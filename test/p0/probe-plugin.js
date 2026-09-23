// Discardable P0 host probe for the DSH session/agent lifecycle contract.
//
// It is never shipped with `dsh-obsidian-mem`; its only product is a JSONL
// record of *which* lifecycle events fire, in *what* order, and *what*
// `session.snapshotEvents()` can see at each notification or flush. No
// conversation text, no message bodies, no credentials are recorded.
//
// Records are appended (one JSON object per line) to the path in
// `DSH_OBSIDIAN_MEM_PROBE_RECORD`. Set `DSH_OBSIDIAN_MEM_PROBE_CANCEL=1` to
// cancel the first turn from inside the pre-step waterfall.
//
// When `DSH_OBSIDIAN_MEM_LLM_PROBE_RECORD` is set, the probe additionally
// exercises `ctx.get('llm').stream()` once from inside the first `agent/pre-step`
// waterfall — an explicit provider/model route, an empty route, caller
// cancellation through an `AbortSignal`, and a timeout signal — and appends the
// observed *field names*, chunk order, terminal outcome, and duration to that
// path. Prompt text, response text, and credentials are never recorded. The
// optional `DSH_OBSIDIAN_MEM_LLM_PROBE_PROVIDER` / `..._MODEL` variables pin the
// explicit route; otherwise the probe reads it from the live `llm` catalog.

import { appendFileSync } from 'node:fs'

/** Stable Cordis plugin name. */
export const name = 'dsh-obsidian-mem-probe'
/** The flush entry point lives on the `sessions` service. */
export const inject = ['sessions']

const RECORD_PATH = process.env.DSH_OBSIDIAN_MEM_PROBE_RECORD
const CANCEL_FIRST_TURN = process.env.DSH_OBSIDIAN_MEM_PROBE_CANCEL === '1'

/** Append one record; probing must never break the host session. */
function record(entry) {
  if (RECORD_PATH === undefined || RECORD_PATH === '') return
  try {
    appendFileSync(RECORD_PATH, `${JSON.stringify(entry)}\n`)
  } catch {
    /* a probe failure must not fail the host run */
  }
}

// --- LLM route probe -------------------------------------------------------

const LLM_RECORD_PATH = process.env.DSH_OBSIDIAN_MEM_LLM_PROBE_RECORD
/** Mirrors the design default `distill.maxOutputTokens`. */
const DISTILL_MAX_OUTPUT_TOKENS = 4000
/** Synthetic one-shot prompt; its text is never recorded. */
const PROBE_PROMPT = 'Reply with the single word OK.'
const PROBE_SYSTEM = 'Compatibility probe. Answer with one word.'

/** Append one LLM probe record; probing must never break the host session. */
function llmRecord(entry) {
  if (LLM_RECORD_PATH === undefined || LLM_RECORD_PATH === '') return
  try {
    appendFileSync(LLM_RECORD_PATH, `${JSON.stringify(entry)}\n`)
  } catch {
    /* a probe failure must not fail the host run */
  }
}

/** Strip the home directory and bound host-supplied error text. */
function sanitize(text) {
  let out = String(text ?? '')
  const home = process.env.HOME
  if (home !== undefined && home !== '') out = out.split(home).join('~')
  return out.length > 300 ? `${out.slice(0, 300)}…` : out
}

/** Detached, record-safe description of one thrown value. */
function describeError(error) {
  return {
    threwName: error?.name ?? 'Error',
    threwCode: error?.code ?? null,
    threwMessage: sanitize(error?.message),
  }
}

/** One identified, hand-built user message (branded ids are plain strings at runtime). */
function probeMessage(id) {
  return { id, role: 'user', content: [{ type: 'text', text: PROBE_PROMPT }], source: { kind: 'user' } }
}

/**
 * Consume one `stream()` result and describe it without recording content.
 *
 * @param {AsyncIterable<unknown>|Promise<unknown>} result - return value of `llm.stream()`
 * @param {object} options - case metadata and the signal to drive
 */
async function observeStream(result, options) {
  const started = Date.now()
  const entry = {
    name: 'probe/llm-case',
    case: options.case,
    provider: options.provider,
    model: options.model,
    maxTokens: options.maxTokens,
    signalKind: options.signalKind,
    timeoutMs: options.timeoutMs ?? null,
    hasAsyncIterator: false,
    hasThen: false,
    chunkTypes: [],
    textDeltaCount: 0,
    blockEndTypes: [],
    usageFields: [],
    finishKind: null,
    finishFailureCode: null,
    finishFailureMessage: null,
    finishFields: [],
    abortAfterChunk: 0,
    signalAborted: null,
    signalReasonName: null,
    threwName: null,
    threwCode: null,
    threwMessage: null,
    ms: 0,
  }
  try {
    let iterable = result
    if (result !== null && result !== undefined && typeof result.then === 'function') {
      entry.hasThen = true
      iterable = await result
    }
    entry.hasAsyncIterator = typeof iterable?.[Symbol.asyncIterator] === 'function'
    if (!entry.hasAsyncIterator) throw new TypeError('stream() result is not async-iterable')
    let abortIssued = false
    for await (const chunk of iterable) {
      const type = chunk?.type ?? 'unknown'
      entry.chunkTypes.push(type)
      if (type === 'text-delta') entry.textDeltaCount += 1
      if (type === 'block-end') entry.blockEndTypes.push(chunk.block?.type ?? 'unknown')
      if (type === 'usage') entry.usageFields = Object.keys(chunk.usage ?? {}).sort()
      if (type === 'finish') {
        entry.finishKind = chunk.reason?.kind ?? null
        entry.finishFields = Object.keys(chunk).sort()
        const failure = chunk.reason?.failure
        if (failure !== undefined && failure !== null) {
          entry.finishFailureCode = failure.code ?? null
          entry.finishFailureMessage = sanitize(failure.message)
        }
      }
      if (
        options.abortController !== undefined &&
        !abortIssued &&
        (type === 'text-delta' || entry.chunkTypes.length >= 3)
      ) {
        abortIssued = true
        entry.abortAfterChunk = entry.chunkTypes.length
        options.abortController.abort()
      }
    }
  } catch (error) {
    Object.assign(entry, describeError(error))
  }
  const signal = options.signalObject
  entry.signalAborted = signal === undefined ? null : signal.aborted
  entry.signalReasonName = signal?.reason?.name ?? null
  entry.ms = Date.now() - started
  return entry
}

/** Run the four LLM route cases once. */
async function runLlmProbe(llm) {
  llmRecord({ name: 'probe/llm-enter', hasLlm: true })

  let providers = []
  let catalogError = null
  try {
    providers = llm.listProviders().map((provider) => provider.id)
  } catch (error) {
    const described = describeError(error)
    catalogError = described.threwCode ?? described.threwName
  }
  const provider = process.env.DSH_OBSIDIAN_MEM_LLM_PROBE_PROVIDER || providers[0] || ''
  let models = []
  let modelError = null
  try {
    models = (await llm.listModels(provider)).map((model) => model.id)
  } catch (error) {
    const described = describeError(error)
    modelError = described.threwCode ?? described.threwName
  }
  const model = process.env.DSH_OBSIDIAN_MEM_LLM_PROBE_MODEL || models[0] || ''
  llmRecord({
    name: 'probe/llm-catalog',
    hasLlm: true,
    providerCount: providers.length,
    modelCount: models.length,
    provider,
    model,
    catalogError,
    modelError,
  })

  // Case 1 — an explicit provider/model route with a generous timeout signal.
  const generous = AbortSignal.timeout(60000)
  llmRecord(
    await observeStream(
      llm.stream({
        provider,
        model,
        messages: [probeMessage('p0-llm-explicit')],
        system: PROBE_SYSTEM,
        maxTokens: DISTILL_MAX_OUTPUT_TOKENS,
        signal: generous,
      }),
      {
        case: 'explicit-route',
        provider,
        model,
        maxTokens: DISTILL_MAX_OUTPUT_TOKENS,
        signalKind: 'timeout-generous',
        timeoutMs: 60000,
        signalObject: generous,
      },
    ),
  )

  // Case 2 — the empty route the design must never rely on.
  llmRecord(
    await observeStream(
      llm.stream({
        provider: '',
        model: '',
        messages: [probeMessage('p0-llm-empty')],
        system: PROBE_SYSTEM,
        maxTokens: 128,
      }),
      { case: 'empty-route', provider: '', model: '', maxTokens: 128, signalKind: 'none' },
    ),
  )

  // Case 3 — caller cancellation from inside the stream.
  const controller = new AbortController()
  llmRecord(
    await observeStream(
      llm.stream({
        provider,
        model,
        messages: [probeMessage('p0-llm-abort')],
        system: PROBE_SYSTEM,
        maxTokens: DISTILL_MAX_OUTPUT_TOKENS,
        signal: controller.signal,
      }),
      {
        case: 'abort-caller',
        provider,
        model,
        maxTokens: DISTILL_MAX_OUTPUT_TOKENS,
        signalKind: 'caller',
        abortController: controller,
        signalObject: controller.signal,
      },
    ),
  )

  // Case 4 — a timeout signal that fires before the request can complete.
  const timeout = AbortSignal.timeout(1)
  llmRecord(
    await observeStream(
      llm.stream({
        provider,
        model,
        messages: [probeMessage('p0-llm-timeout')],
        system: PROBE_SYSTEM,
        maxTokens: DISTILL_MAX_OUTPUT_TOKENS,
        signal: timeout,
      }),
      {
        case: 'timeout',
        provider,
        model,
        maxTokens: DISTILL_MAX_OUTPUT_TOKENS,
        signalKind: 'timeout',
        timeoutMs: 1,
        signalObject: timeout,
      },
    ),
  )

  llmRecord({ name: 'probe/llm-done', cases: 4 })
}

/** Deduplicated event types currently visible in the session log. */
function visibleTypes(session) {
  try {
    return [...new Set(session.snapshotEvents().map((event) => event.type))]
  } catch {
    return []
  }
}

/** Whether one exact seq is already readable through `snapshotEvents`. */
function hasSeq(session, seq) {
  try {
    return session.snapshotEvents(seq, seq + 1).length === 1
  } catch {
    return false
  }
}

export function apply(ctx) {
  const sessions = ctx.sessions
  const cancelled = new Set()
  const flushScheduled = new Set()
  let llmProbed = false

  record({
    name: 'probe/apply',
    id: 'probe',
    hasSessions: sessions !== undefined,
    hasLlm: ctx.get('llm') !== undefined,
    hasAgents: ctx.get('agents') !== undefined,
  })

  ctx.on('agent/session-start', ({ agent, source }) => {
    record({
      name: 'agent/session-start',
      id: agent.session.header.id,
      source,
      hasLlm: ctx.get('llm') !== undefined,
    })
  })

  ctx.on('session/event', (session, event) => {
    const id = session.header.id
    const entry = {
      name: 'session/event',
      id,
      seq: event.seq,
      type: event.type,
      snapshotLen: session.seq,
      snapshotHasSeq: hasSeq(session, event.seq),
    }
    const data = event.data
    if (data !== null && typeof data === 'object') {
      if (typeof data.turn === 'number') entry.turn = data.turn
      const reason = data.reason
      if (typeof reason === 'string') entry.reason = reason
      else if (reason !== null && typeof reason === 'object' && typeof reason.kind === 'string') {
        entry.reason = reason.kind
        if (reason.kind === 'aborted' && typeof reason.reason?.kind === 'string') entry.abortCause = reason.reason.kind
        if (reason.kind === 'error' && typeof reason.error?.code === 'string') entry.errorCode = reason.error.code
      }
    }
    record(entry)

    // Trigger one real flush through the documented entry point (never dispatch
    // the raw event). Deferred so it cannot reenter the append notification.
    if (event.type === 'turn/end' && !flushScheduled.has(id)) {
      flushScheduled.add(id)
      setTimeout(() => {
        record({ name: 'probe/flush-call', id })
        Promise.resolve(sessions.flush(session)).then(
          (participated) => record({ name: 'probe/flush-return', id, participated }),
          (error) => record({ name: 'probe/flush-error', id, error: String(error?.message ?? error) }),
        )
      }, 0)
    }
  })

  ctx.on('session/flush', (session) => {
    let snapshotLen = -1
    let turnEnds = []
    try {
      const snapshot = session.snapshotEvents()
      snapshotLen = snapshot.length
      turnEnds = snapshot
        .filter((event) => event.type === 'turn/end')
        .map((event) => event.data?.reason?.kind ?? 'unknown')
    } catch {
      /* evidence stays partial rather than failing the host */
    }
    record({
      name: 'session/flush',
      id: session.header.id,
      seq: session.seq,
      snapshotLen,
      turnEnds,
      completedTurnEnds: turnEnds.filter((kind) => kind === 'completed').length,
    })
  })

  ctx.on('agent/pre-step', async ({ agent, turn, step, signal }, next) => {
    const id = agent.session.header.id
    record({
      name: 'agent/pre-step/enter',
      id,
      turn,
      step,
      seqAtEnter: agent.session.seq,
      typesAtEnter: visibleTypes(agent.session),
    })
    // The loop awaits this waterfall, so every LLM case settles before the
    // session's own first request. Run it once, on the first turn only.
    if (LLM_RECORD_PATH !== undefined && LLM_RECORD_PATH !== '' && turn === 1 && !llmProbed) {
      llmProbed = true
      const llm = ctx.get('llm')
      if (llm === undefined) llmRecord({ name: 'probe/llm-enter', hasLlm: false })
      else await runLlmProbe(llm)
    }
    const decision = await next()
    record({
      name: 'agent/pre-step',
      id,
      turn,
      step,
      kind: decision.kind,
      aborted: signal.aborted,
      seqAtExit: agent.session.seq,
    })
    if (CANCEL_FIRST_TURN && turn === 1 && !cancelled.has(id)) {
      cancelled.add(id)
      record({ name: 'probe/cancel-issued', id, turn })
      agent.cancel({ kind: 'user' })
    }
    return decision
  })
}
