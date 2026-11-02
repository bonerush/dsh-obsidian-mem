// Task 10 / search envelope: the search-level facts must survive the boundary
// from the index to the tool result.
//
// `lib/index-db.js` deliberately attaches `truncated`, `truncationReason`,
// `candidateWindow`, `rowsExamined` and `candidatesScored` to the result array
// as non-enumerable properties, so an empty list can never be mistaken for
// "searched and found nothing" when a bound closed the window. Both boundaries
// above the index used to rebuild the array: `services.search` projected every
// hit into a fresh object and offered no place for the facts, and the tool
// returned only `{ hits }`, whose closed schema had no field for them either.
// A caller therefore saw a truncated search as a successful, complete one.
//
// These cases mount the shipped tool runtime against a throwaway world and seed
// notes by writing the vault directly: one `services.write` creates the project
// and a note whose frontmatter is a template, and the rest are copies of that
// template with a unique id/title. The first search pays for the index's initial
// scan, so the whole file stays a couple of seconds rather than dozens of writes.
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import toolsPlugin from '@deepseek-ai/dsh-tools'

import { registerTools } from '../lib/tools.js'
import { makeCurationWorld } from './curation-world.js'

/** The five search-level facts the index attaches to a result array. */
const SEARCH_FACTS = [
  'truncated',
  'truncationReason',
  'candidateWindow',
  'rowsExamined',
  'candidatesScored',
]

/** A real Cordis context with the shipped ToolRuntime mounted. */
async function toolbed(t) {
  const ctx = new Context()
  ctx.provide('systemPrompt', { tools: () => () => {} })
  const fork = ctx.plugin(toolsPlugin)
  await fork
  t.after(async () => {
    await fork.dispose().catch(() => {})
  })
  return ctx
}

let callSeq = 0

/** Execute one tool through the real runtime, with a real `AbortSignal`. */
function call(ctx, name, args, extra = {}) {
  return ctx.tools.execute({
    callId: `call-${(callSeq += 1)}`,
    name,
    arguments: args,
    signal: extra.signal ?? new AbortController().signal,
    ...('agent' in extra ? { agent: extra.agent } : {}),
  })
}

/**
 * Seed `count` convention notes by copying the freshly written note's template.
 *
 * @param {object} world - a `makeCurationWorld` result.
 * @param {number} count - how many extra notes to write.
 * @returns {Promise<string[]>} the seeded vault paths.
 */
async function seedConventions(world, count) {
  const first = await world.services.write({
    type: 'convention',
    title: '种子',
    body: '调度器种子。',
  })
  const absolute = join(world.vault, ...first.path.split('/'))
  const template = await readFile(absolute, 'utf8')
  const directory = absolute.slice(0, absolute.lastIndexOf('/'))
  const written = [first.path]
  for (let i = 0; i < count; i += 1) {
    const id = `con-00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
    const content = template
      .replace(/^id: .*$/m, `id: "${id}"`)
      .replace(/^title: .*$/m, `title: "直接写 ${i}"`)
      .replace('调度器种子。', `第 ${i} 条：调度器可插拔直接写。`)
    const name = `直接写 ${i}.md`
    await writeFile(join(directory, name), content)
    written.push(`${first.path.slice(0, first.path.lastIndexOf('/'))}/${name}`)
  }
  return written
}

test('mem_search reports how the index truncated its candidate window', async (t) => {
  const world = await makeCurationWorld(t)
  const seeded = await seedConventions(world, 30)
  assert.equal(seeded.length, 31)
  const ctx = await toolbed(t)
  registerTools(ctx, world.services)
  const agent = { session: { header: { id: 'sess-envelope', cwd: world.repo } } }

  // 31 matching notes, limit 1: the window (24) closes before the source is
  // exhausted, so a single returned hit is a cut-短 result, not the whole answer.
  const result = await call(ctx, 'mem_search', { query: '调度器', limit: 1 }, { agent })
  assert.equal(result.isError, false, result.error?.message)
  assert.equal(result.value.hits.length, 1)
  assert.equal(result.value.truncated, true, 'a bounded window must not look complete')
  assert.equal(result.value.truncationReason, 'candidate-window:24')
  assert.equal(result.value.candidateWindow, 24)
  assert.equal(result.value.rowsExamined, 25)
  assert.equal(result.value.candidatesScored, 24)
})

test('mem_search reports a genuinely empty search as not truncated', async (t) => {
  const world = await makeCurationWorld(t)
  await seedConventions(world, 3)
  const ctx = await toolbed(t)
  registerTools(ctx, world.services)
  const agent = { session: { header: { id: 'sess-envelope-empty', cwd: world.repo } } }

  const result = await call(ctx, 'mem_search', { query: 'no-such-token-zzzz' }, { agent })
  assert.equal(result.isError, false, result.error?.message)
  assert.deepEqual(result.value.hits, [])
  // Present and false, not missing: "searched and found nothing" is a claim the
  // caller can only trust if the envelope states it explicitly.
  assert.equal(result.value.truncated, false)
  assert.equal(result.value.truncationReason, null)
  assert.equal(typeof result.value.candidateWindow, 'number')
  assert.equal(result.value.candidatesScored, 0)
})

test('the service boundary keeps the index facts without leaking them into hits', async (t) => {
  const world = await makeCurationWorld(t)
  await seedConventions(world, 30)

  const hits = await world.services.search({ query: '调度器', limit: 1 })
  assert.equal(hits.length, 1)
  for (const fact of SEARCH_FACTS) {
    assert.equal(fact in hits, true, `the service result must carry ${fact}`)
  }
  assert.equal(hits.truncated, true)
  assert.equal(hits.truncationReason, 'candidate-window:24')
  // The facts are non-enumerable: the array still serialises as a plain list, so
  // a renderer that JSON-encodes the hits cannot turn them into elements.
  assert.deepEqual(Object.keys(hits), ['0'])
  const plain = JSON.parse(JSON.stringify(hits))
  assert.equal(plain.length, 1)
  assert.deepEqual(Object.keys(plain[0]).sort(), [
    'id',
    'path',
    'projectId',
    'scoreSignals',
    'snippet',
    'source',
    'status',
    'title',
    'type',
  ])
})
