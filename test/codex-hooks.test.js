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
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { hooksConfig } from '../codex/prepare.mjs'
import {
  curationCursorPath,
  readCurationCursor,
  readCurationViewJson,
} from '../lib/curation-state.js'
import {
  CONTINUE,
  INJECT_SOURCES,
  MAX_ROLLOUT_BYTES,
  briefFor,
  decide,
  hookOutput,
  resumeVerdict,
  runHook,
} from '../codex/session-start.mjs'
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
 * A synthetic Codex rollout.
 *
 * The shape is the measured one (`~/.codex/sessions/…/rollout-*.jsonl`): a
 * `session_meta` first line, then records, with the hook's injection serialized as a
 * developer message whose `input_text` starts with the brief marker.
 *
 * @param {object} options - what the rollout contains.
 * @param {boolean} [options.marker] - include a hook injection.
 * @param {boolean} [options.quote] - include a tool output that merely quotes the marker.
 * @param {boolean} [options.compacted] - append a compaction record after the injection.
 * @param {boolean} [options.compactedOnly] - append a compaction record with no injection.
 * @param {string} [options.padding] - extra records, to push past a byte cap.
 * @returns {string} the rollout text.
 */
function rollout({
  marker = true,
  quote = false,
  compacted = false,
  compactedOnly = false,
  padding = '',
} = {}) {
  const lines = [
    JSON.stringify({
      timestamp: '2026-10-04T11:34:00.000Z',
      ordinal: 0,
      type: 'session_meta',
      payload: { id: 'x' },
    }),
    JSON.stringify({
      timestamp: '2026-10-04T11:34:01.000Z',
      ordinal: 1,
      type: 'event_msg',
      payload: { type: 'task_started' },
    }),
  ]
  if (marker) {
    lines.push(
      JSON.stringify({
        timestamp: '2026-10-04T11:34:59.637Z',
        ordinal: 8,
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'developer',
          content: [
            {
              type: 'input_text',
              text: '<!-- obsidian-mem:brief mode=full -->\n> 引用数据\n\n<!-- brief: 10/6000 chars -->',
            },
          ],
        },
      }),
    )
  }
  if (quote) {
    // A grep of the rollout itself, which is what the vault's own convention
    // recommends. The marker appears, but escaped inside a JSON string — the exact
    // case a scan for the bare string gets wrong.
    lines.push(
      JSON.stringify({
        timestamp: '2026-10-04T11:35:00.000Z',
        ordinal: 9,
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          output:
            '9:{"type":"response_item","payload":{"content":[{"type":"input_text","text":"<!-- obsidian-mem:brief mode=full -->',
        },
      }),
    )
  }
  if (compacted || compactedOnly) {
    lines.push(
      JSON.stringify({
        timestamp: '2026-10-04T11:40:00.000Z',
        ordinal: 400,
        type: 'compacted',
        payload: {
          message: '',
          replacement_history: [
            { type: 'message', role: 'user', content: [{ type: 'input_text', text: '继续' }] },
          ],
          window_number: 1,
        },
      }),
    )
  }
  if (padding !== '') lines.push(padding)
  return `${lines.join('\n')}\n`
}

/** A rollout on disk under a throwaway directory. */
function rolloutFile(t, text, name = 'rollout-test.jsonl') {
  const dir = mkdtempSync(join(tmpdir(), 'codex-rollout-'))
  const path = join(dir, name)
  writeFileSync(path, text, 'utf8')
  return path
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

/**
 * The one project id the private curation state names, read off the hint the MCP
 * write leaves behind.
 *
 * The changed-path set's file name is the only document in this throwaway world
 * that spells the whole UUID out; a receipt carries a transaction id instead.
 *
 * @param {string} dataRoot - the throwaway plugin data root.
 * @returns {string} the project id.
 */
function hintedProjectId(dataRoot) {
  const dir = join(dataRoot, 'curation', 'changed')
  const names = readdirSync(dir)
  assert.equal(names.length, 1, `expected one hint, saw ${JSON.stringify(names)}`)
  return names[0].replace(/\.json$/u, '')
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

test('the hook injects on the sources that open a conversation with no context', async () => {
  // This started as a cost decision, not a technicality: `resume` continues a
  // conversation that already carries the earlier injection, so paying for the same
  // brief twice is the one saving the hook can make for free. `compact` was measured
  // out of that group: a rollout records what compaction leaves the model with in its
  // `compacted` payload's `replacement_history`, and the brief is not in it (see
  // `codex/README.md` for the sample), so a compacted session is one whose memory is
  // gone.
  assert.deepEqual([...INJECT_SOURCES], ['startup', 'clear', 'compact'])
  assert.equal((await decide(payload('/tmp'))).inject, true)
  assert.equal((await decide(payload('/tmp', { source: 'clear' }))).inject, true)
  assert.deepEqual(await decide(payload('/tmp', { source: 'compact' })), {
    inject: true,
    reason: 'compact',
  })
  // A `resume` is decided per session from the rollout. A payload with no readable
  // rollout path is `unknown`, and `unknown` keeps the behaviour this hook had before
  // the scan existed: a resumed conversation is assumed to still carry the brief.
  assert.deepEqual(await decide(payload('/tmp', { source: 'resume' })), {
    inject: false,
    reason: 'resume-unknown',
  })
  assert.deepEqual(await decide(payload('/tmp', { source: 'resume', transcript_path: '' })), {
    inject: false,
    reason: 'resume-unknown',
  })
})

test('anything that is not a SessionStart with a cwd injects nothing', async () => {
  assert.equal((await decide(null)).inject, false)
  assert.equal((await decide({ hook_event_name: 'Stop' })).reason, 'event-Stop')
  assert.equal((await decide(payload('/tmp', { cwd: '' }))).reason, 'cwd-missing')
  assert.equal((await decide(payload('/tmp', { cwd: '   ' }))).reason, 'cwd-missing')
  assert.equal((await decide(payload('/tmp', { source: undefined }))).reason, 'source-missing')
})

test('a resumed conversation is re-injected only when the rollout proves the brief is gone', async (t) => {
  // The scan's three answers, on synthetic rollouts shaped like the measured ones.
  const present = rolloutFile(t, rollout())
  assert.equal(await resumeVerdict(present), 'present', 'the injection is the latest record')
  assert.deepEqual(await decide(payload('/tmp', { source: 'resume', transcript_path: present })), {
    inject: false,
    reason: 'resume-present',
  })

  // Measured on a real rollout: the `compacted` record replaces the context and the
  // brief is not in `replacement_history`. This is the case that used to lose memory
  // silently for the rest of the conversation.
  const compacted = rolloutFile(t, rollout({ compacted: true }), 'compacted.jsonl')
  assert.equal(await resumeVerdict(compacted), 'absent')
  assert.deepEqual(
    await decide(payload('/tmp', { source: 'resume', transcript_path: compacted })),
    {
      inject: true,
      reason: 'resume-without-brief',
    },
  )

  // A rollout that never received an injection: the plugin was installed mid-thread, or
  // the session was imported from another agent.
  const never = rolloutFile(t, rollout({ marker: false }), 'never.jsonl')
  assert.equal(await resumeVerdict(never), 'absent')

  // A tool output that quotes the marker must not be mistaken for the injection: this
  // repository's own convention is to grep the rollout for it to verify the hook, and
  // inside that output every quote is escaped.
  const quoted = rolloutFile(t, rollout({ marker: false, quote: true }), 'quoted.jsonl')
  assert.equal(await resumeVerdict(quoted), 'absent', 'a quoted marker is not an injection')

  // Not a rollout, a compaction with no injection, and nothing at all are all
  // `unknown`/`absent` — never a false `present`.
  const notARollout = rolloutFile(t, '{"hello":"world"}\n', 'other.jsonl')
  assert.equal(await resumeVerdict(notARollout), 'unknown')
  assert.equal(await resumeVerdict(join(tmpdir(), 'definitely-not-here-0123456789')), 'unknown')
  assert.equal(await resumeVerdict(null), 'unknown')
  assert.equal(await resumeVerdict(42), 'unknown')
})

test('a rollout larger than the scan cap is answered conservatively, never as present', async (t) => {
  // The cap exists so a session start cannot read a 100 MB transcript. Past it the
  // answer is `unknown` in both directions: an unseen compaction could have dropped a
  // brief this scan can see, and an unseen injection could be one it cannot.
  const big = 'x'.repeat(4096)
  const withMarker = rolloutFile(
    t,
    rollout({ padding: JSON.stringify({ type: 'event_msg', payload: big }) }),
    'big.jsonl',
  )
  assert.equal(await resumeVerdict(withMarker, { maxBytes: 64 }), 'unknown')
  assert.equal(await resumeVerdict(withMarker), 'present', 'the default cap reads it whole')

  const markerBeyondCap = rolloutFile(t, rollout({ padding: big, marker: false }), 'beyond.jsonl')
  assert.equal(await resumeVerdict(markerBeyondCap, { maxBytes: 64 }), 'unknown')
  assert.equal(MAX_ROLLOUT_BYTES, 8 * 1024 * 1024)
})

test('a resume decision reaches the hook: a lost brief is injected, a live one is not', async (t) => {
  // Driven through `runHook`, so the decision, the reader and the answer document are
  // the ones a real session gets. `open` is a stub with `autoCurate: false` rather than
  // the real `openMemory` on purpose: `openMemory` without a `vaultPath` would resolve
  // this machine's *default* vault, and a test must never read a real one.
  const opened = []
  const open = (options) => {
    opened.push(options)
    return {
      config: { autoCurate: false },
      services: {
        brief: async () => ({ status: 'bound', text: 'THE BRIEF' }),
        close: async () => {},
      },
    }
  }
  const compacted = rolloutFile(t, rollout({ compacted: true }), 'resume-compacted.jsonl')
  const out = {
    writes: [],
    write(text) {
      this.writes.push(text)
    },
  }
  const answer = await runHook(
    JSON.stringify(payload('/work/demo', { source: 'resume', transcript_path: compacted })),
    { open, out, err: { write() {} } },
  )
  assert.equal(answer.hookSpecificOutput?.hookEventName, 'SessionStart')
  assert.equal(answer.hookSpecificOutput.additionalContext, 'THE BRIEF')
  assert.equal(opened.length, 1, 'the vault is opened once, for the brief that was owed')

  const live = rolloutFile(t, rollout(), 'resume-live.jsonl')
  const quietOut = {
    writes: [],
    write(text) {
      this.writes.push(text)
    },
  }
  const quiet = await runHook(
    JSON.stringify(payload('/work/demo', { source: 'resume', transcript_path: live })),
    { open, out: quietOut, err: { write() {} } },
  )
  assert.deepEqual(
    quiet,
    { ...CONTINUE },
    'a conversation that still carries the brief pays nothing',
  )
  assert.equal(opened.length, 1, 'and no vault is opened for it')
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

test('UserPromptSubmit offers a matching note with its excerpt once per session', async () => {
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
  // The excerpt the index computed for this query travels with the path, so the
  // turn does not depend on a second voluntary `mem_read` call.
  assert.match(first.answer.hookSpecificOutput.additionalContext, /Codex 侧用/)

  const repeat = hook(env, submitted, PROMPT_HOOK)
  assert.equal(repeat.status, 0)
  assert.deepEqual(repeat.answer, { continue: true })
  const stateDir = join(space.dsh, 'data', 'obsidian-mem', 'prompt-recall')
  const files = readdirSync(stateDir)
  assert.equal(files.length, 1)
  const saved = JSON.parse(readFileSync(join(stateDir, files[0]), 'utf8'))
  assert.deepEqual(Object.keys(saved), ['paths'])
  assert.deepEqual(saved.paths, [receipt.path])
  // The excerpt reaches the model, never the state file: persistence stays
  // paths-only, exactly as before.
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
  const dataRoot = join(space.dsh, 'data', 'obsidian-mem')
  assert.deepEqual(readdirSync(dataRoot), ['diagnostics'])
  assert.equal(readdirSync(join(dataRoot, 'diagnostics')).length, 1)
  const malformed = hook(env, 'not JSON', PROMPT_HOOK)
  assert.equal(malformed.status, 0)
  assert.deepEqual(malformed.answer, { continue: true })
  assert.equal(readdirSync(join(dataRoot, 'diagnostics')).length, 1)
})

test('a bound project is skipped on resume, and an unbound directory is asked about', async () => {
  const space = world()
  const env = { HOME: space.home, DSH_HOME: space.dsh, OBSIDIAN_MEM_VAULT: space.vault }
  // Bound **before** the cases below, on purpose: the resume control only means
  // something if there is a vault it would have opened. Against an unbound
  // directory every source looks identical, and the control proves nothing.
  await bind(space)
  const other = join(space.home, 'not-a-project')
  mkdirSync(other, { recursive: true })

  // A directory that is not this plugin's project gets DSH's one-shot notice — the
  // question the user is asked, with the call that answers it — instead of silence.
  // Before this, the two harnesses disagreed: DSH asked, Codex said nothing until a
  // tool happened to be called.
  const unbound = hook(env, JSON.stringify(payload(other)))
  assert.equal(unbound.status, 0)
  assert.equal(unbound.answer.hookSpecificOutput?.hookEventName, 'SessionStart')
  const notice = unbound.answer.hookSpecificOutput?.additionalContext ?? ''
  assert.ok(notice.includes('mem_admin(action="bind", mode="local")'), notice)
  assert.ok(notice.includes(other), 'the directory in question is named')
  assert.ok(!notice.includes('项目绑定'), 'a notice is not a brief')
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
  // The absorption this file is about, driven at the seam that decides it: an
  // `openMemory` that throws (a vault path that is a file, an unreadable vault) must
  // come back as exactly one `continue: true` document with the reason on stderr.
  // The subprocess cases above cannot reach this — an unbound directory answers from
  // the resolution and never opens the vault, and a bound project with a different
  // vault path simply produces no text.
  const out = {
    writes: [],
    write(text) {
      this.writes.push(text)
    },
  }
  const err = {
    writes: [],
    write(text) {
      this.writes.push(text)
    },
  }
  const answer = await runHook(JSON.stringify(payload('/work/demo')), {
    open: () => {
      throw new Error('vault is a file')
    },
    out,
    err,
  })
  assert.deepEqual(answer, { ...CONTINUE }, 'a refused vault is not a refused session')
  assert.equal(out.writes.length, 1, 'exactly one document is written')
  assert.match(err.writes.join(''), /brief failed/, 'and the reason reaches stderr')
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

// ---------------------------------------------------------------------------
// The automatic curation trigger (curation Task 6)
// ---------------------------------------------------------------------------

/**
 * One `openMemory`-shaped handle whose services are the test's own, with a spy
 * on the one call the due pass is allowed to make.
 *
 * The shape is what `briefFor` reads (`services.brief`, `services.close`,
 * `config.autoCurate`), so the trigger's decision is exercised without a vault:
 * the bound and the configuration switch are exactly the two inputs that are not
 * about the brief, and the process-level controls below cover the vault.
 *
 * @param {object} [input] - overrides: `text`, `status`, `autoCurate`, `fail`.
 * @returns {object} the handle plus `calls` and `closed`.
 */
function curationHandle({
  text = '# obsidian-mem:brief\n\n- 一条记忆\n',
  status = 'ok',
  autoCurate = true,
  fail = false,
} = {}) {
  const calls = []
  const state = { closed: 0 }
  return {
    calls,
    state,
    config: { autoCurate },
    diagnostics: { event: () => {} },
    services: {
      brief: async () => ({ status, text }),
      curateCurrentProject: async (options) => {
        calls.push(options)
        if (fail) {
          const error = new Error('the cursor could not be read')
          error.code = 'curation-state'
          throw error
        }
        return { status: 'scanned', projectId: '1c392abb-7b08-42f7-871d-2a379caf9448' }
      },
      close: async () => {
        state.closed += 1
      },
    },
  }
}

test('a bound SessionStart runs one due pass with the bounded limits and one JSON line', async () => {
  const lines = []
  const err = []
  const handle = curationHandle()
  const out = { write: (line) => lines.push(line) }
  const result = await runHook(JSON.stringify(payload('/work/demo')), {
    open: () => handle,
    out,
    err: { write: (line) => err.push(line) },
  })

  // The hook document Codex validates, and the one wire line it arrives on: a
  // `console.log` anywhere below this would be read as a second answer.
  assert.equal(result.hookSpecificOutput.hookEventName, 'SessionStart')
  assert.match(result.hookSpecificOutput.additionalContext, /obsidian-mem:brief/u)
  assert.equal(lines.length, 1)
  assert.deepEqual(JSON.parse(lines[0]), result)
  assert.equal(handle.calls.length, 1, 'one due pass and no more')
  assert.deepEqual(handle.calls[0], { dueOnly: true, maxNotes: 256, maxMs: 500 })
  // The brief is built first, so the pass can never be what the injected text
  // waits for.
  assert.equal(handle.state.closed, 1)
  assert.deepEqual(err, [])
})

test('a scan that throws changes neither the injected brief nor the exit code', async () => {
  const lines = []
  const handle = curationHandle({ fail: true })
  const result = await runHook(JSON.stringify(payload('/work/demo')), {
    open: () => handle,
    out: { write: (line) => lines.push(line) },
    err: { write: () => {} },
  })

  assert.equal(result.hookSpecificOutput.hookEventName, 'SessionStart')
  assert.match(result.hookSpecificOutput.additionalContext, /obsidian-mem:brief/)
  assert.equal(lines.length, 1, 'a failed pass still emits exactly one line')
  assert.deepEqual(JSON.parse(lines[0]), result)
  assert.equal(handle.calls.length, 1)
  assert.equal(handle.state.closed, 1, 'the hook releases what it opened even on the failure path')
})

test('autoCurate:false and an unbound project both claim no automatic pass', async () => {
  // `briefFor` is called directly here for the same reason the process-level
  // controls exist: the switch has exactly one effect, and the stub makes it
  // impossible for the assertion to pass because of an unrelated crash.
  const off = curationHandle({ autoCurate: false })
  const injected = await briefFor('/work/demo', () => off)
  assert.match(injected, /obsidian-mem:brief/u)
  assert.deepEqual(off.calls, [], 'autoCurate:false disables the automatic pass and nothing else')

  const unbound = curationHandle({ status: 'unbound', text: '' })
  assert.equal(await briefFor('/work/demo', () => unbound), null)
  assert.deepEqual(unbound.calls, [], 'an unbound directory must not start a pass')
})

test('the Codex notice uses the same fallback when the budget cannot carry the full wording', async () => {
  // Both harnesses compose the notice through `bindHintWithin`, and this is the Codex
  // half of that claim: a config whose `briefBudgetChars` cannot hold the 261-code-point
  // `no-pointer` notice still gets the one-line form instead of silence — which is what
  // a resumed session at that budget would otherwise be left with.
  const opened = []
  const open = (options) => {
    opened.push(options)
    return {
      config: { briefBudgetChars: 256, autoCurate: false },
      services: {
        brief: async () => ({ status: 'unbound', reason: 'no-pointer', repoRoot: '/work/demo' }),
        close: async () => {},
      },
    }
  }
  const text = await briefFor('/work/demo', open)
  assert.equal(typeof text, 'string', 'the question is still asked at the floor')
  assert.ok([...text].length <= 256, `the notice respects the budget (${[...text].length})`)
  assert.ok(text.includes('mem_admin(action="bind", mode="local")'))
  assert.ok(!text.includes('\n'), 'the one-line form is the one that fit')

  // The same refusal at the default budget gets the detailed wording, so the fallback is
  // not a replacement for it.
  const roomy = await briefFor('/work/demo', () => ({
    config: { briefBudgetChars: 6000, autoCurate: false },
    services: {
      brief: async () => ({ status: 'unbound', reason: 'no-pointer', repoRoot: '/work/demo' }),
      close: async () => {},
    },
  }))
  assert.ok(roomy.includes('\n'), 'the detailed wording is used when it fits')
  assert.ok([...roomy].length > 200)
})

test('a bound start injects the real brief and the due pass never reaches stdout', async () => {
  // The process-level half of the contract: whatever the pass answers, the wire
  // carries the brief and nothing else. The counting stub stands in for the seam
  // so the pass's own answer cannot be mistaken for the hook document.
  const space = world()
  const receipt = await bind(space)
  const dataRoot = join(space.dsh, 'data', 'obsidian-mem')
  const projectId = hintedProjectId(dataRoot)
  // The MCP write leaves the durable hint and nothing else: it has no worker to
  // wake, so any cursor or view below can only be the hook's own pass.
  assert.equal(
    existsSync(curationCursorPath(dataRoot, projectId)),
    false,
    'an MCP-only write runs no pass',
  )
  const run = hook(
    { HOME: space.home, DSH_HOME: space.dsh, OBSIDIAN_MEM_VAULT: space.vault },
    JSON.stringify(payload(space.repo)),
  )
  assert.equal(run.status, 0)
  assert.equal(run.lines.length, 1)
  assert.equal(run.answer.hookSpecificOutput.hookEventName, 'SessionStart')
  // The real hook wrote the real brief for the note `bind` committed.
  assert.match(run.answer.hookSpecificOutput.additionalContext, /钩子注入的决定/u)
  // And the real handle ran the due pass, not just the stub below: the pass leaves
  // a marker and a committed view for the note the write queued, which is state no
  // other caller in this world can produce.
  const cursor = await readCurationCursor(dataRoot, projectId)
  assert.notEqual(cursor, null, 'the hook process ran the automatic pass')
  const view = await readCurationViewJson(dataRoot, projectId)
  assert.equal(view.complete, true)
  assert.equal(
    view.entries.some((entry) => entry.path === receipt.path),
    true,
    'the due pass inspected the note the MCP write committed',
  )

  const handle = curationHandle({ text: '# obsidian-mem:brief\n\n- 钩子注入的决定\n' })
  const lines = []
  const stubbed = await runHook(JSON.stringify(payload(space.repo)), {
    open: () => handle,
    out: { write: (line) => lines.push(line) },
    err: { write: () => {} },
  })
  assert.equal(stubbed.hookSpecificOutput.hookEventName, 'SessionStart')
  assert.equal(lines.length, 1)
  assert.deepEqual(handle.calls, [{ dueOnly: true, maxNotes: 256, maxMs: 500 }])
  assert.match(receipt.path, /Decisions\//u)
})

test('the automatic pass parks a real candidate, and the other adapter reads it back', async (t) => {
  // One throwaway world, two real adapter inputs: an MCP write pair that leaves a
  // durable hint, then the installed hook's own due pass over it. What that pass
  // finds is what the MCP status surface has to report, because both adapters
  // derive one data root from `DSH_HOME` — nothing here is a second queue.
  const space = world()
  const memory = openMemory({
    cwd: space.repo,
    dshHome: space.dsh,
    vaultPath: space.vault,
    home: space.home,
  })
  const first = await memory.services.write({
    type: 'decision',
    title: '钩子注入的决定',
    body: 'Codex 侧用 SessionStart 钩子注入简报。',
  })
  // Same title and type, a different body: the scanner's near-duplicate finding,
  // which is parked for review rather than merged or dropped.
  const second = await memory.services.write({
    type: 'decision',
    title: '钩子注入的决定',
    body: '同一标题，另一条不同的结论。',
  })
  await memory.services.close()
  assert.notEqual(second.path, first.path)

  const dataRoot = join(space.dsh, 'data', 'obsidian-mem')
  const projectId = hintedProjectId(dataRoot)

  // The real hook process: one JSON line, exit zero, the real brief inside it.
  const run = hook(
    { HOME: space.home, DSH_HOME: space.dsh, OBSIDIAN_MEM_VAULT: space.vault },
    JSON.stringify(payload(space.repo)),
  )
  assert.equal(run.status, 0)
  assert.equal(run.lines.length, 1)
  assert.match(run.answer.hookSpecificOutput.additionalContext, /钩子注入的决定/u)

  // The other adapter's read-only status surface, over the same data root.
  const reader = openMemory({
    cwd: space.repo,
    dshHome: space.dsh,
    vaultPath: space.vault,
    home: space.home,
  })
  t.after(() => reader.services.close?.())
  const status = await reader.services.admin({ action: 'curation', operation: 'status' })
  assert.equal(status.action, 'curation')
  assert.equal(status.result.status, 'listed')
  assert.equal(status.result.operation, 'status')
  assert.equal(status.result.projectId, projectId)
  assert.equal(status.result.complete, true, JSON.stringify(status.result))
  assert.equal(status.result.examined, 0, 'status inspects nothing')
  assert.equal(status.result.autoEnabled, true)
  assert.ok(status.result.counts.entries >= 2, JSON.stringify(status.result.counts))
  assert.ok(
    status.result.proposals.pending >= 1,
    `the hook pass must park the near duplicate: ${JSON.stringify(status.result.proposals)}`,
  )

  // The index followed both writes, and their receipts are durable under the one
  // data root the two adapters derive from `DSH_HOME`.
  const hits = await reader.services.search({ query: '钩子注入的决定' })
  for (const written of [first, second]) {
    assert.equal(
      hits.some((hit) => hit.path === written.path),
      true,
      `${written.path} is missing from mem_search`,
    )
    assert.equal((await reader.services.read({ path: written.path })).path, written.path)
  }
  assert.ok(readdirSync(join(dataRoot, 'receipts'), { recursive: true }).length >= 2)
})

test('a source that injects nothing opens no vault and claims no pass', async () => {
  // A `resume` whose rollout says the brief is still there continues a conversation
  // that already carries it, so the hook returns before `openMemory` is reached: the
  // counterfactual root is never created, which is what "opens no data root" means
  // when there is a bound repository it *would* have opened. (`compact` used to be in
  // this group and is not any more: it is the one source measured to drop the brief,
  // so it pays for it again — see the sources case above.)
  const space = world()
  await bind(space)
  {
    const env = { HOME: space.home, DSH_HOME: space.dsh, OBSIDIAN_MEM_VAULT: space.vault }
    for (const source of ['resume', 'unknown-source']) {
      const root = join(space.home, `skipped-${source}`)
      const run = hook({ ...env, DSH_HOME: root }, JSON.stringify(payload(space.repo, { source })))
      assert.equal(run.status, 0)
      assert.deepEqual(run.answer, { ...CONTINUE })
      assert.equal(run.lines.length, 1)
      assert.equal(existsSync(root), false, `${source} must not open a data root`)
    }
    // An unbound directory on a *startup* source is the other half of this file's
    // contract, and deliberately not "injects nothing": it gets the notice instead of
    // the brief, still exactly one document, and still no curation pass (there is no
    // project to curate) — asserted by the sibling case above.
    const other = join(space.home, 'not-a-project')
    mkdirSync(other, { recursive: true })
    const unbound = hook(env, JSON.stringify(payload(other)))
    assert.equal(unbound.answer.hookSpecificOutput?.hookEventName, 'SessionStart')
    assert.equal(unbound.lines.length, 1)
  }
})

test('the unbound notice can be turned off in the Codex adapter', async () => {
  // The SessionStart hook is its own process with no Cordis row, so the switch comes
  // from the environment (`OBSIDIAN_MEM_BIND_HINT`); without this the README's claim
  // that the notice is a switch would be a DSH-only promise.
  const space = world()
  const other = join(space.home, 'not-a-project')
  mkdirSync(other, { recursive: true })
  const env = { HOME: space.home, DSH_HOME: space.dsh, OBSIDIAN_MEM_VAULT: space.vault }
  const off = hook({ ...env, OBSIDIAN_MEM_BIND_HINT: '0' }, JSON.stringify(payload(other)))
  assert.equal(off.status, 0)
  assert.deepEqual(off.answer, { ...CONTINUE }, 'the notice is off')
  assert.equal(off.lines.length, 1)
  const on = hook({ ...env, OBSIDIAN_MEM_BIND_HINT: '1' }, JSON.stringify(payload(other)))
  assert.equal(on.answer.hookSpecificOutput?.hookEventName, 'SessionStart')
})
