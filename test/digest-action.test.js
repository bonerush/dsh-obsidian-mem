import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { validateConfig } from '../lib/config.js'
import { writeMemory } from '../lib/memory.js'
import { createMemoryServices } from '../lib/services.js'
import { bootstrapVault } from '../lib/vault.js'

const PROJECT_ID = '1c392abb-7b08-42f7-871d-2a379caf9448'

test('mem_admin(action="digest") reads one bounded window through the real service', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'obsidian-mem-digest-action-'))
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
      title: 'Digest decision',
      assertion: 'observed',
      body: 'A current claim with [[missing-target]] evidence.',
    },
    { dataRoot, home, now: new Date('2026-10-27T12:00:00Z') },
  )
  const services = createMemoryServices({
    config: validateConfig({ vaultPath: vault }),
    dataRoot,
    home,
    binding,
    // Two refreshes must be a byte-for-byte no-op; pin the day so the assertion
    // is about the rendered note, not about the UTC date the suite runs on.
    clock: () => new Date('2026-10-27T12:00:00Z'),
  })
  t.after(async () => {
    await services.close?.()
    await rm(root, { recursive: true, force: true, maxRetries: 4 })
  })

  const value = await services.admin({ action: 'digest', days: 1 }, undefined, {})
  assert.equal(value.action, 'digest')
  assert.deepEqual(Object.keys(value.result).sort(), [
    'appraisal',
    'collection',
    'hot',
    'notes',
    'queue',
    'recent',
    'snapshot',
    'window',
  ])
  assert.equal(value.result.window.days, 1)
  assert.equal(value.result.notes.created >= 1, true)
  assert.equal(value.result.recent.length <= 8, true)
  assert.equal(value.result.collection.inspected >= 1, true)
  assert.equal(value.result.collection.incomplete, false)
  assert.equal(value.result.hot.missing, false)
  assert.deepEqual(Object.keys(value.result.queue).sort(), ['deferred', 'failed', 'queued'])
  assert.equal(
    value.result.appraisal.findings.some((finding) => finding.code === 'dead-link'),
    true,
  )

  await assert.rejects(() => services.admin({ action: 'digest', days: 31 }), RangeError)
  const refreshed = await services.admin({ action: 'digest', operation: 'refresh' }, undefined, {})
  assert.equal(refreshed.result.publication.status, 'created')
  assert.equal(refreshed.result.publication.path, binding.relativeDir + '/_meta/digest.md')
  const unchanged = await services.admin({ action: 'digest', operation: 'refresh' }, undefined, {})
  assert.equal(unchanged.result.publication.status, 'unchanged')
})
