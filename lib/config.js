// Eager configuration validation for the obsidian-mem host plugin.
//
// `Config` is a schemastery (Standard Schema v1) object, so Cordis runs
// `Config['~standard'].validate` against the row's `config:` *before* `apply`
// is ever called. `validateConfig` layers on the v1 range checks schemastery
// cannot express — safe-integer bounds, an open ratio, a non-blank path — and
// is written to be safely re-runnable on the value the host already validated.
//
// `ignoreGlobs` is validated and compiled here rather than at the point of use,
// because an operator's typo must fail the row loudly instead of silently
// mis-matching every path it was meant to exclude. The accepted language is
// deliberately tiny: `*` (within one segment), `**` (across segments), `?` (one
// character) and ordinary path characters. Brace expansion, character classes,
// negation (`!…`) and escapes are refused, so no user glob can express anything
// this plugin cannot honour exactly (Task 17).
import z from '@deepseek-ai/schemastery'

export const Config = z.object({
  enabled: z.boolean().default(true),
  vaultPath: z.string().default('~/Documents/dsh-memory'),
  initGitOnCreate: z.boolean().default(true),
  injectBrief: z.boolean().default(true),
  briefBudgetChars: z.number().default(6000),
  hotCapacityChars: z.number().default(9000),
  hotArchiveRatio: z.number().default(0.67),
  autoCapture: z.boolean().default(true),
  captureIdleMs: z.number().default(90000),
  distill: z.object({
    provider: z.string().default(''), model: z.string().default(''),
    maxItems: z.number().default(12), minConfidence: z.number().default(0.75),
    maxInputChars: z.number().default(24000), maxOutputTokens: z.number().default(4000),
    timeoutMs: z.number().default(60000), maxRetries: z.number().default(3),
    dryRun: z.boolean().default(false)
  }),
  indexBackend: z.union([z.const('auto'), z.const('sqlite'), z.const('scan')]).default('auto'),
  ignoreGlobs: z.array(z.string()).default([])
})

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
  if (points.length === 0 || glob.trim() === '') throw new RangeError('ignoreGlobs entries must be non-blank globs')
  if (points.length > IGNORE_GLOB_MAX_CHARS) {
    throw new RangeError(`ignoreGlobs entry is longer than ${IGNORE_GLOB_MAX_CHARS} characters: ${JSON.stringify(glob)}`)
  }
  if (/[\u0000-\u001f\u007f]/.test(glob)) {
    throw new RangeError(`ignoreGlobs entry must not contain control characters: ${JSON.stringify(glob)}`)
  }
  const unsupported = [...glob].find((character) => !IGNORE_GLOB_ALLOWED.test(character))
  if (unsupported !== undefined) {
    throw new RangeError(
      `ignoreGlobs does not support ${JSON.stringify(unsupported)} in ${JSON.stringify(glob)}; only *, **, ? and ordinary path characters are allowed`,
    )
  }
  if (glob.startsWith('/')) {
    throw new RangeError(`ignoreGlobs must be vault- or repository-relative, never absolute: ${JSON.stringify(glob)}`)
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
 * surface as an `Error` listing every issue; v1 range violations as a
 * `RangeError` naming the offending field.
 *
 * @param {unknown} raw - raw row config (possibly `undefined`).
 * @returns {object} the validated config with defaults applied.
 * @throws {Error} when schemastery reports issues.
 * @throws {RangeError} when a v1 range check fails.
 */
export function validateConfig(raw) {
  const result = Config['~standard'].validate(raw)
  if (result.issues) throw new Error(result.issues.map(x=>x.message).join('; '))
  const c = result.value
  const intRange = (key, n, min, max) => {
    if (!Number.isSafeInteger(n) || n < min || n > max) throw new RangeError(key)
  }
  intRange('briefBudgetChars',c.briefBudgetChars,256,20000)
  intRange('hotCapacityChars',c.hotCapacityChars,1024,50000)
  intRange('captureIdleMs',c.captureIdleMs,1000,3600000)
  intRange('distill.maxItems',c.distill.maxItems,1,50)
  intRange('distill.maxInputChars',c.distill.maxInputChars,256,100000)
  intRange('distill.maxOutputTokens',c.distill.maxOutputTokens,128,32000)
  intRange('distill.timeoutMs',c.distill.timeoutMs,1000,300000)
  intRange('distill.maxRetries',c.distill.maxRetries,0,10)
  if (!(c.hotArchiveRatio > 0 && c.hotArchiveRatio < 1)) throw new RangeError('hotArchiveRatio')
  if (!(c.distill.minConfidence >= 0 && c.distill.minConfidence <= 1)) throw new RangeError('distill.minConfidence')
  if (!c.vaultPath.trim()) throw new RangeError('vaultPath')
  if (Boolean(c.distill.provider) !== Boolean(c.distill.model)) throw new RangeError('distill.route')
  // Unsupported glob syntax is refused here, where a typo is still the
  // operator's, rather than silently mis-matching at the point of use (T17).
  compileIgnoreGlobs(c.ignoreGlobs)
  return c
}
