// Crash-recoverable, whole-vault transactions (Task 7).
//
// Every vault content modification goes through `runTransaction`. The engine
// exists because a write to this vault is never one file: a memory note, the old
// note's status, a MOC, the shared project registry and the receipt log move
// together, and a process that dies between two of them must not leave a
// half-truth behind for the next session to build on (spec §10.4).
//
// State machine, with a durable marker after every step:
//
//   PREPARE  read and validate every target, compute the final bytes, write the
//            manifest (state `preparing`), stage every new revision as a
//            same-directory temporary file with `fsync`, snapshot the old bytes
//            of every updated file, then mark the manifest `prepared`.
//            Nothing in the vault has changed yet, so a crash here is undone by
//            deleting staging only.
//   APPLY    creates publish through `link(temp, target)` — never a rename that
//            could clobber a file which appeared meanwhile; updates re-read the
//            target, re-check its hash against the one PREPARE recorded, and only
//            then `rename(temp, target)`. Each published target is marked
//            `written` in the manifest before the next one starts. The receipt
//            log is the last target, and `steps.receipted` is the commit point.
//   COMMIT   the machine receipt is stored outside the vault, the manifest moves
//            to `committed`, and only then may the index be notified. An index
//            failure never undoes the vault write.
//   ROLLBACK on any failure before the commit point: a target may be restored
//            from its snapshot — or a freshly created file moved into
//            `_meta/.history/<txId>/` — ONLY while its current bytes still equal
//            the hash this transaction wrote. An external edit is kept where it
//            is, its snapshot is kept beside it, and the transaction becomes
//            `needs-manual-repair`, which blocks every later automatic write
//            until a human resolves it.
//
// Recovery runs before any new write, under the same lock. It is a real state
// machine walk, not a `try/catch`: a manifest is rolled forward when its receipt
// is durable, rolled back when a target was published, and merely discarded when
// staging never reached the vault.
//
// The lock is a whole-vault lock keyed by `sha256(realpath(vaultRoot))` at
// `<dataRoot>/locks/vault-<hash>.lock`, so two projects sharing a vault — and
// therefore sharing `_meta/registry.md` and `_meta/log.md` — serialize, and a
// read-modify-write of a shared file happens inside the lock instead of losing
// the other project's row. A lock is stale only when the recorded process no
// longer exists; it is never stolen on a timer.
//
// A read that fails is never an empty file: `EDEADLK` and other transient I/O
// failures, and macOS's `size > 0 && blocks === 0` on-demand-download hint, each
// pause the operation and report (spec §10.3.9).
import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { parseNote } from './frontmatter.js'
import { resolveDataRoot, resolveVaultFile } from './paths.js'
import {
  appendLogEntry,
  failureRecordPath,
  fsyncDirectory,
  LOG_RELATIVE_PATH,
  makeReceipt,
  readReceiptRecord,
  receiptStorePath,
  renderLogEntry,
  vaultIdentity,
  writeJsonAtomic,
  writeReceiptRecord,
} from './receipts.js'

/** Schema version of a transaction manifest. */
export const TRANSACTION_SCHEMA = 1
/** Default time to wait for the whole-vault write lock. */
export const DEFAULT_LOCK_TIMEOUT_MS = 15_000
/** Default poll interval while waiting for the lock. */
export const DEFAULT_LOCK_POLL_MS = 20
/** The real filesystem primitives a target read uses; tests may override them. */
const DEFAULT_IO = Object.freeze({ lstat: fs.lstat, readFile: fs.readFile, link: fs.link })
/** Error codes meaning "this filesystem cannot publish a hard link". */
const LINK_UNSUPPORTED_CODES = Object.freeze([
  'EPERM',
  'EACCES',
  'EOPNOTSUPP',
  'ENOTSUP',
  'EXDEV',
  'ENOSYS',
])
/** Error codes that mean "this read failed", never "the file is empty". */
const TRANSIENT_READ_CODES = Object.freeze([
  'EDEADLK',
  'EBUSY',
  'EAGAIN',
  'EIO',
  'ETIMEDOUT',
  'EINTR',
  'ENOTCONN',
  'EHOSTDOWN',
  'ESTALE',
])
/** In-process record of the locks this process is currently holding. */
const ACTIVE_LOCKS = new Map()
/** The vault-relative directory holding pre-change snapshots and recovery material (spec §5.1). */
const HISTORY_ROOT = '_meta/.history'
/**
 * The accepted transaction-id shape (spec §5.1).
 *
 * One definition, used both when a request is planned and when a manifest is
 * read back from disk: a manifest is JSON in a directory a same-user process can
 * write, and `txId` is joined into the vault's `_meta/.history/` path.
 */
const TX_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
/**
 * The accepted vault-hash shape: lowercase `sha256` hex, as `vaultIdentity`
 * produces it. It names a directory under `<dataRoot>/transactions/`.
 */
const VAULT_HASH_PATTERN = /^[0-9a-f]{64}$/
/** Fault-injection names accepted by `failAfter`. */
const FAULT_NAMES = Object.freeze([
  'new-note',
  'old-status',
  'moc',
  'publish',
  'receipt',
  'receipt-store',
  'index-notify',
])

/** A transaction cannot be honoured, or could not be completed safely. */
export class TransactionError extends Error {
  /**
   * @param {string} code - machine-readable reason (`hash-mismatch`, `lock-timeout`, …).
   * @param {string} message - human-readable diagnostic naming the offending path.
   * @param {{ cause?: Error, report?: object, details?: object }} [options] - underlying failure or extra facts.
   */
  constructor(code, message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'TransactionError'
    this.code = code
    if (options.report !== undefined) this.report = options.report
    if (options.details !== undefined) this.details = options.details
  }
}

/** A simulated crash: the caller asked for an interruption at a named step. */
class InjectedCrash extends TransactionError {
  /**
   * @param {string} when - the fault point that fired.
   */
  constructor(when) {
    super('injected-failure', `failAfter:${when} interrupted the transaction`)
    this.name = 'InjectedCrash'
    this.injected = true
    this.when = when
  }
}

/**
 * A fresh, filename-safe transaction id.
 *
 * @returns {string} `tx-<UUIDv4>`.
 */
export function newTransactionId() {
  return `tx-${randomUUID()}`
}

// ---------------------------------------------------------------------------
// runTransaction
// ---------------------------------------------------------------------------

/**
 * Apply a set of vault changes atomically, or leave the vault as it was.
 *
 * `receipt: null` (or omitted) means this transaction writes no human-readable
 * entry into `_meta/log.md` — bootstrap uses that, because creating the log is
 * not part of the skeleton. The machine receipt is stored either way, keyed by
 * the idempotency key when one was given and by the transaction id otherwise.
 *
 * @param {object} binding - a `kind:'bound'` binding (project id plus vault root).
 * @param {object} request - the transaction.
 * @param {string} request.txId - stable id for this transaction (`newTransactionId()`).
 * @param {string} [request.idempotencyKey] - replay key; a repeated key returns the original receipt.
 * @param {{path: string, contents: string|Buffer|Uint8Array}[]} [request.creates] - files that must not exist yet.
 * @param {{path: string, hash?: string|null, contents?: string|Buffer|Uint8Array, transform?: Function, own?: {id?: string}}[]} [request.updates] - files to replace: a fixed `contents` with the expected `hash`, or a `transform` for a read-modify-write performed under the lock.
 * @param {{action: string, sessionId?: string, fromSeq?: number, toSeq?: number}|null} [request.receipt] - the receipt to append to `_meta/log.md`.
 * @param {{dataRoot?: string, failAfter?: string, notifyIndex?: Function, lockTimeoutMs?: number, pollMs?: number, io?: {lstat?: Function, readFile?: Function, link?: Function}, home?: string}} [options] - data root (defaults to `resolveDataRoot()`), fault injection, index notifier, lock tuning, and a filesystem seam (`io.lstat`/`io.readFile` for vault targets, `io.link` for lock publication) that tests use to provoke conditions a real filesystem cannot be asked to raise on demand.
 * @returns {Promise<object>} the receipt.
 * @throws {TransactionError} on any refusal; `code` names the reason.
 */
export async function runTransaction(binding, request, options = {}) {
  const {
    dataRoot = resolveDataRoot(),
    failAfter,
    notifyIndex,
    lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
    pollMs = DEFAULT_LOCK_POLL_MS,
    io,
    home,
  } = options
  if (typeof dataRoot !== 'string' || dataRoot.length === 0)
    throw new RangeError('dataRoot must be a non-blank path')
  if (notifyIndex !== undefined && notifyIndex !== null && typeof notifyIndex !== 'function') {
    throw new RangeError('notifyIndex must be a function')
  }
  if (!Number.isInteger(lockTimeoutMs) || lockTimeoutMs < 0)
    throw new RangeError('lockTimeoutMs must be a non-negative integer')
  if (!Number.isInteger(pollMs) || pollMs <= 0)
    throw new RangeError('pollMs must be a positive integer')

  const identity = await vaultIdentity(binding, { home })
  if (!identity.vaultExists) {
    throw new TransactionError('vault-missing', `the vault at ${identity.vaultRoot} does not exist`)
  }
  const plan = normalizeRequest(request)
  const fault = normalizeFault(failAfter, plan)

  const lock = await acquireLock({ identity, dataRoot, txId: plan.txId, lockTimeoutMs, pollMs, io })
  let simulatedCrash = false
  try {
    // Recovery before any new write (spec §10.4.4). An unresolved conflict from
    // an earlier crash refuses this transaction instead of writing around it.
    const recovery = await reconcile(identity, dataRoot, { io, notifyIndex })
    if (recovery.unresolved.length > 0) {
      throw new TransactionError(
        'recovery-required',
        `unresolved transaction(s) must be repaired before automatic writes resume: ${recovery.unresolved.map((entry) => entry.txId).join(', ')}`,
        { report: recovery },
      )
    }

    if (plan.idempotencyKey !== null) {
      const stored = await readReceiptRecord(
        receiptStorePath(dataRoot, identity.vaultHash, identity.projectId, plan.idempotencyKey),
      )
      if (stored !== null) return stored
    }
    // A manifest that survived recovery is either unresolved (refused above) or a
    // committed transaction still queued for the index. Either way its txId is
    // taken: reusing it would overwrite a record that is still owed work.
    if (
      (await readManifestRecord(manifestPath(dataRoot, identity.vaultHash, plan.txId))) !== null
    ) {
      throw new TransactionError(
        'txid-in-use',
        `transaction ${plan.txId} already has a manifest for this vault`,
      )
    }
    // The history directory of an earlier transaction with this id holds its
    // snapshots and any quarantined newly created file. Reusing the id would let
    // the next cleanup delete that recovery material.
    if ((await lstatOrNull(join(identity.vaultRoot, HISTORY_ROOT, plan.txId))) !== null) {
      throw new TransactionError(
        'txid-in-use',
        `transaction ${plan.txId} already left history in ${HISTORY_ROOT}/${plan.txId}`,
      )
    }

    const manifest = await buildManifest(identity, plan, dataRoot, { io })
    await writeManifest(manifest, dataRoot)

    try {
      await stage(manifest, identity)
    } catch (error) {
      await discard(manifest, identity, dataRoot)
      throw error
    }
    manifest.state = 'prepared'
    manifest.steps.prepared = true
    await writeManifest(manifest, dataRoot)

    try {
      await applyTargets(manifest, identity, dataRoot, { io, fault })
    } catch (error) {
      if (error instanceof InjectedCrash) {
        simulatedCrash = true
        throw error
      }
      try {
        await rollback(manifest, identity, dataRoot, { io, reason: error.code ?? 'apply-failed' })
      } catch (rollbackError) {
        // A rollback that cannot finish leaves the manifest in place, so the next
        // recovery retries it; the caller is told the vault may not be consistent.
        throw new TransactionError(
          'rollback-failed',
          `transaction ${manifest.txId} failed (${error.code ?? error.message}) and its rollback also failed (${rollbackError.code ?? rollbackError.message}); recovery will retry`,
          { cause: rollbackError, details: { failureCode: error.code ?? 'apply-failed' } },
        )
      }
      throw error
    }

    // Past this line the transaction has committed (`steps.receipted` is durable)
    // and must roll FORWARD, never back: the vault already holds the new bytes,
    // the receipt log entry is on disk, and the log's snapshot is about to be
    // pruned — so an in-process rollback here would fail on a snapshot that no
    // longer exists and would fight every later recovery, which can only redo
    // the transaction.
    manifest.state = 'committed'
    await writeManifest(manifest, dataRoot)
    if (fault.afterReceiptCommit) {
      simulatedCrash = true
      throw new InjectedCrash('receipt-store')
    }
    await pruneLogSnapshot(manifest, identity).catch(() => {
      // The snapshot is only an optimisation to delete; a failure here must not
      // turn a committed transaction into an error the caller would retry.
    })
    if (fault.beforeIndexNotify) {
      simulatedCrash = true
      throw new InjectedCrash('index-notify')
    }
    manifest.receipt.result.index = await settleIndexNotification(
      manifest,
      identity,
      dataRoot,
      notifyIndex,
    )
    return manifest.receipt
  } finally {
    // A simulated crash leaves the lock file exactly where a dead process would:
    // the next acquirer has to prove the owner is gone before taking it.
    if (simulatedCrash) {
      abandonLock(lock)
    } else {
      await releaseLock(lock)
    }
  }
}

/**
 * Apply the caller's targets in order, then the receipt log, persisting a
 * completion marker after every published file.
 *
 * @param {object} manifest - in-memory manifest.
 * @param {object} identity - vault identity.
 * @param {string} dataRoot - plugin data root.
 * @param {{io?: object, fault: object}} options - read seam and fault points.
 * @returns {Promise<void>} resolves once the receipt store write is durable.
 */
async function applyTargets(manifest, identity, dataRoot, { io, fault }) {
  for (let index = 0; index < manifest.targets.length; index += 1) {
    const target = manifest.targets[index]
    if (target.isLog && fault.beforeReceipt) throw new InjectedCrash('receipt')
    if (target.mode === 'noop') {
      target.state = 'skipped'
      await writeManifest(manifest, dataRoot)
      continue
    }
    await publish(manifest, target, identity, { io })
    if (fault.afterPublish) {
      // The narrowest window in the protocol: the file is in the vault, the
      // journal does not know it yet. Recovery has to derive it from the disk.
      fault.afterPublish = false
      throw new InjectedCrash('publish')
    }
    target.state = 'written'
    await writeManifest(manifest, dataRoot)
    if (fault.afterTarget.has(index)) throw new InjectedCrash(fault.afterTarget.get(index))
  }

  // `receipted` is this transaction's commit point: everything in the vault is
  // on disk and the receipt is durable in the log, so recovery rolls forward.
  // Nothing after this marker may be undone by a rollback.
  manifest.state = 'applying'
  manifest.steps.receipted = true
  await writeManifest(manifest, dataRoot)
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

/**
 * Validate the request envelope and normalise its arrays.
 *
 * @param {object} request - caller request.
 * @returns {{txId: string, idempotencyKey: string|null, creates: object[], updates: object[], receipt: object|null}} the plan.
 * @throws {TransactionError} when the request cannot be honoured.
 */
function normalizeRequest(request) {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    throw new TransactionError('invalid-request', 'runTransaction requires a request object')
  }
  const { txId } = request
  if (typeof txId !== 'string' || !TX_ID_PATTERN.test(txId)) {
    throw new TransactionError(
      'invalid-tx-id',
      `txId must match [A-Za-z0-9][A-Za-z0-9._-]{0,127}: ${JSON.stringify(txId)}`,
    )
  }
  const creates = request.creates ?? []
  const updates = request.updates ?? []
  if (!Array.isArray(creates) || !Array.isArray(updates)) {
    throw new TransactionError('invalid-request', 'creates and updates must be arrays')
  }
  const idempotencyKey = request.idempotencyKey ?? null
  if (
    idempotencyKey !== null &&
    (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0)
  ) {
    throw new TransactionError(
      'invalid-request',
      'idempotencyKey must be a non-blank string when present',
    )
  }
  const receipt = request.receipt ?? null
  if (receipt !== null && (typeof receipt !== 'object' || Array.isArray(receipt))) {
    throw new TransactionError('invalid-request', 'receipt must be an object or null')
  }

  const seen = new Set()
  for (const entry of [...creates, ...updates]) {
    const path = entry?.path
    if (typeof path !== 'string' || path.length === 0) {
      throw new TransactionError(
        'invalid-request',
        'every create and update needs a non-blank vault-relative path',
      )
    }
    if (seen.has(path))
      throw new TransactionError(
        'duplicate-target',
        `${path} appears more than once in one transaction`,
      )
    seen.add(path)
  }
  if (receipt !== null && seen.has(LOG_RELATIVE_PATH)) {
    throw new TransactionError(
      'duplicate-target',
      `${LOG_RELATIVE_PATH} is written by the receipt and cannot also be a target`,
    )
  }
  return { txId, idempotencyKey, creates, updates, receipt }
}

/**
 * Translate `failAfter` into the apply-order fault points.
 *
 * @param {string|undefined} failAfter - named interruption point.
 * @param {object} plan - normalised request.
 * @returns {{afterTarget: Map<number, string>, beforeReceipt: boolean, afterReceiptCommit: boolean, beforeIndexNotify: boolean}} fault points.
 * @throws {RangeError} when the name is unknown or has no matching target.
 */
function normalizeFault(failAfter, plan) {
  const fault = {
    afterTarget: new Map(),
    afterPublish: false,
    beforeReceipt: false,
    afterReceiptCommit: false,
    beforeIndexNotify: false,
  }
  if (failAfter === undefined || failAfter === null || failAfter === false) return fault
  if (typeof failAfter !== 'string' || !FAULT_NAMES.includes(failAfter)) {
    throw new RangeError(`failAfter must be one of ${FAULT_NAMES.join(', ')}`)
  }
  if (failAfter === 'new-note') {
    if (plan.creates.length === 0)
      throw new RangeError('failAfter "new-note" needs at least one create')
    fault.afterTarget.set(0, 'new-note')
  } else if (failAfter === 'old-status') {
    if (plan.updates.length === 0)
      throw new RangeError('failAfter "old-status" needs at least one update')
    fault.afterTarget.set(plan.creates.length, 'old-status')
  } else if (failAfter === 'moc') {
    if (plan.updates.length === 0) throw new RangeError('failAfter "moc" needs at least one update')
    fault.afterTarget.set(plan.creates.length + plan.updates.length - 1, 'moc')
  } else if (failAfter === 'publish') {
    fault.afterPublish = true
  } else if (failAfter === 'receipt') {
    if (plan.receipt === null) throw new RangeError('failAfter "receipt" needs a receipt')
    fault.beforeReceipt = true
  } else if (failAfter === 'receipt-store') {
    if (plan.receipt === null) throw new RangeError('failAfter "receipt-store" needs a receipt')
    fault.afterReceiptCommit = true
  } else {
    fault.beforeIndexNotify = true
  }
  return fault
}

/**
 * Read every target, validate it, and compute the bytes this transaction writes.
 *
 * All reads and refusals happen here, before the first write, so a transaction
 * with one bad target writes nothing (spec §10.4.2). Temp and snapshot paths are
 * fixed at this point too, which is what lets recovery clean up after a crash
 * that happened in the middle of staging.
 *
 * @param {object} identity - vault identity.
 * @param {object} plan - normalised request.
 * @param {string} dataRoot - plugin data root.
 * @param {{io?: object}} options - read seam.
 * @returns {Promise<object>} the in-memory manifest.
 * @throws {TransactionError} when any target cannot be trusted.
 */
async function buildManifest(identity, plan, dataRoot, { io }) {
  const targets = []
  for (const [index, entry] of plan.creates.entries()) {
    const contents = toBytes(entry.contents, `creates[${index}]`)
    const absolute = await resolveVaultFile(identity.vaultRoot, entry.path)
    if ((await lstatOrNull(absolute)) !== null) {
      throw new TransactionError(
        'target-exists',
        `${entry.path} already exists; a create never overwrites`,
      )
    }
    await assertParentDirectory(identity.vaultRoot, entry.path)
    targets.push(
      makeTarget({
        index,
        txId: plan.txId,
        path: entry.path,
        mode: 'create',
        beforeHash: null,
        beforeBytes: null,
        afterBytes: contents,
      }),
    )
  }

  for (const [offset, entry] of plan.updates.entries()) {
    const index = plan.creates.length + offset
    if (entry.transform !== undefined && typeof entry.transform !== 'function') {
      throw new TransactionError(
        'invalid-request',
        `updates[${offset}].transform must be a function`,
      )
    }
    if (entry.transform === undefined && entry.contents === undefined) {
      throw new TransactionError(
        'missing-expected-hash',
        `updates[${offset}] for ${entry.path} needs contents or a transform`,
      )
    }
    if (
      entry.transform === undefined &&
      entry.hash !== null &&
      !/^[0-9a-f]{64}$/.test(String(entry.hash ?? ''))
    ) {
      throw new TransactionError(
        'missing-expected-hash',
        `updates[${offset}] for ${entry.path} needs an expected sha256 hash`,
      )
    }
    const absolute = await resolveVaultFile(identity.vaultRoot, entry.path)
    const current = await readGuarded(absolute, entry.path, {
      io,
      mustExist: entry.transform === undefined && entry.hash !== null,
    })
    if (current !== null) await assertParentDirectory(identity.vaultRoot, entry.path)
    if (current !== null) assertOwnership(entry, current, entry.path)

    let afterBytes
    if (entry.transform !== undefined) {
      if (current !== null && entry.hash === null) {
        throw new TransactionError(
          'target-exists',
          `${entry.path} exists, but the transaction requires it to be created`,
        )
      }
      if (current === null && typeof entry.hash === 'string' && entry.hash !== '*') {
        throw new TransactionError(
          'hash-mismatch',
          `${entry.path} is missing (expected ${entry.hash})`,
        )
      }
      if (
        current !== null &&
        typeof entry.hash === 'string' &&
        entry.hash !== '*' &&
        hashBytes(current) !== entry.hash
      ) {
        throw new TransactionError(
          'hash-mismatch',
          `${entry.path} changed after it was read (expected ${entry.hash}, found ${hashBytes(current)})`,
        )
      }
      const produced = await entry.transform(current === null ? null : Buffer.from(current))
      afterBytes =
        produced === null || produced === undefined
          ? null
          : toBytes(produced, `updates[${offset}].transform()`)
    } else {
      const observed = hashBytes(current)
      if (observed !== entry.hash) {
        throw new TransactionError(
          'hash-mismatch',
          `${entry.path} changed after it was read (expected ${entry.hash}, found ${observed})`,
        )
      }
      afterBytes = toBytes(entry.contents, `updates[${offset}]`)
    }

    const mode =
      afterBytes === null
        ? 'noop'
        : current === null
          ? 'create'
          : afterBytes.equals(current)
            ? 'noop'
            : 'update'
    targets.push(
      makeTarget({
        index,
        txId: plan.txId,
        path: entry.path,
        mode,
        beforeHash: current === null ? null : hashBytes(current),
        beforeBytes: current,
        afterBytes,
      }),
    )
  }

  const receipt = makeReceipt({
    txId: plan.txId,
    idempotencyKey: plan.idempotencyKey,
    sessionId: plan.receipt?.sessionId ?? null,
    fromSeq: plan.receipt?.fromSeq ?? null,
    toSeq: plan.receipt?.toSeq ?? null,
    action: String(plan.receipt?.action ?? 'write'),
    paths: targets.map((target) => target.path),
    beforeHashes: Object.fromEntries(targets.map((target) => [target.path, target.beforeHash])),
    afterHashes: Object.fromEntries(targets.map((target) => [target.path, target.afterHash])),
    result: {
      status: 'applied',
      created: targets.filter((target) => target.mode === 'create').length,
      updated: targets.filter((target) => target.mode === 'update').length,
      skipped: targets.filter((target) => target.mode === 'noop').length,
      index: 'queued',
      stored: false,
    },
  })

  if (plan.receipt !== null) {
    targets.push(await buildLogTarget(identity, plan, receipt, targets.length, { io }))
  }
  receipt.result.status = targets.some((target) => target.mode !== 'noop') ? 'applied' : 'no-op'

  return {
    schema: TRANSACTION_SCHEMA,
    txId: plan.txId,
    idempotencyKey: plan.idempotencyKey,
    vaultHash: identity.vaultHash,
    vaultRoot: identity.vaultRoot,
    projectId: identity.projectId,
    pid: process.pid,
    processStartedAt: processStartTime(),
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    state: 'preparing',
    steps: { prepared: false, receipted: false, stored: false, indexNotified: false },
    receipt,
    targets,
  }
}

/**
 * Build the implicit receipt-log target of a transaction that carries a receipt.
 *
 * `_meta/log.md` is append-only and shared by every project, so its next
 * revision is computed here, under the vault lock, from the bytes actually on
 * disk. A log that already ends with this exact entry is left alone, which keeps
 * a roll-forward after a crash idempotent.
 *
 * @param {object} identity - vault identity.
 * @param {object} plan - normalised request.
 * @param {object} receipt - the receipt about to be logged.
 * @param {number} index - target index (for staging names).
 * @param {{io?: object}} options - read seam.
 * @returns {Promise<object>} the log target.
 */
async function buildLogTarget(identity, plan, receipt, index, { io }) {
  const absolute = await resolveVaultFile(identity.vaultRoot, LOG_RELATIVE_PATH)
  await assertParentDirectory(identity.vaultRoot, LOG_RELATIVE_PATH)
  const current = await readGuarded(absolute, LOG_RELATIVE_PATH, { io, mustExist: false })
  const before = current === null ? '' : current.toString('utf8')
  const afterBytes = Buffer.from(appendLogEntry(before, renderLogEntry(receipt)), 'utf8')
  const mode = current === null ? 'create' : afterBytes.equals(current) ? 'noop' : 'update'
  const target = makeTarget({
    index,
    txId: plan.txId,
    path: LOG_RELATIVE_PATH,
    mode,
    beforeHash: current === null ? null : hashBytes(current),
    beforeBytes: current,
    afterBytes: mode === 'noop' ? null : afterBytes,
  })
  target.isLog = true
  return target
}

/**
 * Create one target record, fixing its staging and snapshot names up front.
 *
 * @param {{index: number, txId: string, path: string, mode: string, beforeHash: string|null, beforeBytes: Buffer|null, afterBytes: Buffer|null}} input - target facts.
 * @returns {object} the target record.
 */
function makeTarget({ index, txId, path, mode, beforeHash, beforeBytes, afterBytes }) {
  const directory = parentRelative(path)
  const file = basename(path)
  return {
    index,
    path,
    mode,
    isLog: false,
    beforeHash,
    afterHash: afterBytes === null ? beforeHash : hashBytes(afterBytes),
    tempPath: mode === 'noop' ? null : joinRelative(directory, `.${file}.${txId}.tmp`),
    snapshotPath:
      mode === 'update' ? joinRelative(HISTORY_ROOT, `${txId}/${index}__${file}`) : null,
    state: 'pending',
    observedHash: null,
    reason: null,
    beforeBytes,
    afterBytes,
  }
}

// ---------------------------------------------------------------------------
// Staging, publishing, rollback
// ---------------------------------------------------------------------------

/**
 * Write every new revision to a same-directory temporary file and snapshot every old one.
 *
 * The temporary file lives next to its target so `link`/`rename` stay on one
 * filesystem and stay atomic; each is `fsync`-ed before the manifest says
 * `prepared`, so the bytes survive the crash this design exists for.
 *
 * @param {object} manifest - in-memory manifest.
 * @param {object} identity - vault identity.
 * @returns {Promise<void>} resolves once every target is staged.
 */
async function stage(manifest, identity) {
  for (const target of manifest.targets) {
    if (target.mode === 'noop') continue
    await assertParentDirectory(identity.vaultRoot, target.path)
    const tempAbsolute = await resolveVaultFile(identity.vaultRoot, target.tempPath)
    await writeFileExclusive(tempAbsolute, target.afterBytes)
    if (target.mode === 'update') {
      const snapshotAbsolute = await resolveVaultFile(identity.vaultRoot, target.snapshotPath)
      await fs.mkdir(dirname(snapshotAbsolute), { recursive: true })
      await writeFileExclusive(snapshotAbsolute, target.beforeBytes)
      await fsyncDirectory(dirname(snapshotAbsolute))
    }
  }
}

/**
 * Publish one staged revision.
 *
 * @param {object} manifest - manifest, for diagnostics.
 * @param {object} target - target to publish.
 * @param {object} identity - vault identity.
 * @param {{io?: object}} options - read seam.
 * @returns {Promise<void>} resolves once the publish and its directory `fsync` are done.
 * @throws {TransactionError} when the target appeared or changed underneath the transaction.
 */
async function publish(manifest, target, identity, { io }) {
  const absolute = await resolveVaultFile(identity.vaultRoot, target.path)
  const tempAbsolute = await resolveVaultFile(identity.vaultRoot, target.tempPath)
  if (target.mode === 'create') {
    if ((await lstatOrNull(absolute)) !== null) {
      throw new TransactionError(
        'target-exists',
        `${target.path} appeared while transaction ${manifest.txId} was running`,
      )
    }
    await fs.link(tempAbsolute, absolute)
    await fs.rm(tempAbsolute, { force: true }).catch(() => {})
    await fsyncDirectory(dirname(absolute))
    return
  }
  const current = await readGuarded(absolute, target.path, { io })
  if (hashBytes(current) !== target.beforeHash) {
    throw new TransactionError(
      'target-changed',
      `${target.path} changed after it was read; refusing to overwrite the newer revision`,
    )
  }
  await fs.rename(tempAbsolute, absolute)
  await fsyncDirectory(dirname(absolute))
}

/**
 * Undo a transaction that never reached its commit point.
 *
 * Whether a target was published is derived from the filesystem, not only from
 * the manifest's per-target marker: a crash can land between `link`/`rename` and
 * the journal write that records it. Once the manifest says `prepared`, every
 * target has a staged temporary file, and a publish is exactly the step that
 * consumes it (a rename) or publishes beside it (a link, where the published
 * file is recognizable by its hash). The persisted `written` marker is still
 * trusted as a shortcut, so a manifest that records more than the filesystem can
 * show is never mistaken for one that published nothing.
 *
 * A target may be restored or quarantined only while its current bytes still
 * equal the hash this transaction wrote. An external edit is kept where it is,
 * its snapshot is kept beside it, and the transaction becomes
 * `needs-manual-repair`, so later automatic writes refuse instead of writing
 * around a conflict nobody has looked at. Rollback is idempotent: a target that
 * already holds its pre-transaction bytes (or is already gone, for a create) is
 * recognized as undone, which is what lets a crash *during* a rollback resume.
 *
 * @param {object} manifest - in-memory manifest.
 * @param {object} identity - vault identity.
 * @param {string} dataRoot - plugin data root.
 * @param {{io?: object, reason?: string}} options - read seam and the failure that triggered the rollback.
 * @returns {Promise<{conflicts: object[], published: boolean}>} conflicts that need a human, and whether any target was published.
 */
async function rollback(manifest, identity, dataRoot, { io, reason = 'failed' }) {
  const conflicts = []
  const prepared = manifest.steps?.prepared === true
  let publishedAny = false
  for (const target of [...manifest.targets].reverse()) {
    if (target.mode === 'noop') continue
    const absolute = await resolveVaultFile(identity.vaultRoot, target.path)
    let current = null
    let failure = null
    try {
      current = await readGuarded(absolute, target.path, { io, mustExist: false })
    } catch (error) {
      failure = error
    }
    const currentHash = current === null ? null : hashBytes(current)

    let tempExists = false
    if (prepared && typeof target.tempPath === 'string') {
      const tempAbsolute = await resolveVaultFile(identity.vaultRoot, target.tempPath)
      tempExists = (await lstatOrNull(tempAbsolute)) !== null
    }
    const published = isPublished({ target, prepared, tempExists, currentHash })
    if (!published) continue
    publishedAny = true

    if (currentHash === target.afterHash) {
      // this transaction is still the last writer, so undoing it is safe
      if (target.mode === 'create') {
        const destination = await historyDestination(identity, manifest.txId, target, 'created')
        await fs.rename(absolute, destination)
        await fsyncDirectory(dirname(absolute))
        await fsyncDirectory(dirname(destination))
        target.state = 'quarantined'
      } else {
        const snapshotAbsolute = await resolveVaultFile(identity.vaultRoot, target.snapshotPath)
        await replaceFileAtomic(absolute, await fs.readFile(snapshotAbsolute))
        target.state = 'restored'
      }
      await writeManifest(manifest, dataRoot)
      continue
    }

    // "Already undone" may only be concluded from bytes that were actually read.
    // A failed read (`EDEADLK`, an on-demand download, an unreadable file) leaves
    // `current` null without proving the file is gone — for a create that would
    // silently report a successful rollback while the note is still in the vault.
    const alreadyUndone =
      failure === null &&
      (target.mode === 'create' ? current === null : currentHash === target.beforeHash)
    if (alreadyUndone) {
      // an earlier rollback attempt already undid this target
      target.state = target.mode === 'create' ? 'quarantined' : 'restored'
      await writeManifest(manifest, dataRoot)
      continue
    }

    target.state = 'conflict'
    target.observedHash = currentHash
    target.reason = failure === null ? 'external-edit' : (failure.code ?? 'unreadable')
    conflicts.push(target)
    if (target.mode === 'create' && current !== null) {
      await writeHistoryFile(identity, manifest, target, 'external', current)
    }
    await writeManifest(manifest, dataRoot)
  }

  await cleanupStaging(manifest, identity)
  if (!publishedAny && conflicts.length === 0) {
    // Nothing reached the vault: staging is the only thing to throw away.
    await removeManifest(manifest, dataRoot)
    return { conflicts, published: false }
  }
  manifest.state = conflicts.length > 0 ? 'needs-manual-repair' : 'rolled-back'
  await writeManifest(manifest, dataRoot)
  await writeFailureRecord(manifest, identity, dataRoot, conflicts, reason)
  if (conflicts.length === 0) await removeManifest(manifest, dataRoot)
  return { conflicts, published: true }
}

/**
 * Decide whether one target of an in-flight transaction reached the vault.
 *
 * @param {{target: object, prepared: boolean, tempExists: boolean, currentHash: string|null}} input - the facts.
 * @returns {boolean} whether the target was published.
 */
function isPublished({ target, prepared, tempExists, currentHash }) {
  if (['written', 'restored', 'quarantined', 'conflict'].includes(target.state)) return true
  if (!prepared) return false
  // `prepared` means every target was staged, so a temporary file that is gone
  // was consumed by the publish.
  if (!tempExists) return true
  // `link` cannot remove its source, so a create interrupted between the link and
  // the unlink is recognizable only by the published bytes.
  return target.mode === 'create' && currentHash === target.afterHash
}

/**
 * Remove a transaction that never published anything.
 *
 * @param {object} manifest - in-memory manifest.
 * @param {object} identity - vault identity.
 * @param {string} dataRoot - plugin data root.
 * @returns {Promise<void>} resolves once staging, history and the manifest are gone.
 */
async function discard(manifest, identity, dataRoot) {
  assertManifestIdentity(manifest, 'discard')
  await cleanupStaging(manifest, identity)
  await fs
    .rm(join(identity.vaultRoot, HISTORY_ROOT, manifest.txId), { recursive: true, force: true })
    .catch(() => {})
  await removeManifest(manifest, dataRoot)
}

/**
 * Remove every staged temporary file this transaction created.
 *
 * @param {object} manifest - in-memory manifest.
 * @param {object} identity - vault identity.
 * @returns {Promise<void>} resolves once the staging files are gone.
 */
async function cleanupStaging(manifest, identity) {
  for (const target of manifest.targets) {
    if (target.tempPath === null || target.tempPath === undefined) continue
    let absolute
    try {
      absolute = await resolveVaultFile(identity.vaultRoot, target.tempPath)
    } catch {
      continue
    }
    await fs.rm(absolute, { force: true }).catch(() => {})
  }
}

/**
 * Run a vault-scoped task while holding the whole-vault write lock.
 *
 * Every mutation of vault bytes is supposed to be serialized by the same
 * `realpath(vaultRoot)`-keyed lock the transaction engine takes. This is the one
 * supported way to reach that lock for work that is *not* a `runTransaction`
 * plan — Task 17's `.history` retention sweep is the first caller — so such work
 * cannot interleave with an in-flight transaction (or with recovery) and delete
 * material a transaction is about to reference.
 *
 * With `recover: true` the lock is followed by the same reconciliation
 * `runTransaction` performs before its first write, and an unresolved
 * transaction refuses the whole task with `recovery-required`: a vault that owes
 * manual repair must not have its recovery material swept out from under it.
 *
 * The task runs *inside* the lock and must therefore not call `runTransaction`
 * itself (the lock is not re-entrant). A task that throws still releases the
 * lock; its error propagates untouched.
 *
 * @param {object} binding - a `kind:'bound'` binding.
 * @param {(arg: {identity: object, dataRoot: string}) => Promise<*>} task - the lock-scoped work.
 * @param {{dataRoot?: string, recover?: boolean, notifyIndex?: Function, io?: object, home?: string, lockTimeoutMs?: number, pollMs?: number}} [options] - data root (defaults to `resolveDataRoot()`), pre-task recovery, notifier, filesystem seam and lock tuning.
 * @returns {Promise<*>} whatever the task returned.
 * @throws {RangeError} when the task or an option is malformed.
 * @throws {TransactionError} when the lock cannot be taken or recovery is required.
 */
export async function withVaultLock(binding, task, options = {}) {
  if (typeof task !== 'function') throw new RangeError('withVaultLock requires a task function')
  const {
    dataRoot = resolveDataRoot(),
    recover = false,
    notifyIndex,
    io,
    home,
    lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
    pollMs = DEFAULT_LOCK_POLL_MS,
  } = options
  if (typeof dataRoot !== 'string' || dataRoot.length === 0)
    throw new RangeError('dataRoot must be a non-blank path')
  if (typeof recover !== 'boolean') throw new RangeError('recover must be a boolean')
  if (notifyIndex !== undefined && notifyIndex !== null && typeof notifyIndex !== 'function') {
    throw new RangeError('notifyIndex must be a function')
  }
  if (!Number.isInteger(lockTimeoutMs) || lockTimeoutMs < 0)
    throw new RangeError('lockTimeoutMs must be a non-negative integer')
  if (!Number.isInteger(pollMs) || pollMs <= 0)
    throw new RangeError('pollMs must be a positive integer')

  const identity = await vaultIdentity(binding, { home })
  const lock = await acquireLock({
    identity,
    dataRoot,
    txId: 'vault-lock',
    lockTimeoutMs,
    pollMs,
    io,
  })
  try {
    if (recover === true) {
      const report = await reconcile(identity, dataRoot, { io, notifyIndex })
      if (report.unresolved.length > 0) {
        throw new TransactionError(
          'recovery-required',
          `unresolved transaction(s) must be repaired before this vault mutation resumes: ${report.unresolved.map((entry) => entry.txId).join(', ')}`,
          { report },
        )
      }
    }
    return await task({ identity, dataRoot })
  } finally {
    await releaseLock(lock)
  }
}

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------

/**
 * Reconcile every unfinished transaction of one vault.
 *
 * @param {object} binding - a `kind:'bound'` binding.
 * @param {{dataRoot?: string, notifyIndex?: Function, io?: object, home?: string, lockTimeoutMs?: number, pollMs?: number}} [options] - data root, notifier, filesystem seam and lock tuning.
 * @returns {Promise<object>} the recovery report; `unresolved` lists what blocks automatic writes.
 * @throws {TransactionError} when the lock cannot be taken.
 */
export async function recoverTransactions(binding, options = {}) {
  const { dataRoot = resolveDataRoot(), notifyIndex, io, home } = options
  const identity = await vaultIdentity(binding, { home })
  const lock = await acquireLock({
    identity,
    dataRoot,
    txId: 'recovery',
    lockTimeoutMs: options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
    pollMs: options.pollMs ?? DEFAULT_LOCK_POLL_MS,
    io,
  })
  try {
    return await reconcile(identity, dataRoot, { io, notifyIndex })
  } finally {
    await releaseLock(lock)
  }
}

/**
 * Walk every manifest of this vault and move it to its terminal state.
 *
 * @param {object} identity - vault identity.
 * @param {string} dataRoot - plugin data root.
 * @param {{io?: object, notifyIndex?: Function}} options - read seam and notifier.
 * @returns {Promise<object>} the recovery report.
 */
async function reconcile(identity, dataRoot, { io, notifyIndex }) {
  const directory = transactionsDirectory(dataRoot, identity.vaultHash)
  const report = {
    vaultHash: identity.vaultHash,
    scanned: 0,
    committed: [],
    rolledBack: [],
    discarded: [],
    unresolved: [],
    pendingIndexNotifications: [],
  }
  for (const name of await listManifestNames(directory)) {
    const manifest = await readManifestRecord(join(directory, name))
    if (manifest === null) continue
    report.scanned += 1
    try {
      if (manifest.schema !== TRANSACTION_SCHEMA) {
        throw new TransactionError(
          'manifest-schema',
          `transaction ${manifest.txId} was written by schema ${JSON.stringify(manifest.schema)}; this plugin understands ${TRANSACTION_SCHEMA} only`,
        )
      }
      if (manifest.steps?.receipted) {
        await rollForward(manifest, identity, dataRoot, notifyIndex)
        report.committed.push(manifest.txId)
        if (!manifest.steps.indexNotified) {
          report.pendingIndexNotifications.push({ txId: manifest.txId, receipt: manifest.receipt })
        }
        if (!manifest.steps.stored) {
          // The vault write is committed but its receipt never reached the store,
          // so the idempotency key cannot be answered yet. Fail closed: the
          // manifest is the only durable copy, and letting new writes through
          // would let a same-key retry apply the same change twice. This clears
          // itself as soon as the store accepts the receipt.
          report.unresolved.push(unresolvedEntry(manifest, 'receipt-store-unavailable'))
        }
        continue
      }
      if (manifest.state === 'rolled-back') {
        await removeManifest(manifest, dataRoot)
        continue
      }
      if (manifest.state === 'needs-manual-repair') {
        report.unresolved.push(unresolvedEntry(manifest, 'needs-manual-repair'))
        continue
      }
      if (manifest.steps?.prepared !== true) {
        // Publishing only starts after `prepared` is durable, so nothing reached
        // the vault and staging is the only thing to throw away.
        await discard(manifest, identity, dataRoot)
        report.discarded.push(manifest.txId)
        continue
      }
      const outcome = await rollback(manifest, identity, dataRoot, { io, reason: 'process-crash' })
      if (outcome.conflicts.length > 0) {
        // Name the real cause: a conflict is either an external edit (the bytes
        // changed) or an unreadable target, which must never be reported as a
        // clean rollback.
        const reasons = new Set(outcome.conflicts.map((target) => target.reason))
        const reason = reasons.size === 1 ? [...reasons][0] : 'rollback-conflict'
        report.unresolved.push(
          unresolvedEntry(
            manifest,
            reason,
            outcome.conflicts.map((target) => target.path),
          ),
        )
      } else if (outcome.published) {
        report.rolledBack.push(manifest.txId)
      } else {
        report.discarded.push(manifest.txId)
      }
    } catch (error) {
      report.unresolved.push({
        txId: manifest.txId,
        state: manifest.state,
        reason: error.code ?? 'recovery-failed',
        message: error.message,
        paths: manifest.targets
          .filter((target) => target.state === 'written')
          .map((target) => target.path),
      })
    }
  }
  return report
}

/**
 * Finish a committed transaction: store its receipt, then notify the index.
 *
 * @param {object} manifest - manifest whose receipt is durable.
 * @param {object} identity - vault identity.
 * @param {string} dataRoot - plugin data root.
 * @param {Function|undefined} notifyIndex - index notifier, when one is available.
 * @returns {Promise<void>} resolves once the manifest is either deleted or left queued.
 */
async function rollForward(manifest, identity, dataRoot, notifyIndex) {
  manifest.state = 'committed'
  if (manifest.receipt === null || manifest.receipt === undefined) {
    await removeManifest(manifest, dataRoot)
    return
  }
  await pruneLogSnapshot(manifest, identity).catch(() => {})
  await settleIndexNotification(manifest, identity, dataRoot, notifyIndex)
}

/**
 * Deliver the post-commit index notification and store the machine receipt.
 *
 * Neither step may fail the transaction: the vault write is committed, so a
 * failure here leaves the manifest — which already carries the receipt — as the
 * durable queue, and the next recovery retries. The manifest is deleted only
 * once both the notification was accepted and the receipt is stored, so a
 * receipt can never be lost by dropping its manifest too early.
 *
 * @param {object} manifest - committed manifest.
 * @param {object} identity - vault identity.
 * @param {string} dataRoot - plugin data root.
 * @param {Function|undefined} notifyIndex - notifier.
 * @returns {Promise<'notified'|'queued'|'stale'>} what happened to the notification.
 */
async function settleIndexNotification(manifest, identity, dataRoot, notifyIndex) {
  if (!manifest.steps.indexNotified) {
    if (typeof notifyIndex === 'function') {
      try {
        await notifyIndex(manifest.receipt)
        manifest.steps.indexNotified = true
        manifest.receipt.result.index = 'notified'
      } catch (error) {
        manifest.receipt.result.index = 'stale'
        manifest.steps.indexError = String(error?.code ?? error?.message ?? 'error')
      }
    } else if (manifest.receipt.result.index !== 'stale') {
      manifest.receipt.result.index = 'queued'
    }
  }
  await tryStoreReceipt(manifest, identity, dataRoot)
  if (manifest.steps.indexNotified && manifest.steps.stored) {
    await removeManifest(manifest, dataRoot)
  } else {
    await writeManifest(manifest, dataRoot)
  }
  return manifest.receipt.result.index
}

/**
 * Store the machine receipt if it is not stored yet, without failing the caller.
 *
 * @param {object} manifest - manifest carrying the receipt.
 * @param {object} identity - vault identity.
 * @param {string} dataRoot - plugin data root.
 * @returns {Promise<void>} resolves once the attempt is recorded.
 */
async function tryStoreReceipt(manifest, identity, dataRoot) {
  if (manifest.steps.stored) return
  try {
    await storeReceipt(manifest, identity, dataRoot)
    manifest.steps.stored = true
    delete manifest.steps.storeError
  } catch (error) {
    // The receipt is already durable inside the manifest, so nothing is lost;
    // the next recovery retries and the caller still learns what committed.
    manifest.steps.storeError = String(error?.code ?? error?.message ?? 'error')
  }
}

/**
 * Persist a manifest's receipt to the machine store.
 *
 * A successful store is recorded on the receipt itself, so a caller (and a later
 * reader of the stored copy) can tell "stored" from "still only in the manifest".
 *
 * @param {object} manifest - manifest.
 * @param {object} identity - vault identity.
 * @param {string} dataRoot - plugin data root.
 * @returns {Promise<void>} resolves once the receipt is stored.
 */
async function storeReceipt(manifest, identity, dataRoot) {
  // The stored copy is written with `stored: true`, and only a successful write
  // sets the flag on the in-memory receipt the caller sees.
  const receipt = { ...manifest.receipt, result: { ...manifest.receipt.result, stored: true } }
  await writeReceiptRecord(
    receiptStorePath(
      dataRoot,
      identity.vaultHash,
      identity.projectId,
      manifest.idempotencyKey ?? manifest.txId,
    ),
    receipt,
  )
  manifest.receipt.result.stored = true
}

/**
 * List the transactions of this vault that still owe the index a notification.
 *
 * The manifest is the durable queue: it is deleted only after a notifier
 * accepted the receipt, so this list survives a restart without a second store.
 *
 * @param {object} binding - a `kind:'bound'` binding.
 * @param {{dataRoot?: string, home?: string}} [options] - data root and home seam.
 * @returns {Promise<{txId: string, receipt: object}[]>} pending notifications.
 */
export async function listPendingIndexNotifications(binding, options = {}) {
  const { dataRoot = resolveDataRoot(), home } = options
  const identity = await vaultIdentity(binding, { home })
  const directory = transactionsDirectory(dataRoot, identity.vaultHash)
  const pending = []
  for (const name of await listManifestNames(directory)) {
    const manifest = await readManifestRecord(join(directory, name))
    if (manifest === null) continue
    if (manifest.steps?.receipted && !manifest.steps?.indexNotified) {
      pending.push({ txId: manifest.txId, receipt: manifest.receipt })
    }
  }
  return pending
}

/**
 * Mark one queued index notification as delivered and drop its manifest.
 *
 * A manifest whose receipt was never stored is never dropped here: the manifest
 * is the only copy of that receipt, so removing it would lose the idempotency
 * key. `false` tells the caller the transaction still owes the receipt store.
 *
 * @param {object} binding - a `kind:'bound'` binding.
 * @param {{dataRoot?: string, txId: string, home?: string}} options - data root, transaction id and home seam.
 * @returns {Promise<boolean>} whether a committed manifest was found and removed.
 */
export async function markIndexNotified(binding, options = {}) {
  const { dataRoot = resolveDataRoot(), txId, home } = options
  const identity = await vaultIdentity(binding, { home })
  const manifest = await readManifestRecord(manifestPath(dataRoot, identity.vaultHash, txId))
  if (manifest === null || !manifest.steps?.receipted || manifest.steps?.stored !== true)
    return false
  // Record the delivery before dropping the manifest, so a crash between the two
  // cannot re-deliver a notification that was already accepted.
  manifest.steps.indexNotified = true
  await writeManifest(manifest, dataRoot)
  await removeManifest(manifest, dataRoot)
  return true
}

/**
 * Build one `unresolved` entry for the recovery report.
 *
 * @param {object} manifest - manifest.
 * @param {string} reason - machine-readable cause.
 * @param {string[]} [paths] - the paths that need a human.
 * @returns {object} the report entry.
 */
function unresolvedEntry(manifest, reason, paths) {
  return {
    txId: manifest.txId,
    state: manifest.state,
    reason,
    message: `transaction ${manifest.txId} needs manual repair (${reason}); automatic writes are paused`,
    paths:
      paths ??
      manifest.targets
        .filter((target) => target.state === 'written' || target.state === 'conflict')
        .map((target) => target.path),
  }
}

// ---------------------------------------------------------------------------
// Manifest persistence
// ---------------------------------------------------------------------------

/**
 * The directory holding one vault's transaction manifests.
 *
 * @param {string} dataRoot - plugin data root.
 * @param {string} vaultHash - sha256 of the vault realpath.
 * @returns {string} absolute directory path (not created here).
 */
function transactionsDirectory(dataRoot, vaultHash) {
  return join(dataRoot, 'transactions', vaultHash)
}

/**
 * The manifest path of one transaction.
 *
 * @param {string} dataRoot - plugin data root.
 * @param {string} vaultHash - sha256 of the vault realpath.
 * @param {string} txId - transaction id.
 * @returns {string} absolute manifest path.
 */
function manifestPath(dataRoot, vaultHash, txId) {
  return join(transactionsDirectory(dataRoot, vaultHash), `${txId}.json`)
}

/**
 * Persist the persistable view of a manifest, atomically, and bump `updatedAt`.
 *
 * @param {object} manifest - in-memory manifest.
 * @param {string} dataRoot - plugin data root.
 * @returns {Promise<void>} resolves once the manifest is durable.
 */
async function writeManifest(manifest, dataRoot) {
  assertManifestIdentity(manifest, 'writeManifest')
  manifest.updatedAt = new Date().toISOString()
  await writeJsonAtomic(
    manifestPath(dataRoot, manifest.vaultHash, manifest.txId),
    serializeManifest(manifest),
  )
}

/**
 * Delete a manifest that reached its terminal state.
 *
 * @param {object} manifest - manifest.
 * @param {string} dataRoot - plugin data root.
 * @returns {Promise<void>} resolves once the manifest is gone.
 */
async function removeManifest(manifest, dataRoot) {
  assertManifestIdentity(manifest, 'removeManifest')
  const directory = transactionsDirectory(dataRoot, manifest.vaultHash)
  await fs.rm(join(directory, `${manifest.txId}.json`), { force: true })
  await fsyncDirectory(directory)
}

/**
 * The JSON-safe view of a manifest (buffers and functions are dropped).
 *
 * @param {object} manifest - in-memory manifest.
 * @returns {object} the persistable record.
 */
function serializeManifest(manifest) {
  return {
    schema: manifest.schema,
    txId: manifest.txId,
    idempotencyKey: manifest.idempotencyKey,
    vaultHash: manifest.vaultHash,
    projectId: manifest.projectId,
    pid: manifest.pid,
    processStartedAt: manifest.processStartedAt,
    startedAt: manifest.startedAt,
    updatedAt: manifest.updatedAt,
    state: manifest.state,
    steps: manifest.steps,
    receipt: manifest.receipt,
    targets: manifest.targets.map((target) => ({
      index: target.index,
      path: target.path,
      mode: target.mode,
      isLog: target.isLog === true,
      beforeHash: target.beforeHash,
      afterHash: target.afterHash,
      tempPath: target.tempPath,
      snapshotPath: target.snapshotPath,
      state: target.state,
      observedHash: target.observedHash,
      reason: target.reason,
    })),
  }
}

/**
 * Refuse a manifest whose identity fields are not the shapes this plugin writes.
 *
 * `txId` and `vaultHash` are the two manifest fields that name a path:
 * `discard()` removes `_meta/.history/<txId>/` inside the vault, and
 * `writeManifest`/`removeManifest` write or delete `<dataRoot>/transactions/
 * <vaultHash>/<txId>.json`. Both were trusted verbatim, so a manifest carrying
 * `txId: "../../.."` or a traversing `vaultHash` deleted or wrote **outside** the
 * vault. A manifest is JSON under `$DSH_HOME/data/obsidian-mem/transactions/`,
 * which any process running as this user can rewrite, so every manifest read
 * from disk — and every act-site that joins one of these fields into a path —
 * re-applies the same rules the write path applies to a request.
 *
 * This is hardening, not a violated invariant: it takes a same-user process
 * tampering with the plugin's own data directory.
 *
 * @param {object} manifest - the manifest about to be read from or written to disk.
 * @param {string} where - the path or operation, for the diagnostic.
 * @throws {TransactionError} with code `manifest-corrupt`.
 */
function assertManifestIdentity(manifest, where) {
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new TransactionError(
      'manifest-corrupt',
      `the transaction manifest at ${where} is not a JSON object`,
    )
  }
  if (typeof manifest.txId !== 'string' || !TX_ID_PATTERN.test(manifest.txId)) {
    throw new TransactionError(
      'manifest-corrupt',
      `the transaction manifest at ${where} carries an unsafe txId ${JSON.stringify(manifest.txId)}; ` +
        'expected [A-Za-z0-9][A-Za-z0-9._-]{0,127}',
    )
  }
  if (typeof manifest.vaultHash !== 'string' || !VAULT_HASH_PATTERN.test(manifest.vaultHash)) {
    throw new TransactionError(
      'manifest-corrupt',
      `the transaction manifest at ${where} carries an unsafe vaultHash ${JSON.stringify(manifest.vaultHash)}; ` +
        'expected 64 lowercase hex characters',
    )
  }
}

/**
 * Read a manifest, tolerating absence.
 *
 * @param {string} path - manifest path.
 * @returns {Promise<object|null>} the manifest, or `null` when missing.
 * @throws {TransactionError} when the manifest exists but cannot be parsed, or
 *   carries an identity field that would name a path outside this vault.
 */
async function readManifestRecord(path) {
  let text
  try {
    text = await fs.readFile(path, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw new TransactionError(
      'manifest-unreadable',
      `cannot read the transaction manifest at ${path}`,
      { cause: error },
    )
  }
  try {
    const manifest = JSON.parse(text)
    manifest.targets = Array.isArray(manifest.targets) ? manifest.targets : []
    assertManifestIdentity(manifest, path)
    return manifest
  } catch (error) {
    if (error instanceof TransactionError) throw error
    throw new TransactionError(
      'manifest-corrupt',
      `the transaction manifest at ${path} is not valid JSON`,
      { cause: error },
    )
  }
}

/**
 * List the manifest file names of one vault, sorted for deterministic recovery.
 *
 * @param {string} directory - transactions directory.
 * @returns {Promise<string[]>} `*.json` names.
 */
async function listManifestNames(directory) {
  let names
  try {
    names = await fs.readdir(directory)
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  return names.filter((name) => name.endsWith('.json')).sort()
}

// ---------------------------------------------------------------------------
// History material
// ---------------------------------------------------------------------------

/**
 * Write one extra evidence file into the transaction's history directory.
 *
 * @param {object} identity - vault identity.
 * @param {object} manifest - manifest.
 * @param {object} target - the conflicted target.
 * @param {string} label - file label (`external`).
 * @param {Buffer} bytes - bytes to keep.
 * @returns {Promise<void>} resolves once written and durable.
 */
async function writeHistoryFile(identity, manifest, target, label, bytes) {
  const relative = joinRelative(
    HISTORY_ROOT,
    `${manifest.txId}/${target.index}__${label}__${basename(target.path)}`,
  )
  const absolute = await resolveVaultFile(identity.vaultRoot, relative)
  await fs.mkdir(dirname(absolute), { recursive: true })
  await writeFileExclusive(absolute, bytes)
  await fsyncDirectory(dirname(absolute))
}

/**
 * The history destination for a quarantined created file.
 *
 * @param {object} identity - vault identity.
 * @param {string} txId - transaction id.
 * @param {object} target - target record.
 * @param {string} label - file label (`created`).
 * @returns {Promise<string>} the absolute destination (its directory exists).
 */
async function historyDestination(identity, txId, target, label) {
  const relative = joinRelative(
    HISTORY_ROOT,
    `${txId}/${target.index}__${label}__${basename(target.path)}`,
  )
  const absolute = await resolveVaultFile(identity.vaultRoot, relative)
  await fs.mkdir(dirname(absolute), { recursive: true })
  return absolute
}

/**
 * Drop the receipt log's pre-change snapshot once the transaction is committed.
 *
 * `_meta/log.md` is append-only, so every earlier revision of it is still a
 * prefix of the current file: keeping a full copy per transaction would add no
 * information while growing the vault quadratically in the number of writes.
 * Snapshots of ordinary notes are kept, because those carry content that no
 * longer exists anywhere else.
 *
 * @param {object} manifest - manifest that just committed.
 * @param {object} identity - vault identity.
 * @returns {Promise<void>} resolves once the redundant snapshot is gone.
 */
async function pruneLogSnapshot(manifest, identity) {
  for (const target of manifest.targets) {
    if (target.isLog !== true || typeof target.snapshotPath !== 'string') continue
    const absolute = await resolveVaultFile(identity.vaultRoot, target.snapshotPath)
    await fs.rm(absolute, { force: true }).catch(() => {})
    // The history directory only exists for the snapshots; drop it when the log
    // was the only updated target.
    await fs.rmdir(dirname(absolute)).catch(() => {})
  }
}

/**
 * Persist the durable record of a failed transaction.
 *
 * Two copies are written: one under the plugin data root (for tooling) and one
 * beside the snapshots inside the vault (so a human can read what happened
 * without knowing where the data root lives).
 *
 * @param {object} manifest - manifest.
 * @param {object} identity - vault identity.
 * @param {string} dataRoot - plugin data root.
 * @param {object[]} conflicts - targets that could not be restored.
 * @param {string} reason - the failure that triggered the rollback.
 * @returns {Promise<void>} resolves once both records are written.
 */
async function writeFailureRecord(manifest, identity, dataRoot, conflicts, reason) {
  const record = serializeManifest(manifest)
  record.failure = {
    reason,
    conflicts: conflicts.map((target) => ({
      path: target.path,
      mode: target.mode,
      observedHash: target.observedHash,
      detail: target.reason,
    })),
    at: new Date().toISOString(),
  }
  await writeJsonAtomic(
    failureRecordPath(dataRoot, identity.vaultHash, identity.projectId, manifest.txId),
    record,
  )
  const absolute = await resolveVaultFile(
    identity.vaultRoot,
    joinRelative(HISTORY_ROOT, `${manifest.txId}/manifest.json`),
  )
  await fs.mkdir(dirname(absolute), { recursive: true })
  await writeJsonAtomic(absolute, record)
}

// ---------------------------------------------------------------------------
// Locking
// ---------------------------------------------------------------------------

/**
 * Take the whole-vault write lock.
 *
 * The record is published with `link`, not with `open` + `write`: `link` is
 * atomic and exclusive, so a lock file that exists is always a *complete* record
 * and a crash between creating the file and filling it in cannot strand the
 * vault behind an unreadable lock that no later process may break. The staged
 * temporary that `link` consumes lives in the locks directory and is swept once
 * this process holds the lock.
 *
 * A filesystem without hard links (SMB/NFS/exFAT, some Windows configurations)
 * cannot publish that way, so the fallback creates the file exclusively and then
 * writes the record through the open handle. That accepts a small window the
 * `link` path does not: a crash between the exclusive create and the record write
 * leaves a zero-length lock file, which reads as corrupt and is never stolen —
 * the operator removes it after the `lock-corrupt` diagnostic names it.
 *
 * @param {{identity: object, dataRoot: string, txId: string, lockTimeoutMs: number, pollMs: number, io?: object}} input - lock inputs.
 * @returns {Promise<{path: string, token: string, vaultHash: string}>} the held lock.
 * @throws {TransactionError} on timeout or an unreadable lock record.
 */
async function acquireLock({ identity, dataRoot, txId, lockTimeoutMs, pollMs, io }) {
  const path = join(dataRoot, 'locks', `vault-${identity.vaultHash}.lock`)
  const directory = dirname(path)
  await fs.mkdir(directory, { recursive: true })
  const token = randomUUID()
  const link = io?.link ?? DEFAULT_IO.link
  const record = `${JSON.stringify(
    {
      schema: 1,
      vaultHash: identity.vaultHash,
      vaultRoot: identity.vaultRoot,
      pid: process.pid,
      ppid: process.ppid,
      processStartedAt: processStartTime(),
      token,
      txId,
      acquiredAt: new Date().toISOString(),
    },
    null,
    2,
  )}\n`
  const deadline = Date.now() + lockTimeoutMs
  let corrupt
  for (let attempt = 0; ; attempt += 1) {
    const temporary = join(directory, `.${token}.${attempt}.lock.tmp`)
    await writeFileExclusive(temporary, Buffer.from(record, 'utf8'))
    let published = false
    try {
      await link(temporary, path)
      published = true
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => {})
      if (LINK_UNSUPPORTED_CODES.includes(error.code)) {
        published = await createLockRecordExclusively(path, record)
      } else if (error.code !== 'EEXIST') {
        throw error
      }
    }
    if (published) {
      // Registered immediately after publication: a read that could see this
      // file was necessarily issued after it appeared, so its callback runs after
      // this line and it can never mistake our live lock for an abandoned one.
      ACTIVE_LOCKS.set(path, token)
      await fs.rm(temporary, { force: true }).catch(() => {})
      await fsyncDirectory(directory)
      await sweepLockTemps(directory)
      return { path, token, vaultHash: identity.vaultHash }
    }

    const held = await readLockRecord(path)
    corrupt = held !== null && held.corrupt
    if (held !== null && !held.corrupt && isStaleLock(held.record, path)) {
      // The recorded process is gone: break the lock and try again at once.
      await fs.rm(path, { force: true })
      continue
    }
    if (Date.now() >= deadline) {
      if (corrupt) {
        throw new TransactionError(
          'lock-corrupt',
          `the vault lock at ${path} is unreadable; inspect and remove it by hand`,
        )
      }
      throw new TransactionError('lock-timeout', `another process holds the vault lock at ${path}`)
    }
    await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())))
  }
}

/**
 * Publish a lock record without hard links: exclusive create, then write.
 *
 * @param {string} path - the lock path.
 * @param {string} record - the record to write.
 * @returns {Promise<boolean>} whether this call created the lock.
 * @throws {Error} when the write fails (the partial file is removed first).
 */
async function createLockRecordExclusively(path, record) {
  let handle
  try {
    handle = await fs.open(path, 'wx', 0o600)
  } catch (error) {
    if (error.code === 'EEXIST') return false
    throw error
  }
  try {
    await handle.writeFile(record, 'utf8')
    await handle.sync()
  } catch (error) {
    await handle.close().catch(() => {})
    await fs.rm(path, { force: true }).catch(() => {})
    throw error
  }
  await handle.close()
  return true
}

/**
 * Remove staged lock records that an earlier crash left behind.
 *
 * Only `*.lock.tmp` files in the plugin's own locks directory are considered,
 * and a staged record whose pid is still alive is left alone — it belongs to a
 * process that is publishing its lock right now. An unparsable one is only
 * removed once it is old enough that no live writer could still be finishing it.
 *
 * @param {string} directory - the locks directory.
 * @returns {Promise<void>} resolves once the sweep is done.
 */
async function sweepLockTemps(directory) {
  let names
  try {
    names = await fs.readdir(directory)
  } catch {
    return
  }
  for (const name of names) {
    if (!name.endsWith('.lock.tmp')) continue
    const absolute = join(directory, name)
    let record
    try {
      record = JSON.parse(await fs.readFile(absolute, 'utf8'))
    } catch {
      record = null
    }
    if (record !== null && Number.isInteger(record.pid) && isProcessAlive(record.pid)) continue
    if (record === null) {
      let age
      try {
        age = Date.now() - (await fs.stat(absolute)).mtimeMs
      } catch {
        continue
      }
      if (age < 60_000) continue
    }
    await fs.rm(absolute, { force: true }).catch(() => {})
  }
}

/**
 * Release a lock this process holds.
 *
 * The token read-back means a lock that was broken and retaken by someone else
 * is never deleted by the original holder.
 *
 * @param {{path: string, token: string}} lock - the held lock.
 * @returns {Promise<void>} resolves once the lock file is gone.
 */
async function releaseLock(lock) {
  ACTIVE_LOCKS.delete(lock.path)
  const held = await readLockRecord(lock.path)
  if (held !== null && !held.corrupt && held.record.token !== lock.token) return
  await fs.rm(lock.path, { force: true }).catch(() => {})
  await fsyncDirectory(dirname(lock.path))
}

/**
 * Forget a lock file without deleting it, simulating a process death.
 *
 * @param {{path: string}} lock - the held lock.
 */
function abandonLock(lock) {
  ACTIVE_LOCKS.delete(lock.path)
}

/**
 * Whether a recorded lock can be broken.
 *
 * A lock is stale when its pid is gone, or when it claims this very process but
 * is not one of the locks this process is currently holding — the signature a
 * simulated crash leaves behind. A corrupt record proves nothing and is never
 * treated as stale, so a lock is not stolen on a guess.
 *
 * @param {object} record - lock record.
 * @param {string} path - lock path.
 * @returns {boolean} whether the lock is stale.
 */
function isStaleLock(record, path) {
  if (!Number.isInteger(record.pid) || record.pid <= 0) return false
  if (record.pid === process.pid) return ACTIVE_LOCKS.get(path) !== record.token
  return !isProcessAlive(record.pid)
}

/**
 * Whether a pid still exists.
 *
 * @param {number} pid - process id.
 * @returns {boolean} true when the process exists, even if it cannot be signalled.
 */
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

/**
 * Read a lock record, distinguishing absence from corruption.
 *
 * @param {string} path - lock path.
 * @returns {Promise<{corrupt: boolean, record: object}|null>} the record, or `null` when absent.
 */
async function readLockRecord(path) {
  let text
  try {
    text = await fs.readFile(path, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
  try {
    const record = JSON.parse(text)
    if (
      record === null ||
      typeof record !== 'object' ||
      Array.isArray(record) ||
      typeof record.token !== 'string'
    ) {
      return { corrupt: true, record: {} }
    }
    return { corrupt: false, record }
  } catch {
    return { corrupt: true, record: {} }
  }
}

/**
 * This process's start time in epoch milliseconds.
 *
 * Recorded with the lock so a recycled pid can be told apart from the process
 * that actually took the lock.
 *
 * @returns {number} epoch milliseconds.
 */
function processStartTime() {
  return Date.now() - Math.round(process.uptime() * 1000)
}

// ---------------------------------------------------------------------------
// Small filesystem helpers
// ---------------------------------------------------------------------------

/**
 * The vault-relative parent of a vault-relative path (`''` at the vault root).
 *
 * @param {string} relative - vault-relative path.
 * @returns {string} the parent directory, or an empty string.
 */
function parentRelative(relative) {
  const index = relative.lastIndexOf('/')
  return index === -1 ? '' : relative.slice(0, index)
}

/**
 * Join two vault-relative path fragments with `/`.
 *
 * @param {string} directory - parent fragment (may be empty).
 * @param {string} name - child fragment.
 * @returns {string} the joined path.
 */
function joinRelative(directory, name) {
  return directory === '' ? name : `${directory}/${name}`
}

/**
 * Refuse a target whose parent directory does not exist.
 *
 * The transaction never creates directories implicitly: the vault's layout is
 * bootstrap's decision, and inventing one here would turn a bad path into a
 * silent vault modification.
 *
 * @param {string} vaultRoot - normalized vault root.
 * @param {string} relativePath - vault-relative target.
 * @returns {Promise<void>} resolves when the parent exists and is a directory.
 * @throws {TransactionError} when the parent is missing or not a directory.
 */
async function assertParentDirectory(vaultRoot, relativePath) {
  const parent = parentRelative(relativePath)
  if (parent === '') return
  const absolute = await resolveVaultFile(vaultRoot, parent)
  const info = await lstatOrNull(absolute)
  if (info === null) {
    throw new TransactionError(
      'missing-parent-directory',
      `${relativePath} has no parent directory in the vault`,
    )
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new TransactionError(
      'missing-parent-directory',
      `the parent of ${relativePath} is not a directory`,
    )
  }
}

/**
 * Refuse a file this plugin must not modify.
 *
 * Ownership is proven from the note's own bytes: `trust: owner` is a human file
 * by declaration, and a caller that names an expected `id` gets that identity
 * checked. Frontmatter this plugin cannot parse leaves ownership unprovable,
 * which is a refusal rather than a repair — the plugin never rewrites what it
 * cannot prove it wrote (spec §10.3.2).
 *
 * @param {object} entry - the update request entry.
 * @param {Buffer} bytes - current target bytes.
 * @param {string} path - vault-relative path.
 * @returns {void}
 * @throws {TransactionError} when the target is not plugin-owned.
 */
function assertOwnership(entry, bytes, path) {
  const hasFrontmatter = /^---[ \t]*\r?\n/.test(bytes.subarray(0, 8).toString('latin1'))
  if (!hasFrontmatter) {
    if (entry.own?.id !== undefined) {
      throw new TransactionError(
        'ownership-unproven',
        `${path} has no frontmatter, so it cannot be the note ${entry.own.id} claims to be`,
      )
    }
    return
  }
  let note
  try {
    note = parseNote(bytes)
  } catch (error) {
    throw new TransactionError(
      'ownership-unproven',
      `${path} has frontmatter this plugin cannot parse, so ownership cannot be proven`,
      { cause: error },
    )
  }
  const data = note.data ?? {}
  if (data.trust === 'owner') {
    throw new TransactionError(
      'human-owned',
      `${path} declares trust:owner; the plugin never rewrites a human-owned note`,
    )
  }
  if (entry.own?.id !== undefined && data.id !== entry.own.id) {
    throw new TransactionError(
      'ownership-mismatch',
      `${path} carries id ${JSON.stringify(data.id)}, not ${JSON.stringify(entry.own.id)}`,
    )
  }
}

/**
 * Read a target, refusing every failure that could be an empty file.
 *
 * @param {string} absolute - absolute path.
 * @param {string} relative - vault-relative path, for diagnostics.
 * @param {{io?: object, mustExist?: boolean}} options - read seam and existence requirement.
 * @returns {Promise<Buffer|null>} the bytes, or `null` when absent and `mustExist` is false.
 * @throws {TransactionError} when the target cannot be read safely.
 */
async function readGuarded(absolute, relative, { io, mustExist = true }) {
  const lstat = io?.lstat ?? DEFAULT_IO.lstat
  const readFile = io?.readFile ?? DEFAULT_IO.readFile
  let info
  try {
    info = await lstat(absolute)
  } catch (error) {
    if (error.code === 'ENOENT') {
      if (mustExist) throw new TransactionError('target-missing', `${relative} does not exist`)
      return null
    }
    throw unreadableTarget(relative, error)
  }
  if (info.isSymbolicLink()) throw new TransactionError('unsafe-path', `${relative} is a symlink`)
  if (!info.isFile())
    throw new TransactionError('target-not-a-file', `${relative} is not a regular file`)
  if (info.size > 0 && info.blocks === 0) {
    throw new TransactionError(
      'offloaded-file',
      `${relative} reports ${info.size} bytes with 0 allocated blocks (an on-demand download placeholder); refusing to treat it as empty`,
    )
  }
  let bytes
  try {
    bytes = await readFile(absolute)
  } catch (error) {
    throw unreadableTarget(relative, error)
  }
  if (bytes.length === 0 && info.size > 0) {
    throw new TransactionError(
      'short-read',
      `${relative} reported ${info.size} bytes but read back empty; refusing to overwrite it`,
    )
  }
  return bytes
}

/**
 * Wrap a read failure so the caller can report it without guessing.
 *
 * @param {string} relative - vault-relative path.
 * @param {Error} error - the underlying failure.
 * @returns {TransactionError} the wrapped error, flagged when it is a known transient I/O failure.
 */
function unreadableTarget(relative, error) {
  const wrapped = new TransactionError(
    'unreadable-target',
    `cannot safely read ${relative} (${error.code ?? error.message}); a failed read is never an empty file`,
    { cause: error },
  )
  wrapped.transient = TRANSIENT_READ_CODES.includes(error.code)
  return wrapped
}

/**
 * `lstat` that reports absence as `null` and every other failure as a throw.
 *
 * @param {string} path - path to inspect.
 * @returns {Promise<import('node:fs').Stats|null>} the stat, or `null` when missing.
 */
async function lstatOrNull(path) {
  try {
    return await fs.lstat(path)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

/**
 * Write a new file exclusively, `fsync`-ing it before returning.
 *
 * @param {string} path - destination path.
 * @param {Buffer} bytes - contents.
 * @returns {Promise<void>} resolves once the bytes are durable.
 */
async function writeFileExclusive(path, bytes) {
  const handle = await fs.open(path, 'wx', 0o600)
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } catch (error) {
    await handle.close().catch(() => {})
    await fs.rm(path, { force: true }).catch(() => {})
    throw error
  }
  await handle.close()
}

/**
 * Replace a file through a same-directory temporary file and rename.
 *
 * @param {string} path - destination path.
 * @param {Buffer} bytes - replacement contents.
 * @returns {Promise<void>} resolves once the rename and its directory `fsync` are done.
 */
async function replaceFileAtomic(path, bytes) {
  const directory = dirname(path)
  const temporary = join(directory, `.${basename(path)}.${randomUUID()}.tmp`)
  await writeFileExclusive(temporary, bytes)
  try {
    await fs.rename(temporary, path)
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {})
    throw error
  }
  await fsyncDirectory(directory)
}

/**
 * Coerce a caller-supplied contents value to a Buffer.
 *
 * @param {unknown} value - string, Buffer or Uint8Array.
 * @param {string} label - field label for diagnostics.
 * @returns {Buffer} the bytes.
 * @throws {TransactionError} when the value is not writable content.
 */
function toBytes(value, label) {
  if (Buffer.isBuffer(value)) return value
  if (value instanceof Uint8Array) return Buffer.from(value)
  if (typeof value === 'string') return Buffer.from(value, 'utf8')
  throw new TransactionError(
    'invalid-request',
    `${label}.contents must be a string, Buffer or Uint8Array`,
  )
}

/**
 * The lowercase hex sha256 of a byte sequence.
 *
 * @param {Buffer|Uint8Array|string} bytes - bytes to hash.
 * @returns {string} 64 hex characters.
 */
function hashBytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}
