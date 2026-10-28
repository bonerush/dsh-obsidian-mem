import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { appraiseNotes, APPRAISAL_CODES } from '../lib/appraisal.js'
import { collectDigest, renderDigest } from '../lib/digest.js'
import { readNote } from '../lib/index-db.js'

const CLOCK = () => new Date('2026-10-27T12:00:00.000Z')
const PROJECT = 'Projects/demo--1c392abb'
const HOT = { used: 8, capacity: 100, missing: false, archived: null, moved: null, folded: null }
const QUEUE = { queued: 2, failed: 1, deferred: 3 }

async function fixture(t, notes) {
  const root = await mkdtemp(join(tmpdir(), 'memory-digest-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const originals = new Map()
  const sources = []
  for (const item of notes) {
    const path = `${PROJECT}/${item.path ?? `Docs/${sources.length}.md`}`
    const data = {
      title: item.title ?? path,
      type: 'decision',
      status: 'active',
      created: '2026-10-01',
      updated: '2026-10-27',
      assertion: 'stated',
      confidence: 0.9,
      ...item,
    }
    delete data.path
    delete data.body
    const bytes = Buffer.from(
      '---\n' +
        Object.entries(data)
          .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
          .join('\n') +
        '\n---\n' +
        (item.body ?? 'Source evidence.\n'),
    )
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), bytes)
    originals.set(path, bytes)
    sources.push({ path, updated: data.updated })
  }
  return {
    root,
    sources,
    originals,
    options: {
      clock: CLOCK,
      listSources: async () => ({ sources, truncated: false }),
      readSource: (path) => readNote(root, path),
      readHot: async () => HOT,
      readQueue: async () => QUEUE,
      appraise: appraiseNotes,
    },
  }
}

test('fixed UTC window separates creations from updates and labels current status counts', async (t) => {
  const world = await fixture(t, [
    { path: 'Docs/new.md', type: 'gotcha', created: '2026-10-27', updated: '2026-10-27' },
    { path: 'Docs/changed.md', type: 'decision', updated: '2026-10-26T12:00:00Z' },
    { path: 'Docs/old.md', status: 'superseded', updated: '2026-10-25' },
    { path: 'Docs/future.md', updated: '2026-10-28' },
  ])
  const result = await collectDigest(world.options)
  assert.deepEqual(result.window, {
    days: 1,
    from: '2026-10-26T12:00:00.000Z',
    to: '2026-10-27T12:00:00.000Z',
  })
  assert.deepEqual(result.notes, {
    created: 1,
    updated: 1,
    superseded: 0,
    byType: [
      { type: 'gotcha', created: 1, updated: 0 },
      { type: 'decision', created: 0, updated: 1 },
    ],
  })
  assert.deepEqual(result.snapshot, {
    at: '2026-10-27T12:00:00.000Z',
    basis: 'current-status-among-inspected-sources',
    fields: ['notes.superseded', 'hot', 'queue'],
  })
  assert.equal(result.collection.basis, 'inspected-source-notes')
  assert.equal(result.collection.inspected, 2)
  assert.equal(result.collection.incomplete, false)
  assert.deepEqual(result.hot, HOT)
  assert.deepEqual(result.queue, QUEUE)
  assert.deepEqual(await collectDigest(world.options), result)
})

test('an empty window appraises at most the 50 most recent notes and counts superseded as snapshot', async (t) => {
  const world = await fixture(
    t,
    Array.from({ length: 60 }, (_, index) => ({
      path: `Docs/${String(index).padStart(2, '0')}.md`,
      title: `Old ${index}`,
      status: index === 0 ? 'superseded' : 'active',
      updated: '2026-10-20',
    })),
  )
  // Same separation as the 200-source case above: this is the 50-note *cap*, and a
  // real clock lets the 500 ms deadline cut the run first on a loaded host (it did:
  // `appraisal` came back null and dereferencing it failed). A frozen `now` puts the
  // deadline out of reach so the cap is what is measured.
  const result = await collectDigest({ ...world.options, now: () => 0 })
  assert.deepEqual(result.notes, { created: 0, updated: 0, superseded: 1, byType: [] })
  assert.equal(result.appraisal.scanned, 50)
  assert.equal(result.collection.inspected, 50)
  assert.equal(result.collection.truncated, true)
  assert.equal(result.appraisal.truncated, true)
  assert.deepEqual(result.collection.reasons, ['source-limit'])
})

test('source timestamps control counts; invalid and missing dates never invent changes', async (t) => {
  const world = await fixture(t, [
    { path: 'Docs/a.md', created: '2026-02-30', updated: '2026-02-30' },
    { path: 'Docs/b.md', created: null, updated: null },
    { path: 'Docs/c.md', created: '2026-10-26T12:00:00Z', updated: '2026-10-27T12:00:00Z' },
  ])
  const result = await collectDigest({
    ...world.options,
    listSources: async () => ({
      sources: world.sources.map((source) => ({ ...source, updated: '2026-10-27' })),
    }),
  })
  assert.equal(result.notes.created, 1)
  assert.equal(result.notes.updated, 0)
  assert.equal(result.recent.find((row) => row.path.endsWith('/b.md')).updated, null)
})

test('type ties and recent timestamp ties sort by type and path, independent of source order', async (t) => {
  const world = await fixture(t, [
    { path: 'Docs/z.md', title: 'Z', type: 'gotcha', created: '2026-10-27' },
    { path: 'Docs/b.md', title: 'B', type: 'decision', created: '2026-10-27' },
    { path: 'Docs/a.md', title: 'A', type: 'decision', created: '2026-10-27' },
  ])
  const result = await collectDigest(world.options)
  assert.deepEqual(result.notes.byType, [
    { type: 'decision', created: 2, updated: 0 },
    { type: 'gotcha', created: 1, updated: 0 },
  ])
  assert.deepEqual(
    result.recent.map((row) => row.title),
    ['A', 'B', 'Z'],
  )
  assert.deepEqual(
    await collectDigest({
      ...world.options,
      listSources: async () => ({ sources: [...world.sources].reverse() }),
    }),
    result,
  )
})

test('the real appraisal seam preserves its closed vocabulary, total and finding cap', async (t) => {
  const world = await fixture(
    t,
    Array.from({ length: 30 }, (_, index) => ({
      title: `Review ${index}`,
      review_after: '2026-10-01',
    })),
  )
  const result = await collectDigest(world.options)
  assert.equal(result.appraisal.findings.length, 20)
  assert.equal(result.appraisal.total, 30)
  assert.equal(result.appraisal.scanned, 30)
  assert.equal(result.appraisal.truncated, true)
  assert(result.appraisal.findings.every((finding) => APPRAISAL_CODES.includes(finding.code)))
  assert.equal(result.recent.length, 8)
  assert.deepEqual(Object.keys(result.recent[0]), ['path', 'title', 'type', 'status', 'updated'])
})

test('the collector passes note bodies and frontmatter to the actual injected link appraisal', async (t) => {
  const world = await fixture(t, [{ body: 'See [[absent]]', status: 'contested' }])
  const result = await collectDigest({
    ...world.options,
    appraise: (records, options) => appraiseNotes(records, { ...options, resolves: () => false }),
  })
  assert.deepEqual(
    result.appraisal.findings.map((finding) => finding.code),
    ['dead-link', 'contested'],
  )
})

test('invalid days fail before readers run; default and 30-day windows remain exact', async (t) => {
  const world = await fixture(t, [])
  for (const days of [0, 31, 1.5, null, '1', NaN]) {
    await assert.rejects(collectDigest({ ...world.options, days }), RangeError)
  }
  assert.equal((await collectDigest(world.options)).window.days, 1)
  assert.equal(
    (await collectDigest({ ...world.options, days: 30 })).window.from,
    '2026-09-27T12:00:00.000Z',
  )
  const empty = await collectDigest(world.options)
  assert.deepEqual(empty.notes, { created: 0, updated: 0, superseded: 0, byType: [] })
  assert.equal(empty.collection.incomplete, false)
  assert.equal(empty.appraisal.scanned, 0)
})

test('the collector attempts no more than 200 sources and discloses incomplete source listings', async (t) => {
  const world = await fixture(
    t,
    Array.from({ length: 205 }, (_, index) => ({ title: `Note ${index}` })),
  )
  // This case is about the 200-source *cap*, not about the 500 ms deadline. The
  // real clock made it a race: 200 `readNote` calls over 205 freshly written files
  // measured 527 ms on this host, so the deadline could cut the run at 123 and the
  // assertion on `inspected` became a statement about disk speed. A frozen `now`
  // puts the deadline out of reach, which is what makes the cap the thing under
  // test — the deadline keeps its own two cases below.
  const result = await collectDigest({ ...world.options, now: () => 0 })
  assert.equal(result.collection.inspected, 200)
  assert.equal(result.notes.updated, 200)
  assert.equal(result.collection.truncated, true)
  assert.equal(result.collection.incomplete, false)
  assert.equal(result.appraisal.scanned, 200)
  assert.equal(result.appraisal.truncated, true)
  const partial = await collectDigest({
    ...world.options,
    listSources: async () => ({ sources: world.sources.slice(0, 2), truncated: true }),
  })
  assert.equal(partial.notes.updated, 2)
  assert.equal(partial.collection.truncated, true)
})

test('a source failure keeps the notes already read and never fabricates a missing record', async (t) => {
  const world = await fixture(t, [{ path: 'Docs/a.md' }, { path: 'Docs/b.md' }])
  await rm(join(world.root, world.sources[1].path))
  const result = await collectDigest(world.options)
  assert.equal(result.notes.updated, 1)
  assert.equal(result.collection.inspected, 2)
  assert.equal(result.collection.incomplete, true)
  assert.deepEqual(result.collection.reasons, ['source-read'])
  assert.equal(result.appraisal.scanned, 1)
  assert.equal(result.appraisal.truncated, true)
  assert.equal(result.recent.length, 1)
})

test('the shared deadline covers asynchronous source reads and stops subsequent inspection', async (t) => {
  const world = await fixture(t, [{ path: 'Docs/a.md' }, { path: 'Docs/b.md' }])
  let elapsed = 0
  const result = await collectDigest({
    ...world.options,
    now: () => elapsed,
    readSource: async (path) => {
      const note = await readNote(world.root, path)
      elapsed = 501
      return note
    },
  })
  assert.equal(result.collection.inspected, 1)
  assert.equal(result.notes.updated, 1)
  assert.equal(result.collection.incomplete, true)
  assert(result.collection.reasons.includes('deadline'))
  assert.equal(result.appraisal, null)
})

test('a non-settling reader cannot hold the digest past its 500 ms collection deadline', async (t) => {
  const world = await fixture(t, [{ path: 'Docs/a.md' }])
  let signal
  const started = performance.now()
  const result = await collectDigest({
    ...world.options,
    readSource: (_path, options) => {
      signal = options.signal
      return new Promise(() => {})
    },
  })
  assert(performance.now() - started < 1500)
  assert.equal(signal.aborted, true)
  assert.equal(result.notes.updated, 0)
  assert.equal(result.collection.incomplete, true)
  assert(result.collection.reasons.includes('deadline'))
})

test('generated digest paths are excluded, and a run leaves every input byte unchanged', async (t) => {
  const world = await fixture(t, [
    { path: '_meta/digest.md', title: 'Generated digest' },
    { path: 'Docs/a.md', title: 'Real note' },
  ])
  const result = await collectDigest(world.options)
  assert.equal(result.collection.inspected, 1)
  assert.equal(result.notes.updated, 1)
  assert.equal(result.recent[0].title, 'Real note')
  for (const [path, bytes] of world.originals) {
    assert.deepEqual(await readFile(join(world.root, path)), bytes)
  }
})

test('unavailable snapshots remain null with an explicit incomplete result', async (t) => {
  const world = await fixture(t, [])
  const result = await collectDigest({ ...world.options, readHot: undefined, readQueue: undefined })
  assert.equal(result.hot, null)
  assert.equal(result.queue, null)
  assert.equal(result.collection.incomplete, true)
  assert.deepEqual(result.collection.reasons, ['hot-unavailable', 'queue-unavailable'])
})

test('pure rendering projects values without sorting or changing supplied records', () => {
  const records = [
    {
      path: 'b.md',
      title: 'B',
      type: 'decision',
      status: 'superseded',
      updated: '2026-10-27',
      data: { created: '2026-10-01' },
    },
    {
      path: 'a.md',
      title: 'A',
      type: 'gotcha',
      status: 'active',
      updated: '2026-10-27',
      data: { created: '2026-10-27' },
    },
  ]
  const before = structuredClone(records)
  const result = renderDigest(records, {
    window: { days: 1, from: '2026-10-26T12:00:00.000Z', to: '2026-10-27T12:00:00.000Z' },
    hot: HOT,
    queue: QUEUE,
    appraisal: { findings: [], total: 0, truncated: false, scanned: 2 },
    collection: { inspected: 2, truncated: false, incomplete: false, reasons: [] },
  })
  assert.equal(result.notes.superseded, 1)
  assert.equal(result.notes.created, 1)
  assert.equal(result.notes.updated, 1)
  assert.deepEqual(records, before)
})

test('a date-only created value is compared in the vault calendar, not as UTC midnight', () => {
  // The vault writes `created: YYYY-MM-DD` from the host's local calendar, while
  // the digest window is a rolling UTC instant window. Parsing the date as UTC
  // midnight excluded "today" for hosts east of UTC between local midnight and
  // UTC midnight (measured 2026-10-29 00:10 +08: window ended 2026-10-28T16:10Z,
  // the note's created "2026-10-29" parsed to a future instant). The window here
  // spans mid-day UTC so the expected calendar comparison is timezone-independent.
  const window = { days: 1, from: '2026-10-27T12:00:00.000Z', to: '2026-10-28T12:00:00.000Z' }
  const records = [
    {
      path: 'today.md',
      title: 'today',
      type: 'decision',
      status: 'active',
      updated: '2026-10-28T11:00:00.000Z',
      data: { created: '2026-10-28' },
    },
    {
      path: 'tomorrow.md',
      title: 'tomorrow',
      type: 'decision',
      status: 'active',
      updated: '2026-10-30T00:00:00.000Z',
      data: { created: '2026-10-29' },
    },
    {
      path: 'old.md',
      title: 'old',
      type: 'decision',
      status: 'active',
      updated: '2026-10-27T12:30:00.000Z',
      data: { created: '2026-10-26' },
    },
  ]
  const result = renderDigest(records, {
    window,
    hot: HOT,
    queue: QUEUE,
    appraisal: { findings: [], total: 0, truncated: false, scanned: 3 },
    collection: { inspected: 3, truncated: false, incomplete: false, reasons: [] },
  })
  assert.equal(result.notes.created, 1, 'only the calendar date inside the window is a creation')
  assert.equal(result.notes.updated, 1, 'the older note is an update, not a creation')
})
