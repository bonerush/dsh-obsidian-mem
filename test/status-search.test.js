import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openIndex } from '../lib/index-db.js'
import { searchNotes, resolveScope } from '../lib/search.js'
import { registerPanelRoute } from '../lib/panel-route.js'

const PROJECT = '11111111-1111-4111-8111-111111111111'
const DIRECTORY = 'Projects/alpha--11111111/Decisions'
const note = (status) =>
  '---\ntype: decision\ntitle: binding 中\nstatus: ' +
  status +
  '\nproject: ' +
  PROJECT +
  '\n---\nbinding 中\n'

for (const backend of ['sqlite', 'scan']) {
  test(`exact status matches beyond 50 other hits and rechecks changed source (${backend})`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'obsidian-mem-status-search-'))
    const vault = join(root, 'vault')
    await mkdir(join(vault, DIRECTORY), { recursive: true })
    for (let i = 0; i < 60; i += 1)
      await writeFile(join(vault, DIRECTORY, 'a-' + i + '.md'), note('active'))
    const path = DIRECTORY + '/z-provisional.md'
    await writeFile(join(vault, path), note('provisional'))
    const index = await openIndex({
      vaultRoot: vault,
      dataRoot: join(root, 'data'),
      projectId: PROJECT,
      backend,
    })
    t.after(async () => {
      await index.close()
      await rm(root, { recursive: true, force: true })
    })
    await index.waitReady(undefined, 5000)
    for (const query of ['binding', '中']) {
      const hits = await searchNotes(index, { query, status: 'provisional', limit: 5 })
      assert.deepEqual(
        hits.map((hit) => hit.path),
        [path],
      )
      assert.equal(hits.truncated, false)
      assert.equal(hits.candidatesScored, 1)
    }
    let route
    const dispose = registerPanelRoute(
      {
        webServer: {
          register: (value) => {
            if (value.path === '/obsidian-mem/panel') route = value
            return () => {}
          },
        },
        sessions: { get: () => ({ header: { id: 's', cwd: root } }) },
      },
      {
        services: { indexForBinding: async () => index },
        resolveBinding: async () => ({ kind: 'bound', vaultRoot: vault, projectId: PROJECT }),
        scopeOf: resolveScope,
      },
    )
    t.after(dispose)
    const bytes = Buffer.from(
      JSON.stringify({
        sessionId: 's',
        action: 'search',
        query: 'binding',
        status: 'provisional',
        limit: 5,
      }),
    )
    let value
    await route.handler(
      {
        method: 'POST',
        headers: { host: '127.0.0.1' },
        socket: { remoteAddress: '127.0.0.1' },
        async *[Symbol.asyncIterator]() {
          yield bytes
        },
      },
      {
        writeHead() {},
        end(text) {
          value = JSON.parse(text)
        },
      },
    )
    assert.deepEqual(
      value.value.hits.map((hit) => hit.path),
      [path],
      'the real panel route reaches the rare status',
    )
    assert.equal(value.value.hasMore, false)
    await writeFile(join(vault, path), note('active'))
    const stale = await searchNotes(index, { query: 'binding', status: 'provisional', limit: 5 })
    assert.equal(stale.length, 0, 'source status is rechecked after candidate filtering')
  })
}
