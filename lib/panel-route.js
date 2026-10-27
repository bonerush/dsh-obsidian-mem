import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename } from 'node:path'

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

/** Response ceilings in bytes of UTF-8 JSON (spec §6). */
const CEILINGS = Object.freeze({
  overview: 16 * 1024,
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
const RECENT_LIMIT = 8
const MAX_DIAGNOSTIC_EVENTS = 20

/**
 * Register the panel's asset routes, its read-only POST actions and the two
 * confirmed-mutation actions.
 *
 * The read actions keep their existing same-origin contract. Mutations are fenced
 * more strictly — an explicit `Origin` and a JSON content type — because they are
 * the only requests that can write; the loopback check and the 4 KB body cap
 * still apply to both halves.
 *
 * @param {object} ctx - host context carrying `webServer` and `sessions`.
 * @param {object} options - `services`, `resolveBinding`, `scopeOf`, `assets`
 *   (paths relative to this module; a test points them at a temp file) and an
 *   optional `previewTokens` table (a test injects a clocked one).
 * @returns {Function} a disposer that unregisters every route.
 */
export function registerPanelRoute(
  ctx,
  { services, resolveBinding, scopeOf, assets, previewTokens } = {},
) {
  const files = assets ?? DEFAULT_ASSETS
  const disposeAssets = files.map((file) => {
    const url = new URL(file, import.meta.url)
    const name = file.split('/').pop()
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
        })
        reply(response, 200, { ok: true, value: fit(action, value) })
      } catch (error) {
        const bad = error instanceof SyntaxError || error instanceof RangeError
        const code = typeof error?.code === 'string' ? error.code : null
        const unbound = code === 'unbound' || code === 'project-unbound'
        // A coded refusal from the mutation layer carries its own HTTP status;
        // everything uncoded keeps the read path's 400/404/409/503 mapping.
        const coded = typeof error?.status === 'number'
        const status = bad
          ? 400
          : coded
            ? error.status
            : code === 'session-missing'
              ? 404
              : unbound
                ? 409
                : 503
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
async function answer(payload, action, { sessions, resolveBinding, services, scopeOf }) {
  if (!PANEL_ACTIONS.includes(action)) throw new RangeError('unknown panel action')
  const { binding, exec } = await requestContext(payload, { sessions, resolveBinding })
  const bound = binding?.kind === 'bound'
  if (action === 'search') return searchValue(payload, { services, binding, bound, scopeOf })
  if (!bound) return unboundValue(binding?.reason ?? null)
  if (action === 'overview') return overviewValue({ binding, services, exec })
  return healthValue({ binding, services, exec })
}

/**
 * Why a mutation request is refused before it can reach the service, or `null`.
 *
 * `trusted()` already requires loopback and, when an Origin is present, the same
 * host. A mutation additionally has to carry that Origin at all — "absent means
 * local" is not good enough for the only requests that write — and a JSON body.
 *
 * @param {object} request - the HTTP request.
 * @returns {{status: number, code: string, message: string}|null} the refusal.
 */
function mutationRefusal(request) {
  if (typeof request.headers.origin !== 'string' || request.headers.origin === '') {
    return { status: 403, code: 'forbidden', message: 'same-origin request required' }
  }
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

/** 概览: identity, counts, health chips, recent notes, queue and hot cards. */
async function overviewValue({ binding, services, exec }) {
  const index = await services.indexForBinding(binding)
  const [counts, recent, queue, hot, digest] = await Promise.all([
    index.stats({ scope: 'project' }),
    index.recent({ limit: RECENT_LIMIT }),
    readQueue(services, exec, binding),
    readHot(services, exec),
    readDigest(services, exec),
  ])
  return {
    project: projectOf(binding),
    counts,
    health: indexCard(index.status()),
    queue,
    hot,
    capabilities: CAPABILITIES,
    recent,
    digest,
  }
}

/** 健康: the same cards plus the diagnostics ring, without the notes lists. */
async function healthValue({ binding, services, exec }) {
  const index = await services.indexForBinding(binding)
  const [queue, hot, digest, diagnostics] = await Promise.all([
    readQueue(services, exec, binding),
    readHot(services, exec),
    readDigest(services, exec),
    readDiagnostics(services, exec),
  ])
  return {
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
  return {
    query,
    scope,
    type,
    status,
    limit,
    hits: visible,
    hasMore: hits.truncated === true || scored > hits.length || filtered.length > visible.length,
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

/** Identity for the project strip, with the home prefix masked to `~`. */
function projectOf(binding) {
  const root = typeof binding.vaultRoot === 'string' ? binding.vaultRoot : ''
  const home = homedir()
  const display = root.startsWith(home) ? '~' + root.slice(home.length) : root
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
 */
function fit(action, value) {
  const ceiling = CEILINGS[action] ?? CEILINGS.search
  let current = value
  for (let guard = 8; guard > 0 && byteLength(current) > ceiling; guard -= 1) {
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
        counts: current.counts === null ? null : { ...current.counts, byType: [], byStatus: [] },
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
    // The 概览 payload is mostly lists; trim the largest first and keep the
    // required shape. The recent list is last because it is the smallest.
    if (value.counts?.byType?.length > 0)
      return { ...value, counts: { ...value.counts, byType: half(value.counts.byType) } }
    if (value.counts?.byStatus?.length > 0)
      return { ...value, counts: { ...value.counts, byStatus: half(value.counts.byStatus) } }
    if (value.hot?.sections?.length > 0)
      return { ...value, hot: { ...value.hot, sections: half(value.hot.sections) } }
    if (value.recent.length > 0) return { ...value, recent: half(value.recent) }
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
