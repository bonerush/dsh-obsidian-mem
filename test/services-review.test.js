// Task 1 (curation review panel): the service methods the panel transport reads.
//
// The panel never touches `lib/curation-proposals.js` or `lib/curation-review.js`
// directly: `lib/panel-actions.js` and `lib/panel-route.js` call these four service
// methods, and one host-level hook (`curateForBinding`) gains the deterministic
// reconciliation. Every case here runs through a real `createMemoryServices` on the
// isolated world `test/curation-world.js` builds — a throwaway vault, Git repository
// and private data root — so nothing reads the user's real home or `$DSH_HOME`.
//
// The contracts asserted are the frozen ones from the task brief:
//   * `reviewQueue(binding)` — bounded pending rows and a short decided history, split
//     executable/review-only, with provenance on the history;
//   * `reviewDetail(binding, id)` — evidence verification, a bounded candidate body and the
//     supersede target; unknown ids are a coded 404 and a corrupt record keeps the
//     store's own code;
//   * `reviewDecision(binding, id, decision, reviewer?)` — the `reviewCurationProposal` value,
//     unchanged, so a refusal code is never hidden;
//   * `autoReviewQueue(binding, {llm})` — a pass-through to the bounded automatic
//     reviewer with the service's own data root and config;
//   * `curateForBinding` — `reconciled: {retired: n}` after it records a pass's
//     findings, and a failure there never fails the pass.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  readCurationProposal,
  saveCurationProposal,
  snapshotProposalSources,
} from '../lib/curation-proposals.js'
import { createMemoryServices } from '../lib/services.js'
import { resolveBinding } from '../lib/vault.js'
import { makeCurationWorld } from './curation-world.js'

/** One fixed clock, so every timestamp in a case is the same timestamp. */
const NOW = new Date('2026-10-03T04:00:00Z')

/** The binding the world's first write created, resolved through the shipped seam. */
async function bindingOf(made) {
  const binding = await resolveBinding({
    cwd: made.repo,
    vaultRoot: made.vault,
    mode: 'show',
    home: made.home,
  })
  assert.equal(binding.kind, 'bound', JSON.stringify(binding))
  return binding
}

/** One world with a route configured, one seed note and its binding. */
async function world(t) {
  const made = await makeCurationWorld(t, {
    config: { distill: { provider: 'test-provider', model: 'test-model' } },
  })
  const seed = await made.services.write({ type: 'doc', title: '起点', body: '起点正文。\n' })
  return { ...made, binding: await bindingOf(made), seed }
}

/** A valid-looking distillation item, as `lib/distill.js` shapes one. */
function itemFixture(overrides = {}) {
  return {
    preassignedId: `dec-${randomUUID()}`,
    idempotencyKey: `item:${randomUUID()}`,
    type: 'decision',
    title: '新结论',
    body: '新结论正文。\n',
    tags: [],
    confidence: 0.9,
    assertion: 'stated',
    status: 'accepted',
    evidenceSeqs: [3, 4],
    ...overrides,
  }
}

/** Park one executable `supersede` proposal about a note the world wrote. */
async function parkSupersede(made, { item = {}, target = null } = {}) {
  const about = target ?? made.seed
  const full = itemFixture({ supersedesId: about.id, ...item })
  const proposal = await saveCurationProposal({
    dataRoot: made.dataRoot,
    now: NOW,
    projectId: made.binding.projectId,
    itemKey: full.idempotencyKey,
    kind: 'supersede',
    sources: await snapshotProposalSources(made.binding, {
      supersedesId: about.id,
      twin: { id: about.id, path: about.path },
      home: made.home,
    }),
    operation: { kind: 'supersede', item: full, supersedesId: about.id },
    evidence: full.evidenceSeqs,
  })
  return { proposal, item: full }
}

/** Park one executable `create-separate` proposal about the seed note. */
async function parkCreateSeparate(made) {
  const item = itemFixture({ type: 'gotcha', title: '新的踩坑标题', body: '新的踩坑正文。\n' })
  const proposal = await saveCurationProposal({
    dataRoot: made.dataRoot,
    now: NOW,
    projectId: made.binding.projectId,
    itemKey: item.idempotencyKey,
    kind: 'near-duplicate',
    sources: await snapshotProposalSources(made.binding, {
      twin: { id: made.seed.id, path: made.seed.path },
      home: made.home,
    }),
    operation: { kind: 'create-separate', item },
  })
  return { proposal, item }
}

/** Park one review-only finding proposal (the shape a scan records). */
async function parkFinding(made, { kind = 'expired-review', paths = [made.seed.path] } = {}) {
  return saveCurationProposal({
    dataRoot: made.dataRoot,
    now: NOW,
    projectId: made.binding.projectId,
    itemKey: `scan:${kind}:${[...paths].sort().join('|')}`,
    kind,
    reviewOnly: true,
    reason: '一个需要人类判断的发现',
    sources: paths.map((path) => ({ id: null, path, hash: 'a'.repeat(64) })),
  })
}

/** A fake `llm` service: one async iterable stream carrying exactly these chunks. */
function fakeLlm(text) {
  return {
    calls: [],
    stream: async function* (options) {
      this.calls.push(options)
      yield { type: 'text-delta', text }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
}

/** A hand-written plugin note with whatever frontmatter a case needs. */
function handNote({ id, title, extra = [], body = '正文。\n' }) {
  return [
    '---',
    `id: ${id}`,
    'type: doc',
    `title: ${JSON.stringify(title)}`,
    'status: active',
    'created: 2026-01-01',
    'updated: 2026-01-01',
    ...extra,
    '---',
    body,
  ].join('\n')
}

/** Write one raw note into the vault, creating its directories. */
async function writeRaw(made, relativePath, text) {
  const segments = relativePath.split('/')
  await mkdir(join(made.vault, ...segments.slice(0, -1)), { recursive: true })
  await writeFile(join(made.vault, ...segments), text, 'utf8')
}

// ---------------------------------------------------------------------------
// reviewQueue
// ---------------------------------------------------------------------------

test('reviewQueue is empty on an unbound project and splits executable rows from evidence', async (t) => {
  const made = await world(t)
  // An unbound service set (a session whose directory resolves to no project) still
  // answers the empty card rather than throwing: the panel reads it on every poll.
  const unbound = createMemoryServices({
    config: made.config,
    dataRoot: made.dataRoot,
    cwd: join(made.root, 'not-a-repo'),
    home: made.home,
  })
  try {
    // The card is one shape whether or not the session is bound: the unbound answer
    // is the empty queue plus the honest auto-review flags (this world has a route
    // configured, so both are true).
    assert.deepEqual(await unbound.reviewQueue(null), {
      total: 0,
      pending: 0,
      truncated: false,
      items: [],
      recent: [],
      auto: { enabled: true, routeConfigured: true },
    })
  } finally {
    await unbound.close()
  }

  const executable = await parkSupersede(made)
  const finding = await parkFinding(made)
  const queue = await made.services.reviewQueue(made.binding)
  assert.deepEqual(queue.auto, { enabled: true, routeConfigured: true })
  assert.equal(queue.total, 2)
  assert.equal(queue.pending, 2)
  assert.equal(queue.truncated, false)
  assert.equal(queue.items.length, 2)
  for (const item of queue.items) {
    assert.match(item.proposalId, /^[0-9a-f]{64}$/u)
    assert.equal(typeof item.kind, 'string')
    assert.equal(typeof item.reason, 'string')
    assert.equal(Array.isArray(item.paths), true)
    assert.equal(typeof item.createdAt, 'string')
    assert.equal(typeof item.reviewOnly, 'boolean')
  }
  const byId = Object.fromEntries(queue.items.map((item) => [item.proposalId, item]))
  assert.equal(byId[executable.proposal.proposalId].reviewOnly, false)
  assert.equal(byId[finding.proposalId].reviewOnly, true)

  // One human decision moves a row out of `items` and into the bounded history with
  // its provenance.
  const rejected = await made.services.reviewDecision(made.binding, finding.proposalId, 'reject')
  assert.equal(rejected.status, 'rejected')
  const after = await made.services.reviewQueue(made.binding)
  assert.equal(after.pending, 1)
  assert.equal(after.total, 2)
  assert.deepEqual(
    after.items.map((item) => item.proposalId),
    [executable.proposal.proposalId],
  )
  assert.equal(after.recent.length, 1)
  assert.deepEqual(after.recent[0], {
    proposalId: finding.proposalId,
    kind: 'expired-review',
    state: 'rejected',
    decidedBy: 'human',
    // The service clock is the real one here; the shape is what the card reads.
    decidedAt: after.recent[0].decidedAt,
    reason: 'a human reviewed this candidate and rejected it',
  })
  assert.match(after.recent[0].decidedAt, /^\d{4}-\d{2}-\d{2}T/u)
})

// ---------------------------------------------------------------------------
// reviewDetail
// ---------------------------------------------------------------------------

test('reviewDetail verifies the evidence and shows the note a supersede would move', async (t) => {
  const made = await world(t)
  const { proposal, item } = await parkSupersede(made)
  const detail = await made.services.reviewDetail(made.binding, proposal.proposalId)
  assert.equal(detail.proposalId, proposal.proposalId)
  assert.equal(detail.kind, 'supersede')
  assert.equal(detail.state, 'pending')
  assert.equal(detail.reviewOnly, false)
  assert.equal(detail.itemKey, item.idempotencyKey)
  assert.equal(detail.createdAt, NOW.toISOString())
  assert.equal(detail.reason, 'a distilled conclusion proposes to supersede an existing note')
  assert.deepEqual(detail.sources, [
    {
      path: made.seed.path,
      hash: proposal.sources[0].hash,
      currentHash: proposal.sources[0].hash,
      matched: true,
      missing: false,
    },
  ])
  assert.equal(detail.operation.kind, 'supersede')
  assert.equal(detail.operation.title, '新结论')
  assert.equal(detail.operation.body, '新结论正文。\n')
  assert.equal(detail.operation.bodyTruncated, false)
  assert.equal(detail.operation.supersedesId, made.seed.id)
  assert.equal(detail.operation.target.path, made.seed.path)
  assert.equal(detail.operation.target.title, '起点')
  assert.equal(detail.operation.target.status, 'active')
  assert.match(detail.operation.target.body, /起点正文。/)
  assert.equal(detail.operation.target.bodyTruncated, false)

  // A create-separate has no note whose status moves, so it carries no target.
  const separate = await parkCreateSeparate(made)
  const separateDetail = await made.services.reviewDetail(
    made.binding,
    separate.proposal.proposalId,
  )
  assert.equal(separateDetail.operation.kind, 'create-separate')
  assert.equal(separateDetail.operation.supersedesId, null)
  assert.equal(separateDetail.operation.target, null)

  // A review-only row has no operation at all.
  const finding = await parkFinding(made)
  const findingDetail = await made.services.reviewDetail(made.binding, finding.proposalId)
  assert.equal(findingDetail.reviewOnly, true)
  assert.equal(findingDetail.operation, null)
})

test('reviewDetail bounds both bodies with an explicit truncation flag', async (t) => {
  const made = await world(t)
  // A candidate body over the 16,000-char bound.
  const longItem = await parkSupersede(made, { item: { body: `开头。${'候'.repeat(17_000)}` } })
  const longDetail = await made.services.reviewDetail(made.binding, longItem.proposal.proposalId)
  assert.equal(longDetail.operation.bodyTruncated, true)
  assert.equal(longDetail.operation.body.length, 16_000)

  // A supersede target body over the 4,000-char bound.
  const big = await made.services.write({
    type: 'doc',
    title: '长文',
    body: `长文正文。${'长'.repeat(6000)}\n`,
  })
  const bigItem = await parkSupersede(made, { target: big })
  const bigDetail = await made.services.reviewDetail(made.binding, bigItem.proposal.proposalId)
  assert.equal(bigDetail.operation.target.bodyTruncated, true)
  assert.equal(bigDetail.operation.target.body.length, 4_000)
  // The superseded source's hash still matches: the bound is a display bound, not a
  // staleness claim.
  assert.equal(bigDetail.sources[0].matched, true)
})

test('reviewDetail answers coded errors for a missing id and a corrupt record', async (t) => {
  const made = await world(t)
  await assert.rejects(
    () => made.services.reviewDetail(made.binding, 'f'.repeat(64)),
    (error) => {
      assert.equal(error.code, 'proposal-missing')
      assert.equal(error.status, 404)
      return true
    },
  )
  // A malformed id is a programming error (the panel's argument normalization is the
  // route that answers 400), not a missing record.
  await assert.rejects(
    () => made.services.reviewDetail(made.binding, 'not-a-proposal-id'),
    RangeError,
  )

  const { proposal } = await parkSupersede(made)
  const recordPath = join(
    made.dataRoot,
    'curation',
    'proposals',
    made.binding.projectId,
    `${proposal.proposalId}.json`,
  )
  await writeFile(recordPath, '{not json', 'utf8')
  await assert.rejects(
    () => made.services.reviewDetail(made.binding, proposal.proposalId),
    (error) => {
      assert.equal(error.code, 'state-corrupt', 'the store refusal keeps its own name')
      assert.equal(typeof error.status, 'number')
      return true
    },
  )
})

// ---------------------------------------------------------------------------
// reviewDecision
// ---------------------------------------------------------------------------

test('reviewDecision returns the review value unchanged and defaults to a human reviewer', async (t) => {
  const made = await world(t)
  const { proposal } = await parkSupersede(made)
  const answer = await made.services.reviewDecision(made.binding, proposal.proposalId, 'apply')
  assert.equal(answer.status, 'applied', JSON.stringify(answer))
  assert.equal(typeof answer.receipt, 'object')
  const record = await readCurationProposal({
    dataRoot: made.dataRoot,
    projectId: made.binding.projectId,
    proposalId: proposal.proposalId,
  })
  assert.equal(record.state, 'applied')
  assert.equal(record.decidedBy, 'human')
  // The reviewed write landed through the engine: the seed note is superseded.
  const seed = await made.services.read({ path: made.seed.path })
  assert.equal(seed.frontmatter.status, 'superseded')

  // A refused decision is the review's own value, code included — never remapped.
  const again = await made.services.reviewDecision(made.binding, proposal.proposalId, 'apply')
  assert.equal(again.status, 'refused')
  assert.equal(again.code, 'proposal-not-current')

  const finding = await parkFinding(made)
  const reviewOnly = await made.services.reviewDecision(made.binding, finding.proposalId, 'apply')
  assert.equal(reviewOnly.status, 'refused')
  assert.equal(reviewOnly.code, 'review-only')
  const rejected = await made.services.reviewDecision(made.binding, finding.proposalId, 'reject', {
    kind: 'human',
    note: 'not a memory',
  })
  assert.equal(rejected.status, 'rejected')
  const findingRecord = await readCurationProposal({
    dataRoot: made.dataRoot,
    projectId: made.binding.projectId,
    proposalId: finding.proposalId,
  })
  assert.equal(findingRecord.decidedBy, 'human')
  assert.equal(findingRecord.decisionNote, 'not a memory')

  // An unknown id is the review's refusal value, not a thrown 404: the panel maps it.
  const missing = await made.services.reviewDecision(made.binding, 'e'.repeat(64), 'reject')
  assert.equal(missing.status, 'refused')
  assert.equal(missing.code, 'proposal-missing')
})

// ---------------------------------------------------------------------------
// autoReviewQueue
// ---------------------------------------------------------------------------

test('autoReviewQueue runs the bounded reviewer over this service’s own project and route', async (t) => {
  const made = await world(t)
  const { proposal } = await parkSupersede(made)
  const llm = fakeLlm('{"verdict":"apply","confidence":0.95,"reason":"the evidence is clear"}')
  const summary = await made.services.autoReviewQueue(made.binding, { llm })
  assert.equal(summary.status, 'reviewed', JSON.stringify(summary))
  assert.deepEqual(summary.applied, [proposal.proposalId])
  assert.equal(summary.model, 'test-provider/test-model')
  const record = await readCurationProposal({
    dataRoot: made.dataRoot,
    projectId: made.binding.projectId,
    proposalId: proposal.proposalId,
  })
  assert.equal(record.decidedBy, 'auto')
  assert.equal(record.decidedByModel, 'test-provider/test-model')

  // With no `llm` service at all (P0: it can be absent during `apply`) the pass is
  // a stated no-op and no call is made.
  const second = await parkSupersede(made)
  const skipped = await made.services.autoReviewQueue(made.binding, { llm: null })
  assert.equal(skipped.status, 'skipped')
  assert.equal(skipped.reason, 'no-route')
  assert.equal(
    (
      await readCurationProposal({
        dataRoot: made.dataRoot,
        projectId: made.binding.projectId,
        proposalId: second.proposal.proposalId,
      })
    ).state,
    'pending',
  )
})

// ---------------------------------------------------------------------------
// curateForBinding reconciliation
// ---------------------------------------------------------------------------

/** The raw path of one hand-written note in the world's project tree. */
function rawNotePath(made, name) {
  return `${made.binding.relativeDir}/Docs/${name}.md`
}

test('a curation pass reports reconciling the review-only findings a later pass disproved', async (t) => {
  const made = await world(t)
  // A deterministic pass budget: a tiny fixture finishes well inside the shipped
  // 500 ms hook bound, but a test should assert `complete` about its own fixture
  // rather than about the machine's load.
  // The fixture bounds are passed to both scanning passes explicitly: the service's
  // `curationBounds` option is read by the admin path only, while the
  // `curateForBinding` wrapper forwards its own `maxNotes`/`maxMs`. Leaving those to
  // the shipped 500 ms default made this case's `complete:true` a claim about the
  // machine's load instead of about its fixture (observed once under a concurrent
  // full-suite run).
  const PASS_BOUNDS = { maxNotes: 100, maxMs: 60_000 }
  const passes = createMemoryServices({
    config: made.config,
    dataRoot: made.dataRoot,
    cwd: made.repo,
    home: made.home,
    curationBounds: PASS_BOUNDS,
  })
  made.releaseBeforeCleanup(() => passes.close())
  const relative = rawNotePath(made, '无出处')
  // A plugin-shaped note that cannot say where it came from: a missing-provenance
  // finding the first pass will park as a review-only proposal.
  await writeRaw(
    made,
    relative,
    handNote({
      id: 'doc-11111111-1111-4111-8111-111111111111',
      title: '无出处',
      extra: [`project: ${made.binding.projectId}`, 'trust: agent'],
    }),
  )

  // The first pass records the finding. There is nothing older to reconcile yet, but
  // the result always names the count so a caller never infers it.
  const firstPass = await passes.curateForBinding(made.binding, { force: true, ...PASS_BOUNDS })
  assert.equal(firstPass.status, 'scanned', JSON.stringify(firstPass))
  assert.equal(firstPass.complete, true)
  assert.deepEqual(firstPass.reconciled, { retired: 0 })
  const pending = await passes.reviewQueue(made.binding)
  assert.equal(pending.items.length, 1, JSON.stringify(pending))
  const findingId = pending.items[0].proposalId
  assert.equal(pending.items[0].reviewOnly, true)
  assert.equal(pending.items[0].kind, 'missing-provenance')

  // The note is repaired and the pass is told this note changed: a covered note is
  // re-inspected on a changed-path traversal (a full pass trusts the stored record).
  await writeRaw(
    made,
    relative,
    handNote({
      id: 'doc-11111111-1111-4111-8111-111111111111',
      title: '无出处',
      extra: [
        `project: ${made.binding.projectId}`,
        'trust: agent',
        'source: "session:test"',
        'harness: "dsh"',
      ],
    }),
  )
  const secondPass = await passes.curateForBinding(made.binding, {
    changedPaths: [relative],
    ...PASS_BOUNDS,
  })
  assert.equal(secondPass.status, 'scanned', JSON.stringify(secondPass))
  assert.deepEqual(secondPass.reconciled, { retired: 1 })
  const retired = await readCurationProposal({
    dataRoot: made.dataRoot,
    projectId: made.binding.projectId,
    proposalId: findingId,
  })
  assert.equal(retired.state, 'retired')
  assert.equal(
    retired.retiredReason,
    'a later curation pass examined this evidence and no longer finds it',
  )
  assert.equal((await passes.reviewQueue(made.binding)).pending, 0)

  // A read-only pass inspects nothing, so it reconciles nothing, and still reports
  // the closed shape a caller reads.
  const listed = await passes.curateForBinding(made.binding, { readOnly: true })
  assert.equal(listed.status, 'listed')
  assert.deepEqual(listed.reconciled, { retired: 0 })

  // The tool projection is the one place the additive count is dropped: the
  // `mem_admin` curation output schema is closed and the tool surface is unchanged.
  const tool = await passes.admin({ action: 'curation', operation: 'status' })
  assert.equal(tool.action, 'curation')
  assert.equal('reconciled' in tool.result, false)
})

test('M11: a queue holding a corrupt record does not read as healthy', async (t) => {
  const made = await world(t)
  const { proposal } = await parkSupersede(made)
  // Corrupt the only record: the store lists its id as unreadable, so the card must
  // not present an empty, healthy queue with `truncated: false` while the store knows
  // the queue is damaged (`reviewDetail` on it would answer `state-corrupt`).
  await writeFile(
    join(
      made.dataRoot,
      'curation',
      'proposals',
      made.binding.projectId,
      `${proposal.proposalId}.json`,
    ),
    '{not json',
    'utf8',
  )
  const queue = await made.services.reviewQueue(made.binding)
  assert.equal(queue.total, 0)
  assert.equal(queue.pending, 0)
  assert.equal(queue.truncated, true, 'damage is reported through the existing flag')
  assert.deepEqual(queue.items, [])
})
