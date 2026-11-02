// @ts-check
// Durable note-embedding cache for the optional hybrid retrieval engine.
//
// The store is a single JSON file under the data root, keyed by the vault and
// the model, because that is the whole dependency surface the hybrid path needs
// at query time: one read, then in-memory cosine. JSON rather than SQLite is
// deliberate - it works with both index backends (the in-memory scan backend
// cannot open a second SQLite handle), it is inspectable, and 1089 notes x 384
// float64 is about 3.3 MB, cheap enough to load once per process. The file is
// rebuildable at any time; deleting it costs one re-embed and nothing else.
//
// Sync is hash-based: the index reports the note hash (the same hash the vault
// transaction writes), so a re-index or an edit only re-embeds what changed. A
// note's embedding is deliberately not invalidated by anything else, because the
// embedded text is title plus body only - tags, links and frontmatter are not
// part of the vector and may change without re-embedding.
//
// Layer L1: node builtins plus ./fs-atomic.js. It must not import the receipts
// module (L2) for its atomic writer, so it owns a small one built on the same
// primitives; the shared part (temp file, fsync, rename retry) is fs-atomic's.
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { fsyncDirectory, renameWithRetry } from './fs-atomic.js'

/** Store schema version. A file with any other version is rebuilt, never migrated. */
export const EMBEDDING_STORE_VERSION = 1
/** Hard cap on one embedded text, in code points (the offline experiment's truncation). */
export const EMBEDDING_TEXT_CHARS = 1200
/** Provider batch bound; matches PROVIDER_MAX_EMBED_TEXTS in ./retrieval-provider.js. */
export const EMBEDDING_BATCH_SIZE = 16

export class EmbeddingStoreError extends Error {
  /**
   * @param {string} code - stable machine code (provider-* passthrough, or store-*).
   * @param {string} message - operator-readable message with no note text.
   * @param {{cause?: unknown}} [options] - original error for logs.
   */
  constructor(code, message, options = {}) {
    super(message, options)
    this.name = 'EmbeddingStoreError'
    this.code = code
  }
}

/**
 * Resolve the canonical vault path (realpath), falling back to the absolute path
 * when the directory is not there yet. The vault hash must identify the same
 * directory across renames of its parents, which is what realpath buys.
 *
 * @param {string} vaultRoot - configured vault root.
 * @returns {Promise<string>} absolute real path when resolvable.
 */
async function canonicalVaultRoot(vaultRoot) {
  try {
    return await fs.realpath(vaultRoot)
  } catch {
    return resolve(vaultRoot)
  }
}

/**
 * The store's file path for one vault, model and dimensionality.
 *
 * @param {{dataRoot: string, vaultRoot: string, model: string, dimensions: number}} options - identity.
 * @returns {string} absolute path; deterministic, so callers may cache it.
 */
export function embeddingStorePath({ dataRoot, vaultRoot, model, dimensions }) {
  const vaultHash = createHash('sha256').update(resolve(vaultRoot)).digest('hex').slice(0, 16)
  const modelTag = createHash('sha256').update(model).digest('hex').slice(0, 16)
  return join(
    dataRoot,
    'index',
    'embeddings-' + vaultHash + '-' + modelTag + '-' + dimensions + '.json',
  )
}

/** @param {string} vaultRoot @returns {Promise<string>} hash recorded in the header. */
async function vaultRootHash(vaultRoot) {
  return createHash('sha256')
    .update(await canonicalVaultRoot(vaultRoot))
    .digest('hex')
}

/**
 * Build one embedding input from a candidate note.
 *
 * @param {{title?: string, body?: string}} note - index row.
 * @returns {string} title, newline, body, truncated to the text cap.
 */
export function embeddingText(note) {
  const text = (note.title ?? '') + '\n' + (note.body ?? '')
  const characters = [...text]
  return characters.length > EMBEDDING_TEXT_CHARS
    ? characters.slice(0, EMBEDDING_TEXT_CHARS).join('')
    : text
}

/**
 * Defensive JSON write: stage, fsync, rename, fsync the directory. Same contract
 * as receipts.writeJsonAtomic, which L1 cannot reach; fs-atomic owns the parts
 * that differ across platforms.
 *
 * @param {string} path - destination.
 * @param {unknown} value - JSON-serializable value.
 * @returns {Promise<void>} resolves once the rename is durable.
 */
async function writeJsonAtomic(path, value) {
  const directory = dirname(path)
  await fs.mkdir(directory, { recursive: true })
  const temporary = join(
    directory,
    '.' + Date.now() + '.' + process.pid + '.' + Math.random().toString(16).slice(2) + '.tmp',
  )
  let handle
  try {
    handle = await fs.open(temporary, 'wx', 0o600)
    await handle.writeFile(JSON.stringify(value) + '\n', 'utf8')
    await handle.sync()
    await handle.close()
    handle = null
    await renameWithRetry(temporary, path)
  } catch (error) {
    await handle?.close().catch(() => {})
    await fs.rm(temporary, { force: true }).catch(() => {})
    throw error
  }
  await fsyncDirectory(directory)
}

/**
 * A finite vector of the exact dimensionality, as a Float64Array, or null.
 *
 * @param {unknown} value - parsed JSON value.
 * @param {number} dimensions - expected length.
 * @returns {Float64Array|null} the vector, or null when the entry is unusable.
 */
function usableVector(value, dimensions) {
  if (!Array.isArray(value) || value.length !== dimensions) return null
  const numbers = new Float64Array(value.length)
  for (let index = 0; index < value.length; index += 1) {
    const number = value[index]
    if (typeof number !== 'number' || !Number.isFinite(number)) return null
    numbers[index] = number
  }
  return numbers
}

/**
 * Open (or lazily create) the note-embedding store for one project.
 *
 * @param {{dataRoot: string, vaultRoot: string, model: string, dimensions: number}} options - store identity.
 * @returns {Promise<{path: string, sync: Function, snapshot: Function}>} the store handle.
 */
export async function openEmbeddingStore({ dataRoot, vaultRoot, model, dimensions }) {
  if (!Number.isInteger(dimensions) || dimensions <= 0) {
    throw new EmbeddingStoreError('store-config', 'dimensions must be a positive integer')
  }
  const path = embeddingStorePath({ dataRoot, vaultRoot, model, dimensions })
  const rootHash = await vaultRootHash(vaultRoot)
  /** @type {{key: string, vectors: Map<string, Float64Array>, hashes: Map<string, string>, generatedAt: string}|null} */
  let cache = null

  /**
   * Read and validate the store file. Anything unusable at the header or entry
   * level yields null, which sync and snapshot treat as an empty store: a
   * half-trusted cache would serve a stale or wrongly-dimensioned vector, and
   * rebuilding is one provider round trip.
   *
   * @returns {Promise<{key: string, vectors: Map<string, Float64Array>, hashes: Map<string, string>, generatedAt: string}|null>} parsed state.
   */
  async function readState() {
    let stat
    try {
      stat = await fs.stat(path)
    } catch (error) {
      if (error.code === 'ENOENT') return null
      throw error
    }
    const key = stat.mtimeMs + ':' + stat.size + ':' + stat.ino
    if (cache && cache.key === key) return cache
    let parsed
    try {
      parsed = JSON.parse(await fs.readFile(path, 'utf8'))
    } catch {
      return null
    }
    if (
      !parsed ||
      parsed.version !== EMBEDDING_STORE_VERSION ||
      parsed.model !== model ||
      parsed.dimensions !== dimensions ||
      parsed.vaultRootHash !== rootHash ||
      typeof parsed.vectors !== 'object' ||
      parsed.vectors === null ||
      typeof parsed.hashes !== 'object' ||
      parsed.hashes === null
    ) {
      return null
    }
    const vectors = new Map()
    const hashes = new Map()
    for (const [notePath, value] of Object.entries(parsed.vectors)) {
      const vector = usableVector(value, dimensions)
      if (!vector) return null
      vectors.set(notePath, vector)
    }
    for (const [notePath, value] of Object.entries(parsed.hashes)) {
      if (typeof value !== 'string') return null
      hashes.set(notePath, value)
    }
    if (vectors.size !== hashes.size) return null
    const state = { key, vectors, hashes, generatedAt: parsed.generatedAt }
    cache = state
    return state
  }

  /**
   * Embed every new or changed note, prune removed ones, write once.
   *
   * @param {Array<{path: string, hash: string, title?: string, body?: string}>} notes - candidate notes from the index.
   * @param {(request: {texts: string[], kind: string, signal?: AbortSignal}) => Promise<{vectors: number[][]}>} embed - provider embed function.
   * @param {{signal?: AbortSignal, batchSize?: number}} [options] - cancellation and batch tuning.
   * @returns {Promise<{embedded: number, reused: number, pruned: number, total: number, batches: number}>} sync counts.
   */
  async function sync(notes, embed, options = {}) {
    const state = await readState()
    const vectors = new Map(state?.vectors ?? [])
    const hashes = new Map(state?.hashes ?? [])
    const batchSize = options.batchSize ?? EMBEDDING_BATCH_SIZE
    const wanted = new Set()
    /** @type {Array<{path: string, hash: string, text: string}>} */
    const changed = []
    for (const note of notes) {
      wanted.add(note.path)
      if (hashes.get(note.path) === note.hash && vectors.has(note.path)) continue
      changed.push({ path: note.path, hash: note.hash, text: embeddingText(note) })
    }
    const pruned = [...vectors.keys()].filter((notePath) => !wanted.has(notePath)).length

    let batches = 0
    /**
     * Embed one slice, bisecting only on a provider timeout. The batch bound is a
     * request-size limit, not a promise that a slow local model answers inside
     * the configured timeout: e5-base took 5.4s on sixteen 1200-cp texts against
     * a 5s timeout. A timeout on a single text is still a real failure, and any
     * other error propagates untouched. Successful requests are what count as
     * batches.
     */
    const embedSlice = async (slice) => {
      let response
      try {
        response = await embed({
          texts: slice.map((entry) => entry.text),
          kind: 'passage',
          signal: options.signal,
        })
      } catch (error) {
        const code = typeof error?.code === 'string' ? error.code : 'store-embed-failed'
        if (code === 'provider-timeout' && slice.length > 1) {
          const middle = Math.floor(slice.length / 2)
          const left = await embedSlice(slice.slice(0, middle))
          const right = await embedSlice(slice.slice(middle))
          return left.concat(right)
        }
        if (error instanceof EmbeddingStoreError) throw error
        throw new EmbeddingStoreError(code, 'embedding request failed', { cause: error })
      }
      batches += 1
      const batchVectors = response?.vectors
      if (!Array.isArray(batchVectors) || batchVectors.length !== slice.length) {
        throw new EmbeddingStoreError(
          'provider-invalid-response',
          'embedding response length mismatch',
        )
      }
      return batchVectors
    }
    for (let start = 0; start < changed.length; start += batchSize) {
      const batch = changed.slice(start, start + batchSize)
      const batchVectors = await embedSlice(batch)
      for (let index = 0; index < batch.length; index += 1) {
        const vector = usableVector(batchVectors[index], dimensions)
        if (!vector) {
          throw new EmbeddingStoreError(
            'provider-invalid-response',
            'embedding vector has the wrong shape',
          )
        }
        vectors.set(batch[index].path, vector)
        hashes.set(batch[index].path, batch[index].hash)
      }
    }

    // The next file holds exactly this sync's candidate set: removed notes are
    // pruned, and reused notes carry their recorded hash forward unchanged.
    const nextVectors = new Map()
    const nextHashes = new Map()
    for (const note of notes) {
      nextVectors.set(note.path, vectors.get(note.path))
      nextHashes.set(note.path, note.hash)
    }

    const reused = notes.length - changed.length
    const mustWrite = changed.length > 0 || pruned > 0 || state === null
    if (mustWrite) {
      await writeJsonAtomic(path, {
        version: EMBEDDING_STORE_VERSION,
        model,
        dimensions,
        vaultRootHash: rootHash,
        generatedAt: new Date().toISOString(),
        vectors: Object.fromEntries(
          [...nextVectors].map(([notePath, vector]) => [notePath, Array.from(vector)]),
        ),
        hashes: Object.fromEntries(nextHashes),
      })
      cache = null
    }
    return { embedded: changed.length, reused, pruned, total: notes.length, batches }
  }

  /**
   * In-memory view for query time: one JSON read per file revision, then map
   * lookups. `size` is how many notes have a vector, not how many exist.
   *
   * @returns {Promise<{vectors: Map<string, Float64Array>, size: number, generatedAt: string}>} snapshot.
   */
  async function snapshot() {
    const state = await readState()
    return {
      vectors: new Map(state?.vectors ?? []),
      size: state?.vectors.size ?? 0,
      generatedAt: state?.generatedAt ?? '',
    }
  }

  return { path, sync, snapshot }
}
