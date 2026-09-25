// The durable pending queue (Task 14).
//
// One completed root turn becomes one job file under `<dataRoot>/pending/`. The
// file is the durable hand-off between capture (this task) and distillation
// (Tasks 15/16), so its structural guarantees are the whole point of the module:
//
//   * **The queue directory is `0700` and every job file is `0600`.** A pending
//     job holds the whitelisted projection of a real conversation — the most
//     sensitive artifact this plugin ever writes — so it is never group- or
//     world-readable, and `ensureQueueDir` tightens a pre-existing directory
//     instead of trusting its mode.
//   * **A job becomes visible only after temp write → `fsync` → `rename`, and
//     durable only after the directory `fsync` that follows.** The rename is what
//     removes the half-written state: a reader in the same running system never
//     sees partial bytes, and never sees a job before the rename. But between
//     the rename and the directory `fsync` the entry is visible yet not
//     guaranteed across a crash — a power loss there can lose a job a
//     concurrent reader already saw. So the crash guarantee this module makes is
//     the post-directory-`fsync` one: once `writeJobAtomic` RESOLVES, the job
//     survives. That is exactly the boundary the SIGKILL test measures. The
//     complementary guarantee is deliberately absent: bytes fsynced but killed
//     *before* the rename are not recoverable, matching the plan's conservative
//     G3 wording ("at least once after a successful fsync to pending", ruling
//     R12). Nothing here claims to close that window.
//
//   * **A `processed/` record remembers what the queue already handed off.**
//     A completed job is deleted (spec §10.1), so the pending files alone cannot
//     tell a restarted process whether a committed turn was already enqueued —
//     without this record, the next `session/flush` would re-enqueue every
//     finished turn of the session. The record is a per-session set of covered
//     seq ranges (`[[from,to],…]`), advanced only when a job is durably written,
//     and consulted by the back-fill. It is deliberately a *set of ranges*, not
//     one high-water `toSeq`: a transiently failed capture must never be masked
//     by a later turn that advanced the mark past it.
//
//   * **A distillation output is persisted through one identity-preserving
//     barrier** (`persistJobOutput`, Task 15). The unvalidated model text lands
//     as `raw-durable` first and the evidence-checked items as `validated`
//     second, so a crash never loses the model's own words. Once `validated`
//     exists it is immutable: an identical re-persist is a no-op that keeps the
//     stored `preassignedId`/`idempotencyKey` pairs, and a different item set is
//     refused (`output-immutable`) instead of silently minting a second identity
//     for the same fact. The read → guard → write is serialized per job file.
//
// `beforeRename` is the one test seam: it runs after the temp bytes are fsynced
// and before the rename, which lets the crash-window test kill a real process
// at exactly that boundary instead of modelling it.
//
// Recovery (`loadPending`/`readPendingJobs`) never treats a bad queue file as
// silently droppable: `loadPending` is the brief's simple interface, while
// `readPendingJobs` also reports every invalid file so the caller can surface
// corruption instead of pretending the work never existed.
import { promises as fs } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

import { resolveDataRoot } from './paths.js'
import { isUuidV4 } from './pointer.js'
import { fsyncDirectory } from './receipts.js'
import { sha256Hex } from './registry.js'

/** Schema version of one persisted pending job. */
export const PENDING_SCHEMA = 1
/** Schema version of one persisted processed-range record. */
export const PROCESSED_SCHEMA = 1
/** Schema version of one persisted per-turn result receipt (Task 16). */
export const RESULT_RECEIPT_SCHEMA = 1
/** The sub-directory holding one result receipt per finished job. */
export const RECEIPTS_DIRNAME = 'receipts'
/**
 * What one finished turn can say about itself. `no-memory` is the honest "this
 * turn produced nothing durable" marker (a turn is never silently dropped), and
 * `dry-run` is the `distill.dryRun` observation that wrote no vault byte.
 */
export const RESULT_KINDS = Object.freeze(['applied', 'no-memory', 'dry-run'])
/** The queue directory mode. */
export const QUEUE_DIR_MODE = 0o700
/** The mode of every job file (and of the temporary file renamed into place). */
export const JOB_FILE_MODE = 0o600
/**
 * The two states a distillation output barrier may persist (Task 15):
 * `raw-durable` holds the complete, unvalidated model text; `validated` adds the
 * evidence-checked items and their stable identities.
 */
export const OUTPUT_STATES = Object.freeze(['raw-durable', 'validated'])
/** The sub-directory holding one processed-range record per session. */
export const PROCESSED_DIRNAME = 'processed'
/**
 * Upper bound on stored ranges per session. Reached only by a pathological
 * history (each debounce burst is one range); when exceeded the two oldest
 * ranges are compacted by covering the gap between them — an explicit,
 * documented over-approximation that keeps the record bounded.
 */
const MAX_PROCESSED_RANGES = 512
/** The job-id alphabet: file-name-safe, never a path. */
const JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
/** Fields a job cannot exist without; every one is re-checked on recovery. */
const REQUIRED_FIELDS = ['jobId', 'sessionId', 'projectId', 'fromSeq', 'toSeq', 'state']

/**
 * Upper bounds on a persisted refusal audit (Task 15's per-item refusals).
 *
 * The audit exists so an operator can see what was dropped and why, not so it can
 * become a second copy of the model's output: the list and every string in it are
 * bounded, and a bounded list is still honest about the count it was truncated
 * from (the caller keeps the full count separately).
 */
export const MAX_REFUSED_ENTRIES = 32
/** The longest string kept from one refusal field (reason, field, value). */
export const MAX_REFUSAL_TEXT = 200

/**
 * Bounded result receipts (Task 16) carry at most this many refusal entries.
 * Smaller than the job's own bound because a receipt is an operator view.
 */
export const MAX_RECEIPT_REFUSALS = 16

/** Raised when a queue document, job id or patch cannot be trusted. */
export class PendingError extends Error {
  /**
   * @param {string} code - machine-readable reason (`job-id-invalid`, `job-corrupt`, …).
   * @param {string} message - human-readable diagnostic naming the offending path.
   * @param {{ cause?: Error }} [options] - underlying failure, when there is one.
   */
  constructor(code, message, options) {
    super(message, options)
    this.name = 'PendingError'
    this.code = code
  }
}

/**
 * Whether an id may be used as a job file name.
 *
 * The check is deliberately a whole-string allow-list rather than a
 * "does it contain `..`" test: a job id arrives from a tool argument
 * (`mem_admin(action=jobs)`) as well as from this module, so a separator, a
 * leading dot or a traversal segment must all be impossible before any path is
 * built.
 *
 * @param {unknown} jobId - the candidate.
 * @returns {boolean} true when it is a safe single path segment.
 */
export function isSafeJobId(jobId) {
  return typeof jobId === 'string' && JOB_ID_PATTERN.test(jobId) && !jobId.includes('..')
}

/**
 * The file name of one job.
 *
 * @param {string} jobId - the job id.
 * @returns {string} `<jobId>.json`.
 * @throws {PendingError} when the id is not a safe single path segment.
 */
export function jobFileName(jobId) {
  if (!isSafeJobId(jobId)) {
    throw new PendingError('job-id-invalid', `not a safe pending job id: ${JSON.stringify(jobId)}`)
  }
  return `${jobId}.json`
}

/**
 * The queue directory under one plugin data root.
 *
 * @param {string} dataRoot - absolute plugin data root.
 * @returns {string} `<dataRoot>/pending`.
 * @throws {RangeError} when the data root is not an absolute, non-blank path.
 */
export function queueRootFor(dataRoot) {
  if (typeof dataRoot !== 'string' || !dataRoot.trim() || !isAbsolute(dataRoot)) {
    throw new RangeError('dataRoot must be an absolute, non-blank path')
  }
  return join(resolve(dataRoot), 'pending')
}

/**
 * The production queue root, derived from `DSH_HOME` exactly like every other
 * plugin data root.
 *
 * Tests always pass an explicit `queueRoot`; this default exists for the host
 * assembly path only.
 *
 * @returns {string} `<resolveDataRoot()>/pending`.
 */
export function defaultQueueRoot() {
  return queueRootFor(resolveDataRoot())
}

/**
 * Create (or tighten) the queue directory to `0700`.
 *
 * `mkdir`'s mode is masked by the process umask, so the explicit `chmod` is what
 * makes the guarantee a property of this module instead of a property of the
 * caller's umask — and it also repairs a directory an earlier version left
 * group-readable.
 *
 * @param {string} queueRoot - absolute queue directory.
 * @returns {Promise<string>} the queue root.
 * @throws {RangeError} when the queue root is not an absolute, non-blank path.
 */
export async function ensureQueueDir(queueRoot) {
  if (typeof queueRoot !== 'string' || !queueRoot.trim() || !isAbsolute(queueRoot)) {
    throw new RangeError('queueRoot must be an absolute, non-blank path')
  }
  await fs.mkdir(queueRoot, { recursive: true, mode: QUEUE_DIR_MODE })
  await fs.chmod(queueRoot, QUEUE_DIR_MODE)
  return queueRoot
}

/**
 * Persist one job atomically and durably.
 *
 * The temporary file is hidden (leading dot, `.tmp` suffix) so
 * `readPendingJobs` can never mistake a half-written job for work; the rename
 * publishes it in one step; the directory `fsync` is what makes the rename
 * itself survive a crash.
 *
 * @param {string} queueRoot - absolute queue directory.
 * @param {object} job - the job to persist.
 * @param {{ beforeRename?: Function }} [options] - crash-injection seam, run
 *   after the temporary bytes are fsynced and before the rename.
 * @returns {Promise<string>} the absolute path of the published job file.
 * @throws {PendingError} when the job is not a well-formed job document.
 */
export async function writeJobAtomic(queueRoot, job, { beforeRename } = {}) {
  const normalized = normalizeJob(job)
  return writeAtomicIn(queueRoot, jobFileName(normalized.jobId), normalized, { beforeRename })
}

/**
 * The one atomic document writer this module uses (jobs and processed records).
 *
 * `ensureQueueDir` on the leaf means a nested directory such as `processed/` is
 * created and tightened to `0700` exactly like the queue root.
 *
 * @param {string} directory - absolute directory to write into.
 * @param {string} fileName - the destination file name inside `directory`.
 * @param {unknown} value - JSON-serializable value.
 * @param {{ beforeRename?: Function }} [options] - crash-injection seam.
 * @returns {Promise<string>} the absolute path of the published file.
 */
async function writeAtomicIn(directory, fileName, value, { beforeRename } = {}) {
  await ensureQueueDir(directory)
  const target = join(directory, fileName)
  // The pid + clock alone can collide for two writes in the same millisecond;
  // the random suffix makes the exclusive create a real guard rather than a race.
  const temporary = join(
    directory,
    `.${fileName}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  )
  let handle = null
  try {
    handle = await fs.open(temporary, 'wx', JOB_FILE_MODE)
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await handle.sync()
    await handle.close()
    handle = null
    if (typeof beforeRename === 'function') await beforeRename({ temporary, target })
    await fs.rename(temporary, target)
  } catch (error) {
    await handle?.close().catch(() => {})
    await fs.rm(temporary, { force: true }).catch(() => {})
    throw error
  }
  await fsyncDirectory(directory)
  return target
}

/**
 * Read every committed job in a queue, reporting the files it could not trust.
 *
 * A missing queue directory is "no pending work", not an error: the queue is
 * created lazily by the first write, so a fresh install has none.
 *
 * @param {string} queueRoot - absolute queue directory.
 * @returns {Promise<{jobs: object[], invalid: Array<{file: string, reason: string}>}>} the
 *   valid jobs in creation order, and every `*.json` that was skipped.
 */
export async function readPendingJobs(queueRoot) {
  let names
  try {
    names = await fs.readdir(queueRoot)
  } catch (error) {
    if (error.code === 'ENOENT') return { jobs: [], invalid: [] }
    throw error
  }
  const jobs = []
  const invalid = []
  for (const name of [...names].sort()) {
    // Hidden files and anything without the job extension are not jobs: a
    // temporary file of an interrupted write must never be read.
    if (name.startsWith('.') || !name.endsWith('.json')) continue
    const path = join(queueRoot, name)
    let text
    try {
      text = await fs.readFile(path, 'utf8')
    } catch (error) {
      invalid.push({ file: name, reason: `unreadable:${error.code ?? error.message}` })
      continue
    }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      invalid.push({ file: name, reason: 'job-corrupt' })
      continue
    }
    try {
      const job = normalizeJob(parsed)
      if (`${job.jobId}.json` !== name) {
        throw new PendingError(
          'job-corrupt',
          `the job id ${job.jobId} does not match its file name ${name}`,
        )
      }
      jobs.push(job)
    } catch (error) {
      invalid.push({ file: name, reason: error.code ?? 'job-invalid' })
    }
  }
  jobs.sort((left, right) => {
    if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? -1 : 1
    return left.jobId < right.jobId ? -1 : 1
  })
  return { jobs, invalid }
}

/**
 * The valid jobs of a queue, in creation order.
 *
 * @param {string} queueRoot - absolute queue directory.
 * @returns {Promise<object[]>} the jobs (corruption is reported by `readPendingJobs`).
 */
export async function loadPending(queueRoot) {
  return (await readPendingJobs(queueRoot)).jobs
}

/**
 * Apply a patch to one persisted job, atomically.
 *
 * Identity fields (`jobId`, `sessionId`, `projectId`, `fromSeq`, `toSeq`,
 * `createdAt`) are owned by the queue and are preserved even when a patch tries
 * to rewrite them: a worker must be able to move a job's `state`, `output` and
 * `attempts`, never its identity or its audited range.
 *
 * @param {string} jobId - the job to patch.
 * @param {object} patch - the fields to change.
 * @param {{ queueRoot?: string, beforeRename?: Function }} [options] - queue root
 *   (defaults to the production root) and the crash-injection seam.
 * @returns {Promise<object|null>} the updated job, or `null` when it does not exist.
 * @throws {PendingError} when the id is unsafe or the patch is not an object.
 */
export async function markJob(jobId, patch, { queueRoot = defaultQueueRoot(), beforeRename } = {}) {
  const fileName = jobFileName(jobId)
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new PendingError('patch-invalid', 'a pending job patch must be a plain object')
  }
  const existing = await readJobFile(join(queueRoot, fileName))
  if (existing === null) return null
  const next = { ...existing, ...patch }
  next.schema = PENDING_SCHEMA
  next.jobId = existing.jobId
  next.sessionId = existing.sessionId
  next.projectId = existing.projectId
  next.fromSeq = existing.fromSeq
  next.toSeq = existing.toSeq
  next.createdAt = existing.createdAt
  next.updatedAt = new Date().toISOString()
  await writeJobAtomic(queueRoot, next, { beforeRename })
  return normalizeJob(next)
}

// ---------------------------------------------------------------------------
// The distillation output barriers (Task 15)
// ---------------------------------------------------------------------------

/**
 * Persist one model output back into its job, atomically.
 *
 * This is the write half of Task 15's two durability barriers: the caller writes
 * the complete raw output with `state:'raw-durable'` BEFORE it validates
 * anything, then writes the validated items with `state:'validated'` before a
 * vault could be touched. `state` is mirrored onto the job itself so the queue
 * (and `mem_admin(action=jobs)`) can see how far the job got without reading the
 * nested output.
 *
 * The one structural safety property is **identity is never re-minted**: once a
 * `validated` output exists, an identical re-persist is an idempotent no-op
 * (returning the stored job, ids untouched), and a *different* item set is
 * refused with `output-immutable`. A crash-retry can therefore replay the same
 * `preassignedId`/`idempotencyKey` pairs instead of creating duplicate notes,
 * and the only way to change a validated item set is a new job.
 *
 * @param {string} jobId - the job to write into.
 * @param {object} output - `{state:'raw-durable'|'validated', raw, items?, usage?}`.
 * @param {{ queueRoot?: string, beforeRename?: Function }} [options] - queue root
 *   (defaults to the production root) and the crash-injection seam.
 * @returns {Promise<object|null>} the updated job, or `null` when it does not exist.
 * @throws {PendingError} when the id, the output shape or the identity guard refuses.
 */
export async function persistJobOutput(
  jobId,
  output,
  { queueRoot = defaultQueueRoot(), beforeRename } = {},
) {
  const fileName = jobFileName(jobId)
  const normalized = normalizeJobOutput(output)
  const path = join(queueRoot, fileName)
  // Serialized per job file so the read → guard → write sequence below is one
  // critical section: the identity guard is only a guarantee if two writers for
  // one job cannot both read the pre-write state. A different key space from
  // `withQueueLock`/`record:`, so nesting cannot cycle.
  return withLock(`job:${path}`, async () => {
    const existing = await readJobFile(path)
    if (existing === null) return null
    if (existing.output?.state === 'validated') {
      if (normalized.state !== 'validated' || !sameJson(existing.output.items, normalized.items)) {
        throw new PendingError(
          'output-immutable',
          `the pending job ${jobId} already holds validated items; a validated output is never replaced`,
        )
      }
      // Same items. The ONE write that is not a no-op is the additive audit write:
      // Task 15 computes the per-item refusals beside the items, and a caller that
      // carries them may append them to an output that has never been audited. It
      // can only ADD `refused`; `raw`, `items` and `usage` stay exactly as the
      // identity-bearing barrier wrote them.
      if (Array.isArray(normalized.refused) && existing.output.refused == null) {
        const annotated = {
          ...existing,
          state: 'validated',
          output: { ...existing.output, refused: normalized.refused },
          updatedAt: new Date().toISOString(),
        }
        await writeJobAtomic(queueRoot, annotated, { beforeRename })
        return normalizeJob(annotated)
      }
      // A crash immediately after the barrier retries byte-identically: keep the
      // original file (and therefore the original ids) untouched.
      return existing
    }
    const next = {
      ...existing,
      state: normalized.state,
      output: normalized,
      updatedAt: new Date().toISOString(),
    }
    await writeJobAtomic(queueRoot, next, { beforeRename })
    return normalizeJob(next)
  })
}

/**
 * Validate the persisted shape of one model-output barrier.
 *
 * `raw` is always required — it is the audit trail of what the model actually
 * produced, and it is what a `raw-durable` restart re-validates. `validated`
 * additionally requires the item array (an EMPTY array is a legal `no-memory`
 * result, not a missing field). An aborted or failed stream never reaches this
 * function, so a `null` `usage` is tolerated rather than normalized to zeros:
 * token accounting must never invent data the host did not report.
 *
 * @param {unknown} output - the candidate.
 * @returns {object} `{state, raw, items, usage}` as it is persisted.
 * @throws {PendingError} when the shape is not trustable.
 */
export function normalizeJobOutput(output) {
  if (output === null || typeof output !== 'object' || Array.isArray(output)) {
    throw new PendingError('output-invalid', 'a persisted model output must be a plain object')
  }
  if (!OUTPUT_STATES.includes(output.state)) {
    throw new PendingError(
      'output-invalid',
      `a persisted model output state must be one of ${OUTPUT_STATES.join(', ')}`,
    )
  }
  if (typeof output.raw !== 'string') {
    throw new PendingError(
      'output-invalid',
      'a persisted model output must carry the raw model text',
    )
  }
  if (output.state === 'validated' && !Array.isArray(output.items)) {
    throw new PendingError('output-invalid', 'a validated model output must carry its items array')
  }
  if (output.items !== undefined && output.items !== null && !Array.isArray(output.items)) {
    throw new PendingError('output-invalid', 'a persisted items field must be an array or null')
  }
  if (
    output.usage !== undefined &&
    output.usage !== null &&
    (typeof output.usage !== 'object' || Array.isArray(output.usage))
  ) {
    throw new PendingError('output-invalid', 'a persisted usage field must be an object or null')
  }
  return JSON.parse(
    JSON.stringify({
      state: output.state,
      raw: output.raw,
      items: Array.isArray(output.items) ? output.items : null,
      usage: output.usage === undefined || output.usage === null ? null : output.usage,
      // `null` means "never audited"; `[]` means "audited, nothing refused". The
      // distinction is what lets the one additive audit write below land on an
      // output a previous build persisted without a refusal list.
      refused: normalizeRefusals(output.refused, MAX_REFUSED_ENTRIES),
    }),
  )
}

/**
 * Bound and shape-check one refusal audit.
 *
 * A refused candidate is an audit record, not identity, so a malformed entry is
 * coerced into something printable rather than rejected: refusing the whole
 * barrier over a bad `value` would turn a cosmetic problem into a lost turn. The
 * container itself is still an array-or-nothing decision.
 *
 * @param {unknown} value - the candidate list.
 * @param {number} limit - the maximum number of entries kept.
 * @returns {object[]|null} the bounded entries, or `null` when nothing was supplied.
 * @throws {PendingError} when the value is neither an array nor null/undefined.
 */
export function normalizeRefusals(value, limit = MAX_REFUSED_ENTRIES) {
  if (value === undefined || value === null) return null
  if (!Array.isArray(value)) {
    throw new PendingError('output-invalid', 'a persisted refusal list must be an array or null')
  }
  return value.slice(0, limit).map((entry) => {
    const source =
      entry !== null && typeof entry === 'object' && !Array.isArray(entry)
        ? entry
        : { reason: entry }
    const refusal = {
      index: Number.isSafeInteger(source.index) ? source.index : null,
      reason: boundText(source.reason) ?? 'refused',
    }
    const field = boundText(source.field)
    if (field !== null) refusal.field = field
    const refusedValue = boundText(source.value)
    if (refusedValue !== null) refusal.value = refusedValue
    return refusal
  })
}

/** One bounded, single-line printable string, or `null`. */
function boundText(value) {
  if (value === undefined || value === null) return null
  let text
  if (typeof value === 'string') text = value
  else {
    try {
      text = JSON.stringify(value) ?? String(value)
    } catch {
      text = '[unprintable]'
    }
  }
  const oneLine = text.replace(/\s+/gu, ' ').trim()
  return oneLine === '' ? null : oneLine.slice(0, MAX_REFUSAL_TEXT)
}

/** Structural equality for two persisted JSON values. */
function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

// ---------------------------------------------------------------------------
// The per-turn result receipts (Task 16)
// ---------------------------------------------------------------------------

/**
 * The directory holding one project's result receipts.
 *
 * The receipt is deliberately NOT in the vault: a `dryRun` observation and a
 * `no-memory` turn must be visible without writing a single vault byte, and a
 * failed job may never have touched the vault at all. It lives beside the queue
 * files it describes, under the same `0700` root.
 *
 * @param {string} queueRoot - absolute queue directory.
 * @param {string} projectId - the owning project's UUIDv4.
 * @returns {string} `<queueRoot>/receipts/<projectId>`.
 * @throws {RangeError} when the root is not absolute or the id is not a UUIDv4.
 */
export function resultReceiptDir(queueRoot, projectId) {
  if (typeof queueRoot !== 'string' || !queueRoot.trim() || !isAbsolute(queueRoot)) {
    throw new RangeError('queueRoot must be an absolute, non-blank path')
  }
  if (!isUuidV4(projectId)) throw new RangeError('a result receipt needs a UUIDv4 project id')
  return join(resolve(queueRoot), RECEIPTS_DIRNAME, projectId)
}

/**
 * Persist one finished turn's result receipt, atomically and durably.
 *
 * The file is keyed by `jobId`, so re-writing the receipt of a job whose
 * completion crashed between "receipt written" and "job deleted" UPSERTS the
 * same record instead of appending a second one. That is what makes a resumed
 * turn's receipt idempotent.
 *
 * @param {string} queueRoot - absolute queue directory.
 * @param {object} receipt - the receipt to persist.
 * @returns {Promise<object>} the normalized receipt.
 * @throws {PendingError} when the receipt is not a well-formed result record.
 */
export async function writeResultReceipt(queueRoot, receipt) {
  const normalized = normalizeResultReceipt(receipt)
  await writeAtomicIn(
    resultReceiptDir(queueRoot, normalized.projectId),
    `${normalized.jobId}.json`,
    normalized,
  )
  return normalized
}

/**
 * Read one project's result receipts, oldest first.
 *
 * A receipt that cannot be read or parsed is skipped rather than allowed to
 * break an operator's view of the queue; `readResultReceiptFiles` reports it.
 *
 * @param {string} queueRoot - absolute queue directory.
 * @param {string} projectId - the owning project's UUIDv4.
 * @returns {Promise<object[]>} the receipts, sorted by `at` then `jobId`.
 */
export async function readResultReceipts(queueRoot, projectId) {
  return (await readResultReceiptFiles(queueRoot, projectId)).receipts
}

/**
 * Read one project's result receipts and report every file that was skipped.
 *
 * @param {string} queueRoot - absolute queue directory.
 * @param {string} projectId - the owning project's UUIDv4.
 * @returns {Promise<{receipts: object[], invalid: Array<{file: string, reason: string}>}>} the receipts and the skipped files.
 */
export async function readResultReceiptFiles(queueRoot, projectId) {
  const directory = resultReceiptDir(queueRoot, projectId)
  let names
  try {
    names = await fs.readdir(directory)
  } catch (error) {
    if (error.code === 'ENOENT') return { receipts: [], invalid: [] }
    throw error
  }
  const receipts = []
  const invalid = []
  for (const name of [...names].sort()) {
    if (name.startsWith('.') || !name.endsWith('.json')) continue
    try {
      const parsed = JSON.parse(await fs.readFile(join(directory, name), 'utf8'))
      receipts.push(normalizeResultReceipt(parsed))
    } catch (error) {
      invalid.push({
        file: `${RECEIPTS_DIRNAME}/${projectId}/${name}`,
        reason: error.code ?? 'receipt-invalid',
      })
    }
  }
  receipts.sort((left, right) => {
    if (left.at !== right.at) return left.at < right.at ? -1 : 1
    return left.jobId < right.jobId ? -1 : 1
  })
  return { receipts, invalid }
}

/**
 * Remove one finished job's file.
 *
 * Completion is "the receipt is durable, then the job is deleted" (spec §10.1),
 * and the deletion is idempotent: a crash between the two leaves a job whose
 * replay is harmless, and a second delete of an absent file succeeds.
 *
 * @param {string} jobId - the job to remove.
 * @param {{ queueRoot?: string }} [options] - the queue root (defaults to the production root).
 * @returns {Promise<boolean>} true when the job is gone.
 * @throws {PendingError} when the id is not a safe job id.
 */
export async function deleteJob(jobId, { queueRoot = defaultQueueRoot() } = {}) {
  const fileName = jobFileName(jobId)
  await fs.rm(join(queueRoot, fileName), { force: true })
  return true
}

/**
 * Validate one result receipt and return the exact shape that is persisted.
 *
 * @param {unknown} receipt - the candidate.
 * @returns {object} the normalized receipt.
 * @throws {PendingError} when a required field is missing or has the wrong type.
 */
function normalizeResultReceipt(receipt) {
  if (receipt === null || typeof receipt !== 'object' || Array.isArray(receipt)) {
    throw new PendingError('receipt-invalid', 'a result receipt must be a plain object')
  }
  if (!isSafeJobId(receipt.jobId)) {
    throw new PendingError(
      'receipt-invalid',
      `a result receipt must name a safe job id: ${JSON.stringify(receipt.jobId)}`,
    )
  }
  if (!isUuidV4(receipt.projectId)) {
    throw new PendingError('receipt-invalid', 'a result receipt must name a UUIDv4 project id')
  }
  if (typeof receipt.sessionId !== 'string' || receipt.sessionId === '') {
    throw new PendingError('receipt-invalid', 'a result receipt must name its session')
  }
  if (!Number.isSafeInteger(receipt.toSeq) || receipt.toSeq < 0) {
    throw new PendingError(
      'receipt-invalid',
      'a result receipt must carry a non-negative integer toSeq',
    )
  }
  if (!RESULT_KINDS.includes(receipt.result)) {
    throw new PendingError(
      'receipt-invalid',
      `a result receipt result must be one of ${RESULT_KINDS.join(', ')}`,
    )
  }
  if (receipt.items !== undefined && receipt.items !== null && !Array.isArray(receipt.items)) {
    throw new PendingError('receipt-invalid', 'a result receipt items field must be an array')
  }
  // The refusal audit is the operator-visible half of Task 15's per-item
  // refusals: `refused` is the bounded reason list, `refusedCount` is the real
  // count so a truncated list is never mistaken for the whole story. `null` is
  // preserved as "never audited" — collapsing it to `[]` would make a lost audit
  // read exactly like a turn that refused nothing.
  const refused = normalizeRefusals(receipt.refused, MAX_RECEIPT_REFUSALS)
  return JSON.parse(
    JSON.stringify({
      schema: RESULT_RECEIPT_SCHEMA,
      jobId: receipt.jobId,
      projectId: receipt.projectId,
      sessionId: receipt.sessionId,
      toSeq: receipt.toSeq,
      result: receipt.result,
      dryRun: receipt.dryRun === true,
      attempts:
        Number.isSafeInteger(receipt.attempts) && receipt.attempts >= 0 ? receipt.attempts : 0,
      at:
        typeof receipt.at === 'string' && receipt.at !== '' ? receipt.at : new Date().toISOString(),
      items: Array.isArray(receipt.items) ? receipt.items : [],
      refused,
      refusedCount:
        refused === null
          ? null
          : Number.isSafeInteger(receipt.refusedCount) && receipt.refusedCount >= refused.length
            ? receipt.refusedCount
            : refused.length,
      index: typeof receipt.index === 'string' && receipt.index !== '' ? receipt.index : 'none',
      usage:
        receipt.usage === undefined || receipt.usage === null || typeof receipt.usage !== 'object'
          ? null
          : receipt.usage,
      durationMs: Number.isFinite(receipt.durationMs) ? Math.round(receipt.durationMs) : null,
    }),
  )
}

// ---------------------------------------------------------------------------
// The processed floor
// ---------------------------------------------------------------------------

/**
 * The path of one session's processed-range record.
 *
 * The session id is hashed rather than used verbatim: it arrives from the host
 * and may contain a separator or a leading dot, and this file must be a single
 * safe path segment.
 *
 * @param {string} queueRoot - absolute queue directory.
 * @param {string} sessionId - the session the record belongs to.
 * @returns {string} absolute path of the record (not created here).
 * @throws {PendingError} when the session id is not a non-blank string.
 */
export function processedRecordPath(queueRoot, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') {
    throw new PendingError('processed-invalid', 'a processed record needs a session id')
  }
  return join(queueRoot, PROCESSED_DIRNAME, `${sha256Hex(sessionId)}.json`)
}

/**
 * Whether one seq lies inside a processed-range record.
 *
 * @param {object|null|undefined} record - the record, or nothing.
 * @param {number} seq - the seq to test.
 * @returns {boolean} true when the seq's work is already covered.
 */
export function isProcessed(record, seq) {
  if (record === null || record === undefined || !Array.isArray(record.ranges)) return false
  if (!Number.isSafeInteger(seq)) return false
  return record.ranges.some(([from, to]) => from <= seq && seq <= to)
}

/**
 * Read every session's processed-range record.
 *
 * @param {string} queueRoot - absolute queue directory.
 * @returns {Promise<{records: Map<string, object>, invalid: Array<{file: string, reason: string}>}>} the
 *   records by session id, and every record file that was skipped.
 */
export async function readProcessedRecords(queueRoot) {
  const directory = join(queueRoot, PROCESSED_DIRNAME)
  let names
  try {
    names = await fs.readdir(directory)
  } catch (error) {
    if (error.code === 'ENOENT') return { records: new Map(), invalid: [] }
    throw error
  }
  const records = new Map()
  const invalid = []
  for (const name of [...names].sort()) {
    if (name.startsWith('.') || !name.endsWith('.json')) continue
    try {
      const parsed = JSON.parse(await fs.readFile(join(directory, name), 'utf8'))
      const record = normalizeProcessed(parsed)
      // One session has exactly one record; if two exist, the union would be
      // safest, but a duplicate means a bug — keep the wider one and let the
      // narrower file be replaced on the next write.
      const existing = records.get(record.sessionId)
      if (existing === undefined || record.ranges.length >= existing.ranges.length)
        records.set(record.sessionId, record)
    } catch (error) {
      invalid.push({
        file: `${PROCESSED_DIRNAME}/${name}`,
        reason: error.code ?? 'processed-invalid',
      })
    }
  }
  return { records, invalid }
}

/**
 * The processed-range records of a queue, by session id.
 *
 * @param {string} queueRoot - absolute queue directory.
 * @returns {Promise<Map<string, object>>} the records.
 */
export async function loadProcessedRecords(queueRoot) {
  return (await readProcessedRecords(queueRoot)).records
}

/**
 * Record that a seq range's completed turns are already enqueued.
 *
 * Advance-only: ranges are merged, never shrunk, and a range already contained
 * in the record is a no-op. Call this **after** the job file is durably written,
 * so a crash between the two can never mark work done that is not on disk.
 *
 * @param {string} queueRoot - absolute queue directory.
 * @param {object} input - `{sessionId, fromSeq, toSeq, jobId?, at?}`.
 * @returns {Promise<object>} the record after the merge.
 * @throws {PendingError} when the session id or range is not valid.
 */
export async function recordProcessedRange(
  queueRoot,
  { sessionId, fromSeq, toSeq, jobId = null, at = new Date().toISOString() },
) {
  if (
    !Number.isSafeInteger(fromSeq) ||
    !Number.isSafeInteger(toSeq) ||
    fromSeq < 0 ||
    toSeq < fromSeq
  ) {
    throw new PendingError('processed-invalid', `not a valid processed range: ${fromSeq}..${toSeq}`)
  }
  const path = processedRecordPath(queueRoot, sessionId)
  // Serialized per record so two writers cannot lose each other's ranges; a
  // different key space from `withQueueLock`, so nesting inside a queue lock
  // cannot cycle.
  return withLock(`record:${path}`, async () => {
    let existing = null
    try {
      existing = normalizeProcessed(JSON.parse(await fs.readFile(path, 'utf8')))
    } catch (error) {
      // Absence is the normal first write. Anything else — unreadable bytes,
      // invalid JSON, an invalid shape — fails CLOSED: overwriting a record we
      // cannot read would silently drop coverage and let the back-fill redo
      // work whose job was already handed off. `readProcessedRecords` reports
      // the offending file, and the capture that hit it is retried, so the
      // failure surfaces instead of quietly duplicating distillation.
      if (error.code === 'ENOENT') existing = null
      else throw error
    }
    if (existing !== null && existing.ranges.some(([from, to]) => from <= fromSeq && to >= toSeq))
      return existing
    const ranges = mergeRanges([...(existing?.ranges ?? []), [fromSeq, toSeq]])
    const record = { schema: PROCESSED_SCHEMA, sessionId, ranges, jobId, updatedAt: at }
    await writeAtomicIn(join(queueRoot, PROCESSED_DIRNAME), `${sha256Hex(sessionId)}.json`, record)
    return normalizeProcessed(record)
  })
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/** Tail promise per lock key; entries are removed when they settle. */
const locks = new Map()

/**
 * Run `task` after every earlier task for the same key has settled.
 *
 * Capture is a read → decide → write sequence, and two of them interleaving
 * makes each see the pre-merge queue, which silently defeats the debounce rule.
 * One key per queue root (and one per processed record) is enough: the only
 * shared state is the files those keys name.
 *
 * @param {string} key - the lock namespace.
 * @param {Function} task - the work to run.
 * @returns {Promise<*>} the task's result.
 */
function withLock(key, task) {
  const previous = locks.get(key) ?? Promise.resolve()
  const run = previous.then(task, task)
  const settled = run.then(
    () => {},
    () => {},
  )
  locks.set(key, settled)
  settled.then(() => {
    if (locks.get(key) === settled) locks.delete(key)
  })
  return run
}

/**
 * Serialize every queue decision for one queue root.
 *
 * @param {string} queueRoot - absolute queue directory.
 * @param {Function} task - the read → decide → write sequence.
 * @returns {Promise<*>} the task's result.
 */
export function withQueueLock(queueRoot, task) {
  return withLock(`queue:${queueRoot}`, task)
}

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

/**
 * Read and parse one job file.
 *
 * @param {string} path - absolute job path.
 * @returns {Promise<object|null>} the job, or `null` when the file is absent.
 * @throws {PendingError} when the file exists but cannot be trusted.
 */
async function readJobFile(path) {
  let text
  try {
    text = await fs.readFile(path, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw new PendingError(
      'job-unreadable',
      `cannot read the pending job at ${path}: ${error.code ?? error.message}`,
      { cause: error },
    )
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new PendingError('job-corrupt', `the pending job at ${path} is not valid JSON`, {
      cause: error,
    })
  }
  return normalizeJob(parsed)
}

/**
 * Validate a job document and return the exact shape that is persisted.
 *
 * The JSON round trip is intentional: it drops explicit `undefined` values, so
 * the object returned to a caller is byte-for-byte what the next
 * `loadPending()` reads back. Without it, a job with an `undefined` field would
 * compare unequal to its own persisted form.
 *
 * @param {unknown} job - the candidate.
 * @returns {object} the normalized job.
 * @throws {PendingError} when a required field is missing or has the wrong type.
 */
function normalizeJob(job) {
  if (job === null || typeof job !== 'object' || Array.isArray(job)) {
    throw new PendingError('job-invalid', 'a pending job must be a plain object')
  }
  for (const field of REQUIRED_FIELDS) {
    if (job[field] === undefined || job[field] === null) {
      throw new PendingError('job-invalid', `a pending job must carry ${field}`)
    }
  }
  if (!isSafeJobId(job.jobId))
    throw new PendingError(
      'job-id-invalid',
      `not a safe pending job id: ${JSON.stringify(job.jobId)}`,
    )
  if (typeof job.sessionId !== 'string' || job.sessionId === '') {
    throw new PendingError('job-invalid', 'a pending job must name its session')
  }
  if (typeof job.projectId !== 'string' || job.projectId === '') {
    throw new PendingError('job-invalid', 'a pending job must name its project')
  }
  for (const field of ['fromSeq', 'toSeq']) {
    if (!Number.isSafeInteger(job[field]) || job[field] < 0) {
      throw new PendingError(
        'job-invalid',
        `a pending job must carry a non-negative integer ${field}`,
      )
    }
  }
  if (job.fromSeq > job.toSeq) {
    throw new PendingError('job-invalid', 'a pending job range must not end before it starts')
  }
  if (typeof job.state !== 'string' || job.state === '') {
    throw new PendingError('job-invalid', 'a pending job must carry a state')
  }
  if (!Array.isArray(job.allowedEvents)) {
    throw new PendingError('job-invalid', 'a pending job must carry its allowedEvents list')
  }
  if (typeof job.safeInput !== 'string') {
    throw new PendingError('job-invalid', 'a pending job must carry its safeInput')
  }
  return JSON.parse(JSON.stringify({ schema: PENDING_SCHEMA, ...job }))
}

/**
 * Validate a processed-range record and return the persisted shape.
 *
 * @param {unknown} record - the candidate.
 * @returns {object} the normalized record.
 * @throws {PendingError} when the session id or a range is invalid.
 */
function normalizeProcessed(record) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    throw new PendingError('processed-invalid', 'a processed record must be a plain object')
  }
  if (typeof record.sessionId !== 'string' || record.sessionId === '') {
    throw new PendingError('processed-invalid', 'a processed record must name its session')
  }
  if (!Array.isArray(record.ranges))
    throw new PendingError('processed-invalid', 'a processed record must carry ranges')
  const ranges = []
  for (const entry of record.ranges) {
    if (!Array.isArray(entry) || entry.length !== 2) {
      throw new PendingError('processed-invalid', 'every processed range must be a [from,to] pair')
    }
    const [from, to] = entry
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from) {
      throw new PendingError('processed-invalid', `not a valid processed range: ${from}..${to}`)
    }
    ranges.push([from, to])
  }
  return JSON.parse(
    JSON.stringify({
      schema: PROCESSED_SCHEMA,
      sessionId: record.sessionId,
      ranges: mergeRanges(ranges),
      jobId: typeof record.jobId === 'string' ? record.jobId : null,
      updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : null,
    }),
  )
}

/**
 * Merge overlapping or adjacent `[from,to]` ranges into a sorted, minimal set.
 *
 * Adjacency counts as mergeable (`next.from === current.to + 1`) because no seq
 * exists between them; non-adjacent ranges stay separate so a gap — a turn whose
 * capture failed — is never silently covered by a later turn's mark.
 *
 * @param {number[][]} ranges - the ranges to merge.
 * @returns {number[][]} the merged ranges, oldest first.
 */
function mergeRanges(ranges) {
  const sorted = [...ranges].sort((left, right) => left[0] - right[0] || left[1] - right[1])
  const merged = []
  for (const [from, to] of sorted) {
    const last = merged[merged.length - 1]
    if (last !== undefined && from <= last[1] + 1) {
      if (to > last[1]) last[1] = to
      continue
    }
    merged.push([from, to])
  }
  // Pathological history only: compact the two oldest ranges by covering the gap
  // between them so the record stays bounded. Documented over-approximation.
  while (merged.length > MAX_PROCESSED_RANGES) {
    const oldest = merged[0]
    const second = merged[1]
    merged.splice(0, 2, [oldest[0], second[1]])
  }
  return merged
}
