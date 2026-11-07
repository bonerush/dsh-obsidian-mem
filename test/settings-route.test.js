// Task 6: the host half of the plugin-settings feature.
//
// The route is the only browser surface that can read and write the *profile config
// row*; it never touches a session or a vault. These cases mirror
// `test/panel-route.test.js`'s harness — a fake `webServer` route table, a real
// loopback HTTP server and `fetch` — because the fence, the body bound and the
// response envelope are HTTP behaviour, not helper behaviour. The `configEditor`
// service is a fake too: the real one persists YAML and remounts the plugin, which is
// exactly what the route defers to and what these cases assert it defers to.
//
// What is pinned here is the whole host contract:
//   * `read` resolves the Loader entry and the editor *at request time*, projects
//     `describeConfigFields()`, and answers defaults-filled `values` without writing;
//   * `save` validates with `validateConfig` (400, nothing written), rejects a
//     concurrent save (409), writes a `pending` status record, then schedules exactly
//     one `editor.edit` and replies *before* that edit runs;
//   * the edit's outcome rewrites the record `applied` / `failed`;
//   * `status` answers the record for the polling attempt;
//   * the fence refuses a missing `x-obsidian-mem-panel` header or a non-JSON body,
//     and the body bound refuses an oversized payload;
//   * `describeConfigFields()` covers exactly the `Config` leaves minus `enabled`.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { CONFIG_RANGES, describeConfigFields, validateConfig } from '../lib/config.js'
import { PACKAGE_NAME } from '../lib/index.js'
import { PANEL_HEADER, PANEL_HEADER_VALUE } from '../lib/panel-route.js'
import { registerSettingsRoute, SETTINGS_PENDING_TTL_MS } from '../lib/settings-route.js'

/** The row id a profile patch uses (`entry.options.id`, the patch id). */
const PATCH_ID = 'obsidian-mem-profile-row'
/** One fixed clock, so every status timestamp in a case is the same timestamp. */
const FIXED_NOW = Date.parse('2026-11-07T05:00:00.000Z')
/** The route's one path. */
const ROUTE_PATH = '/obsidian-mem/settings'

/** One fake Loader entry, as the real `configEditor.entries()` yields it. */
function entryOf({ config = {}, name = PACKAGE_NAME, id = 'loader-entry-7' } = {}) {
  return { id, options: { id: PATCH_ID, name, config }, fiber: {} }
}

/**
 * A fake `configEditor`: the three methods the route may call, all recorded.
 *
 * `edit` defaults to the real lifecycle's observable half — it derives `next` from
 * the change callback and resolves — and a case may replace it with a deferred or a
 * rejection. The route must never call anything the real service lacks.
 */
function fakeEditor({ entries = [entryOf()], configuration = null, edit = null } = {}) {
  const calls = { entries: 0, configurations: 0, edits: [] }
  // The real `configuration()` answers rows holding the *same* entry objects as
  // `entries()` (the service maps its own list), so a hand-written row is bound back
  // to the live entry by package name — that identity is what the route matches on.
  const rows = (
    configuration ??
    entries.map((entry) => ({
      entry,
      inherited: entry.options.config ?? {},
      override: {},
    }))
  ).map((row) => ({
    ...row,
    entry:
      entries.find((entry) => entry.options?.name === row?.entry?.options?.name) ??
      row?.entry ??
      null,
  }))
  const service = {
    entries() {
      calls.entries += 1
      return entries
    },
    configuration() {
      calls.configurations += 1
      return rows
    },
    async edit(entry, change) {
      calls.edits.push({ entry, change })
      if (edit !== null) return edit(entry, change, rows)
      return change(
        entry.options.config ?? {},
        rows.find((row) => row.entry === entry)?.inherited ?? {},
      )
    },
    rows,
  }
  return { service, calls, rows, entries }
}

/** One harness: a fake webServer, a real loopback HTTP server and a request helper. */
async function harness(t, { editor = () => null, now = () => FIXED_NOW } = {}) {
  const dataRoot = await mkdtemp(join(tmpdir(), 'obsidian-mem-settings-'))
  t.after(() => rm(dataRoot, { recursive: true, force: true }))
  const routes = new Map()
  const dispose = registerSettingsRoute(
    {
      webServer: {
        register: (route) => {
          routes.set(route.path, route)
          return () => routes.delete(route.path)
        },
      },
    },
    { editor, dataRoot, packageName: PACKAGE_NAME, now },
  )
  t.after(dispose)
  const server = createServer((request, response) => {
    const route = routes.get(request.url)
    if (route === undefined) {
      response.writeHead(404)
      response.end('missing route')
      return
    }
    void route.handler(request, response)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => server.close())
  const origin = 'http://127.0.0.1:' + server.address().port
  const request = async (body, headers) => {
    const response = await fetch(origin + ROUTE_PATH, {
      method: 'POST',
      headers,
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
    const text = await response.text()
    let parsed = null
    try {
      parsed = JSON.parse(text)
    } catch {
      /* an unregistered route's plain-text body stays null for the assertion */
    }
    return { status: response.status, bytes: Buffer.byteLength(text, 'utf8'), body: parsed }
  }
  /** A normal fenced request: JSON body, the panel's own header. */
  const post = (body, headers = {}) =>
    request(body, {
      'content-type': 'application/json',
      [PANEL_HEADER]: PANEL_HEADER_VALUE,
      ...headers,
    })
  /** A fenced request with a raw body string (oversized / malformed payloads). */
  const postRaw = (body, headers = {}) => post(body, headers)
  /** A request without the panel header, whatever the body is. */
  const unfenced = (body, headers = {}) =>
    request(body, { 'content-type': 'application/json', ...headers })
  const get = (headers = {}) => fetch(origin + ROUTE_PATH, { headers })
  return {
    dataRoot,
    origin,
    routes,
    post,
    postRaw,
    unfenced,
    get,
    statusPath: join(dataRoot, 'settings-write.json'),
  }
}

/** Read the persisted status record, or `null` when nothing was written. */
async function storedStatus(root) {
  try {
    return JSON.parse(await readFile(join(root, 'settings-write.json'), 'utf8'))
  } catch {
    return null
  }
}

/** Wait for an asynchronous condition, up to a bound; resolves the value or `null`. */
async function until(condition, { timeoutMs = 4000, stepMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await condition()
    if (value) return value
    if (Date.now() > deadline) return null
    await new Promise((resolve) => setTimeout(resolve, stepMs))
  }
}

/** A deferred a case can release, so `pending → applied` is deterministic. */
function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

/** Every leaf path of an already-validated config object, in walk order. */
function leafPaths(value, path = []) {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return Object.entries(value).flatMap(([key, child]) => leafPaths(child, [...path, key]))
  }
  return [path]
}

// ---------------------------------------------------------------------------
// describeConfigFields: the client's single source
// ---------------------------------------------------------------------------

test('the route is registered for this package, pinned against package.json', async () => {
  // The Loader row is found by `options.name`, so the constant the assembly passes
  // and the package's own name cannot drift apart.
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(PACKAGE_NAME, manifest.name)
})

test('describeConfigFields covers exactly the Config leaves minus enabled', () => {
  const defaults = validateConfig(undefined)
  const fields = describeConfigFields()
  const expected = leafPaths(defaults).filter((path) => path.join('.') !== 'enabled')
  assert.deepEqual(
    fields.map((field) => field.path),
    expected.map((path) => path.join('.')),
    'every Config leaf is projected as its dotted path, in schema order, and enabled is the only omission',
  )
  for (const field of fields) {
    // The client renders by dotted `path`; the split form rides beside it so no
    // second source has to re-derive the path.
    assert.equal(typeof field.path, 'string')
    assert.deepEqual(field.segments, field.path.split('.'), field.path + ' segments')
    assert.equal(typeof field.type, 'string')
    // The default the schema states is the value validateConfig(undefined) fills.
    const filled = field.segments.reduce((node, key) => node[key], defaults)
    assert.deepEqual(field.default, filled, field.path + ' default')
  }
})

test('describeConfigFields projects the union and array shapes the client renders', () => {
  const fields = describeConfigFields()
  const byPath = Object.fromEntries(fields.map((field) => [field.path, field]))
  assert.deepEqual(byPath['briefConventionMode'], {
    path: 'briefConventionMode',
    segments: ['briefConventionMode'],
    type: 'enum',
    default: 'summary',
    enum: ['summary', 'flat'],
  })
  assert.deepEqual(byPath.indexBackend.enum, ['auto', 'sqlite', 'scan'])
  assert.equal(byPath.indexBackend.default, 'auto')
  assert.deepEqual(byPath.retrievalEngine.enum, ['lexical', 'sparse', 'hybrid'])
  assert.deepEqual(byPath.ignoreGlobs, {
    path: 'ignoreGlobs',
    segments: ['ignoreGlobs'],
    type: 'stringArray',
    default: [],
  })
  // The nested leaves carry the client's own split form: the form reads and writes
  // them through `path.split('.')`, which is the contract the landed client uses.
  assert.equal(byPath['distill.provider'].path, 'distill.provider')
  assert.deepEqual(byPath['distill.provider'].segments, ['distill', 'provider'])
  assert.equal(byPath['retrievalProvider.endpoint'].type, 'string')
  // Whole-number fields are integers with their shared bounds projected, so the form
  // can validate inline instead of learning the value was invalid only after a save.
  assert.equal(byPath.briefBudgetChars.type, 'integer')
  assert.equal(byPath.briefBudgetChars.integer, true)
  assert.equal(byPath.briefBudgetChars.min, 256)
  assert.equal(byPath.briefBudgetChars.max, 20000)
  assert.equal(byPath.autoCapture.type, 'boolean')
  assert.equal(byPath.vaultPath.type, 'string')
  // `enabled` is the plugin page's own switch and must not appear anywhere.
  assert.equal(
    fields.some((field) => field.path === 'enabled'),
    false,
  )
  assert.equal(
    fields.some((field) => field.segments?.[0] === 'enabled'),
    false,
  )
})

// ---------------------------------------------------------------------------
// read
// ---------------------------------------------------------------------------

test('read answers the live, default-filled values, the schema projection and writes nothing', async (t) => {
  // The live row config and the layer the editor can write agree: this is the normal,
  // writable shape (an explicit profile override or the inherited composed row).
  const live = { hotCapacityChars: 1234, vaultPath: '/tmp/audit-vault' }
  const entry = entryOf({ config: live })
  const fake = fakeEditor({
    entries: [entry],
    configuration: [{ entry, inherited: {}, override: live }],
  })
  const h = await harness(t, { editor: () => fake.service })
  assert.ok(h.routes.has(ROUTE_PATH), 'the exact route is registered')
  const before = await readdir(h.dataRoot)
  const result = await h.post({ action: 'read' })
  assert.equal(result.status, 200, JSON.stringify(result.body))
  assert.equal(result.body.ok, true)
  const value = result.body.value
  assert.equal(value.writable, true)
  assert.deepEqual(value.entry, { id: 'loader-entry-7', patchId: PATCH_ID })
  assert.equal(Array.isArray(value.fields), true)
  assert.deepEqual(value.defaults, validateConfig(undefined))
  // The effective raw config is the profile override when one exists.
  assert.equal(value.values.hotCapacityChars, 1234)
  assert.equal(value.values.vaultPath, '/tmp/audit-vault')
  assert.equal(value.values.autoCapture, true, 'untouched fields are default-filled')
  assert.equal(value.lastWrite, null)
  assert.equal('reason' in value, false)
  assert.deepEqual(await readdir(h.dataRoot), before, 'a read wrote nothing')
  // A read costs one entries() and one configuration() lookup.
  assert.equal(fake.calls.entries, 1)
  assert.equal(fake.calls.configurations, 1)
})

test('C1: a home-layer override shows the live values and is read-only', async (t) => {
  // `$DSH_HOME/cordis.patch.yml` outranks the profile row and is invisible to
  // `editor.configuration()`, so a read that trusted the layer would show defaults and
  // every save would be refused by the editor. The live row config is the truth.
  const live = { vaultPath: '/real/vault', hotCapacityChars: 1234 }
  const entry = entryOf({ config: live })
  const fake = fakeEditor({
    entries: [entry],
    configuration: [{ entry, inherited: {}, override: {} }],
  })
  const h = await harness(t, { editor: () => fake.service })
  const result = await h.post({ action: 'read' })
  assert.equal(result.status, 200, JSON.stringify(result.body))
  const value = result.body.value
  assert.equal(value.writable, false)
  assert.equal(value.reason, 'layer-override')
  assert.match(value.message, /\$DSH_HOME\/cordis\.patch\.yml/u, 'the hint names the home patch')
  assert.equal(value.message.includes(h.dataRoot), false, 'no absolute path leaks to the wire')
  // The values are the composition the plugin actually runs with, not defaults.
  assert.equal(value.values.vaultPath, '/real/vault')
  assert.equal(value.values.hotCapacityChars, 1234)
  assert.equal(value.readError, undefined)
})

test('read is writable when the live config is exactly the layer the editor can write', async (t) => {
  // No home-layer override: the live row is the inherited/override row the editor
  // composes, and the form must be saveable.
  const live = { recallBudgetChars: 777 }
  const entry = entryOf({ config: live })
  const fake = fakeEditor({
    entries: [entry],
    configuration: [{ entry, inherited: live, override: {} }],
  })
  const h = await harness(t, { editor: () => fake.service })
  const result = await h.post({ action: 'read' })
  assert.equal(result.status, 200)
  assert.equal(result.body.value.writable, true)
  assert.equal('reason' in result.body.value, false)
  assert.equal(result.body.value.values.recallBudgetChars, 777)
})

test('read resolves the editor at request time, not at registration', async (t) => {
  let current = null
  const h = await harness(t, { editor: () => current })
  const before = await h.post({ action: 'read' })
  assert.equal(before.body.value.writable, false)
  assert.equal(before.body.value.reason, 'editor-unavailable')
  current = fakeEditor().service
  const after = await h.post({ action: 'read' })
  assert.equal(after.body.value.writable, true)
  assert.deepEqual(after.body.value.entry, { id: 'loader-entry-7', patchId: PATCH_ID })
})

test('read is readable without an editor or an entry, and says why', async (t) => {
  const absent = await harness(t, { editor: () => null })
  const noEditor = await absent.post({ action: 'read' })
  assert.equal(noEditor.status, 200)
  assert.equal(noEditor.body.value.writable, false)
  assert.equal(noEditor.body.value.reason, 'editor-unavailable')
  assert.deepEqual(noEditor.body.value.values, validateConfig(undefined))
  assert.equal(noEditor.body.value.fields.length > 0, true)

  const empty = fakeEditor({ entries: [] })
  const missing = await harness(t, { editor: () => empty.service })
  const noEntry = await missing.post({ action: 'read' })
  assert.equal(noEntry.status, 200)
  assert.equal(noEntry.body.value.writable, false)
  assert.equal(noEntry.body.value.reason, 'entry-missing')
  assert.equal(noEntry.body.value.entry, null)
})

test('I1: a stored raw config that fails validateConfig is read-only, not silently saveable', async (t) => {
  // Answering defaults *and* keeping the form saveable would replace the whole stored
  // row with defaults the first time a user "repairs" one field. The page must not be
  // able to save until the profile patch itself is fixed.
  const entry = entryOf({ config: { hotCapacityChars: 1 } })
  const fake = fakeEditor({
    entries: [entry],
    configuration: [{ entry, inherited: { hotCapacityChars: 1 }, override: {} }],
  })
  const h = await harness(t, { editor: () => fake.service })
  const result = await h.post({ action: 'read' })
  assert.equal(result.status, 200, JSON.stringify(result.body))
  const value = result.body.value
  assert.equal(value.writable, false)
  assert.equal(value.reason, 'config-invalid')
  assert.equal(typeof value.readError, 'string')
  assert.match(value.readError, /hotCapacityChars/u)
  assert.deepEqual(value.values, validateConfig(undefined), 'defaults are offered for inspection')
})

// ---------------------------------------------------------------------------
// save
// ---------------------------------------------------------------------------

test('save with invalid values is a 400 and schedules nothing', async (t) => {
  const fake = fakeEditor()
  const h = await harness(t, { editor: () => fake.service })
  const result = await h.post({
    action: 'save',
    values: { ...validateConfig(undefined), hotCapacityChars: 1 },
  })
  assert.equal(result.status, 400)
  assert.equal(result.body.ok, false)
  assert.equal(result.body.error.code, 'invalid-config')
  assert.match(result.body.error.message, /hotCapacityChars/u)
  assert.equal(fake.calls.edits.length, 0, 'nothing was scheduled')
  assert.equal(await storedStatus(h.dataRoot), null, 'nothing was written')
})

test('save schedules exactly one editor.edit and the record goes pending → applied', async (t) => {
  const gate = deferred()
  const fake = fakeEditor({ edit: () => gate.promise })
  const h = await harness(t, { editor: () => fake.service })
  const values = { ...validateConfig(undefined), hotCapacityChars: 4321, autoCapture: false }
  const result = await h.post({ action: 'save', values })
  assert.equal(result.status, 200, JSON.stringify(result.body))
  assert.equal(result.body.ok, true)
  assert.equal(result.body.value.scheduled, true)
  assert.match(result.body.value.attempt, /^[0-9a-f-]{36}$/u)
  const attempt = result.body.value.attempt

  // The response left before the edit ran: the pending record is already durable,
  // and the (still gated) edit is the only scheduled work.
  assert.equal(fake.calls.edits.length, 1)
  const pending = await storedStatus(h.dataRoot)
  assert.equal(pending.state, 'pending')
  assert.equal(pending.attempt, attempt)
  assert.equal(pending.scheduledAt, new Date(FIXED_NOW).toISOString())
  const statusWhilePending = await h.post({ action: 'status', attempt })
  assert.equal(statusWhilePending.status, 200)
  assert.equal(statusWhilePending.body.value.state, 'pending')

  // The editor's change callback derives the complete next raw config.
  const edit = fake.calls.edits[0]
  assert.equal(edit.entry, fake.entries[0], 'the live entry object is passed through')
  assert.deepEqual(edit.change({}, {}), validateConfig(values))

  gate.resolve()
  const applied = await until(async () => {
    const record = await storedStatus(h.dataRoot)
    return record?.state === 'applied' ? record : null
  })
  assert.notEqual(applied, null, 'the edit outcome rewrote the record')
  assert.equal(applied.attempt, attempt)
  assert.equal(applied.message, null)
  const status = await h.post({ action: 'status', attempt })
  assert.equal(status.body.value.state, 'applied')
  // The page re-reads after `applied`; the last write rides that read.
  const reread = await h.post({ action: 'read' })
  assert.equal(reread.body.value.lastWrite.state, 'applied')
})

test('a failed edit rewrites the record failed with the editor message', async (t) => {
  const fake = fakeEditor({
    edit: async () => {
      throw new Error('Configuration for "obsidian-mem" is overridden by a home patch')
    },
  })
  const h = await harness(t, { editor: () => fake.service })
  const result = await h.post({ action: 'save', values: validateConfig(undefined) })
  assert.equal(result.status, 200)
  const attempt = result.body.value.attempt
  const failed = await until(async () => {
    const record = await storedStatus(h.dataRoot)
    return record?.state === 'failed' ? record : null
  })
  assert.notEqual(failed, null)
  assert.equal(failed.attempt, attempt)
  assert.match(failed.message, /home patch/u)
  const status = await h.post({ action: 'status', attempt })
  assert.equal(status.body.value.state, 'failed')
  assert.match(status.body.value.message, /home patch/u)
})

test('a failed edit clears the in-flight state so the next save is accepted', async (t) => {
  // The in-flight guard is the durable `pending` record, not a module-level flag:
  // the edit chain's `.catch` rewrites it `failed`, so a refusal can never outlive
  // the edit it belongs to. This pins that recovery after a failed save.
  let fail = true
  const fake = fakeEditor({
    edit: async () => {
      if (fail) throw new Error('Configuration entry is no longer available')
    },
  })
  const h = await harness(t, { editor: () => fake.service })
  const first = await h.post({ action: 'save', values: validateConfig(undefined) })
  assert.equal(first.status, 200)
  const failed = await until(async () => {
    const record = await storedStatus(h.dataRoot)
    return record?.state === 'failed' ? record : null
  })
  assert.notEqual(failed, null)

  fail = false
  const second = await h.post({ action: 'save', values: validateConfig(undefined) })
  assert.equal(second.status, 200, JSON.stringify(second.body))
  assert.notEqual(second.body.value.attempt, first.body.value.attempt)
  const applied = await until(async () => {
    const record = await storedStatus(h.dataRoot)
    return record?.state === 'applied' ? record : null
  })
  assert.notEqual(applied, null, 'the retry after a failure settles applied')
  assert.equal(applied.attempt, second.body.value.attempt)
})

test('a second save while one is pending is refused 409 save-in-flight', async (t) => {
  const fake = fakeEditor({ edit: () => new Promise(() => {}) })
  const h = await harness(t, { editor: () => fake.service })
  const first = await h.post({ action: 'save', values: validateConfig(undefined) })
  assert.equal(first.status, 200)
  const second = await h.post({ action: 'save', values: validateConfig(undefined) })
  assert.equal(second.status, 409)
  assert.equal(second.body.error.code, 'save-in-flight')
  assert.equal(fake.calls.edits.length, 1, 'the refused save scheduled nothing')
})

test('N1: save is refused 409 not-writable whenever the read says the row is read-only', async (t) => {
  // A stale page can POST a save after a read that already said "not writable". The
  // save must run the *same* decision and refuse before it writes anything — for every
  // reason, not just the layer override: a scheduled edit for a row the editor cannot
  // write is a guaranteed failed status and a wasted pending record.

  // editor absent
  const absent = await harness(t, { editor: () => null })
  const noEditor = await absent.post({ action: 'save', values: validateConfig(undefined) })
  assert.equal(noEditor.status, 409)
  assert.equal(noEditor.body.error.code, 'not-writable')
  assert.match(noEditor.body.error.message, /editor/u)
  assert.equal(await storedStatus(absent.dataRoot), null)

  // entry missing
  const empty = fakeEditor({ entries: [] })
  const missing = await harness(t, { editor: () => empty.service })
  const noEntry = await missing.post({ action: 'save', values: validateConfig(undefined) })
  assert.equal(noEntry.status, 409)
  assert.equal(noEntry.body.error.code, 'not-writable')
  assert.match(noEntry.body.error.message, /Loader entry/u)
  assert.equal(empty.calls.edits.length, 0)
  assert.equal(await storedStatus(missing.dataRoot), null)

  // config-invalid stored row
  const invalidEntry = entryOf({ config: { hotCapacityChars: 1 } })
  const invalid = fakeEditor({
    entries: [invalidEntry],
    configuration: [{ entry: invalidEntry, inherited: { hotCapacityChars: 1 }, override: {} }],
  })
  const invalidBed = await harness(t, { editor: () => invalid.service })
  const invalidSave = await invalidBed.post({ action: 'save', values: validateConfig(undefined) })
  assert.equal(invalidSave.status, 409)
  assert.equal(invalidSave.body.error.code, 'not-writable')
  assert.match(
    invalidSave.body.error.message,
    /hotCapacityChars/u,
    'the validator sentence is shown',
  )
  assert.equal(invalid.calls.edits.length, 0)
  assert.equal(await storedStatus(invalidBed.dataRoot), null, 'nothing was written')

  // home-layer override row
  const live = { vaultPath: '/real/vault' }
  const homeEntry = entryOf({ config: live })
  const home = fakeEditor({
    entries: [homeEntry],
    configuration: [{ entry: homeEntry, inherited: {}, override: {} }],
  })
  const homeBed = await harness(t, { editor: () => home.service })
  const homeSave = await homeBed.post({ action: 'save', values: validateConfig(undefined) })
  assert.equal(homeSave.status, 409)
  assert.equal(homeSave.body.error.code, 'not-writable')
  assert.match(homeSave.body.error.message, /\$DSH_HOME\/cordis\.patch\.yml/u)
  assert.equal(home.calls.edits.length, 0)
  assert.equal(await storedStatus(homeBed.dataRoot), null)
})

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

test('status answers the stored record only for the polling attempt', async (t) => {
  const gate = deferred()
  const fake = fakeEditor({ edit: () => gate.promise })
  const h = await harness(t, { editor: () => fake.service })
  const saved = await h.post({ action: 'save', values: validateConfig(undefined) })
  const attempt = saved.body.value.attempt
  const missing = await h.post({ action: 'status', attempt: 'f'.repeat(36) })
  assert.equal(missing.status, 200)
  assert.equal(missing.body.value.state, 'missing')
  const current = await h.post({ action: 'status', attempt })
  assert.equal(current.body.value.attempt, attempt)
  assert.equal(current.body.value.state, 'pending')
  gate.resolve()
  await until(async () => (await storedStatus(h.dataRoot))?.state === 'applied')
})

// ---------------------------------------------------------------------------
// fence, bounds and method
// ---------------------------------------------------------------------------

test('the fence refuses a missing panel header and a non-JSON content type', async (t) => {
  const fake = fakeEditor()
  const h = await harness(t, { editor: () => fake.service })
  const noHeader = await h.unfenced({ action: 'read' })
  assert.equal(noHeader.status, 403)
  assert.equal(noHeader.body.error.code, 'forbidden')
  const wrongType = await h.post(
    { action: 'read' },
    { 'content-type': 'text/plain; charset=utf-8' },
  )
  assert.equal(wrongType.status, 400)
  assert.equal(wrongType.body.error.code, 'bad-request')
  // The same body with the proof and a JSON type answers normally.
  const allowed = await h.post({ action: 'read' })
  assert.equal(allowed.status, 200)
})

test('an oversized body is refused before it is parsed and nothing is scheduled', async (t) => {
  const fake = fakeEditor()
  const h = await harness(t, { editor: () => fake.service })
  const oversized = JSON.stringify({
    action: 'save',
    values: validateConfig(undefined),
    pad: 'x'.repeat(70 * 1024),
  })
  const result = await h.postRaw(oversized)
  assert.equal(result.status, 400)
  assert.equal(result.body.error.code, 'bad-request')
  assert.equal(fake.calls.edits.length, 0)
  assert.equal(await storedStatus(h.dataRoot), null)
})

test('unknown actions, malformed JSON and non-object bodies are 400', async (t) => {
  const fake = fakeEditor()
  const h = await harness(t, { editor: () => fake.service })
  const unknown = await h.post({ action: 'apply' })
  assert.equal(unknown.status, 400)
  assert.equal(unknown.body.error.code, 'bad-request')
  const array = await h.post('[1,2,3]')
  assert.equal(array.status, 400)
  const malformed = await h.postRaw('{not json')
  assert.equal(malformed.status, 400)
  const noAction = await h.post({})
  assert.equal(noAction.status, 400)
})

test('GET answers the same read value, and other methods are refused', async (t) => {
  const fake = fakeEditor()
  const h = await harness(t, { editor: () => fake.service })
  const read = await h.get()
  assert.equal(read.status, 200)
  const body = await read.json()
  assert.equal(body.ok, true)
  assert.equal(body.value.writable, true)
  const foreign = await h.get({ origin: 'https://evil.example' })
  assert.equal(foreign.status, 403)
  const put = await fetch(h.origin + ROUTE_PATH, { method: 'PUT' })
  assert.equal(put.status, 405)
})

// ---------------------------------------------------------------------------
// I2: a stale pending record must not wedge saves forever
// ---------------------------------------------------------------------------

test('I2: status answers failed for a pending record older than the TTL', async (t) => {
  let clock = FIXED_NOW
  const gate = deferred()
  const fake = fakeEditor({ edit: () => gate.promise })
  const h = await harness(t, { editor: () => fake.service, now: () => clock })
  const saved = await h.post({ action: 'save', values: validateConfig(undefined) })
  const attempt = saved.body.value.attempt
  // Inside the window the record is genuinely in flight; the poller keeps waiting.
  clock = FIXED_NOW + SETTINGS_PENDING_TTL_MS - 1
  const pending = await h.post({ action: 'status', attempt })
  assert.equal(pending.body.value.state, 'pending')
  // Past it the poller must terminate with an actionable answer instead of spinning.
  clock = FIXED_NOW + SETTINGS_PENDING_TTL_MS + 1
  const stale = await h.post({ action: 'status', attempt })
  assert.equal(stale.body.value.state, 'failed')
  assert.equal(stale.body.value.attempt, attempt)
  assert.match(stale.body.value.message, /did not finish/u)
  assert.match(stale.body.value.message, /newer save may be attempted/u)
  gate.resolve()
})

test('I2: a stale pending record does not wedge the next save', async (t) => {
  let clock = FIXED_NOW
  const gate = deferred()
  const fake = fakeEditor({ edit: () => gate.promise })
  const h = await harness(t, { editor: () => fake.service, now: () => clock })
  const first = await h.post({ action: 'save', values: validateConfig(undefined) })
  assert.equal(first.status, 200)
  // A fresh pending record still refuses a concurrent save...
  clock = FIXED_NOW + 10
  const refused = await h.post({ action: 'save', values: validateConfig(undefined) })
  assert.equal(refused.status, 409)
  assert.equal(refused.body.error.code, 'save-in-flight')
  // ...but a record older than the TTL is treated as stale and overwritten.
  clock = FIXED_NOW + SETTINGS_PENDING_TTL_MS + 1
  const second = await h.post({ action: 'save', values: validateConfig(undefined) })
  assert.equal(second.status, 200, JSON.stringify(second.body))
  assert.notEqual(second.body.value.attempt, first.body.value.attempt)
  const record = await storedStatus(h.dataRoot)
  assert.equal(record.state, 'pending')
  assert.equal(record.attempt, second.body.value.attempt)
  gate.resolve()
})

// ---------------------------------------------------------------------------
// I3: one bounds table, projected for inline validation
// ---------------------------------------------------------------------------

/** Read one dotted path out of a nested config object (test helper). */
function getConfigPath(target, path) {
  let node = target
  for (const key of path.split('.')) node = node?.[key]
  return node
}

/** Write one dotted path into a nested config object (test helper). */
function setConfigPath(target, path, value) {
  const keys = path.split('.')
  let node = target
  for (const key of keys.slice(0, -1)) node = node[key]
  node[keys[keys.length - 1]] = value
}

test('I3: CONFIG_RANGES is the one bounds table for every validated numeric field', () => {
  assert.deepEqual(CONFIG_RANGES, {
    briefBudgetChars: { min: 256, max: 20000, integer: true },
    recallBudgetChars: { min: 256, max: 20000, integer: true },
    hotCapacityChars: { min: 1024, max: 50000, integer: true },
    captureIdleMs: { min: 1000, max: 3600000, integer: true },
    'distill.maxItems': { min: 1, max: 50, integer: true },
    'distill.maxInputChars': { min: 256, max: 100000, integer: true },
    'distill.maxOutputTokens': { min: 128, max: 32000, integer: true },
    'distill.timeoutMs': { min: 1000, max: 300000, integer: true },
    'distill.maxRetries': { min: 0, max: 10, integer: true },
    hotArchiveRatio: { exclusiveMin: 0, exclusiveMax: 1 },
    'distill.minConfidence': { min: 0, max: 1 },
  })
  assert.equal(Object.isFrozen(CONFIG_RANGES), true)
})

test('I3: validateConfig enforces the table (bounds, integer, exclusivity) with the path as its message', () => {
  const defaults = validateConfig(undefined)
  const mutate = (path, value) => {
    const next = structuredClone(defaults)
    setConfigPath(next, path, value)
    return next
  }
  for (const [path, range] of Object.entries(CONFIG_RANGES)) {
    if (range.integer === true) {
      assert.equal(getConfigPath(validateConfig(mutate(path, range.min)), path), range.min)
      assert.equal(getConfigPath(validateConfig(mutate(path, range.max)), path), range.max)
      for (const bad of [range.min - 1, range.max + 1, range.min + 0.5]) {
        assert.throws(
          () => validateConfig(mutate(path, bad)),
          (error) => {
            assert.equal(error.name, 'RangeError', `${path}=${bad}`)
            assert.equal(error.message, path, `${path}=${bad}`)
            return true
          },
          `${path}=${bad}`,
        )
      }
    } else if (range.exclusiveMin !== undefined || range.exclusiveMax !== undefined) {
      for (const bad of [range.exclusiveMin, range.exclusiveMax]) {
        assert.throws(() => validateConfig(mutate(path, bad)), RangeError, `${path}=${bad}`)
      }
      assert.equal(getConfigPath(validateConfig(mutate(path, 0.5)), path), 0.5)
    } else {
      for (const bad of [range.min - 1, range.max + 1]) {
        assert.throws(() => validateConfig(mutate(path, bad)), RangeError, `${path}=${bad}`)
      }
      assert.equal(getConfigPath(validateConfig(mutate(path, range.min)), path), range.min)
      assert.equal(getConfigPath(validateConfig(mutate(path, range.max)), path), range.max)
    }
  }
})

test('I3: describeConfigFields carries the bounds so the client can validate inline', () => {
  const fields = Object.fromEntries(describeConfigFields().map((field) => [field.path, field]))
  for (const [path, range] of Object.entries(CONFIG_RANGES)) {
    const field = fields[path]
    assert.notEqual(field, undefined, path + ' is projected')
    if (range.integer === true) {
      assert.equal(field.type, 'integer', path)
      assert.equal(field.integer, true, path)
    }
    if (range.exclusiveMin !== undefined) {
      assert.equal(field.min, range.exclusiveMin, path + ' min value')
      assert.equal(field.exclusiveMin, true, path + ' exclusive flag')
    } else if (range.min !== undefined) {
      assert.equal(field.min, range.min, path + ' min')
      assert.equal(field.exclusiveMin, undefined, path + ' inclusive min')
    }
    if (range.exclusiveMax !== undefined) {
      assert.equal(field.max, range.exclusiveMax, path + ' max value')
      assert.equal(field.exclusiveMax, true, path + ' exclusive flag')
    } else if (range.max !== undefined) {
      assert.equal(field.max, range.max, path + ' max')
      assert.equal(field.exclusiveMax, undefined, path + ' inclusive max')
    }
  }
})
