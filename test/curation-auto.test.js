// Task 1 (curation review panel): the bounded automatic reviewer.
//
// The reviewer is the one place a model may decide a parked candidate, so every
// case here is about a limit or a refusal rather than about intelligence:
//
//   * **The verdict contract is strict.** One JSON object, exactly three keys, an
//     enumerated verdict and a finite confidence in 0..1; prose, an extra key or a
//     guessed number refuses the whole answer and the row stays pending.
//   * **Only a confident `apply`/`reject` acts.** A `defer`, a low confidence or a
//     malformed answer changes no record and no note.
//   * **Evidence is re-read first.** A source whose hash moved retires the
//     candidate before any model call, because no decision could ever apply it.
//   * **Every call is bounded.** At most three proposals per pass, ≤ 12,000
//     characters of judge input, 45 s per call, and a missing route or service is
//     a stated no-op instead of an error.
//   * **A model failure is never a pass failure.** A stream that throws, aborts or
//     ends in `error` defers that proposal and keeps going.
//
// Every case runs in the isolated world `test/curation-world.js` builds: a real
// temporary vault, Git repository and private data root, with a fake `llm` whose
// stream is an async iterable exactly like the measured host service.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { test } from 'node:test'

import {
  AUTO_REVIEW_DEFAULTS,
  AUTO_REVIEW_SYSTEM_PROMPT,
  AutoReviewError,
  autoReviewPendingProposals,
  buildAutoReviewRequest,
  parseAutoReviewAnswer,
} from '../lib/curation-auto.js'
import {
  readCurationProposal,
  saveCurationProposal,
  snapshotProposalSources,
} from '../lib/curation-proposals.js'
import { createDiagnostics } from '../lib/debug.js'
import { resolveBinding } from '../lib/vault.js'
import { makeCurationWorld } from './curation-world.js'

/** One fixed clock, so every timestamp and every cap path is deterministic. */
const NOW = new Date('2026-10-03T04:00:00Z')
/** The route the cases configure; a background trigger only reads config. */
const ROUTE = Object.freeze({ provider: 'test-provider', model: 'test-model' })
/** What a strict verdict looks like. */
const ANSWER = (verdict, confidence = 0.95, reason = 'the evidence is clear') =>
  JSON.stringify({ verdict, confidence, reason })

/** The binding the world's first write created, through the shipped resolution. */
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

/** One world with one seed note and its binding. */
async function world(t) {
  const made = await makeCurationWorld(t)
  const seed = await made.services.write({ type: 'doc', title: '起点', body: '起点正文。\n' })
  return { ...made, binding: await bindingOf(made), seed }
}

/** The world's config with the explicit route a background reviewer requires. */
function routed(made, extra = {}) {
  return {
    ...made.config,
    autoReview: true,
    distill: { ...made.config.distill, provider: ROUTE.provider, model: ROUTE.model },
    ...extra,
  }
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

/** Park one executable `supersede` proposal about the seed note. */
async function parkSupersede(made, { now = NOW } = {}) {
  const item = itemFixture({ supersedesId: made.seed.id })
  const proposal = await saveCurationProposal({
    dataRoot: made.dataRoot,
    now,
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
  })
  return { proposal, item }
}

/** Park one executable `create-separate` proposal about a twin note. */
async function parkCreateSeparate(made, { now = NOW } = {}) {
  const item = itemFixture({ type: 'gotcha', title: '新的踩坑标题', body: '新的踩坑正文。\n' })
  const proposal = await saveCurationProposal({
    dataRoot: made.dataRoot,
    now,
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

/** One other project's id, for the cross-project isolation case. */
const OTHER_PROJECT = '6a1f0b52-0000-4000-8000-000000000001'

/** Park one review-only finding proposal: evidence a model must never judge. */
async function parkReviewOnly(made, { kind = 'expired-review', paths = [made.seed.path] } = {}) {
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

/** The absolute path of one stored proposal record. */
function recordFile(made, proposalId) {
  return join(made.dataRoot, 'curation', 'proposals', made.binding.projectId, `${proposalId}.json`)
}

/**
 * A fake `llm` service whose one stream is an async iterable, like the host's.
 *
 * `chunks` is the exact chunk sequence the reviewer reads; `calls` records every
 * request so a case can assert what the judge was actually sent.
 */
function fakeLlm(chunks, calls = []) {
  return {
    calls,
    stream: async function* (options) {
      calls.push(options)
      for (const chunk of chunks) {
        if (typeof chunk === 'function') yield chunk()
        else yield chunk
      }
    },
  }
}

/** The answer chunk sequence a stop-terminated stream ends with. */
function textAndFinish(text, reason = { kind: 'stop' }) {
  return [
    { type: 'text-delta', text },
    { type: 'finish', reason },
  ]
}

/** The judge text one captured call carried. */
function requestText(call) {
  return call.messages[0].content[0].text
}

/** The one pass summary a case expects when nothing should happen. */
function nothingSummary(reason) {
  return {
    status: 'skipped',
    reason,
    inspected: 0,
    applied: [],
    rejected: [],
    retired: [],
    deferred: [],
    refused: [],
    model: null,
    truncated: false,
  }
}

// ---------------------------------------------------------------------------
// The constants and the pure halves
// ---------------------------------------------------------------------------

test('AUTO_REVIEW_DEFAULTS is exactly the frozen measured bound set', () => {
  assert.deepEqual(AUTO_REVIEW_DEFAULTS, {
    maxPerPass: 3,
    minConfidence: 0.8,
    maxInputChars: 12000,
    timeoutMs: 45000,
    maxReasonChars: 500,
  })
  assert.equal(Object.isFrozen(AUTO_REVIEW_DEFAULTS), true)
  assert.equal(typeof AUTO_REVIEW_SYSTEM_PROMPT, 'string')
  assert.match(AUTO_REVIEW_SYSTEM_PROMPT, /defer/, 'the prompt says to defer rather than guess')
  assert.match(AUTO_REVIEW_SYSTEM_PROMPT, /"verdict"/)
  assert.match(AUTO_REVIEW_SYSTEM_PROMPT, /"confidence"/)
  assert.match(AUTO_REVIEW_SYSTEM_PROMPT, /"reason"/)
})

test('parseAutoReviewAnswer refuses every violation of the one-object contract', () => {
  assert.deepEqual(
    parseAutoReviewAnswer('{"verdict":"defer","confidence":0.4,"reason":"not sure"}'),
    {
      verdict: 'defer',
      confidence: 0.4,
      reason: 'not sure',
    },
  )
  const refused = [
    '',
    '   ',
    'I would apply this one.',
    '{"verdict":"apply","confidence":0.9,"reason":"x"} and some prose',
    '{"verdict":"apply","confidence":0.9,"reason":"x"} {}',
    '[]',
    '"apply"',
    'null',
  ]
  for (const text of refused) {
    assert.throws(() => parseAutoReviewAnswer(text), AutoReviewError, JSON.stringify(text))
  }
  const contractViolations = [
    // unknown verdict
    '{"verdict":"maybe","confidence":0.9,"reason":"x"}',
    // absent or non-numeric confidence
    '{"verdict":"apply","reason":"x"}',
    '{"verdict":"apply","confidence":"0.9","reason":"x"}',
    '{"verdict":"apply","confidence":null,"reason":"x"}',
    // confidence outside the contract's 0..1
    '{"verdict":"apply","confidence":1.5,"reason":"x"}',
    '{"verdict":"apply","confidence":-0.1,"reason":"x"}',
    // extra keys
    '{"verdict":"apply","confidence":0.9,"reason":"x","action":"write"}',
    // absent or non-string reason
    '{"verdict":"apply","confidence":0.9}',
    '{"verdict":"apply","confidence":0.9,"reason":7}',
  ]
  for (const text of contractViolations) {
    assert.throws(
      () => parseAutoReviewAnswer(text),
      (error) => {
        assert.equal(error.name, 'AutoReviewError', text)
        assert.equal(typeof error.code, 'string', text)
        return true
      },
      text,
    )
  }
  // The reason is bounded, never a reason to refuse the answer.
  const long = parseAutoReviewAnswer(
    ANSWER('defer', 0.1, 'r'.repeat(AUTO_REVIEW_DEFAULTS.maxReasonChars + 40)),
  )
  assert.equal(long.reason.length, AUTO_REVIEW_DEFAULTS.maxReasonChars)
})

test('buildAutoReviewRequest is pure and bounded by the judge input ceiling', () => {
  const proposal = {
    proposalId: 'a'.repeat(64),
    kind: 'supersede',
    reason: 'a distilled conclusion proposes to supersede an existing note',
    sources: [{ path: 'Projects/p--1/Docs/旧.md', hash: 'b'.repeat(64) }],
    operation: {
      kind: 'supersede',
      supersedesId: 'dec-11111111-1111-4111-8111-111111111111',
      item: {
        type: 'decision',
        title: '新结论',
        body: `候选正文。${'长'.repeat(AUTO_REVIEW_DEFAULTS.maxInputChars * 2)}`,
      },
    },
  }
  const target = {
    path: 'Projects/p--1/Docs/旧.md',
    title: '旧结论',
    status: 'active',
    body: '旧正文。\n',
  }
  const request = buildAutoReviewRequest({ proposal, target })
  assert.equal(request.system, AUTO_REVIEW_SYSTEM_PROMPT)
  assert.equal(typeof request.user, 'string')
  assert.ok([...request.user].length <= AUTO_REVIEW_DEFAULTS.maxInputChars)
  assert.match(request.user, /新结论/)
  assert.match(request.user, /候选正文/)
  assert.match(request.user, /Projects\/p--1\/Docs\/旧\.md/)
  assert.match(request.user, /旧结论/)
  assert.match(request.user, /旧正文/)
  // Pure: two builds of the same inputs are byte-identical.
  assert.deepEqual(buildAutoReviewRequest({ proposal, target }), request)
  // A create-separate judge request also names the twin note it would sit beside.
  const twin = buildAutoReviewRequest({
    proposal: {
      ...proposal,
      kind: 'near-duplicate',
      operation: { kind: 'create-separate', item: proposal.operation.item },
    },
    target: { ...target, path: 'Projects/p--1/Docs/孪生.md' },
  })
  assert.match(twin.user, /孪生\.md/)
  // No target at all is a bounded request, not a throw: the model is asked to
  // defer when it cannot see the note the candidate would touch.
  assert.ok([...buildAutoReviewRequest({ proposal, target: null }).user].length <= 12_000)
})

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

test('a confident apply decides the proposal through the one write path, with provenance', async (t) => {
  const made = await world(t)
  const { proposal, item } = await parkSupersede(made)
  const llm = fakeLlm(textAndFinish(ANSWER('apply')))

  const summary = await autoReviewPendingProposals({
    binding: made.binding,
    dataRoot: made.dataRoot,
    home: made.home,
    config: routed(made),
    llm,
    now: NOW,
  })
  assert.equal(summary.status, 'reviewed', JSON.stringify(summary))
  assert.equal(summary.model, `${ROUTE.provider}/${ROUTE.model}`)
  assert.equal(summary.inspected, 1)
  assert.deepEqual(summary.applied, [proposal.proposalId])
  assert.deepEqual(summary.rejected, [])
  assert.deepEqual(summary.deferred, [])
  assert.deepEqual(summary.refused, [])
  assert.equal(llm.calls.length, 1)

  const record = await readCurationProposal({
    dataRoot: made.dataRoot,
    projectId: made.binding.projectId,
    proposalId: proposal.proposalId,
  })
  assert.equal(record.state, 'applied')
  assert.equal(record.decidedBy, 'auto')
  assert.equal(record.decidedByModel, `${ROUTE.provider}/${ROUTE.model}`)
  assert.equal(record.decisionNote, 'the evidence is clear')
  // The reviewed write really landed: the superseded note moved and the candidate
  // was published under its own identity.
  const seed = await made.services.read({ path: made.seed.path })
  assert.equal(seed.frontmatter.status, 'superseded')
  assert.equal(
    summary.applied.length,
    1,
    'exactly one candidate is applied from one written answer',
  )
  assert.equal(record.operation.item.preassignedId, item.preassignedId)
})

test('a confident reject marks the candidate rejected and names the automatic reviewer', async (t) => {
  const made = await world(t)
  const { proposal } = await parkSupersede(made)
  const llm = fakeLlm(textAndFinish(ANSWER('reject', 0.9, 'the new body restates the old one')))
  const summary = await autoReviewPendingProposals({
    binding: made.binding,
    dataRoot: made.dataRoot,
    home: made.home,
    config: routed(made),
    llm,
    now: NOW,
  })
  assert.equal(summary.status, 'reviewed')
  assert.deepEqual(summary.rejected, [proposal.proposalId])
  const record = await readCurationProposal({
    dataRoot: made.dataRoot,
    projectId: made.binding.projectId,
    proposalId: proposal.proposalId,
  })
  assert.equal(record.state, 'rejected')
  assert.equal(record.decidedBy, 'auto')
  assert.equal(
    record.reason,
    'an automatic review rejected this candidate: the new body restates the old one',
  )
  assert.equal(record.decisionNote, 'the new body restates the old one')
  // A rejection writes no note byte.
  const seed = await made.services.read({ path: made.seed.path })
  assert.equal(seed.frontmatter.status, 'active')
})

test('a defer, a low confidence and a malformed answer leave the candidate pending', async (t) => {
  const cases = [
    ['defer', textAndFinish(ANSWER('defer', 0.99))],
    ['low confidence', textAndFinish(ANSWER('apply', 0.5))],
    ['malformed answer', textAndFinish('Yes, apply it.')],
    ['an exact-confidence threshold is still acting', textAndFinish(ANSWER('reject', 0.8))],
  ]
  for (const [label, chunks] of cases) {
    await t.test(label, async (t) => {
      const made = await world(t)
      const { proposal } = await parkSupersede(made)
      const before = await readFile(join(made.vault, ...made.seed.path.split('/')))
      const summary = await autoReviewPendingProposals({
        binding: made.binding,
        dataRoot: made.dataRoot,
        home: made.home,
        config: routed(made),
        llm: fakeLlm(chunks),
        now: NOW,
      })
      const record = await readCurationProposal({
        dataRoot: made.dataRoot,
        projectId: made.binding.projectId,
        proposalId: proposal.proposalId,
      })
      if (label.includes('still acting')) {
        assert.equal(record.state, 'rejected', 'confidence === minConfidence acts')
      } else {
        assert.equal(summary.status, 'reviewed')
        assert.deepEqual(summary.deferred, [proposal.proposalId], label)
        assert.deepEqual(summary.applied, [])
        assert.deepEqual(summary.rejected, [])
        assert.equal(record.state, 'pending', label)
        assert.deepEqual(
          await readFile(join(made.vault, ...made.seed.path.split('/'))),
          before,
          `${label} changed a note byte`,
        )
      }
    })
  }
})

test('R6: moved evidence retires the candidate before any model call', async (t) => {
  const made = await world(t)
  const { proposal } = await parkSupersede(made)
  // The seed is edited after the snapshot: no decision could ever apply it. The
  // bytes are written directly so the change is exactly a moved hash, not a second
  // transaction the review would have to reason about.
  const seedPath = join(made.vault, ...made.seed.path.split('/'))
  const edited = (await readFile(seedPath, 'utf8')) + '\n补充。\n'
  await writeFile(seedPath, edited, 'utf8')
  const llm = fakeLlm(textAndFinish(ANSWER('apply')))

  const summary = await autoReviewPendingProposals({
    binding: made.binding,
    dataRoot: made.dataRoot,
    home: made.home,
    config: routed(made),
    llm,
    now: NOW,
  })
  assert.equal(summary.status, 'reviewed')
  assert.deepEqual(summary.retired, [proposal.proposalId])
  assert.deepEqual(summary.applied, [])
  assert.deepEqual(summary.rejected, [])
  assert.equal(llm.calls.length, 0, 'moved evidence costs no model call')
  const record = await readCurationProposal({
    dataRoot: made.dataRoot,
    projectId: made.binding.projectId,
    proposalId: proposal.proposalId,
  })
  assert.equal(record.state, 'retired')
  assert.equal(
    record.retiredReason,
    'an automatic review found the evidence changed before a decision',
  )
  assert.equal(record.decidedBy, 'auto')
})

test('maxPerPass bounds one pass and takes the oldest candidates first', async (t) => {
  const made = await world(t)
  const first = await parkSupersede(made, { now: new Date(NOW.getTime() - 3000) })
  const second = await parkSupersede(made, { now: new Date(NOW.getTime() - 2000) })
  const third = await parkSupersede(made, { now: new Date(NOW.getTime() - 1000) })
  await parkSupersede(made, { now: NOW })
  const llm = fakeLlm(textAndFinish(ANSWER('defer', 0.1)))

  const summary = await autoReviewPendingProposals({
    binding: made.binding,
    dataRoot: made.dataRoot,
    home: made.home,
    config: routed(made),
    llm,
    now: NOW,
    maxPerPass: 2,
  })
  assert.equal(summary.status, 'reviewed')
  assert.equal(summary.inspected, 2)
  assert.equal(llm.calls.length, 2)
  assert.deepEqual(summary.deferred, [first.proposal.proposalId, second.proposal.proposalId])
  // The two youngest are untouched, not deferred: the pass never examined them.
  assert.equal(
    (
      await readCurationProposal({
        dataRoot: made.dataRoot,
        projectId: made.binding.projectId,
        proposalId: third.proposal.proposalId,
      })
    ).state,
    'pending',
  )
  // The default cap is 3: one pass never inspects more than the measured bound.
  assert.equal(AUTO_REVIEW_DEFAULTS.maxPerPass, 3)
})

test('the judge input is bounded by maxInputChars and names the twin note', async (t) => {
  const made = await world(t)
  const { item } = await parkCreateSeparate(made)
  const llm = fakeLlm(textAndFinish(ANSWER('defer', 0.1)))
  await autoReviewPendingProposals({
    binding: made.binding,
    dataRoot: made.dataRoot,
    home: made.home,
    config: routed(made),
    llm,
    now: NOW,
    maxInputChars: 600,
  })
  assert.equal(llm.calls.length, 1)
  const text = requestText(llm.calls[0])
  assert.ok([...text].length <= 600, `judge input was ${[...text].length} chars`)
  assert.match(text, /起点/, 'the twin note the candidate would sit beside is named')
  assert.equal(llm.calls[0].provider, ROUTE.provider)
  assert.equal(llm.calls[0].model, ROUTE.model)
  assert.equal(llm.calls[0].maxTokens > 0, true)
  assert.equal(typeof llm.calls[0].signal?.aborted, 'boolean')
  // The item itself is sanitized JSON, never a note body the script forgot to bound.
  assert.equal(item.type, 'gotcha')
})

test('R7: a disabled reviewer, a missing route and a missing service are stated no-ops', async (t) => {
  const made = await world(t)
  await parkSupersede(made)
  const base = {
    binding: made.binding,
    dataRoot: made.dataRoot,
    home: made.home,
    now: NOW,
  }
  // `autoReview: false` disables only the automatic half.
  assert.deepEqual(
    await autoReviewPendingProposals({
      ...base,
      config: routed(made, { autoReview: false }),
      llm: fakeLlm(textAndFinish(ANSWER('apply'))),
    }),
    nothingSummary('disabled'),
  )
  // No configured route.
  assert.deepEqual(
    await autoReviewPendingProposals({
      ...base,
      config: { ...made.config, autoReview: true },
      llm: fakeLlm(textAndFinish(ANSWER('apply'))),
    }),
    nothingSummary('no-route'),
  )
  // A service without `stream` — P0 measured it as absent during `apply`.
  assert.deepEqual(
    await autoReviewPendingProposals({ ...base, config: routed(made), llm: null }),
    nothingSummary('no-route'),
  )
  assert.deepEqual(
    await autoReviewPendingProposals({
      ...base,
      config: routed(made),
      llm: { stream: null },
    }),
    nothingSummary('no-route'),
  )
  // A half-configured route is "no route", never a guessed provider or model.
  assert.deepEqual(
    await autoReviewPendingProposals({
      ...base,
      config: routed(made, {
        distill: { ...made.config.distill, provider: 'only-provider', model: '' },
      }),
      llm: fakeLlm(textAndFinish(ANSWER('apply'))),
    }),
    nothingSummary('no-route'),
  )
  // An empty queue is free: no model call and no write.
  const emptyWorld = await world(t)
  const calls = []
  const empty = await autoReviewPendingProposals({
    binding: emptyWorld.binding,
    dataRoot: emptyWorld.dataRoot,
    home: emptyWorld.home,
    config: routed(emptyWorld),
    llm: fakeLlm(textAndFinish(ANSWER('apply')), calls),
    now: NOW,
  })
  assert.equal(empty.status, 'skipped')
  assert.equal(empty.reason, 'no-pending')
  assert.equal(calls.length, 0)
})

test('a model failure defers that candidate and never throws out of the pass', async (t) => {
  const cases = [
    ['terminal aborted chunk', textAndFinish(ANSWER('apply'), { kind: 'aborted' })],
    [
      'terminal error chunk',
      textAndFinish(ANSWER('apply'), { kind: 'error', failure: { code: 'NO_ADAPTER' } }),
    ],
    ['truncated answer', textAndFinish(ANSWER('apply'), { kind: 'max-tokens' })],
    [
      'a tool call is never a verdict',
      [
        { type: 'tool-call-delta', index: 0 },
        { type: 'finish', reason: { kind: 'tool-calls' } },
      ],
    ],
  ]
  for (const [label, chunks] of cases) {
    await t.test(label, async (t) => {
      const made = await world(t)
      const { proposal } = await parkSupersede(made)
      const summary = await autoReviewPendingProposals({
        binding: made.binding,
        dataRoot: made.dataRoot,
        home: made.home,
        config: routed(made),
        llm: fakeLlm(chunks),
        now: NOW,
      })
      assert.equal(summary.status, 'reviewed', label)
      assert.deepEqual(summary.deferred, [proposal.proposalId], label)
      assert.equal(
        (
          await readCurationProposal({
            dataRoot: made.dataRoot,
            projectId: made.binding.projectId,
            proposalId: proposal.proposalId,
          })
        ).state,
        'pending',
        label,
      )
    })
  }
  // A stream that throws mid-iteration is a model failure, not a pass failure.
  const made = await world(t)
  const { proposal } = await parkSupersede(made)
  const throwing = {
    stream: async function* () {
      yield { type: 'text-delta', text: '{"verdict":' }
      throw new Error('socket reset')
    },
  }
  const summary = await autoReviewPendingProposals({
    binding: made.binding,
    dataRoot: made.dataRoot,
    home: made.home,
    config: routed(made),
    llm: throwing,
    now: NOW,
  })
  assert.equal(summary.status, 'reviewed')
  assert.deepEqual(summary.deferred, [proposal.proposalId])
})

test('one pass records one content-free curation diagnostic with its counts', async (t) => {
  const made = await world(t)
  await parkSupersede(made)
  const diagnostics = createDiagnostics({})
  const summary = await autoReviewPendingProposals({
    binding: made.binding,
    dataRoot: made.dataRoot,
    home: made.home,
    config: routed(made),
    llm: fakeLlm(textAndFinish(ANSWER('apply'))),
    now: NOW,
    diagnostics,
  })
  assert.equal(summary.status, 'reviewed')
  const events = diagnostics.snapshot().events.filter((event) => event.event === 'curation')
  assert.equal(events.length, 1)
  assert.equal(events[0].outcome, 'auto-reviewed')
  assert.equal(events[0].hits, 1)
  assert.equal(events[0].attempts, 1)
  assert.equal(typeof events[0].ms, 'number')
  // No proposal id, path or note text reaches the ring — the journal aliases the
  // project id on its way to disk, which `test/diagnostic-codec.test.js` owns.
  const bytes = JSON.stringify(events)
  assert.equal(bytes.includes('Projects/'), false)
  assert.equal(bytes.includes('新结论'), false)
  assert.equal(bytes.includes('a'.repeat(64)), false)
})

// ---------------------------------------------------------------------------
// Fix round (review-host): failure containment, coverage facts, crash recovery
// ---------------------------------------------------------------------------

test('M1: a synchronous stream() throw defers the candidate instead of failing the pass', async (t) => {
  const made = await world(t)
  const { proposal } = await parkSupersede(made)
  // `llm.stream` itself throws, before returning anything: the pass must answer the
  // same as a mid-iteration throw — one deferred row, no exception out of the pass.
  const llm = {
    stream() {
      throw new Error('adapter busy')
    },
  }
  const summary = await autoReviewPendingProposals({
    binding: made.binding,
    dataRoot: made.dataRoot,
    home: made.home,
    config: routed(made),
    llm,
    now: NOW,
  })
  assert.equal(summary.status, 'reviewed', JSON.stringify(summary))
  assert.deepEqual(summary.deferred, [proposal.proposalId])
  assert.deepEqual(summary.refused, [])
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

test('M2: a JSON-valid record with a non-object operation is a refusal, not a pass abort', async (t) => {
  const made = await world(t)
  const { proposal } = await parkSupersede(made)
  // The store validates identity and state, not the operation shape: a hand-edited
  // record can be readable and still carry garbage. One such row must not block
  // every later pass from the oldest-first batch it keeps sorting into.
  const stored = JSON.parse(await readFile(recordFile(made, proposal.proposalId), 'utf8'))
  stored.operation = 7
  await writeFile(recordFile(made, proposal.proposalId), `${JSON.stringify(stored, null, 2)}\n`)
  const llm = fakeLlm(textAndFinish(ANSWER('apply')))

  const summary = await autoReviewPendingProposals({
    binding: made.binding,
    dataRoot: made.dataRoot,
    home: made.home,
    config: routed(made),
    llm,
    now: NOW,
  })
  assert.equal(summary.status, 'reviewed', JSON.stringify(summary))
  assert.deepEqual(summary.refused, [{ proposalId: proposal.proposalId, code: 'proposal-invalid' }])
  assert.deepEqual(summary.deferred, [])
  assert.equal(llm.calls.length, 0, 'no model call is spent on an unreadable operation')
  const record = JSON.parse(await readFile(recordFile(made, proposal.proposalId), 'utf8'))
  assert.equal(record.state, 'pending')
})

test('M4: a moved-evidence row with a committed application is left pending for recovery', async (t) => {
  await t.test('application evidence exists: refuse and keep the row pending', async (t) => {
    const made = await world(t)
    const { proposal } = await parkSupersede(made)
    const seedPath = join(made.vault, ...made.seed.path.split('/'))
    await writeFile(seedPath, `${await readFile(seedPath, 'utf8')}\n补充。\n`, 'utf8')
    const llm = fakeLlm(textAndFinish(ANSWER('apply')))
    const asked = []
    const summary = await autoReviewPendingProposals({
      binding: made.binding,
      dataRoot: made.dataRoot,
      home: made.home,
      config: routed(made),
      llm,
      now: NOW,
      // Injected seam: the real dependency reads the transaction ledger.
      hasEvidence: async (binding, key, options) => {
        asked.push({ projectId: binding.projectId, key, dataRoot: options?.dataRoot })
        return true
      },
    })
    assert.equal(summary.status, 'reviewed', JSON.stringify(summary))
    assert.deepEqual(summary.retired, [])
    assert.deepEqual(summary.refused, [
      { proposalId: proposal.proposalId, code: 'review-recovery-required' },
    ])
    assert.deepEqual(asked, [
      { projectId: made.binding.projectId, key: proposal.itemKey, dataRoot: made.dataRoot },
    ])
    assert.equal(llm.calls.length, 0)
    assert.equal(
      (
        await readCurationProposal({
          dataRoot: made.dataRoot,
          projectId: made.binding.projectId,
          proposalId: proposal.proposalId,
        })
      ).state,
      'pending',
      'a committed application is never retired as stale evidence',
    )
  })
  await t.test('the ledger cannot answer: fail closed, never retire', async (t) => {
    const made = await world(t)
    const { proposal } = await parkSupersede(made)
    const seedPath = join(made.vault, ...made.seed.path.split('/'))
    await writeFile(seedPath, `${await readFile(seedPath, 'utf8')}\n补充。\n`, 'utf8')
    const llm = fakeLlm(textAndFinish(ANSWER('apply')))
    const summary = await autoReviewPendingProposals({
      binding: made.binding,
      dataRoot: made.dataRoot,
      home: made.home,
      config: routed(made),
      llm,
      now: NOW,
      hasEvidence: async () => {
        throw new Error('lock timeout')
      },
    })
    assert.equal(summary.status, 'reviewed', JSON.stringify(summary))
    assert.deepEqual(summary.retired, [])
    assert.deepEqual(summary.refused, [
      { proposalId: proposal.proposalId, code: 'review-recovery-required' },
    ])
    assert.equal(llm.calls.length, 0)
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
  await t.test('no application evidence: retire as R6 requires', async (t) => {
    const made = await world(t)
    const { proposal } = await parkSupersede(made)
    const seedPath = join(made.vault, ...made.seed.path.split('/'))
    await writeFile(seedPath, `${await readFile(seedPath, 'utf8')}\n补充。\n`, 'utf8')
    const summary = await autoReviewPendingProposals({
      binding: made.binding,
      dataRoot: made.dataRoot,
      home: made.home,
      config: routed(made),
      llm: fakeLlm(textAndFinish(ANSWER('apply'))),
      now: NOW,
      hasEvidence: async () => false,
    })
    assert.deepEqual(summary.retired, [proposal.proposalId])
    assert.deepEqual(summary.refused, [])
    assert.equal(
      (
        await readCurationProposal({
          dataRoot: made.dataRoot,
          projectId: made.binding.projectId,
          proposalId: proposal.proposalId,
        })
      ).state,
      'retired',
    )
  })
})

test('M5: the auto pass surfaces the 200-row listing cap as truncated', async (t) => {
  const made = await world(t)
  // 201 pending executable rows: the newest-200 listing is exactly the batch a pass
  // reads, so the oldest row is invisible — the summary must say so rather than
  // presenting a starvation as a clean pass.
  for (let index = 0; index < 201; index += 1) {
    await parkSupersede(made, { now: new Date(NOW.getTime() + index) })
  }
  const summary = await autoReviewPendingProposals({
    binding: made.binding,
    dataRoot: made.dataRoot,
    home: made.home,
    config: routed(made),
    llm: fakeLlm(textAndFinish(ANSWER('defer', 0.1))),
    now: NOW,
  })
  assert.equal(summary.status, 'reviewed')
  assert.equal(summary.truncated, true, 'the capped listing is reported, not hidden')
  assert.equal(summary.inspected, 3, 'the per-pass bound still holds')
})

test('M7: review-only evidence rows are never judged', async (t) => {
  const made = await world(t)
  await parkReviewOnly(made)
  const llm = fakeLlm(textAndFinish(ANSWER('apply')))
  const summary = await autoReviewPendingProposals({
    binding: made.binding,
    dataRoot: made.dataRoot,
    home: made.home,
    config: routed(made),
    llm,
    now: NOW,
  })
  // A queue with only evidence is "nothing this pass may judge", not a model call.
  assert.equal(summary.status, 'skipped')
  assert.equal(summary.reason, 'no-pending')
  assert.equal(llm.calls.length, 0)
})

test('M7: a pass never inspects another project’s queue', async (t) => {
  const made = await world(t)
  const { proposal } = await parkSupersede(made)
  // A same-data-root record for a different project: the bound project's pass must
  // not read it, decide it, or spend a call on it.
  const foreign = await saveCurationProposal({
    dataRoot: made.dataRoot,
    now: NOW,
    projectId: OTHER_PROJECT,
    itemKey: `item:${randomUUID()}`,
    kind: 'supersede',
    sources: [{ id: null, path: 'Projects/other--deadbeef/Docs/foreign.md', hash: 'a'.repeat(64) }],
    operation: {
      kind: 'supersede',
      supersedesId: 'dec-66666666-6666-4666-8666-666666666666',
      item: itemFixture(),
    },
  })
  const llm = fakeLlm(textAndFinish(ANSWER('apply')))
  const summary = await autoReviewPendingProposals({
    binding: made.binding,
    dataRoot: made.dataRoot,
    home: made.home,
    config: routed(made),
    llm,
    now: NOW,
  })
  assert.equal(summary.inspected, 1)
  assert.deepEqual(summary.applied, [proposal.proposalId])
  assert.equal(llm.calls.length, 1)
  assert.equal(
    (
      await readCurationProposal({
        dataRoot: made.dataRoot,
        projectId: OTHER_PROJECT,
        proposalId: foreign.proposalId,
      })
    ).state,
    'pending',
    'another project’s candidate is untouched',
  )
})

test('M7: the 45 s clock composes with the pass signal through AbortSignal.any', async (t) => {
  const made = await world(t)
  const { proposal } = await parkSupersede(made)
  // The stream waits on the composed signal; aborting the pass must end the call,
  // and the terminal aborted chunk must defer the row rather than throw.
  const llm = {
    stream: async function* (options) {
      await new Promise((resolve) => {
        if (options.signal.aborted) return resolve()
        options.signal.addEventListener('abort', resolve, { once: true })
      })
      yield { type: 'finish', reason: { kind: 'aborted' } }
    },
  }
  const controller = new AbortController()
  const running = autoReviewPendingProposals({
    binding: made.binding,
    dataRoot: made.dataRoot,
    home: made.home,
    config: routed(made),
    llm,
    now: NOW,
    signal: controller.signal,
    timeoutMs: 1000,
  })
  setTimeout(() => controller.abort(), 10)
  const summary = await running
  assert.equal(summary.status, 'reviewed', JSON.stringify(summary))
  assert.deepEqual(summary.deferred, [proposal.proposalId])
})
