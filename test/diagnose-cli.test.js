import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { openDiagnosticJournal } from '../lib/diagnostic-journal.js'
import { buildDiagnosticReport, writeDiagnosticReport } from '../lib/diagnostic-report.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(ROOT, 'lib', 'diagnose-cli.js')

function world(t) {
  const root = mkdtempSync(join(tmpdir(), 'diagnose-cli-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return { root, dsh: join(root, 'dsh'), dataRoot: join(root, 'dsh', 'data', 'obsidian-mem') }
}

function runCli(dsh, output, extra = []) {
  return spawnSync(process.execPath, [CLI, '--output', output, ...extra], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, DSH_HOME: dsh, SENTINEL_ENV_SECRET: 'SENTINEL-ENV-SECRET' },
  })
}

test('the standalone command writes a private, inspectable JSON report', (t) => {
  const { root, dsh } = world(t)
  const output = join(root, 'report.json')
  const run = runCli(dsh, output)
  assert.equal(run.status, 0, run.stderr)
  const report = JSON.parse(readFileSync(output, 'utf8'))
  assert.equal(report.format, 'dsh-obsidian-mem-diagnostics')
  assert.equal(report.schemaVersion, 1)
  assert.equal(
    report.checks.some((check) => check.id === 'node-floor'),
    true,
  )
  assert.equal(
    report.checks.some((check) => check.id === 'fts5'),
    true,
  )
  assert.equal(
    report.checks.some((check) => check.id === 'plugin-smoke'),
    true,
  )
  assert.equal(Buffer.byteLength(readFileSync(output)) <= 256 * 1024, true)
  assert.equal(statSync(output).mode & 0o777, 0o600)
  assert.equal(JSON.stringify(report).includes(root), false)
  assert.equal(JSON.stringify(report).includes('SENTINEL-ENV-SECRET'), false)
})

test('the npm-style symlink invokes the command', (t) => {
  const { root, dsh } = world(t)
  const binary = join(root, 'dsh-obsidian-mem-diagnose')
  const output = join(root, 'linked-report.json')
  symlinkSync(CLI, binary)
  const run = spawnSync(process.execPath, [binary, '--output', output], {
    encoding: 'utf8',
    env: { ...process.env, DSH_HOME: dsh },
  })
  assert.equal(run.status, 0, run.stderr)
  assert.equal(JSON.parse(readFileSync(output, 'utf8')).format, 'dsh-obsidian-mem-diagnostics')
})

test('the command exports aliases and never raw conversation-like bytes', (t) => {
  const { root, dsh, dataRoot } = world(t)
  const journal = openDiagnosticJournal({
    dataRoot,
    config: {
      enabled: true,
      autoCapture: true,
      injectBrief: true,
      indexBackend: 'auto',
      distill: { dryRun: false },
    },
  })
  journal.record({
    seq: 1,
    at: new Date().toISOString(),
    event: 'job',
    outcome: 'failed',
    jobId: 'raw-job-123',
    body: 'SENTINEL-BODY',
  })
  const output = join(root, 'report.json')
  assert.equal(runCli(dsh, output).status, 0)
  const report = JSON.parse(readFileSync(output, 'utf8'))
  assert.equal(
    report.events.some((event) => event.job === 'j1'),
    true,
  )
  assert.equal(JSON.stringify(report).includes('raw-job-123'), false)
  assert.equal(JSON.stringify(report).includes('SENTINEL-BODY'), false)
})

test('an existing output and a symlink are not overwritten', (t) => {
  const { root, dsh } = world(t)
  const output = join(root, 'report.json')
  writeFileSync(output, 'ORIGINAL')
  assert.notEqual(runCli(dsh, output).status, 0)
  assert.equal(readFileSync(output, 'utf8'), 'ORIGINAL')
  const symlink = join(root, 'link.json')
  symlinkSync(output, symlink)
  assert.notEqual(runCli(dsh, symlink).status, 0)
  assert.equal(readFileSync(output, 'utf8'), 'ORIGINAL')
  assert.equal(existsSync(join(root, 'report.json.tmp')), false)
})

test('a failed plugin smoke does not block the basic report or expose its error', async (t) => {
  const { dataRoot } = world(t)
  const report = await buildDiagnosticReport({
    dataRoot,
    packageRoot: ROOT,
    smoke: async () => {
      throw new Error('SENTINEL-PRIVATE-STACK')
    },
  })
  assert.equal(JSON.stringify(report).includes('SENTINEL-PRIVATE-STACK'), false)
  assert.equal(report.checks.find((check) => check.id === 'plugin-smoke').status, 'unavailable')
  assert.equal(report.checks.find((check) => check.id === 'node-floor').status, 'pass')
})

test('oversized reports refuse output without leaving a partial file', (t) => {
  const { root } = world(t)
  const output = join(root, 'oversize.json')
  assert.throws(
    () => writeDiagnosticReport({ data: 'x'.repeat(256 * 1024) }, output),
    (error) => error.code === 'report-size-limit',
  )
  assert.equal(existsSync(output), false)
})

test('the pending check counts files without parsing their contents', async (t) => {
  const { dataRoot, root } = world(t)
  const pending = join(dataRoot, 'pending')
  mkdirSync(pending, { recursive: true })
  writeFileSync(join(pending, 'opaque.json'), 'SENTINEL-UNPARSEABLE-PENDING')
  const report = await buildDiagnosticReport({
    dataRoot,
    packageRoot: ROOT,
    smoke: async () => true,
  })
  assert.equal(report.checks.find((check) => check.id === 'pending-files').count, 1)
  assert.equal(JSON.stringify(report).includes('SENTINEL-UNPARSEABLE-PENDING'), false)
  assert.equal(JSON.stringify(report).includes(root), false)
})

test('the package check requires the declared binary and matching plugin manifest', async (t) => {
  const { root, dataRoot } = world(t)
  const packageRoot = join(root, 'package')
  mkdirSync(join(packageRoot, 'lib'), { recursive: true })
  writeFileSync(join(packageRoot, 'lib', 'index.js'), '')
  writeFileSync(join(packageRoot, 'lib', 'diagnose-cli.js'), '')
  writeFileSync(
    join(packageRoot, 'package.json'),
    JSON.stringify({ name: 'dsh-obsidian-mem', version: '0.1.0' }),
  )
  let report = await buildDiagnosticReport({ dataRoot, packageRoot, smoke: async () => true })
  assert.equal(report.checks.find((check) => check.id === 'package-files').status, 'fail')

  writeFileSync(
    join(packageRoot, 'package.json'),
    JSON.stringify({
      name: 'dsh-obsidian-mem',
      version: '0.1.0',
      main: 'lib/index.js',
      bin: { 'dsh-obsidian-mem-diagnose': './lib/diagnose-cli.js' },
    }),
  )
  writeFileSync(
    join(packageRoot, 'dsh.plugin.json'),
    JSON.stringify({ id: 'dsh-obsidian-mem', version: '0.1.0', main: 'lib/index.js' }),
  )
  report = await buildDiagnosticReport({ dataRoot, packageRoot, smoke: async () => true })
  assert.equal(report.checks.find((check) => check.id === 'package-files').status, 'pass')
})
