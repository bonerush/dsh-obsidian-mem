// Spec §1: the private, bounded persistence half of hot delivery.
//
// The state is under <dataRoot>/delivery/<vaultHash>/<projectId>/<sessionHash>.json —
// never the vault, never a config file, never a real home. These cases pin the
// contract: preparation persists a receipt before any output exists; only a
// verified acknowledgement advances the exact units that were emitted; duplicate
// acks are idempotent; a stale ack cannot downgrade a newer version; removal
// notices withdraw one exact version; a corrupt or oversized state resets
// conservatively; the bounds, the 24-hour retention, the epoch reset and the
// symlink refusal are all enforced.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  DELIVERY_SCHEMA,
  DELIVERY_STATE_MAX_BYTES,
  MAX_ACKED_IDENTITIES,
  MAX_PENDING_RECEIPTS,
  PENDING_RETENTION_MS,
  ackDelivery,
  deliveryStatePath,
  discardDeliveryReceipt,
  pendingDeliveryHashes,
  prepareContinuationReceipt,
  prepareDeliveryReceipt,
  readDeliveryState,
  reconcileTranscript,
  transcriptDeliveryHashes,
} from '../lib/delivery-state.js'

const PROJECT_ID = '1c392abb-7b08-42f7-871d-2a379caf9448'
const SESSION_KEY = 'session-9d4a4c1e-2f1a-4f4e-8b3a-000000000001'
const PRODUCER = 'plugin:obsidian-mem'
const NOW = Date.now()

const emitted = (id, version) => ({ id, version })
const removal = (id, previousVersion) => ({ id, previousVersion })

/**
 * A throwaway data root and a bound identity; the vault root exists so the
 * identity's realpath is stable.
 *
 * @param {object} t - the node:test context.
 * @returns {Promise<object>} the fixture.
 */
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'obsidian-mem-delivery-'))
  const vault = join(root, 'vault')
  const dataRoot = join(root, 'data')
  await mkdir(vault, { recursive: true })
  await mkdir(dataRoot, { recursive: true })
  t.after(async () => rm(root, { recursive: true, force: true, maxRetries: 4 }))
  return {
    root,
    vault,
    dataRoot,
    binding: {
      kind: 'bound',
      projectId: PROJECT_ID,
      vaultRoot: vault,
      relativeDir: 'Projects/demo--1c392abb',
      displayName: 'Demo',
    },
  }
}

/** One full-brief receipt with the given emitted units. */
function prepare(env, overrides = {}) {
  return prepareDeliveryReceipt({
    binding: env.binding,
    dataRoot: env.dataRoot,
    sessionKey: SESSION_KEY,
    epoch: 1,
    kind: 'full',
    generation: 'g1',
    text: 'BRIEF-TEXT',
    emitted: [emitted('hot-a', 'v1')],
    removed: [],
    ...overrides,
  })
}

const proof = { kind: 'session-event', verified: true, sourceKind: PRODUCER, seq: 7 }

// ---------------------------------------------------------------------------
// Layout and preparation
// ---------------------------------------------------------------------------

test('the state lives under delivery/<vaultHash>/<projectId>/<sessionHash>.json with private modes', async (t) => {
  const env = await fixture(t)
  const prepared = await prepare(env)
  const path = deliveryStatePath({
    dataRoot: env.dataRoot,
    vaultHash: prepared.vaultHash,
    projectId: PROJECT_ID,
    sessionKey: SESSION_KEY,
  })
  assert.match(
    path,
    /delivery[/\\][0-9a-f]{64}[/\\]1c392abb-7b08-42f7-871d-2a379caf9448[/\\][0-9a-f]{64}\.json$/u,
  )
  assert.equal(
    path.includes('session-9d4a'),
    false,
    'the session id is hashed, not stored in the name',
  )
  assert.equal(path.startsWith(env.vault), false, 'the vault is never the state root')
  const statted = await stat(path)
  assert.equal(statted.mode & 0o777, 0o600)
  assert.equal((await stat(join(path, '..'))).mode & 0o777, 0o700)
})

test('preparation persists a pending receipt before any output exists and advances nothing', async (t) => {
  const env = await fixture(t)
  const prepared = await prepare(env, { emitted: [emitted('hot-a', 'v1'), emitted('hot-b', 'v2')] })
  assert.equal(prepared.receipt.pending, true)
  assert.match(prepared.receipt.messageHash, /^[0-9a-f]{64}$/)
  const stored = JSON.parse(
    await readFile(
      deliveryStatePath({
        dataRoot: env.dataRoot,
        vaultHash: prepared.vaultHash,
        projectId: PROJECT_ID,
        sessionKey: SESSION_KEY,
      }),
      'utf8',
    ),
  )
  assert.equal(stored.schema, DELIVERY_SCHEMA)
  assert.equal(stored.epoch, 1)
  assert.equal(stored.pending.length, 1)
  assert.deepEqual(stored.pending[0].emitted, [emitted('hot-a', 'v1'), emitted('hot-b', 'v2')])
  // A receipt carries identities and a hash, never text.
  assert.equal(JSON.stringify(stored).includes('BRIEF-TEXT'), false)
  assert.deepEqual(stored.acked, {})
})

// ---------------------------------------------------------------------------
// Acknowledgement
// ---------------------------------------------------------------------------

test('a verified acknowledgement advances exactly the emitted units', async (t) => {
  const env = await fixture(t)
  const prepared = await prepare(env, {
    emitted: [emitted('hot-a', 'v1'), emitted('hot-b', 'v2')],
    removed: [removal('hot-old', 'v0')],
  })
  const acked = await ackDelivery({
    binding: env.binding,
    dataRoot: env.dataRoot,
    sessionKey: SESSION_KEY,
    epoch: 1,
    messageHash: prepared.receipt.messageHash,
    proof,
    producerKind: PRODUCER,
  })
  assert.equal(acked.acknowledged, true)
  assert.equal(acked.duplicate, false)
  const read = await readDeliveryState({
    binding: env.binding,
    dataRoot: env.dataRoot,
    sessionKey: SESSION_KEY,
    epoch: 1,
  })
  assert.deepEqual(read.state.acked, { 'hot-a': 'v1', 'hot-b': 'v2' })
  assert.equal(read.state.pending.length, 0)
})

test('a duplicate acknowledgement is idempotent', async (t) => {
  const env = await fixture(t)
  const prepared = await prepare(env)
  const args = {
    binding: env.binding,
    dataRoot: env.dataRoot,
    sessionKey: SESSION_KEY,
    epoch: 1,
    messageHash: prepared.receipt.messageHash,
    proof,
    producerKind: PRODUCER,
  }
  await ackDelivery(args)
  const first = JSON.parse(
    await readFile(
      deliveryStatePath({
        dataRoot: env.dataRoot,
        vaultHash: prepared.vaultHash,
        projectId: PROJECT_ID,
        sessionKey: SESSION_KEY,
      }),
      'utf8',
    ),
  )
  const again = await ackDelivery(args)
  assert.equal(again.acknowledged, false)
  assert.equal(again.duplicate, true)
  const second = JSON.parse(
    await readFile(
      deliveryStatePath({
        dataRoot: env.dataRoot,
        vaultHash: prepared.vaultHash,
        projectId: PROJECT_ID,
        sessionKey: SESSION_KEY,
      }),
      'utf8',
    ),
  )
  assert.deepEqual(second.acked, first.acked)
})

test('an unverified or foreign proof is a conflict and advances nothing', async (t) => {
  const env = await fixture(t)
  const prepared = await prepare(env)
  for (const bad of [
    null,
    {},
    { kind: 'transcript', verified: false },
    { kind: 'session-event', verified: true, sourceKind: 'plugin:other' },
    { kind: 'tool-output', verified: true },
  ]) {
    const acked = await ackDelivery({
      binding: env.binding,
      dataRoot: env.dataRoot,
      sessionKey: SESSION_KEY,
      epoch: 1,
      messageHash: prepared.receipt.messageHash,
      proof: bad,
      producerKind: PRODUCER,
    })
    assert.equal(acked.acknowledged, false, JSON.stringify(bad))
    assert.equal(acked.conflict, true)
  }
  const read = await readDeliveryState({
    binding: env.binding,
    dataRoot: env.dataRoot,
    sessionKey: SESSION_KEY,
    epoch: 1,
  })
  assert.deepEqual(read.state.acked, {})
})

test('a changed version is delivered and acknowledged again', async (t) => {
  const env = await fixture(t)
  const first = await prepare(env, { emitted: [emitted('hot-a', 'v1')] })
  await ackDelivery({
    binding: env.binding,
    dataRoot: env.dataRoot,
    sessionKey: SESSION_KEY,
    epoch: 1,
    messageHash: first.receipt.messageHash,
    proof,
    producerKind: PRODUCER,
  })
  const second = await prepare(env, { emitted: [emitted('hot-a', 'v2')] })
  await ackDelivery({
    binding: env.binding,
    dataRoot: env.dataRoot,
    sessionKey: SESSION_KEY,
    epoch: 1,
    messageHash: second.receipt.messageHash,
    proof,
    producerKind: PRODUCER,
  })
  const read = await readDeliveryState({
    binding: env.binding,
    dataRoot: env.dataRoot,
    sessionKey: SESSION_KEY,
    epoch: 1,
  })
  assert.deepEqual(read.state.acked, { 'hot-a': 'v2' })
})

test('a late acknowledgement of an older preparation cannot downgrade a newer version', async (t) => {
  const env = await fixture(t)
  const old = await prepare(env, { emitted: [emitted('hot-a', 'v1')] })
  const fresh = await prepare(env, { emitted: [emitted('hot-a', 'v2')] })
  const ack = (hash) =>
    ackDelivery({
      binding: env.binding,
      dataRoot: env.dataRoot,
      sessionKey: SESSION_KEY,
      epoch: 1,
      messageHash: hash,
      proof,
      producerKind: PRODUCER,
    })
  await ack(fresh.receipt.messageHash)
  const late = await ack(old.receipt.messageHash)
  assert.equal(late.acknowledged, true, 'the old receipt is still a real host insertion')
  const read = await readDeliveryState({
    binding: env.binding,
    dataRoot: env.dataRoot,
    sessionKey: SESSION_KEY,
    epoch: 1,
  })
  assert.deepEqual(read.state.acked, { 'hot-a': 'v2' }, 'the newer version stands')
})

test('a removal is acknowledged individually and a stale one cannot erase a newer version', async (t) => {
  const env = await fixture(t)
  const first = await prepare(env, { emitted: [], removed: [removal('hot-a', 'v1')] })
  const second = await prepare(env, { emitted: [emitted('hot-a', 'v2')], removed: [] })
  const ack = (hash) =>
    ackDelivery({
      binding: env.binding,
      dataRoot: env.dataRoot,
      sessionKey: SESSION_KEY,
      epoch: 1,
      messageHash: hash,
      proof,
      producerKind: PRODUCER,
    })
  await ack(second.receipt.messageHash)
  await ack(first.receipt.messageHash)
  const read = await readDeliveryState({
    binding: env.binding,
    dataRoot: env.dataRoot,
    sessionKey: SESSION_KEY,
    epoch: 1,
  })
  assert.deepEqual(read.state.acked, { 'hot-a': 'v2' }, 'the stale removal withdrew v1 only')
})

// ---------------------------------------------------------------------------
// Epoch, corruption and degradation
// ---------------------------------------------------------------------------

test('a new epoch clears the previous delivery observations', async (t) => {
  const env = await fixture(t)
  const first = await prepare(env, { emitted: [emitted('hot-a', 'v1')] })
  await ackDelivery({
    binding: env.binding,
    dataRoot: env.dataRoot,
    sessionKey: SESSION_KEY,
    epoch: 1,
    messageHash: first.receipt.messageHash,
    proof,
    producerKind: PRODUCER,
  })
  const reset = await readDeliveryState({
    binding: env.binding,
    dataRoot: env.dataRoot,
    sessionKey: SESSION_KEY,
    epoch: 2,
  })
  assert.equal(reset.state.epoch, 2)
  assert.deepEqual(reset.state.acked, {})
  assert.equal(reset.state.pending.length, 0)
  assert.equal(reset.degraded, false, 'an intentional reset is not a degraded state')
})

test('a corrupt state resets conservatively instead of suppressing delivery', async (t) => {
  const env = await fixture(t)
  const first = await prepare(env, { emitted: [emitted('hot-a', 'v1')] })
  const path = deliveryStatePath({
    dataRoot: env.dataRoot,
    vaultHash: first.vaultHash,
    projectId: PROJECT_ID,
    sessionKey: SESSION_KEY,
  })
  await writeFile(path, '{ not json', 'utf8')
  const read = await readDeliveryState({
    binding: env.binding,
    dataRoot: env.dataRoot,
    sessionKey: SESSION_KEY,
    epoch: 1,
  })
  assert.equal(read.corrupt, true)
  assert.equal(read.degraded, true)
  assert.deepEqual(read.state.acked, {}, 'nothing is suppressed on a state that cannot be trusted')
  const next = await prepare(env)
  assert.equal(next.degraded, true)
  assert.ok(next.receipt.messageHash.length > 0)
})

test('a state file past 128 KiB is refused as corrupt rather than loaded', async (t) => {
  const env = await fixture(t)
  const first = await prepare(env)
  const path = deliveryStatePath({
    dataRoot: env.dataRoot,
    vaultHash: first.vaultHash,
    projectId: PROJECT_ID,
    sessionKey: SESSION_KEY,
  })
  await writeFile(path, 'x'.repeat(DELIVERY_STATE_MAX_BYTES + 1), 'utf8')
  const read = await readDeliveryState({
    binding: env.binding,
    dataRoot: env.dataRoot,
    sessionKey: SESSION_KEY,
    epoch: 1,
  })
  assert.equal(read.corrupt, true)
})

test('a symlinked session directory is refused instead of followed', async (t) => {
  const env = await fixture(t)
  const first = await prepare(env)
  const path = deliveryStatePath({
    dataRoot: env.dataRoot,
    vaultHash: first.vaultHash,
    projectId: PROJECT_ID,
    sessionKey: SESSION_KEY,
  })
  const outside = join(env.root, 'outside')
  await mkdir(outside, { recursive: true })
  await rm(join(path, '..'), { recursive: true, force: true })
  await symlink(outside, join(path, '..'), 'dir')
  const read = await readDeliveryState({
    binding: env.binding,
    dataRoot: env.dataRoot,
    sessionKey: SESSION_KEY,
    epoch: 1,
  })
  assert.equal(read.symlink, true)
  assert.equal(read.degraded, true)
  assert.deepEqual(read.state.acked, {})
  const files = await readFile(join(outside, 'nothing'), 'utf8').catch(() => null)
  assert.equal(files, null)
})

// ---------------------------------------------------------------------------
// Bounds and retention
// ---------------------------------------------------------------------------

test('pending receipts are capped at 16, oldest dropped first', async (t) => {
  const env = await fixture(t)
  for (let i = 0; i < MAX_PENDING_RECEIPTS + 4; i += 1) {
    await prepare(env, { text: `BRIEF-${i}`, generation: `g${i}`, now: NOW + i })
  }
  const read = await readDeliveryState({
    binding: env.binding,
    dataRoot: env.dataRoot,
    sessionKey: SESSION_KEY,
    epoch: 1,
  })
  assert.equal(read.state.pending.length, MAX_PENDING_RECEIPTS)
  assert.equal(read.degraded, true, 'dropping a pending receipt is a reported degradation')
  assert.equal(read.state.pending[0].generation, 'g4', 'the four oldest were dropped')
})

test('pending receipts older than 24 hours are dropped on the next read', async (t) => {
  const env = await fixture(t)
  const first = await prepare(env, { now: NOW })
  const path = deliveryStatePath({
    dataRoot: env.dataRoot,
    vaultHash: first.vaultHash,
    projectId: PROJECT_ID,
    sessionKey: SESSION_KEY,
  })
  const stored = JSON.parse(await readFile(path, 'utf8'))
  stored.pending[0].at = NOW - PENDING_RETENTION_MS - 1
  await writeFile(path, JSON.stringify(stored), 'utf8')
  const read = await readDeliveryState({
    binding: env.binding,
    dataRoot: env.dataRoot,
    sessionKey: SESSION_KEY,
    epoch: 1,
  })
  assert.equal(read.state.pending.length, 0)
  assert.equal(read.pruned, 1)
})

test('acknowledged identities are capped at 512 and the drop is reported', async (t) => {
  const env = await fixture(t)
  let firstVaultHash = null
  for (let i = 0; i < MAX_ACKED_IDENTITIES + 8; i += 1) {
    const prepared = await prepare(env, {
      emitted: [emitted(`hot-${i}`, 'v1')],
      text: `T${i}`,
      now: NOW + i,
    })
    firstVaultHash = prepared.vaultHash
    await ackDelivery({
      binding: env.binding,
      dataRoot: env.dataRoot,
      sessionKey: SESSION_KEY,
      epoch: 1,
      messageHash: prepared.receipt.messageHash,
      proof,
      producerKind: PRODUCER,
    })
  }
  const read = await readDeliveryState({
    binding: env.binding,
    dataRoot: env.dataRoot,
    sessionKey: SESSION_KEY,
    epoch: 1,
  })
  assert.equal(Object.keys(read.state.acked).length, MAX_ACKED_IDENTITIES)
  assert.equal(read.degraded, true)
  assert.equal(read.vaultHash, firstVaultHash)
})

test('the identity map keeps the most recently acknowledged identities', async (t) => {
  const env = await fixture(t)
  for (let i = 0; i < MAX_ACKED_IDENTITIES + 2; i += 1) {
    const prepared = await prepare(env, {
      emitted: [emitted(`hot-${i}`, 'v1')],
      text: `T${i}`,
      now: NOW + i,
    })
    await ackDelivery({
      binding: env.binding,
      dataRoot: env.dataRoot,
      sessionKey: SESSION_KEY,
      epoch: 1,
      messageHash: prepared.receipt.messageHash,
      proof,
      producerKind: PRODUCER,
    })
  }
  const read = await readDeliveryState({
    binding: env.binding,
    dataRoot: env.dataRoot,
    sessionKey: SESSION_KEY,
    epoch: 1,
  })
  assert.equal(read.state.acked['hot-0'], undefined)
  assert.equal(read.state.acked[`hot-${MAX_ACKED_IDENTITIES + 1}`], 'v1')
})

// ---------------------------------------------------------------------------
// Concurrency and the lock
// ---------------------------------------------------------------------------

test('two concurrent preparations both persist and neither loses the other', async (t) => {
  const env = await fixture(t)
  const [left, right] = await Promise.all([
    prepare(env, { text: 'LEFT', generation: 'g-left' }),
    prepare(env, { text: 'RIGHT', generation: 'g-right' }),
  ])
  assert.notEqual(left.receipt.revision, right.receipt.revision)
  const read = await readDeliveryState({
    binding: env.binding,
    dataRoot: env.dataRoot,
    sessionKey: SESSION_KEY,
    epoch: 1,
  })
  assert.equal(read.state.pending.length, 2)
  const generations = read.state.pending.map((receipt) => receipt.generation).sort()
  assert.deepEqual(generations, ['g-left', 'g-right'])
})

test('the per-state lock is released after an operation and a stale lock is broken', async (t) => {
  const env = await fixture(t)
  const prepared = await prepare(env)
  const path = deliveryStatePath({
    dataRoot: env.dataRoot,
    vaultHash: prepared.vaultHash,
    projectId: PROJECT_ID,
    sessionKey: SESSION_KEY,
  })
  const lockPath = `${path}.lock`
  await assert.rejects(() => stat(lockPath))
  await writeFile(lockPath, '', 'utf8')
  const { utimes } = await import('node:fs/promises')
  const old = new Date(Date.now() - 10 * 60 * 1000)
  await utimes(lockPath, old, old)
  const read = await readDeliveryState({
    binding: env.binding,
    dataRoot: env.dataRoot,
    sessionKey: SESSION_KEY,
    epoch: 1,
  })
  assert.equal(read.degraded, false)
})

// ---------------------------------------------------------------------------
// Continuation preparation and receipts
// ---------------------------------------------------------------------------

test('a full brief offers a continuation only after it is acknowledged; the ack advances it', async (t) => {
  const env = await fixture(t)
  const generation = 'a'.repeat(64)
  const prepared = await prepare(env, {
    generation,
    emitted: [emitted('hot-a', 'v1')],
    candidates: 4,
  })
  assert.equal(prepared.continuation.available, true)
  assert.equal(prepared.continuation.acknowledged, false)
  assert.equal(prepared.continuation.offset, 1)
  assert.equal(prepared.continuation.remaining, 3)
  assert.match(prepared.continuation.cursor, /^hd1:/)

  // The plan exists, but it is not spendable until the host was observed to
  // commit the full message: a continuation that ran now would skip the very
  // units the model never saw.
  const continuationArgs = {
    binding: env.binding,
    dataRoot: env.dataRoot,
    sessionKey: SESSION_KEY,
    epoch: 1,
    generation,
    text: 'CONTINUATION-TEXT',
    emitted: [emitted('hot-b', 'v1')],
    turn: 1,
    now: NOW,
  }
  const beforeAck = await prepareContinuationReceipt(continuationArgs)
  assert.equal(beforeAck.receipt, null)
  assert.equal(beforeAck.continuation.reason, 'unacknowledged')

  const fullAck = await ackDelivery({
    binding: env.binding,
    dataRoot: env.dataRoot,
    sessionKey: SESSION_KEY,
    epoch: 1,
    messageHash: prepared.receipt.messageHash,
    proof,
    producerKind: PRODUCER,
  })
  assert.equal(fullAck.acknowledged, true)
  assert.equal(fullAck.continuationAcknowledged, true)
  const acknowledged = await readDeliveryState({
    binding: env.binding,
    dataRoot: env.dataRoot,
    sessionKey: SESSION_KEY,
    epoch: 1,
  })
  assert.equal(acknowledged.state.continuation.acknowledged, true)

  const continuation = await prepareContinuationReceipt(continuationArgs)
  assert.equal(continuation.stale, false)
  assert.equal(continuation.receipt.offset, 1)
  const acked = await ackDelivery({
    binding: env.binding,
    dataRoot: env.dataRoot,
    sessionKey: SESSION_KEY,
    epoch: 1,
    messageHash: continuation.receipt.messageHash,
    proof,
    producerKind: PRODUCER,
  })
  assert.equal(acked.acknowledged, true)
  const read = await readDeliveryState({
    binding: env.binding,
    dataRoot: env.dataRoot,
    sessionKey: SESSION_KEY,
    epoch: 1,
  })
  assert.equal(read.state.continuation.offset, 2)
  assert.equal(read.state.continuation.acked, 1)
})

test('an unchanged generation stops after two acknowledged continuations', async (t) => {
  const env = await fixture(t)
  const generation = 'b'.repeat(64)
  const prepared = await prepare(env, {
    generation,
    emitted: [emitted('hot-a', 'v1')],
    candidates: 7,
  })
  assert.equal(prepared.continuation.available, true)
  // Two acknowledged continuations are an allowance; the creating full brief must
  // itself be acknowledged before the first of them is spendable.
  await ackDelivery({
    binding: env.binding,
    dataRoot: env.dataRoot,
    sessionKey: SESSION_KEY,
    epoch: 1,
    messageHash: prepared.receipt.messageHash,
    proof,
    producerKind: PRODUCER,
  })
  for (let i = 0; i < 3; i += 1) {
    const text = `C${i}`
    const cont = await prepareContinuationReceipt({
      binding: env.binding,
      dataRoot: env.dataRoot,
      sessionKey: SESSION_KEY,
      epoch: 1,
      generation: 'b'.repeat(64),
      text,
      emitted: [emitted(`hot-${i}`, 'v1')],
      turn: i + 1,
      now: NOW + i * 1000,
    })
    if (i < 2) {
      await ackDelivery({
        binding: env.binding,
        dataRoot: env.dataRoot,
        sessionKey: SESSION_KEY,
        epoch: 1,
        messageHash: cont.receipt.messageHash,
        proof,
        producerKind: PRODUCER,
      })
    }
  }
  const read = await readDeliveryState({
    binding: env.binding,
    dataRoot: env.dataRoot,
    sessionKey: SESSION_KEY,
    epoch: 1,
  })
  assert.equal(read.state.continuation.acked, 2)
  assert.equal(read.state.continuation.offset, 3)
  const third = await prepareContinuationReceipt({
    binding: env.binding,
    dataRoot: env.dataRoot,
    sessionKey: SESSION_KEY,
    epoch: 1,
    generation: 'g1',
    text: 'C-again',
    emitted: [emitted('hot-x', 'v1')],
    turn: 9,
    now: NOW + 9000,
  })
  assert.equal(third.receipt, null)
  assert.equal(third.continuation.available, false)
})

test('an unacknowledged full plan cannot be continued, and discarding its receipt clears the plan', async (t) => {
  const env = await fixture(t)
  const generation = 'c'.repeat(64)
  const prepared = await prepare(env, {
    generation,
    text: 'UNACKED-BRIEF',
    emitted: [emitted('hot-a', 'v1')],
    candidates: 5,
  })
  const blocked = await prepareContinuationReceipt({
    binding: env.binding,
    dataRoot: env.dataRoot,
    sessionKey: SESSION_KEY,
    epoch: 1,
    generation,
    text: 'NEVER-SENT',
    emitted: [emitted('hot-b', 'v1')],
    turn: 2,
    now: NOW,
  })
  assert.equal(blocked.receipt, null)
  assert.equal(blocked.continuation.reason, 'unacknowledged')

  // The message this plan belongs to is discarded (aborted/lost insertion): the
  // plan must not survive as a handle onto units nobody saw.
  const discarded = await discardDeliveryReceipt({
    binding: env.binding,
    dataRoot: env.dataRoot,
    sessionKey: SESSION_KEY,
    epoch: 1,
    messageHash: prepared.receipt.messageHash,
    home: env.home,
  })
  assert.equal(discarded.discarded, true)
  const read = await readDeliveryState({
    binding: env.binding,
    dataRoot: env.dataRoot,
    sessionKey: SESSION_KEY,
    epoch: 1,
  })
  assert.equal(read.state.continuation, null, 'a discarded full brief leaves no plan behind')
})

test('a second full preparation of the same generation rebases an unacknowledged plan on its own emitted prefix', async (t) => {
  const env = await fixture(t)
  const generation = 'd'.repeat(64)
  const first = await prepare(env, {
    generation,
    text: 'FIRST-ATTEMPT',
    emitted: [emitted('hot-a', 'v1')],
    candidates: 6,
  })
  assert.equal(first.continuation.offset, 1)
  const second = await prepare(env, {
    generation,
    text: 'SECOND-ATTEMPT',
    emitted: [emitted('hot-a', 'v1'), emitted('hot-b', 'v1')],
    candidates: 6,
  })
  // The first attempt was never observed, so its offset cannot be trusted; the
  // new message's prefix is the only observed position.
  assert.equal(second.continuation.acknowledged, false)
  assert.equal(second.continuation.offset, 2)
  assert.equal(second.continuation.available, true)
})

// ---------------------------------------------------------------------------
// Codex: structured transcript evidence
// ---------------------------------------------------------------------------

/** One Codex rollout line: a developer message carrying structured input_text. */
function developerLine(text) {
  return JSON.stringify({
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'developer',
      content: [{ type: 'input_text', text }],
    },
  })
}

/** One Codex rollout line: a tool output that quotes the same text. */
function toolOutputLine(text) {
  return JSON.stringify({
    type: 'response_item',
    payload: {
      type: 'function_call_output',
      output: { content: [{ type: 'output_text', text }] },
    },
  })
}

test('the transcript scan accepts only structured developer input_text messages', () => {
  const text = '<!-- obsidian-mem:brief mode=full -->\nBRIEF'
  const transcript = [developerLine(text), toolOutputLine(text), 'not json'].join('\n')
  const hashes = transcriptDeliveryHashes(transcript)
  assert.ok(hashes.has(sha256ForTest(text)))
  assert.equal(hashes.size, 1, 'quoted tool output cannot acknowledge')
})

test('a reconciled transcript acknowledges a pending receipt, and an over-cap transcript does not', async (t) => {
  const env = await fixture(t)
  const text = '<!-- obsidian-mem:brief mode=full -->\nBRIEF-BODY'
  const prepared = await prepare(env, { text })
  const transcript = developerLine(text)
  const unreadable = await reconcileTranscript({
    binding: env.binding,
    dataRoot: env.dataRoot,
    sessionKey: SESSION_KEY,
    epoch: 1,
    transcript,
    truncated: true,
    proofKind: 'transcript',
    producerKind: PRODUCER,
  })
  assert.equal(unreadable.reconciled.length, 0, 'an over-cap read is unacknowledged')

  const reconciled = await reconcileTranscript({
    binding: env.binding,
    dataRoot: env.dataRoot,
    sessionKey: SESSION_KEY,
    epoch: 1,
    transcript,
    truncated: false,
    proofKind: 'transcript',
    producerKind: PRODUCER,
  })
  assert.equal(reconciled.reconciled.length, 1)
  const read = await readDeliveryState({
    binding: env.binding,
    dataRoot: env.dataRoot,
    sessionKey: SESSION_KEY,
    epoch: 1,
  })
  assert.deepEqual(read.state.acked, { 'hot-a': prepared.receipt.emitted[0].version })
})

test('pending hashes are readable without exposing anything but hashes', async (t) => {
  const env = await fixture(t)
  const prepared = await prepare(env, { text: 'A-SECRET-BODY' })
  const pending = await pendingDeliveryHashes({
    binding: env.binding,
    dataRoot: env.dataRoot,
    sessionKey: SESSION_KEY,
    epoch: 1,
  })
  assert.deepEqual(pending.hashes, [prepared.receipt.messageHash])
  assert.equal(JSON.stringify(pending).includes('A-SECRET-BODY'), false)
})

/** The message hash rule the module owns, restated so the scan test cannot pass by accident. */
function sha256ForTest(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}
