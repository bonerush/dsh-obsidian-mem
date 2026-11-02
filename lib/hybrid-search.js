// @ts-check
// Fusing a lexical shortlist with a dense one, the deterministic minimum.
//
// The measured premise: the lexical branch is precise when the query shares a
// literal anchor with the note and blind when it does not - 96.9% P@3 on the
// exact class against 15.6% on the cross-lingual one in the frozen baseline. The
// dense branch is the opposite trade. Neither may replace the other, so this
// module fuses two rankings and nothing else: no index read, no I/O, no model.
//
// Three rules carry the design:
//
//   * **A literal anchor is never displaced.** When the top lexical hit matches
//     the query verbatim in its title or a phrase, or shares enough tokens with
//     it (LEXICAL_GUARD_TOKEN_HITS), the lexical order stands. That is what keeps
//     the exact class from regressing: BM25 already solved it, and a cosine
//     similarity is not allowed to overrule a verbatim match.
//   * **Weighted RRF, not score blending.** The two branches produce scores on
//     different scales (BM25 is unbounded, cosine is in [-1, 1]); reciprocal
//     rank fusion only uses position, so no calibration is needed. Dense carries
//     double weight because it is the branch that reaches what BM25 cannot.
//   * **Deterministic ties.** Equal fused scores break by lexical rank (dense-only
//     entries last), then by path. Input order never decides.
import { RRF_K } from './retrieval-rank.js'

/** How many lexical candidates the hybrid branch fuses with the dense shortlist. */
export const HYBRID_LEXICAL_LIMIT = 50
/** Token-hit count at which a lexical hit is treated as a literal anchor. */
export const LEXICAL_GUARD_TOKEN_HITS = 8
/** Reciprocal-rank-fusion weight of the lexical branch. */
export const LEXICAL_RRF_WEIGHT = 1
/** Reciprocal-rank-fusion weight of the dense branch. */
export const DENSE_RRF_WEIGHT = 2

/**
 * Whether the lexical top hit is strong enough to keep the lexical order alone.
 *
 * @param {object[]|null|undefined} lexicalTop - hits shaped like searchNotes output.
 * @returns {boolean} true when the lexical ranking must not be fused.
 */
export function shouldKeepLexical(lexicalTop) {
  const top = Array.isArray(lexicalTop) ? lexicalTop[0] : undefined
  const signals = top?.signals
  if (!signals) return false
  if (signals.titleExact || signals.titleContains || signals.phraseContains) return true
  return Number(signals.tokenHits) >= LEXICAL_GUARD_TOKEN_HITS
}

/**
 * Cosine similarity of the query against every stored vector, best first.
 *
 * Vectors are normalised on read rather than trusted: the store validates shape
 * and finiteness but not length, and a zero vector must score zero rather than
 * divide by zero.
 *
 * @param {ArrayLike<number>} queryVector - the embedded query.
 * @param {Map<string, ArrayLike<number>>} vectors - stored vectors by path.
 * @param {{limit?: number}} [options] - how many to return (default 50).
 * @returns {Array<{path: string, score: number}>} the shortlist, descending.
 */
export function cosineTopK(queryVector, vectors, options = {}) {
  const limit = options.limit ?? 50
  const query = Array.from(queryVector, Number)
  const queryNorm = Math.sqrt(query.reduce((sum, value) => sum + value * value, 0))
  if (!(queryNorm > 0)) return []
  const scored = []
  for (const [path, raw] of vectors) {
    const vector = Array.from(raw, Number)
    if (vector.length !== query.length) continue
    let dot = 0
    let norm = 0
    for (let index = 0; index < vector.length; index += 1) {
      dot += query[index] * vector[index]
      norm += vector[index] * vector[index]
    }
    const magnitude = Math.sqrt(norm)
    const score = magnitude > 0 ? dot / (queryNorm * magnitude) : 0
    scored.push({ path, score })
  }
  scored.sort(
    (left, right) =>
      right.score - left.score || (left.path < right.path ? -1 : left.path > right.path ? 1 : 0),
  )
  return scored.slice(0, limit)
}

/**
 * Fuse a lexical ranking and a dense one with weighted reciprocal rank fusion.
 *
 * @param {{lexicalTop: object[], denseTop: Array<{path: string, score: number}>, k?: number}} input - the two rankings.
 * @returns {Array<{path: string, score: number, source: 'lexical'|'dense', lexicalHit: object|null, lexicalRank: number|null, denseRank: number|null, semanticScore: number|null, hybridRank: number}>} the fused ranking.
 */
export function weightedRrf({ lexicalTop, denseTop, k = RRF_K }) {
  const entries = new Map()
  const ensure = (path) => {
    let entry = entries.get(path)
    if (!entry) {
      entry = {
        path,
        score: 0,
        source: 'dense',
        lexicalHit: null,
        lexicalRank: null,
        denseRank: null,
        semanticScore: null,
        hybridRank: 0,
      }
      entries.set(path, entry)
    }
    return entry
  }
  lexicalTop.forEach((hit, rank) => {
    const entry = ensure(hit.path)
    entry.score += LEXICAL_RRF_WEIGHT / (k + rank + 1)
    entry.source = 'lexical'
    entry.lexicalHit = hit
    entry.lexicalRank = rank
  })
  denseTop.forEach((candidate, rank) => {
    const entry = ensure(candidate.path)
    entry.score += DENSE_RRF_WEIGHT / (k + rank + 1)
    entry.denseRank = rank
    entry.semanticScore = candidate.score
  })
  const fused = [...entries.values()]
  fused.sort(
    (left, right) =>
      right.score - left.score ||
      (left.lexicalRank ?? Infinity) - (right.lexicalRank ?? Infinity) ||
      (left.denseRank ?? Infinity) - (right.denseRank ?? Infinity) ||
      (left.path < right.path ? -1 : left.path > right.path ? 1 : 0),
  )
  fused.forEach((entry, rank) => {
    entry.hybridRank = rank
  })
  return fused
}

/**
 * The hybrid shortlist: guard, fuse, cut.
 *
 * A dense candidate that the lexical branch never returned is a new hit, not a
 * reordering, which is the whole point of adding the branch.
 *
 * @param {{lexicalTop: object[], denseTop: Array<{path: string, score: number}>, limit: number}} input - the two rankings and the cut.
 * @returns {Array<{path: string, score: number, source: 'lexical'|'dense', lexicalHit: object|null, lexicalRank: number|null, denseRank: number|null, semanticScore: number|null, hybridRank: number}>} the hybrid ranking.
 */
export function hybridSearch({ lexicalTop, denseTop, limit }) {
  if (shouldKeepLexical(lexicalTop)) {
    return lexicalTop.slice(0, limit).map((hit, rank) => ({
      path: hit.path,
      score: 0,
      source: 'lexical',
      lexicalHit: hit,
      lexicalRank: rank,
      denseRank: null,
      semanticScore: null,
      hybridRank: rank,
    }))
  }
  return weightedRrf({ lexicalTop, denseTop }).slice(0, limit)
}
