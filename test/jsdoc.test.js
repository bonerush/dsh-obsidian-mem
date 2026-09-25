// Task 3: keep the JSDoc readable by the compiler that is *not* pinned here.
//
// Measured 2026-09-25 on the same two files, `checkJs: true`, `types: []`:
//
//   TypeScript 7.0.2 (the current `latest` on npm)  5 x TS1005 + 8 x TS8032
//   TypeScript 5.9.3 (the version this repository pins)  0 + 0
//
// The pinned compiler tolerates the Closure-style `{function(string): T}` type, so
// this is not a defect today and no test can catch it through the pinned
// compiler. It is a portability cliff: the day the devDependency is bumped to 7,
// `registerHooks` and `withVaultLock` stop type-checking and the eight orphan
// `@param deps.*` entries below them lose their binding. This test freezes the
// arrow form so that bump is a non-event, and its message says so rather than
// leaving the next reader to guess whether the rule is style or substance.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/** Directories whose JSDoc is read by tooling rather than only by people. */
const SCANNED_DIRECTORIES = ['lib', 'scripts', 'codex']
/** A Closure-style function type inside a JSDoc type expression. */
const CLOSURE_FUNCTION_TYPE = /\{function\s*\(/

/**
 * Every JSDoc type expression that uses the Closure function form.
 *
 * @returns {Array<{path: string, line: number, text: string}>} one entry per hit.
 */
function closureFunctionTypes() {
  const found = []
  for (const directory of SCANNED_DIRECTORIES) {
    for (const name of readdirSync(join(ROOT, directory)).sort()) {
      if (!name.endsWith('.js') && !name.endsWith('.mjs')) continue
      const path = join(directory, name)
      const lines = readFileSync(join(ROOT, path), 'utf8').split('\n')
      for (const [index, text] of lines.entries()) {
        if (CLOSURE_FUNCTION_TYPE.test(text))
          found.push({ path, line: index + 1, text: text.trim() })
      }
    }
  }
  return found
}

test('no JSDoc type expression uses the Closure function form', () => {
  const found = closureFunctionTypes()
  const report = found.map((hit) => `  ${hit.path}:${hit.line}  ${hit.text}`).join('\n')
  assert.equal(
    found.length,
    0,
    `TypeScript 7 (npm latest) rejects these with TS1005; write the arrow form instead:\n${report}`,
  )
})
