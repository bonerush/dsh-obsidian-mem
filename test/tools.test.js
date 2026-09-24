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
import { test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import toolsPlugin, { defineTool } from '@deepseek-ai/dsh-tools'

import { TOOL_NAMES, TOOL_PARAMETERS, registerTools } from '../lib/tools.js'

/** The six names, sorted for set comparison. */
const SIX = Object.freeze(['mem_admin', 'mem_brief', 'mem_log', 'mem_read', 'mem_search', 'mem_write'])

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
const adminResult = (action) => {
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
        index: { backend: 'sqlite', ready: true, notes: 1, rows: 1, files: 1, compared: true, reason: null },
        history: { policy: { keepCount: 200 }, directories: 0, bytes: 0, prunable: 0, pruned: [], needsRepair: [], oversized: false },
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
    result: action === 'promote'
      ? { source: SAMPLE_PATH, moved: false, id: SAMPLE_ID, path: 'Methods/样例.md', receipt: sampleReceipt('write') }
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
    admin: (args) => adminResult(args.action),
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
  t.after(async () => { await fork.dispose().catch(() => {}) })
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

/** Every object node reachable through `properties`, `items` and `oneOf`. */
function objectNodes(node, path, out) {
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    node.forEach((child, index) => objectNodes(child, `${path}[${index}]`, out))
    return
  }
  if (node.type === 'object') out.push({ path, node })
  if (node.properties !== undefined) {
    for (const [key, value] of Object.entries(node.properties)) objectNodes(value, `${path}.${key}`, out)
  }
  if (node.items !== undefined) objectNodes(node.items, `${path}[]`, out)
  if (node.oneOf !== undefined) node.oneOf.forEach((arm, index) => objectNodes(arm, `${path}|${index}`, out))
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

test('the registered name set is exactly the six documented tools', async (t) => {
  const ctx = await toolbed(t)
  registerTools(ctx, stubServices())
  const names = ctx.tools.schemas().map((schema) => schema.name).sort()
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
    const required = Object.entries(spec).filter(([, node]) => node.required === true).map(([key]) => key).sort()
    assert.deepEqual(required, REQUIRED[name].slice().sort(), `${name} required set`)
    // No property may carry the JSON-Schema array form; the DSL wants `true`.
    for (const [key, node] of Object.entries(spec)) {
      if (Object.hasOwn(node, 'required')) assert.equal(node.required, true, `${name}.${key}.required must be true`)
    }
  }
})

test('the runtime compiles those annotations into the JSON Schema required array', async (t) => {
  const ctx = await toolbed(t)
  registerTools(ctx, stubServices())
  for (const name of SIX) {
    const compiled = ctx.tools.get(name).parameters
    assert.equal(compiled.type, 'object')
    assert.deepEqual((compiled.required ?? []).slice().sort(), REQUIRED[name].slice().sort(), `${name} compiled required`)
    for (const key of REQUIRED[name]) assert.equal(Object.hasOwn(compiled.properties, key), true)
  }
})

test('the compiled parameter root is OPEN, so extra keys are refused by execute and not by the schema', async (t) => {
  const ctx = await toolbed(t)
  registerTools(ctx, stubServices())
  for (const name of SIX) {
    const compiled = ctx.tools.get(name).parameters
    assert.equal(compiled.type, 'object', `${name} root is an object`)
    assert.equal(Object.hasOwn(compiled, 'additionalProperties'), false, `${name} root must stay open`)
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
      assert.equal(Object.hasOwn(node, 'additionalProperties'), true, `${path} must declare additionalProperties`)
      assert.equal(typeof node.additionalProperties, 'boolean', `${path}.additionalProperties must be a boolean`)
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

  assert.deepEqual(params('mem_admin').action.enum, ['lint', 'index', 'bind', 'projects', 'promote', 'jobs'])
  assert.deepEqual(params('mem_admin').mode.enum, ['show', 'local', 'fork', 'retain'])
  assert.equal(params('mem_admin').mode.default, 'show')
  assert.equal(params('mem_admin').rebuild.default, false)
  assert.equal(params('mem_admin').report.default, false)
  assert.equal(params('mem_admin').prune.default, false)
  assert.deepEqual(Object.keys(params('mem_admin')).sort(), ['action', 'jobId', 'mode', 'path', 'prune', 'rebuild', 'report', 'retry'])
  assert.deepEqual(params('mem_write').assertion.enum, ['stated', 'inferred', 'observed'])

  assert.deepEqual(Object.keys(params('mem_brief')), [])
})

test('mem_admin branches its result with a per-action const instead of an unconstrained object', async (t) => {
  const ctx = await toolbed(t)
  registerTools(ctx, stubServices())
  const schema = ctx.tools.get('mem_admin').output.schema
  assert.equal(Array.isArray(schema.oneOf), true)
  const actions = schema.oneOf.map((arm) => arm.properties.action.const)
  assert.deepEqual(actions.slice().sort(), ['bind', 'index', 'jobs', 'lint', 'projects', 'promote'])
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
  ctx.tools.register(defineTool({
    name: 'control_open_root',
    description: 'control: open parameter root, no key check',
    parameters: { query: { type: 'string', required: true } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { seen: { type: 'array', required: true, items: { type: 'string' } } } },
      render: (_args, value) => [{ type: 'text', text: value.seen.join(',') }],
    },
    async execute(args) { return { seen: Object.keys(args).sort() } },
  }))
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
    admin: (args) => (args.action === 'bind'
      ? { action: 'bind', result: { mode: 'show', status: 'shown', resolution: { kind: 'unbound', reason: 'no-pointer' } } }
      : adminResult(args.action)),
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
  assert.deepEqual(result.value, { status: 'unbound', message: 'this working directory is not a bound project' })
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
