// The unbound-session notice: what a session is told when its project has no
// usable memory, and what to do about it.
//
// The plugin used to answer every "there is no pointer here" with nothing at all.
// `planInjection` returned `null`, the `brief` diagnostic recorded `none`, and the
// session proceeded exactly as if the plugin were not installed. Two measured
// consequences, both reported against this build:
//
//   * **Initialization was undiscoverable.** A repository with no `.obsidian-mem`
//     gets no brief, so no model ever learns that binding it was an option; the
//     only path that ever created a pointer was a write (`mem_admin` with
//     `mode:"local"`, or the implicit first-write bind), and a user who never
//     writes learns nothing. CodeGraph closes the same hole by returning "not
//     initialized" from a tool call and printing the follow-up question in its
//     agent instructions; this module is that half, one hint per session.
//   * **A missing directory was invisible.** DSH keeps `header.cwd` for the life
//     of a session, and an imported conversation carries the directory it was
//     recorded in — possibly another machine's, possibly renamed since. Until
//     `resolveBinding` grew the `cwd-missing` refusal, that case threw `ENOENT`
//     into the pre-step's blanket catch: no brief, no recall, one host log line,
//     retried every step. The session looked like a project with no memory.
//
// The text is static and never read from the vault: the only dynamic part is the
// path, which is quoted and sanitized. The decision (is this reason worth a hint,
// has this session been told already, does it fit the budget) belongs to the
// caller; this module owns the vocabulary and the wording.
//
// Adding a reason here is a deliberate act: the hint is injected into a model
// context, so a reason that is self-explanatory (the working directory is inside
// the vault) or not actionable by the user (a lost pointer race) stays silent.

/** The path a hint quotes is clamped: a hint is one short message, not a report. */
const MAX_PATH_CHARS = 200

/**
 * The refusal reasons whose answer is "this project could be enabled, ask the user".
 *
 * Each one has its own wording below, because the question is different: a
 * pointerless repository is a choice, a non-git directory is an offer, and a
 * directory that is no longer there is a fact plus a recovery.
 */
const ENABLE_REASONS = Object.freeze(['no-pointer', 'cwd-missing', 'no-git-root'])

/**
 * The refusal reasons that mean "a pointer exists and cannot be trusted".
 *
 * One wording covers them: the answer is the same for all five — report it, never
 * repair it — and the reason itself is quoted back so the user can look it up.
 */
const POINTER_REASONS = Object.freeze([
  'pointer-corrupt',
  'pointer-unsupported-schema',
  'pointer-unreadable',
  'pointer-not-a-file',
  'pointer-oversize',
])

/**
 * The refusal reasons worth one injected hint.
 *
 * Everything else — `vault`, `vault-cloud-managed`, a lost `pointer-race`, a
 * registry conflict — either explains itself or is already surfaced by the tool
 * that hit it, so it stays silent here.
 *
 * Derived from the two category lists rather than written a second time: the
 * wording is chosen by category, so a reason that is in the list and in no category
 * cannot exist — which is the hole the first draft had, where the pointer wording
 * was a fallback any listed reason would borrow. `test/init-hint.test.js` asserts
 * that the two categories do not overlap and that every member produces text.
 */
export const BIND_HINT_REASONS = Object.freeze([...ENABLE_REASONS, ...POINTER_REASONS])

/**
 * A path safe to place inside one injected line.
 *
 * The path is the only dynamic part of every hint, and it reaches the model, so a
 * newline (which would start a line that reads as a fresh instruction), a control
 * character or a backtick (which would end the quoted span) is removed rather
 * than escaped — a directory with those characters is not worth a second syntax
 * to describe.
 *
 * @param {unknown} value - the candidate path.
 * @returns {string} the clamped, single-line path.
 */
function quotePath(value) {
  const text = typeof value === 'string' ? value : ''
  const cleaned = text
    // eslint-disable-next-line no-control-regex -- stripping the control characters that would break the one-line frame
    .replace(/[\u0000-\u001f\u007f`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (cleaned === '') return '(未记录)'
  const points = [...cleaned]
  return points.length <= MAX_PATH_CHARS
    ? cleaned
    : `${points.slice(0, MAX_PATH_CHARS - 1).join('')}…`
}

/** The three sentences every hint shares: what happened, and who decides. */
const NO_MEMORY_TAIL =
  '本次会话没有项目记忆可注入，mem_search 也无法解析到项目。这件事请如实告诉用户，不要假装有记忆。'

/**
 * The hint for one refusal, or `null` when this reason gets none.
 *
 * @param {object|null} resolution - what `resolveBinding` answered.
 * @returns {string|null} one short message, or `null` to stay silent.
 */
export function bindHintText(resolution) {
  if (resolution === null || typeof resolution !== 'object') return null
  const reason = typeof resolution.reason === 'string' ? resolution.reason : ''
  if (!BIND_HINT_REASONS.includes(reason)) return null

  if (reason === 'cwd-missing') {
    return (
      `obsidian-mem：本会话记录的目录 \`${quotePath(resolution.cwd)}\` 已不存在或不再是一个目录（导入的历史会话常带着旧机器、旧名字的路径）。` +
      `${NO_MEMORY_TAIL}\n` +
      '恢复方法：让用户在现在存在的那个项目目录里新开一个会话；不要尝试创建该目录，也不要改写任何指针。'
    )
  }
  if (reason === 'no-pointer') {
    return (
      `obsidian-mem：仓库 \`${quotePath(resolution.repoRoot ?? resolution.cwd)}\` 还没有记忆指针（.obsidian-mem），` +
      `${NO_MEMORY_TAIL}\n` +
      '把这个选择交给用户，按用户的选择行动，在用户表态前不要调用 bind、也不要写任何文件：\n' +
      '1. 现在启用：调用 mem_admin(action="bind", mode="local")，插件会创建指针并初始化 vault 骨架；\n' +
      '2. 暂不启用：什么都不写，本次会话按没有记忆继续（下次会话仍会再问一次）。'
    )
  }
  if (reason === 'no-git-root') {
    return (
      `obsidian-mem：\`${quotePath(resolution.cwd)}\` 不在 git 仓库里，因此默认不进入长期记忆，` +
      `${NO_MEMORY_TAIL}\n` +
      '问用户是否要为这个目录单独建一个项目（非 git 目录也支持），在用户表态前不要调用 bind：\n' +
      '1. 需要：调用 mem_admin(action="bind", mode="local")，指针会写在该目录自己身上；\n' +
      '2. 暂不启用：什么都不做，之后本次会话不再提这件事。'
    )
  }
  // The pointer codes, gated on the list rather than used as a fallback: a reason
  // added to the allowlist without its own wording must answer `null` (and fail the
  // test that every member produces text), not borrow this one.
  if (!POINTER_REASONS.includes(reason)) return null
  return (
    `obsidian-mem：仓库根目录的 .obsidian-mem 指针无法读取（${reason}），插件不会猜测、修复或覆盖它，` +
    `${NO_MEMORY_TAIL}\n` +
    '请让用户自行处理：检查该文件（必要时从 git 恢复），然后重开会话；不要在用户确认前删除或重写它。'
  )
}

/**
 * The same notice in one line, for a session whose budget cannot carry the full one.
 *
 * Three of the worded notices are 176–270 code points, and `briefBudgetChars` goes
 * down to 256 — so at the smallest accepted budget the one message whose whole job
 * is to ask the user a question was the message that did not fit, and
 * `state.bindHintChecked` made that silence final for the session. Each reason
 * therefore has a form that survives any budget above the floor: the event, the
 * decision, and the one call that answers it, with the path and the explanatory
 * tail dropped. `lib/hooks.js` tries the full text first, exactly as its
 * index-unavailable notice does, so a normal session still gets the wording above.
 *
 * The compact forms deliberately keep the plugin label and the `mem_admin` call:
 * without the label the message is indistinguishable from a user turn, and without
 * the call the model is told to ask a question it cannot act on.
 *
 * @param {object|null} resolution - what `resolveBinding` answered.
 * @returns {string|null} one bounded line, or `null` when this reason gets no notice.
 */
export function bindHintCompactText(resolution) {
  if (resolution === null || typeof resolution !== 'object') return null
  const reason = typeof resolution.reason === 'string' ? resolution.reason : ''
  if (!BIND_HINT_REASONS.includes(reason)) return null

  if (reason === 'cwd-missing') {
    return 'obsidian-mem：本会话记录的目录已不存在，本次没有项目记忆。请告诉用户在现存的项目目录新开会话；不要创建该目录或改写指针。'
  }
  if (reason === 'no-pointer') {
    return 'obsidian-mem：本仓库没有记忆指针，本次没有项目记忆。问用户是否启用；若同意再调用 mem_admin(action="bind", mode="local")。'
  }
  if (reason === 'no-git-root') {
    return 'obsidian-mem：本目录不在 git 仓库里，默认不进入长期记忆。问用户是否单独建项目；若同意再调用 mem_admin(action="bind", mode="local")。'
  }
  if (!POINTER_REASONS.includes(reason)) return null
  return `obsidian-mem：记忆指针无法读取（${reason}），本次没有项目记忆。请用户检查或从 git 恢复，不要删除或重写它。`
}

/**
 * The notice for one refusal: the full wording, else the one that fits, else nothing.
 *
 * Both harnesses go through here — DSH's pre-step with `briefBudgetChars`, the Codex
 * hook with the same config field — so "the message that asks the user a question must
 * not be the one the budget drops" is one decision rather than two copies that could
 * drift. The order mirrors `lib/hooks.js`'s index-unavailable notice: the detailed form
 * when it fits, the one-line form when only that fits, and silence when not even that
 * does.
 *
 * @param {object|null} resolution - what `resolveBinding` answered.
 * @param {number} [budget] - the ceiling in Unicode code points; unbounded when absent.
 * @returns {string|null} the message to send, or `null` to stay silent.
 */
export function bindHintWithin(resolution, budget = Number.POSITIVE_INFINITY) {
  const limit = Number.isSafeInteger(budget) && budget > 0 ? budget : Number.POSITIVE_INFINITY
  const detailed = bindHintText(resolution)
  if (detailed !== null && [...detailed].length <= limit) return detailed
  const compact = bindHintCompactText(resolution)
  return compact !== null && [...compact].length <= limit ? compact : null
}
