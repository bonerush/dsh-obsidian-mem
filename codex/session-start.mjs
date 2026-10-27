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
import { open } from 'node:fs/promises'
import { homedir } from 'node:os'

import { DEFAULT_MAX_MS, DEFAULT_MAX_NOTES } from '../lib/curation-scan.js'
import { deliveryStateEpoch, reconcileTranscript } from '../lib/delivery-state.js'
import { bindHintWithin } from '../lib/init-hint.js'
import { resolveBinding } from '../lib/vault.js'
import { openMemory } from './server.mjs'

/**
 * The `source` values that open a conversation with no project context in it.
 *
 * `compact` is here on measurement, not on policy. A Codex rollout records what
 * compaction leaves the model with in its `compacted` payload's `replacement_history`,
 * and the injection is *not* in it: on
 * `~/.codex/sessions/2026/10/04/rollout-…01a106b0…jsonl` the brief is at line 9 as a
 * `hooks.additional_context` developer message, and the `compacted` record at line 400
 * replaces the context with 102 KB that contains no `obsidian-mem:brief`. Compaction
 * therefore drops the brief, and a session that continues after one is a session whose
 * memory is gone — so it is paid for again, once, at the compaction that lost it.
 * `resume` is different: it continues a conversation verbatim, so it is decided per
 * session by {@link resumeVerdict}.
 */
export const INJECT_SOURCES = Object.freeze(['startup', 'clear', 'compact'])

/**
 * The Codex sources that begin a context with no delivery history in it.
 *
 * Measured in `codex-hook-validation.md`: `compaction really drops the brief`, and
 * `clear` starts a new conversation. A delivery epoch bump is the spec's answer —
 * the previous acked identities cannot describe what the model holds — while a
 * `resume` that still carries the brief keeps its epoch.
 */
const RESET_SOURCES = new Set(['startup', 'clear', 'compact'])

/**
 * How much of a rollout is read before the answer is "cannot tell".
 *
 * The measured rollout is 2.7–7.9 MB. Eight megabytes covers the samples with room to
 * spare and bounds a session start's I/O; anything larger is answered by the
 * conservative branch rather than by reading the whole file.
 */
export const MAX_ROLLOUT_BYTES = 8 * 1024 * 1024

/**
 * The injection as Codex serializes it inside a rollout.
 *
 * The structural prefix matters: the bare string `obsidian-mem:brief` also appears in
 * this repository's own AGENTS.md and in every rollout that greps it, so a scan for the
 * bare string would report a brief that a compaction had already dropped. Inside a
 * quoted tool output the quotes are escaped (`\"text\":\"…`), so neither form below can
 * match a quotation.
 *
 * Two spacings are accepted because the *costs are not symmetric*. Every one of the 132
 * rollouts on this machine writes compact JSON (`"text":"…"`), so the spaced form is
 * untested against a live writer — but if a future one wrote it, missing the injection
 * only costs a duplicate brief, while missing a *compaction* would read as "the brief is
 * still there" and leave the session without memory. Spending one extra `lastIndexOf`
 * on the safe side of that asymmetry is worth more than the purity of a single needle.
 */
const INJECTION_NEEDLES = Object.freeze([
  '"text":"<!-- obsidian-mem:brief mode=',
  '"text": "<!-- obsidian-mem:brief mode=',
])
/** The record compaction appends, likewise matched structurally and in both spacings. */
const COMPACTION_NEEDLES = Object.freeze(['"type":"compacted"', '"type": "compacted"'])

/**
 * The last position of any needle, or -1.
 *
 * @param {string} text - the rollout head.
 * @param {readonly string[]} needles - the accepted serializations.
 * @returns {number} the last index, or -1 when none appears.
 */
function lastIndexOfAny(text, needles) {
  let found = -1
  for (const needle of needles) {
    const at = text.lastIndexOf(needle)
    if (at > found) found = at
  }
  return found
}

/**
 * The head of a rollout, and whether that was all of it.
 *
 * The same read is the delivery reconciler's evidence (spec §1): a rollout past
 * the ceiling is not proof either way, which is why `truncated` is carried out of
 * here rather than assumed away.
 *
 * @param {string} path - the file to read.
 * @param {number} maxBytes - the ceiling.
 * @returns {Promise<{text: string, truncated: boolean}|null>} the head, or `null` when unreadable.
 */
export async function readRolloutHead(path, maxBytes) {
  let handle
  try {
    handle = await open(path, 'r')
  } catch {
    return null
  }
  try {
    const stats = await handle.stat()
    const size = Math.min(Number.isSafeInteger(stats.size) ? stats.size : 0, maxBytes)
    const buffer = Buffer.alloc(size)
    const { bytesRead } = await handle.read(buffer, 0, size, 0)
    return {
      text: buffer.subarray(0, bytesRead).toString('utf8'),
      truncated: stats.size > bytesRead,
    }
  } catch {
    return null
  } finally {
    await handle.close().catch(() => {})
  }
}

/**
 * Whether a file is a Codex rollout, judged by the shape the binary writes.
 *
 * A defensive check, because the hook acts on the answer: `transcript_path` is a
 * measured *field* of the SessionStart payload, but nothing in this repository has
 * measured a live `resume` populating it, so the scan only ever speaks about a file
 * that opens like a rollout. Anything else is `unknown` — the hook's behaviour before
 * this change.
 *
 * @param {string} text - the file's head.
 * @returns {boolean} true when the first line is a `session_meta` record.
 */
function looksLikeRollout(text) {
  const end = text.indexOf('\n')
  const first = end === -1 ? text : text.slice(0, end)
  if (first.trim() === '') return false
  try {
    const parsed = JSON.parse(first)
    return parsed !== null && typeof parsed === 'object' && parsed.type === 'session_meta'
  } catch {
    return false
  }
}

/**
 * Whether a resumed conversation still carries the brief, or whether that is unknowable.
 *
 * Three answers, and the middle one is the honest one:
 *
 *   * `present` — the injection is the *latest* of the two records and the whole file
 *     was read, so the model's window still holds it.
 *   * `absent` — either no injection appears at all (the plugin was installed
 *     mid-thread, or the rollout was imported from another agent), or a compaction
 *     comes after it, which is measured to drop it.
 *   * `unknown` — no readable rollout, a file that is not a rollout, or a file past
 *     {@link MAX_ROLLOUT_BYTES} whose tail could hold a compaction this scan cannot
 *     see. The hook then keeps the behaviour it had before this existed: `resume`
 *     injects nothing, because a resumed conversation usually does carry the brief and
 *     the one saving this hook can make for free is not paying for it twice.
 *
 * @param {unknown} transcriptPath - the payload's `transcript_path`.
 * @param {{read?: Function, maxBytes?: number}} [io] - reader seam, for tests.
 * @returns {Promise<'present'|'absent'|'unknown'>} the verdict.
 */
export async function resumeVerdict(transcriptPath, io = {}) {
  const read = io.read ?? readRolloutHead
  const maxBytes = io.maxBytes ?? MAX_ROLLOUT_BYTES
  if (typeof transcriptPath !== 'string' || transcriptPath.trim() === '') return 'unknown'
  const head = await read(transcriptPath, maxBytes)
  if (head === null || typeof head?.text !== 'string') return 'unknown'
  if (!looksLikeRollout(head.text)) return 'unknown'
  const markerAt = lastIndexOfAny(head.text, INJECTION_NEEDLES)
  const compactedAt = lastIndexOfAny(head.text, COMPACTION_NEEDLES)
  // No injection anywhere in what was read: proof only when the file was read whole.
  if (markerAt === -1) return head.truncated === true ? 'unknown' : 'absent'
  // A compaction after the injection is proof on its own: what follows it is the
  // replacement context, and the measurement says the brief is not in it.
  if (compactedAt > markerAt) return 'absent'
  return head.truncated === true ? 'unknown' : 'present'
}

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
 * `resume` is decided per session by {@link resumeVerdict}: it injects only when the
 * rollout proves the conversation never received a brief (or had it compacted away).
 * A directory that resolves to no usable project is not silently skipped either: it
 * gets the same one-shot notice DSH injects (see `briefFor`), which is how a user is
 * ever asked whether to bind it.
 *
 * @param {unknown} payload - the parsed SessionStart document, or whatever arrived.
 * @param {{read?: Function, maxBytes?: number}} [io] - reader seam handed to {@link resumeVerdict}.
 * @returns {Promise<{inject: boolean, reason: string}>} the decision and a short reason.
 */
export async function decide(payload, io = {}) {
  if (payload === null || typeof payload !== 'object')
    return { inject: false, reason: 'no-payload' }
  const event = /** @type {Record<string, unknown>} */ (payload)
  if (event.hook_event_name !== 'SessionStart') {
    return { inject: false, reason: `event-${String(event.hook_event_name ?? 'missing')}` }
  }
  const source = typeof event.source === 'string' ? event.source : ''
  if (typeof event.cwd !== 'string' || event.cwd.trim() === '') {
    return { inject: false, reason: 'cwd-missing' }
  }
  if (INJECT_SOURCES.includes(source)) return { inject: true, reason: source }
  if (source === 'resume') {
    const verdict = await resumeVerdict(event.transcript_path, io)
    return verdict === 'absent'
      ? { inject: true, reason: 'resume-without-brief' }
      : { inject: false, reason: `resume-${verdict}` }
  }
  return { inject: false, reason: `source-${source === '' ? 'missing' : source}` }
}

/**
 * The Codex delivery context for one SessionStart: epoch, and the reconciliation
 * of what a previous hook wrote.
 *
 * Codex hooks are separate processes, so the epoch cannot live in memory: it is
 * read from the private state, kept on `resume` (the conversation still carries
 * the injection) and bumped on `startup`/`clear`/`compact` (the measured
 * compaction really drops it). Reconciliation runs against the *previous* epoch
 * before that bump, because that is where the pending receipt lives, and it only
 * ever runs on structured developer messages: missing, unreadable or over-cap
 * evidence leaves the receipt pending, which allows the repetition the spec
 * requires.
 *
 * @param {object} memory - the opened memory layer.
 * @param {string} cwd - the session's working directory.
 * @param {object} options - the hook evidence and identity.
 * @param {string} [options.sessionKey] - the Codex session id; absent means no receipt.
 * @param {string} [options.source] - the SessionStart source.
 * @param {string} [options.transcript] - the rollout head, when it was readable.
 * @param {boolean} [options.truncated] - whether the read ceiling cut the rollout.
 * @returns {Promise<{sessionKey: string, epoch: number}|null>} the context, or `null` for a non-bound directory.
 */
async function deliveryContextFor(memory, cwd, options) {
  if (typeof options.sessionKey !== 'string' || options.sessionKey.trim() === '') return null
  const binding = await resolveBinding({
    cwd,
    vaultRoot: memory.config.vaultPath,
    mode: 'show',
    home: homedir(),
  })
  if (binding === null || binding.kind !== 'bound') return null
  let priorEpoch
  try {
    priorEpoch = await deliveryStateEpoch({
      binding,
      dataRoot: memory.dataRoot,
      sessionKey: options.sessionKey,
    })
  } catch {
    return null
  }
  const reconcileEpoch = priorEpoch === 0 ? 1 : priorEpoch
  if (typeof options.transcript === 'string' && options.transcript !== '') {
    try {
      await reconcileTranscript({
        binding,
        dataRoot: memory.dataRoot,
        sessionKey: options.sessionKey,
        epoch: reconcileEpoch,
        transcript: options.transcript,
        truncated: options.truncated === true,
        proofKind: 'transcript',
        home: homedir(),
      })
    } catch {
      // Reconciliation is an observation; a failure leaves the receipt pending.
    }
  }
  const reset = RESET_SOURCES.has(typeof options.source === 'string' ? options.source : '')
  const epoch = priorEpoch === 0 ? 1 : reset ? priorEpoch + 1 : priorEpoch
  return { sessionKey: options.sessionKey, epoch }
}

/**
 * The brief for one directory, or `null` when there is nothing to inject.
 *
 * `null` covers "the brief came back blank", which is the rule that an empty brief
 * must never be injected as if the project had no memory.
 *
 * An `unbound` answer is *not* `null`: it becomes the same notice DSH's pre-step
 * injects, composed by the same module (`lib/init-hint.js`), so that a Codex user
 * in a pointerless project — or in a session whose recorded directory has been
 * moved or deleted — is asked the same question the DSH user is. Before this, the
 * two harnesses disagreed: DSH asked and Codex said nothing until a tool was
 * called. A refusal with no wording (`lib/init-hint.js` keeps a closed list) still
 * injects nothing.
 *
 * Task 6's automatic pass runs *after* the brief is built and before the hook
 * answers, because a session start is the only turn boundary this adapter owns:
 * MCP gives tools, not boundaries, so there is nowhere else to put it. It is
 * bounded by `lib/curation-scan.js`'s shared defaults — a 500 ms deadline and 256
 * notes, which is what keeps a session start from waiting on a large vault — and it
 * may neither change the brief nor fail the hook: a scan that throws is one
 * diagnostic and nothing more. `onCurated` exists so a test can hold the pass open
 * and count the calls; production passes nothing.
 *
 * @param {string} cwd - the session's working directory, from the hook payload.
 * @param {Function} open - {@link openMemory}; injected so a test can count opens.
 * @param {Function} [onCurated] - called once per pass that was actually started.
 * @param {object} [options] - the delivery evidence.
 * @param {string} [options.sessionKey] - the Codex session id, which enables receipts.
 * @param {string} [options.source] - the SessionStart source (startup/resume/clear/compact).
 * @param {string} [options.transcript] - the rollout head that may reconcile a previous pending receipt.
 * @param {boolean} [options.truncated] - whether the rollout read hit its ceiling.
 * @returns {Promise<string|null>} the brief text, or `null` for "inject nothing".
 */
export async function briefFor(cwd, open, onCurated, options = {}) {
  const memory = open({ cwd })
  try {
    let delivery = null
    try {
      delivery = await deliveryContextFor(memory, cwd, options)
    } catch {
      // A delivery receipt is an observation layer: it must never block the brief.
      delivery = null
    }
    const brief = await memory.services.brief(
      delivery === null
        ? {}
        : { delivery: { sessionKey: delivery.sessionKey, epoch: delivery.epoch } },
    )
    if (brief === null || typeof brief !== 'object') return null
    if (brief.status === 'unbound') {
      // The notice, not a brief: no vault text, no index, and no automatic pass —
      // there is no project to curate. `cwd` and `repoRoot` are passed so the message
      // can quote the directory in question (the repository root where the pointer
      // belongs, not the session's subdirectory); an unworded reason answers `null`
      // and stays silent, and `bindHint: false` removes the notice here exactly as it
      // does on the DSH side.
      if (memory.config?.bindHint === false) return null
      return bindHintWithin(
        {
          reason: brief.reason,
          cwd,
          ...(typeof brief.repoRoot === 'string' ? { repoRoot: brief.repoRoot } : {}),
        },
        memory.config?.briefBudgetChars,
      )
    }
    if (memory.config?.autoCurate !== false) {
      try {
        onCurated?.(cwd)
        // The shared pass, so the binding rules and the R14 cloud-managed refusal
        // are decided in one place. `lib/curation-scan.js`'s own defaults — 256
        // notes and a 500 ms deadline — are named here rather than left implicit,
        // because this adapter holds a session start open while it runs; the DSH
        // paths pass no bounds at all, so they get these exact two values.
        await memory.services.curateCurrentProject({
          dueOnly: true,
          maxNotes: DEFAULT_MAX_NOTES,
          maxMs: DEFAULT_MAX_MS,
        })
      } catch (error) {
        // Content-free, and never rethrown. A hook that exited non-zero or
        // answered nothing would cost the user a session to report a housekeeping
        // failure.
        memory.diagnostics?.event?.('curation', {
          outcome: 'failed',
          code: typeof error?.code === 'string' ? error.code : undefined,
        })
      }
    }
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
 * @param {{open?: Function, out?: {write: Function}, err?: {write: Function}, read?: Function, maxBytes?: number}} [io] - sinks and the rollout-reader seam, injected for tests.
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
  // One bounded read of the session's own rollout serves both consumers: the
  // `resume` verdict (does the conversation still carry the brief?) and the
  // delivery reconciler (was a prepared brief really committed as a developer
  // message?). Missing or unreadable evidence is `null`, which acknowledges
  // nothing — the spec's conservative direction.
  const transcriptPath =
    payload !== null && typeof payload.transcript_path === 'string' ? payload.transcript_path : null
  let evidence = null
  if (transcriptPath !== null && transcriptPath.trim() !== '') {
    const read = io.read ?? readRolloutHead
    try {
      evidence = await read(transcriptPath, io.maxBytes ?? MAX_ROLLOUT_BYTES)
    } catch {
      evidence = null
    }
  }
  // The decision reads the rollout for a `resume`, so it is awaited — and every branch
  // of it is still a plain value: the reader answers `unknown` rather than throwing.
  const { inject, reason } = await decide(payload, {
    read: async () => evidence,
    maxBytes: io.maxBytes,
  })
  let answer = CONTINUE
  try {
    if (inject) {
      const text = await briefFor(payload.cwd, open, undefined, {
        sessionKey: payload.session_id,
        source: payload.source,
        ...(evidence === null ? {} : { transcript: evidence.text, truncated: evidence.truncated }),
      })
      if (text === null) note(`no brief for ${payload.cwd}; injecting nothing`)
      else answer = hookOutput(text)
    } else {
      note(`not injecting (${reason})`)
      // A quiet source pays nothing — not even a delivery reconciliation. That is
      // the measured contract this hook keeps for a resume that still carries the
      // brief: no memory layer is opened, no data root is created. A pending receipt
      // therefore waits for the next session start that actually injects, which is
      // exactly the conservative direction the spec gives: missing evidence means
      // unacknowledged, allowing repetition.
    }
  } catch (error) {
    // A vault that refuses must not become a session that refuses. Codex shows
    // hook stderr in its own log, which is where this belongs.
    err.write(`obsidian-mem(hook): brief failed: ${error?.message ?? error}\n`)
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
