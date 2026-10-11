// Task 1: the habit signal extractor.
//
// This module exists because the FIRST version of this feature was falsified by
// measurement. It originally read tool calls — bash command names, file
// extensions, adjacent tool sequences — and counted them as evidence of how the
// user works. Replaying 137 real session logs (40 root sessions, 107 usable
// turns) showed that **99.0% of tool choices were never requested by the user**
// (291 of 294): the agent picked `grep` 78 times with the user naming it 0 times,
// `git` 63 times with 0 mentions, and so on. Counting those measures the AGENT's
// defaults, which are a constant across every user and therefore carry no
// information about who this user is. See `docs/habit-learning-results.md`.
//
// So the input here is a USER MESSAGE, and nothing else. There is deliberately no
// parameter through which events, tool names or arguments could arrive — the
// original mistake is excluded by the signature rather than by a comment.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { BUILTIN_MARKERS, labelsFromUserText } from '../lib/habit-signals.js'

test('the extractor takes a user message and nothing else', () => {
  // The falsified version took an events array. This asserts the replacement's
  // whole surface: one string in, labels out. A future edit that reintroduces an
  // events parameter has to delete this assertion first.
  assert.equal(labelsFromUserText.length, 1, 'labelsFromUserText takes exactly one argument')
  assert.deepEqual(labelsFromUserText(''), [])
})

test('text that matches nothing yields no labels, never a guess', () => {
  // Measured in the calibration: 4 of the 12 hand-written markers hit zero times,
  // so the vocabulary is known to be incomplete. An unrecognised message must
  // contribute nothing rather than a fallback label — the same choice
  // `failure-streak.js` makes when an unrecognised body contributes `unknown`.
  assert.deepEqual(labelsFromUserText('今天天气不错'), [])
  assert.deepEqual(labelsFromUserText('把那个文件挪一下'), [])
})

test('a stated preference is recognised', () => {
  assert.deepEqual(labelsFromUserText('重大改动完成就提交，不要留在工作区'), ['提交'])
  assert.deepEqual(labelsFromUserText('用中文回答我'), ['中文回答'])
})

test('one message can carry several labels, each once', () => {
  // Every label here is in the built-in vocabulary. 「先给结论」 is deliberately
  // NOT: the calibration measured it in 0 sessions, so it was dropped rather
  // than kept as speculation — a marker that never fires is a rule nobody stated.
  const labels = labelsFromUserText('为什么这么改？用中文，而且改动完记得提交')
  assert.deepEqual([...labels].sort(), ['中文回答', '提交', '解释原因'].sort())
  // Repetition inside one message is still one label: the count that matters is
  // over SESSIONS, and this function does not count at all.
  assert.deepEqual(labelsFromUserText('提交 提交 提交'), ['提交'])
})

test('labels are vocabulary entries, never text from the message', () => {
  // The state file stores labels. If a label could carry message text, the
  // private state would become a transcript of what the user typed.
  const hostile = '提交 my-secret-token /Users/someone/private/path.md'
  const labels = labelsFromUserText(hostile)
  assert.deepEqual(labels, ['提交'])
  for (const label of labels) {
    assert.ok(!label.includes('/'), 'no label carries a path separator')
    assert.ok(!/\s/.test(label), 'no label carries whitespace')
    assert.ok(label.length <= 32, 'labels are short')
  }
})

test('malformed input is answered, not thrown', () => {
  for (const value of [null, undefined, 42, {}, [], true]) {
    assert.deepEqual(labelsFromUserText(value), [], `answered for ${JSON.stringify(value)}`)
  }
})

test('extra markers extend the vocabulary without displacing the built-in one', () => {
  const extra = [{ label: '自定义', pattern: /照我说的做/ }]
  assert.deepEqual(labelsFromUserText('照我说的做', extra), ['自定义'])
  assert.deepEqual(labelsFromUserText('记得提交', extra), ['提交'], 'built-ins still work')
  assert.deepEqual(labelsFromUserText('照我说的做，记得提交', extra).sort(), ['提交', '自定义'])
})

test('a malformed extra marker is ignored rather than breaking the pass', () => {
  const broken = [
    { label: '', pattern: /x/ },
    { label: 'ok' },
    null,
    { label: 'ok2', pattern: /记得提交/ },
  ]
  assert.deepEqual(labelsFromUserText('记得提交', broken), ['提交', 'ok2'])
})

test('a very long message is bounded in time', () => {
  // A user can paste a megabyte. The scan must not become the slowest thing in a
  // turn, and no pattern may backtrack catastrophically.
  const huge = `${'a'.repeat(200_000)} ${'b'.repeat(200_000)}`
  const started = Date.now()
  const labels = labelsFromUserText(huge)
  const elapsed = Date.now() - started
  assert.deepEqual(labels, [])
  assert.ok(elapsed < 2000, `scanning 400k characters took ${elapsed}ms`)
})

test('a long message is scanned at both ends, and its middle is a known miss', () => {
  // The bound is a head-and-tail slice, so a preference stated at either end of a
  // long paste is found. One buried in the middle is NOT — that is the documented
  // cost of the bound, asserted here so it stays a decision instead of becoming a
  // surprise. The alternative (scanning all 400k) is also linear, but a paste that
  // size is a document, and a document's preference sits in its opening or closing
  // lines, not its middle.
  const head = `提交 ${'a'.repeat(50_000)}`
  assert.deepEqual(labelsFromUserText(head), ['提交'], 'a preference in the opening is found')
  const tail = `${'a'.repeat(50_000)} 记得提交`
  assert.deepEqual(labelsFromUserText(tail), ['提交'], 'a preference in the closing is found')
  const middle = `${'a'.repeat(50_000)} 记得提交 ${'b'.repeat(50_000)}`
  assert.deepEqual(
    labelsFromUserText(middle),
    [],
    'a preference buried in the middle is the known miss',
  )
})

test('every built-in marker is a usable, distinct entry', () => {
  const seen = new Set()
  for (const marker of BUILTIN_MARKERS) {
    assert.equal(typeof marker.label, 'string')
    assert.ok(marker.label.length > 0 && marker.label.length <= 32, `label bound: ${marker.label}`)
    assert.ok(!/\s/.test(marker.label), `label carries whitespace: ${marker.label}`)
    assert.ok(!seen.has(marker.label), `duplicate label: ${marker.label}`)
    seen.add(marker.label)
    assert.ok(marker.pattern instanceof RegExp, `pattern is a RegExp: ${marker.label}`)
  }
  assert.ok(seen.size >= 6, 'the vocabulary carries the markers the calibration found recurring')
})
