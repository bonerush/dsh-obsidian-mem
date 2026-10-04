// One source of truth for the *fixed* curation `code` vocabulary (Task 5 fix round 2,
// R33). The lists below are the vocabulary `lib/diagnostic-codec.js` derives the
// persisted set from, and the only thing that binds an emitter to them is
// `test/diagnostic-codec.test.js`: it parses the scanner, the private-state store, the
// view builder and the proposal store, and requires each module's literal code
// arguments to *equal* the list declared for it. Nothing imports this module to raise a
// code — no emitter names it at all — so the binding is that test and not this comment.
//
// This module is a leaf on purpose: it imports nothing, so the four emitters (L4–L6)
// and the codec (L1) can all point down at it. The alternative — having the codec
// import the emitters — is an upward edge the layer table refuses, and keeping a
// second copy of the lists in the codec is the drift this file exists to remove.
//
// A code is a short token naming a refusal, never a path or a note.

/**
 * Every fixed `truncatedReason` one scan pass can report (`lib/curation-scan.js`).
 *
 * `manifest-budget` is the one that inspects nothing: the manifest itself was cut, so
 * no coverage can be claimed. `records-missing` is coverage lost after the walk
 * finished, `manifest-changed` a walk whose fingerprint moved under it, and the two
 * budgets the pass's own note and time bounds.
 */
export const CURATION_TRUNCATION_REASONS = Object.freeze([
  'file-budget',
  'time-budget',
  'manifest-budget',
  'manifest-changed',
  'records-missing',
])
/**
 * Every fixed `code` the private-state store raises (`lib/curation-state.js`).
 *
 * `state-unreadable` is the shared one: every document this store reads decides it the
 * same way. The cursor, record, changed-set and view families name the document whose
 * version, project or shape was refused.
 */
export const CURATION_STATE_CODES = Object.freeze([
  'state-unreadable',
  'state-not-a-file',
  'state-corrupt',
  'state-oversize',
  'cursor-invalid',
  'cursor-version',
  'cursor-project',
  'record-invalid',
  'record-version',
  'record-mismatch',
  'changed-invalid',
  'changed-version',
  'changed-project',
  'view-invalid',
  'view-version',
  'view-project',
])
/**
 * Every fixed `code` the proposal store raises (`lib/curation-proposals.js`).
 *
 * Four of these are that module's record reader repeating the state refusals for the
 * document it owns, and `proposal-state` is both a stored-state refusal and a refused
 * transition. The rest name why a proposal could not be placed, edited or sourced.
 */
export const CURATION_PROPOSAL_CODES = Object.freeze([
  'proposal-invalid',
  'proposal-version',
  'proposal-mismatch',
  'proposal-state',
  'proposal-kind',
  'proposal-kind-operation',
  'proposal-operation',
  'proposal-conflict',
  'proposal-oversize',
  'proposal-missing',
  'proposal-source-missing',
  'proposal-source-unsafe',
  'proposal-source-unreadable',
  'state-unreadable',
  'state-not-a-file',
  'state-corrupt',
  'state-oversize',
])
/**
 * Every fixed `reason` the view builder returns as a `fallback`
 * (`lib/curation-view.js`) — which `lib/services.js` reports as a pass's one `code`.
 *
 * `view-unwritable` is only ever a prefix there: the builder appends the underlying
 * filesystem error's own code, so that half is a dynamic family no list can enumerate.
 * It never reaches a recorded event as a code at all: the diagnostics ring's own `code`
 * validator (`lib/debug.js`) admits a lowercase token and no colon, so the field is
 * dropped from the event outright rather than coarsened. `source-changed` is written to
 * the ring by `lib/brief.js` itself — a view that fails verification is recorded as
 * `curation`/`brief-fallback` with exactly this code — and it is listed because it is
 * also one of this module's fallback reasons.
 */
export const CURATION_VIEW_CODES = Object.freeze([
  'backfill-incomplete',
  'entry-unusable',
  'view-oversize',
  'view-unwritable',
  'source-changed',
])

/**
 * Every fixed `code` a curation *review* answers with (Task 7).
 *
 * These never reach the diagnostics journal: a review is an interactive command a
 * human runs, and its answer is printed, not persisted as an event. They live here
 * anyway so the one list a caller can enumerate is the one the review module is
 * held to, and `test/curation-review.test.js` holds it equal to the set
 * `lib/curation-review.js` can answer with — in both directions: a code the module
 * can answer that is missing here, and an entry here the module cannot answer, are
 * both defects. That test derives the answered set from the review module's own
 * emitters (its `CurationReviewError` arguments, the `code: '…'` entries it returns,
 * and the values of every translation table `refusalCode` answers through), so the
 * check cannot be satisfied by copying a list back: adding a refusal without
 * declaring it fails the case. The one dynamic emitter — the ownership proof
 * re-emitted from `assertPluginOwnedNote` — is checked too: its code must be read out
 * of a declared table, and a bare `error.code` there is reported rather than skipped.
 *
 * The first two families name the record a review may not decide, and
 * `operation-invalid` names a record whose operation cannot become a write request
 * at all (`applyReviewedMemory` is exported, and a caller reaches it with no
 * operation); `source-changed` and `source-unsafe` name why the evidence no longer
 * matches; `lock-timeout` is the engine's own code, passed through rather than
 * renamed; `proposal-unreadable` names a stored record the private-state reader could
 * not trust, which is a cache fault rather than a decision; and the memory layer's
 * vocabulary is repeated here because a review reports those facts as refusals rather
 * than inventing second names for them — `human-owned` and the two ownership proofs
 * `assertPluginOwnedNote` can fail with. The proposal store's own `proposal-state` is
 * deliberately absent: a record decided under a review is the same answer to a caller
 * as `proposal-not-current`, and `lib/curation-review.js` reports it as that rather
 * than as a second name. Every one of them is produced by a case in
 * `test/curation-review.test.js`.
 */
export const CURATION_REVIEW_CODES = Object.freeze([
  'proposal-missing',
  'proposal-not-current',
  'proposal-unreadable',
  'review-only',
  'operation-not-executable',
  'operation-invalid',
  'source-changed',
  'source-unsafe',
  'lock-timeout',
  'human-owned',
  'ownership-unproven',
  'ownership-mismatch',
])
