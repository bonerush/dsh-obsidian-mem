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
import { chmod, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  CURATION_DIR_MODE,
  CURATION_FILE_MODE,
  MAX_CHANGED_PATHS,
  MAX_CURSOR_BYTES,
  MAX_SCAN_RECORD_BYTES,
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
import {
  inspectCurationNote,
  scanCuration,
  MAX_ENTRY_TEXT_CHARS,
  MAX_NOTE_FINDINGS,
} from '../lib/curation-scan.js'
import { MAX_NOTE_BYTES, isIndexableRelativePath } from '../lib/index-db.js'
import { parseNote } from '../lib/frontmatter.js'
import { lintVault } from '../lib/lint.js'
import { writeMemory } from '../lib/memory.js'
import { noteLinkFindings, noteReviewFinding, createVaultLinkResolver } from '../lib/note-health.js'
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

/**
 * One bounded pass with the world's seams, so no case has to repeat them.
 *
 * The wall-clock bound is a step counter, not `Date.now`: the pass consults it once
 * per note and per batch, and the shipped 500-ms default turned every case that
 * asserts coverage — `complete`, `truncatedReason === null` — into an assertion about
 * machine load. Measured with the suite under eight concurrent fsync loaders (3.2x),
 * four of those cases failed with `time-budget` against a fixture of a handful of
 * notes. The two cases that are *about* the deadline keep it honest by passing their
 * own clock (`maxMs: 0` still truncates before the first read, and the stepped
 * 100-ms clock still reaches a 250-ms budget after two notes); a case that wants the
 * real clock can pass one and override this default.
 */
function scan(world, binding, options = {}) {
  let ticks = 0
  return scanCuration(binding, {
    dataRoot: world.dataRoot,
    home: world.home,
    now: NOW,
    clock: () => (ticks += 1),
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
  // `autoCurate: false` because Task 6 made a committed `services.write` queue its
  // note: these cases set up their own changed-path state by hand, and a hint the
  // fixture left behind per note would be read as part of what they assert.
  const world = await makeCurationWorld(t, { config: { autoCurate: false } })
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

test('the scan-vs-linter link matrix is exactly what the resolver comment states', async (t) => {
  const world = await makeCurationWorld(t)
  await world.services.write({ type: 'doc', title: '锚点', body: '正文。\n' })
  const binding = await bindingOf(world)
  const project = binding.relativeDir
  for (const [path, text] of [
    // Swept vault files the scan's universe does not hold: they are neither in the
    // project tree nor a *file* entry of the vault root (the root's `Docs/` is a
    // directory here, and the scan never descends the root).
    ['Methods/某方法.md', '# 某方法\n\n正文。\n'],
    [
      'Projects/other--6a1f0b52/Docs/别家.md',
      handNote({ id: 'doc-44444444-4444-4444-8444-444444444444', title: '别家' }),
    ],
    ['Docs/分享.md', '---\ntitle: 分享\n---\n正文。\n'],
    ['Docs/zzz.txt', 'x\n'],
    // Inside the project: an extension-less file beside the linking note and a
    // non-Markdown attachment, both of which the scan's *file* set must hold.
    [`${project}/Docs/LICENSE`, 'MIT\n'],
    [`${project}/Docs/txt.txt`, 'x\n'],
    [`${project}/Docs/图.png`, 'not really a png\n'],
    // The carrier of the basename `a`: a file of the project's own tree whose name is
    // what the resolver's last-segment rule reads, and which no candidate path of an
    // `[[Other/a]]` link can match.
    [`${project}/Docs/a/a`, 'extension-less\n'],
    // One directory up from the linking note, so a bare `[[LICENSE]]` — or the
    // `[[README]]` whose only carrier this is — is out of reach of the linter's
    // directory-bound rule.
    [`${project}/LICENSE`, 'MIT\n'],
    [`${project}/README`, 'readme\n'],
    // The vault root: a note and an extension-less file the resolver must see.
    ['Home.md', '---\ntitle: Home\n---\n首页。\n'],
    ['Makefile', 'all:\n\techo hi\n'],
  ]) {
    await writeRaw(world, path, text)
  }
  const inside = `${project}/Docs/并不存在`
  const targets = [
    'Docs/nomatch',
    'Methods/并不存在',
    'Methods/某方法',
    'Home',
    'Makefile',
    'LICENSE',
    'Docs/txt.txt',
    'Docs/LICENSE',
    'other/LICENSE',
    'Docs/分享',
    'Docs/zzz.txt',
    'Other/a',
    `${project}/Other/a`,
    'README',
    `${project}/Docs/txt.txt`,
    `${project}/Docs/图.png`,
    '并不存在',
    `${project}/Docs/并不存在`,
  ]
  const linker = await world.services.write({
    type: 'doc',
    title: '引用者',
    body: `${targets.map((target) => `[[${target}]]`).join('、')}。\n`,
  })

  const result = await scan(world, binding)
  assert.equal(result.complete, true)
  const lint = await lintVault({ binding, home: world.home, now: NOW })
  const scanDead = new Set(
    result.findings.filter((finding) => finding.kind === 'dead-wikilink').map((f) => f.target),
  )
  const lintDead = new Set(
    lint.findings
      .filter((finding) => finding.kind === 'dead-wikilink' && finding.path === linker.path)
      .map((finding) => /\[\[([^\]]+)\]\]/u.exec(finding.message)[1]),
  )

  // The probe matrix, run against this fixture and asserted row by row: `DEAD` is
  // a reported finding, `silent` is none. Seven rows have the scan silent and the
  // linter dead, in two groups. `Docs/nomatch`, `Methods/并不存在`, `Docs/txt.txt`,
  // `Docs/LICENSE`, `other/LICENSE` and `Other/a` share the first reason: a
  // slash-bearing target that does not start with this project's directory is
  // answered `true` before any name is looked at, so that silence needs no basename
  // match anywhere — `Docs/nomatch` has none at all, while `Other/a`'s basename is
  // carried by `${project}/Docs/a/a` and the answer is the same either way.
  // `Docs/分享` is that same rule on a target that exists (the linter resolves it
  // through the root `Docs/`, the scan answers `true` without deciding), and the
  // `${project}/Docs/txt.txt` and `${project}/Docs/图.png` rows are the plain-file
  // agreement: both surfaces hold them, so both are silent.
  //
  // The last two silence rows are about the basename branch itself rather than the
  // prefix one. `${project}/Other/a` does start with this project's directory, so
  // that branch never answers and the branch that does is the last-segment one,
  // reading the `a` of `${project}/Docs/a/a` while the linter's two candidates both
  // miss — the one-directional under-report this resolver allows. `[[README]]` is
  // its bare case: the name's only carrier is `${project}/README`, one directory
  // above the linking note and so unreachable for the linter's directory-bound
  // rule, and the scan answers `true` on it. `[[LICENSE]]` is the bare case that
  // does *not* diverge — both surfaces are silent, the linter through the vault-root
  // copy, which the resolver assertions at the end of this case re-probe directly.
  // Every row is probed rather than described; a comment that went further than
  // this matrix is the failure it exists to prevent.
  const expected = [
    ['Docs/nomatch', 'silent', 'DEAD'],
    ['Methods/并不存在', 'silent', 'DEAD'],
    ['Methods/某方法', 'silent', 'silent'],
    ['Home', 'silent', 'silent'],
    ['Makefile', 'silent', 'silent'],
    ['LICENSE', 'silent', 'silent'],
    ['Docs/txt.txt', 'silent', 'DEAD'],
    ['Docs/LICENSE', 'silent', 'DEAD'],
    ['other/LICENSE', 'silent', 'DEAD'],
    ['Docs/分享', 'silent', 'silent'],
    ['Docs/zzz.txt', 'silent', 'silent'],
    ['Other/a', 'silent', 'DEAD'],
    [`${project}/Other/a`, 'silent', 'DEAD'],
    ['README', 'silent', 'DEAD'],
    [`${project}/Docs/txt.txt`, 'silent', 'silent'],
    [`${project}/Docs/图.png`, 'silent', 'silent'],
    ['并不存在', 'DEAD', 'DEAD'],
    [`${project}/Docs/并不存在`, 'DEAD', 'DEAD'],
  ]
  assert.deepEqual(
    targets.map((target) => [
      target,
      scanDead.has(target) ? 'DEAD' : 'silent',
      lintDead.has(target) ? 'DEAD' : 'silent',
    ]),
    expected,
  )
  // The relation the comment claims holds over that matrix: for a target it can
  // decide the scan is a subset of the linter, and a missing finding is the safe
  // direction. A curation merge can miss a finding; it is never shown a link the
  // linter called alive.
  assert.deepEqual(
    targets.filter((target) => scanDead.has(target) && !lintDead.has(target)),
    [],
  )
  // The scan's whole dead-link output for this note: the bare name that exists
  // nowhere and the project-prefixed path that exists nowhere. Those two are the
  // only rows the matrix calls `DEAD`, so nothing above is a filter artefact.
  assert.deepEqual(
    result.findings
      .filter((finding) => finding.kind === 'dead-wikilink')
      .map((finding) => [finding.path, finding.target]),
    [
      [linker.path, '并不存在'],
      [linker.path, inside],
    ],
  )
  // The two attributions the prose above rests on, probed directly instead of
  // reasoned about, because a claim that names which file carried an answer is the
  // exact shape this case exists to keep pinned. `LICENSE` sits at the vault root
  // *and* one directory above the linker: the linter's own rule reaches only the
  // vault-root copy, so its `true` above is that copy's, which is why the row is a
  // limit. `README`'s only carrier is the project-root copy, which the same rule
  // cannot reach at all, and that is the row that diverges.
  assert.equal(createVaultLinkResolver([`${project}/LICENSE`])('LICENSE', linker.path), false)
  assert.equal(createVaultLinkResolver(['LICENSE'])('LICENSE', linker.path), true)
  assert.equal(
    createVaultLinkResolver([`${project}/LICENSE`, 'LICENSE'])('LICENSE', linker.path),
    true,
  )
  assert.equal(createVaultLinkResolver([`${project}/README`])('README', linker.path), false)
})

test('a directory the resolver cannot enumerate makes it silent, never a false dead link', async (t) => {
  const world = await makeCurationWorld(t)
  const written = await world.services.write({ type: 'doc', title: '锚点', body: '正文。\n' })
  const binding = await bindingOf(world)
  // A directory beside the linking note that the enumerator cannot read, holding
  // both a `.txt` and a **real Markdown note**. The note is what makes this case
  // about coverage and not only about links: it is indexable, so a pass that cannot
  // read the directory holds a manifest one note short of the project — and the
  // fixture has to be able to see that, which is exactly what the earlier
  // `.txt`-only version could not do.
  const locked = join(world.vault, ...binding.relativeDir.split('/'), 'Docs', '锁定')
  await mkdir(locked, { recursive: true })
  await writeFile(join(locked, '隐藏.txt'), 'hidden\n', 'utf8')
  const hidden = `${binding.relativeDir}/Docs/锁定/隐藏.md`
  await writeFile(
    join(locked, '隐藏.md'),
    handNote({ id: 'doc-55555555-5555-4555-8555-555555555555', title: '隐藏' }),
    'utf8',
  )
  // A target that names nothing anywhere: no bare name carries it and no
  // directory-qualified candidate matches, so a resolver that believes it
  // enumerated the tree reports it dead. That belief is the thing under test.
  const target = `${binding.relativeDir}/Docs/并不存在`
  const linker = await world.services.write({
    type: 'doc',
    title: '引用者',
    body: `见 [[${target}]]。\n`,
  })
  // Each pass gets its own data root on purpose. A second pass over the same root
  // would resume from the cursor and replay the linker's stored record instead of
  // asking the resolver again — which would mask exactly the decision this test is
  // about behind a cached finding.
  const options = (name) => ({
    dataRoot: join(world.root, name),
    home: world.home,
    now: NOW,
  })

  // Readable first, so the same fixture is proven to produce the finding when the
  // enumeration can see the whole tree.
  const readable = await scanCuration(binding, options('readable'))
  assert.deepEqual(
    readable.findings
      .filter((finding) => finding.kind === 'dead-wikilink')
      .map((finding) => [finding.path, finding.target]),
    [[linker.path, target]],
  )
  // The control: a readable walk sees every note, certified as covered, with no
  // enumeration finding at all. Every assertion in the locked half below is read
  // against this same fixture.
  const wholeManifest = await manifestOf(world, binding)
  assert.equal(readable.complete, true)
  assert.equal(readable.manifest.count, wholeManifest.length)
  assert.equal(readable.manifest.denied, false)
  assert.equal(
    readable.findings.some((finding) => finding.kind === 'enumeration-failed'),
    false,
  )

  await chmod(locked, 0o000)
  t.after(() => chmod(locked, 0o700).catch(() => {}))
  let result
  try {
    result = await scanCuration(binding, options('locked'))
  } finally {
    // Restored inside the test as well as in `t.after`, so a failure above cannot
    // leave an unreadable directory for the temp-tree cleanup.
    await chmod(locked, 0o700).catch(() => {})
  }
  // Nothing is judged dead: "I could not look" is never "it is not there". The pass
  // still inspects the notes it can see, so the silence is the resolver's decision
  // about a half-enumerated universe and not an empty pass.
  assert.deepEqual(
    result.findings.filter((finding) => finding.kind === 'dead-wikilink'),
    [],
  )
  assert.equal(result.examinedPaths.includes(linker.path), true)
  assert.equal(result.examinedPaths.includes(written.path), true)

  // Silence about the unreadable directory is not the same as coverage of it. The
  // note inside it is a real `README`-shaped file a scan would have inspected, so a
  // pass that never enumerated it holds a manifest one note short of the project —
  // and must say so in every way a caller can read: the pass is not complete, the
  // state finding names it, the manifest count is a floor, and the cursor is not
  // moved onto the shorter list. This is the half the previous fixture could not
  // see, because it put only a `.txt` in the locked directory.
  assert.equal(result.complete, false)
  assert.equal(result.manifest.denied, true)
  assert.equal(result.manifest.count, wholeManifest.length - 1)
  assert.equal(result.examinedPaths.includes(hidden), false)
  assert.deepEqual(
    result.findings
      .filter((finding) => finding.kind === 'enumeration-failed')
      .map((finding) => finding.severity),
    ['warn'],
  )
  assert.equal(result.cursor, null)
  // No budget truncated anything: the hole is the enumeration's, and naming a bound
  // would be a second wrong claim in place of the first.
  assert.equal(result.truncatedReason, null)

  // Enumeration restored, the finding comes back and the note inside the directory
  // is part of the pass again — which is what makes the silence above a decision
  // about the failed enumeration rather than a resolver that never reports anything.
  const restored = await scanCuration(binding, options('restored'))
  assert.deepEqual(
    restored.findings
      .filter((finding) => finding.kind === 'dead-wikilink')
      .map((finding) => [finding.path, finding.target]),
    [[linker.path, target]],
  )
  assert.equal(restored.complete, true)
  assert.equal(restored.manifest.count, wholeManifest.length)
  assert.equal(restored.examinedPaths.includes(hidden), true)
})

test('a truncated link universe makes the resolver silent rather than confident', async (t) => {
  const world = await makeCurationWorld(t)
  await world.services.write({ type: 'doc', title: '锚点', body: '正文。\n' })
  const binding = await bindingOf(world)
  // Forty extension-less attachments at the *tail* of the enumeration — `Inbox`
  // sorts after `Docs`, and the walk is breadth-first — so the file list is a list
  // whose end is exactly where a link would be called dead into. The target's
  // basename is not one of them: the whole-list pass reports the link dead, while a
  // list cut short is not allowed to answer at all.
  const inbox = join(world.vault, ...binding.relativeDir.split('/'), 'Inbox')
  await mkdir(inbox, { recursive: true })
  for (let index = 0; index < 40; index += 1) {
    await writeFile(join(inbox, `附件-${String(index).padStart(3, '0')}`), 'x\n', 'utf8')
  }
  const target = `${binding.relativeDir}/Docs/尾部附件`
  const linker = await world.services.write({
    type: 'doc',
    title: '引用者',
    body: `见 [[${target}]]。\n`,
  })

  // The whole universe is enumerated at the shipped bound, and the link is judged.
  // This pass gets a data root of its own: both halves of this case inspect the same
  // paths, and a shared root would let the bounded half's record — written from an
  // undecidable resolver — overwrite the finding this half asserts on.
  const whole = await scan(world, binding, { dataRoot: join(world.root, 'whole') })
  assert.equal(whole.examinedPaths.includes(linker.path), true)
  assert.equal(whole.complete, true)
  assert.equal(whole.manifest.count, (await manifestOf(world, binding)).length)
  assert.deepEqual(
    whole.findings
      .filter((finding) => finding.kind === 'dead-wikilink')
      .map((finding) => [finding.path, finding.target]),
    [[linker.path, target]],
  )

  // The same fixture under a bound the file list cannot fill. `maxFiles` is the seam
  // the module exposes for exactly this case, and it is the bound the reviewer's
  // probe used. What it must not do is shorten the *manifest*: `manifest.paths` is
  // the notes this pass claims coverage of, and a walk that broke there would write
  // the cursor over a short fingerprint and call it `complete` — notes nobody
  // looked at, certified by a flag. So the assertions name every half of that: the
  // same note count, the same `complete`, the resolver silent rather than certain,
  // and a cursor that moved only because the coverage behind it really is whole.
  const bounded = await scan(world, binding, {
    maxFiles: 10,
    dataRoot: join(world.root, 'bounded'),
  })
  assert.deepEqual(
    bounded.findings.filter((finding) => finding.kind === 'dead-wikilink'),
    [],
    'a link into a region the walk never reached must not be called dead',
  )
  assert.deepEqual(
    bounded.findings
      .filter((finding) => finding.kind === 'resolver-truncated')
      .map((finding) => [finding.severity, finding.message]),
    [['warn', 'the link universe hit its 10-file bound, so no link was judged dead in this pass']],
  )
  // The manifest is untouched by the link-universe bound, which is the whole of this
  // fix: the same project, the same note count, the same coverage claim. The bound
  // stops the file list alone, so the cursor is allowed to move — and the note count
  // is asserted equal to the whole pass rather than merely non-zero, because that
  // equality is the thing the old walk broke.
  assert.equal(bounded.manifest.count, whole.manifest.count)
  assert.equal(bounded.manifest.truncated, false)
  assert.equal(bounded.complete, true)
  // "No cursor over a short fingerprint" is the assertion that actually pins this,
  // and a non-null cursor alone does not make it: the fingerprint the pass returns
  // and the one it persisted are both the fingerprint of the *whole* manifest, so a
  // later pass resumes over exactly the note list this pass certified rather than
  // over the shortened file list the resolver bound stopped.
  const manifestPaths = await manifestOf(world, binding)
  assert.equal(bounded.manifest.fingerprint, fingerprintOf(manifestPaths))
  assert.equal(bounded.cursor.manifestFingerprint, fingerprintOf(manifestPaths))
  assert.deepEqual(
    await readCurationCursor(join(world.root, 'bounded'), binding.projectId),
    bounded.cursor,
  )
  // The price of that silence, asserted because it is not a deferral: an unchanged
  // note is never re-inspected — a covered path is verified by its record's
  // presence, not re-read — so a later pass over this same root with a whole
  // universe still reports no dead link for it. The finding returns when the linking
  // note's own bytes change and a changed-path pass asks the resolver again.
  const wholeAgain = await scan(world, binding, { dataRoot: join(world.root, 'bounded') })
  assert.equal(wholeAgain.complete, true)
  assert.deepEqual(
    wholeAgain.findings.filter((finding) => finding.kind === 'dead-wikilink'),
    [],
  )
  assert.deepEqual(
    wholeAgain.findings.filter((finding) => finding.kind === 'resolver-truncated'),
    [],
  )
})

test('the manifest budget is a coverage truncation the pass names and never hides', async (t) => {
  const world = await makeCurationWorld(t)
  await world.services.write({ type: 'doc', title: '锚点', body: '正文。\n' })
  const binding = await bindingOf(world)
  for (let index = 0; index < 4; index += 1) {
    await world.services.write({ type: 'doc', title: `预算 ${index}`, body: `第 ${index} 条。\n` })
  }
  const whole = await scan(world, binding, { dataRoot: join(world.root, 'whole') })
  assert.equal(whole.manifest.count, (await manifestOf(world, binding)).length)
  assert.equal(whole.manifest.truncated, false)
  assert.equal(whole.complete, true)

  // `maxManifestFiles` is the seam for the manifest's own budget, and it is the
  // only bound that truncates the walk. It was structurally unreachable before the
  // file bound stopped breaking the whole walk, so this case is the one that keeps
  // the branch from going dead again: a pass that cannot cover every note says
  // `manifest-budget`, claims nothing complete, and leaves the cursor alone rather
  // than writing one over the shorter manifest it is holding.
  const bounded = await scan(world, binding, {
    maxManifestFiles: 3,
    dataRoot: join(world.root, 'bounded'),
  })
  assert.equal(bounded.manifest.count, 3)
  assert.equal(bounded.manifest.truncated, true)
  assert.equal(bounded.truncatedReason, 'manifest-budget')
  assert.equal(bounded.complete, false)
  assert.equal(bounded.cursor, null)
  assert.deepEqual(
    bounded.findings
      .filter((finding) => finding.kind === 'manifest-truncated')
      .map((finding) => [finding.severity, finding.message]),
    [
      [
        'warn',
        'the manifest walk stopped at its 3-path budget, so no coverage was claimed for this pass',
      ],
    ],
  )
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

test('a truncated pass is never complete, even when the backfill behind it is', async (t) => {
  const { world, binding, written } = await worldWithNotes(t, 3)
  const done = await scan(world, binding)
  assert.equal(done.complete, true)

  const [first, second] = [written[0].path, written[1].path].sort()
  // The changed-path traversal runs out of note budget before the second path: the
  // stored backfill is finished, but this pass covered half of what it was handed,
  // and the path it never inspected is the one a merge on `complete` would drop.
  const budgeted = await scan(world, binding, { changedPaths: [first, second], maxNotes: 1 })
  assert.equal(budgeted.truncated, true)
  assert.equal(budgeted.truncatedReason, 'file-budget')
  assert.equal(budgeted.complete, false)
  assert.equal(budgeted.examined, 1)
  assert.deepEqual(
    budgeted.entries.map((entry) => entry.path),
    [first],
  )

  const timedOut = await scan(world, binding, { changedPaths: [first], maxMs: 0 })
  assert.equal(timedOut.truncatedReason, 'time-budget')
  assert.equal(timedOut.complete, false)
  assert.equal(timedOut.examined, 0)

  // Nothing about the backfill changed, so a changed-path pass that finished its
  // own list still reports the project complete.
  const again = await scan(world, binding, { changedPaths: [first] })
  assert.equal(again.complete, true)
})

test('verifying the covered prefix obeys the deadline', async (t) => {
  const { world, binding } = await worldWithNotes(t, 3)
  const done = await scan(world, binding)
  assert.equal(done.complete, true)
  assert.ok(done.cursor.afterPath)

  // Every path is already covered, so this pass has no note to inspect: the only
  // work left is re-reading one record per manifest path to prove the coverage.
  // With no time budget that read must not happen, and a pass that verified
  // nothing may not certify anything.
  const starved = await scan(world, binding, { maxMs: 0 })
  assert.equal(starved.examined, 0)
  assert.equal(starved.truncatedReason, 'time-budget')
  assert.equal(starved.complete, false)
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

test('a frontmatter string cannot fill a record past what the store accepts', async (t) => {
  const { world, binding } = await worldWithNotes(t, 1)
  const path = `${binding.relativeDir}/Docs/巨题.md`
  const links = Array.from(
    { length: 128 },
    (unused, index) => `[[缺失-${String(index).padStart(4, '0')}${'x'.repeat(150)}]]`,
  )
  // Frontmatter has to close inside the parser's first 64 KB, so this is a title as
  // long as a note can legally carry, beside enough findings to reach the finding
  // cap: before the entry bound, the title alone pushed the record over the store's
  // 64 KB and the pass threw instead of reporting the note.
  await writeRaw(
    world,
    path,
    handNote({
      id: 'doc-99999999-9999-4999-8999-999999999999',
      title: 'T'.repeat(60_000),
      body: `${links.join(' ')}\n`,
    }),
  )

  const result = await scan(world, binding)
  assert.equal(result.complete, true)
  const entry = result.entries.find((item) => item.path === path)
  assert.ok(entry, JSON.stringify(result.counts))
  assert.equal(entry.title.length, MAX_ENTRY_TEXT_CHARS)

  // The bound is not cosmetic: the record the store accepted is inside the bound
  // its own reader enforces, so the next pass reuses it instead of refusing it and
  // inspecting the note again.
  const recordFile = curationRecordPath(world.dataRoot, binding.projectId, path)
  const size = (await stat(recordFile)).size
  assert.ok(size <= MAX_SCAN_RECORD_BYTES, `the record is ${size} bytes`)
  assert.equal(JSON.parse(await readFile(recordFile, 'utf8')).status, 'ok')
  const reread = await scan(world, binding)
  assert.deepEqual(reread.examinedPaths, [])
})

test('a record the store refuses becomes an unexamined note, never a thrown pass', async (t) => {
  const { world, binding, written } = await worldWithNotes(t, 1)
  const path = written[0].path
  // A directory where the record file belongs: every rename into place fails, which
  // is the code path an oversize record takes too. One note's record must not be
  // able to fail the pass that reads it.
  await mkdir(curationRecordPath(world.dataRoot, binding.projectId, path), { recursive: true })

  const result = await scan(world, binding)
  assert.equal(
    result.entries.some((entry) => entry.path === path),
    false,
  )
  const finding = result.findings.find((item) => item.kind === 'unexamined' && item.path === path)
  assert.ok(finding, JSON.stringify(result.findings))
  assert.match(finding.reason, /^record-/)
  // The record never became durable, so the path is a coverage hole: this pass may
  // not claim completion over an inspection nobody can read back.
  assert.equal(result.complete, false)
  assert.equal(result.truncatedReason, 'records-missing')
  assert.equal(
    result.findings.some((item) => item.kind === 'record-unreadable'),
    true,
  )
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
