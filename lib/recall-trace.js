// @ts-check
// The in-memory recall replay ring.
//
// A trace names the query, its candidates and their ranks. That is exactly the
// data the privacy rules of the hybrid design keep out of the diagnostic journal,
// so it must never be written anywhere: this module has no fs, no vault, no
// diagnostics. The process rebuilding it on demand is the only copy, and losing
// it on exit is the design, not an accident.

export const RECALL_TRACE_MAX_SESSIONS = 64
export const RECALL_TRACE_MAX_PER_SESSION = 20
export const RECALL_QUERY_TEXT_MAX = 200
export const TRACE_LEXICAL_CAP = 50
export const TRACE_DENSE_CAP = 50
export const TRACE_FUSED_CAP = 20
export const TRACE_VIEW_BYTES = 12 * 1024

const clip = (value, max) => [...String(value ?? '')].slice(0, max).join('')
const list = (value) => (Array.isArray(value) ? value : [])
const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : 0)

export function lexicalTrace(paths, facts = {}) {
  const top = list(paths)
    .slice(0, TRACE_LEXICAL_CAP)
    .map((hit, index) => ({
      path: typeof hit === 'string' ? hit : String(hit?.path ?? ''),
      rank: index + 1,
    }))
    .filter((entry) => entry.path !== '')
    .map((entry, index) => ({ ...entry, rank: index + 1 }))
  return {
    queryVector: null,
    guard: facts.guard === true,
    fallback: typeof facts.fallback === 'string' ? facts.fallback : null,
    denseCandidates: count(facts.denseCandidates),
    embedMs: count(facts.embedMs),
    lexicalTop: top,
    denseTop: [],
    fusedTop: top.slice(0, TRACE_FUSED_CAP).map((entry) => ({
      path: entry.path,
      source: 'lexical',
      lexicalRank: entry.rank,
      denseRank: null,
      semanticScore: null,
      hybridRank: entry.rank,
      lexicalHit: true,
    })),
  }
}

export function createRecallTrace() {
  const sessions = new Map()
  let cursor = 0
  return {
    record(sessionId, trace) {
      if (typeof sessionId !== 'string' || sessionId === '') return null
      if (trace === null || typeof trace !== 'object') return null
      cursor += 1
      const lexicalTop = list(trace.lexicalTop)
        .slice(0, TRACE_LEXICAL_CAP)
        .reduce((rows, entry) => {
          if (typeof entry?.path !== 'string' || entry.path === '') return rows
          rows.push({ path: entry.path, rank: rows.length + 1 })
          return rows
        }, [])
      const denseTop = list(trace.denseTop)
        .slice(0, TRACE_DENSE_CAP)
        .reduce((rows, entry) => {
          if (typeof entry?.path !== 'string' || entry.path === '') return rows
          rows.push({
            path: entry.path,
            rank: rows.length + 1,
            score: Number.isFinite(entry.score) ? Number(entry.score) : 0,
          })
          return rows
        }, [])
      const fusedTop = list(trace.fusedTop)
        .slice(0, TRACE_FUSED_CAP)
        .reduce((rows, entry) => {
          if (typeof entry?.path !== 'string' || entry.path === '') return rows
          rows.push({
            path: entry.path,
            source: entry.source === 'dense' ? 'dense' : 'lexical',
            lexicalRank: Number.isSafeInteger(entry.lexicalRank) ? entry.lexicalRank : null,
            denseRank: Number.isSafeInteger(entry.denseRank) ? entry.denseRank : null,
            semanticScore: Number.isFinite(entry.semanticScore)
              ? Number(entry.semanticScore)
              : null,
            hybridRank: rows.length + 1,
            lexicalHit: entry.lexicalHit === true,
          })
          return rows
        }, [])
      const entry = {
        cursor,
        at: Date.now(),
        source: trace.source === 'prompt' ? 'prompt' : trace.source === 'panel' ? 'panel' : 'tool',
        queryText: clip(trace.queryText, RECALL_QUERY_TEXT_MAX),
        queryVector:
          trace.queryVector instanceof Float32Array
            ? trace.queryVector
            : trace.queryVector
              ? Float32Array.from(trace.queryVector)
              : null,
        engine: typeof trace.engine === 'string' ? trace.engine : 'hybrid',
        fallback: typeof trace.fallback === 'string' ? trace.fallback : null,
        guard: trace.guard === true,
        denseCandidates: count(trace.denseCandidates),
        embedMs: count(trace.embedMs),
        tookMs: count(trace.tookMs),
        lexicalTop,
        denseTop,
        fusedTop,
      }
      const existing = sessions.get(sessionId)
      sessions.delete(sessionId)
      sessions.set(sessionId, {
        cursor,
        traces: [...(existing?.traces ?? []), entry].slice(-RECALL_TRACE_MAX_PER_SESSION),
      })
      while (sessions.size > RECALL_TRACE_MAX_SESSIONS)
        sessions.delete(sessions.keys().next().value)
      return cursor
    },
    /**
     * Record the trace a hybrid result array carries, if it carries one at all.
     * @param {string} sessionId
     * @param {{ queryText?: string, source?: string, tookMs?: number, hits?: unknown }} [options]
     */
    recordFromHits(sessionId, options = {}) {
      /** @type {{ queryText?: string, source?: string, tookMs?: number, hits?: any }} */
      const { queryText, source, tookMs, hits } = options
      const trace = hits?.hybridTrace
      if (trace === undefined || trace === null) return null
      return this.record(sessionId, { ...trace, queryText, source, tookMs })
    },
    since(sessionId, after = 0) {
      const session = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined
      if (session === undefined) return { cursor: 0, events: [] }
      const floor = Number.isSafeInteger(after) && after >= 0 ? after : 0
      return {
        cursor: session.cursor,
        events: session.traces.filter((trace) => trace.cursor > floor),
      }
    },
    clear(sessionId) {
      if (typeof sessionId === 'string') sessions.delete(sessionId)
    },
  }
}

export function toTraceView(trace, options = {}) {
  const project = typeof options.project === 'function' ? options.project : null
  let x = null
  let y = null
  if (trace.queryVector !== null && project !== null) {
    const point = project(trace.queryVector)
    if (point !== null && Number.isFinite(point.x) && Number.isFinite(point.y)) {
      x = point.x
      y = point.y
    }
  }
  return {
    cursor: trace.cursor,
    at: trace.at,
    source: trace.source,
    engine: trace.engine,
    fallback: trace.fallback,
    guard: trace.guard,
    denseCandidates: trace.denseCandidates,
    embedMs: trace.embedMs,
    tookMs: trace.tookMs,
    query: { text: trace.queryText, x, y },
    lexical: trace.lexicalTop,
    dense: trace.denseTop,
    fused: trace.fusedTop,
    truncated: false,
  }
}

// Shrink a view until it fits the wire budget. Dense rows are the least
// load-bearing (the fused list already carries the semantic verdict), so they go
// first; lexical rows encode the baseline answer, so they go second; fused rows
// are the replay itself and only go as an absolute last resort when even one row
// of each list does not fit.
export function fitTraceView(view, options = {}) {
  const maxBytes =
    Number.isSafeInteger(options.maxBytes) && options.maxBytes > 0
      ? options.maxBytes
      : TRACE_VIEW_BYTES
  const next = {
    ...view,
    lexical: [...view.lexical],
    dense: [...view.dense],
    fused: [...view.fused],
  }
  const size = () => new TextEncoder().encode(JSON.stringify(next)).length
  while (size() > maxBytes) {
    if (next.dense.length > 1) {
      next.dense.pop()
      next.truncated = true
    } else if (next.lexical.length > 1) {
      next.lexical.pop()
      next.truncated = true
    } else if (next.fused.length > 1) {
      next.fused.pop()
      next.truncated = true
    } else {
      next.truncated = true
      break
    }
  }
  return next
}
