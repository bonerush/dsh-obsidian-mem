// Task 2: one eligibility predicate for automatic injection (spec §3.1, P0).
//
// Automatic injection — the brief, prompt recall and a stored curation view — must
// leave a provisional note out, while explicit `mem_search` still finds it so the
// human who has to confirm it can. History (`superseded`/`archived`) keeps the
// behaviour it already had: out of the brief and out of a default search, visible
// through `includeHistory` and never a finding source.
//
// Every case builds a throwaway vault under `mkdtemp` through the shipped service
// layer, so what is under test is the same path a session start uses. Nothing here
// reads or writes the user's real vault or `~/.dsh`.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { writeCurationViewJson } from '../lib/curation-state.js'
import { VIEW_SCHEMA, buildCurationView, readCurationView } from '../lib/curation-view.js'
import { scanCuration } from '../lib/curation-scan.js'
import { promptRecall } from '../lib/prompt-recall.js'
import { resolveBinding } from '../lib/vault.js'
import { makeCurationWorld } from './curation-world.js'

/** The fixed clock, so `generatedAt` is a value the assertions can name. */
const NOW = new Date('2026-10-03T04:00:00Z')

/** The sha256 of one byte sequence, exactly as the view stores it. */
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

/** The vault-absolute path of one vault-relative path. */
const absoluteOf = (world, path) => join(world.vault, ...path.split('/'))

/**
 * A world with one active and one provisional convention.
 *
 * The pair is the whole fixture: the active note is the positive control in every
 * case, and the provisional one is the note automatic injection must not carry.
 *
 * @param {object} t - the node:test context.
 * @returns {Promise<object>} the world plus both written notes.
 */
async function seamWorld(t) {
  const world = await makeCurationWorld(t)
  const active = await world.services.write({
    type: 'convention',
    title: '导出格式',
    body: '导出时使用 JSON。',
  })
  const provisional = await world.services.write({
    type: 'convention',
    title: '习惯：中文回复',
    body: '用户要求中文回复。',
    status: 'provisional',
    assertion: 'observed',
  })
  const binding = await resolveBinding({
    cwd: world.repo,
    vaultRoot: world.vault,
    mode: 'show',
    home: world.home,
  })
  assert.equal(binding.kind, 'bound', JSON.stringify(binding))
  return { ...world, active, provisional, binding }
}

/** The recall seam the shipped service layer exposes. */
const recallSearch = (world) => (args, signal, exec) => world.services.search(args, signal, exec)

test('a provisional convention is kept out of the brief and prompt recall, and explicit search still finds it', async (t) => {
  const world = await seamWorld(t)

  const brief = await world.services.brief({})
  assert.ok(brief.text.includes('导出格式'), 'the active convention is current guidance')
  assert.equal(
    brief.text.includes('习惯：中文回复'),
    false,
    'a provisional convention is not injected',
  )

  // Explicit search is unchanged — the quarantined note stays discoverable,
  // because the human who must confirm it finds it this way.
  const found = await world.services.search({ query: '中文回复' })
  const hit = found.find((candidate) => candidate.path === world.provisional.path)
  assert.ok(hit !== undefined, JSON.stringify(found.map((candidate) => candidate.path)))
  assert.equal(hit.status, 'provisional')

  // Prompt recall must not offer it back: the hit is real, and it is refused.
  const quarantined = await promptRecall({
    prompt: '中文回复',
    seenPaths: new Set(),
    maxChars: 900,
    search: recallSearch(world),
  })
  assert.equal(quarantined.text, null, JSON.stringify(quarantined))
  assert.deepEqual(quarantined.paths, [])

  // The positive control: the same seam fires for the active convention, so the
  // silence above is about the status rather than about recall being broken.
  const active = await promptRecall({
    prompt: '导出格式',
    seenPaths: new Set(),
    maxChars: 900,
    search: recallSearch(world),
  })
  assert.equal(active.outcome, 'fired', JSON.stringify(active))
  assert.deepEqual(active.paths, [world.active.path])
})

test('a provisional convention never stands for a stored-view entry', async (t) => {
  const world = await seamWorld(t)
  const scan = await scanCuration(world.binding, {
    dataRoot: world.dataRoot,
    maxNotes: 1000,
    maxMs: 60_000,
    home: world.home,
    now: NOW,
  })
  assert.equal(scan.complete, true)
  // The scanner reports the note as an entry: the exclusion under test belongs to
  // the view, not to the scan.
  assert.ok(scan.entries.some((entry) => entry.path === world.provisional.path))

  const built = await buildCurationView({
    binding: world.binding,
    dataRoot: world.dataRoot,
    scan,
    now: NOW,
  })
  assert.equal(built.status, 'written')

  const view = await readCurationView({
    dataRoot: world.dataRoot,
    projectId: world.binding.projectId,
  })
  assert.equal(
    view.entries.some((entry) => entry.paths.includes(world.provisional.path)),
    false,
    'a provisional note must not stand for an injectable fact',
  )
  assert.ok(
    view.entries.some((entry) => entry.paths.includes(world.active.path)),
    'the active convention still stands for one',
  )

  const brief = await world.services.brief({})
  assert.equal(brief.text.includes(world.provisional.path), false)
})

test('a stored view an older version wrote cannot inject a provisional entry either', async (t) => {
  const world = await seamWorld(t)
  const hashOf = async (path) => sha256(await readFile(absoluteOf(world, path)))
  const entryFor = async (written, status) => {
    const hash = await hashOf(written.path)
    return {
      path: written.path,
      hash,
      paths: [written.path],
      sourceHashes: [hash],
      exactKey: null,
      id: written.id,
      type: 'convention',
      title: status === 'provisional' ? '习惯：中文回复' : '导出格式',
      status,
      description: status === 'provisional' ? '用户要求中文回复。' : '导出时使用 JSON。',
    }
  }
  // The consumer-side defence: a view built before this fix (or edited by hand)
  // can carry a provisional entry, and the brief must not trust it.
  await writeCurationViewJson(world.dataRoot, world.binding.projectId, {
    version: VIEW_SCHEMA,
    projectId: world.binding.projectId,
    complete: true,
    generatedAt: NOW.toISOString(),
    entries: [
      await entryFor(world.provisional, 'provisional'),
      await entryFor(world.active, 'active'),
    ],
  })

  const brief = await world.services.brief({})
  assert.equal(brief.text.includes(world.provisional.path), false, brief.text)
  assert.equal(brief.text.includes('习惯：中文回复'), false)
})
