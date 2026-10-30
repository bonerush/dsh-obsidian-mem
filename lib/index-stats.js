// The pure projections behind the 概览 charts (memory-panel v0.4 design §3.3).
//
// These are the halves of `stats`, `activity` and `tagFrequencies` that never
// touch a database handle, an in-memory record map or a file: they take rows (or a
// `Map<tag, n>`) and answer numbers. ./index-db.js keeps the two backends and the
// ready barrier, and calls down into this module so the two backends cannot each
// keep a copy of the bucketing rule — which is the disagreement the index is
// built to prevent.
//
// The layer is L1 rather than L0 only because the activity window needs today's
// local calendar day from ./note-health.js (L0). Nothing here imports a backend.
//
// Two facts belong to this file rather than its caller:
//
//   * A day is a *local* calendar day. `toISOString()` is UTC and answers yesterday
//     for a UTC+8 host after 16:00, so every day below is built from local parts.
//   * `created` and `updated` are mutually exclusive **on one local day**: a note
//     written and then edited the same day is one creation, not a creation plus an
//     update. An edit on a later day is an update even when the note's creation is
//     itself inside the window; a note created before the window contributes only
//     its update. The digest applies the same same-day rule to the same two
//     frontmatter values and does *not* have the file-mtime fallback this panel spec
//     requires, so the two are deliberately separate implementations kept in step by
//     hand.
import { localDate } from './note-health.js'

/** The shortest and longest activity window the panel may ask for. */
export const MIN_ACTIVITY_DAYS = 7
/**
 * The widest activity window the panel may ask for: a year.
 *
 * The panel route asks for a narrower one (`ACTIVITY_DAYS` = 84, twelve weeks, in
 * `lib/panel-route.js`) and the heat map draws whatever window it is handed whole,
 * so this bound guards the aggregate read, not the chart's column count.
 */
export const MAX_ACTIVITY_DAYS = 365
/** The largest tag page the panel may ask for. */
export const MAX_TAG_FREQUENCIES = 50

/** A `YYYY-MM-DD` local day, or null for anything that is not one. */
const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/

/** Local calendar parts of a Date as a `YYYY-MM-DD` day. */
function localDayOf(date) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * Shift a local `YYYY-MM-DD` day by whole days.
 *
 * Built from local calendar parts rather than an ISO string so a host timezone
 * can never move the day. Invalid input answers `null` instead of throwing,
 * because the callers are aggregations over stored text, not a validator.
 *
 * @param {string} day - a `YYYY-MM-DD` day.
 * @param {number} offset - whole days to add (negative moves back).
 * @returns {string|null} the shifted day, or null when `day` is not a day.
 */
export function shiftDay(day, offset) {
  const match = DAY_PATTERN.exec(String(day))
  if (match === null) return null
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  if (Number.isNaN(date.getTime())) return null
  date.setDate(date.getDate() + offset)
  return localDayOf(date)
}

/**
 * The local calendar day of an integer microsecond timestamp.
 *
 * `notes.mtime` is microseconds, so the division is load-bearing: without it every
 * timestamp lands in March 1970.
 *
 * @param {number|bigint} micros - an integer microsecond timestamp.
 * @returns {string|null} the day, or null when the value is not a time.
 */
export function localDayOfMicros(micros) {
  const date = new Date(Math.round(Number(micros) / 1000))
  if (Number.isNaN(date.getTime())) return null
  return localDayOf(date)
}

/**
 * A stored date as a `YYYY-MM-DD` day, or null.
 *
 * Frontmatter dates may carry a time (`2026-10-29 10:00:00`); only the day is read
 * here, because the aggregate is a calendar, not a clock.
 *
 * @param {unknown} value - a stored value.
 * @returns {string|null} the leading day, or null.
 */
export function normalizeDay(value) {
  if (typeof value !== 'string') return null
  const day = value.trim().slice(0, 10)
  return DAY_PATTERN.test(day) ? day : null
}

/**
 * The days a `days`-long window ending today covers, oldest first.
 *
 * @param {number} days - a validated window length.
 * @returns {{from: string, to: string, days: string[]}} the window.
 */
export function activityWindow(days) {
  const to = localDate()
  const list = []
  for (let offset = days - 1; offset >= 0; offset -= 1) list.push(shiftDay(to, -offset))
  return { from: list[0], to, days: list }
}

/** Validate an activity request's window length. */
export function activityRequest(options) {
  const days = options.days === undefined ? MAX_ACTIVITY_DAYS : options.days
  if (!Number.isInteger(days) || days < MIN_ACTIVITY_DAYS || days > MAX_ACTIVITY_DAYS)
    throw new RangeError(
      `activity days must be an integer between ${MIN_ACTIVITY_DAYS} and ${MAX_ACTIVITY_DAYS}`,
    )
  return days
}

/**
 * Bucket one note's creation and update into a window.
 *
 * The mutuality is per local day, not per window: a note created and edited on the
 * same day is one creation, while an edit on a later day is an update even when the
 * creation is also inside this window. The previous window-wide suppression counted
 * only the updates of notes created *before* the window, which made the 84-day
 * series structurally incapable of showing an update on a vault younger than the
 * window (measured on a real vault: 950 creations, 0 updates).
 *
 * @param {{created: string|null, updated: string|null, mtimeDay: string|null}} row - one note's days.
 * @param {Map<string, number>} index - day → position in the window.
 * @param {number[]} created - creation counts, mutated.
 * @param {number[]} updated - update counts, mutated.
 * @returns {void}
 */
export function bucketOneDay(row, index, created, updated) {
  const creationDay = row.created ?? row.mtimeDay
  const creationAt = creationDay === null ? undefined : index.get(creationDay)
  if (creationAt !== undefined) created[creationAt] += 1
  // A same-day edit is not a second event; a later-day edit is one, even when the
  // creation above already counted inside the window.
  const updatedAt = row.updated === null ? undefined : index.get(row.updated)
  if (updatedAt !== undefined && row.updated !== creationDay) updated[updatedAt] += 1
}

/**
 * Bucket every row of one backend's activity read into the window's two series.
 *
 * @param {{from: string, to: string, days: string[]}} window - the window.
 * @param {Array<{created: string|null, updated: string|null, mtimeDay: string|null}>} rows - the rows.
 * @returns {{from: string, to: string, days: string[], created: number[], updated: number[]}} the series.
 */
export function bucketActivity(window, rows) {
  const index = new Map(window.days.map((day, position) => [day, position]))
  const created = new Array(window.days.length).fill(0)
  const updated = new Array(window.days.length).fill(0)
  for (const row of rows) bucketOneDay(row, index, created, updated)
  return { ...window, created, updated }
}

/**
 * One activity row's three candidate days, normalised.
 *
 * @param {{created?: unknown, updated?: unknown, mtime: unknown}} row - a raw row.
 * @returns {{created: string|null, updated: string|null, mtimeDay: string|null}} the days.
 */
export function normalizeActivityRow(row) {
  return {
    created: normalizeDay(row.created),
    updated: normalizeDay(row.updated),
    mtimeDay: localDayOfMicros(row.mtime),
  }
}

/**
 * Whether one record belongs to the bound project, by the graph's rule.
 *
 * The same predicate the graph projection and the in-memory aggregates use, so a
 * note cannot be in scope for one read and out of it for another.
 *
 * @param {object} row - one record or note row.
 * @param {{projectId: string, projectId8: string}} pair - the bound project.
 * @returns {boolean} whether the row is in scope.
 */
export function eligibleForProject(row, pair) {
  if (row.project === pair.projectId) return true
  return (
    (row.project === null || row.project === undefined) && row.projectDirId8 === pair.projectId8
  )
}

/**
 * The bounded tag ranking, with the two numbers the panel prints beside it.
 *
 * `total` is every occurrence in scope — the number beside the ranking — while
 * `items` is the bounded page, so a caller can say "另有 N 个" without a second
 * read. Ties break by tag text so two backends agree.
 *
 * `distinct` is how many DIFFERENT tags exist in scope, which is not
 * `items.length` once the page truncates. The panel needs it because "另有 N 个
 * 标签" is a tag count: deriving the remainder from `total` would print an
 * occurrence count labelled as tags, correct only when every unshown tag has a
 * single occurrence.
 *
 * @param {Map<string, number>} counts - tag → occurrences.
 * @param {number} limit - the page size.
 * @returns {{items: Array<{tag: string, n: number}>, total: number, distinct: number}} the ranking.
 */
export function rankTags(counts, limit) {
  const total = [...counts.values()].reduce((sum, n) => sum + n, 0)
  const items = [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([tag, n]) => ({ tag, n }))
  return { items, total, distinct: counts.size }
}
