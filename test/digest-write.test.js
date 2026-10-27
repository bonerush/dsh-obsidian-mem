import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { validateConfig } from '../lib/config.js'
import { renderDigestNote, writeDigestNote } from '../lib/digest-write.js'
import { writeMemory } from '../lib/memory.js'
import { createMemoryServices } from '../lib/services.js'
import { bootstrapVault } from '../lib/vault.js'

const PROJECT_ID = '1c392abb-7b08-42f7-871d-2a379caf9448'
const NOTE = 'Projects/demo--1c392abb/_meta/digest.md'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'obsidian-mem-digest-write-'))
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
  return { root, dataRoot, home, vault, binding, services }
}

test('the owned digest writer creates, no-ops and updates one project note', async (t) => {
  const world = await fixture(t)
  await writeMemory(
    world.binding,
    { type: 'decision', title: 'Digest write', assertion: 'observed', body: 'Evidence.' },
    { dataRoot: world.dataRoot, home: world.home },
  )
  const digest = await world.services.admin({ action: 'digest', days: 1 }, undefined, {})
  assert.equal(digest.action, 'digest')

  const first = await writeDigestNote(world.binding, digest.result, {
    dataRoot: world.dataRoot,
    home: world.home,
    now: new Date('2026-10-27T12:00:00Z'),
  })
  assert.equal(first.status, 'created')
  assert.equal(first.path, NOTE)
  assert.equal(first.charCount > 0, true)
  assert.equal(first.charCount <= 8000, true)
  const note = await readFile(join(world.vault, NOTE), 'utf8')
  assert.match(note, /^---\n/iu)
  assert.match(note, /trust: agent/u)
  assert.match(note, /harness: dsh/u)
  assert.match(note, /generated_by: dsh-obsidian-mem/u)

  const second = await writeDigestNote(world.binding, digest.result, {
    dataRoot: world.dataRoot,
    home: world.home,
    now: new Date('2026-10-27T12:00:01Z'),
  })
  assert.equal(second.status, 'unchanged')
  assert.equal(second.txId, null)

  await writeMemory(
    world.binding,
    { type: 'decision', title: 'Digest write 2', assertion: 'observed', body: 'More.' },
    { dataRoot: world.dataRoot, home: world.home },
  )
  const changed = await world.services.admin({ action: 'digest', days: 1 }, undefined, {})
  const third = await writeDigestNote(world.binding, changed.result, {
    dataRoot: world.dataRoot,
    home: world.home,
    now: new Date('2026-10-27T12:00:02Z'),
  })
  assert.equal(third.status, 'updated')
  assert.equal(typeof third.txId, 'string')

  const refreshed = await world.services.admin(
    { action: 'digest', operation: 'refresh', days: 1 },
    undefined,
    {},
  )
  assert.equal(refreshed.action, 'digest')
  assert.equal(refreshed.result.publication.status, 'unchanged')
})

test('a human-owned target is refused, never replaced', async (t) => {
  const world = await fixture(t)
  const digest = await world.services.admin({ action: 'digest', days: 1 }, undefined, {})
  const absolute = join(world.vault, NOTE)
  await mkdir(join(world.vault, 'Projects/demo--1c392abb/_meta'), { recursive: true })
  await writeFile(absolute, '---\ntrust: owner\n---\n# Human digest\n')
  await assert.rejects(
    () =>
      writeDigestNote(world.binding, digest.result, { dataRoot: world.dataRoot, home: world.home }),
    /human-owned|ownership/u,
  )
  assert.equal(await readFile(absolute, 'utf8'), '---\ntrust: owner\n---\n# Human digest\n')
})

test('rendering is pure and refuses a note over the code-point ceiling', () => {
  const digest = {
    window: { days: 1, from: '2026-10-26T00:00:00Z', to: '2026-10-27T00:00:00Z' },
    notes: { created: 1, updated: 0, superseded: 0, byType: [] },
    hot: null,
    queue: null,
    appraisal: null,
    recent: [],
    snapshot: { at: '2026-10-27T00:00:00Z' },
    collection: { inspected: 1, truncated: false, incomplete: false, reasons: [] },
  }
  const text = renderDigestNote(digest, {
    project: { projectId: PROJECT_ID },
    id: 'doc-11111111-1111-4111-8111-111111111111',
    created: '2026-10-27',
    now: new Date('2026-10-27T12:00:00Z'),
  })
  assert.match(text, /项目摘要/u)

  const huge = {
    ...digest,
    recent: Array.from({ length: 200 }, (_, index) => ({
      path: 'Projects/demo--1c392abb/Docs/note-' + index + '.md',
      title: 'Note ' + index + ' ' + 'x'.repeat(80),
      updated: '2026-10-27',
    })),
  }
  assert.throws(
    () =>
      renderDigestNote(huge, {
        project: { projectId: PROJECT_ID },
        id: 'doc-11111111-1111-4111-8111-111111111111',
        created: '2026-10-27',
        now: new Date('2026-10-27T12:00:00Z'),
      }),
    (error) => error.code === 'digest-too-large',
  )
})
