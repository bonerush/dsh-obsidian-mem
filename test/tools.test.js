// Task 10: the six-tool contract, exercised against the real tool runtime.
//
// Every case below mounts the SHIPPED `@deepseek-ai/dsh-tools` plugin — the same
// `ToolRuntime` a DSH process loads — and registers the six tools through the
// module's public `registerTools(ctx, services)` seam. Nothing here installs the
// plugin into a DSH profile, reads the user's real vault, or writes under the
// real `~/.dsh`: the services are stubs, and the vault-level behaviour is
// covered by `test/integration-write-read.test.js` against a throwaway vault.
//
// Two facts this file exists to pin down:
//
//   * `defineTool`'s shorthand parameter DSL compiles an **open** object root
//     (no `additionalProperties`), so the runtime does NOT reject an extra
//     argument key. Each `execute` therefore rejects its own unknown keys, and
//     the last case here proves that rejection happens before the service runs.
//   * `defineTool` compiles the author's `required: true` annotations into a
//     JSON Schema `required` array, so `TOOL_PARAMETERS` (the author-facing DSL)
//     is asserted per property AND the compiled schema is asserted per tool.
//
// `@deepseek-ai/dsh-tools` is an OPTIONAL PEER dependency: DSH supplies it to an
// installed plugin through `~/.dsh/profiles/node_modules/@deepseek-ai/*`
// symlinks that point into the DSH install. This repository's own
// `node_modules` mirrors that symlink so the suite can mount the real runtime;
// a checkout whose `node_modules` was rebuilt without it cannot run this file,
// exactly as a DSH process without the package could not register the tools.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import toolsPlugin, { defineTool } from '@deepseek-ai/dsh-tools'

import { validateConfig } from '../lib/config.js'
import {
  ackChangedSources,
  enqueueChangedSource,
  readChangedSources,
} from '../lib/curation-state.js'
import { createDiagnostics } from '../lib/debug.js'
import {
  createAliases,
  decodeDiagnosticEvent,
  encodeDiagnosticEvent,
} from '../lib/diagnostic-codec.js'
import { createMemoryServices, TOOL_NAMES, TOOL_PARAMETERS, registerTools } from '../lib/tools.js'
import { resolveBinding } from '../lib/vault.js'
import { makeCurationWorld } from './curation-world.js'

/** The six names, sorted for set comparison. */
const SIX = Object.freeze([
  'mem_admin',
  'mem_brief',
  'mem_log',
  'mem_read',
  'mem_search',
  'mem_write',
])

/** The one required parameter of each tool (spec §9). */
const REQUIRED = Object.freeze({
  mem_search: ['query'],
  mem_read: ['path'],
  mem_write: ['type', 'title', 'body'],
  mem_log: ['text'],
  mem_brief: [],
  mem_admin: ['action'],
})

const SAMPLE_ID = 'doc-11111111-1111-4111-8111-111111111111'
const SAMPLE_PATH = 'Projects/demo--1c392abb/Docs/样例.md'

/** A receipt-shaped value the `write`/`log` stubs can return without a vault. */
function sampleReceipt(action) {
  return {
    schema: 1,
    txId: `tx-${action}`,
    idempotencyKey: null,
    sessionId: null,
    fromSeq: null,
    toSeq: null,
    action,
    paths: [SAMPLE_PATH],
    beforeHashes: { [SAMPLE_PATH]: null },
    afterHashes: { [SAMPLE_PATH]: 'a'.repeat(64) },
    result: { status: 'applied', index: 'queued' },
    at: '2026-09-23T00:00:00.000Z',
  }
}

const SAMPLE_NOTE = Object.freeze({
  path: SAMPLE_PATH,
  hash: 'b'.repeat(64),
  size: 12,
  body: '正文',
  frontmatter: { id: SAMPLE_ID },
  tags: [],
  parseError: null,
  id: SAMPLE_ID,
})

/** The `mem_admin` values every action returns now that all six are real. */
const adminResult = (action, args = {}) => {
  if (action === 'curation') {
    return {
      action,
      result: {
        status: args.operation === 'scan' ? 'scanned' : 'listed',
        operation: args.operation ?? 'status',
        projectId: '1c392abb-7b08-42f7-871d-2a379caf9448',
        complete: false,
        cursor: null,
        scannedAt: null,
        examined: 0,
        counts: { entries: 0, exactGroups: 0, findings: 0, unexamined: 0 },
        proposals: { total: 0, pending: 0, truncated: false, unreadable: [] },
        truncated: null,
        autoEnabled: true,
      },
    }
  }
  if (action === 'lint') {
    return {
      action,
      result: {
        projectId: '1c392abb-7b08-42f7-871d-2a379caf9448',
        relativeDir: 'Projects/demo--1c392abb',
        generatedAt: '2026-09-24T00:00:00.000Z',
        readOnly: true,
        total: 0,
        counts: {},
        findings: [],
        index: {
          backend: 'sqlite',
          ready: true,
          notes: 1,
          rows: 1,
          files: 1,
          compared: true,
          reason: null,
        },
        history: {
          policy: { keepCount: 200 },
          directories: 0,
          bytes: 0,
          prunable: 0,
          pruned: [],
          needsRepair: [],
          oversized: false,
        },
        pending: { jobs: 0, failed: 0, invalid: 0, known: true },
        repository: { scanned: 0, candidates: 0, truncated: false, known: true },
        report: { status: 'none', path: null, message: null },
        safetyExclusions: ['_meta/log.md'],
        ignoreGlobs: [],
        truncated: { vault: false, repo: false },
      },
    }
  }
  return {
    action,
    result:
      action === 'promote'
        ? {
            source: SAMPLE_PATH,
            moved: false,
            id: SAMPLE_ID,
            path: 'Methods/样例.md',
            receipt: sampleReceipt('write'),
          }
        : { status: 'listed', jobs: [], failed: 0, message: null },
  }
}

/**
 * A services stub that records every call and returns schema-valid values.
 *
 * `overrides` replace one service body without losing the recording, which is
 * what lets a contract case assert *what the tool passed down* rather than what
 * a vault did with it.
 *
 * @param {object} [overrides] - per-service replacement bodies.
 * @returns {object} the six-service object plus the recorded `calls`.
 */
function stubServices(overrides = {}) {
  const calls = []
  const defaults = {
    search: () => [],
    read: () => SAMPLE_NOTE,
    write: () => ({ id: SAMPLE_ID, path: SAMPLE_PATH, receipt: sampleReceipt('write') }),
    log: () => sampleReceipt('log'),
    brief: () => ({ status: 'unbound', message: 'this working directory is not a bound project' }),
    admin: (args) => adminResult(args.action, args),
  }
  const services = { calls }
  for (const key of Object.keys(defaults)) {
    services[key] = async (args, signal, exec) => {
      calls.push({ key, args, signal, exec })
      return (overrides[key] ?? defaults[key])(args, signal, exec)
    }
  }
  return services
}

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

let callSeq = 0

/** Execute one tool through the real runtime, with a real `AbortSignal`. */
function call(ctx, name, args, extra = {}) {
  return ctx.tools.execute({
    callId: `call-${(callSeq += 1)}`,
    name,
    arguments: args,
    signal: extra.signal ?? new AbortController().signal,
    ...('agent' in extra ? { agent: extra.agent } : {}),
  })
}

/** A throwaway world with one bound project and private curation state. */
async function curationServices(
  t,
  { config = {}, notes = 1, bind = true, curationBounds = null } = {},
) {
  const world = await makeCurationWorld(t, { config })
  const diagnostics = createDiagnostics({})
  const services = createMemoryServices({
    config: world.config,
    dataRoot: world.dataRoot,
    cwd: world.repo,
    home: world.home,
    diagnostics,
    curationBounds,
  })
  t.after(() => services.close())
  // The first write is what binds the repository and bootstraps the vault, exactly
  // as a real session's first `mem_write` does. `bind: false` is the pointerless
  // world a session that has only ever read sees.
  const written = []
  for (let index = 0; bind && index < notes; index += 1) {
    written.push(
      await services.write({
        type: 'convention',
        title: `记忆条 ${index + 1}`,
        body: `第 ${index + 1} 条约定的正文。`,
      }),
    )
  }
  const binding = await resolveBinding({
    cwd: world.repo,
    vaultRoot: world.config.vaultPath,
    mode: 'show',
    home: world.home,
  })
  // Private curation state only: the index the first write built lives under
  // `index/`, and the journal under `diagnostics/`.
  const countPrivateFiles = async () => {
    const found = []
    const walk = async (directory) => {
      let entries
      try {
        entries = await readdir(directory, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (entry.isDirectory()) await walk(join(directory, entry.name))
        else found.push(join(directory, entry.name))
      }
    }
    await walk(join(world.dataRoot, 'curation'))
    return found.length
  }
  return {
    ...world,
    services,
    diagnostics,
    binding,
    written,
    countPrivateFiles,
    readEnqueued: () => readChangedSources({ binding, dataRoot: world.dataRoot }),
    enqueue: (path) => {
      const target = path ?? written[0]?.path
      if (target === undefined) throw new Error('this world has no written note to enqueue')
      return enqueueChangedSource({ binding, dataRoot: world.dataRoot, path: target })
    },
    ack: (paths) => ackChangedSources({ binding, dataRoot: world.dataRoot, paths }),
  }
}

/** Every object node reachable through `properties`, `items` and `oneOf`. */
function objectNodes(node, path, out) {
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    node.forEach((child, index) => objectNodes(child, `${path}[${index}]`, out))
    return
  }
  if (node.type === 'object') out.push({ path, node })
  if (node.properties !== undefined) {
    for (const [key, value] of Object.entries(node.properties))
      objectNodes(value, `${path}.${key}`, out)
  }
  if (node.items !== undefined) objectNodes(node.items, `${path}[]`, out)
  if (node.oneOf !== undefined)
    node.oneOf.forEach((arm, index) => objectNodes(arm, `${path}|${index}`, out))
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

test('the registered name set is exactly the six documented tools', async (t) => {
  const ctx = await toolbed(t)
  registerTools(ctx, stubServices())
  const names = ctx.tools
    .schemas()
    .map((schema) => schema.name)
    .sort()
  assert.deepEqual(names, SIX)
  assert.deepEqual([...TOOL_NAMES].sort(), SIX)
  for (const name of names) assert.match(name, /^mem_[a-z]+$/)
})

test('the definition set stays six — there is no seventh tool', async (t) => {
  const ctx = await toolbed(t)
  const disposers = registerTools(ctx, stubServices())
  assert.equal(disposers.length, 6)
  assert.equal(ctx.tools.schemas().length, 6)
})

test('every required parameter is a per-property required:true in the DSL', () => {
  for (const name of SIX) {
    const spec = TOOL_PARAMETERS[name]
    assert.equal(typeof spec, 'object', `${name} has a parameter spec`)
    const required = Object.entries(spec)
      .filter(([, node]) => node.required === true)
      .map(([key]) => key)
      .sort()
    assert.deepEqual(required, REQUIRED[name].slice().sort(), `${name} required set`)
    // No property may carry the JSON-Schema array form; the DSL wants `true`.
    for (const [key, node] of Object.entries(spec)) {
      if (Object.hasOwn(node, 'required'))
        assert.equal(node.required, true, `${name}.${key}.required must be true`)
    }
  }
})

test('the runtime compiles those annotations into the JSON Schema required array', async (t) => {
  const ctx = await toolbed(t)
  registerTools(ctx, stubServices())
  for (const name of SIX) {
    const compiled = ctx.tools.get(name).parameters
    assert.equal(compiled.type, 'object')
    assert.deepEqual(
      (compiled.required ?? []).slice().sort(),
      REQUIRED[name].slice().sort(),
      `${name} compiled required`,
    )
    for (const key of REQUIRED[name]) assert.equal(Object.hasOwn(compiled.properties, key), true)
  }
})

test('the compiled parameter root is OPEN, so extra keys are refused by execute and not by the schema', async (t) => {
  const ctx = await toolbed(t)
  registerTools(ctx, stubServices())
  for (const name of SIX) {
    const compiled = ctx.tools.get(name).parameters
    assert.equal(compiled.type, 'object', `${name} root is an object`)
    assert.equal(
      Object.hasOwn(compiled, 'additionalProperties'),
      false,
      `${name} root must stay open`,
    )
  }
})

test('every object node of every output schema declares additionalProperties', async (t) => {
  const ctx = await toolbed(t)
  registerTools(ctx, stubServices())
  for (const name of SIX) {
    const schema = ctx.tools.get(name).output.schema
    const nodes = []
    objectNodes(schema, name, nodes)
    assert.ok(nodes.length > 0, `${name} declares at least one object node`)
    for (const { path, node } of nodes) {
      assert.equal(
        Object.hasOwn(node, 'additionalProperties'),
        true,
        `${path} must declare additionalProperties`,
      )
      assert.equal(
        typeof node.additionalProperties,
        'boolean',
        `${path}.additionalProperties must be a boolean`,
      )
    }
  }
})

test('the documented enums and defaults are exactly spec §9', async (t) => {
  const ctx = await toolbed(t)
  registerTools(ctx, stubServices())
  const params = (name) => TOOL_PARAMETERS[name]

  assert.deepEqual(params('mem_search').scope.enum, ['project', 'global', 'all'])
  assert.equal(params('mem_search').scope.default, 'project')
  assert.equal(params('mem_search').includeHistory.default, false)
  assert.equal(params('mem_search').limit.default, 8)
  assert.equal(params('mem_search').query.required, true)

  assert.deepEqual(params('mem_admin').action.enum, [
    'lint',
    'index',
    'bind',
    'projects',
    'promote',
    'jobs',
    // The one action that reads no vault and needs no binding, so it still answers
    // when every other action refuses.
    'diagnostics',
    // Task 5's bounded administration: `status` reads private state without
    // scanning and `scan` runs one bounded pass. There is deliberately no
    // `apply`, `approve` or `reject` value here — approval is a TTY-only command
    // (Task 7), never a model-callable action.
    'curation',
  ])
  assert.deepEqual(params('mem_admin').operation.enum, ['status', 'scan'])
  assert.equal(params('mem_admin').operation.default, 'status')
  assert.deepEqual(params('mem_admin').mode.enum, ['show', 'local', 'fork', 'retain'])
  assert.equal(params('mem_admin').mode.default, 'show')
  assert.equal(params('mem_admin').rebuild.default, false)
  assert.equal(params('mem_admin').report.default, false)
  assert.equal(params('mem_admin').prune.default, false)
  assert.deepEqual(Object.keys(params('mem_admin')).sort(), [
    'action',
    'jobId',
    'mode',
    'operation',
    'path',
    'prune',
    'rebuild',
    'report',
    'retry',
  ])
  assert.deepEqual(params('mem_write').assertion.enum, ['stated', 'inferred', 'observed'])

  assert.deepEqual(Object.keys(params('mem_brief')), [])
})

test('mem_admin exposes no approval operation, in the DSL or in the compiled schema', async (t) => {
  const ctx = await toolbed(t)
  registerTools(ctx, stubServices())
  const compiled = ctx.tools.get('mem_admin').parameters.properties.action.enum
  const operation = ctx.tools.get('mem_admin').parameters.properties.operation.enum
  for (const name of ['apply', 'approve', 'reject', 'accept']) {
    assert.equal(TOOL_PARAMETERS.mem_admin.action.enum.includes(name), false)
    assert.equal(compiled.includes(name), false)
    assert.equal(operation.includes(name), false)
  }
  // The closed pair is the whole set: a widened `operation` would be a widened
  // contract, so the equality is asserted rather than the absence of four names.
  assert.deepEqual(operation, ['status', 'scan'])
})

test('mem_admin branches its result with a per-action const instead of an unconstrained object', async (t) => {
  const ctx = await toolbed(t)
  registerTools(ctx, stubServices())
  const schema = ctx.tools.get('mem_admin').output.schema
  assert.equal(Array.isArray(schema.oneOf), true)
  const actions = schema.oneOf.map((arm) => arm.properties.action.const)
  assert.deepEqual(actions.slice().sort(), [
    'bind',
    'curation',
    'diagnostics',
    'index',
    'jobs',
    'lint',
    'projects',
    'promote',
  ])
})

test('a service that is missing is refused at registration time', async (t) => {
  const ctx = await toolbed(t)
  const services = stubServices()
  delete services.brief
  assert.throws(() => registerTools(ctx, services), /services\.brief/)
  assert.equal(ctx.tools.schemas().length, 0)
})

test('disposing registerTools removes all six registrations', async (t) => {
  const ctx = await toolbed(t)
  const disposers = registerTools(ctx, stubServices())
  assert.equal(ctx.tools.schemas().length, 6)
  for (const dispose of disposers) dispose()
  assert.deepEqual(ctx.tools.schemas(), [])
})

// ---------------------------------------------------------------------------
// Execution: arguments, defaults and cancellation
// ---------------------------------------------------------------------------

test('the runtime passes an undeclared key through, which is why every execute checks', async (t) => {
  const ctx = await toolbed(t)
  // A control tool with the same open parameter root and no key check of its
  // own: the runtime compiles `{type:'object', properties}` and validates only
  // the declared properties, so the extra key reaches `execute` untouched. This
  // is the fact `assertKnownArguments` exists for.
  ctx.tools.register(
    defineTool({
      name: 'control_open_root',
      description: 'control: open parameter root, no key check',
      parameters: { query: { type: 'string', required: true } },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { seen: { type: 'array', required: true, items: { type: 'string' } } },
        },
        render: (_args, value) => [{ type: 'text', text: value.seen.join(',') }],
      },
      async execute(args) {
        return { seen: Object.keys(args).sort() }
      },
    }),
  )
  const result = await call(ctx, 'control_open_root', { query: 'x', zzz: 1 })
  assert.equal(result.isError, false, result.error?.message)
  assert.deepEqual(result.value.seen, ['query', 'zzz'])
})

test('an extra argument key is refused by every tool before its service runs', async (t) => {
  const ctx = await toolbed(t)
  const services = stubServices()
  registerTools(ctx, services)
  const cases = [
    ['mem_search', { query: '调度器', zzz: 1 }],
    ['mem_read', { path: SAMPLE_PATH, zzz: 1 }],
    ['mem_write', { type: 'doc', title: '标题', body: '正文', zzz: 1 }],
    ['mem_log', { text: '一行日志', zzz: 1 }],
    ['mem_brief', { zzz: 1 }],
    ['mem_admin', { action: 'lint', zzz: 1 }],
  ]
  for (const [name, args] of cases) {
    const result = await call(ctx, name, args)
    assert.equal(result.isError, true, `${name} must refuse an unknown argument`)
    assert.match(result.error.message, /zzz/, `${name} names the offending key`)
  }
  assert.deepEqual(services.calls, [], 'no service may see a call with an unknown key')
})

test('an unknown argument key is named in a stable order', async (t) => {
  const ctx = await toolbed(t)
  registerTools(ctx, stubServices())
  const result = await call(ctx, 'mem_search', { query: 'x', zzz: 1, aaa: 2 })
  assert.equal(result.isError, true)
  assert.match(result.error.message, /"aaa", "zzz"/)
})

test('a missing required argument is refused by the compiled schema', async (t) => {
  const ctx = await toolbed(t)
  const services = stubServices()
  registerTools(ctx, services)
  const result = await call(ctx, 'mem_search', { limit: 3 })
  assert.equal(result.isError, true)
  assert.match(result.error.message, /query/)
  assert.deepEqual(services.calls, [])
})

test('an out-of-enum scope, action or mode is refused by the compiled schema', async (t) => {
  const ctx = await toolbed(t)
  const services = stubServices()
  registerTools(ctx, services)
  for (const [name, args] of [
    ['mem_search', { query: 'x', scope: 'everywhere' }],
    ['mem_admin', { action: 'nope' }],
    ['mem_admin', { action: 'bind', mode: 'whatever' }],
    ['mem_write', { type: 'doc', title: 't', body: 'b', assertion: 'guessed' }],
  ]) {
    const result = await call(ctx, name, args)
    assert.equal(result.isError, true, `${name} ${JSON.stringify(args)} must be refused`)
  }
  assert.deepEqual(services.calls, [])
})

test('mem_search fills the spec §9 defaults before the service sees them', async (t) => {
  const ctx = await toolbed(t)
  const services = stubServices()
  registerTools(ctx, services)
  const result = await call(ctx, 'mem_search', { query: '调度器' })
  assert.equal(result.isError, false, result.error?.message)
  assert.deepEqual(result.value, { hits: [] })
  assert.equal(services.calls.length, 1)
  const forwarded = services.calls[0].args
  assert.equal(forwarded.scope, 'project')
  assert.equal(forwarded.includeHistory, false)
  assert.equal(forwarded.limit, 8)
})

test('mem_admin defaults mode to show, retry to false and report to false', async (t) => {
  const ctx = await toolbed(t)
  const services = stubServices({
    admin: (args) =>
      args.action === 'bind'
        ? {
            action: 'bind',
            result: {
              mode: 'show',
              status: 'shown',
              resolution: { kind: 'unbound', reason: 'no-pointer' },
            },
          }
        : adminResult(args.action, args),
  })
  registerTools(ctx, services)

  const bound = await call(ctx, 'mem_admin', { action: 'bind' })
  assert.equal(bound.isError, false, bound.error?.message)
  assert.equal(services.calls[0].args.mode, 'show')
  assert.equal(bound.value.result.resolution.kind, 'unbound')

  const jobs = await call(ctx, 'mem_admin', { action: 'jobs' })
  assert.equal(jobs.isError, false, jobs.error?.message)
  assert.equal(services.calls[1].args.retry, false)

  // `lint` is read-only unless the caller asks for a report and/or a prune.
  const lint = await call(ctx, 'mem_admin', { action: 'lint' })
  assert.equal(lint.isError, false, lint.error?.message)
  assert.equal(services.calls[2].args.report, false)
  assert.equal(services.calls[2].args.prune, false)
  assert.equal(lint.value.result.readOnly, true)

  // The two write requests are independent: a report never implies a prune.
  const reporting = await call(ctx, 'mem_admin', { action: 'lint', report: true })
  assert.equal(reporting.isError, false, reporting.error?.message)
  assert.equal(services.calls[3].args.report, true)
  assert.equal(services.calls[3].args.prune, false)
  const pruning = await call(ctx, 'mem_admin', { action: 'lint', prune: true })
  assert.equal(pruning.isError, false, pruning.error?.message)
  assert.equal(services.calls[4].args.report, false)
  assert.equal(services.calls[4].args.prune, true)
})

test('mem_admin refuses a parameter that the requested action cannot act on', async (t) => {
  const ctx = await toolbed(t)
  const services = stubServices()
  registerTools(ctx, services)
  const result = await call(ctx, 'mem_admin', { action: 'projects', jobId: 'job-1' })
  assert.equal(result.isError, true)
  assert.match(result.error.message, /jobId/)
  assert.deepEqual(services.calls, [])
})

test('execute hands its own AbortSignal and execution context to the service', async (t) => {
  const ctx = await toolbed(t)
  const services = stubServices()
  registerTools(ctx, services)
  const controller = new AbortController()
  const agent = { session: { header: { id: 'sess-1', cwd: '/tmp/example' } } }
  const result = await call(ctx, 'mem_search', { query: 'x' }, { signal: controller.signal, agent })
  assert.equal(result.isError, false, result.error?.message)
  assert.equal(services.calls[0].signal, controller.signal)
  assert.equal(services.calls[0].exec.agent, agent)
})

test('an already-aborted signal stops the call before the service runs', async (t) => {
  const ctx = await toolbed(t)
  const services = stubServices()
  registerTools(ctx, services)
  const controller = new AbortController()
  controller.abort()
  const result = await call(ctx, 'mem_search', { query: 'x' }, { signal: controller.signal })
  assert.equal(result.isError, true)
  assert.deepEqual(services.calls, [])
})

test('a malformed value returned by a service is refused by the output schema', async (t) => {
  const ctx = await toolbed(t)
  const services = stubServices({
    // `hits[0].title` is declared required, so a hit without one is a bug in the
    // service, not a value the model may see.
    search: () => [{ path: 'a.md' }],
  })
  registerTools(ctx, services)
  const result = await call(ctx, 'mem_search', { query: 'x' })
  assert.equal(result.isError, true)
  assert.match(result.error.message, /title/)
})

test('mem_brief reports an unbound project instead of an empty brief', async (t) => {
  const ctx = await toolbed(t)
  registerTools(ctx, stubServices())
  const result = await call(ctx, 'mem_brief', {})
  assert.equal(result.isError, false, result.error?.message)
  assert.deepEqual(result.value, {
    status: 'unbound',
    message: 'this working directory is not a bound project',
  })
})

test('every mem_admin action answers its own real result shape, with no placeholder', async (t) => {
  const ctx = await toolbed(t)
  const services = stubServices()
  registerTools(ctx, services)
  for (const action of ['lint', 'promote', 'jobs']) {
    const result = await call(ctx, 'mem_admin', { action })
    assert.equal(result.isError, false, result.error?.message)
    assert.equal(result.value.action, action)
    assert.notEqual(JSON.stringify(result.value).includes('not-ready-in-p1'), true)
  }
  // `path` belongs to promote; lint has no use for it and must say so.
  const refused = await call(ctx, 'mem_admin', { action: 'lint', path: SAMPLE_PATH })
  assert.equal(refused.isError, true)
  assert.match(refused.error.message, /path/)
})

test('mem_admin(action="diagnostics") answers through the real seam without a vault', async (t) => {
  const ctx = await toolbed(t)
  const dataRoot = mkdtempSync(join(tmpdir(), 'obsidian-mem-diag-'))
  t.after(() => rmSync(dataRoot, { recursive: true, force: true }))
  // The ring is injected, which is the property under test: the tool must report
  // the instance the plugin is actually using, not a fresh empty one.
  const diagnostics = createDiagnostics({})
  const services = createMemoryServices({ config: validateConfig({}), dataRoot, diagnostics })
  t.after(() => services.close?.())
  registerTools(ctx, services)
  diagnostics.event('job', { outcome: 'applied', attempts: 1 })
  // Every category the ring can record has to survive the *output* schema, and
  // `recall` is the one that did not: the ring accepted it, the schema's closed
  // enum had never heard of it, and `mem_admin(action="diagnostics")` refused the
  // whole snapshot with "must match exactly one oneOf branch (matched 0)". This
  // case is the comparison neither `test/debug.test.js` (which calls the ring) nor
  // `test/hooks.test.js` (which injects its own ring) was making.
  diagnostics.event('recall', { outcome: 'below-floor', hits: 8, chars: 0 })

  const result = await call(ctx, 'mem_admin', { action: 'diagnostics' })
  assert.equal(result.isError, false, result.error?.message)
  assert.equal(result.value.action, 'diagnostics')
  assert.deepEqual(Object.keys(result.value.result).sort(), ['events', 'window'])
  assert.deepEqual(Object.keys(result.value.result.window).sort(), [
    'capacity',
    'dropped',
    'newestSeq',
    'oldestSeq',
    'size',
  ])
  assert.equal(result.value.result.window.capacity, 200)
  assert.equal(result.value.result.events.length, 2)
  assert.equal(result.value.result.events[0].event, 'job')
  assert.equal(result.value.result.events[0].outcome, 'applied')
  assert.equal(result.value.result.events[1].event, 'recall')
  assert.equal(result.value.result.events[1].outcome, 'below-floor')
  assert.equal(result.value.result.events[1].hits, 8)
  assert.equal(result.value.result.events[1].chars, 0)

  // An irrelevant argument is refused exactly like every other action's.
  const refused = await call(ctx, 'mem_admin', { action: 'diagnostics', path: 'x.md' })
  assert.equal(refused.isError, true)
  assert.match(refused.error.message, /does not accept/)
})

// ---------------------------------------------------------------------------
// Task 5: the bounded curation action, through the real service layer
// ---------------------------------------------------------------------------

/**
 * The bounds the tool-path scan cases hand the factory (R40). That action takes no
 * bound from the tool, so the wall clock decides a pass this small only when the
 * machine is loaded; supplying the scan's own generous limits makes `complete` a
 * claim about the fixture instead.
 */
const CURATION_TEST_BOUNDS = Object.freeze({ maxNotes: 256, maxMs: 60_000 })

test('curation status and scan answer their own bounded shape, and only their own parameters', async (t) => {
  const { services, diagnostics } = await curationServices(t)
  const ctx = await toolbed(t)
  registerTools(ctx, services)

  for (const [operation, status] of [
    ['status', 'listed'],
    ['scan', 'scanned'],
  ]) {
    const result = await call(ctx, 'mem_admin', { action: 'curation', operation })
    assert.equal(result.isError, false, result.error?.message)
    assert.equal(result.value.action, 'curation')
    assert.deepEqual(Object.keys(result.value.result).sort(), [
      'autoEnabled',
      'complete',
      'counts',
      'cursor',
      'examined',
      'operation',
      'projectId',
      'proposals',
      'scannedAt',
      'status',
      'truncated',
    ])
    assert.equal(result.value.result.operation, operation)
    assert.equal(result.value.result.status, status)
    assert.equal(result.value.result.autoEnabled, true)
    assert.equal(Number.isSafeInteger(result.value.result.examined), true)
    // The projection is bounded: counts are integers and the listing names its own
    // truncation rather than returning an unbounded queue.
    for (const count of Object.values(result.value.result.counts)) {
      assert.equal(Number.isSafeInteger(count), true)
    }
    assert.deepEqual(result.value.result.proposals.unreadable, [])
  }

  // The scan ran through this service set and recorded its own decision.
  const curated = diagnostics
    .snapshot()
    .events.filter((event) => event.event === 'curation')
    .map((event) => event.outcome)
  assert.ok(curated.includes('scanned'), `no scanned decision: ${JSON.stringify(curated)}`)
  assert.ok(curated.includes('listed'), `no listed decision: ${JSON.stringify(curated)}`)

  // `operation` is curation's own parameter; no other action accepts it, and
  // curation accepts nothing else. Omitting it is the read-only answer, never a
  // scan the caller did not ask for.
  const defaulted = await call(ctx, 'mem_admin', { action: 'curation' })
  assert.equal(defaulted.isError, false, defaulted.error?.message)
  assert.equal(defaulted.value.result.operation, 'status')
  assert.equal(defaulted.value.result.status, 'listed')
  for (const args of [
    { action: 'curation', jobId: 'job-1' },
    { action: 'curation', report: true },
    { action: 'projects', operation: 'scan' },
  ]) {
    const refused = await call(ctx, 'mem_admin', args)
    assert.equal(refused.isError, true, `${JSON.stringify(args)} must be refused`)
    assert.match(refused.error.message, /does not accept/)
  }
  const outOfEnum = await call(ctx, 'mem_admin', { action: 'curation', operation: 'apply' })
  assert.equal(outOfEnum.isError, true)
  assert.match(outOfEnum.error.message, /operation/)
})

test('the scan action passes on the bound the factory supplied', async (t) => {
  // R40: the tool-path coverage cases below supply `curationBounds` so their
  // `complete` is a fixture claim. That is only true if this path really uses the
  // bound, so zero milliseconds — a bound no wall clock can beat — must certify
  // nothing through the tool itself. The world is its own because a truncated pass
  // leaves the cursor and the queue in a state the cases above do not expect.
  const { services, repo } = await curationServices(t, { curationBounds: { maxMs: 0 } })
  const ctx = await toolbed(t)
  registerTools(ctx, services)
  const agent = { session: { header: { id: 'sess-env-bounds', cwd: repo } } }
  const result = await call(ctx, 'mem_admin', { action: 'curation', operation: 'scan' }, { agent })
  assert.equal(result.isError, false, result.error?.message)
  assert.equal(result.value.result.status, 'scanned')
  assert.equal(result.value.result.complete, false)
  assert.equal(result.value.result.truncated, 'time-budget')
  assert.equal(result.value.result.examined, 0)
})

test('an unusable curation bound is refused at the factory, never ignored', async (t) => {
  // A typo'd bound that quietly fell back to the shipped limit would put the
  // coverage cases back on the wall clock, which is the defect the seam removes.
  const world = await makeCurationWorld(t)
  const base = { config: world.config, dataRoot: world.dataRoot, cwd: world.repo, home: world.home }
  for (const curationBounds of [
    [],
    { maxNotes: 0 },
    { maxMs: -1 },
    { maxNotes: 1.5 },
    { limit: 500 },
  ]) {
    assert.throws(
      () => createMemoryServices({ ...base, curationBounds }),
      RangeError,
      `${JSON.stringify(curationBounds)} must be refused`,
    )
  }
  const accepted = createMemoryServices({ ...base, curationBounds: CURATION_TEST_BOUNDS })
  t.after(() => accepted.close())
  assert.equal(typeof accepted.admin, 'function')
})

test('status reads private state without scanning, and scan examines the notes', async (t) => {
  const { services, repo, readEnqueued, countPrivateFiles } = await curationServices(t, {
    curationBounds: CURATION_TEST_BOUNDS,
  })
  const ctx = await toolbed(t)
  registerTools(ctx, services)
  const agent = { session: { header: { id: 'sess-curation', cwd: repo } } }

  // A fresh project: no cursor, no view. `status` must answer that and leave
  // private state exactly as it found it — the read-only half of the contract.
  const before = await countPrivateFiles()
  const fresh = await call(ctx, 'mem_admin', { action: 'curation', operation: 'status' }, { agent })
  assert.equal(fresh.isError, false, fresh.error?.message)
  assert.equal(fresh.value.result.status, 'listed')
  assert.equal(fresh.value.result.complete, false)
  assert.equal(fresh.value.result.cursor, null)
  assert.equal(fresh.value.result.scannedAt, null)
  assert.equal(fresh.value.result.examined, 0)
  assert.equal(fresh.value.result.counts.entries, 0)
  assert.equal(await countPrivateFiles(), before, 'status must write no private state')

  // `scan` inspects the project's notes and leaves a cursor behind — the bounded
  // backfill the automatic pass (Task 6) resumes from.
  const scanned = await call(ctx, 'mem_admin', { action: 'curation', operation: 'scan' }, { agent })
  assert.equal(scanned.isError, false, scanned.error?.message)
  assert.equal(scanned.value.result.status, 'scanned')
  assert.equal(scanned.value.result.complete, true)
  // The bootstrap skeleton is real vault content, so the pass covers every note of
  // the bound project, not just the one this fixture wrote.
  assert.ok(scanned.value.result.examined >= 1)
  assert.ok(scanned.value.result.examined <= 256)
  assert.equal(typeof scanned.value.result.cursor, 'string')
  assert.match(scanned.value.result.scannedAt, /^\d{4}-\d{2}-\d{2}T/)
  assert.ok(scanned.value.result.counts.entries >= 1)
  assert.equal((await countPrivateFiles()) > before, true, 'the pass must leave a cursor')

  // Nothing asked for an inspection and nothing is waiting for one: this fixture
  // never enqueued a hint, so the durable queue is empty after a whole-project pass.
  assert.deepEqual(await readEnqueued(), [])

  // The status that follows reports the state the scan left, without scanning.
  const listed = await call(
    ctx,
    'mem_admin',
    { action: 'curation', operation: 'status' },
    { agent },
  )
  assert.equal(listed.isError, false, listed.error?.message)
  assert.equal(listed.value.result.scannedAt, scanned.value.result.scannedAt)
  assert.equal(listed.value.result.examined, 0)
  assert.equal(listed.value.result.counts.entries, scanned.value.result.counts.entries)
})

test('only the paths one pass inspected are acknowledged, and only over a complete view', async (t) => {
  const { services, repo, written, enqueue, readEnqueued } = await curationServices(t, {
    notes: 3,
    curationBounds: CURATION_TEST_BOUNDS,
  })
  const ctx = await toolbed(t)
  registerTools(ctx, services)
  const agent = { session: { header: { id: 'sess-bounded', cwd: repo } } }

  // A complete view first, so the service has something a changed-path pass may
  // merge into. Until it exists, the same call walks the project instead — which
  // is the branch the second case below pins.
  const initial = await call(ctx, 'mem_admin', { action: 'curation', operation: 'scan' }, { agent })
  assert.equal(initial.isError, false, initial.error?.message)
  assert.equal(initial.value.result.complete, true)

  // Three hints, one inspected: only the path this pass read is durable enough to
  // drop, and the view entry it wrote is what makes that durable.
  const first = await enqueue(written[0].path)
  const second = await enqueue(written[1].path)
  const third = await enqueue(written[2].path)
  const queued = await readEnqueued()
  assert.equal(queued.length, 3, JSON.stringify(queued))
  const one = await services.curateCurrentProject({
    force: true,
    changedPaths: [first.path],
    maxNotes: 1,
    // This call is about the *note* bound, so the deadline is set beyond any loaded
    // machine's reach: the shipped 500 ms made `examined` depend on how fast the box
    // reached its first read.
    maxMs: 60_000,
  })
  assert.equal(one.status, 'scanned')
  assert.equal(one.examined, 1)
  // The two it never read, in the store's own order (it holds paths as they were
  // first enqueued, and the fixture wrote them in this order).
  assert.deepEqual(await readEnqueued(), [second.path, third.path])

  // A pass cut short still only acknowledges what it inspected: the note bound is
  // what makes the remaining hints wait, not any doubt about the ones it read.
  const bounded = await services.curateCurrentProject({
    force: true,
    maxNotes: 1,
    maxMs: 60_000,
  })
  assert.equal(bounded.truncated, 'file-budget')
  assert.equal(bounded.examined, 1)
  assert.equal((await readEnqueued()).length, 1)

  // The traversal over a manifest nothing has moved since covers it and certifies.
  const covered = await call(ctx, 'mem_admin', { action: 'curation', operation: 'scan' }, { agent })
  assert.equal(covered.isError, false, covered.error?.message)
  assert.equal(covered.value.result.complete, true)
  assert.deepEqual(await readEnqueued(), [])

  const listed = await call(
    ctx,
    'mem_admin',
    { action: 'curation', operation: 'status' },
    { agent },
  )
  assert.equal(listed.isError, false, listed.error?.message)
  assert.equal(listed.value.result.complete, true)
})

test('a pass cut short by the note bound reports that reason and certifies nothing', async (t) => {
  // Its own world on purpose: a project that has already been walked has nothing
  // of its own left to do, so the same call there would be repairing earlier
  // batches instead of inspecting its first note, and the bound would prove
  // something else than the one under test.
  const { services } = await curationServices(t, { notes: 3 })
  // The note bound is what this case asserts, so the wall clock is not allowed to
  // supply the truncation instead: 60 s is far beyond what a three-note pass costs.
  const bounded = await services.curateCurrentProject({
    force: true,
    maxNotes: 1,
    maxMs: 60_000,
  })
  assert.equal(bounded.status, 'scanned')
  assert.equal(bounded.complete, false)
  assert.equal(bounded.truncated, 'file-budget')
  assert.equal(bounded.examined, 1)
  // The cursor moved, so the next pass resumes instead of starting over — the
  // bound is a resumption point, not a lost pass.
  assert.equal(typeof bounded.cursor, 'string')
  assert.equal(bounded.scannedAt !== null, true)

  const finished = await services.curateCurrentProject({
    force: true,
    maxNotes: 256,
    maxMs: 60_000,
  })
  assert.equal(finished.complete, true)
  assert.equal(finished.examined > bounded.examined, true)

  // The other bound is the wall clock, and it is reported by its own name: zero
  // milliseconds means this pass may not start a file operation at all, so it
  // inspects nothing and says which bound stopped it.
  const deadline = await services.curateCurrentProject({ force: true, maxMs: 0 })
  assert.equal(deadline.status, 'scanned')
  assert.equal(deadline.truncated, 'time-budget')
  assert.equal(deadline.examined, 0)
  assert.equal(deadline.complete, false)
})

test('curateCurrentProject answers "unbound" instead of scanning or binding', async (t) => {
  const { services, repo, config, home } = await curationServices(t, { bind: false })
  // A pointerless repository, which is what a session in a project nobody has
  // written to yet looks like. The read-only resolution must report that instead
  // of running a pass over whatever project the process happens to sit in.
  assert.equal(await services.curateCurrentProject({}), 'unbound')
  // Neither is a pointer minted as a side effect: the identity of a repository is
  // the user's explicit action, never something a curation pass creates.
  assert.equal(existsSync(join(repo, '.obsidian-mem')), false)
  // A pointerless repository refuses an explicit curation call too, and refuses it
  // without minting the identity: `mem_admin(action="curation")` resolves a project
  // the read-only way, so a scan is not a bind in disguise.
  await assert.rejects(
    () => services.admin({ action: 'curation', operation: 'scan' }),
    (error) => {
      assert.equal(error.code, 'not-bound')
      return true
    },
  )
  assert.equal(existsSync(join(repo, '.obsidian-mem')), false)
  const still = await resolveBinding({
    cwd: repo,
    vaultRoot: config.vaultPath,
    mode: 'show',
    home,
  })
  assert.equal(still.kind, 'unbound')
})

test('a hint callback that throws never retracts a committed write', async (t) => {
  // The write path's failure contract. `onCurationHint` is the seam that starts a
  // pass, and it runs *after* the transaction — so the vault byte, the receipt and
  // the durable hint are all already in place when it can fail. The failure the
  // receipt must survive is the callback's, and `applyOutcome` hangs the equivalent
  // promise off itself rather than awaiting it; here the callback is synchronous and
  // throwing, which is the harsher of the two.
  const world = await makeCurationWorld(t)
  const services = createMemoryServices({
    config: world.config,
    dataRoot: world.dataRoot,
    cwd: world.repo,
    home: world.home,
    onCurationHint: () => {
      throw new Error('the trigger is broken')
    },
  })
  t.after(() => services.close())

  const written = await services.write({
    type: 'convention',
    title: '钩子坏了也要留下字据',
    body: '结论：回执与提示先落盘，触发器的失败不能撤销回执。',
  })
  assert.match(written.path, /^Projects\//u)
  assert.equal(typeof written.receipt.txId, 'string')
  // The hint is durable, which is what makes the failed trigger a missing
  // optimisation rather than a lost change: the next due pass services it.
  const binding = await resolveBinding({
    cwd: world.repo,
    vaultRoot: world.config.vaultPath,
    mode: 'show',
    home: world.home,
  })
  assert.deepEqual(await readChangedSources({ binding, dataRoot: world.dataRoot }), [written.path])
  assert.equal(existsSync(join(world.vault, ...written.path.split('/'))), true)
})

test('a pass whose view build fell back acknowledges nothing', async (t) => {
  // The ordering guarantee the plan states: a hint may be dropped only once the
  // view it was built from is durable. Every non-`written` build *returns without
  // writing*, so gating the acknowledgement on the attempt rather than on the
  // result would drop the batch from the durable queue while the stored view never
  // learned about it — lost from both, which is the one outcome the plan's order
  // exists to prevent.
  //
  // The build is injected, because the service's own inputs cannot reach this
  // combination: `curateForBinding` only hands `buildCurationView` changed paths
  // when the stored view is already complete, and a complete view plus a complete
  // batch is exactly the case that writes. The injected verdict is the one the real
  // build returns for an oversize or unusable document; what is under test is what
  // the caller does with it. The injection runs *after* the real scan, so the pass
  // really inspected the queued path.
  const { services, diagnostics, repo, binding, written, enqueue, readEnqueued } =
    await curationServices(t, { notes: 1, curationBounds: CURATION_TEST_BOUNDS })
  const ctx = await toolbed(t)
  registerTools(ctx, services)
  const agent = { session: { header: { id: 'sess-fallback', cwd: repo } } }

  const initial = await call(ctx, 'mem_admin', { action: 'curation', operation: 'scan' }, { agent })
  assert.equal(initial.isError, false, initial.error?.message)
  assert.equal(initial.value.result.complete, true)
  const queued = await enqueue(written[0].path)
  assert.deepEqual(await readEnqueued(), [queued.path])

  let built = null
  const fellBack = await services.curateForBinding(binding, {
    force: true,
    changedPaths: [queued.path],
    buildView: async (input) => {
      built = input
      return { status: 'fallback', reason: 'view-oversize' }
    },
  })
  // The real scan ran and really inspected the queued path, so only the build's
  // verdict is under test.
  assert.equal(built.scan.examined, 1)
  assert.equal(built.scan.examinedPaths.includes(queued.path), true)
  assert.equal(fellBack.status, 'scanned')
  assert.equal(fellBack.examined, 1)
  // The fallback reason is reported as this call's one code, so `scanned` does not
  // read as "published"; `truncated` stays null because the scan was not cut short.
  assert.equal(fellBack.truncated, null)
  const decision = diagnostics
    .snapshot()
    .events.filter((event) => event.event === 'curation')
    .at(-1)
  assert.equal(decision.outcome, 'scanned')
  assert.equal(decision.code, 'view-oversize')
  // The reason is only durable if the disk vocabulary knows it: feed the very event
  // this pass recorded through the codec, so a code a call site starts emitting
  // cannot be silently persisted as `other` (the trap `review` fell into).
  const persisted = encodeDiagnosticEvent(decision, createAliases())
  assert.equal(persisted.code, 'view-oversize')
  assert.equal(decodeDiagnosticEvent(persisted).code, 'view-oversize')
  // The hint survives, because nothing durable carries what the view would have.
  assert.deepEqual(await readEnqueued(), [queued.path])

  // And through the tool's own projection of the same private state.
  const throughTool = await call(ctx, 'mem_admin', { action: 'curation', operation: 'status' })
  assert.equal(throughTool.isError, false, throughTool.error?.message)
  assert.deepEqual(await readEnqueued(), [queued.path])
})
