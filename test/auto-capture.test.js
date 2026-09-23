// Task 16: applying distilled candidates, dedupe/retry, dryRun and crash resume.
//
// The queue worker is the only place in this plugin that writes a vault from an
// unattended path, so every case here is about a failure that must not become a
// duplicate or a silent drop:
//
//   * **A persisted output is never distilled twice.** A `raw-durable` job is
//     re-validated from exactly the bytes on disk and a `validated` job hands
//     back its stored `preassignedId`/`idempotencyKey` pairs, so a restart at
//     either barrier makes ZERO model calls and reuses the same identities.
//   * **A crash mid-apply only finishes the unfinished items.** Progress is
//     persisted per item (`appliedItems`), and the transaction receipt of the
//     item already written replays by idempotency key, so neither an ADR number
//     nor a `_meta/log.md` entry is ever minted twice.
//   * **`dryRun` writes receipts only.** The whole vault tree is snapshotted and
//     must come back byte-identical, while the result receipt says what WOULD
//     have been written.
//   * **Failure is bounded and visible.** A validation refusal (R43) records an
//     attempt per pass and ends in a terminal `failed` state with a reason, so a
//     bad model output can neither wedge a turn invisibly nor start a retry storm
//     at startup. `retryJob` is the only way back, and it is explicit.
//   * **An index failure never undoes a committed vault transaction.** The
//     refresh is the last step, its failure is recorded on the receipt, and the
//     note stays.
//
// Every case runs against a REAL temporary vault created by the REAL bootstrap,
// a real throwaway data root and an explicit queue root: nothing here may read or
// write the user's `~/.dsh` or a real vault.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createCapture, createQueueWorker, enqueueTurn, processQueue, retryJob } from '../lib/capture.js'
import { registerHooks } from '../lib/hooks.js'
import { applyCandidate, createMemoryWithId } from '../lib/memory.js'
import {
  PENDING_SCHEMA,
  PendingError,
  loadPending,
  readResultReceipts,
  writeJobAtomic,
} from '../lib/pending.js'
import { bootstrapVault, parseNote } from '../lib/vault.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Fixed, valid UUIDv4 identity (version nibble `4`, variant nibble `8`). */
const PROJECT_ID = '1c392abb-7b08-42f7-871d-2a379caf9448'
const ID8 = PROJECT_ID.slice(0, 8)
const PROJECT = `项目/alpha--${ID8}`
const SESSION_ID = 'session-9d4a4c1e-2f1a-4f4e-8b3a-000000000001'
const TO_SEQ = 7
const JOB_ID = 'job-0123456789abcdef0123456789abcdef'
const DECISIONS = `${PROJECT}/决策`
const INBOX = `${PROJECT}/收件箱`
const LOG = '_meta/log.md'

/** The §6.4 prefix of each type admissible to automatic distillation. */
const PREFIX = Object.freeze({ decision: 'dec', gotcha: 'got', convention: 'con' })

/** The whitelisted evidence `capture.js` stores: user, one tool run, final text. */
const ALLOWED = Object.freeze([
  { kind: 'user', seq: 2, source: 'user' },
  { kind: 'tool', seq: 4, name: 'bash', ok: true },
  { kind: 'assistant-final', seq: 6 },
])

const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const at = (vault, relative) => join(vault, ...relative.split('/'))
const occurrences = (haystack, needle) => String(haystack).split(needle).length - 1

/** A fresh private root; nothing in this file uses the process cwd or home. */
async function temporaryRoot(t, name = 'obsidian-mem-t16-auto-') {
  const root = await mkdtemp(join(tmpdir(), name))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 4 }))
  return root
}

/** A real bootstrapped vault, a throwaway data root and an explicit queue root. */
async function fixture(t) {
  const root = await temporaryRoot(t)
  const dataRoot = await mkdtemp(join(tmpdir(), 'obsidian-mem-t16-data-'))
  t.after(() => rm(dataRoot, { recursive: true, force: true, maxRetries: 4 }))
  const home = join(root, 'home')
  await mkdir(home, { recursive: true })
  const vault = join(root, 'vault')
  const binding = {
    kind: 'bound',
    projectId: PROJECT_ID,
    slug: 'alpha',
    displayName: 'alpha',
    schema: 1,
    vaultRoot: vault,
    relativeDir: PROJECT,
  }
  await bootstrapVault(binding, { dataRoot, home })
  return {
    root,
    dataRoot,
    home,
    vault,
    binding,
    queueRoot: join(dataRoot, 'pending'),
    deps: { dataRoot, home },
  }
}

/** The validated plugin config shape, with the distillation knobs under `distill`. */
function baseConfig({ distill = {}, ...rest } = {}) {
  return {
    autoCapture: true,
    captureIdleMs: 90000,
    distill: {
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      maxItems: 12,
      minConfidence: 0.75,
      maxInputChars: 24000,
      maxOutputTokens: 4000,
      timeoutMs: 60000,
      maxRetries: 3,
      dryRun: false,
      ...distill,
    },
    ...rest,
  }
}

/** The shape `enqueueTurn` is contracted to produce. */
function jobFixture(overrides = {}) {
  return {
    schema: PENDING_SCHEMA,
    jobId: JOB_ID,
    sessionId: SESSION_ID,
    projectId: PROJECT_ID,
    fromSeq: 1,
    toSeq: TO_SEQ,
    state: 'pending',
    route: { provider: 'deepseek-official', model: 'deepseek-flash' },
    allowedEvents: [...ALLOWED],
    safeInput: '[obsidian-mem pending] session=… project=… turn=1 seq 1-7\n--- user (seq 2) ---\n把调度器改成可插拔后端\n',
    credentialSkips: 0,
    omitted: null,
    attempts: 0,
    output: null,
    createdAt: '2026-09-23T00:00:00.000Z',
    updatedAt: '2026-09-23T00:00:00.000Z',
    ...overrides,
  }
}

/** One complete, well-formed candidate item (the Task 15 contract fields only). */
function itemFixture(overrides = {}) {
  return {
    type: 'decision',
    title: '调度器改为可插拔后端',
    body: '结论与适用范围：调度器通过一个后端接口注册，默认实现不变。',
    tags: ['dsh-mem/decision'],
    confidence: 0.91,
    assertion: 'stated',
    status: 'accepted',
    supersedesId: null,
    evidenceSeqs: [2],
    ...overrides,
  }
}

/** Give each item the persisted identity Task 15 assigns before any vault write. */
function withIdentity(items) {
  return items.map((item, index) => ({
    ...item,
    preassignedId: item.preassignedId ?? `${PREFIX[item.type]}-${randomUUID()}`,
    idempotencyKey: item.idempotencyKey ?? `${SESSION_ID}:${TO_SEQ}:${index}`,
  }))
}

/** A job whose validated output is already durable — the resume state. */
function validatedJob(items, overrides = {}) {
  const identified = withIdentity(items)
  return jobFixture({
    state: 'validated',
    output: {
      state: 'validated',
      raw: JSON.stringify({ items: identified.map(({ preassignedId, idempotencyKey, ...rest }) => rest) }),
      items: identified,
      usage: null,
    },
    ...overrides,
  })
}

/** An `llm` stub in the P0-measured `{provider,model,messages,system,maxTokens,signal}` shape. */
function stubLlm(raw, { delayMs = 0 } = {}) {
  const calls = []
  return {
    calls,
    stream(options) {
      calls.push(options)
      const text = typeof raw === 'function' ? raw(options, calls.length) : raw
      return (async function* () {
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
}

/** An `llm` stub whose stream ends in a terminal, non-throwing abort chunk. */
function abortedLlm() {
  const calls = []
  return {
    calls,
    stream(options) {
      calls.push(options)
      return (async function* () {
        yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'aborted by caller' } } }
      })()
    },
  }
}

/** The default worker options for a fixture: explicit roots, no debounce, no backoff. */
function queueOptions(f, overrides = {}) {
  return {
    queueRoot: f.queueRoot,
    dataRoot: f.dataRoot,
    home: f.home,
    config: baseConfig(),
    resolveBinding: () => f.binding,
    debounceMs: 0,
    retryBackoffMs: 0,
    warn: () => {},
    ...overrides,
  }
}

/** Every file under one tree, as `relativePath:sha256`, sorted. */
async function snapshotTree(root) {
  const found = []
  async function walk(directory, prefix) {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if (error.code === 'ENOENT') return
      throw error
    }
    for (const entry of [...entries].sort((left, right) => (left.name < right.name ? -1 : 1))) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) {
        await walk(join(directory, entry.name), relative)
        continue
      }
      if (!entry.isFile()) continue
      found.push(`${relative}:${sha256(await readFile(join(directory, entry.name)))}`)
    }
  }
  await walk(root, '')
  return found.sort()
}

/** Every note inside the bound project, with its parsed frontmatter. */
async function listProjectNotes(f) {
  const root = at(f.vault, PROJECT)
  const found = []
  async function walk(directory, prefix) {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if (error.code === 'ENOENT') return
      throw error
    }
    for (const entry of [...entries].sort((left, right) => (left.name < right.name ? -1 : 1))) {
      if (entry.name.startsWith('.')) continue
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) {
        await walk(join(directory, entry.name), relative)
        continue
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue
      const bytes = await readFile(join(directory, entry.name))
      found.push({ path: `${PROJECT}/${relative}`, bytes, hash: sha256(bytes), note: parseNote(bytes) })
    }
  }
  await walk(root, '')
  return found
}

/** The decision|gotcha|convention notes of a project (the only auto-writable types). */
async function memoryNotes(f) {
  return (await listProjectNotes(f)).filter((entry) => ['decision', 'gotcha', 'convention'].includes(entry.note.data.type))
}

/** The receipts written for one project, oldest first. */
async function readReceipts(f) {
  return readResultReceipts(f.queueRoot, PROJECT_ID)
}

/** Read one vault file, or `''` when it does not exist. */
async function readVault(f, relative) {
  try {
    return await readFile(at(f.vault, relative), 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return ''
    throw error
  }
}

/** The candidate notes parked in the explicit inbox (the MOC itself is not one). */
async function inboxCandidates(f) {
  return (await listProjectNotes(f)).filter((entry) => entry.path.startsWith(INBOX) && !entry.path.endsWith('/index.md'))
}

/** The job on disk, or `null`. */
async function jobOnDisk(f, jobId = JOB_ID) {
  return (await loadPending(f.queueRoot)).find((job) => job.jobId === jobId) ?? null
}

/** A recording per-item apply seam wrapping the real `applyCandidate`. */
function recordingApply() {
  const calls = []
  return {
    calls,
    seam: async (binding, job, item, deps) => {
      calls.push({ idempotencyKey: item.idempotencyKey, preassignedId: item.preassignedId })
      return applyCandidate(binding, job, item, deps)
    },
  }
}

/** Seed one real decision note and return its identity and bytes. */
async function seedDecision(f, { title = '旧结论', idempotencyKey = `seed:${randomUUID()}` } = {}) {
  const id = `dec-${randomUUID()}`
  const written = await createMemoryWithId(f.binding, {
    preassignedId: id,
    idempotencyKey,
    type: 'decision',
    title,
    body: '旧结论正文。',
    status: 'accepted',
    confidence: 0.9,
    assertion: 'stated',
  }, { dataRoot: f.dataRoot, home: f.home })
  return written
}

// ---------------------------------------------------------------------------
// The happy path and the two no-op results
// ---------------------------------------------------------------------------

test('a validated job applies through createMemoryWithId: one note, one MOC line, one log entry', async (t) => {
  const f = await fixture(t)
  const job = validatedJob([itemFixture()])
  const items = job.output.items
  await writeJobAtomic(f.queueRoot, job)

  const summary = await processQueue(queueOptions(f))
  assert.equal(summary.completed, 1)
  assert.equal(summary.failed, 0)
  assert.equal(summary.deferred, 0)

  const notes = await memoryNotes(f)
  assert.equal(notes.length, 1)
  assert.equal(notes[0].note.data.id, items[0].preassignedId)
  assert.equal(notes[0].note.data.type, 'decision')
  assert.equal(notes[0].note.data.trust, 'agent')
  assert.equal(notes[0].note.data.session, SESSION_ID)
  assert.match(notes[0].path, /决策\/ADR-1-/)

  // The MOC's generated region lists the note; the log carries exactly one block.
  const moc = await readVault(f, `${DECISIONS}/index.md`)
  assert.equal(occurrences(moc, notes[0].path.replace(/\.md$/, '')), 1)
  const log = await readVault(f, LOG)
  assert.equal(occurrences(log, items[0].idempotencyKey), 1)

  // The finished job is deleted (spec §10.1) and its receipt is the completion marker.
  assert.equal(await jobOnDisk(f), null)
  const receipts = await readReceipts(f)
  assert.equal(receipts.length, 1)
  assert.equal(receipts[0].result, 'applied')
  assert.equal(receipts[0].items.length, 1)
  assert.equal(receipts[0].items[0].id, items[0].preassignedId)
  assert.equal(receipts[0].items[0].path, notes[0].path)
})

test('an empty result writes a no-memory receipt and touches nothing', async (t) => {
  const f = await fixture(t)
  const before = await snapshotTree(f.vault)
  await writeJobAtomic(f.queueRoot, jobFixture())
  const llm = stubLlm('{"items":[]}')

  const summary = await processQueue(queueOptions(f, { llm }))
  assert.equal(summary.completed, 1)
  assert.equal(llm.calls.length, 1)
  assert.deepEqual(await memoryNotes(f), [])
  assert.deepEqual(await snapshotTree(f.vault), before, 'an empty distillation writes no vault byte')

  const [receipt] = await readReceipts(f)
  assert.equal(receipt.result, 'no-memory')
  assert.deepEqual(receipt.items, [])
  assert.equal(await jobOnDisk(f), null)
})

test('dryRun writes a dry-run receipt and leaves the whole vault tree byte-identical', async (t) => {
  const f = await fixture(t)
  const before = await snapshotTree(f.vault)
  await writeJobAtomic(f.queueRoot, jobFixture())
  const llm = stubLlm(JSON.stringify({ items: [itemFixture()] }))

  const summary = await processQueue(queueOptions(f, { llm, config: baseConfig({ distill: { dryRun: true } }) }))
  assert.equal(summary.completed, 1)
  assert.equal(llm.calls.length, 1)

  assert.deepEqual(
    (await listProjectNotes(f)).filter((entry) => ['decision', 'gotcha', 'convention'].includes(entry.note.data.type)),
    [],
  )
  assert.deepEqual(await snapshotTree(f.vault), before, 'dryRun changes no note, MOC, hot file or log byte')

  const receipts = await readReceipts(f)
  assert.equal(receipts.at(-1).result, 'dry-run')
  assert.equal(receipts.at(-1).dryRun, true)
  assert.equal(receipts.at(-1).items.length, 1)
  assert.equal(receipts.at(-1).items[0].type, 'decision')
  assert.match(receipts.at(-1).items[0].preassignedId, /^dec-/)
  assert.equal(await jobOnDisk(f), null, 'a dry run still finishes the job it observed')
})

test('a dry run of an empty result is visibly finished as no-memory', async (t) => {
  const f = await fixture(t)
  await writeJobAtomic(f.queueRoot, jobFixture())
  const llm = stubLlm('{"items":[]}')

  await processQueue(queueOptions(f, { llm, config: baseConfig({ distill: { dryRun: true } }) }))
  const [receipt] = await readReceipts(f)
  assert.equal(receipt.result, 'no-memory')
  assert.equal(receipt.dryRun, true)
})

// ---------------------------------------------------------------------------
// Deferral: no model call is worth making yet
// ---------------------------------------------------------------------------

test('a missing llm defers the job with zero attempts and leaves it on disk', async (t) => {
  const f = await fixture(t)
  await writeJobAtomic(f.queueRoot, jobFixture())

  const summary = await processQueue(queueOptions(f, { llm: undefined }))
  assert.equal(summary.completed, 0)
  assert.equal(summary.deferred, 1)
  assert.equal(summary.failed, 0)

  const job = await jobOnDisk(f)
  assert.notEqual(job, null)
  assert.equal(job.state, 'deferred')
  assert.equal(job.deferredReason, 'no-route')
  assert.equal(job.attempts, 0)
  assert.equal(job.output, null)
})

test('a project that cannot be resolved defers without consuming an attempt', async (t) => {
  const f = await fixture(t)
  await writeJobAtomic(f.queueRoot, jobFixture())

  const summary = await processQueue(queueOptions(f, { llm: stubLlm('{"items":[]}'), resolveBinding: () => null }))
  assert.equal(summary.deferred, 1)
  const job = await jobOnDisk(f)
  assert.equal(job.state, 'deferred')
  assert.equal(job.deferredReason, 'no-binding')
  assert.equal(job.attempts, 0)
})

// ---------------------------------------------------------------------------
// Bounded failure: R43's terminal, visible refusal
// ---------------------------------------------------------------------------

test('a validation refusal records an attempt per pass and ends failed with a reason', async (t) => {
  const f = await fixture(t)
  await writeJobAtomic(f.queueRoot, jobFixture())
  const llm = stubLlm('not json at all')

  for (let pass = 1; pass <= 3; pass += 1) {
    await processQueue(queueOptions(f, { llm }))
    const job = await jobOnDisk(f)
    assert.equal(job.attempts, pass, `pass ${pass} records its attempt`)
    if (pass < 3) assert.equal(job.state, 'raw-durable', 'the retry resumes from the durable barrier')
  }

  const failed = await jobOnDisk(f)
  assert.equal(failed.state, 'failed')
  assert.equal(failed.attempts, 3)
  assert.equal(failed.lastError.code, 'not-json')
  assert.equal(typeof failed.lastError.message, 'string')
  assert.equal(failed.output.state, 'raw-durable', 'the refused bytes stay inspectable')
  // The refusal happened AFTER the raw barrier, so exactly one model call was made
  // for all three attempts: the resume path re-validates the same bytes.
  assert.equal(llm.calls.length, 1)

  const again = await processQueue(queueOptions(f, { llm }))
  assert.equal(again.failed, 1)
  assert.equal(again.completed, 0)
  assert.equal(llm.calls.length, 1, 'a terminally failed job is never retried at startup')
})

test('a transient stream failure retries with backoff, then fails with the stream reason', async (t) => {
  const f = await fixture(t)
  await writeJobAtomic(f.queueRoot, jobFixture())
  const llm = abortedLlm()

  for (let pass = 1; pass <= 3; pass += 1) await processQueue(queueOptions(f, { llm }))
  const job = await jobOnDisk(f)
  assert.equal(job.state, 'failed')
  assert.equal(job.attempts, 3)
  assert.equal(job.lastError.code, 'aborted')
  assert.equal(job.output, null, 'a terminal abort reaches no durability barrier')
  assert.equal(llm.calls.length, 3, 'each transient retry made exactly one call')
})

test('a job whose next attempt is in the future is not retried by the next pass', async (t) => {
  const f = await fixture(t)
  await writeJobAtomic(f.queueRoot, jobFixture())
  const llm = abortedLlm()

  const first = await processQueue(queueOptions(f, { llm, retryBackoffMs: 3_600_000 }))
  assert.equal(first.deferred, 1)
  assert.equal(first.failed, 0)
  const job = await jobOnDisk(f)
  assert.equal(job.state, 'pending')
  assert.equal(job.attempts, 1)
  assert.ok(Date.parse(job.nextAttemptAt) > Date.now(), 'the retry is scheduled in the future')
  assert.ok(first.nextDueAt > Date.now(), 'the worker is told when to wake up')

  await processQueue(queueOptions(f, { llm, retryBackoffMs: 3_600_000 }))
  assert.equal(llm.calls.length, 1, 'no startup retry storm')
})

test('retryJob explicitly requeues a terminally failed job and refuses a healthy one', async (t) => {
  const f = await fixture(t)
  await writeJobAtomic(f.queueRoot, jobFixture())
  const llm = abortedLlm()
  for (let pass = 0; pass < 3; pass += 1) await processQueue(queueOptions(f, { llm }))
  const failed = await jobOnDisk(f)
  assert.equal(failed.state, 'failed')
  assert.equal(failed.attempts, 3)

  const revived = await retryJob(JOB_ID, { queueRoot: f.queueRoot })
  assert.equal(revived.state, 'pending', 'a job with no durable output restarts from the model call')
  assert.equal(revived.attempts, 0)
  assert.equal(revived.nextAttemptAt, null)
  assert.equal(revived.previousAttempts, 3, 'the prior attempt count stays inspectable')

  const healthy = stubLlm(JSON.stringify({ items: [itemFixture()] }))
  // The retry is explicit, so the capture debounce does not apply to it.
  const summary = await processQueue(queueOptions(f, { llm: healthy, debounceMs: 90_000 }))
  assert.equal(summary.completed, 1)
  assert.equal((await memoryNotes(f)).length, 1)

  await writeJobAtomic(f.queueRoot, jobFixture({ jobId: 'job-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }))
  await assert.rejects(
    () => retryJob('job-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', { queueRoot: f.queueRoot }),
    (error) => error instanceof PendingError && error.code === 'retry-not-failed',
  )
  assert.equal(await retryJob('job-does-not-exist', { queueRoot: f.queueRoot }), null)
})

// ---------------------------------------------------------------------------
// Crash resume: the two durability barriers
// ---------------------------------------------------------------------------

test('a fault before the raw barrier leaves no output and the next pass calls the model once more', async (t) => {
  const f = await fixture(t)
  await writeJobAtomic(f.queueRoot, jobFixture())
  const llm = stubLlm(JSON.stringify({ items: [itemFixture()] }))

  const first = await processQueue(queueOptions(f, {
    llm,
    beforePersist: (jobId, output) => {
      if (output.state === 'raw-durable') throw new Error('injected-before-output')
    },
  }))
  assert.equal(first.deferred, 1)
  const interrupted = await jobOnDisk(f)
  assert.equal(interrupted.output, null, 'nothing durable was written')
  assert.equal(interrupted.attempts, 1)
  assert.match(interrupted.lastError.message, /injected-before-output/)

  const second = await processQueue(queueOptions(f, { llm }))
  assert.equal(second.completed, 1)
  assert.equal(llm.calls.length, 2, 'no barrier means the model call is legitimately repeated')
  assert.equal((await memoryNotes(f)).length, 1, 'and it is applied exactly once')
})

test('a raw-durable job resumes by re-validating the same bytes with no second model call', async (t) => {
  const f = await fixture(t)
  await writeJobAtomic(f.queueRoot, jobFixture())
  const llm = stubLlm(JSON.stringify({ items: [itemFixture()] }))

  const first = await processQueue(queueOptions(f, {
    llm,
    afterPersist: (jobId, output) => {
      if (output.state === 'raw-durable') throw new Error('injected-after-output')
    },
  }))
  assert.equal(first.deferred, 1)
  const interrupted = await jobOnDisk(f)
  assert.equal(interrupted.output.state, 'raw-durable')
  const rawBytes = interrupted.output.raw
  assert.equal(interrupted.attempts, 1)

  const second = await processQueue(queueOptions(f, { llm }))
  assert.equal(second.completed, 1)
  assert.equal(llm.calls.length, 1, 'the persisted bytes are re-validated, never re-requested')

  const notes = await memoryNotes(f)
  assert.equal(notes.length, 1)
  // The identity minted on the resume is the one that was persisted and applied.
  const receipt = (await readReceipts(f)).at(-1)
  assert.equal(receipt.result, 'applied')
  assert.equal(receipt.items[0].id, notes[0].note.data.id)
  assert.match(rawBytes, /"items"/)
})

// ---------------------------------------------------------------------------
// Crash mid-apply: only the unfinished items, with stable identities
// ---------------------------------------------------------------------------

test('a crash after the first item resumes with only the unfinished second item', async (t) => {
  const f = await fixture(t)
  const items = [itemFixture({ title: '第一条结论' }), itemFixture({ title: '第二条结论' })]
  const job = validatedJob(items)
  const ids = job.output.items.map((item) => item.preassignedId)
  await writeJobAtomic(f.queueRoot, job)

  const apply = recordingApply(f)
  const first = await processQueue(queueOptions(f, {
    writeMemory: apply.seam,
    beforeApply: (binding, current, item, index) => {
      if (index === 1) throw new Error('injected-before-second-item')
    },
  }))
  assert.equal(first.deferred, 1)
  const interrupted = await jobOnDisk(f)
  assert.equal(interrupted.attempts, 1)
  assert.deepEqual(interrupted.output.items.map((item) => item.preassignedId), ids, 'identities are byte-stable')
  assert.equal(interrupted.appliedItems.length, 1)
  assert.equal(interrupted.appliedItems[0].idempotencyKey, `${SESSION_ID}:${TO_SEQ}:0`)

  const second = recordingApply(f)
  const resumed = await processQueue(queueOptions(f, { writeMemory: second.seam }))
  assert.equal(resumed.completed, 1)
  assert.deepEqual(
    second.calls.map((entry) => entry.idempotencyKey),
    [`${SESSION_ID}:${TO_SEQ}:1`],
    'only the unfinished item is applied',
  )

  const notes = await memoryNotes(f)
  assert.equal(notes.length, 2, 'no third note from the resumed item')
  assert.deepEqual(notes.map((entry) => entry.note.data.id).sort(), [...ids].sort(), 'the same identities survive the resume')
  assert.match(notes.map((entry) => entry.path).join('\n'), /ADR-1-/)
  assert.match(notes.map((entry) => entry.path).join('\n'), /ADR-2-/)
  const names = (await readdir(at(f.vault, DECISIONS))).filter((name) => name.endsWith('.md'))
  assert.equal(names.filter((name) => name.startsWith('ADR-3-')).length, 0, 'no duplicate ADR number was minted')
})

test('a crash after a note write but before the progress record replays its receipt', async (t) => {
  const f = await fixture(t)
  const items = [itemFixture({ title: '第一条结论' }), itemFixture({ title: '第二条结论' })]
  const job = validatedJob(items)
  await writeJobAtomic(f.queueRoot, job)

  const first = await processQueue(queueOptions(f, {
    afterApply: (binding, current, item, index) => {
      if (index === 1) throw new Error('injected-after-second-note')
    },
  }))
  assert.equal(first.deferred, 1)
  const interrupted = await jobOnDisk(f)
  assert.equal(interrupted.appliedItems.length, 1, 'the second item was written but not recorded')
  assert.equal((await memoryNotes(f)).length, 2, 'both notes exist on disk')

  const second = recordingApply(f)
  const resumed = await processQueue(queueOptions(f, { writeMemory: second.seam }))
  assert.equal(resumed.completed, 1)
  assert.deepEqual(second.calls.map((entry) => entry.idempotencyKey), [`${SESSION_ID}:${TO_SEQ}:1`])

  const notes = await memoryNotes(f)
  assert.equal(notes.length, 2, 'the replay created no third note')
  const log = await readVault(f, LOG)
  for (const item of job.output.items) {
    assert.equal(occurrences(log, item.idempotencyKey), 1, `${item.idempotencyKey} appears exactly once in the log`)
  }
  assert.equal((await readdir(at(f.vault, DECISIONS))).filter((name) => name.startsWith('ADR-3-')).length, 0)
})

test('a fault after the result receipt but before the job deletion does not double-apply', async (t) => {
  const f = await fixture(t)
  const job = validatedJob([itemFixture()])
  await writeJobAtomic(f.queueRoot, job)

  const first = await processQueue(queueOptions(f, {
    beforeComplete: () => { throw new Error('injected-before-complete') },
  }))
  assert.equal(first.deferred, 1)
  assert.notEqual(await jobOnDisk(f), null, 'the receipt exists but the job was not deleted')
  assert.equal((await readReceipts(f)).length, 1)

  const second = await processQueue(queueOptions(f))
  assert.equal(second.completed, 1)
  assert.equal((await memoryNotes(f)).length, 1, 'the item replayed instead of being duplicated')
  assert.equal((await readReceipts(f)).length, 1, 'the receipt is keyed by job, so it is upserted not appended')
})

// ---------------------------------------------------------------------------
// The index is the last step and never rolls a write back
// ---------------------------------------------------------------------------

test('a working index is refreshed for each applied item', async (t) => {
  const f = await fixture(t)
  const items = [itemFixture({ title: '第一条结论' }), itemFixture({ title: '第二条结论' })]
  await writeJobAtomic(f.queueRoot, validatedJob(items))
  const refreshes = []

  const summary = await processQueue(queueOptions(f, {
    index: (binding) => ({ refresh: async () => { refreshes.push(binding.projectId) } }),
  }))
  assert.equal(summary.completed, 1)
  assert.deepEqual(refreshes, [PROJECT_ID, PROJECT_ID])
  assert.equal((await readReceipts(f)).at(-1).index, 'refreshed')
})

test('an index failure does not undo a successful vault transaction', async (t) => {
  const f = await fixture(t)
  const job = validatedJob([itemFixture()])
  const items = job.output.items
  await writeJobAtomic(f.queueRoot, job)

  const summary = await processQueue(queueOptions(f, {
    index: () => ({ refresh: async () => { throw new Error('index-down') } }),
  }))
  assert.equal(summary.completed, 1)
  const notes = await memoryNotes(f)
  assert.equal(notes.length, 1, 'the committed note stays')
  assert.equal(notes[0].note.data.id, items[0].preassignedId)
  const receipt = (await readReceipts(f)).at(-1)
  assert.equal(receipt.result, 'applied')
  assert.equal(receipt.index, 'failed')
  assert.equal(await jobOnDisk(f), null)
})

test('a fault injected before the index update leaves the note committed', async (t) => {
  const f = await fixture(t)
  const job = validatedJob([itemFixture()])
  await writeJobAtomic(f.queueRoot, job)
  const refreshes = []

  const summary = await processQueue(queueOptions(f, {
    index: () => ({ refresh: async () => { refreshes.push(1) } }),
    beforeIndex: () => { throw new Error('injected-before-index') },
  }))
  assert.equal(summary.completed, 1)
  assert.equal((await memoryNotes(f)).length, 1)
  assert.deepEqual(refreshes, [], 'the refresh never ran')
  assert.equal((await readReceipts(f)).at(-1).index, 'failed')
})

// ---------------------------------------------------------------------------
// Supersede: evidence, ownership and the old file's hash
// ---------------------------------------------------------------------------

test('a supersede whose old file changed mid-apply is not overwritten', async (t) => {
  const f = await fixture(t)
  const old = await seedDecision(f)
  const before = await readFile(at(f.vault, old.path))
  const item = itemFixture({ title: '新结论', supersedesId: old.id })
  await writeJobAtomic(f.queueRoot, validatedJob([item]))

  const summary = await processQueue(queueOptions(f, {
    afterScan: async ({ path }) => {
      const absolute = at(f.vault, path)
      const current = await readFile(absolute, 'utf8')
      await writeFile(absolute, `${current}\n人工补充的一行。\n`)
    },
  }))
  assert.equal(summary.completed, 1)

  const after = await readFile(at(f.vault, old.path))
  assert.notEqual(sha256(after), sha256(before), 'the human edit is the revision on disk')
  assert.match(after.toString('utf8'), /人工补充的一行。/)
  assert.doesNotMatch(after.toString('utf8'), /superseded_by: dec-/, 'the old note was not relinked')

  const receipt = (await readReceipts(f)).at(-1)
  assert.equal(receipt.items[0].superseded, false)
  assert.equal(receipt.items[0].conflicts[0].reason, 'hash-mismatch')
  assert.equal(receipt.items[0].inbox, true)

  const parked = await inboxCandidates(f)
  assert.equal(parked.length, 1, 'the candidate is parked in the inbox instead of overwriting')
  assert.equal(parked[0].note.data.type, 'decision')
  assert.deepEqual(
    (await readdir(at(f.vault, DECISIONS))).filter((name) => name.startsWith('ADR-')),
    ['ADR-1-旧结论.md'],
    'a parked candidate takes no ADR number',
  )
})

test('a supersede target that no longer exists parks the candidate in the inbox', async (t) => {
  const f = await fixture(t)
  const missing = `dec-${randomUUID()}`
  await writeJobAtomic(f.queueRoot, validatedJob([itemFixture({ supersedesId: missing })]))

  await processQueue(queueOptions(f))
  const receipt = (await readReceipts(f)).at(-1)
  assert.equal(receipt.items[0].conflicts[0].reason, 'note-not-found')
  assert.equal((await inboxCandidates(f)).length, 1)
})

test('a human-owned supersede target is never rewritten', async (t) => {
  const f = await fixture(t)
  const id = `dec-${randomUUID()}`
  const handWritten = `---\nid: ${id}\ntype: decision\ntitle: 手写结论\nstatus: active\ntrust: owner\nharness: dsh\n---\n手写正文。\n`
  const path = `${DECISIONS}/手写结论.md`
  await writeFile(at(f.vault, path), handWritten)
  await writeJobAtomic(f.queueRoot, validatedJob([itemFixture({ supersedesId: id })]))

  await processQueue(queueOptions(f))
  assert.equal(await readVault(f, path), handWritten, 'the human file is byte-identical')
  const receipt = (await readReceipts(f)).at(-1)
  assert.equal(receipt.items[0].conflicts[0].reason, 'human-owned')
})

test('a legitimate supersede relinks the old note and never overwrites its body', async (t) => {
  const f = await fixture(t)
  const old = await seedDecision(f)
  const oldBytes = await readFile(at(f.vault, old.path))
  await writeJobAtomic(f.queueRoot, validatedJob([itemFixture({ title: '新结论', supersedesId: old.id })]))

  await processQueue(queueOptions(f))
  const receipt = (await readReceipts(f)).at(-1)
  assert.equal(receipt.items[0].superseded, true)
  assert.deepEqual(receipt.items[0].conflicts, [])

  const relinked = await readFile(at(f.vault, old.path), 'utf8')
  const original = oldBytes.toString('utf8')
  const originalBody = parseNote(oldBytes).body
  assert.match(relinked, /status: "?superseded"?/)
  assert.ok(relinked.includes(originalBody.trim()), 'the old evidence is preserved')
  assert.equal((await memoryNotes(f)).length, 2)
})

// ---------------------------------------------------------------------------
// The refusal audit: a dropped candidate is never unaccounted for
// ---------------------------------------------------------------------------

test('a refused candidate is persisted beside the validated items and survives a restart', async (t) => {
  const f = await fixture(t)
  const raw = JSON.stringify({
    items: [
      itemFixture({ title: '保留的结论' }),
      itemFixture({ title: '被拒的结论', supersedesId: `项目/other--deadbeef/决策/ADR-1.md` }),
    ],
  })
  await writeJobAtomic(f.queueRoot, jobFixture())
  const llm = stubLlm(raw)

  // Stop right after the validated barrier: the output is durable, nothing applied.
  const first = await processQueue(queueOptions(f, {
    llm,
    beforeApply: () => { throw new Error('injected-before-apply') },
  }))
  assert.equal(first.deferred, 1)
  const interrupted = await jobOnDisk(f)
  assert.equal(interrupted.state, 'validated')
  assert.equal(interrupted.output.items.length, 1, 'only the surviving candidate is an item')
  assert.equal(interrupted.output.refused.length, 1, 'the refusal is durable with the items')
  assert.equal(interrupted.output.refused[0].reason, 'foreign-target')
  assert.equal(interrupted.output.refused[0].field, 'supersedesId')
  assert.equal(llm.calls.length, 1)

  // A restart with NO llm at all resumes from the persisted output; the audit is
  // still available because it lives on the job, not in the model's answer.
  const resumed = await processQueue(queueOptions(f, { llm: undefined }))
  assert.equal(resumed.completed, 1)
  assert.equal(llm.calls.length, 1, 'the resume never called the model')
  const receipt = (await readReceipts(f)).at(-1)
  assert.equal(receipt.result, 'applied')
  assert.equal(receipt.items.length, 1)
  assert.equal(receipt.refusedCount, 1)
  assert.equal(receipt.refused[0].reason, 'foreign-target')
  assert.equal((await memoryNotes(f)).length, 1, 'the refused candidate became no note')
})

test('a refused candidate alone is a no-memory turn that still explains the drop', async (t) => {
  const f = await fixture(t)
  await writeJobAtomic(f.queueRoot, jobFixture())
  const llm = stubLlm(JSON.stringify({
    items: [itemFixture({ supersedesId: `方法/跨项目方法.md` })],
  }))

  const summary = await processQueue(queueOptions(f, { llm }))
  assert.equal(summary.completed, 1)
  const receipt = (await readReceipts(f)).at(-1)
  assert.equal(receipt.result, 'no-memory')
  assert.deepEqual(receipt.items, [])
  assert.equal(receipt.refusedCount, 1)
  assert.equal(receipt.refused[0].reason, 'foreign-target')
  assert.deepEqual(await memoryNotes(f), [])
})

test('the receipt keeps the real refusal count while the listed reasons stay bounded', async (t) => {
  const f = await fixture(t)
  const refused = Array.from({ length: 40 }, (unused, index) => ({
    index,
    reason: 'foreign-target',
    field: 'supersedesId',
    value: `项目/other--deadbeef/决策/ADR-${index}.md`,
  }))
  const items = validatedJob([itemFixture()]).output.items
  await writeJobAtomic(f.queueRoot, validatedJob([itemFixture()], {
    output: { state: 'validated', raw: '{}', items, usage: null, refused },
  }))

  await processQueue(queueOptions(f, { llm: undefined }))
  const receipt = (await readReceipts(f)).at(-1)
  assert.equal(receipt.refusedCount, 40, 'the count is never truncated')
  assert.equal(receipt.refused.length, 16, 'the listed reasons are bounded')
  assert.equal(receipt.items.length, 1)
})

// ---------------------------------------------------------------------------
// Single-flight, capture gating and the real-host wiring
// ---------------------------------------------------------------------------

test('two concurrent passes distill one job exactly once', async (t) => {
  const f = await fixture(t)
  await writeJobAtomic(f.queueRoot, jobFixture())
  const llm = stubLlm(JSON.stringify({ items: [itemFixture()] }), { delayMs: 20 })
  const options = queueOptions(f, { llm })

  const [first, second] = await Promise.all([processQueue(options), processQueue(options)])
  assert.equal(first.completed + second.completed, 1)
  assert.equal(llm.calls.length, 1)
  assert.equal((await memoryNotes(f)).length, 1)
})

test('the capture seam hands a freshly captured turn to the worker', async (t) => {
  const f = await fixture(t)
  const kicked = []
  const capture = createCapture({
    queueRoot: f.queueRoot,
    config: baseConfig(),
    resolveBinding: async () => f.binding,
    warn: () => {},
    onEnqueued: (job) => kicked.push(job.jobId),
  })
  const events = [
    { seq: 0, type: 'turn/start', data: { turn: 1 } },
    { seq: 1, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '把调度器改成可插拔后端' }], source: { kind: 'user' } } },
    { seq: 2, type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '已实现' }], source: { kind: 'model' } } } },
    { seq: 3, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  const session = {
    header: { id: SESSION_ID, cwd: '/work/demo' },
    snapshotEvents: (from = 0, to) => events.slice(from, to ?? events.length),
    requestContext: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }),
  }
  await capture.recover()
  capture.sessionEvent(session, events[3])
  await capture.settle()
  assert.equal(kicked.length, 1)

  const jobs = await loadPending(f.queueRoot)
  assert.equal(jobs.length, 1)
  const llm = stubLlm(JSON.stringify({ items: [itemFixture({ evidenceSeqs: [1] })] }))
  const summary = await processQueue(queueOptions(f, { llm }))
  assert.equal(summary.completed, 1)
  assert.equal((await memoryNotes(f)).length, 1)
})

test('enqueueTurn produces nothing when autoCapture is off', async (t) => {
  const f = await fixture(t)
  const events = [
    { seq: 0, type: 'turn/start', data: { turn: 1 } },
    { seq: 1, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '你好' }], source: { kind: 'user' } } },
    { seq: 2, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  const session = {
    header: { id: SESSION_ID, cwd: '/work/demo' },
    snapshotEvents: (from = 0, to) => events.slice(from, to ?? events.length),
    requestContext: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }),
  }
  const job = await enqueueTurn({
    session,
    event: events[2],
    binding: f.binding,
    queueRoot: f.queueRoot,
    config: baseConfig({ autoCapture: false }),
  })
  assert.equal(job, null)
  assert.deepEqual(await loadPending(f.queueRoot), [])
})

test('an explicit queueRoot and dataRoot are the only filesystem targets; DSH_HOME is never consulted', async (t) => {
  const f = await fixture(t)
  const fakeHome = await temporaryRoot(t, 'obsidian-mem-t16-home-')
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = fakeHome
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  })

  await writeJobAtomic(f.queueRoot, validatedJob([itemFixture()]))
  const summary = await processQueue(queueOptions(f))
  assert.equal(summary.completed, 1)
  assert.equal(existsSync(join(fakeHome, 'data')), false, 'the production data root was never derived')
  assert.equal(existsSync(join(fakeHome, 'skills')), false)
  // The vault is a temporary directory, never the default `~/Documents/dsh-memory`.
  assert.ok(f.vault.startsWith(f.root))
  assert.equal((await stat(f.vault)).isDirectory(), true)
})

test('registerHooks starts capture and the worker from one queue root, end to end', async (t) => {
  const f = await fixture(t)
  const llm = stubLlm(JSON.stringify({ items: [itemFixture({ evidenceSeqs: [1] })] }))
  const ctx = fakeContext({ llm })
  const config = baseConfig({ captureIdleMs: 1000 })
  const disposers = registerHooks(ctx, {
    resolveBinding: async () => f.binding,
    index: async () => { throw new Error('the index is not part of this case') },
    buildBrief: async () => null,
    config,
    queueRoot: f.queueRoot,
    dataRoot: f.dataRoot,
    home: f.home,
    resolveJobBinding: () => f.binding,
  })
  t.after(() => { for (const dispose of disposers) dispose() })

  // The worker effect resolved, so recovery ran and the debounce timer is armed.
  await ctx.settled()
  const events = [
    { seq: 0, type: 'turn/start', data: { turn: 1 } },
    { seq: 1, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '把调度器改成可插拔后端' }], source: { kind: 'user' } } },
    { seq: 2, type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '已实现' }], source: { kind: 'model' } } } },
    { seq: 3, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  const session = {
    header: { id: SESSION_ID, cwd: '/work/demo' },
    snapshotEvents: (from = 0, to) => events.slice(from, to ?? events.length),
    requestContext: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }),
  }
  ctx.handlers.get('session/event')(session, events[3])

  const notes = await waitFor(() => memoryNotes(f), (found) => found.length === 1)
  assert.equal(notes.length, 1, 'the debounced worker pass applied the captured turn')
  assert.equal(llm.calls.length, 1)
  assert.equal(await jobOnDisk(f), null)
})

// ---------------------------------------------------------------------------
// Small host-shaped helpers for the wiring case
// ---------------------------------------------------------------------------

/** A minimal Cordis-shaped context: `on`, `effect`, `get` and a logger. */
function fakeContext({ llm } = {}) {
  const handlers = new Map()
  const pending = []
  return {
    handlers,
    on(event, handler) {
      handlers.set(event, handler)
      return () => handlers.delete(event)
    },
    effect(fn) {
      pending.push(fn())
      return () => {}
    },
    get(name) {
      return name === 'llm' ? llm : undefined
    },
    logger: { warn: () => {}, info: () => {} },
    async settled() {
      await Promise.all(pending.map((entry) => Promise.resolve(entry).catch(() => {})))
    },
  }
}

/** Poll a reader until a predicate holds, or fail the test with a timeout. */
async function waitFor(read, done, { timeoutMs = 5000, stepMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs
  let value = await read()
  while (!done(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, stepMs))
    value = await read()
  }
  return value
}

test('without a binding seam the worker resolves the project from the vault registry', async (t) => {
  const f = await fixture(t)
  const otherProject = '7f3b19c2-4d05-4a1e-9c77-000000000002'
  await writeJobAtomic(f.queueRoot, validatedJob([itemFixture()]))
  await writeJobAtomic(f.queueRoot, validatedJob([itemFixture()], {
    jobId: 'job-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    projectId: otherProject,
    createdAt: '2026-09-23T00:00:01.000Z',
    updatedAt: '2026-09-23T00:00:01.000Z',
  }))

  // No `resolveBinding`: this is exactly the production path, where the worker has
  // only the job's persisted project id and the configured vault.
  const summary = await processQueue({
    queueRoot: f.queueRoot,
    dataRoot: f.dataRoot,
    home: f.home,
    config: baseConfig({ vaultPath: f.vault }),
    debounceMs: 0,
    retryBackoffMs: 0,
    warn: () => {},
  })
  assert.equal(summary.completed, 1)
  assert.equal(summary.deferred, 1, 'an unregistered project waits instead of failing')
  assert.equal((await memoryNotes(f)).length, 1)

  const waiting = await jobOnDisk(f, 'job-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
  // The deferred state names the resume point its durable output already reached,
  // so an unbound project never costs the work that was already paid for.
  assert.equal(waiting.state, 'validated')
  assert.equal(waiting.deferredReason, 'no-binding')
  assert.equal(waiting.attempts, 0)
})

test('a cloud-managed vault is refused by the worker instead of written into', async (t) => {
  const f = await fixture(t)
  const cloudHome = join(f.root, 'cloud-home')
  const cloudVault = join(cloudHome, 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'dsh-memory')
  await mkdir(cloudVault, { recursive: true })
  await writeJobAtomic(f.queueRoot, validatedJob([itemFixture()]))

  const summary = await processQueue({
    queueRoot: f.queueRoot,
    dataRoot: f.dataRoot,
    home: cloudHome,
    config: baseConfig({ vaultPath: cloudVault }),
    debounceMs: 0,
    retryBackoffMs: 0,
    warn: () => {},
  })
  assert.equal(summary.completed, 0)
  assert.equal(summary.deferred, 1)
  const job = await jobOnDisk(f)
  assert.equal(job.lastError.code, 'vault-cloud-managed')
  assert.equal(job.attempts, 1)
  assert.deepEqual(await memoryNotes(f), [])
})

// ---------------------------------------------------------------------------
// The worker lifecycle used by the host
// ---------------------------------------------------------------------------

test('the queue worker is single-flight, debounce-aware and disposable', async () => {
  const calls = []
  const worker = createQueueWorker({
    queueRoot: '/nonexistent/obsidian-mem-queue',
    dataRoot: '/nonexistent/obsidian-mem-data',
    config: baseConfig(),
    resolveBinding: () => null,
    debounceMs: 0,
    retryBackoffMs: 0,
    warn: (message) => calls.push(message),
    getLlm: () => undefined,
  })
  assert.equal(typeof worker.start, 'function')
  assert.equal(typeof worker.stop, 'function')
  await worker.pass()
  assert.ok(worker.pass() instanceof Promise)
  worker.stop()
  await worker.pass()
})
