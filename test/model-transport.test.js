// The HTTP model transport, exercised against a real loopback SSE server.
//
// The thing under test is an *adapter*, so almost every assertion here is about the
// exact shape a host consumer will read: `lib/distill.js` reads `block-end.block.text`
// in preference to the deltas and treats a non-`stop` finish as a verdict, and
// `lib/curation-auto.js` does the same — so the chunk sequence, the whole text and the
// terminal reason are the contract, not an implementation detail. A real `node:http`
// server on `127.0.0.1:0` is used rather than a fake transport because the two
// behaviours hardest to get right (a socket destroyed by an abort, and an abort that
// arrives while the generator is suspended) only exist on a real socket. No external
// host is ever contacted.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'

import { ModelEgressError } from '../lib/model-egress.js'
import { createHttpLlmRoute } from '../lib/model-transport.js'

// A distinctive value: every produced chunk and every produced error is scanned for it,
// so a leak is a failing test rather than a review note.
const FAKE_KEY = 'sk-test-0123456789abcdef'
/** Text that stands in for the user's own prompt; it must never come back as a diagnostic. */
const PROMPT_MARKER = 'PRIVATE-PROMPT-MARKER'

/**
 * Start one loopback server whose handler answers after the request body is read.
 *
 * @param {(request: {method?: string, url?: string, headers: object, body: string}, response: import('node:http').ServerResponse) => void} handler - the responder.
 * @returns {Promise<{url: string, requests: object[], close: () => Promise<void>}>} the server.
 */
async function listen(handler) {
  /** @type {object[]} */
  const requests = []
  const server = createServer((request, response) => {
    let raw = ''
    request.setEncoding('utf8')
    request.on('data', (chunk) => {
      raw += chunk
    })
    request.on('end', () => {
      const entry = {
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: raw,
      }
      requests.push(entry)
      handler(entry, response)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = /** @type {{port: number}} */ (server.address())
  return {
    url: 'http://127.0.0.1:' + address.port,
    requests,
    async close() {
      // An aborted or stalled response keeps a connection alive; the test owns it.
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

/**
 * Write one SSE frame.
 *
 * @param {import('node:http').ServerResponse} response - the open response.
 * @param {unknown} payload - an object, or a raw string such as `[DONE]`.
 */
function frame(response, payload) {
  const data = typeof payload === 'string' ? payload : JSON.stringify(payload)
  response.write('data: ' + data + '\n\n')
}

/**
 * Write one delta frame.
 *
 * @param {import('node:http').ServerResponse} response - the open response.
 * @param {string} text - the delta.
 */
function delta(response, text) {
  frame(response, { choices: [{ index: 0, delta: { content: text } }] })
}

/**
 * Collect every chunk of one stream.
 *
 * @param {AsyncIterable<object>} stream - the stream.
 * @returns {Promise<object[]>} the chunks, in order.
 */
async function collect(stream) {
  /** @type {object[]} */
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

/**
 * The terminal chunk, which every task-3 assertion is about.
 *
 * @param {object[]} chunks - a collected stream.
 * @returns {any} the last chunk.
 */
function finishOf(chunks) {
  assert.equal(chunks.at(-1).type, 'finish', 'the stream must end with a finish chunk')
  return chunks.at(-1)
}

/**
 * Scan one value for the fake credential.
 *
 * @param {unknown} value - anything a consumer could print.
 * @param {string} what - the label used in the failure message.
 */
function assertNoSecret(value, what) {
  const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value))
  assert.equal(text.includes(FAKE_KEY), false, what + ' leaked the credential')
}

/** The one host request shape the consumers actually send (`lib/distill.js`). */
function request(overrides = {}) {
  return {
    provider: 'test-provider',
    model: 'test-model',
    system: 'You are terse.',
    messages: [
      {
        id: 'message-1',
        role: 'user',
        content: [{ type: 'text', text: PROMPT_MARKER }],
        source: { kind: 'user' },
      },
    ],
    maxTokens: 64,
    ...overrides,
  }
}

/** A route over one test server, with no credential. */
function routeTo(url, overrides = {}) {
  return createHttpLlmRoute({ endpoint: url, timeoutMs: 2000, ...overrides })
}

test('a loopback route refuses a non-loopback endpoint and a remote one accepts it', () => {
  const remote = 'http://gateway.example.internal:8080/v1'
  assert.throws(
    () => createHttpLlmRoute({ endpoint: remote }),
    (error) => error instanceof ModelEgressError && error.code === 'non-loopback',
  )
  assert.throws(
    () => createHttpLlmRoute({ endpoint: remote, egress: 'loopback' }),
    (error) => error instanceof ModelEgressError && error.code === 'non-loopback',
  )
  const route = createHttpLlmRoute({
    endpoint: remote,
    egress: 'remote',
    model: 'm',
    provider: 'gateway',
  })
  assert.equal(route.endpoint, remote)
  assert.equal(route.egress, 'remote')
  // The route states its own names so a caller can report which model answered.
  assert.equal(route.model, 'm')
  assert.equal(route.provider, 'gateway')
  assert.equal(typeof route.stream, 'function')
})

test('the shared endpoint rules are the only ones applied, and they are refused to the caller', () => {
  const refused = {
    'endpoint-blank': '',
    'endpoint-invalid': 'not a url',
    'endpoint-scheme': 'ftp://127.0.0.1:8765',
    'endpoint-credentials': 'http://user:secret@127.0.0.1:8765',
    'endpoint-query': 'http://127.0.0.1:8765?x=1',
    'credential-env-invalid': undefined,
  }
  for (const [code, endpoint] of Object.entries(refused)) {
    const config =
      code === 'credential-env-invalid'
        ? { endpoint: 'http://127.0.0.1:1', apiKeyEnv: 'not a name' }
        : { endpoint }
    assert.throws(
      () => createHttpLlmRoute(config),
      (error) => error instanceof ModelEgressError && error.code === code,
      'expected ' + code + ' for ' + JSON.stringify(config),
    )
  }
  // A bare `?`/`#` has an empty search/hash but still breaks the path join: the
  // suffix would be filed under the query instead of the path. The shared rules
  // refuse the delimiter itself, so the README's "no credentials, no query, no
  // fragment" sentence is true for these forms too.
  for (const endpoint of [
    'http://127.0.0.1:8765/?',
    'http://127.0.0.1:8765/v1?',
    'http://127.0.0.1:8765/#',
    'http://127.0.0.1:8765/v1#',
  ]) {
    assert.throws(
      () => createHttpLlmRoute({ endpoint }),
      (error) => error instanceof ModelEgressError && error.code === 'endpoint-query',
      'expected endpoint-query for ' + JSON.stringify(endpoint),
    )
  }
  assert.throws(
    () => createHttpLlmRoute({ endpoint: 'http://127.0.0.1:1', egress: 'everywhere' }),
    (error) => error instanceof ModelEgressError && error.code === 'egress-mode',
  )
})

test('an unsupported apiStyle or budget is a construction refusal', () => {
  assert.throws(
    () => createHttpLlmRoute({ endpoint: 'http://127.0.0.1:1', apiStyle: 'anthropic' }),
    TypeError,
  )
  // 600000 ms is the accepted ceiling; one millisecond past it is not a budget.
  for (const timeoutMs of [0, -1, Number.NaN, 600001]) {
    assert.throws(
      () => createHttpLlmRoute({ endpoint: 'http://127.0.0.1:1', timeoutMs }),
      TypeError,
    )
  }
  assert.equal(createHttpLlmRoute({ endpoint: 'http://127.0.0.1:1' }).apiStyle, 'openai-chat')
})

test('stream() returns a synchronous async iterable, never a promise', async (t) => {
  const server = await listen((entry, response) => {
    delta(response, 'ok')
    frame(response, '[DONE]')
    response.end()
  })
  t.after(() => server.close())
  const route = routeTo(server.url)
  const stream = route.stream(request())
  assert.equal(stream instanceof Promise, false, 'the host contract is a synchronous return')
  assert.equal(typeof stream[Symbol.asyncIterator], 'function')
  const chunks = await collect(stream)
  assert.equal(finishOf(chunks).reason.kind, 'stop')
  // A malformed argument is still a stream, never a throw in the caller's path.
  for (const argument of [
    undefined,
    null,
    // Even reading the options may throw; the iterator still exists, and the failure
    // arrives as a terminal chunk instead of in the caller's synchronous path.
    new Proxy(
      {},
      {
        get() {
          throw new Error('hostile options')
        },
      },
    ),
  ]) {
    const malformed = route.stream(argument)
    assert.equal(typeof malformed[Symbol.asyncIterator], 'function')
    assert.deepEqual(
      (await collect(malformed)).map((chunk) => chunk.type),
      ['finish'],
    )
  }
})

test('one SSE answer becomes the host chunk sequence, the whole text and the usage', async (t) => {
  const server = await listen((entry, response) => {
    delta(response, 'Hel')
    delta(response, 'lo')
    frame(response, {
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
        prompt_tokens_details: { cached_tokens: 3 },
        completion_tokens_details: { reasoning_tokens: 2 },
      },
    })
    frame(response, '[DONE]')
    response.end()
  })
  t.after(() => server.close())

  const chunks = await collect(routeTo(server.url).stream(request()))
  assert.deepEqual(
    chunks.map((chunk) => chunk.type),
    ['block-start', 'text-delta', 'text-delta', 'block-end', 'usage', 'finish'],
  )
  // The measured shape (test/distill.test.js's `textStream`), index included: a consumer
  // joins blocks by index and reads `block.text` in preference to the deltas.
  assert.deepEqual(chunks[0], { type: 'block-start', index: 0, block: { type: 'text' } })
  assert.deepEqual(chunks[1], { type: 'text-delta', index: 0, text: 'Hel' })
  assert.deepEqual(chunks[2], { type: 'text-delta', index: 0, text: 'lo' })
  assert.deepEqual(chunks[3], {
    type: 'block-end',
    index: 0,
    block: { type: 'text', text: 'Hello' },
  })
  assert.deepEqual(chunks[4], {
    type: 'usage',
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      cacheReadTokens: 3,
      reasoningTokens: 2,
    },
  })
  assert.deepEqual(chunks[5], { type: 'finish', reason: { kind: 'stop' } })
  // `lib/distill.js` reads exactly this; a dashboard that joined only the deltas would
  // have to know where the text ends, which is what `block-end` states.
  const raw = chunks
    .filter((chunk) => chunk.type === 'block-end')
    .map((chunk) => /** @type {any} */ (chunk).block.text)
    .join('')
  assert.equal(raw, 'Hello')
})

test('a multi-byte character split across TCP chunks is decoded, not replaced', async (t) => {
  // The bytes of one delta frame, cut one byte into the first character's UTF-8
  // encoding: neither half is valid UTF-8 on its own, exactly the shape a real socket
  // produces when a packet boundary lands inside a Chinese character. A per-chunk
  // `String()` conversion would freeze the halves into U+FFFD before the line parses.
  const answer = '你好，世界'
  const body = 'data: ' + JSON.stringify({ choices: [{ delta: { content: answer } }] }) + '\n\n'
  const bytes = Buffer.from(body, 'utf8')
  const charAt = body.indexOf('你')
  const cut = Buffer.byteLength(body.slice(0, charAt), 'utf8') + 1
  const server = await listen((entry, response) => {
    response.write(bytes.subarray(0, cut))
    // The timer makes the split deterministic: two writes in one tick can still
    // coalesce into a single chunk on some kernels.
    setTimeout(() => {
      response.write(bytes.subarray(cut))
      response.end('data: [DONE]\n\n')
    }, 25)
  })
  t.after(() => server.close())

  const chunks = await collect(routeTo(server.url).stream(request()))
  const deltas = chunks
    .filter((chunk) => chunk.type === 'text-delta')
    .map((chunk) => /** @type {any} */ (chunk).text)
  // The block-end text is what `lib/distill.js` parses, and the deltas are what a
  // reader would display; both must survive the split unchanged.
  assert.deepEqual(deltas, [answer])
  const end = chunks.find((chunk) => chunk.type === 'block-end')
  assert.equal(/** @type {any} */ (end).block.text, answer)
})

test('the request is one POST /chat/completions with the system message first', async (t) => {
  const server = await listen((entry, response) => {
    frame(response, { choices: [{ delta: { content: 'ok' } }] })
    frame(response, '[DONE]')
    response.end()
  })
  t.after(() => server.close())

  await collect(routeTo(server.url).stream(request()))
  assert.equal(server.requests.length, 1)
  const [sent] = server.requests
  assert.equal(sent.method, 'POST')
  assert.equal(sent.url, '/chat/completions')
  assert.equal(sent.headers.accept, 'text/event-stream')
  assert.equal('authorization' in sent.headers, false, 'an unauthenticated route sends no header')
  const body = JSON.parse(sent.body)
  assert.deepEqual(body, {
    model: 'test-model',
    messages: [
      { role: 'system', content: 'You are terse.' },
      // The host's `id`, `source` and content parts are not part of the wire format.
      { role: 'user', content: PROMPT_MARKER },
    ],
    stream: true,
    max_tokens: 64,
  })
  assert.equal('provider' in body, false, 'provider is a host route name, not a wire field')
})

test('a configured credential becomes one bearer header and never reaches a chunk', async (t) => {
  const server = await listen((entry, response) => {
    delta(response, 'ok')
    frame(response, '[DONE]')
    response.end()
  })
  t.after(() => server.close())

  const route = routeTo(server.url, { apiKeyEnv: 'MODEL_TEST_KEY' })
  const chunks = await collect(route.stream(request({ env: {} })))
  // `env` is a per-call option only on the route, not on the request; the constructor
  // owns it, so this route must read `process.env`.
  assert.equal(finishOf(chunks).reason.failure?.code, 'credential-missing')
  assert.equal(server.requests.length, 0, 'no socket is opened without a credential')

  process.env.MODEL_TEST_KEY = FAKE_KEY
  t.after(() => {
    delete process.env.MODEL_TEST_KEY
  })
  const sent = await collect(route.stream(request()))
  assert.equal(finishOf(sent).reason.kind, 'stop')
  assert.equal(server.requests.length, 1)
  assert.equal(server.requests[0].headers.authorization, 'Bearer ' + FAKE_KEY)
  for (const chunk of sent) assertNoSecret(chunk, 'a chunk')
})

test('a route configured with an env map reads the credential from it', async (t) => {
  const server = await listen((entry, response) => {
    frame(response, '[DONE]')
    response.end()
  })
  t.after(() => server.close())

  const route = routeTo(server.url, {
    apiKeyEnv: 'MODEL_MAP_KEY',
    env: { MODEL_MAP_KEY: FAKE_KEY },
  })
  const chunks = await collect(route.stream(request()))
  assert.equal(finishOf(chunks).reason.kind, 'stop')
  assert.equal(server.requests[0].headers.authorization, 'Bearer ' + FAKE_KEY)
  for (const chunk of chunks) assertNoSecret(chunk, 'a chunk')
})

test('a missing credential is a terminal error naming the variable, not the value', async (t) => {
  const server = await listen((entry, response) => {
    response.end()
  })
  t.after(() => server.close())

  const route = routeTo(server.url, { apiKeyEnv: 'MODEL_ABSENT_KEY', env: {} })
  const chunks = await collect(route.stream(request()))
  const finish = finishOf(chunks)
  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure.code, 'credential-missing')
  assert.match(finish.reason.failure.message, /MODEL_ABSENT_KEY/)
  assert.equal(server.requests.length, 0)
  for (const chunk of chunks) assertNoSecret(chunk, 'a chunk')
})

test('a caller abort ends the stream with finish aborted / ABORTED, keeping no answer', async (t) => {
  const server = await listen((entry, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    delta(response, 'partial')
    // Never end: the abort has to destroy the socket, not wait for the server.
  })
  t.after(() => server.close())

  const controller = new AbortController()
  const stream = routeTo(server.url).stream(request({ signal: controller.signal }))
  const iterator = stream[Symbol.asyncIterator]()
  const started = await iterator.next()
  assert.equal(/** @type {any} */ (started.value).type, 'block-start')
  const first = await iterator.next()
  assert.equal(/** @type {any} */ (first.value).type, 'text-delta')
  controller.abort()

  /** @type {object[]} */
  const rest = []
  for (;;) {
    const step = await iterator.next()
    if (step.done === true) break
    rest.push(step.value)
  }
  const finish = finishOf(rest)
  assert.deepEqual(finish.reason.kind, 'aborted')
  assert.equal(finish.reason.failure.code, 'ABORTED')
  // An aborted stream carries no whole-text verdict and no usage, exactly as the
  // consumers' documented tolerance requires.
  assert.equal(
    rest.some((chunk) => chunk.type === 'block-end' || chunk.type === 'usage'),
    false,
  )
})

test('a route over its budget ends the stream with finish aborted / TIMEOUT', async (t) => {
  const server = await listen((entry, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    delta(response, 'slow')
  })
  t.after(() => server.close())

  const chunks = await collect(routeTo(server.url, { timeoutMs: 25 }).stream(request()))
  const finish = finishOf(chunks)
  assert.equal(finish.reason.kind, 'aborted')
  assert.equal(finish.reason.failure.code, 'TIMEOUT')
  assert.equal(
    chunks.some((chunk) => chunk.type === 'block-end'),
    false,
  )
})

test('a non-2xx answer reports the status alone and never echoes the body', async (t) => {
  const server = await listen((entry, response) => {
    response.writeHead(401, { 'content-type': 'application/json' })
    // A gateway echoing the prompt and the credential back is the leak this defends.
    response.end(JSON.stringify({ error: PROMPT_MARKER, key: FAKE_KEY }))
  })
  t.after(() => server.close())

  const route = routeTo(server.url, {
    apiKeyEnv: 'MODEL_ECHO_KEY',
    env: { MODEL_ECHO_KEY: FAKE_KEY },
  })
  const chunks = await collect(route.stream(request()))
  const finish = finishOf(chunks)
  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure.code, 'HTTP_401')
  for (const chunk of chunks) {
    assertNoSecret(chunk, 'a 401 chunk')
    assert.equal(JSON.stringify(chunk).includes(PROMPT_MARKER), false, 'the prompt was echoed')
  }
  // And the upstream body is never parsed, so no `block-start` is opened for it.
  assert.deepEqual(
    chunks.map((chunk) => chunk.type),
    ['finish'],
  )
})

test('a data line that is not JSON is ignored rather than fatal', async (t) => {
  const server = await listen((entry, response) => {
    response.write('\n')
    response.write(': keep-alive\n\n')
    response.write('event: message\n\n')
    response.write('data: {not json at all\n\n')
    frame(response, { choices: [{ delta: { content: 'ok' } }] })
    response.write('data: null\n\n')
    response.write('data: [1, 2, 3]\n\n')
    frame(response, '[DONE]')
    response.end()
  })
  t.after(() => server.close())

  const chunks = await collect(routeTo(server.url).stream(request()))
  assert.equal(finishOf(chunks).reason.kind, 'stop')
  assert.deepEqual(
    chunks
      .filter((chunk) => chunk.type === 'text-delta')
      .map((chunk) => /** @type {any} */ (chunk).text),
    ['ok'],
  )
  assert.equal(
    /** @type {any} */ (chunks.find((chunk) => chunk.type === 'block-end')).block.text,
    'ok',
  )
})

test('[DONE] ends the answer, and a length finish_reason is the max-tokens verdict', async (t) => {
  const done = await listen((entry, response) => {
    delta(response, 'one')
    frame(response, '[DONE]')
    // A server that keeps talking after the sentinel must not contribute text.
    delta(response, 'never')
    response.end()
  })
  t.after(() => done.close())
  const sent = await collect(routeTo(done.url).stream(request()))
  assert.equal(finishOf(sent).reason.kind, 'stop')
  assert.equal(
    /** @type {any} */ (sent.find((chunk) => chunk.type === 'block-end')).block.text,
    'one',
  )

  const truncated = await listen((entry, response) => {
    frame(response, { choices: [{ delta: { content: 'half' }, finish_reason: 'length' }] })
    frame(response, '[DONE]')
    response.end()
  })
  t.after(() => truncated.close())
  // `lib/distill.js` refuses `max-tokens`: a truncated answer is never a candidate, so
  // the adapter must not dress it as `stop`.
  assert.deepEqual(finishOf(await collect(routeTo(truncated.url).stream(request()))).reason, {
    kind: 'max-tokens',
  })
})

test('usage counters the endpoint omits are 0 and a missing total is the sum', async (t) => {
  const server = await listen((entry, response) => {
    frame(response, {
      choices: [{ delta: { content: 'ok' } }],
      usage: { prompt_tokens: 7, completion_tokens: 3 },
    })
    frame(response, '[DONE]')
    response.end()
  })
  t.after(() => server.close())

  const chunks = await collect(routeTo(server.url).stream(request()))
  const usage = /** @type {any} */ (chunks.find((chunk) => chunk.type === 'usage'))
  assert.deepEqual(usage.usage, {
    inputTokens: 7,
    outputTokens: 3,
    totalTokens: 10,
    cacheReadTokens: 0,
    reasoningTokens: 0,
  })
})

test('an error object mid-stream is a verdict, not half an answer', async (t) => {
  const server = await listen((entry, response) => {
    delta(response, 'partial')
    frame(response, { error: { message: PROMPT_MARKER + ' ' + FAKE_KEY } })
    response.end()
  })
  t.after(() => server.close())

  const route = routeTo(server.url, {
    apiKeyEnv: 'MODEL_STREAM_KEY',
    env: { MODEL_STREAM_KEY: FAKE_KEY },
  })
  const chunks = await collect(route.stream(request()))
  const finish = finishOf(chunks)
  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure.code, 'UPSTREAM')
  // No `block-end` and no `usage`: a partial answer must never look complete.
  assert.equal(
    chunks.some((chunk) => chunk.type === 'block-end' || chunk.type === 'usage'),
    false,
  )
  for (const chunk of chunks) {
    assertNoSecret(chunk, 'a mid-stream error chunk')
    assert.equal(
      JSON.stringify(chunk).includes(PROMPT_MARKER),
      false,
      'the upstream error text leaked',
    )
  }
})

test('an unreachable endpoint is a TRANSPORT verdict, not a throw', async () => {
  // A port that was just closed: the address is real, so this cannot hang.
  const server = await listen((entry, response) => {
    response.end()
  })
  const url = server.url
  await server.close()

  const route = routeTo(url)
  const stream = route.stream(request())
  assert.equal(typeof stream[Symbol.asyncIterator], 'function')
  const finish = finishOf(await collect(stream))
  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure.code, 'TRANSPORT')
  for (const chunk of [finish]) assertNoSecret(chunk, 'a transport error chunk')
})

test('no produced chunk or error carries the credential, across a happy path and a failure', async (t) => {
  const ok = await listen((entry, response) => {
    delta(response, 'ok')
    frame(response, '[DONE]')
    response.end()
  })
  t.after(() => ok.close())
  const reject = await listen((entry, response) => {
    response.writeHead(500, { 'content-type': 'text/plain' })
    response.end('echo: ' + FAKE_KEY)
  })
  t.after(() => reject.close())

  const base = { apiKeyEnv: 'MODEL_SCAN_KEY', env: { MODEL_SCAN_KEY: FAKE_KEY } }
  for (const url of [ok.url, reject.url]) {
    const chunks = await collect(routeTo(url, base).stream(request()))
    for (const chunk of chunks) assertNoSecret(chunk, 'a scanned chunk')
    const finish = finishOf(chunks)
    if (finish.reason.kind === 'error')
      assertNoSecret(finish.reason.failure.message, 'an error message')
  }

  // The construction refusal names the configuration path and the variable, never a value.
  let refused = null
  try {
    createHttpLlmRoute({ endpoint: 'http://gateway.example.internal/v1', egress: 'loopback' })
  } catch (error) {
    refused = error
  }
  assert.ok(refused instanceof ModelEgressError)
  assertNoSecret({ name: refused.name, code: refused.code, message: refused.message }, 'a refusal')
})
