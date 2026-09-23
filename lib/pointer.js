// The `.obsidian-mem` pointer contract (Task 4).
//
// The pointer is a repository's identity record: committed, tiny, exactly four
// fields, and deliberately free of any machine-local path or remote address
// (spec §5.2 / ruling D3). It is the only file this stage writes inside a
// repository, so every read and write here is strict — an unknown field or an
// unknown schema stops resolution instead of being repaired, and creation is
// exclusive so a concurrent writer's pointer is never overwritten.
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { basename, join } from 'node:path'

/** Repository-root pointer file (committed; four fields, no machine-local path). */
export const POINTER_FILENAME = '.obsidian-mem'
/** The only pointer schema this plugin understands. */
export const POINTER_SCHEMA = 1
/** Upper bound for the pointer file; anything larger is not a pointer. */
export const MAX_POINTER_BYTES = 4096

/** A pointer that exists but cannot be trusted. */
export class PointerError extends Error {
  /**
   * @param {string} code - machine-readable reason (`pointer-corrupt`, …).
   * @param {string} message - human-readable diagnostic naming the file.
   * @param {{ cause?: Error }} [options] - underlying failure, when there is one.
   */
  constructor(code, message, options) {
    super(message, options)
    this.name = 'PointerError'
    this.code = code
  }
}

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const SLUG_SOURCE = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?'
const SLUG_PATTERN = new RegExp(`^${SLUG_SOURCE}$`)

/**
 * Whether a value is a UUIDv4.
 *
 * @param {unknown} value - candidate.
 * @returns {boolean} true when `value` is a lowercase UUIDv4 string.
 */
export function isUuidV4(value) {
  return typeof value === 'string' && UUID_V4_PATTERN.test(value)
}

/**
 * Whether a value is a valid vault slug.
 *
 * @param {unknown} value - candidate.
 * @returns {boolean} true for 1–63 characters of `[a-z0-9-]` without a leading or trailing dash.
 */
export function isValidSlug(value) {
  return typeof value === 'string' && SLUG_PATTERN.test(value)
}

/**
 * Turn a repository directory name into a vault-safe slug.
 *
 * Only used to *name* a brand-new project; identity always comes from the
 * pointer, so a rename here never rebinds anything.
 *
 * @param {unknown} name - directory or display name.
 * @returns {string} a 1–63 character lowercase slug, `project` when nothing survives.
 */
export function slugify(name) {
  const cleaned = String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/g, '')
  return cleaned || 'project'
}

/**
 * Parse and validate pointer bytes.
 *
 * Enforces the whole contract in one place: size, JSON object shape, exactly the
 * four fields, a supported schema, a UUIDv4 identity, a safe slug and a
 * non-blank display name. Unknown schemas are reported separately from corrupt
 * files so a future format can be diagnosed instead of "repaired".
 *
 * @param {Buffer} bytes - raw pointer file contents.
 * @param {{ path?: string }} [options] - path used in diagnostics.
 * @returns {Readonly<{projectId: string, slug: string, displayName: string, schema: number}>} the pointer.
 * @throws {PointerError} when the bytes are not a valid schema-1 pointer.
 */
export function parsePointerBytes(bytes, { path = POINTER_FILENAME } = {}) {
  if (bytes.length > MAX_POINTER_BYTES) {
    throw new PointerError('pointer-oversize', `${path} is larger than ${MAX_POINTER_BYTES} bytes`)
  }
  let text = bytes.toString('utf8')
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  let value
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new PointerError('pointer-corrupt', `${path} is not valid JSON: ${error.message}`, { cause: error })
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new PointerError('pointer-corrupt', `${path} must be a JSON object`)
  }
  if (value.schema !== POINTER_SCHEMA) {
    throw new PointerError(
      'pointer-unsupported-schema',
      `${path} uses schema ${JSON.stringify(value.schema)}; only schema ${POINTER_SCHEMA} is supported`,
    )
  }
  const expected = ['displayName', 'projectId', 'schema', 'slug']
  const actual = Object.keys(value).sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new PointerError(
      'pointer-corrupt',
      `${path} must contain exactly ${expected.join(', ')} (found ${actual.length ? actual.join(', ') : 'nothing'})`,
    )
  }
  if (!isUuidV4(value.projectId)) throw new PointerError('pointer-corrupt', `${path} has no UUIDv4 projectId`)
  if (!isValidSlug(value.slug)) throw new PointerError('pointer-corrupt', `${path} has an invalid slug`)
  if (
    typeof value.displayName !== 'string'
    || value.displayName.trim().length === 0
    || value.displayName.length > 200
    || /[\u0000-\u001f\u007f]/.test(value.displayName)
  ) {
    throw new PointerError('pointer-corrupt', `${path} has an invalid displayName`)
  }
  return Object.freeze({
    projectId: value.projectId,
    slug: value.slug,
    displayName: value.displayName,
    schema: POINTER_SCHEMA,
  })
}

/**
 * Read the pointer at a repository root, if there is one.
 *
 * Absence is `null`; every other failure (a symlink, a directory, a permission
 * error, a corrupt body) throws, so a caller can never mistake "unreadable" for
 * "absent" and create a second identity over a file it failed to read.
 *
 * @param {string} repoRoot - git root of the working tree.
 * @returns {Promise<{path: string, pointer: object, bytes: Buffer}|null>} the pointer, or null.
 * @throws {PointerError} when a pointer exists but cannot be trusted.
 */
export async function readPointer(repoRoot) {
  const path = join(repoRoot, POINTER_FILENAME)
  let stat
  try {
    stat = await fs.lstat(path)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw new PointerError('pointer-unreadable', `cannot read ${path}: ${error.code ?? error.message}`, { cause: error })
  }
  if (!stat.isFile()) {
    throw new PointerError('pointer-not-a-file', `${path} is not a regular file`)
  }
  let bytes
  try {
    bytes = await fs.readFile(path)
  } catch (error) {
    throw new PointerError('pointer-unreadable', `cannot read ${path}: ${error.code ?? error.message}`, { cause: error })
  }
  return { path, pointer: parsePointerBytes(bytes, { path }), bytes }
}

/**
 * Create a pointer with exclusive semantics, or report that one already existed.
 *
 * `open(…, 'wx')` is the only write this stage performs. A half-written pointer
 * from a crash is removed again rather than left behind, because the next
 * resolution would otherwise stop on a file that no user ever wrote.
 *
 * @param {string} path - pointer path at the repository root.
 * @param {object} pointer - the four-field pointer to write.
 * @returns {Promise<boolean>} true when this call created the file.
 */
export async function createPointerExclusive(path, pointer) {
  const bytes = Buffer.from(`${JSON.stringify(pointer, null, 2)}\n`, 'utf8')
  let handle
  try {
    handle = await fs.open(path, 'wx', 0o644)
  } catch (error) {
    if (error.code === 'EEXIST') return false
    throw error
  }
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } catch (error) {
    await handle.close().catch(() => {})
    await fs.rm(path, { force: true }).catch(() => {})
    throw error
  }
  await handle.close()
  return true
}

/**
 * Derive a brand-new identity for a repository that has no pointer and no
 * sibling that could supply one.
 *
 * @param {string} repoRoot - git root used to suggest slug and display name.
 * @returns {{projectId: string, slug: string, displayName: string, schema: number}} a fresh pointer.
 */
export function newPointer(repoRoot) {
  const name = basename(repoRoot)
  const displayName = name
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200) || slugify(name)
  return { projectId: randomUUID(), slug: slugify(name), displayName, schema: POINTER_SCHEMA }
}

/**
 * Whether two pointers carry identical identity metadata.
 *
 * @param {object} left - first pointer.
 * @param {object} right - second pointer.
 * @returns {boolean} true when all four fields match.
 */
export function samePointer(left, right) {
  return left.projectId === right.projectId
    && left.slug === right.slug
    && left.displayName === right.displayName
    && left.schema === right.schema
}
