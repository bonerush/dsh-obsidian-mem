import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { validateConfig } from '../lib/config.js'
import { writeMemory } from '../lib/memory.js'
import { createMemoryServices } from '../lib/tools.js'
import { bootstrapVault } from '../lib/vault.js'

const PROJECT_ID = '1c392abb-7b08-42f7-871d-2a379caf9448'

test('mem_admin(action="appraise") reads a bounded recent window and returns real findings', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'obsidian-mem-appraise-action-'))
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
      title: '候选决策',
      body: 'A claim that needs review.',
      review_after: '2026-01-01',
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

  const value = await services.admin({ action: 'appraise' }, undefined, {})
  assert.equal(value.action, 'appraise')
  assert.equal(Array.isArray(value.result.findings), true)
  const codes = value.result.findings.map((finding) => finding.code)
  assert.ok(codes.includes('review-overdue'), 'the past review_after is an error')
  assert.ok(codes.includes('unverified'), 'the missing assertion is a warning')
  assert.equal(value.result.scanned >= 2, true)
  assert.equal(value.result.truncated, false)
  for (const finding of value.result.findings) {
    assert.equal(typeof finding.path, 'string')
    assert.ok(['error', 'warn', 'info'].includes(finding.severity))
  }
})
