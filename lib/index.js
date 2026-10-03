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
//   * **`enabled: false` registers nothing and touches nothing.** The early return
//     precedes the data root, the services and every `ctx` read, so a disabled row
//     cannot leave a lock directory, an index or a registration behind.
//
// The `llm` service is never a hard inject: P0 measured it as `undefined` during
// `apply`, so any later access must go through `ctx.get('llm')` at the point of
// use. The same rule covers `systemPrompt`, which `./hooks.js` reads optionally:
// its absence removes one static line and must not keep this plugin pending.
//
// Task 12 adds the session hooks here. `resolveBinding` is bound to the
// configured vault and `mode: 'show'` — a session start never mints a pointer,
// and the one implicit bind lives on the write path in `./tools.js`
// (spec §5.2.3/§5.3). The index comes from the service set the six tools use, so
// one project has exactly one handle.
//
// Task 13 also ships the portable skill from here. The sync runs as a fiber
// effect and is never awaited inside `apply`: it is file work whose failure (an
// unwritable or symlinked `$DSH_HOME/skills`) must be a log line, never a
// rejection that strands this fiber in PENDING and takes the six tools and the
// pre-step injection with it.
//
// Task 16 makes the pipeline live: the same one `dataRoot` yields the queue root,
// which `registerHooks` turns into turn capture plus the automatic-apply worker.
// Task 6 hands that worker the advisory post-commit curation hint and gives the
// session-activity seam its due-checked counterpart, both under one per-project
// guard.
import { homedir } from 'node:os'

import { syncBundledSkill } from './assets.js'
import { buildBrief } from './brief.js'
import { Config, validateConfig } from './config.js'
import { createDiagnostics, recordDiagnostic } from './debug.js'
import { openDiagnosticJournal } from './diagnostic-journal.js'
import { createGraphActivity, noteTouchFromToolCall } from './graph-activity.js'
import { registerGraphRoute } from './graph-route.js'
import { registerHooks } from './hooks.js'
import { weeklyLintHint } from './lint.js'
import { queueRootFor } from './pending.js'
import { expandHomePath, resolveDataRoot } from './paths.js'
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
  // The config keeps the human `~/…` form and every other consumer expands it
  // through `home` (see `resolveBinding` below). The cue mapper needs the same
  // absolute root: comparing an absolute note path against a literal `~` matches
  // nothing, which is how host tool calls stayed invisible while the `mem_*` cues
  // lit up.
  const vaultRoot = expandHomePath(config.vaultPath, home)
  let sink = null
  try {
    sink = openDiagnosticJournal({ dataRoot, config })
  } catch {
    // A support journal must never prevent the plugin from loading.
  }
  // One ring for services and hooks alike, so one `mem_admin(action="diagnostics")`
  // answers for both. Emission is `lib/debug.js`'s decision.
  const diagnostics = createDiagnostics({ logger: ctx?.logger?.('obsidian-mem'), sink })
  const graphActivity = createGraphActivity()
  // `registerHooks` below builds the queue worker; an explicit job retry is the
  // one caller that has to wake it, so the services hold a late-bound kick.
  let queueWorker = null
  // One pass per project at a time, for both automatic halves. The receipt a pass
  // follows is already durable and the running pass reads the same changed-path
  // set, so a second request is dropped rather than queued.
  const curationInFlight = new Set()
  // Set by the fiber's disposer below. Teardown stops the queue worker, which stops
  // the post-commit trigger, but a session-activity request can arrive in the same
  // window — and a pass must not start once the tree is on its way out.
  let disposed = false
  const curateNow = (binding, options) => {
    if (disposed) return
    if (curationInFlight.has(binding.projectId)) return
    curationInFlight.add(binding.projectId)
    // Never awaited: a curation refusal must not fail a turn whose write is
    // committed. An outcome and a code, never a path.
    void services
      .curateForBinding(binding, options)
      .catch((error) =>
        recordDiagnostic(diagnostics, 'curation', {
          outcome: 'failed',
          code: typeof error?.code === 'string' ? error.code : undefined,
          projectId: binding.projectId,
        }),
      )
      .finally(() => curationInFlight.delete(binding.projectId))
  }
  // The two automatic triggers, one guard. `changedPaths` is what a committed write
  // or distillation knows about; `dueOnly` is the session-activity half — the same
  // pass, bounded by `lib/curation-scan.js`'s shared defaults, over whatever the
  // vault holds rather than only what this process wrote.
  const curateChanged = (binding, paths) => curateNow(binding, { changedPaths: paths })
  const curateDue = (binding) => curateNow(binding, { dueOnly: true })
  const services = createMemoryServices({
    config,
    dataRoot,
    home,
    diagnostics,
    kickQueueWorker: () => queueWorker?.kick(),
    // However a note lands — a committed tool write or a distilled candidate — it
    // asks for a pass through this one function.
    onCurationHint: curateChanged,
    onAccess: (sessionId, paths, kind) => graphActivity.record(sessionId, paths, kind),
  })
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
    onRecall: (sessionId, paths) => graphActivity.record(sessionId, paths, 'recall'),
    // Host file tools reach the vault too, and they are cues: the graph follows the
    // work, not only the `mem_*` surface — for the tools that name one file.
    onToolCall: (sessionId, name, args) => {
      const touch = noteTouchFromToolCall(name, args, vaultRoot)
      if (touch !== null) graphActivity.record(sessionId, [touch.path], touch.kind)
    },
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
    onQueueWorker: (worker) => {
      queueWorker = worker
    },
    // Both automatic triggers, under one per-project guard. The flag is read as
    // "only an explicit `false` disables the automatic half" — the shape the two
    // write-path gates in `lib/services.js` and `lib/capture.js` use — and the
    // config is a validated boolean (`lib/config.js`), so this and `=== true` are
    // the same answer for every config the host accepts.
    ...(config.autoCurate !== false
      ? { onCurationCompleted: curateChanged, onCurationDue: curateDue }
      : {}),
  })
  // The web UI is optional. A headless profile still mounts every memory tool;
  // a web profile adds this read-only route when its host services appear.
  ctx.inject(['webServer', 'sessions'], (webCtx) => {
    webCtx.effect(
      () =>
        registerGraphRoute(webCtx, {
          activity: graphActivity,
          services,
          resolveBinding: (cwd) =>
            resolveBinding({ cwd, vaultRoot: config.vaultPath, mode: 'show', home }),
        }),
      'obsidian-mem: graph route',
    )
  })
  // A fiber effect, not a floating promise: unloading waits for the file work, so
  // a teardown never leaves a write against a half-removed tree. The body cannot
  // reject (`syncBundledSkill` resolves for every outcome), so it can neither
  // fail `apply` nor leave the fiber PENDING.
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
    // Before the registrations go: an activity request already in flight when the
    // fiber unloads must not start a pass against a tree that is being removed.
    disposed = true
    for (const dispose of disposers) dispose()
  }
}
