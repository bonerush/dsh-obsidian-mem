// Spec §1: the pure half of hot delivery receipts.
//
// These are the decisions that need no filesystem and no host: what a rendered hot
// unit is, how its version is hashed, which unit is too large to inject at all,
// which units a composed brief actually emitted, which version of a previously
// delivered unit a notice may withdraw, and the bounded continuation cursor. The
// persistence half (receipts, locks, epochs) is test/delivery-state.test.js.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  HOT_CURSOR_MAX_CHARS,
  HOT_CURSOR_PREFIX,
  MAX_AUTO_CONTINUATIONS,
  continuationFor,
  emittedHotUnits,
  hotCursorFor,
  hotUnitCost,
  hotUnitVersion,
  packContinuation,
  parseHotCursor,
  prepareHotUnits,
  removedHotUnits,
  renderHotUnit,
  splitOversizedHotUnits,
} from '../lib/hot-delivery.js'

const item = (id, section, text, source = null) => ({ id, section, text, source })
const CONSTRAINTS = '强约束'
const ACTIVE = '进行中'

/** The coverage shape composeBrief returns, narrowed to the two hot sections. */
function coverageOf({ constraints = 0, active = 0, delta = 0 } = {}) {
  return {
    sections: [
      { key: 'identity', shown: 2, considered: 2, omitted: 0 },
      { key: 'hot-constraints', shown: constraints, considered: constraints, omitted: 0 },
      { key: 'hot-active', shown: active, considered: active, omitted: 0 },
      { key: 'delta', shown: delta, considered: delta, omitted: 0 },
    ],
  }
}

// ---------------------------------------------------------------------------
// The injectable unit and its version
// ---------------------------------------------------------------------------

test('a rendered hot unit is the line the brief injects, with the stable id and source', () => {
  assert.equal(
    renderHotUnit(item('hot-1', ACTIVE, '实现 receipt', '[[Projects/x/进行中|x]]')),
    '- [hot-1] 实现 receipt — [[Projects/x/进行中|x]]',
  )
  assert.equal(renderHotUnit(item('hot-2', CONSTRAINTS, '只读默认')), '- [hot-2] 只读默认')
})

test('a version hashes the complete injectable unit including its zone', () => {
  const base = item('hot-1', ACTIVE, '同一句话')
  assert.match(hotUnitVersion(base), /^[0-9a-f]{64}$/)
  assert.equal(hotUnitVersion(base), hotUnitVersion({ ...base }))
  // The zone is part of the unit: moving an entry between 强约束 and 进行中 changes
  // what the model reads, so it is a different version even with identical text.
  assert.notEqual(hotUnitVersion(base), hotUnitVersion({ ...base, section: CONSTRAINTS }))
  // So does a source link and any edit of the fact.
  assert.notEqual(hotUnitVersion(base), hotUnitVersion({ ...base, source: '[[y]]' }))
  assert.notEqual(hotUnitVersion(base), hotUnitVersion({ ...base, text: '同一句话。' }))
  // The id is identity, not content: an id edited in place is a new unit by the
  // file writer, and the version has to follow the bytes the brief injects.
  assert.notEqual(hotUnitVersion(base), hotUnitVersion({ ...base, id: 'hot-2' }))
})

test('unit cost is measured in code points, like the brief budget', () => {
  const unit = item('hot-1', ACTIVE, '中文🙂')
  assert.equal(hotUnitCost(unit), [...renderHotUnit(unit)].length)
})

// ---------------------------------------------------------------------------
// Oversized units: skip and continue
// ---------------------------------------------------------------------------

test('an oversized unit is skipped and later units still fit', () => {
  const units = prepareHotUnits([
    item('hot-giant', CONSTRAINTS, 'x'.repeat(900)),
    item('hot-small', CONSTRAINTS, '小约束'),
    item('hot-active', ACTIVE, '进行中的事'),
  ])
  const { injectable, oversized } = splitOversizedHotUnits(units, {
    budget: 600,
    reserveChars: 200,
  })
  assert.deepEqual(idsOf(injectable), ['hot-small', 'hot-active'])
  assert.deepEqual(idsOf(oversized), ['hot-giant'])
  // An oversized unit is reported with its source route, never clipped into a
  // half fact: the id and the source path are what a reader can act on.
  assert.equal(oversized[0].id, 'hot-giant')
  assert.equal(oversized[0].chars, [...renderHotUnit(units[0])].length)
  assert.equal(oversized[0].version, hotUnitVersion(units[0]))
})

test('a unit that fits alone is not oversized, even when other units would not fit with it', () => {
  const units = prepareHotUnits([
    item('hot-a', CONSTRAINTS, 'a'.repeat(200)),
    item('hot-b', CONSTRAINTS, 'b'.repeat(200)),
  ])
  const { injectable, oversized } = splitOversizedHotUnits(units, {
    budget: 600,
    reserveChars: 250,
  })
  assert.deepEqual(idsOf(oversized), [])
  assert.deepEqual(idsOf(injectable), ['hot-a', 'hot-b'])
})

test('an oversized unit keeps the source link a page caller can follow', () => {
  const units = prepareHotUnits([
    item('hot-big', ACTIVE, 'y'.repeat(400), '[[Projects/x/进行中|记录]]'),
  ])
  const { oversized } = splitOversizedHotUnits(units, { budget: 300, reserveChars: 100 })
  assert.equal(oversized.length, 1)
  assert.equal(oversized[0].source, '[[Projects/x/进行中|记录]]')
})

// ---------------------------------------------------------------------------
// What the composed text actually emitted
// ---------------------------------------------------------------------------

test('full mode emits the prefix the budget admitted, in zone order', () => {
  const units = prepareHotUnits([
    item('hot-c1', CONSTRAINTS, '约束一'),
    item('hot-c2', CONSTRAINTS, '约束二'),
    item('hot-a1', ACTIVE, '进行一'),
    item('hot-a2', ACTIVE, '进行二'),
  ])
  const { emitted, units: all } = emittedHotUnits({
    mode: 'full',
    injectable: units,
    coverage: coverageOf({ constraints: 1, active: 1 }),
  })
  assert.deepEqual(idsOf(emitted), ['hot-c1', 'hot-a1'])
  assert.equal(all.length, 2)
  assert.equal(emitted[0].version, hotUnitVersion(units[0]))
})

test('a section cut before any of its units emits none of them', () => {
  const units = prepareHotUnits([
    item('hot-c1', CONSTRAINTS, '约束一'),
    item('hot-a1', ACTIVE, '进行一'),
  ])
  const { emitted } = emittedHotUnits({
    mode: 'full',
    injectable: units,
    coverage: coverageOf({ constraints: 1, active: 0 }),
  })
  assert.deepEqual(idsOf(emitted), ['hot-c1'])
})

test('delta mode emits the changed prefix, not the full layer prefix', () => {
  const changed = prepareHotUnits([
    item('hot-a2', ACTIVE, '改过的进行二'),
    item('hot-a3', ACTIVE, '新增的进行三'),
  ])
  const { emitted } = emittedHotUnits({
    mode: 'delta',
    changed,
    coverage: coverageOf({ delta: 1 }),
  })
  assert.deepEqual(idsOf(emitted), ['hot-a2'])
})

// ---------------------------------------------------------------------------
// Removals withdraw only what was delivered, and only its own version
// ---------------------------------------------------------------------------

test('a removal names a previously delivered id absent from the current injectable set', () => {
  const removed = removedHotUnits({
    currentIds: new Set(['hot-keep']),
    acked: new Map([
      ['hot-keep', 'v1'],
      ['hot-gone', 'v2'],
    ]),
  })
  assert.deepEqual(removed, [{ id: 'hot-gone', previousVersion: 'v2' }])
})

test('a unit never acknowledged is never reported as removed', () => {
  const removed = removedHotUnits({ currentIds: new Set(), acked: new Map() })
  assert.deepEqual(removed, [])
})

test('the removal carries the delivered version so a stale notice cannot erase a newer one', () => {
  const removed = removedHotUnits({
    currentIds: new Set(),
    acked: new Map([['hot-gone', 'version-at-delivery']]),
  })
  assert.equal(removed[0].previousVersion, 'version-at-delivery')
})

// ---------------------------------------------------------------------------
// The bounded continuation cursor
// ---------------------------------------------------------------------------

test('a cursor round-trips project, source hash and next position and stays under 256 characters', () => {
  const projectId = '1c392abb-7b08-42f7-871d-2a379caf9448'
  const sourceHash = 'a'.repeat(64)
  const cursor = hotCursorFor({ projectId, sourceHash, offset: 17 })
  assert.ok(cursor.startsWith(HOT_CURSOR_PREFIX))
  assert.ok(cursor.length <= HOT_CURSOR_MAX_CHARS)
  assert.deepEqual(parseHotCursor(cursor), { projectId, sourceHash, offset: 17 })
})

test('a changed source is a stale continuation, not a silent jump', () => {
  const cursor = hotCursorFor({ projectId: 'p', sourceHash: 'b'.repeat(64), offset: 3 })
  const parsed = parseHotCursor(cursor)
  assert.notEqual(parsed.sourceHash, 'c'.repeat(64))
})

test('a malformed or foreign cursor is refused with a machine-readable code', () => {
  for (const bad of ['', 'hd1', 'hd0:p:h:1', 'hd1:p:short:1', 'hd1:p:' + 'a'.repeat(64) + ':-1']) {
    assert.throws(
      () => parseHotCursor(bad),
      (error) => error instanceof RangeError && error.code === 'invalid-cursor',
      bad,
    )
  }
})

test('a cursor offset is bounded like a page offset', () => {
  assert.throws(
    () =>
      parseHotCursor(hotCursorFor({ projectId: 'p', sourceHash: 'a'.repeat(64), offset: 10001 })),
    (error) => error.code === 'invalid-cursor',
  )
})

// ---------------------------------------------------------------------------
// At most two automatic continuations per unchanged generation
// ---------------------------------------------------------------------------

test('the first brief may leave a continuation: the next untouched window', () => {
  const plan = continuationFor({ candidates: 12, offset: 5, attempts: 0, turn: 1, lastTurn: null })
  assert.equal(plan.available, true)
  assert.equal(plan.offset, 5)
  assert.equal(plan.remaining, 7)
  assert.equal(plan.retry, false)
})

test('two acknowledged continuations exhaust the automatic allowance', () => {
  const plan = continuationFor({
    candidates: 30,
    offset: 15,
    attempts: MAX_AUTO_CONTINUATIONS,
    turn: 3,
    lastTurn: 2,
  })
  assert.equal(plan.available, false)
  assert.equal(plan.remaining, 15)
})

test('a continuation never fires twice in one user turn', () => {
  const plan = continuationFor({ candidates: 20, offset: 5, attempts: 0, turn: 4, lastTurn: 4 })
  assert.equal(plan.available, false)
  assert.equal(plan.reason, 'same-turn')
})

test('an unacknowledged continuation is retried next turn instead of spending a new one', () => {
  const plan = continuationFor({
    candidates: 20,
    offset: 5,
    attempts: 1,
    turn: 5,
    lastTurn: 4,
  })
  assert.equal(plan.available, true)
  assert.equal(plan.retry, true, 'the same window is re-prepared; the allowance is not spent twice')
})

test('nothing remains when the emitted prefix reached the candidate list', () => {
  const plan = continuationFor({ candidates: 4, offset: 4, attempts: 0, turn: 2, lastTurn: 1 })
  assert.equal(plan.available, false)
  assert.equal(plan.remaining, 0)
})

// ---------------------------------------------------------------------------
// Packing a continuation window
// ---------------------------------------------------------------------------

test('a continuation window is whole units only and never crosses its budget', () => {
  const units = prepareHotUnits([
    item('hot-1', ACTIVE, '一'),
    item('hot-2', ACTIVE, '二'),
    item('hot-3', ACTIVE, '三'),
  ])
  const packed = packContinuation({ units, offset: 0, budget: 90, overheadChars: 60 })
  assert.ok(packed.units.length >= 1)
  assert.ok(packed.units.length < 3)
  assert.equal(packed.nextOffset, packed.units.length)
  assert.ok(packed.charCount <= 90)
  for (const unit of packed.units) {
    assert.equal(unit.line, renderHotUnit(unit))
  }
})

test('a continuation window that cannot fit its first unit stops instead of clipping it', () => {
  const units = prepareHotUnits([item('hot-giant', ACTIVE, 'z'.repeat(500))])
  const packed = packContinuation({ units, offset: 0, budget: 120, overheadChars: 60 })
  assert.deepEqual(packed.units, [])
  assert.equal(packed.nextOffset, 0)
})

test('offset past the end packs nothing', () => {
  const units = prepareHotUnits([item('hot-1', ACTIVE, '一')])
  const packed = packContinuation({ units, offset: 5, budget: 600, overheadChars: 100 })
  assert.deepEqual(packed.units, [])
  assert.equal(packed.nextOffset, 5)
})

/** Ids of normalized or emitted units, for the assertions above. */
function idsOf(list) {
  return list.map((entry) => entry.id)
}
