// @ts-check
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
// configured vault and `mode: 'show'` — a session start never mints a
// `.obsidian-mem` pointer, and the `mem_*` hooks it feeds are reads. The one
// implicit bind lives on the write path in `./tools.js` (spec §5.2.3/§5.3) —
// and the index is taken from the same service set the six tools use, so one
// project has exactly one handle.
//
// Task 13 also ships the portable skill from here. The sync runs as a fiber
// effect and is never awaited inside `apply`: it is file work whose failure (an
// unwritable or symlinked `$DSH_HOME/skills`) must be a log line, never a
// rejection out of `apply` that strands this fiber in PENDING and takes the six
// tools and the pre-step injection with it. `syncBundledSkill` is the wrapper
// that guarantees that contract, and `ctx.effect` is what makes the file work
// belong to this fiber instead of outliving it.
//
// Task 16 makes the pipeline live. The same one `dataRoot` yields the queue root,
// which `registerHooks` turns into completed-turn capture plus the automatic-apply
// worker; the worker's index access comes from the same memoized service set as
// the six tools, so one project keeps one open index. Before this the capture seam
// was built only when a caller passed `queueRoot`, and nothing did — the whole
// automatic path was inert in a real host.
import { homedir } from 'node:os'

import { syncBundledSkill } from './assets.js'
import { buildBrief } from './brief.js'
import { Config, validateConfig } from './config.js'
import { createDiagnostics, recordDiagnostic } from './debug.js'
import { registerHooks } from './hooks.js'
import { weeklyLintHint } from './lint.js'
import { queueRootFor } from './pending.js'
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
  // One ring for the whole plugin instance, shared by the services and the hooks
  // so a single `mem_admin(action="diagnostics")` call answers for both. The logger
  // is the host's named one: emission stays off unless `DSH_OBSIDIAN_MEM_DEBUG=1`,
  // and whether the host shows info-level lines is still the host's decision.
  const diagnostics = createDiagnostics({ logger: ctx?.logger?.('obsidian-mem') })
  const services = createMemoryServices({ config, dataRoot, home, diagnostics })
  registerTools(ctx, services)
  const disposers = registerHooks(ctx, {
    // The same instance the tools read, so a decision made during a turn and the
    // ring a later `diagnostics` call returns cannot drift apart.
    diagnostics,
    // `mode: 'show'` reports a repository without a pointer instead of creating
    // one; a session start must never bind a repository the user did not ask for.
    resolveBinding: (cwd) =>
      resolveBinding({ cwd, vaultRoot: config.vaultPath, mode: 'show', home }),
    // The same project resolution and R14 cloud-managed refusal the tools use.
    index: (exec) => services.index(exec),
    search: (args, signal, exec) => services.search(args, signal, exec),
    buildBrief,
    config,
    // Task 16's capture and automatic apply share THIS data root (the single
    // `resolveDataRoot()` above): the queue, its processed floor, its result
    // receipts and the transaction receipts a crash resumes from all live under
    // it. Before this, capture was wired but inert in a real host.
    queueRoot: queueRootFor(dataRoot),
    dataRoot,
    home,
    // The queue worker resumes a job from its persisted project id, so it needs
    // the index of the bound project rather than of whatever cwd happens to be
    // current; the same memoized handle keeps one project at one open index.
    indexForBinding: (binding) => services.indexForBinding(binding),
    // Task 17's weekly prompt. It is a read of the vault's `_meta/` report names,
    // asked at most once per session at the first pre-step — never at session
    // start and never on a timer.
    lintHint: () => weeklyLintHint({ vaultPath: config.vaultPath, home }),
  })
  // The sync is registered as this fiber's effect rather than a bare floating
  // promise: unloading the fiber waits for the file work, so a reload or a test
  // teardown never leaves a write running against a half-removed tree. The body
  // cannot reject — `syncBundledSkill` resolves for every outcome, including a
  // refused or failed sync — so it can neither fail `apply` nor leave the fiber
  // PENDING.
  ctx.effect(async () => {
    const outcome = await syncBundledSkill({ ctx })
    // The sync's failure already reaches the logger as a warning; recording the
    // decision is what lets a later `mem_admin(action="diagnostics")` answer "did the
    // skill land?" without reading `$DSH_HOME` by hand.
    recordDiagnostic(diagnostics, 'skill', {
      outcome:
        outcome?.ok === true ? (outcome.changed === true ? 'synced' : 'unchanged') : 'failed',
    })
    return () => {}
  }, 'obsidian-mem: skill sync')
  return () => {
    for (const dispose of disposers) dispose()
  }
}
