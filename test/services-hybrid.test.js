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
  const world = await makeCurationWorld(t, { config: { retrievalEngine: 'lexical' } })
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

test('the shipped default row reads lexically and says why', async (t) => {
  // 2.0.0's default is `hybrid`, but the provider ships disabled, so an
  // unconfigured row must keep reading exactly what it read before: the plain
  // lexical call, not the hybrid branch with a missing runtime. That distinction
  // is observable — the hybrid branch would widen the candidate window to
  // HYBRID_LEXICAL_LIMIT and decorate the array — and the diagnostic names the
  // state instead of leaving it implied.
  const world = await makeCurationWorld(t)
  assert.equal(world.config.retrievalEngine, 'hybrid')
  assert.equal(world.config.retrievalProvider.enabled, false)
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
  assert.ok(hits.length >= 1, 'the lexical path still answers')
  // The plain lexical result carries no hybrid bookkeeping at all.
  assert.equal(hits.retrievalEngine, undefined)
  assert.equal(hits.hybridFallback, undefined)
  const snapshot = await world.services.admin(
    { action: 'diagnostics' },
    new AbortController().signal,
    {},
  )
  const last = snapshot.result.events.filter((event) => event.event === 'search').at(-1)
  // The event reports the engine that was *asked for*, plus the reason the dense
  // half did not run. A silent downgrade to `lexical` here would hide the fact
  // that the operator's config is inert.
  assert.equal(last.engine, 'hybrid')
  assert.equal(last.fallback, 'provider-disabled')
})
