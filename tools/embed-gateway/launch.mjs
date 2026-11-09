#!/usr/bin/env node
// Windows-friendly launcher for the loopback embedding gateway.
//
// Two things the plain shim cannot do on a fresh login:
// 1. The upstream credential has to come from somewhere. This machine keeps it
//    in DSH's own secret store (~/.dsh/.credentials.yaml, a refs: map). The
//    launcher reads it only when the environment does not already carry it, and
//    never prints or copies it.
// 2. A launched process must survive the terminal that started it. --detach
//    re-execs the shim as a hidden, detached child.
//
// Usage:
//   node tools/embed-gateway/launch.mjs            # foreground, logs to stdout
//   node tools/embed-gateway/launch.mjs --detach   # background (Startup entry)
//
// Credential precedence: EMBED_UPSTREAM_KEY, then DOCUMIND_API_KEY, then the
// DSH secret store. Nothing is ever written back to a file.
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SHIM = join(HERE, 'shim.mjs')
const KEY_NAME = process.env.EMBED_UPSTREAM_KEY_ENV || 'DOCUMIND_API_KEY'

/** Defaults this machine needs; each one is an ordinary shim variable. */
const DEFAULTS = Object.freeze({
  EMBED_PORT: '8790',
  EMBED_HOST: '127.0.0.1',
  EMBED_UPSTREAM_BASE: 'https://llms.documind.bosch-app.com/v1',
  EMBED_UPSTREAM_MODEL: 'qwen3.7-text-embedding',
  EMBED_DIMENSIONS: '1024',
  // Below the plugin's 5000 ms ceiling on purpose: the shim should time out
  // first and say why, instead of the plugin abandoning a request it cannot name.
  EMBED_TIMEOUT_MS: '4000',
})

/**
 * Read one NAME: value entry out of DSH's secret store.
 *
 * The file is a flat two-level YAML map (refs: then NAME: value). This is a
 * deliberately narrow reader: one scalar for one key, nothing else, so a change
 * to the store's shape surfaces as 'not found' rather than as a mis-parsed secret.
 *
 * @param {string} name - the credential name to look up.
 * @param {string} [file] - the store path; defaults to DSH's own.
 * @returns {string|null} the value, or null when the store or the key is absent.
 */
export function readDshCredential(name, file = join(homedir(), '.dsh', '.credentials.yaml')) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return null
  }
  let inRefs = false
  for (const raw of text.split(/\r?\n/u)) {
    if (/^\S/u.test(raw)) {
      inRefs = /^refs:\s*$/u.test(raw)
      continue
    }
    if (!inRefs) continue
    const match = /^\s+([A-Za-z0-9_.-]+):\s*(.*)$/u.exec(raw)
    if (match === null) continue
    if (match[1] !== name) continue
    const value = match[2].trim().replace(/^["']|["']$/gu, '')
    return value === '' ? null : value
  }
  return null
}

/** The environment the shim should run under: defaults, then the caller's own. */
export function resolveEnvironment(env = process.env, readCredential = readDshCredential) {
  const out = { ...env }
  for (const [key, value] of Object.entries(DEFAULTS)) {
    if (out[key] === undefined || String(out[key]).trim() === '') out[key] = value
  }
  const named = out[KEY_NAME]
  const explicit = out.EMBED_UPSTREAM_KEY
  if (explicit === undefined || String(explicit).trim() === '') {
    const fromEnv = named === undefined ? '' : String(named).trim()
    const value = fromEnv !== '' ? fromEnv : readCredential(KEY_NAME)
    if (value) out.EMBED_UPSTREAM_KEY = value
  }
  return out
}

const detach = process.argv.includes('--detach')

if (!detach) {
  // The shim owns its own wiring (loadConfig -> startShim, its banner and its
  // signal handlers), so a launcher that hand-rolled a server would be a second
  // copy of all four. Give the child the resolved environment and let it run.
  const child = spawn(process.execPath, [SHIM], { env: resolveEnvironment(), stdio: 'inherit' })
  const code = await new Promise((resolve) => child.on('exit', (value) => resolve(value ?? 1)))
  process.exitCode = code
} else {
  const spawnEnv = resolveEnvironment()
  const child = spawn(process.execPath, [SHIM], {
    env: spawnEnv,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()
  process.stdout.write('embed-gateway: started pid ' + child.pid + '\n')
  const port = spawnEnv.EMBED_PORT
  process.stdout.write(
    'embed-gateway: detached; probe http://' + spawnEnv.EMBED_HOST + ':' + port + '/health\n',
  )
}
