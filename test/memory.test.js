// Task 8: content routing, note lifecycle, the MOC generated block and the hot layer.
//
// Every case runs against a REAL temporary vault created by the REAL bootstrap
// (`bootstrapVault`) and a REAL throwaway data root, so the transaction engine,
// the whole-vault lock and the receipt store under test are the production ones.
// Nothing here reads or writes the user's real `~/.dsh` or `~/Documents`.
//
// Vault bytes are verified by recomputing sha256 with `node:crypto` and by
// re-parsing notes with the Task 6 reader, never with a helper the writer also
// uses for its own evidence. The hand-written `_meta/user.md` and every
// hand-written note are asserted byte-identical after the operations that must
// not touch them.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { HOT_ARCHIVE_RATIO, HOT_CAPACITY_CHARS, updateHot } from '../lib/hot.js'
import { appendLog, createMemoryWithId, readNoteById, writeMemory } from '../lib/memory.js'
import { routeNote, mocPathFor } from '../lib/routing.js'
import { bootstrapVault, findReceipt, parseNote, safeBasename } from '../lib/vault.js'

/** A fixed identity (valid UUIDv4), and the machine's local date as the clock. */
const PROJECT_ID = '1c392abb-7b08-42f7-871d-2a379caf9448'
const PROJECT = `Projects/alpha--${PROJECT_ID.slice(0, 8)}`
/**
 * The fixture clock is the machine's own local date, because `bootstrapVault`
 * stamps `created`/`updated` with the real one: pinning an invented date would
 * make the MOC's byte-preservation assertions depend on the calendar.
 */
const NOW = new Date()
const TODAY = `${NOW.getFullYear()}-${String(NOW.getMonth() + 1).padStart(2, '0')}-${String(NOW.getDate()).padStart(2, '0')}`

const DOCS = `${PROJECT}/Docs`
const DECISIONS = `${PROJECT}/Decisions`
const CONVENTIONS = `${PROJECT}/Conventions`
const INBOX = `${PROJECT}/Inbox`
const LOGS = `${PROJECT}/Daily`
const HOT = `${PROJECT}/_meta/hot.md`
const ARCHIVE = `${DOCS}/hot-archive.md`
const USER_MD = '---\npreferences: 中文优先\n---\n# 用户偏好\n\n保持原样。\n'

const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const at = (vault, relative) => join(vault, ...relative.split('/'))
const codePoints = (text) => [...text].length
const countOf = (haystack, needle) => String(haystack).split(needle).length - 1
const noExt = (relative) => relative.replace(/\.md$/, '')

async function read(vault, relative) {
  return readFile(at(vault, relative), 'utf8')
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

async function listMarkdown(directory) {
  try {
    return (await readdir(directory)).filter((name) => name.endsWith('.md')).sort()
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

/** A binding shaped like `resolveBinding`'s, without needing a git repository. */
function bindingFor(vaultRoot, projectId, slug) {
  return {
    kind: 'bound',
    projectId,
    slug,
    displayName: slug,
    schema: 1,
    vaultRoot,
    relativeDir: `Projects/${slug}--${projectId.slice(0, 8)}`,
  }
}

/** A bootstrapped vault, a throwaway data root, and the pristine user note. */
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'obsidian-mem-t8-'))
  const dataRoot = await mkdtemp(join(tmpdir(), 'obsidian-mem-t8-data-'))
  t.after(() =>
    Promise.all([
      rm(root, { recursive: true, force: true, maxRetries: 4 }),
      rm(dataRoot, { recursive: true, force: true, maxRetries: 4 }),
    ]),
  )
  const home = join(root, 'home')
  await mkdir(home, { recursive: true })
  const vault = join(root, 'vault')
  const binding = bindingFor(vault, PROJECT_ID, 'alpha')
  await bootstrapVault(binding, { dataRoot, home })
  // `_meta/user.md` belongs to the user and is created by nobody but them.
  await writeFile(at(vault, '_meta/user.md'), USER_MD)
  return { root, dataRoot, home, vault, binding, deps: { dataRoot, home, now: NOW } }
}

/** `assert.rejects` predicate that names the expected error code. */
const failsWith = (code) => (error) => {
  assert.equal(error.code, code, `expected code ${code}, received ${error.code}: ${error.message}`)
  return true
}

// ---------------------------------------------------------------------------
// Step 1 (carried R28/R31): the naming byte budget
// ---------------------------------------------------------------------------

test('safeBasename keeps the emitted file name inside the 200-byte budget (R28/R31)', () => {
  // A title whose first dot sits at byte 1 and whose tail alone is 199 bytes:
  // the old `withSuffix` kept the whole tail and blew past the budget.
  const title = `a.${'b'.repeat(300)}`
  const stem = safeBasename(title)
  assert.equal(
    Buffer.byteLength(stem, 'utf8'),
    197,
    'the basename budget leaves room for the .md extension',
  )
  assert.ok(Buffer.byteLength(`${stem}.md`, 'utf8') <= 200)

  const suffixed = safeBasename(title, [stem])
  assert.notEqual(suffixed, stem)
  assert.match(suffixed, /-[0-9a-f]{8}/)
  assert.ok(
    Buffer.byteLength(`${suffixed}.md`, 'utf8') <= 200,
    `${Buffer.byteLength(`${suffixed}.md`, 'utf8')} bytes for a suffixed name must fit the 200-byte whole-file budget`,
  )

  // A leading dot plus a long tail is the same hazard through sanitization, and
  // *every* path — suffixed or not — must fit the whole-file budget (R31).
  for (const candidate of [
    `.${'a'.repeat(300)}.md`,
    `x.${'决'.repeat(120)}`,
    `${'y'.repeat(60)}.${'z'.repeat(300)}`,
    `w.${'q'.repeat(64)}`,
  ]) {
    const clean = safeBasename(candidate)
    const collided = safeBasename(candidate, [clean])
    for (const name of [clean, collided]) {
      assert.ok(Buffer.byteLength(name, 'utf8') <= 197, 'the basename budget always holds')
      assert.ok(
        Buffer.byteLength(`${name}.md`, 'utf8') <= 200,
        `${JSON.stringify(name)} plus the extension must fit the budget`,
      )
    }
  }
})

test('routeNote budgets the emitted vault file name to 200 UTF-8 bytes', () => {
  const binding = bindingFor('/tmp/vault', PROJECT_ID, 'alpha')
  const long = routeNote(binding, 'doc', '长'.repeat(300))
  const filename = long.slice(long.lastIndexOf('/') + 1)
  assert.ok(Buffer.byteLength(filename, 'utf8') <= 200, `${filename} must fit the file-name budget`)
  const decision = routeNote(binding, 'decision', '决'.repeat(300), { adrNumber: 12 })
  const decisionName = decision.slice(decision.lastIndexOf('/') + 1)
  assert.ok(
    Buffer.byteLength(decisionName, 'utf8') <= 200,
    `${decisionName} must fit the file-name budget`,
  )
})

// ---------------------------------------------------------------------------
// Step 1: type -> landing directory (§6.2)
// ---------------------------------------------------------------------------

test('routeNote maps every memory type to its §6.2 landing place', () => {
  const binding = bindingFor('/tmp/vault', PROJECT_ID, 'alpha')
  assert.match(TODAY, /^\d{4}-\d{2}-\d{2}$/)
  assert.equal(routeNote(binding, 'doc', '设计稿'), `${DOCS}/设计稿.md`)
  assert.equal(
    routeNote(binding, 'decision', '调度器', { adrNumber: 7 }),
    `${DECISIONS}/ADR-7-调度器.md`,
  )
  assert.equal(routeNote(binding, 'decision', '调度器'), `${DECISIONS}/ADR-1-调度器.md`)
  assert.equal(routeNote(binding, 'gotcha', '缓存不失效'), `${PROJECT}/Pitfalls/缓存不失效.md`)
  assert.equal(routeNote(binding, 'convention', '只用 ESM'), `${CONVENTIONS}/只用 ESM.md`)
  assert.equal(
    routeNote(binding, 'invariant', '只用 ESM'),
    `${CONVENTIONS}/只用 ESM.md`,
    'invariant is the input alias',
  )
  assert.equal(routeNote(binding, 'glossary', '术语'), `${DOCS}/glossary.md`)
  assert.equal(routeNote(binding, 'session-log', 'x', { today: TODAY }), `${LOGS}/${TODAY}.md`)
  assert.equal(routeNote(binding, 'hub', 'x'), `${PROJECT}/index.md`)
  assert.equal(routeNote(binding, 'method', '复盘'), 'Methods/复盘.md')
  // a name that collides inside the directory gets a deterministic suffix
  const collided = routeNote(binding, 'doc', '设计稿', { existingNames: ['设计稿.md'] })
  assert.match(collided, new RegExp(`^${DOCS}/设计稿-[0-9a-f]{8}\\.md$`))
  // the explicit inbox destination (R33) overrides the type's landing place
  // without becoming a `type` value of its own
  assert.equal(routeNote(binding, 'decision', '待定', { inbox: true }), `${INBOX}/待定.md`)
  assert.equal(routeNote(binding, 'gotcha', '待定', { inbox: true }), `${INBOX}/待定.md`)
  assert.equal(routeNote(binding, 'convention', '待定', { inbox: true }), `${INBOX}/待定.md`)
  assert.equal(mocPathFor(binding, 'decision', { inbox: true }), `${INBOX}/index.md`)
  assert.equal(mocPathFor(binding, 'decision'), `${DECISIONS}/index.md`)
  assert.equal(mocPathFor(binding, 'session-log'), null)
  assert.throws(() => routeNote(binding, 'nonsense', 'x'), RangeError)
  assert.throws(() => routeNote(binding, 'nonsense', 'x', { inbox: true }), RangeError)
  assert.throws(() => routeNote(binding, 'session-log', 'x'), RangeError)
})

// ---------------------------------------------------------------------------
// Step 1: create -> route, MOC and receipt
// ---------------------------------------------------------------------------

test('writeMemory routes a doc into Docs and registers it in the MOC generated block', async (t) => {
  const { vault, binding, deps } = await fixture(t)
  const result = await writeMemory(
    binding,
    { type: 'doc', title: '写入协议', body: '正文一。' },
    deps,
  )

  assert.match(result.id, /^doc-[0-9a-f-]{36}$/)
  assert.equal(result.path, `${DOCS}/写入协议.md`)
  assert.equal(result.receipt.paths[0], result.path)
  assert.equal(result.receipt.action, 'write')
  assert.equal(result.receipt.beforeHashes[result.path], null)
  assert.equal(result.receipt.afterHashes[result.path], sha256(await read(vault, result.path)))

  const note = parseNote(await readFile(at(vault, result.path)))
  assert.equal(note.data.id, result.id)
  assert.equal(note.data.type, 'doc')
  assert.equal(note.data.project, PROJECT_ID)
  assert.deepEqual(note.data.tags, ['dsh-mem/doc', 'project/alpha'])
  assert.equal(note.data.created, TODAY)
  assert.equal(note.data.updated, TODAY)
  assert.equal(note.data.trust, 'agent')
  assert.equal(note.data.harness, 'dsh')
  assert.equal(note.body, '正文一。\n')

  // the MOC lists it with a path-qualified wikilink (R7)
  const moc = await read(vault, `${DOCS}/index.md`)
  assert.equal(moc.includes(`- [[${noExt(result.path)}|写入协议]]`), true)
  const block = generatedBlock(moc)
  assert.equal(block.declaredHash, sha256(block.body))
  assert.equal(result.receipt.afterHashes[`${DOCS}/index.md`], sha256(moc))

  // Task 5's handoff: the first receipt-bearing writer creates `_meta/log.md`
  const log = await read(vault, '_meta/log.md')
  assert.equal(log.includes(result.receipt.txId), true)
})

test('a decision takes the next exclusive ADR number, which is never its identity', async (t) => {
  const { vault, binding, deps } = await fixture(t)
  const first = await writeMemory(
    binding,
    { type: 'decision', title: '调度器', body: '采用 A' },
    deps,
  )
  assert.equal(first.path, `${DECISIONS}/ADR-1-调度器.md`)
  assert.match(first.id, /^dec-[0-9a-f-]{36}$/)
  assert.equal(parseNote(await readFile(at(vault, first.path))).data.id, first.id)

  const second = await writeMemory(
    binding,
    { type: 'decision', title: '缓存', body: '两级缓存' },
    deps,
  )
  assert.equal(second.path, `${DECISIONS}/ADR-2-缓存.md`)

  // a hand-written ADR with a higher number wins the next allocation
  await writeFile(
    at(vault, `${DECISIONS}/ADR-9-手写决策.md`),
    '---\ntitle: "手写"\n---\n\n人写的。\n',
  )
  const third = await writeMemory(
    binding,
    { type: 'decision', title: '日志', body: '结构化' },
    deps,
  )
  assert.equal(third.path, `${DECISIONS}/ADR-10-日志.md`)
  assert.equal(
    parseNote(await readFile(at(vault, `${DECISIONS}/ADR-9-手写决策.md`))).data.title,
    '手写',
  )
})

test('the same title on the same day yields two distinct ids and two files', async (t) => {
  const { vault, binding, deps } = await fixture(t)
  const first = await writeMemory(
    binding,
    { type: 'decision', title: '调度器', body: '采用 A' },
    deps,
  )
  const second = await writeMemory(
    binding,
    { type: 'decision', title: '调度器', body: '采用 B' },
    deps,
  )

  assert.notEqual(first.id, second.id)
  assert.notEqual(first.path, second.path)
  assert.equal(first.path, `${DECISIONS}/ADR-1-调度器.md`)
  assert.equal(second.path, `${DECISIONS}/ADR-2-调度器.md`)
  // the first note is byte-identical: a second write never edits the first
  assert.equal(parseNote(await readFile(at(vault, first.path))).data.id, first.id)
  assert.equal((await read(vault, second.path)).includes('采用 B'), true)
})

test('a convention is one file per entry', async (t) => {
  const { vault, binding, deps } = await fixture(t)
  const esm = await writeMemory(
    binding,
    { type: 'convention', title: '只用 ESM', body: 'no require' },
    deps,
  )
  const dates = await writeMemory(
    binding,
    { type: 'convention', title: '日期一律本地日期', body: 'no toISOString' },
    deps,
  )
  const alias = await writeMemory(
    binding,
    { type: 'invariant', title: '只用 ESM', body: 'no require' },
    deps,
  )

  assert.equal(esm.path, `${CONVENTIONS}/只用 ESM.md`)
  assert.equal(dates.path, `${CONVENTIONS}/日期一律本地日期.md`)
  assert.notEqual(alias.path, esm.path, 'a second entry with the same title is a second file')
  assert.deepEqual(
    (await listMarkdown(at(vault, CONVENTIONS))).filter((name) => name !== 'index.md').length,
    3,
  )
  assert.equal(parseNote(await readFile(at(vault, esm.path))).data.type, 'convention')
  const moc = await read(vault, `${CONVENTIONS}/index.md`)
  assert.equal(moc.includes(`[[${noExt(esm.path)}|只用 ESM]]`), true)
  assert.equal(moc.includes(`[[${noExt(dates.path)}|日期一律本地日期]]`), true)
})

test('an external update requires a known id and never matches on title', async (t) => {
  const { vault, binding, deps } = await fixture(t)
  const first = await writeMemory(binding, { type: 'doc', title: '写入协议', body: 'v1' }, deps)
  const before = await read(vault, first.path)

  // a title that already exists is NOT an update target: it is a second fact
  const second = await writeMemory(binding, { type: 'doc', title: '写入协议', body: 'v2' }, deps)
  assert.notEqual(second.id, first.id)
  assert.notEqual(second.path, first.path)
  assert.equal(await read(vault, first.path), before)

  // an id that does not resolve is refused instead of silently creating a note
  await assert.rejects(
    writeMemory(binding, { id: `doc-${randomUUID()}`, body: 'v3' }, deps),
    failsWith('note-not-found'),
  )
  const notes = (await listMarkdown(at(vault, DOCS))).filter((name) => name !== 'index.md')
  assert.equal(notes.length, 2, 'the refused update created no third note')

  // a real update through the id does change the body and bumps `updated`
  const updated = await writeMemory(binding, { id: first.id, body: 'v4' }, deps)
  assert.equal(updated.path, first.path)
  assert.equal(updated.id, first.id)
  const note = await readNoteById(binding, first.id, deps)
  assert.equal(note.body, 'v4\n')
  assert.equal(note.frontmatter.updated, TODAY)
  assert.notEqual(await read(vault, first.path), before)
})

test('createMemoryWithId creates exclusively and refuses an existing id', async (t) => {
  const { vault, binding, deps } = await fixture(t)
  const uuid = randomUUID()
  const preassignedId = `got-${uuid}`

  const created = await createMemoryWithId(
    binding,
    {
      preassignedId,
      idempotencyKey: 'distill:sess-1:0',
      type: 'gotcha',
      title: '缓存不失效',
      body: '症状：旧值。',
    },
    deps,
  )
  assert.equal(created.id, preassignedId)
  assert.equal(created.path, `${PROJECT}/Pitfalls/缓存不失效.md`)
  assert.equal((await readNoteById(binding, preassignedId, deps)).frontmatter.id, preassignedId)

  // the same persisted id + key replays the original receipt and writes nothing
  const replay = await createMemoryWithId(
    binding,
    {
      preassignedId,
      idempotencyKey: 'distill:sess-1:0',
      type: 'gotcha',
      title: '缓存不失效',
      body: '症状：旧值。',
    },
    deps,
  )
  assert.equal(replay.receipt.txId, created.receipt.txId)
  assert.equal(replay.path, created.path)
  assert.equal((await listMarkdown(at(vault, `${PROJECT}/Pitfalls`))).length, 2)

  // a *new* key with an already-used id is a refusal, never an update
  await assert.rejects(
    createMemoryWithId(
      binding,
      {
        preassignedId,
        idempotencyKey: 'distill:sess-1:1',
        type: 'gotcha',
        title: '缓存不失效',
        body: '想覆盖。',
      },
      deps,
    ),
    failsWith('id-taken'),
  )
  assert.equal((await listMarkdown(at(vault, `${PROJECT}/Pitfalls`))).length, 2)
  assert.equal((await read(vault, created.path)).includes('想覆盖'), false)
})

test('a repeated idempotencyKey returns the original receipt without a second write', async (t) => {
  const { vault, binding, deps } = await fixture(t)
  const request = { type: 'doc', title: '写入协议', body: 'v1', idempotencyKey: 'mem-write-1' }
  const first = await writeMemory(binding, request, deps)
  const mocBefore = await read(vault, `${DOCS}/index.md`)
  const logBefore = await read(vault, '_meta/log.md')

  const replay = await writeMemory(binding, { ...request }, deps)
  assert.equal(replay.receipt.txId, first.receipt.txId)
  assert.equal(replay.path, first.path)
  assert.equal(replay.id, first.id)
  assert.deepEqual(await listMarkdown(at(vault, DOCS)), ['index.md', '写入协议.md'])
  assert.equal(await read(vault, `${DOCS}/index.md`), mocBefore)
  assert.equal(await read(vault, '_meta/log.md'), logBefore)

  // and the key is readable from the store outside the vault
  const stored = await findReceipt(binding, 'mem-write-1', deps)
  assert.equal(stored.txId, first.receipt.txId)
})

test('two concurrent writes with one title still land two exclusive ADR numbers', async (t) => {
  const { vault, binding, deps } = await fixture(t)
  const request = { type: 'decision', title: '调度器', body: '并发' }
  const [first, second] = await Promise.all([
    writeMemory(binding, { ...request }, deps),
    writeMemory(binding, { ...request }, deps),
  ])

  assert.notEqual(first.id, second.id)
  assert.notEqual(first.path, second.path)
  const numbers = [first.path, second.path].map((path) => /ADR-(\d+)-/.exec(path)[1]).sort()
  assert.deepEqual(
    numbers,
    ['1', '2'],
    'the loser of the exclusive create re-allocates instead of overwriting',
  )
  const names = (await listMarkdown(at(vault, DECISIONS))).filter((name) => name !== 'index.md')
  assert.deepEqual(names.sort(), ['ADR-1-调度器.md', 'ADR-2-调度器.md'])
  for (const result of [first, second]) {
    assert.equal(parseNote(await readFile(at(vault, result.path))).data.id, result.id)
  }
})

test('the §6.4 optional properties round-trip and a no-op update writes no bytes', async (t) => {
  const { vault, binding, deps } = await fixture(t)
  const created = await writeMemory(
    binding,
    {
      type: 'gotcha',
      title: '缓存不失效',
      body: '症状 / 根因 / 修复 / 证据',
      status: 'accepted',
      confidence: 0.8,
      assertion: 'observed',
      review_after: '2027-03-23',
      source: 'git',
      session: 'sess-1',
      tags: ['dsh-mem/gotcha', 'project/alpha', 'topic/cache'],
    },
    deps,
  )
  const note = await readNoteById(binding, created.id, deps)
  assert.equal(note.frontmatter.confidence, 0.8)
  assert.equal(note.frontmatter.assertion, 'observed')
  assert.equal(note.frontmatter.review_after, '2027-03-23')
  assert.equal(note.frontmatter.source, 'git')
  assert.equal(note.frontmatter.session, 'sess-1')
  assert.deepEqual(note.frontmatter.tags, ['dsh-mem/gotcha', 'project/alpha', 'topic/cache'])
  await assert.rejects(writeMemory(binding, { id: created.id, confidence: 1.5 }, deps), RangeError)

  // an update that changes nothing is recorded as a no-op on the note: the same
  // bytes, the same mtime, and before/after hashes that agree (R23)
  const before = await readFile(at(vault, created.path))
  const mtimeBefore = (await stat(at(vault, created.path))).mtimeMs
  const idle = await writeMemory(binding, { id: created.id, body: note.body }, deps)
  assert.equal(idle.receipt.beforeHashes[created.path], idle.receipt.afterHashes[created.path])
  assert.equal((await readFile(at(vault, created.path))).equals(before), true)
  assert.equal((await stat(at(vault, created.path))).mtimeMs, mtimeBefore)

  // a real status change does rewrite it
  await writeMemory(binding, { id: created.id, status: 'proposed' }, deps)
  assert.equal((await readNoteById(binding, created.id, deps)).frontmatter.status, 'proposed')
})

test('a low-confidence candidate lands in Inbox with its real type preserved', async (t) => {
  const { vault, binding, deps } = await fixture(t)
  const candidate = await writeMemory(
    binding,
    {
      type: 'decision',
      title: '也许该换调度器',
      body: '低置信候选，待人工分类。',
      status: 'provisional',
      confidence: 0.4,
      assertion: 'inferred',
      inbox: true,
    },
    deps,
  )

  assert.equal(candidate.path, `${INBOX}/也许该换调度器.md`)
  const note = parseNote(await readFile(at(vault, candidate.path)))
  // the §6.4 vocabulary stays closed: the item carries its real type, only the
  // destination changed (R33)
  assert.equal(note.data.type, 'decision')
  assert.equal(note.data.id, candidate.id)
  assert.match(candidate.id, /^dec-[0-9a-f-]{36}$/)
  assert.equal(note.data.status, 'provisional')
  assert.equal(note.data.confidence, 0.4)
  assert.equal(note.data.assertion, 'inferred')

  // it is registered in the inbox MOC and nowhere else
  const inboxMoc = await read(vault, `${INBOX}/index.md`)
  assert.equal(inboxMoc.includes(`- [[${noExt(candidate.path)}|也许该换调度器]]`), true)
  assert.equal((await read(vault, `${DECISIONS}/index.md`)).includes('也许该换调度器'), false)
  assert.equal(await exists(at(vault, `${DECISIONS}/ADR-1-也许该换调度器.md`)), false)

  // parking a candidate burns no ADR number and creates no ADR file
  const real = await writeMemory(
    binding,
    { type: 'decision', title: '调度器', body: '采用 A' },
    deps,
  )
  assert.equal(real.path, `${DECISIONS}/ADR-1-调度器.md`)

  // a gotcha candidate keeps its own id prefix and type in the same way
  const gotcha = await writeMemory(
    binding,
    { type: 'gotcha', title: '缓存可疑', body: '待确认', inbox: true },
    deps,
  )
  assert.equal(gotcha.path, `${INBOX}/缓存可疑.md`)
  assert.match(gotcha.id, /^got-[0-9a-f-]{36}$/)
  assert.equal(parseNote(await readFile(at(vault, gotcha.path))).data.type, 'gotcha')
})

test('an update refuses lifecycle and destination fields instead of dropping them', async (t) => {
  const { binding, deps } = await fixture(t)
  const a = await writeMemory(binding, { type: 'decision', title: '调度器', body: '采用 A' }, deps)
  const b = await writeMemory(binding, { type: 'decision', title: '别的', body: 'x' }, deps)
  const before = await readNoteById(binding, a.id, deps)

  await assert.rejects(
    writeMemory(binding, { id: a.id, supersedes: b.id, body: '被静默丢弃的取代' }, deps),
    failsWith('lifecycle-on-update'),
  )
  await assert.rejects(
    writeMemory(binding, { id: a.id, contestedWith: b.id }, deps),
    failsWith('lifecycle-on-update'),
  )
  await assert.rejects(
    writeMemory(binding, { id: a.id, inbox: true }, deps),
    failsWith('destination-on-update'),
  )

  const after = await readNoteById(binding, a.id, deps)
  assert.equal(after.frontmatter.status, before.frontmatter.status)
  assert.equal(after.frontmatter.superseded_by, null)
  assert.equal(after.body, before.body)
  assert.equal((await readNoteById(binding, b.id, deps)).frontmatter.status, 'proposed')
})

test('an update refuses a note that changed between the scan and the transaction', async (t) => {
  const { vault, binding, deps } = await fixture(t)
  const note = await writeMemory(binding, { type: 'doc', title: '写入协议', body: 'v1' }, deps)
  // The seam produces the one window a real filesystem cannot be asked to raise
  // on demand: a hand edit landing after the id scan and before the lock.
  const racing = {
    ...deps,
    afterScan: async ({ path }) => {
      await writeFile(at(vault, path), `${await read(vault, path)}外部改动。\n`)
    },
  }
  const edited = `${await read(vault, note.path)}外部改动。\n`

  await assert.rejects(
    writeMemory(binding, { id: note.id, body: 'v2' }, racing),
    failsWith('hash-mismatch'),
  )
  assert.equal(await read(vault, note.path), edited, 'the newer revision is kept, not overwritten')
  assert.equal(edited.includes('外部改动。'), true)

  // without the edit the same request succeeds, so the refusal is the stale hash
  const updated = await writeMemory(binding, { id: note.id, body: 'v3' }, deps)
  assert.equal(updated.path, note.path)
  assert.equal((await read(vault, note.path)).includes('v3'), true)
})

// ---------------------------------------------------------------------------
// Step 1: lifecycle — supersede and contested (§6.3)
// ---------------------------------------------------------------------------
test('supersede writes the new note and updates the old one in both directions', async (t) => {
  const { vault, binding, deps } = await fixture(t)
  const a = await writeMemory(binding, { type: 'decision', title: '调度器', body: '采用 A' }, deps)
  const oldBefore = await read(vault, a.path)
  const b = await writeMemory(
    binding,
    { type: 'decision', title: '调度器', body: '采用 B', supersedes: a.id },
    deps,
  )

  assert.notEqual(a.id, b.id)
  assert.notEqual(a.path, b.path)

  const oldNote = await readNoteById(binding, a.id, deps)
  assert.equal(oldNote.frontmatter.status, 'superseded')
  assert.equal(oldNote.frontmatter.superseded_by, b.id)
  assert.equal(oldNote.body.includes('采用 A'), true, 'the old evidence is never deleted')
  assert.equal(oldNote.body.includes(noExt(b.path)), true, 'the old note links to the new one')

  const newNote = await readNoteById(binding, b.id, deps)
  assert.equal(newNote.frontmatter.supersedes, a.id)
  assert.equal(newNote.frontmatter.superseded_by, null)
  assert.equal(newNote.body.includes(noExt(a.path)), true, 'the new note links back to the old one')
  assert.equal(newNote.body.includes('采用 B'), true)

  // the old note's update is part of the same receipt
  assert.equal(b.receipt.beforeHashes[a.path], sha256(oldBefore))
  assert.equal(b.receipt.afterHashes[a.path], sha256(await read(vault, a.path)))
  // the old note is still listed in the MOC: superseding never deletes
  assert.equal((await read(vault, `${DECISIONS}/index.md`)).includes(noExt(a.path)), true)
})

test('contested keeps both notes and links them without superseding either', async (t) => {
  const { binding, deps } = await fixture(t)
  const a = await writeMemory(binding, { type: 'decision', title: '调度器', body: '采用 A' }, deps)
  const b = await writeMemory(
    binding,
    {
      type: 'decision',
      title: '调度器（反方）',
      body: '采用 B',
      contestedWith: a.id,
    },
    deps,
  )

  const oldNote = await readNoteById(binding, a.id, deps)
  const newNote = await readNoteById(binding, b.id, deps)
  assert.equal(oldNote.frontmatter.status, 'contested')
  assert.equal(newNote.frontmatter.status, 'contested')
  assert.equal(oldNote.frontmatter.superseded_by, null, 'no winner is chosen')
  assert.equal(newNote.frontmatter.supersedes, null, 'no winner is chosen')
  assert.equal(oldNote.body.includes('采用 A'), true)
  assert.equal(newNote.body.includes('采用 B'), true)
  assert.equal(oldNote.body.includes(noExt(b.path)), true)
  assert.equal(newNote.body.includes(noExt(a.path)), true)
})

test('a trust:owner note and an unowned note are never modified', async (t) => {
  const { vault, binding, deps } = await fixture(t)
  const ownedId = `doc-${randomUUID()}`
  const unownedId = `doc-${randomUUID()}`
  await writeFile(
    at(vault, `${DOCS}/人写的.md`),
    `---\nid: "${ownedId}"\ntype: "doc"\ntitle: "人写的"\ntrust: "owner"\n---\n\n人写的内容\n`,
  )
  await writeFile(
    at(vault, `${DOCS}/无主.md`),
    `---\nid: "${unownedId}"\ntype: "doc"\ntitle: "无主"\n---\n\n没有插件收据的内容\n`,
  )
  const ownedBefore = await read(vault, `${DOCS}/人写的.md`)
  const unownedBefore = await read(vault, `${DOCS}/无主.md`)

  await assert.rejects(
    writeMemory(binding, { id: ownedId, body: '改' }, deps),
    failsWith('human-owned'),
  )
  await assert.rejects(
    writeMemory(binding, { id: unownedId, body: '改' }, deps),
    failsWith('ownership-unproven'),
  )
  assert.equal(await read(vault, `${DOCS}/人写的.md`), ownedBefore)
  assert.equal(await read(vault, `${DOCS}/无主.md`), unownedBefore)
})

// ---------------------------------------------------------------------------
// Step 4: the MOC written only inside its verified generated block
// ---------------------------------------------------------------------------

test('the MOC generated block is the only thing a write touches', async (t) => {
  const { vault, binding, deps } = await fixture(t)
  const mocPath = `${DOCS}/index.md`
  const withTail = `${await read(vault, mocPath)}\n## 人工章节\n\n人工内容，插件不得改动。\n`
  await writeFile(at(vault, mocPath), withTail)

  const result = await writeMemory(
    binding,
    { type: 'doc', title: '写入协议', body: '正文一。' },
    deps,
  )
  const after = await read(vault, mocPath)
  const before = splitGenerated(withTail)
  const written = splitGenerated(after)

  assert.equal(written.prefix, before.prefix, 'every byte before the block is preserved')
  assert.equal(written.suffix, before.suffix, 'every byte after the block is preserved')
  assert.equal(written.body, `- [[${noExt(result.path)}|写入协议]]`)
  assert.equal(written.declaredHash, sha256(written.body))
  assert.equal(result.receipt.beforeHashes[mocPath], sha256(withTail))
  assert.equal(result.receipt.afterHashes[mocPath], sha256(after))
})

test('a human-edited MOC generated block stops the write with a conflict', async (t) => {
  const { vault, binding, deps } = await fixture(t)
  const mocPath = `${DOCS}/index.md`
  const tampered = (await read(vault, mocPath)).replace(
    '<!-- obsidian-mem:generated end -->',
    '- 人工添加的一行\n<!-- obsidian-mem:generated end -->',
  )
  await writeFile(at(vault, mocPath), tampered)
  await writeFile(at(vault, '_meta/user.md'), USER_MD)

  await assert.rejects(
    writeMemory(binding, { type: 'doc', title: '第二篇', body: '不该落盘' }, deps),
    failsWith('generated-block-conflict'),
  )

  assert.equal(
    await read(vault, mocPath),
    tampered,
    'the edited block is left exactly as the human wrote it',
  )
  assert.equal(
    await exists(at(vault, `${DOCS}/第二篇.md`)),
    false,
    'the refused transaction wrote nothing',
  )
  assert.equal(await read(vault, '_meta/user.md'), USER_MD)
})

// ---------------------------------------------------------------------------
// Step 1/4: the hot layer (§6.1)
// ---------------------------------------------------------------------------

/** Fill a hot section with padding so the file lands near a budget boundary. */
function padHot(text, section, filler, size) {
  return text.replace(`## ${section}\n`, `## ${section}\n\n- ${filler}${'x'.repeat(size)}\n`)
}

test('updateHot appends one entry to the requested section and logs a receipt', async (t) => {
  const { vault, binding, deps } = await fixture(t)
  const doc = await writeMemory(binding, { type: 'doc', title: '写入协议', body: '正文。' }, deps)

  const receipt = await updateHot(
    binding,
    { section: '进行中', text: '接通热层写入', sourceId: doc.id },
    deps,
  )
  assert.equal(receipt.action, 'hot')
  assert.equal(receipt.paths[0], HOT)

  const hot = await read(vault, HOT)
  assert.equal(hot.includes('接通热层写入'), true)
  assert.equal(hot.includes(`[[${noExt(doc.path)}|写入协议]]`), true)
  assert.match(hot, /- \[hot-[0-9a-f-]{36}\] /)
  const note = parseNote(await readFile(at(vault, HOT)))
  assert.equal(note.data.updated, TODAY)
  assert.equal(receipt.afterHashes[HOT], sha256(hot))
})

test('the hot layer archives only complete 已完成 entries, and leaves fragments alone', async (t) => {
  const { vault, binding, deps } = await fixture(t)
  const complete = `- [hot-11111111-1111-4111-8111-111111111111] 已完成的事项 — [[${DOCS}/写入协议|写入协议]]`
  const handwritten = '- 手写但没有插件标记的条目'
  const truncated = `- [hot-22222222-2222-4222-8222-222222222222] 被截断的条目 — [[x]]`

  let hot = await read(vault, HOT)
  hot = padHot(hot, '进行中', '填充', Math.ceil(HOT_CAPACITY_CHARS * HOT_ARCHIVE_RATIO) + 200)
  hot = hot.replace('## 已完成\n', `## 已完成\n\n${complete}\n${handwritten}\n${truncated}\n`)
  hot = hot.replace(/\n+$/, '')
  assert.equal(hot.endsWith('\n'), false, 'the last line is a real fragment')
  await writeFile(at(vault, HOT), hot)
  assert.ok(
    codePoints(hot) > HOT_CAPACITY_CHARS * HOT_ARCHIVE_RATIO,
    'the write must trigger archival',
  )

  const receipt = await updateHot(binding, { section: '进行中', text: '新进展' }, deps)
  const after = await read(vault, HOT)

  assert.ok(codePoints(after) <= HOT_CAPACITY_CHARS, 'archival keeps the file inside its hard cap')
  assert.equal(after.includes('已完成的事项'), false, 'the complete entry was moved out')
  assert.equal(after.includes('已归档'), true, 'a pointer replaced it in place')
  assert.equal(
    after.includes(handwritten),
    true,
    'a hand-written entry without a plugin marker is never archived',
  )
  assert.equal(after.includes('被截断的条目'), true, 'an unterminated fragment is never archived')
  assert.equal(after.includes('新进展'), true)

  const archive = await read(vault, ARCHIVE)
  assert.equal(archive.includes('已完成的事项'), true)
  assert.equal(archive.includes('被截断的条目'), false)
  assert.equal(archive.includes(handwritten), false)
  const archived = parseNote(await readFile(at(vault, ARCHIVE)))
  assert.match(archived.data.id, /^doc-[0-9a-f-]{36}$/)
  assert.equal(archived.data.trust, 'agent')
  assert.equal(receipt.paths.includes(ARCHIVE), true)
})

test('an over-limit hot file that cannot be archived refuses the write', async (t) => {
  const { vault, binding, deps } = await fixture(t)
  let hot = await read(vault, HOT)
  hot = padHot(hot, '进行中', '填充', HOT_CAPACITY_CHARS + 200)
  await writeFile(at(vault, HOT), hot)
  const before = await read(vault, HOT)

  await assert.rejects(
    updateHot(binding, { section: '进行中', text: '还是塞不进去' }, deps),
    failsWith('hot-over-capacity'),
  )
  assert.equal(await read(vault, HOT), before, 'the cap is never silently exceeded')
  assert.equal(await exists(at(vault, ARCHIVE)), false, 'nothing was archived')
})

test('updateHot replays a repeated idempotencyKey without a second entry', async (t) => {
  const { vault, binding, deps } = await fixture(t)
  const request = { section: '强约束', text: '不得自动 commit', idempotencyKey: 'hot-1' }
  const first = await updateHot(binding, request, deps)
  const replay = await updateHot(binding, { ...request }, deps)

  assert.equal(replay.txId, first.txId)
  assert.equal(countOf(await read(vault, HOT), '不得自动 commit'), 1)

  // the same entry without a key is a content-level no-op as well
  const again = await updateHot(binding, { section: '强约束', text: '不得自动 commit' }, deps)
  assert.notEqual(again.txId, first.txId)
  assert.equal(countOf(await read(vault, HOT), '不得自动 commit'), 1)
})

// ---------------------------------------------------------------------------
// Step 1/4: the cold log
// ---------------------------------------------------------------------------

test('appendLog creates the day log and one block per session and section', async (t) => {
  const { vault, binding, deps } = await fixture(t)
  const receipt = await appendLog(
    binding,
    {
      session: 'sess-1',
      section: '决定',
      text: '采用可插拔调度器。',
      idempotencyKey: 'log-1',
    },
    deps,
  )

  const logPath = `${LOGS}/${TODAY}.md`
  assert.equal(receipt.action, 'log')
  assert.equal(receipt.paths[0], logPath)
  assert.equal(receipt.sessionId, 'sess-1')
  const log = await read(vault, logPath)
  const note = parseNote(await readFile(at(vault, logPath)))
  assert.equal(note.data.type, 'session-log')
  assert.equal(note.data.session, null, 'a day log is never attributed to one session')
  assert.equal(note.data.updated, TODAY)
  assert.equal(log.includes('## sess-1 · 决定'), true)
  assert.equal(log.includes('采用可插拔调度器。'), true)
  assert.equal(log.includes('<!-- mem-log:sess-1:决定 -->'), true)

  const second = await appendLog(
    binding,
    { session: 'sess-1', section: '下一步', text: '补测试。' },
    deps,
  )
  assert.notEqual(second.txId, receipt.txId)
  const grown = await read(vault, logPath)
  assert.equal(grown.includes('## sess-1 · 下一步'), true)
  assert.equal(grown.includes('补测试。'), true)
  assert.equal(
    grown.includes('采用可插拔调度器。'),
    true,
    'appending never rewrites the earlier blocks',
  )
})

test('appendLog is idempotent per session/seq and per idempotencyKey', async (t) => {
  const { vault, binding, deps } = await fixture(t)
  const logPath = `${LOGS}/${TODAY}.md`
  const request = {
    session: 'sess-1',
    section: '决定',
    seq: 7,
    text: '采用 A。',
    idempotencyKey: 'log-7',
  }
  const first = await appendLog(binding, request, deps)
  const before = await read(vault, logPath)

  const replay = await appendLog(binding, { ...request }, deps)
  assert.equal(replay.txId, first.txId)
  assert.equal(await read(vault, logPath), before)

  // same session/seq, a different key: the content-level guard still holds
  const guarded = await appendLog(
    binding,
    { session: 'sess-1', section: '决定', seq: 7, text: '采用 A。' },
    deps,
  )
  assert.notEqual(guarded.txId, first.txId)
  const after = await read(vault, logPath)
  assert.equal(after, before, 'a different key must not duplicate the same session/seq block')
  assert.equal(countOf(after, '<!-- mem-log:sess-1:7 -->'), 1)
  assert.equal(countOf(after, '采用 A。'), 1)
})

// ---------------------------------------------------------------------------
// Step 4: the read-only file and the pristine bytes
// ---------------------------------------------------------------------------

test('every write leaves _meta/user.md and the receipt log append-only', async (t) => {
  const { vault, binding, deps } = await fixture(t)
  const logBefore = await exists(at(vault, '_meta/log.md'))
  assert.equal(logBefore, false, 'bootstrap never creates the shared receipt log')

  await writeMemory(binding, { type: 'decision', title: '调度器', body: '采用 A' }, deps)
  await writeMemory(binding, { type: 'convention', title: '只用 ESM', body: 'no require' }, deps)
  await appendLog(binding, { session: 'sess-1', section: '决定', text: '采用 A。' }, deps)
  await updateHot(binding, { section: '进行中', text: '接通热层' }, deps)

  assert.equal(await read(vault, '_meta/user.md'), USER_MD)
  const log = await read(vault, '_meta/log.md')
  assert.equal(log.includes('— write'), true)
  assert.equal(log.includes('— log'), true)
  assert.equal(log.includes('— hot'), true)
  // nothing in the vault holds a transaction temp or a lock
  const stray = (await readdir(at(vault, DOCS))).filter(
    (name) => name.startsWith('.') || name.endsWith('.tmp'),
  )
  assert.deepEqual(stray, [])
})

// ---------------------------------------------------------------------------
// Helpers for reading the generated region
// ---------------------------------------------------------------------------

const GENERATED_BEGIN = '<!-- obsidian-mem:generated begin sha256:'
const GENERATED_END = '<!-- obsidian-mem:generated end -->'

/** Split a note around its generated block, by the bytes themselves. */
function generatedBlock(text) {
  const block = splitGenerated(text)
  assert.equal(
    sha256(block.body),
    block.declaredHash,
    'the declared hash must match the block body',
  )
  return block
}

function splitGenerated(text) {
  const beginAt = text.indexOf(GENERATED_BEGIN)
  assert.notEqual(beginAt, -1, 'the note must carry a generated block')
  const hashStart = beginAt + GENERATED_BEGIN.length
  const beginEnd = text.indexOf(' -->', hashStart)
  const bodyStart = text.indexOf('\n', beginEnd) + 1
  const endAt = text.indexOf(GENERATED_END, bodyStart)
  assert.notEqual(endAt, -1, 'the generated block must close')
  let bodyEnd = endAt
  if (text[bodyEnd - 1] === '\n') bodyEnd -= 1
  if (text[bodyEnd - 1] === '\r') bodyEnd -= 1
  return {
    prefix: text.slice(0, beginAt),
    declaredHash: text.slice(hashStart, beginEnd),
    body: text.slice(bodyStart, bodyEnd),
    suffix: text.slice(endAt + GENERATED_END.length),
  }
}
