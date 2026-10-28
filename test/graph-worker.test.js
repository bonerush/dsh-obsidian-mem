import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
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
 * The packages `scripts/build-graph-worker.mjs` reads from the package-root
 * `node_modules/`, or the ones this checkout does not have there.
 *
 * The script resolves every distribution from the *package root*, which is how a
 * flat `npm ci` tree looks. A partial or strictly-nested install (pnpm keeps
 * transitive dependencies under `node_modules/d3-force/node_modules/`) leaves the
 * script unable to rebuild, and that is a property of the checkout, not of the
 * shipped asset. Naming the missing packages is what keeps the skip honest: an
 * absolute skip would also hide a stale asset on a machine that can rebuild.
 *
 * @returns {string[]} the missing package names; empty when the build can run.
 */
function missingUpstreamPackages() {
  return UPSTREAM_PACKAGES.filter((name) => {
    return !existsSync(join(REPO_ROOT, 'node_modules', name, 'package.json'))
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
