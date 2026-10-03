// Task 7: reviewing one parked proposal, and applying it through a transaction.
//
// A proposal exists because applying it is a *semantic* decision. This module is
// the half that lets a human make that decision and nothing else: it may apply
// exactly the operation the proposal carries, through the same transaction engine
// every other write uses, or it may refuse and change nothing. Everything here is
// one of four properties:
//
//   * **The write request is built from explicit fields.** `writeMemory` reads a
//     present `request.id` as "update this note", so a candidate that happens to
//     carry one would turn an approved create into an overwrite of an unrelated
//     note. R6: never spread the candidate.
//   * **A stale proposal never auto-rebases.** The proposal's own source hashes
//     travel into the transaction request as `expectedSourceHashes` and are
//     re-verified there, under the transaction's own vault lock. A mismatch
//     refuses and leaves the record pending for another review.
//   * **Only `create-separate` and `supersede` execute.** A finding is evidence,
//     never a plan, and a deletion has no generic apply at all.
//   * **A refused or rejected decision changes no source byte** and never marks an
//     unapplied proposal applied.
//
// Every case runs in the isolated world Task 1 built (a throwaway vault, Git
// repository and private data root), so nothing here can read or write the user's
// real home, vault or `$DSH_HOME`.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import ts from 'typescript'

import {
  CURATION_REVIEW_CODES,
  readCurationProposal,
  saveCurationProposal,
  snapshotProposalSources,
} from '../lib/curation-proposals.js'
import { applyReviewedMemory, reviewCurationProposal } from '../lib/curation-review.js'
import { withVaultLock } from '../lib/transaction.js'
import { resolveBinding } from '../lib/vault.js'
import { makeCurationWorld } from './curation-world.js'

/** One fixed clock, so every timestamp in a case is the same timestamp. */
const NOW = new Date('2026-10-03T04:00:00Z')
/** The other project these cases must never see. */
const OTHER_PROJECT = '6a1f0b52-0000-4000-8000-000000000001'
/**
 * The translation tables in `lib/curation-review.js` whose *values* are the answer
 * vocabulary: a key is an engine code, a value is what this module reports for it.
 */
const TABLE_NAMES = new Set(['STORE_CODES', 'TRANSACTION_CODES', 'MEMORY_CODES'])

/** The sha256 of a byte sequence. */
function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

/** The binding the world's writes created, resolved through the shipped seam. */
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

/** The `id` prefix of each type, as `lib/routing.js` fixes it. */
const PREFIXES = Object.freeze({
  doc: 'doc',
  decision: 'dec',
  gotcha: 'got',
  convention: 'con',
  glossary: 'glo',
  method: 'met',
})

/** One validated-looking distillation item, as `lib/distill.js` shapes it. */
function itemFixture(overrides = {}) {
  return {
    preassignedId: `${PREFIXES[overrides.type ?? 'decision']}-${randomUUID()}`,
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
 * Park one `supersede` proposal about the seed note, from the vault's own bytes.
 *
 * The sources are snapshotted through the store's own reader so the hashes a
 * review re-verifies are the hashes of the bytes on disk, not a literal this test
 * invented.
 */
async function parkSupersede(made, overrides = {}) {
  const item = itemFixture({ supersedesId: made.seed.id, ...(overrides.item ?? {}) })
  const proposal = await saveCurationProposal({
    dataRoot: made.dataRoot,
    now: NOW,
    projectId: made.binding.projectId,
    itemKey: item.idempotencyKey,
    kind: 'supersede',
    sources: await snapshotProposalSources(made.binding, {
      supersedesId: made.seed.id,
      twin: { id: made.seed.id, path: made.seed.path },
      home: made.home,
    }),
    operation: { kind: 'supersede', item, supersedesId: made.seed.id },
    evidence: item.evidenceSeqs,
    ...(overrides.details ?? {}),
  })
  return { proposal, item }
}

/** Park one `create-separate` proposal about the seed note (a twin, not a target). */
async function parkCreateSeparate(made, overrides = {}) {
  const item = itemFixture({
    type: 'gotcha',
    title: '新的踩坑标题',
    body: '新的踩坑正文。\n',
    ...(overrides.item ?? {}),
  })
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
    ...(overrides.details ?? {}),
  })
  return { proposal, item }
}

/** Every `.md` file under one directory, vault-relative, sorted. */
async function listMarkdown(directory) {
  const walk = async (base, prefix) => {
    let entries
    try {
      entries = await readdir(base, { withFileTypes: true })
    } catch {
      return []
    }
    const out = []
    for (const entry of entries) {
      const next = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) out.push(...(await walk(join(base, entry.name), next)))
      else if (entry.name.endsWith('.md')) out.push(next)
    }
    return out
  }
  return (await walk(directory, '')).sort()
}

/** Every note byte in the vault, keyed by path, so "no byte changed" is literal. */
async function vaultBytes(made) {
  const out = new Map()
  for (const relative of await listMarkdown(made.vault)) {
    out.set(relative, await readFile(join(made.vault, relative)))
  }
  return out
}

// ---------------------------------------------------------------------------
// The executable operations
// ---------------------------------------------------------------------------

test('an approved supersede creates the note, marks the old one, and records a receipt', async (t) => {
  const made = await world(t)
  const { proposal, item } = await parkSupersede(made)
  const old = await readFile(at(made, made.seed.path))

  const answer = await reviewCurationProposal({
    dataRoot: made.dataRoot,
    proposalId: proposal.proposalId,
    decision: 'apply',
    binding: made.binding,
    now: NOW,
  })
  assert.equal(answer.status, 'applied', JSON.stringify(answer))
  // `writeMemory` answers `{id, path, receipt}`, so the transaction receipt a
  // decision records is its `receipt` field — the same shape a direct write gets.
  assert.equal(answer.receipt.receipt.result.status, 'applied')
  assert.equal(answer.receipt.receipt.idempotencyKey, item.idempotencyKey)
  assert.equal(answer.receipt.id, item.preassignedId)

  const record = await readCurationProposal({
    dataRoot: made.dataRoot,
    projectId: made.binding.projectId,
    proposalId: proposal.proposalId,
  })
  assert.equal(record.state, 'applied')
  assert.equal(record.decidedAt, NOW.toISOString())

  // The new note exists under the candidate's own pre-assigned identity…
  const written = await made.services.read({ path: answer.receipt.path })
  assert.equal(written.frontmatter.id, item.preassignedId)
  assert.equal(written.frontmatter.supersedes, made.seed.id)
  // …and the superseded note still holds its own id, with its status moved.
  const after = await made.services.read({ path: made.seed.path })
  assert.equal(after.frontmatter.id, made.seed.id)
  assert.equal(after.frontmatter.status, 'superseded')
  assert.notDeepEqual(await readFile(at(made, made.seed.path)), old)
})

test('an approved create-separate publishes the candidate as a separate note', async (t) => {
  const made = await world(t)
  const { proposal, item } = await parkCreateSeparate(made)
  const before = await vaultBytes(made)

  const answer = await reviewCurationProposal({
    dataRoot: made.dataRoot,
    proposalId: proposal.proposalId,
    decision: 'apply',
    binding: made.binding,
    now: NOW,
  })
  assert.equal(answer.status, 'applied', JSON.stringify(answer))

  const written = await made.services.read({ path: answer.receipt.path })
  assert.equal(written.frontmatter.id, item.preassignedId)
  assert.equal(written.frontmatter.supersedes, null)

  const after = await vaultBytes(made)
  // Exactly one file appears, and it is the one the receipt names. Everything the
  // create is not allowed to touch is byte-identical: the seed note, the user's own
  // preferences file, and every other note.
  // The engine's own snapshot of the MOC it updated lives under `_meta/.history/`,
  // which is recovery material and not vault content.
  assert.deepEqual(
    [...after.keys()].filter((path) => !before.has(path) && !path.startsWith('_meta/.history/')),
    [answer.receipt.path],
    'exactly one new note is published',
  )
  for (const [path, bytes] of before) {
    // Two files are *expected* to move and are the create's own routed changes:
    // the directory's generated MOC gains the new link, and the append-only receipt
    // log gains this transaction's entry. Neither is another note's content.
    if (path.endsWith('/index.md') || path === '_meta/log.md') continue
    assert.deepEqual(after.get(path), bytes, `${path} changed`)
  }
  assert.notDeepEqual(
    after.get(`${made.binding.relativeDir}/Pitfalls/index.md`),
    before.get(`${made.binding.relativeDir}/Pitfalls/index.md`),
    'the generated MOC gained the new line',
  )
  assert.match(after.get('_meta/log.md').toString('utf8'), /新的踩坑标题/u)
})

test('R6: an id on the parked candidate never reaches the write request', async (t) => {
  // The dangerous shape: a distilled item that happens to carry the *seed note's*
  // id. `writeMemory` reads a present `id` as "update that note", so spreading the
  // candidate would rewrite the seed's body instead of publishing a new note — an
  // approved create silently becoming an overwrite of an unrelated file.
  const made = await world(t)
  const { proposal } = await parkSupersede(made, {
    item: { id: made.seed.id, type: 'decision' },
  })
  const old = await readFile(at(made, made.seed.path))

  const answer = await reviewCurationProposal({
    dataRoot: made.dataRoot,
    proposalId: proposal.proposalId,
    decision: 'apply',
    binding: made.binding,
    now: NOW,
  })
  assert.equal(answer.status, 'applied', JSON.stringify(answer))

  // The seed is an *update* (status → superseded), never a body overwrite, and the
  // new note carries the candidate's own pre-assigned identity.
  const seed = await made.services.read({ path: made.seed.path })
  assert.equal(seed.frontmatter.id, made.seed.id)
  assert.match(seed.body, /起点正文。/, 'the seed body must survive an approved create')
  assert.notDeepEqual(await readFile(at(made, made.seed.path)), old)
  const written = await made.services.read({ path: answer.receipt.path })
  assert.equal(written.frontmatter.id, proposal.operation.item.preassignedId)
})

test('a second approval of an applied proposal is refused, not applied twice', async (t) => {
  const made = await world(t)
  const { proposal } = await parkCreateSeparate(made)
  const first = await reviewCurationProposal({
    dataRoot: made.dataRoot,
    proposalId: proposal.proposalId,
    decision: 'apply',
    binding: made.binding,
    now: NOW,
  })
  assert.equal(first.status, 'applied')
  const after = await vaultBytes(made)

  const second = await reviewCurationProposal({
    dataRoot: made.dataRoot,
    proposalId: proposal.proposalId,
    decision: 'apply',
    binding: made.binding,
    now: NOW,
  })
  assert.equal(second.status, 'refused')
  assert.equal(second.code, 'proposal-not-current')
  assert.deepEqual(await vaultBytes(made), after, 'a repeated apply writes no byte')

  const third = await reviewCurationProposal({
    dataRoot: made.dataRoot,
    proposalId: proposal.proposalId,
    decision: 'reject',
    binding: made.binding,
    now: NOW,
  })
  assert.equal(third.status, 'refused')
  assert.equal(
    (
      await readCurationProposal({
        dataRoot: made.dataRoot,
        projectId: made.binding.projectId,
        proposalId: proposal.proposalId,
      })
    ).state,
    'applied',
    'a refused rejection never rewrites a decided proposal',
  )
})

// ---------------------------------------------------------------------------
// Refusals, each of which must change no source byte
// ---------------------------------------------------------------------------

test('an unknown proposal id is refused and nothing in the vault moves', async (t) => {
  const made = await world(t)
  const before = await vaultBytes(made)
  const answer = await reviewCurationProposal({
    dataRoot: made.dataRoot,
    proposalId: 'a'.repeat(64),
    decision: 'apply',
    binding: made.binding,
    now: NOW,
  })
  assert.equal(answer.status, 'refused')
  assert.equal(answer.code, 'proposal-missing')
  assert.deepEqual(await vaultBytes(made), before)
})

test('wrong project: the binding’s own project is the only one this may apply', async (t) => {
  const made = await world(t)
  const { proposal } = await parkCreateSeparate(made)
  const before = await vaultBytes(made)

  const answer = await reviewCurationProposal({
    dataRoot: made.dataRoot,
    proposalId: proposal.proposalId,
    // The proposal lives under the world's own project directory; this binding
    // names another, so the store itself cannot even find the record.
    binding: { ...made.binding, projectId: OTHER_PROJECT },
    decision: 'apply',
    now: NOW,
  })
  assert.equal(answer.status, 'refused')
  assert.equal(answer.code, 'proposal-missing')
  assert.deepEqual(await vaultBytes(made), before)

  const record = await readCurationProposal({
    dataRoot: made.dataRoot,
    projectId: made.binding.projectId,
    proposalId: proposal.proposalId,
  })
  assert.equal(record.state, 'pending', 'the proposal stays for the right project to review')
})

test('a source edited after the scan refuses the approval and keeps the record pending', async (t) => {
  // The stale-proposal case the plan names. The edit lands between the scan that
  // hashed it and the approval, so the decision refers to bytes nobody read.
  const made = await world(t)
  const { proposal } = await parkSupersede(made)
  const source = at(made, made.seed.path)
  await writeFile(source, `${await readFile(source, 'utf8')}尾注。\n`)
  const beforeReviewBytes = await readFile(source)

  const answer = await reviewCurationProposal({
    dataRoot: made.dataRoot,
    proposalId: proposal.proposalId,
    decision: 'apply',
    binding: made.binding,
    now: NOW,
  })
  assert.equal(answer.status, 'refused')
  assert.equal(answer.code, 'source-changed')
  assert.deepEqual(await readFile(source), beforeReviewBytes)

  const record = await readCurationProposal({
    dataRoot: made.dataRoot,
    projectId: made.binding.projectId,
    proposalId: proposal.proposalId,
  })
  assert.equal(record.state, 'pending', 'a stale proposal is never auto-rebased')
})

test('the evidence is re-verified by the engine, under its own lock', async (t) => {
  // The seam proves *where* the second check happens. `io.readFile` is the
  // transaction engine's own vault read, so a stub that answers other bytes for a
  // source makes the apply fail even though the file on disk is untouched: the
  // precondition is validated inside the transaction, not from a caller's earlier
  // read. Without the field the request would carry no evidence check at all and
  // this stub would change nothing.
  const made = await world(t)
  const { proposal } = await parkCreateSeparate(made)
  const before = await vaultBytes(made)
  const wrongBytes = { [made.seed.path]: Buffer.from('不是扫描时看到的那份字节\n') }
  const io = {
    readFile: (absolute, ...rest) => {
      for (const [relative, bytes] of Object.entries(wrongBytes)) {
        if (String(absolute).endsWith(relative.split('/').at(-1))) return Promise.resolve(bytes)
      }
      return readFile(absolute, ...rest)
    },
  }

  const answer = await reviewCurationProposal({
    dataRoot: made.dataRoot,
    proposalId: proposal.proposalId,
    decision: 'apply',
    binding: made.binding,
    now: NOW,
    io,
  })
  assert.equal(answer.status, 'refused', JSON.stringify(answer))
  assert.equal(answer.code, 'source-changed')
  assert.deepEqual(await vaultBytes(made), before, 'the refusal published nothing')
})

test('a source replaced by a symlink is refused before any write', async (t) => {
  const made = await world(t)
  const { proposal } = await parkCreateSeparate(made)
  const source = at(made, made.seed.path)
  const outside = join(made.root, 'outside.md')
  await writeFile(outside, '外部文件。\n')
  await symlink(outside, `${source}.link`)
  // Rewrite the proposal's own source list at the store's path, so the review is
  // asked about a path that is now a symlink out of the vault. The record is
  // written through the store's reader/writer pair rather than by hand.
  const storePath = join(
    made.dataRoot,
    'curation',
    'proposals',
    made.binding.projectId,
    `${proposal.proposalId}.json`,
  )
  const stored = JSON.parse(await readFile(storePath, 'utf8'))
  stored.sources = [{ id: null, path: `${made.seed.path}.link`, hash: sha256('外部文件。\n') }]
  await writeFile(storePath, `${JSON.stringify(stored, null, 2)}\n`)
  const before = await vaultBytes(made)

  const answer = await reviewCurationProposal({
    dataRoot: made.dataRoot,
    proposalId: proposal.proposalId,
    decision: 'apply',
    binding: made.binding,
    now: NOW,
  })
  assert.equal(answer.status, 'refused')
  assert.equal(answer.code, 'source-unsafe')
  assert.deepEqual(await vaultBytes(made), before)
})

test('a human-owned supersede target is refused by the executor', async (t) => {
  const made = await world(t)
  // A note the user wrote: `trust: owner` is a declaration this plugin obeys.
  const humanPath = made.seed.path.replace(/\.md$/u, '-human.md')
  await writeFile(
    at(made, humanPath),
    [
      '---',
      `id: doc-${randomUUID()}`,
      'type: doc',
      'title: "人手写的"',
      'trust: owner',
      'harness: dsh',
      '---',
      '人写的正文。\n',
    ].join('\n'),
  )
  const humanId = /id: (.+)/u.exec(await readFile(at(made, humanPath), 'utf8'))[1].trim()
  const item = itemFixture({ supersedesId: humanId })
  const proposal = await saveCurationProposal({
    dataRoot: made.dataRoot,
    now: NOW,
    projectId: made.binding.projectId,
    itemKey: item.idempotencyKey,
    kind: 'supersede',
    sources: await snapshotProposalSources(made.binding, {
      supersedesId: humanId,
      twin: { id: humanId, path: humanPath },
      home: made.home,
    }),
    operation: { kind: 'supersede', item, supersedesId: humanId },
  })
  const before = await vaultBytes(made)

  const answer = await reviewCurationProposal({
    dataRoot: made.dataRoot,
    proposalId: proposal.proposalId,
    decision: 'apply',
    binding: made.binding,
    now: NOW,
  })
  assert.equal(answer.status, 'refused', JSON.stringify(answer))
  assert.equal(answer.code, 'human-owned')
  assert.deepEqual(await vaultBytes(made), before)
})

test('a review-only finding has no apply path', async (t) => {
  const made = await world(t)
  const finding = await saveCurationProposal({
    dataRoot: made.dataRoot,
    now: NOW,
    projectId: made.binding.projectId,
    itemKey: `scan:dead-wikilink:${made.seed.path}`,
    kind: 'dead-wikilink',
    reviewOnly: true,
    reason: '一个指向不存在笔记的 wikilink',
    sources: await snapshotProposalSources(made.binding, {
      twin: { id: made.seed.id, path: made.seed.path },
      home: made.home,
    }),
  })
  assert.equal(finding.operation, null)
  const before = await vaultBytes(made)

  const answer = await reviewCurationProposal({
    dataRoot: made.dataRoot,
    proposalId: finding.proposalId,
    decision: 'apply',
    binding: made.binding,
    now: NOW,
  })
  assert.equal(answer.status, 'refused')
  assert.equal(answer.code, 'review-only')
  assert.deepEqual(await vaultBytes(made), before)
  assert.equal(
    (
      await readCurationProposal({
        dataRoot: made.dataRoot,
        projectId: made.binding.projectId,
        proposalId: finding.proposalId,
      })
    ).state,
    'pending',
  )
})

test('a deletion operation has no generic apply, and the executor refuses it by name', async (t) => {
  const made = await world(t)
  const before = await vaultBytes(made)
  await assert.rejects(
    () =>
      applyReviewedMemory(
        made.binding,
        {
          operation: { kind: 'delete', path: made.seed.path },
          idempotencyKey: 'delete:1',
        },
        { dataRoot: made.dataRoot, home: made.home, now: NOW },
      ),
    (error) => {
      assert.equal(error.code, 'operation-not-executable', error.message)
      return true
    },
  )
  assert.deepEqual(await vaultBytes(made), before)

  // No operation at all is a different answer: there is no plan here to refuse by
  // name, so the exported executor says the operation itself is unusable rather than
  // claiming it recognised a kind it never saw.
  await assert.rejects(
    () =>
      applyReviewedMemory(
        made.binding,
        { operation: null, idempotencyKey: 'review-only:1' },
        { dataRoot: made.dataRoot, home: made.home, now: NOW },
      ),
    (error) => {
      assert.equal(error.code, 'operation-invalid', error.message)
      return true
    },
  )
  assert.deepEqual(await vaultBytes(made), before)
})

test('a rejection marks the proposal rejected and changes no source byte', async (t) => {
  const made = await world(t)
  const { proposal } = await parkSupersede(made)
  const before = await vaultBytes(made)

  const answer = await reviewCurationProposal({
    dataRoot: made.dataRoot,
    proposalId: proposal.proposalId,
    decision: 'reject',
    binding: made.binding,
    now: NOW,
  })
  assert.equal(answer.status, 'rejected')
  assert.equal(answer.receipt, undefined)
  assert.equal(answer.code, undefined)

  const record = await readCurationProposal({
    dataRoot: made.dataRoot,
    projectId: made.binding.projectId,
    proposalId: proposal.proposalId,
  })
  assert.equal(record.state, 'rejected')
  assert.equal(record.decidedAt, NOW.toISOString())
  assert.deepEqual(await vaultBytes(made), before)

  const after = await reviewCurationProposal({
    dataRoot: made.dataRoot,
    proposalId: proposal.proposalId,
    decision: 'apply',
    binding: made.binding,
    now: NOW,
  })
  assert.equal(after.status, 'refused')
  assert.equal(after.code, 'proposal-not-current')
  assert.deepEqual(await vaultBytes(made), before)
})

// ---------------------------------------------------------------------------
// Concurrency, the lock, and what a committed transaction that cannot notify
// the index must leave behind
// ---------------------------------------------------------------------------

test('two concurrent reviewers of one proposal: one applies, one is refused', async (t) => {
  const made = await world(t)
  const { proposal } = await parkCreateSeparate(made)
  const review = (decision) =>
    reviewCurationProposal({
      dataRoot: made.dataRoot,
      proposalId: proposal.proposalId,
      decision,
      binding: made.binding,
      now: NOW,
    })

  const [first, second] = await Promise.all([review('apply'), review('apply')])
  const statuses = [first.status, second.status].sort()
  assert.deepEqual(statuses, ['applied', 'refused'], JSON.stringify([first, second]))
  const refused = [first, second].find((answer) => answer.status === 'refused')
  assert.equal(refused.code, 'proposal-not-current')

  // `index.md` is the directory's own MOC, created by bootstrap and rewritten by
  // no review: the count that matters is the notes beside it.
  const notes = (await listMarkdown(at(made, `${made.binding.relativeDir}/Pitfalls`))).filter(
    (name) => name !== 'index.md',
  )
  assert.deepEqual(notes.length, 1, `one note for one approved candidate, saw ${notes.join(', ')}`)
})

/**
 * A one-shot gate on the reviewed evidence read.
 *
 * The engine reads each `expectedSourceHashes` path inside the transaction, through
 * `io.readFile`, so a promise that resolves on that read is a seam *after* the review
 * took its claim and *before* it publishes. `release` lets the apply finish.
 *
 * @param {string} relative - the vault-relative source the apply will re-read.
 * @returns {{reached: Promise<void>, io: object, release: () => void}} the gate.
 */ function evidenceGate(relative) {
  const name = relative.split('/').at(-1)
  let arrived = null
  const reached = new Promise((resolve) => {
    arrived = resolve
  })
  let release = null
  const held = new Promise((resolve) => {
    release = resolve
  })
  let fired = false
  return {
    reached,
    release,
    io: {
      readFile: async (absolute, ...rest) => {
        if (!fired && String(absolute).endsWith(name)) {
          fired = true
          arrived()
          await held
        }
        return readFile(absolute, ...rest)
      },
    },
  }
}

test(
  'a rejection cannot take a proposal an apply is publishing',
  { timeout: 30_000 },
  async (t) => {
    // The interleaving Important 5 names: the apply has taken the claim and is between
    // its publish and its mark when a rejection arrives. Before this round the reject
    // branch ran before any claim, so it read the record `pending`, marked it
    // `rejected`, and the apply then refused *after* the note was on disk — a published
    // note behind a rejected record, and an undeclared `proposal-state` answer.
    const made = await world(t)
    const { proposal } = await parkCreateSeparate(made)
    const gate = evidenceGate(made.seed.path)
    const applying = reviewCurationProposal({
      dataRoot: made.dataRoot,
      proposalId: proposal.proposalId,
      decision: 'apply',
      binding: made.binding,
      now: NOW,
      io: gate.io,
    })
    await gate.reached
    // The claim is held while the apply is inside its transaction, so the reject is
    // refused before it can move the record.
    const rejected = await reviewCurationProposal({
      dataRoot: made.dataRoot,
      proposalId: proposal.proposalId,
      decision: 'reject',
      binding: made.binding,
      now: NOW,
    })
    assert.equal(rejected.status, 'refused', JSON.stringify(rejected))
    assert.equal(rejected.code, 'proposal-not-current')
    gate.release()
    const applied = await applying
    assert.equal(applied.status, 'applied', JSON.stringify(applied))

    const record = await readCurationProposal({
      dataRoot: made.dataRoot,
      projectId: made.binding.projectId,
      proposalId: proposal.proposalId,
    })
    assert.equal(record.state, 'applied', 'no rejection landed behind the apply')
    const notes = (await listMarkdown(at(made, `${made.binding.relativeDir}/Pitfalls`))).filter(
      (name) => name !== 'index.md',
    )
    assert.equal(notes.length, 1, 'exactly one note, and the record that decided it')
  },
)

test('a held vault lock refuses the review with the engine’s lock code', async (t) => {
  const made = await world(t)
  const { proposal } = await parkCreateSeparate(made)
  const before = await vaultBytes(made)

  const answer = await withVaultLock(
    made.binding,
    () =>
      reviewCurationProposal({
        dataRoot: made.dataRoot,
        proposalId: proposal.proposalId,
        decision: 'apply',
        binding: made.binding,
        now: NOW,
        lockTimeoutMs: 60,
        pollMs: 10,
      }),
    { dataRoot: made.dataRoot, home: made.home },
  )

  // The lock is not reentrant, so the nested review cannot take it and reports the
  // engine's own code rather than a second name for the same fact. Nothing is
  // written: the refusal happens before the transaction plans a single target.
  assert.equal(answer.status, 'refused', JSON.stringify(answer))
  assert.equal(answer.code, 'lock-timeout')
  assert.deepEqual(await vaultBytes(made), before)
  assert.equal(
    (
      await readCurationProposal({
        dataRoot: made.dataRoot,
        projectId: made.binding.projectId,
        proposalId: proposal.proposalId,
      })
    ).state,
    'pending',
  )
})

test('a committed apply whose index notification fails still records the applied proposal', async (t) => {
  const made = await world(t)
  const { proposal } = await parkCreateSeparate(made)

  const answer = await reviewCurationProposal({
    dataRoot: made.dataRoot,
    proposalId: proposal.proposalId,
    decision: 'apply',
    binding: made.binding,
    now: NOW,
    notifyIndex: () => {
      throw Object.assign(new Error('index unavailable'), { code: 'index-unavailable' })
    },
  })
  // The vault is committed, so the proposal is applied and the receipt says the
  // index is behind rather than claiming it was notified.
  assert.equal(answer.status, 'applied', JSON.stringify(answer))
  assert.equal(answer.receipt.receipt.result.index, 'stale')
  assert.equal(
    (
      await readCurationProposal({
        dataRoot: made.dataRoot,
        projectId: made.binding.projectId,
        proposalId: proposal.proposalId,
      })
    ).state,
    'applied',
  )
  const written = await made.services.read({ path: answer.receipt.path })
  assert.equal(written.frontmatter.id, proposal.operation.item.preassignedId)
})

test('a crash before the receipt is stored is replayed only by asking for recovery', async (t) => {
  // `failAfter: 'receipt'` interrupts *after* the manifest was written `committed`
  // and after the vault holds the new note, but *before* the receipt store learns the
  // idempotency key — the window `recover` exists for. `index-notify` (the earlier
  // value here) fires after both, so nothing about that case needed recovery at all.
  const made = await world(t)
  const { proposal } = await parkCreateSeparate(made)
  const attempt = (extra) =>
    reviewCurationProposal({
      dataRoot: made.dataRoot,
      proposalId: proposal.proposalId,
      decision: 'apply',
      binding: made.binding,
      now: NOW,
      ...extra,
    })

  await assert.rejects(
    () => attempt({ failAfter: 'receipt' }),
    (error) => {
      assert.equal(error.code, 'injected-failure', error.message)
      assert.equal(error.when, 'receipt')
      return true
    },
  )
  // The crash landed after the publish, so the note is already in the vault and the
  // record is still undecided — this is the window `recover` exists for.
  const afterCrash = (await listMarkdown(at(made, `${made.binding.relativeDir}/Pitfalls`))).filter(
    (name) => name !== 'index.md',
  )
  assert.deepEqual(
    afterCrash.length,
    1,
    `the crash published the note, saw ${afterCrash.join(', ')}`,
  )
  assert.equal(
    (
      await readCurationProposal({
        dataRoot: made.dataRoot,
        projectId: made.binding.projectId,
        proposalId: proposal.proposalId,
      })
    ).state,
    'pending',
    'the crash left the record undecided',
  )

  // A retry that does not ask for recovery cannot proceed, and it never will on its
  // own: the committed manifest still owes a receipt, so the retry is refused rather
  // than allowed to publish a second note. Two attempts, because "it refuses once"
  // would also be true of a transient failure.
  for (const round of ['first', 'second']) {
    const blocked = await attempt({})
    assert.equal(blocked.status, 'refused', `${round} retry: ${JSON.stringify(blocked)}`)
    assert.equal(blocked.code, 'proposal-not-current')
  }

  // The one retry that asks for recovery rolls the committed manifest forward and
  // replays the write, so the published note is the note that stands.
  const retry = await attempt({ recover: true })
  assert.equal(retry.status, 'applied', JSON.stringify(retry))
  const notes = (await listMarkdown(at(made, `${made.binding.relativeDir}/Pitfalls`))).filter(
    (name) => name !== 'index.md',
  )
  assert.deepEqual(notes.length, 1, `one note after a crash and a replay, saw ${notes.join(', ')}`)
  assert.deepEqual(
    notes,
    afterCrash,
    'recovery reused the published note instead of minting another',
  )
  const afterRetry = await vaultBytes(made)

  const replay = await attempt({})
  assert.equal(replay.status, 'refused')
  assert.equal(replay.code, 'proposal-not-current')
  assert.deepEqual(await vaultBytes(made), afterRetry, 'a refused replay writes no byte')
})
// ---------------------------------------------------------------------------
// The declared code vocabulary
// ---------------------------------------------------------------------------

test('every refusal code this module answers with is declared in one list', async (t) => {
  // The Step-1 cases each name a code. A code answered but not declared is a
  // vocabulary a caller cannot enumerate, and a declared code nothing answers is a
  // promise the module does not keep. Both directions are checked against observed
  // behaviour rather than against a second hand-copied list: every case below
  // produces its code, and the fall-through at the end fails the moment the module
  // answers with something not declared here.
  const made = await world(t)
  const observed = new Set()

  const refused = (answer) => {
    assert.equal(answer.status, 'refused', JSON.stringify(answer))
    observed.add(answer.code)
    return answer
  }
  const unknown = 'f'.repeat(64)
  refused(
    await reviewCurationProposal({
      dataRoot: made.dataRoot,
      proposalId: unknown,
      decision: 'apply',
      binding: made.binding,
      now: NOW,
    }),
  )
  assert.equal(observed.has('proposal-missing'), true)

  const applied = await parkCreateSeparate(made)
  const first = await reviewCurationProposal({
    dataRoot: made.dataRoot,
    proposalId: applied.proposal.proposalId,
    decision: 'apply',
    binding: made.binding,
    now: NOW,
  })
  assert.equal(first.status, 'applied', JSON.stringify(first))
  refused(
    await reviewCurationProposal({
      dataRoot: made.dataRoot,
      proposalId: applied.proposal.proposalId,
      decision: 'apply',
      binding: made.binding,
      now: NOW,
    }),
  )

  const finding = await saveCurationProposal({
    dataRoot: made.dataRoot,
    now: NOW,
    projectId: made.binding.projectId,
    itemKey: `scan:expired-review:${made.seed.path}`,
    kind: 'expired-review',
    reviewOnly: true,
    sources: await snapshotProposalSources(made.binding, {
      twin: { id: made.seed.id, path: made.seed.path },
      home: made.home,
    }),
  })
  refused(
    await reviewCurationProposal({
      dataRoot: made.dataRoot,
      proposalId: finding.proposalId,
      decision: 'apply',
      binding: made.binding,
      now: NOW,
    }),
  )

  // A `supersede` record whose operation was rewritten to a deletion: nothing the
  // store writes can produce this, which is the point — the executor refuses on the
  // operation, not on the path that produced the record.
  const { proposal: tampered } = await parkSupersede(made)
  const storePath = join(
    made.dataRoot,
    'curation',
    'proposals',
    made.binding.projectId,
    `${tampered.proposalId}.json`,
  )
  const stored = JSON.parse(await readFile(storePath, 'utf8'))
  stored.operation = { kind: 'delete', path: made.seed.path }
  await writeFile(storePath, `${JSON.stringify(stored, null, 2)}\n`)
  refused(
    await reviewCurationProposal({
      dataRoot: made.dataRoot,
      proposalId: tampered.proposalId,
      decision: 'apply',
      binding: made.binding,
      now: NOW,
    }),
  )

  const stale = await parkSupersede(made)
  await writeFile(at(made, made.seed.path), '被改写。\n')
  refused(
    await reviewCurationProposal({
      dataRoot: made.dataRoot,
      proposalId: stale.proposal.proposalId,
      decision: 'apply',
      binding: made.binding,
      now: NOW,
    }),
  )

  const symlinked = await parkCreateSeparate(made)
  const outside = join(made.root, 'outside-proof.md')
  await writeFile(outside, '外部。\n')
  await symlink(outside, `${at(made, made.seed.path)}.link`)
  const symlinkStore = join(
    made.dataRoot,
    'curation',
    'proposals',
    made.binding.projectId,
    `${symlinked.proposal.proposalId}.json`,
  )
  const symlinkRecord = JSON.parse(await readFile(symlinkStore, 'utf8'))
  symlinkRecord.sources = [{ id: null, path: `${made.seed.path}.link`, hash: sha256('外部。\n') }]
  await writeFile(symlinkStore, `${JSON.stringify(symlinkRecord, null, 2)}\n`)
  refused(
    await reviewCurationProposal({
      dataRoot: made.dataRoot,
      proposalId: symlinked.proposal.proposalId,
      decision: 'apply',
      binding: made.binding,
      now: NOW,
    }),
  )

  const humanPath = `${made.binding.relativeDir}/Docs/human-proof.md`
  await writeFile(
    at(made, humanPath),
    [
      '---',
      `id: doc-${randomUUID()}`,
      'type: doc',
      'title: "人手写的"',
      'trust: owner',
      'harness: dsh',
      '---',
      '人写的正文。\n',
    ].join('\n'),
  )
  const humanId = /^id: (.+)$/mu.exec(await readFile(at(made, humanPath), 'utf8'))[1].trim()
  const humanItem = itemFixture({ supersedesId: humanId })
  const human = await saveCurationProposal({
    dataRoot: made.dataRoot,
    now: NOW,
    projectId: made.binding.projectId,
    itemKey: humanItem.idempotencyKey,
    kind: 'supersede',
    sources: await snapshotProposalSources(made.binding, {
      supersedesId: humanId,
      twin: { id: humanId, path: humanPath },
      home: made.home,
    }),
    operation: { kind: 'supersede', item: humanItem, supersedesId: humanId },
  })
  refused(
    await reviewCurationProposal({
      dataRoot: made.dataRoot,
      proposalId: human.proposalId,
      decision: 'apply',
      binding: made.binding,
      now: NOW,
    }),
  )

  const locked = await parkCreateSeparate(made)
  refused(
    await withVaultLock(
      made.binding,
      () =>
        reviewCurationProposal({
          dataRoot: made.dataRoot,
          proposalId: locked.proposal.proposalId,
          decision: 'apply',
          binding: made.binding,
          now: NOW,
          lockTimeoutMs: 60,
          pollMs: 10,
        }),
      { dataRoot: made.dataRoot, home: made.home },
    ),
  )

  // `operation-invalid` also travels through a review: a record whose operation is not
  // an object at all reaches `applyReviewedMemory`, whose own request check names it —
  // the path the exported executor exists for.
  const malformed = await parkCreateSeparate(made)
  const malformedPath = join(
    made.dataRoot,
    'curation',
    'proposals',
    made.binding.projectId,
    `${malformed.proposal.proposalId}.json`,
  )
  const malformedRecord = JSON.parse(await readFile(malformedPath, 'utf8'))
  malformedRecord.operation = { kind: 'create-separate', item: null }
  await writeFile(malformedPath, `${JSON.stringify(malformedRecord, null, 2)}\n`)
  refused(
    await reviewCurationProposal({
      dataRoot: made.dataRoot,
      proposalId: malformed.proposal.proposalId,
      decision: 'apply',
      binding: made.binding,
      now: NOW,
    }),
  )

  // The store's own refused transition (`proposal-state`) is answered as
  // `proposal-not-current`: a rejection arriving while an apply holds the claim is
  // refused by the claim, which is the same fact about the same record.
  const gated = await parkCreateSeparate(made)
  const gate = evidenceGate(made.seed.path)
  const applying = reviewCurationProposal({
    dataRoot: made.dataRoot,
    proposalId: gated.proposal.proposalId,
    decision: 'apply',
    binding: made.binding,
    now: NOW,
    io: gate.io,
  })
  await gate.reached
  refused(
    await reviewCurationProposal({
      dataRoot: made.dataRoot,
      proposalId: gated.proposal.proposalId,
      decision: 'reject',
      binding: made.binding,
      now: NOW,
    }),
  )
  gate.release()
  assert.equal((await applying).status, 'applied')

  assert.deepEqual(
    [...observed].sort(),
    [...CURATION_REVIEW_CODES].sort(),
    'every declared code is answered by a case, and every answered code is declared',
  )
})

test('the review vocabulary and the module’s own emitters are the same set', () => {
  // The behavioural case above can only observe the codes its own drivers produce, so
  // on its own it cannot fail for a code the module answers and this file never
  // drives — the direction the finding named. This reads the module's source instead:
  // every code it passes to its own error constructor is an answer it can give, and so
  // is every value of the three translation tables `refusalCode` answers through. A
  // refusal added to the module and not declared fails here, and a declared code the
  // module cannot answer fails here too.
  const source = readFileSync(new URL('../lib/curation-review.js', import.meta.url), 'utf8')

  /**
   * Every code one module source can answer with: the constructor's first string
   * argument and every value of the named translation tables.
   *
   * @param {string} sourceText - the JavaScript.
   * @returns {Set<string>} the answered codes.
   */
  const answeredCodes = (sourceText) => {
    const file = ts.createSourceFile(
      'scan.js',
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    )
    const found = new Set()
    const walk = (node) => {
      if (ts.isNewExpression(node) && node.expression.getText(file) === 'CurationReviewError') {
        const code = node.arguments?.[0]
        // The code is a quoted string (`'operation-invalid'`) or a substitution-free
        // template; one with a `${}` in it is a message.
        if (code !== undefined && ts.isStringLiteralLike(code)) found.add(code.text)
      }
      // A refusal the function returns rather than throws is a `code: '…'` entry.
      if (
        ts.isPropertyAssignment(node) &&
        node.name.getText(file) === 'code' &&
        ts.isStringLiteralLike(node.initializer)
      ) {
        found.add(node.initializer.text)
      }
      // The tables' *values* are the answers (their keys are the engine's own codes).
      // They are declared as `Object.freeze({…})`, so the literal is reached through
      // the call; a spread or shorthand entry is not an answer and is skipped.
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const initializer =
          ts.isCallExpression(node.initializer) && node.initializer.arguments.length === 1
            ? node.initializer.arguments[0]
            : node.initializer
        if (TABLE_NAMES.has(node.name.text) && ts.isObjectLiteralExpression(initializer)) {
          for (const property of initializer.properties) {
            // The keys are *not* answers: a table maps an engine code to the one this
            // module reports for it, and only the reading side of that pair is a code
            // `CURATION_REVIEW_CODES` may declare.
            if (ts.isPropertyAssignment(property) && ts.isStringLiteral(property.initializer)) {
              found.add(property.initializer.text)
            }
          }
        }
      }
      ts.forEachChild(node, walk)
    }
    walk(file)
    return found
  }

  const answers = answeredCodes(source)
  assert.ok(answers.size > 0, 'the scan found no emitter, so this check would be vacuous')
  // `proposal-state` is a table *key*: the store's own refusal is reported under this
  // module's name for the same fact, so it is not part of the answer vocabulary and a
  // position here would be a promise nothing answers.
  assert.deepEqual(
    [...answers].sort(),
    [...CURATION_REVIEW_CODES].sort(),
    'the codes lib/curation-review.js can answer with must be exactly the declared list',
  )

  // The control: the same scan reports an answer the list does not declare, so the
  // case above is a check and not a restatement of the list.
  // The control changes a table *value*, which is the half that is an answer: the
  // replacement must be reported as an undeclared code.
  const control = source.replace(`'human-owned': 'human-owned',`, `'human-owned': 'undeclared-x',`)
  assert.notEqual(control, source, 'the control must actually change the source')
  const controlAnswers = answeredCodes(control)
  assert.deepEqual(
    [...controlAnswers].filter((code) => !CURATION_REVIEW_CODES.includes(code)),
    ['undeclared-x'],
    'an answered-but-undeclared code must be reported',
  )
})
