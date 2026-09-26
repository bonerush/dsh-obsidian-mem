// Task 14: the durable pending queue — 0700 queue directory, 0600 job files,
// written as temporary file → fsync → rename → directory fsync.
//
// Two guarantees are pinned here, and the difference between them is the whole
// point of the module:
//
//   * a job that is visible to `loadPending()` after a fresh process is a job
//     whose bytes AND whose directory entry were fsynced (crash window closed);
//   * a job that was killed between the temporary write and the rename is NOT
//     visible — matching the plan's conservative G3 wording ("at least once
//     after a successful fsync to pending", controller ruling R12). Nothing
//     here claims the turn survives that window.
//
// The crash cases terminate a REAL child process with SIGKILL (no cleanup, no
// handler) instead of simulating one, and every path under test is an explicit
// `mkdtemp` root: no case may read or write the real `~/.dsh`.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  JOB_FILE_MODE,
  PENDING_SCHEMA,
  PROCESSED_DIRNAME,
  QUEUE_DIR_MODE,
  PendingError,
  ensureQueueDir,
  isSafeJobId,
  jobFileName,
  loadPending,
  loadProcessedRecords,
  markJob,
  normalizeJobError,
  processedRecordPath,
  queueRootFor,
  readPendingJobs,
  readProcessedRecords,
  recordProcessedRange,
  writeJobAtomic,
} from '../lib/pending.js'

/** A fresh, private root; nothing in this file uses the process cwd or home. */
async function temporaryRoot(t, name = 'obsidian-mem-t14-pending-') {
  const root = await mkdtemp(join(tmpdir(), name))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 4 }))
  return root
}

/** A complete, valid job — the shape `enqueueTurn` is contracted to produce. */
function jobFixture(overrides = {}) {
  return {
    schema: PENDING_SCHEMA,
    jobId: 'job-0123456789abcdef0123456789abcdef',
    sessionId: 'session-9d4a4c1e-2f1a-4f4e-8b3a-000000000001',
    projectId: '1c392abb-7b08-42f7-871d-2a379caf9448',
    fromSeq: 1,
    toSeq: 7,
    state: 'pending',
    route: { provider: 'deepseek-official', model: 'deepseek-flash' },
    allowedEvents: [
      { kind: 'user', seq: 2, source: 'user' },
      { kind: 'assistant-final', seq: 6 },
    ],
    safeInput:
      '[obsidian-mem] seq 1-7\n--- user (seq 2) ---\nping\n--- assistant-final (seq 6) ---\npong\n',
    credentialSkips: 0,
    omitted: null,
    attempts: 0,
    output: null,
    createdAt: '2026-09-23T00:00:00.000Z',
    updatedAt: '2026-09-23T00:00:00.000Z',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// The queue root: 0700, and the only thing this module creates
// ---------------------------------------------------------------------------

test('the queue directory is created 0700 and never widened', async (t) => {
  const root = await temporaryRoot(t)
  const queueRoot = join(root, 'pending')

  assert.equal(await ensureQueueDir(queueRoot), queueRoot)
  assert.equal((await stat(queueRoot)).mode & 0o777, QUEUE_DIR_MODE)
  assert.equal(QUEUE_DIR_MODE, 0o700)

  // A directory that already exists with a wider mode is tightened, not trusted.
  const loose = join(root, 'loose')
  await mkdir(loose, { recursive: true, mode: 0o755 })
  await ensureQueueDir(loose)
  assert.equal((await stat(loose)).mode & 0o777, 0o700)
})

test('a written job is 0600 and the queue holds no temporary file afterwards', async (t) => {
  const root = await temporaryRoot(t)
  const queueRoot = join(root, 'pending')
  const job = jobFixture()

  const path = await writeJobAtomic(queueRoot, job)
  assert.equal(path, join(queueRoot, jobFileName(job.jobId)))
  assert.equal((await stat(path)).mode & 0o777, JOB_FILE_MODE)
  assert.equal(JOB_FILE_MODE, 0o600)
  assert.equal((await stat(queueRoot)).mode & 0o777, QUEUE_DIR_MODE)

  // A rewrite through markJob leaves the same 0600 guarantee.
  await markJob(job.jobId, { state: 'distilling' }, { queueRoot })
  assert.equal((await stat(path)).mode & 0o777, JOB_FILE_MODE)

  const entries = await readdir(queueRoot)
  assert.deepEqual(entries, [jobFileName(job.jobId)], 'no .tmp file may survive a completed write')
})

// ---------------------------------------------------------------------------
// loadPending / markJob
// ---------------------------------------------------------------------------

test('loadPending returns every committed job in a stable order and ignores temp files', async (t) => {
  const root = await temporaryRoot(t)
  const queueRoot = join(root, 'pending')
  await ensureQueueDir(queueRoot)

  const second = jobFixture({
    jobId: 'job-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    createdAt: '2026-09-23T00:00:02.000Z',
    updatedAt: '2026-09-23T00:00:02.000Z',
  })
  const first = jobFixture({
    jobId: 'job-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    createdAt: '2026-09-23T00:00:01.000Z',
    updatedAt: '2026-09-23T00:00:01.000Z',
  })
  await writeJobAtomic(queueRoot, second)
  await writeJobAtomic(queueRoot, first)
  // A crash-orphaned temporary file is invisible, exactly like one that is
  // still being written.
  await writeFile(join(queueRoot, '.1234.tmp'), '{"half":', { mode: 0o600 })
  // A non-job file is not a job.
  await writeFile(join(queueRoot, 'README'), 'x', { mode: 0o600 })

  const jobs = await loadPending(queueRoot)
  assert.deepEqual(
    jobs.map((job) => job.jobId),
    [first.jobId, second.jobId],
  )
  // Every field the queue contract names survives the round trip verbatim.
  assert.deepEqual(jobs[0], first)
})

test('loadPending on a queue that was never created answers empty, not an error', async (t) => {
  const root = await temporaryRoot(t)
  assert.deepEqual(await loadPending(join(root, 'never-created')), [])
})

test('a corrupt job file is reported through readPendingJobs and skipped by loadPending', async (t) => {
  const root = await temporaryRoot(t)
  const queueRoot = join(root, 'pending')
  await ensureQueueDir(queueRoot)
  const good = jobFixture()
  await writeJobAtomic(queueRoot, good)

  await writeFile(join(queueRoot, 'job-broken.json'), '{"schema":1,', { mode: 0o600 })
  await writeFile(join(queueRoot, 'job-notjson.json'), 'hello', { mode: 0o600 })
  await writeFile(join(queueRoot, 'job-wrongshape.json'), '{"jobId":"job-wrongshape"}', {
    mode: 0o600,
  })

  // One bad file must not hide the recoverable work around it.
  const jobs = await loadPending(queueRoot)
  assert.deepEqual(
    jobs.map((job) => job.jobId),
    [good.jobId],
  )

  const { invalid } = await readPendingJobs(queueRoot)
  assert.deepEqual(invalid.map((entry) => entry.file).sort(), [
    'job-broken.json',
    'job-notjson.json',
    'job-wrongshape.json',
  ])
  for (const entry of invalid) assert.equal(typeof entry.reason, 'string')
})

test('markJob patches one job atomically, preserves its identity, and refuses a path-shaped id', async (t) => {
  const root = await temporaryRoot(t)
  const queueRoot = join(root, 'pending')
  const job = jobFixture()
  await writeJobAtomic(queueRoot, job)

  const marked = await markJob(
    job.jobId,
    {
      state: 'raw-durable',
      output: { raw: '{"items":[]}' },
      attempts: 1,
      // An identity field in the patch must never take effect.
      jobId: 'job-ffffffffffffffffffffffffffffffff',
      sessionId: 'session-rewritten',
    },
    { queueRoot },
  )
  assert.equal(marked.jobId, job.jobId)
  assert.equal(marked.sessionId, job.sessionId)
  assert.equal(marked.state, 'raw-durable')
  assert.deepEqual(marked.output, { raw: '{"items":[]}' })
  assert.equal(marked.attempts, 1)

  const [reread] = await loadPending(queueRoot)
  assert.deepEqual(reread, marked)
  assert.equal((await stat(join(queueRoot, jobFileName(job.jobId)))).mode & 0o777, JOB_FILE_MODE)

  const failed = await markJob(job.jobId, { state: 'failed', attempts: 2 }, { queueRoot })
  assert.equal(failed.state, 'failed')
  assert.equal(failed.attempts, 2)
  assert.equal(await markJob('job-does-not-exist', { state: 'failed' }, { queueRoot }), null)

  await assert.rejects(
    () => markJob('../escape', { state: 'failed' }, { queueRoot }),
    (error) => error instanceof PendingError && error.code === 'job-id-invalid',
  )
  assert.equal(isSafeJobId('../escape'), false)
  assert.equal(isSafeJobId('job-ok'), true)
  assert.equal(existsSync(join(root, 'escape.json')), false)
})

test('queueRootFor places the queue under the one plugin data root', () => {
  assert.equal(queueRootFor('/data/obsidian-mem'), join('/data/obsidian-mem', 'pending'))
})

// The two shapes this has to survive are both real: `capture.js` writes an object
// whose `message` is `describeError`'s output and therefore already carries the
// code, and an older or hand-written job file may carry the bare string. Printing
// the code twice would misreport the reason, and printing nothing is the defect
// this normalizer exists to close.
test('normalizeJobError renders every stored shape as one line, never a doubled code', () => {
  assert.equal(
    normalizeJobError({
      code: 'too-many-items',
      message: 'too-many-items: the model returned 15 items',
      at: '2026-09-25T09:45:27.499Z',
    }),
    'too-many-items: the model returned 15 items',
  )
  assert.equal(
    normalizeJobError({ code: 'aborted', message: 'the stream ended' }),
    'aborted: the stream ended',
  )
  assert.equal(normalizeJobError({ code: 'aborted', message: '' }), 'aborted')
  assert.equal(normalizeJobError({ message: 'unprintable error' }), 'unprintable error')
  assert.equal(normalizeJobError('MISSING_CREDENTIAL'), 'MISSING_CREDENTIAL')
  assert.equal(normalizeJobError(''), null)
  assert.equal(normalizeJobError(null), null)
  assert.equal(normalizeJobError(undefined), null)
  assert.equal(normalizeJobError(42), null)
})

// ---------------------------------------------------------------------------
// The processed floor: durable memory of what the queue already handed off
// ---------------------------------------------------------------------------

test('a processed record is 0600 inside a 0700 sub-directory and is never read as a job', async (t) => {
  const root = await temporaryRoot(t)
  const queueRoot = join(root, 'pending')
  const job = jobFixture()
  await writeJobAtomic(queueRoot, job)

  const record = await recordProcessedRange(queueRoot, {
    sessionId: job.sessionId,
    fromSeq: job.fromSeq,
    toSeq: job.toSeq,
    jobId: job.jobId,
    at: '2026-09-23T00:00:00.000Z',
  })
  assert.deepEqual(record.ranges, [[job.fromSeq, job.toSeq]])

  const directory = join(queueRoot, PROCESSED_DIRNAME)
  assert.equal((await stat(directory)).mode & 0o777, QUEUE_DIR_MODE)
  const [name] = await readdir(directory)
  assert.equal((await stat(join(directory, name))).mode & 0o777, JOB_FILE_MODE)

  // The processed record is state, not work: `loadPending` must not see it.
  const jobs = await loadPending(queueRoot)
  assert.deepEqual(
    jobs.map((entry) => entry.jobId),
    [job.jobId],
  )
})

test('a processed record only grows: ranges merge and never shrink', async (t) => {
  const root = await temporaryRoot(t)
  const queueRoot = join(root, 'pending')
  const sessionId = 'session-floor-1'

  await recordProcessedRange(queueRoot, { sessionId, fromSeq: 4, toSeq: 6 })
  await recordProcessedRange(queueRoot, { sessionId, fromSeq: 1, toSeq: 3 })
  const disjoint = await recordProcessedRange(queueRoot, { sessionId, fromSeq: 9, toSeq: 9 })
  assert.deepEqual(disjoint.ranges, [
    [1, 6],
    [9, 9],
  ])

  // Re-recording a contained range is a no-op...
  assert.deepEqual(
    (await recordProcessedRange(queueRoot, { sessionId, fromSeq: 2, toSeq: 2 })).ranges,
    [
      [1, 6],
      [9, 9],
    ],
  )
  // ... and a new range only ever adds coverage.
  assert.deepEqual(
    (await recordProcessedRange(queueRoot, { sessionId, fromSeq: 0, toSeq: 0 })).ranges,
    [
      [0, 6],
      [9, 9],
    ],
  )

  const records = await loadProcessedRecords(queueRoot)
  assert.deepEqual(records.get(sessionId).ranges, [
    [0, 6],
    [9, 9],
  ])
  assert.equal(records.size, 1)
})

test('readProcessedRecords reports a corrupt record instead of dropping it silently', async (t) => {
  const root = await temporaryRoot(t)
  const queueRoot = join(root, 'pending')
  await recordProcessedRange(queueRoot, { sessionId: 'session-good', fromSeq: 0, toSeq: 3 })
  const directory = join(queueRoot, PROCESSED_DIRNAME)
  await writeFile(join(directory, 'broken.json'), '{"sessionId":', { mode: 0o600 })

  const { records, invalid } = await readProcessedRecords(queueRoot)
  assert.deepEqual([...records.keys()], ['session-good'])
  assert.equal(invalid.length, 1)
  assert.match(invalid[0].file, /broken\.json$/)
})

test('a corrupt processed record fails closed instead of being overwritten', async (t) => {
  const root = await temporaryRoot(t)
  const queueRoot = join(root, 'pending')
  const sessionId = 'session-corrupt-floor'
  const path = processedRecordPath(queueRoot, sessionId)
  await ensureQueueDir(join(queueRoot, PROCESSED_DIRNAME))
  const corrupt = '{"sessionId":"session-corrupt-floor","ranges":"not-a-list"}'
  await writeFile(path, corrupt, { mode: 0o600 })

  // Dropping an unreadable record would silently lose coverage and re-enable
  // the duplicate re-enqueue this floor exists to prevent.
  await assert.rejects(
    () => recordProcessedRange(queueRoot, { sessionId, fromSeq: 0, toSeq: 5 }),
    (error) => error instanceof PendingError && error.code === 'processed-invalid',
  )
  assert.equal(
    await readFile(path, 'utf8'),
    corrupt,
    'the unusable record is reported, not repaired',
  )
  assert.equal((await readProcessedRecords(queueRoot)).invalid.length, 1)
})

test('a processed record refuses a range that is not a non-negative half-open pair', async (t) => {
  const root = await temporaryRoot(t)
  const queueRoot = join(root, 'pending')
  await assert.rejects(
    () => recordProcessedRange(queueRoot, { sessionId: 's', fromSeq: 5, toSeq: 1 }),
    (error) => error instanceof PendingError && error.code === 'processed-invalid',
  )
  await assert.rejects(() =>
    recordProcessedRange(queueRoot, { sessionId: '', fromSeq: 0, toSeq: 1 }),
  )
})

// ---------------------------------------------------------------------------
// The crash window, measured with a real SIGKILL
// ---------------------------------------------------------------------------

const CRASH_CHILD = `
const { enqueueTurn } = await import(process.env.T14_CAPTURE_URL)
const mode = process.argv[2]
const queueRoot = process.argv[3]
const EVENTS = [
  { seq: 0, type: 'turn/start', data: { turn: 1 } },
  { seq: 1, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: 'crash-window probe' }], source: { kind: 'user' } } },
  { seq: 2, type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'committed answer' }], source: { kind: 'model' } } } },
  { seq: 3, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
]
const session = {
  header: { id: 'session-crash-1', cwd: '/work/demo' },
  snapshotEvents(from = 0, to) {
    const end = to ?? EVENTS.length
    return EVENTS.slice(from, end)
  },
  requestContext: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }),
}
const binding = { kind: 'bound', projectId: '1c392abb-7b08-42f7-871d-2a379caf9448' }
const config = { captureIdleMs: 90000, distill: { maxInputChars: 24000 } }
const options = { session, event: EVENTS[3], binding, queueRoot, config }
if (mode === 'after-fsync') {
  await enqueueTurn(options)
  process.kill(process.pid, 'SIGKILL')
} else {
  // Killed at the exact boundary: bytes fsynced, rename not yet issued.
  await enqueueTurn({ ...options, beforeRename: () => { process.kill(process.pid, 'SIGKILL') } })
}
`

async function runCrashChild(t, root, mode) {
  const script = join(root, 'crash-child.mjs')
  await writeFile(script, CRASH_CHILD, 'utf8')
  const queueRoot = join(root, 'pending')
  const result = spawnSync(process.execPath, [script, mode, queueRoot], {
    encoding: 'utf8',
    env: {
      ...process.env,
      T14_CAPTURE_URL: new URL('../lib/capture.js', import.meta.url).href,
    },
  })
  assert.equal(result.signal, 'SIGKILL', `the child must be killed, stderr: ${result.stderr}`)
  return queueRoot
}

test('a job killed after the fsync is visible to the next process', async (t) => {
  const root = await temporaryRoot(t, 'obsidian-mem-t14-crash-after-')
  const queueRoot = await runCrashChild(t, root, 'after-fsync')

  const jobs = await loadPending(queueRoot)
  assert.equal(jobs.length, 1, 'an fsynced job survives SIGKILL')
  assert.equal(jobs[0].state, 'pending')
  assert.equal(jobs[0].sessionId, 'session-crash-1')
  assert.equal(jobs[0].toSeq, 3)
  assert.equal(jobs[0].allowedEvents.map((entry) => entry.kind).join(','), 'user,assistant-final')
  assert.match(jobs[0].safeInput, /committed answer/)
  assert.equal((await stat(queueRoot)).mode & 0o777, QUEUE_DIR_MODE)
  assert.equal(
    (await stat(join(queueRoot, jobFileName(jobs[0].jobId)))).mode & 0o777,
    JOB_FILE_MODE,
  )
})

test('a kill between the temporary write and the rename leaves no visible job (R12 boundary)', async (t) => {
  const root = await temporaryRoot(t, 'obsidian-mem-t14-crash-before-')
  const queueRoot = await runCrashChild(t, root, 'before-rename')

  // The bytes were written and fsynced — the temporary file proves it — but the
  // rename never happened, so no reader may see a job. This is the honest edge
  // of the guarantee, not a bug.
  assert.deepEqual(await loadPending(queueRoot), [])
  const entries = await readdir(queueRoot)
  assert.ok(
    entries.some((name) => name.endsWith('.tmp')),
    'the pre-rename bytes exist',
  )
  assert.equal(entries.filter((name) => name.endsWith('.json')).length, 0)
  const raw = await readFile(
    join(
      queueRoot,
      entries.find((name) => name.endsWith('.tmp')),
    ),
    'utf8',
  )
  assert.match(raw, /committed answer/)
})
