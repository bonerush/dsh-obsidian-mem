// Independently implemented event feedback. Design references:
// force-graph/example/emit-particles and sigma.js/4-use-reducers on GitHub.
// An edge cue indicates a relationship; it never means the neighbor was read.
const DURATION = 2600
const clamp = (value) => Math.max(0, Math.min(1, value))
const smooth = (value) => {
  const t = clamp(value)
  return t * t * (3 - 2 * t)
}

function cueAt(age, reduced) {
  const weight = reduced ? 1 : smooth(age / 180) * (1 - smooth((age - 2000) / 600))
  const travel = (age - 140) / 880
  return {
    weight,
    sweep: !reduced && travel >= 0 && travel <= 1 ? travel : null,
  }
}

/** Create bounded, per-renderer recall state driven by received activity events. */
export function createGraphRecall() {
  const seen = new Map()
  const entries = new Map()
  return {
    update(events, nodes, now, wallTime) {
      const byPath = new Map(nodes.map((node) => [node.path, node.id]))
      const wanted = new Set(byPath.values())
      for (const id of seen.keys()) if (!wanted.has(id)) seen.delete(id)
      for (const id of entries.keys()) if (!wanted.has(id)) entries.delete(id)
      if (!events.length) {
        seen.clear()
        entries.clear()
      }
      for (const event of events) {
        const id = byPath.get(event.path)
        if (!id || !Number.isFinite(event.at) || wallTime - event.at >= 3600) continue
        const previous = seen.get(id)
        const cursor = Number.isSafeInteger(event.cursor) ? event.cursor : 0
        if (previous && event.at <= previous.at && cursor <= previous.cursor) continue
        seen.set(id, { at: event.at, cursor })
        // Polling may consume the entrance before an event arrives. Start the
        // finite visual clock at receipt, then use monotonic time until expiry.
        entries.set(id, now)
      }
    },
    frame(now, lookup, reduced) {
      const cues = new Map()
      const related = new Set()
      let weight = 0
      for (const [id, started] of entries) {
        const age = Math.max(0, now - started)
        if (age >= DURATION) {
          entries.delete(id)
          continue
        }
        const cue = { ...cueAt(age, reduced), started }
        cues.set(id, cue)
        weight = Math.max(weight, cue.weight)
        if (cue.weight > 0) {
          related.add(id)
          for (const neighbor of lookup.get(id)?.related ?? []) related.add(neighbor)
        }
      }
      return { cues, related, weight }
    },
    clear() {
      seen.clear()
      entries.clear()
    },
  }
}

/** Paint a stationary soft halo and core only for an actually recalled node. */
export function paintRecallNode(context, node, cue, palette) {
  if (!cue || cue.weight <= 0) return
  const radius = node.r + 9
  const halo = context.createRadialGradient(node.x, node.y, node.r, node.x, node.y, radius)
  halo.addColorStop(0, palette.fillHighlight.css)
  halo.addColorStop(1, 'transparent')
  context.globalAlpha = cue.weight * 0.18
  context.fillStyle = halo
  context.beginPath()
  context.arc(node.x, node.y, radius, 0, Math.PI * 2)
  context.fill()
  context.globalAlpha = cue.weight * 0.82 * palette.fillHighlight.a
  context.fillStyle = palette.fillHighlight.opaque
  context.beginPath()
  context.arc(node.x, node.y, node.r, 0, Math.PI * 2)
  context.fill()
  context.globalAlpha = cue.weight * 0.5 * palette.circle.a
  context.strokeStyle = palette.circle.css
  context.lineWidth = 1
  context.beginPath()
  context.arc(node.x, node.y, node.r + 2.5, 0, Math.PI * 2)
  context.stroke()
}

/** Sweep each incident edge once, outward from its most recently read endpoint. */
export function paintRecallEdge(context, edge, activity, palette, width) {
  const a = activity.cues.get(edge.source.id)
  const b = activity.cues.get(edge.target.id)
  const fromSource = (a?.started ?? -Infinity) >= (b?.started ?? -Infinity)
  const cue = fromSource ? a : b
  if (!cue || cue.weight <= 0) return
  context.globalAlpha = cue.weight * 0.2 * palette.lineHighlight.a
  context.lineWidth = Math.max(1, width)
  context.strokeStyle = palette.lineHighlight.opaque
  context.beginPath()
  context.moveTo(edge.sx, edge.sy)
  context.lineTo(edge.tx, edge.ty)
  context.stroke()
  if (cue.sweep === null) return
  const sx = fromSource ? edge.sx : edge.tx
  const sy = fromSource ? edge.sy : edge.ty
  const tx = fromSource ? edge.tx : edge.sx
  const ty = fromSource ? edge.ty : edge.sy
  const length = Math.hypot(tx - sx, ty - sy)
  if (length < 1) return
  const segment = Math.min(0.35, 34 / length)
  const head = cue.sweep * (1 + segment)
  const tail = Math.max(0, head - segment)
  const tip = Math.min(1, head)
  if (tip <= tail) return
  const x1 = sx + (tx - sx) * tail,
    y1 = sy + (ty - sy) * tail,
    x2 = sx + (tx - sx) * tip,
    y2 = sy + (ty - sy) * tip
  const gradient = context.createLinearGradient(x1, y1, x2, y2)
  gradient.addColorStop(0, 'transparent')
  gradient.addColorStop(1, palette.lineHighlight.css)
  context.strokeStyle = gradient
  context.globalAlpha =
    cue.weight * smooth(cue.sweep / 0.08) * (1 - smooth((cue.sweep - 0.88) / 0.12))
  context.lineWidth = Math.max(1.5, width + 0.6)
  context.lineCap = 'round'
  context.beginPath()
  context.moveTo(x1, y1)
  context.lineTo(x2, y2)
  context.stroke()
  context.lineCap = 'butt'
}
