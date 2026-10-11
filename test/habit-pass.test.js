// Task 5b: the composition — counting on a completed turn, and the decay pass.
//
// This is the only piece of the habit feature that touches the vault, so every case
// here is about a failure that must not become a wrong note:
//
//   * A turn with no USER message must produce nothing. That is the attribution
//     boundary, and it is the regression test for the mistake that falsified v1,
//     which counted tool calls and learned this plugin's defaults.
//   * A promoted candidate is `observed` / `provisional`, never `stated` / `active`.
//     The automatic path may record what it saw; it may never claim the user said it,
//     and a provisional note is what the brief quarantines.
//   * The note body carries a count and a label, never message text — the private
//     state and the note are both readable, and neither may become a transcript.
//
// Everything runs against a REAL temporary vault from the REAL bootstrap and a
// throwaway data root: nothing here may read or write the user's `~/.dsh`.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createHabitPass } from '../lib/habit-pass.js'
import { readHabitState } from '../lib/habit-state.js'
import { bootstrapVault, parseNote } from '../lib/vault.js'

const PROJECT_ID = '3f2a1b4c-5d6e-4f70-8a9b-1c2d3e4f5061'
const ID8 = PROJECT_ID.slice(0, 8)
const PROJECT = `Projects/beta--${ID8}`
const CONVENTIONS = `${PROJECT}/Conventions`

/** A real bootstrapped vault and a throwaway data root. */
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'obsidian-mem-habit-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 4 }))
  const dataRoot = await mkdtemp(join(tmpdir(), 'obsidian-mem-habit-data-'))
  t.after(() => rm(dataRoot, { recursive: true, force: true, maxRetries: 4 }))
  const home = join(root, 'home')
  await mkdir(home, { recursive: true })
  const vault = join(root, 'vault')
  const binding = {
    kind: 'bound',
    projectId: PROJECT_ID,
    slug: 'beta',
    displayName: 'beta',
    schema: 1,
    vaultRoot: vault,
    relativeDir: PROJECT,
  }
  await bootstrapVault(binding, { dataRoot, home })
  return { root, dataRoot, home, vault, binding, deps: { dataRoot, home } }
}

/** The config slice this module reads, plus the defaults it falls back to. */
function config(overrides = {}) {
  return {
    habitLearning: {
      enabled: true,
      promoteAfter: 3,
      markers: [],
      halfLifeDays: 30,
      demoteBelow: 0.5,
      archiveBelow: 0.15,
      ...overrides,
    },
  }
}

/** A completed turn carrying one real user message. */
function turnWithUser(text, turn = 1) {
  return [
    { type: 'turn/start', seq: 1, data: { turn } },
    {
      type: 'user/message',
      seq: 2,
      data: { source: { kind: 'user' }, content: [{ type: 'text', text }] },
    },
    { type: 'turn/end', seq: 3, data: { turn, reason: { kind: 'completed' } } },
  ]
}

/** A completed turn carrying only tool activity and injected context. */
function turnWithoutUser(turn = 1) {
  return [
    { type: 'turn/start', seq: 1, data: { turn } },
    { type: 'tool/call', seq: 2, data: { name: 'bash', arguments: '{"command":"npm test"}' } },
    {
      type: 'user/message',
      seq: 3,
      data: {
        source: { kind: 'plugin:obsidian-mem' },
        content: [{ type: 'text', text: '记得提交' }],
      },
    },
    { type: 'turn/end', seq: 4, data: { turn, reason: { kind: 'completed' } } },
  ]
}

async function noteAt(f, name) {
  const text = await readFile(join(f.vault, CONVENTIONS, `${name}.md`), 'utf8')
  return parseNote(Buffer.from(text))
}

test('a turn with no user message records nothing, however much tool activity it has', async (t) => {
  // The attribution regression. v1 counted tool calls and 99.0% of what it counted
  // was the agent's own choice, so a turn full of tool calls must contribute zero.
  const f = await fixture(t)
  const pass = createHabitPass({ dataRoot: f.dataRoot, config: config(), home: f.home })
  const result = await pass.recordTurn({
    binding: f.binding,
    sessionId: 'session-1',
    events: turnWithoutUser(),
  })
  assert.deepEqual(result.promoted, [])
  const state = await readHabitState(f.dataRoot, result.vaultHash, PROJECT_ID)
  assert.deepEqual(state.records, {}, 'tool activity left no counter behind')
})

test('one session counts once, and three sessions promote a provisional candidate', async (t) => {
  const f = await fixture(t)
  const pass = createHabitPass({ dataRoot: f.dataRoot, config: config(), home: f.home })
  for (const sessionId of ['session-1', 'session-2']) {
    const r = await pass.recordTurn({
      binding: f.binding,
      sessionId,
      events: turnWithUser('记得提交'),
    })
    assert.deepEqual(r.promoted, [], `no promotion at ${sessionId}`)
  }
  // The same session twice more must not advance the count: the unit is the session.
  await pass.recordTurn({
    binding: f.binding,
    sessionId: 'session-2',
    events: turnWithUser('记得提交'),
  })
  const third = await pass.recordTurn({
    binding: f.binding,
    sessionId: 'session-3',
    events: turnWithUser('改动完就提交'),
  })
  assert.deepEqual(third.promoted, ['提交'], 'the third distinct session promotes')

  const note = await noteAt(f, '习惯：提交')
  assert.equal(note.data.assertion, 'observed', 'the plugin saw it; the user did not say it')
  assert.equal(note.data.status, 'provisional', 'quarantined until confirmed')
  assert.equal(note.data.type, 'convention')
  assert.ok(note.data.tags.includes('user-habit'), 'findable without reading the title')
  assert.ok(note.data.tags.includes(`project/beta`), 'carries the project tag')
})

test('the promoted note carries no message text', async (t) => {
  // Both the state file and the note are readable by anyone with the vault, so
  // neither may carry what the user typed. The body states the observation and
  // how to act on it; the evidence is the count.
  const f = await fixture(t)
  const pass = createHabitPass({ dataRoot: f.dataRoot, config: config(), home: f.home })
  const secret = '记得提交 my-secret-token'
  for (const sessionId of ['s1', 's2', 's3']) {
    await pass.recordTurn({ binding: f.binding, sessionId, events: turnWithUser(secret) })
  }
  const note = await noteAt(f, '习惯：提交')
  assert.ok(!note.body.includes('my-secret-token'), 'no message text in the body')
  assert.ok(!note.body.includes('secret'), 'no message text in the body')
  // And the private state, which is the other readable artifact.
  const state = await readHabitState(f.dataRoot, 'x', PROJECT_ID)
  assert.ok(!JSON.stringify(state).includes('secret'), 'no message text in the state')
})

test('a disabled pass writes no state and promotes nothing', async (t) => {
  const f = await fixture(t)
  const pass = createHabitPass({
    dataRoot: f.dataRoot,
    config: config({ enabled: false }),
    home: f.home,
  })
  for (const sessionId of ['s1', 's2', 's3']) {
    const r = await pass.recordTurn({
      binding: f.binding,
      sessionId,
      events: turnWithUser('记得提交'),
    })
    assert.deepEqual(r.promoted, [])
  }
  const state = await readHabitState(f.dataRoot, 'x', PROJECT_ID)
  assert.deepEqual(state.records, {})
})

test('a re-observed candidate is refreshed, not duplicated', async (t) => {
  const f = await fixture(t)
  const pass = createHabitPass({ dataRoot: f.dataRoot, config: config(), home: f.home })
  let vaultHash = null
  for (const sessionId of ['s1', 's2', 's3', 's4']) {
    const r = await pass.recordTurn({
      binding: f.binding,
      sessionId,
      events: turnWithUser('记得提交'),
    })
    vaultHash = r.vaultHash
  }
  const { readdir } = await import('node:fs/promises')
  const names = (await readdir(join(f.vault, CONVENTIONS))).filter((n) => n.startsWith('习惯：'))
  assert.deepEqual(names, ['习惯：提交.md'], 'four sessions produced exactly one note')
  const state = await readHabitState(f.dataRoot, vaultHash, PROJECT_ID)
  assert.equal(state.records.提交.sessions, 4, 'the fourth session kept counting')
  assert.equal(state.records.提交.score, 1, 'and restored the decay clock')
  assert.equal(typeof state.records.提交.noteId, 'string', 'the note identity is recorded')
})

test('the decay pass archives a stale candidate and never deletes it', async (t) => {
  const f = await fixture(t)
  // Promote at a frozen 'today', then run the decay pass far in the future.
  const promoteAt = new Date(Date.UTC(2026, 0, 1))
  const promoting = createHabitPass({
    dataRoot: f.dataRoot,
    config: config(),
    home: f.home,
    now: () => promoteAt,
  })
  for (const sessionId of ['s1', 's2', 's3']) {
    await promoting.recordTurn({ binding: f.binding, sessionId, events: turnWithUser('记得提交') })
  }
  const before = await readFile(join(f.vault, CONVENTIONS, '习惯：提交.md'), 'utf8')
  assert.ok(before.includes('status: "provisional"'), 'promoted as a candidate')

  // Far enough out that the score passes the demote line and then the floor.
  const later = new Date(Date.UTC(2027, 6, 1))
  const decaying = createHabitPass({
    dataRoot: f.dataRoot,
    config: config(),
    home: f.home,
    now: () => later,
  })
  const result = await decaying.decay({ binding: f.binding })
  assert.deepEqual(result.archived, ['习惯：提交'], 'the stale candidate is archived')

  const after = await readFile(join(f.vault, CONVENTIONS, '习惯：提交.md'), 'utf8')
  assert.ok(after.includes('status: "archived"'), 'archived, not deleted')
  assert.ok(after.includes('习惯：提交'), 'the note is still there')
})
