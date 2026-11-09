// @ts-check
// The model route a background pass may use when the operator never configured one.
//
// `distill.provider` + `distill.model` is an explicit route. When the pair is empty
// the documented meaning is "reuse the session's last recorded route" — and until
// now a background pass could not know it, so `autoReview` was a silent no-op on
// the default configuration. This module is the missing memory: the capture seam
// reports the provider/model the conversation actually ran on, keyed by project, and
// the background reviewer falls back to it. An explicit pair always wins; this is
// only the floor under it, never a guess.
//
// What is stored is routing metadata (two model identifiers and a timestamp), never
// a prompt, a note or a credential. The file is private (`0600` under `dataRoot`,
// written through the same locked atomic helpers as the delivery state), bounded,
// pruned by age and by project count, and every failure is fail-open: an unreadable
// route file reads as "no remembered route", which is exactly the old behaviour.
//
// The TTL is measured on the stored `updatedAt`, not the file mtime: a provider
// retired from the host must stop being used even if the entry is old but the file
// was touched yesterday by another project. Thirty days is the same horizon as the
// delivery state's retention — past that, a session route is history, not a fact
// about which model this install can still call.

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { readPrivateJson, withPrivateLock, writePrivateJson } from './delivery-state.js'

/** Schema of `<dataRoot>/review-route.json`. A mismatch is "no remembered route". */
export const REVIEW_ROUTE_SCHEMA = 1

/** Ceiling for the private route file; 200 project entries fit well below it. */
export const REVIEW_ROUTE_MAX_BYTES = 64 * 1024

/** How long a remembered route stays usable after the last conversation that used it. */
export const REVIEW_ROUTE_TTL_MS = 30 * 24 * 60 * 60 * 1000

/** How many projects one file keeps; the oldest entry is dropped first. */
export const REVIEW_ROUTE_MAX_PROJECTS = 200

/** The provider half is a service id, not free prose; the model half is a model id. */
const PROVIDER_MAX_CHARS = 120
const MODEL_MAX_CHARS = 200

/**
 * The remembered-route file for one plugin data root.
 *
 * @param {{dataRoot?: unknown}} input - the plugin data root.
 * @returns {string} the absolute route-state path.
 * @throws {RangeError} when the data root is not a non-blank string.
 */
export function reviewRoutePath({ dataRoot } = {}) {
  if (typeof dataRoot !== 'string' || dataRoot.trim() === '') {
    throw new RangeError('a review route state needs a non-blank data root')
  }
  return join(dataRoot, 'review-route.json')
}

/** One clamped model id, or `null` when it is not a usable string. */
function modelId(value, maxChars) {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (text === '' || [...text].length > maxChars) return null
  // Identity characters only: a route is an identifier pair, never text with
  // whitespace or a control character inside it, and such a value could not come
  // from the host's request context anyway.
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (code <= 0x20 || code === 0x7f || /\s/u.test(char)) return null
  }
  return text
}

/**
 * Normalize a provider/model pair into the stored route shape.
 *
 * @param {unknown} route - `{provider, model}`, or anything else.
 * @returns {{provider: string, model: string}|null} the usable pair, or `null`.
 */
export function normalizeReviewRoute(route) {
  if (route === null || typeof route !== 'object' || Array.isArray(route)) return null
  const provider = modelId(/** @type {any} */ (route).provider, PROVIDER_MAX_CHARS)
  const model = modelId(/** @type {any} */ (route).model, MODEL_MAX_CHARS)
  if (provider === null || model === null) return null
  return { provider, model }
}

/**
 * The explicitly configured route, or `null` when the pair is not complete.
 *
 * This is the same predicate the reviewer, the trigger and the panel card have
 * always shared; it stays the first choice so an operator's configuration can
 * never be overridden by an observation.
 *
 * @param {object} config - the validated plugin config.
 * @returns {{provider: string, model: string}|null} the configured route, or `null`.
 */
export function routeFromConfig(config) {
  const distill = /** @type {any} */ (config)?.distill
  const provider = modelId(distill?.provider, PROVIDER_MAX_CHARS)
  const model = modelId(distill?.model, MODEL_MAX_CHARS)
  if (provider === null || model === null) return null
  return { provider, model }
}

/** One millisecond value from a `Date`, a number or `Date.now`. */
function toMillis(now) {
  if (now instanceof Date) {
    const value = now.getTime()
    return Number.isFinite(value) ? value : Date.now()
  }
  if (typeof now === 'number' && Number.isFinite(now)) return now
  if (typeof now === 'function') return toMillis(now())
  return Date.now()
}

/**
 * Remember the route one captured conversation turn actually ran on.
 *
 * The write is a locked read-modify-write of the one private file; entries are
 * replaced per project and the oldest overflow is dropped. A failure (locked file,
 * unwritable data root, malformed input) answers `false` and never throws: a missed
 * observation only means the reviewer falls back to the explicit configuration,
 * which is the pre-existing behaviour.
 *
 * @param {{dataRoot?: unknown, projectId?: unknown, route?: unknown, now?: Date|number|Function}} input - the observation.
 * @returns {Promise<boolean>} whether the route was persisted.
 */
export async function rememberSessionRoute({ dataRoot, projectId, route, now = Date.now } = {}) {
  try {
    const remembered = normalizeReviewRoute(route)
    const key = typeof projectId === 'string' ? projectId.trim() : ''
    if (remembered === null || key === '') return false
    const path = reviewRoutePath({ dataRoot })
    const root = /** @type {string} */ (dataRoot)
    // `withPrivateLock` creates the chain *below* its root, not the root itself: the
    // caller owns that directory, exactly as the session-state writer does. Without
    // this the first remember on a fresh install failed with ENOENT on the lock file.
    await mkdir(root, { recursive: true, mode: 0o700 })
    const updatedAt = new Date(toMillis(now)).toISOString()
    return await withPrivateLock({ path, root }, async () => {
      const read = await readPrivateJson({ path, root, maxBytes: REVIEW_ROUTE_MAX_BYTES })
      const current =
        read.value?.schema === REVIEW_ROUTE_SCHEMA &&
        read.value.projects !== null &&
        typeof read.value.projects === 'object' &&
        !Array.isArray(read.value.projects)
          ? /** @type {Record<string, any>} */ (read.value.projects)
          : {}
      const projects = { ...current, [key]: { ...remembered, updatedAt } }
      const bounded = Object.entries(projects)
        .sort((left, right) => {
          const l = Date.parse(String(left[1]?.updatedAt ?? ''))
          const r = Date.parse(String(right[1]?.updatedAt ?? ''))
          if (!Number.isFinite(l) && !Number.isFinite(r)) return left[0] < right[0] ? -1 : 1
          if (!Number.isFinite(l)) return 1
          if (!Number.isFinite(r)) return -1
          return r - l
        })
        .slice(0, REVIEW_ROUTE_MAX_PROJECTS)
      await writePrivateJson({
        path,
        root,
        value: { schema: REVIEW_ROUTE_SCHEMA, projects: Object.fromEntries(bounded) },
      })
      return true
    })
  } catch {
    return false
  }
}

/**
 * The route last observed for one project, or `null` when there is none usable.
 *
 * Missing, corrupt, wrongly versioned, symlinked and stale files all answer `null`
 * for one reason: a background pass may only run on a route this install has
 * evidence it can call, and "no evidence" and "corrupt evidence" are the same
 * decision.
 *
 * @param {{dataRoot?: unknown, projectId?: unknown, now?: Date|number|Function}} input - the lookup.
 * @returns {Promise<{provider: string, model: string, updatedAt: string}|null>} the remembered route.
 */
export async function readRememberedRoute({ dataRoot, projectId, now = Date.now } = {}) {
  try {
    const key = typeof projectId === 'string' ? projectId.trim() : ''
    if (key === '') return null
    const path = reviewRoutePath({ dataRoot })
    const root = /** @type {string} */ (dataRoot)
    const read = await readPrivateJson({ path, root, maxBytes: REVIEW_ROUTE_MAX_BYTES })
    if (read.value === null || read.value.schema !== REVIEW_ROUTE_SCHEMA) return null
    const projects = read.value.projects
    if (projects === null || typeof projects !== 'object' || Array.isArray(projects)) return null
    const entry = /** @type {any} */ (projects)[key]
    const remembered = normalizeReviewRoute(entry)
    if (remembered === null) return null
    const updatedAt = typeof entry?.updatedAt === 'string' ? entry.updatedAt : ''
    const at = Date.parse(updatedAt)
    if (!Number.isFinite(at) || toMillis(now) - at > REVIEW_ROUTE_TTL_MS) return null
    return { ...remembered, updatedAt }
  } catch {
    return null
  }
}

/**
 * The one route every automatic-review gate resolves: configured pair, else the
 * route last observed for this project.
 *
 * The three gates (the host trigger, the pass and the panel card) all call this
 * function, so they cannot disagree about whether a route exists — the drift the
 * exported `reviewRouteOf` predicate was introduced to prevent.
 *
 * @param {{config?: object, dataRoot?: unknown, projectId?: unknown, now?: Date|number|Function}} input - the resolution inputs.
 * @returns {Promise<{provider: string, model: string, source: 'config'|'remembered'}|null>} the route.
 */
export async function resolveReviewRoute({ config, dataRoot, projectId, now = Date.now } = {}) {
  const configured = routeFromConfig(config)
  if (configured !== null) return { ...configured, source: /** @type {const} */ ('config') }
  const remembered = await readRememberedRoute({ dataRoot, projectId, now })
  if (remembered === null) return null
  return {
    provider: remembered.provider,
    model: remembered.model,
    source: /** @type {const} */ ('remembered'),
  }
}
