// The one locale vocabulary the server-side panel modules share.
//
// The browser halves of the panel are served as standalone ES modules (see
// lib/panel-route.js's DEFAULT_ASSETS), so they cannot import this file; each
// carries the same tiny normalization rule inline. Everything that runs in Node
// points here instead, and test/locale.test.js pins the rule itself.

/** The languages this build can answer in. */
export const SUPPORTED_LOCALES = Object.freeze(['zh', 'en'])

/** The source language: what an unidentified caller gets. */
export const DEFAULT_LOCALE = 'zh'

/**
 * Map one language tag onto a supported locale, or null when it is not one.
 *
 * Only the primary subtag matters: zh-Hans-CN and zh-CN both answer in Chinese,
 * and the panel's copy has no regional variants.
 */
export function normalizeLocale(value) {
  if (typeof value !== 'string') return null
  const tag = value.trim().toLowerCase()
  if (tag === '') return null
  const base = tag.split(/[-_]/u)[0]
  return SUPPORTED_LOCALES.includes(base) ? base : null
}

/**
 * Split an Accept-Language header into its entries and their q-values.
 *
 * A q of zero is a refusal and an unparsable q counts as zero: parsing lives in
 * one place so the preference lookup and the wildcard check below cannot
 * disagree about what the header says. Wildcards stay in the output — '*' means
 * "anything is acceptable", which the callers treat as no preference, the
 * opposite of a language choice.
 *
 * @param {string} header - the raw header value.
 * @returns {Array<{tag: string, quality: number}>} the header's entries.
 */
function acceptLanguageEntries(header) {
  if (typeof header !== 'string' || header.trim() === '') return []
  const entries = []
  for (const part of header.split(',')) {
    const [tagPart, ...params] = part.split(';')
    let quality = 1
    for (const param of params) {
      const [name, raw] = param.split('=')
      if (name.trim().toLowerCase() !== 'q') continue
      const parsed = Number.parseFloat(raw)
      quality = Number.isFinite(parsed) ? parsed : 0
    }
    entries.push({ tag: tagPart.trim().toLowerCase(), quality })
  }
  return entries
}

/**
 * Pick the most preferred supported locale out of an Accept-Language header.
 *
 * The header is a comma-separated list with optional q-values; a higher q wins
 * and ties keep the header's order. A q of zero is a refusal, not a preference,
 * and anything unparsable is ignored rather than defaulted, so a malformed
 * header behaves like a missing one and resolveLocale decides.
 *
 * @param {string} header - the raw header value.
 * @returns {string|null} the locale, or null when the header names none.
 */
export function localeFromAcceptLanguage(header) {
  let best = null
  let bestQuality = 0
  for (const { tag, quality } of acceptLanguageEntries(header)) {
    const locale = normalizeLocale(tag)
    if (locale === null) continue
    if (quality <= 0 || quality <= bestQuality) continue
    best = locale
    bestQuality = quality
  }
  return best
}

/**
 * Whether the header names at least one concrete language the caller accepts.
 *
 * A wildcard is not a preference: '*' says anything is fine, so a header of
 * just '*' — Node's fetch sends exactly that by default — must behave like a
 * missing header rather than picking English. A concrete tag this build cannot
 * speak, and does not refuse, still proves the caller did not ask for Chinese.
 *
 * @param {string} header - the raw header value.
 * @returns {boolean} whether a concrete, accepted tag is present.
 */
function namesAcceptedLanguage(header) {
  return acceptLanguageEntries(header).some(
    (entry) => entry.tag !== '' && entry.tag !== '*' && entry.quality > 0,
  )
}

/**
 * Resolve the locale for one panel request: an explicit locale field first, then
 * the request's Accept-Language, then the default.
 *
 * A header that names only languages this build cannot speak resolves to English
 * rather than Chinese: the header proves the caller did not ask for Chinese, and
 * English is the only other copy this build has. A wildcard-only or missing
 * header proves nothing, so it gets the source language; that is what keeps
 * Node's default accept-language: * from flipping every headerless caller.
 *
 * @param {object} [input] - '{ value, acceptLanguage }'.
 * @returns {string} one of SUPPORTED_LOCALES.
 */
export function resolveLocale({ value, acceptLanguage } = {}) {
  const explicit = normalizeLocale(value)
  if (explicit !== null) return explicit
  const preferred = localeFromAcceptLanguage(acceptLanguage)
  if (preferred !== null) return preferred
  if (namesAcceptedLanguage(acceptLanguage)) return 'en'
  return DEFAULT_LOCALE
}
