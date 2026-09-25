#!/usr/bin/env node
// @ts-check
// The one automatic thing the Codex side can do: a `SessionStart` hook that puts
// the project brief in front of the first model call, the way DSH's pre-step does.
//
// Why this file exists. `codex/server.mjs` exposes the six tools over MCP, and a
// tool is something the model has to decide to call — so a Codex session where
// nothing calls `mem_brief` recalls nothing. DSH has no such hole: the plugin
// hooks the pre-step and injects the brief itself. Codex 0.146.0 has a second
// extension point that closes it, and it is not a tool: a plugin may ship
// `hooks/hooks.json`, whose `SessionStart` command receives the session as JSON
// on stdin and may answer with `hookSpecificOutput.additionalContext`, which
// Codex adds to the conversation before the first model call.
//
// This file is the adapter for that slot and nothing else. It composes no text of
// its own: what it injects is `brief.text` from `lib/brief.js` — the same field
// DSH's pre-step hands to `recallMessage`. There is still exactly one copy of the
// memory layer, and this is not a second one.
//
// Measured against codex-cli 0.146.0 (probe transcript in CHANGELOG.md):
//   * stdin: `{session_id, transcript_path, cwd, hook_event_name, model,
//     permission_mode, source}`, `source` in startup|resume|clear|compact.
//   * stdout: one JSON object. `hookSpecificOutput.hookEventName` is required and
//     `additionalContext` is the injected text; anything else is dropped with
//     "hook returned invalid session start JSON output".
//   * this event's `matcher` matches `source`, not a tool name — verified by a
//     `matcher = "clear"` hook not firing on a startup session.
//   * a hook is skipped in silence until the client records a trust hash for it,
//     which is why the README makes that review a numbered install step.
//
// Fail-open is the whole safety story. This runs in front of every session,
// including the ones that have nothing to do with this plugin, so no failure here
// may cost the user a session: every path writes one schema-valid object and exits
// 0. Reasons go to stderr, where they cannot be mistaken for protocol, and only
// when something actually went wrong or `OBSIDIAN_MEM_HOOK_DEBUG=1` asks for them.
import { openMemory } from './server.mjs'

/** The `source` values that open a conversation with no project context in it. */
export const INJECT_SOURCES = Object.freeze(['startup', 'clear'])

/**
 * What a hook that injects nothing still has to say.
 *
 * `continue: true` is written out rather than left to the default, because the
 * default belongs to the client: a Codex release that changed it would turn this
 * plugin's quiet no-op into a blocked session.
 */
export const CONTINUE = Object.freeze({ continue: true })

/** Verbose reasons are opt-in: a normal session start should be silent. */
const DEBUG = process.env.OBSIDIAN_MEM_HOOK_DEBUG === '1'

/**
 * The hook's success answer for one brief.
 *
 * @param {string} additionalContext - the text Codex adds to the conversation.
 * @returns {object} one `session-start.command.output` document.
 */
export function hookOutput(additionalContext) {
  return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext } }
}

/**
 * Whether this session start should recall anything, and why or why not.
 *
 * `resume` and `compact` are deliberately absent from {@link INJECT_SOURCES}: both
 * continue a conversation that already carries the earlier injection (or its
 * summary), and paying for the same brief twice is the one cost this hook can
 * avoid without losing anything. A directory with no `.obsidian-mem` pointer is
 * not a refusal either — it is simply not this plugin's project, and it is decided
 * later, by the brief itself answering `status: "unbound"`.
 *
 * @param {unknown} payload - the parsed SessionStart document, or whatever arrived.
 * @returns {{inject: boolean, reason: string}} the decision and a short reason.
 */
export function decide(payload) {
  if (payload === null || typeof payload !== 'object')
    return { inject: false, reason: 'no-payload' }
  const event = /** @type {Record<string, unknown>} */ (payload)
  if (event.hook_event_name !== 'SessionStart') {
    return { inject: false, reason: `event-${String(event.hook_event_name ?? 'missing')}` }
  }
  const source = typeof event.source === 'string' ? event.source : ''
  if (!INJECT_SOURCES.includes(source)) {
    return { inject: false, reason: `source-${source === '' ? 'missing' : source}` }
  }
  if (typeof event.cwd !== 'string' || event.cwd.trim() === '') {
    return { inject: false, reason: 'cwd-missing' }
  }
  return { inject: true, reason: source }
}

/**
 * The brief for one directory, or `null` when there is nothing to inject.
 *
 * `null` covers both "this directory is not a bound project" and "the brief came
 * back blank". Neither is an error: the first is most directories on any machine,
 * and the second is the rule that an empty brief must never be injected as if the
 * project had no memory.
 *
 * @param {string} cwd - the session's working directory, from the hook payload.
 * @param {Function} open - {@link openMemory}; injected so a test can count opens.
 * @returns {Promise<string|null>} the brief text, or `null` for "inject nothing".
 */
export async function briefFor(cwd, open) {
  const memory = open({ cwd })
  try {
    const brief = await memory.services.brief({})
    if (brief === null || typeof brief !== 'object') return null
    if (brief.status === 'unbound') return null
    const text = typeof brief.text === 'string' ? brief.text.trim() : ''
    return text === '' ? null : text
  } finally {
    // The hook process is about to exit, but the vault lock and the index handle
    // are not the operating system's to clean up: release them here so a killed
    // hook and a clean one leave the same state behind.
    await memory.services.close?.()
  }
}

/**
 * Answer one SessionStart payload.
 *
 * @param {string} raw - everything the client wrote to stdin.
 * @param {{open?: Function, out?: {write: Function}, err?: {write: Function}}} [io] - sinks, injected for tests.
 * @returns {Promise<object>} the object that was written, for a test to assert on.
 */
export async function runHook(raw, io = {}) {
  const open = io.open ?? openMemory
  const out = io.out ?? process.stdout
  const err = io.err ?? process.stderr
  const note = (message) => {
    if (DEBUG) err.write(`obsidian-mem(hook): ${message}\n`)
  }
  let payload = null
  try {
    payload = JSON.parse(raw)
  } catch {
    note('stdin was not JSON; injecting nothing')
  }
  const { inject, reason } = decide(payload)
  let answer = CONTINUE
  if (inject) {
    try {
      const text = await briefFor(payload.cwd, open)
      if (text === null) note(`no brief for ${payload.cwd}; injecting nothing`)
      else answer = hookOutput(text)
    } catch (error) {
      // A vault that refuses must not become a session that refuses. Codex shows
      // hook stderr in its own log, which is where this belongs.
      err.write(`obsidian-mem(hook): brief failed: ${error?.message ?? error}\n`)
    }
  } else {
    note(`not injecting (${reason})`)
  }
  out.write(`${JSON.stringify(answer)}\n`)
  return answer
}

/** Read the payload; a terminal means a human ran this by hand, so there is none. */
async function readPayload() {
  if (process.stdin.isTTY === true) return ''
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

const isEntry = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`
if (isEntry) {
  try {
    await runHook(await readPayload())
  } catch (error) {
    // runHook already fails open; this is the belt to that braces, so that even a
    // defect in the failure path leaves the session able to start.
    process.stderr.write(`obsidian-mem(hook): fatal: ${error?.stack ?? error}\n`)
    process.stdout.write(`${JSON.stringify(CONTINUE)}\n`)
  }
}
