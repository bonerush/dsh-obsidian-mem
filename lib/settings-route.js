// The plugin page's settings route: read and write this plugin's profile config row.
//
// This is the host half of the "配置 on the DSH Plugins page" feature. It is a route,
// not a tool, and it is deliberately narrow:
//
//   * **One surface, one row.** It never touches a session or a vault. It reads and
//     writes the profile patch row whose Loader `options.name` is this package, through
//     the host's own `configEditor` service (`entries()` / `configuration()` /
//     `edit()`), so the write is the sanctioned "persist complete raw configs and apply
//     them through the normal Loader path" primitive rather than a hand-rolled YAML
//     edit. The route owns no second copy of the config contract: the form's fields are
//     `describeConfigFields()` and every value is judged by `validateConfig`.
//   * **Read shows what the plugin is actually running.** The effective config is the
//     LIVE row (`entry.options.config`), the composition every layer produced — the
//     home patch at `$DSH_HOME/cordis.patch.yml` included. `editor.configuration()`
//     knows only the bundle+profile layers, so a home-layer override is detected by
//     comparing the live row with the row the editor can write and answered
//     `writable:false, reason:'layer-override'` with the migration hint: the page shows
//     the true values and never pretends a save could land.
//   * **Read is always available; write is feature-detected.** `ctx.get('configEditor')`
//     is resolved at REQUEST time (P0 measured host services as absent during `apply`),
//     and a host without it still gets a readable schema with `writable:false` and a
//     reason instead of an error page. A stored raw config that no longer validates is
//     likewise read-only (`reason:'config-invalid'`), never a saveable default row.
//   * **The save returns before the edit runs.** `configEditor.edit` re-resolves and
//     remounts this very plugin. Awaiting it in the request would invalidate the
//     connection that is supposed to deliver the answer, so the route writes a durable
//     `pending` status record, replies `{scheduled:true, attempt}`, and only then starts
//     the edit. The page polls `{action:'status', attempt}`; the edit outcome rewrites
//     the record `applied`/`failed`. A crash between the two leaves a pending record a
//     later read shows as `lastWrite` — and one older than `SETTINGS_PENDING_TTL_MS`
//     is treated as stale (a new save may proceed, a poll is answered `failed`), so a
//     dead process can never wedge the page forever.
//   * **The fence is the panel's.** Every POST is loopback + same-host (`trusted`), and
//     carries `x-obsidian-mem-panel: 1` plus `application/json` — a cross-site page
//     cannot add either without a preflight this route never answers. Bodies are bounded
//     at 64 KiB (the settings form sends one complete config); the response envelope is
//     the browser routes' `{ok, value|error}`.
//   * **No diagnostics.** v1 records nothing in the ring: the status record already
//     names the outcome for the page, and a browser-driven config save is not a
//     memory-pipeline event. (No diagnostics vocabulary was added, by design.)
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'

import { describeConfigFields, validateConfig } from './config.js'
import { fsyncDirectory, renameWithRetry } from './fs-atomic.js'
import { PANEL_HEADER, PANEL_HEADER_VALUE } from './panel-route.js'
import { reply, trusted } from './route-guard.js'

/** The one route: `/obsidian-mem/settings` (GET reads, POST reads/writes). */
export const SETTINGS_ROUTE_PATH = '/obsidian-mem/settings'
/** The settings form sends one complete config in one JSON body. */
export const MAX_SETTINGS_BODY_BYTES = 64 * 1024
/** The private status record the page polls; orphaned on a plugin removal, harmless. */
export const SETTINGS_STATUS_FILE = 'settings-write.json'
/** The longest editor error message one status record keeps (paths stay bounded). */
const MAX_STATUS_MESSAGE_CHARS = 500
/** The actions the POST surface knows; anything else is a 400. */
const SETTINGS_ACTIONS = Object.freeze(['read', 'save', 'status'])
/** The states a status record can carry (`missing` is answered, never persisted). */
const SETTINGS_STATES = Object.freeze(['pending', 'applied', 'failed'])
/**
 * How long a `pending` record is trusted as "an edit is running".
 *
 * The remount a save triggers takes seconds, and the page polls for 20 s; two minutes
 * is far above both. Past it the writer is assumed dead (a crash between the pending
 * write and the outcome write leaves no other trace), so a new save may overwrite the
 * record and a poll is answered `failed` instead of spinning forever.
 */
export const SETTINGS_PENDING_TTL_MS = 120_000
/** The answer a stale pending record gives a poller: it is over, a new save may run. */
const STALE_PENDING_MESSAGE = 'previous save did not finish; a newer save may be attempted'
/**
 * The message a home-layer override answers with.
 *
 * Deliberately `$DSH_HOME/...` and never the expanded absolute path: the wire may name
 * where the user's own file lives without leaking a machine path.
 */
/** The read-only sentences a save's 409 repeats to a stale page. */
const EDITOR_UNAVAILABLE_MESSAGE = 'the config editor service is unavailable in this host'
const EDITOR_READ_ONLY_MESSAGE = 'this host cannot write plugin config from the page'
const CONFIG_INVALID_MESSAGE =
  'the stored configuration does not validate, so it cannot be saved from this page'
const LAYER_OVERRIDE_MESSAGE =
  'this config is overridden by a higher layer, the home patch at $DSH_HOME/cordis.patch.yml, which this plugin page cannot rewrite; edit that file or move the row into the profile patch'
/** The record's schema version, so an old record can be recognized and ignored. */
const SETTINGS_STATUS_SCHEMA = 1

/**
 * Register the settings route on the host's web server.
 *
 * @param {object} ctx - the host context carrying `webServer`.
 * @param {object} options - the route's inputs.
 * @param {() => object|undefined} options.editor - resolves `ctx.get('configEditor')`
 *   at request time; absent or throwing means "read-only host".
 * @param {string} options.dataRoot - the plugin's private data root (status record).
 * @param {string} options.packageName - the Loader row's `options.name` this page edits.
 * @param {() => number} [options.now] - the clock seam the status timestamps read.
 * @returns {Function} a disposer that unregisters the route.
 * @throws {RangeError} when the inputs cannot describe a working route.
 */
export function registerSettingsRoute(ctx, { editor, dataRoot, packageName, now = Date.now } = {}) {
  if (ctx === null || typeof ctx !== 'object' || ctx.webServer === undefined) {
    throw new RangeError('the settings route needs the host webServer')
  }
  if (typeof editor !== 'function') {
    throw new RangeError('the settings route needs an editor resolver function')
  }
  if (typeof dataRoot !== 'string' || dataRoot.trim() === '') {
    throw new RangeError('the settings route needs the plugin data root')
  }
  if (typeof packageName !== 'string' || packageName.trim() === '') {
    throw new RangeError('the settings route needs the plugin package name')
  }
  if (typeof now !== 'function') {
    throw new RangeError('the settings route accepts only a function as now')
  }
  const env = { editor, dataRoot, packageName, now }
  return ctx.webServer.register({
    kind: 'exact',
    path: SETTINGS_ROUTE_PATH,
    handler: (request, response) => handle(request, response, env),
  })
}

/**
 * Dispatch one request: the method, the fence, the body, then one action.
 *
 * @param {object} request - the HTTP request.
 * @param {object} response - the HTTP response.
 * @param {{editor: Function, dataRoot: string, packageName: string, now: Function}} env - the route's inputs.
 * @returns {Promise<void>} resolves once the reply is sent (a save's scheduled edit runs after it).
 */
async function handle(request, response, env) {
  if (!trusted(request)) {
    reply(response, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
    return
  }
  if (request.method === 'GET') {
    try {
      reply(response, 200, { ok: true, value: await readValue(env) })
    } catch {
      reply(response, 503, unavailable())
    }
    return
  }
  if (request.method !== 'POST') {
    reply(response, 405, {
      ok: false,
      error: { code: 'method', message: 'GET or POST required' },
    })
    return
  }
  const refusal = fenceRefusal(request)
  if (refusal !== null) {
    reply(response, refusal.status, {
      ok: false,
      error: { code: refusal.code, message: refusal.message },
    })
    return
  }
  let payload
  try {
    payload = await settingsPayloadOf(request)
  } catch (error) {
    reply(response, 400, {
      ok: false,
      error: {
        code: 'bad-request',
        // A JSON parse message can quote request bytes; keep the answer to the two
        // bounded sentences this route owns.
        message:
          error instanceof RangeError && error.message === 'request too large'
            ? 'request body is larger than 64 KiB'
            : 'request must be one JSON object',
      },
    })
    return
  }
  try {
    const action = payload.action
    if (!SETTINGS_ACTIONS.includes(action)) {
      reply(response, 400, {
        ok: false,
        error: { code: 'bad-request', message: 'unknown settings action' },
      })
      return
    }
    if (action === 'read') {
      reply(response, 200, { ok: true, value: await readValue(env) })
      return
    }
    if (action === 'status') {
      reply(response, 200, { ok: true, value: await statusValue(env, payload) })
      return
    }
    // A save must answer the page *before* it starts the reload the edit causes.
    const planned = await planSave(env, payload)
    reply(response, 200, { ok: true, value: { scheduled: true, attempt: planned.attempt } })
    planned.run()
  } catch (error) {
    const coded = typeof error?.status === 'number' && typeof error?.code === 'string'
    reply(response, coded ? error.status : 503, {
      ok: false,
      error: {
        code: coded ? error.code : 'unavailable',
        message: coded ? error.message : 'settings unavailable',
      },
    })
  }
}

/** The `{ok:false, error}` envelope an unreadable route answers. */
function unavailable() {
  return {
    ok: false,
    error: { code: 'unavailable', message: 'settings unavailable' },
  }
}

/**
 * The panel's CSRF fence, applied to every settings POST.
 *
 * The desktop proxy strips `Origin`, so the same-origin proof that survives it is the
 * panel's own header; a cross-site page cannot add a custom header (or send
 * `application/json`) without a preflight this route does not answer. Unlike the
 * panel's mutation fence there is no `Origin` alternative: the settings page is one
 * caller, and a stricter rule cannot drift with the proxy's behaviour.
 *
 * @param {object} request - the HTTP request.
 * @returns {{status: number, code: string, message: string}|null} the refusal, or `null`.
 */
function fenceRefusal(request) {
  if (request.headers[PANEL_HEADER] !== PANEL_HEADER_VALUE) {
    return { status: 403, code: 'forbidden', message: 'same-origin request required' }
  }
  const contentType = request.headers['content-type']
  if (
    typeof contentType !== 'string' ||
    !/^application\/json\s*(?:;|$)/iu.test(contentType.trim())
  ) {
    return { status: 400, code: 'bad-request', message: 'content-type application/json required' }
  }
  return null
}

/**
 * Read one settings request body, bounded at 64 KiB and required to be a plain object.
 *
 * `lib/route-guard.js`'s reader is 4 KiB because the panel's bodies are tiny; the
 * settings form legitimately sends one complete config, so this route carries its own
 * larger bound rather than widening the panel's.
 *
 * @param {object} request - the HTTP request.
 * @returns {Promise<object>} the parsed body.
 * @throws {RangeError} when the body is too large, not JSON, or not a plain object.
 */
async function settingsPayloadOf(request) {
  const chunks = []
  let bytes = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > MAX_SETTINGS_BODY_BYTES) throw new RangeError('request too large')
    chunks.push(buffer)
  }
  const value = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'))
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RangeError('request must be a plain object')
  }
  return value
}

/**
 * Resolve the `configEditor` service now, or `null` when this host cannot edit.
 *
 * Deliberately read per request: the editor service may legitimately be absent while
 * the plugin is applying (P0), and a page can load before or after it appears.
 *
 * @param {Function} editor - the resolver the route was registered with.
 * @returns {object|null} the editor service, or `null`.
 */
function resolveEditor(editor) {
  let service
  try {
    service = editor()
  } catch {
    return null
  }
  if (service === null || service === undefined || typeof service !== 'object') return null
  return service
}

/**
 * The active Loader entry whose patch row names this package, or `null`.
 *
 * The real `entries()` answers an array; an iterable is accepted too, because the
 * real service builds it from `loader.entries()` and a host version may hand back a
 * Set. An entry is matched on `options.name` only — that is the bundle/package
 * identity the page was opened for, and the patch id is not ours to assume.
 *
 * @param {object} service - the editor service.
 * @param {string} packageName - the package name to match.
 * @returns {object|null} the entry, or `null`.
 */
function findEntry(service, packageName) {
  if (typeof service.entries !== 'function') return null
  const listed = service.entries()
  const entries =
    listed === null || listed === undefined
      ? []
      : Array.isArray(listed)
        ? listed
        : Array.from(listed)
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object') continue
    if (entry.options !== null && typeof entry.options === 'object') {
      if (entry.options.name === packageName) return entry
    }
  }
  return null
}

/**
 * The raw config the running plugin actually received: the LIVE row config.
 *
 * `entry.options.config` is the composition of every layer — bundle, profile and the
 * home patch at `$DSH_HOME/cordis.patch.yml` — which is why it, and not
 * `configuration()`, is what the page must show. `configuration()` is still used, but
 * only to decide whether the editor could write that row (see {@link writableOf}).
 *
 * @param {object} entry - the current Loader entry.
 * @returns {object} the live raw config (an empty object when the row carries none).
 */
function liveRawOf(entry) {
  return isPlainObject(entry.options?.config) ? entry.options.config : {}
}

/**
 * A JSON-shaped value in a canonical form, so two config objects compare by content.
 *
 * Object key order is not part of a config's meaning, and a live composition and the
 * profile row can spell the same object with different insertion orders.
 *
 * @param {unknown} value - the value.
 * @returns {string} the canonical JSON text.
 */
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
}

/**
 * The layer comparison: whether the editor could write the row the plugin runs with.
 *
 * `configuration()` composes only the bundle and profile layers; a row config in the
 * home patch (or a command-line overlay) replaces the whole object above them, so the
 * live row differs from what the editor would write and `configEditor.edit` refuses.
 * Comparing the two up front is what turns that into an honest read-only page instead
 * of a form whose save must fail.
 *
 * @param {object} service - the editor service (already known to have `edit`).
 * @param {object} entry - the current Loader entry.
 * @param {object} live - the live raw row config.
 * @returns {{writable: boolean, reason?: string, message?: string}} the write decision.
 */
function writableOf(service, entry, live) {
  // An older service without `configuration()` cannot name a higher layer; the live
  // row is then the only truth there is, and the edit call itself stays the guard.
  if (typeof service.configuration !== 'function') return { writable: true }
  let rows
  try {
    rows = service.configuration()
  } catch {
    return { writable: true }
  }
  const row = Array.isArray(rows) ? rows.find((candidate) => candidate?.entry === entry) : undefined
  const override = row?.override
  const inherited = row?.inherited
  const expected =
    isPlainObject(override) && Object.keys(override).length > 0
      ? override
      : isPlainObject(inherited)
        ? inherited
        : {}
  if (canonicalJson(live) === canonicalJson(expected)) return { writable: true }
  return { writable: false, reason: 'layer-override', message: LAYER_OVERRIDE_MESSAGE }
}

/**
 * The one read/write decision both actions share.
 *
 * `read` projects it and `save` refuses on it, so a page that loaded a read-only row
 * cannot schedule a write for it later: the reasons a row cannot be written from the
 * page are the editor being absent or read-only, the Loader entry missing, the live
 * row failing validation, and a higher layer overriding the row. The returned `values`
 * is the normalized live config on success and the defaults on every refusal (a
 * repair-inspection view — a refusal is never saveable).
 *
 * @param {object|null} service - the resolved editor service, if any.
 * @param {object|null} entry - the current Loader entry, if any.
 * @param {string} packageName - the package name the entry is looked up by.
 * @returns {{writable: boolean, values: object, reason?: string, message?: string, readError?: string}} the decision.
 */
function rowDecision(service, entry, packageName) {
  const defaults = validateConfig(undefined)
  if (service === null) {
    return {
      writable: false,
      values: defaults,
      reason: 'editor-unavailable',
      message: EDITOR_UNAVAILABLE_MESSAGE,
    }
  }
  if (entry === null) {
    return {
      writable: false,
      values: defaults,
      reason: 'entry-missing',
      message: `no Loader entry named ${packageName} is installed in this profile`,
    }
  }
  const live = liveRawOf(entry)
  let values
  try {
    values = validateConfig(live)
  } catch (error) {
    // A stored row that does not validate must not be repaired by overwriting it with
    // the defaults this view can offer: the page is read-only until the file is fixed.
    const readError = messageOf(error)
    return {
      writable: false,
      values: defaults,
      reason: 'config-invalid',
      message: `${CONFIG_INVALID_MESSAGE}: ${readError}`,
      readError,
    }
  }
  if (typeof service.edit !== 'function') {
    return {
      writable: false,
      values,
      reason: 'editor-unavailable',
      message: EDITOR_READ_ONLY_MESSAGE,
    }
  }
  const availability = writableOf(service, entry, live)
  if (!availability.writable) {
    return {
      writable: false,
      values,
      reason: availability.reason,
      message: availability.message,
    }
  }
  return { writable: true, values }
}

/**
 * Build the read value: schema projection, effective values, defaults, last write.
 *
 * Readable in every state. Without an editor or a Loader entry the answer is the
 * schema plus defaults and a `reason`, so the page can render a read-only form with the
 * hint instead of an error. A stored raw config that no longer validates (a hand-edited
 * profile, a field the next plugin version refuses) still answers, with `readError` and
 * the defaults offered for inspection — never a failed read.
 *
 * The projection is a read of `rowDecision`, the same function `planSave` refuses on:
 * the page's writable state and the save's admission are one decision, not two reads
 * of the same state that could disagree between a poll and a click.
 *
 * @param {{editor: Function, dataRoot: string, packageName: string}} env - the route's inputs.
 * @returns {Promise<object>} the read value.
 */
async function readValue({ editor, dataRoot, packageName }) {
  const defaults = validateConfig(undefined)
  const fields = describeConfigFields()
  // A status record that cannot be read is "no last write" to a read-only view; it is
  // never a reason to fail the page that would let a user repair the config.
  const lastWrite = await readStatus(dataRoot).catch(() => null)
  const service = resolveEditor(editor)
  let entry = null
  if (service !== null) {
    try {
      entry = findEntry(service, packageName)
    } catch {
      entry = null
    }
  }
  const decision = rowDecision(service, entry, packageName)
  const value = {
    writable: decision.writable,
    entry: entry === null ? null : { id: entry.id, patchId: entry.options.id },
    fields,
    values: decision.values,
    defaults,
    lastWrite,
  }
  if (!decision.writable) {
    value.reason = decision.reason
    if (typeof decision.message === 'string') value.message = decision.message
  }
  if (typeof decision.readError === 'string') value.readError = decision.readError
  return value
}

/**
 * Validate one save, write its pending status record, and prepare the deferred edit.
 *
 * Everything that can refuse happens before the record is written. The first gate is
 * the read's own decision (`rowDecision`): a stale page can POST a save after a poll
 * that already said the row is not writable, and scheduling an edit for it would be a
 * guaranteed failed status and a wasted pending record. Then: a bad value is a 400
 * with the validator's own message, and a still-pending record is a 409 so two pages
 * cannot race the one profile row. The returned `run` is started by the handler only
 * after the reply left.
 *
 * @param {{editor: Function, dataRoot: string, packageName: string, now: Function}} env - the route's inputs.
 * @param {object} payload - the parsed request body.
 * @returns {Promise<{attempt: string, run: () => void}>} the scheduled save.
 * @throws {Error} coded refusals: `not-writable` 409 (editor absent/read-only, entry missing, invalid stored row, higher-layer override), `invalid-config` 400, `save-in-flight` 409.
 */
async function planSave({ editor, dataRoot, packageName, now }, payload) {
  const service = resolveEditor(editor)
  let entry = null
  if (service !== null) {
    try {
      entry = findEntry(service, packageName)
    } catch {
      entry = null
    }
  }
  const decision = rowDecision(service, entry, packageName)
  if (!decision.writable) {
    throw settingsError(
      'not-writable',
      decision.message ?? 'this configuration cannot be saved from the plugin page',
      409,
    )
  }
  if (!isPlainObject(payload.values)) {
    throw settingsError('invalid-config', 'save needs a complete values object', 400)
  }
  // The one validator, with every range check and the distill.route pair rule: a save
  // that would be refused at the next mount is refused here, before any write.
  let next
  try {
    next = validateConfig(payload.values)
  } catch (error) {
    throw settingsError('invalid-config', messageOf(error), 400)
  }
  const at = now()
  const current = await readStatus(dataRoot)
  // A pending record is a live edit only while it is young: a writer that died between
  // the pending write and the outcome write leaves no other trace, and refusing here
  // forever would make the page unrecoverable. An old record is stale and overwritten.
  if (current !== null && current.state === 'pending' && !pendingIsStale(current, at)) {
    throw settingsError('save-in-flight', 'another settings save is still pending', 409)
  }
  const attempt = randomUUID()
  const scheduledAt = new Date(at).toISOString()
  await writeStatus(dataRoot, {
    version: SETTINGS_STATUS_SCHEMA,
    attempt,
    state: 'pending',
    scheduledAt,
    updatedAt: scheduledAt,
    message: null,
  })
  return {
    attempt,
    run: () => {
      // Never awaited by the request: the edit remounts this plugin, and the reply is
      // already on its way. The outcome is reported through the durable record the
      // page is polling; a failure to write that record cannot fail anything already
      // committed.
      void Promise.resolve()
        .then(() => service.edit(entry, () => next))
        .then(() =>
          writeStatus(dataRoot, {
            version: SETTINGS_STATUS_SCHEMA,
            attempt,
            state: 'applied',
            scheduledAt,
            updatedAt: new Date(now()).toISOString(),
            message: null,
          }),
        )
        .catch((error) =>
          writeStatus(dataRoot, {
            version: SETTINGS_STATUS_SCHEMA,
            attempt,
            state: 'failed',
            scheduledAt,
            updatedAt: new Date(now()).toISOString(),
            message: clipMessage(messageOf(error)),
          }).catch(() => {}),
        )
    },
  }
}

/**
 * The status value the page polls: the stored record for its attempt.
 *
 * A record for another attempt (or none) answers `state:'missing'` — the page's poll
 * then times out with the restart hint rather than mistaking an old save for its own.
 *
 * @param {{dataRoot: string}} env - the route's inputs.
 * @param {object} payload - the parsed request body.
 * @returns {Promise<object>} the record, or `{attempt, state:'missing'}`.
 */
async function statusValue({ dataRoot, now }, payload) {
  const requested =
    typeof payload.attempt === 'string' && payload.attempt !== '' ? payload.attempt : null
  const record = await readStatus(dataRoot)
  if (record === null) return { attempt: requested, state: 'missing' }
  if (requested !== null && record.attempt !== requested) {
    return { attempt: requested, state: 'missing' }
  }
  // A poller must terminate even when the writer vanished: answer an over-age pending
  // record as failed with the actionable message the page renders.
  if (record.state === 'pending' && pendingIsStale(record, now())) {
    return { ...record, state: 'failed', message: STALE_PENDING_MESSAGE }
  }
  return record
}

/**
 * Whether a `pending` record is too old to still be a live edit.
 *
 * Age is measured from the last write to the record (`updatedAt`, falling back to
 * `scheduledAt`). An unparseable timestamp is treated as stale: the safe direction is to
 * let a new save proceed and to end the poll, because the alternative is a permanent
 * dead end with no visible cause.
 *
 * @param {object} record - the status record.
 * @param {number} at - the current epoch milliseconds.
 * @returns {boolean} true when the pending record is stale.
 */
function pendingIsStale(record, at) {
  const stamp = Date.parse(record?.updatedAt ?? record?.scheduledAt ?? '')
  if (!Number.isFinite(stamp)) return true
  return at - stamp >= SETTINGS_PENDING_TTL_MS
}

/**
 * Read the durable status record, or `null` when there is none it can trust.
 *
 * A record that is absent, corrupt, from another schema or from another plugin's
 * write is "no record": the page's poll treats that as `missing`, and a save treats
 * it as "nothing pending" rather than as a permanent 409.
 *
 * @param {string} dataRoot - the plugin's private data root.
 * @returns {Promise<object|null>} the bounded record.
 * @throws {Error} when the file exists but cannot be read for a reason other than absence.
 */
async function readStatus(dataRoot) {
  let raw
  try {
    raw = await fs.readFile(join(dataRoot, SETTINGS_STATUS_FILE), 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isPlainObject(parsed)) return null
  if (parsed.version !== SETTINGS_STATUS_SCHEMA) return null
  if (!SETTINGS_STATES.includes(parsed.state)) return null
  return {
    attempt: typeof parsed.attempt === 'string' ? parsed.attempt : null,
    state: parsed.state,
    scheduledAt: typeof parsed.scheduledAt === 'string' ? parsed.scheduledAt : null,
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
    message: typeof parsed.message === 'string' ? clipMessage(parsed.message) : null,
  }
}

/**
 * Replace the status record atomically: a temporary file, an fsynced rename, 0600/0700.
 *
 * The record is private plugin state under the data root, like the proposal store, so
 * it is written with the same "temporary → fsync → rename → directory fsync" primitive
 * every durable writer in this repository uses.
 *
 * @param {string} dataRoot - the plugin's private data root.
 * @param {object} record - the record to persist.
 * @returns {Promise<void>} resolves once the rename is durable.
 */
async function writeStatus(dataRoot, record) {
  const path = join(dataRoot, SETTINGS_STATUS_FILE)
  const directory = dirname(path)
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  await fs.chmod(directory, 0o700)
  const text = `${JSON.stringify(record, null, 2)}\n`
  const temporary = join(directory, `.${SETTINGS_STATUS_FILE}.${randomUUID()}.tmp`)
  let handle = null
  try {
    handle = await fs.open(temporary, 'wx', 0o600)
    await handle.writeFile(text, 'utf8')
    await handle.sync()
    await handle.close()
    handle = null
    await renameWithRetry(temporary, path)
  } finally {
    try {
      await handle?.close()
    } finally {
      await fs.rm(temporary, { force: true })
    }
  }
  await fsyncDirectory(directory)
}

/** One coded refusal the request handler maps onto an HTTP status. */
function settingsError(code, message, status) {
  const error = new Error(message)
  error.code = code
  error.status = status
  return error
}

/** A bounded message for status records and the wire. */
function clipMessage(value) {
  const text = typeof value === 'string' ? value : 'the settings edit failed'
  const points = [...text.trim()]
  if (points.length === 0) return 'the settings edit failed'
  if (points.length <= MAX_STATUS_MESSAGE_CHARS) return points.join('')
  return points.slice(0, MAX_STATUS_MESSAGE_CHARS).join('')
}

/** One error's display message, never a stack or an object's JSON. */
function messageOf(error) {
  return typeof error?.message === 'string' && error.message.trim() !== ''
    ? error.message
    : 'the settings edit failed'
}

/** Whether a value is a plain object (`null`/arrays excluded). */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
