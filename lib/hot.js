// The hot memory layer (Task 8, spec §6.1).
//
// `_meta/hot.md` is the only part of the vault that is injected into every
// session, so it has a hard character cap (9000 by default) and an archival
// trigger at a fraction of it (67% by default). Its three zones — 强约束 /
// 进行中 / 已完成 — are plugin-managed; every entry carries a stable id, a
// source link, and is a single line, which is what makes the file parseable
// without a second grammar.
//
// Archival happens *before* the write, in the same transaction as the append,
// and follows four rules that this module exists to enforce:
//
//   * automatic archival takes from 已完成 alone, and only **complete** entries:
//     a line must carry the plugin's `hot-<UUIDv4>` marker *and* be
//     newline-terminated. A hand-written line, or a fragment the file ends in the
//     middle of, is never moved — the hot layer must not silently swallow text it
//     cannot prove it wrote;
//   * a **pointer line is never a candidate**, whatever it looks like: it is what
//     an archived entry leaves behind, it carries no text the archive does not
//     already have, and moving it costs bytes instead of freeing them. A 已完成
//     zone that holds nothing but pointers is a dead end for the automatic path,
//     and says so, rather than spinning over them;
//   * what leaves is replaced in place by a pointer line, so the hot file keeps
//     a navigable trace and the archive note keeps the full text;
//   * if the file is over the hard cap and nothing is archivable, the write
//     **fails** (`hot-over-capacity`) instead of exceeding the cap or truncating
//     an entry. That refusal names what each zone holds and points at
//     `mem_admin(action="hot", operation="compact")` — the explicit route, which
//     may also fold pointer lines and drain 进行中, because a caller asked for it.
//
// The archive note lives at `<project>/Docs/hot-archive.md`: a warm, searchable
// note rather than `_meta/`, which the index excludes except for `_meta/user.md`
// (spec §7). It is created on demand, carries a §6.4 id, and is itself only ever
// appended to — never rewritten — and only after its ownership is proven from
// its own frontmatter.
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  assertPluginOwnedContainer,
  assertPluginOwnedNote,
  findNoteById,
  localDate,
  MemoryError,
  normalizeDeps,
  renderNote,
  spliceBody,
} from './memory.js'
import { isValidNoteId, noteIdFor } from './routing.js'
import {
  findReceipt,
  newTransactionId,
  parseNote,
  runTransaction,
  assertOwnedFrontmatter,
} from './vault.js'

import {
  ARCHIVE_FILENAME,
  ARCHIVE_SECTION,
  ARCHIVED_PREFIX,
  ARCHIVE_TITLE,
  COMPACT_SECTIONS,
  HOT_ARCHIVE_RATIO,
  HOT_CAPACITY_CHARS,
  HOT_ENTRY_PATTERN,
  HOT_SECTIONS,
  archiveEntryIds,
  charCount,
  entryIdOf,
  entryPayload,
  isPointerLine,
  locateSection,
} from './hot-text.js'
import {
  describeZones,
  foldPointers,
  planArchive,
  totalEligibility,
  zoneStats,
} from './hot-archive.js'

export { MemoryError }

// Every name this module exported before the split stays importable from here:
// the text layer and the planner moved, the facade did not.
export {
  ARCHIVE_FILENAME,
  ARCHIVE_SECTION,
  ARCHIVED_PREFIX,
  ARCHIVE_TITLE,
  COMPACT_SECTIONS,
  HOT_ARCHIVE_RATIO,
  HOT_CAPACITY_CHARS,
  HOT_ENTRY_PATTERN,
  HOT_SECTIONS,
  charCount,
  isPointerLine,
  locateSection,
}

/**
 * The hot file of a bound project.
 *
 * @param {object} binding - a `kind:'bound'` binding.
 * @returns {string} the vault-relative path.
 */
export function hotPathFor(binding) {
  return `${projectDirectory(binding)}/_meta/hot.md`
}

/**
 * The archive note of a bound project.
 *
 * @param {object} binding - a `kind:'bound'` binding.
 * @returns {string} the vault-relative path.
 */
export function archivePathFor(binding) {
  return `${projectDirectory(binding)}/Docs/${ARCHIVE_FILENAME}.md`
}

/**
 * Append one entry to the hot file and archive complete 已完成 entries when the
 * file crosses its archival trigger.
 *
 * @param {object} binding - a `kind:'bound'` binding.
 * @param {{ section: string, text: string, sourceId?: string, session?: string, idempotencyKey?: string }} request - the entry to add.
 * @param {{ dataRoot?: string, home?: string, now?: Date, capacityChars?: number, archiveRatio?: number }} [deps] - dependency seam plus budget overrides.
 * @returns {Promise<object>} the transaction receipt.
 * @throws {MemoryError} with `hot-over-capacity` when an over-limit file cannot be archived.
 */
export async function updateHot(binding, request, deps = {}) {
  const options = normalizeDeps(deps)
  const { dataRoot, home } = options
  const today = localDate(options.now)
  const capacity = numberOption(deps, 'capacityChars', HOT_CAPACITY_CHARS)
  if (!Number.isSafeInteger(capacity) || capacity < 64)
    throw new RangeError('deps.capacityChars must be an integer of at least 64')
  const ratio = numberOption(deps, 'archiveRatio', HOT_ARCHIVE_RATIO)
  if (!(ratio > 0 && ratio < 1)) throw new RangeError('deps.archiveRatio must be between 0 and 1')
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    throw new RangeError('an updateHot request object is required')
  }
  const section = requireText(request.section, 'section')
  if (!HOT_SECTIONS.includes(section))
    throw new RangeError(`section must be one of ${HOT_SECTIONS.join(', ')}`)
  const entryText = singleLine(requireText(request.text, 'text'))
  const idempotencyKey = request.idempotencyKey ?? null
  if (idempotencyKey !== null) {
    if (typeof idempotencyKey !== 'string' || idempotencyKey === '') {
      throw new RangeError('idempotencyKey must be a non-blank string when present')
    }
    const stored = await findReceipt(binding, idempotencyKey, options)
    if (stored !== null) return stored
  }

  const hotPath = hotPathFor(binding)
  const archivePath = archivePathFor(binding)
  const entryId = `hot-${randomUUID()}`
  const source = await sourceLabel(binding, request.sourceId, options)
  const entryLine = `- [${entryId}] ${entryText}${source === null ? '' : ` — ${source}`}`
  // The archive target runs after the hot target inside the same transaction, so
  // the hot transform records what to move and the archive transform renders the
  // archive note from the bytes it reads under the lock. Neither has to guess the
  // other's current revision.
  const stash = { lines: [] }

  return runTransaction(
    binding,
    {
      txId: newTransactionId(),
      idempotencyKey,
      updates: [
        {
          path: hotPath,
          transform: (current) =>
            planHotWrite({
              current,
              hotPath,
              section,
              entryLine,
              entryId,
              today,
              archivePath,
              stash,
              capacity,
              trigger: capacity * ratio,
            }),
        },
        {
          path: archivePath,
          hash: '*',
          transform: (current) =>
            stash.lines.length === 0
              ? null
              : archiveUpdate(current, { binding, archivePath, today, lines: stash.lines }),
        },
      ],
      receipt: { action: 'hot', sessionId: request.session ?? null },
    },
    { dataRoot, home },
  )
}

/**
 * Bring an over-full hot file back under its archival trigger, explicitly.
 *
 * This is the recovery path a `hot-over-capacity` refusal points at, and the one
 * thing no automatic write can do: it folds the 已完成 zone pointer lines into a
 * single summary line, keeping every id the file carried, and then drains the
 * oldest archivable entries from 已完成 and — only when that was not enough — from
 * 进行中. All of it lands in one transaction, with one receipt, under the same
 * vault lock and the same ownership proofs as every other write.
 *
 * It never refuses for being over the cap: it is the way out. It does refuse for
 * the reasons every hot write refuses (a missing or unproven container), and it
 * reports what it could not free instead of pretending the file is now small.
 *
 * @param {object} binding - a `kind:'bound'` binding.
 * @param {{ dataRoot?: string, home?: string, now?: Date, capacityChars?: number, archiveRatio?: number, session?: string|null }} [deps] - dependency seam plus budget overrides.
 * @returns {Promise<{receipt: object, outcome: object}>} the transaction receipt and what the pass did.
 * @throws {MemoryError} with `hot-missing` when the file does not exist.
 */
export async function compactHot(binding, deps = {}) {
  const options = normalizeDeps(deps)
  const { dataRoot, home } = options
  const today = localDate(options.now)
  const capacity = numberOption(deps, 'capacityChars', HOT_CAPACITY_CHARS)
  const ratio = numberOption(deps, 'archiveRatio', HOT_ARCHIVE_RATIO)
  const hotPath = hotPathFor(binding)
  const archivePath = archivePathFor(binding)
  // The same seam `updateHot` uses: the hot transform records what to move and
  // the archive transform renders from the bytes it reads under the lock.
  const stash = { lines: [] }
  const receipt = await runTransaction(
    binding,
    {
      txId: newTransactionId(),
      updates: [
        {
          path: hotPath,
          transform: (current) =>
            planCompact({ current, hotPath, archivePath, stash, trigger: capacity * ratio, today }),
        },
        {
          path: archivePath,
          hash: '*',
          transform: (current) =>
            stash.lines.length === 0
              ? null
              : archiveUpdate(current, { binding, archivePath, today, lines: stash.lines }),
        },
      ],
      receipt: { action: 'hot-compact', sessionId: deps.session ?? null },
    },
    { dataRoot, home },
  )
  return { receipt, outcome: stash.outcome ?? EMPTY_COMPACT_OUTCOME }
}

/** What a compact that never reached the planning step reports. */
const EMPTY_COMPACT_OUTCOME = Object.freeze({
  usedBefore: null,
  used: null,
  reclaimed: 0,
  moved: 0,
  folded: 0,
})

/**
 * The current state of one project hot layer, without writing anything.
 *
 * The read half of the recovery path: it answers "why did the write refuse, and
 * what would free space" with the same numbers the refusal itself carries, so a
 * caller never has to parse an error message or hand-edit the vault.
 *
 * @param {object} binding - a `kind:'bound'` binding.
 * @param {{ capacityChars?: number, archiveRatio?: number }} [deps] - budget overrides.
 * @returns {Promise<object>} the usage report.
 */
export async function hotStatus(binding, deps = {}) {
  const capacity = numberOption(deps, 'capacityChars', HOT_CAPACITY_CHARS)
  const ratio = numberOption(deps, 'archiveRatio', HOT_ARCHIVE_RATIO)
  const hotPath = hotPathFor(binding)
  const archivePath = archivePathFor(binding)
  const text = await readHotText(binding, hotPath)
  const trigger = capacity * ratio
  if (text === null) {
    return {
      missing: true,
      used: 0,
      capacity,
      trigger,
      ratio,
      sections: [],
      archivable: 0,
      compactable: 0,
    }
  }
  const sections = zoneStats(text, { archivePath })
  return {
    missing: false,
    used: charCount(text),
    capacity,
    trigger,
    ratio,
    sections,
    ...totalEligibility(sections),
  }
}

/**
 * Read one vault file by its vault-relative path.
 *
 * @param {object} binding - a `kind:'bound'` binding.
 * @param {string} relativePath - the vault-relative path.
 * @returns {Promise<string|null>} the text, or null when the file is absent.
 */
async function readHotText(binding, relativePath) {
  try {
    const bytes = await readFile(join(binding.vaultRoot, ...relativePath.split('/')))
    return bytes.toString('utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

/**
 * Compute the next hot file: append the entry, archive if the trigger is
 * crossed, and refuse a file that would exceed the hard cap.
 *
 * @param {object} input - the plan inputs.
 * @returns {Buffer|null} the next hot bytes, or `null` for a no-op.
 */
function planHotWrite({
  current,
  hotPath,
  section,
  entryLine,
  entryId,
  today,
  archivePath,
  stash,
  capacity,
  trigger,
}) {
  if (current === null) {
    throw new MemoryError(
      'hot-missing',
      `${hotPath} is missing; bootstrap the project before writing hot memory`,
    )
  }
  const note = parseNote(current)
  assertPluginOwnedContainer(note, hotPath, 'hot')
  const text = current.toString('utf8')
  const appended = appendEntry(text, section, entryLine)
  if (appended === null) return null // the exact entry is already in the zone

  let next = appended
  if (charCount(next) > trigger) {
    const move = planArchive(next, { archivePath, excludeId: entryId, trigger })
    if (move.archived.length > 0) {
      stash.lines = move.archived
      next = move.text
    }
  }
  if (charCount(next) > capacity) {
    // The refusal is the only thing a caller sees, so it carries the numbers the
    // status report would give and names the way out. "No entry can be archived"
    // was the old text, and it was wrong twice over: it hid that the 已完成 zone
    // was full of pointers, and it offered no route to a file that is stuck.
    const sections = zoneStats(next, { archivePath, excludeId: entryId })
    const { compactable } = totalEligibility(sections)
    throw new MemoryError(
      'hot-over-capacity',
      `${hotPath} would hold ${charCount(next)} characters, above the ${capacity} character cap. ${describeZones(sections)}. Automatic archival moves only complete ${ARCHIVE_SECTION} entries, so it cannot free the ${charCount(next) - capacity} characters this write needs; ${compactable} more entry(ies) can be moved by mem_admin(action="hot", operation="compact"), which also folds pointer lines and may drain 进行中. Refusing to exceed the cap or truncate an entry`,
    )
  }
  const out = spliceBody(current, next, { today })
  return out.equals(current) ? null : out
}

/**
 * Append one entry line to a hot zone.
 *
 * An entry whose text and source are already in the zone is a content-level
 * no-op even when the caller supplied no idempotency key: the same fact must not
 * appear twice in the injected layer just because a retry minted a new entry id.
 *
 * @param {string} text - the hot file text.
 * @param {string} section - the zone name.
 * @param {string} line - the entry line.
 * @returns {string|null} the next text, or `null` when the entry is already there.
 * @throws {MemoryError} when the zone is missing.
 */
function appendEntry(text, section, line) {
  const zone = locateSection(text, section)
  if (zone === null) {
    throw new MemoryError(
      'hot-section-missing',
      `the hot file has no \`## ${section}\` zone to write into`,
    )
  }
  const payload = entryPayload(line)
  for (const existing of zone.body.split('\n')) {
    if (
      existing === line ||
      (HOT_ENTRY_PATTERN.test(existing) && entryPayload(existing) === payload)
    )
      return null
  }
  const following = zone.bodyEnd < text.length
  const insertion = `${line}\n${following ? '\n' : ''}`
  return `${text.slice(0, zone.bodyEnd)}${insertion}${text.slice(zone.bodyEnd)}`
}

/**
 * Bring one hot file back under its trigger, the explicit way.
 *
 * Two steps, in this order, and the order is the contract: fold first, because a
 * folded aggregate line costs fewer characters than the per-entry pointers it
 * replaces and may bring the file under the trigger on its own; then drain, which
 * stops at the first prefix whose aggregate text is strictly smaller and fits.
 * `planCompact` is the only caller of `planArchive` that names more than one
 * source zone.
 *
 * @param {object} input - the plan inputs (`stash` receives the moved lines and the outcome).
 * @returns {Buffer|null} the next hot bytes, or `null` for a no-op.
 */
function planCompact({ current, hotPath, archivePath, stash, trigger, today }) {
  if (current === null) {
    throw new MemoryError(
      'hot-missing',
      `${hotPath} is missing; bootstrap the project before compacting hot memory`,
    )
  }
  const note = parseNote(current)
  assertPluginOwnedContainer(note, hotPath, 'hot')
  const text = current.toString('utf8')
  const before = charCount(text)
  // Fold the legacy per-entry pointers first: the migration shrinks the file and
  // may be enough on its own. Then drain, and evaluate the *final* folded text —
  // the move now leaves one aggregate line per zone, so the second fold is
  // normally a no-op, but the outcome below must report the bytes a caller will
  // actually keep, and that is the post-fold text.
  const first = foldPointers(text, archivePath)
  const move = planArchive(first.text, {
    archivePath,
    trigger,
    sections: COMPACT_SECTIONS,
    mustHelp: true,
  })
  if (move.archived.length > 0) stash.lines = move.archived
  const second = foldPointers(move.text, archivePath)
  const next = second.text
  // Reported whether or not the file shrank: "compact ran and could not help" is
  // an answer, and it is the one a caller trapped by a refusal needs.
  stash.outcome = {
    usedBefore: before,
    used: charCount(next),
    reclaimed: before - charCount(next),
    moved: move.archived.length,
    folded: first.removed + second.removed,
  }
  if (next === text) return null
  return spliceBody(current, next, { today })
}

/**
 * The archive update for one batch of moved entries, or `null` when nothing new
 * is appendable.
 *
 * This is the one door every archive append goes through, and it is where an
 * archive stops absorbing its own output: pointer lines are dropped (they are not
 * entries) and an id the note already carries is skipped (a note that holds the
 * same id eight times is the shipped bug this exists to prevent). Returning `null`
 * rather than an unchanged buffer is what keeps a batch of only-pointers from
 * creating the archive note. It does not keep the path out of the receipt: the
 * transaction engine lists every declared target it was given, changed or not.
 *
 * @param {Buffer|null} current - current archive bytes, or `null` when absent.
 * @param {{ binding: object, archivePath: string, today: string, lines: string[] }} input - archive inputs.
 * @returns {Buffer|null} the next archive bytes, or `null` for a no-op.
 */
function archiveUpdate(current, { binding, archivePath, today, lines }) {
  const existing = current === null ? null : current.toString('utf8')
  const fresh = appendableArchiveLines(lines, existing, archivePath)
  if (fresh.length === 0) return null
  return renderArchiveNext(current, { binding, archivePath, today, lines: fresh })
}

/**
 * The moved entries an archive note does not already hold.
 *
 * @param {string[]} lines - the entry lines about to be appended.
 * @param {string|null} existingText - the note's current text, or `null` when it does not exist yet.
 * @param {string} archivePath - the archive note's vault-relative path.
 * @returns {string[]} the lines worth appending.
 */
function appendableArchiveLines(lines, existingText, archivePath) {
  const seen = new Set(existingText === null ? [] : archiveEntryIds(existingText))
  const fresh = []
  for (const line of lines) {
    if (isPointerLine(line, archivePath)) continue
    const id = entryIdOf(line)
    if (id !== null) {
      if (seen.has(id)) continue
      seen.add(id)
    }
    fresh.push(line)
  }
  return fresh
}

/**
 * The next archive note, created on demand and otherwise appended to.
 *
 * `lines` is what `archiveUpdate` already vetted: never empty, never a pointer,
 * never an id the note holds. The guard here is the backstop for a caller that
 * gets it wrong, because rendering an empty batch would create a properly owned
 * note with an empty section.
 *
 * @param {Buffer|null} current - current archive bytes, or `null` when absent.
 * @param {{ binding: object, archivePath: string, today: string, lines: string[] }} input - archive inputs.
 * @returns {Buffer|null} the next archive bytes, or `null` for a no-op.
 */
function renderArchiveNext(current, { binding, archivePath, today, lines }) {
  if (lines.length === 0) return null
  if (current === null) {
    const fields = {
      id: noteIdFor('doc'),
      type: 'doc',
      title: ARCHIVE_TITLE,
      status: 'active',
      created: today,
      updated: today,
      tags: ['dsh-mem/doc', `project/${binding.slug}`],
      project: binding.projectId,
      source: 'agent',
      session: null,
      harness: 'dsh',
      trust: 'agent',
      superseded_by: null,
    }
    const text = renderNote(
      fields,
      `# ${ARCHIVE_TITLE}\n\n## ${today} 归档\n\n${lines.join('\n')}\n`,
    )
    // The same pre-write self-check bootstrap runs on its templates: a renderer
    // regression must fail here rather than reach the vault.
    assertOwnedFrontmatter(text, { path: archivePath })
    return Buffer.from(text, 'utf8')
  }
  const note = parseNote(current)
  assertPluginOwnedNote(note, archivePath)
  if (!isValidNoteId(note.data?.id)) {
    throw new MemoryError(
      'ownership-unproven',
      `${archivePath} carries no plugin id, so the archive is never appended to`,
    )
  }
  const text = current.toString('utf8')
  const heading = `## ${today} 归档`
  const base = text.endsWith('\n') ? text : `${text}\n`
  const nextText =
    text.includes(`\n${heading}\n`) || text.startsWith(`${heading}\n`)
      ? `${base}\n${lines.join('\n')}\n`
      : `${base}\n${heading}\n\n${lines.join('\n')}\n`
  const out = spliceBody(current, nextText, { today })
  return out.equals(current) ? null : out
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * A source link for one hot entry, resolved from the source note's id.
 *
 * @param {object} binding - a `kind:'bound'` binding.
 * @param {unknown} sourceId - the source note's stable id.
 * @param {object} options - normalised deps.
 * @returns {Promise<string|null>} a path-qualified wikilink, or `null` when no source was given.
 * @throws {MemoryError} with `note-not-found` when the named source does not exist.
 */
async function sourceLabel(binding, sourceId, options) {
  if (sourceId === undefined || sourceId === null) return null
  if (typeof sourceId !== 'string' || sourceId.trim() === '')
    throw new RangeError('sourceId must be a non-blank id')
  const found = await findNoteById(binding, sourceId, options)
  if (found === null) {
    throw new MemoryError(
      'note-not-found',
      `sourceId ${JSON.stringify(sourceId)} does not exist in this project, so the hot entry cannot link its source`,
    )
  }
  const title = String(found.note.data?.title ?? sourceId)
  return `[[${found.path.replace(/\.md$/, '')}|${title}]]`
}

/**
 * Collapse an entry to the single line the hot format requires.
 *
 * @param {string} text - the caller's text.
 * @returns {string} one trimmed line.
 */
function singleLine(text) {
  const collapsed = String(text).replace(/\s+/gu, ' ').trim()
  if (collapsed === '') throw new RangeError('text must carry at least one visible character')
  return collapsed
}

/**
 * Read one optional numeric budget override from the dependency seam.
 *
 * @param {object} deps - the caller's deps (may be empty).
 * @param {string} key - the deps key.
 * @param {number} fallback - the default.
 * @returns {number} the effective value.
 * @throws {RangeError} when the override is not a finite number.
 */
function numberOption(deps, key, fallback) {
  const raw = deps?.[key] ?? fallback
  if (typeof raw !== 'number' || !Number.isFinite(raw))
    throw new RangeError(`deps.${key} must be a finite number`)
  return raw
}

/**
 * Require a non-blank string field.
 *
 * @param {unknown} value - candidate.
 * @param {string} field - field name for the diagnostic.
 * @returns {string} the value.
 */
function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '')
    throw new RangeError(`${field} must be a non-blank string`)
  return value
}

/**
 * The bound project's vault-relative directory.
 *
 * @param {object} binding - a `kind:'bound'` binding.
 * @returns {string} the directory.
 */
function projectDirectory(binding) {
  if (binding === null || typeof binding !== 'object' || Array.isArray(binding)) {
    throw new RangeError('a bound project binding is required')
  }
  if (typeof binding.relativeDir !== 'string' || binding.relativeDir.trim() === '') {
    throw new RangeError('binding.relativeDir must be a non-blank vault-relative path')
  }
  return binding.relativeDir.replace(/\/+$/, '')
}
