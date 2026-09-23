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

/** Every `test/*.test.js`, relative to the repository root, in a stable order. */
function testFiles() {
  return readdirSync(join(ROOT, 'test'))
    .filter((name) => name.endsWith('.test.js'))
    .sort()
    .map((name) => join('test', name))
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

/** Remove the temporary home, then adopt the child's outcome as our own. */
let finished = false
function finish(code, signal) {
  if (finished) return
  finished = true
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

// A signal that kills *this* process would otherwise skip the cleanup above and
// leak an empty temp home — which is what happens when the suite's output is
// piped into something that stops reading (measured: `npm test | head`). The
// child already receives the same signal from the terminal's process group, so
// this only has to remove the directory and exit with the conventional code.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    rmSync(home, { recursive: true, force: true })
    process.exit(128 + (constants.signals[signal] ?? 0))
  })
}
