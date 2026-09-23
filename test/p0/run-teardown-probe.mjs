#!/usr/bin/env node
// Task 18b teardown probe: builds a throwaway DSH home, installs
// `test/p0/teardown` with `link:`, runs ONE real headless turn against the real
// model route, prints the sanitized records, and asserts the host facts that
// `docs/p0-compatibility.md` §9 records.
//
// What it establishes:
//   * a model call from a BARE timer inside the live window completes normally;
//   * the host disposes the whole plugin tree when the run's session completes,
//     and every `ctx.get(...)` path (strict and non-strict, and a handle captured
//     while the service was live) then fails;
//   * an IN-FLIGHT stream is not killed by that disposal;
//   * the terminal `finish.reason.kind === 'aborted'` the queue worker measured is
//     produced by the worker's OWN disposer calling `abort()`.
//
// Safety: `DSH_HOME` is always a fresh temp directory, the credential only ever
// travels in the child's environment, and the record holds no prompt, response,
// note or credential text. The real `~/.dsh` is fingerprinted before and after.
//
// Usage: node test/p0/run-teardown-probe.mjs [--keep] [--task "<one short task>"]
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..')
const DSH_BIN = process.env.DSH_BIN ?? 'dsh'
const PROFILE = 'mem-teardown'
const ROW_ID = 'obsidian-mem-teardown-probe'
const KEEP = process.argv.includes('--keep')
const TASK = process.argv.includes('--task')
  ? process.argv[process.argv.indexOf('--task') + 1]
  : '不要调用任何工具。请只回答一个词：OK'

const sha256 = (value) => createHash('sha256').update(value).digest('hex')

/** Refuse an absolute path outside the temp roots: this probe never writes a real vault. */
function assertTempPath(candidate, label) {
  const absolute = resolve(candidate)
  const roots = [resolve(tmpdir()), '/tmp', '/private/tmp', '/var/folders']
  if (!roots.some((root) => absolute === root || absolute.startsWith(root + sep))) {
    throw new Error(`${label} must live under a temporary root, refusing: ${absolute}`)
  }
  return absolute
}

/** Resolve the model credential without printing or persisting it. */
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
    /* an unreadable store is reported as "no credential" */
  }
  return null
}

/** Run one child process to completion, capturing stdout/stderr as buffers. */
function run(command, commandArgs, options = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, commandArgs, { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout = []
    const stderr = []
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? 240_000)
    child.stdout.on('data', (chunk) => stdout.push(chunk))
    child.stderr.on('data', (chunk) => stderr.push(chunk))
    child.on('error', (error) => {
      clearTimeout(timer)
      resolvePromise({ code: null, signal: null, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), spawnError: error.message })
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolvePromise({ code, signal, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) })
    })
  })
}

/** The real DSH home files that must stay byte-identical, as `{path: sha256}`. */
function realHomeFingerprint() {
  const home = join(homedir(), '.dsh')
  const map = {}
  for (const path of [
    'cordis.patch.yml', 'settings.yaml', '.credentials.yaml',
    'profiles/web/package.json', 'profiles/web/pnpm-workspace.yaml', 'profiles/web/cordis.patch.yml',
  ]) {
    try {
      map[path] = sha256(readFileSync(join(home, path)))
    } catch {
      map[path] = 'absent'
    }
  }
  try {
    map['profiles/'] = sha256(readdirSync(join(home, 'profiles')).sort().join('\n'))
  } catch {
    map['profiles/'] = 'absent'
  }
  return map
}

const checks = []
/** Record one assertion and print it in the probe's own vocabulary. */
function check(id, ok, detail) {
  checks.push({ id, ok: ok === true })
  process.stdout.write(`  ${ok === true ? 'PASS' : 'FAIL'} ${id} — ${detail}\n`)
}

main().catch((error) => {
  process.stderr.write(`run-teardown-probe: ${error?.stack ?? error}\n`)
  process.exit(1)
})

async function main() {
  const credential = resolveCredential()
  if (credential === null) {
    process.stderr.write('run-teardown-probe: no DEEPSEEK_API_KEY in the environment and none in the credentials store; refusing to run without a model route\n')
    process.exit(2)
  }

  const baseDir = assertTempPath(mkdtempSync(join(tmpdir(), 'dsh-obsidian-mem-teardown-')), 'baseDir')
  const dshHome = join(baseDir, 'home')
  const repo = join(baseDir, 'repo')
  const recordPath = join(baseDir, 'teardown.jsonl')
  for (const directory of [dshHome, repo]) mkdirSync(directory, { recursive: true })
  writeFileSync(recordPath, '')
  writeFileSync(join(repo, 'README.md'), '# teardown probe repository\n')
  await run('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  await run('git', ['add', 'README.md'], { cwd: repo })
  await run('git', ['-c', 'user.name=probe', '-c', 'user.email=probe@example.invalid', 'commit', '-q', '-m', 'chore: seed'], { cwd: repo })

  const homeBefore = realHomeFingerprint()
  const env = { ...process.env, DSH_HOME: dshHome, DEEPSEEK_API_KEY: credential.value }

  await run(DSH_BIN, ['--profile', PROFILE, '--from-default-profile', 'headless', '--dump-config'], { cwd: REPO_ROOT, env })
  await run(DSH_BIN, ['plugin', '--profile', PROFILE, 'add', `link:${join(HERE, 'teardown')}`], { cwd: REPO_ROOT, env })
  const dump = await run(DSH_BIN, ['--profile', PROFILE, '--dump-config'], { cwd: REPO_ROOT, env })

  const result = await run(DSH_BIN, ['--profile', PROFILE, TASK], {
    cwd: repo,
    env: { ...env, DSH_OBSIDIAN_MEM_TEARDOWN_RECORD: recordPath },
  })

  const records = readFileSync(recordPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line))

  const find = (label) => records.find((entry) => entry.rec === 'llm' && entry.label === label) ?? null
  const disposal = records.find((entry) => entry.rec === 'disposer') ?? null
  const strictLive = records.find((entry) => entry.rec === 'vis' && entry.llm?.strictHas === true) ?? null
  const afterDisposal = records.find(
    (entry) => entry.rec === 'vis' && disposal !== null && entry.t > disposal.t && entry.llm?.strictHas === false && entry.llm?.looseHas === false,
  ) ?? null
  const bare = find('bare-timer-live-window')
  const workerSignal = find('live-window-worker-signal')
  const privateSignal = find('live-window-private-signal')
  const inHandler = find('in-handler-control')
  const freshAfter = find('post-run-fresh-lookup')
  const capturedAfter = find('post-run-captured-handle')

  const answered = (entry) => entry !== null && ['stop', 'max-tokens'].includes(entry.finishKind)

  check('probe-row-registered', new RegExp(`^- id: ${ROW_ID}$`, 'm').test(dump.stdout.toString('utf8')), `dump-config has "- id: ${ROW_ID}"`)
  check('run-completed', result.code === 0 && result.signal === null, `exit=${result.code ?? result.signal} stdoutBytes=${result.stdout.length} stderrBytes=${result.stderr.length}`)
  check(
    'service-is-live-with-an-active-provider-fiber',
    strictLive !== null && strictLive.llm.providerFiber === 'LlmRuntime' && strictLive.llm.providerState === 'ACTIVE',
    strictLive === null ? 'no record saw a live `llm`' : `label=${strictLive.label} provider=${strictLive.llm.providerFiber}/${strictLive.llm.providerState} isolateKey=${strictLive.llm.isolateKey}`,
  )
  check(
    'in-handler-call-is-a-real-answer',
    answered(inHandler) && inHandler.chunks > 0,
    inHandler === null ? 'no in-handler control record' : `finish=${inHandler.finishKind} chunks=${inHandler.chunks} ms=${inHandler.ms}`,
  )
  check(
    'bare-timer-in-the-live-window-is-a-real-answer',
    answered(bare),
    bare === null ? 'no bare-timer record' : `finish=${bare.finishKind} chunks=${bare.chunks} ms=${bare.ms}`,
  )
  check(
    'the-tree-is-disposed-at-the-end-of-the-run',
    disposal !== null && afterDisposal !== null,
    disposal === null ? 'no disposer record' : `disposer t=${disposal.t}; after it, ctx.get('llm') strict=false loose=false at t=${afterDisposal?.t ?? '-'}`,
  )
  check(
    'an-in-flight-stream-survives-the-disposal',
    privateSignal !== null && answered(privateSignal) && privateSignal.callerAbortedAtFinish !== true &&
      disposal !== null && privateSignal.finishedAt > disposal.t,
    privateSignal === null ? 'no private-signal record' : `finish=${privateSignal.finishKind} ms=${privateSignal.ms} finishedAt=${privateSignal.finishedAt} (disposer t=${disposal?.t ?? '-'})`,
  )
  check(
    'the-worker-signal-disposer-abort-is-what-produces-aborted',
    workerSignal !== null && workerSignal.finishKind === 'aborted' && workerSignal.callerAbortedAtFinish === true &&
      disposal !== null && Math.abs(workerSignal.finishedAt - disposal.t) <= 1000,
    workerSignal === null
      ? 'no worker-signal record'
      : `finish=${workerSignal.finishKind} failureCode=${workerSignal.failureCode} callerAbortedAtFinish=${workerSignal.callerAbortedAtFinish} finishedAt=${workerSignal.finishedAt} (disposer t=${disposal?.t ?? '-'})`,
  )
  check(
    'no-lookup-path-works-after-the-disposal',
    (freshAfter === null || answered(freshAfter) === false) && (capturedAfter === null || answered(capturedAfter) === false),
    `fresh=${freshAfter?.reason ?? freshAfter?.finishKind ?? '-'}/${freshAfter?.failureCode ?? '-'} captured=${capturedAfter?.finishKind ?? '-'}/${capturedAfter?.failureCode ?? '-'}`,
  )

  const homeAfter = realHomeFingerprint()
  check('real-dsh-home-unchanged', sha256(JSON.stringify(homeBefore)) === sha256(JSON.stringify(homeAfter)), 'the real ~/.dsh fingerprint is byte-identical')
  check('real-data-dir-absent', !existsSync(join(homedir(), '.dsh', 'data')), '~/.dsh/data does not exist')
  check('real-skills-only-ultramath', JSON.stringify(readdirSync(join(homedir(), '.dsh', 'skills'))) === JSON.stringify(['ultramath']), `~/.dsh/skills = ${JSON.stringify(readdirSync(join(homedir(), '.dsh', 'skills')))}`)
  check('default-vault-absent', !existsSync(join(homedir(), 'Documents', 'dsh-memory')), '~/Documents/dsh-memory does not exist')

  process.stdout.write(`run-teardown-probe: credentialRoute=${credential.source} records=${records.length}\n`)
  process.stdout.write('--- records (metadata only) ---\n')
  for (const entry of records) process.stdout.write(`${JSON.stringify(entry)}\n`)

  if (!KEEP) rmSync(baseDir, { recursive: true, force: true })

  const failed = checks.filter((entry) => !entry.ok)
  process.stdout.write(`run-teardown-probe: ${failed.length === 0 ? 'OK' : `${failed.length} FAILED`} (${checks.length} assertion(s))\n`)
  process.exit(failed.length === 0 ? 0 : 1)
}
