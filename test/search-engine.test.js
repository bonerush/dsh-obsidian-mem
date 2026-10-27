// Task 3 Phase B: the deterministic sparse retrieval engine, wired into
// `searchNotes` behind `retrievalEngine: 'sparse'`.
//
// These cases run against REAL throwaway vaults and the REAL sqlite index, so the
// sparse path is measured through the same seam `mem_search` uses: a real
// `openIndex()` object, real source files re-read and hash-verified, real lexical
// candidates. Nothing here touches a real vault, a real `~/.dsh` or the network.
//
// What this file pins, and why:
//
//   * the DEFAULT engine is byte-for-byte the pre-v0.4 lexical result — the plan's
//     global constraint, asserted by comparing against a direct `index.search`;
//   * sparse reranks a BOUNDED candidate set (24 lexical sources, 256 source-verified
//     chunks of at most 1,200 code points) instead of inventing candidates;
//   * the two orders are fused by RRF k=60, ties are broken by an exact title/alias
//     match and then deterministically by path — never by input order;
//   * a stale or missing source falls back to the lexical order instead of ranking
//     bytes the plugin cannot verify;
//   * the tool-level search (the Lead-owned `services.js` seam) follows the
//     configured engine, so the config value reaches `mem_search` and not only a
//     direct `searchNotes` call;
//   * the measurement case prints grouped Recall@3 / MRR@3 / false injection and
//     p50/p95 for both engines on ONE fixed local fixture. Semantic retrieval is
//     NOT measured: no provider is selected, so that claim stays unverified.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { test } from 'node:test'

import { validateConfig } from '../lib/config.js'
import { indexText, openIndex } from '../lib/index-db.js'
import { SPARSE_MAX_CHUNK_CHARS, SPARSE_MAX_RECORDS } from '../lib/retrieval-rank.js'
import {
  RETRIEVAL_ENGINES,
  SPARSE_FALLBACK_REASONS,
  SPARSE_MAX_SOURCES,
  chunkNoteText,
  resolveScope,
  searchNotes,
} from '../lib/search.js'
import { createMemoryServices } from '../lib/services.js'

/** The one project every fixture note belongs to. */
const PROJECT_ID = '7d1f2c3b-4a5e-4f60-8b71-9c2d3e4f5a6b'
const PROJECT_SLUG = 't3'
const PROJECT_DIR = `Projects/${PROJECT_SLUG}--${PROJECT_ID.slice(0, 8)}`

/** Vault-relative path of a note whose project-relative path is `relative`. */
const projectPath = (relative) => `${PROJECT_DIR}/${relative}`

/** Render one note as the Markdown the index parses. */
function renderNote(note) {
  const frontmatter = [
    '---',
    `type: "${note.type ?? 'doc'}"`,
    `title: ${JSON.stringify(note.title)}`,
    `status: "${note.status ?? 'active'}"`,
    `project: "${PROJECT_ID}"`,
  ]
  if (note.updated !== undefined) frontmatter.push(`updated: "${note.updated}"`)
  if (note.aliases !== undefined) {
    frontmatter.push(`aliases: [${note.aliases.map((alias) => JSON.stringify(alias)).join(', ')}]`)
  }
  frontmatter.push('---')
  return [...frontmatter, '', `# ${note.title}`, '', note.body, ''].join('\n')
}

/** A throwaway vault with the given notes, plus its open index and data root. */
async function makeVault(t, notes, indexOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), 'obsidian-mem-t3-sparse-'))
  const vault = join(root, 'vault')
  const dataRoot = join(root, 'data')
  await mkdir(dataRoot, { recursive: true })
  for (const note of notes) {
    const absolute = join(vault, ...projectPath(note.path).split('/'))
    await mkdir(dirname(absolute), { recursive: true })
    await writeFile(absolute, note.source ?? renderNote(note))
  }
  const index = await openIndex({
    vaultRoot: vault,
    dataRoot,
    backend: 'sqlite',
    projectId: PROJECT_ID,
    ...indexOptions,
  })
  t.after(async () => {
    await index.close().catch(() => {})
    await rm(root, { recursive: true, force: true })
  })
  const ready = await index.waitReady(undefined, 10_000)
  assert.equal(ready.ready, true, `index did not become ready: ${JSON.stringify(ready)}`)
  return { root, vault, dataRoot, index }
}

/** The paths of a hit list, in returned order. */
const hitPaths = (hits) => hits.map((hit) => hit.path)

// ---------------------------------------------------------------------------
// The default engine
// ---------------------------------------------------------------------------

test('the default lexical engine returns exactly the index result it returned before Phase B', async (t) => {
  const { index } = await makeVault(t, [
    { path: 'Docs/cache.md', title: '缓存失效', body: '缓存失效按内容哈希判断。' },
    { path: 'Docs/retry.md', title: '重试策略', body: '失败重试要指数退避。' },
    { path: 'Pitfalls/deadlock.md', title: '调度器死锁', body: '调度器死锁要重试。' },
  ])
  const options = { query: '缓存失效', limit: 2 }
  const implicit = await searchNotes(index, options)
  const explicit = await searchNotes(index, { ...options, engine: 'lexical' })
  // The exact call the pre-v0.4 path made, with the same resolved filters.
  const direct = await index.search({
    query: options.query,
    filters: resolveScope({
      scope: 'project',
      boundProjectId: index.boundProjectId,
    }),
    limit: options.limit,
  })
  assert.deepEqual(explicit, direct)
  assert.deepEqual(implicit, direct)
  assert.equal(implicit.truncated, direct.truncated)
  assert.equal(implicit.truncationReason, direct.truncationReason)
  assert.equal(implicit.rowsExamined, direct.rowsExamined)
  // The lexical result carries no sparse bookkeeping at all.
  assert.equal(implicit.retrievalEngine, undefined)
  assert.equal(implicit.sparseFallback, undefined)
})

test('the engine enum is closed and an unknown engine is refused before the index is touched', async () => {
  assert.deepEqual(RETRIEVAL_ENGINES, ['lexical', 'sparse'])
  const untouched = {
    waitReady() {
      throw new Error('the ready barrier must not run for a rejected engine')
    },
    search() {
      throw new Error('the index must not run for a rejected engine')
    },
  }
  for (const engine of ['semantic', 'hybrid', 'Lexical', '', true, null, 7]) {
    await assert.rejects(searchNotes(untouched, { query: '缓存', engine }), (error) => {
      assert.ok(error instanceof RangeError, `expected RangeError for ${JSON.stringify(engine)}`)
      assert.match(error.message, /engine/)
      return true
    })
  }
})

test('the tool-level search follows the configured retrievalEngine', async (t) => {
  // `services.js` is Lead-owned, so this is the tool-level half of the wiring:
  // the same vault and query through two service sets, one with the default config
  // and one with `retrievalEngine: 'sparse'`, must follow `config.retrievalEngine`.
  const { vault, dataRoot } = await makeVault(t, [
    // Lexical order is [A, B, C]; the fused order is [B, A, C] — see the RRF case.
    { path: 'Docs/retry.md', title: '重试', body: '重试一次。' },
    {
      path: 'Conventions/retry-convention.md',
      title: '重试约定',
      body: '重试 '.repeat(20).trim(),
      type: 'convention',
    },
    { path: 'Docs/retry-log.md', title: '重试记录', body: '重试 '.repeat(9).trim() },
  ])
  const openServices = (retrievalEngine) =>
    createMemoryServices({
      config: validateConfig({ vaultPath: vault, retrievalEngine }),
      dataRoot,
      // A bound project is passed directly, so the case needs no Git repo, no
      // `.obsidian-mem` pointer and no write: the services resolve it as bound.
      binding: { kind: 'bound', projectId: PROJECT_ID },
    })
  const lexicalServices = openServices('lexical')
  const sparseServices = openServices('sparse')
  t.after(async () => {
    await lexicalServices.close()
    await sparseServices.close()
  })
  const lexical = await lexicalServices.search({ query: '重试', limit: 3 }, undefined, {})
  const sparse = await sparseServices.search({ query: '重试', limit: 3 }, undefined, {})
  assert.deepEqual(
    lexical.map((hit) => hit.path),
    [
      projectPath('Docs/retry.md'),
      projectPath('Conventions/retry-convention.md'),
      projectPath('Docs/retry-log.md'),
    ],
  )
  assert.deepEqual(
    sparse.map((hit) => hit.path),
    [
      projectPath('Conventions/retry-convention.md'),
      projectPath('Docs/retry.md'),
      projectPath('Docs/retry-log.md'),
    ],
  )
})

// ---------------------------------------------------------------------------
// The bounded candidate set and deterministic fusion
// ---------------------------------------------------------------------------

test('sparse reranks a bounded candidate set, never invents candidates and is deterministic', async (t) => {
  // 26 notes all mention the query term; the sparse engine may still only look at
  // the first SPARSE_MAX_SOURCES lexical candidates.
  const notes = Array.from({ length: 26 }, (_, position) => ({
    path: `Docs/note-${String(position).padStart(2, '0')}.md`,
    title: `重试笔记 ${position}`,
    body: `重试第 ${position} 条说明：重试要受控。${'重试 '.repeat(position % 4)}`,
  }))
  const { index } = await makeVault(t, notes)
  const first = await searchNotes(index, { query: '重试', engine: 'sparse', limit: 5 })
  const second = await searchNotes(index, { query: '重试', engine: 'sparse', limit: 5 })
  assert.equal(first.length, 5)
  assert.deepEqual(hitPaths(first), hitPaths(second))
  assert.equal(first.retrievalEngine, 'sparse')
  assert.equal(first.sparseSources, SPARSE_MAX_SOURCES)
  assert.ok(first.sparseRecords <= SPARSE_MAX_RECORDS)

  // The lexical candidate retrieval must ask for the bounded 24, not for 5.
  const calls = []
  const probing = {
    ...index,
    search: async (searchOptions) => {
      calls.push(searchOptions)
      return index.search(searchOptions)
    },
  }
  await searchNotes(probing, { query: '重试', engine: 'sparse', limit: 3 })
  assert.equal(calls.length, 1, 'the sparse path must run one lexical candidate search')
  assert.equal(calls[0].limit, SPARSE_MAX_SOURCES)

  // Every returned sparse hit was already a lexical candidate.
  const lexical = await searchNotes(index, { query: '重试', limit: SPARSE_MAX_SOURCES })
  const lexicalPaths = new Set(hitPaths(lexical))
  for (const hit of first) assert.ok(lexicalPaths.has(hit.path), `${hit.path} was invented`)
})

test('RRF k=60 fuses the two orders so a candidate both retrievers agree on wins', async (t) => {
  const { index } = await makeVault(t, [
    // A wins lexically through the exact-title boost; sparse likes B's raw frequency.
    { path: 'Docs/retry.md', title: '重试', body: '重试一次。' },
    {
      path: 'Conventions/retry-convention.md',
      title: '重试约定',
      body: '重试 重试 重试 重试 重试 重试 重试 重试 重试 重试 重试 重试 重试 重试 重试 重试 重试 重试 重试 重试',
      type: 'convention',
    },
    {
      path: 'Docs/retry-log.md',
      title: '重试记录',
      body: '重试 重试 重试 重试 重试 重试 重试 重试 重试',
    },
  ])
  const lexical = await searchNotes(index, { query: '重试', limit: 3 })
  const sparse = await searchNotes(index, { query: '重试', engine: 'sparse', limit: 3 })
  const lexicalOrder = hitPaths(lexical)
  const sparseOrder = hitPaths(sparse)
  // The engines disagree, which is what makes the fusion observable.
  assert.notDeepEqual(lexicalOrder, sparseOrder)
  // B, C, A is the RRF order: B is rank 1 in sparse and rank 2 lexically, while
  // A is rank 1 lexically and last in sparse.
  assert.deepEqual(sparseOrder, [
    projectPath('Conventions/retry-convention.md'),
    projectPath('Docs/retry.md'),
    projectPath('Docs/retry-log.md'),
  ])
  // A fused hit keeps its lexical score but explains the sparse contribution.
  const promoted = sparse.find((hit) => hit.path === projectPath('Docs/retry.md'))
  assert.equal(promoted.signals.retrievalEngine, 'sparse')
  assert.equal(typeof promoted.signals.fusedScore, 'number')
  assert.equal(typeof promoted.signals.sparseScore, 'number')
})

test('an exact title or alias match decides an RRF tie deterministically', async (t) => {
  // Lexical puts A first (title match / type weight); sparse puts B first (raw
  // term frequency), so the two RRF scores tie. The tie-break is the documented
  // exact title/alias equality, never the path (B's path sorts first here).
  const exactTitle = await makeVault(t, [
    { path: 'Docs/retry.md', title: '重试', body: '重试一次。' },
    {
      path: 'Conventions/retry-convention.md',
      title: '重试约定',
      body: '重试 '.repeat(20).trim(),
      type: 'convention',
    },
  ])
  const byTitle = await searchNotes(exactTitle.index, { query: '重试', engine: 'sparse', limit: 2 })
  assert.deepEqual(hitPaths(byTitle), [
    projectPath('Docs/retry.md'),
    projectPath('Conventions/retry-convention.md'),
  ])
  assert.equal(byTitle[0].signals.sparseRank, 2)
  assert.equal(byTitle[0].signals.lexicalRank, 1)

  const exactAlias = await makeVault(t, [
    {
      path: 'Docs/retry-alias.md',
      title: '重试说明',
      aliases: ['重试'],
      body: '重试一次。',
      type: 'decision',
    },
    {
      path: 'Conventions/retry-big.md',
      title: '重试约定',
      body: '重试 '.repeat(20).trim(),
      type: 'convention',
    },
  ])
  const byAlias = await searchNotes(exactAlias.index, { query: '重试', engine: 'sparse', limit: 2 })
  assert.deepEqual(hitPaths(byAlias), [
    projectPath('Docs/retry-alias.md'),
    projectPath('Conventions/retry-big.md'),
  ])

  // With no exact name on either side the same tie falls to the deterministic
  // path order (Conventions sorts before Docs).
  const neither = await makeVault(t, [
    { path: 'Docs/retry-decision.md', title: '重试决策', body: '重试一次。', type: 'decision' },
    {
      path: 'Conventions/retry-convention.md',
      title: '重试约定',
      body: '重试 '.repeat(20).trim(),
      type: 'convention',
    },
  ])
  const byPath = await searchNotes(neither.index, { query: '重试', engine: 'sparse', limit: 2 })
  assert.deepEqual(hitPaths(byPath), [
    projectPath('Conventions/retry-convention.md'),
    projectPath('Docs/retry-decision.md'),
  ])
})

// ---------------------------------------------------------------------------
// Tokenisation and the honest fallbacks
// ---------------------------------------------------------------------------

test('CJK bigrams and Latin case folding survive the sparse path', async (t) => {
  const { index } = await makeVault(t, [
    {
      path: 'Docs/pluggable.md',
      title: '可插拔调度',
      body: '可插拔调度器按固定窗口执行，慢任务顺延。',
    },
    {
      path: 'Docs/scheduler.md',
      title: 'Scheduler Notes',
      body: 'The scheduler retries with backoff and jitter.',
    },
    { path: 'Pitfalls/cache.md', title: '缓存失效', body: '缓存失效按内容哈希。', type: 'gotcha' },
  ])
  const cjk = await searchNotes(index, { query: '可插拔调度', engine: 'sparse', limit: 3 })
  assert.equal(cjk[0].path, projectPath('Docs/pluggable.md'))
  assert.equal(cjk.retrievalEngine, 'sparse')
  assert.equal(cjk.sparseFallback, null)

  // The index lowercases Latin runs; the sparse query stream must do the same.
  const latin = await searchNotes(index, { query: 'SCHEDULER', engine: 'sparse', limit: 3 })
  assert.ok(
    hitPaths(latin).includes(projectPath('Docs/scheduler.md')),
    'case-folded latin query did not reach the sparse ranking',
  )

  // A lone CJK character is the index's substring branch and has no sparse term
  // at all, so the honest answer is the lexical order, reported as a fallback.
  const lone = await searchNotes(index, { query: '器', engine: 'sparse', limit: 3 })
  const lexical = await searchNotes(index, { query: '器', limit: 3 })
  assert.deepEqual(hitPaths(lone), hitPaths(lexical))
  assert.equal(lone.sparseFallback, 'no-sparse-terms')
})

test('a stale or missing source falls back to the lexical order instead of ranking unverified bytes', async (t) => {
  const { vault, index } = await makeVault(t, [
    { path: 'Docs/cache.md', title: '缓存失效', body: '缓存失效按内容哈希判断。' },
    { path: 'Docs/retry.md', title: '重试策略', body: '失败重试要指数退避。' },
  ])
  const query = '缓存失效'
  const lexical = await searchNotes(index, { query, limit: 2 })
  // A source changed between the lexical search and the sparse re-read: the
  // cached hit hash no longer matches the bytes on disk.
  const staleHits = lexical.map((hit) => ({ ...hit, hash: '0'.repeat(64) }))
  const stale = { ...index, search: async () => staleHits }
  const staleResult = await searchNotes(stale, { query, engine: 'sparse', limit: 2 })
  assert.deepEqual(hitPaths(staleResult), hitPaths(lexical))
  assert.equal(staleResult.retrievalEngine, 'sparse')
  assert.equal(staleResult.sparseFallback, 'no-source-verified-candidates')
  assert.equal(staleResult.sparseVerified, 0)

  // And the missing-source half: the index still serves its cached hits while the
  // vault is gone, so no candidate can be source-verified.
  await rm(vault, { recursive: true, force: true })
  const missing = { ...index, search: async () => lexical }
  const missingResult = await searchNotes(missing, { query, engine: 'sparse', limit: 2 })
  assert.deepEqual(hitPaths(missingResult), hitPaths(lexical))
  assert.equal(missingResult.sparseFallback, 'no-source-verified-candidates')
  assert.deepEqual([...SPARSE_FALLBACK_REASONS].sort(), [
    'no-lexical-candidates',
    'no-source-verified-candidates',
    'no-sparse-terms',
    'vault-root-unavailable',
  ])
})

// ---------------------------------------------------------------------------
// The chunk and record bounds
// ---------------------------------------------------------------------------

test('chunkNoteText keeps every code point and never exceeds 1,200 code points', () => {
  const dense = '重'.repeat(3000)
  const source = `标题\n${dense}`
  const chunks = chunkNoteText(source)
  assert.ok(chunks.length >= 3)
  for (const chunk of chunks) assert.ok([...chunk].length <= SPARSE_MAX_CHUNK_CHARS)
  assert.equal(chunks.join('').replace(/\s+/gu, ''), source.replace(/\s+/gu, ''))

  // A text made of words is cut at a whitespace boundary where one exists, so a
  // Latin token is not split across two records. The boundary whitespace stays at
  // the end of the earlier chunk (that is what makes the split lossless).
  const words = '重试 word '.repeat(400).trim()
  const wordChunks = chunkNoteText(words)
  for (const [position, chunk] of wordChunks.entries()) {
    assert.ok([...chunk].length <= SPARSE_MAX_CHUNK_CHARS)
    if (position < wordChunks.length - 1) assert.match(chunk, /\s$/u)
  }
  assert.equal(wordChunks.join('').replace(/\s+/gu, ''), words.replace(/\s+/gu, ''))

  assert.deepEqual(chunkNoteText('   \n\n  '), [])
})

test('the source-verified record budget bounds one sparse ranking', async (t) => {
  // 24 long notes produce far more than 256 chunks; the round-robin selection
  // must stop exactly at the ranker's bound rather than growing with vault size.
  const longBody = '重试 缓存 '.repeat(3000).trim()
  const notes = Array.from({ length: 24 }, (_, position) => ({
    path: `Docs/long-${String(position).padStart(2, '0')}.md`,
    title: `长笔记 ${position}`,
    body: `${longBody}`,
  }))
  const { index } = await makeVault(t, notes)
  const hits = await searchNotes(index, { query: '重试', engine: 'sparse', limit: 3 })
  assert.equal(hits.sparseSources, SPARSE_MAX_SOURCES)
  assert.equal(hits.sparseRecords, SPARSE_MAX_RECORDS)
  assert.equal(hits.length, 3)
})

// ---------------------------------------------------------------------------
// Measurement: one fixed fixture, grouped Recall@3 / MRR@3, false injection,
// p50/p95. This is the evidence behind docs/validation/retrieval-sparse-*.md.
// ---------------------------------------------------------------------------

/**
 * The fixed measurement fixture: 20 notes about this plugin's own subject
 * matter, in one project. Kept here — rather than in `test/fixtures/` — because
 * the same array feeds both the focused cases and the measurement, so the two
 * cannot drift.
 */
const MEASUREMENT_NOTES = [
  {
    path: 'Docs/retry-backoff.md',
    title: '重试退避',
    body: '失败重试要指数退避，首次等待 200 毫秒，上限 30 秒。重试超过三次应放弃。',
  },
  {
    path: 'Decisions/retry-idempotent.md',
    title: '重试必须幂等',
    type: 'decision',
    body: '重试必须幂等：写入前检查交易号，重复请求直接返回上次结果。',
  },
  {
    path: 'Pitfalls/cache-hash.md',
    title: '缓存失效按内容哈希',
    type: 'gotcha',
    body: '缓存失效按内容哈希判断，不按时间。文件内容变了哈希就变，缓存必须重算。',
  },
  {
    path: 'Conventions/hot-capacity.md',
    title: '热点文件容量',
    type: 'convention',
    body: '热点文件超过 9000 字符必须压缩，归档只取已完成条目。',
  },
  {
    path: 'Docs/scheduler-window.md',
    title: '调度器窗口',
    body: '调度器使用固定窗口，慢任务进入下一次调度。',
  },
  {
    path: 'Docs/cache-size.md',
    title: '缓存大小',
    body: '缓存默认上限 100 MiB，超过就淘汰最旧条目，淘汰顺序按写入时间。',
  },
  {
    path: 'Conventions/hash-naming.md',
    title: '文件名使用内容哈希',
    type: 'convention',
    body: '笔记文件名使用内容哈希前缀，重命名不改哈希。',
  },
  {
    path: 'Docs/panel-render.md',
    title: '面板重绘',
    body: '面板重绘使用 requestAnimationFrame，切换标签时保持滚动位置。',
  },
  {
    path: 'Conventions/panel-focus.md',
    title: '面板命中区域',
    type: 'convention',
    body: '面板焦点必须在 40 像素以上的命中区域，Tab 顺序跟随视觉顺序。',
  },
  {
    path: 'Decisions/index-backend.md',
    title: '索引后端默认 sqlite',
    type: 'decision',
    body: '索引后端默认 sqlite，不可用时退回扫描。',
  },
  {
    path: 'Conventions/vault-binding.md',
    title: '绑定指针只在仓库根',
    type: 'convention',
    body: '绑定指针只在仓库根，身份用 projectId，不跟随工作目录。',
  },
  {
    path: 'Pitfalls/journal-recovery.md',
    title: '事务中断后按日志恢复',
    type: 'gotcha',
    body: '事务中断后按日志恢复，回执缺失时重放，不覆盖已提交内容。',
  },
  {
    path: 'Docs/token-budget.md',
    title: '提示词预算',
    body: '提示词预算 6000 字符，热点区最多 9000 字符，超出就分页。',
  },
  {
    path: 'Decisions/distill-route.md',
    title: '蒸馏必须显式配置',
    type: 'decision',
    body: '蒸馏必须显式配置 provider 和 model，缺失就禁用，不推断凭据。',
  },
  {
    path: 'Conventions/config-unknown.md',
    title: '未知配置键直接拒绝',
    type: 'convention',
    body: '未知配置键直接拒绝，不静默用默认值，避免写错路径。',
  },
  {
    path: 'Docs/panel-search.md',
    title: '面板搜索框',
    body: '面板搜索框按回车执行，结果显示路径和摘要。',
  },
  {
    path: 'Docs/graph-render.md',
    title: '图谱渲染',
    body: '图谱渲染用 Canvas，节点超过 240 个时裁剪，避免掉帧。',
  },
  {
    path: 'Conventions/habit-clause.md',
    title: '用户习惯只在明确陈述时记录',
    type: 'convention',
    body: '用户习惯只在明确陈述时记录，推测出来的不写入，避免编造偏好。',
  },
  {
    path: 'Docs/delivery-receipt.md',
    title: '投递回执',
    body: '投递回执记录实际发出的 id，未确认不算送达，重发要有上限。',
  },
  {
    path: 'Methods/backoff-method.md',
    title: 'Methods 退避策略',
    type: 'method',
    body: '退避策略：首次 200 毫秒，随后翻倍，直到 30 秒上限。',
  },
  // A type-weighted distractor: a fresh `decision` that repeats the common query term
  // but says nothing about the rare one. The lexical composite score rates it first;
  // the sparse reranker's IDF weighting prefers the doc that mentions both terms.
  {
    path: 'Decisions/retry-policy.md',
    title: '重试决策',
    type: 'decision',
    updated: '2026-10-26',
    body: '重试 重试 重试 重试 重试 重试 重试 重试 重试 重试。',
  },
  // A note about the rare term only, so the sparse list is not a two-item swap.
  {
    path: 'Docs/jitter-sample.md',
    title: '抖动采样',
    body: '客户端抖动检测每秒采样，抖动越大越要降速；抖动采样写入日志，抖动超过阈值就告警。',
  },
  // The dev-group target for the "重试 抖动" query: both terms, no metadata boost.
  {
    path: 'Docs/backoff-jitter.md',
    title: '退避抖动',
    body: '指数退避要加抖动，抖动取随机值，避免所有客户端同时重试；抖动上限不超过退避间隔的一半。',
  },
]

/**
 * The 11 measurement queries in three groups.
 *
 * `development` is the lexical-friendly half (query terms appear verbatim in the
 * target note, with distractors sharing one term). `paraphrase` is HELD OUT: the
 * query is phrased with synonyms and shares at most one generic token with the
 * target, so it is the group a purely lexical retriever should not improve on.
 * `distractor` queries have NO correct answer in the fixture — they measure how
 * many notes each engine injects anyway.
 */
const MEASUREMENT_QUERIES = [
  { group: 'development', query: '指数退避', target: 'Docs/retry-backoff.md' },
  { group: 'development', query: '内容哈希 缓存', target: 'Pitfalls/cache-hash.md' },
  { group: 'development', query: '热点文件 压缩', target: 'Conventions/hot-capacity.md' },
  { group: 'development', query: '幂等 重试', target: 'Decisions/retry-idempotent.md' },
  { group: 'development', query: '重试 抖动', target: 'Docs/backoff-jitter.md' },
  { group: 'paraphrase', query: '错误反复出现时暂停多久', target: 'Docs/retry-backoff.md' },
  {
    group: 'paraphrase',
    query: '写操作提交两次会不会执行两遍',
    target: 'Decisions/retry-idempotent.md',
  },
  { group: 'paraphrase', query: '页面刷新时如何避免跳动', target: 'Docs/panel-render.md' },
  {
    group: 'paraphrase',
    query: '长时间不用之后体积怎么缩小',
    target: 'Conventions/hot-capacity.md',
  },
  { group: 'distractor', query: '缓存目录放在哪个磁盘分区', target: null },
  { group: 'distractor', query: '调度器的端口号是多少', target: null },
]

/** Aggregate Recall@3 / MRR@3 / false injection@3 per group. */
function groupedMetrics(results) {
  const groups = new Map()
  for (const item of MEASUREMENT_QUERIES) {
    const paths = results.get(item.query)
    const group = groups.get(item.group) ?? {
      queries: 0,
      targeted: 0,
      recall: 0,
      mrr: 0,
      injected: 0,
    }
    group.queries += 1
    const top = paths.slice(0, 3)
    if (item.target === null) {
      group.injected += top.length
    } else {
      group.targeted += 1
      const expected = projectPath(item.target)
      const rank = top.indexOf(expected) + 1
      if (rank > 0) {
        group.recall += 1
        group.mrr += 1 / rank
      }
      group.injected += top.filter((path) => path !== expected).length
    }
    groups.set(item.group, group)
  }
  return groups
}

/** p50/p95 of a list of durations, in milliseconds with 2 decimals. */
function percentiles(durations) {
  const sorted = [...durations].sort((left, right) => left - right)
  const at = (fraction) => sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]
  return {
    p50: Number(at(0.5).toFixed(2)),
    p95: Number(at(0.95).toFixed(2)),
  }
}

test('measurement: lexical vs sparse grouped quality on the fixed local fixture', async (t) => {
  const { index } = await makeVault(t, MEASUREMENT_NOTES)
  const limit = 3
  const results = { lexical: new Map(), sparse: new Map() }
  for (const engine of RETRIEVAL_ENGINES) {
    for (const item of MEASUREMENT_QUERIES) {
      const hits = await searchNotes(index, { query: item.query, engine, limit })
      results[engine].set(item.query, hitPaths(hits))
      if (engine === 'sparse') {
        // A held-out paraphrase may share no token with any note at all; an empty
        // lexical candidate set is then the honest reason for the fallback. Any
        // other fallback would mean the measurement silently ranked lexical.
        const lexicalEmpty = results.lexical.get(item.query).length === 0
        assert.ok(
          hits.sparseFallback === null ||
            (lexicalEmpty && hits.sparseFallback === 'no-lexical-candidates'),
          `sparse fell back for ${item.query}: ${hits.sparseFallback}`,
        )
      }
    }
  }
  // Determinism: the same fixture and query produce the same order twice.
  for (const item of MEASUREMENT_QUERIES) {
    const again = await searchNotes(index, { query: item.query, engine: 'sparse', limit })
    assert.deepEqual(hitPaths(again), results.sparse.get(item.query))
  }

  // Warm latency, 11 repetitions per query and engine (121 samples each).
  const durations = { lexical: [], sparse: [] }
  for (const engine of RETRIEVAL_ENGINES) {
    for (const item of MEASUREMENT_QUERIES) {
      for (let repetition = 0; repetition < 11; repetition += 1) {
        const started = performance.now()
        await searchNotes(index, { query: item.query, engine, limit })
        durations[engine].push(performance.now() - started)
      }
    }
  }

  const metrics = {
    lexical: groupedMetrics(results.lexical),
    sparse: groupedMetrics(results.sparse),
  }
  const lines = [
    'measurement: fixed local fixture, 11 queries, limit=3, engine=sparse|lexical',
    'group        engine   Recall@3  MRR@3   false-injection@3  (queries)',
  ]
  for (const groupName of ['development', 'paraphrase', 'distractor']) {
    for (const engine of RETRIEVAL_ENGINES) {
      const group = metrics[engine].get(groupName)
      const recall = group.targeted === 0 ? 'n/a' : (group.recall / group.targeted).toFixed(3)
      const mrr = group.targeted === 0 ? 'n/a' : (group.mrr / group.targeted).toFixed(3)
      lines.push(
        `${groupName.padEnd(12)} ${engine.padEnd(8)} ${String(recall).padEnd(9)} ${String(mrr).padEnd(8)} ${(group.injected / group.queries).toFixed(3).padEnd(19)} (${group.queries})`,
      )
    }
  }
  for (const engine of RETRIEVAL_ENGINES) {
    const latency = percentiles(durations[engine])
    lines.push(
      `latency      ${engine.padEnd(8)} p50=${latency.p50}ms p95=${latency.p95}ms (n=${durations[engine].length})`,
    )
  }
  // Held-out purity: how many index tokens a paraphrase query shares with its
  // target's own title/body. A purely lexical retriever can only find a target it
  // shares a token with, so this is what makes "no synonym gain" auditable.
  for (const item of MEASUREMENT_QUERIES) {
    if (item.group !== 'paraphrase') continue
    const target = MEASUREMENT_NOTES.find((note) => note.path === item.target)
    const targetTokens = new Set(indexText(`${target.title}\n${target.body}`))
    const shared = [...new Set(indexText(item.query))].filter((token) => targetTokens.has(token))
    lines.push(
      `held-out-overlap ${JSON.stringify(item.query)} shared-tokens=${shared.length} ${JSON.stringify(shared)}`,
    )
  }
  // Per-query orders, so the record can show exactly where the two engines differ
  // instead of only their aggregated scores.
  for (const item of MEASUREMENT_QUERIES) {
    const short = (paths) => paths.map((path) => path.slice(PROJECT_DIR.length + 1)).join(' > ')
    lines.push(`query ${item.group.padEnd(12)} ${JSON.stringify(item.query)}`)
    lines.push(`  lexical: ${short(results.lexical.get(item.query))}`)
    lines.push(`  sparse : ${short(results.sparse.get(item.query))}`)
  }
  lines.push(
    'semantic: UNVERIFIED — no embedding/rerank provider is configured; no network or model was called.',
  )
  for (const line of lines) {
    t.diagnostic(line)
    console.log(line)
  }

  // The acceptance rule from the spec: no grouped relevance regression versus
  // lexical, and no extra false injection for the queries with no right answer.
  for (const groupName of ['development', 'paraphrase']) {
    assert.ok(
      metrics.sparse.get(groupName).recall >= metrics.lexical.get(groupName).recall,
      `sparse lost Recall@3 on the ${groupName} group`,
    )
    assert.ok(
      metrics.sparse.get(groupName).mrr >= metrics.lexical.get(groupName).mrr - 1e-9,
      `sparse lost MRR@3 on the ${groupName} group`,
    )
  }
  assert.ok(
    metrics.sparse.get('distractor').injected <= metrics.lexical.get('distractor').injected,
    'sparse injected more notes for unanswerable queries than lexical',
  )
})
