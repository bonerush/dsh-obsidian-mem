// The private, bounded persistence half of the session brief state.
//
// A restarted host process has no in-memory snapshot, so the first bound
// pre-step probes `<dataRoot>/session-state/<sha256(sessionKey)>.json` and adopts
// it only when the claimed conversation still carries that exact brief. These
// cases pin the contract: the path is derived from the data root and a session
// key hash; a record round-trips; a corrupt, oversized, foreign, stale or
// symlinked record reads as absent; the brief fields are normalized to their
// bounds; the adoption probe only counts user-role text that starts with the
// plugin's own marker; and the lazy GC removes expired records but never a live
// one.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  SESSION_STATE_MAX_BYTES,
  SESSION_STATE_MAX_HASHES,
  SESSION_STATE_SCHEMA,
  SESSION_STATE_TTL_MS,
  briefMarkerHashes,
  emptyBriefState,
  readSessionState,
  saveSessionState,
  sessionStatePath,
} from '../lib/session-state.js'

const PROJECT_ID = '1c392abb-7b08-42f7-871d-2a379caf9448'
const SESSION_KEY = 'session-9d4a4c1e-2f1a-4f4e-8b3a-000000000001'
const NOW = 1_760_000_000_000
const BRIEF_TEXT = '<!-- obsidian-mem:brief mode=full -->\nBRIEF'

/**
 * A throwaway data root and a bound identity whose vault directory exists, so
 * the identity's realpath is stable and the record is verifiable.
 *
 * @param {object} t - the node:test context.
 * @returns {Promise<object>} the fixture.
 */
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'obsidian-mem-session-state-'))
  const vault = join(root, 'vault')
  const dataRoot = join(root, 'data')
  await mkdir(vault, { recursive: true })
  await mkdir(dataRoot, { recursive: true })
  t.after(async () => rm(root, { recursive: true, force: true, maxRetries: 4 }))
  return {
    root,
    vault,
    dataRoot,
    binding: { kind: 'bound', projectId: PROJECT_ID, vaultRoot: vault },
  }
}

/** One complete observation record, the shape the hook writes. */
function briefValue(overrides = {}) {
  return {
    ...emptyBriefState(),
    sentFull: true,
    lastHotHash: 'h1',
    lastHotItems: [{ id: 'hot-1', section: '进行中', text: '条目', source: null }],
    sentHotHashes: ['h0'],
    lastFullHash: 'a'.repeat(64),
    lastBriefHash: 'a'.repeat(64),
    ...overrides,
  }
}

const SESSION_HASH = createHash('sha256').update(SESSION_KEY).digest('hex')

test('a saved record round-trips with its private path and identity', async (t) => {
  const { dataRoot, binding } = await fixture(t)
  const brief = briefValue()
  assert.equal(
    await saveSessionState({ dataRoot, sessionKey: SESSION_KEY, binding, brief, now: NOW }),
    true,
  )

  const path = sessionStatePath({ dataRoot, sessionKey: SESSION_KEY })
  assert.equal(path, join(dataRoot, 'session-state', SESSION_HASH + '.json'))
  assert.equal((await stat(path)).mode & 0o777, 0o600)
  const raw = JSON.parse(await readFile(path, 'utf8'))
  assert.equal(raw.schema, SESSION_STATE_SCHEMA)
  assert.equal(raw.identity.projectId, PROJECT_ID)
  assert.equal(raw.savedAt, NOW)

  const record = await readSessionState({
    dataRoot,
    sessionKey: SESSION_KEY,
    binding,
    now: NOW + 1000,
  })
  assert.notEqual(record, null)
  assert.equal(record.path, path)
  assert.deepEqual(record.state.brief, brief)
})

test('an absent record reads as absent', async (t) => {
  const { dataRoot, binding } = await fixture(t)
  assert.equal(
    await readSessionState({ dataRoot, sessionKey: SESSION_KEY, binding, now: NOW }),
    null,
  )
})

test('a corrupt, oversized or foreign-schema record reads as absent', async (t) => {
  const { dataRoot, binding } = await fixture(t)
  const path = sessionStatePath({ dataRoot, sessionKey: SESSION_KEY })
  await mkdir(join(dataRoot, 'session-state'), { recursive: true })

  await writeFile(path, '{ not json')
  assert.equal(
    await readSessionState({ dataRoot, sessionKey: SESSION_KEY, binding, now: NOW }),
    null,
  )

  await writeFile(
    path,
    JSON.stringify({
      schema: SESSION_STATE_SCHEMA,
      savedAt: NOW,
      identity: { vaultHash: 'x', projectId: PROJECT_ID },
      brief: briefValue(),
      pad: 'x'.repeat(SESSION_STATE_MAX_BYTES),
    }),
  )
  assert.equal(
    await readSessionState({ dataRoot, sessionKey: SESSION_KEY, binding, now: NOW }),
    null,
  )

  await writeFile(
    path,
    JSON.stringify({
      schema: SESSION_STATE_SCHEMA + 1,
      savedAt: NOW,
      identity: {},
      brief: briefValue(),
    }),
  )
  assert.equal(
    await readSessionState({ dataRoot, sessionKey: SESSION_KEY, binding, now: NOW }),
    null,
  )
})

test('a record written for another vault or project reads as absent', async (t) => {
  const { root, dataRoot, binding } = await fixture(t)
  const otherVault = join(root, 'other-vault')
  await mkdir(otherVault, { recursive: true })
  await saveSessionState({
    dataRoot,
    sessionKey: SESSION_KEY,
    binding: { ...binding, vaultRoot: otherVault },
    brief: briefValue(),
    now: NOW,
  })
  assert.equal(
    await readSessionState({ dataRoot, sessionKey: SESSION_KEY, binding, now: NOW }),
    null,
  )
})

test('a record past its TTL reads as absent', async (t) => {
  const { dataRoot, binding } = await fixture(t)
  await saveSessionState({
    dataRoot,
    sessionKey: SESSION_KEY,
    binding,
    brief: briefValue(),
    now: NOW,
  })
  assert.notEqual(
    await readSessionState({
      dataRoot,
      sessionKey: SESSION_KEY,
      binding,
      now: NOW + SESSION_STATE_TTL_MS,
    }),
    null,
  )
  assert.equal(
    await readSessionState({
      dataRoot,
      sessionKey: SESSION_KEY,
      binding,
      now: NOW + SESSION_STATE_TTL_MS + 1,
    }),
    null,
  )
})

test('the brief fields are clamped to their documented bounds', async (t) => {
  const { dataRoot, binding } = await fixture(t)
  const hashes = Array.from(
    { length: SESSION_STATE_MAX_HASHES + 36 },
    (_, index) => 'h' + String(index),
  )
  const items = Array.from({ length: 260 }, (_, index) => ({
    id: 'hot-' + String(index),
    section: '进行中',
    text: '条目 ' + String(index),
    source: null,
  }))
  await saveSessionState({
    dataRoot,
    sessionKey: SESSION_KEY,
    binding,
    brief: briefValue({ sentHotHashes: hashes, heldTruncatedHashes: hashes, lastHotItems: items }),
    now: NOW,
  })
  const record = await readSessionState({ dataRoot, sessionKey: SESSION_KEY, binding, now: NOW })
  assert.equal(record.state.brief.sentHotHashes.length, SESSION_STATE_MAX_HASHES)
  assert.equal(record.state.brief.heldTruncatedHashes.length, SESSION_STATE_MAX_HASHES)
  assert.equal(record.state.brief.lastHotItems.length, 200)
})

test('an invalid binding or blank key is refused without throwing', async (t) => {
  const { dataRoot, binding } = await fixture(t)
  assert.equal(
    await saveSessionState({
      dataRoot,
      sessionKey: SESSION_KEY,
      binding: { ...binding, projectId: 'not-a-uuid' },
      brief: briefValue(),
      now: NOW,
    }),
    false,
  )
  assert.throws(() => sessionStatePath({ dataRoot, sessionKey: '' }), RangeError)
})

test('the adoption probe only hashes user-role text that starts with the marker', () => {
  const hashes = briefMarkerHashes([
    { role: 'user', content: [{ type: 'text', text: BRIEF_TEXT }] },
    { role: 'assistant', content: [{ type: 'text', text: BRIEF_TEXT }] },
    { role: 'user', content: [{ type: 'text', text: 'quoted: ' + BRIEF_TEXT }] },
    { role: 'tool', content: [{ type: 'text', text: BRIEF_TEXT }] },
    { role: 'user', content: [{ type: 'text', text: 'plain prompt' }] },
  ])
  assert.equal(hashes.size, 1)
  assert.equal([...hashes][0], createHash('sha256').update(BRIEF_TEXT).digest('hex'))
})

test('the lazy GC removes an expired record and a stale lock, but keeps a live record', async (t) => {
  const { dataRoot, binding } = await fixture(t)
  const root = join(dataRoot, 'session-state')
  await mkdir(root, { recursive: true })
  const expiredPath = sessionStatePath({ dataRoot, sessionKey: 'session-expired' })
  await saveSessionState({
    dataRoot,
    sessionKey: 'session-expired',
    binding,
    brief: briefValue(),
    now: NOW - SESSION_STATE_TTL_MS - 60_000,
  })
  const old = new Date(NOW - SESSION_STATE_TTL_MS - 60_000)
  await utimes(expiredPath, old, old)
  const lockPath = join(root, 'stale.lock')
  await writeFile(lockPath, '')
  await utimes(lockPath, old, old)

  await saveSessionState({
    dataRoot,
    sessionKey: 'session-live',
    binding,
    brief: briefValue(),
    now: NOW,
  })

  await assert.rejects(readFile(expiredPath), /ENOENT/)
  await assert.rejects(readFile(lockPath), /ENOENT/)
  assert.notEqual(
    await readSessionState({ dataRoot, sessionKey: 'session-live', binding, now: NOW }),
    null,
  )
})
