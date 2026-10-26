// Task 6: the panel's index reads — counts, recent notes, and the batch status
// lookup E1 asked for.
//
// Every case runs against a REAL throwaway vault and a REAL throwaway data root,
// never the user's vault or ~/.dsh. The expected numbers are written out by hand
// from the fixture below, not derived from the implementation, so a change in
// what "this project" or "an orphan" means fails here.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

import { IndexError, MAX_STATUS_PATHS, openIndex } from '../lib/index-db.js'

const ALPHA = '11111111-1111-4111-8111-111111111111'
const BETA = '22222222-2222-4222-8222-222222222222'
const A = 'Projects/alpha--11111111'
const B = 'Projects/beta--22222222'

/** `node:sqlite` is only required by the SQLite backend; the scan backend must work without it. */
const HAS_SQLITE = await (async () => {
  try {
    const sqlite = await import('node:sqlite')
    const db = new sqlite.DatabaseSync(':memory:')
    db.exec('CREATE VIRTUAL TABLE probe USING fts5(x)')
    db.close()
    return true
  } catch {
    return false
  }
})()

/** One note with the frontmatter the index reads (id, type, status, project, links). */
function note(fields) {
  const body = (fields.links ?? []).map((target) => '[[' + target + ']]').join('\n') + '\n'
  return [
    '---',
    'id: "' + fields.id + '"',
    'type: "' + fields.type + '"',
    'title: "' + fields.title + '"',
    'status: "' + fields.status + '"',
    'created: 2026-09-01',
    'updated: ' + (fields.updated ?? '2026-09-20'),
    'project: ' + (fields.project === null ? 'null' : '"' + fields.project + '"'),
    'source: "human"',
    '---',
    '# ' + fields.title,
    '',
    body,
  ].join('\n')
}

/** Build the fixture vault once; callers copy it per backend. */
async function makeVault() {
  const root = await mkdtemp(join(tmpdir(), 'obsidian-mem-stats-'))
  const vault = join(root, 'vault')
  const files = [
    [
      `${A}/Decisions/a.md`,
      { id: 'a', type: 'decision', title: 'a', status: 'active', project: ALPHA, links: ['b'] },
    ],
    [
      `${A}/Decisions/b.md`,
      { id: 'b', type: 'decision', title: 'b', status: 'superseded', project: ALPHA },
    ],
    [
      `${A}/Conventions/c.md`,
      { id: 'c', type: 'convention', title: 'c', status: 'active', project: ALPHA },
    ],
    [
      `${A}/Pitfalls/d.md`,
      { id: 'd', type: 'gotcha', title: 'd', status: 'active', project: ALPHA, links: ['c'] },
    ],
    [`${A}/Docs/f.md`, { id: 'f', type: 'doc', title: 'f', status: 'active', project: ALPHA }],
    [`${B}/Docs/e.md`, { id: 'e', type: 'doc', title: 'e', status: 'active', project: BETA }],
    [
      'Methods/m.md',
      { id: 'm', type: 'method', title: 'm', status: 'active', project: null, links: ['a'] },
    ],
  ]
  for (const [path, fields] of files) {
    const absolute = join(vault, ...path.split('/'))
    await mkdir(dirname(absolute), { recursive: true })
    await writeFile(absolute, note(fields), 'utf8')
  }
  // Distinct mtimes so "newest first" is a fact, not a same-second tie.
  const stamps = {
    'a.md': 1_000,
    'b.md': 2_000,
    'c.md': 3_000,
    'd.md': 4_000,
    'f.md': 5_000,
    'e.md': 6_000,
    'm.md': 7_000,
  }
  for (const [name, seconds] of Object.entries(stamps)) {
    for (const path of files.map(([path]) => path)) {
      if (!path.endsWith('/' + name)) continue
      await utimes(join(vault, ...path.split('/')), seconds, seconds)
    }
  }
  return { root, vault, dataRoot: join(root, 'data') }
}

/** Open one index over a fresh copy of the fixture, closed and removed by the caller. */
async function harness(t, backend) {
  const { root, vault, dataRoot } = await makeVault()
  const index = await openIndex({ vaultRoot: vault, dataRoot, backend, projectId: ALPHA })
  t.after(async () => {
    await index.close().catch(() => {})
    await rm(root, { recursive: true, force: true })
  })
  // The box can be loaded by the rest of the suite; the barrier, not the clock,
  // is what this test is about.
  const ready = await index.waitReady(undefined, 120_000)
  assert.equal(ready.ready, true, ready.reason)
  return index
}

const BACKENDS = [['scan', 'scan backend'], ...(HAS_SQLITE ? [['sqlite', 'SQLite backend']] : [])]

for (const [backend, label] of BACKENDS) {
  test(`stats counts this project only (${label})`, async (t) => {
    const index = await harness(t, backend)
    const alpha = await index.stats({ scope: 'project' })
    assert.equal(alpha.notes, 5)
    assert.equal(alpha.links, 2)
    assert.equal(alpha.orphans, 1)
    assert.deepEqual(alpha.byType.map((row) => row.type + ':' + row.n).sort(), [
      'convention:1',
      'decision:2',
      'doc:1',
      'gotcha:1',
    ])
    assert.deepEqual(alpha.byStatus.map((row) => row.status + ':' + row.n).sort(), [
      'active:4',
      'superseded:1',
    ])
    // `notes.mtime` is microseconds; f.md's 5 s file mtime is 5,000,000 µs.
    assert.equal(alpha.updatedAt, new Date(5_000_000).toISOString())
    const all = await index.stats({ scope: 'all' })
    assert.equal(all.notes, 7)
    assert.equal(all.links, 3)
    assert.equal(all.orphans, 2)
  })

  test(`stats refuses a project scope on an unbound index (${label})`, async (t) => {
    const { root, vault, dataRoot } = await makeVault()
    const index = await openIndex({ vaultRoot: vault, dataRoot, backend, projectId: null })
    t.after(async () => {
      await index.close().catch(() => {})
      await rm(root, { recursive: true, force: true })
    })
    await assert.rejects(
      index.stats({ scope: 'project' }),
      (error) => error.code === 'project-unbound',
    )
    assert.ok((await index.stats({ scope: 'all' })).notes > 0)
  })

  test(`recent is newest first and bounded (${label})`, async (t) => {
    const index = await harness(t, backend)
    const rows = await index.recent({ limit: 3 })
    assert.deepEqual(
      rows.map((row) => row.path.split('/').pop()),
      ['f.md', 'd.md', 'c.md'],
    )
    assert.deepEqual(Object.keys(rows[0]).sort(), ['path', 'status', 'title', 'type', 'updated'])
    assert.equal(rows[0].status, 'active')
    await assert.rejects(index.recent({ limit: 0 }), RangeError)
    await assert.rejects(index.recent({ limit: 51 }), RangeError)
  })

  test(`statusesForPaths answers one map and nulls what it does not hold (${label})`, async (t) => {
    const index = await harness(t, backend)
    const wanted = [
      `${A}/Decisions/a.md`,
      `${A}/Decisions/b.md`,
      `${A}/Decisions/a.md`,
      `${A}/Nope/missing.md`,
    ]
    const statuses = await index.statusesForPaths(wanted)
    assert.ok(statuses instanceof Map)
    assert.equal(statuses.get(`${A}/Decisions/a.md`), 'active')
    assert.equal(statuses.get(`${A}/Decisions/b.md`), 'superseded')
    assert.equal(statuses.get(`${A}/Nope/missing.md`), null)
    assert.equal(statuses.size, new Set(wanted).size)
    await assert.rejects(index.statusesForPaths([]), RangeError)
    await assert.rejects(
      index.statusesForPaths(new Array(MAX_STATUS_PATHS + 1).fill('x.md')),
      RangeError,
    )
    await assert.rejects(index.statusesForPaths([42]), RangeError)
  })
}

test('statusesForPaths reads every path it was given, once per unique path', async (t) => {
  const index = await harness(t, 'scan')
  const paths = Array.from({ length: MAX_STATUS_PATHS }, (_, i) => `${A}/Docs/f${i}.md`)
  const started = process.hrtime.bigint()
  const statuses = await index.statusesForPaths(paths)
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6
  assert.equal(statuses.size, paths.length)
  for (const path of paths) assert.equal(statuses.get(path), null)
  assert.ok(elapsedMs < 1000, 'a 512-path miss must not cost a second')
})

test('a closed index refuses the batch read instead of answering nulls', async (t) => {
  const index = await harness(t, 'scan')
  await index.close()
  await assert.rejects(
    index.statusesForPaths([`${A}/Docs/f.md`]),
    (error) => error instanceof IndexError,
  )
})
