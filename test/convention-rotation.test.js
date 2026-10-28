// Spec §2: rotate the convention preview across sessions.
//
// The pure selection is tested first (anchored windows, wrap, N<=5, missing
// anchor), then the private cursor's compare-and-swap: a stale acknowledgement
// never skips another window, concurrent preparations may repeat a window, a
// corrupt state resets to the first eligible unit, and the file holds only
// schema/revision/fingerprint/hashed anchor under dataRoot/cursors/.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  CONVENTION_PREVIEW_LIMIT,
  CONVENTION_STATE_MAX_BYTES,
  advanceConventionCursor,
  conventionCursorPath,
  conventionUnitHash,
  inventoryFingerprint,
  prepareConventionPreview,
  readConventionCursor,
  rotateConventions,
} from '../lib/convention-rotation.js'
import {
  assertPrivateDirectory,
  assertPrivateFile,
  createDirectoryLink,
  skipWithoutDirectorySymlink,
} from './platform-capabilities.js'

const PROJECT_ID = '1c392abb-7b08-42f7-871d-2a379caf9448'
const UNITS = Array.from({ length: 12 }, (_, i) => `- [[Conventions/约定-${i + 1}|约定 ${i + 1}]]`)

/**
 * A throwaway vault root and a bound identity. The cursor lives under
 * <dataRoot>/cursors, never in the vault.
 *
 * @param {object} t - the node:test context.
 * @returns {Promise<object>} the fixture.
 */
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'obsidian-mem-rotation-'))
  const vault = join(root, 'vault')
  const dataRoot = join(root, 'data')
  await mkdir(vault, { recursive: true })
  await mkdir(dataRoot, { recursive: true })
  t.after(async () => rm(root, { recursive: true, force: true, maxRetries: 4 }))
  return {
    root,
    vault,
    dataRoot,
    binding: {
      kind: 'bound',
      projectId: PROJECT_ID,
      vaultRoot: vault,
      relativeDir: `Projects/demo--${PROJECT_ID.slice(0, 8)}`,
      displayName: 'Demo',
    },
  }
}

const linesOf = (selection) => selection.map((entry) => entry.line)

// ---------------------------------------------------------------------------
// Pure rotation
// ---------------------------------------------------------------------------

test('the first preview starts at the first eligible unit and selects five', () => {
  const selection = rotateConventions({ units: UNITS, anchorHash: null })
  assert.equal(selection.selected.length, CONVENTION_PREVIEW_LIMIT)
  assert.deepEqual(linesOf(selection.selected), UNITS.slice(0, 5))
  assert.equal(selection.wrapped, false)
  assert.equal(selection.anchorHash, conventionUnitHash(UNITS[4]))
})

test('the next preview starts after the persisted anchor', () => {
  const anchor = conventionUnitHash(UNITS[4])
  const selection = rotateConventions({ units: UNITS, anchorHash: anchor })
  assert.deepEqual(linesOf(selection.selected), UNITS.slice(5, 10))
  assert.equal(selection.wrapped, false)
})

test('a window at the end wraps to the start instead of shrinking the preview', () => {
  const anchor = conventionUnitHash(UNITS[10])
  const selection = rotateConventions({ units: UNITS, anchorHash: anchor })
  assert.deepEqual(linesOf(selection.selected), [...UNITS.slice(11), ...UNITS.slice(0, 4)])
  assert.equal(selection.wrapped, true)
  assert.equal(selection.selected.length, CONVENTION_PREVIEW_LIMIT)
})

test('a missing anchor resumes at the first eligible unit', () => {
  const selection = rotateConventions({
    units: UNITS,
    anchorHash: conventionUnitHash('- [[Conventions/已删除|已删除]]'),
  })
  assert.deepEqual(linesOf(selection.selected), UNITS.slice(0, 5))
})

test('an inventory of at most five renders all of it in MOC order, unchanged by rotation', () => {
  const small = UNITS.slice(0, 4)
  const selection = rotateConventions({ units: small, anchorHash: conventionUnitHash(small[1]) })
  assert.deepEqual(linesOf(selection.selected), small)
  assert.equal(selection.anchorHash, conventionUnitHash(small[3]))
})

test('the inventory fingerprint is stable for identical bytes and changes when any unit changes', () => {
  const fingerprint = inventoryFingerprint(UNITS)
  assert.equal(fingerprint, inventoryFingerprint([...UNITS]))
  assert.notEqual(fingerprint, inventoryFingerprint([...UNITS.slice(1), '- [[Conventions/新|新]]']))
})

// ---------------------------------------------------------------------------
// Coverage under a stable inventory
// ---------------------------------------------------------------------------

test('ceil(N/5) serial acknowledged starts cover a stable inventory', async (t) => {
  const env = await fixture(t)
  const seen = new Set()
  const starts = Math.ceil(UNITS.length / CONVENTION_PREVIEW_LIMIT)
  for (let round = 0; round < starts; round += 1) {
    const preview = await prepareConventionPreview({
      binding: env.binding,
      dataRoot: env.dataRoot,
      units: UNITS,
    })
    assert.equal(preview.lines.length, CONVENTION_PREVIEW_LIMIT)
    for (const line of preview.lines) seen.add(line)
    const advanced = await advanceConventionCursor({
      binding: env.binding,
      dataRoot: env.dataRoot,
      expectedRevision: preview.rotation.revision,
      fingerprint: preview.rotation.fingerprint,
      anchorHash: preview.rotation.anchorHash,
    })
    assert.equal(advanced.advanced, true)
  }
  assert.equal(
    seen.size,
    UNITS.length,
    'every convention appeared within ceil(N/5) acknowledged starts',
  )
})

// ---------------------------------------------------------------------------
// The private cursor: CAS, concurrency, corruption, bounds
// ---------------------------------------------------------------------------

test('the cursor lives under cursors/<vaultHash>/<projectId> with private modes and only four fields', async (t) => {
  const env = await fixture(t)
  const preview = await prepareConventionPreview({
    binding: env.binding,
    dataRoot: env.dataRoot,
    units: UNITS,
  })
  const path = conventionCursorPath({
    dataRoot: env.dataRoot,
    vaultHash: preview.rotation.vaultHash,
    projectId: PROJECT_ID,
  })
  // The path shape the spec names, not a vault path.
  assert.match(path, /cursors[/\\][0-9a-f]{64}[/\\]1c392abb/u)
  assert.equal(path.startsWith(env.vault), false)
  await advanceConventionCursor({
    binding: env.binding,
    dataRoot: env.dataRoot,
    expectedRevision: preview.rotation.revision,
    fingerprint: preview.rotation.fingerprint,
    anchorHash: preview.rotation.anchorHash,
  })
  const statted = await stat(path)
  assert.equal(statted.isFile(), true)
  // POSIX bits are the assertion on a POSIX host; NTFS does not express them, so
  // there the helper asserts the regular-file/not-a-link/owner-readable shape.
  await assertPrivateFile(path, 0o600)
  await assertPrivateDirectory(join(path, '..'), 0o700)
  const stored = JSON.parse(await readFile(path, 'utf8'))
  assert.deepEqual(Object.keys(stored).sort(), ['anchorHash', 'fingerprint', 'revision', 'schema'])
  // The anchor is hashed: no convention text is persisted.
  assert.equal(stored.anchorHash, conventionUnitHash(UNITS[4]))
  assert.equal(JSON.stringify(stored).includes('约定'), false)
})

test('two concurrent preparations may repeat a window, and a stale acknowledgement never skips another', async (t) => {
  const env = await fixture(t)
  const start = { binding: env.binding, dataRoot: env.dataRoot, units: UNITS }
  const first = await prepareConventionPreview(start)
  const second = await prepareConventionPreview(start)
  assert.equal(first.rotation.revision, second.rotation.revision)
  assert.deepEqual(
    first.lines,
    second.lines,
    'a concurrent pair repeats the window rather than interleaving',
  )

  const advanced = await advanceConventionCursor({
    binding: env.binding,
    dataRoot: env.dataRoot,
    expectedRevision: first.rotation.revision,
    fingerprint: first.rotation.fingerprint,
    anchorHash: first.rotation.anchorHash,
  })
  assert.equal(advanced.advanced, true)

  const stale = await advanceConventionCursor({
    binding: env.binding,
    dataRoot: env.dataRoot,
    expectedRevision: second.rotation.revision,
    fingerprint: second.rotation.fingerprint,
    anchorHash: conventionUnitHash(UNITS[10]),
  })
  assert.equal(stale.advanced, false)
  assert.equal(stale.stale, true)
  // The stale write changed nothing: the next preparation follows the FIRST
  // acknowledgement's anchor, not the second session's chosen unit.
  const next = await prepareConventionPreview(start)
  assert.deepEqual(next.lines, UNITS.slice(5, 10))
})

test('a corrupt cursor resets safely and the next preview starts at the first eligible unit', async (t) => {
  const env = await fixture(t)
  const first = await prepareConventionPreview({
    binding: env.binding,
    dataRoot: env.dataRoot,
    units: UNITS,
  })
  await advanceConventionCursor({
    binding: env.binding,
    dataRoot: env.dataRoot,
    expectedRevision: first.rotation.revision,
    fingerprint: first.rotation.fingerprint,
    anchorHash: first.rotation.anchorHash,
  })
  const path = conventionCursorPath({
    dataRoot: env.dataRoot,
    vaultHash: first.rotation.vaultHash,
    projectId: PROJECT_ID,
  })
  await writeFile(path, '{ not json', 'utf8')
  const read = await readConventionCursor({ binding: env.binding, dataRoot: env.dataRoot })
  assert.equal(read.corrupt, true)
  assert.equal(read.degraded, true)
  assert.equal(read.state.revision, 0)
  assert.equal(read.state.anchorHash, null)
  const next = await prepareConventionPreview({
    binding: env.binding,
    dataRoot: env.dataRoot,
    units: UNITS,
  })
  assert.deepEqual(next.lines, UNITS.slice(0, 5))
})

test('an oversized or foreign-shaped cursor file is refused instead of trusted', async (t) => {
  const env = await fixture(t)
  const first = await prepareConventionPreview({
    binding: env.binding,
    dataRoot: env.dataRoot,
    units: UNITS,
  })
  const path = conventionCursorPath({
    dataRoot: env.dataRoot,
    vaultHash: first.rotation.vaultHash,
    projectId: PROJECT_ID,
  })
  await mkdir(join(path, '..'), { recursive: true, mode: 0o700 })
  await writeFile(
    path,
    JSON.stringify({ revision: 3, anchorHash: 'x', fingerprint: 'y', extra: 'z' }),
    'utf8',
  )
  const read = await readConventionCursor({ binding: env.binding, dataRoot: env.dataRoot })
  assert.equal(read.corrupt, true, 'a schema mismatch is not a cursor')
  await writeFile(path, 'x'.repeat(CONVENTION_STATE_MAX_BYTES + 1), 'utf8')
  const oversizedRead = await readConventionCursor({ binding: env.binding, dataRoot: env.dataRoot })
  assert.equal(oversizedRead.corrupt, true)
})

test(
  'the cursor directory refuses to follow a symlink',
  { skip: skipWithoutDirectorySymlink() },
  async (t) => {
    const env = await fixture(t)
    const first = await prepareConventionPreview({
      binding: env.binding,
      dataRoot: env.dataRoot,
      units: UNITS,
    })
    const path = conventionCursorPath({
      dataRoot: env.dataRoot,
      vaultHash: first.rotation.vaultHash,
      projectId: PROJECT_ID,
    })
    const outside = join(env.root, 'outside')
    await mkdir(outside, { recursive: true })
    await mkdir(join(path, '..'), { recursive: true, mode: 0o700 })
    // Replace the private project cursor directory with a symlink to a directory
    // outside dataRoot; a reader that follows it is a privacy hole, so this is a
    // refusal and the state starts fresh.
    await rm(join(path, '..'), { recursive: true, force: true })
    // A junction where a directory symlink is refused still produces a real link the
    // reader must refuse to follow, so the refusal itself stays covered.
    await createDirectoryLink(outside, join(path, '..'))
    const read = await readConventionCursor({ binding: env.binding, dataRoot: env.dataRoot })
    assert.equal(read.degraded, true)
    assert.equal(read.symlink, true)
    assert.equal(read.state.revision, 0)
  },
)
