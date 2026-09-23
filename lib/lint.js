// Read-only vault governance for the obsidian-mem plugin (Task 17, design §11).
//
// `lintVault` answers one question — *what is wrong with this vault right now?* —
// and, by default, answers it without writing a single byte. The whole module is
// built around that default:
//
//   * **Read-only unless asked.** The default call inspects the vault, the index
//     and the pending queue and returns a structured report. It creates no file,
//     touches no note and never rewrites a repository document. Writes happen
//     only when the caller explicitly asks for them (`report`, `pruneHistory`),
//     and the only vault file the report path may create is the dated
//     `_meta/Lint Report <date>.md`.
//   * **The repository audit reports candidates and moves nothing.** A repository
//     Markdown file that no vault note references is listed in the report; it is
//     never copied, mirrored, moved or rewritten. Mirroring is a decision for the
//     user, not a side effect of an inspection.
//   * **The safety exclusions are fixed and can only grow.** `SAFETY_EXCLUSIONS`
//     covers the plugin's own internal material (the receipt log, the registry,
//     the lint reports, `.history/`, `.obsidian/`, `pending/`, `.git/`,
//     `node_modules/`). A user's `ignoreGlobs` adds entries; because the glob
//     language refuses negation, no user glob can cancel one of them.
//   * **`.history` growth is bounded, never blind and never unserialized.**
//     Committed snapshots of ordinary notes are the only recovery material for
//     content that no longer exists anywhere else, so retention keeps the newest
//     `keepCount` directories and everything younger than `maxAgeDays`, never
//     removes anything younger than `minAgeHours`, and never removes a directory
//     a `needs-manual-repair`, live or unresolved transaction still references.
//     The sweep is an explicit request of its own (`pruneHistory`, or
//     `mem_admin(action="lint", prune=true)`) — asking for the dated report does
//     not delete anything — and it runs through `withVaultLock`, the same
//     `realpath(vaultRoot)`-keyed lock every transaction takes, so it can never
//     interleave with an in-flight write. A lock it cannot take deletes nothing
//     and is reported as `history-prune-blocked`.
//
// Where the index is concerned, `openIndex` exposes no row enumeration
// (`status`, `search`, `refresh`, `ready`, `close` only), and a report that can
// only compare *counts* silently misses the case where one file appeared and one
// file vanished at the same time. This module therefore reads the index's own
// SQLite cache through a second, read-only connection (`SELECT path FROM notes`)
// to name exact orphan rows and orphan files, and falls back to an honest
// count-level `index-inconsistent` finding when that cache cannot be read (the
// scan backend, a missing database, an unreadable file). The index is the
// plugin's own cache under the data root; only `notes.path` is read.
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

import { compileIgnoreGlobs, matchesIgnoreGlob } from './config.js'
import { parseNote } from './frontmatter.js'
import { indexFilePath, isIndexableRelativePath, MAX_NOTE_BYTES } from './index-db.js'
import { readPendingJobs } from './pending.js'
import { locateGeneratedBlock, MemoryError, sha256Hex } from './routing.js'
import {
  DEFAULT_LOCK_TIMEOUT_MS,
  newTransactionId,
  resolveVaultFile,
  resolveVaultRoot,
  runTransaction,
  TransactionError,
  vaultIdentity,
  withVaultLock,
} from './vault.js'

/** The prefix of the dated report note; the design names `_meta/Lint Report <date>.md`. */
export const LINT_REPORT_PREFIX = 'Lint Report'
/** How many recorded findings one report carries before it says it truncated. */
const MAX_FINDINGS = 500
/** How many repository candidates one audit lists before it says it truncated. */
const MAX_REPO_FINDINGS = 200
/** How many notes one scan reads before it stops and reports the bound. */
const MAX_LINT_FILES = 20_000
/** The deepest vault/repository directory a scan descends into (mirrors the indexer). */
const MAX_LINT_DEPTH = 8
/** How many days without a report the weekly hint starts asking. */
const LINT_HINT_AGE_DAYS = 7

/**
 * Paths the plugin never inspects, whatever the user's `ignoreGlobs` say.
 *
 * The list mirrors what the index already refuses to retrieve plus the plugin's
 * own working material. It is applied *in addition to* the user's globs, and the
 * glob language has no negation, so a user glob can add an exclusion but can
 * never cancel one of these.
 */
export const SAFETY_EXCLUSIONS = Object.freeze([
  '.git/**',
  '**/.git/**',
  'node_modules/**',
  '**/node_modules/**',
  '.obsidian/**',
  '.trash/**',
  '_meta/.history/**',
  '_meta/log.md',
  '_meta/项目注册表.md',
  `_meta/${LINT_REPORT_PREFIX} *.md`,
  'pending/**',
  '**/pending/**',
])

/**
 * The bounded `.history` retention policy (R30).
 *
 * `keepCount` and `maxAgeDays` are the two bounds an entry must be outside to be
 * prunable; `minAgeHours` is the floor that keeps a running transaction's live
 * recovery material out of reach; `oversizeBytes`/`oversizedSnapshotBytes` are
 * the reporting thresholds for a history that has grown too large.
 */
export const HISTORY_POLICY = Object.freeze({
  keepCount: 200,
  maxAgeDays: 90,
  minAgeHours: 24,
  oversizeBytes: 32 * 1024 * 1024,
  oversizedSnapshotBytes: 8 * 1024 * 1024,
})

/** The vault-relative root of the snapshot history. */
export const HISTORY_RELATIVE_ROOT = '_meta/.history'
/** The directory holding the dated lint reports. */
const REPORT_DIRECTORY = '_meta'

/**
 * The statuses whose notes are history rather than current memory.
 *
 * An expired `review_after` on a superseded note is not a thing to review, so
 * those notes are excluded from the expiry finding exactly as they are excluded
 * from a default search.
 */
const HISTORY_STATUSES = Object.freeze(['superseded', 'archived'])
/** The owned frontmatter fields every plugin note must carry (§6.4). */
const REQUIRED_OWNED_FIELDS = Object.freeze(['type', 'title', 'status', 'created', 'updated'])
/** Containers that deliberately carry no `id` (spec §6.4 has no `hot` prefix). */
const IDLESS_TYPES = Object.freeze(new Set(['hot']))
/** A wikilink: `[[target]]`, `[[target|alias]]`, `[[target#heading]]`, `![[embed]]`. */
const WIKILINK_PATTERN = /!?\[\[([^\]|#\n]+)(?:#[^\]|\n]*)?(?:\|[^\]\n]*)?\]\]/g

/**
 * Today's local date as `YYYY-MM-DD` (never `toISOString()`, which is UTC).
 *
 * @param {Date} now - the clock.
 * @returns {string} the local date.
 */
function localDate(now) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** `lstat` that reports absence as `null` and every other failure as a throw. */
async function lstatOrNull(path) {
  try {
    return await fs.lstat(path)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

/**
 * The vault-relative path of one date's lint report.
 *
 * @param {Date} now - the clock.
 * @returns {string} `_meta/Lint Report <YYYY-MM-DD>.md`.
 */
export function lintReportRelativePath(now) {
  return `${REPORT_DIRECTORY}/${LINT_REPORT_PREFIX} ${localDate(now)}.md`
}

// ---------------------------------------------------------------------------
// lintVault
// ---------------------------------------------------------------------------

/**
 * Inspect one bound project's vault and return a structured report.
 *
 * @param {object} options - the inspection inputs.
 * @param {object} options.binding - a `kind:'bound'` binding.
 * @param {object|null} [options.index] - the open index handle (`status()`; the same one the tools use).
 * @param {string|null} [options.repoRoot] - repository root for the Markdown audit.
 * @param {string|null} [options.queueRoot] - pending queue root for the backlog check.
 * @param {string[]} [options.ignoreGlobs] - the validated user exclusions (they can only add).
 * @param {string|null} [options.dataRoot] - the plugin data root; required to name live transactions and to write.
 * @param {boolean} [options.report] - explicitly create/update `_meta/Lint Report <date>.md`; it never deletes anything.
 * @param {boolean} [options.pruneHistory] - explicitly apply the `.history` retention policy (under the whole-vault write lock); independent of `report`.
 * @param {object} [options.historyPolicy] - retention-policy overrides (tests, operators).
 * @param {number} [options.pruneLockTimeoutMs] - how long the sweep waits for the vault write lock.
 * @param {string} [options.home] - home seam for `~/` expansion.
 * @param {Date} [options.now] - clock injection point.
 * @param {AbortSignal} [options.signal] - cooperative cancellation.
 * @returns {Promise<object>} the report.
 * @throws {RangeError} when the binding, an option or a glob is invalid.
 */
export async function lintVault(options = {}) {
  const {
    binding,
    index = null,
    repoRoot = null,
    queueRoot = null,
    ignoreGlobs = [],
    dataRoot = null,
    report: writeReport = false,
    pruneHistory = false,
    historyPolicy = {},
    pruneLockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
    home = homedir(),
    now = new Date(),
    signal = null,
  } = options

  const project = requireBoundBinding(binding)
  if (index !== null && (typeof index !== 'object' || typeof index.status !== 'function')) {
    throw new RangeError('lintVault accepts the object openIndex() returns, or null')
  }
  if ((writeReport === true || pruneHistory === true) && (typeof dataRoot !== 'string' || dataRoot === '')) {
    throw new RangeError('lintVault needs the plugin data root to write a report or prune history')
  }
  const policy = normalizeHistoryPolicy(historyPolicy)
  const userGlobs = [...ignoreGlobs]
  const matchers = compileIgnoreGlobs([...SAFETY_EXCLUSIONS, ...userGlobs])
  const vault = await resolveVaultRoot(binding.vaultRoot, { home })
  const vaultRoot = vault.root
  const today = localDate(now)

  throwIfAborted(signal)
  const findings = []
  const add = (kind, severity, path, message, extra = {}) => {
    if (findings.length >= MAX_FINDINGS) return
    findings.push({ kind, severity, path: path ?? null, message, ...extra })
  }

  const swept = await sweepVault(vaultRoot, { matchers })
  const noteRecords = await readNotes(vaultRoot, swept)
  // A note the indexer would skip for its size is not an orphan, so the
  // comparison uses the files both sides can actually hold.
  const indexableRecords = noteRecords.filter((record) => record.reason !== 'oversize')
  const filePaths = new Set(swept.entries.filter((entry) => entry.kind === 'file').map((entry) => entry.path))
  const foldedFiles = new Set([...filePaths].map((path) => path.toLowerCase()))
  const linkNames = new Set()

  checkNotes({ records: noteRecords, add, today, filePaths, foldedFiles, linkNames })
  checkCaseFoldDuplicates({ records: noteRecords, add })
  const indexReport = await checkIndex({
    index, vaultRoot, dataRoot, home, swept, indexableRecords, add,
  })
  const history = await checkHistory({
    binding, vaultRoot, dataRoot, home, policy, prune: pruneHistory, lockTimeoutMs: pruneLockTimeoutMs, add,
  })
  throwIfAborted(signal)
  const pending = queueRoot === null || queueRoot === undefined
    ? { jobs: 0, failed: 0, invalid: 0, known: false }
    : await checkQueue(queueRoot, add)
  const repository = repoRoot === null || repoRoot === undefined
    ? { scanned: 0, candidates: 0, truncated: false, known: false }
    : await auditRepository(repoRoot, { matchers, linkNames, add })

  const report = {
    projectId: project.projectId,
    relativeDir: project.relativeDir,
    generatedAt: now.toISOString(),
    today,
    readOnly: !(writeReport === true || pruneHistory === true),
    total: findings.length,
    counts: countByKind(findings),
    findings,
    index: indexReport,
    history,
    pending,
    repository,
    report: { status: 'none', path: null, message: null },
    safetyExclusions: [...SAFETY_EXCLUSIONS],
    ignoreGlobs: userGlobs,
    truncated: { vault: swept.truncated, repo: repository.truncated },
  }

  if (writeReport === true) {
    report.report = await writeLintReportNote(binding, report, { now, dataRoot, home })
  }
  return report
}

/**
 * Validate and project a binding onto the fields lint reads.
 *
 * @param {unknown} binding - the candidate.
 * @returns {{projectId: string, relativeDir: string, vaultRoot: string}} the validated fields.
 * @throws {RangeError} when it is not a bound project binding.
 */
function requireBoundBinding(binding) {
  if (binding === null || typeof binding !== 'object' || Array.isArray(binding)) {
    throw new RangeError('lintVault requires a bound project binding')
  }
  if (binding.kind !== 'bound') throw new RangeError(`lintVault requires a bound binding, not ${JSON.stringify(binding.kind)}`)
  if (typeof binding.relativeDir !== 'string' || binding.relativeDir.trim() === '') {
    throw new RangeError('binding.relativeDir must be a non-blank vault-relative path')
  }
  if (typeof binding.vaultRoot !== 'string' || binding.vaultRoot.trim() === '') {
    throw new RangeError('binding.vaultRoot must be a non-blank path')
  }
  return { projectId: binding.projectId, relativeDir: binding.relativeDir.replace(/\/+$/, ''), vaultRoot: binding.vaultRoot }
}

/** Merge caller overrides over the default retention policy, refusing nonsense. */
function normalizeHistoryPolicy(overrides) {
  const policy = { ...HISTORY_POLICY }
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (!Number.isFinite(value) || value < 0) throw new RangeError(`historyPolicy.${key} must be a non-negative number`)
    if (!Object.hasOwn(HISTORY_POLICY, key)) throw new RangeError(`unknown historyPolicy field: ${key}`)
    policy[key] = value
  }
  return policy
}

/** The cooperative cancellation check. */
function throwIfAborted(signal) {
  if (signal !== null && signal !== undefined && signal.aborted === true) {
    throw new Error('lintVault was cancelled')
  }
}

/** One finding count per kind, in first-seen order. */
function countByKind(findings) {
  const counts = {}
  for (const finding of findings) counts[finding.kind] = (counts[finding.kind] ?? 0) + 1
  return counts
}

// ---------------------------------------------------------------------------
// Walking and reading
// ---------------------------------------------------------------------------

/**
 * Walk one tree, returning every file and the directories it passed through.
 *
 * Symlinks are never followed (a link out of the vault is exactly what the vault
 * jail exists to refuse), a dot-directory is never entered, and both a depth and
 * a file-count bound are enforced so an inspection cannot be turned into an
 * unbounded walk. A tree that hit a bound is reported as `truncated`, never
 * silently as complete.
 *
 * @param {string} root - absolute directory.
 * @param {{matchers: RegExp[], maxFiles?: number, maxDepth?: number, entry?: Function}} input - exclusions and bounds.
 * @returns {Promise<{entries: object[], truncated: boolean}>} the entries.
 */
async function walkTree(root, { matchers, maxFiles = MAX_LINT_FILES, maxDepth = MAX_LINT_DEPTH, entry = null }) {
  const entries = []
  let truncated = false
  const queue = [{ relative: '', depth: 0 }]
  while (queue.length > 0) {
    const { relative, depth } = queue.shift()
    const absolute = relative === '' ? root : join(root, ...relative.split('/'))
    let children
    try {
      children = await fs.readdir(absolute, { withFileTypes: true })
    } catch (error) {
      if (error.code === 'ENOENT') continue
      throw error
    }
    children.sort((left, right) => (left.name < right.name ? -1 : 1))
    for (const child of children) {
      const childRelative = relative === '' ? child.name : `${relative}/${child.name}`
      if (childRelative.startsWith('.') || childRelative.includes('/.')) continue
      if (matchesIgnoreGlob(childRelative, matchers)) continue
      const childAbsolute = join(absolute, child.name)
      if (child.isSymbolicLink()) continue
      if (child.isDirectory()) {
        entries.push({ kind: 'directory', path: childRelative })
        if (depth + 1 >= maxDepth) continue
        queue.push({ relative: childRelative, depth: depth + 1 })
        continue
      }
      if (!child.isFile()) continue
      if (entry !== null && !entry(child.name, childRelative)) continue
      if (entries.length >= maxFiles) {
        truncated = true
        break
      }
      entries.push({ kind: 'file', path: childRelative, absolute: childAbsolute })
    }
    if (truncated) break
  }
  return { entries, truncated }
}

/** Sweep the whole vault once: every file, and every indexable note among them. */
async function sweepVault(vaultRoot, { matchers }) {
  const swept = await walkTree(vaultRoot, { matchers })
  return {
    ...swept,
    notes: swept.entries.filter((item) => item.kind === 'file' && isIndexableRelativePath(item.path)),
  }
}

/**
 * Read and parse every indexable note, never throwing on a broken one.
 *
 * @param {string} vaultRoot - the vault root.
 * @param {{notes: object[]}} swept - the swept notes.
 * @returns {Promise<object[]>} one record per note.
 */
async function readNotes(vaultRoot, swept) {
  const records = []
  for (const note of swept.notes) {
    const record = { path: note.path, absolute: note.absolute, bytes: null, note: null, error: null, reason: null }
    try {
      const stats = await fs.lstat(note.absolute)
      if (!stats.isFile() || stats.isSymbolicLink()) continue
      if (stats.size > MAX_NOTE_BYTES) {
        record.reason = 'oversize'
        record.error = new Error(`${note.path} is larger than the ${MAX_NOTE_BYTES}-byte note bound`)
        records.push(record)
        continue
      }
      record.bytes = await fs.readFile(note.absolute)
    } catch (error) {
      // An unreadable file is not a note with broken frontmatter: the two
      // failures need different answers, so they are labelled differently.
      record.reason = 'unreadable'
      record.error = error
      records.push(record)
      continue
    }
    try {
      record.note = parseNote(record.bytes)
    } catch (error) {
      record.reason = 'frontmatter'
      record.error = error
    }
    records.push(record)
  }
  return records
}

// ---------------------------------------------------------------------------
// Note-level findings
// ---------------------------------------------------------------------------

/**
 * Every per-note finding: broken frontmatter, a frontmatter gap, an expired
 * review date, and every wikilink that resolves to nothing.
 *
 * @param {object} input - records, the sink, the clock and the vault's file set.
 * @returns {void}
 */
function checkNotes({ records, add, today, filePaths, foldedFiles, linkNames }) {
  const seen = new Set()
  for (const record of records) {
    if (record.error !== null) {
      if (record.reason === 'oversize') {
        add('note-oversize', 'info', record.path, record.error.message)
      } else if (record.reason === 'unreadable') {
        add('note-unreadable', 'warn', record.path, `cannot read ${record.path}: ${record.error.code ?? record.error.message}`)
      } else {
        add('broken-frontmatter', 'error', record.path, `cannot parse ${record.path}: ${record.error.code ?? record.error.message}`)
      }
      continue
    }
    const note = record.note
    if (note === null) continue
    // A note without frontmatter is still a note with links: spec §7 keeps such a
    // file retrievable as plain text, so its wikilinks are inspected too.
    const data = note.data ?? {}
    if (note.hasFrontmatter === true && data.trust === 'agent') {
      const required = IDLESS_TYPES.has(data.type) ? REQUIRED_OWNED_FIELDS : ['id', ...REQUIRED_OWNED_FIELDS]
      const missing = required.filter((field) => data[field] === undefined || data[field] === null)
      if (missing.length > 0) {
        add('frontmatter-gap', 'warn', record.path, `${record.path} declares trust:agent but is missing ${missing.join(', ')}`)
      }
    }
    const reviewAfter = note.hasFrontmatter === true && typeof data.review_after === 'string' ? data.review_after : null
    if (reviewAfter !== null && reviewAfter < today && !HISTORY_STATUSES.includes(data.status)) {
      add('expired-review', 'info', record.path, `${record.path} was due for review on ${reviewAfter}`)
    }
    const text = note.body ?? ''
    WIKILINK_PATTERN.lastIndex = 0
    let match = WIKILINK_PATTERN.exec(text)
    while (match !== null) {
      const target = match[1].trim()
      if (target !== '') {
        linkNames.add(foldedNameOf(target))
        if (!resolvesLink(target, record.path, filePaths, foldedFiles)) {
          const key = `${record.path}\u0000${target}`
          if (!seen.has(key)) {
            seen.add(key)
            add('dead-wikilink', 'warn', record.path, `${record.path} links to [[${target}]], which does not exist in this vault`)
          }
        }
      }
      match = WIKILINK_PATTERN.exec(text)
    }
  }
}

/** Report two notes whose names differ only by case — an ambiguous link target. */
function checkCaseFoldDuplicates({ records, add }) {
  const groups = new Map()
  for (const record of records) {
    if (record.error !== null || record.note === null) continue
    const name = basename(record.path)
    const folded = name.toLowerCase()
    if (!groups.has(folded)) groups.set(folded, new Map())
    groups.get(folded).set(name, record.path)
  }
  for (const [folded, names] of groups) {
    if (names.size < 2) continue
    const paths = [...names.values()].sort()
    add('duplicate-name', 'warn', paths[0], `names differing only by case make [[${[...names.keys()][0]}]] ambiguous: ${paths.join(', ')}`, { paths })
  }
}

/** The folded basename stem or name a vault link target contributes to the audit. */
function foldedNameOf(target) {
  const cleaned = String(target).replace(/\.md$/i, '')
  const name = cleaned.slice(cleaned.lastIndexOf('/') + 1)
  return name.toLowerCase()
}

/**
 * Whether a wikilink target resolves inside the vault.
 *
 * A target may be vault-relative (`项目/x--y/文档/Notes`) or relative to the
 * linking note's own directory (Obsidian resolves the shortest form), with or
 * without the `.md` extension, and matching is case-insensitive exactly as
 * Obsidian's resolver is. An external URL is not this vault's business.
 */
function resolvesLink(target, notePath, filePaths, foldedFiles) {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target) || target.startsWith('mailto:')) return true
  const cleaned = target.replace(/\.md$/i, '').replace(/^\.\//, '')
  if (cleaned === '') return true
  const directory = notePath.includes('/') ? `${notePath.slice(0, notePath.lastIndexOf('/'))}/` : ''
  const candidates = [cleaned, `${directory}${cleaned}`]
  for (const candidate of candidates) {
    if (filePaths.has(candidate) || filePaths.has(`${candidate}.md`)) return true
    const folded = candidate.toLowerCase()
    if (foldedFiles.has(folded) || foldedFiles.has(`${folded}.md`)) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Index consistency
// ---------------------------------------------------------------------------

/**
 * Compare the index's own rows with the files the vault actually holds.
 *
 * `openIndex` cannot enumerate its rows, so an exact comparison reads the cache's
 * `notes.path` column through a read-only connection. When that is impossible the
 * module degrades to a count comparison and says so, instead of inventing an
 * answer: a report is allowed to know less, never to claim more.
 *
 * @param {object} input - the index handle, vault root, data root and the sink.
 * @returns {Promise<object>} the index section of the report.
 */
async function checkIndex({ index, vaultRoot, dataRoot, home, swept, indexableRecords, add }) {
  const status = index === null ? null : index.status()
  const files = indexableRecords.map((record) => record.path).sort()
  const section = {
    backend: status?.backend ?? null,
    ready: status?.ready === true,
    notes: typeof status?.notes === 'number' ? status.notes : null,
    files: files.length,
    rows: null,
    compared: false,
    reason: null,
  }
  if (index === null) {
    section.reason = 'no-index'
    return section
  }
  if (!section.ready || status?.scanning === true) {
    // A scan that has not finished has not observed every file yet: "not ready"
    // is never "the vault disagrees with the index".
    section.reason = 'index-not-ready'
    add('index-not-ready', 'info', null, 'the memory index has not completed a scan, so its rows were not compared with the vault')
    return section
  }
  if (swept.truncated) {
    section.reason = 'walk-truncated'
    add('index-inconsistent', 'info', null, 'the vault walk hit its bound, so the index comparison was skipped rather than guessed')
    return section
  }
  const rows = await readIndexRowPaths({ vaultRoot, dataRoot, home, status })
  section.reason = rows.reason
  if (rows.paths === null) {
    // Count-level fallback: still honest, just less specific.
    if (section.notes !== null && section.notes !== files.length) {
      add(
        'index-inconsistent',
        'warn',
        null,
        `the index holds ${section.notes} notes while the vault holds ${files.length} indexable files (${rows.reason}); rows could not be enumerated`,
      )
    }
    return section
  }
  section.rows = rows.paths.length
  section.compared = true
  const rowSet = new Set(rows.paths)
  const fileSet = new Set(files)
  for (const path of rows.paths) {
    if (!fileSet.has(path)) add('orphan-index-row', 'warn', path, `the index still holds a row for ${path}, which no longer exists in the vault`)
  }
  for (const path of files) {
    if (!rowSet.has(path)) add('orphan-file', 'warn', path, `${path} exists in the vault but has no row in the index`)
  }
  return section
}

/**
 * Read the index cache's row paths through a read-only connection.
 *
 * Only `SELECT path FROM notes` is ever executed, and every failure (the scan
 * backend has no database, the file is missing, the schema moved on) is reported
 * as a reason rather than thrown: an unreadable cache is a smaller report, not a
 * failed inspection.
 *
 * @param {object} input - vault root, data root, home and the index status.
 * @returns {Promise<{paths: string[]|null, reason: string|null}>} the row paths or why they are unavailable.
 */
async function readIndexRowPaths({ vaultRoot, dataRoot, home, status }) {
  if (typeof dataRoot !== 'string' || dataRoot === '') return { paths: null, reason: 'no-data-root' }
  if (status?.backend !== 'sqlite') return { paths: null, reason: `backend-${status?.backend ?? 'unknown'}` }
  let dbPath
  try {
    dbPath = await indexFilePath(vaultRoot, dataRoot, { home })
  } catch (error) {
    return { paths: null, reason: error.code ?? 'index-path-unavailable' }
  }
  if ((await lstatOrNull(dbPath)) === null) return { paths: null, reason: 'index-database-missing' }
  let db = null
  try {
    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(dbPath, { readOnly: true })
    const rows = db.prepare('SELECT path FROM notes ORDER BY path').all()
    return { paths: rows.map((row) => String(row.path)), reason: null }
  } catch (error) {
    return { paths: null, reason: error.code ?? error.message ?? 'index-unreadable' }
  } finally {
    try {
      db?.close()
    } catch {
      /* a reader that never opened has nothing to release */
    }
  }
}

// ---------------------------------------------------------------------------
// History retention (R30)
// ---------------------------------------------------------------------------

/**
 * Apply the `.history` retention policy and report what it found.
 *
 * Nothing is deleted unless `prune` is true. A directory is protected when it
 * carries a failure manifest (the transaction needs manual repair), when the
 * plugin's transaction store still has a manifest for that txId (the transaction
 * is live or unresolved), or when a failure record exists for it.
 *
 * @param {object} input - binding, vault root, data root, policy, prune flag and sink.
 * @returns {Promise<object>} the history section of the report.
 */
async function checkHistory({ binding, vaultRoot, dataRoot, home, policy, prune, lockTimeoutMs, add }) {
  const section = {
    policy: { ...policy },
    directories: 0,
    bytes: 0,
    prunable: 0,
    pruned: [],
    needsRepair: [],
    oversized: false,
    oversizedSnapshots: [],
  }
  const absolute = await resolveVaultFile(vaultRoot, HISTORY_RELATIVE_ROOT, { home }).catch(() => null)
  if (absolute === null || (await lstatOrNull(absolute)) === null) return section
  const identity = dataRoot === null || dataRoot === undefined ? null : await vaultIdentity(binding, { home }).catch(() => null)
  let names
  try {
    names = (await fs.readdir(absolute, { withFileTypes: true })).filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
  } catch (error) {
    // A read failure (permissions, I/O, something that is not a directory at all)
    // is a finding about the history, never a crash of the whole inspection.
    add('history-unreadable', 'warn', HISTORY_RELATIVE_ROOT, `cannot read ${HISTORY_RELATIVE_ROOT}: ${error.code ?? error.message}`)
    return section
  }
  const now = Date.now()
  const inspected = []
  for (const entry of names) {
    const directory = join(absolute, entry.name)
    try {
      inspected.push({ txId: entry.name, ...(await inspectHistoryDirectory(directory, policy)) })
    } catch (error) {
      add('history-unreadable', 'warn', `${HISTORY_RELATIVE_ROOT}/${entry.name}`, `cannot read ${HISTORY_RELATIVE_ROOT}/${entry.name}: ${error.code ?? error.message}`)
    }
  }
  // The count bound is about recency: the newest `keepCount` transactions are
  // kept whatever their age, and everything older must also clear the age bound.
  inspected.sort((left, right) => right.newestMs - left.newestMs)
  const candidates = []
  for (const [index, facts] of inspected.entries()) {
    section.directories += 1
    section.bytes += facts.bytes
    if (facts.oversized !== null) section.oversizedSnapshots.push(facts.oversized)
    if (facts.manifest !== null && facts.manifest.state === 'needs-manual-repair') section.needsRepair.push(facts.txId)
    const protectedByReference = await isTransactionReferenced(facts.txId, { facts, dataRoot, identity, binding })
    const ageMs = now - facts.newestMs
    const beyond = index >= policy.keepCount || ageMs > policy.maxAgeDays * 86_400_000
    const prunable = !protectedByReference && beyond && ageMs > policy.minAgeHours * 3_600_000
    if (prunable) candidates.push({ txId: facts.txId, path: `${HISTORY_RELATIVE_ROOT}/${facts.txId}`, bytes: facts.bytes })
  }
  section.prunable = candidates.length
  if (section.bytes > policy.oversizeBytes) {
    section.oversized = true
    add('history-oversized', 'warn', HISTORY_RELATIVE_ROOT, `.history holds ${section.bytes} bytes across ${section.directories} transactions, above the ${policy.oversizeBytes}-byte bound`)
  }
  for (const oversized of section.oversizedSnapshots) {
    add('history-oversized', 'warn', oversized.path, `${oversized.path} is ${oversized.bytes} bytes, above the ${policy.oversizedSnapshotBytes}-byte per-file bound`)
  }
  for (const txId of section.needsRepair) {
    add('history-needs-repair', 'error', `${HISTORY_RELATIVE_ROOT}/${txId}`, `transaction ${txId} needs manual repair; automatic writes refuse until it is resolved and its snapshots are never pruned`)
  }
  if (!prune) return section
  section.pruned = await sweepHistoryUnderLock({
    binding, vaultRoot, dataRoot, home, policy, candidates, lockTimeoutMs, add,
  })
  if (section.pruned.length > 0) {
    add('history-pruned', 'info', HISTORY_RELATIVE_ROOT, `pruned ${section.pruned.length} snapshot transaction(s) older than the retention policy: ${section.pruned.join(', ')}`)
  }
  return section
}

/**
 * Delete the prunable history directories while holding the whole-vault lock.
 *
 * Every vault mutation is serialized by the same `realpath(vaultRoot)`-keyed lock
 * the transaction engine uses, so the sweep runs through `withVaultLock`: an
 * in-flight transaction (or a recovery) finishes first, and each candidate is
 * re-checked against the *locked* state before a byte is removed. A lock that
 * cannot be taken — or a vault that still owes manual repair — deletes nothing and
 * is reported as `history-prune-blocked`, never as a partial sweep.
 *
 * @param {{binding: object, vaultRoot: string, dataRoot: string, home: string, policy: object, candidates: object[], lockTimeoutMs: number, add: Function}} input - the sweep inputs.
 * @returns {Promise<string[]>} the txIds actually removed.
 */
async function sweepHistoryUnderLock({ binding, vaultRoot, dataRoot, home, policy, candidates, lockTimeoutMs, add }) {
  if (candidates.length === 0) return []
  try {
    return await withVaultLock(binding, async ({ identity }) => {
      const pruned = []
      for (const candidate of candidates) {
        const target = await resolveVaultFile(vaultRoot, candidate.path, { home }).catch(() => null)
        if (target === null) continue
        const stats = await lstatOrNull(target)
        if (stats === null || !stats.isDirectory() || stats.isSymbolicLink()) continue
        let facts
        try {
          facts = await inspectHistoryDirectory(target, policy)
        } catch {
          continue
        }
        // Re-checked under the lock: a transaction that ran while this sweep was
        // waiting may have made the directory live or unresolved.
        if (facts.manifest !== null) continue
        if (await isTransactionReferenced(candidate.txId, { facts, dataRoot, identity, binding })) continue
        if (Date.now() - facts.newestMs <= policy.minAgeHours * 3_600_000) continue
        try {
          await fs.rm(target, { recursive: true, force: true })
          pruned.push(candidate.txId)
        } catch (error) {
          add('history-prune-failed', 'warn', candidate.path, `could not prune ${candidate.path}: ${error.code ?? error.message}`)
        }
      }
      return pruned
    }, { dataRoot, home, recover: true, lockTimeoutMs })
  } catch (error) {
    // A sweep that cannot run is reported, never thrown: the report still has to
    // describe the vault, and "nothing was deleted" is the whole point.
    if (error instanceof TransactionError) {
      add(
        'history-prune-blocked',
        'warn',
        HISTORY_RELATIVE_ROOT,
        `the .history sweep could not take the vault write lock (${error.code}): ${error.message}; nothing was deleted`,
      )
    } else {
      add(
        'history-prune-failed',
        'warn',
        HISTORY_RELATIVE_ROOT,
        `the .history sweep failed before deleting anything: ${error.code ?? error.message}`,
      )
    }
    return []
  }
}

/**
 * Measure one history directory: its bytes, newest mtime, largest snapshot and
 * any failure manifest it carries.
 *
 * @param {string} directory - absolute history transaction directory.
 * @returns {Promise<object>} the facts.
 */
async function inspectHistoryDirectory(directory, policy) {
  let bytes = 0
  let newestMs = 0
  let manifest = null
  let oversized = null
  const entries = await fs.readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const file = join(directory, entry.name)
    const stats = await fs.lstat(file)
    bytes += stats.size
    newestMs = Math.max(newestMs, stats.mtimeMs)
    if (entry.name === 'manifest.json') {
      try {
        manifest = JSON.parse(await fs.readFile(file, 'utf8'))
      } catch {
        manifest = { state: 'unreadable' }
      }
    }
    if (stats.size > policy.oversizedSnapshotBytes) {
      oversized = { path: `${HISTORY_RELATIVE_ROOT}/${basename(directory)}/${entry.name}`, bytes: stats.size }
    }
  }
  const directoryStats = await fs.lstat(directory)
  newestMs = Math.max(newestMs, directoryStats.mtimeMs)
  return { bytes, newestMs, manifest, oversized }
}

/**
 * Whether a transaction store still references one history directory.
 *
 * Two references exist beside the vault copy: the transaction manifest the engine
 * writes under `<dataRoot>/transactions/<vaultHash>/` (a transaction that is
 * still live or unresolved) and the failure record under
 * `<dataRoot>/receipts/<vaultHash>/<projectId>/failures/`. Either one spares the
 * directory.
 */
async function isTransactionReferenced(txId, { facts, dataRoot, identity, binding }) {
  if (facts.manifest !== null) return true
  if (dataRoot === null || dataRoot === undefined || identity === null) return false
  const manifest = join(dataRoot, 'transactions', identity.vaultHash, `${txId}.json`)
  if ((await lstatOrNull(manifest)) !== null) return true
  const failure = join(dataRoot, 'receipts', identity.vaultHash, binding.projectId, 'failures', `${txId}.json`)
  return (await lstatOrNull(failure)) !== null
}

// ---------------------------------------------------------------------------
// Pending queue and repository audit
// ---------------------------------------------------------------------------

/**
 * Report the pending queue: how much is waiting, what failed, what is corrupt.
 *
 * @param {string} queueRoot - the queue root.
 * @param {Function} add - finding sink.
 * @returns {Promise<object>} the pending section.
 */
async function checkQueue(queueRoot, add) {
  let jobs
  let invalid
  try {
    ({ jobs, invalid } = await readPendingJobs(queueRoot))
  } catch (error) {
    // An unreadable queue is "the backlog could not be read", never a failed
    // inspection of the vault.
    add('pending-unreadable', 'warn', 'pending', `cannot read the pending queue: ${error.code ?? error.message}`)
    return { jobs: 0, failed: 0, invalid: 0, known: false }
  }
  const section = { jobs: jobs.length, failed: 0, invalid: invalid.length, known: true }
  const failed = []
  for (const job of jobs) {
    if (job.state === 'failed') {
      section.failed += 1
      failed.push(`${job.jobId}(attempts=${job.attempts ?? 0})`)
    }
  }
  if (jobs.length > 0) {
    add(
      'pending-backlog',
      section.failed > 0 ? 'warn' : 'info',
      null,
      `${jobs.length} pending job(s) are queued${section.failed > 0 ? `, ${section.failed} terminally failed: ${failed.join(', ')}` : ''}`,
    )
  }
  for (const entry of invalid) {
    add('pending-invalid', 'warn', `pending/${entry.file}`, `${entry.file} is not a readable pending job: ${entry.reason}`)
  }
  return section
}

/**
 * Report repository Markdown that no vault note references.
 *
 * The audit is deliberately one-directional: it lists candidates and writes
 * nothing. A repository file counts as referenced when a vault note links to its
 * name (a wikilink target) or when a vault note with that name exists.
 *
 * @param {string} repoRoot - absolute repository root.
 * @param {{matchers: RegExp[], linkNames: Set<string>, add: Function}} input - exclusions, vault names and the sink.
 * @returns {Promise<object>} the repository section.
 */
async function auditRepository(repoRoot, { matchers, linkNames, add }) {
  let walked
  try {
    walked = await walkTree(repoRoot, {
      matchers,
      maxFiles: 5_000,
      entry: (name) => name.toLowerCase().endsWith('.md'),
    })
  } catch (error) {
    add('repository-unreadable', 'warn', null, `the repository Markdown audit could not walk ${repoRoot}: ${error.code ?? error.message}`)
    return { scanned: 0, candidates: 0, truncated: false, known: false }
  }
  const section = { scanned: 0, candidates: 0, truncated: walked.truncated, known: true }
  for (const file of walked.entries.filter((entry) => entry.kind === 'file')) {
    section.scanned += 1
    if (section.candidates >= MAX_REPO_FINDINGS) {
      section.truncated = true
      break
    }
    const name = basename(file.path).toLowerCase()
    const stem = name.replace(/\.md$/, '')
    if (linkNames.has(name) || linkNames.has(stem)) continue
    section.candidates += 1
    add('unlinked-repo-markdown', 'info', file.path, `${file.path} is repository Markdown that no vault note references; it is reported only and never moved`)
  }
  return section
}

// ---------------------------------------------------------------------------
// The dated report note
// ---------------------------------------------------------------------------

/** The heading above a report's generated area. */
function reportHeading(today) {
  return `# ${LINT_REPORT_PREFIX} ${today}`
}

/** The R24 generated block, with the sha256 of exactly its body. */
function generatedBlock(body) {
  return `<!-- obsidian-mem:generated begin sha256:${sha256Hex(body)} -->\n${body}\n<!-- obsidian-mem:generated end -->`
}

/**
 * The generated area of one report: the findings, the history policy, the
 * pending queue and the fixed safety exclusions, as Markdown a human can read.
 *
 * @param {object} report - the report.
 * @returns {string} the body (no trailing newline; the block owns the separators).
 */
export function renderLintReportBody(report) {
  const lines = [
    `项目 ${report.relativeDir}`,
    '',
    `只读体检：${report.readOnly ? '是' : '否'} · 发现 ${report.total} 条`,
    '',
  ]
  if (report.total === 0) {
    lines.push('没有发现问题。', '')
  } else {
    lines.push('## 发现', '')
    for (const finding of report.findings) {
      const where = finding.path === null ? '（全局）' : finding.path
      lines.push(`- [${finding.severity}] ${finding.kind} · ${where} — ${finding.message}`)
    }
    lines.push('')
  }
  lines.push('## 索引', '', `- 后端 ${report.index.backend ?? '未知'}，就绪 ${report.index.ready ? '是' : '否'}`,
    `- vault 可索引文件 ${report.index.files}，索引行 ${report.index.rows ?? '未枚举'}`, '')
  lines.push('## .history 保留策略', '',
    `- 保留最新 ${report.history.policy.keepCount} 个事务快照，且任何年轻于 ${report.history.policy.minAgeHours} 小时的快照都不动`,
    `- 超过 ${report.history.policy.maxAgeDays} 天则视为可清理；目录 ${report.history.directories} 个，共 ${report.history.bytes} 字节`,
    `- 本次可清理（读阶段估算，加锁后逐个复核）${report.history.prunable} 个，已加锁清理 ${report.history.pruned.length} 个`,
    `- 需人工修复（永不清理）：${report.history.needsRepair.length === 0 ? '无' : report.history.needsRepair.join(', ')}`, '')
  lines.push('## 待处理队列', '', `- 任务 ${report.pending.jobs} 个，失败 ${report.pending.failed} 个，不可读 ${report.pending.invalid} 个`, '')
  lines.push('## 永久安全排除（用户 ignoreGlobs 只能追加）', '')
  for (const glob of report.safetyExclusions) lines.push(`- \`${glob}\``)
  if (report.ignoreGlobs.length > 0) {
    lines.push('', '## 用户追加排除', '')
    for (const glob of report.ignoreGlobs) lines.push(`- \`${glob}\``)
  }
  lines.push('', '仓库 Markdown 审计只报告候选，从不搬移、镜像或改写仓库文件。')
  return lines.join('\n')
}

/**
 * Create or update one dated report note, inside the vault transaction engine.
 *
 * A report that does not exist is created exclusively. An existing one is
 * rewritten only while its declared generated-block hash still matches its bytes
 * (R24); a note a human edited is reported as a conflict and left exactly as it
 * is. Nothing else in the vault is touched — the transaction carries no receipt,
 * so `_meta/log.md` is not appended to either.
 *
 * @param {object} binding - a bound project binding.
 * @param {object} report - the report to render.
 * @param {{ now: Date, dataRoot: string, home: string }} input - the clock and seams.
 * @returns {Promise<{status: string, path: string|null, message: string|null}>} what happened.
 */
async function writeLintReportNote(binding, report, { now, dataRoot, home }) {
  const relativePath = lintReportRelativePath(now)
  const body = renderLintReportBody(report)
  const absolute = await resolveVaultFile(binding.vaultRoot, relativePath, { home })
  const existing = await lstatOrNull(absolute)
  if (existing === null) {
    const contents = `${reportHeading(localDate(now))}\n\n${generatedBlock(body)}\n`
    try {
      await runTransaction(
        binding,
        { txId: newTransactionId(), creates: [{ path: relativePath, contents }], updates: [], receipt: null },
        { dataRoot, home },
      )
    } catch (error) {
      if (error instanceof TransactionError) {
        return { status: 'conflict', path: relativePath, message: `the vault refused the report write (${error.code}): ${error.message}` }
      }
      throw error
    }
    return { status: 'written', path: relativePath, message: null }
  }
  let current
  try {
    current = await fs.readFile(absolute, 'utf8')
  } catch (error) {
    return { status: 'conflict', path: relativePath, message: `cannot read the existing ${relativePath}: ${error.code ?? error.message}` }
  }
  const block = locateGeneratedBlock(current)
  if (block === null) {
    return { status: 'conflict', path: relativePath, message: `${relativePath} has no obsidian-mem:generated region; refusing to overwrite it` }
  }
  if (!block.matches) {
    return { status: 'conflict', path: relativePath, message: `${relativePath} was edited by hand (its declared sha256 no longer matches its body); refusing to overwrite the human revision` }
  }
  if (block.body === body) return { status: 'unchanged', path: relativePath, message: null }
  try {
    await runTransaction(
      binding,
      {
        txId: newTransactionId(),
        updates: [{
          path: relativePath,
          hash: '*',
          transform: (bytes) => {
            const text = bytes.toString('utf8')
            const found = locateGeneratedBlock(text)
            if (found === null || !found.matches) {
              throw new MemoryError('generated-block-conflict', `${relativePath} changed while the report was being written; refusing to overwrite it`)
            }
            if (found.body === body) return null
            return Buffer.from(`${text.slice(0, found.beginStart)}${generatedBlock(body)}${text.slice(found.endStart)}`, 'utf8')
          },
        }],
        receipt: null,
      },
      { dataRoot, home },
    )
  } catch (error) {
    if (error instanceof TransactionError || error instanceof MemoryError) {
      return { status: 'conflict', path: relativePath, message: `${error.code}: ${error.message}` }
    }
    throw error
  }
  return { status: 'written', path: relativePath, message: null }
}

// ---------------------------------------------------------------------------
// The weekly hint
// ---------------------------------------------------------------------------

/**
 * Whether the weekly lint reminder is due, and the one line it injects.
 *
 * The reminder exists because v1 has no resident timer (design §11): a session
 * that starts more than `LINT_HINT_AGE_DAYS` after the newest lint report asks
 * the operator to run one. The newest report note *is* the record — no hidden
 * state file, and therefore nothing the read-only path had to write.
 *
 * @param {object} options - input.
 * @param {string} options.vaultPath - the configured vault path (absolute or `~/…`).
 * @param {string} [options.home] - home seam.
 * @param {Date} [options.now] - clock injection point.
 * @param {number} [options.maxAgeDays] - how old the newest report may be.
 * @returns {Promise<{due: boolean, text: string, lastLintAt: string|null, reports: number}>} the hint.
 */
export async function weeklyLintHint({ vaultPath, home = homedir(), now = new Date(), maxAgeDays = LINT_HINT_AGE_DAYS } = {}) {
  const quiet = { due: false, text: '', lastLintAt: null, reports: 0 }
  if (typeof vaultPath !== 'string' || vaultPath.trim() === '') return quiet
  let directory
  try {
    const vault = await resolveVaultRoot(vaultPath, { home })
    // A vault that does not exist yet has nothing to inspect: a first session
    // must never be told to lint a vault it has not created.
    if (!vault.exists) return quiet
    directory = join(vault.root, REPORT_DIRECTORY)
  } catch {
    return quiet
  }
  let names
  try {
    names = await fs.readdir(directory)
  } catch {
    // A vault without a `_meta/` directory has never produced a report, which is
    // exactly the state the reminder exists for.
    return { ...quiet, due: true, text: hintText(null) }
  }
  const reports = names.filter((name) => name.startsWith(`${LINT_REPORT_PREFIX} `) && name.endsWith('.md'))
  let newest = 0
  let newestName = null
  for (const name of reports) {
    try {
      const stats = await fs.lstat(join(directory, name))
      if (stats.mtimeMs > newest) {
        newest = stats.mtimeMs
        newestName = name
      }
    } catch {
      /* a report that vanished between readdir and stat is not a report */
    }
  }
  if (newest === 0) return { ...quiet, due: true, text: hintText(null) }
  const lastLintAt = new Date(newest).toISOString()
  const due = now.getTime() - newest > maxAgeDays * 86_400_000
  return { due, text: due ? hintText(lastLintAt) : '', lastLintAt, reports: reports.length, newestReport: newestName }
}

/** The one-line reminder. */
function hintText(lastLintAt) {
  const when = lastLintAt === null ? '从未运行' : `上次报告 ${lastLintAt.slice(0, 10)}`
  return `记忆体检提醒（${when}，超过 7 天）：建议运行 mem_admin(action="lint", report=true) 检查孤儿、死链、重名、frontmatter、过期条目、pending 积压与仓库文档漏检。`
}
