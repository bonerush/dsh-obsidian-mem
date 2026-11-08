import assert from 'node:assert/strict'
import { test } from 'node:test'

import { MAX_SNIPPET_CHARS, promptFromMessages, promptRecall } from '../lib/prompt-recall.js'

const path = 'Projects/demo--1c392abb/Decisions/FTS5-中文索引.md'
const RECALL_BUDGET = 900

test('a relevant result carries the index excerpt, not a bare pointer', async () => {
  const calls = []
  const result = await promptRecall({
    prompt: '如何修复 FTS5 中文索引？',
    seenPaths: new Set(),
    maxChars: RECALL_BUDGET,
    search: async (args) => {
      calls.push(args)
      return [
        {
          path,
          title: 'FTS5 中文索引',
          snippet: '中文分词命中：把查询切成 bigram 再拼 FTS5 MATCH',
          scoreSignals: ['title-contains', 'token-hits:5', 'source-verified'],
        },
      ]
    },
  })

  assert.deepEqual(calls[0].scope, 'project')
  assert.equal(calls[0].limit, 8)
  assert.deepEqual(result.paths, [path])
  assert.match(result.text, /FTS5-中文索引\.md/)
  // The excerpt the index already computed is what makes the message usable
  // without a second voluntary tool call.
  assert.match(result.text, /中文分词命中/)
  assert.match(result.text, /mem_read/)
  assert.ok([...result.text].length <= RECALL_BUDGET)
})

test('a long or multiline excerpt is clamped and collapsed to one line', async () => {
  const result = await promptRecall({
    prompt: '如何修复 FTS5 中文索引？',
    seenPaths: new Set(),
    maxChars: RECALL_BUDGET,
    search: async () => [
      {
        path,
        title: 'FTS5 中文索引',
        snippet: `spaced\n\n\t text ${'x'.repeat(5000)}`,
        scoreSignals: ['title-contains', 'token-hits:5'],
      },
    ],
  })
  assert.ok(!result.text.includes('x'.repeat(MAX_SNIPPET_CHARS + 1)), 'the excerpt is clamped')
  assert.ok(!result.text.includes('\n\n'), 'the excerpt never breaks the line layout')
  assert.match(result.text, /spaced text/)
})

test('a hit without an excerpt still yields a usable pointer line', async () => {
  const result = await promptRecall({
    prompt: '如何修复 FTS5 中文索引？',
    seenPaths: new Set(),
    maxChars: RECALL_BUDGET,
    search: async () => [{ path, title: 'FTS5 中文索引', scoreSignals: ['title-contains'] }],
  })
  assert.deepEqual(result.paths, [path])
  assert.match(result.text, /FTS5-中文索引\.md/)
})

test("a caller's smaller ceiling binds, so the configured range is honest", async () => {
  const result = await promptRecall({
    prompt: '如何修复 FTS5 中文索引？',
    seenPaths: new Set(),
    maxChars: 300,
    search: async () => [
      { path, title: 'FTS5 中文索引', snippet: 'x'.repeat(100), scoreSignals: ['title-contains'] },
      {
        path: path.replace('FTS5', 'FTS5-b'),
        title: 'FTS5 中文索引二',
        snippet: 'y'.repeat(100),
        scoreSignals: ['title-contains'],
      },
    ],
  })
  assert.ok([...result.text].length <= 300)
  assert.ok(result.paths.length < 2, 'the second note does not fit and is skipped, not truncated')
})

test('a recall decision reports why it was silent, and how much it saw', async () => {
  // The plugin could not previously answer "did recall fire?" from its own
  // diagnostics: the `brief` event fires whenever the *brief* is injected,
  // whatever the map did. The decision is now part of the returned value, so the
  // adapters can record it.
  const below = await promptRecall({
    prompt: '请详细规划一个完全不相关的长任务',
    search: async () => [
      { path, title: '不相关', scoreSignals: ['token-hits:1'] },
      { path: path.replace('FTS5', 'FTS5-b'), title: '也不相关', scoreSignals: ['token-hits:1'] },
    ],
  })
  assert.equal(below.outcome, 'below-floor')
  assert.equal(below.text, null)
  assert.equal(below.hits, 2)
  assert.equal(below.chars, 0)
  assert.equal(below.accepted, 0, 'nothing passed the gate')
  assert.equal(below.injected, 0, 'nothing was offered')
  assert.deepEqual(below.paths, [])

  const tooShort = await promptRecall({ prompt: '好', search: async () => [] })
  assert.equal(tooShort.outcome, 'no-query')

  const empty = await promptRecall({ prompt: '如何修复 FTS5 中文索引？', search: async () => [] })
  assert.equal(empty.outcome, 'no-hits')
  assert.equal(empty.hits, 0)

  const fired = await promptRecall({
    prompt: '如何修复 FTS5 中文索引？',
    search: async () => [
      { path, title: 'FTS5 中文索引', snippet: '片段', scoreSignals: ['title-contains'] },
    ],
  })
  assert.equal(fired.outcome, 'fired')
  assert.equal(fired.hits, 1)
  assert.equal(fired.chars, [...fired.text].length)
  assert.equal(fired.accepted, 1, 'the gate accepted the one candidate')
  assert.equal(fired.injected, 1, 'and the map carried it')
  assert.deepEqual(fired.paths, [path])
})

test('every acceptable note already shown is all-seen, not below-floor', async () => {
  const result = await promptRecall({
    prompt: '如何修复 FTS5 中文索引？',
    seenPaths: new Set([path]),
    search: async () => [{ path, title: 'FTS5 中文索引', scoreSignals: ['title-contains'] }],
  })
  assert.equal(result.outcome, 'all-seen')
  assert.equal(result.text, null)
})

test('the Phase 2 gate needs six token hits, more than the old capped floor', async () => {
  // Phase 2 raises the automatic gate to title/phrase OR token-hits >=
  // max(6, floor). The measured reason: at four hits the corpus gate passes
  // 61.0% of top-3 slots at 20.1% precision; at six the offline replay gives
  // 39.8% precision with 5.0% no-answer false positives.
  const long = '甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉'
  for (const count of [3, 4, 5]) {
    const weak = await promptRecall({
      prompt: long,
      search: async () => [{ path, title: '弱命中', scoreSignals: ['token-hits:' + count] }],
    })
    assert.equal(weak.outcome, 'below-floor', count + ' token hits is still not enough')
  }

  const strong = await promptRecall({
    prompt: long,
    search: async () => [{ path, title: '强命中', scoreSignals: ['token-hits:6'] }],
  })
  assert.equal(strong.outcome, 'fired', 'six token hits clears the Phase 2 gate')
})

test('a top-three dense slot above the semantic threshold passes without token overlap', async () => {
  // The hybrid ranker can place the right note in the top three while the
  // lexical floor still rejects it; the dense score is the only evidence left.
  const result = await promptRecall({
    prompt: '记忆召回为什么对不上',
    seenPaths: new Set(),
    maxChars: RECALL_BUDGET,
    search: async () => [
      {
        path,
        title: 'FTS5 中文索引',
        snippet: '语义分支接受的摘录',
        scoreSignals: ['semantic-score:0.93', 'hybrid-rank:2', 'token-hits:1'],
      },
    ],
  })
  assert.equal(result.outcome, 'fired')
  assert.equal(result.accepted, 1, 'the semantic branch accepted the slot')
  assert.equal(result.injected, 1)
  assert.deepEqual(result.paths, [path])
  assert.ok(result.text.includes('语义分支接受的摘录'))
})

test('the semantic branch needs both the calibrated score and the fused shortlist', async () => {
  // 0.90 is a better threshold for e5-base but worse for the calibrated e5-small
  // model, and a slot the fusion ranked fourth is not a top-three decision.
  const cases = [
    ['semantic-score:0.91', 'hybrid-rank:1', 'token-hits:1'],
    ['semantic-score:0.99', 'hybrid-rank:3', 'token-hits:1'],
  ]
  for (const signals of cases) {
    const result = await promptRecall({
      prompt: '记忆召回为什么对不上',
      search: async () => [
        { path, title: 'FTS5 中文索引', snippet: '不该注入的摘录', scoreSignals: signals },
      ],
    })
    assert.equal(result.accepted, 0, signals.join(' '))
    assert.equal(result.outcome, 'near-miss', signals.join(' '))
    assert.ok(!result.text.includes('不该注入的摘录'))
  }
})

test('the resident hot layer is never offered back as recall', async () => {
  const hot = 'Projects/demo--1c392abb/_meta/hot.md'
  const result = await promptRecall({
    prompt: '如何修复 FTS5 中文索引？',
    seenPaths: new Set(),
    maxChars: RECALL_BUDGET,
    search: async () => [
      { path: hot, title: '热记忆', snippet: '已常驻的层', scoreSignals: ['title-contains'] },
      { path, title: 'FTS5 中文索引', snippet: '索引片段', scoreSignals: ['title-contains'] },
    ],
  })
  assert.deepEqual(result.paths, [path])
  assert.ok(!result.text.includes(hot))
})

test('weak matches, already shown paths, and tiny prompts stay silent', async () => {
  let calls = 0
  const search = async () => {
    calls += 1
    return [
      {
        path,
        title: 'FTS5 中文索引',
        scoreSignals: ['token-hits:1', 'source-verified'],
      },
    ]
  }
  assert.equal(
    (
      await promptRecall({
        prompt: '请详细规划一个完全不相关的长任务',
        search,
        maxChars: RECALL_BUDGET,
      })
    ).text,
    null,
  )
  assert.equal(calls, 1)
  assert.equal((await promptRecall({ prompt: '好', search })).text, null)
  assert.equal(calls, 1)

  const strongSearch = async () => [
    { path, title: 'FTS5 中文索引', scoreSignals: ['title-contains', 'token-hits:5'] },
  ]
  assert.equal(
    (
      await promptRecall({
        prompt: 'FTS5 中文索引',
        search: strongSearch,
        seenPaths: new Set([path]),
      })
    ).text,
    null,
  )
})

test('a hit whose status automatic injection excludes is never offered', async () => {
  // A provisional note is recorded and searchable on purpose; the recall map is part
  // of automatic injection, so offering it back would leak the quarantine through the
  // prompt instead of the brief. History is normally filtered by the index already,
  // but a caller-supplied search need not be that index — the refusal belongs here.
  const withStatus = (status) => async () => [
    { path, title: 'FTS5 中文索引', status, scoreSignals: ['title-contains'] },
  ]
  for (const status of ['provisional', 'superseded', 'archived']) {
    const result = await promptRecall({ prompt: 'FTS5 中文索引', search: withStatus(status) })
    assert.equal(result.text, null, status)
    assert.deepEqual(result.paths, [], status)
  }
  // An active — or unrecorded — status stays eligible: a missing status is never
  // allowed to hide a note, which is the keep-on-doubt rule the brief already had.
  for (const status of ['active', undefined]) {
    const result = await promptRecall({ prompt: 'FTS5 中文索引', search: withStatus(status) })
    assert.equal(result.outcome, 'fired', String(status))
    assert.deepEqual(result.paths, [path])
  }
})

test('only producer-owned user messages become the DSH query', () => {
  assert.equal(
    promptFromMessages([
      {
        role: 'user',
        source: { kind: 'plugin:obsidian-mem' },
        content: [{ type: 'text', text: 'ignore me' }],
      },
      { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '修复索引' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'also ignore' }] },
    ]),
    '修复索引',
  )
  assert.equal(
    promptFromMessages([{ role: 'user', content: [{ type: 'text', text: 'no source' }] }]),
    null,
  )
})

test('a ranked dense lead becomes one weak hint line, never the body', async () => {
  const result = await promptRecall({
    prompt: '记忆召回为什么对不上',
    seenPaths: new Set(),
    maxChars: RECALL_BUDGET,
    search: async () => [
      {
        path,
        title: 'FTS5 中文索引',
        snippet: '这段摘录绝不能被注入为弱提示',
        scoreSignals: ['semantic-score:0.914', 'hybrid-rank:1', 'token-hits:2'],
      },
      {
        path: path.replace('FTS5', 'FTS5-b'),
        title: '次席候选',
        snippet: '次席摘录也不该出现',
        scoreSignals: ['semantic-score:0.60', 'hybrid-rank:3', 'token-hits:1'],
      },
    ],
  })
  assert.equal(result.outcome, 'near-miss')
  assert.equal(result.accepted, 0, 'the strong gate accepted nothing')
  assert.equal(result.injected, 1, 'the single hint line was offered')
  assert.deepEqual(result.paths, [path], 'the session dedupe records the hint')
  assert.match(result.text, /弱匹配/)
  assert.match(result.text, /需核实/)
  assert.match(result.text, /FTS5 中文索引/)
  assert.ok(!result.text.includes('这段摘录'), 'no excerpt on a weak hint')
  assert.ok(!result.text.includes('次席'), 'only the dense lead is named')
  assert.equal(result.text.split('\n').filter((line) => line.startsWith('- ')).length, 1)
})

test('the weak tier needs a dense lead, a margin, and a low absolute floor', async () => {
  const caseOf =
    ([first, second]) =>
    async () => [
      { path, title: '候选', scoreSignals: [first] },
      { path: path.replace('FTS5', 'FTS5-b'), title: '次席', scoreSignals: [second] },
    ]
  // Below the weak floor: the score cannot be a lead at all.
  let result = await promptRecall({
    prompt: '记忆召回为什么对不上',
    search: caseOf(['semantic-score:0.54', 'semantic-score:0.50']),
  })
  assert.equal(result.outcome, 'below-floor', 'below the weak floor')
  assert.equal(result.text, null)
  // Two dense candidates too close to call: no margin, no lead.
  result = await promptRecall({
    prompt: '记忆召回为什么对不上',
    search: caseOf(['semantic-score:0.62', 'semantic-score:0.61']),
  })
  assert.equal(result.outcome, 'below-floor', 'margin below 0.02')
  assert.equal(result.text, null)
  // Lexical-only evidence never becomes a weak hint: the measured no-answer
  // false-positive rate was 50-60% for a token-hits>=3 weak tier.
  result = await promptRecall({
    prompt: '记忆召回为什么对不上',
    search: async () => [{ path, title: '候选', scoreSignals: ['token-hits:2'] }],
  })
  assert.equal(result.outcome, 'below-floor', 'lexical-only')
  // A clear dense lead just above the floor is offered, without an excerpt.
  result = await promptRecall({
    prompt: '记忆召回为什么对不上',
    search: caseOf(['semantic-score:0.56', 'semantic-score:0.40']),
  })
  assert.equal(result.outcome, 'near-miss')
  assert.deepEqual(result.paths, [path])
})

test('a top dense lead is named without a margin; a middling lead still needs one', async () => {
  const caseOf =
    ([first, second]) =>
    async () => [
      { path, title: '候选', scoreSignals: [first] },
      { path: path.replace('FTS5', 'FTS5-b'), title: '次席', scoreSignals: [second] },
    ]
  // 0.66 vs 0.655 is under the 0.02 margin, but an absolute lead this high is
  // not a coin flip: on the key-backed vault the margin rule was hiding real
  // leads (coverage 147->151 of 200, no-answer weak hints unchanged 5/40).
  let result = await promptRecall({
    prompt: '记忆召回为什么对不上',
    search: caseOf(['semantic-score:0.66', 'semantic-score:0.655']),
  })
  assert.equal(result.outcome, 'near-miss', 'top-score lead needs no margin')
  assert.deepEqual(result.paths, [path])
  // Just under the top-score floor the old margin rule applies again.
  result = await promptRecall({
    prompt: '记忆召回为什么对不上',
    search: caseOf(['semantic-score:0.64', 'semantic-score:0.635']),
  })
  assert.equal(result.outcome, 'below-floor', 'below the top-score floor, margin still rules')
  assert.equal(result.text, null)
})

test('a weak hint already offered this session is all-seen, not repeated', async () => {
  const search = async () => [
    { path, title: '候选', scoreSignals: ['semantic-score:0.80', 'hybrid-rank:1'] },
  ]
  const first = await promptRecall({ prompt: '记忆召回为什么对不上', search })
  assert.equal(first.outcome, 'near-miss')
  const second = await promptRecall({
    prompt: '记忆召回为什么对不上',
    search,
    seenPaths: new Set(first.paths),
  })
  assert.equal(second.outcome, 'all-seen')
  assert.equal(second.text, null)
})

test('a strong hit this session suppresses the weak line', async () => {
  const result = await promptRecall({
    prompt: '如何修复 FTS5 中文索引？',
    search: async () => [
      { path, title: 'FTS5 中文索引', snippet: '直接命中', scoreSignals: ['title-contains'] },
      {
        path: path.replace('FTS5', 'FTS5-b'),
        title: '弱候选',
        scoreSignals: ['semantic-score:0.9', 'hybrid-rank:1'],
      },
    ],
  })
  assert.equal(result.outcome, 'fired')
  assert.ok(!result.text.includes('弱匹配'))
  assert.equal(result.paths.length, 1)
})

test('a long prompt keeps a bounded lexical query and sends the full text to the dense channel', async () => {
  // The lexical query stays bounded so FTS does not pay for a pasted page, but an
  // embedding is not a keyword query: production replay showed truncating the
  // text before both channels costs 8.7pp P@3. The full plain prompt therefore
  // travels as `denseQuery`; the fake search here stands in for services.search.
  const calls = []
  const prompt =
    '我需要你根据之前几个 session 的对话，评估记忆的调动情况、召回情况以及相关记忆工具的使用频率，看是否还存在什么问题。当前还是处于 V2 的次主分支上，你可以新建一个 feature 的分支，这个分支描述的是对于召回机制的改进。'
  const result = await promptRecall({
    prompt,
    search: async (args) => {
      calls.push(args)
      return []
    },
  })
  assert.equal(result.outcome, 'no-hits')
  assert.notEqual(calls[0].query, prompt, 'the lexical query is truncated')
  assert.ok([...calls[0].query].length < 200)
  assert.equal(calls[0].denseQuery, prompt, 'the dense channel receives the untruncated prompt')
})

test('the dense query is capped at 800 code points', async () => {
  // E2b on the recovery corpus: cap 400 costs 1.3pp P@3; 800 equals uncapped
  // quality (69.4% P@3, 85.0% recall@8) without embedding a pasted page.
  const calls = []
  const prompt = '记忆召回'.repeat(300) // 1,200 code points before the cap
  await promptRecall({
    prompt,
    search: async (args) => {
      calls.push(args)
      return []
    },
  })
  assert.equal([...calls[0].denseQuery].length, 800)
  assert.ok([...calls[0].query].length < 200, 'the lexical query stays bounded')
})

test('a short prompt does not duplicate itself into denseQuery', async () => {
  const calls = []
  await promptRecall({
    prompt: '如何修复 FTS5 中文索引？',
    search: async (args) => {
      calls.push(args)
      return []
    },
  })
  assert.equal(calls[0].denseQuery, undefined, 'no truncation means no denseQuery argument')
})

test('a very short follow-up searches with the previous turn as its lexical query', async () => {
  // All 40 deictic prompts on the frozen corpus are 5-14 code points and carry a
  // previous-turn context. The token gate can never pass a referent-less query,
  // so the lexical query is rebuilt from prompt + context: deictic P@3 43.8% ->
  // 53.1%, gate pass 0% -> 9.4%, every other class unchanged, no-answer FP 2.5%.
  const calls = []
  const context = '上一轮在核对 AGENTS.md 里的开发依赖数量'
  const result = await promptRecall({
    prompt: '继续推进',
    context,
    search: async (args) => {
      calls.push(args)
      return []
    },
  })
  assert.equal(result.outcome, 'no-hits')
  assert.match(calls[0].query, /agents|开发/)
  assert.equal(calls[0].denseQuery, '继续推进', 'the dense channel still gets the prompt itself')
  assert.equal(calls[0].context, context, 'the dense channel still receives the context as well')
})

test('a two-character continuation is a query only when a previous turn exists', async () => {
  const calls = []
  await promptRecall({
    prompt: '继续',
    context: '上一轮在核对 AGENTS.md 里的开发依赖数量',
    search: async (args) => {
      calls.push(args)
      return []
    },
  })
  assert.equal(calls.length, 1, 'the context gives a referent-less continuation a query')
  assert.ok([...calls[0].query].length > 2)
  await promptRecall({ prompt: '继续', search: async () => [] })
  assert.equal(calls.length, 1, 'without context there is still nothing to search')
})

test('the context never joins a prompt that is not a short follow-up', async () => {
  const calls = []
  const prompt = '如何修复 FTS5 中文索引？'
  await promptRecall({
    prompt,
    context: '上一轮在核对 AGENTS.md 里的开发依赖数量',
    search: async (args) => {
      calls.push(args)
      return []
    },
  })
  assert.equal(calls[0].query, prompt, 'a real question keeps exactly its own words')
  assert.equal(calls[0].denseQuery, undefined)
})

test('the thin-prompt cutoff is eight code points', async () => {
  const calls = []
  const search = async (args) => {
    calls.push(args)
    return []
  }
  await promptRecall({ prompt: '这个还是要改一下', context: '上一轮在改召回门槛', search })
  assert.equal(calls[0].query, '这个还是要改一下 上一轮在改召回门槛')
  await promptRecall({ prompt: '这个还是要改一下啊', context: '上一轮在改召回门槛', search })
  assert.equal(calls[1].query, '这个还是要改一下啊', 'nine code points is not a follow-up')
})
