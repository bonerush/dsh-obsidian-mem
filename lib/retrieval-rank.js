// The deterministic sparse retrieval baseline (v0.4 spec §5, option A).
//
// The premise measured into this design: the existing index is lexical (BM25 over
// the same CJK-bigram + Latin tokenisation), and the cheapest honest improvement
// is a reranker that can see term *weight* — a rare query term matters more than a
// common one, and an exact title or alias match should win an otherwise tied
// score. No model, no network, no dependency: given the same records and the same
// query, this module returns the same order on every machine and every run.
//
// The rules it is built on:
//
//   * **One tokenizer, borrowed.** CJK runs become overlapping bigrams and Latin
//     runs become lowercased words — indexText from ./index-db.js, the same pure
//     function the index and the query side already share. A second copy here
//     would drift on the first tokenizer bug fix, and the sparse ranking would
//     disagree with the lexical one it is fused with.
//   * **TF-IDF, not raw counts.** A term that appears in every record cannot
//     separate them; the smoothed IDF (ln((N+1)/(df+1)) + 1) keeps it above zero
//     so a record that matches only a ubiquitous term is still a candidate.
//   * **Cosine, so length does not win.** A long chunk that repeats a query term
//     twice beats a short one that says it once (that is tf's job), but a long
//     chunk that merely contains more unrelated words does not get a free boost.
//   * **Bounded input.** The caller supplies source-verified chunks; this module
//     refuses more than SPARSE_MAX_RECORDS records or a chunk over
//     SPARSE_MAX_CHUNK_CHARS code points rather than silently truncating what it
//     was asked to rank.
//   * **Deterministic ties.** Two equal cosine scores are broken by an exact
//     title/alias match (spec §5's "deterministic exact-title/alias tie-breaks"),
//     then by the record key, never by input order. That is why the sort has two
//     stages: score first, identity last.
//
// Ranking is the only job here: no index read, no vault access, no I/O.
import { MAX_QUERY_TOKENS, indexText } from './index-text.js'

/** The RRF constant the design fixes (spec §5). */
export const RRF_K = 60
/** The largest record list one rank call accepts. */
export const SPARSE_MAX_RECORDS = 256
/** The largest chunk this ranker will score, in code points (spec §5: 1,200). */
export const SPARSE_MAX_CHUNK_CHARS = 1200
/**
 * Scores closer than this are treated as tied before the exact-match and key
 * tie-breaks run. The value is far below the difference one shared token makes on
 * the corpora this reranks, and far above float noise from the same computation.
 */
const SCORE_TIE_EPSILON = 1e-12

/**
 * The query's term stream, deduplicated in first-occurrence order and capped like
 * the index's own query-side token list.
 *
 * @param {string} query - the user's query text.
 * @returns {string[]} lowercased Latin words and CJK bigrams.
 * @throws {RangeError} when the query is not a non-blank string.
 */
export function sparseQueryTokens(query) {
  if (typeof query !== 'string' || query.trim() === '') {
    throw new RangeError('retrieval query must be a non-blank string')
  }
  const seen = new Set()
  const tokens = []
  for (const token of indexText(query)) {
    if (seen.has(token)) continue
    seen.add(token)
    tokens.push(token)
    if (tokens.length >= MAX_QUERY_TOKENS) break
  }
  return tokens
}

/**
 * The normalised form used only for an exact title/alias comparison.
 *
 * Case and whitespace are folded because "Scheduler" and "scheduler" are the same
 * name to a reader; nothing else is normalised, because a near-miss title must
 * fall through to the score and the key, not pretend to be exact.
 *
 * Exported (additively, for the Phase B wiring) so the search layer's fused
 * tie-break applies the same definition of "exact" as this ranker instead of
 * keeping a second copy that could drift.
 *
 * @param {string} text - a title, an alias or the query.
 * @returns {string} the folded form.
 */
export function foldMatchText(text) {
  return String(text).trim().toLowerCase().replace(/\s+/gu, ' ')
}

/**
 * Validate and normalise the caller's bounded record list.
 *
 * @param {object[]} records - candidates shaped {key, text, title?, aliases?}.
 * @returns {object[]} the records with their token streams.
 * @throws {RangeError} when the list or one record breaks the contract.
 */
function requireRecords(records) {
  if (!Array.isArray(records)) throw new RangeError('retrieval records must be an array')
  if (records.length > SPARSE_MAX_RECORDS) {
    throw new RangeError(
      'retrieval records must contain at most ' + SPARSE_MAX_RECORDS + ' entries',
    )
  }
  const keys = new Set()
  const normalised = []
  for (const record of records) {
    if (record === null || typeof record !== 'object' || Array.isArray(record)) {
      throw new RangeError('each retrieval record must be an object')
    }
    const key = record.key
    if (typeof key !== 'string' || key.trim() === '') {
      throw new RangeError('each retrieval record must carry a non-blank string key')
    }
    if (keys.has(key)) throw new RangeError('duplicate retrieval record key: ' + key)
    if (typeof record.text !== 'string' || record.text.trim() === '') {
      throw new RangeError('retrieval record ' + key + ' must carry non-blank text')
    }
    if ([...record.text].length > SPARSE_MAX_CHUNK_CHARS) {
      throw new RangeError(
        'retrieval record ' +
          key +
          ' exceeds the ' +
          SPARSE_MAX_CHUNK_CHARS +
          '-code-point chunk bound',
      )
    }
    const title = record.title === undefined || record.title === null ? null : record.title
    if (title !== null && (typeof title !== 'string' || title.trim() === '')) {
      throw new RangeError('retrieval record ' + key + ' has a malformed title')
    }
    const aliases = record.aliases === undefined || record.aliases === null ? [] : record.aliases
    if (
      !Array.isArray(aliases) ||
      aliases.some((alias) => typeof alias !== 'string' || alias.trim() === '')
    ) {
      throw new RangeError('retrieval record ' + key + ' has malformed aliases')
    }
    keys.add(key)
    normalised.push({
      key,
      tokens: indexText(record.text),
      matchNames: [title, ...aliases].filter((name) => name !== null).map(foldMatchText),
    })
  }
  return normalised
}

/**
 * The record tokens' inverse document frequency, smoothed so no term costs zero.
 *
 * @param {object[]} documents - the normalised records.
 * @returns {Map<string, number>} term to IDF.
 */
function inverseDocumentFrequency(documents) {
  const documentFrequency = new Map()
  for (const document of documents) {
    for (const token of new Set(document.tokens)) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1)
    }
  }
  const total = documents.length
  const idf = new Map()
  for (const [token, frequency] of documentFrequency) {
    idf.set(token, Math.log((total + 1) / (frequency + 1)) + 1)
  }
  return idf
}

/**
 * The cosine score of every record that shares at least one term with the query.
 *
 * @param {string[]} queryTokens - the deduplicated query terms.
 * @param {object[]} records - the normalised, validated records.
 * @returns {object[]} entries with key, score and matchNames, positive scores only.
 */
function cosineScores(queryTokens, records) {
  const idf = inverseDocumentFrequency(records)
  const fallbackIdf = Math.log(records.length + 1) + 1
  const queryWeights = new Map()
  let queryNorm = 0
  for (const token of queryTokens) {
    const weight = idf.get(token) ?? fallbackIdf
    queryWeights.set(token, (queryWeights.get(token) ?? 0) + weight)
  }
  for (const weight of queryWeights.values()) queryNorm += weight * weight
  queryNorm = Math.sqrt(queryNorm)

  const scored = []
  for (const record of records) {
    const termFrequency = new Map()
    for (const token of record.tokens) {
      termFrequency.set(token, (termFrequency.get(token) ?? 0) + 1)
    }
    let dot = 0
    let norm = 0
    for (const [token, count] of termFrequency) {
      const weight = count * (idf.get(token) ?? fallbackIdf)
      norm += weight * weight
      const queryWeight = queryWeights.get(token)
      if (queryWeight !== undefined) dot += weight * queryWeight
    }
    norm = Math.sqrt(norm)
    const score = dot === 0 || norm === 0 || queryNorm === 0 ? 0 : dot / (queryNorm * norm)
    if (score > 0) scored.push({ key: record.key, score, matchNames: record.matchNames })
  }
  return scored
}

/**
 * Sort scored records by the documented deterministic order.
 *
 * @param {object[]} scored - entries with key, score and matchNames.
 * @param {string} foldedQuery - the folded query text.
 * @returns {object[]} the same entries, sorted best first.
 */
function orderResults(scored, foldedQuery) {
  const exact = (entry) => (entry.matchNames.includes(foldedQuery) ? 1 : 0)
  return scored.sort((left, right) => {
    const difference = right.score - left.score
    if (Math.abs(difference) > SCORE_TIE_EPSILON) return difference
    const leftExact = exact(left)
    const rightExact = exact(right)
    if (leftExact !== rightExact) return rightExact - leftExact
    return left.key < right.key ? -1 : left.key > right.key ? 1 : 0
  })
}

/**
 * Rank the caller's bounded records against one query, deterministically.
 *
 * The result is a filtered ranking: only records that share a term with the query
 * are returned, in score order. Each item carries the query's term list so a
 * caller can report *why* a candidate was considered without re-tokenising — and
 * so a regression test can pin the tokenizer it actually used.
 *
 * @param {object} input - the rank request.
 * @param {string} input.query - the user's query text.
 * @param {object[]} input.records - bounded records shaped {key, text, title?, aliases?}.
 * @param {number|null} [input.limit] - how many results to keep; omitted means all.
 * @returns {object[]} entries with key, score and tokens, best first; empty when nothing shares a term.
 * @throws {RangeError} when the query, the records or the limit are malformed.
 */
export function rankSparse({ query, records, limit = null }) {
  const queryTokens = sparseQueryTokens(query)
  if (limit !== null && (!Number.isInteger(limit) || limit < 1)) {
    throw new RangeError('retrieval limit must be a positive integer or null')
  }
  const normalised = requireRecords(records)
  if (normalised.length === 0 || queryTokens.length === 0) return []
  const scored = cosineScores(queryTokens, normalised)
  const ordered = orderResults(scored, foldMatchText(query))
  const shown = limit === null ? ordered : ordered.slice(0, limit)
  return shown.map((entry) => ({ key: entry.key, score: entry.score, tokens: queryTokens }))
}

/**
 * Fuse several ranked key lists with reciprocal rank fusion (RRF, k=60).
 *
 * Each list contributes 1 / (k + rank) per key, with rank starting at 1, so a
 * candidate that two independent retrievers agree on outranks one that a single
 * retriever put first. Ties are broken deterministically: the higher summed score,
 * then the best rank in any list, then the key — never list order.
 *
 * @param {string[][]} rankings - ranked key lists, best first; a key may repeat across lists but not within one.
 * @param {{k?: number}} [options] - the RRF constant (default {@link RRF_K}).
 * @returns {object[]} entries with key, score and per-list ranks, best first.
 * @throws {RangeError} when a list, a key or the constant is malformed.
 */
export function reciprocalRankFusion(rankings, { k = RRF_K } = {}) {
  if (!Array.isArray(rankings)) throw new RangeError('rankings must be an array of arrays')
  if (!Number.isInteger(k) || k < 1) {
    throw new RangeError('the RRF constant must be a positive integer')
  }
  const fused = new Map()
  for (let listIndex = 0; listIndex < rankings.length; listIndex += 1) {
    const ranking = rankings[listIndex]
    if (!Array.isArray(ranking)) throw new RangeError('each ranking must be an array of keys')
    const seen = new Set()
    for (let position = 0; position < ranking.length; position += 1) {
      const key = ranking[position]
      if (typeof key !== 'string' || key.trim() === '') {
        throw new RangeError('each ranking entry must be a non-blank string key')
      }
      if (seen.has(key)) throw new RangeError('a ranking lists ' + key + ' more than once')
      seen.add(key)
      let entry = fused.get(key)
      if (entry === undefined) {
        entry = { key, score: 0, ranks: new Array(rankings.length).fill(0) }
        fused.set(key, entry)
      }
      entry.score += 1 / (k + position + 1)
      entry.ranks[listIndex] = position + 1
    }
  }
  const bestRank = (entry) => {
    let best = Number.POSITIVE_INFINITY
    for (const rank of entry.ranks) if (rank > 0 && rank < best) best = rank
    return best
  }
  return [...fused.values()].sort((left, right) => {
    const difference = right.score - left.score
    if (Math.abs(difference) > SCORE_TIE_EPSILON) return difference
    const rankDifference = bestRank(left) - bestRank(right)
    if (rankDifference !== 0) return rankDifference
    return left.key < right.key ? -1 : left.key > right.key ? 1 : 0
  })
}
