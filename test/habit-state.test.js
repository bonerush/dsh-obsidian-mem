// Task 2: the idempotent decay and the status transition.
//
// The decay shape is taken from limbic's `trust.py:apply_decay`, including the bug
// its docstring records. Anchoring only on "last reinforced" re-billed the whole
// elapsed interval on every pass: the same 27 days were charged about five times,
// driving a healthy 0.69 to 0.036 — 10x the correct decay. The fix is that the
// anchor is the LATEST of last-reinforced, created and last-decayed, so a second
// call at the same instant finds the anchor already advanced and charges zero.
//
// That property is what makes running the pass on every session start safe, and it
// is the one thing here that must never regress, so it is the first test.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  ARCHIVE_BELOW,
  DEMOTE_BELOW,
  HALF_LIFE_DAYS,
  decayScore,
  nextStatus,
} from '../lib/habit-state.js'

const DAY = 86_400_000
const at = (days) => new Date(Date.UTC(2026, 0, 1) + days * DAY)

test('the decay constants are the measured ones', () => {
  // 30 days is limbic's default, which cites Microsoft's "decay half-life ~29 days
  // optimal for production". 0.15 is CAPTURE's retention floor phi, which its
  // quarantine reaches after 14 days at 0.135/day. Neither is invented here.
  assert.equal(HALF_LIFE_DAYS, 30)
  assert.equal(DEMOTE_BELOW, 0.5)
  assert.equal(ARCHIVE_BELOW, 0.15)
})

test('decay is idempotent: a second pass at the same instant charges nothing', () => {
  // The limbic 10x bug, as a regression test. Run the pass five times over one
  // real interval and the score must equal the result of running it once.
  const base = { score: 1, createdAt: at(0), lastReinforcedAt: at(0) }
  const once = decayScore({ ...base, lastDecayedAt: null, today: at(30) })
  assert.ok(Math.abs(once - 0.5) < 1e-9, `one half-life halves the score, got ${once}`)
  let score = once
  for (let pass = 0; pass < 5; pass += 1) {
    score = decayScore({
      score,
      createdAt: at(0),
      lastReinforcedAt: at(0),
      lastDecayedAt: at(30),
      today: at(30),
    })
  }
  assert.ok(Math.abs(score - once) < 1e-9, `five passes charged nothing extra, got ${score}`)
})

test('the anchor is the latest of reinforced, created and last-decayed', () => {
  // Created long ago, but reinforced yesterday: the clock runs from yesterday.
  const reinforced = decayScore({
    score: 1,
    createdAt: at(0),
    lastReinforcedAt: at(99),
    lastDecayedAt: null,
    today: at(100),
  })
  assert.ok(reinforced > 0.97, `one day after reinforcement barely decays, got ${reinforced}`)
  // Never reinforced: the clock runs from creation.
  const orphan = decayScore({
    score: 1,
    createdAt: at(0),
    lastReinforcedAt: null,
    lastDecayedAt: null,
    today: at(30),
  })
  assert.ok(Math.abs(orphan - 0.5) < 1e-9, `an orphan decays from creation, got ${orphan}`)
  // A previous pass is the newest of the three, so it wins.
  const afterPass = decayScore({
    score: 0.5,
    createdAt: at(0),
    lastReinforcedAt: at(0),
    lastDecayedAt: at(29),
    today: at(30),
  })
  assert.ok(afterPass > 0.48, `one day since the last pass, got ${afterPass}`)
})

test('a malformed or missing date fails open', () => {
  // mem0's rule for its expiration predicate: "A bad date never makes a memory
  // silently vanish." A date this code cannot read charges no decay, and the
  // caller records a diagnostic instead of guessing.
  for (const bad of ['not-a-date', '', 42, {}, null, undefined]) {
    const score = decayScore({
      score: 0.8,
      createdAt: bad,
      lastReinforcedAt: bad,
      lastDecayedAt: bad,
      today: at(400),
    })
    assert.equal(score, 0.8, `fails open for ${JSON.stringify(bad)}`)
  }
})

test('a half-life of zero or less disables decay rather than dividing by it', () => {
  // limbic keeps half-life 0 as a documented kill switch, and a file that persists
  // 0 must keep it. The guard is here so the arithmetic cannot divide by zero.
  for (const halfLife of [0, -1, Number.NaN]) {
    const score = decayScore({
      score: 0.9,
      createdAt: at(0),
      lastReinforcedAt: at(0),
      lastDecayedAt: null,
      today: at(3650),
      halfLifeDays: halfLife,
    })
    assert.equal(score, 0.9, `no decay for half-life ${halfLife}`)
  }
})

test('a clock that moved backwards never increases a score', () => {
  const score = decayScore({
    score: 0.5,
    createdAt: at(0),
    lastReinforcedAt: at(10),
    lastDecayedAt: null,
    today: at(5),
  })
  assert.equal(score, 0.5, 'a negative interval is charged nothing, not compounded')
})

test('status transitions are deterministic and never delete', () => {
  const active = { status: 'active', assertion: 'observed' }
  assert.equal(
    nextStatus({ ...active, score: DEMOTE_BELOW - 0.01 }),
    'provisional',
    'an active habit below the demote line leaves the injection',
  )
  assert.equal(
    nextStatus({ ...active, score: DEMOTE_BELOW }),
    'active',
    'the line itself is not below it',
  )
  assert.equal(
    nextStatus({ status: 'provisional', assertion: 'observed', score: ARCHIVE_BELOW - 0.01 }),
    'archived',
    'a provisional habit below the floor is archived',
  )
  assert.equal(
    nextStatus({ status: 'archived', assertion: 'observed', score: 0 }),
    'archived',
    'archived is terminal: further decay changes nothing',
  )
})

test('a habit the user stated is never demoted by time', () => {
  // The evidence for a stated habit is "the user said so". That the user has not
  // repeated it lately is not counter-evidence, so no score moves it.
  for (const score of [0, 0.1, 0.49, 1]) {
    assert.equal(
      nextStatus({ status: 'active', assertion: 'stated', score }),
      'active',
      `stated stays active at score ${score}`,
    )
  }
})

test('an unknown status is left alone rather than guessed at', () => {
  assert.equal(nextStatus({ status: 'contested', assertion: 'observed', score: 0 }), 'contested')
  assert.equal(nextStatus({ status: 'superseded', assertion: 'observed', score: 0 }), 'superseded')
})
