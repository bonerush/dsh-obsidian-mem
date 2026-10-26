// The pure composition half of the brief: budget, render and footer.
//
// composeBrief turns an ordered list of whole units into the injected text
// under a hard code-point budget. It is a strict prefix of the priority order,
// so a block is either rendered byte-for-byte or left out entirely — a truncated
// link or half a fact can never be injected — and the footer is assembled to a
// fixpoint because the printed count can change the count.
//
// It imports nothing: ./brief.js does every read, verifies the view and hands
// the composed sections here. The only text this module returns is the bytes a
// session is injected with, which is why it can be tested with plain strings.
//
// charCount is deliberately the same one-line rule as ./hot-text.js's: a
// same-layer import is the lateral edge the architecture table refuses, so the
// code-point count is stated here rather than reached for. Both are measured in
// code points, so the brief budget and the hot cap still agree on what a
// character costs.

/**
 * The smallest budget this module will accept. `validateConfig` enforces the same
 * floor, so a plugin the host accepted can always produce a brief.
 */
export const MIN_BRIEF_BUDGET_CHARS = 256

/** Serialized footer text is capped, so a broken note cannot inflate the footer. */
const MAX_FOOTER_FIELD_CHARS = 40

/**
 * A string's length in Unicode code points, not UTF-16 units, so a CJK entry
 * costs one character per character.
 *
 * @param {string} text - the text.
 * @returns {number} the code-point count.
 */
function charCount(text) {
  return [...String(text)].length
}

/**
 * Compose the brief under a hard code-point budget.
 *
 * The pass is a strict prefix of the priority order: blocks are added whole until
 * the next one does not fit, and everything after it is counted as omitted. A
 * block is therefore always rendered byte-for-byte — never cut in the middle of a
 * link or a fact.
 *
 * The footer is part of the budget and reports the real total, so the final text
 * is assembled to a fixpoint (the printed count can change the count). The
 * largest fitting prefix is found by bisection: the assembled size is monotone
 * inside `0..total-1`, and the only discontinuity is at `total`, where the
 * "omitted" notice and footer field disappear.
 *
 * @param {object} input - the composition inputs.
 * @param {object[]} input.sections - the sections, highest priority first.
 * @param {string} input.preamble - the fixed header.
 * @param {string[]} input.extras - plugin notices that are not vault data.
 * @param {number} input.budget - the hard code-point cap.
 * @param {Function} input.footer - `(used, omitted) => string`.
 * @returns {{text: string, charCount: number, omitted: number, truncated: boolean}} the brief text.
 * @throws {RangeError} when the budget cannot even hold the preamble and footer.
 */
export function composeBrief({ sections, preamble, extras, budget, footer }) {
  const total = totalUnits(sections)
  const assemble = (count, notes) =>
    renderBrief({ sections, count, preamble, extras: notes, footer })
  const fits = (count, notes) => assemble(count, notes).charCount <= budget

  if (fits(total, extras)) return assemble(total, extras)

  const bounded = Math.max(0, total - 1)
  let low = 0
  let high = bounded
  let best = -1
  while (low <= high) {
    const middle = (low + high) >> 1
    if (fits(middle, extras)) {
      best = middle
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  if (best >= 0) return assemble(best, extras)

  // Not even an empty unit list fits: the notices were the last thing keeping the
  // floor above the budget, so drop them before refusing anything else.
  for (let keep = extras.length - 1; keep >= 0; keep -= 1) {
    const notes = extras.slice(0, keep)
    if (fits(0, notes)) return assemble(0, notes)
  }
  throw new RangeError(
    `briefBudgetChars (${budget}) is too small for the brief preamble and footer; the minimum useful budget is ${MIN_BRIEF_BUDGET_CHARS}`,
  )
}

/**
 * Render the brief for one prefix length, to a footer fixpoint.
 *
 * @param {object} input - the render inputs.
 * @param {object[]} input.sections - the sections, highest priority first.
 * @param {number} input.count - how many units (in priority order) are included.
 * @param {string} input.preamble - the fixed header.
 * @param {string[]} input.extras - plugin notices that are not vault data.
 * @param {Function} input.footer - `(used, omitted) => string`.
 * @returns {{text: string, charCount: number, omitted: number, truncated: boolean}} the rendered brief.
 */
function renderBrief({ sections, count, preamble, extras, footer }) {
  const included = []
  let seen = 0
  for (const section of sections) {
    const take = Math.max(0, Math.min(section.units.length, count - seen))
    seen += section.units.length
    if (take > 0) included.push({ ...section, units: section.units.slice(0, take) })
  }
  const total = totalUnits(sections)
  const omitted = total - count
  // `truncated` is the machine-readable form of the same fact the prose notice and
  // the footer report: the budget dropped complete units the caller never saw.
  const truncated = omitted > 0
  const notes = [...extras]
  if (truncated) notes.push(`（简报预算已满，省略 ${omitted} 条完整条目。）`)

  const blocks = [preamble, ...included.map(renderSection), ...notes].filter(
    (block) => block !== '',
  )
  const content = blocks.join('\n\n')

  let used = charCount(content)
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const text = `${content}\n\n${footer(used, omitted)}`
    const next = charCount(text)
    if (next === used) return { text, charCount: next, omitted, truncated }
    used = next
  }
  const text = `${content}\n\n${footer(used, omitted)}`
  return { text, charCount: charCount(text), omitted, truncated }
}

/**
 * Render one non-empty section: its heading followed by its quoted lines.
 *
 * A vault-derived line is always a blockquote; the section heading says
 * `（引用数据）`. Nothing in a note is ever re-rendered as a heading or as plain
 * prose, which is what keeps a hostile line from reading as an instruction.
 *
 * @param {object} section - the section.
 * @returns {string} the block.
 */
function renderSection(section) {
  const lines = section.units.map((unit) => (section.quote ? `> ${unit}` : unit))
  return `## ${section.title}\n${lines.join('\n')}`
}

/**
 * Build the footer printer for one brief.
 *
 * @param {object} input - the footer inputs.
 * @param {number} input.budget - the code-point cap.
 * @param {number} input.hotCapacity - the hot layer's stored cap.
 * @param {number} input.hotChars - the hot file's code-point count.
 * @param {string} input.updated - the hot file's revision date.
 * @param {object} input.indexState - the reported index state.
 * @returns {Function} `(used, omitted) => footer`.
 */
export function footerFactory({ budget, hotCapacity, hotChars, updated, indexState }) {
  const state =
    indexState.status === 'ready'
      ? 'index ready'
      : `index not-ready: ${clamp(indexState.reason ?? 'unknown')}`
  const revision = clamp(updated)
  return (used, omitted) => {
    const parts = [
      `${used}/${budget} chars`,
      `hot ${hotChars}/${hotCapacity}`,
      `updated ${revision}`,
      state,
    ]
    if (omitted > 0) parts.push(`omitted ${omitted}`)
    return `<!-- brief: ${parts.join(', ')} -->`
  }
}

/**
 * Truncate a footer field to whole code points.
 *
 * @param {unknown} value - the value.
 * @returns {string} at most {@link MAX_FOOTER_FIELD_CHARS} code points.
 */
export function clamp(value) {
  const text = String(value ?? '')
  const points = [...text]
  return points.length <= MAX_FOOTER_FIELD_CHARS
    ? text
    : points.slice(0, MAX_FOOTER_FIELD_CHARS).join('')
}

/**
 * The number of units in a section list.
 *
 * @param {object[]} sections - the sections.
 * @returns {number} the count.
 */
export function totalUnits(sections) {
  let total = 0
  for (const section of sections) total += section.units.length
  return total
}
