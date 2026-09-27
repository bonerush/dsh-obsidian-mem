// A small, content-free support journal. Every process writes its own run file;
// malformed or foreign files never become report fields.
import { randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { isAbsolute, join } from 'node:path'

import {
  createAliases,
  decodeDiagnosticConfig,
  decodeDiagnosticEvent,
  encodeDiagnosticEvent,
  safeConfigSummary,
} from './diagnostic-codec.js'

const SCHEMA_VERSION = 1
const AGE_MS = 7 * 24 * 60 * 60 * 1000
const MAX_EVENTS = 200
const MAX_BYTES = 128 * 1024
const RUN_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.jsonl$/
const NOFOLLOW = constants.O_NOFOLLOW ?? 0

function diagnosticsDir(dataRoot) {
  if (typeof dataRoot !== 'string' || !isAbsolute(dataRoot)) {
    throw new RangeError('diagnostic dataRoot must be absolute')
  }
  return join(dataRoot, 'diagnostics')
}

function assertPrivateDirectory(directory) {
  const stat = lstatSync(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe-diagnostics-directory')
  if ((stat.mode & 0o077) !== 0) throw new Error('unsafe-diagnostics-directory')
}

function ensureDirectory(dataRoot) {
  const directory = diagnosticsDir(dataRoot)
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true, mode: 0o700 })
  assertPrivateDirectory(directory)
  return directory
}

function header(run, config, dropped, at) {
  return { kind: 'header', schemaVersion: SCHEMA_VERSION, run, createdAt: at, config, dropped }
}

function bytesOf(run, config, dropped, at, events) {
  const lines = [header(run, config, dropped, at), ...events]
  return Buffer.from(lines.map((line) => JSON.stringify(line)).join('\n') + '\n')
}

function writeExclusive(path, bytes) {
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
    0o600,
  )
  try {
    writeFileSync(fd, bytes)
  } finally {
    closeSync(fd)
  }
}

function appendSafe(path, bytes) {
  const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | NOFOLLOW)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error('unsafe-diagnostics-file')
    writeFileSync(fd, bytes)
  } finally {
    closeSync(fd)
  }
}

function replaceSafe(path, bytes) {
  const current = lstatSync(path)
  if (!current.isFile() || current.isSymbolicLink()) throw new Error('unsafe-diagnostics-file')
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    writeExclusive(temporary, bytes)
    renameSync(temporary, path)
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary)
  }
}

function cleanup(directory, now) {
  const floor = now().getTime() - AGE_MS
  for (const name of readdirSync(directory)) {
    if (!RUN_FILE.test(name)) continue
    const path = join(directory, name)
    const stat = lstatSync(path)
    if (stat.isFile() && stat.mtimeMs < floor) unlinkSync(path)
  }
}

/** Open a private run; callers keep failures advisory, never operational. */
export function openDiagnosticJournal({ dataRoot, config, now = () => new Date() }) {
  const directory = ensureDirectory(dataRoot)
  cleanup(directory, now)
  const summary = safeConfigSummary(config)
  let aliases = createAliases()
  let run = randomUUID()
  let path = join(directory, `${run}.jsonl`)
  let createdAt = now().toISOString()
  let events = []
  let dropped = 0
  writeExclusive(path, bytesOf(run, summary, dropped, createdAt, events))

  const restart = () => {
    aliases = createAliases()
    run = randomUUID()
    path = join(directory, `${run}.jsonl`)
    createdAt = now().toISOString()
    events = []
    dropped = 0
    writeExclusive(path, bytesOf(run, summary, dropped, createdAt, events))
  }

  return {
    get path() {
      return path
    },
    record(source) {
      // Another process may have expired an idle run while this one stayed alive.
      if (!existsSync(path)) restart()
      const event = encodeDiagnosticEvent(source, aliases)
      if (event === null) return
      events.push(event)
      while (
        events.length > MAX_EVENTS ||
        bytesOf(run, summary, dropped, createdAt, events).length > MAX_BYTES
      ) {
        events.shift()
        dropped += 1
      }
      if (dropped > 0) {
        replaceSafe(path, bytesOf(run, summary, dropped, createdAt, events))
      } else {
        appendSafe(path, Buffer.from(JSON.stringify(event) + '\n'))
      }
    },
    close() {},
  }
}

function empty(status) {
  return { events: [], dropped: 0, corrupt: 0, expired: 0, status, config: null }
}

function safeHeader(value, fileName) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const keys = ['kind', 'schemaVersion', 'run', 'createdAt', 'config', 'dropped']
  if (Object.keys(value).length !== keys.length || keys.some((key) => !(key in value))) return null
  if (value.kind !== 'header' || value.schemaVersion !== SCHEMA_VERSION) return null
  if (`${value.run}.jsonl` !== fileName) return null
  if (!Number.isSafeInteger(value.dropped) || value.dropped < 0) return null
  const config = decodeDiagnosticConfig(value.config)
  if (config === null) return null
  const date = new Date(value.createdAt)
  if (Number.isNaN(date.valueOf()) || date.toISOString() !== value.createdAt) return null
  return { config, dropped: value.dropped }
}

/** Read only validated, bounded fields from recent private run files. */
export function readDiagnosticJournal({ dataRoot, now = () => new Date() }) {
  const result = empty('unavailable')
  let directory
  try {
    directory = diagnosticsDir(dataRoot)
    assertPrivateDirectory(directory)
  } catch {
    return result
  }
  const names = readdirSync(directory)
    .filter((name) => RUN_FILE.test(name))
    .map((name) => {
      try {
        return { name, mtimeMs: lstatSync(join(directory, name)).mtimeMs }
      } catch {
        return { name, mtimeMs: -Infinity }
      }
    })
    .sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name))
  if (names.length === 0) return result
  const floor = now().getTime() - AGE_MS
  let runs = 0
  for (const { name } of names) {
    const path = join(directory, name)
    let fd
    try {
      const stat = lstatSync(path)
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        (stat.mode & 0o077) !== 0 ||
        stat.size > MAX_BYTES
      ) {
        result.corrupt += 1
        continue
      }
      if (stat.mtimeMs < floor) {
        result.expired += 1
        continue
      }
      fd = openSync(path, constants.O_RDONLY | NOFOLLOW)
      if (!fstatSync(fd).isFile()) throw new Error('unsafe-diagnostics-file')
      const lines = readFileSync(fd, 'utf8').trimEnd().split('\n')
      const parsedHeader = safeHeader(JSON.parse(lines.shift()), name)
      if (parsedHeader === null) {
        result.corrupt += 1
        continue
      }
      runs += 1
      result.config = parsedHeader.config
      result.dropped += parsedHeader.dropped
      for (const line of lines) {
        try {
          const event = decodeDiagnosticEvent(JSON.parse(line))
          if (event === null) result.corrupt += 1
          else result.events.push({ run: `r${runs}`, ...event })
        } catch {
          result.corrupt += 1
        }
      }
    } catch {
      result.corrupt += 1
    } finally {
      if (fd !== undefined) closeSync(fd)
    }
  }
  result.events.sort((a, b) => a.at.localeCompare(b.at) || a.seq - b.seq)
  if (result.events.length > MAX_EVENTS) {
    result.dropped += result.events.length - MAX_EVENTS
    result.events = result.events.slice(-MAX_EVENTS)
  }
  result.status = result.corrupt > 0 ? 'partial' : runs > 0 ? 'ok' : 'unavailable'
  return result
}
