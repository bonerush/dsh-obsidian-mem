import { isIP } from 'node:net'

// The HTTP fence, request reader and reply writer shared by every read-only
// browser route this plugin serves.
//
// Moved verbatim out of `lib/graph-route.js` when the panel route landed: two
// routes now answer on the same server, and a second copy of the same-origin
// check is a second place for the rule to drift. This module imports nothing
// from the repository, so a route that uses it stays at the bottom of the
// layer table and can be reviewed as one small security surface.

/** A body larger than this is refused before it is parsed (4 KB, spec §5.2). */
export const MAX_BODY_BYTES = 4096

/**
 * Keep memory metadata on the same local browser origin as the DSH UI.
 *
 * @param {object} request - the HTTP request.
 * @returns {boolean} whether the request may read memory metadata.
 */
export function trusted(request) {
  const address = request.socket?.remoteAddress?.toLowerCase()
  if (address !== '::1' && address !== '127.0.0.1' && address !== '::ffff:127.0.0.1') return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let authority
  try {
    authority = new URL(`http://${host}`)
  } catch {
    return false
  }
  const hostname = authority.hostname
  if (
    hostname !== 'localhost' &&
    hostname !== '[::1]' &&
    !(isIP(hostname) === 4 && hostname.startsWith('127.'))
  )
    return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === authority.host
  } catch {
    return false
  }
}

/**
 * Read one small JSON request without letting a local page stream unbounded bytes.
 *
 * @param {object} request - the HTTP request.
 * @returns {Promise<object>} the parsed body; it is always a plain object.
 * @throws {RangeError} when the body is too large, not JSON, or not an object.
 */
export async function payloadOf(request) {
  const chunks = []
  let bytes = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > MAX_BODY_BYTES) throw new RangeError('request too large')
    chunks.push(buffer)
  }
  const value = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'))
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new RangeError('request must be an object')
  return value
}

/**
 * Write one JSON envelope with the route's fixed headers.
 *
 * @param {object} response - the HTTP response.
 * @param {number} status - the HTTP status.
 * @param {unknown} value - the JSON value to send.
 * @returns {void}
 */
export function reply(response, status, value) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  response.end(JSON.stringify(value))
}
