// Task 6: the memory panel's read-only route.
//
// The route's job is narrow and security-shaped: refuse anything that is not a
// same-origin loopback POST with a small JSON body, answer three read actions,
// and never expose a write. The stubs below are deliberate — the route composes
// services it is given, so these cases can drive every branch without a vault,
// while the asset cases use a real temporary file to prove the read happens per
// request (the measured bug that made a stale renderer survive a refresh).
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { PANEL_ACTIONS, registerPanelRoute } from '../lib/panel-route.js'
import { resolveScope } from '../lib/search.js'

const SESSION = 'panel-session'
const VAULT = join(homedir(), 'Documents', 'knowledge')

/** The binding the fake resolver reports. */
const BOUND = {
  kind: 'bound',
  projectId: '11111111-1111-4111-8111-111111111111',
  slug: 'alpha',
  displayName: 'alpha',
  vaultRoot: VAULT,
}

/** A stub service set: every admin and index-search call is recorded. */
function stubServices(overrides = {}) {
  const calls = { admin: [], indexForBinding: [], indexSearch: [] }
  const hits = [
    {
      path: 'Projects/alpha--11111111/Decisions/a.md',
      title: 'a',
      type: 'decision',
      status: 'active',
      source: 'body',
      snippet: 'x'.repeat(2000),
      scoreSignals: ['matched-by:fts'],
    },
  ]
  Object.defineProperty(hits, 'candidatesScored', { value: 3, enumerable: false })
  const index = {
    boundProjectId: BOUND.projectId,
    search: async (args) => {
      calls.indexSearch.push(args)
      return hits
    },
    status: () => ({
      backend: 'sqlite',
      ready: true,
      degraded: false,
      stale: false,
      scanning: false,
      notes: 5,
      lastScan: '2026-10-26T14:02:11.000Z',
      quarantined: [],
      skipped: {},
      fts: true,
    }),
    stats: async () => ({
      notes: 5,
      links: 2,
      orphans: 1,
      byType: [{ type: 'decision', n: 5 }],
      byStatus: [{ status: 'active', n: 5 }],
      updatedAt: '2026-10-26T14:02:11.000Z',
    }),
    recent: async () => [
      {
        path: 'Projects/alpha--11111111/Decisions/a.md',
        title: 'a',
        type: 'decision',
        status: 'active',
        updated: null,
      },
    ],
  }
  const services = {
    async indexForBinding(binding) {
      calls.indexForBinding.push(binding)
      return { ...index, boundProjectId: binding === null ? null : BOUND.projectId }
    },
    async admin(args) {
      calls.admin.push(args)
      if (args.action === 'jobs')
        return { action: 'jobs', result: { status: 'listed', jobs: [], failed: 0, message: null } }
      if (args.action === 'hot') {
        return {
          action: 'hot',
          result: {
            operation: 'status',
            projectId: BOUND.projectId,
            missing: false,
            used: 100,
            capacity: 9000,
            trigger: 6030,
            ratio: 0.01,
            archivable: 0,
            compactable: 0,
            moved: 0,
            folded: 0,
            reclaimed: 0,
            sections: [],
          },
        }
      }
      if (args.action === 'diagnostics')
        return {
          action: 'diagnostics',
          result: {
            window: { capacity: 200, size: 0, oldestSeq: null, newestSeq: null, dropped: 0 },
            events: [],
          },
        }
      // An unknown action falls through to the queue in the real services module.
      return { action: 'jobs', result: { status: 'listed', jobs: [], failed: 0, message: null } }
    },
    ...overrides,
  }
  return { services, calls }
}

/** One harness: a fake webServer, a real HTTP server, and a loopback fetch. */
async function harness(t, { services = stubServices().services, resolveBinding, assets } = {}) {
  const routes = new Map()
  const dispose = registerPanelRoute(
    {
      webServer: {
        register: (route) => {
          routes.set(route.path, route)
          return () => routes.delete(route.path)
        },
      },
      sessions: {
        get: (id) => (id === SESSION ? { header: { id, cwd: '/home/user/repo' } } : undefined),
      },
    },
    {
      services,
      resolveBinding: resolveBinding ?? (async () => BOUND),
      scopeOf: resolveScope,
      ...(assets === undefined ? {} : { assets }),
    },
  )
  t.after(dispose)
  const server = createServer((request, response) => {
    const route = routes.get(request.url)
    if (route === undefined) {
      response.writeHead(404)
      response.end('missing route')
      return
    }
    void route.handler(request, response)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => server.close())
  const origin = 'http://127.0.0.1:' + server.address().port
  const post = async (body, headers = {}) => {
    const response = await fetch(origin + '/obsidian-mem/panel', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
    const text = await response.text()
    let parsed = null
    try {
      parsed = JSON.parse(text)
    } catch {
      /* a non-JSON body (an unregistered route) stays null for the assertion */
    }
    return { status: response.status, bytes: Buffer.byteLength(text, 'utf8'), body: parsed }
  }
  const get = (path, headers = {}) => fetch(origin + path, { headers })
  return { routes, origin, post, get }
}

test('the route exposes the three read actions and nothing else', () => {
  assert.deepEqual([...PANEL_ACTIONS], ['overview', 'search', 'health'])
  for (const forbidden of ['bind', 'promote', 'curation', 'index', 'projects', 'digest', 'hot']) {
    assert.equal(PANEL_ACTIONS.includes(forbidden), false, forbidden + ' is not a POST action')
  }
})

test('overview composes the cards and never asks for a write action', async (t) => {
  const stub = stubServices()
  const h = await harness(t, { services: stub.services })
  const result = await h.post({ sessionId: SESSION, action: 'overview' })
  assert.equal(result.status, 200)
  assert.equal(result.body.ok, true)
  const value = result.body.value
  assert.equal(value.project.state, 'bound')
  assert.equal(value.project.projectId, BOUND.projectId)
  assert.equal(value.project.vault.basename, 'knowledge')
  assert.equal(value.project.vault.display, '~/Documents/knowledge')
  assert.equal(value.counts.notes, 5)
  assert.equal(value.health.state, 'ready')
  assert.deepEqual(value.queue, { queued: 0, failed: 0, deferred: 0 })
  assert.equal(value.recent.length, 1)
  // The digest does not exist yet; admin's fall-through must not be mistaken for one.
  assert.equal(value.digest, null)
  for (const call of stub.calls.admin)
    assert.equal(['jobs', 'hot', 'diagnostics', 'digest'].includes(call.action), true)
})

test('search reads its hasMore from the index facts and reports unbound scope', async (t) => {
  const stub = stubServices()
  const h = await harness(t, { services: stub.services })
  const result = await h.post({ sessionId: SESSION, action: 'search', query: 'binding', limit: 1 })
  assert.equal(result.status, 200)
  assert.equal(result.body.value.hasMore, true)
  assert.equal(result.body.value.limit, 1)
  assert.equal(stub.calls.indexSearch[0].query, 'binding')
  assert.equal(stub.calls.indexSearch[0].limit, 1)
  // The scope policy is resolveScope's, not a second copy in the route.
  assert.equal(stub.calls.indexSearch[0].filters.kind, 'project')
  assert.equal(stub.calls.indexSearch[0].filters.type, null)
  const empty = await h.post({ sessionId: SESSION, action: 'search', query: '   ' })
  assert.equal(empty.status, 400)
  assert.equal(empty.body.error.code, 'bad-request')
  const tooBig = await h.post({ sessionId: SESSION, action: 'search', query: 'x', limit: 51 })
  assert.equal(tooBig.status, 400)
})

test('an unbound project answers a 200 state with the refusal reason, but search needs scope all', async (t) => {
  const refused = { kind: 'unbound', reason: 'no-pointer' }
  const h = await harness(t, {
    services: stubServices().services,
    resolveBinding: async () => refused,
  })
  const overview = await h.post({ sessionId: SESSION, action: 'overview' })
  assert.equal(overview.status, 200)
  assert.deepEqual(overview.body.value.project, { state: 'unbound', reason: 'no-pointer' })
  assert.equal(overview.body.value.counts, null)
  assert.deepEqual(overview.body.value.recent, [])
  const health = await h.post({ sessionId: SESSION, action: 'health' })
  assert.equal(health.status, 200)
  assert.equal(health.body.value.health, null)
  const projectSearch = await h.post({
    sessionId: SESSION,
    action: 'search',
    query: 'x',
    scope: 'project',
  })
  assert.equal(projectSearch.status, 409)
  assert.equal(projectSearch.body.error.code, 'unbound')
  const allSearch = await h.post({ sessionId: SESSION, action: 'search', query: 'x', scope: 'all' })
  assert.equal(allSearch.status, 200)
})

test('method, fence, body cap and unknown action are refused before any read', async (t) => {
  const stub = stubServices()
  const h = await harness(t, { services: stub.services })
  const { routes, origin } = h
  assert.ok(routes.has('/obsidian-mem/panel'))
  assert.ok(routes.has('/obsidian-mem/memory-panel.js'))
  const getResponse = await h.get('/obsidian-mem/panel')
  assert.equal(getResponse.status, 405)
  const foreign = await h.post(
    { sessionId: SESSION, action: 'overview' },
    { origin: 'https://evil.example' },
  )
  assert.equal(foreign.status, 403)
  const oversized = await h.post(
    JSON.stringify({ sessionId: SESSION, action: 'overview', pad: 'x'.repeat(5000) }),
  )
  assert.equal(oversized.status, 400)
  assert.equal(oversized.body.error.code, 'bad-request')
  const unknown = await h.post({ sessionId: SESSION, action: 'digest' })
  assert.equal(unknown.status, 400)
  const noSession = await h.post({ sessionId: 'other', action: 'overview' })
  assert.equal(noSession.status, 404)
  assert.equal(noSession.body.error.code, 'session-missing')
  assert.equal(stub.calls.admin.length, 0)
  assert.equal(stub.calls.indexForBinding.length, 0)
  assert.match(origin, /^http:\/\/127\.0\.0\.1:/u)
})

test('a search answer stays inside 32 KB and says so by trimming rows', async (t) => {
  const hits = Array.from({ length: 50 }, (_, index) => ({
    path: 'Projects/alpha--11111111/Docs/note-' + index + '.md',
    // Titles are not snippet-clipped, so this is what makes the payload exceed
    // the 32 KB ceiling and forces the route to trim rows.
    title: 'note ' + index + ' ' + 't'.repeat(1000),
    type: 'doc',
    status: 'active',
    source: 'body',
    snippet: 'y'.repeat(2000),
    scoreSignals: [],
  }))
  Object.defineProperty(hits, 'candidatesScored', { value: 60, enumerable: false })
  const services = {
    async indexForBinding() {
      return { boundProjectId: BOUND.projectId, search: async () => hits }
    },
    async admin() {
      throw new Error('search must not need admin')
    },
  }
  const h = await harness(t, { services })
  const result = await h.post({ sessionId: SESSION, action: 'search', query: 'note', limit: 50 })
  assert.equal(result.status, 200)
  assert.ok(result.bytes <= 32 * 1024, 'answer is ' + result.bytes + ' bytes')
  assert.ok(result.body.value.hits.length < 50)
  assert.equal(result.body.value.hasMore, true)
})

test('the asset routes read per request and keep the same-origin fence', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'obsidian-mem-panel-asset-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = join(root, 'memory-kit.js')
  await writeFile(file, 'export const version = 1\n', 'utf8')
  const h = await harness(t, { services: stubServices().services, assets: [file] })
  const first = await h.get('/obsidian-mem/memory-kit.js')
  assert.equal(first.status, 200)
  assert.match(first.headers.get('content-type'), /javascript/u)
  assert.equal(await first.text(), 'export const version = 1\n')
  await writeFile(file, 'export const version = 2\n', 'utf8')
  const second = await h.get('/obsidian-mem/memory-kit.js')
  assert.equal(await second.text(), 'export const version = 2\n')
  const foreign = await h.get('/obsidian-mem/memory-kit.js', { origin: 'https://evil.example' })
  assert.equal(foreign.status, 403)
  const missing = await h.get('/obsidian-mem/memory-overview.js')
  assert.equal(missing.status, 404)
})

test('a status filter is applied before hasMore is decided', async (t) => {
  const hits = Array.from({ length: 50 }, (_x, index) => ({
    path: 'Projects/alpha--11111111/Decisions/' + index + '.md',
    title: 'note ' + index,
    type: 'decision',
    status: 'active',
    source: 'body',
    snippet: 'x',
    scoreSignals: [],
  }))
  Object.defineProperty(hits, 'candidatesScored', { value: 100, enumerable: false })
  let searchArgs
  const services = {
    async indexForBinding() {
      return {
        boundProjectId: BOUND.projectId,
        search: async (args) => {
          searchArgs = args
          return hits
        },
      }
    },
    async admin() {
      return { action: 'jobs', result: { jobs: [], failed: 0, deferred: 0 } }
    },
  }
  const h = await harness(t, { services })
  const result = await h.post({
    sessionId: SESSION,
    action: 'search',
    query: 'note',
    status: 'provisional',
    limit: 5,
  })
  assert.equal(result.status, 200)
  assert.equal(searchArgs.limit, 5, 'the exact predicate is applied before the requested page cap')
  assert.equal(searchArgs.filters.status, 'provisional')
  assert.equal(result.body.value.hits.length, 0)
  assert.equal(result.body.value.hasMore, true, 'rows beyond the page still exist')
})

test('overview trims its lists to stay inside the 16 KB ceiling', async (t) => {
  const byType = Array.from({ length: 500 }, (_x, index) => ({
    type: 'type-' + index + '-' + 'x'.repeat(20),
    n: index,
  }))
  const byStatus = Array.from({ length: 500 }, (_x, index) => ({
    status: 'status-' + index + '-' + 'x'.repeat(20),
    n: index,
  }))
  const recent = Array.from({ length: 50 }, (_x, index) => ({
    path: 'Projects/alpha--11111111/Decisions/' + index + '.md',
    title: 'note ' + index + ' ' + 'x'.repeat(40),
    type: 'decision',
    status: 'active',
    updated: null,
  }))
  const services = {
    async indexForBinding() {
      return {
        boundProjectId: BOUND.projectId,
        status: () => ({
          backend: 'sqlite',
          ready: true,
          degraded: false,
          stale: false,
          scanning: false,
          notes: 500,
          lastScan: null,
          quarantined: [],
          skipped: {},
          fts: true,
        }),
        stats: async () => ({
          notes: 500,
          links: 1000,
          orphans: 20,
          byType,
          byStatus,
          updatedAt: null,
        }),
        recent: async () => recent,
      }
    },
    async admin(args) {
      if (args.action === 'jobs')
        return { action: 'jobs', result: { jobs: [], failed: 0, deferred: 0 } }
      if (args.action === 'hot')
        return {
          action: 'hot',
          result: {
            missing: false,
            used: 1,
            capacity: 9,
            trigger: 6,
            ratio: 0.67,
            archivable: 0,
            compactable: 0,
            sections: [],
          },
        }
      if (args.action === 'diagnostics')
        return {
          action: 'diagnostics',
          result: {
            window: { capacity: 200, size: 0, oldestSeq: null, newestSeq: null, dropped: 0 },
            events: [],
          },
        }
      return { action: 'jobs', result: { jobs: [], failed: 0, deferred: 0 } }
    },
  }
  const h = await harness(t, { services })
  const result = await h.post({ sessionId: SESSION, action: 'overview' })
  assert.equal(result.status, 200)
  assert.ok(result.bytes <= 16 * 1024, 'overview is ' + result.bytes + ' bytes')
})

test('search measures the final UTF-8 envelope at ceiling minus one, ceiling and ceiling plus one', async (t) => {
  t.mock.method(Date, 'now', () => 1000)
  const hits = [
    {
      path: 'p',
      title: '中文"\\',
      type: 'decision',
      status: 'active',
      source: 'body',
      snippet: '',
      scoreSignals: [],
    },
  ]
  const services = {
    indexForBinding: async () => ({ boundProjectId: BOUND.projectId, search: async () => hits }),
  }
  const h = await harness(t, { services })
  const payload = { sessionId: SESSION, action: 'search', query: 'binding', limit: 1 }
  const measured = await h.post(payload)
  const prefix = hits[0].title
  for (const delta of [-1, 0, 1]) {
    hits[0].title = prefix + 'x'.repeat(32768 - measured.bytes + delta)
    const result = await h.post(payload)
    assert.equal(result.status, 200)
    assert.ok(result.bytes <= 32768, 'final response is ' + result.bytes + ' bytes')
    assert.equal(result.body.value.hits.length, delta > 0 ? 0 : 1)
    if (delta <= 0) assert.equal(result.bytes, 32768 + delta)
    else assert.equal(result.body.value.hasMore, true)
  }
})

test('a fixed-field overflow returns a bounded error after optional lists are exhausted', async (t) => {
  const h = await harness(t, {
    resolveBinding: async () => ({ ...BOUND, displayName: 'x'.repeat(100000) }),
  })
  const result = await h.post({ sessionId: SESSION, action: 'overview' })
  assert.ok(result.bytes <= 16384, 'final response is ' + result.bytes + ' bytes')
  assert.equal(result.body.ok, false)
  assert.equal(result.body.error.code, 'response-too-large')
})
