import assert from 'node:assert/strict'
import { test } from 'node:test'

import { promptFromMessages, promptRecall } from '../lib/prompt-recall.js'

const path = 'Projects/demo--1c392abb/Decisions/FTS5-中文索引.md'

test('a relevant result becomes a bounded pointer and never copies its body', async () => {
  const calls = []
  const result = await promptRecall({
    prompt: '如何修复 FTS5 中文索引？',
    seenPaths: new Set(),
    maxChars: 360,
    search: async (args) => {
      calls.push(args)
      return [
        {
          path,
          title: 'FTS5 中文索引',
          snippet: 'PRIVATE NOTE BODY',
          scoreSignals: ['title-contains', 'token-hits:5', 'source-verified'],
        },
      ]
    },
  })

  assert.deepEqual(calls[0].scope, 'project')
  assert.equal(calls[0].limit, 8)
  assert.deepEqual(result.paths, [path])
  assert.match(result.text, /mem_read/)
  assert.match(result.text, /FTS5-中文索引\.md/)
  assert.doesNotMatch(result.text, /PRIVATE NOTE BODY/)
  assert.ok([...result.text].length <= 360)
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
  assert.equal(await promptRecall({ prompt: '请详细规划一个完全不相关的长任务', search }), null)
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
