// Task 9: the bounded, content-free diagnostics channel.
//
// The design's answer to "debugging this plugin means guessing" is a ring buffer
// that always records *decisions* and never records content. The distinction is
// the whole safety story, so it is asserted here rather than documented: a
// sentinel body goes through the same code path a note does, and the serialised
// snapshot must not contain it, nor any of the field names that would carry one.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'

import { createDiagnostics, recordDiagnostic } from '../lib/debug.js'

/** A logger that records what it was asked to write. */
function fakeLogger() {
  const lines = []
  return {
    lines,
    logger: {
      info: (line) => lines.push(line),
      debug: (line) => lines.push('debug:' + line),
    },
  }
}

/** A clock that stands still, so timestamps are checkable. */
const fixedClock = () => new Date('2026-01-02T03:04:05.000Z')

test('the ring keeps the newest events and counts what it dropped', () => {
  const diagnostics = createDiagnostics({ capacity: 200, now: fixedClock })
  for (let index = 0; index < 201; index += 1) diagnostics.event('job', { outcome: 'applied' })
  const { window, events } = diagnostics.snapshot()
  assert.equal(events.length, 200)
  assert.equal(window.size, 200)
  assert.equal(window.capacity, 200)
  assert.equal(window.dropped, 1)
  assert.equal(window.oldestSeq, 2, 'the first event was overwritten')
  assert.equal(window.newestSeq, 201)
  assert.equal(events[0].seq, 2)
  assert.equal(events.at(-1).seq, 201)
})

test('a snapshot is a copy: mutating it cannot reach into the ring', () => {
  const diagnostics = createDiagnostics({ now: fixedClock })
  diagnostics.event('capture', { outcome: 'skipped', attempts: 2 })
  const first = diagnostics.snapshot()
  first.events[0].outcome = 'tampered'
  first.events.push({ seq: 999 })
  const second = diagnostics.snapshot()
  assert.equal(second.events.length, 1)
  assert.equal(second.events[0].outcome, 'skipped')
})

test('only allowlisted names and scalar fields are recorded', () => {
  const diagnostics = createDiagnostics({ now: fixedClock })
  diagnostics.event('not-a-category', { outcome: 'applied' })
  diagnostics.event('job', {
    outcome: 'applied',
    attempts: 2,
    ms: 12,
    code: 'recovery-required',
    projectId: '1c392abb-7b08-42f7-871d-2a379caf9448',
    body: 'SENTINEL-BODY',
    title: 'SENTINEL-TITLE',
    message: 'SENTINEL-MESSAGE',
    path: 'Projects/x/Docs/secret.md',
    prompt: 'SENTINEL-PROMPT',
    nested: { deep: true },
  })
  const { events } = diagnostics.snapshot()
  assert.equal(events.length, 1, 'an unknown category is not an event')
  const serialised = JSON.stringify(events)
  for (const sentinel of [
    'SENTINEL-BODY',
    'SENTINEL-TITLE',
    'SENTINEL-MESSAGE',
    'SENTINEL-PROMPT',
    'secret.md',
    'nested',
    'deep',
  ]) {
    assert.equal(serialised.includes(sentinel), false, sentinel + ' must not reach the ring')
  }
  for (const key of ['body', 'title', 'message', 'path', 'prompt']) {
    assert.equal(
      serialised.includes('"' + key + '"'),
      false,
      'the field name ' + key + ' must not appear',
    )
  }
  assert.equal(events[0].outcome, 'applied')
  assert.equal(events[0].attempts, 2)
  assert.equal(events[0].ms, 12)
  assert.equal(events[0].code, 'recovery-required')
})

test('a sentinel body cannot survive the round trip through a real write path', () => {
  const sentinel = 'SENTINEL-BODY-' + randomUUID()
  const diagnostics = createDiagnostics({ now: fixedClock })
  // The shape a capture or distill call site has: it knows the text and records
  // only the decision about it.
  const candidate = { title: sentinel, body: sentinel }
  diagnostics.event('capture', {
    outcome: 'skipped',
    code: 'too-short',
    title: candidate.title,
    body: candidate.body,
  })
  assert.equal(JSON.stringify(diagnostics.snapshot()).includes(sentinel), false)
})

test('values of the wrong shape are dropped rather than coerced', () => {
  const diagnostics = createDiagnostics({ now: fixedClock })
  diagnostics.event('job', {
    outcome: 42,
    attempts: -1,
    ms: Number.NaN,
    code: 'x'.repeat(500),
    projectId: { toString: () => 'nope' },
  })
  const [event] = diagnostics.snapshot().events
  assert.equal(event.outcome, undefined)
  assert.equal(event.attempts, undefined)
  assert.equal(event.ms, undefined)
  assert.equal(event.code, undefined)
  assert.equal(event.projectId, undefined)
})

test('the env flag is what turns logger emission on', () => {
  const off = fakeLogger()
  const quiet = createDiagnostics({ logger: off.logger, now: fixedClock })
  quiet.event('job', { outcome: 'applied' })
  assert.deepEqual(off.lines, [], 'nothing is emitted unless the flag is set')

  const on = fakeLogger()
  const previous = process.env.DSH_OBSIDIAN_MEM_DEBUG
  process.env.DSH_OBSIDIAN_MEM_DEBUG = '1'
  try {
    const loud = createDiagnostics({ logger: on.logger, now: fixedClock })
    loud.event('job', { outcome: 'applied', ms: 3 })
    assert.equal(on.lines.length, 1)
    const parsed = JSON.parse(on.lines[0])
    assert.equal(parsed.event, 'job')
    assert.equal(parsed.outcome, 'applied')
    assert.equal(parsed.ms, 3)
  } finally {
    if (previous === undefined) delete process.env.DSH_OBSIDIAN_MEM_DEBUG
    else process.env.DSH_OBSIDIAN_MEM_DEBUG = previous
  }
})

test('neither a throwing logger nor a throwing clock escapes event()', () => {
  const diagnostics = createDiagnostics({
    logger: {
      info: () => {
        throw new Error('logger exploded')
      },
    },
    now: () => {
      throw new Error('clock exploded')
    },
  })
  const previous = process.env.DSH_OBSIDIAN_MEM_DEBUG
  process.env.DSH_OBSIDIAN_MEM_DEBUG = '1'
  try {
    assert.doesNotThrow(() => diagnostics.event('job', { outcome: 'applied' }))
  } finally {
    if (previous === undefined) delete process.env.DSH_OBSIDIAN_MEM_DEBUG
    else process.env.DSH_OBSIDIAN_MEM_DEBUG = previous
  }
  const { events } = diagnostics.snapshot()
  assert.equal(events.length, 1)
  assert.equal(typeof events[0].at, 'string')
})

test('recordDiagnostic absorbs a broken diagnostics object', () => {
  const calls = []
  const good = { event: (name, fields) => calls.push([name, fields]) }
  recordDiagnostic(good, 'bind', { outcome: 'refused', code: 'no-pointer' })
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], ['bind', { outcome: 'refused', code: 'no-pointer' }])
  assert.doesNotThrow(() => recordDiagnostic(undefined, 'bind', {}))
  assert.doesNotThrow(() =>
    recordDiagnostic(
      {
        event: () => {
          throw new Error('no')
        },
      },
      'bind',
      {},
    ),
  )
  assert.doesNotThrow(() =>
    recordDiagnostic(
      {
        get event() {
          throw new Error('getter')
        },
      },
      'bind',
      {},
    ),
  )
})
