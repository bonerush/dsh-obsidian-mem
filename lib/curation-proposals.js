// @ts-check
// Durable review proposals: the private queue of candidates this plugin may not
// apply on its own (curation plan Task 3).
//
// A proposal exists because a *semantic* decision — "this supersedes that", "this
// restates a fact already in the vault", "this pair needs a human's judgment" —
// is not a decision an unattended worker gets to make. The vault is the source of
// truth and its notes are never changed except by an explicit transaction, so the
// candidate is parked here, whole, and a human decides later. Everything in this
// module serves that one sentence:
//
//   * **Identity is derived, never minted.** `proposalId` is the sha256 of
//     `{projectId, itemKey, kind, sources}` for one item or one stable scan
//     finding, so replaying the same candidate returns the same record instead of
//     growing the queue. `itemKey` is the caller's item idempotency key, or the
//     finding's stable key; the sources are `{path, hash}` pairs read from the
//     vault's exact bytes.
//   * **A colliding ID is a refusal, not an overwrite.** The same identity with
//     the same content is a replay; the same identity with *different* content is
//     a `proposal-conflict`, because the first reviewer's decision would otherwise
//     silently come to refer to a different candidate.
//   * **Nothing here takes the vault lock, and the reason is the interesting
//     part.** The store never holds a lock while it evaluates a candidate: the
//     capture path that supplies risky items holds the queue's own discipline and
//     a vault lock taken here would be a lock the caller's transaction would then
//     wait on. Concurrency is instead handled where the record is published — an
//     exclusive `link` publishes fully written bytes, so two processes cannot both
//     publish one ID, and the loser re-reads the winner and either replays it or
//     refuses. `markCurationProposal` is the one state transition, it is a
//     read-modify-write, and that one does take the vault lock.
//   * **A review-only record carries no operation.** A finding that needs judgment
//     (an expired review, a dead link, a missing provenance, a near duplicate) is
//     a record to read. Only `supersede` and `near-duplicate` distillation items
//     carry a plan, and a plan on any other kind is refused rather than stored and
//     ignored.
//
// The store lives under the caller's private data root — `<dataRoot>/curation/
// proposals/<projectId>/<proposalId>.json` — inside the directory
// `lib/curation-state.js` already owns, so the vault is never scratch space and
// the permission, size and atomicity rules are the ones that module established
// (`0700` directories, `0600` files, a temporary file renamed into place).
//
// Zero vault writes, by construction: no function in this file calls a
// transaction, and the only reads it performs are jailed source reads.
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import { CURATION_REVIEW_CODES } from './curation-codes.js'
import {
  CurationStateError,
  CURATION_FILE_MODE,
  curationRoot,
  requireCurationBinding,
  requireCurationDataRoot,
  requireProjectNotePath,
} from './curation-state.js'
import { sha256Hex } from './index-db.js'
import { isUuidV4 } from './pointer.js'
import { resolveVaultRoot } from './paths.js'
import { fsyncDirectory } from './receipts.js'
import { withVaultLock } from './transaction.js'

/** Schema version of one persisted proposal. */
export const PROPOSAL_SCHEMA = 1
/**
 * The refusal code vocabulary a curation *review* answers with (Task 7).
 *
 * Re-published here because this module is the review queue's own public surface:
 * a caller that reads proposals through these four functions should not have to
 * learn a second import path to enumerate the answers a decision can return. The
 * list itself is declared once, in `lib/curation-codes.js`, beside the other fixed
 * curation vocabularies.
 */
export { CURATION_REVIEW_CODES }
/** The stable states a proposal may be in. */
export const PROPOSAL_STATES = Object.freeze(['pending', 'applied', 'rejected', 'retired'])
/**
 * The states a proposal may be moved to, and from where.
 *
 * A decided proposal is never re-opened: `applied` and `rejected` are terminal
 * answers, and a queue that could silently take them back is a queue whose
 * decisions mean nothing. `retired` is the one state a later scan may write, and
 * only a human's approval may *consume* a pending record.
 */
const ALLOWED_TRANSITIONS = Object.freeze({
  pending: Object.freeze(['applied', 'rejected', 'retired']),
  applied: Object.freeze([]),
  rejected: Object.freeze(['retired']),
  retired: Object.freeze([]),
})
/**
 * The proposal kinds that carry an executable operation, and the exact operation
 * each one allows. Everything else the scanner finds is review-only evidence.
 *
 * `near-duplicate` appears in both this table and `REVIEW_FINDING_KINDS`, and that
 * is deliberate rather than a collision: the scanner's *finding* of that name is
 * review-only evidence, while a distillation item routed here because it twins an
 * existing note is a candidate a human can publish as a separate note. The
 * proposal's shape — not its name — says which one it is, and the operation is
 * what the approval path executes.
 */
const EXECUTABLE_KINDS = Object.freeze({
  supersede: 'supersede',
  'near-duplicate': 'create-separate',
})
/**
 * The finding kinds that may be recorded as review-only proposals.
 *
 * Deliberately the scanner's own judgement-dependent set. The state-level findings
 * (`unexamined`, `findings-truncated`, `record-unreadable`, `cursor-invalid`,
 * `manifest-truncated`, `enumeration-failed`, `resolver-truncated`) are dropped by
 * `recordCurationFindings` rather than refused: they describe the store, not a note a
 * human could review, and a pass that produced one must still be able to record the
 * findings beside it. A kind outside this set is skipped and counted in `skipped`,
 * not refused: the scanner can gain a finding kind before this list does, and a pass
 * whose findings are mostly unknown must still record the ones it knows.
 */
export const REVIEW_FINDING_KINDS = Object.freeze([
  'expired-review',
  'dead-wikilink',
  'missing-provenance',
  'near-duplicate',
])
/** Upper bound on one stored proposal document, matching the scan-record family. */
export const MAX_PROPOSAL_BYTES = 64 * 1024
/** How many reasons and paths a listing row may carry, so one read stays bounded. */
export const MAX_LIST_LIMIT = 200
/** The longest reason string one record keeps. */
export const MAX_REASON_CHARS = 2_048
/** The longest `itemKey` one record keeps. */
export const MAX_ITEM_KEY_CHARS = 512

/** Raised when a proposal cannot be trusted, placed or edited. */
export class CurationError extends Error {
  /**
   * @param {string} code - machine-readable reason (`proposal-conflict`, `proposal-oversize`, …).
   * @param {string} message - human-readable diagnostic naming the offending value.
   * @param {{ cause?: Error }} [options] - underlying failure, when there is one.
   */
  constructor(code, message, options) {
    super(message, options)
    this.name = 'CurationError'
    this.code = code
  }
}

// ---------------------------------------------------------------------------
// Identity and canonical serialization
// ---------------------------------------------------------------------------

/**
 * A JSON string whose object keys are sorted, so a hash cannot depend on order.
 *
 * The stored `operation` is kept as the caller wrote it (a reviewer should read
 * the candidate they submitted), but every hash is taken over this form: a
 * `contentHash` that changed when a model reordered two keys would turn an
 * idempotent replay into a conflict — the failure this module's identity exists
 * to prevent.
 *
 * @param {*} value - the value to canonicalize.
 * @returns {string} the canonical JSON.
 */
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
}

/**
 * One non-blank string, or a refusal.
 *
 * @param {unknown} value - the candidate.
 * @param {string} field - the field name, for the message.
 * @param {number} [maxChars] - the longest value that may be kept.
 * @param {string} [code] - a `CurationError` code; absent means a `RangeError`.
 * @returns {string} the string.
 * @throws {RangeError} when it is not a non-blank string or is over the bound.
 * @throws {CurationError} when a code was supplied and the value is blank.
 */
function requireText(value, field, maxChars, code) {
  if (typeof value !== 'string' || value.trim() === '') {
    const message = `${field} must be a non-blank string`
    if (code === undefined) throw new RangeError(message)
    throw new CurationError(code, message)
  }
  if (maxChars !== undefined && value.length > maxChars) {
    throw new RangeError(`${field} is ${value.length} characters, over the ${maxChars} bound`)
  }
  return value
}

/**
 * A string value with its length bounded, for fields that are prose and must not
 * be able to grow the document past the bound its own reader enforces.
 *
 * @param {unknown} value - the candidate.
 * @param {number} maxChars - the longest value kept.
 * @returns {string|null} the bounded string, or `null` when it was not a string.
 */
function boundedText(value, maxChars) {
  return typeof value === 'string' ? value.slice(0, maxChars) : null
}

/**
 * Normalize the source list a proposal is built from.
 *
 * A source is the exact evidence a review will re-verify: the note's stable id
 * (when it has one), its vault-relative path — which is what makes the record
 * project-scoped — and the sha256 of its exact bytes. The coercion (trimming,
 * de-duplication of a repeated path) is here so no caller can store two forms of
 * the same source and get two different proposal IDs for one candidate.
 *
 * @param {unknown} sources - the candidate list.
 * @returns {Array<{id: string|null, path: string, hash: string}>} the normalized sources, sorted by path.
 * @throws {RangeError} when a source is not `{path, hash}` with a sha256 hash.
 */
function normalizeSources(sources) {
  if (!Array.isArray(sources)) throw new RangeError('a proposal carries an array of sources')
  const byPath = new Map()
  for (const source of sources) {
    if (source === null || typeof source !== 'object' || Array.isArray(source)) {
      throw new RangeError('a proposal source must be a plain object')
    }
    const path = requireText(source.path, 'a proposal source path')
    const hash = requireText(source.hash, `the hash of ${path}`)
    if (!/^[0-9a-f]{64}$/u.test(hash)) {
      throw new RangeError(`the hash of ${path} must be the sha256 of its bytes`)
    }
    const id =
      source.id === undefined || source.id === null ? null : requireText(source.id, 'a source id')
    if (!byPath.has(path)) byPath.set(path, { id, path, hash })
  }
  return [...byPath.values()].sort((left, right) => (left.path < right.path ? -1 : 1))
}

/**
 * The proposal ID of one candidate: a sha256 over its project, identity, kind and
 * exact sources.
 *
 * Paths are sorted before hashing so a caller that read the same sources in
 * another order gets the same identity. The hash is over the *sources'* hashes,
 * not the paths alone: a note edited between two passes has different bytes, and a
 * candidate whose evidence moved is a candidate that has to be reviewed again —
 * which is what makes the ID change and the stale record retire, instead of the
 * review silently re-pointing at content nobody looked at.
 *
 * @param {{projectId: string, itemKey: string, kind: string, sources: object[]}} input - the identity inputs.
 * @returns {string} the 64-hex proposal id.
 */
function proposalIdOf({ projectId, itemKey, kind, sources }) {
  return sha256Hex(
    canonicalJson({
      projectId,
      itemKey,
      kind,
      // A path→hash map rather than a list of pairs: the map is the form a
      // re-computation from the record's own fields takes, and two encodings of one
      // identity would be two proposal IDs for one candidate.
      sources: Object.fromEntries(sources.map((source) => [source.path, source.hash])),
    }),
  )
}

/**
 * The content hash of a proposal: everything a decision is a decision *about*.
 *
 * Sources are excluded on purpose. A review-only record is re-recorded on every
 * pass, and a note edited between two passes must not turn that replay into a
 * conflict — the choice is re-verified by the approval path against the hashes the
 * record already carries. What a human decides on is here: the review details, or
 * the executable operation and the evidence it was derived from.
 *
 * @param {{projectId: string, itemKey: string, kind: string, review: object|null, operation: object|null, evidence: number[]}} input - the semantic inputs.
 * @returns {string} the 64-hex content hash.
 */
function contentHashOf({ projectId, itemKey, kind, review, operation, evidence }) {
  return sha256Hex(canonicalJson({ projectId, itemKey, kind, review, operation, evidence }))
}

/**
 * The one-line human summary of a distillation proposal, as a listing carries it.
 *
 * @param {object} operation - the validated operation.
 * @returns {string} the reason.
 */
function reasonOfOperation(operation) {
  if (operation.kind === 'supersede')
    return 'a distilled conclusion proposes to supersede an existing note'
  return 'a distilled candidate restates a note that already exists'
}

/**
 * Validate one executable operation, or refuse it.
 *
 * @param {unknown} operation - the candidate.
 * @param {string} kind - the proposal kind it must match.
 * @returns {object} the normalized operation.
 * @throws {RangeError} when the operation is absent or of the wrong shape.
 */
function normalizeOperation(operation, kind) {
  if (operation === null || typeof operation !== 'object' || Array.isArray(operation)) {
    throw new RangeError('an executable proposal needs an operation object')
  }
  const candidate = /** @type {{kind?: unknown, item?: unknown, supersedesId?: unknown}} */ (
    operation
  )
  const expected = EXECUTABLE_KINDS[kind]
  if (candidate.kind !== expected) {
    throw new RangeError(
      `a ${kind} proposal carries a ${expected} operation, not ${JSON.stringify(candidate.kind)}`,
    )
  }
  const item = candidate.item
  if (item === null || typeof item !== 'object' || Array.isArray(item)) {
    throw new RangeError('an executable proposal carries the whole validated candidate item')
  }
  if (expected === 'supersede') {
    const supersedesId = requireText(
      candidate.supersedesId,
      'a supersede operation needs the id it replaces',
    )
    return { kind: expected, supersedesId, item }
  }
  return { kind: expected, item }
}

/**
 * The review details of a finding-kind proposal: the facts a human decides on.
 *
 * Only these keys are kept, so the record's own shape — not whatever a caller
 * passed — is what a reviewer reads and what the content hash covers.
 *
 * @param {object} input - the candidate details.
 * @returns {object} the review object.
 */
function reviewOf(input) {
  const review = {
    reason: boundedText(input.reason, MAX_REASON_CHARS),
    title: boundedText(input.title, MAX_ITEM_KEY_CHARS),
    target: boundedText(input.target, MAX_ITEM_KEY_CHARS),
    missing: Array.isArray(input.missing)
      ? input.missing.filter((value) => typeof value === 'string').slice(0, 16)
      : null,
  }
  return review
}

/**
 * Validate the item's evidence sequence list.
 *
 * @param {unknown} evidence - the candidate.
 * @returns {number[]} the sequence numbers.
 * @throws {RangeError} when an entry is not a non-negative integer.
 */
function normalizeEvidence(evidence) {
  if (evidence === undefined || evidence === null) return []
  if (!Array.isArray(evidence))
    throw new RangeError('proposal evidence must be an array of sequence numbers')
  for (const value of evidence) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(
        `proposal evidence holds only non-negative integers, not ${JSON.stringify(value)}`,
      )
    }
  }
  return [...evidence]
}

// ---------------------------------------------------------------------------
// Paths and private files
// ---------------------------------------------------------------------------

/**
 * The directory holding one project's proposals.
 *
 * @param {string} dataRoot - the plugin data root.
 * @param {string} projectId - the owning project's UUIDv4.
 * @returns {string} absolute path (not created here).
 * @throws {RangeError} when the data root or the project id is invalid.
 */
export function curationProposalDir(dataRoot, projectId) {
  requireCurationDataRoot(dataRoot)
  if (!isUuidV4(projectId)) throw new RangeError('a proposal store needs a UUIDv4 project id')
  return join(curationRoot(dataRoot), 'proposals', projectId)
}

/**
 * The document of one proposal.
 *
 * @param {string} dataRoot - the plugin data root.
 * @param {string} projectId - the owning project's UUIDv4.
 * @param {string} proposalId - the proposal's sha256 identity.
 * @returns {string} absolute path (not created here).
 * @throws {RangeError} when any segment is invalid.
 */
export function curationProposalPath(dataRoot, projectId, proposalId) {
  const directory = curationProposalDir(dataRoot, projectId)
  if (typeof proposalId !== 'string' || !/^[0-9a-f]{64}$/u.test(proposalId)) {
    throw new RangeError('a proposal id must be the 64-hex sha256 of its identity')
  }
  return join(directory, `${proposalId}.json`)
}

/**
 * Create (or tighten) one private directory to `0700`.
 *
 * @param {string} directory - absolute directory.
 * @returns {Promise<void>} resolves once the directory is private.
 */
async function ensurePrivateDir(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  await fs.chmod(directory, 0o700)
}

/**
 * Publish one document by creating it exclusively, so a race has one winner.
 *
 * @param {string} path - absolute destination path.
 * @param {unknown} value - the JSON-serializable document.
 * @returns {Promise<'written'>} resolved once the bytes are published and the directory synced.
 * @throws {Error} with code `EEXIST` for the loser of the exclusive `link`; the caller re-reads
 *   the winner's record rather than treating the collision as a failure.
 */
async function publishExclusive(path, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`)
  let handle = null
  try {
    handle = await fs.open(temporary, 'wx', CURATION_FILE_MODE)
    await handle.writeFile(text, 'utf8')
    await handle.sync()
    await handle.close()
    handle = null
    // link is exclusive and exposes only complete, already fsynced bytes.
    await fs.link(temporary, path)
    await fsyncDirectory(dirname(path))
  } finally {
    try {
      await handle?.close()
    } finally {
      await fs.rm(temporary, { force: true })
    }
  }
  return 'written'
}

/**
 * Replace one document atomically, for the state transitions a record's owner
 * performs after the exclusive create.
 *
 * @param {string} path - absolute destination path.
 * @param {unknown} value - the JSON-serializable document.
 * @returns {Promise<void>} resolves once the rename is visible and durable.
 */
async function replaceAtomic(path, value) {
  const directory = dirname(path)
  await ensurePrivateDir(directory)
  const text = `${JSON.stringify(value, null, 2)}\n`
  const temporary = join(directory, `.${basename(path)}.${process.pid}.${Date.now()}.tmp`)
  let handle = null
  try {
    handle = await fs.open(temporary, 'wx', CURATION_FILE_MODE)
    await handle.writeFile(text, 'utf8')
    await handle.close()
    handle = null
    await fs.rename(temporary, path)
  } catch (error) {
    await handle?.close().catch(() => {})
    await fs.rm(temporary, { force: true }).catch(() => {})
    throw error
  }
  await fsyncDirectory(directory)
}

// ---------------------------------------------------------------------------
// Reading one document
// ---------------------------------------------------------------------------

/**
 * Parse and validate one stored proposal.
 *
 * @param {string} path - absolute document path.
 * @param {string} projectId - the project the document must belong to.
 * @param {string} proposalId - the id the document must carry.
 * @returns {Promise<object|null>} the record, or `null` when there is no document.
 * @throws {CurationStateError} when the document exists but cannot be trusted.
 */
async function readRecord(path, projectId, proposalId) {
  let stats
  try {
    stats = await fs.lstat(path)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw new CurationStateError(
      'state-unreadable',
      `cannot read ${path}: ${error.code ?? error.message}`,
      {
        cause: error,
      },
    )
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new CurationStateError('state-not-a-file', `${path} is not a regular file`)
  }
  if (stats.size > MAX_PROPOSAL_BYTES) {
    throw new CurationStateError(
      'state-oversize',
      `${path} holds ${stats.size} bytes, over the ${MAX_PROPOSAL_BYTES}-byte proposal bound`,
    )
  }
  let raw
  try {
    raw = JSON.parse(await fs.readFile(path, 'utf8'))
  } catch (error) {
    throw new CurationStateError('state-corrupt', `${path} is not valid JSON`, { cause: error })
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CurationStateError('proposal-invalid', 'a proposal must be a plain object')
  }
  if (raw.version !== PROPOSAL_SCHEMA) {
    throw new CurationStateError(
      'proposal-version',
      `a proposal must be version ${PROPOSAL_SCHEMA}, not ${JSON.stringify(raw.version)}`,
    )
  }
  if (raw.proposalId !== proposalId) {
    throw new CurationStateError(
      'proposal-mismatch',
      `${path} carries proposal id ${JSON.stringify(raw.proposalId)}, not ${proposalId}`,
    )
  }
  if (raw.projectId !== projectId) {
    throw new CurationStateError(
      'proposal-mismatch',
      `${path} belongs to project ${JSON.stringify(raw.projectId)}, not ${projectId}`,
    )
  }
  if (!PROPOSAL_STATES.includes(raw.state)) {
    throw new CurationStateError(
      'proposal-state',
      `a stored proposal state must be one of ${PROPOSAL_STATES.join(', ')}, not ${JSON.stringify(raw.state)}`,
    )
  }
  return { ...raw, sources: normalizeSources(raw.sources ?? []) }
}

// ---------------------------------------------------------------------------
// The public store
// ---------------------------------------------------------------------------

/**
 * Read the exact bytes of each source a risky candidate names, through the jail.
 *
 * The hash is always computed from bytes read here, never taken from an index or
 * from a caller's claim. That is the whole point of a snapshot: an approval
 * re-verifies these hashes, so a hash this function did not read is a hash no
 * later check can be honest about.
 *
 * Both a missing path and an unsafe one are `CurationError`s rather than
 * `MemoryError`s: the caller is the distillation apply path, which turns this into
 * a retryable refusal. The distinction is the reason both codes are named —
 * `proposal-source-unsafe` is a jail or project-ownership refusal (a path that
 * must never be retried into existence), and `proposal-source-unreadable` is a
 * source that could not be read (which a later attempt may find again).
 *
 * @param {object} binding - a `kind:'bound'` binding.
 * @param {{supersedesId?: string|null, twin?: object|null, home?: string}} [input] - the risky candidate's targets.
 * @returns {Promise<Array<{id: string|null, path: string, hash: string}>>} one source per target, in target order.
 * @throws {CurationError} with code `proposal-source-missing`, `proposal-source-unsafe` or `proposal-source-unreadable`.
 * @throws {RangeError} when the binding is not a bound project.
 */
export async function snapshotProposalSources(
  binding,
  { supersedesId = null, twin = null, home } = {},
) {
  const project = requireCurationBinding(binding)
  const wanted = []
  if (typeof supersedesId === 'string' && supersedesId !== '') {
    if (twin !== null && twin !== undefined && typeof twin.path === 'string' && twin.path !== '') {
      wanted.push({ id: supersedesId, path: twin.path })
    } else {
      throw new CurationError(
        'proposal-source-missing',
        `the candidate supersedes ${supersedesId}, but no resolved path was supplied to snapshot`,
      )
    }
  } else if (twin !== null && twin !== undefined) {
    if (typeof twin.path !== 'string' || twin.path === '') {
      throw new CurationError(
        'proposal-source-missing',
        'the duplicate lookup returned no vault path',
      )
    }
    wanted.push({
      id: typeof twin.id === 'string' && twin.id !== '' ? twin.id : null,
      path: twin.path,
    })
  }
  if (wanted.length === 0) {
    throw new CurationError(
      'proposal-source-missing',
      'a proposal needs at least one source: neither a supersede target nor a twin was supplied',
    )
  }
  const root = (await resolveVaultRoot(project.vaultRoot, { home })).root
  const sources = []
  for (const target of wanted) {
    try {
      await requireProjectNotePath(project, target.path, { home })
    } catch (error) {
      if (error instanceof CurationError) throw error
      throw new CurationError(
        'proposal-source-unsafe',
        `${target.path} is not a note this project owns: ${error.code ?? error.message}`,
        { cause: error },
      )
    }
    const absolute = await fs
      .realpath(join(root, ...target.path.split('/')))
      .catch((error) => ({ error }))
    if (absolute instanceof Object && 'error' in absolute) {
      throw new CurationError(
        'proposal-source-unreadable',
        `cannot read ${target.path}: ${absolute.error.code ?? absolute.error.message}`,
        { cause: absolute.error },
      )
    }
    let bytes
    try {
      bytes = await fs.readFile(absolute)
    } catch (error) {
      throw new CurationError(
        'proposal-source-unreadable',
        `cannot read ${target.path}: ${error.code ?? error.message}`,
        { cause: error },
      )
    }
    sources.push({ id: target.id, path: target.path, hash: sha256Hex(bytes) })
  }
  return normalizeSources(sources)
}

/**
 * Persist one proposal, returning the record that is now durable.
 *
 * A replay (same identity, same content) returns the stored record untouched: the
 * candidate has already been parked and the queue must not grow a second entry for
 * it. The same identity with different content is a `proposal-conflict`, because
 * the first decision would otherwise come to refer to a different candidate.
 *
 * @param {object} input - the proposal.
 * @param {string} input.dataRoot - the plugin data root.
 * @param {string} input.projectId - the owning project's UUIDv4.
 * @param {string} input.itemKey - the item idempotency key, or the scan finding's stable key.
 * @param {string} input.kind - `supersede`, `near-duplicate`, or a `REVIEW_FINDING_KINDS` value.
 * @param {Array<{id?: string|null, path: string, hash: string}>} [input.sources] - the evidence.
 * @param {{kind: string, item: object, supersedesId?: string}} [input.operation] - the plan, for an executable kind.
 * @param {number[]} [input.evidence] - the source event sequence numbers.
 * @param {string} [input.reason] - the one-line review reason.
 * @param {string} [input.title] - the finding's title, as the scanner saw it.
 * @param {string} [input.target] - the finding's link target.
 * @param {string[]} [input.missing] - the finding's missing provenance fields.
 * @param {string} [input.proposalId] - a pre-computed identity (used to prove collisions).
 * @param {boolean} [input.reviewOnly] - force the review-only form of an executable kind (the scanner's call for a near-duplicate finding).
 * @param {Date} [input.now] - the clock.
 * @returns {Promise<object>} the durable record.
 * @throws {CurationError} with code `proposal-conflict`, `proposal-oversize` or `proposal-kind-operation`.
 * @throws {RangeError} when a field is missing or malformed.
 */
export async function saveCurationProposal(input) {
  return (await saveProposalResult(input)).record
}

/** Save once and report which producer actually published the immutable candidate. */
async function saveProposalResult(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new RangeError('a proposal must be a plain object')
  }
  const dataRoot = requireCurationDataRoot(input.dataRoot)
  const projectId = requireText(input.projectId, 'proposal projectId')
  if (!isUuidV4(projectId)) throw new RangeError('proposal projectId must be a UUIDv4')
  const itemKey = requireText(input.itemKey, 'proposal itemKey', MAX_ITEM_KEY_CHARS)
  const kind = requireText(input.kind, 'proposal kind', undefined, 'proposal-kind')
  // A kind is executable when something known executes it, and review-only when it
  // is a finding a human reads. `near-duplicate` is both: the scanner's finding of
  // that name is evidence, while a distillation item parked because it twins an
  // existing note is a candidate an approval path can publish. The executable table
  // therefore has to be asked first, or a distillation twin would be refused the
  // operation it exists for.
  const executable = EXECUTABLE_KINDS[kind] !== undefined
  if (!executable && !REVIEW_FINDING_KINDS.includes(kind)) {
    throw new CurationError(
      'proposal-kind',
      `proposal kind must be one of ${[...Object.keys(EXECUTABLE_KINDS), ...REVIEW_FINDING_KINDS].join(', ')}, not ${JSON.stringify(kind)}`,
    )
  }
  const hasOperation = input.operation !== undefined && input.operation !== null
  if (!executable && hasOperation) {
    // The finding kinds are evidence, not plans. Storing an operation beside one
    // would be a record an approval path could later execute, which is exactly the
    // semantic power this module exists to withhold. This is checked *before* the
    // operation is normalized: the refusal a caller must see is "this kind is
    // review-only", not "this operation does not match a table this kind is not in".
    throw new CurationError(
      'proposal-kind-operation',
      `a ${kind} proposal is review-only and cannot carry an executable operation`,
    )
  }
  // The operation is normalized with its own code so a malformed plan is
  // distinguishable from a malformed identity or a malformed kind.
  let operation = null
  if (hasOperation) {
    try {
      operation = normalizeOperation(input.operation, kind)
    } catch (error) {
      throw new CurationError('proposal-operation', error.message, { cause: error })
    }
  }
  // `reviewOnly: true` is the scanner's call, and it is the only way an executable
  // *kind* is stored without the operation its executable form requires. A kind that
  // executes nothing never needs it; a distillation twin always does.
  if (executable && operation === null && input.reviewOnly !== true) {
    throw new CurationError(
      'proposal-kind-operation',
      `a ${kind} proposal is executable and must carry its operation`,
    )
  }
  const readOnly = operation === null
  const sources = normalizeSources(input.sources ?? [])
  const evidence = normalizeEvidence(input.evidence)
  const review = readOnly ? reviewOf(input) : null
  const now = input.now ?? new Date()
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new RangeError('a proposal clock must be a valid Date')
  }
  const reviewed =
    input.proposalId === undefined || input.proposalId === null ? null : input.proposalId
  if (reviewed !== null && (typeof reviewed !== 'string' || !/^[0-9a-f]{64}$/u.test(reviewed))) {
    throw new RangeError('a proposal id must be the 64-hex sha256 of its identity')
  }
  const proposalId = reviewed ?? proposalIdOf({ projectId, itemKey, kind, sources })
  const contentHash = contentHashOf({ projectId, itemKey, kind, review, operation, evidence })
  const path = curationProposalPath(dataRoot, projectId, proposalId)

  let existing = await readRecord(path, projectId, proposalId)
  if (existing !== null) {
    if (existing.contentHash !== contentHash) {
      throw new CurationError(
        'proposal-conflict',
        `${proposalId} already exists with different content; a decided proposal is never rewritten`,
      )
    }
    return { record: existing, created: false }
  }

  const record = {
    version: PROPOSAL_SCHEMA,
    proposalId,
    projectId,
    itemKey,
    kind,
    state: 'pending',
    reason:
      boundedText(input.reason, MAX_REASON_CHARS) ??
      (operation === null ? null : reasonOfOperation(operation)),
    contentHash,
    sources,
    operation,
    evidence,
    review,
    createdAt: now.toISOString(),
    seenAt: now.toISOString(),
    decidedAt: null,
    retiredAt: null,
    retiredReason: null,
  }
  const text = `${JSON.stringify(record, null, 2)}\n`
  if (Buffer.byteLength(text, 'utf8') > MAX_PROPOSAL_BYTES) {
    throw new CurationError(
      'proposal-oversize',
      `this proposal would hold ${Buffer.byteLength(text, 'utf8')} bytes, over the ${MAX_PROPOSAL_BYTES}-byte bound`,
    )
  }
  await ensurePrivateDir(dirname(path))
  try {
    await publishExclusive(path, record)
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    // Another process published this identity between the read above and the
    // exclusive create. Re-read it: a replay is a replay whichever process wrote
    // it, and a genuine collision is refused by the same rule as above.
    existing = await readRecord(path, projectId, proposalId)
    if (existing === null) {
      throw new CurationError(
        'proposal-conflict',
        `${proposalId} exists but could not be read back`,
      )
    }
    if (existing.contentHash !== contentHash) {
      throw new CurationError(
        'proposal-conflict',
        `${proposalId} already exists with different content; a decided proposal is never rewritten`,
      )
    }
    return { record: existing, created: false }
  }
  return { record, created: true }
}

/**
 * Read one proposal.
 *
 * @param {{dataRoot: string, projectId: string, proposalId: string}} input - the lookup.
 * @returns {Promise<object|null>} the record, or `null` when this project has no such proposal.
 * @throws {CurationStateError} when the stored document cannot be trusted.
 * @throws {RangeError} when the data root, the project id or the proposal id is invalid.
 */
export async function readCurationProposal({ dataRoot, projectId, proposalId }) {
  const path = curationProposalPath(dataRoot, projectId, proposalId)
  return readRecord(path, projectId, proposalId)
}

/**
 * List the proposals of one project, bounded and with truncation named.
 *
 * The read is deliberately shallow: a row carries the identity, the state, the
 * reason and the source paths a status surface renders, and never the candidate
 * itself. A status read that loaded every parked candidate's body would be an
 * unbounded read of every note the plugin ever distilled.
 *
 * @param {{dataRoot: string, projectId: string, state?: string|null, limit?: number, now?: Date}} input - the query.
 * @returns {Promise<{projectId: string, total: number, truncated: boolean, proposals: object[], unreadable: string[], missingDir?: boolean}>} the bounded listing.
 * @throws {RangeError} when the data root, the project id, the state or the limit is invalid.
 */
export async function listCurationProposals({
  dataRoot,
  projectId,
  state = null,
  limit = MAX_LIST_LIMIT,
}) {
  if (state !== null && !PROPOSAL_STATES.includes(state)) {
    throw new RangeError(`a proposal state filter must be one of ${PROPOSAL_STATES.join(', ')}`)
  }
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_LIST_LIMIT) {
    throw new RangeError(`a proposal listing limit must be an integer in 1..${MAX_LIST_LIMIT}`)
  }
  const rows = []
  const { unreadable, missingDir } = await visitProposalRecords(dataRoot, projectId, (record) => {
    if (state !== null && record.state !== state) return
    rows.push({
      proposalId: record.proposalId,
      kind: record.kind,
      state: record.state,
      reason: record.reason,
      reviewOnly: record.operation === null,
      itemKey: record.itemKey,
      paths: record.sources.map((source) => source.path),
      createdAt: record.createdAt,
      seenAt: record.seenAt,
      decidedAt: record.decidedAt,
    })
  })
  if (missingDir)
    return { projectId, total: 0, truncated: false, proposals: [], unreadable, missingDir: true }
  // The review queue is a queue: newest first, with the id as the tiebreaker so a
  // status surface is stable between two reads of one unchanged store.
  rows.sort((left, right) =>
    left.createdAt === right.createdAt
      ? left.proposalId < right.proposalId
        ? -1
        : 1
      : left.createdAt > right.createdAt
        ? -1
        : 1,
  )
  return {
    projectId,
    total: rows.length,
    truncated: rows.length > limit,
    proposals: rows.slice(0, limit),
    unreadable,
  }
}

/** Visit every valid record sequentially without retaining candidate bodies. */
async function visitProposalRecords(dataRoot, projectId, visit) {
  const directory = curationProposalDir(dataRoot, projectId)
  let names
  try {
    names = await fs.readdir(directory)
  } catch (error) {
    if (error.code === 'ENOENT') return { unreadable: [], missingDir: true }
    throw new CurationStateError(
      'state-unreadable',
      `cannot list ${directory}: ${error.code ?? error.message}`,
      { cause: error },
    )
  }
  const unreadable = []
  for (const name of names.sort()) {
    if (!/^[0-9a-f]{64}\.json$/u.test(name)) continue
    const proposalId = name.slice(0, -5)
    let record
    try {
      record = await readRecord(join(directory, name), projectId, proposalId)
    } catch (error) {
      if (!(error instanceof CurationStateError)) throw error
      unreadable.push(proposalId)
      continue
    }
    if (record !== null) visit(record)
  }
  return { unreadable, missingDir: false }
}

/**
 * Move one proposal to a decided state, under the vault lock.
 *
 * This is the only state transition in the module and the only place a vault lock
 * is taken: it is a read-modify-write of a private document, and two processes
 * deciding one proposal at once must not both believe they won. The lock is the
 * same `realpath(vaultRoot)`-keyed lock every vault mutation uses, so a decision
 * cannot interleave with a transaction that touches the note the proposal names.
 *
 * @param {{binding: object, dataRoot: string, proposalId: string, state: string, reason?: string, now?: Date, home?: string}} input - the transition.
 * @returns {Promise<object>} the updated record.
 * @throws {CurationError} with code `proposal-missing` or `proposal-state`.
 * @throws {RangeError} when the binding, the data root or the proposal id is invalid.
 */
export async function markCurationProposal({
  binding,
  dataRoot,
  proposalId,
  state,
  reason = null,
  now = new Date(),
  home,
}) {
  const project = requireCurationBinding(binding)
  const path = curationProposalPath(dataRoot, project.projectId, proposalId)
  if (typeof state !== 'string' || !PROPOSAL_STATES.includes(state)) {
    throw new CurationError(
      'proposal-state',
      `a proposal state must be one of ${PROPOSAL_STATES.join(', ')}, not ${JSON.stringify(state)}`,
    )
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new RangeError('a proposal clock must be a valid Date')
  }
  return withVaultLock(
    project,
    async () => {
      const existing = await readRecord(path, project.projectId, proposalId)
      if (existing === null) {
        throw new CurationError(
          'proposal-missing',
          `no proposal ${proposalId} exists for this project`,
        )
      }
      if (existing.state === state) return existing
      if (!ALLOWED_TRANSITIONS[existing.state].includes(state)) {
        throw new CurationError(
          'proposal-state',
          `${proposalId} is ${existing.state} and cannot become ${state}`,
        )
      }
      const updated = {
        ...existing,
        state,
        reason: existing.reason ?? boundedText(reason, MAX_REASON_CHARS),
        decidedAt: now.toISOString(),
        retiredAt: state === 'retired' ? now.toISOString() : existing.retiredAt,
        retiredReason:
          state === 'retired' ? boundedText(reason, MAX_REASON_CHARS) : existing.retiredReason,
      }
      await replaceAtomic(path, updated)
      return updated
    },
    { dataRoot, home },
  )
}

/**
 * Persist the judgment-dependent findings of one scan as review-only proposals.
 *
 * This is the seam between the scanner and the store, and it is deliberately
 * *after* the scan: the scan reads notes and decides nothing about the queue, and
 * this function consumes the findings as data. Three rules shape it:
 *
 *   * **A finding's subject is its kind and paths; its identity also includes
 *     source hashes.** Unchanged evidence replays one ID; edited evidence gets a
 *     new ID and retires the old candidate rather than changing its meaning.
 *   * **A stale record is retired, not rewritten.** When the same subject comes
 *     back with different bytes (an edited note), the old proposal — built from
 *     evidence that no longer exists — is marked `retired` and the current one is
 *     recorded. The state module's own records are never touched, and no source
 *     note is ever changed.
 *   * **The state-level findings are skipped, not refused.** A pass that reports
 *     `unexamined` or `cursor-invalid` must still be able to record the findings
 *     beside them; a kind nothing here knows how to park is counted in `skipped` and
 *     passed over, not raised, so one unknown kind cannot cost a pass the findings it
 *     does know.
 *
 * `updated` stays empty for compatibility: candidate contents are immutable.
 *
 * @param {{binding: object, dataRoot: string, findings: object[], home?: string, now?: Date}} input - the pass result.
 * @returns {Promise<{projectId: string, created: object[], updated: object[], retired: object[], replayed: object[], skipped: number, unreadable: string[], processingTruncated: boolean}>} what the pass did.
 * @throws {CurationError} when a finding cannot be placed (a conflict, an oversize record).
 * @throws {RangeError} when the binding, the data root or a path is invalid.
 */
export async function recordCurationFindings({
  binding,
  dataRoot,
  findings,
  home,
  now = new Date(),
}) {
  const project = requireCurationBinding(binding)
  requireCurationDataRoot(dataRoot)
  if (!Array.isArray(findings))
    throw new RangeError('recordCurationFindings needs an array of findings')
  const created = []
  const updated = []
  const retired = []
  const replayed = []
  let skipped = 0
  // Which subject each pending review-only proposal currently covers, so a
  // proposal whose finding came back with different bytes can be retired by
  // identity rather than left open beside the replacement for it.
  const openBySubject = new Map()
  const pending = await visitProposalRecords(dataRoot, project.projectId, (row) => {
    if (
      row.state !== 'pending' ||
      row.operation !== null ||
      !REVIEW_FINDING_KINDS.includes(row.kind)
    )
      return
    if (!openBySubject.has(row.itemKey)) openBySubject.set(row.itemKey, [])
    openBySubject.get(row.itemKey).push(row.proposalId)
  })

  for (const finding of findings) {
    if (finding === null || typeof finding !== 'object') {
      throw new RangeError('a curation finding must be a plain object')
    }
    if (!REVIEW_FINDING_KINDS.includes(finding.kind)) {
      skipped += 1
      continue
    }
    const paths = (
      Array.isArray(finding.paths) && finding.paths.length > 0 ? finding.paths : [finding.path]
    ).filter((path) => typeof path === 'string' && path !== '')
    if (paths.length === 0) {
      throw new RangeError(`a ${finding.kind} finding must name the note or notes it is about`)
    }
    // Every path is jailed and shape-checked before it can become evidence, so a
    // finding about another project can never be parked as one of this project's.
    for (const path of paths) await requireProjectNotePath(project, path, { home })
    const sources = []
    for (const path of [...paths].sort()) {
      const absolute = join(project.vaultRoot, ...path.split('/'))
      let bytes
      try {
        bytes = await fs.readFile(absolute)
      } catch (error) {
        throw new CurationError(
          'proposal-source-unreadable',
          `cannot read ${path} to record a ${finding.kind} finding: ${error.code ?? error.message}`,
          { cause: error },
        )
      }
      // Hashed from the bytes just read, never from a caller's claim: these are the
      // hashes an approval re-verifies, so a hash this function did not read itself
      // is one no later check can be honest about.
      sources.push({ id: null, path, hash: sha256Hex(bytes) })
    }
    const itemKey = `scan:${finding.kind}:${[...paths].sort().join('|')}`
    const saved = await saveProposalResult({
      dataRoot,
      now,
      projectId: project.projectId,
      itemKey,
      kind: finding.kind,
      // A finding is never a plan, whatever its kind is called: this is the call
      // that says so, and it is why a near duplicate can be review-only here while
      // the same kind carries `create-separate` when a distillation item is parked.
      reviewOnly: true,
      reason: finding.message,
      title: finding.title,
      target: finding.target,
      missing: finding.missing,
      sources,
    })
    const record = saved.record
    const row = {
      proposalId: record.proposalId,
      kind: record.kind,
      state: record.state,
      paths: record.sources.map((source) => source.path),
      reason: record.reason,
      // This is the *writer's* view of what it just parked, not the status
      // listing's: it says whether the record carries a plan, because that is what
      // lets a caller assert that a finding never became executable.
      operation: record.operation,
    }
    // The publication result remains honest for repeated findings and concurrent producers.
    if (saved.created) created.push(row)
    else replayed.push(row)

    for (const staleId of openBySubject.get(itemKey) ?? []) {
      if (staleId === record.proposalId) continue
      const stale = await markCurationProposal({
        binding: project,
        dataRoot,
        proposalId: staleId,
        state: 'retired',
        reason: 'a later scan found that this finding\u2019s evidence has changed',
        now,
        home,
      })
      retired.push({
        proposalId: stale.proposalId,
        kind: stale.kind,
        state: stale.state,
        paths: stale.sources.map((source) => source.path),
        reason: stale.retiredReason,
      })
    }
  }

  return {
    projectId: project.projectId,
    created,
    updated,
    retired,
    replayed,
    skipped,
    unreadable: pending.unreadable,
    // Processing streams the whole store; the status listing's cap never limits retirement.
    processingTruncated: false,
  }
}
