import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { openIndex } from '../lib/index-db.js'
import { createGraphActivity } from '../lib/graph-activity.js'
import { createMemoryServices } from '../lib/services.js'
import { validateConfig } from '../lib/config.js'

const PROJECT = '1c392abb-7b08-42f7-871d-2a379caf9448'
const OTHER = '9f8e7d6c-7b08-42f7-871d-2a379caf9448'
const dir = `Projects/demo--${PROJECT.slice(0, 8)}`
const otherDir = `Projects/other--${OTHER.slice(0, 8)}`

async function fixture(t, backend, extraNotes = 0) {
  const root = await mkdtemp(join(tmpdir(), 'obsidian-mem-graph-'))
  const vaultRoot = join(root, 'vault')
  const dataRoot = join(root, 'data')
  await mkdir(join(vaultRoot, dir, 'Decisions'), { recursive: true })
  await mkdir(join(vaultRoot, dir, 'Conventions'), { recursive: true })
  await mkdir(join(vaultRoot, dir, 'Docs'), { recursive: true })
  await mkdir(join(vaultRoot, otherDir, 'Docs'), { recursive: true })
  await mkdir(dataRoot)
  const note = (id, type, title, project, body, status = 'active') =>
    `---\nid: "${id}"\ntype: "${type}"\ntitle: "${title}"\nproject: "${project}"\nstatus: "${status}"\ntags: [graph]\n---\n${body}\n`
  await writeFile(
    join(vaultRoot, dir, 'Decisions', 'Design.md'),
    note('decision-one', 'decision', 'Design', PROJECT, 'See [[Conventions/Naming]].'),
  )
  await writeFile(
    join(vaultRoot, dir, 'Conventions', 'Naming.md'),
    note('convention-one', 'convention', 'Naming', PROJECT, 'Names matter.'),
  )
  await writeFile(
    join(vaultRoot, dir, 'Decisions', 'Old.md'),
    note('old-one', 'decision', 'Old', PROJECT, 'Superseded.', 'superseded'),
  )
  await writeFile(
    join(vaultRoot, otherDir, 'Docs', 'Other.md'),
    note('other-one', 'doc', 'Other', OTHER, 'Unrelated.'),
  )
  for (let i = 0; i < extraNotes; i += 1) {
    await writeFile(
      join(vaultRoot, dir, 'Docs', `A-${String(i).padStart(2, '0')}.md`),
      note(`extra-${i}`, 'doc', `A-${i}`, PROJECT, 'An isolated note.'),
    )
  }
  if (extraNotes > 0)
    await writeFile(
      join(vaultRoot, dir, 'Docs', 'Z-Hub.md'),
      note('hub-one', 'hub', 'Z-Hub', PROJECT, 'See [[Docs/A-00]].'),
    )
  const index = await openIndex({ vaultRoot, dataRoot, backend, projectId: PROJECT })
  t.after(async () => {
    await index.close()
    await rm(root, { recursive: true, force: true })
  })
  assert.equal((await index.waitReady(undefined, 5000)).ready, true)
  return { index, vaultRoot, dataRoot }
}

for (const backend of ['scan', 'sqlite']) {
  test(`${backend} graph keeps linked hubs inside a bounded projection`, async (t) => {
    const { index } = await fixture(t, backend, 25)
    const graph = await index.graph({ scope: 'project', limit: 5 })
    assert.equal(graph.truncated, true)
    assert.equal(
      graph.nodes.some((node) => node.id === 'hub-one'),
      true,
    )
    assert.equal(
      graph.nodes.some((node) => node.id === 'extra-0'),
      true,
    )
    assert.equal(
      graph.edges.some((edge) => edge.source === 'hub-one' && edge.target === 'extra-0'),
      true,
    )
  })
}

for (const backend of ['scan', 'sqlite']) {
  test(`${backend} graph preserves the registry bridge while retrieval keeps it internal`, async (t) => {
    const { index, vaultRoot } = await fixture(t, backend)
    await mkdir(join(vaultRoot, '_meta'))
    await writeFile(
      join(vaultRoot, '_meta', 'registry.md'),
      `# Registry\n[[${dir}/Decisions/Design\\|Project [one] done]] [[${otherDir}/Docs/Other\\|Project [two] done]]\n`,
    )
    await index.refresh()
    const graph = await index.graph({ scope: 'all', limit: 20 })
    const registry = graph.nodes.find((node) => node.path === '_meta/registry.md')
    assert.ok(registry, 'the registry is a real bridge in the Obsidian graph')
    assert.deepEqual(
      graph.edges
        .filter((edge) => edge.source === registry.id)
        .map((edge) => edge.target)
        .sort(),
      ['decision-one', 'other-one'],
    )
    assert.equal(
      (await index.graph({ scope: 'project', limit: 20 })).nodes.some(
        (node) => node.path === '_meta/registry.md',
      ),
      false,
    )
    const { readNote } = await import('../lib/index-db.js')
    await assert.rejects(() => readNote(vaultRoot, '_meta/registry.md'), {
      code: 'internal-path',
    })
  })

  test(`${backend} graph keeps historical bridge notes and uncreated link targets`, async (t) => {
    const { index, vaultRoot } = await fixture(t, backend)
    await writeFile(
      join(vaultRoot, dir, 'Decisions', 'Old.md'),
      '---\nid: old-one\nstatus: archived\n---\n[[Design]] [[Missing.md#Heading]]\n',
    )
    await index.refresh()
    const graph = await index.graph({ scope: 'all', limit: 20 })
    assert.ok(graph.nodes.some((node) => node.id === 'old-one'))
    const missing = graph.nodes.find((node) => node.path === 'Missing')
    assert.equal(missing?.type, 'unresolved')
    assert.ok(graph.edges.some((edge) => edge.source === 'old-one' && edge.target === missing.id))
    assert.ok(
      graph.edges.some((edge) => edge.source === 'old-one' && edge.target === 'decision-one'),
    )
  })

  test(`${backend} graph preserves backticks inside filenames and repeated Markdown extensions`, async (t) => {
    const { index, vaultRoot } = await fixture(t, backend)
    const command = `${dir}/Docs/Command \`npm run check\`.md`
    const readme = `${dir}/Docs/README.md.md`
    await mkdir(join(vaultRoot, dir, 'Docs'), { recursive: true })
    await writeFile(join(vaultRoot, command), '# Command\n')
    await writeFile(join(vaultRoot, readme), '# Readme\n')
    await writeFile(
      join(vaultRoot, dir, 'Decisions', 'Design.md'),
      '---\nid: decision-one\n---\n' +
        `[[${command.slice(0, -3)}]] [[${readme.slice(0, -3)}]]\n` +
        '`[[InlineGhost]]`\n',
    )
    await index.refresh()
    const graph = await index.graph({ scope: 'all', limit: 20 })
    assert.deepEqual(
      graph.edges.filter((edge) => edge.source === 'decision-one'),
      [
        { source: 'decision-one', target: command },
        { source: 'decision-one', target: readme },
      ],
    )
    assert.equal(
      graph.nodes.some((node) => node.type === 'unresolved'),
      false,
    )
  })

  test(`${backend} graph includes inline-code Markdown destinations recorded by Obsidian metadata`, async (t) => {
    const { index, vaultRoot } = await fixture(t, backend)
    await writeFile(
      join(vaultRoot, dir, 'Decisions', 'Design.md'),
      '---\nid: decision-one\n---\n`English | [中文](README.zh.md)`\n',
    )
    await index.refresh()
    const graph = await index.graph({ scope: 'all', limit: 20 })
    const target = graph.nodes.find((node) => node.path === 'README.zh')
    assert.equal(target?.type, 'unresolved')
    assert.ok(
      graph.edges.some((edge) => edge.source === 'decision-one' && edge.target === target.id),
    )
  })

  test(`${backend} graph resolves Markdown, frontmatter and relative links as Obsidian does`, async (t) => {
    const { index, vaultRoot } = await fixture(t, backend)
    await writeFile(
      join(vaultRoot, dir, 'Decisions', 'Design.md'),
      '---\nid: decision-one\nrelated: "[[../Conventions/Naming]]"\n---\n' +
        '[English](../Conventions/Naming.md#Heading)\n' +
        `[Encoded](${encodeURI(otherDir)}/Docs/Other.md)\n` +
        '[[../Conventions/NAMING.MD]]\n' +
        '<!-- [[CommentGhost]] -->\n`[[InlineGhost]]`\n```md\n[[CodeGhost]]\n```\n',
    )
    await index.refresh()
    const graph = await index.graph({ scope: 'all', limit: 20 })
    assert.deepEqual(
      graph.edges.filter((edge) => edge.source === 'decision-one'),
      [
        { source: 'decision-one', target: 'convention-one' },
        { source: 'decision-one', target: 'other-one' },
      ],
    )
    assert.equal(
      graph.nodes.some((node) => node.type === 'unresolved'),
      false,
    )
  })
}

for (const backend of ['scan', 'sqlite']) {
  test(`${backend} graph keeps project boundaries and resolved links`, async (t) => {
    const { index } = await fixture(t, backend)
    const graph = await index.graph({ scope: 'project', limit: 20 })
    assert.deepEqual(graph.nodes.map((node) => node.id).sort(), [
      'convention-one',
      'decision-one',
      'old-one',
    ])
    assert.deepEqual(graph.edges, [{ source: 'decision-one', target: 'convention-one' }])
    assert.equal(graph.nodes.find((node) => node.id === 'decision-one').type, 'decision')
    assert.deepEqual(graph.nodes.find((node) => node.id === 'decision-one').tags, ['graph'])
    assert.equal(graph.truncated, false)

    const all = await index.graph({ scope: 'all', limit: 20 })
    assert.equal(
      all.nodes.some((node) => node.id === 'other-one'),
      true,
    )
    assert.equal(
      all.nodes.some((node) => node.id === 'old-one'),
      true,
    )
  })
}

test('SQLite reopens a cache from the old link parser without waiting for note edits', async (t) => {
  const { index, vaultRoot, dataRoot } = await fixture(t, 'sqlite')
  await writeFile(
    join(vaultRoot, dir, 'Decisions', 'Design.md'),
    '---\nid: decision-one\n---\n[Related](../Conventions/Naming.md)\n',
  )
  await index.refresh()
  const databasePath = index.status().dbPath
  await index.close()
  const { DatabaseSync } = await import('node:sqlite')
  const database = new DatabaseSync(databasePath)
  database.exec(
    "DELETE FROM links; INSERT OR REPLACE INTO kv(key,value) VALUES ('link_parser_version','1')",
  )
  database.close()
  const reopened = await openIndex({ vaultRoot, dataRoot, backend: 'sqlite', projectId: PROJECT })
  t.after(() => reopened.close())
  const graph = await reopened.graph({ scope: 'all', limit: 20 })
  assert.ok(
    graph.edges.some((edge) => edge.source === 'decision-one' && edge.target === 'convention-one'),
  )
})

test('graph activity is scoped to a session and advances only for recorded access', () => {
  const activity = createGraphActivity()
  activity.record('session-one', ['Projects/demo/Decisions/Design.md'], 'read')
  const first = activity.since('session-one', 0)
  assert.equal(first.events.length, 1)
  assert.equal(first.events[0].path, 'Projects/demo/Decisions/Design.md')
  assert.equal(first.events[0].kind, 'read')
  assert.equal(activity.since('session-two', 0).events.length, 0)
  assert.deepEqual(activity.since('session-one', first.cursor).events, [])
})

test('a successful mem_read reports its note path to the graph activity seam', async (t) => {
  const { vaultRoot, dataRoot } = await fixture(t, 'scan')
  const accessed = []
  const services = createMemoryServices({
    config: validateConfig({ vaultPath: vaultRoot }),
    dataRoot,
    onAccess: (sessionId, path) => accessed.push({ sessionId, path }),
  })
  t.after(() => services.close())
  const path = `${dir}/Decisions/Design.md`
  await services.read({ path }, undefined, {
    agent: { session: { header: { id: 'session-one' } } },
  })
  assert.deepEqual(accessed, [{ sessionId: 'session-one', path }])
  await assert.rejects(() =>
    services.read({ path: 'missing.md' }, undefined, {
      agent: { session: { header: { id: 'session-one' } } },
    }),
  )
  assert.equal(accessed.length, 1)
})
