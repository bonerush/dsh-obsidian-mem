import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { buildBrief, pageBrief } from '../lib/brief.js'
import { validateConfig } from '../lib/config.js'
import { updateHot } from '../lib/hot.js'
import { createMemoryServices } from '../lib/tools.js'
import { openIndex } from '../lib/index-db.js'
import { bootstrapVault } from '../lib/vault.js'

const PROJECT_ID = '1c392abb-7b08-42f7-871d-2a379caf9448'
const RELATIVE_DIR = 'Projects/demo--1c392abb'
const HOT_ID = /hot-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/g
const at = (root, relative) => join(root, ...relative.split('/'))

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'obsidian-mem-page-'))
  const dataRoot = join(root, 'data')
  const home = join(root, 'home')
  const vault = join(root, 'vault')
  await mkdir(dataRoot, { recursive: true })
  await mkdir(home, { recursive: true })
  const binding = {
    kind: 'bound',
    projectId: PROJECT_ID,
    slug: 'demo',
    displayName: 'Demo',
    schema: 1,
    vaultRoot: vault,
    relativeDir: RELATIVE_DIR,
  }
  if (options.bootstrap !== false) await bootstrapVault(binding, { dataRoot, home })
  const index = await openIndex({
    vaultRoot: vault,
    dataRoot,
    backend: options.backend ?? 'sqlite',
    projectId: PROJECT_ID,
    ...(options.io === undefined ? {} : { io: options.io }),
  })
  t.after(async () => {
    await index.close().catch(() => {})
    await rm(root, { recursive: true, force: true, maxRetries: 4 })
  })
  return { root, dataRoot, home, vault, binding, index }
}

test('paging walks every hot id exactly once and the brief records the cut', async (t) => {
  const env = await fixture(t)
  for (let i = 0; i < 40; i += 1) {
    await updateHot(
      env.binding,
      { section: '进行中', text: '分页-进行中-' + String(i).padStart(2, '0') },
      { dataRoot: env.dataRoot, home: env.home },
    )
  }
  const built = await buildBrief(env.binding, {
    index: env.index,
    config: { briefBudgetChars: 600, hotCapacityChars: 9000 },
    mode: 'full',
  })
  assert.equal(built.truncated, true)
  assert.equal(built.coverage.omitted, built.coverage.considered - built.coverage.shown)
  const active = built.coverage.sections.find((section) => section.key === 'hot-active')
  assert.ok(active.omitted > 0, 'the fixture cuts the active zone')
  assert.match(built.text, /记忆覆盖/)
  assert.match(built.text, /mem_brief\(section="hot-active"/)

  const ids = []
  let offset = 0
  let total
  for (;;) {
    const page = await pageBrief(env.binding, {
      section: 'hot-active',
      offset,
      limit: 7,
      index: env.index,
      config: { briefBudgetChars: 600, hotCapacityChars: 9000 },
    })
    total = page.total
    ids.push(...[...page.lines.join('\n').matchAll(HOT_ID)].map((match) => match[0]))
    if (!page.hasMore) break
    offset = page.nextOffset
  }
  assert.equal(total, 40, 'all 40 entries are in 进行中')
  assert.equal(new Set(ids).size, ids.length, 'no id is repeated across pages')
  assert.equal(ids.length, total, 'every id is reached')

  // The service dispatch: a section request is a page, not a second full brief;
  // offset/limit without a section is refused instead of silently ignored.
  const services = createMemoryServices({
    config: validateConfig({ vaultPath: env.vault }),
    dataRoot: env.dataRoot,
    home: env.home,
    binding: env.binding,
  })
  try {
    const viaService = await services.brief(
      { section: 'hot-active', offset: 0, limit: 7 },
      undefined,
      {},
    )
    assert.equal(viaService.section, 'hot-active')
    assert.equal(viaService.lines.length, 7)
    assert.equal(viaService.total, 40)
    await assert.rejects(
      () => services.brief({ offset: 1 }, undefined, {}),
      /only valid together with section/u,
    )
  } finally {
    await services.close?.()
  }
})

test('conventions summary renders five lines, counts all 50 and paging reaches every note', async (t) => {
  const env = await fixture(t)
  const lines = Array.from({ length: 50 }, (_x, i) => {
    const number = String(i).padStart(2, '0')
    return '- [[' + RELATIVE_DIR + '/Conventions/note-' + number + '|约定-' + number + ']]'
  })
  await writeFile(
    at(env.vault, RELATIVE_DIR + '/Conventions/index.md'),
    '# Conventions\n\n' + lines.join('\n') + '\n',
    'utf8',
  )
  const built = await buildBrief(env.binding, {
    index: env.index,
    config: { briefBudgetChars: 6000, hotCapacityChars: 9000, briefConventionMode: 'summary' },
    mode: 'full',
  })
  const conventions = built.coverage.sections.find((section) => section.key === 'conventions')
  assert.equal(conventions.considered, 50)
  assert.equal(conventions.shown, 5)
  assert.equal(conventions.omitted, 45)
  assert.equal((built.text.match(/约定-\d\d/gu) ?? []).length, 5)
  assert.match(built.text, /mem_brief\(section="conventions", offset=5/u)

  const page = await pageBrief(env.binding, {
    section: 'conventions',
    offset: 0,
    limit: 50,
    index: env.index,
    config: { briefBudgetChars: 6000, hotCapacityChars: 9000, briefConventionMode: 'summary' },
  })
  assert.equal(page.total, 50)
  assert.equal(page.lines.length, 50)
  assert.equal(page.hasMore, false)
})

test('a 2,000-line MOC pages in under one second at session start', async (t) => {
  const env = await fixture(t, { bootstrap: false })
  await mkdir(at(env.vault, RELATIVE_DIR + '/Conventions'), { recursive: true })
  const lines = Array.from(
    { length: 2000 },
    (_x, i) => '- [[' + RELATIVE_DIR + '/Conventions/n-' + i + '|题-' + i + ']]',
  )
  await writeFile(
    at(env.vault, RELATIVE_DIR + '/Conventions/index.md'),
    lines.join('\n') + '\n',
    'utf8',
  )
  const started = performance.now()
  const built = await buildBrief(env.binding, {
    index: env.index,
    config: { briefBudgetChars: 6000, hotCapacityChars: 9000 },
    mode: 'full',
  })
  const elapsed = performance.now() - started
  assert.ok(elapsed < 1000, 'buildBrief took ' + Math.round(elapsed) + ' ms')
  const conventions = built.coverage.sections.find((section) => section.key === 'conventions')
  assert.equal(conventions.considered, 2000)
  assert.equal(conventions.shown, 5)
  assert.equal(conventions.omitted, 1995)
})

for (const backend of ['sqlite', 'scan']) {
  test(`convention recall rechecks source status despite an active or missing cached row (${backend})`, async (t) => {
    const env = await fixture(t, { backend })
    const path = RELATIVE_DIR + '/Conventions/fresh.md'
    const missing = RELATIVE_DIR + '/Conventions/unindexed.md'
    await writeFile(at(env.vault, path), '---\nstatus: active\n---\n# Fresh\n')
    await writeFile(
      at(env.vault, RELATIVE_DIR + '/Conventions/index.md'),
      '- [[' + path + '|Fresh sentinel]]\n- [[' + missing + '|New sentinel]]\n',
    )
    await env.index.refresh()
    for (const status of ['provisional', 'active', 'archived', 'active']) {
      await writeFile(at(env.vault, path), '---\nstatus: ' + status + '\n---\n# Fresh\n')
      await writeFile(at(env.vault, missing), '---\nstatus: provisional\n---\n# New\n')
      const built = await buildBrief(env.binding, { index: env.index })
      assert.equal(built.text.includes('Fresh sentinel'), status === 'active', status)
      assert.equal(
        built.text.includes('New sentinel'),
        false,
        'an unindexed provisional source stays quarantined',
      )
    }
    assert.equal((await env.index.statusesForPaths([path])).get(path), 'active')
    await rm(at(env.vault, path))
    const page = await pageBrief(env.binding, { section: 'conventions', index: env.index })
    assert.equal(
      page.lines.some((line) => line.includes('Fresh sentinel')),
      true,
      'a missing source remains navigation',
    )
  })
}

test('fresh status rechecks only a changed source, not every unchanged one', async (t) => {
  const reads = []
  const env = await fixture(t, {
    io: {
      readFile: async (...args) => {
        reads.push(args[0])
        return readFile(...args)
      },
    },
  })
  const directory = RELATIVE_DIR + '/Conventions'
  await mkdir(at(env.vault, directory), { recursive: true })
  const unchanged = directory + '/unchanged.md'
  const changed = directory + '/changed.md'
  await writeFile(at(env.vault, unchanged), '---\nstatus: active\n---\n# Unchanged\n')
  await writeFile(at(env.vault, changed), '---\nstatus: active\n---\n# Changed\n')
  await env.index.refresh()
  reads.length = 0
  const first = await env.index.statusesForPaths([unchanged, changed], { fresh: true })
  assert.equal(first.get(unchanged), 'active')
  assert.equal(first.get(changed), 'active')
  assert.equal(reads.length, 0, 'an unchanged cached stamp is trusted')
  await writeFile(at(env.vault, changed), '---\nstatus: provisional\n---\n# Changed\n')
  const second = await env.index.statusesForPaths([unchanged, changed], { fresh: true })
  assert.equal(second.get(unchanged), 'active')
  assert.equal(second.get(changed), 'provisional')
  assert.equal(reads.length, 1, 'only the changed source is read')
})

test('an oversized complete hot item reports its source and a continuation reaching later items', async (t) => {
  const env = await fixture(t)
  for (const text of ['x'.repeat(8100), 'later small item']) {
    await updateHot(
      env.binding,
      { section: '强约束', text },
      { dataRoot: env.dataRoot, home: env.home },
    )
  }
  let failure
  await assert.rejects(
    () => pageBrief(env.binding, { section: 'hot-constraints' }),
    (error) => {
      failure = error
      return error instanceof RangeError && error.code === 'brief-unit-too-large'
    },
  )
  assert.match(failure.message, /mem_read\(path="Projects\/demo--1c392abb\/_meta\/hot.md"\)/u)
  assert.match(failure.message, /offset=1/u)
  const page = await pageBrief(env.binding, { section: 'hot-constraints', offset: 1 })
  assert.equal(page.hasMore, false)
  assert.equal(page.nextOffset, 2)
  assert.match(page.lines.join('\n'), /later small item/u)
  assert.ok(page.charCount <= 8000)
  assert.match(await readFile(at(env.vault, RELATIVE_DIR + '/_meta/hot.md'), 'utf8'), /x{8100}/u)
})

test('view paging reaches its full eligible tail independently of the brief preview budget', async (t) => {
  const env = await fixture(t)
  const entries = []
  for (let i = 0; i < 20; i += 1) {
    const paths = [RELATIVE_DIR + '/Docs/view-' + i + '.md']
    if (i === 3) paths.push(RELATIVE_DIR + '/Docs/view-alternate.md')
    const hashes = []
    for (const path of paths) {
      const bytes = Buffer.from('# View ' + i + '\n')
      await writeFile(at(env.vault, path), bytes)
      hashes.push(createHash('sha256').update(bytes).digest('hex'))
    }
    entries.push({
      path: paths[0],
      paths,
      sourceHashes: hashes,
      hash: hashes[0],
      status: 'active',
      description: 'd'.repeat(80),
    })
  }
  const all = []
  for (let offset = 0; offset < 20;) {
    const page = await pageBrief(env.binding, {
      section: 'view',
      offset,
      limit: 7,
      curationView: { complete: true, entries },
      home: env.home,
      config: { briefBudgetChars: 600 },
    })
    assert.equal(page.total, 20)
    assert.ok(page.nextOffset > offset)
    all.push(...page.lines)
    offset = page.nextOffset
    if (!page.hasMore) break
  }
  assert.equal(all.length, 20)
  for (const entry of entries)
    for (const path of entry.paths)
      assert.ok(
        all.some((line) => line.includes(path)),
        path,
      )
})
