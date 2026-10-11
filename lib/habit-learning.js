// @ts-check
// When does an observation become a habit candidate?
//
// ---------------------------------------------------------------------------
// Why this is a pure policy and not a writer
// ---------------------------------------------------------------------------
//
// This module folds one session's observations into the private counters and
// returns the promotions that follow. It writes no note and reads no vault. The
// composition with the real writer happens one layer up, in `capture` (L6), which
// already owns `applyCandidate` — the same split `failure-memory` (L1) uses for the
// failure policy that `distill` (L2) composes. Keeping the policy pure is what lets
// it sit below `memory` (L5) without importing it, and it is why every rule here is
// testable without a vault, a lock or a receipt.
//
// ---------------------------------------------------------------------------
// The unit is the SESSION, not the turn
// ---------------------------------------------------------------------------
//
// The calibration measured a median of TWO usable turns per session across the real
// corpus, and a maximum of a handful. Counting turns would therefore let a single
// conversation that repeats a phrase charge the same habit two or three times, and
// "three occurrences" would mean "one afternoon". A session id is the smallest unit
// that can honestly represent "the user came back and said this again".
//
// ---------------------------------------------------------------------------
// Why the bar is low (3) and precision is bought elsewhere
// ---------------------------------------------------------------------------
//
// At >=3 sessions the calibration produced 6 candidates from 44 root sessions, and
// the vault's own three confirmed cross-project habits were all among them. Raising
// the bar to 9 would have left 2. The bar is deliberately the lower one because a
// promoted candidate is NOT a rule: it is written `assertion: observed` and
// `status: provisional`, which keeps it out of the injected brief until a human
// confirms it. That is CAPTURE's quarantine shape — write it, make it
// non-retrievable, let it wait — and it is what lets recall stay high while
// precision is enforced at the point where it matters.
//
// ---------------------------------------------------------------------------
// A promotion is a candidate, never a claim
// ---------------------------------------------------------------------------
//
// The title carries the `习惯：` prefix and the note carries `user-habit`, so it is
// findable the same way a stated habit is. But the assertion is `observed`, never
// `stated`: the calibration's whole point is that the plugin may record what it saw
// and must not pretend the user said it. `stated` is reserved for the pipeline that
// has the user's own words, and `habit-state` exempts it from decay accordingly.

import { BUILTIN_MARKERS, labelsFromUserText } from './habit-signals.js'

/** How many distinct sessions must observe a label before it becomes a candidate. */
export const PROMOTE_AFTER = 3
/** The tag the plugin attaches to a habit candidate, matching the stated-habit tag. */
export const HABIT_TAG = 'user-habit'
/** The title prefix every habit note carries, stated or observed. */
export const HABIT_TITLE_PREFIX = '习惯：'
/** The assertion a promoted candidate carries: the plugin saw it, the user did not say it. */
export const OBSERVED_ASSERTION = 'observed'
/** The status a candidate is written with: recorded, not yet injected. */
export const CANDIDATE_STATUS = 'provisional'
/** The confidence a candidate carries. Below the distill floor, so it never auto-accepts. */
export const CANDIDATE_CONFIDENCE = 0.6

/** Every label this module will store, from the closed vocabulary. */
const KNOWN_LABELS = new Set(BUILTIN_MARKERS.map((marker) => marker.label))

/**
 * The label a promoted note is titled with.
 *
 * The prefix is the same one the stated-habit path uses, so `mem_search` and the
 * brief's convention scan find both kinds by one rule. The label is a vocabulary
 * entry and never message text, which is what keeps a user's sentence out of a note
 * title.
 *
 * @param {string} label - a vocabulary label.
 * @returns {string} the note title.
 */
export function habitTitle(label) {
  return `${HABIT_TITLE_PREFIX}${label}`
}

/**
 * Fold one session's labels into the counters and report what that promotes.
 *
 * @param {{schema: number, records: Record<string, object>}} state - the state read from disk.
 * @param {{labels?: unknown, sessionId?: unknown, today?: unknown, enabled?: boolean,
 *   promoteAfter?: number, extraMarkers?: ReadonlyArray<{label: string, pattern: RegExp}>}} input - one session's pass.
 * @returns {{state: object, promotions: object[]}} the next state and the candidates to write.
 */
export function foldObservations(state, input) {
  const records = cloneRecords(state?.records)
  const promotions = []
  const today = typeof input?.today === 'string' ? input.today : null
  const sessionId = input?.sessionId
  // A pass with no session identity cannot tell "again" from "still the same".
  // Refusing it is the honest answer; counting it would invent evidence.
  if (typeof sessionId !== 'string' || sessionId === '') {
    return { state: { schema: state?.schema ?? 1, records }, promotions }
  }
  if (input?.enabled === false) {
    return { state: { schema: state?.schema ?? 1, records }, promotions }
  }
  const bar = Number.isSafeInteger(input?.promoteAfter) ? input.promoteAfter : PROMOTE_AFTER
  const labels = Array.isArray(input?.labels) ? input.labels : []
  for (const label of labels) {
    if (typeof label !== 'string' || !KNOWN_LABELS.has(label)) continue
    const existing = records[label] ?? null
    // The session that last charged this label. Stored so a repeat inside one
    // session is one observation, not several.
    if (existing !== null && existing.lastSession === sessionId) continue
    const sessions = (existing?.sessions ?? 0) + 1
    const firstSeen = existing?.firstSeen ?? today
    const record = {
      sessions,
      firstSeen,
      lastReinforcedAt: today,
      lastDecayedAt: existing?.lastDecayedAt ?? null,
      // A reinforcement restores the clock, which is what "the user did it again"
      // means. limbic's decay resets on retrieval for the same reason.
      score: 1,
      noteId: existing?.noteId ?? null,
      lastSession: sessionId,
    }
    records[label] = record
    // Promoted once, on the pass that crosses the bar. Later sessions keep
    // counting and keep refreshing the clock, but they add no second note: the
    // note's identity is stable and a duplicate would fragment the evidence.
    if (sessions === bar && record.noteId === null) {
      promotions.push({
        label,
        sessions,
        title: habitTitle(label),
        assertion: OBSERVED_ASSERTION,
        status: CANDIDATE_STATUS,
        confidence: CANDIDATE_CONFIDENCE,
        // The same tag pair an accepted distillation candidate carries: the type tag
        // every note of this kind has, plus the plugin-owned habit marker. The caller
        // adds the project tag, because only it knows the binding's slug.
        tags: ['dsh-mem/convention', HABIT_TAG],
      })
    }
  }
  return { state: { schema: state?.schema ?? 1, records }, promotions }
}

/**
 * Attach the identity a promotion produced, so later passes refresh instead of re-create.
 *
 * @param {{schema: number, records: Record<string, object>}} state - the state after a fold.
 * @param {string} label - the promoted label.
 * @param {string} noteId - the note the writer created.
 * @returns {object} the next state.
 */
export function recordPromotion(state, label, noteId) {
  const records = cloneRecords(state?.records)
  const existing = records[label]
  if (existing !== undefined) records[label] = { ...existing, noteId }
  return { schema: state?.schema ?? 1, records }
}

/**
 * A deep-enough copy that a fold cannot mutate its input.
 *
 * The caller holds the state it read; mutating it in place would make a failed
 * write leave the in-memory copy ahead of the file.
 *
 * @param {unknown} records - the record map.
 * @returns {Record<string, object>} a copy.
 */
function cloneRecords(records) {
  /** @type {Record<string, object>} */
  const copy = {}
  if (records === null || typeof records !== 'object') return copy
  for (const [label, value] of Object.entries(records)) {
    if (value !== null && typeof value === 'object') copy[label] = { ...value }
  }
  return copy
}

/**
 * The labels one turn states, read ONLY from the user's own messages.
 *
 * This is the attribution boundary, and it is the regression test for the mistake
 * that falsified the first version of this feature. That version read tool calls —
 * bash command names, file extensions, adjacent tool sequences — and 99.0% of the
 * choices it counted (291 of 294) were the AGENT's, never requested by the user.
 * It measured this plugin's defaults, which are identical for every user.
 *
 * So this function reads exactly one event kind: a `user/message` whose
 * `source.kind` is `'user'`. Everything else in a turn is skipped by construction —
 * `tool/call`, `tool/result`, the plugin's own injections (`plugin:<name>`), the
 * skill catalogue and the runtime context all commit as events, and the calibration
 * measured injected context OUTNUMBERING real user messages (48 plugin injections
 * against 40 user messages in the sampled sessions). Reading them would be worse
 * than reading tools: it would count this plugin talking to itself.
 *
 * @param {unknown} events - one completed turn's committed events.
 * @param {ReadonlyArray<{label: string, pattern: RegExp}>} [extraMarkers] - configuration markers.
 * @returns {string[]} the distinct labels the user's own messages stated.
 */
export function labelsFromTurnEvents(events, extraMarkers = []) {
  if (!Array.isArray(events)) return []
  const labels = new Set()
  for (const event of events) {
    if (event === null || typeof event !== 'object') continue
    if (event.type !== 'user/message') continue
    const source = event.data?.source
    if (source === null || typeof source !== 'object') continue
    if (source.kind !== 'user') continue
    const text = textOfContent(event.data?.content)
    if (text === '') continue
    for (const label of labelsFromUserText(text, extraMarkers)) labels.add(label)
  }
  return [...labels]
}

/**
 * The concatenated `text` parts of a message content array.
 *
 * Mirrors `capture.js:textOfContent` for the one shape this module reads. Kept here
 * rather than imported because that module is L6 and this policy sits below it.
 *
 * @param {unknown} content - the message content.
 * @returns {string} the text, or an empty string.
 */
function textOfContent(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const part of content) {
    if (
      part !== null &&
      typeof part === 'object' &&
      part.type === 'text' &&
      typeof part.text === 'string'
    ) {
      parts.push(part.text)
    }
  }
  return parts.join('\n')
}

// Re-exported so a caller composing this policy has one import for the pair.
export { labelsFromUserText }
