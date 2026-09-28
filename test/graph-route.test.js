import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createGraphActivity } from '../lib/graph-activity.js'
import { registerGraphRoute } from '../lib/graph-route.js'

const SESSION = 'session-graph-test'

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
  const dispose = registerGraphRoute(ctx, {
    activity,
    resolveBinding: async (cwd) => ({ kind: 'bound', projectId: 'project-one', cwd }),
    services: {
      indexForBinding: async (binding) => {
        calls.push(binding)
        return {
          graph: async ({ scope }) => ({
            nodes: [{ id: scope, path: 'note.md', title: 'Note', type: 'decision' }],
            edges: [],
            truncated: false,
            total: 1,
          }),
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
