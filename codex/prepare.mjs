#!/usr/bin/env node
// Prepare the local Codex marketplace: skill, MCP server, SessionStart brief,
// and UserPromptSubmit prompt recall. Both hooks reuse the shared memory layer.
//
// Why a generator: Codex *materializes* a plugin — `codex plugin add` copies the
// plugin directory into `~/.codex/plugins/cache/<marketplace>/<plugin>/`, so a
// relative path out of the plugin would break the moment it is installed, and a
// copy of `lib/` inside the plugin would be a second memory layer that drifts.
// Pointing `.mcp.json` and `hooks/hooks.json` at this checkout by absolute path
// keeps exactly one copy of the memory layer, at the cost of two machine-specific
// files — which is why both are generated, never hand-edited, and git-ignored.
//
//   node codex/prepare.mjs           # write the generated .mcp.json and hooks.json
//   node codex/prepare.mjs --check   # verify both are present and current (exit 1 if not)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { listTools } from './server.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const PLUGIN = join(HERE, 'marketplace', 'plugins', 'dsh-obsidian-mem')
const MCP_FILE = join(PLUGIN, '.mcp.json')
const HOOKS_FILE = join(PLUGIN, 'hooks', 'hooks.json')
const SKILL_FILE = join(PLUGIN, 'skills', 'obsidian-mem', 'SKILL.md')

/**
 * The MCP declaration Codex reads out of a plugin directory.
 *
 * `env_vars` forwards the named host variables into the server, so a user can
 * point the Codex side at another vault or data root (`OBSIDIAN_MEM_VAULT`,
 * `DSH_HOME`) without editing a generated file.
 *
 * @returns {object} the `.mcp.json` contents.
 */
export function mcpConfig() {
  return {
    mcpServers: {
      'obsidian-mem': {
        command: 'node',
        args: [join(HERE, 'server.mjs')],
        cwd: REPO,
        env_vars: ['HOME', 'PATH', 'DSH_HOME', 'OBSIDIAN_MEM_VAULT', 'OBSIDIAN_MEM_CWD'],
        startup_timeout_sec: 20,
        tool_timeout_sec: 120,
      },
    },
  }
}

/**
 * The hooks Codex reads out of the plugin directory.
 *
 * Two measured facts shape this object, and both were surprises worth writing
 * down (probe transcript in CHANGELOG.md):
 *
 *   * Codex discovers hooks at `<plugin>/hooks/hooks.json`. A plugin manifest may
 *     **not** declare them — the plugin-authoring spec embedded in codex-cli
 *     0.146.0 says validation "rejects unsupported manifest fields such as
 *     `hooks`" — and the manifest is where a reader looks first, so the file
 *     that works is named here instead.
 *   * `matcher` on `SessionStart` matches the session's `source`, not a tool
 *     name: a hook with `matcher = "clear"` does not fire on a `startup` session.
 *     It is left as `"*"` on purpose, so the decision about which sources are
 *     worth paying for lives in `session-start.mjs`, where a test can read it.
 *
 * `timeout` is in seconds and small on purpose: a slow vault may cost a session
 * fifteen seconds at worst. A hook that overruns is dropped and the session
 * continues, which is the same fail-open direction the script itself takes.
 *
 * @returns {object} the `hooks/hooks.json` contents.
 */
export function hooksConfig() {
  return {
    hooks: {
      SessionStart: [
        {
          matcher: '*',
          hooks: [
            {
              type: 'command',
              command: `node ${join(HERE, 'session-start.mjs')}`,
              timeout: 15,
              statusMessage: 'obsidian-mem: recalling project memory',
            },
          ],
        },
      ],
      UserPromptSubmit: [
        {
          hooks: [
            {
              type: 'command',
              command: `node ${join(HERE, 'prompt-submit.mjs')}`,
              timeout: 15,
              statusMessage: 'obsidian-mem: finding relevant project notes',
            },
          ],
        },
      ],
    },
  }
}

/**
 * Everything that must exist before the marketplace is worth adding.
 *
 * @returns {string[]} one message per problem; empty means the plugin is complete.
 */
export function problems() {
  const found = []
  if (!existsSync(SKILL_FILE)) found.push(`missing skill: ${SKILL_FILE}`)
  if (!existsSync(join(HERE, 'server.mjs'))) found.push('missing codex/server.mjs')
  if (!existsSync(join(HERE, 'session-start.mjs'))) found.push('missing codex/session-start.mjs')
  if (!existsSync(join(HERE, 'prompt-submit.mjs'))) found.push('missing codex/prompt-submit.mjs')
  if (!existsSync(join(HERE, 'marketplace', '.agents', 'plugins', 'marketplace.json'))) {
    found.push('missing marketplace/.agents/plugins/marketplace.json')
  }
  const tools = listTools().map((tool) => tool.name)
  if (tools.length !== 6) found.push(`the MCP server exposes ${tools.length} tools, expected 6`)
  return found
}

/**
 * Write or check the generated `.mcp.json`.
 *
 * @param {{ check?: boolean, log?: Function, fail?: Function }} [io] - output sinks, injected so a test can call this without exiting anything.
 * @returns {number} a process exit code.
 */
export function main({
  check = false,
  log = (line) => process.stdout.write(`${line}\n`),
  fail = (line) => process.stderr.write(`${line}\n`),
} = {}) {
  const required = problems()
  if (required.length > 0) {
    for (const problem of required) fail(`prepare: ${problem}`)
    return 1
  }

  const generated = [
    { path: MCP_FILE, body: `${JSON.stringify(mcpConfig(), null, 2)}\n` },
    { path: HOOKS_FILE, body: `${JSON.stringify(hooksConfig(), null, 2)}\n` },
  ]

  if (check) {
    let stale = false
    for (const file of generated) {
      const current = existsSync(file.path) ? readFileSync(file.path, 'utf8') : null
      if (current === null) {
        fail(`prepare --check: ${file.path} is missing; run: node codex/prepare.mjs`)
        stale = true
      } else if (current !== file.body) {
        fail(`prepare --check: ${file.path} is stale; run: node codex/prepare.mjs`)
        stale = true
      }
    }
    if (stale) return 1
    log('prepare --check: ok (6 tools, skill, .mcp.json and both hooks)')
    return 0
  }

  for (const file of generated) {
    // `hooks/` does not exist in a fresh checkout: the directory is the plugin's,
    // and only the generated file inside it is machine-specific.
    mkdirSync(dirname(file.path), { recursive: true })
    const current = existsSync(file.path) ? readFileSync(file.path, 'utf8') : null
    if (current !== file.body) writeFileSync(file.path, file.body)
    log(`${current === file.body ? 'unchanged' : 'wrote'} ${file.path}`)
  }
  log(`next: codex plugin marketplace add ${join(HERE, 'marketplace')}`)
  log('      codex plugin add dsh-obsidian-mem@dsh-obsidian-mem-local')
  return 0
}

// Only a direct run acts: importing this module (a test does) must not exit anything.
if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main({ check: process.argv.includes('--check') })
}
