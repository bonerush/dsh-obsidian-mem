// Task 4: safe vault paths and stable project binding.
//
// Every case below runs against REAL temporary filesystems, real `git`
// worktrees and real symlinks — never an fs mock — because the boundary under
// test is exactly what `lstat`, `realpath` and `open(…, 'wx')` do on this
// machine. Fixtures are built from `mkdtemp`; nothing here reads or writes the
// user's real `~/.dsh`, documents or cloud folders. The single case that must
// prove the iCloud refusal injects its own temporary HOME instead of touching
// the real `~/Library`.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, isAbsolute, join, resolve, sep } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'

import * as gitModule from '../lib/git.js'
import { isCloudManagedVaultRoot, resolveDataRoot, resolveVaultFile, resolveVaultRoot } from '../lib/paths.js'
import * as pointerModule from '../lib/pointer.js'
import * as registryModule from '../lib/registry.js'
import * as vaultModule from '../lib/vault.js'
import { POINTER_FILENAME, PROJECTS_DIR, resolveBinding } from '../lib/vault.js'

const execFileAsync = promisify(execFile)

/** Fixed identities. Both are valid UUIDv4 values (version nibble `4`). */
const ID1 = '1c392abb-7b08-42f7-871d-2a379caf9448'
const ID2 = '5f0e6d1c-9a4b-4c2d-8e3f-0b7a6c5d4e3f'

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/**
 * A hermetic git environment: no user or system config, and no inherited
 * `GIT_DIR`-family variables that could redirect a read at another repository.
 * The production code strips the same variables, so tests and plugin agree.
 */
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
      '-c', 'user.name=Task Four',
      '-c', 'user.email=t4@example.invalid',
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
  return realpath(dir)
}

/** Register a linked worktree (its `.git` is a FILE) and return its real path. */
async function addWorktree(repoDir, target) {
  await git(repoDir, ['worktree', 'add', '--detach', '-q', target, 'HEAD'])
  return realpath(target)
}

/** One throwaway fixture root holding `vault/`, and free names for repo/scratch. */
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'obsidian-mem-t4-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 4 }))
  const vault = join(root, 'vault')
  await mkdir(vault, { recursive: true })
  return {
    root,
    vault,
    vaultReal: await realpath(vault),
    repo: join(root, 'repo'),
    scratch: join(root, 'scratch'),
  }
}

function pointerFor(projectId, overrides = {}) {
  return { projectId, slug: 'demo', displayName: 'demo', schema: 1, ...overrides }
}

async function writePointer(dir, pointer) {
  const path = join(dir, POINTER_FILENAME)
  await writeFile(path, `${JSON.stringify(pointer, null, 2)}\n`)
  return path
}

async function readPointerOf(dir) {
  return JSON.parse(await readFile(join(dir, POINTER_FILENAME), 'utf8'))
}

/**
 * The registry document body in the shape Task 5 owns: the plugin-managed
 * region with the fixed four columns, hub cells as vault-relative wikilinks
 * (`link: false` writes a plain relative path instead). The alias separator `|`
 * inside the cell is escaped as `\|`, exactly as spec §5.2 requires of any `|`
 * in a cell. The generator hash is a placeholder: this stage only reads the
 * region, it never verifies or writes it.
 */
function registryMarkdown(rows, { link = true } = {}) {
  const hubCell = (hub) => (link ? `[[${hub}/index\\|${basename(hub)}]]` : hub)
  return [
    '<!-- obsidian-mem:registry begin sha256:0000000000000000000000000000000000000000000000000000000000000000 -->',
    '| projectId | hub 相对路径 | displayName | remote |',
    '| --- | --- | --- | --- |',
    ...rows.map((row) => `| ${row.projectId} | ${hubCell(row.hub)} | ${row.displayName ?? basename(row.hub)} | ${row.remote ?? ''} |`),
    '<!-- obsidian-mem:registry end -->',
    '',
  ].join('\n')
}

async function writeRegistry(vault, rows, options) {
  const meta = join(vault, '_meta')
  await mkdir(meta, { recursive: true })
  await writeFile(join(meta, '项目注册表.md'), registryMarkdown(rows, options))
}

/** Create the project directory a registry row promises, with stable content. */
async function writeProjectDir(vault, hub) {
  await mkdir(join(vault, hub), { recursive: true })
  await writeFile(join(vault, hub, 'index.md'), `# ${basename(hub)}\n`)
}

/** Run `body` with `$GIT_DIR` poisoned, restoring the environment afterwards. */
async function withGitDir(value, body) {
  const previous = process.env.GIT_DIR
  process.env.GIT_DIR = value
  try {
    return await body()
  } finally {
    if (previous === undefined) delete process.env.GIT_DIR
    else process.env.GIT_DIR = previous
  }
}

// ---------------------------------------------------------------------------
// resolveVaultFile — the path jail
// ---------------------------------------------------------------------------

test('resolveVaultFile returns an absolute path inside the vault for a nested relative path', async (t) => {
  const { vault, vaultReal } = await fixture(t)
  await mkdir(join(vault, PROJECTS_DIR, 'demo'), { recursive: true })
  const file = await resolveVaultFile(vault, `${PROJECTS_DIR}/demo/note.md`)
  assert.equal(file, join(vaultReal, PROJECTS_DIR, 'demo', 'note.md'))
  assert.equal(isAbsolute(file), true)
})

test('resolveVaultFile keeps Unicode path segments intact', async (t) => {
  const { vault, vaultReal } = await fixture(t)
  const file = await resolveVaultFile(vault, `${PROJECTS_DIR}/演示--1c392abb/决策/第一个决定.md`)
  assert.equal(file, join(vaultReal, PROJECTS_DIR, '演示--1c392abb', '决策', '第一个决定.md'))
})

test('resolveVaultFile rejects a path that is blank, non-string or empty after normalization', async (t) => {
  const { vault } = await fixture(t)
  for (const bad of ['', '   ', './', '.', '///', null, undefined, 42, {}, []]) {
    await assert.rejects(resolveVaultFile(vault, bad), /path/i, `expected ${JSON.stringify(bad)} to be rejected`)
  }
})

test('resolveVaultFile rejects absolute paths, even inside the vault', async (t) => {
  const { vault, vaultReal } = await fixture(t)
  await assert.rejects(resolveVaultFile(vault, '/etc/passwd'), /path/i)
  await assert.rejects(resolveVaultFile(vault, join(vaultReal, 'inside.md')), /path/i)
  await assert.rejects(resolveVaultFile(vault, join(vault, 'inside.md')), /path/i)
})

test('resolveVaultFile rejects .. traversal at every depth', async (t) => {
  const { root, vault } = await fixture(t)
  await writeFile(join(root, 'outside.md'), 'outside\n')
  for (const bad of ['..', '../outside.md', 'a/../outside.md', 'a/../../outside.md', `${PROJECTS_DIR}/../../outside.md`, 'a/b/../../../outside.md']) {
    await assert.rejects(resolveVaultFile(vault, bad), /path/i, `expected ${bad} to be rejected`)
  }
  await assert.rejects(resolveVaultFile(vault, '../outside.md', { mustExist: true }), /path/i)
})

test('resolveVaultFile refuses a symlink at any segment, even one pointing back inside', async (t) => {
  const { root, vault } = await fixture(t)
  const outside = join(root, 'outside')
  await mkdir(outside, { recursive: true })
  await writeFile(join(outside, 'secret.md'), 'secret\n')

  await symlink(outside, join(vault, 'escape'))
  await assert.rejects(resolveVaultFile(vault, 'escape/secret.md'), /path/i)
  await assert.rejects(resolveVaultFile(vault, 'escape/secret.md', { mustExist: true }), /path/i)
  await assert.rejects(resolveVaultFile(vault, 'escape/new.md'), /path/i)

  // a symlinked leaf is refused whether or not it currently resolves
  await symlink('escape/secret.md', join(vault, 'leaf.md'))
  await assert.rejects(resolveVaultFile(vault, 'leaf.md'), /path/i)
  await assert.rejects(resolveVaultFile(vault, 'leaf.md', { mustExist: true }), /path/i)

  // pointing back inside the vault does not make a symlink acceptable
  await mkdir(join(vault, 'real'), { recursive: true })
  await symlink(join(vault, 'real'), join(vault, 'inside-link'))
  await assert.rejects(resolveVaultFile(vault, 'inside-link/x.md'), /path/i)
})

test('resolveVaultFile honours mustExist and never reports a read failure as a missing file', async (t) => {
  const { vault, vaultReal } = await fixture(t)

  const missing = await resolveVaultFile(vault, 'missing.md')
  assert.equal(missing, join(vaultReal, 'missing.md'))
  await assert.rejects(resolveVaultFile(vault, 'missing.md', { mustExist: true }), /exist/i)

  await writeFile(join(vault, 'present.md'), 'x\n')
  assert.equal(await resolveVaultFile(vault, 'present.md', { mustExist: true }), join(vaultReal, 'present.md'))

  // An unreadable directory is a read failure, not an absence: the caller must
  // be able to pause instead of creating a file over a hidden one.
  await mkdir(join(vault, 'locked'), { recursive: true })
  await chmod(join(vault, 'locked'), 0o000)
  try {
    await assert.rejects(resolveVaultFile(vault, 'locked/x.md'), (error) => {
      assert.equal(error.code, 'EACCES')
      return true
    })
  } finally {
    await chmod(join(vault, 'locked'), 0o755)
  }
})

// ---------------------------------------------------------------------------
// resolveVaultRoot / resolveDataRoot / cloud location
// ---------------------------------------------------------------------------

test('resolveVaultRoot expands ~, realpaths what exists and normalizes what does not', async (t) => {
  const { root } = await fixture(t)
  const home = join(root, 'home')
  await mkdir(home, { recursive: true })
  const homeReal = await realpath(home)
  const vault = join(root, 'vault')
  await mkdir(vault, { recursive: true })

  const existing = await resolveVaultRoot(vault, { home })
  assert.equal(existing.root, await realpath(vault))
  assert.equal(existing.exists, true)

  const missing = await resolveVaultRoot(join(root, 'not-yet'), { home })
  assert.equal(missing.root, join(await realpath(root), 'not-yet'))
  assert.equal(missing.exists, false)

  const expanded = await resolveVaultRoot('~/vault', { home })
  assert.equal(expanded.root, join(homeReal, 'vault'))
  assert.equal(expanded.exists, false)

  for (const bad of ['', '   ', 'relative/vault', './vault', null, 42]) {
    await assert.rejects(resolveVaultRoot(bad, { home }), /vaultRoot/i)
  }
})

test('resolveDataRoot lands inside DSH_HOME and defaults to <home>/.dsh/data/obsidian-mem', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'obsidian-mem-home-'))
  t.after(() => rm(home, { recursive: true, force: true }))

  const explicit = resolveDataRoot(home)
  assert.equal(explicit, resolve(home, 'data', 'obsidian-mem'))
  assert.equal(explicit.startsWith(resolve(home) + sep), true)

  const previous = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = home
    assert.equal(resolveDataRoot(), resolve(home, 'data', 'obsidian-mem'))
    delete process.env.DSH_HOME
    assert.equal(resolveDataRoot(), join(homedir(), '.dsh', 'data', 'obsidian-mem'))
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('resolveDataRoot rejects a blank or relative DSH_HOME instead of writing to the cwd', () => {
  for (const bad of ['', '   ', '.dsh', 'relative/data', null, 42, {}]) {
    assert.throws(() => resolveDataRoot(bad), /dshHome/i, `expected ${JSON.stringify(bad)} to be rejected`)
  }
})

test('isCloudManagedVaultRoot claims only the two known macOS sync roots', async (t) => {
  const { root } = await fixture(t)
  const home = join(root, 'home')
  const icloud = join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'dsh-memory')
  const cloudStorage = join(home, 'Library', 'CloudStorage', 'Dropbox', 'dsh-memory')
  const documents = join(home, 'Documents', 'dsh-memory')
  const library = join(home, 'Library')
  for (const dir of [icloud, cloudStorage, documents, library]) await mkdir(dir, { recursive: true })

  assert.equal(await isCloudManagedVaultRoot(await realpath(icloud), { home }), true)
  assert.equal(await isCloudManagedVaultRoot(await realpath(cloudStorage), { home }), true)
  // `~/Documents` and `~/Library` may or may not be managed by a provider on a
  // given machine, so the path name alone must never be treated as proof.
  assert.equal(await isCloudManagedVaultRoot(await realpath(documents), { home }), false)
  assert.equal(await isCloudManagedVaultRoot(await realpath(library), { home }), false)
  assert.equal(await isCloudManagedVaultRoot(await realpath(home), { home }), false)
})

test('resolveBinding refuses automatic writes for a vault under an on-demand cloud root', async (t) => {
  const { root, repo } = await fixture(t)
  await initRepo(repo)
  const home = join(root, 'home')
  const vault = join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'dsh-memory')
  await mkdir(vault, { recursive: true })

  const refused = await resolveBinding({ cwd: repo, vaultRoot: vault, home })
  assert.equal(refused.kind, 'conflict')
  assert.equal(refused.reason, 'vault-cloud-managed')
  assert.match(refused.message, /local directory/i)
  // refusing means refusing: no pointer appears in the repository either
  await assert.rejects(readFile(join(repo, POINTER_FILENAME)), { code: 'ENOENT' })
})

// ---------------------------------------------------------------------------
// resolveBinding — stable project identity
// ---------------------------------------------------------------------------

test('a plain git repository is bound through one exclusive four-field pointer', async (t) => {
  const { vault, vaultReal, repo } = await fixture(t)
  const repoReal = await initRepo(repo)

  const binding = await resolveBinding({ cwd: repo, vaultRoot: vault })
  assert.equal(binding.kind, 'bound')
  assert.match(binding.projectId, UUID_V4)
  assert.equal(binding.slug, basename(repo))
  assert.equal(binding.schema, 1)
  assert.equal(binding.pointerCreated, true)
  assert.equal(binding.pointerInherited, false)
  assert.equal(binding.registered, false)
  assert.equal(binding.repoRoot, repoReal)
  assert.equal(binding.vaultRoot, vaultReal)
  assert.equal(binding.vaultExists, true)
  assert.equal(binding.pointerPath, join(repoReal, POINTER_FILENAME))
  assert.equal(binding.relativeDir, `${PROJECTS_DIR}/${basename(repo)}--${binding.projectId.slice(0, 8)}`)
  assert.equal(binding.projectDir, join(vaultReal, binding.relativeDir))

  // the pointer is a small regular file with exactly four fields (spec §5.2/D3)
  const pointerPath = join(repo, POINTER_FILENAME)
  assert.equal((await lstat(pointerPath)).isFile(), true)
  const raw = await readFile(pointerPath, 'utf8')
  const pointer = JSON.parse(raw)
  assert.deepEqual(Object.keys(pointer).sort(), ['displayName', 'projectId', 'schema', 'slug'])
  assert.equal(pointer.projectId, binding.projectId)
  assert.equal(pointer.schema, 1)
  assert.equal(pointer.version, undefined)
  for (const value of Object.values(pointer)) assert.equal(isAbsolute(String(value)), false)
  for (const forbidden of [vaultReal, vault, repoReal, repo, 'vaultPath', 'remote', 'git@']) {
    assert.equal(raw.includes(forbidden), false, `pointer must not contain ${forbidden}`)
  }

  // the pointer is the only thing this stage writes; the vault stays untouched
  assert.deepEqual(await readdir(vault), [])
})

test('re-resolving an existing pointer reuses the id and leaves its bytes untouched', async (t) => {
  const { vault, repo } = await fixture(t)
  await initRepo(repo)

  const first = await resolveBinding({ cwd: repo, vaultRoot: vault })
  const before = await readFile(join(repo, POINTER_FILENAME))
  const second = await resolveBinding({ cwd: repo, vaultRoot: vault })

  assert.equal(second.projectId, first.projectId)
  assert.equal(second.pointerCreated, false)
  assert.equal(second.relativeDir, first.relativeDir)
  assert.deepEqual(await readFile(join(repo, POINTER_FILENAME)), before)
})

test('only the repository root pointer is project identity', async (t) => {
  const { vault, repo } = await fixture(t)
  const repoReal = await initRepo(repo)
  const nested = join(repo, 'sub', 'deeper')
  await mkdir(nested, { recursive: true })
  await writePointer(nested, pointerFor(ID2, { slug: 'nested', displayName: 'Nested' }))

  const binding = await resolveBinding({ cwd: nested, vaultRoot: vault })
  assert.equal(binding.kind, 'bound')
  assert.notEqual(binding.projectId, ID2)
  assert.equal(binding.repoRoot, repoReal)
  assert.equal(binding.pointerPath, join(repoReal, POINTER_FILENAME))
  assert.equal((await readPointerOf(nested)).projectId, ID2)
})

test('a linked worktree with a .git file inherits the unique valid sibling pointer', async (t) => {
  const { root, vault, repo } = await fixture(t)
  await initRepo(repo)

  const main = await resolveBinding({ cwd: repo, vaultRoot: vault })
  const mainBytes = await readFile(join(repo, POINTER_FILENAME))

  const worktree = await addWorktree(repo, join(root, 'worktree-old-branch'))
  assert.equal((await lstat(join(worktree, '.git'))).isFile(), true)
  await assert.rejects(readFile(join(worktree, POINTER_FILENAME)), { code: 'ENOENT' })

  const inherited = await resolveBinding({ cwd: worktree, vaultRoot: vault })
  assert.equal(inherited.kind, 'bound')
  assert.equal(inherited.projectId, main.projectId)
  assert.equal(inherited.slug, main.slug)
  assert.equal(inherited.pointerCreated, true)
  assert.equal(inherited.pointerInherited, true)
  assert.deepEqual(await readFile(join(worktree, POINTER_FILENAME)), mainBytes)
})

test('sibling worktrees with different ids stop resolution and never guess a new id', async (t) => {
  const { root, vault, repo } = await fixture(t)
  await initRepo(repo)
  const siblingA = await addWorktree(repo, join(root, 'wt-alpha'))
  const siblingB = await addWorktree(repo, join(root, 'wt-beta'))
  await writePointer(repo, pointerFor(ID1, { slug: 'alpha', displayName: 'Alpha' }))
  await writePointer(siblingA, pointerFor(ID2, { slug: 'beta', displayName: 'Beta' }))

  const conflict = await resolveBinding({ cwd: siblingB, vaultRoot: vault })
  assert.equal(conflict.kind, 'conflict')
  assert.equal(conflict.reason, 'sibling-disagreement')
  await assert.rejects(readFile(join(siblingB, POINTER_FILENAME)), { code: 'ENOENT' })
})

test('sibling worktrees sharing an id but not metadata stop resolution', async (t) => {
  const { root, vault, repo } = await fixture(t)
  await initRepo(repo)
  const siblingA = await addWorktree(repo, join(root, 'wt-alpha'))
  const siblingB = await addWorktree(repo, join(root, 'wt-beta'))
  await writePointer(repo, pointerFor(ID1, { slug: 'alpha', displayName: 'Alpha' }))
  await writePointer(siblingA, pointerFor(ID1, { slug: 'alpha-renamed', displayName: 'Alpha Renamed' }))

  const conflict = await resolveBinding({ cwd: siblingB, vaultRoot: vault })
  assert.equal(conflict.kind, 'conflict')
  assert.equal(conflict.reason, 'sibling-disagreement')
  await assert.rejects(readFile(join(siblingB, POINTER_FILENAME)), { code: 'ENOENT' })
})

test('an unreadable sibling worktree stops resolution instead of minting an id', async (t) => {
  const { root, vault, repo } = await fixture(t)
  await initRepo(repo)
  const doomed = await addWorktree(repo, join(root, 'wt-gone'))
  const live = await addWorktree(repo, join(root, 'wt-live'))
  await writePointer(repo, pointerFor(ID1, { slug: 'alpha', displayName: 'Alpha' }))

  // The worktree stays registered in the common git dir while its checkout is
  // gone, so its pointer cannot be read — and must not be guessed around.
  await rm(doomed, { recursive: true, force: true })
  const listing = await git(repo, ['worktree', 'list', '--porcelain'])
  assert.match(listing.stdout, /wt-gone/)

  const conflict = await resolveBinding({ cwd: live, vaultRoot: vault })
  assert.equal(conflict.kind, 'conflict')
  assert.equal(conflict.reason, 'sibling-unreadable')
  await assert.rejects(readFile(join(live, POINTER_FILENAME)), { code: 'ENOENT' })
})

test('sibling discovery ignores an inherited GIT_DIR', async (t) => {
  const { vault, repo } = await fixture(t)
  await initRepo(repo)

  const binding = await withGitDir(join(vault, 'not-a-repository'), () =>
    resolveBinding({ cwd: repo, vaultRoot: vault }))
  assert.equal(binding.kind, 'bound')
  assert.equal(binding.pointerCreated, true)
  assert.match(binding.projectId, UUID_V4)
})

test('a corrupt sibling pointer stops resolution instead of guessing', async (t) => {
  const { root, vault, repo } = await fixture(t)
  await initRepo(repo)
  const sibling = await addWorktree(repo, join(root, 'wt-corrupt'))
  const fresh = await addWorktree(repo, join(root, 'wt-fresh'))
  await writeFile(join(sibling, POINTER_FILENAME), '{ not a pointer')

  const conflict = await resolveBinding({ cwd: fresh, vaultRoot: vault })
  assert.equal(conflict.kind, 'conflict')
  assert.equal(conflict.reason, 'sibling-unreadable')
  assert.equal(conflict.details.some((entry) => entry.reason === 'pointer-corrupt'), true)
  await assert.rejects(readFile(join(fresh, POINTER_FILENAME)), { code: 'ENOENT' })
})

const CORRUPT_POINTERS = [
  ['invalid JSON', '{ this is not json'],
  ['a missing field', JSON.stringify({ projectId: ID1, slug: 'demo', schema: 1 })],
  ['an extra machine-local field', JSON.stringify({ ...pointerFor(ID1), vaultPath: '/Users/someone/Documents/dsh-memory' })],
  ['a remote field', JSON.stringify({ ...pointerFor(ID1), remote: 'git@github.com:someone/private.git' })],
  ['a non-v4 uuid', JSON.stringify(pointerFor('1c392abb-7b08-32f7-871d-2a379caf9448'))],
  ['an uppercase uuid', JSON.stringify(pointerFor(ID1.toUpperCase()))],
  ['a slug with a path separator', JSON.stringify(pointerFor(ID1, { slug: '../escape' }))],
  ['a blank displayName', JSON.stringify(pointerFor(ID1, { displayName: '   ' }))],
  ['a JSON array', '[]'],
  ['a bare JSON string', '"nope"'],
  ['a JSON null', 'null'],
]

for (const [label, raw] of CORRUPT_POINTERS) {
  test(`a pointer with ${label} stops resolution and is never repaired`, async (t) => {
    const { vault, repo } = await fixture(t)
    await initRepo(repo)
    const path = join(repo, POINTER_FILENAME)
    await writeFile(path, raw)
    const before = await readFile(path)

    const conflict = await resolveBinding({ cwd: repo, vaultRoot: vault })
    assert.equal(conflict.kind, 'conflict')
    assert.equal(conflict.reason, 'pointer-corrupt')
    assert.deepEqual(await readFile(path), before)
  })
}

test('a pointer with an unknown schema stops resolution and is never rewritten', async (t) => {
  const { vault, repo } = await fixture(t)
  await initRepo(repo)
  const path = await writePointer(repo, pointerFor(ID1, { schema: 2 }))
  const before = await readFile(path)

  const conflict = await resolveBinding({ cwd: repo, vaultRoot: vault })
  assert.equal(conflict.kind, 'conflict')
  assert.equal(conflict.reason, 'pointer-unsupported-schema')
  assert.deepEqual(await readFile(path), before)
})

test('an oversized pointer stops resolution', async (t) => {
  const { vault, repo } = await fixture(t)
  await initRepo(repo)
  await writePointer(repo, { ...pointerFor(ID1), padding: 'x'.repeat(8192) })

  const conflict = await resolveBinding({ cwd: repo, vaultRoot: vault })
  assert.equal(conflict.kind, 'conflict')
  assert.equal(conflict.reason, 'pointer-oversize')
})

test('a pointer that is not a regular file stops resolution', async (t) => {
  const { root, vault, repo } = await fixture(t)
  await initRepo(repo)
  await symlink(join(root, 'elsewhere.json'), join(repo, POINTER_FILENAME))
  const symlinked = await resolveBinding({ cwd: repo, vaultRoot: vault })
  assert.equal(symlinked.kind, 'conflict')
  assert.equal(symlinked.reason, 'pointer-not-a-file')

  await rm(join(repo, POINTER_FILENAME))
  await mkdir(join(repo, POINTER_FILENAME))
  const directory = await resolveBinding({ cwd: repo, vaultRoot: vault })
  assert.equal(directory.kind, 'conflict')
  assert.equal(directory.reason, 'pointer-not-a-file')
})

test('an unreadable pointer stops resolution and is left untouched', async (t) => {
  const { vault, repo } = await fixture(t)
  await initRepo(repo)
  const path = await writePointer(repo, pointerFor(ID1))
  const before = await readFile(path)

  await chmod(path, 0o000)
  try {
    const conflict = await resolveBinding({ cwd: repo, vaultRoot: vault })
    assert.equal(conflict.kind, 'conflict')
    assert.equal(conflict.reason, 'pointer-unreadable')
  } finally {
    await chmod(path, 0o644)
  }
  assert.deepEqual(await readFile(path), before)
})

test('a non-git directory stays unbound and read-only', async (t) => {
  const { vault, scratch } = await fixture(t)
  await mkdir(scratch, { recursive: true })

  const unbound = await resolveBinding({ cwd: scratch, vaultRoot: vault })
  assert.equal(unbound.kind, 'unbound')
  assert.equal(unbound.reason, 'no-git-root')
  await assert.rejects(readFile(join(scratch, POINTER_FILENAME)), { code: 'ENOENT' })
  assert.deepEqual(await readdir(vault), [])

  // A scratch directory is never silently adopted: only the explicit local bind
  // creates a pointer, and it leaves the vault untouched (Task 17).
  const local = await resolveBinding({ cwd: scratch, vaultRoot: vault, mode: 'local' })
  assert.equal(local.kind, 'bound')
  assert.equal(local.pointerCreated, true)
  const pointer = JSON.parse(await readFile(join(scratch, POINTER_FILENAME), 'utf8'))
  assert.deepEqual(Object.keys(pointer).sort(), ['displayName', 'projectId', 'schema', 'slug'])
  assert.equal(pointer.projectId, local.projectId)
  assert.equal(local.registered, false)
  assert.deepEqual(await readdir(vault), [])
})

test('a working directory inside the vault resolves to the vault context', async (t) => {
  const { vault, vaultReal } = await fixture(t)
  const inner = join(vault, PROJECTS_DIR, 'x')
  await mkdir(inner, { recursive: true })

  const atRoot = await resolveBinding({ cwd: vault, vaultRoot: vault })
  assert.equal(atRoot.kind, 'vault')
  assert.equal(atRoot.vaultRoot, vaultReal)

  const inside = await resolveBinding({ cwd: inner, vaultRoot: vault })
  assert.equal(inside.kind, 'vault')

  // the vault's own .git must never be treated as an ordinary project
  await initRepo(vault)
  const managed = await resolveBinding({ cwd: inner, vaultRoot: vault })
  assert.equal(managed.kind, 'vault')
  assert.equal(managed.vaultRoot, vaultReal)
  await assert.rejects(readFile(join(vault, POINTER_FILENAME)), { code: 'ENOENT' })
})

test('binding works before the vault root exists and creates nothing inside it', async (t) => {
  const { root, repo } = await fixture(t)
  await initRepo(repo)
  const vaultRoot = join(root, 'brand-new-vault')

  const binding = await resolveBinding({ cwd: repo, vaultRoot })
  assert.equal(binding.kind, 'bound')
  assert.equal(binding.vaultExists, false)
  assert.equal(binding.projectDir, join(await realpath(root), 'brand-new-vault', binding.relativeDir))
  await assert.rejects(lstat(vaultRoot), { code: 'ENOENT' })
})

test('mode show resolves the current state without creating or repairing anything', async (t) => {
  const { vault, repo } = await fixture(t)
  await initRepo(repo)

  const unbound = await resolveBinding({ cwd: repo, vaultRoot: vault, mode: 'show' })
  assert.equal(unbound.kind, 'unbound')
  assert.equal(unbound.reason, 'no-pointer')
  await assert.rejects(readFile(join(repo, POINTER_FILENAME)), { code: 'ENOENT' })

  await writePointer(repo, pointerFor(ID1, { slug: 'alpha', displayName: 'Alpha' }))
  const shown = await resolveBinding({ cwd: repo, vaultRoot: vault, mode: 'show' })
  assert.equal(shown.kind, 'bound')
  assert.equal(shown.projectId, ID1)
  assert.equal(shown.pointerCreated, false)
})

test('identity modes require an existing pointer, and unknown modes are rejected', async (t) => {
  const { vault, repo } = await fixture(t)
  await initRepo(repo)

  // There is nothing to fork away from and nothing to confirm yet.
  for (const mode of ['fork', 'retain']) {
    const refused = await resolveBinding({ cwd: repo, vaultRoot: vault, mode, dataRoot: join(vault, '..', 'data') })
    assert.equal(refused.kind, 'conflict')
    assert.equal(refused.reason, 'no-pointer')
  }
  // `local` is the explicit bind and is the one mode that creates the pointer.
  const local = await resolveBinding({ cwd: repo, vaultRoot: vault, mode: 'local' })
  assert.equal(local.kind, 'bound')
  assert.equal(local.pointerCreated, true)
  assert.equal(JSON.parse(await readFile(join(repo, POINTER_FILENAME), 'utf8')).projectId, local.projectId)

  for (const mode of ['nonsense', '', 42, {}]) {
    await assert.rejects(resolveBinding({ cwd: repo, vaultRoot: vault, mode }), /mode/i)
  }
})

// ---------------------------------------------------------------------------
// resolveBinding — vault registry consistency
// ---------------------------------------------------------------------------

test('a registry row selects the recorded hub path, so a rename never moves content', async (t) => {
  const { vault, vaultReal, repo } = await fixture(t)
  await initRepo(repo)
  const hub = `${PROJECTS_DIR}/old-name--${ID1.slice(0, 8)}`
  await writeProjectDir(vault, hub)
  const content = await readFile(join(vault, hub, 'index.md'))
  await writePointer(repo, pointerFor(ID1, { slug: 'new-name', displayName: 'New Name' }))
  await writeRegistry(vault, [{ projectId: ID1, hub, displayName: 'New Name' }])

  const binding = await resolveBinding({ cwd: repo, vaultRoot: vault })
  assert.equal(binding.kind, 'bound')
  assert.equal(binding.projectId, ID1)
  assert.equal(binding.slug, 'new-name')
  assert.equal(binding.registered, true)
  assert.equal(binding.relativeDir, hub)
  assert.equal(binding.projectDir, join(vaultReal, hub))
  assert.equal(binding.pointerCreated, false)

  assert.deepEqual(await readFile(join(vault, hub, 'index.md')), content)
  assert.deepEqual(await readdir(join(vault, PROJECTS_DIR)), [basename(hub)])
})

test('the registry accepts a plain relative hub cell as well as a wikilink', async (t) => {
  const { vault, repo } = await fixture(t)
  await initRepo(repo)
  const hub = `${PROJECTS_DIR}/alpha--${ID1.slice(0, 8)}`
  await writeProjectDir(vault, hub)
  await writePointer(repo, pointerFor(ID1, { slug: 'alpha', displayName: 'Alpha' }))
  await writeRegistry(vault, [{ projectId: ID1, hub }], { link: false })

  const binding = await resolveBinding({ cwd: repo, vaultRoot: vault })
  assert.equal(binding.kind, 'bound')
  assert.equal(binding.relativeDir, hub)
  assert.equal(binding.registered, true)
})

test('two different project ids pointing at one directory fail', async (t) => {
  const { vault, repo } = await fixture(t)
  await initRepo(repo)
  await writePointer(repo, pointerFor(ID1, { slug: 'alpha', displayName: 'Alpha' }))
  const hub = `${PROJECTS_DIR}/alpha--${ID1.slice(0, 8)}`
  await writeProjectDir(vault, hub)
  await writeRegistry(vault, [{ projectId: ID1, hub }, { projectId: ID2, hub }])

  const conflict = await resolveBinding({ cwd: repo, vaultRoot: vault })
  assert.equal(conflict.kind, 'conflict')
  assert.equal(conflict.reason, 'registry-duplicate-directory')
})

test('one project id registered against two directories fails', async (t) => {
  const { vault, repo } = await fixture(t)
  await initRepo(repo)
  await writePointer(repo, pointerFor(ID1, { slug: 'alpha', displayName: 'Alpha' }))
  const first = `${PROJECTS_DIR}/alpha--${ID1.slice(0, 8)}`
  const second = `${PROJECTS_DIR}/beta--${ID1.slice(0, 8)}`
  await writeProjectDir(vault, first)
  await writeProjectDir(vault, second)
  await writeRegistry(vault, [{ projectId: ID1, hub: first }, { projectId: ID1, hub: second }])

  const conflict = await resolveBinding({ cwd: repo, vaultRoot: vault })
  assert.equal(conflict.kind, 'conflict')
  assert.equal(conflict.reason, 'registry-duplicate-id')
})

test('an unreadable registry pauses binding instead of being treated as empty', async (t) => {
  const { vault, repo } = await fixture(t)
  await initRepo(repo)
  await writePointer(repo, pointerFor(ID1, { slug: 'alpha', displayName: 'Alpha' }))
  await writeRegistry(vault, [{ projectId: ID1, hub: `${PROJECTS_DIR}/alpha--${ID1.slice(0, 8)}` }])
  const registryPath = join(vault, '_meta', '项目注册表.md')

  await chmod(registryPath, 0o000)
  try {
    const conflict = await resolveBinding({ cwd: repo, vaultRoot: vault })
    assert.equal(conflict.kind, 'conflict')
    assert.equal(conflict.reason, 'registry-unreadable')
  } finally {
    await chmod(registryPath, 0o644)
  }
})

test('a symlinked registry path is refused instead of read from outside the vault', async (t) => {
  const { root, vault, repo } = await fixture(t)
  await initRepo(repo)
  await writePointer(repo, pointerFor(ID1, { slug: 'alpha', displayName: 'Alpha' }))
  const hub = `${PROJECTS_DIR}/alpha--${ID1.slice(0, 8)}`
  // A perfectly valid registry living outside the vault: it must never be read.
  const outside = join(root, 'outside-meta')
  await mkdir(outside, { recursive: true })
  await writeFile(join(outside, '项目注册表.md'), registryMarkdown([{ projectId: ID1, hub }]))

  // 1. a symlinked `_meta` directory
  await symlink(outside, join(vault, '_meta'))
  const symlinkedDirectory = await resolveBinding({ cwd: repo, vaultRoot: vault })
  assert.equal(symlinkedDirectory.kind, 'conflict')
  assert.equal(symlinkedDirectory.reason, 'registry-symlink')

  // 2. a symlinked registry file inside a real `_meta` directory
  await rm(join(vault, '_meta'))
  await mkdir(join(vault, '_meta'), { recursive: true })
  await symlink(join(outside, '项目注册表.md'), join(vault, '_meta', '项目注册表.md'))
  const symlinkedFile = await resolveBinding({ cwd: repo, vaultRoot: vault })
  assert.equal(symlinkedFile.kind, 'conflict')
  assert.equal(symlinkedFile.reason, 'registry-symlink')
})

const MALFORMED_REGISTRY_ROWS = [
  ['a hub whose id suffix is not its own project id', { projectId: ID1, hub: `${PROJECTS_DIR}/alpha--deadbeef` }],
  ['a non-uuid project id', { projectId: 'not-a-uuid', hub: `${PROJECTS_DIR}/alpha--${ID1.slice(0, 8)}` }],
  ['a traversal hub path', { projectId: ID1, hub: '../../etc' }],
  ['a hub path escaping through ..', { projectId: ID1, hub: `${PROJECTS_DIR}/alpha--${ID1.slice(0, 8)}/../../..` }],
  ['a hub path outside 项目/', { projectId: ID1, hub: `方法/alpha--${ID1.slice(0, 8)}` }],
]

for (const [label, row] of MALFORMED_REGISTRY_ROWS) {
  test(`a registry row with ${label} stops resolution`, async (t) => {
    const { vault, repo } = await fixture(t)
    await initRepo(repo)
    await writePointer(repo, pointerFor(ID1, { slug: 'alpha', displayName: 'Alpha' }))
    await writeRegistry(vault, [row])

    const conflict = await resolveBinding({ cwd: repo, vaultRoot: vault })
    assert.equal(conflict.kind, 'conflict')
    assert.equal(conflict.reason, 'registry-invalid')
  })
}

test('renaming the vault project directory stops with a conflict and never moves content', async (t) => {
  const { vault, repo } = await fixture(t)
  await initRepo(repo)
  await writePointer(repo, pointerFor(ID1, { slug: 'alpha', displayName: 'Alpha' }))
  const hub = `${PROJECTS_DIR}/alpha--${ID1.slice(0, 8)}`
  await writeProjectDir(vault, hub)
  await writeRegistry(vault, [{ projectId: ID1, hub }])

  const renamed = `${PROJECTS_DIR}/alpha-renamed--${ID1.slice(0, 8)}`
  await rename(join(vault, hub), join(vault, renamed))
  const content = await readFile(join(vault, renamed, 'index.md'))

  const conflict = await resolveBinding({ cwd: repo, vaultRoot: vault })
  assert.equal(conflict.kind, 'conflict')
  assert.equal(conflict.reason, 'registry-directory-missing')
  // the user's rename is respected: nothing moved back, nothing recreated
  assert.deepEqual(await readFile(join(vault, renamed, 'index.md')), content)
  assert.deepEqual(await readdir(join(vault, PROJECTS_DIR)), [basename(renamed)])
})

test('renaming the repository directory keeps the id and never moves vault content', async (t) => {
  const { root, vault, repo } = await fixture(t)
  await initRepo(repo)
  const first = await resolveBinding({ cwd: repo, vaultRoot: vault })
  await writeProjectDir(vault, first.relativeDir)
  const content = await readFile(join(vault, first.relativeDir, 'index.md'))

  const renamed = join(root, 'renamed-repository')
  await rename(repo, renamed)
  const second = await resolveBinding({ cwd: renamed, vaultRoot: vault })

  assert.equal(second.kind, 'bound')
  assert.equal(second.projectId, first.projectId)
  assert.equal(second.slug, first.slug)
  assert.equal(second.relativeDir, first.relativeDir)
  assert.deepEqual(await readFile(join(vault, first.relativeDir, 'index.md')), content)
  assert.deepEqual(await readdir(join(vault, PROJECTS_DIR)), [basename(first.relativeDir)])
})

test('a registry mapping the pointer id to a missing directory stops resolution', async (t) => {
  const { vault, repo } = await fixture(t)
  await initRepo(repo)
  await writePointer(repo, pointerFor(ID1, { slug: 'alpha', displayName: 'Alpha' }))
  const hub = `${PROJECTS_DIR}/alpha--${ID1.slice(0, 8)}`
  await writeRegistry(vault, [{ projectId: ID1, hub }])

  const conflict = await resolveBinding({ cwd: repo, vaultRoot: vault })
  assert.equal(conflict.kind, 'conflict')
  assert.equal(conflict.reason, 'registry-directory-missing')
  assert.deepEqual(await readdir(vault), ['_meta'])
})

test('a symlinked 项目 directory is refused instead of binding outside the vault', async (t) => {
  const { root, vault, repo } = await fixture(t)
  await initRepo(repo)
  await writePointer(repo, pointerFor(ID1, { slug: 'alpha', displayName: 'Alpha' }))
  const hub = `${PROJECTS_DIR}/alpha--${ID1.slice(0, 8)}`
  const outside = join(root, 'outside-projects')
  await mkdir(join(outside, basename(hub)), { recursive: true })
  await writeFile(join(outside, basename(hub), 'index.md'), 'outside\n')
  await writeRegistry(vault, [{ projectId: ID1, hub }])
  await symlink(outside, join(vault, PROJECTS_DIR))

  const conflict = await resolveBinding({ cwd: repo, vaultRoot: vault })
  assert.equal(conflict.kind, 'conflict')
  assert.equal(conflict.reason, 'project-directory-symlink')
})

test('a vault without a registry file binds through the derived fixed directory', async (t) => {
  const { vault, vaultReal, repo } = await fixture(t)
  await initRepo(repo)
  const binding = await resolveBinding({ cwd: repo, vaultRoot: vault })
  assert.equal(binding.kind, 'bound')
  assert.equal(binding.registered, false)
  assert.equal(binding.relativeDir, `${PROJECTS_DIR}/${binding.slug}--${binding.projectId.slice(0, 8)}`)
  assert.equal(binding.projectDir, join(vaultReal, binding.relativeDir))
})

// ---------------------------------------------------------------------------
// Concurrent first bind (two fresh sibling worktrees, one repository)
// ---------------------------------------------------------------------------

test('concurrent first binds in fresh worktrees never leave two project ids', async (t) => {
  // A genuine interleaving: both worktrees pass the inheritance scan before
  // either writes, so each would mint its own id. The regression this guards is
  // "one repository, two project ids, both reported as bound"; each round
  // re-runs the race with a fresh repository and vault.
  const rounds = 6
  for (let round = 0; round < rounds; round += 1) {
    const { root, vault, repo } = await fixture(t)
    await initRepo(repo)
    const worktrees = [
      await addWorktree(repo, join(root, 'wt-a')),
      await addWorktree(repo, join(root, 'wt-b')),
    ]

    const results = await Promise.all(
      worktrees.map((cwd) => resolveBinding({ cwd, vaultRoot: vault })),
    )

    const ids = new Set()
    for (let index = 0; index < worktrees.length; index += 1) {
      const pointer = await readPointerOf(worktrees[index]).catch(() => null)
      if (pointer !== null) ids.add(pointer.projectId)
      const result = results[index]
      if (result.kind === 'bound') {
        assert.equal(pointer?.projectId, result.projectId, 'a bound worktree must hold the id it reported')
      } else {
        assert.equal(result.kind, 'conflict')
        assert.equal(pointer, null, `a refused first bind must unwind its own pointer (${result.reason})`)
      }
    }
    assert.ok(ids.size <= 1, `round ${round} left ${ids.size} project ids for one repository`)
  }
})

// ---------------------------------------------------------------------------
// The R20 split: contracts moved, the public surface did not
// ---------------------------------------------------------------------------

test('lib/vault.js still re-exports the split contracts unchanged', () => {
  const fromPointer = [
    'POINTER_FILENAME', 'POINTER_SCHEMA', 'MAX_POINTER_BYTES', 'PointerError',
    'isUuidV4', 'isValidSlug', 'slugify', 'parsePointerBytes', 'readPointer',
    'createPointerExclusive', 'newPointer', 'samePointer',
  ]
  for (const name of fromPointer) {
    assert.equal(vaultModule[name], pointerModule[name], `vault.${name} must be pointer.${name}`)
  }
  const fromRegistry = [
    'PROJECTS_DIR', 'PROJECT_DIR_SEPARATOR', 'REGISTRY_RELATIVE_PATH', 'RegistryError',
    'projectRelativeDir', 'parseRegistryMarkdown', 'readRegistry',
  ]
  for (const name of fromRegistry) {
    assert.equal(vaultModule[name], registryModule[name], `vault.${name} must be registry.${name}`)
  }
  for (const name of ['findGitRoot', 'scanSiblingPointers']) {
    assert.equal(vaultModule[name], gitModule[name], `vault.${name} must be git.${name}`)
  }
  // the pre-split surface that always came from vault.js itself
  for (const name of ['resolveBinding', 'isCloudManagedVaultRoot', 'resolveVaultRoot', 'resolveVaultFile', 'splitRelativeVaultPath']) {
    assert.equal(typeof vaultModule[name], 'function', `vault.${name} must still be a function export`)
  }
  assert.ok(Array.isArray(vaultModule.BIND_MODES), 'vault.BIND_MODES must still be exported')
})