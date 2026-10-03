// Task 3: durable proposals — identity, persistence and the review-only record.
//
// A proposal is the one place this plugin stores a candidate it is not allowed to
// apply. Everything here is about the three properties that make that store
// trustworthy:
//
//   * **Identity is stable.** Replaying one distillation item, or re-scanning one
//     near duplicate, returns the same proposal ID; a store that minted a new one
//     per pass would flood a human's review queue, which is the defect this
//     module's whole shape exists to prevent.
//   * **Nothing is silently lost.** The document is written `0600` inside an
//     `0700` directory under the private data root, atomically and size-bounded,
//     and an ID that already exists with different content is refused rather than
//     overwritten.
//   * **A review-only proposal carries no operation.** A finding that needs
//     judgment is a record to read, never a plan this plugin could execute.
//
// Every case runs in the isolated world Task 1 built: a real temporary vault, a
// real Git repository and a throwaway private data root. Nothing here reads the
// user's home, a real vault or a real `$DSH_HOME`.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  CurationError,
  MAX_PROPOSAL_BYTES,
  listCurationProposals,
  markCurationProposal,
  readCurationProposal,
  recordCurationFindings,
  saveCurationProposal,
  snapshotProposalSources,
} from '../lib/curation-proposals.js'
import {
  CURATION_DIR_MODE,
  CURATION_FILE_MODE,
  curationRecordDir,
  readScanRecord,
} from '../lib/curation-state.js'
import { scanCuration } from '../lib/curation-scan.js'
import { writeMemory } from '../lib/memory.js'
import { resolveBinding } from '../lib/vault.js'
import { makeCurationWorld } from './curation-world.js'

/** One fixed clock, so every timestamp in a case is the same timestamp. */
const NOW = new Date('2026-10-03T04:00:00Z')
/** The other project these cases must never see. */
const OTHER_PROJECT = '6a1f0b52-0000-4000-8000-000000000001'

/** The sha256 of a byte sequence. */
function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

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

/** One world, one binding, one seed note. */
async function world(t) {
  const made = await makeCurationWorld(t)
  const seed = await made.services.write({ type: 'doc', title: '起点', body: '起点正文。\n' })
  return { ...made, binding: await bindingOf(made), seed }
}

/** The absolute vault path of one vault-relative path. */
function at(made, relative) {
  return join(made.vault, ...relative.split('/'))
}

/** Write one hand-made note into the vault, creating its directories. */
async function writeRaw(made, relativePath, text) {
  const segments = relativePath.split('/')
  await mkdir(join(made.vault, ...segments.slice(0, -1)), { recursive: true })
  await writeFile(join(made.vault, ...segments), text, 'utf8')
}

/** A hand-written, plugin-shaped note with whatever frontmatter a case needs. */
function handNote({ id, type = 'doc', title, extra = [], body = '正文。\n' }) {
  return [
    '---',
    `id: ${id}`,
    `type: ${type}`,
    `title: ${JSON.stringify(title)}`,
    'status: active',
    'created: 2026-01-01',
    'updated: 2026-01-01',
    ...extra,
    '---',
    body,
  ].join('\n')
}

/** One validated-looking distillation item, as `lib/distill.js` shapes it. */
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

/**
 * One complete scan of a world, with the clock and seams every case shares.
 *
 * `maxMs` is the seam, not a preference: the shipped 500 ms bound belongs to a hook
 * pass, and every case here asserts what a *finished* pass found, so the deadline is
 * set far beyond what one of these fixtures costs.
 */
function scan(made, binding) {
  return scanCuration(binding, {
    dataRoot: made.dataRoot,
    home: made.home,
    now: NOW,
    maxMs: 60_000,
  })
}

/** The source path list one finding names. */
function pathsOf(finding) {
  return (
    Array.isArray(finding.paths) && finding.paths.length > 0 ? finding.paths : [finding.path]
  ).filter((path) => typeof path === 'string' && path !== '')
}

// ---------------------------------------------------------------------------
// Identity and persistence
// ---------------------------------------------------------------------------

test('one proposal ID per item identity, and replay returns the same record', async (t) => {
  const made = await world(t)
  const item = itemFixture({ supersedesId: made.seed.id })
  const details = {
    projectId: made.binding.projectId,
    itemKey: item.idempotencyKey,
    kind: 'supersede',
    sources: [{ id: made.seed.id, path: made.seed.path, hash: 'a'.repeat(64) }],
    operation: { kind: 'supersede', item, supersedesId: made.seed.id },
    evidence: item.evidenceSeqs,
  }
  const first = await saveCurationProposal({ dataRoot: made.dataRoot, now: NOW, ...details })
  const replay = await saveCurationProposal({ dataRoot: made.dataRoot, now: NOW, ...details })

  assert.equal(first.proposalId, replay.proposalId, 'a replay is the same proposal')
  assert.equal(first.state, 'pending')
  assert.equal(replay.createdAt, first.createdAt, 'the review queue did not grow a second entry')
  assert.match(first.proposalId, /^[0-9a-f]{64}$/u)
  assert.equal(first.operation.item.idempotencyKey, item.idempotencyKey)
  assert.deepEqual(first.evidence, [3, 4])

  // The identity is a function of project, item key, kind and source hashes, so an
  // explicit ID claiming the same identity resolves to the record the derivation
  // produced. It is asserted through the store rather than by re-deriving the hash
  // here: a test that reimplements the encoding agrees with a wrong encoding too.
  const claimed = await saveCurationProposal({
    dataRoot: made.dataRoot,
    now: NOW,
    ...details,
    proposalId: first.proposalId,
  })
  assert.equal(claimed.proposalId, first.proposalId, 'the ID is derived, not minted')
  await assert.rejects(
    () =>
      saveCurationProposal({
        dataRoot: made.dataRoot,
        now: NOW,
        ...details,
        proposalId: first.proposalId,
        itemKey: `${item.idempotencyKey}-other`,
      }),
    (error) => {
      assert.equal(error.code, 'proposal-conflict', 'another identity under one ID collides')
      return true
    },
  )
  const other = await saveCurationProposal({
    dataRoot: made.dataRoot,
    now: NOW,
    ...details,
    itemKey: `${item.idempotencyKey}-other`,
  })
  assert.notEqual(other.proposalId, first.proposalId)
})

test('a collision with different content is refused, and nothing is overwritten', async (t) => {
  const made = await world(t)
  const id = 'f'.repeat(64)
  const base = {
    projectId: made.binding.projectId,
    itemKey: 'item:one',
    kind: 'supersede',
    sources: [{ id: null, path: made.seed.path, hash: 'a'.repeat(64) }],
  }
  const first = await saveCurationProposal({
    dataRoot: made.dataRoot,
    now: NOW,
    proposalId: id,
    ...base,
    operation: {
      kind: 'supersede',
      supersedesId: 'dec-11111111-1111-4111-8111-111111111111',
      item: { title: '第一版' },
    },
  })
  assert.equal(first.proposalId, id)

  await assert.rejects(
    () =>
      saveCurationProposal({
        dataRoot: made.dataRoot,
        now: NOW,
        proposalId: id,
        ...base,
        operation: {
          kind: 'supersede',
          supersedesId: 'dec-11111111-1111-4111-8111-111111111111',
          item: { title: '内容变了' },
        },
      }),
    (error) => {
      assert.ok(error instanceof CurationError, error?.stack)
      assert.equal(error.code, 'proposal-conflict')
      return true
    },
  )

  const kept = await readCurationProposal({
    dataRoot: made.dataRoot,
    projectId: made.binding.projectId,
    proposalId: id,
  })
  assert.equal(kept.contentHash, first.contentHash, 'the refused write left the record alone')
  assert.equal(kept.operation.item.title, '第一版')
})

test('a proposal document is private, atomic and size-bounded', async (t) => {
  const made = await world(t)
  const stored = await saveCurationProposal({
    dataRoot: made.dataRoot,
    now: NOW,
    projectId: made.binding.projectId,
    itemKey: 'item:modes',
    kind: 'supersede',
    sources: [],
    operation: {
      kind: 'supersede',
      supersedesId: 'dec-22222222-2222-4222-8222-222222222222',
      item: { title: '模式' },
    },
  })
  const directory = join(made.dataRoot, 'curation', 'proposals', made.binding.projectId)
  const path = join(directory, `${stored.proposalId}.json`)
  assert.equal((await stat(path)).mode & 0o777, CURATION_FILE_MODE)
  assert.equal((await stat(directory)).mode & 0o777, CURATION_DIR_MODE)
  assert.equal(
    (await readdir(directory)).some((name) => name.endsWith('.tmp')),
    false,
    'no temporary file survives a successful write',
  )

  // A candidate over the document bound is refused by name, so a stored document
  // can never be one its own reader would refuse.
  await assert.rejects(
    () =>
      saveCurationProposal({
        dataRoot: made.dataRoot,
        now: NOW,
        projectId: made.binding.projectId,
        itemKey: 'item:huge',
        kind: 'supersede',
        sources: [],
        operation: {
          kind: 'supersede',
          supersedesId: 'dec-33333333-3333-4333-8333-333333333333',
          item: { body: 'x'.repeat(MAX_PROPOSAL_BYTES) },
        },
      }),
    (error) => {
      assert.equal(error.code, 'proposal-oversize')
      return true
    },
  )
})

test('a review-only proposal carries no executable operation, and a bad pair is refused', async (t) => {
  const made = await world(t)
  const stored = await saveCurationProposal({
    dataRoot: made.dataRoot,
    now: NOW,
    projectId: made.binding.projectId,
    itemKey: 'scan:dead-wikilink:docs',
    kind: 'dead-wikilink',
    reason: 'Docs/引用者.md links to [[不存在的东西]]',
    sources: [{ id: null, path: made.seed.path, hash: 'b'.repeat(64) }],
  })
  assert.equal(stored.operation, null)
  assert.equal(stored.kind, 'dead-wikilink')
  assert.equal(stored.reason.includes('不存在的东西'), true)

  // A planning operation on a kind the design executes nothing for is refused
  // rather than stored and ignored: a record a reviewer reads as review-only must
  // not carry a plan.
  await assert.rejects(
    () =>
      saveCurationProposal({
        dataRoot: made.dataRoot,
        now: NOW,
        projectId: made.binding.projectId,
        itemKey: 'scan:dead-wikilink:other',
        kind: 'dead-wikilink',
        operation: {
          kind: 'supersede',
          supersedesId: 'dec-44444444-4444-4444-8444-444444444444',
          item: { title: '不该被执行' },
        },
      }),
    (error) => {
      assert.equal(error.code, 'proposal-kind-operation')
      return true
    },
  )
  await assert.rejects(
    () =>
      saveCurationProposal({
        dataRoot: made.dataRoot,
        now: NOW,
        projectId: made.binding.projectId,
        itemKey: 'item:unknown',
        kind: 'not-a-kind',
        operation: {
          kind: 'supersede',
          supersedesId: 'dec-55555555-5555-4555-8555-555555555555',
          item: { title: 'x' },
        },
      }),
    (error) => {
      assert.equal(error.code, 'proposal-kind')
      return true
    },
  )
  await assert.rejects(
    () =>
      saveCurationProposal({
        dataRoot: made.dataRoot,
        now: NOW,
        projectId: made.binding.projectId,
        itemKey: 'item:no-item',
        kind: 'supersede',
        operation: { kind: 'supersede' },
      }),
    (error) => {
      assert.equal(error.code, 'proposal-operation')
      return true
    },
  )
})

test('proposal source hashes are read from the vault, and an unreadable source is a refusal', async (t) => {
  const made = await world(t)
  const bytes = await readFile(at(made, made.seed.path))
  const sources = await snapshotProposalSources(made.binding, {
    supersedesId: null,
    twin: { id: made.seed.id, path: made.seed.path },
  })
  assert.deepEqual(sources, [{ id: made.seed.id, path: made.seed.path, hash: sha256(bytes) }])

  // The supersede target is named by id and path, and both are recorded: the id is
  // what the approval rechecks ownership from, the path is where it must be.
  const byId = await snapshotProposalSources(made.binding, {
    supersedesId: made.seed.id,
    twin: { id: made.seed.id, path: made.seed.path },
  })
  assert.deepEqual(byId, [{ id: made.seed.id, path: made.seed.path, hash: sha256(bytes) }])

  // A path that does not exist is a refusal, never a hash guessed from an index: a
  // proposal whose evidence names bytes nobody read is one nobody can review.
  await assert.rejects(
    () =>
      snapshotProposalSources(made.binding, {
        supersedesId: null,
        twin: { id: null, path: `${made.binding.relativeDir}/Docs/不存在.md` },
      }),
    (error) => {
      assert.ok(error instanceof CurationError, error?.stack)
      assert.equal(error.code, 'proposal-source-unreadable')
      return true
    },
  )

  // A path outside this project's tree is refused too, so evidence can never name
  // another project's note.
  await assert.rejects(
    () =>
      snapshotProposalSources(made.binding, {
        supersedesId: null,
        twin: { id: null, path: 'Projects/other--deadbeef/Docs/别家.md' },
      }),
    (error) => {
      assert.ok(error instanceof CurationError, error?.stack)
      assert.equal(error.code, 'proposal-source-unsafe')
      return true
    },
  )

  // Neither source named at all is a refusal: a proposal with no evidence is not
  // a proposal.
  await assert.rejects(
    () => snapshotProposalSources(made.binding, { supersedesId: null, twin: null }),
    (error) => {
      assert.equal(error.code, 'proposal-source-missing')
      return true
    },
  )
})

test('a state transition is recorded, and a decided proposal cannot be re-opened', async (t) => {
  const made = await world(t)
  const stored = await saveCurationProposal({
    dataRoot: made.dataRoot,
    now: NOW,
    projectId: made.binding.projectId,
    itemKey: 'item:reject-me',
    kind: 'supersede',
    sources: [],
    operation: {
      kind: 'supersede',
      supersedesId: 'dec-66666666-6666-4666-8666-666666666666',
      item: { title: '待审' },
    },
  })
  const rejected = await markCurationProposal({
    binding: made.binding,
    dataRoot: made.dataRoot,
    proposalId: stored.proposalId,
    state: 'rejected',
    now: NOW,
  })
  assert.equal(rejected.state, 'rejected')
  assert.equal(rejected.decidedAt, NOW.toISOString())
  assert.equal(rejected.createdAt, stored.createdAt, 'the decision does not rewrite the record')

  await assert.rejects(
    () =>
      markCurationProposal({
        binding: made.binding,
        dataRoot: made.dataRoot,
        proposalId: stored.proposalId,
        state: 'pending',
        now: NOW,
      }),
    (error) => {
      assert.equal(error.code, 'proposal-state')
      return true
    },
  )
  await assert.rejects(
    () =>
      markCurationProposal({
        binding: made.binding,
        dataRoot: made.dataRoot,
        proposalId: stored.proposalId,
        state: 'not-a-state',
        now: NOW,
      }),
    (error) => {
      assert.equal(error.code, 'proposal-state')
      return true
    },
  )

  // A missing proposal is refused by name, never silently created.
  await assert.rejects(
    () =>
      markCurationProposal({
        binding: made.binding,
        dataRoot: made.dataRoot,
        proposalId: '9'.repeat(64),
        state: 'rejected',
        now: NOW,
      }),
    (error) => {
      assert.equal(error.code, 'proposal-missing')
      return true
    },
  )
})

test('a listing is bounded, carries the review surface and names its truncation', async (t) => {
  const made = await world(t)
  for (let index = 0; index < 4; index += 1) {
    await saveCurationProposal({
      dataRoot: made.dataRoot,
      now: NOW,
      projectId: made.binding.projectId,
      itemKey: `item:${index}`,
      kind: 'supersede',
      reason: `第 ${index} 条`,
      sources: [{ id: null, path: made.seed.path, hash: 'c'.repeat(64) }],
      operation: {
        kind: 'supersede',
        supersedesId: `dec-77777777-7777-4777-8777-77777777777${index}`,
        item: { title: `标题 ${index}` },
      },
    })
  }
  const listed = await listCurationProposals({
    dataRoot: made.dataRoot,
    projectId: made.binding.projectId,
    limit: 2,
    now: NOW,
  })
  assert.equal(listed.total, 4)
  assert.equal(listed.truncated, true)
  assert.equal(listed.proposals.length, 2)
  for (const row of listed.proposals) {
    assert.match(row.proposalId, /^[0-9a-f]{64}$/u)
    assert.equal(row.state, 'pending')
    assert.equal(row.kind, 'supersede')
    assert.deepEqual(row.paths, [made.seed.path])
    assert.equal(typeof row.reason, 'string')
  }
  // The listing never carries the candidate itself: a status read is bounded.
  assert.equal('operation' in listed.proposals[0], false)

  const pending = await listCurationProposals({
    dataRoot: made.dataRoot,
    projectId: made.binding.projectId,
    state: 'pending',
    now: NOW,
  })
  assert.equal(pending.total, 4)
  const empty = await listCurationProposals({
    dataRoot: made.dataRoot,
    projectId: made.binding.projectId,
    state: 'applied',
    now: NOW,
  })
  assert.deepEqual(empty, {
    projectId: made.binding.projectId,
    total: 0,
    truncated: false,
    proposals: [],
    unreadable: [],
  })
})

// ---------------------------------------------------------------------------
// Scanner findings become review-only proposals
// ---------------------------------------------------------------------------

test('repeated scans of a near duplicate yield one durable, review-only proposal', async (t) => {
  const made = await world(t)
  const nearA = await made.services.write({
    type: 'decision',
    title: '预算上限',
    body: '预算是 12 万。\n',
  })
  const nearB = await made.services.write({
    type: 'decision',
    title: '预算上限',
    body: '预算是 13 万。\n',
  })
  const before = {
    [nearA.path]: sha256(await readFile(at(made, nearA.path))),
    [nearB.path]: sha256(await readFile(at(made, nearB.path))),
  }

  const first = await scan(made, made.binding)
  const grouped = first.findings.filter((finding) => finding.kind === 'near-duplicate')
  assert.equal(grouped.length, 1, JSON.stringify(first.findings.map((finding) => finding.kind)))
  const recorded = await recordCurationFindings({
    binding: made.binding,
    dataRoot: made.dataRoot,
    findings: first.findings,
    now: NOW,
  })
  assert.equal(recorded.created.length, 1, JSON.stringify(recorded))
  assert.equal(recorded.created[0].kind, 'near-duplicate')
  assert.equal(recorded.created[0].operation, null, 'a finding is never an executable plan')

  // The second pass over the same bytes is a replay: no second queue entry, no
  // second review, and no retirement of the one that is already there.
  const second = await scan(made, made.binding)
  const again = await recordCurationFindings({
    binding: made.binding,
    dataRoot: made.dataRoot,
    findings: second.findings,
    now: NOW,
  })
  assert.deepEqual(again.created, [])
  assert.deepEqual(again.updated, [])
  assert.deepEqual(again.retired, [])
  assert.equal(again.replayed.length, 1, JSON.stringify(again))
  assert.equal(again.replayed[0].proposalId, recorded.created[0].proposalId)

  const listed = await listCurationProposals({
    dataRoot: made.dataRoot,
    projectId: made.binding.projectId,
    state: 'pending',
    now: NOW,
  })
  assert.equal(listed.total, 1, 'two passes over one pair are one proposal')
  assert.deepEqual([...listed.proposals[0].paths].sort(), [...pathsOf(grouped[0])].sort())

  // Neither the scan nor the recording changed a source-note byte.
  assert.deepEqual(
    {
      [nearA.path]: sha256(await readFile(at(made, nearA.path))),
      [nearB.path]: sha256(await readFile(at(made, nearB.path))),
    },
    before,
  )
})

test('a changed source retires the stale proposal and records the current one', async (t) => {
  const made = await world(t)
  await made.services.write({ type: 'decision', title: '预算上限', body: '预算是 12 万。\n' })
  const near = await made.services.write({
    type: 'decision',
    title: '预算上限',
    body: '预算是 13 万。\n',
  })

  const first = await scan(made, made.binding)
  const firstRecord = await recordCurationFindings({
    binding: made.binding,
    dataRoot: made.dataRoot,
    findings: first.findings,
    now: NOW,
  })
  assert.equal(firstRecord.created.length, 1, JSON.stringify(firstRecord))
  const staleId = firstRecord.created[0].proposalId

  // The candidate itself is edited: the same pair of paths, different bytes.
  const edited = (await readFile(at(made, near.path), 'utf8')).replace('13 万', '14 万')
  await writeFile(at(made, near.path), edited, 'utf8')

  const second = await scan(made, made.binding)
  const secondRecord = await recordCurationFindings({
    binding: made.binding,
    dataRoot: made.dataRoot,
    findings: second.findings,
    now: NOW,
  })

  assert.equal(secondRecord.created.length, 1, JSON.stringify(secondRecord))
  assert.notEqual(secondRecord.created[0].proposalId, staleId)
  assert.deepEqual(
    secondRecord.retired.map((row) => row.proposalId),
    [staleId],
    'the proposal built from bytes that no longer exist is retired, not left open',
  )
  const stale = await readCurationProposal({
    dataRoot: made.dataRoot,
    projectId: made.binding.projectId,
    proposalId: staleId,
  })
  assert.equal(stale.state, 'retired')
  assert.equal(stale.operation, null)

  const open = await listCurationProposals({
    dataRoot: made.dataRoot,
    projectId: made.binding.projectId,
    state: 'pending',
    now: NOW,
  })
  assert.equal(open.total, 1, 'exactly one reviewable proposal survives the edit')
  assert.equal(open.proposals[0].proposalId, secondRecord.created[0].proposalId)
})

test('an expired review, a missing provenance and a dead link each become one proposal', async (t) => {
  const made = await world(t)
  const expired = await writeMemory(
    made.binding,
    { type: 'decision', title: '待复盘', body: '需要复盘。\n', review_after: '2000-01-01' },
    { dataRoot: made.dataRoot, home: made.home },
  )
  const naked = `${made.binding.relativeDir}/Docs/无出处.md`
  await writeRaw(
    made,
    naked,
    handNote({
      id: 'doc-11111111-1111-4111-8111-111111111111',
      title: '无出处',
      extra: [`project: ${made.binding.projectId}`, 'trust: agent'],
    }),
  )
  const linker = await made.services.write({
    type: 'doc',
    title: '引用者',
    body: '见 [[不存在的东西]]。\n',
  })

  const result = await scan(made, made.binding)
  const wanted = result.findings.filter((finding) =>
    ['expired-review', 'missing-provenance', 'dead-wikilink'].includes(finding.kind),
  )
  assert.deepEqual(
    [...new Set(wanted.map((finding) => finding.kind))].sort(),
    ['dead-wikilink', 'expired-review', 'missing-provenance'],
    JSON.stringify(result.findings.map((finding) => finding.kind)),
  )
  const recorded = await recordCurationFindings({
    binding: made.binding,
    dataRoot: made.dataRoot,
    findings: wanted,
    now: NOW,
  })
  assert.equal(recorded.created.length, 3, JSON.stringify(recorded))
  assert.deepEqual([...new Set(recorded.created.map((row) => row.kind))].sort(), [
    'dead-wikilink',
    'expired-review',
    'missing-provenance',
  ])
  for (const row of recorded.created) {
    assert.equal(row.operation, null)
    assert.ok(row.paths.length >= 1)
  }
  const byKind = Object.fromEntries(recorded.created.map((row) => [row.kind, row.paths]))
  assert.deepEqual(byKind['expired-review'], [expired.path])
  assert.deepEqual(byKind['missing-provenance'], [naked])
  assert.deepEqual(byKind['dead-wikilink'], [linker.path])

  // Replay is one proposal each, with no retirement: identity for these three is
  // their kind and path, so the same bytes are the same record.
  const replay = await recordCurationFindings({
    binding: made.binding,
    dataRoot: made.dataRoot,
    findings: wanted,
    now: NOW,
  })
  assert.deepEqual(replay.created, [])
  assert.deepEqual(replay.retired, [])
  assert.equal(replay.replayed.length, 3)
})

test('a finding from another project is refused and records nothing', async (t) => {
  const made = await world(t)
  await assert.rejects(
    () =>
      recordCurationFindings({
        binding: made.binding,
        dataRoot: made.dataRoot,
        findings: [
          {
            kind: 'dead-wikilink',
            path: 'Projects/other--deadbeef/Docs/别家.md',
            target: '不存在的东西',
            message: 'another project',
          },
        ],
        now: NOW,
      }),
    (error) => {
      assert.ok(['RangeError', 'PathSafetyError'].includes(error.name), error?.stack)
      return true
    },
  )
  const listed = await listCurationProposals({
    dataRoot: made.dataRoot,
    projectId: made.binding.projectId,
    now: NOW,
  })
  assert.equal(listed.total, 0, 'a refused finding leaves no record behind')
})

// ---------------------------------------------------------------------------
// Isolation and failure
// ---------------------------------------------------------------------------

test('a proposal for one project is invisible to another', async (t) => {
  const made = await world(t)
  const stored = await saveCurationProposal({
    dataRoot: made.dataRoot,
    now: NOW,
    projectId: made.binding.projectId,
    itemKey: 'item:mine',
    kind: 'supersede',
    sources: [],
    operation: {
      kind: 'supersede',
      supersedesId: 'dec-88888888-8888-4888-8888-888888888888',
      item: { title: '本项目的' },
    },
  })
  assert.equal(
    await readCurationProposal({
      dataRoot: made.dataRoot,
      projectId: OTHER_PROJECT,
      proposalId: stored.proposalId,
    }),
    null,
  )
  const mine = await readCurationProposal({
    dataRoot: made.dataRoot,
    projectId: made.binding.projectId,
    proposalId: stored.proposalId,
  })
  assert.equal(mine.operation.item.title, '本项目的')
  assert.equal(mine.projectId, made.binding.projectId)
})

test('a private document that cannot be trusted is refused by name', async (t) => {
  const made = await world(t)
  const stored = await saveCurationProposal({
    dataRoot: made.dataRoot,
    now: NOW,
    projectId: made.binding.projectId,
    itemKey: 'item:corrupt',
    kind: 'supersede',
    sources: [],
    operation: {
      kind: 'supersede',
      supersedesId: 'dec-99999999-9999-4999-8999-999999999999',
      item: { title: 'x' },
    },
  })
  const directory = join(made.dataRoot, 'curation', 'proposals', made.binding.projectId)
  await writeFile(join(directory, `${stored.proposalId}.json`), '{ not json', 'utf8')
  await assert.rejects(
    () =>
      readCurationProposal({
        dataRoot: made.dataRoot,
        projectId: made.binding.projectId,
        proposalId: stored.proposalId,
      }),
    (error) => {
      assert.equal(error.name, 'CurationStateError')
      assert.equal(error.code, 'state-corrupt')
      return true
    },
  )
  // A damaged record is reported by a listing too, never silently counted as a
  // proposal a human could approve.
  const listed = await listCurationProposals({
    dataRoot: made.dataRoot,
    projectId: made.binding.projectId,
    now: NOW,
  })
  assert.deepEqual(listed.unreadable, [stored.proposalId])
  assert.equal(listed.total, 0)
})

test('the store refuses a data root or a project id it cannot place private state under', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'obsidian-mem-t3-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 4 }))
  await assert.rejects(
    () =>
      saveCurationProposal({
        dataRoot: 'relative/path',
        projectId: '1c392abb-7b08-42f7-871d-2a379caf9448',
        itemKey: 'item:x',
        kind: 'supersede',
        sources: [],
      }),
    (error) => {
      assert.equal(error.name, 'RangeError')
      return true
    },
  )
  await assert.rejects(
    () =>
      saveCurationProposal({
        dataRoot: root,
        projectId: 'not-a-uuid',
        itemKey: 'item:x',
        kind: 'supersede',
        sources: [],
      }),
    (error) => {
      assert.equal(error.name, 'RangeError')
      return true
    },
  )
})

test('proposals live beside, not inside, the scan records', async (t) => {
  const made = await world(t)
  await scan(made, made.binding)
  const record = await readScanRecord(made.dataRoot, made.binding.projectId, made.seed.path)
  assert.notEqual(record, null, 'the scanner state exists')
  assert.equal(
    curationRecordDir(made.dataRoot, made.binding.projectId).includes('proposals'),
    false,
  )

  await saveCurationProposal({
    dataRoot: made.dataRoot,
    now: NOW,
    projectId: made.binding.projectId,
    itemKey: 'item:beside',
    kind: 'supersede',
    sources: [],
    operation: {
      kind: 'supersede',
      supersedesId: 'dec-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      item: { title: '旁邻' },
    },
  })
  assert.equal(
    (await readdir(join(made.dataRoot, 'curation'))).sort().includes('proposals'),
    true,
    'the proposal directory is a sibling of the scanner state',
  )
  // Both stores keep working: a proposal write does not damage a scan record.
  const again = await readScanRecord(made.dataRoot, made.binding.projectId, made.seed.path)
  assert.equal(again.hash, record.hash)
})
