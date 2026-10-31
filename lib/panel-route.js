import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'

import { localDate } from './note-health.js'
import { PANEL_MUTATIONS, confirmPanelAction, previewPanelAction } from './panel-actions.js'
import { payloadOf, reply, trusted } from './route-guard.js'

// The memory panel's data plane: one route answers 概览 / 检索 / 健康 read-only,
// plus the two confirmed-mutation actions (Task 2) that can write exactly three
// reviewed operations. The read action list is still the whole read vocabulary and
// a test pins it; the mutation action list is separate so a read can never be
// mistaken for the start of a write. `services` and `resolveBinding` are injected,
// so this route stays at the bottom of the layer table and a test can drive every
// branch with stubs against a throwaway vault.

/** The one browser module the panel's views load. */
const DEFAULT_ASSETS = Object.freeze(['./memory-panel.js'])

/** Every POST action this route answers read-only. The mutation list is separate. */
export const PANEL_ACTIONS = Object.freeze(['overview', 'search', 'health'])

/** The two POST actions that can write: a preview, then its separate confirm. */
export const PANEL_MUTATION_ACTIONS = Object.freeze(['preview', 'confirm'])

/**
 * What a read value advertises to the panel: which operations this build supports
 * and that a preview/confirm exchange is available. The UI feature-detects it, so
 * a read-only build shows no confirm affordances at all.
 */
const CAPABILITIES = Object.freeze({
  mutations: [...PANEL_MUTATIONS],
  confirm: true,
})

/** The unbound value advertises the protocol but offers no operation to run. */
const UNBOUND_CAPABILITIES = Object.freeze({ mutations: [], confirm: true })

/** At most this many terminally failed jobs ride along for the retry sheet. */
const MAX_FAILED_JOBS = 5

/**
 * Response ceilings in bytes of UTF-8 JSON (spec §6).
 *
 * `overview` is 20 KiB while every other view keeps its old ceiling: the 371-day
 * heat map is the one honest payload whose size crosses 16 KiB. Measured on the
 * real vault on 2026-10-31: the 371-day activity series is 6,399 B, the real
 * 182-day overview answer 10,697 B, and the same answer carrying the real year
 * series 13,909 B. The dense-year fixture in test/panel-route.test.js (371 days
 * with two-digit counts plus real-shaped cards) answers 15,209 B, and a fully
 * active year reaches ~16.7 KiB by the conservative upper bound — the whole
 * 182-day answer (10,697 B) plus the full year series (6,399 B). At 16 KiB the
 * trimmer's FIRST stage fires on such an answer: `shrink()` gives back the wide
 * activity window before anything else, so the calendar would silently snap back
 * to 84 days. 20 KiB keeps a fully active year whole; the shrink order is unchanged.
 */
const CEILINGS = Object.freeze({
  overview: 20 * 1024,
  search: 32 * 1024,
  health: 32 * 1024,
  preview: 8 * 1024,
  confirm: 8 * 1024,
})

const MAX_SESSION_ID = 180
const DEFAULT_SEARCH_LIMIT = 25
const MAX_SEARCH_LIMIT = 50
const MAX_FIELD_CHARS = 64
const MAX_SNIPPET_CHARS = 300
/** The most rows the 最近变化 wire array ever carries (the card's eight lines). */
const RECENT_LIMIT = 8
// The panel draws 最近变化 as GitHub-style DAY GROUPS, so a flat newest-8 read
// collapses to one group exactly when the vault is busiest (live 2026-10-31: all
// eight rows shared one day while the digest reported 45 notes created that day).
// The route scans a wide internal page and samples days from it; the wire still
// carries at most RECENT_LIMIT rows, so this widens a read, not the payload.
const RECENT_SCAN_LIMIT = 500
/** How many distinct `updated` days the day-diverse sample spans, newest first. */
const RECENT_MAX_DAYS = 4
/** How many rows one calendar day contributes to the sample. */
const RECENT_PER_DAY = 2
const MAX_DIAGNOSTIC_EVENTS = 20
/** The 概览 calendar's DESIGN window: twelve weeks, the size every older client gets. */
const ACTIVITY_DAYS = 84
// A wide panel asks for a whole year so its fixed GitHub-style calendar fills the
// body: 371 days = 53 whole Sunday-first weeks, one column per week. This mirrors
// `MAX_ACTIVITY_DAYS` in ./index-stats.js (the index rejects a wider ask) and is the
// largest activity the 20 KiB overview budget pays for; the route clamps.
const ACTIVITY_DAYS_MAX = 371
// 24 is the frequency chart's page: the treemap draws area-proportional tiles plus a
// tail row, so it needs enough rows to show the long tail rather than the same eight
// tags the old ranked bars printed. `distinct` still carries the real remainder, and
// the trimmer halves this page first, so the byte ceiling stays the same promise.
const TAG_LIMIT = 24
/** The window `shrink()` falls back to when the charts do not fit: four weeks. */
const ACTIVITY_TRIM_DAYS = 28

/**
 * How often a live panel read may re-scan the project index.
 *
 * The panel polls forever, but a scan re-walks the vault; this is the same order of
 * magnitude as the panel's own 15 s poll, so the first read after new memory lands
 * refreshes it while idle polls do not scan at all. Exported for the refresh tests.
 */
export const PANEL_REFRESH_INTERVAL_MS = 5000

/**
 * The custom request header the panel's browser half sends on every POST.
 *
 * The desktop GUI proxy deletes `Origin`, so this header is the same-origin proof
 * for mutations (see `mutationRefusal`). lib/memory-panel.js is served standalone
 * and cannot import these, so it repeats the literals; a two-source test pins them.
 */
export const PANEL_HEADER = 'x-obsidian-mem-panel'
export const PANEL_HEADER_VALUE = '1'

/** The last refresh attempt per index handle; module scope because the route registers once. */
const lastPanelRefresh = new WeakMap()

/**
 * Register the panel's asset routes, its read-only POST actions and the two
 * confirmed-mutation actions.
 *
 * The read actions keep their existing same-origin contract. Mutations are fenced
 * more strictly — a JSON content type and a same-origin proof — because they are
 * the only requests that can write; the loopback check and the 4 KB body cap still
 * apply to both halves. The proof is a matching `Origin` when one survives the
 * desktop proxy, and the panel's own `x-obsidian-mem-panel` header when it does not.
 *
 * 概览 and 健康 also refresh the project index before answering, at most once per
 * {@link PANEL_REFRESH_INTERVAL_MS}, so a note written by another process shows up
 * without a DSH restart. 检索 reads the index as it stands and never refreshes.
 *
 * @param {object} ctx - host context carrying `webServer` and `sessions`.
 * @param {object} options - `services`, `resolveBinding`, `scopeOf`, `assets`
 *   (paths relative to this module; a test points them at a temp file), an
 *   optional `previewTokens` table (a test injects a clocked one), and an optional
 *   `now` clock the refresh throttle reads (a test advances it; default `Date.now`).
 * @returns {Function} a disposer that unregisters every route.
 */
export function registerPanelRoute(
  ctx,
  { services, resolveBinding, scopeOf, assets, previewTokens, now = Date.now } = {},
) {
  const files = assets ?? DEFAULT_ASSETS
  const disposeAssets = files.map((file) => {
    // A native absolute path (the shipped default is module-relative, but a test
    // injects a temp file) must go through `pathToFileURL`: on Windows `new URL`
    // reads the drive letter as a scheme and the read then fails.
    const url = isAbsolute(file) ? pathToFileURL(file) : new URL(file, import.meta.url)
    const name = file.split(/[\\/]/u).pop()
    return ctx.webServer.register({
      kind: 'exact',
      path: '/obsidian-mem/' + name,
      handler: (request, response) => {
        if (!trusted(request)) return reply(response, 403, { ok: false })
        if (request.method !== 'GET') return reply(response, 405, { ok: false })
        let source
        try {
          source = readFileSync(url, 'utf8')
        } catch {
          return reply(response, 500, {
            ok: false,
            error: { code: 'asset-unreadable', message: 'panel asset unavailable' },
          })
        }
        response.writeHead(200, {
          'content-type': 'text/javascript; charset=utf-8',
          'cache-control': 'no-cache',
          'x-content-type-options': 'nosniff',
        })
        response.end(source)
      },
    })
  })
  const disposePanel = ctx.webServer.register({
    kind: 'exact',
    path: '/obsidian-mem/panel',
    handler: async (request, response) => {
      if (!trusted(request)) {
        reply(response, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
        return
      }
      if (request.method !== 'POST') {
        reply(response, 405, { ok: false, error: { code: 'method', message: 'POST required' } })
        return
      }
      let payload
      try {
        payload = await payloadOf(request)
      } catch (error) {
        const bad = error instanceof SyntaxError || error instanceof RangeError
        reply(response, bad ? 400 : 503, {
          ok: false,
          error: {
            code: bad ? 'bad-request' : 'unavailable',
            message: bad ? error.message : 'memory panel unavailable',
          },
        })
        return
      }
      try {
        const action = payload.action ?? 'overview'
        if (PANEL_MUTATION_ACTIONS.includes(action)) {
          const refusal = mutationRefusal(request)
          if (refusal !== null) {
            reply(response, refusal.status, {
              ok: false,
              error: { code: refusal.code, message: refusal.message },
            })
            return
          }
          const value = await answerMutation(payload, action, {
            sessions: ctx.sessions,
            resolveBinding,
            services,
            tokens: previewTokens,
            today: localDate(),
          })
          reply(response, 200, { ok: true, value: fit(action, value) })
          return
        }
        const value = await answer(payload, action, {
          sessions: ctx.sessions,
          resolveBinding,
          services,
          scopeOf,
          now,
        })
        reply(response, 200, { ok: true, value: fit(action, value) })
      } catch (error) {
        const bad = error instanceof SyntaxError || error instanceof RangeError
        const code = typeof error?.code === 'string' ? error.code : null
        const unbound = code === 'unbound' || code === 'project-unbound'
        // A coded refusal from the mutation layer carries its own HTTP status;
        // everything uncoded keeps the read path's 400/409/503 mapping. 404 is
        // deliberately never produced here: the browser asset reads a 404 as "this
        // route is not registered" and shows the fatal restart notice, so an
        // unresolvable session (a resumed session racing the panel's first poll)
        // must be a retryable 503 that keeps its own `session-missing` code.
        const coded = typeof error?.status === 'number'
        const status = bad ? 400 : coded ? error.status : unbound ? 409 : 503
        reply(response, status, {
          ok: false,
          error: {
            code: bad ? 'bad-request' : unbound ? 'unbound' : (code ?? 'unavailable'),
            message: bad || coded || unbound ? error.message : 'memory panel unavailable',
          },
        })
      }
    },
  })
  return () => {
    disposePanel()
    for (const dispose of disposeAssets) dispose()
  }
}

/**
 * Resolve the session, its cwd binding and the tool context every action needs.
 *
 * @param {object} payload - the parsed request body.
 * @param {object} seams - `sessions` and `resolveBinding`.
 * @returns {Promise<{sessionId: string, binding: object|null, exec: object}>} the context.
 */
async function requestContext(payload, { sessions, resolveBinding }) {
  const sessionId = payload.sessionId
  if (typeof sessionId !== 'string' || sessionId === '' || sessionId.length > MAX_SESSION_ID)
    throw new RangeError('sessionId required')
  const session = sessions.get(sessionId)
  if (session === undefined || session === null) {
    const missing = new Error('session unavailable')
    missing.code = 'session-missing'
    throw missing
  }
  const cwd = session.header?.cwd
  if (typeof cwd !== 'string' || cwd === '')
    throw new RangeError('session has no working directory')
  return {
    sessionId,
    binding: await resolveBinding(cwd),
    exec: { agent: { session: { header: { id: sessionId, cwd } } } },
  }
}

/** Validate the request and build its read action's value; a malformed one throws. */
async function answer(payload, action, { sessions, resolveBinding, services, scopeOf, now }) {
  if (!PANEL_ACTIONS.includes(action)) throw new RangeError('unknown panel action')
  const { binding, exec } = await requestContext(payload, { sessions, resolveBinding })
  const bound = binding?.kind === 'bound'
  if (action === 'search') return searchValue(payload, { services, binding, bound, scopeOf })
  if (!bound) return unboundValue(binding?.reason ?? null)
  if (action === 'overview')
    return overviewValue({ binding, services, exec, days: activityDaysOf(payload), now })
  return healthValue({ binding, services, exec, now })
}

/**
 * Why a mutation request is refused before it can reach the service, or `null`.
 *
 * The old fence demanded an explicit `Origin` at all. That broke the desktop GUI:
 * its `dsh-app://` main-process proxy (`forwardWebRequest`) deletes `host`,
 * `origin`, `cookie` and `sec-fetch-site` before forwarding to loopback, so every
 * real mutation arrived with no Origin and 403'd while reads (which merely tolerate
 * a missing Origin) kept working. The fence is now: a JSON body, and a same-origin
 * proof that survives that proxy. When `Origin` is present, `trusted()` has already
 * compared it to the host; when it is absent, the request must carry the panel's
 * own `x-obsidian-mem-panel: 1` header. A cross-site page cannot add a custom header
 * — or send `application/json` — without a CORS preflight this route never answers,
 * so the header keeps the CSRF meaning the proxy's stripping would otherwise remove.
 *
 * @param {object} request - the HTTP request.
 * @returns {{status: number, code: string, message: string}|null} the refusal.
 */
function mutationRefusal(request) {
  const origin = request.headers.origin
  if (
    (typeof origin !== 'string' || origin === '') &&
    request.headers[PANEL_HEADER] !== PANEL_HEADER_VALUE
  )
    return { status: 403, code: 'forbidden', message: 'same-origin request required' }
  const contentType = request.headers['content-type']
  if (typeof contentType !== 'string' || !/^application\/json\s*(?:;|$)/iu.test(contentType.trim()))
    return { status: 400, code: 'bad-request', message: 'content-type application/json required' }
  return null
}

/**
 * Answer one preview or confirm request, re-resolving the binding each time.
 *
 * A confirm re-resolves rather than trusting the binding the preview saw: the
 * second request is a new decision by the same browser, and `confirmPanelAction`
 * refuses a token whose project no longer matches this resolution.
 *
 * @param {object} payload - the parsed request body.
 * @param {string} action - `preview` or `confirm`.
 * @param {object} seams - sessions, binding resolver, services, token table and today.
 * @returns {Promise<object>} the wire value under `ok: true`.
 */
async function answerMutation(
  payload,
  action,
  { sessions, resolveBinding, services, tokens, today },
) {
  const { sessionId, binding, exec } = await requestContext(payload, { sessions, resolveBinding })
  if (binding?.kind !== 'bound') {
    const unbound = new Error('a confirmed panel operation needs a bound project')
    unbound.code = 'unbound'
    throw unbound
  }
  if (action === 'preview') {
    if (!PANEL_MUTATIONS.includes(payload.mutation))
      throw new RangeError('mutation must be one of ' + PANEL_MUTATIONS.join(', '))
    const preview = await previewPanelAction({
      operation: payload.mutation,
      args: payload.args,
      sessionId,
      binding,
      services,
      exec,
      tokens,
      today,
    })
    return {
      mutation: preview.operation,
      token: preview.token,
      expiresAt: preview.expiresAt,
      preview: preview.preview,
    }
  }
  if (typeof payload.token !== 'string' || payload.token === '')
    throw new RangeError('token required')
  const confirmed = await confirmPanelAction({
    token: payload.token,
    sessionId,
    binding,
    services,
    exec,
    tokens,
    today,
  })
  return {
    mutation: confirmed.operation,
    result: confirmed.result,
    replayed: confirmed.replayed,
  }
}

/** The one unbound value every action returns, so the panel reads one shape. */
function unboundValue(reason) {
  return {
    project: { state: 'unbound', reason },
    counts: null,
    health: null,
    queue: { queued: 0, failed: 0, deferred: 0, failedJobs: [] },
    hot: null,
    capabilities: UNBOUND_CAPABILITIES,
    recent: [],
    digest: null,
  }
}

/**
 * The activity window a request asks for, clamped to 84..371 days.
 *
 * A malformed, absent or out-of-range value falls back to (or clamps into) the
 * band the charts and the 20 KB ceiling are designed for: twelve weeks is the
 * DESIGN window every older client gets, 53 whole weeks is the heat map's year.
 *
 * @param {object} payload - the parsed request body.
 * @returns {number} the window length in days.
 */
function activityDaysOf(payload) {
  const requested = payload?.days
  if (!Number.isInteger(requested)) return ACTIVITY_DAYS
  return Math.min(ACTIVITY_DAYS_MAX, Math.max(ACTIVITY_DAYS, requested))
}

/**
 * Refresh the project index before a live read, at most once per throttle window.
 *
 * A memory written by a DIFFERENT process (another DSH profile, the Codex adapter,
 * Obsidian itself) never reaches an already-open panel: the index only re-scans
 * after a write in this process, so the panel looks stale until DSH restarts. The
 * `refresh()` seam is the existing mtime/size incremental scan; running it on every
 * poll would re-walk the vault every few seconds, so it is throttled per handle.
 *
 * The timestamp is stamped BEFORE awaiting. A second poll that arrives while the
 * scan runs must see the window as used, or two panels would start two scans. A
 * failure is swallowed: the previous scan is still a valid answer and the index
 * reports `stale` itself, so a read must never fail because a refresh did.
 *
 * @param {object} index - the project index handle.
 * @param {Function} now - the clock seam `registerPanelRoute` was given.
 * @returns {Promise<void>} resolves once the refresh (if any) settled.
 */
async function refreshForRead(index, now) {
  try {
    if (typeof index?.refresh !== 'function') return
    // Do not stack a scan on one already running: `scanning` is the index's own
    // answer to "would this refresh be redundant work?".
    if (index.status?.()?.scanning === true) return
    const at = now()
    const last = lastPanelRefresh.get(index)
    if (last !== undefined && at - last < PANEL_REFRESH_INTERVAL_MS) return
    lastPanelRefresh.set(index, at)
    await index.refresh()
  } catch {
    // A refresh failure never fails the read; see the doc comment above.
  }
}

/**
 * 概览: identity, counts, health chips, recent notes, queue and hot cards, plus
 * the two aggregates the charts are drawn from.
 *
 * The chart data rides on this response rather than a fourth action because every
 * chart lives on 概览: a second round trip would only delay the first paint, and a
 * new action would widen the read vocabulary the route pins on purpose.
 *
 * @param {object} options - binding, services, exec and the requested `days` window.
 */
async function overviewValue({ binding, services, exec, days = ACTIVITY_DAYS, now = Date.now }) {
  const index = await services.indexForBinding(binding)
  await refreshForRead(index, now)
  const [counts, activity, tags, recent, queue, hot, digest] = await Promise.all([
    index.stats({ scope: 'project' }),
    readActivity(index, days),
    readTagFrequencies(index),
    readRecent(index),
    readQueue(services, exec, binding),
    readHot(services, exec),
    readDigest(services, exec),
  ])
  return {
    project: projectOf(binding),
    counts,
    activity,
    tags,
    health: indexCard(index.status()),
    queue,
    hot,
    capabilities: CAPABILITIES,
    recent,
    digest,
  }
}

/**
 * The daily activity series, or `null` when this index build cannot answer it.
 *
 * Feature-detected rather than assumed: the panel and the plugin are two halves
 * that can be upgraded at different times (a browser page served by an older
 * host, or a host serving a newer asset), and a missing aggregate must degrade
 * to "no chart" instead of failing the whole 概览 read.
 *
 * @param {object} index - the project index handle.
 * @param {number} days - the requested window length, already route-clamped.
 * @returns {Promise<object|null>} the series, or null.
 */
async function readActivity(index, days) {
  if (typeof index.activity !== 'function') return null
  try {
    return await index.activity({ scope: 'project', days })
  } catch {
    return null
  }
}

/**
 * The 最近变化 sample: newest rows spread across the newest four calendar days.
 *
 * A flat newest-8 page collapses to a single day when the vault is busy — live on
 * 2026-10-31 the overview's eight rows all shared that day while the digest
 * reported 45 notes created in the last day — and the panel draws GitHub-style day
 * groups, so the wire would show one group. The route scans a wide INTERNAL page
 * and keeps at most {@link RECENT_PER_DAY} rows for each of the newest
 * {@link RECENT_MAX_DAYS} distinct days. The wire array keeps its shape and its
 * eight-row bound, so the overview byte ceiling is untouched.
 *
 * @param {object} index - the project index handle.
 * @returns {Promise<object[]>} the selected rows, mtime-descending.
 */
async function readRecent(index) {
  return dayDiverseRecent(await index.recent({ limit: RECENT_SCAN_LIMIT }))
}

/**
 * Keep at most {@link RECENT_PER_DAY} rows for each of the newest
 * {@link RECENT_MAX_DAYS} `updated` days, preserving the input's mtime order.
 *
 * A day is the first ten characters of the row's `updated` value; nothing is
 * invented from the file time of a row that never set one. Rows without a usable
 * `updated` form a final unknown bucket: it never displaces a dated day from the
 * newest four and only takes the rows a full dated selection leaves over. Those
 * rows keep their original positions so the array is still readable as
 * mtime-descending; the client renders the bucket last.
 *
 * @param {unknown} rows - the index's recent page.
 * @returns {object[]} the selected rows, in input order.
 */
function dayDiverseRecent(rows) {
  if (!Array.isArray(rows)) return []
  const dayOf = (row) => {
    const updated = row?.updated
    if (typeof updated !== 'string' || !/^\d{4}-\d{2}-\d{2}/u.test(updated)) return null
    return updated.slice(0, 10)
  }
  const days = new Set()
  for (const row of rows) {
    const day = dayOf(row)
    if (day === null || days.has(day)) continue
    if (days.size >= RECENT_MAX_DAYS) break
    days.add(day)
  }
  const perDay = new Map()
  let dated = 0
  for (const row of rows) {
    const day = dayOf(row)
    if (day === null || !days.has(day)) continue
    const count = perDay.get(day) ?? 0
    if (count >= RECENT_PER_DAY) continue
    perDay.set(day, count + 1)
    dated += 1
    if (dated >= RECENT_LIMIT) break
  }
  const unknownBudget = Math.min(RECENT_PER_DAY, RECENT_LIMIT - dated)
  const taken = new Map()
  const picked = []
  let unknowns = 0
  for (const row of rows) {
    const day = dayOf(row)
    if (day === null) {
      if (unknowns >= unknownBudget) continue
      unknowns += 1
      picked.push(row)
      continue
    }
    const target = perDay.get(day)
    if (target === undefined) continue
    const count = taken.get(day) ?? 0
    if (count >= target) continue
    taken.set(day, count + 1)
    picked.push(row)
  }
  return picked
}

/**
 * The tag ranking, or `null` when this index build cannot answer it.
 *
 * @param {object} index - the project index handle.
 * @returns {Promise<{items: Array<{tag: string, n: number}>, total: number}|null>} the ranking, or null.
 */
async function readTagFrequencies(index) {
  if (typeof index.tagFrequencies !== 'function') return null
  try {
    return await index.tagFrequencies({ scope: 'project', limit: TAG_LIMIT })
  } catch {
    return null
  }
}

/** 健康: the same cards plus the diagnostics ring, without the notes lists. */
async function healthValue({ binding, services, exec, now = Date.now }) {
  const index = await services.indexForBinding(binding)
  await refreshForRead(index, now)
  const [queue, hot, digest, diagnostics] = await Promise.all([
    readQueue(services, exec, binding),
    readHot(services, exec),
    readDigest(services, exec),
    readDiagnostics(services, exec),
  ])
  return {
    // The identity rides on 健康 too, not only on 概览: the shell's header reads
    // the project from whichever view reported last, so omitting it here relabeled
    // the header "项目记忆" the moment the user opened this tab. One identity shape
    // for both actions, not one per view.
    project: projectOf(binding),
    index: indexCard(index.status()),
    queue,
    hot,
    capabilities: CAPABILITIES,
    diagnostics,
    digest,
  }
}

/**
 * 检索: a bounded FTS search whose "还有更多" comes from the index's own facts.
 *
 * An unbound project may still search `all`; that is the one useful read before
 * a project is bound, and it is why the unbound empty state is not a dead end.
 */
async function searchValue(payload, { services, binding, bound, scopeOf }) {
  const query = typeof payload.query === 'string' ? payload.query.trim() : ''
  if (query === '') throw new RangeError('query must be a non-blank string')
  const scope = payload.scope ?? 'project'
  if (!['project', 'global', 'all'].includes(scope)) throw new RangeError('invalid search scope')
  if (!bound && scope !== 'all') {
    const refused = new Error('the project is not bound; scope "all" still works')
    refused.code = 'unbound'
    throw refused
  }
  const field = (value) =>
    typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, MAX_FIELD_CHARS) : null
  const type = field(payload.type)
  const status = field(payload.status)
  const limit = payload.limit === undefined ? DEFAULT_SEARCH_LIMIT : payload.limit
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SEARCH_LIMIT)
    throw new RangeError(`limit must be an integer between 1 and ${MAX_SEARCH_LIMIT}`)
  // The panel reads the INDEX, not `services.search`: the latter projects hits to
  // the tool's plain views (the mem_search output must stay lossless JSON), which
  // would drop the non-enumerable search facts this route needs for a truthful
  // `hasMore`. `scopeOf` is `resolveScope` injected by the assembly, so the scope
  // policy still lives in exactly one module.
  const index = await services.indexForBinding(bound ? binding : null)
  const filters = scopeOf({
    scope,
    projectId: null,
    boundProjectId: index.boundProjectId ?? null,
    type,
    status,
    includeHistory: false,
  })
  const started = Date.now()
  const hits = await index.search({ query, filters, limit })
  const tookMs = Date.now() - started
  const scored = Number.isFinite(hits.candidatesScored) ? hits.candidatesScored : hits.length
  const views = hits.map(hitView)
  const filtered = status === null ? views : views.filter((hit) => hit.status === status)
  const visible = filtered.slice(0, limit)
  // `hasMore` must be a promise the 显示更多 button can keep. Without a status
  // filter the index page IS the answer, so `candidatesScored` beyond it is a
  // truthful "more". With a status filter the page was fetched at the largest
  // size and filtered here, so `candidatesScored` counts rows that may all fail
  // the filter — claiming "more" from it would re-request the same page and
  // yield nothing. In that case only rows the filter kept beyond the visible
  // window prove there is more to show.
  const hasMore =
    status === null
      ? scored > hits.length || filtered.length > visible.length
      : filtered.length > visible.length
  return {
    query,
    scope,
    type,
    status,
    limit,
    hits: visible,
    hasMore,
    tookMs,
  }
}

/** One result row, clipped so a pathological note cannot own the payload. */
function hitView(hit) {
  return {
    path: String(hit.path ?? ''),
    title: String(hit.title ?? ''),
    type: String(hit.type ?? ''),
    status: String(hit.status ?? ''),
    source: String(hit.source ?? ''),
    snippet: String(hit.snippet ?? '').slice(0, MAX_SNIPPET_CHARS),
    scoreSignals: Array.isArray(hit.scoreSignals) ? hit.scoreSignals.slice(0, 8) : [],
  }
}

/**
 * Identity for the project strip, with the home prefix masked to `~`.
 *
 * The display string is normalized to POSIX separators before it leaves the
 * route: it is rendered in the browser, and a Windows-native `\\` path there
 * reads as an escaped sequence rather than a path. `basename` still runs on the
 * native root, so the last segment is correct on every platform.
 */
function projectOf(binding) {
  const root = typeof binding.vaultRoot === 'string' ? binding.vaultRoot : ''
  const home = homedir()
  const masked = root.startsWith(home) ? '~' + root.slice(home.length) : root
  const display = masked.replaceAll('\\', '/')
  return {
    state: 'bound',
    name: binding.displayName ?? binding.slug ?? null,
    projectId: binding.projectId,
    vault: { display, basename: root === '' ? '' : basename(root) },
    reason: null,
  }
}

/** The index card both views share; one shape, one meaning per field. */
function indexCard(status) {
  const state =
    status.closed === true
      ? 'closed'
      : status.ready !== true
        ? 'starting'
        : status.degraded === true
          ? 'degraded'
          : 'ready'
  return {
    state,
    backend: status.backend ?? null,
    fts: status.fts === true,
    stale: status.stale === true,
    scanning: status.scanning === true,
    notes: Number.isFinite(status.notes) ? status.notes : 0,
    lastScan: status.lastScan ?? null,
    quarantined: Array.isArray(status.quarantined) ? status.quarantined.length : 0,
    skipped: status.skipped ?? {},
    reason: status.reason ?? null,
  }
}

/**
 * The queue card. `jobs` needs no vault, so any session can read it.
 *
 * The card also carries at most {@link MAX_FAILED_JOBS} terminally failed jobs of
 * the DISPLAYED project: the retry sheet targets one of them by id, and the route
 * must not require a second endpoint the UI cannot reach. The ids are the same job
 * views `mem_admin(action="jobs")` already exposes; nothing from `safeInput` or a
 * model message is copied.
 */
async function readQueue(services, exec, binding) {
  const value = await services.admin({ action: 'jobs' }, undefined, exec)
  const result = value?.result ?? {}
  const jobs = Array.isArray(result.jobs) ? result.jobs : []
  const deferred = jobs.filter((job) => job.state === 'deferred').length
  const failed = Number.isFinite(result.failed)
    ? result.failed
    : jobs.filter((job) => job.state === 'failed').length
  const queued = jobs.length - deferred - failed
  const failedJobs = jobs
    .filter((job) => job.state === 'failed' && job.projectId === binding.projectId)
    .sort(
      (left, right) =>
        String(right.failedAt ?? '').localeCompare(String(left.failedAt ?? '')) ||
        String(left.jobId ?? '').localeCompare(String(right.jobId ?? '')),
    )
    .slice(0, MAX_FAILED_JOBS)
    .map((job) => ({
      jobId: job.jobId,
      state: job.state,
      attempts: Number.isFinite(job.attempts) ? job.attempts : 0,
    }))
  return { queued, failed, deferred, failedJobs }
}

/** The hot-zone card, from the same status read `mem_admin(action="hot")` uses. */
async function readHot(services, exec) {
  const value = await services.admin({ action: 'hot', operation: 'status' }, undefined, exec)
  const result = value?.result
  if (result === undefined || result === null) return null
  const count = (key) => (Number.isFinite(result[key]) ? result[key] : 0)
  return {
    missing: result.missing === true,
    used: count('used'),
    capacity: count('capacity'),
    trigger: count('trigger'),
    ratio: count('ratio'),
    archivable: count('archivable'),
    compactable: count('compactable'),
    sections: Array.isArray(result.sections) ? result.sections : [],
  }
}

/** The diagnostics card: the ring's window plus its most recent events. */
async function readDiagnostics(services, exec) {
  const value = await services.admin({ action: 'diagnostics' }, undefined, exec)
  const result = value?.result
  if (result === undefined || result === null) return null
  const events = Array.isArray(result.events) ? result.events.slice(-MAX_DIAGNOSTIC_EVENTS) : []
  return { window: result.window ?? null, events }
}

/**
 * The digest card, feature-detected.
 *
 * `services.admin` falls through to the queue for an action it does not know, so
 * the answer is accepted only when it names itself a digest — otherwise the
 * panel gets `null` instead of a queue disguised as an appraisal.
 */
async function readDigest(services, exec) {
  try {
    const value = await services.admin({ action: 'digest', days: 1 }, undefined, exec)
    return value?.action === 'digest' ? (value.result ?? null) : null
  } catch {
    return null
  }
}

/** The UTF-8 byte length of one value as the client will receive it. */
function byteLength(value) {
  return Buffer.byteLength(JSON.stringify({ ok: true, value }), 'utf8')
}

/**
 * Keep one answer inside its byte ceiling by halving its largest list.
 *
 * A ceiling is a promise about the wire, so it is enforced by measurement. The
 * search view sets `hasMore` when rows are dropped; every other view simply
 * shows fewer items.
 *
 * The guard is 64, not 8: `shrink()` follows an *eight-stage* order (design §3.6)
 * and each stage halves one list until it is empty, so a 500-entry distribution
 * needs about nine steps on its own and the stages behind it would never get
 * their turn under a smaller guard — the trim order would silently be "halve
 * `byType` eight times, then give up". 64 covers every stage reaching zero from
 * any realistic row count (7 × log2 500 < 63) and still terminates: every step
 * strictly shortens one list (`flow` is dropped whole in one step), and
 * `shrink()` answers `null` once none is left.
 */
function fit(action, value) {
  const ceiling = CEILINGS[action] ?? CEILINGS.search
  let current = value
  for (let guard = 64; guard > 0 && byteLength(current) > ceiling; guard -= 1) {
    const next = shrink(action, current)
    if (next === null) break
    current = next
  }
  // A ceiling is a hard promise. If every optional list is already empty and the
  // payload still exceeds it (a pathological index count or a very long vault
  // path), keep the required shape but drop the remaining list payloads rather
  // than returning a response the client cannot rely on.
  if (byteLength(current) > ceiling) {
    if (action === 'overview') {
      current = {
        ...current,
        counts:
          current.counts === null
            ? null
            : { ...current.counts, byType: [], byStatus: [], flow: [] },
        // The charts are optional decoration; the counts above them are the
        // required shape. Dropping them keeps 概览 answerable at any size.
        activity: null,
        tags: null,
        hot: current.hot === null ? null : { ...current.hot, sections: [] },
        recent: [],
        digest: null,
      }
    }
    if (action === 'health') {
      current = {
        ...current,
        index: current.index === null ? null : { ...current.index, skipped: {} },
        hot: current.hot === null ? null : { ...current.hot, sections: [] },
        diagnostics: current.diagnostics === null ? null : { ...current.diagnostics, events: [] },
      }
    }
  }
  if (byteLength(current) > ceiling) {
    const error = new Error('panel response exceeds its byte ceiling after trimming')
    error.code = 'response-too-large'
    throw error
  }
  return current
}

/** One trimming step, or null when nothing is left to drop. */
function shrink(action, value) {
  const half = (list) => list.slice(0, Math.floor(list.length / 2))
  if (action === 'overview') {
    // Trim in the order the 概览 view can afford to lose things (design §3.6): first the
    // window BEYOND the designed twelve weeks (a 53-week calendar becomes the twelve the
    // panel shipped with, not the four-week last resort below), then the tag page, the
    // joint flow, the distributions, the activity window itself and the text lists. The
    // scalar counts and the KPI band are the required shape and are never trimmed here.
    const designed = activityWindowTo(value.activity, ACTIVITY_DAYS)
    if (designed !== null) return { ...value, activity: designed }
    if (value.tags?.items?.length > 0)
      return { ...value, tags: { ...value.tags, items: half(value.tags.items) } }
    // The flow is ALL-OR-NOTHING: a partial flow would draw a Sankey whose link
    // sum disagrees with the printed totals, so the whole array drops in one step
    // and the view falls back to the stacked bar. It goes before either
    // distribution pays, because the two margins are what the bar needs.
    if (value.counts?.flow?.length > 0) return { ...value, counts: { ...value.counts, flow: [] } }
    if (value.counts?.byType?.length > 0)
      return { ...value, counts: { ...value.counts, byType: half(value.counts.byType) } }
    if (value.counts?.byStatus?.length > 0)
      return { ...value, counts: { ...value.counts, byStatus: half(value.counts.byStatus) } }
    const shorter = trimmedActivity(value.activity)
    if (shorter !== null) return { ...value, activity: shorter }
    if (value.hot?.sections?.length > 0)
      return { ...value, hot: { ...value.hot, sections: half(value.hot.sections) } }
    if (value.recent.length > 0) return { ...value, recent: half(value.recent) }
    // The digest card is the last optional payload: it repeats facts the counts
    // and the chart already show, so dropping it is cheaper than dropping a row.
    if (value.digest !== null && value.digest !== undefined) return { ...value, digest: null }
  }
  if (action === 'search' && value.hits.length > 0)
    return { ...value, hits: half(value.hits), hasMore: true }
  const events = value.diagnostics?.events
  if (action === 'health' && Array.isArray(events) && events.length > 0)
    return { ...value, diagnostics: { ...value.diagnostics, events: half(events) } }
  if (action === 'health' && value.hot?.sections?.length > 0)
    return { ...value, hot: { ...value.hot, sections: half(value.hot.sections) } }
  return null
}

/**
 * One activity series cut to at most `days` days, or null when it is already that short.
 *
 * Both series and the day list are cut from the head together: the window is a
 * calendar, so a series that lost days without losing their labels would put
 * every count on the wrong date. `from` moves with them.
 *
 * @param {object|null} activity - the current series, or null.
 * @param {number} days - the longest window to keep.
 * @returns {object|null} the shorter series, or null when nothing can be cut.
 */
function activityWindowTo(activity, days) {
  if (activity === null || activity === undefined) return null
  const list = Array.isArray(activity.days) ? activity.days : []
  if (list.length <= days) return null
  const drop = list.length - days
  return {
    ...activity,
    from: list[drop],
    days: list.slice(drop),
    created: Array.isArray(activity.created) ? activity.created.slice(drop) : [],
    updated: Array.isArray(activity.updated) ? activity.updated.slice(drop) : [],
  }
}

/**
 * The last-resort window when even the designed one does not fit: four weeks.
 *
 * @param {object|null} activity - the current series, or null.
 * @returns {object|null} a four-week series, or null when nothing can be cut.
 */
function trimmedActivity(activity) {
  return activityWindowTo(activity, ACTIVITY_TRIM_DAYS)
}
