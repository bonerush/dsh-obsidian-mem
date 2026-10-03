// Task 7: the interactive review command, driven over a real pseudo-terminal.
//
// The command's accepting path exists only behind a terminal, so a pipe — which is
// exactly the model-callable route it must not have — cannot exercise it. These
// cases therefore spawn the shipped binary *inside* a pty and type at it, which is
// the only way to assert the two things the design promises: the exact typed
// confirmation applies, and a near miss applies nothing.
//
// The pty comes from `expect(1)`, the standard Tcl utility present on macOS and on
// most Linux images. `script(1)` is not usable here: on the BSD implementation it
// refuses to hand a child a terminal when *its own* stdin is a socket, which is
// exactly how a test runner starts it. A missing `expect` is reported as a skip,
// never as a pass.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

import {
  readCurationProposal,
  saveCurationProposal,
  snapshotProposalSources,
} from '../lib/curation-proposals.js'
import { resolveBinding } from '../lib/vault.js'
import { makeCurationWorld } from './curation-world.js'

const CLI = resolve(import.meta.dirname, '..', 'lib', 'curation-cli.js')
const EXPECT = '/usr/bin/expect'
const NOW = new Date('2026-10-03T04:00:00Z')

/** Whether a usable `expect` exists on this machine. */
function hasExpect() {
  return spawnSync(EXPECT, ['-v'], { encoding: 'utf8' }).status === 0
}

/**
 * One Tcl program that runs the command, waits for its prompt and types `typed`.
 *
 * `eof` is reached when the child exits, which is how the exit status is captured
 * without a second spawn. `exit 0` on the eof branch is deliberate: expect treats
 * any other eof as a failure and writes a misleading message of its own.
 */
function expectProgram(typed, args) {
  const argv = [process.execPath, CLI, ...args].join(' ')
  return [
    'set timeout 30',
    `spawn -noecho ${argv}`,
    'expect {',
    // The prompt line the command itself prints, and the signal that it is waiting
    // for input rather than still reading the vault.
    '  -re {type exactly} { send -- "' +
      typed.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('$', '\\$') +
      '\\n" }',
    // Neither branch decides anything: a command that never prompted (an unknown
    // id, an unbound project) has already exited, and its status is read below.
    '  eof {}',
    '  timeout {}',
    '}',
    // A child that exits on its own closes the spawn id before this second read, so
    // the read is wrapped: a closed id is "the command has finished", not a harness
    // error. Without the wrap, `expect` aborts and its own non-zero status would be
    // reported as a zero one.
    'catch {',
    '  expect {',
    '    eof {}',
    '    timeout {}',
    '  }',
    '}',
    // The spawned process's own exit status, not expect's: a near miss must be a
    // non-zero exit from the command, and a default of 0 here would hide that.
    // Tcl's `wait` answers a four-element list whose last element is the status.
    'set status 1',
    'catch {set status [lindex [wait] 3]}',
    'exit $status',
    '',
  ].join('\n')
}

/**
 * Run the command inside a pty and type `typed` at it.
 *
 * @param {object} made - the world.
 * @param {string[]} args - the command's argv (after the program name).
 * @param {string} typed - the exact bytes a user would type, newline included.
 * @returns {{status: number, output: string}} the run, or `null` when there is no pty.
 */
function runOnTty(made, args, typed) {
  if (!hasExpect()) return null
  const run = spawnSync(EXPECT, ['-c', expectProgram(typed, args)], {
    cwd: made.repo,
    encoding: 'utf8',
    env: { ...process.env, DSH_HOME: made.dshHome },
    timeout: 60_000,
  })
  return { status: run.status ?? -1, output: `${run.stdout ?? ''}${run.stderr ?? ''}` }
}

/** The binding the world's writes created. */
async function bindingOf(made) {
  const binding = await resolveBinding({
    cwd: made.repo,
    vaultRoot: made.vault,
    mode: 'show',
    home: made.home,
  })
  assert.equal(binding.kind, 'bound', JSON.stringify(binding))
  return binding
}

/** One world with one saved `create-separate` proposal about the seed note. */
async function parked(t, { itemKey = 'cli:1', title = '命令行复核的候选' } = {}) {
  const made = await makeCurationWorld(t)
  const seed = await made.services.write({ type: 'doc', title: '起点', body: '起点正文。\n' })
  const binding = await bindingOf(made)
  const item = {
    preassignedId: `got-${crypto.randomUUID()}`,
    idempotencyKey: itemKey,
    type: 'gotcha',
    title,
    body: '命令行复核的正文。\n',
  }
  const proposal = await saveCurationProposal({
    dataRoot: made.dataRoot,
    now: NOW,
    projectId: binding.projectId,
    itemKey,
    kind: 'near-duplicate',
    sources: await snapshotProposalSources(binding, {
      twin: { id: seed.id, path: seed.path },
      home: made.home,
    }),
    operation: { kind: 'create-separate', item },
  })
  return { ...made, binding, seed, item, proposal }
}

/** The notes a review would publish, with the directory's own MOC excluded. */
async function publishedNotes(made) {
  try {
    // `gotcha` routes to `Pitfalls/`, and the directory's `index.md` is its MOC.
    return (await readdir(join(made.vault, ...`${made.binding.relativeDir}/Pitfalls`.split('/'))))
      .filter((name) => name.endsWith('.md') && name !== 'index.md')
      .sort()
  } catch {
    return []
  }
}

test('typing the exact confirmation applies the proposal', async (t) => {
  const made = await parked(t)
  const id = made.proposal.proposalId
  const answer = runOnTty(made, ['--vault', made.vault, id], `apply ${id}`)
  if (answer === null) {
    t.skip('expect(1) is unavailable, so no pseudo-terminal can be created')
    return
  }
  // The command prints both accepted forms with the exact id it read, which is what
  // makes the byte-for-byte comparison possible for the person typing.
  assert.match(answer.output, /type exactly: {2}apply [0-9a-f]{64}/u)
  assert.match(answer.output, /reject [0-9a-f]{64}/u)
  assert.match(answer.output, /命令行复核的候选/u, 'the candidate is shown before it is applied')
  assert.equal(answer.status, 0, answer.output)

  const notes = await publishedNotes(made)
  assert.equal(notes.length, 1, `expected the approved note, saw ${notes.join(', ')}`)
  const written = await made.services.read({
    path: `${made.binding.relativeDir}/Pitfalls/${notes[0]}`,
  })
  assert.equal(written.frontmatter.id, made.item.preassignedId)
  const record = await readCurationProposal({
    dataRoot: made.dataRoot,
    projectId: made.binding.projectId,
    proposalId: id,
  })
  assert.equal(record.state, 'applied')
})

test('a near miss publishes nothing and exits non-zero', async (t) => {
  const made = await parked(t)
  const id = made.proposal.proposalId
  for (const typed of ['', `apply`, id, `apply ${id} `, `APPLY ${id}`, `apply ${id}x`]) {
    const answer = runOnTty(made, ['--vault', made.vault, id], typed)
    if (answer === null) {
      t.skip('expect(1) is unavailable, so no pseudo-terminal can be created')
      return
    }
    assert.notEqual(answer.status, 0, `expected ${JSON.stringify(typed)} to be refused`)
    assert.match(answer.output, /confirmation-mismatch/u, `for ${JSON.stringify(typed)}`)
  }
  assert.deepEqual(await publishedNotes(made), [], 'a near miss publishes nothing')
  assert.equal(
    (
      await readCurationProposal({
        dataRoot: made.dataRoot,
        projectId: made.binding.projectId,
        proposalId: id,
      })
    ).state,
    'pending',
  )
})

test('typing the exact rejection marks the proposal rejected and changes no byte', async (t) => {
  const made = await parked(t)
  const id = made.proposal.proposalId
  const seedPath = join(made.vault, ...made.seed.path.split('/'))
  const before = await readFile(seedPath)
  const answer = runOnTty(made, ['--vault', made.vault, id], `reject ${id}`)
  if (answer === null) {
    t.skip('expect(1) is unavailable, so no pseudo-terminal can be created')
    return
  }
  assert.equal(answer.status, 0, answer.output)
  const record = await readCurationProposal({
    dataRoot: made.dataRoot,
    projectId: made.binding.projectId,
    proposalId: id,
  })
  assert.equal(record.state, 'rejected')
  assert.deepEqual(await readFile(seedPath), before)
  assert.deepEqual(await publishedNotes(made), [])
})

test('a wrong proposal id exits non-zero and writes nothing', async (t) => {
  const made = await parked(t)
  const wrong = 'b'.repeat(64)
  const seedPath = join(made.vault, ...made.seed.path.split('/'))
  const before = await readFile(seedPath)
  const answer = runOnTty(made, ['--vault', made.vault, wrong], `apply ${wrong}`)
  if (answer === null) {
    t.skip('expect(1) is unavailable, so no pseudo-terminal can be created')
    return
  }
  assert.notEqual(answer.status, 0, answer.output)
  assert.match(answer.output, /proposal-missing/u)
  assert.deepEqual(await readFile(seedPath), before)
  assert.deepEqual(await publishedNotes(made), [])
})

test('the command never approves a batch: one id, one proposal', async (t) => {
  const made = await parked(t)
  const other = await saveCurationProposal({
    dataRoot: made.dataRoot,
    now: NOW,
    projectId: made.binding.projectId,
    itemKey: 'cli:2',
    kind: 'near-duplicate',
    sources: await snapshotProposalSources(made.binding, {
      twin: { id: made.seed.id, path: made.seed.path },
      home: made.home,
    }),
    operation: {
      kind: 'create-separate',
      item: {
        preassignedId: `got-${crypto.randomUUID()}`,
        idempotencyKey: 'cli:2',
        type: 'gotcha',
        title: '第二个候选',
        body: '第二个正文。\n',
      },
    },
  })
  const id = made.proposal.proposalId
  const answer = runOnTty(made, ['--vault', made.vault, id], `apply ${id}`)
  if (answer === null) {
    t.skip('expect(1) is unavailable, so no pseudo-terminal can be created')
    return
  }
  assert.equal(answer.status, 0, answer.output)
  assert.equal((await publishedNotes(made)).length, 1)
  const untouched = await readCurationProposal({
    dataRoot: made.dataRoot,
    projectId: made.binding.projectId,
    proposalId: other.proposalId,
  })
  assert.equal(untouched.state, 'pending', 'a run that names one id decides only that id')
})

test('the review display names the source it will touch and carries no credentials', async (t) => {
  const made = await parked(t)
  const id = made.proposal.proposalId
  const answer = runOnTty(made, ['--vault', made.vault, id], `reject ${id}`)
  if (answer === null) {
    t.skip('expect(1) is unavailable, so no pseudo-terminal can be created')
    return
  }
  assert.ok(answer.output.includes(made.seed.path), `expected ${made.seed.path} in the display`)
  assert.doesNotMatch(answer.output, /api[_-]?key|token|secret|password/iu)
})
