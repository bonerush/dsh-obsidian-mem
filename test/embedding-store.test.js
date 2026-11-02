import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import test from 'node:test'

import {
  EmbeddingStoreError,
  embeddingStorePath,
  openEmbeddingStore,
} from '../lib/embedding-store.js'

/**
 * Build one candidate note shaped like index.candidateNotes output. The store
 * embeds title + newline + body, so these fields are the real input.
 */
function note(path, hash, title, body) {
  return {
    path,
    hash,
    title,
    body,
    type: 'gotcha',
    status: 'active',
    updated: '2026-11-02',
    project: null,
  }
}

/** A fake provider.embed that records requests and returns deterministic vectors. */
function fakeEmbed(dimensions = 4) {
  const calls = []
  const embed = async ({ texts, kind }) => {
    calls.push({ texts: [...texts], kind })
    return {
      model: 'fake-model',
      dimensions,
      vectors: texts.map((text) => {
        // Deterministic but text-dependent: a changed text changes the vector.
        const seed = [...text].reduce((sum, char) => (sum + char.codePointAt(0)) % 97, 0)
        return Array.from({ length: dimensions }, (_, index) => (seed + index + 1) / 100)
      }),
    }
  }
  embed.calls = calls
  return embed
}

async function makeStore(t) {
  const dataRoot = await fs.mkdtemp(join(tmpdir(), 'embedding-store-test-'))
  t.after(() => fs.rm(dataRoot, { recursive: true, force: true }))
  const vaultRoot = join(dataRoot, 'vault')
  await fs.mkdir(vaultRoot, { recursive: true })
  const store = await openEmbeddingStore({
    dataRoot,
    vaultRoot,
    model: 'fake-model',
    dimensions: 4,
  })
  return { store, embed: fakeEmbed(), dataRoot, vaultRoot }
}

test('sync embeds every note once and writes a versioned file', async (t) => {
  const { store, embed } = await makeStore(t)
  const notes = [
    note('Projects/p/A.md', 'h1', '甲', '第一条正文'),
    note('Projects/p/B.md', 'h2', '乙', '第二条正文'),
    note('Projects/p/C.md', 'h3', '丙', '第三条正文'),
  ]
  const result = await store.sync(notes, embed)
  assert.deepEqual(result, { embedded: 3, reused: 0, pruned: 0, total: 3, batches: 1 })
  assert.equal(embed.calls.length, 1)
  assert.equal(embed.calls[0].kind, 'passage', 'note embeddings are passages, not queries')
  assert.equal(
    embed.calls[0].texts[0],
    '甲\n第一条正文',
    'title plus newline plus body, the offline convention',
  )

  const file = JSON.parse(await fs.readFile(store.path, 'utf8'))
  assert.equal(file.version, 1)
  assert.equal(file.model, 'fake-model')
  assert.equal(file.dimensions, 4)
  assert.equal(typeof file.vaultRootHash, 'string')
  assert.deepEqual(Object.keys(file.vectors).sort(), [
    'Projects/p/A.md',
    'Projects/p/B.md',
    'Projects/p/C.md',
  ])
  assert.equal(file.vectors['Projects/p/A.md'].length, 4)
  assert.equal(file.hashes['Projects/p/A.md'], 'h1')
})

test('a second sync embeds only the changed note and reuses the rest', async (t) => {
  const { store, embed } = await makeStore(t)
  const notes = [
    note('Projects/p/A.md', 'h1', '甲', '第一条正文'),
    note('Projects/p/B.md', 'h2', '乙', '第二条正文'),
  ]
  await store.sync(notes, embed)
  assert.equal(embed.calls.length, 1)

  const edited = [notes[0], note('Projects/p/B.md', 'h2-new', '乙', '第二条正文改过')]
  const result = await store.sync(edited, embed)
  assert.deepEqual(result, { embedded: 1, reused: 1, pruned: 0, total: 2, batches: 1 })
  assert.equal(embed.calls.length, 2)
  assert.deepEqual(embed.calls[1].texts, ['乙\n第二条正文改过'])

  const unchanged = await store.sync(edited, embed)
  assert.deepEqual(unchanged, { embedded: 0, reused: 2, pruned: 0, total: 2, batches: 0 })
  assert.equal(embed.calls.length, 2, 'an unchanged vault makes zero provider calls')
})

test('a removed note is pruned from the store on the next sync', async (t) => {
  const { store, embed } = await makeStore(t)
  await store.sync(
    [note('Projects/p/A.md', 'h1', '甲', '一'), note('Projects/p/B.md', 'h2', '乙', '二')],
    embed,
  )
  const result = await store.sync([note('Projects/p/A.md', 'h1', '甲', '一')], embed)
  assert.deepEqual(result, { embedded: 0, reused: 1, pruned: 1, total: 1, batches: 0 })
  const file = JSON.parse(await fs.readFile(store.path, 'utf8'))
  assert.deepEqual(Object.keys(file.vectors), ['Projects/p/A.md'])
})

test('a corrupt file is rebuilt, never merged', async (t) => {
  const { store, embed } = await makeStore(t)
  await fs.mkdir(join(store.path, '..'), { recursive: true })
  await fs.writeFile(store.path, '{not json', 'utf8')
  const result = await store.sync([note('Projects/p/A.md', 'h1', '甲', '一')], embed)
  assert.deepEqual(result, { embedded: 1, reused: 0, pruned: 0, total: 1, batches: 1 })
  const file = JSON.parse(await fs.readFile(store.path, 'utf8'))
  assert.deepEqual(Object.keys(file.vectors), ['Projects/p/A.md'])
})

test('a finite but unusable vector rebuilds the note instead of trusting the file', async (t) => {
  const { store, embed } = await makeStore(t)
  await store.sync([note('Projects/p/A.md', 'h1', '甲', '一')], embed)
  const file = JSON.parse(await fs.readFile(store.path, 'utf8'))
  file.vectors['Projects/p/A.md'] = [1, 2]
  await fs.writeFile(store.path, JSON.stringify(file), 'utf8')
  const result = await store.sync([note('Projects/p/A.md', 'h1', '甲', '一')], embed)
  assert.deepEqual(result, { embedded: 1, reused: 0, pruned: 0, total: 1, batches: 1 })
})

test('a different model or dimension starts an empty store', async (t) => {
  const { dataRoot, vaultRoot, embed } = await makeStore(t)
  const first = await openEmbeddingStore({
    dataRoot,
    vaultRoot,
    model: 'fake-model',
    dimensions: 4,
  })
  await first.sync([note('Projects/p/A.md', 'h1', '甲', '一')], embed)

  const otherModel = await openEmbeddingStore({
    dataRoot,
    vaultRoot,
    model: 'other-model',
    dimensions: 4,
  })
  assert.notEqual(otherModel.path, first.path, 'the model tag names the file')
  const otherResult = await otherModel.sync([note('Projects/p/A.md', 'h1', '甲', '一')], embed)
  assert.deepEqual(otherResult, { embedded: 1, reused: 0, pruned: 0, total: 1, batches: 1 })

  const otherDimensions = await openEmbeddingStore({
    dataRoot,
    vaultRoot,
    model: 'fake-model',
    dimensions: 8,
  })
  assert.notEqual(otherDimensions.path, first.path, 'the dimension tag names the file')
})

test('a store file with a mismatched header is not trusted', async (t) => {
  const { store, embed, dataRoot, vaultRoot } = await makeStore(t)
  await store.sync([note('Projects/p/A.md', 'h1', '甲', '一')], embed)
  const file = JSON.parse(await fs.readFile(store.path, 'utf8'))
  file.dimensions = 99
  await fs.writeFile(store.path, JSON.stringify(file), 'utf8')
  const reopened = await openEmbeddingStore({
    dataRoot,
    vaultRoot,
    model: 'fake-model',
    dimensions: 4,
  })
  const result = await reopened.sync([note('Projects/p/A.md', 'h1', '甲', '一')], embed)
  assert.deepEqual(result, { embedded: 1, reused: 0, pruned: 0, total: 1, batches: 1 })
})

test('text is truncated to 1200 code points before it reaches the provider', async (t) => {
  const { store, embed } = await makeStore(t)
  await store.sync([note('Projects/p/A.md', 'h1', '', '字'.repeat(2000))], embed)
  const text = embed.calls[0].texts[0]
  assert.equal([...text].length, 1200)
})

test('the provider is called in batches of at most sixteen texts', async (t) => {
  const { store, embed } = await makeStore(t)
  const notes = Array.from({ length: 17 }, (_, index) =>
    note('Projects/p/' + index + '.md', 'h' + index, '标题' + index, '正文' + index),
  )
  const result = await store.sync(notes, embed)
  assert.deepEqual(result, { embedded: 17, reused: 0, pruned: 0, total: 17, batches: 2 })
  assert.deepEqual(
    embed.calls.map((call) => call.texts.length),
    [16, 1],
  )
})

test('a timed-out batch is bisected until each slice answers', async (t) => {
  const { store } = await makeStore(t)
  const notes = Array.from({ length: 4 }, (_, index) =>
    note('Projects/p/' + index + '.md', 'h' + index, '标题' + index, '正文' + index),
  )
  const base = fakeEmbed()
  const calls = []
  const embed = async (request) => {
    calls.push(request.texts.length)
    if (request.texts.length > 2) {
      const error = new Error('deadline')
      error.code = 'provider-timeout'
      throw error
    }
    return base(request)
  }
  const result = await store.sync(notes, embed)
  assert.deepEqual(result, { embedded: 4, reused: 0, pruned: 0, total: 4, batches: 2 })
  assert.deepEqual(calls, [4, 2, 2], 'the timeout costs one probe, then two halves answer')
  const snapshot = await store.snapshot()
  assert.equal(snapshot.size, 4, 'every note is stored even though the first batch timed out')
})

test('a timeout on a single text is reported, not retried forever', async (t) => {
  const { store } = await makeStore(t)
  const calls = []
  const failing = async (request) => {
    calls.push(request.texts.length)
    const error = new Error('deadline')
    error.code = 'provider-timeout'
    throw error
  }
  const notes = [
    note('Projects/p/A.md', 'h1', '甲', '一'),
    note('Projects/p/B.md', 'h2', '乙', '二'),
  ]
  await assert.rejects(
    store.sync(notes, failing),
    (error) => error instanceof EmbeddingStoreError && error.code === 'provider-timeout',
  )
  assert.deepEqual(calls, [2, 1], 'one probe, then the first single text fails')
  await assert.rejects(fs.readFile(store.path, 'utf8'))
})

test('a finished sync leaves no temporary files behind', async (t) => {
  const { store, embed } = await makeStore(t)
  await store.sync([note('Projects/p/A.md', 'h1', '甲', '一')], embed)
  const entries = await fs.readdir(join(store.path, '..'))
  assert.deepEqual(entries, [basename(store.path)])
})

test('a provider failure leaves the previous file intact and names the failure', async (t) => {
  const { store, embed } = await makeStore(t)
  await store.sync([note('Projects/p/A.md', 'h1', '甲', '一')], embed)
  const before = await fs.readFile(store.path, 'utf8')
  const failing = async () => {
    const error = new Error('provider-unreachable')
    error.code = 'provider-unreachable'
    throw error
  }
  await assert.rejects(
    store.sync([note('Projects/p/B.md', 'h2', '乙', '二')], failing),
    (error) => error instanceof EmbeddingStoreError && error.code === 'provider-unreachable',
  )
  assert.equal(await fs.readFile(store.path, 'utf8'), before)
})

test('snapshot exposes vectors by path and reloads after an external write', async (t) => {
  const { store, embed } = await makeStore(t)
  await store.sync([note('Projects/p/A.md', 'h1', '甲', '一')], embed)
  const snapshot = await store.snapshot()
  const vector = snapshot.vectors.get('Projects/p/A.md')
  assert.equal(vector.length, 4)
  assert.equal(snapshot.size, 1)

  await store.sync(
    [note('Projects/p/A.md', 'h1', '甲', '一'), note('Projects/p/B.md', 'h2', '乙', '二')],
    embed,
  )
  const refreshed = await store.snapshot()
  assert.equal(refreshed.size, 2)
})

test('embeddingStorePath is deterministic and vault-scoped', async (t) => {
  const dataRoot = await fs.mkdtemp(join(tmpdir(), 'embedding-store-path-'))
  t.after(() => fs.rm(dataRoot, { recursive: true, force: true }))
  const vaultA = join(dataRoot, 'vault-a')
  const vaultB = join(dataRoot, 'vault-b')
  await fs.mkdir(vaultA)
  await fs.mkdir(vaultB)
  const options = { dataRoot, model: 'm', dimensions: 384 }
  const pathA = embeddingStorePath({ ...options, vaultRoot: vaultA })
  const pathAgain = embeddingStorePath({ ...options, vaultRoot: vaultA })
  const pathB = embeddingStorePath({ ...options, vaultRoot: vaultB })
  assert.equal(pathA, pathAgain)
  assert.notEqual(pathA, pathB)
  assert.match(pathA, /embeddings-[0-9a-f]{16}-[0-9a-f]{16}-384\.json$/)
})
