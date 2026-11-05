import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { validateConfig } from '../lib/config.js'
import { embeddingStorePath, openEmbeddingStore } from '../lib/embedding-store.js'
import { openIndex } from '../lib/index-db.js'
import { createMemoryServices } from '../lib/services.js'

const PROJECT_ID = '9a8b7c6d-5e4f-4a3b-2c1d-0e9f8a7b6c5d'
const PROJECT_DIR = 'Projects/semantic'
const pathOf = (relative) => `${PROJECT_DIR}/${relative}`

function renderNote(title, body) {
  return [
    '---',
    'type: "doc"',
    `title: ${JSON.stringify(title)}`,
    'status: "active"',
    `project: "${PROJECT_ID}"`,
    '---',
    '',
    `# ${title}`,
    '',
    body,
    '',
  ].join('\n')
}

async function makeServices(t, configOverrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'obsidian-mem-semantic-service-'))
  let vault = join(root, 'vault')
  const dataRoot = join(root, 'data')
  await mkdir(dataRoot, { recursive: true })
  await mkdir(join(vault, ...PROJECT_DIR.split('/')), { recursive: true })
  vault = await realpath(vault)
  await writeFile(
    join(vault, ...pathOf('retry.md').split('/')),
    renderNote('重试策略', '失败重试要指数退避。'),
  )
  await writeFile(
    join(vault, ...pathOf('backoff.md').split('/')),
    renderNote('退避', '指数退避公式。'),
  )
  await writeFile(
    join(vault, ...pathOf('vector.md').split('/')),
    renderNote('向量检索', '把查询投影到同一组基。'),
  )
  const index = await openIndex({
    vaultRoot: vault,
    dataRoot,
    backend: 'sqlite',
    projectId: PROJECT_ID,
  })
  t.after(() => index.close().catch(() => {}))
  await index.waitReady(undefined, 10_000)
  const config = validateConfig({
    vaultPath: vault,
    enabled: true,
    retrievalEngine: 'hybrid',
    retrievalProvider: {
      enabled: true,
      endpoint: 'http://127.0.0.1:8790',
      model: 'fake',
      dimensions: 4,
      timeoutMs: 50,
    },
    ...configOverrides,
  })
  const rows = await index.candidateNotes({ kind: 'all', excludeStatuses: [], type: null })
  const store = await openEmbeddingStore({
    dataRoot,
    vaultRoot: vault,
    model: 'fake',
    dimensions: 4,
  })
  await store.sync(rows, async ({ texts }) => ({
    model: 'fake',
    dimensions: 4,
    // Three notes so the centered cloud has two non-zero principal axes; a
    // two-note fixture is always collinear and correctly reports degeneracy.
    vectors: texts.map((text) =>
      text.includes('重试策略')
        ? [1, 0, 0, 0]
        : text.includes('退避')
          ? [0.9, 0.2, 0, 0]
          : [0, 0, 1, 0],
    ),
  }))
  const binding = { kind: 'bound', projectId: PROJECT_ID, projectPath: PROJECT_DIR, cwd: vault }
  return {
    root,
    vault,
    dataRoot,
    config,
    index,
    binding,
    storePath: embeddingStorePath({ dataRoot, vaultRoot: vault, model: 'fake', dimensions: 4 }),
  }
}

test('semanticMap reads the store, marks readiness and quantizes points', async (t) => {
  const fixture = await makeServices(t)
  const services = createMemoryServices({
    config: fixture.config,
    dataRoot: fixture.dataRoot,
    cwd: fixture.vault,
    binding: fixture.binding,
  })
  t.after(() => services.close?.())
  const map = await services.semanticMap()
  assert.equal(map.state, 'ready')
  assert.equal(map.count, 3)
  assert.equal(map.state === 'ready' ? map.points.length : 0, 3)
  for (const [, x, y] of map.points)
    assert.ok(Number.isInteger(x) && x >= 0 && x <= 4095 && Number.isInteger(y))
  assert.match(map.mapKey, /^\d+-\d+-3$/)
})

test('search records a tool trace and explain replays through the same pipeline', async (t) => {
  const fixture = await makeServices(t)
  const trace = {
    queryVector: Float32Array.from([1, 0, 0, 0]),
    guard: false,
    fallback: null,
    denseCandidates: 2,
    embedMs: 3,
    lexicalTop: [{ path: pathOf('retry.md'), rank: 1 }],
    denseTop: [{ path: pathOf('backoff.md'), rank: 1, score: 0.9 }],
    fusedTop: [
      {
        path: pathOf('retry.md'),
        source: 'lexical',
        lexicalRank: 1,
        denseRank: null,
        semanticScore: null,
        hybridRank: 1,
        lexicalHit: true,
      },
      {
        path: pathOf('backoff.md'),
        source: 'dense',
        lexicalRank: null,
        denseRank: 1,
        semanticScore: 0.9,
        hybridRank: 2,
        lexicalHit: false,
      },
    ],
  }
  const hybrid = {
    async rank({ lexicalTop, limit }) {
      const hits = lexicalTop
        .slice(0, limit)
        .map((hit) => ({ ...hit, signals: { ...hit.signals, semanticScore: 0.9, hybridRank: 1 } }))
      Object.defineProperty(hits, 'hybridTrace', { value: trace, enumerable: false })
      Object.defineProperties(hits, {
        denseCandidates: { value: 2, enumerable: false },
        embedMs: { value: 3, enumerable: false },
        hybridFallback: { value: null, enumerable: false },
      })
      return hits
    },
  }
  const services = createMemoryServices({
    config: fixture.config,
    dataRoot: fixture.dataRoot,
    cwd: fixture.vault,
    binding: fixture.binding,
    hybrid,
  })
  const exec = { agent: { session: { header: { id: 'session-a', cwd: fixture.vault } } } }
  await services.search({ query: '重试' }, undefined, exec)
  const recalled = await services.recallSince('session-a', 0)
  assert.equal(recalled.events.length, 1)
  assert.equal(recalled.events[0].source, 'tool')
  assert.deepEqual(recalled.events[0].query, {
    text: '重试',
    x: recalled.events[0].query.x,
    y: recalled.events[0].query.y,
  })
  const explained = await services.explainSearch({
    binding: fixture.binding,
    query: '退避 重复',
    sessionId: 'session-a',
  })
  assert.equal(explained.source, 'panel')
  assert.equal(explained.fused[1].lexicalHit, false)
  // The trace query is projected into the same 0..1000 world square the client
  // decodes the map into; a unit-square 0..1 value would draw the query point at
  // the origin while every note sits a thousand units away.
  assert.ok(Number.isFinite(explained.query.x) && Number.isFinite(explained.query.y))
  assert.ok(explained.query.x >= 0 && explained.query.x <= 1000)
  assert.ok(explained.query.y >= 0 && explained.query.y <= 1000)
  assert.ok(Math.max(explained.query.x, explained.query.y) > 1)
  const map = await services.semanticMap()
  const retryMapPoint = new Map(
    map.points.map(([path, x, y]) => [path, { x: (x / 4095) * 1000, y: (y / 4095) * 1000 }]),
  ).get(pathOf('retry.md'))
  assert.ok(retryMapPoint !== undefined)
  assert.ok(Math.abs(explained.query.x - retryMapPoint.x) <= 1)
  assert.ok(Math.abs(explained.query.y - retryMapPoint.y) <= 1)
  const neighbors = await services.semanticNeighbors({ path: pathOf('retry.md') })
  assert.equal(neighbors.state, 'ready')
  assert.equal(neighbors.neighbors[0].path, pathOf('backoff.md'))
})

test('a disabled provider reports unavailable instead of pretending', async (t) => {
  const fixture = await makeServices(t, { retrievalProvider: { enabled: false } })
  const services = createMemoryServices({
    config: fixture.config,
    dataRoot: fixture.dataRoot,
    cwd: fixture.vault,
    binding: fixture.binding,
  })
  assert.deepEqual(await services.semanticMap(), {
    state: 'unavailable',
    reason: 'provider-disabled',
    count: 0,
    total: 0,
    explained: 0,
    generatedAt: null,
    mapKey: null,
    points: [],
  })
  assert.deepEqual(await services.recallSince('nobody'), { cursor: 0, events: [] })
})
