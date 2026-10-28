// Spec §1: the private, bounded persistence half of hot delivery receipts.
//
// A receipt is a promise that was kept: prepare writes it *before* the host
// output exists, and only an observed host insertion may acknowledge it. The
// state lives under dataRoot/delivery/<vaultHash>/<projectId>/<sessionHash>.json —
// never the vault, a config file or a real home — and every rule in the spec is
// enforced here: 128 KiB, 512 acknowledged identities, 16 pending receipts, 24
// hour retention, private modes, symlink refusal, atomic replacement, a short
// per-state lock that is never held across host I/O, idempotent duplicate acks,
// removals that cannot erase a newer version, and a new epoch on compaction or
// an uncertain restore.
//
// The module also carries the shared private-state primitives (identity, bounded
// JSON, atomic write, lock) that convention-rotation.js reuses, so the two
// subsystems cannot drift in how they write private files.
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative as relativePath, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { continuationFor, hotCursorFor } from './hot-delivery.js'
import { fsyncDirectory, vaultIdentity, writeJsonAtomic } from './receipts.js'
import { sha256Hex } from './routing.js'

/** Schema of the delivery state document. */
export const DELIVERY_SCHEMA = 1
/** The hard ceiling on one state file, in bytes. */
export const DELIVERY_STATE_MAX_BYTES = 128 * 1024
/** How many acknowledged identities one session state may hold. */
export const MAX_ACKED_IDENTITIES = 512
/** How many unacknowledged receipts may be pending at once. */
export const MAX_PENDING_RECEIPTS = 16
/** How long an unacknowledged preparation may be reconciled, in milliseconds. */
export const PENDING_RETENTION_MS = 24 * 60 * 60 * 1000
/** How many acknowledged message hashes are kept to answer a duplicate ack. */
const MAX_RECENT_ACKS = 32
/** A lock older than this is treated as abandoned by a dead process. */
const STALE_LOCK_MS = 60 * 1000
/** The default wait for another process's short state lock. */
const DEFAULT_LOCK_TIMEOUT_MS = 2000
/** The receipt kinds a delivery may have. */
export const DELIVERY_KINDS = Object.freeze(['full', 'delta', 'continuation'])
/** The producer kind a session-event acknowledgement must carry. */
export const DELIVERY_PRODUCER_KIND = 'plugin:obsidian-mem'
/** The marker every injected brief starts with inside its own text. */
const BRIEF_MARKER = '<!-- obsidian-mem:brief '

/** A delivery-state file could not be trusted or written. */
export class DeliveryStateError extends Error {
  /**
   * @param {string} code - machine-readable reason (state-lock-timeout, symlink-state, ...).
   * @param {string} message - human-readable diagnostic naming the offending path.
   * @param {{cause?: Error}} [options] - underlying failure, when there is one.
   */
  constructor(code, message, options) {
    super(message, options)
    this.name = 'DeliveryStateError'
    this.code = code
  }
}

/**
 * The identity a delivery state is scoped to.
 *
 * Reuses the receipt store's identity rule (sha256 of the vault's realpath) so a
 * vault reached through a symlinked home names the same store, and refuses a
 * binding that is not a bound project with a UUIDv4 id.
 *
 * @param {object} binding - a bound project binding.
 * @param {{home?: string}} [options] - home seam.
 * @returns {Promise<{vaultHash: string, projectId: string}>} the identity.
 */
export async function privateIdentity(binding, options = {}) {
  const identity = await vaultIdentity(binding, options)
  return { vaultHash: identity.vaultHash, projectId: identity.projectId }
}

/**
 * The absolute path of one session's delivery state.
 *
 * @param {object} input - the path parts.
 * @param {string} input.dataRoot - plugin data root.
 * @param {string} input.vaultHash - sha256 of the vault realpath.
 * @param {string} input.projectId - owning project id.
 * @param {string} input.sessionKey - the host session identity.
 * @returns {string} the path (not created here).
 */
export function deliveryStatePath({ dataRoot, vaultHash, projectId, sessionKey }) {
  if (typeof sessionKey !== 'string' || sessionKey === '') {
    throw new RangeError('delivery state needs a non-blank session key')
  }
  return join(dataRoot, 'delivery', vaultHash, projectId, sha256Hex(sessionKey) + '.json')
}

/**
 * A fresh state for one epoch: no observations at all.
 *
 * @param {number} epoch - the delivery epoch (bumped on compaction/clear).
 * @returns {object} the state.
 */
export function emptyDeliveryState(epoch) {
  return {
    schema: DELIVERY_SCHEMA,
    epoch,
    revision: 0,
    acked: {},
    ackedRevision: {},
    pending: [],
    recentAcks: [],
    continuation: null,
    degraded: false,
  }
}

/**
 * Read one bounded private JSON document without following a symlink.
 *
 * Missing is not an error: the caller's state is simply absent. A symlink
 * anywhere in the private chain is a refusal, because following it would read a
 * file outside dataRoot. Anything unreadable, oversized or unparseable is
 * reported as corrupt so the caller can reset conservatively.
 *
 * @param {{path: string, root: string, maxBytes: number}} input - path, private root and ceiling.
 * @returns {Promise<{value: object|null, missing: boolean, corrupt: boolean, symlink: boolean, degraded: boolean}>} the read.
 */
export async function readPrivateJson({ path, root, maxBytes }) {
  const chain = await lstatChain(path, root)
  if (chain.symlink)
    return { value: null, missing: false, corrupt: false, symlink: true, degraded: true }
  if (chain.missing)
    return { value: null, missing: true, corrupt: false, symlink: false, degraded: false }
  let stat
  try {
    stat = await fs.lstat(path)
  } catch (error) {
    if (error?.code === 'ENOENT')
      return { value: null, missing: true, corrupt: false, symlink: false, degraded: false }
    throw error
  }
  if (stat.isSymbolicLink())
    return { value: null, missing: false, corrupt: false, symlink: true, degraded: true }
  if (!stat.isFile())
    return { value: null, missing: false, corrupt: true, symlink: false, degraded: true }
  if (stat.size > maxBytes)
    return { value: null, missing: false, corrupt: true, symlink: false, degraded: true }
  let text
  try {
    text = await fs.readFile(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT')
      return { value: null, missing: true, corrupt: false, symlink: false, degraded: false }
    throw error
  }
  try {
    const value = JSON.parse(text)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { value: null, missing: false, corrupt: true, symlink: false, degraded: true }
    }
    return { value, missing: false, corrupt: false, symlink: false, degraded: false }
  } catch {
    return { value: null, missing: false, corrupt: true, symlink: false, degraded: true }
  }
}

/**
 * Write one private JSON document atomically (temporary file, fsync, rename).
 *
 * The directory chain under root is created with 0700 and checked for symlinks
 * first, so a write can never be redirected outside the private tree.
 *
 * @param {{path: string, root: string, value: unknown}} input - destination, private root and value.
 * @returns {Promise<void>} resolves once the rename is durable.
 * @throws {DeliveryStateError} with code symlink-state when the chain is unsafe.
 */
export async function writePrivateJson({ path, root, value }) {
  const chain = await ensurePrivateDirectories(path, root)
  if (chain.symlink) {
    throw new DeliveryStateError(
      'symlink-state',
      'private state path walks through a symlink: ' + path,
    )
  }
  await writeJsonAtomic(path, value)
}

/**
 * Run one short read-modify-write under a per-state lock file.
 *
 * The lock is held only across the bounded private-file work: it is never held
 * across a host call, because another session waiting on it is a session start.
 *
 * @template T
 * @param {{path: string, root: string}} input - the state path and its private root.
 * @param {() => Promise<T>} work - the critical section.
 * @param {{timeoutMs?: number}} [options] - the wait bound.
 * @returns {Promise<T>} the work's result.
 */
export async function withPrivateLock({ path, root }, work, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS
  await ensurePrivateDirectories(path, root)
  const lockPath = path + '.lock'
  const deadline = Date.now() + timeoutMs
  let handle
  for (;;) {
    try {
      handle = await fs.open(lockPath, 'wx', 0o600)
      break
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      const stale = await lockIsStale(lockPath)
      if (stale) {
        await fs.rm(lockPath, { force: true })
        continue
      }
      if (Date.now() >= deadline) {
        throw new DeliveryStateError(
          'state-lock-timeout',
          'another session holds the delivery state lock: ' + path,
        )
      }
      await delay(10)
    }
  }
  try {
    return await work()
  } finally {
    await handle?.close().catch(() => {})
    await fs.rm(lockPath, { force: true }).catch(() => {})
  }
}

/**
 * Load and normalize one session's state: epoch reset, retention, bounds.
 *
 * A corrupt, oversized or symlinked state is conservative: the caller gets a
 * fresh state (so nothing is suppressed) and a degraded flag. A new epoch is an
 * intentional reset, not a degradation.
 *
 * @param {object} input - the state identity.
 * @param {object} input.binding - a bound project binding.
 * @param {string} input.dataRoot - plugin data root.
 * @param {string} input.sessionKey - the host session identity.
 * @param {number} input.epoch - the current delivery epoch.
 * @param {number} [input.now] - clock seam for retention.
 * @param {string} [input.home] - home seam.
 * @returns {Promise<object>} the read result.
 */
export async function readDeliveryState({
  binding,
  dataRoot,
  sessionKey,
  epoch,
  now = Date.now(),
  home,
}) {
  const identity = await privateIdentity(binding, { home: home ?? homedir() })
  const path = deliveryStatePath({
    dataRoot,
    vaultHash: identity.vaultHash,
    projectId: identity.projectId,
    sessionKey,
  })
  const read = await readPrivateJson({
    path,
    root: join(dataRoot, 'delivery'),
    maxBytes: DELIVERY_STATE_MAX_BYTES,
  })
  const base = {
    vaultHash: identity.vaultHash,
    projectId: identity.projectId,
    path,
    corrupt: read.corrupt,
    symlink: read.symlink,
    degraded: read.degraded,
    pruned: 0,
  }
  if (read.symlink || read.corrupt) return { ...base, state: emptyDeliveryState(epoch) }
  if (read.missing) return { ...base, state: emptyDeliveryState(epoch) }
  const value = read.value
  if (value.schema !== DELIVERY_SCHEMA || !Number.isSafeInteger(value.epoch)) {
    return { ...base, corrupt: true, degraded: true, state: emptyDeliveryState(epoch) }
  }
  if (value.epoch !== epoch) return { ...base, state: emptyDeliveryState(epoch) }
  const state = normalizeState(value, epoch, now)
  return { ...base, state, pruned: state.prunedTally, degraded: base.degraded || state.degraded }
}

/**
 * Normalize a loaded document in place: retention, identity/pending caps.
 *
 * The caps are the spec's numbers. When one forces a drop, the state records
 * the degradation so a later reader can report that suppression is no longer
 * complete; dropping an observation always makes delivery less suppressed, never
 * more, which is the conservative direction.
 *
 * @param {object} value - a parsed state document at the current schema/epoch.
 * @param {number} epoch - the current epoch.
 * @param {number} now - clock.
 * @returns {object} the normalized state.
 */
function normalizeState(value, epoch, now) {
  const state = emptyDeliveryState(epoch)
  state.degraded = value.degraded === true
  state.revision = Number.isSafeInteger(value.revision) ? value.revision : 0
  const acked =
    value.acked !== null && typeof value.acked === 'object' && !Array.isArray(value.acked)
      ? value.acked
      : {}
  const revisions =
    value.ackedRevision !== null &&
    typeof value.ackedRevision === 'object' &&
    !Array.isArray(value.ackedRevision)
      ? value.ackedRevision
      : {}
  for (const [id, version] of Object.entries(acked)) {
    if (typeof id !== 'string' || typeof version !== 'string') continue
    state.acked[id] = version
    state.ackedRevision[id] = Number.isSafeInteger(revisions[id]) ? revisions[id] : 0
  }
  trimAcked(state)
  const pending = Array.isArray(value.pending) ? value.pending : []
  let pruned = 0
  for (const receipt of pending) {
    if (!validPendingReceipt(receipt)) continue
    if (now - receipt.at > PENDING_RETENTION_MS) {
      pruned += 1
      continue
    }
    state.pending.push(receipt)
  }
  state.prunedTally = pruned
  while (state.pending.length > MAX_PENDING_RECEIPTS) {
    state.pending.shift()
    state.degraded = true
  }
  if (value.continuation !== null && typeof value.continuation === 'object') {
    state.continuation = normalizeContinuation(value.continuation)
  }
  if (Array.isArray(value.recentAcks)) {
    state.recentAcks = value.recentAcks
      .filter((hash) => typeof hash === 'string')
      .slice(-MAX_RECENT_ACKS)
  }
  return state
}

/** @param {object} receipt - a candidate pending receipt. @returns {boolean} whether its shape is safe. */
function validPendingReceipt(receipt) {
  return (
    receipt !== null &&
    typeof receipt === 'object' &&
    typeof receipt.id === 'string' &&
    typeof receipt.messageHash === 'string' &&
    typeof receipt.generation === 'string' &&
    Number.isSafeInteger(receipt.revision) &&
    Number.isSafeInteger(receipt.at) &&
    DELIVERY_KINDS.includes(receipt.kind) &&
    Array.isArray(receipt.emitted) &&
    Array.isArray(receipt.removed)
  )
}

/** @param {object} continuation - a stored continuation plan. @returns {object|null} the normalized plan. */
function normalizeContinuation(continuation) {
  if (typeof continuation.generation !== 'string') return null
  if (!Number.isSafeInteger(continuation.offset)) return null
  if (!Number.isSafeInteger(continuation.candidates)) return null
  return {
    generation: continuation.generation,
    offset: continuation.offset,
    candidates: continuation.candidates,
    prepared: Number.isSafeInteger(continuation.prepared) ? continuation.prepared : 0,
    acked: Number.isSafeInteger(continuation.acked) ? continuation.acked : 0,
    // Whether the full message that created this plan was observed committed. A
    // plan prepared from a message that was never observed is not spendable: its
    // offset names units the model never saw, and continuing from it would skip
    // them forever. Defaults to false, the conservative direction.
    acknowledged: continuation.acknowledged === true,
    lastTurn: Number.isSafeInteger(continuation.lastTurn) ? continuation.lastTurn : null,
  }
}

/** @param {object} state - normalized state, trimmed in place. */
function trimAcked(state) {
  const ids = Object.keys(state.acked)
  if (ids.length <= MAX_ACKED_IDENTITIES) return
  ids.sort((left, right) => state.ackedRevision[left] - state.ackedRevision[right])
  const drop = ids.length - MAX_ACKED_IDENTITIES
  for (let index = 0; index < drop; index += 1) {
    delete state.acked[ids[index]]
    delete state.ackedRevision[ids[index]]
  }
  state.degraded = true
}

/**
 * Persist one prepared receipt and return the continuation plan it enables.
 *
 * The receipt is written before the caller's text is returned to the host, which
 * is the spec's ordering rule: a message the host never saw is an unacknowledged
 * receipt, and repetition is allowed. Nothing is acknowledged here.
 *
 * @param {object} input - the preparation.
 * @param {object} input.binding - a bound project binding.
 * @param {string} input.dataRoot - plugin data root.
 * @param {string} input.sessionKey - the host session identity.
 * @param {number} input.epoch - the delivery epoch.
 * @param {'full'|'delta'|'continuation'} input.kind - what the message is.
 * @param {string} input.generation - the hot source hash this message belongs to.
 * @param {string} input.text - the final message text (only its hash is stored).
 * @param {{id: string, version: string}[]} [input.emitted] - exact hot units in the message.
 * @param {{id: string, previousVersion: string}[]} [input.removed] - removals the message announces.
 * @param {object|null} [input.rotation] - the convention rotation the message used.
 * @param {number|null} [input.candidates] - how many hot units the generation has (enables continuation).
 * @param {number|null} [input.turn] - the user turn this preparation belongs to.
 * @param {number} [input.now] - clock seam.
 * @param {string} [input.home] - home seam.
 * @returns {Promise<object>} the receipt, continuation decision and degraded flag.
 */
export async function prepareDeliveryReceipt({
  binding,
  dataRoot,
  sessionKey,
  epoch,
  kind,
  generation,
  text,
  emitted = [],
  removed = [],
  rotation = null,
  candidates = null,
  turn = null,
  now = Date.now(),
  home,
}) {
  if (!DELIVERY_KINDS.includes(kind)) throw new RangeError('unknown delivery kind: ' + String(kind))
  const identity = await privateIdentity(binding, { home: home ?? homedir() })
  const path = deliveryStatePath({
    dataRoot,
    vaultHash: identity.vaultHash,
    projectId: identity.projectId,
    sessionKey,
  })
  const root = join(dataRoot, 'delivery')
  return withPrivateLock({ path, root }, async () => {
    const loaded = await loadStateForUpdate({ path, root, epoch, now })
    const state = loaded.state
    state.revision += 1
    const receipt = {
      id: randomUUID(),
      revision: state.revision,
      messageHash: sha256Hex(text),
      kind,
      generation,
      at: now,
      turn,
      emitted: emitted.map((unit) => ({ id: unit.id, version: unit.version })),
      removed: removed.map((unit) => ({ id: unit.id, previousVersion: unit.previousVersion })),
      rotation,
      offset: null,
    }
    let continuation = { available: false, reason: 'not-offered', cursor: null }
    if (kind === 'full' && Number.isSafeInteger(candidates)) {
      const same = state.continuation !== null && state.continuation.generation === generation
      if (!same) {
        state.continuation = {
          generation,
          projectId: identity.projectId,
          offset: emitted.length,
          candidates,
          prepared: 0,
          acked: 0,
          acknowledged: false,
          lastTurn: null,
        }
      } else if (state.continuation.acknowledged !== true) {
        // The previous attempt was never observed (an aborted turn, a lost ack), so
        // its offset is not evidence of delivery: rebase it on the prefix this new
        // message carries. The continuation counters restart with it — neither of
        // them described an observed window.
        state.continuation.offset = emitted.length
        state.continuation.candidates = candidates
        state.continuation.prepared = 0
        state.continuation.acked = 0
        state.continuation.lastTurn = null
        state.continuation.projectId = identity.projectId
      } else {
        state.continuation.candidates = candidates
        state.continuation.projectId = identity.projectId
      }
      continuation = continuationDecision(state.continuation, turn)
    }
    state.pending.push(receipt)
    if (state.pending.length > MAX_PENDING_RECEIPTS) {
      state.pending.shift()
      state.degraded = true
    }
    await writePrivateJson({ path, root, value: state })
    return {
      receipt: { ...receipt, pending: true },
      continuation,
      state,
      degraded: loaded.degraded || state.degraded,
      vaultHash: identity.vaultHash,
      path,
    }
  })
}

/**
 * Persist one continuation receipt for a generation a full brief left unfinished.
 *
 * @param {object} input - the continuation preparation.
 * @param {object} input.binding - a bound project binding.
 * @param {string} input.dataRoot - plugin data root.
 * @param {string} input.sessionKey - the host session identity.
 * @param {number} input.epoch - the delivery epoch.
 * @param {string} input.generation - the hot source hash.
 * @param {string} input.text - the final continuation text.
 * @param {{id: string, version: string}[]} input.emitted - exact hot units in the window.
 * @param {number} input.turn - the user turn.
 * @param {number} [input.now] - clock seam.
 * @param {string} [input.home] - home seam.
 * @returns {Promise<object>} the receipt and the next continuation decision.
 */
export async function prepareContinuationReceipt({
  binding,
  dataRoot,
  sessionKey,
  epoch,
  generation,
  text,
  emitted,
  turn,
  now = Date.now(),
  home,
}) {
  const identity = await privateIdentity(binding, { home: home ?? homedir() })
  const path = deliveryStatePath({
    dataRoot,
    vaultHash: identity.vaultHash,
    projectId: identity.projectId,
    sessionKey,
  })
  const root = join(dataRoot, 'delivery')
  return withPrivateLock({ path, root }, async () => {
    const loaded = await loadStateForUpdate({ path, root, epoch, now })
    const state = loaded.state
    const plan = state.continuation
    if (plan === null || plan.generation !== generation) {
      return {
        stale: true,
        receipt: null,
        continuation: { available: false, reason: 'stale', cursor: null },
        state,
        degraded: loaded.degraded || state.degraded,
        vaultHash: identity.vaultHash,
        path,
      }
    }
    if (plan.acknowledged !== true) {
      return {
        stale: false,
        receipt: null,
        continuation: {
          available: false,
          reason: 'unacknowledged',
          cursor: null,
          acknowledged: false,
        },
        state,
        degraded: loaded.degraded || state.degraded,
        vaultHash: identity.vaultHash,
        path,
      }
    }
    plan.projectId = identity.projectId
    const retry = state.pending.some(
      (pending) =>
        pending.kind === 'continuation' &&
        pending.generation === generation &&
        pending.offset === plan.offset,
    )
    const decision = continuationFor({
      candidates: plan.candidates,
      offset: plan.offset,
      attempts: plan.prepared,
      turn,
      lastTurn: plan.lastTurn,
    })
    if (!decision.available) {
      return {
        stale: false,
        receipt: null,
        continuation: { ...decision, cursor: null },
        state,
        degraded: loaded.degraded || state.degraded,
        vaultHash: identity.vaultHash,
        path,
      }
    }
    state.revision += 1
    const receipt = {
      id: randomUUID(),
      revision: state.revision,
      messageHash: sha256Hex(text),
      kind: 'continuation',
      generation,
      at: now,
      turn,
      emitted: emitted.map((unit) => ({ id: unit.id, version: unit.version })),
      removed: [],
      rotation: null,
      offset: plan.offset,
      counted: !retry,
    }
    if (!retry) plan.prepared += 1
    plan.lastTurn = turn
    state.pending.push(receipt)
    if (state.pending.length > MAX_PENDING_RECEIPTS) {
      state.pending.shift()
      state.degraded = true
    }
    await writePrivateJson({ path, root, value: state })
    return {
      stale: false,
      receipt: { ...receipt, pending: true },
      continuation: continuationDecision(plan, turn),
      state,
      degraded: loaded.degraded || state.degraded,
      vaultHash: identity.vaultHash,
      path,
    }
  })
}

/**
 * Acknowledge one observed host insertion.
 *
 * Only the units named in that exact message advance, and only when the proof is
 * a trusted observation (a committed producer-owned session event, or a
 * structured developer message in the harness's own transcript). Duplicate acks
 * are idempotent; a late ack cannot downgrade a newer version; a removal deletes
 * only the version it announced.
 *
 * @param {object} input - the acknowledgement.
 * @param {object} input.binding - a bound project binding.
 * @param {string} input.dataRoot - plugin data root.
 * @param {string} input.sessionKey - the host session identity.
 * @param {number} input.epoch - the delivery epoch the message belongs to.
 * @param {string} input.messageHash - sha256 of the message text.
 * @param {object} input.proof - the trusted observation.
 * @param {string} [input.producerKind] - the expected producer source kind.
 * @param {number} [input.now] - clock seam.
 * @param {string} [input.home] - home seam.
 * @returns {Promise<object>} the acknowledgement result.
 */
export async function ackDelivery({
  binding,
  dataRoot,
  sessionKey,
  epoch,
  messageHash,
  proof,
  producerKind = DELIVERY_PRODUCER_KIND,
  now = Date.now(),
  home,
}) {
  if (!trustedProof(proof, producerKind)) {
    return { acknowledged: false, duplicate: false, conflict: true, reason: 'untrusted-proof' }
  }
  const identity = await privateIdentity(binding, { home: home ?? homedir() })
  const path = deliveryStatePath({
    dataRoot,
    vaultHash: identity.vaultHash,
    projectId: identity.projectId,
    sessionKey,
  })
  const root = join(dataRoot, 'delivery')
  return withPrivateLock({ path, root }, async () => {
    const loaded = await loadStateForUpdate({ path, root, epoch, now })
    const state = loaded.state
    const index = state.pending.findIndex((receipt) => receipt.messageHash === messageHash)
    if (index === -1) {
      if (state.recentAcks.includes(messageHash)) {
        return { acknowledged: false, duplicate: true, conflict: false, reason: 'duplicate' }
      }
      return { acknowledged: false, duplicate: false, conflict: true, reason: 'unknown-receipt' }
    }
    const receipt = state.pending[index]
    for (const unit of receipt.emitted) {
      if (typeof unit?.id !== 'string' || typeof unit?.version !== 'string') continue
      const known = state.ackedRevision[unit.id]
      if (known !== undefined && known > receipt.revision) continue
      state.acked[unit.id] = unit.version
      state.ackedRevision[unit.id] = receipt.revision
    }
    for (const unit of receipt.removed) {
      if (typeof unit?.id !== 'string') continue
      if (state.acked[unit.id] !== unit.previousVersion) continue
      const known = state.ackedRevision[unit.id]
      if (known !== undefined && known > receipt.revision) continue
      delete state.acked[unit.id]
      delete state.ackedRevision[unit.id]
    }
    let continuationAdvanced = false
    let continuationAcknowledged = false
    if (receipt.kind === 'continuation' && state.continuation !== null) {
      const plan = state.continuation
      if (plan.generation === receipt.generation && plan.offset === receipt.offset) {
        plan.offset += receipt.emitted.length
        plan.acked += 1
        continuationAdvanced = true
      }
    }
    if (
      receipt.kind === 'full' &&
      state.continuation !== null &&
      state.continuation.generation === receipt.generation &&
      state.continuation.acknowledged !== true
    ) {
      // Spec §1: the unchanged overflow may only be continued after the message
      // that named it was observed committed. This ack is that observation, and it
      // also rebases the position on the units this exact message carried — the
      // preparation-time prefix is a proposal, the emitted list is the fact.
      state.continuation.acknowledged = true
      state.continuation.offset = receipt.emitted.length
      state.continuation.prepared = 0
      state.continuation.acked = 0
      state.continuation.lastTurn = null
      continuationAcknowledged = true
    }
    state.pending.splice(index, 1)
    state.recentAcks.push(messageHash)
    if (state.recentAcks.length > MAX_RECENT_ACKS) state.recentAcks.shift()
    trimAcked(state)
    await writePrivateJson({ path, root, value: state })
    return {
      acknowledged: true,
      duplicate: false,
      conflict: false,
      receipt,
      rotation: receipt.rotation ?? null,
      continuationAdvanced,
      continuationAcknowledged,
      continuation:
        state.continuation === null
          ? null
          : {
              ...continuationDecision(state.continuation, 0),
              acknowledged: state.continuation.acknowledged === true,
            },
      degraded: loaded.degraded || state.degraded,
      state,
    }
  })
}

/**
 * The pending message hashes of one session, for a transcript reconciler.
 *
 * Only hashes leave this call: a reconciler never needs the receipt bodies, and
 * a leaked body would be a second copy of text the host already has.
 *
 * @param {object} input - the state identity.
 * @param {object} input.binding - a bound project binding.
 * @param {string} input.dataRoot - plugin data root.
 * @param {string} input.sessionKey - the host session identity.
 * @param {number} input.epoch - the delivery epoch.
 * @param {number} [input.now] - clock seam.
 * @param {string} [input.home] - home seam.
 * @returns {Promise<{hashes: string[], vaultHash: string, path: string}>} the pending hashes.
 */
export async function pendingDeliveryHashes({
  binding,
  dataRoot,
  sessionKey,
  epoch,
  now = Date.now(),
  home,
}) {
  const read = await readDeliveryState({ binding, dataRoot, sessionKey, epoch, now, home })
  return {
    hashes: read.state.pending.map((receipt) => receipt.messageHash),
    vaultHash: read.vaultHash,
    path: read.path,
  }
}

/**
 * The message hashes a Codex rollout really delivered.
 *
 * The scan is structural, not textual: it parses each rollout line and accepts
 * only a developer message's input-text content whose text starts with the brief
 * marker. That is why a tool output that quotes the brief cannot acknowledge it —
 * quoted output lives in a different record shape, and the spec says quoted tool
 * output is not evidence.
 *
 * @param {string} transcript - the rollout text (already bounded by the caller).
 * @returns {Set<string>} the hashes of structured developer injections.
 */
export function transcriptDeliveryHashes(transcript) {
  const hashes = new Set()
  if (typeof transcript !== 'string' || transcript === '') return hashes
  for (const line of transcript.split(String.fromCharCode(10))) {
    if (line.trim() === '') continue
    let parsed
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    walkDeveloperText(parsed, hashes)
  }
  return hashes
}

/** @param {unknown} node - a parsed rollout value. @param {Set<string>} hashes - the accumulator. */
function walkDeveloperText(node, hashes) {
  if (Array.isArray(node)) {
    for (const entry of node) walkDeveloperText(entry, hashes)
    return
  }
  if (node === null || typeof node !== 'object') return
  if (node.role === 'developer' && Array.isArray(node.content)) {
    for (const part of node.content) {
      if (part === null || typeof part !== 'object') continue
      if (part.type !== 'input_text' || typeof part.text !== 'string') continue
      if (!part.text.startsWith(BRIEF_MARKER)) continue
      hashes.add(sha256Hex(part.text))
    }
  }
  for (const value of Object.values(node)) walkDeveloperText(value, hashes)
}

/**
 * Reconcile a Codex rollout's structured injections against the pending receipts.
 *
 * Missing, unreadable or over-cap evidence is unacknowledged: the caller passes
 * the read ceiling's verdict and this function refuses to claim anything from a
 * partial read, which keeps repetition possible exactly as the spec requires.
 *
 * @param {object} input - the reconciliation.
 * @param {object} input.binding - a bound project binding.
 * @param {string} input.dataRoot - plugin data root.
 * @param {string} input.sessionKey - the host session identity.
 * @param {number} input.epoch - the delivery epoch.
 * @param {string} input.transcript - the rollout head the hook read.
 * @param {boolean} [input.truncated] - true when the read ceiling cut the file.
 * @param {string} [input.proofKind] - the trusted hook that observed it.
 * @param {string} [input.producerKind] - the expected producer source kind.
 * @param {number} [input.now] - clock seam.
 * @param {string} [input.home] - home seam.
 * @returns {Promise<{reconciled: object[], truncated: boolean}>} what was acknowledged.
 */
export async function reconcileTranscript({
  binding,
  dataRoot,
  sessionKey,
  epoch,
  transcript,
  truncated = false,
  proofKind = 'transcript',
  producerKind = DELIVERY_PRODUCER_KIND,
  now = Date.now(),
  home,
}) {
  if (truncated) return { reconciled: [], truncated: true }
  const observed = transcriptDeliveryHashes(transcript)
  if (observed.size === 0) return { reconciled: [], truncated: false }
  const pending = await pendingDeliveryHashes({ binding, dataRoot, sessionKey, epoch, now, home })
  const reconciled = []
  for (const hash of pending.hashes) {
    if (!observed.has(hash)) continue
    const acked = await ackDelivery({
      binding,
      dataRoot,
      sessionKey,
      epoch,
      messageHash: hash,
      proof: { kind: proofKind, verified: true },
      producerKind,
      now,
      home,
    })
    if (acked.acknowledged) reconciled.push({ messageHash: hash, receipt: acked.receipt })
  }
  return { reconciled, truncated: false }
}

/**
 * Whether an acknowledgement proof is a trusted observation.
 *
 * A session-event proof must name this plugin's producer kind, because a
 * different plugin's committed message is not our insertion. A transcript proof
 * is a structured developer message already; the reconciler only passes it after
 * the structural scan matched the exact hash.
 *
 * @param {unknown} proof - the candidate proof.
 * @param {string} producerKind - the expected producer source kind.
 * @returns {boolean} whether the proof may acknowledge a receipt.
 */
function trustedProof(proof, producerKind) {
  if (proof === null || typeof proof !== 'object' || Array.isArray(proof)) return false
  if (proof.verified !== true) return false
  if (proof.kind === 'transcript') return true
  if (proof.kind !== 'session-event') return false
  return proof.sourceKind === producerKind
}

/**
 * The continuation a full brief leaves behind, as a decision plus a cursor.
 *
 * @param {object} plan - the stored continuation plan.
 * @param {number|null} turn - the current user turn.
 * @returns {object} the decision with a cursor when available.
 */
function continuationDecision(plan, turn) {
  const decision = continuationFor({
    candidates: plan.candidates,
    offset: plan.offset,
    attempts: plan.prepared,
    turn: Number.isSafeInteger(turn) ? turn : 0,
    lastTurn: plan.lastTurn,
  })
  if (!decision.available) {
    return { ...decision, cursor: null, acknowledged: plan.acknowledged === true }
  }
  const projectId =
    typeof plan.projectId === 'string' && plan.projectId !== '' ? plan.projectId : null
  return {
    ...decision,
    acknowledged: plan.acknowledged === true,
    cursor:
      projectId === null
        ? null
        : hotCursorFor({ projectId, sourceHash: plan.generation, offset: plan.offset }),
  }
}

/**
 * Load the state for one locked read-modify-write, resetting on a new epoch.
 *
 * @param {{path: string, root: string, epoch: number, now: number}} input - the locked identity.
 * @returns {Promise<{state: object, degraded: boolean}>} the state to mutate.
 */
async function loadStateForUpdate({ path, root, epoch, now }) {
  const read = await readPrivateJson({ path, root, maxBytes: DELIVERY_STATE_MAX_BYTES })
  if (read.symlink || read.corrupt) return { state: emptyDeliveryState(epoch), degraded: true }
  if (read.missing) return { state: emptyDeliveryState(epoch), degraded: read.degraded }
  const value = read.value
  if (
    value.schema !== DELIVERY_SCHEMA ||
    !Number.isSafeInteger(value.epoch) ||
    value.epoch !== epoch
  ) {
    return { state: emptyDeliveryState(epoch), degraded: read.degraded }
  }
  const state = normalizeState(value, epoch, now)
  return { state, degraded: read.degraded || state.degraded }
}

/**
 * The path components of `path` below `root`, as an array of segments.
 *
 * Not `path.slice(root.length).split('/')`: on Windows both strings come from
 * `node:path.join`, so they are backslash-separated and that split leaves ONE
 * segment ("\\hash\\project\\session.json"), which `join` then turns into a bogus
 * child of `root`. The loop below lstat-ed that single wrong path, saw `ENOENT` and
 * reported "missing, not a symlink" — so a junction planted at any intermediate
 * level was silently FOLLOWED, and `readPrivateJson` could answer with bytes from
 * outside `dataRoot`. On POSIX the same expression happened to be correct, which
 * is why only Windows exposed it.
 *
 * `relativePath` is separator-aware and `sep` splits by the platform's separator,
 * so the chain is the real one on both platforms. A path outside `root` yields a
 * `..` segment, which the caller's `lstat` then answers for itself rather than
 * being flattened away.
 *
 * @param {string} path - candidate private path (file or directory).
 * @param {string} root - the private root it must live under.
 * @returns {string[]} the segments between `root` and `path`.
 */
function privateChainOf(path, root) {
  if (!isAbsolute(path) || !isAbsolute(root)) return []
  const relative = relativePath(root, path)
  if (relative === '') return []
  // `relativePath` cannot produce a leading separator, so the split is exact.
  return relative.split(sep).filter(Boolean)
}

/**
 * The lstat verdict for every private path component below root.
 *
 * @param {string} path - the candidate state path.
 * @param {string} root - the private root (dataRoot/delivery or dataRoot/cursors).
 * @returns {Promise<{missing: boolean, symlink: boolean}>} the verdict.
 */
async function lstatChain(path, root) {
  const relative = privateChainOf(path, root)
  let current = root
  try {
    const rootStat = await fs.lstat(root)
    if (rootStat.isSymbolicLink()) return { missing: false, symlink: true }
  } catch (error) {
    if (error?.code === 'ENOENT') return { missing: true, symlink: false }
    throw error
  }
  for (const segment of relative) {
    current = join(current, segment)
    try {
      const stat = await fs.lstat(current)
      if (stat.isSymbolicLink()) return { missing: false, symlink: true }
    } catch (error) {
      if (error?.code === 'ENOENT') return { missing: true, symlink: false }
      throw error
    }
  }
  return { missing: false, symlink: false }
}

/**
 * Create the private directory chain and report whether it is symlink-safe.
 *
 * @param {string} path - the destination file.
 * @param {string} root - the private root.
 * @returns {Promise<{symlink: boolean}>} the safety verdict.
 */
async function ensurePrivateDirectories(path, root) {
  const relative = privateChainOf(dirname(path), root)
  let current = root
  for (const segment of relative) {
    current = join(current, segment)
    try {
      const stat = await fs.lstat(current)
      if (stat.isSymbolicLink()) return { symlink: true }
      if (!stat.isDirectory()) return { symlink: false }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      await fs.mkdir(current, { recursive: true, mode: 0o700 })
    }
  }
  return { symlink: false }
}

/**
 * Whether a lock file is older than the stale ceiling.
 *
 * @param {string} lockPath - the lock file.
 * @returns {Promise<boolean>} whether a dead process most likely left it.
 */
async function lockIsStale(lockPath) {
  try {
    const stat = await fs.lstat(lockPath)
    return Date.now() - stat.mtimeMs > STALE_LOCK_MS
  } catch (error) {
    if (error?.code === 'ENOENT') return true
    throw error
  }
}

export { fsyncDirectory }

/**
 * The epoch one session's delivery state currently holds, without resetting it.
 *
 * A harness that keeps no per-session memory (the Codex hooks are separate
 * processes) reads this before preparing: a compaction/clear bumps it, an ordinary
 * resume keeps it, and a missing or unreadable state answers 0 so the first
 * preparation starts at epoch 1. This never writes.
 *
 * @param {object} input - the state identity.
 * @param {object} input.binding - a bound project binding.
 * @param {string} input.dataRoot - plugin data root.
 * @param {string} input.sessionKey - the host session identity.
 * @param {string} [input.home] - home seam.
 * @returns {Promise<number>} the stored epoch, or 0.
 */
export async function deliveryStateEpoch({ binding, dataRoot, sessionKey, home }) {
  const identity = await privateIdentity(binding, { home: home ?? homedir() })
  const path = deliveryStatePath({
    dataRoot,
    vaultHash: identity.vaultHash,
    projectId: identity.projectId,
    sessionKey,
  })
  const read = await readPrivateJson({
    path,
    root: join(dataRoot, 'delivery'),
    maxBytes: DELIVERY_STATE_MAX_BYTES,
  })
  if (read.value === null) return 0
  return Number.isSafeInteger(read.value.epoch) && read.value.epoch > 0 ? read.value.epoch : 0
}

/**
 * Drop one preparation whose message was deliberately not emitted.
 *
 * The delta builder composes a message on every pre-step to learn whether the hot
 * generation changed; when the plan is discarded (an unchanged hash, a delta that
 * does not fit, an awaited abort), the receipt it persisted would otherwise sit
 * pending for 24 hours and could never be acknowledged. Removing exactly that
 * receipt is safe: it was written before any host output existed, so no committed
 * message can have carried it. A continuation receipt also gives its preparation
 * count back, so a discarded window does not spend one of the two allowances.
 *
 * @param {object} input - the discarded preparation.
 * @param {object} input.binding - a bound project binding.
 * @param {string} input.dataRoot - plugin data root.
 * @param {string} input.sessionKey - the host session identity.
 * @param {number} input.epoch - the delivery epoch.
 * @param {string} input.messageHash - the receipt's message hash.
 * @param {number} [input.now] - clock seam.
 * @param {string} [input.home] - home seam.
 * @returns {Promise<{discarded: boolean}>} whether a pending receipt was removed.
 */
export async function discardDeliveryReceipt({
  binding,
  dataRoot,
  sessionKey,
  epoch,
  messageHash,
  now = Date.now(),
  home,
}) {
  if (typeof messageHash !== 'string' || messageHash === '') return { discarded: false }
  const identity = await privateIdentity(binding, { home: home ?? homedir() })
  const path = deliveryStatePath({
    dataRoot,
    vaultHash: identity.vaultHash,
    projectId: identity.projectId,
    sessionKey,
  })
  const root = join(dataRoot, 'delivery')
  return withPrivateLock({ path, root }, async () => {
    const loaded = await loadStateForUpdate({ path, root, epoch, now })
    const state = loaded.state
    const index = state.pending.findIndex((receipt) => receipt.messageHash === messageHash)
    if (index === -1) return { discarded: false }
    const [receipt] = state.pending.splice(index, 1)
    if (
      receipt.kind === 'full' &&
      state.continuation !== null &&
      state.continuation.generation === receipt.generation &&
      state.continuation.acknowledged !== true
    ) {
      // The message this plan was derived from never reached the host, so its
      // offset names units nobody saw. Dropping the plan makes the next full
      // preparation rebuild it from what that message really carries.
      state.continuation = null
    }
    if (
      receipt.kind === 'continuation' &&
      receipt.counted === true &&
      state.continuation !== null &&
      state.continuation.generation === receipt.generation &&
      state.continuation.offset === receipt.offset
    ) {
      state.continuation.prepared = Math.max(0, state.continuation.prepared - 1)
    }
    await writePrivateJson({ path, root, value: state })
    return { discarded: true }
  })
}
