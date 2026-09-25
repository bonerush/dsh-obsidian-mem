// Task 11, step 1: the façade is a contract, so it gets a test that fails when
// it is trimmed.
//
// `lib/tools.js` is the public entry point — `lib/index.js` (the DSH plugin) and
// `codex/server.mjs` (the MCP adapter) both import from it, and so does every test
// file that touches the surface. That makes it the one place a refactor can break
// something invisible from inside `lib/`: delete an export and the plugin still
// loads, the files that never needed that name still pass, and the failure lands
// in an entry point nobody ran.
//
// The split into `tool-schema.js`, `tool-registry.js` and `services.js` is only
// safe because this file exists. Two directions are asserted, on purpose:
//
//   * the four published names are all present, with the shape the callers use;
//   * nothing else is exported, because a name that leaks out of the façade is a
//     name the next refactor has to keep working whether or not anyone meant it.
//
// The fourth case is the one that would have caught a copy-paste split: the
// façade must re-export the *same* values the owning modules hold, not structurally
// equal rebuilds of them. `assert.equal` on a frozen object is reference identity,
// so a duplicated `TOOL_PARAMETERS` fails here even though both copies compile.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import toolsPlugin from '@deepseek-ai/dsh-tools'

import { jsonSchemaFor, listTools } from '../codex/server.mjs'
import { createMemoryServices, registerTools, TOOL_NAMES, TOOL_PARAMETERS } from '../lib/tools.js'
import {
  TOOL_NAMES as SCHEMA_NAMES,
  TOOL_PARAMETERS as SCHEMA_PARAMETERS,
} from '../lib/tool-schema.js'
import { registerTools as REGISTRY_REGISTER } from '../lib/tool-registry.js'
import { createMemoryServices as SERVICES_CREATE } from '../lib/services.js'

/** The four names the façade publishes, and what each one has to be. */
const PUBLISHED = Object.freeze({
  TOOL_NAMES: 'object',
  TOOL_PARAMETERS: 'object',
  registerTools: 'function',
  createMemoryServices: 'function',
})

/** The six names, sorted for set comparison. */
const SIX = Object.freeze([
  'mem_admin',
  'mem_brief',
  'mem_log',
  'mem_read',
  'mem_search',
  'mem_write',
])

/** A real Cordis context with the shipped ToolRuntime mounted. */
async function toolbed(t) {
  const ctx = new Context()
  ctx.provide('systemPrompt', { tools: () => () => {} })
  const fork = ctx.plugin(toolsPlugin)
  await fork
  t.after(async () => {
    await fork.dispose().catch(() => {})
  })
  return ctx
}

/** The smallest service seam `registerTools` accepts, none of which is called. */
function stubServices() {
  const services = { close: async () => {} }
  for (const key of ['search', 'read', 'write', 'log', 'brief', 'admin']) {
    services[key] = async () => {
      throw new Error('the façade contract test does not execute tools')
    }
  }
  return services
}

test('the façade exports exactly the four published names, with the right shape', async () => {
  const module = await import('../lib/tools.js')
  assert.deepEqual(
    Object.keys(module).sort(),
    Object.keys(PUBLISHED).sort(),
    'an export added to or removed from lib/tools.js is a change to the public entry point',
  )
  for (const [name, kind] of Object.entries(PUBLISHED)) {
    assert.equal(typeof module[name], kind, `${name} is a ${kind}`)
  }
})

test('every façade name is the same value the owning module holds', () => {
  assert.equal(TOOL_NAMES, SCHEMA_NAMES, 'TOOL_NAMES must be re-exported, not rebuilt')
  assert.equal(
    TOOL_PARAMETERS,
    SCHEMA_PARAMETERS,
    'TOOL_PARAMETERS must be re-exported, not rebuilt',
  )
  assert.equal(registerTools, REGISTRY_REGISTER)
  assert.equal(createMemoryServices, SERVICES_CREATE)
})

test('registerTools through the façade mounts the six tools TOOL_NAMES lists', async (t) => {
  const ctx = await toolbed(t)
  const disposers = registerTools(ctx, stubServices())
  const names = ctx.tools
    .schemas()
    .map((schema) => schema.name)
    .sort()
  assert.deepEqual(names, SIX)
  assert.deepEqual([...TOOL_NAMES].sort(), SIX)
  assert.equal(disposers.length, 6)
})

test('the Codex listing and the runtime schemas describe the same six tools', async (t) => {
  const ctx = await toolbed(t)
  registerTools(ctx, stubServices())
  const runtime = new Map(ctx.tools.schemas().map((schema) => [schema.name, schema]))
  const listed = listTools()
  assert.deepEqual(
    listed.map((tool) => tool.name).sort(),
    [...runtime.keys()].sort(),
    'the MCP adapter and the DSH plugin must expose the same six names',
  )
  for (const tool of listed) {
    const compiled = runtime.get(tool.name).parameters
    // The two surfaces are the same document apart from three root-level
    // conventions. They are asserted here rather than smoothed over, because
    // each one is a decision somebody made on purpose:
    //
    //   * the MCP adapter CLOSES the argument root (`additionalProperties:
    //     false`) and DSH leaves it OPEN. That is precisely why
    //     `assertKnownArguments` exists — DSH hands an undeclared key to
    //     `execute`, while this adapter refuses it at the schema.
    //   * the adapter always writes `required`, DSH omits it when it is empty
    //     (`mem_brief` takes no arguments at all).
    //
    // Neither difference reaches a parameter, and that is what the comparisons
    // below say: same names, same declared order, same specs, same required set.
    // Comparing the two documents whole would fail on a deliberate design
    // choice; skipping the comparison is how a parameter renamed on one side
    // stops being noticed.
    assert.deepEqual(
      Object.keys(tool.inputSchema.properties),
      Object.keys(compiled.properties),
      `${tool.name}: both sides declare the parameters in TOOL_PARAMETERS order`,
    )
    assert.deepEqual(
      tool.inputSchema.properties,
      compiled.properties,
      `${tool.name}: the same parameter specs on both surfaces`,
    )
    assert.deepEqual(
      tool.inputSchema.required,
      compiled.required ?? [],
      `${tool.name}: the same required set on both surfaces`,
    )
    assert.equal(tool.inputSchema.type, compiled.type)
    assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name}: MCP closes the root`)
    assert.equal(compiled.additionalProperties, undefined, `${tool.name}: DSH leaves it open`)
    assert.deepEqual(
      tool.inputSchema,
      jsonSchemaFor(TOOL_PARAMETERS[tool.name]),
      `${tool.name}: the listing is derived from TOOL_PARAMETERS, not hand-written`,
    )
  }
})
