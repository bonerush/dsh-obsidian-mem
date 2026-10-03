import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  createAliases,
  decodeDiagnosticConfig,
  decodeDiagnosticEvent,
  encodeDiagnosticEvent,
  safeConfigSummary,
} from '../lib/diagnostic-codec.js'

const at = '2026-09-27T00:00:00.000Z'

test('the disk format removes content and aliases identifiers consistently', () => {
  const aliases = createAliases()
  const first = encodeDiagnosticEvent(
    {
      seq: 1,
      at,
      event: 'job',
      outcome: 'failed',
      jobId: 'raw-job-123',
      projectId: 'raw-project-123',
      code: 'private-user-text',
      body: 'SENTINEL-BODY',
      path: 'SENTINEL-PATH',
      prompt: 'SENTINEL-PROMPT',
      title: 'SENTINEL-TITLE',
      message: 'SENTINEL-MESSAGE',
    },
    aliases,
  )
  const second = encodeDiagnosticEvent(
    { seq: 2, at, event: 'job', outcome: 'retry', jobId: 'raw-job-123' },
    aliases,
  )
  assert.equal(first.job, 'j1')
  assert.equal(first.project, 'p1')
  assert.equal(second.job, 'j1')
  assert.equal(first.code, 'other')
  const bytes = JSON.stringify([first, second])
  for (const sentinel of ['raw-job', 'raw-project', 'SENTINEL', 'private-user-text']) {
    assert.equal(bytes.includes(sentinel), false)
  }
})

test('every distill outcome a call site emits survives the round trip', () => {
  // The disk format is a closed vocabulary, so an outcome a call site really
  // produces but the codec does not list is silently rewritten to `other` — the
  // one durable trace of why an item produced no note, erased, with a green suite.
  // `review` is the parked-candidate signal the whole curation gate exists to
  // raise, and `duplicate-check-failed` was added for the same reason; pin the
  // whole set so a new call site has to register its token here.
  const aliases = createAliases()
  const outcomes = [
    'deferred',
    'no-memory',
    'dry-run',
    'duplicate',
    'duplicate-check-failed',
    'review',
    'applied',
  ]
  for (const outcome of outcomes) {
    const encoded = encodeDiagnosticEvent({ seq: 1, at, event: 'distill', outcome }, aliases)
    assert.equal(encoded.outcome, outcome, `${outcome} is not coarsened`)
    assert.equal(decodeDiagnosticEvent(encoded).outcome, outcome, `${outcome} decodes back`)
  }
  // The control: a token the codec does not know is still coarsened, so the loop
  // above is testing registration rather than a codec that echoes anything.
  const unknown = encodeDiagnosticEvent(
    { seq: 1, at, event: 'distill', outcome: 'invented' },
    createAliases(),
  )
  assert.equal(unknown.outcome, 'other')
  assert.equal(decodeDiagnosticEvent(unknown).outcome, 'other')
})

test('unknown outcomes are coarsened and unsupported events are rejected', () => {
  const aliases = createAliases()
  assert.equal(encodeDiagnosticEvent({ seq: 1, at, event: 'unknown' }, aliases), null)
  assert.equal(
    encodeDiagnosticEvent({ seq: 1, at, event: 'job', outcome: 'private-text' }, aliases).outcome,
    'other',
  )
  assert.equal(encodeDiagnosticEvent({ seq: -1, at, event: 'job' }, aliases), null)
})

test('the reader refuses extras, raw ids, invalid counts and invalid dates', () => {
  const good = { seq: 1, at, event: 'job', outcome: 'failed', job: 'j1', attempts: 2 }
  assert.deepEqual(decodeDiagnosticEvent(good), good)
  for (const bad of [
    { ...good, body: 'SENTINEL' },
    { ...good, job: 'raw-job-123' },
    { ...good, attempts: -1 },
    { ...good, at: 'yesterday' },
  ]) {
    assert.equal(decodeDiagnosticEvent(bad), null)
  }
})

test('config projection includes only approved fields', () => {
  const config = safeConfigSummary({
    enabled: true,
    autoCapture: false,
    injectBrief: true,
    indexBackend: 'scan',
    distill: { dryRun: true, provider: 'SENTINEL-PROVIDER', model: 'SENTINEL-MODEL' },
    vaultPath: 'SENTINEL-VAULT',
  })
  assert.deepEqual(config, {
    enabled: true,
    autoCapture: false,
    injectBrief: true,
    indexBackend: 'scan',
    dryRun: true,
  })
  assert.deepEqual(decodeDiagnosticConfig(config), config)
  assert.equal(decodeDiagnosticConfig({ ...config, vaultPath: 'SENTINEL' }), null)
})
