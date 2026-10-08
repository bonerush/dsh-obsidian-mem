// Task 18: the failure signal, and the query it produces.
//
// Three properties are under test and they fail for different reasons, so they
// are worth naming before the cases:
//
//   1. **Classification.** `hard` is the host's own verdict and must never be
//      missed — a recall that cannot see a real failure is the whole feature
//      failing. `soft` is a pattern match on raw output and must never be
//      generous, because it spends retrieval budget in sessions that are working.
//      Both directions are pinned, and both were wrong in the first draft: the
//      generic pattern matched `\bE[A-Z]{3,}\b` under `/i`, which matches any word
//      starting with `e` — `export`, `Evenly`, `emit` — and fired on 63.7% of
//      successful results.
//   2. **Scoping.** A successful `read` or `grep` that mentions a missing file is
//      a tool doing its job. Unscoped, the soft rule fired in 31 of 60 real
//      sessions; scoped to shells, fetchers and code runners, and counted per
//      step, it fires in 6. The cases below hold both the scope and the per-step
//      reset, because either one alone restores the noise.
//   3. **Once per run.** A run of thirteen failures must inject once. That is what
//      `consume()` guarantees, and it is the difference between a hint and a
//      flood.
//
// The numbers in these cases come from the author's 60 most recent session logs
// (measured 2026-10-08; `research/failure-triggered-recall.md`).
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  classifyResult,
  FAILURE_KINDS,
  FailureStreak,
  HARD_STREAK_THRESHOLD,
  kindOf,
  MAX_SCAN_CHARS,
  queryForFailure,
  SOFT_STREAK_THRESHOLD,
} from '../lib/failure-streak.js'

/** A `tool/result` event with the shape the corpus carries. */
function result({
  text = '',
  isError = false,
  step = 1,
  seq = 1,
  error = undefined,
  toolCallId,
  name,
} = {}) {
  const data = {
    turn: 1,
    step,
    message: {
      role: 'tool',
      content: text === '' ? [] : [{ type: 'text', text }],
      isError,
      ...(toolCallId === undefined ? {} : { toolCallId }),
    },
  }
  if (error !== undefined) data.error = error
  if (name !== undefined) data.name = name
  return { type: 'tool/result', seq, step, data }
}

/** A `tool/call` event, which is where a tool's name comes from. */
function call(callId, name, seq = 1) {
  return { type: 'tool/call', seq, data: { callId, name, arguments: '{}' } }
}

/** One hard failure for a named tool, at a given step. */
function hardFailure(name, callId, seq, step) {
  return [call(callId, name, seq), result({ isError: true, seq, step, toolCallId: callId })]
}

test('the host verdict is never missed, whatever the tool', () => {
  // Hard is universal: a tool the host could not run failed, and no allowlist may
  // suppress that. The corpus has 150 of these and the classifier finds all 150.
  for (const name of ['bash', 'edit', 'read', 'subagent', 'todo_write', 'web_fetch', '']) {
    assert.equal(classifyResult(result({ isError: true }).data, name), 'hard')
  }
  // The second shape a failure arrives in: `data.error` beside a non-error message.
  assert.equal(
    classifyResult(result({ text: 'partial', error: { code: 'EPIPE' } }).data, 'read'),
    'hard',
  )
})

test('a successful result is inspected only for tools whose success can hide a failure', () => {
  const body = 'ENOENT: no such file or directory'
  // Scoped: these are the tools that report success while the work did not happen.
  for (const name of ['bash', 'exec', 'run_code', 'web_fetch', 'bash'.toUpperCase()]) {
    assert.equal(classifyResult(result({ text: body }).data, name), 'soft', name)
  }
  // Not scoped: a read or a grep that mentions a missing file is doing its job.
  // Before this scope the rule fired in 31 of 60 real sessions, almost all of them
  // on exactly these tools.
  for (const name of ['read', 'grep', 'edit', 'todo_write', 'mem_search', 'unknown']) {
    assert.equal(classifyResult(result({ text: body }).data, name), 'ok', name)
  }
})

test('a body with no signature is ok, not unknown', () => {
  // The allowance that was refused: for recall, a false negative costs a missed
  // hint while a false positive spends tokens in every session. So the table is an
  // allowlist and an ordinary body is `ok`.
  assert.equal(classifyResult(result({ text: 'all good, 42 tests passed' }).data, 'bash'), 'ok')
  assert.equal(kindOf('nothing to see here'), null)
  assert.equal(kindOf(''), null)
  assert.equal(kindOf(null), null)
})

test('the generic pattern does not match ordinary words', () => {
  // The exact regression that made the soft signal useless. `\bE[A-Z]{3,}\b` under
  // `/i` matches every one of these, which is how 63.7% of successful results
  // became "failures".
  for (const word of ['export', 'Evenly', 'emit', 'easystats', 'ezproxy', 'emitanaka', 'eval']) {
    assert.equal(kindOf(word), null, `${word} is a word, not an error code`)
  }
  // Real errno codes are upper case and still match, and a named exception is
  // matched by shape rather than by the bare word "error".
  assert.equal(kindOf('spawn failed with ENOENT'), 'not-found')
  assert.equal(kindOf('raised ValueError: bad input'), 'traceback')
  // Documenting an error is not committing one: the bare word is not a signature.
  assert.equal(kindOf('this note discusses an error in the parser'), null)
})

test('the kind table is closed and ordered most-specific first', () => {
  assert.equal(kindOf('URL hostname "x" resolves to a non-public IP address'), 'host-unresolvable')
  assert.equal(kindOf('fatal: not a git repository'), 'not-a-repo')
  assert.equal(kindOf('EACCES: permission denied'), 'permission-denied')
  assert.equal(kindOf('zsh: command not found: ripgrep'), 'command-not-found')
  assert.equal(kindOf('Traceback (most recent call last):'), 'traceback')
  assert.equal(kindOf('process exited with code 2'), 'nonzero-exit')
  assert.equal(kindOf('ToolCallError: boom'), 'tool-error')
  assert.equal(kindOf('npm ERR! code ELIFECYCLE'), 'tool-error')
  // Every kind the classifier can return is in the declared vocabulary, so a
  // diagnostics token cannot be invented by accident.
  for (const sample of [
    'ENOENT',
    'EACCES',
    'ToolCallError',
    'npm ERR!',
    'Traceback (most recent call last)',
    'exit code 3',
    'command not found',
    'not a git repository',
    'resolves to a non-public IP address',
  ]) {
    assert.ok(FAILURE_KINDS.includes(kindOf(sample)), `${sample} → ${kindOf(sample)}`)
  }
})

test('the scan is bounded, and reads both ends of a long body', () => {
  const filler = 'x'.repeat(MAX_SCAN_CHARS * 4)
  // Head: a signature at the start of a long log is found.
  assert.equal(kindOf(`ENOENT: missing\n${filler}`), 'not-found')
  // Tail: and so is one at the end, which is where a build log puts its verdict.
  assert.equal(kindOf(`${filler}\nENOENT: missing`), 'not-found')
  // A signature strictly inside an unreadably long body is missed, which is the
  // accepted cost of bounding the scan to a slice.
  assert.equal(kindOf(`${filler}ENOENT${filler}`), null)
})

test('legacy nested tool results and message-less host errors are hard failures', () => {
  assert.equal(
    classifyResult(
      { message: { content: [{ type: 'tool-result', isError: true, content: [] }] } },
      'read',
    ),
    'hard',
  )
  assert.equal(classifyResult({ error: { code: 'EPIPE' } }, 'bash'), 'hard')
})

test('a success clears soft counters and step numbers are scoped to a turn', () => {
  const streak = new FailureStreak()
  streak.observe(result({ text: 'ENOENT', name: 'bash', step: 1 }))
  streak.observe(result({ text: 'done', name: 'bash', step: 1 }))
  streak.observe(result({ text: 'ENOENT', name: 'bash', step: 1 }))
  assert.equal(streak.consume(), null)
  streak.observe({
    ...result({ text: 'ENOENT', name: 'bash', step: 1 }),
    data: { ...result({ text: 'ENOENT', name: 'bash', step: 1 }).data, turn: 2 },
  })
  assert.equal(streak.consume(), null, 'step 1 of two turns is not one step')
})

test('nested dispatch failures count once and their successful wrapper cannot erase them', () => {
  const streak = new FailureStreak()
  streak.observe(call('root', 'run_code'))
  for (let i = 1; i <= 3; i++)
    streak.observe({
      type: 'tool/ptc-dispatch',
      seq: i,
      data: {
        rootCallId: 'root',
        subCallId: `nested${i}`,
        name: 'bash',
        isError: true,
        content: [{ type: 'text', text: 'ENOENT' }],
        turn: 1,
        step: 1,
      },
    })
  streak.observe(result({ text: 'done', toolCallId: 'root' }))
  assert.equal(streak.consume()?.hard, 3)
})

test('a wrapper failure after successful nested calls remains a hard failure', () => {
  const streak = new FailureStreak()
  for (let i = 0; i < 3; i++) {
    streak.observe(call(`root${i}`, 'run_code'))
    streak.observe({
      type: 'tool/ptc-dispatch',
      data: {
        rootCallId: `root${i}`,
        name: 'read',
        isError: false,
        content: [{ type: 'text', text: 'ok' }],
        turn: 1,
        step: i + 1,
      },
    })
    streak.observe(
      result({ isError: true, toolCallId: `root${i}`, text: 'TypeError: wrapper failed' }),
    )
  }
  assert.equal(streak.consume()?.hard, 3)
})

test('a run of hard failures reaches the threshold, and one short of it does not', () => {
  const streak = new FailureStreak()
  for (let i = 1; i < HARD_STREAK_THRESHOLD; i += 1) {
    for (const event of hardFailure('bash', `c${i}`, i, i)) streak.observe(event)
  }
  assert.equal(streak.consume(), null, `${HARD_STREAK_THRESHOLD - 1} failures is not a run`)
  for (const event of hardFailure('bash', 'c9', 9, 9)) streak.observe(event)
  const run = streak.consume()
  assert.equal(run.hard, HARD_STREAK_THRESHOLD)
  assert.deepEqual(run.tools, ['bash'])
  assert.equal(run.soft, 0)
})

test('a run is reported once, however long it grows', () => {
  const streak = new FailureStreak()
  for (let i = 1; i <= 13; i += 1) {
    for (const event of hardFailure('run_code', `c${i}`, i, i)) streak.observe(event)
    streak.consume()
  }
  assert.equal(streak.consume(), null, 'a run of thirteen injects once, not thirteen times')
  // And a success clears it, so a later run is a new run.
  streak.observe(result({ text: 'ok', isError: false, seq: 20, name: 'bash' }))
  for (let i = 21; i <= 23; i += 1) {
    for (const event of hardFailure('bash', `d${i}`, i, i)) streak.observe(event)
  }
  assert.equal(streak.consume()?.hard, HARD_STREAK_THRESHOLD)
})

test('soft failures count inside one step, never across steps', () => {
  const soft = (seq, step) => result({ text: 'ENOENT: gone', step, seq, name: 'bash' })
  // One match per step, three steps: no run. Counting across steps made this a
  // trigger, and it is the difference between 26 and 6 firing sessions.
  const across = new FailureStreak()
  for (const [seq, step] of [
    [1, 1],
    [2, 2],
    [3, 3],
  ])
    across.observe(soft(seq, step))
  assert.equal(across.consume(), null, 'three separate steps are not one stuck step')

  // Two matches inside one step: a run, and it is the step that is stuck.
  const within = new FailureStreak()
  within.observe(soft(1, 1))
  within.observe(soft(2, 1))
  const run = within.consume()
  assert.equal(run.soft, SOFT_STREAK_THRESHOLD)
  assert.equal(run.hard, 0)
})

test('the step is read from the event data, not the event', () => {
  // The field path is load-bearing: `tool/result` carries `step` inside `data`, so
  // reading `event.step` yielded null for every result, the per-step reset never
  // ran, and the soft counter accumulated across the whole session — silently
  // degrading the per-step rule into the per-session rule it replaced.
  const streak = new FailureStreak()
  streak.observe({
    type: 'tool/result',
    seq: 1,
    data: {
      step: 7,
      turn: 1,
      name: 'bash',
      message: { content: [{ type: 'text', text: 'ENOENT' }] },
    },
  })
  assert.equal(streak.softStep, 7)
  // A different step resets to zero, so a single match is never half a trigger.
  streak.observe({
    type: 'tool/result',
    seq: 2,
    data: {
      step: 8,
      turn: 1,
      name: 'bash',
      message: { content: [{ type: 'text', text: 'ENOENT' }] },
    },
  })
  assert.equal(streak.soft, 1)
  assert.equal(streak.consume(), null)
})

test('a tool name is resolved through the call, and unknown when it cannot be', () => {
  const streak = new FailureStreak()
  streak.observe(call('c1', 'web_fetch', 1))
  streak.observe(result({ isError: true, seq: 2, step: 1, toolCallId: 'c1' }))
  // A result whose call was never seen still counts: the failure is real even when
  // the name is not, and `unknown` is the honest token for the query.
  streak.observe(result({ isError: true, seq: 3, step: 1, toolCallId: 'never-seen' }))
  streak.observe(result({ isError: true, seq: 4, step: 1 }))
  const run = streak.consume()
  assert.deepEqual(run.tools, ['unknown', 'web_fetch'])
})

test('the query names the error kind before the tool, and is bounded', () => {
  // Kinds first because a kind is distinctive and a tool name is not: every
  // session uses `bash`, so a query of bare tool names would rank nothing.
  assert.equal(
    queryForFailure({ kinds: ['not-found'], tools: ['bash'] }),
    'ENOENT 找不到文件 not-found bash',
  )
  assert.equal(queryForFailure({ kinds: ['a', 'b', 'c'], tools: ['x', 'y', 'z', 'w'] }), 'w x y')
  assert.equal(queryForFailure({ kinds: [], tools: [] }), null)
  assert.equal(queryForFailure({}), null)
  assert.equal(queryForFailure(null), null)
  // Duplicates collapse, and blank values never become query tokens.
  assert.equal(queryForFailure({ kinds: ['x', 'x'], tools: ['', 'bash', 'bash'] }), 'bash')
})
