import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { scanCuration, MAX_NOTE_FINDINGS, MAX_NOTE_FINDING_BYTES } from '../lib/curation-scan.js'
import { MAX_SCAN_DEPTH, isIndexableRelativePath } from '../lib/index-db.js'
import {
  saveCurationProposal,
  readCurationProposal,
  recordCurationFindings,
  MAX_LIST_LIMIT,
} from '../lib/curation-proposals.js'
import {
  curationRecordPath,
  readCurationCursor,
  readScanRecord,
  MAX_VIEW_BYTES,
  writeCurationViewJson,
} from '../lib/curation-state.js'
import {
  buildCurationView,
  groupExactEntries,
  MAX_VIEW_DOCUMENT_BYTES,
} from '../lib/curation-view.js'
import { resolveBinding } from '../lib/vault.js'
import { localDate as memoryDate } from '../lib/memory.js'
import { localDate as healthDate } from '../lib/note-health.js'
import { makeCurationWorld } from './curation-world.js'

const digest = (value) => createHash('sha256').update(value).digest('hex')
const NOW = new Date('2026-10-04T00:00:00Z')
async function world(t) {
  const made = await makeCurationWorld(t)
  const seed = await made.services.write({ type: 'doc', title: '起点', body: '正文。' })
  const binding = await resolveBinding({
    cwd: made.repo,
    vaultRoot: made.vault,
    home: made.home,
    mode: 'show',
  })
  return { ...made, seed, binding }
}
function scan(made, options = {}) {
  return scanCuration(made.binding, {
    dataRoot: made.dataRoot,
    home: made.home,
    now: NOW,
    maxMs: 60000,
    ...options,
  })
}
async function raw(made, path, title, body = '正文。') {
  const absolute = join(made.vault, path)
  await fs.mkdir(join(absolute, '..'), { recursive: true })
  await fs.writeFile(
    absolute,
    `---\ntype: doc\ntitle: ${JSON.stringify(title)}\nproject: ${made.binding.projectId}\nstatus: active\n---\n${body}\n`,
  )
}
function proposal(made, extra = {}) {
  return {
    dataRoot: made.dataRoot,
    projectId: made.binding.projectId,
    itemKey: 'fixed-item',
    kind: 'near-duplicate',
    reviewOnly: true,
    sources: [],
    reason: 'review this pair',
    now: NOW,
    ...extra,
  }
}

test('exclusive publication exposes whole bytes and replays during the publication seam', async (t) => {
  const made = await world(t)
  const open = fs.open
  let entered
  const paused = new Promise((resolve) => {
    entered = resolve
  })
  let resume
  const gate = new Promise((resolve) => {
    resume = resolve
  })
  let intercepted = false
  fs.open = async (path, ...args) => {
    const handle = await open(path, ...args)
    if (!intercepted && String(path).includes('/proposals/') && args[0] === 'wx') {
      intercepted = true
      const write = handle.writeFile.bind(handle)
      handle.writeFile = async (...input) => {
        entered()
        await gate
        return write(...input)
      }
    }
    return handle
  }
  const first = saveCurationProposal(proposal(made))
  await paused
  let second
  try {
    second = await saveCurationProposal(proposal(made))
    assert.equal(
      (
        await readCurationProposal({
          dataRoot: made.dataRoot,
          projectId: made.binding.projectId,
          proposalId: second.proposalId,
        })
      ).reason,
      'review this pair',
    )
  } finally {
    resume()
    fs.open = open
    await first.catch(() => {})
  }
  assert.equal((await first).proposalId, second.proposalId)
  assert.deepEqual(
    (await fs.readdir(join(made.dataRoot, 'curation', 'proposals', made.binding.projectId))).filter(
      (name) => name.startsWith('.'),
    ),
    [],
  )
})

test('simultaneous identical and conflicting producers retain one intact candidate', async (t) => {
  const made = await world(t)
  const [a, b] = await Promise.all([
    saveCurationProposal(proposal(made)),
    saveCurationProposal(proposal(made)),
  ])
  assert.equal(a.proposalId, b.proposalId)
  const results = await Promise.allSettled([
    saveCurationProposal(proposal(made, { itemKey: 'conflict', title: 'first' })),
    saveCurationProposal(proposal(made, { itemKey: 'conflict', title: 'second' })),
  ])
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
  assert.equal(
    results.find((result) => result.status === 'rejected').reason.code,
    'proposal-conflict',
  )
})

test('findings retire an older row beyond the status limit and count replays honestly', async (t) => {
  const made = await world(t)
  const finding = {
    kind: 'missing-provenance',
    path: made.seed.path,
    message: 'missing provenance',
    missing: ['harness'],
  }
  const initial = await recordCurationFindings({
    binding: made.binding,
    dataRoot: made.dataRoot,
    findings: [finding],
    now: new Date('2020-01-01'),
  })
  for (let index = 0; index <= MAX_LIST_LIMIT; index += 1) {
    await saveCurationProposal(proposal(made, { itemKey: `filler-${index}` }))
  }
  const replay = await recordCurationFindings({
    binding: made.binding,
    dataRoot: made.dataRoot,
    findings: [finding, finding],
    now: NOW,
  })
  assert.equal(replay.created.length, 0)
  assert.equal(replay.replayed.length, 2)
  assert.deepEqual(replay.updated, [])
  await fs.appendFile(join(made.vault, made.seed.path), '\nChanged evidence.\n')
  const changed = await recordCurationFindings({
    binding: made.binding,
    dataRoot: made.dataRoot,
    findings: [finding],
    now: NOW,
  })
  assert.deepEqual(
    changed.retired.map((row) => row.proposalId),
    [initial.created[0].proposalId],
  )
  assert.equal(changed.created.length, 1)
  assert.equal(changed.processingTruncated, false)
})

test('proposal identity is the canonical path-to-hash mapping independently of ordering', async (t) => {
  const made = await world(t)
  const paths = [`${made.binding.relativeDir}/Docs/a.md`, `${made.binding.relativeDir}/Docs/b.md`]
  const sources = [
    { path: paths[1], hash: 'b'.repeat(64) },
    { path: paths[0], hash: 'a'.repeat(64) },
  ]
  const input = proposal(made, { itemKey: 'vector', sources })
  const canonical = JSON.stringify({
    itemKey: 'vector',
    kind: 'near-duplicate',
    projectId: made.binding.projectId,
    sources: { [paths[0]]: 'a'.repeat(64), [paths[1]]: 'b'.repeat(64) },
  })
  const record = await saveCurationProposal(input)
  assert.equal(record.proposalId, digest(canonical))
  assert.equal(
    (await saveCurationProposal({ ...input, sources: [...sources].reverse() })).proposalId,
    record.proposalId,
  )
  const executable = await saveCurationProposal(
    proposal(made, {
      itemKey: 'ordered-operation',
      sources,
      operation: { kind: 'create-separate', item: { title: 'candidate', body: 'same bytes' } },
    }),
  )
  const reordered = await saveCurationProposal({
    operation: { item: { body: 'same bytes', title: 'candidate' }, kind: 'create-separate' },
    ...proposal(made, { itemKey: 'ordered-operation' }),
    sources: [...sources].reverse(),
  })
  assert.equal(reordered.proposalId, executable.proposalId)
  assert.equal(reordered.contentHash, executable.contentHash)
  assert.notEqual(
    (
      await saveCurationProposal({
        ...input,
        sources: [{ ...sources[0], hash: 'c'.repeat(64) }, sources[1]],
      })
    ).proposalId,
    record.proposalId,
  )
})

test('full titles control near identity while legacy cached entries are reinspected', async (t) => {
  const made = await world(t)
  const prefix = '长'.repeat(256)
  const paths = ['a', 'b', 'c'].map((name) => `${made.binding.relativeDir}/Docs/${name}.md`)
  await raw(made, paths[0], `${prefix}甲`, `value 1 ${'d'.repeat(200)}`)
  await raw(made, paths[1], `${prefix}乙`, 'value 2')
  await raw(made, paths[2], `${prefix}甲`, 'value 3')
  const first = await scan(made)
  assert.deepEqual(
    first.findings
      .filter((finding) => finding.kind === 'near-duplicate')
      .map((finding) => finding.paths),
    [[paths[0], paths[2]]],
  )
  assert.equal(first.entries.find((entry) => entry.path === paths[0]).title.length, 256)
  assert.equal(first.entries.find((entry) => entry.path === paths[0]).description.length, 160)
  const file = curationRecordPath(made.dataRoot, made.binding.projectId, paths[1])
  const legacy = JSON.parse(await fs.readFile(file, 'utf8'))
  delete legacy.entry.nearKey
  await fs.writeFile(file, JSON.stringify(legacy))
  const next = await scan(made)
  assert.ok(next.examinedPaths.includes(paths[1]))
  assert.deepEqual(
    next.findings
      .filter((finding) => finding.kind === 'near-duplicate')
      .map((finding) => finding.paths),
    [[paths[0], paths[2]]],
  )
})

test('scanner and indexer enumerate the same vault-relative depth boundary', async (t) => {
  const made = await world(t)
  const boundaryDir = `${made.binding.relativeDir}/${Array.from({ length: MAX_SCAN_DEPTH - 3 }, (_, index) => `d${index}`).join('/')}`
  const inside = `${boundaryDir}/inside.md`
  const outside = `${boundaryDir}/deep/outside.md`
  assert.equal(inside.split('/').length, MAX_SCAN_DEPTH)
  assert.equal(isIndexableRelativePath(inside), true)
  await raw(made, inside, '边界')
  await raw(made, outside, '越界')
  const result = await scan(made)
  assert.ok(result.entries.some((entry) => entry.path === inside))
  assert.equal(
    result.entries.some((entry) => entry.path === outside),
    false,
  )
  const hits = await made.services.search({ query: '边界 越界' })
  assert.ok(hits.some((hit) => hit.path === inside))
  assert.equal(
    hits.some((hit) => hit.path === outside),
    false,
  )
})

test('a stale pass cannot replace a cursor from a newer manifest', async (t) => {
  const made = await world(t)
  const open = fs.open
  let entered
  const paused = new Promise((resolve) => {
    entered = resolve
  })
  let resume
  const gate = new Promise((resolve) => {
    resume = resolve
  })
  let intercepted = false
  fs.open = async (path, ...args) => {
    const handle = await open(path, ...args)
    if (!intercepted && String(path).includes('/curation/records/') && args[0] === 'wx') {
      intercepted = true
      entered()
      await gate
    }
    return handle
  }
  const older = scan(made, { maxNotes: 1, now: new Date('2026-10-03') })
  await paused
  let newer
  try {
    await raw(made, `${made.binding.relativeDir}/Docs/new.md`, 'new')
    newer = await scan(made)
  } finally {
    resume()
    fs.open = open
  }
  await older
  const stored = await readCurationCursor(made.dataRoot, made.binding.projectId)
  assert.deepEqual(stored, newer.cursor)
})

test('record persistence programming defects remain exceptions', async (t) => {
  const made = await world(t)
  const open = fs.open
  const defect = new TypeError('programming defect in record write')
  fs.open = async (path, ...args) => {
    if (String(path).includes('/curation/records/') && args[0] === 'wx') throw defect
    return open(path, ...args)
  }
  try {
    await assert.rejects(scan(made), (error) => error === defect)
  } finally {
    fs.open = open
  }
})

test('finding bytes truncate before the count bound and stored records remain reusable', async (t) => {
  const made = await world(t)
  const path = `${made.binding.relativeDir}/Docs/bytes.md`
  const links = Array.from({ length: 70 }, (_, index) => `[[${'缺'.repeat(200)}${index}]]`)
  await raw(made, path, 'byte budget', links.join(' '))
  const result = await scan(made)
  const record = await readScanRecord(made.dataRoot, made.binding.projectId, path)
  const linksKept = record.findings.filter((finding) => finding.kind === 'dead-wikilink')
  assert.ok(linksKept.length > 0 && linksKept.length < 70 && linksKept.length < MAX_NOTE_FINDINGS)
  assert.ok(
    linksKept.reduce((sum, finding) => sum + Buffer.byteLength(JSON.stringify(finding)), 0) <=
      MAX_NOTE_FINDING_BYTES,
  )
  assert.ok(record.findings.some((finding) => finding.kind === 'findings-truncated'))
  assert.equal(result.complete, true)
  assert.equal((await scan(made)).examinedPaths.length, 0)
})

test('view persistence bounds pretty bytes and rejects compact oversize without replacing the cache', async (t) => {
  const made = await world(t)
  const complete = await scan(made)
  assert.equal(
    (
      await buildCurationView({
        binding: made.binding,
        dataRoot: made.dataRoot,
        scan: complete,
        now: NOW,
      })
    ).status,
    'written',
  )
  const previous = await fs.readFile(
    join(made.dataRoot, 'curation', 'view', `${made.binding.projectId}.json`),
  )
  const entries = Array.from({ length: 4000 }, (_, index) => ({
    path: `${index}.md`,
    hash: 'a'.repeat(64),
    title: 'x',
    type: 'doc',
    exactKey: digest(String(Math.floor(index / 2))),
    description: '',
  }))
  const document = {
    version: 1,
    projectId: made.binding.projectId,
    complete: true,
    entries: groupExactEntries(entries),
    generatedAt: NOW.toISOString(),
  }
  assert.ok(Buffer.byteLength(JSON.stringify(document)) <= MAX_VIEW_BYTES)
  assert.ok(Buffer.byteLength(`${JSON.stringify(document, null, 2)}\n`) > MAX_VIEW_BYTES)
  await assert.rejects(writeCurationViewJson(made.dataRoot, made.binding.projectId, document), {
    code: 'state-oversize',
  })
  assert.ok(Buffer.byteLength(JSON.stringify(document)) > MAX_VIEW_DOCUMENT_BYTES)
  const result = await buildCurationView({
    binding: made.binding,
    dataRoot: made.dataRoot,
    scan: { entries, complete: true },
    now: NOW,
  })
  assert.equal(result.status, 'fallback')
  assert.equal(result.reason, 'view-oversize')
  assert.deepEqual(
    await fs.readFile(join(made.dataRoot, 'curation', 'view', `${made.binding.projectId}.json`)),
    previous,
  )
})

test('local date exports share the formatter and preserve local calendar behavior', () => {
  assert.equal(memoryDate, healthDate)
  const clock = new Date(2026, 0, 2, 0, 30)
  assert.equal(memoryDate(clock), '2026-01-02')
  assert.match(healthDate(), /^\d{4}-\d{2}-\d{2}$/u)
})

test('world cleanup is registered before fallible setup and removes the root after close errors', async () => {
  const callbacks = []
  await assert.rejects(
    makeCurationWorld(
      { after: (cleanup) => callbacks.push(cleanup) },
      { config: { briefBudget: -1 } },
    ),
  )
  assert.equal(callbacks.length, 1)
  await callbacks[0]()
  const made = await makeCurationWorld({ after: (cleanup) => callbacks.push(cleanup) })
  const defect = new Error('close failed')
  made.services.close = async () => {
    throw defect
  }
  await assert.rejects(callbacks[1](), (error) => error === defect)
  await assert.rejects(fs.stat(made.root), { code: 'ENOENT' })
})

test('equal-prefix concurrent passes keep the newer due timestamp', async (t) => {
  const made = await world(t)
  const open = fs.open
  let entered
  const paused = new Promise((resolve) => {
    entered = resolve
  })
  let resume
  const gate = new Promise((resolve) => {
    resume = resolve
  })
  let intercepted = false
  fs.open = async (path, ...args) => {
    const handle = await open(path, ...args)
    if (!intercepted && String(path).includes('/curation/records/') && args[0] === 'wx') {
      intercepted = true
      entered()
      await gate
    }
    return handle
  }
  const older = scan(made, { maxNotes: 1, now: new Date('2026-10-03') })
  await paused
  let newer
  try {
    newer = await scan(made, { maxNotes: 1 })
  } finally {
    resume()
    fs.open = open
  }
  await older
  assert.deepEqual(await readCurationCursor(made.dataRoot, made.binding.projectId), newer.cursor)
})

test('the degraded record retry also propagates programming defects', async (t) => {
  const made = await world(t)
  const open = fs.open
  const defect = new TypeError('defect in degraded retry')
  let attempts = 0
  fs.open = async (path, ...args) => {
    if (String(path).includes('/curation/records/') && args[0] === 'wx') {
      attempts += 1
      if (attempts === 1) throw Object.assign(new Error('permission refused'), { code: 'EACCES' })
      throw defect
    }
    return open(path, ...args)
  }
  try {
    await assert.rejects(scan(made), (error) => error === defect)
    assert.equal(attempts, 2)
  } finally {
    fs.open = open
  }
})
