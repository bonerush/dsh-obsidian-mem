// @ts-check
// Filesystem primitives shared by every durable writer in this plugin.
//
// Two platform facts, both measured on Windows 11 (non-elevated, Developer Mode
// off) on 2026-10-28 rather than inferred from `process.platform`:
//
//   * `rename(from, to)` fails with `EPERM` when another handle still holds the
//     destination open. POSIX replaces the directory entry unconditionally; on
//     Windows the failing handle is often not this process at all (Defender
//     scanning a freshly written file, an editor, a search indexer) and it lets
//     go a few milliseconds later, so the same rename then succeeds.
//   * NTFS does not implement POSIX permission bits. `chmod(0o600)` followed by
//     `stat().mode & 0o777` answers `0o666`, and a directory is `0o666` too, so a
//     `mode & 0o077` "is this private?" check can never pass on a correct file.
//
// Seven writers had each grown a private copy of "temporary file → fsync →
// rename → directory fsync", so each had the Windows rename hole in its own
// words. This module owns the knowledge once. It is a leaf with no repository
// import, which is what lets every module above it point downward instead of
// keeping a copy that could drift.
import { promises as fs, renameSync } from 'node:fs'

/** True where permission bits are real and enforced (POSIX), false on Windows. */
export const HAS_POSIX_MODES = process.platform !== 'win32'
/** How many times a transient Windows rename failure is retried. */
export const RENAME_RETRY_ATTEMPTS = 12
/** Base backoff between those retries, in milliseconds (linear, so the last wait is 110 ms). */
export const RENAME_RETRY_DELAY_MS = 10
/**
 * Codes that mean "the destination is momentarily held" rather than "this rename
 * is impossible". Windows reports `EPERM` for an open destination and `AACES` /
 * `EBUSY` for a mapped one.
 */
const TRANSIENT_RENAME_CODES = Object.freeze(['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY'])

/**
 * Rename a file, retrying only the transient "destination is held" failure.
 *
 * On POSIX there is exactly one attempt, as before: a permission failure there is
 * a real answer, and retrying it would turn a precise, fast error into a slow one.
 *
 * On Windows the codes above are retried with a bounded linear backoff. If the
 * *whole* budget is spent on an `EPERM`, the destination is unlinked and the
 * rename retried once — see `replaceByUnlink` for why that is the only remaining
 * move and why it does not weaken the durability contract.
 *
 * @param {string} from - source path (the staged temporary file).
 * @param {string} to - destination path.
 * @param {{attempts?: number, delayMs?: number, platform?: string}} [options] - retry tuning and a platform seam for tests.
 * @returns {Promise<number>} how many attempts the rename needed (1 on POSIX, and
 *   `attempts + 1` when the unlink fallback was the one that succeeded).
 */
export async function renameWithRetry(from, to, options = {}) {
  const attempts = options.attempts ?? RENAME_RETRY_ATTEMPTS
  const delayMs = options.delayMs ?? RENAME_RETRY_DELAY_MS
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') {
    await fs.rename(from, to)
    return 1
  }
  let last
  for (let attempt = 1; ; attempt += 1) {
    try {
      await fs.rename(from, to)
      return attempt
    } catch (error) {
      last = error
      if (!TRANSIENT_RENAME_CODES.includes(error.code)) throw error
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, delayMs * attempt))
        continue
      }
      break
    }
  }
  if (last?.code === 'EPERM' && (await replaceByUnlink(from, to))) return attempts + 1
  throw last
}

/**
 * Replace a destination Windows will not let us rename over, by unlinking it first.
 *
 * Measured on this host (2026-10-28), the failure is not a short-lived lock: a
 * destination path that was ever **published with `fs.link`** answers `EPERM` to
 * `MoveFileEx` for as long as it exists, and no amount of waiting changes it —
 * 25 ms × 400 attempts (10 s) still failed. In one interleaved run inside the same
 * directory, `link`-published destinations failed 4/60 while plain `writeFile`
 * destinations failed 0/60, so the hard-link publish leaves the entry in a share
 * mode that permits no replacement rename.
 *
 * `curation-proposals.js` publishes a record exclusively with `link` (so a race has
 * one winner) and then replaces it with `replaceAtomic` on every state transition.
 * Without this fallback, marking proposals decided fails on Windows as soon as a
 * few dozen records exist — which is exactly the store the never-deleted proposal
 * queue grows into.
 *
 * Why unlinking first keeps the contract: the caller is replacing bytes it has
 * already decided are stale, and the new bytes are staged and `fsync`ed before this
 * runs. The visible window is the same one every non-atomic writer has, but it is
 * bounded by a single `rename` on the same directory — and it is only ever taken
 * after the retry budget has proven the replace cannot happen atomically. POSIX
 * never reaches it, and neither does a Windows destination that was not hard-link
 * published.
 *
 * @param {string} from - the staged, already-flushed temporary file.
 * @param {string} to - the destination that cannot be renamed over.
 * @returns {Promise<boolean>} whether the unlink-then-rename succeeded.
 */
async function replaceByUnlink(from, to) {
  try {
    await fs.rm(to, { force: true })
    await fs.rename(from, to)
    return true
  } catch {
    return false
  }
}

/**
 * Whether an `ENOENT` from a path read may really mean "a parent is a file".
 *
 * POSIX separates the two: a path whose parent is a regular file answers
 * `ENOTDIR`, and only a genuinely absent entry answers `ENOENT`. Windows
 * collapses both into `ENOENT` — measured on this host (2026-10-28): with
 * `proposals/` replaced by a regular file, both `lstat('proposals/x.json')` and
 * `readFile(...)` answer `ENOENT`.
 *
 * Callers that translate `ENOENT` into "this record does not exist" therefore
 * lose a real refusal on Windows: a proposal whose `proposals/` directory was
 * replaced by a file reads as "no such proposal" instead of "unreadable", and the
 * linter's own privacy refusal becomes a silent miss. This helper re-reads the
 * parent so the two cases can be told apart again.
 *
 * Not every `ENOENT` caller needs it: a read of the vault's own note file, where
 * the parent is a directory the caller just listed, is genuinely "missing". It
 * matters where the path came from outside the process — private state under the
 * data root, a proposal record, a registry file.
 *
 * @param {string} path - the path whose read answered `ENOENT`.
 * @returns {Promise<boolean>} true when a parent of `path` exists but is not a directory.
 */
export async function parentIsNotDirectory(path) {
  let parent = path.slice(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')))
  if (parent === '') return false
  for (;;) {
    let stat
    try {
      stat = await fs.lstat(parent)
    } catch (error) {
      if (error.code !== 'ENOENT') return true
      const next = parent.slice(0, Math.max(parent.lastIndexOf('/'), parent.lastIndexOf('\\')))
      if (next === parent || next === '') return false
      parent = next
      continue
    }
    return !stat.isDirectory()
  }
}

/**
 * `lstat` that reports absence as `null` and every other failure as a throw.
 *
 * Seven modules had grown this exact function, byte for byte. It belongs beside the
 * platform primitives for the same reason the rename backoff does: "missing" and
 * "unreadable" are different facts, and a caller that cannot tell them apart starts
 * inventing a repair for a file it never read. (`lib/paths.js` keeps its own copy
 * because it is a layer leaf the others import; see the comment there.)
 *
 * @param {string} path - path to inspect.
 * @returns {Promise<import('node:fs').Stats|null>} the stat, or `null` when missing.
 */
export async function lstatOrNull(path) {
  try {
    return await fs.lstat(path)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

/**
 * Whether a stat's permission bits prove the entry is owner-only.
 *
 * On POSIX that is exactly `mode & 0o077 === 0` — the check every caller had. On
 * Windows NTFS does not implement those bits: every file this process creates
 * reports `0o666`, so the POSIX predicate answers "not private" for a correct,
 * ACL-inherited file and the caller refuses its own data root. There is no
 * mode-based equivalent to substitute, because privacy there is carried by the
 * ACL the OS inherited and Node does not expose it; the callers keep their
 * structural checks (regular file, not a link) and this predicate answers what the
 * platform can actually prove.
 *
 * @param {object} stats - a `Stat`/`BigIntStats`-shaped record with `mode`.
 * @returns {boolean} whether the entry is private by this platform's definition.
 */
export function isPrivateMode(stats) {
  if (!HAS_POSIX_MODES) return true
  return (stats.mode & 0o077) === 0
}

/**
 * Synchronous twin of `renameWithRetry` for the callers that must stay synchronous.
 *
 * `lib/diagnostic-journal.js`'s `record()` and `lib/curation-review.js`'s claim guard
 * are synchronous public paths; making them async to reuse the promise helper would
 * change an API for a platform retry, which is the wrong trade. `Atomics.wait` gives
 * a real sleep on the main thread without a busy loop, so the backoff costs nothing
 * while the other handle closes.
 *
 * @param {string} from - source path (the staged temporary file).
 * @param {string} to - destination path.
 * @param {{attempts?: number, delayMs?: number, platform?: string}} [options] - retry tuning and a platform seam for tests.
 * @returns {number} how many attempts the rename needed (1 on POSIX).
 */
export function renameSyncWithRetry(from, to, options = {}) {
  const attempts = options.attempts ?? RENAME_RETRY_ATTEMPTS
  const delayMs = options.delayMs ?? RENAME_RETRY_DELAY_MS
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') {
    renameSync(from, to)
    return 1
  }
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      renameSync(from, to)
      return attempt
    } catch (error) {
      if (!TRANSIENT_RENAME_CODES.includes(error.code) || attempt === attempts) throw error
      sleepSync(delayMs * attempt)
    }
  }
  throw new Error(`renameSyncWithRetry exhausted ${attempts} attempts for ${from}`)
}

/**
 * Sleep synchronously for a bounded number of milliseconds.
 *
 * `Atomics.wait` on a private `SharedArrayBuffer` is the only portable way to block
 * the current thread without a busy loop; it is available in every Node release this
 * package supports and does not need a worker.
 *
 * @param {number} milliseconds - how long to block.
 * @returns {void}
 */
function sleepSync(milliseconds) {
  if (milliseconds <= 0) return
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

/**
 * `fsync` a directory so a rename inside it survives a crash.
 *
 * Some platforms refuse to open a directory or to sync the handle they did open
 * (Windows raises `EPERM` on the sync itself); both are reported as success
 * because there is nothing more this code can do, while every other failure is
 * real and propagates.
 *
 * @param {string} directory - directory to sync.
 * @returns {Promise<void>} resolves when the directory entry is durable.
 */
export async function fsyncDirectory(directory) {
  let handle
  try {
    handle = await fs.open(directory, 'r')
  } catch (error) {
    if (['EISDIR', 'EACCES', 'EPERM', 'EINVAL', 'ENOTSUP', 'ENOENT'].includes(error.code)) return
    throw error
  }
  try {
    await handle.sync()
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EBADF', 'EPERM', 'EACCES'].includes(error.code)) throw error
  } finally {
    await handle.close()
  }
}
