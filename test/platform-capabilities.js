// Platform capabilities and permission assertions for this host (2026-10-28).
//
// Three Windows facts drive every helper here, each measured on this machine
// (non-elevated, Developer Mode off) rather than inferred from `process.platform`:
//
//   * `symlink(target, link)` for a FILE or a DIRECTORY fails with EPERM;
//     `symlink(target, link, 'junction')` succeeds for a directory.
//   * `chmod(0o600)` then `stat().mode & 0o777` answers 0o666 — NTFS does not
//     implement POSIX permission bits, so an assertion on them can never hold.
//   * `stat().mode` for a directory is also 0o666, so `mode & 0o077` is always
//     truthy and a POSIX "private directory" check would always fail.
//
// The probes below really create and remove a link once (memoised), because a
// platform check alone answers wrongly on this host: junction works while a file
// symlink does not. A test that only skipped on `win32` would throw away real
// coverage of the refusal logic that a junction still exercises.
//
// Nothing here relaxes an assertion. On POSIX every helper keeps the exact mode
// check; on Windows it asserts the observable property that still exists — the
// file/directory is there, private by OS inheritance, and readable by its owner —
// so a missing file, a symlink, a wrong name or an unreadable body still fails.
import assert from 'node:assert/strict'
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  closeSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  symlinkSync,
} from 'node:fs'
import { lstat, open, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'

/** `true` on a POSIX host, where permission bits are real and enforced. */
export const HAS_POSIX_MODES = process.platform !== 'win32'

/**
 * Probe one link kind by creating it for real, then removing it.
 *
 * @param {'file'|'dir'|'junction'} kind - the link kind to probe.
 * @returns {boolean} whether this process may create that link.
 */
function probeLink(kind) {
  const root = mkdtempSync(join(tmpdir(), 'obsidian-mem-cap-'))
  try {
    const target = join(root, 'target')
    mkdirSync(target, { recursive: true })
    const file = join(target, 'probe.txt')
    writeFileSync(file, 'probe')
    const link = join(root, 'link')
    try {
      if (kind === 'junction') symlinkSync(target, link, 'junction')
      else symlinkSync(kind === 'file' ? file : target, link, kind === 'file' ? 'file' : 'dir')
      return true
    } catch {
      return false
    } finally {
      rmSync(link, { recursive: true, force: true })
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

/**
 * The link capabilities of this host, measured once per process.
 *
 * `junction` is separate from `directorySymlink` on purpose: on this Windows host
 * one works and the other does not, so a single "can we link at all" flag would
 * either skip coverage it could keep or throw in thirteen files.
 */
export const LINK_CAPABILITIES = Object.freeze({
  fileSymlink: probeLink('file'),
  directorySymlink: probeLink('dir'),
  junction: probeLink('junction'),
})

/**
 * A `node:test` `skip` value for a case that needs a real file symlink.
 *
 * @returns {false|string} `false` when the link can be created, else the reason.
 */
export function skipWithoutFileSymlink() {
  if (LINK_CAPABILITIES.fileSymlink) return false
  return 'this host refuses file symlinks without elevation (Windows non-elevated: EPERM); the escape path cannot be constructed'
}

/**
 * A `node:test` `skip` value for a case that needs a real directory symlink.
 *
 * @returns {false|string} `false` when either a directory symlink or a junction
 *   can be created (a junction is a directory link this host does accept).
 */
export function skipWithoutDirectorySymlink() {
  // `||` over two booleans here would return `true` (the capability) instead of
  // `false` (the skip value), which silently skipped every directory-link case on
  // this host even though a junction works. The capability has to be tested, not
  // returned.
  if (LINK_CAPABILITIES.directorySymlink || LINK_CAPABILITIES.junction) return false
  return 'this host refuses directory symlinks and junctions without elevation'
}

/**
 * Create a directory link the way this host permits it.
 *
 * The caller must already have established that a directory link is possible
 * (`skipWithoutDirectorySymlink()` is `false`), because a fallback that silently
 * did nothing would turn a refusal test into an assertion about nothing.
 *
 * @param {string} target - absolute target directory.
 * @param {string} link - link path to create.
 * @returns {Promise<void>} resolves once the link exists.
 */
export async function createDirectoryLink(target, link) {
  if (!isAbsolute(target)) {
    throw new Error(`createDirectoryLink needs an absolute target, got ${JSON.stringify(target)}`)
  }
  if (LINK_CAPABILITIES.directorySymlink) await symlinkLink(target, link, 'dir')
  else await symlinkLink(target, link, 'junction')
}

/** The promise-based `symlink` import, kept out of the module's public surface. */
async function symlinkLink(target, link, kind) {
  const { symlink } = await import('node:fs/promises')
  await symlink(target, link, kind)
}

/**
 * Assert a file is private the way this platform expresses privacy.
 *
 * On POSIX: `mode & 0o777 === expected`, exactly as before.
 * On Windows: the path is a regular file (not a link), the owner can open it for
 * reading, and — when `contents` is given — it holds those exact bytes. The POSIX
 * bits are meaningless there, so asserting them would fail on a correct file; the
 * properties asserted instead still catch a missing file, a symlink, an
 * unreadable file and wrong contents.
 *
 * @param {string} path - absolute file path.
 * @param {number} [expected] - expected POSIX mode (ignored on Windows).
 * @param {{contents?: string|Buffer}} [options] - extra content assertion.
 * @returns {Promise<object>} the `lstat` result.
 */
export async function assertPrivateFile(path, expected = 0o600, options = {}) {
  const info = await lstat(path)
  assert.ok(info.isFile(), `${path} must be a regular file, not a link or a directory`)
  assert.equal(info.isSymbolicLink(), false, `${path} must not be a link`)
  if (HAS_POSIX_MODES) {
    assert.equal(info.mode & 0o777, expected, `${path} must be private (${expected.toString(8)})`)
    return info
  }
  // Windows: open for reading through the same API production uses. A file whose
  // ACL denies the current user is still a failing test; only the bit check is
  // replaced, because NTFS answers 0o666 for every file it creates.
  const handle = await open(path, 'r')
  try {
    if (options.contents !== undefined) {
      const bytes = await handle.readFile()
      assert.deepEqual(
        Buffer.isBuffer(options.contents) ? bytes : bytes.toString('utf8'),
        options.contents,
      )
    }
  } finally {
    await handle.close()
  }
  return info
}

/**
 * Assert a directory is private the way this platform expresses privacy.
 *
 * @param {string} path - absolute directory path.
 * @param {number} [expected] - expected POSIX mode (ignored on Windows).
 * @returns {Promise<object>} the `lstat` result.
 */
export async function assertPrivateDirectory(path, expected = 0o700) {
  const info = await lstat(path)
  assert.ok(info.isDirectory(), `${path} must be a directory`)
  assert.equal(info.isSymbolicLink(), false, `${path} must not be a link`)
  if (HAS_POSIX_MODES) {
    assert.equal(info.mode & 0o777, expected, `${path} must be private (${expected.toString(8)})`)
    return info
  }
  // Windows: the directory exists, is enumerable by its owner, and is not a link.
  await readdir(path)
  return info
}

/**
 * Sync twin of `assertPrivateFile` for the tests that are written synchronously.
 *
 * @param {string} path - absolute file path.
 * @param {number} [expected] - expected POSIX mode (ignored on Windows).
 * @returns {object} the `lstatSync` result.
 */
export function assertPrivateFileSync(path, expected = 0o600) {
  const info = lstatSync(path)
  assert.ok(info.isFile(), `${path} must be a regular file, not a link or a directory`)
  assert.equal(info.isSymbolicLink(), false, `${path} must not be a link`)
  if (HAS_POSIX_MODES) {
    assert.equal(info.mode & 0o777, expected, `${path} must be private (${expected.toString(8)})`)
    return info
  }
  const fd = openSync(path, 'r')
  try {
    readFileSync(fd)
  } finally {
    closeSync(fd)
  }
  return info
}

/**
 * Sync twin of `assertPrivateDirectory`.
 *
 * @param {string} path - absolute directory path.
 * @param {number} [expected] - expected POSIX mode (ignored on Windows).
 * @returns {object} the `lstatSync` result.
 */
export function assertPrivateDirectorySync(path, expected = 0o700) {
  const info = lstatSync(path)
  assert.ok(info.isDirectory(), `${path} must be a directory`)
  assert.equal(info.isSymbolicLink(), false, `${path} must not be a link`)
  if (HAS_POSIX_MODES) {
    assert.equal(info.mode & 0o777, expected, `${path} must be private (${expected.toString(8)})`)
    return info
  }
  readdirSync(path)
  return info
}

/**
 * Register a throwaway tree whose removal runs AFTER every later cleanup.
 *
 * `node:test` runs `t.after` hooks in registration order, and a fixture
 * registers its `rm` first. On POSIX deleting a directory that still holds an
 * open sqlite handle is fine; on Windows it fails with EBUSY, so the fixture's
 * removal has to wait for the services the test opens afterwards. This returns a
 * registrar: every `dispose` passed to it runs first (newest first), then the
 * tree is removed.
 *
 * @param {object} t - the `node:test` context.
 * @param {string} root - the throwaway root to remove.
 * @returns {(dispose: () => Promise<void>|void) => void} the disposal registrar.
 */
export function registerTreeCleanup(t, root) {
  /** @type {Array<() => Promise<void>|void>} */
  const disposers = []
  t.after(async () => {
    for (const dispose of [...disposers].reverse()) {
      try {
        await dispose()
      } catch {
        /* a fixture that never opened must not mask the removal result */
      }
    }
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  return (dispose) => disposers.push(dispose)
}
