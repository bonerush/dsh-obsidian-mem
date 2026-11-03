// @ts-check
// Project the vault's embedding vectors to two deterministic dimensions.
//
// PCA runs against the covariance *operator*, never a materialised d×d matrix:
// the store is 1024-dimensional and a 1024² matrix per projection costs more
// than the iteration it feeds. Power iteration with Gram–Schmidt deflation
// gives the first two components in O(iterations · n · d). The start vector is a
// fixed function of the coordinate index, so two runs over the same vectors are
// byte-identical — the point cloud does not reshuffle between panel reloads.

export const PCA_ITERATIONS = 24
const EPSILON = 1e-12
const GOLDEN = 0.6180339887498949

function dot(a, b) {
  let sum = 0
  for (let index = 0; index < a.length; index += 1) sum += a[index] * b[index]
  return sum
}

function normalize(vector) {
  const norm = Math.sqrt(dot(vector, vector))
  if (!(norm > EPSILON)) return null
  for (let index = 0; index < vector.length; index += 1) vector[index] /= norm
  return vector
}

function startVector(dimensions) {
  const vector = new Float64Array(dimensions)
  for (let index = 0; index < dimensions; index += 1)
    vector[index] = 1 + Math.sin((index + 1) * GOLDEN)
  return normalize(vector)
}

export function createSemanticProjection({
  vectors,
  total,
  generatedAt = null,
  iterations = PCA_ITERATIONS,
}) {
  const empty = (state, count = 0) => ({
    state,
    count,
    total,
    explained: 0,
    generatedAt,
    points: new Map(),
    project: () => null,
  })
  if (!(vectors instanceof Map) || vectors.size === 0) return empty('warming')
  const paths = [...vectors.keys()].sort()
  let dimensions = null
  const usable = []
  for (const path of paths) {
    const raw = vectors.get(path)
    const vector = Array.isArray(raw)
      ? Float64Array.from(raw)
      : raw instanceof Float32Array || raw instanceof Float64Array
        ? Float64Array.from(raw)
        : null
    if (vector === null) return empty('warming')
    if (dimensions === null) dimensions = vector.length
    if (vector.length !== dimensions) continue
    usable.push({ path, vector })
  }
  if (usable.length === 0) return empty('warming')
  if (usable.length < total) return empty('warming', usable.length)
  const mean = new Float64Array(dimensions)
  for (const { vector } of usable)
    for (let index = 0; index < dimensions; index += 1) mean[index] += vector[index]
  for (let index = 0; index < dimensions; index += 1) mean[index] /= usable.length
  const apply = (vector) => {
    const target = new Float64Array(dimensions)
    for (const { vector: point } of usable) {
      let weight = 0
      for (let index = 0; index < dimensions; index += 1)
        weight += (point[index] - mean[index]) * vector[index]
      for (let index = 0; index < dimensions; index += 1)
        target[index] += weight * (point[index] - mean[index])
    }
    return target
  }
  const component = (previous) => {
    let vector = startVector(dimensions)
    for (let round = 0; round < iterations; round += 1) {
      const next = apply(vector)
      if (previous !== null) {
        const projection = dot(next, previous)
        for (let index = 0; index < dimensions; index += 1)
          next[index] -= projection * previous[index]
      }
      const unit = normalize(next)
      if (unit === null) return null
      vector = unit
    }
    return vector
  }
  const first = component(null)
  const second = first === null ? null : component(first)
  if (first === null || second === null) return empty('degenerate')
  const trace = usable.reduce((sum, { vector }) => {
    let squared = 0
    for (let index = 0; index < dimensions; index += 1) {
      const delta = vector[index] - mean[index]
      squared += delta * delta
    }
    return sum + squared
  }, 0)
  const lambda1 = dot(first, apply(first))
  const lambda2 = dot(second, apply(second))
  if (!(trace > EPSILON) || !(lambda1 + lambda2 > EPSILON)) return empty('degenerate')
  const raw = usable.map(({ path, vector }) => {
    const centred = (axis) => {
      let value = 0
      for (let index = 0; index < dimensions; index += 1)
        value += (vector[index] - mean[index]) * axis[index]
      return value
    }
    return { path, x: centred(first), y: centred(second) }
  })
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (const point of raw) {
    minX = Math.min(minX, point.x)
    maxX = Math.max(maxX, point.x)
    minY = Math.min(minY, point.y)
    maxY = Math.max(maxY, point.y)
  }
  const span = Math.max(maxX - minX, maxY - minY)
  if (!(span > EPSILON)) return empty('degenerate')
  const midX = (minX + maxX) / 2
  const midY = (minY + maxY) / 2
  const points = new Map(
    raw.map(({ path, x, y }) => [path, { x: (x - midX) / span + 0.5, y: (y - midY) / span + 0.5 }]),
  )
  const project = (vector) => {
    if (!vector || vector.length !== dimensions) return null
    const axis = (direction) => {
      let value = 0
      for (let index = 0; index < dimensions; index += 1)
        value += (vector[index] - mean[index]) * direction[index]
      return value
    }
    return { x: (axis(first) - midX) / span + 0.5, y: (axis(second) - midY) / span + 0.5 }
  }
  return {
    state: 'ready',
    count: usable.length,
    total,
    explained: (lambda1 + lambda2) / trace,
    generatedAt,
    points,
    project,
  }
}

export function nearestNeighbors(vectors, path, options = {}) {
  const limit = Number.isSafeInteger(options.limit) && options.limit > 0 ? options.limit : 8
  const target = vectors instanceof Map ? vectors.get(path) : undefined
  if (target === undefined || target === null) return []
  const targetNorm = Math.sqrt(dot(target, target))
  if (!(targetNorm > EPSILON)) return []
  const scored = []
  for (const [other, vector] of vectors) {
    if (other === path || vector.length !== target.length) continue
    const norm = Math.sqrt(dot(vector, vector))
    if (!(norm > EPSILON)) continue
    scored.push({ path: other, score: dot(target, vector) / (targetNorm * norm) })
  }
  scored.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
  return scored.slice(0, limit).map((entry, index) => ({ ...entry, rank: index + 1 }))
}
