// obsidian-mem host plugin entry point.
//
// Cordis validates `Config` before calling `apply`, so by the time `apply` runs
// the config is already normalised; `validateConfig` re-runs the full checks to
// keep a direct `apply(ctx, raw)` call honest. This task wires the entry point
// only — Task 10 registers the `mem_*` tools through the injected `tools`
// service. The `llm` service is never a hard inject: P0 measured it as
// `undefined` during `apply`, so any later access must go through
// `ctx.get('llm')` at the point of use.
import { Config, validateConfig } from './config.js'

export { Config }

export const name = 'obsidian-mem'
export const inject = ['tools']

/**
 * Activate the plugin for one Cordis fiber.
 *
 * @param {object} ctx - the Cordis context for this fiber.
 * @param {unknown} raw - row config, already validated by the host.
 */
export function apply(ctx, raw) {
  validateConfig(raw)
}
