// Independently implemented event feedback. Design references:
// force-graph/example/emit-particles and sigma.js/4-use-reducers on GitHub.
// An edge cue indicates a relationship; it never means the neighbor was read.
//
// Three kinds arrive here and two of them look different on purpose: a read (and
// an injected recall map) takes the accent highlight, a write takes the tag
// colour so "this note just changed" is not read as "this note was read", and a
// search hit is the same accent at a lower weight, because finding a note is
// weaker evidence of use than opening it.
const DURATION = 2600
/** How much of a read's weight a search hit keeps. */
const SEARCH_WEIGHT = 0.6
/**
 * How long a cue waits for the note it names to appear in the projection.
 *
 * The graph is rebuilt from a snapshot every 15 s, so a write cues a note that no
 * snapshot has carried yet. The event itself goes stale long before that (an
 * event older than 3.6 s is not replayed), which is why the cue is parked here
 * rather than left in the list: without this, every note a turn *creates* is
 * written and never lights up.
 */
const PENDING_TTL = 60000
/** How many parked cues are kept, so a path that never appears cannot pile up. */
const PENDING_MAX = 80
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

/** The cue kind an activity event carries, with everything unknown read as a read. */
function kindOf(event) {
  return event.kind === 'write' || event.kind === 'search' ? event.kind : 'read'
}

/** Create bounded, per-renderer recall state driven by received activity events. */
export function createGraphRecall() {
  const seen = new Map()
  const entries = new Map()
  /** Cues whose note no projection has carried yet, newest per path. */
  const pending = new Map()
  return {
    update(events, nodes, now, wallTime) {
      const byPath = new Map(nodes.map((node) => [node.path, node.id]))
      const wanted = new Set(byPath.values())
      for (const id of seen.keys()) if (!wanted.has(id)) seen.delete(id)
      for (const id of entries.keys()) if (!wanted.has(id)) entries.delete(id)
      if (!events.length) {
        seen.clear()
        entries.clear()
        pending.clear()
      }
      for (const event of events) {
        if (!Number.isFinite(event.at) || wallTime - event.at >= 3600) continue
        const id = byPath.get(event.path)
        if (id === undefined) {
          // Parked, not dropped: the node may simply not be in this snapshot yet.
          const cursor = Number.isSafeInteger(event.cursor) ? event.cursor : 0
          pending.delete(event.path)
          pending.set(event.path, { at: event.at, cursor, kind: kindOf(event) })
          while (pending.size > PENDING_MAX) pending.delete(pending.keys().next().value)
          continue
        }
        const previous = seen.get(id)
        const cursor = Number.isSafeInteger(event.cursor) ? event.cursor : 0
        if (previous && event.at <= previous.at && cursor <= previous.cursor) continue
        seen.set(id, { at: event.at, cursor })
        // Polling may consume the entrance before an event arrives. Start the
        // finite visual clock at receipt, then use monotonic time until expiry.
        // `recall` is normalised to `read`: an injected map is a read of those
        // notes, and it has always looked like one.
        entries.set(id, { started: now, kind: kindOf(event) })
      }
      // A parked cue starts its clock when its node finally arrives: the cue is
      // about a note the projection only just showed, and the clock that would
      // have run at receipt had nothing to paint.
      for (const [path, queued] of pending) {
        const id = byPath.get(path)
        if (id === undefined) {
          if (wallTime - queued.at >= PENDING_TTL) pending.delete(path)
          continue
        }
        pending.delete(path)
        const previous = seen.get(id)
        if (previous && queued.at <= previous.at && queued.cursor <= previous.cursor) continue
        seen.set(id, { at: queued.at, cursor: queued.cursor })
        entries.set(id, { started: now, kind: queued.kind })
      }
    },
    frame(now, lookup, reduced) {
      const cues = new Map()
      const related = new Set()
      let weight = 0
      for (const [id, entry] of entries) {
        const age = Math.max(0, now - entry.started)
        if (age >= DURATION) {
          entries.delete(id)
          continue
        }
        const cue = { ...cueAt(age, reduced), started: entry.started, kind: entry.kind }
        if (entry.kind === 'search') cue.weight *= SEARCH_WEIGHT
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
      pending.clear()
    },
  }
}

/** Paint a stationary soft halo and core only for an actually recalled node. */
export function paintRecallNode(context, node, cue, palette) {
  if (!cue || cue.weight <= 0) return
  // A write is not a read: it takes the tag colour, so the graph says which of the
  // two happened. The geometry is shared, only the slot differs.
  const slot = cue.kind === 'write' ? palette.fillTag : palette.fillHighlight
  const radius = node.r + 9
  const halo = context.createRadialGradient(node.x, node.y, node.r, node.x, node.y, radius)
  halo.addColorStop(0, slot.css)
  halo.addColorStop(1, 'transparent')
  context.globalAlpha = cue.weight * 0.18
  context.fillStyle = halo
  context.beginPath()
  context.arc(node.x, node.y, radius, 0, Math.PI * 2)
  context.fill()
  context.globalAlpha = cue.weight * 0.82 * slot.a
  context.fillStyle = slot.opaque
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
  // The sweep follows the cue's colour so a write never reads as a read.
  const line = cue.kind === 'write' ? palette.fillTag : palette.lineHighlight
  context.globalAlpha = cue.weight * 0.2 * line.a
  context.lineWidth = Math.max(1, width)
  context.strokeStyle = line.opaque
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
  gradient.addColorStop(1, line.css)
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
