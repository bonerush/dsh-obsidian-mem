// obsidian-mem host plugin entry point.
//
// Cordis validates `Config` before calling `apply`, so by the time `apply` runs
// the config is already normalised; `validateConfig` re-runs the full checks to
// keep a direct `apply(ctx, raw)` call honest.
//
// Assembly is deliberately thin, because two lifetime rules live here:
//
//   * **`resolveDataRoot()` is called exactly once**, and that one data root is
//     handed to the transaction engine (through `writeMemory`/`appendLog`/
//     `updateHot`), to the search index and, from Task 14 on, to the pending
//     queue. A second call site would let two subsystems disagree about where
//     lock files, receipts and the index live; tests inject a throwaway root.
//   * **`enabled: false` registers nothing and touches nothing.** The early
//     return happens before the data root is resolved, before the services are
//     built and before a single `ctx` property is read, so a disabled row cannot
//     leave a lock directory, an index or a tool registration behind.
//
// The `llm` service is never a hard inject: P0 measured it as `undefined` during
// `apply`, so any later access must go through `ctx.get('llm')` at the point of
// use. Task 12 adds the session-start binding and the pre-step brief here.
import { Config, validateConfig } from './config.js'
import { resolveDataRoot } from './paths.js'
import { createMemoryServices, registerTools } from './tools.js'

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
  const config = validateConfig(raw)
  if (!config.enabled) return
  const dataRoot = resolveDataRoot()
  const services = createMemoryServices({ config, dataRoot })
  registerTools(ctx, services)
}
