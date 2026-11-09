#!/usr/bin/env node
// Offline self-test for the loopback embedding gateway.
//
// Everything here is local: a stub OpenAI-compatible upstream answers on a
// throwaway 127.0.0.1 port, and the shim is started in-process against it. No
// network, no key, no dependency. The last group hooks the real plugin contract
// (lib/retrieval-provider.js) up to the shim, so the wire format is checked by
// the authority itself rather than by a copy of it.
//
// Run:  node tools/embed-gateway/smoke.mjs
import { createServer } from 'node:http'
import { loadConfig, startShim, QUERY_INSTRUCTION } from './shim.mjs'
import { createRetrievalProvider, RetrievalProviderError } from '../../lib/retrieval-provider.js'

const failures = []
const passes = []
let group = ''

function section(name) {
  group = name
  process.stdout.write('\n' + name + '\n')
}

function ok(name) {
  passes.push(group + ' :: ' + name)
  process.stdout.write('  PASS ' + name + '\n')
}

function bad(name, detail) {
  failures.push(group + ' :: ' + name + ' :: ' + detail)
  process.stdout.write('  FAIL ' + name + '\n      ' + detail + '\n')
}

function check(name, condition, detail) {
  if (condition) ok(name)
  else bad(name, detail ?? 'assertion failed')
}

function equal(name, actual, expected) {
  const same = JSON.stringify(actual) === JSON.stringify(expected)
  check(name, same, 'expected ' + JSON.stringify(expected) + ' but got ' + JSON.stringify(actual))
}

function throwsCode(name, fn, code) {
  try {
    fn()
    bad(name, 'expected a throw with code ' + code + ', nothing was thrown')
  } catch (error) {
    check(
      name,
      error?.code === code,
      'expected code ' + code + ' but got ' + error?.code + ': ' + error?.message,
    )
  }
}

/** Deterministic values whose L2 norm is deliberately not 1. */
function stubVector(width, seed) {
  const vector = []
  for (let i = 0; i < width; i += 1) vector.push(Math.sin((i + 1) * (seed + 1)) * 3 + 0.5)
  return vector
}

const SECRET = 'stub-secret-do-not-log-0123456789'

// ---------------------------------------------------------------------------
// The stub upstream. Each request may set a mode that changes the answer.
// ---------------------------------------------------------------------------
const stub = {
  mode: 'ok',
  calls: [],
  width: 1024,
  async handler(req, res) {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const raw = Buffer.concat(chunks).toString('utf8')
    let body
    try {
      body = JSON.parse(raw)
    } catch {
      body = { __bad: raw }
    }
    stub.calls.push({ url: req.url, headers: req.headers, body })
    const send = (status, payload) => {
      const text = typeof payload === 'string' ? payload : JSON.stringify(payload)
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(text)
    }
    switch (stub.mode) {
      case 'ok': {
        const inputs = Array.isArray(body.input) ? body.input : []
        send(200, {
          object: 'list',
          model: body.model,
          data: inputs.map((_, index) => ({
            object: 'embedding',
            index,
            embedding: stubVector(stub.width, index),
          })),
          usage: { prompt_tokens: 1, total_tokens: 1 },
        })
        return
      }
      case 'reversed': {
        const inputs = Array.isArray(body.input) ? body.input : []
        const data = inputs.map((_, index) => ({
          object: 'embedding',
          index,
          embedding: stubVector(stub.width, index),
        }))
        data.reverse()
        send(200, { object: 'list', data })
        return
      }
      case 'narrow': {
        const inputs = Array.isArray(body.input) ? body.input : []
        send(200, {
          object: 'list',
          data: inputs.map((_, index) => ({ index, embedding: stubVector(768, index) })),
        })
        return
      }
      case 'wide': {
        const inputs = Array.isArray(body.input) ? body.input : []
        send(200, {
          object: 'list',
          data: inputs.map((_, index) => ({ index, embedding: stubVector(1536, index) })),
        })
        return
      }
      case 'short': {
        const inputs = Array.isArray(body.input) ? body.input : []
        send(200, {
          object: 'list',
          data: inputs.slice(0, Math.max(0, inputs.length - 1)).map((_, index) => ({
            index,
            embedding: stubVector(stub.width, index),
          })),
        })
        return
      }
      case 'unauthorized': {
        // The stub deliberately echoes the credential in its body; the shim
        // must never pass it through to the client or into a log line.
        send(401, { error: { message: 'bad key ' + (req.headers.authorization ?? '') } })
        return
      }
      case 'slow': {
        await new Promise((resolve) => setTimeout(resolve, 1500))
        send(200, { object: 'list', data: [] })
        return
      }
      case 'notjson':
        send(200, 'this is not json')
        return
      default:
        send(500, { error: { message: 'unexpected stub mode' } })
    }
  },
}

const stubServer = createServer((req, res) => {
  stub.handler(req, res).catch(() => {
    res.writeHead(500)
    res.end()
  })
})
await new Promise((resolve) => stubServer.listen(0, '127.0.0.1', resolve))
const stubPort = stubServer.address().port
const STUB_BASE = 'http://127.0.0.1:' + stubPort + '/v1'

const baseEnv = {
  // Ephemeral bind: the smoke test must never collide with a real shim on 8790
  // (or with any other listener) and must be runnable while one is up.
  EMBED_PORT: '0',
  EMBED_UPSTREAM_BASE: STUB_BASE,
  EMBED_UPSTREAM_MODEL: 'stub-upstream-model',
  EMBED_UPSTREAM_KEY: SECRET,
  EMBED_DIMENSIONS: '1024',
}

const logs = []
const logger = (line) => logs.push(String(line))
const started = []

async function start(envOverrides = {}) {
  const config = loadConfig({ ...baseEnv, ...envOverrides })
  const shim = await startShim(config, { logger })
  started.push(shim)
  return { shim, config }
}

async function postEmbed(base, payload) {
  const response = await fetch(base + '/embed', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  })
  const text = await response.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }
  return { status: response.status, json, text }
}

const norm = (vector) => Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0))

const main = await start()
const MODEL = 'plugin-fingerprint.v1'

// ---------------------------------------------------------------------------
section('config and bind rules')
// ---------------------------------------------------------------------------
throwsCode(
  'a non-loopback EMBED_HOST is refused at config time',
  () => {
    loadConfig({ ...baseEnv, EMBED_HOST: '0.0.0.0' })
  },
  'shim-config',
)
throwsCode(
  'a hostname (not a literal address) is refused at config time',
  () => {
    loadConfig({ ...baseEnv, EMBED_HOST: 'localhost' })
  },
  'shim-config',
)
throwsCode(
  'a blank EMBED_UPSTREAM_BASE is refused',
  () => {
    loadConfig({ EMBED_UPSTREAM_MODEL: 'm', EMBED_UPSTREAM_BASE: '' })
  },
  'shim-config',
)
throwsCode(
  'a non-numeric EMBED_PORT is refused',
  () => {
    loadConfig({ ...baseEnv, EMBED_PORT: 'eightyseven' })
  },
  'shim-config',
)
throwsCode(
  'an unknown EMBED_API_STYLE is refused',
  () => {
    loadConfig({ ...baseEnv, EMBED_API_STYLE: 'grpc' })
  },
  'shim-config',
)
equal('the default dimensions are 1024', loadConfig(baseEnv).dimensions, 1024)
equal('the default timeout is below the plugin budget', loadConfig(baseEnv).timeoutMs, 4000)
check(
  'the default timeout is under 5000 ms',
  loadConfig(baseEnv).timeoutMs < 5000,
  'timeout is not below the plugin budget',
)

// ---------------------------------------------------------------------------
section('GET /health')
// ---------------------------------------------------------------------------
{
  const response = await fetch(main.shim.url + '/health')
  const body = await response.json()
  equal('health answers 200', response.status, 200)
  equal('health status is ok', body.status, 'ok')
  equal('health reports the configured dimensions', body.dimensions, 1024)
  equal('health reports the upstream base', body.upstream, STUB_BASE)
  equal('health reports the upstream model', body.upstreamModel, 'stub-upstream-model')
  check(
    'health names a model',
    typeof body.model === 'string' && body.model !== '',
    'health.model is blank',
  )
  check(
    'health does not leak the credential',
    !JSON.stringify(body).includes(SECRET),
    'the health payload contains the key',
  )
}

// ---------------------------------------------------------------------------
section('POST /embed: contract shape')
// ---------------------------------------------------------------------------
{
  stub.mode = 'ok'
  stub.calls.length = 0
  const response = await postEmbed(main.shim.url, {
    model: MODEL,
    texts: ['alpha', 'beta'],
    kind: 'passage',
  })
  const body = response.json
  equal('embed answers 200', response.status, 200)
  equal('the requested model fingerprint is echoed verbatim', body?.model, MODEL)
  equal('dimensions match EMBED_DIMENSIONS', body?.dimensions, 1024)
  equal('one vector comes back per text', body?.vectors?.length, 2)
  check(
    'every vector has 1024 components',
    Array.isArray(body?.vectors) && body.vectors.every((v) => v.length === 1024),
    'a vector width differs from 1024',
  )
  check(
    'every component is a finite number',
    body.vectors.every((v) => v.every((x) => typeof x === 'number' && Number.isFinite(x))),
    'a component is not a finite number',
  )
  check(
    'every vector is L2-normalised',
    body.vectors.every((v) => Math.abs(norm(v) - 1) < 1e-9),
    'a vector is not unit length: ' + JSON.stringify(body.vectors.map(norm)),
  )
  equal(
    'the upstream model name is not the echoed fingerprint',
    stub.calls[0]?.body?.model,
    'stub-upstream-model',
  )
  equal(
    'the plugin fingerprint never reaches upstream as the model',
    stub.calls[0]?.body?.model === MODEL,
    false,
  )
}

// ---------------------------------------------------------------------------
section('POST /embed: kind and prefix rules (server-owned)')
// ---------------------------------------------------------------------------
{
  stub.mode = 'ok'
  stub.calls.length = 0
  await postEmbed(main.shim.url, { model: MODEL, texts: ['what is fts5'], kind: 'query' })
  const sent = stub.calls[0]?.body?.input?.[0]
  equal('a query is prefixed with the instruct form', sent, QUERY_INSTRUCTION + 'what is fts5')
  check(
    'the prefix is exactly the documented instruction',
    sent.startsWith(
      'Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:',
    ),
    'the prefix does not match the documented instruction: ' + JSON.stringify(sent.slice(0, 90)),
  )
}
{
  stub.calls.length = 0
  await postEmbed(main.shim.url, { model: MODEL, texts: ['a passage'], kind: 'passage' })
  equal('a passage is sent raw', stub.calls[0]?.body?.input?.[0], 'a passage')
}
{
  stub.calls.length = 0
  await postEmbed(main.shim.url, { model: MODEL, texts: ['no kind here'] })
  equal('an omitted kind is sent raw', stub.calls[0]?.body?.input?.[0], 'no kind here')
}
{
  const off = await start({ EMBED_QUERY_INSTRUCTION: '0' })
  stub.calls.length = 0
  await postEmbed(off.shim.url, { model: MODEL, texts: ['quiet'], kind: 'query' })
  equal('EMBED_QUERY_INSTRUCTION=0 sends a query raw', stub.calls[0]?.body?.input?.[0], 'quiet')
}
{
  const calls = stub.calls.length
  await postEmbed(main.shim.url, { model: MODEL, texts: ['one', 'two', 'three'], kind: 'query' })
  equal('one upstream call covers the whole batch', stub.calls.length - calls, 1)
  equal('the batch is passed in order', stub.calls.at(-1).body.input.length, 3)
}

// ---------------------------------------------------------------------------
section('POST /embed: request bounds answer 4xx')
// ---------------------------------------------------------------------------
{
  const tooMany = await postEmbed(main.shim.url, {
    model: MODEL,
    texts: Array.from({ length: 17 }, (_, i) => 't' + i),
  })
  equal('17 texts are refused with 400', tooMany.status, 400)
  check(
    'the refusal carries an error field',
    typeof tooMany.json?.error === 'string',
    'no error field',
  )
  equal('the refusal names the bound', tooMany.json?.code, 'too-many-texts')
}
{
  const longText = await postEmbed(main.shim.url, { model: MODEL, texts: ['x'.repeat(1201)] })
  equal('a 1201-code-point text is refused with 400', longText.status, 400)
  equal('the refusal names the bound', longText.json?.code, 'text-too-long')
  const boundary = await postEmbed(main.shim.url, { model: MODEL, texts: ['x'.repeat(1200)] })
  equal('a 1200-code-point text is accepted', boundary.status, 200)
}
{
  // Code points, not UTF-16 units: 1200 CJK code points must be accepted.
  const cjk = await postEmbed(main.shim.url, { model: MODEL, texts: ['记'.repeat(1200)] })
  equal('1200 multi-byte code points are accepted', cjk.status, 200)
}
{
  const huge = await postEmbed(main.shim.url, {
    model: MODEL,
    texts: ['x'],
    pad: 'a'.repeat(4 * 1024 * 1024 + 1024),
  })
  equal('a body over 4 MiB is refused with 413', huge.status, 413)
  equal('the refusal names the bound', huge.json?.code, 'body-too-large')
}
{
  equal(
    'a blank model is refused with 400',
    (await postEmbed(main.shim.url, { model: '', texts: ['x'] })).status,
    400,
  )
  equal(
    'an empty texts array is refused with 400',
    (await postEmbed(main.shim.url, { model: MODEL, texts: [] })).status,
    400,
  )
  equal(
    'a non-string text is refused with 400',
    (await postEmbed(main.shim.url, { model: MODEL, texts: [7] })).status,
    400,
  )
  equal(
    'an unknown kind is refused with 400',
    (await postEmbed(main.shim.url, { model: MODEL, texts: ['x'], kind: 'document' })).status,
    400,
  )
  const badJson = await postEmbed(main.shim.url, '{not json')
  equal('malformed JSON is refused with 400', badJson.status, 400)
  equal('the refusal names the rule', badJson.json?.code, 'bad-json')
}
{
  const wrongMethod = await fetch(main.shim.url + '/embed')
  equal('GET /embed is refused with 405', wrongMethod.status, 405)
  const missing = await fetch(main.shim.url + '/nope')
  equal('an unknown path answers 404', missing.status, 404)
}

// ---------------------------------------------------------------------------
section('POST /embed: upstream failures never truncate or pad')
// ---------------------------------------------------------------------------
{
  stub.mode = 'narrow'
  const narrow = await postEmbed(main.shim.url, { model: MODEL, texts: ['x'] })
  equal('a 768-d answer against 1024 is a 502', narrow.status, 502)
  equal('the failure names the dimension mismatch', narrow.json?.code, 'upstream-dimensions')
  check(
    'the failure reports both widths',
    String(narrow.json?.error).includes('768') && String(narrow.json?.error).includes('1024'),
    'the message does not name both widths: ' + narrow.json?.error,
  )
}
{
  stub.mode = 'wide'
  const wide = await postEmbed(main.shim.url, { model: MODEL, texts: ['x'] })
  equal('a 1536-d answer against 1024 is a 502', wide.status, 502)
  equal('the failure names the dimension mismatch', wide.json?.code, 'upstream-dimensions')
}
{
  stub.mode = 'short'
  const short = await postEmbed(main.shim.url, { model: MODEL, texts: ['a', 'b'] })
  equal('a missing embedding is a 502', short.status, 502)
  equal('the failure names the count', short.json?.code, 'upstream-count')
}
{
  stub.mode = 'notjson'
  const notJson = await postEmbed(main.shim.url, { model: MODEL, texts: ['x'] })
  equal('a non-JSON upstream body is a 502', notJson.status, 502)
  equal('the failure names the JSON rule', notJson.json?.code, 'upstream-bad-json')
}
{
  stub.mode = 'unauthorized'
  const denied = await postEmbed(main.shim.url, { model: MODEL, texts: ['x'] })
  equal('an upstream 401 is a 502', denied.status, 502)
  check(
    'the credential is redacted from the upstream message',
    !JSON.stringify(denied.json).includes(SECRET) && JSON.stringify(denied.json).includes('***'),
    'the credential leaked into the client error: ' + JSON.stringify(denied.json),
  )
  check(
    'the credential never reached the log',
    !logs.join('\n').includes(SECRET),
    'the credential leaked into a log line',
  )
}
{
  // The upstream is replaced by a dead port to force a transport failure.
  const dead = await start({ EMBED_UPSTREAM_BASE: 'http://127.0.0.1:1/v1' })
  const unreachable = await postEmbed(dead.shim.url, { model: MODEL, texts: ['x'] })
  equal('an unreachable upstream is a 502', unreachable.status, 502)
  equal('the failure names the transport', unreachable.json?.code, 'upstream-unreachable')
}
{
  const slow = await start({ EMBED_TIMEOUT_MS: '300' })
  stub.mode = 'slow'
  const started_at = Date.now()
  const timedOut = await postEmbed(slow.shim.url, { model: MODEL, texts: ['x'] })
  const elapsed = Date.now() - started_at
  equal('a slow upstream is a 504', timedOut.status, 504)
  equal('the failure names the timeout', timedOut.json?.code, 'upstream-timeout')
  check(
    'the shim gives up near its own budget, not later',
    elapsed < 1400,
    'elapsed ' + elapsed + 'ms',
  )
}

// ---------------------------------------------------------------------------
section('POST /embed: out-of-order upstream indices')
// ---------------------------------------------------------------------------
{
  stub.mode = 'reversed'
  const response = await postEmbed(main.shim.url, { model: MODEL, texts: ['zero', 'one', 'two'] })
  equal('a reversed answer still answers 200', response.status, 200)
  const first = response.json?.vectors?.[0]
  const expected = l2Stub(0)
  check(
    'vectors are re-ordered by index, not by position',
    JSON.stringify(first?.map((v) => Math.round(v * 1e6))) ===
      JSON.stringify(expected.map((v) => Math.round(v * 1e6))),
    'vector 0 does not match the upstream index 0 embedding',
  )
}

function l2Stub(seed) {
  const raw = stubVector(1024, seed)
  const length = Math.sqrt(raw.reduce((sum, value) => sum + value * value, 0))
  return raw.map((value) => value / length)
}

// ---------------------------------------------------------------------------
section('the real plugin contract talks to this shim')
// ---------------------------------------------------------------------------
{
  stub.mode = 'ok'
  const provider = createRetrievalProvider({
    enabled: true,
    endpoint: main.shim.url,
    model: MODEL,
    dimensions: 1024,
    timeoutMs: 5000,
  })
  const queryResult = await provider.embed({ texts: ['what is hybrid retrieval'], kind: 'query' })
  equal('createRetrievalProvider accepts the response model', queryResult.model, MODEL)
  equal('createRetrievalProvider accepts the dimensions', queryResult.dimensions, 1024)
  equal('createRetrievalProvider accepts one vector', queryResult.vectors.length, 1)
  equal('the accepted vector is 1024-d', queryResult.vectors[0].length, 1024)

  const noKind = await provider.embed({ texts: ['a chunk'] })
  equal('the no-kind path also validates', noKind.vectors[0].length, 1024)

  stub.calls.length = 0
  await provider.embed({ texts: ['q'], kind: 'query' })
  equal(
    'the provider-driven query is prefixed too',
    stub.calls[0].body.input[0],
    QUERY_INSTRUCTION + 'q',
  )

  // A dimensions mismatch is reported as provider-response, not as data.
  const narrowProvider = createRetrievalProvider({
    enabled: true,
    endpoint: main.shim.url,
    model: MODEL,
    dimensions: 1024,
    timeoutMs: 5000,
  })
  stub.mode = 'narrow'
  let mismatch = null
  try {
    await narrowProvider.embed({ texts: ['x'] })
  } catch (error) {
    mismatch = error
  }
  check(
    'the provider sees a clean provider-error for a bad upstream width',
    mismatch instanceof RetrievalProviderError && typeof mismatch.code === 'string',
    'no RetrievalProviderError was raised: ' + String(mismatch),
  )
  stub.mode = 'ok'
}

// ---------------------------------------------------------------------------
section('credential hygiene')
// ---------------------------------------------------------------------------
{
  check(
    'no log line contains the credential',
    !logs.join('\n').includes(SECRET),
    'a log line contains the key',
  )
  check(
    'no served body contains the credential',
    !JSON.stringify(await (await fetch(main.shim.url + '/health')).json()).includes(SECRET),
    'the health body contains the key',
  )
  const config = loadConfig(baseEnv)
  check(
    'the key is only reachable through the config object, never printed',
    config.upstreamKey === SECRET,
    'the config does not carry the key it was given',
  )
}

// ---------------------------------------------------------------------------
section('timeout sanity')
// ---------------------------------------------------------------------------
{
  check(
    'the shipped default timeout is below the plugin 5000 ms budget',
    4000 < 5000,
    'the default timeout is not below the plugin budget',
  )
}

// ---------------------------------------------------------------------------
for (const shim of started) await shim.close()
await new Promise((resolve) => stubServer.close(resolve))

const total = passes.length + failures.length
process.stdout.write('\n' + '-'.repeat(60) + '\n')
process.stdout.write('embed-gateway smoke: ' + passes.length + '/' + total + ' checks passed\n')
if (failures.length > 0) {
  process.stdout.write('FAILURES:\n')
  for (const line of failures) process.stdout.write('  - ' + line + '\n')
  process.exitCode = 1
} else {
  process.stdout.write('ALL CHECKS PASSED\n')
}
