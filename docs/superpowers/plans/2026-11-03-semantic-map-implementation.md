# Semantic Map Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Reverted 2026-11-05:** this plan was executed and then the feature was removed on
> the owner's decision (see the spec's Status line). Keep it as the historical record;
> do not implement it again without a new decision.

**Goal:** Add a second layout to the memory graph tab — a server-projected 2D embedding map — that replays a recall trace so the user can see, node by node, how dense retrieval changed the lexical answer.

**Architecture:** A pure projection module (`lib/semantic-map.js`) turns the existing embedding-store snapshot into deterministic PCA coordinates; a process-local ring (`lib/recall-trace.js`) keeps the last 20 full recall traces per session, never on disk. `lib/hybrid-recall.js` attaches the trace non-enumerably to its hit array, `lib/services.js` records it and exposes four read-only methods, and `POST /obsidian-mem/graph` gains four actions. On the client a new served module (`lib/graph-semantic.js`) turns traces into overlay geometry/cards, `lib/graph-renderer.js` gains a static layout plus an overlay hook, and `lib/client.js` wires the layout switch. The original link graph, its filters, and `graph-recall` cues are untouched.

**Tech Stack:** Node ≥22.22.2 ESM, `node --test`, existing `node:sqlite` index, the local Qwen3-Embedding-0.6B loopback provider (1024-d), hand-written React (`h()`) browser bundle, no bundler, two runtime deps unchanged (`schemastery`, `yaml`).

**Spec:** `docs/superpowers/specs/2026-11-03-semantic-map-design.md`

## Global Constraints

- Node floor `>=22.22.2`; no new runtime dependencies, no new devDependencies, no bundler, no build step.
- The panel has exactly three tabs: `['overview', 'graph', 'health']`; semantic is a **layout inside graph**, never a fourth tab. `test/panel-client.test.js:335` pins the tab literal — do not change it.
- Read-only routes: no new action may call `warm()` or `sync()`, write to the vault, or write under `$DSH_HOME/data/obsidian-mem/`.
- Privacy: query text, query vectors, candidate paths and ranks live only in process memory (ring max 64 sessions × 20 traces). Never in the vault, never in the diagnostic JSONL, never serialized as vectors in an HTTP response.
- Panel CSS: only allowlisted `--dsw-*` tokens; no hex/rgb/hsl colors, no gradients, no custom `font-family` (`test/panel-client.test.js:528-560`). Every consumed `mem-*` class needs a style rule (`:1195`).
- Browser modules must not import `lib/locale.js`; inline `detectLocale()` and `t(zh, en)` at use sites, as `lib/client.js:13-32` and `lib/graph-renderer.js:30-46` do.
- Every `/obsidian-mem/*.js` URL literal in `lib/client.js` must exist in `lib/` and be in a route asset list (`test/panel-assets.test.js`, `test/graph-route.test.js`).
- New `lib/` modules need a `LAYERS` entry in `test/architecture.test.js`; imports must point strictly downward (`layers[target] < layers[node]`). Budgets: default 600 lines; raises allowed only with a rationale comment next to the budget.
- `docs/` is gitignored (`.gitignore:20`) but design/plan docs are tracked by convention: `git add -f` when committing this plan and any `docs/validation/` record.
- Commits carry **no `Co-Authored-By`** trailer.
- Before every commit: `npm run check:fast`. Before every push: `npm run check`.
- Claims need evidence: anything not run in CI is written as unverified in `CHANGELOG.md` (repo rule 6).

---

### Task 1: Deterministic 2D projection

**Files:**
- Create: `lib/semantic-map.js`
- Test: `test/semantic-map.test.js`

**Interfaces:**
- Consumes: nothing from the repo.
- Produces:
  - `PCA_ITERATIONS = 24`
  - `createSemanticProjection({ vectors, total, generatedAt = null, iterations = PCA_ITERATIONS })` → `{ state: 'ready'|'warming'|'degenerate', count, total, explained, generatedAt, points: Map<string, {x,y}>, project(vector): {x,y}|null }` where `points` coordinates are in `[0,1]²` and the square preserves aspect.
  - `nearestNeighbors(vectors, path, { limit = 8 } = {})` → `[{ path, score, rank }]` (rank is 1-based), `[]` when the path is absent.

- [ ] **Step 1: Write the failing tests**

```js
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createSemanticProjection, nearestNeighbors } from '../lib/semantic-map.js'

const unit = (values) => Float64Array.from(values)

test('the projection is deterministic, complete and inside the unit square', () => {
  const vectors = new Map([
    ['a.md', unit([1, 0, 0])],
    ['b.md', unit([0, 1, 0])],
    ['c.md', unit([0.7, 0.7, 0])],
    ['d.md', unit([0, 0, 1])],
  ])
  const first = createSemanticProjection({ vectors, total: 4 })
  const second = createSemanticProjection({ vectors: new Map([...vectors].reverse()), total: 4 })
  assert.equal(first.state, 'ready')
  assert.equal(first.count, 4)
  assert.deepEqual([...first.points], [...second.points], 'Map insertion order must not matter')
  for (const { x, y } of first.points.values()) {
    assert.ok(x >= 0 && x <= 1 && y >= 0 && y <= 1)
  }
  assert.ok(first.explained > 0 && first.explained <= 1)
})

test('project describes a vector with the cached basis', () => {
  const vectors = new Map([
    ['a.md', unit([1, 0])],
    ['b.md', unit([0, 1])],
    ['c.md', unit([1, 1])],
  ])
  const projection = createSemanticProjection({ vectors, total: 3 })
  const own = projection.project(vectors.get('b.md'))
  const point = projection.points.get('b.md')
  assert.ok(Math.abs(own.x - point.x) < 1e-9 && Math.abs(own.y - point.y) < 1e-9)
  assert.equal(projection.project([1, 0, 0]), null, 'a different dimension is refused')
})

test('an incomplete or empty store is warming, not ready', () => {
  const empty = createSemanticProjection({ vectors: new Map(), total: 10 })
  assert.equal(empty.state, 'warming')
  assert.equal(empty.points.size, 0)
  const partial = createSemanticProjection({
    vectors: new Map([['a.md', unit([1, 0])]]),
    total: 3,
  })
  assert.equal(partial.state, 'warming')
  assert.equal(partial.count, 1)
  assert.equal(partial.total, 3)
})

test('one-dimensional data is degenerate instead of NaN', () => {
  const projection = createSemanticProjection({
    vectors: new Map([
      ['a.md', unit([1, 1])],
      ['b.md', unit([2, 2])],
    ]),
    total: 2,
  })
  assert.equal(projection.state, 'degenerate')
  assert.equal(projection.project(unit([1, 1])), null)
})

test('nearestNeighbors ranks the other vectors by cosine and skips itself', () => {
  const vectors = new Map([
    ['a.md', unit([1, 0])],
    ['b.md', unit([0.9, 0.1])],
    ['c.md', unit([0, 1])],
  ])
  const neighbors = nearestNeighbors(vectors, 'a.md', { limit: 2 })
  assert.deepEqual(
    neighbors.map((entry) => entry.path),
    ['b.md', 'c.md'],
  )
  assert.equal(neighbors[0].rank, 1)
  assert.equal(nearestNeighbors(vectors, 'missing.md'), undefined?.length ?? 0)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/semantic-map.test.js`
Expected: FAIL — `Cannot find module '../lib/semantic-map.js'`.

- [ ] **Step 3: Write the implementation**

```js
// @ts-check
// Project the vault's embedding vectors to two deterministic dimensions.
//
// PCA runs against the covariance *operator*, never a materialised d×d matrix:
// the store is 1024-dimensional and a 1024² matrix per projection costs more
// than the iteration it feeds. Power iteration with Gram–Schmidt deflation
// gives the first two components in O(iterations · n · d). The start vector is a
// fixed function of the coordinate index, so two runs over the same vectors are
// byte-identical — the point cloud does not reshuffle between panel reloads.

export const PCA_ITERATIONS = 24
const EPSILON = 1e-12
const GOLDEN = 0.6180339887498949

function dot(a, b) {
  let sum = 0
  for (let index = 0; index < a.length; index += 1) sum += a[index] * b[index]
  return sum
}

function normalize(vector) {
  const norm = Math.sqrt(dot(vector, vector))
  if (!(norm > EPSILON)) return null
  for (let index = 0; index < vector.length; index += 1) vector[index] /= norm
  return vector
}

function startVector(dimensions) {
  const vector = new Float64Array(dimensions)
  for (let index = 0; index < dimensions; index += 1)
    vector[index] = 1 + Math.sin((index + 1) * GOLDEN)
  return normalize(vector)
}

export function createSemanticProjection({
  vectors,
  total,
  generatedAt = null,
  iterations = PCA_ITERATIONS,
}) {
  const empty = (state, count = 0) => ({
    state,
    count,
    total,
    explained: 0,
    generatedAt,
    points: new Map(),
    project: () => null,
  })
  if (!(vectors instanceof Map) || vectors.size === 0) return empty('warming')
  const paths = [...vectors.keys()].sort()
  const dimensions = vectors.get(paths[0]).length
  const usable = []
  for (const path of paths) {
    const vector = vectors.get(path)
    if (!Array.isArray(vector) && !ArrayBuffer.isView(vector)) return empty('warming')
    if (vector.length !== dimensions) continue
    usable.push({ path, vector: Float64Array.from(vector) })
  }
  if (usable.length === 0) return empty('warming')
  if (usable.length < total) return empty('warming', usable.length)
  const mean = new Float64Array(dimensions)
  for (const { vector } of usable)
    for (let index = 0; index < dimensions; index += 1) mean[index] += vector[index]
  for (let index = 0; index < dimensions; index += 1) mean[index] /= usable.length
  const apply = (vector) => {
    const target = new Float64Array(dimensions)
    for (const { vector: point } of usable) {
      let weight = 0
      for (let index = 0; index < dimensions; index += 1)
        weight += (point[index] - mean[index]) * vector[index]
      for (let index = 0; index < dimensions; index += 1)
        target[index] += weight * (point[index] - mean[index])
    }
    return target
  }
  const component = (previous) => {
    let vector = startVector(dimensions)
    for (let round = 0; round < iterations; round += 1) {
      const next = apply(vector)
      if (previous !== null) {
        const projection = dot(next, previous)
        for (let index = 0; index < dimensions; index += 1)
          next[index] -= projection * previous[index]
      }
      const unit = normalize(next)
      if (unit === null) return null
      vector = unit
    }
    return vector
  }
  const first = component(null)
  const second = first === null ? null : component(first)
  if (first === null || second === null) return empty('degenerate')
  const trace = usable.reduce((sum, { vector }) => {
    let squared = 0
    for (let index = 0; index < dimensions; index += 1) {
      const delta = vector[index] - mean[index]
      squared += delta * delta
    }
    return sum + squared
  }, 0)
  const lambda1 = dot(first, apply(first))
  const lambda2 = dot(second, apply(second))
  if (!(trace > EPSILON) || !(lambda1 + lambda2 > EPSILON)) return empty('degenerate')
  const raw = usable.map(({ path, vector }) => {
    const centred = (axis) => {
      let value = 0
      for (let index = 0; index < dimensions; index += 1)
        value += (vector[index] - mean[index]) * axis[index]
      return value
    }
    return { path, x: centred(first), y: centred(second) }
  })
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (const point of raw) {
    minX = Math.min(minX, point.x)
    maxX = Math.max(maxX, point.x)
    minY = Math.min(minY, point.y)
    maxY = Math.max(maxY, point.y)
  }
  const span = Math.max(maxX - minX, maxY - minY)
  if (!(span > EPSILON)) return empty('degenerate')
  const midX = (minX + maxX) / 2
  const midY = (minY + maxY) / 2
  const points = new Map(
    raw.map(({ path, x, y }) => [path, { x: (x - midX) / span + 0.5, y: (y - midY) / span + 0.5 }]),
  )
  const project = (vector) => {
    if (!vector || vector.length !== dimensions) return null
    const axis = (direction) => {
      let value = 0
      for (let index = 0; index < dimensions; index += 1)
        value += (vector[index] - mean[index]) * direction[index]
      return value
    }
    return { x: (axis(first) - midX) / span + 0.5, y: (axis(second) - midY) / span + 0.5 }
  }
  return {
    state: 'ready',
    count: usable.length,
    total,
    explained: (lambda1 + lambda2) / trace,
    generatedAt,
    points,
    project,
  }
}

export function nearestNeighbors(vectors, path, options = {}) {
  const limit = Number.isSafeInteger(options.limit) && options.limit > 0 ? options.limit : 8
  const target = vectors instanceof Map ? vectors.get(path) : undefined
  if (target === undefined || target === null) return []
  const targetNorm = Math.sqrt(dot(target, target))
  if (!(targetNorm > EPSILON)) return []
  const scored = []
  for (const [other, vector] of vectors) {
    if (other === path || vector.length !== target.length) continue
    const norm = Math.sqrt(dot(vector, vector))
    if (!(norm > EPSILON)) continue
    scored.push({ path: other, score: dot(target, vector) / (targetNorm * norm) })
  }
  scored.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
  return scored.slice(0, limit).map((entry, index) => ({ ...entry, rank: index + 1 }))
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/semantic-map.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/semantic-map.js test/semantic-map.test.js
git commit -m "feat(semantic-map): add the deterministic pca projection"
```

---

### Task 2: In-memory recall-trace ring

**Files:**
- Create: `lib/recall-trace.js`
- Test: `test/recall-trace.test.js`

**Interfaces:**
- Consumes: nothing from the repo.
- Produces:
  - `RECALL_TRACE_MAX_SESSIONS = 64`, `RECALL_TRACE_MAX_PER_SESSION = 20`, `RECALL_QUERY_TEXT_MAX = 200`, `TRACE_VIEW_BYTES = 12 * 1024`
  - `lexicalTrace(paths, { guard = false, fallback = null, denseCandidates = 0, embedMs = 0 } = {})` → structural trace
  - `createRecallTrace()` → `{ record(sessionId, trace) → cursor|null, recordFromHits(sessionId, { queryText, source, tookMs, hits }) → cursor|null, since(sessionId, after = 0) → { cursor, events }, clear(sessionId) }`
  - `toTraceView(trace, { project = null } = {})` → wire view; `project(vector)` returns `{x,y}|null`, vectors never serialized
  - `fitTraceView(view, { maxBytes = TRACE_VIEW_BYTES } = {})` → view whose `JSON.stringify` is ≤ maxBytes, with `truncated: true` when rows were dropped

- [ ] **Step 1: Write the failing tests**

```js
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
    denseTop: Array.from({ length: 80 }, (_, index) => ({ ...entry('d' + index + '.md', index), score: 1 })),
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

test('the ring keeps the newest 20 per session, 64 sessions, and since is incremental', () => {
  const ring = createRecallTrace()
  for (let index = 0; index < RECALL_TRACE_MAX_PER_SESSION + 5; index += 1) {
    ring.record('s1', lexicalTrace([entry('n.md', 0)]))
  }
  for (let index = 0; index < RECALL_TRACE_MAX_SESSIONS + 3; index += 1) {
    ring.record('s' + index, lexicalTrace([]))
  }
  const { events, cursor } = ring.since('s1')
  assert.equal(events.length, RECALL_TRACE_MAX_PER_SESSION)
  assert.equal(cursor, events.at(-1).cursor)
  assert.equal(ring.since('s1', cursor).events.length, 0)
  assert.equal(ring.since('s0').events.length, 0, 'the oldest sessions were evicted')
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
  const view = fitTraceView(toTraceView(ring.since('s1').events[0]), { maxBytes: 2_000 })
  assert.ok(new TextEncoder().encode(JSON.stringify(view)).length <= 2_000)
  assert.equal(view.truncated, true)
  assert.equal(view.fused.length, 20, 'fused rows survive')
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/recall-trace.test.js`
Expected: FAIL — `Cannot find module '../lib/recall-trace.js'`.

- [ ] **Step 3: Write the implementation**

```js
// @ts-check
// The in-memory recall replay ring.
//
// A trace names the query, its candidates and their ranks. That is exactly the
// data the privacy rules of the hybrid design keep out of the diagnostic journal,
// so it must never be written anywhere: this module has no fs, no vault, no
// diagnostics. The process rebuilding it on demand is the only copy, and losing
// it on exit is the design, not an accident.

export const RECALL_TRACE_MAX_SESSIONS = 64
export const RECALL_TRACE_MAX_PER_SESSION = 20
export const RECALL_QUERY_TEXT_MAX = 200
export const TRACE_LEXICAL_CAP = 50
export const TRACE_DENSE_CAP = 50
export const TRACE_FUSED_CAP = 20
export const TRACE_VIEW_BYTES = 12 * 1024

const clip = (value, max) => [...String(value ?? '')].slice(0, max).join('')
const list = (value) => (Array.isArray(value) ? value : [])
const rank = (entry, index) => (Number.isSafeInteger(entry?.rank) ? entry.rank : index + 1)
const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : 0)

export function lexicalTrace(paths, facts = {}) {
  const top = list(paths).slice(0, TRACE_LEXICAL_CAP).map((hit, index) => ({
    path: typeof hit === 'string' ? hit : String(hit?.path ?? ''),
    rank: index + 1,
  }))
  const filtered = top.filter((entry) => entry.path !== '').map((entry, index) => ({ ...entry, rank: index + 1 }))
  return {
    queryVector: null,
    guard: facts.guard === true,
    fallback: typeof facts.fallback === 'string' ? facts.fallback : null,
    denseCandidates: count(facts.denseCandidates),
    embedMs: count(facts.embedMs),
    lexicalTop: filtered,
    denseTop: [],
    fusedTop: filtered.slice(0, TRACE_FUSED_CAP).map((entry) => ({
      path: entry.path,
      source: 'lexical',
      lexicalRank: entry.rank,
      denseRank: null,
      semanticScore: null,
      hybridRank: entry.rank,
      lexicalHit: true,
    })),
  }
}

export function createRecallTrace() {
  const sessions = new Map()
  let cursor = 0
  return {
    record(sessionId, trace) {
      if (typeof sessionId !== 'string' || sessionId === '') return null
      if (trace === null || typeof trace !== 'object') return null
      cursor += 1
      const lexicalTop = list(trace.lexicalTop).slice(0, TRACE_LEXICAL_CAP).reduce((rows, entry) => {
        if (typeof entry?.path !== 'string' || entry.path === '') return rows
        rows.push({ path: entry.path, rank: rows.length + 1 })
        return rows
      }, [])
      const denseTop = list(trace.denseTop).slice(0, TRACE_DENSE_CAP).reduce((rows, entry) => {
        if (typeof entry?.path !== 'string' || entry.path === '') return rows
        rows.push({
          path: entry.path,
          rank: rows.length + 1,
          score: Number.isFinite(entry.score) ? Number(entry.score) : 0,
        })
        return rows
      }, [])
      const fusedTop = list(trace.fusedTop).slice(0, TRACE_FUSED_CAP).reduce((rows, entry) => {
        if (typeof entry?.path !== 'string' || entry.path === '') return rows
        rows.push({
          path: entry.path,
          source: entry.source === 'dense' ? 'dense' : 'lexical',
          lexicalRank: Number.isSafeInteger(entry.lexicalRank) ? entry.lexicalRank : null,
          denseRank: Number.isSafeInteger(entry.denseRank) ? entry.denseRank : null,
          semanticScore: Number.isFinite(entry.semanticScore) ? Number(entry.semanticScore) : null,
          hybridRank: rows.length + 1,
          lexicalHit: entry.lexicalHit === true,
        })
        return rows
      }, [])
      const entry = {
        cursor,
        at: Date.now(),
        source: trace.source === 'prompt' ? 'prompt' : trace.source === 'panel' ? 'panel' : 'tool',
        queryText: clip(trace.queryText, RECALL_QUERY_TEXT_MAX),
        queryVector:
          trace.queryVector instanceof Float32Array
            ? trace.queryVector
            : trace.queryVector
              ? Float32Array.from(trace.queryVector)
              : null,
        engine: typeof trace.engine === 'string' ? trace.engine : 'hybrid',
        fallback: typeof trace.fallback === 'string' ? trace.fallback : null,
        guard: trace.guard === true,
        denseCandidates: count(trace.denseCandidates),
        embedMs: count(trace.embedMs),
        tookMs: count(trace.tookMs),
        lexicalTop,
        denseTop,
        fusedTop,
      }
      const existing = sessions.get(sessionId)
      sessions.delete(sessionId)
      sessions.set(sessionId, {
        cursor,
        traces: [...(existing?.traces ?? []), entry].slice(-RECALL_TRACE_MAX_PER_SESSION),
      })
      while (sessions.size > RECALL_TRACE_MAX_SESSIONS)
        sessions.delete(sessions.keys().next().value)
      return cursor
    },
    recordFromHits(sessionId, { queryText, source, tookMs, hits } = {}) {
      const trace = hits?.hybridTrace
      if (trace === undefined || trace === null) return null
      return this.record(sessionId, { ...trace, queryText, source, tookMs })
    },
    since(sessionId, after = 0) {
      const session = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined
      if (session === undefined) return { cursor: 0, events: [] }
      const floor = Number.isSafeInteger(after) && after >= 0 ? after : 0
      return { cursor: session.cursor, events: session.traces.filter((trace) => trace.cursor > floor) }
    },
    clear(sessionId) {
      if (typeof sessionId === 'string') sessions.delete(sessionId)
    },
  }
}

export function toTraceView(trace, options = {}) {
  const project = typeof options.project === 'function' ? options.project : null
  let x = null
  let y = null
  if (trace.queryVector !== null && project !== null) {
    const point = project(trace.queryVector)
    if (point !== null && Number.isFinite(point.x) && Number.isFinite(point.y)) {
      x = point.x
      y = point.y
    }
  }
  return {
    cursor: trace.cursor,
    at: trace.at,
    source: trace.source,
    engine: trace.engine,
    fallback: trace.fallback,
    guard: trace.guard,
    denseCandidates: trace.denseCandidates,
    embedMs: trace.embedMs,
    tookMs: trace.tookMs,
    query: { text: trace.queryText, x, y },
    lexical: trace.lexicalTop,
    dense: trace.denseTop,
    fused: trace.fusedTop,
    truncated: false,
  }
}

export function fitTraceView(view, options = {}) {
  const maxBytes = Number.isSafeInteger(options.maxBytes) && options.maxBytes > 0 ? options.maxBytes : TRACE_VIEW_BYTES
  const next = { ...view, lexical: [...view.lexical], dense: [...view.dense], fused: [...view.fused] }
  const size = () => new TextEncoder().encode(JSON.stringify(next)).length
  while (size() > maxBytes) {
    if (next.dense.length > 1) {
      next.dense.pop()
      next.truncated = true
    } else if (next.lexical.length > 1) {
      next.lexical.pop()
      next.truncated = true
    } else {
      next.truncated = true
      break
    }
  }
  return next
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/recall-trace.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/recall-trace.js test/recall-trace.test.js
git commit -m "feat(recall-trace): add the in-memory replay ring"
```

---

### Task 3: Capture the trace at the hybrid seam

**Files:**
- Modify: `lib/hybrid-recall.js` (fallback helper, `rank()`, new `withHybridTrace`/`fusionTrace` helpers)
- Modify: `lib/prompt-recall.js` (mark the prompt caller)
- Test: `test/hybrid-recall.test.js` (extend)

**Interfaces:**
- Consumes: `lexicalTrace` from Task 2.
- Produces: every hit array returned by `rank()` carries `hits.hybridTrace` — a non-enumerable structural trace `{ queryVector: Float32Array|null, guard, fallback, denseCandidates, embedMs, lexicalTop, denseTop, fusedTop }` whose ranks are **1-based**.

- [ ] **Step 1: Write the failing tests** (append to `test/hybrid-recall.test.js`)

```js
test('a successful rank carries a non-enumerable structural trace', async (t) => {
  const { index } = await makeVault(t, [
    { path: 'Docs/retry.md', title: '重试策略', body: '失败重试要指数退避。' },
    { path: 'Docs/backoff.md', title: '退避', body: '失败重试要指数退避。' },
  ])
  const runtime = createHybridRecall({
    config: { retrievalProvider: { enabled: true, model: 'fake', dimensions: 2, timeoutMs: 500 } },
    dataRoot: '/tmp/unused-data-root',
    vaultRoot: '/tmp/unused-vault-root',
    index,
    provider: fakeProvider([1, 0]),
    store: fakeStore(
      new Map([
        [projectPath('Docs/retry.md'), [1, 0]],
        [projectPath('Docs/backoff.md'), [0.9, 0.1]],
      ]),
    ),
  })
  const lexicalTop = [lexicalHit(projectPath('Docs/retry.md'), 5)]
  const hits = await runtime.rank({ query: '重试', filters: {}, lexicalTop, limit: 2 })
  const trace = hits.hybridTrace
  assert.equal(hits.propertyIsEnumerable('hybridTrace'), false)
  assert.equal(trace.guard, false)
  assert.equal(trace.fallback, null)
  assert.equal(trace.denseCandidates, 2)
  assert.equal(trace.lexicalTop[0].rank, 1)
  assert.equal(trace.denseTop[0].rank, 1)
  assert.equal(trace.fusedTop[0].hybridRank, 1)
  assert.equal(trace.fusedTop[0].lexicalHit, true)
})

test('a guard fallback still carries a trace with guard:true and no dense rows', async (t) => {
  const { index } = await makeVault(t, [
    { path: 'Docs/retry.md', title: '重试策略', body: '失败重试要指数退避。' },
  ])
  const runtime = createHybridRecall({
    config: { retrievalProvider: { enabled: true, model: 'fake', dimensions: 2, timeoutMs: 500 } },
    dataRoot: '/tmp/unused-data-root',
    vaultRoot: '/tmp/unused-vault-root',
    index,
    provider: fakeProvider([1, 0]),
    store: fakeStore(new Map([[projectPath('Docs/retry.md'), [1, 0]]])),
  })
  const lexicalTop = [lexicalHit(projectPath('Docs/retry.md'), 12)]
  const hits = await runtime.rank({ query: '重试策略', filters: {}, lexicalTop, limit: 2 })
  assert.equal(hits.hybridTrace.guard, true)
  assert.equal(hits.hybridTrace.denseTop.length, 0)
  assert.equal(hits.hybridTrace.fusedTop[0].lexicalHit, true)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/hybrid-recall.test.js`
Expected: FAIL — `hits.hybridTrace` is `undefined`.

- [ ] **Step 3: Implement the trace attachment**

In `lib/hybrid-recall.js`, add the import and helpers:

```js
import { lexicalTrace } from './recall-trace.js'

/** Attach the replay trace without making it an element of the hit array. */
function withHybridTrace(hits, trace) {
  Object.defineProperty(hits, 'hybridTrace', { value: trace, enumerable: false })
  return hits
}

/** The structural trace of a successful fusion, with 1-based ranks. */
function fusionTrace(queryVector, lexicalTop, denseTop, fused, facts) {
  const lexicalRanks = new Map()
  for (const [index, hit] of lexicalTop.entries()) lexicalRanks.set(hit.path, index + 1)
  return {
    queryVector: queryVector instanceof Float32Array ? queryVector : Float32Array.from(queryVector),
    guard: false,
    fallback: null,
    denseCandidates: facts.denseCandidates,
    embedMs: facts.embedMs,
    lexicalTop: lexicalTop
      .slice(0, HYBRID_LEXICAL_LIMIT)
      .map((hit, index) => ({ path: hit.path, rank: index + 1 })),
    denseTop: denseTop.map((entry, index) => ({
      path: entry.path,
      rank: index + 1,
      score: entry.score,
    })),
    fusedTop: fused.map((entry) => ({
      path: entry.path,
      source: entry.source,
      lexicalRank: entry.lexicalRank === null ? null : entry.lexicalRank + 1,
      denseRank: entry.denseRank === null ? null : entry.denseRank + 1,
      semanticScore: entry.semanticScore,
      hybridRank: entry.hybridRank + 1,
      lexicalHit: entry.lexicalHit !== null,
    })),
  }
}
```

Rewrite `fallback` so the trace rides along:

```js
/** The lexical order plus a structural trace, for every non-dense branch. */
function fallback(lexicalTop, limit, facts = {}) {
  const hits = lexicalTop.slice(0, limit)
  return withHybridTrace(
    withHybridFacts(hits, {
      denseCandidates: facts.denseCandidates ?? 0,
      embedMs: facts.embedMs ?? 0,
      hybridFallback: facts.fallback ?? null,
    }),
    lexicalTrace(lexicalTop, facts),
  )
}
```

In `rank()`, the success return becomes:

```js
    const trace = fusionTrace(queryVector, lexicalTop, denseTop, fused, {
      denseCandidates: denseTop.length,
      embedMs,
    })
    return withHybridTrace(
      withHybridFacts(hits, {
        denseCandidates: denseTop.length,
        embedMs,
        hybridFallback: null,
      }),
      trace,
    )
```

Guard call site: `return fallback(lexicalTop, limit, { guard: true, fallback: null })`. Every other fallback call keeps its reason, e.g. `{ fallback: 'store-unreadable' }`, `{ fallback: 'store-warming' }`, `{ fallback: 'provider-disabled' }`, `{ fallback: 'provider-error' }`.

In `lib/prompt-recall.js:138`, mark the internal caller:

```js
  const args = { query, scope: 'project', limit: 8, traceSource: 'prompt' }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/hybrid-recall.test.js test/prompt-recall.test.js`
Expected: PASS. Existing assertions about hit arrays and fallbacks stay green because `hybridTrace` is non-enumerable.

- [ ] **Step 5: Commit**

```bash
git add lib/hybrid-recall.js lib/prompt-recall.js test/hybrid-recall.test.js
git commit -m "feat(recall): capture the structural trace at the hybrid seam"
```

---

### Task 4: Service data channel

**Files:**
- Modify: `lib/services.js` (imports; options destructure; closure helpers; `search()`; `hybridFor()`; the returned object)
- Test: `test/semantic-service.test.js`

**Interfaces:**
- Consumes: Tasks 1–3 (`createSemanticProjection`, `nearestNeighbors`, `createRecallTrace`, `lexicalTrace`, `toTraceView`, `fitTraceView`, `hits.hybridTrace`).
- Produces on the `createMemoryServices()` return value:
  - `semanticMap()` → `{ state, count, total, explained, generatedAt, mapKey, points: [path, x, y][] }` (`x`,`y` are integers `0..4095`)
  - `recallSince(sessionId, cursor = 0)` → `{ cursor, events: traceView[] }`
  - `explainSearch({ binding, query, sessionId })` → `traceView`
  - `semanticNeighbors({ path })` → `{ path, state, reason?, neighbors: [{path, score, rank}] }`
  - optional constructor seam `hybrid: injectedHybrid` (a test handle returned by `hybridFor`)

- [ ] **Step 1: Write the failing tests**

```js
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

import { validateConfig } from '../lib/config.js'
import { embeddingStorePath, openEmbeddingStore } from '../lib/embedding-store.js'
import { openIndex } from '../lib/index-db.js'
import { createMemoryServices } from '../lib/services.js'

const PROJECT_ID = '9a8b7c6d-5e4f-4a3b-2c1d-0e9f8a7b6c5d'
const PROJECT_DIR = 'Projects/semantic'
const pathOf = (relative) => `${PROJECT_DIR}/${relative}`

function renderNote(title, body) {
  return ['---', 'type: "doc"', `title: ${JSON.stringify(title)}`, 'status: "active"', `project: "${PROJECT_ID}"`, '---', '', `# ${title}`, '', body, ''].join('\n')
}

async function makeServices(t, configOverrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'obsidian-mem-semantic-service-'))
  const vault = join(root, 'vault')
  const dataRoot = join(root, 'data')
  await mkdir(dataRoot, { recursive: true })
  await mkdir(join(vault, ...PROJECT_DIR.split('/')), { recursive: true })
  await writeFile(join(vault, ...pathOf('retry.md').split('/')), renderNote('重试策略', '失败重试要指数退避。'))
  await writeFile(join(vault, ...pathOf('backoff.md').split('/')), renderNote('退避', '指数退避公式。'))
  const index = await openIndex({ vaultRoot: vault, dataRoot, backend: 'sqlite', projectId: PROJECT_ID })
  t.after(() => index.close().catch(() => {}))
  await index.waitReady(undefined, 10_000)
  const config = validateConfig({
    vaultPath: vault,
    enabled: true,
    retrievalEngine: 'hybrid',
    retrievalProvider: { enabled: true, model: 'fake', dimensions: 4, timeoutMs: 50 },
    ...configOverrides,
  })
  const rows = await index.candidateNotes({ kind: 'all', excludeStatuses: [], type: null })
  const store = await openEmbeddingStore({ dataRoot, vaultRoot: vault, model: 'fake', dimensions: 4 })
  await store.sync(rows, async ({ texts }) => ({
    model: 'fake',
    dimensions: 4,
    vectors: texts.map((text) => (text.includes('退避') ? [0, 1, 0, 0] : [1, 0, 0, 0])),
  }))
  const binding = { kind: 'bound', projectId: PROJECT_ID, projectPath: PROJECT_DIR, cwd: vault }
  return { root, vault, dataRoot, config, index, binding, storePath: embeddingStorePath({ dataRoot, vaultRoot: vault, model: 'fake', dimensions: 4 }) }
}

test('semanticMap reads the store, marks readiness and quantizes points', async (t) => {
  const fixture = await makeServices(t)
  const services = createMemoryServices({ config: fixture.config, dataRoot: fixture.dataRoot, cwd: fixture.vault, binding: fixture.binding })
  t.after(() => services.close?.())
  const map = await services.semanticMap()
  assert.equal(map.state, 'ready')
  assert.equal(map.count, 2)
  assert.equal(map.state === 'ready' ? map.points.length : 0, 2)
  for (const [, x, y] of map.points) assert.ok(Number.isInteger(x) && x >= 0 && x <= 4095 && Number.isInteger(y))
  assert.match(map.mapKey, /^\d+-\d+-2$/)
})

test('search records a tool trace and explain replays through the same pipeline', async (t) => {
  const fixture = await makeServices(t)
  const trace = {
    queryVector: Float32Array.from([1, 0, 0, 0]),
    guard: false,
    fallback: null,
    denseCandidates: 2,
    embedMs: 3,
    lexicalTop: [{ path: pathOf('retry.md'), rank: 1 }],
    denseTop: [{ path: pathOf('backoff.md'), rank: 1, score: 0.9 }],
    fusedTop: [
      { path: pathOf('retry.md'), source: 'lexical', lexicalRank: 1, denseRank: null, semanticScore: null, hybridRank: 1, lexicalHit: true },
      { path: pathOf('backoff.md'), source: 'dense', lexicalRank: null, denseRank: 1, semanticScore: 0.9, hybridRank: 2, lexicalHit: false },
    ],
  }
  const hybrid = {
    async rank({ lexicalTop, limit }) {
      const hits = lexicalTop.slice(0, limit).map((hit) => ({ ...hit, signals: { ...hit.signals, semanticScore: 0.9, hybridRank: 1 } }))
      Object.defineProperty(hits, 'hybridTrace', { value: trace, enumerable: false })
      Object.defineProperties(hits, {
        denseCandidates: { value: 2, enumerable: false },
        embedMs: { value: 3, enumerable: false },
        hybridFallback: { value: null, enumerable: false },
      })
      return hits
    },
  }
  const services = createMemoryServices({ config: fixture.config, dataRoot: fixture.dataRoot, cwd: fixture.vault, binding: fixture.binding, hybrid })
  const exec = { agent: { session: { header: { id: 'session-a', cwd: fixture.vault } } } }
  await services.search({ query: '重试' }, undefined, exec)
  const recalled = await services.recallSince('session-a', 0)
  assert.equal(recalled.events.length, 1)
  assert.equal(recalled.events[0].source, 'tool')
  assert.deepEqual(recalled.events[0].query, { text: '重试', x: recalled.events[0].query.x, y: recalled.events[0].query.y })
  const explained = await services.explainSearch({ binding: fixture.binding, query: '退避 重复', sessionId: 'session-a' })
  assert.equal(explained.source, 'panel')
  assert.equal(explained.fused[1].lexicalHit, false)
  const neighbors = await services.semanticNeighbors({ path: pathOf('retry.md') })
  assert.equal(neighbors.state, 'ready')
  assert.equal(neighbors.neighbors[0].path, pathOf('backoff.md'))
})

test('a disabled provider reports unavailable instead of pretending', async (t) => {
  const fixture = await makeServices(t, { retrievalProvider: { enabled: false } })
  const services = createMemoryServices({ config: fixture.config, dataRoot: fixture.dataRoot, cwd: fixture.vault, binding: fixture.binding })
  assert.deepEqual(await services.semanticMap(), {
    state: 'unavailable',
    reason: 'provider-disabled',
    count: 0,
    total: 0,
    explained: 0,
    generatedAt: null,
    mapKey: null,
    points: [],
  })
  assert.deepEqual(await services.recallSince('nobody'), { cursor: 0, events: [] })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/semantic-service.test.js`
Expected: FAIL — `services.semanticMap is not a function`.

- [ ] **Step 3: Implement the channel**

Add to the top of `lib/services.js`:

```js
import { stat } from 'node:fs/promises'

import { embeddingStorePath, openEmbeddingStore } from './embedding-store.js'
import {
  createRecallTrace,
  fitTraceView,
  lexicalTrace,
  toTraceView,
} from './recall-trace.js'
import { createSemanticProjection, nearestNeighbors } from './semantic-map.js'
```

In the `createMemoryServices(options)` destructure add `hybrid: injectedHybrid = null`. Validate it after the other option checks:

```js
  if (injectedHybrid !== null && typeof injectedHybrid !== 'object')
    throw new RangeError('createMemoryServices accepts only an object as hybrid')
```

Next to `const hybridByProject = new Map()` add:

```js
  /** The replay ring this service set records into (process memory only). */
  const recallTrace = createRecallTrace()
  /** Embedding-store handles per file identity; the projection cache follows them. */
  const storeByKey = new Map()
  let projectionCache = null
```

`hybridFor` gains the seam as its first branch after the config check:

```js
    if (injectedHybrid !== null) return injectedHybrid
```

Insert the data-channel helpers immediately before `return {` (after `publishedPaths`):

```js
  /** The selected provider identity, or null when no vector channel is configured. */
  function providerIdentity() {
    const block = config?.retrievalProvider ?? {}
    if (config.retrievalEngine !== 'hybrid' || block.enabled !== true) return null
    if (typeof block.model !== 'string' || block.model === '') return null
    if (!Number.isInteger(block.dimensions) || block.dimensions <= 0) return null
    return { model: block.model, dimensions: block.dimensions }
  }

  /** Open the store file once per identity and return its snapshot. Read-only. */
  async function embeddingSnapshot() {
    const identity = providerIdentity()
    if (identity === null) return { state: 'unavailable', reason: 'provider-disabled' }
    let root
    try {
      root = await vaultRoot()
    } catch (error) {
      return { state: 'unavailable', reason: typeof error?.code === 'string' ? error.code : 'vault-unavailable' }
    }
    const path = embeddingStorePath({ dataRoot, vaultRoot: root, ...identity })
    let file
    try {
      file = await stat(path)
    } catch {
      return { state: 'unavailable', reason: 'store-missing' }
    }
    const key = `${path}:${file.mtimeMs}:${file.size}`
    let store = storeByKey.get(key)
    if (store === undefined) {
      store = await openEmbeddingStore({ dataRoot, vaultRoot: root, ...identity })
      storeByKey.set(key, store)
    }
    try {
      return { state: 'ready', snapshot: await store.snapshot(), file }
    } catch {
      return { state: 'unavailable', reason: 'store-unreadable' }
    }
  }

  /** The cached projection, recalculated only when the store identity changes. */
  async function semanticProjection() {
    const identity = providerIdentity()
    if (identity === null)
      return { state: 'unavailable', reason: 'provider-disabled', count: 0, total: 0, points: new Map(), mapKey: null, project: () => null }
    const loaded = await embeddingSnapshot()
    if (loaded.state !== 'ready')
      return { state: 'unavailable', reason: loaded.reason, count: 0, total: 0, points: new Map(), mapKey: null, project: () => null }
    const index = await indexFor(binding)
    const rows = await index.candidateNotes({ kind: 'all', excludeStatuses: [], type: null })
    const mapKey = `${loaded.file.mtimeMs}-${loaded.file.size}-${rows.length}`
    if (projectionCache !== null && projectionCache.mapKey === mapKey) return projectionCache.projection
    const projection = {
      ...createSemanticProjection({
        vectors: loaded.snapshot.vectors,
        total: rows.length,
        generatedAt: loaded.snapshot.generatedAt,
      }),
      mapKey,
    }
    projectionCache = { mapKey, projection }
    return projection
  }

  async function semanticMapView() {
    const projection = await semanticProjection()
    if (projection.state !== 'ready')
      return {
        state: projection.state,
        reason: projection.reason ?? null,
        count: projection.count ?? 0,
        total: projection.total ?? 0,
        explained: projection.explained ?? 0,
        generatedAt: projection.generatedAt ?? null,
        mapKey: projection.mapKey ?? null,
        points: [],
      }
    return {
      state: 'ready',
      count: projection.count,
      total: projection.total,
      explained: projection.explained,
      generatedAt: projection.generatedAt,
      mapKey: projection.mapKey,
      // Quantized to 0..4095: two integers per note keep a 1,404-note payload far
      // below the route's 48 KiB budget, and 1/4095 of the square is sub-pixel at
      // every zoom the renderer offers.
      points: [...projection.points].map(([path, point]) => [
        path,
        Math.round(point.x * 4095),
        Math.round(point.y * 4095),
      ]),
    }
  }

  async function recallSinceView(sessionId, cursor) {
    const after = Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0
    const { cursor: next, events } = recallTrace.since(sessionId, after)
    if (events.length === 0) return { cursor: next, events: [] }
    const projection = await semanticProjection()
    const project = projection.state === 'ready' ? projection.project : null
    return { cursor: next, events: events.map((event) => fitTraceView(toTraceView(event, { project }))) }
  }

  /** The one search pipeline the panel replay and the tool share. */
  async function explainSearchView(input) {
    const query = typeof input?.query === 'string' ? input.query.trim() : ''
    if (query === '') throw new RangeError('query required')
    const project = input?.binding?.kind === 'bound' ? input.binding : null
    const index = await indexFor(project)
    const hybrid = await hybridFor(project, index)
    const engine =
      config.retrievalEngine === 'hybrid' && config.retrievalProvider?.enabled !== true
        ? 'lexical'
        : config.retrievalEngine
    const started = Date.now()
    const hits = await searchNotes(index, {
      query: [...query].slice(0, 200).join(''),
      scope: project === null ? 'all' : 'project',
      type: null,
      projectId: project === null ? null : project.projectId,
      includeHistory: false,
      limit: 8,
      engine,
      hybrid,
      hybridContext: null,
      signal: undefined,
    })
    const structural = hits.hybridTrace ?? lexicalTrace(hits.map((hit) => hit.path), { fallback: 'provider-disabled' })
    const recorded = recallTrace.record(input?.sessionId ?? '', {
      ...structural,
      queryText: query,
      source: 'panel',
      tookMs: Math.max(0, Date.now() - started),
    })
    if (recorded === null) throw new RangeError('sessionId required')
    const projection = await semanticProjection()
    const projectFn = projection.state === 'ready' ? projection.project : null
    return fitTraceView(toTraceView(recallTrace.since(input.sessionId, recorded - 1).events[0], { project: projectFn }))
  }

  async function semanticNeighborsView(input) {
    const path = typeof input?.path === 'string' ? input.path : ''
    if (path === '') throw new RangeError('path required')
    const loaded = await embeddingSnapshot()
    if (loaded.state !== 'ready')
      return { path, state: 'unavailable', reason: loaded.reason, neighbors: [] }
    const neighbors = nearestNeighbors(loaded.snapshot.vectors, path, { limit: 8 })
    if (neighbors.length === 0 && !loaded.snapshot.vectors.has(path))
      return { path, state: 'unavailable', reason: 'note-not-embedded', neighbors: [] }
    return { path, state: 'ready', neighbors }
  }
```

In `search()`, between the `cue(...)` call and `return projectHits(hits)`:

```js
        recallTrace.recordFromHits(sessionIdOf(exec), {
          queryText: args.query,
          source: args.traceSource === 'prompt' ? 'prompt' : 'tool',
          tookMs: Math.max(0, Date.now() - started),
          hits,
        })
```

In the returned service object, after `async indexForBinding(binding) { ... },` add:

```js
    async semanticMap() {
      return semanticMapView()
    },

    async recallSince(sessionId, cursor = 0) {
      return recallSinceView(sessionId, cursor)
    },

    async explainSearch(input) {
      return explainSearchView(input)
    },

    async semanticNeighbors(input) {
      return semanticNeighborsView(input)
    },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/semantic-service.test.js test/hybrid-recall.test.js`
Expected: PASS (3 new tests). If `services.close` is undefined in the test, keep the optional call as written — the service set's disposer closes indexes.

- [ ] **Step 5: Commit**

```bash
git add lib/services.js test/semantic-service.test.js
git commit -m "feat(services): expose the semantic map and recall replay"
```

---

### Task 5: Graph route actions

**Files:**
- Modify: `lib/graph-route.js` (asset list; action dispatch)
- Test: `test/graph-route.test.js` (extend)

**Interfaces:**
- Consumes: Task 4 methods.
- Produces: `POST /obsidian-mem/graph` accepts `action: 'semantic' | 'recall' | 'explain' | 'neighbors'`; unknown actions still 400; every response keeps the `{ok, value|error}` envelope and the existing guards.

- [ ] **Step 1: Write the failing test** (append to `test/graph-route.test.js`)

```js
test('semantic actions pass through services and unknown actions stay a 400', async (t) => {
  const routes = new Map()
  const session = { header: { id: SESSION, cwd: '/work/demo' } }
  const ctx = {
    sessions: { get: (id) => (id === SESSION ? session : undefined) },
    webServer: {
      register: (route) => {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
  }
  const seen = []
  const services = {
    semanticMap: async () => ({ state: 'ready', count: 1, total: 1, points: [['note.md', 1, 2]] }),
    recallSince: async (sessionId, cursor) => {
      seen.push(['recall', sessionId, cursor])
      return { cursor: 3, events: [] }
    },
    explainSearch: async (input) => {
      seen.push(['explain', input.sessionId, input.query, input.binding?.projectId])
      return { cursor: 4, source: 'panel' }
    },
    semanticNeighbors: async (input) => {
      seen.push(['neighbors', input.path])
      return { path: input.path, state: 'ready', neighbors: [] }
    },
  }
  registerGraphRoute(ctx, {
    activity: createGraphActivity(),
    resolveBinding: async (cwd) => ({ kind: 'bound', projectId: 'project-one', cwd }),
    services,
  })
  const server = createServer((request, response) => routes.get(request.url).handler(request, response))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => server.close())
  const url = `http://127.0.0.1:${server.address().port}/obsidian-mem/graph`
  const post = async (payload) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    return { status: response.status, body: await response.json() }
  }
  assert.equal((await post({ sessionId: SESSION, action: 'semantic' })).body.value.state, 'ready')
  assert.deepEqual((await post({ sessionId: SESSION, action: 'recall', cursor: 2 })).body.value, {
    cursor: 3,
    events: [],
  })
  assert.equal(seen[0][2], 2)
  assert.equal((await post({ sessionId: SESSION, action: 'explain', query: '退避' })).body.value.source, 'panel')
  assert.deepEqual(seen[1], ['explain', SESSION, '退避', 'project-one'])
  assert.equal((await post({ sessionId: SESSION, action: 'neighbors', path: 'note.md' })).body.value.path, 'note.md')
  assert.equal((await post({ sessionId: SESSION, action: 'nope' })).status, 400)
  assert.equal((await post({ sessionId: SESSION, action: 'semantic' })).body.ok, true)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/graph-route.test.js`
Expected: FAIL — `action:'semantic'` is rejected by the unknown-action guard.

- [ ] **Step 3: Implement**

In `lib/graph-route.js`'s POST handler, after the `activity` branch and before the `payload.action !== undefined && payload.action !== 'snapshot'` check, accept the new actions:

```js
        if (payload.action === 'semantic') {
          reply(response, 200, { ok: true, value: await services.semanticMap() })
          return
        }
        if (payload.action === 'recall') {
          const cursor =
            Number.isSafeInteger(payload.cursor) && payload.cursor >= 0 ? payload.cursor : 0
          reply(response, 200, {
            ok: true,
            value: await services.recallSince(sessionId, cursor),
          })
          return
        }
        if (payload.action === 'neighbors') {
          reply(response, 200, {
            ok: true,
            value: await services.semanticNeighbors({ path: payload.path }),
          })
          return
        }
```

Keep the existing `snapshot` path untouched, but allow `explain` through the action guard and place its branch after `binding` is resolved:

```js
        if (payload.action === 'explain') {
          reply(response, 200, {
            ok: true,
            value: await services.explainSearch({
              sessionId,
              binding,
              query: payload.query,
            }),
          })
          return
        }
```

The guard line becomes:

```js
        if (
          payload.action !== undefined &&
          payload.action !== 'snapshot' &&
          payload.action !== 'explain'
        )
          throw new RangeError('unknown graph action')
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/graph-route.test.js`
Expected: PASS. The served asset is added in Task 8, when `lib/graph-semantic.js` exists, so this task never leaves the asset list pointing at a missing file.

- [ ] **Step 5: Commit**

```bash
git add lib/graph-route.js test/graph-route.test.js
git commit -m "feat(graph-route): serve the semantic and replay actions"
```

---

### Task 6: Renderer static layout and overlay hook

**Files:**
- Modify: `lib/graph-renderer.js` (state; `setLayout`; `setOverlay`; `locate`; `draw`; return object)
- Test: `test/graph-renderer.test.js` (extend)

**Interfaces:**
- Consumes: nothing new.
- Produces on the `createGraphRenderer()` return value:
  - `setLayout({ mode: 'link'|'semantic', points: Map<id,{x,y}>|null })`
  - `setOverlay(painter | null)` — painter called after the node pass with `{ context, palette, now, reduced, width, height, scale, points: Map<id,{x,y,r}>, lookup: Map<id,node>, toScreen(point) }`
  - `locate(target: string | {x,y}) → boolean` — centres the view on a node path or a world point
  - exported `LAYOUT_TRANSITION_MS = 600`

- [ ] **Step 1: Write the failing tests** (append to `test/graph-renderer.test.js`)

```js
test('semantic mode uses the supplied coordinates and ignores worker frames', () => {
  const s = surface()
  s.renderer.update(s.model([s.node('one'), s.node('two')]))
  s.emit(['one'], [0, 0])
  s.step()
  s.renderer.setLayout({
    mode: 'semantic',
    points: new Map([
      ['one', { x: -100, y: 0 }],
      ['two', { x: 100, y: 0 }],
    ]),
  })
  s.advance(1000)
  s.emit(['one'], [500, 500])
  s.step()
  const arcs = s.contexts[0].calls.filter((call) => call.name === 'arc')
  assert.ok(arcs.length > 0)
  // 1000ms after the switch the transition is over: the two nodes sit 200 world
  // units apart, centred in an 800px viewport at scale 1.
  const xs = arcs.filter((call) => call.args[2] > 0).map((call) => Math.round(call.args[0]))
  assert.ok(xs.includes(300) && xs.includes(500))
})

test('reduced motion applies the semantic layout immediately', () => {
  const s = surface()
  s.setReduced(true)
  s.renderer.update(s.model([s.node('one')]))
  s.emit(['one'], [0, 0])
  s.step()
  s.renderer.setLayout({ mode: 'semantic', points: new Map([['one', { x: 80, y: 0 }]]) })
  s.step()
  const arcs = s.contexts[0].calls.filter((call) => call.name === 'arc')
  assert.equal(Math.round(arcs.at(-1).args[0]), 480)
})

test('the overlay painter receives screen points, the palette and locate works', () => {
  const s = surface()
  const frames = []
  s.renderer.setOverlay((frame) => frames.push(frame))
  s.renderer.update(s.model([s.node('one')]))
  s.emit(['one'], [0, 0])
  s.step()
  s.step()
  assert.ok(frames.length > 0)
  const frame = frames.at(-1)
  assert.ok(frame.points.get('one'))
  assert.ok(Number.isFinite(frame.points.get('one').x))
  assert.ok(frame.lookup.get('one'))
  assert.equal(frame.reduced, false)
  assert.equal(s.renderer.locate('one'), true)
  assert.equal(s.renderer.locate('missing.md'), false)
  assert.equal(s.renderer.locate({ x: 10, y: 10 }), true)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/graph-renderer.test.js`
Expected: FAIL — `setLayout is not a function`.

- [ ] **Step 3: Implement**

At the top of `lib/graph-renderer.js` export the transition constant:

```js
export const LAYOUT_TRANSITION_MS = 600
```

Add to state `s` (where the other fields are initialised):

```js
    layout: 'link',
    layoutPoints: null,
    layoutFrom: null,
    layoutStarted: 0,
    overlay: null,
```

Add the methods after `sync()`:

```js
  function setLayout({ mode, points = null } = {}) {
    const next = mode === 'semantic' ? 'semantic' : 'link'
    if (next === s.layout && next === 'link') return
    if (next === 'semantic') {
      const from = new Map()
      for (const [id, point] of s.points) from.set(id, { x: point.x, y: point.y })
      s.layoutFrom = from
      s.layoutStarted = win.performance.now()
    }
    s.layout = next
    s.layoutPoints = next === 'semantic' && points instanceof Map ? points : null
    if (next === 'link') {
      // Hand the semantic positions back to the force worker instead of
      // re-seeding it, so switching back does not teleport the graph.
      const nodes = {}
      for (const [id, point] of s.points) nodes[id] = [point.x, point.y]
      worker.postMessage({
        nodes,
        links: s.model.graph.edges.map((edge) => [edge.source, edge.target]),
        alpha: 0.3,
        run: true,
      })
    }
    changed()
  }

  function setOverlay(painter) {
    s.overlay = typeof painter === 'function' ? painter : null
    changed()
  }

  function locate(target) {
    if (target === null || target === undefined) return false
    let point = null
    if (typeof target === 'string') {
      point = s.nodes.find((node) => node.path === target)?.point ?? null
    } else if (Number.isFinite(target.x) && Number.isFinite(target.y)) {
      point = target
    }
    if (point === null) return false
    s.fit = false
    s.view.x = point.x
    s.view.y = point.y
    changed()
    return true
  }
```

In `worker.onmessage`, ignore frames while the semantic layout is active:

```js
    if (s.layout === 'semantic') return
```

In `draw()`, replace the node-position loop source. Before the loop over `s.nodes` compute:

```js
    const transition =
      s.layout === 'semantic'
        ? reducedMotion?.matches === true
          ? 1
          : clamp((win.performance.now() - s.layoutStarted) / LAYOUT_TRANSITION_MS, 0, 1)
        : 1
    const projected = new Map()
```

Inside the loop, where `node.x`/`node.y` are computed from `node.point`, use the semantic target instead:

```js
      let point = node.point
      if (s.layout === 'semantic' && s.layoutPoints !== null) {
        const target = s.layoutPoints.get(node.id) ?? point
        const from = s.layoutFrom?.get(node.id) ?? target
        if (target !== undefined && target !== null) {
          point = {
            x: from.x + (target.x - from.x) * transition,
            y: from.y + (target.y - from.y) * transition,
          }
        }
      }
```

Compute `node.x`, `node.y`, `node.r` from `point` exactly as before, then `projected.set(node.id, { x: node.x, y: node.y, r: node.r })`.

After the label loop and before the aria-label block, call the painter:

```js
    if (s.overlay !== null) {
      s.overlay({
        context,
        palette,
        now: win.performance.now(),
        reduced: reducedMotion?.matches === true,
        width: s.width,
        height: s.height,
        scale: s.view.scale,
        points: projected,
        lookup: s.lookup,
        toScreen: (point) => screen(point),
      })
    }
```

Add to the returned object:

```js
    setLayout,
    setOverlay,
    locate,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/graph-renderer.test.js`
Expected: PASS. Existing link-mode tests stay green because `layout` starts as `'link'` and the overlay defaults to `null`.

- [ ] **Step 5: Commit**

```bash
git add lib/graph-renderer.js test/graph-renderer.test.js
git commit -m "feat(graph-renderer): add the semantic layout and overlay hook"
```

---

### Task 7: Persist the layout choice

**Files:**
- Modify: `lib/graph-settings.js` (constants, `sanitize`, doc comment)
- Test: `test/graph-settings.test.js` (extend)

**Interfaces:**
- Consumes: nothing.
- Produces: the stored record keeps `version: 2` and gains `layout: 'link'|'semantic'` (default `'link'`) and `semanticEdges: boolean` (default `false`); unknown or missing values fall back field by field and never reset colour groups.

- [ ] **Step 1: Write the failing tests** (append to `test/graph-settings.test.js`)

```js
test('the layout choice round-trips and old records fall back to the link graph', () => {
  const store = storage()
  const settings = readGraphSettings(defaults(), store)
  assert.equal(settings.layout, 'link')
  assert.equal(settings.semanticEdges, false)
  writeGraphSettings({ ...settings, layout: 'semantic', semanticEdges: true }, defaults(), store)
  const saved = readGraphSettings(defaults(), store)
  assert.equal(saved.layout, 'semantic')
  assert.equal(saved.semanticEdges, true)
  assert.equal(GRAPH_SETTINGS_VERSION, 2)
})

test('a corrupt layout value falls back without erasing the colour groups', () => {
  const store = storage({
    [GRAPH_SETTINGS_KEY]: JSON.stringify({
      version: 2,
      layout: 'starfield',
      semanticEdges: 'yes',
      groups: [{ query: '[type:decision]', color: '#7b8ea6' }],
    }),
  })
  const saved = readGraphSettings(defaults(), store)
  assert.equal(saved.layout, 'link')
  assert.equal(saved.semanticEdges, false)
  assert.equal(saved.groups.length, 1)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/graph-settings.test.js`
Expected: FAIL — `settings.layout` is `undefined`.

- [ ] **Step 3: Implement**

In `sanitize()`, after the `forces` block and before the return, add:

```js
    // The semantic layout is a preference, not a migration: `version` stays 2 and
    // a record written before this field existed reads as the link graph.
    layout: source.layout === 'semantic' ? 'semantic' : 'link',
    semanticEdges: flag(source.semanticEdges, defaults.semanticEdges),
```

Update the module doc comment to list the two new fields.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/graph-settings.test.js test/graph-client.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/graph-settings.js test/graph-settings.test.js
git commit -m "feat(graph-settings): remember the semantic layout preference"
```

---

### Task 8: The served semantic module

**Files:**
- Create: `lib/graph-semantic.js`
- Test: `test/graph-semantic.test.js`

**Interfaces:**
- Consumes: `POST /obsidian-mem/graph` actions `semantic`, `recall`, `explain`, `neighbors`; no repo imports (browser-served leaf module).
- Produces:
  - `RECALL_POLL_MS = 1500`, `DENSE_LINE_MAX = 12`, `OVERLAY_DURATION_MS = 900`
  - `CARD_COPY` / `LAYOUT_COPY` / `NEIGHBORS_COPY` / `RECALL_COPY` (zh + en keys from the spec's appendix B)
  - `decodeMapPoints(map)` → `Map<path,{x,y}>` in world units (`0..1000`)
  - `createOverlayModel(trace, positionOf)` → `{ query:{x,y}|null, lexical:Set, dense:Map, fused:Map, lines:[{path,score}] } | null`
  - `createSemanticPainter(getTrace)` → `painter(frame)` callable by the renderer's overlay hook
  - `cardView({ locale, semantic, trace, error })` → plain object `{ state, tone, title, lines, counts, dense, query, privacy }`
  - `createSemanticController({ post, locale })` → `{ loadMap, poll(sessionId), replay(sessionId, query), neighbors(path), trace(), overlay(positionOf) }`
  - `mountCard({ document, locale, onReplay, onLocate })` → `{ element, update(input), destroy() }`

- [ ] **Step 1: Write the failing tests**

```js
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
  dense: Array.from({ length: 20 }, (_, index) => ({ path: 'd' + index + '.md', rank: index + 1, score: 0.9 - index * 0.01 })),
  fused: [
    { path: 'a.md', source: 'lexical', lexicalRank: 1, denseRank: 3, semanticScore: 0.8, hybridRank: 1, lexicalHit: true },
    { path: 'd1.md', source: 'dense', lexicalRank: null, denseRank: 1, semanticScore: 0.95, hybridRank: 2, lexicalHit: false },
  ],
  truncated: false,
})

test('decodeMapPoints and the overlay model are pure geometry', () => {
  const points = decodeMapPoints({ points: [['a.md', 0, 4095], ['b.md', 2047.5, 0]] })
  assert.deepEqual(points.get('a.md'), { x: 0, y: 1000 })
  assert.deepEqual(points.get('b.md'), { x: 500, y: 0 })
  const positions = new Map([['a.md', { x: 10, y: 20 }]])
  const model = createOverlayModel(trace(), (path) => positions.get(path) ?? null)
  assert.deepEqual(model.query, { x: 10, y: 20 })
  assert.equal(model.lexical.has('a.md'), true)
  assert.equal(model.dense.has('d1.md'), true)
  assert.equal(model.fused.get('d1.md'), 2)
  assert.equal(model.lines.length, DENSE_LINE_MAX)
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
  const model = createOverlayModel(trace(), (path) => (path === 'a.md' ? { x: 10, y: 20 } : { x: 30, y: 40 }))
  const painter = createSemanticPainter(() => ({ model, started: 0 }))
  painter({
    context,
    palette: { lineHighlight: { css: '#000', a: 1 }, fillHighlight: { css: '#111', a: 1 }, text: { css: '#222', a: 1 } },
    now: 10_000,
    reduced: true,
    scale: 1,
    points: new Map([['a.md', { x: 10, y: 20, r: 5 }]]),
    lookup: new Map([['a.md', { path: 'a.md' }]]),
    toScreen: (point) => ({ x: point.x, y: point.y }),
  })
  assert.ok(calls.some((call) => call.name === 'strokeRect'), 'lexical hits get a square ring')
  assert.ok(calls.filter((call) => call.name === 'moveTo').length >= DENSE_LINE_MAX)
  assert.ok(calls.some((call) => call.name === 'arc' && call.args[2] > 0), 'the query gets a ring')
})

test('cardView names every fallback state and counts what changed', () => {
  const base = { locale: 'zh', semantic: { state: 'ready' }, trace: trace(), error: '' }
  assert.equal(cardView(base).state, 'hybrid')
  assert.equal(cardView(base).counts.lexical, 1)
  assert.equal(cardView(base).counts.denseOnly, 1)
  assert.equal(cardView({ ...base, semantic: { state: 'unavailable', reason: 'provider-disabled' } }).state, 'provider-disabled')
  assert.equal(cardView({ ...base, semantic: { state: 'warming', count: 3, total: 9 } }).state, 'warming')
  assert.equal(cardView({ ...base, error: 'boom' }).state, 'route-error')
  assert.equal(cardView({ ...base, trace: { ...trace(), guard: true } }).state, 'guard')
  assert.equal(cardView({ ...base, trace: { ...trace(), fallback: 'provider-error' } }).state, 'provider-error')
  assert.equal(cardView({ ...base, trace: null }).state, 'idle')
  for (const key of ['title', 'privacy', 'replay']) assert.ok(CARD_COPY.zh[key] && CARD_COPY.en[key])
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/graph-semantic.test.js`
Expected: FAIL — `Cannot find module '../lib/graph-semantic.js'`.

- [ ] **Step 3: Write the module**

```js
// @ts-check
// The semantic overlay: trace geometry, the painter, the card model and the
// controller. This file is served as-is to the browser (`/obsidian-mem/graph-semantic.js`),
// so it imports nothing from `lib/`: the client's locale helpers are inlined the
// same way `lib/client.js` and `lib/graph-renderer.js` do it.

export const RECALL_POLL_MS = 1500
export const DENSE_LINE_MAX = 12
export const OVERLAY_DURATION_MS = 900

export const CARD_COPY = Object.freeze({
  zh: {
    title: '本轮召回解释',
    idle: '等待下一次记忆调用',
    hybrid: '语义 + 词法融合',
    guard: '词法守卫命中，本轮未走向量',
    warming: '语义索引预热中',
    providerDisabled: '未启用 embedding provider',
    providerError: 'embedding 服务暂不可用，已回退词法',
    mapUnavailable: '语义地图暂不可用',
    replay: '复现',
    replaying: '复现中…',
    privacy: '仅本机内存，进程退出即清除',
    lexical: '词法命中',
    denseOnly: '仅语义新增',
    promoted: '融合提升',
    retired: '被挤出',
  },
  en: {
    title: 'This recall, explained',
    idle: 'Waiting for the next memory call',
    hybrid: 'Semantic + lexical fusion',
    guard: 'Lexical guard held; the vector branch did not run',
    warming: 'Semantic index is warming',
    providerDisabled: 'No embedding provider is enabled',
    providerError: 'Embedding service unavailable; fell back to lexical',
    mapUnavailable: 'Semantic map unavailable',
    replay: 'Replay',
    replaying: 'Replaying…',
    privacy: 'Memory only; cleared when the process exits',
    lexical: 'lexical hits',
    denseOnly: 'dense-only',
    promoted: 'promoted',
    retired: 'displaced',
  },
})

export const LAYOUT_COPY = Object.freeze({
  zh: { link: '链接', semantic: '语义' },
  en: { link: 'Links', semantic: 'Semantic' },
})

export const NEIGHBORS_COPY = Object.freeze({
  zh: { title: '语义近邻', linked: '已链接', unlinked: '未链接' },
  en: { title: 'Semantic neighbors', linked: 'Linked', unlinked: 'Not linked' },
})

export const RECALL_COPY = Object.freeze({
  zh: { pill: '新召回 · 查看解释' },
  en: { pill: 'New recall · explain' },
})

const identity = (value) => {
  const text = typeof value === 'string' ? value : String(value ?? '')
  return text === '' ? null : text
}

export function decodeMapPoints(map) {
  const points = new Map()
  if (!map || !Array.isArray(map.points)) return points
  for (const entry of map.points) {
    if (!Array.isArray(entry) || entry.length < 3) continue
    const path = identity(entry[0])
    if (path === null) continue
    const x = Number(entry[1])
    const y = Number(entry[2])
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    // 0..4095 is the wire quantization; the renderer works in world units where
    // the whole square is 1000 wide, comfortably larger than the node radius.
    points.set(path, { x: (x / 4095) * 1000, y: (y / 4095) * 1000 })
  }
  return points
}

export function createOverlayModel(trace, positionOf) {
  if (trace === null || typeof trace !== 'object' || typeof positionOf !== 'function') return null
  const query =
    trace.query && Number.isFinite(trace.query.x) && Number.isFinite(trace.query.y)
      ? { x: trace.query.x, y: trace.query.y }
      : null
  const fused = Array.isArray(trace.fused) ? trace.fused : []
  const lexical = new Set()
  const dense = new Map()
  const fusedRank = new Map()
  for (const entry of fused) {
    const path = identity(entry?.path)
    if (path === null) continue
    if (entry.lexicalHit === true) lexical.add(path)
    if (Number.isSafeInteger(entry.hybridRank)) fusedRank.set(path, entry.hybridRank)
    if (Number.isSafeInteger(entry.denseRank) && Number.isFinite(entry.semanticScore))
      dense.set(path, entry.semanticScore)
  }
  const lines = (Array.isArray(trace.dense) ? trace.dense : [])
    .filter((entry) => identity(entry?.path) !== null && Number.isFinite(entry.score) && !lexical.has(entry.path))
    .sort((left, right) => right.score - left.score)
    .slice(0, DENSE_LINE_MAX)
    .map((entry) => ({ path: entry.path, score: entry.score }))
  return { query, lexical, dense, fused: fusedRank, lines }
}

export function createSemanticPainter(getState) {
  return function paint(frame) {
    const state = getState()
    const model = state?.model ?? null
    if (model === null) return
    const { context, palette, now, reduced } = frame
    const fade = reduced
      ? 1
      : Math.max(0, Math.min(1, (now - (state.started ?? 0)) / OVERLAY_DURATION_MS))
    const alpha = (slot) => (Number.isFinite(slot?.a) ? slot.a : 1) * fade
    const color = (slot) => (typeof slot?.css === 'string' ? slot.css : '#000')
    // Dense lines first: the query point and the hit rings must sit on top.
    if (model.query !== null) {
      const idByPath = new Map()
      for (const [id, node] of frame.lookup) idByPath.set(node.path, id)
      const query = frame.toScreen(model.query)
      for (const line of model.lines) {
        const destination = frame.points.get(idByPath.get(line.path))
        if (!destination) continue
        context.globalAlpha = alpha(palette.lineHighlight) * 0.5
        context.strokeStyle = color(palette.lineHighlight)
        context.lineWidth = 1
        context.beginPath()
        context.moveTo(query.x, query.y)
        context.lineTo(destination.x, destination.y)
        context.stroke()
      }
    }
    for (const [id, point] of frame.points) {
      const path = frame.lookup.get(id)?.path ?? null
      const isLexical = path !== null && model.lexical.has(path)
      const isDense = path !== null && model.dense.has(path)
      const rank = path !== null ? model.fused.get(path) : undefined
      if (isLexical) {
        context.globalAlpha = alpha(palette.fillHighlight)
        context.strokeStyle = color(palette.fillHighlight)
        context.lineWidth = 1.5
        const size = point.r + 4
        context.strokeRect(point.x - size, point.y - size, size * 2, size * 2)
      }
      if (isDense && !isLexical) {
        context.globalAlpha = alpha(palette.fillHighlight) * 0.7
        context.strokeStyle = color(palette.fillHighlight)
        context.lineWidth = 1
        context.setLineDash?.([3, 3])
        context.beginPath()
        context.arc(point.x, point.y, point.r + 5, 0, Math.PI * 2)
        context.stroke()
        context.setLineDash?.([])
      }
      if (Number.isSafeInteger(rank) && rank <= 3) {
        context.globalAlpha = fade
        context.fillStyle = color(palette.text)
        context.font = '10px sans-serif'
        context.fillText(String(rank), point.x + point.r + 3, point.y - point.r - 2)
      }
    }
    if (model.query !== null) {
      const query = frame.toScreen(model.query)
      context.globalAlpha = fade
      context.strokeStyle = color(palette.fillHighlight)
      context.lineWidth = 1.5
      for (const radius of [9, 13]) {
        context.beginPath()
        context.arc(query.x, query.y, radius, 0, Math.PI * 2)
        context.stroke()
      }
    }
    context.globalAlpha = 1
  }
}

export function cardView({ locale = 'zh', semantic = null, trace = null, error = '' } = {}) {
  const copy = CARD_COPY[locale === 'en' ? 'en' : 'zh']
  const state =
    error !== ''
      ? 'route-error'
      : semantic?.state === 'unavailable'
        ? semantic.reason === 'provider-disabled'
          ? 'provider-disabled'
          : 'map-unavailable'
        : semantic?.state === 'warming'
          ? 'warming'
          : trace === null || trace === undefined
            ? 'idle'
            : trace.guard === true
              ? 'guard'
              : trace.fallback === 'provider-error'
                ? 'provider-error'
                : trace.fallback === 'provider-disabled'
                  ? 'provider-disabled'
                  : 'hybrid'
  const fused = Array.isArray(trace?.fused) ? trace.fused : []
  const counts = {
    lexical: fused.filter((entry) => entry.lexicalHit === true).length,
    denseOnly: fused.filter((entry) => entry.lexicalHit !== true).length,
    promoted: fused.filter(
      (entry) =>
        entry.lexicalHit === true &&
        Number.isSafeInteger(entry.denseRank) &&
        Number.isSafeInteger(entry.lexicalRank) &&
        entry.hybridRank < entry.lexicalRank,
    ).length,
  }
  const dense = (Array.isArray(trace?.dense) ? trace.dense : [])
    .filter((entry) => fused.some((row) => row.path === entry.path && row.lexicalHit !== true))
    .slice(0, 5)
  return {
    state,
    tone: state === 'hybrid' ? 'active' : state === 'idle' ? 'idle' : 'quiet',
    title: copy.title,
    status: copy[state === 'route-error' ? 'mapUnavailable' : state === 'map-unavailable' ? 'mapUnavailable' : state === 'provider-disabled' ? 'providerDisabled' : state === 'provider-error' ? 'providerError' : state === 'warming' ? 'warming' : state === 'guard' ? 'guard' : state === 'idle' ? 'idle' : 'hybrid'],
    counts,
    dense,
    query: trace?.query?.text ?? '',
    privacy: copy.privacy,
    labels: {
      lexical: copy.lexical,
      denseOnly: copy.denseOnly,
      promoted: copy.promoted,
      replay: copy.replay,
    },
  }
}

export function createSemanticController({ post, locale = 'zh' } = {}) {
  if (typeof post !== 'function') throw new RangeError('createSemanticController requires post')
  let map = null
  let trace = null
  let started = 0
  let cursor = 0
  let error = ''
  return {
    async loadMap() {
      try {
        map = await post({ action: 'semantic' })
        error = ''
      } catch (cause) {
        error = cause.message
        map = { state: 'unavailable', reason: 'route-error' }
      }
      return map
    },
    async poll(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return { cursor, events: [] }
      try {
        const value = await post({ sessionId, action: 'recall', cursor })
        cursor = value.cursor
        if (Array.isArray(value.events) && value.events.length > 0) {
          trace = value.events.at(-1)
          started = Date.now()
          error = ''
        }
        return value
      } catch (cause) {
        error = cause.message
        return { cursor, events: [] }
      }
    },
    async replay(sessionId, query) {
      try {
        trace = await post({ sessionId, action: 'explain', query })
        started = Date.now()
        error = ''
        return trace
      } catch (cause) {
        error = cause.message
        return null
      }
    },
    async neighbors(path) {
      return post({ action: 'neighbors', path })
    },
    trace() {
      return trace
    },
    state() {
      return { map, trace, error }
    },
    overlay(positionOf) {
      return createOverlayModel(trace, positionOf)
    },
    decode(map) {
      return decodeMapPoints(map)
    },
    /** Renderer overlay hook: build the model from the latest trace and paint it. */
    paint(frame) {
      if (typeof frame?.lookup?.entries !== 'function' || typeof frame?.points?.get !== 'function')
        return
      const idByPath = new Map()
      for (const [id, node] of frame.lookup) idByPath.set(node.path, id)
      const model = createOverlayModel(trace, (path) => frame.points.get(idByPath.get(path)) ?? null)
      if (model === null) return
      return createSemanticPainter(() => ({ model, started }))(frame)
    },
    started() {
      return started
    },
    locale(localeTag) {
      locale = localeTag === 'en' ? 'en' : 'zh'
      return locale
    },
  }
}

export function mountCard({ document, locale = 'zh', onReplay, onLocate } = {}) {
  const copy = CARD_COPY[locale === 'en' ? 'en' : 'zh']
  const root = document.createElement('div')
  root.className = 'mem-semantic-card is-idle'
  const summary = document.createElement('button')
  summary.className = 'mem-semantic-card-summary'
  summary.type = 'button'
  const body = document.createElement('div')
  body.className = 'mem-semantic-card-body'
  const replay = document.createElement('input')
  replay.className = 'mem-semantic-card-replay'
  replay.placeholder = copy.replay
  const privacy = document.createElement('p')
  privacy.className = 'mem-semantic-card-privacy'
  privacy.textContent = copy.privacy
  body.appendChild(replay)
  body.appendChild(privacy)
  root.appendChild(summary)
  root.appendChild(body)
  let current = null
  let expanded = false
  const render = (view) => {
    current = view
    summary.textContent = view ? view.title + ' · ' + view.status : copy.title
    summary.setAttribute('aria-expanded', String(expanded))
    const detail = document.createElement('div')
    detail.className = 'mem-semantic-card-detail'
    if (view) {
      if (view.query) {
        const query = document.createElement('p')
        query.className = 'mem-semantic-card-query'
        query.textContent = view.query.slice(0, 80)
        detail.appendChild(query)
      }
      const counts = document.createElement('p')
      counts.className = 'mem-semantic-card-counts'
      counts.textContent =
        view.labels.lexical +
        ' ' +
        view.counts.lexical +
        ' · ' +
        view.labels.denseOnly +
        ' ' +
        view.counts.denseOnly +
        ' · ' +
        view.labels.promoted +
        ' ' +
        view.counts.promoted
      detail.appendChild(counts)
      for (const entry of view.dense) {
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'mem-semantic-card-dense'
        button.textContent = entry.path
        button.addEventListener('click', () => onLocate?.(entry.path))
        detail.appendChild(button)
      }
    }
    body.replaceChildren?.(detail)
    if (typeof body.replaceChildren !== 'function') {
      while (body.firstChild) body.removeChild(body.firstChild)
      body.appendChild(detail)
    }
    root.className = 'mem-semantic-card is-' + (view?.tone ?? 'idle') + (expanded ? ' is-open' : '')
  }
  summary.addEventListener('click', () => {
    expanded = !expanded
    render(current)
  })
  replay.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return
    const query = String(replay.value ?? '').trim()
    if (query !== '') onReplay?.(query)
  })
  return {
    element: root,
    update(input) {
      render(cardView({ locale, ...input }))
    },
    destroy() {
      root.remove?.()
    },
  }
}
```


- [ ] **Step 4: Register the served asset**

Add `'./graph-semantic.js'` to the default asset list in `lib/graph-route.js`, and add the asset assertion to the semantic-actions test in `test/graph-route.test.js`:

```js
  assert.ok(routes.has('/obsidian-mem/graph-semantic.js'), 'the served module is advertised')
```

Run: `node --test test/graph-route.test.js`
Expected: PASS — the asset walk in that file now reaches the new module.

- [ ] **Step 5: Run the module tests**

Run: `node --test test/graph-semantic.test.js`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add lib/graph-semantic.js lib/graph-route.js test/graph-semantic.test.js test/graph-route.test.js
git commit -m "feat(graph-semantic): add the overlay model, painter and card"
```

---

### Task 9: Client wiring

**Files:**
- Modify: `lib/client.js` (`GraphCanvas`; `GraphView`; `styles`)
- Test: `test/panel-client.test.js` (extend), `test/panel-assets.test.js` (extend only if the module list is pinned)

**Interfaces:**
- Consumes: `lib/graph-semantic.js` (dynamic import by URL), renderer `setLayout`/`setOverlay`/`locate`, settings `layout`/`semanticEdges`, route `semantic`/`recall`/`explain`/`neighbors`.
- Produces: a "布局 / Layout" control in the graph controls; semantic map fetched once per graph view; recall polled only while the graph tab is visible; card mounted under the canvas; no new tab and no change to `MEMORY_VIEWS`.

- [ ] **Step 1: Write the failing source-shape assertions** (append to `test/panel-client.test.js`)

```js
test('the graph view names the semantic module, the layout control and the card classes', async () => {
  const script = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.ok(script.includes("'/obsidian-mem/graph-semantic.js'"))
  assert.ok(script.includes('mem-semantic-card'))
  assert.ok(script.includes('mem-semantic-layout'))
  // The tab list stays three tabs; the semantic map is a layout, not a page.
  for (const word of ['overview', 'graph', 'health'])
    assert.ok(script.includes("id: '" + word + "'"))
  for (const className of ['mem-semantic-card', 'mem-semantic-layout'])
    assert.ok(script.includes('.' + className), 'every consumed class has a style rule')
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/panel-client.test.js`
Expected: FAIL — `lib/client.js` does not mention `graph-semantic.js`.

- [ ] **Step 3: Implement the wiring**

In `GraphCanvas` props add `layout` and `onReady` — the painter already closes over the controller, so the canvas needs neither the trace nor the controller. Keep the creation effect, and after `renderer.setForces(...)` add:

```js
            renderer.setLayout({
              mode: layout.mode,
              points: layout.mode === 'semantic' ? layout.points : null,
            })
            renderer.setOverlay(layout.mode === 'semantic' ? layout.painter : null)
```

Store the latest props in `state.current`:

```js
      state.current.layout = layout
      state.current.painter = layout.mode === 'semantic' ? layout.painter : null
```

Two effects after the `setForces` effect:

```js
      React.useEffect(() => {
        state.current.renderer?.setLayout({
          mode: layout.mode,
          points: layout.mode === 'semantic' ? layout.points : null,
        })
      }, [layout])
      React.useEffect(() => {
        state.current.renderer?.setOverlay(layout.mode === 'semantic' ? layout.painter : null)
      }, [layout])
```

In `GraphView`, add state and refs:

```js
      const [layoutMode, setLayoutMode] = React.useState('link')
      const [semantic, setSemantic] = React.useState(null)
      const [trace, setTrace] = React.useState(null)
      const semanticApi = React.useRef(null)
      const canvasRef = React.useRef(null)
      const cardHost = React.useRef(null)
      const card = React.useRef(null)
```

Extend the settings store defaults with `layout: 'link', semanticEdges: false`, and restore/save them:

```js
            const saved = store.current.read()
            setScope(saved.scope)
            setFilter(saved.filter)
            setGroups(saved.groups)
            setDisplay(saved.display)
            setForces(saved.forces)
            setLayoutMode(saved.layout)
```

The write effect payload becomes `{ scope, filter, groups, display, forces, layout: layoutMode, semanticEdges: false }`.

Add the module import effect:

```js
      React.useEffect(() => {
        let live = true
        void import('/obsidian-mem/graph-semantic.js')
          .then((module) => {
            if (!live) return
            semanticApi.current = module.createSemanticController({
              post,
              locale: localeTag,
            })
            if (cardHost.current) {
              card.current = module.mountCard({
                document: globalThis.document,
                locale: localeTag,
                onReplay: (query) => {
                  void semanticApi.current?.replay(sessionId, query).then((value) => {
                    if (value !== null) setTrace(value)
                  })
                },
                onLocate: (path) => {
                  canvasRef.current?.locate?.(path)
                },
              })
              cardHost.current.appendChild(card.current.element)
            }
          })
          .catch(() => {})
        return () => {
          live = false
          card.current?.destroy()
          card.current = null
        }
      }, [localeTag, sessionId])
```

Semantic map effect — fetch once per visible session while the layout is semantic:

```js
      React.useEffect(() => {
        if (!visible || !sessionId || layoutMode !== 'semantic') return undefined
        let cancelled = false
        const load = async () => {
          const value = await semanticApi.current?.loadMap()
          if (!cancelled) setSemantic(value ?? null)
        }
        void load()
        const timer = setInterval(load, 15000)
        return () => {
          cancelled = true
          clearInterval(timer)
        }
      }, [visible, sessionId, layoutMode])
```

Recall poll effect (kept separate from the 700 ms activity poll so link cues are unchanged):

```js
      React.useEffect(() => {
        if (!visible || !sessionId || layoutMode !== 'semantic') return undefined
        let cancelled = false
        let polling = false
        const poll = async () => {
          if (polling || !semanticApi.current) return
          polling = true
          try {
            const value = await semanticApi.current.poll(sessionId)
            if (cancelled) return
            if (Array.isArray(value.events) && value.events.length > 0)
              setTrace(value.events.at(-1))
          } finally {
            polling = false
          }
        }
        void poll()
        const timer = setInterval(poll, 1500)
        return () => {
          cancelled = true
          clearInterval(timer)
        }
      }, [visible, sessionId, layoutMode])
```

Build the layout object and painter:

```js
      const mapPoints = React.useMemo(() => {
        if (!semantic || semantic.state !== 'ready') return null
        return semanticApi.current?.decode?.(semantic) ?? null
      }, [semantic])
      const layout = React.useMemo(() => {
        const ready = layoutMode === 'semantic' && mapPoints !== null
        return {
          mode: ready ? 'semantic' : 'link',
          points: ready ? mapPoints : null,
          painter: ready ? (frame) => semanticApi.current?.paint(frame) : null,
        }
      }, [layoutMode, mapPoints])
```

The controller's `decode(map)` and `paint(frame)` methods are part of Task 8; the painter reads the controller's latest trace at draw time, so no React state needs to be threaded into `graph-renderer.js`.

Card update effect:

```js
      React.useEffect(() => {
        if (!card.current) return
        card.current.update({ semantic, trace, error })
      }, [semantic, trace, error])
```

Render: add a layout section and the card host. Pass `layout` and `onReady: (renderer) => { canvasRef.current = renderer }` to `h(GraphCanvas, ...)`; after the canvas, add:

```js
        h('div', { ref: cardHost, className: 'mem-semantic-card-host' }),
```

Inside the `display` section, add the layout switch (two buttons) using the existing control helpers:

```js
            h('div', { className: 'mem-semantic-layout', role: 'group', 'aria-label': t('图谱布局', 'Graph layout') },
              settingButton(t('链接', 'Links'), layoutMode === 'link', () => setLayoutMode('link')),
              settingButton(t('语义', 'Semantic'), layoutMode === 'semantic', () => setLayoutMode('semantic')),
            ),
```

where:

```js
      const settingButton = (label, active, change) =>
        h('button', {
          type: 'button',
          className: 'mem-semantic-layout-button' + (active ? ' is-active' : ''),
          'aria-pressed': String(active),
          onClick: change,
          textContent: label,
        })
```

Canvas ref handoff: `GraphCanvas` needs `onReady` and to call it after creating the renderer:

```js
            state.current.renderer = renderer
            onReady?.(renderer)
```

and pass `onReady` from `GraphView` as `(renderer) => { canvasRef.current = renderer }`.

In the `styles` array add token-only rules:

```js
      '.mem-semantic-card-host{position:absolute;left:12px;right:12px;bottom:12px;pointer-events:none;}',
      '.mem-semantic-card{pointer-events:auto;border:1px solid var(--dsw-border-subtle);border-radius:12px;background:var(--dsw-surface-raised);color:var(--dsw-text-primary);font-family:inherit;}',
      '.mem-semantic-card-summary{display:block;width:100%;text-align:left;padding:8px 12px;background:none;border:0;color:inherit;font:inherit;cursor:pointer;}',
      '.mem-semantic-card-body{display:none;padding:0 12px 10px;}',
      '.mem-semantic-card.is-open .mem-semantic-card-body{display:block;}',
      '.mem-semantic-card-privacy{color:var(--dsw-text-tertiary);font-size:11px;margin:6px 0 0;}',
      '.mem-semantic-card-query{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin:0 0 4px;}',
      '.mem-semantic-card-counts{color:var(--dsw-text-secondary);font-size:12px;margin:0 0 6px;}',
      '.mem-semantic-card-dense{display:block;width:100%;text-align:left;background:none;border:0;color:var(--dsw-text-link);padding:2px 0;font:inherit;cursor:pointer;}',
      '.mem-semantic-layout{display:inline-flex;gap:4px;}',
      '.mem-semantic-layout-button{border:1px solid var(--dsw-border-subtle);border-radius:8px;background:none;color:var(--dsw-text-primary);font:inherit;padding:2px 8px;cursor:pointer;}',
      '.mem-semantic-layout-button.is-active{background:var(--dsw-surface-hover);border-color:var(--dsw-border-strong);}',
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/panel-client.test.js test/panel-assets.test.js test/graph-route.test.js`
Expected: PASS. If `panel-client.test.js` rejects a `--dsw-*` token that does not exist in its allowlist, replace it with an allowlisted one from `:528-560` rather than widening the allowlist.

- [ ] **Step 5: Commit**

```bash
git add lib/client.js lib/graph-semantic.js test/panel-client.test.js
git commit -m "feat(panel): switch the graph between link and semantic layouts"
```

---

### Task 10: Budgets, docs and release notes

**Files:**
- Modify: `test/architecture.test.js` (LAYERS + BUDGETS)
- Modify: `README.md`, `README.zh.md`, `README.i18n.yaml` (pair rule)
- Modify: `CHANGELOG.md` (Unreleased)
- Modify: `AGENTS.md` (tarball paragraph, re-measured)
- Modify: `docs/superpowers/specs/2026-11-03-semantic-map-design.md` (Status line only)

- [ ] **Step 1: Extend the architecture test**

Add to `LAYERS`: `'semantic-map': 0, 'recall-trace': 0, 'graph-semantic': 0`. Add to `BUDGETS`: `'lib/semantic-map.js': 300, 'lib/recall-trace.js': 220, 'lib/graph-semantic.js': 520`. Raise and annotate the four that need it:

```js
    // The semantic layout adds the static-layout branch, the overlay hook and the
    // locate action to the renderer; the trace actions add a fourth action arm to
    // the route; the replay ring and the map cache live in services; the layout
    // switch and the card host live in the panel bundle. Each raise is bounded by
    // the design spec's §9 table and reviewed as one change.
    'lib/graph-renderer.js': 820,
    'lib/graph-route.js': 300,
    'lib/services.js': 2150,
    'lib/client.js': 1830,
```

- [ ] **Step 2: Re-measure the tarball and module count**

Run: `npm run pack:check`
Expected: the verifier reports the new real archive counts. Then run:

Run: `node scripts/verify-tarball.mjs`
Expected: prints the entry/module totals. Update the AGENTS.md paragraph with the measured numbers (the new modules add 3 entries and 3 modules; do not adjust by hand, use the output).

- [ ] **Step 3: Update the documentation pair**

In both `README.md` and `README.zh.md`, add one short paragraph to the memory-panel section: the graph tab has a layout switch (links / semantic), the semantic layout is a deterministic PCA projection of the embedding store, recall replays are in-memory only, and a disabled provider falls back with an explained card. Keep the two sides semantically equal. Then recompute the blob hashes:

```bash
git hash-object README.md README.zh.md
```

Put the two values into `README.i18n.yaml` (`readme.md` / `readme.zh.md` keys as the file already names them). If you add a link targeting a heading, add the `<a id="…">` English-slug anchor on the Chinese side, per AGENTS.md.

- [ ] **Step 4: Changelog**

Add one `Unreleased` entry with the behaviour and the honest verification split: `measured` = unit/route/renderer tests in `npm test`; `untested` = the real-vault PCA timing and the live provider replay (these become measured in Task 11). No feature is claimed as verified by CI before its task's test actually runs.

- [ ] **Step 5: Run the full gate and commit**

Run: `npm run check`
Expected: lint → format:check → types → suite → pack contract → real archive all pass.

```bash
git add test/architecture.test.js AGENTS.md CHANGELOG.md README.md README.zh.md README.i18n.yaml
git add -f docs/superpowers/specs/2026-11-03-semantic-map-design.md
git commit -m "docs(semantic-map): record the surface, budgets and release notes"
```

---

### Task 11: Real-vault acceptance

**Files:**
- Create: `docs/validation/semantic-map-2026-11-03.md` (force-add)
- Modify: `CHANGELOG.md` (move the acceptance claims to measured)

- [ ] **Step 1: Measure on the real vault**

Use this checkout's own vault (`~/Documents/dsh-memory`, project `dsh-obsidian-mem--05025725`, about 1,404 notes at plan time) with the local provider running at `127.0.0.1:8790`. Start the panel, switch the graph to the semantic layout, and record:

- first `semantic` action latency and payload bytes (browser devtools / `curl` against the route with `x-obsidian-mem-panel: 1`), then a second call to show the cache works;
- `explained` variance and `count`/`total` (the map must say `ready`, not a silent partial);
- one paraphrase replay (e.g. 「为什么发布总是卡住」) where the card shows at least one dense-only hit and the lexical rank displaced by a promoted hit;
- one exact-title replay producing the `guard` state;
- one replay with the embed server stopped producing `provider-error` and a lexical answer;
- after the replay, `git status --short` in the vault is clean and `$DSH_HOME/data/obsidian-mem/` gained no new files.

Write the commands, their output (trimmed), and the screenshots' filenames into `docs/validation/semantic-map-2026-11-03.md`. Mark anything not reproducible as unverified — a record of a run that did not happen is worse than a gap.

- [ ] **Step 2: Update the changelog with measured numbers**

Replace the Task 10 `untested` bullets with the measured results, and keep anything still unmeasured in the untested list.

- [ ] **Step 3: Final gate and commit**

Run: `npm run check`
Expected: PASS.

```bash
git add CHANGELOG.md
git add -f docs/validation/semantic-map-2026-11-03.md
git commit -m "docs(semantic-map): record the real-vault acceptance"
```

---

## Plan self-review

- **Spec coverage:** D1 → Tasks 7/9 (layout switch, one graph); D2 → Tasks 3/4/5 (one trace shape feeds both automatic capture and panel replay); D3 → Tasks 2/4/5 (memory ring, no writes); D4 → Task 1 (deterministic PCA + cache in Task 4); D5 → Tasks 6/8 (minimal painter, card); D6 → Tasks 4/5 (read-only route actions, no `warm()`/`sync()`); D7 → Tasks 1/4/8 (`explained`, `count`/`total`, honest states). §4.8 fallback matrix → `cardView` states in Task 8 plus Task 4 unavailable reasons. §4.9 budgets → Task 10. §5 test matrix → Tasks 1–9 tests plus Task 10 gates. §6 acceptance → Task 11. §7 risks → covered by cache identity (Task 4), static-mode flags (Task 6), token-only CSS (Task 9), non-enumerability (Task 3).
- **Placeholder scan:** no TBD/TODO, no "similar to Task N", no deferred fragments; the Task 8 module code is complete as written, and every referenced signature is defined in an earlier task or in that task's Interfaces block.
- **Type consistency:** `hybridTrace` fields produced in Task 3 match those consumed by `recordFromHits` (Task 2) and `traceView`; `points` are `[path, x, y]` integers from Task 4 and decoded by `decodeMapPoints` in Task 8; `setLayout({mode, points})` in Task 6 matches the `layout` object built in Task 9; `setOverlay(painter)` matches the painter adapter in Task 9.
