// The shared pure tokenizer for the index and the sparse ranker (v0.4).
//
// One function, two callers that must never disagree: the FTS index stores this
// token stream for every note, and the sparse reranker scores a query against the
// same stream. A copy in the ranker would drift on the first tokenizer fix, and
// the drift would read as a ranking bug rather than a tokenizer decision.
//
// It is a leaf with no repository import so that `index-db` (L2) and
// `retrieval-rank` (L1) can both point down at it; keeping it inside
// `index-db` would give the ranker a lateral edge on the index.

/** Query tokens kept after pre-tokenisation (spec §7 "设长度/数量上限"). */
export const MAX_QUERY_TOKENS = 16
/** Query tokens longer than this are dropped on both sides, so index and query stay symmetric. */
export const MAX_TOKEN_CHARS = 128

// Letters only: CJK punctuation (、。「」) and fullwidth forms are separators, so
// they neither open nor join a bigram run.
const CJK_RANGES = Object.freeze([
  [0x3040, 0x30ff], // hiragana + katakana
  [0x3130, 0x318f], // hangul compatibility jamo
  [0x3400, 0x4dbf], // CJK unified ideographs extension A
  [0x4e00, 0x9fff], // CJK unified ideographs
  [0xa960, 0xa97f], // hangul jamo extended-A
  [0xac00, 0xd7af], // hangul syllables
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0x20000, 0x2fa1f], // CJK extensions B+ (surrogate pairs)
])
const WORD_CHAR = /[\p{L}\p{N}\p{M}]/u

/**
 * Whether a code point belongs to a CJK script.
 *
 * @param {string} char - a single code point.
 * @returns {boolean} true for Han, kana and Hangul letters.
 */
export function isCjkChar(char) {
  const code = char.codePointAt(0)
  return CJK_RANGES.some(([low, high]) => code >= low && code <= high)
}

/**
 * Split text into the token stream the index stores and the query side searches.
 *
 * One pure function serves both sides: runs of latin letters/digits/marks become
 * lowercased words, and each contiguous CJK run becomes its overlapping bigrams.
 * A one-character CJK run yields nothing on purpose — FTS5 cannot express it, so
 * the caller's bounded substring branch handles it instead (spec §7).
 *
 * @param {string} text - document text or a user query.
 * @returns {{tokens: string[], latin: string[], bigrams: string[], loneCjk: string[]}} the token view.
 */
export function tokenizeText(text) {
  const tokens = []
  const latin = []
  const bigrams = []
  const loneCjk = []
  const source = typeof text === 'string' ? text : ''
  let run = ''
  let runIsCjk = false
  const flush = () => {
    if (run === '') return
    if (!runIsCjk) {
      const word = run.toLowerCase()
      if (word.length <= MAX_TOKEN_CHARS) {
        tokens.push(word)
        latin.push(word)
      }
    } else {
      const chars = [...run]
      if (chars.length === 1) {
        loneCjk.push(chars[0])
      } else {
        for (let i = 0; i + 1 < chars.length; i += 1) {
          const bigram = chars[i] + chars[i + 1]
          tokens.push(bigram)
          bigrams.push(bigram)
        }
      }
    }
    run = ''
  }
  for (const char of source) {
    if (isCjkChar(char)) {
      if (!runIsCjk) flush()
      runIsCjk = true
      run += char
    } else if (WORD_CHAR.test(char)) {
      if (runIsCjk) flush()
      runIsCjk = false
      run += char
    } else {
      flush()
    }
  }
  flush()
  return { tokens, latin, bigrams, loneCjk }
}

/**
 * The token stream of a document or a query — the one pure function both sides use.
 *
 * @param {string} text - text to tokenise.
 * @returns {string[]} lowercased latin words and overlapping CJK bigrams.
 */
export function indexText(text) {
  return tokenizeText(text).tokens
}
