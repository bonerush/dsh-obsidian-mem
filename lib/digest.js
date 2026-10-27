// The digest read contract, with all I/O and appraisal supplied by the caller.
// Keeping this leaf import-free lets the service reuse its jailed source reader
// and the shared appraisal resolver without making either a second filesystem.
const MAX_SOURCES = 200
const EMPTY_WINDOW_SOURCES = 50
const MAX_MS = 500
const MAX_FINDINGS = 20

/**
 * Collect a deterministic, bounded digest without writing any source.
 *
 * `listSources` returns current-project metadata, newest first, and truthfully
 * marks a partial listing. It must honour `limit` (201); metadata is only a
 * selection hint. Every reported note is read again through `readSource`, which
 * must enforce the caller's path jail. Generated `_meta/digest.md` is excluded.
 * `appraise` owns the closed finding vocabulary and source-verified resolver;
 * it receives source records and the remaining part of the same 500 ms budget.
 *
 * Counts describe inspected source notes, not unobserved transitions or a full
 * vault. Missing snapshots stay null, and incomplete reads are disclosed.
 *
 * @param {object} options - injected read-only inputs.
 * @param {number} [options.days] - trailing UTC days, integer 1..30, default 1.
 * @param {() => Date} [options.clock] - the wall clock, captured once.
 * @param {() => number} [options.now] - monotonic milliseconds for the deadline.
 * @param {(options: object) => Promise<{sources: object[], truncated?: boolean}>} options.listSources - bounded current-project metadata.
 * @param {(path: string, options: object) => Promise<object>} options.readSource - the jailed `readNote` seam.
 * @param {(options: object) => Promise<object>} [options.readHot] - current hot snapshot.
 * @param {(options: object) => Promise<object>} [options.readQueue] - current queue counts.
 * @param {(records: object[], options: object) => object|Promise<object>} options.appraise - shared deterministic appraisal.
 * @returns {Promise<object>} the v3 digest result, with snapshot and collection provenance.
 * @throws {RangeError} when days, clocks or required readers are invalid.
 */
export async function collectDigest(options = {}) {
  const days = options.days === undefined ? 1 : options.days
  if (!Number.isSafeInteger(days) || days < 1 || days > 30)
    throw new RangeError('digest.days must be an integer in 1..30')
  const clock = options.clock ?? (() => new Date())
  const now = options.now ?? Date.now
  for (const [name, reader] of Object.entries({
    clock,
    now,
    listSources: options.listSources,
    readSource: options.readSource,
    appraise: options.appraise,
  })) {
    if (typeof reader !== 'function') throw new RangeError(`digest.${name} must be a function`)
  }
  const instant = clock()
  if (!(instant instanceof Date) || !Number.isFinite(instant.getTime()))
    throw new RangeError('digest.clock must return a valid Date')
  const window = {
    days,
    from: new Date(instant.getTime() - days * 86_400_000).toISOString(),
    to: instant.toISOString(),
  }
  const deadline = now() + MAX_MS
  const controller = new AbortController()
  const reasons = new Set()
  const collection = {
    basis: 'inspected-source-notes',
    inspected: 0,
    limit: MAX_SOURCES,
    truncated: false,
    incomplete: false,
    reasons: [],
  }
  const incomplete = (reason) => {
    collection.incomplete = true
    reasons.add(reason)
  }

  // Promise.race bounds even a reader that ignores cancellation; abort is also
  // offered to cooperative readers so work need not continue after disclosure.
  async function readWithin(read, failure) {
    const remaining = deadline - now()
    if (remaining <= 0 || controller.signal.aborted) {
      incomplete('deadline')
      controller.abort()
      return null
    }
    let timer
    const expired = Symbol('deadline')
    try {
      const value = await Promise.race([
        Promise.resolve().then(() => read({ signal: controller.signal })),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(expired), remaining)
        }),
      ])
      if (value === expired) {
        incomplete('deadline')
        controller.abort()
        return null
      }
      return value
    } catch {
      incomplete(failure)
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  async function snapshot(reader, name) {
    if (typeof reader !== 'function') {
      incomplete(`${name}-unavailable`)
      return null
    }
    const value = await readWithin(reader, `${name}-read`)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      incomplete(`${name}-unavailable`)
      return null
    }
    return value
  }

  const [listing, hot, queue] = await Promise.all([
    readWithin(
      (input) => options.listSources({ ...input, window, limit: MAX_SOURCES + 1 }),
      'source-list',
    ),
    snapshot(options.readHot, 'hot'),
    snapshot(options.readQueue, 'queue'),
  ])
  const listed = Array.isArray(listing?.sources) ? listing.sources : []
  if (!Array.isArray(listing?.sources)) incomplete('source-list')
  if (listing?.truncated === true || listed.length > MAX_SOURCES + 1) {
    collection.truncated = true
    reasons.add('source-limit')
  }
  const unique = new Map()
  for (const source of listed.slice(0, MAX_SOURCES + 1)) {
    if (typeof source?.path !== 'string' || generatedDigest(source.path)) continue
    if (!unique.has(source.path)) unique.set(source.path, source)
  }
  const sources = [...unique.values()].sort(newestFirst)
  const changed = sources.filter((source) => inWindow(source.updated, window))
  const candidates = changed.length === 0 ? sources : changed
  const limit = changed.length === 0 ? EMPTY_WINDOW_SOURCES : MAX_SOURCES
  if (candidates.length > limit) {
    collection.truncated = true
    reasons.add('source-limit')
  }
  const records = []
  for (const source of candidates.slice(0, limit)) {
    if (now() >= deadline || controller.signal.aborted) {
      incomplete('deadline')
      controller.abort()
      break
    }
    collection.inspected += 1
    const note = await readWithin((input) => options.readSource(source.path, input), 'source-read')
    if (note === null || typeof note !== 'object') {
      if (!controller.signal.aborted) incomplete('source-read')
      continue
    }
    if (generatedDigest(note.path ?? source.path)) continue
    records.push({
      path: source.path,
      title: note.title ?? '',
      type: note.type ?? 'untyped',
      status: note.status ?? '',
      updated: note.updated ?? null,
      projectId: note.projectId ?? null,
      data: note.frontmatter ?? null,
      body: note.body ?? '',
    })
  }
  const changedRecords = records.filter((record) => inWindow(record.updated, window))
  const appraisal = await readWithin(
    (input) =>
      options.appraise(changedRecords.length === 0 ? records.slice(0, 50) : changedRecords, {
        ...input,
        today: window.to.slice(0, 10),
        now,
        maxNotes: MAX_SOURCES,
        maxMs: Math.max(0, Math.floor(deadline - now())),
        maxFindings: MAX_FINDINGS,
      }),
    'appraisal-read',
  )
  collection.reasons = [...reasons].sort(compareText)
  return renderDigest(records, { window, appraisal, hot, queue, collection })
}

/**
 * Project already-read source records into the v3 digest shape, without I/O.
 * New notes and updates do not overlap. Superseded is a current status snapshot
 * among these records because source metadata cannot prove a status transition.
 *
 * @param {object[]} records - source records, with `data` containing frontmatter.
 * @param {object} input - `{window, appraisal, hot, queue, collection}`.
 * @returns {object} the disclosure consumed by the existing DigestCard.
 */
export function renderDigest(records, input) {
  const { window, hot = null, queue = null, collection } = input
  const notes = { created: 0, updated: 0, superseded: 0, byType: [] }
  const byType = new Map()
  for (const record of records) {
    const created = inWindow(record.data?.created, window)
    const updated = !created && inWindow(record.updated, window)
    notes.created += Number(created)
    notes.updated += Number(updated)
    notes.superseded += Number(record.status === 'superseded')
    if (!created && !updated) continue
    const type = record.type || 'untyped'
    const counts = byType.get(type) ?? { type, created: 0, updated: 0 }
    counts.created += Number(created)
    counts.updated += Number(updated)
    byType.set(type, counts)
  }
  notes.byType = [...byType.values()].sort(
    (left, right) => right.created - left.created || compareText(left.type, right.type),
  )
  const appraisal = input.appraisal
    ? {
        findings: input.appraisal.findings.slice(0, MAX_FINDINGS),
        total: input.appraisal.total,
        truncated:
          input.appraisal.truncated ||
          input.appraisal.findings.length > MAX_FINDINGS ||
          collection.truncated ||
          collection.incomplete,
        scanned: input.appraisal.scanned,
      }
    : null
  return {
    window: { ...window },
    notes,
    hot,
    queue,
    appraisal,
    recent: [...records]
      .sort(newestFirst)
      .slice(0, 8)
      .map(({ path, title, type, status, updated }) => ({
        path,
        title,
        type,
        status,
        updated,
      })),
    snapshot: {
      at: window.to,
      basis: 'current-status-among-inspected-sources',
      fields: ['notes.superseded', 'hot', 'queue'],
    },
    collection: { ...collection, reasons: [...collection.reasons] },
  }
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

function generatedDigest(path) {
  return /(?:^|\/)_meta\/digest\.md$/iu.test(path)
}

function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T|$)/u.test(value)) return null
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) return null
  // Date.parse normalises February 30; it is not evidence of a real source date.
  if (new Date(parsed).toISOString().slice(0, 10) !== value.slice(0, 10)) return null
  return parsed
}

function inWindow(value, window) {
  const parsed = timestamp(value)
  return parsed !== null && parsed >= Date.parse(window.from) && parsed <= Date.parse(window.to)
}

function newestFirst(left, right) {
  return (
    (timestamp(right.updated) ?? -Infinity) - (timestamp(left.updated) ?? -Infinity) ||
    compareText(left.path, right.path)
  )
}
