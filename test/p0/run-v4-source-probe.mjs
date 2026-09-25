#!/usr/bin/env node
// Does the *installed* DSH admit the source this plugin stamps on its recall
// message, and what kind does it derive for this producer?
//
// Three independent measurements, all through the host's own code rather than a
// reimplementation of its rules:
//
//   A  the retired `{kind:'plugin', plugin}` wrapper is refused by the V4 writer
//   B  the current `{kind:'plugin:<name>'}` kind is admitted by the V4 writer
//   C  the real V3→V4 catalog restore, run over a real V3 session, names this
//      producer — so a converted session and a new write agree
//   D  a V3-line writer admits the current kind too, which is what keeps
//      `engines.dsh: ">=0.1.5-rc.2"` honest instead of a range this change broke
//
// A and B call `assertV4RowAdmission` from
// `@deepseek-ai/dsh-session-format-v3-to-v4`, the same gate the JSONL writer
// runs before `encodeEvent`. C needs a V3 session file to convert; D needs a
// V3-line install. Without those flags the corresponding case is reported as
// skipped rather than silently passed.
//
// The packages are not dependencies of this plugin, so the script locates them
// in an installed DSH: `DSH_FORMAT_ROOT` names the `@deepseek-ai` directory
// directly, otherwise it is derived from `npm root -g`.
//
// Usage:
//   node test/p0/run-v4-source-probe.mjs [--session <session.v3.jsonl.zstd>]
//                                        [--v3-root <@deepseek-ai dir of 0.1.5>]
//
// Nothing here reads a vault, writes a DSH home, or prints a credential.

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

import { PLUGIN_ID, RECALL_SOURCE } from '../../lib/hooks.js'

/** The retired shape this plugin used before session format v4. */
const RETIRED_SOURCE = Object.freeze({ kind: 'plugin', plugin: PLUGIN_ID, form: 'recall' })

/** Resolve the `@deepseek-ai` directory of an installed DSH. */
function formatRoot() {
  if (process.env.DSH_FORMAT_ROOT) return process.env.DSH_FORMAT_ROOT
  const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim()
  return join(globalRoot, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai')
}

const load = (root, pkg) => import(pathToFileURL(join(root, pkg, 'lib/index.js')).href)

/** One V4 `user/message` row stamped with `source`. */
const row = (source) => ({
  type: 'user/message',
  seq: 1,
  time: 1,
  data: { id: 'probe-message', role: 'user', content: [{ type: 'text', text: 'probe' }], source },
})

/** One V3 `user/message` event stamped with `source`; V3 requires a surfaceOp. */
const v3Event = (source) => ({ ...row(source), surfaceOp: 'append' })

/** Record the outcome of running `gate` on one source. */
function admission(gate, subject) {
  try {
    return { admitted: true, stored: gate(subject) }
  } catch (error) {
    return {
      admitted: false,
      error: error?.constructor?.name ?? 'Error',
      message: error?.message ?? String(error),
    }
  }
}

const args = process.argv.slice(2)
const flag = (name) => (args.indexOf(name) === -1 ? null : args[args.indexOf(name) + 1])
const session = flag('--session')
const v3root = flag('--v3-root')

const root = formatRoot()
const { assertV4RowAdmission } = await load(root, 'dsh-session-format-v3-to-v4')

const results = {
  probe: 'v4-message-source',
  pluginId: PLUGIN_ID,
  root,
  retiredShape: admission(assertV4RowAdmission, row(RETIRED_SOURCE)),
  currentShape: admission(assertV4RowAdmission, row(RECALL_SOURCE)),
  convertedKind: null,
  restoredSourceCounts: null,
  conversion: 'skipped: pass --session <session.v3.jsonl.zstd> to convert a real V3 session',
  v3: 'skipped: pass --v3-root <@deepseek-ai dir of a 0.1.5-line install> to write through it',
}

// The install must actually refuse the old shape, or this probe proves nothing.
if (results.retiredShape.admitted)
  throw new Error('the retired plugin wrapper was admitted; the probe premise does not hold')
if (!results.currentShape.admitted)
  throw new Error(`the current source was refused: ${results.currentShape.message}`)

if (v3root !== null) {
  const v3catalog = await load(v3root, 'dsh-session-format-catalog')
  const gate = (source) =>
    v3catalog.sessionFormatCatalog.encodeCurrentEvent(v3Event(source)).data.source
  results.v3 = {
    currentVersion: v3catalog.sessionFormatCatalog.currentVersion,
    retiredShape: admission(gate, RETIRED_SOURCE),
    currentShape: admission(gate, RECALL_SOURCE),
  }
  if (!results.v3.currentShape.admitted)
    throw new Error(`the V3 writer refused the current source: ${results.v3.currentShape.message}`)
}

if (session !== null) {
  if (!existsSync(session)) throw new Error(`no such session file: ${session}`)
  const catalog = await load(root, 'dsh-session-format-catalog')
  const text = execFileSync('zstd', ['-dc', session], { encoding: 'utf8', maxBuffer: 1 << 28 })
  const rows = text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line))
  const bound = catalog.createSessionFormatCatalogWithChildren([])
  const restore = bound.createRestore(rows[0], {
    recovery: 'recoverable',
    validation: 'transformed',
  })
  for (const physical of rows.slice(1)) restore.decodeRow(physical)
  const current = restore.finish()
  const counts = new Map()
  for (const event of current.events) {
    for (const match of JSON.stringify(event).matchAll(/"source":(\{[^}]*\})/g)) {
      const key = `${event.type} ${match[1]}`
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }
  const mine = `user/message ${JSON.stringify({ kind: RECALL_SOURCE.kind, form: 'recall' })}`
  results.convertedKind = counts.get(mine) === undefined ? null : RECALL_SOURCE.kind
  results.restoredSourceCounts = { events: current.events.length, [mine]: counts.get(mine) ?? 0 }
  results.conversion =
    counts.get(mine) === undefined
      ? 'the converted session carries no source from this producer'
      : `converted to ${mine}`
  if (counts.get(mine) === undefined)
    throw new Error(`the converter did not derive ${RECALL_SOURCE.kind}`)
}

process.stdout.write(`${JSON.stringify(results, null, 2)}\n`)
