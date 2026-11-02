// Task 5: the service layer actually reaches the hybrid branch.
//
// `test/hybrid-recall.test.js` proves the orchestrator in isolation; this file
// proves `services.search` selects it when `retrievalEngine` is `hybrid` and the
// provider is enabled — the wiring a config edit can silently break while every
// unit test stays green. The endpoint points at a closed loopback port so the
// background warm fails fast without a server: the observable is the *fallback*
// path and its diagnostic, not a successful embedding call.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { makeCurationWorld } from './curation-world.js'

/** @type {object} */
const HYBRID_CONFIG = {
  retrievalEngine: 'hybrid',
  retrievalProvider: {
    enabled: true,
    endpoint: 'http://127.0.0.1:1',
    model: 'test-model',
    dimensions: 2,
    timeoutMs: 100,
  },
}

test('services.search runs the hybrid branch when configured for it', async (t) => {
  const world = await makeCurationWorld(t, { config: HYBRID_CONFIG })
  // The first write binds the repository (spec §5.2.3) and lands one note.
  await world.services.write({
    type: 'decision',
    title: '缓存失效策略',
    body: '缓存失效后重新计算。',
  })
  const hits = await world.services.search(
    { query: '重新计算后的缓存' },
    new AbortController().signal,
    {},
  )
  assert.ok(Array.isArray(hits))
  assert.ok(hits.length >= 1, 'the lexical half still returns the note')

  const snapshot = await world.services.admin(
    { action: 'diagnostics' },
    new AbortController().signal,
    {},
  )
  const search = snapshot.result.events.filter((event) => event.event === 'search')
  assert.ok(search.length >= 1, 'search records a diagnostic event')
  const last = search.at(-1)
  assert.equal(last.engine, 'hybrid')
  // The store has never been written and the provider is unreachable: the first
  // search must say so in one token and still return lexical results.
  assert.equal(last.fallback, 'store-warming')
  assert.equal(last.denseCandidates, 0)
  assert.ok(last.ms >= 0)
})

test('a lexical engine config never mounts a hybrid runtime', async (t) => {
  const world = await makeCurationWorld(t)
  await world.services.write({
    type: 'decision',
    title: '缓存失效策略',
    body: '缓存失效后重新计算。',
  })
  const hits = await world.services.search(
    { query: '重新计算后的缓存' },
    new AbortController().signal,
    {},
  )
  assert.ok(hits.length >= 1)
  const snapshot = await world.services.admin(
    { action: 'diagnostics' },
    new AbortController().signal,
    {},
  )
  const last = snapshot.result.events.filter((event) => event.event === 'search').at(-1)
  assert.equal(last.engine, 'lexical')
  assert.equal(last.fallback, undefined)
})
