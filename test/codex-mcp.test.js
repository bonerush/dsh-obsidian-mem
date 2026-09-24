// The Codex (MCP) adapter: a real handshake, a real write, a real search.
//
// `codex/server.mjs` is the second entry point into `lib/` — the first being the
// DSH plugin — so this file pins the three things that would otherwise rot
// silently:
//
//   * the MCP tool surface IS the plugin's six tools. The names come from
//     `TOOL_NAMES` and the argument schemas are derived from `TOOL_PARAMETERS`,
//     so a seventh tool or a renamed argument cannot appear on one side only.
//   * the working directory comes from the client's `roots/list`, NOT from the
//     server's own cwd. Codex launches a plugin's MCP server with the *plugin*
//     directory as cwd, so a server that trusted `process.cwd()` would bind the
//     wrong project — or bind this repository's checkout.
//   * a failed tool call is an `isError` result, and the server keeps answering.
//
// Nothing here touches the real harness state: the child gets a throwaway
// `DSH_HOME`, vault, home directory and repository through its environment, and
// no test writes under `~/.codex` or into the user's vault.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { jsonSchemaFor, listTools } from '../codex/server.mjs'
import { mcpConfig, problems } from '../codex/prepare.mjs'
import { TOOL_NAMES, TOOL_PARAMETERS } from '../lib/tools.js'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SERVER = join(REPO, 'codex', 'server.mjs')

/**
 * A throwaway world: home, data root, vault and a git repository to bind.
 *
 * @returns {{home: string, dsh: string, vault: string, repo: string}} absolute paths.
 */
function world() {
  const home = mkdtempSync(join(tmpdir(), 'codex-mcp-'))
  const vault = join(home, 'vault')
  const repo = join(home, 'demo-repo')
  mkdirSync(vault, { recursive: true })
  mkdirSync(repo, { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: repo })
  return { home, dsh: join(home, 'dsh'), vault, repo }
}

/**
 * Start the server and speak newline-delimited JSON-RPC to it.
 *
 * @param {object} env - the child's environment (always relative to a fresh `world()`).
 * @returns {Promise<{request: Function, notify: Function, respond: Function, close: Function, logs: string[]}>} a client.
 */
async function connect(env) {
  const child = spawn(process.execPath, [SERVER], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  const logs = []
  child.stderr.on('data', (chunk) => logs.push(String(chunk)))
  let buffer = ''
  let nextId = 1
  const waiting = new Map()
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    for (let index = buffer.indexOf('\n'); index !== -1; index = buffer.indexOf('\n')) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      if (line.trim() === '') continue
      const message = JSON.parse(line)
      const settle = waiting.get(message.id)
      if (settle !== undefined) {
        waiting.delete(message.id)
        settle(message)
      }
    }
  })
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`)
  const answer = (id, result) => send({ jsonrpc: '2.0', id, result })
  const request = (method, params) => new Promise((settle, fail) => {
    const id = nextId
    nextId += 1
    waiting.set(id, settle)
    send({ jsonrpc: '2.0', id, method, params })
    setTimeout(() => {
      if (waiting.delete(id)) fail(new Error(`no answer to ${method} within 20s`))
    }, 20000).unref()
  })
  const close = () => new Promise((settle) => {
    child.on('close', settle)
    child.stdin.end()
    setTimeout(() => {
      child.kill('SIGKILL')
      settle()
    }, 5000).unref()
  })
  return { request, notify: (method, params) => send({ jsonrpc: '2.0', method, params }), respond: answer, close, logs }
}

test('the MCP surface is the plugin\'s six tools, with schemas derived from TOOL_PARAMETERS', () => {
  const tools = listTools()
  assert.deepEqual(tools.map((tool) => tool.name), [...TOOL_NAMES])
  for (const tool of tools) {
    assert.equal(tool.inputSchema.type, 'object')
    assert.equal(tool.inputSchema.additionalProperties, false)
    assert.ok(tool.description.length > 40, `${tool.name} needs a real description`)
    // Every declared argument is present, and nothing else is.
    assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), Object.keys(TOOL_PARAMETERS[tool.name]).sort())
  }
  // The required list is the author-facing `required: true` set, nothing more.
  for (const tool of tools) {
    const required = Object.entries(TOOL_PARAMETERS[tool.name]).filter(([, spec]) => spec.required === true).map(([key]) => key)
    assert.deepEqual(tool.inputSchema.required, required, `${tool.name} required list`)
  }
})

test('jsonSchemaFor mirrors the author-facing DSL', () => {
  const schema = jsonSchemaFor({
    text: { type: 'string', required: true, description: 'one line' },
    mode: { type: 'string', enum: ['a', 'b'], default: 'a' },
    tags: { type: 'array', items: { type: 'string' } },
    flag: { type: 'boolean', default: false },
  })
  assert.deepEqual(schema.required, ['text'])
  assert.deepEqual(schema.properties.mode, { type: 'string', enum: ['a', 'b'], default: 'a' })
  assert.deepEqual(schema.properties.tags, { type: 'array', items: { type: 'string' } })
  assert.deepEqual(schema.properties.flag, { type: 'boolean', default: false })
  // Absent input is an empty, closed object rather than `undefined`.
  assert.deepEqual(jsonSchemaFor(undefined), { type: 'object', properties: {}, required: [], additionalProperties: false })
})

test('a handshake, a write and a search round-trip against a throwaway vault', { timeout: 60000 }, async (t) => {
  const { home, dsh, vault, repo } = world()
  const client = await connect({ ...process.env, HOME: home, DSH_HOME: dsh, OBSIDIAN_MEM_VAULT: vault, OBSIDIAN_MEM_CWD: repo })
  t.after(async () => { await client.close() })

  const init = await client.request('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'test', version: '0' } })
  assert.equal(init.result.protocolVersion, '2025-06-18')
  assert.deepEqual(init.result.capabilities, { tools: {} })
  assert.equal(init.result.serverInfo.name, 'dsh-obsidian-mem')
  client.notify('notifications/initialized')

  const tools = await client.request('tools/list', {})
  assert.deepEqual(tools.result.tools.map((tool) => tool.name), [...TOOL_NAMES])

  const written = await client.request('tools/call', {
    name: 'mem_write',
    arguments: { type: 'convention', title: 'Codex 侧也能写入', body: '通过 MCP 适配层写入的一条约定。' },
  })
  const receipt = JSON.parse(written.result.content[0].text)
  assert.equal(written.result.isError, undefined)
  assert.match(receipt.path, /^Projects\/demo-repo--[0-9a-f]{8}\/Conventions\//)

  const found = await client.request('tools/call', { name: 'mem_search', arguments: { query: '适配层', limit: 5 } })
  const hits = JSON.parse(found.result.content[0].text)
  assert.equal(hits.length, 1)
  assert.equal(hits[0].path, receipt.path)

  // The vault tree the DSH plugin expects, written by the Codex side: the same
  // ASCII protocol directories, plus the plugin's own root .gitignore.
  assert.deepEqual(readdirSync(vault).sort(), ['.gitignore', 'Methods', 'Projects', '_meta'])
  assert.match(readFileSync(join(repo, '.obsidian-mem'), 'utf8'), /"slug": "demo-repo"/)
})

test('the client\'s roots decide the project, not the server\'s own cwd', { timeout: 60000 }, async (t) => {
  const { home, dsh, vault, repo } = world()
  // No OBSIDIAN_MEM_CWD: only `roots/list` can name the project directory.
  const env = { ...process.env, HOME: home, DSH_HOME: dsh, OBSIDIAN_MEM_VAULT: vault }
  delete env.OBSIDIAN_MEM_CWD
  const client = await connect(env)
  t.after(async () => { await client.close() })

  const init = await client.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: { roots: { listChanged: false } },
    clientInfo: { name: 'test', version: '0' },
  })
  assert.equal(init.result.protocolVersion, '2025-06-18')
  client.respond(1, { roots: [{ uri: `file://${repo}`, name: 'demo-repo' }] })
  client.notify('notifications/initialized')

  const written = await client.request('tools/call', {
    name: 'mem_write',
    arguments: { type: 'decision', title: '工作目录来自 roots', body: '客户端给的 roots 决定绑定哪个项目。' },
  })
  const receipt = JSON.parse(written.result.content[0].text)
  assert.match(receipt.path, /^Projects\/demo-repo--[0-9a-f]{8}\/Decisions\//)
  // The server was launched with the plugin directory as cwd. If it had trusted
  // that, a project for this checkout would exist in the vault; roots won instead,
  // and the throwaway repository is the only project bound.
  assert.deepEqual(readdirSync(join(vault, 'Projects')).map((name) => name.replace(/--.*$/, '')), ['demo-repo'])
  assert.equal(existsSync(join(vault, 'Projects', readdirSync(join(vault, 'Projects'))[0], 'Decisions')), true)
})

test('an unknown tool is an error result, and the server keeps answering', { timeout: 60000 }, async (t) => {
  const { home, dsh, vault, repo } = world()
  const client = await connect({ ...process.env, HOME: home, DSH_HOME: dsh, OBSIDIAN_MEM_VAULT: vault, OBSIDIAN_MEM_CWD: repo })
  t.after(async () => { await client.close() })
  await client.request('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'test', version: '0' } })

  const bad = await client.request('tools/call', { name: 'mem_nope', arguments: {} })
  assert.equal(bad.result.isError, true)
  assert.match(bad.result.content[0].text, /exposes mem_search/)

  const unknown = await client.request('resources/list', {})
  assert.equal(unknown.error.code, -32601)

  const ping = await client.request('ping', {})
  assert.deepEqual(ping.result, {})

  const still = await client.request('tools/call', { name: 'mem_brief', arguments: {} })
  assert.equal(still.result.isError, undefined)
  assert.match(still.result.content[0].text, /obsidian-mem:brief|未绑定|no project/i)
})

test('the marketplace plugin is complete, and its generated .mcp.json matches the generator', () => {
  // A plugin missing its skill or its MCP declaration installs into Codex and does
  // nothing, which is worse than not installing: `prepare.mjs` refuses to run and
  // this case refuses to pass.
  assert.deepEqual(problems(), [], 'the plugin must be installable end to end')
  const plugin = join(REPO, 'codex', 'marketplace', 'plugins', 'dsh-obsidian-mem')
  assert.equal(existsSync(join(plugin, 'skills', 'obsidian-mem', 'SKILL.md')), true, 'the plugin must ship the skill')
  const marketplace = JSON.parse(readFileSync(join(REPO, 'codex', 'marketplace', '.agents', 'plugins', 'marketplace.json'), 'utf8'))
  assert.equal(marketplace.name, 'dsh-obsidian-mem-local')
  assert.deepEqual(marketplace.plugins.map((entry) => entry.name), ['dsh-obsidian-mem'])
  assert.equal(marketplace.plugins[0].source.path, './plugins/dsh-obsidian-mem')

  const generated = join(plugin, '.mcp.json')
  if (existsSync(generated)) {
    assert.deepEqual(JSON.parse(readFileSync(generated, 'utf8')), mcpConfig(), 'run: node codex/prepare.mjs')
  } else {
    // Not generated yet on a fresh clone: the file is machine-specific and ignored
    // by git, so its absence is a step to run, not a failure.
    assert.match(mcpConfig().mcpServers['obsidian-mem'].args[0], /codex\/server\.mjs$/)
  }
})
