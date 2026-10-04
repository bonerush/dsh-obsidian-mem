// Repository conventions that no other tool checks: the type ratchet's two
// lists, the bilingual README hash record, and the documentation's commands.
//
// The ratchet (Task 4) works by `checkJs: false` plus a `// @ts-check` marker per
// file, and that combination has exactly one hole: a marked file that is neither
// listed in `tsconfig.json`'s `files` nor imported by a listed file is never
// loaded into the program, so its marker does nothing and reports nothing. The
// two lists have to be the same set, and both halves are asserted here.
//
// The shebang assertion exists because of a measured trap: `codex/server.mjs` and
// `scripts/verify-pack.mjs` start with one, and a marker written above it is a hard
// `TS18026` (plus `TS1005`) rather than a harmless comment.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MARKER = '// @ts-check'
/** The bilingual documentation pair; both sides carry equal authority. */
const README_PAIR = ['README.md', 'README.zh.md']
/**
 * Documents whose `npm run` references have to be real scripts.
 *
 * `AGENTS.md` is a local maintenance document — the repository ignores it (see
 * `/.gitignore`) — so a clone that has none is not a failure: the check runs over
 * whichever of these documents this checkout actually carries.
 */
const DOCUMENTS = ['AGENTS.md', 'README.md', 'README.zh.md']
/** Directories that participate in the type ratchet. */
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

/**
 * Git's blob hash for one file: sha1 over `blob <byte length>\0` plus the bytes.
 *
 * Byte length, not `String.length`: these files are Chinese and English, so a
 * character count is a different number and would produce a hash that never
 * matches `git hash-object`. Computed with `node:crypto` rather than by shelling
 * out to git, so the check gives the same answer in CI and in a bare checkout.
 *
 * @param {string} path - absolute path of the file.
 * @returns {string} the lowercase hex blob hash.
 */
function gitBlobHash(path) {
  const bytes = readFileSync(path)
  return createHash('sha1')
    .update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`, 'utf8'), bytes]))
    .digest('hex')
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

test('README.i18n.yaml records the current blob hash of both READMEs', () => {
  const record = YAML.parse(readFileSync(join(ROOT, 'README.i18n.yaml'), 'utf8'))
  for (const name of README_PAIR) {
    assert.equal(
      gitBlobHash(join(ROOT, name)),
      record[name],
      `${name} changed without re-recording its hash; run git hash-object ${name} and update README.i18n.yaml`,
    )
  }
})

/**
 * The four documents that must each carry the curation switch and its approval route.
 *
 * The bilingual pair carries equal authority and both portable skill editions are
 * loaded by a real agent, so a switch documented on one side only is a language (or
 * a harness) reading a different plugin. `autoCurate` is the field a reader has to
 * find before turning automation off, and `dsh-obsidian-mem-review` is the only
 * route that can approve a parked proposal — a document that omits the second one
 * leaves "how do I approve this?" with no answer that is not a model call.
 */
const CURATION_DOCUMENTS = [
  'README.md',
  'README.zh.md',
  'skills/obsidian-mem/SKILL.md',
  'codex/marketplace/plugins/dsh-obsidian-mem/skills/obsidian-mem/SKILL.md',
]

test('both README sides and both skill editions name the curation switch and its approval route', () => {
  const missing = []
  for (const document of CURATION_DOCUMENTS) {
    const text = readFileSync(join(ROOT, document), 'utf8')
    for (const needle of ['autoCurate', 'dsh-obsidian-mem-review']) {
      if (!text.includes(needle)) missing.push(`${document} does not name ${needle}`)
    }
  }
  assert.deepEqual(
    missing,
    [],
    'a switch documented on one side only is how one language goes stale',
  )
})

test('every npm run command named in the documentation exists', () => {
  const scripts = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts
  const missing = []
  for (const document of DOCUMENTS) {
    if (!existsSync(join(ROOT, document))) continue
    const text = readFileSync(join(ROOT, document), 'utf8')
    for (const match of text.matchAll(/npm run ([a-zA-Z0-9:_-]+)/g)) {
      if (scripts[match[1]] === undefined) missing.push(`${document} names npm run ${match[1]}`)
    }
  }
  assert.deepEqual(
    missing,
    [],
    'a documented command that does not exist is worse than no documentation',
  )
})
