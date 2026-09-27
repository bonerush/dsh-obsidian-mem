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

test('a long prompt does not raise the floor above four token hits', async () => {
  // Measured over the 148 real prompts that produce a query: the ratio term tops
  // out at a floor of 5 for a 16-token query, and that bucket rejected hits at
  // four token hits that a reader judges relevant — 22.3% of prompts fired,
  // against 58.1% with the floor capped at four. The floor still never drops
  // below three, so a weak match stays silent.
  const long = '甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉'
  const weak = await promptRecall({
    prompt: long,
    search: async () => [{ path, title: '弱命中', scoreSignals: ['token-hits:3'] }],
  })
  assert.equal(weak.outcome, 'below-floor', 'three token hits is still not enough')

  const strong = await promptRecall({
    prompt: long,
    search: async () => [{ path, title: '强命中', scoreSignals: ['token-hits:4'] }],
  })
  assert.equal(strong.outcome, 'fired', 'four token hits clears the capped floor')
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
