import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  CARD_COPY,
  cardView,
  createOverlayModel,
  createSemanticController,
  createSemanticPainter,
  DENSE_LINE_MAX,
  decodeMapPoints,
  RECALL_POLL_MS,
} from '../lib/graph-semantic.js'

const trace = () => ({
  cursor: 7,
  at: 1,
  source: 'tool',
  engine: 'hybrid',
  fallback: null,
  guard: false,
  denseCandidates: 2,
  embedMs: 90,
  tookMs: 240,
  query: { text: '重试 退避', x: 100, y: 200 },
  lexical: [{ path: 'a.md', rank: 1 }],
  dense: Array.from({ length: 20 }, (_, index) => ({
    path: 'd' + index + '.md',
    rank: index + 1,
    score: 0.9 - index * 0.01,
  })),
  fused: [
    {
      path: 'a.md',
      source: 'lexical',
      lexicalRank: 1,
      denseRank: 3,
      semanticScore: 0.8,
      hybridRank: 1,
      lexicalHit: true,
    },
    {
      path: 'd1.md',
      source: 'dense',
      lexicalRank: null,
      denseRank: 1,
      semanticScore: 0.95,
      hybridRank: 2,
      lexicalHit: false,
    },
  ],
  truncated: false,
})

test('decodeMapPoints and the overlay model are pure geometry', () => {
  const points = decodeMapPoints({
    points: [
      ['a.md', 0, 4095],
      ['b.md', 2047.5, 0],
    ],
  })
  assert.deepEqual(points.get('a.md'), { x: 0, y: 1000 })
  assert.deepEqual(points.get('b.md'), { x: 500, y: 0 })
  const positions = new Map([['a.md', { x: 10, y: 20 }]])
  const model = createOverlayModel(trace(), (path) => positions.get(path) ?? null)
  assert.deepEqual(model?.query, { x: 100, y: 200 })
  assert.equal(model?.lexical.has('a.md'), true)
  assert.equal(model?.dense.has('d1.md'), true)
  assert.equal(model?.fused.get('d1.md'), 2)
  assert.equal(model?.lines.length, DENSE_LINE_MAX)
})

test('the painter draws dense lines, a query ring, lexical squares and rank badges', () => {
  const calls = []
  const context = new Proxy(
    { calls, set: null },
    {
      get(target, key) {
        if (key in target) return target[key]
        return (...args) => calls.push({ name: key, args })
      },
      set(target, key, value) {
        calls.push({ name: 'set:' + String(key), args: [value] })
        target[key] = value
        return true
      },
    },
  )
  const model = createOverlayModel(trace(), (path) =>
    path === 'a.md' ? { x: 10, y: 20 } : { x: 30, y: 40 },
  )
  const painter = createSemanticPainter(() => ({ model, started: 0 }))
  const points = new Map([['a.md', { x: 10, y: 20, r: 5 }]])
  const lookup = new Map([['a.md', { path: 'a.md' }]])
  for (let index = 0; index < DENSE_LINE_MAX; index += 1) {
    const id = 'd' + index + '.md'
    points.set(id, { x: 30 + index, y: 40, r: 5 })
    lookup.set(id, { path: id })
  }
  painter({
    context,
    palette: {
      lineHighlight: { css: '#000', a: 1 },
      fillHighlight: { css: '#111', a: 1 },
      text: { css: '#222', a: 1 },
    },
    now: 10_000,
    reduced: true,
    scale: 1,
    points,
    lookup,
    toScreen: (point) => ({ x: point.x, y: point.y }),
  })
  assert.ok(
    calls.some((call) => call.name === 'strokeRect'),
    'lexical hits get a square ring',
  )
  assert.ok(calls.filter((call) => call.name === 'moveTo').length >= DENSE_LINE_MAX)
  assert.ok(
    calls.some((call) => call.name === 'arc' && call.args[2] > 0),
    'the query gets a ring',
  )
})

test('cardView names every fallback state and counts what changed', () => {
  const base = { locale: 'zh', semantic: { state: 'ready' }, trace: trace(), error: '' }
  assert.equal(cardView(base).state, 'hybrid')
  assert.equal(cardView(base).counts.lexical, 1)
  assert.equal(cardView(base).counts.denseOnly, 1)
  assert.equal(
    cardView({ ...base, semantic: { state: 'unavailable', reason: 'provider-disabled' } }).state,
    'provider-disabled',
  )
  assert.equal(
    cardView({ ...base, semantic: { state: 'warming', count: 3, total: 9 } }).state,
    'warming',
  )
  assert.equal(cardView({ ...base, error: 'boom' }).state, 'route-error')
  assert.equal(cardView({ ...base, trace: { ...trace(), guard: true } }).state, 'guard')
  assert.equal(
    cardView({ ...base, trace: { ...trace(), fallback: 'provider-error' } }).state,
    'provider-error',
  )
  assert.equal(cardView({ ...base, trace: null }).state, 'idle')
  for (const key of ['title', 'privacy', 'replay'])
    assert.ok(CARD_COPY.zh[key] && CARD_COPY.en[key])
})

test('the controller keeps cursor, starts the map once and dedupes recall polling', async () => {
  const posted = []
  const controller = createSemanticController({
    post: async (payload) => {
      posted.push(payload)
      if (payload.action === 'semantic') return { state: 'ready', points: [['a.md', 0, 0]] }
      if (payload.action === 'recall') return { cursor: 2, events: [] }
      if (payload.action === 'explain') return trace()
      return { path: payload.path, state: 'ready', neighbors: [] }
    },
  })
  assert.equal(RECALL_POLL_MS, 1500)
  assert.equal((await controller.loadMap()).state, 'ready')
  assert.equal(posted.filter((payload) => payload.action === 'semantic').length, 1)
  await controller.poll('s1')
  await controller.poll('s1')
  assert.deepEqual(
    posted.filter((payload) => payload.action === 'recall').map((payload) => payload.cursor),
    [0, 2],
  )
  assert.equal((await controller.replay('s1', '退避')).source, 'tool')
})
