// Task 2: the bounded curation scanner and the private state it resumes from.
//
// Every case runs in the isolated world Task 1 built (`curation-world.js`): a real
// temporary vault, a real Git repository and a throwaway plugin data root, driven
// through the shipped service layer. Nothing here reads the user's home, a real
// vault or a real `$DSH_HOME`.
//
// The assertions are about behaviour a later task depends on, in the order the
// plan states them:
//
//   * a pass is bounded by BOTH a note count and a wall-clock deadline, and a
//     bounded pass carries an explicit cursor and truncation reason;
//   * a later pass resumes where the previous one stopped instead of recounting
//     earlier notes, and only a completed backfill may claim `complete: true`;
//   * a manifest that changed between batches restarts the backfill rather than
//     publishing a partial "complete" view;
//   * the private state (cursor, per-path records, changed-path set) is durable,
//     de-duplicated, versioned, size-bounded and permission-tight;
//   * no pass, bounded or complete, changes a single source-note byte.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  CURATION_DIR_MODE,
  CURATION_FILE_MODE,
  MAX_CHANGED_PATHS,
  MAX_CURSOR_BYTES,
  SCAN_RECORD_SCHEMA,
  ackChangedSources,
  curationChangedPath,
  curationCursorPath,
  curationRecordDir,
  curationRecordPath,
  enqueueChangedSource,
  readChangedSources,
  readCurationCursor,
} from '../lib/curation-state.js'
import { inspectCurationNote, scanCuration, MAX_NOTE_FINDINGS } from '../lib/curation-scan.js'
import { MAX_NOTE_BYTES, isIndexableRelativePath } from '../lib/index-db.js'
import { parseNote } from '../lib/frontmatter.js'
import { writeMemory } from '../lib/memory.js'
import { noteLinkFindings, noteReviewFinding } from '../lib/note-health.js'
import { resolveBinding } from '../lib/vault.js'
import { listMarkdown, makeCurationWorld } from './curation-world.js'

/** The clock every case injects, so `scannedAt` and the review date are fixed. */
const NOW = new Date('2026-10-03T04:00:00Z')

/** The sha256 of a byte sequence. */
function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

/** The manifest fingerprint exactly as `lib/curation-scan.js` defines it. */
function fingerprintOf(paths) {
  return sha256(paths.map((path) => `${path}\n`).join(''))
}

/** The binding the world's first write created, resolved through the shipped seam. */
async function bindingOf(world) {
  const binding = await resolveBinding({
    cwd: world.repo,
    vaultRoot: world.vault,
    mode: 'show',
    home: world.home,
  })
  assert.equal(binding.kind, 'bound', JSON.stringify(binding))
  return binding
}

/** One bounded pass with the world's seams, so no case has to repeat them. */
function scan(world, binding, options = {}) {
  return scanCuration(binding, {
    dataRoot: world.dataRoot,
    home: world.home,
    now: NOW,
    ...options,
  })
}

/** The sorted vault-relative paths a pass must see as this project's manifest. */
async function manifestOf(world, binding) {
  return (await listMarkdown(world.vault, binding.relativeDir)).filter(isIndexableRelativePath)
}

/** `path -> sha256` for every file under a tree, so "unchanged" is about bytes. */
async function hashTree(root) {
  const found = new Map()
  const walk = async (directory, prefix) => {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
      left.name < right.name ? -1 : 1,
    )
    for (const entry of entries) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) await walk(join(directory, entry.name), relative)
      else if (entry.isFile())
        found.set(relative, sha256(await readFile(join(directory, entry.name))))
    }
  }
  await walk(root, '')
  return found
}

/** Write one hand-made note into the vault, creating its directories. */
async function writeRaw(world, relativePath, text) {
  const segments = relativePath.split('/')
  await mkdir(join(world.vault, ...segments.slice(0, -1)), { recursive: true })
  await writeFile(join(world.vault, ...segments), text, 'utf8')
}

/** Read one note's bytes back out of the vault. */
function vaultFile(world, relativePath) {
  return join(world.vault, ...relativePath.split('/'))
}

/**
 * One hand-written, plugin-shaped note.
 *
 * `fields` are extra frontmatter lines, which is how the missing-provenance and
 * expired-review cases are built: the scanner reads the same bytes Obsidian does,
 * so a fixture that omits `source` must be a file that really omits it.
 */
function handNote({ id, type = 'doc', title, extra = [], body = '正文。\n' }) {
  return [
    '---',
    `id: ${id}`,
    `type: ${type}`,
    `title: ${JSON.stringify(title)}`,
    'status: active',
    'created: 2026-01-01',
    'updated: 2026-01-01',
    ...extra,
    '---',
    body,
  ].join('\n')
}

/** A world with `count` plain notes written through the service layer. */
async function worldWithNotes(t, count) {
  const world = await makeCurationWorld(t)
  const written = []
  for (let index = 0; index < count; index += 1) {
    written.push(
      await world.services.write({
        type: 'doc',
        title: `条目 ${index}`,
        body: `第 ${index} 条正文。\n`,
      }),
    )
  }
  return { world, binding: await bindingOf(world), written }
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

test('one pass classifies active, exact, near, expired, broken-link and unexamined notes', async (t) => {
  const world = await makeCurationWorld(t, {
    config: { ignoreGlobs: ['**/Docs/用户排除.md'] },
  })
  const { services } = world

  const active = await services.write({
    type: 'convention',
    title: '导出格式',
    body: '导出时使用 JSON。\n',
  })
  // Same project, type, title and body: an exact duplicate, a different id and a
  // different path (a title is a rendering, never an identity).
  const twinA = await services.write({
    type: 'decision',
    title: '预算上限',
    body: '预算是 12 万。\n',
  })
  const twinB = await services.write({
    type: 'decision',
    title: '预算上限',
    body: '预算是 12 万。\n',
  })
  // Same title, a different number: a near duplicate, never an exact one.
  const near = await services.write({
    type: 'decision',
    title: '预算上限',
    body: '预算是 13 万。\n',
  })
  const linker = await services.write({
    type: 'doc',
    title: '引用者',
    body: `见 [[${active.path.replace(/\.md$/, '')}]]、[[导出格式]] 与 [[不存在的东西]]。\n`,
  })
  const binding = await bindingOf(world)
  const projectDir = binding.relativeDir
  // `review_after` is not one of `mem_write`'s tool arguments, so the note that
  // carries it is written through the memory seam the tool itself calls.
  const expired = await writeMemory(
    binding,
    { type: 'decision', title: '待复盘', body: '需要复盘。\n', review_after: '2000-01-01' },
    { dataRoot: world.dataRoot, home: world.home },
  )

  // A hand-written note that parses and is retrieved, but declares no provenance.
  const naked = `${projectDir}/Docs/无出处.md`
  await writeRaw(
    world,
    naked,
    handNote({
      id: 'doc-11111111-1111-4111-8111-111111111111',
      title: '无出处',
      extra: [`project: ${binding.projectId}`, 'trust: agent'],
    }),
  )
  const broken = `${projectDir}/Docs/损坏.md`
  await writeRaw(world, broken, '---\ntitle: [未闭合\n---\n正文。\n')
  const oversized = `${projectDir}/Docs/超大.md`
  await writeRaw(world, oversized, 'x'.repeat(MAX_NOTE_BYTES + 1))
  // One note excluded by the user's own globs and one the safety exclusions own.
  const excluded = `${projectDir}/Docs/用户排除.md`
  await writeRaw(
    world,
    excluded,
    handNote({ id: 'doc-22222222-2222-4222-8222-222222222222', title: '用户排除' }),
  )
  const dependency = `${projectDir}/node_modules/依赖.md`
  await writeRaw(
    world,
    dependency,
    handNote({ id: 'doc-33333333-3333-4333-8333-333333333333', title: '依赖' }),
  )

  const result = await scan(world, binding, { ignoreGlobs: world.config.ignoreGlobs })
  assert.equal(result.complete, true)
  assert.equal(result.truncatedReason, null)
  assert.ok(result.manifest.count >= result.entries.length)

  const paths = result.entries.map((entry) => entry.path)
  for (const expected of [active, twinA, twinB, near, expired, linker]) {
    assert.ok(paths.includes(expected.path), `missing ${expected.path}`)
  }
  // A provenance gap is a finding about a note, not a reason to hide it.
  assert.ok(paths.includes(naked), JSON.stringify(paths))
  // A note this pass could not inspect contributes no navigation entry at all.
  for (const absent of [broken, oversized, excluded, dependency]) {
    assert.equal(paths.includes(absent), false, `${absent} must not be an entry`)
  }

  const groups = result.exactGroups
  assert.equal(groups.length, 1, JSON.stringify(groups))
  assert.deepEqual(groups[0].paths, [twinA.path, twinB.path].sort())
  assert.equal(groups[0].type, 'decision')

  const kindsOf = (kind) => result.findings.filter((finding) => finding.kind === kind)
  const review = kindsOf('expired-review')
  assert.deepEqual(
    review.map((finding) => finding.path),
    [expired.path],
  )
  assert.match(review[0].message, /2000-01-01/)

  // A vault-relative link and a bare basename both resolve; only the target that
  // names nothing is reported.
  const dead = kindsOf('dead-wikilink')
  assert.deepEqual(
    dead.map((finding) => finding.target),
    ['不存在的东西'],
  )
  assert.equal(dead[0].path, linker.path)

  const provenance = kindsOf('missing-provenance')
  assert.deepEqual(
    provenance.map((finding) => finding.path),
    [naked],
  )
  assert.deepEqual(provenance[0].missing.sort(), ['harness', 'source'])

  const unexamined = kindsOf('unexamined')
  assert.deepEqual(
    unexamined.map((finding) => [finding.path, finding.reason]).sort(),
    [
      [broken, 'frontmatter'],
      [oversized, 'oversize'],
    ].sort(),
  )

  const nearDuplicate = kindsOf('near-duplicate')
  assert.equal(nearDuplicate.length, 1, JSON.stringify(nearDuplicate))
  assert.equal(nearDuplicate[0].paths.includes(near.path), true)
  assert.equal(nearDuplicate[0].paths.length, 2, JSON.stringify(nearDuplicate[0].paths))
  assert.equal(
    nearDuplicate[0].paths.some((path) => path === twinA.path || path === twinB.path),
    true,
  )

  // Every entry carries the source hash a reader verifies before injecting it.
  assert.ok(result.entries.every((entry) => /^[0-9a-f]{64}$/u.test(entry.hash)))
  const activeEntry = result.entries.find((entry) => entry.path === active.path)
  assert.equal(activeEntry.type, 'convention')
  assert.equal(activeEntry.title, '导出格式')
  assert.equal(activeEntry.description.includes('\n'), false)
  assert.ok(activeEntry.description.length <= 200)
})

test('inspectCurationNote reports a dead link only when it is given a resolver', async (t) => {
  const { world, binding, written } = await worldWithNotes(t, 1)
  const path = written[0].path
  const bytes = await readFile(vaultFile(world, path))
  const note = parseNote(bytes)
  const body = '见 [[不存在的目标]]，另见 `[[代码里的目标]]`。\n'
  const parsed = { ...note, body }

  const withoutResolver = inspectCurationNote({
    binding,
    path,
    note: parsed,
    hash: sha256(bytes),
    now: NOW,
  })
  assert.deepEqual(withoutResolver.findings, [])
  assert.equal(withoutResolver.entry.exactKey.length, 64)

  const dead = inspectCurationNote({
    binding,
    path,
    note: parsed,
    hash: sha256(bytes),
    now: NOW,
    resolves: () => false,
  })
  assert.deepEqual(
    dead.findings.map((finding) => finding.target),
    ['不存在的目标'],
  )

  const alive = inspectCurationNote({
    binding,
    path,
    note: parsed,
    hash: sha256(bytes),
    now: NOW,
    resolves: () => true,
  })
  assert.deepEqual(alive.findings, [])
})

test('the shared note-health helpers keep the linter vocabulary', () => {
  // `today` is the linter's local date; a date equal to it is not yet due, and a
  // history note is never due however old its `review_after` is.
  assert.equal(noteReviewFinding({ review_after: '2026-10-03' }, '2026-10-03'), null)
  assert.equal(
    noteReviewFinding({ review_after: '2026-10-02' }, '2026-10-03').reviewAfter,
    '2026-10-02',
  )
  assert.equal(
    noteReviewFinding({ review_after: '2000-01-01', status: 'superseded' }, '2026-10-03'),
    null,
  )
  assert.equal(
    noteReviewFinding({ review_after: '2000-01-01', status: 'archived' }, '2026-10-03'),
    null,
  )
  // No resolver is "cannot judge", never "every link is dead"; a repeated target
  // is one finding, exactly as the lint report has it.
  assert.deepEqual(noteLinkFindings('[[甲]] [[甲]] `[[乙]]`', 'a/b.md', null), [])
  assert.deepEqual(
    noteLinkFindings('[[甲]] [[甲]] `[[乙]]`', 'a/b.md', () => false).map(
      (finding) => finding.target,
    ),
    ['甲'],
  )
})

// ---------------------------------------------------------------------------
// Bounds and resumption
// ---------------------------------------------------------------------------

test('maxNotes bounds one pass and the next pass resumes without recounting', async (t) => {
  const { world, binding, written } = await worldWithNotes(t, 5)
  const manifest = await manifestOf(world, binding)
  assert.ok(manifest.length > written.length)

  const first = await scan(world, binding, { maxNotes: 1, maxMs: 500 })
  assert.equal(first.complete, false)
  assert.equal(first.examined, 1)
  assert.ok(first.cursor)
  assert.equal(first.truncatedReason, 'file-budget')
  assert.deepEqual(first.examinedPaths, [manifest[0]])

  const seen = [...first.examinedPaths]
  let result = first
  let passes = 1
  while (result.complete !== true) {
    result = await scan(world, binding, { maxNotes: 1, maxMs: 500 })
    passes += 1
    assert.equal(result.examined, 1, `pass ${passes} inspected ${result.examined}`)
    seen.push(...result.examinedPaths)
    assert.ok(passes < 50, 'a bounded pass must make progress')
  }

  // Every manifest path was inspected exactly once, and the completed result
  // carries the records of every batch — not only the last one.
  assert.deepEqual(seen, manifest)
  assert.deepEqual(
    result.entries.map((entry) => entry.path),
    manifest,
  )
  assert.equal(result.truncatedReason, null)
  assert.equal(result.cursor.afterPath, manifest[manifest.length - 1])
  assert.equal(result.cursor.manifestFingerprint, fingerprintOf(manifest))
  assert.deepEqual(await readCurationCursor(world.dataRoot, binding.projectId), result.cursor)
})

test('a manifest that changed between batches restarts the backfill before it completes', async (t) => {
  const { world, binding, written } = await worldWithNotes(t, 3)
  const before = await manifestOf(world, binding)

  const first = await scan(world, binding, { maxNotes: 1 })
  assert.equal(first.complete, false)
  assert.equal(first.cursor.afterPath, before[0])

  // A path appears between two batches.
  const added = await world.services.write({ type: 'doc', title: '新增条目', body: '新增正文。\n' })
  const after = await manifestOf(world, binding)
  assert.equal(after.length, before.length + 1)
  assert.notEqual(fingerprintOf(after), fingerprintOf(before))

  const restarted = await scan(world, binding, { maxNotes: 1 })
  assert.equal(restarted.complete, false)
  assert.equal(restarted.truncatedReason, 'manifest-changed')
  // The restart walks the new manifest from its first path, not from the old cursor.
  assert.deepEqual(restarted.examinedPaths, [after[0]])

  let result = restarted
  let guard = 0
  while (result.complete !== true) {
    result = await scan(world, binding, { maxNotes: 2 })
    guard += 1
    assert.ok(guard < 50, 'the restarted backfill must finish')
  }
  assert.deepEqual(
    result.entries.map((entry) => entry.path),
    after,
  )
  assert.ok(result.entries.some((entry) => entry.path === added.path))

  // A path disappears between two batches: same rule, and the removed note leaves
  // the view instead of staying in it as a stale entry.
  const removed = written[0].path
  await rm(vaultFile(world, removed))
  const shrunk = await manifestOf(world, binding)
  const afterRemoval = await scan(world, binding, { maxNotes: 1 })
  assert.equal(afterRemoval.complete, false)
  assert.equal(afterRemoval.truncatedReason, 'manifest-changed')

  let final = afterRemoval
  guard = 0
  while (final.complete !== true) {
    final = await scan(world, binding, { maxNotes: 2 })
    guard += 1
    assert.ok(guard < 50, 'the restarted backfill must finish')
  }
  assert.deepEqual(
    final.entries.map((entry) => entry.path),
    shrunk,
  )
  assert.equal(
    final.entries.some((entry) => entry.path === removed),
    false,
  )
})

test('maxMs: 0 reports a time budget without reading a note', async (t) => {
  const { world, binding } = await worldWithNotes(t, 3)
  const before = await hashTree(world.vault)

  const result = await scan(world, binding, { maxMs: 0, maxNotes: 10 })
  assert.equal(result.complete, false)
  assert.equal(result.truncatedReason, 'time-budget')
  assert.equal(result.examined, 0)
  assert.deepEqual(result.examinedPaths, [])
  assert.deepEqual(result.entries, [])
  assert.deepEqual(result.findings, [])
  assert.equal(result.cursor.afterPath, null)
  // Nothing was inspected, so nothing was recorded.
  await assert.rejects(stat(curationRecordDir(world.dataRoot, binding.projectId)), {
    code: 'ENOENT',
  })
  assert.deepEqual(await hashTree(world.vault), before)

  // A deadline reached mid-pass stops before the *next* read rather than at the
  // end of the manifest: two notes fit in 250 ms of this stepped clock, the third
  // does not start.
  let ticks = 0
  const stepped = await scan(world, binding, {
    maxMs: 250,
    maxNotes: 100,
    clock: () => (ticks += 100),
  })
  assert.equal(stepped.truncatedReason, 'time-budget')
  assert.equal(stepped.complete, false)
  assert.equal(stepped.examined, 2)
})

// ---------------------------------------------------------------------------
// Path refusals
// ---------------------------------------------------------------------------

test('a path outside the project, through the jail, or through a symlink is refused', async (t) => {
  const { world, binding, written } = await worldWithNotes(t, 2)
  const other = `Projects/other--6a1f0b52/Docs/别家.md`
  await writeRaw(
    world,
    other,
    handNote({ id: 'doc-44444444-4444-4444-8444-444444444444', title: '别家' }),
  )

  await assert.rejects(
    enqueueChangedSource({ binding, dataRoot: world.dataRoot, path: other, home: world.home }),
    RangeError,
  )
  await assert.rejects(
    enqueueChangedSource({
      binding,
      dataRoot: world.dataRoot,
      path: `${binding.relativeDir}/../escape.md`,
      home: world.home,
    }),
    { code: 'unsafe-path' },
  )
  const link = `${binding.relativeDir}/Docs/软链.md`
  await symlink(vaultFile(world, written[0].path), vaultFile(world, link))
  await assert.rejects(
    enqueueChangedSource({ binding, dataRoot: world.dataRoot, path: link, home: world.home }),
    { code: 'unsafe-path' },
  )
  await assert.rejects(
    enqueueChangedSource({
      binding,
      dataRoot: world.dataRoot,
      path: `${binding.relativeDir}/index.md.txt`,
      home: world.home,
    }),
    RangeError,
  )

  await assert.rejects(scan(world, binding, { changedPaths: [other] }), RangeError)
  await assert.rejects(scan(world, binding, { changedPaths: [link] }), { code: 'unsafe-path' })
  // The per-note seam refuses the same path shape, so no caller can inspect a
  // note by handing it a path from another project's tree.
  assert.throws(
    () =>
      inspectCurationNote({
        binding,
        path: other,
        note: { hasFrontmatter: true, data: {}, body: '' },
        hash: 'a'.repeat(64),
        now: NOW,
      }),
    RangeError,
  )
  assert.deepEqual(await readChangedSources({ binding, dataRoot: world.dataRoot }), [])
})

test('a superseded note stays an entry but never joins a duplicate group', async (t) => {
  const world = await makeCurationWorld(t)
  const old = await world.services.write({
    type: 'convention',
    title: '导出格式',
    body: '导出时使用 CSV。\n',
  })
  const current = await world.services.write({
    type: 'convention',
    title: '导出格式',
    body: '导出时使用 JSON。\n',
    supersedes: old.id,
  })
  const binding = await bindingOf(world)
  const result = await scan(world, binding)
  assert.equal(result.complete, true)

  // History is still an entry — a view has to be able to learn that a note it
  // once showed is no longer current — and it carries the status that says so.
  const byPath = new Map(result.entries.map((entry) => [entry.path, entry]))
  assert.equal(byPath.get(old.path)?.status, 'superseded')
  assert.equal(byPath.get(current.path)?.status, 'active')
  // The two share a title and differ in meaning, but one of them is history, so
  // there is no current-memory near-duplicate to review.
  assert.deepEqual(
    result.findings.filter((finding) => finding.kind === 'near-duplicate'),
    [],
  )
})

test('a note with more findings than a record holds reports the count', async (t) => {
  const { world, binding } = await worldWithNotes(t, 1)
  const links = Array.from(
    { length: MAX_NOTE_FINDINGS + 5 },
    (unused, index) => `[[缺失-${index}]]`,
  )
  await writeRaw(
    world,
    `${binding.relativeDir}/Docs/多链.md`,
    handNote({
      id: 'doc-99999999-9999-4999-8999-999999999999',
      title: '多链',
      body: `${links.join(' ')}\n`,
    }),
  )

  const result = await scan(world, binding)
  assert.equal(result.complete, true)
  assert.equal(
    result.findings.filter((finding) => finding.kind === 'dead-wikilink').length,
    MAX_NOTE_FINDINGS,
  )
  const truncated = result.findings.find((finding) => finding.kind === 'findings-truncated')
  assert.ok(truncated, JSON.stringify(result.counts))
  assert.match(truncated.message, new RegExp(`has ${MAX_NOTE_FINDINGS + 5} findings`))
  // The capped record still fits its own reader: the next pass reuses it instead
  // of refusing it and inspecting the note again.
  const reread = await scan(world, binding)
  assert.equal(reread.complete, true)
  assert.deepEqual(reread.examinedPaths, [])
})

// ---------------------------------------------------------------------------
// The durable changed-path set
// ---------------------------------------------------------------------------

test('a changed path is de-duplicated, survives another process, and is acknowledged', async (t) => {
  const { world, binding, written } = await worldWithNotes(t, 2)
  const path = written[0].path

  await enqueueChangedSource({ binding, dataRoot: world.dataRoot, path, home: world.home })
  await enqueueChangedSource({ binding, dataRoot: world.dataRoot, path, home: world.home })
  assert.deepEqual(
    await readChangedSources({ binding, dataRoot: world.dataRoot, home: world.home }),
    [path],
  )

  // A brand-new process reads the same one path out of the data root.
  const script = [
    `import { readChangedSources } from ${JSON.stringify(new URL('../lib/curation-state.js', import.meta.url).href)}`,
    'const [bindingJson, dataRoot, home] = process.argv.slice(1)',
    'const paths = await readChangedSources({ binding: JSON.parse(bindingJson), dataRoot, home })',
    'process.stdout.write(JSON.stringify(paths))',
  ].join('\n')
  const output = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      script,
      JSON.stringify({
        kind: 'bound',
        projectId: binding.projectId,
        relativeDir: binding.relativeDir,
        vaultRoot: binding.vaultRoot,
      }),
      world.dataRoot,
      world.home,
    ],
    { cwd: world.repo, encoding: 'utf8' },
  )
  assert.deepEqual(JSON.parse(output), [path])

  // A bounded pass that was asked about exactly that path reports only its entry
  // and leaves the backfill cursor exactly as it was.
  const complete = await scan(world, binding)
  assert.equal(complete.complete, true)
  const cursorBytes = await readFile(curationCursorPath(world.dataRoot, binding.projectId))
  const changed = await scan(world, binding, { changedPaths: [path] })
  assert.deepEqual(changed.changedPaths, [path])
  assert.equal(changed.complete, true)
  assert.deepEqual(
    changed.entries.map((entry) => entry.path),
    [path],
  )
  assert.deepEqual(
    await readFile(curationCursorPath(world.dataRoot, binding.projectId)),
    cursorBytes,
  )

  const acknowledged = await ackChangedSources({
    binding,
    dataRoot: world.dataRoot,
    paths: [path],
    home: world.home,
  })
  assert.equal(acknowledged.acknowledged, 1)
  assert.equal(acknowledged.remaining, 0)
  assert.deepEqual(
    await readChangedSources({ binding, dataRoot: world.dataRoot, home: world.home }),
    [],
  )

  // The queue is bounded: at its cap the oldest hint is dropped, and the newest
  // one is still there. A dropped hint is repaired by the next full pass and by
  // the hash check a reader performs before injecting an entry.
  const synthetic = Array.from(
    { length: MAX_CHANGED_PATHS },
    (unused, index) => `${binding.relativeDir}/Docs/合成-${String(index).padStart(4, '0')}.md`,
  )
  await writeFile(
    curationChangedPath(world.dataRoot, binding.projectId),
    `${JSON.stringify({ version: 1, projectId: binding.projectId, paths: synthetic, updatedAt: NOW.toISOString() }, null, 2)}\n`,
    'utf8',
  )
  await enqueueChangedSource({ binding, dataRoot: world.dataRoot, path, home: world.home })
  const bounded = await readChangedSources({ binding, dataRoot: world.dataRoot, home: world.home })
  assert.equal(bounded.length, MAX_CHANGED_PATHS)
  assert.equal(bounded.includes(path), true)
  assert.equal(bounded.includes(synthetic[0]), false)
})

// ---------------------------------------------------------------------------
// Private state
// ---------------------------------------------------------------------------

test('private state is versioned, size-bounded and permission-tight', async (t) => {
  const { world, binding, written } = await worldWithNotes(t, 1)
  const path = written[0].path
  await scan(world, binding)
  await enqueueChangedSource({ binding, dataRoot: world.dataRoot, path, home: world.home })

  const cursorPath = curationCursorPath(world.dataRoot, binding.projectId)
  const recordPath = curationRecordPath(world.dataRoot, binding.projectId, path)
  const changedPath = curationChangedPath(world.dataRoot, binding.projectId)
  for (const file of [cursorPath, recordPath, changedPath]) {
    assert.equal((await stat(file)).mode & 0o777, CURATION_FILE_MODE, file)
  }
  assert.equal((await stat(join(world.dataRoot, 'curation'))).mode & 0o777, CURATION_DIR_MODE)

  const cursor = JSON.parse(await readFile(cursorPath, 'utf8'))
  assert.deepEqual(Object.keys(cursor).sort(), [
    'afterPath',
    'manifestFingerprint',
    'projectId',
    'scannedAt',
    'version',
  ])
  assert.equal(cursor.version, 1)
  assert.equal(cursor.projectId, binding.projectId)
  assert.equal(cursor.scannedAt, NOW.toISOString())
  const record = JSON.parse(await readFile(recordPath, 'utf8'))
  assert.equal(record.version, SCAN_RECORD_SCHEMA)
  assert.equal(record.path, path)
  assert.equal(record.hash, sha256(await readFile(vaultFile(world, path))))

  // The cursor reader refuses a wrong version, a wrong project and oversize data.
  const original = await readFile(cursorPath, 'utf8')
  for (const [name, document] of [
    ['version', { ...cursor, version: 99 }],
    ['project', { ...cursor, projectId: '6a1f0b52-0f6e-4a0f-9a0e-1d7a2f4b6c31' }],
    ['size', { ...cursor, afterPath: 'x'.repeat(MAX_CURSOR_BYTES) }],
  ]) {
    await writeFile(cursorPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
    await assert.rejects(readCurationCursor(world.dataRoot, binding.projectId), (error) => {
      assert.equal(error.name, 'CurationStateError', name)
      return true
    })
  }

  // A damaged cursor is reported and rebuilt, never silently trusted: the pass
  // restarts the backfill from the first path and this time completes it.
  const repaired = await scan(world, binding)
  assert.equal(repaired.complete, true)
  assert.equal(
    repaired.findings.some((finding) => finding.kind === 'cursor-invalid'),
    true,
  )
  assert.equal((await readCurationCursor(world.dataRoot, binding.projectId)).version, 1)

  // A record that cannot be read is treated as "not covered": the path is
  // inspected again in this pass instead of being claimed as complete.
  await writeFile(recordPath, '{ not json', 'utf8')
  const reread = await scan(world, binding)
  assert.equal(reread.complete, true)
  assert.equal(reread.examinedPaths.includes(path), true)
  assert.equal(
    reread.findings.some((finding) => finding.kind === 'record-unreadable'),
    true,
  )
  assert.equal(JSON.parse(await readFile(recordPath, 'utf8')).hash, record.hash)

  await writeFile(cursorPath, original, 'utf8')
})

// ---------------------------------------------------------------------------
// Read-only guarantee
// ---------------------------------------------------------------------------

test('no pass changes a source-note byte', async (t) => {
  const { world, binding, written } = await worldWithNotes(t, 3)
  const before = await hashTree(world.vault)

  const complete = await scan(world, binding)
  assert.equal(complete.complete, true)
  assert.deepEqual(await hashTree(world.vault), before)

  await enqueueChangedSource({
    binding,
    dataRoot: world.dataRoot,
    path: written[0].path,
    home: world.home,
  })
  await scan(world, binding, { changedPaths: [written[0].path] })
  await scan(world, binding, { maxNotes: 1 })
  await scan(world, binding, { maxMs: 0 })
  assert.deepEqual(await hashTree(world.vault), before)
})
