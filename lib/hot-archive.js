// The hot file's archive planner, one layer above its text format.
//
// planArchive is the decision the hot layer rules describe: take the smallest
// prefix of complete 已完成 entries that brings the file back under its trigger,
// replace each with its pointer line, and never touch a hand-written line, a
// fragment or a pointer. foldPointers is the first step of the explicit compact,
// and zoneStats / totalEligibility / describeZones are the numbers a refusal and
// a status report both quote.
//
// It imports ./hot-text.js and nothing else. There is no I/O here and no
// knowledge of a binding, a transaction or a receipt: ./hot.js composes those
// around it, which is what lets the planner be reviewed as a pure function of
// the bytes it is given.
import {
  ARCHIVE_SECTION,
  COMPACT_SECTIONS,
  HOT_ENTRY_PATTERN,
  HOT_SECTIONS,
  charCount,
  entryIdOf,
  isPointerLine,
  isTerminated,
  locateSection,
  pointerLine,
} from './hot-text.js'

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
export function applyPointers(text, zones, chosen, archivePath) {
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
export function foldPointers(text, archivePath) {
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
