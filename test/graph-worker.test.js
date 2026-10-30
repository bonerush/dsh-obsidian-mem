import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The four upstream distributions the shipped worker is built from, in the order
 * `scripts/build-graph-worker.mjs` concatenates them.
 */
const UPSTREAM_PACKAGES = ['d3-quadtree', 'd3-dispatch', 'd3-timer', 'd3-force']

/**
 * The repository root, as a directory path usable with `join`/`existsSync`.
 */
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

/**
 * The packages `scripts/build-graph-worker.mjs` cannot resolve in this checkout.
 *
 * The build resolves each distribution the way Node does, anchored at d3-force's
 * own resolved directory, so a pnpm tree (which keeps the other three under
 * `node_modules/.pnpm/d3-force@…/node_modules/`) is a supported layout rather than a
 * permanent skip. This probe mirrors that resolution instead of testing for a flat
 * `node_modules/<name>`: the old flat test reported a complete install as missing
 * and cost the rebuild guarantee on every pnpm checkout.
 *
 * @returns {string[]} the missing package names; empty when the build can run.
 */
function missingUpstreamPackages() {
  const rootRequire = createRequire(join(REPO_ROOT, 'package.json'))
  let anchor
  try {
    // The anchor is d3-force's RESOLVED directory: on a pnpm tree the hoisted
    // `node_modules/d3-force` is a symlink whose lexical neighbours are not the
    // package's own dependencies, so a lookup anchored there finds nothing.
    anchor = createRequire(join(dirname(dirname(rootRequire.resolve('d3-force'))), 'package.json'))
  } catch {
    return [...UPSTREAM_PACKAGES]
  }
  return UPSTREAM_PACKAGES.filter((name) => {
    try {
      if (name === 'd3-force') rootRequire.resolve(name)
      else anchor.resolve(name)
      return false
    } catch {
      return true
    }
  })
}

/**
 * Why the rebuild check cannot run here, or `false` when it can.
 *
 * Measured 2026-10-28 on this checkout: only `d3-force` is installed at the root
 * and the other three are absent, so `--check` exits 1 with
 * `ENOENT … node_modules/d3-quadtree/package.json`. The shipped asset was verified
 * independently against the same pinned versions in the pnpm store and is
 * byte-identical to what the script emits (after the CRLF normalization git's
 * clean filter applies on this host), so this skip costs the rebuild check, not
 * the guarantee. Install the full devDependencies (the documented `npm ci`) and
 * this case runs, and must pass.
 */
const REBUILD_SKIP = (() => {
  const missing = missingUpstreamPackages()
  if (missing.length === 0) return false
  return (
    'not installed at node_modules/ in this checkout: ' +
    missing.join(', ') +
    ' (incomplete or pnpm-nested dependency tree), so scripts/build-graph-worker.mjs' +
    ' --check cannot read the pinned distributions; expected to pass after a' +
    ' complete npm ci'
  )
})()

test(
  'shipped worker and license match the pinned upstream distributions and reviewed adapter',
  { skip: REBUILD_SKIP },
  () => {
    const result = spawnSync(process.execPath, ['scripts/build-graph-worker.mjs', '--check'], {
      cwd: new URL('..', import.meta.url),
      encoding: 'utf8',
    })
    assert.equal(result.status, 0, result.stderr)
  },
)

async function worker() {
  const source = await readFile(new URL('../lib/graph-worker.js', import.meta.url), 'utf8')
  const pending = new Map()
  const frames = []
  let clock = 0
  let nextId = 0
  const context = {
    self: {},
    performance: { now: () => clock },
    setTimeout(callback) {
      const id = ++nextId
      pending.set(id, callback)
      return id
    },
    clearTimeout: (id) => pending.delete(id),
    setInterval: () => ++nextId,
    clearInterval() {},
    postMessage: (frame) => frames.push(frame),
  }
  runInNewContext(source, context)
  return {
    send: (data) => context.self.onmessage({ data }),
    tick(count = 1) {
      for (let i = 0; i < count && pending.size; i += 1) {
        const [id, callback] = pending.entries().next().value
        pending.delete(id)
        clock += 1000 / 60
        callback()
      }
      const frame = frames.at(-1)
      assert.ok(frame, 'the shipped worker must publish a frame')
      return new Map(
        Array.from(frame.id, (id, i) => [
          id,
          Array.from(new Float32Array(frame.buffer).slice(i * 2, i * 2 + 2)),
        ]),
      )
    },
  }
}

test('graph worker lays out a connected hub without overlap and stops when cooled', async () => {
  const sim = await worker()
  const nodes = { hub: [0, 0] }
  const links = []
  for (let i = 0; i < 12; i += 1) {
    nodes[`leaf${i}`] = [Math.cos(i) * 20, Math.sin(i) * 20]
    links.push(['hub', `leaf${i}`])
  }
  sim.send({ nodes, links, alpha: 1, run: true })
  const points = sim.tick(320)
  assert.equal(points.size, 13)
  for (const point of points.values()) assert.ok(point.every(Number.isFinite))
  const hub = points.get('hub')
  assert.ok(Math.hypot(...hub) < 70, 'the linked hub stays at the cluster center')
  for (const [id, point] of points) {
    if (id === 'hub') continue
    const distance = Math.hypot(point[0] - hub[0], point[1] - hub[1])
    assert.ok(distance > 120 && distance < 420, `a branch remains attached: ${distance}`)
  }
  assert.deepEqual(sim.tick(20), points, 'a cooled worker does not continue moving nodes')
})

test('graph worker preserves existing positions, pins a dragged node and removes filtered nodes', async () => {
  const sim = await worker()
  sim.send({ nodes: { a: [-80, 0], b: [80, 0] }, links: [['a', 'b']], run: true })
  sim.tick(20)
  sim.send({ forceNode: { id: 'a', x: 155, y: -90 }, alpha: 0.3, run: true })
  assert.deepEqual(sim.tick(5).get('a'), [155, -90])
  sim.send({ nodes: { a: false }, links: [], alpha: 0.3, run: true })
  const filtered = sim.tick(2)
  assert.equal(filtered.size, 1)
  assert.deepEqual(filtered.get('a'), [155, -90])
  sim.send({ forceNode: { id: 'a', x: null, y: null }, alpha: 0.3, run: true })
  assert.ok(Math.hypot(...sim.tick(100).get('a')) < Math.hypot(155, 90))
})

test("the ported Obsidian forces keep a dense large graph's leaves apart exactly as a small graph", async () => {
  // 1:1 parity: sim.js keeps forceCollide(60, 0.5) on at every size — it has no size
  // policy at all — so a graph above the old 800-node threshold separates its leaves
  // the same way a small one does. The fixture is a ring whose leaves start 30 world
  // units apart. Measured on 2026-10-30 (macOS 27.2, Node 25.9.0, 320 ticks): the
  // parity worker settles the 902-leaf ring at a minimum pair distance of ~49 and the
  // 500-leaf ring at ~70, while the old drop-collision policy settled the 902-leaf
  // ring at ~31. The threshold pins the invariant "leaves keep the force's minimum
  // spacing", not the exact geometry.
  const ring = async (count) => {
    const sim = await worker()
    const nodes = { hub: [0, 0] }
    const links = []
    for (let i = 0; i < count - 1; i += 1) {
      const angle = (i / (count - 1)) * Math.PI * 2
      nodes['leaf' + i] = [Math.cos(angle) * 30, Math.sin(angle) * 30]
      links.push(['hub', 'leaf' + i])
    }
    sim.send({ nodes, links, run: true })
    return sim.tick(320)
  }
  const minimum = (points) => {
    const list = [...points.values()]
    let min = Infinity
    for (let i = 0; i < list.length; i += 1)
      for (let j = i + 1; j < list.length; j += 1)
        min = Math.min(min, Math.hypot(list[i][0] - list[j][0], list[i][1] - list[j][1]))
    return min
  }
  const small = await ring(500)
  assert.equal(small.size, 500)
  for (const point of small.values()) assert.ok(point.every(Number.isFinite))
  assert.ok(minimum(small) > 60, 'a small graph still answers the quadtree force')
  const large = await ring(902)
  assert.equal(large.size, 902)
  for (const point of large.values()) assert.ok(point.every(Number.isFinite))
  const largeMinimum = minimum(large)
  assert.ok(
    largeMinimum > 40,
    'a 902-node graph keeps its leaves apart: ' + largeMinimum.toFixed(1),
  )
})

test('repulsion and link distance controls change the actual worker geometry', async () => {
  const distance = async (forces) => {
    const sim = await worker()
    sim.send({
      nodes: { a: [-80, 0], b: [80, 0] },
      links: [['a', 'b']],
      forces,
      run: true,
    })
    const points = sim.tick(320)
    const a = points.get('a')
    const b = points.get('b')
    return Math.hypot(a[0] - b[0], a[1] - b[1])
  }
  const baseline = await distance({ linkDistance: 250, repelStrength: 1000 })
  assert.ok((await distance({ linkDistance: 450, repelStrength: 1000 })) > baseline + 100)
  assert.ok((await distance({ linkDistance: 250, repelStrength: 8000 })) > baseline + 30)
})
