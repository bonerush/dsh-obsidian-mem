import { readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'

import { payloadOf, reply, trusted } from './route-guard.js'

// The same-origin fence, the 4 KB body reader and the JSON envelope are shared
// with the panel route (`lib/panel-route.js`); a second copy of the fence would
// be a second place for the rule to drift.

/**
 * Register the read-only graph and per-session activity endpoint on the DSH web server.
 *
 * The browser modules and Worker are read on every request rather than captured at
 * registration: registering happens once per plugin load, so a cached buffer
 * would keep serving the previous build after `lib/` changed — the browser would
 * silently run stale code until the host restarted. The files are a few KB and
 * the route already answers `no-cache`.
 *
 * @param {object} ctx - host context carrying `webServer` and `sessions`.
 * @param {object} options - routes inputs.
 * @param {object} options.activity - the in-process call-activity ring.
 * @param {Function} options.resolveBinding - `(cwd) → binding|refusal`.
 * @param {object} options.services - the memory services (project index lookup).
 * @param {string[]} [options.assets] - asset paths relative to this module; a test
 *   points them at a temporary file to prove the read happens per request.
 * @returns {Function} a disposer that unregisters every route.
 */
export function registerGraphRoute(ctx, { activity, resolveBinding, services, assets } = {}) {
  const files = assets ?? [
    './graph-worker.js',
    './graph-renderer.js',
    './graph-palette.js',
    './graph-recall.js',
    './graph-settings.js',
  ]
  const disposeAssets = files.map((file) => {
    // A native absolute path (the shipped default is module-relative, but a test
    // injects a temp file) must go through `pathToFileURL`: on Windows `new URL`
    // reads the drive letter as a scheme and the read then fails.
    const url = isAbsolute(file) ? pathToFileURL(file) : new URL(file, import.meta.url)
    // An injected asset path may be native (Windows backslash) or URL-shaped;
    // split on both separators so the route name is the basename either way.
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
            error: { code: 'asset-unreadable', message: 'graph asset unavailable' },
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
  const disposeGraph = ctx.webServer.register({
    kind: 'exact',
    path: '/obsidian-mem/graph',
    handler: async (request, response) => {
      if (!trusted(request)) {
        reply(response, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
        return
      }
      if (request.method !== 'POST') {
        reply(response, 405, { ok: false, error: { code: 'method', message: 'POST required' } })
        return
      }
      try {
        const payload = await payloadOf(request)
        const sessionId = payload.sessionId
        if (typeof sessionId !== 'string' || sessionId.length > 180 || sessionId === '')
          throw new RangeError('sessionId required')
        const session = ctx.sessions.get(sessionId)
        if (session === undefined || session === null) {
          reply(response, 404, {
            ok: false,
            error: { code: 'session-missing', message: 'session unavailable' },
          })
          return
        }
        if (payload.action === 'activity') {
          const cursor =
            Number.isSafeInteger(payload.cursor) && payload.cursor >= 0 ? payload.cursor : 0
          reply(response, 200, { ok: true, value: activity.since(sessionId, cursor) })
          return
        }
        if (payload.action !== undefined && payload.action !== 'snapshot')
          throw new RangeError('unknown graph action')
        const scope = payload.scope ?? 'project'
        if (scope !== 'project' && scope !== 'all') throw new RangeError('invalid graph scope')
        const cwd = session.header?.cwd
        if (typeof cwd !== 'string' || cwd === '')
          throw new RangeError('session has no working directory')
        const binding = await resolveBinding(cwd)
        if (scope === 'project' && binding?.kind !== 'bound') {
          reply(response, 200, {
            ok: true,
            value: {
              nodes: [],
              edges: [],
              truncated: false,
              total: 0,
              unbound: true,
              // The panel explains *why* there is no graph; the vocabulary is
              // `lib/init-hint.js`'s refusal reasons.
              reason: binding?.reason ?? null,
            },
          })
          return
        }
        const index = await services.indexForBinding(binding?.kind === 'bound' ? binding : null)
        const graph = await index.graph({ scope, limit: 500 })
        reply(response, 200, { ok: true, value: graph })
      } catch (error) {
        const badInput = error instanceof SyntaxError || error instanceof RangeError
        reply(response, badInput ? 400 : 503, {
          ok: false,
          error: {
            code: badInput
              ? 'bad-request'
              : typeof error?.code === 'string'
                ? error.code
                : 'unavailable',
            message: badInput ? error.message : 'memory graph unavailable',
          },
        })
      }
    },
  })
  return () => {
    disposeGraph()
    for (const dispose of disposeAssets) dispose()
  }
}
