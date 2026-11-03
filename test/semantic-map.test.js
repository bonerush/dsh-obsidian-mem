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
  assert.deepEqual(nearestNeighbors(vectors, 'missing.md'), [])
})
