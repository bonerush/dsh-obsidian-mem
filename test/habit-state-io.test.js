// Task 2b: the private state file the habit counters live in.
//
// The state is a DERIVED artifact, not vault content, so it lives under the plugin
// data root beside `pending/` and `curation/` — the repository's rule is that the
// vault is never the plugin's scratch space. It is rebuildable: losing it costs the
// counts, never a note.
//
// Two properties the tests pin:
//
//   * NOTHING FROM A MESSAGE IS STORED. The file holds vocabulary labels and
//     counters. If a label could carry message text, this file would become a
//     transcript of what the user typed, which is the one thing the capture
//     whitelist exists to prevent.
//   * A CORRUPT FILE IS A MISS, NOT AN ERROR. A torn write must not stop a session
//     from starting, so an unreadable document is answered as empty state and the
//     next pass rewrites it.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  HABIT_STATE_SCHEMA,
  habitStatePath,
  readHabitState,
  writeHabitState,
} from '../lib/habit-state.js'

/** A throwaway data root; never the real one. */
async function withRoot(run) {
  const root = await mkdtemp(join(tmpdir(), 'habit-state-'))
  try {
    return await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('the state path is derived from the data root, not the vault', () => {
  const path = habitStatePath('/tmp/data', 'vaulthash', 'project-id')
  assert.ok(path.startsWith('/tmp/data'), 'under the data root')
  assert.ok(path.includes('habits'), 'in its own directory')
  assert.ok(path.includes('vaulthash'), 'scoped to the vault')
  assert.ok(path.endsWith('.json'), 'a JSON document')
})

test('a missing state file reads as empty state', async () => {
  await withRoot(async (root) => {
    const state = await readHabitState(root, 'vh', 'p1')
    assert.equal(state.schema, HABIT_STATE_SCHEMA)
    assert.deepEqual(state.records, {})
  })
})

test('state round-trips through a real file', async () => {
  await withRoot(async (root) => {
    const state = {
      schema: HABIT_STATE_SCHEMA,
      records: {
        提交: {
          sessions: 3,
          firstSeen: '2026-10-01',
          lastReinforcedAt: '2026-10-01',
          lastDecayedAt: null,
          score: 1,
          noteId: null,
        },
      },
    }
    await writeHabitState(root, 'vh', 'p1', state)
    const back = await readHabitState(root, 'vh', 'p1')
    assert.deepEqual(back.records, state.records)
  })
})

test('a corrupt or foreign state file is a miss, not a crash', async () => {
  await withRoot(async (root) => {
    const path = habitStatePath(root, 'vh', 'p1')
    await mkdir(join(path, '..'), { recursive: true })
    for (const body of ['{not json', '[]', 'null', '{"schema":99,"records":{}}', '']) {
      await writeFile(path, body, 'utf8')
      const state = await readHabitState(root, 'vh', 'p1')
      assert.deepEqual(state.records, {}, `answered empty for ${JSON.stringify(body)}`)
      assert.equal(state.schema, HABIT_STATE_SCHEMA)
    }
  })
})

test('a record with an unusable shape is dropped, not trusted', async () => {
  await withRoot(async (root) => {
    const path = habitStatePath(root, 'vh', 'p1')
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(
      path,
      JSON.stringify({
        schema: HABIT_STATE_SCHEMA,
        records: {
          提交: {
            sessions: 2,
            score: 1,
            firstSeen: '2026-10-01',
            lastReinforcedAt: null,
            lastDecayedAt: null,
            noteId: null,
          },
          broken: 'not an object',
          alsoBroken: { sessions: 'many' },
        },
      }),
      'utf8',
    )
    const state = await readHabitState(root, 'vh', 'p1')
    assert.deepEqual(Object.keys(state.records), ['提交'])
  })
})

test('the stored document never carries message text', async () => {
  // The label is a vocabulary entry; the counter is a number. A field that could
  // hold what the user typed would make this file a transcript.
  await withRoot(async (root) => {
    await writeHabitState(root, 'vh', 'p1', {
      schema: HABIT_STATE_SCHEMA,
      records: {
        提交: {
          sessions: 1,
          firstSeen: '2026-10-11',
          lastReinforcedAt: '2026-10-11',
          lastDecayedAt: null,
          score: 1,
          noteId: null,
        },
      },
    })
    const raw = await readFile(habitStatePath(root, 'vh', 'p1'), 'utf8')
    const allowed = new Set([
      'schema',
      'records',
      'sessions',
      'firstSeen',
      'lastReinforcedAt',
      'lastDecayedAt',
      'score',
      'noteId',
    ])
    for (const key of Object.keys(JSON.parse(raw).records.提交)) {
      assert.ok(allowed.has(key), `unexpected field ${key} would widen what can be stored`)
    }
  })
})

test('writing creates the directory and leaves no temporary file behind', async () => {
  await withRoot(async (root) => {
    await writeHabitState(root, 'vh', 'p1', { schema: HABIT_STATE_SCHEMA, records: {} })
    const { readdir } = await import('node:fs/promises')
    const dir = join(habitStatePath(root, 'vh', 'p1'), '..')
    const names = await readdir(dir)
    assert.deepEqual(
      names.filter((n) => n.includes('.tmp')),
      [],
      'no temp file survives',
    )
  })
})
