// The rebuildable search index for the obsidian-mem vault (Task 9, spec §7).
//
// The index is a *cache*. It can be deleted at any moment and rebuilt from the
// vault, it never becomes the source of truth, and it lives entirely outside the
// vault at `<dataRoot>/index/index-<sha256(realpath(vaultRoot))>.db` — a vault
// must not learn that the index exists and must not carry it into the user's
// Obsidian sync.
//
// Facts this module is built on (measured, see docs/p0-compatibility.md §8.2):
//
//   * `node:sqlite`'s FTS5 `unicode61` tokenizer treats a whole CJK run as ONE
//     token: on a line `调度器改为可插拔后端`, `MATCH '调度器'` finds nothing and
//     `MATCH '调度'` (two characters) finds nothing either. Both the indexed
//     text and the query are therefore pre-tokenised by the same pure function
//     (`indexText`) into overlapping CJK bigrams. A single CJK character has no
//     bigram and can never use FTS, so it takes the bounded substring branch.
//   * `bm25()` sorts ASCENDING: smaller is more relevant (the values are
//     negative). Candidates therefore come back `ORDER BY bm25(...) ASC`.
//   * Removing the experimental flag and having FTS5 are two different things
//     (SQLite 3.47.2 in Node 22.13.0 has no FTS5 module at all), which is why
//     `indexBackend: 'auto'` must degrade to the scan backend and report why,
//     while an explicit `'sqlite'` must fail loudly.
//
// A damaged database is quarantined (`index-<hash>.db.corrupt-<stamp>`) and
// rebuilt; nothing outside `<dataRoot>/index/` is ever touched, in particular
// never the `pending/` queue.
//
// Reading policy lives next door in ./search.js, which resolves scopes and
// refuses to return "nothing" when the answer is really "not ready yet".
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { FrontmatterError, parseNote } from './frontmatter.js'
import { isInside, resolveDataRoot, resolveVaultFile, resolveVaultRoot } from './paths.js'

/** Schema generation of `<dataRoot>/index/*.db`; a different value is treated as damage, not migrated. */
export const INDEX_SCHEMA_VERSION = '1'
/** The single directory this module owns under the data root. */
export const INDEX_DIRECTORY = 'index'
/** Largest note the index and `readNote` will touch (spec §7 "限制单文件大小"). */
export const MAX_NOTE_BYTES = 1_048_576
/** Query tokens kept after pre-tokenisation (spec §7 "设长度/数量上限"). */
export const MAX_QUERY_TOKENS = 16
/** Query tokens longer than this are dropped on both sides, so index and query stay symmetric. */
export const MAX_TOKEN_CHARS = 128
/** Bounded substring scan for queries FTS cannot express (a single CJK character, punctuation only). */
export const SCAN_BRANCH_MAX_ROWS = 2_000
/** Default and maximum `mem_search` limit (spec §9: default 8). */
export const DEFAULT_LIMIT = 8
export const MAX_LIMIT = 50
/** Default ready-barrier budget; a pre-step injection always waits a *bounded* time (spec §7). */
export const DEFAULT_READY_TIMEOUT_MS = 5_000
/** Files per first-scan batch before the host event loop is given a turn (spec §7). */
export const DEFAULT_BATCH_SIZE = 64
/** Statuses excluded unless history is explicitly requested (spec §7). */
export const SUPERSEDED_STATUSES = Object.freeze(['superseded', 'archived'])
/** Periodic full-source verification, so an mtime/size-preserving edit is caught without a hit. */
export const DEFAULT_FULL_VERIFY_INTERVAL_MS = 900_000
/** Walker bounds: a pathological tree must not turn a refresh into an unbounded walk. */
export const MAX_SCAN_DEPTH = 8
export const MAX_SCAN_FILES = 50_000
/** How many extra candidates a backend fetches before read-before-trust drops stale ones. */
const CANDIDATE_FACTOR = 4
const MIN_CANDIDATES = 24
const MAX_CANDIDATES = 200
/** Column weights for `bm25(notes_fts, title, body, tokens)`. */
const BM25_WEIGHTS = Object.freeze([10, 1, 4])
/** Snippet window, in characters, on each side of the match. */
const SNIPPET_RADIUS = 60
/** §7 "类型权重": durable decisions and conventions outrank narration. */
const TYPE_WEIGHTS = Object.freeze({
  decision: 6, convention: 5, gotcha: 4, method: 4, doc: 2, glossary: 2, hub: 1, 'session-log': 1, hot: 0,
})
const FRESHNESS_DAYS = Object.freeze([30, 180])
/** The only file under the vault-root `_meta/` that may be retrieved (spec §7). */
export const GLOBAL_USER_PATH = '_meta/user.md'
/** The cross-project methodology directory (spec §6.2). */
export const METHOD_PREFIX = '方法/'

/** A refusal the caller must report rather than paper over. */
export class IndexError extends Error {
  /**
   * @param {string} code - machine-readable reason (`index-not-ready`, `internal-path`, …).
   * @param {string} message - human-readable diagnostic naming the offending path or cause.
   * @param {{ cause?: Error, details?: object }} [options] - underlying failure or extra facts.
   */
  constructor(code, message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'IndexError'
    this.code = code
    if (options.details !== undefined) this.details = options.details
  }
}

// ---------------------------------------------------------------------------
// The shared pure tokenizer (index side and query side must be the same one)
// ---------------------------------------------------------------------------

// Letters only: CJK punctuation (、。「」) and fullwidth forms are separators, so
// they neither open nor join a bigram run.
const CJK_RANGES = Object.freeze([
  [0x3040, 0x30ff], // hiragana + katakana
  [0x3130, 0x318f], // hangul compatibility jamo
  [0x3400, 0x4dbf], // CJK unified ideographs extension A
  [0x4e00, 0x9fff], // CJK unified ideographs
  [0xa960, 0xa97f], // hangul jamo extended-A
  [0xac00, 0xd7af], // hangul syllables
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0x20000, 0x2fa1f], // CJK extensions B+ (surrogate pairs)
])
const WORD_CHAR = /[\p{L}\p{N}\p{M}]/u

/**
 * Whether a code point belongs to a CJK script.
 *
 * @param {string} char - a single code point.
 * @returns {boolean} true for Han, kana and Hangul letters.
 */
export function isCjkChar(char) {
  const code = char.codePointAt(0)
  return CJK_RANGES.some(([low, high]) => code >= low && code <= high)
}

/**
 * Split text into the token stream the index stores and the query side searches.
 *
 * One pure function serves both sides: runs of latin letters/digits/marks become
 * lowercased words, and each contiguous CJK run becomes its overlapping bigrams.
 * A one-character CJK run yields nothing on purpose — FTS5 cannot express it, so
 * the caller's bounded substring branch handles it instead (spec §7).
 *
 * @param {string} text - document text or a user query.
 * @returns {{tokens: string[], latin: string[], bigrams: string[], loneCjk: string[]}} the token view.
 */
export function tokenizeText(text) {
  const tokens = []
  const latin = []
  const bigrams = []
  const loneCjk = []
  const source = typeof text === 'string' ? text : ''
  let run = ''
  let runIsCjk = false
  const flush = () => {
    if (run === '') return
    if (!runIsCjk) {
      const word = run.toLowerCase()
      if (word.length <= MAX_TOKEN_CHARS) {
        tokens.push(word)
        latin.push(word)
      }
    } else {
      const chars = [...run]
      if (chars.length === 1) {
        loneCjk.push(chars[0])
      } else {
        for (let i = 0; i + 1 < chars.length; i += 1) {
          const bigram = chars[i] + chars[i + 1]
          tokens.push(bigram)
          bigrams.push(bigram)
        }
      }
    }
    run = ''
  }
  for (const char of source) {
    if (isCjkChar(char)) {
      if (!runIsCjk) flush()
      runIsCjk = true
      run += char
    } else if (WORD_CHAR.test(char)) {
      if (runIsCjk) flush()
      runIsCjk = false
      run += char
    } else {
      flush()
    }
  }
  flush()
  return { tokens, latin, bigrams, loneCjk }
}

/**
 * The token stream of a document or a query — the one pure function both sides use.
 *
 * @param {string} text - text to tokenise.
 * @returns {string[]} lowercased latin words and overlapping CJK bigrams.
 */
export function indexText(text) {
  return tokenizeText(text).tokens
}

/**
 * Which matching strategy a query needs, and the tokens it contributes.
 *
 * @param {string} query - the user's raw query text.
 * @returns {{tokens: string[], branch: 'tokens'|'substring', needle: string, loneCjk: string[]}} the plan.
 */
export function planQuery(query) {
  const view = tokenizeText(query)
  const needle = String(query).trim()
  // A lone CJK character (or text with no word characters at all) has nothing
  // FTS5 can index, so it takes the bounded substring branch. Everything else
  // is recalled by OR-ing quoted tokens.
  const branch = view.bigrams.length === 0 && (view.loneCjk.length > 0 || view.tokens.length === 0)
    ? 'substring'
    : 'tokens'
  return { tokens: view.tokens.slice(0, MAX_QUERY_TOKENS), branch, needle, loneCjk: view.loneCjk }
}

/**
 * Render the FTS5 MATCH expression for a token list.
 *
 * Every token is quoted and doubled-quote escaped, so user text can never become
 * FTS5 syntax (`NEAR`, `*`, `-`, `"` are data). Tokens are OR-ed because spec §7
 * recalls first and ranks afterwards.
 *
 * @param {string[]} tokens - tokens from {@link planQuery}.
 * @returns {string|null} the MATCH expression, or `null` when there is nothing to search.
 */
export function buildMatchQuery(tokens) {
  const usable = tokens
    .filter((token) => typeof token === 'string' && token.length > 0 && token.length <= MAX_TOKEN_CHARS)
    .map((token) => `"${token.replaceAll('"', '""')}"`)
  if (usable.length === 0) return null
  return usable.join(' OR ')
}

/**
 * The lowercase hex sha256 of a byte sequence or string.
 *
 * @param {Buffer|Uint8Array|string} value - bytes to hash.
 * @returns {string} 64 hex characters.
 */
export function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex')
}

// ---------------------------------------------------------------------------
// Paths, indexability and the reader
// ---------------------------------------------------------------------------

/**
 * Whether a vault-relative path may be indexed and retrieved (spec §7).
 *
 * Only `.md` files are eligible; symlinks never reach this function because the
 * walker skips them. The vault-root `_meta/` directory is special: it holds the
 * shared receipts log, the project registry and optional lint reports, so only
 * `_meta/user.md` is retrievable. `pending/`, `.obsidian/`, `.history/` and any
 * other dot-directory are internal plumbing.
 *
 * @param {string} relativePath - a `/`-separated vault-relative path.
 * @returns {boolean} whether the path is indexable.
 */
export function isIndexableRelativePath(relativePath) {
  if (typeof relativePath !== 'string' || relativePath.trim() === '') return false
  if (relativePath.includes('\0')) return false
  if (relativePath.startsWith('/') || relativePath.startsWith('\\')) return false
  const segments = relativePath.split('/').filter((segment) => segment !== '')
  if (segments.length === 0) return false
  if (segments.some((segment) => segment === '.' || segment === '..')) return false
  if (segments.some((segment) => segment.startsWith('.'))) return false
  if (segments[0] === '_meta') {
    return segments.length === 2 && segments[1] === 'user.md'
  }
  if (segments.some((segment) => segment === 'pending')) return false
  return segments[segments.length - 1].endsWith('.md')
}

/**
 * The project directory (`项目/<slug>--<projectId 前8位>`) a path lives under.
 *
 * @param {string} relativePath - vault-relative path.
 * @returns {{dir: string, id8: string}|null} the project directory and its id prefix, or `null`.
 */
export function projectDirectoryOf(relativePath) {
  const segments = String(relativePath).split('/')
  if (segments.length < 3 || segments[0] !== '项目') return null
  const match = /--([0-9a-f]{8})$/.exec(segments[1])
  return { dir: `${segments[0]}/${segments[1]}`, id8: match === null ? null : match[1] }
}

/**
 * `lstat` that reports absence as `null` and every other failure as a throw.
 *
 * @param {string} path - path to inspect.
 * @returns {Promise<import('node:fs').Stats|null>} the stat, or `null` when missing.
 */
async function lstatOrNull(path) {
  try {
    return await fs.lstat(path)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

/** Source modification time in integer microseconds (exact in a double, unlike nanoseconds). */
function mtimeMicros(stats) {
  if (typeof stats.mtimeNs === 'bigint') return Number(stats.mtimeNs / 1000n)
  return Math.round(stats.mtimeMs * 1000)
}

/**
 * Read a note from disk, never from the cache.
 *
 * The path is resolved through `resolveVaultFile` first, so traversal and any
 * symlink in the path are refused by the vault's own security boundary; then the
 * indexability rule rejects internal paths. The source is stat-ed and hashed on
 * every call, which is what makes "a cache hit whose source hash changed must be
 * re-read" enforceable upstream.
 *
 * @param {string} vaultRoot - vault root, absolute or `~/…`.
 * @param {string} relativePath - vault-relative path.
 * @param {string} [section] - optional ATX heading whose body should be returned.
 * @param {{home?: string, maxBytes?: number}} [options] - home seam and size bound.
 * @returns {Promise<object>} `{path, absolutePath, hash, size, mtimeUs, id, type, title, status, projectId, updated, tags, frontmatter, body, text, parseError}` (plus `section`/`sectionBody` when a section was requested).
 * @throws {IndexError} when the path is internal, missing, not a regular file, or oversized.
 * @throws {PathSafetyError} when the path escapes the vault or walks through a symlink.
 */
export async function readNote(vaultRoot, relativePath, section, options = {}) {
  const { home = homedir(), maxBytes = MAX_NOTE_BYTES } = options
  const absolutePath = await resolveVaultFile(vaultRoot, relativePath, { mustExist: true, home })
  assertIndexable(relativePath)

  const stats = await fs.stat(absolutePath, { bigint: true })
  if (!stats.isFile()) throw new IndexError('not-a-file', `${relativePath} is not a regular file`)
  if (stats.size > BigInt(maxBytes)) {
    throw new IndexError('note-too-large', `${relativePath} is ${stats.size} bytes, over the ${maxBytes}-byte note bound`)
  }
  const bytes = await fs.readFile(absolutePath)
  const parsed = parseNoteBytes(bytes)
  const data = parsed.data ?? {}
  const note = {
    path: relativePath,
    absolutePath,
    hash: sha256Hex(bytes),
    size: Number(stats.size),
    mtimeUs: mtimeMicros(stats),
    id: typeof data.id === 'string' ? data.id : null,
    type: typeof data.type === 'string' ? data.type : null,
    title: typeof data.title === 'string' ? data.title : null,
    status: typeof data.status === 'string' ? data.status : null,
    projectId: typeof data.project === 'string' ? data.project : null,
    updated: normalizeScalar(data.updated),
    tags: Array.isArray(data.tags) ? data.tags.filter((tag) => typeof tag === 'string') : [],
    frontmatter: parsed.data,
    body: parsed.body,
    text: parsed.text,
    parseError: parsed.parseError,
  }
  if (section !== undefined && section !== null) {
    const found = extractSection(parsed.body, section)
    note.section = found.section
    note.sectionBody = found.body
  }
  return note
}

/**
 * Parse note bytes, degrading a broken frontmatter block to plain text.
 *
 * Spec §7: a note whose frontmatter does not parse is still retrievable as text
 * (only ~17% of a real vault carries frontmatter). The whole file then becomes
 * the searchable body, and every structured field stays `null` rather than being
 * guessed from the unparsable bytes.
 *
 * @param {Buffer} bytes - the note bytes.
 * @returns {{data: object|null, body: string, text: string, parseError: object|null}} the parse view.
 */
function parseNoteBytes(bytes) {
  const text = bytes.toString('utf8')
  try {
    const parsed = parseNote(bytes)
    return { data: parsed.data, body: parsed.body, text, parseError: null }
  } catch (error) {
    const parseError = {
      code: error instanceof FrontmatterError ? error.code : 'unreadable',
      message: error.message,
    }
    return { data: null, body: text, text, parseError }
  }
}

/**
 * Extract one ATX section from a note body.
 *
 * @param {string} body - the note body.
 * @param {string} section - heading text, with or without its `#` markers.
 * @returns {{section: string, level: number, body: string}} the section body and its heading level.
 * @throws {IndexError} when the heading does not exist.
 */
export function extractSection(body, section) {
  const wanted = String(section).trim().replace(/^#+\s*/, '').trim()
  const lines = String(body).split(/\r?\n/)
  let start = -1
  let level = 0
  for (const [index, line] of lines.entries()) {
    const match = /^(#{1,6})\s+(.*?)\s*$/.exec(line)
    if (match !== null && match[2] === wanted) {
      start = index
      level = match[1].length
      break
    }
  }
  if (start < 0) throw new IndexError('section-not-found', `no heading ${JSON.stringify(wanted)} in the note`)
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    const match = /^(#{1,6})\s+/.exec(lines[index])
    if (match !== null && match[1].length <= level) {
      end = index
      break
    }
  }
  return { section: wanted, level, body: lines.slice(start, end).join('\n').trim() }
}

/**
 * Refuse a path that is not indexable.
 *
 * @param {string} relativePath - vault-relative path.
 * @throws {IndexError} with `code: 'internal-path'` or `'not-markdown'`.
 */
function assertIndexable(relativePath) {
  if (isIndexableRelativePath(relativePath)) return
  const first = String(relativePath ?? '').split('/')[0]
  const internal = first.startsWith('.')
    || first === '_meta'
    || String(relativePath ?? '').split('/').includes('pending')
  throw new IndexError(
    internal ? 'internal-path' : 'not-markdown',
    internal
      ? `${relativePath} is internal vault plumbing, not a retrievable note`
      : `${relativePath} is not a retrievable Markdown note`,
  )
}

// ---------------------------------------------------------------------------
// The index location
// ---------------------------------------------------------------------------

/**
 * The directory this module owns under the data root.
 *
 * @param {string} dataRoot - plugin data root.
 * @returns {string} `<dataRoot>/index`.
 */
export function indexDirectory(dataRoot) {
  if (typeof dataRoot !== 'string' || dataRoot.trim() === '') throw new RangeError('dataRoot must be a non-blank path')
  return join(dataRoot, INDEX_DIRECTORY)
}

/**
 * The exact database file of one vault (spec §7).
 *
 * @param {string} vaultRoot - vault root, absolute or `~/…`.
 * @param {string} dataRoot - plugin data root (production: `resolveDataRoot()`).
 * @param {{home?: string}} [options] - home seam for `~/` expansion.
 * @returns {Promise<string>} `<dataRoot>/index/index-<sha256(realpath(vaultRoot))>.db`.
 * @throws {IndexError} when the data root would place the index inside the vault.
 */
export async function indexFilePath(vaultRoot, dataRoot, options = {}) {
  const { home = homedir() } = options
  const vault = await resolveVaultRoot(vaultRoot, { home })
  const directory = indexDirectory(dataRoot)
  // Both sides are normalized before the containment test: a macOS temp path
  // reached through `/var` and its real `/private/var` form are the same place,
  // and a lexical comparison would wave the index into the vault.
  const directoryReal = (await resolveVaultRoot(directory, { home })).root
  if (isInside(directoryReal, vault.root) || isInside(vault.root, directoryReal)) {
    throw new IndexError('index-inside-vault', `the index directory ${directory} must not live inside the vault ${vault.root}`)
  }
  return join(directory, `index-${sha256Hex(vault.root)}.db`)
}

// ---------------------------------------------------------------------------
// openIndex
// ---------------------------------------------------------------------------

/**
 * Open (or rebuild) the vault's search index.
 *
 * Returns immediately after the store is prepared and kicks the first scan off in
 * the background; `waitReady(signal, timeoutMs)` is the readiness barrier and
 * always answers explicitly, so an empty result array can mean only "searched and
 * found nothing" (spec §7). A damaged or unknown-schema database is quarantined
 * next to itself and rebuilt — a cache that cannot be trusted is thrown away,
 * never migrated, and nothing outside `<dataRoot>/index/` is ever removed.
 *
 * @param {object} options - open inputs.
 * @param {string} options.vaultRoot - vault root, absolute or `~/…`.
 * @param {string} [options.dataRoot] - plugin data root (defaults to `resolveDataRoot()`).
 * @param {'auto'|'sqlite'|'scan'} [options.backend] - requested backend (spec §12 `indexBackend`).
 * @param {string|null} [options.projectId] - the bound project; `scope:'project'` needs it.
 * @param {string} [options.home] - home seam for `~/` expansion and cloud checks.
 * @param {number} [options.batchSize] - files per first-scan batch before yielding to the event loop.
 * @param {number} [options.maxFileBytes] - per-note size bound.
 * @param {number} [options.fullVerifyIntervalMs] - how often a refresh re-hashes every source.
 * @param {Function} [options.yieldToEventLoop] - batch yield seam (defaults to `setImmediate`).
 * @param {Function} [options.openDatabase] - database seam; the default imports `node:sqlite`.
 * @param {{readdir?: Function, stat?: Function, readFile?: Function}} [options.io] - filesystem seam for tests.
 * @returns {Promise<object>} `{waitReady, refresh, search, close, status, boundProjectId}`.
 * @throws {RangeError} when an input is malformed.
 * @throws {IndexError} when a requested backend cannot be provided or the data root is inside the vault.
 */
export async function openIndex(options = {}) {
  const {
    vaultRoot,
    backend = 'auto',
    projectId = null,
    home = homedir(),
    batchSize = DEFAULT_BATCH_SIZE,
    maxFileBytes = MAX_NOTE_BYTES,
    fullVerifyIntervalMs = DEFAULT_FULL_VERIFY_INTERVAL_MS,
    yieldToEventLoop,
    openDatabase,
    io,
  } = options
  if (typeof vaultRoot !== 'string' || vaultRoot.trim() === '') throw new RangeError('vaultRoot must be a non-blank path')
  if (!['auto', 'sqlite', 'scan'].includes(backend)) throw new RangeError("backend must be one of 'auto', 'sqlite', 'scan'")
  if (projectId !== null && (typeof projectId !== 'string' || projectId.trim() === '')) {
    throw new RangeError('projectId must be null or a non-blank string')
  }
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new RangeError('batchSize must be a positive integer')
  if (!Number.isInteger(maxFileBytes) || maxFileBytes < 1) throw new RangeError('maxFileBytes must be a positive integer')
  const dataRoot = options.dataRoot ?? resolveDataRoot()
  const vault = await resolveVaultRoot(vaultRoot, { home })
  const dbPath = await indexFilePath(vault.root, dataRoot, { home })

  const state = {
    vaultRoot: vault.root,
    dataRoot,
    dbPath,
    indexDir: indexDirectory(dataRoot),
    requestedBackend: backend,
    backend: null,
    boundProjectId: projectId,
    maxFileBytes,
    batchSize,
    fullVerifyIntervalMs,
    yieldToEventLoop: typeof yieldToEventLoop === 'function'
      ? yieldToEventLoop
      : () => new Promise((resolve) => setImmediate(resolve)),
    openDatabase,
    io: {
      readdir: io?.readdir ?? fs.readdir,
      stat: io?.stat ?? fs.stat,
      readFile: io?.readFile ?? fs.readFile,
    },
    db: null,
    records: null,
    ready: false,
    scanning: false,
    stale: false,
    closed: false,
    degraded: false,
    reason: null,
    lastError: null,
    lastScan: null,
    lastFullVerify: 0,
    noteCount: 0,
    quarantined: [],
    skipped: { large: 0, symlink: 0, internal: 0, depth: 0, other: 0 },
    initial: null,
    initialError: null,
    refreshChain: Promise.resolve(),
  }

  if (backend === 'scan') {
    state.backend = 'scan'
    state.records = new Map()
  } else {
    try {
      await openSqlite(state)
      state.backend = 'sqlite'
    } catch (error) {
      await discardDatabaseHandle(state)
      if (backend === 'sqlite') {
        throw error instanceof IndexError
          ? error
          : new IndexError('sqlite-unavailable', `the sqlite index backend is unavailable: ${error.message}`, { cause: error })
      }
      state.backend = 'scan'
      state.records = new Map()
      state.degraded = true
      state.reason = `sqlite-unavailable: ${error.message}`
    }
  }

  state.initial = (async () => {
    try {
      await refresh(state)
    } catch (error) {
      state.initialError = error
    }
  })()

  return {
    boundProjectId: state.boundProjectId,
    waitReady: (signal, timeoutMs) => waitReady(state, signal, timeoutMs),
    refresh: (refreshOptions) => refresh(state, refreshOptions),
    search: (searchOptions) => search(state, searchOptions),
    close: () => close(state),
    status: () => status(state),
  }
}

/**
 * Prepare the SQLite store, quarantining a database that cannot be trusted.
 *
 * @param {object} state - index state.
 * @returns {Promise<void>} resolves once the schema is present.
 * @throws {IndexError} when the database cannot be opened or the schema cannot be created.
 */
async function openSqlite(state) {
  await fs.mkdir(state.indexDir, { recursive: true })
  const existing = await lstatOrNull(state.dbPath)
  if (existing !== null && existing.size > 0) {
    const verdict = await probeDatabase(state)
    if (!verdict.ok) {
      const moved = await quarantine(state, verdict.reason)
      state.quarantined.push(moved)
    }
  }
  state.db = await openDatabaseHandle(state)
  createSchema(state)
}

/**
 * Whether an existing database file is this module's own, current schema.
 *
 * @param {object} state - index state.
 * @returns {Promise<{ok: boolean, reason?: string}>} the verdict.
 */
async function probeDatabase(state) {
  let db = null
  try {
    db = await openDatabaseHandle(state)
    const check = db.prepare('PRAGMA integrity_check').get()
    const verdict = check === null || check === undefined ? undefined : Object.values(check)[0]
    if (verdict !== 'ok') return { ok: false, reason: `integrity:${String(verdict)}` }
    const version = db.prepare("SELECT value FROM kv WHERE key = 'schema_version'").get()
    if (version === null || version === undefined || version.value !== INDEX_SCHEMA_VERSION) {
      return { ok: false, reason: `schema-version:${version?.value ?? 'missing'}` }
    }
    db.prepare('SELECT count(*) FROM notes_fts').get()
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: error.code ?? error.message ?? 'unreadable' }
  } finally {
    try { db?.close() } catch { /* already unusable */ }
  }
}

/**
 * Release a database handle whose backend could not be established.
 *
 * A half-initialised store must not keep a file descriptor, and a file that
 * never became a usable index (an FTS5-less runtime writes the WAL header before
 * `CREATE VIRTUAL TABLE` fails) is removed with its sidecars, so a degraded run
 * leaves the index directory exactly as it found it.
 *
 * @param {object} state - index state.
 * @returns {Promise<void>} resolves once the handle and any empty file are gone.
 */
async function discardDatabaseHandle(state) {
  const db = state.db
  state.db = null
  if (db !== null) {
    try { db.close() } catch { /* nothing to release */ }
  }
  if (await lstatOrNull(state.dbPath) === null) return
  // A valid store is never deleted here, even when this attempt opened it.
  const verdict = await probeDatabase(state)
  if (verdict.ok) return
  await fs.rm(state.dbPath, { force: true }).catch(() => {})
  for (const suffix of ['-wal', '-shm']) {
    await fs.rm(`${state.dbPath}${suffix}`, { force: true }).catch(() => {})
  }
}

/**
 * Open the database handle, through the injected seam when there is one.
 *
 * @param {object} state - index state.
 * @returns {Promise<object>} a `DatabaseSync`-shaped handle.
 */
async function openDatabaseHandle(state) {
  if (typeof state.openDatabase === 'function') return state.openDatabase(state.dbPath)
  const { DatabaseSync } = await import('node:sqlite')
  return new DatabaseSync(state.dbPath)
}

/**
 * Create the six §7 tables and stamp the schema version.
 *
 * @param {object} state - index state.
 * @returns {void}
 */
function createSchema(state) {
  const db = state.db
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS notes (
      path TEXT PRIMARY KEY,
      mtime INTEGER NOT NULL,
      size INTEGER NOT NULL,
      id TEXT,
      type TEXT,
      title TEXT,
      status TEXT,
      project TEXT,
      project_dir TEXT,
      project_id8 TEXT,
      updated TEXT,
      source TEXT,
      hash TEXT NOT NULL,
      broken INTEGER NOT NULL DEFAULT 0
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(title, body, tokens);
    CREATE TABLE IF NOT EXISTS fm_kv (note_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT);
    CREATE TABLE IF NOT EXISTS tags (note_id TEXT NOT NULL, tag TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS links (src_id TEXT NOT NULL, target TEXT NOT NULL, resolved_id TEXT);
    CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS notes_project ON notes(project);
    CREATE INDEX IF NOT EXISTS notes_status ON notes(status);
    CREATE INDEX IF NOT EXISTS tags_tag ON tags(tag);
    CREATE INDEX IF NOT EXISTS links_src ON links(src_id);
    CREATE INDEX IF NOT EXISTS links_target ON links(target);
    INSERT OR IGNORE INTO kv(key, value) VALUES ('schema_version', '${INDEX_SCHEMA_VERSION}');
    INSERT OR REPLACE INTO kv(key, value) VALUES ('backend', 'sqlite');
  `)
}

/**
 * Move an unusable database aside, together with its WAL sidecars.
 *
 * The main file is renamed, never deleted: a damaged cache is evidence, and the
 * `-wal`/`-shm` files must leave the path too or the freshly created database
 * would try to recover a stranger's journal.
 *
 * @param {object} state - index state.
 * @param {string} reason - why the database was rejected.
 * @returns {Promise<string>} the quarantine path.
 */
async function quarantine(state, reason) {
  const stamp = new Date().toISOString().replaceAll(':', '').replace(/\.\d+Z$/, 'Z')
  const moved = `${state.dbPath}.corrupt-${stamp}`
  await fs.rename(state.dbPath, moved)
  for (const suffix of ['-wal', '-shm']) {
    const sidecar = `${state.dbPath}${suffix}`
    if (await lstatOrNull(sidecar) !== null) await fs.rename(sidecar, `${moved}${suffix}`).catch(() => {})
  }
  await fs.writeFile(`${moved}.reason`, `${reason}\n`, 'utf8').catch(() => {})
  return moved
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

/**
 * Queue one scan behind every scan already running.
 *
 * The first scan starts in the background, and a tool may legitimately ask for a
 * refresh while it is still running. Scans are serialized on a promise chain so
 * two passes can never interleave their writes to the same store.
 *
 * @param {object} state - index state.
 * @param {{full?: boolean}} [options] - refresh options.
 * @returns {Promise<object>} the refresh summary.
 */
function refresh(state, options = {}) {
  const next = state.refreshChain.then(
    () => runRefresh(state, options),
    () => runRefresh(state, options),
  )
  state.refreshChain = next.then(() => undefined, () => undefined)
  return next
}

/**
 * Walk the vault and index every eligible note.
 *
 * @param {object} state - index state.
 * @param {{full?: boolean}} [options] - `full: true` re-hashes every source.
 * @returns {Promise<object>} the refresh summary.
 */
async function runRefresh(state, options = {}) {
  if (state.closed) throw new IndexError('closed', 'the index is closed')
  const requestedFull = options.full === true
  // The first pass has nothing to compare against, so it hashes everything; a
  // later pass re-hashes every source once the verification interval elapses,
  // which is how an mtime/size-preserving external edit is eventually caught
  // without waiting for a matching hit (spec §7 "定期校验").
  const full = requestedFull
    || state.lastFullVerify === 0
    || Date.now() - state.lastFullVerify >= state.fullVerifyIntervalMs
  state.scanning = true
  try {
    const summary = await scanInto(state, { full })
    state.lastFullVerify = Date.now()
    state.ready = true
    state.stale = false
    state.lastError = null
    state.reason = state.degraded ? state.reason : null
    state.lastScan = new Date().toISOString()
    if (state.db !== null) {
      state.db.prepare("INSERT OR REPLACE INTO kv(key, value) VALUES ('last_scan', ?)").run(state.lastScan)
    }
    return { ok: true, ...summary }
  } catch (error) {
    state.stale = true
    const code = error instanceof IndexError ? error.code : 'refresh-failed'
    state.lastError = `${code}: ${error.message}`
    state.reason = state.lastError
    if (error instanceof IndexError) throw error
    throw new IndexError(code, `the index refresh failed: ${error.message}`, { cause: error })
  } finally {
    state.scanning = false
  }
}

/**
 * Perform one scan pass and apply it to the active backend.
 *
 * @param {object} state - index state.
 * @param {{full: boolean}} options - whether to bypass the cheap mtime/size filter.
 * @returns {Promise<object>} counters for the caller.
 */
async function scanInto(state, { full }) {
  const { files, skipped, truncated } = await listCandidateFiles(state)
  const summary = {
    full,
    scanned: files.length,
    added: 0,
    updated: 0,
    unchanged: 0,
    removed: 0,
    skippedLarge: 0,
    truncated,
  }
  state.skipped = skipped
  const existing = state.backend === 'sqlite' ? loadIndexedStamps(state) : state.records
  const seen = new Set()
  let sinceYield = 0
  for (const relative of files) {
    sinceYield = await tick(state, sinceYield)
    let absolute
    try {
      absolute = await resolveVaultFile(state.vaultRoot, relative)
    } catch {
      // A path that walks through a symlink (or vanished between listing and
      // reading) is not indexable; it is reported, never guessed.
      skipped.symlink += 1
      continue
    }
    let stats
    try {
      stats = await state.io.stat(absolute, { bigint: true })
    } catch (error) {
      if (error.code === 'ENOENT') continue
      throw new IndexError('scan-failed', `cannot stat ${relative}: ${error.code ?? error.message}`, { cause: error })
    }
    if (!stats.isFile()) continue
    if (stats.size > BigInt(state.maxFileBytes)) {
      summary.skippedLarge += 1
      skipped.large += 1
      continue
    }
    seen.add(relative)
    const prior = existing.get(relative) ?? null
    const mtime = mtimeMicros(stats)
    const size = Number(stats.size)
    if (prior !== null && !full && prior.size === size && prior.mtime === mtime) {
      summary.unchanged += 1
      continue
    }
    let bytes
    try {
      bytes = await state.io.readFile(absolute)
    } catch (error) {
      if (error.code === 'ENOENT') continue
      throw new IndexError('scan-failed', `cannot read ${relative}: ${error.code ?? error.message}`, { cause: error })
    }
    const hash = sha256Hex(bytes)
    if (prior !== null && prior.hash === hash) {
      summary.unchanged += 1
      touchStamp(state, relative, { mtime, size, hash })
      continue
    }
    const record = parseNoteRecord(relative, bytes, { mtime, size, hash })
    storeRecord(state, record)
    if (prior === null) summary.added += 1
    else summary.updated += 1
  }
  // A truncated walk never removes: files beyond the bound were not observed,
  // and an unobserved file is not a deleted file.
  if (existing.size > 0 && !truncated) {
    for (const relative of [...existing.keys()]) {
      if (seen.has(relative)) continue
      dropRecord(state, relative)
      summary.removed += 1
    }
  }
  state.noteCount = state.backend === 'sqlite'
    ? state.db.prepare('SELECT count(*) AS c FROM notes').get().c
    : state.records.size
  if (state.backend === 'sqlite') resolveLinks(state)
  return summary
}

/**
 * Yield to the host event loop once per batch of visited files (spec §7).
 *
 * @param {object} state - index state.
 * @param {number} sinceYield - files visited since the last yield.
 * @returns {Promise<number>} the updated counter.
 */
async function tick(state, sinceYield) {
  const next = sinceYield + 1
  if (next < state.batchSize) return next
  await state.yieldToEventLoop()
  return 0
}

/**
 * List every eligible note, in a deterministic order, skipping internal paths.
 *
 * @param {object} state - index state.
 * @returns {Promise<{files: string[], skipped: object, truncated: boolean}>} the walk result.
 * @throws {IndexError} when the vault itself cannot be read — an unreadable vault is never "empty".
 */
async function listCandidateFiles(state) {
  const files = []
  const skipped = { large: 0, symlink: 0, internal: 0, depth: 0, other: 0 }
  const queue = ['']
  let truncated = false
  let sinceYield = 0
  while (queue.length > 0 && !truncated) {
    const directory = queue.shift()
    const absolute = directory === '' ? state.vaultRoot : join(state.vaultRoot, ...directory.split('/'))
    let entries
    try {
      entries = await state.io.readdir(absolute, { withFileTypes: true })
    } catch (error) {
      // Absence is absence (a vault bootstrap has not created yet, or a
      // directory deleted mid-walk); any other failure is a real one and must
      // never be read as "this directory is empty".
      if (error.code === 'ENOENT') continue
      throw new IndexError('scan-failed', `cannot read vault directory ${directory || '.'}: ${error.code ?? error.message}`, { cause: error })
    }
    entries = [...entries].sort((left, right) => String(left.name).localeCompare(String(right.name)))
    for (const entry of entries) {
      sinceYield = await tick(state, sinceYield)
      const name = String(entry.name)
      const relative = directory === '' ? name : `${directory}/${name}`
      if (typeof entry.isSymbolicLink === 'function' && entry.isSymbolicLink()) {
        skipped.symlink += 1
        continue
      }
      if (typeof entry.isDirectory === 'function' && entry.isDirectory()) {
        if (name.startsWith('.') || name === 'pending' || name === 'node_modules') {
          skipped.internal += 1
          continue
        }
        if (relative.split('/').length >= MAX_SCAN_DEPTH) {
          skipped.depth += 1
          continue
        }
        queue.push(relative)
        continue
      }
      if (typeof entry.isFile === 'function' && !entry.isFile()) {
        skipped.other += 1
        continue
      }
      if (!isIndexableRelativePath(relative)) {
        skipped.internal += 1
        continue
      }
      files.push(relative)
      if (files.length >= MAX_SCAN_FILES) {
        truncated = true
        break
      }
    }
  }
  return { files, skipped, truncated }
}

/**
 * Build the indexable record of one note.
 *
 * @param {string} relative - vault-relative path.
 * @param {Buffer} bytes - note bytes.
 * @param {{mtime: number, size: number, hash: string}} stamp - source stamp.
 * @returns {object} the record.
 */
function parseNoteRecord(relative, bytes, stamp) {
  const parsed = parseNoteBytes(bytes)
  const data = parsed.data ?? {}
  const directory = projectDirectoryOf(relative)
  const title = typeof data.title === 'string' ? data.title : null
  const body = parsed.body
  const searchText = title === null ? body : `${title}\n${body}`
  const tokenStream = [...indexText(title ?? ''), ...indexText(body)]
  return {
    path: relative,
    hash: stamp.hash,
    size: stamp.size,
    mtime: stamp.mtime,
    id: typeof data.id === 'string' ? data.id : null,
    type: typeof data.type === 'string' ? data.type : null,
    title,
    status: typeof data.status === 'string' ? data.status : null,
    project: typeof data.project === 'string' ? data.project : null,
    projectDir: directory === null ? null : directory.dir,
    projectDirId8: directory === null ? null : directory.id8,
    updated: normalizeScalar(data.updated),
    source: typeof data.source === 'string' ? data.source : null,
    broken: parsed.parseError !== null,
    parseError: parsed.parseError,
    body,
    searchText,
    tokens: tokenStream,
    tokenSet: new Set(tokenStream),
    tags: Array.isArray(data.tags) ? data.tags.filter((tag) => typeof tag === 'string') : [],
    fm: flatFrontmatter(data),
    links: extractLinks(body),
  }
}

/**
 * Normalise a frontmatter scalar (a Date, string, number or null) to text.
 *
 * @param {unknown} value - the frontmatter value.
 * @returns {string|null} text, or `null` when the value is absent.
 */
function normalizeScalar(value) {
  if (value === null || value === undefined) return null
  if (value instanceof Date) {
    const pad = (n) => String(n).padStart(2, '0')
    return `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`
  }
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return null
}

/**
 * Flatten the scalar frontmatter a note carries, for `fm_kv`.
 *
 * @param {object} data - parsed frontmatter.
 * @returns {[string, string][]} key/value pairs.
 */
function flatFrontmatter(data) {
  const pairs = []
  for (const [key, value] of Object.entries(data ?? {})) {
    const text = normalizeScalar(value)
    if (text !== null) pairs.push([String(key), text])
  }
  return pairs
}

const WIKILINK_PATTERN = /\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g

/**
 * Extract the `[[wikilink]]` targets of a note body.
 *
 * @param {string} body - note body.
 * @returns {string[]} the targets, trimmed and de-duplicated.
 */
function extractLinks(body) {
  const targets = new Set()
  for (const match of String(body).matchAll(WIKILINK_PATTERN)) {
    const target = match[1].trim()
    if (target !== '') targets.add(target)
  }
  return [...targets]
}

/**
 * The `(size, mtime, hash)` stamp of every currently indexed note.
 *
 * @param {object} state - index state.
 * @returns {Map<string, object>} path → stamp.
 */
function loadIndexedStamps(state) {
  const map = new Map()
  for (const row of state.db.prepare('SELECT path, mtime, size, hash FROM notes').all()) {
    map.set(row.path, { mtime: Number(row.mtime), size: Number(row.size), hash: row.hash })
  }
  return map
}

/**
 * Write one record into the active backend.
 *
 * @param {object} state - index state.
 * @param {object} record - the record from {@link parseNoteRecord}.
 * @returns {void}
 */
function storeRecord(state, record) {
  if (state.backend === 'scan') {
    if (!state.records.has(record.path)) state.noteCount += 1
    state.records.set(record.path, record)
    return
  }
  const db = state.db
  db.prepare(`
    INSERT INTO notes (path, mtime, size, id, type, title, status, project, project_dir, project_id8, updated, source, hash, broken)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      mtime = excluded.mtime, size = excluded.size, id = excluded.id, type = excluded.type,
      title = excluded.title, status = excluded.status, project = excluded.project,
      project_dir = excluded.project_dir, project_id8 = excluded.project_id8,
      updated = excluded.updated, source = excluded.source, hash = excluded.hash, broken = excluded.broken
  `).run(
    record.path, record.mtime, record.size, record.id, record.type, record.title, record.status,
    record.project, record.projectDir, record.projectDirId8, record.updated, record.source,
    record.hash, record.broken ? 1 : 0,
  )
  const row = db.prepare('SELECT rowid FROM notes WHERE path = ?').get(record.path)
  db.prepare('DELETE FROM notes_fts WHERE rowid = ?').run(row.rowid)
  db.prepare('INSERT INTO notes_fts(rowid, title, body, tokens) VALUES (?, ?, ?, ?)')
    .run(row.rowid, record.title ?? '', record.body, record.tokens.join(' '))
  const noteId = record.id ?? record.path
  db.prepare('DELETE FROM fm_kv WHERE note_id = ?').run(noteId)
  const insertFm = db.prepare('INSERT INTO fm_kv(note_id, key, value) VALUES (?, ?, ?)')
  for (const [key, value] of record.fm) insertFm.run(noteId, key, value)
  db.prepare('DELETE FROM tags WHERE note_id = ?').run(noteId)
  const insertTag = db.prepare('INSERT INTO tags(note_id, tag) VALUES (?, ?)')
  for (const tag of record.tags) insertTag.run(noteId, tag)
  db.prepare('DELETE FROM links WHERE src_id = ?').run(noteId)
  const insertLink = db.prepare('INSERT INTO links(src_id, target, resolved_id) VALUES (?, ?, NULL)')
  for (const target of record.links) insertLink.run(noteId, target)
}

/**
 * Record that an unchanged file was re-verified, refreshing its mtime if needed.
 *
 * @param {object} state - index state.
 * @param {string} relative - vault-relative path.
 * @param {{mtime: number, size: number, hash: string}} stamp - the fresh stamp.
 * @returns {void}
 */
function touchStamp(state, relative, stamp) {
  if (state.backend === 'scan') {
    const record = state.records.get(relative)
    if (record !== undefined) {
      record.mtime = stamp.mtime
      record.size = stamp.size
    }
    return
  }
  state.db.prepare('UPDATE notes SET mtime = ?, size = ? WHERE path = ?').run(stamp.mtime, stamp.size, relative)
}

/**
 * Remove one note from the active backend, including its FTS row and satellites.
 *
 * @param {object} state - index state.
 * @param {string} relative - vault-relative path.
 * @returns {void}
 */
function dropRecord(state, relative) {
  if (state.backend === 'scan') {
    if (state.records.delete(relative)) state.noteCount -= 1
    return
  }
  const db = state.db
  const row = db.prepare('SELECT rowid, id FROM notes WHERE path = ?').get(relative)
  if (row === null || row === undefined) return
  const noteId = row.id ?? relative
  db.prepare('DELETE FROM notes_fts WHERE rowid = ?').run(row.rowid)
  db.prepare('DELETE FROM notes WHERE path = ?').run(relative)
  db.prepare('DELETE FROM fm_kv WHERE note_id = ?').run(noteId)
  db.prepare('DELETE FROM tags WHERE note_id = ?').run(noteId)
  db.prepare('DELETE FROM links WHERE src_id = ?').run(noteId)
  state.noteCount -= 1
}

/**
 * Resolve `[[wikilink]]` targets to a known note id when one exists.
 *
 * @param {object} state - index state.
 * @returns {void}
 */
function resolveLinks(state) {
  const db = state.db
  const rows = db.prepare('SELECT src_id, target FROM links').all()
  if (rows.length === 0) return
  const byId = new Map()
  const byName = new Map()
  for (const note of db.prepare('SELECT path, id, title FROM notes').all()) {
    if (typeof note.id === 'string') byId.set(note.id, note.id)
    const basename = String(note.path).split('/').pop().replace(/\.md$/, '')
    if (!byName.has(basename)) byName.set(basename, note.id ?? note.path)
    if (typeof note.title === 'string' && !byName.has(note.title)) byName.set(note.title, note.id ?? note.path)
  }
  const update = db.prepare('UPDATE links SET resolved_id = ? WHERE src_id = ? AND target = ?')
  for (const row of rows) {
    const target = String(row.target)
    const resolved = byId.get(target) ?? byName.get(target) ?? null
    if (resolved !== null) update.run(resolved, row.src_id, target)
  }
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/**
 * Run one search against the active backend.
 *
 * @param {object} state - index state.
 * @param {{query: string, filters?: object, limit?: number}} options - the query, a resolved filter descriptor and a limit.
 * @returns {Promise<object[]>} hits, best first.
 * @throws {IndexError} when the index is closed or has never completed a scan.
 */
async function search(state, options = {}) {
  if (state.closed) throw new IndexError('closed', 'the index is closed')
  if (!state.ready) throw new IndexError('index-not-ready', 'the index has not completed its first scan')
  const query = options.query
  if (typeof query !== 'string' || query.trim() === '') throw new RangeError('query must be a non-blank string')
  const limit = options.limit ?? DEFAULT_LIMIT
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new RangeError(`limit must be an integer between 1 and ${MAX_LIMIT}`)
  const filters = options.filters ?? { kind: 'all', excludeStatuses: [], type: null }
  const plan = planQuery(query)
  const candidateLimit = Math.min(MAX_CANDIDATES, Math.max(MIN_CANDIDATES, limit * CANDIDATE_FACTOR))

  const candidates = state.backend === 'sqlite'
    ? querySqlite(state, { plan, filters, candidateLimit })
    : queryScan(state, { plan, filters, candidateLimit })

  const hits = []
  for (const candidate of candidates) {
    if (hits.length >= limit) break
    const verified = await verifyCandidate(state, candidate, plan)
    if (verified === null) continue
    verified.backend = state.backend
    hits.push(verified)
  }
  hits.sort((left, right) => (
    right.score - left.score
    || right.signals.relevance - left.signals.relevance
    || (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
  ))
  return hits
}

/**
 * Candidate rows from SQLite: FTS5 when the query has tokens, a bounded substring scan otherwise.
 *
 * @param {object} state - index state.
 * @param {{plan: object, filters: object, candidateLimit: number}} input - query plan and bounds.
 * @returns {object[]} candidate rows carrying `rank` and `body`.
 */
function querySqlite(state, { plan, filters, candidateLimit }) {
  const where = []
  const params = []
  applySqlFilters(filters, where, params)
  if (plan.branch === 'tokens') {
    const match = buildMatchQuery(plan.tokens)
    if (match === null) return []
    const sql = `
      SELECT n.path, n.hash, n.id, n.type, n.title, n.status, n.project, n.project_dir, n.project_id8,
             n.updated, n.source, n.broken, notes_fts.body AS body,
             bm25(notes_fts, ${BM25_WEIGHTS.join(', ')}) AS rank
      FROM notes_fts JOIN notes n ON n.rowid = notes_fts.rowid
      WHERE notes_fts MATCH ?${where.length > 0 ? ` AND ${where.join(' AND ')}` : ''}
      ORDER BY rank ASC
      LIMIT ?
    `
    return state.db.prepare(sql).all(match, ...params, candidateLimit).map(toCandidate)
  }
  const sql = `
    SELECT n.path, n.hash, n.id, n.type, n.title, n.status, n.project, n.project_dir, n.project_id8,
           n.updated, n.source, n.broken, f.body AS body
    FROM notes n JOIN notes_fts f ON f.rowid = n.rowid
    ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
    LIMIT ?
  `
  const needle = plan.needle.toLowerCase()
  const rows = state.db.prepare(sql).all(...params, SCAN_BRANCH_MAX_ROWS)
  return rows.filter((row) => `${row.title ?? ''}\n${row.body}`.toLowerCase().includes(needle)).slice(0, candidateLimit).map(toCandidate)
}

/**
 * Candidate records from the in-memory scan backend, with a bounded relevance score.
 *
 * @param {object} state - index state.
 * @param {{plan: object, filters: object, candidateLimit: number}} input - query plan and bounds.
 * @returns {object[]} candidate records.
 */
function queryScan(state, { plan, filters, candidateLimit }) {
  const needle = plan.needle.toLowerCase()
  const candidates = []
  for (const record of state.records.values()) {
    if (!matchesFilters(record, filters)) continue
    if (plan.branch === 'tokens') {
      const matched = plan.tokens.filter((token) => record.tokenSet.has(token)).length
      if (matched === 0) continue
      candidates.push({ ...record, rank: null, matchedRatio: matched / plan.tokens.length })
    } else if (record.searchText.toLowerCase().includes(needle)) {
      candidates.push({ ...record, rank: null, matchedRatio: 0 })
    }
  }
  candidates.sort((left, right) => (
    right.matchedRatio - left.matchedRatio
    || (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
  ))
  return candidates.slice(0, candidateLimit)
}

/**
 * Add the resolved filter descriptor to a SQL `WHERE` clause.
 *
 * @param {object} filters - descriptor from `./search.js`.
 * @param {string[]} where - clause accumulator.
 * @param {unknown[]} params - parameter accumulator.
 * @returns {void}
 */
function applySqlFilters(filters, where, params) {
  if (filters.kind === 'global') {
    where.push("(n.path = ? OR n.path GLOB ?)")
    params.push(GLOBAL_USER_PATH, `${METHOD_PREFIX}*`)
  }
  if (filters.kind === 'project') {
    where.push('(n.project = ? OR (n.project IS NULL AND n.project_id8 = ?))')
    params.push(filters.projectId, filters.projectId8)
  }
  if (filters.filterProjectId !== undefined && filters.filterProjectId !== null) {
    where.push('n.project = ?')
    params.push(filters.filterProjectId)
  }
  if (Array.isArray(filters.excludeStatuses) && filters.excludeStatuses.length > 0) {
    where.push(`(n.status IS NULL OR n.status NOT IN (${filters.excludeStatuses.map(() => '?').join(', ')}))`)
    params.push(...filters.excludeStatuses)
  }
  if (filters.type !== undefined && filters.type !== null) {
    where.push('n.type = ?')
    params.push(filters.type)
  }
}

/**
 * Whether an in-memory record satisfies a filter descriptor.
 *
 * @param {object} record - a scanned record.
 * @param {object} filters - descriptor from `./search.js`.
 * @returns {boolean} whether the record is in scope.
 */
function matchesFilters(record, filters) {
  if (filters.kind === 'global' && !(record.path === GLOBAL_USER_PATH || record.path.startsWith(METHOD_PREFIX))) return false
  if (filters.kind === 'project' && !(record.project === filters.projectId || (record.project === null && record.projectDirId8 === filters.projectId8))) return false
  if (filters.filterProjectId !== undefined && filters.filterProjectId !== null && record.project !== filters.filterProjectId) return false
  if (Array.isArray(filters.excludeStatuses) && record.status !== null && filters.excludeStatuses.includes(record.status)) return false
  if (filters.type !== undefined && filters.type !== null && record.type !== filters.type) return false
  return true
}

/**
 * Normalise a SQLite row into a candidate record.
 *
 * @param {object} row - the database row.
 * @returns {object} the candidate.
 */
function toCandidate(row) {
  return {
    path: row.path,
    hash: row.hash,
    id: row.id,
    type: row.type,
    title: row.title,
    status: row.status,
    project: row.project,
    projectDir: row.project_dir,
    projectDirId8: row.project_id8,
    updated: row.updated,
    source: row.source,
    broken: row.broken === 1,
    body: row.body ?? '',
    rank: row.rank ?? null,
    matchedRatio: null,
  }
}

/**
 * Read-before-trust: verify a candidate against its source before returning it.
 *
 * The cached row is only a *candidate*. The source is stat-ed and hashed on every
 * hit; when the hash still matches, the cached body may be used, and when it does
 * not the note is re-read, re-parsed and re-matched — and the cache row is
 * repaired so the index converges. A vanished or oversized source drops the hit,
 * so a deleted file's cached body is never served (spec §7).
 *
 * @param {object} state - index state.
 * @param {object} candidate - candidate from the backend.
 * @param {object} plan - the query plan.
 * @returns {Promise<object|null>} the scored hit, or `null` when it must be dropped.
 */
async function verifyCandidate(state, candidate, plan) {
  let absolute
  try {
    absolute = await resolveVaultFile(state.vaultRoot, candidate.path)
  } catch {
    dropRecord(state, candidate.path)
    return null
  }
  let stats
  try {
    stats = await state.io.stat(absolute, { bigint: true })
  } catch (error) {
    if (error.code === 'ENOENT') {
      dropRecord(state, candidate.path)
      return null
    }
    throw new IndexError('read-failed', `cannot stat ${candidate.path}: ${error.code ?? error.message}`, { cause: error })
  }
  if (!stats.isFile() || stats.size > BigInt(state.maxFileBytes)) {
    dropRecord(state, candidate.path)
    return null
  }
  let record = candidate
  let repaired = false
  const bytes = await state.io.readFile(absolute)
  const hash = sha256Hex(bytes)
  if (hash !== candidate.hash) {
    const fresh = parseNoteRecord(candidate.path, bytes, {
      hash,
      size: Number(stats.size),
      mtime: mtimeMicros(stats),
    })
    storeRecord(state, fresh)
    repaired = true
    if (!matchesQuery(fresh, plan)) return null
    record = fresh
  }
  return scoreCandidate(record, plan, { repaired })
}

/**
 * Whether a record still satisfies the query (used after re-reading a changed source).
 *
 * @param {object} record - the fresh record.
 * @param {object} plan - the query plan.
 * @returns {boolean} whether it matches.
 */
function matchesQuery(record, plan) {
  if (plan.branch === 'tokens') return plan.tokens.some((token) => record.tokenSet.has(token))
  return record.searchText.toLowerCase().includes(plan.needle.toLowerCase())
}

/**
 * Turn a verified record into a hit with explainable ranking signals (spec §7).
 *
 * @param {object} record - the verified record.
 * @param {object} plan - the query plan.
 * @param {{repaired: boolean}} options - whether this read repaired the cache row.
 * @returns {object} the hit.
 */
function scoreCandidate(record, plan, { repaired }) {
  const title = record.title ?? ''
  const body = record.body ?? ''
  const needle = plan.needle.toLowerCase()
  const titleLower = title.toLowerCase()
  const tokenSet = record.tokenSet ?? new Set([...indexText(title), ...indexText(body)])
  const titleExact = title.length > 0 && titleLower === needle
  const titleContains = !titleExact && title.length > 0 && titleLower.includes(needle)
  const phraseContains = needle.length > 0 && body.toLowerCase().includes(needle)
  const tokenHits = plan.tokens.filter((token) => tokenSet.has(token)).length
  const typeWeight = TYPE_WEIGHTS[record.type] ?? 0
  const freshness = freshnessBonus(record.updated)
  const relevance = record.rank === null || record.rank === undefined
    ? (record.matchedRatio ?? 0) * 1e-6
    : -record.rank
  const score = (titleExact ? 50 : 0) + (titleContains ? 20 : 0) + (phraseContains ? 10 : 0)
    + typeWeight + freshness + relevance
  return {
    path: record.path,
    title: record.title,
    type: record.type,
    status: record.status,
    id: record.id,
    projectId: record.project,
    projectDirId8: record.projectDirId8,
    updated: record.updated,
    source: record.source,
    hash: record.hash,
    snippet: buildSnippet(record, [plan.needle, ...plan.tokens]),
    score,
    backend: null,
    signals: {
      relevance,
      bm25: record.rank ?? null,
      matchedBy: plan.branch,
      tokenHits,
      titleExact,
      titleContains,
      phraseContains,
      substringMatch: plan.branch === 'substring',
      typeWeight,
      freshness,
      history: record.status !== null && SUPERSEDED_STATUSES.includes(record.status),
      frontmatterBroken: record.broken === true,
      repaired,
      verifiedSource: true,
    },
  }
}

/**
 * A bounded recency bonus, so newer memories win ties but never outrank relevance.
 *
 * @param {string|null} updated - `YYYY-MM-DD` from the frontmatter.
 * @returns {number} `0`, `1` or `2`.
 */
function freshnessBonus(updated) {
  if (typeof updated !== 'string') return 0
  const stamp = Date.parse(`${updated}T00:00:00Z`)
  if (Number.isNaN(stamp)) return 0
  const ageDays = (Date.now() - stamp) / 86_400_000
  if (ageDays <= FRESHNESS_DAYS[0]) return 2
  if (ageDays <= FRESHNESS_DAYS[1]) return 1
  return 0
}

/**
 * A verbatim excerpt around the first match, from the verified source body.
 *
 * @param {object} record - the verified record.
 * @param {string[]} needles - candidate match strings, best first.
 * @returns {string} the excerpt.
 */
function buildSnippet(record, needles) {
  const text = `${record.title === null ? '' : `${record.title}\n`}${record.body ?? ''}`.replace(/\s+/g, ' ').trim()
  for (const needle of needles) {
    if (typeof needle !== 'string' || needle === '') continue
    const index = text.toLowerCase().indexOf(needle.toLowerCase())
    if (index < 0) continue
    const start = Math.max(0, index - SNIPPET_RADIUS)
    const end = Math.min(text.length, index + needle.length + SNIPPET_RADIUS)
    return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`
  }
  return text.slice(0, SNIPPET_RADIUS * 2)
}

// ---------------------------------------------------------------------------
// Readiness, status and shutdown
// ---------------------------------------------------------------------------

/**
 * The readiness barrier (spec §7).
 *
 * Never resolves to "no results": it answers `ready: true`, or `ready: false`
 * with a reason (`index-not-ready`, `closed`, or the recorded scan failure), so a
 * timeout can never be mistaken for an empty vault.
 *
 * @param {object} state - index state.
 * @param {AbortSignal} [signal] - caller cancellation.
 * @param {number} [timeoutMs] - upper bound on the wait.
 * @returns {Promise<{ready: boolean, reason?: string, backend: string, notes?: number}>} the status.
 */
async function waitReady(state, signal, timeoutMs = DEFAULT_READY_TIMEOUT_MS) {
  if (typeof timeoutMs !== 'number' || Number.isNaN(timeoutMs) || timeoutMs < 0) {
    throw new RangeError('timeoutMs must be a non-negative number')
  }
  const settle = () => {
    if (state.ready) return { ready: true, backend: state.backend, notes: state.noteCount }
    if (state.closed) return { ready: false, reason: 'closed', backend: state.backend }
    if (state.initialError !== null) {
      return {
        ready: false,
        reason: `${state.initialError.code}: ${state.initialError.message}`,
        backend: state.backend,
      }
    }
    return { ready: false, reason: 'index-not-ready', backend: state.backend, scanning: state.scanning }
  }
  if (state.ready || state.closed || state.initialError !== null) return settle()
  if (signal !== null && signal !== undefined && signal.aborted) {
    return { ready: false, reason: 'aborted', backend: state.backend }
  }

  let timer
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs)
    timer.unref?.()
  })
  const aborted = new Promise((resolve) => {
    if (signal === null || signal === undefined || typeof signal.addEventListener !== 'function') return
    signal.addEventListener('abort', () => resolve('aborted'), { once: true })
  })
  const outcome = await Promise.race([
    (state.initial ?? Promise.resolve()).then(() => 'settled'),
    timeout,
    aborted,
  ])
  clearTimeout(timer)
  if (outcome === 'timeout') {
    return { ready: false, reason: 'index-not-ready', backend: state.backend, scanning: state.scanning }
  }
  if (outcome === 'aborted') {
    return { ready: false, reason: 'aborted', backend: state.backend }
  }
  return settle()
}

/**
 * A snapshot of the index, cheap enough to call from any tool.
 *
 * @param {object} state - index state.
 * @returns {object} the status.
 */
function status(state) {
  return {
    backend: state.backend,
    requestedBackend: state.requestedBackend,
    degraded: state.degraded,
    reason: state.reason,
    ready: state.ready,
    scanning: state.scanning,
    stale: state.stale,
    closed: state.closed,
    lastError: state.lastError,
    lastScan: state.lastScan,
    schemaVersion: state.backend === 'sqlite' ? INDEX_SCHEMA_VERSION : null,
    notes: state.noteCount,
    dbPath: state.backend === 'sqlite' ? state.dbPath : null,
    indexDir: state.indexDir,
    vaultRoot: state.vaultRoot,
    boundProjectId: state.boundProjectId,
    quarantined: [...state.quarantined],
    skipped: { ...state.skipped },
    fts: state.backend === 'sqlite',
  }
}

/**
 * Close the index. Idempotent, and it never removes anything but the handle.
 *
 * @param {object} state - index state.
 * @returns {Promise<void>} resolves once the handle is closed.
 */
async function close(state) {
  if (state.closed) return
  state.closed = true
  state.ready = false
  // Drain a scan already in flight so the handle is never closed underneath it.
  await state.refreshChain.catch(() => {})
  const db = state.db
  state.db = null
  if (db !== null) {
    try { db.close() } catch { /* an unusable handle has nothing to release */ }
  }
}
