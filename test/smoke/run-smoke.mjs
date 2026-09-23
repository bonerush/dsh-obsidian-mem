#!/usr/bin/env node
// Isolated-profile smoke runner for `dsh-obsidian-mem`.
//
// It builds a throwaway DSH home, vault and repository under the OS temp
// directory, installs THIS checkout plus `test/smoke/driver` into a `smoke`
// profile with `link:`, and then drives three real headless sessions:
//
//   dryRun      real turn captured and applied by the real queue worker with
//               `distill.dryRun: true` — the receipt is the only durable trace
//   interrupted the same wiring with `dryRun: false`, but the process SIGKILLs
//               itself once the completed turn's job is fsynced
//   recovery    a restart that recovers that job and applies it for real
//
// It writes one run record (`schema: 1`) that `test/smoke/verify.mjs` checks.
// The record carries versions, counts, hashes, paths, ids and PASS/FAIL — never
// a prompt, a model output body, a note body or a credential.
//
// Safety: every path it touches is a fresh temp path, `DSH_HOME` is always set
// for the child, and the real `~/.dsh` is never written. The temp tree is kept
// so `verify.mjs` can re-derive the vault facts independently; delete it after
// verification (the printed `baseDir`).
//
// Usage:
//   node test/smoke/run-smoke.mjs [--out <record.json>] [--base <dir>]
//                                 [--timeout-ms <ms>] [--keep-failed]

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, statSync, writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..')
const DSH_BIN = process.env.DSH_BIN ?? 'dsh'
const PROFILE = 'smoke'
const ROW_ID = 'obsidian-mem'
const DRIVER_PACKAGE = 'dsh-obsidian-mem-smoke-driver'

const args = parseArgs(process.argv.slice(2))
const outPath = args.out === undefined ? join(tmpdir(), `dsh-obsidian-mem-smoke-record-${Date.now()}.json`) : resolve(args.out)

/** Refuse an absolute path outside the temp root: this runner never writes a real vault. */
function assertTempPath(candidate, label) {
  const absolute = resolve(candidate)
  const roots = [resolve(tmpdir()), '/tmp', '/private/tmp', '/var/folders']
  const inside = roots.some((root) => absolute === root || absolute.startsWith(root + sep))
  if (!inside) throw new Error(`${label} must live under a temporary root, refusing: ${absolute}`)
  return absolute
}

function parseArgs(argv) {
  const parsed = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--out') parsed.out = argv[++index]
    else if (token === '--base') parsed.base = argv[++index]
    else if (token === '--timeout-ms') parsed.timeoutMs = Number(argv[++index])
    else if (token === '--only') parsed.only = argv[++index]
    else if (token === '--help' || token === '-h') parsed.help = true
    else throw new Error(`unknown argument: ${token}`)
  }
  return parsed
}

if (args.help === true) {
  process.stdout.write('usage: node test/smoke/run-smoke.mjs [--out <record.json>] [--base <dir>] [--timeout-ms <ms>]\n')
  process.exit(0)
}

const RUN_TIMEOUT_MS = Number.isSafeInteger(args.timeoutMs) && args.timeoutMs > 0 ? args.timeoutMs : 300_000
/** How long the driver holds a run open waiting for the worker's result receipt. */
const HOLD_MS = 60_000

/** sha256 hex of a string or buffer. */
const sha256 = (value) => createHash('sha256').update(value).digest('hex')

/** Run one child process to completion, capturing stdout/stderr as buffers. */
function run(command, commandArgs, options = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, commandArgs, { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout = []
    const stderr = []
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, options.timeoutMs ?? RUN_TIMEOUT_MS)
    child.stdout.on('data', (chunk) => stdout.push(chunk))
    child.stderr.on('data', (chunk) => stderr.push(chunk))
    child.on('error', (error) => {
      clearTimeout(timer)
      resolvePromise({ code: null, signal: null, timedOut, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), spawnError: error.message })
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolvePromise({ code, signal, timedOut, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) })
    })
  })
}

// ---------------------------------------------------------------------------
// Credentials: only ever handed to the child process environment
// ---------------------------------------------------------------------------

/**
 * Resolve the model credential without ever printing or persisting it.
 *
 * The environment route is what P0 measured as the winning route, so it is the
 * only one used here: the value is read from `DEEPSEEK_API_KEY`, or from the
 * `refs` entry of the real credentials store, and passed straight into the
 * child's `env`. It is never written into the temp home, the record or a log.
 */
function resolveCredential() {
  const fromEnv = process.env.DEEPSEEK_API_KEY
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return { value: fromEnv, source: 'env' }
  const storePath = join(homedir(), '.dsh', '.credentials.yaml')
  if (!existsSync(storePath)) return null
  try {
    const doc = YAML.parse(readFileSync(storePath, 'utf8'))
    const value = doc?.refs?.DEEPSEEK_API_KEY
    if (typeof value === 'string' && value.trim() !== '') return { value, source: 'store-ref' }
  } catch {
    /* an unreadable store is reported as "no credential" rather than a crash */
  }
  return null
}

// ---------------------------------------------------------------------------
// Fingerprints
// ---------------------------------------------------------------------------

/** Every regular file under `root`, as `/`-separated relative paths, sorted. */
function listFiles(root) {
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
      else if (entry.isFile()) found.push(path)
    }
  }
  walk(root, '')
  return found
}

/** `{path: sha256}` for every file under `root`. */
function hashTree(root) {
  const map = {}
  for (const path of listFiles(root)) {
    try {
      map[path] = sha256(readFileSync(join(root, path)))
    } catch {
      /* a file that vanished is not part of the tree */
    }
  }
  return map
}

/**
 * A canonical string for a `{path: sha256}` tree map.
 *
 * Two maps that describe the same tree must compare equal; object identity never
 * does, so a `!==` on the maps would report every apply as a change.
 *
 * @param {object} map - a tree map.
 * @returns {string} the sorted `path:hash` join.
 */
function canonicalTree(map) {
  return Object.keys(map ?? {}).sort().map((key) => `${key}:${map[key]}`).join('\n')
}

/** The real DSH home files that must stay byte-identical, as `{path: sha256}`. */
function realHomeFingerprint() {
  const home = join(homedir(), '.dsh')
  const files = [
    join(home, 'cordis.patch.yml'),
    join(home, 'settings.yaml'),
    join(home, '.credentials.yaml'),
    join(home, 'profiles', 'web', 'package.json'),
    join(home, 'profiles', 'web', 'pnpm-workspace.yaml'),
    join(home, 'profiles', 'web', 'pnpm-lock.yaml'),
    join(home, 'profiles', 'web', 'cordis.patch.yml'),
  ]
  const map = {}
  for (const path of files) {
    try {
      map[relative(home, path)] = sha256(readFileSync(path))
    } catch {
      map[relative(home, path)] = 'absent'
    }
  }
  // The profile tree's shape, so a new file or directory next to `web/` shows up.
  try {
    map['profiles/'] = sha256(readdirSync(join(home, 'profiles')).sort().join('\n'))
  } catch {
    map['profiles/'] = 'absent'
  }
  return map
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

main().catch((error) => {
  process.stderr.write(`run-smoke: ${error?.stack ?? error}\n`)
  process.exit(1)
})

async function main() {
  const credential = resolveCredential()
  if (credential === null) {
    process.stderr.write('run-smoke: no DEEPSEEK_API_KEY in the environment and none in the credentials store; refusing to run without a model route\n')
    process.exit(2)
  }

  const baseDir = args.base === undefined ? mkdtempSync(join(tmpdir(), 'dsh-obsidian-mem-smoke-')) : assertTempPath(args.base, '--base')
  if (args.base !== undefined) rmSync(baseDir, { recursive: true, force: true })
  const dshHome = join(baseDir, 'home')
  const vault = join(baseDir, 'vault')
  const repo = join(baseDir, 'repo')
  const recordsDir = join(baseDir, 'records')
  for (const directory of [dshHome, vault, repo, recordsDir]) mkdirSync(directory, { recursive: true })

  const homeBefore = realHomeFingerprint()

  // An `.obsidian/` directory with fixed bytes, so "the plugin never touches it"
  // is a hash comparison rather than a claim about a missing directory.
  mkdirSync(join(vault, '.obsidian'), { recursive: true })
  writeFileSync(join(vault, '.obsidian', 'app.json'), '{\n  "smoke": "untouched"\n}\n')
  writeFileSync(join(vault, '.obsidian', 'workspace.json'), '{\n  "smoke": "untouched"\n}\n')
  const obsidianBefore = hashTree(join(vault, '.obsidian'))

  // A repository the plugin can bind: a git root with one Markdown file.
  writeFileSync(join(repo, 'README.md'), '# smoke repository\n\nA throwaway repository for the isolated-profile smoke.\n')
  await run('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  await run('git', ['add', 'README.md'], { cwd: repo })
  await run('git', ['-c', 'user.name=smoke', '-c', 'user.email=smoke@example.invalid', 'commit', '-q', '-m', 'chore: seed smoke repository'], { cwd: repo })

  const childEnv = {
    ...process.env,
    DSH_HOME: dshHome,
    DEEPSEEK_API_KEY: credential.value,
    DSH_OBSIDIAN_MEM_SMOKE_RECORD: '',
  }

  const steps = []
  // stderr is kept as a BYTE COUNT only. DSH prints the model's reasoning to
  // stderr, so a captured tail would put model output into the record — the one
  // thing the record must never contain.
  const note = async (label, result) => {
    steps.push({ label, code: result.code, signal: result.signal, timedOut: result.timedOut, stderrBytes: result.stderr.length })
    return result
  }

  // --- profile -----------------------------------------------------------------
  await note('profile:dump-default', await run(DSH_BIN, ['--profile', PROFILE, '--from-default-profile', 'headless', '--dump-config'], { cwd: REPO_ROOT, env: childEnv }))
  await note('plugin:add', await run(DSH_BIN, ['plugin', '--profile', PROFILE, 'add', `link:${REPO_ROOT}`], { cwd: REPO_ROOT, env: childEnv }))
  await note('driver:add', await run(DSH_BIN, ['plugin', '--profile', PROFILE, 'add', `link:${join(HERE, 'driver')}`], { cwd: REPO_ROOT, env: childEnv }))

  const dumpResult = await note('profile:dump-config', await run(DSH_BIN, ['--profile', PROFILE, '--dump-config'], { cwd: REPO_ROOT, env: childEnv }))
  const dumpConfig = dumpResult.stdout.toString('utf8')
  const profileManifest = JSON.parse(readFileSync(join(dshHome, 'profiles', PROFILE, 'package.json'), 'utf8'))

  // The distill route is pinned from the profile's own default-model row rather
  // than assumed: P0 measured the empty route as NO_ADAPTER, so an explicit
  // provider+model is what makes a captured turn distillable at all.
  const defaultRoute = parseDefaultRoute(dumpConfig)
  const distillRoute = {
    provider: process.env.DSH_SMOKE_DISTILL_PROVIDER ?? defaultRoute.provider ?? '',
    model: process.env.DSH_SMOKE_DISTILL_MODEL ?? defaultRoute.model ?? '',
  }

  // --- the passes --------------------------------------------------------------
  //
  // Measured host fact this shape rests on: a captured job is applied by the
  // queue worker's *boot* pass (which runs inside a Cordis invocation), while a
  // mid-session retry — which runs from a bare `setTimeout` — did not apply the
  // job within a 60 s hold in five consecutive isolated runs. The smoke therefore
  // takes each configuration through capture → real SIGKILL → restart, which is
  // the crash contract the design names, and records the in-process outcome as
  // its own observation instead of assuming it.
  const SCENARIO_TASK = '不要调用任何工具。请用一句话复述这个项目约定：本仓库的模块格式统一为 ESM，测试命令是 npm test。'
  const LIVE_TASK = '不要调用任何工具。请用一句话确认这个项目决定：数据库迁移必须在同一个事务里完成，失败整体回滚。'
  const IDLE_TASK = '不要调用任何工具。请只回答：已收到。'
  const seedConfig = (dryRun) => ({
    vaultPath: vault,
    distill: { ...distillRoute, dryRun },
    captureIdleMs: 15_000,
    autoCapture: true,
    indexBackend: 'sqlite',
    briefBudgetChars: 6000,
  })
  const recoverConfig = (dryRun) => ({ ...seedConfig(dryRun), captureIdleMs: 1000, autoCapture: false })

  const seedSpecs = {
    dryRunSeed: {
      key: 'dryRunSeed',
      holdMs: 20_000,
      env: { SCENARIO: '1', WAIT_RECEIPT: '0', KILL: '1' },
      config: seedConfig(true),
      task: SCENARIO_TASK,
    },
    liveSeed: {
      key: 'liveSeed',
      holdMs: 20_000,
      env: { SCENARIO: '0', WAIT_RECEIPT: '0', KILL: '1' },
      config: seedConfig(false),
      task: LIVE_TASK,
    },
  }
  const passes = {}
  const runPass = async (spec) => {
    const recordPath = join(recordsDir, `${spec.key}.jsonl`)
    writeFileSync(recordPath, '')
    const config = spec.config
    // Every seed pass starts from an empty queue, so the interruption lands on
    // the turn that pass just captured and never on an earlier cycle's leftover.
    // A recover pass must NOT clear: the killed job is exactly what it resumes.
    const cleared = spec.clearQueue === false ? [] : clearQueue(join(dshHome, 'data', 'obsidian-mem', 'pending'))
    writeProfilePatch(dshHome, config)
    const result = await note(`run:${spec.key}`, await run(DSH_BIN, ['--profile', PROFILE, spec.task], {
      cwd: repo,
      env: {
        ...childEnv,
        DSH_OBSIDIAN_MEM_SMOKE_RECORD: recordPath,
        DSH_OBSIDIAN_MEM_SMOKE_VAULT: vault,
        DSH_OBSIDIAN_MEM_SMOKE_SCENARIO: spec.env.SCENARIO,
        DSH_OBSIDIAN_MEM_SMOKE_WAIT_RECEIPT: spec.env.WAIT_RECEIPT,
        DSH_OBSIDIAN_MEM_SMOKE_KILL: spec.env.KILL,
        DSH_OBSIDIAN_MEM_SMOKE_HOLD_MS: String(spec.holdMs ?? HOLD_MS),
        DSH_OBSIDIAN_MEM_SMOKE_LLM_PROBE: spec.llmProbe === true ? '1' : '0',
      },
    }))
    const leftover = readPendingJobs(join(dshHome, 'data', 'obsidian-mem', 'pending'))
    passes[spec.key] = {
      config,
      recordPath,
      records: readRecords(recordPath),
      exit: { code: result.code, signal: result.signal, timedOut: result.timedOut },
      stdoutBytes: result.stdout.length,
      stderrBytes: result.stderr.length,
      clearedJobs: cleared,
      leftoverJobs: leftover.map((job) => jobView(job)),
    }
    return passes[spec.key]
  }

  /** Wait until one job's own debounce deadline is safely in the past. */
  const waitPastDue = async (job, captureIdleMs) => {
    if (job === null) return
    const dueAt = Date.parse(job.updatedAt ?? job.createdAt) + captureIdleMs
    const waitMs = dueAt - Date.now() + 2000
    if (waitMs > 0) await new Promise((resolvePromise) => setTimeout(resolvePromise, waitMs))
  }

  /**
   * One lane: capture a completed turn, SIGKILL the process at the durability
   * boundary, then restart and let the real worker resume the job.
   *
   * The model-backed distill aborts intermittently on this host (a
   * `finish.reason.kind === 'aborted'` terminal chunk with no signal of ours
   * aborted), so the lane retries with a FRESH turn up to three cycles rather
   * than hammering one bounded-failed job — a failed job is never retried
   * automatically (R43), and that refusal is itself the designed behaviour.
   *
   * The vault tree is hashed by the orchestrator on both sides of each restart,
   * which is the one observation the driver cannot make when the resume happens
   * before its hold ever starts.
   *
   * @param {{label: string, dryRun: boolean, task: string, scenarioOnFirstCycle: boolean}} lane - the lane.
   * @returns {Promise<object>} the lane's receipt, cycles and passes.
   */
  const runLane = async (lane) => {
    const cycles = []
    let scenarioPass = null
    let jobId = null
    let receipt = null
    for (let cycle = 1; cycle <= (lane.cycles ?? 3) && receipt === null; cycle += 1) {
      const seedKey = `${lane.label}Seed${cycle}`
      const recoverKey = `${lane.label}Recover${cycle}`
      const seed = await runPass({
        key: seedKey,
        holdMs: 20_000,
        llmProbe: lane.llmProbe === true && cycle === 1,
        env: { SCENARIO: lane.scenarioOnFirstCycle && cycle === 1 ? '1' : '0', WAIT_RECEIPT: '0', KILL: '1' },
        config: seedConfig(lane.dryRun),
        task: lane.task,
      })
      if (lane.scenarioOnFirstCycle && cycle === 1) scenarioPass = seed
      const job = readPendingJob(dshHome) ?? seed.leftoverJobs[0] ?? null
      jobId = job?.jobId ?? null
      await waitPastDue(job, seed.config.captureIdleMs)
      const treeBefore = hashTree(vault)
      const recover = await runPass({
        key: recoverKey,
        clearQueue: false,
        holdMs: lane.recoverHoldMs ?? 120_000,
        env: { SCENARIO: '0', WAIT_RECEIPT: '1', KILL: '0' },
        config: recoverConfig(lane.dryRun),
        task: IDLE_TASK,
      })
      const treeAfter = hashTree(vault)
      receipt = jobId === null ? null : (readReceipts(queueRoot).find((entry) => entry.jobId === jobId) ?? null)
      cycles.push({
        cycle,
        seedKey,
        recoverKey,
        jobId,
        jobState: seed.leftoverJobs[0]?.state ?? null,
        treeBefore,
        treeAfter,
        vaultChanged: canonicalTree(treeBefore) !== canonicalTree(treeAfter),
        receiptResult: receipt?.result ?? null,
        receiptDryRun: receipt?.dryRun ?? null,
        recoverExit: recover.exit,
        holdReceipt: recover.records.some((entry) => entry.name === 'smoke/hold' && entry.action === 'receipt'),
      })
    }
    // One more restart with nothing left to resume: the completed job must be
    // gone and no second receipt may appear for the same job id.
    const verify = await runPass({
      key: `${lane.label}Verify`,
      clearQueue: false,
      holdMs: 6000,
      env: { SCENARIO: '0', WAIT_RECEIPT: '1', KILL: '0' },
      config: recoverConfig(lane.dryRun),
      task: IDLE_TASK,
    })
    return { lane: lane.label, jobId, receipt, cycles, verify, scenarioPass }
  }

  /**
   * Apply one captured job through the documented `raw-durable` resume path.
   *
   * This is a fault injection, and it is labelled as one. The queue worker's own
   * model call cannot complete in this host (see `capture.modelLane` below and
   * `docs/smoke-results.md`): it aborts as soon as it runs, so a fresh distill
   * never produces a receipt here. The design's answer to an interrupted model
   * call is exactly `output.state === 'raw-durable'` — "the bytes are already
   * durable: re-validating them is the whole resume path" — and `runPendingJob`
   * takes that path WITHOUT a model call.
   *
   * So the job file is rewritten with a durable raw answer and the real worker
   * applies it in a real process. What this proves is the apply half: identities
   * are minted, notes are written, `dryRun` writes nothing, the restart is not
   * duplicated, and human files are untouched. What it does NOT prove is the
   * model call, which is reported separately and never claimed as PASS.
   *
   * @param {{label: string, dryRun: boolean, task: string}} lane - the lane.
   * @returns {Promise<object>} the lane's receipt, cycle and what was injected.
   */
  const runResumeLane = async (lane) => {
    const seedKey = `resume${lane.label}Seed`
    const recoverKey = `resume${lane.label}Recover`
    const seed = await runPass({
      key: seedKey,
      holdMs: 20_000,
      env: { SCENARIO: '0', WAIT_RECEIPT: '0', KILL: '1' },
      config: seedConfig(lane.dryRun),
      task: lane.task,
    })
    const job = readPendingJob(dshHome) ?? seed.leftoverJobs[0] ?? null
    if (job === null) return { lane: `resume${lane.label}`, jobId: null, receipt: null, cycle: null, injection: null, verify: null }
    const injection = injectRawDurable(job, lane)
    await waitPastDue(job, seed.config.captureIdleMs)
    const treeBefore = hashTree(vault)
    const recover = await runPass({
      key: recoverKey,
      clearQueue: false,
      holdMs: 120_000,
      env: { SCENARIO: '0', WAIT_RECEIPT: '1', KILL: '0' },
      config: recoverConfig(lane.dryRun),
      task: IDLE_TASK,
    })
    const treeAfter = hashTree(vault)
    const receipt = readReceipts(queueRoot).find((entry) => entry.jobId === job.jobId) ?? null
    const verify = await runPass({
      key: `resume${lane.label}Verify`,
      clearQueue: false,
      holdMs: 6000,
      env: { SCENARIO: '0', WAIT_RECEIPT: '1', KILL: '0' },
      config: recoverConfig(lane.dryRun),
      task: IDLE_TASK,
    })
    return {
      lane: `resume${lane.label}`,
      jobId: job.jobId,
      receipt,
      verify,
      injection,
      cycle: {
        jobId: job.jobId,
        seedExit: seed.exit,
        treeBefore,
        treeAfter,
        vaultChanged: canonicalTree(treeBefore) !== canonicalTree(treeAfter),
        receiptResult: receipt?.result ?? null,
        receiptDryRun: receipt?.dryRun ?? null,
        recoverExit: recover.exit,
      },
    }
  }

  /**
   * Rewrite one pending job's durable output as the `raw-durable` a distill that
   * was cut off would have left behind. The raw text is the documented contract
   * (`{items:[…]}` with a real committed evidence seq from this job).
   *
   * @param {object} job - the captured job, read from disk.
   * @param {{label: string}} lane - the lane being seeded.
   * @returns {object} what was injected, for the record.
   */
  function injectRawDurable(job, lane) {
    // `allowedEvents` entries are the committed event records themselves
    // (`{kind, seq, source}`), and `evidenceSeqs` accepts only their integers.
    const firstAllowed = Array.isArray(job.allowedEvents) && job.allowedEvents.length > 0 ? job.allowedEvents[0] : null
    const evidenceSeq = Number.isSafeInteger(firstAllowed?.seq) ? firstAllowed.seq : null
    const raw = JSON.stringify({
      items: [{
        type: 'convention',
        title: `恢复通道约定（${lane.label}）`,
        body: '冒烟恢复通道：本仓库的模块格式统一为 ESM，测试命令是 npm test。',
        tags: ['smoke', 'resume'],
        confidence: 0.9,
        assertion: 'stated',
        status: 'active',
        supersedesId: null,
        evidenceSeqs: evidenceSeq === null ? [] : [evidenceSeq],
      }],
    })
    const path = join(queueRoot, `${job.jobId}.json`)
    const rewritten = {
      ...job,
      state: 'pending',
      output: { state: 'raw-durable', raw, usage: null },
      attempts: 0,
      deferredReason: null,
    }
    delete rewritten.failedAt
    delete rewritten.lastError
    delete rewritten.nextAttemptAt
    delete rewritten.retriedAt
    writeFileSync(path, `${JSON.stringify(rewritten, null, 2)}
`)
    return { jobId: job.jobId, outputState: 'raw-durable', rawChars: [...raw].length, evidenceSeq, itemCount: 1 }
  }

  const queueRoot = join(dshHome, 'data', 'obsidian-mem', 'pending')
  const dryRunLane = args.only === 'live'
    ? { lane: 'dryRun', jobId: null, receipt: null, cycles: [], verify: null, scenarioPass: null }
    : await runLane({ label: 'dryRun', dryRun: true, task: SCENARIO_TASK, scenarioOnFirstCycle: true, llmProbe: true, cycles: 1, recoverHoldMs: 30_000 })
  const liveLane = args.only === 'dryRun'
    ? { lane: 'live', jobId: null, receipt: null, cycles: [], verify: null, scenarioPass: null }
    : await runLane({ label: 'live', dryRun: false, task: LIVE_TASK, scenarioOnFirstCycle: false, cycles: 1, recoverHoldMs: 30_000 })
  const resumeDryRunLane = args.only === 'live'
    ? { lane: 'resumedryRun', jobId: null, receipt: null, cycle: null, injection: null, verify: null }
    : await runResumeLane({ label: 'dryRun', dryRun: true, task: SCENARIO_TASK })
  const resumeLiveLane = args.only === 'dryRun'
    ? { lane: 'resumelive', jobId: null, receipt: null, cycle: null, injection: null, verify: null }
    : await runResumeLane({ label: 'live', dryRun: false, task: LIVE_TASK })

  // --- observations ------------------------------------------------------------
  const receipts = readReceipts(queueRoot)
  const vaultFiles = listFiles(vault).filter((path) => path.endsWith('.md') || path.startsWith('.obsidian/'))
  const memoryNotes = readMemoryNotes(vault)

  const scenarioRecords = dryRunLane.scenarioPass?.records ?? []
  const dryRecords = scenarioRecords
  const stage = (records, name) => records.find((entry) => entry.name === 'smoke/stage' && entry.stage === name) ?? null
  const scenario = {
    bind: stage(dryRecords, 'bind'),
    docWrite: stage(dryRecords, 'doc-write'),
    searchCn: stage(dryRecords, 'search-cn'),
    supersede: stage(dryRecords, 'supersede'),
    externalEdit: stage(dryRecords, 'external-edit'),
    humanOwned: stage(dryRecords, 'human-owned'),
    lintReadonly: stage(dryRecords, 'lint-readonly'),
    briefTool: stage(dryRecords, 'brief-tool'),
    logWrite: stage(dryRecords, 'log-write'),
    tools: dryRecords.find((entry) => entry.name === 'smoke/tools') ?? null,
  }

  const recallRecords = dryRecords.filter((entry) => entry.name === 'smoke/recall')
  const firstStepRecalls = recallRecords.filter((entry) => entry.beforeFirstRequest === true)
  const budget = 6000

  // The vault facts are re-derived from disk here AND independently by verify.mjs.
  const docPath = scenario.docWrite?.path ?? null
  const externalPath = scenario.externalEdit?.path ?? null
  const humanPath = scenario.humanOwned?.path ?? null
  const humanNow = humanPath === null ? null : readFileOrNull(join(vault, humanPath))
  const externalNow = externalPath === null ? null : readFileOrNull(join(vault, externalPath))

  const dryRunJobId = resumeDryRunLane.jobId
  const liveJobId = resumeLiveLane.jobId

  const duplicateNoteIds = duplicateIds(memoryNotes)
  const receiptsForLive = receipts.filter((receipt) => receipt.jobId === liveJobId)

  // The in-process observation the smoke must not overstate: did the worker apply
  // the captured job during the session that captured it, or only on a restart?
  const seedRecords = Object.entries(passes)
    .filter(([key]) => key.includes('Seed'))
    .flatMap(([, value]) => value.records)
  const inProcessApplied = {
    seedsObserved: seedRecords.filter((entry) => entry.name === 'smoke/hold' && entry.action === 'job-observed').length,
    seedPolls: seedRecords.filter((entry) => entry.name === 'smoke/poll').length,
    seedAttempts: seedRecords
      .filter((entry) => entry.name === 'smoke/poll')
      .map((entry) => entry.job?.attempts ?? 0),
    anySeedSawAnAttempt: seedRecords.some((entry) => entry.name === 'smoke/poll' && (entry.job?.attempts ?? 0) > 0),
  }

  const record = {
    schema: 1,
    startedAt: new Date().toISOString(),
    repoRoot: REPO_ROOT,
    versions: {
      dsh: (await run(DSH_BIN, ['--version'], { env: childEnv })).stdout.toString('utf8').trim(),
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      obsidian: process.env.DSH_SMOKE_OBSIDIAN_VERSION ?? null,
    },
    paths: { baseDir, dshHome, vault, repo, queueRoot, record: outPath },
    distillRoute,
    profile: {
      name: PROFILE,
      bundles: profileManifest?.dsh?.profile?.bundles ?? null,
      driverInstalled: (profileManifest?.dependencies?.[DRIVER_PACKAGE] ?? null) !== null,
      dumpConfigHasRow: dumpConfig.includes(`id: ${ROW_ID}`) || dumpConfig.includes(`- id: ${ROW_ID}`),
      dumpConfigRowLine: dumpConfig.split('\n').find((line) => line.includes(`id: ${ROW_ID}`)) ?? null,
      dumpConfigChars: dumpConfig.length,
      dumpConfigPath: join(recordsDir, 'dump-config.yml'),
    },
    credentialRoute: credential.source,
    passes: Object.fromEntries(Object.entries(passes).map(([key, value]) => [key, {
      config: value.config,
      exit: value.exit,
      recordCount: value.records.length,
      stdoutBytes: value.stdoutBytes,
      stderrBytes: value.stderrBytes,
      clearedJobs: value.clearedJobs ?? [],
      leftoverJobs: value.leftoverJobs ?? [],
      sessionIds: [...new Set(value.records.filter((entry) => typeof entry.id === 'string').map((entry) => entry.id))],
      turnReasons: value.records.filter((entry) => entry.name === 'smoke/turn').map((entry) => entry.reason),
    }])),
    steps,
    checks: {
      pluginRowInDumpConfig: new RegExp(`^- id: ${ROW_ID}$`, 'm').test(dumpConfig),
      driverRowInDumpConfig: new RegExp('^- id: obsidian-mem-smoke-driver$', 'm').test(dumpConfig),
      briefBudgetChars: budget,
      firstStepBriefCount: firstStepRecalls.length === 0 ? 0 : Math.max(...firstStepRecalls.map((entry) => entry.briefsBeforeFirstRequest ?? 1)),
      firstStepBriefChars: firstStepRecalls.length === 0 ? null : firstStepRecalls[firstStepRecalls.length - 1].chars,
      firstStepBriefSha256: firstStepRecalls.length === 0 ? null : firstStepRecalls[firstStepRecalls.length - 1].sha256,
      sessionBriefCount: recallRecords.length,
      firstRecallSeq: firstStepRecalls[0]?.seq ?? null,
      tools: scenario.tools,
      chineseSearch: scenario.searchCn,
      documentWrite: {
        ...scenario.docWrite,
        existsOnDisk: docPath !== null && existsSync(join(vault, docPath)),
      },
      supersede: scenario.supersede,
      externalEdit: {
        ...scenario.externalEdit,
        existsOnDisk: externalPath !== null && existsSync(join(vault, externalPath)),
        humanLineOnDiskAfterAllPasses: externalNow === null ? false : externalNow.toString('utf8').includes('人工外部编辑的一行：这一行必须存活。'),
        obsidianUntouched: sha256(JSON.stringify(hashTree(join(vault, '.obsidian')))) === sha256(JSON.stringify(obsidianBefore)),
      },
      humanOwned: {
        ...scenario.humanOwned,
        existsOnDisk: humanPath !== null && existsSync(join(vault, humanPath)),
        hashOnDiskAfterAllPasses: humanNow === null ? null : sha256(humanNow),
        byteIdenticalOnDisk: humanNow !== null && scenario.humanOwned?.hashBefore === sha256(humanNow),
      },
      lintReadonly: scenario.lintReadonly,
      briefTool: scenario.briefTool,
      logWrite: scenario.logWrite,
      capture: {
        // The capture half, observed on the model lane: a completed turn became a
        // durable job, and a real SIGKILL at that boundary left it on disk.
        inProcessApplied,
        modelLane: {
          dryRun: { jobId: dryRunLane.jobId, cycles: dryRunLane.cycles, receipt: dryRunLane.receipt },
          live: { jobId: liveLane.jobId, cycles: liveLane.cycles, receipt: liveLane.receipt },
          llmProbe: (dryRunLane.scenarioPass?.records ?? []).find((entry) => entry.name === 'smoke/llm-probe') ?? null,
        },
        // The apply half, observed on the model-free resume lane. `injection`
        // records exactly what was placed on the job, so the claim cannot be read
        // as "a fresh model call was verified".
        dryRunJobId: resumeDryRunLane.jobId,
        dryRunReceipt: resumeDryRunLane.receipt,
        dryRunCycle: resumeDryRunLane.cycle,
        dryRunInjection: resumeDryRunLane.injection,
        dryRunErrorAudit: dryRunLane.cycles.map((entry) => ({ cycle: entry.cycle, receiptResult: entry.receiptResult, jobState: entry.jobState })),
        liveJobId: resumeLiveLane.jobId,
        liveReceipt: resumeLiveLane.receipt,
        liveCycle: resumeLiveLane.cycle,
        liveInjection: resumeLiveLane.injection,
        laneVerify: {
          dryRun: { exit: resumeDryRunLane.verify?.exit ?? null },
          live: { exit: resumeLiveLane.verify?.exit ?? null },
        },
      },
      restart: {
        dryRunKilledBy: resumeDryRunLane.cycle?.seedExit?.signal ?? null,
        killedBy: resumeLiveLane.cycle?.seedExit?.signal ?? null,
        jobId: resumeLiveLane.jobId,
        receiptCount: receipts.filter((entry) => entry.jobId === resumeLiveLane.jobId).length,
        receiptsTotal: receipts.length,
        duplicateNoteIds,
        memoryNoteCount: memoryNotes.length,
        noteIds: memoryNotes.map((note) => note.id).filter((id) => typeof id === 'string').sort(),
        noPendingJobAfterRecovery: readPendingJobs(queueRoot).length === 0,
      },
      realHomeUnchanged: null,
    },
    vault: {
      files: vaultFiles,
      obsidianBefore,
      obsidianAfter: hashTree(join(vault, '.obsidian')),
      memoryNotes: memoryNotes.map((note) => ({ path: note.path, id: note.id, type: note.type, status: note.status, tags: note.tags })),
    },
    realHome: { before: homeBefore, after: realHomeFingerprint() },
  }
  record.checks.realHomeUnchanged = sha256(JSON.stringify(homeBefore)) === sha256(JSON.stringify(record.realHome.after))

  writeFileSync(join(recordsDir, 'dump-config.yml'), dumpConfig)
  writeFileSync(outPath, `${JSON.stringify(record, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify({
    record: outPath,
    baseDir,
    vault,
    profileRowPresent: record.checks.pluginRowInDumpConfig,
    firstStepBriefCount: record.checks.firstStepBriefCount,
    firstStepBriefChars: record.checks.firstStepBriefChars,
    chineseHit: record.checks.chineseSearch?.ok === true,
    supersedeOk: record.checks.supersede?.ok === true,
    externalEditSurvived: record.checks.externalEdit?.ok === true,
    humanOwnedSurvived: record.checks.humanOwned?.ok === true && record.checks.humanOwned?.byteIdenticalOnDisk === true,
    lintReadOnly: record.checks.lintReadonly?.ok === true,
    dryRunReceipt: record.checks.capture.dryRunReceipt?.result ?? null,
    dryRunWroteNothing: record.checks.capture.dryRunReceipt?.result === 'dry-run' && record.checks.capture.dryRunCycle?.vaultChanged === false,
    dryRunJobId,
    liveJobId,
    liveReceipt: record.checks.capture.liveReceipt?.result ?? null,
    liveWroteSomething: record.checks.capture.liveReceipt?.result === 'applied' && record.checks.capture.liveCycle?.vaultChanged === true,
    receiptsForLive: record.checks.restart.receiptCount,
    duplicateNoteIds: record.checks.restart.duplicateNoteIds,
    inProcessApplied,
    realHomeUnchanged: record.checks.realHomeUnchanged,
    exitCodes: Object.fromEntries(Object.entries(passes).map(([key, value]) => [key, value.exit.code ?? value.exit.signal])),
  }, null, 2)}\n`)
}

/** Write the profile patch that pins the plugin row's config for one pass. */
function writeProfilePatch(dshHome, config) {
  const patch = [
    '# Written by test/smoke/run-smoke.mjs for one pass. Replaced between passes.',
    '- id: obsidian-mem',
    '  config:',
    `    vaultPath: ${JSON.stringify(config.vaultPath)}`,
    `    initGitOnCreate: true`,
    `    injectBrief: true`,
    `    briefBudgetChars: ${config.briefBudgetChars}`,
    `    autoCapture: ${config.autoCapture}`,
    `    captureIdleMs: ${config.captureIdleMs}`,
    `    indexBackend: ${config.indexBackend}`,
    '    distill:',
    `      provider: ${JSON.stringify(config.distill.provider)}`,
    `      model: ${JSON.stringify(config.distill.model)}`,
    `      dryRun: ${config.distill.dryRun}`,
    '      maxItems: 3',
    '      minConfidence: 0.3',
    '      maxRetries: 4',
    '      maxOutputTokens: 800',
    '      timeoutMs: 60000',
    '',
  ].join('\n')
  writeFileSync(join(dshHome, 'profiles', PROFILE, 'cordis.patch.yml'), patch, { mode: 0o600 })
}

/**
 * Remove any pending job files left in the temp queue, returning their names.
 *
 * The receipts and the processed floor are deliberately kept: only the pending
 * work is cleared, so a crash-recovery observation is never confused with work
 * an earlier pass left behind.
 *
 * @param {string} queueRoot - the temp queue root.
 * @returns {string[]} the removed job file names.
 */
function clearQueue(queueRoot) {
  let names = []
  try {
    names = readdirSync(queueRoot).filter((name) => name.endsWith('.json'))
  } catch {
    return []
  }
  for (const name of names) rmSync(join(queueRoot, name), { force: true })
  return names
}

/**
 * The profile's own default model route, read from the composed config dump.
 *
 * The dump is "one loadable YAML document", so it is parsed rather than grepped
 * for line offsets. `agent-default-model` is the row that carries the route the
 * isolated profile would actually use.
 *
 * @param {string} dump - the `--dump-config` output.
 * @returns {{provider: string|null, model: string|null}} the route, best effort.
 */
function parseDefaultRoute(dump) {
  try {
    const document = YAML.parse(dump, { logLevel: 'silent' })
    if (!Array.isArray(document)) return { provider: null, model: null }
    const row = document.find((entry) => entry?.id === 'agent-default-model')
    return {
      provider: typeof row?.config?.provider === 'string' ? row.config.provider : null,
      model: typeof row?.config?.model === 'string' ? row.config.model : null,
    }
  } catch {
    return { provider: null, model: null }
  }
}

/** Every JSONL record one run wrote, parsed; a malformed line is kept as an error entry. */
function readRecords(recordPath) {
  if (!existsSync(recordPath)) return []
  return readFileSync(recordPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .flatMap((line, index) => {
      try {
        return [JSON.parse(line)]
      } catch (error) {
        return [{ name: 'smoke/malformed', line: index + 1, error: error.message }]
      }
    })
}

/** Every pending job in the temp queue, with a record-safe view of each. */
function readPendingJobs(queueRoot) {
  let names = []
  try {
    names = readdirSync(queueRoot).filter((name) => name.endsWith('.json'))
  } catch {
    return []
  }
  return names.map((name) => {
    try {
      return JSON.parse(readFileSync(join(queueRoot, name), 'utf8'))
    } catch {
      return { jobId: name.replace(/\.json$/, ''), unreadable: true }
    }
  })
}

/** A record-safe view of one pending job: state and error codes, never its input text. */
function jobView(job) {
  return {
    jobId: job?.jobId ?? null,
    sessionId: job?.sessionId ?? null,
    fromSeq: job?.fromSeq ?? null,
    toSeq: job?.toSeq ?? null,
    state: job?.state ?? null,
    attempts: job?.attempts ?? null,
    deferredReason: job?.deferredReason ?? null,
    route: job?.route ?? null,
    outputState: job?.output?.state ?? null,
    lastErrorCode: job?.lastError?.code ?? null,
    lastErrorName: job?.lastError?.name ?? null,
    lastErrorMessage: typeof job?.lastError?.message === 'string' ? job.lastError.message.slice(0, 200) : null,
    lastErrorAt: job?.lastError?.at ?? null,
    createdAt: job?.createdAt ?? null,
    updatedAt: job?.updatedAt ?? null,
    failedAt: job?.failedAt ?? null,
    safeInputChars: typeof job?.safeInput === 'string' ? job.safeInput.length : null,
    allowedEvents: Array.isArray(job?.allowedEvents) ? job.allowedEvents.length : null,
  }
}

/** The single pending job left in the temp queue, or `null`. */
function readPendingJob(dshHome) {
  const queueRoot = join(dshHome, 'data', 'obsidian-mem', 'pending')
  let names = []
  try {
    names = readdirSync(queueRoot).filter((name) => name.endsWith('.json'))
  } catch {
    return null
  }
  if (names.length === 0) return null
  try {
    return JSON.parse(readFileSync(join(queueRoot, names[0]), 'utf8'))
  } catch {
    return { jobId: names[0].replace(/\.json$/, ''), updatedAt: null, createdAt: null }
  }
}

/** Every result receipt under a queue root, newest last. */
function readReceipts(queueRoot) {
  const receiptsRoot = join(queueRoot, 'receipts')
  const found = []
  for (const path of listFiles(receiptsRoot)) {
    if (!path.endsWith('.json')) continue
    try {
      found.push(JSON.parse(readFileSync(join(receiptsRoot, path), 'utf8')))
    } catch {
      /* an unreadable receipt is reported by its absence, not by a crash */
    }
  }
  return found.sort((a, b) => String(a.at).localeCompare(String(b.at)))
}

/** Every vault document (never the transaction engine's private `.history` copies). */
function readMemoryNotes(vault) {
  const notes = []
  for (const path of listFiles(vault)) {
    if (!path.endsWith('.md') || path.startsWith('.obsidian/') || path.startsWith('_meta/.history/')) continue
    let text
    try {
      text = readFileSync(join(vault, path), 'utf8')
    } catch {
      continue
    }
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
    let data = null
    if (frontmatter !== null) {
      try {
        data = YAML.parse(frontmatter[1])
      } catch {
        data = null
      }
    }
    notes.push({
      path,
      id: typeof data?.id === 'string' ? data.id : null,
      type: typeof data?.type === 'string' ? data.type : null,
      status: typeof data?.status === 'string' ? data.status : null,
      tags: Array.isArray(data?.tags) ? data.tags : (data?.tags === undefined ? null : 'not-a-list'),
      trust: typeof data?.trust === 'string' ? data.trust : null,
      sha256: sha256(text),
    })
  }
  return notes
}

/** Ids that appear on more than one note. */
function duplicateIds(notes) {
  const seen = new Map()
  for (const note of notes) {
    if (note.id === null) continue
    seen.set(note.id, (seen.get(note.id) ?? 0) + 1)
  }
  return [...seen.entries()].filter(([, count]) => count > 1).map(([id]) => id)
}

function readFileOrNull(path) {
  try {
    return readFileSync(path)
  } catch {
    return null
  }
}
