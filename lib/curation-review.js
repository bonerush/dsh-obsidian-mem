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
//     no source byte moves. This module does not take the vault lock itself: a second lock
//     around the first is a deadlock or a reentrancy bug, not a stricter check.
//   * **Only `create-separate` and `supersede` execute.** A scan finding is
//     evidence a human reads, not a plan; a deletion has no generic apply at all
//     because the vault's own rule is that a conclusion moves by being superseded,
//     never by being removed.
//
// The vault is untouched by every refusal path, and outside a transaction this module
// writes only the proposal's own decision, through the store's one lock-taking
// transition, the per-proposal claim held for the review, and its private SQLite guard.
import { randomUUID } from 'node:crypto'
import {
  promises as fs,
  constants,
  fstatSync,
  lstatSync,
  readFileSync,
  openSync,
  closeSync,
  writeFileSync,
  fsyncSync,
  renameSync,
  rmSync,
} from 'node:fs'
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
import { hasTransactionEvidence, TransactionError } from './transaction.js'

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

/** The existing JSON claim remains readable across upgrades and crash recovery. */
function claimPath(dataRoot, proposalId, project) {
  return join(curationProposalDir(dataRoot, project.projectId), `${proposalId}.claim`)
}

/**
 * Serialize claim mutations across processes without holding the vault lock.
 *
 * SQLite supplies the OS lock and releases it even on process death. The database
 * contains no proposal or vault data: it only guards the existing claim files. Every
 * callback is synchronous and short; no await, vault write or proposal transition
 * runs inside it. Keeping read/check/replace and read/check/remove in this one guard
 * prevents both stale reclamation and a late release from touching a new owner.
 *
 * The private file is opened without following symlinks and must be regular with
 * one hardlink; new files use 0600 before SQLite opens them. An unavailable module,
 * corrupt database, denied permission or busy guard refuses safely; there is no weaker
 * filesystem fallback. SQLite contention waits at most one second before the caller
 * refuses; filesystem I/O is not a wall-clock-bounded operation.
 *
 * @param {string} path - one proposal's claim path.
 * @param {Function} task - synchronous claim mutation.
 * @returns {Promise<unknown>} the callback result.
 */
async function withClaimGuard(path, task) {
  let db
  try {
    const { DatabaseSync } = await import('node:sqlite')
    const guard = join(dirname(path), '.review-lock.sqlite')
    // O_NOFOLLOW prevents even initial creation through a dangling symlink. The
    // SQLite API opens by pathname, so validate that same regular file before
    // handing it over. Manual replacement during active reviews remains unsupported.
    if (!Number.isInteger(constants.O_NOFOLLOW) || constants.O_NOFOLLOW === 0) {
      throw new Error('this platform cannot open a review guard without following symlinks')
    }
    const fd = openSync(guard, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
    try {
      const opened = fstatSync(fd)
      const named = lstatSync(guard)
      if (
        !opened.isFile() ||
        !named.isFile() ||
        opened.nlink !== 1 ||
        named.nlink !== 1 ||
        opened.ino !== named.ino ||
        opened.dev !== named.dev
      ) {
        throw new Error(
          'review guard must be a regular, non-symlink private file with one hardlink',
        )
      }
    } finally {
      closeSync(fd)
    }
    db = new DatabaseSync(guard)
    db.exec('PRAGMA busy_timeout = 1000; BEGIN IMMEDIATE')
    const answer = task()
    db.exec('COMMIT')
    return answer
  } catch (cause) {
    throw new CurationReviewError(
      'review-lock-unavailable',
      `review claim guard is unavailable: ${cause.message}`,
      { cause },
    )
  } finally {
    // Closing an uncommitted transaction rolls it back and releases its OS lock.
    db?.close()
  }
}

/** Read a claim while holding the guard; invalid bytes prove no owner's death. */
function readClaim(path) {
  try {
    const held = JSON.parse(readFileSync(path, 'utf8'))
    if (!held || typeof held.claimId !== 'string' || !Number.isInteger(held.pid) || held.pid <= 0) {
      throw new Error('review claim has no trustworthy owner; inspect it with reviewers stopped')
    }
    return held
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

/**
 * Only a confirmed dead pid permits reclamation. Time is not a fencing token:
 * an old live process may still publish. EPERM and other uncertain results are
 * treated as alive; pid reuse may delay recovery, but cannot steal a live claim.
 */
function claimIsStale(held) {
  if (!held || !Number.isInteger(held.pid) || held.pid <= 0) return false
  try {
    process.kill(held.pid, 0)
    return false
  } catch (error) {
    return error.code === 'ESRCH'
  }
}

/** Claim one proposal, checking and replacing a dead owner under the same guard. */
async function claimReview({ dataRoot, proposalId, project, now }) {
  const path = claimPath(dataRoot, proposalId, project)
  return withClaimGuard(path, () => {
    const held = readClaim(path)
    if (held !== null && !claimIsStale(held)) return null
    const mine = { claimId: randomUUID(), pid: process.pid, at: now.toISOString() }
    const staged = join(dirname(path), `.${basename(path)}.${mine.claimId}.new`)
    const fd = openSync(staged, 'wx', 0o600)
    try {
      writeFileSync(fd, `${JSON.stringify(mine)}\n`, 'utf8')
      fsyncSync(fd)
      // The live path is never withdrawn before its owner is checked. Every other
      // claimant and release must acquire this same guard before inspecting it.
      renameSync(staged, path)
      return mine.claimId
    } finally {
      closeSync(fd)
      rmSync(staged, { force: true })
    }
  })
}

/** Release only this owner, serialized with every acquisition and reclamation. */
async function releaseClaim({ dataRoot, proposalId, project, claimId }) {
  const path = claimPath(dataRoot, proposalId, project)
  // Cleanup failure must not hide a committed result. Leaving the claim in place
  // fails closed until this process exits or the local guard problem is repaired.
  await withClaimGuard(path, () => {
    if (readClaim(path)?.claimId === claimId) rmSync(path, { force: true })
  }).catch(() => {})
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
 * run under the claim, so competing applies and rejections cannot both proceed.
 * A live owner retains its claim regardless of age; acquisition and release are
 * serialized by a short, separate SQLite guard. The decision is persisted last, so
 * a write that fails leaves the proposal `pending` and re-reviewable rather than marked applied.
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
  // here too, like every other refusal: a corrupt record in the plugin's own data root
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
  let claimId
  try {
    claimId = await claimReview({ dataRoot, proposalId, project, now })
  } catch (error) {
    const code = refusalCode(error)
    if (code === null) throw error
    return { status: 'refused', code, message: error.message }
  }
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
      // The claim excludes live reviewers, but a dead apply can leave a published
      // note and a pending proposal. Inspect both manifests and receipts: the former
      // exists before the receipt store, and the latter survives manifest cleanup.
      //
      // The match is on the proposal's `itemKey`, which is the idempotency key its
      // approved write would carry. That makes it exact for the shape this guard
      // exists for — one parked candidate and its own interrupted attempt — and
      // deliberately conservative otherwise: distillation keys are positional
      // (`sessionId:toSeq:itemIndex`), so if the same job range is ever parked twice
      // against a changed vault, the second record shares the first one's key and
      // its rejection answers the same refusal. Treating that as "an application may
      // exist" is the safe reading; a rejection is never worth risking a published
      // note behind a `rejected` record.
      let started
      try {
        started = await hasTransactionEvidence(project, current.itemKey, {
          dataRoot,
          home,
          lockTimeoutMs,
          pollMs,
        })
      } catch (cause) {
        if (cause instanceof TransactionError && cause.code === 'lock-timeout') throw cause
        throw new CurationReviewError(
          'review-recovery-required',
          `cannot establish that this proposal is safe to reject: ${cause.message}`,
          { cause },
        )
      }
      if (started) {
        throw new CurationReviewError(
          'review-recovery-required',
          'this proposal has a partial or committed application; rejection changes no source bytes. If you still approve it, confirm apply in the interactive review; otherwise inspect the transaction for manual resolution',
        )
      }
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
