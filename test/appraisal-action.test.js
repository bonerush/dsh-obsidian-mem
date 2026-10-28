import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { validateConfig } from '../lib/config.js'
import { writeMemory } from '../lib/memory.js'
import { createMemoryServices } from '../lib/tools.js'
import { bootstrapVault } from '../lib/vault.js'

// A symlinked *file* cannot be created on a non-elevated Windows host (EPERM),
// and a junction links directories only, so the one case that needs a real file
// symlink is split out below and skipped with the measured platform reason. The
// appraisal coverage it used to share a test with — the bounded window, the
// overdue/unverified findings and every link-shape probe — keeps running on every
// platform, and the symlinked-escape assertion keeps its exact expectation on the
// platforms that can build the escape.
import { skipWithoutFileSymlink } from './platform-capabilities.js'

const PROJECT_ID = '1c392abb-7b08-42f7-871d-2a379caf9448'

/** One bootstrapped project with the notes both cases read, inside a throwaway root. */
async function fixture(t) {
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
  const valid = binding.relativeDir + '/Decisions/Target.md'
  await writeFile(join(vault, valid), '# Target\n')
  await writeFile(join(root, 'outside.md'), '# Private\n')
  const linked = await writeMemory(
    binding,
    {
      type: 'decision',
      title: 'Link audit',
      assertion: 'observed',
      body:
        '[[Target]] [[target]] [[Target.md#Heading|alias]] [[#Local heading]] [[' +
        valid +
        '|alias]] `[[code-only-missing]]`',
    },
    { dataRoot, home },
  )
  const broken = await writeMemory(
    binding,
    {
      type: 'decision',
      title: 'Broken link',
      assertion: 'observed',
      body: '[[DOES-NOT-EXIST]]',
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
  /** Write the note that links to `[[escape]]` and return it. */
  const writeEscaped = () =>
    writeMemory(
      binding,
      {
        type: 'decision',
        title: 'Jailed link',
        assertion: 'observed',
        body: '[[escape]]',
      },
      { dataRoot, home },
    )
  const appraise = () => services.admin({ action: 'appraise' }, undefined, {})
  return { root, vault, binding, linked, broken, writeEscaped, appraise }
}

test('mem_admin(action="appraise") reads a bounded recent window and returns real findings', async (t) => {
  const { writeEscaped, broken, linked, appraise } = await fixture(t)
  // `escape` names nothing in the vault here: the link is dead for a reason this
  // platform can always construct, and the link-shape probes below are what the
  // shared case is about.
  const escaped = await writeEscaped()

  const value = await appraise()
  assert.equal(value.action, 'appraise')
  assert.equal(Array.isArray(value.result.findings), true)
  const codes = value.result.findings.map((finding) => finding.code)
  assert.ok(codes.includes('review-overdue'), 'the past review_after is an error')
  assert.ok(codes.includes('unverified'), 'the missing assertion is a warning')
  assert.equal(value.result.scanned >= 2, true)
  assert.equal(value.result.truncated, false)
  const dead = value.result.findings.filter((finding) => finding.code === 'dead-link')
  assert.ok(
    dead.some((finding) => finding.path === broken.path),
    'service checks a missing target',
  )
  assert.ok(
    dead.some((finding) => finding.path === escaped.path),
    'a link to a name that is not in the vault is dead',
  )
  assert.equal(
    dead.some((finding) => finding.path === linked.path),
    false,
    'aliases, relative links, anchors, case and extension variants resolve',
  )
  for (const finding of value.result.findings) {
    assert.equal(typeof finding.path, 'string')
    assert.ok(['error', 'warn', 'info'].includes(finding.severity))
  }
})

// The escape this case is named for: a note *outside* the vault, reached through a
// symlinked inside it. It is not a resolvable vault file, and reading it would
// disclose bytes the jail exists to keep out. A file symlink is the only link kind
// that expresses it, so this runs where the host can create one.
test(
  'a wikilink through a symlinked note is a dead link, never a read outside the vault',
  { skip: skipWithoutFileSymlink() },
  async (t) => {
    const { root, vault, binding, writeEscaped, appraise } = await fixture(t)
    await symlink(
      join(root, 'outside.md'),
      join(vault, binding.relativeDir, 'Decisions', 'escape.md'),
    )
    const escaped = await writeEscaped()

    const value = await appraise()
    const dead = value.result.findings.filter((finding) => finding.code === 'dead-link')
    assert.ok(
      dead.some((finding) => finding.path === escaped.path),
      'a symlink is not a resolvable vault file',
    )
  },
)
