// @ts-check
// Retrieval policy for the obsidian-mem vault (Task 9, spec §7/§9).
//
// `lib/index-db.js` owns *where* memory is stored and how text is tokenised;
// this module owns *who may see what*, and refuses to answer when it cannot.
// Three rules shape it:
//
//   * `scope` decides the corpus. `project` (the default) is the bound project
//     only, `global` is the cross-project `Methods/` directory plus the read-only
//     `_meta/user.md`, and `all` crosses projects and may be narrowed with a
//     `projectId`. Passing a *different* `projectId` to `project` is refused
//     rather than silently widened — the isolation is the point (spec §9).
//   * History is excluded unless asked for: `superseded` and `archived` notes
//     stay out of the default result set.
//   * A search never reports "nothing" for "not ready yet". The ready barrier
//     answers first, and a timeout becomes an `index-not-ready` refusal.
//
// `readNote` is re-exported from `./index-db.js` so the retrieval surface
// (`searchNotes` + `readNote`) has one import site.
import {
  DEFAULT_LIMIT,
  DEFAULT_READY_TIMEOUT_MS,
  IndexError,
  MAX_LIMIT,
  SUPERSEDED_STATUSES,
  indexText,
} from './index-db.js'

export { readNote } from './index-db.js'
export { MAX_NOTE_BYTES, SUPERSEDED_STATUSES } from './index-db.js'

/** The three retrieval scopes of `mem_search` (spec §9). */
export const SEARCH_SCOPES = Object.freeze(['project', 'global', 'all'])

/**
 * Resolve the scope of one search into the filter descriptor the index applies.
 *
 * @param {object} input - scope inputs.
 * @param {'project'|'global'|'all'} [input.scope] - the requested scope (default `project`).
 * @param {string|null} [input.projectId] - the caller's project id.
 * @param {string|null} [input.boundProjectId] - the index's bound project.
 * @param {string|null} [input.type] - optional note-type filter.
 * @param {boolean} [input.includeHistory] - whether `superseded`/`archived` notes are wanted.
 * @returns {{kind: string, projectId?: string, projectId8?: string, filterProjectId?: string|null, excludeStatuses: string[], type: string|null}} the descriptor.
 * @throws {IndexError} when `project` cannot be honoured (`project-unbound`, `project-mismatch`).
 * @throws {RangeError} when the scope is unknown.
 */
export function resolveScope(input = {}) {
  const {
    scope = 'project',
    projectId = null,
    boundProjectId = null,
    type = null,
    includeHistory = false,
  } = input
  if (!SEARCH_SCOPES.includes(scope))
    throw new RangeError(`scope must be one of ${SEARCH_SCOPES.join(', ')}`)
  const excludeStatuses = includeHistory ? [] : [...SUPERSEDED_STATUSES]
  if (scope === 'project') {
    if (boundProjectId === null || boundProjectId === undefined) {
      throw new IndexError(
        'project-unbound',
        'scope "project" needs a bound project; an unbound context may only use scope "global"',
      )
    }
    if (projectId !== null && projectId !== undefined && projectId !== boundProjectId) {
      throw new IndexError(
        'project-mismatch',
        `scope "project" is bound to ${boundProjectId}; refusing to search ${projectId} instead of silently crossing projects`,
      )
    }
    return {
      kind: 'project',
      projectId: boundProjectId,
      projectId8: String(boundProjectId).slice(0, 8),
      excludeStatuses,
      type,
    }
  }
  if (scope === 'global') {
    // `global` has no project dimension at all: it is `Methods/` plus the user's
    // read-only `_meta/user.md`, so a `projectId` would filter nothing and is
    // ignored rather than refused.
    return { kind: 'global', excludeStatuses, type }
  }
  return { kind: 'all', filterProjectId: projectId ?? null, excludeStatuses, type }
}

/**
 * Search the vault's memory through an open index.
 *
 * @param {object} index - the object returned by `openIndex`.
 * @param {object} options - the query.
 * @param {string} [options.query] - the user's query text (never interpreted as FTS
 *   syntax). Optional in the *type* only because `options` defaults to `{}`: the
 *   runtime contract is unchanged and omitting it is still a `RangeError`, not a
 *   search for everything.
 * @param {'project'|'global'|'all'} [options.scope] - retrieval scope, default `project`.
 * @param {string|null} [options.type] - optional note-type filter.
 * @param {string|null} [options.projectId] - caller project id; a different one refuses `project`.
 * @param {boolean} [options.includeHistory] - include `superseded`/`archived` notes.
 * @param {number} [options.limit] - maximum hits (default 8, at most 50).
 * @param {AbortSignal} [options.signal] - caller cancellation for the ready barrier and the search itself.
 * @param {number} [options.readyTimeoutMs] - ready-barrier budget (default `DEFAULT_READY_TIMEOUT_MS`).
 * @returns {Promise<object[]>} hits, best first, each carrying `path`, `title`, `snippet`,
 *   `signals`. The array also carries non-enumerable search facts: `truncated` (a bound
 *   stopped the search, so more matches may exist), `truncationReason`, `rowsExamined`
 *   and `candidatesScored`. An empty array with `truncated: false` means "searched and
 *   found nothing"; with `truncated: true` it means "the bound cut the search short".
 * @throws {IndexError} when the index is not ready, unbound for `project`, bound elsewhere, or cancelled.
 * @throws {RangeError} when an argument is malformed.
 */
export async function searchNotes(index, options = {}) {
  if (
    index === null ||
    typeof index !== 'object' ||
    typeof index.search !== 'function' ||
    typeof index.waitReady !== 'function'
  ) {
    throw new RangeError('searchNotes requires the object returned by openIndex()')
  }
  const {
    query,
    scope = 'project',
    type = null,
    projectId = null,
    includeHistory = false,
    limit = DEFAULT_LIMIT,
    signal,
    readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
  } = options
  if (typeof query !== 'string' || query.trim() === '')
    throw new RangeError('query must be a non-blank string')
  if (type !== null && type !== undefined && (typeof type !== 'string' || type.trim() === '')) {
    throw new RangeError('type must be null or a non-blank string')
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new RangeError(`limit must be an integer between 1 and ${MAX_LIMIT}`)
  }
  const filters = resolveScope({
    scope,
    projectId,
    boundProjectId: index.boundProjectId ?? null,
    type,
    includeHistory,
  })
  const readiness = await index.waitReady(signal, readyTimeoutMs)
  if (!readiness.ready) {
    // A cancelled wait is a cancellation, not an index that failed to become ready.
    if (readiness.reason === 'aborted') throw new IndexError('aborted', 'the search was cancelled')
    throw new IndexError('index-not-ready', `the memory index is not ready: ${readiness.reason}`, {
      details: readiness,
    })
  }
  return index.search({ query, filters, limit, signal })
}
// ---------------------------------------------------------------------------
// Title twins
// ---------------------------------------------------------------------------

/**
 * The overlap at which two titles describe the same note.
 *
 * Measured on this repository's own vault: the duplicate pairs a reader finds
 * by inspection score 0.80 (a distilled pitfall beside an agent-written one) and
 * 0.72 (a distilled ADR restating another), while unrelated same-type titles sit
 * below 0.5. The threshold is placed at the top of that gap because the two
 * errors are not symmetric: a missed twin leaves a duplicate, a false twin
 * silently discards a distilled fact.
 */
export const TITLE_TWIN_OVERLAP = 0.8

/**
 * How much two titles share, as the overlap coefficient of their index tokens.
 *
 * The coefficient is used rather than Jaccard because a distilled title is
 * usually a reworded *superset* — dividing by the smaller set asks "does an
 * existing note already cover this?", which is the question. Jaccard punishes
 * the length difference instead: the same pitfall pair scores 0.60 under it,
 * below the threshold, and would have been missed.
 *
 * @param {string} left - one title.
 * @param {string} right - the other title.
 * @returns {number} the shared fraction of the smaller token set, 0 when either is empty.
 */
export function titleOverlap(left, right) {
  const a = new Set(indexText(String(left)))
  const b = new Set(indexText(String(right)))
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const token of a) if (b.has(token)) shared += 1
  return shared / Math.min(a.size, b.size)
}

/**
 * The note in the bound project that an incoming title would duplicate.
 *
 * The lookup is scoped exactly like `mem_search`: the bound project only, never
 * a sibling, and never a superseded or archived note — a replaced note is not a
 * twin. `type` narrows it further, because a decision and a pitfall about one
 * fact are deliberately different records.
 *
 * @param {object} index - the object `openIndex()` returns.
 * @param {object} options - the candidate.
 * @param {string} [options.title] - the title about to be written; blank answers `null`.
 * @param {string|null} [options.type] - the candidate's routed type, when it has one.
 * @param {AbortSignal} [options.signal] - cancellation.
 * @returns {Promise<{id: string|null, path: string, title: string, score: number}|null>} the twin, or null.
 */
export async function findTitleTwin(index, { title = '', type = null, signal } = {}) {
  if (typeof title !== 'string' || title.trim() === '') return null
  const hits = await searchNotes(index, { query: title, scope: 'project', type, limit: 8, signal })
  let best = null
  for (const hit of hits) {
    const score = titleOverlap(title, hit.title ?? '')
    if (score < TITLE_TWIN_OVERLAP) continue
    if (best === null || score > best.score)
      best = { id: hit.id ?? null, path: hit.path, title: hit.title ?? '', score }
  }
  return best
}
