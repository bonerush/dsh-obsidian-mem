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

export { MemoryError }

/** The three plugin-managed zones of `_meta/hot.md` (spec §6.1). */
export const HOT_SECTIONS = Object.freeze(['强约束', '进行中', '已完成'])
/** The one zone automatic archival may move entries out of (spec §6.1: "只允许从'已完成'区自动归档"). */
export const ARCHIVE_SECTION = '已完成'
/**
 * The source order an **explicit** compact drains, after the automatic zone.
 *
 * 进行中 is where a long-lived file actually grows, so a 已完成 zone that has
 * nothing archivable left would otherwise strand the whole hot layer at its cap.
 * Only an explicit call may cross into it: the spec restricts *automatic*
 * archival to 已完成, and moving an in-progress entry out of the injected layer is
 * a decision a caller has to make, not one a background write makes for them.
 */
export const COMPACT_SECTIONS = Object.freeze([ARCHIVE_SECTION, '进行中'])
/**
 * The word an archived entry's pointer line opens with.
 *
 * It is the *content* half of the pointer test, and deliberately the vault's own
 * language: a pointer a foreign tool wrote still starts with 已归档, while the
 * archive link alone would miss a hand-typed pointer that dropped the wikilink.
 */
export const ARCHIVED_PREFIX = '已归档'
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
 * text, and a source.
 *
 * Shaped, not sufficient: a pointer line (what an archived entry becomes) matches
 * this pattern too, so matching is only ever the *first* half of archive
 * eligibility — {@link isPointerLine} is the second, and it is the half that
 * keeps archival from spinning over its own output. The earlier comment here
 * claimed a pointer line does not match, and that wrong claim is what made the
 * hot layer archive pointers instead of entries.
 */
export const HOT_ENTRY_PATTERN =
  /^- \[(hot-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\] (.+)$/

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
  return {
    headingStart: found.headingStart,
    bodyStart: found.bodyStart,
    bodyEnd,
    body: text.slice(found.bodyStart, bodyEnd),
  }
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
 * Move the complete entries needed to get a hot file back under its trigger.
 *
 * Eligibility has three halves, and every one of them is load-bearing:
 *
 *   * a plugin-written line, shaped `hot-<UUIDv4>`. A hand-written line has no
 *     marker, so this plugin may not claim it wrote it;
 *   * newline-terminated. A file that ends mid-line proves the last entry was
 *     never written completely, so it is not moved;
 *   * **not already a pointer line.** A pointer carries no text the archive does
 *     not have, and replacing it with an equal pointer costs bytes instead of
 *     freeing them — which is how the hot layer used to fill its archive with
 *     pointers while still refusing every write.
 *
 * Entries are taken oldest first (file order), from each named zone in turn, and
 * the *smallest* prefix that fits the trigger is taken. A prefix that costs bytes
 * is still a plan when it moves text the archive did not have — a pointer line
 * costs about 100 characters, so a short entry can be replaced by a longer line,
 * and the capacity check, not this function, is what guards the cap. `mustHelp` is
 * how `compact` refuses that trade: a recovery pass that grows the file is not a
 * recovery pass.
 *
 * @param {string} text - the hot file text (after the append).
 * @param {{ archivePath: string, excludeId?: string|null, trigger: number, sections?: readonly string[], mustHelp?: boolean }} input - the archive target, the entry just added, the trigger, the zones this call may take from, and whether a prefix that costs bytes is refused.
 * @returns {{text: string, archived: string[]}} the next text, and the moved entry lines (empty when nothing may be moved).
 */
function planArchive(
  text,
  { archivePath, excludeId = null, trigger, sections = [ARCHIVE_SECTION], mustHelp = false },
) {
  const { zones, candidates } = archiveCandidates(text, { archivePath, excludeId, sections })
  if (candidates.length === 0) return { text, archived: [] }
  // Already inside the trigger: nothing needs to leave. `compact` is the caller
  // this exists for — it folds before it drains, and folding alone can be enough,
  // in which case moving entries out of the injected layer would be pure loss.
  if (charCount(text) <= trigger) return { text, archived: [] }

  for (let take = 1; take <= candidates.length; take += 1) {
    const chosen = candidates.slice(0, take)
    const nextText = applyPointers(text, zones, chosen, archivePath)
    const plan = { text: nextText, archived: chosen.map((entry) => entry.line) }
    // The smallest prefix that gets the file under its trigger is the plan. A
    // pointer line costs about 100 characters, so a short entry can be replaced by
    // a *longer* line; the automatic path accepts that (moving the text is the
    // point, and the capacity check still guards the cap), while `compact` forbids
    // it — a recovery pass that grows the file is not a recovery pass — and looks
    // at a larger batch instead.
    if (charCount(nextText) <= trigger) {
      if (!mustHelp || charCount(nextText) <= charCount(text)) return plan
      continue
    }
    if (take < candidates.length) continue
    // Everything was taken and it still does not fit. Move it anyway unless this
    // caller forbids growth: "moved as much as possible" is the answer the next
    // decision is made against.
    return mustHelp && charCount(nextText) > charCount(text) ? { text, archived: [] } : plan
  }
  return { text, archived: [] }
}

/**
 * The zones this call may take from, and the entries eligible inside them.
 *
 * @param {string} text - the hot file text.
 * @param {{ archivePath: string, excludeId?: string|null, sections: readonly string[] }} input - the archive target, the entry just added, and the zone order.
 * @returns {{zones: object[], candidates: object[]}} located zones and candidates, both in document order within each zone.
 */
function archiveCandidates(text, { archivePath, excludeId = null, sections }) {
  const zones = []
  const candidates = []
  for (const name of sections) {
    const zone = locateSection(text, name)
    if (zone === null) continue
    zones.push(zone)
    const lines = zone.body.split('\n')
    for (let index = 0; index < lines.length; index += 1) {
      const match = HOT_ENTRY_PATTERN.exec(lines[index])
      if (match === null || match[1] === excludeId) continue
      if (!isTerminated(index, lines, zone, text)) continue
      if (isPointerLine(lines[index], archivePath)) continue
      candidates.push({ id: match[1], index, line: lines[index], zone })
    }
  }
  return { zones, candidates }
}

/**
 * Replace the chosen entries with their pointer lines, in place.
 *
 * Zones are rewritten back to front: an earlier zone edit changes the length of
 * the text every later zone offset was measured against. 进行中 comes before
 * 已完成 in the document even though it is drained second, so "document order"
 * and "drain order" are deliberately two different things here.
 *
 * @param {string} text - the hot file text.
 * @param {object[]} zones - the located zones (document order).
 * @param {object[]} chosen - the candidates to replace.
 * @param {string} archivePath - the archive note's vault-relative path.
 * @returns {string} the next text.
 */
function applyPointers(text, zones, chosen, archivePath) {
  const byZone = new Map()
  for (const entry of chosen) {
    let pointers = byZone.get(entry.zone)
    if (pointers === undefined) {
      pointers = new Map()
      byZone.set(entry.zone, pointers)
    }
    pointers.set(entry.index, pointerLine(entry.id, archivePath))
  }
  let next = text
  for (const zone of [...zones].sort((left, right) => right.bodyStart - left.bodyStart)) {
    const pointers = byZone.get(zone)
    if (pointers === undefined) continue
    const body = zone.body
      .split('\n')
      .map((line, index) => pointers.get(index) ?? line)
      .join('\n')
    next = `${next.slice(0, zone.bodyStart)}${body}${next.slice(zone.bodyEnd)}`
  }
  return next
}

/**
 * What each zone holds, in the numbers a refusal and a status report both quote.
 *
 * The two counters are independent on purpose. `pointers` counts pointer lines
 * *whatever their shape*, because `compact` folds a whole zone into one summary
 * line that is not `HOT_ENTRY_PATTERN`-shaped at all — a report that only counted
 * entry-shaped lines would show a zone full of pointers as empty. `entries` counts
 * the complete non-pointer entries, and `moveable` is those minus the entry this
 * call just added (which is there, but not a candidate for its own archive).
 *
 * @param {string} text - the hot file text.
 * @param {{ archivePath: string, excludeId?: string|null, sections?: readonly string[] }} input - the archive target, the entry just added, and the zones to describe.
 * @returns {object[]} one row per located zone: `{name, chars, entries, pointers, moveable}`.
 */
function zoneStats(text, { archivePath, excludeId = null, sections = HOT_SECTIONS }) {
  const stats = []
  for (const name of sections) {
    const zone = locateSection(text, name)
    if (zone === null) continue
    const lines = zone.body.split('\n')
    let entries = 0
    let pointers = 0
    let moveable = 0
    for (let index = 0; index < lines.length; index += 1) {
      const match = HOT_ENTRY_PATTERN.exec(lines[index])
      const pointer = isPointerLine(lines[index], archivePath)
      if (match === null && !pointer) continue
      if (!isTerminated(index, lines, zone, text)) continue
      if (pointer) {
        pointers += 1
        continue
      }
      entries += 1
      if (match[1] === excludeId) continue
      moveable += 1
    }
    stats.push({ name, chars: charCount(zone.body), entries, pointers, moveable })
  }
  return stats
}

/**
 * The two totals a caller acts on, derived from per-zone numbers.
 *
 * `archivable` is what an automatic write may move (已完成 alone, per the spec);
 * `compactable` is what an explicit `mem_admin(action="hot", operation="compact")`
 * may move, which is why 进行中 is counted there and never in `archivable`.
 * 强约束 appears in neither: it is released explicitly, never moved.
 *
 * @param {object[]} sections - the rows `zoneStats` returned.
 * @returns {{archivable: number, compactable: number}} the totals.
 */
function totalEligibility(sections) {
  const moveable = (name) => sections.find((zone) => zone.name === name)?.moveable ?? 0
  return {
    archivable: moveable(ARCHIVE_SECTION),
    compactable: COMPACT_SECTIONS.reduce((sum, name) => sum + moveable(name), 0),
  }
}

/**
 * One line per zone, for the refusal that has to explain itself.
 *
 * @param {object[]} sections - the rows `zoneStats` returned.
 * @returns {string} a semicolon-joined summary.
 */
function describeZones(sections) {
  return sections
    .map(
      (zone) =>
        `${zone.name}: ${zone.chars} chars, ${zone.entries} complete entries (${zone.pointers} pointers, ${zone.moveable} moveable)`,
    )
    .join('; ')
}

/**
 * Bring one hot file back under its trigger, the explicit way.
 *
 * Two steps, in this order, and the order is the contract: fold first, because a
 * folded line costs fewer characters than the pointers it replaces and may bring
 * the file under the trigger on its own; then drain, which stops at the first
 * prefix that fits. `planCompact` is the only caller of `planArchive` that names
 * more than one source zone.
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
  // Fold, then move, then fold again. The last fold is not redundant: the entries
  // the move just took leave *new* pointer lines behind, and folding those into the
  // zone summary is what makes a batch of short entries profitable at all — a single
  // pointer line costs about 100 characters, so one short entry moved on its own can
  // grow the file even though the batch it belongs to shrinks it.
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
 * Fold the 已完成 zone pointer lines into one summary pointer.
 *
 * Only ever shrinks, and only ever with at least two pointers: one pointer folded
 * "into itself" grows the line by the summary overhead. Lines that are not
 * terminated, or that carry no parseable id, are left exactly as they are — this
 * is a rendering change to lines the plugin wrote, not a licence to rewrite the
 * zone.
 *
 * @param {string} text - the hot file text.
 * @param {string} archivePath - the archive note's vault-relative path.
 * @returns {{text: string, removed: number}} the next text and how many pointer lines the fold removed (0 when nothing was).
 */
function foldPointers(text, archivePath) {
  const zone = locateSection(text, ARCHIVE_SECTION)
  if (zone === null) return { text, removed: 0 }
  const lines = zone.body.split('\n')
  const indices = []
  const ids = []
  for (let index = 0; index < lines.length; index += 1) {
    if (!isPointerLine(lines[index], archivePath)) continue
    if (!isTerminated(index, lines, zone, text)) continue
    const id = entryIdOf(lines[index])
    if (id === null) continue
    indices.push(index)
    ids.push(id)
  }
  if (ids.length < 2) return { text, removed: 0 }
  const dropped = new Set(indices.slice(1))
  const nextLines = []
  for (let index = 0; index < lines.length; index += 1) {
    if (index === indices[0]) nextLines.push(pointerLine(ids, archivePath))
    else if (!dropped.has(index)) nextLines.push(lines[index])
  }
  const nextBody = nextLines.join('\n')
  if (charCount(nextBody) >= charCount(zone.body)) return { text, removed: 0 }
  return {
    text: `${text.slice(0, zone.bodyStart)}${nextBody}${text.slice(zone.bodyEnd)}`,
    // Lines that disappeared, not "pointers seen": the summary line is folded
    // again by the second pass, and counting it twice would overstate the work.
    removed: ids.length - 1,
  }
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
 * The line archived entries leave behind.
 *
 * It takes one id or several: `compact` folds a whole 已完成 zone of pointers into
 * one line that keeps every id, which is the only way the bytes those pointers
 * occupy are ever reclaimed. A folded line is not a `HOT_ENTRY_PATTERN` match, so
 * nothing can archive it, and it still answers `isPointerLine`.
 *
 * @param {string|string[]} entryIds - one archived entry's stable id, or the ids being folded together.
 * @param {string} archivePath - the archive note's vault-relative path.
 * @returns {string} the pointer line.
 */
function pointerLine(entryIds, archivePath) {
  const ids = Array.isArray(entryIds) ? entryIds : [entryIds]
  return `- [${ids.join(', ')}] ${ARCHIVED_PREFIX} → ${archiveLink(archivePath)}|${ARCHIVE_TITLE}]]`
}

/**
 * The wikilink an archive pointer carries, without its closing brackets.
 *
 * @param {string} archivePath - the archive note's vault-relative path.
 * @returns {string} the link opener.
 */
function archiveLink(archivePath) {
  return `[[${archivePath.replace(/\.md$/, '')}`
}

/**
 * Whether a line is what an archived entry leaves behind, rather than an entry.
 *
 * Two independent tests, because either one alone has a hole: the payload word
 * catches a pointer a foreign tool rendered without the link, and the archive link
 * catches one rendered in another language or with another title. The id shape is
 * deliberately *not* a test — a foreign, non-UUIDv4 pointer is exactly what the
 * reported hot file held, and it must be inert too.
 *
 * Exported because the brief injects 强约束/进行中 and must never inject one of
 * these as if it were a fact: `compact` can drain 进行中, which leaves pointers
 * in an *injected* zone, and a pointer rendered as "- [ ] 已归档 → [[…]]" is
 * noise in every session prompt.
 *
 * @param {string} line - a zone line.
 * @param {string} archivePath - the archive note's vault-relative path.
 * @returns {boolean} whether the line is a pointer.
 */
export function isPointerLine(line, archivePath) {
  const payload = entryPayload(line)
  if (payload.startsWith(ARCHIVED_PREFIX)) return true
  return payload.includes(archiveLink(archivePath))
}

/**
 * The stable id a line carries, whatever shape it has.
 *
 * Deliberately laxer than `HOT_ENTRY_PATTERN`: this is the identity half of the
 * archive dedupe, and a foreign id is still an identity that must not be filed
 * twice. A folded summary reports its whole id list as "one id"; that is harmless
 * because the pointer test runs before the dedupe, so a folded line is never a
 * candidate to append anywhere.
 *
 * @param {string} line - an entry or pointer line.
 * @returns {string|null} the id, or `null` when the line carries none.
 */
function entryIdOf(line) {
  const match = /^- \[(hot-[^\]]+)\] /.exec(String(line))
  return match === null ? null : match[1]
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
 * Every entry id a text already carries.
 *
 * @param {string} text - a note or zone text.
 * @returns {string[]} the ids, in file order.
 */
function archiveEntryIds(text) {
  const ids = []
  for (const line of String(text).split('\n')) {
    const id = entryIdOf(line)
    if (id !== null) ids.push(id)
  }
  return ids
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
