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
  readNote,
} from './index-db.js'
import {
  RRF_K,
  SPARSE_MAX_CHUNK_CHARS,
  SPARSE_MAX_RECORDS,
  foldMatchText,
  rankSparse,
  reciprocalRankFusion,
} from './retrieval-rank.js'

export { readNote }
export { MAX_NOTE_BYTES, SUPERSEDED_STATUSES } from './index-db.js'

/** The three retrieval scopes of `mem_search` (spec §9). */
export const SEARCH_SCOPES = Object.freeze(['project', 'global', 'all'])

/** The retrieval engines `searchNotes` accepts. `lexical` is the default. */
export const RETRIEVAL_ENGINES = Object.freeze(['lexical', 'sparse'])

/**
 * How many lexical candidates one sparse search may look at (spec §5: 24).
 *
 * The bound is what keeps a sparse query's cost independent of vault size, and it
 * is also why sparse can never *add* a note the lexical index did not find: it
 * reorders a bounded window, it does not search.
 */
export const SPARSE_MAX_SOURCES = 24

/**
 * Why a sparse search returned the lexical order instead of a fused one.
 *
 * Reported on the result array as `sparseFallback` so a caller (and the
 * measurement record) can tell "sparse ran and agreed" from "sparse did not run".
 */
export const SPARSE_FALLBACK_REASONS = Object.freeze([
  'vault-root-unavailable',
  'no-lexical-candidates',
  'no-sparse-terms',
  'no-source-verified-candidates',
])

/**
 * Fusion scores closer than this are treated as tied before the exact-name and
 * path tie-breaks. It is far below the gap between two different integer rank
 * combinations and far above float noise from the same sum.
 */
const FUSED_TIE_EPSILON = 1e-12

/**
 * Resolve the scope of one search into the filter descriptor the index applies.
 *
 * @param {object} input - scope inputs.
 * @param {'project'|'global'|'all'} [input.scope] - the requested scope (default `project`).
 * @param {string|null} [input.projectId] - the caller's project id.
 * @param {string|null} [input.boundProjectId] - the index's bound project.
 * @param {string|null} [input.type] - optional note-type filter.
 * @param {string|null} [input.status] - optional exact status, applied before ranking.
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
    status = null,
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
      ...(status === null ? {} : { status }),
    }
  }
  if (scope === 'global') {
    // `global` has no project dimension at all: it is `Methods/` plus the user's
    // read-only `_meta/user.md`, so a `projectId` would filter nothing and is
    // ignored rather than refused.
    return { kind: 'global', excludeStatuses, type, ...(status === null ? {} : { status }) }
  }
  return {
    kind: 'all',
    filterProjectId: projectId ?? null,
    excludeStatuses,
    type,
    ...(status === null ? {} : { status }),
  }
}

// ---------------------------------------------------------------------------
// Sparse engine (Phase B)
// ---------------------------------------------------------------------------

/**
 * Split a note's searchable text into deterministic chunks of at most 1,200 code
 * points (spec §5's chunk bound).
 *
 * The split is lossless — every non-whitespace code point lands in exactly one
 * chunk — because the ranker's score must describe bytes that really exist; a
 * chunker that dropped or rewrote text would make "source-verified" a lie. A cut
 * prefers a whitespace boundary near the end of the window so a Latin token is
 * not split across two records, and falls back to the hard bound when the text
 * has no whitespace to cut at (a long CJK run).
 *
 * @param {string} text - the note text (title + body).
 * @param {number} [maxChars] - the chunk bound in code points.
 * @returns {string[]} the chunks, in source order; empty for blank text.
 */
export function chunkNoteText(text, maxChars = SPARSE_MAX_CHUNK_CHARS) {
  const source = typeof text === 'string' ? text : ''
  if (source.trim() === '') return []
  const codePoints = [...source]
  const chunks = []
  let start = 0
  while (start < codePoints.length) {
    let end = Math.min(start + maxChars, codePoints.length)
    if (end < codePoints.length) {
      // Prefer the last whitespace inside the final 40% of the window: a token cut
      // in half would contribute to neither chunk's term stream.
      const floor = start + Math.max(1, Math.floor(maxChars * 0.6))
      for (let index = end - 1; index >= floor; index -= 1) {
        const character = codePoints[index]
        if (character === '\n' || character === ' ') {
          end = index + 1
          break
        }
      }
    }
    const chunk = codePoints.slice(start, end).join('')
    if (chunk.trim() !== '') chunks.push(chunk)
    start = end
  }
  return chunks
}

/**
 * The alias list a note's frontmatter declares, in a shape the ranker accepts.
 *
 * Obsidian accepts either a scalar or a list for `aliases`; a frontmatter value
 * that is neither is ignored rather than stringified into a fake name.
 *
 * @param {unknown} raw - the parsed `aliases` field.
 * @returns {string[]} the usable aliases.
 */
function normalizeAliases(raw) {
  const values = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : []
  return values.filter((value) => typeof value === 'string' && value.trim() !== '')
}

/**
 * Re-read every lexical candidate's source and keep only the verified ones.
 *
 * This is the "source-verified chunk" rule: the index hit's `hash` is the hash the
 * index last saw, so a candidate whose bytes no longer hash to it is stale and is
 * left to its lexical rank rather than reranked on bytes the plugin cannot vouch
 * for. A missing, oversized or unreadable source is the same answer — exclude it,
 * never guess.
 *
 * @param {string} vaultRoot - the index's resolved vault root.
 * @param {object[]} hits - the lexical candidates.
 * @param {AbortSignal} [signal] - caller cancellation.
 * @returns {Promise<object[]>} candidates shaped `{hit, note}` whose source hash matched.
 * @throws {IndexError} when the caller cancelled between two reads.
 */
async function readVerifiedCandidates(vaultRoot, hits, signal) {
  const verified = []
  for (const hit of hits) {
    if (signal !== undefined && signal !== null && signal.aborted === true) {
      throw new IndexError('aborted', 'the search was cancelled')
    }
    let note
    try {
      note = await readNote(vaultRoot, hit.path, null)
    } catch {
      continue
    }
    if (note.hash !== hit.hash) continue
    verified.push({ hit, note })
  }
  return verified
}

/**
 * Build the bounded record list the sparse ranker scores.
 *
 * Records are chunks, because a whole 1 MiB note has no bounded representation.
 * They are selected round-robin by chunk index — chunk 0 of every candidate first,
 * then chunk 1, and so on until the ranker's 256-record bound — so a short note is
 * covered completely and a long one is sampled evenly instead of being represented
 * by its opening only. A match past the record bound is not seen by the sparse
 * side; the note keeps its lexical rank, which is why the two lists are fused
 * rather than replaced.
 *
 * @param {object[]} verified - candidates from {@link readVerifiedCandidates}.
 * @returns {{records: object[], keyToPath: Map<string, string>, names: Map<string, object>}} the ranker input and its maps.
 */
function buildSparseRecords(verified) {
  const prepared = verified.map(({ hit, note }) => {
    const title = note.title ?? hit.title ?? null
    const body = typeof note.body === 'string' ? note.body : ''
    const text = title === null ? body : `${title}\n${body}`
    return {
      path: hit.path,
      title,
      aliases: normalizeAliases(note.frontmatter?.aliases),
      chunks: chunkNoteText(text),
    }
  })
  const records = []
  const keyToPath = new Map()
  const names = new Map()
  for (const entry of prepared) names.set(entry.path, entry)
  let slot = 0
  let placed = true
  while (placed && records.length < SPARSE_MAX_RECORDS) {
    placed = false
    for (const entry of prepared) {
      const text = entry.chunks[slot]
      if (text === undefined) continue
      placed = true
      const key = `${entry.path}\u0000c${slot}`
      keyToPath.set(key, entry.path)
      records.push({ key, text, title: entry.title, aliases: entry.aliases })
      if (records.length >= SPARSE_MAX_RECORDS) break
    }
    slot += 1
  }
  return { records, keyToPath, names }
}

/**
 * The best (lowest) rank an entry holds in any fused list, or `Infinity` when it is
 * in none.
 *
 * @param {{ranks: number[]}} entry - one RRF entry.
 * @returns {number} the best 1-based rank.
 */
function bestRankOf(entry) {
  let best = Number.POSITIVE_INFINITY
  for (const rank of entry.ranks) if (rank > 0 && rank < best) best = rank
  return best
}

/**
 * Apply the documented final order to the fused entries.
 *
 * `reciprocalRankFusion` already orders by score, best rank and key; this adds the
 * exact title/alias tie-break that spec §5 calls for. It is a *tie-break*, not a
 * boost: a candidate whose title or alias equals the query only wins when the
 * fused score is already equal, so it cannot overrule what the two retrievers
 * agreed on.
 *
 * @param {object[]} fused - entries from `reciprocalRankFusion`.
 * @param {string} foldedQuery - the folded query text.
 * @param {Map<string, {title: string|null, aliases: string[]}>} names - each candidate's names.
 * @returns {object[]} the entries, best first.
 */
function orderFused(fused, foldedQuery, names) {
  const exact = (key) => {
    const entry = names.get(key)
    if (entry === undefined) return 0
    if (entry.title !== null && foldMatchText(entry.title) === foldedQuery) return 1
    return entry.aliases.some((alias) => foldMatchText(alias) === foldedQuery) ? 1 : 0
  }
  return [...fused].sort((left, right) => {
    const difference = right.score - left.score
    if (Math.abs(difference) > FUSED_TIE_EPSILON) return difference
    const exactDifference = exact(right.key) - exact(left.key)
    if (exactDifference !== 0) return exactDifference
    const rankDifference = bestRankOf(left) - bestRankOf(right)
    if (rankDifference !== 0) return rankDifference
    return left.key < right.key ? -1 : left.key > right.key ? 1 : 0
  })
}

/**
 * Attach the search facts to a sparse result array without making them elements.
 *
 * The lexical facts are carried over so a caller can compare the candidate
 * window's cost across engines; the sparse facts say what the reranker actually
 * saw and whether it ran at all.
 *
 * @param {object[]} hits - the returned hits.
 * @param {object} facts - the search facts.
 * @returns {object[]} the same array.
 */
function withEngineMeta(hits, facts) {
  Object.defineProperties(hits, {
    truncated: { value: facts.truncated, enumerable: false },
    truncationReason: { value: facts.truncationReason, enumerable: false },
    candidateWindow: { value: facts.candidateWindow, enumerable: false },
    rowsExamined: { value: facts.rowsExamined, enumerable: false },
    candidatesScored: { value: facts.candidatesScored, enumerable: false },
    retrievalEngine: { value: 'sparse', enumerable: false },
    sparseSources: { value: facts.sparseSources, enumerable: false },
    sparseVerified: { value: facts.sparseVerified, enumerable: false },
    sparseRecords: { value: facts.sparseRecords, enumerable: false },
    sparseFallback: { value: facts.sparseFallback, enumerable: false },
  })
  return hits
}

/**
 * Run one sparse search: lexical candidates, source-verified chunks, sparse
 * ranking and RRF fusion.
 *
 * The lexical call is bounded to {@link SPARSE_MAX_SOURCES} regardless of the
 * caller's limit, because the candidate window is the cost ceiling. Every
 * fallback returns the lexical order sliced to the caller's limit — the honest
 * answer when the plugin cannot verify the bytes a rerank would need — and says
 * why on the result array.
 *
 * @param {object} index - the object `openIndex()` returns.
 * @param {object} request - the search request.
 * @param {string} request.query - the query.
 * @param {object} request.filters - the resolved scope descriptor.
 * @param {number} request.limit - the caller's hit limit.
 * @param {AbortSignal} [request.signal] - caller cancellation.
 * @returns {Promise<object[]>} hits, best first, carrying the sparse search facts.
 */
async function searchSparse(index, { query, filters, limit, signal }) {
  const lexical = await index.search({ query, filters, limit: SPARSE_MAX_SOURCES, signal })
  const lexicalFacts = {
    truncated: lexical.truncated === true,
    truncationReason: lexical.truncationReason ?? null,
    candidateWindow: lexical.candidateWindow ?? SPARSE_MAX_SOURCES,
    rowsExamined: lexical.rowsExamined ?? lexical.length,
    candidatesScored: lexical.candidatesScored ?? lexical.length,
  }
  const fallback = (reason, sparseVerified = 0, sparseRecords = 0) =>
    withEngineMeta(lexical.slice(0, limit), {
      ...lexicalFacts,
      sparseSources: lexical.length,
      sparseVerified,
      sparseRecords,
      sparseFallback: reason,
    })
  if (lexical.length === 0) return fallback('no-lexical-candidates')
  // The vault root is needed to re-read a candidate's source, and the index is the
  // only object that knows it. An index-shaped object that cannot answer (a test
  // seam, a future backend) degrades to lexical instead of guessing a root.
  let status
  try {
    status = typeof index.status === 'function' ? index.status() : null
  } catch {
    // A status probe that cannot answer is the same outcome as one that has no
    // root: fall back to lexical rather than guess where the vault lives.
    status = null
  }
  const vaultRoot = typeof status?.vaultRoot === 'string' ? status.vaultRoot : null
  if (vaultRoot === null) return fallback('vault-root-unavailable')
  const verified = await readVerifiedCandidates(vaultRoot, lexical, signal)
  if (verified.length === 0) return fallback('no-source-verified-candidates')
  const { records, keyToPath, names } = buildSparseRecords(verified)
  const ranked = rankSparse({ query, records })
  // A query the tokenizer cannot express sparsely (a lone CJK character takes the
  // index's substring branch) has nothing to rerank with.
  if (ranked.length === 0) return fallback('no-sparse-terms', verified.length, records.length)

  // Note-level sparse order: a note takes the position of its best chunk.
  const sparseScore = new Map()
  const sparseRanking = []
  for (const entry of ranked) {
    const path = keyToPath.get(entry.key)
    if (path === undefined || sparseScore.has(path)) continue
    sparseScore.set(path, entry.score)
    sparseRanking.push(path)
  }
  const lexicalRanking = lexical.map((hit) => hit.path)
  const fused = reciprocalRankFusion([lexicalRanking, sparseRanking], { k: RRF_K })
  const ordered = orderFused(fused, foldMatchText(query), names)
  const lexicalRank = new Map(lexicalRanking.map((path, position) => [path, position + 1]))
  const sparseRank = new Map(sparseRanking.map((path, position) => [path, position + 1]))
  const byPath = new Map(lexical.map((hit) => [hit.path, hit]))
  const hits = ordered.slice(0, limit).map((entry) => {
    const hit = byPath.get(entry.key)
    return {
      ...hit,
      signals: {
        ...(hit.signals ?? {}),
        retrievalEngine: 'sparse',
        fusedScore: entry.score,
        lexicalRank: lexicalRank.get(entry.key) ?? null,
        sparseRank: sparseRank.get(entry.key) ?? null,
        sparseScore: sparseScore.get(entry.key) ?? null,
      },
    }
  })
  return withEngineMeta(hits, {
    ...lexicalFacts,
    sparseSources: lexical.length,
    sparseVerified: verified.length,
    sparseRecords: records.length,
    sparseFallback: null,
  })
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
 * @param {string|null} [options.status] - optional exact note status.
 * @param {string|null} [options.projectId] - caller project id; a different one refuses `project`.
 * @param {boolean} [options.includeHistory] - include `superseded`/`archived` notes.
 * @param {number} [options.limit] - maximum hits (default 8, at most 50).
 * @param {'lexical'|'sparse'} [options.engine] - ranking engine (default `lexical`, the
 *   pre-v0.4 behaviour). `sparse` reranks at most {@link SPARSE_MAX_SOURCES} lexical
 *   candidates by local TF-IDF/cosine and fuses the two orders with RRF k=60; it
 *   returns at most that many hits even when `limit` is larger, and falls back to
 *   the lexical order when no candidate's source can be verified.
 * @param {AbortSignal} [options.signal] - caller cancellation for the ready barrier and the search itself.
 * @param {number} [options.readyTimeoutMs] - ready-barrier budget (default `DEFAULT_READY_TIMEOUT_MS`).
 * @returns {Promise<object[]>} hits, best first, each carrying `path`, `title`, `snippet`,
 *   `signals`. The array also carries non-enumerable search facts: `truncated` (a bound
 *   stopped the search, so more matches may exist), `truncationReason`, `rowsExamined`
 *   and `candidatesScored`. An empty array with `truncated: false` means "searched and
 *   found nothing"; with `truncated: true` it means "the bound cut the search short".
 *   A sparse result additionally carries `retrievalEngine`, `sparseSources`,
 *   `sparseVerified`, `sparseRecords` and `sparseFallback`; the lexical result
 *   carries none of them, which keeps the default path byte-identical.
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
    status = null,
    type = null,
    projectId = null,
    includeHistory = false,
    limit = DEFAULT_LIMIT,
    engine = 'lexical',
    signal,
    readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
  } = options
  if (typeof query !== 'string' || query.trim() === '')
    throw new RangeError('query must be a non-blank string')
  if (type !== null && type !== undefined && (typeof type !== 'string' || type.trim() === '')) {
    throw new RangeError('type must be null or a non-blank string')
  }
  if (status !== null && (typeof status !== 'string' || status.trim() === '')) {
    throw new RangeError('status must be null or a non-blank string')
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new RangeError(`limit must be an integer between 1 and ${MAX_LIMIT}`)
  }
  // Refused here, with the other argument errors, so an unknown engine can never
  // reach the index or the vault (the config schema refuses it earlier too).
  if (!RETRIEVAL_ENGINES.includes(engine)) {
    throw new RangeError(`engine must be one of ${RETRIEVAL_ENGINES.join(', ')}`)
  }
  const filters = resolveScope({
    scope,
    projectId,
    boundProjectId: index.boundProjectId ?? null,
    type,
    status,
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
  // The default path is untouched on purpose: same single call, same arguments,
  // same array. That is what makes "lexical is byte-identical" checkable.
  if (engine === 'lexical') return index.search({ query, filters, limit, signal })
  return searchSparse(index, { query, filters, limit, signal })
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
