// @ts-check
// The language rules one memory note is measured against (Task 17).
//
// Two very different callers must agree on the same list: `distill.js` (L2) tells
// the model how to write a note and reports where its own note missed, and
// `lint.js` (L5) reports the same misses across a vault written months earlier by
// an older prompt. A copy in each would drift the moment either was tuned, and
// the drift would read as a linter bug rather than a decision. It is a LEAF — no
// repository import, no `node:` import — which is what lets both point down at it.
//
// The rules are calibrated against the 739 fact notes already in the author's
// vault (Conventions 243, Pitfalls 285, Decisions 211), measured with
// `scratch/vault-style-probe.mjs`; the rates are in
// `research/memory-note-language-standard.md`. Each constant repeats the number it
// was chosen from, because a threshold without its measurement is a preference.
//
// **ASD-STE100 was the starting point, and its two most famous rules are both
// refused by this corpus:**
//
//   * Tense restrictions. STE forbids the perfect and future forms so technical
//     text is timeless. 39% of these notes use them and are RIGHT to: `Decisions/`
//     holds ADRs, whose purpose is to record what was decided at a point in time.
//     A rule whose hit rate is explained by the genre is not a rule.
//   * "One concept per sentence" read as a ban on mixed script. 37% of notes
//     interleave Chinese prose with Latin identifiers, but `FTS5`, `node:sqlite`
//     and `[[path|label]]` cannot be translated. What STE offers here is a
//     sentence-length budget, which is kept, not a script-purity rule.
//
// What is kept is the short list where a hit is a defect rather than a genre. The
// tiers matter more than the rules: `warn` is advisory, `downgrade` parks a
// candidate in `Inbox/` instead of the directory the model claimed. Nothing here
// refuses a write — the distillation contract already records why: "a wording
// accident never costs the turn". A model that writes one vague sentence must
// still get its other five facts saved.
//
// A "sentence" here runs between terminal punctuation in either script and is
// measured in CJK characters when it holds any, else in Latin words. Inline code,
// wikilinks and quote markers are masked first: an unmasked
// `[[Projects/x/Docs/y|label]]` contributes one 40-character "word" and would
// flag a compliant note. The cost is that a code span is never measured — the
// honest trade, since a code span is not prose.

/**
 * Sentence-length ceiling, in CJK characters, before a finding is reported.
 *
 * 60, not the 40 a literal translation of STE's 25-word descriptive limit would
 * give, and not the 50 this constant first held. Both alternatives were rejected
 * against the corpus: 40 flags 27% of existing sentences and 50 flags 16%, while
 * 60 flags 4% — and the notes in the 50–60 band are legitimate, because a Chinese
 * technical sentence carries its bounded condition inside it ("A 改为 B，因为不
 * 这样做会…"). The nearest published Chinese authority, ruanyf's document style
 * guide, puts its hard cut at ">40 characters is never acceptable" with
 * 30–39 "must be semantically clear" — a scale, not a single number, which is
 * what this constant and {@link MAX_SENTENCE_WORDS} reproduce on their own side.
 */
export const MAX_SENTENCE_CJK = 60
/** Sentence-length ceiling, in Latin words, for a sentence with no CJK text. */
export const MAX_SENTENCE_WORDS = 25
/**
 * Sentence-count ceiling for one note.
 *
 * Chosen from ASD-STE100 Rule 6.6 ("no more than six sentences in a
 * paragraph", descriptive writing) and tightened by one because a memory note is
 * read alone rather than as part of a section. Measured: 13% of existing notes
 * exceed five sentences, 8% of Conventions and 17% of Decisions.
 */
export const MAX_SENTENCES = 5
/**
 * Minimum sentence length before a note is treated as having no measurable prose.
 *
 * A note whose body is one short line — a tag list, a single path — is not
 * "too short to check"; it is checked and passes. This bound only stops the
 * sentence splitter from treating a fragment as a sentence.
 */
const MIN_SENTENCE_CHARS = 4

/** A finding's strength. `warn` is reported only; `downgrade` reroutes the note. */
export const STYLE_SEVERITIES = Object.freeze(['warn', 'downgrade'])

/**
 * Open-ended qualifiers: words that mark doubt without bounding it.
 *
 * Deliberately NOT here, because each one is information: `约 15s` is a
 * measurement with a stated tolerance, worth more than a precise number nobody
 * measured; `must`/`never`/`禁止`/`不得` are normative rather than hedged.
 *
 * `应该` IS here while `应` is not, and that distinction is the point of the list:
 * GB/T 1.1 defines 应/宜/可 as normative verbs of fixed strength, so `应` in a
 * quoted clause states an obligation while `应该` in a note is the author guessing
 * at one. `建议`/`最好`/`尽量` are included for the same reason — a preference whose
 * ground was never written down cannot be obeyed or contradicted later.
 */
const HEDGE_PATTERNS = Object.freeze([
  // Chinese open-ended qualifiers.
  /可能|也许|大概|似乎|或许|应该|等等|一些|若干|相关|适当|尽量|建议|最好|基本上|大致/gu,
  // English equivalents. `should` is listed beside 应该 on purpose: the US
  // federal plain-language guidelines define it as a *recommendation*, which is
  // precisely the lost information this rule is about.
  /\b(?:should|may|might|probably|possibly|perhaps|seems?|appears?|likely|roughly|approximately|several|various|etc)\b/giu,
])

/**
 * Deictic references that point outside the note.
 *
 * A note is read alone, out of order, possibly years later, so `该` and `上述`
 * have no referent at read time. Measured: 189 of 739 notes (26%) contain one.
 *
 * Two deliberate exclusions. `其` is the most common Chinese deictic and is NOT
 * here, because `其他`/`其余`/`其中`/`尤其` account for most of its occurrences and
 * flagging those would flag a third of the corpus for ordinary vocabulary. And
 * the `(?<!应)` lookbehind is load-bearing rather than decorative: `应该` is a
 * hedge, and a lookahead alone cannot exclude it because the characters are
 * ordered 应-then-该 and a lookahead reads forward. The first version of this
 * pattern reported `应该重建索引` as BOTH a hedge and a deictic — one word, two
 * defects. The lookahead beside it keeps `该当`/`该有` out for the same reason.
 */
const DEICTIC_PATTERN = /(?<!应)该(?![当有])|上述|前述|前者|后者|此(?=[\u4e00-\u9fff])/gu

/** Inline code, wikilinks and blockquote markers are masked before measuring. */
function maskInline(markup) {
  return markup
    .replace(/`[^`]*`/gu, ' ')
    .replace(/\[\[[^\]]*\]\]/gu, ' ')
    .replace(/^>.*$/gmu, ' ')
}

/**
 * Split text into sentences across both scripts.
 *
 * @param {string} text - note body or title.
 * @returns {string[]} non-empty sentences, markup masked.
 */
export function splitSentences(text) {
  const masked = maskInline(text)
  return masked
    .split(/(?<=[。！？；])|(?<=[.!?])\s+|(?<=[;])\s+/u)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= MIN_SENTENCE_CHARS)
}

/**
 * A word, for the length of a sentence with no CJK text in it.
 *
 * Two measured corrections are baked in, from one class of bug — an identifier
 * the counter could not see. **No trailing `\b`**: `\b[A-Za-z][A-Za-z-]{2,}\b`
 * never matches `FTS5` or `UTF8`, because `\b` needs a word/non-word transition
 * and a digit IS a word character, so a sentence of such tokens measured as zero
 * words and passed any ceiling. **Digits allowed inside the word**: dropping the
 * boundary is not enough, since requiring a trailing run of letters alone counted
 * `FTS5` as one word but `ES6` as none. Verified after both: a 26-word sentence
 * measures 26, `FTS5 UTF8 ES6` measures 3, and `dsh-obsidian-mem` still counts
 * once, because splitting on a hyphen would be worse than one compound.
 */
const LATIN_WORD = /\b[A-Za-z][A-Za-z0-9-]{2,}/gu

/**
 * The length of one sentence in its own script's unit.
 *
 * @param {string} sentence - one entry from {@link splitSentences}.
 * @returns {number} CJK characters when the sentence has any, else Latin words.
 */
export function sentenceLength(sentence) {
  const cjk = (sentence.match(/[\u4e00-\u9fff]/gu) ?? []).length
  if (cjk > 0) return cjk
  return (sentence.match(LATIN_WORD) ?? []).length
}

/**
 * The CJK share of a text's letters, used to compare body and title language.
 *
 * @param {string} text - any text.
 * @returns {number} 0..1; 0 when the text holds no letters at all.
 */
export function cjkShare(text) {
  const cjk = cjkCount(text)
  const latin = (text.match(/[A-Za-z]/gu) ?? []).length
  const total = cjk + latin
  return total === 0 ? 0 : cjk / total
}

/** Letters (CJK or Latin) in one text. Zero means the text has no language. */
function letterCount(text) {
  return cjkCount(text) + (text.match(/[A-Za-z]/gu) ?? []).length
}

/** CJK characters in one text. */
function cjkCount(text) {
  return (text.match(/[\u4e00-\u9fff]/gu) ?? []).length
}

/**
 * Whether two texts are written in the same script family.
 *
 * The thresholds are far apart on purpose — "Chinese" above 0.5, "English" below
 * 0.15, anything between is mixed and accepted either way — because a note titled
 * `FTS5 中文索引` is legitimately bilingual and a rule that guessed would fire on
 * the titles this vault actually writes.
 *
 * A text with NO LETTERS is unclassifiable, and unclassifiable agrees with
 * everything: a `123` title (the vault's own `_meta` files have them) or a
 * `2026-10-08` body holds no evidence to disagree with. That guard is measured
 * rather than courteous — without it a letterless title fell through to the
 * English branch and reported a mismatch against a Chinese body.
 *
 * @param {string} title - the note title.
 * @param {string} body - the note body.
 * @returns {boolean} true when they agree, or when either is unclassifiable.
 */
export function languagesAgree(title, body) {
  // Tested on the LETTER COUNT, not on `cjkShare`: a share of 0 is ambiguous
  // (an all-Latin text and a letterless one both have zero CJK), and reading that
  // 0 as unclassifiable would silently disable the rule for every English note.
  if (letterCount(title) === 0 || letterCount(body) === 0) return true
  const titleShare = cjkShare(title)
  const bodyShare = cjkShare(body)
  if (titleShare >= 0.5) return bodyShare >= 0.15
  if (titleShare <= 0.15) return bodyShare <= 0.5
  return true
}

/**
 * Every style finding for one candidate note.
 *
 * The caller decides what to do with the result: `distill.js` downgrades on any
 * `downgrade`, `lint.js` reports every entry. Nothing here throws, trims or
 * rewrites — a finding names a location, never a replacement, because this
 * module never sees the evidence that would justify new wording.
 *
 * @param {{title?: unknown, body?: unknown}} note - the candidate's title and body.
 * @returns {Array<{rule: string, severity: 'warn'|'downgrade', message: string}>} findings, possibly empty.
 */
export function styleFindings(note) {
  const title = typeof note?.title === 'string' ? note.title : ''
  const body = typeof note?.body === 'string' ? note.body : ''
  if (body.trim() === '') return []

  /** @type {Array<{rule: string, severity: 'warn'|'downgrade', message: string}>} */
  const findings = []
  const sentences = splitSentences(body)

  // One fact per note. The body is written for a reader who has this note and
  // nothing else, so a sixth sentence is a second fact that should carry its own
  // evidence, its own expiry and its own supersede target.
  if (sentences.length > MAX_SENTENCES) {
    findings.push({
      rule: 'sentences',
      severity: 'warn',
      message: `${sentences.length} sentences, beyond ${MAX_SENTENCES}`,
    })
  }

  // One idea per sentence. This is the part of STE that transfers: it is a
  // budget on the sentence, not a restriction on the vocabulary or the tense.
  const overLong = sentences.filter(
    (sentence) =>
      sentenceLength(sentence) >
      (/[\u4e00-\u9fff]/u.test(sentence) ? MAX_SENTENCE_CJK : MAX_SENTENCE_WORDS),
  )
  for (const sentence of overLong) {
    findings.push({
      rule: 'sentence-length',
      severity: 'warn',
      message: `${sentenceLength(sentence)} units in one sentence; split it (${first(sentence, 40)})`,
    })
  }

  const hedges = matches(body, HEDGE_PATTERNS[0], HEDGE_PATTERNS[1])
  if (hedges.length > 0) {
    findings.push({
      rule: 'hedge',
      severity: 'warn',
      message: `open-ended qualifier ${list(hedges)}; state the bound or drop it`,
    })
  }

  const deictics = uniqueMatches(body.match(DEICTIC_PATTERN) ?? [])
  if (deictics.length > 0) {
    findings.push({
      rule: 'deictic',
      severity: 'warn',
      // No rule about `其` here by design; see DEICTIC_PATTERN.
      message: `a reference outside the note (${list(deictics)}); name the object`,
    })
  }

  // Language drift is the ONE style finding strong enough to reroute a note.
  //
  // Every rule above is `warn`, and that asymmetry came from measuring the first
  // implementation against the corpus: with hedges, deictics and long sentences
  // also downgrading, 326 of 739 existing notes (44%) would have gone to `Inbox/`
  // instead of the directory each was distilled for. Moving a fact out of
  // `Conventions/` destroys the routing it was written for, so "would read better"
  // must never move a note. A body in its title's other language is different in
  // kind: recall matches the words a note is written in, so such a note is not
  // found by the title a reader recalls it by — a retrieval defect, which is what
  // `Inbox/` is for.
  if (title.trim() !== '' && !languagesAgree(title, body)) {
    findings.push({
      rule: 'language',
      severity: 'downgrade',
      message: 'body script differs from the title script',
    })
  }

  return findings
}

/**
 * The findings that should keep a candidate out of its claimed destination.
 *
 * `warn` findings are excluded on purpose: they are worth reporting and not
 * worth rerouting a fact for. A caller that treated them alike would send every
 * bilingual note to `Inbox/`, which is how a style rule turns into a memory
 * outage.
 *
 * @param {Array<{severity: string}>} findings - the output of {@link styleFindings}.
 * @returns {boolean} true when at least one finding is a downgrade.
 */
export function shouldDowngrade(findings) {
  return findings.some((finding) => finding.severity === 'downgrade')
}

/** The distinct hedge terms in one text, matched case-insensitively. */
function matches(text, ...patterns) {
  const found = []
  for (const pattern of patterns) {
    // Each pattern is a `g` regex reused across calls; `matchAll` clones it
    // internally only in newer engines, so the lastIndex is reset explicitly.
    pattern.lastIndex = 0
    for (const match of text.matchAll(pattern)) found.push(match[0].toLowerCase())
  }
  return uniqueMatches(found)
}

/** Distinct values, sorted so a message is stable across runs. */
function uniqueMatches(values) {
  return [...new Set(values)].sort()
}

/** A bounded excerpt, so a finding stays one line in a report. */
function first(text, limit) {
  const trimmed = text.trim().replace(/\s+/gu, ' ')
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit)}…`
}

/** Join terms for a message, bounded so one note cannot flood a report. */
function list(values) {
  const shown = values.slice(0, 4)
  const suffix = values.length > shown.length ? ` +${values.length - shown.length}` : ''
  return `${shown.join(', ')}${suffix}`
}
