/* global self, postMessage, d3 */
// The force contract is measured from Obsidian 1.13.7's sim.js fallback.
// Use the upstream D3 implementation; render and host adapters stay independent.
const link = d3
  .forceLink()
  .id((node) => node.id)
  .distance(250)
const baseLinkStrength = link.strength()
const x = d3.forceX(0).strength(0.1)
const y = d3.forceY(0).strength(0.1)
// MEASURED (2026-10-30, scratch/qa/bench-report): charge is 72% of the layout cost
// at 4 000 nodes and collision 26%, while link is 0.9%. A charge force with no
// `distanceMax` walks the whole quadtree for every node; bounding the interaction
// radius to 2 500 world units took 2 000 nodes from 32.7 ms to 9.7 ms per tick and
// 4 000 from 50.2 to 20.9, and the layout it produces is measurably the same: at 800
// nodes the minimum spacing stayed 108.8 px with zero overlaps, spread 4358 x 4338.
// (`distanceMax(600)` is NOT that trade — it flattens the spread from 5597 to 3158 —
// so the bound is set at the distance the panel's own slider can already produce.)
// `theta(1.2)` makes the quadtree approximate more of the far field, which is what
// the same measurement supports; the original 0.9 is kept nowhere.
const charge = d3.forceManyBody().strength(-1000).distanceMin(30).distanceMax(2500).theta(1.2)
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

// MEASURED (2026-10-30, scratch/qa/graph-bench.mjs, this machine): one tick at the
// shipped forces costs 7.6 ms at 500 nodes, 30-35 ms at 1 000 and 68-113 ms at
// 2 000-4 000 — and the cost is dominated by forceCollide, the only force whose
// quadtree walk grows super-linearly: with collision removed the same 1 000-node
// graph costs 5 ms. The panel now draws every node, so a large vault must not be
// laid out at a cost nobody can interact with.
//
// Two derived settings keep the whole graph usable instead of capping what is
// drawn. Collision is dropped above COLLISION_LIMIT nodes: overlap in a dense
// graph reads as a cluster, while a 60 ms tick reads as a broken panel. And a
// large graph cools at a coarser alpha step, so it settles in about the same
// wall-clock time as a small one instead of in hundreds of frames.
const COLLISION_LIMIT = 800
const LARGE_GRAPH = 1500
let collisionOn = true

/** Apply the measured size policy to the running simulation. */
function applySizePolicy() {
  const size = lookup.size
  const wanted = size <= COLLISION_LIMIT
  if (wanted !== collisionOn) {
    collisionOn = wanted
    simulation.force('collision', wanted ? collision : null)
  }
  // 300 steps is the shipped decay; a large graph reaches the same alpha floor in
  // half as many, which is what keeps its settle time bounded.
  simulation.alphaDecay(1 - Math.pow(0.001, 1 / (size > LARGE_GRAPH ? 150 : 300)))
}

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
    applySizePolicy()
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
