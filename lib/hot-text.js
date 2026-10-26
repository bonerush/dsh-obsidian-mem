// The hot file's shared, import-free text layer.
//
// _meta/hot.md is parsed and rendered by three readers: the write path
// (./hot.js, L6), the archive planner (./hot-archive.js, L1) and the brief
// (./brief.js, L7). The constants and predicates here are the format itself —
// the three zone names, the entry pattern, the pointer shape, and the rules that
// decide when a line is an entry this plugin may move, inject or fold. Keeping
// them in one module is what makes those three readers agree by construction
// rather than by three copies of a regex that could drift apart.
//
// It imports nothing, from this repository or the platform: the format is a
// contract, and a layer that can pull in a vault reader is a layer that can
// drift. Everything here is a pure function of its arguments.

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
 * The text of an entry line, without its stable id.
 *
 * @param {string} line - an entry line.
 * @returns {string} the payload.
 */
export function entryPayload(line) {
  const marker = String(line).indexOf('] ')
  return marker === -1 ? String(line) : String(line).slice(marker + 2)
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
export function isTerminated(index, lines, zone, text) {
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
export function pointerLine(entryIds, archivePath) {
  const ids = Array.isArray(entryIds) ? entryIds : [entryIds]
  return `- [${ids.join(', ')}] ${ARCHIVED_PREFIX} → ${archiveLink(archivePath)}|${ARCHIVE_TITLE}]]`
}

/**
 * The wikilink an archive pointer carries, without its closing brackets.
 *
 * @param {string} archivePath - the archive note's vault-relative path.
 * @returns {string} the link opener.
 */
export function archiveLink(archivePath) {
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
export function entryIdOf(line) {
  const match = /^- \[(hot-[^\]]+)\] /.exec(String(line))
  return match === null ? null : match[1]
}

/**
 * Every entry id a text already carries.
 *
 * @param {string} text - a note or zone text.
 * @returns {string[]} the ids, in file order.
 */
export function archiveEntryIds(text) {
  const ids = []
  for (const line of String(text).split('\n')) {
    const id = entryIdOf(line)
    if (id !== null) ids.push(id)
  }
  return ids
}
