// Task 20b: first use binds — the write path mints a missing pointer.
//
// `docs/dogfood-results.md` §10 F1 measured that no internal seam ever minted a
// pointer, so a repository without `.obsidian-mem` could never be bound by
// writing, and that an unbound resolution was memoized per working directory for
// the life of the loaded plugin. Spec §5.2 ends its resolution order with
// "generate the slug, write the pointer exclusively, build the skeleton, register
// the project" and §5.3 says the skeleton appears on first contact; this file
// pins what a real `mem_write`/`mem_log` now does through the SHIPPED tool
// runtime, against a real temporary repository and vault.
//
// What is asserted end to end:
//
//   * a pointerless Git repository is bound by its first write — four-field
//     pointer, no absolute path, vault skeleton, registry row — and the write
//     then proceeds;
//   * the same session's next call sees that binding, whether it was minted
//     automatically or by `mem_admin(action="bind", mode="local")`;
//   * an existing pointer is never rewritten by a later write;
//   * every fail-closed guard still refuses and still mints nothing: a non-Git
//     directory, a corrupt pointer, an unknown schema, an unreadable registry,
//     an unreadable sibling worktree and a cloud-managed vault.
//
// The real vault (`~/Documents/dsh-memory`), the real `~/.dsh` and any real
// repository are never read or written; every fixture is a `mkdtemp` tree.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'

import { Context } from '@deepseek-ai/cordis'
import toolsPlugin from '@deepseek-ai/dsh-tools'

import { validateConfig } from '../lib/config.js'
import { createMemoryServices, registerTools } from '../lib/tools.js'
import { POINTER_FILENAME, REGISTRY_RELATIVE_PATH, resolveBinding } from '../lib/vault.js'

const execFileAsync = promisify(execFile)

/** The four pointer fields, sorted (spec §5.2 / ruling D3). */
const POINTER_KEYS = Object.freeze(['displayName', 'projectId', 'schema', 'slug'])

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
      '-c', 'user.name=Task 20b',
      '-c', 'user.email=t20b@example.invalid',
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

/** Register a linked worktree (its `.git` is a FILE) and return its path. */
async function addWorktree(repoDir, target) {
  await git(repoDir, ['worktree', 'add', '--detach', '-q', target, 'HEAD'])
  return target
}

/**
 * A throwaway root with a temporary home, data root, Git repository and a vault
 * path that does **not** exist yet — the state a first write meets in a fresh
 * checkout.
 */
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'obsidian-mem-t20b-'))
  const dataRoot = await mkdtemp(join(tmpdir(), 'obsidian-mem-t20b-data-'))
  t.after(() => Promise.all([
    rm(root, { recursive: true, force: true, maxRetries: 4 }),
    rm(dataRoot, { recursive: true, force: true, maxRetries: 4 }),
  ]))
  const home = join(root, 'home')
  const repo = join(root, 'repo')
  const vault = join(root, 'vault')
  await mkdir(home, { recursive: true })
  await initRepo(repo)
  return { root, dataRoot, home, repo, vault }
}

/** A real Cordis context with the shipped ToolRuntime mounted, and no tools. */
async function bareBed(t) {
  const ctx = new Context()
  ctx.provide('systemPrompt', { tools: () => () => {} })
  const fork = ctx.plugin(toolsPlugin)
  await fork
  t.after(async () => { await fork.dispose().catch(() => {}) })
  return ctx
}

/**
 * The six tools over real services pointed at one fixture. `initGitOnCreate` is
 * off so the temporary vault is not turned into a Git repository by the
 * bootstrap; that default is covered by `test/bootstrap.test.js`.
 */
async function memoryBed(t, fixture, overrides = {}) {
  const ctx = await bareBed(t)
  const services = createMemoryServices({
    config: validateConfig({ vaultPath: fixture.vault, initGitOnCreate: false, ...overrides }),
    dataRoot: fixture.dataRoot,
    cwd: fixture.repo,
    home: fixture.home,
  })
  const disposers = registerTools(ctx, services)
  t.after(async () => {
    for (const dispose of disposers) dispose()
    await services.close()
  })
  return { ctx, services }
}

let callSeq = 0

/** Execute one tool with an agent whose session carries `cwd`. */
function call(ctx, name, args, { cwd } = {}) {
  return ctx.tools.execute({
    callId: `call-${(callSeq += 1)}`,
    name,
    arguments: args,
    signal: new AbortController().signal,
    agent: { session: { header: { id: 'sess-auto-bind', ...(cwd === undefined ? {} : { cwd }) } } },
  })
}

/** Assert a call succeeded and hand back its canonical value. */
function value(result, label) {
  assert.equal(result.isError, false, `${label}: ${result.error?.message ?? JSON.stringify(result)}`)
  return result.value
}

/** The one refused call, with its message. */
function refused(result, label) {
  assert.equal(result.isError, true, `${label} must refuse: ${JSON.stringify(result.value)}`)
  return result.error.message
}

async function readPointerBytes(repo) {
  return readFile(join(repo, POINTER_FILENAME))
}

async function pointerIsAbsent(repo) {
  await assert.rejects(readPointerBytes(repo), { code: 'ENOENT' })
}

// ---------------------------------------------------------------------------
// Auto-bind on the write path
// ---------------------------------------------------------------------------

test('the first mem_write binds a pointerless Git repository and lands the note', async (t) => {
  const f = await fixture(t)
  const { ctx } = await memoryBed(t, f)

  await pointerIsAbsent(f.repo)
  assert.equal((await readFile(join(f.vault, REGISTRY_RELATIVE_PATH), 'utf8').catch(() => null)), null,
    'the vault does not exist before the write')

  const written = value(await call(ctx, 'mem_write', {
    type: 'doc',
    title: '调度器改为可插拔后端',
    body: '采用可插拔调度器方案，理由与备选方案见正文。',
  }, { cwd: f.repo }), 'first mem_write')

  // (a) the pointer: exactly the four fields, nothing machine-local.
  const bytes = await readPointerBytes(f.repo)
  const pointer = JSON.parse(bytes.toString('utf8'))
  assert.deepEqual(Object.keys(pointer).sort(), POINTER_KEYS)
  assert.equal(pointer.schema, 1)
  assert.match(pointer.projectId, UUID_V4)
  assert.equal(pointer.slug, basename(f.repo))
  assert.equal(pointer.displayName, basename(f.repo))
  const raw = bytes.toString('utf8')
  assert.equal(raw.includes('/'), false, `the pointer must carry no path: ${raw}`)
  assert.equal(raw.includes(f.repo), false)

  // The skeleton and the registry row are the rest of §5.2's first use.
  const projectDir = `Projects/${pointer.slug}--${pointer.projectId.slice(0, 8)}`
  assert.match(written.path, new RegExp(`^${projectDir}/Docs/`))
  const registry = await readFile(join(f.vault, REGISTRY_RELATIVE_PATH), 'utf8')
  assert.match(registry, new RegExp(pointer.projectId))
  const hub = await readFile(join(f.vault, ...projectDir.split('/'), 'index.md'), 'utf8')
  assert.match(hub, /^---\n/)
  const hot = await readFile(join(f.vault, ...projectDir.split('/'), '_meta', 'hot.md'), 'utf8')
  assert.ok(hot.length > 0)

  // (b) the write proceeded, and the note round-trips.
  const read = value(await call(ctx, 'mem_read', { path: written.path }, { cwd: f.repo }), 'mem_read')
  assert.equal(read.id, written.id)
  assert.match(read.body, /采用可插拔调度器方案/)
})

test('the first mem_log binds a pointerless Git repository too', async (t) => {
  const f = await fixture(t)
  const { ctx } = await memoryBed(t, f)

  const receipt = value(await call(ctx, 'mem_log', {
    text: '第一次写日志时自动绑定。',
    session: 'sess-auto-bind-log',
  }, { cwd: f.repo }), 'first mem_log')

  assert.equal(receipt.action, 'log')
  const pointer = JSON.parse((await readPointerBytes(f.repo)).toString('utf8'))
  assert.deepEqual(Object.keys(pointer).sort(), POINTER_KEYS)
  assert.ok(receipt.paths.some((path) => path.startsWith(`Projects/${pointer.slug}--${pointer.projectId.slice(0, 8)}/Daily/`)),
    `the log landed under the new project: ${JSON.stringify(receipt.paths)}`)
})

// ---------------------------------------------------------------------------
// The per-cwd memo
// ---------------------------------------------------------------------------

test('an automatic bind is visible to the next call in the same session', async (t) => {
  const f = await fixture(t)
  const { ctx } = await memoryBed(t, f)

  // This call memoizes the *miss* for the working directory. Before the fix the
  // memo survived the bind, so every later call kept replaying `not-bound`.
  const before = await call(ctx, 'mem_search', { query: '调度器' }, { cwd: f.repo })
  assert.match(refused(before, 'mem_search before any bind'), /needs a bound project/)

  const written = value(await call(ctx, 'mem_write', {
    type: 'doc', title: '调度器改为可插拔后端', body: '采用可插拔调度器方案。',
  }, { cwd: f.repo }), 'mem_write after the miss')

  const after = value(await call(ctx, 'mem_search', { query: '调度器' }, { cwd: f.repo }), 'mem_search after the bind')
  assert.ok(after.hits.some((hit) => hit.id === written.id), `the new binding must reach the index: ${JSON.stringify(after.hits)}`)
})

test('an explicit bind is visible to the next call in the same session', async (t) => {
  const f = await fixture(t)
  const { ctx } = await memoryBed(t, f)

  const before = await call(ctx, 'mem_search', { query: '调度器' }, { cwd: f.repo })
  assert.match(refused(before, 'mem_search before the explicit bind'), /needs a bound project/)

  const bound = value(await call(ctx, 'mem_admin', { action: 'bind', mode: 'local' }, { cwd: f.repo }), 'mem_admin bind local')
  assert.equal(bound.result.status, 'bound')
  assert.equal(bound.result.resolution.kind, 'bound')

  const after = await call(ctx, 'mem_search', { query: '调度器' }, { cwd: f.repo })
  assert.equal(after.isError, false, `the same session must see the binding: ${after.error?.message}`)
})

test('a second write never rewrites an existing pointer', async (t) => {
  const f = await fixture(t)
  const { ctx } = await memoryBed(t, f)

  const first = value(await call(ctx, 'mem_write', { type: 'doc', title: '第一篇', body: '正文。' }, { cwd: f.repo }))
  const bytesAfterFirst = await readPointerBytes(f.repo)

  const second = value(await call(ctx, 'mem_write', { type: 'doc', title: '第二篇', body: '正文。' }, { cwd: f.repo }))
  assert.notEqual(second.id, first.id)
  assert.deepEqual(await readPointerBytes(f.repo), bytesAfterFirst, 'the pointer bytes must be identical')
  assert.equal(second.path.slice(0, first.path.lastIndexOf('/')), first.path.slice(0, first.path.lastIndexOf('/')),
    'both notes land in the same project directory')
})

test('a fresh worktree inherits its sibling pointer instead of minting a second id', async (t) => {
  const f = await fixture(t)
  const { ctx } = await memoryBed(t, f)

  const onMain = value(await call(ctx, 'mem_write', { type: 'doc', title: '第一篇', body: '正文。' }, { cwd: f.repo }))
  const mainPointer = JSON.parse((await readPointerBytes(f.repo)).toString('utf8'))

  const worktree = join(f.root, 'wt-fresh')
  await addWorktree(f.repo, worktree)
  await pointerIsAbsent(worktree)

  const inWorktree = value(await call(ctx, 'mem_write', { type: 'doc', title: '第二篇', body: '正文。' }, { cwd: worktree }))
  const worktreePointer = JSON.parse((await readPointerBytes(worktree)).toString('utf8'))
  assert.equal(worktreePointer.projectId, mainPointer.projectId, 'the worktree inherits the repository identity')
  assert.equal(worktreePointer.slug, mainPointer.slug)
  assert.equal(
    inWorktree.path.slice(0, inWorktree.path.lastIndexOf('/')),
    onMain.path.slice(0, onMain.path.lastIndexOf('/')),
    'both worktrees write into the one project directory',
  )
})

// ---------------------------------------------------------------------------
// The guards still refuse, and still mint nothing
// ---------------------------------------------------------------------------

test('a non-Git directory still refuses and stays unbound', async (t) => {
  const f = await fixture(t)
  const plain = join(f.root, 'plain')
  await mkdir(plain, { recursive: true })
  const { ctx } = await memoryBed(t, f)

  const message = refused(await call(ctx, 'mem_write', { type: 'doc', title: '标题', body: '正文。' }, { cwd: plain }), 'plain directory write')
  assert.match(message, /needs a bound project/)
  assert.match(message, /no-git-root/)
  await pointerIsAbsent(plain)
})

test('a corrupt pointer still refuses and is left untouched', async (t) => {
  const f = await fixture(t)
  const corrupt = '{ not a pointer'
  await writeFile(join(f.repo, POINTER_FILENAME), corrupt)
  const { ctx } = await memoryBed(t, f)

  const message = refused(await call(ctx, 'mem_write', { type: 'doc', title: '标题', body: '正文。' }, { cwd: f.repo }), 'corrupt pointer write')
  assert.match(message, /pointer-corrupt/)
  assert.equal(await readFile(join(f.repo, POINTER_FILENAME), 'utf8'), corrupt, 'a corrupt pointer is never repaired')
})

test('an unknown pointer schema still refuses and is left untouched', async (t) => {
  const f = await fixture(t)
  const unknown = `${JSON.stringify({
    projectId: '1c392abb-7b08-42f7-871d-2a379caf9448',
    slug: 'repo',
    displayName: 'repo',
    schema: 2,
  })}\n`
  await writeFile(join(f.repo, POINTER_FILENAME), unknown)
  const { ctx } = await memoryBed(t, f)

  const message = refused(await call(ctx, 'mem_write', { type: 'doc', title: '标题', body: '正文。' }, { cwd: f.repo }), 'unknown schema write')
  assert.match(message, /pointer-unsupported-schema/)
  assert.equal(await readFile(join(f.repo, POINTER_FILENAME), 'utf8'), unknown)
})

test('an unreadable registry still refuses and leaves no minted pointer', async (t) => {
  const f = await fixture(t)
  await mkdir(join(f.vault, '_meta'), { recursive: true })
  await writeFile(
    join(f.vault, REGISTRY_RELATIVE_PATH),
    [
      '<!-- obsidian-mem:registry begin sha256:0000000000000000000000000000000000000000000000000000000000000000 -->',
      '<!-- obsidian-mem:registry begin sha256:0000000000000000000000000000000000000000000000000000000000000000 -->',
      '',
      '<!-- obsidian-mem:registry end -->',
      '',
    ].join('\n'),
  )
  const { ctx } = await memoryBed(t, f)

  const message = refused(await call(ctx, 'mem_write', { type: 'doc', title: '标题', body: '正文。' }, { cwd: f.repo }), 'malformed registry write')
  assert.match(message, /registry-invalid/)
  // The bind mints the pointer before it reads the registry; a refusal must not
  // leave that half-created identity behind, or the next attempt would read it
  // instead of minting again. The direct seam is the only place the annotated
  // `unwound` value is visible, so it is asserted here.
  await pointerIsAbsent(f.repo)
  const direct = await resolveBinding({ cwd: f.repo, vaultRoot: f.vault, mode: 'local', dataRoot: f.dataRoot, home: f.home })
  assert.equal(direct.kind, 'conflict')
  assert.equal(direct.reason, 'registry-invalid')
  assert.equal(direct.unwound, true, 'the pointer this resolution created must be handed back')
  await pointerIsAbsent(f.repo)
})

test('an unreadable sibling worktree still refuses instead of minting', async (t) => {
  const f = await fixture(t)
  const doomed = await addWorktree(f.repo, join(f.root, 'wt-gone'))
  // Registered in the common git dir, checkout gone: its pointer cannot be read.
  await rm(doomed, { recursive: true, force: true })
  const { ctx } = await memoryBed(t, f)

  const message = refused(await call(ctx, 'mem_write', { type: 'doc', title: '标题', body: '正文。' }, { cwd: f.repo }), 'unreadable sibling write')
  assert.match(message, /sibling-unreadable/)
  await pointerIsAbsent(f.repo)
})

test('a property preflight refusal hands the minted pointer back', async (t) => {
  const f = await fixture(t)
  // An existing vault note whose `tags` is text where §6.4 requires a list: the
  // bootstrap preflight refuses before the first vault write.
  await mkdir(join(f.vault, 'Projects', 'x--deadbeef'), { recursive: true })
  await writeFile(
    join(f.vault, 'Projects', 'x--deadbeef', '坏笔记.md'),
    '---\nid: "dec-1"\ntags: foo\n---\nBody\n',
  )
  const { ctx } = await memoryBed(t, f)

  const first = refused(await call(ctx, 'mem_write', { type: 'doc', title: '标题', body: '正文。' }, { cwd: f.repo }), 'preflight write')
  assert.match(first, /tags/)
  // The pointer would otherwise make the next write resolve as bound and skip
  // the preflight that just refused it.
  await pointerIsAbsent(f.repo)

  const second = refused(await call(ctx, 'mem_write', { type: 'doc', title: '标题', body: '正文。' }, { cwd: f.repo }), 'second preflight write')
  assert.match(second, /tags/)
  await pointerIsAbsent(f.repo)
})

test('a registry whose recorded hash does not match still refuses and leaves no minted pointer', async (t) => {
  const f = await fixture(t)
  // Structurally valid, so `resolveBinding` reads it and binds; the declared
  // sha256 does not cover the body, which only the bootstrap's registry step
  // verifies — a refusal that still happens before the first vault write.
  await mkdir(join(f.vault, '_meta'), { recursive: true })
  await writeFile(join(f.vault, REGISTRY_RELATIVE_PATH), [
    '<!-- obsidian-mem:registry begin sha256:0000000000000000000000000000000000000000000000000000000000000000 -->',
    '<!-- obsidian-mem:registry end -->',
    '',
  ].join('\n'))
  const { ctx } = await memoryBed(t, f)

  const first = refused(await call(ctx, 'mem_write', { type: 'doc', title: '标题', body: '正文。' }, { cwd: f.repo }), 'hash-mismatch write')
  assert.match(first, /recorded sha256/)
  await pointerIsAbsent(f.repo)

  const second = refused(await call(ctx, 'mem_write', { type: 'doc', title: '标题', body: '正文。' }, { cwd: f.repo }), 'second hash-mismatch write')
  assert.match(second, /recorded sha256/)
  await pointerIsAbsent(f.repo)
})

test('a failure after the skeleton is written keeps the identity, and an explicit bind repairs it', async (t) => {
  const f = await fixture(t)
  // A deterministic failure *after* the first skeleton write: the registry
  // transaction is the last step of a bootstrap, and a `transactions` path that
  // is a regular file makes it fail there.
  await writeFile(join(f.dataRoot, 'transactions'), 'not a directory')
  const { ctx } = await memoryBed(t, f)

  const first = refused(await call(ctx, 'mem_write', { type: 'doc', title: '标题', body: '正文。' }, { cwd: f.repo }), 'post-skeleton write')
  assert.match(first, /not a directory|ENOTDIR/)

  // The identity stays, because the skeleton it names really exists; only the
  // registry row is missing. An explicit bind is the documented repair.
  const bytes = await readPointerBytes(f.repo)
  const pointer = JSON.parse(bytes.toString('utf8'))
  const projectDir = `Projects/${pointer.slug}--${pointer.projectId.slice(0, 8)}`
  await readFile(join(f.vault, ...projectDir.split('/'), '_meta', 'hot.md'), 'utf8')
  await assert.rejects(readFile(join(f.vault, REGISTRY_RELATIVE_PATH)), { code: 'ENOENT' })

  await rm(join(f.dataRoot, 'transactions'))
  const healed = value(await call(ctx, 'mem_admin', { action: 'bind', mode: 'local' }, { cwd: f.repo }), 'repairing bind')
  assert.equal(healed.result.status, 'bound')
  assert.equal(healed.result.registryUpdated, true)
  assert.deepEqual(await readPointerBytes(f.repo), bytes, 'the repair reuses the identity instead of minting a second one')
  const registry = await readFile(join(f.vault, REGISTRY_RELATIVE_PATH), 'utf8')
  assert.match(registry, new RegExp(pointer.projectId))
})

test('a pointer minted by another writer since the memoized miss is adopted, not refused', async (t) => {
  const f = await fixture(t)
  // Two loaded service sets over the same repository: the closest stand-in for a
  // second process, and the only way to make the race deterministic. The first
  // set memoizes a miss for this working directory; the second mints the pointer.
  const mine = await memoryBed(t, f)
  const other = await memoryBed(t, f)

  assert.match(
    refused(await call(mine.ctx, 'mem_search', { query: '调度器' }, { cwd: f.repo }), 'memoized miss'),
    /needs a bound project/,
  )
  const bound = value(await call(other.ctx, 'mem_admin', { action: 'bind', mode: 'local' }, { cwd: f.repo }), 'other writer bind')
  assert.equal(bound.result.status, 'bound')

  // This call's `show` probe now answers `bound`, which carries no `reason` or
  // `message`. Reporting it as a refusal printed `cannot be bound (undefined):
  // undefined`; it is the binding.
  const written = value(await call(mine.ctx, 'mem_write', {
    type: 'doc', title: '竞争中的写入', body: '另一进程已经铸出指针。',
  }, { cwd: f.repo }), 'write after the race')
  assert.match(written.path, /^Projects\//)
  const pointer = JSON.parse((await readPointerBytes(f.repo)).toString('utf8'))
  assert.equal(pointer.projectId, bound.result.resolution.projectId, 'the adopted identity is the one on disk')

  // The memoized miss was replaced, so the next call does not replay it.
  const after = await call(mine.ctx, 'mem_search', { query: '竞争' }, { cwd: f.repo })
  assert.equal(after.isError, false, `the adopted binding must survive the memo: ${after.error?.message}`)
})

// ---------------------------------------------------------------------------
// The explicit bind follows the same pre-write release policy
// ---------------------------------------------------------------------------

test('an explicit bind that refuses before its first write hands the pointer and the memo back', async (t) => {
  const f = await fixture(t)
  // The §6.4 property preflight refuses inside `bootstrapVault`, before any vault
  // write: exactly the class of refusal `autoBindProject` releases on.
  await mkdir(join(f.vault, 'Projects', 'x--deadbeef'), { recursive: true })
  await writeFile(join(f.vault, 'Projects', 'x--deadbeef', '坏笔记.md'), '---\nid: "dec-1"\ntags: foo\n---\nBody\n')
  const { ctx } = await memoryBed(t, f)

  const message = refused(await call(ctx, 'mem_admin', { action: 'bind', mode: 'local' }, { cwd: f.repo }), 'explicit bind')
  assert.match(message, /tags/)
  await pointerIsAbsent(f.repo)

  // The memo must not have been published either: with it published the next
  // write would resolve as bound and skip the preflight that just refused it.
  const second = refused(await call(ctx, 'mem_write', { type: 'doc', title: '标题', body: '正文。' }, { cwd: f.repo }), 'write after the refused bind')
  assert.match(second, /tags/)
  await pointerIsAbsent(f.repo)
})

test('a cloud-managed vault still refuses and mints nothing', async (t) => {
  const f = await fixture(t)
  const vault = join(f.home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'dsh-memory')
  await mkdir(vault, { recursive: true })
  const { ctx } = await memoryBed(t, f, { vaultPath: vault })

  const message = refused(await call(ctx, 'mem_write', { type: 'doc', title: '标题', body: '正文。' }, { cwd: f.repo }), 'cloud-managed vault write')
  assert.match(message, /cloud-managed/)
  await pointerIsAbsent(f.repo)
})
