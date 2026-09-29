// Short-lived, process-local UI cues. Vault notes remain the only durable memory.
import { isAbsolute, relative, resolve, sep } from 'node:path'

const MAX_EVENTS = 80
const MAX_SESSIONS = 64

/**
 * Host tools whose arguments name one file the agent touched, and the cue that
 * leaves behind.
 *
 * A whitelist on purpose. `run_code`, `bash` and `glob` carry vault paths as
 * program text, as command text or as a search root, so reading a path out of
 * them would light up notes the agent never opened — the tidy turn this was
 * written for dispatched 25 `bash` and 36 `run_code` calls that all mention
 * vault paths without touching a single note.
 */
const HOST_FILE_TOOLS = Object.freeze({
  read: { field: 'file_path', kind: 'read' },
  edit: { field: 'file_path', kind: 'write' },
  write: { field: 'file_path', kind: 'write' },
  grep: { field: 'path', kind: 'read' },
})

/**
 * The note one host tool call touched, as a vault-relative path.
 *
 * `arguments` is a JSON string on `tool/call` and an already-parsed object on
 * `tool/ptc-dispatch` (measured in docs/p0-compatibility.md), so both shapes are
 * accepted. A name outside the whitelist returns before anything is parsed, which
 * is what keeps `run_code`'s program text off this path.
 *
 * @param {unknown} name - the tool name from the event.
 * @param {unknown} args - the event's raw `arguments`.
 * @param {unknown} vaultRoot - the vault's absolute root.
 * @returns {{kind: string, path: string}|null} the cue, or `null` for no cue.
 */
export function noteTouchFromToolCall(name, args, vaultRoot) {
  const tool = HOST_FILE_TOOLS[name]
  if (tool === undefined || typeof vaultRoot !== 'string' || vaultRoot === '') return null
  let parsed = args
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed)
    } catch {
      return null
    }
  }
  if (parsed === null || typeof parsed !== 'object') return null
  const path = insideVault(parsed[tool.field], vaultRoot)
  return path === null ? null : { kind: tool.kind, path }
}

/** The vault-relative POSIX path of a `.md` argument, or `null` when it is not one. */
function insideVault(value, vaultRoot) {
  if (typeof value !== 'string' || value === '') return null
  if (!value.toLowerCase().endsWith('.md')) return null
  const root = resolve(vaultRoot)
  for (const candidate of [resolve(value), resolve(root, value)]) {
    const path = relative(root, candidate)
    if (path !== '' && !path.startsWith('..') && !isAbsolute(path)) return path.split(sep).join('/')
  }
  return null
}

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
