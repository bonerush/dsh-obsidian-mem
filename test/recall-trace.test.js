import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  createRecallTrace,
  fitTraceView,
  lexicalTrace,
  RECALL_QUERY_TEXT_MAX,
  RECALL_TRACE_MAX_PER_SESSION,
  RECALL_TRACE_MAX_SESSIONS,
  toTraceView,
} from '../lib/recall-trace.js'

const entry = (path, index) => ({ path, rank: index + 1 })

test('a trace is capped, text is clipped and the vector is kept off the wire', () => {
  const ring = createRecallTrace()
  const cursor = ring.record('s1', {
    source: 'tool',
    queryText: 'x'.repeat(500),
    queryVector: Float32Array.from([1, 0]),
    engine: 'hybrid',
    lexicalTop: Array.from({ length: 80 }, (_, index) => entry('n' + index + '.md', index)),
    denseTop: Array.from({ length: 80 }, (_, index) => ({
      ...entry('d' + index + '.md', index),
      score: 1,
    })),
    fusedTop: Array.from({ length: 80 }, (_, index) => ({
      path: 'f' + index + '.md',
      source: 'lexical',
      lexicalRank: index + 1,
      denseRank: null,
      semanticScore: null,
      hybridRank: index + 1,
      lexicalHit: true,
    })),
  })
  assert.equal(cursor, 1)
  const { events } = ring.since('s1')
  assert.equal(events.length, 1)
  assert.equal([...events[0].queryText].length, RECALL_QUERY_TEXT_MAX)
  assert.equal(events[0].lexicalTop.length, 50)
  assert.equal(events[0].denseTop.length, 50)
  assert.equal(events[0].fusedTop.length, 20)
  const view = toTraceView(events[0], { project: () => ({ x: 0.25, y: 0.5 }) })
  assert.deepEqual(view.query, { text: 'x'.repeat(200), x: 0.25, y: 0.5 })
  assert.equal(JSON.stringify(view).includes('queryVector'), false)
})

test('the ring keeps the newest 20 per session and since is incremental', () => {
  const ring = createRecallTrace()
  for (let index = 0; index < RECALL_TRACE_MAX_PER_SESSION + 5; index += 1) {
    ring.record('s1', lexicalTrace([entry('n.md', 0)]))
  }
  const { events, cursor } = ring.since('s1')
  assert.equal(events.length, RECALL_TRACE_MAX_PER_SESSION)
  assert.equal(cursor, events.at(-1).cursor)
  assert.equal(ring.since('s1', cursor).events.length, 0)
})

test('the ring keeps the newest 64 sessions and reports nothing for an evicted one', () => {
  const ring = createRecallTrace()
  for (let index = 0; index < RECALL_TRACE_MAX_SESSIONS + 3; index += 1) {
    ring.record('s' + index, lexicalTrace([]))
  }
  assert.equal(ring.since('s0').events.length, 0, 'the oldest sessions were evicted')
  assert.equal(ring.since('s' + (RECALL_TRACE_MAX_SESSIONS + 2)).events.length, 1)
})

test('recordFromHits only records a hit array that carries a trace', () => {
  const ring = createRecallTrace()
  const hits = [entry('n.md', 0)]
  assert.equal(ring.recordFromHits('s1', { queryText: 'q', source: 'tool', tookMs: 3, hits }), null)
  Object.defineProperty(hits, 'hybridTrace', {
    value: lexicalTrace(hits, { fallback: 'provider-error' }),
    enumerable: false,
  })
  const cursor = ring.recordFromHits('s1', { queryText: 'q', source: 'tool', tookMs: 3, hits })
  assert.equal(typeof cursor, 'number')
  const [event] = ring.since('s1').events
  assert.equal(event.source, 'tool')
  assert.equal(event.fallback, 'provider-error')
  assert.equal(event.queryText, 'q')
})

test('fitTraceView drops dense rows first, then lexical rows, and flags truncation', () => {
  const ring = createRecallTrace()
  ring.record('s1', {
    ...lexicalTrace([entry('n.md', 0)]),
    denseTop: Array.from({ length: 50 }, (_, index) => ({
      path: 'd' + index + '.md',
      rank: index + 1,
      score: 0.5,
    })),
    fusedTop: Array.from({ length: 20 }, (_, index) => ({
      path: 'f' + index + '.md',
      source: 'dense',
      lexicalRank: null,
      denseRank: index + 1,
      semanticScore: 0.5,
      hybridRank: index + 1,
      lexicalHit: false,
    })),
  })
  const view = fitTraceView(toTraceView(ring.since('s1').events[0]), { maxBytes: 3_000 })
  assert.ok(new TextEncoder().encode(JSON.stringify(view)).length <= 3_000)
  assert.equal(view.truncated, true)
  assert.equal(view.fused.length, 20, 'fused rows survive')
})
