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
  briefBudgetChars: 6000,
  hotCapacityChars: 9000,
  hotArchiveRatio: 0.67,
  autoCapture: true,
  captureIdleMs: 90000,
  distill: {
    provider: '',
    model: '',
    maxItems: 12,
    minConfidence: 0.75,
    maxInputChars: 24000,
    maxOutputTokens: 4000,
    timeoutMs: 60000,
    maxRetries: 3,
    dryRun: false,
  },
  indexBackend: 'auto',
  ignoreGlobs: [],
}

/** Validate through the schema the host itself uses, failing loudly on issues. */
function schemaValidate(raw) {
  const result = Config['~standard'].validate(raw)
  assert.equal(result.issues, undefined, `unexpected schema issues: ${JSON.stringify(result.issues)}`)
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
  const routed = validateConfig({ distill: { provider: 'deepseek-official', model: 'deepseek-flash' } })
  assert.deepStrictEqual(validateConfig(routed), routed)
})

const INTEGER_BOUNDS = [
  ['briefBudgetChars', 256, 20000],
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
  const routed = validateConfig({ distill: { provider: 'deepseek-official', model: 'deepseek-flash' } })
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

test('ignoreGlobs defaults to empty and only appends exclusions', () => {
  assert.deepStrictEqual(validateConfig({}).ignoreGlobs, [])
  const globs = ['**/.trash/**', 'Archive/**']
  assert.deepStrictEqual(validateConfig({ ignoreGlobs: globs }).ignoreGlobs, globs)
  assertRejected(/ignoreGlobs/, { ignoreGlobs: ['ok', 7] })
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

test('apply registers no tool or hook, and reaches for no service, when enabled is false', () => {
  const { ctx, accesses } = recordingContext()
  assert.equal(apply(ctx, { enabled: false }), undefined)
  assert.deepStrictEqual(accesses, [])
})
