// @ts-check
// The semantic overlay: trace geometry, the painter, the card model and the
// controller. This file is served as-is to the browser
// (`/obsidian-mem/graph-semantic.js`), so it imports nothing from `lib/`: the
// client's locale helpers are inlined the same way `lib/client.js` and
// `lib/graph-renderer.js` do it.

export const RECALL_POLL_MS = 1500
export const DENSE_LINE_MAX = 12
export const OVERLAY_DURATION_MS = 900

export const CARD_COPY = Object.freeze({
  zh: {
    title: '本轮召回解释',
    idle: '等待下一次记忆调用',
    hybrid: '语义 + 词法融合',
    guard: '词法守卫命中，本轮未走向量',
    warming: '语义索引预热中',
    providerDisabled: '未启用 embedding provider',
    providerError: 'embedding 服务暂不可用，已回退词法',
    mapUnavailable: '语义地图暂不可用',
    replay: '复现',
    replaying: '复现中…',
    privacy: '仅本机内存，进程退出即清除',
    lexical: '词法命中',
    denseOnly: '仅语义新增',
    promoted: '融合提升',
    retired: '被挤出',
  },
  en: {
    title: 'This recall, explained',
    idle: 'Waiting for the next memory call',
    hybrid: 'Semantic + lexical fusion',
    guard: 'Lexical guard held; the vector branch did not run',
    warming: 'Semantic index is warming',
    providerDisabled: 'No embedding provider is enabled',
    providerError: 'Embedding service unavailable; fell back to lexical',
    mapUnavailable: 'Semantic map unavailable',
    replay: 'Replay',
    replaying: 'Replaying…',
    privacy: 'Memory only; cleared when the process exits',
    lexical: 'lexical hits',
    denseOnly: 'dense-only',
    promoted: 'promoted',
    retired: 'displaced',
  },
})

export const LAYOUT_COPY = Object.freeze({
  zh: { link: '链接', semantic: '语义' },
  en: { link: 'Links', semantic: 'Semantic' },
})

export const NEIGHBORS_COPY = Object.freeze({
  zh: { title: '语义近邻', linked: '已链接', unlinked: '未链接' },
  en: { title: 'Semantic neighbors', linked: 'Linked', unlinked: 'Not linked' },
})

export const RECALL_COPY = Object.freeze({
  zh: { pill: '新召回 · 查看解释' },
  en: { pill: 'New recall · explain' },
})

const pickLocale = (locale) => (locale === 'en' ? 'en' : 'zh')

const identity = (value) => {
  const text = typeof value === 'string' ? value : String(value ?? '')
  return text === '' ? null : text
}

/**
 * Turn the route's quantized `[[path, x, y], ...]` wire points (0..4095) into
 * world points (0..1000). Bad entries are skipped rather than thrown away whole.
 *
 * @param {{ points?: unknown[] } | null} map - the `semantic` action payload.
 * @returns {Map<string, {x: number, y: number}>}
 */
export function decodeMapPoints(map) {
  const points = new Map()
  if (!map || !Array.isArray(map.points)) return points
  for (const entry of map.points) {
    if (!Array.isArray(entry) || entry.length < 3) continue
    const path = identity(entry[0])
    if (path === null) continue
    const x = Number(entry[1])
    const y = Number(entry[2])
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    // 0..4095 is the wire quantization; the renderer works in world units where
    // the whole square is 1000 wide, comfortably larger than the node radius.
    points.set(path, { x: (x / 4095) * 1000, y: (y / 4095) * 1000 })
  }
  return points
}

/**
 * Classify the traces the route hands back. `positionOf` resolves a note path to
 * its world position when the map has one; the query line always goes through it.
 *
 * @param {object | null} trace - one `traceView`.
 * @param {(path: string) => {x: number, y: number} | null} positionOf
 * @returns {{query: {x: number, y: number} | null, lexical: Set<string>, dense: Map<string, number>, fused: Map<string, number>, lines: {path: string, score: number}[]} | null}
 */
export function createOverlayModel(trace, positionOf) {
  if (trace === null || typeof trace !== 'object' || typeof positionOf !== 'function') return null
  const query =
    trace.query && Number.isFinite(trace.query.x) && Number.isFinite(trace.query.y)
      ? { x: trace.query.x, y: trace.query.y }
      : null
  const fused = Array.isArray(trace.fused) ? trace.fused : []
  const lexical = new Set()
  const dense = new Map()
  const fusedRank = new Map()
  for (const entry of fused) {
    const path = identity(entry?.path)
    if (path === null) continue
    if (entry.lexicalHit === true) lexical.add(path)
    if (Number.isSafeInteger(entry.hybridRank)) fusedRank.set(path, entry.hybridRank)
    if (Number.isSafeInteger(entry.denseRank) && Number.isFinite(entry.semanticScore))
      dense.set(path, entry.semanticScore)
  }
  const lines = (Array.isArray(trace.dense) ? trace.dense : [])
    .filter(
      (entry) =>
        identity(entry?.path) !== null && Number.isFinite(entry.score) && !lexical.has(entry.path),
    )
    .sort((left, right) => right.score - left.score)
    .slice(0, DENSE_LINE_MAX)
    .map((entry) => ({ path: entry.path, score: entry.score }))
  return { query, lexical, dense, fused: fusedRank, lines }
}

/**
 * Build the canvas overlay for the latest trace. It only paints what the frame
 * actually carries: a dense line whose node is filtered out of the view is not
 * invented from the map, because the map can legitimately not contain it.
 *
 * @param {() => {model: object | null, started: number}} getState
 * @returns {(frame: object) => void}
 */
export function createSemanticPainter(getState) {
  return function paint(frame) {
    const state = getState()
    const model = state?.model ?? null
    if (model === null || model === undefined) return
    const { context, palette, now, reduced } = frame
    const fade = reduced
      ? 1
      : Math.max(0, Math.min(1, (now - (state.started ?? 0)) / OVERLAY_DURATION_MS))
    const alpha = (slot) => (Number.isFinite(slot?.a) ? slot.a : 1) * fade
    const color = (slot) => (typeof slot?.css === 'string' ? slot.css : 'currentColor')
    const idByPath = new Map()
    for (const [id, node] of frame.lookup) idByPath.set(node.path, id)
    // Dense lines first: the query point and the hit rings must sit on top.
    if (model.query !== null) {
      const query = frame.toScreen(model.query)
      for (const line of model.lines) {
        const destination = frame.points.get(idByPath.get(line.path))
        if (!destination) continue
        context.globalAlpha = alpha(palette.lineHighlight) * 0.5
        context.strokeStyle = color(palette.lineHighlight)
        context.lineWidth = 1
        context.beginPath()
        context.moveTo(query.x, query.y)
        context.lineTo(destination.x, destination.y)
        context.stroke()
      }
    }
    for (const [id, point] of frame.points) {
      const path = frame.lookup.get(id)?.path ?? null
      const isLexical = path !== null && model.lexical.has(path)
      const isDense = path !== null && model.dense.has(path)
      const rank = path !== null ? model.fused.get(path) : undefined
      if (isLexical) {
        context.globalAlpha = alpha(palette.fillHighlight)
        context.strokeStyle = color(palette.fillHighlight)
        context.lineWidth = 1.5
        const size = point.r + 4
        context.strokeRect(point.x - size, point.y - size, size * 2, size * 2)
      }
      if (isDense && !isLexical) {
        context.globalAlpha = alpha(palette.fillHighlight) * 0.7
        context.strokeStyle = color(palette.fillHighlight)
        context.lineWidth = 1
        context.setLineDash?.([3, 3])
        context.beginPath()
        context.arc(point.x, point.y, point.r + 5, 0, Math.PI * 2)
        context.stroke()
        context.setLineDash?.([])
      }
      if (Number.isSafeInteger(rank) && rank <= 3) {
        context.globalAlpha = fade
        context.fillStyle = color(palette.text)
        context.font = '10px sans-serif'
        context.fillText(String(rank), point.x + point.r + 3, point.y - point.r - 2)
      }
    }
    if (model.query !== null) {
      const query = frame.toScreen(model.query)
      context.globalAlpha = fade
      context.strokeStyle = color(palette.fillHighlight)
      context.lineWidth = 1.5
      for (const radius of [9, 13]) {
        context.beginPath()
        context.arc(query.x, query.y, radius, 0, Math.PI * 2)
        context.stroke()
      }
    }
    context.globalAlpha = 1
  }
}

const STATUS_KEYS = Object.freeze({
  hybrid: 'hybrid',
  idle: 'idle',
  guard: 'guard',
  warming: 'warming',
  'provider-disabled': 'providerDisabled',
  'provider-error': 'providerError',
  'map-unavailable': 'mapUnavailable',
  'route-error': 'mapUnavailable',
})

/**
 * Turn the controller's latest state into the small frozen-shaped object the card
 * renders. Pure: no DOM, no clock read.
 *
 * @param {{locale?: string, semantic?: object | null, trace?: object | null, error?: string}} input
 * @returns {{state: string, tone: string, title: string, status: string, counts: {lexical: number, denseOnly: number, promoted: number}, dense: object[], query: string, privacy: string, labels: {lexical: string, denseOnly: string, promoted: string, replay: string}}}
 */
export function cardView({ locale = 'zh', semantic = null, trace = null, error = '' } = {}) {
  const copy = CARD_COPY[pickLocale(locale)]
  let state
  if (error !== '') state = 'route-error'
  else if (semantic?.state === 'unavailable')
    state = semantic.reason === 'provider-disabled' ? 'provider-disabled' : 'map-unavailable'
  else if (semantic?.state === 'warming') state = 'warming'
  else if (trace === null || trace === undefined) state = 'idle'
  else if (trace.guard === true) state = 'guard'
  else if (trace.fallback === 'provider-error') state = 'provider-error'
  else if (trace.fallback === 'provider-disabled') state = 'provider-disabled'
  else state = 'hybrid'
  const fused = Array.isArray(trace?.fused) ? trace.fused : []
  const counts = {
    lexical: fused.filter((entry) => entry.lexicalHit === true).length,
    denseOnly: fused.filter((entry) => entry.lexicalHit !== true).length,
    promoted: fused.filter(
      (entry) =>
        entry.lexicalHit === true &&
        Number.isSafeInteger(entry.denseRank) &&
        Number.isSafeInteger(entry.lexicalRank) &&
        entry.hybridRank < entry.lexicalRank,
    ).length,
  }
  const dense = (Array.isArray(trace?.dense) ? trace.dense : [])
    .filter((entry) => fused.some((row) => row.path === entry.path && row.lexicalHit !== true))
    .slice(0, 5)
  const status = copy[STATUS_KEYS[state] ?? 'idle']
  return {
    state,
    tone: state === 'hybrid' ? 'active' : state === 'idle' ? 'idle' : 'quiet',
    title: copy.title,
    status,
    counts,
    dense,
    query: trace?.query?.text ?? '',
    privacy: copy.privacy,
    labels: {
      lexical: copy.lexical,
      denseOnly: copy.denseOnly,
      promoted: copy.promoted,
      replay: copy.replay,
    },
  }
}

/**
 * The browser-side owner of the semantic state: the map is fetched once, recall
 * polling is cursor-deduped, replay goes through `explain`, and the renderer gets
 * one painter that always reads the latest trace.
 *
 * Every action carries the session id: the graph route rejects a request without
 * one before it dispatches (`bad-request: sessionId required`), and the map and
 * neighbour views are served by that same route — a browser that forgot the id
 * would see the card fall back to `route-error` on every poll.
 *
 * @param {{post?: (payload: object) => Promise<any>, locale?: string}} options
 */
export function createSemanticController({ post, locale = 'zh' } = {}) {
  if (typeof post !== 'function') throw new RangeError('createSemanticController requires post')
  let map = null
  let trace = null
  let started = 0
  let cursor = 0
  let error = ''
  let currentLocale = pickLocale(locale)
  return {
    async loadMap(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') {
        error = 'sessionId required'
        map = { state: 'unavailable', reason: 'route-error' }
        return map
      }
      try {
        map = await post({ sessionId, action: 'semantic' })
        error = ''
      } catch (cause) {
        error = cause.message
        map = { state: 'unavailable', reason: 'route-error' }
      }
      return map
    },
    async poll(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return { cursor, events: [] }
      try {
        const value = await post({ sessionId, action: 'recall', cursor })
        cursor = Number.isSafeInteger(value?.cursor) ? value.cursor : cursor
        if (Array.isArray(value?.events) && value.events.length > 0) {
          trace = value.events.at(-1)
          started = Date.now()
          error = ''
        }
        return value
      } catch (cause) {
        error = cause.message
        return { cursor, events: [] }
      }
    },
    async replay(sessionId, query) {
      try {
        trace = await post({ sessionId, action: 'explain', query })
        started = Date.now()
        error = ''
        return trace
      } catch (cause) {
        error = cause.message
        return null
      }
    },
    async neighbors(sessionId, path) {
      return post({ sessionId, action: 'neighbors', path })
    },
    trace() {
      return trace
    },
    state() {
      return { map, trace, error }
    },
    overlay(positionOf) {
      return createOverlayModel(trace, positionOf)
    },
    decode(mapPayload) {
      return decodeMapPoints(mapPayload)
    },
    /** Renderer overlay hook: build the model from the latest trace and paint it. */
    paint(frame) {
      if (typeof frame?.lookup?.entries !== 'function' || typeof frame?.points?.get !== 'function')
        return
      const idByPath = new Map()
      for (const [id, node] of frame.lookup) idByPath.set(node.path, id)
      const model = createOverlayModel(
        trace,
        (path) => frame.points.get(idByPath.get(path)) ?? null,
      )
      if (model === null) return
      return createSemanticPainter(() => ({ model, started }))(frame)
    },
    started() {
      return started
    },
    locale(localeTag) {
      currentLocale = pickLocale(localeTag)
      return currentLocale
    },
    card() {
      return cardView({ locale: currentLocale, ...this.state() })
    },
  }
}

/**
 * The bottom overlay card. Kept to plain DOM so the panel does not pull a second
 * React tree into the served bundle; the panel mounts it and feeds `cardView`
 * results in.
 *
 * @param {{document?: object, locale?: string, onReplay?: (query: string) => void, onLocate?: (path: string) => void}} options
 */
export function mountCard({ document, locale = 'zh', onReplay, onLocate } = {}) {
  if (!document || typeof document.createElement !== 'function')
    throw new RangeError('mountCard requires a document')
  const copy = CARD_COPY[pickLocale(locale)]
  const root = document.createElement('div')
  root.className = 'mem-semantic-card is-idle'
  const summary = document.createElement('button')
  summary.className = 'mem-semantic-card-summary'
  summary.type = 'button'
  const body = document.createElement('div')
  body.className = 'mem-semantic-card-body'
  const detail = document.createElement('div')
  detail.className = 'mem-semantic-card-detail'
  const replay = document.createElement('input')
  replay.className = 'mem-semantic-card-replay'
  replay.placeholder = copy.replay
  const privacy = document.createElement('p')
  privacy.className = 'mem-semantic-card-privacy'
  privacy.textContent = copy.privacy
  body.appendChild(detail)
  body.appendChild(replay)
  body.appendChild(privacy)
  root.appendChild(summary)
  root.appendChild(body)
  let current = null
  let expanded = false
  const render = (view) => {
    current = view
    summary.textContent = view ? view.title + ' · ' + view.status : copy.title
    summary.setAttribute('aria-expanded', String(expanded))
    detail.replaceChildren?.()
    if (view) {
      if (view.query) {
        const query = document.createElement('p')
        query.className = 'mem-semantic-card-query'
        query.textContent = view.query.slice(0, 80)
        detail.appendChild(query)
      }
      const counts = document.createElement('p')
      counts.className = 'mem-semantic-card-counts'
      counts.textContent =
        view.labels.lexical +
        ' ' +
        view.counts.lexical +
        ' · ' +
        view.labels.denseOnly +
        ' ' +
        view.counts.denseOnly +
        ' · ' +
        view.labels.promoted +
        ' ' +
        view.counts.promoted
      detail.appendChild(counts)
      for (const entry of view.dense) {
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'mem-semantic-card-dense'
        button.textContent = entry.path
        button.addEventListener('click', () => onLocate?.(entry.path))
        detail.appendChild(button)
      }
    }
    root.className = 'mem-semantic-card is-' + (view?.tone ?? 'idle') + (expanded ? ' is-open' : '')
  }
  summary.addEventListener('click', () => {
    expanded = !expanded
    render(current)
  })
  replay.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return
    const query = String(replay.value ?? '').trim()
    if (query !== '') onReplay?.(query)
  })
  return {
    element: root,
    update(input) {
      render(cardView({ locale, ...input }))
    },
    expand(value = true) {
      expanded = value === true
      render(current)
    },
    destroy() {
      root.remove?.()
    },
  }
}
