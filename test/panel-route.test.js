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
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createPreviewTokens } from '../lib/panel-actions.js'
import {
  PANEL_ACTIONS,
  PANEL_HEADER,
  PANEL_HEADER_VALUE,
  PANEL_REFRESH_INTERVAL_MS,
  registerPanelRoute,
} from '../lib/panel-route.js'
import { resolveScope } from '../lib/search.js'

const SESSION = 'panel-session'
const VAULT = join(homedir(), 'Documents', 'knowledge')

/** The binding the fake resolver reports. */
const BOUND = {
  kind: 'bound',
  projectId: '11111111-1111-4111-8111-111111111111',
  slug: 'alpha',
  displayName: 'alpha',
  schema: 1,
  vaultRoot: VAULT,
  relativeDir: 'Projects/alpha--11111111',
}
const OTHER_PROJECT_ID = '22222222-2222-4222-8222-222222222222'
const JOB_ID = 'job-0123456789abcdef0123456789abcdef'
const SESSION_TWO = 'panel-session-2'

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
      flow: [{ type: 'decision', status: 'active', n: 5 }],
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
async function harness(
  t,
  { services = stubServices().services, resolveBinding, assets, previewTokens, now } = {},
) {
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
        get: (id) =>
          id === SESSION || id === SESSION_TWO
            ? { header: { id, cwd: '/home/user/repo' } }
            : undefined,
      },
    },
    {
      services,
      resolveBinding: resolveBinding ?? (async () => BOUND),
      scopeOf: resolveScope,
      ...(assets === undefined ? {} : { assets }),
      ...(previewTokens === undefined ? {} : { previewTokens }),
      ...(now === undefined ? {} : { now }),
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
  // The 构成 Sankey's joint type×status links ride the wire untouched: the route
  // is a projection, never a second place that could re-derive the joint counts.
  assert.deepEqual(value.counts.flow, [{ type: 'decision', status: 'active', n: 5 }])
  assert.equal(value.health.state, 'ready')
  assert.deepEqual(value.queue, { queued: 0, failed: 0, deferred: 0, failedJobs: [] })
  assert.equal(value.recent.length, 1)
  // The digest is feature-detected: the stub has no digest action, so the card
  // is absent and the fall-through answer is not mistaken for one.
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
  // 健康 answers the same unbound identity 概览 does, so switching tabs never
  // changes what the header says the project is.
  assert.deepEqual(health.body.value.project, { state: 'unbound', reason: 'no-pointer' })
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
  // 503, never 404: the browser asset treats 404 as "the route was not registered"
  // and shows the fatal restart notice, so an unresolvable session (a resumed
  // session racing the panel's first poll) must be a retryable unavailability.
  assert.equal(noSession.status, 503)
  assert.equal(noSession.body.error.code, 'session-missing')
  assert.equal(noSession.body.error.message, 'memory panel unavailable')
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

test('a vault root outside the home directory keeps a POSIX display and a native-root basename', async (t) => {
  // The display string is rendered as text in the browser, so a native Windows
  // separator must never leave the route. The masked-home path is covered by the
  // overview case; this one is the unmasked branch, and it also proves `basename`
  // still reads the native root (normalizing the root first would break the last
  // segment on POSIX).
  const nativeRoot = process.platform === 'win32' ? 'D:\\vaults\\knowledge' : '/srv/knowledge'
  const expected = process.platform === 'win32' ? 'D:/vaults/knowledge' : '/srv/knowledge'
  const h = await harness(t, {
    services: stubServices().services,
    resolveBinding: async () => ({ ...BOUND, vaultRoot: nativeRoot }),
  })
  const result = await h.post({ sessionId: SESSION, action: 'overview' })
  assert.equal(result.status, 200)
  const vault = result.body.value.project.vault
  assert.equal(vault.display, expected, 'the display is a POSIX path')
  assert.equal(vault.display.includes('\\'), false, 'the display carries no native separator')
  assert.equal(vault.basename, 'knowledge', 'the basename runs on the native root')
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

test('the shipped module-relative asset and a native absolute asset path both serve', async (t) => {
  // A Windows drive letter reads as a URL scheme in `new URL(file, import.meta.url)`, so
  // the route has to send a native absolute path through `pathToFileURL`. Both branches
  // are pinned: an injected temp file (absolute) and the shipped default (relative).
  const root = await mkdtemp(join(tmpdir(), 'obsidian-mem-panel-native-asset-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const native = join(root, 'memory-kit.js')
  await writeFile(native, 'export const version = 7\n', 'utf8')
  const injected = await harness(t, { services: stubServices().services, assets: [native] })
  const served = await injected.get('/obsidian-mem/memory-kit.js')
  assert.equal(served.status, 200, 'a native absolute asset path is served')
  assert.match(served.headers.get('content-type'), /javascript/u)
  assert.equal(await served.text(), 'export const version = 7\n')
  const shipped = await harness(t, { services: stubServices().services })
  const panel = await shipped.get('/obsidian-mem/memory-panel.js')
  assert.equal(panel.status, 200, 'the module-relative default is served')
  const source = await readFile(new URL('../lib/memory-panel.js', import.meta.url), 'utf8')
  assert.equal(await panel.text(), source, 'the default asset is served byte for byte')
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
  // A full page with zero matching rows is NOT "more": the 显示更多 button would
  // re-request the same page and yield nothing. `candidatesScored` counts rows
  // the filter may reject, so it cannot promise more matches.
  assert.equal(result.body.value.hasMore, false, 'no matching row means no more to show')

  // But rows the filter kept beyond the visible window do prove more.
  const mixed = Array.from({ length: 50 }, (_x, index) => ({
    path: 'Projects/alpha--11111111/Decisions/m-' + index + '.md',
    title: 'note ' + index,
    type: 'decision',
    status: index < 10 ? 'provisional' : 'active',
    source: 'body',
    snippet: 'x',
    scoreSignals: [],
  }))
  Object.defineProperty(mixed, 'candidatesScored', { value: 100, enumerable: false })
  const mixedServices = {
    async indexForBinding() {
      return {
        boundProjectId: BOUND.projectId,
        search: async () => mixed,
      }
    },
    async admin() {
      return { action: 'jobs', result: { jobs: [], failed: 0, deferred: 0 } }
    },
  }
  const h2 = await harness(t, { services: mixedServices })
  const more = await h2.post({
    sessionId: SESSION,
    action: 'search',
    query: 'note',
    status: 'provisional',
    limit: 5,
  })
  assert.equal(more.status, 200)
  assert.equal(more.body.value.hits.length, 5)
  assert.equal(more.body.value.hasMore, true, 'kept rows beyond the window prove more')
})

test('overview trims its lists to stay inside the 20 KB ceiling', async (t) => {
  const byType = Array.from({ length: 500 }, (_x, index) => ({
    type: 'type-' + index + '-' + 'x'.repeat(20),
    n: index,
  }))
  const byStatus = Array.from({ length: 500 }, (_x, index) => ({
    status: 'status-' + index + '-' + 'x'.repeat(20),
    n: index,
  }))
  const flow = Array.from({ length: 500 }, (_x, index) => ({
    type: 'type-' + index + '-' + 'x'.repeat(20),
    status: 'status-' + index + '-' + 'x'.repeat(20),
    n: 1,
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
          flow,
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
  assert.ok(result.bytes <= 20 * 1024, 'overview is ' + result.bytes + ' bytes')
  // The padded flow is over the ceiling on its own, so it is dropped whole; a
  // halved flow would leave a Sankey whose links disagree with the printed totals.
  assert.deepEqual(result.body.value.counts.flow, [], 'flow is dropped whole')
})

// ---------------------------------------------------------------------------
// Task 2: the 概览 chart aggregates (activity + tag frequencies)
// ---------------------------------------------------------------------------

/** The local calendar days a window of `days` covers, oldest first. */
function localDays(days) {
  const pad = (value) => String(value).padStart(2, '0')
  const today = new Date()
  const list = []
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset)
    list.push(`${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`)
  }
  return list
}

/** An activity series of `days` days, every bucket zero, oldest first. */
function activitySeries(days, fill = 0) {
  const list = localDays(days)
  return {
    from: list[0],
    to: list[list.length - 1],
    days: list,
    created: list.map((_day, position) => (position + fill) % 4),
    updated: list.map((_day, position) => (position + fill) % 6),
  }
}

test('overview carries the chart aggregates and asks for the route-driven window', async (t) => {
  const calls = {}
  const base = stubServices()
  const services = {
    ...base.services,
    async indexForBinding() {
      return {
        boundProjectId: BOUND.projectId,
        status: () => ({
          backend: 'sqlite',
          ready: true,
          degraded: false,
          stale: false,
          scanning: false,
          notes: 5,
          lastScan: null,
          quarantined: [],
          skipped: {},
          fts: true,
        }),
        stats: async () => ({
          notes: 5,
          links: 2,
          orphans: 1,
          byType: [],
          byStatus: [],
          updatedAt: null,
        }),
        activity: async (args) => {
          calls.activity = args
          return activitySeries(84, 1)
        },
        tagFrequencies: async (args) => {
          calls.tags = args
          return { items: [{ tag: 'dsh-mem/decision', n: 3 }], total: 4, distinct: 2 }
        },
        recent: async () => [],
      }
    },
  }
  const h = await harness(t, { services })
  const result = await h.post({ sessionId: SESSION, action: 'overview' })
  assert.equal(result.status, 200)
  const value = result.body.value
  assert.deepEqual(calls.activity, { scope: 'project', days: 84 })
  // 24 is the treemap's page: it draws area-proportional tiles plus a tail row, so
  // the old twelve rows would have shown the same short head twice. `distinct` (not
  // this page size) is what still carries the real remainder.
  assert.deepEqual(calls.tags, { scope: 'project', limit: 24 })
  assert.equal(value.activity.days.length, 84, 'a twelve-week calendar, per design §3.3')
  assert.equal(value.activity.from, value.activity.days[0])
  assert.equal(value.activity.to, value.activity.days[83])
  assert.equal(value.activity.created.length, 84)
  assert.equal(value.activity.updated.length, 84)
  // `distinct` rides through untouched: the route is a projection, not a second
  // place that could derive the tag count differently.
  assert.deepEqual(value.tags, {
    items: [{ tag: 'dsh-mem/decision', n: 3 }],
    total: 4,
    distinct: 2,
  })
  // Both series are integers: the panel formats them, the route never ships text.
  for (const n of [...value.activity.created, ...value.activity.updated])
    assert.equal(Number.isInteger(n), true)
  for (const item of value.tags.items) assert.equal(Number.isInteger(item.n), true)
})

test('overview reads the activity window the client asks for, inside the route bound', async (t) => {
  // A wide panel asks for the whole year (53 weeks, 371 days) so its fixed GitHub-style
  // heat map can fill the body; the route is the bound on that ask, because the 20 KB
  // ceiling and the index's own 371-day limit are both behind it. Absent, malformed or
  // out-of-range values fall back to the designed twelve weeks instead of failing the read.
  const calls = []
  const base = stubServices()
  const services = {
    ...base.services,
    async indexForBinding() {
      return {
        boundProjectId: BOUND.projectId,
        status: () => ({
          backend: 'sqlite',
          ready: true,
          degraded: false,
          stale: false,
          scanning: false,
          notes: 3,
          lastScan: null,
          quarantined: [],
          skipped: {},
          fts: true,
        }),
        stats: async () => ({
          notes: 3,
          links: 0,
          orphans: 0,
          byType: [],
          byStatus: [],
          updatedAt: null,
        }),
        activity: async (args) => {
          calls.push(args)
          return activitySeries(args.days, 1)
        },
        tagFrequencies: async () => ({ items: [], total: 0 }),
        recent: async () => [],
      }
    },
  }
  const h = await harness(t, { services })
  const read = async (days) =>
    h.post(
      days === undefined
        ? { sessionId: SESSION, action: 'overview' }
        : { sessionId: SESSION, action: 'overview', days },
    )

  const wide = await read(371)
  assert.equal(wide.status, 200)
  assert.deepEqual(calls.at(-1), { scope: 'project', days: 371 })
  assert.equal(wide.body.value.activity.days.length, 371, 'the wire carries the whole window')
  assert.ok(wide.bytes <= 20 * 1024, 'the wide window still fits the ceiling: ' + wide.bytes)

  // Past the bound clamps to 53 weeks (it does not fail, and it does not grow).
  await read(500)
  assert.deepEqual(calls.at(-1), { scope: 'project', days: 371 }, 'a request past the bound clamps')
  // Below the design window falls back to the twelve weeks the charts are designed on.
  await read(28)
  assert.deepEqual(calls.at(-1), { scope: 'project', days: 84 }, 'a short request falls back')
  await read('371')
  assert.deepEqual(calls.at(-1), { scope: 'project', days: 84 }, 'a non-integer falls back')
  await read()
  assert.deepEqual(calls.at(-1), { scope: 'project', days: 84 }, 'absent means the design window')
})

test('an index build without the joint flow still answers overview', async (t) => {
  // The panel asset and the host plugin upgrade independently. An older index
  // build returns the two margins without the joint counts; the route must pass
  // the absence through (the view then falls back to its bar) instead of failing
  // the whole 概览 read or inventing a flow.
  const base = stubServices()
  const h = await harness(t, {
    services: {
      ...base.services,
      async indexForBinding(binding) {
        const index = await base.services.indexForBinding(binding)
        return {
          ...index,
          stats: async () => ({
            notes: 5,
            links: 2,
            orphans: 1,
            byType: [{ type: 'decision', n: 5 }],
            byStatus: [{ status: 'active', n: 5 }],
            updatedAt: null,
          }),
        }
      },
    },
  })
  const result = await h.post({ sessionId: SESSION, action: 'overview' })
  assert.equal(result.status, 200)
  assert.equal(
    'flow' in result.body.value.counts,
    false,
    'an absent flow stays absent, never invented',
  )
  assert.deepEqual(result.body.value.counts.byType, [{ type: 'decision', n: 5 }])
})
test('an index build without the chart aggregates still answers overview', async (t) => {
  // The panel asset and the host plugin upgrade independently, so a missing
  // aggregate must read as "no chart" rather than fail the whole 概览 read.
  const h = await harness(t, { services: stubServices().services })
  const result = await h.post({ sessionId: SESSION, action: 'overview' })
  assert.equal(result.status, 200)
  assert.equal(result.body.value.activity, null)
  assert.equal(result.body.value.tags, null)
  assert.equal(result.body.value.counts.notes, 5, 'the required cards still answer')
})

test('a failing chart aggregate degrades to no chart instead of failing the read', async (t) => {
  const base = stubServices()
  const services = {
    ...base.services,
    async indexForBinding() {
      return {
        boundProjectId: BOUND.projectId,
        status: () => ({
          backend: 'sqlite',
          ready: true,
          degraded: false,
          stale: false,
          scanning: false,
          notes: 5,
          lastScan: null,
          quarantined: [],
          skipped: {},
          fts: true,
        }),
        stats: async () => ({
          notes: 5,
          links: 2,
          orphans: 1,
          byType: [],
          byStatus: [],
          updatedAt: null,
        }),
        activity: async () => {
          throw new Error('index-not-ready')
        },
        tagFrequencies: async () => {
          throw new RangeError('limit out of range')
        },
        recent: async () => [],
      }
    },
  }
  const h = await harness(t, { services })
  const result = await h.post({ sessionId: SESSION, action: 'overview' })
  assert.equal(result.status, 200)
  assert.equal(result.body.value.activity, null)
  assert.equal(result.body.value.tags, null)
})

test('an unbound project keeps its pre-chart shape', async (t) => {
  const h = await harness(t, {
    services: stubServices().services,
    resolveBinding: async () => ({ kind: 'unbound', reason: 'no-pointer' }),
  })
  const result = await h.post({ sessionId: SESSION, action: 'overview' })
  assert.equal(result.status, 200)
  assert.deepEqual(Object.keys(result.body.value).sort(), [
    'capabilities',
    'counts',
    'digest',
    'health',
    'hot',
    'project',
    'queue',
    'recent',
  ])
  assert.equal('activity' in result.body.value, false, 'the unbound value gains no chart field')
  assert.equal('tags' in result.body.value, false)
})

// ---------------------------------------------------------------------------
// Item 1: a live read refreshes the project index behind the panel
// ---------------------------------------------------------------------------

/**
 * One index object shared across reads, with an observable `refresh` seam.
 *
 * The route throttles per index OBJECT (a WeakMap key), so the stub must answer
 * the same handle every time. The real `indexForBinding` does; a fresh object per
 * call would make every read look like the first and defeat the throttle.
 */
function refreshableIndex() {
  const state = {
    scanning: () => false,
    refreshes: 0,
    events: [],
    failure: null,
    gate: null,
    entered: null,
  }
  const index = {
    boundProjectId: BOUND.projectId,
    async refresh() {
      state.refreshes += 1
      state.events.push('refresh')
      if (state.entered !== null) state.entered()
      if (state.gate !== null) await state.gate
      if (state.failure !== null) throw state.failure
    },
    status: () => ({
      backend: 'sqlite',
      ready: true,
      degraded: false,
      stale: false,
      scanning: state.scanning(),
      notes: 5,
      lastScan: null,
      quarantined: [],
      skipped: {},
      fts: true,
    }),
    async stats() {
      state.events.push('stats')
      return { notes: 5, links: 2, orphans: 1, byType: [], byStatus: [], updatedAt: null }
    },
    async activity(args) {
      return activitySeries(args.days)
    },
    async tagFrequencies() {
      return { items: [], total: 0 }
    },
    async recent() {
      return []
    },
    async search() {
      const hits = []
      Object.defineProperty(hits, 'candidatesScored', { value: 0, enumerable: false })
      return hits
    },
  }
  const base = stubServices()
  const services = {
    ...base.services,
    async indexForBinding() {
      return index
    },
  }
  return { index, state, services }
}

test('overview and health refresh the project index at most once per throttle window', async (t) => {
  // The panel polls forever; the index is only re-scanned after a write in THIS
  // process. A memory created by another process (another profile, the Codex
  // adapter, Obsidian itself) is invisible until the index is asked to rescan, so
  // both live reads refresh it — but a scan per poll would re-walk the vault every
  // few seconds for a panel that only redraws.
  const { state, services } = refreshableIndex()
  let clock = 1_000_000
  const h = await harness(t, { services, now: () => clock })
  const read = () => h.post({ sessionId: SESSION, action: 'overview' })

  assert.equal((await read()).status, 200)
  assert.equal(state.refreshes, 1, 'the first live read refreshes the index')
  assert.equal(state.events[0], 'refresh', 'and it refreshes before the cards are read')

  await read()
  assert.equal(state.refreshes, 1, 'a second read inside the window does not')
  clock += PANEL_REFRESH_INTERVAL_MS - 1
  await read()
  assert.equal(state.refreshes, 1, 'one millisecond before the window ends still does not')
  clock += 1
  await read()
  assert.equal(state.refreshes, 2, 'at the window boundary the next read refreshes')

  clock += PANEL_REFRESH_INTERVAL_MS
  const health = await h.post({ sessionId: SESSION, action: 'health' })
  assert.equal(health.status, 200)
  assert.equal(state.refreshes, 3, '健康 is a live read too and shares the same window')
})

test('a scanning index is left alone, and the skip does not spend the window', async (t) => {
  const { state, services } = refreshableIndex()
  state.scanning = () => true
  let clock = 1_000_000
  const h = await harness(t, { services, now: () => clock })
  const read = () => h.post({ sessionId: SESSION, action: 'overview' })

  assert.equal((await read()).status, 200)
  assert.equal(
    state.refreshes,
    0,
    'the index already reports scanning; queueing a second scan is waste',
  )

  state.scanning = () => false
  clock += PANEL_REFRESH_INTERVAL_MS
  assert.equal((await read()).status, 200)
  assert.equal(state.refreshes, 1, 'the skipped read never stamped a window of its own')
})

test('the refresh window is stamped before the scan is awaited, so polls do not stampede', async (t) => {
  // Set the timestamp BEFORE awaiting the scan. Otherwise two panels polling in
  // the same watchdog tick both see an empty window and both start a vault scan.
  const { state, services } = refreshableIndex()
  let release
  state.gate = new Promise((resolve) => {
    release = resolve
  })
  let entered
  state.entered = () => {
    if (entered !== undefined) entered()
  }
  const started = new Promise((resolve) => {
    entered = resolve
  })
  const h = await harness(t, { services, now: () => 1_000_000 })
  const read = () => h.post({ sessionId: SESSION, action: 'overview' })

  const first = read()
  await started
  const second = await read()
  assert.equal(second.status, 200)
  assert.equal(state.refreshes, 1, 'the second poll saw the window already stamped')
  release()
  assert.equal((await first).status, 200)
})

test('a failed index refresh never fails the read and still spends the window', async (t) => {
  const { state, services } = refreshableIndex()
  state.failure = new Error('scan failed')
  const h = await harness(t, { services, now: () => 1_000_000 })
  const first = await h.post({ sessionId: SESSION, action: 'overview' })
  assert.equal(first.status, 200, 'a refresh failure is swallowed; the read still answers')
  assert.equal(first.body.value.counts.notes, 5, 'the previous scan is still a valid answer')
  assert.equal(first.body.value.activity.days.length, 84, 'and the charts still render')
  const second = await h.post({ sessionId: SESSION, action: 'overview' })
  assert.equal(second.status, 200)
  assert.equal(state.refreshes, 1, 'the failed attempt stamped the window before awaiting')
})

test('search and unbound reads never trigger the refresh', async (t) => {
  const { state, services } = refreshableIndex()
  const h = await harness(t, { services, now: () => 1_000_000 })
  const search = await h.post({ sessionId: SESSION, action: 'search', query: 'x', scope: 'all' })
  assert.equal(search.status, 200)
  assert.equal(state.refreshes, 0, '检索 answers from the index as it is')

  const unbound = await harness(t, {
    services,
    now: () => 1_000_000,
    resolveBinding: async () => ({ kind: 'unbound', reason: 'no-pointer' }),
  })
  const read = await unbound.post({ sessionId: SESSION, action: 'overview' })
  assert.equal(read.status, 200)
  assert.equal(state.refreshes, 0, 'an unbound read answers before an index is ever resolved')
})

test('a real-shaped dense year fits the 20 KB ceiling without trimming', async (t) => {
  // The heat map requests all 371 days on every load, so a year where every day
  // carries counts is the largest honest activity series the panel can produce.
  // It must answer whole at the new ceiling: if the trimmer's first stage fired it
  // would cut the series to the designed 84 days and silently snap the heat map
  // back to twelve weeks. This fixture is the evidence the CEILINGS comment cites:
  // a dense 371-day series (two-digit counts every day) plus real-shaped cards —
  // counts, 24 tags, 8 recent rows, the collector's digest — measures 15,209 B.
  const year = () => {
    const list = localDays(371)
    return {
      from: list[0],
      to: list[list.length - 1],
      days: list,
      created: list.map((_day, index) => 10 + (index % 25)),
      updated: list.map((_day, index) => 10 + ((index * 7) % 30)),
    }
  }
  const byType = [
    { type: 'gotcha', n: 363 },
    { type: 'convention', n: 324 },
    { type: 'decision', n: 261 },
    { type: 'doc', n: 11 },
    { type: 'hub', n: 7 },
    { type: 'session-log', n: 6 },
    { type: 'hot', n: 1 },
  ]
  const tags = Array.from({ length: 24 }, (_x, index) => ({
    tag: 'dsh-mem/tag-' + index,
    n: 24 - index,
  }))
  const recent = Array.from({ length: 8 }, (_x, index) => ({
    path:
      'Projects/alpha--11111111/Conventions/发布前核对包内两份 manifest 版本一致-' + index + '.md',
    title: '发布前核对包内两份 manifest 版本一致 · 第 ' + index + ' 条',
    type: 'convention',
    status: 'active',
    // Two rows per day across four days, so the day-diverse feed keeps all eight:
    // this fixture still measures the real-shaped eight-row recent card.
    updated: '2026-10-' + String(31 - Math.floor(index / 2)).padStart(2, '0'),
  }))
  const sections = ['已完成', '进行中', '强约束'].map((name) => ({
    name,
    chars: 1200,
    entries: 2,
    pointers: 3,
    moveable: 1,
  }))
  // The digest card as the real collector shapes it — it is the second-largest card
  // on the wire (2,800 B measured), so leaving it out would understate the payload.
  const digestYear = () => ({
    window: { days: 1, from: '2026-10-30T03:32:24.639Z', to: '2026-10-31T03:32:24.639Z' },
    notes: {
      created: 31,
      updated: 4,
      superseded: 0,
      byType: [
        { type: 'convention', created: 15, updated: 0 },
        { type: 'gotcha', created: 12, updated: 0 },
        { type: 'doc', created: 4, updated: 0 },
        { type: 'hub', created: 0, updated: 4 },
      ],
    },
    hot: {
      missing: false,
      used: 5728,
      capacity: 9000,
      trigger: 6030,
      ratio: 0.67,
      sections: [
        { name: '强约束', chars: 1, entries: 0, pointers: 0, moveable: 0 },
        { name: '进行中', chars: 1, entries: 0, pointers: 0, moveable: 0 },
        { name: '已完成', chars: 5464, entries: 14, pointers: 1, moveable: 14 },
      ],
      archivable: 14,
      compactable: 14,
    },
    queue: { queued: 0, failed: 0, deferred: 0 },
    appraisal: { findings: [], total: 0, truncated: true, scanned: 35 },
    recent: recent.map((row) => ({ ...row, updated: '2026-10-30' })),
    snapshot: {
      at: '2026-10-31T03:32:24.639Z',
      basis: 'current-status-among-inspected-sources',
      fields: ['notes.superseded', 'hot', 'queue'],
    },
    collection: {
      basis: 'inspected-source-notes',
      inspected: 35,
      limit: 200,
      truncated: true,
      incomplete: false,
      reasons: ['source-limit'],
    },
  })
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
          notes: 973,
          lastScan: '2026-10-30T17:03:55.034Z',
          quarantined: [],
          skipped: { large: 0, symlink: 0, internal: 10, depth: 0, other: 0 },
          fts: true,
        }),
        stats: async () => ({
          notes: 973,
          links: 1101,
          orphans: 844,
          byType,
          byStatus: [
            { status: 'active', n: 588 },
            { status: 'superseded', n: 199 },
            { status: 'accepted', n: 90 },
            { status: 'proposed', n: 43 },
            { status: 'provisional', n: 39 },
            { status: 'archived', n: 14 },
          ],
          flow: [
            { type: 'gotcha', status: 'active', n: 242 },
            { type: 'convention', status: 'active', n: 226 },
            { type: 'decision', status: 'active', n: 95 },
            { type: 'gotcha', status: 'superseded', n: 89 },
            { type: 'decision', status: 'accepted', n: 80 },
            { type: 'convention', status: 'superseded', n: 71 },
            { type: 'decision', status: 'superseded', n: 39 },
            { type: 'decision', status: 'proposed', n: 35 },
            { type: 'gotcha', status: 'provisional', n: 15 },
            { type: 'convention', status: 'provisional', n: 13 },
            { type: 'gotcha', status: 'archived', n: 12 },
            { type: 'decision', status: 'provisional', n: 11 },
            { type: 'doc', status: 'active', n: 11 },
            { type: 'convention', status: 'accepted', n: 7 },
            { type: 'hub', status: 'active', n: 7 },
            { type: 'convention', status: 'proposed', n: 6 },
            { type: 'session-log', status: 'active', n: 6 },
            { type: 'gotcha', status: 'accepted', n: 3 },
            { type: 'gotcha', status: 'proposed', n: 2 },
            { type: 'convention', status: 'archived', n: 1 },
            { type: 'decision', status: 'archived', n: 1 },
            { type: 'hot', status: 'active', n: 1 },
          ],
          updatedAt: '2026-10-30T17:03:54.798Z',
        }),
        activity: async () => year(),
        tagFrequencies: async () => ({ items: tags, total: 411, distinct: 24 }),
        recent: async () => recent,
      }
    },
    async admin(args) {
      if (args.action === 'hot')
        return {
          action: 'hot',
          result: { ...hotView({ sections }), sections },
        }
      if (args.action === 'digest') return { action: 'digest', result: digestYear() }
      return { action: 'jobs', result: { jobs: [], failed: 0, deferred: 0 } }
    },
  }
  const h = await harness(t, { services })
  const result = await h.post({ sessionId: SESSION, action: 'overview', days: 371 })
  assert.equal(result.status, 200)
  assert.ok(result.bytes <= 20 * 1024, 'a dense year is ' + result.bytes + ' bytes')
  const value = result.body.value
  assert.equal(value.activity.days.length, 371, 'the whole year reaches the heat map untrimmed')
  assert.equal(value.activity.created.length, 371)
  assert.equal(value.tags.items.length, 24, 'the tag treemap page is intact')
  assert.equal(value.recent.length, 8)
  assert.notEqual(value.digest, null)
  assert.equal(value.hot.sections.length, 3)
})

// ---------------------------------------------------------------------------
// 最近变化: a day-diverse sample instead of a flat newest-8 page
// ---------------------------------------------------------------------------

/** A row as `index.recent` answers it; the index is newest first by file mtime. */
function recentView(day, index) {
  return {
    path: 'Projects/alpha--11111111/Decisions/' + String(day) + '-' + index + '.md',
    title: 'note ' + String(day) + ' #' + index,
    type: 'decision',
    status: 'active',
    updated: day === null ? null : day + 'T10:00:00.000Z',
  }
}

/** One overview read from an index whose recent page is fixed; the ask is recorded. */
async function recentRead(t, rows) {
  const calls = []
  const base = stubServices()
  const services = {
    ...base.services,
    async indexForBinding() {
      return {
        boundProjectId: BOUND.projectId,
        status: () => ({
          backend: 'sqlite',
          ready: true,
          degraded: false,
          stale: false,
          scanning: false,
          notes: 60,
          lastScan: null,
          quarantined: [],
          skipped: {},
          fts: true,
        }),
        stats: async () => ({
          notes: 60,
          links: 0,
          orphans: 0,
          byType: [],
          byStatus: [],
          updatedAt: null,
        }),
        activity: async (args) => activitySeries(args.days, 1),
        tagFrequencies: async () => ({ items: [], total: 0 }),
        async recent(args) {
          calls.push(args)
          return rows
        },
      }
    },
  }
  const h = await harness(t, { services })
  const result = await h.post({ sessionId: SESSION, action: 'overview' })
  return { calls, result }
}

test('最近变化 samples up to two notes per day across the newest four days', async (t) => {
  // Live 2026-10-31: the overview's eight recent rows were ALL updated that day
  // (the digest reported 45 notes created in the last day), so a flat newest-8
  // window could only ever draw one day group. The route scans a wide INTERNAL
  // page and keeps a day-diverse sample; the wire still carries <= 8 rows, so the
  // overview byte ceiling is untouched.
  const rows = [
    ...Array.from({ length: 45 }, (_x, index) => recentView('2026-10-31', index)),
    ...Array.from({ length: 3 }, (_x, index) => recentView('2026-10-30', index)),
    ...Array.from({ length: 2 }, (_x, index) => recentView('2026-10-29', index)),
    ...Array.from({ length: 2 }, (_x, index) => recentView('2026-10-28', index)),
    ...Array.from({ length: 1 }, (_x, index) => recentView('2026-10-27', index)),
  ]
  const { calls, result } = await recentRead(t, rows)
  assert.equal(result.status, 200)
  assert.deepEqual(calls, [{ limit: 500 }], 'the internal scan asks for the wide page')
  const value = result.body.value.recent
  assert.equal(value.length, 8)
  assert.deepEqual(
    value.map((row) => row.updated.slice(0, 10)),
    [
      '2026-10-31',
      '2026-10-31',
      '2026-10-30',
      '2026-10-30',
      '2026-10-29',
      '2026-10-29',
      '2026-10-28',
      '2026-10-28',
    ],
    'two rows per day, newest days first, original mtime order preserved',
  )
  assert.equal(
    value.some((row) => row.updated.startsWith('2026-10-27')),
    false,
    'a fifth day is beyond the four-day sample',
  )
  for (const row of value)
    assert.deepEqual(
      Object.keys(row).sort(),
      ['path', 'status', 'title', 'type', 'updated'],
      'the wire row shape is unchanged',
    )
})

test('a busy single day is bounded to two rows instead of a flat newest-8', async (t) => {
  const rows = Array.from({ length: 12 }, (_x, index) => recentView('2026-10-31', index))
  const { result } = await recentRead(t, rows)
  assert.equal(result.status, 200)
  assert.deepEqual(
    result.body.value.recent.map((row) => row.path),
    rows.slice(0, 2).map((row) => row.path),
    'only the newest two rows of the only day reach the wire',
  )
})

test('rows without an updated day form a final unknown bucket with the same cap', async (t) => {
  // The timeline renders undated rows as a final 未知 group; the route keeps them
  // as one bucket (at most two rows) and never lets them displace a dated day.
  const rows = [
    recentView(null, 0),
    recentView('2026-10-31', 0),
    recentView(null, 1),
    recentView('2026-10-31', 1),
    recentView(null, 2),
    recentView('2026-10-30', 0),
    recentView('2026-10-30', 1),
  ]
  const { result } = await recentRead(t, rows)
  const value = result.body.value.recent
  assert.equal(value.length, 6, 'two dated days plus two unknown rows still fit the wire')
  assert.equal(
    value.filter((row) => row.updated === null).length,
    2,
    'the unknown bucket keeps the same two-row cap',
  )
  assert.deepEqual(
    value.map((row) => row.updated),
    [
      null,
      '2026-10-31T10:00:00.000Z',
      null,
      '2026-10-31T10:00:00.000Z',
      '2026-10-30T10:00:00.000Z',
      '2026-10-30T10:00:00.000Z',
    ],
    'the original mtime order is preserved across buckets',
  )
})

test('overview stays inside 20 KB with fifty notes and the full 84-day window', async (t) => {
  const recent = Array.from({ length: 8 }, (_x, index) => ({
    path: 'Projects/alpha--11111111/Decisions/note-' + index + '.md',
    title: 'a realistic note title number ' + index,
    type: 'decision',
    status: 'active',
    updated: '2026-10-2' + (index % 9) + 'T10:00:00.000Z',
  }))
  const tags = Array.from({ length: 12 }, (_x, index) => ({
    tag: 'dsh-mem/' + ['decision', 'gotcha', 'convention'][index % 3] + '-' + index,
    n: 12 - index,
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
          notes: 50,
          lastScan: new Date().toISOString(),
          quarantined: [],
          skipped: {},
          fts: true,
        }),
        stats: async () => ({
          notes: 50,
          links: 120,
          orphans: 3,
          byType: Array.from({ length: 6 }, (_x, index) => ({
            type: 'type-' + index,
            n: 50 - index,
          })),
          byStatus: Array.from({ length: 5 }, (_x, index) => ({
            status: 'status-' + index,
            n: 50 - index,
          })),
          updatedAt: null,
        }),
        activity: async () => activitySeries(84, 1),
        tagFrequencies: async () => ({ items: tags, total: 37 }),
        recent: async () => recent,
      }
    },
    async admin(args) {
      if (args.action === 'hot')
        return {
          action: 'hot',
          result: {
            missing: false,
            used: 7200,
            capacity: 9000,
            trigger: 6030,
            ratio: 0.8,
            archivable: 3,
            compactable: 5,
            sections: [{ name: '已完成', chars: 1200, entries: 1, pointers: 2, moveable: 3 }],
          },
        }
      if (args.action === 'digest') return { action: 'digest', result: digestView() }
      return { action: 'jobs', result: { jobs: [], failed: 0, deferred: 0 } }
    },
  }
  const h = await harness(t, { services })
  const result = await h.post({ sessionId: SESSION, action: 'overview' })
  assert.equal(result.status, 200)
  assert.ok(result.bytes <= 20 * 1024, 'overview is ' + result.bytes + ' bytes')
  const value = result.body.value
  // A realistic overview fits untrimmed: the 84-day window and twelve tag rows
  // are the designed payload, not the overflow case.
  assert.equal(value.activity.days.length, 84)
  assert.equal(value.tags.items.length, 12)
  // This fixture's eight rows are eight DIFFERENT days, so the day-diverse feed
  // samples two rows for each of the newest four days instead of all eight.
  assert.equal(value.recent.length, 4)
  assert.notEqual(value.digest, null)
})

/** A mutable index/admin pair: a case sets the fields, then reads what survived. */
function ladderHarness(t) {
  const state = {
    activity: activitySeries(84, 1),
    tagPage: { items: [], total: 0 },
    byType: [],
    byStatus: [],
    flow: [],
    sections: [],
    recent: [],
    digest: null,
  }
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
          notes: 3,
          lastScan: null,
          quarantined: [],
          skipped: {},
          fts: true,
        }),
        stats: async () => ({
          notes: 3,
          links: 0,
          orphans: 0,
          byType: state.byType,
          byStatus: state.byStatus,
          flow: state.flow,
          updatedAt: null,
        }),
        activity: async () => state.activity,
        tagFrequencies: async () => state.tagPage,
        recent: async () => state.recent,
      }
    },
    async admin(args) {
      if (args.action === 'hot')
        return {
          action: 'hot',
          result: {
            missing: false,
            used: 1,
            capacity: 9,
            trigger: 6,
            ratio: 0.1,
            archivable: 0,
            compactable: 0,
            sections: state.sections,
          },
        }
      if (args.action === 'digest') return { action: 'digest', result: state.digest }
      return { action: 'jobs', result: { jobs: [], failed: 0, deferred: 0 } }
    },
  }
  const ready = harness(t, { services })
  const post = async () => (await ready).post({ sessionId: SESSION, action: 'overview' })
  return { state, post }
}

test('a wider activity window is the first thing the ceiling gives back', async (t) => {
  // The wide-panel window is the newest enhancement to the payload, and the only one
  // whose loss still leaves both charts drawn at the designed twelve weeks. So it is
  // the first thing shrunk when the answer crosses 20 KB — before the tag page or any
  // distribution pays — and the charts keep their design window instead of a 4-week
  // last resort.
  const CEILING = 20 * 1024
  const SLACK = 400
  const { state, post } = ladderHarness(t)
  const rows = (count, make) => Array.from({ length: count }, (_x, index) => make(index))
  const zeros = (days) => ({
    ...activitySeries(days),
    created: new Array(days).fill(0),
    updated: new Array(days).fill(0),
  })
  const section = (name = 'done') => ({
    name,
    chars: 10,
    entries: 1,
    pointers: 0,
    moveable: 0,
  })
  state.activity = zeros(371)
  state.tagPage = { items: [], total: 0 }
  state.byType = []
  state.byStatus = []
  state.sections = [section()]
  state.recent = []
  state.digest = null
  const before = (await post()).bytes
  const width = Math.max(8, CEILING + SLACK - before)
  state.sections = rows(6, (index) => ({
    ...section('sec-' + index + '-' + 'x'.repeat(Math.ceil(width / 6))),
  }))
  const trimmed = await post()
  assert.equal(trimmed.status, 200)
  assert.ok(trimmed.bytes <= CEILING, 'the answer is ' + trimmed.bytes + ' bytes')
  const window = trimmed.body.value.activity
  assert.equal(
    window.days.length,
    84,
    'the wider window shrinks to the designed twelve weeks first',
  )
  assert.equal(window.created.length, 84, 'the series are cut with the calendar')
  assert.equal(window.updated.length, 84)
  assert.equal(window.from, zeros(371).days[287], 'from moves to the new first day')
  assert.equal(window.to, zeros(371).days[370], 'to never moves')
  assert.equal(trimmed.body.value.hot.sections.length, 6, 'the hot sections are untouched')
})

test('overview trims the charts before the text lists, in the design §3.6 order', async (t) => {
  const CEILING = 20 * 1024
  const SLACK = 400
  const { state, post } = ladderHarness(t)
  const rows = (count, make) => Array.from({ length: count }, (_x, index) => make(index))
  const zeros = (days) => ({
    ...activitySeries(days),
    created: new Array(days).fill(0),
    updated: new Array(days).fill(0),
  })
  const section = (name = 'done') => ({
    name,
    chars: 10,
    entries: 1,
    pointers: 0,
    moveable: 0,
  })
  const recentRow = (index = 0) => ({
    path: 'p/' + index + '.md',
    title: 'a',
    type: 'decision',
    status: 'active',
    updated: null,
  })
  /**
   * Reset to a shape where only `order`'s target is large: measure the answer,
   * then pad the target so the payload lands `SLACK` bytes past the ceiling.
   * The answer must then have lost exactly the fields that precede the target in
   * the design's order, and nothing after it.
   */
  const overCeiling = async (reset, pad) => {
    reset()
    const before = (await post()).bytes
    pad(Math.max(8, CEILING + SLACK - before))
    return post()
  }

  // 1. tags.items is the first thing to go.
  const first = await overCeiling(
    () => {
      state.activity = zeros(84)
      state.tagPage = { items: [{ tag: 'a', n: 1 }], total: 1 }
      state.byType = [
        { type: 'decision', n: 1 },
        { type: 'doc', n: 1 },
      ]
      state.byStatus = [
        { status: 'active', n: 1 },
        { status: 'provisional', n: 1 },
      ]
      state.sections = [section()]
      state.recent = [recentRow(0)]
      state.digest = null
    },
    (width) => {
      state.tagPage = {
        items: rows(8, (index) => ({
          tag: 'tag-' + index + '-' + 'x'.repeat(Math.ceil(width / 8)),
          n: 8 - index,
        })),
        total: 8,
      }
    },
  )
  assert.equal(first.status, 200)
  assert.ok(first.bytes <= CEILING, 'first stage answer is ' + first.bytes + ' bytes')
  assert.equal(first.body.value.tags.items.length, 4, 'the tag page halves first')
  assert.equal(first.body.value.counts.byType.length, 2, 'the distributions still fit')
  assert.equal(first.body.value.counts.byStatus.length, 2)
  assert.equal(
    first.body.value.activity.days.length,
    84,
    'the window is untouched until the tags run out',
  )
  assert.equal(first.body.value.hot.sections.length, 1)
  assert.equal(first.body.value.recent.length, 1)

  // 2. With the tag page gone, counts.byType pays next, before byStatus.
  const second = await overCeiling(
    () => {
      state.activity = zeros(84)
      state.tagPage = { items: [{ tag: 'a', n: 1 }], total: 1 }
      state.byType = [
        { type: 'decision', n: 1 },
        { type: 'doc', n: 1 },
      ]
      state.byStatus = [
        { status: 'active', n: 1 },
        { status: 'provisional', n: 1 },
      ]
      state.sections = [section()]
      state.recent = [recentRow(0)]
    },
    (width) => {
      state.byType = rows(4, (index) => ({
        type: 'type-' + index + '-' + 'x'.repeat(Math.ceil(width / 4)),
        n: 4 - index,
      }))
    },
  )
  assert.ok(second.bytes <= CEILING)
  assert.deepEqual(second.body.value.tags.items, [], 'an exhausted tag page cannot pay twice')
  assert.equal(second.body.value.counts.byType.length, 2, 'byType halves before byStatus')
  assert.equal(second.body.value.counts.byStatus.length, 2)
  assert.equal(second.body.value.activity.days.length, 84)

  // 3. Then byStatus, and only then the activity window.
  const third = await overCeiling(
    () => {
      state.activity = zeros(84)
      state.tagPage = { items: [], total: 0 }
      state.byType = [{ type: 'decision', n: 1 }]
      state.byStatus = [
        { status: 'active', n: 1 },
        { status: 'provisional', n: 1 },
      ]
      state.sections = [section()]
      state.recent = [recentRow(0)]
    },
    (width) => {
      state.byStatus = rows(4, (index) => ({
        status: 'status-' + index + '-' + 'x'.repeat(Math.ceil(width / 4)),
        n: 4 - index,
      }))
    },
  )
  assert.ok(third.bytes <= CEILING)
  // `byType` is stage 2 and is spent before `byStatus` (stage 3) is touched —
  // even when spending it means emptying its last row: the order is the design's,
  // not "whichever list looks cheapest".
  assert.equal(third.body.value.counts.byType.length, 0, 'byType is spent before byStatus')
  assert.equal(third.body.value.counts.byStatus.length, 2, 'byStatus halves after byType')
  assert.equal(
    third.body.value.activity.days.length,
    84,
    'the window is a later stage than byStatus',
  )

  // 4. The activity window shrinks to four weeks as one step, all three arrays
  // together and `from` moving with them — before the hot sections pay.
  const fourth = await overCeiling(
    () => {
      state.activity = zeros(84)
      state.tagPage = { items: [], total: 0 }
      state.byType = []
      state.byStatus = []
      state.sections = [section()]
      state.recent = [recentRow(0)]
    },
    (width) => {
      state.sections = rows(6, (index) => ({
        ...section('sec-' + index + '-' + 'x'.repeat(Math.ceil(width / 6))),
      }))
    },
  )
  assert.ok(fourth.bytes <= CEILING)
  const cut = fourth.body.value.activity
  assert.equal(cut.days.length, 28, 'the window falls back to four weeks')
  assert.equal(cut.created.length, 28, 'the created series is cut with the calendar')
  assert.equal(cut.updated.length, 28)
  assert.equal(cut.from, zeros(84).days[56], 'from moves to the new first day')
  assert.equal(cut.to, zeros(84).days[83], 'to never moves')
  assert.equal(fourth.body.value.hot.sections.length, 6, 'the hot sections are untouched')

  // 5. The hot sections pay only once the window is already four weeks.
  const fifth = await overCeiling(
    () => {
      state.activity = zeros(28)
      state.tagPage = { items: [], total: 0 }
      state.byType = []
      state.byStatus = []
      state.sections = [section()]
      state.recent = [recentRow(0)]
    },
    (width) => {
      state.sections = rows(6, (index) => ({
        ...section('sec-' + index + '-' + 'x'.repeat(Math.ceil(width / 6))),
      }))
    },
  )
  assert.ok(fifth.bytes <= CEILING)
  assert.equal(
    fifth.body.value.hot.sections.length,
    3,
    'the hot sections halve once the window is short',
  )
  assert.equal(fifth.body.value.recent.length, 1, 'the recent list survives the hot step')

  // 6. Then the recent list, while the digest card still fits.
  const sixth = await overCeiling(
    () => {
      state.activity = zeros(28)
      state.tagPage = { items: [], total: 0 }
      state.byType = []
      state.byStatus = []
      state.sections = [section()]
      state.recent = [recentRow(0)]
      state.digest = digestView()
    },
    (width) => {
      state.recent = rows(4, (index) => ({
        ...recentRow(index),
        // Two days × two rows: the day-diverse feed keeps all four, so the last
        // list still has something to halve.
        updated: '2026-10-' + (27 + (index % 2)),
        title: 'x'.repeat(Math.ceil(width / 4)),
      }))
    },
  )
  assert.ok(sixth.bytes <= CEILING)
  assert.equal(sixth.body.value.recent.length, 2, 'the recent list halves last of the lists')
  assert.notEqual(sixth.body.value.digest, null, 'the digest is still worth its bytes here')

  // 7. The digest card is the final payload to go.
  const seventh = await overCeiling(
    () => {
      state.activity = zeros(28)
      state.tagPage = { items: [], total: 0 }
      state.byType = []
      state.byStatus = []
      state.sections = [section()]
      state.recent = []
      state.digest = digestView()
    },
    (width) => {
      state.digest = {
        ...digestView(),
        appraisal: {
          findings: [{ code: 'x'.repeat(width) }],
          total: 1,
          truncated: false,
          scanned: 1,
        },
      }
    },
  )
  assert.ok(seventh.bytes <= CEILING)
  assert.equal(seventh.body.value.digest, null, 'the digest card is dropped last')
  assert.deepEqual(seventh.body.value.recent, [])
})

test('overview drops the whole flow before it halves a distribution', async (t) => {
  // The trimmer's design §3.6 order is tags -> flow -> byType -> byStatus -> ...
  // The flow is all-or-nothing: a halved flow would draw a Sankey whose link sum
  // disagrees with the printed totals, so a too-large flow is dropped entirely
  // and the view falls back to the stacked bar instead.
  const CEILING = 20 * 1024
  const { state, post } = ladderHarness(t)
  const flat = (days) => ({
    ...activitySeries(days),
    created: new Array(days).fill(0),
    updated: new Array(days).fill(0),
  })
  state.activity = flat(84)
  state.tagPage = { items: [], total: 0 }
  state.byType = [
    { type: 'decision', n: 2 },
    { type: 'doc', n: 1 },
  ]
  state.byStatus = [
    { status: 'active', n: 2 },
    { status: 'provisional', n: 1 },
  ]
  state.flow = [{ type: 'decision', status: 'active', n: 2 }]
  state.sections = []
  state.recent = []
  state.digest = null
  const before = (await post()).bytes
  assert.ok(before <= CEILING, 'the baseline fits: ' + before + ' bytes')
  // Pad ONLY the flow: 120 long joint rows put the payload far past the ceiling.
  state.flow = Array.from({ length: 120 }, (_x, index) => ({
    type: 'type-' + index + '-' + 'x'.repeat(100),
    status: 'status-' + index + '-' + 'y'.repeat(100),
    n: index + 1,
  }))
  const result = await post()
  assert.equal(result.status, 200)
  assert.ok(result.bytes <= CEILING, 'the answer is ' + result.bytes + ' bytes')
  assert.deepEqual(result.body.value.counts.flow, [], 'flow is dropped whole, never halved')
  assert.deepEqual(
    result.body.value.counts.byType.map((row) => row.type),
    ['decision', 'doc'],
    'the distributions did not pay for the flow',
  )
  assert.deepEqual(
    result.body.value.counts.byStatus.map((row) => row.status),
    ['active', 'provisional'],
    'and neither did the status margins',
  )
  assert.equal(result.body.value.activity.days.length, 84, 'the window did not shrink either')
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
  assert.ok(result.bytes <= 20480, 'final response is ' + result.bytes + ' bytes')
  assert.equal(result.body.ok, false)
  assert.equal(result.body.error.code, 'response-too-large')
})

// ---------------------------------------------------------------------------
// Task 2: confirmed mutations over the wire (preview then confirm)
// ---------------------------------------------------------------------------

/** The job view the real `jobs` action reports (no model text, no safeInput). */
function failedJob(overrides = {}) {
  return {
    jobId: JOB_ID,
    state: 'failed',
    sessionId: 'session-x',
    projectId: BOUND.projectId,
    fromSeq: 1,
    toSeq: 7,
    attempts: 2,
    createdAt: '2026-10-26T00:00:00.000Z',
    failedAt: '2026-10-26T01:00:00.000Z',
    lastError: 'boom',
    outputState: null,
    ...overrides,
  }
}

/** The hot status the real action reports, with the counters compact moves. */
function hotView(overrides = {}) {
  return {
    missing: false,
    used: 7200,
    capacity: 9000,
    trigger: 6030,
    ratio: 0.8,
    archivable: 3,
    compactable: 5,
    sections: [{ name: '已完成', chars: 1200, entries: 1, pointers: 2, moveable: 3 }],
    ...overrides,
  }
}

/** The digest result the collector renders; only the stable facts matter here. */
function digestView(overrides = {}) {
  return {
    window: { days: 1, from: '2026-10-26T10:00:00.000Z', to: '2026-10-27T10:00:00.000Z' },
    notes: {
      created: 1,
      updated: 0,
      superseded: 0,
      byType: [{ type: 'decision', created: 1, updated: 0 }],
    },
    hot: hotView({ sections: [] }),
    queue: { queued: 1, failed: 0, deferred: 0 },
    appraisal: { findings: [], total: 0, truncated: false, scanned: 1 },
    recent: [],
    snapshot: {
      at: '2026-10-27T10:00:00.000Z',
      basis: 'current-status-among-inspected-sources',
      fields: ['notes.superseded', 'hot', 'queue'],
    },
    collection: {
      basis: 'inspected-source-notes',
      inspected: 1,
      limit: 200,
      truncated: false,
      incomplete: false,
      reasons: [],
    },
    ...overrides,
  }
}

/**
 * A stub service set that can answer the three mutations: every read is recorded,
 * and only the one compact/retry/refresh call per confirmation changes its world.
 */
function mutationStubServices() {
  const calls = { admin: [], retries: 0, compacts: 0, refreshes: 0 }
  const state = {
    job: failedJob(),
    hot: hotView(),
    digest: digestView(),
    compacted: false,
    refreshed: false,
  }
  const services = {
    async admin(args) {
      calls.admin.push({ ...args })
      if (args.action === 'jobs') {
        if (args.retry === true) {
          calls.retries += 1
          state.job = { ...state.job, state: 'pending', attempts: 0 }
          return {
            action: 'jobs',
            result: { status: 'retried', jobs: [state.job], failed: 0, message: null },
          }
        }
        const jobs = state.job === null ? [] : [state.job]
        const selected =
          args.jobId === undefined ? jobs : jobs.filter((entry) => entry.jobId === args.jobId)
        return {
          action: 'jobs',
          result: {
            status: 'listed',
            jobs: selected,
            failed: jobs.filter((job) => job.state === 'failed').length,
            message: selected.length === 0 ? 'no such job' : null,
          },
        }
      }
      if (args.action === 'hot') {
        if (args.operation === 'compact') {
          calls.compacts += 1
          state.compacted = true
          return {
            action: 'hot',
            result: {
              operation: 'compact',
              projectId: BOUND.projectId,
              ...state.hot,
              moved: 3,
              folded: 2,
              reclaimed: 900,
            },
          }
        }
        return {
          action: 'hot',
          result: {
            operation: 'status',
            projectId: BOUND.projectId,
            ...state.hot,
            moved: 0,
            folded: 0,
            reclaimed: 0,
          },
        }
      }
      if (args.action === 'digest') {
        if (args.operation === 'refresh') {
          calls.refreshes += 1
          state.refreshed = true
          return {
            action: 'digest',
            result: {
              ...state.digest,
              publication: {
                status: 'created',
                path: BOUND.relativeDir + '/_meta/digest.md',
                id: 'doc-abcdefgh',
                charCount: 900,
                txId: 'tx-digest-1',
              },
            },
          }
        }
        return { action: 'digest', result: state.digest }
      }
      throw new Error('unexpected admin call ' + JSON.stringify(args))
    },
  }
  return { services, calls, state }
}

const ORIGIN_HEADER = (h) => ({ origin: h.origin })

/** The desktop proxy's request shape: forwardWebRequest deletes Origin, keeping only custom headers. */
const DESKTOP_HEADER = { [PANEL_HEADER]: PANEL_HEADER_VALUE }

test('overview and health carry capabilities and the bounded failed-job list', async (t) => {
  const entry = (jobId, state, minutes) =>
    failedJob({
      jobId,
      state,
      failedAt: new Date(Date.parse('2026-10-26T01:00:00.000Z') + minutes * 60_000).toISOString(),
    })
  const jobs = [
    entry('job-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'failed', 6),
    entry('job-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'failed', 5),
    entry('job-cccccccccccccccccccccccccccccccc', 'failed', 4),
    entry('job-dddddddddddddddddddddddddddddddd', 'failed', 3),
    entry('job-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', 'failed', 2),
    entry('job-ffffffffffffffffffffffffffffffff', 'failed', 1),
    failedJob({ jobId: 'job-99999999999999999999999999999999', projectId: OTHER_PROJECT_ID }),
    failedJob({ jobId: 'job-88888888888888888888888888888888', state: 'pending' }),
  ]
  const base = stubServices()
  const services = {
    ...base.services,
    async admin(args) {
      if (args.action === 'jobs')
        return {
          action: 'jobs',
          result: {
            status: 'listed',
            jobs,
            failed: jobs.filter((job) => job.state === 'failed').length,
            message: null,
          },
        }
      if (args.action === 'hot')
        return {
          action: 'hot',
          result: { operation: 'status', missing: false, ...hotView(), sections: [] },
        }
      if (args.action === 'diagnostics')
        return {
          action: 'diagnostics',
          result: { window: { capacity: 200, size: 0, dropped: 0 }, events: [] },
        }
      return { action: 'jobs', result: { status: 'listed', jobs: [], failed: 0, message: null } }
    },
  }
  const h = await harness(t, { services })
  const expected = {
    mutations: ['retry-job', 'compact-hot', 'refresh-digest'],
    confirm: true,
  }
  const overview = await h.post({ sessionId: SESSION, action: 'overview' })
  assert.equal(overview.status, 200)
  assert.deepEqual(overview.body.value.capabilities, expected)
  assert.equal(overview.body.value.queue.failed, 7)
  const listed = overview.body.value.queue.failedJobs
  assert.deepEqual(
    listed.map((job) => job.jobId),
    [
      'job-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'job-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      'job-cccccccccccccccccccccccccccccccc',
      'job-dddddddddddddddddddddddddddddddd',
      'job-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    ],
    'at most five failed jobs of the displayed project, newest first',
  )
  for (const job of listed)
    assert.deepEqual(Object.keys(job).sort(), ['attempts', 'jobId', 'state'], 'bounded view')
  const health = await h.post({ sessionId: SESSION, action: 'health' })
  assert.equal(health.status, 200)
  assert.deepEqual(health.body.value.capabilities, expected)
  assert.deepEqual(health.body.value.queue.failedJobs, listed)
  // The health payload carries the same project identity 概览 does: the shell's
  // masthead reads it from whichever view reported last, so a 健康 read that
  // omitted it would relabel the header "项目记忆" the moment the user switched
  // tabs. Both actions answer one identity shape.
  assert.deepEqual(health.body.value.project, overview.body.value.project)
  assert.equal(health.body.value.project.state, 'bound')
  assert.equal(health.body.value.project.name, 'alpha')
  const unbound = await harness(t, {
    services,
    resolveBinding: async () => ({ kind: 'unbound', reason: 'no-pointer' }),
  })
  const readOnly = await unbound.post({ sessionId: SESSION, action: 'overview' })
  assert.deepEqual(readOnly.body.value.capabilities, { mutations: [], confirm: true })
})

test('a retry preview issues a token and the confirm revives exactly once', async (t) => {
  const stub = mutationStubServices()
  const h = await harness(t, { services: stub.services })
  const preview = await h.post(
    {
      sessionId: SESSION,
      action: 'preview',
      mutation: 'retry-job',
      args: { jobId: JOB_ID },
    },
    ORIGIN_HEADER(h),
  )
  assert.equal(preview.status, 200)
  assert.equal(preview.body.ok, true)
  const value = preview.body.value
  assert.deepEqual(Object.keys(value).sort(), ['expiresAt', 'mutation', 'preview', 'token'])
  assert.equal(value.mutation, 'retry-job')
  assert.match(value.token, /^[A-Za-z0-9_-]{40,}$/u)
  assert.equal(typeof value.expiresAt, 'number')
  assert.equal(value.preview.title.length > 0, true)
  assert.equal(value.preview.confirmLabel.length > 0, true)
  assert.equal(Array.isArray(value.preview.facts), true)
  assert.equal(Array.isArray(value.preview.effects), true)
  assert.equal(value.preview.facts.find((fact) => fact.label === '任务').value, JOB_ID)
  assert.match(value.preview.warning, /DSH/u)
  assert.match(value.preview.warning, /Codex/u)
  assert.equal(stub.calls.retries, 0, 'the preview wrote nothing')
  assert.equal(stub.state.job.state, 'failed', 'the preview did not revive the job')

  const confirm = await h.post(
    { sessionId: SESSION, action: 'confirm', token: value.token },
    ORIGIN_HEADER(h),
  )
  assert.equal(confirm.status, 200)
  assert.deepEqual(Object.keys(confirm.body.value).sort(), ['mutation', 'replayed', 'result'])
  assert.equal(confirm.body.value.mutation, 'retry-job')
  assert.equal(confirm.body.value.replayed, false)
  assert.deepEqual(confirm.body.value.result, {
    status: 'retried',
    jobId: JOB_ID,
    state: 'pending',
  })
  assert.equal(stub.calls.retries, 1)

  const replay = await h.post(
    { sessionId: SESSION, action: 'confirm', token: value.token },
    ORIGIN_HEADER(h),
  )
  assert.equal(replay.status, 200)
  assert.equal(replay.body.value.replayed, true)
  assert.deepEqual(replay.body.value.result, confirm.body.value.result)
  assert.equal(stub.calls.retries, 1, 'a replay must not run the mutation twice')
})

test('an expired token over the wire is 409 preview-expired and writes nothing', async (t) => {
  let clock = 1_000_000
  const stub = mutationStubServices()
  const h = await harness(t, {
    services: stub.services,
    previewTokens: createPreviewTokens({ now: () => clock }),
  })
  const preview = await h.post(
    {
      sessionId: SESSION,
      action: 'preview',
      mutation: 'retry-job',
      args: { jobId: JOB_ID },
    },
    ORIGIN_HEADER(h),
  )
  assert.equal(preview.status, 200)
  clock += 60_001
  const expired = await h.post(
    { sessionId: SESSION, action: 'confirm', token: preview.body.value.token },
    ORIGIN_HEADER(h),
  )
  assert.equal(expired.status, 409)
  assert.equal(expired.body.error.code, 'preview-expired')
  assert.equal(stub.calls.retries, 0)
})

test('mutations accept the desktop proxy shape and still refuse a foreign or headerless request', async (t) => {
  // The DSH desktop app loads the GUI through dsh-app:// and its main-process
  // proxy (forwardWebRequest) DELETES host/origin/cookie/sec-fetch-site before
  // forwarding to loopback. So every real GUI mutation arrives with no Origin, and
  // the old "Origin required" fence 403'd both write actions. The fence is now:
  // JSON body, and either a matching Origin or the panel's own custom header —
  // a header a cross-site page cannot send without a preflight this route never
  // answers, which is what keeps the CSRF meaning the proxy stripped.
  const stub = mutationStubServices()
  const h = await harness(t, { services: stub.services })
  const body = {
    sessionId: SESSION,
    action: 'preview',
    mutation: 'retry-job',
    args: { jobId: JOB_ID },
  }
  const missing = await h.post(body)
  assert.equal(missing.status, 403)
  assert.equal(missing.body.error.code, 'forbidden')
  assert.equal(missing.body.error.message, 'same-origin request required')
  const foreign = await h.post(body, { origin: 'https://evil.example', ...DESKTOP_HEADER })
  assert.equal(foreign.status, 403, 'a mismatched Origin is refused by trusted()')
  const wrongValue = await h.post(body, { [PANEL_HEADER]: '0' })
  assert.equal(wrongValue.status, 403, 'only the panel header value counts')
  const notJson = await h.post(body, { ...DESKTOP_HEADER, 'content-type': 'text/plain' })
  assert.equal(notJson.status, 400)
  assert.equal(notJson.body.error.code, 'bad-request')
  const notJsonOrigin = await h.post(body, { ...ORIGIN_HEADER(h), 'content-type': 'text/plain' })
  assert.equal(notJsonOrigin.status, 400)
  assert.equal(stub.calls.admin.length, 0, 'no rejected request reached the service')

  // The two accepted shapes: the desktop proxy's (no Origin, panel header) and a
  // browser page's same-origin JSON POST (matching Origin, no header needed).
  const desktop = await h.post(body, DESKTOP_HEADER)
  assert.equal(desktop.status, 200, 'the desktop request shape previews')
  assert.equal(typeof desktop.body.value.token, 'string')
  const explicit = await h.post(body, ORIGIN_HEADER(h))
  assert.equal(explicit.status, 200, 'a matching Origin is still enough on its own')

  const unknownMutation = await h.post({ ...body, mutation: 'lint' }, ORIGIN_HEADER(h))
  assert.equal(unknownMutation.status, 400)
  assert.equal(unknownMutation.body.error.code, 'bad-request')
  const noArgs = await h.post(
    { sessionId: SESSION, action: 'preview', mutation: 'retry-job' },
    ORIGIN_HEADER(h),
  )
  assert.equal(noArgs.status, 400)
  const missingSession = await h.post({ ...body, sessionId: 'gone' }, ORIGIN_HEADER(h))
  // The route reserves 404 for "not registered"; a missing session is a retryable
  // 503 with its own code, exactly as on the read path.
  assert.equal(missingSession.status, 503)
  assert.equal(missingSession.body.error.code, 'session-missing')
  const unknownToken = await h.post(
    { sessionId: SESSION, action: 'confirm', token: 'never-issued' },
    ORIGIN_HEADER(h),
  )
  assert.equal(unknownToken.status, 409)
  assert.equal(unknownToken.body.error.code, 'preview-unknown')
  const noToken = await h.post({ sessionId: SESSION, action: 'confirm' }, ORIGIN_HEADER(h))
  assert.equal(noToken.status, 400)
  assert.equal(noToken.body.error.code, 'bad-request')
  const oversizedMutation = await h.post(
    JSON.stringify({ ...body, pad: 'x'.repeat(5000) }),
    ORIGIN_HEADER(h),
  )
  assert.equal(oversizedMutation.status, 400)
  assert.equal(oversizedMutation.body.error.code, 'bad-request')
})

test('both panel halves pin the same custom request header', async () => {
  // lib/memory-panel.js is served to the browser as one standalone ES module, so it
  // cannot import this route's constant. The literal is therefore duplicated, and
  // this test reads both sources and pins them equal: drift here would 403 every
  // mutation in the desktop GUI again — the exact bug this round fixes.
  assert.equal(PANEL_HEADER, 'x-obsidian-mem-panel')
  assert.equal(PANEL_HEADER_VALUE, '1')
  const client = await readFile(new URL('../lib/memory-panel.js', import.meta.url), 'utf8')
  assert.ok(client.includes('x-obsidian-mem-panel'), 'the browser half sends the header name')
  assert.ok(
    /PANEL_HEADER_VALUE\s*=\s*'1'/u.test(client),
    'the browser half sends the same header value',
  )
})

test('a stale, cross-session or expired preview never mutates', async (t) => {
  const stub = mutationStubServices()
  const h = await harness(t, { services: stub.services })
  const preview = async () =>
    (
      await h.post(
        {
          sessionId: SESSION,
          action: 'preview',
          mutation: 'retry-job',
          args: { jobId: JOB_ID },
        },
        ORIGIN_HEADER(h),
      )
    ).body.value

  const crossSession = await preview()
  const mismatch = await h.post(
    { sessionId: SESSION_TWO, action: 'confirm', token: crossSession.token },
    ORIGIN_HEADER(h),
  )
  assert.equal(mismatch.status, 409)
  assert.equal(mismatch.body.error.code, 'preview-mismatch')
  const stillValid = await h.post(
    { sessionId: SESSION, action: 'confirm', token: crossSession.token },
    ORIGIN_HEADER(h),
  )
  assert.equal(stillValid.status, 200)
  assert.equal(stillValid.body.value.replayed, false)

  // A fresh failed job so the next preview is about the stale case, not the retry
  // the cross-session case just performed.
  stub.state.job = { ...stub.state.job, state: 'failed' }
  const stale = await preview()
  stub.state.job = { ...stub.state.job, state: 'distilling' }
  const before = stub.calls.retries
  const refused = await h.post(
    { sessionId: SESSION, action: 'confirm', token: stale.token },
    ORIGIN_HEADER(h),
  )
  assert.equal(refused.status, 409)
  assert.equal(refused.body.error.code, 'preview-stale')
  assert.notEqual(refused.body.error.message, 'memory panel unavailable')
  assert.equal(stub.calls.retries, before, 'a stale preview never reaches the mutation')
})

test('compact-hot and refresh-digest preview, confirm and replay over the wire', async (t) => {
  const stub = mutationStubServices()
  const h = await harness(t, { services: stub.services })

  const hotPreview = await h.post(
    { sessionId: SESSION, action: 'preview', mutation: 'compact-hot' },
    ORIGIN_HEADER(h),
  )
  assert.equal(hotPreview.status, 200)
  assert.equal(stub.state.compacted, false)
  assert.equal(
    hotPreview.body.value.preview.facts.some((fact) => fact.label === '使用'),
    true,
  )
  const hotConfirm = await h.post(
    { sessionId: SESSION, action: 'confirm', token: hotPreview.body.value.token },
    ORIGIN_HEADER(h),
  )
  assert.equal(hotConfirm.status, 200)
  assert.equal(hotConfirm.body.value.result.status, 'compacted')
  assert.equal(hotConfirm.body.value.result.moved, 3)
  assert.equal(stub.state.compacted, true)

  const digestPreview = await h.post(
    { sessionId: SESSION, action: 'preview', mutation: 'refresh-digest', args: { days: 1 } },
    ORIGIN_HEADER(h),
  )
  assert.equal(digestPreview.status, 200)
  assert.equal(stub.state.refreshed, false, 'a digest preview must not publish')
  assert.equal(
    digestPreview.body.value.preview.facts.some((fact) => fact.value === '_meta/digest.md'),
    true,
  )
  const digestConfirm = await h.post(
    { sessionId: SESSION, action: 'confirm', token: digestPreview.body.value.token },
    ORIGIN_HEADER(h),
  )
  assert.equal(digestConfirm.status, 200)
  assert.equal(digestConfirm.body.value.result.status, 'created')
  assert.equal(digestConfirm.body.value.result.txId, 'tx-digest-1')
  assert.equal(digestConfirm.body.value.result.window.days, 1)
  assert.equal(stub.state.refreshed, true)
  const replay = await h.post(
    { sessionId: SESSION, action: 'confirm', token: digestPreview.body.value.token },
    ORIGIN_HEADER(h),
  )
  assert.equal(replay.body.value.replayed, true)
  assert.deepEqual(replay.body.value.result, digestConfirm.body.value.result)
  assert.equal(stub.calls.refreshes, 1)
})

test('mutation preconditions keep their coded status over the wire', async (t) => {
  const stub = mutationStubServices()
  const h = await harness(t, { services: stub.services })
  stub.state.job = null
  const missing = await h.post(
    {
      sessionId: SESSION,
      action: 'preview',
      mutation: 'retry-job',
      args: { jobId: JOB_ID },
    },
    ORIGIN_HEADER(h),
  )
  assert.equal(missing.status, 409)
  assert.equal(missing.body.error.code, 'job-missing')

  const foreign = mutationStubServices()
  foreign.state.job = failedJob({ projectId: OTHER_PROJECT_ID })
  const foreignHarness = await harness(t, { services: foreign.services })
  const refused = await foreignHarness.post(
    {
      sessionId: SESSION,
      action: 'preview',
      mutation: 'retry-job',
      args: { jobId: JOB_ID },
    },
    ORIGIN_HEADER(foreignHarness),
  )
  assert.equal(refused.status, 409)
  assert.equal(refused.body.error.code, 'job-foreign')

  const hotMissing = mutationStubServices()
  hotMissing.state.hot = hotView({ missing: true })
  const hotHarness = await harness(t, { services: hotMissing.services })
  const noHot = await hotHarness.post(
    { sessionId: SESSION, action: 'preview', mutation: 'compact-hot' },
    ORIGIN_HEADER(hotHarness),
  )
  assert.equal(noHot.status, 409)
  assert.equal(noHot.body.error.code, 'hot-missing')

  const fallthrough = {
    async admin(args) {
      assert.equal(args.action, 'digest')
      return { action: 'jobs', result: { jobs: [], failed: 0 } }
    },
  }
  const digestHarness = await harness(t, { services: fallthrough })
  const noDigest = await digestHarness.post(
    { sessionId: SESSION, action: 'preview', mutation: 'refresh-digest' },
    ORIGIN_HEADER(digestHarness),
  )
  assert.equal(noDigest.status, 503)
  assert.equal(noDigest.body.error.code, 'digest-unavailable')

  const unbound = await harness(t, {
    services: stub.services,
    resolveBinding: async () => ({ kind: 'unbound', reason: 'no-pointer' }),
  })
  const notBound = await unbound.post(
    { sessionId: SESSION, action: 'preview', mutation: 'compact-hot' },
    ORIGIN_HEADER(unbound),
  )
  assert.equal(notBound.status, 409)
  assert.equal(notBound.body.error.code, 'unbound')
})
