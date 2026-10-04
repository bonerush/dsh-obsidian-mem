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

import { curationCursorPath } from '../lib/curation-state.js'
import {
  DIAGNOSTIC_FIELDS,
  EVENT_NAMES,
  createDiagnostics,
  recordDiagnostic,
} from '../lib/debug.js'
import { ADMIN_OUTPUT } from '../lib/tool-schema.js'
import { makeCurationWorld } from './curation-world.js'

/** The diagnostics arm of \`mem_admin\`'s output schema, reached the way a caller does. */
const DIAGNOSTICS_ARM = ADMIN_OUTPUT.oneOf.find(
  (arm) => arm.properties.action.const === 'diagnostics',
)

test("the ring's allowlists and the output schema cannot drift apart", () => {
  // Both sets are closed, and they are the same fact written twice: the ring
  // refuses a name it does not know, and the schema refuses to *return* one it
  // does not list. Divergence is silent in the unit tests and fatal in the tool —
  // \`mem_admin(action="diagnostics")\` failed its own output validation the first
  // time a \`recall\` event reached the ring, because neither the schema's enum nor
  // its two count fields had been extended with it.
  const eventSchema = DIAGNOSTICS_ARM.properties.result.properties.events.items
  const listed = eventSchema.properties.event.enum
  for (const name of EVENT_NAMES) {
    assert.ok(listed.includes(name), 'the schema does not list the event ' + name)
  }
  assert.equal(listed.length, EVENT_NAMES.length, 'the schema lists nothing the ring cannot record')
  for (const field of DIAGNOSTIC_FIELDS) {
    assert.ok(field in eventSchema.properties, 'the schema has no property ' + field)
  }
  // `seq`, `at` and `event` are the ring's own three keys; everything else the
  // schema publishes has to be a field the ring can actually write.
  const own = ['seq', 'at', 'event']
  for (const key of Object.keys(eventSchema.properties)) {
    assert.ok(
      own.includes(key) || DIAGNOSTIC_FIELDS.includes(key),
      'the schema publishes ' + key + ', which the ring never writes',
    )
  }
})

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

test('the recall event records a decision and counts, never the query or a path', () => {
  // Recall could not answer 'did it fire?' from its own diagnostics: the `brief`
  // event is recorded whenever the *brief* is injected, whatever the map did.
  const diagnostics = createDiagnostics({ now: fixedClock })
  diagnostics.event('recall', {
    outcome: 'below-floor',
    hits: 8,
    chars: 0,
    prompt: 'SENTINEL-PROMPT',
    path: 'Projects/x/Docs/secret.md',
  })
  diagnostics.event('recall', { outcome: 'fired', hits: -1, chars: 1.5 })
  const { events } = diagnostics.snapshot()
  assert.equal(events.length, 2, 'recall is an allowlisted category')
  assert.equal(events[0].outcome, 'below-floor')
  assert.equal(events[0].hits, 8)
  assert.equal(events[0].chars, 0)
  assert.equal(events[1].hits, undefined, 'a negative count is dropped')
  assert.equal(events[1].chars, undefined, 'a fractional count is dropped')
  const serialised = JSON.stringify(events)
  for (const sentinel of ['SENTINEL-PROMPT', 'secret.md']) {
    assert.equal(serialised.includes(sentinel), false, sentinel + ' must not reach the ring')
  }
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

/** The `curation` arm of `mem_admin`'s output schema. */
const CURATION_ARM = ADMIN_OUTPUT.oneOf.find((arm) => arm.properties.action.const === 'curation')

test("the curation category's outcomes and the schema's closed enums agree", () => {
  // Same rule as the `recall` case above, applied to Task 5's category: the ring
  // accepts the outcomes the call sites emit and the disk codec persists exactly
  // those, so both closed lists are asserted rather than the absence of a fifth
  // name. `failed` is the per-finding refusal and Task 6's trigger catches; the last
  // two are the final wave's brief-time view fallback and changed-path cap drop.
  assert.ok(EVENT_NAMES.includes('curation'))
  assert.deepEqual(CURATION_ARM.properties.result.properties.operation.enum, ['status', 'scan'])
  const emitted = [
    'listed',
    'scanned',
    'skipped',
    'failed',
    'brief-fallback',
    'changed-path-dropped',
  ]
  const diagnostics = createDiagnostics({})
  for (const [index, outcome] of emitted.entries()) {
    diagnostics.event('curation', { outcome, hits: index, ms: index })
  }
  const events = diagnostics.snapshot().events
  assert.deepEqual(
    events.map((event) => event.outcome),
    emitted,
  )
  // The schema's shape is the bound: five integer counts and a duration, no text.
  assert.deepEqual(
    Object.keys(CURATION_ARM.properties.result.properties.counts.properties).sort(),
    ['entries', 'exactGroups', 'findings', 'unexamined'],
  )
})

test('a curated note body and path stay out of the diagnostics the tool returns', async (t) => {
  const sentinelBody = `SENTINEL-CURATION-BODY-${randomUUID()}`
  const sentinelTitle = `SENTINEL-CURATION-TITLE-${randomUUID()}`
  const world = await makeCurationWorld(t)
  const written = await world.services.write({
    type: 'convention',
    title: sentinelTitle,
    body: `${sentinelBody} 的正文。`,
  })
  // Real curation work through the shipped service, with a real sentinel in the
  // vault the pass reads.
  const curated = await world.services.admin({ action: 'curation', operation: 'scan' })
  assert.equal(curated.result.status, 'scanned')
  assert.ok(curated.result.examined >= 1)
  assert.equal(curated.result.counts.entries >= 1, true)

  const diagnostics = await world.services.admin({ action: 'diagnostics' })
  const serialised = JSON.stringify(diagnostics)
  for (const sentinel of [sentinelBody, sentinelTitle]) {
    assert.equal(serialised.includes(sentinel), false, `${sentinel} reached the ring`)
  }
  // Neither the vault-relative note the pass read nor the private cursor it wrote
  // may appear: the ring carries outcomes and counts, never a path. The cursor path
  // is derived here the way the state module derives it, so the assertion covers
  // the write side of the pass rather than the note it read.
  assert.equal(serialised.includes(written.path), false)
  assert.equal(
    serialised.includes(curationCursorPath(world.dataRoot, curated.result.projectId)),
    false,
  )
  assert.equal(
    diagnostics.result.events.some((event) => event.event === 'curation'),
    true,
    'the pass must record that it ran',
  )
})

test('a failing disk sink cannot change the ring result', () => {
  let calls = 0
  let seen
  const diagnostics = createDiagnostics({
    now: fixedClock,
    sink: {
      record(record) {
        calls += 1
        seen = record
        throw new Error('SENTINEL-SINK-FAILED')
      },
    },
  })
  diagnostics.event('job', { outcome: 'failed', body: 'SENTINEL-BODY' })
  assert.equal(calls, 1)
  assert.equal(JSON.stringify(seen).includes('SENTINEL-BODY'), false)
  assert.equal(diagnostics.snapshot().events.length, 1)
  assert.equal(diagnostics.snapshot().events[0].outcome, 'failed')
  assert.equal(JSON.stringify(diagnostics.snapshot()).includes('SENTINEL-BODY'), false)
})
