// The disk/report format is narrower than the in-process diagnostics ring.
// Unknown tokens are coarsened before persistence; raw identifiers never cross it.
import {
  CURATION_PROPOSAL_CODES,
  CURATION_STATE_CODES,
  CURATION_TRUNCATION_REASONS,
  CURATION_VIEW_CODES,
} from './curation-codes.js'
import { EVENT_NAMES } from './debug.js'
import { BIND_HINT_REASONS } from './init-hint.js'

const EVENTS = new Set(EVENT_NAMES)
const OUTCOMES = Object.freeze({
  capture: new Set([
    'captured',
    'skipped-unbound',
    'auto-capture-off',
    'not-turn-end',
    'not-root-session',
    'no-session-id',
    'no-project-id',
    'no-end-seq',
    'no-user-messages',
    'no-segments',
    'already-processed',
  ]),
  // An outcome a call site emits but this list omits is written to disk as `other`,
  // losing the one durable record of why nothing was written — `review` (a parked
  // candidate) and `duplicate-check-failed` exist only to name a non-write.
  distill: new Set([
    'deferred',
    'no-memory',
    'dry-run',
    'duplicate',
    'duplicate-check-failed',
    'review',
    'applied',
  ]),
  index: new Set(['open-failed', 'refresh-failed', 'none', 'refreshed']),
  bind: new Set(['refused']),
  job: new Set([
    'retry-refused',
    'retry-missing',
    'retried',
    'deferred',
    'completed',
    'failed',
    'retry',
  ]),
  transaction: new Set(['committed', 'refused']),
  brief: new Set(['none', 'hint-only', 'injected']),
  skill: new Set(['synced', 'unchanged', 'failed']),
  recall: new Set([
    'fired',
    'no-query',
    'no-hits',
    'below-floor',
    'all-seen',
    'budget',
    'aborted',
    'search-failed',
  ]),
  // Task 5's bounded curation action, plus the outcomes Task 6's triggers add.
  // `listed` is the read-only status call, `scanned` a pass, and `skipped` a `dueOnly`
  // request whose marker was fresh and queue empty — its only producer, because
  // `autoCurate: false` removes the automatic callers. `failed` is a curation step that
  // could not be carried out; `brief-fallback` is a stored view that failed verification
  // at brief time, `changed-path-dropped` a hint the cap evicted. Unknown is `other`.
  curation: new Set([
    'listed',
    'scanned',
    'skipped',
    'failed',
    'brief-fallback',
    'changed-path-dropped',
  ]),
})

// The scalars a curation call site can put in `code`, by the module that produces
// them: the scanner's five truncation reasons (`lib/curation-scan.js`), the state
// payloads whose read is refused and the cursor, record, changed-set and view refusals
// (`lib/curation-state.js`), the proposal family the `recordCurationFindings` call can
// raise (`lib/curation-proposals.js`), and the builder's own judged fallbacks
// (`lib/curation-view.js`). Those four families are declared in `lib/curation-codes.js`
// and derived here. `test/diagnostic-codec.test.js` parses the four emitters and holds
// each equal to its declared family, so a fixed code an emitter names at the throw or
// the `reason` site — a literal, or an identifier or ternary bound to one in the same
// module — fails that test rather than being coarsened to `other` in silence. A code
// that reaches a constructor through a helper's parameter is outside that scan: the
// `requireText(input.kind, 'proposal kind', undefined, 'proposal-kind')` call in
// `lib/curation-proposals.js` passes its code into `new CurationError(code, …)`, and
// only the literal at the neighbouring throw keeps `proposal-kind` in that module's
// found set.
//
// Two families are dynamic and *cannot* be registered: `view-unwritable:<code>` appends
// a raw filesystem error's code, and `writePrivateJson` (`lib/curation-state.js`)
// rethrows a raw filesystem error unchanged — probed by putting a file where the private
// `curation/` directory belongs, which makes `writeCurationViewJson` throw a plain
// `Error` with `code: 'ENOTDIR'` rather than a `CurationStateError`. Every writer built
// on it, the hint enqueue and the acknowledgement included, can therefore hand an errno
// to the catch sites that record `error.code`. Neither family is enumerable, so both
// land on `other` like any unknown token. A code here is a name, never a path or a note.
const CURATION_CODES = new Set([
  ...CURATION_TRUNCATION_REASONS,
  ...CURATION_STATE_CODES,
  ...CURATION_PROPOSAL_CODES,
  ...CURATION_VIEW_CODES,
  // The binding refusal a caller's resolution can throw at the service seam.
  'not-bound',
])
const CODES = new Set([
  'no-binding',
  'no-route',
  'no-pointer',
  'vault-cloud-managed',
  'unsafe-path',
  'recovery-required',
  'job-corrupt',
  'schema',
  'evidence',
  // `bind-hint` is the `brief` event's own code for the unbound-session notice
  // (`lib/hooks.js`): without it here the ring keeps the token and the journal
  // writes `other`, which is the exact trap `review` and the curation outcomes fell
  // into. The two families below are the refusal reasons a `bind` diagnostic carries
  // (`lib/services.js` records `resolution.reason`): the notice's own list covers the
  // reasons worth telling a model about, and `vault`/`not-bound` are the two refusals
  // the notice deliberately stays silent on but the ring still wants to name. Every
  // other `bind` reason — a raw `error.code` from the pointer or registry layer —
  // is dynamic and still coarsens, which the codec's header states as a property of
  // the format rather than a gap.
  'bind-hint',
  'vault',
  'not-bound',
  ...BIND_HINT_REASONS,
  ...CURATION_CODES,
])
const COUNTS = ['attempts', 'ms', 'hits', 'chars']
const EVENT_KEYS = new Set([
  'seq',
  'at',
  'event',
  'outcome',
  'code',
  'attempts',
  'ms',
  'hits',
  'chars',
  'project',
  'job',
  'transaction',
])
const CONFIG_KEYS = new Set(['enabled', 'autoCapture', 'injectBrief', 'indexBackend', 'dryRun'])
const ALIAS_KEYS = Object.freeze({ projectId: 'project', jobId: 'job', txId: 'transaction' })
const ALIAS_PREFIXES = Object.freeze({ project: 'p', job: 'j', transaction: 't' })

/** One mapping per process run; raw identifiers are never written to disk. */
export function createAliases() {
  return { project: new Map(), job: new Map(), transaction: new Map() }
}

function validTime(value) {
  if (typeof value !== 'string' || value.length !== 24) return false
  const date = new Date(value)
  return !Number.isNaN(date.valueOf()) && date.toISOString() === value
}

function validCount(value) {
  return Number.isSafeInteger(value) && value >= 0
}

function aliasFor(aliases, kind, raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 80) return null
  const map = aliases?.[kind]
  if (!(map instanceof Map)) return null
  if (!map.has(raw)) map.set(raw, `${ALIAS_PREFIXES[kind]}${map.size + 1}`)
  return map.get(raw)
}

/** Project a ring event into the closed disk format. */
export function encodeDiagnosticEvent(source, aliases) {
  try {
    if (source === null || typeof source !== 'object') return null
    if (!EVENTS.has(source.event) || !validCount(source.seq) || source.seq === 0) return null
    if (!validTime(source.at)) return null
    const event = { seq: source.seq, at: source.at, event: source.event }
    if (source.outcome !== undefined) {
      event.outcome = OUTCOMES[source.event]?.has(source.outcome) ? source.outcome : 'other'
    }
    if (source.code !== undefined) event.code = CODES.has(source.code) ? source.code : 'other'
    for (const key of COUNTS) {
      if (validCount(source[key])) event[key] = source[key]
    }
    for (const [rawKey, safeKey] of Object.entries(ALIAS_KEYS)) {
      const alias = aliasFor(aliases, safeKey, source[rawKey])
      if (alias !== null) event[safeKey] = alias
    }
    return event
  } catch {
    return null
  }
}

/** Validate already-persisted bytes without preserving unknown fields. */
export function decodeDiagnosticEvent(source) {
  if (source === null || typeof source !== 'object' || Array.isArray(source)) return null
  if (Object.keys(source).some((key) => !EVENT_KEYS.has(key))) return null
  if (!EVENTS.has(source.event) || !validCount(source.seq) || source.seq === 0) return null
  if (!validTime(source.at)) return null
  const event = { seq: source.seq, at: source.at, event: source.event }
  if (source.outcome !== undefined) {
    if (source.outcome !== 'other' && !OUTCOMES[source.event]?.has(source.outcome)) return null
    event.outcome = source.outcome
  }
  if (source.code !== undefined) {
    if (source.code !== 'other' && !CODES.has(source.code)) return null
    event.code = source.code
  }
  for (const key of COUNTS) {
    if (source[key] === undefined) continue
    if (!validCount(source[key])) return null
    event[key] = source[key]
  }
  for (const [kind, prefix] of Object.entries(ALIAS_PREFIXES)) {
    if (source[kind] === undefined) continue
    if (
      typeof source[kind] !== 'string' ||
      !new RegExp(`^${prefix}[1-9][0-9]*$`).test(source[kind])
    ) {
      return null
    }
    event[kind] = source[kind]
  }
  return event
}

/** Keep only validated non-identifying config switches. */
export function safeConfigSummary(config) {
  return {
    enabled: config?.enabled === true,
    autoCapture: config?.autoCapture === true,
    injectBrief: config?.injectBrief === true,
    indexBackend: ['auto', 'sqlite', 'scan'].includes(config?.indexBackend)
      ? config.indexBackend
      : 'unavailable',
    dryRun: config?.distill?.dryRun === true,
  }
}

/** Reject a modified config summary instead of copying extra fields. */
export function decodeDiagnosticConfig(source) {
  if (source === null || typeof source !== 'object' || Array.isArray(source)) return null
  if (Object.keys(source).length !== CONFIG_KEYS.size) return null
  if (Object.keys(source).some((key) => !CONFIG_KEYS.has(key))) return null
  for (const key of ['enabled', 'autoCapture', 'injectBrief', 'dryRun']) {
    if (typeof source[key] !== 'boolean') return null
  }
  if (!['auto', 'sqlite', 'scan', 'unavailable'].includes(source.indexBackend)) return null
  return {
    enabled: source.enabled,
    autoCapture: source.autoCapture,
    injectBrief: source.injectBrief,
    indexBackend: source.indexBackend,
    dryRun: source.dryRun,
  }
}
