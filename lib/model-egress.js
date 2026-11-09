// Where a model-backed feature is allowed to send text, and with what credential.
//
// Both model features (hybrid embedding, distillation) accept a local service and a
// cloud/enterprise one, so both need the same three questions answered once:
//
//   * Which endpoint forms are legal at all? A loopback-only route refuses a name
//     that could resolve elsewhere; a remote route is an explicit egress decision and
//     must be written out by the operator. Neither accepts credentials, a query or a
//     fragment inside the URL, and neither accepts a non-http(s) scheme.
//   * Is the credential present, and where does it come from? The config carries the
//     NAME of an environment variable, never a secret; the value is read when a
//     request is about to be made.
//   * How does a failure avoid leaking it? Error text and logs are redacted against the
//     resolved value, so a gateway echoing the header cannot put it in a diagnostic.
//
// This module imports nothing from the repository: both transports and the provider
// contract sit above it, and it must stay a leaf so neither can drag the other in.
import { isIP } from 'node:net'

/** The two egress modes an operator may state. */
export const EGRESS_MODES = Object.freeze(['loopback', 'remote'])
/** The only hosts a loopback route may name: literal addresses, no names. */
export const LOOPBACK_HOSTS = Object.freeze(['127.0.0.1', '::1'])
/** The longest accepted apiKeyEnv name; an env var name, not a secret. */
export const MAX_KEY_ENV_CHARS = 128

/**
 * A refusal from the egress or credential rules, with a neutral code.
 *
 * The codes are deliberately transport-independent: the provider contract maps them
 * onto its own provider-* vocabulary and the distillation transport maps them onto its
 * own, so neither has to re-implement the rules to get its own words back.
 *
 * code is one of: egress-mode, endpoint-blank, endpoint-invalid, endpoint-scheme,
 * endpoint-credentials, endpoint-query, non-loopback, credential-env-invalid,
 * credential-missing.
 */
export class ModelEgressError extends Error {
  /**
   * @param {string} code - the machine-readable reason.
   * @param {string} message - the rule that failed; never the credential or the text.
   */
  constructor(code, message) {
    super(message)
    this.name = 'ModelEgressError'
    this.code = code
  }
}

/**
 * Normalise one egress mode.
 *
 * @param {unknown} egress - the configured value.
 * @param {string} label - the dotted config path, used in the message.
 * @returns {"loopback"|"remote"} the mode; absent means loopback.
 * @throws {ModelEgressError} with egress-mode.
 */
export function resolveEgress(egress, label = 'egress') {
  if (egress === undefined || egress === null) return 'loopback'
  if (!EGRESS_MODES.includes(egress)) {
    throw new ModelEgressError(
      'egress-mode',
      label + ' must be ' + EGRESS_MODES.join(' or ') + ', got ' + JSON.stringify(egress),
    )
  }
  return egress
}

/**
 * Whether a host is a literal loopback address.
 *
 * @param {string} host - a URL hostname (brackets already removed).
 * @returns {boolean} true when the address cannot leave this machine.
 */
export function isLoopbackHost(host) {
  if (typeof host !== 'string') return false
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
  if (LOOPBACK_HOSTS.includes(bare)) return true
  // 127.0.0.0/8 is loopback by definition; a resolved DNS name is not, which is why
  // only a literal IPv4 quad is accepted here.
  return isIP(bare) === 4 && bare.split('.')[0] === '127'
}

/**
 * Validate one endpoint URL against its egress mode.
 *
 * @param {unknown} endpoint - the configured endpoint.
 * @param {"loopback"|"remote"} egress - the resolved mode.
 * @param {string} label - the dotted config path, used in the messages.
 * @returns {string} the normalised URL without a trailing slash.
 * @throws {ModelEgressError} with endpoint-blank, endpoint-invalid, endpoint-scheme,
 *   endpoint-credentials, endpoint-query or non-loopback.
 */
export function resolveEndpoint(endpoint, egress, label = 'endpoint') {
  if (typeof endpoint !== 'string' || endpoint.trim() === '') {
    throw new ModelEgressError('endpoint-blank', label + ' must be a non-blank URL')
  }
  let parsed
  try {
    parsed = new URL(endpoint)
  } catch {
    throw new ModelEgressError('endpoint-invalid', label + ' is not a valid URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ModelEgressError('endpoint-scheme', label + ' must use http or https')
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new ModelEgressError('endpoint-credentials', label + ' must not carry credentials')
  }
  // A bare `?` or `#` parses to an empty search/hash, so checking `parsed.search`
  // and `parsed.hash` misses it — yet the delimiter survives in `href`, and
  // `new URL(endpoint + '/chat/completions')` then files the suffix under the
  // query, silently requesting the wrong path. Reject the delimiters themselves.
  if (endpoint.trim().includes('?') || endpoint.trim().includes('#')) {
    throw new ModelEgressError('endpoint-query', label + ' must not carry a query or fragment')
  }
  if (egress === 'loopback') {
    const host = parsed.hostname.startsWith('[') ? parsed.hostname.slice(1, -1) : parsed.hostname
    if (!LOOPBACK_HOSTS.includes(host)) {
      throw new ModelEgressError(
        'non-loopback',
        label + ' must be a literal loopback address (127.0.0.1 or ::1) unless egress is remote',
      )
    }
  }
  return parsed.href.replace(/\/+$/, '')
}

/**
 * Validate the name of the environment variable a credential is read from.
 *
 * A name is configuration; the value is never config. An empty name means "this route
 * is unauthenticated", which is the loopback default.
 *
 * @param {unknown} apiKeyEnv - the configured variable name.
 * @param {string} label - the dotted config path, used in the message.
 * @returns {string} the name, or "" for an unauthenticated route.
 * @throws {ModelEgressError} with credential-env-invalid.
 */
export function resolveKeyEnvName(apiKeyEnv, label = 'apiKeyEnv') {
  if (apiKeyEnv === undefined || apiKeyEnv === null) return ''
  if (typeof apiKeyEnv !== 'string') {
    throw new ModelEgressError('credential-env-invalid', label + ' must be a string')
  }
  const name = apiKeyEnv.trim()
  if (name === '') return ''
  if ([...name].length > MAX_KEY_ENV_CHARS || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new ModelEgressError(
      'credential-env-invalid',
      label + ' must name an environment variable (letters, digits and underscore)',
    )
  }
  return name
}

/**
 * Read the credential a route needs, at the moment a request is about to be sent.
 *
 * @param {string} keyEnv - the validated variable name, or "" for none.
 * @param {{[key: string]: string|undefined}} [env] - the environment to read.
 * @returns {string} the value, or "" when the route carries no variable name.
 * @throws {ModelEgressError} with credential-missing when the named variable is
 *   absent or blank. The message names the variable, never its value.
 */
export function resolveCredential(keyEnv, env = process.env) {
  if (keyEnv === '' || keyEnv === undefined || keyEnv === null) return ''
  const value = env[keyEnv]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ModelEgressError(
      'credential-missing',
      'the configured credential is absent: environment variable ' + keyEnv + ' is not set',
    )
  }
  return value.trim()
}

/**
 * Replace every occurrence of a secret in one string.
 *
 * Both the raw and the JSON-escaped spelling are replaced, because an escaping layer
 * between the gateway and this process can rewrite the value before it is echoed.
 *
 * @param {string} text - the string that may contain the secret.
 * @param {string} secret - the value to remove; "" is a no-op.
 * @returns {string} the redacted string.
 */
export function redactSecret(text, secret) {
  if (typeof text !== 'string') return text
  if (typeof secret !== 'string' || secret === '') return text
  return text.split(secret).join('***')
}

/**
 * Whether one URL names the same machine (used to decide if a "remote" route is
 * really local, so a diagnostic can state the truth).
 *
 * @param {string} url - a normalised endpoint.
 * @returns {boolean} true when the host is a literal loopback address.
 */
export function isLoopbackEndpoint(url) {
  try {
    return isLoopbackHost(new URL(url).hostname)
  } catch {
    return false
  }
}
