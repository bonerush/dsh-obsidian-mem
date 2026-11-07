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
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { validateConfig } from '../lib/config.js'
import { EXECUTABLE_OPERATIONS } from '../lib/curation-review.js'
import { writeMemory } from '../lib/memory.js'
import { localDate } from '../lib/note-health.js'
import { PENDING_SCHEMA, queueRootFor, readPendingJobs, writeJobAtomic } from '../lib/pending.js'
import {
  EXECUTABLE_OPERATION_KINDS,
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
// The review-proposal fixtures: a pending supersede candidate served by a stub
// service set whose `reviewDetail`/`reviewDecision` are the frozen Task-1 contract
// ---------------------------------------------------------------------------

/** A 64-character lowercase hex proposal id, as the store mints them. */
const PROPOSAL_ID = 'a'.repeat(64)
const PROPOSAL_TARGET_PATH = 'Projects/demo--11111111/Decisions/old-decision.md'

/** One stored source with its re-read hash facts. */
function proposalSource(overrides = {}) {
  return {
    path: PROPOSAL_TARGET_PATH,
    hash: '1'.repeat(64),
    currentHash: '1'.repeat(64),
    matched: true,
    missing: false,
    ...overrides,
  }
}

/** The detail shape `services.reviewDetail` answers (frozen in the task brief). */
function proposalDetail(overrides = {}) {
  return {
    proposalId: PROPOSAL_ID,
    kind: 'supersede',
    state: 'pending',
    reason: 'a newer note covers this decision',
    reviewOnly: false,
    itemKey: 'session-1:2:0',
    createdAt: '2026-11-06T10:00:00.000Z',
    sources: [proposalSource()],
    operation: {
      kind: 'supersede',
      title: 'Panel review candidate',
      body: '# Candidate\n\nThe body that will be written.\n',
      bodyTruncated: false,
      supersedesId: 'dec-1234',
      target: {
        path: PROPOSAL_TARGET_PATH,
        title: 'Old decision',
        status: 'active',
        body: 'The old body that this candidate supersedes.',
        bodyTruncated: false,
      },
    },
    ...overrides,
  }
}

/** A pending create-separate candidate: a near-duplicate that becomes its own note. */
function createSeparateDetail(overrides = {}) {
  return proposalDetail({
    kind: 'near-duplicate',
    operation: {
      kind: 'create-separate',
      title: 'Panel separate candidate',
      body: 'The separate note body.',
      bodyTruncated: false,
      supersedesId: null,
      target: null,
    },
    ...overrides,
  })
}

/** A review-only finding: evidence with no executable operation. */
function reviewOnlyDetail(overrides = {}) {
  return proposalDetail({
    kind: 'dead-wikilink',
    reviewOnly: true,
    operation: null,
    ...overrides,
  })
}

/**
 * A stub of the three frozen review-service methods.
 *
 * It records every read and every decision and lets a case move the stored detail
 * between the preview and the confirmation, which is how the staleness branch is
 * driven without a vault.
 */
function reviewStub({ detail = proposalDetail(), decision, failure } = {}) {
  const calls = { details: [], decisions: [], admin: [] }
  let current = detail
  const services = {
    // The real service set always has `admin`; these cases must never reach it.
    async admin(args) {
      calls.admin.push({ ...args })
      throw new Error('unexpected admin call ' + JSON.stringify(args))
    },
    async reviewDetail(binding, proposalId) {
      calls.details.push({ binding, proposalId })
      if (current === null || current.proposalId !== proposalId) {
        const missing = new Error('no proposal ' + proposalId + ' exists for this project')
        missing.code = 'proposal-missing'
        missing.status = 404
        throw missing
      }
      return current
    },
    async reviewDecision(binding, proposalId, action, reviewer) {
      calls.decisions.push({ binding, proposalId, decision: action, reviewer })
      if (failure !== undefined) throw failure
      if (decision !== undefined) return decision
      current = { ...current, state: action === 'apply' ? 'applied' : 'rejected' }
      return action === 'apply'
        ? { status: 'applied', receipt: { path: 'Projects/demo--11111111/Decisions/new-note.md' } }
        : { status: 'rejected' }
    },
  }
  return {
    services,
    calls,
    setDetail(next) {
      current = next
    },
  }
}

/** The exact UTF-8 size of the wire answer the route sends for one preview. */
function previewWireBytes(issued) {
  return Buffer.byteLength(
    JSON.stringify({
      ok: true,
      value: {
        mutation: issued.operation,
        token: issued.token,
        expiresAt: issued.expiresAt,
        preview: issued.preview,
      },
    }),
    'utf8',
  )
}

/** The exact UTF-8 size of the wire answer the route sends for one confirmation. */
function confirmWireBytes(confirmed) {
  return Buffer.byteLength(
    JSON.stringify({
      ok: true,
      value: {
        mutation: confirmed.operation,
        result: confirmed.result,
        replayed: confirmed.replayed,
      },
    }),
    'utf8',
  )
}

/** The Markdown body section of a preview document, cut out for length checks. */
function candidateSectionOf(markdown) {
  return markdown.split('## 候选正文\n\n')[1].split('\n\n## 来源')[0]
}

// ---------------------------------------------------------------------------
// The vocabulary and the argument contract
// ---------------------------------------------------------------------------

test('the confirmed operation vocabulary grows by exactly the two review decisions', () => {
  assert.deepEqual(
    [...PANEL_MUTATIONS],
    ['retry-job', 'compact-hot', 'refresh-digest', 'apply-proposal', 'reject-proposal'],
  )
  for (const forbidden of [
    'lint',
    'index',
    'bind',
    'curation',
    'promote',
    'digest',
    'hot',
    'apply',
    'reject',
    'retire',
  ])
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

test('the panel executable kinds match the store review contract exactly', () => {
  // lib/panel-actions.js cannot import lib/curation-review.js (layer 1 vs layer 6), so
  // the executable-kind list is a deliberate duplicate. If the store ever adds or
  // renames an executable operation this pin fails, instead of the panel silently
  // refusing a legitimate preview with `operation-not-executable`.
  assert.deepEqual([...EXECUTABLE_OPERATION_KINDS], [...EXECUTABLE_OPERATIONS])
})

test('the two review mutations accept exactly a 64-character lowercase hex proposal id', () => {
  for (const operation of ['apply-proposal', 'reject-proposal']) {
    assert.deepEqual(
      { ...normalizePanelArgs(operation, { proposalId: PROPOSAL_ID }) },
      {
        proposalId: PROPOSAL_ID,
      },
    )
    for (const bad of [
      undefined,
      {},
      { proposalId: '' },
      { proposalId: 'a'.repeat(63) },
      { proposalId: 'a'.repeat(65) },
      { proposalId: 'A'.repeat(64) },
      { proposalId: 'g'.repeat(64) },
      { proposalId: ' ' + PROPOSAL_ID },
      { proposalId: PROPOSAL_ID + '\n' },
      { proposalId: '0x' + 'a'.repeat(62) },
      { proposalId: 42 },
      { proposalId: null },
      { proposalId: ['a'] },
      { proposalId: PROPOSAL_ID, days: 1 },
      { jobId: PROPOSAL_ID.replaceAll('a', '0') },
    ])
      assert.throws(
        () => normalizePanelArgs(operation, bad),
        RangeError,
        operation + ' ' + JSON.stringify(bad),
      )
  }
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
// The review-proposal mutations: preview a bounded Markdown document, then decide
// ---------------------------------------------------------------------------

test('an apply preview renders the candidate body, sources and supersede effect', async () => {
  const stub = reviewStub()
  const env = panelEnv(stub)
  const preview = await previewPanelAction({
    operation: 'apply-proposal',
    args: { proposalId: PROPOSAL_ID },
    ...env,
  })
  assert.equal(preview.operation, 'apply-proposal')
  assert.equal(preview.projectId, PROJECT_ID)
  assert.match(preview.token, /^[A-Za-z0-9_-]{40,}$/u)
  assert.equal(preview.preview.title, '批准候补记忆')
  assert.equal(preview.preview.confirmLabel, '批准')
  assert.deepEqual(
    preview.preview.facts.map((fact) => fact.label),
    ['类型', '状态', '理由', '来源', '目标'],
  )
  assert.deepEqual(
    preview.preview.facts.map((fact) => fact.value),
    [
      '取代',
      '待审阅',
      'a newer note covers this decision',
      '1 个来源，其中 1 个匹配',
      PROPOSAL_TARGET_PATH,
    ],
  )
  assert.equal(
    preview.preview.effects.some((effect) => /superseded/u.test(effect)),
    true,
  )
  assert.equal(
    preview.preview.effects.some((effect) => effect.includes(PROPOSAL_TARGET_PATH)),
    true,
  )
  assert.match(preview.preview.warning, /superseded/u)
  const markdown = preview.preview.markdown
  assert.equal(typeof markdown, 'string')
  assert.match(markdown, /^# Panel review candidate\n/u)
  assert.match(markdown, /> 类型：取代 · 状态：待审阅 · 创建于：2026-11-06T10:00:00\.000Z/u)
  assert.match(markdown, /理由：a newer note covers this decision/u)
  assert.match(
    markdown,
    /\n## 候选正文\n\n# Candidate\n\nThe body that will be written\.\n\n## 来源\n/u,
    'the candidate body is embedded verbatim, never escaped or fenced',
  )
  assert.match(markdown, /\n- ✔ Projects\/demo--11111111\/Decisions\/old-decision\.md — 匹配\n/u)
  assert.match(
    markdown,
    /\n## 影响\n\n目标笔记 Projects\/demo--11111111\/Decisions\/old-decision\.md 的状态从 active 改为 superseded/u,
  )
  assert.match(
    markdown,
    /确认是唯一写入点/u,
    'the footer names the two decisions and the one write',
  )
  assert.equal(stub.calls.decisions.length, 0, 'a preview never decides')
  assert.deepEqual(
    stub.calls.details,
    [{ binding: BINDING, proposalId: PROPOSAL_ID }],
    'reviewDetail is called binding-first, exactly as the frozen contract says',
  )
  assert.equal(stub.calls.admin.length, 0)
  assert.ok(previewWireBytes(preview) <= 8 * 1024, 'a preview answer fits its 8 KiB ceiling')
})

test('a reject preview promises no note write and a review-only row can be dismissed', async () => {
  const stub = reviewStub()
  const env = panelEnv(stub)
  const preview = await previewPanelAction({
    operation: 'reject-proposal',
    args: { proposalId: PROPOSAL_ID },
    ...env,
  })
  assert.equal(preview.preview.title, '拒绝候补记忆')
  assert.equal(preview.preview.confirmLabel, '拒绝')
  assert.equal(
    preview.preview.effects.some((effect) => /不写入/u.test(effect)),
    true,
  )
  assert.match(preview.preview.markdown, /拒绝只会更新候补记录；批准才会写入候选/u)
  assert.match(preview.preview.markdown, /## 候选正文/u, 'a rejection shows what is being rejected')

  const reviewOnly = reviewStub({ detail: reviewOnlyDetail() })
  const dismissed = await previewPanelAction({
    operation: 'reject-proposal',
    args: { proposalId: PROPOSAL_ID },
    ...panelEnv(reviewOnly),
  })
  assert.equal(dismissed.preview.facts.find((fact) => fact.label === '类型').value, '死链接')
  assert.equal(
    dismissed.preview.facts.some((fact) => fact.label === '目标'),
    false,
    'a review-only row has no supersede target',
  )
  assert.match(dismissed.preview.markdown, /只读发现只能拒绝/u)
  assert.match(dismissed.preview.markdown, /不写入任何笔记/u)
  assert.doesNotMatch(
    dismissed.preview.markdown,
    /^# Candidate/mu,
    'a review-only row carries no candidate body',
  )
})

test('previews refuse a missing, decided or review-only apply', async () => {
  const missing = reviewStub({ detail: null })
  await assert.rejects(
    () =>
      previewPanelAction({
        operation: 'apply-proposal',
        args: { proposalId: PROPOSAL_ID },
        ...panelEnv(missing),
      }),
    assertCode(404, 'proposal-missing'),
  )
  for (const state of ['applied', 'rejected', 'retired']) {
    const decided = reviewStub({ detail: proposalDetail({ state }) })
    await assert.rejects(
      () =>
        previewPanelAction({
          operation: 'apply-proposal',
          args: { proposalId: PROPOSAL_ID },
          ...panelEnv(decided),
        }),
      assertCode(409, 'proposal-not-current'),
      state,
    )
  }
  const reviewOnly = reviewStub({ detail: reviewOnlyDetail() })
  await assert.rejects(
    () =>
      previewPanelAction({
        operation: 'apply-proposal',
        args: { proposalId: PROPOSAL_ID },
        ...panelEnv(reviewOnly),
      }),
    (error) => {
      assert.equal(error.code, 'review-only')
      assert.equal(error.status, 409)
      assert.match(error.message, /只能拒绝|review-only/u)
      return true
    },
  )
  // A record with no operation is review-only evidence even when the flag is stale.
  const noOperation = reviewStub({ detail: proposalDetail({ operation: null }) })
  await assert.rejects(
    () =>
      previewPanelAction({
        operation: 'apply-proposal',
        args: { proposalId: PROPOSAL_ID },
        ...panelEnv(noOperation),
      }),
    assertCode(409, 'review-only'),
  )
})

test('a contradictory reviewOnly flag follows the executable operation, not the flag', async () => {
  // A hand-edited/corrupt record can carry `reviewOnly: true` beside a valid
  // executable operation. The operation is the authority (the same single rule the
  // service derives the flag from), so the sheet must promise what apply will do —
  // never the record-only footer it would show for a real read-only finding.
  const stub = reviewStub({ detail: proposalDetail({ reviewOnly: true }) })
  const preview = await previewPanelAction({
    operation: 'apply-proposal',
    args: { proposalId: PROPOSAL_ID },
    ...panelEnv(stub),
  })
  const markdown = preview.preview.markdown
  assert.match(markdown, /## 候选正文/u)
  assert.match(markdown, /改为 superseded/u, 'the effect follows the supersede operation')
  assert.doesNotMatch(markdown, /只读发现只是证据/u, 'never claim a no-write finding')
  assert.match(
    markdown,
    /确认是唯一写入点：批准会写入候选/u,
    'the apply footer, not the review-only one',
  )
  assert.equal(
    preview.preview.effects.some((effect) => /superseded/u.test(effect)),
    true,
    'the sheet effects follow the operation',
  )
})

test('a create-separate candidate previews and confirms as a separate new note', async () => {
  const stub = reviewStub({ detail: createSeparateDetail() })
  const env = panelEnv(stub)
  const preview = await previewPanelAction({
    operation: 'apply-proposal',
    args: { proposalId: PROPOSAL_ID },
    ...env,
  })
  assert.equal(preview.preview.facts.find((fact) => fact.label === '类型').value, '近似重复')
  assert.equal(
    preview.preview.effects.join('\n').includes('独立的新笔记'),
    true,
    'the effect says a separate note is written',
  )
  assert.equal(preview.preview.warning, undefined, 'only a supersede writes a warning')
  const markdown = preview.preview.markdown
  assert.match(markdown, /^# Panel separate candidate\n/u)
  assert.match(markdown, /\n## 影响\n\n候选作为一篇独立的新笔记写入 vault\n不改动任何已有笔记/u)
  assert.doesNotMatch(markdown, /目标笔记当前正文摘录/u, 'no create-separate target excerpt')
  assert.doesNotMatch(markdown, /改为 superseded/u, 'nothing is superseded')
  assert.match(markdown, /确认是唯一写入点：批准会写入候选/u)
  assert.equal(stub.calls.details[0].binding, BINDING, 'the read is binding-first')

  const confirmed = await confirmPanelAction({ token: preview.token, ...env })
  assert.deepEqual(confirmed.result, {
    status: 'applied',
    proposalId: PROPOSAL_ID,
    path: 'Projects/demo--11111111/Decisions/new-note.md',
    reviewOnly: false,
  })
  assert.deepEqual(stub.calls.decisions, [
    { binding: BINDING, proposalId: PROPOSAL_ID, decision: 'apply', reviewer: { kind: 'human' } },
  ])
})

test('an English proposal preview translates every string and keeps the body bytes', async () => {
  const stub = reviewStub()
  const preview = await previewPanelAction({
    operation: 'apply-proposal',
    args: { proposalId: PROPOSAL_ID },
    ...panelEnv(stub),
    locale: 'en',
  })
  assert.equal(preview.preview.title, 'Approve candidate memory')
  assert.equal(preview.preview.confirmLabel, 'Approve')
  assert.deepEqual(
    preview.preview.facts.map((fact) => fact.label),
    ['Kind', 'State', 'Reason', 'Sources', 'Target'],
  )
  assert.equal(preview.preview.facts[0].value, 'Replace')
  assert.equal(preview.preview.facts[3].value, '1 source, 1 matching')
  assertNoHan([
    preview.preview.title,
    preview.preview.confirmLabel,
    ...preview.preview.facts.map((fact) => fact.label),
    ...preview.preview.facts.map((fact) => fact.value),
    ...preview.preview.effects,
    preview.preview.warning,
    preview.preview.markdown,
  ])
  // The note's own bytes are never translated; only the framing around them is.
  assert.match(preview.preview.markdown, /^# Panel review candidate\n/u)
  assert.match(
    preview.preview.markdown,
    /\n## Candidate body\n\n# Candidate\n\nThe body that will be written\.\n/u,
  )
})

test('the preview refuses an operation this build cannot execute', async () => {
  // A corrupt or foreign record may carry a kind the decision path never executes.
  // The sheet must not promise an effect the confirmation cannot perform.
  const foreign = reviewStub({
    detail: proposalDetail({
      operation: {
        kind: 'rewrite-everything',
        title: 'Foreign candidate',
        body: 'The body it will not write.\n',
        bodyTruncated: false,
        supersedesId: null,
        target: null,
      },
    }),
  })
  await assert.rejects(
    () =>
      previewPanelAction({
        operation: 'apply-proposal',
        args: { proposalId: PROPOSAL_ID },
        ...panelEnv(foreign),
      }),
    (error) => {
      assert.equal(error.code, 'operation-not-executable')
      assert.equal(error.status, 409)
      assert.match(error.message, /cannot apply/u)
      return true
    },
  )
  // A rejection is still legal: the store allows dismissing a pending record.
  const rejection = await previewPanelAction({
    operation: 'reject-proposal',
    args: { proposalId: PROPOSAL_ID },
    ...panelEnv(foreign),
  })
  assert.match(rejection.preview.markdown, /只把候补记录标记为已拒绝/u)

  // A non-plain operation (an array) is not an operation at all: the single
  // review-only rule refuses apply instead of promising a candidate write.
  const corrupt = reviewStub({ detail: proposalDetail({ operation: [] }) })
  await assert.rejects(
    () =>
      previewPanelAction({
        operation: 'apply-proposal',
        args: { proposalId: PROPOSAL_ID },
        ...panelEnv(corrupt),
      }),
    assertCode(409, 'review-only'),
  )
  const corruptRejection = await previewPanelAction({
    operation: 'reject-proposal',
    args: { proposalId: PROPOSAL_ID },
    ...panelEnv(corrupt),
  })
  assert.doesNotMatch(corruptRejection.preview.markdown, /候选正文/u)
  assert.match(corruptRejection.preview.markdown, /不写入任何笔记/u)
})

test('confirm applies the proposal once and a replay returns the recorded result', async () => {
  const stub = reviewStub()
  const env = panelEnv(stub)
  const preview = await previewPanelAction({
    operation: 'apply-proposal',
    args: { proposalId: PROPOSAL_ID },
    ...env,
  })
  const confirmed = await confirmPanelAction({ token: preview.token, ...env })
  assert.equal(confirmed.replayed, false)
  assert.equal(confirmed.operation, 'apply-proposal')
  assert.deepEqual(confirmed.result, {
    status: 'applied',
    proposalId: PROPOSAL_ID,
    path: 'Projects/demo--11111111/Decisions/new-note.md',
    reviewOnly: false,
  })
  assert.deepEqual(stub.calls.decisions, [
    {
      binding: BINDING,
      proposalId: PROPOSAL_ID,
      decision: 'apply',
      reviewer: { kind: 'human' },
    },
  ])
  const replay = await confirmPanelAction({ token: preview.token, ...env })
  assert.equal(replay.replayed, true)
  assert.deepEqual(replay.result, confirmed.result)
  assert.equal(stub.calls.decisions.length, 1, 'a replay never decides twice')
  assert.equal(stub.calls.admin.length, 0)
})

test('a review-only decision confirms as a record-only rejection with no path', async () => {
  const stub = reviewStub({ detail: reviewOnlyDetail() })
  const env = panelEnv(stub)
  const preview = await previewPanelAction({
    operation: 'reject-proposal',
    args: { proposalId: PROPOSAL_ID },
    ...env,
  })
  const confirmed = await confirmPanelAction({ token: preview.token, ...env })
  assert.deepEqual(confirmed.result, {
    status: 'rejected',
    proposalId: PROPOSAL_ID,
    path: null,
    reviewOnly: true,
  })
  assert.deepEqual(stub.calls.decisions, [
    {
      binding: BINDING,
      proposalId: PROPOSAL_ID,
      decision: 'reject',
      reviewer: { kind: 'human' },
    },
  ])
  assert.ok(confirmWireBytes(confirmed) <= 8 * 1024, 'a confirm answer fits its 8 KiB ceiling')
})

test('the confirm result forwards a bounded relative path and never an absolute one', async () => {
  const longPath =
    homedir() +
    '/Documents/knowledge/Projects/demo--11111111/Decisions/' +
    'x'.repeat(2_000) +
    '.md'
  const stub = reviewStub({
    decision: { status: 'applied', receipt: { path: longPath } },
  })
  const env = panelEnv(stub)
  const preview = await previewPanelAction({
    operation: 'apply-proposal',
    args: { proposalId: PROPOSAL_ID },
    ...env,
  })
  const confirmed = await confirmPanelAction({ token: preview.token, ...env })
  assert.equal(confirmed.result.status, 'applied')
  assert.equal(typeof confirmed.result.path, 'string')
  assert.ok(
    [...confirmed.result.path].length <= 240,
    'the receipt path is clipped to 240 codepoints',
  )
  assert.equal(
    confirmed.result.path.includes(homedir()),
    false,
    'no absolute home path reaches the wire',
  )
  assert.match(confirmed.result.path, /^~\/Documents\/knowledge\//u)
  assert.equal(confirmed.result.reviewOnly, false)
  assert.ok(
    confirmWireBytes(confirmed) <= 8 * 1024,
    'a bounded confirm answer fits its 8 KiB ceiling',
  )
})

test('a proposal that moved or vanished between preview and confirm is preview-stale', async () => {
  const stub = reviewStub()
  const env = panelEnv(stub)
  const first = await previewPanelAction({
    operation: 'apply-proposal',
    args: { proposalId: PROPOSAL_ID },
    ...env,
  })
  stub.setDetail(proposalDetail({ state: 'applied' }))
  await assert.rejects(
    () => confirmPanelAction({ token: first.token, ...env }),
    assertCode(409, 'preview-stale'),
  )
  assert.equal(stub.calls.decisions.length, 0)

  // A stored source re-hash alone moves the fingerprint even when the state string stays.
  const hashMoved = reviewStub()
  const hashEnv = panelEnv(hashMoved)
  const second = await previewPanelAction({
    operation: 'reject-proposal',
    args: { proposalId: PROPOSAL_ID },
    ...hashEnv,
  })
  hashMoved.setDetail(
    proposalDetail({
      sources: [proposalSource({ hash: '2'.repeat(64), currentHash: '2'.repeat(64) })],
    }),
  )
  await assert.rejects(
    () => confirmPanelAction({ token: second.token, ...hashEnv }),
    assertCode(409, 'preview-stale'),
  )
  assert.equal(hashMoved.calls.decisions.length, 0)

  // A record deleted after the preview is a moved state, not a second 404.
  const gone = reviewStub()
  const goneEnv = panelEnv(gone)
  const third = await previewPanelAction({
    operation: 'reject-proposal',
    args: { proposalId: PROPOSAL_ID },
    ...goneEnv,
  })
  gone.setDetail(null)
  await assert.rejects(
    () => confirmPanelAction({ token: third.token, ...goneEnv }),
    assertCode(409, 'preview-stale'),
  )
  assert.equal(gone.calls.decisions.length, 0)
})

test('a refused decision keeps its code and status, and an unknown refusal is 503', async () => {
  const table = [
    ['proposal-missing', 404],
    ['proposal-not-current', 409],
    ['review-only', 409],
    ['source-changed', 409],
    ['review-recovery-required', 409],
    ['proposal-unreadable', 409],
    // A record whose operation this build cannot execute is a conflict, not an
    // outage: the frozen "otherwise unavailable" row would hide the real cause.
    ['operation-not-executable', 409],
  ]
  for (const [code, status] of table) {
    const stub = reviewStub({
      decision: { status: 'refused', code, message: 'refused by the service' },
    })
    const env = panelEnv(stub)
    const preview = await previewPanelAction({
      operation: 'apply-proposal',
      args: { proposalId: PROPOSAL_ID },
      ...env,
    })
    await assert.rejects(
      () => confirmPanelAction({ token: preview.token, ...env }),
      (error) => {
        assert.equal(error.code, code)
        assert.equal(error.status, status)
        assert.equal(error.message, 'refused by the service')
        return true
      },
      code,
    )
    assert.equal(stub.calls.decisions.length, 1)
  }
  for (const decision of [
    { status: 'refused', code: 'queue-lock-timeout', message: 'an unregistered code' },
    { status: 'refused', code: undefined, message: 'no code' },
    { status: 'confused' },
    null,
  ]) {
    const stub = reviewStub({ decision })
    const env = panelEnv(stub)
    const preview = await previewPanelAction({
      operation: 'reject-proposal',
      args: { proposalId: PROPOSAL_ID },
      ...env,
    })
    await assert.rejects(
      () => confirmPanelAction({ token: preview.token, ...env }),
      assertCode(503, 'unavailable'),
      JSON.stringify(decision),
    )
  }
})

test('a thrown decision error maps by its code, and an unknown throw is unavailable', async () => {
  const coded = Object.assign(new Error('a source changed under the decision'), {
    code: 'source-changed',
    status: 409,
  })
  const codedStub = reviewStub({ failure: coded })
  const codedEnv = panelEnv(codedStub)
  const codedPreview = await previewPanelAction({
    operation: 'apply-proposal',
    args: { proposalId: PROPOSAL_ID },
    ...codedEnv,
  })
  await assert.rejects(
    () => confirmPanelAction({ token: codedPreview.token, ...codedEnv }),
    (error) => {
      assert.equal(error.code, 'source-changed')
      assert.equal(error.status, 409)
      return true
    },
  )
  // The failed token is released so the same sheet can be confirmed again.
  await assert.rejects(
    () => confirmPanelAction({ token: codedPreview.token, ...codedEnv }),
    assertCode(409, 'source-changed'),
  )
  assert.equal(codedStub.calls.decisions.length, 2)

  const unknownStub = reviewStub({ failure: new Error('the store exploded') })
  const unknownEnv = panelEnv(unknownStub)
  const unknownPreview = await previewPanelAction({
    operation: 'reject-proposal',
    args: { proposalId: PROPOSAL_ID },
    ...unknownEnv,
  })
  await assert.rejects(
    () => confirmPanelAction({ token: unknownPreview.token, ...unknownEnv }),
    (error) => {
      assert.equal(error.code, 'unavailable')
      assert.equal(error.status, 503)
      assert.doesNotMatch(error.message, /exploded/u, 'an unknown fault leaks no internals')
      return true
    },
  )
})

test('a long candidate body is clipped with an explicit marker inside both ceilings', async () => {
  const longBody = 'A'.repeat(20_000)
  const bigTarget = 'B'.repeat(4_000)
  const detail = proposalDetail({
    operation: {
      kind: 'supersede',
      title: 'Big candidate',
      body: longBody,
      bodyTruncated: false,
      supersedesId: 'dec-1234',
      target: {
        path: PROPOSAL_TARGET_PATH,
        title: 'Old decision',
        status: 'active',
        body: bigTarget,
        bodyTruncated: false,
      },
    },
    sources: [
      proposalSource({ path: 'Projects/demo--11111111/Decisions/' + 'x'.repeat(300) + '.md' }),
    ],
  })
  const stub = reviewStub({ detail })
  const preview = await previewPanelAction({
    operation: 'apply-proposal',
    args: { proposalId: PROPOSAL_ID },
    ...panelEnv(stub),
  })
  const markdown = preview.preview.markdown
  assert.ok(markdown.length <= 24_000, 'document <= 24000 chars: ' + markdown.length)
  assert.ok(previewWireBytes(preview) <= 8 * 1024, 'preview answer <= 8 KiB')
  assert.match(markdown, /…（已截断）/u, 'a clipped body says so')
  const section = candidateSectionOf(markdown)
  assert.ok(
    [...section].length <= 5_500 + [...'…（已截断）'].length,
    'the candidate body keeps its 5500-character cap: ' + section.length,
  )
  assert.match(markdown, /B{100}/u, 'the target excerpt survives a long candidate')
  const targetSection = markdown.split('## 影响\n\n')[1]
  assert.match(targetSection, /目标笔记当前正文摘录/u)
})

test('a CJK candidate body is trimmed by bytes before the target body is touched', async () => {
  const candidate = '中'.repeat(4_000)
  const targetBody = '目标正文'.repeat(200)
  const detail = proposalDetail({
    operation: {
      kind: 'supersede',
      title: '中文候选',
      body: candidate,
      bodyTruncated: false,
      supersedesId: 'dec-1234',
      target: {
        path: PROPOSAL_TARGET_PATH,
        title: '旧决定',
        status: 'active',
        body: targetBody,
        bodyTruncated: false,
      },
    },
  })
  const stub = reviewStub({ detail })
  const preview = await previewPanelAction({
    operation: 'apply-proposal',
    args: { proposalId: PROPOSAL_ID },
    ...panelEnv(stub),
  })
  const markdown = preview.preview.markdown
  assert.ok(previewWireBytes(preview) <= 8 * 1024, 'a CJK body cannot overflow the wire ceiling')
  const section = candidateSectionOf(markdown)
  assert.ok(
    [...section].length < 3_000,
    'the candidate body is trimmed far below its character cap to fit bytes: ' + section.length,
  )
  assert.match(markdown, /…（已截断）/u)
  assert.match(markdown, new RegExp(targetBody.slice(0, 40), 'u'), 'the target excerpt survives')
})

test('an unterminated candidate fence is closed before the document framing', async () => {
  // The sheet's renderer treats every line starting with ``` as a fence toggle, so an
  // odd fence count in the candidate would swallow the source/effect/footer framing
  // into a code block. The host appends one closing fence line; body bytes otherwise
  // stay untouched.
  const unterminated = '# 标题\n\n说明\n\n```js\nconst unfinished = 1\n'
  const detail = proposalDetail({
    operation: {
      kind: 'supersede',
      title: '围栏候选',
      body: unterminated,
      bodyTruncated: false,
      supersedesId: 'dec-1234',
      target: {
        path: PROPOSAL_TARGET_PATH,
        title: 'Old decision',
        status: 'active',
        body: 'old body',
        bodyTruncated: false,
      },
    },
  })
  const preview = await previewPanelAction({
    operation: 'apply-proposal',
    args: { proposalId: PROPOSAL_ID },
    ...panelEnv(reviewStub({ detail })),
  })
  const markdown = preview.preview.markdown
  const lines = markdown.split('\n')
  const fences = lines.filter((line) => line.startsWith('```'))
  assert.equal(fences.length % 2, 0, 'the assembled document carries balanced fences')
  let inCode = false
  const framed = []
  for (const line of lines) {
    if (line.startsWith('```')) {
      inCode = !inCode
      continue
    }
    if (inCode && /^## (?:来源|影响)$/u.test(line)) framed.push(line)
    if (inCode && line.startsWith('确认是唯一写入点')) framed.push(line)
    if (inCode && line.startsWith('目标笔记当前正文摘录')) framed.push(line)
  }
  assert.deepEqual(framed, [], 'no host framing line renders inside the candidate code block')
  assert.equal(inCode, false, 'the document ends outside every fence')
  assert.match(
    markdown,
    /## 候选正文\n\n# 标题\n\n说明\n\n```js\nconst unfinished = 1\n```\n\n## 来源/u,
    'the one appended line closes the body fence without rewriting the body',
  )

  // A balanced body gains no extra fence: only the two the note itself carries.
  const balanced = proposalDetail({
    operation: {
      ...proposalDetail().operation,
      body: 'before\n\n```\ncode\n```\n',
    },
  })
  const balancedPreview = await previewPanelAction({
    operation: 'apply-proposal',
    args: { proposalId: PROPOSAL_ID },
    ...panelEnv(reviewStub({ detail: balanced })),
  })
  const balancedMarkdown = balancedPreview.preview.markdown
  assert.equal(
    balancedMarkdown.split('\n').filter((line) => line.startsWith('```')).length,
    2,
    'a balanced body keeps exactly its own fences',
  )
  assert.match(balancedMarkdown, /```\ncode\n```\n\n## 来源/u)
})

test('a record with no sources renders the explicit no-sources line', async () => {
  const detail = proposalDetail({ sources: [] })
  const preview = await previewPanelAction({
    operation: 'apply-proposal',
    args: { proposalId: PROPOSAL_ID },
    ...panelEnv(reviewStub({ detail })),
  })
  assert.match(
    preview.preview.markdown,
    /## 来源\n\n（没有记录来源）\n/u,
    'an empty source list says so instead of rendering a blank section',
  )
  assert.equal(
    preview.preview.facts.find((fact) => fact.label === '来源').value,
    '0 个来源，其中 0 个匹配',
  )
})

test('the preview document bounds its source lines and masks an absolute home path', async () => {
  const sources = Array.from({ length: 10 }, (_, index) =>
    proposalSource({
      path: 'Projects/demo--11111111/Decisions/' + index + '.md',
      matched: index % 2 === 0,
      currentHash: index % 2 === 0 ? '1'.repeat(64) : '3'.repeat(64),
      missing: index === 9,
    }),
  )
  const detail = proposalDetail({
    sources,
    operation: {
      ...proposalDetail().operation,
      target: {
        path: homedir() + '/Documents/knowledge/Projects/demo--11111111/Decisions/old.md',
        title: 'Old',
        status: 'active',
        body: 'old body',
        bodyTruncated: false,
      },
    },
  })
  const stub = reviewStub({ detail })
  const preview = await previewPanelAction({
    operation: 'apply-proposal',
    args: { proposalId: PROPOSAL_ID },
    ...panelEnv(stub),
  })
  const markdown = preview.preview.markdown
  const sourceLines = markdown.split('## 来源\n\n')[1].split('\n\n## 影响')[0].split('\n')
  assert.ok(
    sourceLines.length <= 9,
    'at most eight source lines plus the remainder: ' + sourceLines.length,
  )
  assert.match(sourceLines.join('\n'), /还有 2 个来源/u)
  assert.match(sourceLines.join('\n'), /✔ Projects\/demo--11111111\/Decisions\/0\.md — 匹配/u)
  assert.match(sourceLines.join('\n'), /✘ Projects\/demo--11111111\/Decisions\/1\.md — 已变或缺失/u)
  assert.equal(markdown.includes(homedir()), false, 'no absolute home path reaches the wire')
  assert.match(markdown, /~\/Documents\/knowledge/u)
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
