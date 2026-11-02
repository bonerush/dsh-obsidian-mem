import assert from 'node:assert/strict'
import test from 'node:test'

import {
  LEXICAL_GUARD_TOKEN_HITS,
  cosineTopK,
  hybridSearch,
  shouldKeepLexical,
  weightedRrf,
} from '../lib/hybrid-search.js'

/** A lexical hit shaped like searchNotes output, reduced to what the guard reads. */
function hit(path, signals = {}) {
  return { path, title: path, type: 'doc', status: 'active', signals }
}

test('the lexical guard fires on a literal anchor and on enough token hits', () => {
  assert.equal(LEXICAL_GUARD_TOKEN_HITS, 8)
  assert.equal(shouldKeepLexical([hit('a.md', { titleExact: true })]), true)
  assert.equal(shouldKeepLexical([hit('a.md', { titleContains: true })]), true)
  assert.equal(shouldKeepLexical([hit('a.md', { phraseContains: true })]), true)
  assert.equal(shouldKeepLexical([hit('a.md', { tokenHits: 8 })]), true)
  assert.equal(shouldKeepLexical([hit('a.md', { tokenHits: 7 })]), false)
  assert.equal(shouldKeepLexical([hit('a.md', {})]), false)
  assert.equal(shouldKeepLexical([]), false)
  assert.equal(shouldKeepLexical(null), false)
})

test('cosineTopK normalises defensively, breaks ties by path and honours the limit', () => {
  const vectors = new Map([
    ['b.md', [1, 0]],
    ['a.md', [2, 0]],
    ['c.md', [0, 1]],
    ['z.md', [0, 0]],
  ])
  const ranked = cosineTopK([1, 0], vectors, { limit: 3 })
  assert.deepEqual(
    ranked.map((entry) => entry.path),
    ['a.md', 'b.md', 'c.md'],
  )
  assert.equal(ranked[0].score, 1)
  assert.equal(ranked[1].score, 1)
  assert.equal(ranked[2].score, 0)
  const capped = cosineTopK([1, 0], vectors, { limit: 1 })
  assert.deepEqual(
    capped.map((entry) => entry.path),
    ['a.md'],
  )
})

test('an empty dense ranking returns the lexical order, guarded or not', () => {
  const lexicalTop = [hit('a.md'), hit('b.md'), hit('c.md')]
  const fused = hybridSearch({ lexicalTop, denseTop: [], limit: 2 })
  assert.deepEqual(
    fused.map((entry) => entry.path),
    ['a.md', 'b.md'],
  )
  assert.ok(fused.every((entry) => entry.source === 'lexical'))
})

test('a literal anchor keeps the lexical order even when a dense list exists', () => {
  const lexicalTop = [hit('a.md', { tokenHits: 10 }), hit('b.md')]
  const denseTop = [
    { path: 'c.md', score: 0.9 },
    { path: 'a.md', score: 0.8 },
  ]
  const fused = hybridSearch({ lexicalTop, denseTop, limit: 8 })
  assert.deepEqual(
    fused.map((entry) => entry.path),
    ['a.md', 'b.md'],
  )
})

test('weighted RRF ranks 1.0 lexical against 2.0 dense at k=60', () => {
  const lexicalTop = [hit('a.md'), hit('b.md')]
  const denseTop = [
    { path: 'c.md', score: 0.9 },
    { path: 'a.md', score: 0.8 },
  ]
  const fused = weightedRrf({ lexicalTop, denseTop })
  assert.deepEqual(
    fused.map((entry) => entry.path),
    ['a.md', 'c.md', 'b.md'],
  )
  assert.ok(Math.abs(fused[0].score - (1 / 61 + 2 / 62)) < 1e-12)
  assert.ok(Math.abs(fused[1].score - 2 / 61) < 1e-12)
  assert.ok(Math.abs(fused[2].score - 1 / 62) < 1e-12)
})

test('hybridSearch fuses the two rankings and marks where each entry came from', () => {
  const lexicalTop = [hit('a.md'), hit('b.md')]
  const denseTop = [
    { path: 'c.md', score: 0.9 },
    { path: 'a.md', score: 0.8 },
  ]
  const fused = hybridSearch({ lexicalTop, denseTop, limit: 2 })
  assert.deepEqual(
    fused.map((entry) => entry.path),
    ['a.md', 'c.md'],
  )
  assert.equal(fused[0].source, 'lexical')
  assert.equal(fused[0].lexicalHit, lexicalTop[0], 'the lexical hit travels with the entry')
  assert.equal(fused[0].semanticScore, 0.8)
  assert.equal(fused[1].source, 'dense')
  assert.equal(fused[1].lexicalHit, null)
  assert.equal(fused[1].semanticScore, 0.9)
  assert.equal(fused[1].hybridRank, 1)
})

test('the same path never appears twice in one ranking', () => {
  const lexicalTop = [hit('a.md'), hit('b.md')]
  const denseTop = [
    { path: 'b.md', score: 0.95 },
    { path: 'a.md', score: 0.7 },
  ]
  const fused = weightedRrf({ lexicalTop, denseTop })
  assert.equal(new Set(fused.map((entry) => entry.path)).size, fused.length)
})
