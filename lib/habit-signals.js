// @ts-check
// User-habit signal extraction: what the USER said, never what the agent did.
//
// ---------------------------------------------------------------------------
// The measurement that shaped this file
// ---------------------------------------------------------------------------
//
// The first version of this feature read TOOL CALLS — bash command names, file
// extensions, adjacent tool sequences — and counted them as evidence of how the
// user works. Replaying 137 real session logs (40 root sessions, 107 usable
// turns, 178 real user messages) falsified it (`docs/habit-learning-results.md`):
//
//   * 99.0% of tool choices were never requested by the user — 291 of 294. The
//     agent ran `grep` 78 times with the user naming it 0 times, `git` 63 times
//     with 0 mentions, `python3` 27 times with 0. The `rg` and `pnpm` binaries
//     ARE installed on this machine and were used 2 and 4 times against grep's
//     2012 and npm's 303, so those are real choices — the AGENT's real choices.
//   * 205 of 341 such signals appeared in exactly one project, i.e. they are
//     project properties rather than anything about the person.
//   * `promoteAfter=3` produced 149 candidates from 107 turns — more candidates
//     than turns. The top ones were `bash→run_code` (72) and `run_code→bash`
//     (70): a description of this plugin's own toolchain, identical for every
//     user, and therefore worth nothing as a preference.
//
// Counting the agent's defaults yields notes like 「习惯：使用 bash 和 run_code」,
// and it does so while looking successful — 149 candidates is a *plausible*
// number. That is exactly the failure mode the prior-art survey warned about
// (TraceRetain: pollution is invisible on clean inputs).
//
// ---------------------------------------------------------------------------
// The rule this module enforces
// ---------------------------------------------------------------------------
//
// The input is a USER MESSAGE and nothing else. There is deliberately no
// parameter through which events, tool names or arguments could arrive: the
// original mistake is excluded by the signature, not by a comment. A future
// change that wants tool data back has to widen this signature on purpose.
//
// The vocabulary is CLOSED and KNOWN INCOMPLETE. Four of the twelve markers
// measured in the calibration hit zero times, so an unrecognised message
// contributes NOTHING rather than a fallback label — the same honesty
// `failure-streak.js` applies when an unrecognised result body contributes
// `unknown` rather than a guess. The cost is a recall ceiling that no amount of
// tuning removes: a user who phrases a preference differently is not learned.
// That is the accepted price of never inventing a preference.
//
// A leaf: no repository import and no `node:` import, so `hooks` and `capture`
// point down at it the way they do at `failure-streak` and `note-style`.

/**
 * One vocabulary entry: a label that may be stored, and what it matches.
 *
 * `pattern` is matched against the message with `test`, so it must be a plain
 * `RegExp` with no `g` flag (a stateful `lastIndex` would make the result depend
 * on how many times the pattern had been used). The test file asserts this.
 *
 * @typedef {{label: string, pattern: RegExp}} Marker
 */

/** The longest label this module will store or accept from configuration. */
export const MAX_LABEL_CHARS = 32

/**
 * How many characters of a message are scanned, counted over BOTH ends.
 *
 * A user can paste a whole file into a turn. Scanning is linear and every
 * pattern matches literal text, so the cost is a few passes over the slice; the
 * bound exists so one pathological paste cannot make the scan the slowest part
 * of a turn.
 *
 * The slice is the FIRST and the LAST `MAX_SCAN_CHARS / 2` characters rather
 * than one prefix. A preference can be stated either side of a long paste —
 * 「以下是我之前的记录……总之以后改动完就提交」 puts it at the end — and a
 * prefix-only scan would silently miss it. This is the same head-and-tail choice
 * `failure-streak.js` makes for its result scan, and for the same reason: a real
 * signature sits at one end, not in the middle.
 */
export const MAX_SCAN_CHARS = 8000

/**
 * The closed vocabulary, drawn from what actually recurred in the calibration.
 *
 * Each label's session count over the 44 root sessions carrying real user
 * messages is recorded beside it, because the vocabulary should be argued for
 * with the measurement rather than with intuition. Entries that hit zero times
 * were removed rather than kept as speculation.
 *
 * The three entries the vault's own `Methods/` habits correspond to are marked
 * `[verified]`: those habits were written and confirmed by the user, so a
 * vocabulary that recognises them has external validity rather than only a
 * plausible shape. That cross-check is the strongest evidence this file has.
 *
 * @type {ReadonlyArray<Marker>}
 */
export const BUILTIN_MARKERS = Object.freeze([
  // [verified] 18 sessions / 3 projects. The vault habit 「重大改动必须提交，
  // 小改动勤提交」 corresponds to this one.
  Object.freeze({ label: '提交', pattern: /提交|commit|不要留在工作区/ }),
  // [verified] 9 sessions / 2 projects, and 10 sessions for the spec-and-plan
  // phrasing. The vault habits 「任务工作流优先参考 superpowers」 and 「产出文档按
  // superpowers 形态与规格书写」 correspond to these.
  Object.freeze({ label: 'superpowers', pattern: /superpowers/i }),
  Object.freeze({ label: '规格与计划', pattern: /规格|计划书|\bspec\b|\bplan\b/i }),
  // 5 sessions / 4 projects — the broadest reach of any entry.
  Object.freeze({ label: '解释原因', pattern: /为什么|原因|解释/ }),
  // 3 sessions / 2 projects.
  Object.freeze({ label: '中文回答', pattern: /中文|用中文/ }),
  // 3 sessions / 1 project.
  Object.freeze({ label: '简洁', pattern: /简洁|简短|精简|别啰嗦/ }),
  // 2 sessions. Below the recurrence bar the calibration used to PROMOTE, but
  // kept in the vocabulary because recognising is not promoting: a marker only
  // contributes a count, and a count below `promoteAfter` never becomes a note.
  Object.freeze({ label: '先调研', pattern: /先调研|先去调研|调研一下|research first/ }),
  Object.freeze({ label: '先写测试', pattern: /先写测试|契约测试|测试先行|test first/i }),
])

/**
 * Whether a candidate marker is usable: a bounded label and a state-free RegExp.
 *
 * Configuration can add markers, and a malformed one must be skipped rather than
 * allowed to break the whole pass — a user editing their config should lose the
 * one entry they mistyped, not every preference they have.
 *
 * @param {unknown} marker - the candidate entry.
 * @returns {boolean} whether it may be used.
 */
function isUsableMarker(marker) {
  if (marker === null || typeof marker !== 'object') return false
  const { label, pattern } = /** @type {Marker} */ (marker)
  if (typeof label !== 'string') return false
  if (label.length === 0 || label.length > MAX_LABEL_CHARS) return false
  // A label is stored in the private state file and rendered into a note title.
  // Whitespace would make it unreadable there, and a path separator would make it
  // look like one.
  if (/\s/.test(label) || label.includes('/') || label.includes('\\')) return false
  if (!(pattern instanceof RegExp)) return false
  // A `g` or `y` flag carries `lastIndex` between calls, so the same message could
  // match or not depending on what was scanned before it.
  if (pattern.global || pattern.sticky) return false
  return true
}

/**
 * The bounded slice a message is scanned over: its head and its tail.
 *
 * A message shorter than the bound is returned whole. A longer one contributes
 * its first and last halves joined by a newline, so a pattern cannot match across
 * the join by accident.
 *
 * @param {string} text - the message.
 * @returns {string} the text to scan.
 */
function scanSlice(text) {
  if (text.length <= MAX_SCAN_CHARS) return text
  const half = Math.floor(MAX_SCAN_CHARS / 2)
  return `${text.slice(0, half)}\n${text.slice(text.length - half)}`
}

/**
 * The labels one user message states, in vocabulary order.
 *
 * @param {unknown} text - the user's message. Anything that is not a string
 *   yields no labels: this function answers rather than throws, because it runs
 *   inside a capture pass whose failure would cost the turn.
 * @param {ReadonlyArray<Marker>} [extraMarkers] - configuration-supplied entries,
 *   appended to the built-in vocabulary. Malformed entries are skipped.
 * @returns {string[]} the distinct labels, never empty strings, never message text.
 */
export function labelsFromUserText(text, extraMarkers = []) {
  if (typeof text !== 'string' || text === '') return []
  const slice = scanSlice(text)
  const labels = []
  const seen = new Set()
  const candidates = Array.isArray(extraMarkers)
    ? [...BUILTIN_MARKERS, ...extraMarkers]
    : BUILTIN_MARKERS
  for (const marker of candidates) {
    if (!isUsableMarker(marker)) continue
    const { label, pattern } = /** @type {Marker} */ (marker)
    if (seen.has(label)) continue
    if (!pattern.test(slice)) continue
    seen.add(label)
    labels.push(label)
  }
  return labels
}
