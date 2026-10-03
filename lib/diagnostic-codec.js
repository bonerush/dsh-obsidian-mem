// The disk/report format is narrower than the in-process diagnostics ring.
// Unknown tokens are coarsened before persistence; raw identifiers never cross it.
import { EVENT_NAMES } from './debug.js'

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
  // Task 5's bounded curation action. `skipped` is the automatic pass the due
  // marker or `autoCurate: false` declined; `failed` is a finding or a Task 6 pass
  // that could not be recorded. Unlisted outcomes are persisted as `other`.
  curation: new Set(['listed', 'scanned', 'skipped', 'failed']),
})
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
