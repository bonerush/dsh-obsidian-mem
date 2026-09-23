#!/usr/bin/env node
// Acceptance checker for the isolated-profile smoke run of `dsh-obsidian-mem`.
//
// It reads one run record written by `test/smoke/run-smoke.mjs` and re-derives
// the vault facts from the temporary vault on disk, so the Obsidian-facing
// checks are observations rather than a replay of the runner's own claims.
//
// It exits non-zero when any of these is true:
//
//   1. the plugin row is missing from `--dump-config`
//   2. a duplicate brief was injected
//   3. the brief is over budget
//   4. a Chinese search returned no hit for the written document
//   5. the supersede chain is wrong
//   6. a restart duplicated the interrupted turn's work
//   7. the queue worker's own model-backed distill produced no receipt, or a
//      model lane is absent without the runner's explicit `skipped: true`
//      sentinel (Task 18b)
//   8. an external edit was overwritten
//
// Safety: it takes only *temporary* paths. A record or vault argument outside
// the OS temp root is refused outright, so this checker can never be pointed at
// a personal vault.
//
// Usage:
//   node test/smoke/verify.mjs <record.json> [--vault <dir>] [--json]

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import process from 'node:process'
import YAML from 'yaml'

const DATE_FIELDS = new Set(['created', 'updated', 'review_after', 'last_lint', 'date', 'valid_from', 'valid_until'])
const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/

const argv = process.argv.slice(2)
const options = { record: null, vault: null, json: false }
for (let index = 0; index < argv.length; index += 1) {
  const token = argv[index]
  if (token === '--vault') options.vault = argv[++index]
  else if (token === '--json') options.json = true
  else if (token === '--help' || token === '-h') options.help = true
  else if (token.startsWith('--')) fail(2, `unknown option: ${token}`)
  else if (options.record === null) options.record = token
  else fail(2, `unexpected extra argument: ${token}`)
}

if (options.help === true) {
  process.stdout.write('usage: node test/smoke/verify.mjs <record.json> [--vault <dir>] [--json]\n')
  process.exit(0)
}
if (options.record === null) fail(2, 'no run record given; usage: node test/smoke/verify.mjs <record.json> [--vault <dir>]')

/** Report a usage/refusal problem and exit with a fixed non-zero code. */
function fail(code, message) {
  process.stderr.write(`verify: ${message}\n`)
  process.exit(code)
}

/** The temporary roots this checker is willing to read from. */
function tempRoots() {
  return [resolve(tmpdir()), '/tmp', '/private/tmp', '/var/folders'].map((root) => (root.endsWith(sep) ? root.slice(0, -1) : root))
}

/** Whether one path is inside a temporary root (and so is not a personal vault). */
function isTempPath(candidate) {
  const absolute = resolve(candidate)
  return tempRoots().some((root) => absolute === root || absolute.startsWith(root + sep))
}

/** Refuse anything that is not a temporary path. */
function requireTemp(candidate, label) {
  if (!isTempPath(candidate)) {
    fail(2, `${label} must be a temporary path; refusing ${candidate}`)
  }
  return resolve(candidate)
}

const recordPath = requireTemp(options.record, 'the run record')
if (!existsSync(recordPath)) fail(2, `run record does not exist: ${recordPath}`)

let record
try {
  record = JSON.parse(readFileSync(recordPath, 'utf8'))
} catch (error) {
  fail(2, `run record is not valid JSON: ${error.message}`)
}

const vaultPath = requireTemp(options.vault ?? record?.paths?.vault ?? '', 'the vault')
if (record?.paths?.vault !== undefined && record.paths.vault !== null) {
  requireTemp(record.paths.vault, "the record's vault")
}
if (record?.paths?.dshHome !== undefined && record.paths.dshHome !== null) {
  requireTemp(record.paths.dshHome, "the record's DSH home")
}
if (record.schema !== 1) fail(2, `unsupported run record schema: ${JSON.stringify(record.schema)}`)
if (!existsSync(vaultPath)) {
  fail(2, `the temporary vault is gone, so the Obsidian filesystem facts cannot be re-derived: ${vaultPath}`)
}

const checks = []
/** Record one check outcome. */
function check(id, ok, detail) {
  checks.push({ id, ok: ok === true, detail: detail === undefined ? '' : String(detail) })
  return ok === true
}

/**
 * A canonical string for a `{path: sha256}` tree map, so two maps that describe
 * the same tree compare equal. The checker derives the "did the apply change the
 * vault" verdict from the maps themselves rather than trusting a boolean.
 *
 * @param {object} map - a tree map.
 * @returns {string} the sorted `path:hash` join.
 */
function canonicalTree(map) {
  return Object.keys(map ?? {}).sort().map((key) => `${key}:${map[key]}`).join('\n')
}

/**
 * Whether the vault changed between two recorded tree maps.
 *
 * @param {object} cycle - the lane cycle, carrying `treeBefore`/`treeAfter`.
 * @returns {boolean|null} the verdict, or `null` when the maps are absent.
 */
function treeChanged(cycle) {
  if (cycle === null || cycle === undefined) return null
  if (cycle.treeBefore === undefined || cycle.treeAfter === undefined) return null
  return canonicalTree(cycle.treeBefore) !== canonicalTree(cycle.treeAfter)
}

const vault = record.checks ?? {}
const capture = vault.capture ?? {}
const restart = vault.restart ?? {}

// ---------------------------------------------------------------------------
// 1. the plugin row is in the composed config
// ---------------------------------------------------------------------------
check(
  'plugin-row-in-dump-config',
  vault.pluginRowInDumpConfig === true,
  `dump-config has "- id: obsidian-mem": ${vault.pluginRowInDumpConfig === true} (${record.profile?.dumpConfigChars ?? '?'} chars)`,
)
check(
  'plugin-row-line-recorded',
  typeof record.profile?.dumpConfigRowLine === 'string' && record.profile.dumpConfigRowLine.includes('obsidian-mem'),
  record.profile?.dumpConfigRowLine ?? '(no row line)',
)

// ---------------------------------------------------------------------------
// 2. exactly one brief on the first step
// ---------------------------------------------------------------------------
check(
  'brief-injected-exactly-once',
  vault.firstStepBriefCount === 1,
  `firstStepBriefCount=${vault.firstStepBriefCount} (session total ${vault.sessionBriefCount})`,
)
check(
  'brief-not-repeated-later',
  typeof vault.sessionBriefCount === 'number' && vault.sessionBriefCount === vault.firstStepBriefCount,
  `sessionBriefCount=${vault.sessionBriefCount}`,
)

// ---------------------------------------------------------------------------
// 3. the brief is within budget
// ---------------------------------------------------------------------------
check(
  'brief-within-budget',
  Number.isSafeInteger(vault.firstStepBriefChars) &&
    Number.isSafeInteger(vault.briefBudgetChars) &&
    vault.firstStepBriefChars > 0 &&
    vault.firstStepBriefChars <= vault.briefBudgetChars,
  `${vault.firstStepBriefChars} code points <= ${vault.briefBudgetChars}`,
)

// ---------------------------------------------------------------------------
// 4. a Chinese search hits the document that was written
// ---------------------------------------------------------------------------
const search = vault.chineseSearch ?? {}
check(
  'chinese-search-hit',
  search.ok === true && search.matchedDocPath === true && Number.isSafeInteger(search.hitCount) && search.hitCount >= 1,
  `queryChars=${search.queryChars} hitCount=${search.hitCount} matchedDocPath=${search.matchedDocPath}`,
)
const docPath = vault.documentWrite?.path ?? null
check(
  'document-write-on-disk',
  typeof docPath === 'string' && docPath !== '' && existsSync(join(vaultPath, docPath)),
  `${docPath}`,
)

// ---------------------------------------------------------------------------
// 5. the supersede chain
// ---------------------------------------------------------------------------
const supersede = vault.supersede ?? {}
check(
  'supersede-chain-correct',
  supersede.ok === true &&
    supersede.oldFileStillExists === true &&
    supersede.oldStatus === 'superseded' &&
    typeof supersede.oldSupersededBy === 'string' &&
    supersede.oldSupersededBy === supersede.newId &&
    supersede.defaultSearchHasOld === false &&
    supersede.defaultSearchHasNew === true &&
    supersede.historySearchHasOld === true,
  `old=${supersede.oldId} status=${supersede.oldStatus} superseded_by=${supersede.oldSupersededBy} defaultHasOld=${supersede.defaultSearchHasOld} historyHasOld=${supersede.historySearchHasOld}`,
)

// ---------------------------------------------------------------------------
// 6. the interrupted turn is recovered exactly once
// ---------------------------------------------------------------------------
check(
  'interrupted-process-was-killed',
  restart.killedBy === 'SIGKILL' && capture.liveInjection !== null && capture.liveInjection !== undefined,
  `killedBy=${restart.killedBy} jobId=${capture.liveJobId} injected=${capture.liveInjection?.outputState}`,
)
check(
  'restart-recovered-exactly-once',
  restart.receiptCount === 1,
  `result receipts for ${restart.jobId}: ${restart.receiptCount} (total ${restart.receiptsTotal})`,
)
check(
  'restart-live-apply-succeeded',
  capture.liveReceipt?.result === 'applied' && capture.liveReceipt?.dryRun === false,
  `live receipt: ${capture.liveReceipt?.result ?? '(none)'} dryRun=${capture.liveReceipt?.dryRun}`,
)
const liveTreeChanged = treeChanged(capture.liveCycle)
check(
  'restart-wrote-to-the-vault',
  liveTreeChanged === true && capture.liveReceipt?.result === 'applied',
  `vault changed across the live restart: ${liveTreeChanged} (receipt ${capture.liveReceipt?.result ?? '(none)'})`,
)
check(
  'no-duplicate-note-ids',
  Array.isArray(restart.duplicateNoteIds) && restart.duplicateNoteIds.length === 0,
  `duplicate ids: ${JSON.stringify(restart.duplicateNoteIds)}`,
)
const dryRunTreeChanged = treeChanged(capture.dryRunCycle)
check(
  'dry-run-wrote-nothing',
  capture.dryRunReceipt?.result === 'dry-run' &&
    capture.dryRunReceipt?.dryRun === true &&
    dryRunTreeChanged === false,
  `dry-run receipt: ${capture.dryRunReceipt?.result ?? '(none)'} vaultChanged=${dryRunTreeChanged}`,
)

// ---------------------------------------------------------------------------
// 7. the queue worker's OWN model-backed distill completed (the headline path)
// ---------------------------------------------------------------------------
// Task 18 recorded this as unverified: the worker's model call never finished on
// a real host, so every apply receipt came from the documented `raw-durable`
// resume path. Task 18b fixed the cause (`docs/p0-compatibility.md` §9), and this
// is the acceptance: a real completed turn, distilled by the real worker with a
// real model call, applied to the vault.
//
// A lane that never ran (`--only dry-run` / `--only live`) carries the runner's
// explicit `skipped: true` and is reported as a pass with that fact. Anything
// else is a FAILURE:
//
//   * an ABSENT lane means the record does not carry the headline evidence at
//     all — trusting absence let a record with no `capture.modelLane` pass both
//     checks, which is the fail-open shape the whole-branch review found; and
//   * a lane that RAN but captured no job (`jobId === null` with no sentinel) is
//     a failure too, so the acceptance cannot pass on a total capture failure.
const modelLane = capture.modelLane ?? {}
/** Whether the worker's receipt shows a real model answer (not a stubbed path). */
const realModelCall = (receipt) => (receipt?.usage?.outputTokens ?? 0) > 0 && (receipt?.durationMs ?? 0) > 0
for (const [label, lane, expected] of [
  ['dry-run', modelLane.dryRun, 'dry-run'],
  ['live', modelLane.live, 'applied'],
]) {
  if (lane === undefined || lane === null) {
    check(
      `model-lane-${label}-real-distill`,
      false,
      `the ${label} lane is absent from the record, so nothing about the headline path was verified; ` +
      'only an explicit `skipped: true` from the runner (`--only`) marks a lane as not run',
    )
    continue
  }
  if (lane.skipped === true) {
    check(`model-lane-${label}-real-distill`, true, `the ${label} lane carries the runner's explicit skipped: true (--only); nothing to verify`)
    continue
  }
  const cycle = Array.isArray(lane.cycles) ? lane.cycles[lane.cycles.length - 1] : {}
  const receipt = lane.receipt ?? null
  const captured = lane.jobId !== null && lane.jobId !== undefined
  check(
    `model-lane-${label}-real-distill`,
    captured &&
      receipt !== null &&
      receipt.result === expected &&
      receipt.attempts === 0 &&
      realModelCall(receipt) &&
      cycle.vaultChanged === (expected === 'applied'),
    captured
      ? (receipt === null
          ? 'a job was captured but no result receipt exists: the worker\'s own model call did not complete'
          : `result=${receipt.result} attempts=${receipt.attempts} outputTokens=${receipt.usage?.outputTokens ?? '(none)'} durationMs=${receipt.durationMs ?? '(none)'} vaultChanged=${cycle.vaultChanged}`)
      : 'no job was captured on this lane, so there is nothing the worker could have distilled',
  )
}

// ---------------------------------------------------------------------------
// 8. an external edit was never overwritten
// ---------------------------------------------------------------------------
const externalEdit = vault.externalEdit ?? {}
const humanOwned = vault.humanOwned ?? {}
check(
  'external-edit-survived',
  externalEdit.ok === true &&
    externalEdit.humanLineSurvived === true &&
    externalEdit.existsOnDisk === true &&
    externalEdit.humanLineOnDiskAfterAllPasses === true,
  `path=${externalEdit.path} humanLineSurvived=${externalEdit.humanLineSurvived} onDiskAfterAllPasses=${externalEdit.humanLineOnDiskAfterAllPasses}`,
)
check(
  'human-owned-file-byte-identical',
  humanOwned.ok === true &&
    humanOwned.survivedUpdate === true &&
    humanOwned.survivedSupersede === true &&
    humanOwned.byteIdenticalOnDisk === true,
  `path=${humanOwned.path} update=${humanOwned.updateRefusalCode} supersede=${humanOwned.supersedeRefusalCode} byteIdentical=${humanOwned.byteIdenticalOnDisk}`,
)

// ---------------------------------------------------------------------------
// Supporting invariants
// ---------------------------------------------------------------------------
check(
  'read-only-lint-never-writes',
  vault.lintReadonly?.ok === true && vault.lintReadonly?.treeUntouched === true && vault.lintReadonly?.readOnly === true,
  `findings=${vault.lintReadonly?.total} treeUntouched=${vault.lintReadonly?.treeUntouched}`,
)
check('real-dsh-home-unchanged', vault.realHomeUnchanged === true, `real ~/.dsh fingerprint unchanged: ${vault.realHomeUnchanged}`)

// ---------------------------------------------------------------------------
// The Obsidian-facing filesystem facts, re-derived here
// ---------------------------------------------------------------------------
const fs2 = inspectVault(vaultPath)
check('frontmatter-parses-under-yaml-v2', fs2.unparsable.length === 0, fs2.unparsable.length === 0 ? `${fs2.notes} notes parsed` : `unparsable: ${JSON.stringify(fs2.unparsable.slice(0, 5))}`)
check('tags-is-a-list', fs2.badTags.length === 0, fs2.badTags.length === 0 ? `${fs2.tagged} notes carry a tags list` : `not a list: ${JSON.stringify(fs2.badTags.slice(0, 5))}`)
check('date-fields-are-iso-days', fs2.badDates.length === 0, fs2.badDates.length === 0 ? `${fs2.dated} date fields shaped YYYY-MM-DD` : `bad dates: ${JSON.stringify(fs2.badDates.slice(0, 5))}`)
check('wikilinks-resolve', fs2.deadLinks.length === 0, fs2.deadLinks.length === 0 ? `${fs2.links} wikilinks resolved by path or basename` : `dead: ${JSON.stringify(fs2.deadLinks.slice(0, 5))}`)
check('obsidian-directory-untouched', vault.externalEdit?.obsidianUntouched === true, `externalEdit.obsidianUntouched=${vault.externalEdit?.obsidianUntouched}`)

// ---------------------------------------------------------------------------
// Notes: what this run does NOT establish
// ---------------------------------------------------------------------------
// These are printed, never scored. A model-backed apply that never produced a
// receipt is an open item for a human to read, not a PASS and not a FAIL of a
// behaviour the plugin claims.
const unverified = []
// A lane that ran and produced no receipt is exactly the Task 18 defect: the
// worker's own model call did not complete, so the apply evidence above came
// from the model-free `raw-durable` resume path. The in-context probe is the
// control that tells "the route is broken" apart from "the worker's call was cut
// off", so it is reported beside it.
const modelLaneRan = ['dryRun', 'live'].filter((key) => modelLane[key]?.skipped !== true)
const modelLaneMissing = modelLaneRan.filter((key) => modelLane[key]?.receipt === null || modelLane[key]?.receipt === undefined)
if (modelLaneMissing.length > 0) {
  unverified.push(
    `the queue worker's own model-backed distill produced no receipt on the ${modelLaneMissing.join(', ')} lane(s); the apply checks above were satisfied through the documented \`raw-durable\` resume path instead`,
  )
  if (modelLane.llmProbe !== null && modelLane.llmProbe !== undefined) {
    unverified.push(`in-context llm.stream() control: finish=${modelLane.llmProbe.finishKind} ms=${modelLane.llmProbe.ms} — the route itself answered, so the worker's call is what did not complete`)
  }
}
if (record.versions?.obsidian === null || record.versions?.obsidian === undefined) {
  unverified.push('Obsidian GUI checks (rendered tag list, date property, clickable wikilink): the vault was never opened in Obsidian')
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const failed = checks.filter((entry) => !entry.ok)
const report = {
  record: recordPath,
  vault: vaultPath,
  obsidianGuiVersion: record.versions?.obsidian ?? null,
  versions: record.versions ?? null,
  checks,
  vaultFacts: { notes: fs2.notes, links: fs2.links, deadLinks: fs2.deadLinks.length },
  unverified,
  failed: failed.map((entry) => entry.id),
}

if (options.json === true) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
} else {
  process.stdout.write(`verify: ${recordPath}\n`)
  process.stdout.write(`  versions: dsh=${record.versions?.dsh} node=${record.versions?.node} obsidian=${record.versions?.obsidian ?? '(not supplied; GUI checks unverified)'}\n`)
  for (const entry of checks) {
    process.stdout.write(`  ${entry.ok ? 'PASS' : 'FAIL'} ${entry.id} — ${entry.detail}\n`)
  }
  for (const note of unverified) {
    process.stdout.write(`  UNVERIFIED ${note}\n`)
  }
  process.stdout.write(`verify: ${failed.length === 0 ? 'OK' : `${failed.length} FAILED`} (${checks.length} checks, ${fs2.notes} vault notes)\n`)
}

process.exit(failed.length === 0 ? 0 : 1)

/**
 * Re-derive the Obsidian-facing facts from the temporary vault on disk.
 *
 * Only the notes the user would actually browse are inspected: the `_meta/.history`
 * snapshots are the transaction engine's private copies, not vault documents.
 *
 * @param {string} vaultRoot - temporary vault root.
 * @returns {{notes: number, tagged: number, dated: number, links: number, unparsable: string[], badTags: string[], badDates: string[], deadLinks: string[]}} the facts.
 */
function inspectVault(vaultRoot) {
  const files = listMarkdown(vaultRoot).filter((path) => !path.startsWith('_meta/.history/'))
  const targets = new Set()
  for (const path of files) {
    const stem = path.replace(/\.md$/, '')
    targets.add(stem)
    targets.add(stem.split('/').at(-1))
  }
  const result = { notes: 0, tagged: 0, dated: 0, links: 0, unparsable: [], badTags: [], badDates: [], deadLinks: [] }
  for (const path of files) {
    let text
    try {
      text = readFileSync(join(vaultRoot, path), 'utf8')
    } catch {
      continue
    }
    result.notes += 1
    const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
    if (match === null) continue
    let data
    try {
      data = YAML.parse(match[1], { logLevel: 'silent' })
    } catch (error) {
      result.unparsable.push(`${path}: ${error.message.slice(0, 120)}`)
      continue
    }
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      result.unparsable.push(`${path}: frontmatter is not a mapping`)
      continue
    }
    if (data.tags !== undefined) {
      if (Array.isArray(data.tags) && data.tags.every((tag) => typeof tag === 'string')) result.tagged += 1
      else result.badTags.push(`${path}: tags=${JSON.stringify(data.tags)}`)
    }
    for (const [key, value] of Object.entries(data)) {
      if (!DATE_FIELDS.has(key)) continue
      if (value === null || value === undefined) continue
      if (typeof value === 'string' && DATE_SHAPE.test(value)) result.dated += 1
      else result.badDates.push(`${path}: ${key}=${JSON.stringify(value)}`)
    }
    for (const link of wikilinks(text)) {
      result.links += 1
      if (!targets.has(link)) result.deadLinks.push(`${path} -> [[${link}]]`)
    }
  }
  return result
}

/** Every Markdown file under a directory, as `/`-separated relative paths. */
function listMarkdown(root) {
  const found = []
  const walk = (directory, prefix) => {
    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) walk(join(directory, entry.name), path)
      else if (entry.isFile() && entry.name.endsWith('.md')) found.push(path)
    }
  }
  walk(root, '')
  return found
}

/**
 * The wikilink targets in one Markdown body, with alias/anchor stripped.
 *
 * @param {string} text - the note's full text.
 * @returns {string[]} the targets, in order, de-duplicated.
 */
function wikilinks(text) {
  const found = new Set()
  for (const match of text.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)) {
    const target = match[1].trim().replace(/\\/g, '/')
    if (target !== '') found.add(target)
  }
  return [...found]
}
