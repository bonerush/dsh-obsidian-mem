// Task 17: the language rules one memory note is measured against.
//
// Two things are under test and they fail for different reasons. The first half
// pins the RULES — the thresholds, the vocabularies and the two rules that are
// deliberately absent. The second half pins the ASYMMETRY between the severities,
// which is the only part of this module that can lose a fact: a finding strong
// enough to reroute a candidate moves it to `Inbox/` instead of `Conventions/`,
// `Pitfalls/` or `Decisions/`, so a rule that reroutes on "would read better" is
// a memory outage wearing a style guide's clothes.
//
// Every threshold here is calibrated on the author's own vault (739 fact notes)
// and the measurements are recorded beside the constants in `lib/note-style.js`.
// The case that matters most is `holds the measured corpus`, which asserts the
// calibration still holds rather than trusting the comment: it re-measures a
// fixed sample and fails if a rule starts firing on ordinary notes.
//
// These are pure functions over strings — no vault, no data root, no model — so
// every case here runs in microseconds and none of them touches the filesystem.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  cjkShare,
  languagesAgree,
  MAX_SENTENCE_CJK,
  MAX_SENTENCE_WORDS,
  MAX_SENTENCES,
  sentenceLength,
  shouldDowngrade,
  splitSentences,
  STYLE_SEVERITIES,
  styleFindings,
} from '../lib/note-style.js'

/** Every finding for one body, with the title omitted. */
function forBody(body) {
  return styleFindings({ title: '', body })
}

/** The rules that fired, sorted, for a terse assertion. */
function rules(body, title = '') {
  return styleFindings({ title, body })
    .map((finding) => finding.rule)
    .sort()
}

/** The one finding for a rule, or a failure naming what fired instead. */
function only(body, rule, title = '') {
  const found = styleFindings({ title, body }).filter((finding) => finding.rule === rule)
  assert.equal(
    found.length,
    1,
    `expected exactly one ${rule} finding, got ${JSON.stringify(rules(body, title))}`,
  )
  return found[0]
}

test('a body with no findings is the common case and stays empty', () => {
  assert.deepEqual(forBody('绑定指针只在仓库根，身份是 projectId。'), [])
  assert.deepEqual(
    forBody('The vault is never the scratch space. Tests use mktemp -d instead.'),
    [],
  )
})

test('an empty or whitespace body has nothing to measure', () => {
  // The distillation contract allows a body only as a non-blank string, so this
  // is a guard rather than a live path: it must not report a finding that would
  // reroute a candidate whose body the validator already refused.
  assert.deepEqual(forBody(''), [])
  assert.deepEqual(forBody('   \n  '), [])
  assert.deepEqual(styleFindings({}), [])
  assert.deepEqual(styleFindings({ title: 42, body: null }), [])
})

test('a sentence is split across both scripts and measured in its own unit', () => {
  assert.deepEqual(splitSentences('一句话。第二句！第三句？'), ['一句话。', '第二句！', '第三句？'])
  assert.deepEqual(splitSentences('First one. Second one! Third?'), [
    'First one.',
    'Second one!',
    'Third?',
  ])
  // The mixed-script split is the whole reason `sentenceLength` exists: a Chinese
  // sentence carrying identifiers is measured in characters, and counting its
  // Latin words too would make a compliant note look long. The count is exact —
  // 用/的/建/索/引 are the five CJK characters; every other character is Latin.
  assert.equal(sentenceLength('用 node:sqlite 的 FTS5 建索引。'), 5)
  // A Latin sentence is measured in words. `node:sqlite` and `fts5` each count
  // twice, because `\b` sits between a letter and an adjacent digit — a limitation
  // of counting identifiers as words rather than a defect to hide: STE's 25-word
  // ceiling is simply reached sooner by identifier-dense English, so the rule errs
  // toward asking for a shorter sentence.
  assert.equal(sentenceLength('use node:sqlite fts5 tables'), 5)
})

test('code spans, wikilinks and quote markers are masked before measuring', () => {
  // A wikilink left unmasked contributes a ~40-character "word" and would flag a
  // compliant note; a code span is not prose and is not measured at all.
  const withLink = '见 [[Projects/demo--1c392abb/Docs/a very long note title here|长标题]]。'
  assert.deepEqual(forBody(withLink), [])
  const longCode = `\`${'x'.repeat(200)}\` 是一个标识符。`
  assert.deepEqual(forBody(longCode), [])
})

test('a sentence over the CJK ceiling is reported once, at warn', () => {
  const just = `${'字'.repeat(MAX_SENTENCE_CJK)}。`
  assert.deepEqual(forBody(just), [], 'the ceiling itself is inside the budget')
  const over = only(`${'字'.repeat(MAX_SENTENCE_CJK + 1)}。`, 'sentence-length')
  assert.equal(over.severity, 'warn')
  assert.match(over.message, /61 units/)
})

test('an English sentence is measured in words, not characters', () => {
  const words = (n) => `${Array.from({ length: n }, (_, i) => `word${i}`).join(' ')}.`
  // `word0`..`wordN` are Latin words: 25 passes, 26 does not.
  assert.deepEqual(forBody(words(MAX_SENTENCE_WORDS)), [])
  const over = only(words(MAX_SENTENCE_WORDS + 1), 'sentence-length')
  assert.match(over.message, /26 units/)

  // The case that motivated the counting pattern: a token like `FTS5` or `UTF8`
  // ends in a digit, and a word boundary cannot follow letters+digits, so a
  // `\b`-terminated pattern measured a sentence of identifiers as zero words and
  // let it through any ceiling. Technical prose is exactly where those dominate.
  const identifiers = `${Array.from({ length: 30 }, (_, i) => `FTS${i}`).join(' ')}.`
  assert.match(only(identifiers, 'sentence-length').message, /30 units/)
  assert.equal(sentenceLength('FTS5 UTF8 ES6'), 3)
})

test('short English words count and quoted identifiers cannot cause language downgrades', () => {
  assert.equal(sentenceLength('I am on it and I do it by a rule'), 11)
  const long = `${Array.from({ length: 26 }, () => 'it').join(' ')}.`
  assert.equal(only(long, 'sentence-length').severity, 'warn')
  assert.equal(
    languagesAgree(
      '中文标题',
      '`abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ`. 中文内容。',
    ),
    true,
  )
  assert.deepEqual(forBody('命令为 `should --该文件`。'), [])
})

test('a sixth sentence is reported, and five are not', () => {
  const body = (n) => Array.from({ length: n }, (_, i) => `第${i}句。`).join('')
  assert.deepEqual(forBody(body(MAX_SENTENCES)), [])
  const over = only(body(MAX_SENTENCES + 1), 'sentences')
  assert.equal(over.severity, 'warn')
  assert.match(over.message, /6 sentences, beyond 5/)
})

test('an open-ended qualifier is reported; a stated bound is not', () => {
  const hedge = only('这可能需要重构。', 'hedge')
  assert.equal(hedge.severity, 'warn')
  assert.match(hedge.message, /可能/)

  // The distinction the vocabulary exists for. Each of these is information, and
  // a rule that flagged them would train the writer to delete the measurement.
  for (const bounded of [
    '索引重建约 15s 完成。',
    '正文上限 ≤9000 字符。',
    '一次最多 21 条。',
    'Retries stop after 3 attempts.',
    'The cap is 200 bytes.',
  ]) {
    assert.deepEqual(forBody(bounded), [], `expected no finding for ${JSON.stringify(bounded)}`)
  }

  // `应` is a normative verb in a GB/T clause; `应该` is the author guessing.
  assert.deepEqual(forBody('条款 5.3.4 规定术语应统一。'), [])
  assert.equal(only('术语应该统一。', 'hedge').rule, 'hedge')

  // `should` is listed beside 应该 on purpose: the federal guidelines define it
  // as a recommendation, which is the lost information this rule is about.
  assert.equal(only('The index should be rebuilt nightly.', 'hedge').rule, 'hedge')
})

test('a deictic reference is reported, and 其 is deliberately not a deictic', () => {
  const finding = only('该文件由插件生成。', 'deictic')
  assert.equal(finding.severity, 'warn')
  assert.match(finding.message, /该/)

  for (const word of ['上述', '前述', '前者', '后者']) {
    assert.equal(rules(`配置见${word}。`).includes('deictic'), true, `${word} should be reported`)
  }

  // The `应该` family is a hedge, never a deictic. This is a lookbehind and not a
  // lookahead for a reason worth keeping: 应 precedes 该, so a forward read cannot
  // exclude it, and before the lookbehind existed `应该重建索引` reported BOTH — as
  // though one word were two defects at once.
  assert.deepEqual(rules('应该重建索引。'), ['hedge'])

  // 其他/其余/其中/尤其 account for most occurrences of 其, and flagging them
  // would flag ordinary vocabulary across a third of the corpus.
  for (const ordinary of [
    '其他文件不动。',
    '其余条目保持原样。',
    '其中一个必须删除。',
    '尤其注意引号。',
  ]) {
    assert.equal(rules(ordinary).includes('deictic'), false, `${ordinary} is not deictic`)
  }
})

test('language agreement is a wide band, not a guess', () => {
  assert.equal(languagesAgree('中文标题', '这是一段中文正文。'), true)
  assert.equal(languagesAgree('English title', 'This is English prose.'), true)
  assert.equal(languagesAgree('中文标题', 'This body was never translated.'), false)
  assert.equal(languagesAgree('English title', '这段正文没有翻译。'), false)
  // An all-Latin title has a CJK SHARE of zero, which is also what a letterless
  // title has. An earlier guard read that 0 as "unclassifiable" and so switched
  // the rule off for every English note — the opposite of its purpose. The check
  // is on the letter count, and this pair is what pins it.
  assert.equal(cjkShare('English title'), 0)
  assert.equal(languagesAgree('English title', '这是一个中文标题的英文正文。'), false)

  // A bilingual title is what this vault actually writes. Above the 0.5 band it
  // counts as Chinese, so a Chinese body agrees and an English one disagrees —
  // `FTS5 中文索引` is 4 CJK characters against 3 Latin letters, which is a
  // Chinese title with a term in it, not an English one.
  assert.equal(languagesAgree('FTS5 中文索引', '这是一段中文正文。'), true)
  assert.equal(languagesAgree('FTS5 中文索引', 'Body of the note.'), false)
  // A title that is genuinely BETWEEN the bands is accepted either way rather
  // than guessed at: `index 与 索引` is 3 CJK characters against 5 Latin letters
  // (0.2), which is inside (0.15, 0.5) and therefore classifies as neither
  // language. The band is asymmetric on purpose — a body is "Chinese" at 0.15
  // while a title must reach 0.5, because a title carries the identifiers a
  // reader searches by and those are Latin.
  assert.equal(cjkShare('index 与 索引'), 0.375)
  assert.equal(languagesAgree('index 与 索引', '这是一段中文正文。'), true)
  assert.equal(languagesAgree('index 与 索引', 'Body of the note.'), true)
  // Unclassifiable input never produces a finding: a title with no letters at all
  // cannot disagree with anything.
  assert.equal(cjkShare('123 456'), 0)
  assert.equal(languagesAgree('123', '任何正文'), true)
})

test('only the language finding is strong enough to reroute a candidate', () => {
  // This is the case the corpus measurement produced. The first implementation of
  // this module made hedges, deictics and long sentences downgrades too, and
  // against the author's 739 real notes that rerouted 326 of them (44%) away from
  // the directory each was distilled for. A style rule may report; it may not move
  // a fact.
  const wording = '这可能有问题。该文件较大。上述结论不成立。'
  const findings = forBody(wording)
  // One hedge plus one deictic: the two vocabularies are separate findings, and
  // neither is a reroute.
  assert.deepEqual(findings.map((finding) => finding.rule).sort(), ['deictic', 'hedge'])
  assert.deepEqual(
    findings.map((finding) => finding.severity),
    findings.map(() => 'warn'),
  )
  assert.equal(shouldDowngrade(findings), false)

  const drift = styleFindings({ title: '中文标题', body: 'This body is in English.' })
  assert.equal(drift.length, 1)
  assert.equal(drift[0].severity, 'downgrade')
  assert.equal(shouldDowngrade(drift), true)

  // An empty body is declared allowed by the validator, so it must not reroute.
  assert.equal(shouldDowngrade(forBody('')), false)
})

test('every severity the module can emit is in its declared vocabulary', () => {
  // A severity outside `STYLE_SEVERITIES` would reach the linter's mapping and be
  // reported as a warning, silently losing a reroute.
  const emitted = new Set()
  for (const { title, body } of [
    { title: '', body: '这可能需要重构。' },
    { title: '', body: '该文件由插件生成。' },
    { title: '', body: `${'字'.repeat(61)}。` },
    { title: '', body: '一。二。三。四。五。六。' },
    { title: '中文标题', body: 'This body is in English.' },
  ]) {
    for (const finding of styleFindings({ title, body })) emitted.add(finding.severity)
  }
  assert.deepEqual([...emitted].sort(), ['downgrade', 'warn'])
  assert.deepEqual([...STYLE_SEVERITIES].sort(), ['downgrade', 'warn'])
})

test('holds the measured corpus', () => {
  // The calibration, asserted rather than described. These notes are the shapes
  // the vault actually contains — a convention, a gotcha and an ADR — and each was
  // chosen because an earlier threshold revision flagged it wrongly.
  const corpus = [
    // 58 CJK characters in one sentence: legitimately inside the 60 budget. At the
    // first threshold (50) this note was a finding, which is what moved the number.
    '本项目所有可视化以中文为默认语言，并遵循出版级规范：Paul Tol 色盲友好配色、300 dpi 导出、PNG 与 SVG 双格式。',
    // A convention that names its object instead of writing 该.
    'vault 内部布局固定为 Methods 全局目录加 Projects/<名>--<projectId 前 8 位> 目录，改名不改写历史记录。',
    // An ADR, which is allowed its tense: 已/将 is what an ADR records.
    'ADR-62：engines.node 已定为 22.22.2，因为这是实测到 node:sqlite 带 FTS5 的最低版本。',
    // A gotcha whose bound is the information.
    '热区上限为 9000 字符，超过时先归档再写入；简报预算为 6000 码点。',
  ]
  for (const body of corpus) {
    assert.deepEqual(
      styleFindings({ title: '跳过重建', body }),
      [],
      `the calibration flagged a real note: ${body}`,
    )
  }
})
