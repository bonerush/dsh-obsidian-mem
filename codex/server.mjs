#!/usr/bin/env node
// @ts-check
// Codex (MCP) adapter for the memory layer this repository ships as a DSH plugin.
//
// Why this file exists: DSH and Codex have incompatible extension models. The
// plugin itself is a Cordis host plugin — `ctx.tools.register`, `agent/session-start`,
// `ctx.llm` — and none of that exists in Codex. What *is* portable is everything
// under `lib/`: `createMemoryServices()` and the modules behind it are plain
// functions that take a validated config, a data root and a working directory.
// So the adapter is deliberately thin — it speaks MCP on stdio and dispatches to
// the same six operations the DSH tools call. There is exactly one copy of the
// memory layer, and this file is not a second implementation of it.
//
// What does NOT carry over, and is not pretended here:
//   * automatic distillation — DSH hooks `agent/turn-stopping` and calls the
//     model; MCP offers tools, not turn boundaries. In Codex a note is written
//     when the agent decides to write one.
//   * recall injection at session start — DSH injects the brief in a pre-step;
//     here the agent has to call `mem_brief` itself (the shipped skill says so).
//   * the six tool *descriptions* below are Codex-side prose. The parameter
//     schemas are derived from `TOOL_PARAMETERS`, so they cannot drift, and a
//     test asserts the six names match `TOOL_NAMES` exactly.
//
// The data root is `resolveDataRoot()` — the same `$DSH_HOME/data/obsidian-mem`
// the plugin uses, so locks, receipts and the search index stay one set. Two
// harnesses writing the same vault serialize through the same vault lock; the
// README lists cross-process contention as the least-tested part of that story.
//
// stdout is the protocol channel. Nothing here may print to it: diagnostics go to
// stderr, and `console.log` is never used.
import { homedir } from 'node:os'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

import { validateConfig } from '../lib/config.js'
import { createDiagnostics } from '../lib/debug.js'
import { resolveDataRoot } from '../lib/paths.js'
import { TOOL_NAMES, TOOL_PARAMETERS, createMemoryServices } from '../lib/tools.js'

/** The MCP revision this server implements; `initialize` echoes the client's when it sends one. */
export const PROTOCOL_VERSION = '2025-06-18'
/** Identifies the server to the client. */
export const SERVER_INFO = Object.freeze({ name: 'dsh-obsidian-mem', version: '0.1.0' })

/**
 * Codex-side descriptions. Short on purpose: the long-form rules live in the
 * skill, which is loaded as instructions rather than skimmed as a tool list.
 */
const DESCRIPTION = Object.freeze({
  mem_search:
    'Search project memory and return ranked notes with their vault-relative paths. Defaults to the project bound to the current working directory; scope "global" covers Methods/ and _meta/user.md, "all" crosses projects.',
  mem_read: 'Read one note by its vault-relative path, optionally a single ATX section of it.',
  mem_write:
    'Create or update one memory note and index it. Omitting "id" always creates a new note; pass an existing "id" to update it. Nothing is ever deleted — to correct a fact, write the new note with "supersedes".',
  mem_log:
    'Append one entry to the project day log under Daily/. With section "hot" it edits the controlled hot zone instead.',
  mem_brief:
    'The recall brief for the project bound to the current working directory: binding, hot memory, conventions and recent decisions. Call this once when you start work in a repository.',
  mem_admin:
    "Vault maintenance: lint, index status/rebuild, bind (show/local/fork/retain), the project list, promote a note into Methods/, the pending job queue, and diagnostics (a bounded, content-free ring of this process's decisions; it empties on restart).",
})

/**
 * Turn the plugin's shorthand parameter table into JSON Schema.
 *
 * The table is the single source of truth for what a tool accepts, so the MCP
 * surface cannot describe a parameter the implementation does not read.
 *
 * @param {object} params - one entry of `TOOL_PARAMETERS`.
 * @returns {object} a JSON Schema object for that tool's arguments.
 */
export function jsonSchemaFor(params) {
  const properties = {}
  const required = []
  for (const [key, spec] of Object.entries(params ?? {})) {
    const property = { type: spec.type }
    if (spec.items !== undefined) property.items = spec.items
    if (spec.enum !== undefined) property.enum = spec.enum
    if (spec.default !== undefined) property.default = spec.default
    if (spec.description !== undefined) property.description = spec.description
    properties[key] = property
    if (spec.required === true) required.push(key)
  }
  return { type: 'object', properties, required, additionalProperties: false }
}

/**
 * The MCP tool list, in the plugin's own order.
 *
 * @returns {{name: string, description: string, inputSchema: object}[]} six tools.
 */
export function listTools() {
  return TOOL_NAMES.map((name) => ({
    name,
    description: DESCRIPTION[name],
    inputSchema: jsonSchemaFor(TOOL_PARAMETERS[name]),
  }))
}

/**
 * Open the memory layer for one working directory.
 *
 * Every input has the same default the DSH plugin would use, so the two
 * harnesses agree about the vault and the data root without any configuration:
 * `OBSIDIAN_MEM_VAULT` (then `OBSIDIAN_MEM_CWD`, `DSH_HOME`) exist so a test —
 * or a second checkout — can point somewhere else without touching the real one.
 *
 * @param {{ cwd?: string, dshHome?: string, vaultPath?: string, home?: string }} [options] - overrides; every one of them defaults to what the DSH plugin would use.
 * @returns {{ services: object, config: object, dataRoot: string, cwd: string, diagnostics: object }} the opened layer, with the ring its own `mem_admin` reads.
 */
export function openMemory(options = {}) {
  const home = options.home ?? homedir()
  const cwd = options.cwd ?? process.env.OBSIDIAN_MEM_CWD ?? process.cwd()
  const vaultPath = options.vaultPath ?? process.env.OBSIDIAN_MEM_VAULT
  const config = validateConfig(vaultPath === undefined ? {} : { vaultPath })
  const dataRoot = resolveDataRoot(options.dshHome ?? process.env.DSH_HOME ?? undefined)
  // One ring per server, with its own sink: this process has no Cordis logger, so
  // emission goes to stderr and only when the env flag is set. The DSH side keeps
  // its own instance, which is why the tool's answer is always about the process
  // the caller is actually talking to.
  const diagnostics = createDiagnostics({
    logger: { info: (line) => process.stderr.write(line + '\n') },
  })
  return {
    services: createMemoryServices({ config, dataRoot, cwd, home, diagnostics }),
    config,
    dataRoot,
    cwd,
    diagnostics,
  }
}

/**
 * Run one tool against an open memory layer.
 *
 * @param {{ services: object }} memory - the result of {@link openMemory}.
 * @param {string} name - one of `TOOL_NAMES`.
 * @param {object} args - tool arguments.
 * @returns {Promise<unknown>} the operation's result, as JSON-serialisable data.
 * @throws {RangeError} when the tool name is unknown.
 */
export async function callMemoryTool(memory, name, args = {}) {
  const service = {
    mem_search: 'search',
    mem_read: 'read',
    mem_write: 'write',
    mem_log: 'log',
    mem_brief: 'brief',
    mem_admin: 'admin',
  }[name]
  if (service === undefined)
    throw new RangeError(
      `unknown tool ${JSON.stringify(name)}; this server exposes ${TOOL_NAMES.join(', ')}`,
    )
  return memory.services[service](args)
}

/** ISO-8601 with milliseconds, for stderr diagnostics only. */
const stamp = () => new Date().toISOString()
const warn = (message) => process.stderr.write(`${stamp()} obsidian-mem(mcp): ${message}\n`)

/**
 * Serve the MCP stdio protocol on one connection.
 *
 * Messages are newline-delimited JSON-RPC 2.0. The dispatcher answers
 * `initialize`, `tools/list`, `tools/call` and `ping`, ignores every
 * notification, and replies `-32601` to anything else rather than dying — a
 * client that asks an unknown question should get an error, not a dead server.
 *
 * The working directory comes from the client's `roots` when it advertises them
 * (MCP's own way to say "the project is here"), because the server is launched
 * with the *plugin's* directory as its cwd. Without roots it falls back to the
 * process cwd, and `OBSIDIAN_MEM_CWD` overrides both — when that variable is set
 * the exchange is skipped entirely, so a configured checkout never waits.
 *
 * Handlers are serialised so two tool calls cannot interleave inside one vault
 * lock. That serialisation is exactly why `initialize` must NOT await the roots
 * answer: the answer is itself a message, it would be queued behind the handler
 * waiting for it, and the server would deadlock until its own timeout fired. The
 * request goes out, the handler returns, and the first tool call awaits the
 * promise instead.
 *
 * @param {{ input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream, open?: Function }} [io] - injected for tests.
 * @returns {Promise<{ close: Function }>} resolves once the input ends.
 */
export async function serve(io = {}) {
  const input = io.input ?? process.stdin
  const output = io.output ?? process.stdout
  const open = io.open ?? openMemory
  const send = (message) => output.write(`${JSON.stringify(message)}\n`)

  /**
   * The opened layer, or `null` until the first tool call opens it. The declared
   * type is load-bearing, not decoration: the only assignment lives inside
   * `openOnce`, so without it TypeScript's control-flow analysis types this
   * binding as `null` at the `close` call below and rejects the optional chain
   * (`TS18047`). Measured both ways on the pinned compiler.
   *
   * @type {{ services: object, config: object, dataRoot: string, cwd: string }|null}
   */
  let memory = null
  let workspace = process.env.OBSIDIAN_MEM_CWD ?? null
  let roots = null
  let nextId = 1
  const pendingRoots = new Map()

  const openOnce = async () => {
    if (memory === null) {
      if (roots !== null) {
        const root = await roots
        roots = null
        if (root !== null && workspace === null) workspace = root
      }
      memory = open({ cwd: workspace ?? process.cwd() })
      warn(`opened vault ${memory.config.vaultPath} data root ${memory.dataRoot} cwd ${memory.cwd}`)
    }
    return memory
  }

  const askRoots = () =>
    new Promise((resolve) => {
      const id = nextId
      nextId += 1
      pendingRoots.set(id, resolve)
      send({ jsonrpc: '2.0', id, method: 'roots/list' })
      // A client that goes quiet must not hang the first tool call.
      setTimeout(() => {
        if (pendingRoots.delete(id)) resolve(null)
      }, 2000).unref()
    })

  const handleToolCall = async (id, params) => {
    const name = params?.name
    try {
      const opened = await openOnce()
      const result = await callMemoryTool(opened, name, params?.arguments ?? {})
      send({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] },
      })
    } catch (error) {
      warn(`${name} failed: ${error?.code ?? ''} ${error?.message ?? error}`)
      send({
        jsonrpc: '2.0',
        id,
        result: {
          content: [
            {
              type: 'text',
              text: `${error?.code === undefined ? '' : `${error.code}: `}${error?.message ?? String(error)}`,
            },
          ],
          isError: true,
        },
      })
    }
  }

  const handle = async (message) => {
    const { id, method, params } = message
    // A response to our own roots/list request. It is answered here rather than
    // inside the request's own handler: see the deadlock note above.
    if (method === undefined) {
      const settle = pendingRoots.get(id)
      if (settle === undefined) return
      pendingRoots.delete(id)
      const first = Array.isArray(message.result?.roots) ? message.result.roots[0]?.uri : undefined
      try {
        settle(
          typeof first === 'string' && first.startsWith('file://') ? fileURLToPath(first) : null,
        )
      } catch {
        settle(null)
      }
      return
    }
    if (id === undefined) return // a notification: nothing to answer, ever
    switch (method) {
      case 'initialize': {
        const asked = params?.protocolVersion
        const supportsRoots = params?.capabilities?.roots !== undefined
        send({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: typeof asked === 'string' ? asked : PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: SERVER_INFO,
          },
        })
        // Started, never awaited: the answer is a message that this serialised
        // queue can only deliver once this handler has returned.
        if (supportsRoots && workspace === null) roots = askRoots()
        return
      }
      case 'ping':
        send({ jsonrpc: '2.0', id, result: {} })
        return
      case 'tools/list':
        send({ jsonrpc: '2.0', id, result: { tools: listTools() } })
        return
      case 'tools/call':
        await handleToolCall(id, params)
        return
      default:
        send({
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `method not found: ${method}` },
        })
    }
  }

  const lines = createInterface({ input, crlfDelay: Infinity })
  const queue = []
  let working = Promise.resolve()
  lines.on('line', (line) => {
    const text = line.trim()
    if (text === '') return
    let message
    try {
      message = JSON.parse(text)
    } catch {
      warn(`ignoring a line that is not JSON: ${text.slice(0, 120)}`)
      return
    }
    queue.push(message)
    // Serialise handling: two tool calls must not interleave inside one vault lock.
    working = working.then(async () => {
      const next = queue.shift()
      if (next !== undefined) await handle(next)
    })
  })

  await new Promise((resolve) => lines.on('close', resolve))
  await working
  await memory?.services?.close?.()
  return { close: () => lines.close() }
}

const isEntry = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`
if (isEntry) {
  serve().catch((error) => {
    warn(`fatal: ${error?.stack ?? error}`)
    process.exitCode = 1
  })
}
