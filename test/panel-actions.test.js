// Task 2 (v0.4): the three confirmed panel operations, as a pure contract.
//
// The unit here is the *preview* half of a mutation: it reads enough to show a
// human what will change, issues one single-use token bound to the session, the
// project, the operation, its arguments and a fingerprint of those facts, and
// then — only on a separate confirmation — lets the service run the one write.
// Every service call is injected, so the token/state machine can be driven
// without a vault; the last three cases drive the real service over a
// `mktemp` vault and queue to prove the preview really writes nothing.
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { validateConfig } from '../lib/config.js'
import { writeMemory } from '../lib/memory.js'
import { localDate } from '../lib/note-health.js'
import { PENDING_SCHEMA, queueRootFor, readPendingJobs, writeJobAtomic } from '../lib/pending.js'
import {
  MAX_PREVIEW_TOKENS,
  PANEL_MUTATIONS,
  PREVIEW_TTL_MS,
  confirmPanelAction,
  createPreviewTokens,
  normalizePanelArgs,
  previewFingerprint,
  previewPanelAction,
} from '../lib/panel-actions.js'
import { createMemoryServices } from '../lib/services.js'
import { bootstrapVault } from '../lib/vault.js'

import { registerTreeCleanup } from './platform-capabilities.js'

const PROJECT_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_PROJECT_ID = '22222222-2222-4222-8222-222222222222'
const JOB_ID = 'job-0123456789abcdef0123456789abcdef'
const SESSION = 'panel-session'

/** A bound project. Nothing unit-level reads the vault root. */
const BINDING = {
  kind: 'bound',
  projectId: PROJECT_ID,
  slug: 'demo',
  displayName: 'Demo',
  schema: 1,
  vaultRoot: '/tmp/obsidian-mem-panel-actions-unused',
  relativeDir: 'Projects/demo--11111111',
}

/** The tool execution context the route builds for every panel request. */
const EXEC = { agent: { session: { header: { id: SESSION, cwd: '/repo' } } } }

/** The job view the real `jobs` action reports (no model text, no safeInput). */
function jobView(overrides = {}) {
  return {
    jobId: JOB_ID,
    state: 'failed',
    sessionId: 'session-x',
    projectId: PROJECT_ID,
    fromSeq: 1,
    toSeq: 7,
    attempts: 2,
    createdAt: '2026-10-26T00:00:00.000Z',
    failedAt: '2026-10-26T01:00:00.000Z',
    lastError: 'boom',
    outputState: null,
    // Required by `writeJobAtomic`; the panel never reads either field.
    allowedEvents: [],
    safeInput: '',
    ...overrides,
  }
}

/** The status shape `mem_admin(action="hot", operation="status")` returns. */
function hotFixture(overrides = {}) {
  return {
    missing: false,
    used: 7200,
    capacity: 9000,
    trigger: 6030,
    ratio: 0.8,
    archivable: 3,
    compactable: 5,
    sections: [
      { name: '已完成', chars: 1200, entries: 1, pointers: 2, moveable: 3 },
      { name: '进行中', chars: 5400, entries: 6, pointers: 0, moveable: 2 },
      { name: '强约束', chars: 600, entries: 2, pointers: 0, moveable: 0 },
    ],
    ...overrides,
  }
}

/** A digest result as the collector renders it; only the stable facts matter. */
function digestFixture(overrides = {}) {
  return {
    window: { days: 1, from: '2026-10-26T10:00:00.000Z', to: '2026-10-27T10:00:00.000Z' },
    notes: {
      created: 1,
      updated: 0,
      superseded: 0,
      byType: [{ type: 'decision', created: 1, updated: 0 }],
    },
    hot: hotFixture({ sections: [] }),
    queue: { queued: 1, failed: 0, deferred: 0 },
    appraisal: { findings: [], total: 0, truncated: false, scanned: 1 },
    recent: [
      {
        path: 'Projects/demo--11111111/Decisions/a.md',
        title: 'a',
        type: 'decision',
        status: 'active',
        updated: '2026-10-27T09:00:00.000Z',
      },
    ],
    snapshot: {
      at: '2026-10-27T10:00:00.000Z',
      basis: 'current-status-among-inspected-sources',
      fields: ['notes.superseded', 'hot', 'queue'],
    },
    collection: {
      basis: 'inspected-source-notes',
      inspected: 1,
      limit: 200,
      truncated: false,
      incomplete: false,
      reasons: [],
    },
    ...overrides,
  }
}

/** Shift a digest's two clock-derived fields by `ms`, staying inside its day. */
function advanceDigestMs(digest, ms) {
  const shift = (value) =>
    typeof value === 'string' ? new Date(Date.parse(value) + ms).toISOString() : value
  return {
    ...digest,
    window: { ...digest.window, to: shift(digest.window.to) },
    snapshot: { ...digest.snapshot, at: shift(digest.snapshot.at) },
  }
}

/**
 * A stub service set that records every `admin` call and lets a case change the
 * world between preview and confirm.
 */
function previewStub({ job = jobView(), hot = hotFixture(), digest = digestFixture() } = {}) {
  const calls = []
  const state = { job, hot, digest, digestReads: 0, compacted: false, refreshed: false }
  const services = {
    async admin(args) {
      calls.push({ ...args })
      if (args.action === 'jobs') {
        if (args.retry === true) {
          state.job = { ...state.job, state: 'pending', attempts: 0 }
          return {
            action: 'jobs',
            result: { status: 'retried', jobs: [state.job], failed: 0, message: null },
          }
        }
        const jobs = state.job === null ? [] : [state.job]
        const selected =
          args.jobId === undefined ? jobs : jobs.filter((entry) => entry.jobId === args.jobId)
        return {
          action: 'jobs',
          result: {
            status: 'listed',
            jobs: selected,
            failed: jobs.filter((entry) => entry.state === 'failed').length,
            message: selected.length === 0 ? 'no such job' : null,
          },
        }
      }
      if (args.action === 'hot') {
        if (args.operation === 'compact') {
          state.compacted = true
          return {
            action: 'hot',
            result: {
              operation: 'compact',
              projectId: PROJECT_ID,
              ...state.hot,
              moved: 3,
              folded: 2,
              reclaimed: 900,
            },
          }
        }
        return {
          action: 'hot',
          result: {
            operation: 'status',
            projectId: PROJECT_ID,
            ...state.hot,
            moved: 0,
            folded: 0,
            reclaimed: 0,
          },
        }
      }
      if (args.action === 'digest') {
        if (args.operation === 'refresh') {
          state.refreshed = true
          return {
            action: 'digest',
            result: {
              ...state.digest,
              publication: {
                status: 'created',
                path: BINDING.relativeDir + '/_meta/digest.md',
                id: 'doc-abcdefgh',
                charCount: 900,
                txId: 'tx-digest-1',
              },
            },
          }
        }
        state.digestReads += 1
        // The collector reads its own clock twice: two reads on one day differ in
        // the millisecond, and the fingerprint has to be day-granular or every
        // confirmation near a read would be stale.
        if (state.digestReads > 1) state.digest = advanceDigestMs(state.digest, 700)
        return { action: 'digest', result: state.digest }
      }
      throw new Error('unexpected admin call ' + JSON.stringify(args))
    },
  }
  return { services, calls, state }
}

/** One environment the preview and its confirmation both have to share. */
function panelEnv(stub, { sessionId = SESSION, binding = BINDING, tokens } = {}) {
  return {
    sessionId,
    binding,
    services: stub.services,
    exec: EXEC,
    tokens: tokens ?? createPreviewTokens(),
    today: '2026-10-27',
  }
}

/** Assert one coded panel refusal, including the HTTP status it carries. */
function assertCode(status, code) {
  return (error) => {
    assert.equal(error?.code, code, String(error?.message))
    if (status !== undefined) assert.equal(error?.status, status)
    return true
  }
}

/**
 * English chrome must carry no Han characters. Callers pass labels, titles and
 * effects only: a fixture's own data values are not chrome.
 */
function assertNoHan(values) {
  const joined = values.join('\n')
  assert.equal(/[\u3400-\u9fff]/u.test(joined), false, joined)
}

/**
 * A throwaway root plus the registrar that removes it last.
 *
 * `node:test` runs its hooks in registration order, so a plain `t.after(rm)`
 * here would remove the tree before the services a later case opens are
 * closed, and Windows answers EBUSY on the still-open sqlite files. The
 * registrar runs every disposal registered on it first, then removes the tree.
 */
async function temporaryRoot(t, name) {
  const root = await mkdtemp(join(tmpdir(), name))
  return { root, onCleanup: registerTreeCleanup(t, root) }
}

// ---------------------------------------------------------------------------
// The vocabulary and the argument contract
// ---------------------------------------------------------------------------

test('the confirmed operation vocabulary is exactly the three reviewed operations', () => {
  assert.deepEqual([...PANEL_MUTATIONS], ['retry-job', 'compact-hot', 'refresh-digest'])
  for (const forbidden of ['lint', 'index', 'bind', 'curation', 'promote', 'digest', 'hot'])
    assert.equal(PANEL_MUTATIONS.includes(forbidden), false, forbidden + ' is not a panel mutation')
})

test('normalizePanelArgs bounds every operation to its one reviewed argument', () => {
  assert.deepEqual({ ...normalizePanelArgs('retry-job', { jobId: JOB_ID }) }, { jobId: JOB_ID })
  assert.throws(() => normalizePanelArgs('retry-job', undefined), RangeError)
  assert.throws(() => normalizePanelArgs('retry-job', { jobId: '   ' }), RangeError)
  assert.throws(() => normalizePanelArgs('retry-job', { jobId: 'x'.repeat(201) }), RangeError)
  assert.throws(() => normalizePanelArgs('retry-job', { jobId: JOB_ID, days: 2 }), RangeError)
  assert.deepEqual({ ...normalizePanelArgs('compact-hot', undefined) }, {})
  assert.deepEqual({ ...normalizePanelArgs('compact-hot', {}) }, {})
  assert.throws(() => normalizePanelArgs('compact-hot', { jobId: JOB_ID }), RangeError)
  assert.deepEqual({ ...normalizePanelArgs('refresh-digest', undefined) }, { days: 1 })
  assert.deepEqual({ ...normalizePanelArgs('refresh-digest', { days: 30 }) }, { days: 30 })
  for (const days of [0, 31, 1.5, '2', null]) {
    assert.throws(() => normalizePanelArgs('refresh-digest', { days }), RangeError, String(days))
  }
  assert.throws(() => normalizePanelArgs('refresh-digest', { days: 1, window: 'x' }), RangeError)
  assert.throws(() => normalizePanelArgs('lint', {}), RangeError)
  assert.throws(() => normalizePanelArgs('digest', {}), RangeError)
  assert.throws(() => normalizePanelArgs('retry-job', []), RangeError)
})

test('the preview fingerprint binds project, operation, arguments and facts', () => {
  const base = { projectId: PROJECT_ID, operation: 'compact-hot', args: {}, state: { used: 1 } }
  const fingerprint = previewFingerprint(base)
  assert.match(fingerprint, /^[0-9a-f]{64}$/u)
  assert.equal(previewFingerprint({ ...base, args: {}, state: { used: 1 } }), fingerprint)
  assert.notEqual(previewFingerprint({ ...base, state: { used: 2 } }), fingerprint)
  assert.notEqual(
    previewFingerprint({ ...base, projectId: OTHER_PROJECT_ID }),
    fingerprint,
    'a preview is bound to the project that issued it',
  )
  assert.notEqual(previewFingerprint({ ...base, operation: 'retry-job' }), fingerprint)
  // Key order is not a fact in the state, so it must not mint a second token id.
  assert.equal(
    previewFingerprint({ ...base, args: { b: 1, a: 2 } }),
    previewFingerprint({ ...base, args: { a: 2, b: 1 } }),
  )
})

// ---------------------------------------------------------------------------
// The token state machine
// ---------------------------------------------------------------------------

test('a preview token is single-use, replays its result and expires 60 seconds on', () => {
  let clock = 1_000_000
  const tokens = createPreviewTokens({ now: () => clock })
  const issued = tokens.issue({
    sessionId: SESSION,
    projectId: PROJECT_ID,
    operation: 'compact-hot',
    args: {},
    fingerprint: 'f'.repeat(64),
  })
  assert.equal(issued.expiresAt, clock + PREVIEW_TTL_MS)
  assert.match(issued.token, /^[A-Za-z0-9_-]{40,}$/u)
  const begun = tokens.begin({ token: issued.token, sessionId: SESSION, projectId: PROJECT_ID })
  assert.equal(begun.kind, 'run')
  assert.equal(begun.entry.fingerprint, 'f'.repeat(64))
  assert.throws(
    () => tokens.begin({ token: issued.token, sessionId: SESSION, projectId: PROJECT_ID }),
    assertCode(409, 'preview-in-progress'),
  )
  tokens.settle(issued.token, { status: 'compacted' })
  const replay = tokens.begin({ token: issued.token, sessionId: SESSION, projectId: PROJECT_ID })
  assert.equal(replay.kind, 'replay')
  assert.deepEqual(replay.result, { status: 'compacted' })
  // Exactly the TTL is still valid; one millisecond later it is not.
  const later = tokens.issue({
    sessionId: SESSION,
    projectId: PROJECT_ID,
    operation: 'compact-hot',
    args: {},
    fingerprint: 'e'.repeat(64),
  })
  clock = later.expiresAt
  assert.equal(
    tokens.begin({ token: later.token, sessionId: SESSION, projectId: PROJECT_ID }).kind,
    'run',
  )
  const expired = tokens.issue({
    sessionId: SESSION,
    projectId: PROJECT_ID,
    operation: 'compact-hot',
    args: {},
    fingerprint: 'd'.repeat(64),
  })
  clock = expired.expiresAt + 1
  assert.throws(
    () => tokens.begin({ token: expired.token, sessionId: SESSION, projectId: PROJECT_ID }),
    assertCode(409, 'preview-expired'),
  )
})

test('a token is bound to its session and project, and a mismatch does not burn it', () => {
  const tokens = createPreviewTokens({ now: () => 0 })
  const issued = tokens.issue({
    sessionId: SESSION,
    projectId: PROJECT_ID,
    operation: 'compact-hot',
    args: {},
    fingerprint: 'a'.repeat(64),
  })
  assert.throws(
    () =>
      tokens.begin({ token: issued.token, sessionId: 'another-session', projectId: PROJECT_ID }),
    assertCode(409, 'preview-mismatch'),
  )
  assert.throws(
    () => tokens.begin({ token: issued.token, sessionId: SESSION, projectId: OTHER_PROJECT_ID }),
    assertCode(409, 'preview-mismatch'),
  )
  // A mistaken tab cannot invalidate the tab that owns the preview.
  assert.equal(
    tokens.begin({ token: issued.token, sessionId: SESSION, projectId: PROJECT_ID }).kind,
    'run',
  )
  assert.throws(
    () => tokens.begin({ token: 'never-issued', sessionId: SESSION, projectId: PROJECT_ID }),
    assertCode(409, 'preview-unknown'),
  )
})

test('the token store holds at most 128 previews and evicts terminal ones first', () => {
  const tokens = createPreviewTokens({ now: () => 0, max: 2 })
  const first = tokens.issue({
    sessionId: SESSION,
    projectId: PROJECT_ID,
    operation: 'compact-hot',
    args: {},
    fingerprint: '1'.repeat(64),
  })
  const second = tokens.issue({
    sessionId: SESSION,
    projectId: PROJECT_ID,
    operation: 'compact-hot',
    args: {},
    fingerprint: '2'.repeat(64),
  })
  tokens.begin({ token: first.token, sessionId: SESSION, projectId: PROJECT_ID })
  tokens.settle(first.token, { status: 'done' })
  // third has to displace the finished token, not the still-usable second.
  tokens.issue({
    sessionId: SESSION,
    projectId: PROJECT_ID,
    operation: 'compact-hot',
    args: {},
    fingerprint: '3'.repeat(64),
  })
  assert.throws(
    () => tokens.begin({ token: first.token, sessionId: SESSION, projectId: PROJECT_ID }),
    assertCode(409, 'preview-unknown'),
  )
  assert.equal(
    tokens.begin({ token: second.token, sessionId: SESSION, projectId: PROJECT_ID }).kind,
    'run',
  )
  // A running confirmation is never evicted; the capacity bound still holds.
  const fourth = tokens.issue({
    sessionId: SESSION,
    projectId: PROJECT_ID,
    operation: 'compact-hot',
    args: {},
    fingerprint: '4'.repeat(64),
  })
  assert.equal(tokens.size(), 2)
  assert.equal(
    tokens.begin({ token: fourth.token, sessionId: SESSION, projectId: PROJECT_ID }).kind,
    'run',
  )
  assert.equal(MAX_PREVIEW_TOKENS, 128)
})

// ---------------------------------------------------------------------------
// Preview and confirm against a stub service
// ---------------------------------------------------------------------------

test('a retry preview issues a token without asking the service to write', async () => {
  const stub = previewStub()
  const tokens = createPreviewTokens({ now: () => 5_000 })
  const env = panelEnv(stub, { tokens })
  const preview = await previewPanelAction({
    operation: 'retry-job',
    args: { jobId: JOB_ID },
    ...env,
  })
  assert.equal(preview.operation, 'retry-job')
  assert.equal(preview.projectId, PROJECT_ID)
  assert.equal(preview.expiresAt, 5_000 + PREVIEW_TTL_MS)
  assert.equal(preview.preview.title.length > 0, true)
  assert.equal(preview.preview.confirmLabel.length > 0, true)
  assert.deepEqual(preview.preview.facts.map((fact) => fact.label).includes('任务'), true)
  assert.equal(preview.preview.facts.find((fact) => fact.label === '任务').value, JOB_ID)
  assert.ok(preview.preview.effects.length >= 1)
  assert.deepEqual(
    stub.calls.map((call) => call.action),
    ['jobs'],
    'preview reads the queue and nothing else',
  )
  assert.equal(stub.calls[0].retry, undefined)
  assert.equal(stub.state.job.state, 'failed', 'preview never revives the job')
})

test('confirm retries once and a repeated confirm returns the recorded result', async () => {
  const stub = previewStub()
  const tokens = createPreviewTokens({ now: () => 5_000 })
  const env = panelEnv(stub, { tokens })
  const preview = await previewPanelAction({
    operation: 'retry-job',
    args: { jobId: JOB_ID },
    ...env,
  })
  const confirmed = await confirmPanelAction({ token: preview.token, ...env })
  assert.equal(confirmed.replayed, false)
  assert.equal(confirmed.operation, 'retry-job')
  assert.equal(confirmed.result.status, 'retried')
  assert.equal(confirmed.result.jobId, JOB_ID)
  assert.equal(confirmed.result.state, 'pending')
  const retries = stub.calls.filter((call) => call.retry === true)
  assert.equal(retries.length, 1)
  assert.equal(retries[0].projectId, PROJECT_ID)
  const before = stub.calls.length
  const replay = await confirmPanelAction({ token: preview.token, ...env })
  assert.equal(replay.replayed, true)
  assert.deepEqual(replay.result, confirmed.result)
  assert.equal(stub.calls.length, before, 'a replay must not read or write again')
})

test('a changed previewed state is 409 preview-stale and never reaches the mutation', async () => {
  const stub = previewStub()
  const tokens = createPreviewTokens({ now: () => 5_000 })
  const env = panelEnv(stub, { tokens })
  const preview = await previewPanelAction({
    operation: 'retry-job',
    args: { jobId: JOB_ID },
    ...env,
  })
  stub.state.job = { ...stub.state.job, state: 'distilling' }
  await assert.rejects(
    () => confirmPanelAction({ token: preview.token, ...env }),
    assertCode(409, 'preview-stale'),
  )
  assert.equal(stub.calls.filter((call) => call.retry === true).length, 0)
})

test('cross-session and cross-project confirmations are refused', async () => {
  const stub = previewStub()
  const tokens = createPreviewTokens({ now: () => 5_000 })
  const env = panelEnv(stub, { tokens })
  const preview = await previewPanelAction({
    operation: 'retry-job',
    args: { jobId: JOB_ID },
    ...env,
  })
  await assert.rejects(
    () => confirmPanelAction({ token: preview.token, ...env, sessionId: 'another-session' }),
    assertCode(409, 'preview-mismatch'),
  )
  const foreign = {
    ...env.binding,
    projectId: OTHER_PROJECT_ID,
    relativeDir: 'Projects/other--22222222',
  }
  await assert.rejects(
    () => confirmPanelAction({ token: preview.token, ...env, binding: foreign }),
    assertCode(409, 'preview-mismatch'),
  )
  // Neither mismatch burnt the token the session itself still owns.
  const confirmed = await confirmPanelAction({ token: preview.token, ...env })
  assert.equal(confirmed.replayed, false)
})

test('an expired preview is refused before any service call', async () => {
  let clock = 1_000_000
  const tokens = createPreviewTokens({ now: () => clock })
  const stub = previewStub()
  const env = panelEnv(stub, { tokens })
  const preview = await previewPanelAction({
    operation: 'compact-hot',
    args: {},
    ...env,
  })
  const calls = stub.calls.length
  clock += PREVIEW_TTL_MS + 1
  await assert.rejects(
    () => confirmPanelAction({ token: preview.token, ...env }),
    assertCode(409, 'preview-expired'),
  )
  assert.equal(stub.calls.length, calls)
})

test('compact-hot previews the current zones and confirms the one compact action', async () => {
  const stub = previewStub()
  const env = panelEnv(stub)
  const preview = await previewPanelAction({ operation: 'compact-hot', args: {}, ...env })
  assert.equal(
    preview.preview.facts.some((fact) => fact.label === '使用'),
    true,
  )
  assert.equal(
    preview.preview.facts.some((fact) => fact.label === '可搬出'),
    true,
  )
  // Above the trigger (7200 > 6030) the promises stay: entries can move, bounded
  // by the eligibility count, and no below-trigger warning is shown.
  assert.equal(
    preview.preview.effects.some((effect) => /本次最多搬出 5 条/u.test(effect)),
    true,
  )
  assert.equal(preview.preview.warning, undefined, 'no warning above the trigger')
  const confirmed = await confirmPanelAction({ token: preview.token, ...env })
  assert.equal(confirmed.result.status, 'compacted')
  assert.equal(confirmed.result.moved, 3)
  assert.equal(confirmed.result.folded, 2)
  // The confirm result carries the numbers the panel's outcome copy needs. Its
  // exact shape is a contract with lib/memory-panel.js, so pin all seven keys.
  assert.deepEqual(Object.keys(confirmed.result).sort(), [
    'capacity',
    'folded',
    'moved',
    'reclaimed',
    'status',
    'trigger',
    'used',
  ])
  assert.equal(confirmed.result.used, 7200)
  assert.equal(confirmed.result.capacity, 9000)
  assert.equal(confirmed.result.trigger, 6030)
  assert.deepEqual(
    stub.calls.map((call) => (call.action === 'hot' ? call.operation : call.action)),
    ['status', 'status', 'compact'],
  )
  assert.equal(stub.state.compacted, true)
})

test('a compact preview below the trigger says no entries will be archived', async () => {
  // Live 2026-10-31: used 5728 < trigger 6030, so lib/hot-archive.js planArchive
  // is a deliberate no-op and the compact reports moved 0 / folded 0 / reclaimed 0
  // while the old preview promised "本次最多搬出 14 条" and showed 可搬出 14 /
  // 可归档 14 — the button looked broken. The preview must say what the planner
  // will actually do: fold legacy per-entry pointer lines, archive nothing.
  const stub = previewStub({
    hot: hotFixture({ used: 5728, trigger: 6030, compactable: 14, archivable: 14 }),
  })
  const env = panelEnv(stub)
  const preview = await previewPanelAction({ operation: 'compact-hot', args: {}, ...env })
  const effects = preview.preview.effects.join('\n')
  assert.equal(/本次最多搬出/u.test(effects), false, 'no move promise below the trigger')
  assert.equal(/指针行/u.test(effects), true, 'folding pointer lines is still what may happen')
  assert.equal(
    preview.preview.effects.some((effect) => /不会搬出/u.test(effect)),
    true,
    'an effect must say nothing is archived',
  )
  const warning = preview.preview.warning
  assert.equal(typeof warning, 'string', 'a below-trigger preview carries a warning')
  assert.match(warning, /5728/u, 'the warning names the current usage')
  assert.match(warning, /6030/u, 'and the trigger it is compared to')
  assert.match(warning, /不会搬出/u, 'and says plainly that nothing will move')
  assert.equal(/仍只会搬出/u.test(warning), false, 'the old half-truth is gone')
  // The confirm path stays open — a below-trigger compact is safe, just a no-op.
  const confirmed = await confirmPanelAction({ token: preview.token, ...env })
  assert.equal(confirmed.replayed, false)
  assert.equal(confirmed.result.status, 'compacted')
})

test('a digest preview tolerates sub-day clock drift but a changed digest is stale', async () => {
  const stub = previewStub()
  const env = panelEnv(stub)
  const preview = await previewPanelAction({
    operation: 'refresh-digest',
    args: { days: 1 },
    ...env,
  })
  assert.equal(
    preview.preview.facts.some((fact) => fact.value === '_meta/digest.md'),
    true,
  )
  // The stub advances the collector clock by 700 ms on every read; the identity
  // is day-granular, so the confirmation still matches.
  const confirmed = await confirmPanelAction({ token: preview.token, ...env })
  assert.equal(confirmed.result.status, 'created')
  assert.equal(confirmed.result.txId, 'tx-digest-1')
  assert.equal(confirmed.result.window.days, 1)
  assert.equal(stub.state.refreshed, true)

  const staleStub = previewStub()
  const staleEnv = panelEnv(staleStub)
  const stalePreview = await previewPanelAction({
    operation: 'refresh-digest',
    args: { days: 1 },
    ...staleEnv,
  })
  staleStub.state.digest = {
    ...staleStub.state.digest,
    notes: { ...staleStub.state.digest.notes, created: 2 },
  }
  await assert.rejects(
    () => confirmPanelAction({ token: stalePreview.token, ...staleEnv }),
    assertCode(409, 'preview-stale'),
  )
  assert.equal(staleStub.state.refreshed, false)
})

test('an English retry preview translates the dialog copy and falls back to Chinese', async () => {
  const preview = await previewPanelAction({
    operation: 'retry-job',
    args: { jobId: JOB_ID },
    ...panelEnv(previewStub()),
    locale: 'en',
  })
  assert.equal(preview.preview.title, 'Retry failed job')
  assert.equal(preview.preview.confirmLabel, 'Retry')
  assert.deepEqual(
    preview.preview.facts.map((fact) => fact.label),
    ['Job', 'Project', 'Status', 'Attempts', 'Failed at', 'Error'],
  )
  assert.equal(preview.preview.facts.find((fact) => fact.label === 'Job').value, JOB_ID)
  assert.deepEqual(preview.preview.effects, [
    'The job re-enters the queue',
    'Attempts reset to zero',
    'Whether it runs immediately depends on the host',
  ])
  assert.match(preview.preview.warning, /DSH/u)
  assert.match(preview.preview.warning, /Codex/u)
  assertNoHan([
    preview.preview.title,
    preview.preview.confirmLabel,
    ...preview.preview.facts.map((fact) => fact.label),
    ...preview.preview.effects,
    preview.preview.warning,
  ])

  // Missing, unsupported and explicit zh locales all keep the source copy: the
  // pre-i18n behaviour is the default, not a special case.
  for (const locale of [undefined, 'fr', 'zh']) {
    const chinese = await previewPanelAction({
      operation: 'retry-job',
      args: { jobId: JOB_ID },
      ...panelEnv(previewStub()),
      locale,
    })
    assert.equal(chinese.preview.title, '重新排队失败任务', String(locale))
    assert.equal(chinese.preview.confirmLabel, '重新排队', String(locale))
  }
})

test('an English hot preview translates zones, effects and the below-trigger warning', async () => {
  const preview = await previewPanelAction({
    operation: 'compact-hot',
    args: {},
    ...panelEnv(previewStub()),
    locale: 'en-US',
  })
  assert.equal(preview.preview.title, 'Compact hot zone')
  assert.equal(preview.preview.confirmLabel, 'Compact')
  assert.deepEqual(preview.preview.facts.slice(0, 4), [
    { label: 'Used', value: '7200 / 9000 code points' },
    { label: 'Trigger', value: '6030 code points' },
    { label: 'Movable', value: '5' },
    { label: 'Archivable', value: '3' },
  ])
  // The fixed zone names are translated; entries and pointers agree in number.
  const completed = preview.preview.facts.find((fact) => fact.label === 'Completed')
  assert.equal(completed?.value, '1 complete entry, 2 pointers, 3 movable')
  assert.equal(
    preview.preview.facts.some((fact) => fact.label === 'In progress'),
    true,
  )
  assert.equal(
    preview.preview.facts.some((fact) => fact.label === 'Strong constraints'),
    true,
  )
  assert.deepEqual(preview.preview.effects, [
    'Moves terminated Completed/In progress entries into the archive',
    'Folds pointer lines in Completed',
    'Moves at most 5 entries this time',
  ])
  assert.equal(preview.preview.warning, undefined, 'no warning above the trigger')
  assertNoHan([
    preview.preview.title,
    preview.preview.confirmLabel,
    ...preview.preview.facts.map((fact) => fact.label),
    ...preview.preview.effects,
  ])

  const below = await previewPanelAction({
    operation: 'compact-hot',
    args: {},
    ...panelEnv(previewStub({ hot: hotFixture({ used: 5728, trigger: 6030 }) })),
    locale: 'en',
  })
  assert.deepEqual(below.preview.effects, [
    'Only folds legacy per-entry pointer lines in Completed',
    'No entries are archived; the archive and sections stay as they are',
  ])
  assert.equal(
    below.preview.warning,
    'The hot zone is below its trigger (5728 / 6030 code points): this compact moves no entries.',
  )
})

test('an English digest preview translates its target, window and effects', async () => {
  const preview = await previewPanelAction({
    operation: 'refresh-digest',
    args: { days: 1 },
    ...panelEnv(previewStub()),
    locale: 'en',
  })
  assert.equal(preview.preview.title, 'Publish project digest')
  assert.equal(preview.preview.confirmLabel, 'Write digest')
  assert.deepEqual(
    preview.preview.facts.map((fact) => fact.label),
    ['Target', 'Project', 'Window', 'Created', 'Updated', 'Sources checked'],
  )
  assert.equal(
    preview.preview.facts.find((fact) => fact.label === 'Target').value,
    '_meta/digest.md',
  )
  assert.equal(preview.preview.facts.find((fact) => fact.label === 'Window').value, 'Last day')
  assert.deepEqual(preview.preview.effects, [
    'Re-collect and render the digest for the window',
    'Writes Projects/demo--11111111/_meta/digest.md',
    'No file is written when the content is unchanged',
  ])
  assert.equal(preview.preview.warning, undefined)
  assertNoHan([
    preview.preview.title,
    preview.preview.confirmLabel,
    ...preview.preview.facts.map((fact) => fact.label),
    ...preview.preview.effects,
  ])

  const wider = await previewPanelAction({
    operation: 'refresh-digest',
    args: { days: 30 },
    ...panelEnv(previewStub()),
    locale: 'en',
  })
  assert.equal(wider.preview.facts.find((fact) => fact.label === 'Window').value, 'Last 30 days')
})

test('previews refuse missing, foreign and non-terminal jobs and a missing hot file', async () => {
  const env = (stub) => panelEnv(stub)
  await assert.rejects(
    () =>
      previewPanelAction({
        operation: 'retry-job',
        args: { jobId: JOB_ID },
        ...env(previewStub({ job: null })),
      }),
    assertCode(409, 'job-missing'),
  )
  await assert.rejects(
    () =>
      previewPanelAction({
        operation: 'retry-job',
        args: { jobId: JOB_ID },
        ...env(previewStub({ job: jobView({ projectId: OTHER_PROJECT_ID }) })),
      }),
    assertCode(409, 'job-foreign'),
  )
  await assert.rejects(
    () =>
      previewPanelAction({
        operation: 'retry-job',
        args: { jobId: JOB_ID },
        ...env(previewStub({ job: jobView({ state: 'distilling' }) })),
      }),
    assertCode(409, 'job-not-retryable'),
  )
  await assert.rejects(
    () =>
      previewPanelAction({
        operation: 'compact-hot',
        args: {},
        ...env(previewStub({ hot: hotFixture({ missing: true }) })),
      }),
    assertCode(409, 'hot-missing'),
  )
  const fallthrough = {
    async admin(args) {
      assert.equal(args.action, 'digest')
      return { action: 'jobs', result: { jobs: [], failed: 0 } }
    },
  }
  await assert.rejects(
    () =>
      previewPanelAction({
        operation: 'refresh-digest',
        args: {},
        sessionId: SESSION,
        binding: BINDING,
        services: fallthrough,
        exec: EXEC,
        tokens: createPreviewTokens(),
        today: '2026-10-27',
      }),
    assertCode(503, 'digest-unavailable'),
  )
})

// ---------------------------------------------------------------------------
// The real service seam: previews read, confirmations write
// ---------------------------------------------------------------------------

test('the service refuses a retry for another project before reviving it', async (t) => {
  const { root, onCleanup } = await temporaryRoot(t, 'obsidian-mem-panel-retry-precondition-')
  const dataRoot = join(root, 'data')
  const home = join(root, 'home')
  await mkdir(dataRoot, { recursive: true })
  await mkdir(home, { recursive: true })
  const binding = { ...BINDING, vaultRoot: join(root, 'vault') }
  const queueRoot = queueRootFor(dataRoot)
  const own = jobView({ jobId: JOB_ID })
  const foreign = jobView({
    jobId: 'job-ffffffffffffffffffffffffffffffff',
    projectId: OTHER_PROJECT_ID,
  })
  await writeJobAtomic(queueRoot, { schema: PENDING_SCHEMA, ...own })
  await writeJobAtomic(queueRoot, { schema: PENDING_SCHEMA, ...foreign })
  const services = createMemoryServices({
    config: validateConfig({ vaultPath: binding.vaultRoot }),
    dataRoot,
    home,
    cwd: root,
    binding,
  })
  // Closed before the tree removal: see `temporaryRoot`.
  onCleanup(async () => services.close?.())

  const refused = await services.admin(
    { action: 'jobs', retry: true, jobId: foreign.jobId, projectId: PROJECT_ID },
    undefined,
    EXEC,
  )
  assert.equal(refused.action, 'jobs')
  assert.equal(refused.result.status, 'refused')
  assert.match(refused.result.message, /does not belong to project/u)
  let jobs = (await readPendingJobs(queueRoot)).jobs
  assert.equal(jobs.find((job) => job.jobId === foreign.jobId).state, 'failed')

  const revived = await services.admin(
    { action: 'jobs', retry: true, jobId: own.jobId, projectId: PROJECT_ID },
    undefined,
    EXEC,
  )
  assert.equal(revived.result.status, 'retried')
  jobs = (await readPendingJobs(queueRoot)).jobs
  assert.equal(jobs.find((job) => job.jobId === own.jobId).state, 'pending')
  assert.equal(jobs.find((job) => job.jobId === own.jobId).attempts, 0)
})

test('real services: the panel retry revives exactly the displayed failed job', async (t) => {
  const { root, onCleanup } = await temporaryRoot(t, 'obsidian-mem-panel-retry-')
  const dataRoot = join(root, 'data')
  const home = join(root, 'home')
  await mkdir(dataRoot, { recursive: true })
  await mkdir(home, { recursive: true })
  const binding = { ...BINDING, vaultRoot: join(root, 'vault') }
  const queueRoot = queueRootFor(dataRoot)
  await writeJobAtomic(queueRoot, { schema: PENDING_SCHEMA, ...jobView() })
  const services = createMemoryServices({
    config: validateConfig({ vaultPath: binding.vaultRoot }),
    dataRoot,
    home,
    cwd: root,
    binding,
  })
  // Closed before the tree removal: see `temporaryRoot`.
  onCleanup(async () => services.close?.())
  const env = panelEnv({ services })
  const preview = await previewPanelAction({
    operation: 'retry-job',
    args: { jobId: JOB_ID },
    ...env,
  })
  let jobs = (await readPendingJobs(queueRoot)).jobs
  assert.equal(jobs[0].state, 'failed', 'preview did not write')
  const confirmed = await confirmPanelAction({ token: preview.token, ...env })
  assert.equal(confirmed.result.status, 'retried')
  jobs = (await readPendingJobs(queueRoot)).jobs
  assert.equal(jobs[0].state, 'pending')
  assert.equal(jobs[0].attempts, 0)
})

test('real services: a digest preview writes nothing and its confirmation publishes once', async (t) => {
  const { root, onCleanup } = await temporaryRoot(t, 'obsidian-mem-panel-digest-action-')
  const dataRoot = join(root, 'data')
  const home = join(root, 'home')
  const vault = join(root, 'vault')
  await mkdir(dataRoot, { recursive: true })
  await mkdir(home, { recursive: true })
  const binding = { ...BINDING, vaultRoot: vault }
  await bootstrapVault(binding, { dataRoot, home })
  await writeMemory(
    binding,
    {
      type: 'decision',
      title: 'Panel digest action',
      assertion: 'observed',
      body: 'A note with a [[missing-panel-action-target]] link.',
    },
    { dataRoot, home },
  )
  const services = createMemoryServices({
    config: validateConfig({ vaultPath: vault }),
    dataRoot,
    home,
    cwd: root,
    binding,
  })
  // Closed before the tree removal: see `temporaryRoot`.
  onCleanup(async () => services.close?.())
  const exec = { agent: { session: { header: { id: SESSION, cwd: root } } } }
  const env = {
    sessionId: SESSION,
    binding,
    services,
    exec,
    tokens: createPreviewTokens(),
    today: localDate(),
  }
  const target = join(vault, binding.relativeDir, '_meta', 'digest.md')
  const preview = await previewPanelAction({
    operation: 'refresh-digest',
    args: { days: 1 },
    ...env,
  })
  assert.equal(existsSync(target), false, 'preview must not create the owned note')
  assert.equal(
    preview.preview.facts.some((fact) => fact.value === '_meta/digest.md'),
    true,
  )
  const confirmed = await confirmPanelAction({ token: preview.token, ...env })
  assert.equal(confirmed.result.status, 'created')
  assert.equal(existsSync(target), true)
  const text = await readFile(target, 'utf8')
  assert.match(text, /generated_by: dsh-obsidian-mem/u)
  const replay = await confirmPanelAction({ token: preview.token, ...env })
  assert.equal(replay.replayed, true)
  assert.deepEqual(replay.result, confirmed.result)

  const secondPreview = await previewPanelAction({
    operation: 'refresh-digest',
    args: { days: 1 },
    ...env,
  })
  const unchanged = await confirmPanelAction({ token: secondPreview.token, ...env })
  assert.equal(unchanged.result.status, 'unchanged')
  assert.equal(unchanged.result.txId, null)
})
