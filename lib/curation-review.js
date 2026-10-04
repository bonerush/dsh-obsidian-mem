// What an approved proposal may become, and what a refused one says (Task 7).
//
// This module is the executor half of the review queue. `lib/curation-proposals.js`
// parks a candidate the plugin may not apply on its own; this module is the only
// code in the tree that applies one, through the *same* transaction engine every
// other write uses. Three properties shape it:
//
//   * **The write request is built from explicit fields (R6) and goes to the
//     exclusive-create path.** `writeMemory` reads a present `request.id` as
//     "update this note by id" and ignores `preassignedId`, so spreading a parked
//     candidate into a request would turn an approved `create-separate` into an
//     overwrite of whatever note the candidate happened to name. The fields are
//     copied one by one from a closed list, `id` is never among them, and the write
//     goes through `createMemoryWithId`, whose whole contract is "create under
//     exactly this pre-assigned id, never update".
//   * **A stale proposal never auto-rebases.** The proposal's own source hashes
//     travel into the transaction request as `expectedSourceHashes`, and the engine
//     re-verifies them under its own vault lock — the same lock that publishes the
//     write. A mismatch refuses; the record stays `pending` for another review, and
//     no source byte moves. This module does not take the lock itself: a second lock
//     around the first is a deadlock or a reentrancy bug, not a stricter check.
//   * **Only `create-separate` and `supersede` execute.** A scan finding is
//     evidence a human reads, not a plan; a deletion has no generic apply at all
//     because the vault's own rule is that a conclusion moves by being superseded,
//     never by being removed.
//
// The vault is untouched by every refusal path, and outside a transaction this module
// writes only the proposal's own decision, through the store's one lock-taking
// transition, and the per-proposal claim file it holds for the length of a review.
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join, basename, dirname } from 'node:path'

import {
  CurationError,
  curationProposalDir,
  readCurationProposal,
  markCurationProposal,
  PROPOSAL_STATES,
} from './curation-proposals.js'
import { CurationStateError, requireCurationBinding } from './curation-state.js'
import { MemoryError, assertPluginOwnedNote, createMemoryWithId, normalizeDeps } from './memory.js'
import { parseNote } from './frontmatter.js'
import { resolveVaultFile } from './paths.js'
import { sha256Hex } from './index-db.js'
import { TransactionError } from './transaction.js'

/** The two operation kinds this module can apply. Anything else is refused by name. */
export const EXECUTABLE_OPERATIONS = Object.freeze(['create-separate', 'supersede'])
/**
 * The candidate fields that become a write request, in the order §6.4 reads them.
 *
 * `id` is deliberately absent from this list and is never copied: it is the one key
 * that turns a create into an update. `preassignedId` and `idempotencyKey` are
 * carried separately because they are the identity this module writes *with*,
 * not part of the note's content.
 */
const REQUEST_FIELDS = Object.freeze([
  'type',
  'title',
  'body',
  'tags',
  'confidence',
  'assertion',
  'status',
])
/** The decisions a review may take. */
const DECISIONS = Object.freeze(['apply', 'reject'])

/**
 * One reviewed operation was refused before, or instead of, being applied.
 *
 * `code` is the machine-readable reason; the message names the value that failed.
 */
export class CurationReviewError extends Error {
  /**
   * @param {string} code - one of `CURATION_REVIEW_CODES`.
   * @param {string} message - human-readable reason naming the offending value.
   * @param {{cause?: Error}} [options] - the underlying failure, when there is one.
   */
  constructor(code, message, options) {
    super(message, options)
    this.name = 'CurationReviewError'
    this.code = code
  }
}

/**
 * The item fields of one reviewed operation, copied explicitly (R6).
 *
 * @param {object} operation - the proposal's normalized operation.
 * @returns {object} `{type, title, body, tags?, confidence?, assertion?, status?}`.
 * @throws {CurationReviewError} with code `operation-not-executable` when the operation is absent or its kind has no apply; `operation-invalid` when it carries no usable item or a required field is missing.
 */
function requestFields(operation) {
  if (operation === null || typeof operation !== 'object' || Array.isArray(operation)) {
    throw new CurationReviewError(
      'operation-invalid',
      'there is no operation object here, so there is nothing to apply',
    )
  }
  if (!EXECUTABLE_OPERATIONS.includes(operation.kind)) {
    throw new CurationReviewError(
      'operation-not-executable',
      `this build applies ${EXECUTABLE_OPERATIONS.join(' and ')} only, not ${JSON.stringify(operation.kind)}`,
    )
  }
  const item = operation.item
  if (item === null || typeof item !== 'object' || Array.isArray(item)) {
    throw new CurationReviewError(
      'operation-invalid',
      'the operation carries no validated candidate item to write',
    )
  }
  const request = {}
  // Only the listed fields, and only when the candidate actually carries them: an
  // absent optional field must stay absent rather than become `undefined`, because
  // the note writer distinguishes "not supplied" from "supplied as nothing".
  for (const field of REQUEST_FIELDS) {
    if (item[field] !== undefined) request[field] = item[field]
  }
  for (const field of ['type', 'title', 'body']) {
    if (typeof request[field] !== 'string' || request[field].trim() === '') {
      throw new CurationReviewError(
        'operation-invalid',
        `the reviewed candidate has no usable ${field}, so it cannot be written`,
      )
    }
  }
  if (typeof item.preassignedId === 'string' && item.preassignedId !== '') {
    request.preassignedId = item.preassignedId
  }
  if (typeof item.idempotencyKey === 'string' && item.idempotencyKey !== '') {
    request.idempotencyKey = item.idempotencyKey
  }
  return request
}

/**
 * Apply one approved memory operation through the transaction engine.
 *
 * This is the executor curation Task 3 established was missing: a parked
 * `supersede` cannot be re-applied through `applyCandidate`, because that path
 * would classify it as risky again and park it a second time. Here the operation is
 * already approved, so it is applied — and applied through `createMemoryWithId`,
 * which routes, mints the MOC entry, relinks the superseded note and records the
 * receipt exactly as any other write does. That path is also the R6 guard made
 * structural rather than promised: it never reads `id` at all, so a candidate that
 * carries one cannot reach an update.
 *
 * `request.expectedSourceHashes` is validated by the engine inside its own vault
 * lock, so the caller's evidence and the published bytes are checked under one
 * lock rather than two.
 *
 * @param {object} binding - a `kind:'bound'` binding.
 * @param {{operation: object, expectedSourceHashes?: Array<{path: string, hash: string}>, idempotencyKey?: string}} request - the reviewed operation and its evidence.
 * @param {{dataRoot?: string, home?: string, now?: Date, lockTimeoutMs?: number, pollMs?: number, failAfter?: string, recover?: boolean, notifyIndex?: Function, io?: object}} [deps] - dependency and engine seam.
 * @returns {Promise<object>} the transaction receipt.
 * @throws {RangeError} when `request` is not a plain object — that is a programming error, not a review outcome.
 * @throws {CurationReviewError} with code `operation-invalid` when there is no operation object or its item cannot be written, or `operation-not-executable` when the operation kind has no generic apply.
 * @throws {RangeError} when the candidate carries no valid `preassignedId`, or its id prefix does not match its type.
 * @throws {TransactionError} when the engine refuses the write (a moved source, a taken identity, a lock timeout).
 * @throws {MemoryError} when the memory layer refuses the note (ownership, routing).
 */
export async function applyReviewedMemory(binding, request, deps = {}) {
  const options = normalizeDeps(deps)
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    throw new RangeError('a reviewed operation must be a plain object')
  }
  const fields = requestFields(request.operation)
  const operation = request.operation
  const write = {
    ...fields,
    ...(operation.kind === 'supersede' ? { supersedes: operation.supersedesId } : {}),
    ...(typeof request.idempotencyKey === 'string' && request.idempotencyKey !== ''
      ? { idempotencyKey: request.idempotencyKey }
      : {}),
  }
  return createMemoryWithId(binding, write, {
    ...options,
    expectedSourceHashes: Array.isArray(request.expectedSourceHashes)
      ? request.expectedSourceHashes
      : [],
  })
}

/**
 * Read and verify every source one proposal names, without taking the vault lock.
 *
 * The read is deliberately *not* the authority — the engine re-verifies the same
 * hashes under the lock before it writes — but it decides the refusals a review must
 * be able to name (`source-unsafe`, `human-owned`, `source-changed`), so a caller
 * learns which one applies instead of a single generic refusal.
 *
 * @param {object} binding - a `kind:'bound'` binding.
 * @param {object} proposal - the stored proposal.
 * @returns {Promise<void>} resolves once every source is present, in the project, not a symlink, plugin-owned and unchanged.
 * @throws {CurationReviewError} naming the refusal.
 */
async function assertSourcesHeld(binding, proposal) {
  const project = requireCurationBinding(binding)
  for (const source of proposal.sources) {
    if (!source.path.startsWith(`${project.relativeDir}/`)) {
      throw new CurationReviewError(
        'source-unsafe',
        `${source.path} is not inside ${project.relativeDir}, so this project does not own it`,
      )
    }
    const absolute = join(project.vaultRoot, ...source.path.split('/'))
    let stats
    try {
      stats = await fs.lstat(absolute)
    } catch (error) {
      throw new CurationReviewError(
        error.code === 'ENOENT' ? 'source-changed' : 'source-unsafe',
        `cannot read ${source.path}: ${error.code ?? error.message}`,
        { cause: error },
      )
    }
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new CurationReviewError(
        'source-unsafe',
        `${source.path} is not a regular file in the vault, so it is never treated as evidence`,
      )
    }
    let bytes
    try {
      bytes = await fs.readFile(absolute)
    } catch (error) {
      throw new CurationReviewError(
        'source-changed',
        `cannot read ${source.path}: ${error.code ?? error.message}`,
        { cause: error },
      )
    }
    if (sha256Hex(bytes) !== source.hash) {
      throw new CurationReviewError(
        'source-changed',
        `${source.path} changed after this proposal was scanned, so the decision no longer refers to what was read`,
      )
    }
    // The supersede target is the one source whose *ownership* decides whether the
    // write may proceed at all: the engine's own check is on the note's frontmatter,
    // and a human's file is refused rather than repaired.
    if (proposal.operation !== null && proposal.operation.kind === 'supersede') {
      try {
        assertPluginOwnedNote(parseNote(bytes), source.path, { expectId: source.id ?? undefined })
      } catch (error) {
        if (!(error instanceof MemoryError)) throw error
        // The ownership proof is the one refusal translated here rather than left to
        // `refusalCode`: the error was raised against a source this review read, not
        // against a write the memory layer performed, and the answer must be the
        // layer's own name for the proof that failed. A code this table does not hold
        // is not an answer and is rethrown.
        const code = OWNERSHIP_CODES[error.code]
        if (code === undefined) throw error
        throw new CurationReviewError(code, error.message, { cause: error })
      }
    }
  }
}

/**
 * How long a review claim outlives the process that wrote it. A claim whose owner is
 * gone is reclaimed at once, so this bound only covers a live process wedged
 * mid-apply; past it, the next reviewer decides.
 */
const CLAIM_TTL_MS = 15 * 60 * 1000

/**
 * The file that says one review is applying one proposal right now.
 *
 * It decides the first race a proposal store cannot decide on its own: two reviewers
 * that both read `pending` before either writes. The shared idempotency key (the
 * proposal's `itemKey`) already prevents a *second note* — the engine replays the first
 * transaction — but the second reviewer would otherwise still decide a proposal for a
 * write it did not make. The claim is per proposal, per process, and lives beside the
 * record it guards in the same `0700` directory.
 *
 * @param {string} dataRoot - the plugin data root.
 * @param {string} proposalId - the proposal's sha256 identity.
 * @param {{projectId: string}} project - the bound project.
 * @returns {string} the absolute claim path.
 */
function claimPath(dataRoot, proposalId, project) {
  return join(curationProposalDir(dataRoot, project.projectId), `${proposalId}.claim`)
}

/**
 * Read one claim document, or `null` when nothing trustworthy is there.
 *
 * @param {string} path - the claim file.
 * @returns {Promise<object|null>} the parsed claim, or `null` when it is absent or not JSON.
 */
async function readClaim(path) {
  try {
    return JSON.parse(await fs.readFile(path, 'utf8'))
  } catch (error) {
    if (error instanceof SyntaxError || error.code === 'ENOENT') return null
    throw error
  }
}

/**
 * Claim the right to apply one proposal, or report that somebody else holds it.
 *
 * The arbitration is one atomic step and nothing else: the new claim is written to a
 * name only this process knows and then `link()`ed into place, which fails `EEXIST`
 * for every claimant but one. A stale claim is retired first, but retirement never
 * decides anything — it only clears the way for that `link`.
 *
 * The retirement is content-checked for the ordering where it matters: a reclaimer
 * whose `rename` lands *after* another review installed its claim moves *that* claim,
 * not the stale one, and `retireStaleClaim` then withdraws those bytes and reports
 * `not-stale`, so this review refuses instead of installing a second claim. The rule
 * this buys is the one the claim exists for, and it is a rule about *two* reviews: of
 * two reviews that both judge one stale claim stale, only one reaches the write, because
 * only one `link` can succeed and a reclaimer that moved a fresh claim withdraws.
 * At three it is not mutual exclusion — the withdrawal leaves the claim path empty for
 * the length of the move, and a third review can install its own claim there while the
 * review whose bytes were moved is still running (see `retireStaleClaim` for what holds
 * the outcome together then). Claiming at all is what keeps a crash between the claim
 * and the write from blocking the proposal until a human deletes a file by hand — the
 * same rule the vault lock uses, for the same reason.
 *
 * @param {{dataRoot: string, proposalId: string, project: object, now: Date}} input - the claim.
 * @returns {Promise<string|null>} this review's claim id, or `null` when another review holds the proposal.
 */
async function claimReview({ dataRoot, proposalId, project, now }) {
  const path = claimPath(dataRoot, proposalId, project)
  const mine = { claimId: randomUUID(), pid: process.pid, at: now.toISOString() }
  // The staged file is this process's alone, so writing it can never be mistaken for
  // a claim; only the `link` publishes it. Both temporary names are hidden, like the
  // store's own, so a crash mid-reclaim leaves no name a listing would render.
  const staged = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.new`)
  const handle = await fs.open(staged, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(mine)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    // Bounded rather than `while (true)`: each pass ends by either returning or
    // observing a claim that is not stale, so only continuous reclaim churn can reach
    // the bound, and refusing there is the safe direction.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await fs.link(staged, path)
        return mine.claimId
      } catch (error) {
        if (error.code !== 'EEXIST') throw error
      }
      const held = await readClaim(path)
      // The claim vanished between the failed `link` and this read: nothing holds the
      // proposal, so try the `link` again rather than refusing a free proposal.
      if (held === null) continue
      if (!claimIsStale(held, now)) return null
      if ((await retireStaleClaim(path, held)) === 'not-stale') return null
    }
    return null
  } finally {
    await fs.rm(staged, { force: true }).catch(() => {})
  }
}

/**
 * Move one stale claim out of the way, but only if the bytes moved are still stale.
 *
 * `rename` is atomic, so exactly one reclaimer moves the file that was at the path; the
 * content check is what makes that insufficient on its own. A reclaimer whose rename
 * landed after another review installed a fresh claim moved that fresh claim, and this
 * function then *withdraws* those bytes. It must not `link` them back: a `link` is the
 * one operation that can create the claim file, and the claim it would recreate may
 * already have been released — the owner's `releaseClaim` ran while those bytes were out
 * of the path, so nothing holds what a restore would put there, and the next review
 * would be answered "another review is deciding it" for as long as the owner's pid keeps
 * the claim fresh (the 15-minute bound, or a human deleting the file). Deleting the
 * moved bytes cannot recreate anything. Both orderings are driven by *a claim its owner
 * released is never reinstated by the reclaimer that moved it* in
 * `test/curation-review.test.js`: pre-fix the reinstated file survived the release and
 * the next review was answered `proposal-not-current`, while with the withdrawal the file
 * is gone and that review applies the proposal.
 *
 * The cost is bounded and named: for the length of that window — one `rename` and one
 * read — the claim path is empty, so a *third* review can install its own claim while
 * the review whose bytes were moved is still running. At three the claim is therefore
 * not mutual exclusion; what still holds the outcome together is the shared idempotency
 * key, which replays the winner's transaction instead of minting a second note (driven
 * by *at three reviewers the claim stops being mutual exclusion and the record decides*
 * in `test/curation-review.test.js`). The key makes two *applies* one note and does not
 * make an apply and a reject agree: a third claimant that decides `reject` can mark the
 * record `rejected` while the moved-claim review is still applying, leaving a published
 * note behind a `rejected` record. `CHANGELOG.md` discloses that outcome beside this
 * limit; the command decides one proposal per run at a terminal, which is what keeps it
 * a three-way race rather than a routine one. At two the property holds: the only review
 * whose claim can be moved here is the one that installed it a moment ago, so after the
 * withdrawal it is the only review left that can reach the write.
 *
 * `clear` means the file this review judged stale is no longer in the way — moved here,
 * or already moved by whichever reclaimer won that rename — and the caller's `link`
 * remains the only thing that decides who holds the proposal.
 *
 * @param {string} path - the claim file.
 * @param {object} held - the stale claim this review read.
 * @returns {Promise<'clear'|'not-stale'>} whether the bytes this review moved were the stale claim.
 */
async function retireStaleClaim(path, held) {
  const retired = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.retired`)
  try {
    await fs.rename(path, retired)
  } catch (error) {
    if (error.code === 'ENOENT') return 'clear'
    throw error
  }
  const moved = await readClaim(retired)
  // Withdrawn rather than restored, whatever these bytes are: a stale claim needs no
  // separate delete either, so both outcomes are the same one removal.
  await fs.rm(retired, { force: true }).catch(() => {})
  return moved !== null && moved.claimId === held.claimId ? 'clear' : 'not-stale'
}

/**
 * Whether a stored claim means nothing any more.
 *
 * A claim is only ever written for a process that is still running, so a recorded
 * pid that no longer exists is a claim left by a crash. The age bound is the
 * second half: a live but wedged process must not hold a proposal forever.
 *
 * @param {unknown} held - the parsed claim document.
 * @param {Date} now - the clock.
 * @returns {boolean} whether the claim may be reclaimed.
 */
function claimIsStale(held, now) {
  if (held === null || typeof held !== 'object') return true
  if (!Number.isInteger(held.pid) || held.pid <= 0) return true
  const at = Date.parse(held.at)
  if (!Number.isFinite(at) || now.getTime() - at >= CLAIM_TTL_MS) return true
  if (held.pid === process.pid) return false
  try {
    process.kill(held.pid, 0)
    return false
  } catch {
    return true
  }
}

/**
 * Release one review's claim, if it is still the one on disk.
 *
 * A review that finds somebody else's claim id here lost the arbitration that
 * happened while it was writing, so it must not delete that claimant's record.
 *
 * @param {{dataRoot: string, proposalId: string, project: object, claimId: string}} input - the claim.
 * @returns {Promise<void>} resolves once the claim is gone or was never this review's.
 */
async function releaseClaim({ dataRoot, proposalId, project, claimId }) {
  const path = claimPath(dataRoot, proposalId, project)
  // A claim file that cannot be parsed is not this review's to keep, and failing to
  // release must never mask the answer the review already produced.
  const held = await readClaim(path).catch(() => null)
  if (held !== null && held.claimId !== claimId) return
  await fs.rm(path, { force: true }).catch(() => {})
}

/**
 * The ownership proofs `assertPluginOwnedNote` can refuse with, under the memory
 * layer's own names.
 *
 * A review reports which proof failed rather than one generic "not ours", because
 * the repair differs: `ownership-unproven` is a note with no plugin evidence,
 * `ownership-mismatch` a note that is not the one the scan named, and `human-owned` a
 * file the plugin never rewrites. These are the memory layer's codes kept as they are
 * so a reader can act on the answer, not renamed into this module's vocabulary.
 */
const OWNERSHIP_CODES = Object.freeze({
  'human-owned': 'human-owned',
  'ownership-unproven': 'ownership-unproven',
  'ownership-mismatch': 'ownership-mismatch',
})
/**
 * The proposal store's own refusals, under this module's names: a record decided
 * under this review and one that is gone are both "not current" to a caller.
 */
const STORE_CODES = Object.freeze({
  'proposal-state': 'proposal-not-current',
  'proposal-missing': 'proposal-missing',
})
/**
 * The engine's refusals in this review's vocabulary: a moved source under three of
 * its names, and `invalid-request` (reachable only through the exported
 * `applyReviewedMemory`) as the request defect it is.
 */
const TRANSACTION_CODES = Object.freeze({
  'source-changed': 'source-changed',
  'hash-mismatch': 'source-changed',
  'target-changed': 'source-changed',
  'unsafe-path': 'source-unsafe',
  'lock-timeout': 'lock-timeout',
  'invalid-request': 'operation-invalid',
  'target-exists': 'proposal-not-current',
  'txid-in-use': 'proposal-not-current',
})
/**
 * The memory layer's refusals to a *write*: `human-owned` keeps the layer's own name,
 * while `id-taken` is reported as `proposal-not-current` because a taken identity
 * means the note this review planned is not the one that landed — the same answer as
 * a record already decided. The ownership codes above are not here: they are raised
 * against a source this module read and are re-emitted before any write.
 */
const MEMORY_CODES = Object.freeze({
  'human-owned': 'human-owned',
  'id-taken': 'proposal-not-current',
})
/**
 * The record reader's refusals, answered as one code: a stored record this review
 * cannot read is a cache fault, not a decision, and the only useful answer is
 * "this record cannot be decided until the cache is repaired" — which the message
 * names in the reader's own terms (`state-corrupt`, `proposal-version`, …).
 *
 * Four of these keys (`state-unreadable`, `state-not-a-file`, `state-oversize`,
 * `state-corrupt`) are the shared document refusals `lib/curation-state.js` raises and
 * `lib/curation-proposals.js`'s own `readRecord` repeats for the document it owns; the
 * other four (`proposal-invalid`, `proposal-version`, `proposal-mismatch`,
 * `proposal-state`) are that reader's alone. A refused *transition* is a `CurationError`
 * and stays in `STORE_CODES`. Every key is driven by
 * *every untrustworthy stored record is answered proposal-unreadable* in
 * `test/curation-review.test.js`, which asserts the reader raised that key and the
 * review answered `proposal-unreadable` for it.
 */
const STATE_CODES = Object.freeze({
  'state-unreadable': 'proposal-unreadable',
  'state-not-a-file': 'proposal-unreadable',
  'state-oversize': 'proposal-unreadable',
  'state-corrupt': 'proposal-unreadable',
  'proposal-invalid': 'proposal-unreadable',
  'proposal-version': 'proposal-unreadable',
  'proposal-mismatch': 'proposal-unreadable',
  'proposal-state': 'proposal-unreadable',
})

/**
 * The refusal code for one thrown error, or `null` when it is not a refusal.
 *
 * A missing record, a corrupt record, a moved source, a refused ownership claim and a
 * lost lock race are all *answers* a review reports; a malformed argument is a
 * programming error and is thrown. The translation is a table rather than a chain of
 * comparisons so the set of engine codes this module answers with is enumerable —
 * that is what `test/curation-review.test.js` holds `CURATION_REVIEW_CODES` equal to.
 *
 * @param {unknown} error - the thrown value.
 * @returns {string|null} the refusal code.
 */
function refusalCode(error) {
  if (error instanceof CurationReviewError) return error.code
  if (error instanceof CurationError) return STORE_CODES[error.code] ?? null
  if (error instanceof CurationStateError) return STATE_CODES[error.code] ?? null
  if (error instanceof TransactionError) return TRANSACTION_CODES[error.code] ?? null
  if (error instanceof MemoryError) return MEMORY_CODES[error.code] ?? null
  return null
}

/**
 * Decide one parked proposal: apply exactly its operation, or mark it rejected.
 *
 * Reads the record, validates the binding's project and the state, takes the
 * proposal's claim, re-reads the state under that claim, and only then decides —
 * applies through `applyReviewedMemory`, whose transaction re-verifies the same
 * source hashes under the vault lock, or marks the record rejected. Both decisions
 * run under the claim, so an apply and a rejection of one proposal cannot both
 * proceed — at two reviewers, which is the width the claim is exclusive at; see
 * `retireStaleClaim` for the window in which a third review can claim the same
 * proposal. The decision is persisted last, so a write that fails leaves the
 * proposal `pending` and re-reviewable rather than marked applied.
 *
 * @param {{dataRoot: string, proposalId: string, decision: string, binding: object, now?: Date, home?: string, recover?: boolean, lockTimeoutMs?: number, pollMs?: number, failAfter?: string, notifyIndex?: Function, io?: object}} input - the review.
 * @returns {Promise<{status: 'applied', receipt: object}|{status: 'rejected'}|{status: 'refused', code: string, message: string}>} the decision, its receipt, or the named refusal.
 * @throws {RangeError} when the data root, the project id, the proposal id or the decision cannot be trusted — those are programming errors, not review outcomes.
 */
export async function reviewCurationProposal({
  dataRoot,
  proposalId,
  decision,
  binding,
  now = new Date(),
  home,
  lockTimeoutMs,
  pollMs,
  failAfter,
  notifyIndex,
  io,
  recover,
}) {
  if (!DECISIONS.includes(decision)) {
    throw new RangeError(`a review decision must be one of ${DECISIONS.join(', ')}`)
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new RangeError('a review clock must be a valid Date')
  }
  const project = requireCurationBinding(binding)
  const options = { dataRoot, home, now }
  // Reading the record validates the id and the data root, and answers `null` for
  // "this project has no such proposal" — knowledge the caller must not learn
  // about another project's queue. A record whose bytes cannot be read is answered
  // here too, like every other refusal: a corrupt cache in the plugin's own data root
  // is something the caller acts on, not an exception the caller has to catch.
  let proposal
  try {
    proposal = await readCurationProposal({
      dataRoot,
      projectId: project.projectId,
      proposalId,
    })
  } catch (error) {
    const code = refusalCode(error)
    if (code === null) throw error
    return { status: 'refused', code, message: error.message }
  }
  if (proposal === null) {
    return {
      status: 'refused',
      code: 'proposal-missing',
      message: `no proposal ${proposalId} exists for this project`,
    }
  }
  if (!PROPOSAL_STATES.includes(proposal.state) || proposal.state !== 'pending') {
    return {
      status: 'refused',
      code: 'proposal-not-current',
      message: `${proposalId} is ${proposal.state}, and only a pending proposal is decided`,
    }
  }

  // Both reviewers of one proposal can read `pending` before either decides it, and
  // a *rejection* races an apply the same way. The claim is taken before either
  // decision: the loser refuses here, before it plans a write or moves a record.
  const claimId = await claimReview({ dataRoot, proposalId, project, now })
  if (claimId === null) {
    return {
      status: 'refused',
      code: 'proposal-not-current',
      message: `another review is deciding ${proposalId}; decide it again once that run has finished`,
    }
  }
  try {
    // Re-read under the claim: the store, not this module, is the arbiter for a
    // record a scan retired or a transition that landed between the read above and
    // the claim, so the decision is taken on the state owned at this moment.
    const current = await readCurationProposal({
      dataRoot,
      projectId: project.projectId,
      proposalId,
    })
    if (
      current === null ||
      !PROPOSAL_STATES.includes(current.state) ||
      current.state !== 'pending'
    ) {
      return {
        status: 'refused',
        code: current === null ? 'proposal-missing' : 'proposal-not-current',
        message:
          current === null
            ? `no proposal ${proposalId} exists for this project`
            : `${proposalId} is ${current.state}; it was decided while this review was claiming it`,
      }
    }
    if (decision === 'reject') {
      const record = await markCurationProposal({
        binding: project,
        dataRoot,
        proposalId,
        state: 'rejected',
        reason: 'a human reviewed this candidate and rejected it',
        now,
        home,
      })
      return { status: 'rejected', record: { proposalId: record.proposalId, state: record.state } }
    }
    if (current.operation === null) {
      return {
        status: 'refused',
        code: 'review-only',
        message: `${proposalId} is a ${current.kind} finding: evidence to read, with no operation to apply`,
      }
    }
    if (!EXECUTABLE_OPERATIONS.includes(current.operation.kind)) {
      return {
        status: 'refused',
        code: 'operation-not-executable',
        message: `${proposalId} carries a ${current.operation.kind} operation, which has no generic apply`,
      }
    }
    // Claimed until the record is marked, so no rejection lands between the two.
    await assertSourcesHeld(project, current)
    const receipt = await applyReviewedMemory(
      project,
      {
        operation: current.operation,
        idempotencyKey: current.itemKey,
        expectedSourceHashes: current.sources.map(({ path, hash }) => ({ path, hash })),
      },
      { ...options, recover, lockTimeoutMs, pollMs, failAfter, notifyIndex, io },
    )
    // Last, and only after the vault is committed: a proposal marked applied whose
    // write threw would be a decision the vault never made.
    const record = await markCurationProposal({
      binding: project,
      dataRoot,
      proposalId,
      state: 'applied',
      now,
      home,
    })
    return {
      status: 'applied',
      receipt,
      record: { proposalId: record.proposalId, state: record.state },
    }
  } catch (error) {
    const code = refusalCode(error)
    if (code === null) throw error
    return { status: 'refused', code, message: error.message }
  } finally {
    // Released on both paths. A review that crashed between the claim and its write
    // leaves the claim behind, which the next review reclaims because this process
    // is gone — the same rule the vault lock uses, for the same reason.
    await releaseClaim({ dataRoot, proposalId, project, claimId })
  }
}

/**
 * The text a reviewer reads before deciding: the plan, its evidence and its effect.
 *
 * A review without the exact before/after would be a confirmation dialog over an
 * unseen change, so the renderer states the operation, every source with the hash
 * it was scanned at, and — for a supersede — the note whose status the write moves
 * and the body it will hold. It reads the vault only to show what is there; every
 * value it prints comes from the stored record or from the note's own bytes.
 *
 * @param {object} proposal - the stored proposal.
 * @param {{vaultRoot: string}} options - the vault the proposal's paths are relative to.
 * @returns {Promise<string>} the review text.
 * @throws {RangeError} when no vault root is supplied: a proposal record carries paths, never a vault.
 */
export async function renderCurationProposal(proposal, { vaultRoot } = {}) {
  const lines = [
    `proposal  ${proposal.proposalId}`,
    `kind      ${proposal.kind}`,
    `state     ${proposal.state}`,
    `reason    ${proposal.reason ?? '(none)'}`,
  ]
  if (proposal.operation === null) {
    lines.push('operation (none: this record is evidence to read, not a plan to apply)')
  } else {
    const item = proposal.operation.item ?? {}
    lines.push(`operation ${proposal.operation.kind}`)
    lines.push(`title     ${item.title ?? '(none)'}`)
    if (proposal.operation.kind === 'supersede') {
      lines.push(`supersedes ${proposal.operation.supersedesId}`)
    }
    lines.push('--- body ---')
    lines.push(String(item.body ?? '').trimEnd())
  }
  lines.push('--- sources ---')
  for (const source of proposal.sources) {
    lines.push(`${source.hash}  ${source.path}`)
  }
  // The effect on the note a supersede moves: what the reviewer is agreeing to is
  // the pair of changes, not just the new file.
  if (proposal.operation !== null && proposal.operation.kind === 'supersede') {
    const target = proposal.sources.find((source) => source.id === proposal.operation.supersedesId)
    if (target !== undefined) {
      if (typeof vaultRoot !== 'string' || vaultRoot === '') {
        throw new RangeError('rendering a review needs the vault root its paths are relative to')
      }
      const absolute = await resolveVaultFile(vaultRoot, target.path).catch(() => null)
      if (absolute !== null) {
        const bytes = await fs.readFile(absolute).catch(() => null)
        if (bytes !== null) {
          const note = parseNote(bytes)
          lines.push(`--- effect on ${target.path} ---`)
          lines.push(`status    ${note.data?.status ?? '(none)'} -> superseded`)
          lines.push('linked by a new line pointing at the new note')
        }
      }
    }
  }
  lines.push(
    `--- confirm ---`,
    `type exactly:  apply ${proposal.proposalId}`,
    `          or:  reject ${proposal.proposalId}`,
    '',
  )
  return lines.join('\n')
}
