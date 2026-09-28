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
const charge = d3.forceManyBody().strength(-1000).distanceMin(30).theta(0.9)
const simulation = d3
  .forceSimulation([])
  .stop()
  .alphaDecay(1 - Math.pow(0.001, 1 / 300))
  .velocityDecay(0.4)
  .force('x', x)
  .force('y', y)
  .force('link', link)
  .force('charge', charge)
  .force('collision', d3.forceCollide(60).strength(0.5))
let lookup = new Map()
let timer = null
let linkStrength = 1

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
