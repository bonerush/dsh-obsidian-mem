// Short-lived, process-local UI cues. Vault notes remain the only durable memory.
const MAX_EVENTS = 80
const MAX_SESSIONS = 64

/** Create a bounded activity feed for graph highlights in the current host process. */
export function createGraphActivity() {
  const bySession = new Map()
  let cursor = 0
  return {
    /** Record paths actually read or injected for one agent session. */
    record(sessionId, paths, kind) {
      if (typeof sessionId !== 'string' || sessionId === '' || !Array.isArray(paths)) return
      for (const path of paths) {
        if (typeof path !== 'string' || path === '') continue
        cursor += 1
        const events = bySession.get(sessionId) ?? []
        events.push({ cursor, path, kind, at: Date.now() })
        if (events.length > MAX_EVENTS) events.shift()
        bySession.delete(sessionId)
        bySession.set(sessionId, events)
      }
      while (bySession.size > MAX_SESSIONS) bySession.delete(bySession.keys().next().value)
    },
    /** Return only events newer than the caller's cursor. */
    since(sessionId, after = 0) {
      const events = bySession.get(sessionId) ?? []
      return { cursor, events: events.filter((event) => event.cursor > after) }
    },
  }
}
