// Native DSH + real model, with temporary config, repository and vault only.
// Usage: DSH_BIN=/absolute/dsh node test/p0/run-habit-probe.mjs
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'
import { validateConfig } from '../../lib/config.js'
import { createMemoryServices } from '../../lib/services.js'
import { readResultReceipts, readPendingJobs, queueRootFor } from '../../lib/pending.js'
import { parseNote, resolveBinding } from '../../lib/vault.js'

const checkout = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const base = mkdtempSync(join(tmpdir(), 'dsh-habit-probe-'))
const home = join(base, 'home')
const repo = join(base, 'repo')
const vault = join(base, 'vault')
const driver = join(base, 'driver')
for (const path of [home, repo, driver]) mkdirSync(path, { recursive: true })
execFileSync('git', ['init', '-q'], { cwd: repo })
const dataRoot = join(home, 'data/obsidian-mem')
const credential =
  process.env.DEEPSEEK_API_KEY ??
  YAML.parse(readFileSync(join(homedir(), '.dsh/.credentials.yaml'), 'utf8'))?.refs
    ?.DEEPSEEK_API_KEY
assert.ok(typeof credential === 'string' && credential, 'a model credential is required')
const fingerprint = () =>
  ['cordis.patch.yml', 'profiles/desktop/cordis.patch.yml', '.credentials.yaml'].map((p) => {
    const file = join(homedir(), '.dsh', p)
    return existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : null
  })
const before = fingerprint()
const env = { ...process.env, DSH_HOME: home, DEEPSEEK_API_KEY: credential }
const cli = process.env.DSH_BIN ?? 'dsh'
async function run(args) {
  return new Promise((done, reject) => {
    const child = spawn(cli, args, { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdoutBytes = 0
    let stderrBytes = 0
    child.stdout.on('data', (d) => {
      stdoutBytes += d.length
    })
    child.stderr.on('data', (d) => {
      stderrBytes += d.length
    })
    const timer = setTimeout(() => child.kill('SIGKILL'), 120000)
    child.on('error', reject)
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      done({ code, signal, stdoutBytes, stderrBytes })
    })
  })
}
// The probe holds the awaited final flush until DSH's own worker settles.
// The driver never captures prompts or model output and never calls the distiller.
writeFileSync(
  join(driver, 'package.json'),
  JSON.stringify({
    name: 'dsh-habit-probe-driver',
    version: '0.0.0',
    private: true,
    type: 'module',
    main: 'index.js',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }),
)
writeFileSync(
  join(driver, 'cordis.patch.yml'),
  '- insert:\n    - id: habit-probe-driver\n      name: dsh-habit-probe-driver\n',
)
writeFileSync(
  join(driver, 'index.js'),
  `
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
export const name = 'dsh-habit-probe-driver'
export function apply(ctx) {
  let ended = false
  ctx.on('session/event', (_session, event) => { if (event.type === 'turn/end') ended = true })
  ctx.on('session/flush', async () => {
    if (!ended) return
    const queue = join(process.env.DSH_HOME, 'data/obsidian-mem/pending')
    const receipts = join(queue, 'receipts')
    const deadline = Date.now() + 15000
    let settled = 0
    while (Date.now() < deadline && settled < 20) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      const waiting = existsSync(queue) && readdirSync(queue).some((p) => p.endsWith('.json') && JSON.parse(readFileSync(join(queue, p), 'utf8')).origin === 'habit-curation')
      const done = existsSync(receipts) && readdirSync(receipts).some((p) => readdirSync(join(receipts, p)).some((f) => f.endsWith('.json')))
      settled = done && !waiting ? settled + 1 : 0
    }
  })
}
`,
)
const setup = [
  await run(['--profile', 'habit', '--from-default-profile', 'headless', '--dump-config']),
  await run(['plugin', '--profile', 'habit', 'add', `link:${checkout}`]),
  await run(['plugin', '--profile', 'habit', 'add', `link:${driver}`]),
]
assert.ok(
  setup.every((r) => r.code === 0),
  JSON.stringify({ base, setup }),
)
const config = validateConfig({
  vaultPath: vault,
  initGitOnCreate: false,
  captureIdleMs: 1000,
  distill: { provider: 'deepseek-official', model: 'deepseek-flash' },
})
const services = createMemoryServices({ config, dataRoot, cwd: repo, home })
await services.write({
  type: 'convention',
  title: '学习方式声明',
  body: '学习新概念时，我更愿意通过实物复现和真实代码来理解。',
  assertion: 'stated',
  status: 'active',
})
const binding = await resolveBinding({ cwd: repo, vaultRoot: vault, mode: 'show', home })
await services.close()
writeFileSync(
  join(home, 'profiles/habit/cordis.patch.yml'),
  YAML.stringify([
    { id: 'obsidian-mem', config },
    {
      id: 'agent-default-model',
      config: { provider: 'deepseek-official', model: 'deepseek-flash' },
    },
  ]),
  { mode: 0o600 },
)
const native = await run([
  '--profile',
  'habit',
  '本项目要求在记忆蒸馏和整理中自动生成习惯。这是软件功能需求。仅回复 OK，不要调用工具。',
])
const receipts = await readResultReceipts(queueRootFor(dataRoot), binding.projectId)
const pending = await readPendingJobs(queueRootFor(dataRoot))
const paths = [
  ...new Set(
    receipts
      .flatMap((r) => r.items)
      .map((item) => item.path)
      .filter(Boolean),
  ),
]
const notes = paths.map((path) => parseNote(readFileSync(join(vault, path))))
const habits = notes.filter((n) => /^习惯[:：]/.test(n.data.title ?? ''))
assert.deepEqual(fingerprint(), before, 'real user configuration must stay byte-identical')
assert.equal(native.code, 0, JSON.stringify({ base, native }))
assert.equal(pending.invalid.length, 0, 'every pending job must be readable')
assert.ok(
  pending.jobs.every((job) => job.state !== 'failed'),
  'headless successors must remain retryable',
)
assert.ok(
  receipts.some((r) => r.sessionId.startsWith('curation-')),
  'native curation must reach the queue',
)
assert.ok(
  habits.some((n) => n.data.assertion === 'observed' && n.data.status === 'provisional'),
  'memory curation must produce a quarantined habit',
)
assert.ok(
  habits.every((n) => n.data.status === 'provisional'),
  'a software requirement must not become a confirmed personal preference',
)
console.log(
  JSON.stringify({
    base,
    native,
    receipts: receipts.length,
    memoryReceipts: receipts.filter((r) => r.sessionId.startsWith('curation-')).length,
    habitNotes: habits.length,
    observed: habits.filter((n) => n.data.assertion === 'observed').length,
    provisional: habits.filter((n) => n.data.status === 'provisional').length,
    pendingMemoryJobs: pending.jobs.filter((job) => job.origin === 'habit-curation').length,
    pendingRootTurns: pending.jobs.filter((job) => job.origin !== 'habit-curation').length,
    completedRootTurns: receipts.filter((r) => !r.sessionId.startsWith('curation-')).length,
    realConfigUnchanged: true,
  }),
)
