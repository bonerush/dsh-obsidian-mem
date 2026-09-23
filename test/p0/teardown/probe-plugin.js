// Discardable Task 18b probe: where the plugin tree goes, and what actually ends
// an in-flight model call.
//
// `docs/p0-compatibility.md` §9 is the product; this file is the instrument. It
// records only labels, service presence, provider-fiber states, chunk counts,
// terminal `finish.reason.kind`/`failure.code` and durations. Prompt text,
// response text, note text and credentials are never recorded.
//
// Four questions, answered in ONE isolated run (`test/p0/run-teardown-probe.mjs`):
//
//   1. When does `ctx.get('llm'|'tools'|'sessions'|'agents')` resolve at all,
//      strictly and non-strictly, and which fiber provides each service?
//   2. Does a model call issued from a BARE timer in the live window work?
//   3. What happens to a call that is still streaming when the host disposes the
//      whole plugin tree (the queue worker's own disposer calls `abort()`)?
//   4. Does a *captured* handle survive the disposal better than a fresh
//      `ctx.get()`?
import { appendFileSync } from 'node:fs'

export const name = 'dsh-obsidian-mem-teardown-probe'

const RECORD = process.env.DSH_OBSIDIAN_MEM_TEARDOWN_RECORD
const PROVIDER = process.env.DSH_OBSIDIAN_MEM_TEARDOWN_PROVIDER ?? 'deepseek-official'
const MODEL = process.env.DSH_OBSIDIAN_MEM_TEARDOWN_MODEL ?? 'deepseek-flash'

/** `FiberState` values (cordis `src/fiber.ts`), by index. */
const STATE = ['PENDING', 'LOADING', 'ACTIVE', 'FAILED', 'DISPOSED', 'UNLOADING']
const ORIGINAL = Symbol.for('cordis.original')
const ISOLATE = Symbol.for('cordis.isolate')
const T0 = Date.now()

/** Strip the home directory and bound host-supplied text. */
function sanitize(text) {
  let out = String(text ?? '')
  const home = process.env.HOME
  if (home !== undefined && home !== '') out = out.split(home).join('~')
  return out.length > 200 ? `${out.slice(0, 200)}…` : out
}

function errorView(error) {
  return { name: error?.name ?? 'Error', code: error?.code ?? null, message: sanitize(error?.message) }
}

/** Append one record; probing must never break the host run. */
function record(entry) {
  if (RECORD === undefined || RECORD === '') return
  try {
    appendFileSync(RECORD, `${JSON.stringify({ t: Date.now() - T0, ...entry })}\n`)
  } catch {
    /* a probe failure must not fail the host run */
  }
}

/** One service as `ctx` sees it, strictly and non-strictly. */
function serviceView(ctx, name) {
  let strict
  let loose
  try {
    strict = ctx.get(name)
  } catch (error) {
    strict = undefined
    record({ rec: 'get-threw', name, strict: true, error: errorView(error) })
  }
  try {
    loose = ctx.get(name, false)
  } catch (error) {
    loose = undefined
    record({ rec: 'get-threw', name, strict: false, error: errorView(error) })
  }
  let providerFiber = null
  let providerState = null
  try {
    const bare = loose?.[ORIGINAL] ?? loose
    providerFiber = bare?.ctx?.fiber?.name ?? null
    providerState = STATE[bare?.ctx?.fiber?.state] ?? null
  } catch {
    /* a hostile getter is reported as unknown */
  }
  let isolateKey = 'unknown'
  try {
    isolateKey = String(ctx[ISOLATE]?.[name] ?? 'none')
  } catch {
    /* nothing to report */
  }
  return {
    strictHas: strict !== undefined && strict !== null,
    looseHas: loose !== undefined && loose !== null,
    providerFiber,
    providerState,
    isolateKey,
  }
}

function visibility(ctx, label, extra = {}) {
  record({
    rec: 'vis',
    label,
    ...extra,
    ctxFiber: ctx?.fiber?.name ?? null,
    ctxFiberState: STATE[ctx?.fiber?.state] ?? null,
    llm: serviceView(ctx, 'llm'),
    tools: serviceView(ctx, 'tools'),
    sessions: serviceView(ctx, 'sessions'),
    agents: serviceView(ctx, 'agents'),
  })
}

/**
 * One real, tool-free model call. Only the terminal outcome is recorded.
 *
 * `caller` is the worker-shaped cancellation signal: when it aborts, the host
 * does NOT throw, it emits a terminal `aborted` finish chunk (measured, §8.3).
 * `long` asks for a response big enough that the stream outlives the run's
 * teardown window, which is the only way to observe what ends it.
 */
async function callModel(llm, label, { caller, maxTokens = 32, long = false } = {}) {
  const started = Date.now()
  const entry = {
    rec: 'llm',
    label,
    long,
    callerAbortedAtStart: caller?.aborted === true,
    chunks: 0,
    usageFields: null,
    finishKind: null,
    failureCode: null,
    failureMessage: null,
  }
  if (llm === null || llm === undefined || typeof llm.stream !== 'function') {
    record({ ...entry, reason: 'no-service', ms: 0 })
    return
  }
  const timeout = AbortSignal.timeout(60_000)
  try {
    const stream = await llm.stream({
      provider: PROVIDER,
      model: MODEL,
      system: 'Compatibility probe. Answer with one word.',
      messages: [{
        id: 'teardown-1',
        role: 'user',
        // The prompt is never recorded; the long variant only exists to keep the
        // stream open across the teardown.
        content: [{
          type: 'text',
          text: long
            ? 'List twenty numbered short lines about determinism in software.'
            : 'Reply with the single word OK.',
        }],
        source: { kind: 'user' },
      }],
      maxTokens,
      signal: caller === undefined ? timeout : AbortSignal.any([caller, timeout]),
    })
    for await (const chunk of stream) {
      entry.chunks += 1
      if (chunk?.type === 'usage') entry.usageFields = Object.keys(chunk.usage ?? {}).length
      if (chunk?.type === 'finish') {
        entry.finishKind = chunk.reason?.kind ?? null
        entry.failureCode = chunk.reason?.failure?.code ?? null
        entry.failureMessage = sanitize(chunk.reason?.failure?.message)
      }
    }
  } catch (error) {
    entry.threw = errorView(error)
  }
  entry.ms = Date.now() - started
  entry.finishedAt = Date.now() - T0
  entry.callerAbortedAtFinish = caller?.aborted === true
  record(entry)
}

/** Read a service without letting a throwing lookup break the probe. */
function safeGet(ctx, name) {
  if (ctx === null || ctx === undefined || typeof ctx.get !== 'function') return undefined
  try {
    return ctx.get(name)
  } catch (error) {
    record({ rec: 'get-threw', name, error: errorView(error) })
    return undefined
  }
}

export function apply(ctx) {
  record({ rec: 'apply', dshHomeIsTemp: /^\/(?:tmp|private\/tmp|var\/folders)\//.test(process.env.DSH_HOME ?? '') })
  visibility(ctx, 'apply')
  let agentRef = null
  let inHandlerProbed = false
  let liveWindowProbed = false
  let turnEndSeen = false

  // A referenced interval keeps the process alive past the end of the run —
  // exactly the window the queue worker's own unref'd timer fires in.
  const interval = setInterval(() => visibility(ctx, 'interval'), 500)
  const stopInterval = setTimeout(() => clearInterval(interval), 15_000)
  if (typeof stopInterval.unref === 'function') stopInterval.unref()

  // The worker's own lifecycle: an AbortController that its fiber disposer
  // aborts, a boot pass at plugin load, and one unref'd timer.
  const workerController = new AbortController()
  ctx.effect(async () => {
    visibility(ctx, 'boot-effect')
    const llm = safeGet(ctx, 'llm')
    record({ rec: 'boot-pass', strictHas: llm !== undefined && llm !== null })
    // The pass that follows a `no-route` deferral today. No caller signal here:
    // this case exists to show that a BARE timer in the live window is not
    // inherently broken (the worker-shaped cancellation is measured separately,
    // by `live-window-worker-signal`).
    const timer = setTimeout(() => {
      visibility(ctx, 'boot-timer-fires')
      void callModel(safeGet(ctx, 'llm'), 'bare-timer-live-window')
    }, 1000)
    if (typeof timer.unref === 'function') timer.unref()
    return () => {
      record({ rec: 'disposer', workerControllerAbortedBefore: workerController.signal.aborted })
      workerController.abort('probe plugin unloaded')
    }
  }, 'obsidian-mem-teardown-probe boot effect')

  ctx.on('agent/session-start', ({ agent }) => {
    agentRef = agent ?? agentRef
    visibility(ctx, 'session-start', { agentCtxIsPluginCtx: agent?.ctx === ctx })
  })
  ctx.on('agent/disposed', () => visibility(ctx, 'agent-disposed'))
  ctx.on('session/flush', (session) => {
    visibility(ctx, 'flush', { seq: session?.seq ?? null })
    if (liveWindowProbed) return
    const llm = safeGet(ctx, 'llm')
    if (llm === undefined || llm === null) return
    liveWindowProbed = true
    // Two calls, opened in the earliest live window with a budget large enough to
    // straddle the disposal. The only difference is who may abort them.
    void callModel(llm, 'live-window-worker-signal', { caller: workerController.signal, maxTokens: 1500, long: true })
    void callModel(llm, 'live-window-private-signal', { maxTokens: 1500, long: true })
  })
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    agentRef = agent ?? agentRef
    visibility(ctx, 'pre-step', { aborted: signal?.aborted === true })
    if (!inHandlerProbed) {
      inHandlerProbed = true
      await callModel(safeGet(ctx, 'llm'), 'in-handler-control')
    }
    return next()
  })
  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'turn/end') return
    const reason = event.data?.reason?.kind ?? null
    visibility(ctx, 'turn-end', { reason })
    if (reason !== 'completed' || turnEndSeen) return
    turnEndSeen = true
    const captured = safeGet(ctx, 'llm')
    const capturedAgent = safeGet(agentRef?.ctx ?? null, 'llm')
    record({
      rec: 'capture',
      hasHandle: captured !== undefined && captured !== null,
      hasAgentHandle: capturedAgent !== undefined && capturedAgent !== null,
    })
    // After the run ends: a fresh lookup versus the handle captured while live.
    setTimeout(() => void callModel(safeGet(ctx, 'llm'), 'post-run-fresh-lookup'), 1000)
    setTimeout(() => void callModel(captured, 'post-run-captured-handle'), 1000)
  })
}
