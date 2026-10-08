// @ts-check
// The failure streak, and the query it produces (Task 18).
//
// The user's observation was about TIMING: memory was only ever offered at turn
// boundaries, so a session that was failing — a tool refusing, a command
// exiting non-zero, the same mistake three times — got no help from what the
// project had already learned. This module supplies the missing signal: it reads
// the tool events one turn produced and answers two questions — "is this session
// stuck?" and "stuck on what, in words a note could match?".
//
// It is a LEAF. No repository import and no `node:` import, so it sits with
// `prompt-recall` and `routing` at L3 and both readers point down at it: `hooks`
// (L8) decides when to ask, and `capture` (L6) owns the same event stream.
//
// ---------------------------------------------------------------------------
// Measured, not imagined
// ---------------------------------------------------------------------------
//
// The thresholds below come from the author's own 60 most recent V4 session logs
// (measured 2026-10-08, `research/failure-triggered-recall.md`):
//
//   * 6,442 `tool/result` events, of which **150 were hard failures (2.3%)**.
//     2.3% is the number that rules out the obvious design: a recall on every
//     failure would interrupt roughly one tool call in 43, and almost all of
//     those are a command typo rather than project knowledge.
//   * Failures CLUSTER. Five of the 60 sessions had a run of three or more
//     consecutive failures, the longest run being 13. A run is the signal a
//     single failure is not: the session is repeating itself, which is exactly
//     when "we hit this before" is worth the tokens.
//   * **370 results reported success with error text inside them** — more than
//     twice the hard-failure count. This is the case that makes `isError` alone
//     insufficient, and it is not hypothetical: while writing the research for
//     this module, `web_fetch` returned `isError: false` with `len= 0` for every
//     attempt, its body a wall of `ToolCallError: URL hostname … resolves to a
//     non-public IP address`. The tool layer said the calls succeeded.
//
// ---------------------------------------------------------------------------
// Two kinds of failure, two thresholds, one asymmetry
// ---------------------------------------------------------------------------
//
// `hard` is the host saying a call failed; `soft` is a call the host called
// successful whose body is error text. They are counted separately rather than
// summed, because a soft failure is a guess from a pattern and a hard failure is
// not — mixing them would let nine text matches masquerade as a run of nine real
// failures.
//
// And they are ASYMMETRIC in what they may cause: a hard failure is evidence a
// tool really refused, so it may justify recording a candidate later; a soft
// failure is a pattern match on raw output, so it may only ever SUGGEST a recall.
// That boundary is the user's own decision, and it is also what the repository's
// privacy rules require — `capture.js` records "name and outcome only: the result
// body is raw tool output and is never copied", and the distillation contract
// treats a claim without a verified tool result as `inferred` rather than
// `observed`. A soft failure cannot promote an `assertion`, so it must not be
// allowed to open a write path.
//
// ---------------------------------------------------------------------------
// What may become a query, and what may never
// ---------------------------------------------------------------------------
//
// The query is built from a CLOSED vocabulary: the tool's NAME (a host-provided
// identifier such as `bash` or `web_fetch`) and one error KIND from the fixed
// table below. Nothing else from the result body crosses this boundary — no
// command text, no path, no URL, no output fragment — because that text can hold
// credentials, and because the vault is a document store rather than a log. The
// table is closed on purpose: an unrecognised body contributes `unknown`, which
// is a poor query and an honest one. Guessing a kind from arbitrary text would
// put tool output into a search query, which is the one thing the design forbids.

/** The failure kinds a query may name. Closed: an unknown body yields `unknown`. */
export const FAILURE_KINDS = Object.freeze([
  'directory-not-found',
  'host-unresolvable',
  'not-found',
  'permission-denied',
  'not-a-repo',
  'command-not-found',
  'nonzero-exit',
  'traceback',
  'tool-error',
  // The fallback, and the ONLY kind a hard failure can carry when its body has no
  // signature. Capture stores the category without its output. A generic errno
  // signature also maps here; a body with no signature returns null from kindOf.
  'unknown',
])

/** How many consecutive hard failures count as a stuck session. */
export const HARD_STREAK_THRESHOLD = 3
/** How many soft failures inside one step suggest the same. */
export const SOFT_STREAK_THRESHOLD = 2
/** Query words actually used by English and Chinese notes, from a fixed table. */
const QUERY_ALIASES = Object.freeze({
  'not-found': 'ENOENT 找不到文件',
  'directory-not-found': 'ENOTDIR 目录',
  'permission-denied': 'EACCES EPERM 权限',
  'host-unresolvable': 'DNS hostname 解析',
  'not-a-repo': 'git repository 仓库',
  'command-not-found': 'command module 命令',
  'nonzero-exit': 'exit status 退出码',
  traceback: 'Traceback 异常',
  'tool-error': 'ToolCallError 工具错误',
  unknown: '',
})
/**
 * How many characters of a successful result are scanned for error text.
 *
 * A tool result is unbounded — one `run_code` result in the measured corpus was
 * several KB, and a `bash` result can be a whole build log — so the scan needs a
 * ceiling. A real error signature sits at the head or the tail of such a log, and
 * 8,000 characters covers both ends of everything the corpus contains while
 * bounding the work to a slice rather than a copy of the whole body.
 */
export const MAX_SCAN_CHARS = 8000
/** Bound outstanding call names and nested wrapper identities in a long session. */
const MAX_TRACKED_CALLS = 256

/**
 * Read either host tool-message format without retaining output.
 * @param {object} data - tool result event data.
 * @returns {object|null} the result envelope, or null for a non-result.
 */
export function toolResultMessage(data) {
  const message = data?.message
  if (message && typeof message === 'object') {
    const nested = Array.isArray(message.content)
      ? message.content.find((part) => part?.type === 'tool-result')
      : null
    if (nested) return { ...nested, source: message.source }
    if (
      Array.isArray(message.content) ||
      message.role === 'tool' ||
      typeof message.isError === 'boolean' ||
      typeof message.toolCallId === 'string'
    )
      return message
  }
  return data?.error != null ? {} : null
}

/**
 * A closed failure category, computed transiently from bounded result text.
 * @param {object} data - one tool result event's data.
 * @returns {string} a fixed category, never a body fragment.
 */
export function failureKind(data) {
  return kindOf(textOf(toolResultMessage(data))) ?? 'unknown'
}

/** Host tool identifiers cannot carry a path, URL, command or unbounded text. */
function safeToolName(name) {
  return typeof name === 'string' && /^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/u.test(name)
    ? name
    : 'unknown'
}

/** Keep only a bounded set of outstanding identities. */
function remember(map, key, value) {
  map.set(key, value)
  if (map.size > MAX_TRACKED_CALLS) map.delete(map.keys().next().value)
}

/**
 * The error signatures, in priority order: the first pattern that matches wins,
 * so a more specific kind is never shadowed by a broader one.
 *
 * Every pattern is anchored on something a real tool emits, and the anchoring is
 * the whole difficulty of the soft signal. The first version of this table
 * matched 3,821 of 2,771 successful results — **63.7% of them** — because its
 * generic fallback was `\bE[A-Z]{3,}\b|Error:|\berror\b` under the `i` flag, and
 * with case folded, `\bE[A-Z]{3,}\b` matches any word starting with `e`:
 * `export`, `Evenly`, `emitanaka`, `ezproxy`, `easystats` all became "error
 * codes". A soft signal that fires on 64% of successful work cannot distinguish
 * a stuck session from a busy one, so it was rebuilt around three rules:
 *
 *   1. **No case folding on the error-code pattern.** `[A-Z]` under `/i` is
 *      `[A-Za-z]`, which is how `export` matched. Errno codes are upper case; the
 *      pattern now is too.
 *   2. **No bare `\berror\b`.** The corpus contains 215 `error:` occurrences in
 *      successful results, and most are prose *about* errors — a note, a log line
 *      being read, a search result. Documenting an error is not committing one.
 *      A named exception (`ValueError:`) is kept, because that shape is emitted by
 *      an interpreter rather than written by an author.
 *   3. **A body that matches nothing is `ok`, not `unknown`.** Recall is a
 *      suggestion, so a false negative costs a missed hint while a false positive
 *      spends tokens on every session that does ordinary work. The asymmetry sets
 *      the direction: this table is an allowlist, and `unknown` survives only as
 *      the kind of a HARD failure whose body carries no signature.
 *
 * Re-measured after the rebuild: soft matches fell from 3,821 to a small fraction,
 * and `host-unresolvable` still catches the `web_fetch` case that motivated the
 * soft signal at all. See `research/failure-triggered-recall.md`.
 */
/** @type {ReadonlyArray<readonly [string, RegExp]>} */
const KIND_PATTERNS = Object.freeze([
  [
    'host-unresolvable',
    /resolves to a non-public IP address|Name or service not known|nodename nor servname|Could not resolve host/iu,
  ],
  ['not-a-repo', /not a git repository/iu],
  ['permission-denied', /\bEACCES\b|\bEPERM\b|Permission denied/iu],
  ['directory-not-found', /\bENOTDIR\b/iu],
  ['not-found', /\bENOENT\b|No such file or directory/iu],
  [
    'command-not-found',
    /command not found|Cannot find module|ModuleNotFoundError|\bcommand not recognized\b/iu,
  ],
  // The two broadest alternatives sit last, and their position is load-bearing.
  // `ToolCallError` and `npm ERR!` are specific sigla, but `npm ERR! code
  // ELIFECYCLE` — one of the most common npm failures — matched the named-exception
  // alternative below instead, because `ELIFECYCLE` ends in the letters `e` then a
  // colon. A signature that is specific must outrank one that is a shape.
  ['nonzero-exit', /exit code [1-9]\d*|exited with (?:code|status) [1-9]\d*|returned non-zero/iu],
  ['tool-error', /ToolCallError|npm ERR!/u],
  // Named exceptions only: `ValueError:`, `TypeError:`, `SyntaxError:` — never the
  // bare word "error", and never case-folded, so an ordinary word that happens to
  // precede a colon is not a Python panic.
  ['traceback', /Traceback \(most recent call last\)|(?:^|\s)[A-Z][A-Za-z]*(?:Error|Exception):/mu],
  ['unknown', /\bE[A-Z]{3,}\b/u],
])

/**
 * The tools whose SUCCESS can hide a failure.
 *
 * The soft signal is scoped to this list, and the scoping is the second measured
 * correction to it. Applied to every tool, a two-match soft rule fired in **31 of
 * 60** sessions — and almost all of those were benign: a `read` whose body
 * mentioned a missing file it had searched for, a `run_code` probe that printed a
 * traceback *as its result* (the failure was the thing being measured, not a
 * problem), a `grep` that found nothing. Those are the tool doing its job. What
 * the soft signal exists for is the opposite shape: a tool that reports success
 * while the work it claims to have done did not happen — `web_fetch` returning
 * `len= 0` with a wall of `ToolCallError`, or `bash` exiting zero while its log
 * says `ENOENT`.
 *
 * So the list is deliberately short: a shell, a fetcher, and the two code-running
 * tools, matched case-insensitively because the host names them `run_code` and
 * the Codex side names them `exec`. A tool that is not here can still produce a
 * HARD failure — that path is the host's own verdict and stays universal.
 */
const SOFT_CAPABLE_TOOLS = Object.freeze([
  'bash',
  'shell',
  'exec',
  'run_code',
  'run-code',
  'code',
  'web_fetch',
  'web_fetch_batch',
  'fetch',
  'curl',
])

/** Whether a tool's successful output may be inspected for error text. */
function softCapable(name) {
  const folded = String(name ?? '').toLowerCase()
  return SOFT_CAPABLE_TOOLS.includes(folded)
}

/**
 * The class of one tool result.
 *
 * @param {{message?: object, error?: unknown}} data - the `tool/result` event's `data`.
 * @param {string} [name] - the tool that produced it, when known.
 * @returns {'ok'|'hard'|'soft'} the classification.
 */
export function classifyResult(data, name = '') {
  const message = toolResultMessage(data)
  if (data?.error != null) return 'hard'
  if (message === null) return 'ok'
  // Hard: the host said so, in either of the two shapes the corpus contains
  // (719 results carry `{message,step,turn}`, 16 carry `{error,message,step,turn}`).
  // Universal: a tool the host could not run is a failure whatever the tool is.
  if (message.isError === true) return 'hard'
  if (!softCapable(name)) return 'ok'
  const text = textOf(message)
  if (text === '') return 'ok'
  return kindOf(text) === null ? 'ok' : 'soft'
}

/**
 * The error kind of a result body, or `null` when it carries no signature.
 *
 * @param {string} text - tool output text.
 * @returns {string|null} one of {@link FAILURE_KINDS}, or null.
 */
export function kindOf(text) {
  if (typeof text !== 'string' || text === '') return null
  const scanned =
    text.length > MAX_SCAN_CHARS * 2
      ? text.slice(0, MAX_SCAN_CHARS) + text.slice(-MAX_SCAN_CHARS)
      : text
  for (const [kind, pattern] of KIND_PATTERNS) {
    if (pattern.test(scanned)) return kind
  }
  return null
}

/**
 * A failure streak for one session.
 *
 * The caller feeds events in seq order and reads {@link FailureStreak.consume}
 * after each `tool/result`. State is three counters and a token set: this is a
 * signal, not a history, and nothing here is persisted or written to a vault.
 */
export class FailureStreak {
  constructor() {
    /** @type {Map<string, string>} callId → tool name, from `tool/call`. */
    this.names = new Map()
    /** @type {number} consecutive hard failures. */
    this.hard = 0
    /** @type {number} soft failures seen in the current step. */
    this.soft = 0
    /** @type {number|null} the step the soft counter belongs to. */
    this.softStep = null
    this.softTurn = null
    this.nestedRoots = new Map()
    /** @type {Set<string>} tool names seen in the current run. */
    this.tools = new Set()
    /** @type {Set<string>} error kinds seen in the current run. */
    this.kinds = new Set()
    /** @type {boolean} whether a run is already being reported. */
    this.triggered = false
  }

  /**
   * Record calls, result envelopes and nested dispatch outcomes.
   *
   * @param {object} event - one session event.
   * @returns {void}
   */
  observe(event) {
    if (event?.type === 'tool/call') {
      const callId = event.data?.callId
      const name = event.data?.name
      if (typeof callId === 'string') remember(this.names, callId, safeToolName(name))
      return
    }
    const nested = event?.type === 'tool/ptc-dispatch'
    if (!nested && event?.type !== 'tool/result') return
    const data = nested ? { ...event.data, message: event.data } : event.data
    const message = toolResultMessage(data) ?? {}
    const callId = message.toolCallId ?? message.source?.callId
    if (!nested && typeof callId === 'string') {
      const wrapper = this.nestedRoots.get(callId)
      this.nestedRoots.delete(callId)
      if (wrapper) {
        this.names.delete(callId)
        return
      }
    }
    const name = safeToolName(
      (typeof callId === 'string' ? this.names.get(callId) : undefined) ??
        (typeof event.data?.name === 'string' ? event.data.name : undefined) ??
        'unknown',
    )
    if (typeof callId === 'string') this.names.delete(callId)
    const classed = classifyResult(data, name)
    if (nested && typeof data.rootCallId === 'string') {
      remember(
        this.nestedRoots,
        data.rootCallId,
        this.nestedRoots.get(data.rootCallId) === true || classed !== 'ok',
      )
    }
    // The step is on the event's DATA, not on the event — measured against the
    // corpus, where `tool/result` carries `{turn, step, message}` inside `data`
    // and nothing at the top level. Reading `event.step` therefore yielded `null`
    // for every result, the per-step reset below never ran, and the soft counter
    // accumulated across a whole session: the per-step rule silently degraded to
    // the per-session rule it was written to replace. Both spellings are accepted
    // so a host that moves the field does not disable the rule in silence.
    const step = Number.isSafeInteger(event.data?.step)
      ? event.data.step
      : Number.isSafeInteger(event.step)
        ? event.step
        : null
    const turn = Number.isSafeInteger(data?.turn) ? data.turn : null
    if (turn !== this.softTurn || step !== this.softStep) {
      this.softTurn = turn
      this.softStep = step
      this.soft = 0
    }
    if (classed === 'ok') {
      // A success ends a run of hard failures — but only if soft scanning was
      // available for this tool at all. A result from a tool outside the scope
      // classifies as `ok` because it was never a candidate, and letting that
      // reset the counters would mean a `read` or a `grep` in the middle of a
      // failing shell run silently cancelled the run. Separately tracked, so the
      // soft counter is also untouched by an unscanned result.
      if (softCapable(name) || this.tools.has(name)) this.reset()
      return
    }
    if (classed === 'hard') {
      this.hard += 1
      this.tools.add(name)
      this.kinds.add(kindOf(textOf(message)) ?? 'unknown')
      return
    }
    // A soft failure counts only INSIDE one step, and the counter is therefore
    // per-step rather than per-run: the threshold asks "did one step produce two
    // suspicious results?", not "did two suspicious results happen anywhere in
    // this session?". The distinction is measured. Accumulating across steps made
    // the rule fire in 26 of 60 sessions — every session with two unrelated
    // single matches — while counting per step fires in 11, and the ones it drops
    // are exactly the sessions that never repeated themselves. Reset to zero on a
    // new step rather than to one, so a step with a single match is not
    // half-way to a trigger.
    if (step === null) return
    this.soft += 1
    this.tools.add(name)
    this.kinds.add(kindOf(textOf(message)) ?? 'unknown')
  }

  /**
   * Whether a run has reached its threshold since the last report.
   *
   * Returns a token set at most once per run: a run of thirteen failures must not
   * inject thirteen times, and the run itself — not a per-event flag — is the
   * unit. A success clears the run, so a session that recovers and fails again
   * later is two runs and may be reported twice, which is correct: the second
   * run is a different problem until proven otherwise.
   *
   * @returns {{hard: number, soft: number, tools: string[], kinds: string[]}|null} the run, or null.
   */
  consume() {
    if (this.triggered) return null
    const earned = this.hard >= HARD_STREAK_THRESHOLD || this.soft >= SOFT_STREAK_THRESHOLD
    if (!earned) return null
    if (this.tools.size === 0 && this.kinds.size === 0) return null
    this.triggered = true
    return {
      hard: this.hard,
      soft: this.soft,
      tools: [...this.tools].sort(),
      kinds: [...this.kinds].sort(),
    }
  }

  /** Forget the current run. Called on any success, so runs cannot span one. */
  reset() {
    this.hard = 0
    this.soft = 0
    this.softStep = null
    this.softTurn = null
    this.tools.clear()
    this.kinds.clear()
    this.triggered = false
  }
}

/**
 * The retrieval query for one reported run.
 *
 * Both halves are bounded: at most three tool names and two error kinds, longest
 * first, because a query is a search string rather than a report and the vault's
 * notes are titled by symptom. The kind is included ahead of the tool name
 * because "ENOENT" is more distinctive than "bash" — every session uses `bash`,
 * so a query of bare tool names would match everything and rank nothing.
 *
 * Returns `null` when the run carries no token at all, which a caller must treat
 * as "no query" rather than "search for the empty string".
 *
 * @param {{tools?: string[], kinds?: string[]}} run - one {@link FailureStreak.consume} result.
 * @returns {string|null} the query, or null.
 */
export function queryForFailure(run) {
  const tools = Array.isArray(run?.tools)
    ? run.tools
        .map(safeToolName)
        .filter((name) => name !== 'unknown' || run.tools.includes('unknown'))
    : []
  const kinds = Array.isArray(run?.kinds)
    ? run.kinds.filter((kind) => FAILURE_KINDS.includes(kind))
    : []
  const pick = (values, limit) =>
    [...new Set(values.filter((value) => typeof value === 'string' && value !== ''))]
      .sort((a, b) => b.length - a.length || a.localeCompare(b))
      .slice(0, limit)
  const selected = pick(kinds, 2)
  const tokens = [
    ...selected.flatMap((kind) => [QUERY_ALIASES[kind], kind]).filter(Boolean),
    ...pick(tools, 3),
  ]
  if (tokens.length === 0) return null
  return tokens.join(' ')
}

/** The concatenated `text` parts of a tool result message. */
function textOf(message) {
  const content = message?.content
  if (!Array.isArray(content)) return ''
  let head = ''
  let tail = ''
  for (const part of content) {
    if (part !== null && typeof part === 'object' && typeof part.text === 'string') {
      if (head.length < MAX_SCAN_CHARS)
        head = (head + '\n' + part.text.slice(0, MAX_SCAN_CHARS - head.length)).slice(
          0,
          MAX_SCAN_CHARS,
        )
      tail = (tail + '\n' + part.text.slice(-MAX_SCAN_CHARS)).slice(-MAX_SCAN_CHARS)
    }
  }
  return head + '\n' + tail
}
