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
import { activityWindow, bucketActivity } from '../lib/index-stats.js'

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

// ---------------------------------------------------------------------------
// The 概览 构成 Sankey's joint type×status flow. Expected rows are hand-written
// from the fixture above, NOT derived from the implementation: the order is part
// of the data contract (n DESC, then type ASC, then status ASC) and so are the
// margins the flow implies (5 project notes, 7 across all projects).
// ---------------------------------------------------------------------------

/** Project ALPHA: decision×active, decision×superseded, convention×active, gotcha×active, doc×active — every n is 1. */
const PROJECT_FLOW = [
  { type: 'convention', status: 'active', n: 1 },
  { type: 'decision', status: 'active', n: 1 },
  { type: 'decision', status: 'superseded', n: 1 },
  { type: 'doc', status: 'active', n: 1 },
  { type: 'gotcha', status: 'active', n: 1 },
]

/** All projects: BETA adds doc×active (making doc 2) and Methods/m.md adds method×active. */
const ALL_FLOW = [
  { type: 'doc', status: 'active', n: 2 },
  { type: 'convention', status: 'active', n: 1 },
  { type: 'decision', status: 'active', n: 1 },
  { type: 'decision', status: 'superseded', n: 1 },
  { type: 'gotcha', status: 'active', n: 1 },
  { type: 'method', status: 'active', n: 1 },
]

for (const [backend, label] of BACKENDS) {
  test(`stats carries the joint type×status flow (${label})`, async (t) => {
    const index = await harness(t, backend)
    assert.deepEqual((await index.stats({ scope: 'project' })).flow, PROJECT_FLOW)
    assert.deepEqual((await index.stats({ scope: 'all' })).flow, ALL_FLOW)
  })

  test(`stats flow margins agree with byType/byStatus and the note total (${label})`, async (t) => {
    const index = await harness(t, backend)
    for (const scope of ['project', 'all']) {
      const counts = await index.stats({ scope })
      const flow = counts.flow
      assert.ok(Array.isArray(flow), 'flow is always an array: ' + scope)
      const sum = (rows) => rows.reduce((total, row) => total + row.n, 0)
      // Every printed number in the Sankey's section meta is this total.
      assert.equal(sum(flow), counts.notes, 'flow total equals the note count: ' + scope)
      assert.deepEqual(Object.keys(counts.flow[0]).sort(), ['n', 'status', 'type'])
      // A link may not invent a margin: both columns the view draws are real.
      for (const row of counts.byType) {
        assert.equal(
          sum(flow.filter((line) => line.type === row.type)),
          row.n,
          'type margin ' + row.type + ': ' + scope,
        )
      }
      for (const row of counts.byStatus) {
        assert.equal(
          sum(flow.filter((line) => line.status === row.status)),
          row.n,
          'status margin ' + row.status + ': ' + scope,
        )
      }
      // Every key in a margin appears in the flow (all rows are active, n > 0).
      for (const row of counts.byType)
        assert.ok(
          flow.some((line) => line.type === row.type),
          'flow covers type ' + row.type,
        )
      for (const row of counts.byStatus)
        assert.ok(
          flow.some((line) => line.status === row.status),
          'flow covers status ' + row.status,
        )
      // Active only: a zero-count joint pair is not a link that could be drawn.
      for (const row of flow) assert.ok(row.n > 0, 'no zero-thickness link: ' + scope)
    }
  })
}

test(
  'stats flow is identical across both backends',
  { skip: HAS_SQLITE ? false : 'node:sqlite is unavailable on this host' },
  async (t) => {
    const scanIndex = await harness(t, 'scan')
    const sqliteIndex = await harness(t, 'sqlite')
    assert.deepEqual(
      (await scanIndex.stats({ scope: 'project' })).flow,
      (await sqliteIndex.stats({ scope: 'project' })).flow,
    )
    assert.deepEqual(
      (await scanIndex.stats({ scope: 'all' })).flow,
      (await sqliteIndex.stats({ scope: 'all' })).flow,
    )
  },
)

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

// ---------------------------------------------------------------------------
// The 概览 charts' two aggregates (memory-panel v0.4). Expected numbers are
// hand-written from the fixture below, never derived from the implementation.
//
// A dedicated fixture is used because the shared one above has fixed mtimes and
// no `created` values: a date aggregate needs control over both.
// ---------------------------------------------------------------------------

/** A local day `offset` days away from today, as `YYYY-MM-DD`. */
function localDay(offset = 0) {
  const now = new Date()
  const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset)
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** One note carrying explicit `created`/`updated` dates and tags. */
function datedNote(fields) {
  const lines = [
    '---',
    'id: "' + fields.id + '"',
    'type: "' + (fields.type ?? 'doc') + '"',
    'title: "' + fields.id + '"',
    'status: "' + (fields.status ?? 'active') + '"',
  ]
  if (fields.created !== undefined) lines.push('created: ' + fields.created)
  if (fields.updated !== undefined) lines.push('updated: ' + fields.updated)
  lines.push('project: "' + (fields.project ?? ALPHA) + '"')
  if (fields.tags !== undefined) lines.push("tags: ['" + fields.tags.join("', '") + "']")
  lines.push('---', '# ' + fields.id, '')
  return lines.join('\n')
}

/**
 * A vault whose activity is known day by day. All notes are in project ALPHA
 * unless stated:
 *   n1  created -3, updated -1          → created at -3 AND an update at -1 (later day)
 *   n2  created -1, updated -1          → a creation at -1 only (same-day edit)
 *   n3  created -1, updated -10         → a creation at -1 only (stale update)
 *   n4  no created, file mtime -2 noon  → a creation at -2, from the mtime fallback
 *   n5  created -40, updated -40        → outside 7 days, inside 60
 *   n6  created -40, updated -2         → an UPDATE at -2: created long before the window
 *   b1  project BETA, created -1        → never counted in a project scope
 *
 * The three cases are the rule: a note written and edited on the same local day is
 * one creation (n2); an edit on a later day is also an update, even though its
 * creation is inside the window (n1); a note created before the window contributes
 * only an update (n6). A note created in the window and edited on a later day counts
 * once in each series — a window-wide "created notes never update" rule erased the
 * panel's updated series whenever the window covered the whole vault. The digest
 * projects the same two values with the same rule, and the two must not disagree.
 */
async function makeActivityVault() {
  const root = await mkdtemp(join(tmpdir(), 'obsidian-mem-activity-'))
  const vault = join(root, 'vault')
  const files = [
    [
      `${A}/Docs/n1.md`,
      { id: 'n1', created: localDay(-3), updated: localDay(-1), tags: ['alpha'] },
    ],
    [
      `${A}/Docs/n2.md`,
      { id: 'n2', created: localDay(-1), updated: localDay(-1), tags: ['alpha', 'beta'] },
    ],
    [
      `${A}/Docs/n3.md`,
      { id: 'n3', created: localDay(-1), updated: localDay(-10), tags: ['beta'] },
    ],
    [`${A}/Docs/n4.md`, { id: 'n4', tags: ['gamma'] }],
    [`${A}/Docs/n5.md`, { id: 'n5', created: localDay(-40), updated: localDay(-40) }],
    [`${A}/Docs/n6.md`, { id: 'n6', created: localDay(-40), updated: localDay(-2) }],
    [`${B}/Docs/b1.md`, { id: 'b1', project: BETA, created: localDay(-1), tags: ['beta'] }],
  ]
  for (const [path, fields] of files) {
    const absolute = join(vault, ...path.split('/'))
    await mkdir(dirname(absolute), { recursive: true })
    await writeFile(absolute, datedNote(fields), 'utf8')
  }
  // n4 has no `created`, so its day comes from the file mtime: two days ago at
  // local noon, which is unambiguously that local day on every host timezone.
  const noon = new Date()
  noon.setDate(noon.getDate() - 2)
  noon.setHours(12, 0, 0, 0)
  await utimes(join(vault, ...`${A}/Docs/n4.md`.split('/')), noon, noon)
  return { root, vault, dataRoot: join(root, 'data') }
}

/** Open one index over a fresh activity fixture. */
async function activityHarness(t, backend) {
  const { root, vault, dataRoot } = await makeActivityVault()
  const index = await openIndex({ vaultRoot: vault, dataRoot, backend, projectId: ALPHA })
  t.after(async () => {
    await index.close().catch(() => {})
    await rm(root, { recursive: true, force: true })
  })
  const ready = await index.waitReady(undefined, 120_000)
  assert.equal(ready.ready, true, ready.reason)
  return index
}

for (const [backend, label] of BACKENDS) {
  test(`activity buckets created and updated by local day (${label})`, async (t) => {
    const index = await activityHarness(t, backend)
    const value = await index.activity({ scope: 'project', days: 7 })
    assert.deepEqual(Object.keys(value).sort(), ['created', 'days', 'from', 'to', 'updated'])
    assert.equal(value.days.length, 7)
    assert.equal(value.to, localDay(0), 'the window ends today')
    assert.equal(value.from, localDay(-6), 'a 7-day window starts six days back')
    const at = (series, offset) => series[value.days.indexOf(localDay(offset))]
    // n1 at -3 and n4 at -2 (the mtime fallback). n2 and n3 both land on -1.
    assert.equal(at(value.created, -3), 1)
    assert.equal(at(value.created, -2), 1)
    assert.equal(at(value.created, -1), 2)
    // A creation and an edit on the same local day are one creation (n2), but an
    // edit on a later day is also an update even when the creation is inside the
    // window: n1 (created -3, edited -1) contributes both, and n6 (created 40 days
    // ago, edited -2) contributes only the update.
    assert.equal(at(value.updated, -2), 1)
    assert.equal(at(value.updated, -1), 1)
    assert.equal(at(value.updated, -3), 0)
    assert.equal(
      value.days.reduce((sum, _, i) => sum + value.created[i], 0),
      4,
    )
    assert.equal(
      value.days.reduce((sum, _, i) => sum + value.updated[i], 0),
      2,
    )
  })

  test('same-day creation and edit is one creation; a later-day edit is also an update', () => {
    // The rule the panel's activity series (and the digest) project onto the two
    // frontmatter values, isolated from the fixture above: a note created and edited
    // on the same local day counts once, as a creation; an edit on a later day is an
    // update even when its creation is inside the window; a note created before the
    // window contributes only its update.
    const window = activityWindow(7)
    const day = (offset) => window.days[6 + offset]
    const series = bucketActivity(window, [
      { created: day(-2), updated: day(-2), mtimeDay: null }, // same local day
      { created: day(-3), updated: day(-1), mtimeDay: null }, // later day, created inside
      { created: day(-30), updated: day(-2), mtimeDay: null }, // created before the window
    ])
    const at = (values, offset) => values[window.days.indexOf(day(offset))]
    assert.equal(at(series.created, -3), 1, 'the later-day note was still created')
    assert.equal(at(series.created, -2), 1, 'the same-day note was created')
    assert.equal(at(series.updated, -1), 1, 'a later-day edit of an in-window note is an update')
    assert.equal(at(series.updated, -2), 1, 'the before-window note contributes its update')
    assert.equal(at(series.updated, -3), 0, 'a same-day edit is never a second event')
    assert.equal(
      series.created.reduce((sum, n) => sum + n, 0),
      2,
      'two creations',
    )
    assert.equal(
      series.updated.reduce((sum, n) => sum + n, 0),
      2,
      'two updates',
    )
  })

  test(`activity is project-scoped and widens on demand (${label})`, async (t) => {
    const index = await activityHarness(t, backend)
    const total = (series) => series.reduce((sum, value) => sum + value, 0)
    const all = await index.activity({ scope: 'all', days: 7 })
    const project = await index.activity({ scope: 'project', days: 7 })
    assert.equal(total(all.created), total(project.created) + 1, 'beta b1 adds one')
    const wide = await index.activity({ scope: 'project', days: 60 })
    assert.equal(wide.days.length, 60)
    assert.equal(wide.from, localDay(-59))
    assert.equal(total(wide.created), 6, 'n5 and n6 land inside a 60-day window')
  })

  test(`activity refuses a bad window instead of guessing (${label})`, async (t) => {
    const index = await activityHarness(t, backend)
    for (const days of [6, 366, 2.5, 0, -7, '30'])
      await assert.rejects(index.activity({ scope: 'project', days }), RangeError, String(days))
    await assert.rejects(index.activity({ scope: 'nope' }), RangeError)
  })

  test(`tagFrequencies counts tag occurrences in the project (${label})`, async (t) => {
    const index = await activityHarness(t, backend)
    const value = await index.tagFrequencies({ scope: 'project', limit: 10 })
    assert.deepEqual(value.items, [
      { tag: 'alpha', n: 2 },
      { tag: 'beta', n: 2 },
      { tag: 'gamma', n: 1 },
    ])
    assert.equal(value.total, 5, 'project tags: alpha×2, beta×2, gamma×1')
    // `distinct` is how many DIFFERENT tags exist, which is neither `items.length`
    // (that is the page) nor `total` (that is occurrences). The panel's "另有 N 个标签"
    // is a tag count, so deriving it from `total` would print occurrences as tags.
    assert.equal(value.distinct, 3, 'three distinct tags, five occurrences')
    const all = await index.tagFrequencies({ scope: 'all', limit: 10 })
    assert.equal(all.total, 6, 'beta in project BETA adds a third beta')
    assert.equal(all.distinct, 3, 'still three distinct tags across both projects')
    assert.deepEqual(all.items[0], { tag: 'beta', n: 3 })
  })

  test(`tagFrequencies bounds its page and rejects a bad limit (${label})`, async (t) => {
    const index = await activityHarness(t, backend)
    const value = await index.tagFrequencies({ scope: 'project', limit: 1 })
    assert.equal(value.items.length, 1)
    assert.equal(value.total, 5, 'total reports every occurrence, not the page')
    assert.equal(value.distinct, 3, 'distinct reports the whole ranking, not the page')
    for (const limit of [0, 51, 1.5, '12'])
      await assert.rejects(index.tagFrequencies({ scope: 'project', limit }), RangeError)
  })
}

test(
  'activity and tagFrequencies agree across both backends',
  { skip: HAS_SQLITE ? false : 'node:sqlite is unavailable on this host' },
  async (t) => {
    const scanIndex = await activityHarness(t, 'scan')
    const sqliteIndex = await activityHarness(t, 'sqlite')
    assert.deepEqual(
      await scanIndex.activity({ scope: 'project', days: 30 }),
      await sqliteIndex.activity({ scope: 'project', days: 30 }),
    )
    assert.deepEqual(
      await scanIndex.tagFrequencies({ scope: 'all', limit: 20 }),
      await sqliteIndex.tagFrequencies({ scope: 'all', limit: 20 }),
    )
  },
)
