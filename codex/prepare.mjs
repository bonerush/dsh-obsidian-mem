#!/usr/bin/env node
// Prepare the local Codex marketplace that ships the two portable halves of this
// plugin: the skill (`skills/obsidian-mem/SKILL.md`, Agent Skills format) and the
// MCP server (`codex/server.mjs`, which reuses `lib/`).
//
// Why a generator: Codex *materializes* a plugin — `codex plugin add` copies the
// plugin directory into `~/.codex/plugins/cache/<marketplace>/<plugin>/`, so a
// relative path out of the plugin would break the moment it is installed, and a
// copy of `lib/` inside the plugin would be a second memory layer that drifts.
// Pointing `.mcp.json` at this checkout by absolute path keeps exactly one copy of
// the memory layer, at the cost of one machine-specific file — which is why that
// file is generated, never hand-edited, and git-ignored.
//
//   node codex/prepare.mjs           # write the generated .mcp.json
//   node codex/prepare.mjs --check   # verify it is present and current (exit 1 if not)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { listTools } from './server.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const PLUGIN = join(HERE, 'marketplace', 'plugins', 'dsh-obsidian-mem')
const MCP_FILE = join(PLUGIN, '.mcp.json')
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
 * Everything that must exist before the marketplace is worth adding.
 *
 * @returns {string[]} one message per problem; empty means the plugin is complete.
 */
export function problems() {
  const found = []
  if (!existsSync(SKILL_FILE)) found.push(`missing skill: ${SKILL_FILE}`)
  if (!existsSync(join(HERE, 'server.mjs'))) found.push('missing codex/server.mjs')
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
export function main({ check = false, log = (line) => process.stdout.write(`${line}\n`), fail = (line) => process.stderr.write(`${line}\n`) } = {}) {
  const required = problems()
  if (required.length > 0) {
    for (const problem of required) fail(`prepare: ${problem}`)
    return 1
  }

  const generated = `${JSON.stringify(mcpConfig(), null, 2)}\n`
  const current = existsSync(MCP_FILE) ? readFileSync(MCP_FILE, 'utf8') : null

  if (check) {
    if (current === null) {
      fail(`prepare --check: ${MCP_FILE} is missing; run: node codex/prepare.mjs`)
      return 1
    }
    if (current !== generated) {
      fail(`prepare --check: ${MCP_FILE} is stale; run: node codex/prepare.mjs`)
      return 1
    }
    log('prepare --check: ok (6 tools, skill and .mcp.json present)')
    return 0
  }

  mkdirSync(PLUGIN, { recursive: true })
  if (current !== generated) writeFileSync(MCP_FILE, generated)
  log(`${current === generated ? 'unchanged' : 'wrote'} ${MCP_FILE}`)
  log(`next: codex plugin marketplace add ${join(HERE, 'marketplace')}`)
  log('      codex plugin add dsh-obsidian-mem@dsh-obsidian-mem-local')
  return 0
}

// Only a direct run acts: importing this module (a test does) must not exit anything.
if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main({ check: process.argv.includes('--check') })
}
