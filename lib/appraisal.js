// Deterministic memory appraisal: the rules behind mem_admin(action='digest').
//
// No model, no vault write, no network. The caller supplies records it already
// read (the digest action reads a bounded recent window) and, when it has one,
// a link resolver. Every rule is a function of the record's bytes and the
// injected clock, so a replay of the same fixture produces the same findings.
//
// The output is a closed vocabulary: a caller may render the codes but may not
// invent new ones. The bound is part of the contract: an appraisal that cannot
// finish in maxMs reports scanned/truncated rather than pretending it saw the
// whole vault.
import { extractNoteLinks } from './graph-links.js'
import { localDate } from './note-health.js'

/** The finding codes, in the order they sort. */
export const APPRAISAL_CODES = Object.freeze([
  'review-overdue',
  'dead-link',
  'unverified',
  'duplicate-title',
  'contested',
])

/** Severity per code. The code, not the caller, decides how bad it is. */
export const APPRAISAL_SEVERITIES = Object.freeze({
  'review-overdue': 'error',
  'dead-link': 'error',
  unverified: 'warn',
  'duplicate-title': 'warn',
  contested: 'info',
})

/** Types whose provenance is expected to be explicit. */
const PROVENANCE_TYPES = Object.freeze(['decision', 'gotcha', 'convention'])

/** A note whose assertion is absent or whose confidence is below this is unverified. */
export const UNVERIFIED_CONFIDENCE = 0.5

/** The default note bound. */
export const DEFAULT_MAX_NOTES = 200
/** The default wall-clock bound, in milliseconds. */
export const DEFAULT_MAX_MS = 500
/** The default finding bound. */
export const DEFAULT_MAX_FINDINGS = 20
/** The most wikilinks inspected on one note. */
const MAX_LINKS_PER_NOTE = 20
/** The longest detail string the caller may render. */
const MAX_DETAIL_CHARS = 160

/**
 * Normalize a title for exact-twin grouping.
 *
 * Case, surrounding whitespace and runs of whitespace are not identity: the
 * vault's titles are written by a model and by hand, and the same title with a
 * double space is the same title for a reader.
 *
 * @param {unknown} title - the note title.
 * @returns {string} the normalized key.
 */
export function titleKey(title) {
  return String(title ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/gu, ' ')
    .trim()
}

/**
 * Parse one wikilink target: strip an alias and a heading, reject external or
 * traversing targets. Mirrors lib/brief.js's wikilinkTargets, deliberately.
 *
 * @param {string} text - one line or body.
 * @returns {string[]} vault-relative targets, without .md.
 */
/**
 * Parse the internal links of one note body, ignoring code spans and fences.
 *
 * This reuses the graph extractor rather than a second regex: a link inside an
 * inline code sample is not a claim that the target exists, and the graph and
 * the appraisal must agree about that. The target keeps its extension here; the
 * resolver applies Obsidian case, relative-path and basename rules.
 *
 * @param {string} text - one note body.
 * @returns {string[]} vault-relative targets, bounded.
 */
export function linkTargets(text) {
  return extractNoteLinks(String(text ?? ''))
    .filter(
      (target) =>
        target !== '' &&
        !target.startsWith('/') &&
        !target.startsWith('http://') &&
        !target.startsWith('https://') &&
        !target.split('/').includes('..'),
    )
    .slice(0, MAX_LINKS_PER_NOTE)
}

/**
 * Whether one frontmatter date is a valid YYYY-MM-DD before today.
 *
 * @param {unknown} value - the frontmatter value.
 * @param {string} today - today's local date.
 * @returns {boolean} whether the date is valid and past.
 */
function overdue(value, today) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false
  return value < today
}

/**
 * The confidence as a number, or null when absent/invalid.
 *
 * @param {unknown} value - the frontmatter value.
 * @returns {number|null} the confidence in [0,1], or null.
 */
function confidenceOf(value) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1 ? n : null
}

/**
 * One finding, with its detail clamped so a hostile note cannot inflate the
 * digest beyond its declared bound.
 *
 * @param {string} code - one of APPRAISAL_CODES.
 * @param {object} record - the note record.
 * @param {string} detail - why the finding exists.
 * @returns {object} the finding.
 */
function findingOf(code, record, detail) {
  return {
    code,
    severity: APPRAISAL_SEVERITIES[code],
    path: String(record.path),
    title: String(record.title ?? ''),
    detail: String(detail).slice(0, MAX_DETAIL_CHARS),
  }
}

/**
 * Appraise a bounded set of note records.
 *
 * A record is an object with path, title, type, status, data, body and updated.
 * The data field is the parsed frontmatter; body is the Markdown body.
 *
 * @param {object[]} records - the note records.
 * @param {object} [options] - appraisal inputs.
 * @param {string} [options.today] - local date; defaults to the injected clock.
 * @param {() => number} [options.now] - monotonic milliseconds; defaults to Date.now.
 * @param {number} [options.maxNotes] - note bound (1..1000).
 * @param {number} [options.maxMs] - wall-clock bound (>=0).
 * @param {number} [options.maxFindings] - finding bound (1..100).
 * @param {(target: string) => boolean} [options.resolves] - link resolver; absent skips dead-link.
 * @returns {{findings: object[], total: number, truncated: boolean, scanned: number}} the appraisal.
 * @throws {RangeError} when an input is outside its declared range.
 */
export function appraiseNotes(records, options = {}) {
  if (!Array.isArray(records)) throw new RangeError('appraiseNotes requires an array of records')
  const maxNotes = optionInt(options.maxNotes, DEFAULT_MAX_NOTES, 1, 1000, 'maxNotes')
  const maxMs = optionInt(options.maxMs, DEFAULT_MAX_MS, 0, 60_000, 'maxMs')
  const maxFindings = optionInt(options.maxFindings, DEFAULT_MAX_FINDINGS, 1, 100, 'maxFindings')
  if (options.now !== undefined && typeof options.now !== 'function')
    throw new RangeError('appraiseNotes.now must be a function')
  if (options.resolves !== undefined && typeof options.resolves !== 'function')
    throw new RangeError('appraiseNotes.resolves must be a function')
  const now = options.now ?? Date.now
  const started = now()
  const today = options.today ?? localDate(new Date())
  if (typeof today !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(today))
    throw new RangeError('appraiseNotes.today must be YYYY-MM-DD')

  const byTitle = new Map()
  for (const record of records.slice(0, maxNotes)) {
    const key = String(record?.type ?? '') + '\u0000' + titleKey(record?.title)
    if (!byTitle.has(key)) byTitle.set(key, [])
    byTitle.get(key).push(record)
  }

  const findings = []
  let scanned = 0
  let truncated = false
  for (const record of records) {
    if (scanned >= maxNotes) {
      truncated = true
      break
    }
    if (now() - started > maxMs) {
      truncated = true
      break
    }
    scanned += 1
    if (record === null || typeof record !== 'object' || typeof record.path !== 'string') continue
    const data = record.data !== null && typeof record.data === 'object' ? record.data : {}
    const status = typeof record.status === 'string' ? record.status : data.status
    if (status === 'contested')
      findings.push(findingOf('contested', record, 'status is contested; confirm or supersede'))
    if (overdue(data.review_after, today))
      findings.push(
        findingOf(
          'review-overdue',
          record,
          'review_after ' + data.review_after + ' is before ' + today,
        ),
      )
    if (PROVENANCE_TYPES.includes(record.type)) {
      const assertion = typeof data.assertion === 'string' ? data.assertion : null
      const confidence = confidenceOf(data.confidence)
      if (assertion === null || (confidence !== null && confidence < UNVERIFIED_CONFIDENCE))
        findings.push(
          findingOf(
            'unverified',
            record,
            assertion === null
              ? 'no assertion field'
              : 'confidence ' + confidence + ' is below ' + UNVERIFIED_CONFIDENCE,
          ),
        )
    }
    const targets = linkTargets(record.body)
    if (typeof options.resolves === 'function') {
      for (const target of targets) {
        if (!options.resolves(target, record)) {
          findings.push(findingOf('dead-link', record, 'unresolved wikilink: ' + target))
          break
        }
      }
    }
  }

  // One finding per exact-title group, naming the first path and the count; a
  // group of 40 copies must not consume the whole finding bound.
  for (const group of byTitle.values()) {
    if (group.length < 2) continue
    const first = group[0]
    if (typeof first?.path !== 'string') continue
    findings.push(
      findingOf(
        'duplicate-title',
        first,
        group.length +
          ' notes share this title (' +
          group
            .map((r) => r.path)
            .slice(0, 3)
            .join(', ') +
          ')',
      ),
    )
  }

  findings.sort((left, right) => {
    const rank = { error: 0, warn: 1, info: 2 }
    const bySeverity = rank[left.severity] - rank[right.severity]
    if (bySeverity !== 0) return bySeverity
    return left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  })
  const total = findings.length
  const bounded = findings.slice(0, maxFindings)
  return { findings: bounded, total, truncated: truncated || total > bounded.length, scanned }
}

/**
 * One integer option in range.
 *
 * @param {unknown} value - the supplied value or undefined.
 * @param {number} fallback - the default.
 * @param {number} min - inclusive minimum.
 * @param {number} max - inclusive maximum.
 * @param {string} name - the option name for the error.
 * @returns {number} the value.
 * @throws {RangeError} when it is not an integer in range.
 */
function optionInt(value, fallback, min, max, name) {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new RangeError('appraiseNotes.' + name + ' must be an integer in ' + min + '..' + max)
  return value
}
