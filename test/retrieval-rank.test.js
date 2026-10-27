// Task 3 (v0.4) — deterministic sparse retrieval baseline.
//
// Phase A: the ranker is a pure function over a caller-supplied bounded list of
// source-verified records. The tests pin the properties the design promises —
// lexical-equivalent ordering through TF-IDF/cosine, the repo's CJK bigram +
// Latin tokenisation, RRF with k=60, and a deterministic order under shuffling —
// without touching the index, the vault or the network.
//
// The fixture deliberately uses small hand-computable corpora: a ranking test
// that only asserts "the obvious hit is first" would not notice an IDF or a
// tie-break bug.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  RRF_K,
  SPARSE_MAX_CHUNK_CHARS,
  SPARSE_MAX_RECORDS,
  rankSparse,
  reciprocalRankFusion,
} from '../lib/retrieval-rank.js'

const record = (key, text, extra = {}) => ({ key, text, ...extra })
const keys = (results) => results.map((result) => result.key)
const close = (actual, expected, epsilon = 1e-12) =>
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `${actual} is not within ${epsilon} of ${expected}`,
  )

test('the RRF constant is 60', () => {
  assert.equal(RRF_K, 60)
})

test('rankSparse orders by TF-IDF cosine, not by shared-term count', () => {
  // Hand-computed IDF: df(alpha)=3, df(beta)=2 in a four-record corpus
  // (ln((N+1)/(df+1))+1). d has beta twice, so its cosine beats a even though
  // both share the same two query terms — the assertion that would miss a
  // ranking bug is "alpha first", so the expected order is spelled out.
  const results = rankSparse({
    query: 'alpha beta',
    records: [
      record('a', 'alpha beta gamma'),
      record('b', 'alpha only'),
      record('c', 'unrelated words'),
      record('d', 'alpha beta beta'),
    ],
  })
  assert.deepEqual(keys(results), ['d', 'a', 'b'])
  assert.ok(results[0].score > results[1].score)
  assert.ok(results[1].score > results[2].score)
  assert.ok(results.every((result) => result.score > 0))
})

test('rankSparse is deterministic under shuffling and breaks exact ties by key', () => {
  const records = [
    record('tie-b', 'alpha'),
    record('tie-a', 'alpha'),
    record('other', 'beta'),
    record('also', 'alpha'),
  ]
  const first = rankSparse({ query: 'alpha', records })
  const reversed = rankSparse({ query: 'alpha', records: [...records].reverse() })
  assert.deepEqual(keys(first), ['also', 'tie-a', 'tie-b'])
  assert.deepEqual(keys(first), keys(reversed))
  // Three identical scores: the stable key decides, not the input order.
  assert.deepEqual(keys(first).slice(1), ['tie-a', 'tie-b'])
})

test('an exact title or alias wins a score tie, before the key fallback', () => {
  // Identical text means identical cosine; only the explicit exact-title rule
  // can put 'zeta' ahead of 'alpha'.
  const results = rankSparse({
    query: '调度器',
    records: [
      record('alpha', '调度器改为可插拔后端', { title: '别的标题' }),
      record('zeta', '调度器改为可插拔后端', { title: '调度器' }),
      record('alias', '调度器改为可插拔后端', { aliases: ['调度器'] }),
    ],
  })
  assert.deepEqual(keys(results).slice(0, 2).sort(), ['alias', 'zeta'])
  assert.equal(keys(results)[2], 'alpha')
})

test('CJK runs become the repo bigrams and Latin words are case-folded', () => {
  const cjk = rankSparse({
    query: '可插拔调度',
    records: [
      record('cjk', '调度器改为可插拔后端'),
      record('latin', 'pluggable scheduler backend'),
      record('none', '无关的另一个主题'),
    ],
  })
  assert.deepEqual(keys(cjk), ['cjk'])
  assert.deepEqual(cjk[0].tokens, ['可插', '插拔', '拔调', '调度'])

  const latin = rankSparse({
    query: 'PLUGGABLE',
    records: [record('lower', 'pluggable backend'), record('none', 'something else')],
  })
  assert.deepEqual(keys(latin), ['lower'])
  assert.deepEqual(latin[0].tokens, ['pluggable'])
})

test('a query with no repo token (a lone CJK character) yields no sparse candidate', () => {
  const results = rankSparse({
    query: '调',
    records: [record('a', '调度器'), record('b', 'other')],
  })
  assert.deepEqual(results, [])
})

test('reciprocalRankFusion uses k=60 and is deterministic on ties', () => {
  const fused = reciprocalRankFusion([
    ['a', 'b', 'c'],
    ['b', 'c', 'a'],
  ])
  // a: 1/61 + 1/63, b: 1/62 + 1/61, c: 1/63 + 1/62
  close(fused.find((item) => item.key === 'a').score, 1 / 61 + 1 / 63)
  close(fused.find((item) => item.key === 'b').score, 1 / 62 + 1 / 61)
  close(fused.find((item) => item.key === 'c').score, 1 / 63 + 1 / 62)
  assert.deepEqual(keys(fused), ['b', 'a', 'c'])
  assert.deepEqual(fused.find((item) => item.key === 'a').ranks, [1, 3])

  // A perfect tie between two lists' single members is broken by the key, not
  // by which list came first.
  assert.deepEqual(keys(reciprocalRankFusion([['y'], ['x']])), ['x', 'y'])
})

test('rankSparse enforces the caller-bound contract instead of guessing', () => {
  const records = [record('a', 'alpha')]
  assert.throws(() => rankSparse({ query: '', records }), RangeError)
  assert.throws(() => rankSparse({ query: 'alpha', records: 'nope' }), RangeError)
  assert.throws(() => rankSparse({ query: 'alpha', records: [{ text: 'alpha' }] }), RangeError)
  assert.throws(() => rankSparse({ query: 'alpha', records: [record('a', '')] }), RangeError)
  assert.throws(
    () => rankSparse({ query: 'alpha', records: [record('a', 'alpha'), record('a', 'alpha')] }),
    RangeError,
  )
  assert.throws(
    () =>
      rankSparse({
        query: 'alpha',
        records: [record('big', 'x'.repeat(SPARSE_MAX_CHUNK_CHARS + 1))],
      }),
    RangeError,
  )
  assert.throws(
    () =>
      rankSparse({
        query: 'alpha',
        records: Array.from({ length: SPARSE_MAX_RECORDS + 1 }, (_, index) =>
          record(`r${index}`, 'alpha'),
        ),
      }),
    RangeError,
  )
  assert.throws(() => rankSparse({ query: 'alpha', records, limit: 0 }), RangeError)
})
