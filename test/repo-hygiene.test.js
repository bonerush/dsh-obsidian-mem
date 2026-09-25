// Task 4: guard the opt-in type ratchet, both directions.
//
// The ratchet works by `checkJs: false` plus a `// @ts-check` marker per file, and
// that combination has exactly one hole: a marked file that is neither listed in
// `tsconfig.json`'s `files` nor imported by a listed file is never loaded into the
// program, so its marker does nothing and reports nothing. The two lists have to
// be the same set, and both halves are asserted here.
//
// The second assertion exists because of a measured trap: `codex/prepare.mjs` and
// `codex/server.mjs` start with a shebang, and a marker written above it is a hard
// `TS18026` (plus `TS1005`) rather than a harmless comment. A shebang that is not
// the first line is that mistake, so it is checked directly.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MARKER = '// @ts-check'
/** Directories that participate in the ratchet. */
const SCANNED_DIRECTORIES = ['lib', 'scripts', 'codex']

/** The `files` list from `tsconfig.json`, as repository-relative POSIX paths. */
function configuredFiles() {
  const { files } = JSON.parse(readFileSync(join(ROOT, 'tsconfig.json'), 'utf8'))
  return [...files].sort()
}

/** Every source file under the scanned directories that carries the marker. */
function markedFiles() {
  const marked = []
  for (const directory of SCANNED_DIRECTORIES) {
    for (const name of readdirSync(join(ROOT, directory)).sort()) {
      if (!name.endsWith('.js') && !name.endsWith('.mjs')) continue
      const path = `${directory}/${name}`
      if (readFileSync(join(ROOT, path), 'utf8').includes(MARKER)) marked.push(path)
    }
  }
  return marked.sort()
}

test('the marked files and tsconfig.json files are the same set', () => {
  const configured = configuredFiles()
  const marked = markedFiles()
  assert.deepEqual(
    configured,
    marked,
    'a marked file outside tsconfig.files is never loaded, and a listed file without a marker reports nothing',
  )
})

test('every shebang is on the first line, so a marker cannot precede one', () => {
  for (const path of markedFiles()) {
    const lines = readFileSync(join(ROOT, path), 'utf8').split('\n')
    const shebangAt = lines.findIndex((line) => line.startsWith('#!'))
    assert.ok(
      shebangAt <= 0,
      `${path}: a shebang at line ${shebangAt + 1} means something was written above it — TypeScript rejects that with TS18026`,
    )
  }
})
