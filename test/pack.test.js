// Task 19: the package manifest contract, and the verifier that guards it.
//
// `npm run prepack` is the release gate: it runs this suite and then
// `scripts/verify-pack.mjs`. A verifier nothing exercises is a verifier that
// quietly rots, so every failure condition the ruling names is pinned here
// against a throwaway fixture tree — the real checkout is only ever read.
//
// The fixture is deliberately tiny: it is the smallest tree that satisfies the
// contract, so a case can break exactly one thing and still fail for that
// reason alone.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { REQUIRED_ENTRIES, verifyTarballEntries } from '../scripts/verify-tarball.mjs'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const VERIFIER = resolve(REPO_ROOT, 'scripts/verify-pack.mjs')
const TARBALL_VERIFIER = resolve(REPO_ROOT, 'scripts/verify-tarball.mjs')

/**
 * The six tool names the shipped surface registers, and the four names the façade
 * publishes them through.
 *
 * Both halves exist in the fixture because the verifier checks both: the
 * registration sites live in `lib/tool-registry.js` and the re-exports in
 * `lib/tools.js` since Task 11, and a fixture that only wrote one of the two
 * files would be testing a package layout this plugin no longer has.
 */
const TOOL_NAMES = ['mem_search', 'mem_read', 'mem_write', 'mem_log', 'mem_brief', 'mem_admin']

/** The four published names, and the module each one is re-exported from. */
const FACADE = [
  ['TOOL_NAMES', './tool-schema.js'],
  ['TOOL_PARAMETERS', './tool-schema.js'],
  ['registerTools', './tool-registry.js'],
  ['createMemoryServices', './services.js'],
]

/**
 * A `lib/tool-registry.js` with one `name: '…'` registration site per tool.
 *
 * @param {string[]} [names] - the tools to register.
 * @returns {string} the module's contents.
 */
function registrySource(names = TOOL_NAMES) {
  return names.map((name) => `  name: '${name}',\n`).join('')
}

/**
 * A `lib/tools.js` façade. By default it is the real one's three re-export
 * statements; `omit` drops a name so a case can break exactly that.
 *
 * @param {string[]} [omit] - published names to leave out.
 * @returns {string} the module's contents.
 */
function facadeSource(omit = []) {
  const byModule = new Map()
  for (const [name, module] of FACADE) {
    if (omit.includes(name)) continue
    byModule.set(module, [...(byModule.get(module) ?? []), name])
  }
  const lines = [...byModule].map(
    ([module, names]) => `export { ${names.join(', ')} } from '${module}'`,
  )
  return `${lines.join('\n')}\n`
}

/**
 * The smallest manifest that satisfies every mandatory check.
 *
 * Kept as a literal so a case can override exactly one field and know the rest
 * still describe a packable package.
 *
 * @returns {object} a fresh, mutable `package.json` value.
 */
function baseManifest() {
  return {
    name: 'dsh-obsidian-mem',
    version: '0.1.0',
    main: 'lib/index.js',
    engines: { node: '>=22.22.2' },
    files: [
      'lib',
      'skills/obsidian-mem/SKILL.md',
      'cordis.patch.yml',
      'dsh.plugin.json',
      'README.md',
      'LICENSE',
    ],
  }
}

/** The `dsh.plugin.json` that matches `baseManifest()`. */
function basePluginManifest() {
  return { id: 'dsh-obsidian-mem', version: '0.1.0', main: 'lib/index.js' }
}

/** Write one file, creating its parent directories. */
function write(root, path, content) {
  const full = join(root, path)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content)
}

/**
 * Build a fixture tree and run the verifier against it.
 *
 * @param {object} [options] - overrides.
 * @param {object} [options.pkg] - a complete replacement `package.json`.
 * @param {object} [options.plugin] - a complete replacement `dsh.plugin.json`.
 * @param {string[]} [options.omit] - asset paths to leave off disk.
 * @returns {{status:number, stdout:string, stderr:string, root:string}} the run.
 */
function verify(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'obsidian-mem-pack-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const omit = new Set(options.omit ?? [])
  const assets = {
    'lib/index.js': "export const name = 'obsidian-mem'\n",
    'lib/tools.js': facadeSource(),
    'lib/tool-registry.js': registrySource(),
    'skills/obsidian-mem/SKILL.md': '---\nname: obsidian-mem\n---\n',
    'cordis.patch.yml': '- insert: []\n',
    'dsh.plugin.json': `${JSON.stringify(options.plugin ?? basePluginManifest(), null, 2)}\n`,
    'README.md': '# fixture\n',
    LICENSE: 'MIT\n',
  }
  for (const [path, content] of Object.entries(assets)) {
    if (!omit.has(path)) write(root, path, content)
  }
  write(root, 'package.json', `${JSON.stringify(options.pkg ?? baseManifest(), null, 2)}\n`)
  const run = spawnSync(process.execPath, [VERIFIER, '--root', root], { encoding: 'utf8' })
  return { status: run.status, stdout: run.stdout ?? '', stderr: run.stderr ?? '', root }
}

test('the shipped manifest passes the pack verifier', () => {
  const run = spawnSync(process.execPath, [VERIFIER], { encoding: 'utf8' })
  assert.equal(run.status, 0, `expected the real manifest to pass:\n${run.stdout}${run.stderr}`)
  assert.match(run.stdout, /verify-pack: OK/)
})

test('a fixture that satisfies the contract passes', (t) => {
  const run = verify(t)
  assert.equal(run.status, 0, run.stdout + run.stderr)
})

test('a version disagreement between the two manifests fails', (t) => {
  const run = verify(t, { plugin: { ...basePluginManifest(), version: '0.2.0' } })
  assert.notEqual(run.status, 0)
  assert.match(run.stdout + run.stderr, /0\.1\.0/)
  assert.match(run.stdout + run.stderr, /0\.2\.0/)
})

test('dropping the portable skill from files fails', (t) => {
  const pkg = baseManifest()
  pkg.files = pkg.files.filter((entry) => entry !== 'skills/obsidian-mem/SKILL.md')
  // `lib` stays, so the only thing missing is the skill asset itself.
  const run = verify(t, { pkg })
  assert.notEqual(run.status, 0)
  assert.match(run.stdout + run.stderr, /skills\/obsidian-mem\/SKILL\.md/)
})

test('a skill asset listed but absent on disk fails', (t) => {
  const run = verify(t, { omit: ['skills/obsidian-mem/SKILL.md'] })
  assert.notEqual(run.status, 0)
  assert.match(run.stdout + run.stderr, /skills\/obsidian-mem\/SKILL\.md/)
})

test('an entry that is absolute or escapes the package root fails', (t) => {
  for (const entry of ['/etc/passwd', '../outside', 'lib/../../outside', '~/.dsh']) {
    const pkg = baseManifest()
    pkg.files = [...pkg.files, entry]
    const run = verify(t, { pkg })
    assert.notEqual(run.status, 0, `expected ${entry} to be refused`)
    assert.match(
      run.stdout + run.stderr,
      /files/,
      `expected the report to name \`files\` for ${entry}`,
    )
  }
})

test('probe records, dependency trees and pending data can never be packed', (t) => {
  const forbidden = [
    'scratch/notes.md',
    'research/prior-art.md',
    'docs/design.md',
    'test/pack.test.js',
    'node_modules/left-pad/index.js',
    'pending/jobs/job.json',
    '_meta/hot.md',
    '.superpowers/sdd/task-19-brief.md',
    'probe-events.jsonl',
    'lib/pending/queue.json',
    'lib/_meta/.history/tx1/hot.md',
    'lib/index.db',
  ]
  for (const entry of forbidden) {
    const pkg = baseManifest()
    pkg.files = [...pkg.files, entry]
    const run = verify(t, { pkg })
    assert.notEqual(run.status, 0, `expected ${entry} to be refused`)
    assert.match(
      run.stdout + run.stderr,
      new RegExp(entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `expected the report to name ${entry}`,
    )
  }
})

test('a directory entry is expanded, so forbidden files under lib are refused', (t) => {
  const run = verify(t)
  assert.equal(run.status, 0, run.stdout + run.stderr)
  // Same tree, one forbidden file added under the `lib` directory entry.
  const second = verify(t, { pkg: baseManifest() })
  assert.equal(second.status, 0)
  write(second.root, 'lib/pending/queue.json', '{}\n')
  const rerun = spawnSync(process.execPath, [VERIFIER, '--root', second.root], { encoding: 'utf8' })
  assert.notEqual(rerun.status, 0)
  assert.match(rerun.stdout + rerun.stderr, /lib\/pending\/queue\.json/)
})

test('a missing plugin entry, a missing registry or a dropped tool fails', (t) => {
  const missingEntry = verify(t, { omit: ['lib/index.js'] })
  assert.notEqual(missingEntry.status, 0)
  assert.match(missingEntry.stdout + missingEntry.stderr, /lib\/index\.js/)

  // The registration module is its own required file now: shipping the façade
  // without it is a package whose six names resolve to nothing.
  const missingRegistry = verify(t, { omit: ['lib/tool-registry.js'] })
  assert.notEqual(missingRegistry.status, 0)
  assert.match(missingRegistry.stdout + missingRegistry.stderr, /lib\/tool-registry\.js is missing/)

  const pkg = baseManifest()
  const droppedTool = verify(t, { pkg })
  assert.equal(droppedTool.status, 0, droppedTool.stdout + droppedTool.stderr)
  write(droppedTool.root, 'lib/tool-registry.js', registrySource(TOOL_NAMES.slice(0, 5)))
  const rerun = spawnSync(process.execPath, [VERIFIER, '--root', droppedTool.root], {
    encoding: 'utf8',
  })
  assert.notEqual(rerun.status, 0)
  assert.match(rerun.stdout + rerun.stderr, /no longer registers mem_admin/)
})

test('an unstated Node floor fails', (t) => {
  const pkg = baseManifest()
  delete pkg.engines
  const run = verify(t, { pkg })
  assert.notEqual(run.status, 0)
  assert.match(run.stdout + run.stderr, /engines/)
})

// The regression that made this check worth tightening: a bare substring search
// over the registry passes on the module's own header comment and on the
// exported `TOOL_NAMES` list, so it kept passing with every registration deleted.
// These two cases pin the shapes that must be distinguished.
test('the tool check requires a registration site, not a mention', (t) => {
  const run = verify(t)
  assert.equal(run.status, 0, run.stdout + run.stderr)

  // Every one of the six names is still present as a *mention* — in a comment and
  // in an exported list — while `mem_admin` has no `name: '…'` registration.
  write(
    run.root,
    'lib/tool-registry.js',
    [
      '// The six tools: mem_search, mem_read, mem_write, mem_log, mem_brief, mem_admin.',
      `export const TOOL_NAMES = Object.freeze([${TOOL_NAMES.map((name) => `'${name}'`).join(', ')}])`,
      ...TOOL_NAMES.filter((name) => name !== 'mem_admin').map((name) => `  name: '${name}',\n`),
    ].join('\n'),
  )
  const dropped = spawnSync(process.execPath, [VERIFIER, '--root', run.root], { encoding: 'utf8' })
  assert.notEqual(dropped.status, 0, 'a comment and an export list must not satisfy the check')
  assert.match(dropped.stdout + dropped.stderr, /no longer registers mem_admin/)
})

test('a seventh registration fails, because the surface is capped at six', (t) => {
  const run = verify(t)
  assert.equal(run.status, 0, run.stdout + run.stderr)
  write(run.root, 'lib/tool-registry.js', registrySource([...TOOL_NAMES, 'mem_extra']))
  const extra = spawnSync(process.execPath, [VERIFIER, '--root', run.root], { encoding: 'utf8' })
  assert.notEqual(extra.status, 0)
  assert.match(extra.stdout + extra.stderr, /mem_extra/)
})

// Task 11's own failure mode, and the reason the façade is checked separately
// from the registrations: all six tools can be registered correctly while
// `lib/tools.js` publishes none of them, because both entry points import
// through the façade. The package installs, the plugin loads, the surface is
// empty — nothing above this line would notice.
test('a façade that stops publishing a name fails, even with every tool registered', (t) => {
  const run = verify(t)
  assert.equal(run.status, 0, run.stdout + run.stderr)
  write(run.root, 'lib/tools.js', facadeSource(['registerTools']))
  const trimmed = spawnSync(process.execPath, [VERIFIER, '--root', run.root], { encoding: 'utf8' })
  assert.notEqual(trimmed.status, 0)
  assert.match(trimmed.stdout + trimmed.stderr, /no longer re-exports registerTools/)
  // …and the registrations it would have published are still all there.
  assert.doesNotMatch(trimmed.stdout + trimmed.stderr, /no longer registers/)
})

test('a local copy of a published name does not satisfy the façade check', (t) => {
  const run = verify(t)
  assert.equal(run.status, 0, run.stdout + run.stderr)
  // A second, structurally-equal `TOOL_NAMES` is exactly what the façade must not
  // grow: it compiles, it passes type checking, and it drifts.
  write(run.root, 'lib/tools.js', `export const TOOL_NAMES = []\n${facadeSource(['TOOL_NAMES'])}`)
  const copied = spawnSync(process.execPath, [VERIFIER, '--root', run.root], { encoding: 'utf8' })
  assert.notEqual(copied.status, 0, 'a declared copy is not a re-export')
  assert.match(copied.stdout + copied.stderr, /no longer re-exports TOOL_NAMES/)
})

// ---------------------------------------------------------------------------
// Task 6: the real archive, checked as a set rather than a count.
// ---------------------------------------------------------------------------

/**
 * A complete, synthetic archive listing.
 *
 * @param {object} [overrides] - `drop` removes entries, `add` appends them.
 * @returns {string[]} archive paths.
 */
function archiveListing({ drop = [], add = [] } = {}) {
  const base = [
    ...REQUIRED_ENTRIES.map(([path]) => path),
    ...LISTED_LIB.map((path) => `package/${path}`),
  ]
  return [...base.filter((path) => !drop.includes(path)), ...add]
}

/** The lib modules the synthetic listing claims to carry. */
const LISTED_LIB = ['lib/index.js', 'lib/tools.js']

test('a complete archive listing passes the tarball contract', () => {
  assert.deepEqual(verifyTarballEntries(archiveListing(), LISTED_LIB), [])
})

test('a missing required asset is named, and its reason with it', () => {
  const problems = verifyTarballEntries(
    archiveListing({ drop: ['package/README.zh.md'] }),
    LISTED_LIB,
  )
  assert.equal(problems.length, 1)
  assert.match(problems[0], /package\/README\.zh\.md/)
  assert.match(problems[0], /Chinese half/)
})

test('the contract is a set of lib modules, not a frozen count', () => {
  // A new module that ships is fine — this is what a fixed "33 files" would break.
  const grown = archiveListing({ add: ['package/lib/new-module.js'] })
  assert.deepEqual(verifyTarballEntries(grown, [...LISTED_LIB, 'lib/new-module.js']), [])
  // A module on disk that did not ship is the failure that matters.
  const problems = verifyTarballEntries(archiveListing(), [...LISTED_LIB, 'lib/new-module.js'])
  assert.equal(problems.length, 1)
  assert.match(problems[0], /missing lib\/new-module\.js/)
})

test('a packed development tree or vault artefact fails', () => {
  const cases = [
    ['package/test/pack.test.js', /development or runtime state/],
    ['package/docs/superpowers/specs/x.md', /development or runtime state/],
    ['package/lib/pending/queue.json', /vault or data-root state/],
    ['package/lib/foo.lock', /evidence rather than package content/],
  ]
  for (const [entry, pattern] of cases) {
    const problems = verifyTarballEntries(archiveListing({ add: [entry] }), LISTED_LIB)
    assert.equal(problems.length, 1, `${entry} should be refused`)
    assert.match(problems[0], pattern)
  }
})

test('the archive this checkout really produces satisfies the contract', () => {
  const run = spawnSync(process.execPath, [TARBALL_VERIFIER], { encoding: 'utf8' })
  assert.equal(run.status, 0, run.stdout + run.stderr)
  assert.match(run.stdout, /verify-tarball: OK/)
  // The report has to stay informative without freezing a number.
  assert.match(run.stdout, /lib modules, every required asset present/)
})
