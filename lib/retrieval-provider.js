// The optional retrieval provider contract (v0.4 spec §5, options B and C).
//
// The design's boundary is the whole point of this module: the plugin never
// chooses, discovers or infers an embedding/rerank service. A provider exists only
// when an operator hands over an explicit endpoint, model fingerprint and vector
// dimension, and even then the *route* is an explicit statement of theirs:
//
//   * `egress: 'loopback'` (the default) keeps the v0.4 rule — a literal
//     127.0.0.1 or ::1 address, no hostname that could resolve elsewhere, no
//     redirect that could carry the request off the machine.
//   * `egress: 'remote'` is the operator writing down that inference happens
//     elsewhere (an internal gateway, a commercial API). The endpoint forms stay
//     bounded — no credentials, query or fragment in the URL, http(s) only — but
//     the literal-address rule is a loopback-mode rule, not a blanket ban.
//   * `apiStyle` says which protocol that service speaks: this plugin's own
//     `/embed` contract, or the OpenAI-compatible `/embeddings` one.
//
// The egress forms and the credential rules are shared with the distillation
// transport, so they live in ./model-egress.js and are applied here rather than
// re-implemented; `provider-non-loopback` below is this contract's own code for
// the one shared refusal a loopback route raises.
//
// Two failure modes are treated as product behaviour rather than errors:
//
//   * **Disabled is the default.** A missing config, an empty config or
//     enabled:false yields a provider whose methods reject with
//     provider-disabled and whose transport is never called. Absence of a
//     provider is not a retry condition and must never cause a request.
//   * **A bad response is a provider failure, not data.** Every number from the
//     service is checked (model identity, dimensions, finite components, candidate
//     ids, finite rerank scores) before it reaches the caller. Nothing from the
//     request or response body is echoed into an error message: diagnostics must
//     not leak query text, chunks, embeddings or credentials.
//
// A credential is a *name* in the config (`apiKeyEnv`) and a value in the
// environment, resolved immediately before a request is sent. A missing variable
// is a coded failure (`provider-credential`) with no socket opened; the value is
// never part of a message, and text an upstream error echoes back is redacted
// against it.
//
// The transport is a seam. Production uses the built-in node:http(s) transport,
// which never follows a redirect; tests inject a fake and count its calls, which
// is how zero-egress-when-disabled is asserted rather than assumed.
import http from 'node:http'
import https from 'node:https'

import {
  ModelEgressError,
  redactSecret,
  resolveCredential,
  resolveEgress,
  resolveEndpoint,
  resolveKeyEnvName,
} from './model-egress.js'

// Re-exported rather than restated: the loopback address list is one list, and the
// README plus tools/embed-gateway/ both name this module as where it lives.
export { LOOPBACK_HOSTS } from './model-egress.js'

/** The two wire protocols an operator may name. */
const API_STYLES = Object.freeze(['embed', 'openai'])
/** Default per-request budget; the design's query deadline is 700 ms across stages. */
export const PROVIDER_DEFAULT_TIMEOUT_MS = 500
/** Bounds for an operator-supplied timeout. */
export const PROVIDER_MIN_TIMEOUT_MS = 50
export const PROVIDER_MAX_TIMEOUT_MS = 5000
/** The largest response body this contract will read. */
export const PROVIDER_MAX_RESPONSE_BYTES = 1_048_576
/** One embed call's batch bound and per-text bound (spec §5: 16 chunks, 1,200 cp). */
export const PROVIDER_MAX_EMBED_TEXTS = 16
export const PROVIDER_MAX_TEXT_CHARS = 1200
/** One rerank call's candidate bound and total-text bound (spec §5: 10, 8,000 cp). */
export const PROVIDER_MAX_RERANK_CANDIDATES = 10
export const PROVIDER_MAX_RERANK_CHARS = 8000

/**
 * A content-free failure of the provider contract.
 *
 * code is the machine-readable reason (provider-config, provider-non-loopback,
 * provider-credential, provider-disabled, provider-request, provider-transport,
 * provider-timeout, provider-aborted, provider-redirect, provider-response,
 * provider-model, provider-unsupported). message names the rule that failed, never
 * the text that was sent and never a credential.
 */
export class RetrievalProviderError extends Error {
  constructor(code, message, options = {}) {
    super(message)
    this.name = 'RetrievalProviderError'
    this.code = code
    if (options.cause !== undefined) this.cause = options.cause
  }
}

/**
 * Run one ./model-egress.js rule and restate its refusal in this contract's words.
 *
 * The shared module answers in transport-neutral codes (`non-loopback`,
 * `endpoint-query`, `credential-env-invalid`, …). Callers of this module — the
 * config loader, the README, the shipped tests — know `provider-non-loopback` and
 * `provider-config`, and the loopback refusal in particular is documented product
 * behaviour rather than an implementation detail, so it keeps its own code and
 * sentence here while every other rule reports the shared message verbatim.
 *
 * @param {() => any} read - one validation call.
 * @returns {any} the validated value.
 * @throws {RetrievalProviderError} with provider-config or provider-non-loopback.
 */
function viaEgressRules(read) {
  try {
    return read()
  } catch (error) {
    if (!(error instanceof ModelEgressError)) throw error
    if (error.code === 'non-loopback') {
      throw new RetrievalProviderError(
        'provider-non-loopback',
        'provider.endpoint must be a literal loopback address (127.0.0.1 or ::1); remote inference needs a separate explicit egress decision',
        { cause: error },
      )
    }
    throw new RetrievalProviderError('provider-config', error.message, { cause: error })
  }
}

/**
 * Validate an operator's provider configuration.
 *
 * A config that omits enabled:true is not an error: it is the disabled default.
 * An enabled config must name its own endpoint, model and dimension; none of
 * those has a shipped default, because inventing a provider or a model is exactly
 * what this contract exists to prevent. `egress` decides which endpoint forms are
 * legal (./model-egress.js), `apiStyle` which protocol the service speaks, and
 * `apiKeyEnv` the name of the variable the credential is read from.
 *
 * @param {object|null|undefined} config - the operator's explicit configuration.
 * @returns {{enabled: false}|{enabled: true, egress: string, apiStyle: string, apiKeyEnv: string, url: string, model: string, dimensions: number, timeoutMs: number, rerank: boolean}} the normalised config.
 * @throws {RetrievalProviderError} with provider-config or provider-non-loopback.
 */
export function validateProviderConfig(config) {
  if (config === undefined || config === null) return { enabled: false }
  if (typeof config !== 'object' || Array.isArray(config)) {
    throw new RetrievalProviderError(
      'provider-config',
      'the retrieval provider config must be an object',
    )
  }
  if (config.enabled !== true) return { enabled: false }
  const egress = viaEgressRules(() => resolveEgress(config.egress, 'provider.egress'))
  const url = viaEgressRules(() => resolveEndpoint(config.endpoint, egress, 'provider.endpoint'))
  const apiKeyEnv = viaEgressRules(() => resolveKeyEnvName(config.apiKeyEnv, 'provider.apiKeyEnv'))
  const apiStyle = requireApiStyle(config.apiStyle)
  const model = requireModel(config.model)
  const dimensions = requireDimensions(config.dimensions)
  const timeoutMs = config.timeoutMs === undefined ? PROVIDER_DEFAULT_TIMEOUT_MS : config.timeoutMs
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < PROVIDER_MIN_TIMEOUT_MS ||
    timeoutMs > PROVIDER_MAX_TIMEOUT_MS
  ) {
    throw new RetrievalProviderError(
      'provider-config',
      'provider.timeoutMs must be an integer between ' +
        PROVIDER_MIN_TIMEOUT_MS +
        ' and ' +
        PROVIDER_MAX_TIMEOUT_MS,
    )
  }
  if (config.rerank !== undefined && typeof config.rerank !== 'boolean') {
    throw new RetrievalProviderError(
      'provider-config',
      'provider.rerank must be a boolean when present',
    )
  }
  const rerank = config.rerank === true
  // The OpenAI-compatible protocol has one operation, /embeddings. A service that
  // also offered /rerank would be speaking a third dialect this contract does not
  // know, so an enabled rerank is a config mistake to say out loud rather than a
  // call to fail later.
  if (apiStyle === 'openai' && rerank) {
    throw new RetrievalProviderError(
      'provider-config',
      'provider.rerank is not available with provider.apiStyle openai: the OpenAI-compatible contract has no /rerank operation',
    )
  }
  return {
    enabled: true,
    egress,
    apiStyle,
    apiKeyEnv,
    url,
    model,
    dimensions,
    timeoutMs,
    rerank,
  }
}

/** @param {unknown} model - the operator-supplied model fingerprint. @returns {string} the model. */
function requireModel(model) {
  if (typeof model !== 'string' || model.trim() === '') {
    throw new RetrievalProviderError(
      'provider-config',
      'provider.model must be a non-blank fingerprint',
    )
  }
  if (model.length > 128) {
    throw new RetrievalProviderError(
      'provider-config',
      'provider.model must be at most 128 characters',
    )
  }
  return model
}

/** @param {unknown} dimensions - the operator-supplied vector width. @returns {number} the width. */
function requireDimensions(dimensions) {
  if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > 8192) {
    throw new RetrievalProviderError(
      'provider-config',
      'provider.dimensions must be an integer between 1 and 8192',
    )
  }
  return dimensions
}

/** @param {unknown} apiStyle - the configured wire protocol. @returns {string} one of API_STYLES. */
function requireApiStyle(apiStyle) {
  if (apiStyle === undefined || apiStyle === null) return 'embed'
  if (!API_STYLES.includes(apiStyle)) {
    throw new RetrievalProviderError(
      'provider-config',
      'provider.apiStyle must be ' + API_STYLES.join(' or ') + ', got ' + JSON.stringify(apiStyle),
    )
  }
  return apiStyle
}

/** A provider that answers every call with provider-disabled and touches no transport. */
function disabledProvider() {
  const reject = async () => {
    throw new RetrievalProviderError(
      'provider-disabled',
      'the retrieval provider is disabled; no request was made',
    )
  }
  return Object.freeze({
    enabled: false,
    model: null,
    dimensions: null,
    endpoint: null,
    egress: null,
    apiStyle: null,
    embed: reject,
    rerank: reject,
  })
}

/**
 * Build the provider contract for one validated configuration.
 *
 * @param {object|null|undefined} config - the operator's explicit configuration.
 * @param {{transport?: Function}} [options] - the transport seam (default: the built-in http/https transport).
 * @returns {object} the provider: enabled/model/dimensions/endpoint/egress/apiStyle plus async embed and rerank.
 * @throws {RetrievalProviderError} when the configuration is enabled but unusable.
 */
export function createRetrievalProvider(config, { transport = defaultTransport } = {}) {
  const normalised = validateProviderConfig(config)
  if (!normalised.enabled) return disabledProvider()
  if (typeof transport !== 'function') {
    throw new RetrievalProviderError('provider-config', 'the provider transport must be a function')
  }
  const { url, model, dimensions, timeoutMs, egress, apiStyle, apiKeyEnv } = normalised
  const openAi = apiStyle === 'openai'

  /**
   * One credentialed POST to the configured service.
   *
   * The credential is resolved here, immediately before the request: a missing
   * variable therefore fails with `provider-credential` and no socket has been
   * opened. A resolved value rides as a bearer header and is then redacted out of
   * anything the failure path produces, because an upstream can echo the header it
   * was sent.
   */
  async function post(path, body, signal) {
    const secret = requireCredential(apiKeyEnv)
    const headers = secret === '' ? undefined : { authorization: 'Bearer ' + secret }
    try {
      return await sendJson(transport, { url: url + path, body, timeoutMs, signal, headers })
    } catch (error) {
      throw redacted(error, secret)
    }
  }

  return Object.freeze({
    enabled: true,
    model,
    dimensions,
    endpoint: url,
    egress,
    apiStyle,
    async embed({ texts, kind, signal } = {}) {
      const requestTexts = requireEmbedTexts(texts)
      const requestKind = requireEmbedKind(kind)
      const expected = { model, dimensions, count: requestTexts.length }
      if (!openAi) {
        // The v0.4 body stays byte-identical, which is why the field is omitted
        // rather than sent as null when the caller has no query/passage
        // distinction (test/retrieval-provider.test.js asserts the exact body).
        const body = JSON.stringify(
          requestKind === undefined
            ? { model, texts: requestTexts }
            : { model, texts: requestTexts, kind: requestKind },
        )
        return requireEmbedResponse(await post('/embed', body, signal), expected)
      }
      // The OpenAI-compatible protocol has no query/passage field: the prefix rule
      // belongs to the service, so a valid marker is validated and then dropped
      // rather than invented into a second, plugin-side prefix.
      const body = JSON.stringify({ model, input: requestTexts })
      return mapOpenAiResponse(await post('/embeddings', body, signal), expected)
    },
    async rerank({ query, candidates, signal } = {}) {
      if (normalised.rerank !== true) {
        throw new RetrievalProviderError(
          'provider-unsupported',
          'this provider is not configured for rerank; enable provider.rerank explicitly',
        )
      }
      const requestQuery = requireQuery(query)
      const requestCandidates = requireRerankCandidates(candidates)
      const body = JSON.stringify({ model, query: requestQuery, candidates: requestCandidates })
      return requireRerankResponse(await post('/rerank', body, signal), requestCandidates)
    },
  })
}

/**
 * Read the configured credential, restating the shared refusal in this contract's words.
 *
 * The name was validated at load time; only the variable's presence can fail here,
 * and it fails before any socket exists. The message names the variable, never a
 * value, and the shared error is the cause rather than the answer.
 *
 * @param {string} apiKeyEnv - the validated variable name, or "" for no credential.
 * @returns {string} the value, or "" when the route is unauthenticated.
 * @throws {RetrievalProviderError} with provider-credential.
 */
function requireCredential(apiKeyEnv) {
  try {
    return resolveCredential(apiKeyEnv)
  } catch (error) {
    if (!(error instanceof ModelEgressError)) throw error
    throw new RetrievalProviderError(
      'provider-credential',
      'provider.apiKeyEnv: ' + error.message,
      { cause: error },
    )
  }
}

/**
 * Remove the resolved credential from the text of a failure this module produces.
 *
 * Only the wrapped transport error and its own cause can carry foreign text; every
 * message built above this point is written from scratch and names no value.
 *
 * @param {Error} error - the failure to restate.
 * @param {string} secret - the credential that was sent.
 * @returns {Error} the same failure when nothing changed, otherwise a redacted copy.
 */
function redacted(error, secret) {
  if (secret === '' || !(error instanceof RetrievalProviderError)) return error
  return new RetrievalProviderError(error.code, redactSecret(error.message, secret), {
    cause: redactCause(error.cause, secret),
  })
}

/**
 * Redact the same credential out of a wrapped error's message and stack.
 *
 * The original error is replaced by a copy rather than mutated: a transport test
 * may hold the thrown object, and rewriting it would make the assertion and the
 * code describe different failures.
 *
 * @param {unknown} cause - the wrapped error.
 * @param {string} secret - the credential that was sent.
 * @returns {unknown} the original when it holds no secret, otherwise a redacted copy.
 */
function redactCause(cause, secret) {
  if (!(cause instanceof Error) || typeof cause.message !== 'string') return cause
  if (!cause.message.includes(secret)) return cause
  const copy = new Error(redactSecret(cause.message, secret))
  copy.name = cause.name
  if (typeof cause.stack === 'string') copy.stack = redactSecret(cause.stack, secret)
  return copy
}

/**
 * Validate one embed batch before any request exists.
 *
 * @param {unknown} texts - the caller's chunks.
 * @returns {string[]} the texts to send.
 * @throws {RetrievalProviderError} with provider-request.
 */
function requireEmbedTexts(texts) {
  if (!Array.isArray(texts) || texts.length === 0 || texts.length > PROVIDER_MAX_EMBED_TEXTS) {
    throw new RetrievalProviderError(
      'provider-request',
      'embed.texts must contain between 1 and ' + PROVIDER_MAX_EMBED_TEXTS + ' texts',
    )
  }
  for (const text of texts) {
    if (typeof text !== 'string' || text.trim() === '') {
      throw new RetrievalProviderError(
        'provider-request',
        'every embed text must be a non-blank string',
      )
    }
    if ([...text].length > PROVIDER_MAX_TEXT_CHARS) {
      throw new RetrievalProviderError(
        'provider-request',
        'an embed text exceeds the ' + PROVIDER_MAX_TEXT_CHARS + '-code-point bound',
      )
    }
  }
  return texts.slice()
}

/**
 * Validate the optional query/passage marker of an embed batch.
 *
 * e5-family models embed a query and a passage differently; the contract carries
 * that distinction as a field instead of the plugin rewriting text, so the
 * provider keeps ownership of its own prefix rule. Absent means "no distinction"
 * and must not change the request body. The marker is validated under either
 * apiStyle — a caller passing an unknown one is a bug in either dialect — and the
 * openai style simply does not transmit it.
 *
 * @param {unknown} kind - the caller's optional marker.
 * @returns {string|undefined} the marker when one was passed.
 * @throws {RetrievalProviderError} with provider-request.
 */
function requireEmbedKind(kind) {
  if (kind === undefined) return undefined
  if (kind !== 'query' && kind !== 'passage') {
    throw new RetrievalProviderError(
      'provider-request',
      'embed.kind must be either "query" or "passage" when present',
    )
  }
  return kind
}

/** @param {unknown} query - the rerank query. @returns {string} the non-blank query. */
function requireQuery(query) {
  if (typeof query !== 'string' || query.trim() === '') {
    throw new RetrievalProviderError('provider-request', 'rerank.query must be a non-blank string')
  }
  return query
}

/**
 * Validate one rerank candidate list before any request exists.
 *
 * @param {unknown} candidates - the caller's candidates.
 * @returns {object[]} the candidates to send.
 * @throws {RetrievalProviderError} with provider-request.
 */
function requireRerankCandidates(candidates) {
  if (
    !Array.isArray(candidates) ||
    candidates.length === 0 ||
    candidates.length > PROVIDER_MAX_RERANK_CANDIDATES
  ) {
    throw new RetrievalProviderError(
      'provider-request',
      'rerank.candidates must contain between 1 and ' + PROVIDER_MAX_RERANK_CANDIDATES + ' items',
    )
  }
  const ids = new Set()
  let total = 0
  const checked = []
  for (const candidate of candidates) {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new RetrievalProviderError(
        'provider-request',
        'every rerank candidate must be an object',
      )
    }
    if (typeof candidate.id !== 'string' || candidate.id.trim() === '') {
      throw new RetrievalProviderError(
        'provider-request',
        'every rerank candidate needs a non-blank id',
      )
    }
    if (ids.has(candidate.id)) {
      throw new RetrievalProviderError('provider-request', 'rerank candidate ids must be unique')
    }
    if (typeof candidate.text !== 'string' || candidate.text.trim() === '') {
      throw new RetrievalProviderError(
        'provider-request',
        'every rerank candidate needs non-blank text',
      )
    }
    ids.add(candidate.id)
    total += [...candidate.text].length
    checked.push({ id: candidate.id, text: candidate.text })
  }
  if (total > PROVIDER_MAX_RERANK_CHARS) {
    throw new RetrievalProviderError(
      'provider-request',
      'rerank candidate text exceeds the ' + PROVIDER_MAX_RERANK_CHARS + '-code-point bound',
    )
  }
  return checked
}

/**
 * One POST that returns parsed JSON, with the redirect and status rules applied.
 *
 * @param {Function} transport - the transport seam.
 * @param {{url: string, body: string, timeoutMs: number, signal?: AbortSignal, headers?: object}} request - the request to send; `headers` is the route's own additions (the credential), never a body.
 * @returns {Promise<unknown>} the parsed JSON body.
 * @throws {RetrievalProviderError} on transport, redirect, status, byte-bound or parse failure.
 */
async function sendJson(transport, { url, body, timeoutMs, signal, headers }) {
  if (signal !== undefined && signal !== null && signal.aborted === true) {
    throw new RetrievalProviderError(
      'provider-aborted',
      'the provider request was already cancelled',
    )
  }
  let response
  try {
    response = await transport({
      url,
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
      body,
      timeoutMs,
      signal,
    })
  } catch (error) {
    if (error instanceof RetrievalProviderError) throw error
    if (error?.name === 'AbortError') {
      throw new RetrievalProviderError('provider-aborted', 'the provider request was cancelled', {
        cause: error,
      })
    }
    throw new RetrievalProviderError(
      'provider-transport',
      'the provider request failed before a response arrived',
      { cause: error },
    )
  }
  if (response === null || typeof response !== 'object') {
    throw new RetrievalProviderError(
      'provider-response',
      'the provider transport returned no response object',
    )
  }
  const status = response.status
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    throw new RetrievalProviderError(
      'provider-response',
      'the provider response has no valid status',
    )
  }
  if (status >= 300 && status <= 399) {
    throw new RetrievalProviderError(
      'provider-redirect',
      'the provider answered with a redirect; redirects are never followed',
    )
  }
  if (status !== 200) {
    throw new RetrievalProviderError(
      'provider-response',
      'the provider answered with status ' + status,
    )
  }
  const text = response.body
  if (typeof text !== 'string') {
    throw new RetrievalProviderError('provider-response', 'the provider response body is not text')
  }
  if (Buffer.byteLength(text, 'utf8') > PROVIDER_MAX_RESPONSE_BYTES) {
    throw new RetrievalProviderError(
      'provider-response',
      'the provider response exceeded the ' + PROVIDER_MAX_RESPONSE_BYTES + '-byte bound',
    )
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new RetrievalProviderError('provider-response', 'the provider response is not valid JSON')
  }
}

/**
 * Map one OpenAI-compatible /embeddings reply onto this plugin's own contract.
 *
 * The upstream order is only meaningful when every item carries an `index`: a
 * complete permutation is restored to request order rather than trusted, and an
 * index that is missing (on some or all items), repeated or out of range is a
 * coded refusal instead of a silent reordering or truncation. The mapped vectors
 * then go through requireEmbedResponse, so width, component and count checks are
 * the same function the /embed contract uses rather than a second copy with its
 * own wording. The configured model and dimension are what the wrapped object
 * states: this dialect has no reason to echo them, and the configured values are
 * what the caller was promised.
 *
 * @param {unknown} parsed - the parsed JSON body.
 * @param {{model: string, dimensions: number, count: number}} expected - the request contract.
 * @returns {{model: string, dimensions: number, vectors: number[][]}} the validated result.
 * @throws {RetrievalProviderError} with provider-response.
 */
function mapOpenAiResponse(parsed, expected) {
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    !Array.isArray(parsed.data)
  ) {
    throw new RetrievalProviderError(
      'provider-response',
      'the embeddings response must carry a data array',
    )
  }
  const data = orderByIndex(parsed.data, expected.count)
  return requireEmbedResponse(
    {
      model: expected.model,
      dimensions: expected.dimensions,
      vectors: data.map((item) =>
        item !== null && typeof item === 'object' ? item.embedding : undefined,
      ),
    },
    expected,
  )
}

/**
 * Restore request order when an /embeddings reply carries indices.
 *
 * @param {object[]} data - the response rows.
 * @param {number} count - how many embeddings were requested.
 * @returns {object[]} the rows in request order (the original array when unindexed).
 * @throws {RetrievalProviderError} with provider-response.
 */
function orderByIndex(data, count) {
  const indexed = data.some(
    (item) => item !== null && typeof item === 'object' && item.index !== undefined,
  )
  if (!indexed) return data
  const seen = new Set()
  for (const item of data) {
    const index = item === null || typeof item !== 'object' ? undefined : item.index
    if (!Number.isInteger(index) || index < 0 || index >= count || seen.has(index)) {
      throw new RetrievalProviderError(
        'provider-response',
        'the embeddings response index must be a distinct integer per requested text',
      )
    }
    seen.add(index)
  }
  return [...data].sort((left, right) => left.index - right.index)
}

/**
 * Validate an embed response against the configuration that asked for it.
 *
 * @param {unknown} parsed - the parsed JSON body.
 * @param {{model: string, dimensions: number, count: number}} expected - the request contract.
 * @returns {{model: string, dimensions: number, vectors: number[][]}} the validated result.
 * @throws {RetrievalProviderError} with provider-model or provider-response.
 */
function requireEmbedResponse(parsed, { model, dimensions, count }) {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new RetrievalProviderError('provider-response', 'the embed response must be an object')
  }
  if (parsed.model !== model) {
    throw new RetrievalProviderError(
      'provider-model',
      'the embed response does not name the configured model fingerprint',
    )
  }
  if (parsed.dimensions !== dimensions) {
    throw new RetrievalProviderError(
      'provider-response',
      'the embed response dimensions do not match the configured dimensions',
    )
  }
  if (!Array.isArray(parsed.vectors) || parsed.vectors.length !== count) {
    throw new RetrievalProviderError(
      'provider-response',
      'the embed response must carry one vector per requested text',
    )
  }
  const vectors = []
  for (const vector of parsed.vectors) {
    if (!Array.isArray(vector) || vector.length !== dimensions) {
      throw new RetrievalProviderError(
        'provider-response',
        'every embed vector must have exactly the configured dimensions',
      )
    }
    for (const value of vector) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new RetrievalProviderError(
          'provider-response',
          'every embed component must be a finite number',
        )
      }
    }
    vectors.push(vector.slice())
  }
  return { model, dimensions, vectors }
}

/**
 * Validate a rerank response against the candidates that were sent.
 *
 * @param {unknown} parsed - the parsed JSON body.
 * @param {object[]} candidates - the validated request candidates.
 * @returns {object[]} the validated id/score list, in the service's order.
 * @throws {RetrievalProviderError} with provider-response.
 */
function requireRerankResponse(parsed, candidates) {
  if (!Array.isArray(parsed) || parsed.length > candidates.length) {
    throw new RetrievalProviderError(
      'provider-response',
      'the rerank response must be an array no longer than the candidate list',
    )
  }
  const ids = new Set(candidates.map((candidate) => candidate.id))
  const seen = new Set()
  const ranked = []
  for (const item of parsed) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new RetrievalProviderError('provider-response', 'every rerank item must be an object')
    }
    if (typeof item.id !== 'string' || !ids.has(item.id)) {
      throw new RetrievalProviderError(
        'provider-response',
        'a rerank item names an id that was not among the candidates',
      )
    }
    if (seen.has(item.id)) {
      throw new RetrievalProviderError('provider-response', 'a rerank id appears more than once')
    }
    if (typeof item.score !== 'number' || !Number.isFinite(item.score)) {
      throw new RetrievalProviderError(
        'provider-response',
        'every rerank score must be a finite number',
      )
    }
    seen.add(item.id)
    ranked.push({ id: item.id, score: item.score })
  }
  return ranked
}

/**
 * The built-in transport: one node:http(s) POST, never a redirect, bounded body.
 *
 * Node's http client does not follow redirects on its own, so the only redirect
 * handling is the explicit refusal in sendJson. The timeout is a hard destroy, and
 * an aborted signal destroys the request rather than leaving it to complete.
 *
 * @param {{url: string, method: string, headers: object, body: string, timeoutMs: number, signal?: AbortSignal}} request - the request.
 * @returns {Promise<{status: number, headers: object, body: string}>} the response.
 */
function defaultTransport({ url, method, headers, body, timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const library = target.protocol === 'https:' ? https : http
    let settled = false
    const fail = (error) => {
      if (settled) return
      settled = true
      reject(error)
    }
    const request = library.request(target, { method, headers }, (response) => {
      const chunks = []
      let size = 0
      response.on('data', (chunk) => {
        size += chunk.length
        if (size > PROVIDER_MAX_RESPONSE_BYTES) {
          request.destroy(
            new RetrievalProviderError(
              'provider-response',
              'the provider response exceeded the ' + PROVIDER_MAX_RESPONSE_BYTES + '-byte bound',
            ),
          )
          return
        }
        chunks.push(chunk)
      })
      response.on('end', () => {
        if (settled) return
        settled = true
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        })
      })
      response.on('error', (error) => {
        fail(
          new RetrievalProviderError('provider-transport', 'the provider response stream failed', {
            cause: error,
          }),
        )
      })
    })
    request.setTimeout(timeoutMs, () => {
      request.destroy(
        new RetrievalProviderError('provider-timeout', 'the provider request exceeded its timeout'),
      )
    })
    request.on('error', (error) => {
      if (error instanceof RetrievalProviderError) return fail(error)
      if (signal !== undefined && signal !== null && signal.aborted === true) {
        return fail(
          new RetrievalProviderError('provider-aborted', 'the provider request was cancelled', {
            cause: error,
          }),
        )
      }
      fail(
        new RetrievalProviderError('provider-transport', 'the provider request failed', {
          cause: error,
        }),
      )
    })
    if (signal !== undefined && signal !== null) {
      signal.addEventListener(
        'abort',
        () => {
          request.destroy(
            new RetrievalProviderError('provider-aborted', 'the provider request was cancelled'),
          )
        },
        { once: true },
      )
    }
    request.end(body)
  })
}
