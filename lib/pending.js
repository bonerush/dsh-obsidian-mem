// The durable pending queue (Task 14).
//
// One completed root turn becomes one job file under `<dataRoot>/pending/`. The
// file is the durable hand-off between capture (this task) and distillation
// (Tasks 15/16), so its two structural guarantees are the whole point of the
// module:
//
//   * **The queue directory is `0700` and every job file is `0600`.** A pending
//     job holds the whitelisted projection of a real conversation — the most
//     sensitive artifact this plugin ever writes — so it is never group- or
//     world-readable, and `ensureQueueDir` tightens a pre-existing directory
//     instead of trusting its mode.
//   * **A job becomes visible only after temp write → `fsync` → `rename` →
//     directory `fsync`.** A reader therefore never sees a half-written job,
//     and a job that is visible survived a crash. The complementary guarantee
//     is deliberately absent: bytes fsynced but killed *before* the rename are
//     not recoverable, which matches the plan's conservative G3 wording
//     ("at least once after a successful fsync to pending", ruling R12). Nothing
//     in this file claims to close that window.
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
import { fsyncDirectory } from './receipts.js'

/** Schema version of one persisted pending job. */
export const PENDING_SCHEMA = 1
/** The queue directory mode. */
export const QUEUE_DIR_MODE = 0o700
/** The mode of every job file (and of the temporary file renamed into place). */
export const JOB_FILE_MODE = 0o600
/** The job-id alphabet: file-name-safe, never a path. */
const JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
/** Fields a job cannot exist without; every one is re-checked on recovery. */
const REQUIRED_FIELDS = ['jobId', 'sessionId', 'projectId', 'fromSeq', 'toSeq', 'state']

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
  const fileName = jobFileName(normalized.jobId)
  await ensureQueueDir(queueRoot)
  const target = join(queueRoot, fileName)
  const temporary = join(queueRoot, `.${fileName}.${process.pid}.${Date.now()}.tmp`)
  let handle = null
  try {
    handle = await fs.open(temporary, 'wx', JOB_FILE_MODE)
    await handle.writeFile(`${JSON.stringify(normalized, null, 2)}\n`, 'utf8')
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
  await fsyncDirectory(queueRoot)
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
        throw new PendingError('job-corrupt', `the job id ${job.jobId} does not match its file name ${name}`)
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
    throw new PendingError('job-unreadable', `cannot read the pending job at ${path}: ${error.code ?? error.message}`, { cause: error })
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new PendingError('job-corrupt', `the pending job at ${path} is not valid JSON`, { cause: error })
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
  if (!isSafeJobId(job.jobId)) throw new PendingError('job-id-invalid', `not a safe pending job id: ${JSON.stringify(job.jobId)}`)
  if (typeof job.sessionId !== 'string' || job.sessionId === '') {
    throw new PendingError('job-invalid', 'a pending job must name its session')
  }
  if (typeof job.projectId !== 'string' || job.projectId === '') {
    throw new PendingError('job-invalid', 'a pending job must name its project')
  }
  for (const field of ['fromSeq', 'toSeq']) {
    if (!Number.isSafeInteger(job[field]) || job[field] < 0) {
      throw new PendingError('job-invalid', `a pending job must carry a non-negative integer ${field}`)
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
