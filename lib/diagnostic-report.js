// Build a support report from fixed, content-free fields. This module imports
// no host service at startup, so it still runs when the plugin cannot load.
import { randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { arch, platform, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

import { decodeDiagnosticEvent } from './diagnostic-codec.js'
import { readDiagnosticJournal } from './diagnostic-journal.js'

const MAX_REPORT_BYTES = 256 * 1024
const LIMITATIONS = Object.freeze([
  'This report does not inspect conversation content, pending job bodies, notes, host logs, or user configuration files.',
  'An absent or incomplete journal does not prove the plugin operated correctly.',
  'The isolated smoke check does not verify a real vault, model route, or host session hook.',
])

function check(id, status, code = null, count = null) {
  const result = { id, status }
  if (code !== null) result.code = code
  if (count !== null) result.count = count
  return result
}

function atLeast(actual, floor) {
  const parts = (value) => {
    const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value)
    return match === null ? null : match.slice(1).map(Number)
  }
  const a = parts(actual)
  const b = parts(floor)
  if (a === null || b === null) return false
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index]
  }
  return true
}

async function fts5Check() {
  let database
  try {
    const { DatabaseSync } = await import('node:sqlite')
    database = new DatabaseSync(':memory:')
    database.exec('CREATE VIRTUAL TABLE probe USING fts5(value)')
    return check('fts5', 'pass')
  } catch {
    return check('fts5', 'fail', 'fts5-unavailable')
  } finally {
    try {
      database?.close()
    } catch {
      // A self-check cleanup failure does not block the report.
    }
  }
}

function packageInfo(packageRoot) {
  try {
    const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
    const plugin = JSON.parse(readFileSync(join(packageRoot, 'dsh.plugin.json'), 'utf8'))
    if (
      manifest.name !== 'dsh-obsidian-mem' ||
      manifest.main !== 'lib/index.js' ||
      manifest.bin?.['dsh-obsidian-mem-diagnose'] !== './lib/diagnose-cli.js' ||
      plugin.id !== manifest.name ||
      plugin.version !== manifest.version ||
      plugin.main !== manifest.main
    )
      return { version: 'unavailable', check: check('package-files', 'fail', 'package-invalid') }
    for (const file of ['lib/index.js', 'lib/diagnose-cli.js']) {
      if (!lstatSync(join(packageRoot, file)).isFile()) {
        return {
          version: 'unavailable',
          check: check('package-files', 'fail', 'package-incomplete'),
        }
      }
    }
    const version =
      typeof manifest.version === 'string' &&
      /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(manifest.version)
        ? manifest.version
        : 'unavailable'
    return { version, check: check('package-files', 'pass') }
  } catch {
    return { version: 'unavailable', check: check('package-files', 'fail', 'package-incomplete') }
  }
}

function dataRootCheck(dataRoot) {
  try {
    const stat = lstatSync(dataRoot)
    if (!stat.isDirectory() || stat.isSymbolicLink())
      return check('data-root', 'fail', 'data-root-unsafe')
    if ((stat.mode & 0o077) !== 0) return check('data-root', 'partial', 'data-root-permissions')
    return check('data-root', 'pass')
  } catch {
    return check('data-root', 'unavailable', 'data-root-missing')
  }
}

function pendingCheck(dataRoot) {
  try {
    const directory = join(dataRoot, 'pending')
    if (!lstatSync(directory).isDirectory())
      return check('pending-files', 'unavailable', 'pending-unavailable')
    const count = readdirSync(directory, { withFileTypes: true }).filter(
      (entry) => entry.isFile() && !entry.name.startsWith('.') && entry.name.endsWith('.json'),
    ).length
    return check('pending-files', 'pass', null, count)
  } catch {
    return check('pending-files', 'unavailable', 'pending-unavailable')
  }
}

/** A real tool-path check against a disposable home and vault. */
export async function isolatedPluginSmoke() {
  const root = mkdtempSync(join(tmpdir(), 'obsidian-mem-diagnostic-smoke-'))
  let services
  try {
    const vaultPath = join(root, 'vault')
    mkdirSync(vaultPath, { mode: 0o700 })
    await import('./index.js')
    const { validateConfig } = await import('./config.js')
    const { createMemoryServices } = await import('./tools.js')
    const config = validateConfig({ vaultPath })
    services = createMemoryServices({
      config,
      dataRoot: join(root, 'dsh', 'data', 'obsidian-mem'),
      cwd: root,
      home: root,
    })
    const result = await services.admin({ action: 'diagnostics' })
    return result?.action === 'diagnostics' && Array.isArray(result?.result?.events)
  } finally {
    try {
      await services?.close()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
}

function safeEvents(source) {
  const events = []
  for (const item of source) {
    if (typeof item?.run !== 'string' || !/^r[1-9][0-9]*$/.test(item.run)) continue
    const { run, ...raw } = item
    const event = decodeDiagnosticEvent(raw)
    if (event !== null) events.push({ run, ...event })
  }
  return events
}

/** Build only fields approved for an Issue attachment. */
export async function buildDiagnosticReport({
  dataRoot,
  packageRoot,
  now = () => new Date(),
  smoke = isolatedPluginSmoke,
}) {
  const packageState = packageInfo(packageRoot)
  let journal
  try {
    journal = readDiagnosticJournal({ dataRoot, now })
  } catch {
    journal = { events: [], dropped: 0, corrupt: 0, expired: 0, status: 'partial', config: null }
  }
  let smokeCheck
  try {
    smokeCheck = (await smoke())
      ? check('plugin-smoke', 'pass')
      : check('plugin-smoke', 'fail', 'plugin-smoke-failed')
  } catch {
    smokeCheck = check('plugin-smoke', 'unavailable', 'plugin-smoke-failed')
  }
  const events = safeEvents(journal.events)
  const report = {
    format: 'dsh-obsidian-mem-diagnostics',
    schemaVersion: 1,
    generatedAt: now().toISOString(),
    environment: {
      pluginVersion: packageState.version,
      nodeVersion: process.versions.node,
      dshVersion: 'unavailable',
      platform: platform(),
      arch: arch(),
      config: journal.config ?? 'unavailable',
    },
    checks: [
      atLeast(process.versions.node, '22.22.2')
        ? check('node-floor', 'pass')
        : check('node-floor', 'fail', 'node-too-old'),
      await fts5Check(),
      packageState.check,
      dataRootCheck(dataRoot),
      check(
        'diagnostic-journal',
        journal.status === 'ok' ? 'pass' : journal.status,
        journal.status === 'ok' ? null : 'journal-unavailable',
      ),
      pendingCheck(dataRoot),
      smokeCheck,
    ],
    eventWindow: {
      status: journal.status,
      included: events.length,
      runs: new Set(events.map((event) => event.run)).size,
      oldestAt: events[0]?.at ?? null,
      newestAt: events.at(-1)?.at ?? null,
      dropped: journal.dropped,
      corrupt: journal.corrupt,
      expired: journal.expired,
      truncated: 0,
    },
    events,
    limitations: [...LIMITATIONS],
  }
  while (
    Buffer.byteLength(JSON.stringify(report, null, 2) + '\n') > MAX_REPORT_BYTES &&
    report.events.length > 0
  ) {
    report.events.shift()
    report.eventWindow.truncated += 1
  }
  report.eventWindow.included = report.events.length
  report.eventWindow.oldestAt = report.events[0]?.at ?? null
  report.eventWindow.runs = new Set(report.events.map((event) => event.run)).size
  return report
}

function fixedError(code) {
  return Object.assign(new Error(code), { code })
}

function refuseExistingOutput(outputPath) {
  if (existsSync(outputPath) || isSymbolicLink(outputPath)) {
    throw fixedError('output-exists')
  }
}

function isSymbolicLink(path) {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

/** Publish a report without overwriting an existing path. */
export function writeDiagnosticReport(report, outputPath) {
  const bytes = Buffer.from(JSON.stringify(report, null, 2) + '\n')
  if (bytes.length > MAX_REPORT_BYTES) throw fixedError('report-size-limit')
  if (typeof outputPath !== 'string' || outputPath.trim() === '') throw fixedError('output-invalid')
  const requested = isAbsolute(outputPath) ? outputPath : resolve(outputPath)
  // macOS exposes its normal temporary directory through /var -> /private/var.
  // Resolve the parent once, then refuse the final entry itself if it exists.
  let destination
  try {
    destination = join(realpathSync(dirname(requested)), basename(requested))
    refuseExistingOutput(destination)
  } catch (error) {
    if (error?.code === 'output-exists') throw error
    throw fixedError('output-write-failed')
  }
  const temporary = `${destination}.${randomUUID()}.tmp`
  let fd
  try {
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
    writeFileSync(fd, bytes)
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    linkSync(temporary, destination)
  } catch (error) {
    if (error?.code === 'EEXIST') throw fixedError('output-exists')
    if (typeof error?.code === 'string' && error.code.startsWith('output-')) throw error
    throw fixedError('output-write-failed')
  } finally {
    if (fd !== undefined) closeSync(fd)
    if (existsSync(temporary)) unlinkSync(temporary)
  }
  return destination
}
