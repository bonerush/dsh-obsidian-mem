// Note frontmatter for the obsidian-mem vault (Task 6, spec §6.4/R5/R16/R18/R21/R23).
//
// This module owns one promise: **a field update never rewrites a file**. The
// reader locates the frontmatter at byte 0, and the writer replaces only the
// byte range of an allowed field's value — or inserts one minimal line before
// the closing `---` when the key is missing. Unknown keys, comments, key order
// and the entire body come out byte-identical, which is why an unquoted
// `legacy: 0123` or a `# owner` comment can never be silently "normalized".
//
// The one thing that is easy to get catastrophically wrong: `yaml` 2.x reports
// node ranges as **JavaScript character offsets (UTF-16 code units)**, while the
// file is edited as a **Buffer of UTF-8 bytes**. Every offset is converted with
// `Buffer.byteLength(text.slice(0, charOffset), 'utf8')` before it touches the
// buffer. Skipping that conversion splices any note whose target field follows
// CJK text or an emoji at the wrong byte offset and corrupts it without an
// error — so the conversion is centralised in `byteOffsetOf` and the module
// refuses bytes that do not round-trip through UTF-8, which is what makes the
// mapping exact.
//
// Two deliberate refusals:
//
//   * The read is bounded to the first 64 KiB when looking for the closing
//     marker. Obsidian keeps large attachments in the same tree and macOS can
//     offload file contents to the cloud, so scanning a whole note (or a whole
//     vault) would trigger mass downloads. A file whose frontmatter does not
//     close inside the window stops automatic writing instead.
//   * A comment inside the byte range being replaced is refused rather than
//     dropped: there is no way to keep it inside a single scalar token, and
//     dropping it would be a silent edit to text this plugin does not own.
//
// **Residual limit (R18).** Obsidian registers property types vault-wide, and
// its GUI-side registry (`.obsidian/types.json`, plus any type the user chose for
// a property that no note currently carries a value for) is not visible here.
// `validateKnownPropertyTypes` therefore only inspects value types that are
// actually *visible in the note bytes* it reads. A property whose type was fixed
// in the GUI while every note leaves it empty cannot be detected by this
// preflight, and a first write to such a property may still conflict in
// Obsidian. Closing that gap needs either a vault-side `types.json` reader or a
// real Obsidian DOM probe; both are out of scope here and are reported as the
// residual risk of this task.
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isMap, parseDocument } from 'yaml'

import { resolveVaultRoot } from './paths.js'

/** How far into a note the closing frontmatter marker is searched for (spec §6.4). */
export const FRONTMATTER_SCAN_LIMIT = 65_536
/** How many notes one preflight will read before it stops and reports a bound. */
export const PROPERTY_PREFLIGHT_MAX_FILES = 5_000

/**
 * The closed property vocabulary of spec §6.4 — the *only* writable surface.
 *
 * Obsidian registers a property's type vault-wide by name, so inventing a name
 * (or writing the wrong type under a known name) pollutes every note. The value
 * is the visible type the vocabulary expects: `text`, `date` (bare
 * `YYYY-MM-DD`, unquoted), `tags` (a list), a `-or-null` variant, or a number.
 */
export const OWNED_FIELD_TYPES = Object.freeze({
  id: 'text',
  type: 'text',
  title: 'text',
  status: 'text',
  created: 'date',
  updated: 'date',
  tags: 'tags',
  project: 'text-or-null',
  source: 'text',
  session: 'text-or-null',
  harness: 'text',
  trust: 'text',
  confidence: 'number-or-null',
  assertion: 'text-or-null',
  supersedes: 'text-or-null',
  superseded_by: 'text-or-null',
  review_after: 'date-or-null',
})
/** Just the names, in vocabulary order (spec §6.4). */
export const OWNED_FIELDS = Object.freeze(Object.keys(OWNED_FIELD_TYPES))

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/
const DATETIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/
/** The frontmatter must open at byte 0 as its own line (spec §6.4/R16). */
const OPENING_MARKER = /^---[ \t]*(\r?\n)/
const BOM = Object.freeze([0xef, 0xbb, 0xbf])

/** A refusal the caller must report instead of repairing the user's file. */
export class FrontmatterError extends Error {
  /**
   * @param {string} code - machine-readable reason (`bom`, `duplicate-key`, `hash-mismatch`, …).
   * @param {string} message - human-readable diagnostic.
   * @param {{ cause?: Error, details?: object }} [options] - underlying failure or extra facts.
   */
  constructor(code, message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'FrontmatterError'
    this.code = code
    if (options.details !== undefined) this.details = options.details
  }
}

/**
 * Parse a note's frontmatter and body.
 *
 * @param {Buffer|Uint8Array} bytes - the note bytes. Callers that bound their read
 *   may pass a head; the frontmatter must fit inside it.
 * @returns {{hasFrontmatter: boolean, data: object|null, body: string, bodyBytes: Buffer, bodyOffset: number, frontmatter: string}} the note view.
 * @throws {FrontmatterError} on a BOM, unclosed or unparsable frontmatter, duplicate keys, or non-UTF-8 bytes.
 */
export function parseNote(bytes) {
  const parsed = parseFrontmatterBytes(bytes)
  if (!parsed.hasFrontmatter) {
    return {
      hasFrontmatter: false,
      data: null,
      body: parsed.text,
      bodyBytes: parsed.bytes.subarray(0),
      bodyOffset: 0,
      frontmatter: '',
    }
  }
  return {
    hasFrontmatter: true,
    data: plainData(parsed),
    body: parsed.text.slice(parsed.bodyStartChar),
    bodyBytes: parsed.bytes.subarray(parsed.bodyStartByte),
    bodyOffset: parsed.bodyStartByte,
    frontmatter: parsed.frontmatterText,
  }
}

/**
 * Render one owned field's value as the YAML token spec §6.4 requires.
 *
 * Identifiers and text are always quoted, `tags` is always a flow list of quoted
 * strings, dates stay bare `YYYY-MM-DD` (Obsidian's Date type), and `null` /
 * numbers stay unquoted. A leading-zero identifier such as `0123` is therefore
 * always written quoted: unquoted it is silently swallowed into the integer
 * `123` (R21).
 *
 * @param {string} key - an owned property name.
 * @param {string|number|null|string[]} value - the value to render.
 * @returns {string} the YAML token (no trailing newline).
 * @throws {RangeError} when the key is not owned, the value has the wrong type, or it does not round-trip.
 */
export function serializeOwnedValue(key, value) {
  const kind = OWNED_FIELD_TYPES[key]
  if (kind === undefined) {
    throw new RangeError(`${JSON.stringify(key)} is not one of the §6.4 owned properties`)
  }
  const token = renderToken(key, kind, value)
  // Round-trip through the same parser Obsidian uses, so a renderer bug can
  // never reach a note: the token must read back as exactly the requested value.
  const check = parseDocument(`${key}: ${token}`, { uniqueKeys: true })
  const roundTripped = check.errors.length > 0 ? undefined : plainDataOf(check)[key]
  if (check.errors.length > 0 || !sameValue(roundTripped, value)) {
    throw new RangeError(`the rendered ${key} value does not round-trip through YAML: ${token}`)
  }
  return token
}

/**
 * Replace the values of the allowed fields in a note, leaving every other byte alone.
 *
 * The optimistic-concurrency token `expectedHash` is the sha256 of the exact
 * bytes being patched: a note that changed underneath the caller is refused, not
 * merged. A field whose value already holds the requested semantics is left
 * untouched — the returned Buffer is then byte-identical to the input, and the
 * writer must skip the file write (spec §6.4/R23, "never rewrite a file to
 * refresh metadata").
 *
 * @param {Buffer|Uint8Array} bytes - the complete note bytes.
 * @param {Record<string, string|number|null|string[]>} changes - owned field names to values.
 * @param {string} expectedHash - lowercase hex sha256 of `bytes`.
 * @returns {Buffer} the patched note (a new Buffer; the input is never mutated).
 * @throws {RangeError} on an unknown field name, an unrenderable value, or a non-hex `expectedHash`.
 * @throws {FrontmatterError} when the file cannot be patched without losing bytes.
 */
export function patchOwnedFields(bytes, changes, expectedHash) {
  if (changes === null || typeof changes !== 'object' || Array.isArray(changes)) {
    throw new RangeError('changes must be a plain object of owned fields')
  }
  if (typeof expectedHash !== 'string' || !/^[0-9a-f]{64}$/.test(expectedHash)) {
    throw new RangeError('expectedHash must be the lowercase hex sha256 of the bytes being patched')
  }
  const parsed = parseFrontmatterBytes(bytes)
  if (!parsed.hasFrontmatter) {
    throw new FrontmatterError('no-frontmatter', 'the note has no frontmatter block at byte 0, so no field can be replaced in place')
  }
  const actualHash = createHash('sha256').update(parsed.bytes).digest('hex')
  if (actualHash !== expectedHash) {
    throw new FrontmatterError('hash-mismatch', 'the note changed after it was read; refusing to overwrite a newer revision', {
      details: { expectedHash, actualHash },
    })
  }

  const entries = Object.entries(changes)
  const current = plainData(parsed)
  const edits = []
  entries.forEach(([key, value], order) => {
    if (!Object.hasOwn(OWNED_FIELD_TYPES, key)) {
      throw new RangeError(`${JSON.stringify(key)} is not one of the §6.4 owned properties`)
    }
    const token = serializeOwnedValue(key, value)
    const item = mapItem(parsed.map, key)
    if (item === null) {
      // Minimal insertion: one line, immediately before the closing marker.
      edits.push({ kind: 'insert', key, token, order, charStart: parsed.contentEndChar })
      return
    }
    const node = item.value
    if (node === null || node === undefined || !Array.isArray(node.range) || node.range[0] === node.range[1]) {
      throw new FrontmatterError('unlocatable-value', `${key} has no replaceable value range (an empty value would need the file rewritten)`)
    }
    assertVisibleType(key, node, current[key])
    if (sameValue(current[key], value)) return // semantic no-op: keep the original bytes
    assertNoCommentInside(key, node)
    // yaml ranges are relative to the frontmatter text it was handed, so the
    // opening marker's length has to be added back to reach a file offset. A
    // block scalar's range also swallows the newline that terminates its last
    // line, and that newline is structural: without it the next property would
    // be glued onto this one.
    let charEnd = parsed.contentStartChar + node.range[1]
    if (parsed.text[charEnd - 1] === '\n') charEnd -= 1
    if (parsed.text[charEnd - 1] === '\r') charEnd -= 1
    edits.push({
      kind: 'replace',
      key,
      token,
      order,
      charStart: parsed.contentStartChar + node.range[0],
      charEnd,
    })
  })
  if (edits.length === 0) return Buffer.from(parsed.bytes)

  // Descending order keeps every earlier character offset valid. Inserts share
  // the closing-marker offset, so they are applied back-to-front as well, which
  // is what preserves the caller's property order on the page.
  edits.sort((a, b) => (b.charStart - a.charStart) || (b.order - a.order))
  let output = Buffer.from(parsed.bytes)
  for (const edit of edits) {
    const start = byteOffsetOf(parsed.text, edit.charStart)
    if (edit.kind === 'insert') {
      const line = Buffer.from(`${edit.key}: ${edit.token}${parsed.lineEnding}`, 'utf8')
      output = Buffer.concat([output.subarray(0, start), line, output.subarray(start)])
    } else {
      const end = byteOffsetOf(parsed.text, edit.charEnd)
      output = Buffer.concat([output.subarray(0, start), Buffer.from(edit.token, 'utf8'), output.subarray(end)])
    }
  }

  assertPatchIsFaithful(parsed, output, changes)
  return output
}

/**
 * Verify a note this plugin is about to create from scratch.
 *
 * A brand-new file may be serialized whole (spec §6.4) — but the result still has
 * to round-trip. Every property the template emitted must be a name from the
 * closed vocabulary, and every value must re-render and parse back as itself, so
 * a template regression (an unquoted leading-zero id, a `tags: foo` string, an
 * ISO timestamp) fails loudly at write time instead of producing a note Obsidian
 * reads differently from what the template meant.
 *
 * @param {string} text - the rendered note.
 * @param {{ path?: string }} [options] - path used in diagnostics.
 * @returns {object} the parsed note, so callers can inspect what they are writing.
 * @throws {FrontmatterError} when the rendered note is not a valid §6.4 note.
 */
export function assertOwnedFrontmatter(text, { path = 'note' } = {}) {
  const label = String(text)
  let note
  try {
    note = parseNote(Buffer.from(label, 'utf8'))
  } catch (error) {
    throw new FrontmatterError('template-invalid', `${path} was not rendered as a valid note: ${error.message}`, { cause: error })
  }
  if (!note.hasFrontmatter) {
    throw new FrontmatterError('no-frontmatter', `${path} was rendered without a frontmatter block`)
  }
  for (const [key, value] of Object.entries(note.data ?? {})) {
    if (!Object.hasOwn(OWNED_FIELD_TYPES, key)) {
      throw new FrontmatterError('unknown-property', `${path} writes ${JSON.stringify(key)}, which is outside the §6.4 vocabulary`)
    }
    try {
      serializeOwnedValue(key, value)
    } catch (error) {
      throw new FrontmatterError(
        'property-type-conflict',
        `${path} writes ${key} as a value the §6.4 ${OWNED_FIELD_TYPES[key]} type cannot round-trip: ${error.message}`,
        { cause: error },
      )
    }
  }
  return note
}

/**
 * Read the frontmatter of every note in a vault and report type conflicts.
 *
 * Only Obsidian's *file-level* evidence is available here (see the residual
 * limit at the top of this module): for every §6.4 property name that appears in
 * a note, the value as written must match the type the vocabulary promises. A
 * conflict means the vault already registers that property as something else, so
 * writing the plugin's own value would pollute every note that shares the name.
 *
 * The scan is deliberately cheap and honest about its own limits: at most
 * `FRONTMATTER_SCAN_LIMIT` bytes per file, no symlinks, no dot-directories, no
 * repair. A file it cannot read, cannot trust, or cannot reach within the window
 * becomes a conflict, because automatic writing must stop rather than guess.
 *
 * @param {string} vaultRoot - vault root, absolute or `~/…`.
 * @param {{ home?: string, maxFiles?: number }} [options] - home for path decisions and the file bound.
 * @returns {Promise<{conflicts: object[], scanned: number}>} conflicts plus how many notes were read.
 * @throws {RangeError} when `vaultRoot` is blank or not absolute after expansion.
 */
export async function validateKnownPropertyTypes(vaultRoot, { home = homedir(), maxFiles = PROPERTY_PREFLIGHT_MAX_FILES } = {}) {
  if (typeof vaultRoot !== 'string' || !vaultRoot.trim()) throw new RangeError('vaultRoot must be a non-blank path')
  if (!Number.isInteger(maxFiles) || maxFiles < 1) throw new RangeError('maxFiles must be a positive integer')
  const vault = await resolveVaultRoot(vaultRoot, { home })
  if (!vault.exists) return { conflicts: [], scanned: 0 }

  const inventory = await listNotePaths(vault.root, maxFiles)
  const conflicts = [...inventory.conflicts]
  let scanned = 0
  for (const relativePath of inventory.paths) {
    scanned += 1
    const absolute = join(vault.root, ...relativePath.split('/'))
    let head
    try {
      head = await readNoteHead(absolute)
    } catch (error) {
      conflicts.push({
        path: relativePath,
        reason: 'unreadable',
        message: `cannot read ${relativePath}: ${error.code ?? error.message}`,
      })
      continue
    }
    let parsed
    try {
      parsed = parseFrontmatterBytes(head.bytes)
    } catch (error) {
      if (!(error instanceof FrontmatterError)) throw error
      const beyondWindow = error.code === 'unclosed-frontmatter' && head.truncated
      conflicts.push({
        path: relativePath,
        reason: beyondWindow ? 'frontmatter-beyond-scan-limit' : 'invalid-frontmatter',
        code: error.code,
        message: beyondWindow
          ? `${relativePath} does not close its frontmatter within the first ${FRONTMATTER_SCAN_LIMIT} bytes`
          : `${relativePath}: ${error.message}`,
      })
      continue
    }
    if (!parsed.hasFrontmatter) continue
    const data = plainData(parsed)
    for (const key of OWNED_FIELDS) {
      const item = mapItem(parsed.map, key)
      if (item === null) continue
      try {
        assertVisibleType(key, item.value, data[key])
      } catch (error) {
        if (!(error instanceof FrontmatterError)) throw error
        conflicts.push({
          path: relativePath,
          reason: 'type-conflict',
          key,
          expected: OWNED_FIELD_TYPES[key],
          actual: visibleTypeName(item.value, data[key]),
          message: `${relativePath} declares ${key} as ${visibleTypeName(item.value, data[key])}, but the §6.4 vocabulary needs ${OWNED_FIELD_TYPES[key]}`,
        })
      }
    }
  }
  if (inventory.truncated) {
    conflicts.push({
      path: '',
      reason: 'scan-truncated',
      message: `the vault holds more than ${maxFiles} notes; refusing to assume the property registry is clean without reading them all`,
    })
  }
  return { conflicts, scanned }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * Parse the frontmatter block plus the offsets every writer needs.
 *
 * @param {Buffer|Uint8Array} input - note bytes.
 * @returns {object} internals: bytes, text, document, map, char/byte offsets and the line ending.
 * @throws {FrontmatterError} when the bytes cannot be trusted.
 */
function parseFrontmatterBytes(input) {
  if (!Buffer.isBuffer(input) && !(input instanceof Uint8Array)) {
    throw new RangeError('note bytes must be a Buffer or Uint8Array')
  }
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input)
  if (bytes.length >= BOM.length && BOM.every((byte, index) => bytes[index] === byte)) {
    throw new FrontmatterError('bom', 'the note starts with a BOM; frontmatter must begin at byte 0 (spec §6.4/R16)')
  }
  const text = bytes.toString('utf8')
  // An exact character↔byte mapping is the whole basis of the writer, so bytes
  // that do not survive a UTF-8 round-trip are refused instead of approximated.
  if (!Buffer.from(text, 'utf8').equals(bytes)) {
    throw new FrontmatterError('invalid-utf8', 'the note is not valid UTF-8, so character offsets cannot be mapped to bytes')
  }

  const opening = OPENING_MARKER.exec(text)
  if (opening === null) {
    return {
      bytes,
      text,
      hasFrontmatter: false,
      contentStartChar: 0,
      contentEndChar: 0,
      bodyStartChar: 0,
      contentEndByte: 0,
      bodyStartByte: 0,
      frontmatterText: '',
      document: null,
      map: null,
      lineEnding: '\n',
    }
  }

  const contentStartChar = opening[0].length
  const totalBytes = bytes.length
  const truncated = totalBytes > FRONTMATTER_SCAN_LIMIT
  const scanEndChar = charIndexForByteLimit(text, FRONTMATTER_SCAN_LIMIT)
  const closing = findClosingLine(text, contentStartChar, scanEndChar, truncated)
  if (closing === null) {
    throw new FrontmatterError(
      'unclosed-frontmatter',
      truncated
        ? `the frontmatter does not close within the first ${FRONTMATTER_SCAN_LIMIT} bytes`
        : 'the frontmatter opens at byte 0 but never closes',
    )
  }

  const frontmatterText = text.slice(contentStartChar, closing.start)
  const document = parseDocument(frontmatterText, { uniqueKeys: true, keepSourceTokens: true })
  const duplicate = document.errors.find((error) => error.code === 'DUPLICATE_KEY')
  if (duplicate !== undefined) {
    throw new FrontmatterError('duplicate-key', `the frontmatter repeats a key: ${firstLine(duplicate.message)}`)
  }
  if (document.errors.length > 0) {
    throw new FrontmatterError('invalid-yaml', `the frontmatter is not valid YAML: ${firstLine(document.errors[0].message)}`)
  }
  if (document.contents !== null && !isMap(document.contents)) {
    throw new FrontmatterError('frontmatter-not-mapping', 'the frontmatter is not a mapping of property names to values')
  }

  return {
    bytes,
    text,
    hasFrontmatter: true,
    contentStartChar,
    contentEndChar: closing.start,
    bodyStartChar: closing.end,
    contentEndByte: byteOffsetOf(text, closing.start),
    bodyStartByte: byteOffsetOf(text, closing.end),
    frontmatterText,
    document,
    map: document.contents,
    lineEnding: frontmatterText.includes('\r\n') ? '\r\n' : '\n',
  }
}

/**
 * Find the closing `---` line within the scan window.
 *
 * Only a line that is exactly `---` (trailing blanks allowed, indentation not)
 * closes the block. Indentation is what keeps a `---` inside a block scalar from
 * being mistaken for the end of the frontmatter.
 *
 * @param {string} text - the whole note text.
 * @param {number} from - character offset of the first frontmatter character.
 * @param {number} scanEnd - character offset of the last character inside the 64 KiB window.
 * @param {boolean} truncated - whether the window cut the file short.
 * @returns {{start: number, end: number}|null} character offsets of the marker line and of the body.
 */
function findClosingLine(text, from, scanEnd, truncated) {
  const window = text.slice(0, scanEnd)
  const lines = window.split('\n')
  let offset = 0
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]
    const start = offset
    offset += raw.length + 1
    if (start < from) continue
    // The final element of a truncated window is a fragment: it cannot prove a
    // line ended, so it can never be the closing marker.
    if (truncated && index === lines.length - 1) continue
    if (raw.trimEnd() !== '---') continue
    // `raw` excludes the `\n` that `split` consumed, so the body starts one byte
    // past it — and past a `\r` when the file uses CRLF.
    return { start, end: Math.min(start + raw.length + 1, text.length) }
  }
  return null
}

/**
 * Read at most the frontmatter window from a note, without touching the rest.
 *
 * @param {string} absolutePath - note path.
 * @param {number} [limit] - byte budget.
 * @returns {Promise<{bytes: Buffer, truncated: boolean}>} the head, trimmed to a code-point boundary.
 */
async function readNoteHead(absolutePath, limit = FRONTMATTER_SCAN_LIMIT) {
  const handle = await fs.open(absolutePath, 'r')
  try {
    const buffer = Buffer.allocUnsafe(limit + 1)
    const { bytesRead } = await handle.read(buffer, 0, limit + 1, 0)
    const truncated = bytesRead > limit
    return { bytes: trimToUtf8Boundary(buffer.subarray(0, Math.min(bytesRead, limit))), truncated }
  } finally {
    await handle.close()
  }
}

/**
 * Drop a trailing incomplete UTF-8 sequence from a truncated read.
 *
 * Without this, a window that cuts a CJK character in half would look like
 * invalid UTF-8 and be misreported as an unreadable note.
 *
 * @param {Buffer} bytes - the raw head.
 * @returns {Buffer} the head ending on a code-point boundary.
 */
function trimToUtf8Boundary(bytes) {
  if (bytes.length === 0) return bytes
  let back = 0
  while (back < 3 && bytes[bytes.length - back - 1] !== undefined && (bytes[bytes.length - back - 1] & 0xc0) === 0x80) {
    back += 1
  }
  if (back === 0) {
    return (bytes[bytes.length - 1] & 0xc0) === 0xc0 ? bytes.subarray(0, bytes.length - 1) : bytes
  }
  const lead = bytes[bytes.length - back - 1]
  const needed = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : 2
  return needed === back + 1 ? bytes : bytes.subarray(0, bytes.length - back - 1)
}

/**
 * List the note paths a preflight should read.
 *
 * Dot-directories (`.obsidian`, `.trash`, `_meta/.history`) and symlinks are
 * skipped: they are either not notes or not this plugin's to follow. A directory
 * that cannot be listed is a conflict, because an unreadable region of the vault
 * is exactly the region that could hide a conflict.
 *
 * @param {string} root - normalized vault root.
 * @param {number} maxFiles - cap on the number of notes.
 * @returns {Promise<{paths: string[], truncated: boolean, conflicts: object[]}>} the inventory.
 */
async function listNotePaths(root, maxFiles) {
  const paths = []
  const conflicts = []
  const queue = ['']
  let truncated = false
  while (queue.length > 0 && !truncated) {
    const relative = queue.shift()
    const absolute = relative === '' ? root : join(root, ...relative.split('/'))
    let entries
    try {
      entries = await fs.readdir(absolute, { withFileTypes: true })
    } catch (error) {
      conflicts.push({
        path: relative,
        reason: 'unreadable',
        message: `cannot list ${relative === '' ? 'the vault root' : relative}: ${error.code ?? error.message}`,
      })
      continue
    }
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue
      const child = relative === '' ? entry.name : `${relative}/${entry.name}`
      if (entry.isDirectory()) {
        queue.push(child)
        continue
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue
      if (paths.length >= maxFiles) {
        truncated = true
        break
      }
      paths.push(child)
    }
  }
  return { paths, truncated, conflicts }
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * The YAML token for one value, before the round-trip check.
 *
 * @param {string} key - owned property name (for diagnostics and the `confidence` range rule).
 * @param {string} kind - the vocabulary kind.
 * @param {string|number|null|string[]} value - value to render.
 * @returns {string} the token.
 * @throws {RangeError} when the value does not match the vocabulary kind.
 */
function renderToken(key, kind, value) {
  switch (kind) {
    case 'text':
      return JSON.stringify(requireText(key, value))
    case 'text-or-null':
      return value === null ? 'null' : JSON.stringify(requireText(key, value))
    case 'date':
      return renderDate(key, value)
    case 'date-or-null':
      return value === null ? 'null' : renderDate(key, value)
    case 'number-or-null': {
      if (value === null) return 'null'
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new RangeError(`${key} must be a finite number or null`)
      }
      if (key === 'confidence' && (value < 0 || value > 1)) throw new RangeError('confidence must be between 0 and 1')
      return String(value)
    }
    case 'tags': {
      if (!Array.isArray(value)) {
        throw new RangeError(`${key} must be a list; Obsidian does not read "tags: foo" as a list`)
      }
      for (const tag of value) {
        if (typeof tag !== 'string') throw new RangeError(`${key} must be a list of strings`)
      }
      return `[${value.map((tag) => JSON.stringify(tag)).join(', ')}]`
    }
    default:
      throw new RangeError(`${JSON.stringify(key)} has no renderer for ${kind}`)
  }
}

/**
 * Require the text type.
 *
 * @param {string} key - property name, for the diagnostic.
 * @param {unknown} value - candidate value.
 * @returns {string} the value.
 * @throws {RangeError} when it is not a string.
 */
function requireText(key, value) {
  if (typeof value !== 'string') throw new RangeError(`${key} must be a string`)
  return value
}

/**
 * Require a bare, real `YYYY-MM-DD` (or `YYYY-MM-DD HH:mm:ss`) date.
 *
 * This is where `toISOString()` is refused: the spec (R16) requires the local
 * date Obsidian's Date type reads, never a UTC timestamp, and a quoted date
 * would register as text.
 *
 * @param {string} key - property name, for the diagnostic.
 * @param {unknown} value - candidate value.
 * @returns {string} the bare date.
 * @throws {RangeError} when the value is not a valid date in the required shape.
 */
function renderDate(key, value) {
  if (typeof value !== 'string') throw new RangeError(`${key} must be a YYYY-MM-DD string`)
  const dateTime = DATETIME_PATTERN.exec(value)
  const date = dateTime === null ? DATE_PATTERN.exec(value) : null
  if (dateTime === null && date === null) {
    throw new RangeError(`${key} must be YYYY-MM-DD (or YYYY-MM-DD HH:mm:ss), never an ISO timestamp`)
  }
  const [, year, month, day] = dateTime ?? date
  const monthNumber = Number(month)
  const dayNumber = Number(day)
  if (monthNumber < 1 || monthNumber > 12 || dayNumber < 1 || dayNumber > daysInMonth(Number(year), monthNumber)) {
    throw new RangeError(`${key} is not a real calendar date: ${value}`)
  }
  if (dateTime !== null) {
    const [, , , , hours, minutes, seconds] = dateTime
    if (Number(hours) > 23 || Number(minutes) > 59 || Number(seconds) > 59) {
      throw new RangeError(`${key} is not a real time of day: ${value}`)
    }
  }
  return value
}

/**
 * Number of days in a month (proleptic Gregorian, leap years included).
 *
 * @param {number} year - full year.
 * @param {number} month - 1..12.
 * @returns {number} the day count.
 */
function daysInMonth(year, month) {
  return [31, (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
}

/**
 * Refuse a replacement whose byte range contains a comment.
 *
 * A trailing comment sits after the value's range and is preserved by the splice;
 * a comment *inside* the range (a multi-line flow collection, for example) would
 * be deleted by it and cannot be carried into a single token.
 *
 * @param {string} key - property name, for the diagnostic.
 * @param {object} node - the YAML value node.
 * @throws {FrontmatterError} when the range holds a comment.
 */
function assertNoCommentInside(key, node) {
  const [start, end] = node.range
  for (const comment of collectCommentOffsets(node.srcToken)) {
    if (comment >= start && comment < end) {
      throw new FrontmatterError('unpreservable-comment', `the value of ${key} contains a comment at character ${comment}, which cannot survive a single-token replacement`)
    }
  }
}

/**
 * Every comment token offset inside a source-token subtree.
 *
 * @param {unknown} node - a CST node or token.
 * @param {Set<object>} [seen] - cycle guard.
 * @returns {number[]} the comment offsets.
 */
function collectCommentOffsets(node, seen = new Set()) {
  if (node === null || typeof node !== 'object' || seen.has(node)) return []
  seen.add(node)
  if (Array.isArray(node)) return node.flatMap((child) => collectCommentOffsets(child, seen))
  const found = node.type === 'comment' && typeof node.offset === 'number' ? [node.offset] : []
  for (const key of ['start', 'end', 'items', 'props', 'key', 'sep', 'value']) {
    const child = node[key]
    if (child !== undefined) found.push(...collectCommentOffsets(child, seen))
  }
  return found
}

/**
 * Assert that a value already in the file matches the type the vocabulary promises.
 *
 * Only types *visible in the file* can be judged: `tags: foo` is text where a
 * list is required, `confidence: "高"` is quoted text where a number is required,
 * and a quoted `"2026-09-23"` is text where Obsidian's Date type is required.
 *
 * @param {string} key - property name.
 * @param {object|null} node - the YAML value node.
 * @param {unknown} value - the parsed value.
 * @throws {FrontmatterError} with code `property-type-conflict` on a mismatch.
 */
function assertVisibleType(key, node, value) {
  const kind = OWNED_FIELD_TYPES[key]
  if (kind === undefined) return
  const compatible = (() => {
    if (value === null) return kind === 'text-or-null' || kind === 'number-or-null' || kind === 'date-or-null'
    switch (kind) {
      case 'text':
      case 'text-or-null':
        return typeof value === 'string'
      case 'tags':
        return Array.isArray(value) && value.every((tag) => typeof tag === 'string')
      case 'number-or-null':
        return typeof value === 'number' && Number.isFinite(value)
      case 'date':
      case 'date-or-null':
        return typeof value === 'string' && isBareDate(node, value)
      default:
        return false
    }
  })()
  if (!compatible) {
    throw new FrontmatterError(
      'property-type-conflict',
      `${key} is ${visibleTypeName(node, value)} in this file, which conflicts with the §6.4 ${kind} type`,
      { details: { key, expected: kind, actual: visibleTypeName(node, value) } },
    )
  }
}

/**
 * Whether a value is a bare (unquoted) `YYYY-MM-DD` / datetime scalar.
 *
 * @param {object|null} node - the YAML value node.
 * @param {string} value - the parsed string.
 * @returns {boolean} true when Obsidian would read it as a Date/Datetime.
 */
function isBareDate(node, value) {
  if (node === null || node.type !== 'PLAIN') return false
  return DATE_PATTERN.test(value) || DATETIME_PATTERN.test(value)
}

/**
 * Obsidian's visible type name for a value, used in conflict reports.
 *
 * @param {object|null} node - the YAML value node.
 * @param {unknown} value - the parsed value.
 * @returns {string} one of `text`, `list`, `number`, `date`, `null`, `boolean`, `mapping`.
 */
function visibleTypeName(node, value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'list'
  if (typeof value === 'number') return 'number'
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'string') return isBareDate(node, value) ? 'date' : 'text'
  return 'mapping'
}

/**
 * Re-read the patched bytes and prove the patch did what it claimed.
 *
 * The body must be byte-identical and every requested field must parse back to
 * exactly the requested value; a renderer or offset bug therefore surfaces as a
 * thrown error instead of a corrupted note on disk.
 *
 * @param {object} parsed - the original parse internals.
 * @param {Buffer} output - the patched bytes.
 * @param {object} changes - the requested changes.
 * @throws {FrontmatterError} with code `self-check-failed`.
 */
function assertPatchIsFaithful(parsed, output, changes) {
  let verified
  try {
    verified = parseFrontmatterBytes(output)
  } catch (error) {
    throw new FrontmatterError('self-check-failed', `the patched note no longer parses: ${error.message}`, { cause: error })
  }
  if (!verified.hasFrontmatter) {
    throw new FrontmatterError('self-check-failed', 'the patched note lost its frontmatter')
  }
  const patched = plainData(verified)
  for (const [key, value] of Object.entries(changes)) {
    if (!sameValue(patched[key], value)) {
      throw new FrontmatterError('self-check-failed', `${key} did not round-trip to the requested value after patching`)
    }
  }
  if (!output.subarray(verified.bodyStartByte).equals(parsed.bytes.subarray(parsed.bodyStartByte))) {
    throw new FrontmatterError('self-check-failed', 'the patch changed the note body instead of only the target field')
  }
}

/**
 * The document's plain JS data, with an empty mapping normalized to `{}`.
 *
 * @param {object} parsed - parse internals.
 * @returns {object} the frontmatter as plain data.
 */
function plainData(parsed) {
  if (!parsed.hasFrontmatter) return null
  const data = parsed.document === null ? null : parsed.document.toJS()
  return data === null || data === undefined ? {} : data
}

/**
 * The plain data of a freshly parsed document.
 *
 * @param {object} document - a YAML document from `parseDocument`.
 * @returns {object|null} the plain data.
 */
function plainDataOf(document) {
  const data = document.toJS()
  return data === null || data === undefined ? {} : data
}

/**
 * Find a mapping pair by property name.
 *
 * @param {object|null} map - the YAML map node.
 * @param {string} key - property name.
 * @returns {object|null} the pair, or `null` when the key is absent.
 */
function mapItem(map, key) {
  if (map === null || map === undefined || !Array.isArray(map.items)) return null
  for (const item of map.items) {
    if (item !== null && typeof item === 'object' && item.key !== null && item.key !== undefined && item.key.value === key) {
      return item
    }
  }
  return null
}

/**
 * Whether two frontmatter values are the same value.
 *
 * Semantic idempotence depends on this: a field that already holds the requested
 * value keeps its original bytes (and therefore its original quoting), so a
 * repeat write never rewrites the file.
 *
 * @param {unknown} left - first value.
 * @param {unknown} right - second value.
 * @returns {boolean} true when they are equal.
 */
function sameValue(left, right) {
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((item, index) => sameValue(item, right[index]))
  }
  return left === right
}

// ---------------------------------------------------------------------------
// Offsets
// ---------------------------------------------------------------------------

/**
 * Convert a JavaScript character offset into a UTF-8 byte offset.
 *
 * `yaml` reports ranges in UTF-16 code units; the note is a byte buffer. Every
 * splice goes through here — this is the single most important line in the
 * module, because a note whose target field follows CJK text or an emoji would
 * otherwise be spliced at the wrong byte.
 *
 * @param {string} text - the note text that the offsets index into.
 * @param {number} charOffset - a character offset into `text`.
 * @returns {number} the equivalent byte offset.
 */
function byteOffsetOf(text, charOffset) {
  return Buffer.byteLength(text.slice(0, charOffset), 'utf8')
}

/**
 * The character offset that corresponds to a byte limit.
 *
 * @param {string} text - the note text.
 * @param {number} byteLimit - maximum byte offset.
 * @returns {number} the largest character offset whose bytes stay within the limit.
 */
function charIndexForByteLimit(text, byteLimit) {
  if (Buffer.byteLength(text, 'utf8') <= byteLimit) return text.length
  let bytes = 0
  for (let index = 0; index < text.length; index += 1) {
    const code = text.codePointAt(index)
    const size = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
    if (bytes + size > byteLimit) return index
    bytes += size
    if (code > 0xffff) index += 1
  }
  return text.length
}

/**
 * The first line of a YAML error message, for a one-line diagnostic.
 *
 * @param {string} message - the raw error message.
 * @returns {string} the first line.
 */
function firstLine(message) {
  return String(message).split('\n')[0]
}
