// Task 7: project transactions, receipts and crash recovery.
//
// Everything below runs against REAL temporary filesystems and REAL
// `fsync`/`link`/`rename` semantics, because the guarantees under test are
// exactly the ones the filesystem provides. Two cases go further:
//
//   * a REAL second process is started, made to die in the middle of a
//     transaction, and recovered by this process — the lock it left behind is
//     only broken because its pid is gone;
//   * a REAL sparse file (`size > 0 && blocks === 0`) and a REAL unreadable file
//     (mode 000) prove that a failed read is never interpreted as an empty file.
//
// The only injected seam is `options.io` for a vault target read, used to
// produce an `EDEADLK` that a real filesystem cannot be asked to raise on
// demand; the sparse-file case next to it proves the same branch with real
// bytes. No `fs` mock is used anywhere.
//
// Fixtures never touch the real `~/.dsh`: every case passes an explicit
// throwaway `dataRoot` and a `vaultRoot` under `mkdtemp`.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import {
  bootstrapVault,
  findReceipt,
  listPendingIndexNotifications,
  LOG_RELATIVE_PATH,
  markIndexNotified,
  newTransactionId,
  parseRegistryMarkdown,
  recoverTransactions,
  renderRegistryDocument,
  runTransaction,
  TransactionError,
} from '../lib/vault.js'

const execFileAsync = promisify(execFile)

/** Fixed identities. Both are valid UUIDv4 values (version nibble `4`). */
const ID_A = '1c392abb-7b08-42f7-871d-2a379caf9448'
const ID_B = '5f0e6d1c-9a4b-4c2d-8e3f-0b7a6c5d4e3f'
const PROJECT_A = `项目/alpha--${ID_A.slice(0, 8)}`
const PROJECT_B = `项目/beta--${ID_B.slice(0, 8)}`

/** Vault-relative paths used by nearly every case. */
const REGISTRY = '_meta/项目注册表.md'
const HISTORY_ROOT = '_meta/.history'
const NEW_NOTE = `${PROJECT_A}/决策/ADR-1-调度器.md`
const STATUS_NOTE = `${PROJECT_A}/决策/ADR-0-旧决策.md`
const MOC = `${PROJECT_A}/决策/index.md`

const NEW_NOTE_TEXT = '---\nid: "dec-11111111-1111-4111-8111-111111111111"\ntype: "decision"\ntitle: "调度器改为可插拔后端"\nstatus: "accepted"\nupdated: 2026-09-23\n---\n采用 A，理由见正文。\n'
const STATUS_BEFORE = '---\nid: "dec-00000000-0000-4000-8000-000000000001"\ntype: "decision"\ntitle: "旧决策"\nstatus: "accepted"\nupdated: 2026-09-23\n---\n旧正文\n'
const STATUS_AFTER = STATUS_BEFORE.replace('"accepted"', '"superseded"')
const MOC_BEFORE = '---\nid: "hub-00000000-0000-4000-8000-000000000002"\ntype: "hub"\ntitle: "决策"\nupdated: 2026-09-23\n---\n# 决策\n\n<!-- obsidian-mem:generated begin sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 -->\n<!-- obsidian-mem:generated end -->\n'
const MOC_AFTER = `${MOC_BEFORE}\n- [[${PROJECT_A}/决策/ADR-1-调度器|调度器改为可插拔后端]]\n`

const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const at = (vault, relative) => join(vault, ...relative.split('/'))

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'obsidian-mem-t7-'))
  const dataRoot = await mkdtemp(join(tmpdir(), 'obsidian-mem-t7-data-'))
  t.after(() => Promise.all([
    rm(root, { recursive: true, force: true, maxRetries: 4 }),
    rm(dataRoot, { recursive: true, force: true, maxRetries: 4 }),
  ]))
  const vault = join(root, 'vault')
  await mkdir(join(vault, '_meta'), { recursive: true })
  await mkdir(join(vault, PROJECT_A, '决策'), { recursive: true })
  await mkdir(join(vault, PROJECT_A, '_meta'), { recursive: true })
  await mkdir(join(vault, PROJECT_B, '决策'), { recursive: true })
  await writeFile(at(vault, STATUS_NOTE), STATUS_BEFORE)
  await writeFile(at(vault, MOC), MOC_BEFORE)
  await writeFile(at(vault, REGISTRY), renderRegistryDocument([]))
  return {
    root,
    dataRoot,
    vault,
    bindingA: binding(vault, ID_A, 'alpha'),
    bindingB: binding(vault, ID_B, 'beta'),
  }
}

/** A binding shaped like `resolveBinding`'s, without needing a git repository. */
function binding(vaultRoot, projectId, slug) {
  return {
    kind: 'bound',
    projectId,
    slug,
    displayName: slug,
    schema: 1,
    vaultRoot,
    relativeDir: `项目/${slug}--${projectId.slice(0, 8)}`,
  }
}

/** The standard write: one new note, one status update, one MOC update, one receipt. */
function request(txId, overrides = {}) {
  return {
    txId,
    creates: [{ path: NEW_NOTE, contents: NEW_NOTE_TEXT }],
    updates: [
      { path: STATUS_NOTE, hash: sha256(STATUS_BEFORE), contents: STATUS_AFTER },
      { path: MOC, hash: sha256(MOC_BEFORE), contents: MOC_AFTER },
    ],
    receipt: { action: 'write', sessionId: 'sess-1', fromSeq: 3, toSeq: 9 },
    ...overrides,
  }
}

async function readOrNull(path) {
  try {
    return await readFile(path)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

async function historyEntries(vault, txId) {
  try {
    return (await readdir(at(vault, `${HISTORY_ROOT}/${txId}`))).sort()
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

const countOf = (haystack, needle) => String(haystack).split(needle).length - 1

// ---------------------------------------------------------------------------
// Step 1: the happy path and the receipt contract
// ---------------------------------------------------------------------------

test('a transaction publishes creates and updates and appends exactly one receipt', async (t) => {
  const { vault, dataRoot, bindingA } = await fixture(t)
  const txId = newTransactionId()

  const receipt = await runTransaction(bindingA, request(txId), { dataRoot })

  // the receipt describes the transaction, the paths and both byte revisions
  assert.equal(receipt.txId, txId)
  assert.equal(receipt.action, 'write')
  assert.equal(receipt.sessionId, 'sess-1')
  assert.equal(receipt.fromSeq, 3)
  assert.equal(receipt.toSeq, 9)
  assert.equal(receipt.idempotencyKey, null)
  assert.equal(receipt.result.status, 'applied')
  assert.deepEqual(receipt.result, { status: 'applied', created: 1, updated: 2, skipped: 0, index: 'queued', stored: true })
  assert.deepEqual(receipt.paths, [NEW_NOTE, STATUS_NOTE, MOC])
  assert.deepEqual(receipt.beforeHashes, {
    [NEW_NOTE]: null,
    [STATUS_NOTE]: sha256(STATUS_BEFORE),
    [MOC]: sha256(MOC_BEFORE),
  })
  assert.deepEqual(receipt.afterHashes, {
    [NEW_NOTE]: sha256(NEW_NOTE_TEXT),
    [STATUS_NOTE]: sha256(STATUS_AFTER),
    [MOC]: sha256(MOC_AFTER),
  })
  assert.match(receipt.at, /^\d{4}-\d{2}-\d{2}T/)

  // the vault really changed, and the log gained one entry
  assert.equal(await readFile(at(vault, NEW_NOTE), 'utf8'), NEW_NOTE_TEXT)
  assert.equal(await readFile(at(vault, STATUS_NOTE), 'utf8'), STATUS_AFTER)
  assert.equal(await readFile(at(vault, MOC), 'utf8'), MOC_AFTER)
  const log = await readFile(at(vault, LOG_RELATIVE_PATH), 'utf8')
  assert.equal(countOf(log, txId), 1)
  assert.equal(countOf(log, STATUS_NOTE), 1)

  // the index notification is durably queued until a notifier drains it
  assert.deepEqual((await listPendingIndexNotifications(bindingA, { dataRoot })).map((n) => n.txId), [txId])
  assert.equal(await markIndexNotified(bindingA, { dataRoot, txId }), true)
  assert.deepEqual(await listPendingIndexNotifications(bindingA, { dataRoot }), [])
  assert.equal(await markIndexNotified(bindingA, { dataRoot, txId }), false)
})

test('a notifier that succeeds drains the queue inside runTransaction', async (t) => {
  const { dataRoot, bindingA } = await fixture(t)
  const txId = newTransactionId()
  const seen = []
  const receipt = await runTransaction(bindingA, request(txId), {
    dataRoot,
    notifyIndex: async (value) => { seen.push(value.txId) },
  })
  assert.deepEqual(seen, [txId])
  assert.equal(receipt.result.index, 'notified')
  assert.deepEqual(await listPendingIndexNotifications(bindingA, { dataRoot }), [])
})

test('a failing notifier marks the receipt stale without undoing the vault write', async (t) => {
  const { vault, dataRoot, bindingA } = await fixture(t)
  const txId = newTransactionId()
  const receipt = await runTransaction(bindingA, request(txId), {
    dataRoot,
    notifyIndex: async () => { throw Object.assign(new Error('index offline'), { code: 'EIO' }) },
  })
  assert.equal(receipt.result.index, 'stale')
  assert.equal(await readFile(at(vault, STATUS_NOTE), 'utf8'), STATUS_AFTER)
  assert.deepEqual((await listPendingIndexNotifications(bindingA, { dataRoot })).map((n) => n.txId), [txId])
})

// ---------------------------------------------------------------------------
// Step 1: idempotency
// ---------------------------------------------------------------------------

test('a repeated idempotencyKey returns the original receipt and writes nothing', async (t) => {
  const { vault, dataRoot, bindingA, bindingB } = await fixture(t)
  const key = 'sess-1:3:0'
  const first = await runTransaction(bindingA, request(newTransactionId(), { idempotencyKey: key }), { dataRoot })
  const logBefore = await stat(at(vault, LOG_RELATIVE_PATH))
  const noteBefore = await stat(at(vault, NEW_NOTE))

  // a different txId, the same key: the original receipt comes back untouched
  const second = await runTransaction(bindingA, request(newTransactionId(), { idempotencyKey: key }), { dataRoot })
  assert.deepEqual(second, first)
  assert.equal((await stat(at(vault, LOG_RELATIVE_PATH))).mtimeMs, logBefore.mtimeMs)
  assert.equal((await stat(at(vault, NEW_NOTE))).mtimeMs, noteBefore.mtimeMs)
  assert.equal(countOf(await readFile(at(vault, LOG_RELATIVE_PATH), 'utf8'), first.txId), 1)

  assert.deepEqual(await findReceipt(bindingA, key, { dataRoot }), first)
  assert.equal(await findReceipt(bindingA, 'never-used', { dataRoot }), null)
  // receipts are scoped to the project that wrote them
  assert.equal(await findReceipt(bindingB, key, { dataRoot }), null)
})

// ---------------------------------------------------------------------------
// Step 1: the fault-injection matrix
// ---------------------------------------------------------------------------

/**
 * Every interruption point the brief names, and what recovery must produce:
 * `rollback` restores the old bytes and moves the create into `.history/`,
 * `committed` keeps the fully applied transaction and only has to notify.
 */
const FAULT_POINTS = [
  ['new-note', 'rollback'],
  ['old-status', 'rollback'],
  ['moc', 'rollback'],
  ['receipt', 'rollback'],
  ['receipt-store', 'committed'],
  ['index-notify', 'committed'],
]

for (const [failAfter, outcome] of FAULT_POINTS) {
  test(`an interruption after ${failAfter} recovers to ${outcome}`, async (t) => {
    const { vault, dataRoot, bindingA } = await fixture(t)
    const txId = newTransactionId()
    const key = `fault-key-${failAfter}`

    await assert.rejects(
      runTransaction(bindingA, request(txId, { idempotencyKey: key }), { dataRoot, failAfter }),
      (error) => error instanceof TransactionError && error.code === 'injected-failure',
      `failAfter:${failAfter} must interrupt the transaction`,
    )

    const report = await recoverTransactions(bindingA, { dataRoot })
    assert.deepEqual(report.unresolved, [], `recovery must resolve itself: ${JSON.stringify(report.unresolved)}`)
    assert.equal(report.scanned, 1)

    if (outcome === 'rollback') {
      // either the whole transaction succeeded or the old bytes are back
      assert.deepEqual(report.rolledBack, [txId])
      assert.equal(report.committed.length, 0)
      assert.equal(await findReceipt(bindingA, key, { dataRoot }), null, 'a rolled-back transaction must not answer its key')
      assert.equal(await exists(at(vault, NEW_NOTE)), false, 'a freshly created file must not survive a rollback')
      assert.equal(await readFile(at(vault, STATUS_NOTE), 'utf8'), STATUS_BEFORE)
      assert.equal(await readFile(at(vault, MOC), 'utf8'), MOC_BEFORE)
      assert.equal(await exists(at(vault, LOG_RELATIVE_PATH)), false, 'no receipt may survive a rollback')

      // the created note is quarantined under `.history/<txId>/`, not deleted
      const entries = await historyEntries(vault, txId)
      const quarantined = entries.filter((name) => name.endsWith('ADR-1-调度器.md'))
      assert.equal(quarantined.length, 1, `expected the created note under ${HISTORY_ROOT}/${txId}: ${entries}`)
      assert.equal(await readFile(at(vault, `${HISTORY_ROOT}/${txId}/${quarantined[0]}`), 'utf8'), NEW_NOTE_TEXT)
      // the pre-transaction bytes of every updated file survive as a snapshot
      const snapshot = entries.find((name) => name.endsWith('ADR-0-旧决策.md'))
      assert.ok(snapshot, `expected a snapshot of ${STATUS_NOTE}: ${entries}`)
      assert.equal(await readFile(at(vault, `${HISTORY_ROOT}/${txId}/${snapshot}`), 'utf8'), STATUS_BEFORE)
      assert.ok(entries.includes('manifest.json'), 'the recovery material keeps a manifest copy')

      // a retry applies the transaction once — no duplicated note, no doubled receipt
      const retryKey = 'retry-of-a-rolled-back-transaction'
      const retryTxId = newTransactionId()
      const retry = await runTransaction(bindingA, request(retryTxId, { idempotencyKey: retryKey }), { dataRoot })
      assert.equal(retry.result.status, 'applied')
      assert.equal(await readFile(at(vault, STATUS_NOTE), 'utf8'), STATUS_AFTER)
      assert.equal(await readFile(at(vault, NEW_NOTE), 'utf8'), NEW_NOTE_TEXT)
      const log = await readFile(at(vault, LOG_RELATIVE_PATH), 'utf8')
      assert.equal(countOf(log, retryTxId), 1, 'the retry must append exactly one receipt')
      assert.equal(countOf(log, retryKey), 1)
      assert.equal(countOf(log, txId), 0, 'the rolled-back transaction must leave no receipt')
      assert.equal(await exists(at(vault, `${HISTORY_ROOT}/${txId}`)), true, 'history is kept as an audit trail')
    } else {
      // the receipt was already durable, so recovery only finishes the commit
      assert.deepEqual(report.committed, [txId])
      assert.deepEqual(report.rolledBack, [])
      assert.equal(await readFile(at(vault, NEW_NOTE), 'utf8'), NEW_NOTE_TEXT)
      assert.equal(await readFile(at(vault, STATUS_NOTE), 'utf8'), STATUS_AFTER)
      assert.equal(await readFile(at(vault, MOC), 'utf8'), MOC_AFTER)
      assert.equal(countOf(await readFile(at(vault, LOG_RELATIVE_PATH), 'utf8'), txId), 1)
      // the machine receipt the crash may have swallowed is completed by recovery
      const stored = await findReceipt(bindingA, key, { dataRoot })
      assert.equal(stored?.txId, txId)
      assert.equal(stored?.result.status, 'applied')
      // a committed transaction keeps the pre-write snapshots as history
      const committedEntries = await historyEntries(vault, txId)
      const committedSnapshot = committedEntries.find((name) => name.endsWith('ADR-0-旧决策.md'))
      assert.ok(committedSnapshot, `expected a pre-write snapshot: ${committedEntries}`)
      assert.equal(await readFile(at(vault, `${HISTORY_ROOT}/${txId}/${committedSnapshot}`), 'utf8'), STATUS_BEFORE)
      // ...but not a copy of the append-only receipt log, whose every earlier
      // revision is already a prefix of the file on disk
      assert.equal(committedEntries.some((name) => name.endsWith('log.md')), false)

      // the index notification the crash swallowed is still queued and drainable
      assert.deepEqual(report.pendingIndexNotifications.map((entry) => entry.txId), [txId])
      const drained = []
      const second = await recoverTransactions(bindingA, {
        dataRoot,
        notifyIndex: async (value) => { drained.push(value.txId) },
      })
      assert.deepEqual(drained, [txId])
      assert.deepEqual(second.pendingIndexNotifications, [])
      assert.deepEqual(second.unresolved, [])
      assert.deepEqual(await listPendingIndexNotifications(bindingA, { dataRoot }), [])
    }
  })
}

test('recovery of a clean vault reports nothing to do', async (t) => {
  const { dataRoot, bindingA } = await fixture(t)
  const report = await recoverTransactions(bindingA, { dataRoot })
  assert.deepEqual(report, {
    vaultHash: report.vaultHash,
    scanned: 0,
    committed: [],
    rolledBack: [],
    discarded: [],
    unresolved: [],
    pendingIndexNotifications: [],
  })
  assert.match(report.vaultHash, /^[0-9a-f]{64}$/)
})

// ---------------------------------------------------------------------------
// Step 1: byte-equal writes are skipped
// ---------------------------------------------------------------------------

test('an update whose bytes already match is skipped and keeps the mtime', async (t) => {
  const { vault, dataRoot, bindingA } = await fixture(t)
  const before = await stat(at(vault, STATUS_NOTE))

  const receipt = await runTransaction(bindingA, {
    txId: newTransactionId(),
    updates: [{ path: STATUS_NOTE, hash: sha256(STATUS_BEFORE), contents: STATUS_BEFORE }],
    receipt: null,
  }, { dataRoot })

  assert.deepEqual(receipt.result, { status: 'no-op', created: 0, updated: 0, skipped: 1, index: 'queued', stored: true })
  assert.equal(await readFile(at(vault, STATUS_NOTE), 'utf8'), STATUS_BEFORE)
  assert.equal((await stat(at(vault, STATUS_NOTE))).mtimeMs, before.mtimeMs, 'a semantic no-op must not touch the mtime')
  assert.equal(await exists(at(vault, LOG_RELATIVE_PATH)), false)
  assert.equal(await exists(at(vault, HISTORY_ROOT)), false, 'a skipped target is never staged')
})

test('a transform that returns null is a no-op too', async (t) => {
  const { vault, dataRoot, bindingA } = await fixture(t)
  const before = await stat(at(vault, MOC))
  const receipt = await runTransaction(bindingA, {
    txId: newTransactionId(),
    updates: [{ path: MOC, transform: (current) => (current.equals(Buffer.from(MOC_BEFORE)) ? null : 'changed') }],
    receipt: null,
  }, { dataRoot })
  assert.equal(receipt.result.skipped, 1)
  assert.equal((await stat(at(vault, MOC))).mtimeMs, before.mtimeMs)
})

// ---------------------------------------------------------------------------
// Step 1: a failed read is never an empty file
// ---------------------------------------------------------------------------

test('an unreadable target is refused instead of being treated as empty', async (t) => {
  if (process.getuid?.() === 0) t.skip('root ignores file permissions')
  const { vault, dataRoot, bindingA } = await fixture(t)
  await chmod(at(vault, STATUS_NOTE), 0o000)

  await assert.rejects(
    runTransaction(bindingA, request(newTransactionId()), { dataRoot }),
    (error) => error instanceof TransactionError && error.code === 'unreadable-target',
  )
  // nothing was published, not even the create that came first in the plan
  assert.equal(await exists(at(vault, NEW_NOTE)), false)
  assert.equal(await readFile(at(vault, MOC), 'utf8'), MOC_BEFORE)
  await chmod(at(vault, STATUS_NOTE), 0o644)
})

test('EDEADLK pauses the target instead of reading it as empty', async (t) => {
  const { vault, dataRoot, bindingA } = await fixture(t)
  const deadlock = Object.assign(new Error('Resource deadlock avoided'), { code: 'EDEADLK' })

  await assert.rejects(
    runTransaction(bindingA, request(newTransactionId()), {
      dataRoot,
      io: { readFile: async () => { throw deadlock } },
    }),
    (error) => error instanceof TransactionError
      && error.code === 'unreadable-target'
      && error.transient === true
      && /EDEADLK/.test(error.message),
  )
  assert.equal(await exists(at(vault, NEW_NOTE)), false)
  assert.equal(await readFile(at(vault, STATUS_NOTE), 'utf8'), STATUS_BEFORE)
  assert.equal(await readFile(at(vault, MOC), 'utf8'), MOC_BEFORE)
})

test('a real size>0 && blocks===0 file is refused as offloaded', async (t) => {
  const { vault, dataRoot, bindingA } = await fixture(t)
  // An empty file extended to 4096 bytes stays a real sparse APFS file: size 4096, blocks 0.
  await writeFile(at(vault, STATUS_NOTE), '')
  const handle = await open(at(vault, STATUS_NOTE), 'r+')
  await handle.truncate(4096)
  await handle.close()
  const sparse = await stat(at(vault, STATUS_NOTE))
  assert.equal(sparse.size, 4096)
  assert.equal(sparse.blocks, 0, 'the fixture must really be a sparse file')

  await assert.rejects(
    runTransaction(bindingA, {
      txId: newTransactionId(),
      updates: [{ path: STATUS_NOTE, hash: sha256(Buffer.alloc(4096)), contents: 'replacement' }],
    }, { dataRoot }),
    (error) => error instanceof TransactionError && error.code === 'offloaded-file',
  )
  assert.equal((await stat(at(vault, STATUS_NOTE))).size, 4096, 'the offloaded file must be left exactly as it was')
  assert.equal(await exists(at(vault, LOG_RELATIVE_PATH)), false)
})

// ---------------------------------------------------------------------------
// Step 1: an external edit is never overwritten
// ---------------------------------------------------------------------------

test('an external edit survives rollback and stops further automatic writes', async (t) => {
  const { vault, dataRoot, bindingA } = await fixture(t)
  const txId = newTransactionId()
  await assert.rejects(
    runTransaction(bindingA, request(txId), { dataRoot, failAfter: 'moc' }),
    { code: 'injected-failure' },
  )

  // the human edits the status note after this transaction wrote it
  const external = `${STATUS_BEFORE}\n外部编辑：在 Obsidian 里手写的补充。\n`
  await writeFile(at(vault, STATUS_NOTE), external)

  const report = await recoverTransactions(bindingA, { dataRoot })
  assert.equal(report.rolledBack.includes(txId), false)
  assert.equal(report.unresolved.length, 1)
  assert.equal(report.unresolved[0].txId, txId)
  assert.equal(report.unresolved[0].reason, 'external-edit')
  assert.deepEqual(report.unresolved[0].paths, [STATUS_NOTE])

  // both contents exist: the external edit at its path, the snapshot in history
  assert.equal(await readFile(at(vault, STATUS_NOTE), 'utf8'), external)
  const entries = await historyEntries(vault, txId)
  const snapshot = entries.find((name) => name.endsWith('ADR-0-旧决策.md'))
  assert.equal(await readFile(at(vault, `${HISTORY_ROOT}/${txId}/${snapshot}`), 'utf8'), STATUS_BEFORE)
  // the manifest copy records the unresolved state for a human to inspect
  const copy = JSON.parse(await readFile(at(vault, `${HISTORY_ROOT}/${txId}/manifest.json`), 'utf8'))
  assert.equal(copy.state, 'needs-manual-repair')
  assert.equal(copy.txId, txId)

  // the targets that were NOT edited are still restored, and the create quarantined
  assert.equal(await readFile(at(vault, MOC), 'utf8'), MOC_BEFORE)
  assert.equal(await exists(at(vault, NEW_NOTE)), false)

  // automatic writes stop until a human resolves the conflict — twice in a row
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(
      runTransaction(bindingA, request(newTransactionId()), { dataRoot }),
      (error) => error instanceof TransactionError && error.code === 'recovery-required',
    )
  }
  assert.equal(await readFile(at(vault, STATUS_NOTE), 'utf8'), external)
})

test('an external edit detected before publishing refuses without touching the file', async (t) => {
  const { vault, dataRoot, bindingA } = await fixture(t)
  const external = `${STATUS_BEFORE}\n（外部改动）\n`
  await writeFile(at(vault, STATUS_NOTE), external)

  await assert.rejects(
    runTransaction(bindingA, request(newTransactionId()), { dataRoot }),
    (error) => error instanceof TransactionError && error.code === 'hash-mismatch',
  )
  assert.equal(await readFile(at(vault, STATUS_NOTE), 'utf8'), external)
  assert.equal(await exists(at(vault, NEW_NOTE)), false)
  assert.equal(await exists(at(vault, LOG_RELATIVE_PATH)), false)
})

test('an interruption between publishing a file and journaling it still rolls back', async (t) => {
  // The narrowest window in the protocol: the bytes are in the vault, the
  // manifest does not say so yet. Recovery must derive the publication from the
  // disk (a consumed staging file, or a create whose hash matches this run).
  const { vault, dataRoot, bindingA } = await fixture(t)

  // (a) a create: `link` published it, the unlink/marker never happened
  const createTxId = newTransactionId()
  await assert.rejects(
    runTransaction(bindingA, request(createTxId), { dataRoot, failAfter: 'publish' }),
    { code: 'injected-failure' },
  )
  assert.equal(await readFile(at(vault, NEW_NOTE), 'utf8'), NEW_NOTE_TEXT, 'the fixture must really have published it')
  let report = await recoverTransactions(bindingA, { dataRoot })
  assert.deepEqual(report.unresolved, [])
  assert.deepEqual(report.rolledBack, [createTxId])
  assert.equal(await exists(at(vault, NEW_NOTE)), false)
  assert.equal(await readFile(at(vault, STATUS_NOTE), 'utf8'), STATUS_BEFORE)

  // (b) an update: `rename` replaced it, the marker never happened
  const updateTxId = newTransactionId()
  await assert.rejects(
    runTransaction(bindingA, {
      txId: updateTxId,
      updates: [{ path: MOC, hash: sha256(MOC_BEFORE), contents: MOC_AFTER }],
      receipt: null,
    }, { dataRoot, failAfter: 'publish' }),
    { code: 'injected-failure' },
  )
  assert.equal(await readFile(at(vault, MOC), 'utf8'), MOC_AFTER, 'the fixture must really have replaced it')
  report = await recoverTransactions(bindingA, { dataRoot })
  assert.deepEqual(report.unresolved, [])
  assert.deepEqual(report.rolledBack, [updateTxId])
  assert.equal(await readFile(at(vault, MOC), 'utf8'), MOC_BEFORE)
  assert.equal(await exists(at(vault, LOG_RELATIVE_PATH)), false)
})

test('a crash during a rollback resumes instead of reporting a conflict', async (t) => {
  const { vault, dataRoot, bindingA } = await fixture(t)
  const txId = newTransactionId()
  await assert.rejects(runTransaction(bindingA, request(txId), { dataRoot, failAfter: 'moc' }), { code: 'injected-failure' })

  // Simulate a rollback that restored the status note and then died before it
  // could journal that: the target holds its pre-transaction bytes again.
  await writeFile(at(vault, STATUS_NOTE), STATUS_BEFORE)
  const report = await recoverTransactions(bindingA, { dataRoot })
  assert.deepEqual(report.unresolved, [], 'an already-restored target is not a conflict')
  assert.deepEqual(report.rolledBack, [txId])
  assert.equal(await readFile(at(vault, MOC), 'utf8'), MOC_BEFORE)
  assert.equal(await exists(at(vault, NEW_NOTE)), false)
})

// ---------------------------------------------------------------------------
// Step 4: an unreadable target is a conflict during rollback, never "absent"
// ---------------------------------------------------------------------------

test('an unreadable target during rollback is a conflict, never "already undone"', async (t) => {
  // Review finding: `readGuarded` throwing left `current` null, and for a create
  // "current === null" was read as "already quarantined". Recovery then reported
  // a clean rollback while the created note was still in the vault.
  const deadlock = Object.assign(new Error('Resource deadlock avoided'), { code: 'EDEADLK' })

  // (a) injected through the documented read seam, on the one published target
  {
    const { vault, dataRoot, bindingA } = await fixture(t)
    const txId = newTransactionId()
    await assert.rejects(
      runTransaction(bindingA, request(txId), { dataRoot, failAfter: 'new-note' }),
      { code: 'injected-failure' },
    )
    assert.equal(await exists(at(vault, NEW_NOTE)), true)

    const report = await recoverTransactions(bindingA, { dataRoot, io: { readFile: async () => { throw deadlock } } })
    assert.equal(report.rolledBack.includes(txId), false, 'an unreadable target must not be reported as rolled back')
    assert.equal(report.unresolved.length, 1)
    assert.equal(report.unresolved[0].txId, txId)
    assert.equal(report.unresolved[0].reason, 'unreadable-target')
    assert.deepEqual(report.unresolved[0].paths, [NEW_NOTE])
    assert.equal(await exists(at(vault, NEW_NOTE)), true, 'a failed read is never an absent file')
    assert.equal(await exists(join(dataRoot, 'transactions', report.vaultHash, `${txId}.json`)), true, 'the manifest must survive')

    // the conflict is sticky: a readable retry cannot make it disappear unnoticed
    const again = await recoverTransactions(bindingA, { dataRoot })
    assert.equal(again.unresolved.length, 1)
    assert.equal(again.unresolved[0].reason, 'needs-manual-repair')
    await assert.rejects(
      runTransaction(bindingA, request(newTransactionId()), { dataRoot }),
      (error) => error instanceof TransactionError && error.code === 'recovery-required',
    )
  }

  // (b) the same rule with a real filesystem failure
  if (process.getuid?.() !== 0) {
    const { vault, dataRoot, bindingA } = await fixture(t)
    const txId = newTransactionId()
    await assert.rejects(runTransaction(bindingA, request(txId), { dataRoot, failAfter: 'moc' }), { code: 'injected-failure' })
    await chmod(at(vault, NEW_NOTE), 0o000)

    const report = await recoverTransactions(bindingA, { dataRoot })
    assert.equal(report.rolledBack.includes(txId), false)
    assert.equal(report.unresolved.length, 1)
    assert.equal(report.unresolved[0].reason, 'unreadable-target')
    assert.deepEqual(report.unresolved[0].paths, [NEW_NOTE])
    assert.equal(await exists(at(vault, NEW_NOTE)), true)
    // the readable targets of the same transaction were still restored
    assert.equal(await readFile(at(vault, MOC), 'utf8'), MOC_BEFORE)
    assert.equal(await readFile(at(vault, STATUS_NOTE), 'utf8'), STATUS_BEFORE)
    await chmod(at(vault, NEW_NOTE), 0o644)
  }
})

// ---------------------------------------------------------------------------
// Step 4: a committed transaction rolls forward, even when its receipt store fails
// ---------------------------------------------------------------------------

test('a receipt-store failure after the commit point rolls forward, never back', async (t) => {
  if (process.getuid?.() === 0) t.skip('root ignores the read-only receipt directory')
  const { vault, dataRoot, bindingA } = await fixture(t)
  // A real, deterministic failure: the receipt store's directory exists but may
  // not be written. The pre-flight lookup still reports "no receipt yet" (ENOENT
  // inside a searchable directory), so only the post-commit store fails.
  const receiptDirectory = join(dataRoot, 'receipts', sha256(await realpath(vault)), ID_A)
  await mkdir(receiptDirectory, { recursive: true })
  await chmod(receiptDirectory, 0o500)

  const txId = newTransactionId()
  const key = 'store-failure'
  const receipt = await runTransaction(bindingA, request(txId, { idempotencyKey: key }), { dataRoot })

  // the transaction committed and tells the caller its receipt is not stored yet
  assert.equal(receipt.result.status, 'applied')
  assert.equal(receipt.result.stored, false)
  assert.equal(await readFile(at(vault, STATUS_NOTE), 'utf8'), STATUS_AFTER, 'a committed vault write must never be undone')
  assert.equal(await readFile(at(vault, NEW_NOTE), 'utf8'), NEW_NOTE_TEXT)
  assert.equal(countOf(await readFile(at(vault, LOG_RELATIVE_PATH), 'utf8'), txId), 1)
  // the log snapshot was pruned before the failure, so a rollback here would have
  // failed on a missing snapshot while the committed log entry stayed
  assert.equal((await historyEntries(vault, txId)).some((name) => name.endsWith('log.md')), false)
  assert.deepEqual((await listPendingIndexNotifications(bindingA, { dataRoot })).map((entry) => entry.txId), [txId])

  // recovery completes the receipt store, and the key then replays without re-applying
  await chmod(receiptDirectory, 0o700)
  const report = await recoverTransactions(bindingA, { dataRoot })
  assert.deepEqual(report.unresolved, [])
  assert.deepEqual(report.committed, [txId])
  const stored = await findReceipt(bindingA, key, { dataRoot })
  assert.equal(stored.txId, txId)
  assert.equal(stored.result.stored, true)

  const before = await stat(at(vault, LOG_RELATIVE_PATH))
  const replay = await runTransaction(bindingA, request(newTransactionId(), { idempotencyKey: key }), { dataRoot })
  assert.equal(replay.txId, txId)
  assert.equal((await stat(at(vault, LOG_RELATIVE_PATH))).mtimeMs, before.mtimeMs, 'a replay must not re-apply')
})

test('a delivered notification still keeps the manifest until the receipt is stored', async (t) => {
  if (process.getuid?.() === 0) t.skip('root ignores the read-only receipt directory')
  const { vault, dataRoot, bindingA } = await fixture(t)
  const receiptDirectory = join(dataRoot, 'receipts', sha256(await realpath(vault)), ID_A)
  await mkdir(receiptDirectory, { recursive: true })
  await chmod(receiptDirectory, 0o500)

  const txId = newTransactionId()
  const key = 'delivered-but-unstored'
  const notified = []
  const receipt = await runTransaction(bindingA, request(txId, { idempotencyKey: key }), {
    dataRoot,
    notifyIndex: async (value) => { notified.push(value.txId) },
  })
  assert.deepEqual(notified, [txId])
  assert.equal(receipt.result.index, 'notified')
  assert.equal(receipt.result.stored, false)

  // the manifest is the only copy of the receipt, so it is not dropped
  const manifestPath = join(dataRoot, 'transactions', sha256(await realpath(vault)), `${txId}.json`)
  assert.equal(await exists(manifestPath), true)
  assert.equal(await markIndexNotified(bindingA, { dataRoot, txId }), false, 'a manifest that still owes the receipt store is never dropped')
  assert.equal(await exists(manifestPath), true)

  await chmod(receiptDirectory, 0o700)
  const report = await recoverTransactions(bindingA, { dataRoot })
  assert.deepEqual(report.unresolved, [])
  assert.deepEqual(report.committed, [txId])
  assert.equal((await findReceipt(bindingA, key, { dataRoot })).result.stored, true)
  assert.equal(await exists(manifestPath), false, 'the manifest is dropped once nothing is owed')
})

test('a txId whose history already exists is refused instead of overwritten', async (t) => {
  const { vault, dataRoot, bindingA } = await fixture(t)
  const txId = newTransactionId()
  await assert.rejects(runTransaction(bindingA, request(txId), { dataRoot, failAfter: 'new-note' }), { code: 'injected-failure' })
  await recoverTransactions(bindingA, { dataRoot })
  assert.ok((await historyEntries(vault, txId)).some((name) => name.endsWith('ADR-1-调度器.md')), 'the create was quarantined')

  await assert.rejects(
    runTransaction(bindingA, request(txId), { dataRoot }),
    (error) => error instanceof TransactionError && error.code === 'txid-in-use',
  )
  // reusing the id did not delete the quarantine
  assert.ok((await historyEntries(vault, txId)).some((name) => name.endsWith('ADR-1-调度器.md')))
})

// ---------------------------------------------------------------------------
// Step 4: two projects writing the shared files at once
// ---------------------------------------------------------------------------

test('two projects writing the registry and the log at once lose no update', async (t) => {
  const { vault, dataRoot, bindingA, bindingB } = await fixture(t)
  const addRow = (row) => (current) => {
    const rows = current === null ? [] : parseRegistryMarkdown(current.toString('utf8')).rows
    return renderRegistryDocument([...rows, row])
  }

  const txA = {
    txId: newTransactionId(),
    updates: [{ path: REGISTRY, transform: addRow({ projectId: ID_A, dir: PROJECT_A, displayName: 'Alpha', remote: '' }) }],
    receipt: { action: 'bootstrap' },
  }
  const txB = {
    txId: newTransactionId(),
    updates: [{ path: REGISTRY, transform: addRow({ projectId: ID_B, dir: PROJECT_B, displayName: 'Beta', remote: '' }) }],
    receipt: { action: 'bootstrap' },
  }

  const receipts = await Promise.all([
    runTransaction(bindingA, txA, { dataRoot }),
    runTransaction(bindingB, txB, { dataRoot }),
  ])
  assert.deepEqual(receipts.map((receipt) => receipt.result.status), ['applied', 'applied'])

  const { rows } = parseRegistryMarkdown(await readFile(at(vault, REGISTRY), 'utf8'))
  assert.deepEqual(rows.map((row) => row.projectId).sort(), [ID_A, ID_B].sort())
  assert.deepEqual(rows.map((row) => row.dir).sort(), [PROJECT_A, PROJECT_B].sort())

  const log = await readFile(at(vault, LOG_RELATIVE_PATH), 'utf8')
  assert.equal(countOf(log, txA.txId), 1)
  assert.equal(countOf(log, txB.txId), 1, 'the second writer must not overwrite the first receipt')
})

test('two projects binding at once both land their registry row', async (t) => {
  const { root, vault, dataRoot, bindingA, bindingB } = await fixture(t)
  const results = await Promise.all([
    bootstrapVault(bindingA, { initGitOnCreate: false, home: root, dataRoot }),
    bootstrapVault(bindingB, { initGitOnCreate: false, home: root, dataRoot }),
  ])
  assert.deepEqual(results.map((result) => result.registryUpdated), [true, true])

  const { rows } = parseRegistryMarkdown(await readFile(at(vault, REGISTRY), 'utf8'))
  assert.deepEqual(rows.map((row) => row.projectId).sort(), [ID_A, ID_B].sort())
  assert.deepEqual(rows.map((row) => row.dir).sort(), [PROJECT_A, PROJECT_B].sort())
})

// ---------------------------------------------------------------------------
// Step 3: the lock lifecycle
// ---------------------------------------------------------------------------

test('a lock left by a dead process is broken after the manifest is reconciled', async (t) => {
  const { vault, dataRoot, bindingA } = await fixture(t)
  const vaultHash = sha256(await realpath(vault))
  await mkdir(join(dataRoot, 'locks'), { recursive: true })
  const lockPath = join(dataRoot, 'locks', `vault-${vaultHash}.lock`)
  await writeFile(lockPath, JSON.stringify({
    schema: 1,
    vaultHash,
    pid: 999_999_999,
    token: 'abandoned',
    txId: 'tx-dead',
    acquiredAt: new Date().toISOString(),
  }))

  const receipt = await runTransaction(bindingA, request(newTransactionId()), { dataRoot })
  assert.equal(receipt.result.status, 'applied')
  assert.equal(await exists(lockPath), false, 'the lock is released after a successful transaction')
})

test('a lock held by a live process is never stolen', async (t) => {
  const { vault, dataRoot, bindingA } = await fixture(t)
  const vaultHash = sha256(await realpath(vault))
  await mkdir(join(dataRoot, 'locks'), { recursive: true })
  const lockPath = join(dataRoot, 'locks', `vault-${vaultHash}.lock`)
  const held = JSON.stringify({
    schema: 1,
    vaultHash,
    pid: process.ppid,
    token: 'live',
    txId: 'tx-live',
    acquiredAt: new Date().toISOString(),
  })
  await writeFile(lockPath, held)

  await assert.rejects(
    runTransaction(bindingA, request(newTransactionId()), { dataRoot, lockTimeoutMs: 250, pollMs: 20 }),
    (error) => error instanceof TransactionError && error.code === 'lock-timeout',
  )
  assert.equal(await readFile(lockPath, 'utf8'), held, 'a live lock must be left alone')
  assert.equal(await exists(at(vault, NEW_NOTE)), false)
})

test('a committed transaction still queued for the index keeps its txId reserved', async (t) => {
  const { dataRoot, bindingA } = await fixture(t)
  const txId = newTransactionId()
  await assert.rejects(runTransaction(bindingA, request(txId), { dataRoot, failAfter: 'index-notify' }), { code: 'injected-failure' })

  await assert.rejects(
    runTransaction(bindingA, request(txId), { dataRoot }),
    (error) => error instanceof TransactionError && error.code === 'txid-in-use',
  )
})

// ---------------------------------------------------------------------------
// Step 1/4: a real second process that dies mid-transaction
// ---------------------------------------------------------------------------

test('recovery works after a real process dies with the lock on disk', async (t) => {
  const { root, vault, dataRoot, bindingA } = await fixture(t)
  const libUrl = pathToFileURL(join(import.meta.dirname, '..', 'lib', 'vault.js')).href
  const script = join(root, 'crash-child.mjs')
  await writeFile(script, [
    `import { runTransaction } from ${JSON.stringify(libUrl)}`,
    'const [vaultRoot, dataRoot, projectId] = process.argv.slice(2)',
    `const binding = { kind: 'bound', projectId, slug: 'alpha', displayName: 'alpha', vaultRoot }`,
    `await runTransaction(binding, ${JSON.stringify(request('tx-child'))}, { dataRoot, failAfter: 'new-note' })`,
    'console.log("the child must never reach this line")',
  ].join('\n'))

  const failure = await execFileAsync(process.execPath, [script, vault, dataRoot, ID_A], { encoding: 'utf8' })
    .then(() => null, (error) => error)
  assert.ok(failure, 'the child must die inside the transaction')
  assert.notEqual(failure.code, 0)

  // the dead child left its lock and its manifest behind
  const locks = await readdir(join(dataRoot, 'locks'))
  assert.equal(locks.length, 1, `expected the crashed lock to survive: ${locks}`)

  const report = await recoverTransactions(bindingA, { dataRoot })
  assert.deepEqual(report.unresolved, [])
  assert.equal(report.scanned, 1)
  assert.equal(report.rolledBack.length, 1)
  assert.equal(await exists(at(vault, NEW_NOTE)), false)
  assert.equal(await readFile(at(vault, STATUS_NOTE), 'utf8'), STATUS_BEFORE)
  assert.equal(await readdir(join(dataRoot, 'locks')).then((names) => names.length), 0)

  // the vault is writable again
  const receipt = await runTransaction(bindingA, request(newTransactionId()), { dataRoot })
  assert.equal(receipt.result.status, 'applied')
})

// ---------------------------------------------------------------------------
// Step 3: target validation before anything is written
// ---------------------------------------------------------------------------

test('an update must prove plugin ownership of the file it rewrites', async (t) => {
  const { vault, dataRoot, bindingA } = await fixture(t)
  const id = 'dec-00000000-0000-4000-8000-000000000001'
  const human = `---\nid: "${id}"\ntrust: "owner"\ntype: "decision"\n---\n人类手写的笔记\n`
  await writeFile(at(vault, STATUS_NOTE), human)

  // a note that declares itself human-owned is never rewritten, even with a matching hash
  await assert.rejects(
    runTransaction(bindingA, {
      txId: newTransactionId(),
      updates: [{ path: STATUS_NOTE, hash: sha256(human), contents: 'rewritten', own: { id } }],
    }, { dataRoot }),
    (error) => error instanceof TransactionError && error.code === 'human-owned',
  )
  assert.equal(await readFile(at(vault, STATUS_NOTE), 'utf8'), human)

  // an expected stable id is checked against the note's own frontmatter, for a
  // fixed replacement and for a transform alike
  const agent = `---\nid: "${id}"\ntrust: "agent"\ntype: "decision"\n---\n插件写的笔记\n`
  await writeFile(at(vault, STATUS_NOTE), agent)
  for (const entry of [
    { path: STATUS_NOTE, hash: sha256(agent), contents: 'rewritten', own: { id: 'dec-11111111-1111-4111-8111-111111111111' } },
    { path: STATUS_NOTE, transform: () => 'rewritten', own: { id: 'dec-11111111-1111-4111-8111-111111111111' } },
  ]) {
    await assert.rejects(
      runTransaction(bindingA, { txId: newTransactionId(), updates: [entry] }, { dataRoot }),
      (error) => error instanceof TransactionError && error.code === 'ownership-mismatch',
    )
  }
  assert.equal(await readFile(at(vault, STATUS_NOTE), 'utf8'), agent)

  // a file with no frontmatter cannot be the note a caller claims to be updating
  await writeFile(at(vault, STATUS_NOTE), '没有 frontmatter 的文件\n')
  await assert.rejects(
    runTransaction(bindingA, {
      txId: newTransactionId(),
      updates: [{ path: STATUS_NOTE, hash: sha256('没有 frontmatter 的文件\n'), contents: 'x', own: { id } }],
    }, { dataRoot }),
    (error) => error instanceof TransactionError && error.code === 'ownership-unproven',
  )

  // the matching id is accepted, and the note is really rewritten
  await writeFile(at(vault, STATUS_NOTE), agent)
  const receipt = await runTransaction(bindingA, {
    txId: newTransactionId(),
    updates: [{ path: STATUS_NOTE, hash: sha256(agent), contents: 'rewritten', own: { id } }],
  }, { dataRoot })
  assert.equal(receipt.result.status, 'applied')
  assert.equal(await readFile(at(vault, STATUS_NOTE), 'utf8'), 'rewritten')
})

test('unsafe, duplicate or already-taken targets are refused before the first write', async (t) => {
  const { root, vault, dataRoot, bindingA } = await fixture(t)
  const txId = () => newTransactionId()

  const cases = [
    ['traversal', { txId: txId(), creates: [{ path: '../outside.md', contents: 'x' }] }, 'unsafe-path'],
    ['absolute', { txId: txId(), creates: [{ path: '/tmp/evil.md', contents: 'x' }] }, 'unsafe-path'],
    ['existing create', { txId: txId(), creates: [{ path: STATUS_NOTE, contents: 'x' }] }, 'target-exists'],
    [
      'duplicate target',
      {
        txId: txId(),
        creates: [{ path: NEW_NOTE, contents: 'x' }],
        updates: [{ path: NEW_NOTE, hash: sha256(STATUS_BEFORE), contents: 'y' }],
      },
      'duplicate-target',
    ],
    ['missing hash', { txId: txId(), updates: [{ path: STATUS_NOTE, contents: 'x' }] }, 'missing-expected-hash'],
    [
      'stale hash',
      { txId: txId(), updates: [{ path: STATUS_NOTE, hash: '0'.repeat(64), contents: 'x' }] },
      'hash-mismatch',
    ],
    ['missing parent', { txId: txId(), creates: [{ path: `${PROJECT_A}/新目录/笔记.md`, contents: 'x' }] }, 'missing-parent-directory'],
    ['bad txId', { txId: '../escape', creates: [] }, 'invalid-tx-id'],
  ]

  for (const [label, tx, code] of cases) {
    await assert.rejects(
      runTransaction(bindingA, tx, { dataRoot }),
      (error) => error.code === code,
      `${label} must be refused with ${code}`,
    )
  }

  // a symlinked project directory is refused, not written through
  const outside = join(root, 'outside-decision')
  await mkdir(outside, { recursive: true })
  await symlink(outside, join(vault, PROJECT_A, '链接目录'))
  await assert.rejects(
    runTransaction(bindingA, { txId: txId(), creates: [{ path: `${PROJECT_A}/链接目录/x.md`, contents: 'x' }] }, { dataRoot }),
    (error) => error.code === 'unsafe-path',
  )
  assert.deepEqual(await readdir(outside), [])
  assert.equal(await exists(at(vault, NEW_NOTE)), false)
  assert.equal(await exists(at(vault, LOG_RELATIVE_PATH)), false)
})

test('a transaction leaks no file descriptor and leaves no lock behind', async (t) => {
  if (process.platform === 'win32') t.skip('/dev/fd is a POSIX view of the descriptor table')
  const { dataRoot, bindingA } = await fixture(t)
  const counts = []
  for (let index = 0; index < 5; index += 1) {
    await runTransaction(bindingA, {
      txId: newTransactionId(),
      creates: [{ path: `${PROJECT_A}/决策/笔记-${index}.md`, contents: `笔记 ${index}\n` }],
      receipt: { action: 'write' },
    }, { dataRoot })
    counts.push((await readdir('/dev/fd')).length)
  }
  assert.equal(new Set(counts).size, 1, `a transaction must not leak a descriptor: ${counts.join(',')}`)
  assert.deepEqual(await readdir(join(dataRoot, 'locks')), [], 'the vault lock must be released')
})

test('a lock record that cannot be read is reported, never stolen', async (t) => {
  const { vault, dataRoot, bindingA } = await fixture(t)
  const vaultHash = sha256(await realpath(vault))
  await mkdir(join(dataRoot, 'locks'), { recursive: true })
  const lockPath = join(dataRoot, 'locks', `vault-${vaultHash}.lock`)
  await writeFile(lockPath, '')

  await assert.rejects(
    runTransaction(bindingA, request(newTransactionId()), { dataRoot, lockTimeoutMs: 150, pollMs: 20 }),
    (error) => error instanceof TransactionError && error.code === 'lock-corrupt',
  )
  assert.equal(await exists(lockPath), true, 'an unreadable lock is never removed on a guess')

  await rm(lockPath)
  const receipt = await runTransaction(bindingA, request(newTransactionId()), { dataRoot })
  assert.equal(receipt.result.status, 'applied')
})

test('staged lock records are swept only when their owner is gone', async (t) => {
  const { vault, dataRoot, bindingA } = await fixture(t)
  const vaultHash = sha256(await realpath(vault))
  const locks = join(dataRoot, 'locks')
  await mkdir(locks, { recursive: true })
  const dead = join(locks, '.dead.0.lock.tmp')
  const live = join(locks, `.${process.pid}.0.lock.tmp`)
  await writeFile(dead, JSON.stringify({ schema: 1, pid: 999_999_999, token: 'dead' }))
  await writeFile(live, JSON.stringify({ schema: 1, pid: process.pid, token: 'live' }))

  const receipt = await runTransaction(bindingA, request(newTransactionId()), { dataRoot })
  assert.equal(receipt.result.status, 'applied')
  assert.equal(await exists(dead), false, 'an abandoned staged record is swept')
  assert.equal(await exists(live), true, 'a staged record whose writer is alive is left alone')
})

test('a committed receipt that cannot be stored blocks a same-key retry instead of applying twice', async (t) => {
  if (process.getuid?.() === 0) t.skip('root ignores the read-only receipt directory')
  const { vault, dataRoot, bindingA } = await fixture(t)
  const receiptDirectory = join(dataRoot, 'receipts', sha256(await realpath(vault)), ID_A)
  await mkdir(receiptDirectory, { recursive: true })
  await chmod(receiptDirectory, 0o500)

  const key = 'persistent-store-failure'
  // a transform, not a create: a duplicate here is silent — the registry simply
  // gains a second row and the log a second receipt
  const addRow = (row) => (current) => {
    const rows = current === null ? [] : parseRegistryMarkdown(current.toString('utf8')).rows
    return renderRegistryDocument([...rows, row])
  }
  const tx = () => ({
    txId: newTransactionId(),
    idempotencyKey: key,
    updates: [{ path: REGISTRY, transform: addRow({ projectId: ID_A, dir: PROJECT_A, displayName: 'Alpha', remote: '' }) }],
    receipt: { action: 'write' },
  })

  const first = await runTransaction(bindingA, tx(), { dataRoot })
  assert.equal(first.result.status, 'applied')
  assert.equal(first.result.stored, false, 'the receipt is only in the manifest')
  const registryAfterFirst = await readFile(at(vault, REGISTRY), 'utf8')
  const logAfterFirst = await readFile(at(vault, LOG_RELATIVE_PATH), 'utf8')
  assert.equal(parseRegistryMarkdown(registryAfterFirst).rows.length, 1)

  // the store keeps failing: recovery must fail closed, not pretend
  const report = await recoverTransactions(bindingA, { dataRoot })
  assert.equal(report.unresolved.length, 1)
  assert.equal(report.unresolved[0].reason, 'receipt-store-unavailable')

  // the same key can never be applied a second time while its receipt is unstored
  await assert.rejects(
    runTransaction(bindingA, tx(), { dataRoot }),
    (error) => error instanceof TransactionError && error.code === 'recovery-required',
  )
  assert.equal(await readFile(at(vault, REGISTRY), 'utf8'), registryAfterFirst, 'the registry must not gain a second row')
  assert.equal(await readFile(at(vault, LOG_RELATIVE_PATH), 'utf8'), logAfterFirst, 'the log must not gain a second receipt')

  // once the store works the receipt lands, the block clears, and the key replays
  await chmod(receiptDirectory, 0o700)
  const healed = await recoverTransactions(bindingA, { dataRoot })
  assert.deepEqual(healed.unresolved, [])
  assert.equal((await findReceipt(bindingA, key, { dataRoot })).txId, first.txId)
  const replay = await runTransaction(bindingA, tx(), { dataRoot })
  assert.equal(replay.txId, first.txId)
  assert.equal(await readFile(at(vault, REGISTRY), 'utf8'), registryAfterFirst)
  assert.equal(await readFile(at(vault, LOG_RELATIVE_PATH), 'utf8'), logAfterFirst)
})

test('a filesystem without hard links still publishes a readable lock record', async (t) => {
  const { vault, dataRoot, bindingA } = await fixture(t)
  const staged = []
  const io = {
    link: async (temporary) => {
      // the record is complete before it is ever visible under the lock name
      staged.push(JSON.parse(await readFile(temporary, 'utf8')))
      throw Object.assign(new Error('operation not supported'), { code: 'EOPNOTSUPP' })
    },
  }
  const lockPath = join(dataRoot, 'locks', `vault-${sha256(await realpath(vault))}.lock`)

  let releaseHolder
  const hold = new Promise((resolve) => { releaseHolder = resolve })
  const holder = runTransaction(bindingA, {
    txId: newTransactionId(),
    updates: [{
      path: MOC,
      transform: async (current) => {
        await hold
        return `${current.toString('utf8')}\n追加\n`
      },
    }],
    receipt: null,
  }, { dataRoot, io })

  for (let attempt = 0; attempt < 200 && !(await exists(lockPath)); attempt += 1) await delay(10)
  assert.equal(await exists(lockPath), true, 'the exclusive-create fallback must publish the lock')

  // a concurrent attempt reads a complete, live record: it waits and times out
  // instead of reporting the lock as unreadable or stealing it
  await assert.rejects(
    runTransaction(bindingA, {
      txId: newTransactionId(),
      updates: [{ path: STATUS_NOTE, hash: sha256(STATUS_BEFORE), contents: 'replacement' }],
      receipt: null,
    }, { dataRoot, io, lockTimeoutMs: 150, pollMs: 20 }),
    (error) => error instanceof TransactionError && error.code === 'lock-timeout',
  )

  releaseHolder()
  const receipt = await holder
  assert.equal(receipt.result.status, 'applied')
  // every staged record (one per acquisition attempt) was a complete record
  assert.ok(staged.length >= 1)
  for (const record of staged) {
    assert.equal(record.pid, process.pid)
    assert.equal(typeof record.token, 'string')
    assert.equal(typeof record.txId, 'string')
  }
  assert.equal(await exists(lockPath), false, 'the fallback lock is released')

  // and a later transaction acquires through the same fallback, leaving nothing behind
  const current = await readFile(at(vault, MOC))
  const again = await runTransaction(bindingA, {
    txId: newTransactionId(),
    updates: [{ path: MOC, hash: sha256(current), contents: current }],
    receipt: null,
  }, { dataRoot, io })
  assert.equal(again.result.status, 'no-op')
  assert.deepEqual(await readdir(join(dataRoot, 'locks')), [], 'no staged lock record is left behind')
})

test('no temporary file survives a refused transaction', async (t) => {
  const { vault, dataRoot, bindingA } = await fixture(t)
  await assert.rejects(
    runTransaction(bindingA, request(newTransactionId()), { dataRoot, failAfter: 'old-status' }),
    { code: 'injected-failure' },
  )
  await recoverTransactions(bindingA, { dataRoot })
  const stray = (await readdir(at(vault, `${PROJECT_A}/决策`))).filter((name) => name.startsWith('.'))
  assert.deepEqual(stray, [], 'staging files must be cleaned up by recovery')
  assert.deepEqual(
    (await readdir(join(dataRoot, 'transactions', sha256(await realpath(vault))))).filter((name) => name.endsWith('.json')),
    [],
  )
})
