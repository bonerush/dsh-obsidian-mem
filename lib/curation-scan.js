// Bounded, deterministic curation inspection of one bound project (curation plan Task 2).
//
// `scanCuration` answers one question: *which of this project's notes are current,
// which are duplicated or stale, and how far has this pass got?* It reads the
// vault — the source of truth — and writes only private state under the caller's
// data root. It never mutates a note, never takes the vault lock while it reads,
// and never holds one across a scan.
//
// Three rules shape everything below:
//
//   * **`complete` is a coverage claim, never a progress report.** It is true
//     only when this pass ended with nothing left truncated (`truncated === null`)
//     *and* what the pass set out to cover is proven: for a full pass, every path
//     in the current project manifest has a readable record belonging to this
//     backfill; for a changed-path pass, every requested path was inspected and
//     the stored backfill already covers the manifest. A pass that hit `maxNotes`
//     or `maxMs` — in either traversal — reports `complete: false` and keeps its
//     `truncatedReason`, even when the backfill behind it is finished: a pass that
//     stopped early certified nothing, and a consumer that merges on `complete` is
//     exactly the consumer this rule exists for. A pass always walks the manifest,
//     because a directory walk is cheap metadata and note *bytes* are what the
//     bounds exist for; a manifest whose fingerprint changed while a backfill was
//     in progress restarts the walk in the same pass, and never reports completion
//     for coverage it cannot prove. Per-path records survive the restart, so a
//     restart costs the walk, not the work already done. A directory the walk
//     could not read is the same kind of hole and takes the same answer: this pass
//     did not enumerate that subtree, so it claims no coverage of it, keeps its
//     cursor where it was and says so in a finding. Hitting the resolver's *file*
//     bound is deliberately not one of those holes: it stops the link universe and
//     leaves the manifest whole, so it costs findings and never coverage — the walk
//     that used to stop dead at that bound wrote a cursor over a short manifest and
//     called it complete, which is why the two lists now stop separately. Neither
//     rule covers the wall-clock deadline, which is first consulted after the walk
//     returns — a known limitation, named in the changes rather than implied away.
//   * **A partial result is never shaped like a complete one.** `entries` span
//     every batch only when the pass finished its scope; a bounded pass returns
//     just the batch it inspected, and `complete: false` plus `truncatedReason`
//     say so. A consumer that needs the whole project must check `complete`
//     first — a view built from a partial set is a view that silently dropped
//     facts.
//   * **A note this pass cannot trust is `unexamined`, never absent and never
//     safe to merge.** An oversized, unreadable or unparsable note produces a
//     finding and no navigation entry, so it is visible in curation status and
//     can never be grouped, collapsed or reported as current.
//
// A changed-path pass (what a write asks for) inspects exactly the requested
// paths and leaves the cursor alone. Its `truncatedReason` describes *this pass*
// and its `complete` has two halves: every requested path was inspected, and the
// stored backfill already covers the manifest. A pass that ran out of notes or
// time before reaching the end of its own list is therefore `complete: false`
// even though the backfill behind it is finished — the paths it never inspected
// are exactly the ones a caller would merge on the strength of that flag. It
// groups the entries it inspected; regrouping a new note against unchanged ones is
// the view layer's job (rebuild after a complete pass) and is re-derived on the
// next full pass.
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { compileIgnoreGlobs, matchesIgnoreGlob } from './config.js'
import {
  CurationStateError,
  SCAN_RECORD_SCHEMA,
  curationRecordDir,
  readCurationCursor,
  readScanRecord,
  requireCurationBinding,
  requireCurationDataRoot,
  requireProjectNotePath,
  requireProjectPathShape,
  writeCurationCursor,
  writeScanRecord,
} from './curation-state.js'
import { parseNote } from './frontmatter.js'
// `sha256Hex` comes from `index-db` rather than `registry`: it is the byte-safe
// one, and it is what `readNote` hashes a note's bytes with — the source hash a
// scan reports has to be the value a view verifies against later.
import { MAX_NOTE_BYTES, isIndexableRelativePath, sha256Hex } from './index-db.js'
import { SAFETY_EXCLUSIONS } from './lint.js'
import {
  HISTORY_STATUSES,
  createVaultLinkResolver,
  localDate,
  noteLinkFindings,
  noteProvenance,
  noteProvenanceFinding,
  noteReviewFinding,
} from './note-health.js'
import { resolveVaultFile, resolveVaultRoot } from './paths.js'
import { fsyncDirectory } from './receipts.js'
import { withVaultLock } from './transaction.js'

/** One hook pass examines at most this many notes (design §"Triggers and progress"). */
export const DEFAULT_MAX_NOTES = 256
/** One hook pass stops starting new file operations once this much time has elapsed. */
export const DEFAULT_MAX_MS = 500

/**
 * How many manifest paths one pass will consider.
 *
 * A project with more Markdown files than this is not a memory vault any more,
 * and a walk with no bound turns a session hook into an unbounded scan. A walk
 * that hits it reports `manifest-budget` and inspects nothing, because a manifest
 * that is not the whole project cannot support any coverage claim.
 */
export const MAX_MANIFEST_FILES = 50_000
/** The deepest project directory a manifest walk descends into (mirrors the indexer). */
export const MAX_MANIFEST_DEPTH = 8
/**
 * How many files the resolver's universe may hold.
 *
 * The manifest's own budget bounds how many notes a backfill must cover; nothing
 * about it bounds the link universe, because that list is entry for entry larger
 * (attachments, canvases, extension-less files) and the vault-root `readdir` adds
 * to it. A count bound of its own is what keeps a link check from being the one
 * unbounded structure in a bounded pass. A walk that hits it does not hand over a
 * short list: a resolver judging links against half a tree would call every link
 * into the other half dead, so the caller turns this into `files: null`,
 * "undecidable", and the pass says so rather than guessing. It stops the *file*
 * list alone — the manifest walk keeps going, because a short manifest is a
 * coverage hole (`complete` over notes nobody read) and a short link universe is
 * only a missing finding.
 */
export const MAX_RESOLVER_FILES = 50_000
/** The longest one-line extract an entry carries into a view. */
export const MAX_DESCRIPTION_CHARS = 160
/**
 * How many characters of one note-supplied string an entry carries.
 *
 * An entry is persisted beside the note's findings, and a record the store refuses
 * is a note nobody can trust — so every string this module copies out of a note's
 * frontmatter is bounded here instead of being trusted to be small. A title past
 * this length is still an entry and still readable; what has to stay bounded is
 * the record, and frontmatter is data, not a promise about length. The bound is
 * hundreds of characters rather than tens so a truncated title stays recognisable
 * in a view; the identity hash is computed from the *raw* text, where truncation
 * would have been a correctness bug (two notes collapsed into one).
 */
export const MAX_ENTRY_TEXT_CHARS = 256
/**
 * How many findings one path's record keeps.
 *
 * The cap is what keeps a record smaller than the bound its own reader enforces:
 * a note with thousands of dead links must produce a bounded record, not one the
 * next pass refuses and therefore re-inspects forever.
 */
export const MAX_NOTE_FINDINGS = 128
/**
 * How many bytes of findings one record keeps.
 *
 * The count cap alone is not a size bound: a path long enough makes 128 findings
 * exceed the record's own reader limit, and a record nobody can read is a note
 * re-inspected on every pass forever. The two caps together are the real bound.
 */
export const MAX_NOTE_FINDING_BYTES = 48 * 1024

/** Every finding kind this module can report, so a consumer can close its schema. */
export const CURATION_FINDING_KINDS = Object.freeze([
  'expired-review',
  'dead-wikilink',
  'missing-provenance',
  'near-duplicate',
  'unexamined',
  'findings-truncated',
  'record-unreadable',
  'cursor-invalid',
  'manifest-truncated',
  // A directory the walk could not read is a hole in what the pass can name: it
  // gets a finding of its own so a pass that covered less than the project says so
  // in its findings, not only in a `complete: false` a caller may not read.
  'enumeration-failed',
  // The resolver's file list hit its count bound, so links were not judged at all.
  'resolver-truncated',
])

/**
 * The manifest fingerprint: sha256 over the sorted path list, one newline per path.
 *
 * A newline terminator per path is what makes the encoding unambiguous — without
 * it `['a', 'bc']` and `['ab', 'c']` would fingerprint the same.
 *
 * @param {string[]} paths - the sorted vault-relative manifest paths.
 * @returns {string} the hex fingerprint.
 */
function fingerprintOfPaths(paths) {
  return sha256Hex(paths.map((path) => `${path}\n`).join(''))
}

/**
 * A JSON string whose object keys are sorted, for identity hashes.
 *
 * A key that changes when a property is reordered is a key that changes for a
 * reason nobody can see, and this key decides which notes are called duplicates.
 * Values are the string/null primitives an entry is built from.
 *
 * @param {*} value - the value to canonicalize.
 * @returns {string} the canonical JSON.
 */
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
}

/** The folded title two notes must share to be near duplicates. */
function foldTitle(title) {
  return typeof title === 'string' ? title.trim().replace(/\s+/gu, ' ').toLowerCase() : ''
}

/**
 * One note-supplied string as an entry carries it: bounded, or `null`.
 *
 * @param {unknown} value - the frontmatter value.
 * @returns {string|null} the bounded string, or `null` when it was not a string.
 */
function boundedEntryText(value) {
  return typeof value === 'string' ? value.slice(0, MAX_ENTRY_TEXT_CHARS) : null
}

/**
 * The one-line extract of a note body an entry carries as navigation.
 *
 * The first non-blank line, with its Markdown block prefix removed and its
 * whitespace collapsed. The prefix removal is not decoration: an extract that
 * still began with `##` would read as a heading the moment a view inlines it,
 * and a note's text is data, never a heading of the brief that quotes it.
 *
 * @param {unknown} body - the note body.
 * @returns {string} the bounded extract (possibly empty).
 */
function describeBody(body) {
  for (const line of String(body ?? '').split('\n')) {
    const text = line
      .replace(/^\s*(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)?/u, '')
      .replace(/\s+/gu, ' ')
      .trim()
    if (text !== '') return text.slice(0, MAX_DESCRIPTION_CHARS)
  }
  return ''
}

/**
 * The identity hash of an entry: project, type, title, body and provenance.
 *
 * Two notes are exact duplicates only when every one of those matches byte for
 * byte; title overlap alone is evidence for a review candidate, never authority
 * to collapse a note.
 *
 * @param {{project: string|null, type: string|null, title: string|null, body: string, provenance: object}} input - the identity fields.
 * @returns {string} the hex key.
 */
function exactKeyOf(input) {
  return sha256Hex(canonicalJson(input))
}

/**
 * Inspect one already-read note and return its navigation entry and findings.
 *
 * Pure over the parsed note: the caller owns the file read, the source hash and
 * the filesystem jail, because a scan has already resolved the path once and
 * re-walking it per note would double the pass's path cost for no new answer.
 * The path is still checked against the project prefix and the indexable rule,
 * so a note from another project's tree is refused here as well.
 *
 * @param {object} input - the note and its seams.
 * @param {object} input.binding - a `kind:'bound'` binding.
 * @param {string} input.path - the note's vault-relative path.
 * @param {{hasFrontmatter: boolean, data: object|null, body: string}} input.note - the parsed note (`parseNote`).
 * @param {string} input.hash - the sha256 of the exact bytes `note` was parsed from.
 * @param {Date} [input.now] - the clock, for the review-date rule.
 * @param {((target: string, path: string) => boolean)|null} [input.resolves] - the link resolver; absent means no dead-link finding.
 * @returns {{entry: object, findings: object[]}} the entry and the per-note findings.
 * @throws {RangeError} when the binding, the path, the note or the hash is unusable.
 */
export function inspectCurationNote(input) {
  const { binding, path, note, hash, now = new Date(), resolves = null } = input
  const project = requireCurationBinding(binding)
  requireProjectPathShape(project, path)
  if (note === null || typeof note !== 'object' || Array.isArray(note)) {
    throw new RangeError('inspectCurationNote needs the object parseNote() returned')
  }
  if (typeof hash !== 'string' || hash === '') {
    throw new RangeError('inspectCurationNote needs the sha256 of the bytes it was handed')
  }
  const data = note.data ?? {}
  const body = typeof note.body === 'string' ? note.body : ''
  const findings = []

  const due = noteReviewFinding(data, localDate(now))
  if (due !== null) {
    findings.push({ ...due, path, message: `${path} was due for review on ${due.reviewAfter}` })
  }
  const provenance = noteProvenanceFinding(data, project.projectId)
  if (provenance !== null) {
    findings.push({
      ...provenance,
      path,
      message: `${path} declares trust:agent but has no ${provenance.missing.join(', ')} provenance`,
    })
  }
  for (const link of noteLinkFindings(body, path, resolves)) {
    findings.push({
      ...link,
      severity: 'warn',
      path,
      message: `${path} links to [[${link.target}]], which does not exist in this vault`,
    })
  }

  const type = boundedEntryText(data.type)
  const title = boundedEntryText(data.title)
  const entry = {
    path,
    hash,
    id: boundedEntryText(data.id),
    type,
    title,
    status: boundedEntryText(data.status),
    project: boundedEntryText(data.project),
    reviewAfter: boundedEntryText(data.review_after),
    supersedes: boundedEntryText(data.supersedes),
    supersededBy: boundedEntryText(data.superseded_by),
    description: describeBody(body),
    exactKey: exactKeyOf({
      // The identity hash reads the *raw* fields, never the bounded entry: two
      // titles that differ only past `MAX_ENTRY_TEXT_CHARS` are two different
      // notes, and collapsing them would be a data-loss bug hidden by a size bound.
      project: typeof data.project === 'string' ? data.project : null,
      type: typeof data.type === 'string' ? data.type : null,
      title: typeof data.title === 'string' ? data.title : null,
      body,
      provenance: noteProvenance(data),
    }),
  }
  return { entry, findings }
}

/**
 * The link resolver a scan builds from the universe it just enumerated.
 *
 * There is exactly one linter-style resolver — `createVaultLinkResolver`, applied
 * by `lib/lint.js` to the whole swept vault — and this is that resolver applied to
 * a narrower set plus two rules of its own. What the direction actually is was
 * probed rather than reasoned about, so it is written here as the probe's literal
 * result; `test/curation-scan.test.js` carries the same matrix as assertions, and
 * a comment in this file that is not in that matrix is a claim with nothing behind
 * it. The rules the code below implements:
 *
 *   * **The universe is smaller than the linter's.** `files` is every file of the
 *     bound project's tree plus the vault root's own file entries; the linter's
 *     `filePaths` is every file of the swept vault. Both hold plain files and not
 *     only notes, so an extension-less file or a non-Markdown attachment inside the
 *     project resolves here exactly as it does there — the probe matrix carries both
 *     as silent/silent rows (`<project>/Docs/txt.txt`, `<project>/Docs/图.png`).
 *   * **A slash-bearing target that does not start with this project's directory
 *     is answered `true` whatever its basename.** That is the `bare.includes('/')`
 *     branch below, and it is the widest of the silences. Six probe rows have the
 *     scan silent and `lintVault` reporting a dead link — `[[Docs/nomatch]]` with
 *     nothing named `nomatch` anywhere, `[[Methods/并不存在]]`, `[[Docs/txt.txt]]`,
 *     `[[Docs/LICENSE]]`, `[[other/LICENSE]]` and `[[Other/a]]`, whose basename `a`
 *     is carried by an enumerated file (`<project>/Docs/a/a`) — and the match
 *     changes nothing, because this branch answers before any name is looked at. One
 *     row where both surfaces are silent is `[[Docs/分享]]`, which the linter
 *     resolves through the vault-root `Docs/` and the scan never decides at all. The
 *     pass enumerated one project plus the vault root, so a target outside that is
 *     one it cannot decide, and "cannot see" must never arrive as "dead".
 *   * **A basename — a bare one, or the last segment of a target that does start
 *     with this project's directory — resolves when any enumerated file carries that
 *     name.** `[[Some Note]]` written from another directory is the bare case, which
 *     Obsidian resolves and the linter's directory-bound rule deliberately does not.
 *     The two surfaces diverge whenever the linter's two candidates (the target
 *     itself, and the linking note's own directory plus it) both miss, and the matrix
 *     has one row of each shape: the bare `[[README]]`, whose only carrier is
 *     `<project>/README` one directory above the linking note, and the
 *     project-prefixed `[[<project>/Other/a]]`, where the last-segment rule reads the
 *     `a` of `<project>/Docs/a/a`. In both the scan is silent and `lintVault` reports a
 *     dead link. The `[[LICENSE]]` row is the bare case that does *not* diverge: both
 *     surfaces are silent, and the file that carries both answers is the
 *     extension-less `<project>/Docs/LICENSE` **beside the linking note** — the
 *     linter's own directory-append candidate. Which copy carried it is probed rather
 *     than reasoned about, and the probe's result is the opposite of a vault-root
 *     credit: given `<project>/LICENSE`, the project-root copy, the linter's rule
 *     answers `false`; given `<project>/Docs/LICENSE` alone it answers `true`; and the
 *     fixture holds no vault-root `LICENSE` at all, so the `['LICENSE']`-alone probe is
 *     asserted only as what a vault-root copy *would* answer. Neither answer rests on
 *     the project-root copy. A missing finding is the one-directional under-report
 *     this resolver allows.
 *   * **A bare target whose last segment contains a dot is answered `true`
 *     unconditionally.** That is the `name.includes('.')` branch below, and it is the
 *     third silence shape: `names` holds only dot-free stems (a `.md` is stripped), so
 *     an extension-bearing name is never looked up there and this branch returns
 *     before the set is consulted. `[[nomatch.png]]` names nothing anywhere and
 *     `lintVault` reports it dead, while the scan is silent; the matrix carries that
 *     row, and the comment on the branch below is the reason it is left that way.
 *
 * The relation that holds over the probe matrix, and the only one this comment
 * claims: **for a target it can decide, the scan's findings are a subset of the
 * linter's; for a target it cannot decide — any slash-bearing target that does not
 * name a path under this project, and everything when the enumeration failed or was
 * truncated — the scan reports nothing and the linter may still report it.** No
 * row of the matrix has the scan reporting a link the linter resolved. The matrix's
 * silent-scan/dead-lint total is nine rows in the three shapes above: six
 * slash-bearing, two last-segment and one bare dot-bearing.
 *
 * The enumeration is the resolver's whole authority, so an enumeration that failed
 * (a `readdir` that threw) or one that hit `MAX_RESOLVER_FILES` is not a short
 * universe: `files === null` makes every target resolve, because a half-walked file
 * list has exactly the shape above — the names it never reached are the ones a link
 * would be called dead into. A false dead-link claim about the user's vault is worse
 * than a missing one, and the linter still reports the truth on demand.
 *
 * @param {{paths: string[], files: string[]|null}} universe - the walk's manifest (unread here, and read by the caller) and every enumerated file, vault-relative, or `null` when the enumeration failed or was truncated.
 * @param {string} relativeDir - the bound project's vault-relative directory.
 * @returns {(target: string, notePath: string) => boolean} the resolver.
 */
function createManifestLinkResolver(universe, relativeDir) {
  const { files } = universe
  if (files === null) return () => true
  const resolveVaultLink = createVaultLinkResolver(files)
  const prefix = `${relativeDir}/`
  const names = new Set()
  for (const path of files) {
    const name = path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/iu, '')
    names.add(name.toLowerCase())
  }
  return (target, notePath) => {
    if (resolveVaultLink(target, notePath)) return true
    const bare = target.replace(/\.md$/iu, '').replace(/^\.\//, '')
    if (bare.includes('/') && !bare.startsWith(prefix)) return true
    const name = bare.slice(bare.lastIndexOf('/') + 1)
    // A dot here is a file extension — `.png`, `.canvas`, `.txt` — and `names`
    // holds only dot-free stems (a `.md` is stripped). Such a name is left out of
    // `names` on purpose: including it could only resolve a target the linter's
    // path-append candidates also miss, and this resolver's one job is to never
    // report a dead link the linter resolved.
    if (name.includes('.')) return true
    return name !== '' && names.has(name.toLowerCase())
  }
}

/**
 * Enumerate one tree: every file below it, and the indexable notes among them.
 *
 * One walk feeds both answers, because they have to agree: the note manifest is
 * the `.md` subset of the same enumeration the resolver's universe comes from, so
 * a path can never be in one and invisible to the other. The two keep separate
 * budgets because they are separate claims: `MAX_MANIFEST_FILES` bounds how many
 * notes a backfill must cover, and `MAX_RESOLVER_FILES` bounds how many names a
 * link may be checked against. Either bound having been hit is reported to the
 * caller, because a truncated walk is not a shorter tree — the part it never
 * reached is unknown, not empty.
 *
 * Hitting the *file* bound stops the file list and nothing else. The walk keeps
 * going so `paths` stays whole: those are the notes the pass is claiming coverage
 * of, and a bound that cut them short would make `complete: true` mean "covered
 * the notes I happened to reach" — a fail-open the resolver's `null` cannot undo,
 * because `null` only drops link findings. Only the manifest's own budget stops
 * the walk, and that one is visible as `truncated`.
 *
 * A directory this walk cannot read is a hole and is reported as one: `denied` is
 * true, and the caller turns it into a state finding plus `complete: false`. The
 * walk keeps going, so the notes it *can* see are still inspected, but a pass that
 * never enumerated a subtree must not certify coverage of it — silence about a
 * locked directory, presented as a complete pass over a shorter manifest, is the
 * failure this reporting exists to prevent.
 *
 * @param {string} root - the absolute directory to walk.
 * @param {string} relativeDir - `root`'s vault-relative directory.
 * @param {{matchers: RegExp[], maxFiles: number, maxManifestFiles: number}} input - the compiled exclusions, the resolver's file bound and the manifest's path budget.
 * @returns {Promise<{paths: string[], files: string[]|null, truncated: boolean, denied: boolean, filesFull: boolean}>} the manifest, every file (`null` when a directory could not be read or the file bound was hit), whether the manifest hit its budget, whether a directory refused to be read, and whether the resolver's file bound was hit.
 */
async function enumerateProjectTree(root, relativeDir, { matchers, maxFiles, maxManifestFiles }) {
  const paths = []
  const files = []
  let denied = false
  let manifestFull = false
  let filesFull = false
  const queue = [{ relative: relativeDir, depth: 0 }]
  while (queue.length > 0) {
    const { relative, depth } = queue.shift()
    const absolute = join(root, ...relative.split('/'))
    let children
    try {
      children = await fs.readdir(absolute, { withFileTypes: true })
    } catch (error) {
      // A directory that is gone between two passes is a race and not a hole, but
      // any other refusal — a permission, an I/O error — leaves files this walk
      // cannot name, which is exactly what makes the file list unusable.
      if (error.code !== 'ENOENT') denied = true
      continue
    }
    children.sort((left, right) => (left.name < right.name ? -1 : 1))
    for (const child of children) {
      // A dot entry is the plugin's own material (`.history/`, `.obsidian/`) or a
      // hidden file; neither is project memory.
      if (child.name.startsWith('.')) continue
      const childRelative = `${relative}/${child.name}`
      if (matchesIgnoreGlob(childRelative, matchers)) continue
      if (child.isSymbolicLink()) continue
      if (child.isDirectory()) {
        if (depth + 1 >= MAX_MANIFEST_DEPTH) continue
        queue.push({ relative: childRelative, depth: depth + 1 })
        continue
      }
      if (!child.isFile()) continue
      // The resolver's bound stops *its* list and nothing else. Breaking the walk
      // here truncated `paths` too, and the pass then wrote a cursor over the short
      // manifest while `truncated` and `denied` both stayed false — `complete: true`
      // over notes nobody had looked at, the one failure this module exists to
      // prevent. The two lists are separate claims, so they stop separately: past
      // this point the walk still enumerates every note, and only `files` is short.
      if (!filesFull && files.length >= maxFiles) filesFull = true
      if (!filesFull) files.push(childRelative)
      if (!isIndexableRelativePath(childRelative)) continue
      if (paths.length >= maxManifestFiles) {
        manifestFull = true
        break
      }
      paths.push(childRelative)
    }
    if (manifestFull) break
  }
  paths.sort()
  files.sort()
  return {
    paths,
    files: denied || filesFull ? null : files,
    truncated: manifestFull,
    denied,
    filesFull,
  }
}

/**
 * The vault root's own file entries, or `null` when the root cannot be read.
 *
 * One non-recursive `readdir`: the resolver needs the root's names, not a second
 * whole-vault walk, and a root that cannot be listed is reported to the caller so
 * it can decline to judge links rather than call them dead. `denied` says the
 * listing failed for a reason other than "there is no vault root": that is a hole
 * in what this pass can name, so it is reported at the pass level too and not
 * merely turned into a silent resolver. Directories are excluded on purpose: the
 * linter's `filePaths` holds files only, so a name this universe carried that the
 * linter would not resolve is a link the scan calls alive and a lint calls dead —
 * a difference in the wrong direction, which is the one direction this resolver is
 * not allowed to have.
 *
 * @param {string} vaultRoot - the resolved vault root.
 * @param {{matchers: RegExp[]}} input - the compiled exclusions.
 * @returns {Promise<{names: string[]|null, denied: boolean}>} the root's vault-relative file names, and whether the root refused to be listed.
 */
async function enumerateVaultRootFiles(vaultRoot, { matchers }) {
  let children
  try {
    children = await fs.readdir(vaultRoot, { withFileTypes: true })
  } catch (error) {
    // A vault root that is not there contributes no names and is not a hole; any
    // other refusal leaves names this pass cannot see.
    return { names: null, denied: error.code !== 'ENOENT' }
  }
  const names = []
  for (const child of children) {
    if (child.name.startsWith('.')) continue
    if (matchesIgnoreGlob(child.name, matchers)) continue
    if (child.isSymbolicLink()) continue
    if (!child.isFile()) continue
    names.push(child.name)
  }
  names.sort()
  return { names, denied: false }
}

/**
 * Walk the vault root and one project's tree into the two sets a scan needs.
 *
 * The safety exclusions are the linter's fixed list, applied to the full
 * vault-relative path, plus whatever the user's `ignoreGlobs` add: a scan and a
 * lint must agree about which paths are internal, and a file the user excluded
 * from retrieval must not reappear as a curation entry. Symlinks are never
 * followed and dot directories are never entered, for the same reason the
 * walker in `lib/lint.js` refuses them.
 *
 * `paths` is the note manifest — `.md` only, because that is what a scan inspects.
 * It is whole even when the resolver's list is not: the file bound stops `files`
 * and only `files` (see `enumerateProjectTree`). `files` is the resolver's
 * universe: every file of the project's tree plus the vault root's entries,
 * because a link is a claim about the vault's files and not about the notes alone.
 * It is `null` when either half cannot be enumerated, when either was truncated by
 * its own count bound, or when the project walk was denied a directory — and the
 * resolver reads `null` as "undecidable" instead of as an empty vault. `denied` is
 * reported separately from `files` because it is also a *coverage* fact: the
 * manifest the caller is holding may be missing a subtree.
 *
 * @param {string} vaultRoot - the resolved vault root.
 * @param {string} relativeDir - the project's vault-relative directory.
 * @param {{matchers: RegExp[], home: string, maxFiles: number, maxManifestFiles: number}} input - the compiled exclusions, the home seam, the resolver's file bound and the manifest's path budget.
 * @returns {Promise<{paths: string[], files: string[]|null, truncated: boolean, denied: boolean, filesFull: boolean}>} the manifest, the resolver's universe, whether the manifest hit its budget, whether a directory refused to be read, and whether the resolver's file bound was hit.
 * @throws {import('./paths.js').PathSafetyError} when the project directory walks through a symlink.
 */
async function walkManifest(
  vaultRoot,
  relativeDir,
  { matchers, home, maxFiles, maxManifestFiles },
) {
  // The project directory itself passes the jail once, so a project reached
  // through a symlink is refused before any note below it is read.
  await resolveVaultFile(vaultRoot, relativeDir, { home })
  const tree = await enumerateProjectTree(vaultRoot, relativeDir, {
    matchers,
    maxFiles,
    maxManifestFiles,
  })
  const rootFiles = await enumerateVaultRootFiles(vaultRoot, { matchers })
  const combined =
    tree.files === null || rootFiles.names === null
      ? null
      : [...tree.files, ...rootFiles.names].sort()
  return {
    paths: tree.paths,
    files: combined,
    truncated: tree.truncated,
    denied: tree.denied || rootFiles.denied,
    filesFull: tree.filesFull,
  }
}

/**
 * One note read, and every fact a later pass needs from it.
 *
 * @param {object} input - the absolute path, the project and the seams.
 * @returns {Promise<{status: string, hash: string|null, size: number|null, reason: string|null, entry: object|null, findings: object[]}>} the record payload.
 */
async function inspectPath({ absolute, path, binding, now, resolves }) {
  const unexamined = (reason, message, extra = {}) => ({
    status: 'unexamined',
    hash: extra.hash ?? null,
    size: extra.size ?? null,
    reason,
    entry: null,
    findings: [
      {
        kind: 'unexamined',
        severity: reason === 'oversize' || reason === 'missing' ? 'info' : 'warn',
        path,
        reason,
        message,
      },
    ],
  })
  let stats
  try {
    stats = await fs.lstat(absolute)
  } catch (error) {
    if (error.code === 'ENOENT') return unexamined('missing', `${path} is no longer in the vault`)
    return unexamined('unreadable', `cannot read ${path}: ${error.code ?? error.message}`)
  }
  // Checked on the lstat that precedes the read, so a path swapped for a symlink
  // after the walk is reported unreadable instead of followed out of the vault.
  if (!stats.isFile() || stats.isSymbolicLink()) {
    return unexamined('unreadable', `${path} is not a regular file`)
  }
  if (stats.size > MAX_NOTE_BYTES) {
    return unexamined('oversize', `${path} is larger than the ${MAX_NOTE_BYTES}-byte note bound`, {
      size: stats.size,
    })
  }
  let bytes
  try {
    bytes = await fs.readFile(absolute)
  } catch (error) {
    return unexamined('unreadable', `cannot read ${path}: ${error.code ?? error.message}`, {
      size: stats.size,
    })
  }
  const hash = sha256Hex(bytes)
  let note
  try {
    note = parseNote(bytes)
  } catch (error) {
    return unexamined('frontmatter', `cannot parse ${path}: ${error.code ?? error.message}`, {
      hash,
      size: stats.size,
    })
  }
  const inspected = inspectCurationNote({ binding, path, note, hash, now, resolves })
  return {
    status: 'ok',
    hash,
    size: stats.size,
    reason: null,
    entry: inspected.entry,
    findings: inspected.findings,
  }
}

/**
 * Group entries by exact identity and by title, returning both kinds of finding.
 *
 * History is excluded from grouping but stays in `entries`: an exact group that
 * collapsed a superseded conclusion into a current one would present history as
 * current memory, while dropping the entry entirely would leave a view unable to
 * learn that a note it once showed has become history.
 *
 * @param {object[]} entries - the entries in this result.
 * @returns {{exactGroups: object[], findings: object[]}} the groups and the near-duplicate findings.
 */
function groupEntries(entries) {
  const groupable = entries.filter(
    (entry) =>
      !HISTORY_STATUSES.includes(entry.status) && entry.type !== null && entry.title !== null,
  )
  const byExact = new Map()
  const byTitle = new Map()
  for (const entry of groupable) {
    if (!byExact.has(entry.exactKey)) byExact.set(entry.exactKey, [])
    byExact.get(entry.exactKey).push(entry)
    const titleKey = `${entry.project ?? ''}\u0000${entry.type}\u0000${foldTitle(entry.title)}`
    if (!byTitle.has(titleKey)) byTitle.set(titleKey, [])
    byTitle.get(titleKey).push(entry)
  }

  const exactGroups = []
  for (const [key, members] of byExact) {
    if (members.length < 2) continue
    const paths = members.map((entry) => entry.path).sort()
    exactGroups.push({
      key,
      paths,
      count: paths.length,
      type: members[0].type,
      title: members[0].title,
      id: members[0].id,
    })
  }
  exactGroups.sort((left, right) => (left.paths[0] < right.paths[0] ? -1 : 1))

  const findings = []
  for (const members of byTitle.values()) {
    // One witness per distinct fact: the exact group collapses to its first path,
    // so the finding names the two claims that differ rather than every file.
    const witnesses = new Map()
    for (const entry of members) {
      if (!witnesses.has(entry.exactKey)) witnesses.set(entry.exactKey, entry.path)
    }
    if (witnesses.size < 2) continue
    const paths = [...witnesses.values()].sort()
    findings.push({
      kind: 'near-duplicate',
      severity: 'warn',
      path: paths[0],
      paths,
      title: members[0].title,
      message: `${paths.length} notes share the title "${members[0].title}" without being exact duplicates: ${paths.join(', ')}`,
    })
  }
  findings.sort((left, right) => (left.path < right.path ? -1 : 1))
  return { exactGroups, findings }
}

/**
 * Pick the cursor that has covered more of one manifest.
 *
 * Two passes can reach the write at the same time (two adapters, one project).
 * Both propose a cursor over the same manifest, and the honest merge is the one
 * that got further along it: a pass that inspected fewer notes must not overwrite
 * the progress of one that inspected more. A cursor over a different manifest is
 * not comparable and the live pass's own wins, because its fingerprint is the one
 * the notes on disk actually have.
 *
 * @param {object|null} current - the cursor on disk.
 * @param {object} next - the cursor this pass built.
 * @param {string[]} paths - the sorted manifest.
 * @returns {object} the cursor to persist.
 */
function furtherCursor(current, next, paths) {
  if (current === null || current.manifestFingerprint !== next.manifestFingerprint) return next
  const position = (after) => (after === null ? -1 : paths.indexOf(after))
  return position(current.afterPath) > position(next.afterPath) ? current : next
}

/**
 * Inspect one bound project, bounded by a note count and a wall-clock deadline.
 *
 * @param {object} binding - a `kind:'bound'` binding.
 * @param {object} [options] - the pass inputs.
 * @param {string} options.dataRoot - the plugin data root (required; the private state lives under it).
 * @param {number} [options.maxNotes] - how many notes this pass may inspect.
 * @param {number} [options.maxMs] - how long this pass may keep starting new inspections.
 * @param {string[]|null} [options.changedPaths] - inspect exactly these paths and leave the cursor alone; empty or absent means advance the backfill.
 * @param {string[]} [options.ignoreGlobs] - the user's validated exclusions (they can only add to the fixed safety list).
 * @param {string} [options.home] - home seam for `~/` expansion.
 * @param {Date} [options.now] - clock injection point for the review rule and `scannedAt`.
 * @param {() => number} [options.clock] - monotonic-ish millisecond source for the time bound (test seam).
 * @param {number} [options.maxFiles] - how many files the link universe may hold (the test seam for `MAX_RESOLVER_FILES`; production callers use the shipped 50 000). Hitting it makes every link undecidable and never shortens the manifest.
 * @param {number} [options.maxManifestFiles] - how many notes the manifest may hold (the test seam for `MAX_MANIFEST_FILES`; production callers use the shipped 50 000). Hitting it stops the walk, so it is a coverage truncation.
 * @returns {Promise<object>} the pass result (see the module comment for what `complete` and `entries` mean; `manifest.denied` marks a manifest a directory refused to be enumerated into, which forces `complete: false`).
 * @throws {RangeError} when the binding, an option or a changed path is invalid.
 * @throws {import('./paths.js').PathSafetyError} when a changed path escapes the vault or walks through a symlink.
 * @throws {CurationStateError} when private state cannot be read or written.
 */
export async function scanCuration(binding, options = {}) {
  const {
    dataRoot,
    maxNotes = DEFAULT_MAX_NOTES,
    maxMs = DEFAULT_MAX_MS,
    maxFiles = MAX_RESOLVER_FILES,
    maxManifestFiles = MAX_MANIFEST_FILES,
    changedPaths = null,
    ignoreGlobs = [],
    home,
    now = new Date(),
    clock = Date.now,
  } = options
  const project = requireCurationBinding(binding)
  requireCurationDataRoot(dataRoot)
  if (!Number.isSafeInteger(maxNotes) || maxNotes <= 0) {
    throw new RangeError('maxNotes must be a positive integer')
  }
  if (!Number.isSafeInteger(maxMs) || maxMs < 0) {
    throw new RangeError('maxMs must be a non-negative integer')
  }
  if (!Number.isSafeInteger(maxFiles) || maxFiles <= 0) {
    throw new RangeError('maxFiles must be a positive integer')
  }
  if (!Number.isSafeInteger(maxManifestFiles) || maxManifestFiles <= 0) {
    throw new RangeError('maxManifestFiles must be a positive integer')
  }
  const started = clock()
  const matchers = compileIgnoreGlobs([...SAFETY_EXCLUSIONS, ...ignoreGlobs])
  const vaultRoot = (await resolveVaultRoot(project.vaultRoot, { home })).root

  const requested =
    changedPaths === null || changedPaths === undefined ? [] : [...new Set(changedPaths)]
  // Every path a caller names is jailed and shape-checked before any work, so a
  // refusal happens before a single note is read.
  for (const path of requested) await requireProjectNotePath(project, path, { home })
  requested.sort()
  const fullPass = requested.length === 0

  const manifest = await walkManifest(vaultRoot, project.relativeDir, {
    matchers,
    home,
    maxFiles,
    maxManifestFiles,
  })
  const fingerprint = fingerprintOfPaths(manifest.paths)
  // The resolver's universe is the walk's file set, not the manifest: a link is a
  // claim about the vault's files, and the manifest is only the notes a pass reads.
  const resolves = createManifestLinkResolver(manifest, project.relativeDir)

  const stateFindings = []
  let cursor = null
  try {
    cursor = await readCurationCursor(dataRoot, project.projectId)
  } catch (error) {
    if (!(error instanceof CurationStateError)) throw error
    // A cursor we cannot trust is reported and rebuilt in this same pass: the
    // alternative is a project whose curation is dead until a human deletes a file
    // they have never heard of.
    stateFindings.push({
      kind: 'cursor-invalid',
      severity: 'warn',
      path: null,
      message: `the stored curation cursor could not be trusted (${error.code}): ${error.message}; the backfill restarts from the first path`,
    })
  }

  let truncated = manifest.truncated ? 'manifest-budget' : null
  if (manifest.truncated) {
    stateFindings.push({
      kind: 'manifest-truncated',
      severity: 'warn',
      path: null,
      message: `the manifest walk stopped at its ${maxManifestFiles}-path budget, so no coverage was claimed for this pass`,
    })
  }
  if (manifest.filesFull) {
    // A named finding, but not `complete: false`: `complete` is this pass's claim
    // that it covered the notes in its manifest, and the file bound no longer
    // touches that list — it stops the link universe, so this pass judges no link
    // dead and records that absence. The absence is not a deferral: a covered path
    // is re-checked by its record's presence rather than re-read, so a dead-link
    // finding a later pass with a whole universe would have made stays absent until
    // the linking note's own bytes change and a changed-path pass asks the resolver
    // again. That is the price of never inventing a dead link, and the covering test
    // asserts both halves: the unchanged note stays absent across a later
    // whole-universe pass, and editing the linking note's bytes brings the finding
    // back on the next changed-path pass. The wrong version of this comment said a
    // "truncated link universe does not un-cover one note" while the walk it
    // described *did* truncate the manifest; the walk is fixed, and this states what
    // it does.
    stateFindings.push({
      kind: 'resolver-truncated',
      severity: 'warn',
      path: null,
      message: `the link universe hit its ${maxFiles}-file bound, so no link was judged dead in this pass`,
    })
  }
  // A directory the walk could not read is a hole in the manifest it just built:
  // the paths inside it are missing rather than absent, so this pass inspected a
  // smaller project than the one on disk. Both halves matter — `complete: false`
  // for a caller that reads the flag, and a finding for the report and for a caller
  // that reads only findings — and neither may be replaced by the other.
  if (manifest.denied) {
    stateFindings.push({
      kind: 'enumeration-failed',
      severity: 'warn',
      path: null,
      message:
        'a directory of this project could not be read, so this pass covered only part of it and claims no complete result',
    })
  }

  // Where this pass resumes, and whether a manifest that moved under a running
  // backfill forces it to start over rather than publish unproven coverage.
  let afterPath = cursor === null ? null : cursor.afterPath
  if (
    fullPass &&
    cursor !== null &&
    cursor.afterPath !== null &&
    cursor.manifestFingerprint !== fingerprint
  ) {
    afterPath = null
  }
  const restarted = fullPass && cursor !== null && cursor.afterPath !== null && afterPath === null

  const suffix = fullPass
    ? manifest.paths.filter((path) => afterPath === null || path > afterPath)
    : requested
  const prefix =
    fullPass && afterPath !== null ? manifest.paths.filter((path) => path <= afterPath) : []

  const records = new Map()
  const loadRecord = async (path) => {
    if (records.has(path)) return records.get(path)
    let value
    try {
      value = { record: await readScanRecord(dataRoot, project.projectId, path), problem: null }
    } catch (error) {
      if (!(error instanceof CurationStateError)) throw error
      value = { record: null, problem: error.code }
    }
    records.set(path, value)
    return value
  }
  const noteRecordProblem = (path, problem) => {
    stateFindings.push({
      kind: 'record-unreadable',
      severity: 'info',
      path,
      message: `the scan record of ${path} could not be used (${problem}) and the note is inspected again`,
    })
  }

  /**
   * Bound one note's findings to what its record may hold, and say so when capped.
   *
   * The count cap alone is not a size bound, and the byte cap alone lets a note
   * with thousands of short findings through: a record nobody can read is a note
   * re-inspected on every pass forever, so both apply and the truncation is named
   * in the record rather than left to look like a note with nothing else wrong.
   */
  const boundedFindings = (path, source) => {
    const kept = []
    let keptBytes = 0
    for (const finding of source) {
      const size = Buffer.byteLength(JSON.stringify(finding), 'utf8')
      if (kept.length >= MAX_NOTE_FINDINGS || keptBytes + size > MAX_NOTE_FINDING_BYTES) break
      keptBytes += size
      kept.push(finding)
    }
    if (kept.length < source.length) {
      kept.push({
        kind: 'findings-truncated',
        severity: 'info',
        path,
        message: `${path} has ${source.length} findings; only the first ${kept.length} are recorded`,
      })
    }
    return kept
  }

  /** Read one note and persist its record, so a later pass can trust the path. */
  const inspectAndRecord = async (path) => {
    const absolute = await resolveVaultFile(vaultRoot, path, { home })
    const checked = await inspectPath({ absolute, path, binding, now, resolves })
    const payload = {
      version: SCAN_RECORD_SCHEMA,
      projectId: project.projectId,
      path,
      hash: checked.hash,
      size: checked.size,
      status: checked.status,
      reason: checked.reason,
      inspectedAt: now.toISOString(),
      findings: boundedFindings(path, checked.findings),
      findingsTotal: checked.findings.length,
      entry: checked.entry,
    }
    try {
      const record = await writeScanRecord(dataRoot, project.projectId, payload)
      records.set(path, { record, problem: null })
      return record
    } catch (error) {
      // A record this module cannot store is that *note's* problem, never the
      // pass's: one note's frontmatter must not turn a hook pass into a throw. The
      // note becomes `unexamined`, which a view can show and can never merge as
      // current; whether it also counts as covered depends on whether the smaller
      // record below becomes durable.
      const code = typeof error?.code === 'string' && error.code !== '' ? error.code : 'unwritable'
      const degraded = {
        ...payload,
        status: 'unexamined',
        reason: `record-${code}`,
        findingsTotal: 1,
        findings: [
          {
            kind: 'unexamined',
            severity: 'warn',
            path,
            reason: `record-${code}`,
            message: `${path} could not be recorded (${code}); it is unexamined rather than counted as current`,
          },
        ],
        entry: null,
      }
      try {
        const record = await writeScanRecord(dataRoot, project.projectId, degraded)
        records.set(path, { record, problem: null })
        return record
      } catch (second) {
        // Even the one-finding record could not be stored — the store itself is
        // unwritable. The pass still must not throw, the note is still reported
        // unexamined, and the non-null problem makes the path a coverage hole, so
        // `complete` is never claimed over an inspection that did not become durable.
        const marker = `record-${typeof second?.code === 'string' && second.code !== '' ? second.code : 'unwritable'}`
        degraded.reason = marker
        degraded.findings[0].reason = marker
        degraded.findings[0].message = `${path} could not be recorded (${marker}) and is not counted as covered; it is unexamined`
        records.set(path, { record: degraded, problem: marker })
        return degraded
      }
    }
  }

  const inspected = []
  const todo = [...suffix]
  // The prefix — everything the previous cursor already claimed — is verified only
  // once this pass has nothing left of its own to do, and only enough to repair a
  // path that lost its record (a crash between a record write and its rename, or a
  // deleted file). Reading it up front would make every bounded pass pay for the
  // whole covered prefix.
  let prefixChecked = fullPass && cursor !== null && cursor.afterPath !== null ? false : true
  let index = 0
  let reachedEnd = false
  while (truncated === null) {
    if (index >= todo.length) {
      if (prefixChecked) {
        reachedEnd = true
        break
      }
      prefixChecked = true
      const uncovered = []
      for (const path of prefix) {
        // The prefix is read one record per covered path, which is a walk of the
        // whole manifest: without the deadline here a pass that had already spent
        // its time budget would still read every one of those files before it
        // returned, so `maxMs: 0` would cost O(manifest) reads. The note budget
        // does not apply — this loop inspects no note, it only verifies that the
        // records the cursor claims are still there.
        if (clock() - started >= maxMs) {
          truncated = 'time-budget'
          break
        }
        const { record, problem } = await loadRecord(path)
        if (problem !== null) noteRecordProblem(path, problem)
        if (record === null) uncovered.push(path)
      }
      if (truncated !== null) break
      todo.push(...uncovered)
      continue
    }
    // Both bounds are checked before the next read, so a bound stops *starting*
    // work rather than abandoning a read mid-flight: `maxMs: 0` inspects nothing
    // at all, and a pass that has spent its note budget does not spend one more
    // note on a repair path it happened to discover late.
    if (inspected.length >= maxNotes) {
      truncated = 'file-budget'
      break
    }
    if (clock() - started >= maxMs) {
      truncated = 'time-budget'
      break
    }
    const path = todo[index]
    index += 1
    inspected.push(await inspectAndRecord(path))
  }

  // One directory fsync per pass, not per record: renames are what make a record
  // visible, and the cursor written below claims the paths those renames cover.
  if (inspected.length > 0) {
    await fsyncDirectory(curationRecordDir(dataRoot, project.projectId))
  }

  // Assemble the result. A finished scope is read back from the persisted records
  // — including the batches of earlier passes — and a bounded pass reports only
  // the batch it just inspected.
  const scope = fullPass ? manifest.paths : requested
  const finishedScope = reachedEnd && truncated === null
  const scopeEntries = []
  const scopeFindings = []
  let coverageHole = false
  if (finishedScope) {
    for (const path of scope) {
      const { record, problem } = await loadRecord(path)
      if (problem !== null) {
        noteRecordProblem(path, problem)
        coverageHole = true
        // A record that could not be stored still holds what this pass saw about
        // the note — an `unexamined` finding naming the record reason — and
        // dropping it would hide the note's real state behind the state-level
        // finding that only names the store.
        if (record !== null) scopeFindings.push(...record.findings)
        continue
      }
      if (record === null) {
        coverageHole = true
        continue
      }
      if (record.entry !== null) scopeEntries.push(record.entry)
      scopeFindings.push(...record.findings)
    }
  } else {
    for (const record of inspected) {
      if (record.entry !== null) scopeEntries.push(record.entry)
      scopeFindings.push(...record.findings)
    }
  }
  // Coverage is the invariant `complete` rests on, so it is recomputed from the
  // records that were actually readable rather than assumed from the loop ending.
  const covered = finishedScope && !coverageHole
  if (finishedScope && !covered) truncated = 'records-missing'

  const grouped = groupEntries(scopeEntries)
  const findings = [...stateFindings, ...scopeFindings, ...grouped.findings]
  // `complete` requires every half: nothing left truncated, and the scope proven
  // covered — or, for a changed-path pass, the stored backfill covering the
  // manifest. A truncated pass is never complete, whichever traversal stopped it:
  // the caller reading `complete` is the one merging `entries` into a view, and the
  // paths a truncated pass never inspected are exactly what it would silently drop.
  // `manifest.denied` is the same rule for a coverage hole no bound produced: the
  // walk could not name a directory, so the manifest is smaller than the project
  // and no result over it is complete, however cleanly the pass then ran. It is
  // deliberately not a `truncatedReason`: no budget stopped this pass, so naming
  // one would be a second false claim in place of the first.
  const complete =
    truncated === null &&
    !manifest.denied &&
    (fullPass ? covered : backfillComplete(cursor, fingerprint, manifest.paths))

  // Only a full pass moves the cursor, and never past a manifest it could not walk
  // whole — neither a budget-truncated one nor one with a directory it could not
  // read. A cursor over a manifest short of a locked subtree would tell the next
  // pass that this project is covered when the hole is still there. The write
  // re-reads the cursor under the vault lock so two passes cannot overwrite each
  // other's progress.
  let resultCursor = cursor
  if (fullPass && truncated !== 'manifest-budget' && !manifest.denied) {
    const lastInspected = inspected.length > 0 ? inspected[inspected.length - 1].path : afterPath
    // Only a *covered* scope may name the last manifest path: a scope that ended
    // with a record missing would otherwise claim coverage the records deny.
    const nextAfter =
      covered && manifest.paths.length > 0
        ? manifest.paths[manifest.paths.length - 1]
        : lastInspected
    const next = {
      version: 1,
      projectId: project.projectId,
      afterPath: nextAfter,
      scannedAt: now.toISOString(),
      manifestFingerprint: fingerprint,
    }
    resultCursor = await withVaultLock(
      binding,
      async () => {
        let current = null
        try {
          current = await readCurationCursor(dataRoot, project.projectId)
        } catch (error) {
          if (!(error instanceof CurationStateError)) throw error
        }
        return writeCurationCursor(
          dataRoot,
          project.projectId,
          furtherCursor(current, next, manifest.paths),
        )
      },
      { dataRoot, home },
    )
  }

  const byKind = {}
  for (const finding of findings) byKind[finding.kind] = (byKind[finding.kind] ?? 0) + 1
  return {
    projectId: project.projectId,
    relativeDir: project.relativeDir,
    generatedAt: now.toISOString(),
    durationMs: Math.max(0, Math.round(clock() - started)),
    complete,
    truncated: truncated !== null,
    // `manifest-changed` names a pass that had to start over, and it outranks the
    // bound that stopped it: the reason it did not finish is that the ground moved.
    truncatedReason: restarted && !finishedScope ? 'manifest-changed' : truncated,
    cursor: resultCursor,
    manifest: {
      count: manifest.paths.length,
      fingerprint,
      truncated: manifest.truncated,
      // Why a caller must not read `count` as "how many notes this project has": a
      // directory that refused to be read contributed nothing to it. `complete:
      // false` already covers a merge decision; this names the measurement, so a
      // reader of `manifest` alone can see that the count is a floor.
      denied: manifest.denied,
    },
    changedPaths: requested,
    examined: inspected.length,
    examinedPaths: inspected.map((record) => record.path),
    entries: scopeEntries,
    exactGroups: grouped.exactGroups,
    findings,
    counts: {
      entries: scopeEntries.length,
      exactGroups: grouped.exactGroups.length,
      findings: findings.length,
      unexamined: byKind.unexamined ?? 0,
      byKind,
    },
  }
}

/**
 * Whether a project's stored backfill has already covered its whole manifest.
 *
 * This is the claim a changed-path pass reports as `complete`: the cursor's
 * fingerprint is the manifest that is on disk now, and its `afterPath` is that
 * manifest's last path. Nothing here re-reads the records — a changed-path pass
 * was asked to inspect a few paths, and verifying the whole record set to answer
 * a question about the backfill would make every write pay for the whole project.
 *
 * @param {object|null} cursor - the stored cursor, or `null`.
 * @param {string} fingerprint - the current manifest fingerprint.
 * @param {string[]} paths - the sorted manifest.
 * @returns {boolean} whether the backfill is complete.
 */
function backfillComplete(cursor, fingerprint, paths) {
  if (cursor === null || cursor.manifestFingerprint !== fingerprint) return false
  return cursor.afterPath === (paths.length === 0 ? null : paths[paths.length - 1])
}
