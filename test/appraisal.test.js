import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  APPRAISAL_CODES,
  APPRAISAL_SEVERITIES,
  UNVERIFIED_CONFIDENCE,
  appraiseNotes,
  linkTargets,
  titleKey,
} from '../lib/appraisal.js'

const TODAY = '2026-10-26'
const note = (over = {}) => ({
  path: 'Projects/demo--1c392abb/Conventions/a.md',
  title: 'same title',
  type: 'convention',
  status: 'active',
  data: { type: 'convention', status: 'active', assertion: 'stated', confidence: 0.9 },
  body: 'plain body',
  updated: '2026-10-20',
  ...over,
})

test('the vocabulary is closed and every code has a severity', () => {
  assert.deepEqual([...APPRAISAL_CODES].sort(), Object.keys(APPRAISAL_SEVERITIES).sort())
  assert.equal(APPRAISAL_SEVERITIES['review-overdue'], 'error')
  assert.equal(APPRAISAL_SEVERITIES['duplicate-title'], 'warn')
  assert.equal(APPRAISAL_SEVERITIES.contested, 'info')
})

test('a past review_after is an error, a future one is not', () => {
  const past = appraiseNotes([note({ data: { ...note().data, review_after: '2026-10-01' } })], {
    today: TODAY,
  })
  assert.deepEqual(
    past.findings.map((f) => f.code),
    ['review-overdue'],
  )
  const future = appraiseNotes([note({ data: { ...note().data, review_after: '2026-11-01' } })], {
    today: TODAY,
  })
  assert.deepEqual(future.findings, [])
})

test('missing assertion or low confidence is unverified; high confidence is not', () => {
  const missing = appraiseNotes(
    [note({ data: { type: 'convention', status: 'active', confidence: 0.9 } })],
    { today: TODAY },
  )
  assert.deepEqual(
    missing.findings.map((f) => f.code),
    ['unverified'],
  )
  const low = appraiseNotes([note({ data: { ...note().data, confidence: 0.2 } })], { today: TODAY })
  assert.deepEqual(
    low.findings.map((f) => f.code),
    ['unverified'],
  )
  assert.equal(UNVERIFIED_CONFIDENCE, 0.5)
})

test('exact title groups are one finding, and different types do not group', () => {
  const rows = [
    note({ path: 'a.md', title: 'Same  Title' }),
    note({ path: 'b.md', title: 'same title' }),
    note({
      path: 'c.md',
      title: 'same title',
      type: 'decision',
      data: { type: 'decision', status: 'active', assertion: 'stated', confidence: 0.9 },
    }),
  ]
  const out = appraiseNotes(rows, { today: TODAY })
  const duplicates = out.findings.filter((f) => f.code === 'duplicate-title')
  assert.equal(duplicates.length, 1)
  assert.match(duplicates[0].detail, /2 notes share this title/)
  assert.equal(titleKey(' Same  Title '), 'same title')
})

test('dead links use the injected resolver and ignore external targets', () => {
  const rows = [
    note({ path: 'a.md', body: 'see [[Conventions/missing|alias]] and https://example.com' }),
    note({ path: 'b.md', body: 'see [[Conventions/alive]]' }),
  ]
  const out = appraiseNotes(rows, {
    today: TODAY,
    resolves: (target) => target === 'Conventions/alive',
  })
  const dead = out.findings.filter((f) => f.code === 'dead-link')
  assert.equal(dead.length, 1)
  assert.equal(dead[0].path, 'a.md')
  assert.deepEqual(linkTargets('[[a/b#h|x]] [[https://x]]'), ['a/b'])
})

test('contested is info, and the findings sort severity then path', () => {
  const rows = [
    note({
      path: 'z.md',
      title: 'z',
      status: 'contested',
      data: { ...note().data, review_after: '2026-01-01' },
    }),
    note({ path: 'a.md', title: 'a', data: { ...note().data, review_after: '2026-01-01' } }),
  ]
  const out = appraiseNotes(rows, { today: TODAY })
  assert.deepEqual(
    out.findings.map((f) => f.code),
    ['review-overdue', 'review-overdue', 'contested'],
  )
  assert.deepEqual(
    out.findings.map((f) => f.path),
    ['a.md', 'z.md', 'z.md'],
  )
})

test('the note and time bounds are honest about truncation', () => {
  const rows = Array.from({ length: 10 }, (_, i) => note({ path: 'n' + i + '.md', title: 't' + i }))
  const byNotes = appraiseNotes(rows, { today: TODAY, maxNotes: 3 })
  assert.equal(byNotes.scanned, 3)
  assert.equal(byNotes.truncated, true)
  let ticks = 0
  const byTime = appraiseNotes(rows, { today: TODAY, maxMs: 2, now: () => ticks++ })
  assert.equal(byTime.scanned, 2)
  assert.equal(byTime.truncated, true)
})

test('the finding bound keeps the total real and rejects bad inputs', () => {
  const rows = Array.from({ length: 5 }, (_, i) =>
    note({
      path: 'n' + i + '.md',
      title: 'n' + i,
      data: { ...note().data, review_after: '2026-01-01' },
    }),
  )
  const out = appraiseNotes(rows, { today: TODAY, maxFindings: 2 })
  assert.equal(out.findings.length, 2)
  assert.equal(out.total, 5)
  assert.equal(out.truncated, true)
  assert.throws(() => appraiseNotes(null), RangeError)
  assert.throws(() => appraiseNotes([], { maxNotes: 0 }), RangeError)
  assert.throws(() => appraiseNotes([], { today: 'nope' }), RangeError)
  assert.throws(() => appraiseNotes([], { resolves: 1 }), RangeError)
})
