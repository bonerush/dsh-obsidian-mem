// The private curation state: one cursor, one record per inspected path, and the
// changed-path queue (curation plan Task 2).
//
// The vault is the source of truth and is never the plugin's scratch space, so
// everything here lives under the caller's `dataRoot` — `<dataRoot>/curation/` —
// and nothing in this module ever writes inside a vault. Three documents live
// there, one directory each:
//
//   * **`cursor/<projectId>.json`** — where a backfill is, and the fingerprint of
//     the path manifest it was walking. Exactly the five fields the plan fixes;
//     a wrong version or a wrong project is refused rather than reinterpreted.
//   * **`records/<projectId>/<sha256(path)>.json`** — one record per inspected
//     path, keyed by project and path and carrying the exact source hash it was
//     built from. This is what lets the last batch of a backfill return the
//     entries of every earlier batch, and what makes a damaged record a
//     re-inspection instead of a silently missing fact.
//   * **`changed/<projectId>.json`** — the durable, de-duplicated set of paths a
//     write asked to be inspected promptly. It is a *hint*: a hint that is lost
//     or dropped at the cap costs latency, never correctness, because the full
//     backfill re-covers every path and a view verifies its source hashes before
//     injecting anything.
//
// Everything is `0700`/`0600` (the explicit `chmod` is what makes that a property
// of this module rather than of the caller's umask), and every write is an
// exclusive temporary file renamed into place, so a reader never observes a
// half-written document. Two writers repair and one refuses: `readCurationCursor`
// and `readChangedSources` throw on a document they cannot trust — an unreadable
// cursor must not be replaced by a fresh one that would later claim coverage
// nobody proved — while `enqueueChangedSource` and the scanner treat a damaged
// document as "start over", because both can rebuild what they lost in the same
// pass and neither may fail a user's turn over a cache.
//
// Durability is deliberate and per document. The changed-path queue is fsynced
// (it is the hand-off a committed write makes, and losing it means a note waits
// for the next full pass); the cursor and the records are not, because both are
// rebuildable and fsyncing up to `maxNotes` files per pass would cost more than
// the pass itself. A crash therefore loses at most the work the next pass redoes.
//
// The vault lock is used for the two genuine cross-process read-modify-write
// sequences (the changed-path set, and the cursor write the scanner performs),
// and never held across a scan: a scan reads notes, which no lock protects.
import { promises as fs } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

import { isIndexableRelativePath, sha256Hex } from './index-db.js'
import { resolveVaultFile } from './paths.js'
import { isUuidV4 } from './pointer.js'
import { fsyncDirectory } from './receipts.js'
import { withVaultLock } from './transaction.js'

/** The single directory this module owns under the data root. */
export const CURATION_DIRECTORY = 'curation'
/** Schema version of one persisted backfill cursor. */
export const CURSOR_SCHEMA = 1
/** Schema version of one persisted per-path scan record. */
export const SCAN_RECORD_SCHEMA = 1
/** Schema version of one persisted changed-path set. */
export const CHANGED_SET_SCHEMA = 1
/** The directory mode of every directory this module creates. */
export const CURATION_DIR_MODE = 0o700
/** The mode of every file this module creates. */
export const CURATION_FILE_MODE = 0o600
/** Upper bound on one cursor document; it carries five short fields. */
export const MAX_CURSOR_BYTES = 8 * 1024
/**
 * Upper bound on one scan record. The scanner caps a record's finding list, so a
 * note with thousands of dead links produces a bounded record rather than one its
 * own reader would refuse.
 */
export const MAX_SCAN_RECORD_BYTES = 64 * 1024
/** Upper bound on the changed-path set; reached only by a burst of writes. */
export const MAX_CHANGED_SET_BYTES = 256 * 1024
/**
 * How many distinct paths the changed-path set holds before the oldest hint is
 * dropped. Dropping is safe by construction: the hint only shortens the wait, and
 * a full pass covers every path within its due window.
 */
export const MAX_CHANGED_PATHS = 512

/** Raised when a private curation document cannot be trusted. */
export class CurationStateError extends Error {
  /**
   * @param {string} code - machine-readable reason (`cursor-version`, `state-oversize`, …).
   * @param {string} message - human-readable diagnostic naming the offending path.
   * @param {{ cause?: Error }} [options] - underlying failure, when there is one.
   */
  constructor(code, message, options) {
    super(message, options)
    this.name = 'CurationStateError'
    this.code = code
  }
}

// ---------------------------------------------------------------------------
// Paths and validation
// ---------------------------------------------------------------------------

/**
 * Validate one plugin data root.
 *
 * @param {unknown} dataRoot - the candidate.
 * @returns {string} the absolute data root.
 * @throws {RangeError} when it is not an absolute, non-blank path.
 */
export function requireCurationDataRoot(dataRoot) {
  if (typeof dataRoot !== 'string' || !dataRoot.trim() || !isAbsolute(dataRoot)) {
    throw new RangeError('the curation state needs an absolute, non-blank dataRoot')
  }
  return resolve(dataRoot)
}

/**
 * Validate one project id for use as a private file name.
 *
 * @param {unknown} projectId - the candidate.
 * @returns {string} the id.
 * @throws {RangeError} when it is not a UUIDv4.
 */
function requireProjectId(projectId) {
  if (!isUuidV4(projectId)) throw new RangeError('the curation state needs a UUIDv4 project id')
  return projectId
}

/**
 * The whole curation state root under one data root (not created here).
 *
 * @param {string} dataRoot - the plugin data root.
 * @returns {string} `<dataRoot>/curation`.
 * @throws {RangeError} when the data root is not absolute.
 */
export function curationRoot(dataRoot) {
  return join(requireCurationDataRoot(dataRoot), CURATION_DIRECTORY)
}

/**
 * The cursor document of one project.
 *
 * @param {string} dataRoot - the plugin data root.
 * @param {string} projectId - the owning project's UUIDv4.
 * @returns {string} absolute path (not created here).
 */
export function curationCursorPath(dataRoot, projectId) {
  return join(curationRoot(dataRoot), 'cursor', `${requireProjectId(projectId)}.json`)
}

/**
 * The directory holding one project's per-path scan records.
 *
 * @param {string} dataRoot - the plugin data root.
 * @param {string} projectId - the owning project's UUIDv4.
 * @returns {string} absolute path (not created here).
 */
export function curationRecordDir(dataRoot, projectId) {
  return join(curationRoot(dataRoot), 'records', requireProjectId(projectId))
}

/**
 * The scan record of one vault-relative path.
 *
 * The file name is the sha256 of the path: a path may contain any character a
 * filesystem allows and still has to land as one safe segment, and hashing also
 * keeps the directory bounded by the number of notes rather than by their names.
 *
 * @param {string} dataRoot - the plugin data root.
 * @param {string} projectId - the owning project's UUIDv4.
 * @param {string} path - the vault-relative note path.
 * @returns {string} absolute path (not created here).
 * @throws {RangeError} when the path is not a non-blank string.
 */
export function curationRecordPath(dataRoot, projectId, path) {
  if (typeof path !== 'string' || path === '') {
    throw new RangeError('a scan record needs the vault-relative path it describes')
  }
  return join(curationRecordDir(dataRoot, projectId), `${sha256Hex(path)}.json`)
}

/**
 * The changed-path document of one project.
 *
 * @param {string} dataRoot - the plugin data root.
 * @param {string} projectId - the owning project's UUIDv4.
 * @returns {string} absolute path (not created here).
 */
export function curationChangedPath(dataRoot, projectId) {
  return join(curationRoot(dataRoot), 'changed', `${requireProjectId(projectId)}.json`)
}

/**
 * Validate a binding and project it onto the fields curation needs.
 *
 * @param {unknown} binding - the candidate.
 * @returns {{projectId: string, relativeDir: string, vaultRoot: string}} the validated fields.
 * @throws {RangeError} when it is not a bound project binding.
 */
export function requireCurationBinding(binding) {
  if (binding === null || typeof binding !== 'object' || Array.isArray(binding)) {
    throw new RangeError('curation requires a bound project binding')
  }
  if (binding.kind !== 'bound') {
    throw new RangeError(`curation requires a bound binding, not ${JSON.stringify(binding.kind)}`)
  }
  if (!isUuidV4(binding.projectId)) throw new RangeError('binding.projectId must be a UUIDv4')
  if (typeof binding.relativeDir !== 'string' || binding.relativeDir.trim() === '') {
    throw new RangeError('binding.relativeDir must be a non-blank vault-relative path')
  }
  if (typeof binding.vaultRoot !== 'string' || binding.vaultRoot.trim() === '') {
    throw new RangeError('binding.vaultRoot must be a non-blank path')
  }
  // `kind` is part of the projection so the result can be re-validated: a caller
  // that has already projected a binding must be able to hand the result back to
  // any function that validates one.
  return {
    kind: 'bound',
    projectId: binding.projectId,
    relativeDir: binding.relativeDir.replace(/\/+$/, ''),
    vaultRoot: binding.vaultRoot,
  }
}

/**
 * The shape half of the project-path check: this project's, and an indexable note.
 *
 * Separate from the jail because the scanner inspects notes it has already
 * resolved once: re-walking every path segment per note would double a pass's
 * path cost for an answer it already has, while the shape check still refuses a
 * note from another project's tree.
 *
 * @param {unknown} binding - a bound project binding, or one `requireCurationBinding` returned.
 * @param {unknown} path - the candidate vault-relative path.
 * @returns {string} the path, unchanged.
 * @throws {RangeError} when the path is not this project's indexable note.
 */
export function requireProjectPathShape(binding, path) {
  const project = requireCurationBinding(binding)
  const prefix = `${project.relativeDir}/`
  if (typeof path !== 'string' || !path.startsWith(prefix) || path.length === prefix.length) {
    throw new RangeError(`${JSON.stringify(path)} is not inside ${project.relativeDir}`)
  }
  if (!isIndexableRelativePath(path)) {
    throw new RangeError(`${path} is not an indexable note of this project`)
  }
  return path
}

/**
 * The vault-relative path of a note this project owns, or a refusal.
 *
 * Every path that enters private state passes through here first, because the two
 * failure modes it prevents are both silent: a path that escapes the vault jail
 * (the transaction engine refuses those too, but a scan reads without a
 * transaction) and a path belonging to another project, which is how one
 * project's curation would inspect — and later report on — another's notes.
 *
 * @param {unknown} binding - a bound project binding.
 * @param {unknown} path - the candidate vault-relative path.
 * @param {{ home?: string }} [options] - home seam for `~/` expansion.
 * @returns {Promise<string>} the path, unchanged.
 * @throws {RangeError} when the binding or the path is not this project's indexable note.
 * @throws {import('./paths.js').PathSafetyError} when the path escapes the vault or walks through a symlink.
 */
export async function requireProjectNotePath(binding, path, options = {}) {
  const project = requireCurationBinding(binding)
  // The jail runs first: it is the only check that can see a symlink, and a path
  // that escapes the vault must never be reported as merely "not this project".
  await resolveVaultFile(project.vaultRoot, path, {
    home: options.home,
  })
  return requireProjectPathShape(project, path)
}

// ---------------------------------------------------------------------------
// Private JSON files
// ---------------------------------------------------------------------------

/**
 * Create (or tighten) one private directory to `0700`.
 *
 * @param {string} directory - absolute directory.
 * @returns {Promise<string>} the directory.
 */
async function ensureCurationDir(directory) {
  await fs.mkdir(directory, { recursive: true, mode: CURATION_DIR_MODE })
  await fs.chmod(directory, CURATION_DIR_MODE)
  return directory
}

/**
 * Read and parse one private JSON document, refusing anything untrustworthy.
 *
 * The size is checked before the read, so a corrupted or hostile file cannot make
 * a pass load megabytes of text to discover it is not JSON.
 *
 * @param {string} path - absolute file path.
 * @param {number} maxBytes - the document's own size bound.
 * @returns {Promise<*>} the parsed document, or `null` when the file does not exist.
 * @throws {CurationStateError} when the file exists but cannot be trusted.
 */
async function readPrivateJson(path, maxBytes) {
  let stats
  try {
    stats = await fs.lstat(path)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw new CurationStateError(
      'state-unreadable',
      `cannot read ${path}: ${error.code ?? error.message}`,
      { cause: error },
    )
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new CurationStateError('state-not-a-file', `${path} is not a regular file`)
  }
  if (stats.size > maxBytes) {
    throw new CurationStateError(
      'state-oversize',
      `${path} holds ${stats.size} bytes, over the ${maxBytes}-byte private-state bound`,
    )
  }
  let text
  try {
    text = await fs.readFile(path, 'utf8')
  } catch (error) {
    throw new CurationStateError(
      'state-unreadable',
      `cannot read ${path}: ${error.code ?? error.message}`,
      { cause: error },
    )
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new CurationStateError('state-corrupt', `${path} is not valid JSON`, { cause: error })
  }
}

/**
 * Publish one private JSON document atomically.
 *
 * The temporary file is hidden and exclusive, and the rename is what makes the
 * document appear whole or not at all — a reader that arrives mid-write sees the
 * previous document, never a prefix of the new one. `durable` adds the file and
 * directory `fsync` that survives a crash, and is used only where a lost document
 * would be a lost hand-off rather than lost work.
 *
 * @param {string} path - absolute destination path.
 * @param {*} value - the JSON-serializable document.
 * @param {{ durable?: boolean, maxBytes?: number }} [options] - durability and size bound.
 * @returns {Promise<string>} the destination path.
 * @throws {CurationStateError} when the serialized document is over its bound.
 */
async function writePrivateJson(path, value, options = {}) {
  const { durable = false, maxBytes } = options
  const directory = dirname(path)
  const text = `${JSON.stringify(value, null, 2)}\n`
  if (maxBytes !== undefined && Buffer.byteLength(text, 'utf8') > maxBytes) {
    throw new CurationStateError(
      'state-oversize',
      `${path} would hold ${Buffer.byteLength(text, 'utf8')} bytes, over its ${maxBytes}-byte bound`,
    )
  }
  await ensureCurationDir(directory)
  const temporary = join(
    directory,
    `.${basename(path)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  )
  let handle = null
  try {
    handle = await fs.open(temporary, 'wx', CURATION_FILE_MODE)
    await handle.writeFile(text, 'utf8')
    if (durable) await handle.sync()
    await handle.close()
    handle = null
    await fs.rename(temporary, path)
  } catch (error) {
    await handle?.close().catch(() => {})
    await fs.rm(temporary, { force: true }).catch(() => {})
    throw error
  }
  if (durable) await fsyncDirectory(directory)
  return path
}

// ---------------------------------------------------------------------------
// The backfill cursor
// ---------------------------------------------------------------------------

/**
 * Validate one cursor and return the exact shape that is persisted.
 *
 * @param {unknown} raw - the candidate.
 * @param {string} projectId - the project the cursor must belong to.
 * @returns {object} the normalized cursor.
 * @throws {CurationStateError} when the version, project or a field is wrong.
 */
function normalizeCursor(raw, projectId) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CurationStateError('cursor-invalid', 'a curation cursor must be a plain object')
  }
  if (raw.version !== CURSOR_SCHEMA) {
    throw new CurationStateError(
      'cursor-version',
      `a curation cursor must be version ${CURSOR_SCHEMA}, not ${JSON.stringify(raw.version)}`,
    )
  }
  if (raw.projectId !== projectId) {
    throw new CurationStateError(
      'cursor-project',
      `the cursor at this project's path names ${JSON.stringify(raw.projectId)}, not ${projectId}`,
    )
  }
  const afterPath = raw.afterPath === undefined ? null : raw.afterPath
  if (afterPath !== null && (typeof afterPath !== 'string' || afterPath === '')) {
    throw new CurationStateError(
      'cursor-invalid',
      'a curation cursor needs a null or non-blank afterPath',
    )
  }
  if (
    typeof raw.manifestFingerprint !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(raw.manifestFingerprint)
  ) {
    throw new CurationStateError(
      'cursor-invalid',
      'a curation cursor needs the sha256 of the manifest it was walking',
    )
  }
  if (typeof raw.scannedAt !== 'string' || raw.scannedAt === '') {
    throw new CurationStateError('cursor-invalid', 'a curation cursor needs a scannedAt timestamp')
  }
  return {
    version: CURSOR_SCHEMA,
    projectId,
    afterPath,
    scannedAt: raw.scannedAt,
    manifestFingerprint: raw.manifestFingerprint,
  }
}

/**
 * Read one project's backfill cursor.
 *
 * A cursor that cannot be trusted is refused, never reinterpreted: the caller
 * that can rebuild it (the scanner) says so in its result and starts over, and a
 * caller that can only report says the state is damaged. Treating damage as
 * "no cursor" here would hide it from both.
 *
 * @param {string} dataRoot - the plugin data root.
 * @param {string} projectId - the owning project's UUIDv4.
 * @returns {Promise<object|null>} the cursor, or `null` when the project has none.
 * @throws {CurationStateError} when the stored document cannot be trusted.
 * @throws {RangeError} when the data root or the project id is invalid.
 */
export async function readCurationCursor(dataRoot, projectId) {
  const raw = await readPrivateJson(curationCursorPath(dataRoot, projectId), MAX_CURSOR_BYTES)
  if (raw === null) return null
  return normalizeCursor(raw, requireProjectId(projectId))
}

/**
 * Persist one project's backfill cursor.
 *
 * This is a plain atomic replace; the scanner performs the read-merge-write
 * around it under the vault lock, which is where two concurrent passes are kept
 * from overwriting each other's progress.
 *
 * @param {string} dataRoot - the plugin data root.
 * @param {string} projectId - the owning project's UUIDv4.
 * @param {unknown} cursor - the cursor to persist.
 * @returns {Promise<object>} the normalized cursor that was written.
 * @throws {CurationStateError} when the cursor is not a valid cursor.
 * @throws {RangeError} when the data root or the project id is invalid.
 */
export async function writeCurationCursor(dataRoot, projectId, cursor) {
  const normalized = normalizeCursor(cursor, requireProjectId(projectId))
  await writePrivateJson(curationCursorPath(dataRoot, projectId), normalized, {
    maxBytes: MAX_CURSOR_BYTES,
  })
  return normalized
}

// ---------------------------------------------------------------------------
// The per-path scan records
// ---------------------------------------------------------------------------

/**
 * Validate one scan record and return the exact shape that is persisted.
 *
 * @param {unknown} raw - the candidate.
 * @param {string} projectId - the project the record must belong to.
 * @param {string} path - the vault-relative path the record must describe.
 * @returns {object} the normalized record.
 * @throws {CurationStateError} when a field is missing or has the wrong type.
 */
function normalizeScanRecord(raw, projectId, path) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CurationStateError('record-invalid', 'a scan record must be a plain object')
  }
  if (raw.version !== SCAN_RECORD_SCHEMA) {
    throw new CurationStateError(
      'record-version',
      `a scan record must be version ${SCAN_RECORD_SCHEMA}, not ${JSON.stringify(raw.version)}`,
    )
  }
  if (raw.projectId !== projectId || raw.path !== path) {
    throw new CurationStateError(
      'record-mismatch',
      `the scan record at ${path} describes ${JSON.stringify(raw.path)} of ${JSON.stringify(raw.projectId)}`,
    )
  }
  if (raw.status !== 'ok' && raw.status !== 'unexamined') {
    throw new CurationStateError('record-invalid', 'a scan record status must be ok or unexamined')
  }
  if (raw.hash !== null && typeof raw.hash !== 'string') {
    throw new CurationStateError('record-invalid', 'a scan record hash must be a string or null')
  }
  if (!Array.isArray(raw.findings)) {
    throw new CurationStateError('record-invalid', 'a scan record carries its finding list')
  }
  if (raw.status === 'ok' && (raw.entry === null || typeof raw.entry !== 'object')) {
    throw new CurationStateError('record-invalid', 'a covered scan record carries its entry')
  }
  return {
    version: SCAN_RECORD_SCHEMA,
    projectId,
    path,
    hash: raw.hash,
    size: Number.isSafeInteger(raw.size) ? raw.size : null,
    status: raw.status,
    reason: typeof raw.reason === 'string' ? raw.reason : null,
    inspectedAt: typeof raw.inspectedAt === 'string' ? raw.inspectedAt : null,
    findings: raw.findings,
    findingsTotal: Number.isSafeInteger(raw.findingsTotal)
      ? raw.findingsTotal
      : raw.findings.length,
    entry: raw.status === 'ok' ? raw.entry : null,
  }
}

/**
 * Read the scan record of one path.
 *
 * @param {string} dataRoot - the plugin data root.
 * @param {string} projectId - the owning project's UUIDv4.
 * @param {string} path - the vault-relative note path.
 * @returns {Promise<object|null>} the record, or `null` when the path was never inspected.
 * @throws {CurationStateError} when the stored record cannot be trusted.
 * @throws {RangeError} when the data root, the project id or the path is invalid.
 */
export async function readScanRecord(dataRoot, projectId, path) {
  const raw = await readPrivateJson(
    curationRecordPath(dataRoot, projectId, path),
    MAX_SCAN_RECORD_BYTES,
  )
  if (raw === null) return null
  return normalizeScanRecord(raw, requireProjectId(projectId), path)
}

/**
 * Persist the scan record of one path.
 *
 * @param {string} dataRoot - the plugin data root.
 * @param {string} projectId - the owning project's UUIDv4.
 * @param {unknown} record - the record to persist.
 * @returns {Promise<object>} the normalized record that was written.
 * @throws {CurationStateError} when the record is invalid or over its size bound.
 * @throws {RangeError} when the data root, the project id or the path is invalid.
 */
export async function writeScanRecord(dataRoot, projectId, record) {
  const path = record === null || typeof record !== 'object' ? undefined : record.path
  const normalized = normalizeScanRecord(record, requireProjectId(projectId), path)
  await writePrivateJson(curationRecordPath(dataRoot, projectId, path), normalized, {
    maxBytes: MAX_SCAN_RECORD_BYTES,
  })
  return normalized
}

// ---------------------------------------------------------------------------
// The changed-path set
// ---------------------------------------------------------------------------

/**
 * Validate one changed-path document and return the exact shape that is persisted.
 *
 * @param {unknown} raw - the candidate.
 * @param {string} projectId - the project the document must belong to.
 * @returns {object} the normalized document.
 * @throws {CurationStateError} when the version, project or a path is wrong.
 */
function normalizeChangedSet(raw, projectId) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CurationStateError('changed-invalid', 'a changed-path set must be a plain object')
  }
  if (raw.version !== CHANGED_SET_SCHEMA) {
    throw new CurationStateError(
      'changed-version',
      `a changed-path set must be version ${CHANGED_SET_SCHEMA}, not ${JSON.stringify(raw.version)}`,
    )
  }
  if (raw.projectId !== projectId) {
    throw new CurationStateError(
      'changed-project',
      `the changed-path set at this project's path names ${JSON.stringify(raw.projectId)}, not ${projectId}`,
    )
  }
  if (!Array.isArray(raw.paths)) {
    throw new CurationStateError('changed-invalid', 'a changed-path set carries its path list')
  }
  const paths = []
  for (const path of raw.paths) {
    if (typeof path !== 'string' || path === '') {
      throw new CurationStateError(
        'changed-invalid',
        `a changed-path set holds only non-blank paths, not ${JSON.stringify(path)}`,
      )
    }
    // A path is enqueued once, however many times it is written, so a repeated
    // write while the queue is backed up cannot grow it.
    if (!paths.includes(path)) paths.push(path)
  }
  return {
    version: CHANGED_SET_SCHEMA,
    projectId,
    paths,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
  }
}

/** Merge `additions` into `paths`, keeping first-seen order and dropping the oldest over the cap. */
function mergeChangedPaths(paths, additions) {
  const merged = [...paths]
  for (const path of additions) if (!merged.includes(path)) merged.push(path)
  const dropped = Math.max(0, merged.length - MAX_CHANGED_PATHS)
  return { paths: dropped > 0 ? merged.slice(dropped) : merged, dropped }
}

/**
 * Read the paths one project still owes an inspection.
 *
 * @param {{binding: object, dataRoot: string}} input - the bound project and the plugin data root.
 * @returns {Promise<string[]>} the paths, in the order they were first enqueued.
 * @throws {CurationStateError} when the stored set cannot be trusted.
 * @throws {RangeError} when the binding or the data root is invalid.
 */
export async function readChangedSources({ binding, dataRoot }) {
  const project = requireCurationBinding(binding)
  const raw = await readPrivateJson(
    curationChangedPath(dataRoot, project.projectId),
    MAX_CHANGED_SET_BYTES,
  )
  if (raw === null) return []
  return normalizeChangedSet(raw, project.projectId).paths
}

/**
 * Durably record that one note changed and wants a prompt inspection.
 *
 * De-duplicated by path, so a note written five times while the queue is backed
 * up is one inspection. A document that cannot be read is *replaced* rather than
 * preserved: this is the writer, an unreadable hint set has no recoverable
 * content, and refusing here would make a committed write unable to ask for its
 * own inspection. The reader still refuses that document, so the damage is loud
 * wherever it can be reported instead of repaired.
 *
 * Must be called *after* a vault transaction commits, never inside one: the lock
 * this takes is the transaction engine's own and is not reentrant, so an enqueue
 * issued from inside a transaction would wait for a lock the caller already holds
 * and then refuse on the timeout.
 *
 * @param {{binding: object, dataRoot: string, path: string, home?: string}} input - the request.
 * @returns {Promise<{path: string, count: number, added: boolean, dropped: number, repaired: string|null}>} what the queue did.
 * @throws {RangeError} when the binding is not a bound project or the path is not its indexable note.
 * @throws {import('./paths.js').PathSafetyError} when the path escapes the vault or walks through a symlink.
 */
export async function enqueueChangedSource({ binding, dataRoot, path, home }) {
  const project = requireCurationBinding(binding)
  requireCurationDataRoot(dataRoot)
  const relative = await requireProjectNotePath(project, path, { home })
  const target = curationChangedPath(dataRoot, project.projectId)
  // The read-merge-write runs under the whole-vault lock (the transaction engine's
  // own `realpath(vaultRoot)`-keyed lock), so two processes writing notes at the
  // same moment cannot lose each other's hint.
  return withVaultLock(
    binding,
    async () => {
      let existing = []
      let repaired = null
      try {
        const raw = await readPrivateJson(target, MAX_CHANGED_SET_BYTES)
        if (raw !== null) existing = normalizeChangedSet(raw, project.projectId).paths
      } catch (error) {
        if (!(error instanceof CurationStateError)) throw error
        repaired = error.code
      }
      const merged = mergeChangedPaths(existing, [relative])
      const added = !existing.includes(relative)
      await writePrivateJson(
        target,
        {
          version: CHANGED_SET_SCHEMA,
          projectId: project.projectId,
          paths: merged.paths,
          updatedAt: new Date().toISOString(),
        },
        { durable: true, maxBytes: MAX_CHANGED_SET_BYTES },
      )
      return {
        path: relative,
        count: merged.paths.length,
        added,
        dropped: merged.dropped,
        repaired,
      }
    },
    { dataRoot, home },
  )
}

/**
 * Drop the paths a caller has already inspected.
 *
 * The caller acknowledges only after whatever it built from those paths is
 * durable (the scanner's caller writes a view first), so a crash before the
 * acknowledgement leaves the paths queued for replay instead of losing them.
 * Acknowledging a path that is not queued is a no-op, which makes a retry safe.
 *
 * @param {{binding: object, dataRoot: string, paths: string[], home?: string}} input - the request.
 * @returns {Promise<{acknowledged: number, remaining: number}>} how many were dropped and how many remain.
 * @throws {CurationStateError} when the stored set cannot be trusted.
 * @throws {RangeError} when the binding, the data root or the list is invalid.
 */
export async function ackChangedSources({ binding, dataRoot, paths, home }) {
  const project = requireCurationBinding(binding)
  requireCurationDataRoot(dataRoot)
  if (!Array.isArray(paths)) throw new RangeError('ackChangedSources needs an array of paths')
  const target = curationChangedPath(dataRoot, project.projectId)
  const wanted = new Set(paths)
  return withVaultLock(
    binding,
    async () => {
      const raw = await readPrivateJson(target, MAX_CHANGED_SET_BYTES)
      const existing = raw === null ? [] : normalizeChangedSet(raw, project.projectId).paths
      const remaining = existing.filter((path) => !wanted.has(path))
      if (remaining.length !== existing.length) {
        await writePrivateJson(
          target,
          {
            version: CHANGED_SET_SCHEMA,
            projectId: project.projectId,
            paths: remaining,
            updatedAt: new Date().toISOString(),
          },
          { durable: true, maxBytes: MAX_CHANGED_SET_BYTES },
        )
      }
      return { acknowledged: existing.length - remaining.length, remaining: remaining.length }
    },
    { dataRoot, home },
  )
}
