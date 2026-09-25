#!/usr/bin/env node
// Negative controls for `test/smoke/verify.mjs`.
//
// A checker that only ever passes is not a checker. This script takes one real
// run record, breaks exactly one acceptance condition at a time, and asserts
// that `verify.mjs` exits non-zero for each mutation. The clean record must
// still pass, so the controls measure the checker and not the environment.
//
// One control goes the other way: the runner's explicit `skipped: true` sentinel
// (`--only`) must still PASS, so a lane that never ran is not failed. Together
// the two directions pin the sentinel: absence is a failure, the sentinel is not.
//
// Every path it writes is a fresh temporary file; nothing is copied out of the
// temp tree.
//
// Usage:
//   node test/smoke/negative-controls.mjs <record.json>

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const VERIFY = join(HERE, 'verify.mjs')

const recordPath = process.argv[2]
if (typeof recordPath !== 'string' || recordPath === '') {
  process.stderr.write('usage: node test/smoke/negative-controls.mjs <record.json>\n')
  process.exit(2)
}

/** One mutation: what to break, and how the record must change for it. */
const MUTATIONS = [
  {
    id: 'plugin-row-missing',
    expectation: 'the checker fails when the plugin row is absent from --dump-config',
    mutate: (record) => {
      record.checks.pluginRowInDumpConfig = false
      record.profile.dumpConfigRowLine = '# (row removed)'
    },
  },
  {
    id: 'duplicate-brief',
    expectation: 'the checker fails when two briefs reach the first step',
    mutate: (record) => {
      record.checks.firstStepBriefCount = 2
    },
  },
  {
    id: 'over-budget-brief',
    expectation: 'the checker fails when the brief exceeds the character budget',
    mutate: (record) => {
      record.checks.firstStepBriefChars = record.checks.briefBudgetChars + 1
    },
  },
  {
    id: 'no-chinese-hit',
    expectation: 'the checker fails when the Chinese search misses the written document',
    mutate: (record) => {
      record.checks.chineseSearch.hitCount = 0
      record.checks.chineseSearch.matchedDocPath = false
      record.checks.chineseSearch.ok = false
    },
  },
  {
    id: 'wrong-supersede',
    expectation: 'the checker fails when the old note is not the one superseded',
    mutate: (record) => {
      record.checks.supersede.oldSupersededBy = 'dec-00000000-0000-4000-8000-000000000000'
      record.checks.supersede.ok = false
    },
  },
  {
    id: 'pending-restart-duplicate',
    expectation: 'the checker fails when recovery applied the interrupted job twice',
    mutate: (record) => {
      record.checks.restart.receiptCount = 2
      record.checks.restart.duplicateNoteIds = ['con-00000000-0000-4000-8000-000000000000']
    },
  },
  {
    id: 'external-edit-overwritten',
    expectation: 'the checker fails when an external edit was overwritten',
    mutate: (record) => {
      record.checks.humanOwned.hashAfterUpdate = 'deadbeef'
      record.checks.humanOwned.survivedUpdate = false
      record.checks.humanOwned.ok = false
    },
  },
  {
    id: 'model-lane-lost-its-receipt',
    expectation: "the checker fails when the worker's own model-backed distill produced no receipt",
    mutate: (record) => {
      // Exactly the Task 18 shape: the lane ran, the seed job is on disk, but no
      // result receipt exists for it (the model call never completed).
      record.checks.capture.modelLane.live.receipt = null
      record.checks.capture.modelLane.live.cycles = record.checks.capture.modelLane.live.cycles.map(
        (entry) => ({ ...entry, receiptResult: null }),
      )
    },
  },
  {
    id: 'model-lane-captured-nothing',
    expectation: 'the checker fails when the model lane ran but never captured a job',
    mutate: (record) => {
      // A lane that ran and captured nothing leaves `jobId` null WITHOUT the
      // `skipped` sentinel. Reporting that as a skip would let the headline
      // acceptance pass on a total capture failure.
      record.checks.capture.modelLane.live.jobId = null
      record.checks.capture.modelLane.live.receipt = null
      record.checks.capture.modelLane.live.cycles = []
    },
  },
  {
    id: 'model-lane-absent',
    expectation: 'the checker fails when a model lane is missing from the record entirely',
    mutate: (record) => {
      // The fail-open shape the whole-branch review found: with the lane absent,
      // `lane === undefined` was scored PASS. Absence is not evidence.
      delete record.checks.capture.modelLane.live
    },
  },
  {
    id: 'model-lane-absent-at-the-top',
    expectation: 'the checker fails when capture.modelLane itself is missing',
    mutate: (record) => {
      // The same rule one level up: a record that never recorded the headline
      // lanes at all must not pass them by default.
      delete record.checks.capture.modelLane
    },
  },
]

/**
 * The one shape that MUST still pass: a lane the runner marked `skipped: true`.
 *
 * `--only live` leaves the dry-run lane present with only the sentinel. That is
 * the projection `run-smoke.mjs` now emits; if it stops passing, the `--only`
 * paths are back to failing a lane that never ran.
 */
const SKIPPED_LANE = {
  id: 'model-lane-explicitly-skipped',
  expectation: "a lane carrying the runner's explicit skipped: true still passes",
  mutate: (record) => {
    record.checks.capture.modelLane.dryRun = {
      skipped: true,
      jobId: null,
      cycles: [],
      receipt: null,
    }
  },
}

const base = JSON.parse(readFileSync(resolve(recordPath), 'utf8'))
const workDir = mkdtempSync(join(tmpdir(), 'dsh-obsidian-mem-negative-'))

/** Run verify.mjs against one record and return its exit code. */
function verifyExit(path) {
  const result = spawnSync(process.execPath, [VERIFY, path, '--json'], { encoding: 'utf8' })
  return result.status
}

const cleanPath = join(workDir, 'clean.json')
writeFileSync(cleanPath, `${JSON.stringify(base, null, 2)}\n`)
const cleanExit = verifyExit(cleanPath)

const results = []
for (const mutation of MUTATIONS) {
  const mutated = JSON.parse(JSON.stringify(base))
  mutation.mutate(mutated)
  const path = join(workDir, `${mutation.id}.json`)
  writeFileSync(path, `${JSON.stringify(mutated, null, 2)}\n`)
  const exit = verifyExit(path)
  results.push({ id: mutation.id, expectation: mutation.expectation, exit, passed: exit !== 0 })
}

// The one positive control: the explicit `skipped: true` sentinel really does
// pass, so the `--only` paths are not failed for a lane that never ran.
const skippedRecord = JSON.parse(JSON.stringify(base))
SKIPPED_LANE.mutate(skippedRecord)
const skippedPath = join(workDir, `${SKIPPED_LANE.id}.json`)
writeFileSync(skippedPath, `${JSON.stringify(skippedRecord, null, 2)}\n`)
const skippedExit = verifyExit(skippedPath)

const refusedPersonalPath = spawnSync(
  process.execPath,
  [VERIFY, cleanPath, '--vault', join(process.env.HOME ?? '/root', 'Documents', 'dsh-memory')],
  { encoding: 'utf8' },
)

const failures = results.filter((entry) => !entry.passed)
process.stdout.write(`negative-controls: clean record exit=${cleanExit} (expected 0)\n`)
for (const entry of results) {
  process.stdout.write(
    `  ${entry.passed ? 'PASS' : 'FAIL'} ${entry.id} -> verify exit=${entry.exit} (${entry.expectation})\n`,
  )
}
process.stdout.write(
  `  ${skippedExit === 0 ? 'PASS' : 'FAIL'} ${SKIPPED_LANE.id} -> verify exit=${skippedExit} (${SKIPPED_LANE.expectation})\n`,
)
process.stdout.write(
  `  ${refusedPersonalPath.status === 2 ? 'PASS' : 'FAIL'} refuses-personal-vault-path -> verify exit=${refusedPersonalPath.status} (expected 2)\n`,
)

const ok =
  cleanExit === 0 && failures.length === 0 && skippedExit === 0 && refusedPersonalPath.status === 2
process.stdout.write(
  `negative-controls: ${ok ? 'OK' : 'FAILED'} (${results.length} negative controls, 1 positive control)\n`,
)
process.exit(ok ? 0 : 1)
