import { colorOf, resolvePalette } from './graph-palette.js'

// Obsidian xQ caches PIXI.Text at resolution 2 and only changes its transform
// during zoom. Re-rasterizing at each fractional zoom size changes glyph shape
// and defeats the browser's font cache. Keep that contract in this Canvas port.
const FONT =
  'ui-sans-serif, -apple-system, BlinkMacSystemFont, system-ui, "Segoe UI", Roboto, "Inter", "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Microsoft YaHei Light", sans-serif'
const clamp = (value, min, max) => Math.max(min, Math.min(max, value))
/** app.js `fQ`: the alpha the rest of the graph keeps while one node is highlighted. */
const DIM = 0.2
/**
 * Deliberate deviation from the original: app.js rasterizes a label at
 * `14 + getSize() / 4` px, and this panel is a narrow sidebar rather than a full
 * graph pane, where the same labels read as oversized next to the fitted graph.
 * The factor is the default of the display section's "标题文字大小" slider
 * (`display.label`); position, ordering, `sqrt(scale)` scaling and the
 * `1 / scale` pin for a highlighted node stay exactly as app.js has it.
 */
const LABEL_SCALE = 0.5
const labelOf = (node) => node.path.split('/').pop().replace(/\.md$/, '')
const breaks = '[\\t \\u2000-\\u2006\\u2008-\\u200a\\u205f\\u3000]'
const trailingSpaces = new RegExp(breaks + '+$')
const breakingSpace = new RegExp('^' + breaks + '$')

// Pixi TextStyle's defaults are whiteSpace: pre and breakWords: false. A long
// CJK filename without spaces stays whole; wordWrapWidth never squeezes glyphs.
function wrap(text, context) {
  const lines = []
  let line = ''
  let width = 0
  let allowLeading = true
  const push = () => {
    lines.push(line.replace(trailingSpaces, ''))
    line = ''
    width = 0
  }
  const tokens = text.split(new RegExp('([\\r\\n]|' + breaks + ')')).filter(Boolean)
  const widths = new Map()
  for (const token of tokens) {
    if (token === '\r' || token === '\n') {
      push()
      allowLeading = true
      continue
    }
    if (!widths.has(token)) widths.set(token, context.measureText(token).width)
    const tokenWidth = widths.get(token)
    if (tokenWidth > 300) {
      if (line) push()
      lines.push(token)
      allowLeading = false
      continue
    }
    if (width + tokenWidth > 300) {
      push()
      allowLeading = false
    }
    if (line || !breakingSpace.test(token) || allowLeading) {
      line += token
      width += tokenWidth
    }
  }
  if (line || lines.length === 0) push()
  return lines
}

function rasterLabel(document, node, color, scale) {
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d', { willReadFrequently: true })
  const font = 'normal normal normal ' + (14 + node.baseRadius / 4) * scale + 'px ' + FONT
  context.font = font
  const lines = wrap(node.label, context)
  const metrics = context.measureText('|ÉqÅM')
  const ascent = Math.ceil(metrics.actualBoundingBoxAscent)
  const height = ascent + Math.ceil(metrics.actualBoundingBoxDescent)
  const widths = lines.map((line) => context.measureText(line).width)
  const inkWidth = Math.max(0, ...widths)
  const width = Math.ceil(Math.max(1, inkWidth))
  canvas.width = width * 2
  canvas.height = Math.max(1, height * lines.length) * 2
  context.setTransform(2, 0, 0, 2, 0, 0)
  context.font = font
  context.fillStyle = color
  context.textBaseline = 'alphabetic'
  lines.forEach((line, index) =>
    context.fillText(line, (inkWidth - widths[index]) / 2, ascent + index * height),
  )
  return {
    canvas,
    width,
    height: canvas.height / 2,
    font,
    color,
    label: node.label,
    radius: node.baseRadius,
    scale,
  }
}

/**
 * Create the browser graph renderer over one canvas. Layout remains in a Worker.
 * Labels, viewport culling and the 60 idle frame limit follow Obsidian's graph.
 * @param {HTMLCanvasElement} canvas - visible graph surface.
 * @param {(message: string) => void} onError - failure-isolated view message.
 * @returns {{update: Function, setForces: Function, destroy: Function}} renderer lifetime.
 */
export function createGraphRenderer(canvas, onError) {
  const document = canvas.ownerDocument
  const win = document.defaultView
  const context = canvas.getContext('2d')
  const worker = new win.Worker('/obsidian-mem/graph-worker.js')
  const s = {
    points: new Map(),
    workerIds: new Set(),
    lookup: new Map(),
    nodes: [],
    edges: [],
    labels: new Map(),
    active: new Map(),
    view: { x: 0, y: 0, scale: 1, target: 1 },
    model: null,
    focus: null,
    fit: true,
    frames: 0,
    drag: null,
    width: 1,
    height: 1,
    ratio: 1,
    timer: null,
    idle: 0,
    destroyed: false,
  }
  let palette = {}
  function readPalette() {
    // The slot table and the probe read live in `graph-palette.js`; a theme switch
    // — Obsidian's or this host's — repaints the graph with no other change.
    palette = resolvePalette({
      document,
      win,
      host: canvas.parentElement ?? document.body,
    })
    changed()
  }
  function changed() {
    if (s.destroyed) return
    s.idle = 0
    if (s.timer === null) s.timer = win.requestAnimationFrame(draw)
  }
  function resize() {
    s.width = canvas.clientWidth
    s.height = canvas.clientHeight
    s.ratio = win.devicePixelRatio || 1
    canvas.width = Math.round(s.width * s.ratio)
    canvas.height = Math.round(s.height * s.ratio)
    changed()
  }
  const observer = new win.ResizeObserver(resize)
  observer.observe(canvas)
  win.addEventListener?.('resize', resize)
  // This host flips `body[data-ds-dark-theme]`; Obsidian flips classes on its app
  // container. Watch both documents plus every ancestor of the panel, so either
  // kind of theme switch re-resolves the slots.
  const themeObserver = win.MutationObserver && new win.MutationObserver(readPalette)
  if (themeObserver) {
    const observed = new Set([document.documentElement, document.body])
    for (let parent = canvas.parentElement; parent; parent = parent.parentElement)
      observed.add(parent)
    for (const target of observed) {
      if (target === null || target === undefined) continue
      themeObserver.observe(target, {
        attributes: true,
        attributeFilter: ['class', 'style', 'data-theme', 'data-ds-dark-theme'],
      })
    }
  }
  readPalette()
  const fontsChanged = () => {
    s.labels.clear()
    changed()
  }
  document.fonts?.addEventListener('loadingdone', fontsChanged)
  worker.onerror = () => onError('图谱布局暂不可用')
  worker.onmessage = ({ data }) => {
    const coordinates = new Float32Array(data.buffer)
    data.id.forEach((id, index) => {
      if (!s.workerIds.has(id)) return
      const point = s.points.get(id)
      point.x = coordinates[index * 2]
      point.y = coordinates[index * 2 + 1]
    })
    s.frames += 1
    changed()
  }
  const at = (event) => {
    const rect = canvas.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }
  const screen = (point) => ({
    x: (point.x - s.view.x) * s.view.scale + s.width / 2,
    y: (point.y - s.view.y) * s.view.scale + s.height / 2,
  })
  const world = (point) => ({
    x: s.view.x + (point.x - s.width / 2) / s.view.scale,
    y: s.view.y + (point.y - s.height / 2) / s.view.scale,
  })
  const hit = (point) =>
    s.nodes.find((node) => {
      const p = screen(node.point)
      return (
        Math.hypot(point.x - p.x, point.y - p.y) <= node.baseRadius * Math.sqrt(s.view.scale) + 4
      )
    })
  const wheel = (event) => {
    event.preventDefault()
    s.fit = false
    let delta = event.deltaY
    if (event.deltaMode === 1) delta *= 40
    if (event.deltaMode === 2) delta *= 800
    const target = clamp(s.view.target * Math.pow(1.5, -delta / 120), 1 / 128, 8)
    s.zoomPoint = target < s.view.scale ? { x: s.width / 2, y: s.height / 2 } : at(event)
    s.zoomAt = world(s.zoomPoint)
    s.view.target = target
    changed()
  }
  const down = (event) => {
    if (event.button !== 0) return
    s.fit = false
    const p = at(event),
      node = hit(p)
    s.drag = { id: node?.id, start: p, x: s.view.x, y: s.view.y, moved: false }
    s.focus = node?.id ?? null
    canvas.setPointerCapture(event.pointerId)
    changed()
  }
  const move = (event) => {
    const p = at(event)
    if (s.drag) {
      const drag = s.drag
      drag.moved ||= Math.hypot(p.x - drag.start.x, p.y - drag.start.y) > 3
      if (drag.id) {
        const position = world(p)
        Object.assign(s.points.get(drag.id), position)
        worker.postMessage({
          forceNode: { id: drag.id, ...position },
          alpha: 0.3,
          alphaTarget: 0.3,
          run: true,
        })
      } else {
        s.view.x = drag.x - (p.x - drag.start.x) / s.view.scale
        s.view.y = drag.y - (p.y - drag.start.y) / s.view.scale
      }
      changed()
    } else {
      const node = hit(p),
        focus = node?.id ?? null
      if (s.focus !== focus) {
        s.focus = focus
        changed()
      }
      canvas.style.cursor = node ? 'pointer' : 'grab'
      canvas.title = node?.label ?? ''
    }
  }
  const up = () => {
    if (s.drag?.id) {
      worker.postMessage({
        forceNode: { id: s.drag.id, x: null, y: null },
        alphaTarget: 0,
        run: true,
      })
    }
    s.drag = null
    changed()
  }
  const leave = () => {
    if (!s.drag && s.focus) {
      s.focus = null
      changed()
    }
  }
  const fit = () => {
    s.fit = true
    s.frames = 0
    s.zoomAt = null
    changed()
  }
  const key = (event) => {
    if (event.key === 'Escape') {
      s.focus = null
      changed()
    }
    if (event.key === '0') fit()
    if (event.key === '+' || event.key === '-') {
      s.fit = false
      s.zoomAt = null
      s.view.target = clamp(s.view.target * (event.key === '+' ? 1.25 : 0.8), 1 / 128, 8)
      changed()
    }
  }
  const listeners = {
    wheel,
    pointerdown: down,
    pointermove: move,
    pointerup: up,
    pointercancel: up,
    pointerleave: leave,
    dblclick: fit,
    keydown: key,
  }
  for (const [name, handler] of Object.entries(listeners))
    canvas.addEventListener(name, handler, { passive: false })

  function sync() {
    const wanted = new Set(s.model.graph.nodes.map((node) => node.id))
    for (const id of s.points.keys())
      if (!wanted.has(id)) {
        s.points.delete(id)
        s.labels.delete(id)
      }
    const adjacency = new Map(s.model.graph.nodes.map((node) => [node.id, []]))
    for (const edge of s.model.graph.edges) {
      adjacency.get(edge.source)?.push(edge.target)
      adjacency.get(edge.target)?.push(edge.source)
    }
    const added = s.model.graph.nodes.filter((node) => !s.workerIds.has(node.id))
    let oldRadius = 0
    for (const point of s.points.values())
      oldRadius = Math.max(oldRadius, Math.hypot(point.x, point.y))
    const area = 3600 * added.length
    const ring = Math.sqrt(area / Math.PI + oldRadius * oldRadius) - oldRadius
    const jitter = Math.sqrt(area)
    const nodes = {}
    for (const node of s.model.graph.nodes) {
      if (s.workerIds.has(node.id)) {
        nodes[node.id] = false
        continue
      }
      let point = s.points.get(node.id)
      if (!point) {
        const neighbors = adjacency
          .get(node.id)
          .map((id) => s.points.get(id))
          .filter(Boolean)
        if (neighbors.length)
          point = {
            x:
              neighbors.reduce((sum, next) => sum + next.x, 0) / neighbors.length +
              (Math.random() - 0.5) * jitter,
            y:
              neighbors.reduce((sum, next) => sum + next.y, 0) / neighbors.length +
              (Math.random() - 0.5) * jitter,
          }
        else {
          const angle = Math.random() * Math.PI * 2,
            radius = oldRadius + Math.sqrt(Math.random()) * ring
          point = { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius }
        }
        s.points.set(node.id, point)
      }
      nodes[node.id] = [point.x, point.y]
    }
    s.workerIds = wanted
    worker.postMessage({
      nodes,
      links: s.model.graph.edges.map((edge) => [edge.source, edge.target]),
      alpha: 0.3,
      run: true,
    })
  }

  function update(model) {
    if (s.destroyed) return
    const previous = s.model
    s.model = model
    if (!previous || previous.graph !== model.graph) sync()
    if (
      !previous ||
      previous.graph !== model.graph ||
      previous.degree !== model.degree ||
      previous.colors !== model.colors ||
      previous.display.size !== model.display.size
    ) {
      const old = s.lookup
      s.nodes = model.graph.nodes.map((node) => ({
        ...node,
        label: labelOf(node),
        point: s.points.get(node.id),
        baseRadius:
          model.display.size * clamp(3 * Math.sqrt((model.degree.get(node.id) ?? 0) + 1), 8, 30),
        color: model.colors.get(node.id),
        related: new Set(),
        fade: old.get(node.id)?.fade ?? 0,
        moveText: old.get(node.id)?.moveText ?? 0,
      }))
      s.lookup = new Map(s.nodes.map((node) => [node.id, node]))
      const seen = new Set()
      s.edges = []
      for (const edge of model.graph.edges) {
        const source = s.lookup.get(edge.source),
          target = s.lookup.get(edge.target)
        if (!source || !target) continue
        source.related.add(target.id)
        target.related.add(source.id)
        const key = [edge.source, edge.target].sort().join('\0')
        if (!seen.has(key)) {
          seen.add(key)
          s.edges.push({ source, target })
        }
      }
    }
    s.active.clear()
    const byPath = new Map(model.graph.nodes.map((node) => [node.path, node.id]))
    for (const call of model.active) {
      const id = byPath.get(call.path)
      if (id) s.active.set(id, Math.max(call.at, s.active.get(id) ?? 0))
    }
    changed()
  }
  const outside = (left, top, right, bottom) =>
    right < 0 || left > s.width || bottom < 0 || top > s.height
  function edgeGeometry(edge) {
    const a = edge.source,
      b = edge.target
    if (outside(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y)))
      return false
    const dx = b.x - a.x,
      dy = b.y - a.y,
      length = Math.hypot(dx, dy) || 1
    if (length <= a.r + b.r) return false
    edge.sx = a.x + (dx * a.r) / length
    edge.sy = a.y + (dy * a.r) / length
    edge.tx = b.x - (dx * b.r) / length
    edge.ty = b.y - (dy * b.r) / length
    return true
  }

  function draw() {
    s.timer = null
    if (s.destroyed || !s.model) return
    const appearance = s.model.display,
      now = Date.now()
    if (s.fit && s.nodes.length) {
      let minX = Infinity,
        maxX = -Infinity,
        minY = Infinity,
        maxY = -Infinity
      for (const node of s.nodes) {
        minX = Math.min(minX, node.point.x)
        maxX = Math.max(maxX, node.point.x)
        minY = Math.min(minY, node.point.y)
        maxY = Math.max(maxY, node.point.y)
      }
      s.view.x = (minX + maxX) / 2
      s.view.y = (minY + maxY) / 2
      s.view.target = clamp(
        Math.min(
          (s.width - 80) / Math.max(120, maxX - minX),
          (s.height - 80) / Math.max(120, maxY - minY),
        ),
        1 / 128,
        1,
      )
      if (s.frames > 90) s.fit = false
    }
    // Original updateZoom stops interpolation at a 1% ratio difference.
    if (Math.max(s.view.scale / s.view.target, s.view.target / s.view.scale) - 1 >= 0.01) {
      s.view.scale = s.view.scale * 0.85 + s.view.target * 0.15
      if (s.zoomAt) {
        s.view.x = s.zoomAt.x - (s.zoomPoint.x - s.width / 2) / s.view.scale
        s.view.y = s.zoomAt.y - (s.zoomPoint.y - s.height / 2) / s.view.scale
      }
      s.idle = 0
    }
    const scale = s.view.scale,
      rootScale = Math.sqrt(scale),
      focus = s.drag?.id ?? s.focus
    const related = s.lookup.get(focus)?.related
    for (const node of s.nodes) {
      node.x = (node.point.x - s.view.x) * scale + s.width / 2
      node.y = (node.point.y - s.view.y) * scale + s.height / 2
      node.r = node.baseRadius * rootScale
      node.fade =
        0.9 * node.fade + 0.1 * (!focus || node.id === focus || related?.has(node.id) ? 1 : 0.2)
      const offset = node.id === focus ? 15 : 0
      node.moveText = node.textVisible === true ? 0.9 * node.moveText + 0.1 * offset : offset
    }
    for (const [id, at] of s.active) if (now - at >= 3600) s.active.delete(id)
    context.setTransform(s.ratio, 0, 0, s.ratio, 0, 0)
    context.clearRect(0, 0, s.width, s.height)
    // Obsidian's canvas stays transparent: the host surface shows through and only
    // the colour slots above paint. Lines keep their slot opacity, and the rest of
    // the graph drops to `fQ` while one node is highlighted.
    context.lineWidth = appearance.width
    // Combine equal-style lines into one path; their geometry is already culled.
    for (const highlighted of [false, true]) {
      const slot = highlighted ? palette.lineHighlight : palette.line
      context.strokeStyle = slot.css
      context.globalAlpha = (highlighted || !focus ? 1 : DIM) * slot.a
      context.beginPath()
      let count = 0
      for (const edge of s.edges) {
        const emphasized = edge.source.id === focus || edge.target.id === focus
        if (emphasized !== highlighted || !edgeGeometry(edge)) continue
        context.moveTo(edge.sx, edge.sy)
        context.lineTo(edge.tx, edge.ty)
        count += 1
      }
      if (count) context.stroke()
    }
    for (const edge of s.edges) {
      if (!edgeGeometry(edge)) continue
      if (appearance.arrows && scale > 0.3) {
        // app.js tints the arrow with the text colour and scales it by `color-arrow`.
        context.globalAlpha =
          (!focus || edge.source.id === focus || edge.target.id === focus ? 1 : DIM) *
          clamp(2 * (scale - 0.3), 0, 1) *
          palette.arrow.a
        const angle = Math.atan2(edge.ty - edge.sy, edge.tx - edge.sx)
        context.beginPath()
        context.moveTo(edge.tx, edge.ty)
        context.lineTo(edge.tx - 7 * Math.cos(angle - 0.4), edge.ty - 7 * Math.sin(angle - 0.4))
        context.lineTo(edge.tx - 7 * Math.cos(angle + 0.4), edge.ty - 7 * Math.sin(angle + 0.4))
        context.closePath()
        context.fillStyle = palette.text.opaque
        context.fill()
      }
      const started = Math.max(s.active.get(edge.source.id) ?? 0, s.active.get(edge.target.id) ?? 0)
      if (started) {
        const progress = ((now - started) % 850) / 850
        context.globalAlpha = palette.lineHighlight.a
        context.fillStyle = palette.lineHighlight.css
        context.shadowColor = palette.lineHighlight.css
        context.shadowBlur = 8
        context.beginPath()
        context.arc(
          edge.sx + (edge.tx - edge.sx) * progress,
          edge.sy + (edge.ty - edge.sy) * progress,
          3,
          0,
          Math.PI * 2,
        )
        context.fill()
        context.shadowBlur = 0
      }
    }
    for (const node of s.nodes) {
      if (
        outside(
          node.x - node.r - 17,
          node.y - node.r - 17,
          node.x + node.r + 17,
          node.y + node.r + 17,
        )
      )
        continue
      const focused = node.id === focus
      // app.js `getFillColor`: the highlighted node wins, then a colour-group
      // value, then the node type's slot, then the plain fill slot.
      const fill = focused
        ? palette.fillHighlight
        : colorOf(
            node.color,
            node.type === 'unresolved'
              ? palette.fillUnresolved
              : node.type === 'tag'
                ? palette.fillTag
                : node.type === 'attachment'
                  ? palette.fillAttachment
                  : palette.fill,
          )
      context.globalAlpha = node.fade * fill.a
      context.fillStyle = fill.opaque
      context.beginPath()
      context.arc(node.x, node.y, node.r, 0, Math.PI * 2)
      context.fill()
      if (focused || s.active.has(node.id)) {
        const pulse = s.active.has(node.id) ? ((now - s.active.get(node.id)) % 1200) / 1200 : 0
        // app.js draws the hover ring from `colors.circle` at
        // `max(1, 1 / scale / nodeScale)` world units, i.e. max(1, sqrt(scale)) on screen.
        const ring = focused ? palette.circle : palette.lineHighlight
        const width = Math.max(1, rootScale)
        context.globalAlpha = ring.a * (1 - pulse)
        context.strokeStyle = ring.css
        context.lineWidth = width
        context.beginPath()
        context.arc(node.x, node.y, node.r + width / 2 + pulse * 16, 0, Math.PI * 2)
        context.stroke()
      }
    }
    let budget = 50
    // The display section's "标题文字大小" slider, defaulting to LABEL_SCALE.
    const labelScale = Number.isFinite(appearance.label) ? appearance.label : LABEL_SCALE
    const textAlpha = clamp(Math.log2(scale) + 1 - appearance.text, 0, 1)
    for (const node of s.nodes) {
      // A node whose memory is being called is shown like a highlighted one: its
      // name stays legible at any zoom, which is the point of the cue — the panel
      // is telling you *which* file the agent just read.
      const focused = node.id === focus || s.active.has(node.id),
        alpha = focused ? 1 : textAlpha * node.fade
      if (
        alpha <= 0.001 ||
        (!focused &&
          outside(node.x - 300 * scale, node.y, node.x + 300 * scale, node.y + 200 * scale))
      ) {
        node.textVisible = false
        continue
      }
      let label = s.labels.get(node.id)
      if (
        !label ||
        label.label !== node.label ||
        label.radius !== node.baseRadius ||
        label.scale !== labelScale ||
        label.color !== palette.text.opaque
      ) {
        if (!focused && budget <= 0) {
          node.textVisible = false
          s.idle = 0
          continue
        }
        label = rasterLabel(document, node, palette.text.opaque, labelScale)
        s.labels.set(node.id, label)
        budget -= 1
        s.idle = 0
      }
      const textScale = focused && scale < 1 ? 1 : rootScale
      const width = label.width * textScale,
        height = label.height * textScale
      const top = node.y + node.r + 5 * rootScale + node.moveText
      if (!focused && outside(node.x - width / 2, top, node.x + width / 2, top + height)) {
        node.textVisible = false
        continue
      }
      // app.js multiplies the label alpha by the text colour's own opacity.
      context.globalAlpha = alpha * palette.text.a
      context.drawImage(label.canvas, node.x - width / 2, top, width, height)
      node.textVisible = true
    }
    context.globalAlpha = 1
    const called = s.nodes.filter((node) => s.active.has(node.id)).map((node) => node.label)
    const label = called.length
      ? '记忆关系图谱，正在调用 ' +
        called.length +
        ' 条记忆：' +
        called.slice(0, 3).join('、') +
        (called.length > 3 ? ' 等' : '')
      : '可缩放的记忆关系图谱，' + s.nodes.length + ' 个节点'
    if (canvas.getAttribute?.('aria-label') !== label) {
      canvas.setAttribute('data-active-count', s.active.size)
      canvas.setAttribute('aria-label', label)
    }
    if (s.active.size) s.idle = 0
    if (++s.idle <= 60) s.timer = win.requestAnimationFrame(draw)
  }

  return {
    update,
    setForces(forces) {
      worker.postMessage({ forces, alpha: 0.3, run: true })
      changed()
    },
    destroy() {
      s.destroyed = true
      observer.disconnect()
      themeObserver?.disconnect()
      win.removeEventListener?.('resize', resize)
      document.fonts?.removeEventListener('loadingdone', fontsChanged)
      if (s.timer !== null) win.cancelAnimationFrame(s.timer)
      for (const [name, handler] of Object.entries(listeners))
        canvas.removeEventListener(name, handler)
      worker.terminate()
      s.labels.clear()
      s.points.clear()
    },
  }
}
