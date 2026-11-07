// The confirmed panel operations — a preview, then a separate confirm that performs
// exactly one write: the original three (retry-job / compact-hot / refresh-digest)
// plus the two review decisions (apply-proposal / reject-proposal, v0.4's review
// panel). Every one keeps the same shape: a preview token, a fingerprint, one write.
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
// the queue lock or the vault transaction, and a review decision runs
// `reviewCurationProposal` (claim, hash re-verification under the vault lock, then
// write), so this module never grows a second check-then-write: it asks the service
// for both the read and the write.
//
// Nothing here is a listener or a timer. The only state is the bounded in-process
// token table, and a plugin restart makes every open preview stale — which is the
// correct answer, because the sheet a human was looking at no longer exists.
import { createHash, randomBytes } from 'node:crypto'
import { homedir } from 'node:os'

import { resolveLocale } from './locale.js'
import { dialogCopy } from './panel-copy.js'

/** The confirmed operation vocabulary; the panel UI and the route both read it. */
export const PANEL_MUTATIONS = Object.freeze([
  'retry-job',
  'compact-hot',
  'refresh-digest',
  'apply-proposal',
  'reject-proposal',
])

/** How long an issued preview stays confirmable. */
export const PREVIEW_TTL_MS = 60_000

/** The per-process preview bound (spec §4: at most 128 tokens). */
export const MAX_PREVIEW_TOKENS = 128

const MAX_JOB_ID_CHARS = 200
const MAX_FACT_CHARS = 160

/**
 * The two review decisions and the proposal id shape the transport accepts.
 *
 * A proposal id is the store's own content address (64 lowercase hex characters);
 * anything else is a malformed argument, refused before a service read.
 */
const PROPOSAL_DECISIONS = Object.freeze({
  'apply-proposal': 'apply',
  'reject-proposal': 'reject',
})
const PROPOSAL_ID_PATTERN = /^[0-9a-f]{64}$/u

/**
 * The operation kinds this build can execute (frozen by lib/curation-review.js).
 *
 * Duplicated rather than imported: `panel-actions` is layer 1 and `curation-review`
 * is layer 6, so an import would invert the layer table. The list is exported and
 * pinned against `EXECUTABLE_OPERATIONS` by a test, so a store-side rename cannot
 * silently make the panel refuse a legitimate preview; the order matches the store's
 * list on purpose so the pin is an exact deep-equal. A record carrying any other kind
 * is refused at preview — the same refusal the service would answer at decision time
 * — so the sheet can never promise an effect this build cannot perform.
 */
export const EXECUTABLE_OPERATION_KINDS = Object.freeze(['create-separate', 'supersede'])

/**
 * The wire status each frozen review refusal code keeps.
 *
 * `proposal-missing` is the only 404, and it is safe on this route: the panel's POST
 * reader treats a coded 404 envelope as a data error and only a bodyless 404 as "the
 * route is not registered" (lib/memory-panel.js). Every other refusal is a conflict.
 *
 * `operation-not-executable` is a conflict, not an outage: a record whose operation
 * kind this build cannot run is the record's problem, so mapping it to `unavailable`
 * 503 would tell the reader to retry a decision that can never succeed. The panel's
 * UI falls back to its generic "action failed (code)" line for the code, which names
 * the cause, and no sheet opens over an unperformable promise.
 */
const PROPOSAL_REFUSAL_STATUS = Object.freeze({
  'proposal-missing': 404,
  'proposal-not-current': 409,
  'review-only': 409,
  'source-changed': 409,
  'review-recovery-required': 409,
  'proposal-unreadable': 409,
  'operation-not-executable': 409,
})

/**
 * The review document's bounds (design §Token / context budget).
 *
 * The Markdown is assembled host-side to fit the route's 8 KiB preview ceiling *by
 * construction*: the character caps below are the comfort limits, then the body
 * budgets are trimmed by measured UTF-8 bytes (a Chinese note body costs up to three
 * bytes a character, so the character caps alone are not a byte promise).
 */
const MAX_CANDIDATE_BODY_CHARS = 5_500
const MAX_TARGET_BODY_CHARS = 1_500
const MAX_DOCUMENT_CHARS = 24_000
/** The route's preview ceiling in UTF-8 bytes (lib/panel-route.js `CEILINGS.preview`). */
const MAX_PREVIEW_BYTES = 8 * 1024
/** A minted token is always 43 base64url characters; an expiry is a 13-digit stamp. */
const PREVIEW_TOKEN_CHARS = 43
const PREVIEW_PLACEHOLDER_MS = 9_999_999_999_999
/** Slack for the placeholder token/expiry above, so the estimate never under-counts. */
const PREVIEW_ENVELOPE_RESERVE = 32
/** How many source lines the document prints before it summarises the rest. */
const MAX_DOCUMENT_SOURCES = 8
const MAX_DOCUMENT_TITLE_CHARS = 120
const MAX_DOCUMENT_REASON_CHARS = 500
const MAX_DOCUMENT_PATH_CHARS = 240
// The panel's renderer treats every line starting with exactly this marker as a code
// fence toggle (lib/memory-panel.js renderMarkdown), so the host mirrors that rule
// when it balances an embedded candidate body.
const FENCE_MARKER = '```'
const MAX_DOCUMENT_STATUS_CHARS = 40
const MAX_DOCUMENT_STAMP_CHARS = 40

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
  if (operation === 'apply-proposal' || operation === 'reject-proposal') {
    if (keys.length !== 1 || !keys.includes('proposalId'))
      throw new RangeError(operation + ' takes exactly one argument: { proposalId }')
    const raw = args.proposalId
    if (typeof raw !== 'string' || !PROPOSAL_ID_PATTERN.test(raw))
      throw new RangeError(operation + ' proposalId must be 64 lowercase hex characters')
    return { proposalId: raw }
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
 * @throws {Error} a coded refusal (`job-*`, `hot-missing`, `digest-unavailable`,
 *   `proposal-missing`, `proposal-not-current`, `review-only`, `unavailable`).
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
      // Additive: only the two review mutations assemble a document, so an older
      // client that does not know the field simply never sees it.
      ...(built.markdown === undefined ? {} : { markdown: built.markdown }),
    },
  }
}

/**
 * Confirm one preview: revalidate its fingerprint, run its single mutation, replay on retry.
 *
 * @param {object} input - `{token, sessionId, binding, services, exec, tokens, today}`.
 * @returns {Promise<object>} `{replayed, operation, result}`.
 * @throws {Error} a coded refusal (`preview-*`, `job-*`, `hot-*`, `digest-*`, and
 *   the frozen review refusals with their own status; unknown failures are 503).
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
    const revalidated = await revalidate(entry.operation, {
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
      state: revalidated.state,
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
      // A review-only row is recorded from the same re-read the fingerprint used:
      // the confirmation's result must describe what was actually decided.
      reviewOnly: revalidated.reviewOnly,
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
  if (operation === 'refresh-digest') return digestPreview(input)
  return proposalPreview(operation, input)
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
// The review-proposal preview: one bounded Markdown document, then the decision
// ---------------------------------------------------------------------------

/**
 * The review preview: read the record, refuse a dead decision, build the sheet.
 *
 * A preview never decides anything. It reads the same detail the confirmation will
 * re-read for its fingerprint, states the facts a human is agreeing to, and
 * assembles the Markdown document that shows the candidate bytes. The one write is
 * the confirmation's `reviewDecision` call.
 *
 * @param {string} operation - `apply-proposal` or `reject-proposal`.
 * @param {object} input - the preview inputs (`args`, `services`, `copy`).
 * @returns {Promise<object>} the preview projection, including `markdown`.
 */
async function proposalPreview(operation, { args, services, binding, copy }) {
  const decision = PROPOSAL_DECISIONS[operation]
  const detail = await readReviewDetail(services, binding, args.proposalId)
  assertDecidable(detail, decision, copy)
  return buildProposalPreview(operation, decision, detail, copy)
}

/**
 * Read one proposal detail through the frozen service method.
 *
 * The service is the authority for what exists and whether the bytes can be read;
 * this helper only maps its coded refusals onto the panel's codes and refuses a host
 * that cannot answer at all (an older build gains no capability).
 *
 * @param {object} services - the memory services.
 * @param {object} binding - the bound project the frozen service contract needs.
 * @param {string} proposalId - the proposal to read.
 * @returns {Promise<object>} the detail.
 */
async function readReviewDetail(services, binding, proposalId) {
  if (typeof services?.reviewDetail !== 'function')
    throw panelError('unavailable', 'this host cannot read the review queue', 503)
  let detail
  try {
    detail = await services.reviewDetail(binding, proposalId)
  } catch (error) {
    throw proposalRefusal(error)
  }
  if (detail === null || typeof detail !== 'object')
    throw panelError(
      'proposal-missing',
      'no proposal ' + proposalId + ' exists for this project',
      404,
    )
  return detail
}

/**
 * Map a service refusal, or a thrown coded service error, onto the panel's refusal.
 *
 * A code outside the frozen table is `unavailable` 503: the panel has no honest
 * sentence for a shape it does not know, and an unknown answer must never be
 * rendered as a successful decision. The message is source-free and bounded.
 *
 * @param {{code?: string, message?: string}} error - the service's coded error value.
 * @returns {Error} the coded panel refusal to throw.
 */
function proposalRefusal(error) {
  const code = typeof error?.code === 'string' ? error.code : null
  const status = code === null ? undefined : PROPOSAL_REFUSAL_STATUS[code]
  if (status === undefined) return panelError('unavailable', 'the review queue is unavailable', 503)
  const message =
    typeof error?.message === 'string' && error.message.trim() !== ''
      ? clipText(error.message.trim(), MAX_FACT_CHARS)
      : 'the review decision was refused'
  return panelError(code, message, status)
}

/**
 * Refuse a decision the store can no longer take, before a token is issued.
 *
 * `proposal-missing` is the service's own read answer; the other two refusals are
 * preconditions this layer states with the same codes the service would answer at
 * confirmation time, so the sheet never opens over a dead button.
 *
 * @param {object} detail - the proposal detail.
 * @param {string} decision - `apply` or `reject`.
 * @param {object} copy - the resolved locale's dialog copy.
 */
function assertDecidable(detail, decision, copy) {
  if (detail.state !== 'pending')
    throw panelError(
      'proposal-not-current',
      'the proposal ' +
        String(detail.proposalId ?? '') +
        ' is ' +
        String(detail.state ?? 'unknown') +
        ', and only a pending proposal can be decided',
      409,
    )
  // A rejection is legal for any pending record: dismissing evidence changes no note,
  // and the service's reject branch never asks what the operation is.
  if (decision === 'reject') return
  // One rule for "review-only": a row with no plain operation object is evidence to
  // read, never a plan to apply. (The record's own `reviewOnly` flag is derived from
  // the same shape by the service; the operation is the authority here.)
  const view = operationOf(detail)
  if (view === null) throw panelError('review-only', copy.applyProposal.reviewOnlyNote, 409)
  // A foreign/corrupt operation kind would be refused by the service at decision time;
  // refuse it here instead, so the preview never promises an effect this build cannot
  // perform.
  if (!EXECUTABLE_OPERATION_KINDS.includes(view.kind))
    throw proposalRefusal({
      code: 'operation-not-executable',
      message:
        'the proposal carries a ' + String(view.kind) + ' operation, which this build cannot apply',
    })
}

/**
 * Build the sheet projection and fit its Markdown inside the wire ceiling.
 *
 * The facts are the short structured rows the sheet always shows; the Markdown is
 * the readable document (title, metadata, reason, candidate bytes, sources, effect,
 * footer). Only the document's variable budgets are trimmed for size — the candidate
 * body first, then the supersede target's excerpt, then the source lines — so a huge
 * candidate never costs the target's context.
 *
 * @param {string} operation - `apply-proposal` or `reject-proposal`.
 * @param {string} decision - `apply` or `reject`.
 * @param {object} detail - the proposal detail.
 * @param {object} copy - the resolved locale's dialog copy.
 * @returns {object} `{title, confirmLabel, facts, effects, warning?, markdown, state}`.
 */
function buildProposalPreview(operation, decision, detail, copy) {
  const shared = copy.proposal
  const dialog = decision === 'apply' ? copy.applyProposal : copy.rejectProposal
  const view = operationOf(detail)
  const target = targetOf(view, shared)
  // One review-only rule, the same `operationOf` one assertDecidable uses.
  const reviewOnly = view === null
  const kindLabel = shared.kindLabel(typeof detail.kind === 'string' ? detail.kind : '')
  const stateLabel =
    shared.states[String(detail.state ?? '')] ?? String(detail.state ?? shared.unknown)
  const sources = Array.isArray(detail.sources) ? detail.sources : []
  const matched = sources.filter(
    (source) => source?.matched === true && source?.missing !== true,
  ).length
  const reason = clip(detail.reason) ?? shared.unknown
  const facts = [
    { label: shared.labels.kind, value: kindLabel },
    { label: shared.labels.state, value: stateLabel },
    { label: shared.labels.reason, value: reason },
    { label: shared.labels.sources, value: shared.sourceSummary(matched, sources.length) },
  ]
  if (target !== null) facts.push({ label: shared.labels.target, value: clip(target.path) })
  const effects = proposalEffects(decision, shared, reviewOnly, view, target)
  const warning =
    decision === 'apply' && view?.kind === 'supersede' ? shared.supersedeWarning(target) : undefined
  const build = (candidateChars, targetChars, sourceLimit) => ({
    title: dialog.title,
    confirmLabel: dialog.confirmLabel,
    facts,
    effects,
    ...(warning === undefined ? {} : { warning }),
    markdown: proposalDocument({
      decision,
      detail,
      copy,
      candidateChars,
      targetChars,
      sourceLimit,
    }),
  })
  const markdown = fitProposalPreview(operation, build)
  return {
    title: dialog.title,
    confirmLabel: dialog.confirmLabel,
    facts,
    effects,
    ...(warning === undefined ? {} : { warning }),
    markdown,
    state: proposalIdentity(detail, String(detail.proposalId ?? '')),
  }
}

/**
 * Fit a preview document inside the route's byte ceiling, trimming the candidate
 * body first, then the target excerpt, then the source lines.
 *
 * Character caps alone are not a byte promise: a note body of Chinese characters
 * costs three UTF-8 bytes each, so a 5,500-character candidate can exceed 8 KiB on
 * its own. Each stage is a binary search over the largest budget whose projection
 * still fits, so the result is maximal rather than a guessed step. If even the
 * framing without bodies does not fit (a pathological source list), the whole
 * preview is still returned and the caller degrades to a source summary line.
 *
 * @param {string} operation - the wire mutation name (part of the measured envelope).
 * @param {(candidateChars: number, targetChars: number, sourceLimit: number) => object} build - the projection builder.
 * @returns {string} the fitted Markdown document.
 */
function fitProposalPreview(operation, build) {
  const fits = (projection) =>
    projection.markdown.length <= MAX_DOCUMENT_CHARS &&
    previewEnvelopeBytes(projection, operation) + PREVIEW_ENVELOPE_RESERVE <= MAX_PREVIEW_BYTES
  const largest = (attempt) => {
    let low = 0
    let high = attempt.limit
    let best = null
    while (low <= high) {
      const mid = Math.floor((low + high) / 2)
      const projection = attempt.build(mid)
      if (fits(projection)) {
        best = projection
        low = mid + 1
      } else high = mid - 1
    }
    return best
  }
  const candidate = largest({
    limit: MAX_CANDIDATE_BODY_CHARS,
    build: (chars) => build(chars, MAX_TARGET_BODY_CHARS, MAX_DOCUMENT_SOURCES),
  })
  if (candidate !== null) return candidate.markdown
  // The candidate is already empty and the preview still does not fit: the target
  // excerpt is next, exactly as the frozen trim order says.
  const target = largest({
    limit: MAX_TARGET_BODY_CHARS,
    build: (chars) => build(0, chars, MAX_DOCUMENT_SOURCES),
  })
  if (target !== null) return target.markdown
  // Finally the source lines (a very long path list is the only remaining cost).
  const sources = largest({
    limit: MAX_DOCUMENT_SOURCES,
    build: (limit) => build(0, 0, limit),
  })
  return (sources ?? build(0, 0, 0)).markdown
}

/**
 * Measure the preview answer the route will send, in UTF-8 bytes.
 *
 * The route measures `{ok:true, value:{mutation, token, expiresAt, preview}}`; the
 * token and expiry are placeholders sized at their worst case, and the reserve in
 * `fitProposalPreview` covers the couple of bytes of difference.
 *
 * @param {object} preview - the preview projection.
 * @param {string} mutation - the wire mutation name (the envelope carries it).
 * @returns {number} the estimated wire size in bytes.
 */
function previewEnvelopeBytes(preview, mutation) {
  return Buffer.byteLength(
    JSON.stringify({
      ok: true,
      value: {
        mutation,
        token: 'x'.repeat(PREVIEW_TOKEN_CHARS),
        expiresAt: PREVIEW_PLACEHOLDER_MS,
        preview,
      },
    }),
    'utf8',
  )
}

/**
 * Assemble the review document: rendered framing around the note's own bytes.
 *
 * The candidate body is embedded verbatim as Markdown, never escaped or fenced —
 * the point of the sheet is to render the note the way the vault will read it. The
 * target excerpt appears only for a supersede (the one operation that moves an
 * existing note); a rejection's effect section says plainly that nothing is written.
 *
 * @param {object} input - `{decision, detail, copy, candidateChars, targetChars, sourceLimit}`.
 * @returns {string} the Markdown document.
 */
function proposalDocument({ decision, detail, copy, candidateChars, targetChars, sourceLimit }) {
  const shared = copy.proposal
  const view = operationOf(detail)
  const target = targetOf(view, shared)
  // The one review-only rule: the operation is the authority, never the record's
  // flag (the same rule assertDecidable/buildProposalPreview use). A contradictory
  // record therefore documents what apply would actually do.
  const reviewOnly = view === null
  const sources = Array.isArray(detail.sources) ? detail.sources : []
  const matched = sources.filter(
    (source) => source?.matched === true && source?.missing !== true,
  ).length
  const title =
    typeof view?.title === 'string' && view.title.trim() !== ''
      ? clipText(view.title.trim(), MAX_DOCUMENT_TITLE_CHARS)
      : shared.fallbackTitle
  const kindLabel = shared.kindLabel(typeof detail.kind === 'string' ? detail.kind : '')
  const stateLabel =
    shared.states[String(detail.state ?? '')] ?? String(detail.state ?? shared.unknown)
  const createdAt =
    typeof detail.createdAt === 'string' && detail.createdAt !== ''
      ? clipText(detail.createdAt, MAX_DOCUMENT_STAMP_CHARS)
      : shared.unknown
  const reason =
    clipText(
      typeof detail.reason === 'string' ? detail.reason.trim().replace(/\s+/gu, ' ') : '',
      MAX_DOCUMENT_REASON_CHARS,
    ) || shared.unknown
  const lines = [
    '# ' + title,
    '',
    '> ' + shared.meta(kindLabel, stateLabel, createdAt),
    '',
    shared.reasonPrefix + reason,
  ]
  if (view !== null) {
    const candidate = clippedBody(
      view.body,
      candidateChars,
      view.bodyTruncated,
      shared.truncatedMarker,
    )
    lines.push(
      '',
      '## ' + shared.bodyHeading,
      '',
      balanceFences(trimTrailingNewlines(candidate.text)),
    )
  }
  lines.push('', '## ' + shared.sourcesHeading, '')
  if (sources.length === 0) {
    // No sources is a fact the document states: an empty section would read as a
    // rendering bug rather than as a record that names no evidence.
    lines.push(shared.noSources)
  } else if (sourceLimit === 0) {
    // A summary line is honest where a path list is not affordable: it still says
    // how much evidence there is and how much of it matches.
    lines.push(shared.sourceSummary(matched, sources.length))
  } else {
    const shown = sources.slice(0, sourceLimit)
    for (const source of shown) lines.push(sourceLine(shared, source))
    if (sources.length > shown.length) lines.push(shared.moreSources(sources.length - shown.length))
  }
  lines.push('', '## ' + shared.effectHeading, '')
  lines.push(...proposalEffects(decision, shared, reviewOnly, view, target))
  if (decision === 'apply' && view?.kind === 'supersede' && target !== null) {
    const excerpt = clippedBody(
      target.body,
      targetChars,
      view.target.bodyTruncated,
      shared.truncatedMarker,
    )
    lines.push('', shared.targetExcerptHeading)
    const excerptText = trimTrailingNewlines(excerpt.text)
    if (excerptText === '') lines.push(shared.unknown)
    else lines.push(...excerptText.split('\n').map((line) => '> ' + line))
  }
  const footer = reviewOnly
    ? shared.footer.reviewOnly
    : decision === 'apply'
      ? shared.footer.apply
      : shared.footer.reject
  lines.push('', '---', '', footer)
  return lines.join('\n')
}

/**
 * The effects a sheet promises, in the frozen decision vocabulary.
 *
 * @param {string} decision - `apply` or `reject`.
 * @param {object} shared - the locale's shared proposal copy.
 * @param {boolean} reviewOnly - whether the row is evidence with no operation.
 * @param {object|null} view - the operation view, when there is one.
 * @param {{path: string, status: string, body?: unknown}|null} target - the supersede target.
 * @returns {string[]} one to three effect lines.
 */
function proposalEffects(decision, shared, reviewOnly, view, target) {
  if (reviewOnly) return [shared.reviewOnlyEffect]
  if (decision === 'reject') return [...shared.rejectEffects]
  if (view?.kind === 'supersede') return shared.supersedeEffects(target)
  return [...shared.createEffects]
}

/**
 * The operation view of a detail, or null when the row is review-only evidence.
 *
 * @param {object} detail - the proposal detail.
 * @returns {object|null} the executable operation.
 */
function operationOf(detail) {
  const operation = detail.operation
  return operation !== null && typeof operation === 'object' && !Array.isArray(operation)
    ? operation
    : null
}

/**
 * The supersede target, reduced to the display fields the sheet may print.
 *
 * @param {object|null} view - the operation view.
 * @param {object} shared - the locale's shared proposal copy.
 * @returns {{path: string, status: string, body: unknown, bodyTruncated: boolean}|null} the target.
 */
function targetOf(view, shared) {
  const target = view?.target
  if (target === null || typeof target !== 'object' || Array.isArray(target)) return null
  return {
    path: displayPath(target.path) || shared.unknown,
    status:
      clipText(String(target.status ?? '').trim(), MAX_DOCUMENT_STATUS_CHARS) || shared.unknown,
    body: target.body,
    bodyTruncated: target.bodyTruncated === true,
  }
}

/**
 * One source line with its re-read state: a stale hash is visible, never hidden.
 *
 * @param {object} shared - the locale's shared proposal copy.
 * @param {object} source - `{path, matched, missing}` as the detail projected it.
 * @returns {string} one Markdown list item.
 */
function sourceLine(shared, source) {
  const path = displayPath(source?.path) || shared.unknown
  const matched = source?.matched === true && source?.missing !== true
  const mark = matched ? shared.matchMark : shared.missMark
  const state = matched ? shared.sourceMatch : shared.sourceMissing
  return '- ' + mark + ' ' + path + ' — ' + state
}

/**
 * A vault path as the wire may carry it: POSIX separators, home masked to `~`.
 *
 * The service answers vault-relative paths, so the mask is defensive — an absolute
 * path must never ride a wire value even if an older service hands one over.
 *
 * @param {unknown} value - the path as the service reported it.
 * @returns {string} the display path, clipped and home-masked.
 */
function displayPath(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text === '') return ''
  const home = homedir()
  const masked = text.startsWith(home) ? '~' + text.slice(home.length) : text
  return clipText(masked.replaceAll('\\', '/'), MAX_DOCUMENT_PATH_CHARS)
}

/**
 * One body clip that says it clipped: a truncated body must never look complete.
 *
 * `bodyTruncated` is the service's own flag (it bounded the body before answering),
 * so a flag-only truncation still carries the marker even when this clip keeps every
 * character it received.
 *
 * @param {unknown} value - the body.
 * @param {number} maxChars - the character budget.
 * @param {unknown} bodyTruncated - the service's truncation flag.
 * @param {string} marker - the locale's truncation marker.
 * @returns {{text: string}} the body, with the marker when it was cut or already bounded.
 */
function clippedBody(value, maxChars, bodyTruncated, marker) {
  const text = typeof value === 'string' ? value : ''
  const points = [...text]
  if (points.length > maxChars) return { text: points.slice(0, maxChars).join('') + marker }
  if (bodyTruncated === true) return { text: text + marker }
  return { text }
}

/**
 * Close one unterminated code fence in an embedded candidate body.
 *
 * The sheet's renderer closes an open fence at EOF, so an odd fence count in the
 * candidate would swallow the document's own `## 来源` / `## 影响` / footer framing
 * into a code block — the reader would be asked to approve a note while the sheet's
 * consequence lines looked like candidate content. Appending one closing fence line
 * when the count is odd restores the boundary without rewriting a single byte of the
 * note's Markdown (a balanced body is returned unchanged, which the tests pin).
 *
 * @param {string} text - the candidate body as it will be embedded.
 * @returns {string} the body, with one closing fence appended when a fence is open.
 */
function balanceFences(text) {
  const fenceLines = text.split('\n').filter((line) => line.startsWith(FENCE_MARKER))
  if (fenceLines.length % 2 === 0) return text
  return text + '\n' + FENCE_MARKER
}

/**
 * Drop trailing blank lines from an embedded body so the framing keeps exactly one
 * blank line between sections. Leading bytes and every internal newline stay
 * untouched: the note's own Markdown is never rewritten, only surrounded.
 *
 * @param {string} text - the body text.
 * @returns {string} the body without its trailing newlines.
 */
function trimTrailingNewlines(text) {
  return text.replace(/\n+$/u, '')
}

/**
 * The stable identity a review preview is bound to.
 *
 * Stored hashes only. Current-byte drift is deliberately NOT in the fingerprint: the
 * preview shows and binds the evidence the record was parked on, and an ordinary
 * source edit must not turn the sheet stale — the service's claim re-read is what
 * refuses `source-changed` 409 once the vault no longer holds the stored bytes. What
 * does move this fingerprint is the record: its state, itemKey or stored source list
 * changing between preview and confirmation (a decision landed elsewhere, a scan
 * repaired the record), which is exactly the `preview-stale` case.
 *
 * @param {object} detail - the proposal detail.
 * @param {string} proposalId - the read id (a defensive fallback).
 * @returns {{proposalId: string, state: string, itemKey: string, sources: Array<{path: string, hash: string}>}} the fingerprint state.
 */
function proposalIdentity(detail, proposalId) {
  const sources = Array.isArray(detail.sources) ? detail.sources : []
  return {
    proposalId: String(detail.proposalId ?? proposalId),
    state: String(detail.state ?? ''),
    itemKey: String(detail.itemKey ?? ''),
    sources: sources.map((source) => ({
      path: String(source?.path ?? ''),
      hash: String(source?.hash ?? ''),
    })),
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
    return { state: job === null ? { missing: true, jobId: input.args.jobId } : retryIdentity(job) }
  }
  if (operation === 'compact-hot') {
    const status = await hotState(input.services, input.exec)
    return { state: status === null ? { unavailable: true } : hotIdentity(status) }
  }
  if (operation === 'apply-proposal' || operation === 'reject-proposal')
    return proposalRevalidate(input)
  const digest = await digestState(input.services, input.exec, input.args.days)
  return {
    state:
      digest === null ? { unavailable: true } : digestIdentity(digest, input.args.days, input.day),
  }
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

/**
 * Re-read one proposal's identity for the confirmation's staleness check.
 *
 * A record deleted or unreadable between the preview and the confirmation is a
 * moved state, not a second preview refusal: the sheet on screen no longer describes
 * the store, and `preview-stale` is the honest answer (it writes nothing). Any other
 * failure — the queue itself being unavailable — propagates so the token is
 * released and the same sheet can retry.
 *
 * @param {object} input - the confirmation inputs (`args`, `services`, `binding`).
 * @returns {Promise<{state: object, reviewOnly: boolean}>} the fingerprint state and
 *   the re-read review-only fact the confirm result reports.
 */
async function proposalRevalidate({ args, services, binding }) {
  try {
    const detail = await readReviewDetail(services, binding, args.proposalId)
    return {
      state: proposalIdentity(detail, args.proposalId),
      // The same single rule the rest of the transport uses: no plain operation means
      // the row is read-only evidence, whatever a corrupt flag says.
      reviewOnly: operationOf(detail) === null,
    }
  } catch (error) {
    if (error?.code === 'proposal-missing' || error?.code === 'proposal-unreadable')
      return { state: { missing: true, proposalId: args.proposalId }, reviewOnly: false }
    throw error
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
  if (operation === 'refresh-digest') return mutateDigest(input)
  return mutateProposal(operation, input)
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

/**
 * Run the one decision a confirmed review token names.
 *
 * The service method is the single write path (`reviewCurationProposal`): it takes
 * the claim, re-verifies every source hash under the vault lock and only then writes.
 * This layer never re-derives a precondition — it maps the service's own refusal to
 * the panel's coded answer so the sheet can name why nothing was written.
 *
 * @param {string} operation - `apply-proposal` or `reject-proposal`.
 * @param {object} input - `{args, services, binding, reviewOnly}`.
 * @returns {Promise<{status: 'applied'|'rejected', proposalId: string, path: string|null, reviewOnly: boolean}>} the decision.
 */
async function mutateProposal(operation, { args, services, binding, reviewOnly }) {
  if (typeof services?.reviewDecision !== 'function')
    throw panelError('unavailable', 'this host cannot decide a review proposal', 503)
  let value
  try {
    value = await services.reviewDecision(binding, args.proposalId, PROPOSAL_DECISIONS[operation], {
      kind: 'human',
    })
  } catch (error) {
    throw proposalRefusal(error)
  }
  if (value === null || typeof value !== 'object')
    throw panelError('unavailable', 'the review decision returned no result', 503)
  if (value.status === 'refused') throw proposalRefusal(value)
  if (value.status !== 'applied' && value.status !== 'rejected')
    throw panelError('unavailable', 'the review decision returned no outcome', 503)
  // The applied decision names the note it published — a vault-relative path, clipped
  // and home-masked like every other wire path, never the receipt itself. A rejection
  // writes nothing, so it has no path; `reviewOnly` distinguishes a dismissed finding
  // from a rejected executable candidate.
  const receipt = value.receipt !== null && typeof value.receipt === 'object' ? value.receipt : null
  return {
    status: value.status,
    proposalId: args.proposalId,
    path: value.status === 'applied' ? displayPath(receipt?.path) || null : null,
    reviewOnly: reviewOnly === true,
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

/**
 * One codepoint-safe clip with an explicit ellipsis that counts inside the limit.
 *
 * Codepoints, not UTF-16 units: a preview must never cut a surrogate pair, and a
 * truncated value must never look complete.
 *
 * @param {unknown} value - the text to clip.
 * @param {number} maxChars - the maximum length, ellipsis included.
 * @returns {string} the clipped text.
 */
function clipText(value, maxChars) {
  const text = typeof value === 'string' ? value : ''
  const points = [...text]
  if (points.length <= maxChars) return text
  return points.slice(0, Math.max(0, maxChars - 1)).join('') + '…'
}
