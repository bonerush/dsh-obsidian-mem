// Task 9: the rebuildable search index and safe retrieval.
//
// Every case runs against a REAL throwaway vault (a byte-for-byte copy of
// `test/fixtures/search/corpus/`) and a REAL throwaway data root, so the index,
// its quarantine path and its file layout under test are the production ones.
// Nothing here reads or writes the user's real `~/.dsh`; the one case that
// exercises the production `resolveDataRoot()` derivation points `DSH_HOME` at a
// temporary directory first and restores it afterwards.
//
// The corpus is fixed and self-describing (`corpus.json` names the role of every
// file), because this task's whole point is that the SQLite and scan backends
// must agree on filtering and that the first hits must be explainable.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { getEventListeners } from 'node:events'
import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  IndexError,
  MAX_NOTE_BYTES,
  MAX_QUERY_TOKENS,
  buildMatchQuery,
  indexFilePath,
  indexText,
  isIndexableRelativePath,
  openIndex,
  planQuery,
} from '../lib/index-db.js'
import { readNote, searchNotes } from '../lib/search.js'
import { newTransactionId, runTransaction } from '../lib/vault.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(HERE, 'fixtures', 'search')
const CORPUS_ROOT = join(FIXTURES, 'corpus')
const CORPUS = JSON.parse(await readFile(join(FIXTURES, 'corpus.json'), 'utf8'))

const ALPHA = CORPUS.projects.alpha.projectId
const BETA = CORPUS.projects.beta.projectId
const ALPHA_DIR = CORPUS.projects.alpha.dir
const BETA_DIR = CORPUS.projects.beta.dir
const N = CORPUS.notes
const Q = CORPUS.queries
const E = CORPUS.expected

/** `node:sqlite` is a hard requirement of the SQLite backend only; the scan backend must work without it. */
const HAS_SQLITE = await (async () => {
  try {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(':memory:')
    db.exec("CREATE VIRTUAL TABLE probe USING fts5(x)")
    db.close()
    return true
  } catch {
    return false
  }
})()

const at = (vault, relative) => join(vault, ...relative.split('/'))
const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const paths = (hits) => hits.map((hit) => hit.path)
const sorted = (hits) => paths(hits).slice().sort()

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

/**
 * A throwaway vault (the corpus, copied) plus a throwaway data root.
 *
 * `open` registers every index it hands out, so one `after` hook closes them all
 * before deleting the temporary tree.
 */
async function harness(t) {
  const root = await mkdtemp(join(tmpdir(), 'obsidian-mem-t9-'))
  const vault = join(root, 'vault')
  const dataRoot = join(root, 'data')
  await cp(CORPUS_ROOT, vault, { recursive: true })
  await mkdir(dataRoot, { recursive: true })
  const indexes = []
  t.after(async () => {
    for (const index of indexes) await index.close().catch(() => {})
    await rm(root, { recursive: true, force: true })
  })
  const open = async (options = {}) => {
    const index = await openIndex({ vaultRoot: vault, dataRoot, backend: 'sqlite', projectId: ALPHA, ...options })
    indexes.push(index)
    return index
  }
  return { root, vault, dataRoot, open }
}

/** Wait for the ready barrier and fail loudly with the returned status. */
async function ready(index, timeoutMs = 10_000) {
  const status = await index.waitReady(undefined, timeoutMs)
  assert.equal(status.ready, true, `index did not become ready: ${JSON.stringify(status)}`)
  return status
}

/** A second project used by the bound/paging regressions; its vault is built in-test. */
const PAGED_ID = '2b3c4d5e-6f70-4182-9a3b-4c5d6e7f8091'
const PAGED_DIR = `项目/paged--${PAGED_ID.slice(0, 8)}`
/**
 * The path-order prefix of the paging vault. `文档/sub/*` sorts before
 * `文档/zzz-shallow.md`, while the *scan* inserts the shallow file first — so a
 * rowid/unordered read and a path-ordered read return different first rows.
 */
const PAGED_DEEP_FIRST = `${PAGED_DIR}/文档/sub/aaa-deep.md`
const PAGED_DEEP_LAST = `${PAGED_DIR}/文档/sub/ddd-deep.md`
const PAGED_SHALLOW = `${PAGED_DIR}/文档/zzz-shallow.md`

/**
 * Build the paging vault: five active notes, `器` in the path-first and
 * path-fourth notes only, and an insertion order that differs from path order.
 */
async function pagedHarness(t, indexOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), 'obsidian-mem-t9-paged-'))
  const vault = join(root, 'vault')
  const dataRoot = join(root, 'data')
  await mkdir(join(vault, PAGED_DIR, '文档', 'sub'), { recursive: true })
  const note = (title, body) => `---
type: "doc"
title: "${title}"
status: "active"
project: "${PAGED_ID}"
---
# ${title}

${body}
`
  await writeFile(at(vault, PAGED_SHALLOW), note('浅层', '浅层的普通说明。'))
  await writeFile(at(vault, PAGED_DEEP_FIRST), note('首个', '第一个深层的说明，含 器 字。'))
  await writeFile(at(vault, `${PAGED_DIR}/文档/sub/bbb-deep.md`), note('第二', '第二个深层的说明。'))
  await writeFile(at(vault, `${PAGED_DIR}/文档/sub/ccc-deep.md`), note('第三', '第三个深层的说明。'))
  await writeFile(at(vault, PAGED_DEEP_LAST), note('第四', '第四个深层的说明，亦含 器 字。'))
  const index = await openIndex({ vaultRoot: vault, dataRoot, backend: 'sqlite', projectId: PAGED_ID, ...indexOptions })
  t.after(async () => {
    await index.close().catch(() => {})
    await rm(root, { recursive: true, force: true })
  })
  return { root, vault, dataRoot, index, open: (options) => openIndex({ vaultRoot: vault, dataRoot, backend: 'sqlite', projectId: PAGED_ID, ...options }) }
}

/** The human-readable reasons a hit sorted where it did (spec §7 "可解释的排序信号"). */
function reasons(hit) {
  const s = hit.signals
  return [
    s.titleExact && 'title-exact',
    s.titleContains && 'title-contains',
    s.phraseContains && 'phrase',
    s.substringMatch && 'substring',
    s.tokenHits > 0 && `tokens:${s.tokenHits}`,
    s.history && 'history',
    s.typeWeight > 0 && `type:${s.typeWeight}`,
  ].filter(Boolean)
}

// ---------------------------------------------------------------------------
// Step 1: the fixed corpus, its location contract and the ready barrier
// ---------------------------------------------------------------------------

test('the fixed corpus is complete and the index lives under the data root, never in the vault', async (t) => {
  const h = await harness(t)
  for (const relative of [...Object.values(N), ...Object.values(CORPUS.excluded)]) {
    assert.ok(await exists(at(h.vault, relative)), `corpus is missing ${relative}`)
  }

  const index = await h.open()
  await ready(index)
  const expected = join(h.dataRoot, 'index', `index-${sha256(await realpath(h.vault))}.db`)
  assert.equal(index.status().dbPath, expected)
  assert.equal(await indexFilePath(h.vault, h.dataRoot), expected)
  assert.equal(await exists(join(h.vault, 'index')), false, 'the vault must not learn the index exists')
  assert.ok(!(await readdir(h.vault)).includes('index'))
  // The vault is also untouched byte-wise: a scan never writes to it.
  assert.equal(await readFile(at(h.vault, N.user), 'utf8'), await readFile(at(CORPUS_ROOT, N.user), 'utf8'))
})

test('the first scan yields in batches; a timed-out waitReady is an explicit not-ready, never an empty result', async (t) => {
  const h = await harness(t)
  let yields = 0
  const index = await h.open({
    yieldToEventLoop: async () => { yields += 1; await delay(5) },
    batchSize: 3,
  })
  let ticks = 0
  const timer = setInterval(() => { ticks += 1 }, 1)
  let early
  try {
    early = await index.waitReady(undefined, 1)
    await ready(index)
  } finally {
    clearInterval(timer)
  }
  assert.equal(early.ready, false, 'a 1ms timeout cannot have finished a batched first scan')
  assert.match(String(early.reason), /not-ready|scan/i)
  assert.equal(early.backend, 'sqlite')
  assert.ok(early.reason.length > 0, 'the not-ready status must say why')
  assert.ok(yields >= 2, `the first scan must yield in batches (yields=${yields})`)
  assert.ok(ticks > 0, 'the host event loop must have run while the first scan was in progress')
  assert.equal(index.status().ready, true)
})

test('production derives the index root from DSH_HOME and never from the vault', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'obsidian-mem-t9-home-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const vault = join(home, 'vault')
  await cp(CORPUS_ROOT, vault, { recursive: true })
  const index = await openIndex({ vaultRoot: vault, backend: 'sqlite', projectId: ALPHA })
  t.after(async () => {
    await index.close().catch(() => {})
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  })
  await ready(index)
  const expected = join(home, 'data', 'obsidian-mem', 'index', `index-${sha256(await realpath(vault))}.db`)
  assert.equal(index.status().dbPath, expected)
  assert.ok(existsSync(expected))
})

test('a data root inside the vault is refused', async (t) => {
  const h = await harness(t)
  await assert.rejects(
    () => openIndex({ vaultRoot: h.vault, dataRoot: join(h.vault, 'cache'), backend: 'sqlite', projectId: ALPHA }),
    (error) => error instanceof IndexError && error.code === 'index-inside-vault',
  )
})

// ---------------------------------------------------------------------------
// Step 4: retrieval semantics on the fixed corpus
// ---------------------------------------------------------------------------

test('project scope returns the explainable first hits and excludes history by default', async (t) => {
  const h = await harness(t)
  const index = await h.open()
  await ready(index)

  const hits = await searchNotes(index, { query: Q.threeCharCjk, scope: 'project', projectId: ALPHA, limit: 8 })
  assert.equal(hits[0].projectId, ALPHA)
  assert.equal(hits[0].path, N.alphaExactTitle, 'the exact title match must win')
  assert.equal(hits.some((hit) => hit.status === 'superseded'), false)
  assert.equal(hits.some((hit) => hit.status === 'archived'), false)
  assert.equal(hits.length, E.projectScopeThreeChar.length)
  assert.deepEqual(sorted(hits), [...E.projectScopeThreeChar].sort())
  for (const [i, hit] of hits.entries()) {
    if (i > 0) assert.ok(hits[i - 1].score >= hit.score, 'hits must be ordered by non-increasing score')
    assert.ok(reasons(hit).length > 0, `hit ${hit.path} has no explanation`)
    // Attribution is the frontmatter id when it exists and the project directory
    // (which is the authoritative location) when the frontmatter does not parse.
    assert.ok(
      hit.projectId === ALPHA || hit.projectDirId8 === ALPHA.slice(0, 8),
      `hit ${hit.path} left the bound project`,
    )
    assert.match(hit.snippet, /调度/)
    assert.equal(typeof hit.signals.bm25, 'number')
  }
  assert.deepEqual(reasons(hits[0]).sort(), ['phrase', 'title-exact', 'tokens:2', 'type:2'])

  const history = await searchNotes(index, { query: Q.threeCharCjk, scope: 'project', projectId: ALPHA, includeHistory: true, limit: 20 })
  assert.deepEqual(sorted(history), [...E.projectScopeThreeCharWithHistory].sort())
  const superseded = history.find((hit) => hit.path === N.alphaDecisionSuperseded)
  assert.equal(superseded.status, 'superseded')
  assert.equal(superseded.signals.history, true)
})

test('duplicate titles stay distinct: scope decides which same-titled note is visible', async (t) => {
  const h = await harness(t)
  const index = await h.open()
  await ready(index)

  const project = await searchNotes(index, { query: CORPUS.duplicateTitle, scope: 'project', projectId: ALPHA, limit: 1 })
  assert.deepEqual(paths(project), [N.alphaDecision])
  assert.equal(project[0].title, CORPUS.duplicateTitle)
  assert.equal(project[0].id, 'dec-5d46ff43-1bf8-496d-8b9f-c11e89d4e2aa')
  assert.equal(project[0].signals.titleExact, true)
  const inProject = await searchNotes(index, { query: CORPUS.duplicateTitle, scope: 'project', projectId: ALPHA, limit: 20 })
  assert.equal(paths(inProject).includes(N.betaDecision), false, 'a same-titled note in another project must stay invisible')
  assert.equal(paths(inProject).includes(N.alphaDecisionSuperseded), false, 'the superseded same-titled note is history')
  assert.equal(inProject[0].path, N.alphaDecision)

  // The two same-titled notes outrank every note that merely shares a bigram,
  // so the top two of the cross-project scope are exactly the duplicates.
  const all = await searchNotes(index, { query: CORPUS.duplicateTitle, scope: 'all', limit: 2 })
  assert.deepEqual(sorted(all), [...E.allScopeDuplicateTitle].sort())
  assert.deepEqual(new Set(all.map((hit) => hit.projectId)), new Set([ALPHA, BETA]))
  assert.deepEqual(new Set(all.map((hit) => hit.title)), new Set([CORPUS.duplicateTitle]))
  assert.ok(all.every((hit) => hit.signals.titleExact === true))
})

test('the scope matrix isolates projects, global memory and the read-only user file', async (t) => {
  const h = await harness(t)
  const index = await h.open()
  await ready(index)

  // project: only the bound project, and a different projectId is refused outright
  const project = await searchNotes(index, { query: Q.threeCharCjk, scope: 'project', projectId: ALPHA, limit: 20 })
  assert.ok(project.length > 0)
  assert.ok(project.every((hit) => hit.path.startsWith(`${ALPHA_DIR}/`)), 'project scope must not cross projects')
  await assert.rejects(
    () => searchNotes(index, { query: Q.threeCharCjk, scope: 'project', projectId: BETA }),
    (error) => error instanceof IndexError && error.code === 'project-mismatch',
  )

  // global: 方法/ plus the read-only `_meta/user.md`, nothing else
  const method = await searchNotes(index, { query: Q.methodWord, scope: 'global', limit: 20 })
  assert.deepEqual(paths(method), E.globalScopeMethodWord)
  const user = await searchNotes(index, { query: Q.userWord, scope: 'global', limit: 20 })
  assert.deepEqual(paths(user), E.globalScopeUserWord)
  const globalAll = await searchNotes(index, { query: Q.threeCharCjk, scope: 'global', limit: 20 })
  assert.ok(globalAll.every((hit) => hit.path.startsWith('方法/') || hit.path === '_meta/user.md'))
  // a projectId carries no meaning in the global scope, so it is ignored rather than refused
  const ignored = await searchNotes(index, { query: Q.methodWord, scope: 'global', projectId: BETA, limit: 20 })
  assert.deepEqual(paths(ignored), E.globalScopeMethodWord)

  // all: crosses projects, still honours an explicit projectId filter
  const all = await searchNotes(index, { query: Q.threeCharCjk, scope: 'all', limit: 20 })
  const allPaths = sorted(all)
  assert.ok(allPaths.includes(N.alphaDecision))
  assert.ok(allPaths.includes(N.betaDecision))
  assert.ok(all[0].signals !== undefined)
  const beta = await searchNotes(index, { query: Q.threeCharCjk, scope: 'all', projectId: BETA, limit: 20 })
  assert.deepEqual(sorted(beta), [N.betaDecision, N.betaEnglish].sort())
  // ...and the cross-project corpus is reachable through `all` as well
  assert.deepEqual(paths(await searchNotes(index, { query: Q.methodWord, scope: 'all', limit: 20 })), [N.method])
  assert.ok(paths(await searchNotes(index, { query: Q.userWord, scope: 'all', limit: 20 })).includes(N.user))

  // shared `_meta/` plumbing is never retrievable, in any scope
  for (const [marker, path] of Object.entries(CORPUS.excludedMarkers)) {
    const hits = await searchNotes(index, { query: marker, scope: 'all', limit: 20 })
    assert.equal(paths(hits).includes(path), false, `${path} must not be indexed (marker ${marker})`)
  }
  assert.deepEqual(await searchNotes(index, { query: '收据', scope: 'all' }), [])

  // an unbound context has no project scope at all
  const unbound = await h.open({ projectId: undefined })
  await ready(unbound)
  await assert.rejects(
    () => searchNotes(unbound, { query: Q.threeCharCjk, scope: 'project' }),
    (error) => error instanceof IndexError && error.code === 'project-unbound',
  )
  assert.ok((await searchNotes(unbound, { query: Q.methodWord, scope: 'global' })).length > 0)
})

test('CJK is pre-tokenised on both sides: a two-character query matches because of our bigrams, not FTS5', async (t) => {
  const h = await harness(t)
  const index = await h.open()
  await ready(index)

  assert.deepEqual(indexText('调度器'), ['调度', '度器'])
  assert.deepEqual(indexText('Scheduler 调度'), ['scheduler', '调度'])

  // The measured P0 fact, re-confirmed here as the reason the index exists:
  // FTS5's unicode61 makes a whole CJK run one token, so a raw two-character
  // query returns nothing.
  if (HAS_SQLITE) {
    const { DatabaseSync } = await import('node:sqlite')
    const raw = new DatabaseSync(':memory:')
    raw.exec("CREATE VIRTUAL TABLE raw USING fts5(x, tokenize='unicode61')")
    raw.exec("INSERT INTO raw(x) VALUES('调度器改为可插拔后端')")
    const count = raw.prepare('SELECT count(*) AS c FROM raw WHERE raw MATCH ?').get('"调度"').c
    raw.close()
    assert.equal(count, 0, 'raw FTS5 finds no two-character CJK query; the index must not rely on it')
  }

  const three = await searchNotes(index, { query: Q.threeCharCjk, scope: 'project', projectId: ALPHA, limit: 20 })
  const two = await searchNotes(index, { query: Q.twoCharCjk, scope: 'project', projectId: ALPHA, limit: 20 })
  assert.ok(three.length > 0)
  assert.ok(two.length > 0, 'a two-character CJK query must work through the shared bigram tokenizer')
  assert.ok(two.every((hit) => hit.signals.tokenHits > 0))

  // A single CJK character has no bigram, so it takes the bounded substring branch.
  const single = await searchNotes(index, { query: Q.singleCharCjk, scope: 'project', projectId: ALPHA, limit: 20 })
  assert.ok(single.length > 0, 'single CJK characters must still be findable')
  assert.ok(single.every((hit) => hit.signals.matchedBy === 'substring'))
  assert.ok(single.every((hit) => hit.snippet.includes(Q.singleCharCjk)))
})

test('dangerous FTS operator input is data, never syntax', async (t) => {
  const h = await harness(t)
  const index = await h.open()
  await ready(index)

  const dangerous = [
    '"', '*', '-', 'NEAR', 'NEAR/2', '"调度器" OR *', '-调度器', '调度*', 'a NOT b', '^', '---',
    '(((', '))', '调度器 AND', '标题:', '"', '\\', "O'Brien", 'wildcard* NEAR/3 -x',
  ]
  for (const query of dangerous) {
    const hits = await searchNotes(index, { query, scope: 'all', limit: 8 })
    assert.ok(Array.isArray(hits), `${query} must return an array`)
    for (const hit of hits) assert.ok(await exists(at(h.vault, hit.path)))
  }
  // A query with nothing FTS5 can index is "searched and found nothing", not an error.
  assert.deepEqual(await searchNotes(index, { query: '(((', scope: 'all' }), [])
  // the literal word inside a note is still findable
  const near = await searchNotes(index, { query: Q.dangerLiteral, scope: 'all', limit: 8 })
  assert.ok(paths(near).includes(N.alphaDangerousOperators))
  // a query far past the token cap is truncated, not rejected
  const flooded = await searchNotes(index, { query: new Array(200).fill('调度器').join(' '), scope: 'all', limit: 8 })
  assert.ok(Array.isArray(flooded))
})

test('a note with broken frontmatter is still plain-text searchable and keeps its project attribution', async (t) => {
  const h = await harness(t)
  const index = await h.open()
  await ready(index)

  const hits = await searchNotes(index, { query: Q.brokenWord, scope: 'project', projectId: ALPHA, limit: 8 })
  assert.deepEqual(paths(hits), [N.alphaBrokenFrontmatter])
  assert.equal(hits[0].title, null)
  assert.equal(hits[0].type, null)
  assert.equal(hits[0].status, null)
  assert.equal(hits[0].signals.frontmatterBroken, true)
  assert.equal(hits[0].projectDirId8, ALPHA.slice(0, 8))

  const note = await readNote(h.vault, N.alphaBrokenFrontmatter)
  assert.equal(note.frontmatter, null)
  assert.equal(note.parseError.code, 'invalid-yaml')
  assert.match(note.body, /断链笔记/, 'the whole file stays searchable as plain text')
  assert.equal(note.hash, sha256(await readFile(at(h.vault, N.alphaBrokenFrontmatter))))
})

test('a same-mtime, same-size external rewrite is never trusted from the cache', async (t) => {
  const h = await harness(t)
  const index = await h.open()
  await ready(index)
  const file = at(h.vault, N.alphaExternalRewrite)

  // Pin an integer mtime so the rewrite below can be restored exactly.
  await utimes(file, 1_700_000_000, 1_700_000_000)
  const before = await index.refresh()
  assert.equal(before.ok, true)
  const beforeStat = await stat(file, { bigint: true })

  const original = await readFile(file, 'utf8')
  const rewritten = original.replace(Q.rewriteBefore, Q.rewriteAfter)
  assert.notEqual(rewritten, original)
  assert.equal(Buffer.byteLength(rewritten), Buffer.byteLength(original), 'the rewrite must keep the byte length identical')
  await writeFile(file, rewritten)
  await utimes(file, 1_700_000_000, 1_700_000_000)
  const afterStat = await stat(file, { bigint: true })
  assert.equal(afterStat.size, beforeStat.size, 'size must be unchanged')
  assert.equal(afterStat.mtimeNs, beforeStat.mtimeNs, 'mtime must be unchanged')

  // The cheap mtime+size candidate filter legitimately misses it...
  const incremental = await index.refresh()
  assert.equal(incremental.updated, 0)
  assert.ok(incremental.unchanged >= 1)

  // ...so the stale cache body must never be returned for the old phrase...
  const stale = await searchNotes(index, { query: Q.rewriteBefore, scope: 'project', projectId: ALPHA, limit: 20 })
  assert.equal(paths(stale).includes(N.alphaExternalRewrite), false, 'a cache hit whose source hash changed must be re-read, not trusted')

  // ...and the read-triggered revalidation converges the index onto the new bytes.
  const fresh = await searchNotes(index, { query: Q.rewriteAfter, scope: 'project', projectId: ALPHA, limit: 20 })
  assert.deepEqual(paths(fresh), [N.alphaExternalRewrite])
  assert.match(fresh[0].snippet, /绿色办法/)
  assert.equal(fresh[0].hash, sha256(await readFile(file)))

  // A forced full verification also picks the change up for the next query.
  await utimes(file, 1_700_000_000, 1_700_000_000)
  const full = await index.refresh({ full: true })
  assert.equal(full.full, true)
})

test('a deleted source disappears from results and its cached body is never served', async (t) => {
  const h = await harness(t)
  const index = await h.open()
  await ready(index)
  assert.ok(paths(await searchNotes(index, { query: Q.deletedWord, scope: 'project', projectId: ALPHA })).includes(N.alphaDeleted))

  // A hit whose source vanished is dropped by the read-before-trust step, so the
  // cached body is never served even before any refresh runs.
  await rm(at(h.vault, N.alphaDeleted))
  const hits = await searchNotes(index, { query: Q.deletedWord, scope: 'project', projectId: ALPHA, limit: 20 })
  assert.equal(paths(hits).includes(N.alphaDeleted), false)

  // A file deleted without an intervening hit is removed by the next scan.
  await rm(at(h.vault, N.alphaGotcha))
  const summary = await index.refresh()
  assert.equal(summary.ok, true)
  assert.equal(summary.removed, 1)
  assert.equal(paths(await searchNotes(index, { query: '死锁', scope: 'project', projectId: ALPHA, limit: 20 })).includes(N.alphaGotcha), false)
})

test('readNote re-reads the source, refuses internal and oversized paths, and can slice a section', async (t) => {
  const h = await harness(t)
  const index = await h.open()
  await ready(index)

  const note = await readNote(h.vault, N.alphaLog, '20260922-155100-a1b2')
  assert.equal(note.path, N.alphaLog)
  assert.equal(note.title, '2026-09-22 会话日志')
  assert.equal(note.section, '20260922-155100-a1b2')
  assert.match(note.sectionBody, /排查调度器延迟问题/)
  assert.equal(note.hash, sha256(await readFile(at(h.vault, N.alphaLog))))
  await assert.rejects(
    () => readNote(h.vault, N.alphaLog, '不存在的章节'),
    (error) => error instanceof IndexError && error.code === 'section-not-found',
  )

  for (const internal of [CORPUS.excluded.receipts, CORPUS.excluded.registry, CORPUS.excluded.lint, CORPUS.excluded.history, CORPUS.excluded.obsidian, '.gitignore']) {
    await assert.rejects(
      () => readNote(h.vault, internal),
      (error) => error instanceof IndexError && error.code === 'internal-path',
      `${internal} must be refused`,
    )
  }
  await assert.rejects(() => readNote(h.vault, '../outside.md'), (error) => error.name === 'PathSafetyError')

  const link = at(h.vault, `${ALPHA_DIR}/文档/链接.md`)
  await symlink(at(h.vault, N.user), link)
  await assert.rejects(() => readNote(h.vault, `${ALPHA_DIR}/文档/链接.md`), (error) => error.name === 'PathSafetyError')

  const huge = at(h.vault, `${ALPHA_DIR}/文档/超大.md`)
  await writeFile(huge, `---\ntitle: "超大"\n---\n# 超大\n\n${'x'.repeat(MAX_NOTE_BYTES + 1)}\n`)
  await assert.rejects(
    () => readNote(h.vault, `${ALPHA_DIR}/文档/超大.md`),
    (error) => error instanceof IndexError && error.code === 'note-too-large',
  )
  const summary = await index.refresh()
  assert.ok(summary.skippedLarge >= 1)
  assert.equal(paths(await searchNotes(index, { query: '超大', scope: 'project', projectId: ALPHA })).includes(`${ALPHA_DIR}/文档/超大.md`), false)
})

// ---------------------------------------------------------------------------
// Step 4: degradation, quarantine and the transaction invariant
// ---------------------------------------------------------------------------

test("backend 'auto' degrades to the scan backend and says why; 'sqlite' fails loudly; 'scan' opens no database", async (t) => {
  const h = await harness(t)
  const boom = () => { throw Object.assign(new Error('no such module: fts5'), { code: 'SQLITE_ERROR' }) }

  const degraded = await h.open({ backend: 'auto', openDatabase: boom })
  await ready(degraded)
  assert.equal(degraded.status().backend, 'scan')
  assert.equal(degraded.status().requestedBackend, 'auto')
  assert.equal(degraded.status().degraded, true)
  assert.match(degraded.status().reason, /fts5/)
  assert.equal(degraded.status().dbPath, null)
  const hits = await searchNotes(degraded, { query: Q.threeCharCjk, scope: 'project', projectId: ALPHA, limit: 8 })
  assert.equal(hits[0].path, N.alphaExactTitle)

  await assert.rejects(
    () => h.open({ backend: 'sqlite', openDatabase: boom }),
    (error) => error instanceof IndexError && error.code === 'sqlite-unavailable',
  )

  const scan = await h.open({ backend: 'scan' })
  await ready(scan)
  assert.equal(scan.status().backend, 'scan')
  assert.equal(scan.status().dbPath, null)
  assert.equal(scan.status().degraded, false)
  const indexDir = join(h.dataRoot, 'index')
  const entries = await readdir(indexDir).catch((error) => (error.code === 'ENOENT' ? [] : Promise.reject(error)))
  assert.deepEqual(entries.filter((name) => name.endsWith('.db')), [], "an explicit 'scan' backend must not open a database at all")
})

test('the scan backend and SQLite agree on filtering across the scope matrix', async (t) => {
  const h = await harness(t)
  const sqlite = await h.open({ backend: 'sqlite' })
  const scan = await h.open({ backend: 'scan' })
  await ready(sqlite)
  await ready(scan)

  const matrix = [
    { query: Q.threeCharCjk, scope: 'project', projectId: ALPHA },
    { query: Q.threeCharCjk, scope: 'project', projectId: ALPHA, includeHistory: true },
    { query: Q.threeCharCjk, scope: 'all' },
    { query: Q.threeCharCjk, scope: 'all', projectId: BETA },
    { query: Q.threeCharCjk, scope: 'global' },
    { query: Q.twoCharCjk, scope: 'project', projectId: ALPHA },
    { query: Q.singleCharCjk, scope: 'project', projectId: ALPHA },
    { query: Q.latin, scope: 'all' },
    { query: Q.methodWord, scope: 'global' },
    { query: Q.userWord, scope: 'all' },
    { query: Q.threeCharCjk, scope: 'project', projectId: ALPHA, type: 'decision' },
    { query: Q.dangerLiteral, scope: 'all' },
    { query: '收据', scope: 'all' },
    { query: '(((', scope: 'all' },
  ]
  for (const options of matrix) {
    const a = await searchNotes(sqlite, { limit: 50, ...options })
    const b = await searchNotes(scan, { limit: 50, ...options })
    assert.deepEqual(sorted(a), sorted(b), `backends disagree for ${JSON.stringify(options)}`)
    assert.equal(a.length, b.length)
    if (a.length > 0) assert.equal(a[0].path, b[0].path, `top hit differs for ${JSON.stringify(options)}`)
  }

  // ...and both carry the exact-title corpus winner for the CJK query.
  const a = await searchNotes(sqlite, { query: Q.threeCharCjk, scope: 'project', projectId: ALPHA, limit: 8 })
  const b = await searchNotes(scan, { query: Q.threeCharCjk, scope: 'project', projectId: ALPHA, limit: 8 })
  assert.deepEqual(sorted(a), sorted(b))
  assert.equal(a[0].path, N.alphaExactTitle)
  assert.equal(b[0].path, N.alphaExactTitle)
})

test('a damaged index is quarantined and rebuilt, and pending work is never deleted', async (t) => {
  const h = await harness(t)
  await mkdir(join(h.dataRoot, 'pending'), { recursive: true })
  const marker = join(h.dataRoot, 'pending', 'queued-job.json')
  await writeFile(marker, '{"job":"distill","state":"queued"}\n')

  const first = await h.open()
  await ready(first)
  const dbPath = first.status().dbPath
  await first.close()
  await writeFile(dbPath, 'this is not a SQLite database, it is rubble'.repeat(4))

  const second = await h.open()
  await ready(second)
  assert.equal(second.status().quarantined.length, 1)
  assert.match(second.status().quarantined[0], /\.corrupt-/)
  assert.ok(existsSync(second.status().quarantined[0]))
  const hits = await searchNotes(second, { query: Q.threeCharCjk, scope: 'project', projectId: ALPHA, limit: 8 })
  assert.equal(hits[0].path, N.alphaExactTitle)
  assert.equal(await readFile(marker, 'utf8'), '{"job":"distill","state":"queued"}\n')

  // An unknown schema version is damage too: the index is a cache, so it is rebuilt.
  if (HAS_SQLITE) {
    await second.close()
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(second.status().dbPath)
    db.exec("UPDATE kv SET value = '0' WHERE key = 'schema_version'")
    db.close()
    const third = await h.open()
    await ready(third)
    assert.equal(third.status().quarantined.length, 1)
    assert.equal((await searchNotes(third, { query: Q.threeCharCjk, scope: 'project', projectId: ALPHA, limit: 1 })).length, 1)
  }
  const leftovers = await readdir(join(h.dataRoot, 'pending'))
  assert.deepEqual(leftovers, ['queued-job.json'])
})

test('an index failure is reported as stale and never fails the vault transaction', async (t) => {
  const h = await harness(t)
  await mkdir(join(h.dataRoot, 'pending'), { recursive: true })
  await writeFile(join(h.dataRoot, 'pending', 'keep.json'), '{}\n')

  const index = await h.open({
    io: { readdir: async () => { throw Object.assign(new Error('EACCES: injected'), { code: 'EACCES' }) } },
  })
  const outcome = await index.waitReady(undefined, 5000)
  assert.equal(outcome.ready, false)
  assert.match(String(outcome.reason), /scan|EACCES/i)

  await assert.rejects(() => index.refresh(), (error) => error instanceof IndexError && error.code === 'scan-failed')
  assert.equal(index.status().stale, true)
  assert.match(String(index.status().reason), /EACCES/)

  const relative = `${ALPHA_DIR}/文档/写入成功.md`
  const contents = `---\ntitle: "写入成功"\nproject: "${ALPHA}"\n---\n# 写入成功\n\n即使索引更新失败，写入也必须成功。\n`
  const receipt = await runTransaction(
    { kind: 'bound', projectId: ALPHA, slug: 'alpha', displayName: 'alpha', vaultRoot: h.vault, relativeDir: ALPHA_DIR },
    { txId: newTransactionId(), creates: [{ path: relative, contents }], receipt: null },
    { dataRoot: h.dataRoot, notifyIndex: () => index.refresh() },
  )
  assert.equal(await readFile(at(h.vault, relative), 'utf8'), contents)
  assert.equal(receipt.result.index, 'stale')
  assert.equal(index.status().stale, true)
  assert.equal(await readFile(join(h.dataRoot, 'pending', 'keep.json'), 'utf8'), '{}\n')

  // A later, healthy refresh clears the stale flag and indexes the new note.
  await index.close()
  const healthy = await openIndex({ vaultRoot: h.vault, dataRoot: h.dataRoot, backend: 'sqlite', projectId: ALPHA })
  t.after(() => healthy.close())
  await ready(healthy)
  assert.equal(healthy.status().stale, false)
  assert.ok(paths(await searchNotes(healthy, { query: '即使索引更新失败', scope: 'project', projectId: ALPHA })).includes(relative))
})

test('openIndex validates its inputs and a closed index refuses work', async (t) => {
  const h = await harness(t)
  await assert.rejects(() => openIndex({ backend: 'sqlite' }), RangeError)
  await assert.rejects(() => openIndex({ vaultRoot: h.vault, dataRoot: h.dataRoot, backend: 'nope' }), RangeError)

  const index = await h.open()
  await ready(index)
  const hits = await searchNotes(index, { query: Q.threeCharCjk, scope: 'project', projectId: ALPHA })
  assert.ok(hits.length > 0)
  assert.equal(hits.length <= 8, true, 'the default limit is 8')

  await assert.rejects(() => searchNotes(index, { query: '', scope: 'project', projectId: ALPHA }), RangeError)
  await assert.rejects(() => searchNotes(index, { query: 'x', scope: 'nope' }), RangeError)
  await assert.rejects(() => searchNotes(index, { query: 'x', scope: 'all', limit: 0 }), RangeError)
  await assert.rejects(() => searchNotes(index, { query: 'x', scope: 'all', limit: 999 }), RangeError)

  await index.close()
  await index.close() // idempotent
  await assert.rejects(() => index.refresh(), (error) => error instanceof IndexError && error.code === 'closed')
  await assert.rejects(() => index.search({ query: 'x', filters: {} }), (error) => error instanceof IndexError && error.code === 'closed')
  const closed = await index.waitReady(undefined, 10)
  assert.equal(closed.ready, false)
  assert.equal(closed.reason, 'closed')
})

test('the schema keeps the six designed tables and populates tags, frontmatter and links', async (t) => {
  if (!HAS_SQLITE) return
  const h = await harness(t)
  const index = await h.open()
  await ready(index)
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(index.status().dbPath)
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY name").all().map((row) => row.name)
  for (const table of ['notes', 'notes_fts', 'fm_kv', 'tags', 'links', 'kv']) {
    assert.ok(tables.includes(table), `missing table ${table}`)
  }
  const schemaVersion = db.prepare("SELECT value FROM kv WHERE key = 'schema_version'").get()
  assert.equal(schemaVersion.value, '1')
  assert.ok(db.prepare("SELECT value FROM kv WHERE key = 'last_scan'").get().value.length > 0)
  const note = db.prepare('SELECT id, hash FROM notes WHERE path = ?').get(N.alphaDecision)
  assert.equal(note.id, 'dec-5d46ff43-1bf8-496d-8b9f-c11e89d4e2aa')
  assert.equal(note.hash, sha256(await readFile(at(h.vault, N.alphaDecision))))
  assert.ok(db.prepare('SELECT count(*) AS c FROM tags WHERE note_id = ?').get(note.id).c >= 2)
  assert.equal(db.prepare("SELECT value FROM fm_kv WHERE note_id = ? AND key = 'status'").get(note.id).value, 'accepted')
  assert.ok(db.prepare('SELECT count(*) AS c FROM links').get().c >= 1, 'wikilinks from the corpus hubs must be recorded')
  db.close()
})

test('the query builder quotes and caps every token, and the path rule is a pure predicate', async () => {
  assert.equal(buildMatchQuery([]), null)
  assert.equal(buildMatchQuery(['调度', 'NEAR']), '"调度" OR "NEAR"')
  assert.equal(buildMatchQuery(['a"b']), '"a""b"', 'a quote in a token is escaped, never left as FTS syntax')
  const flooded = planQuery(new Array(50).fill('调度器').join(' '))
  assert.equal(flooded.tokens.length, MAX_QUERY_TOKENS)
  assert.equal(flooded.branch, 'tokens')
  assert.equal(planQuery('器').branch, 'substring')
  assert.equal(planQuery('器').tokens.length, 0)
  assert.equal(planQuery('*').branch, 'substring')
  assert.equal(planQuery('scheduler').branch, 'tokens')
  assert.deepEqual(planQuery('调度器').tokens, ['调度', '度器'])

  assert.equal(isIndexableRelativePath('_meta/user.md'), true)
  assert.equal(isIndexableRelativePath('收件箱/待定条目.md'), true, 'the inbox is searchable, only `pending/` is not')
  assert.equal(isIndexableRelativePath('项目/alpha--1c392abb/收件箱/待定条目.md'), true)
  for (const bad of [
    '_meta/log.md', '_meta/项目注册表.md', '_meta/Lint Report 2026-09-23.md', '_meta/.history/x.md',
    '.obsidian/workspace.json', '.gitignore', 'pending/x.md', '项目/a--1c392abb/pending/x.md',
    '项目/a--1c392abb/文档/x.txt', '项目/a--1c392abb/文档/.hidden.md', '../x.md', '/abs/x.md',
  ]) {
    assert.equal(isIndexableRelativePath(bad), false, `${bad} must not be indexable`)
  }
})

test('a vault that does not exist yet is empty and ready, not broken', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'obsidian-mem-t9-absent-'))
  const dataRoot = join(root, 'data')
  const index = await openIndex({ vaultRoot: join(root, 'vault-not-yet'), dataRoot, backend: 'sqlite', projectId: ALPHA })
  t.after(async () => {
    await index.close().catch(() => {})
    await rm(root, { recursive: true, force: true })
  })
  const readiness = await index.waitReady(undefined, 10_000)
  assert.equal(readiness.ready, true)
  assert.equal(index.status().notes, 0)
  assert.deepEqual(await searchNotes(index, { query: '调度器', scope: 'project', projectId: ALPHA }), [])
})

test('concurrent refreshes are serialized and leave a consistent store', async (t) => {
  const h = await harness(t)
  const index = await h.open({ backend: 'scan' })
  await ready(index)
  const before = index.status().notes
  assert.ok(before > 0)
  const [first, second] = await Promise.all([index.refresh(), index.refresh()])
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  // An unchanged vault gains nothing and loses nothing, however the passes overlapped.
  assert.equal(index.status().notes, before)
  assert.equal(first.added + second.added, 0)
  assert.equal(first.removed + second.removed, 0)
  assert.equal(first.updated + second.updated, 0)
})

test('the scan backend keeps working after the vault changes, without ever touching the vault', async (t) => {
  const h = await harness(t)
  const index = await h.open({ backend: 'scan' })
  await ready(index)
  assert.equal(index.status().notes > 0, true)

  await rm(at(h.vault, N.alphaDeleted))
  const relative = `${ALPHA_DIR}/文档/新增.md`
  await writeFile(at(h.vault, relative), `---\ntitle: "新增"\nproject: "${ALPHA}"\n---\n# 新增\n\n新的调度器备注。\n`)
  const summary = await index.refresh()
  assert.equal(summary.added, 1)
  assert.equal(summary.removed, 1)
  const hits = await searchNotes(index, { query: '新的调度', scope: 'project', projectId: ALPHA, limit: 20 })
  assert.ok(paths(hits).includes(relative))
  assert.equal(index.status().dbPath, null)
})

// ---------------------------------------------------------------------------
// Review fixes: an honest substring bound and a full-window composite score
// ---------------------------------------------------------------------------

test('the substring branch pages in path order and reports its bound instead of a silent empty result', async (t) => {
  const h = await pagedHarness(t, { scanBranchMaxRows: 1, scanBranchPageSize: 1 })
  await ready(h.index)

  // Only the path-smallest row may be examined; it is the deep file, not the
  // shallow one the scan inserted first (whose rowid is lower).
  const hits = await searchNotes(h.index, { query: Q.singleCharCjk, scope: 'project', projectId: PAGED_ID, limit: 50 })
  assert.deepEqual(paths(hits), [PAGED_DEEP_FIRST])
  assert.equal(hits.truncated, true, 'a bound that cut the scan must be visible on the result')
  assert.match(String(hits.truncationReason), /substring-scan-bound/)
  assert.equal(hits.rowsExamined, 1)
  assert.equal(h.index.status().lastSearch.truncated, true)
  assert.equal(h.index.status().lastSearch.truncationReason, hits.truncationReason)

  // A bound that hides every match is still distinguishable from "found nothing":
  // the match sits beyond the bound, so the list is empty *and* flagged.
  const blind = await searchNotes(h.index, { query: '亦', scope: 'project', projectId: PAGED_ID, limit: 50 })
  assert.deepEqual(blind, [])
  assert.equal(blind.truncated, true, 'an empty list is never silently empty while the bound is the reason')
  assert.match(String(blind.truncationReason), /substring-scan-bound/)
})

test('paging crosses pages in path order and a bound past the vault is not flagged', async (t) => {
  const bounded = await pagedHarness(t, { scanBranchMaxRows: 4, scanBranchPageSize: 2 })
  await ready(bounded.index)
  // Two pages of two rows cover the path prefix; the path-fifth shallow note is
  // outside it, so `ddd` is the last match and the flag must be set.
  const page1 = await searchNotes(bounded.index, { query: Q.singleCharCjk, scope: 'project', projectId: PAGED_ID, limit: 50 })
  assert.deepEqual(paths(page1), [PAGED_DEEP_FIRST, PAGED_DEEP_LAST].sort())
  assert.equal(page1.truncated, true)
  assert.equal(page1.rowsExamined, 4)

  // A bound beyond the vault exhausts the source, and that must not be reported as truncation.
  const whole = await pagedHarness(t, { scanBranchMaxRows: 10, scanBranchPageSize: 2 })
  await ready(whole.index)
  const all = await searchNotes(whole.index, { query: Q.singleCharCjk, scope: 'project', projectId: PAGED_ID, limit: 50 })
  assert.deepEqual(paths(all), [PAGED_DEEP_FIRST, PAGED_DEEP_LAST].sort())
  assert.equal(all.truncated, false, 'an exhausted scan is complete, not truncated')
  assert.equal(all.truncationReason, null)
  assert.equal(all.rowsExamined, 5)

  // Both backends apply the same bound in the same order and report the same facts.
  const sqlite = await pagedHarness(t, { scanBranchMaxRows: 4, scanBranchPageSize: 2 })
  await ready(sqlite.index)
  const scan = await sqlite.open({ backend: 'scan', scanBranchMaxRows: 4, scanBranchPageSize: 2 })
  await ready(scan)
  for (const options of [
    { query: Q.singleCharCjk, scope: 'project', projectId: PAGED_ID },
    { query: Q.singleCharCjk, scope: 'all' },
    { query: '第二', scope: 'project', projectId: PAGED_ID },
  ]) {
    const a = await searchNotes(sqlite.index, { limit: 50, ...options })
    const b = await searchNotes(scan, { limit: 50, ...options })
    assert.deepEqual(sorted(a), sorted(b), `backends disagree for ${JSON.stringify(options)}`)
    assert.equal(a.truncated, b.truncated, `truncation differs for ${JSON.stringify(options)}`)
    assert.equal(a.rowsExamined, b.rowsExamined, `examined rows differ for ${JSON.stringify(options)}`)
  }
})

test('a wide bound on the real corpus is not flagged as truncated', async (t) => {
  const h = await harness(t)
  const index = await h.open()
  await ready(index)
  const hits = await searchNotes(index, { query: Q.singleCharCjk, scope: 'all', limit: 50 })
  assert.ok(hits.length > 0)
  assert.equal(hits.truncated, false)
  assert.equal(hits.truncationReason, null)
})

test('the composite score promotes a title match that bm25 ranks below the limit', async (t) => {
  const h = await harness(t)
  const exact = `${ALPHA_DIR}/文档/zebra-exact.md`
  for (let i = 0; i < 12; i += 1) {
    const name = `zebra-filler-${String(i).padStart(2, '0')}.md`
    await writeFile(
      at(h.vault, `${ALPHA_DIR}/文档/${name}`),
      `---\ntype: "doc"\ntitle: "filler ${i}"\nstatus: "active"\nproject: "${ALPHA}"\n---\n# filler ${i}\n\n${'zebra '.repeat(60)}\n`,
    )
  }
  await writeFile(at(h.vault, exact), `---\ntype: "doc"\ntitle: "zebra"\nstatus: "active"\nproject: "${ALPHA}"\n---\n# zebra\n\nzebra\n`)
  const index = await h.open()
  await ready(index)

  // Precondition: bm25 alone puts the exact title below the requested limit.
  assert.equal(HAS_SQLITE, true)
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(index.status().dbPath)
  const match = buildMatchQuery(planQuery('zebra').tokens)
  const ranked = db.prepare(`
    SELECT n.path FROM notes_fts JOIN notes n ON n.rowid = notes_fts.rowid
    WHERE notes_fts MATCH ? ORDER BY bm25(notes_fts, 10.0, 1.0, 4.0) ASC LIMIT 3
  `).all(match).map((row) => row.path)
  db.close()
  assert.equal(ranked.includes(exact), false, 'the corpus must really rank the title match below the limit')

  const hits = await searchNotes(index, { query: 'zebra', scope: 'project', projectId: ALPHA, limit: 3 })
  assert.equal(hits.length, 3)
  assert.equal(hits[0].path, exact, 'the composite score must promote the title match over raw bm25')
  assert.equal(hits[0].signals.titleExact, true)
  assert.ok(hits.every((hit) => hit.path !== exact || hit === hits[0]))
})

test('an aborted signal cancels the search instead of being accepted and ignored', async (t) => {
  const h = await harness(t)
  const index = await h.open()
  await ready(index)
  await assert.rejects(
    () => searchNotes(index, { query: Q.threeCharCjk, scope: 'project', projectId: ALPHA, signal: AbortSignal.abort() }),
    (error) => error instanceof IndexError && error.code === 'aborted',
  )
})

test('a ready barrier removes its abort listener when the timeout wins', async (t) => {
  const h = await harness(t)
  const slow = await h.open({ batchSize: 1, yieldToEventLoop: async () => { await delay(5) } })
  const controller = new AbortController()
  const outcome = await slow.waitReady(controller.signal, 1)
  assert.equal(outcome.ready, false)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0, 'the timeout path must not leak its abort listener')
  await ready(slow)
  controller.abort()
  await assert.rejects(
    () => searchNotes(slow, { query: Q.threeCharCjk, scope: 'project', projectId: ALPHA, signal: controller.signal }),
    (error) => error instanceof IndexError && error.code === 'aborted',
  )
})
