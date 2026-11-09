// The HTTP transport for the one tool-free model call, dressed as the host's `llm`.
//
// Distillation and the automatic curation reviewer both talk to a model through exactly
// one call, and until now that call could only be `ctx.get('llm').stream(...)`. A host
// with no routed provider (the Codex adapter, a TUI with no provider, a CLI run) had no
// distillation at all, and an operator with an OpenAI-compatible gateway had no way to
// point the plugin at it. This module is that adapter: a plain `{stream(options)}`
// object answering in the host's own measured chunk vocabulary
// (`docs/p0-compatibility.md` §8.3, restated at the top of `lib/distill.js`), so
// `lib/distill.js`, `lib/capture.js` and `lib/curation-auto.js` cannot tell it apart
// from the host.
//
// Three rules shape it, and each one is a measured host fact rather than taste:
//
//   * **`stream()` never throws synchronously.** The host contract makes a synchronous
//     refusal a deferred job and an in-stream failure a verdict, so the two are not
//     interchangeable: every failure here is the last chunk instead — `finish` with
//     `reason.kind === 'error'` or `'aborted'`. The route itself is validated once, at
//     construction, so a per-call mistake is the only remaining source of a throw, and
//     even that is caught inside the generator (the generator body does not run until
//     the first `next()`, which is what makes the synchronous return safe).
//   * **The whole text is authoritative, not the deltas.** `lib/distill.js` prefers
//     `block-end.block.text` over the accumulated deltas (a consumer joins blocks), so
//     the adapter accumulates every delta and emits one `block-end` carrying the
//     complete text, then `usage`, then `finish`. An aborted or failed stream carries
//     neither `block-end` nor `usage`, exactly as the consumers already tolerate.
//   * **Nothing the credential or the user text touched may appear in a diagnostic.**
//     A non-2xx answer is reported as its status code alone: the upstream body is never
//     echoed (it can repeat the prompt) and never parsed. The credential is read when a
//     request is about to be made — never at construction — lives in one `Authorization`
//     header, and is never logged or copied into a message.
//
// The module is a leaf on purpose: it imports `node:http`, `node:https` and
// `./model-egress.js` and nothing else, so the host entry can build it without dragging
// the provider contract or the vault in, and `model-egress` stays the single copy of the
// egress and credential rules that both transports obey.
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

import {
  ModelEgressError,
  resolveCredential,
  resolveEgress,
  resolveEndpoint,
  resolveKeyEnvName,
} from './model-egress.js'

/** The one wire protocol this adapter speaks; the config vocabulary closes it. */
const OPENAI_CHAT = 'openai-chat'
/** `distill.timeoutMs`'s default, used when a route states no budget of its own. */
const DEFAULT_TIMEOUT_MS = 60000
/** A larger budget is not a budget but a hang spelled as a number. */
const MAX_TIMEOUT_MS = 600000
/** The single text block the host reads back; a reasoning block is not an answer. */
const BLOCK_INDEX = 0
/** The SSE field name; the optional space after the colon is tolerated. */
const DATA_FIELD = 'data:'
/** The block type the adapter opens, streams and closes. */
const TEXT_BLOCK = Object.freeze({ type: 'text' })
/** The `block-start` chunk, a constant of the host contract rather than per-call state. */
const BLOCK_START = Object.freeze({ type: 'block-start', index: BLOCK_INDEX, block: TEXT_BLOCK })

/**
 * Build one route that answers like the host `llm` service over
 * `POST <endpoint>/chat/completions`.
 *
 * The constructor is the only place a configuration mistake can be reported as a
 * throw: it applies the shared egress rules (`./model-egress.js`) and resolves the
 * endpoint once, so no call has to re-validate and no call can fail for a reason the
 * operator could have been told at startup. The credential is deliberately *not*
 * resolved here — an absent environment variable is a per-request condition, and a
 * route that cannot be built is a different complaint from a request that cannot be
 * sent.
 *
 * @param {object} [config] - the route configuration.
 * @param {string} [config.endpoint] - the service base URL; loopback unless remote.
 * @param {"loopback"|"remote"} [config.egress] - the operator's egress decision.
 * @param {"openai-chat"} [config.apiStyle] - the only wire protocol offered today.
 * @param {string} [config.apiKeyEnv] - the NAME of the credential variable, never the value.
 * @param {string} [config.model] - the default model the route names.
 * @param {string} [config.provider] - the host route name this adapter stands in for.
 * @param {number} [config.timeoutMs] - the per-request budget in milliseconds.
 * @param {{[key: string]: string|undefined}} [config.env] - the environment to read the
 *   credential from; absent means `process.env`.
 * @returns {{stream: Function, endpoint: string, model: string, provider: string, egress: string, apiStyle: string}} the route.
 * @throws {ModelEgressError} for an egress, endpoint or credential-name refusal.
 * @throws {TypeError} for an unsupported `apiStyle` or a `timeoutMs` that is not a budget.
 */
export function createHttpLlmRoute(config = {}) {
  const settings = config !== null && typeof config === 'object' ? config : {}
  const apiStyle = normalizeStyle(settings.apiStyle)
  const egress = resolveEgress(settings.egress, 'distill.egress')
  const endpoint = resolveEndpoint(settings.endpoint, egress, 'distill.endpoint')
  const keyEnv = resolveKeyEnvName(settings.apiKeyEnv, 'distill.apiKeyEnv')
  const timeoutMs = normalizeTimeout(settings.timeoutMs)
  const routeModel = typeof settings.model === 'string' ? settings.model.trim() : ''
  const routeProvider = typeof settings.provider === 'string' ? settings.provider.trim() : ''
  const env = settings.env
  // `resolveEndpoint` has already proved this parses and carries no query or fragment.
  const target = new URL(endpoint + '/chat/completions')

  return {
    endpoint,
    model: routeModel,
    // The host route name is not part of the wire format, but an object pretending to
    // be `llm` also has to be able to *state* its route (the panel and the distiller
    // read it); the value is configuration, never a credential.
    provider: routeProvider,
    egress,
    apiStyle,
    /**
     * The host `llm` seam: a synchronous async iterable of host-shaped chunks.
     *
     * A synchronous return is the contract, not a convenience: the generator body does
     * not execute until the first `next()`, so every failure — the credential, the
     * socket, the status line, the parse — is a terminal `finish` chunk rather than a
     * throw in the caller's synchronous path.
     *
     * @param {{provider?: string, model?: string, messages?: object[], system?: string, maxTokens?: number, signal?: AbortSignal}} [options] the host request.
     * @returns {AsyncIterable<object>} the chunks.
     */
    stream(options) {
      return completions(options)
    },
  }

  /**
   * The one call, as an async iterable of host-shaped chunks.
   *
   * @param {unknown} options - the host request; a malformed one is an error chunk.
   * @returns {AsyncGenerator<object>} the chunk stream.
   */
  async function* completions(options) {
    const call = options !== null && typeof options === 'object' ? options : {}
    let composed = null
    let answer = null
    try {
      const body = JSON.stringify(requestBody(call, routeModel))
      const credential = resolveCredential(keyEnv, environmentOf(env))
      const budget = AbortSignal.timeout(timeoutMs)
      const caller = call.signal instanceof AbortSignal ? call.signal : null
      composed = caller === null ? budget : AbortSignal.any([caller, budget])
      answer = await sendBody(target, body, credential, composed)

      const status = answer.statusCode ?? 0
      if (status < 200 || status >= 300) {
        // The body may repeat the prompt or the credential; it is dropped, not parsed.
        answer.resume()
        yield failureHunk('HTTP_' + status, 'the model endpoint answered HTTP ' + status)
        return
      }

      // A TCP chunk ends where the packet ended, which is not necessarily a character
      // boundary: a raw Buffer appended into the string accumulator would freeze the
      // bytes of a split multi-byte character into U+FFFD before the line is parsed.
      // `setEncoding('utf8')` reads through a StringDecoder, which holds an incomplete
      // sequence until the next chunk arrives.
      answer.setEncoding('utf8')
      yield BLOCK_START
      const state = { text: '', usage: null, done: false, failed: false, truncated: false }
      /** Text of one SSE line, or '' when the line contributes none. */
      let pending = ''
      for await (const piece of answer) {
        pending += piece
        let newline = pending.indexOf('\n')
        while (newline >= 0) {
          const line = pending.slice(0, newline)
          pending = pending.slice(newline + 1)
          const delta = readSseLine(line, state)
          if (delta !== '') yield deltaHunk(delta)
          if (state.failed === true || state.done === true) break
          newline = pending.indexOf('\n')
        }
        if (state.failed === true || state.done === true) break
      }
      // A final line the server did not terminate with a newline is still a line.
      if (state.failed === false && state.done === false && pending !== '') {
        const delta = readSseLine(pending, state)
        if (delta !== '') yield deltaHunk(delta)
      }
      // An abort destroys the socket, and a destroyed socket ends the iterator the way
      // a complete one does; the signal is the only thing that tells them apart. A
      // truncated answer must never be dressed as a complete one.
      if (state.failed === false && isAborted(composed)) {
        yield abortHunk(composed)
        return
      }
      if (state.failed === true) {
        yield failureHunk('UPSTREAM', 'the model endpoint reported an error mid-stream')
        return
      }
      yield { type: 'block-end', index: BLOCK_INDEX, block: { type: 'text', text: state.text } }
      if (state.usage !== null) yield { type: 'usage', usage: state.usage }
      // `length` is the OpenAI spelling of the host's own `max-tokens` verdict; the
      // consumers refuse a truncated answer rather than parse half of one.
      yield { type: 'finish', reason: { kind: state.truncated ? 'max-tokens' : 'stop' } }
    } catch (error) {
      // A refusal from the credential rules is the operator's own code, already
      // redacted; everything else is either the caller's abort or a transport failure.
      if (error instanceof ModelEgressError) {
        yield failureHunk(error.code, error.message)
        return
      }
      // No signal exists yet, so nothing was sent: the request itself is at fault
      // (a missing model, an unreadable options object).
      if (composed === null) {
        yield failureHunk('REQUEST', 'the model request could not be built')
        return
      }
      yield abortHunk(composed)
    } finally {
      if (answer !== null && answer.destroyed === false) answer.destroy()
    }
  }
}

/**
 * Push one request into the endpoint and hand back the response head.
 *
 * The body is written once and the socket is closed at end-of-body; the caller owns
 * the response stream from there. An abort on the composed signal destroys the socket,
 * which is what makes `finish {kind:'aborted'}` prompt rather than waiting for the
 * server to notice.
 *
 * @param {URL} target - the resolved `/chat/completions` URL.
 * @param {string} body - the serialised request body.
 * @param {string} credential - the header value, or '' for an unauthenticated route.
 * @param {AbortSignal} signal - the composed caller/timeout signal.
 * @returns {Promise<import('node:http').IncomingMessage>} the response.
 */
function sendBody(target, body, credential, signal) {
  return new Promise((resolve, reject) => {
    const send = target.protocol === 'https:' ? httpsRequest : httpRequest
    /** @type {{[key: string]: string|number}} */
    const headers = {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'content-length': Buffer.byteLength(body),
    }
    // The one place the value exists. It is never logged and never in a message.
    if (credential !== '') headers.authorization = 'Bearer ' + credential
    const socket = send(
      {
        method: 'POST',
        // `new URL()` keeps the brackets on an IPv6 literal; `http.request` wants bare.
        hostname: target.hostname.startsWith('[') ? target.hostname.slice(1, -1) : target.hostname,
        port: target.port === '' ? (target.protocol === 'https:' ? 443 : 80) : Number(target.port),
        path: target.pathname,
        headers,
        signal,
      },
      resolve,
    )
    socket.on('error', reject)
    socket.end(body)
  })
}

/**
 * Turn one host request into the `/chat/completions` body.
 *
 * The host's messages carry structured content parts; the wire protocol wants one
 * string per message, and only `text` parts are ever an answer (a reasoning or tool
 * part is not). `provider` is not part of the OpenAI wire format and is not sent.
 *
 * @param {object} call - the host request.
 * @param {string} routeModel - the constructor's model, used when the call names none.
 * @returns {object} the request body.
 * @throws {TypeError} when no model is named anywhere.
 */
function requestBody(call, routeModel) {
  const model = typeof call.model === 'string' && call.model !== '' ? call.model : routeModel
  if (model === '') throw new TypeError('the http model route needs a model')
  /** @type {{role: string, content: string}[]} */
  const messages = []
  if (typeof call.system === 'string' && call.system !== '') {
    messages.push({ role: 'system', content: call.system })
  }
  if (Array.isArray(call.messages)) {
    for (const message of call.messages) messages.push(chatMessage(message))
  }
  /** @type {{model: string, messages: object[], stream: boolean, max_tokens?: number}} */
  const body = { model, messages, stream: true }
  const maxTokens = typeof call.maxTokens === 'number' ? call.maxTokens : NaN
  if (Number.isSafeInteger(maxTokens) && maxTokens > 0) body.max_tokens = maxTokens
  return body
}

/**
 * One host message as one wire message.
 *
 * @param {unknown} message - a host message.
 * @returns {{role: string, content: string}} the wire message.
 */
function chatMessage(message) {
  const record = message !== null && typeof message === 'object' ? message : {}
  const role =
    typeof record.role === 'string' && record.role !== '' && record.role !== 'system'
      ? record.role
      : 'user'
  return { role, content: textOf(record.content) }
}

/**
 * Flatten a host content value into the one string the wire protocol accepts.
 *
 * @param {unknown} content - a string or an array of content parts.
 * @returns {string} the text, in part order.
 */
function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const part of content) {
    const record = part !== null && typeof part === 'object' ? part : {}
    if (record.type === 'text' && typeof record.text === 'string') text += record.text
  }
  return text
}

/**
 * Read one SSE line into the accumulated answer.
 *
 * Only `data:` fields carry an answer. A keep-alive comment, an `event:` field and a
 * `[DONE]` sentinel are not text; a payload that is not JSON (some gateways send a
 * bare trace line) is ignored rather than aborting an otherwise good stream, and an
 * `error` object is recorded so the caller can end with a verdict instead of a
 * half-written answer.
 *
 * @param {string} line - one line, without its terminator.
 * @param {{text: string, usage: object|null, done: boolean, failed: boolean, truncated: boolean}} state - the accumulated answer.
 * @returns {string} the text this line contributes, or ''.
 */
function readSseLine(line, state) {
  if (!line.startsWith(DATA_FIELD)) return ''
  const data = line.slice(DATA_FIELD.length).trim()
  if (data === '') return ''
  if (data === '[DONE]') {
    state.done = true
    return ''
  }
  /** @type {any} */
  let payload
  try {
    payload = JSON.parse(data)
  } catch {
    return ''
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return ''
  if (payload.error !== undefined && payload.error !== null) {
    state.failed = true
    return ''
  }
  if (payload.usage !== undefined && payload.usage !== null) state.usage = usageOf(payload.usage)
  const choice = Array.isArray(payload.choices) ? payload.choices[0] : null
  if (choice === null || typeof choice !== 'object') return ''
  if (choice.finish_reason === 'length') state.truncated = true
  const delta = choice.delta
  if (delta === null || typeof delta !== 'object') return ''
  if (typeof delta.content !== 'string' || delta.content === '') return ''
  state.text += delta.content
  return delta.content
}

/**
 * Map an OpenAI `usage` object onto the host's five counters.
 *
 * Every counter is a number: a counter the endpoint did not report is 0 rather than
 * `undefined`, because the consumers print and persist `usage` and an absent field
 * would become `NaN` in an arithmetic path. A missing `total_tokens` is the sum of
 * the two halves, which is what the field means.
 *
 * @param {any} raw - the upstream usage object.
 * @returns {{inputTokens: number, outputTokens: number, totalTokens: number, cacheReadTokens: number, reasoningTokens: number}} the host usage.
 */
function usageOf(raw) {
  const inputTokens = countOf(raw.prompt_tokens)
  const outputTokens = countOf(raw.completion_tokens)
  const totalTokens = countOf(raw.total_tokens)
  const cached = raw.prompt_tokens_details
  const reasoning = raw.completion_tokens_details
  return {
    inputTokens,
    outputTokens,
    totalTokens: totalTokens === 0 ? inputTokens + outputTokens : totalTokens,
    cacheReadTokens: countOf(
      cached === null || typeof cached !== 'object' ? 0 : cached.cached_tokens,
    ),
    reasoningTokens: countOf(
      reasoning === null || typeof reasoning !== 'object' ? 0 : reasoning.reasoning_tokens,
    ),
  }
}

/**
 * A non-negative integer counter, or 0.
 *
 * @param {unknown} value - the upstream counter.
 * @returns {number} the counter.
 */
function countOf(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0
}

/**
 * The terminal `error` chunk.
 *
 * @param {string} code - the machine-readable reason; never a body or a credential.
 * @param {string} message - one sentence of operator-facing context.
 * @returns {object} the chunk.
 */
function failureHunk(code, message) {
  return { type: 'finish', reason: { kind: 'error', failure: { code, message } } }
}

/**
 * The terminal `aborted` chunk for a socket that ended under us.
 *
 * The composed signal is the only verdict, exactly as in `lib/distill.js`: a
 * `TimeoutError` reason is a timeout and an `AbortError` reason is a caller cancel. A
 * socket that closed with no abort at all is a transport failure, not a cancellation.
 *
 * @param {AbortSignal|null} composed - the caller/timeout signal.
 * @returns {object} the chunk.
 */
function abortHunk(composed) {
  if (isAborted(composed)) {
    const timeout = composed.reason?.name === 'TimeoutError'
    return {
      type: 'finish',
      reason: {
        kind: 'aborted',
        failure: {
          code: timeout ? 'TIMEOUT' : 'ABORTED',
          message: timeout
            ? 'the model request exceeded its budget'
            : 'the model request was aborted',
        },
      },
    }
  }
  return failureHunk('TRANSPORT', 'the model endpoint could not be reached')
}

/**
 * Whether the composed caller/timeout signal has fired.
 *
 * @param {AbortSignal|null} composed - the composed signal, or null before one exists.
 * @returns {boolean} true when the request was cancelled or timed out.
 */
function isAborted(composed) {
  return composed !== null && composed.aborted === true
}

/**
 * One `text-delta` chunk.
 *
 * @param {string} text - the delta just read.
 * @returns {object} the chunk.
 */
function deltaHunk(text) {
  return { type: 'text-delta', index: BLOCK_INDEX, text }
}

/**
 * Read the environment a credential comes from.
 *
 * @param {unknown} env - the constructor's `env`.
 * @returns {{[key: string]: string|undefined}} the environment to read.
 */
function environmentOf(env) {
  if (env === undefined || env === null) return process.env
  return typeof env === 'object' ? env : {}
}

/**
 * Normalise the wire-protocol selector.
 *
 * @param {unknown} apiStyle - the configured style.
 * @returns {string} the style.
 * @throws {TypeError} when it is not the one protocol this module speaks.
 */
function normalizeStyle(apiStyle) {
  if (apiStyle === undefined || apiStyle === null) return OPENAI_CHAT
  if (apiStyle !== OPENAI_CHAT) {
    throw new TypeError('apiStyle must be ' + OPENAI_CHAT + ', got ' + JSON.stringify(apiStyle))
  }
  return OPENAI_CHAT
}

/**
 * Normalise the per-request budget.
 *
 * @param {unknown} timeoutMs - the configured budget.
 * @returns {number} the budget in whole milliseconds.
 * @throws {TypeError} when it is not a positive, sane number of milliseconds.
 */
function normalizeTimeout(timeoutMs) {
  if (timeoutMs === undefined || timeoutMs === null) return DEFAULT_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new TypeError('timeoutMs must be a positive number of milliseconds')
  }
  return Math.floor(timeoutMs)
}
