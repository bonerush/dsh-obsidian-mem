import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  appendFileSync,
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { openDiagnosticJournal, readDiagnosticJournal } from '../lib/diagnostic-journal.js'

function world(t) {
  const root = mkdtempSync(join(tmpdir(), 'diagnostic-journal-'))
  t.after(() => {
    chmodSync(root, 0o700)
    rmSync(root, { recursive: true, force: true })
  })
  return root
}

const config = {
  enabled: true,
  autoCapture: true,
  injectBrief: true,
  indexBackend: 'auto',
  distill: { dryRun: false },
}
const now = () => new Date('2026-09-27T12:00:00.000Z')

test('a journal keeps 200 safe events and private permissions', (t) => {
  const dataRoot = world(t)
  const journal = openDiagnosticJournal({ dataRoot, config, now })
  for (let seq = 1; seq <= 201; seq += 1) {
    journal.record({
      seq,
      at: now().toISOString(),
      event: 'capture',
      outcome: 'captured',
      projectId: 'raw-project-id',
      body: 'SENTINEL-BODY',
    })
  }
  assert.equal(lstatSync(join(dataRoot, 'diagnostics')).mode & 0o777, 0o700)
  assert.equal(lstatSync(journal.path).mode & 0o777, 0o600)
  const bytes = readFileSync(journal.path, 'utf8')
  assert.equal(Buffer.byteLength(bytes) <= 128 * 1024, true)
  assert.equal(bytes.includes('raw-project-id'), false)
  assert.equal(bytes.includes('SENTINEL-BODY'), false)
  const read = readDiagnosticJournal({ dataRoot, now })
  assert.equal(read.events.length, 200)
  assert.equal(read.events[0].seq, 2)
  assert.equal(read.dropped, 1)
  assert.equal(read.config.indexBackend, 'auto')
})

test('two processes use separate run files', (t) => {
  const dataRoot = world(t)
  const first = openDiagnosticJournal({ dataRoot, config, now })
  first.record({ seq: 1, at: now().toISOString(), event: 'job', outcome: 'failed' })
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import {openDiagnosticJournal} from './lib/diagnostic-journal.js'; const j=openDiagnosticJournal({dataRoot:process.argv[1],config:{enabled:true},now:()=>new Date('2026-09-27T12:00:00.000Z')}); j.record({seq:1,at:'2026-09-27T12:00:00.000Z',event:'job',outcome:'retry'});`,
      dataRoot,
    ],
    { cwd: process.cwd(), encoding: 'utf8' },
  )
  assert.equal(child.status, 0, child.stderr)
  assert.equal(
    readdirSync(join(dataRoot, 'diagnostics')).filter((name) => name.endsWith('.jsonl')).length,
    2,
  )
  assert.equal(readDiagnosticJournal({ dataRoot, now }).events.length, 2)
})

test('expired files are ignored and cleaned on next open', (t) => {
  const dataRoot = world(t)
  const old = openDiagnosticJournal({ dataRoot, config, now })
  old.record({ seq: 1, at: '2026-09-01T00:00:00.000Z', event: 'job', outcome: 'failed' })
  utimesSync(old.path, new Date('2026-09-01'), new Date('2026-09-01'))
  assert.equal(readDiagnosticJournal({ dataRoot, now }).expired, 1)
  openDiagnosticJournal({ dataRoot, config, now })
  assert.equal(
    readdirSync(join(dataRoot, 'diagnostics')).includes(old.path.split('/').at(-1)),
    false,
  )
})

test('a symlinked diagnostics directory is refused', (t) => {
  const dataRoot = world(t)
  const target = world(t)
  symlinkSync(target, join(dataRoot, 'diagnostics'))
  assert.throws(
    () => openDiagnosticJournal({ dataRoot, config, now }),
    /unsafe-diagnostics-directory/,
  )
})

test('corrupt records are counted but never returned raw', (t) => {
  const dataRoot = world(t)
  const journal = openDiagnosticJournal({ dataRoot, config, now })
  journal.record({ seq: 1, at: now().toISOString(), event: 'job', outcome: 'failed' })
  appendFileSync(journal.path, '{"body":"SENTINEL-PRIVATE"}\n')
  const read = readDiagnosticJournal({ dataRoot, now })
  assert.equal(read.corrupt, 1)
  assert.equal(read.events.length, 1)
  assert.equal(JSON.stringify(read).includes('SENTINEL-PRIVATE'), false)
})

test('a substituted run-file symlink cannot be written or exported', (t) => {
  const dataRoot = world(t)
  const external = join(dataRoot, 'outside.txt')
  writeFileSync(external, 'SENTINEL-OUTSIDE')
  const journal = openDiagnosticJournal({ dataRoot, config, now })
  rmSync(journal.path)
  symlinkSync(external, journal.path)
  assert.throws(
    () => journal.record({ seq: 1, at: now().toISOString(), event: 'job', outcome: 'failed' }),
    /ELOOP|unsafe-diagnostics-file/,
  )
  assert.equal(readFileSync(external, 'utf8'), 'SENTINEL-OUTSIDE')
  assert.equal(
    JSON.stringify(readDiagnosticJournal({ dataRoot, now })).includes('SENTINEL-OUTSIDE'),
    false,
  )
})

test('the latest run supplies the config summary regardless of filename order', (t) => {
  const dataRoot = world(t)
  const first = openDiagnosticJournal({
    dataRoot,
    config: { ...config, indexBackend: 'auto' },
    now,
  })
  const second = openDiagnosticJournal({
    dataRoot,
    config: { ...config, indexBackend: 'scan' },
    now,
  })
  const byName = [first, second].sort((a, b) => a.path.localeCompare(b.path))
  utimesSync(byName[0].path, new Date('2026-09-27T11:00:00Z'), new Date('2026-09-27T11:00:00Z'))
  utimesSync(byName[1].path, new Date('2026-09-27T10:00:00Z'), new Date('2026-09-27T10:00:00Z'))
  const expected = byName[0] === first ? 'auto' : 'scan'
  assert.equal(readDiagnosticJournal({ dataRoot, now }).config.indexBackend, expected)
})
