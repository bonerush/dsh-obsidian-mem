// Eager configuration validation for the obsidian-mem host plugin.
//
// `Config` is a schemastery (Standard Schema v1) object, so Cordis runs
// `Config['~standard'].validate` against the row's `config:` *before* `apply`
// is ever called. `validateConfig` layers on the v1 range checks schemastery
// cannot express — safe-integer bounds, an open ratio, a non-blank path, and the
// unknown-key refusal `z.object` does not perform — and is written to be safely
// re-runnable on the value the host already validated.
//
// `ignoreGlobs` is validated and compiled here rather than at the point of use,
// because an operator's typo must fail the row loudly instead of silently
// mis-matching every path it was meant to exclude. The accepted language is
// deliberately tiny: `*` (within one segment), `**` (across segments), `?` (one
// character) and ordinary path characters. Brace expansion, character classes,
// negation (`!…`) and escapes are refused, so no user glob can express anything
// this plugin cannot honour exactly (Task 17).
import z from '@deepseek-ai/schemastery'

import { validateProviderConfig } from './retrieval-provider.js'

export const Config = z.object({
  enabled: z.boolean().default(true),
  vaultPath: z.string().default('~/Documents/dsh-memory'),
  initGitOnCreate: z.boolean().default(true),
  injectBrief: z.boolean().default(true),
  // The unbound-session notice (`lib/init-hint.js`). `true` means a session whose
  // directory resolves to no usable project is told once — so the user is asked
  // whether to bind it, and a session whose recorded directory has been moved or
  // deleted says so instead of losing memory in silence. It is a switch because it
  // is the one injection that is not project memory: a session in a scratch
  // directory can turn the question off without losing the brief.
  bindHint: z.boolean().default(true),
  briefBudgetChars: z.number().default(6000),
  // How a long conventions index is rendered: `summary` shows five lines and
  // leaves the rest addressable through mem_brief(section='conventions'); `flat`
  // is the pre-0.3 list where the budget alone decides. Rendering only; paging
  // always sees every unit.
  briefConventionMode: z.union([z.const('summary'), z.const('flat')]).default('summary'),
  recallBudgetChars: z.number().default(900),
  // The failure-triggered recall (Task 18). `true` means a session whose tool
  // calls begin failing in a run may retrieve the project's pitfalls mid-turn,
  // sharing `recallBudgetChars` with the prompt-driven recall rather than adding a
  // second budget. It is a switch because it is the one path that searches on
  // something other than what the user typed: a session that wants retrieval keyed
  // strictly to its own prompts can turn it off without losing the brief.
  failureRecall: z.boolean().default(true),
  hotCapacityChars: z.number().default(9000),
  hotArchiveRatio: z.number().default(0.67),
  autoCapture: z.boolean().default(true),
  // The default switch for automatic curation (Task 5). `true` means a committed
  // write or a session start may trigger one bounded pass; `false` disables those
  // automatic triggers only — `mem_admin(action="curation", operation="scan")`
  // stays available, because an operator turning automation off is not asking to
  // lose the ability to curate on demand.
  autoCurate: z.boolean().default(true),
  captureIdleMs: z.number().default(90000),
  distill: z.object({
    provider: z.string().default(''),
    model: z.string().default(''),
    maxItems: z.number().default(12),
    minConfidence: z.number().default(0.75),
    maxInputChars: z.number().default(24000),
    maxOutputTokens: z.number().default(4000),
    timeoutMs: z.number().default(60000),
    maxRetries: z.number().default(3),
    dryRun: z.boolean().default(false),
    learnHabits: z.boolean().default(true),
  }),
  indexBackend: z.union([z.const('auto'), z.const('sqlite'), z.const('scan')]).default('auto'),
  // How `mem_search` ranks. `hybrid` is the default from 2.0.0: it adds the
  // loopback dense candidate channel from ./retrieval-provider.js to the existing
  // lexical order (spec 2026-11-02). It is default-on in *engine* only — the
  // provider still ships disabled and empty, because every field describes an
  // operator's own local service and nothing here may silently invent one. With
  // no provider configured the engine resolves to the lexical path unchanged, so
  // an unconfigured row still behaves exactly as it did before v0.4; the fallback
  // is stated on every search (`hybridFallback: 'provider-disabled'`) rather than
  // implied. `sparse` reranks a bounded candidate set by local TF-IDF/cosine and
  // fuses the two orders without needing anything. `semantic` remains
  // deliberately absent: a bare word would promise a provider selection this
  // schema cannot make, which is what retrievalProvider exists to state.
  retrievalEngine: z
    .union([z.const('lexical'), z.const('sparse'), z.const('hybrid')])
    .default('hybrid'),
  // The optional loopback provider that the hybrid engine reads. It ships
  // disabled and empty: every field describes an operator's own local service,
  // so nothing here can silently invent one. The block is judged by
  // ./retrieval-provider.js rather than by a second copy of its rules.
  retrievalProvider: z.object({
    enabled: z.boolean().default(false),
    endpoint: z.string().default(''),
    model: z.string().default(''),
    dimensions: z.number().default(0),
    timeoutMs: z.number().default(500),
    rerank: z.boolean().default(false),
  }),
  ignoreGlobs: z.array(z.string()).default([]),
})

/**
 * The exact accepted key set, read back from the schema's own defaults.
 *
 * Derived rather than written twice: a second literal list would be a place for
 * the field set to drift out of the schema it is supposed to guard. Every field
 * declares a default, so `validate(undefined)` materialises all of them.
 */
const SCHEMA_DEFAULTS = Config['~standard'].validate(undefined).value
/** Accepted top-level keys. */
const CONFIG_KEYS = new Set(Object.keys(SCHEMA_DEFAULTS))
/** Accepted keys inside `distill`. */
const DISTILL_KEYS = new Set(Object.keys(SCHEMA_DEFAULTS.distill))
/** Accepted keys inside `retrievalProvider`. */
const PROVIDER_KEYS = new Set(Object.keys(SCHEMA_DEFAULTS.retrievalProvider))

/**
 * Fields the design document's §12 lists but the plan's field set drops.
 *
 * They are named in the refusal because a user copying that block gets an error
 * either way; naming them turns "unknown key" into "this was dropped on purpose,
 * go read README §Configuration".
 */
const DROPPED_BY_DESIGN = Object.freeze([
  'projectsDir',
  'methodsDir',
  'metaDir',
  'reservedPrefixes',
  'docMirror',
  'distill.mode',
  'distill.maxCostPerSession',
])

/**
 * Refuse a config object carrying a key the plan's field set does not define.
 *
 * schemastery's `z.object` is not strict: an unknown key is passed through into
 * the validated value untouched, so `{ vaultpath: '/tmp/nope' }` would silently
 * fall back to `vaultPath`'s default and point the plugin — and its bootstrap —
 * at a different vault than the operator wrote. A typo in a hand-written row
 * must be the operator's error, not a silently different vault (T3 deferred
 * minor, confirmed live by the whole-branch review).
 *
 * @param {unknown} raw - raw row config.
 * @throws {Error} naming every unknown key, and the fields dropped by design.
 */
function rejectUnknownKeys(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return
  const unknown = Object.keys(raw).filter((key) => !CONFIG_KEYS.has(key))
  // A nested block is checked the same way its parent is: an unknown key inside
  // `distill` would otherwise keep its default in silence, which
  // is the same failure the top-level check exists to prevent.
  for (const [block, accepted] of [
    ['distill', DISTILL_KEYS],
    ['retrievalProvider', PROVIDER_KEYS],
  ]) {
    const nested = raw[block]
    if (nested === null || typeof nested !== 'object' || Array.isArray(nested)) continue
    unknown.push(
      ...Object.keys(nested)
        .filter((key) => !accepted.has(key))
        .map((key) => `${block}.${key}`),
    )
  }
  if (unknown.length === 0) return
  throw new Error(
    `unknown config key${unknown.length === 1 ? '' : 's'} ${unknown.map((key) => JSON.stringify(key)).join(', ')}; ` +
      `this plugin's config is exactly ${[...CONFIG_KEYS].join(', ')} with ${[...DISTILL_KEYS].map((key) => `distill.${key}`).join(', ')} inside distill and ${[...PROVIDER_KEYS].map((key) => `retrievalProvider.${key}`).join(', ')} inside retrievalProvider. ` +
      'A key that is not in that set is refused instead of being ignored, because a typo in a known key would otherwise ' +
      'silently keep its default (for example a mistyped `vaultPath` would point the plugin at the default vault). ' +
      `The design document also lists fields that this plugin deliberately does not have and that are refused for the same reason: ${DROPPED_BY_DESIGN.join(', ')}.`,
  )
}

/** The longest accepted `ignoreGlobs` entry, in code points. */
export const IGNORE_GLOB_MAX_CHARS = 200
/**
 * The accepted alphabet: letters, numbers, marks, `.`, `_`, `-`, `/`, space and
 * the three glob operators. Everything else is unsupported syntax.
 */
const IGNORE_GLOB_ALLOWED = /^[\p{L}\p{N}\p{M}._\-/ *?]+$/u

/**
 * Assert that one `ignoreGlobs` entry is a glob this plugin can honour exactly.
 *
 * @param {unknown} glob - the candidate entry.
 * @returns {string} the entry, unchanged.
 * @throws {RangeError} when it is not a supported vault-relative glob.
 */
export function assertIgnoreGlob(glob) {
  if (typeof glob !== 'string') throw new RangeError('ignoreGlobs entries must be strings')
  const points = [...glob]
  if (points.length === 0 || glob.trim() === '')
    throw new RangeError('ignoreGlobs entries must be non-blank globs')
  if (points.length > IGNORE_GLOB_MAX_CHARS) {
    throw new RangeError(
      `ignoreGlobs entry is longer than ${IGNORE_GLOB_MAX_CHARS} characters: ${JSON.stringify(glob)}`,
    )
  }
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
  if (/[\u0000-\u001f\u007f]/.test(glob)) {
    throw new RangeError(
      `ignoreGlobs entry must not contain control characters: ${JSON.stringify(glob)}`,
    )
  }
  const unsupported = [...glob].find((character) => !IGNORE_GLOB_ALLOWED.test(character))
  if (unsupported !== undefined) {
    throw new RangeError(
      `ignoreGlobs does not support ${JSON.stringify(unsupported)} in ${JSON.stringify(glob)}; only *, **, ? and ordinary path characters are allowed`,
    )
  }
  if (glob.startsWith('/')) {
    throw new RangeError(
      `ignoreGlobs must be vault- or repository-relative, never absolute: ${JSON.stringify(glob)}`,
    )
  }
  if (glob.split('/').includes('..')) {
    throw new RangeError(`ignoreGlobs must not contain "..": ${JSON.stringify(glob)}`)
  }
  return glob
}

/**
 * Compile one supported glob into an anchored, `/`-separated path matcher.
 *
 * The glob is to be read against the path a caller offers (vault-relative or
 * repository-relative, POSIX separators). Every character that is not an
 * operator is escaped before the pattern is anchored, so a `.` in a user's glob
 * can never become a regular-expression wildcard.
 *
 * @param {string} glob - a supported glob.
 * @returns {RegExp} the anchored matcher.
 * @throws {RangeError} when the glob uses unsupported syntax.
 */
export function compileIgnoreGlob(glob) {
  assertIgnoreGlob(glob)
  let source = ''
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index]
    if (character === '*') {
      if (glob[index + 1] === '*') {
        // `**/` spans zero or more whole segments; a bare `**` spans anything.
        if (glob[index + 2] === '/') {
          source += '(?:[^/]+/)*'
          index += 2
        } else {
          source += '.*'
          index += 1
        }
      } else {
        source += '[^/]*'
      }
      continue
    }
    if (character === '?') {
      source += '[^/]'
      continue
    }
    source += /[.*+?^${}()|[\]\\]/.test(character) ? `\\${character}` : character
  }
  return new RegExp(`^${source}$`, 'u')
}

/**
 * Compile a list of globs, refusing the whole list when one entry is unsupported.
 *
 * @param {unknown} globs - the configured list.
 * @returns {RegExp[]} one anchored matcher per entry, in order.
 * @throws {RangeError} when the list or one of its entries is invalid.
 */
export function compileIgnoreGlobs(globs) {
  if (!Array.isArray(globs)) throw new RangeError('ignoreGlobs must be an array of globs')
  return globs.map((glob) => compileIgnoreGlob(glob))
}

/**
 * Whether one path matches any compiled glob.
 *
 * @param {string} path - a `/`-separated relative path.
 * @param {RegExp[]} matchers - compiled globs.
 * @returns {boolean} true when at least one glob matches.
 */
export function matchesIgnoreGlob(path, matchers) {
  return matchers.some((matcher) => matcher.test(path))
}

/**
 * Validate raw plugin config and return the normalised config object.
 *
 * The Standard Schema entry is the same one Cordis uses, so a row without a
 * `config:` block, a partial row config, and the already-validated object the
 * host hands to `apply` all resolve through one code path. Schema violations
 * surface as an `Error` listing every issue; an unknown key as an `Error` naming
 * it (and the fields the design document drops); v1 range violations as a
 * `RangeError` naming the offending field.
 *
 * @param {unknown} raw - raw row config (possibly `undefined`).
 * @returns {object} the validated config with defaults applied.
 * @throws {Error} when schemastery reports issues, or when a key is unknown.
 * @throws {RangeError} when a v1 range check fails.
 */
export function validateConfig(raw) {
  rejectUnknownKeys(raw)
  const result = Config['~standard'].validate(raw)
  if (result.issues) throw new Error(result.issues.map((x) => x.message).join('; '))
  const c = result.value
  const intRange = (key, n, min, max) => {
    if (!Number.isSafeInteger(n) || n < min || n > max) throw new RangeError(key)
  }
  intRange('briefBudgetChars', c.briefBudgetChars, 256, 20000)
  intRange('recallBudgetChars', c.recallBudgetChars, 256, 20000)
  intRange('hotCapacityChars', c.hotCapacityChars, 1024, 50000)
  intRange('captureIdleMs', c.captureIdleMs, 1000, 3600000)
  intRange('distill.maxItems', c.distill.maxItems, 1, 50)
  intRange('distill.maxInputChars', c.distill.maxInputChars, 256, 100000)
  intRange('distill.maxOutputTokens', c.distill.maxOutputTokens, 128, 32000)
  intRange('distill.timeoutMs', c.distill.timeoutMs, 1000, 300000)
  intRange('distill.maxRetries', c.distill.maxRetries, 0, 10)
  if (!(c.hotArchiveRatio > 0 && c.hotArchiveRatio < 1)) throw new RangeError('hotArchiveRatio')
  if (!(c.distill.minConfidence >= 0 && c.distill.minConfidence <= 1))
    throw new RangeError('distill.minConfidence')
  if (!c.vaultPath.trim()) throw new RangeError('vaultPath')
  if (Boolean(c.distill.provider) !== Boolean(c.distill.model))
    throw new RangeError('distill.route')
  // The provider block is judged by the contract that will read it, not by a
  // second copy of the loopback/dimension rules. An enabled provider is legal
  // with any engine (nothing calls it under lexical). Since 2.0.0 the engine
  // defaults to `hybrid` while the provider defaults to disabled, so "hybrid with
  // no provider" is the *shipped* row and must load: it is not a config that
  // cannot be honoured, it is one that asked for an optional channel and did not
  // supply it. `search` answers from the lexical branch and states
  // `provider-disabled` in the search diagnostics, so the state is visible rather
  // than implied. What stays refused is the incoherent row: `enabled: true` with
  // an unusable endpoint, which is checked above by validateProviderConfig.
  const provider = validateProviderConfig(c.retrievalProvider)
  // The shipped row since 2.0.0 is `hybrid` with a disabled provider, so this
  // combination has to load. It is not a config that cannot be honoured: it asked
  // for an optional channel and did not supply one, and `services.search` answers
  // from the lexical branch with `provider-disabled` on the search event. What
  // stays refused is an *enabled* provider that cannot be used (remote endpoint,
  // blank model, non-integer width) — validateProviderConfig above throws on each.
  // Nothing needs the parsed provider handle here; no throw, no rewrite.
  void provider
  // Unsupported glob syntax is refused here, where a typo is still the
  // operator's, rather than silently mis-matching at the point of use (T17).
  compileIgnoreGlobs(c.ignoreGlobs)
  return c
}
