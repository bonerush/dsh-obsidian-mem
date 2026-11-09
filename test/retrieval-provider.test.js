// Task 3 (v0.4) — provider contract for an explicitly configured loopback
// embedding/rerank service.
//
// The contract is the whole feature Phase A can land without choosing a
// provider: it validates configuration, refuses anything but a literal loopback
// endpoint, never follows a redirect, validates every number that comes back,
// and makes no request at all when it is disabled. Almost every transport in this
// file is an injected fake, which is how the zero-egress assertion is counted; one
// case drives the built-in transport against a throwaway loopback server so the
// production path is exercised too. No external host is ever contacted.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'

import {
  RetrievalProviderError,
  createRetrievalProvider,
  validateProviderConfig,
} from '../lib/retrieval-provider.js'

// A test-only model name and dimension. Nothing here chooses or ships a default
// provider: an enabled service always names its own endpoint and fingerprint.
const CONFIG = Object.freeze({
  enabled: true,
  endpoint: 'http://127.0.0.1:8765',
  model: 'test-embedding-model',
  dimensions: 2,
  timeoutMs: 250,
})

/** A transport fake that records every request and answers with one response. */
function fakeTransport(response) {
  const calls = []
  const transport = async (request) => {
    calls.push(request)
    if (typeof response === 'function') return response(request)
    return response
  }
  return { calls, transport }
}

const jsonResponse = (value, status = 200) => ({
  status,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(value),
})

const failsWith = (code) => (error) => {
  assert.ok(
    error instanceof RetrievalProviderError,
    `expected RetrievalProviderError, got ${error}`,
  )
  assert.equal(error.code, code, `expected code ${code}, received ${error.code}: ${error.message}`)
  return true
}

test('the provider is disabled by default and never touches the transport', async () => {
  const calls = []
  const transport = async (request) => {
    calls.push(request)
    throw new Error('egress attempted while disabled')
  }
  for (const config of [undefined, null, {}, { enabled: false, endpoint: CONFIG.endpoint }]) {
    const provider = createRetrievalProvider(config, { transport })
    assert.equal(provider.enabled, false)
    await assert.rejects(provider.embed({ texts: ['hello'] }), failsWith('provider-disabled'))
    await assert.rejects(
      provider.rerank({ query: 'q', candidates: [{ id: 'a', text: 'x' }] }),
      failsWith('provider-disabled'),
    )
  }
  assert.equal(calls.length, 0, 'zero egress when disabled')
})

test('invalid or non-loopback provider configuration is refused before any request', () => {
  const invalid = [
    { ...CONFIG, endpoint: 'http://example.com:8765' },
    { ...CONFIG, endpoint: 'http://10.1.2.3:8765' },
    { ...CONFIG, endpoint: 'http://localhost:8765' },
    { ...CONFIG, endpoint: 'https://192.168.1.10:8765' },
    { ...CONFIG, endpoint: 'ftp://127.0.0.1:8765' },
    { ...CONFIG, endpoint: 'http://user:secret@127.0.0.1:8765' },
    { ...CONFIG, endpoint: 'not a url' },
    { ...CONFIG, model: '' },
    { ...CONFIG, model: undefined },
    { ...CONFIG, dimensions: 0 },
    { ...CONFIG, dimensions: 1.5 },
    { ...CONFIG, timeoutMs: 0 },
  ]
  for (const config of invalid) {
    assert.throws(
      () => createRetrievalProvider(config, { transport: fakeTransport({}).transport }),
      (error) => {
        assert.ok(error instanceof RetrievalProviderError)
        assert.ok(
          ['provider-config', 'provider-non-loopback'].includes(error.code),
          `unexpected code ${error.code} for ${JSON.stringify(config.endpoint)}`,
        )
        return true
      },
    )
  }
  assert.deepEqual(validateProviderConfig(undefined), { enabled: false })
  // A literal loopback address is accepted, including bracketed IPv6.
  assert.equal(validateProviderConfig(CONFIG).enabled, true)
  assert.equal(
    validateProviderConfig({ ...CONFIG, endpoint: 'http://[::1]:8765/embed' }).enabled,
    true,
  )
})

test('embed validates the request, posts once and validates the response', async () => {
  const { calls, transport } = fakeTransport(
    jsonResponse({
      model: CONFIG.model,
      dimensions: 2,
      vectors: [
        [1, 2],
        [3.5, -0.5],
      ],
    }),
  )
  const provider = createRetrievalProvider(CONFIG, { transport })
  assert.equal(provider.enabled, true)
  assert.equal(provider.model, CONFIG.model)
  const result = await provider.embed({ texts: ['第一条', 'second'] })
  assert.deepEqual(result, {
    model: CONFIG.model,
    dimensions: 2,
    vectors: [
      [1, 2],
      [3.5, -0.5],
    ],
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'http://127.0.0.1:8765/embed')
  assert.equal(calls[0].method, 'POST')
  assert.deepEqual(JSON.parse(calls[0].body), {
    model: CONFIG.model,
    texts: ['第一条', 'second'],
  })
})

test('embed rejects malformed or mismatched responses without echoing text', async () => {
  const cases = [
    [jsonResponse({ model: 'other-model', dimensions: 2, vectors: [[1, 2]] }), 'provider-model'],
    [jsonResponse({ model: CONFIG.model, dimensions: 3, vectors: [[1, 2]] }), 'provider-response'],
    [
      jsonResponse({ model: CONFIG.model, dimensions: 2, vectors: [[1, Number.NaN]] }),
      'provider-response',
    ],
    [jsonResponse({ model: CONFIG.model, dimensions: 1, vectors: [[1]] }), 'provider-response'],
    [jsonResponse({ model: CONFIG.model, dimensions: 2, vectors: [] }), 'provider-response'],
    [{ status: 500, headers: {}, body: 'boom' }, 'provider-response'],
    [{ status: 200, headers: {}, body: 'not json' }, 'provider-response'],
    [
      { status: 302, headers: { location: 'http://elsewhere.invalid' }, body: '' },
      'provider-redirect',
    ],
  ]
  for (const [response, code] of cases) {
    const { calls, transport } = fakeTransport(response)
    const provider = createRetrievalProvider(CONFIG, { transport })
    await assert.rejects(provider.embed({ texts: ['secret text'] }), failsWith(code))
    assert.equal(calls.length, 1, 'a redirect is reported, never followed')
    assert.equal(String(response.body).includes('secret text'), false)
  }
})

test('embed rejects a request that breaks the batch or chunk bound', async () => {
  const { calls, transport } = fakeTransport(jsonResponse({}))
  const provider = createRetrievalProvider(CONFIG, { transport })
  await assert.rejects(provider.embed({ texts: [] }), failsWith('provider-request'))
  await assert.rejects(provider.embed({ texts: [''] }), failsWith('provider-request'))
  await assert.rejects(
    provider.embed({ texts: Array.from({ length: 17 }, () => 'x') }),
    failsWith('provider-request'),
  )
  await assert.rejects(provider.embed({ texts: ['x'.repeat(1201)] }), failsWith('provider-request'))
  assert.equal(calls.length, 0, 'a malformed request never egresses')
})

test('rerank is opt-in, validates candidate ids and scores', async () => {
  const rerankConfig = { ...CONFIG, rerank: true }
  const request = {
    query: 'query text',
    candidates: [
      { id: 'a', text: 'first' },
      { id: 'b', text: 'second' },
    ],
  }
  const { calls, transport } = fakeTransport(
    jsonResponse([
      { id: 'b', score: 0.9 },
      { id: 'a', score: 0.1 },
    ]),
  )
  const provider = createRetrievalProvider(rerankConfig, { transport })
  const result = await provider.rerank(request)
  assert.deepEqual(result, [
    { id: 'b', score: 0.9 },
    { id: 'a', score: 0.1 },
  ])
  assert.equal(calls[0].url, 'http://127.0.0.1:8765/rerank')
  assert.deepEqual(JSON.parse(calls[0].body), {
    model: CONFIG.model,
    query: 'query text',
    candidates: request.candidates,
  })

  for (const [response, code] of [
    [jsonResponse([{ id: 'unknown', score: 1 }]), 'provider-response'],
    [
      jsonResponse([
        { id: 'a', score: 1 },
        { id: 'a', score: 0.5 },
      ]),
      'provider-response',
    ],
    [jsonResponse([{ id: 'a', score: Number.POSITIVE_INFINITY }]), 'provider-response'],
    [jsonResponse([{ id: 'a', score: 'high' }]), 'provider-response'],
  ]) {
    const failing = createRetrievalProvider(rerankConfig, {
      transport: fakeTransport(response).transport,
    })
    await assert.rejects(failing.rerank(request), failsWith(code))
  }

  const notOptedIn = createRetrievalProvider(CONFIG, {
    transport: fakeTransport(jsonResponse([])).transport,
  })
  await assert.rejects(notOptedIn.rerank(request), failsWith('provider-unsupported'))
})

test('rerank refuses a malformed request and never egresses for it', async () => {
  const { calls, transport } = fakeTransport(jsonResponse([]))
  const provider = createRetrievalProvider({ ...CONFIG, rerank: true }, { transport })
  await assert.rejects(
    provider.rerank({ query: '', candidates: [] }),
    failsWith('provider-request'),
  )
  await assert.rejects(
    provider.rerank({
      query: 'q',
      candidates: Array.from({ length: 11 }, (_, i) => ({ id: `c${i}`, text: 'x' })),
    }),
    failsWith('provider-request'),
  )
  await assert.rejects(
    provider.rerank({ query: 'q', candidates: [{ id: 'a', text: 'x'.repeat(8001) }] }),
    failsWith('provider-request'),
  )
  assert.equal(calls.length, 0)
})

test('a transport failure is wrapped as a provider error with no body leakage', async () => {
  const { transport } = fakeTransport(async () => {
    throw new Error('socket hang up: secret text')
  })
  const provider = createRetrievalProvider(CONFIG, { transport })
  await assert.rejects(provider.embed({ texts: ['secret text'] }), (error) => {
    assert.equal(error.code, 'provider-transport')
    assert.equal(error.message.includes('secret text'), false)
    return true
  })
})

test('the built-in loopback transport speaks HTTP and never follows a redirect', async (t) => {
  let requests = 0
  const server = createServer((request, response) => {
    requests += 1
    if (request.url === '/embed') {
      const chunks = []
      request.on('data', (chunk) => chunks.push(chunk))
      request.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify({
            model: CONFIG.model,
            dimensions: CONFIG.dimensions,
            vectors: body.texts.map(() => [1, 2]),
          }),
        )
      })
      return
    }
    response.writeHead(302, { location: 'http://127.0.0.1:1/elsewhere' })
    response.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const { port } = server.address()

  const provider = createRetrievalProvider({ ...CONFIG, endpoint: 'http://127.0.0.1:' + port })
  const embedded = await provider.embed({ texts: ['第一条'] })
  assert.deepEqual(embedded.vectors, [[1, 2]])
  assert.equal(requests, 1, 'one request reached the loopback server')

  const redirecting = createRetrievalProvider({
    ...CONFIG,
    endpoint: 'http://127.0.0.1:' + port + '/redirect',
  })
  await assert.rejects(redirecting.embed({ texts: ['x'] }), failsWith('provider-redirect'))
  assert.equal(requests, 2, 'the redirect is reported after exactly one request, never followed')
})

test('embed sends the optional kind field only when asked and refuses unknown kinds', async () => {
  // e5-family models need a different prefix for a query and a passage. The
  // contract carries the distinction as a field rather than a text prefix, so the
  // plugin never rewrites text and the provider keeps its own prefixing rule. The
  // body assertion for the no-kind case above must keep passing unchanged, which
  // is why the field is omitted rather than sent as null.
  const { calls, transport } = fakeTransport(
    jsonResponse({ model: CONFIG.model, dimensions: CONFIG.dimensions, vectors: [[1, 2]] }),
  )
  const provider = createRetrievalProvider(CONFIG, { transport })
  await provider.embed({ texts: ['q'], kind: 'query' })
  assert.deepEqual(JSON.parse(calls[0].body), {
    model: CONFIG.model,
    texts: ['q'],
    kind: 'query',
  })
  await provider.embed({ texts: ['p'], kind: 'passage' })
  assert.equal(JSON.parse(calls[1].body).kind, 'passage')
  await assert.rejects(
    provider.embed({ texts: ['x'], kind: 'document' }),
    failsWith('provider-request'),
  )
  assert.equal(calls.length, 2, 'an invalid kind never reaches the transport')
})

// ---------------------------------------------------------------------------
// Slice 2 (2026-11-09) — egress, apiStyle and apiKeyEnv.
//
// The provider used to be a loopback-only contract. An operator may now state
// `egress: 'remote'` (an internal gateway or a commercial API), name the wire
// protocol (`apiStyle: 'openai'` for /embeddings), and name the environment
// variable the credential is read from. These cases pin the three of them: that
// remote is only legal when written out, that the mapping reuses the same
// response checks rather than a second copy, and that a credential is a header
// value which never turns into text anybody can read back.
// ---------------------------------------------------------------------------

/** A distinctive fake credential; every string the module produces is scanned for it. */
const FAKE_KEY = 'sk-test-0123456789abcdef'
/** The variable NAME the tests set; a name is configuration, a value is not. */
const KEY_ENV = 'DSH_TEST_PROVIDER_KEY'
/** A remote gateway-shaped config. The injected transport means it is never contacted. */
const REMOTE = Object.freeze({
  enabled: true,
  egress: 'remote',
  endpoint: 'https://gateway.example.com/v1',
  model: CONFIG.model,
  dimensions: CONFIG.dimensions,
  timeoutMs: CONFIG.timeoutMs,
})

/** Every readable string a produced failure carries, including its wrapped cause. */
function producedStrings(error) {
  const cause = error?.cause
  return [
    String(error),
    error?.message ?? '',
    error?.stack ?? '',
    cause instanceof Error ? cause.message : String(cause ?? ''),
    cause instanceof Error ? (cause.stack ?? '') : '',
  ]
}

test('a remote endpoint is accepted only with an explicit remote egress', () => {
  const normalised = validateProviderConfig(REMOTE)
  assert.equal(normalised.egress, 'remote')
  assert.equal(normalised.apiStyle, 'embed')
  assert.equal(normalised.apiKeyEnv, '')
  assert.equal(normalised.url, 'https://gateway.example.com/v1')

  const remote = createRetrievalProvider(REMOTE, { transport: fakeTransport({}).transport })
  assert.equal(remote.egress, 'remote')
  assert.equal(remote.apiStyle, 'embed')

  // The same endpoint under the default egress keeps the v0.4 refusal, code and
  // sentence included: the README and test/config.test.js both name this code.
  for (const endpoint of [
    'http://example.com:8765',
    'http://10.1.2.3:8765',
    'http://localhost:8765',
    'https://192.168.1.10:8765',
  ]) {
    assert.throws(
      () =>
        createRetrievalProvider(
          { ...CONFIG, endpoint },
          { transport: fakeTransport({}).transport },
        ),
      (error) => {
        assert.equal(error.code, 'provider-non-loopback', endpoint)
        assert.match(error.message, /literal loopback address/)
        return true
      },
    )
  }

  // A literal loopback address stays legal under remote: the literal-address rule
  // is a loopback-mode rule, not a blanket ban on the form.
  assert.equal(
    validateProviderConfig({ ...REMOTE, endpoint: 'http://127.0.0.1:8765' }).egress,
    'remote',
  )

  // Unknown modes and every URL form this contract refuses are provider-config,
  // and remote egress does not bypass any of them.
  for (const config of [
    { ...REMOTE, egress: 'anywhere' },
    { ...REMOTE, egress: 'REMOTE' },
    { ...REMOTE, endpoint: 'https://user:secret@gateway.example.com/v1' },
    { ...REMOTE, endpoint: 'https://gateway.example.com/v1?key=1' },
    { ...REMOTE, endpoint: 'https://gateway.example.com/v1#fragment' },
    { ...REMOTE, endpoint: 'ftp://gateway.example.com/v1' },
    { ...REMOTE, endpoint: '' },
    { ...REMOTE, endpoint: 'not a url' },
    { ...REMOTE, apiStyle: 'grpc' },
    { ...REMOTE, apiKeyEnv: 'NOT A NAME' },
    { ...REMOTE, apiKeyEnv: 7 },
  ]) {
    assert.throws(
      () => createRetrievalProvider(config, { transport: fakeTransport({}).transport }),
      failsWith('provider-config'),
      JSON.stringify(config),
    )
  }

  // Defaults: an unchanged fixture still normalises to loopback/embed/no credential.
  const unchanged = validateProviderConfig({ ...CONFIG })
  assert.equal(unchanged.egress, 'loopback')
  assert.equal(unchanged.apiStyle, 'embed')
  assert.equal(unchanged.apiKeyEnv, '')

  // There is no /rerank in the OpenAI-compatible dialect, so an enabled rerank is
  // refused when the route is built rather than failed later by a request.
  assert.throws(
    () => validateProviderConfig({ ...REMOTE, apiStyle: 'openai', rerank: true }),
    failsWith('provider-config'),
  )
  assert.equal(validateProviderConfig({ ...REMOTE, rerank: true }).rerank, true)
})

test('apiStyle openai posts /embeddings and maps data[].embedding onto the contract', async (t) => {
  const received = []
  const server = createServer((request, response) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      received.push({ url: request.url, body: Buffer.concat(chunks).toString('utf8') })
      response.writeHead(200, { 'content-type': 'application/json' })
      // Deliberately out of order: a real gateway is free to answer in any order,
      // so the mapping restores request order instead of trusting row position.
      response.end(
        JSON.stringify({
          object: 'list',
          data: [
            { object: 'embedding', index: 1, embedding: [3.5, -0.5] },
            { object: 'embedding', index: 0, embedding: [1, 2] },
          ],
        }),
      )
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const { port } = server.address()

  const provider = createRetrievalProvider({
    ...CONFIG,
    egress: 'remote',
    apiStyle: 'openai',
    endpoint: 'http://127.0.0.1:' + port + '/v1',
  })
  assert.equal(provider.apiStyle, 'openai')
  const result = await provider.embed({ texts: ['第一条', 'second'], kind: 'query' })
  assert.deepEqual(result, {
    model: CONFIG.model,
    dimensions: CONFIG.dimensions,
    vectors: [
      [1, 2],
      [3.5, -0.5],
    ],
  })
  assert.equal(received.length, 1)
  assert.equal(received[0].url, '/v1/embeddings')
  const body = JSON.parse(received[0].body)
  assert.deepEqual(body, { model: CONFIG.model, input: ['第一条', 'second'] })
  assert.equal('kind' in body, false, 'the OpenAI dialect has no query/passage field')
})

test('apiStyle openai refuses every reply it cannot map, with its own code for each', async () => {
  const openai = { ...CONFIG, apiStyle: 'openai' }
  const cases = [
    // A width that disagrees with the configured dimensions.
    [
      jsonResponse({
        data: [
          { index: 0, embedding: [1] },
          { index: 1, embedding: [1, 2] },
        ],
      }),
      /exactly the configured dimensions/,
    ],
    // No data array at all.
    [jsonResponse({ object: 'list' }), /data array/],
    [jsonResponse({ data: 'nope' }), /data array/],
    // Fewer vectors than requested texts.
    [jsonResponse({ data: [] }), /one vector per requested text/],
    // A non-finite component (JSON has no Infinity; it arrives as null).
    [
      jsonResponse({
        data: [
          { index: 0, embedding: [1, null] },
          { index: 1, embedding: [1, 2] },
        ],
      }),
      /finite number/,
    ],
    // Duplicate and out-of-range indices are refusals, never a silent reorder.
    [
      jsonResponse({
        data: [
          { index: 1, embedding: [1, 2] },
          { index: 1, embedding: [3.5, -0.5] },
        ],
      }),
      /distinct integer/,
    ],
    [
      jsonResponse({
        data: [
          { index: 0, embedding: [1, 2] },
          { index: 5, embedding: [3.5, -0.5] },
        ],
      }),
      /distinct integer/,
    ],
    // A row with no embedding to map.
    [jsonResponse({ data: [{ index: 0, embedding: [1, 2] }, { index: 1 }] }), /dimensions/],
    // A non-200 answer keeps the same status refusal as the /embed contract.
    [{ status: 401, headers: {}, body: 'unauthorised' }, /status 401/],
  ]
  for (const [response, message] of cases) {
    const { calls, transport } = fakeTransport(response)
    const provider = createRetrievalProvider(openai, { transport })
    await assert.rejects(provider.embed({ texts: ['a', 'b'] }), (error) => {
      failsWith('provider-response')(error)
      assert.match(error.message, message)
      return true
    })
    assert.equal(calls.length, 1, 'a reachable service is called exactly once')
  }

  // An unindexed reply is taken in the order it arrived, which is what a service
  // that omits index means; the count still has to match.
  const { transport } = fakeTransport(
    jsonResponse({ data: [{ embedding: [1, 2] }, { embedding: [3.5, -0.5] }] }),
  )
  const provider = createRetrievalProvider(openai, { transport })
  const result = await provider.embed({ texts: ['a', 'b'] })
  assert.deepEqual(result.vectors, [
    [1, 2],
    [3.5, -0.5],
  ])
})

test('a credential is resolved at request time and never appears in any message', async () => {
  const config = { ...REMOTE, apiStyle: 'openai', apiKeyEnv: KEY_ENV }
  const saved = process.env[KEY_ENV]

  try {
    // 1. A variable that is absent (and one that is blank) refuses before any socket:
    //    the counting transport proves zero calls rather than assuming it.
    for (const value of [undefined, '   ']) {
      if (value === undefined) delete process.env[KEY_ENV]
      else process.env[KEY_ENV] = value
      const { calls, transport } = fakeTransport(jsonResponse({ data: [] }))
      const provider = createRetrievalProvider(config, { transport })
      await assert.rejects(provider.embed({ texts: ['x'] }), (error) => {
        assert.equal(error.code, 'provider-credential')
        assert.match(error.message, new RegExp(KEY_ENV), 'the message names the variable')
        assert.equal(calls.length, 0, 'a missing credential opens no socket')
        for (const text of producedStrings(error)) {
          assert.equal(text.includes(FAKE_KEY), false, 'the value is never in a message')
        }
        return true
      })
    }

    process.env[KEY_ENV] = FAKE_KEY

    // 2. Success: the value rides as a bearer header and never enters the body.
    const { calls, transport } = fakeTransport(
      jsonResponse({ data: [{ index: 0, embedding: [1, 2] }] }),
    )
    const provider = createRetrievalProvider(config, { transport })
    const result = await provider.embed({ texts: ['x'] })
    assert.deepEqual(result.vectors, [[1, 2]])
    assert.equal(calls[0].headers.authorization, 'Bearer ' + FAKE_KEY)
    assert.equal(calls[0].body.includes(FAKE_KEY), false)
    assert.equal(String(provider.endpoint).includes(FAKE_KEY), false)
    assert.equal(String(provider.apiStyle).includes(FAKE_KEY), false)

    // 3. An upstream that echoes the header cannot put the value in a diagnostic:
    //    the wrapped cause is redacted along with the message.
    const echoing = fakeTransport(async () => {
      throw new Error('gateway rejected Bearer ' + FAKE_KEY)
    })
    const echoingProvider = createRetrievalProvider(config, { transport: echoing.transport })
    await assert.rejects(echoingProvider.embed({ texts: ['x'] }), (error) => {
      assert.equal(error.code, 'provider-transport')
      for (const text of producedStrings(error)) {
        assert.equal(text.includes(FAKE_KEY), false, 'the value is never in a message')
      }
      return true
    })

    // 4. A 401 body that repeats the key is not echoed either: the status is the
    //    whole message.
    const bodyEcho = fakeTransport({
      status: 401,
      headers: {},
      body: JSON.stringify({ error: 'bad key ' + FAKE_KEY }),
    })
    const bodyEchoProvider = createRetrievalProvider(config, { transport: bodyEcho.transport })
    await assert.rejects(bodyEchoProvider.embed({ texts: ['x'] }), (error) => {
      assert.equal(error.code, 'provider-response')
      for (const text of producedStrings(error)) {
        assert.equal(text.includes(FAKE_KEY), false, 'the response body is never echoed')
      }
      return true
    })
  } finally {
    if (saved === undefined) delete process.env[KEY_ENV]
    else process.env[KEY_ENV] = saved
  }
})
