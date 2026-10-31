// Task 2 (v0.4): the three confirmed panel operations — a preview, then a separate
// confirm that performs exactly one write.
//
// The unit of work is a *preview token*: a random, single-use capability bound to
// the session, the project, the operation, the normalized arguments and a
// fingerprint of the facts the human was shown. Previewing reads through
// `services.admin` and writes nothing; confirming re-reads the same facts, refuses
// with `preview-stale` when they moved, and only then calls the one mutation. That
// ordering is the whole reason the browser cannot replay a stale sheet against a
// job that was retried in another tab, or against another project's queue entry.
//
// The service stays the authority for every write. `retryJob`, `compactHot` and
// `writeDigestNote` already re-derive their own preconditions and commit through
// the queue lock or the vault transaction, so this module never grows a second
// check-then-write: it asks `services.admin` for both the read and the write.
//
// Nothing here is a listener or a timer. The only state is the bounded in-process
// token table, and a plugin restart makes every open preview stale — which is the
// correct answer, because the sheet a human was looking at no longer exists.
import { createHash, randomBytes } from 'node:crypto'

import { resolveLocale } from './locale.js'
import { dialogCopy } from './panel-copy.js'

/** The confirmed operation vocabulary; the panel UI and the route both read it. */
export const PANEL_MUTATIONS = Object.freeze(['retry-job', 'compact-hot', 'refresh-digest'])

/** How long an issued preview stays confirmable. */
export const PREVIEW_TTL_MS = 60_000

/** The per-process preview bound (spec §4: at most 128 tokens). */
export const MAX_PREVIEW_TOKENS = 128

const MAX_JOB_ID_CHARS = 200
const MAX_FACT_CHARS = 160

/**
 * A coded refusal: the route maps `status` straight onto the HTTP response.
 *
 * @param {string} code - the wire code the UI switches on.
 * @param {string} message - a short, source-free sentence a human can read.
 * @param {number} status - the HTTP status that carries it.
 * @returns {Error} the refusal.
 */
function panelError(code, message, status) {
  const error = new Error(message)
  error.code = code
  error.status = status
  return error
}

/**
 * The bounded preview-token table: issue, begin, settle, replay.
 *
 * A token moves `idle -> running -> done`. `begin` is the only transition that
 * spends a token, and a mismatch (another session or project) does not spend it —
 * a mistaken tab must not invalidate the tab that owns the sheet. A `running`
 * token is refused to a second begin rather than overwritten, and it is never
 * evicted, so capacity is reported instead of silently dropping work in flight.
 *
 * @param {{now?: () => number, max?: number}} [options] - clock and capacity seams.
 * @returns {object} the token table.
 */
export function createPreviewTokens({ now = Date.now, max = MAX_PREVIEW_TOKENS } = {}) {
  if (typeof now !== 'function') throw new RangeError('the preview clock must be a function')
  if (!Number.isSafeInteger(max) || max < 1)
    throw new RangeError('the preview capacity must be a positive integer')
  /** @type {Map<string, object>} insertion-ordered, so eviction is oldest-first. */
  const entries = new Map()
  const expired = (entry) => now() > entry.expiresAt

  /** Free one slot: a terminal or expired token first, then an idle one. */
  const makeRoom = () => {
    if (entries.size < max) return
    for (const [token, entry] of entries) {
      if (entry.state === 'done' || expired(entry)) {
        entries.delete(token)
        return
      }
    }
    for (const [token, entry] of entries) {
      if (entry.state === 'idle') {
        entries.delete(token)
        return
      }
    }
    throw panelError(
      'preview-capacity',
      'too many previews are open in this process; confirm or wait for one to expire',
      503,
    )
  }

  return {
    /** Mint one token for a previewed operation. */
    issue({ sessionId, projectId, operation, args, fingerprint }) {
      if (typeof sessionId !== 'string' || sessionId === '')
        throw new RangeError('a preview token needs a session id')
      if (typeof projectId !== 'string' || projectId === '')
        throw new RangeError('a preview token needs a project id')
      if (!PANEL_MUTATIONS.includes(operation))
        throw new RangeError('a preview token needs a panel mutation')
      if (typeof fingerprint !== 'string' || fingerprint === '')
        throw new RangeError('a preview token needs a fingerprint')
      makeRoom()
      let token
      do {
        token = randomBytes(32).toString('base64url')
      } while (entries.has(token))
      const expiresAt = now() + PREVIEW_TTL_MS
      entries.set(token, {
        sessionId,
        projectId,
        operation,
        args,
        fingerprint,
        expiresAt,
        state: 'idle',
        result: null,
      })
      return { token, expiresAt }
    },

    /** Spend one token, or replay the result a spent token already recorded. */
    begin({ token, sessionId, projectId }) {
      const entry = entries.get(token)
      if (entry === undefined)
        throw panelError('preview-unknown', 'this preview token is unknown or was evicted', 409)
      if (entry.sessionId !== sessionId || entry.projectId !== projectId)
        throw panelError(
          'preview-mismatch',
          'this preview belongs to another session or project',
          409,
        )
      if (expired(entry)) {
        entries.delete(token)
        throw panelError(
          'preview-expired',
          'this preview expired; preview the operation again',
          409,
        )
      }
      if (entry.state === 'running')
        throw panelError(
          'preview-in-progress',
          'a confirmation for this preview is already running',
          409,
        )
      if (entry.state === 'done') return { kind: 'replay', entry, result: entry.result }
      entry.state = 'running'
      return { kind: 'run', entry }
    },

    /** Record the result of a successful confirmation so a lost response replays. */
    settle(token, result) {
      const entry = entries.get(token)
      if (entry === undefined) return
      entry.state = 'done'
      entry.result = result
    },

    /** Return a refused/failed token to `idle` so the same sheet can retry. */
    release(token) {
      const entry = entries.get(token)
      if (entry !== undefined && entry.state === 'running') entry.state = 'idle'
    },

    /** The number of tokens currently held (the capacity bound, observable). */
    size() {
      return entries.size
    },
  }
}

/** The one per-process token table the route uses when no test seam is supplied. */
let processPreviewTokens = null

/** @returns {object} the process-wide preview table. */
function defaultPreviewTokens() {
  processPreviewTokens ??= createPreviewTokens()
  return processPreviewTokens
}

/**
 * Bound one operation's arguments to the single reviewed shape it accepts.
 *
 * @param {string} operation - a member of {@link PANEL_MUTATIONS}.
 * @param {unknown} args - the request's argument object, if any.
 * @returns {object} the normalized arguments (`{}` for compact-hot).
 * @throws {RangeError} for an unknown operation, a foreign key or an out-of-bound value.
 */
export function normalizePanelArgs(operation, args) {
  if (!PANEL_MUTATIONS.includes(operation))
    throw new RangeError(`unknown panel mutation: ${JSON.stringify(operation)}`)
  if (args === undefined) args = {}
  if (args === null || typeof args !== 'object' || Array.isArray(args))
    throw new RangeError('panel mutation arguments must be a plain object')
  const keys = Object.keys(args)
  if (operation === 'retry-job') {
    if (keys.length !== 1 || !keys.includes('jobId'))
      throw new RangeError('retry-job takes exactly one argument: { jobId }')
    const raw = args.jobId
    if (typeof raw !== 'string' || raw.trim() === '')
      throw new RangeError('retry-job jobId must be a non-blank string')
    const jobId = raw.trim()
    if (jobId.length > MAX_JOB_ID_CHARS)
      throw new RangeError(`retry-job jobId is longer than ${MAX_JOB_ID_CHARS} characters`)
    return { jobId }
  }
  if (operation === 'compact-hot') {
    if (keys.length > 0) throw new RangeError('compact-hot takes no arguments')
    return {}
  }
  for (const key of keys)
    if (key !== 'days') throw new RangeError(`refresh-digest does not accept ${key}`)
  const days = args.days === undefined ? 1 : args.days
  if (!Number.isSafeInteger(days) || days < 1 || days > 30)
    throw new RangeError('refresh-digest days must be an integer in 1..30')
  return { days }
}

/**
 * Hash everything a shown preview depends on, order-independently.
 *
 * Key order is not a fact, so the JSON is canonical (sorted keys, recursive); two
 * requests with the same arguments and the same state produce the same id even
 * when a caller built the objects in a different order.
 *
 * @param {{projectId: string, operation: string, args?: object, state?: unknown}} input - the preview identity.
 * @returns {string} the 64-character hex fingerprint.
 * @throws {RangeError} when the project, operation or shape is missing.
 */
export function previewFingerprint({ projectId, operation, args, state } = {}) {
  if (typeof projectId !== 'string' || projectId === '')
    throw new RangeError('a preview fingerprint needs a project id')
  if (!PANEL_MUTATIONS.includes(operation))
    throw new RangeError('a preview fingerprint needs a panel mutation')
  const canonical = canonicalJson({ projectId, operation, args: args ?? {}, state: state ?? null })
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

/**
 * Canonical JSON: object keys sorted, arrays in order, undefined dropped.
 *
 * @param {unknown} value - the value to serialize.
 * @returns {string} the canonical text.
 */
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') {
    const text = JSON.stringify(value)
    return text === undefined ? 'null' : text
  }
  if (Array.isArray(value)) return '[' + value.map((item) => canonicalJson(item)).join(',') + ']'
  const keys = Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
  return (
    '{' + keys.map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}'
  )
}

/**
 * Preview one operation: read its facts, issue a token, write nothing.
 *
 * @param {object} input - `{operation, args, sessionId, binding, locale, services, exec, tokens, today}`.
 * @returns {Promise<object>} `{operation, projectId, token, expiresAt, preview}`.
 * @throws {Error} a coded refusal (`job-*`, `hot-missing`, `digest-unavailable`).
 */
export async function previewPanelAction({
  operation,
  args,
  sessionId,
  binding,
  locale,
  services,
  exec,
  tokens,
  today,
} = {}) {
  if (typeof sessionId !== 'string' || sessionId === '')
    throw new RangeError('previewPanelAction needs a session id')
  assertServices(services, 'previewPanelAction')
  const projectId = requireProjectId(binding)
  const copy = dialogCopy(resolveLocale({ value: locale }))
  const normalized = normalizePanelArgs(operation, args)
  const built = await previewOf(operation, {
    args: normalized,
    services,
    exec,
    binding,
    projectId,
    copy,
    day: dayOf(today, null),
  })
  const fingerprint = previewFingerprint({
    projectId,
    operation,
    args: normalized,
    state: built.state,
  })
  const issued = (tokens ?? defaultPreviewTokens()).issue({
    sessionId,
    projectId,
    operation,
    args: normalized,
    fingerprint,
  })
  return {
    operation,
    projectId,
    token: issued.token,
    expiresAt: issued.expiresAt,
    preview: {
      title: built.title,
      confirmLabel: built.confirmLabel,
      facts: built.facts,
      effects: built.effects,
      ...(built.warning === undefined ? {} : { warning: built.warning }),
    },
  }
}

/**
 * Confirm one preview: revalidate its fingerprint, run its single mutation, replay on retry.
 *
 * @param {object} input - `{token, sessionId, binding, services, exec, tokens, today}`.
 * @returns {Promise<object>} `{replayed, operation, result}`.
 * @throws {Error} a coded refusal (`preview-*`, `job-*`, `hot-*`, `digest-*`).
 */
export async function confirmPanelAction({
  token,
  sessionId,
  binding,
  services,
  exec,
  tokens,
  today,
} = {}) {
  if (typeof sessionId !== 'string' || sessionId === '')
    throw new RangeError('confirmPanelAction needs a session id')
  assertServices(services, 'confirmPanelAction')
  const projectId = requireProjectId(binding)
  const store = tokens ?? defaultPreviewTokens()
  const begun = store.begin({ token, sessionId, projectId })
  if (begun.kind === 'replay')
    return { replayed: true, operation: begun.entry.operation, result: begun.result }
  const entry = begun.entry
  let result
  try {
    const state = await revalidate(entry.operation, {
      args: entry.args,
      services,
      exec,
      binding,
      projectId,
      day: dayOf(today, null),
    })
    const fingerprint = previewFingerprint({
      projectId,
      operation: entry.operation,
      args: entry.args,
      state,
    })
    if (fingerprint !== entry.fingerprint)
      throw panelError(
        'preview-stale',
        'the state behind this preview changed; preview the operation again',
        409,
      )
    result = await mutate(entry.operation, {
      args: entry.args,
      services,
      exec,
      binding,
      projectId,
    })
  } catch (error) {
    store.release(token)
    throw error
  }
  store.settle(token, result)
  return { replayed: false, operation: entry.operation, result }
}

// ---------------------------------------------------------------------------
// Preview builders: read the facts a human needs and refuse a dead operation
// ---------------------------------------------------------------------------

/**
 * Build one operation's preview: title, facts, effects and the fingerprint state.
 *
 * @param {string} operation - the panel mutation.
 * @param {object} input - `{args, services, exec, binding, projectId, copy, day}`.
 * @returns {Promise<object>} the preview projection.
 */
async function previewOf(operation, input) {
  if (operation === 'retry-job') return retryPreview(input)
  if (operation === 'compact-hot') return hotPreview(input)
  return digestPreview(input)
}

/**
 * The retry preview: identity and terminal state of one displayed job.
 *
 * @param {object} input - the preview inputs.
 * @returns {Promise<object>} the preview projection.
 */
async function retryPreview({ args, services, exec, binding, projectId, copy }) {
  const { job } = await retryState(services, exec, args.jobId)
  if (job === null) throw panelError('job-missing', `no queued job named ${args.jobId}`, 409)
  if (job.projectId !== projectId)
    throw panelError('job-foreign', `the queued job ${args.jobId} belongs to another project`, 409)
  if (job.state !== 'failed')
    throw panelError(
      'job-not-retryable',
      `the queued job ${args.jobId} is ${job.state}, not failed`,
      409,
    )
  const { retry } = copy
  const facts = [
    { label: retry.labels.job, value: job.jobId },
    { label: retry.labels.project, value: projectLabel(binding) },
    { label: retry.labels.state, value: String(job.state) },
    { label: retry.labels.attempts, value: String(count(job.attempts)) },
    {
      label: retry.labels.failedAt,
      value: typeof job.failedAt === 'string' ? job.failedAt : retry.unknown,
    },
  ]
  const lastError = clip(job.lastError)
  if (lastError !== null) facts.push({ label: retry.labels.error, value: lastError })
  return {
    title: retry.title,
    confirmLabel: retry.confirmLabel,
    facts,
    effects: [...retry.effects],
    warning: retry.warning,
    state: retryIdentity(job),
  }
}

/**
 * The hot preview: current usage and exactly what one compact may move.
 *
 * @param {object} input - the preview inputs.
 * @returns {Promise<object>} the preview projection.
 */
async function hotPreview({ services, exec, copy }) {
  const status = await hotState(services, exec)
  if (status === null) throw panelError('unavailable', 'the hot-zone status is unavailable', 503)
  if (status.missing === true)
    throw panelError('hot-missing', 'this project has no hot file to compact', 409)
  const sections = Array.isArray(status.sections) ? status.sections : []
  const used = count(status.used)
  const trigger = count(status.trigger)
  const compactable = count(status.compactable)
  // `planArchive` only drains entries when the file is ABOVE the trigger; at or
  // below it (`charCount(text) <= trigger`) it is a deliberate no-op, and compact
  // reports moved 0 / folded 0 / reclaimed 0. The live case on 2026-10-31 was used
  // 5728 < trigger 6030: the old preview still promised "本次最多搬出 14 条" and
  // listed 可搬出 14 / 可归档 14, so a safe no-op looked like a broken button. The
  // preview must instead say what the planner will actually do: fold legacy
  // per-entry pointer lines, archive nothing.
  const belowTrigger = used <= trigger
  const { hot } = copy
  const facts = [
    { label: hot.labels.used, value: hot.usedValue(used, count(status.capacity)) },
    { label: hot.labels.trigger, value: hot.triggerValue(trigger) },
    { label: hot.labels.movable, value: String(compactable) },
    { label: hot.labels.archivable, value: String(count(status.archivable)) },
    ...sections.map((section) => ({
      label: hot.sectionLabel(String(section?.name ?? '')),
      value: hot.sectionValue(
        count(section?.entries),
        count(section?.pointers),
        count(section?.moveable),
      ),
    })),
  ]
  return {
    title: hot.title,
    confirmLabel: hot.confirmLabel,
    facts,
    effects: belowTrigger ? [...hot.effectsBelow] : hot.effectsAbove(compactable),
    ...(belowTrigger ? { warning: hot.warningBelow(used, trigger) } : {}),
    state: hotIdentity(status),
  }
}

/**
 * The digest preview: target, window and the counts the writer will publish.
 *
 * @param {object} input - the preview inputs.
 * @returns {Promise<object>} the preview projection.
 */
async function digestPreview({ args, services, exec, binding, day, copy }) {
  const digest = await digestState(services, exec, args.days)
  if (digest === null)
    throw panelError('digest-unavailable', 'the digest collector is unavailable', 503)
  const notes = digest.notes ?? {}
  const collection = digest.collection ?? {}
  const reasons = Array.isArray(collection.reasons)
    ? collection.reasons.filter((reason) => typeof reason === 'string')
    : []
  const relativeDir =
    typeof binding.relativeDir === 'string' && binding.relativeDir !== ''
      ? binding.relativeDir + '/'
      : ''
  const { digest: copyDigest } = copy
  return {
    title: copyDigest.title,
    confirmLabel: copyDigest.confirmLabel,
    facts: [
      { label: copyDigest.labels.target, value: '_meta/digest.md' },
      { label: copyDigest.labels.project, value: projectLabel(binding) },
      { label: copyDigest.labels.window, value: copyDigest.windowValue(args.days) },
      { label: copyDigest.labels.created, value: String(count(notes.created)) },
      { label: copyDigest.labels.updated, value: String(count(notes.updated)) },
      { label: copyDigest.labels.checked, value: String(count(collection.inspected)) },
    ],
    effects: copyDigest.effects(relativeDir),
    ...(collection.incomplete === true ? { warning: copyDigest.warning(reasons) } : {}),
    state: digestIdentity(digest, args.days, day),
  }
}

// ---------------------------------------------------------------------------
// Fingerprint states: the exact facts a preview is bound to, and their re-read
// ---------------------------------------------------------------------------

/**
 * Re-read one operation's preview state without enforcing its preconditions.
 *
 * A confirmation has to distinguish "precondition refused" (a coded job/hot error)
 * from "state moved" (preview-stale): the sheet was valid when issued, so anything
 * that no longer matches is staleness, never a fresh preview refusal.
 *
 * @param {string} operation - the panel mutation.
 * @param {object} input - the revalidation inputs.
 * @returns {Promise<unknown>} the state object to fingerprint.
 */
async function revalidate(operation, input) {
  if (operation === 'retry-job') {
    const { job } = await retryState(input.services, input.exec, input.args.jobId)
    return job === null ? { missing: true, jobId: input.args.jobId } : retryIdentity(job)
  }
  if (operation === 'compact-hot') {
    const status = await hotState(input.services, input.exec)
    return status === null ? { unavailable: true } : hotIdentity(status)
  }
  const digest = await digestState(input.services, input.exec, input.args.days)
  return digest === null
    ? { unavailable: true }
    : digestIdentity(digest, input.args.days, input.day)
}

/**
 * The retry state: the three facts that make a job revivable.
 *
 * @param {object} job - one job view.
 * @returns {object} the stable identity.
 */
function retryIdentity(job) {
  return {
    jobId: String(job.jobId ?? ''),
    state: String(job.state ?? ''),
    attempts: count(job.attempts),
    projectId: String(job.projectId ?? ''),
  }
}

/**
 * The hot state: every number one compact decision reads.
 *
 * @param {object} status - the hot status result.
 * @returns {object} the stable identity.
 */
function hotIdentity(status) {
  const sections = Array.isArray(status.sections) ? status.sections : []
  return {
    missing: status.missing === true,
    used: count(status.used),
    capacity: count(status.capacity),
    trigger: count(status.trigger),
    ratio: count(status.ratio),
    archivable: count(status.archivable),
    compactable: count(status.compactable),
    sections: sections.map((section) => ({
      name: String(section?.name ?? ''),
      chars: count(section?.chars),
      entries: count(section?.entries),
      pointers: count(section?.pointers),
      moveable: count(section?.moveable),
    })),
  }
}

/**
 * The digest state, day-granular exactly where the written note is.
 *
 * The collector reads its clock twice, so `window.to` and `snapshot.at` move by a
 * few milliseconds between the preview and the confirmation. The rendered note is
 * day-granular (`renderDigestNote` slices the window to a date), so the fingerprint
 * must be too — otherwise a confirmation near a read would always be stale.
 *
 * @param {object} digest - the collected digest.
 * @param {number} days - the requested window.
 * @param {string|null} day - the preview day, when the caller supplied one.
 * @returns {object} the stable identity.
 */
function digestIdentity(digest, days, day) {
  const notes = digest.notes ?? {}
  const hot = digest.hot ?? null
  const queue = digest.queue ?? null
  const collection = digest.collection ?? {}
  const appraisal = digest.appraisal ?? null
  const recent = Array.isArray(digest.recent) ? digest.recent : []
  return {
    day: day ?? String(digest.window?.to ?? '').slice(0, 10),
    days,
    notes: {
      created: count(notes.created),
      updated: count(notes.updated),
      superseded: count(notes.superseded),
      byType: (Array.isArray(notes.byType) ? notes.byType : []).map((row) => ({
        type: String(row?.type ?? ''),
        created: count(row?.created),
        updated: count(row?.updated),
      })),
    },
    hot: hot === null ? null : hotIdentity(hot),
    queue:
      queue === null
        ? null
        : {
            queued: count(queue.queued),
            failed: count(queue.failed),
            deferred: count(queue.deferred),
          },
    appraisal:
      appraisal === null
        ? null
        : {
            total: count(appraisal.total),
            truncated: appraisal.truncated === true,
            scanned: count(appraisal.scanned),
          },
    recent: recent.map((row) => ({
      path: String(row?.path ?? ''),
      title: String(row?.title ?? ''),
      type: String(row?.type ?? ''),
      status: String(row?.status ?? ''),
      updated: row?.updated ?? null,
    })),
    collection: {
      inspected: count(collection.inspected),
      truncated: collection.truncated === true,
      incomplete: collection.incomplete === true,
      reasons: (Array.isArray(collection.reasons) ? collection.reasons : []).map(String),
    },
  }
}

// ---------------------------------------------------------------------------
// The service reads and the one write per operation
// ---------------------------------------------------------------------------

/**
 * Read one job view from the queue, if it still exists.
 *
 * @param {object} services - the memory services.
 * @param {object} exec - the tool execution context.
 * @param {string} jobId - the job to read.
 * @returns {Promise<{job: object|null}>} the job view.
 */
async function retryState(services, exec, jobId) {
  const value = await services.admin({ action: 'jobs', jobId }, undefined, exec)
  const jobs = Array.isArray(value?.result?.jobs) ? value.result.jobs : []
  const job = jobs.find(
    (entry) => entry !== null && typeof entry === 'object' && entry.jobId === jobId,
  )
  return { job: job ?? null }
}

/**
 * Read the hot-zone status, feature-detected against the action fall-through.
 *
 * @param {object} services - the memory services.
 * @param {object} exec - the tool execution context.
 * @returns {Promise<object|null>} the status result, or `null` when absent.
 */
async function hotState(services, exec) {
  const value = await services.admin({ action: 'hot', operation: 'status' }, undefined, exec)
  if (value?.action !== 'hot') return null
  return value.result !== null && typeof value.result === 'object' ? value.result : null
}

/**
 * Read one digest, feature-detected exactly as the panel's read card is.
 *
 * @param {object} services - the memory services.
 * @param {object} exec - the tool execution context.
 * @param {number} days - the requested window.
 * @returns {Promise<object|null>} the digest result, or `null` when absent.
 */
async function digestState(services, exec, days) {
  const value = await services.admin({ action: 'digest', days, operation: 'read' }, undefined, exec)
  if (value?.action !== 'digest') return null
  return value.result !== null && typeof value.result === 'object' ? value.result : null
}

/** Run the one write a confirmed operation names. */
async function mutate(operation, input) {
  if (operation === 'retry-job') return mutateRetry(input)
  if (operation === 'compact-hot') return mutateHot(input)
  return mutateDigest(input)
}

/**
 * Requeue exactly the previewed job through the service's ownership guard.
 *
 * @param {object} input - the mutation inputs.
 * @returns {Promise<object>} `{status, jobId, state}`.
 */
async function mutateRetry({ args, services, exec, projectId }) {
  const value = await services.admin(
    { action: 'jobs', retry: true, jobId: args.jobId, projectId },
    undefined,
    exec,
  )
  const result = value?.result
  if (result?.status !== 'retried') {
    const message = typeof result?.message === 'string' ? result.message : 'the retry was refused'
    // The service re-derived the same preconditions under its own read; mapping its
    // refusal text back to the wire code keeps the panel honest after a race.
    if (/does not belong to project/u.test(message)) throw panelError('job-foreign', message, 409)
    if (/not failed|retry-not-failed/u.test(message))
      throw panelError('job-not-retryable', message, 409)
    if (/no pending job/u.test(message)) throw panelError('job-missing', message, 409)
    throw panelError('unavailable', message, 503)
  }
  const jobs = Array.isArray(result.jobs) ? result.jobs : []
  const job = jobs.find((entry) => entry?.jobId === args.jobId)
  return {
    status: 'retried',
    jobId: args.jobId,
    state: typeof job?.state === 'string' ? job.state : null,
  }
}

/**
 * Compact the hot file in one transaction and report what the pass moved.
 *
 * `used`, `capacity` and `trigger` ride along because a below-trigger compact is
 * a safe no-op (moved 0 / folded 0 / reclaimed 0) and the panel has to be able to
 * say why instead of showing a silent success. The admin compact branch already
 * answers with the post-commit `hotStatus()` spread — which carries all three —
 * so this stays one bounded read plus the one write, and lib/hot.js is unchanged.
 *
 * @param {object} input - the mutation inputs.
 * @returns {Promise<object>} `{status, moved, folded, reclaimed, used, capacity, trigger}`.
 */
async function mutateHot({ services, exec }) {
  const value = await services.admin({ action: 'hot', operation: 'compact' }, undefined, exec)
  const result = value?.result
  if (value?.action !== 'hot' || result === null || typeof result !== 'object')
    throw panelError('unavailable', 'the hot-zone compact returned no report', 503)
  return {
    status: 'compacted',
    moved: count(result.moved),
    folded: count(result.folded),
    reclaimed: count(result.reclaimed),
    used: count(result.used),
    capacity: count(result.capacity),
    // An older host's compact report may omit the trigger; 0 is the honest
    // absence the client renders as "no number to compare against".
    trigger: count(result.trigger),
  }
}

/**
 * Publish the digest once and report the owned note's outcome.
 *
 * @param {object} input - the mutation inputs.
 * @returns {Promise<object>} `{status, path, id, charCount, txId, window}`.
 */
async function mutateDigest({ args, services, exec }) {
  const value = await services.admin(
    { action: 'digest', days: args.days, operation: 'refresh' },
    undefined,
    exec,
  )
  const result = value?.result
  const publication = result?.publication
  if (value?.action !== 'digest' || publication === null || typeof publication !== 'object')
    throw panelError('digest-unavailable', 'the digest writer returned no publication', 503)
  return {
    status: typeof publication.status === 'string' ? publication.status : 'unknown',
    path: publication.path ?? null,
    id: publication.id ?? null,
    charCount: count(publication.charCount),
    txId: publication.txId ?? null,
    window: result.window ?? null,
  }
}

// ---------------------------------------------------------------------------
// Small shared rules
// ---------------------------------------------------------------------------

/** Assert the injected service set can answer both halves of an operation. */
function assertServices(services, caller) {
  if (services === null || typeof services !== 'object' || typeof services.admin !== 'function')
    throw new RangeError(caller + ' requires the memory services (`services.admin`)')
}

/** The project a mutation is bound to, or the same coded refusal the route uses. */
function requireProjectId(binding) {
  if (
    binding === null ||
    typeof binding !== 'object' ||
    binding.kind !== 'bound' ||
    typeof binding.projectId !== 'string' ||
    binding.projectId === ''
  )
    throw panelError('unbound', 'a confirmed panel operation needs a bound project', 409)
  return binding.projectId
}

/** A project label for the fact list, stable across missing display names. */
function projectLabel(binding) {
  if (typeof binding.displayName === 'string' && binding.displayName !== '')
    return binding.displayName
  if (typeof binding.slug === 'string' && binding.slug !== '') return binding.slug
  return binding.projectId
}

/** The day-granular identity the digest fingerprint uses. */
function dayOf(today, fallback) {
  if (typeof today === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(today)) return today
  if (typeof fallback === 'string' && fallback.length >= 10) return fallback.slice(0, 10)
  return null
}

/** A finite counter, or zero: the service may omit a field on an older shape. */
function count(value) {
  return Number.isFinite(value) ? value : 0
}

/** One fact-safe clip: no source note text, one line, bounded length. */
function clip(value) {
  if (typeof value !== 'string' || value.trim() === '') return null
  const text = value.trim().replace(/\s+/gu, ' ')
  const points = [...text]
  if (points.length <= MAX_FACT_CHARS) return text
  return points.slice(0, MAX_FACT_CHARS).join('') + '…'
}
