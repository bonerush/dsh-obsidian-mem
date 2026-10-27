import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { validateConfig } from '../lib/config.js'
import { registerPanelRoute } from '../lib/panel-route.js'
import { writeMemory } from '../lib/memory.js'
import { resolveScope } from '../lib/search.js'
import { createMemoryServices } from '../lib/services.js'
import { bootstrapVault } from '../lib/vault.js'

const PROJECT_ID = '1c392abb-7b08-42f7-871d-2a379caf9448'
const SESSION = 'panel-digest-session'

test('the health route serves a non-null digest from the real service', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'obsidian-mem-panel-digest-'))
  const dataRoot = join(root, 'data')
  const home = join(root, 'home')
  const vault = join(root, 'vault')
  await mkdir(dataRoot, { recursive: true })
  await mkdir(home, { recursive: true })
  const binding = {
    kind: 'bound',
    projectId: PROJECT_ID,
    slug: 'demo',
    displayName: 'Demo',
    schema: 1,
    vaultRoot: vault,
    relativeDir: 'Projects/demo--1c392abb',
  }
  await bootstrapVault(binding, { dataRoot, home })
  await writeMemory(
    binding,
    {
      type: 'decision',
      title: 'Panel digest',
      assertion: 'observed',
      body: 'Visible [[missing-panel-target]] link.',
    },
    { dataRoot, home },
  )
  const services = createMemoryServices({
    config: validateConfig({ vaultPath: vault }),
    dataRoot,
    home,
    binding,
  })
  t.after(async () => {
    await services.close?.()
    await rm(root, { recursive: true, force: true, maxRetries: 4 })
  })

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
        get: (id) => (id === SESSION ? { header: { id, cwd: root } } : undefined),
      },
    },
    {
      services,
      resolveBinding: async () => binding,
      scopeOf: resolveScope,
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
  const response = await fetch(origin + '/obsidian-mem/panel', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: SESSION, action: 'health' }),
  })
  const body = await response.json()
  assert.equal(response.status, 200)
  assert.equal(body.ok, true)
  assert.notEqual(body.value.digest, null)
  assert.equal(body.value.digest.window.days, 1)
  assert.equal(body.value.digest.notes.created >= 1, true)
  assert.equal(body.value.digest.collection.inspected >= 1, true)
  assert.equal(
    body.value.digest.appraisal.findings.some((finding) => finding.code === 'dead-link'),
    true,
  )
})
