// @ts-check
// Hard-failure recording policy over the capture whitelist, never raw output.
import { FAILURE_KINDS, HARD_STREAK_THRESHOLD } from './failure-streak.js'

/** Bound auxiliary review work and every evidence list to the distill contract. */
const MAX_RUNS = 16
const MAX_SEQS = 63

/** Keep unknown or unsafe identifiers out of generated note text. */
function toolName(name) {
  return typeof name === 'string' && /^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/u.test(name)
    ? name
    : 'unknown'
}

/**
 * Find repeated hard failures and later same-tool successes in committed evidence.
 * A success is recovery evidence only; it proves neither the diagnosis nor a fix.
 * @param {object[]} events - capture's ordered, whitelisted evidence.
 * @returns {object[]} bounded runs carrying identities and seqs only.
 */
export function hardFailureRuns(events) {
  const active = new Map()
  const runs = []
  for (const event of events) {
    if (event?.kind !== 'tool' || !Number.isSafeInteger(event.seq)) continue
    const name = toolName(event.name)
    const key = `${event.turn ?? '?'}:${name}`
    if (event.ok === false) {
      let run = active.get(key)
      if (!run) {
        run = {
          name,
          turn: event.turn ?? null,
          firstSeq: event.seq,
          lastSeq: event.seq,
          kinds: new Set(),
          failureSeqs: [],
          count: 0,
          recoverySeq: null,
        }
        active.set(key, run)
        if (active.size > 256) active.delete(active.keys().next().value)
      }
      run.count += 1
      run.lastSeq = event.seq
      if (run.failureSeqs.length < MAX_SEQS) run.failureSeqs.push(event.seq)
      if (FAILURE_KINDS.includes(event.failureKind)) run.kinds.add(event.failureKind)
      if (run.count === HARD_STREAK_THRESHOLD) {
        runs.push(run)
        if (runs.length > MAX_RUNS) runs.shift()
      }
    } else if (event.ok === true && event.verified !== false) {
      const run = active.get(key)
      if (run && name !== 'unknown') run.recoverySeq = event.seq
      active.delete(key)
    }
  }
  return runs
}

/**
 * Guard model gotchas and supply a bounded Inbox fallback for an omitted hard run.
 * Existing applyCandidate owns duplicate detection and review; this adds no writer.
 * @param {object[]} items - validated distill candidates.
 * @param {object[]} events - capture evidence, including hard outcomes only.
 * @param {{maxItems: number}} settings - resolved distillation limits.
 * @returns {object[]} candidates through the same pending/receipt/transaction path.
 */
export function finalizeFailureMemory(items, events, settings) {
  const runs = hardFailureRuns(events)
  const covered = new Set()
  const result = items.map((item) => {
    if (item.type !== 'gotcha') return item
    const cited = events.filter((event) => item.evidenceSeqs.includes(event.seq))
    const related = runs.filter((run) =>
      cited.some(
        (event) =>
          event.kind === 'tool' &&
          event.ok === false &&
          toolName(event.name) === run.name &&
          (event.turn ?? null) === run.turn &&
          event.seq >= run.firstSeq &&
          event.seq <= run.lastSeq,
      ),
    )
    if (related.length === 0) return item
    for (const run of related) covered.add(run)
    const recovered = related.every(
      (run) => run.recoverySeq !== null && item.evidenceSeqs.includes(run.recoverySeq),
    )
    const described = item.evidenceSeqs.some((seq) =>
      events.some(
        (event) => event.seq === seq && (event.kind === 'assistant-final' || event.kind === 'user'),
      ),
    )
    const inbox = item.inbox || !recovered || !described
    return {
      ...item,
      assertion: 'inferred',
      status: 'provisional',
      inbox,
      supersedesId: null,
      downgrades: [
        ...item.downgrades,
        'failure-cause-unverified',
        ...(!recovered ? ['failure-unresolved'] : []),
        ...(!described ? ['failure-without-description'] : []),
      ],
    }
  })
  for (const run of runs) {
    if (covered.has(run) || result.length >= settings.maxItems) continue
    const kinds = [...run.kinds].sort().slice(0, 2).join(' ') || 'unknown'
    // Stable wording makes repeat runs dedupe. Session ids, paths and output never
    // enter this note; the receipt retains the run-specific evidence separately.
    result.push({
      type: 'gotcha',
      title: `${run.name} repeated failure: ${kinds}`,
      body: `${run.name} failed repeatedly with category ${kinds}. The cause and remedy remain unverified. Review committed evidence before treating a retry as a fix.`,
      tags: ['dsh-mem/gotcha'],
      confidence: 0.5,
      assertion: 'inferred',
      status: 'provisional',
      supersedesId: null,
      inbox: true,
      evidenceSeqs: [...run.failureSeqs, ...(run.recoverySeq === null ? [] : [run.recoverySeq])],
      downgrades: ['failure-review-required'],
    })
  }
  return result
}
