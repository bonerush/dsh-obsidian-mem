// Task 15: the tool-free LLM distillation call, strict JSON and evidence
// validation.
//
// The cases here pin the contract the rest of P3 depends on:
//
//   * **The request is bounded, tool-free and routed.** One `llm.stream()`
//     object argument (`{provider,model,messages,system,maxTokens,signal}`,
//     never `stream(prompt, options)`), no tool schema at all, the input clamped
//     to `distill.maxInputChars`, `maxTokens` mapped from
//     `distill.maxOutputTokens`, and a timeout composed with the caller's
//     signal. A missing `llm` service or route is `{state:'deferred'}` and the
//     job file is left byte-for-byte alone.
//   * **Cancellation and timeout are terminal chunks, not throws.** Both cases
//     are driven by a stub that yields `finish.reason.kind === 'aborted'` with
//     the SAME `failure.message` ("aborted by caller") as `docs/p0-compatibility.md`
//     §8 measured, and the test asserts the two are told apart by
//     `signal.reason.name` alone (`AbortError` vs `TimeoutError`).
//   * **Evidence rules.** Only seqs drawn from the job's own `allowedEvents`
//     count; an unknown seq, a disallowed type and over-long output refuse the
//     whole output, while a foreign supersede target refuses only its own item
//     (prose that merely mentions a path costs nothing), and the model can never
//     promote its own claim: `accepted` without a user seq becomes
//     `provisional`, `observed` without an independently verified tool result
//     becomes `inferred`.
//   * **The two durability barriers.** The complete raw output is written to the
//     0600 pending job (`raw-durable`) BEFORE validation, and the validated
//     items (`validated`) before anything could write a vault. A restart
//     re-validates the persisted raw — or reuses the persisted
//     `preassignedId`/`idempotencyKey` byte-identically — without a second
//     model call.
//
// Every case works under an explicit `mkdtemp` queue root, and the containment
// case proves `DSH_HOME` is never consulted: no test here can write the real
// `~/.dsh` or a real vault.
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  DistillError,
  distillCandidates,
  distillSettings,
  runPendingJob,
  validateDistillation,
} from '../lib/distill.js'
import { isValidNoteId } from '../lib/routing.js'
import {
  JOB_FILE_MODE,
  PENDING_SCHEMA,
  loadPending,
  persistJobOutput,
  writeJobAtomic,
} from '../lib/pending.js'

/** Fixed, valid UUIDv4 identity (version nibble `4`, variant nibble `8`). */
const PROJECT_ID = '1c392abb-7b08-42f7-871d-2a379caf9448'
const SESSION_ID = 'session-9d4a4c1e-2f1a-4f4e-8b3a-000000000001'
const TO_SEQ = 7
const JOB_ID = 'job-0123456789abcdef0123456789abcdef'

/** The whitelisted evidence `capture.js` stores: user, two tool runs, final text. */
const ALLOWED = Object.freeze([
  { kind: 'user', seq: 2, source: 'user' },
  { kind: 'tool', seq: 4, name: 'bash', ok: true },
  { kind: 'tool', seq: 5, name: 'bash', ok: false },
  { kind: 'assistant-final', seq: 6 },
])

const CONFIG = Object.freeze({
  distill: {
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    maxItems: 12,
    minConfidence: 0.75,
    maxInputChars: 24000,
    maxOutputTokens: 4000,
    timeoutMs: 60000,
    maxRetries: 3,
    dryRun: false,
  },
})

/** The shape `enqueueTurn` is contracted to produce. */
function jobFixture(overrides = {}) {
  return {
    schema: PENDING_SCHEMA,
    jobId: JOB_ID,
    sessionId: SESSION_ID,
    projectId: PROJECT_ID,
    fromSeq: 1,
    toSeq: TO_SEQ,
    state: 'pending',
    route: { provider: 'deepseek-official', model: 'deepseek-flash' },
    allowedEvents: [...ALLOWED],
    safeInput:
      '[obsidian-mem pending] session=… project=… turn=1 seq 1-7\n--- user (seq 2) ---\n把调度器改成可插拔后端\n',
    credentialSkips: 0,
    omitted: null,
    attempts: 0,
    output: null,
    createdAt: '2026-09-23T00:00:00.000Z',
    updatedAt: '2026-09-23T00:00:00.000Z',
    ...overrides,
  }
}

const JOB = jobFixture()

/** A fresh private root; nothing in this file uses the process cwd or home. */
async function temporaryRoot(t, name = 'obsidian-mem-t15-distill-') {
  const root = await mkdtemp(join(tmpdir(), name))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 4 }))
  return root
}

/** A queue root plus the real persistence barrier bound to it. */
async function queueIn(t) {
  const queueRoot = join(await temporaryRoot(t), 'pending')
  return {
    queueRoot,
    persistOutput: (jobId, output) => persistJobOutput(jobId, output, { queueRoot }),
  }
}

// ---------------------------------------------------------------------------
// Item fixtures
// ---------------------------------------------------------------------------

/** One complete, well-formed decision item. */
function decisionItem(overrides = {}) {
  return {
    type: 'decision',
    title: '调度器改为可插拔后端',
    body: '结论与适用范围：调度器通过一个后端接口注册，默认实现不变。',
    tags: ['dsh-mem/decision'],
    confidence: 0.91,
    assertion: 'stated',
    status: 'accepted',
    supersedesId: null,
    evidenceSeqs: [2],
    ...overrides,
  }
}

/** The model output envelope. */
function json(items) {
  return JSON.stringify({ items })
}

/** A predicate that asserts a typed distillation refusal. */
function throwsCode(code) {
  return (error) => {
    assert.equal(
      error?.name,
      'DistillError',
      `expected a DistillError, got ${error?.name}: ${error?.message}`,
    )
    assert.equal(error.code, code, `expected code ${code}, got ${error.code}: ${error.message}`)
    return true
  }
}

/** One validated item, for the raw-output tests. */
function onlyItem(raw, job = JOB, config = CONFIG) {
  const items = validateDistillation(raw, job, config)
  assert.equal(items.length, 1)
  return items[0]
}

// ---------------------------------------------------------------------------
// Strict JSON: the envelope
// ---------------------------------------------------------------------------

test('an empty items array is a legal, empty distillation', () => {
  assert.deepEqual(validateDistillation('{"items":[]}', JOB, CONFIG), [])
})

test('a non-JSON model output is refused as not-json', () => {
  assert.throws(
    () => validateDistillation('I could not find anything durable.', JOB, CONFIG),
    throwsCode('not-json'),
  )
  assert.throws(() => validateDistillation('{"items":[}', JOB, CONFIG), throwsCode('not-json'))
})

test('a non-string raw value is refused', () => {
  assert.throws(() => validateDistillation(null, JOB, CONFIG), throwsCode('raw-invalid'))
  assert.throws(() => validateDistillation({ items: [] }, JOB, CONFIG), throwsCode('raw-invalid'))
})

test('an envelope with an extra field is refused, never silently ignored', () => {
  assert.throws(
    () => validateDistillation('{"items":[],"cost":0.5}', JOB, CONFIG),
    throwsCode('schema'),
  )
  assert.throws(
    () => validateDistillation('{"items":[],"notes":"hello"}', JOB, CONFIG),
    throwsCode('schema'),
  )
})

test('a missing or non-array items field is refused', () => {
  assert.throws(() => validateDistillation('{}', JOB, CONFIG), throwsCode('schema'))
  assert.throws(() => validateDistillation('{"items":{}}', JOB, CONFIG), throwsCode('schema'))
  assert.throws(() => validateDistillation('[]', JOB, CONFIG), throwsCode('schema'))
})

// ---------------------------------------------------------------------------
// Strict JSON: the item
// ---------------------------------------------------------------------------

test('the brief example: a doc item is refused with a message naming the type', () => {
  assert.throws(() => validateDistillation('{"items":[{"type":"doc"}]}', JOB, CONFIG), /type/)
  for (const type of ['doc', 'glossary', 'session-log', 'hub', 'method', 'invariant']) {
    assert.throws(
      () => validateDistillation(json([decisionItem({ type })]), JOB, CONFIG),
      throwsCode('type'),
    )
  }
})

test('an item with an extra field is refused (no free-form smuggling)', () => {
  assert.throws(
    () =>
      validateDistillation(
        json([{ ...decisionItem(), path: 'Projects/other--deadbeef/Decisions/ADR-9.md' }]),
        JOB,
        CONFIG,
      ),
    throwsCode('schema'),
  )
  assert.throws(
    () => validateDistillation(json([{ ...decisionItem(), applied: true }]), JOB, CONFIG),
    throwsCode('schema'),
  )
})

test('an item missing any contract field is refused', () => {
  for (const field of [
    'type',
    'title',
    'body',
    'tags',
    'confidence',
    'assertion',
    'status',
    'supersedesId',
    'evidenceSeqs',
  ]) {
    const item = decisionItem()
    delete item[field]
    assert.throws(
      () => validateDistillation(json([item]), JOB, CONFIG),
      throwsCode('schema'),
      `missing ${field}`,
    )
  }
})

test('malformed field values are refused', () => {
  assert.throws(
    () => validateDistillation(json([decisionItem({ title: '   ' })]), JOB, CONFIG),
    throwsCode('schema'),
  )
  assert.throws(
    () => validateDistillation(json([decisionItem({ body: '' })]), JOB, CONFIG),
    throwsCode('schema'),
  )
  assert.throws(
    () => validateDistillation(json([decisionItem({ tags: 'dsh-mem/decision' })]), JOB, CONFIG),
    throwsCode('schema'),
  )
  assert.throws(
    () => validateDistillation(json([decisionItem({ tags: [''] })]), JOB, CONFIG),
    throwsCode('schema'),
  )
  assert.throws(
    () => validateDistillation(json([decisionItem({ confidence: 'high' })]), JOB, CONFIG),
    throwsCode('schema'),
  )
  assert.throws(
    () => validateDistillation(json([decisionItem({ confidence: 1.5 })]), JOB, CONFIG),
    throwsCode('schema'),
  )
  assert.throws(
    () => validateDistillation(json([decisionItem({ confidence: -0.1 })]), JOB, CONFIG),
    throwsCode('schema'),
  )
  assert.throws(
    () => validateDistillation(json([decisionItem({ assertion: 'verified' })]), JOB, CONFIG),
    throwsCode('schema'),
  )
  assert.throws(
    () => validateDistillation(json([decisionItem({ status: 'done' })]), JOB, CONFIG),
    throwsCode('schema'),
  )
  assert.throws(
    () => validateDistillation(json([decisionItem({ evidenceSeqs: '2' })]), JOB, CONFIG),
    throwsCode('evidence'),
  )
  assert.throws(
    () => validateDistillation(json([decisionItem({ evidenceSeqs: [2.5] })]), JOB, CONFIG),
    throwsCode('evidence'),
  )
})

test('an oversize title, body, tag list or item count is refused', () => {
  assert.throws(
    () => validateDistillation(json([decisionItem({ title: 'x'.repeat(201) })]), JOB, CONFIG),
    throwsCode('item-too-long'),
  )
  assert.throws(
    () => validateDistillation(json([decisionItem({ body: 'x'.repeat(4001) })]), JOB, CONFIG),
    throwsCode('item-too-long'),
  )
  assert.throws(
    () =>
      validateDistillation(
        json([decisionItem({ tags: Array.from({ length: 17 }, (_, i) => `t${i}`) })]),
        JOB,
        CONFIG,
      ),
    throwsCode('item-too-long'),
  )
  const three = [
    decisionItem({ title: 'a' }),
    decisionItem({ title: 'b' }),
    decisionItem({ title: 'c' }),
  ]
  assert.throws(
    () => validateDistillation(json(three), JOB, { distill: { ...CONFIG.distill, maxItems: 2 } }),
    throwsCode('too-many-items'),
  )
})

test('an over-long raw output is refused before it is even parsed', () => {
  // The ceiling is derived from the permitted output tokens (a generous
  // 8 code points per token), so 128 tokens caps the raw text at 1024.
  const config = { distill: { ...CONFIG.distill, maxOutputTokens: 128 } }
  const padding = 'x'.repeat(1100)
  const raw = json([decisionItem({ tags: [], body: padding })])
  assert.ok(raw.length > 128 * 8)
  assert.throws(() => validateDistillation(raw, JOB, config), throwsCode('output-too-long'))
})

test('a supersedesId is null, a plugin-shaped note id, or a foreign target that drops the item', () => {
  assert.equal(onlyItem(json([decisionItem({ supersedesId: null })])).supersedesId, null)
  const valid = 'dec-5d46ff43-1bf8-496d-8b9f-c11e89d4e2aa'
  assert.equal(onlyItem(json([decisionItem({ supersedesId: valid })])).supersedesId, valid)

  // A supersede target the plugin would act on but cannot resolve inside this
  // project refuses the ITEM, never the whole turn.
  for (const supersedesId of [
    'Projects/x--ffffffff/Decisions/ADR-1.md',
    '/etc/passwd',
    '~/.dsh/x.md',
    '../secret/notes.md',
    '_meta/user.md',
    'Methods/调度器.md',
  ]) {
    assert.deepEqual(
      validateDistillation(json([decisionItem({ supersedesId })]), JOB, CONFIG),
      [],
      supersedesId,
    )
  }

  // Anything else is not a target at all: it is a malformed contract.
  for (const supersedesId of [
    'dec-not-a-uuid',
    '见 ADR-1',
    `Projects/demo--${PROJECT_ID.slice(0, 8)}/Decisions/ADR-1.md`,
    7,
    true,
    '',
  ]) {
    assert.throws(
      () => validateDistillation(json([decisionItem({ supersedesId })]), JOB, CONFIG),
      throwsCode('schema'),
      String(supersedesId),
    )
  }
})

// ---------------------------------------------------------------------------
// Evidence: only the job's own committed seqs count
// ---------------------------------------------------------------------------

test('evidence is mandatory: an empty evidenceSeqs list is refused', () => {
  assert.throws(
    () => validateDistillation(json([decisionItem({ evidenceSeqs: [] })]), JOB, CONFIG),
    throwsCode('evidence'),
  )
})

test('a seq outside allowedEvents is refused even when it is inside the job range', () => {
  // seq 3 and seq 7 are inside [fromSeq,toSeq] but were never whitelisted.
  for (const seq of [3, 7, 0, 999]) {
    assert.throws(
      () => validateDistillation(json([decisionItem({ evidenceSeqs: [seq] })]), JOB, CONFIG),
      throwsCode('evidence'),
    )
  }
  assert.throws(
    () => validateDistillation(json([decisionItem({ evidenceSeqs: [2, 7] })]), JOB, CONFIG),
    throwsCode('evidence'),
  )
})

test('every allowed seq is accepted, and repeated seqs are refused', () => {
  assert.equal(
    onlyItem(json([decisionItem({ evidenceSeqs: [2, 4, 5, 6] })])).evidenceSeqs.length,
    4,
  )
  assert.throws(
    () => validateDistillation(json([decisionItem({ evidenceSeqs: [2, 2] })]), JOB, CONFIG),
    throwsCode('evidence'),
  )
})

// ---------------------------------------------------------------------------
// Paths: prose never costs a candidate; only a foreign acted-on target does
// ---------------------------------------------------------------------------

/** The path shapes that must never be acted on outside this project. */
const FOREIGN_PATHS = [
  'Projects/other--deadbeef/Decisions/ADR-1.md',
  'Projects/x--ffffffff/Conventions/a.md',
  '/etc/passwd',
  '~/.dsh/data/obsidian-mem/pending/x.json',
  'C:\\Users\\me\\notes.md',
  '../secret/notes.md',
  '_meta/user.md',
  '_meta/registry.md',
  'Methods/调度器后端.md',
]

test('prose mentions of foreign or vault-level paths never cost a candidate', () => {
  // The narrowing: a body that merely MENTIONS `_meta/log.md` (or any other
  // path) is ordinary text — the plugin acts on no path from it, so refusing
  // the turn over a wording accident is memory loss.
  for (const mention of FOREIGN_PATHS) {
    const body = `记录在 ${mention} 的旁注里，与结论无关。`
    const items = validateDistillation(json([decisionItem({ body })]), JOB, CONFIG)
    assert.equal(items.length, 1, mention)
    assert.equal(items[0].body, body)
  }
  const wikilink = '见 [[Projects/other--deadbeef/Decisions/ADR-1]]'
  assert.equal(onlyItem(json([decisionItem({ body: wikilink })])).body, wikilink)
  assert.equal(
    validateDistillation(
      json([decisionItem({ title: '见 Projects/x--ffffffff/Conventions/a.md' })]),
      JOB,
      CONFIG,
    ).length,
    1,
  )
  assert.equal(
    validateDistillation(
      json([decisionItem({ tags: ['Projects/other--deadbeef/Decisions'] })]),
      JOB,
      CONFIG,
    ).length,
    1,
  )
})

test('a body that mentions _meta/log.md survives alongside its siblings', () => {
  const raw = json([
    decisionItem({ title: 'a', body: '结论一，记录在 _meta/log.md。' }),
    decisionItem({ title: 'b', body: '结论二，见 Projects/other--deadbeef/Decisions/ADR-1.md。' }),
    decisionItem({ title: 'c', body: '结论三，无路径。' }),
  ])
  assert.deepEqual(
    validateDistillation(raw, JOB, CONFIG).map((item) => item.title),
    ['a', 'b', 'c'],
  )
})

test('a foreign supersede target drops that item and leaves its siblings', () => {
  const raw = json([
    decisionItem({ title: 'a' }),
    decisionItem({ title: 'b', supersedesId: 'Projects/other--deadbeef/Decisions/ADR-1.md' }),
    decisionItem({ title: 'c' }),
  ])
  assert.deepEqual(
    validateDistillation(raw, JOB, CONFIG).map((item) => item.title),
    ['a', 'c'],
  )
  const { refused } = distillCandidates(raw, JOB, CONFIG)
  assert.deepEqual(refused, [
    {
      index: 1,
      reason: 'foreign-target',
      field: 'supersedesId',
      value: 'Projects/other--deadbeef/Decisions/ADR-1.md',
    },
  ])
})

test('every foreign target class drops only its own item', () => {
  for (const target of FOREIGN_PATHS) {
    const raw = json([
      decisionItem({ title: 'drop', supersedesId: target }),
      decisionItem({ title: 'keep' }),
    ])
    assert.deepEqual(
      validateDistillation(raw, JOB, CONFIG).map((item) => item.title),
      ['keep'],
      target,
    )
  }
})

test('a malformed output is never salvaged by dropping a foreign-target sibling', () => {
  const dropped = decisionItem({ supersedesId: 'Projects/x--ffffffff/Decisions/a.md' })
  assert.throws(() => validateDistillation('not json', JOB, CONFIG), throwsCode('not-json'))
  assert.throws(
    () => validateDistillation(json([dropped, { type: 'doc' }]), JOB, CONFIG),
    throwsCode('type'),
  )
  assert.throws(
    () =>
      validateDistillation(
        json([dropped, decisionItem({ title: 'bad', evidenceSeqs: [999] })]),
        JOB,
        CONFIG,
      ),
    throwsCode('evidence'),
  )
  assert.throws(
    () =>
      validateDistillation(
        json([dropped, { ...decisionItem({ title: 'x' }), extra: 1 }]),
        JOB,
        CONFIG,
      ),
    throwsCode('schema'),
  )
  assert.throws(
    () => validateDistillation(json([{ ...dropped, confidence: 3 }]), JOB, CONFIG),
    throwsCode('schema'),
  )
})

test("the job's own project path, a bare tag namespace and a URL are not paths out", () => {
  const body = `见 Projects/demo--${PROJECT_ID.slice(0, 8)}/Decisions/ADR-1.md 与 https://example.com/docs#x，另见 Decisions/ADR-2.md`
  const item = onlyItem(json([decisionItem({ body, tags: ['dsh-mem/decision', 'obsidian-mem'] })]))
  assert.equal(item.body, body)
})

// ---------------------------------------------------------------------------
// The model may not promote its own claims
// ---------------------------------------------------------------------------

test('observed without an independently verified tool result is downgraded to inferred', () => {
  const narrative = onlyItem(
    json([decisionItem({ assertion: 'observed', status: 'proposed', evidenceSeqs: [6] })]),
  )
  assert.equal(narrative.assertion, 'inferred')
  assert.deepEqual(narrative.downgrades, ['observed-without-verification'])

  // A FAILED tool run is not independent verification either.
  const failedTool = onlyItem(
    json([decisionItem({ assertion: 'observed', status: 'proposed', evidenceSeqs: [5] })]),
  )
  assert.equal(failedTool.assertion, 'inferred')
})

test('observed with a verified tool result is retained', () => {
  const item = onlyItem(
    json([decisionItem({ assertion: 'observed', status: 'proposed', evidenceSeqs: [4] })]),
  )
  assert.equal(item.assertion, 'observed')
  assert.deepEqual(item.downgrades, [])
})

test('both trust downgrades can apply to the same candidate', () => {
  const item = onlyItem(
    json([decisionItem({ assertion: 'observed', status: 'accepted', evidenceSeqs: [6] })]),
  )
  assert.equal(item.assertion, 'inferred')
  assert.equal(item.status, 'provisional')
  assert.deepEqual(item.downgrades, [
    'observed-without-verification',
    'accepted-without-user-confirmation',
  ])
})

test('accepted without explicit user confirmation is downgraded to provisional', () => {
  const fromFinalText = onlyItem(json([decisionItem({ status: 'accepted', evidenceSeqs: [6] })]))
  assert.equal(fromFinalText.status, 'provisional')
  assert.deepEqual(fromFinalText.downgrades, ['accepted-without-user-confirmation'])

  const fromToolRun = onlyItem(json([decisionItem({ status: 'accepted', evidenceSeqs: [4] })]))
  assert.equal(fromToolRun.status, 'provisional')
})

test('accepted with a real user seq is retained, and unrelated statuses are untouched', () => {
  const accepted = onlyItem(json([decisionItem({ status: 'accepted', evidenceSeqs: [2] })]))
  assert.equal(accepted.status, 'accepted')
  assert.deepEqual(accepted.downgrades, [])

  const proposed = onlyItem(json([decisionItem({ status: 'proposed', evidenceSeqs: [6] })]))
  assert.equal(proposed.status, 'proposed')
  assert.deepEqual(proposed.downgrades, [])
})

// ---------------------------------------------------------------------------
// Confidence routes to the inbox
// ---------------------------------------------------------------------------

test('low confidence goes to the inbox and cannot supersede an established conclusion', () => {
  const low = onlyItem(
    json([
      decisionItem({
        confidence: 0.5,
        supersedesId: 'dec-5d46ff43-1bf8-496d-8b9f-c11e89d4e2aa',
      }),
    ]),
  )
  assert.equal(low.inbox, true)
  assert.equal(low.supersedesId, null, 'an inbox candidate must not auto-supersede')
  assert.deepEqual(low.downgrades, ['inbox-supersede-cleared'])

  const atFloor = onlyItem(json([decisionItem({ confidence: 0.75 })]))
  assert.equal(atFloor.inbox, false, 'the floor itself is accepted')
  const below = onlyItem(json([decisionItem({ confidence: 0.74 })]))
  assert.equal(below.inbox, true)
  assert.deepEqual(below.downgrades, [])
})

test('minConfidence comes from config', () => {
  const config = { distill: { ...CONFIG.distill, minConfidence: 0.95 } }
  assert.equal(onlyItem(json([decisionItem({ confidence: 0.91 })]), JOB, config).inbox, true)
})

test('the resolved settings survive a resolved-settings hand-off (no silent default reset)', () => {
  // runPendingJob resolves the settings once and hands the result to
  // validateDistillation; that hand-off must not quietly restore the defaults.
  const settings = distillSettings({
    distill: { ...CONFIG.distill, maxItems: 1, minConfidence: 0.99 },
  })
  assert.equal(settings.maxItems, 1)
  assert.equal(distillSettings(settings).maxItems, 1)
  assert.equal(distillSettings(settings).minConfidence, 0.99)
  assert.deepEqual(distillSettings(settings).route, {
    provider: 'deepseek-official',
    model: 'deepseek-flash',
  })
  assert.throws(
    () =>
      validateDistillation(
        json([decisionItem({ title: 'a' }), decisionItem({ title: 'b' })]),
        JOB,
        settings,
      ),
    throwsCode('too-many-items'),
  )
  assert.equal(onlyItem(json([decisionItem({ confidence: 0.91 })]), JOB, settings).inbox, true)
})

// ---------------------------------------------------------------------------
// The validated item shape
// ---------------------------------------------------------------------------

test('a validated item carries the contract plus the routing decision', () => {
  const item = onlyItem(json([decisionItem()]))
  assert.deepEqual(Object.keys(item).sort(), [
    'assertion',
    'body',
    'confidence',
    'downgrades',
    'evidenceSeqs',
    'inbox',
    'status',
    'supersedesId',
    'tags',
    'title',
    'type',
  ])
  assert.equal(item.type, 'decision')
  assert.equal(item.inbox, false)
})

test('the default settings are the design defaults when config is absent', () => {
  const item = onlyItem(
    '{"items":[{"type":"gotcha","title":"x","body":"y","tags":[],"confidence":0.8,"assertion":"stated","status":"proposed","supersedesId":null,"evidenceSeqs":[2]}]}',
    JOB,
    undefined,
  )
  assert.equal(item.inbox, false)
})

// ---------------------------------------------------------------------------
// The model call: one call, bounded, tool-free, routed
// ---------------------------------------------------------------------------

/** A recording `llm` service whose `stream` returns the produced iterable. */
function recordingLlm(produce) {
  const calls = []
  return {
    calls,
    stream(options) {
      calls.push(options)
      return produce(options)
    },
  }
}

/** A successful text stream in the P0-measured chunk order. */
function textStream(
  text,
  usage = {
    inputTokens: 10,
    outputTokens: 20,
    totalTokens: 30,
    cacheReadTokens: 0,
    reasoningTokens: 0,
  },
) {
  return (async function* () {
    yield { type: 'block-start', index: 0, block: { type: 'text' } }
    yield { type: 'text-delta', index: 0, text: text.slice(0, 5) }
    yield { type: 'text-delta', index: 0, text: text.slice(5) }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
}

test('one model call: explicit route, bounded input/output, no tool schema at all', async (t) => {
  const { queueRoot, persistOutput } = await queueIn(t)
  await writeJobAtomic(queueRoot, jobFixture())
  const payload = json([decisionItem()])
  const llm = recordingLlm(() => textStream(payload))

  const result = await runPendingJob(jobFixture(), { llm, config: CONFIG, persistOutput })

  assert.equal(llm.calls.length, 1)
  const request = llm.calls[0]
  assert.deepEqual(Object.keys(request).sort(), [
    'maxTokens',
    'messages',
    'model',
    'provider',
    'signal',
    'system',
  ])
  assert.equal(request.provider, 'deepseek-official')
  assert.equal(request.model, 'deepseek-flash')
  assert.equal(request.maxTokens, CONFIG.distill.maxOutputTokens)
  assert.match(request.system, /JSON/)
  assert.match(request.system, /Do not request tools/)
  assert.equal(request.messages.length, 1)
  assert.equal(request.messages[0].role, 'user')
  assert.equal(typeof request.messages[0].id, 'string')
  assert.deepEqual(request.messages[0].content, [{ type: 'text', text: jobFixture().safeInput }])
  assert.deepEqual(request.messages[0].source, { kind: 'user' })
  assert.ok(request.signal instanceof AbortSignal)
  assert.equal(request.signal.aborted, false)

  assert.equal(result.items.length, 1)
  assert.equal(result.durationMs >= 0, true)
  assert.deepEqual(result.usage, {
    inputTokens: 10,
    outputTokens: 20,
    totalTokens: 30,
    cacheReadTokens: 0,
    reasoningTokens: 0,
  })
})

test('identity is a prefix-shaped UUIDv4 and the idempotency key is session:toSeq:index', async (t) => {
  const { queueRoot, persistOutput } = await queueIn(t)
  await writeJobAtomic(queueRoot, jobFixture())
  const payload = json([
    decisionItem({ title: 'd' }),
    decisionItem({ type: 'gotcha', title: 'g', status: 'proposed' }),
    decisionItem({ type: 'convention', title: 'c', status: 'proposed' }),
  ])
  const llm = recordingLlm(() => textStream(payload))
  const result = await runPendingJob(jobFixture(), { llm, config: CONFIG, persistOutput })

  assert.deepEqual(
    result.items.map((item) => item.preassignedId.slice(0, 4)),
    ['dec-', 'got-', 'con-'],
  )
  for (const item of result.items)
    assert.equal(isValidNoteId(item.preassignedId), true, item.preassignedId)
  assert.deepEqual(
    result.items.map((item) => item.idempotencyKey),
    [`${SESSION_ID}:${TO_SEQ}:0`, `${SESSION_ID}:${TO_SEQ}:1`, `${SESSION_ID}:${TO_SEQ}:2`],
  )
})

test('the request input is clamped to distill.maxInputChars, keeping the newest text', async (t) => {
  const { queueRoot, persistOutput } = await queueIn(t)
  const long = `NEWEST-TAIL ${'x'.repeat(600)}`
  await writeJobAtomic(queueRoot, jobFixture({ safeInput: long }))
  const llm = recordingLlm(() => textStream(json([decisionItem()])))
  await runPendingJob(jobFixture({ safeInput: long }), {
    llm,
    config: { distill: { ...CONFIG.distill, maxInputChars: 256 } },
    persistOutput,
  })

  const sent = llm.calls[0].messages[0].content[0].text
  assert.equal([...sent].length, 256)
  assert.equal(sent.endsWith('x'.repeat(50)), true)
  assert.equal(long.endsWith(sent.slice(1)), true)
})

test('a route from the job is used when the config names no explicit route', async (t) => {
  const { queueRoot, persistOutput } = await queueIn(t)
  await writeJobAtomic(queueRoot, jobFixture())
  const llm = recordingLlm(() => textStream(json([decisionItem()])))
  await runPendingJob(jobFixture(), {
    llm,
    config: { distill: { ...CONFIG.distill, provider: '', model: '' } },
    persistOutput,
  })
  assert.equal(llm.calls[0].provider, 'deepseek-official')
  assert.equal(llm.calls[0].model, 'deepseek-flash')
})

test('a service that cannot stream is treated as no service: deferred, not a crash', async (t) => {
  const { queueRoot, persistOutput } = await queueIn(t)
  await writeJobAtomic(queueRoot, jobFixture())
  const result = await runPendingJob(jobFixture(), {
    llm: { name: 'not-an-llm' },
    config: CONFIG,
    persistOutput,
  })
  assert.deepEqual(result, { state: 'deferred', reason: 'no-route' })
  assert.equal(existsSync(join(queueRoot, `${JOB_ID}.json`)), true)
})

test('a job claiming validated without its items is refused, never re-distilled', async (t) => {
  const { queueRoot, persistOutput } = await queueIn(t)
  await writeJobAtomic(
    queueRoot,
    jobFixture({
      state: 'validated',
      output: { state: 'validated', raw: '{}', items: null, usage: null },
    }),
  )
  const deadLlm = recordingLlm(() => {
    throw new Error('the model must not be called again')
  })
  await assert.rejects(
    () =>
      runPendingJob(
        jobFixture({
          state: 'validated',
          output: { state: 'validated', raw: '{}', items: null, usage: null },
        }),
        {
          llm: deadLlm,
          config: CONFIG,
          persistOutput,
        },
      ),
    throwsCode('job-invalid'),
  )
  assert.equal(deadLlm.calls.length, 0)
})

test('a job claiming raw-durable without its text is refused, never re-distilled', async (t) => {
  const { queueRoot, persistOutput } = await queueIn(t)
  await writeJobAtomic(
    queueRoot,
    jobFixture({
      state: 'raw-durable',
      output: { state: 'raw-durable', raw: null, items: null, usage: null },
    }),
  )
  const deadLlm = recordingLlm(() => {
    throw new Error('the model must not be called again')
  })
  await assert.rejects(
    () =>
      runPendingJob(
        jobFixture({
          state: 'raw-durable',
          output: { state: 'raw-durable', raw: null, items: null, usage: null },
        }),
        {
          llm: deadLlm,
          config: CONFIG,
          persistOutput,
        },
      ),
    throwsCode('job-invalid'),
  )
  assert.equal(deadLlm.calls.length, 0)
})

test('a thenable stream is awaited before iterating (waterfall middleware defence)', async (t) => {
  const { queueRoot, persistOutput } = await queueIn(t)
  await writeJobAtomic(queueRoot, jobFixture())
  const llm = recordingLlm(() => Promise.resolve(textStream(json([decisionItem()]))))
  const result = await runPendingJob(jobFixture(), { llm, config: CONFIG, persistOutput })
  assert.equal(llm.calls.length, 1)
  assert.equal(result.items.length, 1)
})

test('a non-iterable stream is a refusal, not a hang', async (t) => {
  const { queueRoot, persistOutput } = await queueIn(t)
  await writeJobAtomic(queueRoot, jobFixture())
  const llm = recordingLlm(() => ({ not: 'a stream' }))
  await assert.rejects(
    () => runPendingJob(jobFixture(), { llm, config: CONFIG, persistOutput }),
    throwsCode('stream-invalid'),
  )
})

// ---------------------------------------------------------------------------
// The two durability barriers
// ---------------------------------------------------------------------------

test('the raw output is durable before validation, and the validated items after', async (t) => {
  const { queueRoot, persistOutput } = await queueIn(t)
  await writeJobAtomic(queueRoot, jobFixture())
  const payload = json([decisionItem()])
  const barriers = []
  const persist = async (jobId, output) => {
    barriers.push({ jobId, ...output })
    return persistOutput(jobId, output)
  }
  const llm = recordingLlm(() => textStream(payload))

  await runPendingJob(jobFixture(), { llm, config: CONFIG, persistOutput: persist })

  assert.deepEqual(
    barriers.map((entry) => entry.state),
    ['raw-durable', 'validated'],
  )
  assert.equal(barriers[0].raw, payload)
  assert.equal(barriers[0].items, undefined, 'nothing validated exists at the first barrier')
  assert.equal(barriers[1].raw, payload)
  assert.equal(barriers[1].items.length, 1)
  assert.deepEqual(barriers[1].usage, {
    inputTokens: 10,
    outputTokens: 20,
    totalTokens: 30,
    cacheReadTokens: 0,
    reasoningTokens: 0,
  })

  const [stored] = await loadPending(queueRoot)
  assert.equal(stored.state, 'validated')
  assert.equal(stored.output.state, 'validated')
  assert.equal(stored.output.raw, payload)
  assert.equal(stored.output.items.length, 1)
  assert.equal((await stat(join(queueRoot, `${JOB_ID}.json`))).mode & 0o777, JOB_FILE_MODE)
})

test('a dropped foreign-target item is reported, and only survivors reach the validated barrier', async (t) => {
  const { queueRoot, persistOutput } = await queueIn(t)
  await writeJobAtomic(queueRoot, jobFixture())
  const raw = json([
    decisionItem({ title: 'a' }),
    decisionItem({ title: 'b', supersedesId: 'Projects/other--deadbeef/Decisions/ADR-1.md' }),
  ])
  const llm = recordingLlm(() => textStream(raw))
  const result = await runPendingJob(jobFixture(), { llm, config: CONFIG, persistOutput })

  assert.deepEqual(
    result.items.map((item) => item.title),
    ['a'],
  )
  assert.deepEqual(result.refused, [
    {
      index: 1,
      reason: 'foreign-target',
      field: 'supersedesId',
      value: 'Projects/other--deadbeef/Decisions/ADR-1.md',
    },
  ])
  const [stored] = await loadPending(queueRoot)
  assert.deepEqual(
    stored.output.items.map((item) => item.title),
    ['a'],
  )
  assert.deepEqual(
    stored.output.items.map((item) => item.idempotencyKey),
    [`${SESSION_ID}:${TO_SEQ}:0`],
  )
})

test('a job whose every item is dropped is still a durable, model-call-free resume', async (t) => {
  const { queueRoot, persistOutput } = await queueIn(t)
  await writeJobAtomic(queueRoot, jobFixture())
  const raw = json([decisionItem({ supersedesId: '_meta/user.md' })])
  const result = await runPendingJob(jobFixture(), {
    llm: recordingLlm(() => textStream(raw)),
    config: CONFIG,
    persistOutput,
  })
  assert.deepEqual(result.items, [])
  assert.equal(result.refused.length, 1)

  const [reloaded] = await loadPending(queueRoot)
  const deadLlm = recordingLlm(() => {
    throw new Error('the model must not be called again')
  })
  const second = await runPendingJob(reloaded, { llm: deadLlm, config: CONFIG, persistOutput })
  assert.equal(deadLlm.calls.length, 0)
  assert.deepEqual(second.items, [])
  assert.deepEqual(second.refused, [], 'a validated resume reports no new refusals')
})

test('the persisted metadata holds only measured tokens and no invented currency cost', async (t) => {
  const { queueRoot, persistOutput } = await queueIn(t)
  await writeJobAtomic(queueRoot, jobFixture())
  const llm = recordingLlm(() => textStream(json([decisionItem()])))
  const result = await runPendingJob(jobFixture(), { llm, config: CONFIG, persistOutput })

  const stored = JSON.parse(await readFile(join(queueRoot, `${JOB_ID}.json`), 'utf8'))
  assert.deepEqual(Object.keys(stored.output.usage).sort(), [
    'cacheReadTokens',
    'inputTokens',
    'outputTokens',
    'reasoningTokens',
    'totalTokens',
  ])
  assert.equal(typeof result.durationMs, 'number')
  assert.equal(Number.isSafeInteger(result.durationMs), true)
  assert.equal(/"cost"|"usd"|"price"|"currency"/i.test(JSON.stringify(stored)), false)
})

test('an aborted stream carries no usage, and a stream without one persists null rather than zeros', async (t) => {
  const { queueRoot, persistOutput } = await queueIn(t)
  await writeJobAtomic(queueRoot, jobFixture())
  // A success stream with NO usage chunk at all: the metadata must stay null,
  // never a fabricated zero.
  const llm = recordingLlm(() =>
    (async function* () {
      yield { type: 'block-start', index: 0, block: { type: 'text' } }
      yield { type: 'text-delta', index: 0, text: json([decisionItem()]) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })(),
  )

  const result = await runPendingJob(jobFixture(), { llm, config: CONFIG, persistOutput })
  assert.equal(result.usage, null)
  const [stored] = await loadPending(queueRoot)
  assert.equal(stored.output.usage, null)
})

// ---------------------------------------------------------------------------
// Resume: no second model call, byte-identical ids
// ---------------------------------------------------------------------------

test('a validated job resumes from the persisted items without a second model call', async (t) => {
  const { queueRoot, persistOutput } = await queueIn(t)
  await writeJobAtomic(queueRoot, jobFixture())
  const payload = json([
    decisionItem(),
    decisionItem({ type: 'gotcha', title: '踩坑', status: 'proposed' }),
  ])
  const first = await runPendingJob(jobFixture(), {
    llm: recordingLlm(() => textStream(payload)),
    config: CONFIG,
    persistOutput,
  })

  const [reloaded] = await loadPending(queueRoot)
  assert.equal(reloaded.output.state, 'validated')
  const deadLlm = recordingLlm(() => {
    throw new Error('the model must not be called again')
  })
  const second = await runPendingJob(reloaded, { llm: deadLlm, config: CONFIG, persistOutput })

  assert.equal(deadLlm.calls.length, 0)
  assert.deepEqual(
    second.items.map((item) => item.preassignedId),
    first.items.map((item) => item.preassignedId),
  )
  assert.deepEqual(
    second.items.map((item) => item.idempotencyKey),
    first.items.map((item) => item.idempotencyKey),
  )
  assert.deepEqual(second.usage, first.usage)
  assert.deepEqual((await loadPending(queueRoot))[0].output.items, reloaded.output.items)
})

test('a raw-durable job re-validates the same bytes without a second model call', async (t) => {
  const { queueRoot, persistOutput } = await queueIn(t)
  const payload = json([decisionItem()])
  await writeJobAtomic(
    queueRoot,
    jobFixture({
      state: 'raw-durable',
      output: {
        state: 'raw-durable',
        raw: payload,
        items: null,
        usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
      },
    }),
  )

  const deadLlm = recordingLlm(() => {
    throw new Error('the model must not be called again')
  })
  const [reloaded] = await loadPending(queueRoot)
  const result = await runPendingJob(reloaded, { llm: deadLlm, config: CONFIG, persistOutput })

  assert.equal(deadLlm.calls.length, 0)
  assert.equal(result.items.length, 1)
  assert.equal(result.usage.totalTokens, 7)
  const [stored] = await loadPending(queueRoot)
  assert.equal(stored.state, 'validated')
  assert.equal(stored.output.raw, payload)
})

test('a raw-durable job whose raw is invalid fails again without a model call, and stays raw-durable', async (t) => {
  const { queueRoot, persistOutput } = await queueIn(t)
  const payload = 'not json at all'
  await writeJobAtomic(
    queueRoot,
    jobFixture({
      state: 'raw-durable',
      output: { state: 'raw-durable', raw: payload, items: null, usage: null },
    }),
  )

  const deadLlm = recordingLlm(() => {
    throw new Error('the model must not be called again')
  })
  const [reloaded] = await loadPending(queueRoot)
  await assert.rejects(
    () => runPendingJob(reloaded, { llm: deadLlm, config: CONFIG, persistOutput }),
    throwsCode('not-json'),
  )

  assert.equal(deadLlm.calls.length, 0)
  const [stored] = await loadPending(queueRoot)
  assert.equal(stored.state, 'raw-durable')
  assert.equal(stored.output.raw, payload)
})

test('validation failure leaves the raw output durable in the job', async (t) => {
  const { queueRoot, persistOutput } = await queueIn(t)
  await writeJobAtomic(queueRoot, jobFixture())
  const payload = json([decisionItem({ evidenceSeqs: [999] })])
  const llm = recordingLlm(() => textStream(payload))

  await assert.rejects(
    () => runPendingJob(jobFixture(), { llm, config: CONFIG, persistOutput }),
    throwsCode('evidence'),
  )

  const [stored] = await loadPending(queueRoot)
  assert.equal(stored.state, 'raw-durable')
  assert.equal(stored.output.raw, payload)
  assert.equal(stored.output.items, null)
})

test('persistJobOutput refuses to overwrite a validated item set with different ids', async (t) => {
  const { queueRoot } = await queueIn(t)
  await writeJobAtomic(queueRoot, jobFixture())
  const persisted = await persistJobOutput(
    JOB_ID,
    {
      state: 'validated',
      raw: '{}',
      items: [
        {
          preassignedId: 'dec-5d46ff43-1bf8-496d-8b9f-c11e89d4e2aa',
          idempotencyKey: `${SESSION_ID}:7:0`,
        },
      ],
      usage: null,
    },
    { queueRoot },
  )
  assert.equal(persisted.state, 'validated')

  await assert.rejects(
    () =>
      persistJobOutput(
        JOB_ID,
        {
          state: 'validated',
          raw: '{}',
          items: [
            {
              preassignedId: 'dec-11111111-1111-4111-8111-111111111111',
              idempotencyKey: `${SESSION_ID}:7:0`,
            },
          ],
          usage: null,
        },
        { queueRoot },
      ),
    (error) => error.name === 'PendingError' && error.code === 'output-immutable',
  )

  // The identical re-persist is an idempotent no-op that keeps the original ids.
  const again = await persistJobOutput(
    JOB_ID,
    {
      state: 'validated',
      raw: '{}',
      items: persisted.output.items,
      usage: null,
    },
    { queueRoot },
  )
  assert.equal(again.output.items[0].preassignedId, 'dec-5d46ff43-1bf8-496d-8b9f-c11e89d4e2aa')
})

test('persistJobOutput rejects a malformed barrier payload and a missing job', async (t) => {
  const { queueRoot } = await queueIn(t)
  await writeJobAtomic(queueRoot, jobFixture())
  await assert.rejects(
    () => persistJobOutput(JOB_ID, { state: 'done', raw: '{}' }, { queueRoot }),
    (error) => error.name === 'PendingError' && error.code === 'output-invalid',
  )
  await assert.rejects(
    () => persistJobOutput(JOB_ID, { state: 'validated', raw: '{}' }, { queueRoot }),
    (error) => error.name === 'PendingError' && error.code === 'output-invalid',
  )
  assert.equal(
    await persistJobOutput(
      'job-ffffffffffffffffffffffffffffffff',
      { state: 'raw-durable', raw: '{}' },
      { queueRoot },
    ),
    null,
  )
})

test('two racing validated barriers cannot both win: exactly one identity survives', async (t) => {
  const { queueRoot } = await queueIn(t)
  await writeJobAtomic(queueRoot, jobFixture())
  const item = (id) => ({ preassignedId: id, idempotencyKey: `${SESSION_ID}:7:0` })
  const [left, right] = await Promise.allSettled([
    persistJobOutput(
      JOB_ID,
      {
        state: 'validated',
        raw: '{}',
        items: [item('dec-5d46ff43-1bf8-496d-8b9f-c11e89d4e2aa')],
        usage: null,
      },
      { queueRoot },
    ),
    persistJobOutput(
      JOB_ID,
      {
        state: 'validated',
        raw: '{}',
        items: [item('dec-11111111-1111-4111-8111-111111111111')],
        usage: null,
      },
      { queueRoot },
    ),
  ])
  const outcomes = [left, right].map((entry) => entry.status).sort()
  assert.deepEqual(outcomes, ['fulfilled', 'rejected'])
  const rejected = [left, right].find((entry) => entry.status === 'rejected')
  assert.equal(rejected.reason.code, 'output-immutable')
  const [stored] = await loadPending(queueRoot)
  assert.equal(stored.output.items.length, 1)
  assert.equal(
    stored.output.items[0].preassignedId,
    [left, right].find((entry) => entry.status === 'fulfilled').value.output.items[0].preassignedId,
  )
})

// ---------------------------------------------------------------------------
// Deferral and failure: the job is always kept
// ---------------------------------------------------------------------------

test('a missing llm service defers and keeps the job byte-for-byte', async (t) => {
  const { queueRoot, persistOutput } = await queueIn(t)
  await writeJobAtomic(queueRoot, jobFixture())
  const before = await readFile(join(queueRoot, `${JOB_ID}.json`), 'utf8')

  const result = await runPendingJob(jobFixture(), {
    llm: undefined,
    config: CONFIG,
    persistOutput,
  })

  assert.deepEqual(result, { state: 'deferred', reason: 'no-route' })
  assert.equal(await readFile(join(queueRoot, `${JOB_ID}.json`), 'utf8'), before)
})

test('an empty route defers without ever calling the service (NO_ADAPTER is not a default route)', async (t) => {
  const { queueRoot, persistOutput } = await queueIn(t)
  await writeJobAtomic(queueRoot, jobFixture({ route: null }))
  const llm = recordingLlm(() => {
    throw new Error('an empty route must not be dispatched')
  })

  for (const config of [
    { distill: { ...CONFIG.distill, provider: '', model: '' } },
    {},
    undefined,
    { distill: { ...CONFIG.distill, provider: 'deepseek-official', model: '' } },
  ]) {
    const result = await runPendingJob(jobFixture({ route: null }), { llm, config, persistOutput })
    assert.deepEqual(result, { state: 'deferred', reason: 'no-route' })
  }
  assert.equal(llm.calls.length, 0)
  assert.equal(existsSync(join(queueRoot, `${JOB_ID}.json`)), true)
})

test('a tool call in the stream is a hard failure and nothing is persisted', async (t) => {
  const { queueRoot, persistOutput } = await queueIn(t)
  await writeJobAtomic(queueRoot, jobFixture())
  const llm = recordingLlm(() =>
    (async function* () {
      yield { type: 'block-start', index: 0, block: { type: 'text' } }
      yield { type: 'tool-call-delta', index: 1, block: { type: 'tool-call' } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    })(),
  )

  await assert.rejects(
    () => runPendingJob(jobFixture(), { llm, config: CONFIG, persistOutput }),
    throwsCode('tool-call'),
  )
  const [stored] = await loadPending(queueRoot)
  assert.equal(stored.output, null, 'a tool-call stream never reaches a persistence barrier')
})

test('a caller cancel is a terminal aborted chunk classified as aborted, never from message text', async (t) => {
  const { queueRoot, persistOutput } = await queueIn(t)
  await writeJobAtomic(queueRoot, jobFixture())
  const controller = new AbortController()
  controller.abort()
  const sharedMessage = 'the request was aborted by caller'
  const llm = recordingLlm((options) =>
    (async function* () {
      yield {
        type: 'finish',
        reason: { kind: 'aborted', failure: { code: 'ABORTED', message: sharedMessage } },
      }
      assert.equal(options.signal.aborted, true)
    })(),
  )

  await assert.rejects(
    () =>
      runPendingJob(jobFixture(), {
        llm,
        config: CONFIG,
        signal: controller.signal,
        persistOutput,
      }),
    throwsCode('aborted'),
  )
  const [stored] = await loadPending(queueRoot)
  assert.equal(stored.output, null)
  assert.equal(existsSync(join(queueRoot, `${JOB_ID}.json`)), true)
})

test('a timeout is the same terminal chunk with the same message, told apart only by signal.reason.name', async (t) => {
  const { queueRoot, persistOutput } = await queueIn(t)
  await writeJobAtomic(queueRoot, jobFixture())
  const sharedMessage = 'the request was aborted by caller'
  // `AbortSignal.timeout()`'s timer is unref'd (measured on both v22.22.2 and
  // v25.9.0), so while this stub waits for the abort event there is no ref'd
  // handle left in the process. Node 22's test runner reads that as "the event
  // loop has already resolved", cancels this subtest and then every subtest
  // after it — a minimum-Node-only failure (Task 19). The timer below is ref'd
  // on purpose: it holds the loop open long enough for the 20 ms timeout to
  // fire. It is capped so a genuine hang still fails rather than stalling.
  const keepAlive = setTimeout(() => {}, 5_000)
  t.after(() => clearTimeout(keepAlive))
  const llm = recordingLlm((options) =>
    (async function* () {
      if (!options.signal.aborted) {
        await new Promise((resolve) =>
          options.signal.addEventListener('abort', resolve, { once: true }),
        )
      }
      assert.equal(options.signal.reason?.name, 'TimeoutError')
      yield {
        type: 'finish',
        reason: { kind: 'aborted', failure: { code: 'ABORTED', message: sharedMessage } },
      }
    })(),
  )

  await assert.rejects(
    () =>
      runPendingJob(jobFixture(), {
        llm,
        config: { distill: { ...CONFIG.distill, timeoutMs: 20 } },
        persistOutput,
      }),
    throwsCode('timeout'),
  )
  assert.equal((await loadPending(queueRoot))[0].output, null)
})

test('an empty-route terminal NO_ADAPTER chunk is reported as no-adapter', async (t) => {
  const { queueRoot, persistOutput } = await queueIn(t)
  await writeJobAtomic(queueRoot, jobFixture())
  const llm = recordingLlm(() =>
    (async function* () {
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: { code: 'NO_ADAPTER', message: 'no adapter registered for provider ""' },
        },
      }
    })(),
  )

  await assert.rejects(
    () => runPendingJob(jobFixture(), { llm, config: CONFIG, persistOutput }),
    throwsCode('no-adapter'),
  )
})

test('a max-tokens finish is a truncation refusal, and a missing finish is a refusal', async (t) => {
  const { queueRoot, persistOutput } = await queueIn(t)
  await writeJobAtomic(queueRoot, jobFixture())

  const truncated = recordingLlm(() =>
    (async function* () {
      yield { type: 'text-delta', index: 0, text: '{"items":[' }
      yield { type: 'finish', reason: { kind: 'max-tokens' } }
    })(),
  )
  await assert.rejects(
    () => runPendingJob(jobFixture(), { llm: truncated, config: CONFIG, persistOutput }),
    throwsCode('truncated'),
  )

  const silent = recordingLlm(() =>
    (async function* () {
      yield { type: 'block-start', index: 0, block: { type: 'text' } }
      yield { type: 'text-delta', index: 0, text: '{"items":[]}' }
    })(),
  )
  await assert.rejects(
    () => runPendingJob(jobFixture(), { llm: silent, config: CONFIG, persistOutput }),
    throwsCode('finish-missing'),
  )

  const errored = recordingLlm(() =>
    (async function* () {
      yield {
        type: 'finish',
        reason: { kind: 'error', failure: { code: 'MISSING_CREDENTIAL', message: 'no API key' } },
      }
    })(),
  )
  await assert.rejects(
    () => runPendingJob(jobFixture(), { llm: errored, config: CONFIG, persistOutput }),
    throwsCode('stream-error'),
  )
  assert.equal((await loadPending(queueRoot))[0].output, null)
})

test('reasoning deltas and an empty final answer never become the raw output', async (t) => {
  const { queueRoot, persistOutput } = await queueIn(t)
  await writeJobAtomic(queueRoot, jobFixture())
  const payload = json([decisionItem()])
  const llm = recordingLlm(() =>
    (async function* () {
      yield { type: 'block-start', index: 0, block: { type: 'reasoning' } }
      yield { type: 'reasoning-delta', index: 0, text: 'SECRET_REASONING' }
      yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'SECRET_REASONING' } }
      yield { type: 'block-start', index: 1, block: { type: 'text' } }
      yield { type: 'text-delta', index: 1, text: payload }
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })(),
  )

  const result = await runPendingJob(jobFixture(), { llm, config: CONFIG, persistOutput })
  const stored = await readFile(join(queueRoot, `${JOB_ID}.json`), 'utf8')
  assert.equal(stored.includes('SECRET_REASONING'), false)
  assert.equal(result.items.length, 1)
})

// ---------------------------------------------------------------------------
// Containment
// ---------------------------------------------------------------------------

test('an explicit queueRoot is the only filesystem target; DSH_HOME is never consulted', async (t) => {
  const root = await temporaryRoot(t)
  const previous = process.env.DSH_HOME
  const dshHome = join(root, 'dsh-home')
  process.env.DSH_HOME = dshHome
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  })

  const queueRoot = join(root, 'queue', 'pending')
  await writeJobAtomic(queueRoot, jobFixture())
  const llm = recordingLlm(() => textStream(json([decisionItem()])))
  await runPendingJob(jobFixture(), {
    llm,
    config: CONFIG,
    persistOutput: (jobId, output) => persistJobOutput(jobId, output, { queueRoot }),
  })

  assert.equal(existsSync(dshHome), false, 'the derived data root must never be touched')
  assert.equal((await loadPending(queueRoot)).length, 1)
})

test('DistillError is the one refusal type and it carries a machine-readable code', () => {
  const refusal = new DistillError('evidence', 'example')
  assert.equal(refusal.name, 'DistillError')
  assert.equal(refusal.code, 'evidence')
  assert.equal(refusal instanceof Error, true)
  assert.equal(refusal.message, 'example')
})
