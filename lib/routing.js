// Content routing for the obsidian-mem vault (Task 8, spec §6.2/§6.4/R24/R22).
//
// Routing answers one question: for a memory of type *T* with title *X*, which
// vault-relative path does it live at? Three rules shape the answer.
//
//   * The directory is chosen by `type`, never by topic (R10/§5.1); topic
//     relations live in `[[links]]` and `tags`.
//   * A title is a *rendering*, never an identity (§6.4). Two same-titled facts
//     are two files, so the name is sanitized and disambiguated, and the stable
//     `id` in the frontmatter is what actually identifies the note. An ADR number
//     is human-readable ordering only — collisions are resolved by exclusive
//     creation in ./memory.js, never by reusing a number.
//   * Every emitted file name is bounded by the §6.4/R22 contract *including* its
//     `.md` extension (R31), so the routing layer can never hand the transaction
//     engine a name a real filesystem would refuse.
//   * A memory that cannot be classified yet goes to the **explicit inbox
//     destination** (R33): `inbox: true` parks the note under `收件箱/` while the
//     frontmatter keeps the type it actually is. The §6.4 `type` vocabulary is
//     never widened to gain a destination.
//
// This module also owns the one marker convention that makes an automatic region
// rewritable (R24, ratified in the design): `<!-- obsidian-mem:generated begin
// sha256:<body hash> -->` … `<!-- obsidian-mem:generated end -->`. A region may
// be rewritten **only** when its declared hash equals the sha256 of the bytes
// currently between the markers; a region a human edited stops the write with a
// conflict instead of being silently reverted. Bootstrap instantiates exactly
// this marker (with the sha256 of an empty body) in every `index.md` template.
//
// The error type below is shared by this module, ./memory.js and ./hot.js so a
// caller can branch on a stable machine-readable `code` across the whole memory
// layer.
import { createHash, randomUUID } from 'node:crypto'

import { FALLBACK_BASENAME, MAX_FILENAME_BYTES, safeBasename } from './naming.js'

/** The generated-region opening marker, with its declared body hash (R24). */
export const GENERATED_BEGIN_PATTERN = /<!-- obsidian-mem:generated begin sha256:([0-9a-f]{64}) -->/
/** The generated-region closing marker (R24). */
export const GENERATED_END_MARKER = '<!-- obsidian-mem:generated end -->'
/** The only extension this vault writes. */
export const NOTE_EXTENSION = '.md'
// The §6.4/R22 whole-file budget, extension included (R31); ./naming.js owns it.
export { MAX_FILENAME_BYTES }
/** The explicit inbox destination of a low-confidence candidate (R33, §6.2/§10.2). */
export const INBOX_DIRECTORY = '收件箱'
/** Every `type` value §6.4's id table defines, plus the `invariant` input alias. */
export const MEMORY_TYPES = Object.freeze([
  'doc', 'decision', 'gotcha', 'convention', 'session-log', 'hub', 'glossary', 'method',
])
/** Input aliases accepted for a `type` (§6.2). */
export const TYPE_ALIASES = Object.freeze({ invariant: 'convention' })
/** `type` → its per-project content directory (§5.1/§6.2). */
export const TYPE_DIRECTORIES = Object.freeze({
  doc: '文档',
  decision: '决策',
  gotcha: '踩坑',
  convention: '约定',
  'session-log': '日志',
  glossary: '文档',
  inbox: '收件箱',
})
/** `type` → the §6.4 id prefix, so identity never depends on the path. */
export const TYPE_PREFIXES = Object.freeze({
  doc: 'doc',
  decision: 'dec',
  gotcha: 'got',
  convention: 'con',
  'session-log': 'log',
  hub: 'hub',
  glossary: 'glo',
  method: 'met',
})
/** Cross-project methodology notes are the one route outside `项目/` (§6.2). */
export const METHOD_DIRECTORY = '方法'

/** `id` shape for every plugin-created note (§6.4): a known prefix plus a UUIDv4. */
const NOTE_ID_PATTERN = /^(?:doc|dec|got|con|log|hub|glo|met)-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** A memory-layer refusal. `code` is the machine-readable reason. */
export class MemoryError extends Error {
  /**
   * @param {string} code - machine-readable reason (`note-not-found`, `generated-block-conflict`, …).
   * @param {string} message - human-readable diagnostic naming the offending path.
   * @param {{ cause?: Error, details?: object }} [options] - underlying failure or extra facts.
   */
  constructor(code, message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'MemoryError'
    this.code = code
    if (options.details !== undefined) this.details = options.details
  }
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

/**
 * Resolve a `type` (including its input alias) to a routing kind.
 *
 * @param {string} type - requested type.
 * @returns {string} one of {@link MEMORY_TYPES}.
 * @throws {RangeError} when the type is not part of the §6.2 table.
 */
export function normalizeType(type) {
  const resolved = TYPE_ALIASES[type] ?? type
  if (!MEMORY_TYPES.includes(resolved)) {
    throw new RangeError(`type must be one of ${MEMORY_TYPES.join(', ')} (or the alias invariant): ${JSON.stringify(type)}`)
  }
  return resolved
}

/**
 * The §6.4 id prefix of a routing kind.
 *
 * @param {string} type - requested type.
 * @returns {string} the three-letter prefix.
 */
export function typePrefix(type) {
  return TYPE_PREFIXES[normalizeType(type)]
}

/**
 * Mint a fresh stable id for a new note.
 *
 * @param {string} type - requested type.
 * @returns {string} `"<prefix>-<UUIDv4>"`.
 */
export function noteIdFor(type) {
  return `${typePrefix(type)}-${randomUUID()}`
}

/**
 * Whether a value is a plugin-shaped note id.
 *
 * Ownership evidence (./memory.js) uses this: an id outside the §6.4 prefix
 * table cannot have been minted by this plugin, so the note carrying it is never
 * modified automatically.
 *
 * @param {unknown} id - candidate id.
 * @returns {boolean} true when the id is `<known prefix>-<UUIDv4>`.
 */
export function isValidNoteId(id) {
  return typeof id === 'string' && NOTE_ID_PATTERN.test(id)
}

/**
 * The directory a type routes into, as a vault-relative path.
 *
 * `inbox: true` is the **explicit inbox destination** of R33: a low-confidence
 * candidate is parked under `收件箱/` whatever its type, because the decision has
 * not been made yet. It is an option, never a `type` value — the §6.4 `type`
 * vocabulary stays closed and the note keeps the type it actually is.
 *
 * @param {object} binding - a `kind:'bound'` binding.
 * @param {string} type - requested type.
 * @param {{ inbox?: boolean }} [options] - park the note in the inbox instead.
 * @returns {string} the vault-relative directory (no trailing slash).
 * @throws {RangeError} when the binding has no usable project directory.
 */
export function directoryFor(binding, type, { inbox = false } = {}) {
  const kind = normalizeType(type)
  const relativeDir = projectDirectory(binding)
  if (inbox === true) return `${relativeDir}/${INBOX_DIRECTORY}`
  if (kind === 'method') return METHOD_DIRECTORY
  if (kind === 'hub') return relativeDir
  return `${relativeDir}/${TYPE_DIRECTORIES[kind]}`
}

/**
 * The MOC note that lists one directory's notes, or `null` when the route has no
 * generated MOC of its own (§6.2).
 *
 * @param {object} binding - a `kind:'bound'` binding.
 * @param {string} type - requested type.
 * @param {{ inbox?: boolean }} [options] - the inbox destination, which owns `收件箱/index.md` (R33).
 * @returns {string|null} the vault-relative `index.md`, or `null`.
 */
export function mocPathFor(binding, type, { inbox = false } = {}) {
  const kind = normalizeType(type)
  if (inbox === true) return `${directoryFor(binding, kind, { inbox: true })}/index.md`
  if (!['doc', 'decision', 'gotcha', 'convention', 'glossary'].includes(kind)) return null
  return `${directoryFor(binding, kind)}/index.md`
}

/**
 * Route one memory to its vault-relative note path (§6.2/R22/R31).
 *
 * `existingNames` is the target directory's `readdir` result: the natural caller
 * passes it so two notes whose titles sanitize identically still get distinct
 * names, and the caller's collision guard matches what the filesystem holds.
 *
 * `adrNumber` is the number the caller allocated for a `decision` under the vault
 * lock. It defaults to 1 only so the three-argument call in the design still
 * returns a path: ./memory.js always passes the allocated number, and the number
 * is never identity — a stale number fails the exclusive create and the
 * allocator retries with the next one.
 *
 * `inbox: true` routes to `收件箱/` (R33) and consumes no ADR number, so parking a
 * low-confidence candidate never burns a decision's ordering slot.
 *
 * @param {object} binding - a `kind:'bound'` binding.
 * @param {string} type - requested type (or its `invariant` alias).
 * @param {string} title - the note title; never an identity.
 * @param {{ today?: string, adrNumber?: number, existingNames?: string[], inbox?: boolean }} [options] - clock date for a day log, ADR number, the target directory's names, and the explicit inbox destination.
 * @returns {string} the vault-relative note path ending in `.md`.
 * @throws {RangeError} on an unknown type, a missing/invalid `today` for a day log, or a bad `adrNumber`.
 */
export function routeNote(binding, type, title, options = {}) {
  const kind = normalizeType(type)
  const { today, adrNumber = 1, existingNames = [], inbox = false } = options
  if (inbox === true) {
    return `${directoryFor(binding, kind, { inbox: true })}/${fitFilename(safeBasename(requireTitle(title), existingNames))}${NOTE_EXTENSION}`
  }
  if (kind === 'session-log') return `${directoryFor(binding, kind)}/${requireDay(today)}${NOTE_EXTENSION}`
  if (kind === 'hub') return `${directoryFor(binding, kind)}/index${NOTE_EXTENSION}`
  if (kind === 'glossary') return `${directoryFor(binding, kind)}/术语表${NOTE_EXTENSION}`
  if (kind === 'method') return `${METHOD_DIRECTORY}/${fitFilename(safeBasename(requireTitle(title), existingNames))}${NOTE_EXTENSION}`
  if (!Number.isSafeInteger(adrNumber) || adrNumber < 1) {
    throw new RangeError(`adrNumber must be a positive integer: ${JSON.stringify(adrNumber)}`)
  }
  const stem = kind === 'decision' ? `ADR-${adrNumber}-${requireTitle(title)}` : requireTitle(title)
  return `${directoryFor(binding, kind)}/${fitFilename(safeBasename(stem, existingNames))}${NOTE_EXTENSION}`
}

/**
 * Locate the generated region of a note, with its declared and actual hashes.
 *
 * The body is the exact byte run between the opening marker's line and the
 * closing marker's line, excluding the newline that separates the body from the
 * closing marker; that is what both bootstrap's empty-block hash and this
 * module's re-render hash are computed over.
 *
 * @param {string} text - the note text.
 * @returns {{beginStart: number, beginMarker: string, bodyStart: number, bodyEnd: number, body: string, endStart: number, declaredHash: string, matches: boolean}|null} the region, or `null` when absent.
 */
export function locateGeneratedBlock(text) {
  if (typeof text !== 'string') throw new RangeError('text must be a string')
  const opening = GENERATED_BEGIN_PATTERN.exec(text)
  if (opening === null) return null
  const beginStart = opening.index
  const bodyStart = afterLine(text, beginStart + opening[0].length)
  const endStart = text.indexOf(GENERATED_END_MARKER, bodyStart)
  if (endStart === -1) return null
  let bodyEnd = endStart
  if (text[bodyEnd - 1] === '\n') bodyEnd -= 1
  if (text[bodyEnd - 1] === '\r') bodyEnd -= 1
  const body = text.slice(bodyStart, Math.max(bodyStart, bodyEnd))
  return {
    beginStart,
    beginMarker: opening[0],
    bodyStart,
    bodyEnd: Math.max(bodyStart, bodyEnd),
    body,
    endStart,
    declaredHash: opening[1],
    matches: sha256Hex(body) === opening[1],
  }
}

/**
 * Append one line to a note's generated region, or return `null` when it is
 * already listed.
 *
 * This is the whole read-modify-write of a MOC (§6.4/R24) as a pure function of
 * the bytes on disk, so ./memory.js can run it inside the whole-vault lock.
 * Every refusal — a missing region, or one whose declared hash no longer matches
 * its bytes — happens before a single byte is produced.
 *
 * @param {string} text - the note text.
 * @param {string} line - the line to append (a path-qualified wikilink entry).
 * @returns {string|null} the next text, or `null` when the line is already there.
 * @throws {MemoryError} when the region is missing or was edited by a human.
 */
export function appendGeneratedLine(text, line) {
  const block = locateGeneratedBlock(text)
  if (block === null) {
    throw new MemoryError('generated-block-missing', 'the MOC has no `obsidian-mem:generated` region to write into')
  }
  if (!block.matches) {
    throw new MemoryError(
      'generated-block-conflict',
      'the generated region was edited by hand (its declared sha256 no longer matches its body); refusing to overwrite the human revision',
      { details: { declaredHash: block.declaredHash, actualHash: sha256Hex(block.body) } },
    )
  }
  const lines = block.body === '' ? [] : block.body.split('\n')
  if (lines.includes(line)) return null
  const nextBody = [...lines, line].join('\n')
  const nextMarker = `<!-- obsidian-mem:generated begin sha256:${sha256Hex(nextBody)} -->`
  return `${text.slice(0, block.beginStart)}${nextMarker}${text.slice(block.beginStart + block.beginMarker.length, block.bodyStart)}${nextBody}${text.slice(block.bodyEnd)}`
}

/**
 * Render a path-qualified wikilink line for a MOC entry (R7).
 *
 * @param {string} vaultRelativePath - the target note's vault-relative path.
 * @param {string} title - the link text.
 * @returns {string} a `- [[path|title]]` line without a trailing newline.
 */
export function wikilinkLine(vaultRelativePath, title) {
  return `- [[${String(vaultRelativePath).replace(/\.md$/, '')}|${title}]]`
}

/**
 * Re-check a basename against the whole-file budget (R31).
 *
 * `./naming.js` already reserves the extension, so this is a cheap invariant
 * guard rather than the primary bound: the routing layer is what turns a
 * basename into a vault path, so it refuses to emit one that would break the
 * contract even if a future naming change forgot to.
 *
 * @param {string} basename - a sanitized basename.
 * @returns {string} a basename whose name plus `.md` is at most {@link MAX_FILENAME_BYTES} bytes.
 */
function fitFilename(basename) {
  const budget = MAX_FILENAME_BYTES - Buffer.byteLength(NOTE_EXTENSION, 'utf8')
  if (Buffer.byteLength(basename, 'utf8') <= budget) return basename
  const kept = truncateToBytes(basename, budget).replace(/^[\s.]+/u, '').replace(/[\s.]+$/u, '')
  return kept === '' ? FALLBACK_BASENAME : kept
}

/**
 * Truncate to a UTF-8 byte budget without splitting a code point.
 *
 * @param {string} text - text to truncate.
 * @param {number} limit - maximum UTF-8 bytes.
 * @returns {string} the longest whole-code-point prefix within the budget.
 */
function truncateToBytes(text, limit) {
  if (limit <= 0) return ''
  if (Buffer.byteLength(text, 'utf8') <= limit) return text
  let bytes = 0
  let out = ''
  for (const character of text) {
    const size = Buffer.byteLength(character, 'utf8')
    if (bytes + size > limit) break
    bytes += size
    out += character
  }
  return out
}

/**
 * The character offset just past the line ending at `offset`.
 *
 * @param {string} text - the note text.
 * @param {number} offset - an offset at the end of a line.
 * @returns {number} the offset of the next line's first character.
 */
function afterLine(text, offset) {
  if (text.startsWith('\r\n', offset)) return offset + 2
  return text[offset] === '\n' ? offset + 1 : offset
}

/**
 * The vault-relative project directory of a binding.
 *
 * @param {object} binding - a `kind:'bound'` binding.
 * @returns {string} the vault-relative directory.
 * @throws {RangeError} when it is missing.
 */
function projectDirectory(binding) {
  if (binding === null || typeof binding !== 'object' || Array.isArray(binding)) {
    throw new RangeError('a bound project binding is required')
  }
  if (typeof binding.relativeDir !== 'string' || binding.relativeDir.trim() === '') {
    throw new RangeError('binding.relativeDir must be a non-blank vault-relative path')
  }
  return binding.relativeDir.replace(/\/+$/, '')
}

/**
 * Require a title before it is turned into a name.
 *
 * @param {unknown} title - candidate title.
 * @returns {string} the title.
 * @throws {RangeError} when it is not a non-blank string.
 */
function requireTitle(title) {
  if (typeof title !== 'string' || title.trim() === '') throw new RangeError('title must be a non-blank string')
  return title
}

/**
 * Require the `YYYY-MM-DD` a day log is named after.
 *
 * @param {unknown} today - candidate date.
 * @returns {string} the date.
 * @throws {RangeError} when it is missing or malformed.
 */
function requireDay(today) {
  if (typeof today !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(today)) {
    throw new RangeError(`a day log needs today as YYYY-MM-DD: ${JSON.stringify(today)}`)
  }
  return today
}
