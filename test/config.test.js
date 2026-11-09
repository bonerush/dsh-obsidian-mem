// Task 3: the obsidian-mem plugin entry point and its eager configuration validation.
//
// The tests deliberately go through the SAME Standard Schema entry that Cordis
// runs before `apply` (`Config['~standard'].validate`) so the defaults the host
// applies and the defaults asserted here can never drift apart.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Config, validateConfig } from '../lib/config.js'
import { Config as ReexportedConfig, apply, inject, name } from '../lib/index.js'

/**
 * The complete default configuration of the plan's `Config` field set (R3).
 *
 * Kept as one literal on purpose: it pins the exact field set, so a dropped
 * spec-only field (`projectsDir`, `docMirror`, `distill.mode`, …) or a
 * newly invented one shows up as a diff here rather than silently shipping.
 */
const DEFAULTS = {
  enabled: true,
  vaultPath: '~/Documents/dsh-memory',
  initGitOnCreate: true,
  injectBrief: true,
  // The unbound-session notice (`lib/init-hint.js`): a session whose directory
  // resolves to no usable project is told once, so the user is asked whether to
  // bind it and a moved or deleted directory is reported instead of losing memory
  // in silence. `false` removes that one injection and nothing else.
  bindHint: true,
  briefBudgetChars: 6000,
  // The conventions preview: `summary` shows five lines and pages the rest;
  // `flat` is the pre-0.3 list.
  briefConventionMode: 'summary',
  recallBudgetChars: 900,
  // Task 18's default switch: a session whose tool calls begin failing in a run may
  // retrieve the project's pitfalls mid-turn, sharing `recallBudgetChars` with the
  // prompt-driven recall. `false` keeps retrieval keyed strictly to the user's own
  // prompts without losing the brief.
  failureRecall: true,
  hotCapacityChars: 9000,
  hotArchiveRatio: 0.67,
  autoCapture: true,
  // Task 5's default switch: automatic curation passes are on unless the operator
  // turns them off, and `false` disables only the automatic ones — the explicit
  // `mem_admin(action="curation", operation="scan")` stays available.
  autoCurate: true,
  // The automatic reviewer for parked executable proposals: on by default, and
  // `false` disables only the model decision — the queue, the CLI and the panel
  // stay available. It needs the `distill` route; without one it is a no-op.
  autoReview: true,
  captureIdleMs: 90000,
  distill: {
    provider: '',
    model: '',
    // The transport ships as `host`: the DSH host service, unchanged since 1.0.0.
    // `http` (an OpenAI-compatible endpoint this plugin calls itself) needs an
    // endpoint, so the shipped row cannot carry one.
    transport: 'host',
    egress: 'loopback',
    endpoint: '',
    apiStyle: 'openai-chat',
    apiKeyEnv: '',
    maxItems: 12,
    minConfidence: 0.75,
    maxInputChars: 24000,
    maxOutputTokens: 4000,
    timeoutMs: 60000,
    maxRetries: 3,
    dryRun: false,
    learnHabits: true,
  },
  indexBackend: 'auto',
  // The retrieval engine `mem_search` runs. `lexical` is the existing index
  // ranking and the measured baseline; `sparse` reranks its bounded candidate set
  // locally and fuses the two orders. From 2.0.0 the default is `hybrid`, whose
  // semantic channel is supplied by the provider block below — disabled by
  // default, so the shipped row still reads through the lexical path unchanged.
  retrievalEngine: 'hybrid',
  // The optional loopback retrieval provider: disabled by default so an
  // unconfigured row makes no request at all. `hybrid` is the only engine that
  // reads it; the values here are the shipped defaults, not a working provider.
  retrievalProvider: {
    enabled: false,
    // Loopback + the plugin's own /embed contract are the shipped defaults: an
    // unconfigured row makes no request, and a configured one stays local until
    // an operator writes `egress: remote` or `apiStyle: openai` themselves.
    egress: 'loopback',
    endpoint: '',
    apiStyle: 'embed',
    apiKeyEnv: '',
    model: '',
    dimensions: 0,
    timeoutMs: 500,
    rerank: false,
  },
  ignoreGlobs: [],
}

/** Validate through the schema the host itself uses, failing loudly on issues. */
function schemaValidate(raw) {
  const result = Config['~standard'].validate(raw)
  assert.equal(
    result.issues,
    undefined,
    `unexpected schema issues: ${JSON.stringify(result.issues)}`,
  )
  return result.value
}

/** Assert `validateConfig` rejects `raw` with a message matching `pattern`. */
function assertRejected(pattern, raw) {
  assert.throws(() => validateConfig(raw), pattern)
}

/** A context that records every property read and call, so `apply` can be audited. */
function recordingContext() {
  const accesses = []
  const ctx = new Proxy(
    {},
    {
      get(_target, property) {
        accesses.push(`read:${String(property)}`)
        return (...args) => {
          accesses.push(`call:${String(property)}(${args.length})`)
          return () => {}
        }
      },
    },
  )
  return { ctx, accesses }
}

test('defaults are exactly the plan field set (R3)', () => {
  const config = validateConfig({})
  assert.equal(config.vaultPath, '~/Documents/dsh-memory')
  assert.equal(config.captureIdleMs, 90000)
  assert.equal(config.distill.maxItems, 12)
  assert.deepStrictEqual(config, DEFAULTS)
})

test('the plan field set is exact — no spec-only fields are declared', () => {
  const config = validateConfig({})
  assert.deepStrictEqual(Object.keys(config).sort(), Object.keys(DEFAULTS).sort())
  assert.deepStrictEqual(Object.keys(config.distill).sort(), Object.keys(DEFAULTS.distill).sort())
})

test('a row without config, and the host pre-validated value, both resolve to the same defaults', () => {
  // Cordis passes whatever the row carries (possibly `undefined`) through
  // `Config['~standard'].validate` before `apply`; undefined means "all defaults".
  assert.deepStrictEqual(validateConfig(undefined), DEFAULTS)
  assert.deepStrictEqual(validateConfig(null), DEFAULTS)
  assert.deepStrictEqual(schemaValidate({}), DEFAULTS)
  assert.deepStrictEqual(validateConfig({}), schemaValidate({}))
})

test('validateConfig is idempotent on an already-validated object', () => {
  // The host validates before `apply`, so `apply` re-running validation must be safe.
  const once = validateConfig({})
  assert.deepStrictEqual(validateConfig(once), once)
  const routed = validateConfig({
    distill: { provider: 'deepseek-official', model: 'deepseek-flash' },
  })
  assert.deepStrictEqual(validateConfig(routed), routed)
})

const INTEGER_BOUNDS = [
  ['briefBudgetChars', 256, 20000],
  ['recallBudgetChars', 256, 20000],
  ['hotCapacityChars', 1024, 50000],
  ['captureIdleMs', 1000, 3600000],
]

for (const [key, min, max] of INTEGER_BOUNDS) {
  test(`${key} accepts the inclusive bounds ${min}..${max}`, () => {
    assert.equal(validateConfig({ [key]: min })[key], min)
    assert.equal(validateConfig({ [key]: max })[key], max)
  })

  test(`${key} rejects out-of-range and non-integer values`, () => {
    assertRejected(new RegExp(key), { [key]: min - 1 })
    assertRejected(new RegExp(key), { [key]: max + 1 })
    assertRejected(new RegExp(key), { [key]: min + 0.5 })
  })
}

const DISTILL_BOUNDS = [
  ['maxItems', 1, 50],
  ['maxInputChars', 256, 100000],
  ['maxOutputTokens', 128, 32000],
  ['timeoutMs', 1000, 300000],
  ['maxRetries', 0, 10],
]

for (const [key, min, max] of DISTILL_BOUNDS) {
  const pattern = new RegExp(`distill\\.${key}`)
  test(`distill.${key} accepts the inclusive bounds ${min}..${max}`, () => {
    assert.equal(validateConfig({ distill: { [key]: min } }).distill[key], min)
    assert.equal(validateConfig({ distill: { [key]: max } }).distill[key], max)
  })

  test(`distill.${key} rejects out-of-range and non-integer values`, () => {
    assertRejected(pattern, { distill: { [key]: min - 1 } })
    assertRejected(pattern, { distill: { [key]: max + 1 } })
    assertRejected(pattern, { distill: { [key]: min + 0.5 } })
  })
}

test('habit generation belongs to distill, and the unpublished independent learner is refused', () => {
  assert.equal(validateConfig({ distill: { learnHabits: false } }).distill.learnHabits, false)
  assertRejected(/learnHabits/, { distill: { learnHabits: 'yes' } })
  assertRejected(/habitLearning/, { habitLearning: { enabled: true } })
})

test('hotArchiveRatio must be strictly inside (0,1)', () => {
  assert.equal(validateConfig({ hotArchiveRatio: 0.01 }).hotArchiveRatio, 0.01)
  assert.equal(validateConfig({ hotArchiveRatio: 0.99 }).hotArchiveRatio, 0.99)
  for (const bad of [0, 1, -1, 2, 1.5]) {
    assertRejected(/hotArchiveRatio/, { hotArchiveRatio: bad })
  }
  assertRejected(/hotArchiveRatio/, { hotArchiveRatio: 'half' })
})

test('distill.minConfidence must be inside [0,1]', () => {
  assert.equal(validateConfig({ distill: { minConfidence: 0 } }).distill.minConfidence, 0)
  assert.equal(validateConfig({ distill: { minConfidence: 1 } }).distill.minConfidence, 1)
  for (const bad of [-0.1, 1.1, 2]) {
    assertRejected(/distill\.minConfidence/, { distill: { minConfidence: bad } })
  }
})

test('vaultPath must not be blank', () => {
  assert.equal(validateConfig({ vaultPath: ' /tmp/vault ' }).vaultPath, ' /tmp/vault ')
  for (const bad of ['', '   ', '\t\n']) {
    assertRejected(/vaultPath/, { vaultPath: bad })
  }
  assertRejected(/vaultPath/, { vaultPath: 7 })
})

test('an explicit distill route needs provider and model together', () => {
  assertRejected(/distill\.route/, { distill: { provider: 'deepseek-official' } })
  assertRejected(/distill\.route/, { distill: { model: 'deepseek-flash' } })
  const routed = validateConfig({
    distill: { provider: 'deepseek-official', model: 'deepseek-flash' },
  })
  assert.equal(routed.distill.provider, 'deepseek-official')
  assert.equal(routed.distill.model, 'deepseek-flash')
  assert.equal(validateConfig({ distill: { provider: '', model: '' } }).distill.provider, '')
})

test('indexBackend accepts only auto, sqlite and scan', () => {
  for (const backend of ['auto', 'sqlite', 'scan']) {
    assert.equal(validateConfig({ indexBackend: backend }).indexBackend, backend)
  }
  assertRejected(/indexBackend/, { indexBackend: 'fts5' })
})

test('retrievalEngine is hybrid by default and accepts the three local engines', () => {
  // From 2.0.0 the default engine is `hybrid`, whose dense channel is optional:
  // the provider block still ships disabled, so an unconfigured row answers from
  // the lexical path and says `provider-disabled` on the search event (proved in
  // test/services-hybrid.test.js). `sparse` is the deterministic local reranker
  // and needs nothing. `semantic` remains absent: a bare word would promise a
  // provider selection this schema cannot make.
  assert.equal(validateConfig({}).retrievalEngine, 'hybrid')
  assert.equal(validateConfig({ retrievalEngine: 'lexical' }).retrievalEngine, 'lexical')
  assert.equal(validateConfig({ retrievalEngine: 'sparse' }).retrievalEngine, 'sparse')
  const hybrid = {
    retrievalEngine: 'hybrid',
    retrievalProvider: {
      enabled: true,
      endpoint: 'http://127.0.0.1:8765',
      model: 'multilingual-e5-small',
      dimensions: 384,
    },
  }
  assert.equal(validateConfig(hybrid).retrievalEngine, 'hybrid')
  // Idempotent on the host's own pre-validated object, like every other field.
  assert.equal(
    validateConfig(validateConfig({ retrievalEngine: 'sparse' })).retrievalEngine,
    'sparse',
  )
  assert.equal(validateConfig(validateConfig(hybrid)).retrievalEngine, 'hybrid')
  // An explicit null reads as "absent" to schemastery and resolves to the default,
  // which is the same convention `indexBackend` follows; every other non-enum
  // value is a config error.
  assert.equal(validateConfig({ retrievalEngine: null }).retrievalEngine, 'hybrid')
  for (const bad of ['semantic', 'Sparse', 'LEXICAL', '', true, false, 0, ['sparse']]) {
    assertRejected(/retrievalEngine/, { retrievalEngine: bad })
  }
})

test('a hybrid engine without an enabled provider loads, and a bad provider is refused', () => {
  // `hybrid` is the default engine and the provider is disabled by default, so
  // this pair IS the shipped row since 2.0.0: it must load. The dense channel is
  // optional — `services.search` resolves the pair to the lexical path and records
  // `provider-disabled`, covered in test/services-hybrid.test.js. What must still
  // be refused is a provider that was switched ON and cannot be used.
  assert.equal(validateConfig({}).retrievalEngine, 'hybrid')
  assert.equal(validateConfig({}).retrievalProvider.enabled, false)
  assert.equal(
    validateConfig({
      retrievalEngine: 'hybrid',
      retrievalProvider: { enabled: false, endpoint: 'http://127.0.0.1:8765' },
    }).retrievalEngine,
    'hybrid',
  )
  // An enabled provider with the default engine is allowed (the default IS
  // hybrid), but an enabled provider must still be usable: remote endpoints, a
  // blank model and a non-integer width are refused whatever the engine.
  assert.equal(
    validateConfig({
      retrievalProvider: {
        enabled: true,
        endpoint: 'http://127.0.0.1:8765',
        model: 'e5-small',
        dimensions: 384,
      },
    }).retrievalEngine,
    'hybrid',
  )
  assert.equal(
    validateConfig({
      retrievalEngine: 'lexical',
      retrievalProvider: {
        enabled: true,
        endpoint: 'http://127.0.0.1:8765',
        model: 'e5-small',
        dimensions: 384,
      },
    }).retrievalEngine,
    'lexical',
  )
  assertRejected(/loopback|provider-non-loopback/, {
    retrievalProvider: { enabled: true, endpoint: 'http://example.com:8765' },
  })
  assertRejected(/model|provider-config/, {
    retrievalProvider: {
      enabled: true,
      endpoint: 'http://127.0.0.1:8765',
      model: ' ',
      dimensions: 384,
    },
  })
  assertRejected(/dimensions|provider-config/, {
    retrievalProvider: {
      enabled: true,
      endpoint: 'http://127.0.0.1:8765',
      model: 'e5-small',
      dimensions: 0,
    },
  })
  // defaults leave an unconfigured row with no provider and no request path
  assert.deepEqual(validateConfig({}).retrievalProvider, {
    enabled: false,
    egress: 'loopback',
    endpoint: '',
    apiStyle: 'embed',
    apiKeyEnv: '',
    model: '',
    dimensions: 0,
    timeoutMs: 500,
    rerank: false,
  })
  assertRejected(/retrievalProvider\.typo/, {
    retrievalProvider: { enabled: false, typo: 1 },
  })
})

test('a mistyped retrievalEngine key is refused instead of silently staying lexical', () => {
  // The same defect the top-level refusal exists for: `retrievalengine` would keep
  // the default in silence, so a user who configured sparse would never learn the
  // engine did not change.
  assertRejected(/retrievalengine/, { retrievalengine: 'sparse' })
  assertRejected(/retrieval/, { retrieval: { engine: 'sparse' } })
})

test('ignoreGlobs defaults to empty and only appends exclusions', () => {
  assert.deepStrictEqual(validateConfig({}).ignoreGlobs, [])
  const globs = ['**/.trash/**', 'Archive/**']
  assert.deepStrictEqual(validateConfig({ ignoreGlobs: globs }).ignoreGlobs, globs)
  assertRejected(/ignoreGlobs/, { ignoreGlobs: ['ok', 7] })
})

test('autoCurate is the default switch Task 6 reads, and only a boolean is accepted', () => {
  // The plan's global constraint in one place: `true` by default, `false` turns
  // automatic passes off without removing the explicit scan, and a value that is
  // neither is a config error rather than a truthy guess.
  assert.equal(validateConfig({}).autoCurate, true)
  assert.equal(validateConfig({ autoCurate: false }).autoCurate, false)
  assert.equal(validateConfig({ autoCurate: true }).autoCurate, true)
  // Idempotent on the host's own pre-validated object, like every other field.
  assert.equal(validateConfig(validateConfig({ autoCurate: false })).autoCurate, false)
  assertRejected(/autoCurate/, { autoCurate: 'off' })
  assertRejected(/autoCurate/, { autoCurate: 0 })
})

test('autoReview is the automatic reviewer switch, and only a boolean is accepted', () => {
  // `autoReview` gates only the bounded model reviewer the curation review panel
  // adds: the panel and the TTY command are unaffected, and with the default
  // empty `distill` route the reviewer is a stated no-op rather than an error.
  assert.equal(validateConfig({}).autoReview, true)
  assert.equal(validateConfig({ autoReview: false }).autoReview, false)
  assert.equal(validateConfig({ autoReview: true }).autoReview, true)
  assert.equal(validateConfig(validateConfig({ autoReview: false })).autoReview, false)
  assertRejected(/autoReview/, { autoReview: 'off' })
  assertRejected(/autoReview/, { autoReview: 0 })
})

test('an unknown top-level key is refused instead of silently defaulting', () => {
  // The measured defect: `vaultpath` (one letter off) validated cleanly and the
  // plugin pointed at — and bootstrapped — `~/Documents/dsh-memory`.
  assertRejected(/vaultpath/, { vaultpath: '/tmp/nope' })
  assert.throws(
    () => validateConfig({ vaultpath: '/tmp/nope' }),
    (error) => {
      assert.match(error.message, /unknown config key/)
      assert.match(error.message, /vaultpath/)
      // The message has to help a user who copied the design document's block.
      assert.match(error.message, /dropped|deliberately does not have/)
      assert.match(error.message, /projectsDir/)
      return true
    },
  )
})

test('distill transport selects a transport, and its endpoint is part of that choice', () => {
  // `host` is the DSH service (`ctx.get('llm')`), unchanged since 1.0.0; `http` is an
  // OpenAI-compatible endpoint this plugin calls itself. The two halves of that
  // decision — the transport and the endpoint — may never disagree: an endpoint next
  // to `host` is config nothing reads, and `http` without one cannot make a call.
  assert.equal(validateConfig({}).distill.transport, 'host')
  assert.equal(validateConfig({}).distill.egress, 'loopback')
  assert.equal(validateConfig({}).distill.endpoint, '')
  assert.equal(validateConfig({}).distill.apiStyle, 'openai-chat')
  assert.equal(validateConfig({}).distill.apiKeyEnv, '')
  const http = {
    distill: {
      transport: 'http',
      endpoint: 'http://127.0.0.1:11434/v1',
      provider: 'ollama',
      model: 'qwen3-embedding',
    },
  }
  assert.deepEqual(validateConfig(http).distill.endpoint, 'http://127.0.0.1:11434/v1')
  // A remote endpoint needs the explicit egress statement, same rule as the provider.
  const remote = {
    distill: { ...http.distill, egress: 'remote', endpoint: 'https://gateway.example.com/v1' },
  }
  assert.equal(validateConfig(remote).distill.egress, 'remote')
  assert.throws(() => validateConfig({ distill: { transport: 'http' } }), /distill\.endpoint/)
  assert.throws(
    () => validateConfig({ distill: { transport: 'host', endpoint: 'http://127.0.0.1:1/v1' } }),
    /distill\.endpoint/,
  )
  assert.throws(
    () => validateConfig({ distill: { ...http.distill, transport: 'socket' } }),
    /transport/,
  )
  assert.throws(() => validateConfig({ distill: { transport: 'host', typo: 1 } }), /distill\.typo/)
})

test('an unknown distill key is refused, named with its path', () => {
  assertRejected(/distill\.mode/, { distill: { mode: 'manual' } })
  assertRejected(/distill\.maxCostPerSession/, { distill: { maxCostPerSession: 5 } })
  // A known sibling next to the unknown key still does not smuggle it through.
  assertRejected(/distill\.mode/, { distill: { dryRun: true, mode: 'manual' } })
})

test('the plugin descriptor is the entry point Task 10 will extend', () => {
  assert.equal(name, 'obsidian-mem')
  assert.deepStrictEqual(inject, ['tools'])
  assert.equal(ReexportedConfig, Config)
  assert.equal(typeof apply, 'function')
})

test('apply rejects an out-of-range config eagerly', () => {
  const { ctx } = recordingContext()
  assert.throws(() => apply(ctx, { briefBudgetChars: 0 }), /briefBudgetChars/)
})

test('apply refuses a mistyped key before it resolves a vault or touches a service', () => {
  // The whole point of the refusal: a typo must not bootstrap a different vault.
  // `validateConfig` is the first statement of `apply`, so nothing is read.
  const { ctx, accesses } = recordingContext()
  assert.throws(() => apply(ctx, { vaultpath: '/tmp/nope' }), /vaultpath/)
  assert.deepStrictEqual(accesses, [])
})

test('apply registers no tool or hook, and reaches for no service, when enabled is false', () => {
  const { ctx, accesses } = recordingContext()
  assert.equal(apply(ctx, { enabled: false }), undefined)
  assert.deepStrictEqual(accesses, [])
})
