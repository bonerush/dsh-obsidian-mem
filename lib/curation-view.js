// The compact, source-verified navigation view (curation plan Task 4).
//
// The brief has to answer "what does this project know?" under a hard character
// budget at every session start. Today it does that by reading the vault's own
// navigation — the hub outline, the convention MOC, the most recent decisions and
// gotchas — and every line it emits is re-derived from note bytes on every build.
// This module is the bounded, rebuildable cache of exactly that navigation: one
// entry per current fact, with a bounded one-line description, its vault path and
// the sha256 of the bytes it was built from.
//
// Four rules shape it, and they are the whole module:
//
//   * **The view is never authority.** It is a cache under `<dataRoot>/curation/`
//     whose only consumer is `buildBrief`. Every entry it can inject carries the
//     source hash it was built from, and {@link verifyCurationEntries} re-hashes
//     every path of every selected entry through the vault jail before a brief is
//     composed from it. Deleting the file costs one scan, nothing else; a stale or
//     damaged file costs a fallback to the source path the brief already had.
//   * **A complete view is the only complete view.** `complete` is carried from
//     the scan that produced it and is never inferred from the entries: a scan
//     that hit `maxNotes` or its deadline returns the batch it inspected, and a
//     view built from a batch is a view that silently dropped facts. So a
//     changed-path pass may only merge into a view that is already complete, and
//     refuses with `backfill-incomplete` otherwise. The document's entry count is
//     bounded separately, by {@link VIEW_ENTRY_LIMIT} over the *grouped* list: that
//     bound is a property of the projection, so it never moves this flag.
//   * **A change recomputes, it does not append.** A changed-path scan reports
//     the entries it re-inspected; merging them into the stored entries and
//     regrouping from scratch is what keeps an exact-match group truthful. An
//     entry that was the second member of a collapsed group and is now
//     `superseded` changes the group it belonged to, so the group has to be
//     derived from the merged entry set rather than patched. Regrouping is only
//     possible because each stored entry keeps the `exactKey` the scanner
//     computed: a merge has no note body to re-derive it from, and an entry that
//     lost its key groups alone, which would split every untouched duplicate pair
//     into one displayed line per path until the next full pass.
//   * **A description is quoted note text, bounded.** `note-health`/`curation-scan`
//     already strip a leading block prefix when they extract a body's first line;
//     this module re-applies that rule to the rendered line as well, because the
//     view's content is injected into a Markdown brief and a description that
//     began with `#` would be read as a heading of the brief rather than as the
//     data it is. The bound is small on purpose: a description is a label, and the
//     note itself is one `mem_read` away.
//
// Historical entries are deliberately *excluded from the stored view* rather than
// stored and filtered at render time. The spec says a superseded note is not
// current navigation ("Exclude it from the active view, as current search already
// does"), the scanner's exact-match grouping excludes history for the same reason,
// and storing bytes a reader must remember not to show is the kind of trap this
// repository has already paid for once. The cost of the choice: a note that
// becomes history between two full scans stays visible until the next complete
// pass, because a changed-path merge has no entry for it to delete.
import { promises as fs } from 'node:fs'

import { HISTORY_STATUSES } from './note-health.js'
import { MAX_NOTE_BYTES, sha256Hex } from './index-db.js'
import {
  CurationStateError,
  VIEW_DOCUMENT_SCHEMA,
  readCurationViewJson,
  requireCurationBinding,
  requireCurationDataRoot,
  writeCurationViewJson,
} from './curation-state.js'
import { resolveVaultFile } from './paths.js'

/**
 * The stored schema version. Owned with the document's reader/writer in
 * `lib/curation-state.js` (that is where the version check has to run) and
 * re-exported here so a caller of this API spells the same number.
 */
export const VIEW_SCHEMA = VIEW_DOCUMENT_SCHEMA

/**
 * How many entries one view document holds.
 *
 * Enforced by {@link groupExactEntries}, which is the only function that produces
 * the list the document stores. The bound is applied to the *groups*, after
 * grouping and sorting: cutting the entry list first could split a collapsed
 * exact-match group and drop the alternative paths the group exists to carry.
 */
export const VIEW_ENTRY_LIMIT = 2000
/**
 * The longest description one view entry carries.
 *
 * Smaller than the scanner's own extract bound (160): the scanner's number is
 * sized to keep a *note* recognisable in a status report, while this one is a line
 * the brief has to fit under a 6000-code-point budget. Truncating an already
 * bounded extract can only shorten it, never change which note it came from.
 */
export const MAX_VIEW_DESCRIPTION_CHARS = 120
/** The longest note-supplied title/status/type one view entry carries. */
export const MAX_VIEW_FIELD_CHARS = 256
/**
 * The serialized-size bound this module enforces before it hands a view to the
 * store. Below the reader's own `MAX_VIEW_BYTES` on purpose: a document that
 * exceeds the store's bound must be a reported `fallback`, not a throw.
 */
export const MAX_VIEW_DOCUMENT_BYTES = 768 * 1024

/** The entry fields the view displays; anything else is dropped before storage. */
const VIEW_ENTRY_FIELDS = Object.freeze(['id', 'type', 'title', 'status', 'description'])

/**
 * Truncate one note-supplied string to a bounded number of code points.
 *
 * Code points, not UTF-16 units: the brief's own budget is counted that way, and
 * a cut in the middle of a surrogate pair would store a lone surrogate that any
 * later JSON round-trip is entitled to mangle.
 *
 * @param {unknown} value - the value.
 * @param {number} limit - the maximum code points.
 * @returns {string|null} the bounded string, or `null` when the value was not a string.
 */
function boundedText(value, limit) {
  if (typeof value !== 'string') return null
  const points = [...value]
  return points.length <= limit ? value : points.slice(0, limit).join('')
}

/**
 * One note's text as a description: one line, no block prefix, bounded.
 *
 * The prefix strip is repeated from the scanner rather than trusted, because this
 * function is the one whose output reaches a Markdown document. `describeBody`
 * already removes a leading `#`/`>`/bullet run when it extracts the line; this
 * guard is what keeps that a property of *this* module's output even if a caller
 * hands it an entry the scanner did not build.
 *
 * @param {unknown} description - the scanner's extract.
 * @returns {string} the renderable description (possibly empty).
 */
function renderableDescription(description) {
  const text = String(description ?? '')
    .replace(/^\s*(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)?/u, '')
    .replace(/\s+/gu, ' ')
    .trim()
  return boundedText(text, MAX_VIEW_DESCRIPTION_CHARS) ?? ''
}

/**
 * One entry as the view stores it: display fields only, every string bounded.
 *
 * `exactKey` is stored beside them, as a hex digest or `null`, and it is what makes
 * a changed-path merge able to regroup. The stored shape is what the next merge
 * reads, and a merge has no body to re-derive the scanner's identity hash from; an
 * entry that lost its key would have to be grouped by its path, which is exactly
 * one group per path — the duplicate pair would come back as two displayed lines
 * and lose its alternative paths until the next full pass.
 *
 * @param {object} entry - a scanner entry (or one a previous view stored).
 * @returns {object} the stored shape.
 * @throws {RangeError} when the entry has no usable path.
 */
function pickViewEntry(entry) {
  const path = typeof entry?.path === 'string' && entry.path !== '' ? entry.path : null
  if (path === null) throw new RangeError('a curation view entry needs its vault-relative path')
  const hash = typeof entry.hash === 'string' && entry.hash !== '' ? entry.hash : null
  if (hash === null) {
    // Without the hash there is nothing to verify against, and an entry that
    // cannot be verified is one the brief would have to inject on trust.
    throw new RangeError(
      `a curation view entry for ${path} needs the source hash it was built from`,
    )
  }
  const picked = { path, hash, paths: [path], sourceHashes: [hash] }
  picked.exactKey =
    typeof entry.exactKey === 'string' && entry.exactKey !== '' ? entry.exactKey : null
  for (const field of VIEW_ENTRY_FIELDS) {
    picked[field] =
      field === 'description'
        ? renderableDescription(entry[field])
        : boundedText(entry[field], MAX_VIEW_FIELD_CHARS)
  }
  return picked
}

/**
 * Order entries by their first path, so two passes over the same vault agree.
 *
 * @param {object[]} entries - the entries.
 * @returns {object[]} the same entries, sorted.
 */
function sortEntries(entries) {
  return [...entries].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  )
}

/**
 * Group entries by exact identity, collapsing each group to one displayed entry.
 *
 * The grouping rule and the history exclusion mirror `lib/curation-scan.js`'s
 * `groupEntries`, which is what computes the `exactKey` these entries carry. They
 * are re-applied here rather than imported from there because this function also
 * runs over a *merge* of a stored view and a changed-path batch, where the
 * scanner's group list describes only the batch. The key itself *is* imported, in
 * the sense that it is stored with the entry and read back: a stored entry carries
 * the digest the scanner computed, so a merge regroups untouched entries instead of
 * falling back to one group per path. `entry.path` is the key only for an entry that
 * carries none — a legacy or hand-written stored entry — which is the one case where
 * an exact duplicate pair stays two displayed lines until the next full pass.
 *
 * The result is cut to {@link VIEW_ENTRY_LIMIT} *after* grouping and sorting, so the
 * document's entry bound can never split a collapsed group or drop one of its
 * alternative paths; the entries it drops are the ones whose path sorts last.
 *
 * @param {object[]} entries - view entries carrying `exactKey`.
 * @returns {object[]} one displayed entry per exact group, plus every solitary entry, at most {@link VIEW_ENTRY_LIMIT} of them.
 * @throws {RangeError} when an entry cannot be reduced to a stored entry.
 */
export function groupExactEntries(entries) {
  const current = entries.filter(
    (entry) =>
      !HISTORY_STATUSES.includes(entry.status) &&
      entry.type !== null &&
      entry.type !== undefined &&
      entry.title !== null &&
      entry.title !== undefined,
  )
  const pools = new Map()
  for (const entry of current) {
    const key =
      typeof entry.exactKey === 'string' && entry.exactKey !== '' ? entry.exactKey : entry.path
    if (!pools.has(key)) pools.set(key, [])
    pools.get(key).push(pickViewEntry(entry))
  }
  const groups = []
  for (const members of pools.values()) {
    const ordered = members.sort((left, right) => (left.path < right.path ? -1 : 1))
    const display = { ...ordered[0] }
    display.paths = ordered.map((member) => member.path)
    display.sourceHashes = ordered.map((member) => member.hash)
    groups.push(display)
  }
  return sortEntries(groups).slice(0, VIEW_ENTRY_LIMIT)
}

/**
 * Rebuild one stored entry from the paths and hashes a view carries.
 *
 * The group key is carried through: the stored entry already holds the `exactKey`
 * its members shared, and spreading it means the regroup after the merge sees the
 * same identity the full pass saw.
 *
 * @param {object} entry - a stored view entry.
 * @returns {object[]} one entry per path in the collapsed group.
 */
function expandStoredEntry(entry) {
  return entry.paths.map((path, index) => ({
    ...entry,
    path,
    hash: entry.sourceHashes[index],
    paths: undefined,
    sourceHashes: undefined,
  }))
}

/**
 * Merge a changed-path batch into the entries a complete view already holds.
 *
 * Every path the batch inspected replaces what the view held for that path — the
 * batch is the newer evidence, whichever way the note changed — and a path the
 * batch reported as `unexamined` has no entry, so its old entry is dropped rather
 * than re-injected. Nothing else is touched, which is the "never dropping
 * untouched entries" half of the plan's rule.
 *
 * The set of paths allowed to *delete* is `examinedPaths`, falling back to the
 * paths present in `scanEntries`. Both name only paths the pass actually
 * inspected; the fallback is the narrower of the two, so a caller that omits
 * `examinedPaths` loses nothing rather than losing entries it never re-inspected.
 *
 * @param {object[]} previousEntries - the stored view's entries.
 * @param {object[]} scanEntries - the entries the changed-path scan inspected.
 * @param {string[]} changedPaths - the paths that scan was asked to inspect.
 * @param {unknown} examinedPaths - the paths it actually inspected, when it reports them.
 * @returns {object[]} the merged entries, before grouping.
 */
function mergeStoredEntries(previousEntries, scanEntries, changedPaths, examinedPaths) {
  const merged = new Map()
  for (const entry of previousEntries.flatMap(expandStoredEntry)) merged.set(entry.path, entry)
  // A path the pass was asked for but never reached before its own bound is not
  // the same as a path that disappeared: only an inspected path may delete a
  // stored entry.
  const examined = Array.isArray(examinedPaths)
    ? new Set(examinedPaths)
    : new Set(scanEntries.map((entry) => entry.path))
  for (const path of changedPaths) if (examined.has(path)) merged.delete(path)
  for (const entry of scanEntries) merged.set(entry.path, entry)
  return [...merged.values()]
}

/**
 * The paths one view entry would need to have verified.
 *
 * @param {object} entry - a stored entry, a scan entry, or the plan's `{paths, sourceHashes}` shape.
 * @returns {string[]} the paths.
 * @throws {RangeError} when the entry carries neither.
 */
function pathsOf(entry) {
  if (Array.isArray(entry?.paths) && entry.paths.length > 0) return entry.paths
  if (typeof entry?.path === 'string' && entry.path !== '') return [entry.path]
  throw new RangeError('a curation entry must carry the path (or paths) it was built from')
}

/**
 * Read one note's bytes through the vault jail and hash them.
 *
 * @param {object} project - the validated binding.
 * @param {string} path - the vault-relative path.
 * @param {{home?: string}} [options] - the home seam for `~/` expansion.
 * @returns {Promise<string|null>} the sha256, or `null` when the note cannot be read.
 */
async function hashSource(project, path, options) {
  // The jail runs first and its refusal is a `null` here, not a throw: a path that
  // escapes the vault is a view this process must not use, and it is not a caller
  // bug — the bytes in the view are not the caller's.
  let absolute
  try {
    absolute = await resolveVaultFile(project.vaultRoot, path, { home: options?.home })
  } catch {
    return null
  }
  let size
  try {
    const stats = await fs.stat(absolute, { bigint: true })
    if (!stats.isFile() || stats.size > BigInt(MAX_NOTE_BYTES)) return null
    size = Number(stats.size)
  } catch {
    return null
  }
  if (!Number.isSafeInteger(size)) return null
  try {
    return sha256Hex(await fs.readFile(absolute))
  } catch {
    return null
  }
}

/**
 * Verify that every path of every selected entry still holds the bytes the entry
 * was built from, hashing through the same jailed read the scan used.
 *
 * **Every** path is hashed, including every member of a collapsed exact-match
 * group: the group is displayed as one entry, so verifying only the displayed
 * member would let an edit to an alternative path inject a group whose identity
 * claim is no longer true. One changed member is the whole selection's answer,
 * because a view is injected whole or not at all.
 *
 * A refusal (an escape, a symlink, an unreadable note, an oversize note) is the
 * same answer as a changed hash — `fallback`/`source-changed` — and never a
 * `ready` result with the unverifiable member quietly skipped. The reason string
 * is deliberately coarse: a caller's only correct response is to read the source,
 * and a finer code would be a second thing to keep honest for no decision.
 *
 * @param {{binding: object, entries: object[], home?: string}} input - the bound project and the entries a caller intends to inject.
 * @returns {Promise<{status: 'ready'|'fallback', reason: string|null}>} the verdict.
 * @throws {RangeError} when the binding is not a bound project or an entry carries no path.
 */
export async function verifyCurationEntries({ binding, entries, home }) {
  const project = requireCurationBinding(binding)
  if (!Array.isArray(entries))
    throw new RangeError('verifyCurationEntries needs the entries it should verify')
  for (const entry of entries) {
    const expected = new Map()
    const paths = pathsOf(entry)
    for (const [index, path] of paths.entries()) {
      const hash = Array.isArray(entry.sourceHashes) ? entry.sourceHashes[index] : entry.hash
      if (typeof hash !== 'string' || hash === '') {
        return { status: 'fallback', reason: 'source-changed' }
      }
      expected.set(path, hash)
    }
    for (const [path, hash] of expected) {
      const actual = await hashSource(project, path, { home })
      if (actual === null || actual !== hash)
        return { status: 'fallback', reason: 'source-changed' }
    }
  }
  return { status: 'ready', reason: null }
}

/**
 * Read one project's stored view, or `null` when there is none worth using.
 *
 * `null` covers every unusable case — absent, unreadable, corrupt, the wrong
 * version, another project's — because a caller's response is the same in all of
 * them: use the source path. It never returns a partially populated view, and a
 * view that is stored but `complete: false` is returned as it is, with that flag
 * intact, so the caller decides rather than this reader guessing.
 *
 * @param {{dataRoot: string, projectId: string}} input - the plugin data root and the project.
 * @returns {Promise<{version: number, projectId: string, complete: boolean, entries: object[], generatedAt: string|null}|null>} the view, or `null`.
 * @throws {RangeError} when the data root or the project id is invalid.
 */
export async function readCurationView({ dataRoot, projectId }) {
  const raw = await readCurationViewJson(dataRoot, projectId)
  if (raw === null) return null
  let entries
  try {
    entries = normalizeStoredEntries(raw.entries)
  } catch {
    return null
  }
  return {
    version: VIEW_SCHEMA,
    projectId,
    // Only the literal `true` is complete. A view whose flag is missing or of
    // another type is a view whose completeness nobody proved, and the consumers
    // that merge on this field must not read `undefined` as "yes".
    complete: raw.complete === true,
    entries,
    generatedAt: typeof raw.generatedAt === 'string' ? raw.generatedAt : null,
  }
}

/**
 * Validate and copy the entries a stored view carries.
 *
 * @param {unknown} raw - the stored entry list.
 * @returns {object[]} the entries.
 * @throws {RangeError} when the list or one entry is not a stored view entry.
 */
function normalizeStoredEntries(raw) {
  if (!Array.isArray(raw)) throw new RangeError('a stored curation view carries an entry list')
  return raw.map((entry) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new RangeError('a stored curation view entry must be a plain object')
    }
    const paths = entry.paths
    const hashes = entry.sourceHashes
    if (!Array.isArray(paths) || paths.length === 0) {
      throw new RangeError('a stored curation view entry carries the paths it stands for')
    }
    if (!Array.isArray(hashes) || hashes.length !== paths.length) {
      throw new RangeError('a stored curation view entry carries one source hash per path')
    }
    for (const path of paths) {
      if (typeof path !== 'string' || path === '')
        throw new RangeError('a stored curation view path must be a non-blank string')
    }
    for (const hash of hashes) {
      if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/u.test(hash)) {
        throw new RangeError('a stored curation view hash must be a sha256 hex digest')
      }
    }
    const entryOut = {
      paths: [...paths],
      sourceHashes: [...hashes],
      path: paths[0],
      hash: hashes[0],
      // The identity key a merge needs to regroup. `null` for an entry stored
      // before this field existed (or written by hand): such an entry is grouped by
      // its path, which is the pre-merge behaviour and never a wrong collapse.
      exactKey: typeof entry.exactKey === 'string' && entry.exactKey !== '' ? entry.exactKey : null,
    }
    for (const field of VIEW_ENTRY_FIELDS) {
      entryOut[field] = typeof entry[field] === 'string' ? entry[field] : null
    }
    return entryOut
  })
}

/**
 * Build (or merge into) the compact view for one completed scan and store it.
 *
 * The plan's three cases, in order:
 *
 *   * no changed paths (a full pass) — the scan's entries *replace* the view, and
 *     the view's completeness is the scan's own;
 *   * changed paths over a complete view — the inspected entries are merged into
 *     the stored ones, the exact-match groups are recomputed from the merge, and
 *     the view stays complete because both halves were;
 *   * changed paths over anything else — `fallback`/`backfill-incomplete`, with
 *     nothing written. A changed-path scan's `entries` span only the paths it
 *     inspected, so merging them into an incomplete view would publish a view
 *     that is missing every fact of the unfinished backfill.
 *
 * A stored document over {@link MAX_VIEW_DOCUMENT_BYTES} is reported as
 * `fallback`/`view-oversize` rather than thrown: the caller's alternative is the
 * source path, and a cache that cannot hold this project's navigation must not
 * fail a session.
 *
 * @param {{binding: object, dataRoot: string, scan: object, now?: Date}} input - the bound project, the plugin data root and the scan result to build from.
 * @returns {Promise<{status: 'written'|'fallback', view?: object[], reason?: string}>} `written` with the stored entry list, or `fallback` with why.
 * @throws {RangeError} when the binding, the data root or the scan result is unusable.
 */
export async function buildCurationView({ binding, dataRoot, scan, now = new Date() }) {
  const project = requireCurationBinding(binding)
  requireCurationDataRoot(dataRoot)
  if (scan === null || typeof scan !== 'object' || !Array.isArray(scan.entries)) {
    throw new RangeError('buildCurationView needs the result scanCuration() returned')
  }
  const changedPaths = Array.isArray(scan.changedPaths) ? scan.changedPaths : []
  const previous = await readCurationView({ dataRoot, projectId: project.projectId })

  let entries
  let complete
  if (changedPaths.length === 0) {
    entries = scan.entries
    complete = scan.complete === true
  } else {
    if (previous?.complete !== true) return { status: 'fallback', reason: 'backfill-incomplete' }
    entries = mergeStoredEntries(previous.entries, scan.entries, changedPaths, scan.examinedPaths)
    complete = true
  }

  let grouped
  try {
    grouped = groupExactEntries(entries)
  } catch (error) {
    if (!(error instanceof RangeError)) throw error
    return { status: 'fallback', reason: 'entry-unusable' }
  }
  const document = {
    version: VIEW_SCHEMA,
    projectId: project.projectId,
    complete,
    entries: grouped,
    generatedAt: now.toISOString(),
  }
  if (Buffer.byteLength(JSON.stringify(document), 'utf8') > MAX_VIEW_DOCUMENT_BYTES) {
    return { status: 'fallback', reason: 'view-oversize' }
  }
  try {
    await writeCurationViewJson(dataRoot, project.projectId, document)
  } catch (error) {
    if (!(error instanceof CurationStateError)) throw error
    // The store refused the bytes (its own bound, or a write that could not land).
    // A cache that cannot be written is a fallback, never a failed session.
    return { status: 'fallback', reason: `view-unwritable:${error.code}` }
  }
  return { status: 'written', view: grouped }
}
