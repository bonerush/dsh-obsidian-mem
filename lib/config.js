// Eager configuration validation for the obsidian-mem host plugin.
//
// `Config` is a schemastery (Standard Schema v1) object, so Cordis runs
// `Config['~standard'].validate` against the row's `config:` *before* `apply`
// is ever called. `validateConfig` layers on the v1 range checks schemastery
// cannot express — safe-integer bounds, an open ratio, a non-blank path — and
// is written to be safely re-runnable on the value the host already validated.
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
  return c
}
