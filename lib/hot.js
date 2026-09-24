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
// and follows three rules that this module exists to enforce:
//
//   * only **complete** entries leave the 已完成 zone: a line must carry the
//     plugin's `hot-<UUIDv4>` marker *and* be newline-terminated. A hand-written
//     line, or a fragment the file ends in the middle of, is never moved — the
//     hot layer must not silently swallow text it cannot prove it wrote;
//   * what leaves is replaced in place by a pointer line, so the hot file keeps
//     a navigable trace and the archive note keeps the full text;
//   * if the file is over the hard cap and nothing is archivable, the write
//     **fails** (`hot-over-capacity`) instead of exceeding the cap or truncating
//     an entry.
//
// The archive note lives at `<project>/Docs/hot-archive.md`: a warm, searchable
// note rather than `_meta/`, which the index excludes except for `_meta/user.md`
// (spec §7). It is created on demand, carries a §6.4 id, and is itself only ever
// appended to — never rewritten — and only after its ownership is proven from
// its own frontmatter.
import { randomUUID } from 'node:crypto'

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
import { findReceipt, newTransactionId, parseNote, runTransaction, assertOwnedFrontmatter } from './vault.js'

export { MemoryError }

/** The three plugin-managed zones of `_meta/hot.md` (spec §6.1). */
export const HOT_SECTIONS = Object.freeze(['强约束', '进行中', '已完成'])
/** The zone archival may move entries out of. */
export const ARCHIVE_SECTION = '已完成'
/** The default hard character cap of the hot file. */
export const HOT_CAPACITY_CHARS = 9000
/** The default fraction of the cap that starts archival. */
export const HOT_ARCHIVE_RATIO = 0.67
/** The title of the archive note. Its *name on disk* is ASCII (see {@link ARCHIVE_FILENAME}); the title is content and stays in the vault's own language. */
export const ARCHIVE_TITLE = '热记忆归档'
/**
 * The archive note's fixed file name (no extension).
 *
 * Every path in the vault is ASCII — directory names and the file names the
 * plugin fixes itself — so a vault survives a shell, an archive or a tool that
 * is not comfortable with CJK paths. A *note* the model writes may be named in
 * any language: its name is the writer's choice, its identity is frontmatter
 * `id`. This one is the plugin's own, so it is fixed and ASCII.
 */
export const ARCHIVE_FILENAME = 'hot-archive'
/**
 * A complete, plugin-written hot entry: a stable `hot-<UUIDv4>` id, one line of
 * text, and a source. A pointer line (what an archived entry becomes) does not
 * match, so it is never archived again.
 */
export const HOT_ENTRY_PATTERN = /^- \[(hot-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\] (.+)$/

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
 * The hot layer's character count, in Unicode code points (not UTF-16 units), so
 * a CJK entry costs one character per character.
 *
 * @param {string} text - the hot file text.
 * @returns {number} the code-point count.
 */
export function charCount(text) {
  return [...String(text)].length
}

/**
 * Locate one `## <name>` zone of a Markdown document.
 *
 * @param {string} text - the document.
 * @param {string} name - the zone heading text.
 * @returns {{headingStart: number, bodyStart: number, bodyEnd: number, body: string}|null} the zone, or `null`.
 */
export function locateSection(text, name) {
  const lines = String(text).split('\n')
  let offset = 0
  let found = null
  for (const line of lines) {
    const start = offset
    offset += line.length + 1
    if (found === null) {
      if (line.startsWith('## ') && line.slice(3).trimEnd() === name) {
        found = { headingStart: start, bodyStart: Math.min(start + line.length + 1, text.length) }
      }
      continue
    }
    if (line.startsWith('## ')) {
      found.bodyEnd = start
      break
    }
  }
  if (found === null) return null
  const bodyEnd = found.bodyEnd ?? text.length
  return { headingStart: found.headingStart, bodyStart: found.bodyStart, bodyEnd, body: text.slice(found.bodyStart, bodyEnd) }
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
  if (!Number.isSafeInteger(capacity) || capacity < 64) throw new RangeError('deps.capacityChars must be an integer of at least 64')
  const ratio = numberOption(deps, 'archiveRatio', HOT_ARCHIVE_RATIO)
  if (!(ratio > 0 && ratio < 1)) throw new RangeError('deps.archiveRatio must be between 0 and 1')
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    throw new RangeError('an updateHot request object is required')
  }
  const section = requireText(request.section, 'section')
  if (!HOT_SECTIONS.includes(section)) throw new RangeError(`section must be one of ${HOT_SECTIONS.join(', ')}`)
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
          transform: (current) => planHotWrite({
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
          transform: (current) => (stash.lines.length === 0
            ? null
            : renderArchiveNext(current, { binding, archivePath, today, lines: stash.lines })),
        },
      ],
      receipt: { action: 'hot', sessionId: request.session ?? null },
    },
    { dataRoot, home },
  )
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
function planHotWrite({ current, hotPath, section, entryLine, entryId, today, archivePath, stash, capacity, trigger }) {
  if (current === null) {
    throw new MemoryError('hot-missing', `${hotPath} is missing; bootstrap the project before writing hot memory`)
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
    throw new MemoryError(
      'hot-over-capacity',
      `${hotPath} would hold ${charCount(next)} characters, above the ${capacity} character cap, and no complete ${ARCHIVE_SECTION} entry can be archived; refusing to exceed the cap or truncate an entry`,
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
    throw new MemoryError('hot-section-missing', `the hot file has no \`## ${section}\` zone to write into`)
  }
  const payload = entryPayload(line)
  for (const existing of zone.body.split('\n')) {
    if (existing === line || (HOT_ENTRY_PATTERN.test(existing) && entryPayload(existing) === payload)) return null
  }
  const following = zone.bodyEnd < text.length
  const insertion = `${line}\n${following ? '\n' : ''}`
  return `${text.slice(0, zone.bodyEnd)}${insertion}${text.slice(zone.bodyEnd)}`
}

/**
 * The text of an entry line, without its stable id.
 *
 * @param {string} line - an entry line.
 * @returns {string} the payload.
 */
function entryPayload(line) {
  const marker = String(line).indexOf('] ')
  return marker === -1 ? String(line) : String(line).slice(marker + 2)
}

/**
 * Move the complete 已完成 entries needed to get back under the trigger.
 *
 * Only a plugin-written, newline-terminated entry is eligible: a hand-written
 * line has no `hot-<UUIDv4>` marker, and a fragment the file ends in the middle
 * of is not an entry this plugin may claim it wrote. Entries are taken oldest
 * first, stopping as soon as the file is back under the trigger.
 *
 * @param {string} text - the hot file text (after the append).
 * @param {{ archivePath: string, excludeId: string, trigger: number }} input - the archive target, the entry just added, and the trigger.
 * @returns {{text: string, archived: string[]}} the next text and the moved entry lines.
 */
function planArchive(text, { archivePath, excludeId, trigger }) {
  const zone = locateSection(text, ARCHIVE_SECTION)
  if (zone === null) return { text, archived: [] }
  const lines = zone.body.split('\n')
  const candidates = []
  for (let index = 0; index < lines.length; index += 1) {
    const match = HOT_ENTRY_PATTERN.exec(lines[index])
    if (match === null || match[1] === excludeId) continue
    if (!isTerminated(index, lines, zone, text)) continue
    candidates.push({ id: match[1], index, line: lines[index] })
  }
  if (candidates.length === 0) return { text, archived: [] }

  for (let take = 1; take <= candidates.length; take += 1) {
    const chosen = candidates.slice(0, take)
    const pointers = new Map(chosen.map((entry) => [entry.index, pointerLine(entry.id, archivePath)]))
    const nextBody = lines.map((line, index) => pointers.get(index) ?? line).join('\n')
    const nextText = `${text.slice(0, zone.bodyStart)}${nextBody}${text.slice(zone.bodyEnd)}`
    if (charCount(nextText) <= trigger || take === candidates.length) {
      return { text: nextText, archived: chosen.map((entry) => entry.line) }
    }
  }
  return { text, archived: [] }
}

/**
 * Whether a zone line is terminated by a newline.
 *
 * A file that ends in the middle of a line proves the entry after it was not
 * written completely, so it is never archived.
 *
 * @param {number} index - line index inside the zone body.
 * @param {string[]} lines - the zone body's lines.
 * @param {{bodyEnd: number}} zone - the located zone.
 * @param {string} text - the whole document.
 * @returns {boolean} whether the line is complete.
 */
function isTerminated(index, lines, zone, text) {
  if (index < lines.length - 1) return true
  return zone.bodyEnd === text.length && text.endsWith('\n')
}

/**
 * The line an archived entry leaves behind.
 *
 * @param {string} entryId - the archived entry's stable id.
 * @param {string} archivePath - the archive note's vault-relative path.
 * @returns {string} the pointer line.
 */
function pointerLine(entryId, archivePath) {
  return `- [${entryId}] 已归档 → [[${archivePath.replace(/\.md$/, '')}|${ARCHIVE_TITLE}]]`
}

/**
 * The next archive note, created on demand and otherwise appended to.
 *
 * @param {Buffer|null} current - current archive bytes, or `null` when absent.
 * @param {{ binding: object, archivePath: string, today: string, lines: string[] }} input - archive inputs.
 * @returns {Buffer|null} the next archive bytes, or `null` for a no-op.
 */
function renderArchiveNext(current, { binding, archivePath, today, lines }) {
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
    const text = renderNote(fields, `# ${ARCHIVE_TITLE}\n\n## ${today} 归档\n\n${lines.join('\n')}\n`)
    // The same pre-write self-check bootstrap runs on its templates: a renderer
    // regression must fail here rather than reach the vault.
    assertOwnedFrontmatter(text, { path: archivePath })
    return Buffer.from(text, 'utf8')
  }
  const note = parseNote(current)
  assertPluginOwnedNote(note, archivePath)
  if (!isValidNoteId(note.data?.id)) {
    throw new MemoryError('ownership-unproven', `${archivePath} carries no plugin id, so the archive is never appended to`)
  }
  const text = current.toString('utf8')
  const heading = `## ${today} 归档`
  const base = text.endsWith('\n') ? text : `${text}\n`
  const nextText = text.includes(`\n${heading}\n`) || text.startsWith(`${heading}\n`)
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
  if (typeof sourceId !== 'string' || sourceId.trim() === '') throw new RangeError('sourceId must be a non-blank id')
  const found = await findNoteById(binding, sourceId, options)
  if (found === null) {
    throw new MemoryError('note-not-found', `sourceId ${JSON.stringify(sourceId)} does not exist in this project, so the hot entry cannot link its source`)
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
  if (typeof raw !== 'number' || !Number.isFinite(raw)) throw new RangeError(`deps.${key} must be a finite number`)
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
  if (typeof value !== 'string' || value.trim() === '') throw new RangeError(`${field} must be a non-blank string`)
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
