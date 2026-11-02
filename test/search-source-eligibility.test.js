// Task 6: a repaired candidate is re-matched against the query, but it is not
// re-filtered against the search scope. These cases pin the contract the other
// way: a source that changed its status/type/project while the cached row still
// held the old one must not survive the repair and be returned under the stale
// filter. The read-before-trust repair still lands — a later search sees the
// fresh facts — because the row is repaired, only the hit is dropped.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

import { openIndex } from '../lib/index-db.js'
import { searchNotes } from '../lib/search.js'

import { registerTreeCleanup } from './platform-capabilities.js'

/** The project every fixture note belongs to. */
const PROJECT_ID = '5f1b2d3c-4a6e-4f70-8b91-a2c3d4e5f6a7'
const PROJECT_DIR = `Projects/elig--${PROJECT_ID.slice(0, 8)}`

/** Vault-relative path of a note whose project-relative path is `relative`. */
const projectPath = (relative) => `${PROJECT_DIR}/${relative}`

/** Render one note as the Markdown the index parses. */
function renderNote(note) {
  return [
    '---',
    `type: "${note.type ?? 'doc'}"`,
    `title: ${JSON.stringify(note.title)}`,
    `status: "${note.status ?? 'active'}"`,
    `project: "${note.project ?? PROJECT_ID}"`,
    '---',
    '',
    `# ${note.title}`,
    '',
    note.body,
    '',
  ].join('\n')
}

/** A throwaway vault with the given notes, plus its open index. */
async function makeVault(t, notes) {
  const root = await mkdtemp(join(tmpdir(), 'obsidian-mem-t6-source-'))
  const vault = join(root, 'vault')
  const dataRoot = join(root, 'data')
  await mkdir(dataRoot, { recursive: true })
  const write = async (note) => {
    const absolute = join(vault, ...projectPath(note.path).split('/'))
    await mkdir(dirname(absolute), { recursive: true })
    await writeFile(absolute, renderNote(note))
    return absolute
  }
  const files = new Map()
  for (const note of notes) files.set(note.path, await write(note))
  const index = await openIndex({
    vaultRoot: vault,
    dataRoot,
    backend: 'sqlite',
    projectId: PROJECT_ID,
  })
  const onCleanup = registerTreeCleanup(t, root)
  onCleanup(() => index.close().catch(() => {}))
  const ready = await index.waitReady(undefined, 10_000)
  assert.equal(ready.ready, true, `index did not become ready: ${JSON.stringify(ready)}`)
  return { vault, index, write, files }
}

/** The paths of a hit list, in returned order. */
const hitPaths = (hits) => hits.map((hit) => hit.path)

test('a source edited from active to superseded is not returned by a default search', async (t) => {
  const { index, write } = await makeVault(t, [
    {
      path: 'Pitfalls/race.md',
      type: 'gotcha',
      title: '缓存失效竞态',
      body: '缓存失效要按内容哈希判断。',
    },
  ])
  const before = await searchNotes(index, { query: '缓存失效', scope: 'project' })
  assert.deepEqual(hitPaths(before), [projectPath('Pitfalls/race.md')])
  assert.equal(before[0].status, 'active')

  // The source changes; the cached row still says active, so the candidate is in
  // the window and verifyCandidate is the only gate left.
  await write({
    path: 'Pitfalls/race.md',
    type: 'gotcha',
    title: '缓存失效竞态',
    body: '缓存失效要按内容哈希判断。',
    status: 'superseded',
  })

  const after = await searchNotes(index, { query: '缓存失效', scope: 'project' })
  assert.deepEqual(hitPaths(after), [], 'a repaired superseded note must not be returned')

  // The repair itself still happened: an explicit history search sees the fresh
  // status without a refresh pass.
  const history = await searchNotes(index, {
    query: '缓存失效',
    scope: 'project',
    includeHistory: true,
  })
  assert.deepEqual(hitPaths(history), [projectPath('Pitfalls/race.md')])
  assert.equal(history[0].status, 'superseded')
})

test('a note edited from decision to gotcha is not returned under the decision filter', async (t) => {
  const { index, write } = await makeVault(t, [
    {
      path: 'Decisions/engine.md',
      type: 'decision',
      title: '检索引擎选择',
      body: '选择词法检索作为默认引擎。',
    },
  ])
  const before = await searchNotes(index, { query: '检索', scope: 'project', type: 'decision' })
  assert.deepEqual(hitPaths(before), [projectPath('Decisions/engine.md')])

  await write({
    path: 'Decisions/engine.md',
    type: 'gotcha',
    title: '检索引擎选择',
    body: '选择词法检索作为默认引擎。',
  })

  const stale = await searchNotes(index, { query: '检索', scope: 'project', type: 'decision' })
  assert.deepEqual(hitPaths(stale), [], 'a repaired type change must not survive the type filter')

  // Reindexed, not merely dropped: the same repaired row is found as its new type.
  const fresh = await searchNotes(index, { query: '检索', scope: 'project', type: 'gotcha' })
  assert.deepEqual(hitPaths(fresh), [projectPath('Decisions/engine.md')])
  assert.equal(fresh[0].type, 'gotcha')
})

test('a note edited into another project is not returned by a project-scoped search', async (t) => {
  const OTHER_ID = '9a8b7c6d-5e4f-4031-8293-a4b5c6d7e8f9'
  const { index, write } = await makeVault(t, [
    {
      path: 'Docs/scope.md',
      title: '作用域边界',
      body: '作用域边界只在项目内检索。',
    },
  ])
  const before = await searchNotes(index, { query: '作用域', scope: 'project' })
  assert.deepEqual(hitPaths(before), [projectPath('Docs/scope.md')])

  await write({
    path: 'Docs/scope.md',
    title: '作用域边界',
    body: '作用域边界只在项目内检索。',
    project: OTHER_ID,
  })

  const stale = await searchNotes(index, { query: '作用域', scope: 'project' })
  assert.deepEqual(hitPaths(stale), [], 'a repaired project move must leave the project scope')

  // Cross-project search is a different scope and still sees the repaired row.
  const all = await searchNotes(index, { query: '作用域', scope: 'all' })
  assert.deepEqual(hitPaths(all), [projectPath('Docs/scope.md')])
})
