// Task 5: idempotent bootstrap and the project registry.
//
// Every case below runs against REAL temporary filesystems and a REAL git
// repository — never an fs mock — because what is under test is exactly what
// `mkdir(…, {recursive:true})`, `open(…, 'wx')`, `lstat` and `git init` do on
// this machine. Fixtures are built from `mkdtemp`, a temporary `home` is passed
// for every `~/`/cloud decision, and nothing here reads or writes the user's
// real `~/.dsh`, documents folder or cloud storage.
//
// The registry is validated independently of the writer: the declared region
// hash is recomputed here with `node:crypto` from the bytes between the markers,
// and the table is re-parsed with the Task 4 parser, so a writer bug cannot make
// its own evidence pass.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { parse as parseYaml } from 'yaml'

import { escapeRegistryCell, PROJECTS_DIR, REGISTRY_RELATIVE_PATH } from '../lib/registry.js'
import { bootstrapVault, BootstrapError, parseRegistryMarkdown, resolveBinding } from '../lib/vault.js'

const execFileAsync = promisify(execFile)

/** Fixed identities. Both are valid UUIDv4 values (version nibble `4`). */
const ID1 = '1c392abb-7b08-42f7-871d-2a379caf9448'
const ID2 = '5f0e6d1c-9a4b-4c2d-8e3f-0b7a6c5d4e3f'
/** Shares ID1's first eight hex digits, so it can claim the same directory name. */
const ID1_TWIN = '1c392abb-1111-4aaa-8bbb-222222222222'

/** The per-project content directories, each of which owns an `index.md` MOC. */
const MOC_DIRS = Object.freeze(['Docs', 'Decisions', 'Conventions', 'Pitfalls', 'Daily', 'Inbox'])

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function gitEnvironment() {
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY']) {
    delete env[key]
  }
  return env
}

function git(cwd, args) {
  return execFileAsync(
    'git',
    [
      '-c', 'user.name=Task Five',
      '-c', 'user.email=t5@example.invalid',
      '-c', 'commit.gpgsign=false',
      '-c', 'init.defaultBranch=main',
      ...args,
    ],
    { cwd, env: gitEnvironment(), encoding: 'utf8' },
  )
}

async function initRepo(dir) {
  await mkdir(dir, { recursive: true })
  await git(dir, ['init', '-q'])
  await git(dir, ['commit', '-q', '--allow-empty', '-m', 'init'])
}

/** One throwaway root: a temporary home, two repos and vault paths that do not exist yet. */
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'obsidian-mem-t5-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 4 }))
  // Task 7: the registry write is now a vault transaction, which needs an
  // explicit data root for its lock, manifest and receipt store. It is a second
  // throwaway directory on purpose — this file asserts that neither the
  // temporary home nor the fixture root gains a single entry.
  const dataRoot = await mkdtemp(join(tmpdir(), 'obsidian-mem-t5-data-'))
  t.after(() => rm(dataRoot, { recursive: true, force: true, maxRetries: 4 }))
  const home = join(root, 'home')
  await mkdir(home, { recursive: true })
  return {
    root,
    home,
    dataRoot,
    vault: join(root, 'vault'),
    freshVault: join(root, 'fresh-vault'),
    repo: join(root, 'repo'),
    otherRepo: join(root, 'repo-b'),
  }
}

/** Write a pointer into a fresh git repo and resolve the real Task 4 binding. */
async function bind({ vault, repo, home, projectId = ID1, slug = 'alpha', displayName = 'Alpha' }) {
  await initRepo(repo)
  await writeFile(
    join(repo, '.obsidian-mem'),
    `${JSON.stringify({ projectId, slug, displayName, schema: 1 }, null, 2)}\n`,
  )
  const binding = await resolveBinding({ cwd: repo, vaultRoot: vault, home })
  assert.equal(binding.kind, 'bound', `expected a bound fixture (got ${binding.kind}: ${binding.reason ?? ''})`)
  return binding
}

/** A binding object of the shape `resolveBinding` returns, built without a repo. */
function handBinding(vaultRoot, { projectId = ID1, slug = 'alpha', displayName = 'Alpha', relativeDir } = {}) {
  return {
    kind: 'bound',
    projectId,
    slug,
    displayName,
    schema: 1,
    vaultRoot,
    relativeDir: relativeDir ?? `${PROJECTS_DIR}/${slug}--${projectId.slice(0, 8)}`,
  }
}

// ---------------------------------------------------------------------------
// Expected vault shape (spec §5.1) and read-back helpers
// ---------------------------------------------------------------------------

function vaultTargets(relativeDir) {
  return {
    dirs: [
      '_meta',
      '_meta/.history',
      'Methods',
      PROJECTS_DIR,
      relativeDir,
      `${relativeDir}/_meta`,
      ...MOC_DIRS.map((dir) => `${relativeDir}/${dir}`),
    ],
    files: [
      '.gitignore',
      'Methods/index.md',
      `${relativeDir}/index.md`,
      `${relativeDir}/_meta/hot.md`,
      ...MOC_DIRS.map((dir) => `${relativeDir}/${dir}/index.md`),
      REGISTRY_RELATIVE_PATH,
      // R21: bootstrap creates the user's preferences file once, from a template.
      '_meta/user.md',
    ],
  }
}

/** Every entry below `root`, as `relative path -> 'dir' | 'file'`; `.git` is ignored. */
async function listRelative(root) {
  const found = new Map()
  async function walk(dir, prefix) {
    for (const name of (await readdir(dir)).sort()) {
      if (name === '.git' && prefix === '') continue
      const abs = join(dir, name)
      const rel = `${prefix}${name}`
      const stat = await lstat(abs)
      if (stat.isDirectory()) {
        found.set(rel, 'dir')
        await walk(abs, `${rel}/`)
      } else {
        found.set(rel, 'file')
      }
    }
  }
  await walk(root, '')
  return found
}

/** Path -> base64 bytes + mtime, for the "second run changes nothing" proof. */
async function snapshot(root) {
  const entries = new Map()
  for (const [rel, kind] of await listRelative(root)) {
    const stat = await lstat(join(root, rel))
    entries.set(rel, {
      kind,
      mtimeMs: stat.mtimeMs,
      bytes: kind === 'file' ? (await readFile(join(root, rel))).toString('base64') : null,
    })
  }
  return entries
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/**
 * Split the registry document into its declared hash and the bytes it covers.
 * The covered body is the text between the two marker lines, excluding the line
 * terminator that ends the begin-marker line — the convention
 * `renderRegistryRegion` hashes and `inspectRegistryRegion` verifies.
 */
function registryRegion(text) {
  const match = /<!--\s*obsidian-mem:registry begin sha256:([0-9a-f]{64})\s*-->(\r?\n)?([\s\S]*?)<!--\s*obsidian-mem:registry end\s*-->/.exec(text)
  assert.ok(match, 'the registry must carry a generated region with a sha256 marker')
  return { declaredHash: match[1], body: match[3] }
}

/** Parse a note's frontmatter the way Obsidian would: from byte 0, no BOM, closed. */
function note(text) {
  assert.notEqual(text.charCodeAt(0), 0xfeff, 'a note must not start with a BOM')
  const lines = text.split('\n')
  assert.equal(lines[0], '---', 'frontmatter must start at byte 0')
  const end = lines.indexOf('---', 1)
  assert.ok(end > 1, 'frontmatter must close')
  const frontmatter = parseYaml(lines.slice(1, end).join('\n'))
  assert.ok(frontmatter !== null && typeof frontmatter === 'object', 'frontmatter must be a mapping')
  return { frontmatter, body: lines.slice(end + 1).join('\n') }
}

async function registryText(vault) {
  return readFile(join(vault, REGISTRY_RELATIVE_PATH), 'utf8')
}

/** A hand-written registry table, used to tamper with a valid one. */
function rawRegistry(rows, { hash } = {}) {
  const body = [
    '| projectId | hub 相对路径 | displayName | remote |',
    '| --- | --- | --- | --- |',
    ...rows,
  ].join('\n') + '\n'
  return `<!-- obsidian-mem:registry begin sha256:${hash ?? sha256(body)} -->\n${body}<!-- obsidian-mem:registry end -->\n`
}

function tableRow(projectId, hub, displayName, remote = '') {
  return `| ${projectId} | [[${hub}/index\\|${basename(hub)}]] | ${displayName} | ${remote} |`
}

// ---------------------------------------------------------------------------
// Step 1: the first run creates the whole skeleton
// ---------------------------------------------------------------------------

test('the first run creates every §5.1 directory and MOC and registers the project', async (t) => {
  const { root, vault, repo, home, dataRoot } = await fixture(t)
  const binding = await bind({ vault, repo, home })

  const result = await bootstrapVault(binding, { initGitOnCreate: false, home, dataRoot })
  const expected = vaultTargets(binding.relativeDir)

  assert.equal(binding.relativeDir, `${PROJECTS_DIR}/alpha--${ID1.slice(0, 8)}`)
  assert.equal(result.vaultCreated, true)
  assert.equal(result.gitInitialized, false)
  assert.equal(result.registryUpdated, true)
  assert.equal(result.relativeDir, binding.relativeDir)

  // exactly the §5.1 skeleton exists — nothing else was written into the vault
  const found = await listRelative(vault)
  const wanted = new Map([
    ...expected.dirs.map((dir) => [dir, 'dir']),
    ...expected.files.map((file) => [file, 'file']),
  ])
  assert.deepEqual(found, wanted)

  assert.deepEqual([...result.createdPaths].sort(), [...wanted.keys()].sort())
  assert.deepEqual(result.existingPaths, [])

  // the registry is the vault MOC: one row, the fixed four columns, a real hash
  const text = await registryText(vault)
  const { declaredHash, body } = registryRegion(text)
  assert.equal(declaredHash, sha256(body))
  const { regionPresent, rows } = parseRegistryMarkdown(text)
  assert.equal(regionPresent, true)
  assert.deepEqual(rows, [{
    projectId: ID1,
    dir: binding.relativeDir,
    displayName: 'Alpha',
    remote: '',
  }])
  assert.ok(body.includes('| projectId | hub 相对路径 | displayName | remote |'))

  // every index.md is a parseable hub MOC in the closed property vocabulary
  for (const dir of ['', ...MOC_DIRS.map((name) => `${name}/`)]) {
    const path = join(binding.projectDir, `${dir}index.md`)
    const { frontmatter } = note(await readFile(path, 'utf8'))
    assert.equal(frontmatter.type, 'hub', `${dir}index.md must be a hub`)
    assert.equal(frontmatter.project, ID1)
    assert.deepEqual(frontmatter.tags, ['dsh-mem/hub', 'project/alpha'])
    assert.match(frontmatter.created, /^\d{4}-\d{2}-\d{2}$/)
    assert.equal(frontmatter.id.startsWith('hub-'), true)
  }
  const method = note(await readFile(join(vault, 'Methods/index.md'), 'utf8'))
  assert.equal(method.frontmatter.project, null, 'Methods/ is cross-project')

  // the hub links to each type directory with a vault-root-relative wikilink
  const hub = await readFile(join(binding.projectDir, 'index.md'), 'utf8')
  for (const dir of MOC_DIRS) {
    assert.ok(hub.includes(`[[${binding.relativeDir}/${dir}/index|${dir}]]`), `hub must link to ${dir}`)
  }

  // hot.md carries the three fixed plugin-managed sections
  const hot = note(await readFile(join(binding.projectDir, '_meta', 'hot.md'), 'utf8'))
  assert.equal(hot.frontmatter.type, 'hot')
  assert.equal(hot.frontmatter.project, ID1)
  for (const section of ['强约束', '进行中', '已完成']) {
    assert.ok(hot.body.includes(`## ${section}`), `hot.md must carry the ${section} section`)
  }

  // nothing was written into the temporary home, or anywhere else outside the vault
  assert.deepEqual(await readdir(home), [])
  assert.deepEqual((await readdir(root)).sort(), ['home', 'repo', 'vault'])
})

test('a second run leaves every byte and mtime unchanged', async (t) => {
  const { vault, repo, home, dataRoot } = await fixture(t)
  const binding = await bind({ vault, repo, home })

  const first = await bootstrapVault(binding, { initGitOnCreate: false, home, dataRoot })
  const before = await snapshot(vault)

  const second = await bootstrapVault(binding, { initGitOnCreate: false, home, dataRoot })
  assert.deepEqual(await snapshot(vault), before, 'a second run must not touch a single file')

  assert.deepEqual(second.createdPaths, [])
  assert.equal(second.registryUpdated, false)
  assert.deepEqual([...second.existingPaths].sort(), [...first.createdPaths].sort())
})

test('a hand-written index.md is preserved and only missing items are added', async (t) => {
  const { vault, repo, home, dataRoot } = await fixture(t)
  const binding = await bind({ vault, repo, home })

  const handwritten = '# 我自己写的 hub\n\n这里是我的内容，插件不得改动。\n'
  await mkdir(binding.projectDir, { recursive: true })
  await writeFile(join(binding.projectDir, 'index.md'), handwritten)
  const before = await lstat(join(binding.projectDir, 'index.md'))

  const result = await bootstrapVault(binding, { initGitOnCreate: false, home, dataRoot })

  assert.equal(await readFile(join(binding.projectDir, 'index.md'), 'utf8'), handwritten)
  assert.equal((await lstat(join(binding.projectDir, 'index.md'))).mtimeMs, before.mtimeMs)
  assert.equal(result.createdPaths.includes(`${binding.relativeDir}/index.md`), false)
  assert.equal(result.existingPaths.includes(`${binding.relativeDir}/index.md`), true)
  // the missing MOC and hot.md were added around it
  for (const added of ['Pitfalls/index.md', '_meta/hot.md']) {
    assert.equal(result.createdPaths.includes(`${binding.relativeDir}/${added}`), true, `${added} must be created`)
  }
  const expected = vaultTargets(binding.relativeDir)
  const found = await listRelative(vault)
  assert.deepEqual(found, new Map([
    ...expected.dirs.map((dir) => [dir, 'dir']),
    ...expected.files.map((file) => [file, 'file']),
  ]))
})

// ---------------------------------------------------------------------------
// Step 1: git init is limited to a vault this call just created
// ---------------------------------------------------------------------------

test('a vault that already exists is never git-initialised', async (t) => {
  const { vault, repo, home, dataRoot } = await fixture(t)
  await mkdir(vault, { recursive: true })
  const binding = await bind({ vault, repo, home })

  const result = await bootstrapVault(binding, { initGitOnCreate: true, home, dataRoot })

  assert.equal(result.vaultCreated, false)
  assert.equal(result.gitInitialized, false)
  await assert.rejects(lstat(join(vault, '.git')), { code: 'ENOENT' })
  assert.equal((await lstat(join(vault, '.gitignore'))).isFile(), true)
})

test('a vault this call created is git-initialised only when asked', async (t) => {
  const { freshVault, repo, home, dataRoot } = await fixture(t)
  const binding = await bind({ vault: freshVault, repo, home })

  const initialised = await bootstrapVault(binding, { initGitOnCreate: true, home, dataRoot })
  assert.equal(initialised.vaultCreated, true)
  assert.equal(initialised.gitInitialized, true)
  assert.equal((await lstat(join(freshVault, '.git'))).isDirectory(), true)

  const plain = await fixture(t)
  const other = await bind({ vault: plain.vault, repo: plain.repo, home: plain.home })
  const withoutGit = await bootstrapVault(other, { initGitOnCreate: false, home: plain.home, dataRoot: plain.dataRoot })
  assert.equal(withoutGit.vaultCreated, true)
  assert.equal(withoutGit.gitInitialized, false)
  await assert.rejects(lstat(join(plain.vault, '.git')), { code: 'ENOENT' })
})

test('initGitOnCreate must be a boolean', async (t) => {
  const { vault, repo, home, dataRoot } = await fixture(t)
  const binding = await bind({ vault, repo, home })
  await assert.rejects(bootstrapVault(binding, { initGitOnCreate: 'yes', home, dataRoot }), RangeError)
})

// ---------------------------------------------------------------------------
// Step 1: user.md is read-only for the plugin
// ---------------------------------------------------------------------------

test('_meta/user.md is created once from a template and never rewritten (R21)', async (t) => {
  const { vault, repo, home, dataRoot } = await fixture(t)
  const binding = await bind({ vault, repo, home })

  // R21: the plugin creates the user's preferences file when it is missing ...
  const plain = await bootstrapVault(binding, { initGitOnCreate: false, home, dataRoot })
  assert.equal(plain.createdPaths.includes('_meta/user.md'), true)
  const template = await readFile(join(vault, '_meta', 'user.md'), 'utf8')
  assert.match(template, /^---\ntags: \[/)
  const created = await lstat(join(vault, '_meta', 'user.md'))

  // ... and never rewrites it: the second run reports it as existing, byte for byte.
  const second = await bootstrapVault(binding, { initGitOnCreate: false, home, dataRoot })
  assert.equal(second.createdPaths.includes('_meta/user.md'), false)
  assert.equal(second.existingPaths.includes('_meta/user.md'), true)
  assert.equal(await readFile(join(vault, '_meta', 'user.md'), 'utf8'), template)
  assert.equal((await lstat(join(vault, '_meta', 'user.md'))).mtimeMs, created.mtimeMs)

  // A hand-written one is the user's: two more runs leave it byte- and mtime-identical.
  const content = '---\ntags: [preferences]\n---\n\n我偏好中文回答。\n'
  await writeFile(join(vault, '_meta', 'user.md'), content)
  const before = await lstat(join(vault, '_meta', 'user.md'))
  await bootstrapVault(binding, { initGitOnCreate: false, home, dataRoot })
  const third = await bootstrapVault(binding, { initGitOnCreate: false, home, dataRoot })
  assert.equal(await readFile(join(vault, '_meta', 'user.md'), 'utf8'), content)
  assert.equal((await lstat(join(vault, '_meta', 'user.md'))).mtimeMs, before.mtimeMs)
  assert.equal(third.createdPaths.includes('_meta/user.md'), false)
  assert.equal(third.existingPaths.includes('_meta/user.md'), true)
})

// ---------------------------------------------------------------------------
// Step 1: the generated region — fixed columns, escaping, hash
// ---------------------------------------------------------------------------

test('the generated region carries the fixed four columns and escapes a `|` in a cell', async (t) => {
  const { vault, repo, home, dataRoot } = await fixture(t)
  const binding = await bind({ vault, repo, home, slug: 'acme', displayName: 'Acme | 记忆' })

  await bootstrapVault(binding, { initGitOnCreate: false, home, dataRoot })
  const text = await registryText(vault)
  const { declaredHash, body } = registryRegion(text)

  assert.equal(body.split('\n')[0], '| projectId | hub 相对路径 | displayName | remote |')
  assert.equal(declaredHash, sha256(body))

  const hub = binding.relativeDir
  assert.ok(text.includes(`[[${hub}/index\\|${basename(hub)}]]`), 'the hub wikilink alias must be escaped')
  assert.ok(text.includes(`| ${ID1} | [[${hub}/index\\|${basename(hub)}]] | Acme \\| 记忆 |  |`))

  // the escaped row still round-trips through the Task 4 parser
  const { rows } = parseRegistryMarkdown(text)
  assert.deepEqual(rows, [{ projectId: ID1, dir: hub, displayName: 'Acme | 记忆', remote: '' }])
})

test('escapeRegistryCell escapes separators, backslashes and refuses control characters', () => {
  assert.equal(escapeRegistryCell('a|b'), 'a\\|b')
  assert.equal(escapeRegistryCell('a\\b'), 'a\\\\b')
  assert.equal(escapeRegistryCell('a\\|b'), 'a\\\\\\|b')
  assert.equal(escapeRegistryCell(''), '')
  assert.throws(() => escapeRegistryCell('a\nb'), RangeError)
})

// ---------------------------------------------------------------------------
// Step 1: a tampered registry stops the write before anything is created
// ---------------------------------------------------------------------------

test('a tampered table with a matching hash stops the write', async (t) => {
  const { vault, repo, home, dataRoot } = await fixture(t)
  const alpha = await bind({ vault, repo, home })
  await bootstrapVault(alpha, { initGitOnCreate: false, home, dataRoot })

  const hub = alpha.relativeDir
  const registryPath = join(vault, REGISTRY_RELATIVE_PATH)
  await writeFile(registryPath, rawRegistry([tableRow(ID1, hub, 'Alpha'), tableRow(ID1, hub, 'Alpha')]))
  const before = await snapshot(vault)

  const beta = handBinding(vault, { projectId: ID2, slug: 'beta', displayName: 'Beta' })
  await assert.rejects(bootstrapVault(beta, { initGitOnCreate: false, home, dataRoot }), { code: 'registry-duplicate-id' })
  assert.deepEqual(await snapshot(vault), before, 'a refused bootstrap must not write anything')
})

test('a generated-region hash mismatch stops the write', async (t) => {
  const { vault, repo, home, dataRoot } = await fixture(t)
  const alpha = await bind({ vault, repo, home })
  await bootstrapVault(alpha, { initGitOnCreate: false, home, dataRoot })

  const registryPath = join(vault, REGISTRY_RELATIVE_PATH)
  const valid = await readFile(registryPath, 'utf8')
  const beta = handBinding(vault, { projectId: ID2, slug: 'beta', displayName: 'Beta' })

  // 1. the declared hash no longer matches the bytes it covers
  await writeFile(registryPath, valid.replace(/sha256:[0-9a-f]{64}/, `sha256:${'0'.repeat(64)}`))
  const tamperedHash = await snapshot(vault)
  await assert.rejects(bootstrapVault(beta, { initGitOnCreate: false, home, dataRoot }), { code: 'registry-hash-mismatch' })
  assert.deepEqual(await snapshot(vault), tamperedHash, 'a refused bootstrap must not write anything')

  // 2. the region carries no hash at all
  await writeFile(registryPath, valid.replace(/ begin sha256:[0-9a-f]{64}/, ' begin'))
  const noHash = await snapshot(vault)
  await assert.rejects(bootstrapVault(beta, { initGitOnCreate: false, home, dataRoot }), { code: 'registry-hash-missing' })
  assert.deepEqual(await snapshot(vault), noHash, 'a refused bootstrap must not write anything')
})

test('a symlinked _meta directory is refused instead of written through', async (t) => {
  const { root, vault, repo, home, dataRoot } = await fixture(t)
  const binding = await bind({ vault, repo, home })
  await mkdir(vault, { recursive: true })
  const outside = join(root, 'outside-meta')
  await mkdir(outside, { recursive: true })
  await symlink(outside, join(vault, '_meta'))

  await assert.rejects(bootstrapVault(binding, { initGitOnCreate: false, home, dataRoot }), /symlink/i)
  assert.deepEqual(await readdir(outside), [])
})

// ---------------------------------------------------------------------------
// Step 3/4: registry updates, uniqueness and the id ↔ directory rule
// ---------------------------------------------------------------------------

test('a second project gains its own row without disturbing the first', async (t) => {
  const { vault, repo, otherRepo, home, dataRoot } = await fixture(t)
  const alpha = await bind({ vault, repo, home })
  await bootstrapVault(alpha, { initGitOnCreate: false, home, dataRoot })

  const beta = await bind({ vault, repo: otherRepo, home, projectId: ID2, slug: 'beta', displayName: 'Beta' })
  const second = await bootstrapVault(beta, { initGitOnCreate: false, home, dataRoot })
  assert.equal(second.registryUpdated, true)

  const text = await registryText(vault)
  assert.equal(registryRegion(text).declaredHash, sha256(registryRegion(text).body))
  const { rows } = parseRegistryMarkdown(text)
  assert.deepEqual(rows.map((row) => row.projectId), [ID1, ID2])
  assert.equal(new Set(rows.map((row) => row.dir)).size, 2)

  // re-running either project is a no-op, byte for byte
  const before = await snapshot(vault)
  const againAlpha = await bootstrapVault(alpha, { initGitOnCreate: false, home, dataRoot })
  const againBeta = await bootstrapVault(beta, { initGitOnCreate: false, home, dataRoot })
  assert.equal(againAlpha.registryUpdated, false)
  assert.equal(againBeta.registryUpdated, false)
  assert.deepEqual(await snapshot(vault), before)
})

test('an existing row is verified, never rewritten, and a conflicting directory stops the write', async (t) => {
  const { vault, repo, home, dataRoot } = await fixture(t)
  const alpha = await bind({ vault, repo, home })
  await bootstrapVault(alpha, { initGitOnCreate: false, home, dataRoot })
  const before = await snapshot(vault)

  // the same id pointing at a different directory is a conflict, not an update
  const moved = handBinding(vault, {
    projectId: ID1,
    slug: 'alpha',
    displayName: 'Alpha',
    relativeDir: `${PROJECTS_DIR}/alpha-renamed--${ID1.slice(0, 8)}`,
  })
  await assert.rejects(bootstrapVault(moved, { initGitOnCreate: false, home, dataRoot }), { code: 'registry-id-conflict' })

  // a directory already owned by another id is a conflict even when the id8 matches
  const twin = handBinding(vault, {
    projectId: ID1_TWIN,
    slug: 'alpha',
    displayName: 'Twin',
    relativeDir: `${PROJECTS_DIR}/alpha--${ID1.slice(0, 8)}`,
  })
  await assert.rejects(bootstrapVault(twin, { initGitOnCreate: false, home, dataRoot }), { code: 'registry-directory-taken' })

  assert.deepEqual(await snapshot(vault), before)
})

test('a registry file without a generated region gains one and keeps every existing byte', async (t) => {
  const { vault, repo, home, dataRoot } = await fixture(t)
  const binding = await bind({ vault, repo, home })
  const original = '# 我的注册表\n\n这是我自己写下的说明，插件必须原样保留。\n'
  await mkdir(join(vault, '_meta'), { recursive: true })
  await writeFile(join(vault, REGISTRY_RELATIVE_PATH), original)

  const result = await bootstrapVault(binding, { initGitOnCreate: false, home, dataRoot })
  const text = await registryText(vault)

  assert.equal(result.registryUpdated, true)
  assert.equal(text.startsWith(original), true)
  assert.equal(registryRegion(text).declaredHash, sha256(registryRegion(text).body))
  const { rows } = parseRegistryMarkdown(text)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].projectId, ID1)
})

test('an invalid binding is refused before anything is written', async (t) => {
  const { vault, home, dataRoot } = await fixture(t)
  const cases = [
    [null, 'binding-invalid'],
    [{ kind: 'conflict', reason: 'nope' }, 'binding-invalid'],
    [handBinding(vault, { projectId: 'not-a-uuid' }), 'binding-invalid'],
    [handBinding(vault, { slug: 'Not A Slug' }), 'binding-invalid'],
    [{ ...handBinding(vault), displayName: 'bad\u0000name' }, 'binding-invalid'],
    [{ ...handBinding(vault), relativeDir: `${PROJECTS_DIR}/alpha--deadbeef` }, 'binding-invalid'],
    [{ ...handBinding(vault), relativeDir: `Methods/alpha--${ID1.slice(0, 8)}` }, 'binding-invalid'],
    [{ ...handBinding(vault), vaultRoot: '' }, 'binding-invalid'],
  ]
  for (const [binding, code] of cases) {
    await assert.rejects(
      bootstrapVault(binding, { initGitOnCreate: false, home, dataRoot }),
      (error) => error instanceof BootstrapError && error.code === code,
      `expected ${JSON.stringify(binding)} to be refused with ${code}`,
    )
  }
  await assert.rejects(lstat(vault), { code: 'ENOENT' })
})
