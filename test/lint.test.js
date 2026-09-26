// Task 17: read-only vault governance — the lint corpus, retention, bind modes,
// promotion, the jobs surface and the weekly hint.
//
// Every case runs against a REAL throwaway vault, a REAL git repository and a
// throwaway plugin data root: nothing here reads or writes the user's real
// `~/.dsh`, the default `~/Documents/dsh-memory` vault or any repository file of
// this checkout. The two structural rules of this task are asserted as facts, not
// as intentions:
//
//   * **The default lint writes nothing.** Every case that calls `lintVault`
//     without an explicit write request snapshots the whole vault (and the
//     repository Markdown) as `path -> sha256` before and after and compares.
//   * **A report is written only on an explicit request**, and a report a human
//     edited is reported as a conflict instead of being overwritten (R24).
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'

import { Context } from '@deepseek-ai/cordis'

import { compileIgnoreGlobs, validateConfig } from '../lib/config.js'
import { RECALL_SOURCE, registerHooks } from '../lib/hooks.js'
import { openIndex } from '../lib/index-db.js'
import {
  HISTORY_POLICY,
  SAFETY_EXCLUSIONS,
  lintReportRelativePath,
  lintVault,
  renderLintReportBody,
  weeklyLintHint,
} from '../lib/lint.js'
import { promoteNote, writeMemory } from '../lib/memory.js'
import { readPendingJobs, writeJobAtomic } from '../lib/pending.js'
import { createMemoryServices } from '../lib/tools.js'
import {
  bootstrapVault,
  newTransactionId,
  resolveBinding,
  runTransaction,
  vaultIdentity,
  withVaultLock,
} from '../lib/vault.js'

const execFileAsync = promisify(execFile)

/** A valid UUIDv4 identity for the fixture project. */
const ID1 = '1c392abb-7b08-42f7-871d-2a379caf9448'
/** A second, different identity — the one `fork` must mint. */
const OLD_ID = '5f0e6d1c-9a4b-4c2d-8e3f-0b7a6c5d4e3f'

/** The documented frontmatter every plugin note carries. */
function pluginNote({ id, type = 'doc', title, extra = '', body = '正文\n' }) {
  return [
    '---',
    `id: ${id}`,
    `type: ${type}`,
    `title: ${JSON.stringify(title)}`,
    'status: active',
    'created: 2026-01-01',
    'updated: 2026-01-01',
    'tags: ["dsh-mem/doc"]',
    'project: null',
    'source: agent',
    'harness: dsh',
    'trust: agent',
    '---',
    extra === '' ? '' : extra,
    body,
  ].join('\n')
}

/** The sha256 of a byte sequence. */
function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

/** A hermetic git environment (no user/system config, no inherited GIT_* redirection). */
function gitEnvironment() {
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
  for (const key of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_COMMON_DIR',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
  ]) {
    delete env[key]
  }
  return env
}

/** Run one git command in a fixture repository. */
function git(cwd, args) {
  return execFileAsync(
    'git',
    [
      '-c',
      'user.name=Task Seventeen',
      '-c',
      'user.email=t17@example.invalid',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'init.defaultBranch=main',
      ...args,
    ],
    { cwd, env: gitEnvironment(), encoding: 'utf8' },
  )
}

/** Create a repository with one commit and return its real path. */
async function initRepo(dir) {
  await mkdir(dir, { recursive: true })
  await git(dir, ['init', '-q'])
  await git(dir, ['commit', '-q', '--allow-empty', '-m', 'init'])
  return dir
}

/** Every file below `root` as `relative path -> sha256`, `files` matching optionally. */
async function hashTree(root, { suffix = null } = {}) {
  const found = new Map()
  async function walk(dir, prefix) {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((left, right) => (left.name < right.name ? -1 : 1))
    for (const entry of entries) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      const absolute = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(absolute, relative)
        continue
      }
      if (!entry.isFile()) continue
      if (suffix !== null && !entry.name.endsWith(suffix)) continue
      found.set(relative, sha256(await readFile(absolute)))
    }
  }
  await walk(root, '')
  return found
}

/**
 * One hermetic governance fixture: a temporary home, vault, bound repository and
 * plugin data root, with the vault bootstrapped and its index open and ready.
 *
 * @param {object} t - the node:test context (owns the cleanup).
 * @param {{ pointer?: boolean, git?: boolean }} [options] - skip the pointer or the repository.
 * @returns {Promise<object>} the fixture.
 */
async function fixture(t, { pointer = true, git: withGit = true, projectId = ID1 } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'obsidian-mem-t17-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 4 }))
  const vault = join(root, 'vault')
  const repo = join(root, 'repo')
  const home = join(root, 'home')
  const dataRoot = join(root, 'data')
  const queueRoot = join(dataRoot, 'pending')
  await mkdir(vault, { recursive: true })
  await mkdir(home, { recursive: true })
  if (withGit) await initRepo(repo)
  else await mkdir(repo, { recursive: true })
  if (pointer) {
    await writeFile(
      join(repo, '.obsidian-mem'),
      `${JSON.stringify({ projectId, slug: 'demo', displayName: 'demo', schema: 1 }, null, 2)}\n`,
    )
  }
  const binding = await resolveBinding({ cwd: repo, vaultRoot: vault, home })
  assert.equal(binding.kind, 'bound', JSON.stringify(binding))
  await bootstrapVault(binding, { initGitOnCreate: false, home, dataRoot })
  const index = await openIndex({ vaultRoot: vault, dataRoot, projectId, home })
  await index.waitReady(undefined, 5000)
  return { root, vault, repo, home, dataRoot, queueRoot, binding, index }
}

/** `lintVault` with the fixture's seams; override any input. */
function lintOf(f, overrides = {}) {
  return lintVault({
    binding: f.binding,
    index: f.index,
    repoRoot: f.repo,
    queueRoot: f.queueRoot,
    ignoreGlobs: [],
    dataRoot: f.dataRoot,
    home: f.home,
    ...overrides,
  })
}

/** The finding kinds a report carries. */
function kindsOf(report) {
  return new Set(report.findings.map((finding) => finding.kind))
}

/** One vault-relative path inside the fixture's project directory. */
function projectPath(f, relative) {
  return `${f.binding.relativeDir}/${relative}`
}

/** Write one extra plugin-owned note straight into the vault (no transaction). */
async function writeNote(f, relative, contents) {
  const absolute = join(f.vault, ...relative.split('/'))
  await mkdir(dirname(absolute), { recursive: true })
  await writeFile(absolute, contents)
  return relative
}

/** One valid pending job document. */
function jobDocument(overrides = {}) {
  return {
    jobId: 'job-1',
    sessionId: 'sess-1',
    projectId: ID1,
    fromSeq: 1,
    toSeq: 2,
    state: 'failed',
    attempts: 3,
    lastError: 'MISSING_CREDENTIAL',
    createdAt: '2026-09-20T00:00:00.000Z',
    allowedEvents: [],
    safeInput: 'safe',
    track: 'root',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Step 1: the finding corpus, all of it read-only
// ---------------------------------------------------------------------------

test('an unbound binding is refused, not linted', async (t) => {
  const f = await fixture(t)
  await assert.rejects(lintOf(f, { binding: { kind: 'unbound' } }), RangeError)
  await assert.rejects(lintOf(f, { binding: null }), RangeError)
})

test('orphan files and orphan index rows are named from the index rows and the vault files', async (t) => {
  const f = await fixture(t)
  // Settle the index against the bootstrap skeleton, then create one file the
  // index has never seen and delete one file the index already knows.
  await f.index.refresh()
  const removed = projectPath(f, 'Docs/删除目标.md')
  await writeNote(
    f,
    removed,
    pluginNote({ id: 'doc-11111111-1111-4111-8111-111111111111', title: '删除目标' }),
  )
  await f.index.refresh()
  await rm(join(f.vault, ...removed.split('/')))
  await writeNote(
    f,
    projectPath(f, 'Docs/新增孤儿.md'),
    pluginNote({ id: 'doc-22222222-2222-4222-8222-222222222222', title: '新增孤儿' }),
  )

  const report = await lintOf(f)
  const orphanFiles = report.findings.filter((finding) => finding.kind === 'orphan-file')
  const orphanRows = report.findings.filter((finding) => finding.kind === 'orphan-index-row')
  assert.deepEqual(
    orphanFiles.map((finding) => finding.path),
    [projectPath(f, 'Docs/新增孤儿.md')],
  )
  assert.deepEqual(
    orphanRows.map((finding) => finding.path),
    [removed],
  )
  assert.equal(report.index.notes, report.index.rows)
  assert.equal(report.index.compared, true)
  await f.index.close()
})

test('a dead wikilink is reported and a resolvable one is not', async (t) => {
  const f = await fixture(t)
  const target = projectPath(f, 'Docs/目标.md')
  await writeNote(
    f,
    target,
    pluginNote({ id: 'doc-33333333-3333-4333-8333-333333333333', title: '目标' }),
  )
  await writeNote(
    f,
    projectPath(f, 'Docs/引用者.md'),
    pluginNote({
      id: 'doc-44444444-4444-4444-8444-444444444444',
      title: '引用者',
      body: '见 [[Projects/demo--1c392abb/Docs/目标|目标]] 与 [[不存在的东西]] 以及 https://example.invalid/x\n',
    }),
  )

  const report = await lintOf(f)
  const dead = report.findings.filter((finding) => finding.kind === 'dead-wikilink')
  assert.equal(dead.length, 1, JSON.stringify(dead))
  assert.equal(dead[0].path, projectPath(f, 'Docs/引用者.md'))
  assert.match(dead[0].message, /不存在的东西/)
  await f.index.close()
})

test('case-folded duplicate note names are reported, exact duplicates are not', async (t) => {
  const f = await fixture(t)
  // Two directories on purpose: a case-insensitive filesystem cannot hold both
  // names side by side, but Obsidian's link resolver still sees one ambiguous
  // target across the project.
  await writeNote(
    f,
    projectPath(f, 'Docs/Readme.md'),
    pluginNote({ id: 'doc-55555555-5555-4555-8555-555555555555', title: 'Readme' }),
  )
  await writeNote(
    f,
    projectPath(f, 'Decisions/README.md'),
    pluginNote({ id: 'doc-66666666-6666-4666-8666-666666666666', title: 'README' }),
  )

  const report = await lintOf(f)
  const duplicates = report.findings.filter((finding) => finding.kind === 'duplicate-name')
  assert.equal(duplicates.length, 1, JSON.stringify(duplicates))
  assert.deepEqual(
    duplicates[0].paths.slice().sort(),
    [projectPath(f, 'Decisions/README.md'), projectPath(f, 'Docs/Readme.md')].sort(),
  )
  // The bootstrap skeleton names every hub `index.md`; identical names are by
  // design and must never be reported as a case-folded duplicate.
  assert.equal(
    duplicates.some((finding) => /index\.md$/.test(finding.message)),
    false,
  )
  await f.index.close()
})

test('broken frontmatter, a frontmatter gap and an expired review_after are reported', async (t) => {
  const f = await fixture(t)
  await writeNote(f, projectPath(f, 'Docs/损坏.md'), '---\ntitle: 未闭合\n正文\n')
  await writeNote(
    f,
    projectPath(f, 'Docs/缺口.md'),
    '---\ntype: doc\ntitle: "缺口"\nstatus: active\ncreated: 2026-01-01\nupdated: 2026-01-01\ntrust: agent\nharness: dsh\n---\n正文\n',
  )
  await writeMemory(
    f.binding,
    { type: 'doc', title: '过期条目', body: '正文\n', review_after: '2000-01-01' },
    { dataRoot: f.dataRoot, home: f.home },
  )

  const report = await lintOf(f)
  const kinds = kindsOf(report)
  assert.ok(kinds.has('broken-frontmatter'), JSON.stringify(report.findings))
  assert.ok(kinds.has('frontmatter-gap'), JSON.stringify(report.findings))
  const expired = report.findings.find((finding) => finding.kind === 'expired-review')
  assert.ok(expired, JSON.stringify(report.findings))
  assert.match(expired.message, /2000-01-01/)
  const gap = report.findings.find((finding) => finding.kind === 'frontmatter-gap')
  assert.match(gap.message, /id/)
  await f.index.close()
})

test('a pending backlog is reported from the queue, corrupt files included', async (t) => {
  const f = await fixture(t)
  await writeJobAtomic(f.queueRoot, jobDocument())
  await writeJobAtomic(
    f.queueRoot,
    jobDocument({ jobId: 'job-2', state: 'validated', attempts: 0 }),
  )
  await writeFile(join(f.queueRoot, 'job-3.json'), '{ not json')

  const report = await lintOf(f)
  const backlog = report.findings.find((finding) => finding.kind === 'pending-backlog')
  assert.ok(backlog, JSON.stringify(report.findings))
  assert.match(backlog.message, /job-1/)
  assert.equal(report.pending.jobs, 2)
  assert.equal(report.pending.failed, 1)
  assert.equal(report.pending.invalid, 1)
  await f.index.close()
})

test('a repository Markdown file with no vault link is reported and never moved', async (t) => {
  const f = await fixture(t)
  const repoDoc = join(f.repo, 'NOTES.md')
  await writeFile(repoDoc, '# 仓库文档\n\n没有任何 vault 笔记引用它。\n')
  // A subdirectory must be walked into, and its own directories must never be
  // reported as if they were Markdown files.
  await mkdir(join(f.repo, 'docs'), { recursive: true })
  await writeFile(join(f.repo, 'docs', 'guide.md'), '# 指南\n')
  const before = await hashTree(f.repo, { suffix: '.md' })

  const report = await lintOf(f)
  const unlinked = report.findings.filter((finding) => finding.kind === 'unlinked-repo-markdown')
  assert.deepEqual(unlinked.map((finding) => finding.path).sort(), ['NOTES.md', 'docs/guide.md'])
  assert.deepEqual(await hashTree(f.repo, { suffix: '.md' }), before)

  // A repository file a vault note links to by its stem is not reported.
  await writeNote(
    f,
    projectPath(f, 'Docs/已链接.md'),
    pluginNote({
      id: 'doc-77777777-7777-4777-8777-777777777777',
      title: '已链接',
      body: '见 [[NOTES]]。\n',
    }),
  )
  const second = await lintOf(f)
  assert.deepEqual(
    second.findings
      .filter((finding) => finding.kind === 'unlinked-repo-markdown')
      .map((finding) => finding.path),
    ['docs/guide.md'],
  )
  await f.index.close()
})

test('the default lint leaves every vault and repository byte untouched', async (t) => {
  const f = await fixture(t)
  await writeMemory(
    f.binding,
    { type: 'doc', title: '笔记', body: '正文\n' },
    { dataRoot: f.dataRoot, home: f.home },
  )
  await rm(join(f.vault, '_meta', 'user.md'))
  const vaultBefore = await hashTree(f.vault)
  const repoBefore = await hashTree(f.repo)

  const report = await lintOf(f)

  assert.deepEqual(await hashTree(f.vault), vaultBefore)
  assert.deepEqual(await hashTree(f.repo), repoBefore)
  assert.equal(report.readOnly, true)
  assert.equal(report.report.status, 'none')
  assert.equal(report.report.path, null)
  assert.deepEqual(report.ignoreGlobs, [])
  assert.deepEqual(report.safetyExclusions, [...SAFETY_EXCLUSIONS])
  await f.index.close()
})

test('the safety exclusions cannot be cancelled by user globs', async (t) => {
  const f = await fixture(t)
  // A note a user glob names, and a safety path no glob may unname.
  await writeNote(
    f,
    projectPath(f, 'Docs/忽略我.md'),
    pluginNote({ id: 'doc-88888888-8888-4888-8888-888888888888', title: '忽略我' }),
  )
  await writeNote(
    f,
    '_meta/.history/tx-1/0__泄露.md',
    pluginNote({ id: 'doc-99999999-9999-4999-8999-999999999999', title: '历史' }),
  )

  const ignored = await lintOf(f, { ignoreGlobs: ['**/忽略我.md'] })
  assert.equal(
    ignored.findings.some((finding) => finding.path.endsWith('忽略我.md')),
    false,
  )
  assert.equal(
    ignored.findings.some((finding) => finding.path.includes('.history')),
    false,
  )
  assert.deepEqual(ignored.ignoreGlobs, ['**/忽略我.md'])

  // A negation (or any other unsupported syntax) is refused at config validation
  // instead of silently mis-matching.
  for (const glob of [
    '!Projects/**',
    '[a]b.md',
    '{a,b}.md',
    '**/x@.md',
    'a\\b.md',
    '/absolute/**',
    '../escape/**',
    '',
  ]) {
    assert.throws(
      () => validateConfig({ ignoreGlobs: [glob] }),
      RangeError,
      `must refuse ${JSON.stringify(glob)}`,
    )
  }
  // The supported subset compiles, and a `.` stays a literal dot rather than
  // becoming a regular-expression wildcard.
  const matchers = compileIgnoreGlobs(['*.md', '**/scratch/**', 'a?c.md', 'Docs/忽略我.md'])
  assert.equal(matchers.length, 4)
  assert.equal(matchers[0].test('notes.md'), true)
  assert.equal(matchers[0].test('notesXmd'), false)
  assert.equal(matchers[1].test('a/b/scratch/c.md'), true)
  assert.equal(matchers[1].test('scratch/c.md'), true)
  assert.equal(matchers[2].test('abc.md'), true)
  assert.equal(matchers[2].test('ac.md'), false)
  await f.index.close()
})

// ---------------------------------------------------------------------------
// Step 3: the explicit report, retention, user.md
// ---------------------------------------------------------------------------

test('an explicit report request writes the dated report note once and is idempotent', async (t) => {
  const f = await fixture(t)
  const first = await lintOf(f, { report: true, now: new Date('2026-09-24T10:00:00Z') })
  assert.equal(first.report.status, 'written')
  const expected = lintReportRelativePath(new Date('2026-09-24T10:00:00Z'))
  assert.equal(expected, '_meta/Lint Report 2026-09-24.md')
  assert.equal(first.report.path, expected)
  const absolute = join(f.vault, ...expected.split('/'))
  const text = await readFile(absolute, 'utf8')
  assert.match(text, /<!-- obsidian-mem:generated begin sha256:[0-9a-f]{64} -->/)
  const declared = /sha256:([0-9a-f]{64})/.exec(text)[1]
  const body = text.slice(
    text.indexOf('-->\n') + 4,
    text.lastIndexOf('\n<!-- obsidian-mem:generated end -->'),
  )
  assert.equal(declared, sha256(body))
  const stat = await lstat(absolute)

  const second = await lintOf(f, { report: true, now: new Date('2026-09-24T11:00:00Z') })
  assert.equal(second.report.status, 'unchanged')
  // The note's generated area is exactly the report's own rendering.
  assert.ok(text.includes(renderLintReportBody(second)))
  assert.equal(await readFile(absolute, 'utf8'), text)
  assert.equal((await lstat(absolute)).mtimeMs, stat.mtimeMs)

  // A human edit inside the generated area stops the rewrite and is reported.
  await writeFile(
    absolute,
    text.replace(
      '<!-- obsidian-mem:generated end -->',
      '人类补充\n<!-- obsidian-mem:generated end -->',
    ),
  )
  const edited = await readFile(absolute, 'utf8')
  const third = await lintOf(f, { report: true, now: new Date('2026-09-25T10:00:00Z') })
  assert.equal(third.report.status, 'written')
  // A different date is a different note; today's edited note is left alone.
  assert.equal(await readFile(absolute, 'utf8'), edited)
  const fourth = await lintOf(f, { report: true, now: new Date('2026-09-24T12:00:00Z') })
  assert.equal(fourth.report.status, 'conflict')
  assert.equal(await readFile(absolute, 'utf8'), edited)
  await f.index.close()
})

test('an explicit report changes exactly one vault file and nothing else', async (t) => {
  const f = await fixture(t)
  await writeMemory(
    f.binding,
    { type: 'doc', title: '笔记', body: '正文\n' },
    { dataRoot: f.dataRoot, home: f.home },
  )
  const before = await hashTree(f.vault)

  const report = await lintOf(f, { report: true, now: new Date('2026-09-24T10:00:00Z') })
  const after = await hashTree(f.vault)
  const changed = [...new Set([...before.keys(), ...after.keys()])].filter(
    (path) => before.get(path) !== after.get(path),
  )
  assert.deepEqual(changed, [report.report.path], JSON.stringify(report.findings))
  assert.equal(report.report.status, 'written')
})

test('history retention prunes only old unprotected snapshots and spares a needs-manual-repair transaction', async (t) => {
  const f = await fixture(t)
  const history = join(f.vault, '_meta', '.history')
  const old = join(history, 'tx-old')
  const fresh = join(history, 'tx-fresh')
  const repair = join(history, 'tx-repair')
  for (const dir of [old, fresh, repair]) await mkdir(dir, { recursive: true })
  await writeFile(join(old, '0__note.md'), '# old snapshot\n')
  await writeFile(join(fresh, '0__note.md'), '# fresh snapshot\n')
  await writeFile(join(repair, '0__note.md'), '# repair snapshot\n')
  await writeFile(
    join(repair, 'manifest.json'),
    `${JSON.stringify({ schema: 1, txId: 'tx-repair', state: 'needs-manual-repair' })}\n`,
  )
  const longAgo = new Date(Date.now() - 400 * 24 * 3600_000)
  const recently = new Date(Date.now() - 3600_000)
  for (const target of [
    old,
    join(old, '0__note.md'),
    repair,
    join(repair, '0__note.md'),
    join(repair, 'manifest.json'),
  ]) {
    await utimes(target, longAgo, longAgo)
  }
  await utimes(fresh, recently, recently)
  await utimes(join(fresh, '0__note.md'), recently, recently)

  // The default pass only reports.
  const readOnly = await lintOf(f)
  assert.equal(readOnly.history.pruned.length, 0)
  assert.ok(readOnly.history.prunable >= 1)
  assert.equal(readOnly.history.needsRepair.includes('tx-repair'), true)
  assert.ok((await readdir(history)).includes('tx-old'))

  const pruned = await lintOf(f, { pruneHistory: true, historyPolicy: { keepCount: 5 } })
  const remaining = (await readdir(history)).sort()
  assert.deepEqual(remaining, ['tx-fresh', 'tx-repair'])
  assert.deepEqual(pruned.history.pruned, ['tx-old'])
  assert.equal(await readFile(join(repair, '0__note.md'), 'utf8'), '# repair snapshot\n')
  await f.index.close()
})

test('a live transaction manifest under the data root spares its history snapshots', async (t) => {
  const f = await fixture(t)
  const history = join(f.vault, '_meta', '.history', 'tx-live')
  await mkdir(history, { recursive: true })
  await writeFile(join(history, '0__note.md'), '# live snapshot\n')
  const longAgo = new Date(Date.now() - 400 * 24 * 3600_000)
  await utimes(history, longAgo, longAgo)
  await utimes(join(history, '0__note.md'), longAgo, longAgo)
  // The engine's own transaction store still owes work for this txId, so its
  // recovery material must survive even though there is no vault-side manifest.
  const identity = await vaultIdentity(f.binding, { home: f.home })
  const store = join(f.dataRoot, 'transactions', identity.vaultHash)
  await mkdir(store, { recursive: true })
  await writeFile(
    join(store, 'tx-live.json'),
    `${JSON.stringify({ schema: 1, txId: 'tx-live', state: 'prepared' })}\n`,
  )

  const report = await lintOf(f, { pruneHistory: true })
  assert.deepEqual(report.history.pruned, [])
  assert.equal(await readFile(join(history, '0__note.md'), 'utf8'), '# live snapshot\n')
  await f.index.close()
})

test('a prune waits for the whole-vault lock and never interleaves with a transaction', async (t) => {
  const f = await fixture(t)
  const historyRoot = join(f.vault, '_meta', '.history')
  const target = join(historyRoot, 'tx-old')
  await mkdir(target, { recursive: true })
  await writeFile(join(target, '0__note.md'), '# old snapshot\n')
  const longAgo = new Date(Date.now() - 400 * 24 * 3600_000)
  await utimes(target, longAgo, longAgo)
  await utimes(join(target, '0__note.md'), longAgo, longAgo)

  let prune = null
  let pruneSettled = false
  // Another writer holds the vault lock for the duration of this block, exactly
  // as an in-flight transaction does. The sweep must wait for it instead of
  // deleting anything it cannot see yet.
  await withVaultLock(
    f.binding,
    async () => {
      prune = lintOf(f, { pruneHistory: true }).then((value) => {
        pruneSettled = true
        return value
      })
      await new Promise((resolve) => setTimeout(resolve, 200))
      assert.equal(pruneSettled, false, 'the prune must wait for the vault lock')
      assert.equal((await lstat(target)).isDirectory(), true, 'a locked vault keeps its history')
    },
    { dataRoot: f.dataRoot, home: f.home },
  )

  const report = await prune
  assert.deepEqual(report.history.pruned, ['tx-old'], 'the sweep runs once the lock is free')
  await assert.rejects(lstat(target), { code: 'ENOENT' })
  await f.index.close()
})

test('a prune that cannot take the lock deletes nothing and says so', async (t) => {
  const f = await fixture(t)
  const historyRoot = join(f.vault, '_meta', '.history')
  const target = join(historyRoot, 'tx-old')
  await mkdir(target, { recursive: true })
  await writeFile(join(target, '0__note.md'), '# old snapshot\n')
  const longAgo = new Date(Date.now() - 400 * 24 * 3600_000)
  await utimes(target, longAgo, longAgo)
  await utimes(join(target, '0__note.md'), longAgo, longAgo)

  const blocked = await withVaultLock(
    f.binding,
    () => lintOf(f, { pruneHistory: true, pruneLockTimeoutMs: 60 }),
    { dataRoot: f.dataRoot, home: f.home },
  )
  assert.deepEqual(blocked.history.pruned, [])
  assert.equal((await lstat(target)).isDirectory(), true)
  assert.equal(
    blocked.findings.some((finding) => finding.kind === 'history-prune-blocked'),
    true,
    JSON.stringify(blocked.findings),
  )
  await f.index.close()
})

test('a prune refuses to run while the vault still owes manual repair', async (t) => {
  const f = await fixture(t)
  const historyRoot = join(f.vault, '_meta', '.history')
  const target = join(historyRoot, 'tx-old')
  await mkdir(target, { recursive: true })
  await writeFile(join(target, '0__note.md'), '# old snapshot\n')
  const longAgo = new Date(Date.now() - 400 * 24 * 3600_000)
  await utimes(target, longAgo, longAgo)
  await utimes(join(target, '0__note.md'), longAgo, longAgo)
  // The engine's own store still holds an unresolved transaction, so no vault
  // mutation may proceed until a human resolves it.
  const identity = await vaultIdentity(f.binding, { home: f.home })
  const store = join(f.dataRoot, 'transactions', identity.vaultHash)
  await mkdir(store, { recursive: true })
  await writeFile(
    join(store, 'tx-broken.json'),
    `${JSON.stringify({
      schema: 1,
      txId: 'tx-broken',
      vaultHash: identity.vaultHash,
      state: 'needs-manual-repair',
      steps: { prepared: true },
      targets: [],
    })}\n`,
  )

  const report = await lintOf(f, { pruneHistory: true })
  assert.deepEqual(report.history.pruned, [], 'nothing is deleted while recovery is required')
  assert.equal((await readdir(historyRoot)).includes('tx-old'), true)
  assert.equal(
    report.findings.some((finding) => finding.kind === 'history-prune-blocked'),
    true,
    JSON.stringify(report.findings),
  )
  await f.index.close()
})

test('oversized history is a finding, and the retention policy is reported', async (t) => {
  const f = await fixture(t)
  const history = join(f.vault, '_meta', '.history')
  const big = join(history, 'tx-big')
  await mkdir(big, { recursive: true })
  await writeFile(join(big, '0__note.md'), 'x'.repeat(4096))
  const report = await lintOf(f, {
    historyPolicy: { oversizeBytes: 1024, oversizedSnapshotBytes: 1024 },
  })
  const oversized = report.findings.filter((finding) => finding.kind === 'history-oversized')
  assert.deepEqual(
    oversized.map((finding) => finding.path).sort(),
    ['_meta/.history', '_meta/.history/tx-big/0__note.md'],
    JSON.stringify(report.findings),
  )
  assert.equal(report.history.policy.keepCount, HISTORY_POLICY.keepCount)
  assert.equal(report.history.policy.oversizeBytes, 1024)
  await f.index.close()
})

test('_meta/user.md is created once by bootstrap and never rewritten', async (t) => {
  const f = await fixture(t)
  const userFile = join(f.vault, '_meta', 'user.md')
  const created = await readFile(userFile, 'utf8')
  assert.match(created, /^---\n/)
  const stat = await lstat(userFile)

  const again = await bootstrapVault(f.binding, {
    initGitOnCreate: false,
    home: f.home,
    dataRoot: f.dataRoot,
  })
  assert.equal(again.createdPaths.includes('_meta/user.md'), false)
  assert.equal(again.existingPaths.includes('_meta/user.md'), true)
  assert.equal(await readFile(userFile, 'utf8'), created)
  assert.equal((await lstat(userFile)).mtimeMs, stat.mtimeMs)

  // A hand-written file is the user's; two more runs leave it byte-identical.
  const mine = '---\ntags: [preferences]\n---\n\n我偏好中文回答。\n'
  await writeFile(userFile, mine)
  const mineStat = await lstat(userFile)
  await bootstrapVault(f.binding, { initGitOnCreate: false, home: f.home, dataRoot: f.dataRoot })
  await bootstrapVault(f.binding, { initGitOnCreate: false, home: f.home, dataRoot: f.dataRoot })
  assert.equal(await readFile(userFile, 'utf8'), mine)
  assert.equal((await lstat(userFile)).mtimeMs, mineStat.mtimeMs)
  await f.index.close()
})

// ---------------------------------------------------------------------------
// Step 3: bind modes, promote, jobs and the weekly hint
// ---------------------------------------------------------------------------

test('bind mode local mints a pointer in a non-git directory and bootstraps it', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'obsidian-mem-t17-local-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 4 }))
  const vault = join(root, 'vault')
  const scratch = join(root, 'scratch')
  const home = join(root, 'home')
  const dataRoot = join(root, 'data')
  await mkdir(vault, { recursive: true })
  await mkdir(home, { recursive: true })
  await mkdir(scratch, { recursive: true })

  const shown = await resolveBinding({ cwd: scratch, vaultRoot: vault, mode: 'show', home })
  assert.equal(shown.kind, 'unbound')
  assert.equal(shown.reason, 'no-git-root')

  const bound = await resolveBinding({ cwd: scratch, vaultRoot: vault, mode: 'local', home })
  assert.equal(bound.kind, 'bound', JSON.stringify(bound))
  const pointer = JSON.parse(await readFile(join(scratch, '.obsidian-mem'), 'utf8'))
  assert.deepEqual(Object.keys(pointer).sort(), ['displayName', 'projectId', 'schema', 'slug'])
  assert.equal(pointer.projectId, bound.projectId)

  const boot = await bootstrapVault(bound, { initGitOnCreate: false, home, dataRoot })
  assert.equal(boot.registryUpdated, true)
  assert.ok(boot.createdPaths.includes('_meta/user.md'))
})

test('bind mode fork mints a new id, swaps the pointer and never moves the old project', async (t) => {
  const f = await fixture(t, { projectId: OLD_ID })
  await writeMemory(
    f.binding,
    { type: 'doc', title: '旧项目笔记', body: '旧内容\n' },
    { dataRoot: f.dataRoot, home: f.home },
  )
  const oldTree = await hashTree(join(f.vault, ...f.binding.relativeDir.split('/')))
  const oldId = f.binding.projectId

  const forked = await resolveBinding({
    cwd: f.repo,
    vaultRoot: f.vault,
    mode: 'fork',
    home: f.home,
  })
  assert.equal(forked.kind, 'bound', JSON.stringify(forked))
  assert.notEqual(forked.projectId, oldId)
  assert.equal(forked.previousProjectId, oldId)
  assert.equal(forked.pointerReplaced, true)
  assert.equal(forked.relativeDir, `Projects/repo--${forked.projectId.slice(0, 8)}`)
  const pointer = JSON.parse(await readFile(join(f.repo, '.obsidian-mem'), 'utf8'))
  assert.equal(pointer.projectId, forked.projectId)

  // The old project's content is exactly where it was, byte for byte.
  assert.deepEqual(await hashTree(join(f.vault, ...f.binding.relativeDir.split('/'))), oldTree)

  const boot = await bootstrapVault(forked, {
    initGitOnCreate: false,
    home: f.home,
    dataRoot: f.dataRoot,
  })
  assert.equal(boot.registryUpdated, true)
  await writeMemory(
    forked,
    { type: 'doc', title: '新项目笔记', body: '新内容\n' },
    { dataRoot: f.dataRoot, home: f.home },
  )
  // The old project is still exactly as it was, and the new one never inherited it.
  assert.deepEqual(await hashTree(join(f.vault, ...f.binding.relativeDir.split('/'))), oldTree)
  const newTree = await hashTree(join(f.vault, ...forked.relativeDir.split('/')))
  assert.equal(
    [...newTree.keys()].some((path) => path.includes('旧项目笔记')),
    false,
  )
  assert.equal(
    [...newTree.keys()].some((path) => path.includes('新项目笔记')),
    true,
  )
  assert.equal([...newTree.keys()].includes('index.md'), true)

  // A repository with no pointer has nothing to fork away from.
  const root = await mkdtemp(join(tmpdir(), 'obsidian-mem-t17-fork-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 4 }))
  const bare = join(root, 'repo')
  await initRepo(bare)
  const refused = await resolveBinding({
    cwd: bare,
    vaultRoot: f.vault,
    mode: 'fork',
    home: f.home,
  })
  assert.equal(refused.kind, 'conflict')
  assert.equal(refused.reason, 'no-pointer')
  await assert.rejects(lstat(join(bare, '.obsidian-mem')), { code: 'ENOENT' })
  await f.index.close()
})

test('bind mode retain updates only the confirmed remote hint', async (t) => {
  const f = await fixture(t)
  await git(f.repo, ['remote', 'add', 'origin', 'https://example.invalid/demo.git'])
  const retained = await resolveBinding({
    cwd: f.repo,
    vaultRoot: f.vault,
    mode: 'retain',
    home: f.home,
    dataRoot: f.dataRoot,
  })
  assert.equal(retained.kind, 'bound', JSON.stringify(retained))
  assert.equal(retained.retained, true)
  assert.equal(retained.remote, 'https://example.invalid/demo')
  const registry = await readFile(join(f.vault, '_meta', 'registry.md'), 'utf8')
  assert.match(registry, /https:\/\/example\.invalid\/demo/)
  const declared = /sha256:([0-9a-f]{64})/.exec(registry)[1]
  const body = registry.slice(
    registry.indexOf('-->\n') + 4,
    registry.indexOf('<!-- obsidian-mem:registry end -->'),
  )
  assert.equal(declared, sha256(body))

  const stat = await lstat(join(f.vault, '_meta', 'registry.md'))
  const again = await resolveBinding({
    cwd: f.repo,
    vaultRoot: f.vault,
    mode: 'retain',
    home: f.home,
    dataRoot: f.dataRoot,
  })
  assert.equal(again.retained, false)
  assert.equal((await lstat(join(f.vault, '_meta', 'registry.md'))).mtimeMs, stat.mtimeMs)

  // `retain` writes the shared registry, so it must be told where the vault lock lives.
  await assert.rejects(
    resolveBinding({ cwd: f.repo, vaultRoot: f.vault, mode: 'retain', home: f.home }),
    RangeError,
  )

  // A registry whose generated region no longer matches its declared hash is a
  // refusal, never a rewrite: the R24 guard is what keeps a human edit safe.
  const registryPath = join(f.vault, '_meta', 'registry.md')
  const original = await readFile(registryPath, 'utf8')
  // Edit a cell *inside* the generated region: the table still parses, but its
  // declared sha256 no longer describes its body.
  const tampered = original.replace('| demo |', '| 人类改名 |')
  assert.notEqual(tampered, original)
  await writeFile(registryPath, tampered)
  await git(f.repo, ['remote', 'set-url', 'origin', 'https://example.invalid/moved.git'])
  const refused = await resolveBinding({
    cwd: f.repo,
    vaultRoot: f.vault,
    mode: 'retain',
    home: f.home,
    dataRoot: f.dataRoot,
  })
  assert.equal(refused.kind, 'conflict')
  assert.equal(refused.reason, 'registry-hash-mismatch')
  assert.equal(await readFile(registryPath, 'utf8'), tampered)
  await f.index.close()
})

// The refusal path of `retain` had no test, and the missing test is the only
// reason the defect survived: the catch block names `TransactionError`, but
// `lib/vault.js` only *re-exports* that class — a re-export never puts the name
// in this module's scope. So whenever the registry transaction failed for a
// reason that was not a `BootstrapError`, the `||` short-circuit did not save
// it and the caller got a `ReferenceError` where the documented refusal was
// promised. Reproduced with a real unresolved transaction: a fault-injected
// write to the project index, then an external edit to that same file, which is
// the state `reconcile` refuses to resolve on its own.
test('a retain whose registry transaction cannot run refuses instead of naming an unbound error', async (t) => {
  const f = await fixture(t)
  await git(f.repo, ['remote', 'add', 'origin', 'https://example.invalid/demo.git'])

  const indexRelative = projectPath(f, 'index.md')
  const indexPath = join(f.vault, ...indexRelative.split('/'))
  const before = await readFile(indexPath, 'utf8')
  await assert.rejects(
    runTransaction(
      f.binding,
      {
        txId: newTransactionId(),
        updates: [
          { path: indexRelative, hash: sha256(before), contents: `${before}\n注入后未完成\n` },
        ],
      },
      { dataRoot: f.dataRoot, home: f.home, failAfter: 'old-status' },
    ),
    { code: 'injected-failure' },
  )
  // The human edits the same note in Obsidian before recovery runs. That edit is
  // what turns a resumable transaction into one a human owes a decision on.
  const external = `${before}\n外部编辑\n`
  await writeFile(indexPath, external)

  const refused = await resolveBinding({
    cwd: f.repo,
    vaultRoot: f.vault,
    mode: 'retain',
    home: f.home,
    dataRoot: f.dataRoot,
  })
  assert.equal(refused.kind, 'conflict', JSON.stringify(refused))
  assert.equal(refused.reason, 'recovery-required')
  assert.match(refused.message, /unresolved transaction/)
  // The refusal reports the conflict; it never touches the file the human owns.
  assert.equal(await readFile(indexPath, 'utf8'), external)
  await f.index.close()
})

test('promote creates a Methods note that links its source and never moves the source', async (t) => {
  const f = await fixture(t)
  const source = projectPath(f, 'Conventions/本地约定.md')
  await writeNote(
    f,
    source,
    pluginNote({
      id: 'con-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      type: 'convention',
      title: '本地约定',
      body: '只在项目内成立。\n',
    }),
  )
  const before = await readFile(join(f.vault, ...source.split('/')))

  const promoted = await promoteNote(
    f.binding,
    { path: source },
    { dataRoot: f.dataRoot, home: f.home },
  )
  assert.equal(promoted.source, source)
  assert.equal(promoted.moved, false)
  assert.match(promoted.path, /^Methods\//)
  const method = await readFile(join(f.vault, ...promoted.path.split('/')), 'utf8')
  assert.match(method, /type: "method"|type: method/)
  assert.ok(method.includes(`[[${source.replace(/\.md$/, '')}|本地约定]]`), method)
  assert.ok(method.includes('只在项目内成立。'))
  // The original is byte-identical and still in place.
  assert.deepEqual(await readFile(join(f.vault, ...source.split('/'))), before)

  // A second promotion of the same note is a second note, never an overwrite.
  const again = await promoteNote(
    f.binding,
    { path: source },
    { dataRoot: f.dataRoot, home: f.home },
  )
  assert.notEqual(again.path, promoted.path)

  // A source that is not there is the documented `note-not-found`, not a generic
  // error from somewhere inside the reader.
  const missing = await promoteNote(
    f.binding,
    { path: projectPath(f, 'Docs/不存在.md') },
    { dataRoot: f.dataRoot, home: f.home },
  ).then(
    () => null,
    (error) => error,
  )
  assert.equal(missing?.name, 'MemoryError', String(missing))
  assert.equal(missing?.code, 'note-not-found')

  // A path outside the vault is refused by the jail, and nothing is created.
  await assert.rejects(
    promoteNote(f.binding, { path: '../outside.md' }, { dataRoot: f.dataRoot, home: f.home }),
    /vault|path/i,
  )
  // A source already in `Methods/` is refused rather than promoted again.
  await assert.rejects(
    promoteNote(f.binding, { path: promoted.path }, { dataRoot: f.dataRoot, home: f.home }),
    (error) => error?.code === 'already-method',
  )
  await f.index.close()
})

test('jobs lists the queue and retries only on an explicit request', async (t) => {
  const f = await fixture(t)
  await writeJobAtomic(f.queueRoot, jobDocument())
  const config = validateConfig({ vaultPath: f.vault })
  /** Every wake-up the services asked the queue worker for, in order. */
  const kicks = []
  const services = createMemoryServices({
    config,
    dataRoot: f.dataRoot,
    cwd: f.repo,
    home: f.home,
    binding: f.binding,
    kickQueueWorker: () => kicks.push('kick'),
  })
  t.after(() => services.close())

  const listed = await services.admin({ action: 'jobs', retry: false })
  assert.equal(listed.action, 'jobs')
  assert.equal(listed.result.status, 'listed')
  assert.deepEqual(
    listed.result.jobs.map((job) => job.jobId),
    ['job-1'],
  )
  assert.equal(listed.result.failed, 1)
  assert.equal(listed.result.jobs[0].state, 'failed')
  assert.equal(listed.result.jobs[0].attempts, 3)
  assert.equal(listed.result.jobs[0].lastError, 'MISSING_CREDENTIAL')

  // The queue stores the reason as an object — `{code, message, at}` — because all
  // three are useful to a reader of the job file, while the tool schema declares
  // one string. A failed job whose reason the listing hides is the one thing this
  // action exists for, so both stored shapes have to come out as that string.
  await writeJobAtomic(
    f.queueRoot,
    jobDocument({
      jobId: 'job-2',
      lastError: {
        code: 'too-many-items',
        message: 'too-many-items: the model returned 15 items, beyond distill.maxItems=12',
        at: '2026-09-25T09:45:27.499Z',
      },
    }),
  )
  const withObject = await services.admin({ action: 'jobs', retry: false })
  const second = withObject.result.jobs.find((job) => job.jobId === 'job-2')
  assert.equal(second.state, 'failed')
  assert.equal(
    second.lastError,
    'too-many-items: the model returned 15 items, beyond distill.maxItems=12',
    'the code a stored message already carries is reported once, not twice',
  )
  assert.equal(withObject.result.failed, 2)

  const untouched = await readPendingJobs(f.queueRoot)
  assert.equal(untouched.jobs[0].state, 'failed')
  // Both listings above are reads: neither may have woken the worker.
  assert.deepEqual(kicks, [])

  const retried = await services.admin({ action: 'jobs', jobId: 'job-1', retry: true })
  assert.equal(retried.result.status, 'retried')
  assert.equal(retried.result.jobs[0].state, 'pending')
  assert.equal(retried.result.jobs[0].attempts, 0)
  // A revived job is due immediately, but nothing else would wake the worker: a
  // pass arms its next timer only while work is waiting, so the explicit retry is
  // the one caller that has to ask for a pass — and it asks exactly once.
  assert.deepEqual(kicks, ['kick'])

  // Retrying a job that did not exhaust its attempts is refused, not silently reset.
  const refused = await services.admin({ action: 'jobs', jobId: 'job-1', retry: true })
  assert.equal(refused.result.status, 'refused')
  assert.match(refused.result.message, /retry-not-failed/)
  assert.deepEqual(kicks, ['kick'], 'a refused retry wakes nothing')

  const missing = await services.admin({ action: 'jobs', jobId: 'nope', retry: true })
  assert.equal(missing.result.status, 'refused')
  assert.deepEqual(kicks, ['kick'], 'a retry that named no job wakes nothing')

  // A value that is not a function is refused where it is supplied, not at the
  // first retry — the one moment it would otherwise matter.
  assert.throws(
    () =>
      createMemoryServices({
        config,
        dataRoot: f.dataRoot,
        cwd: f.repo,
        home: f.home,
        kickQueueWorker: 'nope',
      }),
    /kickQueueWorker/,
  )
})

test('the weekly hint is due only when the last report is older than seven days', async (t) => {
  const f = await fixture(t)
  // A vault that does not exist yet has nothing to inspect and must stay quiet.
  const absent = await weeklyLintHint({
    vaultPath: join(f.root, 'no-vault-yet'),
    home: f.home,
    now: new Date(),
  })
  assert.equal(absent.due, false)
  assert.equal(absent.text, '')

  const fresh = await weeklyLintHint({ vaultPath: f.vault, home: f.home, now: new Date() })
  assert.equal(fresh.due, true)
  assert.equal(fresh.lastLintAt, null)

  await lintOf(f, { report: true, now: new Date() })
  const afterReport = await weeklyLintHint({ vaultPath: f.vault, home: f.home, now: new Date() })
  assert.equal(afterReport.due, false)
  assert.equal(typeof afterReport.lastLintAt, 'string')
  assert.equal(afterReport.text, '')

  const later = await weeklyLintHint({
    vaultPath: f.vault,
    home: f.home,
    now: new Date(Date.now() + 8 * 24 * 3600_000),
  })
  assert.equal(later.due, true)
  assert.match(later.text, /lint/)
  assert.ok([...later.text].length <= 300)
  await f.index.close()
})

test('the weekly hint rides the first pre-step of a session, exactly once', async (t) => {
  const ctx = new Context()
  let asked = 0
  const disposers = registerHooks(ctx, {
    // An unbound repository: the hint must still arrive, because the vault's
    // maintenance state is a property of the configured vault, not of one repo.
    resolveBinding: async () => ({ kind: 'unbound', reason: 'no-pointer' }),
    index: async () => ({ waitReady: async () => ({ ready: true }) }),
    buildBrief: async () => {
      throw new Error('an unbound project must never reach buildBrief')
    },
    config: { injectBrief: true, briefBudgetChars: 6000 },
    lintHint: async () => {
      asked += 1
      return { due: true, text: '记忆体检提醒：建议运行 mem_admin(action="lint", report=true)。' }
    },
  })
  t.after(async () => {
    for (const dispose of disposers) await dispose()
  })

  const agent = { session: { header: { id: 'sess-hint', cwd: '/tmp/example' } } }
  ctx.emit('agent/session-start', { agent, source: 'startup' })
  const preStep = () =>
    ctx.waterfall(
      'agent/pre-step',
      { agent, messages: [], turn: 1, step: 1, signal: new AbortController().signal },
      async () => ({ kind: 'enter', messages: [] }),
    )

  const first = await preStep()
  const injected = (first.messages ?? []).filter(
    (message) => message?.source?.kind === RECALL_SOURCE.kind,
  )
  assert.equal(injected.length, 1, JSON.stringify(first.messages))
  assert.match(injected[0].content[0].text, /体检提醒/)
  const second = await preStep()
  assert.equal(
    (second.messages ?? []).length,
    0,
    'the hint is a session-start reminder, never a repeated one',
  )
  assert.equal(asked, 1, 'the seam is asked at most once per session')

  // The hint shares the session's one brief budget: a first request must never
  // carry the recall plus a reminder whose sum exceeds it.
  const shared = new Context()
  let sharedAsked = 0
  const briefText = 'B'.repeat(40)
  const hintText = 'H'.repeat(40)
  const sharedDisposers = registerHooks(shared, {
    resolveBinding: async () => ({
      kind: 'bound',
      projectId: ID1,
      slug: 'demo',
      displayName: 'demo',
      relativeDir: 'Projects/demo--1c392abb',
    }),
    index: async () => ({ waitReady: async () => ({ ready: true }) }),
    buildBrief: async () => ({
      text: briefText,
      charCount: briefText.length,
      hotHash: null,
      hotItems: [],
      indexState: { status: 'ready', reason: null, backend: 'scan', notes: 0, scanning: false },
      truncated: false,
      omitted: 0,
    }),
    // Exactly the room the brief alone fits in: the reminder must be dropped.
    config: { injectBrief: true, briefBudgetChars: briefText.length + hintText.length - 1 },
    lintHint: async () => {
      sharedAsked += 1
      return { due: true, text: hintText }
    },
  })
  t.after(async () => {
    for (const dispose of sharedDisposers) await dispose()
  })
  const sharedAgent = { session: { header: { id: 'sess-shared', cwd: '/tmp/example' } } }
  const sharedDecision = await shared.waterfall(
    'agent/pre-step',
    { agent: sharedAgent, messages: [], turn: 1, step: 1, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [] }),
  )
  assert.equal(sharedAsked, 1)
  const sharedMessages = (sharedDecision.messages ?? []).filter(
    (message) => message?.source?.kind === RECALL_SOURCE.kind,
  )
  assert.deepEqual(
    sharedMessages.map((message) => message.content[0].text),
    [briefText],
    'the brief keeps the budget; the hint is dropped',
  )

  // A session whose hint is not due stays silent, and a throwing seam never
  // breaks the decision.
  const quiet = new Context()
  const quietDisposers = registerHooks(quiet, {
    resolveBinding: async () => ({ kind: 'unbound', reason: 'no-pointer' }),
    index: async () => ({ waitReady: async () => ({ ready: true }) }),
    buildBrief: async () => {
      throw new Error('unbound')
    },
    config: { injectBrief: true, briefBudgetChars: 6000 },
    lintHint: async () => {
      throw new Error('vault unreadable')
    },
  })
  t.after(async () => {
    for (const dispose of quietDisposers) await dispose()
  })
  const other = { session: { header: { id: 'sess-quiet', cwd: '/tmp/example' } } }
  const decision = await quiet.waterfall(
    'agent/pre-step',
    { agent: other, messages: [], turn: 1, step: 1, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [] }),
  )
  assert.equal(decision.messages.length, 0)
})

test('an unreadable history or queue degrades to a finding instead of failing the lint', async (t) => {
  const f = await fixture(t)
  // A read that fails for a reason other than ENOENT (a permission error, an I/O
  // error) must not turn a read-only inspection into a crash. A file where a
  // directory is expected reaches the same code path.
  const historyRoot = join(f.vault, '_meta', '.history')
  await rm(historyRoot, { recursive: true, force: true })
  await writeFile(historyRoot, 'not a directory\n')
  await mkdir(f.dataRoot, { recursive: true })
  await writeFile(f.queueRoot, 'not a directory\n')

  const report = await lintOf(f)
  assert.equal(
    report.findings.some((finding) => finding.kind === 'history-unreadable'),
    true,
    JSON.stringify(report.findings),
  )
  assert.equal(
    report.findings.some((finding) => finding.kind === 'pending-unreadable'),
    true,
    JSON.stringify(report.findings),
  )
  assert.deepEqual(report.history.pruned, [])
  assert.equal(report.pending.known, false)
  await f.index.close()
})

test('an unreadable repository subdirectory degrades the audit to a finding', async (t) => {
  const f = await fixture(t)
  const blocked = join(f.repo, 'blocked-docs')
  await mkdir(blocked, { recursive: true })
  await writeFile(join(blocked, 'guide.md'), '# guide\n')
  await chmod(blocked, 0o000)
  try {
    const report = await lintOf(f)
    assert.equal(
      report.findings.some((finding) => finding.kind === 'repository-unreadable'),
      true,
      JSON.stringify(report.findings),
    )
    assert.equal(report.repository.known, false)
  } finally {
    await chmod(blocked, 0o755)
  }
  await f.index.close()
})

test('lint ignores symlinked notes instead of following them out of the vault', async (t) => {
  const f = await fixture(t)
  const outside = join(f.root, 'outside.md')
  await writeFile(
    outside,
    pluginNote({ id: 'doc-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', title: '外面' }),
  )
  await symlink(outside, join(f.vault, ...projectPath(f, 'Docs/链接.md').split('/')))
  const report = await lintOf(f)
  assert.equal(
    report.findings.some((finding) => finding.path.endsWith('链接.md')),
    false,
  )
  assert.equal(
    await readFile(outside, 'utf8'),
    pluginNote({ id: 'doc-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', title: '外面' }),
  )
  await f.index.close()
})

test('no case in this file writes the real plugin data root', async (t) => {
  const real = join(homedir(), '.dsh', 'data', 'obsidian-mem')
  const snapshot = async () => {
    try {
      return (await readdir(real)).sort()
    } catch (error) {
      if (error.code === 'ENOENT') return 'absent'
      throw error
    }
  }
  const before = await snapshot()
  const f = await fixture(t)
  await lintOf(f)
  await lintOf(f, { report: true })
  await f.index.close()
  assert.deepEqual(await snapshot(), before, 'the real plugin data root must be untouched')
})
