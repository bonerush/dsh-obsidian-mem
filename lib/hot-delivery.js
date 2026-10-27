// Spec §1: the pure half of hot delivery receipts.
//
// Everything here is a decision over values: how a hot entry becomes the one line
// the brief can inject, how that line is versioned, which unit is too large to
// inject at all, which units a composed brief actually emitted, which delivered
// identity a removal notice may withdraw, and the bounded continuation cursor.
// The private persistence (receipts, locks, epochs) lives in delivery-state.js;
// this module imports no repository module at all, so both the brief (L7) and
// the hooks (L8) can point down at it without a lateral edge.
//
// The version rule is the load-bearing one: a version hashes the *complete*
// injectable unit — id, zone, text and source — because "the same id" is not
// "the same thing the model read". A note may be edited in place between two
// briefs; only the bytes the model actually received can be acknowledged.
import { createHash } from 'node:crypto'

/** Schema of a delivery receipt/delivery state written by this pair of modules. */
export const HOT_DELIVERY_SCHEMA = 1
/** The prefix of a bounded hot-continuation cursor. */
export const HOT_CURSOR_PREFIX = 'hd1'
/** The spec's bound on a cursor carried in a tool argument or a brief. */
export const HOT_CURSOR_MAX_CHARS = 256
/** At most two automatic continuations per unchanged hot generation. */
export const MAX_AUTO_CONTINUATIONS = 2
/** The page offset ceiling the brief's paging already enforces. */
const MAX_CURSOR_OFFSET = 10000
/** The project-id half of a cursor; a UUIDv4 is 36 characters. */
const PROJECT_CURSOR_PATTERN = /^[A-Za-z0-9._-]{1,64}$/u
const SOURCE_HASH_PATTERN = /^[0-9a-f]{64}$/u
const OFFSET_PATTERN = /^[0-9]{1,5}$/u

/**
 * The one line a hot entry contributes to the brief.
 *
 * The rendering lives here rather than in brief.js because the delivery version
 * has to hash exactly what the model read: a second renderer would be a second
 * definition of the unit, and a version over a different string would
 * acknowledge a message that was never sent.
 *
 * @param {object} item - one complete hot item ({id, section, text, source}).
 * @returns {string} the navigation line.
 */
export function renderHotUnit(item) {
  const source = item?.source ?? null
  return (
    '- [' + (item?.id ?? '') + '] ' + (item?.text ?? '') + (source === null ? '' : ' — ' + source)
  )
}

/**
 * The code-point cost of one unit, the unit the brief budget is counted in.
 *
 * @param {object} item - one complete hot item.
 * @returns {number} the line's code-point count (no trailing newline).
 */
export function hotUnitCost(item) {
  return [...renderHotUnit(item)].length
}

/**
 * The version of one injectable unit: a hash of every byte the model would read.
 *
 * The zone is included even though the rendered line does not spell it: moving an
 * entry between 强约束 and 进行中 changes the section the model sees it under, so
 * a receipt that hashed only the line would call that delivery unchanged.
 *
 * @param {object} item - one complete hot item.
 * @returns {string} 64 lowercase hex characters.
 */
export function hotUnitVersion(item) {
  const canonical = JSON.stringify([item?.section ?? '', renderHotUnit(item)])
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

/**
 * Normalize complete hot items into the injectable unit records everything else
 * in this module works over.
 *
 * @param {object[]} items - complete hot items, in file order.
 * @returns {{id: string, section: string, text: string, source: string|null, version: string, line: string, cost: number}[]} the units.
 */
export function prepareHotUnits(items) {
  return (Array.isArray(items) ? items : []).map((item) => ({
    id: item.id,
    section: item.section,
    text: item.text,
    source: item.source ?? null,
    version: hotUnitVersion(item),
    line: renderHotUnit(item),
    cost: hotUnitCost(item),
  }))
}

/**
 * Split the hot layer into units this brief can try to inject and units no brief
 * could carry, so one giant entry cannot block the entries after it.
 *
 * A unit is oversized only when its own line plus the brief's minimum scaffold
 * (preamble, identity, headings and footer reserve) exceeds the whole budget: at
 * that point no composition that contains it can fit, and reporting it lets the
 * reader follow its source instead of reading a clipped fact. A unit that merely
 * fails to fit *beside others* is not classified here; the normal prefix cut
 * handles it and counts it as omitted.
 *
 * @param {object[]} units - normalized units from prepareHotUnits.
 * @param {{budget: number, reserveChars: number}} options - the hard budget and the measured non-unit scaffold.
 * @returns {{injectable: object[], oversized: object[]}} the split.
 */
export function splitOversizedHotUnits(units, { budget, reserveChars }) {
  const injectable = []
  const oversized = []
  for (const unit of Array.isArray(units) ? units : []) {
    if (unit.cost + reserveChars > budget) {
      oversized.push({
        id: unit.id,
        version: unit.version,
        section: unit.section,
        source: unit.source,
        chars: unit.cost,
      })
      continue
    }
    injectable.push(unit)
  }
  return { injectable, oversized }
}

/**
 * The units a composed brief actually emitted, derived from its coverage.
 *
 * composeBrief renders a strict prefix of the priority order, so a section's
 * shown count names exactly how many of its units are in the final text. The
 * full brief emits the 强约束 prefix then the 进行中 prefix; a delta emits the
 * changed-items prefix under its own section key. The returned units are the
 * ones a receipt may acknowledge — never the whole hotItems snapshot, which
 * the spec is explicit cannot prove delivery.
 *
 * @param {object} input - the composition facts.
 * @param {'full'|'delta'} input.mode - the brief mode.
 * @param {object[]} [input.injectable] - normalized units for a full brief.
 * @param {object[]} [input.changed] - normalized changed units for a delta.
 * @param {object} input.coverage - the value composeBrief returned.
 * @returns {{emitted: object[], units: object[]}} the emitted unit records.
 */
export function emittedHotUnits({ mode, injectable = [], changed = [], coverage }) {
  const sections = Array.isArray(coverage?.sections) ? coverage.sections : []
  const shownOf = (key) => {
    const section = sections.find((entry) => entry?.key === key)
    const shown = section?.shown
    return Number.isSafeInteger(shown) && shown > 0 ? shown : 0
  }
  if (mode === 'delta') {
    const emitted = changed.slice(0, shownOf('delta'))
    return { emitted, units: emitted }
  }
  const constraints = injectable.filter((unit) => unit.section === '强约束')
  const active = injectable.filter((unit) => unit.section === '进行中')
  const emitted = [
    ...constraints.slice(0, shownOf('hot-constraints')),
    ...active.slice(0, shownOf('hot-active')),
  ]
  return { emitted, units: emitted }
}

/**
 * The delivered identities a removal notice may withdraw.
 *
 * A removal names only ids the session previously had acknowledged and that no
 * longer exist in the current injectable set. It carries the version that was
 * delivered so a later, newer delivery of the same id is never erased by a stale
 * notice (the acknowledgement checks the version before deleting).
 *
 * @param {object} input - the diff inputs.
 * @param {Set<string>} input.currentIds - ids in the current complete hot layer.
 * @param {Map<string, string>} input.acked - acknowledged id → delivered version.
 * @returns {{id: string, previousVersion: string}[]} the removals, id-sorted.
 */
export function removedHotUnits({ currentIds, acked }) {
  const removed = []
  for (const [id, version] of acked instanceof Map ? acked : new Map()) {
    if (!currentIds.has(id)) removed.push({ id, previousVersion: version })
  }
  return removed.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
}

/**
 * The bounded continuation cursor: project, hot source hash and next position.
 *
 * The triple is what makes the handle verifiable rather than opaque. A cursor
 * from another project or another hot generation is refused by the reader
 * instead of being applied to the wrong list.
 *
 * @param {{projectId: string, sourceHash: string, offset: number}} input - the bound position.
 * @returns {string} the cursor, at most HOT_CURSOR_MAX_CHARS characters.
 * @throws {RangeError} when a part cannot be encoded inside the bound.
 */
export function hotCursorFor({ projectId, sourceHash, offset }) {
  if (typeof projectId !== 'string' || !PROJECT_CURSOR_PATTERN.test(projectId)) {
    throw new RangeError('a hot cursor needs a filesystem-safe project id')
  }
  if (typeof sourceHash !== 'string' || !SOURCE_HASH_PATTERN.test(sourceHash)) {
    throw new RangeError('a hot cursor needs the full hot source hash')
  }
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > MAX_CURSOR_OFFSET) {
    const error = new RangeError(
      'a hot cursor offset must be an integer between 0 and ' + MAX_CURSOR_OFFSET,
    )
    error.code = 'invalid-cursor'
    throw error
  }
  const cursor = HOT_CURSOR_PREFIX + ':' + projectId + ':' + sourceHash + ':' + offset
  if (cursor.length > HOT_CURSOR_MAX_CHARS) {
    throw new RangeError('a hot cursor must stay within ' + HOT_CURSOR_MAX_CHARS + ' characters')
  }
  return cursor
}

/**
 * Parse a continuation cursor, refusing anything this module did not write.
 *
 * @param {string} cursor - the model-supplied cursor.
 * @returns {{projectId: string, sourceHash: string, offset: number}} the bound position.
 * @throws {RangeError} with code 'invalid-cursor' when malformed or out of bounds.
 */
export function parseHotCursor(cursor) {
  const invalid = (reason) => {
    const error = new RangeError('invalid hot continuation cursor: ' + reason)
    error.code = 'invalid-cursor'
    return error
  }
  if (typeof cursor !== 'string' || cursor.length === 0) throw invalid('not a string')
  if (cursor.length > HOT_CURSOR_MAX_CHARS) throw invalid('too long')
  const parts = cursor.split(':')
  if (parts.length !== 4) throw invalid('expected hd1:<projectId>:<sourceHash>:<offset>')
  const [prefix, projectId, sourceHash, rawOffset] = parts
  if (prefix !== HOT_CURSOR_PREFIX) throw invalid('unknown prefix ' + JSON.stringify(prefix))
  if (!PROJECT_CURSOR_PATTERN.test(projectId)) throw invalid('project id')
  if (!SOURCE_HASH_PATTERN.test(sourceHash)) throw invalid('source hash')
  if (!OFFSET_PATTERN.test(rawOffset)) throw invalid('offset')
  const offset = Number(rawOffset)
  if (!Number.isSafeInteger(offset) || offset > MAX_CURSOR_OFFSET)
    throw invalid('offset out of bounds')
  return { projectId, sourceHash, offset }
}

/**
 * Should this pre-step prepare another automatic continuation?
 *
 * The allowance is per unchanged hot generation: at most two acknowledged
 * continuations, at most one preparation per user turn. A window whose
 * preparation was never acknowledged is re-prepared on the next turn instead of
 * spending a second allowance, because a lost host insertion is exactly the case
 * the spec says must stay repeatable.
 *
 * @param {object} input - the counters.
 * @param {number} input.candidates - how many units the generation would page through.
 * @param {number} input.offset - how many of them have been emitted so far.
 * @param {number} input.attempts - continuation preparations already made for this generation.
 * @param {number} input.turn - the current user turn.
 * @param {number|null} [input.lastTurn] - the turn that last prepared a continuation.
 * @returns {{available: boolean, offset: number, remaining: number, retry: boolean, reason: string}} the decision.
 */
export function continuationFor({ candidates, offset, attempts, turn, lastTurn = null }) {
  const remaining = Math.max(0, candidates - offset)
  const base = { offset, remaining, retry: attempts > 0 }
  if (remaining === 0) return { available: false, ...base, reason: 'complete' }
  if (attempts >= MAX_AUTO_CONTINUATIONS) return { available: false, ...base, reason: 'exhausted' }
  if (lastTurn !== null && lastTurn === turn)
    return { available: false, ...base, reason: 'same-turn' }
  return { available: true, ...base, reason: attempts > 0 ? 'retry' : 'next-window' }
}

/**
 * Pack one continuation window under a hard budget.
 *
 * Whole units only: a window stops before the first unit that would cross the
 * budget rather than clipping it, exactly like the brief's own composition.
 *
 * @param {object} input - the packing inputs.
 * @param {object[]} input.units - normalized units, in file order.
 * @param {number} input.offset - where the window starts.
 * @param {number} input.budget - the hard code-point cap for the whole message.
 * @param {number} input.overheadChars - the measured preamble/heading/footer cost.
 * @returns {{units: object[], nextOffset: number, lines: string[], charCount: number}} the window.
 */
export function packContinuation({ units, offset, budget, overheadChars }) {
  const list = Array.isArray(units) ? units : []
  const start = Number.isSafeInteger(offset) ? Math.max(0, offset) : 0
  const available = Math.max(0, budget - overheadChars)
  const packed = []
  let used = 0
  for (let index = start; index < list.length; index += 1) {
    const unit = list[index]
    const cost = unit.cost + 1
    if (used + cost > available) break
    packed.push(unit)
    used += cost
  }
  return {
    units: packed,
    nextOffset: start + packed.length,
    lines: packed.map((unit) => unit.line),
    charCount: overheadChars + used,
  }
}
