// The brief state a process restart would otherwise lose.
//
// A full brief is composed once per session and then kept in memory. A host
// process restart creates a new in-memory state, so the next pre-step composes
// the full brief again: task-1's replay measured 83 redundant fulls in 254
// injections (224,090 characters, 52.0% of all injected characters), and 103% of
// the model's own generated output. This module persists exactly the observations
// needed to skip that re-send — and nothing else.
//
// Two rules keep it conservative:
//
//   * **The probe is the host fact, not a hope.** Whether a restarted session's
//     pre-step `messages` still contain the previous brief is unmeasured on the
//     DSH host (`docs/p0-compatibility.md` records `{turn, signal}` only). So a
//     persisted state is adopted only when `claimed` actually carries a message
//     whose text hash matches the persisted brief; otherwise the caller composes
//     the full brief as it does today. No replay means no saving and no risk.
//   * **Only delivery observations are persisted.** The previous prompt,
//     `seenPaths`/`injectedPaths`, the recall ledger, continuation and epoch are
//     session-scoped and are deliberately absent: a stale dedupe set after a
//     restart would suppress a legitimate recall, which is worse than one extra
//     brief.
//
// The store lives under `<dataRoot>/session-state/<sha256(sessionKey)>.json`,
// never in the vault; files are private, bounded, atomic, TTL'd and garbage
// collected lazily. Every failure is fail-open: a missing, corrupt, oversized,
// symlinked or foreign record is the same as no record.
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { privateIdentity, readPrivateJson, withPrivateLock } from './delivery-state.js'
import { sha256Hex } from './routing.js'
import { writePrivateJson } from './delivery-state.js'

/** Schema of the persisted session-state document. */
export const SESSION_STATE_SCHEMA = 1
/** The hard ceiling on one state file, in bytes. The brief fields are tiny. */
export const SESSION_STATE_MAX_BYTES = 64 * 1024
/** How long an unused record is kept before the lazy GC removes it. */
export const SESSION_STATE_TTL_MS = 30 * 24 * 60 * 60 * 1000
/** How many records the lazy GC will keep; the oldest are removed first. */
export const SESSION_STATE_MAX_FILES = 1000
/** How many hot-version hashes one record may carry. */
export const SESSION_STATE_MAX_HASHES = 64
/** How many hot items one record may carry. */
const MAX_HOT_ITEMS = 200

/** The marker every injected brief starts with inside its own text. Kept equal
 * to `lib/delivery-state.js`'s private constant; the probe is the only reader. */
const BRIEF_MARKER = '<!-- obsidian-mem:brief '

/**
 * One session-state file's absolute path. The directory is derived from the data
 * root alone; a vault or project identity lives inside the document, checked on
 * read, so moving a session between vaults cannot adopt the wrong state.
 *
 * @param {{dataRoot: string, sessionKey: string}} input - root and host session id.
 * @returns {string} the absolute path.
 */
export function sessionStatePath({ dataRoot, sessionKey }) {
  if (typeof dataRoot !== 'string' || dataRoot === '')
    throw new RangeError('session state needs a data root')
  if (typeof sessionKey !== 'string' || sessionKey === '')
    throw new RangeError('session state needs a non-blank session key')
  return join(dataRoot, 'session-state', sha256Hex(sessionKey) + '.json')
}

/**
 * A blank brief observation set.
 *
 * @returns {object} the blank state.
 */
export function emptyBriefState() {
  return {
    sentFull: false,
    lastHotHash: null,
    lastHotItems: [],
    sentHotHashes: [],
    heldTruncatedHashes: [],
    lastFullHash: null,
    lastBriefHash: null,
  }
}

/**
 * The hashes of every brief-shaped message in a pre-step's claimed history.
 *
 * This is the adoption probe: the caller compares these against the persisted
 * last-brief hash. Only a user-role text message that starts with the plugin's
 * marker counts, so a tool output that quotes the brief cannot acknowledge it.
 *
 * @param {unknown} messages - the pre-step's `messages` array.
 * @returns {Set<string>} the hashes of structured injections.
 */
export function briefMarkerHashes(messages) {
  const hashes = new Set()
  if (!Array.isArray(messages)) return hashes
  for (const message of messages) {
    if (message === null || typeof message !== 'object') continue
    if (message.role !== 'user' || !Array.isArray(message.content)) continue
    for (const part of message.content) {
      if (part === null || typeof part !== 'object') continue
      if (part.type !== 'text' || typeof part.text !== 'string') continue
      if (!part.text.startsWith(BRIEF_MARKER)) continue
      hashes.add(sha256Hex(part.text))
      break
    }
  }
  return hashes
}

/**
 * Normalize a persisted brief record, or `null` when it is not trustworthy.
 * Every bound is checked here so a corrupt file can never grow a session state.
 *
 * @param {unknown} value - the parsed `brief` field.
 * @returns {object|null} the normalized record.
 */
function normalizeBriefState(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  if (typeof value.sentFull !== 'boolean') return null
  const hashes = (list) => {
    if (!Array.isArray(list)) return []
    return list
      .filter((entry) => typeof entry === 'string' && entry !== '')
      .slice(0, SESSION_STATE_MAX_HASHES)
  }
  const lastHotHash = typeof value.lastHotHash === 'string' ? value.lastHotHash : null
  const lastFullHash = typeof value.lastFullHash === 'string' ? value.lastFullHash : null
  const lastBriefHash = typeof value.lastBriefHash === 'string' ? value.lastBriefHash : null
  const items = Array.isArray(value.lastHotItems)
    ? value.lastHotItems
        .slice(0, MAX_HOT_ITEMS)
        .filter(
          (item) =>
            item !== null &&
            typeof item === 'object' &&
            typeof item.id === 'string' &&
            typeof item.section === 'string' &&
            typeof item.text === 'string',
        )
    : []
  return {
    sentFull: value.sentFull,
    lastHotHash,
    lastHotItems: items,
    sentHotHashes: hashes(value.sentHotHashes),
    heldTruncatedHashes: hashes(value.heldTruncatedHashes),
    lastFullHash,
    lastBriefHash,
  }
}

/**
 * Read one session's persisted state.
 *
 * Returns `null` for every conservative outcome: missing, corrupt, oversized,
 * symlinked, written by another vault/project, written under another schema, or
 * older than the TTL. A caller cannot tell them apart on purpose — all of them
 * mean "compose the full brief".
 *
 * @param {object} input - the read identity.
 * @param {string} input.dataRoot - plugin data root.
 * @param {string} input.sessionKey - host session id.
 * @param {object} [input.binding] - a bound project binding (identity to match).
 * @param {string} [input.home] - home seam.
 * @param {number} [input.now] - clock seam for the TTL.
 * @returns {Promise<{state: object, path: string}|null>} the record, or `null`.
 */
export async function readSessionState({
  dataRoot,
  sessionKey,
  binding = null,
  home,
  now = Date.now(),
}) {
  let path
  try {
    path = sessionStatePath({ dataRoot, sessionKey })
  } catch {
    return null
  }
  const read = await readPrivateJson({
    path,
    root: join(dataRoot, 'session-state'),
    maxBytes: SESSION_STATE_MAX_BYTES,
  })
  if (read.value === null) return null
  const value = read.value
  if (value.schema !== SESSION_STATE_SCHEMA) return null
  if (typeof value.savedAt !== 'number' || now - value.savedAt > SESSION_STATE_TTL_MS) return null
  if (binding !== null) {
    let identity
    try {
      identity = await privateIdentity(binding, { home })
    } catch {
      return null
    }
    const recorded = value.identity
    if (
      recorded === null ||
      typeof recorded !== 'object' ||
      recorded.vaultHash !== identity.vaultHash ||
      recorded.projectId !== identity.projectId
    ) {
      return null
    }
  }
  const brief = normalizeBriefState(value.brief)
  if (brief === null) return null
  return {
    state: { schema: value.schema, savedAt: value.savedAt, identity: value.identity, brief },
    path,
  }
}

/**
 * Persist one brief observation set, atomically and under the shared private
 * lock. Fail-open: a write that cannot land returns `false` and never throws —
 * the cost of losing it is one extra brief after a restart, never a failed turn.
 *
 * @param {object} input - the write identity and payload.
 * @param {string} input.dataRoot - plugin data root.
 * @param {string} input.sessionKey - host session id.
 * @param {object} input.binding - a bound project binding.
 * @param {object} input.brief - the brief observation record.
 * @param {string} [input.home] - home seam.
 * @param {number} [input.now] - clock seam.
 * @returns {Promise<boolean>} true when the record was written.
 */
export async function saveSessionState({
  dataRoot,
  sessionKey,
  binding,
  brief,
  home,
  now = Date.now(),
}) {
  let path
  try {
    path = sessionStatePath({ dataRoot, sessionKey })
  } catch {
    return false
  }
  let identity
  try {
    identity = await privateIdentity(binding, { home })
  } catch {
    return false
  }
  const normalized = normalizeBriefState(brief)
  if (normalized === null) return false
  const value = { schema: SESSION_STATE_SCHEMA, savedAt: now, identity, brief: normalized }
  const root = join(dataRoot, 'session-state')
  try {
    // The private-directory helper walks from `root` downwards; the root itself
    // is the caller's to create.
    await fs.mkdir(root, { recursive: true, mode: 0o700 })
    await withPrivateLock({ path, root }, async () => {
      await writePrivateJson({ path, root, value })
    })
  } catch {
    return false
  }
  // Lazy GC rides the write path: the directory only ever holds one small file
  // per session, and a session that never injects never pays for a scan.
  try {
    await pruneSessionStates(root, now)
  } catch {
    // GC is best-effort; the record above already landed.
  }
  return true
}

/**
 * Bound the state directory: remove expired records first, then the oldest
 * records until the count fits. Also clears lock files an interrupted process
 * left behind. Bounded by `SESSION_STATE_MAX_FILES + some slack`; anything
 * unreadable is left for a later pass.
 *
 * @param {string} root - the session-state directory.
 * @param {number} now - clock seam.
 * @returns {Promise<{removed: number, kept: number}>} what happened.
 */
async function pruneSessionStates(root, now) {
  let entries
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return { removed: 0, kept: 0 }
  }
  const records = []
  let removed = 0
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (entry.name.endsWith('.lock')) {
      const lockPath = join(root, entry.name)
      try {
        const stat = await fs.lstat(lockPath)
        if (now - stat.mtimeMs > 60 * 1000) {
          await fs.rm(lockPath, { force: true })
          removed += 1
        }
      } catch {
        // Another writer may have cleared it first.
      }
      continue
    }
    if (!entry.name.endsWith('.json')) continue
    const path = join(root, entry.name)
    try {
      const stat = await fs.lstat(path)
      if (now - stat.mtimeMs > SESSION_STATE_TTL_MS) {
        await fs.rm(path, { force: true })
        removed += 1
        continue
      }
      records.push({ path, mtimeMs: stat.mtimeMs })
    } catch {
      // Unreadable now; a later pass will see it.
    }
  }
  const overflow = records.length - SESSION_STATE_MAX_FILES
  if (overflow > 0) {
    records.sort((a, b) => a.mtimeMs - b.mtimeMs)
    for (const record of records.slice(0, overflow)) {
      try {
        await fs.rm(record.path, { force: true })
        removed += 1
      } catch {
        // Best-effort.
      }
    }
  }
  return { removed, kept: records.length - Math.max(0, overflow) }
}
