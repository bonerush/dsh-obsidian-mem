#!/usr/bin/env node
// A loopback embedding gateway for dsh-obsidian-mem's hybrid retrieval.
//
// The plugin (lib/retrieval-provider.js) never chooses a model or a service: an
// operator hands it an explicit literal-loopback endpoint, a model fingerprint
// and a vector width. This shim is that endpoint. It speaks the plugin's
// contract on the inside and an OpenAI-compatible /embeddings API on the
// outside, so the plugin's zero-dependency path can reach an internal gateway
// without the plugin itself growing a network client.
//
// The contract implemented here, verbatim from lib/retrieval-provider.js:
//
//   POST /embed   {"model": string, "texts": [string], "kind"?: "query"|"passage"}
//     -> 200 {"model": <the request's model, echoed verbatim>,
//             "dimensions": <EMBED_DIMENSIONS>,
//             "vectors": [[float, ...], ...]}      (every vector L2-normalised)
//   GET /health
//     -> 200 {"status":"ok","model":...,"dimensions":1024,"upstream":...,"upstreamModel":...}
//   any failure -> 4xx/5xx {"error": "<code-ish message>"}
//
// Bounds, mirrored from the provider contract: at most 16 texts, 1,200 code
// points per text, 4 MiB request body. All three answer 4xx instead of being
// silently narrowed.
//
// "kind" exists because the model family owns its own prefix rule and the
// plugin must not rewrite text: a "query" is prefixed with the Qwen3 instruct
// form, a "passage" (or an omitted kind) is sent raw.
//
// Run:  node tools/embed-gateway/shim.mjs
//       (or with a key in the environment only, never in a file)
//       set DOCUMIND_API_KEY=*** && node tools/embed-gateway/shim.mjs
import { createServer } from 'node:http'
import { resolve as resolvePath } from 'node:path'
import { pathToFileURL } from 'node:url'

/** The only addresses this process may bind; anything else is refused outright. */
export const LOOPBACK_BIND_HOSTS = Object.freeze(['127.0.0.1', '::1'])
/** The plugin refuses bodies over 4 MiB on its own side; mirror it here. */
export const MAX_REQUEST_BODY_BYTES = 4 * 1024 * 1024
export const DEFAULT_DIMENSIONS = 1024
export const DEFAULT_TIMEOUT_MS = 4000
/** The plugin's hard per-request budget; this shim must answer inside it. */
export const PLUGIN_TIMEOUT_MS = 5000
/** Qwen3 query instruction; the server owns this prefix, not the plugin. */
export const QUERY_INSTRUCTION =
  'Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:'

/** A refusal to start: bad configuration, never a runtime request failure. */
export class ShimConfigError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ShimConfigError'
    this.code = 'shim-config'
  }
}

/** A refusal to answer: the request was invalid, or upstream failed. */
class ShimError extends Error {
  constructor(code, message, status) {
    super(message)
    this.name = 'ShimError'
    this.code = code
    this.status = status
  }
}

function readInt(env, name, fallback, min, max) {
  const raw = env[name]
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback
  const value = Number(String(raw).trim())
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ShimConfigError(name + ' must be an integer between ' + min + ' and ' + max)
  }
  return value
}

function readFlag(env, name, fallback) {
  const raw = env[name]
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback
  const value = String(raw).trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(value)) return true
  if (['0', 'false', 'no', 'off'].includes(value)) return false
  throw new ShimConfigError(name + ' must be 1/0, true/false, yes/no or on/off')
}

/**
 * Read and validate the configuration.
 *
 * The key is read from EMBED_UPSTREAM_KEY or, when that is empty, from the
 * variable named by EMBED_UPSTREAM_KEY_ENV (DOCUMIND_API_KEY by default). It is
 * never written anywhere and never logged; only its presence is reported.
 *
 * @param {Record<string, string|undefined>} [env] - the environment to read.
 * @returns {object} the frozen configuration.
 * @throws {ShimConfigError} on any unusable value.
 */
export function loadConfig(env = process.env) {
  const host = String(env.EMBED_HOST ?? '127.0.0.1').trim()
  if (!LOOPBACK_BIND_HOSTS.includes(host)) {
    throw new ShimConfigError(
      'EMBED_HOST must be a literal loopback address (' +
        LOOPBACK_BIND_HOSTS.join(' or ') +
        '); refusing to bind ' +
        (host || '(blank)'),
    )
  }
  const port = readInt(env, 'EMBED_PORT', 8790, 0, 65535)

  const rawBase = String(env.EMBED_UPSTREAM_BASE ?? '').trim()
  if (rawBase === '') {
    throw new ShimConfigError(
      'EMBED_UPSTREAM_BASE must name the upstream base URL, e.g. https://gateway.example.com/v1',
    )
  }
  let parsedBase
  try {
    parsedBase = new URL(rawBase)
  } catch {
    throw new ShimConfigError('EMBED_UPSTREAM_BASE is not a valid URL')
  }
  if (parsedBase.protocol !== 'http:' && parsedBase.protocol !== 'https:') {
    throw new ShimConfigError('EMBED_UPSTREAM_BASE must use http or https')
  }
  const upstreamBase = parsedBase.href.replace(/\/+$/, '')

  const upstreamModel = String(env.EMBED_UPSTREAM_MODEL ?? '').trim()
  if (upstreamModel === '') {
    throw new ShimConfigError('EMBED_UPSTREAM_MODEL must name the upstream embedding model')
  }

  const keyEnvName =
    String(env.EMBED_UPSTREAM_KEY_ENV ?? 'DOCUMIND_API_KEY').trim() || 'DOCUMIND_API_KEY'
  const upstreamKey = String(env.EMBED_UPSTREAM_KEY || env[keyEnvName] || '').trim()

  const dimensions = readInt(env, 'EMBED_DIMENSIONS', DEFAULT_DIMENSIONS, 1, 8192)
  const timeoutMs = readInt(env, 'EMBED_TIMEOUT_MS', DEFAULT_TIMEOUT_MS, 1, 120000)
  const maxTexts = readInt(env, 'EMBED_MAX_TEXTS', 16, 1, 1024)
  const maxChars = readInt(env, 'EMBED_MAX_CHARS', 1200, 1, 100000)
  const queryInstruction = readFlag(env, 'EMBED_QUERY_INSTRUCTION', true)

  const apiStyle = String(env.EMBED_API_STYLE ?? 'openai')
    .trim()
    .toLowerCase()
  if (apiStyle !== 'openai' && apiStyle !== 'ollama') {
    throw new ShimConfigError('EMBED_API_STYLE must be "openai" or "ollama"')
  }

  return Object.freeze({
    host,
    port,
    upstreamBase,
    upstreamModel,
    upstreamKey,
    keyEnvName,
    dimensions,
    timeoutMs,
    maxTexts,
    maxChars,
    maxBodyBytes: MAX_REQUEST_BODY_BYTES,
    queryInstruction,
    apiStyle,
  })
}

function embeddingsUrl(config) {
  return config.apiStyle === 'ollama'
    ? config.upstreamBase + '/api/embed'
    : config.upstreamBase + '/embeddings'
}

function upstreamHeaders(config) {
  const headers = { 'content-type': 'application/json', accept: 'application/json' }
  // The key travels in this header only. Nothing writes it to a log or a file.
  if (config.upstreamKey !== '') headers.authorization = 'Bearer ' + config.upstreamKey
  return headers
}

/** Replace any accidental echo of the key with a mask. */
function redact(text, config) {
  let out = String(text)
  if (config.upstreamKey !== '') out = out.split(config.upstreamKey).join('***')
  return out
}

/**
 * L2-normalise one vector.
 *
 * A zero vector stays zero rather than becoming NaN: the plugin rejects any
 * non-finite component, and an all-zero embedding is at least a valid answer.
 *
 * @param {number[]} vector - the upstream components.
 * @returns {number[]} the unit-length vector.
 */
export function l2Normalize(vector) {
  let sum = 0
  for (const value of vector) sum += value * value
  const norm = Math.sqrt(sum)
  if (!(norm > 0) || !Number.isFinite(norm)) return vector.map(() => 0)
  return vector.map((value) => value / norm)
}

/** The prefix the server (not the plugin) adds for a query. */
function prefixFor(kind, config) {
  if (!config.queryInstruction) return ''
  return kind === 'query' ? QUERY_INSTRUCTION : ''
}

/**
 * Validate one /embed body against the contract and this shim's bounds.
 *
 * @param {unknown} payload - the parsed JSON body.
 * @param {object} config - the shim configuration.
 * @returns {{model: string, texts: string[], kind: 'query'|'passage'|undefined}} the request.
 * @throws {ShimError} with 400.
 */
function validateEmbedRequest(payload, config) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ShimError('bad-request', 'the request body must be a JSON object', 400)
  }
  const model = payload.model
  if (typeof model !== 'string' || model.trim() === '') {
    throw new ShimError('bad-model', 'request.model must be a non-blank string', 400)
  }
  if (model.length > 128) {
    throw new ShimError('bad-model', 'request.model must be at most 128 characters', 400)
  }
  const texts = payload.texts
  if (!Array.isArray(texts) || texts.length === 0) {
    throw new ShimError('bad-texts', 'request.texts must be a non-empty array', 400)
  }
  if (texts.length > config.maxTexts) {
    throw new ShimError(
      'too-many-texts',
      'request.texts carries ' + texts.length + ' texts; the bound is ' + config.maxTexts,
      400,
    )
  }
  for (const text of texts) {
    if (typeof text !== 'string' || text.trim() === '') {
      throw new ShimError('bad-texts', 'every request text must be a non-blank string', 400)
    }
    if ([...text].length > config.maxChars) {
      throw new ShimError(
        'text-too-long',
        'a request text exceeds the ' + config.maxChars + '-code-point bound',
        400,
      )
    }
  }
  const kind = payload.kind
  if (kind !== undefined && kind !== null && kind !== 'query' && kind !== 'passage') {
    throw new ShimError('bad-kind', 'request.kind must be "query" or "passage" when present', 400)
  }
  return { model, texts: texts.slice(), kind: kind === null ? undefined : kind }
}

/** Pull the width-checked vectors out of an OpenAI- or Ollama-shaped payload. */
function extractVectors(parsed, config, expectedCount) {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ShimError('upstream-bad-json', 'the upstream response must be a JSON object', 502)
  }
  let raw
  if (config.apiStyle === 'ollama') {
    if (!Array.isArray(parsed.embeddings)) {
      throw new ShimError('upstream-shape', 'the upstream response has no embeddings array', 502)
    }
    raw = parsed.embeddings
  } else {
    if (!Array.isArray(parsed.data)) {
      throw new ShimError('upstream-shape', 'the upstream response has no data array', 502)
    }
    const indexed = parsed.data.every(
      (item) => item !== null && typeof item === 'object' && Number.isInteger(item.index),
    )
    const ordered = parsed.data.slice()
    if (indexed) {
      // The API may answer out of order; the contract is positional.
      ordered.sort((a, b) => a.index - b.index)
      const seen = new Set(ordered.map((item) => item.index))
      if (
        seen.size !== ordered.length ||
        ordered.some((item, position) => item.index !== position)
      ) {
        throw new ShimError('upstream-shape', 'the upstream data indices are not 0..n-1', 502)
      }
    }
    raw = ordered.map((item) => item?.embedding)
  }
  if (!Array.isArray(raw) || raw.length !== expectedCount) {
    throw new ShimError(
      'upstream-count',
      'upstream answered ' +
        (Array.isArray(raw) ? raw.length : 'no') +
        ' embeddings for ' +
        expectedCount +
        ' texts',
      502,
    )
  }
  const vectors = []
  for (const vector of raw) {
    if (!Array.isArray(vector)) {
      throw new ShimError('upstream-shape', 'an upstream embedding is not an array', 502)
    }
    if (vector.length !== config.dimensions) {
      // Never truncate or pad: a wrong width is a provider failure.
      throw new ShimError(
        'upstream-dimensions',
        'upstream returned ' +
          vector.length +
          '-d vectors but EMBED_DIMENSIONS is ' +
          config.dimensions +
          '; refusing to truncate or pad',
        502,
      )
    }
    for (const value of vector) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new ShimError('upstream-vector', 'an upstream component is not a finite number', 502)
      }
    }
    vectors.push(vector)
  }
  return vectors
}

/**
 * One upstream embeddings call.
 *
 * @param {object} config - the shim configuration.
 * @param {Function} fetchImpl - the transport (global fetch by default).
 * @param {string[]} inputs - the texts to embed, already prefixed.
 * @param {AbortSignal|undefined} clientSignal - aborts when the plugin goes away.
 * @returns {Promise<number[][]>} the normalised vectors, in request order.
 * @throws {ShimError} with a 5xx status.
 */
async function embedUpstream(config, fetchImpl, inputs, clientSignal) {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, config.timeoutMs)
  const onClientAbort = () => controller.abort()
  if (clientSignal) clientSignal.addEventListener('abort', onClientAbort, { once: true })
  try {
    if (clientSignal?.aborted) {
      throw new ShimError('client-aborted', 'the client went away before the upstream call', 499)
    }
    let response
    let text
    try {
      response = await fetchImpl(embeddingsUrl(config), {
        method: 'POST',
        headers: upstreamHeaders(config),
        body: JSON.stringify({ model: config.upstreamModel, input: inputs }),
        signal: controller.signal,
      })
      text = await response.text()
    } catch (error) {
      if (timedOut) {
        throw new ShimError(
          'upstream-timeout',
          'upstream did not answer within ' + config.timeoutMs + 'ms',
          504,
        )
      }
      if (clientSignal?.aborted) {
        throw new ShimError('client-aborted', 'the client went away during the upstream call', 499)
      }
      throw new ShimError(
        'upstream-unreachable',
        'the upstream request failed: ' + redact(error?.message ?? 'unknown error', config),
        502,
      )
    }
    if (!response.ok) {
      const snippet = redact(String(text ?? '').slice(0, 200), config)
        .replace(/\s+/g, ' ')
        .trim()
      throw new ShimError(
        'upstream-status',
        'upstream answered HTTP ' + response.status + (snippet === '' ? '' : ': ' + snippet),
        502,
      )
    }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new ShimError('upstream-bad-json', 'the upstream response is not valid JSON', 502)
    }
    return extractVectors(parsed, config, inputs.length).map((vector) => l2Normalize(vector))
  } finally {
    clearTimeout(timer)
    if (clientSignal) clientSignal.removeEventListener('abort', onClientAbort)
  }
}

function sendJson(res, status, payload) {
  if (res.writableEnded || res.destroyed) return
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body, 'utf8'),
  })
  res.end(body)
}

function fail(res, status, code, message) {
  sendJson(res, status, { error: message, code })
}

function healthPayload(config) {
  return {
    status: 'ok',
    model: config.upstreamModel,
    dimensions: config.dimensions,
    upstream: config.upstreamBase,
    upstreamModel: config.upstreamModel,
    style: config.apiStyle,
    queryInstruction: config.queryInstruction,
  }
}

function readBody(req, cap) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let tooLarge = false
    let settled = false
    req.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > cap) {
        tooLarge = true
        chunks.length = 0
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      if (tooLarge) resolve({ tooLarge: true, text: '' })
      else resolve({ tooLarge: false, text: Buffer.concat(chunks).toString('utf8') })
    })
    req.on('error', (error) => {
      if (settled) return
      settled = true
      reject(error)
    })
  })
}

async function handle(config, ctx, req, res) {
  let pathname
  try {
    const hostPart = config.host === '::1' ? '[::1]' : config.host
    pathname = new URL(req.url ?? '/', 'http://' + hostPart).pathname
  } catch {
    pathname = '/'
  }
  if (req.method === 'GET' && pathname === '/health') {
    sendJson(res, 200, healthPayload(config))
    return
  }
  if (pathname === '/embed' && req.method !== 'POST') {
    fail(res, 405, 'method-not-allowed', 'only POST /embed and GET /health exist')
    return
  }
  if (pathname !== '/embed') {
    fail(res, 404, 'not-found', 'only POST /embed and GET /health exist')
    return
  }

  let read
  try {
    read = await readBody(req, config.maxBodyBytes)
  } catch (error) {
    fail(
      res,
      400,
      'bad-body',
      'the request body could not be read: ' + redact(error?.message ?? '', config),
    )
    return
  }
  if (read.tooLarge) {
    fail(res, 413, 'body-too-large', 'the request body exceeds ' + config.maxBodyBytes + ' bytes')
    return
  }
  let payload
  try {
    payload = JSON.parse(read.text)
  } catch {
    fail(res, 400, 'bad-json', 'the request body is not valid JSON')
    return
  }
  let request
  try {
    request = validateEmbedRequest(payload, config)
  } catch (error) {
    fail(res, error.status ?? 400, error.code ?? 'bad-request', error.message)
    return
  }

  const inputs = request.texts.map((text) => prefixFor(request.kind, config) + text)
  const client = new AbortController()
  res.on('close', () => {
    if (!res.writableEnded) client.abort()
  })

  let vectors
  try {
    vectors = await embedUpstream(config, ctx.fetchImpl, inputs, client.signal)
  } catch (error) {
    if (error?.code === 'client-aborted' && (res.destroyed || res.writableEnded)) return
    ctx.logger('embed error: ' + (error?.code ?? 'unknown') + ' ' + (error?.message ?? ''))
    fail(
      res,
      error?.status ?? 502,
      error?.code ?? 'upstream-error',
      error?.message ?? 'upstream failed',
    )
    return
  }
  // The model is the operator's fingerprint, echoed verbatim; it deliberately
  // need not equal the upstream model name.
  sendJson(res, 200, { model: request.model, dimensions: config.dimensions, vectors })
}

/**
 * Start the loopback server.
 *
 * @param {object} config - a loadConfig() result.
 * @param {{fetchImpl?: Function, logger?: Function}} [options] - seams.
 * @returns {Promise<{config: object, server: object, url: string, port: number, close: Function}>}
 */
export async function startShim(
  config,
  { fetchImpl = globalThis.fetch, logger = defaultLogger } = {},
) {
  if (typeof config?.host !== 'string' || !LOOPBACK_BIND_HOSTS.includes(config.host)) {
    throw new ShimConfigError('startShim refuses to bind a non-loopback address')
  }
  if (typeof fetchImpl !== 'function') {
    throw new ShimConfigError('startShim needs a fetch implementation')
  }
  if (config.timeoutMs >= PLUGIN_TIMEOUT_MS) {
    logger(
      'warning: EMBED_TIMEOUT_MS=' +
        config.timeoutMs +
        'ms is not below the plugin budget of ' +
        PLUGIN_TIMEOUT_MS +
        'ms; the plugin will give up first',
    )
  }
  if (config.upstreamKey === '') {
    logger(
      'warning: no upstream key in ' + config.keyEnvName + '; the call goes out unauthenticated',
    )
  }
  const server = createServer((req, res) => {
    handle(config, { fetchImpl, logger }, req, res).catch((error) => {
      logger('unhandled request failure: ' + (error?.message ?? error))
      fail(res, 500, 'internal-error', 'the shim failed while answering')
    })
  })
  server.on('clientError', (error, socket) => {
    if (socket.destroyed) return
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
  })
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.removeListener('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.removeListener('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(config.port, config.host)
  })
  const address = server.address()
  const hostPart = config.host === '::1' ? '[::1]' : config.host
  const url = 'http://' + hostPart + ':' + address.port
  return {
    config,
    server,
    url,
    port: address.port,
    close() {
      return new Promise((resolve) => server.close(() => resolve()))
    },
  }
}

function defaultLogger(line) {
  process.stderr.write('embed-gateway: ' + line + '\n')
}

async function main() {
  let config
  try {
    config = loadConfig(process.env)
  } catch (error) {
    if (error instanceof ShimConfigError) {
      process.stderr.write('embed-gateway: ' + error.message + '\n')
      process.exitCode = 2
      return
    }
    throw error
  }
  const shim = await startShim(config)
  const lines = [
    'embed-gateway listening on ' + shim.url,
    '  upstream: ' + config.upstreamBase + ' (' + config.apiStyle + ' style)',
    '  upstream model: ' + config.upstreamModel,
    '  auth: ' + (config.upstreamKey === '' ? 'unset' : 'bearer *** (set)'),
    '  dimensions: ' + config.dimensions + ', timeout: ' + config.timeoutMs + 'ms',
    '  query instruction: ' + (config.queryInstruction ? 'on' : 'off'),
    '  bounds: ' +
      config.maxTexts +
      ' texts, ' +
      config.maxChars +
      ' chars, ' +
      config.maxBodyBytes +
      ' bytes',
  ]
  process.stdout.write(lines.join('\n') + '\n')
  const shutdown = () => {
    shim.close().finally(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolvePath(process.argv[1])).href
if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write('embed-gateway: failed to start: ' + (error?.message ?? error) + '\n')
    process.exitCode = 1
  })
}
