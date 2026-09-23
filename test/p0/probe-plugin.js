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
