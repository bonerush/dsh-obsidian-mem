// Task 3: the counting policy — when does an observation become a candidate?
//
// This module is PURE: it folds observations into state and returns the decisions
// that follow. It writes no note and touches no vault. The composition with the
// real writer happens in `capture` (L6), which already owns `applyCandidate` —
// the same split `failure-memory` (L1) and `distill` (L2) use, and the reason this
// can sit below `memory` (L5) without importing it.
//
// The unit of counting is the SESSION, not the turn. The calibration measured a
// median of two usable turns per session, so counting turns would let one
// conversation that repeats a phrase charge the same habit several times.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  PROMOTE_AFTER,
  foldObservations,
  labelsFromTurnEvents,
  recordPromotion,
} from '../lib/habit-learning.js'

const DAY = '2026-10-11'

test('the default threshold is the calibrated one', () => {
  // The calibration produced 6 candidates at >=3 sessions and 2 at >=9. The
  // threshold is deliberately the lower one: precision is bought by the quarantine
  // state (a candidate is written but not injected), not by a high bar, which is
  // exactly what CAPTURE's quarantine design intends.
  assert.equal(PROMOTE_AFTER, 3)
})

test('a label seen in one session is counted but not promoted', () => {
  const { state, promotions } = foldObservations(emptyState(), {
    labels: ['提交'],
    sessionId: 's1',
    today: DAY,
  })
  assert.deepEqual(promotions, [])
  assert.equal(state.records.提交.sessions, 1)
})

test('repeating a label inside one session counts once', () => {
  // The median session has two usable turns. Without this rule, one conversation
  // that says "记得提交" twice would look like two sessions of evidence.
  let result = foldObservations(emptyState(), { labels: ['提交'], sessionId: 's1', today: DAY })
  result = foldObservations(result.state, { labels: ['提交'], sessionId: 's1', today: DAY })
  result = foldObservations(result.state, { labels: ['提交'], sessionId: 's1', today: DAY })
  assert.equal(result.state.records.提交.sessions, 1, 'still one session')
  assert.deepEqual(result.promotions, [], 'and still below the bar')
})

test('three distinct sessions promote, and the promotion names its note', () => {
  let state = emptyState()
  const promotions = []
  for (const sessionId of ['s1', 's2', 's3']) {
    const result = foldObservations(state, { labels: ['提交'], sessionId, today: DAY })
    state = result.state
    promotions.push(...result.promotions)
  }
  assert.equal(promotions.length, 1, 'exactly one promotion at the bar')
  const [promotion] = promotions
  assert.equal(promotion.label, '提交')
  assert.equal(promotion.sessions, 3)
  // The note is a candidate, not a rule: observed (not stated) and provisional
  // (not active), which is what keeps it out of the injected brief.
  assert.equal(promotion.assertion, 'observed')
  assert.equal(promotion.status, 'provisional')
  assert.ok(promotion.title.startsWith('习惯：'), `title carries the prefix: ${promotion.title}`)
  assert.ok(promotion.tags.includes('user-habit'), 'carries the plugin-owned tag')
})

test('a label is promoted only once', () => {
  let state = emptyState()
  const promotions = []
  for (const sessionId of ['s1', 's2', 's3', 's4', 's5']) {
    const result = foldObservations(state, { labels: ['提交'], sessionId, today: DAY })
    state = result.state
    promotions.push(...result.promotions)
  }
  assert.equal(promotions.length, 1, 'sessions four and five add no second note')
  assert.equal(state.records.提交.sessions, 5, 'but they do keep counting')
})

test('re-observing a promoted label refreshes the clock without a new note', () => {
  // The fold does not invent a note id: the writer creates the note and hands the
  // identity back through `recordPromotion`, because only the writer knows it.
  // This is the two-step flow the capture path actually runs.
  let state = emptyState()
  for (const sessionId of ['s1', 's2', 's3']) {
    const result = foldObservations(state, { labels: ['提交'], sessionId, today: '2026-10-01' })
    state = result.state
    for (const promotion of result.promotions) {
      state = recordPromotion(state, promotion.label, 'con-abc')
    }
  }
  assert.equal(state.records.提交.noteId, 'con-abc', 'the promotion recorded an identity')
  const later = foldObservations(state, { labels: ['提交'], sessionId: 's9', today: '2026-11-01' })
  assert.deepEqual(later.promotions, [], 'no second note')
  assert.equal(later.state.records.提交.lastReinforcedAt, '2026-11-01', 'the clock moved')
  assert.equal(later.state.records.提交.score, 1, 'and the score was restored')
})

test('nothing is promoted from an empty or unlabelled pass', () => {
  const empty = foldObservations(emptyState(), { labels: [], sessionId: 's1', today: DAY })
  assert.deepEqual(empty.promotions, [])
  assert.deepEqual(empty.state.records, {})
  // A message with no marker produces no label, so a session that says nothing
  // durable leaves no trace at all.
  const none = foldObservations(emptyState(), { labels: [], sessionId: 's1', today: DAY })
  assert.deepEqual(none.state.records, {})
})

test('a session with no id is refused rather than counted', () => {
  // Without an identity there is no way to tell a new session from the same one,
  // so counting would either double-count or never count. Neither is acceptable.
  for (const sessionId of [null, undefined, '', 42]) {
    const result = foldObservations(emptyState(), { labels: ['提交'], sessionId, today: DAY })
    assert.deepEqual(result.promotions, [], `no promotion for ${JSON.stringify(sessionId)}`)
    assert.deepEqual(result.state.records, {}, `no record for ${JSON.stringify(sessionId)}`)
  }
})

test('two labels in one session are counted separately', () => {
  const { state } = foldObservations(emptyState(), {
    labels: ['提交', 'superpowers'],
    sessionId: 's1',
    today: DAY,
  })
  assert.equal(state.records.提交.sessions, 1)
  assert.equal(state.records.superpowers.sessions, 1)
})

test('the state a pass produces is the state a later pass can read', () => {
  // The fold must be serializable: the caller writes it to JSON and reads it back
  // on the next session. A `Date` or a `Set` here would survive in memory and
  // vanish on disk.
  const { state } = foldObservations(emptyState(), {
    labels: ['提交'],
    sessionId: 's1',
    today: DAY,
  })
  const roundTripped = JSON.parse(JSON.stringify(state))
  assert.deepEqual(roundTripped, state)
})

test('a disabled pass changes nothing', () => {
  const { state, promotions } = foldObservations(emptyState(), {
    labels: ['提交'],
    sessionId: 's1',
    today: DAY,
    enabled: false,
  })
  assert.deepEqual(promotions, [])
  assert.deepEqual(state.records, {})
})

test('an unknown label is refused, so the state cannot be widened from outside', () => {
  // The vocabulary is closed. A label that is not in it cannot be stored, which is
  // what stops arbitrary text from reaching the state file through a caller bug.
  const { state } = foldObservations(emptyState(), {
    labels: ['not-in-the-vocabulary', '提交'],
    sessionId: 's1',
    today: DAY,
  })
  assert.deepEqual(Object.keys(state.records), ['提交'])
})

test('ATTRIBUTION: tool calls never produce a label, however many there are', () => {
  // Acceptance criterion 8, and the regression test for the mistake that
  // falsified the first version of this feature. That version counted tool calls
  // and 99.0% of what it counted (291 of 294) was the agent's own choice. A turn
  // can contain any number of tool calls and still say nothing about the user.
  const turn = [
    { type: 'tool/call', data: { name: 'bash', arguments: '{"command":"git commit -m x"}' } },
    { type: 'tool/call', data: { name: 'bash', arguments: '{"command":"npm test"}' } },
    { type: 'tool/result', data: { name: 'bash' } },
    { type: 'tool/ptc-dispatch', data: { name: 'skill' } },
  ]
  assert.deepEqual(labelsFromTurnEvents(turn), [], 'tool activity is not a preference')
  // The same turn plus one real user message yields exactly that message's label,
  // proving the empty result above is not an accident of the fixture.
  const withUser = [
    ...turn,
    {
      type: 'user/message',
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: '记得提交' }] },
    },
  ]
  assert.deepEqual(labelsFromTurnEvents(withUser), ['提交'])
})

test('ATTRIBUTION: injected context is not the user speaking', () => {
  // The calibration measured injected context OUTNUMBERING real user messages —
  // 48 plugin injections against 40 user messages — so a reader that accepted any
  // user/message would mostly be reading this plugin talking to itself. Every one
  // of these is committed by the host as a user/message.
  const injected = [
    'plugin:obsidian-mem',
    'agent-instructions',
    'runtime-context',
    'skill-catalog',
  ].map((kind) => ({
    type: 'user/message',
    data: { source: { kind }, content: [{ type: 'text', text: '记得提交 用中文 为什么' }] },
  }))
  assert.deepEqual(labelsFromTurnEvents(injected), [], 'injected context states no preference')
})

test('ATTRIBUTION: a turn with no user message at all yields nothing', () => {
  assert.deepEqual(labelsFromTurnEvents([]), [])
  assert.deepEqual(labelsFromTurnEvents(null), [])
  assert.deepEqual(labelsFromTurnEvents([{ type: 'turn/end', data: { turn: 1 } }]), [])
})

test('labels from several user messages in one turn are merged and deduped', () => {
  const turn = [
    {
      type: 'user/message',
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: '记得提交' }] },
    },
    {
      type: 'user/message',
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: '提交并且用中文' }] },
    },
  ]
  assert.deepEqual(labelsFromTurnEvents(turn).sort(), ['中文回答', '提交'])
})

/** An empty state in the shape `readHabitState` returns. */
function emptyState() {
  return { schema: 1, records: {} }
}
