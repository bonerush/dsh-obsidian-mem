// Task 5: the hybrid branch of searchNotes and the runtime around it.
//
// Two seams are exercised separately on purpose. `searchHybrid` (in
// `lib/search.js`) only has to call the runtime the caller injected and attach
// the facts, so its cases use a fake handle over a real index. `createHybridRecall`
// owns warming and the dense shortlist, so its cases inject a fake provider and
// store and never touch the network. The end-to-end wiring (a real loopback
// provider over the real index) is the harness mode's job in Task 7.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

import { createHybridRecall } from '../lib/hybrid-recall.js'
import { IndexError, openIndex } from '../lib/index-db.js'
import { searchNotes } from '../lib/search.js'

import { registerTreeCleanup } from './platform-capabilities.js'

const PROJECT_ID = '5c2e9a11-8f34-4b6d-9c25-1a2b3c4d5e6f'
const PROJECT_SLUG = 't5'
const PROJECT_DIR = `Projects/${PROJECT_SLUG}--${PROJECT_ID.slice(0, 8)}`
const projectPath = (relative) => `${PROJECT_DIR}/${relative}`

/** Render one note as the Markdown the index parses. */
function renderNote(note) {
  return [
    '---',
    'type: "doc"',
    `title: ${JSON.stringify(note.title)}`,
    'status: "active"',
    `project: "${PROJECT_ID}"`,
    '---',
    '',
    `# ${note.title}`,
    '',
    note.body,
    '',
  ].join('\n')
}

/** A throwaway vault plus its open index. */
async function makeVault(t, notes) {
  const root = await mkdtemp(join(tmpdir(), 'obsidian-mem-t5-hybrid-'))
  const vault = join(root, 'vault')
  const dataRoot = join(root, 'data')
  await mkdir(dataRoot, { recursive: true })
  for (const note of notes) {
    const absolute = join(vault, ...projectPath(note.path).split('/'))
    await mkdir(dirname(absolute), { recursive: true })
    await writeFile(absolute, renderNote(note))
  }
  const index = await openIndex({
    vaultRoot: vault,
    dataRoot,
    backend: 'sqlite',
    projectId: PROJECT_ID,
  })
  const onCleanup = registerTreeCleanup(t, root)
  onCleanup(() => index.close().catch(() => {}))
  const ready = await index.waitReady(undefined, 10_000)
  assert.equal(ready.ready, true, `index did not become ready: ${JSON.stringify(ready)}`)
  return { vault, dataRoot, index }
}

/** A hit with the fields the fusion reads, shaped like the index's output. */
function lexicalHit(path, tokenHits = 3) {
  return {
    path,
    title: path,
    type: 'doc',
    status: 'active',
    score: 1,
    signals: {
      matchedBy: 'token',
      tokenHits,
      titleExact: false,
      titleContains: false,
      phraseContains: false,
      substringMatch: false,
      history: false,
      frontmatterBroken: false,
      repaired: false,
      verifiedSource: true,
    },
  }
}

/** A provider whose embed resolves one fixed vector and records the calls. */
function fakeProvider(vector, calls = []) {
  return {
    enabled: true,
    model: 'fake',
    dimensions: vector.length,
    async embed(request) {
      calls.push(request)
      return { model: 'fake', dimensions: vector.length, vectors: [vector] }
    },
  }
}

/** An embedding store over a fixed vector map. */
function fakeStore(vectors, { snapshotError = null } = {}) {
  return {
    sync: async () => ({ batches: 0 }),
    snapshot() {
      if (snapshotError !== null) throw snapshotError
      return { vectors: new Map(vectors), size: vectors.size, generatedAt: null }
    },
  }
}

// ---------------------------------------------------------------------------
// searchHybrid: the searchNotes branch
// ---------------------------------------------------------------------------

test("hybrid returns the injected runtime's order and attaches the facts", async (t) => {
  const { index } = await makeVault(t, [
    { path: 'Docs/retry.md', title: '重试策略', body: '失败重试要指数退避。' },
    { path: 'Docs/semantic.md', title: '调度', body: '失败重试要指数退避。' },
  ])
  const calls = []
  const hybrid = {
    async rank(request) {
      calls.push(request)
      const hits = [
        {
          ...lexicalHit(projectPath('Docs/semantic.md'), 2),
          signals: { ...lexicalHit('x').signals, semanticScore: 0.8, hybridRank: 1 },
        },
        {
          ...lexicalHit(projectPath('Docs/retry.md'), 5),
          signals: { ...lexicalHit('x').signals, semanticScore: 0.7, hybridRank: 2 },
        },
      ]
      Object.defineProperties(hits, {
        denseCandidates: { value: 2, enumerable: false },
        embedMs: { value: 7, enumerable: false },
        hybridFallback: { value: null, enumerable: false },
      })
      return hits
    },
  }
  const hits = await searchNotes(index, { query: '重试', engine: 'hybrid', hybrid, limit: 2 })
  assert.equal(calls.length, 1)
  assert.ok(Array.isArray(calls[0].lexicalTop))
  // The lexical shortlist is bounded by HYBRID_LEXICAL_LIMIT, not by the caller's limit.
  assert.equal(hits.length, 2)
  assert.equal(hits[0].path, projectPath('Docs/semantic.md'))
  assert.equal(hits.retrievalEngine, 'hybrid')
  assert.equal(hits.denseCandidates, 2)
  assert.equal(hits.embedMs, 7)
  assert.equal(hits.hybridFallback, null)
  assert.equal(typeof hits[0].signals.semanticScore, 'number')
})

test('a missing runtime falls back to the lexical order and says provider-unavailable', async (t) => {
  const { index } = await makeVault(t, [
    { path: 'Docs/retry.md', title: '重试策略', body: '失败重试要指数退避。' },
  ])
  const hits = await searchNotes(index, { query: '重试', engine: 'hybrid', limit: 2 })
  const lexical = await searchNotes(index, { query: '重试', limit: 2 })
  assert.deepEqual(
    hits.map((hit) => hit.path),
    lexical.map((hit) => hit.path),
  )
  assert.equal(hits.retrievalEngine, 'hybrid')
  assert.equal(hits.hybridFallback, 'provider-unavailable')
  assert.equal(hits.denseCandidates, 0)
})

test('a runtime failure falls back, and cancellation still throws', async (t) => {
  const { index } = await makeVault(t, [
    { path: 'Docs/retry.md', title: '重试策略', body: '失败重试要指数退避。' },
  ])
  const failing = {
    async rank() {
      throw Object.assign(new Error('down'), { code: 'provider-error' })
    },
  }
  const failed = await searchNotes(index, {
    query: '重试',
    engine: 'hybrid',
    hybrid: failing,
    limit: 2,
  })
  assert.equal(failed.hybridFallback, 'provider-error')
  const aborting = {
    async rank() {
      throw Object.assign(new Error('cancelled'), { code: 'provider-aborted' })
    },
  }
  await assert.rejects(
    searchNotes(index, { query: '重试', engine: 'hybrid', hybrid: aborting, limit: 2 }),
    (error) => error instanceof IndexError && error.code === 'aborted',
  )
})

test('the lexical engine never builds or calls a hybrid runtime', async (t) => {
  const { index } = await makeVault(t, [
    { path: 'Docs/retry.md', title: '重试策略', body: '失败重试要指数退避。' },
  ])
  let called = 0
  const hybrid = {
    async rank() {
      called += 1
      return []
    },
  }
  const hits = await searchNotes(index, { query: '重试', engine: 'lexical', hybrid, limit: 2 })
  assert.equal(called, 0)
  assert.equal(hits.retrievalEngine, undefined)
})

// ---------------------------------------------------------------------------
// createHybridRecall: warming, the dense shortlist and the fallbacks
// ---------------------------------------------------------------------------

/** The runtime's index stub: candidate rows for the scope and for the warm sync. */
function fakeIndex(rows) {
  return {
    async candidateNotes() {
      return rows
    },
  }
}

const ROW_LEXICAL = {
  path: projectPath('Docs/lexical.md'),
  title: '重试',
  hash: 'a',
  body: '失败重试要指数退避。',
}
const ROW_DENSE = {
  path: projectPath('Docs/dense.md'),
  title: '失败之后怎么办',
  hash: 'b',
  body: '请求失败后隔一段时间再试。',
}

test('a guard hit keeps the lexical order without embedding the query', async () => {
  const calls = []
  const runtime = createHybridRecall({
    config: { retrievalProvider: { enabled: true, model: 'fake', dimensions: 2 } },
    dataRoot: '/tmp/unused',
    vaultRoot: '/tmp/unused',
    index: fakeIndex([ROW_LEXICAL, ROW_DENSE]),
    provider: fakeProvider(new Float64Array([1, 0]), calls),
    store: fakeStore(new Map([[ROW_DENSE.path, new Float64Array([1, 0])]])),
  })
  const strong = [lexicalHit(ROW_LEXICAL.path, 8)]
  strong[0].signals.titleExact = true
  const hits = await runtime.rank({ query: '重试', filters: {}, lexicalTop: strong, limit: 3 })
  assert.equal(calls.length, 0)
  assert.equal(hits[0].path, ROW_LEXICAL.path)
  assert.equal(hits.hybridFallback, null)
})

test('a weak lexical order is fused with the dense shortlist, scope-filtered', async () => {
  const calls = []
  const runtime = createHybridRecall({
    config: { retrievalProvider: { enabled: true, model: 'fake', dimensions: 2 } },
    dataRoot: '/tmp/unused',
    vaultRoot: '/tmp/unused',
    index: fakeIndex([ROW_DENSE]),
    provider: fakeProvider(new Float64Array([1, 0]), calls),
    store: fakeStore(
      new Map([
        [ROW_LEXICAL.path, new Float64Array([0, 1])],
        [ROW_DENSE.path, new Float64Array([1, 0])],
      ]),
    ),
  })
  const lexicalTop = [lexicalHit(ROW_LEXICAL.path, 3)]
  const hits = await runtime.rank({ query: '失败之后该做什么', filters: {}, lexicalTop, limit: 3 })
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].texts, ['失败之后该做什么'])
  assert.equal(calls[0].kind, 'query')
  // The dense-only note enters, and the lexical note keeps its signals plus the fused ones.
  assert.equal(hits[0].path, ROW_DENSE.path)
  assert.equal(hits[0].signals.matchedBy, 'dense')
  assert.equal(hits[1].path, ROW_LEXICAL.path)
  // The lexical note has no dense counterpart in scope: fused rank is present, the
  // cosine score is explicitly null rather than a fabricated 0.
  assert.equal(hits[1].signals.semanticScore, null)
  assert.equal(typeof hits[1].signals.hybridRank, 'number')
  assert.equal(hits.retrievalEngine, 'hybrid')
  assert.equal(hits.denseCandidates, 1)
  assert.equal(hits.hybridFallback, null)
  // The out-of-scope lexical vector cannot contribute: candidateNotes returned only ROW_DENSE.
  assert.equal(hits.length, 2)
})

test('an empty snapshot answers lexically and starts warming once', async () => {
  let synced = 0
  const runtime = createHybridRecall({
    config: { retrievalProvider: { enabled: true, model: 'fake', dimensions: 2 } },
    dataRoot: '/tmp/unused',
    vaultRoot: '/tmp/unused',
    index: fakeIndex([ROW_LEXICAL]),
    provider: fakeProvider(new Float64Array([1, 0])),
    store: {
      async sync() {
        synced += 1
        return { batches: 1 }
      },
      snapshot: () => ({ vectors: new Map(), size: 0, generatedAt: null }),
    },
  })
  const lexicalTop = [lexicalHit(ROW_LEXICAL.path, 3)]
  const first = await runtime.rank({ query: '重试', filters: {}, lexicalTop, limit: 3 })
  assert.equal(first.hybridFallback, 'store-warming')
  assert.equal(first[0].path, ROW_LEXICAL.path)
  await runtime.warm()
  assert.equal(synced, 1)
})

test('provider and store failures become stated fallbacks, never thrown answers', async () => {
  const runtime = createHybridRecall({
    config: { retrievalProvider: { enabled: true, model: 'fake', dimensions: 2 } },
    dataRoot: '/tmp/unused',
    vaultRoot: '/tmp/unused',
    index: fakeIndex([ROW_LEXICAL]),
    provider: {
      async embed() {
        throw Object.assign(new Error('down'), { code: 'provider-response' })
      },
    },
    store: fakeStore(new Map([[ROW_LEXICAL.path, new Float64Array([0, 1])]])),
  })
  const lexicalTop = [lexicalHit(ROW_LEXICAL.path, 3)]
  const hits = await runtime.rank({ query: '重试', filters: {}, lexicalTop, limit: 3 })
  assert.equal(hits.hybridFallback, 'provider-error')
  assert.equal(hits[0].path, ROW_LEXICAL.path)

  const unreadable = createHybridRecall({
    config: { retrievalProvider: { enabled: true, model: 'fake', dimensions: 2 } },
    dataRoot: '/tmp/unused',
    vaultRoot: '/tmp/unused',
    index: fakeIndex([ROW_LEXICAL]),
    provider: fakeProvider(new Float64Array([1, 0])),
    store: fakeStore(new Map(), { snapshotError: new Error('corrupt') }),
  })
  const degraded = await unreadable.rank({ query: '重试', filters: {}, lexicalTop, limit: 3 })
  assert.equal(degraded.hybridFallback, 'store-unreadable')
})

test('warm forwards the request shape the provider contract expects', async () => {
  const calls = []
  const runtime = createHybridRecall({
    config: { retrievalProvider: { enabled: true, model: 'fake', dimensions: 2 } },
    dataRoot: '/tmp/unused',
    vaultRoot: '/tmp/unused',
    index: fakeIndex([ROW_LEXICAL]),
    provider: fakeProvider(new Float64Array([1, 0]), calls),
    store: {
      // A store whose sync calls the injected embed the way the real one does:
      // one request object with a texts array.
      sync: async (notes, embed) => {
        await embed({ texts: ['alpha', 'beta'], kind: 'passage' })
        return { batches: 1 }
      },
      snapshot: () => ({ vectors: new Map(), size: 0, generatedAt: null }),
    },
  })
  await runtime.warm()
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].texts, ['alpha', 'beta'])
  assert.equal(calls[0].kind, 'passage')
})

test('searchNotes forwards the untruncated denseQuery to the hybrid runtime', async (t) => {
  // The prompt path keeps the lexical query bounded (a pasted page is not a
  // keyword query), but the embedding does not need to be short: production
  // replay showed truncating before both channels costs 8.7pp P@3.
  const { index } = await makeVault(t, [
    { path: 'Docs/retry.md', title: '重试策略', body: '失败重试要指数退避。' },
  ])
  const calls = []
  const hybrid = {
    async rank(request) {
      calls.push(request)
      return [lexicalHit(projectPath('Docs/retry.md'), 6)]
    },
  }
  await searchNotes(index, {
    query: '重试',
    engine: 'hybrid',
    hybrid,
    denseQuery: 'the full untruncated prompt text',
    limit: 2,
  })
  assert.equal(calls[0].denseQuery, 'the full untruncated prompt text')

  await assert.rejects(
    searchNotes(index, { query: '重试', engine: 'hybrid', hybrid, denseQuery: '  ', limit: 2 }),
    (error) => error instanceof RangeError,
  )
})

test('the dense channel embeds denseQuery when the caller has a longer prompt', async () => {
  // `query` is the bounded lexical string; `denseQuery` is what the prompt path
  // judged worth embedding. The previous turn's tail is still appended, so a
  // deictic follow-up keeps its context.
  const calls = []
  const runtime = createHybridRecall({
    config: { retrievalProvider: { enabled: true, model: 'fake', dimensions: 2 } },
    dataRoot: '/tmp/unused',
    vaultRoot: '/tmp/unused',
    index: fakeIndex([ROW_DENSE]),
    provider: fakeProvider(new Float64Array([1, 0]), calls),
    store: fakeStore(new Map([[ROW_DENSE.path, new Float64Array([1, 0])]])),
  })
  const lexicalTop = [lexicalHit(ROW_LEXICAL.path, 3)]
  await runtime.rank({
    query: 'bounded query',
    denseQuery: 'the full untruncated prompt',
    context: 'previous turn',
    filters: {},
    lexicalTop,
    limit: 3,
  })
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].texts, ['the full untruncated prompt\nprevious turn'])

  calls.length = 0
  await runtime.rank({
    query: 'short question',
    filters: {},
    lexicalTop,
    limit: 3,
  })
  assert.deepEqual(calls[0].texts, ['short question'], 'no denseQuery falls back to the query')
})
