// Codex hook adapters for session briefs and prompt-specific memory maps.
//
// These cases drive the real script as a process, with the payload shape measured
// from codex-cli 0.146.0 and a throwaway home, data root, vault and repository —
// never the machine's real ones. What they cannot drive is Codex itself: the
// discovery, the trust gate and the injection are recorded as measurements in
// CHANGELOG.md, and the negative control (an untrusted hook opens no data root)
// is what keeps those measurements from being a story about the wrong process.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { hooksConfig } from '../codex/prepare.mjs'
import { CONTINUE, INJECT_SOURCES, decide, hookOutput } from '../codex/session-start.mjs'
import { openMemory } from '../codex/server.mjs'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const HOOK = join(REPO, 'codex', 'session-start.mjs')
const PROMPT_HOOK = join(REPO, 'codex', 'prompt-submit.mjs')
const PLUGIN = join(REPO, 'codex', 'marketplace', 'plugins', 'dsh-obsidian-mem')

/**
 * A throwaway world: home, data root, vault and a git repository to bind.
 *
 * @returns {{home: string, dsh: string, vault: string, repo: string}} absolute paths.
 */
function world() {
  const home = mkdtempSync(join(tmpdir(), 'codex-hook-'))
  const vault = join(home, 'vault')
  const repo = join(home, 'demo-repo')
  mkdirSync(vault, { recursive: true })
  mkdirSync(repo, { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: repo })
  return { home, dsh: join(home, 'dsh'), vault, repo }
}

/**
 * One SessionStart document, as codex-cli 0.146.0 writes it to a hook's stdin.
 *
 * @param {string} cwd - the session's working directory.
 * @param {object} [overrides] - fields to replace.
 * @returns {object} the payload.
 */
function payload(cwd, overrides = {}) {
  return {
    session_id: '01a0d858-0000-7000-8000-000000000000',
    transcript_path: null,
    cwd,
    hook_event_name: 'SessionStart',
    model: 'gpt-5.6-sol',
    permission_mode: 'default',
    source: 'startup',
    ...overrides,
  }
}

/**
 * Run the hook as Codex does: the payload on stdin, one JSON object on stdout.
 *
 * @param {object} env - the child's environment, always built from a fresh `world()`.
 * @param {string} input - the raw stdin.
 * @returns {{status: number|null, stdout: string, stderr: string, answer: object|null, lines: string[]}} the run.
 */
function hook(env, input, script = HOOK) {
  const child = { ...process.env, ...env }
  delete child.OBSIDIAN_MEM_CWD
  const run = spawnSync(process.execPath, [script], { input, encoding: 'utf8', env: child })
  const lines = run.stdout.split('\n').filter((line) => line !== '')
  return {
    status: run.status,
    stdout: run.stdout,
    stderr: run.stderr,
    answer: parsed(run.stdout),
    lines,
  }
}

/**
 * Parse the hook's stdout, or `null` when it is not one JSON document.
 *
 * @param {string} text - the child's stdout.
 * @returns {object|null} the parsed answer.
 */
function parsed(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** Bind one repository by writing a note into it, the way the MCP side does. */
async function bind({ dsh, vault, repo, home }) {
  const memory = openMemory({ cwd: repo, dshHome: dsh, vaultPath: vault, home })
  const receipt = await memory.services.write({
    type: 'decision',
    title: '钩子注入的决定',
    body: 'Codex 侧用 SessionStart 钩子注入简报。',
  })
  await memory.services.close?.()
  return receipt
}

test('the hook injects on the sources that open a conversation with no context', () => {
  // The choice this pins is a cost decision, not a technicality: `resume` and
  // `compact` continue a conversation that already carries (or summarises) the
  // earlier injection, so paying for the same brief twice is the one saving the
  // hook can make for free.
  assert.deepEqual([...INJECT_SOURCES], ['startup', 'clear'])
  assert.equal(decide(payload('/tmp')).inject, true)
  assert.equal(decide(payload('/tmp', { source: 'clear' })).inject, true)
  assert.deepEqual(decide(payload('/tmp', { source: 'resume' })), {
    inject: false,
    reason: 'source-resume',
  })
  assert.deepEqual(decide(payload('/tmp', { source: 'compact' })), {
    inject: false,
    reason: 'source-compact',
  })
})

test('anything that is not a SessionStart with a cwd injects nothing', () => {
  assert.equal(decide(null).inject, false)
  assert.equal(decide({ hook_event_name: 'Stop' }).reason, 'event-Stop')
  assert.equal(decide(payload('/tmp', { cwd: '' })).reason, 'cwd-missing')
  assert.equal(decide(payload('/tmp', { cwd: '   ' })).reason, 'cwd-missing')
  assert.equal(decide(payload('/tmp', { source: undefined })).reason, 'source-missing')
})

test('the success answer is the document Codex validates', () => {
  assert.deepEqual(hookOutput('hello'), {
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'hello' },
  })
  // `continue: true` is written out rather than left to the client's default: a
  // Codex release that changed that default would otherwise turn this plugin's
  // quiet no-op into a session that will not start.
  assert.deepEqual({ ...CONTINUE }, { continue: true })
})

test('a bound repository gets the same brief DSH injects, and nothing else on stdout', async () => {
  const space = world()
  const receipt = await bind(space)
  assert.match(receipt.path, /^Projects\/demo-repo--[0-9a-f]{8}\/Decisions\//)

  const run = hook(
    { HOME: space.home, DSH_HOME: space.dsh, OBSIDIAN_MEM_VAULT: space.vault },
    JSON.stringify(payload(space.repo)),
  )
  assert.equal(run.status, 0)
  // One line, because stdout is a protocol channel: a stray `console.log` in this
  // script or in anything it imports would be read as part of the hook document.
  assert.equal(run.lines.length, 1)
  assert.equal(run.answer.hookSpecificOutput.hookEventName, 'SessionStart')
  const injected = run.answer.hookSpecificOutput.additionalContext
  assert.match(injected, /obsidian-mem:brief/)
  assert.match(injected, /钩子注入的决定/)
  assert.equal(injected.trim(), injected)
})

test('UserPromptSubmit offers a matching note once per session and stores no prompt text', async () => {
  const space = world()
  const receipt = await bind(space)
  const env = { HOME: space.home, DSH_HOME: space.dsh, OBSIDIAN_MEM_VAULT: space.vault }
  const submitted = JSON.stringify({
    ...payload(space.repo),
    hook_event_name: 'UserPromptSubmit',
    turn_id: 'turn-1',
    prompt: '钩子注入的决定',
  })
  const first = hook(env, submitted, PROMPT_HOOK)
  assert.equal(first.status, 0)
  assert.equal(first.lines.length, 1)
  assert.equal(first.answer.hookSpecificOutput.hookEventName, 'UserPromptSubmit')
  assert.match(first.answer.hookSpecificOutput.additionalContext, /mem_read/)
  assert.ok(first.answer.hookSpecificOutput.additionalContext.includes(receipt.path))
  assert.doesNotMatch(first.answer.hookSpecificOutput.additionalContext, /Codex 侧用/)

  const repeat = hook(env, submitted, PROMPT_HOOK)
  assert.equal(repeat.status, 0)
  assert.deepEqual(repeat.answer, { continue: true })
  const stateDir = join(space.dsh, 'data', 'obsidian-mem', 'prompt-recall')
  const files = readdirSync(stateDir)
  assert.equal(files.length, 1)
  const saved = JSON.parse(readFileSync(join(stateDir, files[0]), 'utf8'))
  assert.deepEqual(Object.keys(saved), ['paths'])
  assert.deepEqual(saved.paths, [receipt.path])
  assert.doesNotMatch(JSON.stringify(saved), /Codex 侧用/)
})

test('UserPromptSubmit is quiet for an unbound directory or malformed input', () => {
  const space = world()
  const env = { HOME: space.home, DSH_HOME: space.dsh, OBSIDIAN_MEM_VAULT: space.vault }
  const unbound = hook(
    env,
    JSON.stringify({
      ...payload(space.repo),
      hook_event_name: 'UserPromptSubmit',
      prompt: 'FTS5 中文索引',
    }),
    PROMPT_HOOK,
  )
  assert.equal(unbound.status, 0)
  assert.deepEqual(unbound.answer, { continue: true })
  assert.equal(existsSync(space.dsh), false)
  const malformed = hook(env, 'not JSON', PROMPT_HOOK)
  assert.equal(malformed.status, 0)
  assert.deepEqual(malformed.answer, { continue: true })
})

test('a bound project is skipped on resume, and an unbound directory always', async () => {
  const space = world()
  const env = { HOME: space.home, DSH_HOME: space.dsh, OBSIDIAN_MEM_VAULT: space.vault }
  // Bound **before** the cases below, on purpose: the resume control only means
  // something if there is a vault it would have opened. Against an unbound
  // directory every source looks identical, and the control proves nothing.
  await bind(space)
  const other = join(space.home, 'not-a-project')
  mkdirSync(other, { recursive: true })

  // A directory that is not this plugin's project: most directories on any
  // machine. It is not a refusal, and it must not read as one to the model.
  const unbound = hook(env, JSON.stringify(payload(other)))
  assert.deepEqual(unbound.answer, { ...CONTINUE })
  assert.equal(unbound.lines.length, 1)

  const suspended = join(space.home, 'untouched-dsh')
  const resumed = hook(
    { ...env, DSH_HOME: suspended },
    JSON.stringify(payload(space.repo, { source: 'resume' })),
  )
  assert.deepEqual(resumed.answer, { ...CONTINUE })
  assert.equal(existsSync(suspended), false, 'a skipped source must not open a vault')

  // Failure to parse is the same answer as failure to find: neither may reach the
  // user as a session that will not start.
  const junk = hook(env, 'this is not JSON')
  assert.equal(junk.status, 0)
  assert.deepEqual(junk.answer, { ...CONTINUE })
  assert.equal(junk.lines.length, 1)
})

test('a vault that refuses still costs the session nothing', async () => {
  const space = world()
  // A vault path that is a file cannot be bootstrapped: this is the failure the
  // hook must absorb, because the alternative is a session that will not start.
  const notAVault = join(space.home, 'not-a-vault')
  mkdirSync(notAVault, { recursive: true })
  const file = join(notAVault, 'blocker')
  execFileSync('touch', [file])

  const run = hook(
    { HOME: space.home, DSH_HOME: space.dsh, OBSIDIAN_MEM_VAULT: file },
    JSON.stringify(payload(space.repo)),
  )
  assert.equal(run.status, 0, 'the hook always exits 0')
  assert.deepEqual(run.answer, { ...CONTINUE })
  assert.equal(run.lines.length, 1)
})

test('the plugin ships its hook at the path Codex discovers, and not in the manifest', () => {
  // Measured on codex-cli 0.146.0: `hooks/list` reports the hook below with
  // source "plugin" and this plugin's id, while the plugin-authoring spec the same
  // binary carries says validation "rejects unsupported manifest fields such as
  // hooks" — so the manifest is exactly where a hook must NOT be declared.
  const config = hooksConfig()
  const groups = config.hooks.SessionStart
  assert.equal(groups.length, 1)
  assert.equal(groups[0].matcher, '*')
  const handler = groups[0].hooks[0]
  assert.equal(handler.type, 'command')
  assert.match(handler.command, /session-start\.mjs$/)
  assert.equal(handler.timeout, 15)
  assert.match(config.hooks.UserPromptSubmit[0].hooks[0].command, /prompt-submit\.mjs$/)
  assert.equal(typeof handler.statusMessage, 'string')
  // An absolute path, because Codex copies the plugin into
  // ~/.codex/plugins/cache/… and a relative one would resolve inside that copy.
  const script = handler.command.replace(/^node /, '')
  assert.equal(script.startsWith('/'), true)
  assert.equal(existsSync(script), true)
  assert.equal(script, HOOK)

  const manifest = join(PLUGIN, '.codex-plugin', 'plugin.json')
  if (existsSync(manifest)) {
    assert.equal('hooks' in JSON.parse(readFileSync(manifest, 'utf8')), false)
  }
  // The generated file is what Codex reads; a stale one is an install that runs an
  // older command, so comparing it to the generator is the whole check.
  const generated = join(PLUGIN, 'hooks', 'hooks.json')
  if (existsSync(generated)) {
    assert.deepEqual(
      JSON.parse(readFileSync(generated, 'utf8')),
      config,
      'run: node codex/prepare.mjs',
    )
  } else {
    assert.match(hooksConfig().hooks.SessionStart[0].hooks[0].command, /session-start\.mjs$/)
  }
  assert.deepEqual(readdirSync(join(PLUGIN, 'skills')), ['obsidian-mem'])
})
