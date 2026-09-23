// Capture of completed root turns (Task 14).
//
// The design's §10.1 pipeline starts here: a `turn/end(completed)` on a root
// session is projected through a **whitelist** into a bounded, auditable job and
// fsynced into the 0600 pending queue. Two facts from `docs/p0-compatibility.md`
// shape the whole module:
//
//   * **`session/flush` is a per-request checkpoint, not a turn-end signal.** It
//     fires before and inside a turn, so "a flush arrived" never means "the turn
//     ended". The only way to find an unprocessed completed turn is to scan the
//     committed log for a `turn/end` — which is exactly what `flush()` does,
//     because P0 also proved the flush barrier *can* see committed turn ends in
//     a live process.
//   * **The durable forms are structured.** `turn/end.data.reason` is
//     `{kind:'completed'|'aborted'|'error'|…}` (the P0 probe normalised it to a
//     string), `request/context` carries the route, and `assistant/message`
//     content is a part array. Every reader here accepts the structured shape
//     and the probe's normalised string, and refuses anything else.
//
// What may enter `safeInput`, precisely:
//
//   * a `user/message` whose `source.kind === 'user'` — a real user turn. The
//     plugin-injected context messages the host also commits as `user/message`
//     (`source.kind` `plugin`, `skill-catalog`, `tool`, …) never enter;
//   * the **last** `assistant/message` in the turn whose content contains no
//     `tool-call` part. A pre-tool draft is in the same message as its tool
//     call, so "last tool-call-free text" is the post-tool final answer and the
//     draft is excluded by construction;
//   * a `tool/result`'s name and success flag only. The result body is raw tool
//     output and is never copied;
//   * nothing else. Reasoning/thinking parts, `assistant/attempt`, system
//     messages, request headers, plugin injections and child sessions are all
//     outside the projection.
//
// A deterministic credential scrub guards every surviving message: a hit skips
// that whole message and increments the job's `credentialSkips`, because a
// conversation can quote a secret that no configuration read would have
// revealed. The scrub is a known-pattern best effort, never a claim of
// completeness (§10.1).
//
// `createCapture` is the lifecycle seam the hooks use. Its `sessionEvent` is
// deliberately short — a synchronous eligibility check plus an in-memory claim,
// then a tracked background write — because `session/event` is a committed,
// fire-and-forget notification. `flush` may await real work because
// `session/flush` is an awaited barrier; `disposed` only nudges outstanding
// writes to disk and never reaches for a model.
//
// Two cross-restart invariants live here, and both are about not doing work
// twice:
//
//   * **A durable floor, not the pending files, decides what is finished.** A
//     completed job is deleted (spec §10.1), so after a restart the queue alone
//     cannot say whether a committed turn was already handed off — the back-fill
//     would re-enqueue every finished turn of the session. `enqueueTurn` records
//     each job's seq range in the queue root's `processed/` record (job first,
//     floor second), startup recovery reconciles the floor with every job still
//     on disk, and `flush` consults it. The floor is a *set of ranges*, not one
//     high-water mark, so a capture that failed transiently is never masked by a
//     later turn that advanced past it.
//   * **Read → decide → write is serialized per queue, and the flush back-fill
//     hands its turns over one at a time.** Two interleaved captures would each
//     read the pre-merge queue and both create a job, so the 90-second
//     coalescing rule would silently fail exactly when several turns complete
//     together.
import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'

import {
  PENDING_SCHEMA,
  isProcessed,
  readPendingJobs,
  readProcessedRecords,
  recordProcessedRange,
  withQueueLock,
  writeJobAtomic,
} from './pending.js'
import { isUuidV4 } from './pointer.js'

/** `distill.maxInputChars`' own default, mirrored for the capture path. */
export const DEFAULT_MAX_INPUT_CHARS = 24000
/** `captureIdleMs`' own default: the debounce/coalescing window. */
export const DEFAULT_CAPTURE_IDLE_MS = 90000

/** States in which a job has not yet been claimed by the distillation worker. */
const COALESCIBLE_STATES = new Set(['pending', 'deferred'])

/**
 * The deterministic credential patterns the scrub must cover (§10.1).
 *
 * Every pattern is anchored on a real format rather than a heuristic, and every
 * one is stateless (`no /g`), so a shared RegExp object cannot carry
 * `lastIndex` between messages.
 */
const CREDENTIAL_PATTERNS = Object.freeze([
  // AWS access key id.
  /AKIA[0-9A-Z]{16}/,
  // GitHub tokens: classic, OAuth, user, server, refresh.
  /gh[pousr]_[A-Za-z0-9_]{20,}/,
  // A fine-grained GitHub personal access token.
  /github_pat_[A-Za-z0-9_]{20,}/,
  // A PEM private-key block, whatever its algorithm or extra qualifier.
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/,
  // An Authorization header value.
  /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/,
])

/** Whether the turn ended successfully. Accepts the structured and probe forms. */
export function isCompletedTurnEnd(event) {
  if (event === null || typeof event !== 'object' || event.type !== 'turn/end') return false
  const reason = event.data?.reason
  if (reason === 'completed') return true
  return reason !== null && typeof reason === 'object' && reason.kind === 'completed'
}

/**
 * Whether this is a root session: no parent session and not a subagent.
 *
 * A session whose header cannot be read is refused rather than assumed to be a
 * root — capture must never happen on a turn this code cannot classify.
 */
export function isRootSession(session) {
  const header = session?.header
  if (header === null || typeof header !== 'object') return false
  if (typeof header.parentSession === 'string' && header.parentSession !== '') return false
  if (header.origin === 'subagent') return false
  return true
}

/** Whether a message body contains a recognisable credential. */
export function containsCredential(text) {
  if (typeof text !== 'string' || text === '') return false
  return CREDENTIAL_PATTERNS.some((pattern) => pattern.test(text))
}

/**
 * Capture one completed turn into the durable queue.
 *
 * Returns `null` for anything that is not a completed, real-user root turn, whose
 * projection is empty after scrubbing, or whose seq range the durable floor (or
 * an existing open job) already covers. Returns the persisted job when it
 * created one or extended an open one; a repeated notification and the flush
 * back-fill for the same turn is therefore one job, not two.
 *
 * @param {object} options - the capture input.
 * @param {object} options.session - the live session (its committed log is the source).
 * @param {object} options.event - the `turn/end` event that closed the turn.
 * @param {object} options.binding - the resolved `kind:'bound'` binding.
 * @param {string} options.queueRoot - absolute queue directory.
 * @param {object} [options.config] - the plugin config (`distill.maxInputChars`, `captureIdleMs`).
 * @param {Function|number} [options.now] - clock, for tests.
 * @param {Function} [options.beforeRename] - crash-injection seam, forwarded to the queue.
 * @returns {Promise<object|null>} the PendingJob, or `null` when nothing was captured.
 */
export async function enqueueTurn({ session, event, binding, queueRoot, config, now = Date.now, beforeRename } = {}) {
  if (!isCompletedTurnEnd(event)) return null
  if (!isRootSession(session)) return null
  const sessionId = sessionIdOf(session)
  if (sessionId === null) return null
  const projectId = boundProjectId(binding)
  if (projectId === null) return null
  if (typeof queueRoot !== 'string' || !queueRoot.trim() || !isAbsolute(queueRoot)) {
    throw new RangeError('queueRoot must be an absolute, non-blank path')
  }
  const endSeq = Number.isSafeInteger(event.seq) ? event.seq : null
  if (endSeq === null) return null
  const turn = Number.isSafeInteger(event.data?.turn) ? event.data.turn : null
  const maxChars = maxInputCharsOf(config)
  const idleMs = idleMsOf(config)
  const at = typeof now === 'function' ? Number(now()) : Number(now)
  const nowMs = Number.isFinite(at) ? at : Date.now()
  const nowIso = new Date(nowMs).toISOString()
  const fromSeq = turnBoundary(session, endSeq, turn)

  // Read → decide → write is one critical section per queue. Two interleaved
  // captures would each read the pre-merge queue, miss the debounce merge, and
  // silently produce two jobs where the design requires one.
  return withQueueLock(queueRoot, async () => {
    const own = projectTurn(session, { fromSeq, toSeq: endSeq, sessionId, projectId, turn, maxChars })
    if (own.userMessages === 0) return null
    if (own.segments.length === 0) return null

    const { jobs } = await readPendingJobs(queueRoot)
    const { records } = await readProcessedRecords(queueRoot)
    const processed = records.get(sessionId) ?? null
    // The durable floor: this turn's work was already enqueued once, even if the
    // job file has since been deleted on completion.
    if (isProcessed(processed, endSeq)) return null

    const open = jobs.filter((job) => job.sessionId === sessionId && job.projectId === projectId)
    const covering = open.find((job) => job.fromSeq <= fromSeq && job.toSeq >= endSeq)
    if (covering !== undefined) {
      // Converge the floor onto a job that predates it (for example one written
      // by an older build), so a later deletion cannot lose the range.
      await recordProcessedRange(queueRoot, {
        sessionId,
        fromSeq: covering.fromSeq,
        toSeq: covering.toSeq,
        jobId: covering.jobId,
        at: nowIso,
      })
      return covering
    }

    const route = routeOf(session)
    const coalescable = pickCoalescable(open, nowMs, idleMs)
    const base = coalescable === undefined
      ? {
          jobId: makeJobId({ projectId, sessionId, fromSeq, toSeq: endSeq }),
          fromSeq,
          toSeq: endSeq,
          createdAt: nowIso,
        }
      : {
          jobId: coalescable.jobId,
          fromSeq: Math.min(coalescable.fromSeq, fromSeq),
          toSeq: Math.max(coalescable.toSeq, endSeq),
          createdAt: coalescable.createdAt,
        }

    // A merged range is re-projected from the committed log rather than
    // concatenated from two stored strings, so the stored whitelist and the
    // stored text can never disagree about which seqs they cover.
    const projection = base.fromSeq === fromSeq && base.toSeq === endSeq
      ? own
      : projectTurn(session, { ...base, sessionId, projectId, turn, maxChars })

    const job = {
      schema: PENDING_SCHEMA,
      jobId: base.jobId,
      sessionId,
      projectId,
      fromSeq: base.fromSeq,
      toSeq: base.toSeq,
      state: route === null ? 'deferred' : 'pending',
      route: route ?? null,
      allowedEvents: projection.allowed,
      safeInput: projection.safeInput.text,
      credentialSkips: projection.credentialSkips,
      truncated: projection.safeInput.truncated,
      omitted: projection.safeInput.omitted,
      attempts: 0,
      output: null,
      createdAt: base.createdAt,
      updatedAt: nowIso,
    }
    if (route === null) job.deferredReason = 'no-route'

    // Job first, floor second: a crash between the two leaves work that the
    // queue still owns, never a floor that claims work nothing wrote.
    await writeJobAtomic(queueRoot, job, { beforeRename })
    await recordProcessedRange(queueRoot, {
      sessionId,
      fromSeq: job.fromSeq,
      toSeq: job.toSeq,
      jobId: job.jobId,
      at: nowIso,
    })
    return job
  })
}

/**
 * Queue recovery: read every committed job of a queue and reconcile the
 * processed floor with it.
 *
 * Runs at plugin startup, before any new capture. It never rejects: an
 * unreadable queue is reported and treated as empty, because a broken queue
 * must not strand the fiber that owns the six tools and the recall injection.
 *
 * Reconciliation is what closes the window between "the job file is durable"
 * and "the floor is durable": a job present at startup is recorded in the floor
 * **before** Task 16's worker can apply and delete it, so a restart can never
 * re-enqueue work whose job was already handed off.
 *
 * @param {{ queueRoot?: string, warn?: Function }} [options] - the queue and a log sink.
 * @returns {Promise<{jobs: object[], recovered: number, invalid: object[]}>} the recovered jobs.
 */
export async function recoverPending({ queueRoot, warn } = {}) {
  if (typeof queueRoot !== 'string' || !queueRoot.trim() || !isAbsolute(queueRoot)) {
    return { jobs: [], recovered: 0, invalid: [] }
  }
  let jobs = []
  const invalid = []
  try {
    const result = await readPendingJobs(queueRoot)
    jobs = result.jobs
    invalid.push(...result.invalid)
  } catch (error) {
    warnLine(warn, `obsidian-mem: pending recovery could not read ${queueRoot}: ${describeError(error)}`)
    return { jobs: [], recovered: 0, invalid: [{ file: queueRoot, reason: error?.code ?? 'queue-unreadable' }] }
  }
  try {
    const processed = await readProcessedRecords(queueRoot)
    invalid.push(...processed.invalid)
    for (const job of jobs) {
      await recordProcessedRange(queueRoot, {
        sessionId: job.sessionId,
        fromSeq: job.fromSeq,
        toSeq: job.toSeq,
        jobId: job.jobId,
      })
    }
  } catch (error) {
    warnLine(warn, `obsidian-mem: pending floor reconciliation failed: ${describeError(error)}`)
  }
  if (invalid.length > 0) {
    warnLine(
      warn,
      `obsidian-mem: ${invalid.length} pending file(s) could not be read and were skipped: ${invalid
        .map((entry) => `${entry.file} (${entry.reason})`)
        .join(', ')}`,
    )
  }
  return { jobs, recovered: jobs.length, invalid }
}

/**
 * The lifecycle seam the hooks drive.
 *
 * @param {object} options - the capture wiring.
 * @param {string} options.queueRoot - absolute queue directory (never derived here).
 * @param {object} [options.config] - the plugin config.
 * @param {Function} [options.resolveBinding] - cwd → a `kind:'bound'` binding.
 * @param {Function} [options.warn] - one-line log sink for best-effort failures.
 * @param {Function|number} [options.now] - clock, for tests.
 * @returns {object} the capture surface.
 * @throws {RangeError} when the queue root is not absolute, so a wiring mistake
 *   fails at registration instead of writing next to the process cwd.
 */
export function createCapture({ queueRoot, config, resolveBinding, warn, now } = {}) {
  if (typeof queueRoot !== 'string' || !queueRoot.trim() || !isAbsolute(queueRoot)) {
    throw new RangeError('createCapture needs an absolute queueRoot')
  }
  /** Jobs known to this process, by id (disk-loaded and freshly captured). */
  const known = new Map()
  /** Turn-end seqs this process already claimed, per session. */
  const claimed = new Map()
  /** Outstanding capture writes, so `disposed`/`settle` can wait for the fsync. */
  const inflight = new Set()
  let recovery = null

  function recover() {
    if (recovery === null) {
      recovery = recoverPending({ queueRoot, warn })
        .then((result) => {
          for (const job of result.jobs) known.set(job.jobId, job)
          return result
        })
        .catch((error) => {
          warnLine(warn, `obsidian-mem: pending recovery failed: ${describeError(error)}`)
          return { jobs: [], recovered: 0, invalid: [] }
        })
    }
    return recovery
  }

  function track(promise) {
    const tracked = Promise.resolve(promise)
      .catch((error) => {
        warnLine(warn, `obsidian-mem: capturing a completed turn failed: ${describeError(error)}`)
        return null
      })
      .finally(() => inflight.delete(tracked))
    inflight.add(tracked)
    return tracked
  }

  async function captureTurn(session, event) {
    // Recovery is the start of the lifecycle: no new capture may run before the
    // queue this process is about to extend has been read.
    await recover()
    // A refusal (unbound repository, cloud-managed vault, …) is a stable answer;
    // anything that throws is transient and releases the claim so the next
    // flush retries rather than dropping the turn.
    const resolved = await resolveBound(resolveBinding, session)
    if (resolved === null) return { status: 'skipped' }
    const job = await enqueueTurn({ session, event, binding: resolved, queueRoot, config, now })
    if (job === null) return { status: 'skipped' }
    known.set(job.jobId, job)
    return { status: 'captured', job }
  }

  /** Claim one turn-end seq and start its tracked capture write. */
  function claimCapture(claims, session, event) {
    const seq = event.seq
    claims.add(seq)
    return track(
      captureTurn(session, event).then(
        () => null,
        (error) => {
          claims.delete(seq)
          throw error
        },
      ),
    )
  }

  /**
   * The `session/event` listener body: short, synchronous, fire-and-forget.
   */
  function sessionEvent(session, event) {
    if (!isCompletedTurnEnd(event) || !isRootSession(session)) return
    const id = sessionIdOf(session)
    if (id === null) return
    const seq = event.seq
    if (!Number.isSafeInteger(seq)) return
    const claims = claimsOf(claimed, id)
    if (claims.has(seq)) return
    claimCapture(claims, session, event)
  }

  /**
   * The `session/flush` barrier body: find any committed completed turn this
   * process has not queued, and queue it.
   *
   * Never a turn-end signal by itself — the scan is the signal. Two floors keep
   * the scan from redoing finished work: the durable processed record (which
   * outlives a job deleted on completion) and the jobs still known to this
   * process.
   */
  async function flush(session) {
    if (!isRootSession(session)) return
    const id = sessionIdOf(session)
    if (id === null) return
    await recover()
    const claims = claimsOf(claimed, id)
    const { records } = await readProcessedRecords(queueRoot)
    const processed = records.get(id) ?? null

    // Collect synchronously (so a concurrent notification cannot claim the same
    // seq), then hand the captures over ONE AT A TIME: the debounce rule merges
    // ranges that are written in sequence, and concurrent captures would each
    // read the same pre-merge queue.
    const targets = []
    for (const event of eventsOf(session)) {
      if (!isCompletedTurnEnd(event)) continue
      const seq = event.seq
      if (!Number.isSafeInteger(seq) || claims.has(seq)) continue
      if (isCovered(known, processed, id, seq)) continue
      claims.add(seq)
      targets.push(event)
    }
    for (const event of targets) await claimCapture(claims, session, event)
  }

  /**
   * The `agent/disposed` body: nudge outstanding writes to disk, nothing else.
   *
   * There is no model call anywhere on this path (ruling: disposal must not
   * wait on one); the only thing awaited is the queue's own `fsync`.
   */
  async function disposed(target) {
    const session = target !== null && typeof target === 'object' && target.session !== undefined ? target.session : target
    const id = sessionIdOf(session)
    if (id !== null) claimed.delete(id)
    await settle()
  }

  /** Await every outstanding capture write, bounded by progress. */
  async function settle() {
    await recover()
    let guard = 0
    while (inflight.size > 0 && guard < 1000) {
      guard += 1
      await Promise.allSettled([...inflight])
    }
  }

  return {
    recover,
    sessionEvent,
    flush,
    disposed,
    settle,
    /** The jobs this process knows about (recovered + captured). */
    knownJobs: () => [...known.values()],
  }
}

// ---------------------------------------------------------------------------
// The projection
// ---------------------------------------------------------------------------

/**
 * Project one committed seq range through the whitelist.
 *
 * @param {object} session - the session whose log is read.
 * @param {object} range - `{fromSeq,toSeq,sessionId,projectId,turn,maxChars}`.
 * @returns {object} `{allowed, segments, safeInput, credentialSkips, userMessages}`.
 */
function projectTurn(session, range) {
  const { fromSeq, toSeq, sessionId, projectId, turn, maxChars } = range
  // The projection is restricted to COMPLETED turn windows. A coalesced range
  // can span more than one turn, and an aborted/errored turn between two
  // completed ones must not have its user message absorbed just because it sits
  // inside the merged seq range.
  const events = completedTurnEvents(
    eventsOf(session, fromSeq, toSeq + 1).filter(
      (event) => Number.isSafeInteger(event?.seq) && event.seq >= fromSeq && event.seq <= toSeq,
    ),
  )
  const allowed = []
  const segments = []
  let credentialSkips = 0
  let userMessages = 0

  // The final answer is the LAST tool-call-free assistant message in the turn.
  // It is located before the ordered pass so a single pass can keep
  // `allowedEvents` in seq order.
  let finalSeq = null
  for (const event of events) {
    if (event.type !== 'assistant/message') continue
    const content = event.data?.message?.content
    if (hasToolCall(content)) continue
    if (textOfContent(content) === '') continue
    finalSeq = event.seq
  }

  const toolNames = new Map()
  for (const event of events) {
    if (event.type === 'tool/call' && typeof event.data?.callId === 'string') {
      toolNames.set(event.data.callId, event.data.name)
    }
  }

  for (const event of events) {
    const seq = event.seq
    if (event.type === 'user/message') {
      // Only a real user message. The host commits plugin/skill/tool context as
      // `user/message` too, and none of it may enter the snapshot.
      if (event.data?.source?.kind !== 'user') continue
      const body = textOfContent(event.data?.content)
      if (body === '') continue
      userMessages += 1
      if (containsCredential(body)) {
        credentialSkips += 1
        continue
      }
      allowed.push({ kind: 'user', seq, source: 'user' })
      segments.push({ kind: 'user', seq, header: `--- user (seq ${seq}) ---`, text: body })
      continue
    }
    if (event.type === 'assistant/message' && seq === finalSeq) {
      const body = textOfContent(event.data?.message?.content)
      if (containsCredential(body)) {
        credentialSkips += 1
        continue
      }
      allowed.push({ kind: 'assistant-final', seq })
      segments.push({ kind: 'assistant-final', seq, header: `--- assistant final (seq ${seq}) ---`, text: body })
      continue
    }
    if (event.type === 'tool/result') {
      const part = toolResultPart(event)
      if (part === null) continue
      const callId = typeof part.toolCallId === 'string' ? part.toolCallId : event.data?.message?.source?.callId
      const name = typeof callId === 'string' ? toolNames.get(callId) ?? null : null
      const ok = part.isError !== true
      // Name and outcome only: the result body is raw tool output and is never
      // copied into the snapshot.
      allowed.push({ kind: 'tool', seq, name, ok })
      segments.push({ kind: 'tool', seq, header: `--- tool ${name ?? 'unknown'} ${ok ? 'ok' : 'failed'} (seq ${seq}) ---`, text: '' })
    }
  }

  return {
    allowed,
    segments,
    credentialSkips,
    userMessages,
    safeInput: buildSafeInput({ sessionId, projectId, turn, fromSeq, toSeq, segments, maxChars }),
  }
}

/**
 * Render the bounded model-facing text from the whitelisted segments.
 *
 * The budget is spent newest-first — "超限按最近完成的回合裁剪" — so a coalesced
 * job always keeps its most recent evidence and records the seqs it dropped.
 * A final hard clamp makes the bound unconditional even for one oversized
 * message.
 *
 * @param {object} input - `{sessionId,projectId,turn,fromSeq,toSeq,segments,maxChars}`.
 * @returns {{text: string, truncated: boolean, omitted: object|null}} the rendered value.
 */
function buildSafeInput({ sessionId, projectId, turn, fromSeq, toSeq, segments, maxChars }) {
  const preamble = `[obsidian-mem pending] session=${sessionId} project=${projectId} turn=${turn ?? '?'} seq ${fromSeq}-${toSeq}`
  const budget = Number.isSafeInteger(maxChars) && maxChars > 0 ? maxChars : DEFAULT_MAX_INPUT_CHARS
  const blocks = segments.map((segment) => ({ seq: segment.seq, text: `${segment.header}\n${segment.text}`.trimEnd() }))
  const keep = []
  const omittedSeqs = []
  let used = codePointLength(preamble)

  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const cost = codePointLength(blocks[index].text) + 1
    if (used + cost <= budget) {
      keep.push(index)
      used += cost
      continue
    }
    omittedSeqs.push(blocks[index].seq)
  }
  // Nothing fit: still hand the model the newest evidence, clamped, instead of
  // an empty job that claims completeness.
  if (keep.length === 0 && blocks.length > 0) {
    const newest = blocks.length - 1
    const room = budget - codePointLength(preamble) - 1
    if (room > 1) {
      keep.push(newest)
      const at = omittedSeqs.indexOf(blocks[newest].seq)
      if (at >= 0) omittedSeqs.splice(at, 1)
    }
  }
  keep.sort((left, right) => left - right)
  const body = keep.map((index) => blocks[index].text).join('\n')
  const assembled = body === '' ? preamble : `${preamble}\n${body}`
  const text = clampCodePoints(assembled, budget)
  const sorted = [...omittedSeqs].sort((left, right) => left - right)
  return {
    text,
    truncated: sorted.length > 0 || codePointLength(assembled) > budget,
    omitted: sorted.length === 0 ? null : { seqs: sorted, fromSeq: sorted[0], toSeq: sorted[sorted.length - 1] },
  }
}

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

/** The session id a session-shaped value carries, or `null`. */
function sessionIdOf(session) {
  const id = session?.header?.id ?? session?.id
  return typeof id === 'string' && id !== '' ? id : null
}

/** The cwd a session-shaped value carries, mirroring `lib/hooks.js`. */
function cwdOf(session) {
  const cwd = session?.header?.cwd
  return typeof cwd === 'string' && cwd.trim() !== '' ? cwd : process.cwd()
}

/** The committed events of a session, optionally a half-open range. */
function eventsOf(session, from, to) {
  if (session === null || typeof session !== 'object') return []
  const snapshot = typeof session.snapshotEvents === 'function' ? session.snapshotEvents(from, to) : null
  if (Array.isArray(snapshot)) return snapshot
  return Array.isArray(session.events) ? session.events : []
}

/** The `turn/start` seq that opened the turn which `endSeq` closed. */
function turnBoundary(session, endSeq, turn) {
  let fromSeq = 0
  for (const event of eventsOf(session, 0, endSeq + 1)) {
    if (event?.type !== 'turn/start') continue
    if (!Number.isSafeInteger(event.seq) || event.seq > endSeq) continue
    if (turn !== null && event.data?.turn !== turn) continue
    fromSeq = event.seq
  }
  return fromSeq
}

/** The concatenated `text` parts of a message content array. */
function textOfContent(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const part of content) {
    if (part !== null && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string') {
      parts.push(part.text)
    }
  }
  return parts.join('\n').trim()
}

/** Whether a message content array carries a tool call. */
function hasToolCall(content) {
  return Array.isArray(content) && content.some((part) => part !== null && typeof part === 'object' && part.type === 'tool-call')
}

/**
 * Restrict a raw event slice to the events of its completed turns.
 *
 * A single turn's `[turn/start, turn/end]` slice contains nothing else, but a
 * **coalesced** range can span several turns — including an aborted or errored
 * one that happens to sit between two completed ones. Without this filter the
 * merged projection would absorb the aborted turn's user message, which
 * constraint 1 forbids. Every event that carries a `turn` must match its
 * window; a `user/message` (which may carry none) is placed by seq position.
 *
 * @param {object[]} events - the candidate events, already sliced to the range.
 * @returns {object[]} the subset inside a completed turn window.
 */
function completedTurnEvents(events) {
  const starts = new Map()
  const windows = []
  for (const event of events) {
    if (event.type === 'turn/start' && Number.isSafeInteger(event.data?.turn)) {
      starts.set(event.data.turn, event.seq)
      continue
    }
    if (!isCompletedTurnEnd(event) || !Number.isSafeInteger(event.data?.turn)) continue
    // Without a `turn/start` this event cannot be attributed to a turn: anchor
    // the window on the turn end itself rather than on seq 0, which would widen
    // it over earlier turns (and admit their turn-field-less user messages).
    const start = starts.has(event.data.turn) ? starts.get(event.data.turn) : event.seq
    windows.push({ turn: event.data.turn, start: Math.min(start, event.seq), end: event.seq })
  }
  return events.filter((event) => {
    const turn = event.data?.turn
    return windows.some(
      (window) =>
        event.seq >= window.start &&
        event.seq <= window.end &&
        (!Number.isSafeInteger(turn) || turn === window.turn),
    )
  })
}

/** The `tool-result` part of a `tool/result` event, or `null`. */
function toolResultPart(event) {
  const content = event.data?.message?.content
  if (!Array.isArray(content)) return null
  const part = content.find((candidate) => candidate !== null && typeof candidate === 'object' && candidate.type === 'tool-result')
  return part ?? null
}

/** The last recorded route, or `null` when the session has none. */
function routeOf(session) {
  if (session === null || typeof session !== 'object' || typeof session.requestContext !== 'function') return null
  let context
  try {
    context = session.requestContext()
  } catch {
    return null
  }
  const provider = typeof context?.provider === 'string' ? context.provider.trim() : ''
  const model = typeof context?.model === 'string' ? context.model.trim() : ''
  return provider !== '' && model !== '' ? { provider, model } : null
}

/** The UUIDv4 project id of a `kind:'bound'` binding, or `null`. */
function boundProjectId(binding) {
  if (binding === null || typeof binding !== 'object' || Array.isArray(binding)) return null
  if (binding.kind !== undefined && binding.kind !== 'bound') return null
  return isUuidV4(binding.projectId) ? binding.projectId : null
}

/** Resolve the session cwd to a bound binding, or `null` for a refusal.
 *
 * A rejection is deliberately NOT caught here: the caller distinguishes a
 * stable refusal (no capture, keep the claim) from a transient failure (release
 * the claim so the next flush retries).
 */
async function resolveBound(resolveBinding, session) {
  if (typeof resolveBinding !== 'function') return null
  const resolution = await resolveBinding(cwdOf(session))
  return resolution !== null && typeof resolution === 'object' && resolution.kind === 'bound' ? resolution : null
}

// ---------------------------------------------------------------------------
// The queue policy
// ---------------------------------------------------------------------------

/**
 * The open job a new turn should extend: same session/project, not yet claimed
 * by the worker, and touched within the idle window.
 *
 * The most recently ended job wins, so a session that somehow accumulated more
 * than one open job still extends the newest one.
 */
function pickCoalescable(open, nowMs, idleMs) {
  let best
  for (const job of open) {
    if (!COALESCIBLE_STATES.has(job.state)) continue
    const updated = Date.parse(job.updatedAt)
    if (!Number.isFinite(updated) || nowMs - updated > idleMs) continue
    if (best === undefined || job.toSeq > best.toSeq) best = job
  }
  return best
}

/** Whether a turn-end seq is already covered by the floor or a known job. */
function isCovered(known, processed, sessionId, seq) {
  if (isProcessed(processed, seq)) return true
  for (const job of known.values()) {
    if (job.sessionId !== sessionId) continue
    if (job.fromSeq <= seq && job.toSeq >= seq) return true
  }
  return false
}

/** The deterministic, filesystem-safe id of a capture range. */
function makeJobId({ projectId, sessionId, fromSeq, toSeq }) {
  const digest = createHash('sha256').update(`${projectId}\n${sessionId}\n${fromSeq}\n${toSeq}`, 'utf8').digest('hex')
  return `job-${digest.slice(0, 32)}`
}

/** The effective `distill.maxInputChars`. */
function maxInputCharsOf(config) {
  const raw = config?.distill?.maxInputChars
  return Number.isSafeInteger(raw) && raw > 0 ? raw : DEFAULT_MAX_INPUT_CHARS
}

/** The effective `captureIdleMs`. */
function idleMsOf(config) {
  const raw = config?.captureIdleMs
  return Number.isSafeInteger(raw) && raw >= 0 ? raw : DEFAULT_CAPTURE_IDLE_MS
}

/** The per-session claimed-seq set, created on first use. */
function claimsOf(claimed, sessionId) {
  let claims = claimed.get(sessionId)
  if (claims === undefined) {
    claims = new Set()
    claimed.set(sessionId, claims)
  }
  return claims
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** The code-point length of a string (the budget unit the spec counts in). */
function codePointLength(text) {
  return [...text].length
}

/** Clamp to a code-point budget, marking the cut. */
function clampCodePoints(text, max) {
  if (max <= 0) return ''
  const points = [...text]
  if (points.length <= max) return text
  if (max === 1) return '…'
  return `${points.slice(0, max - 1).join('')}…`
}

/** Call the best-effort log sink without letting it break the caller. */
function warnLine(warn, message) {
  try {
    if (typeof warn === 'function') warn(message)
  } catch {
    /* the host log is a diagnostic sink, never a control path */
  }
}

/** One clamped, single-line description of a thrown value. */
function describeError(error) {
  if (error === null || error === undefined) return 'unknown error'
  let message
  try {
    message = typeof error?.message === 'string' && error.message !== '' ? error.message : String(error)
  } catch {
    message = 'unprintable error'
  }
  const code = typeof error?.code === 'string' && error.code !== '' ? `${error.code}: ` : ''
  return `${code}${message}`.replace(/\s+/gu, ' ').trim().slice(0, 200)
}
