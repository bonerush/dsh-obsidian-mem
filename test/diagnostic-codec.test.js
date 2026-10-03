import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import ts from 'typescript'

import {
  CURATION_PROPOSAL_CODES,
  CURATION_STATE_CODES,
  CURATION_TRUNCATION_REASONS,
  CURATION_VIEW_CODES,
} from '../lib/curation-codes.js'
import {
  createAliases,
  decodeDiagnosticConfig,
  decodeDiagnosticEvent,
  encodeDiagnosticEvent,
  safeConfigSummary,
} from '../lib/diagnostic-codec.js'

const at = '2026-09-27T00:00:00.000Z'

/**
 * Every curation module that names a fixed code, how it carries it, and the list in
 * `lib/curation-codes.js` that has to agree with it.
 *
 * `error` means the module passes the code to a `CurationStateError`/`CurationError`;
 * `reason` means it stores it under `reason` or `truncatedReason` — the two properties
 * `lib/services.js` and the codec turn into a pass's one `code`. A lifecycle `reason`
 * such as a proposal's own note is prose, not a code, which is why the property scan is
 * scoped to these two modules rather than every module that has one.
 */
const CURATION_CODE_SOURCES = [
  ['error', 'lib/curation-state.js', CURATION_STATE_CODES],
  ['error', 'lib/curation-proposals.js', CURATION_PROPOSAL_CODES],
  ['reason', 'lib/curation-view.js', CURATION_VIEW_CODES],
  ['reason', 'lib/curation-scan.js', CURATION_TRUNCATION_REASONS],
]

/** The constructor names whose first string argument is a persisted code. */
const CODE_ERRORS = new Set(['CurationError', 'CurationStateError'])

/** The properties whose value `lib/services.js` persists as a pass's code. */
const CODE_PROPERTIES = new Set(['reason', 'truncatedReason'])

/**
 * The code a literal or template carries: the whole string, or the static head of a
 * template whose tail is dynamic (`view-unwritable:${error.code}` names the registered
 * prefix `view-unwritable` and a suffix no list can enumerate).
 *
 * @param {object} node - a TypeScript AST node.
 * @returns {string|null} the code, or `null` when the node is neither form.
 */
function codeOfLiteral(node) {
  if (node === undefined) return null
  if (ts.isStringLiteral(node)) return node.text
  // Only the `name:<dynamic>` form is a prefixed code (`view-unwritable:${error.code}`).
  // A template in some other shape (`record-${code}`) is a finding message, not a code.
  if (ts.isTemplateExpression(node) && node.head.text.endsWith(':')) {
    return node.head.text.slice(0, -1)
  }
  return null
}

/**
 * The codes every branch of one expression can carry: a literal, both arms of the
 * ternary that picks one, or a named local the caller resolves instead.
 *
 * @param {object} node - the expression.
 * @param {Map<string, object[]>} locals - every initializer seen for a variable name.
 * @returns {string[]} the codes.
 */
function codesOfExpression(node, locals) {
  if (node === undefined) return []
  if (ts.isConditionalExpression(node)) {
    return [
      ...codesOfExpression(node.whenTrue, locals),
      ...codesOfExpression(node.whenFalse, locals),
    ]
  }
  if (ts.isIdentifier(node)) {
    return (locals.get(node.text) ?? []).flatMap((value) => codesOfExpression(value, locals))
  }
  const code = codeOfLiteral(node)
  return code === null ? [] : [code]
}

/**
 * The fixed codes one module's source really names.
 *
 * @param {'error'|'reason'} kind - how the module carries its code.
 * @param {string} relative - the module, repo-relative.
 * @returns {Set<string>} the codes found.
 */
function codesInSource(kind, relative) {
  return codesInText(
    kind,
    relative,
    readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8'),
  )
}

/**
 * The same scan over an arbitrary source text, so a control can drive a probe this
 * repository must not carry.
 *
 * @param {'error'|'reason'} kind - how the module carries its code.
 * @param {string} name - the file name the parse reports, for messages.
 * @param {string} source - the JavaScript to parse.
 * @param {boolean} [resolveLocals] - resolve an identifier or ternary first argument
 *   through the module's own bindings. `false` is the literal-only scan, kept so the
 *   control can show what that scan misses.
 * @returns {Set<string>} the codes found.
 */
function codesInText(kind, name, source, resolveLocals = true) {
  const file = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const locals = new Map()
  const found = new Set()
  // Two passes, because the property that carries a truncation reason reads a local
  // whose value is chosen between branches (`truncatedReason: … : truncated`) and that
  // local is assigned from several string literals earlier in the same function.
  const collect = (node) => {
    const add = (key, value) => {
      const seen = locals.get(key) ?? []
      seen.push(value)
      locals.set(key, seen)
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      add(node.name.text, node.initializer)
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      add(node.left.getText(), node.right)
    }
    ts.forEachChild(node, collect)
  }
  collect(file)
  const walk = (node) => {
    if (
      kind === 'error' &&
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      CODE_ERRORS.has(node.expression.text)
    ) {
      // The first argument is a code whether it is written there or bound to a name
      // earlier in the module (`const hidden = 'x'; new CurationStateError(hidden, …)`),
      // which a literal-only read of `arguments[0]` cannot see.
      const first = node.arguments?.[0]
      const codes = resolveLocals ? codesOfExpression(first, locals) : [codeOfLiteral(first)]
      for (const code of codes) if (code !== null) found.add(code)
    }
    if (
      kind === 'reason' &&
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      CODE_PROPERTIES.has(node.name.text)
    ) {
      for (const code of codesOfExpression(node.initializer, locals)) found.add(code)
    }
    ts.forEachChild(node, walk)
  }
  walk(file)
  return found
}

/**
 * Every fixed code a curation call site can supply, derived from the emitters.
 *
 * @returns {Set<string>} the union of the families, each checked against its own module.
 */
function emittedCurationCodes() {
  const found = new Set()
  for (const [kind, relative, declared] of CURATION_CODE_SOURCES) {
    const actual = codesInSource(kind, relative)
    assert.ok(actual.size > 0, `${relative} names no code, so this check would be vacuous`)
    assert.deepEqual(
      [...actual].sort(),
      [...declared].sort(),
      `${relative} names codes lib/curation-codes.js does not declare, or the reverse`,
    )
    for (const code of actual) found.add(code)
  }
  return found
}

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

test('every curation outcome the bounded action emits survives the round trip', () => {
  // Task 5's one new diagnostic category, and the same trap `review` fell into:
  // `mem_admin(action="curation")` emits its own outcome, the ring carries it fine,
  // and only the *disk* format can silently rewrite it to `other`.
  const aliases = createAliases()
  // `failed` is emitted by `curateForBinding`'s per-finding refusal and by Task 6's
  // trigger catchers. It was absent from the outcome set, so every one of those was
  // persisted as `other` — this case is what would have caught it.
  const emitted = ['listed', 'scanned', 'skipped', 'failed']
  for (const outcome of emitted) {
    const encoded = encodeDiagnosticEvent({ seq: 1, at, event: 'curation', outcome }, aliases)
    assert.equal(encoded.outcome, outcome, `${outcome} is not coarsened`)
    assert.equal(decodeDiagnosticEvent(encoded).outcome, outcome, `${outcome} decodes back`)
  }
  // The control: a token the codec does not know is still coarsened, so the loop
  // above is testing registration rather than a codec that echoes anything. One
  // control per vocabulary, because the outcome set and the code set are separate.
  const unknown = encodeDiagnosticEvent(
    { seq: 1, at, event: 'curation', outcome: 'invented' },
    createAliases(),
  )
  assert.equal(unknown.outcome, 'other')
  assert.equal(decodeDiagnosticEvent(unknown).outcome, 'other')
})

test('the emitter scan resolves a code passed by name, not only a literal', () => {
  // The reviewer's probe, and the blind spot round 2 shipped with: reading
  // `new CurationError(...)`'s first argument as a literal only makes a code bound to a
  // name invisible, and appending exactly this pair to `lib/curation-state.js` left the
  // case below green. The first assertion is the literal-only scan; the second is the
  // scan the case now uses, which fails the per-module equality on such a probe.
  const probe = [
    "const hidden = 'curation-blindspot'",
    "throw new CurationStateError(hidden, 'probe')",
  ].join('\n')
  assert.deepEqual(
    [...codesInText('error', 'probe.js', probe, false)],
    [],
    'a literal-only scan cannot see an identifier first argument',
  )
  assert.deepEqual([...codesInText('error', 'probe.js', probe)], ['curation-blindspot'])
  // The other direction: a code that reaches the constructor through a helper's
  // parameter is outside both scans, which is why the guarantee is about the site and
  // not about every code that can flow into a constructor.
  const helper = [
    'function requireText(value, code) {',
    "  if (value === '') throw new CurationError(code, 'blank')",
    '  return value',
    '}',
    "requireText('x', 'proposal-kind')",
  ].join('\n')
  assert.deepEqual([...codesInText('error', 'probe.js', helper)], [])
})

test('the second dynamic family and the hand-added code are both pinned', () => {
  // `lib/curation-state.js`'s `writePrivateJson` rethrows a raw filesystem error
  // unchanged, so the hint enqueue and the acknowledgement can carry an errno into a
  // `curation` event's `code`. That family is coarsened exactly like the
  // `view-unwritable:<code>` one the round-trip case's control drives.
  const encoded = encodeDiagnosticEvent(
    { seq: 1, at, event: 'curation', outcome: 'scanned', code: 'EACCES' },
    createAliases(),
  )
  assert.equal(encoded.code, 'other')
  assert.equal(decodeDiagnosticEvent(encoded).code, 'other')
  // `not-bound` is the other direction: a registered code the codec adds by hand, not
  // one of the four emitter families, so neither the derived union nor the loop above
  // can cover it. Deleting it from `CODES` otherwise leaves every covering file green.
  const bound = encodeDiagnosticEvent(
    { seq: 1, at, event: 'curation', outcome: 'listed', code: 'not-bound' },
    createAliases(),
  )
  assert.equal(bound.code, 'not-bound')
  assert.equal(decodeDiagnosticEvent(bound).code, 'not-bound')
})

test('every code a curation emitter can produce survives the round trip', () => {
  // The other half of the same trap. A `curation` event carries one code, and that
  // code is the only durable record of *why* the call wrote nothing: the scanner's
  // truncation reason, the private-state read that failed, the view build's own
  // refusal, or the proposal store's. The loop derives its codes from the emitters'
  // declared families, so it cannot pass while an emitter names a code `CODES` lacks —
  // the first version of this case looped a hand-written copy of the list and could
  // not fail for the one thing it was named after.
  const aliases = createAliases()
  const codes = [...emittedCurationCodes()].sort()
  assert.deepEqual(
    codes,
    [
      'backfill-incomplete',
      'changed-invalid',
      'changed-project',
      'changed-version',
      'cursor-invalid',
      'cursor-project',
      'cursor-version',
      'entry-unusable',
      'file-budget',
      'manifest-budget',
      'manifest-changed',
      'proposal-conflict',
      'proposal-invalid',
      'proposal-kind',
      'proposal-kind-operation',
      'proposal-mismatch',
      'proposal-missing',
      'proposal-operation',
      'proposal-oversize',
      'proposal-source-missing',
      'proposal-source-unreadable',
      'proposal-source-unsafe',
      'proposal-state',
      'proposal-version',
      'record-invalid',
      'record-mismatch',
      'record-version',
      'records-missing',
      'source-changed',
      'state-corrupt',
      'state-not-a-file',
      'state-oversize',
      'state-unreadable',
      'time-budget',
      'view-invalid',
      'view-oversize',
      'view-project',
      'view-unwritable',
      'view-version',
    ],
    'the emitter vocabulary is fixed: a new code lands here and in lib/curation-codes.js',
  )
  for (const code of codes) {
    const encoded = encodeDiagnosticEvent(
      { seq: 1, at, event: 'curation', outcome: 'scanned', code },
      aliases,
    )
    assert.equal(encoded.code, code, `${code} is not coarsened`)
    assert.equal(decodeDiagnosticEvent(encoded).code, code, `${code} decodes back`)
  }
  // The control: a token the codec does not know is still coarsened, so the loop above
  // is testing registration rather than a codec that echoes anything. The dynamic half
  // of `view-unwritable:<code>` is the one curation value that has to be coarsened.
  const unknown = encodeDiagnosticEvent(
    { seq: 1, at, event: 'curation', outcome: 'scanned', code: 'view-unwritable:ENOSPC' },
    createAliases(),
  )
  assert.equal(unknown.code, 'other')
  assert.equal(decodeDiagnosticEvent(unknown).code, 'other')
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
