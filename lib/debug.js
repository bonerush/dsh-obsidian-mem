// The bounded diagnostics channel: decisions in, content never.
//
// The plugin used to have exactly one observability tool — nine `warn` call
// sites in `hooks.js` — which meant that when capture skipped a turn, distillation
// produced nothing, or a queue job was refused, the only way to find out was to
// read the code and reproduce it. This module records *what was decided* in a
// fixed-size ring that `mem_admin(action="diagnostics")` can hand back.
//
// Three properties are load-bearing and each is tested rather than asserted:
//
//   * **A fixed allowlist, checked at the boundary.** Names and field names are
//     both closed sets, and values are validated by shape. A field that is not on
//     the list — a note body, a prompt, a path — is dropped before it can be
//     stored. The privacy test feeds a sentinel body through a real call site and
//     requires it to be absent from the serialised snapshot, so a future "just one
//     more field, it will help debugging" change fails a test instead of shipping.
//   * **It never throws.** Diagnostics are called from capture, injection and
//     worker paths where the pre-existing behaviour is fail-open. A record must
//     not be able to change an outcome, so `event` swallows anything — a broken
//     clock, a logger that throws, a getter that blows up.
//   * **Silent unless asked.** Emission to `ctx.logger` happens only when
//     `DSH_OBSIDIAN_MEM_DEBUG=1`. The level is `info` rather than `debug` on
//     measurement: the host's only exporter uses `levels: { default: 2 }` and skips
//     anything whose level is greater than the threshold, so `debug` (3) is
//     dropped while `info` (1) is not. Whether a host shows it is still the
//     host's decision — this only stops the plugin from asking for a channel that
//     is known to be closed.

/**
 * The event categories. A name outside this set is not recorded at all.
 *
 * Exported because the *other* closed set lives in `lib/tool-schema.js`: the
 * diagnostics output schema pins the same names in its `enum` and the same field
 * names as its properties, and a name recorded here but absent there makes
 * `mem_admin(action="diagnostics")` fail its own output validation. That is
 * exactly what happened when `recall` was added — the ring accepted the event and
 * the tool refused to return it — so the two sets are held equal by a test now.
 */
export const EVENT_NAMES = Object.freeze([
  'capture',
  'distill',
  'index',
  'bind',
  'job',
  'transaction',
  'brief',
  'skill',
  // `recall` exists because the per-turn map was invisible: `brief` is recorded
  // whenever the brief is injected, whatever the map did, so "did recall fire?"
  // had no answer in this ring at all.
  'recall',
  // `curation`: one bounded pass, and whether it ran at all (Task 5). The same
  // shape of gap as `recall` — an automatic trigger that can be skipped by a due
  // marker or a config switch with no record of which one happened.
  'curation',
])

/** The same set, for the one lookup on the recording path. */
const EVENT_SET = new Set(EVENT_NAMES)

/** A short lowercase token: outcomes and error codes. */
const TOKEN = /^[a-z][a-z0-9-]*$/
/** An identifier: UUIDs, transaction ids, queue job ids. */
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9:._-]*$/

/** How each allowed field is validated, and how long it may be. */
const FIELDS = Object.freeze({
  projectId: (value) => typeof value === 'string' && value.length <= 80 && IDENTIFIER.test(value),
  txId: (value) => typeof value === 'string' && value.length <= 80 && IDENTIFIER.test(value),
  jobId: (value) => typeof value === 'string' && value.length <= 80 && IDENTIFIER.test(value),
  outcome: (value) => typeof value === 'string' && value.length <= 40 && TOKEN.test(value),
  code: (value) => typeof value === 'string' && value.length <= 60 && TOKEN.test(value),
  attempts: (value) => Number.isInteger(value) && value >= 0,
  ms: (value) => Number.isInteger(value) && value >= 0,
  // Counts only: how many hits the search returned, and how much the map spent.
  hits: (value) => Number.isInteger(value) && value >= 0,
  chars: (value) => Number.isInteger(value) && value >= 0,
})

/**
 * The field names an event may carry, for the output schema's own allowlist.
 * `seq` and `at` are added by the ring itself and are not part of this set.
 */
export const DIAGNOSTIC_FIELDS = Object.freeze(Object.keys(FIELDS))

/**
 * Build one diagnostics ring.
 *
 * @param {object} [options] - the seams.
 * @param {{info?: Function}} [options.logger] - a logger to emit through when the env flag is set.
 * @param {number} [options.capacity] - how many events to keep (default 200).
 * @param {() => Date} [options.now] - clock seam, for tests.
 * @param {{record?: Function}|null} [options.sink] - optional private local journal.
 * @returns {{event: Function, snapshot: Function, size: Function}} the ring.
 */
export function createDiagnostics({
  logger,
  capacity = 200,
  now = () => new Date(),
  sink = null,
} = {}) {
  const limit = Number.isInteger(capacity) && capacity > 0 ? capacity : 200
  const events = []
  let sequence = 0
  let dropped = 0

  /** A timestamp that cannot be the reason a record is lost. */
  const stamp = () => {
    try {
      return now().toISOString()
    } catch {
      return new Date().toISOString()
    }
  }

  /** Copy the allowed fields whose values pass their own check. */
  const sanitise = (fields) => {
    const record = {}
    if (fields === null || typeof fields !== 'object') return record
    for (const [name, check] of Object.entries(FIELDS)) {
      let value
      try {
        value = fields[name]
      } catch {
        continue
      }
      if (value !== undefined && check(value)) record[name] = value
    }
    return record
  }

  return {
    /**
     * Record one decision.
     *
     * @param {string} name - one of {@link EVENT_NAMES}.
     * @param {object} [fields] - the allowed scalar fields for this event.
     * @returns {void}
     */
    event(name, fields) {
      try {
        if (!EVENT_SET.has(name)) return
        sequence += 1
        const record = { seq: sequence, at: stamp(), event: name, ...sanitise(fields) }
        events.push(record)
        if (events.length > limit) {
          events.shift()
          dropped += 1
        }
        try {
          if (typeof sink?.record === 'function') sink.record(record)
        } catch {
          // The disk view is advisory; the in-process ring remains available.
        }
        if (process.env.DSH_OBSIDIAN_MEM_DEBUG === '1' && typeof logger?.info === 'function') {
          logger.info(JSON.stringify(record))
        }
      } catch {
        // A diagnostic is never allowed to change an outcome.
      }
    },

    /**
     * A copy of the current window.
     *
     * @returns {{window: object, events: object[]}} the window and its events.
     */
    snapshot() {
      return {
        window: {
          capacity: limit,
          size: events.length,
          oldestSeq: events.length === 0 ? null : events[0].seq,
          newestSeq: events.length === 0 ? null : events[events.length - 1].seq,
          dropped,
        },
        events: events.map((record) => ({ ...record })),
      }
    },

    /**
     * How many events are held.
     *
     * @returns {number} the current size.
     */
    size() {
      return events.length
    },
  }
}

/**
 * Record through a diagnostics object that may be absent or broken.
 *
 * Call sites pass an injected seam, so this is the one place that has to survive a
 * caller handing over something that is not a diagnostics ring at all.
 *
 * @param {{event?: Function}|null|undefined} diagnostics - the ring, or anything else.
 * @param {string} name - the event category.
 * @param {object} [fields] - the allowed fields.
 * @returns {void}
 */
export function recordDiagnostic(diagnostics, name, fields) {
  try {
    const event = diagnostics?.event
    if (typeof event === 'function') event.call(diagnostics, name, fields)
  } catch {
    // See above: diagnostics never change an outcome.
  }
}
