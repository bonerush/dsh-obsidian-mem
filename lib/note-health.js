// @ts-check
// The note-health rules the linter and the curation scanner both apply (curation plan Task 2).
//
// Two callers, one rule. `lintVault` answers "what is wrong with this whole
// vault?" and `lib/curation-scan.js` answers "what does this project still need
// reviewed?", and each of them inspects single notes for the same two things: an
// overdue `review_after` and a wikilink that resolves to nothing. If each kept
// its own copy of those rules the two answers would drift, and a note the linter
// calls stale while the scanner calls current is a bug nobody can reproduce —
// which is why this module exists rather than a second implementation beside it.
//
// Everything here is pure and vault-free: the rules take parsed frontmatter, a
// body and a caller-supplied link resolver, and nothing in this file reads a byte
// or knows where the vault is. That is what lets the curation scanner apply the
// linter's rules to a manifest it has already walked instead of launching a
// whole-vault lint on every pass.

/**
 * The statuses whose notes are history rather than current memory.
 *
 * An expired `review_after` on a superseded note is not a thing to review, so
 * those notes are excluded from the expiry finding exactly as they are excluded
 * from a default search. `lib/index-db.js` re-exports this list as
 * `SUPERSEDED_STATUSES`, because that is the name its own callers already use.
 */
export const HISTORY_STATUSES = Object.freeze(['superseded', 'archived'])

/** A wikilink: `[[target]]`, `[[target|alias]]`, `[[target#heading]]`, `![[embed]]`. */
const WIKILINK_PATTERN = /!?\[\[([^\]|#\n]+)(?:#[^\]|\n]*)?(?:\|[^\]\n]*)?\]\]/g

/**
 * A frontmatter value as identity: a non-blank string, or `null`.
 *
 * @param {unknown} value - the candidate.
 * @returns {string|null} the trimmed string, or `null`.
 */
function identityText(value) {
  if (typeof value !== 'string') return null
  return value.trim() === '' ? null : value
}

/**
 * Today's local date as `YYYY-MM-DD` (never `toISOString()`, which is UTC).
 *
 * @param {Date} now - the clock.
 * @returns {string} the local date.
 */
export function localDate(now) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/**
 * A note body with its code removed: fenced blocks and code spans.
 *
 * Obsidian resolves no wikilink inside code and its metadata cache records none
 * either, so a note that *discusses* link syntax (`- [[target|alias]]` in prose
 * about MOCs) or quotes a script (`[[ "$x" == y ]]` in a workflow) is not linking
 * to anything. The mask is textual rather than offset-preserving because only the
 * targets are used here.
 *
 * One trade-off is deliberate: a code span crossing a line break is not paired.
 * Pairing across lines would let a single stray backtick mask every link after
 * it, and a false warning is cheaper than a link nobody sees.
 *
 * @param {string} text - the note body.
 * @returns {string} the body with fenced blocks and code spans blanked.
 */
export function proseWithoutCode(text) {
  const kept = []
  let fence = null
  for (const line of text.split('\n')) {
    const opening = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (fence !== null) {
      // A closing fence is the same character and at least as long; an unclosed
      // one runs to the end of the note, which is also how CommonMark reads it.
      if (opening !== null && opening[1][0] === fence[0] && opening[1].length >= fence.length) {
        fence = null
      }
      kept.push('')
      continue
    }
    if (opening !== null) {
      fence = opening[1]
      kept.push('')
      continue
    }
    kept.push(line.replace(/(`+)(?:[^`]|(?!\1)`)*?\1/gu, ' '))
  }
  return kept.join('\n')
}

/**
 * An overdue `review_after`, or `null` when the note is not due.
 *
 * A date equal to `today` is not yet due, and a note already marked superseded or
 * archived is never due: it is history, and asking a human to review history is
 * how a review queue stops being read.
 *
 * @param {Record<string, any>|null|undefined} data - the note's frontmatter.
 * @param {string} today - the local date (`YYYY-MM-DD`), as `lintVault` computes it.
 * @returns {{kind: string, severity: string, reviewAfter: string}|null} the finding, without a path.
 */
export function noteReviewFinding(data, today) {
  const date = typeof data?.review_after === 'string' ? data.review_after : null
  if (date === null || date >= today || HISTORY_STATUSES.includes(data?.status)) return null
  return { kind: 'expired-review', severity: 'info', reviewAfter: date }
}

/**
 * Every wikilink target in a note, and every one of them that resolves to nothing.
 *
 * The two lists travel together because they are one pass over one masked body:
 * the linter needs every target (its repository audit asks which files a vault
 * note references) and the dead ones (its report), and masking the body twice to
 * answer both questions would double the cost of every note for no gain.
 *
 * A missing resolver is "cannot judge", never "every link is dead": a caller that
 * cannot enumerate the vault's paths gets no dead-link findings at all, so an
 * incomplete resolver can only under-report, never invent.
 *
 * @param {string} body - the note body.
 * @param {string} path - the note's vault-relative path, passed to the resolver as the linking note.
 * @param {((target: string, path: string) => boolean)|null} resolves - the link resolver, or `null`.
 * @returns {{targets: string[], findings: Array<{kind: string, target: string}>}} targets, in document order, and the dead ones.
 */
export function noteLinkAudit(body, path, resolves) {
  const targets = []
  const findings = []
  if (typeof resolves !== 'function') return { targets, findings }
  const seen = new Set()
  for (const match of proseWithoutCode(body ?? '').matchAll(WIKILINK_PATTERN)) {
    const target = match[1].trim()
    if (target === '') continue
    targets.push(target)
    if (resolves(target, path) || seen.has(target)) continue
    // One finding per distinct target: a note that repeats a link four times is
    // one broken link, exactly as the lint report has always counted it.
    seen.add(target)
    findings.push({ kind: 'dead-wikilink', target })
  }
  return { targets, findings }
}

/**
 * Every wikilink in a note that resolves to nothing.
 *
 * @param {string} body - the note body.
 * @param {string} path - the note's vault-relative path.
 * @param {((target: string, path: string) => boolean)|null} resolves - the link resolver, or `null`.
 * @returns {Array<{kind: string, target: string}>} one finding per distinct dead target.
 */
export function noteLinkFindings(body, path, resolves) {
  return noteLinkAudit(body, path, resolves).findings
}

/**
 * The owned fields that say where a note's claim came from.
 *
 * `session` and `supersedes` are part of the tuple on purpose: two notes with the
 * same words distilled from different turns, or one of which replaces an earlier
 * conclusion, are not the same claim even when their text matches.
 *
 * @param {Record<string, any>|null|undefined} data - the note's frontmatter.
 * @returns {{source: string|null, session: string|null, harness: string|null, supersedes: string|null}} the tuple.
 */
export function noteProvenance(data) {
  return {
    source: identityText(data?.source),
    session: identityText(data?.session),
    harness: identityText(data?.harness),
    supersedes: identityText(data?.supersedes),
  }
}

/**
 * A plugin note that cannot say where it came from, or `null` when it can.
 *
 * Only a note that claims `trust: agent` is judged: a hand-written note never
 * promised provenance, and reporting every human file would turn a curation
 * finding into noise. `project` is checked against the project whose directory
 * the note lives in, because a note that names no project (or another one) inside
 * this project's tree is exactly the cross-project leak the design forbids.
 *
 * @param {Record<string, any>|null|undefined} data - the note's frontmatter.
 * @param {string|null} [projectId] - the owning project's id, or `null` to skip that check.
 * @returns {{kind: string, severity: string, missing: string[]}|null} the finding, without a path.
 */
export function noteProvenanceFinding(data, projectId = null) {
  if (data?.trust !== 'agent') return null
  const provenance = noteProvenance(data)
  const missing = []
  if (provenance.source === null) missing.push('source')
  if (provenance.harness === null) missing.push('harness')
  if (projectId !== null && data.project !== projectId) missing.push('project')
  if (missing.length === 0) return null
  return { kind: 'missing-provenance', severity: 'warn', missing }
}

/**
 * Whether a wikilink target resolves inside one known set of vault paths.
 *
 * A target may be vault-relative (`Projects/x--y/Docs/Notes`) or relative to the
 * linking note's own directory (Obsidian resolves the shortest form), with or
 * without the `.md` extension, and matching is case-insensitive exactly as
 * Obsidian's resolver is. An external URL is not this vault's business.
 *
 * `filePaths` is every *file* of the swept vault, notes and attachments alike:
 * `lintVault` fills it from `swept.entries`, not from its note records, so a link
 * to an extension-less file that really exists is resolved here.
 *
 * This is the rule `lintVault` has always applied — to *every* swept vault file,
 * because the linter builds `filePaths` from `swept.entries.filter(kind === 'file')`
 * and not from its `.md` note records. The scanner's own resolver
 * (`createManifestLinkResolver` in `lib/curation-scan.js`) applies this same rule to
 * a *narrower* set — every file of the bound project's tree plus the vault root's
 * own file entries — and then adds a last-segment fallback this directory-bound rule
 * refuses. Both differences under-report, and the relation the two have was probed
 * rather than assumed: **for a target the scan can decide, its dead-link findings are
 * a subset of the linter's; for a target it cannot decide — any slash-bearing target
 * that does not name a path under the scan's project, and everything when its
 * enumeration failed or was truncated — the scan reports nothing and this resolver
 * may still report it.** So a curation merge can miss a finding, and it is never
 * shown a link the linter called alive.
 *
 * The under-report has three probed shapes, and `test/curation-scan.test.js` asserts
 * each as a row of its scan-vs-linter matrix rather than leaving the relation to
 * prose: a slash-bearing target outside the scan's project is answered `true`
 * whatever its basename (`[[Other/a]]`, whose basename *is* carried by an enumerated
 * file, is such a row); a target this rule has no candidate for while the
 * last-segment fallback finds the name — a bare `[[README]]` whose only carrier sits
 * in the project root, out of reach of this note's directory, or the
 * project-prefixed `<project>/Other/a`, where both of this rule's candidates miss
 * and the scan answers through the `a` of `<project>/Docs/a/a`; and a bare target
 * whose last segment carries a dot (`[[nomatch.png]]`), which the scan answers
 * `true` before consulting its name set at all — so the answer does not depend on
 * what that set holds — while this rule looks for the file itself and reports it
 * dead.
 *
 * @param {string} target - the wikilink target, trimmed.
 * @param {string} notePath - the linking note's vault-relative path.
 * @param {Set<string>} filePaths - the known vault-relative paths.
 * @param {Set<string>} foldedFiles - the same paths, case-folded.
 * @returns {boolean} whether the target resolves.
 */
function resolvesVaultLink(target, notePath, filePaths, foldedFiles) {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target) || target.startsWith('mailto:')) return true
  const cleaned = target.replace(/\.md$/i, '').replace(/^\.\//, '')
  if (cleaned === '') return true
  const directory = notePath.includes('/') ? `${notePath.slice(0, notePath.lastIndexOf('/'))}/` : ''
  const candidates = [cleaned, `${directory}${cleaned}`]
  for (const candidate of candidates) {
    if (filePaths.has(candidate) || filePaths.has(`${candidate}.md`)) return true
    const folded = candidate.toLowerCase()
    if (foldedFiles.has(folded) || foldedFiles.has(`${folded}.md`)) return true
  }
  return false
}

/**
 * Build the `(target, path) => boolean` resolver `noteLinkAudit` wants.
 *
 * @param {Iterable<string>} filePaths - every known vault-relative path.
 * @returns {(target: string, notePath: string) => boolean} the resolver.
 */
export function createVaultLinkResolver(filePaths) {
  const paths = filePaths instanceof Set ? filePaths : new Set(filePaths)
  const folded = new Set([...paths].map((path) => path.toLowerCase()))
  return (target, notePath) => resolvesVaultLink(target, notePath, paths, folded)
}
