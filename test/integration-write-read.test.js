// Task 10: the P1 integration chain — a real vault, the real tool runtime.
//
// Every case builds a throwaway home, repo and vault under `mkdtemp`, binds and
// bootstraps them with the Task 4/5 modules, and then drives the six tools
// through the SHIPPED `ToolRuntime`. The user's real vault, real `~/.dsh` and
// real repositories are never read or written: the plugin's data root is an
// explicit temporary directory except in the two `apply` cases, which point
// `DSH_HOME` at a temporary home first.
//
// What is under test end to end is exactly the P1 claim: `mem_write` lands a
// note in the vault, `mem_search` finds the same id through the index, and
// `mem_read` returns that same note's body and hash. Around that chain the file
// also pins the honesty boundary — Task 11 binds `mem_brief` to the real
// `buildBrief`, and Task 17 makes all six `mem_admin` actions real: a lint
// report traces to vault-relative paths, and a bind refusal reports its reason
// instead of a silent success.
//
// Like `test/tools.test.js`, this file mounts the real `@deepseek-ai/dsh-tools`
// runtime, which is an optional peer dependency DSH provides to an installed
// plugin (`~/.dsh/profiles/node_modules/@deepseek-ai/*` symlinks).
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'

import { Context } from '@deepseek-ai/cordis'
import toolsPlugin from '@deepseek-ai/dsh-tools'

import { validateConfig } from '../lib/config.js'
import { apply } from '../lib/index.js'
import { createMemoryServices, registerTools } from '../lib/tools.js'
import { bootstrapVault, resolveBinding } from '../lib/vault.js'

const execFileAsync = promisify(execFile)

const DATE = (() => {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
})()

function gitEnvironment() {
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY']) {
    delete env[key]
  }
  return env
}

async function initRepo(dir) {
  await mkdir(dir, { recursive: true })
  await execFileAsync('git', ['-c', 'init.defaultBranch=main', 'init', '-q'], { cwd: dir, env: gitEnvironment() })
}

/** Vault-relative path → absolute path inside the throwaway vault. */
const at = (vault, relative) => join(vault, ...relative.split('/'))

/** Every file below `root` as `relative path -> sha256`. */
async function hashTree(root) {
  const found = new Map()
  async function walk(directory, prefix) {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries.sort((left, right) => (left.name < right.name ? -1 : 1))) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      const absolute = join(directory, entry.name)
      if (entry.isDirectory()) await walk(absolute, relative)
      else if (entry.isFile()) found.set(relative, createHash('sha256').update(await readFile(absolute)).digest('hex'))
    }
  }
  await walk(root, '')
  return found
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A bound, bootstrapped throwaway project: a temporary home, a real git repo
 * carrying a `.obsidian-mem` pointer, and a vault whose skeleton exists.
 */
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'obsidian-mem-t10-'))
  const dataRoot = await mkdtemp(join(tmpdir(), 'obsidian-mem-t10-data-'))
  t.after(() => Promise.all([
    rm(root, { recursive: true, force: true, maxRetries: 4 }),
    rm(dataRoot, { recursive: true, force: true, maxRetries: 4 }),
  ]))
  const home = join(root, 'home')
  const repo = join(root, 'repo')
  const vault = join(root, 'vault')
  await mkdir(home, { recursive: true })
  await initRepo(repo)
  const binding = await resolveBinding({ cwd: repo, vaultRoot: vault, home })
  assert.equal(binding.kind, 'bound', `fixture must bind: ${JSON.stringify(binding)}`)
  await bootstrapVault(binding, { dataRoot, home })
  return { root, dataRoot, home, repo, vault, binding }
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

/** The same context, with the six tools registered against real services. */
async function memoryBed(t, fixture, config = {}) {
  const ctx = await bareBed(t)
  const services = createMemoryServices({
    config: validateConfig({ vaultPath: fixture.vault, ...config }),
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
function call(ctx, name, args, { cwd, signal } = {}) {
  return ctx.tools.execute({
    callId: `call-${(callSeq += 1)}`,
    name,
    arguments: args,
    signal: signal ?? new AbortController().signal,
    agent: { session: { header: { id: 'sess-integration', ...(cwd === undefined ? {} : { cwd }) } } },
  })
}

/** Assert a call succeeded and hand back its canonical value. */
function value(result, label) {
  assert.equal(result.isError, false, `${label}: ${result.error?.message ?? JSON.stringify(result)}`)
  return result.value
}

// ---------------------------------------------------------------------------
// The chain
// ---------------------------------------------------------------------------

test('mem_write → mem_search → mem_read round-trips one note id', async (t) => {
  const f = await fixture(t)
  const { ctx } = await memoryBed(t, f)

  const written = value(await call(ctx, 'mem_write', {
    type: 'doc',
    title: '调度器改为可插拔后端',
    body: '采用可插拔调度器方案，理由与备选方案见正文。',
  }, { cwd: f.repo }), 'mem_write')

  assert.match(written.id, /^doc-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.match(written.path, /^项目\/[^/]+--[0-9a-f]{8}\/文档\//)
  assert.equal(written.receipt.action, 'write')
  assert.equal(written.receipt.result.status, 'applied')
  assert.equal(written.receipt.afterHashes[written.path].length, 64)

  const found = value(await call(ctx, 'mem_search', { query: '调度器' }, { cwd: f.repo }), 'mem_search')
  const hit = found.hits.find((candidate) => candidate.id === written.id)
  assert.ok(hit, `mem_search must return the written id: ${JSON.stringify(found.hits)}`)
  assert.equal(hit.path, written.path)
  assert.equal(hit.projectId, f.binding.projectId)
  assert.equal(hit.type, 'doc')
  assert.equal(hit.title, '调度器改为可插拔后端')
  assert.ok(hit.scoreSignals.length > 0, 'a hit must explain its ranking')
  assert.match(hit.snippet, /调度器/)

  const read = value(await call(ctx, 'mem_read', { path: written.path }, { cwd: f.repo }), 'mem_read')
  assert.equal(read.id, written.id)
  assert.equal(read.path, written.path)
  assert.equal(read.hash, written.receipt.afterHashes[written.path])
  assert.match(read.body, /采用可插拔调度器方案/)
  assert.equal(read.frontmatter.id, written.id)
  assert.equal(read.frontmatter.project, f.binding.projectId)
  // Provenance: the producing session is recorded from the execution context,
  // not asked of the model (spec §6.4 `session:`, R13).
  assert.equal(read.frontmatter.session, 'sess-integration')

  // The type filter is the closed §6.4 vocabulary: an unknown type is refused
  // rather than silently matching nothing, and the `invariant` input alias
  // resolves to `convention`.
  const badType = await call(ctx, 'mem_search', { query: '调度器', type: 'nope' }, { cwd: f.repo })
  assert.equal(badType.isError, true)
  assert.match(badType.error.message, /type must be one of/)
  const aliased = value(await call(ctx, 'mem_search', { query: '调度器', type: 'invariant' }, { cwd: f.repo }), 'aliased type')
  assert.deepEqual(aliased.hits, [], 'a convention filter must not return the doc note')
})

test('a note written after the first scan is searchable in the same session', async (t) => {
  const f = await fixture(t)
  const { ctx } = await memoryBed(t, f)

  const before = value(await call(ctx, 'mem_search', { query: '索引未刷新' }, { cwd: f.repo }), 'first search')
  assert.deepEqual(before.hits, [], 'the index must be ready and empty before the write')

  value(await call(ctx, 'mem_write', {
    type: 'gotcha',
    title: '写后必须刷新索引',
    body: '索引未刷新时，同一会话搜不到刚写入的笔记。',
  }, { cwd: f.repo }), 'mem_write')

  const after = value(await call(ctx, 'mem_search', { query: '索引未刷新' }, { cwd: f.repo }), 'second search')
  assert.equal(after.hits.some((h) => h.title === '写后必须刷新索引'), true, JSON.stringify(after.hits))
})

test('a repeated idempotencyKey replays the original receipt instead of writing twice', async (t) => {
  const f = await fixture(t)
  const { ctx } = await memoryBed(t, f)
  const args = { type: 'gotcha', title: '重试幂等', body: '同一 key 只写一次。', idempotencyKey: 'k-replay-1' }

  const first = value(await call(ctx, 'mem_write', args, { cwd: f.repo }), 'first write')
  const replay = value(await call(ctx, 'mem_write', args, { cwd: f.repo }), 'replay write')
  assert.equal(replay.id, first.id)
  assert.equal(replay.path, first.path)
  assert.equal(replay.receipt.txId, first.receipt.txId)

  const notes = await readdir(at(f.vault, `${f.binding.relativeDir}/踩坑`))
  assert.deepEqual(notes.filter((name) => name.endsWith('.md') && name !== 'index.md'), ['重试幂等.md'])
})

test('mem_write updates a known id and refuses an unknown one', async (t) => {
  const f = await fixture(t)
  const { ctx } = await memoryBed(t, f)
  const created = value(await call(ctx, 'mem_write', {
    type: 'decision', title: '调度器改为可插拔后端', body: '初始正文。',
  }, { cwd: f.repo }), 'create')

  const updated = value(await call(ctx, 'mem_write', {
    id: created.id, type: 'decision', title: '调度器改为可插拔后端', body: '改后的正文。',
  }, { cwd: f.repo }), 'update')
  assert.equal(updated.id, created.id)
  assert.equal(updated.path, created.path)

  const read = value(await call(ctx, 'mem_read', { path: created.path }, { cwd: f.repo }), 'read')
  assert.match(read.body, /改后的正文/)

  const missing = await call(ctx, 'mem_write', {
    id: 'dec-00000000-0000-4000-8000-000000000000', type: 'decision', title: '不存在', body: '正文',
  }, { cwd: f.repo })
  assert.equal(missing.isError, true)
  assert.match(missing.error.message, /carries id/)
})

test('mem_write refuses an unknown type through the real memory layer', async (t) => {
  const f = await fixture(t)
  const { ctx } = await memoryBed(t, f)
  const result = await call(ctx, 'mem_write', { type: 'docs', title: '标题', body: '正文' }, { cwd: f.repo })
  assert.equal(result.isError, true)
  assert.match(result.error.message, /type must be one of/)
})

test('mem_read keeps every path inside the vault jail', async (t) => {
  const f = await fixture(t)
  const { ctx } = await memoryBed(t, f)
  // An existing non-Markdown file, so the not-a-note branch is exercised on a
  // path that really exists: `readNote` resolves the path first, so a missing
  // internal path is reported as missing rather than as internal plumbing.
  const plainText = `${f.binding.relativeDir}/文档/样例.txt`
  await writeFile(at(f.vault, plainText), '不是笔记\n')
  const cases = [
    ['/etc/passwd', /absolute path is not allowed/],
    ['../../secrets.md', /path traversal is not allowed/],
    [`${f.binding.relativeDir}/文档/../约定/x.md`, /path traversal is not allowed/],
    ['_meta/项目注册表.md', /internal vault plumbing/],
    ['_meta/.history', /internal vault plumbing/],
    [plainText, /not a retrievable Markdown note/],
    ['_meta/log.md', /does not exist|internal vault plumbing/],
  ]
  for (const [path, pattern] of cases) {
    const result = await call(ctx, 'mem_read', { path }, { cwd: f.repo })
    assert.equal(result.isError, true, `${path} must be refused`)
    assert.match(result.error.message, pattern, `${path}: ${result.error.message}`)
  }
  // The refusal above never returned bytes: the file it points at is untouched.
  assert.equal(await readFile(at(f.vault, plainText), 'utf8'), '不是笔记\n')
})

test('a cloud-managed vault root refuses every read path without touching the vault', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'obsidian-mem-t10-cloud-'))
  const dataRoot = await mkdtemp(join(tmpdir(), 'obsidian-mem-t10-cloud-data-'))
  t.after(() => Promise.all([
    rm(root, { recursive: true, force: true, maxRetries: 4 }),
    rm(dataRoot, { recursive: true, force: true, maxRetries: 4 }),
  ]))
  const home = join(root, 'home')
  const repo = join(root, 'repo')
  // iCloud's documented root: `~/Library/Mobile Documents/`. A dataless file
  // there can hard-fail or trigger a mass download, so R14 refuses the whole
  // vault — reads as well as writes.
  const vault = join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'dsh-memory')
  await mkdir(vault, { recursive: true })
  await initRepo(repo)
  const note = '---\nid: "doc-11111111-1111-4111-8111-111111111111"\ntype: "doc"\ntitle: "云端笔记"\n---\n云端正文\n'
  await writeFile(join(vault, 'note.md'), note)
  const { ctx } = await memoryBed(t, { home, repo, vault, dataRoot })

  const cases = [
    ['mem_read', { path: 'note.md' }],
    ['mem_read', { path: '_meta/user.md' }],
    ['mem_search', { query: '云端', scope: 'global' }],
    ['mem_search', { query: '云端' }],
    ['mem_admin', { action: 'projects' }],
    ['mem_admin', { action: 'index' }],
    ['mem_write', { type: 'doc', title: '云端写入', body: '正文' }],
  ]
  for (const [name, args] of cases) {
    const result = await call(ctx, name, args, { cwd: repo })
    assert.equal(result.isError, true, `${name} ${JSON.stringify(args)} must refuse a cloud-managed vault`)
    assert.match(result.error.message, /cloud-managed/, `${name}: ${result.error.message}`)
  }
  // Nothing was opened, scanned, locked or written: no index directory, no lock,
  // no receipt, and the note's bytes are exactly as they were.
  assert.deepEqual(await readdir(dataRoot), [])
  assert.equal(await readFile(join(vault, 'note.md'), 'utf8'), note)
})

test('an unbound working directory refuses project scope and writes but still reads globally', async (t) => {
  const f = await fixture(t)
  const other = join(f.root, 'unbound')
  await initRepo(other)
  const { ctx } = await memoryBed(t, f)

  const search = await call(ctx, 'mem_search', { query: '调度器' }, { cwd: other })
  assert.equal(search.isError, true)
  assert.match(search.error.message, /needs a bound project/)

  const global = value(await call(ctx, 'mem_search', { query: '调度器', scope: 'global' }, { cwd: other }), 'global search')
  assert.deepEqual(global.hits, [])

  const write = await call(ctx, 'mem_write', { type: 'doc', title: '标题', body: '正文' }, { cwd: other })
  assert.equal(write.isError, true)
  assert.match(write.error.message, /bound project/)
})

test('mem_log appends exactly one idempotent day-log block', async (t) => {
  const f = await fixture(t)
  const { ctx } = await memoryBed(t, f)
  const args = { text: '本轮修好了索引刷新。', session: '20260923-120000-abcd', idempotencyKey: 'log-key-1' }

  const first = value(await call(ctx, 'mem_log', args, { cwd: f.repo }), 'first log')
  const replay = value(await call(ctx, 'mem_log', args, { cwd: f.repo }), 'replayed log')
  assert.equal(first.action, 'log')
  assert.equal(replay.txId, first.txId)

  const logPath = at(f.vault, `${f.binding.relativeDir}/日志/${DATE}.md`)
  const text = await readFile(logPath, 'utf8')
  assert.equal(text.split('本轮修好了索引刷新。').length - 1, 1, 'the block is written once')
  assert.match(text, /## 20260923-120000-abcd · 会话/)
})

test('mem_log section=hot writes the controlled 进行中 zone, not a day log', async (t) => {
  const f = await fixture(t)
  const { ctx } = await memoryBed(t, f)
  const result = value(await call(ctx, 'mem_log', {
    text: '正在实现六个工具。', session: 'sess-hot', section: 'hot', idempotencyKey: 'hot-key-1',
  }, { cwd: f.repo }), 'hot log')
  assert.equal(result.action, 'hot')

  const hot = await readFile(at(f.vault, `${f.binding.relativeDir}/_meta/hot.md`), 'utf8')
  const start = hot.indexOf('## 进行中')
  const end = hot.indexOf('## 已完成')
  assert.ok(start > -1 && end > start, 'hot.md keeps its three fixed zones')
  assert.match(hot.slice(start, end), /正在实现六个工具。/)
})

test('mem_brief returns the real budgeted brief through the tool runtime', async (t) => {
  const f = await fixture(t)
  const { ctx } = await memoryBed(t, f)
  value(await call(ctx, 'mem_log', { text: '简报必须出现这一条。', session: 'sess-brief', section: 'hot' }, { cwd: f.repo }), 'hot log')
  const brief = value(await call(ctx, 'mem_brief', {}, { cwd: f.repo }), 'mem_brief')

  // Task 11 binds `mem_brief` to the same `buildBrief` the pre-step injection
  // uses, so the P1 `not-ready-in-p1` marker is gone: the tool answers the real
  // brief, with the binding, the hot entry and its own budget report.
  assert.equal(typeof brief.text, 'string')
  assert.ok(brief.text.includes(f.binding.relativeDir))
  assert.ok(brief.text.includes('简报必须出现这一条。'))
  assert.equal(brief.charCount, [...brief.text].length)
  assert.ok(brief.charCount <= 6000, 'the default brief budget is respected')
  assert.equal(brief.indexState.status, 'ready')
  assert.ok(Array.isArray(brief.hotItems) && brief.hotItems.length === 1)
  assert.match(brief.hotHash, /^[0-9a-f]{64}$/)
  assert.match(brief.text, /<!-- brief: \d+\/6000 chars/)
})

test('mem_admin exposes index status, the project list and bind(show)', async (t) => {
  const f = await fixture(t)
  const { ctx, services } = await memoryBed(t, f)

  const projects = value(await call(ctx, 'mem_admin', { action: 'projects' }, { cwd: f.repo }), 'projects')
  assert.equal(projects.action, 'projects')
  assert.deepEqual(projects.result.projects.map((row) => row.projectId), [f.binding.projectId])

  const status = value(await call(ctx, 'mem_admin', { action: 'index' }, { cwd: f.repo }), 'index')
  assert.equal(status.action, 'index')
  assert.equal(status.result.rebuilt, false)
  assert.ok(['sqlite', 'scan'].includes(status.result.backend))
  assert.equal(status.result.boundProjectId, f.binding.projectId)
  // The tools and a future brief compose from one memoised handle per project.
  const handle = await services.index({ agent: { session: { header: { cwd: f.repo } } } })
  assert.equal(handle.boundProjectId, f.binding.projectId)
  assert.equal(handle.status().boundProjectId, f.binding.projectId)

  const rebuilt = value(await call(ctx, 'mem_admin', { action: 'index', rebuild: true }, { cwd: f.repo }), 'index rebuild')
  assert.equal(rebuilt.result.rebuilt, true)
  assert.equal(rebuilt.result.ready, true)

  const bind = value(await call(ctx, 'mem_admin', { action: 'bind' }, { cwd: f.repo }), 'bind show')
  assert.equal(bind.action, 'bind')
  assert.equal(bind.result.mode, 'show')
  assert.equal(bind.result.status, 'shown')
  assert.equal(bind.result.resolution.kind, 'bound')
  assert.equal(bind.result.resolution.projectId, f.binding.projectId)
  assert.equal(bind.result.resolution.relativeDir, f.binding.relativeDir)
})

test('mem_admin(lint) stays read-only by default and reports real vault facts', async (t) => {
  const f = await fixture(t)
  const { ctx } = await memoryBed(t, f)

  const report = value(await call(ctx, 'mem_admin', { action: 'lint' }, { cwd: f.repo }), 'lint')
  assert.equal(report.action, 'lint')
  assert.equal(report.result.readOnly, true)
  assert.equal(report.result.relativeDir, f.binding.relativeDir)
  assert.equal(report.result.report.status, 'none')
  assert.equal(report.result.index.compared, true)
  // The plugin's own receipts log and registry are permanently excluded.
  assert.equal(report.result.findings.some((finding) => finding.path === '_meta/log.md'), false)
  assert.ok(report.result.safetyExclusions.length > 0)
  // The dated report note is written only when the caller asks for it.
  await assert.rejects(readFile(at(f.vault, `_meta/Lint Report ${DATE}.md`)), { code: 'ENOENT' })

  const written = value(await call(ctx, 'mem_admin', { action: 'lint', report: true }, { cwd: f.repo }), 'lint report')
  assert.equal(written.result.report.status, 'written')
  const text = await readFile(at(f.vault, written.result.report.path), 'utf8')
  assert.match(text, /<!-- obsidian-mem:generated begin sha256:[0-9a-f]{64} -->/)
  assert.match(text, /永久安全排除/)
})

test('mem_admin(lint, report=true) writes only the report; pruning is its own request', async (t) => {
  const f = await fixture(t)
  const { ctx } = await memoryBed(t, f)
  // One old, unprotected snapshot directory: exactly what the retention policy
  // is allowed to remove, and exactly what a report must never remove.
  const snapshot = at(f.vault, '_meta/.history/tx-old')
  await mkdir(snapshot, { recursive: true })
  await writeFile(join(snapshot, '0__note.md'), '# old snapshot\n')
  const longAgo = new Date(Date.now() - 400 * 24 * 3600_000)
  await utimes(snapshot, longAgo, longAgo)
  await utimes(join(snapshot, '0__note.md'), longAgo, longAgo)

  const before = await hashTree(f.vault)
  const reported = value(await call(ctx, 'mem_admin', { action: 'lint', report: true }, { cwd: f.repo }), 'lint report')
  const after = await hashTree(f.vault)
  const changed = [...new Set([...before.keys(), ...after.keys()])]
    .filter((path) => before.get(path) !== after.get(path))
  assert.deepEqual(changed, [reported.result.report.path], 'a report changes exactly the report note')
  assert.equal(existsSync(snapshot), true, 'a report must not prune history')

  const pruned = value(await call(ctx, 'mem_admin', { action: 'lint', prune: true }, { cwd: f.repo }), 'lint prune')
  assert.deepEqual(pruned.result.history.pruned, ['tx-old'], 'the prune is what deletes history')
  assert.equal(existsSync(snapshot), false)

  // Neither flag alone may imply the other.
  const plain = value(await call(ctx, 'mem_admin', { action: 'lint' }, { cwd: f.repo }), 'lint')
  assert.equal(plain.result.readOnly, true)
  assert.equal(plain.result.report.status, 'none')
})

test('mem_admin(promote) creates a 方法 note and leaves the source untouched', async (t) => {
  const f = await fixture(t)
  const { ctx } = await memoryBed(t, f)
  const source = value(await call(ctx, 'mem_write', {
    type: 'convention', title: '项目内约定', body: '只在本项目成立。\n',
  }, { cwd: f.repo }), 'write')

  const before = await readFile(at(f.vault, source.path))
  const promoted = value(await call(ctx, 'mem_admin', { action: 'promote', path: source.path }, { cwd: f.repo }), 'promote')
  assert.equal(promoted.action, 'promote')
  assert.equal(promoted.result.moved, false)
  assert.equal(promoted.result.source, source.path)
  assert.match(promoted.result.path, /^方法\//)
  const method = await readFile(at(f.vault, promoted.result.path), 'utf8')
  assert.ok(method.includes('来源：'))
  assert.deepEqual(await readFile(at(f.vault, source.path)), before)

  // A source outside the vault is refused by the vault jail, not by a guess.
  const refused = await call(ctx, 'mem_admin', { action: 'promote', path: '../../outside.md' }, { cwd: f.repo })
  assert.equal(refused.isError, true)
})

test('mem_admin(jobs) lists the queue and reports a retry refusal honestly', async (t) => {
  const f = await fixture(t)
  const { ctx } = await memoryBed(t, f)
  const listed = value(await call(ctx, 'mem_admin', { action: 'jobs' }, { cwd: f.repo }), 'jobs')
  assert.equal(listed.action, 'jobs')
  assert.equal(listed.result.status, 'listed')
  assert.deepEqual(listed.result.jobs, [])
  assert.equal(listed.result.failed, 0)

  const missing = value(await call(ctx, 'mem_admin', { action: 'jobs', jobId: 'job-404', retry: true }, { cwd: f.repo }), 'retry')
  assert.equal(missing.result.status, 'refused')
  assert.match(missing.result.message, /job-404/)

  const unnamed = await call(ctx, 'mem_admin', { action: 'jobs', retry: true }, { cwd: f.repo })
  assert.equal(unnamed.isError, true)
  assert.match(unnamed.error.message, /jobId/)
})

test('mem_admin(bind) modes report what they did, or why they refused', async (t) => {
  const f = await fixture(t)
  const { ctx } = await memoryBed(t, f)

  const shown = value(await call(ctx, 'mem_admin', { action: 'bind' }, { cwd: f.repo }), 'bind show')
  assert.equal(shown.result.mode, 'show')
  assert.equal(shown.result.status, 'shown')
  assert.equal(shown.result.resolution.kind, 'bound')

  // `retain` with no origin remote has nothing to confirm.
  const refused = value(await call(ctx, 'mem_admin', { action: 'bind', mode: 'retain' }, { cwd: f.repo }), 'bind retain')
  assert.equal(refused.result.mode, 'retain')
  assert.equal(refused.result.status, 'refused')
  assert.equal(refused.result.resolution.kind, 'conflict')
  assert.equal(refused.result.resolution.reason, 'no-remote')
  assert.equal(typeof refused.result.message, 'string')

  // `fork` separates this worktree's identity without touching the old project.
  const before = await readFile(at(f.vault, `${f.binding.relativeDir}/index.md`), 'utf8')
  const forked = value(await call(ctx, 'mem_admin', { action: 'bind', mode: 'fork' }, { cwd: f.repo }), 'bind fork')
  assert.equal(forked.result.mode, 'fork')
  assert.equal(forked.result.status, 'forked')
  assert.equal(forked.result.previousProjectId, f.binding.projectId)
  assert.notEqual(forked.result.resolution.projectId, f.binding.projectId)
  assert.equal(forked.result.bootstrapped, true)
  assert.equal(forked.result.registryUpdated, true)
  assert.equal(await readFile(at(f.vault, `${f.binding.relativeDir}/index.md`), 'utf8'), before)
  assert.equal(existsSync(at(f.vault, forked.result.resolution.relativeDir)), true)
})

// ---------------------------------------------------------------------------
// The host assembly
// ---------------------------------------------------------------------------

test('apply registers exactly the six tools, and nothing at all when enabled is false', async (t) => {
  const ctx = await bareBed(t)
  assert.equal(apply(ctx, { enabled: false }), undefined)
  assert.deepEqual(ctx.tools.schemas(), [])

  const f = await fixture(t)
  // Task 13 made `apply` install the packaged skill under `DSH_HOME`, so this
  // enabled case points `DSH_HOME` at the fixture — the isolation this file's
  // header already claims for both `apply` cases — and then waits for that
  // install, so the fixture teardown cannot race a still-running file write.
  const dshHome = join(f.root, 'dsh-home')
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = dshHome
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  })

  apply(ctx, { vaultPath: f.vault })
  assert.deepEqual(ctx.tools.schemas().map((schema) => schema.name).sort(), [
    'mem_admin', 'mem_brief', 'mem_log', 'mem_read', 'mem_search', 'mem_write',
  ])

  const installed = join(dshHome, 'skills', 'obsidian-mem', 'SKILL.md')
  const installedManifest = join(dshHome, 'skills', 'obsidian-mem', '.obsidian-mem-manifest.json')
  for (let attempt = 0; attempt < 400 && !existsSync(installedManifest); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.equal(existsSync(installed), true, 'the packaged skill is installed into the isolated DSH home')
  assert.equal(existsSync(installedManifest), true, 'and the sync finished before the fixture was torn down')
})

test('apply hands one DSH_HOME-derived data root to the transaction engine and the index', async (t) => {
  const f = await fixture(t)
  const dshHome = join(f.root, 'dsh-home')
  await mkdir(dshHome, { recursive: true })
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = dshHome
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  })

  const ctx = await bareBed(t)
  apply(ctx, { vaultPath: f.vault })

  const written = value(await call(ctx, 'mem_write', {
    type: 'doc', title: '装配说明', body: '数据根由 DSH_HOME 推导。',
  }, { cwd: f.repo }), 'mem_write through apply')
  assert.match(written.path, /^项目\//)

  const dataRoot = join(dshHome, 'data', 'obsidian-mem')
  assert.equal(existsSync(join(dataRoot, 'locks')), true, 'the transaction lock lives under the derived data root')
  assert.equal(existsSync(join(dataRoot, 'receipts')), true, 'the receipt store lives under the derived data root')

  const found = value(await call(ctx, 'mem_search', { query: '装配说明' }, { cwd: f.repo }), 'mem_search through apply')
  assert.equal(found.hits.some((hit) => hit.id === written.id), true)
  assert.equal(existsSync(join(dataRoot, 'index')), true, 'the index lives under the same derived data root')
})
