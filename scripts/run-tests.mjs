#!/usr/bin/env node
// Run the suite with `DSH_HOME` pointed at a throwaway directory (R42).
//
// The plugin derives its entire private data root — locks, receipts, the
// transaction journal, the pending queue, the index and the skill sync target —
// from `DSH_HOME`. Leaving that to per-test convention was not enough: one test
// activated the plugin with `enabled: true` without isolating the home, and the
// skill sync wrote `obsidian-mem` into the real `~/.dsh/skills/`. Setting
// `DSH_HOME` here makes the isolation structural, so even a test that forgets to
// inject a temporary data root cannot reach the user's real home.
//
// The same file set the documented command names is used — `test/*.test.js`, one
// level deep — so `test/p0/` and `test/smoke/` keep their own entry points and
// are not swept into `npm test`.
import { spawn } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { constants, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Every `test/*.test.js`, relative to the repository root, in a stable order.
 *
 * A missing or unreadable `test/` is reported as a message instead of an
 * unhandled `ENOENT`, because the failure has to name the directory it could not
 * read — this runs as `npm test`, where a bare stack trace is not a diagnosis.
 *
 * @returns {string[]} the test files to hand to `node --test`.
 */
function testFiles() {
  const directory = join(ROOT, 'test')
  let entries
  try {
    entries = readdirSync(directory)
  } catch (error) {
    process.stderr.write(`run-tests: cannot read ${directory}: ${error.message}\n`)
    process.exit(1)
  }
  return entries
    .filter((name) => name.endsWith('.test.js'))
    .sort()
    .map((name) => join('test', name))
}

// Arguments are refused rather than dropped: this wrapper exists to run exactly
// the repository's `test/*.test.js` under an isolated `DSH_HOME`, and silently
// ignoring a flag would make a run look narrower or wider than it was.
if (process.argv.length > 2) {
  process.stderr.write(`run-tests: takes no arguments, got ${JSON.stringify(process.argv.slice(2))}\n`)
  process.exit(2)
}

const files = testFiles()
if (files.length === 0) {
  process.stderr.write('run-tests: no test/*.test.js files found\n')
  process.exit(1)
}

const home = mkdtempSync(join(tmpdir(), 'obsidian-mem-test-home-'))
process.stdout.write(`run-tests: DSH_HOME=${home} (${files.length} files)\n`)

const child = spawn(process.execPath, ['--test', ...files], {
  cwd: ROOT,
  env: { ...process.env, DSH_HOME: home },
  stdio: 'inherit',
})

/** The fallback that kills a child which ignores the forwarded signal. */
let escalation = null

/** Remove the temporary home, then adopt the child's outcome as our own. */
let finished = false
function finish(code, signal) {
  if (finished) return
  finished = true
  if (escalation !== null) clearTimeout(escalation)
  rmSync(home, { recursive: true, force: true })
  if (signal !== null && signal !== undefined) {
    // Conventional 128+n so a killed run is never mistaken for a passing one.
    process.exitCode = 128 + (constants.signals[signal] ?? 0)
    return
  }
  process.exitCode = code ?? 1
}

child.on('error', (error) => {
  process.stderr.write(`run-tests: could not start node --test: ${error.message}\n`)
  finish(1, null)
})
child.on('exit', finish)

// A signal has to be *forwarded*, not just handled: removing the home and exiting
// here would leave `node --test` running as an orphan, and the tests it still has
// to run would recreate the `DSH_HOME` we had already deleted — measured with a
// synthetic writer (the R41 incident shape): the pre-fix path left the writer
// alive and it rebuilt the home; this path kills it before the cleanup runs.
// Forwarding first and letting the child's own `exit` drive `finish` means the
// cleanup happens after the writer is gone. (The wrapper's death would otherwise
// also leak the empty directory, which is what `npm test | head` used to cause.)
//
// Note for whoever reads a CI log: Node's own test runner traps these signals,
// tears down its per-file children and exits **1**, so a forwarded signal usually
// surfaces as exit 1 rather than the 128+n `finish` would compute. Non-zero either
// way, which is the part that matters; the line on stderr says a signal caused it.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    process.stderr.write(`run-tests: received ${signal}; forwarding it to the suite\n`)
    // The 'stdio: inherit' child handle keeps this process alive while the child
    // lives; the escalation timer is unref'd so it cannot keep it alive longer.
    if (escalation === null) escalation = setTimeout(() => child.kill('SIGKILL'), 3_000).unref()
    child.kill(signal)
  })
}
