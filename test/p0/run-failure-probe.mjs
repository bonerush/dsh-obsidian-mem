// Real model + native DSH session over a temporary home, repo and vault.
// Usage: DSH_BIN=/absolute/dsh node test/p0/run-failure-probe.mjs
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'
import { validateConfig } from '../../lib/config.js'
import { createMemoryServices } from '../../lib/services.js'
import { parseNote } from '../../lib/vault.js'
import { listCurationProposals, readCurationProposal } from '../../lib/curation-proposals.js'

const checkout = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const base = mkdtempSync(join(tmpdir(), 'dsh-failure-probe-'))
const home = join(base, 'home')
const repo = join(base, 'repo')
const vault = join(base, 'vault')
const dataRoot = join(home, 'data/obsidian-mem')
for (const path of [home, repo]) mkdirSync(path, { recursive: true })
execFileSync('git', ['init', '-q'], { cwd: repo })
const cli = process.env.DSH_BIN ?? 'dsh'
const credential =
  process.env.DEEPSEEK_API_KEY ??
  YAML.parse(readFileSync(join(homedir(), '.dsh/.credentials.yaml'), 'utf8'))?.refs
    ?.DEEPSEEK_API_KEY
assert.ok(typeof credential === 'string' && credential !== '', 'a model credential is required')
const env = {
  ...process.env,
  DSH_HOME: home,
  DEEPSEEK_API_KEY: credential,
  FAILURE_PROBE_RECORD: join(base, 'events.jsonl'),
}
const fingerprint = () =>
  ['cordis.patch.yml', 'profiles/desktop/cordis.patch.yml', '.credentials.yaml'].map((path) => {
    const file = join(homedir(), '.dsh', path)
    return existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : null
  })
const before = fingerprint()

/** Discard child text; the saved record contains exit status and byte counts only. */
function run(args, extra = {}) {
  return new Promise((done, reject) => {
    const child = spawn(cli, args, {
      cwd: repo,
      env: { ...env, ...extra },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdoutBytes = 0
    let stderrBytes = 0
    child.stdout.on('data', (data) => {
      stdoutBytes += data.length
    })
    child.stderr.on('data', (data) => {
      stderrBytes += data.length
    })
    const timer = setTimeout(() => child.kill('SIGKILL'), 180_000)
    child.on('error', reject)
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      done({ code, signal, stdoutBytes, stderrBytes })
    })
  })
}

const setup = []
setup.push(
  await run(['--profile', 'failure', '--from-default-profile', 'headless', '--dump-config']),
)
setup.push(await run(['plugin', '--profile', 'failure', 'add', `link:${checkout}`]))
setup.push(
  await run([
    'plugin',
    '--profile',
    'failure',
    'add',
    `link:${join(checkout, 'test/smoke/failure-driver')}`,
  ]),
)
assert.ok(
  setup.every((result) => result.code === 0),
  'isolated profile setup must succeed',
)
const services = createMemoryServices({
  config: validateConfig({ vaultPath: vault, initGitOnCreate: false }),
  dataRoot,
  cwd: repo,
  home,
})
const seed = await services.write({
  type: 'gotcha',
  title: 'ENOENT not-found probe protocol',
  body: 'The probe reports ENOENT not-found until mode is repair. When the probe fails repeatedly, set mode to repair and verify that the probe returns ok.',
})
await services.close()
writeFileSync(
  join(home, 'profiles/failure/cordis.patch.yml'),
  YAML.stringify([
    {
      id: 'obsidian-mem',
      config: {
        vaultPath: vault,
        initGitOnCreate: false,
        autoCurate: false,
        briefBudgetChars: 600,
        recallBudgetChars: 900,
        captureIdleMs: 1000,
        distill: {
          provider: 'deepseek-official',
          model: 'deepseek-flash',
          maxItems: 4,
          maxOutputTokens: 6000,
        },
      },
    },
    {
      id: 'agent-default-model',
      config: { provider: 'deepseek-official', model: 'deepseek-flash' },
    },
  ]),
  { mode: 0o600 },
)
const first = await run(
  [
    '--profile',
    'failure',
    '执行隔离验收：直接调用 probe，mode=normal，连续执行三次，每次一个调用。三次失败后根据自动提供的项目记忆选择修复方式，调用 probe 验证成功，成功后立即说明经过并结束，不再负向验证。不要提前调用记忆工具，也不要使用其他工具。',
  ],
  { FAILURE_PROBE_KILL: '1' },
)
const recovery = await run(['--profile', 'failure', 'Reply with OK only.'], {
  FAILURE_PROBE_KILL: '0',
})
assert.ok(
  existsSync(env.FAILURE_PROBE_RECORD),
  `native driver did not start: ${JSON.stringify({ base, first, recovery })}`,
)
const events = readFileSync(env.FAILURE_PROBE_RECORD, 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line))
const receiptDir = join(dataRoot, 'pending/receipts')
const receipts = existsSync(receiptDir)
  ? readdirSync(receiptDir).flatMap((project) =>
      readdirSync(join(receiptDir, project)).map((file) =>
        JSON.parse(readFileSync(join(receiptDir, project, file), 'utf8')),
      ),
    )
  : []
const notes = []
function walk(path) {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const file = join(path, entry.name)
    if (entry.isDirectory() && !entry.name.startsWith('.')) walk(file)
    else if (entry.isFile() && entry.name.endsWith('.md')) {
      const note = parseNote(readFileSync(file))
      if (note.data?.type === 'gotcha' && note.data.id !== seed.id)
        notes.push({
          assertion: note.data.assertion,
          status: note.data.status,
          inbox: file.includes('/Inbox/'),
        })
    }
  }
}
walk(vault)
const projectId = JSON.parse(readFileSync(join(repo, '.obsidian-mem'), 'utf8')).projectId
const listing = await listCurationProposals({ dataRoot, projectId, state: 'pending' })
const proposals = []
for (const entry of listing.proposals) {
  const proposal = await readCurationProposal({ dataRoot, projectId, proposalId: entry.proposalId })
  const item = proposal.operation?.item
  if (item?.type === 'gotcha')
    proposals.push({
      kind: proposal.kind,
      assertion: item.assertion,
      status: item.status,
      inbox: item.inbox,
      evidenceCount: item.evidenceSeqs.length,
    })
}
const failureRecalls = events.filter(
  (event) => event.type === 'recall' && event.trigger === 'failure',
)
const failures = events.filter(
  (event) => event.type === 'tool/result' && event.probe && event.isError,
)
const recoveryResult = events.find(
  (event) =>
    event.type === 'tool/result' && event.probe && !event.isError && event.seq > failures[2]?.seq,
)
const checks = {
  hardFailures: failures.length >= 3,
  sameTurnRecall:
    failureRecalls.length === 1 &&
    failures.every((event) => event.turn === 1) &&
    failureRecalls[0].seq > failures[2]?.seq &&
    failureRecalls[0].seq < recoveryResult?.seq,
  verifiedRecovery: recoveryResult?.turn === 1,
  budget: failureRecalls.every((event) => event.chars <= 900),
  interruptedAfterCapture:
    first.signal === 'SIGKILL' && events.some((event) => event.type === 'durable-job'),
  recovery: recovery.code === 0 && receipts.length > 0,
  inferredCandidate: [...notes, ...proposals].some(
    (note) => note.assertion === 'inferred' && note.status === 'provisional',
  ),
  realHomeUnchanged: JSON.stringify(before) === JSON.stringify(fingerprint()),
}
const record = {
  schema: 1,
  base,
  first,
  recovery,
  checks,
  failureRecalls,
  receipts: receipts.length,
  notes,
  proposals,
}
writeFileSync(join(base, 'record.json'), JSON.stringify(record, null, 2))
console.log(JSON.stringify(record))
assert.ok(
  Object.values(checks).every(Boolean),
  'failure probe acceptance failed; inspect metadata record',
)
