import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createGraphActivity } from '../lib/graph-activity.js'
import { registerGraphRoute } from '../lib/graph-route.js'
import { registerPanelRoute } from '../lib/panel-route.js'

const SESSION = 'session-graph-test'

test('every module imported by the renderer is served by the registered routes', async (t) => {
  const routes = new Map()
  const webServer = {
    register: (route) => {
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  }
  const dispose = registerGraphRoute({ webServer })
  // The memory panel is a second route (and the shell imports its one module by
  // URL), so the asset walk must register it too or the panel's module looks like
  // a 404. The POST handler is not exercised here; only the asset route is.
  const disposePanel = registerPanelRoute(
    { webServer, sessions: { get: () => undefined } },
    { services: {}, resolveBinding: async () => ({ kind: 'unbound', reason: 'no-pointer' }) },
  )
  t.after(disposePanel)
  t.after(dispose)
  const server = createServer((request, response) => {
    const route = routes.get(request.url)
    if (route) return route.handler(request, response)
    response.writeHead(404)
    response.end('missing asset route')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => server.close())
  const origin = 'http://127.0.0.1:' + server.address().port
  const visited = new Set()
  const load = async (url) => {
    if (visited.has(url)) return
    visited.add(url)
    const response = await fetch(url)
    assert.equal(response.status, 200, 'the browser must be able to load ' + new URL(url).pathname)
    assert.match(response.headers.get('content-type'), /javascript/u)
    const source = await response.text()
    for (const match of source.matchAll(/\bfrom\s*['"]([^'"]+)['"]/gu)) {
      await load(new URL(match[1], url).href)
    }
    assert.equal(
      (await fetch(url, { headers: { origin: 'https://evil.example' } })).status,
      403,
      'every imported module keeps the same-origin fence',
    )
  }
  await load(origin + '/obsidian-mem/graph-renderer.js')
  // `lib/client.js` is delivered by the client-module system rather than this route,
  // but it names the browser modules by URL: asking for one that has no route is a
  // 404 in the middle of the panel, so every URL it names is loaded here too.
  const client = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  for (const match of client.matchAll(/['"]\/obsidian-mem\/([\w.-]+\.js)['"]/gu)) {
    await load(origin + '/obsidian-mem/' + match[1])
  }
})

test('graph route serves only same-origin requests for a live session', async (t) => {
  const routes = new Map()
  const activity = createGraphActivity()
  const session = { header: { id: SESSION, cwd: '/work/demo' } }
  const ctx = {
    sessions: { get: (id) => (id === SESSION ? session : undefined) },
    webServer: {
      register: (route) => {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
  }
  const calls = []
  /** What the route asked the index for, which is the uncapped claim under test. */
  const asked = []
  const dispose = registerGraphRoute(ctx, {
    activity,
    resolveBinding: async (cwd) => ({ kind: 'bound', projectId: 'project-one', cwd }),
    services: {
      indexForBinding: async (binding) => {
        calls.push(binding)
        return {
          graph: async (options) => {
            asked.push(options)
            return {
              nodes: [{ id: options.scope, path: 'note.md', title: 'Note', type: 'decision' }],
              edges: [],
              truncated: false,
              total: 1,
            }
          },
        }
      },
    },
  })
  assert.ok(routes.has('/obsidian-mem/graph'))
  assert.ok(routes.has('/obsidian-mem/graph-worker.js'))
  assert.ok(routes.has('/obsidian-mem/graph-renderer.js'))
  const server = createServer((request, response) =>
    routes.get(request.url).handler(request, response),
  )
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => server.close())
  const url = `http://127.0.0.1:${server.address().port}/obsidian-mem/graph`
  const post = async (payload, headers = {}) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(payload),
    })
    return { status: response.status, body: await response.json() }
  }

  const graph = await post({ sessionId: SESSION, scope: 'project' })
  assert.equal(graph.status, 200)
  assert.equal(graph.body.value.nodes[0].id, 'project')
  assert.equal(calls[0].projectId, 'project-one')
  assert.equal(calls[0].cwd, '/work/demo')
  // 图谱 draws every node in scope, so the route may not pass a cap. Asserted on the
  // options the index actually received, not on the source text: a limit added here
  // would silently hide nodes again and the reply would still be a valid one.
  assert.deepEqual(asked, [{ scope: 'project' }], 'the route asks for the whole graph')
  await post({ sessionId: SESSION, scope: 'all' })
  assert.deepEqual(asked.at(-1), { scope: 'all' }, 'and for the all-scope graph too')

  activity.record(SESSION, ['note.md'], 'read')
  const events = await post({ sessionId: SESSION, action: 'activity', cursor: 0 })
  assert.equal(events.body.value.events[0].path, 'note.md')
  assert.equal((await post({ sessionId: 'unknown' })).status, 404)
  assert.equal((await post({ sessionId: SESSION }, { origin: 'https://evil.example' })).status, 403)
  const workerUrl = url.replace(/graph$/u, 'graph-worker.js')
  const worker = await fetch(workerUrl)
  assert.equal(worker.status, 200)
  assert.match(worker.headers.get('content-type'), /javascript/u)
  assert.match(await worker.text(), /self.onmessage/u)
  assert.equal(
    (await fetch(workerUrl, { headers: { origin: 'https://evil.example' } })).status,
    403,
  )
  const rendererUrl = url.replace(/graph$/u, 'graph-renderer.js')
  const renderer = await fetch(rendererUrl)
  assert.equal(renderer.status, 200)
  assert.match(await renderer.text(), /export function createGraphRenderer/u)
  assert.equal(
    (await fetch(rendererUrl, { headers: { origin: 'https://evil.example' } })).status,
    403,
  )
  dispose()
  assert.equal(routes.size, 0)
})

test('an unbound graph reply names the refusal reason', async (t) => {
  const routes = new Map()
  const ctx = {
    sessions: { get: () => ({ header: { id: SESSION, cwd: '/work/demo' } }) },
    webServer: {
      register: (route) => {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
  }
  const dispose = registerGraphRoute(ctx, {
    activity: createGraphActivity(),
    resolveBinding: async () => ({ kind: 'unbound', reason: 'no-pointer' }),
    services: {
      indexForBinding: async () => {
        throw new Error('an unbound project must not open an index')
      },
    },
  })
  t.after(dispose)
  const server = createServer((request, response) =>
    routes.get(request.url).handler(request, response),
  )
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => server.close())
  const response = await fetch(`http://127.0.0.1:${server.address().port}/obsidian-mem/graph`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: SESSION, scope: 'project' }),
  })
  const envelope = await response.json()
  assert.equal(response.status, 200)
  assert.equal(envelope.value.unbound, true)
  assert.equal(envelope.value.reason, 'no-pointer')
})

test('a changed asset is served without re-registering the route', async (t) => {
  // Registration runs once per plugin load. A buffer captured there would keep the
  // browser on the previous build after `lib/` changed, so the handler re-reads.
  const root = await mkdtemp(join(tmpdir(), 'obsidian-mem-asset-'))
  const file = join(root, 'graph-renderer.js')
  await writeFile(file, 'export const build = 1\n')
  t.after(() => rm(root, { recursive: true, force: true }))
  const routes = new Map()
  const ctx = {
    sessions: { get: () => undefined },
    webServer: {
      register: (route) => {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
  }
  registerGraphRoute(ctx, {
    activity: createGraphActivity(),
    resolveBinding: async () => null,
    services: { indexForBinding: async () => ({ graph: async () => ({ nodes: [], edges: [] }) }) },
    assets: [file],
  })
  const server = createServer((request, response) =>
    routes.get(request.url).handler(request, response),
  )
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => server.close())
  const url = 'http://127.0.0.1:' + server.address().port + '/obsidian-mem/graph-renderer.js'
  assert.equal(await (await fetch(url)).text(), 'export const build = 1\n')
  await writeFile(file, 'export const build = 2\n')
  assert.equal(await (await fetch(url)).text(), 'export const build = 2\n')
})
