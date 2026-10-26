// Task 3: the hot file's aggregate archive line and the compact that recovers it.
//
// Every case runs against a REAL temporary vault and a REAL throwaway data root:
// the planner is pure, but the only way to prove "a later write at the capacity
// boundary succeeds" is to drive the transaction engine that refused it first.
//
// The fixture is written by hand where the shape matters (120 short active
// entries, a zone of legacy per-entry pointers) because the measured bug is about
// bytes, and one character of payload per entry is what made a 46-cp entry cost
// more than the ~30-cp aggregate that replaces it.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { compactHot, hotStatus, isPointerLine, updateHot } from '../lib/hot.js'
import {
  applyPointers,
  archiveCandidates,
  archiveLine,
  foldPointers,
  zoneStats,
} from '../lib/hot-archive.js'
import { bootstrapVault } from '../lib/vault.js'

const PROJECT_ID = '1c392abb-7b08-42f7-871d-2a379caf9448'
const PROJECT = `Projects/alpha--${PROJECT_ID.slice(0, 8)}`
const HOT = `${PROJECT}/_meta/hot.md`
const ARCHIVE = `${PROJECT}/Docs/hot-archive.md`
const NOW = new Date()
const codePoints = (text) => [...text].length
const at = (vault, relative) => join(vault, ...relative.split('/'))
const read = (vault, relative) => readFile(at(vault, relative), 'utf8')
const countOf = (haystack, needle) => String(haystack).split(needle).length - 1

/** A stable, HOT_ENTRY_PATTERN-shaped id for test entry number `index`. */
const idFor = (index) => `hot-00000000-0000-4000-8000-${String(index).padStart(12, '0')}`

/** One complete plugin entry with a one-character payload. */
const shortEntry = (index) => `- [${idFor(index)}] ${String.fromCharCode(0x4e00 + index)}`

/** A legacy per-entry pointer line, exactly the bytes the old writer produced. */
const legacyPointer = (index) =>
  `- [${idFor(index)}] 已归档 → [[${PROJECT}/Docs/hot-archive|热记忆归档]]`

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'obsidian-mem-hot-'))
  const dataRoot = await mkdtemp(join(tmpdir(), 'obsidian-mem-hot-data-'))
  t.after(() =>
    Promise.all([
      rm(root, { recursive: true, force: true, maxRetries: 4 }),
      rm(dataRoot, { recursive: true, force: true, maxRetries: 4 }),
    ]),
  )
  const home = join(root, 'home')
  await mkdir(home, { recursive: true })
  const vault = join(root, 'vault')
  const binding = {
    kind: 'bound',
    projectId: PROJECT_ID,
    slug: 'alpha',
    displayName: 'alpha',
    schema: 1,
    vaultRoot: vault,
    relativeDir: PROJECT,
  }
  await bootstrapVault(binding, { dataRoot, home })
  return { vault, binding, deps: { dataRoot, home, now: NOW } }
}

/** Rewrite the three zones of the bootstrapped hot file from explicit line lists. */
async function hotWith(vault, zones) {
  let hot = await read(vault, HOT)
  for (const [name, lines] of Object.entries(zones)) {
    hot = hot.replace(`## ${name}\n`, `## ${name}\n\n${lines.join('\n')}\n`)
  }
  await writeFile(at(vault, HOT), hot)
  return hot
}

/** A capacity whose archival trigger is exactly `trigger`. */
const depsAt = (deps, capacity, trigger) => ({
  ...deps,
  capacityChars: capacity,
  archiveRatio: trigger / capacity,
})

test('archiveLine renders the one aggregate pointer, and it is still a pointer', () => {
  assert.equal(
    archiveLine(13, ARCHIVE),
    `- 已归档 13 条 → [[${PROJECT}/Docs/hot-archive|热记忆归档]]`,
  )
  assert.equal(isPointerLine(archiveLine(13, ARCHIVE), ARCHIVE), true)
  assert.equal(isPointerLine(legacyPointer(1), ARCHIVE), true, 'legacy pointers migrate too')
})

test('zoneStats counts an aggregate line as one pointer and the entries as entries', () => {
  const text = ['## 已完成', '', archiveLine(13, ARCHIVE), shortEntry(1), ''].join('\n')
  const [zone] = zoneStats(text, { archivePath: ARCHIVE, sections: ['已完成'] })
  assert.deepEqual(
    { entries: zone.entries, pointers: zone.pointers, moveable: zone.moveable },
    { entries: 1, pointers: 1, moveable: 1 },
  )
})

test('foldPointers migrates legacy pointers and leaves an unparseable pointer alone', () => {
  const parseable = [0, 1, 2].map(legacyPointer)
  const unparseable = `- 已归档 未知 → [[${PROJECT}/Docs/hot-archive|热记忆归档]]`
  const text = [
    '## 已完成',
    '',
    ...parseable,
    unparseable,
    '',
    '## 进行中',
    '',
    legacyPointer(3),
    '',
    '## 强约束',
    '',
  ].join('\n')
  const folded = foldPointers(text, ARCHIVE)
  assert.equal(folded.removed, 4, 'three legacy pointers in 已完成 and one in 进行中')
  assert.equal(countOf(folded.text, archiveLine(3, ARCHIVE)), 1, '已完成 becomes one line')
  assert.equal(countOf(folded.text, archiveLine(1, ARCHIVE)), 1, '进行中 becomes one line')
  assert.equal(folded.text.includes(unparseable), true, 'an unparseable pointer is left alone')
  for (const index of [0, 1, 2, 3]) {
    assert.equal(folded.text.includes(idFor(index)), false, 'the ids leave the injected text')
  }
})

test('applyPointers leaves one aggregate per zone and accumulates an existing count', () => {
  const text = [
    '## 已完成',
    '',
    archiveLine(3, ARCHIVE),
    shortEntry(0),
    '',
    '## 进行中',
    '',
    legacyPointer(1),
    shortEntry(2),
    '',
  ].join('\n')
  const { zones, candidates } = archiveCandidates(text, {
    archivePath: ARCHIVE,
    sections: ['已完成', '进行中'],
  })
  const next = applyPointers(text, zones, candidates, ARCHIVE)
  assert.equal(countOf(next, '已归档'), 2, 'one aggregate line per affected zone')
  assert.match(next, /已归档 4 条/, '已完成 accumulates its own count (3 + 1)')
  assert.match(next, /已归档 2 条/, '进行中 counts its legacy pointer and the moved entry')
  for (const index of [0, 1, 2]) {
    assert.equal(next.includes(idFor(index)), false, 'no per-entry pointer survives the move')
  }
})

test('compact frees short 进行中 entries and the next write at the boundary succeeds', async (t) => {
  const { vault, binding, deps } = await fixture(t)
  await hotWith(vault, { 进行中: Array.from({ length: 120 }, (_, index) => shortEntry(index)) })
  const before = await hotStatus(binding, depsAt(deps, 4600, 4000))
  const beforeText = await read(vault, HOT)
  assert.equal(before.used, codePoints(beforeText))
  assert.ok(before.used > 5000, `120 short entries measured ${before.used} cp`)
  assert.ok(before.used > before.trigger, 'the fixture starts over its trigger')
  assert.equal(before.archivable, 0, 'nothing in 已完成 may be archived automatically')
  assert.equal(before.compactable, 120, 'all 120 active entries are compactable')
  await assert.rejects(
    updateHot(binding, { section: '进行中', text: '塞不进去' }, depsAt(deps, 4600, 4000)),
    (error) => error.code === 'hot-over-capacity',
    'the pre-compact write is refused: the fixture is over its cap',
  )

  const { outcome } = await compactHot(binding, depsAt(deps, 4600, 4000))
  assert.ok(outcome.moved > 0, 'compact frees at least one short 进行中 entry')
  assert.ok(outcome.reclaimed > 0, 'and the file is strictly smaller')
  assert.ok(outcome.used <= 4000, `compact reaches its trigger: ${outcome.used}`)

  const after = await read(vault, HOT)
  assert.ok(codePoints(after) <= 4000)
  const progress = after.slice(after.indexOf('## 进行中'), after.indexOf('## 已完成'))
  const aggregate = progress.match(/^- 已归档 (\d+) 条 → \[\[/m)
  assert.ok(aggregate !== null, '进行中 keeps one aggregate pointer')
  assert.equal(Number(aggregate[1]), outcome.moved, 'the aggregate count is what moved')
  assert.equal(countOf(progress, '已归档'), 1, 'one pointer line for the zone')
  const remaining = progress.split('\n').filter((line) => line.startsWith('- [hot-'))
  assert.equal(remaining.length, 120 - outcome.moved, 'every unmoved entry is still there')
  for (let index = 0; index < 120; index += 1) {
    const present = after.includes(String.fromCharCode(0x4e00 + index))
    assert.equal(present, index >= outcome.moved, `entry ${index} follows the prefix order`)
  }

  const archive = await read(vault, ARCHIVE)
  assert.equal(archive.includes('已归档'), false, 'a pointer is never archived')
  const filed = archive.split('\n').filter((line) => line.startsWith('- [hot-'))
  assert.equal(filed.length, outcome.moved, 'every moved entry is filed exactly once')
  for (let index = 0; index < outcome.moved; index += 1) {
    assert.equal(
      countOf(archive, String.fromCharCode(0x4e00 + index)),
      1,
      'one full line per moved entry, no pointer',
    )
  }

  const write = await updateHot(
    binding,
    { section: '进行中', text: '边界之后' },
    depsAt(deps, 4600, 4000),
  )
  assert.ok(write.paths.includes(HOT))
  assert.equal((await read(vault, HOT)).includes('边界之后'), true)
})

test('an automatic archive leaves one aggregate pointer and a later pass accumulates it', async (t) => {
  const { vault, binding, deps } = await fixture(t)
  const trigger = 500
  await hotWith(vault, {
    进行中: [`- 填充${'x'.repeat(400)}`],
    已完成: [shortEntry(0), shortEntry(1)],
  })
  // Force the trigger with the tight budget on a write whose own entry is excluded.
  let hot = await read(vault, HOT)
  assert.ok(codePoints(hot) > trigger, 'the fixture is over the trigger')
  await updateHot(binding, { section: '进行中', text: '触发' }, depsAt(deps, 1000, trigger))

  let status = await hotStatus(binding, depsAt(deps, 1000, trigger))
  let done = status.sections.find((zone) => zone.name === '已完成')
  assert.deepEqual(
    { entries: done.entries, pointers: done.pointers },
    { entries: 0, pointers: 1 },
    'the zone is one aggregate pointer and no entries',
  )
  hot = await read(vault, HOT)
  const first = hot.slice(hot.indexOf('## 已完成'))
  assert.match(first, /已归档 2 条/, 'the two moved entries are one count')

  // A second pass folds the next archive into the same line.
  hot = await read(vault, HOT)
  hot = hot.replace('## 已完成\n', `## 已完成\n\n${shortEntry(2)}\n`)
  await writeFile(at(vault, HOT), hot)
  await updateHot(binding, { section: '进行中', text: '再触发' }, depsAt(deps, 1000, trigger))
  hot = await read(vault, HOT)
  const doneZone = hot.slice(hot.indexOf('## 已完成'))
  assert.match(doneZone, /已归档 3 条/, 'the aggregate accumulates instead of stacking pointers')
  assert.equal(countOf(doneZone, '已归档'), 1, 'still exactly one pointer line')
})

test('automatic archival never moves 强约束, and compact drains 已完成 before 进行中', async (t) => {
  const { vault, binding, deps } = await fixture(t)
  const constraint = shortEntry(9)
  const huge = (index, size) => `- [${idFor(index)}] ${'记'.repeat(size)}`
  await hotWith(vault, {
    强约束: [constraint],
    已完成: [huge(0, 400)],
    进行中: [huge(1, 400)],
  })
  // Automatic archival at the write's trigger takes 已完成 alone.
  await updateHot(binding, { section: '进行中', text: '自动' }, depsAt(deps, 1000, 500))
  let hot = await read(vault, HOT)
  assert.equal(hot.includes(constraint), true, 'a hard constraint is never moved')
  assert.equal(hot.includes('记'.repeat(400)), true, 'the 进行中 entry is still injected')

  // A fresh 已完成 entry, then an explicit compact that the one entry is enough for.
  const roomy = depsAt(deps, 60000, 40200)
  await updateHot(binding, { section: '已完成', text: `待压缩${'记'.repeat(200)}` }, roomy)
  const tight = depsAt(deps, 1200, 950)
  const { outcome } = await compactHot(binding, tight)
  assert.equal(outcome.moved, 1, 'only the 已完成 entry was needed')
  hot = await read(vault, HOT)
  const progress = hot.slice(hot.indexOf('## 进行中'), hot.indexOf('## 已完成'))
  assert.equal(progress.includes('记'.repeat(400)), true, '进行中 was not drained')
  assert.equal(countOf(progress, '已归档'), 0, 'and it has no pointer line')
  const done = hot.slice(hot.indexOf('## 已完成'))
  assert.match(done, /已归档 2 条/, 'the auto-archived entry and the compacted one share a line')
  assert.equal(hot.includes(constraint), true, 'the constraint is still there after compact')
})
