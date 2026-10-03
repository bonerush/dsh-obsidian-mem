// One source of truth for the *fixed* curation `code` vocabulary (Task 5 fix round 2,
// R33). The scanner, the private-state store, the view builder and the proposal store
// declare the codes they raise here, and `lib/diagnostic-codec.js` derives the
// persisted vocabulary from the same lists — so a code an emitter can produce and the
// disk format does not know is a failing test rather than a silent `other`.
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
 * filesystem error's own code, so that half is a dynamic family no list can enumerate
 * and it is coarsened to `other` on purpose. `source-changed` belongs to
 * `verifyCurationEntries`, whose verdict `lib/brief.js` consumes rather than the
 * diagnostics ring; it is listed because it is one of this module's fallback reasons.
 */
export const CURATION_VIEW_CODES = Object.freeze([
  'backfill-incomplete',
  'entry-unusable',
  'view-oversize',
  'view-unwritable',
  'source-changed',
])
