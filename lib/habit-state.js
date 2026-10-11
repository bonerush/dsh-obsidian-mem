// @ts-check
// The habit decay clock and its status transitions.
//
// ---------------------------------------------------------------------------
// Where the numbers come from
// ---------------------------------------------------------------------------
//
// The shape is limbic's `trust.py:apply_decay` — `score * 0.5 ** (days / half_life)`
// — and the three constants are borrowed rather than invented:
//
//   * HALF_LIFE_DAYS = 30 is limbic's default, which cites Microsoft's
//     "Human-Inspired Memory Architecture" for "decay half-life ~29 days optimal
//     for production". Rounding 29 to 30 changes nothing and matches the source.
//   * DEMOTE_BELOW = 0.5 is one half-life: a habit the user has not restated in a
//     month leaves the injected brief. It is a ranking/visibility line, not a
//     deletion.
//   * ARCHIVE_BELOW = 0.15 is CAPTURE's retention floor phi, which its quarantine
//     state reaches after 14 days at 0.135/day.
//
// ---------------------------------------------------------------------------
// The bug this file exists not to repeat
// ---------------------------------------------------------------------------
//
// limbic's docstring records what happened when the anchor was only
// `last_retrieved`: the decay pass runs on every turn, so the SAME elapsed
// interval was re-billed on each pass — "the same 27 days of real time were
// charged ~5 times, driving a healthy 0.69 to 0.036 (10x the correct decay)",
// which pushed facts past the atrophy threshold inside a single session.
//
// The fix is that the anchor is the LATEST of last-reinforced, created and
// last-decayed. `lastDecayedAt` is the part that makes the operation idempotent:
// a second call at the same instant finds the anchor already advanced and charges
// zero further decay. Without it, running the pass on every session start would
// charge the same month over and over.
//
// ---------------------------------------------------------------------------
// Two deliberate refusals
// ---------------------------------------------------------------------------
//
// 1. DECAY NEVER DELETES. A note that reaches the floor is `archived`, which the
//    repository already treats as history (`HISTORY_STATUSES`), and the file stays
//    on disk byte for byte. The repository's own rule is "supersede rather than
//    overwrite, never delete an old note"; Graphiti keeps bi-temporal intervals
//    and never deletes; MeClear argues that "permanent database overwrites [are]
//    prone to catastrophic cross-task performance regression". The literature
//    splits probabilistic deletion from score decay, and only the second is
//    reversible and auditable.
//
// 2. A STATED HABIT IS NEVER DEMOTED. The evidence for it is that the user said
//    so; that they have not repeated it lately is not counter-evidence. Note that
//    this is a SEMANTIC exemption, not limbic's "pinned" class — limbic measured
//    pinning at 79% saturation (182 of 231 facts pinned) with pin state surviving
//    correction, and concluded "There is no exemption class." What is exempt here
//    is not the clock but the inference: `observed` habits still decay, because
//    for them "the user stopped doing it" IS evidence.
//
// The decay arithmetic and the status transitions are a leaf: they import nothing
// from the repository and read no vault, so `habit-learning` above them owns every
// write. The state-file IO at the bottom needs `node:` builtins and nothing else —
// not even the repository's `writeJsonAtomic`, because importing it would put this
// module above `receipts` (L2) for one atomic rename.
import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'

/** The document version. A file with any other value is a miss, not a migration. */
export const HABIT_STATE_SCHEMA = 1
/** The directory under the plugin data root that holds the habit counters. */
const HABIT_DIRECTORY = 'habits'
/** The fields one counter record may carry; anything else is dropped on read. */
const RECORD_FIELDS = Object.freeze([
  'sessions',
  'firstSeen',
  'lastReinforcedAt',
  'lastDecayedAt',
  'score',
  'noteId',
])
/** The Ebbinghaus half-life in days (limbic's default; Microsoft measured ~29). */
export const HALF_LIFE_DAYS = 30
/** The score at which an `active` habit leaves the injected brief: one half-life. */
export const DEMOTE_BELOW = 0.5
/** The score at which a `provisional` habit is archived (CAPTURE's floor phi). */
export const ARCHIVE_BELOW = 0.15

/** Milliseconds in a day, the unit the decay arithmetic works in. */
const DAY_MS = 86_400_000

/**
 * A timestamp as milliseconds, or `null` when it cannot be read.
 *
 * A date this code cannot parse charges no decay rather than guessing one —
 * mem0's rule for its expiration predicate is "A bad date never makes a memory
 * silently vanish", and the same fail-open applies here. Accepts the `Date`
 * objects the caller builds and the ISO strings a JSON round-trip produces.
 *
 * @param {unknown} value - the candidate timestamp.
 * @returns {number|null} milliseconds since the epoch, or `null`.
 */
function timeOf(value) {
  if (value instanceof Date) {
    const time = value.getTime()
    return Number.isFinite(time) ? time : null
  }
  if (typeof value !== 'string' || value.trim() === '') return null
  const time = Date.parse(value)
  return Number.isFinite(time) ? time : null
}

/**
 * The decayed score: `score * 0.5 ** (days / halfLifeDays)`, from the latest anchor.
 *
 * @param {{score: number, createdAt?: unknown, lastReinforcedAt?: unknown,
 *   lastDecayedAt?: unknown, today?: unknown, halfLifeDays?: number}} input - the record and the clock.
 * @returns {number} the new score, unchanged when no decay can be charged.
 */
export function decayScore(input) {
  const score = input?.score
  if (typeof score !== 'number' || !Number.isFinite(score)) return 0
  const halfLife = input.halfLifeDays ?? HALF_LIFE_DAYS
  // limbic keeps half-life 0 as a documented kill switch, and a persisted 0 must
  // stay 0. The guard is also what keeps the exponentiation from dividing by it.
  if (typeof halfLife !== 'number' || !Number.isFinite(halfLife) || halfLife <= 0) return score
  const today = timeOf(input.today ?? new Date())
  if (today === null) return score
  const anchors = [input.lastReinforcedAt, input.createdAt, input.lastDecayedAt]
    .map(timeOf)
    .filter((time) => time !== null)
  if (anchors.length === 0) return score
  // The LATEST anchor. `lastDecayedAt` is what makes a repeated pass idempotent;
  // see the module comment for the 10x bug that omitting it caused.
  const anchor = Math.max(...anchors)
  const days = (today - anchor) / DAY_MS
  // A clock that moved backwards, or a same-instant pass, charges nothing. It must
  // never compound a negative interval into a larger score.
  if (!(days > 0)) return score
  const decayed = score * 0.5 ** (days / halfLife)
  return Math.min(decayed, 1)
}

/**
 * The status a record should hold at its current score.
 *
 * Deterministic and LLM-free on purpose: ExpeL shows a prune path can be entirely
 * arithmetic, and an LLM judgement here would be unreproducible, unauditable and
 * billable.
 *
 * @param {{status?: unknown, assertion?: unknown, score?: unknown}} record - the record.
 * @returns {string} the status to write. Unrecognised statuses pass through.
 */
export function nextStatus(record) {
  const status = record?.status
  const score =
    typeof record?.score === 'number' && Number.isFinite(record.score) ? record.score : 1
  // The semantic exemption: a stated habit's evidence is the user's own words, and
  // silence is not counter-evidence. See the module comment for why this is not
  // limbic's pinned class.
  if (record?.assertion === 'stated') return typeof status === 'string' ? status : 'active'
  if (status === 'archived') return 'archived'
  if (status === 'active') return score < DEMOTE_BELOW ? 'provisional' : 'active'
  if (status === 'provisional') return score < ARCHIVE_BELOW ? 'archived' : 'provisional'
  // Anything else — contested, superseded, deprecated — is a human or supersede
  // decision this module has no business overwriting.
  return typeof status === 'string' ? status : 'active'
}

// ---------------------------------------------------------------------------
// The private state file
// ---------------------------------------------------------------------------

/**
 * The habit state file for one project in one vault.
 *
 * Scoped by vault hash first, then project id: two vaults can carry the same
 * project id, and a counter from one must never reach the other.
 *
 * @param {string} dataRoot - the plugin data root (`resolveDataRoot()`).
 * @param {string} vaultHash - the vault's identity hash.
 * @param {string} projectId - the project's stable id.
 * @returns {string} the absolute path (not created here).
 */
export function habitStatePath(dataRoot, vaultHash, projectId) {
  return join(dataRoot, HABIT_DIRECTORY, String(vaultHash), `${String(projectId)}.json`)
}

/**
 * One stored record, or `null` when the value cannot be one.
 *
 * A record that fails this check is DROPPED rather than repaired. A counter this
 * code cannot read is a counter it must not act on: guessing a session count would
 * promote a habit on evidence nobody can see.
 *
 * @param {unknown} value - the stored record.
 * @returns {object|null} the bounded record, or `null`.
 */
function sanitizeRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const source = /** @type {Record<string, unknown>} */ (value)
  const sessions = source.sessions
  if (!Number.isSafeInteger(sessions) || /** @type {number} */ (sessions) < 0) return null
  const score = typeof source.score === 'number' && Number.isFinite(source.score) ? source.score : 1
  /** @type {Record<string, unknown>} */
  const record = { sessions, score }
  for (const field of RECORD_FIELDS) {
    if (field === 'sessions' || field === 'score') continue
    const entry = source[field]
    if (entry === null || typeof entry === 'string') record[field] = entry
  }
  return record
}

/**
 * Read one project's habit state, answering empty state for anything unreadable.
 *
 * A torn write, a foreign document or a future schema version all resolve to empty
 * state rather than an error, because this read sits on the session-start path: a
 * corrupt cache must not stop a session from starting. The cost of that choice is
 * that a damaged file loses its counts, which are rebuildable by observation.
 *
 * @param {string} dataRoot - the plugin data root.
 * @param {string} vaultHash - the vault's identity hash.
 * @param {string} projectId - the project's stable id.
 * @returns {Promise<{schema: number, records: Record<string, object>}>} the state.
 */
export async function readHabitState(dataRoot, vaultHash, projectId) {
  const empty = { schema: HABIT_STATE_SCHEMA, records: /** @type {Record<string, object>} */ ({}) }
  let raw
  try {
    raw = await fs.readFile(habitStatePath(dataRoot, vaultHash, projectId), 'utf8')
  } catch {
    return empty
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return empty
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return empty
  if (parsed.schema !== HABIT_STATE_SCHEMA) return empty
  const records = parsed.records
  if (records === null || typeof records !== 'object' || Array.isArray(records)) return empty
  /** @type {Record<string, object>} */
  const kept = {}
  for (const [label, value] of Object.entries(records)) {
    const record = sanitizeRecord(value)
    if (record !== null) kept[label] = record
  }
  return { schema: HABIT_STATE_SCHEMA, records: kept }
}

/**
 * Replace one project's habit state atomically.
 *
 * Written through a temporary file in the same directory and renamed into place,
 * so a crash leaves either the old document or the new one and never a half-written
 * file. The directory is created on first write.
 *
 * @param {string} dataRoot - the plugin data root.
 * @param {string} vaultHash - the vault's identity hash.
 * @param {string} projectId - the project's stable id.
 * @param {{schema: number, records: Record<string, object>}} state - the state to store.
 * @returns {Promise<void>} resolves once the rename is durable.
 */
export async function writeHabitState(dataRoot, vaultHash, projectId, state) {
  const path = habitStatePath(dataRoot, vaultHash, projectId)
  const directory = dirname(path)
  await fs.mkdir(directory, { recursive: true })
  const temporary = join(
    directory,
    `.${Date.now()}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`,
  )
  let handle
  try {
    handle = await fs.open(temporary, 'wx', 0o600)
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, 'utf8')
    await handle.sync()
    await handle.close()
    handle = null
    await fs.rename(temporary, path)
  } catch (error) {
    await handle?.close().catch(() => {})
    await fs.rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}
