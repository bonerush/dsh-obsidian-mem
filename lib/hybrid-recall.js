// @ts-check
// The hybrid recall runtime: warm the embedding store, embed the query, fuse.
//
// ./hybrid-search.js is the pure arithmetic; this module is the I/O and lifecycle
// around it, and it owns the three decisions the pure half cannot make:
//
//   * **Warming never blocks recall.** The first hybrid search starts a background
//     sync and answers from the lexical branch with hybrid-fallback:store-warming.
//     A 98-second CPU embed of the whole vault must not become a 98-second turn.
//   * **A failure is a fallback, not an error.** Provider down, store unreadable,
//     snapshot empty: the caller gets the lexical order plus a reason in
//     hybridFallback. Only cancellation propagates.
//   * **Scope is the candidate set.** Dense vectors exist for the whole vault, but
//     a hit may only come from the rows the same filters would return lexically;
//     anything else would let the dense branch cross a project boundary the
//     lexical branch refuses.
//
// The provider is created here rather than in ./services.js because the contract
// belongs to ./retrieval-provider.js: this module asks it for vectors and maps
// its coded failures onto fallback reasons. Creating it here also keeps the
// service layer's growth to one lazy handle per project.
import { openEmbeddingStore } from './embedding-store.js'
import {
  HYBRID_LEXICAL_LIMIT,
  cosineTopK,
  hybridSearch,
  shouldKeepLexical,
} from './hybrid-search.js'
import { createRetrievalProvider } from './retrieval-provider.js'
import { lexicalTrace } from './recall-trace.js'

export { HYBRID_LEXICAL_LIMIT }
/** The dense shortlist taken from the cosine ranking (spec §4.5). */
export const HYBRID_DENSE_LIMIT = 50
/** The previous-turn context appended to the dense query, in code points. */
export const HYBRID_CONTEXT_CHARS = 400
/** The per-text bound the provider contract enforces. */
const HYBRID_TEXT_CHARS = 1200

/**
 * Attach the hybrid facts to a hit array without making them elements.
 *
 * @param {object[]} hits - the hits.
 * @param {{denseCandidates: number, embedMs: number, hybridFallback: string|null}} facts - what the run did.
 * @returns {object[]} the same array.
 */
function withHybridFacts(hits, facts) {
  Object.defineProperties(hits, {
    retrievalEngine: { value: 'hybrid', enumerable: false },
    denseCandidates: { value: facts.denseCandidates, enumerable: false },
    embedMs: { value: facts.embedMs, enumerable: false },
    hybridFallback: { value: facts.hybridFallback, enumerable: false },
  })
  return hits
}

/** Attach the replay trace without making it an element of the hit array. */
function withHybridTrace(hits, trace) {
  Object.defineProperty(hits, 'hybridTrace', { value: trace, enumerable: false })
  return hits
}

/** The structural trace of a successful fusion, with 1-based ranks. */
function fusionTrace(queryVector, lexicalTop, denseTop, fused, facts) {
  return {
    queryVector: queryVector instanceof Float32Array ? queryVector : Float32Array.from(queryVector),
    guard: false,
    fallback: null,
    denseCandidates: facts.denseCandidates,
    embedMs: facts.embedMs,
    lexicalTop: lexicalTop
      .slice(0, HYBRID_LEXICAL_LIMIT)
      .map((hit, index) => ({ path: hit.path, rank: index + 1 })),
    denseTop: denseTop.map((entry, index) => ({
      path: entry.path,
      rank: index + 1,
      score: entry.score,
    })),
    fusedTop: fused.map((entry) => ({
      path: entry.path,
      source: entry.source,
      lexicalRank: entry.lexicalRank === null ? null : entry.lexicalRank + 1,
      denseRank: entry.denseRank === null ? null : entry.denseRank + 1,
      semanticScore: entry.semanticScore,
      hybridRank: entry.hybridRank + 1,
      lexicalHit: entry.lexicalHit !== null,
    })),
  }
}

/**
 * Copy the lexical branch's search facts onto a fused result.
 *
 * @param {object[]} target - the fused hits.
 * @param {object[]} source - the lexical hits that carried the facts.
 * @returns {void}
 */
function copySearchFacts(target, source) {
  for (const fact of [
    'truncated',
    'truncationReason',
    'candidateWindow',
    'rowsExamined',
    'candidatesScored',
  ]) {
    if (source[fact] !== undefined) {
      Object.defineProperty(target, fact, { value: source[fact], enumerable: false })
    }
  }
}

/** Build the query text the dense branch embeds: prompt, then the previous turn. */
function denseQueryFor(query, context) {
  if (typeof context !== 'string' || context.trim() === '')
    return [...query].slice(0, HYBRID_TEXT_CHARS).join('')
  const tail = [...context.replace(/\s+/gu, ' ').trim()].slice(0, HYBRID_CONTEXT_CHARS).join('')
  const head = [...query].slice(0, HYBRID_TEXT_CHARS)
  return [...head, '\n', ...tail].join('').slice(0, HYBRID_TEXT_CHARS)
}

/** One dense-only hit, shaped like a lexical hit so every projection keeps working. */
function denseHit(row, entry) {
  const body = typeof row.body === 'string' ? row.body : ''
  return {
    path: row.path,
    title: row.title ?? '',
    type: row.type ?? '',
    status: row.status ?? '',
    updated: row.updated ?? null,
    hash: row.hash ?? null,
    source: '',
    snippet: [...body.replace(/\s+/gu, ' ').trim()].slice(0, 160).join(''),
    score: entry.semanticScore ?? 0,
    backend: null,
    signals: {
      matchedBy: 'dense',
      tokenHits: 0,
      titleExact: false,
      titleContains: false,
      phraseContains: false,
      substringMatch: false,
      history: false,
      frontmatterBroken: false,
      repaired: false,
      verifiedSource: true,
      semanticScore: entry.semanticScore,
      hybridRank: entry.hybridRank,
    },
  }
}

/** Add the fused-rank signals to a lexical hit without mutating the index's object. */
function withHybridSignals(hit, entry) {
  return {
    ...hit,
    signals: {
      ...hit.signals,
      semanticScore: entry.semanticScore,
      hybridRank: entry.hybridRank,
    },
  }
}

/**
 * Build the hybrid runtime for one project service.
 *
 * @param {object} [options] - the runtime inputs; omitted only so the type accepts the
 *   default, a real call always passes `config`, `dataRoot`, `vaultRoot` and `index`.
 * @param {object} [options.config] - the validated plugin config.
 * @param {string} [options.dataRoot] - the plugin data root.
 * @param {string} [options.vaultRoot] - the resolved vault root.
 * @param {object} [options.index] - the object `openIndex` returned.
 * @param {object|null} [options.provider] - injected provider seam (tests); default builds the loopback contract.
 * @param {object|null} [options.store] - injected embedding store (tests); default opens the real one.
 * @param {(error: Error) => void} [options.onWarmError] - reports a failed warm without failing a turn.
 * @returns {{rank: Function, warm: Function, status: Function}} the runtime.
 */
export function createHybridRecall(options = {}) {
  const {
    config,
    dataRoot,
    vaultRoot,
    index,
    provider = null,
    store = null,
    onWarmError = null,
  } = options
  const providerBlock = config?.retrievalProvider ?? {}
  const model = typeof providerBlock.model === 'string' ? providerBlock.model : ''
  const dimensions = Number.isInteger(providerBlock.dimensions) ? providerBlock.dimensions : 0
  const client = provider ?? createRetrievalProvider(providerBlock)
  // `openEmbeddingStore` is async (it hashes the vault root to pick the file), so
  // the handle is a promise until first use. `Promise.resolve` keeps a test's
  // injected synchronous store on the same path.
  const storePromise = Promise.resolve(
    store ?? openEmbeddingStore({ dataRoot, vaultRoot, model, dimensions }),
  )
  let warming = null
  let warmError = null

  /** Embed one passage batch for the store sync. The store passes its request
   * object through, the same shape the provider contract takes. */
  const embedPassages = async (request) => client.embed({ ...request, kind: 'passage' })

  /**
   * Sync the store against the index in the background. Concurrent callers share
   * one warm; a failure is recorded and the next call retries.
   */
  function warm() {
    if (warming !== null) return warming
    const pending = (async () => {
      const vectorsStore = await storePromise
      const rows = await index.candidateNotes({ kind: 'all', excludeStatuses: [], type: null })
      await vectorsStore.sync(rows, embedPassages)
      warmError = null
    })()
    pending.catch((error) => {
      warmError = error
      try {
        onWarmError?.(error)
      } catch {
        // Reporting a failed warm must not become a second failure.
      }
    })
    // Callers await a promise that never rejects: warming is background work, and
    // the failure is reported through `status().warmError` and `onWarmError`. A
    // rejected promise here is what made the first real harness run die on a
    // provider error instead of measuring the lexical fallback.
    warming = pending.catch(() => {})
    warming.finally(() => {
      warming = null
    })
    return warming
  }

  /** The lexical order with a stated hybrid reason and its structural trace. */
  function fallback(lexicalTop, limit, { reason = null, guard = false, denseCandidates = 0, embedMs = 0 } = {}) {
    const hits = lexicalTop.slice(0, limit)
    return withHybridTrace(
      withHybridFacts(hits, { denseCandidates, embedMs, hybridFallback: reason }),
      lexicalTrace(lexicalTop, { guard, fallback: reason, denseCandidates, embedMs }),
    )
  }

  /**
   * Rank one query: lexical shortlist, dense shortlist, weighted RRF.
   *
   * @param {{query: string, filters: object, lexicalTop: object[], limit: number, context?: string|null, signal?: AbortSignal}} input - the query and its lexical shortlist.
   * @returns {Promise<object[]>} fused hits with the hybrid facts attached.
   */
  async function rank({ query, filters, lexicalTop, limit, context = null, signal }) {
    if (shouldKeepLexical(lexicalTop)) {
      return fallback(lexicalTop, limit, { guard: true, reason: null })
    }
    let snapshot
    try {
      snapshot = await (await storePromise).snapshot()
    } catch {
      return fallback(lexicalTop, limit, { reason: 'store-unreadable' })
    }
    if (snapshot.size === 0) {
      // The first hybrid turn: start warming and answer lexically now.
      warm()
      return fallback(lexicalTop, limit, { reason: 'store-warming' })
    }
    const started = Date.now()
    let queryVector
    try {
      const response = await client.embed({
        texts: [denseQueryFor(query, context)],
        kind: 'query',
        signal,
      })
      queryVector = response.vectors[0]
    } catch (error) {
      if (error?.code === 'provider-aborted') throw error
      return fallback(lexicalTop, limit, {
        reason: error?.code === 'provider-disabled' ? 'provider-disabled' : 'provider-error',
      })
    }
    const rows = await index.candidateNotes(filters)
    const byPath = new Map(rows.map((row) => [row.path, row]))
    const allowed = new Map()
    for (const [path, vector] of snapshot.vectors) {
      if (byPath.has(path)) allowed.set(path, vector)
    }
    const denseTop = cosineTopK(queryVector, allowed, { limit: HYBRID_DENSE_LIMIT })
    const fused = hybridSearch({ lexicalTop, denseTop, limit })
    const hits = fused
      .map((entry) => {
        if (entry.lexicalHit !== null) return withHybridSignals(entry.lexicalHit, entry)
        const row = byPath.get(entry.path)
        return row === undefined ? null : denseHit(row, entry)
      })
      .filter((hit) => hit !== null)
    copySearchFacts(hits, lexicalTop)
    const embedMs = Math.max(0, Date.now() - started)
    const trace = fusionTrace(queryVector, lexicalTop, denseTop, fused, {
      denseCandidates: denseTop.length,
      embedMs,
    })
    return withHybridTrace(
      withHybridFacts(hits, {
        denseCandidates: denseTop.length,
        embedMs,
        hybridFallback: null,
      }),
      trace,
    )
  }

  return {
    rank,
    warm,
    status() {
      return {
        warming: warming !== null,
        warmError: warmError === null ? null : (warmError.code ?? warmError.message ?? 'error'),
      }
    },
  }
}
