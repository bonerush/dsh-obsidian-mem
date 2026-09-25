// Task 14: completed-turn capture — the whitelist projection, the credential
// scrub, the 90-second coalescing rule and the successor rule.
//
// Every case builds a REAL root-session event log (the shapes measured in
// `docs/p0-compatibility.md`: `turn/end.reason.kind`, `assistant/message`
// content parts, `source.kind`, `requestContext`) and drives the shipped
// `enqueueTurn`/`createCapture` through it. Nothing here reads a credential
// store, calls a model, or touches the real `~/.dsh`: each case gets an
// explicit `mkdtemp` queue root, and the containment case proves the process
// `DSH_HOME` is never even looked at.
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { existsSync, statSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createCapture, enqueueTurn } from '../lib/capture.js'
import { registerHooks } from '../lib/hooks.js'
import { jobFileName, loadPending, loadProcessedRecords } from '../lib/pending.js'

/** Fixed, valid UUIDv4 identity (version nibble `4`, variant nibble `8`). */
const PROJECT_ID = '1c392abb-7b08-42f7-871d-2a379caf9448'
const SESSION_ID = 'session-9d4a4c1e-2f1a-4f4e-8b3a-000000000001'
const CWD = '/work/demo'

const BINDING = Object.freeze({
  kind: 'bound',
  projectId: PROJECT_ID,
  slug: 'demo',
  displayName: 'Demo Project',
  schema: 1,
  vaultRoot: '/vault',
  repoRoot: CWD,
  relativeDir: `Projects/demo--${PROJECT_ID.slice(0, 8)}`,
})

const CONFIG = Object.freeze({ captureIdleMs: 90000, distill: { maxInputChars: 24000 } })

async function temporaryRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'obsidian-mem-t14-capture-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 4 }))
  return root
}

async function queueIn(t) {
  return join(await temporaryRoot(t), 'pending')
}

// ---------------------------------------------------------------------------
// Event-log fixtures (seq === array index, so `snapshotEvents` slices exactly)
// ---------------------------------------------------------------------------

const text = (value) => ({ type: 'text', text: value })
const reasoning = (value) => ({ type: 'reasoning', text: value })
const toolCallPart = (name) => ({ type: 'tool-call', id: `call-${name}`, name, arguments: '{}' })

const at = (seq, type, data) => ({ seq, type, data, time: 1_700_000_000_000 + seq })

const turnStart = (seq, turn = 1) => at(seq, 'turn/start', { turn })
const userMessage = (seq, value, source = 'user') =>
  at(seq, 'user/message', {
    id: `u${seq}`,
    role: 'user',
    content: [text(value)],
    source: { kind: source },
  })
const assistantMessage = (seq, parts, turn = 1, step = 1) =>
  at(seq, 'assistant/message', {
    turn,
    step,
    message: { id: `a${seq}`, role: 'assistant', content: parts, source: { kind: 'model' } },
  })
const toolCall = (seq, name, callId = `call-${name}`, turn = 1, step = 1) =>
  at(seq, 'tool/call', {
    turn,
    step,
    callId,
    name,
    arguments: '{}',
  })
const toolResult = (
  seq,
  textValue,
  { callId = 'call-bash', isError = false, turn = 1, step = 1 } = {},
) =>
  at(seq, 'tool/result', {
    turn,
    step,
    message: {
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: callId, content: [text(textValue)], isError }],
      source: { kind: 'tool', callId },
    },
  })
const turnEnd = (seq, reason, turn = 1) => at(seq, 'turn/end', { turn, reason })

const COMPLETED = { kind: 'completed' }
const ABORTED = { kind: 'aborted', reason: { kind: 'user' } }
const MISSING_CREDENTIAL = {
  kind: 'error',
  error: { code: 'MISSING_CREDENTIAL', message: 'no API key' },
}

function sessionOf(
  events,
  {
    id = SESSION_ID,
    header = {},
    route = { provider: 'deepseek-official', model: 'deepseek-flash' },
  } = {},
) {
  return {
    header: { id, cwd: CWD, ...header },
    snapshotEvents(from = 0, to) {
      const end = to ?? events.length
      return events.slice(from, end)
    },
    requestContext() {
      return route ?? undefined
    },
  }
}

/** One complete, well-formed turn: a real user prompt and a final answer. */
function simpleTurn() {
  return [
    turnStart(0),
    userMessage(1, 'implement the queue'),
    userMessage(2, 'plugin-injected system context', 'plugin'),
    at(3, 'request/context', { provider: 'deepseek-official', model: 'deepseek-flash' }),
    assistantMessage(4, [text('committed final answer')]),
    turnEnd(5, COMPLETED),
  ]
}

// ---------------------------------------------------------------------------
// Step 1's canonical assertion, verbatim in spirit
// ---------------------------------------------------------------------------

test('a completed root turn with a real user message enqueues a bounded, auditable job', async (t) => {
  const queueRoot = await queueIn(t)
  const events = simpleTurn()
  const session = sessionOf(events)

  const job = await enqueueTurn({
    session,
    event: events.at(-1),
    binding: BINDING,
    queueRoot,
    config: CONFIG,
  })

  assert.notEqual(job, null)
  assert.deepEqual(
    job.allowedEvents.map((entry) => entry.kind),
    ['user', 'assistant-final'],
  )
  assert.ok([...job.safeInput].length <= CONFIG.distill.maxInputChars)
  assert.equal(statSync(queueRoot).mode & 0o777, 0o700)

  // The white-listed seqs are the audit trail: the plugin-injected message at
  // seq 2 is not in it, and neither is anything without a text body.
  assert.deepEqual(
    job.allowedEvents.map((entry) => entry.seq),
    [1, 4],
  )
  assert.ok(!job.safeInput.includes('plugin-injected system context'))
  assert.ok(job.safeInput.includes('implement the queue'))
  assert.ok(job.safeInput.includes('committed final answer'))

  // PendingJob's required shape.
  for (const key of [
    'jobId',
    'sessionId',
    'projectId',
    'fromSeq',
    'toSeq',
    'state',
    'route',
    'allowedEvents',
    'safeInput',
  ]) {
    assert.ok(key in job, `the job must carry ${key}`)
  }
  assert.equal(job.sessionId, SESSION_ID)
  assert.equal(job.projectId, PROJECT_ID)
  assert.equal(job.fromSeq, 0)
  assert.equal(job.toSeq, 5)
  assert.deepEqual(job.route, { provider: 'deepseek-official', model: 'deepseek-flash' })
  assert.equal(job.attempts, 0)
  assert.equal(job.output, null)
  assert.equal(job.credentialSkips, 0)
})

// ---------------------------------------------------------------------------
// Eligibility: only completed root turns with a real user message
// ---------------------------------------------------------------------------

test('a cancelled turn and an errored turn never enter the input snapshot', async (t) => {
  const queueRoot = await queueIn(t)
  for (const reason of [ABORTED, MISSING_CREDENTIAL, { kind: 'max-tokens' }, { kind: 'blocked' }]) {
    const events = [
      turnStart(0),
      userMessage(1, 'a question whose answer never came'),
      at(2, 'request/context', { provider: 'deepseek-official', model: 'deepseek-flash' }),
      reason.kind === 'error'
        ? at(3, 'assistant/attempt', { turn: 1, step: 1, stream: [] })
        : assistantMessage(3, [text('a draft that was never accepted')]),
      turnEnd(4, reason),
    ]
    assert.equal(
      await enqueueTurn({
        session: sessionOf(events),
        event: events.at(-1),
        binding: BINDING,
        queueRoot,
        config: CONFIG,
      }),
      null,
      `reason ${reason.kind} must not enqueue`,
    )
  }
  assert.deepEqual(await loadPending(queueRoot), [])
})

test('the legacy string reason is accepted, and anything else is refused', async (t) => {
  const queueRoot = await queueIn(t)
  const completed = [
    turnStart(0),
    userMessage(1, 'hi'),
    assistantMessage(2, [text('done')]),
    turnEnd(3, 'completed'),
  ]
  const job = await enqueueTurn({
    session: sessionOf(completed),
    event: completed.at(-1),
    binding: BINDING,
    queueRoot,
    config: CONFIG,
  })
  assert.notEqual(
    job,
    null,
    "a host that records the bare string 'completed' is still a completed turn",
  )

  const weird = [turnStart(0), userMessage(1, 'hi'), turnEnd(2, { kind: 'something-new' })]
  assert.equal(
    await enqueueTurn({
      session: sessionOf(weird),
      event: weird.at(-1),
      binding: BINDING,
      queueRoot,
      config: CONFIG,
    }),
    null,
  )
})

test('a child-agent session is never captured, by either header field', async (t) => {
  const queueRoot = await queueIn(t)
  const events = simpleTurn()
  const child = sessionOf(events, { header: { parentSession: 'session-parent-1' } })
  assert.equal(
    await enqueueTurn({
      session: child,
      event: events.at(-1),
      binding: BINDING,
      queueRoot,
      config: CONFIG,
    }),
    null,
  )

  const subagent = sessionOf(events, { header: { origin: 'subagent', delegationDepth: 2 } })
  assert.equal(
    await enqueueTurn({
      session: subagent,
      event: events.at(-1),
      binding: BINDING,
      queueRoot,
      config: CONFIG,
    }),
    null,
  )
  assert.deepEqual(await loadPending(queueRoot), [])
})

test('plugin-injected and tool-sourced user messages do not count as a real user turn', async (t) => {
  const queueRoot = await queueIn(t)
  const events = [
    turnStart(0),
    userMessage(1, 'system prompt snapshot', 'plugin'),
    userMessage(2, 'skill catalogue', 'skill-catalog'),
    assistantMessage(3, [text('a reply to nothing the user said')]),
    turnEnd(4, COMPLETED),
  ]
  assert.equal(
    await enqueueTurn({
      session: sessionOf(events),
      event: events.at(-1),
      binding: BINDING,
      queueRoot,
      config: CONFIG,
    }),
    null,
  )
  assert.deepEqual(await loadPending(queueRoot), [])
})

test('an unbound project is not a capture target', async (t) => {
  const queueRoot = await queueIn(t)
  const events = simpleTurn()
  for (const binding of [
    null,
    { kind: 'unbound' },
    { kind: 'conflict', reason: 'vault-cloud-managed' },
  ]) {
    assert.equal(
      await enqueueTurn({
        session: sessionOf(events),
        event: events.at(-1),
        binding,
        queueRoot,
        config: CONFIG,
      }),
      null,
    )
  }
  assert.deepEqual(await loadPending(queueRoot), [])
})

// ---------------------------------------------------------------------------
// The whitelist projection
// ---------------------------------------------------------------------------

test('the pre-tool draft is discarded in favour of the last tool-call-free assistant text', async (t) => {
  const queueRoot = await queueIn(t)
  const events = [
    turnStart(0),
    userMessage(1, 'fix the parser'),
    assistantMessage(2, [text('DRAFT: I will look at the parser'), toolCallPart('bash')]),
    toolCall(3, 'bash'),
    toolResult(4, 'RAW_TOOL_OUTPUT: parser.js:12 unexpected token'),
    assistantMessage(5, [text('FINAL: the parser is fixed')]),
    turnEnd(6, COMPLETED),
  ]
  const job = await enqueueTurn({
    session: sessionOf(events),
    event: events.at(-1),
    binding: BINDING,
    queueRoot,
    config: CONFIG,
  })

  assert.deepEqual(
    job.allowedEvents.map((entry) => entry.kind),
    ['user', 'tool', 'assistant-final'],
  )
  assert.deepEqual(
    job.allowedEvents.map((entry) => entry.seq),
    [1, 4, 5],
  )
  assert.deepEqual(job.allowedEvents[1], { kind: 'tool', seq: 4, name: 'bash', ok: true })
  assert.ok(job.safeInput.includes('FINAL: the parser is fixed'))
  assert.ok(!job.safeInput.includes('DRAFT:'))
  assert.ok(
    !job.safeInput.includes('RAW_TOOL_OUTPUT'),
    'raw tool output never reaches the snapshot',
  )
  assert.ok(
    !JSON.stringify(job).includes('RAW_TOOL_OUTPUT'),
    'not even the persisted job records it',
  )
})

test('a tool call that failed is recorded as a failed tool, still without its output', async (t) => {
  const queueRoot = await queueIn(t)
  const events = [
    turnStart(0),
    userMessage(1, 'run it'),
    assistantMessage(2, [toolCallPart('bash')]),
    toolCall(3, 'bash'),
    toolResult(4, 'SECRET_PERMISSION_DENIED_TAIL', { isError: true }),
    assistantMessage(5, [text('it failed')]),
    turnEnd(6, COMPLETED),
  ]
  const job = await enqueueTurn({
    session: sessionOf(events),
    event: events.at(-1),
    binding: BINDING,
    queueRoot,
    config: CONFIG,
  })
  assert.deepEqual(
    job.allowedEvents.find((entry) => entry.kind === 'tool'),
    { kind: 'tool', seq: 4, name: 'bash', ok: false },
  )
  assert.ok(!job.safeInput.includes('SECRET_PERMISSION_DENIED_TAIL'))
})

test('thinking blocks are never part of the model-facing text', async (t) => {
  const queueRoot = await queueIn(t)
  const events = [
    turnStart(0),
    userMessage(1, 'answer me'),
    assistantMessage(2, [reasoning('THINKING_MARKER: private chain'), text('the answer')]),
    turnEnd(3, COMPLETED),
  ]
  const job = await enqueueTurn({
    session: sessionOf(events),
    event: events.at(-1),
    binding: BINDING,
    queueRoot,
    config: CONFIG,
  })
  assert.ok(job.safeInput.includes('the answer'))
  assert.ok(!job.safeInput.includes('THINKING_MARKER'))
})

test('a completed turn/end with no matching turn/start does not widen its window to seq 0', async (t) => {
  const queueRoot = await queueIn(t)
  const events = [
    turnStart(0, 1),
    // A turn-field-less message of an ABORTED turn. Without a start anchor the
    // window fallback would be `[0, end]` and would admit this.
    userMessage(1, 'ABORTED_MARKER'),
    turnEnd(2, ABORTED, 1),
    // A second turn whose `turn/start` was never committed.
    userMessage(3, 'ORPHAN_USER_MARKER'),
    assistantMessage(4, [text('orphan final')], 2),
    turnEnd(5, COMPLETED, 2),
  ]
  assert.equal(
    await enqueueTurn({
      session: sessionOf(events),
      event: events[5],
      binding: BINDING,
      queueRoot,
      config: CONFIG,
    }),
    null,
    'without a turn/start the turn cannot be attributed, so nothing is captured',
  )
  assert.deepEqual(await loadPending(queueRoot), [])
})

test('a message that fails the credential scrub is skipped whole and counted', async (t) => {
  const queueRoot = await queueIn(t)
  const cases = [
    ['aws', 'deploy with AKIAIOSFODNN7EXAMPLE please'],
    ['github', 'use ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 to push'],
    ['github-pat', 'use github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz to push'],
    [
      'pem',
      'here it is:\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----',
    ],
    [
      'pgp',
      'here it is:\n-----BEGIN PGP PRIVATE KEY BLOCK-----\nVersion: GnuPG\n-----END PGP PRIVATE KEY BLOCK-----',
    ],
    ['bearer', 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig'],
  ]
  for (const [label, tainted] of cases) {
    const events = [
      turnStart(0),
      userMessage(1, tainted),
      assistantMessage(2, [text('a clean final answer')]),
      turnEnd(3, COMPLETED),
    ]
    const job = await enqueueTurn({
      session: sessionOf(events, { id: `session-${label}` }),
      event: events.at(-1),
      binding: BINDING,
      queueRoot,
      config: CONFIG,
    })
    assert.notEqual(job, null, label)
    assert.equal(job.credentialSkips, 1, `${label}: the hit is counted`)
    assert.deepEqual(
      job.allowedEvents.map((entry) => entry.kind),
      ['assistant-final'],
      `${label}: the message is skipped whole`,
    )
    assert.ok(
      !/AKIA|ghp_|github_pat_|PRIVATE KEY|Bearer/.test(job.safeInput),
      `${label}: nothing of the secret survives`,
    )
    assert.ok(!JSON.stringify(job).includes('AKIAIOSFODNN7EXAMPLE'))
  }
})

test('a credential hit on the final answer leaves the user message and no conclusion', async (t) => {
  const queueRoot = await queueIn(t)
  const events = [
    turnStart(0),
    userMessage(1, 'what happened?'),
    assistantMessage(2, [text('the key is AKIAIOSFODNN7EXAMPLE')]),
    turnEnd(3, COMPLETED),
  ]
  const job = await enqueueTurn({
    session: sessionOf(events),
    event: events.at(-1),
    binding: BINDING,
    queueRoot,
    config: CONFIG,
  })
  assert.equal(job.credentialSkips, 1)
  assert.deepEqual(
    job.allowedEvents.map((entry) => entry.kind),
    ['user'],
  )
  assert.ok(job.safeInput.includes('what happened?'))
  assert.ok(!job.safeInput.includes('AKIA'))
})

// ---------------------------------------------------------------------------
// Bounds and the omission record
// ---------------------------------------------------------------------------

test('safeInput respects maxInputChars and records what it had to omit', async (t) => {
  const queueRoot = await queueIn(t)
  const config = { captureIdleMs: 90000, distill: { maxInputChars: 256 } }
  const huge = 'X'.repeat(4000)
  const events = [
    turnStart(0),
    userMessage(1, `OLDER USER ${huge}`),
    assistantMessage(2, [text(`OLDER FINAL ${huge}`)]),
    turnEnd(3, COMPLETED),
    turnStart(4, 2),
    userMessage(5, 'NEWER USER question'),
    assistantMessage(6, [text('NEWER FINAL answer')]),
    turnEnd(7, COMPLETED, 2),
  ]
  const session = sessionOf(events)
  await enqueueTurn({
    session,
    event: events[3],
    binding: BINDING,
    queueRoot,
    config,
    now: 1_000_000,
  })
  const job = await enqueueTurn({
    session,
    event: events[7],
    binding: BINDING,
    queueRoot,
    config,
    now: 1_000_000 + 1_000,
  })
  assert.equal(job.toSeq, 7, 'the two turns coalesced, so the budget covers both')
  assert.ok([...job.safeInput].length <= 256, 'the hard bound holds even for oversized content')
  assert.equal(job.truncated, true)
  assert.ok(job.omitted !== null, 'what was dropped is recorded')
  assert.ok(job.omitted.seqs.includes(1) || job.omitted.seqs.includes(2))
  assert.ok(Number.isSafeInteger(job.omitted.fromSeq) && Number.isSafeInteger(job.omitted.toSeq))
})

test('a turn with nothing left after scrubbing is not enqueued', async (t) => {
  const queueRoot = await queueIn(t)
  const events = [turnStart(0), userMessage(1, 'AKIAIOSFODNN7EXAMPLE'), turnEnd(2, COMPLETED)]
  assert.equal(
    await enqueueTurn({
      session: sessionOf(events),
      event: events.at(-1),
      binding: BINDING,
      queueRoot,
      config: CONFIG,
    }),
    null,
  )
  assert.deepEqual(await loadPending(queueRoot), [])
})

// ---------------------------------------------------------------------------
// Durability and idempotency
// ---------------------------------------------------------------------------

test('the same completed turn enqueues exactly once, with a stable jobId', async (t) => {
  const queueRoot = await queueIn(t)
  const events = simpleTurn()
  const session = sessionOf(events)
  const first = await enqueueTurn({
    session,
    event: events.at(-1),
    binding: BINDING,
    queueRoot,
    config: CONFIG,
  })
  const second = await enqueueTurn({
    session,
    event: events.at(-1),
    binding: BINDING,
    queueRoot,
    config: CONFIG,
  })
  assert.equal(second, null, 'an already-handled turn is not enqueued a second time')
  assert.equal((await loadPending(queueRoot)).length, 1)

  // The id is a pure function of the project, session and seq range: a fresh
  // queue over the same events mints the same id.
  const otherQueue = await queueIn(t)
  const again = await enqueueTurn({
    session,
    event: events.at(-1),
    binding: BINDING,
    queueRoot: otherQueue,
    config: CONFIG,
  })
  assert.equal(again.jobId, first.jobId)
})

test('one flush barrier serializes its captures so several completed turns coalesce', async (t) => {
  const queueRoot = await queueIn(t)
  const events = [
    turnStart(0, 1),
    userMessage(1, 'first turn'),
    assistantMessage(2, [text('first final')], 1),
    turnEnd(3, COMPLETED, 1),
    turnStart(4, 2),
    userMessage(5, 'second turn'),
    assistantMessage(6, [text('second final')], 2),
    turnEnd(7, COMPLETED, 2),
    turnStart(8, 3),
    userMessage(9, 'third turn'),
    assistantMessage(10, [text('third final')], 3),
    turnEnd(11, COMPLETED, 3),
  ]
  const capture = createCapture({
    queueRoot,
    config: CONFIG,
    // Yield a full macrotask so every capture reaches the queue together: the
    // barrier must still hand them over one at a time.
    resolveBinding: async () => {
      await new Promise((resolve) => setImmediate(resolve))
      return BINDING
    },
    now: () => 1_000_000,
  })
  await capture.recover()
  await capture.flush(sessionOf(events))

  const jobs = await loadPending(queueRoot)
  assert.equal(jobs.length, 1, 'three completed turns in one barrier are one debounced job')
  assert.equal(jobs[0].fromSeq, 0)
  assert.equal(jobs[0].toSeq, 11)
})

test('two concurrent enqueueTurn calls merge instead of racing past each other', async (t) => {
  const queueRoot = await queueIn(t)
  const events = [
    turnStart(0, 1),
    userMessage(1, 'first turn'),
    assistantMessage(2, [text('first final')], 1),
    turnEnd(3, COMPLETED, 1),
    turnStart(4, 2),
    userMessage(5, 'second turn'),
    assistantMessage(6, [text('second final')], 2),
    turnEnd(7, COMPLETED, 2),
  ]
  const session = sessionOf(events)
  const [first, second] = await Promise.all([
    enqueueTurn({
      session,
      event: events[3],
      binding: BINDING,
      queueRoot,
      config: CONFIG,
      now: 1_000_000,
    }),
    enqueueTurn({
      session,
      event: events[7],
      binding: BINDING,
      queueRoot,
      config: CONFIG,
      now: 1_000_000,
    }),
  ])
  assert.notEqual(first, null)
  assert.notEqual(second, null)
  assert.equal(second.jobId, first.jobId, 'the second call saw the first job and merged into it')
  const jobs = await loadPending(queueRoot)
  assert.equal(jobs.length, 1)
  assert.equal(jobs[0].fromSeq, 0)
  assert.equal(jobs[0].toSeq, 7)
})

// ---------------------------------------------------------------------------
// The durable floor: a restart with an empty queue must not redo finished work
// ---------------------------------------------------------------------------

test('after a restart with a consumed queue, flush does not re-enqueue finished turns', async (t) => {
  const queueRoot = await queueIn(t)
  const events = simpleTurn()
  const session = sessionOf(events)

  const first = captureFor(queueRoot)
  await first.recover()
  await first.flush(session)
  const [job] = await loadPending(queueRoot)
  assert.notEqual(job, undefined)

  // Task 16 applies the job and deletes it; the queue is empty afterwards.
  await rm(join(queueRoot, jobFileName(job.jobId)))
  assert.deepEqual(await loadPending(queueRoot), [])

  // A new process: fresh capture state, empty queue, the same committed session.
  const restarted = captureFor(queueRoot)
  const { recovered } = await restarted.recover()
  assert.equal(recovered, 0, 'the queue really is empty after completion')
  await restarted.flush(session)
  assert.deepEqual(
    await loadPending(queueRoot),
    [],
    'a finished turn is not re-enqueued after a restart',
  )
})

test('a genuinely unprocessed completed turn is still picked up after a restart', async (t) => {
  const queueRoot = await queueIn(t)
  const firstTurn = simpleTurn()
  const first = captureFor(queueRoot)
  await first.recover()
  await first.flush(sessionOf(firstTurn))
  const [job] = await loadPending(queueRoot)
  await rm(join(queueRoot, jobFileName(job.jobId)))

  // The first turn is finished; a second turn completes against the same
  // committed session, and the old queue is empty.
  const extended = [
    ...firstTurn,
    turnStart(6, 2),
    userMessage(7, 'a genuinely new completed turn'),
    assistantMessage(8, [text('second final')], 2),
    turnEnd(9, COMPLETED, 2),
  ]
  const restarted = captureFor(queueRoot)
  await restarted.recover()
  await restarted.flush(sessionOf(extended))

  const jobs = await loadPending(queueRoot)
  assert.equal(jobs.length, 1)
  assert.equal(jobs[0].toSeq, 9)
  assert.ok(jobs[0].safeInput.includes('a genuinely new completed turn'))
  assert.ok(
    !jobs[0].safeInput.includes('implement the queue'),
    'the finished turn is not re-captured',
  )
})

test('the processed floor grows with each capture and is reported on recovery', async (t) => {
  const queueRoot = await queueIn(t)
  const events = simpleTurn()
  await enqueueTurn({
    session: sessionOf(events),
    event: events.at(-1),
    binding: BINDING,
    queueRoot,
    config: CONFIG,
  })
  const records = await loadProcessedRecords(queueRoot)
  assert.deepEqual(records.get(SESSION_ID).ranges, [[0, 5]])
})

test('a restart sees the same job and the same identity (the fsync boundary)', async (t) => {
  const queueRoot = await queueIn(t)
  const events = simpleTurn()
  const job = await enqueueTurn({
    session: sessionOf(events),
    event: events.at(-1),
    binding: BINDING,
    queueRoot,
    config: CONFIG,
  })

  // A separate "process" is another `loadPending` over the same directory.
  const [recovered] = await loadPending(queueRoot)
  assert.deepEqual(recovered, job)
})

// ---------------------------------------------------------------------------
// The route
// ---------------------------------------------------------------------------

test('the route is the session last recorded route; with none the job stays deferred', async (t) => {
  const queueRoot = await queueIn(t)
  const events = simpleTurn()

  const routed = await enqueueTurn({
    session: sessionOf(events),
    event: events.at(-1),
    binding: BINDING,
    queueRoot,
    config: CONFIG,
  })
  assert.equal(routed.state, 'pending')
  assert.deepEqual(routed.route, { provider: 'deepseek-official', model: 'deepseek-flash' })

  const routeless = sessionOf(events, { id: 'session-no-route', route: null })
  const deferred = await enqueueTurn({
    session: routeless,
    event: events.at(-1),
    binding: BINDING,
    queueRoot,
    config: CONFIG,
  })
  assert.equal(deferred.state, 'deferred')
  assert.equal(deferred.route, null)
  assert.equal(deferred.deferredReason, 'no-route')
  assert.equal(
    (await loadPending(queueRoot)).length,
    2,
    'a deferred job is still durable pending work',
  )
})

// ---------------------------------------------------------------------------
// Coalescing and the successor rule
// ---------------------------------------------------------------------------

test('completed turns within the idle window coalesce their seq range into one job', async (t) => {
  const queueRoot = await queueIn(t)
  const events = [
    ...simpleTurn(),
    turnStart(6, 2),
    userMessage(7, 'and now the successor rule'),
    assistantMessage(8, [text('second answer')]),
    turnEnd(9, COMPLETED, 2),
  ]
  const session = sessionOf(events)
  const first = await enqueueTurn({
    session,
    event: events[5],
    binding: BINDING,
    queueRoot,
    config: CONFIG,
    now: 1_000_000,
  })
  const second = await enqueueTurn({
    session,
    event: events[9],
    binding: BINDING,
    queueRoot,
    config: CONFIG,
    now: 1_000_000 + 89_000,
  })

  assert.equal(second.jobId, first.jobId, 'within the window the job is extended, not duplicated')
  assert.equal(second.fromSeq, 0)
  assert.equal(second.toSeq, 9)
  assert.ok(second.safeInput.includes('implement the queue'))
  assert.ok(second.safeInput.includes('and now the successor rule'))
  assert.equal((await loadPending(queueRoot)).length, 1)
})

test('a merged range never absorbs a non-completed turn between two completed ones', async (t) => {
  const queueRoot = await queueIn(t)
  const events = [
    turnStart(0, 1),
    userMessage(1, 'FIRST_COMPLETED'),
    assistantMessage(2, [text('first final')], 1),
    turnEnd(3, COMPLETED, 1),
    // An aborted turn sits inside the merged range and must stay out of it.
    turnStart(4, 2),
    userMessage(5, 'ABORTED_TURN_MARKER'),
    turnEnd(6, ABORTED, 2),
    turnStart(7, 3),
    userMessage(8, 'THIRD_COMPLETED'),
    assistantMessage(9, [text('third final')], 3),
    turnEnd(10, COMPLETED, 3),
  ]
  const session = sessionOf(events)
  await enqueueTurn({
    session,
    event: events[3],
    binding: BINDING,
    queueRoot,
    config: CONFIG,
    now: 1_000_000,
  })
  const job = await enqueueTurn({
    session,
    event: events[10],
    binding: BINDING,
    queueRoot,
    config: CONFIG,
    now: 1_000_000 + 1_000,
  })

  assert.equal(job.toSeq, 10, 'the completed turns merged')
  assert.ok(job.safeInput.includes('FIRST_COMPLETED'))
  assert.ok(job.safeInput.includes('THIRD_COMPLETED'))
  assert.ok(
    !job.safeInput.includes('ABORTED_TURN_MARKER'),
    'an aborted turn inside the range is not evidence',
  )
  assert.ok(!job.allowedEvents.some((entry) => entry.seq === 5))
  assert.equal((await loadPending(queueRoot)).length, 1)
})

test('a turn that arrives after the idle window starts a new job', async (t) => {
  const queueRoot = await queueIn(t)
  const events = [
    ...simpleTurn(),
    turnStart(6, 2),
    userMessage(7, 'a later turn'),
    assistantMessage(8, [text('later answer')]),
    turnEnd(9, COMPLETED, 2),
  ]
  const session = sessionOf(events)
  const first = await enqueueTurn({
    session,
    event: events[5],
    binding: BINDING,
    queueRoot,
    config: CONFIG,
    now: 1_000_000,
  })
  const second = await enqueueTurn({
    session,
    event: events[9],
    binding: BINDING,
    queueRoot,
    config: CONFIG,
    now: 1_000_000 + 90_001,
  })

  assert.notEqual(second.jobId, first.jobId)
  assert.equal((await loadPending(queueRoot)).length, 2)
})

test('a new turn while the previous job is being processed becomes a successor, never a mutation', async (t) => {
  const queueRoot = await queueIn(t)
  const events = [
    ...simpleTurn(),
    turnStart(6, 2),
    userMessage(7, 'a turn during distillation'),
    assistantMessage(8, [text('during answer')]),
    turnEnd(9, COMPLETED, 2),
  ]
  const session = sessionOf(events)
  const running = await enqueueTurn({
    session,
    event: events[5],
    binding: BINDING,
    queueRoot,
    config: CONFIG,
    now: 1_000_000,
  })
  // The worker claims the job the way Task 15/16 will.
  const { markJob } = await import('../lib/pending.js')
  await markJob(running.jobId, { state: 'distilling' }, { queueRoot })

  const successor = await enqueueTurn({
    session,
    event: events[9],
    binding: BINDING,
    queueRoot,
    config: CONFIG,
    now: 1_000_000 + 1_000,
  })
  assert.notEqual(successor.jobId, running.jobId)
  assert.equal(successor.fromSeq, 6)
  assert.equal(successor.toSeq, 9)

  const jobs = await loadPending(queueRoot)
  assert.equal(jobs.length, 2)
  const stillRunning = jobs.find((job) => job.jobId === running.jobId)
  assert.equal(stillRunning.state, 'distilling', 'the running job is untouched')
  assert.equal(stillRunning.toSeq, 5, 'and its range is not widened under the worker')
  assert.ok(!stillRunning.safeInput.includes('during answer'))
})

// ---------------------------------------------------------------------------
// createCapture: recovery, flush backfill, disposal
// ---------------------------------------------------------------------------

/** Point `capture` at a clock a case can move by hand. */
function captureFor(queueRoot, clock = { at: 1_000_000 }) {
  return createCapture({
    queueRoot,
    config: CONFIG,
    resolveBinding: async () => BINDING,
    now: () => clock.at,
  })
}

test('recovery at startup makes a previously fsynced job known before any new capture', async (t) => {
  const queueRoot = await queueIn(t)
  const events = simpleTurn()
  const seeded = await enqueueTurn({
    session: sessionOf(events),
    event: events.at(-1),
    binding: BINDING,
    queueRoot,
    config: CONFIG,
  })

  const capture = captureFor(queueRoot)
  const { jobs, recovered } = await capture.recover()
  assert.equal(recovered, 1)
  assert.deepEqual(
    jobs.map((job) => job.jobId),
    [seeded.jobId],
  )

  // Re-capturing the same turn after recovery changes nothing: recovery ran
  // first, and the coverage check keeps it a single job.
  capture.sessionEvent(sessionOf(events), events.at(-1))
  await capture.settle()
  assert.deepEqual(
    (await loadPending(queueRoot)).map((job) => job.jobId),
    [seeded.jobId],
  )
})

test('flush finds an unprocessed completed turn and enqueues it, exactly once', async (t) => {
  const queueRoot = await queueIn(t)
  const events = simpleTurn()
  const session = sessionOf(events)
  const capture = captureFor(queueRoot)
  await capture.recover()

  // No `session/event` notification at all: the flush barrier is the only
  // signal, and it must scan the committed log itself.
  await capture.flush(session)
  let jobs = await loadPending(queueRoot)
  assert.equal(jobs.length, 1)
  assert.equal(jobs[0].toSeq, 5)

  await capture.flush(session)
  jobs = await loadPending(queueRoot)
  assert.equal(jobs.length, 1, 'a second flush is not a second job')
})

test('flush never treats a checkpoint with no committed turn/end as a turn end', async (t) => {
  const queueRoot = await queueIn(t)
  // The mid-turn checkpoint from the P0 record: a real user message already
  // committed, the turn still open. This is exactly the shape a naive
  // "flush means the turn ended" implementation would capture.
  const events = [
    turnStart(0),
    userMessage(1, 'still working'),
    at(2, 'request/header', { reason: 'initial' }),
  ]
  const capture = captureFor(queueRoot)
  await capture.recover()
  await capture.flush(sessionOf(events))
  assert.deepEqual(await loadPending(queueRoot), [])
})

test('disposed flushes what was captured and never reaches for a model', async (t) => {
  const queueRoot = await queueIn(t)
  const events = simpleTurn()
  const capture = captureFor(queueRoot)
  await capture.recover()

  capture.sessionEvent(sessionOf(events), events.at(-1))
  await capture.disposed({ session: sessionOf(events) })
  assert.equal(
    (await loadPending(queueRoot)).length,
    1,
    'the captured turn is durable before disposal returns',
  )
})

// ---------------------------------------------------------------------------
// The hooks wiring
// ---------------------------------------------------------------------------

function hookBed(t, queueRoot, config = CONFIG) {
  const ctx = new Context()
  let modelCalls = 0
  ctx.provide('llm', {
    stream() {
      modelCalls += 1
      throw new Error('the capture path must never call the model')
    },
  })
  const disposers = registerHooks(ctx, {
    resolveBinding: async () => BINDING,
    index: async () => {
      throw new Error('unused')
    },
    buildBrief: async () => {
      throw new Error('unused')
    },
    config: { briefBudgetChars: 6000, injectBrief: true, ...config },
    queueRoot,
  })
  t.after(async () => {
    for (const dispose of disposers) await dispose()
  })
  return { ctx, modelCalls: () => modelCalls }
}

async function waitFor(predicate, { timeout = 3000, interval = 10 } = {}) {
  const deadline = Date.now() + timeout
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() > deadline) return null
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
}

test('the registered session/event listener captures a completed turn durably', async (t) => {
  const queueRoot = await queueIn(t)
  const bed = hookBed(t, queueRoot)
  const events = simpleTurn()
  const session = sessionOf(events)

  // The host's notification is fire-and-forget (emit); the listener may only do
  // a short capture/queue, so the durable write lands asynchronously.
  bed.ctx.emit('session/event', session, events.at(-1))
  const jobs = await waitFor(async () => {
    const found = await loadPending(queueRoot)
    return found.length === 1 ? found : null
  })
  assert.notEqual(jobs, null, 'the completed turn reaches the queue')
  assert.deepEqual(
    jobs[0].allowedEvents.map((entry) => entry.kind),
    ['user', 'assistant-final'],
  )
  assert.equal(bed.modelCalls(), 0)
})

test('the flush barrier backs up a notification the hook never saw', async (t) => {
  const queueRoot = await queueIn(t)
  const bed = hookBed(t, queueRoot)
  const events = simpleTurn()
  const session = sessionOf(events)

  await bed.ctx.parallel('session/flush', session)
  const jobs = await loadPending(queueRoot)
  assert.equal(jobs.length, 1, 'the unprocessed completed turn was found by the barrier')

  // And the notification for the same turn now adds nothing.
  bed.ctx.emit('session/event', session, events.at(-1))
  await waitFor(async () => (await loadPending(queueRoot)).length === 1)
  await bed.ctx.parallel('session/flush', session)
  assert.equal((await loadPending(queueRoot)).length, 1)
})

test('agent/disposed nudges the queue to disk without waiting on a model call', async (t) => {
  const queueRoot = await queueIn(t)
  const bed = hookBed(t, queueRoot)
  const events = simpleTurn()
  const session = sessionOf(events)

  bed.ctx.emit('session/event', session, events.at(-1))
  bed.ctx.emit('agent/disposed', { agent: { session } })
  const jobs = await waitFor(async () => {
    const found = await loadPending(queueRoot)
    return found.length === 1 ? found : null
  })
  assert.notEqual(jobs, null)
  assert.equal(bed.modelCalls(), 0, 'no model call is made on the disposal path')
})

test('without a queue root the hooks register no capture at all', async (t) => {
  const ctx = new Context()
  const disposers = registerHooks(ctx, {
    resolveBinding: async () => BINDING,
    index: async () => {
      throw new Error('unused')
    },
    buildBrief: async () => {
      throw new Error('unused')
    },
    config: { briefBudgetChars: 6000, injectBrief: true },
  })
  t.after(async () => {
    for (const dispose of disposers) await dispose()
  })

  // Emitting the whole lifecycle must not create or read anything: there is no
  // queue to write to, which is why registering without one is inert.
  const events = simpleTurn()
  ctx.emit('session/event', sessionOf(events), events.at(-1))
  await ctx.parallel('session/flush', sessionOf(events))
  ctx.emit('agent/disposed', { agent: { session: sessionOf(events) } })
})

// ---------------------------------------------------------------------------
// Containment: an explicit queue root is the only filesystem target
// ---------------------------------------------------------------------------

test('capture never derives a root of its own, and never consults DSH_HOME', async (t) => {
  const root = await temporaryRoot(t)
  const previous = process.env.DSH_HOME
  const dshHome = join(root, 'dsh-home')
  process.env.DSH_HOME = dshHome
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  })

  const queueRoot = join(root, 'queue')
  const events = simpleTurn()
  await enqueueTurn({
    session: sessionOf(events),
    event: events.at(-1),
    binding: BINDING,
    queueRoot,
    config: CONFIG,
  })

  assert.equal(existsSync(dshHome), false, 'an explicit queueRoot must be the only target')
  assert.deepEqual((await readdir(queueRoot)).filter((name) => name.endsWith('.json')).length, 1)
})

test('no raw transcript is written anywhere but the 0600 pending job', async (t) => {
  const root = await temporaryRoot(t)
  const queueRoot = join(root, 'pending')
  const events = [
    turnStart(0),
    userMessage(1, 'USER_TRANSCRIPT_MARKER'),
    assistantMessage(2, [text('DRAFT_TRANSCRIPT_MARKER'), toolCallPart('bash')]),
    toolCall(3, 'bash'),
    toolResult(4, 'TOOL_OUTPUT_TRANSCRIPT_MARKER'),
    assistantMessage(5, [text('FINAL_TRANSCRIPT_MARKER')]),
    turnEnd(6, COMPLETED),
  ]
  const job = await enqueueTurn({
    session: sessionOf(events),
    event: events.at(-1),
    binding: BINDING,
    queueRoot,
    config: CONFIG,
  })

  const files = await readdir(root, { recursive: true })
  const regular = files.filter((name) => name.endsWith('.json')).map((name) => join(root, name))
  assert.equal(
    regular.length,
    2,
    'the pending job and its processed floor record are the only JSON artifacts',
  )
  const bodies = await Promise.all(regular.map((path) => readFile(path, 'utf8')))
  const all = bodies.join('\n')
  // The floor record carries seq ranges, never conversation text.
  const record = regular.find((path) => path.includes('/processed/'))
  assert.notEqual(record, undefined)
  assert.ok(!/TRANSCRIPT_MARKER/.test(await readFile(record, 'utf8')))

  // The final answer and the user prompt are the whitelisted projection; the
  // draft and the raw tool output exist nowhere on disk.
  assert.ok(all.includes('USER_TRANSCRIPT_MARKER'))
  assert.ok(all.includes('FINAL_TRANSCRIPT_MARKER'))
  assert.ok(!all.includes('DRAFT_TRANSCRIPT_MARKER'))
  assert.ok(!all.includes('TOOL_OUTPUT_TRANSCRIPT_MARKER'))
  assert.ok(!existsSync(join(root, 'receipts')), 'Task 14 writes no receipt at all')

  // And the safeInput is what the model would be handed: whitelist only.
  assert.ok(job.safeInput.includes('FINAL_TRANSCRIPT_MARKER'))
  assert.ok(!job.safeInput.includes('DRAFT_TRANSCRIPT_MARKER'))
})
