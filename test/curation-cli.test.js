// Task 7: the interactive review command, driven over a pipe.
//
// The command exists because approval must not be model-callable: a human types
// the proposal id, and only a byte-for-byte match proceeds. These cases run the
// *shipped* binary as a child process against a throwaway world, so what is
// asserted is the command's real argv handling, its real refusal to read from a
// pipe, and its real exit code — not a helper the command also calls.
//
// The accepting path needs a terminal, which a pipe cannot be; those cases live in
// `test/curation-tty.test.js`, behind a real pseudo-terminal.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { test } from 'node:test'

import { ADMIN_ACTION_PARAMETERS, TOOL_PARAMETERS } from '../lib/tool-schema.js'
import { makeCurationWorld } from './curation-world.js'

const CLI = resolve(import.meta.dirname, '..', 'lib', 'curation-cli.js')

/** Run the shipped command with a pipe for stdin and stdout. */
function run(made, args, options = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: made.repo,
    encoding: 'utf8',
    env: { ...process.env, DSH_HOME: made.dshHome, ...(options.env ?? {}) },
    input: options.input ?? '',
    timeout: 30_000,
  })
}

test('the command refuses a pipe: approval requires an interactive terminal', async (t) => {
  // With `input` supplied the child is not waiting on a user, it is reading from a
  // pipe — exactly the model-callable route this command must not have. A non-zero
  // exit and a named code is the whole refusal.
  const made = await makeCurationWorld(t)
  const id = 'a'.repeat(64)
  const answer = run(made, ['--vault', made.vault, id], { input: `apply ${id}\n` })
  assert.notEqual(answer.status, 0)
  assert.match(answer.stderr, /interactive-tty-required/u)
})

test('an absolute --vault path is required before anything is read', async (t) => {
  const made = await makeCurationWorld(t)
  const relative = run(made, ['--vault', 'vault', 'a'.repeat(64)])
  assert.notEqual(relative.status, 0)
  assert.match(relative.stderr, /absolute-vault-path-required/u)

  const missing = run(made, ['a'.repeat(64)])
  assert.notEqual(missing.status, 0)
  assert.match(missing.stderr, /usage|--vault/u)
})

test('a missing --vault or a bad id is a usage error, before any store read', async (t) => {
  const made = await makeCurationWorld(t)
  const noVault = run(made, [])
  assert.notEqual(noVault.status, 0)
  assert.match(noVault.stderr, /--vault/u)
  const noId = run(made, ['--vault', made.vault])
  assert.notEqual(noId.status, 0)
  assert.match(noId.stderr, /proposal/u)
})

test('the review command is not reachable through any model tool action', () => {
  // The model-callable surface is `mem_admin`, and it must have no approve, apply
  // or reject action at all — a batch approval route is the thing this design
  // refuses, and a schema is where it would have to appear first. Read out of the
  // parameter specs the host compiles, not out of a second hand-copied list.
  const declared = Object.keys(ADMIN_ACTION_PARAMETERS)
  assert.ok(declared.length > 0, 'mem_admin must still declare its actions')
  const parameters = TOOL_PARAMETERS.mem_admin
  for (const name of [...declared, ...Object.keys(parameters)]) {
    assert.doesNotMatch(
      name,
      /apply|approve|reject|review/u,
      `mem_admin exposes ${name}, which would be a model-callable approval`,
    )
  }
  const actions = parameters.action.enum
  assert.deepEqual(
    [...actions].filter((action) => /apply|approve|reject|review/u.test(action)),
    [],
    'the approval route is the TTY command, never a mem_admin action',
  )
})
