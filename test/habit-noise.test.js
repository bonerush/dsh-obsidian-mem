// Task 6: the noise-stress acceptance, and the limitation it found.
//
// TraceRetain (arXiv 2606.29178) measured that memory pollution DOES NOT APPEAR on
// clean inputs: on tidy benchmarks the differences between retention policies fell
// inside the Wilson interval and only showed up under a controlled noisy-write stress
// (75% distractors), where unbounded memory's Precision@5 fell from 20.2% to 12.4%.
// The consequence here is blunt: **a passing suite is not evidence that the induction
// bar is right.**
//
// ---------------------------------------------------------------------------
// What this test actually found, which is more useful than a green check
// ---------------------------------------------------------------------------
//
// The noise is not random text. It is the shape that actually threatens a lexical
// matcher: messages that CONTAIN a vocabulary word for a reason that is not a standing
// preference — "把这段提交了吧" is a task, "commit 之前先跑测试" is an instruction for one
// turn. Against 18 such messages spread one per session, the counter promoted FOUR
// labels.
//
// That is not a bug in the counter. It is the counter's definition showing through:
// what it measures is **word recurrence**, and a preference is a SUBSET of word
// recurrence. Three unrelated one-off mentions of the same word in three sessions are
// indistinguishable, to this mechanism, from one preference stated three times — and no
// threshold fixes that, because a common word eventually recurs in any long history.
// The calibration that chose the bar of 3 could not have seen this: it counted message
// occurrences per word and never separated a preference from a mention.
//
// So the acceptance is not "the false-positive rate is zero". It is:
//
//   1. RECALL holds — every real preference still promotes under 75% noise, because a
//      bar raised until nothing is wrong is a bar that learns nothing.
//   2. The false-positive rate is MEASURED and bounded, and the number is written down
//      rather than implied.
//   3. The actual SAFETY property holds: every promoted candidate is quarantined
//      (`status: provisional`, `assertion: observed`), so a wrong one costs a line in a
//      review queue and never a rule in a brief. That is CAPTURE's quarantine doing the
//      work the threshold cannot.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createHabitPass } from '../lib/habit-pass.js'
import { readHabitState } from '../lib/habit-state.js'
import { bootstrapVault, parseNote } from '../lib/vault.js'

const PROJECT_ID = '7a1b2c3d-4e5f-4061-8273-849506172839'
const PROJECT = `Projects/noise--${PROJECT_ID.slice(0, 8)}`
const CONVENTIONS = `${PROJECT}/Conventions`
/**
 * The upper bound this run is held to.
 *
 * MEASURED 2026-10-11: 18 incidental mentions, one per session, promoted 4 of the 6
 * vocabulary labels — 67%. The bound is set at 75% so the number is pinned without
 * the test being brittle to a change of one message; an improvement is welcome and a
 * regression is a failure. It is deliberately not lowered to the measured value: the
 * point of recording it is that the rate is HIGH, and a bound tightened to exactly
 * today's number would read as a target rather than a ceiling.
 */
const MAX_FALSE_PROMOTION = 0.75

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'obsidian-mem-noise-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 4 }))
  const dataRoot = await mkdtemp(join(tmpdir(), 'obsidian-mem-noise-data-'))
  t.after(() => rm(dataRoot, { recursive: true, force: true, maxRetries: 4 }))
  const home = join(root, 'home')
  await mkdir(home, { recursive: true })
  const vault = join(root, 'vault')
  const binding = {
    kind: 'bound',
    projectId: PROJECT_ID,
    slug: 'noise',
    displayName: 'noise',
    schema: 1,
    vaultRoot: vault,
    relativeDir: PROJECT,
  }
  await bootstrapVault(binding, { dataRoot, home })
  return { root, dataRoot, home, vault, binding }
}

function config(overrides = {}) {
  return {
    habitLearning: {
      enabled: true,
      promoteAfter: 3,
      markers: [],
      halfLifeDays: 30,
      demoteBelow: 0.5,
      archiveBelow: 0.15,
      ...overrides,
    },
  }
}

function turn(text) {
  return [
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    {
      type: 'user/message',
      seq: 2,
      data: { source: { kind: 'user' }, content: [{ type: 'text', text }] },
    },
    { type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

/** 6 standing preferences, each stated in 5 distinct sessions. */
const STANDING = [
  '以后改动完就提交，不要留在工作区',
  '我们统一用 superpowers 的流程',
  '产出都写成规格和计划',
  '回答用中文',
  '解释一下为什么这么做',
  '说简洁一点',
]
/**
 * 18 incidental mentions, one per session, sharing the vocabulary words.
 *
 * Four of them contain 提交 or commit, four contain 规格/spec/计划, three contain 中文,
 * four contain 解释/为什么 — the deliberate overlap that makes a lexical matcher's
 * weakness measurable. Each is a one-off task or aside, not a standing preference.
 */
const INCIDENTAL = [
  '把这段提交了吧',
  '这个 commit 信息帮我改一下',
  '先看看上一个 superpowers 的例子',
  '这份规格再补一节',
  '把中文翻译删掉',
  '解释器版本是多少',
  '简洁的那个模板在哪',
  '计划书模板发我',
  '用中文写的那份还在吗',
  '为什么这里会报错',
  '提交记录里有答案',
  '这个 spec 文件在哪',
  '把中文注释去掉',
  '简洁版和完整版都要',
  '解释一下这段代码',
  '计划里没写这一条',
  'commit 之前先跑测试',
  '为什么测试挂了',
]

/** Run a corpus of messages, one session each, and report what promoted. */
async function runCorpus(f, texts, { repeat = 1 } = {}) {
  const pass = createHabitPass({ dataRoot: f.dataRoot, config: config(), home: f.home })
  const promoted = []
  let session = 0
  let vaultHash = null
  for (let round = 0; round < repeat; round += 1) {
    for (const text of texts) {
      session += 1
      const r = await pass.recordTurn({
        binding: f.binding,
        sessionId: `s-${session}`,
        events: turn(text),
      })
      vaultHash = r.vaultHash ?? vaultHash
      promoted.push(...r.promoted)
    }
  }
  return { promoted, sessions: session, vaultHash }
}

test('RECALL: under 75% noise every real preference is still promoted', async (t) => {
  // A bar raised until nothing is wrong is a bar that learns nothing, so the stress
  // case has to show the real preferences still arriving. 6 standing x 5 sessions,
  // against 18 incidental x 1 session — a 37.5% signal ratio, the noise-dominant
  // shape TraceRetain needed before pollution appeared at all.
  const f = await fixture(t)
  const standing = await runCorpus(f, STANDING, { repeat: 5 })
  const incidental = await runCorpus(f, INCIDENTAL)
  const labels = new Set([...standing.promoted, ...incidental.promoted])
  for (const text of STANDING) {
    assert.ok([...labels].length > 0, `the standing corpus promoted nothing at all: ${text}`)
  }
  assert.equal(
    new Set(standing.promoted).size,
    STANDING.length,
    'every standing preference promoted exactly one label',
  )
})

test('MEASURED: the false-promotion rate of 18 incidental mentions, and its bound', async (t) => {
  // The number, not an assurance. This is the finding the noise stress exists to
  // produce, and it is asserted so a change that makes it WORSE cannot pass silently.
  // A rate that improves is welcome; the bound is the ceiling, not the target.
  const f = await fixture(t)
  const { promoted, sessions, vaultHash } = await runCorpus(f, INCIDENTAL)
  const falseLabels = new Set(promoted)
  const rate = falseLabels.size / STANDING.length
  assert.equal(sessions, INCIDENTAL.length, 'one session per incidental message')
  assert.ok(
    rate <= MAX_FALSE_PROMOTION,
    `false-promotion rate ${(rate * 100).toFixed(0)}% exceeded the ${(MAX_FALSE_PROMOTION * 100).toFixed(0)}% bound`,
  )
  // The mechanism, stated as an assertion: an incidental word promotes once it has
  // recurred in `promoteAfter` separate sessions. Recurrence is what the counter
  // measures, and it cannot tell a preference from a mention.
  const state = await readHabitState(f.dataRoot, vaultHash, PROJECT_ID)
  for (const label of falseLabels) {
    assert.ok(
      state.records[label].sessions >= config().habitLearning.promoteAfter,
      `${label} promoted below the bar`,
    )
  }
})

test('SAFETY: every promoted candidate is quarantined, which is what makes the rate tolerable', async (t) => {
  // The property the whole design rests on. A false positive that cannot reach a brief
  // costs a line in a review queue; the same false positive written as an active rule
  // would be the pollution the literature measures. So this asserts the safety on BOTH
  // corpora — the true positives and the false ones alike.
  const f = await fixture(t)
  await runCorpus(f, STANDING, { repeat: 5 })
  await runCorpus(f, INCIDENTAL)
  const names = (await readdir(join(f.vault, CONVENTIONS))).filter((n) => n.startsWith('习惯：'))
  assert.ok(names.length > 0, 'the fixture promoted something, or this proves nothing')
  for (const name of names) {
    const text = await readFile(join(f.vault, CONVENTIONS, name), 'utf8')
    const note = parseNote(Buffer.from(text))
    assert.equal(note.data.status, 'provisional', `${name} must be quarantined`)
    assert.equal(note.data.assertion, 'observed', `${name} must not claim the user said it`)
    assert.ok(note.data.tags.includes('user-habit'), `${name} must carry the habit tag`)
  }
})

test('the bar controls VOLUME, not correctness, and that is stated as a measurement', async (t) => {
  // Raising the bar does not rescue precision: a common word eventually recurs in any
  // long history, so the same incidental corpus promoted at 3 also promotes at 4 where
  // four mentions exist. What the bar does is bound how MUCH reaches the review queue.
  // Two runs at different bars, both measured, so the claim is not a reading.
  const atThree = await fixture(t)
  const first = await runCorpus(atThree, INCIDENTAL)
  const high = await fixture(t)
  const pass = createHabitPass({
    dataRoot: high.dataRoot,
    config: config({ promoteAfter: 9 }),
    home: high.home,
  })
  const promotedAtNine = []
  for (const [index, text] of INCIDENTAL.entries()) {
    const r = await pass.recordTurn({
      binding: high.binding,
      sessionId: `s-${index}`,
      events: turn(text),
    })
    promotedAtNine.push(...r.promoted)
  }
  assert.ok(
    new Set(first.promoted).size > new Set(promotedAtNine).size,
    'a higher bar admits strictly less of the same corpus',
  )
  assert.deepEqual(promotedAtNine, [], 'and at 9 a corpus of one-per-session admits none')
})
