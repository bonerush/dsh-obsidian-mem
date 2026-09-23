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
// use. The same rule covers `systemPrompt`, which `./hooks.js` reads optionally:
// its absence removes one static line and must not keep this plugin pending.
//
// Task 12 adds the session hooks here. `resolveBinding` is bound to the
// configured vault and `mode: 'show'` — a tool call and a session start never
// mint a `.obsidian-mem` pointer — and the index is taken from the same service
// set the six tools use, so one project has exactly one handle.
import { homedir } from 'node:os'

import { buildBrief } from './brief.js'
import { Config, validateConfig } from './config.js'
import { registerHooks } from './hooks.js'
import { resolveDataRoot } from './paths.js'
import { createMemoryServices, registerTools } from './tools.js'
import { resolveBinding } from './vault.js'

export { Config }

export const name = 'obsidian-mem'
export const inject = ['tools']

/**
 * Activate the plugin for one Cordis fiber.
 *
 * @param {object} ctx - the Cordis context for this fiber.
 * @param {unknown} raw - row config, already validated by the host.
 * @returns {Function|undefined} the disposer for the hook registrations, or
 *   `undefined` when the row is disabled and nothing was registered.
 */
export function apply(ctx, raw) {
  const config = validateConfig(raw)
  if (!config.enabled) return
  const dataRoot = resolveDataRoot()
  // One `home` for both the service set and the hook's binding resolution, so a
  // test or host seam cannot make them disagree about `~/…` expansion.
  const home = homedir()
  const services = createMemoryServices({ config, dataRoot, home })
  registerTools(ctx, services)
  const disposers = registerHooks(ctx, {
    // `mode: 'show'` reports a repository without a pointer instead of creating
    // one; a session start must never bind a repository the user did not ask for.
    resolveBinding: (cwd) => resolveBinding({ cwd, vaultRoot: config.vaultPath, mode: 'show', home }),
    // The same project resolution and R14 cloud-managed refusal the tools use.
    index: (exec) => services.index(exec),
    buildBrief,
    config,
  })
  return () => {
    for (const dispose of disposers) dispose()
  }
}
