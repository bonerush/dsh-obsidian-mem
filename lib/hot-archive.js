// The hot file's archive planner, one layer above its text format.
//
// `planArchive` is the decision the hot layer's rules describe: take the smallest
// prefix of complete 已完成 entries that brings the file back under its trigger,
// remove those lines and leave one aggregate pointer per affected zone — never a
// pointer per entry, whose ~100-cp cost is what made a short-entry batch refuse
// itself. `foldPointers` migrates a legacy zone of per-entry pointers into the
// same aggregate form, and `zoneStats` / `totalEligibility` / `describeZones`
// are the numbers a refusal and a status report both quote.
//
// It imports `./hot-text.js` and nothing else. There is no I/O here and no
// knowledge of a binding, a transaction or a receipt: `./hot.js` composes those
// around it, which is what lets the planner be reviewed as a pure function of
// the bytes it is given.
import {
  ARCHIVED_PREFIX,
  ARCHIVE_SECTION,
  ARCHIVE_TITLE,
  COMPACT_SECTIONS,
  HOT_ENTRY_PATTERN,
  HOT_SECTIONS,
  archiveLink,
  charCount,
  entryIdOf,
  isPointerLine,
  isTerminated,
  locateSection,
} from './hot-text.js'

/**
 * The one pointer line an affected zone is left with.
 *
 * `count` is how many archived entries the zone's line stands for, so a later
 * archive pass accumulates into the line instead of appending a second pointer.
 * The line is what the old per-entry pointer (`- [hot-…] 已归档 → …`) became: it
 * is deliberately not a `HOT_ENTRY_PATTERN` match, so nothing can archive it, and
 * it still answers `isPointerLine` through the 已归档 payload prefix.
 *
 * @param {number} count - the archived entries this line stands for.
 * @param {string} archivePath - the archive note's vault-relative path.
 * @returns {string} the aggregate pointer line.
 */
export function archiveLine(count, archivePath) {
  return `- ${ARCHIVED_PREFIX} ${count} 条 → ${archiveLink(archivePath)}|${ARCHIVE_TITLE}]]`
}

/**
 * How many archived entries one pointer line stands for, or `0` when the line is
 * not a pointer this module can parse.
 *
 * An aggregate line carries its own count. A legacy per-entry pointer carries one
 * stable id, and the old fold could put several in one bracket list — that list is
 * still the number of entries it stands for, which is what lets the migration keep
 * the count truthful. A pointer with no parseable id is left alone: it is not this
 * plugin's output to rewrite.
 */
const AGGREGATE_POINTER_PATTERN = new RegExp(`^- ${ARCHIVED_PREFIX} (\\d+) 条 → \\[\\[`)

function pointerCount(line, archivePath) {
  const aggregate = AGGREGATE_POINTER_PATTERN.exec(line)
  if (aggregate !== null) return Number(aggregate[1])
  if (!isPointerLine(line, archivePath)) return 0
  const ids = entryIdOf(line)
  return ids === null ? 0 : ids.split(',').length
}

/** The parseable, newline-terminated pointer lines of one zone, in file order. */
function pointerLinesOf(lines, zone, text, archivePath) {
  const found = []
  for (let index = 0; index < lines.length; index += 1) {
    const count = pointerCount(lines[index], archivePath)
    if (count === 0) continue
    if (!isTerminated(index, lines, zone, text)) continue
    found.push({ index, count })
  }
  return found
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
 *     not have, and it is what archival leaves behind, so it is never a candidate.
 *
 * Entries are taken oldest first (file order), from each named zone in turn, and
 * the *smallest* prefix that fits the trigger is taken. The batch is replaced by
 * one aggregate line per affected zone, so moving a short entry now always frees
 * bytes — that is the fix for the compact that refused every short batch. `mustHelp`
 * is how `compact` keeps the guarantee explicit: a recovery pass that does not make
 * the file strictly smaller is not a recovery pass, and it looks at a larger batch
 * instead.
 *
 * @param {string} text - the hot file text (after the append or the fold).
 * @param {{ archivePath: string, excludeId?: string|null, trigger: number, sections?: readonly string[], mustHelp?: boolean }} input - the archive target, the entry just added, the trigger, the zones this call may take from, and whether a prefix that does not shrink the file is refused.
 * @returns {{text: string, archived: string[]}} the next text, and the moved entry lines (empty when nothing may be moved).
 */
export function planArchive(
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
    // The smallest prefix that gets the file under its trigger is the plan. The
    // automatic path accepts any prefix the trigger admits; `compact` additionally
    // requires the text to be strictly smaller than what it was handed, because a
    // recovery pass that costs bytes is not a recovery pass.
    if (charCount(nextText) <= trigger) {
      if (!mustHelp || charCount(nextText) < charCount(text)) return plan
      continue
    }
    if (take < candidates.length) continue
    // Everything was taken and it still does not fit. Move it anyway unless this
    // caller forbids a non-shrinking batch: "moved as much as possible" is the
    // answer the next decision is made against.
    return mustHelp && charCount(nextText) >= charCount(text) ? { text, archived: [] } : plan
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
export function archiveCandidates(text, { archivePath, excludeId = null, sections }) {
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
 * Remove the chosen entries and leave one aggregate pointer line per affected zone.
 *
 * The aggregate's count is the entries taken now **plus** every parseable pointer
 * the zone already held, so a second archive extends the line rather than stacking
 * one more pointer beside it. Lines that cannot be parsed are left exactly where
 * they are: this is a rendering change to lines the plugin wrote, not a licence to
 * rewrite the zone.
 *
 * Zones are rewritten back to front: an earlier zone edit changes the length of
 * the text every later zone offset was measured against. 进行中 comes before
 * 已完成 in the document even though it is drained second, so "document order"
 * and "drain order" are deliberately two different things here.
 *
 * @param {string} text - the hot file text.
 * @param {object[]} zones - the located zones (document order).
 * @param {object[]} chosen - the candidates to remove.
 * @param {string} archivePath - the archive note's vault-relative path.
 * @returns {string} the next text.
 */
export function applyPointers(text, zones, chosen, archivePath) {
  const byZone = new Map()
  for (const entry of chosen) {
    let indices = byZone.get(entry.zone)
    if (indices === undefined) {
      indices = []
      byZone.set(entry.zone, indices)
    }
    indices.push(entry.index)
  }
  let next = text
  for (const zone of [...zones].sort((left, right) => right.bodyStart - left.bodyStart)) {
    const entryIndices = byZone.get(zone)
    if (entryIndices === undefined) continue
    const lines = zone.body.split('\n')
    const pointers = pointerLinesOf(lines, zone, text, archivePath)
    const removed = new Set([...entryIndices, ...pointers.map((pointer) => pointer.index)])
    const count = entryIndices.length + pointers.reduce((sum, pointer) => sum + pointer.count, 0)
    const insertAt = Math.min(...removed)
    const kept = []
    let before = 0
    for (let index = 0; index < lines.length; index += 1) {
      if (removed.has(index)) continue
      if (index < insertAt) before += 1
      kept.push(lines[index])
    }
    kept.splice(before, 0, archiveLine(count, archivePath))
    next = `${next.slice(0, zone.bodyStart)}${kept.join('\n')}${next.slice(zone.bodyEnd)}`
  }
  return next
}

/**
 * What each zone holds, in the numbers a refusal and a status report both quote.
 *
 * The two counters are independent on purpose. `pointers` counts pointer lines
 * *whatever their shape*, because the aggregate line is not
 * `HOT_ENTRY_PATTERN`-shaped at all — a report that only counted entry-shaped
 * lines would show a zone full of pointers as empty. The aggregate counts as one
 * pointer; `entries` counts the complete non-pointer entries, and `moveable` is
 * those minus the entry this call just added (which is there, but not a candidate
 * for its own archive).
 *
 * @param {string} text - the hot file text.
 * @param {{ archivePath: string, excludeId?: string|null, sections?: readonly string[] }} input - the archive target, the entry just added, and the zones to describe.
 * @returns {object[]} one row per located zone: `{name, chars, entries, pointers, moveable}`.
 */
export function zoneStats(text, { archivePath, excludeId = null, sections = HOT_SECTIONS }) {
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
export function totalEligibility(sections) {
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
export function describeZones(sections) {
  return sections
    .map(
      (zone) =>
        `${zone.name}: ${zone.chars} chars, ${zone.entries} complete entries (${zone.pointers} pointers, ${zone.moveable} moveable)`,
    )
    .join('; ')
}

/**
 * Migrate a zone's pointer lines into one aggregate pointer.
 *
 * This is the upgrade path for a hot file written before the aggregate form: a
 * 已完成 or 进行中 zone may hold one per-entry pointer per archived entry, and the
 * old fold kept every id in a bracket list. The count is the number of archived
 * entries those pointers stand for, so nothing is lost from the report even though
 * the ids leave the injected text. Only ever shrinks, and only lines the plugin can
 * parse: an unterminated line, or a pointer with no stable id, is left untouched.
 *
 * @param {string} text - the hot file text.
 * @param {string} archivePath - the archive note's vault-relative path.
 * @returns {{text: string, removed: number}} the next text and how many pointer lines the fold removed (0 when nothing was).
 */
export function foldPointers(text, archivePath) {
  let next = text
  let removed = 0
  for (const name of COMPACT_SECTIONS) {
    const zone = locateSection(next, name)
    if (zone === null) continue
    const lines = zone.body.split('\n')
    const pointers = pointerLinesOf(lines, zone, next, archivePath)
    if (pointers.length === 0) continue
    const aggregate = archiveLine(
      pointers.reduce((sum, pointer) => sum + pointer.count, 0),
      archivePath,
    )
    const first = pointers[0].index
    const dropped = new Set(pointers.slice(1).map((pointer) => pointer.index))
    const nextLines = []
    for (let index = 0; index < lines.length; index += 1) {
      if (index === first) nextLines.push(aggregate)
      else if (!dropped.has(index)) nextLines.push(lines[index])
    }
    const nextBody = nextLines.join('\n')
    if (charCount(nextBody) >= charCount(zone.body)) continue
    next = `${next.slice(0, zone.bodyStart)}${nextBody}${next.slice(zone.bodyEnd)}`
    removed += pointers.length
  }
  return { text: next, removed }
}
