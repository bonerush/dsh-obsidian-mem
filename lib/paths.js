// @ts-check
// Safe paths for the obsidian-mem vault (Task 4).
//
// `resolveVaultFile` is this plugin's security boundary: later tasks hand it
// model-authored relative paths, so nothing here normalizes a suspicious path
// into an acceptable one. Every segment is checked with `lstat` and a symlink at
// any depth is refused — including one that happens to point back inside the
// vault — because following it would let a write land outside the jail. The
// vault root itself is normalized once with `realpath`, which keeps the jail
// base stable when `vaultPath` is reached through a symlinked home directory.
//
// `resolveDataRoot` is the other half of "never touch a real home": the plugin's
// own cache, locks and queues live under `DSH_HOME`, so an isolated test profile
// (`DSH_HOME=<tmp>`) can never write back into the user's `~/.dsh`.
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'

/** Raised when a path would leave the vault or walk through a symlink. */
export class PathSafetyError extends Error {
  /**
   * @param {string} message - must name the offending path so callers can report it.
   */
  constructor(message) {
    super(message)
    this.name = 'PathSafetyError'
    this.code = 'unsafe-path'
  }
}

/**
 * True when `candidate` is `parent` itself or lives below it.
 *
 * Separator-aware on purpose: `/vault-extra` is not inside `/vault`. Both
 * arguments are expected to be absolute, already-normalized paths.
 *
 * @param {string} candidate - absolute path to test.
 * @param {string} parent - absolute directory that acts as the jail root.
 * @returns {boolean} whether `candidate` is `parent` or a descendant of it.
 */
export function isInside(candidate, parent) {
  if (typeof candidate !== 'string' || typeof parent !== 'string') return false
  if (!isAbsolute(candidate) || !isAbsolute(parent)) return false
  const root = parent.endsWith(sep) ? parent.slice(0, -sep.length) : parent
  return candidate === root || candidate.startsWith(root + sep)
}

/**
 * The plugin's private data root: `<DSH_HOME>/data/obsidian-mem`.
 *
 * `DSH_HOME` is honoured because DSH may run with an isolated profile; without
 * it the default is `~/.dsh`. A blank or relative value is refused rather than
 * resolved against the process cwd, which would silently write into a checkout.
 *
 * @param {string} [dshHome] - absolute DSH home; defaults to `$DSH_HOME` or `~/.dsh`.
 * @returns {string} absolute path to the plugin data root (not created here).
 * @throws {RangeError} when `dshHome` is not an absolute, non-blank path.
 */
export function resolveDataRoot(dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')) {
  if (typeof dshHome !== 'string' || !dshHome.trim() || !isAbsolute(dshHome)) {
    throw new RangeError('dshHome must be an absolute, non-blank path')
  }
  return resolve(dshHome, 'data', 'obsidian-mem')
}

/**
 * Expand a leading `~/` (or a bare `~`) against `home`.
 *
 * The config default is the literal string `~/Documents/dsh-memory`, so this is
 * the one place that turns it into an absolute path. Anything else is returned
 * unchanged; whether it is absolute is checked by the caller.
 *
 * @param {string} candidate - possibly home-relative path.
 * @param {string} [home] - home directory to expand against.
 * @returns {*} the expanded path, or `candidate` unchanged when not a string.
 */
export function expandHomePath(candidate, home = homedir()) {
  if (typeof candidate !== 'string') return candidate
  if (candidate === '~') return home
  if (candidate.startsWith(`~${sep}`)) return join(home, candidate.slice(2))
  return candidate
}

/**
 * Normalize a vault root, tolerating a vault that does not exist yet.
 *
 * The deepest existing ancestor is `realpath`-ed, then the verified-absent
 * segments are appended. That yields a stable jail base on the very first run
 * (the vault is created later by bootstrap) while still resolving a symlinked
 * ancestor to its real location.
 *
 * @param {string} vaultRoot - configured vault path, absolute or `~/…`.
 * @param {{ home?: string }} [options] - home directory used for `~/` expansion.
 * @returns {Promise<{ root: string, exists: boolean }>} normalized root and whether it exists.
 * @throws {RangeError} when `vaultRoot` is blank or not absolute after expansion.
 */
export async function resolveVaultRoot(vaultRoot, { home = homedir() } = {}) {
  if (typeof vaultRoot !== 'string' || !vaultRoot.trim()) {
    throw new RangeError('vaultRoot must be a non-blank path')
  }
  const expanded = expandHomePath(vaultRoot, home)
  if (typeof expanded !== 'string' || !isAbsolute(expanded)) {
    throw new RangeError('vaultRoot must be absolute or start with ~/')
  }
  const absent = []
  let current = resolve(expanded)
  for (;;) {
    const stat = await lstatOrNull(current)
    if (stat !== null) break
    const parent = dirname(current)
    if (parent === current) break
    absent.unshift(basename(current))
    current = parent
  }
  const base = await fs.realpath(current)
  return { root: absent.length === 0 ? base : join(base, ...absent), exists: absent.length === 0 }
}

/**
 * Split a vault-relative path into checked segments.
 *
 * `/`, `.` and `..` handling is intentionally strict: `.` segments are dropped,
 * `..` and absolute paths are rejected outright instead of being collapsed.
 *
 * @param {string} relativePath - caller-supplied path, relative to the vault root.
 * @returns {string[]} the non-empty path segments.
 * @throws {PathSafetyError} when the path is blank, absolute, or contains `..`.
 */
export function splitRelativeVaultPath(relativePath) {
  if (typeof relativePath !== 'string' || !relativePath.trim()) {
    throw new PathSafetyError('relative path must be a non-blank string')
  }
  if (relativePath.includes('\0')) {
    throw new PathSafetyError('relative path must not contain NUL bytes')
  }
  if (isAbsolute(relativePath)) {
    throw new PathSafetyError(`absolute path is not allowed: ${relativePath}`)
  }
  const segments = []
  for (const segment of relativePath.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..')
      throw new PathSafetyError(`path traversal is not allowed: ${relativePath}`)
    segments.push(segment)
  }
  if (segments.length === 0) {
    throw new PathSafetyError(`relative path must name an entry inside the vault: ${relativePath}`)
  }
  return segments
}

/**
 * Resolve a vault-relative path inside the jail.
 *
 * Each existing segment is `lstat`-ed: a symlink anywhere in the path is a
 * `PathSafetyError`, never a followed link. A segment that does not exist ends
 * the walk (nothing below a missing directory can exist), so `mustExist:false`
 * can return a path the caller is about to create. Any other stat failure
 * (EACCES, EDEADLK, EIO, …) is rethrown untouched: a read failure must never be
 * mistaken for "the file is not there", because on cloud-backed storage that is
 * exactly how an offloaded file looks.
 *
 * @param {string} vaultRoot - vault root, absolute or `~/…`.
 * @param {string} relativePath - path relative to the vault root.
 * @param {{ mustExist?: boolean, home?: string }} [options] - existence and home overrides.
 * @returns {Promise<string>} absolute path inside the vault.
 * @throws {PathSafetyError} when the path is unsafe or walks through a symlink.
 */
export async function resolveVaultFile(
  vaultRoot,
  relativePath,
  { mustExist = false, home = homedir() } = {},
) {
  const segments = splitRelativeVaultPath(relativePath)
  const { root } = await resolveVaultRoot(vaultRoot, { home })
  for (let index = 0; index < segments.length; index += 1) {
    const current = join(root, ...segments.slice(0, index + 1))
    let stat
    try {
      stat = await fs.lstat(current)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      // Nothing below a missing directory can exist, so the walk is over. The
      // full path is still returned for a caller that is about to create it.
      if (mustExist) {
        throw new Error(`vault path does not exist: ${relativePath}`, { cause: error })
      }
      break
    }
    if (stat.isSymbolicLink()) {
      throw new PathSafetyError(`symlink is not allowed in a vault path: ${relativePath}`)
    }
  }
  const resolved = join(root, ...segments)
  assertInsideVault(resolved, root, relativePath)
  return resolved
}

/**
 * Whether a normalized vault root sits under a known macOS cloud sync root.
 *
 * Only the two roots whose semantics are documented are claimed: iCloud's
 * `~/Library/Mobile Documents/` (on-demand files can be transparently
 * downloaded, or fail with `EDEADLK` in a background process) and
 * `~/Library/CloudStorage/` (Dropbox/OneDrive/Google Drive mounts). Whether
 * `~/Documents` is managed by a provider varies per machine, so it is
 * deliberately NOT inferred from its name; unknown providers are handled by
 * pausing on file-level read failures instead of pretending to enumerate them.
 *
 * @param {string} realVaultRoot - vault root, normally already `realpath`-ed.
 * @param {{ home?: string }} [options] - home directory that owns the sync roots.
 * @returns {Promise<boolean>} true when the vault root is under a known sync root.
 */
export async function isCloudManagedVaultRoot(realVaultRoot, { home = homedir() } = {}) {
  if (typeof realVaultRoot !== 'string' || !isAbsolute(realVaultRoot)) return false
  if (typeof home !== 'string' || !home.trim()) return false
  let candidate = realVaultRoot
  const stat = await lstatOrNull(candidate)
  if (stat !== null) candidate = await fs.realpath(candidate)
  let homeRoot
  try {
    homeRoot = (await resolveVaultRoot(home, { home })).root
  } catch {
    return false
  }
  return [
    ['Library', 'Mobile Documents'],
    ['Library', 'CloudStorage'],
  ].some((parts) => isInside(candidate, join(homeRoot, ...parts)))
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

/**
 * Assert the containment invariant that the segment checks already imply.
 *
 * @param {string} candidate - resolved candidate path.
 * @param {string} root - normalized vault root.
 * @param {string} relativePath - original relative path, for the message.
 * @throws {PathSafetyError} when `candidate` is not inside `root`.
 */
function assertInsideVault(candidate, root, relativePath) {
  if (!isInside(candidate, root)) {
    throw new PathSafetyError(`path escapes the vault root: ${relativePath}`)
  }
}
