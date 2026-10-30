/* global self, postMessage, d3 */
// 1:1 port of Obsidian's graph simulator fallback, extracted 2026-10-31 from
// /Applications/Obsidian.app/Contents/Resources/obsidian.asar /sim.js
// (17,693 bytes, sha256 549be2f69710af360d521c92b80c83718f673594d3dc2255a65e251199eee25d;
// unchanged from the file the 2026-09-28 port measured). The desktop app prefers a
// WebAssembly simulator of its own; when that contract is unavailable it runs this
// d3 fallback, which is the branch this panel ports. Every constant and step below
// is the extracted one:
//
//   forceX(0) / forceY(0)   strength 0.1
//   forceLink()             id by node id, distance 250, d3 default strength
//   forceManyBody()         strength -1000, distanceMin 30, d3 defaults otherwise
//   forceCollide(60)        strength 0.5 — always on, at every graph size
//   alpha                   1 → 0.001 over 300 steps, alphaTarget 0
//   integration             vx *= 0.6 (d3's velocityDecay accessor takes 1 - 0.4)
//
// Deliberately not ported: the wasm simulator (Obsidian's own binary, not
// redistributable) and the SharedArrayBuffer fast path (it only avoids copying the
// positions this worker already posts). An earlier revision of this file added
// distanceMax(2500)/theta(1.2) and a size policy that dropped or swapped collision
// above 800 nodes; those were local tuning, and measured on this repository's own
// vault they let a 1,236-node layout merge into rings *while it moved* — the exact
// symptom the panel user reported. Parity is the fix: no local policy remains.
const link = d3
  .forceLink()
  .id((node) => node.id)
  .distance(250)
const baseLinkStrength = link.strength()
const x = d3.forceX(0).strength(0.1)
const y = d3.forceY(0).strength(0.1)
const charge = d3.forceManyBody().strength(-1000).distanceMin(30)
const collision = d3.forceCollide(60).strength(0.5)
const simulation = d3
  .forceSimulation([])
  .stop()
  .alphaDecay(1 - Math.pow(0.001, 1 / 300))
  .velocityDecay(0.4)
  .force('x', x)
  .force('y', y)
  .force('link', link)
  .force('charge', charge)
  .force('collision', collision)
let lookup = new Map()
let timer = null
let linkStrength = 1

/**
 * One simulator frame, exactly the fallback loop in sim.js: run the five forces
 * and the integration step, then post the positions. The loop stops when the
 * surviving alpha reaches d3's alphaMin, which the 300-step decay puts at the
 * same frame count Obsidian stops on.
 */
function frame() {
  timer = null
  if (simulation.alpha() <= 0.001 || lookup.size === 0) return
  simulation.tick()
  const nodes = simulation.nodes()
  const points = new Float32Array(nodes.length * 2)
  nodes.forEach((node, index) => {
    points[index * 2] = node.x
    points[index * 2 + 1] = node.y
  })
  postMessage({ id: nodes.map((node) => node.id), buffer: points.buffer }, [points.buffer])
  timer = setTimeout(frame, 1000 / 60)
}

// The message contract is sim.js's own. nodes maps id to [x, y] for a new node or
// false for an already placed one; links are [source, target] id pairs; forceNode
// pins/releases a dragged node; forces carries the panel's four sliders;
// alpha/alphaTarget/run control the loop. The fallback starts at alpha 1 and only
// ever raises it, so the first frame of a new graph animates even though the panel
// asks for 0.3 — the same behaviour as the app's own graph.
self.onmessage = ({ data }) => {
  if (data.nodes) {
    const next = new Map()
    for (const [id, position] of Object.entries(data.nodes)) {
      const node = lookup.get(id) ?? { id, x: 0, y: 0, vx: 0, vy: 0 }
      if (position) [node.x, node.y] = position
      next.set(id, node)
    }
    lookup = next
    link.links([])
    simulation.nodes([...lookup.values()])
  }
  if (data.links) {
    link.links(
      data.links
        .filter(([source, target]) => lookup.has(source) && lookup.has(target))
        .map(([source, target]) => ({ source, target })),
    )
    link.strength((edge) => linkStrength * baseLinkStrength(edge))
  }
  if (data.forceNode) {
    const node = lookup.get(data.forceNode.id)
    if (node) {
      node.fx = data.forceNode.x
      node.fy = data.forceNode.y
    }
  }
  const forces = data.forces
  if (forces) {
    if (forces.centerStrength !== undefined) {
      x.strength(forces.centerStrength)
      y.strength(forces.centerStrength)
    }
    if (forces.repelStrength !== undefined) charge.strength(-Math.max(1, forces.repelStrength))
    if (forces.linkDistance !== undefined) link.distance(forces.linkDistance)
    if (forces.linkStrength !== undefined) {
      linkStrength = forces.linkStrength
      link.strength((edge) => linkStrength * baseLinkStrength(edge))
    }
  }
  if (data.alpha !== undefined) simulation.alpha(Math.max(simulation.alpha(), data.alpha))
  if (data.alphaTarget !== undefined) simulation.alphaTarget(data.alphaTarget)
  if (data.run && timer === null) timer = setTimeout(frame, 1000 / 60)
}
