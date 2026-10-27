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
