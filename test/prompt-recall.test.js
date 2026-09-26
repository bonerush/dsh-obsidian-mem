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
    await promptRecall({
      prompt: '请详细规划一个完全不相关的长任务',
      search,
      maxChars: RECALL_BUDGET,
    }),
    null,
  )
  assert.equal(calls, 1)
  assert.equal(await promptRecall({ prompt: '好', search }), null)
  assert.equal(calls, 1)

  const strongSearch = async () => [
    { path, title: 'FTS5 中文索引', scoreSignals: ['title-contains', 'token-hits:5'] },
  ]
  assert.equal(
    await promptRecall({
      prompt: 'FTS5 中文索引',
      search: strongSearch,
      seenPaths: new Set([path]),
    }),
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
