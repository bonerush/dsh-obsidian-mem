#!/usr/bin/env node
// P0 compatibility assertions for the DSH session/agent lifecycle contract that
// `dsh-obsidian-mem` depends on.
//
// Input: JSONL written by `test/p0/probe-plugin.js`, located via
// `DSH_OBSIDIAN_MEM_PROBE_RECORD`. Every line is one probe record:
//   { name, id, seq?, turn?, type?, reason?, kind?, ... }
// The record never contains conversation text.
//
// The script exits non-zero when the variable is missing, the file does not
// exist, the record is empty, or any contract assertion fails. An empty record
// must never pass.

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import process from 'node:process'

const recordPath = process.env.DSH_OBSIDIAN_MEM_PROBE_RECORD

/** Report a fatal input problem and exit non-zero. */
function fail(message) {
  console.error(`run-probe: ${message}`)
  process.exit(1)
}

if (typeof recordPath !== 'string' || recordPath.trim() === '') {
  fail('DSH_OBSIDIAN_MEM_PROBE_RECORD is not set')
}
if (!existsSync(recordPath)) {
  fail(`probe record does not exist: ${recordPath}`)
}

const lines = readFileSync(recordPath, 'utf8')
  .split('\n')
  .filter((line) => line.trim() !== '')

if (lines.length === 0) {
  fail(`probe record is empty: ${recordPath}`)
}

const events = lines.map((line, index) => {
  try {
    return JSON.parse(line)
  } catch (error) {
    return fail(`line ${index + 1} is not valid JSON: ${error.message}`)
  }
})

for (const event of events) {
  if (typeof event?.name !== 'string') fail('every probe record needs a string `name`')
  if (typeof event?.id !== 'string') fail('every probe record needs a string session `id`')
}

// --- The contract this plugin is built on (brief Step 1) -------------------
// 1. A pre-step waterfall listener observes the very first turn.
assert.equal(
  events.filter((e) => e.name === 'agent/pre-step' && e.turn === 1).length >= 1,
  true,
  'expected at least one agent/pre-step record with turn === 1',
)

// 2. A completed turn is observable as a committed `turn/end` session event.
assert.equal(
  events.some((e) => e.name === 'session/event' && e.type === 'turn/end' && e.reason === 'completed'),
  true,
  "expected a session/event record with type 'turn/end' and reason 'completed'",
)

// 3. The awaited flush barrier is observable.
assert.equal(
  events.some((e) => e.name === 'session/flush'),
  true,
  "expected a session/flush record",
)

// --- Evidence summary ------------------------------------------------------
// Only records carrying one of the four probed lifecycle names belong to a
// session; `probe/*` records are harness metadata, not session data.
const SESSION_RECORD_NAMES = new Set([
  'agent/session-start',
  'agent/pre-step',
  'agent/pre-step/enter',
  'session/event',
  'session/flush',
])
const sessionIds = [...new Set(events.filter((e) => SESSION_RECORD_NAMES.has(e.name)).map((e) => e.id))]
const bySession = (id) => events.filter((e) => e.id === id)

const summarize = (id) => {
  const own = bySession(id)
  const sessionEvents = own
    .filter((e) => e.name === 'session/event')
    .sort((a, b) => a.seq - b.seq)
  const turnEnds = sessionEvents
    .filter((e) => e.type === 'turn/end')
    .map((e) => `${e.turn}:${e.reason}`)
  const preStepEnter = own.find((e) => e.name === 'agent/pre-step/enter' && e.turn === 1)
  // The last flush is the one that matters: DSH flushes per request checkpoint
  // and at teardown, so an early flush sees no turn end at all.
  const flushes = own.filter((e) => e.name === 'session/flush')
  const flush = flushes[flushes.length - 1]
  const turnEndNotice = sessionEvents.find((e) => e.type === 'turn/end' && e.reason === 'completed')
  return {
    id,
    records: own.length,
    eventTypes: sessionEvents.map((e) => e.type).join(','),
    preStepTurn1: preStepEnter !== undefined,
    preStepBeforeFirstRequest:
      preStepEnter !== undefined && !(preStepEnter.typesAtEnter ?? []).includes('request/header'),
    turnEndReasons: turnEnds.join(',') || '(none)',
    turnEndInSnapshotAtNotice: turnEndNotice?.snapshotHasSeq === true,
    flushObserved: flush !== undefined,
    flushCompletedTurnEnds: flush?.completedTurnEnds ?? null,
  }
}

console.log(`run-probe: OK — ${events.length} records across ${sessionIds.length} session(s)`)
for (const id of sessionIds) {
  console.log(`  session ${id}`)
  for (const [key, value] of Object.entries(summarize(id))) {
    if (key === 'id') continue
    console.log(`    ${key}: ${String(value)}`)
  }
}
