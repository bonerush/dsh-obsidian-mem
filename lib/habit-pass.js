// @ts-check
// The habit pass: counting on a completed turn, and the decay sweep.
//
// ---------------------------------------------------------------------------
// What this module is
// ---------------------------------------------------------------------------
//
// The only piece of the habit feature that touches the vault. It composes three
// things that are each testable alone — `habit-signals` (the vocabulary),
// `habit-state` (the counters and the decay clock) and `habit-learning` (when an
// observation becomes a candidate) — with the memory layer's real writer.
//
// It sits above `memory` (L5) because composing a writer is what it does, and it is
// driven from the hooks seam rather than from `capture`: `capture` owns the
// distillation queue, whose 90-second debounce and coalescing exist for a MODEL call,
// while a counter has neither. Two independent passes over the same turn-end event
// keep each one's failure from reaching the other.
//
// ---------------------------------------------------------------------------
// The three properties every case here protects
// ---------------------------------------------------------------------------
//
// 1. ATTRIBUTION. A turn with no real user message contributes nothing. This is the
//    regression test for the mistake that falsified v1: it counted tool calls, and
//    99.0% of what it counted (291 of 294) was the agent's own choice, so it learned
//    this plugin's defaults rather than the person's habits.
//
// 2. NEVER STATED. A promoted candidate is `assertion: observed` and `status:
//    provisional`. The automatic path may record what it saw; it may never claim the
//    user said it. `stated` belongs to the pipeline that holds the user's own words,
//    and `habit-state` exempts it from decay accordingly. `provisional` is what the
//    brief quarantines, so a candidate cannot influence an answer before a human
//    confirms it.
//
// 3. NO TRANSCRIPT. Both the private state file and the note are readable by anyone
//    with access to the vault, so neither may carry what the user typed. The state
//    holds vocabulary labels and counters; the note holds a count and an instruction.
//    The user's sentence stays in the session log, where it already was.
import { noteIdFor } from './routing.js'
import { createMemoryWithId, readNoteById, writeMemory } from './memory.js'
import {
  foldObservations,
  habitTitle,
  labelsFromTurnEvents,
  recordPromotion,
} from './habit-learning.js'
import { decayScore, nextStatus, readHabitState, writeHabitState } from './habit-state.js'
import { recordDiagnostic } from './debug.js'
import { vaultIdentity } from './receipts.js'

/** The status a note holds before a human confirms it. Quarantined by `brief`. */
const CANDIDATE_STATUS = 'provisional'

/**
 * The body of a promoted candidate.
 *
 * It states the observation, the count that earned it, and the two ways to settle
 * it. It deliberately contains NO message text: the label is a vocabulary entry and
 * the count is a number, so this text is the same for every user who states the same
 * preference. That is what keeps the note from becoming a transcript.
 *
 * @param {string} label - the vocabulary label.
 * @param {number} sessions - how many distinct sessions stated it.
 * @returns {string} the note body.
 */
function candidateBody(label, sessions) {
  return [
    `插件在 ${sessions} 个不同会话里观察到这条偏好，因此写为候选。`,
    '',
    '它尚未得到确认，所以不会进入会话简报。',
    '确认时把 status 改为 active；不再适用时改为 archived。',
    '',
    '这条候选由插件计数得出，不是用户的原话。原话留在会话日志里。',
  ].join('\n')
}

/**
 * Create the habit pass for one plugin instance.
 *
 * @param {{ dataRoot?: string, config?: object, home?: string, now?: () => Date, diagnostics?: object }} [options] - wiring.
 *   `dataRoot` is the plugin data root; `now` returns the clock, so a test can freeze it.
 * @returns {{recordTurn: Function, decay: Function}} the two entry points.
 */
export function createHabitPass({ dataRoot, config, home, now, diagnostics } = {}) {
  const settings = config?.habitLearning ?? {}
  const clock = typeof now === 'function' ? now : () => new Date()
  const deps = { dataRoot, home, now: clock() }

  /**
   * Count what one completed turn's USER messages stated, and promote at the bar.
   *
   * @param {{binding: object, sessionId: string, events: unknown[]}} input - the turn.
   * @returns {Promise<{vaultHash: string|null, promoted: string[]}>} the labels promoted.
   */
  async function recordTurn({ binding, sessionId, events } = {}) {
    const none = { vaultHash: null, promoted: [] }
    if (settings.enabled === false) return none
    if (binding === null || typeof binding !== 'object') return none
    let identity
    try {
      identity = await vaultIdentity(binding, { home })
    } catch {
      recordDiagnostic(diagnostics, 'capture', { outcome: 'habit-not-bound' })
      return none
    }
    const labels = labelsFromTurnEvents(events, settings.markers)
    if (labels.length === 0) return { vaultHash: identity.vaultHash, promoted: [] }
    const before = await readHabitState(dataRoot, identity.vaultHash, identity.projectId)
    const folded = foldObservations(before, {
      labels,
      sessionId,
      today: clock().toISOString().slice(0, 10),
      enabled: settings.enabled !== false,
      promoteAfter: settings.promoteAfter,
    })
    let state = folded.state
    const promoted = []
    for (const promotion of folded.promotions) {
      try {
        const written = await createMemoryWithId(
          binding,
          {
            // The identity is minted here and NOT persisted before the write, which is
            // safe because the idempotency key is what a retry replays: a crash between
            // the note and the counter regenerates an id, `createMemoryWithId` finds the
            // successful receipt under the same key and returns the ORIGINAL identity,
            // and no second note is created.
            preassignedId: noteIdFor('convention'),
            idempotencyKey: `habit:${identity.projectId}:${promotion.label}`,
            type: 'convention',
            title: promotion.title,
            body: candidateBody(promotion.label, promotion.sessions),
            // The project tag is added here rather than in the policy: only this layer
            // holds the binding, and a note without it is one the project search cannot
            // find.
            tags: [...promotion.tags, `project/${binding.slug}`],
            confidence: promotion.confidence,
            assertion: promotion.assertion,
            status: promotion.status,
            session: sessionId,
          },
          deps,
        )
        state = recordPromotion(state, promotion.label, written.id)
        promoted.push(promotion.label)
      } catch {
        // A refused candidate must not strand the counters: the other labels in this
        // turn still deserve their count, and the receipt under this key makes the
        // next pass a replay rather than a duplicate.
        recordDiagnostic(diagnostics, 'capture', { outcome: 'habit-promote-failed' })
      }
    }
    await writeHabitState(dataRoot, identity.vaultHash, identity.projectId, state)
    return { vaultHash: identity.vaultHash, promoted }
  }

  /**
   * Sweep one project's candidates: decay each clock and move the ones that fell.
   *
   * The decay is idempotent — `habit-state` anchors on the latest of created,
   * reinforced and last-decayed — so running this on every session start charges the
   * elapsed time exactly once. An `archived` note is never deleted: the status is the
   * whole effect, and the file keeps every byte it had.
   *
   * @param {{binding: object}} input - the project to sweep.
   * @returns {Promise<{vaultHash: string|null, archived: string[], demoted: string[]}>} what moved.
   */
  async function decay({ binding } = {}) {
    const none = { vaultHash: null, archived: [], demoted: [] }
    if (binding === null || typeof binding !== 'object') return none
    let identity
    try {
      identity = await vaultIdentity(binding, { home })
    } catch {
      return none
    }
    const state = await readHabitState(dataRoot, identity.vaultHash, identity.projectId)
    const today = clock()
    const archived = []
    const demoted = []
    let changed = false
    for (const [label, record] of Object.entries(state.records)) {
      const noteId = record.noteId
      if (typeof noteId !== 'string' || noteId === '') continue
      // A habit the user stated is never demoted: its evidence is that they said so,
      // and their silence is not counter-evidence. The assertion lives on the note.
      const found = await readNoteById(binding, noteId, { dataRoot, home }).catch(() => null)
      if (found === null) continue
      const data = found.frontmatter ?? {}
      const score = decayScore({
        score: typeof record.score === 'number' ? record.score : 1,
        createdAt: record.firstSeen,
        lastReinforcedAt: record.lastReinforcedAt,
        lastDecayedAt: record.lastDecayedAt,
        today,
        halfLifeDays: settings.halfLifeDays,
      })
      const status = nextStatus({ status: data.status, assertion: data.assertion, score })
      record.score = score
      record.lastDecayedAt = today.toISOString()
      if (typeof data.status === 'string') {
        // `habit-state` owns these two lines; reading them back off the note is what
        // makes the note the source of truth for its own lifecycle.
        record.status = data.status
      }
      changed = true
      if (status === data.status) continue
      try {
        await writeMemory(binding, { id: noteId, status }, { dataRoot, home, now: today })
        if (status === 'archived') archived.push(habitTitle(label))
        else demoted.push(habitTitle(label))
      } catch {
        recordDiagnostic(diagnostics, 'capture', { outcome: 'habit-decay-failed' })
      }
    }
    if (changed) await writeHabitState(dataRoot, identity.vaultHash, identity.projectId, state)
    return { vaultHash: identity.vaultHash, archived, demoted }
  }

  return { recordTurn, decay }
}

// Re-exported so the hooks assembly has one import for the pair it wires.
export { CANDIDATE_STATUS }
