// The bounded automatic reviewer for parked executable proposals (curation review
// panel, Task 1).
//
// A proposal is parked because publishing it is a semantic decision. `lib/distill.js`
// writes one, `lib/curation-review.js` executes one, and this module is the third
// route: a model may decide the confident, mechanical-looking ones so a project can
// run for months without a terminal visit. Everything here is a bound on that power,
// and each bound is one of the module's properties:
//
//   * **One write path.** Every decision goes through `reviewCurationProposal`, the
//     same function the TTY command and the panel use. This module never writes a
//     note itself, never re-checks a state the review already claimed, and records
//     its provenance (`decidedBy: 'auto'`, the model route, its own note) through the
//     store's one transition.
//   * **Evidence first, model second.** Every source hash is re-read before a call
//     is spent. A candidate whose bytes moved is retired with a decision note — no
//     future decision could ever apply it — and no model sees it.
//   * **A strict verdict contract.** One JSON object with exactly
//     `{verdict, confidence, reason}`; prose, extra keys, an unknown verdict or a
//     non-finite/out-of-range confidence refuse the whole answer (the candidate
//     defers). Only `apply`/`reject` at confidence ≥ `minConfidence` act.
//   * **Hard measured bounds.** At most 3 candidates per pass, ≤ 12,000 characters
//     of judge input, 45 s per call composed with the pass signal through
//     `AbortSignal.any`, and a 5-minute per-project cooldown / one in-flight pass
//     owned by `lib/index.js`. These are constants, not config: a bound an operator
//     can raise is not a bound.
//   * **Nothing-to-do is free, and a model failure is not a pass failure.** No
//     route, no `llm.stream`, `autoReview: false`, or an empty queue costs no call;
//     an aborted/error/truncated stream, a tool call, a thrown stream or a
//     contract-violating answer leaves that row `pending` and the pass continues.
//
// The route is the explicit `distill.provider`/`distill.model` pair, or — when that
// pair is empty — the route the capture seam last observed for the project
// (`lib/route-state.js`), so the default configuration can review after a normal
// conversation instead of waiting for an operator route. No evidence of either is
// `no-route`, never a guessed provider. One content-free `curation` diagnostic with
// outcome `auto-reviewed` records the pass; it carries counts only — no id, path or
// note.
import { randomUUID } from 'node:crypto'

import {
  CurationError,
  listCurationProposals,
  markCurationProposal,
  readCurationProposal,
} from './curation-proposals.js'
import { readProposalEvidence, reviewCurationProposal } from './curation-review.js'
import { recordDiagnostic } from './debug.js'
import { readRememberedRoute } from './route-state.js'
// The ledger that answers "did an application of this key already start?". It is a
// downward edge (transaction L3 → this L7), the same direction `curation-review`
// already uses for its own `review-recovery-required` guard.
import { hasTransactionEvidence } from './transaction.js'

/**
 * The measured bounds of one automatic review pass.
 *
 * Frozen, not configurable: every number is a ceiling a pass is allowed to spend,
 * and a key an operator can raise would stop being one. `maxPerPass`, `minConfidence`
 * and `maxInputChars`/`timeoutMs` can be *lowered* by a caller (a test, or a caller
 * with a stricter budget), never raised.
 */
export const AUTO_REVIEW_DEFAULTS = Object.freeze({
  maxPerPass: 3,
  minConfidence: 0.8,
  maxInputChars: 12000,
  timeoutMs: 45000,
  maxReasonChars: 500,
})

/**
 * The judge's rubric, and the only place the answer contract is stated to a model.
 *
 * It is deliberately blunt about the value of `defer`: the shipped defect this
 * feature replaces is a queue that never drains, and a reviewer that guesses in
 * order to act would be worse than the queue. The JSON shape is quoted exactly as
 * `parseAutoReviewAnswer` enforces it, so the instruction and the parser cannot
 * describe two different contracts.
 */
export const AUTO_REVIEW_SYSTEM_PROMPT = [
  'You are the automatic memory reviewer of an Obsidian project-memory plugin.',
  'A parked candidate is a proposed change to the vault that no human has read yet.',
  'There are two executable operations:',
  '- supersede: publish a distilled conclusion as a new note and move the named existing note to status "superseded";',
  '- create-separate: publish a distilled candidate as its own note beside an existing note it twins.',
  'Apply only when the candidate is self-contained, its evidence supports it, and the operation is obviously safe and useful:',
  'a supersede whose body genuinely replaces the old conclusion, or a create-separate whose body carries a distinct, useful claim the twin does not.',
  'Reject only when the candidate is clearly wrong or harmful: it duplicates the existing note without adding anything, it contradicts its evidence, or publishing it would lose information a reader still needs.',
  'Defer whenever you are not confident: thin or missing evidence, a body that might lose information, a target that is not what the candidate claims, or any uncertainty about the right operation.',
  'Never guess to empty a queue. Deferring is a correct and common answer.',
  'Answer with ONE JSON object only, with exactly these three keys and nothing else:',
  '{"verdict":"apply"|"reject"|"defer","confidence":<number between 0 and 1>,"reason":"<one short sentence>"}',
  'Do not use Markdown, do not add prose before or after the object, and do not call tools.',
].join('\n')

/** The judge is allowed to answer only these three verdicts. */
const VERDICTS = Object.freeze(['apply', 'reject', 'defer'])
/** The exact key set one answer may carry. */
const ANSWER_KEYS = Object.freeze(['verdict', 'confidence', 'reason'])
/** The longest body the judge sees of the note a candidate touches. */
const MAX_TARGET_BODY_CHARS = 3000
/** The most sources one judge request names, so the request stays bounded. */
const MAX_REQUEST_SOURCES = 20
/** The answer is one short sentence; a large budget only invites prose. */
const MAX_ANSWER_TOKENS = 600
/** The last eight code points of a clipped body name the cut explicitly. */
const CLIP_MARKER = '\n…(truncated)'

/**
 * A contract violation in a judge answer, or a malformed request to build one.
 *
 * This error never escapes a pass: the candidate whose answer violated the contract
 * defers, and the module keeps whatever it had collected.
 */
export class AutoReviewError extends Error {
  /**
   * @param {string} code - machine-readable reason (`not-json`, `verdict`, `confidence`, …).
   * @param {string} message - human-readable reason naming the offending value.
   * @param {{ cause?: Error }} [options] - the underlying failure, when there is one.
   */
  constructor(code, message, options) {
    super(message, options)
    this.name = 'AutoReviewError'
    this.code = code
  }
}

/** A model-side failure of one judge call; the candidate defers, the pass continues. */
class AutoReviewModelError extends Error {
  /**
   * @param {string} code - one of `aborted`, `timeout`, `stream-error`, `tool-call`, `truncated`, `finish-missing`, `stream-invalid`.
   * @param {string} message - human-readable reason.
   * @param {{ cause?: Error }} [options] - the underlying failure.
   */
  constructor(code, message, options) {
    super(message, options)
    this.name = 'AutoReviewModelError'
    this.code = code
  }
}

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

/**
 * A value as the judge text spells it, without trusting its type.
 *
 * @param {unknown} value - the value.
 * @returns {string} the string, or ''.
 */
function textOf(value) {
  return typeof value === 'string' ? value : ''
}

/**
 * Cut one string to a code-point budget, keeping a visible marker when it was cut.
 *
 * @param {string} text - the text.
 * @param {number} maxChars - the budget; `0` is the empty answer.
 * @returns {string} the text within `maxChars` code points.
 */
function clipText(text, maxChars) {
  const points = [...text]
  if (maxChars <= 0) return ''
  if (points.length <= maxChars) return text
  if (maxChars <= CLIP_MARKER.length + 1) return points.slice(0, maxChars).join('')
  return `${points.slice(0, maxChars - CLIP_MARKER.length).join('')}${CLIP_MARKER}`
}

/**
 * The number of code points a string holds — the unit every judge bound counts in.
 *
 * @param {string} text - the text.
 * @returns {number} its code-point length.
 */
function codePoints(text) {
  return [...text].length
}

/**
 * The body one note shows the judge: bounded, with the cut named in the text.
 *
 * @param {string} body - the note body.
 * @param {number} maxChars - the budget.
 * @returns {string} the bounded body.
 */
function clipBody(body, maxChars) {
  return clipText(body, Math.max(0, maxChars))
}

/**
 * The block a judge request prints for the one note a candidate touches.
 *
 * @param {object|null} target - the note read for this candidate, if there is one.
 * @returns {string[]} the lines.
 */
function targetLinesOf(target) {
  if (target === null || target === undefined) {
    return ['(none: the candidate touches no readable existing note)']
  }
  return [
    `path: ${textOf(target.path)}`,
    `title: ${textOf(target.title)}`,
    `status: ${textOf(target.status)}`,
    'body:',
    clipBody(textOf(target.body), MAX_TARGET_BODY_CHARS),
  ]
}

/**
 * The route a background pass may use, or `null` when the pair is not configured.
 *
 * Both halves are required by spec R3: an empty pair means "reuse the session's last
 * route", which a background trigger cannot know, so it is reported as `no-route`
 * and the queue waits for a human route instead of a guessed one.
 *
 * Exported as the one predicate three gates read: this pass
 * (`autoReviewPendingProposals`), the host trigger (`lib/index.js`) and the panel's
 * `auto.routeConfigured` (`lib/services.js`). Three hand-copied "is it configured"
 * checks could disagree — the panel telling a user the route is set while the
 * trigger stays silent — so they all point at this function instead.
 *
 * @param {object} config - the validated plugin config.
 * @returns {{provider: string, model: string}|null} the route, or `null`.
 */
export function reviewRouteOf(config) {
  const distill = config?.distill
  if (typeof distill?.provider !== 'string' || distill.provider === '') return null
  if (typeof distill?.model !== 'string' || distill.model === '') return null
  return { provider: distill.provider, model: distill.model }
}

/**
 * Whether the host service can make a streaming call at all.
 *
 * P0 measured `ctx.get('llm')` as `undefined` during `apply`, so a service without
 * `stream` is treated exactly like a missing one: the pass skips instead of failing
 * on a call that cannot be made.
 *
 * @param {unknown} llm - the host `llm` service, when present.
 * @returns {boolean} whether a stream call is possible.
 */
function hasStream(llm) {
  return typeof (/** @type {any} */ (llm)?.stream) === 'function'
}

// ---------------------------------------------------------------------------
// The pure request/answer halves
// ---------------------------------------------------------------------------

/**
 * Build the one judge request for a parked candidate, without calling a model.
 *
 * Pure, deterministic and bounded by construction: the candidate body is clipped to
 * whatever the 12,000-code-point ceiling has left after the fixed sections, and the
 * final text is clamped again so no input shape can exceed it. `target` is the note
 * this candidate is about — for a supersede the note whose status would move, for a
 * create-separate the twin it would sit beside — and a candidate with no readable
 * target still gets a bounded request that names the absence.
 *
 * @param {{proposal: object, target: object|null}} input - the stored proposal and the note it touches.
 * @returns {{system: string, user: string}} the request.
 * @throws {RangeError} when there is no executable proposal to judge.
 */
export function buildAutoReviewRequest({ proposal, target }) {
  if (proposal === null || typeof proposal !== 'object' || Array.isArray(proposal)) {
    throw new RangeError('building an automatic review needs the stored proposal record')
  }
  const operation = proposal.operation
  if (operation === null || typeof operation !== 'object' || Array.isArray(operation)) {
    throw new RangeError('an automatic review only asks about an executable proposal')
  }
  const item = operation.item ?? {}
  const sources = Array.isArray(proposal.sources)
    ? proposal.sources.slice(0, MAX_REQUEST_SOURCES)
    : []
  const targetLabel =
    operation.kind === 'supersede'
      ? 'NOTE THE SUPERSEDE WOULD MOVE'
      : 'EXISTING NOTE THIS CANDIDATE WOULD SIT BESIDE'
  const prefix = [
    'CANDIDATE TO REVIEW',
    `kind: ${textOf(proposal.kind)}`,
    `operation: ${textOf(operation.kind)}`,
    `reason: ${textOf(proposal.reason) || '(none)'}`,
    `title: ${textOf(item.title)}`,
    '',
    'CANDIDATE BODY',
    '',
  ].join('\n')
  const suffix = [
    '',
    'CURRENT EVIDENCE (vault-relative paths as they were scanned)',
    ...(sources.length === 0
      ? ['(none)']
      : sources.map((source) => `- ${textOf(source?.path) || '(unnamed)'}`)),
    '',
    targetLabel,
    ...targetLinesOf(target),
    '',
    'ANSWER WITH ONE JSON OBJECT ONLY, exactly:',
    '{"verdict":"apply"|"reject"|"defer","confidence":<number 0..1>,"reason":"<one short sentence>"}',
  ].join('\n')
  // The body gets exactly what the fixed sections leave of the measured ceiling.
  const bodyBudget = Math.max(
    0,
    AUTO_REVIEW_DEFAULTS.maxInputChars - codePoints(prefix) - codePoints(suffix) - 1,
  )
  const user = `${prefix}${clipBody(textOf(item.body), bodyBudget)}${suffix}`
  return {
    system: AUTO_REVIEW_SYSTEM_PROMPT,
    user: clipText(user, AUTO_REVIEW_DEFAULTS.maxInputChars),
  }
}

/**
 * Parse one judge answer into the closed verdict contract, or refuse it whole.
 *
 * The contract is deliberately unforgiving (spec R5): exactly one JSON object with
 * exactly `{verdict, confidence, reason}`; an array, `null`, prose, a second object,
 * an extra key, an unknown verdict, a missing/non-finite/out-of-range confidence or
 * a non-string reason are all refusals. A parser that recovered a verdict from
 * something close to the contract would decide a note on an answer the model did not
 * actually give.
 *
 * @param {unknown} text - the model's raw output.
 * @returns {{verdict: 'apply'|'reject'|'defer', confidence: number, reason: string}} the verdict, with its reason clipped to `maxReasonChars`.
 * @throws {AutoReviewError} with a code when the answer violates the contract.
 */
export function parseAutoReviewAnswer(text) {
  const source = typeof text === 'string' ? text.trim() : ''
  if (source === '') throw new AutoReviewError('empty-answer', 'the reviewer answered nothing')
  let value
  try {
    value = JSON.parse(source)
  } catch (cause) {
    throw new AutoReviewError(
      'not-json',
      'the reviewer answer is not exactly one JSON object',
      /** @type {Error} */ (cause),
    )
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new AutoReviewError('not-object', 'the reviewer answer must be one JSON object')
  }
  const keys = Object.keys(value)
  const extra = keys.filter((key) => !ANSWER_KEYS.includes(key))
  if (extra.length > 0) {
    throw new AutoReviewError(
      'extra-keys',
      `the reviewer answer carries keys the contract does not define: ${extra.join(', ')}`,
    )
  }
  const missing = ANSWER_KEYS.filter((key) => !keys.includes(key))
  if (missing.length > 0) {
    throw new AutoReviewError(
      'missing-keys',
      `the reviewer answer is missing ${missing.join(', ')}`,
    )
  }
  if (!VERDICTS.includes(value.verdict)) {
    throw new AutoReviewError(
      'verdict',
      `the reviewer verdict must be one of ${VERDICTS.join(', ')}, not ${JSON.stringify(value.verdict)}`,
    )
  }
  const confidence = value.confidence
  if (
    typeof confidence !== 'number' ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1
  ) {
    throw new AutoReviewError(
      'confidence',
      `the reviewer confidence must be a finite number in 0..1, not ${JSON.stringify(confidence)}`,
    )
  }
  if (typeof value.reason !== 'string') {
    throw new AutoReviewError('reason', 'the reviewer reason must be a string')
  }
  return {
    verdict: value.verdict,
    confidence,
    reason: clipText(value.reason, AUTO_REVIEW_DEFAULTS.maxReasonChars),
  }
}

// ---------------------------------------------------------------------------
// The one judge call
// ---------------------------------------------------------------------------

/**
 * Await a thenable stream and require an async iterable.
 *
 * `llm.stream()` returns an iterable synchronously when no `llm/stream` listener is
 * installed, but the host waterfall can hand back a thenable; only that is awaited.
 *
 * @param {unknown} value - what `llm.stream` returned.
 * @returns {Promise<AsyncIterable<object>>} the stream.
 * @throws {AutoReviewModelError} with code `stream-invalid` when it is not iterable.
 */
async function resolveStream(value) {
  const resolved =
    value !== null &&
    typeof value === 'object' &&
    typeof (/** @type {any} */ (value).then) === 'function'
      ? await value
      : value
  if (
    resolved === null ||
    typeof resolved !== 'object' ||
    typeof (/** @type {any} */ (resolved)[Symbol.asyncIterator]) !== 'function'
  ) {
    throw new AutoReviewModelError('stream-invalid', 'llm.stream did not return an async iterable')
  }
  return /** @type {AsyncIterable<object>} */ (resolved)
}

/**
 * Whether a chunk announces a tool call of any shape.
 *
 * @param {object} chunk - one stream chunk.
 * @returns {boolean} true when it is a tool call.
 */
function isToolChunk(chunk) {
  if (
    chunk.type === 'tool-call-delta' ||
    chunk.type === 'tool-call' ||
    chunk.type === 'tool-calls'
  ) {
    return true
  }
  const blockType = /** @type {any} */ (chunk).block?.type
  return typeof blockType === 'string' && blockType.includes('tool')
}

/**
 * Classify a terminal `aborted` chunk from the composed signal, never its message.
 *
 * `failure.message` is "…aborted by caller" for both a caller cancel and a timeout,
 * so the composed signal's `reason.name` is the only verdict (the measured pattern
 * of `lib/distill.js`). An unknown reason is reported as a cancel: claiming a
 * timeout the host never announced would be inventing a cause.
 *
 * @param {AbortSignal} requestSignal - the composed signal.
 * @param {AbortSignal} timeoutSignal - the timeout half.
 * @param {AbortSignal} callerSignal - the pass half.
 * @returns {string} `timeout` or `aborted`.
 */
function abortCode(requestSignal, timeoutSignal, callerSignal) {
  const name = /** @type {any} */ (requestSignal)?.reason?.name
  if (name === 'TimeoutError') return 'timeout'
  if (name === 'AbortError') return 'aborted'
  if (timeoutSignal?.aborted === true) return 'timeout'
  if (callerSignal?.aborted === true) return 'aborted'
  return 'aborted'
}

/**
 * Issue the one tool-free judge call and read its terminal chunk.
 *
 * The request shape is the measured host contract: provider/model, a system prompt,
 * one user text message and `maxTokens`, with the 45 s timeout composed against the
 * pass signal so either can stop it. Text blocks are the only output harvested (a
 * reasoning delta is not an answer); the terminal chunk decides the outcome.
 *
 * @param {{llm: object, route: {provider: string, model: string}, request: {system: string, user: string}, signal?: AbortSignal, timeoutMs: number}} input - the call.
 * @returns {Promise<{raw: string, chars: number}>} the answer text and its input size.
 * @throws {AutoReviewModelError} naming the model-side failure.
 */
async function callReviewModel({ llm, route, request, signal, timeoutMs }) {
  const timeout = AbortSignal.timeout(timeoutMs)
  const caller = signal ?? new AbortController().signal
  const requestSignal = AbortSignal.any([caller, timeout])
  const options = {
    provider: route.provider,
    model: route.model,
    system: request.system,
    messages: [
      {
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: request.user }],
        source: { kind: 'user' },
      },
    ],
    maxTokens: MAX_ANSWER_TOKENS,
    signal: requestSignal,
  }
  let stream
  try {
    // A service can refuse *before* returning a stream (no adapter, a busy host, a
    // synchronous configuration error). That is the same model-side failure as a
    // thrown iteration, and must defer this row rather than fail the pass.
    stream = await resolveStream(/** @type {any} */ (llm).stream(options))
  } catch (cause) {
    if (cause instanceof AutoReviewModelError) throw cause
    throw new AutoReviewModelError(
      'stream-error',
      `review-stream refused: ${/** @type {any} */ (cause)?.message ?? 'unknown'}`,
      /** @type {Error} */ (cause),
    )
  }
  const textByIndex = new Map()
  let finishReason = null
  let sawTool = false
  try {
    for await (const chunk of stream) {
      if (chunk === null || typeof chunk !== 'object') continue
      const typed = /** @type {any} */ (chunk)
      if (typed.type === 'text-delta' && typeof typed.text === 'string') {
        const index = Number.isSafeInteger(typed.index) ? typed.index : 0
        textByIndex.set(index, (textByIndex.get(index) ?? '') + typed.text)
      }
      if (
        typed.type === 'block-end' &&
        typed.block?.type === 'text' &&
        typeof typed.block.text === 'string'
      ) {
        textByIndex.set(Number.isSafeInteger(typed.index) ? typed.index : 0, typed.block.text)
      }
      if (isToolChunk(typed)) sawTool = true
      if (typed.type === 'finish') finishReason = typed.reason ?? null
    }
  } catch (cause) {
    // A transport that fails mid-iteration is exactly the measured behaviour the
    // terminal chunk's `error` reason covers for a well-behaved host service; a
    // service that throws instead must defer the same candidate, not fail the pass.
    throw new AutoReviewModelError(
      'stream-error',
      `review-stream threw: ${/** @type {any} */ (cause)?.message ?? 'unknown'}`,
      /** @type {Error} */ (cause),
    )
  }
  const kind = /** @type {any} */ (finishReason)?.kind
  if (sawTool || kind === 'tool-calls') {
    throw new AutoReviewModelError(
      'tool-call',
      `review-finish:${kind ?? 'missing'} — a tool call is never permitted`,
    )
  }
  if (kind === 'aborted') {
    const code = abortCode(requestSignal, timeout, caller)
    throw new AutoReviewModelError(code, `review-finish:aborted (${code})`)
  }
  if (kind === 'error') {
    const failureCode = /** @type {any} */ (finishReason)?.failure?.code
    throw new AutoReviewModelError(
      'stream-error',
      `review-finish:error${typeof failureCode === 'string' ? `:${failureCode}` : ''}`,
    )
  }
  if (kind === 'max-tokens') {
    throw new AutoReviewModelError(
      'truncated',
      'review-finish:max-tokens — an incomplete answer is never a verdict',
    )
  }
  if (kind !== 'stop') {
    throw new AutoReviewModelError('finish-missing', `review-finish:${kind ?? 'missing'}`)
  }
  const raw = [...textByIndex]
    .sort(([left], [right]) => left - right)
    .map(([, text]) => text)
    .join('')
  return { raw, chars: codePoints(request.user) }
}

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

/**
 * The note a judge request prints for one candidate, or `null` when none is readable.
 *
 * A supersede names the note whose status the write moves; a create-separate names
 * the twin it would sit beside. Both are the proposal's own sources, read by
 * `readProposalEvidence` — never another project's note.
 *
 * @param {object} proposal - the stored proposal.
 * @param {{notes: object[]}} evidence - the notes that were read for its sources.
 * @returns {object|null} the note block, or `null`.
 */
function judgeTargetOf(proposal, evidence) {
  const notes = Array.isArray(evidence?.notes) ? evidence.notes : []
  if (proposal.operation?.kind === 'supersede') {
    const supersedesId = proposal.operation.supersedesId
    const named = notes.find((note) => note.id === supersedesId)
    if (named !== undefined) return named
  }
  return notes[0] ?? null
}

/**
 * Whether this failure is a per-candidate refusal a pass reports instead of throwing.
 *
 * @param {unknown} error - the thrown value.
 * @returns {string|null} the refusal code, or `null` when it is not a refusal.
 */
function refusalCodeOf(error) {
  if (error instanceof CurationError) return error.code
  if (typeof (/** @type {any} */ (error)?.code) === 'string') {
    return /** @type {any} */ (error).code
  }
  return null
}

/**
 * Review one parked candidate: re-read its evidence, judge it, and decide it through
 * `reviewCurationProposal`.
 *
 * The order is the contract. Evidence is re-read first, and any source whose hash
 * moved retires the record before a call is spent (R6) — with one exception (A4): a
 * hit in the transaction ledger means a crashed application of this candidate may
 * already have committed the bytes, so the row is *left pending* with a
 * `review-recovery-required` refusal instead of being retired as stale evidence. The
 * judge sees only the candidate, the vault-relative evidence paths and the one note
 * it touches (R5). Only `apply`/`reject` at confidence ≥ `minConfidence` reach the
 * write path; every other answer, and every model-side failure, defers the candidate
 * and keeps the pass going.
 *
 * @param {object} input - the candidate, the route, the seams and the bounds.
 * @returns {Promise<{kind: 'applied'|'rejected'|'retired'|'deferred'|'refused'|'skip', code?: string, chars?: number}>} what happened to the candidate.
 */
async function reviewOneCandidate({
  binding,
  dataRoot,
  home,
  route,
  model,
  row,
  llm,
  now,
  minConfidence,
  maxInputChars,
  timeoutMs,
  signal,
  hasEvidence,
}) {
  const proposal = await readCurationProposal({
    dataRoot,
    projectId: binding.projectId,
    proposalId: row.proposalId,
  })
  // A record another writer decided or retired between the listing and this read is
  // simply not this pass's candidate any more.
  if (proposal === null || proposal.state !== 'pending' || proposal.operation === null) {
    return { kind: 'skip' }
  }
  let request
  try {
    const evidence = await readProposalEvidence(binding, proposal, { maxBodyChars: maxInputChars })
    if (evidence.sources.some((source) => source.matched !== true)) {
      // A moved hash means the candidate's evidence is gone — with one exception: a
      // *crashed apply*. The transaction may have committed the vault bytes and died
      // before marking the record, which is the state `reviewCurationProposal`'s own
      // `review-recovery-required` guard exists for. Retiring here would erase the
      // only evidence that a recovery is owed, so the ledger is consulted first and
      // the row is left pending (fail closed) when it cannot be cleared.
      let started
      try {
        started = await hasEvidence(binding, proposal.itemKey, { dataRoot, home })
      } catch {
        return { kind: 'refused', code: 'review-recovery-required' }
      }
      if (started === true) return { kind: 'refused', code: 'review-recovery-required' }
      await markCurationProposal({
        binding,
        dataRoot,
        proposalId: proposal.proposalId,
        state: 'retired',
        reason: 'an automatic review found the evidence changed before a decision',
        decidedBy: 'auto',
        now,
        home,
      })
      return { kind: 'retired' }
    }
    const target = judgeTargetOf(proposal, evidence)
    // Without the note the candidate touches there is nothing to judge; the row waits
    // for a human or a later pass rather than being decided blind.
    if (target === null) return { kind: 'deferred' }
    request = buildAutoReviewRequest({ proposal, target })
  } catch (error) {
    // A JSON-readable record whose operation is not a plan (or whose sources are not
    // a source list) is damaged state, not a pass-fatal defect: answer it as this
    // one candidate's refusal so it cannot poison every later oldest-first batch.
    if (error instanceof RangeError) return { kind: 'refused', code: 'proposal-invalid' }
    throw error
  }
  // A caller may lower the ceiling; the builder already enforces the measured one.
  const judged = { system: request.system, user: clipText(request.user, maxInputChars) }
  let raw
  let chars
  try {
    const outcome = await callReviewModel({ llm, route, request: judged, signal, timeoutMs })
    raw = outcome.raw
    chars = outcome.chars
  } catch (error) {
    if (error instanceof AutoReviewModelError) return { kind: 'deferred', chars: 0 }
    throw error
  }
  let verdict
  try {
    verdict = parseAutoReviewAnswer(raw)
  } catch (error) {
    // A contract violation is the model's answer being unusable, not a pass failure:
    // the candidate defers exactly like a deferral it had stated itself.
    if (error instanceof AutoReviewError) return { kind: 'deferred', chars }
    throw error
  }
  if (
    (verdict.verdict !== 'apply' && verdict.verdict !== 'reject') ||
    verdict.confidence < minConfidence
  ) {
    return { kind: 'deferred', chars }
  }
  const answer = await reviewCurationProposal({
    dataRoot,
    proposalId: proposal.proposalId,
    decision: verdict.verdict,
    binding,
    now,
    home,
    reviewer: { kind: 'auto', model, note: verdict.reason },
  })
  if (answer.status === 'applied') return { kind: 'applied', chars }
  if (answer.status === 'rejected') return { kind: 'rejected', chars }
  return { kind: 'refused', code: answer.code, chars }
}

/**
 * The one external entry point: review up to `maxPerPass` parked executable
 * proposals of one bound project, oldest first.
 *
 * The pass answers instead of throwing for everything a model, a service or the
 * queue can do: `{status:'skipped', reason}` for a disabled reviewer, an unconfigured
 * route, a missing stream or an empty queue; `{status:'reviewed', ...}` for a pass
 * that ran (including one where every candidate deferred); `{status:'failed'}` only
 * for a queue the store cannot read. A success records one content-free `curation`
 * diagnostic with the pass's counts — no id, no path, no note text.
 *
 * @param {{binding: object, dataRoot: string, home?: string, config?: object, llm?: object|null, now?: Date, diagnostics?: object|null, maxPerPass?: number, minConfidence?: number, maxInputChars?: number, timeoutMs?: number, clock?: () => number, signal?: AbortSignal, hasEvidence?: Function}} input - the pass inputs; `hasEvidence(binding, key, {dataRoot, home})` defaults to the transaction ledger's own check and exists so a test can drive the crash-recovery branch.
 * @returns {Promise<{status: 'reviewed'|'skipped'|'failed', reason?: string, inspected: number, applied: string[], rejected: string[], retired: string[], deferred: string[], refused: Array<{proposalId: string, code: string}>, model: string|null, truncated: boolean}>} the pass summary; `truncated` names a pending listing that hit the store's 200-row cap (the oldest rows are then outside this pass's sight).
 * @throws {RangeError} when a bound, the clock, the role or the option type is unusable.
 */
export async function autoReviewPendingProposals({
  binding,
  dataRoot,
  home,
  config = {},
  llm = null,
  now = new Date(),
  diagnostics = null,
  maxPerPass = AUTO_REVIEW_DEFAULTS.maxPerPass,
  minConfidence = AUTO_REVIEW_DEFAULTS.minConfidence,
  maxInputChars = AUTO_REVIEW_DEFAULTS.maxInputChars,
  timeoutMs = AUTO_REVIEW_DEFAULTS.timeoutMs,
  clock = () => Date.now(),
  signal,
  hasEvidence = hasTransactionEvidence,
}) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new RangeError('an automatic review clock must be a valid Date')
  }
  if (typeof clock !== 'function') {
    throw new RangeError('an automatic review accepts only a function as clock')
  }
  // The measured bounds are ceilings: a caller may tighten one, never widen it.
  if (
    !Number.isSafeInteger(maxPerPass) ||
    maxPerPass < 1 ||
    maxPerPass > AUTO_REVIEW_DEFAULTS.maxPerPass
  ) {
    throw new RangeError(`maxPerPass must be an integer in 1..${AUTO_REVIEW_DEFAULTS.maxPerPass}`)
  }
  if (
    typeof minConfidence !== 'number' ||
    !Number.isFinite(minConfidence) ||
    minConfidence < 0 ||
    minConfidence > 1
  ) {
    throw new RangeError('minConfidence must be a finite number in 0..1')
  }
  if (
    !Number.isSafeInteger(maxInputChars) ||
    maxInputChars < 256 ||
    maxInputChars > AUTO_REVIEW_DEFAULTS.maxInputChars
  ) {
    throw new RangeError(
      `maxInputChars must be an integer in 256..${AUTO_REVIEW_DEFAULTS.maxInputChars}`,
    )
  }
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1000 ||
    timeoutMs > AUTO_REVIEW_DEFAULTS.timeoutMs
  ) {
    throw new RangeError(`timeoutMs must be an integer in 1000..${AUTO_REVIEW_DEFAULTS.timeoutMs}`)
  }
  if (
    signal !== undefined &&
    signal !== null &&
    typeof (/** @type {any} */ (signal).aborted) !== 'boolean'
  ) {
    throw new RangeError('an automatic review accepts only an AbortSignal as signal')
  }
  if (typeof hasEvidence !== 'function') {
    throw new RangeError('an automatic review accepts only a function as hasEvidence')
  }
  const skipped = (reason, truncated = false) => ({
    status: 'skipped',
    reason,
    inspected: 0,
    applied: [],
    rejected: [],
    retired: [],
    deferred: [],
    refused: [],
    model: null,
    truncated,
  })
  // `autoReview: false` disables only the automatic reviewer; the panel and the TTY
  // command are separate routes and stay available.
  if (config?.autoReview === false) return skipped('disabled')
  // Configured route first; the remember-last-observed fallback is what lets the
  // default configuration work. `reviewRouteOf` stays the explicit-only predicate
  // the other gates import, but it is no longer the whole answer to "may a pass run".
  const route =
    reviewRouteOf(config) ??
    (await readRememberedRoute({
      dataRoot,
      projectId: /** @type {any} */ (binding)?.projectId,
      now,
    }))
  if (route === null || !hasStream(llm)) return skipped('no-route')
  const model = `${route.provider}/${route.model}`
  const started = clock()
  let listing
  try {
    listing = await listCurationProposals({
      dataRoot,
      projectId: /** @type {any} */ (binding)?.projectId,
      state: 'pending',
    })
  } catch (error) {
    // A queue this pass cannot read is reported, never thrown: the caller is a
    // background trigger whose only useful answer is one diagnostic.
    const code = refusalCodeOf(error)
    if (code === null) throw error
    recordDiagnostic(diagnostics, 'curation', {
      outcome: 'failed',
      code,
      projectId:
        typeof (/** @type {any} */ (binding)?.projectId) === 'string'
          ? /** @type {any} */ (binding).projectId
          : undefined,
    })
    return {
      status: 'failed',
      reason: code,
      inspected: 0,
      applied: [],
      rejected: [],
      retired: [],
      deferred: [],
      refused: [],
      model,
      truncated: false,
    }
  }
  // The listing is the store's bounded page (200 newest first). A page that hit its
  // cap means the oldest pending rows are outside this pass's sight; the summary says
  // so instead of presenting a starved batch as a clean pass. Paging is a later
  // round; the visibility is what this pass must not hide.
  const listingTruncated = listing.truncated === true
  const rows = listing.proposals.filter((row) => row.reviewOnly !== true)
  if (rows.length === 0) return skipped('no-pending', listingTruncated)
  // Oldest first: a review queue that forgot its oldest rows would starve exactly
  // the candidates a user has been waiting on longest. The id breaks a tie on
  // created-at so two passes over the same store inspect the same order.
  rows.sort((left, right) =>
    left.createdAt === right.createdAt
      ? left.proposalId < right.proposalId
        ? -1
        : 1
      : left.createdAt < right.createdAt
        ? -1
        : 1,
  )
  const summary = {
    status: /** @type {'reviewed'} */ ('reviewed'),
    inspected: 0,
    applied: [],
    rejected: [],
    retired: [],
    deferred: [],
    refused: [],
    model,
    truncated: listingTruncated,
  }
  let inputChars = 0
  for (const row of rows.slice(0, maxPerPass)) {
    summary.inspected += 1
    let outcome
    try {
      outcome = await reviewOneCandidate({
        binding,
        dataRoot,
        home,
        route,
        model,
        row,
        llm,
        now,
        minConfidence,
        maxInputChars,
        timeoutMs,
        signal,
        hasEvidence,
      })
    } catch (error) {
      // One candidate's refusal is an answer the summary carries; a programming
      // error (no refusal code) still escapes, because it is a defect, not a pass
      // outcome the caller could report meaningfully.
      const code = refusalCodeOf(error)
      if (code === null) throw error
      summary.refused.push({ proposalId: row.proposalId, code })
      continue
    }
    inputChars += outcome.chars ?? 0
    if (outcome.kind === 'applied') summary.applied.push(row.proposalId)
    else if (outcome.kind === 'rejected') summary.rejected.push(row.proposalId)
    else if (outcome.kind === 'retired') summary.retired.push(row.proposalId)
    else if (outcome.kind === 'deferred') summary.deferred.push(row.proposalId)
    else if (outcome.kind === 'refused') {
      summary.refused.push({ proposalId: row.proposalId, code: outcome.code ?? 'review-refused' })
    }
  }
  recordDiagnostic(diagnostics, 'curation', {
    outcome: 'auto-reviewed',
    projectId:
      typeof (/** @type {any} */ (binding)?.projectId) === 'string'
        ? /** @type {any} */ (binding).projectId
        : undefined,
    // Counts only: what the pass decided, how many candidates it examined and what
    // the judge input cost. No id, path or note text may reach the durable record.
    hits: summary.applied.length + summary.rejected.length + summary.retired.length,
    attempts: summary.inspected,
    chars: inputChars,
    ms: Math.max(0, Math.round(clock() - started)),
  })
  return summary
}
