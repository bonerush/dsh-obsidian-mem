// The host-side service layer behind the six `mem_*` tools (spec §9; split out
// of `lib/tools.js` in Task 11).
//
// Four rules shape this module.
//
//   * **No action ever fakes a result.** Every one of `mem_admin`'s seven actions
//     — `lint`, `index`, `bind`, `projects`, `promote`, `jobs`, `diagnostics` —
//     is implemented, and the output schema's per-action arms describe the real
//     values they return. `lint` is read-only unless the caller explicitly asks
//     for the dated report (`report: true`); a bind refusal is reported as a
//     refusal, never as a quiet success. Results carry vault-relative paths; no
//     `obsidian://` URI is invented for a vault this plugin cannot prove
//     Obsidian has opened.
//   * **Every path argument goes through the vault jail.** `mem_read` resolves
//     its path with `resolveVaultFile` (via `readNote`), so an absolute path,
//     `..` traversal, a symlink or an internal path such as `_meta/log.md` is
//     refused by the vault's own security boundary rather than by a second,
//     weaker check here.
//   * **One data root for the whole plugin.** `lib/index.js` calls
//     `resolveDataRoot()` exactly once and hands it here; the transaction engine
//     (through `writeMemory`/`appendLog`/`updateHot`), the index and the pending
//     queue all receive that same directory. This module never derives one for
//     itself, which is what keeps a test-injected root authoritative.
//   * **A projection is not a permission.** `toHitView`, `toNoteView` and the
//     rest shape a value for the wire; they never widen what was read. A field a
//     service did not return cannot appear because a projection decided to add
//     it, and the closed output schemas in `./tool-schema.js` are the second
//     half of that guarantee.
//
// `mem_admin(action="diagnostics")` is answered from the ring passed in as
// `options.diagnostics`; when none is given this module creates its own, so the
// tool always describes the process the caller is talking to rather than a
// process-global one.
import { homedir } from 'node:os'

/**
 * The hot zones `mem_log(section=…)` may target.
 *
 * `section` is the day-log block heading (spec §6.2), with one reserved value:
 * `hot` routes the entry into the hot file's controlled zones. The spec says
 * "the controlled zone" without naming which, so `hot` means 进行中 — the zone
 * for active work, which is the only one a log entry can sensibly open — and the
 * three zone names themselves are accepted directly rather than being silently
 * misread as day-log headings.
 */
const HOT_SECTIONS_BY_SECTION = Object.freeze(
  new Map([
    ['hot', '进行中'],
    ['强约束', '强约束'],
    ['进行中', '进行中'],
    ['已完成', '已完成'],
  ]),
)

/** What `mem_brief` answers when this working directory is not a bound project. */
const BRIEF_UNBOUND = Object.freeze({
  status: 'unbound',
  message:
    'mem_brief needs a bound project: this working directory has no .obsidian-mem pointer, so there is no project memory to recall',
})

import { buildBrief } from './brief.js'
// `retryJob` owns the one revive rule (only a terminally failed job may be
// requeued) and lives in Task 16's capture seam.
import { retryJob } from './capture.js'
// `recordCurationFindings` is the scan→proposal orchestration (Task 3 built it and
// deliberately left it uncalled; this task's `curateForBinding` is its one caller),
// and `scanCuration` is the one bounded pass. The scanner's two default bounds are
// imported so the curation result can report the ceiling it ran under without a
// second literal that could drift from the shipped one.
import { listCurationProposals, recordCurationFindings } from './curation-proposals.js'
import { DEFAULT_MAX_MS, DEFAULT_MAX_NOTES, scanCuration } from './curation-scan.js'
import {
  CurationStateError,
  ackChangedSources,
  enqueueChangedSource,
  readChangedSources,
  readCurationCursor,
  requireCurationBinding,
} from './curation-state.js'
import { buildCurationView, readCurationView } from './curation-view.js'
import { createDiagnostics, recordDiagnostic } from './debug.js'
import { DEFAULT_READY_TIMEOUT_MS, openIndex } from './index-db.js'
import { lintVault } from './lint.js'
import { appendLog, MemoryError, promoteNote, writeMemory } from './memory.js'
import { updateHot } from './hot.js'
import { normalizeJobError, queueRootFor, readPendingJobs } from './pending.js'
import { normalizeType } from './routing.js'
import { readNote, searchNotes } from './search.js'
import { assertNotAborted, DEFAULT_SEARCH_LIMIT, WRITE_OPTIONS } from './tool-schema.js'
import {
  bootstrapVault,
  readRegistry,
  releaseCreatedPointer,
  resolveBinding,
  resolveVaultRoot,
  isCloudManagedVaultRoot,
} from './vault.js'

// ---------------------------------------------------------------------------
// The service layer
// ---------------------------------------------------------------------------

/**
 * Build the six services over one vault, one data root and one binding seam.
 *
 * @param {object} options - assembly inputs.
 * @param {object} options.config - the validated plugin config (`vaultPath`, `indexBackend`, `hotCapacityChars`, `hotArchiveRatio`).
 * @param {string} options.dataRoot - the plugin data root, resolved once by `lib/index.js`.
 * @param {string} [options.cwd] - working directory to bind when a call carries no agent session.
 * @param {string} [options.home] - home seam for `~/` expansion and cloud checks.
 * @param {object|null} [options.binding] - an already-resolved `kind:'bound'` binding (Task 12 passes the session's).
 * @param {object} [options.diagnostics] - the ring `mem_admin(action="diagnostics")` reads; one is created when absent, so a caller that wants the tool to describe *its* process supplies its own.
 * @param {Function|null} [options.kickQueueWorker] - what a successful
 *   `mem_admin(action="jobs", retry=true)` asks to run the revived job now; absent
 *   in a harness with no worker (Codex), where a retry only requeues.
 * @param {Function|null} [options.onCurationHint] - `(binding, paths) => void`:
 *   called after a committed write's changed-path hint is durable, so this host
 *   can start a pass now. Advisory and never awaited; absent means no DSH worker,
 *   where the hint simply waits for the next trusted trigger.
 * @param {(sessionId: string, paths: string[], kind: string) => void} [options.onAccess] - UI cue after a successful read (`read`), search (`search`) or write (`write`).
 * @param {{maxNotes?: number, maxMs?: number}|null} [options.curationBounds] - internal, never a feature: the note and deadline bounds `mem_admin(action="curation", operation="scan")` scans under, so a test can make `complete` a claim about its fixture instead of about the machine's load. No tool parameter and no config key reaches it; `null`, the default, is the scan's own limits.
 * @returns {object} `{ search, read, write, log, brief, admin, close }`.
 * @throws {RangeError} when the config, the data root, `kickQueueWorker` or `curationBounds` is unusable.
 */
export function createMemoryServices(options = {}) {
  const {
    config,
    dataRoot,
    cwd = process.cwd(),
    home = homedir(),
    binding = null,
    diagnostics: injectedDiagnostics,
    kickQueueWorker = null,
    onCurationHint = null,
    onAccess = null,
    curationBounds = null,
  } = options
  // One ring per service set unless a caller (the DSH plugin, or the Codex
  // adapter) supplies its own, so `mem_admin(action="diagnostics")` reports the
  // instance it is answering from.
  const diagnostics = injectedDiagnostics ?? createDiagnostics({})
  if (config === null || typeof config !== 'object')
    throw new RangeError('createMemoryServices requires the validated plugin config')
  if (typeof dataRoot !== 'string' || dataRoot.trim() === '')
    throw new RangeError('createMemoryServices requires a non-blank dataRoot')
  // The pending queue lives under the one data root `lib/index.js` resolved, so
  // `mem_admin(action="lint"|"jobs")` reads exactly the queue Task 16 writes.
  const queueRoot = queueRootFor(dataRoot)
  if (typeof cwd !== 'string' || cwd.trim() === '')
    throw new RangeError('createMemoryServices requires a non-blank cwd')
  if (binding !== null && (typeof binding !== 'object' || binding.kind !== 'bound')) {
    throw new RangeError("createMemoryServices accepts only a kind:'bound' binding")
  }
  if (kickQueueWorker !== null && typeof kickQueueWorker !== 'function')
    throw new RangeError('createMemoryServices accepts only a function as kickQueueWorker')
  // A typo'd bound must be refused rather than quietly fall back to the shipped
  // limit — the bug this seam exists to remove. `scanCuration` enforces the ranges.
  if (curationBounds !== null) {
    if (typeof curationBounds !== 'object' || Array.isArray(curationBounds))
      throw new RangeError('createMemoryServices accepts only an object as curationBounds')
    for (const [key, bound] of Object.entries(curationBounds)) {
      const whole = Number.isSafeInteger(bound)
      const ok = key === 'maxNotes' ? whole && bound > 0 : key === 'maxMs' && whole && bound >= 0
      if (!ok) throw new RangeError(`createMemoryServices rejects curationBounds.${key}`)
    }
  }

  /** Resolved vault roots, memoised so `~/…` is expanded once per service. */
  let vaultPromise = null
  /** Binding per working directory, so a session's cwd resolves once. */
  const bindingByCwd = new Map()
  /** Open indexes per project id (`''` when unbound). */
  const indexByProject = new Map()

  /**
   * The vault root this service set reads and writes.
   *
   * A read never mints a `.obsidian-mem` pointer: `resolveProject` resolves with
   * `mode: 'show'`, which reports an unbound repository instead of binding it, so
   * a stray pointer in a repository the user only searched is not a side effect
   * anybody asked for. A write is the one call that may mint, and only through
   * `autoBindProject` (spec §5.2.3 / §5.3): first use is a write.
   *
   * R14: a cloud-managed vault refuses **reads as well as writes**, so the check
   * lives here rather than on the write path alone. An on-demand (dataless) file
   * under `~/Library/Mobile Documents/` or `~/Library/CloudStorage/` can fail
   * with `EDEADLK` in a background process or silently trigger a mass download,
   * and both are read hazards. Every service that touches the vault — including
   * `mem_read`, `mem_admin(action="projects")` and an unbound
   * `mem_search(scope="global")` — gets its root through this function or
   * through `indexFor`, so the refusal precedes the first vault read.
   *
   * @returns {Promise<string>} the normalised vault root.
   * @throws {MemoryError} with code `vault-cloud-managed` when the root is cloud-managed.
   */
  const vaultRoot = () => {
    if (vaultPromise === null) {
      vaultPromise = (async () => {
        const vault = await resolveVaultRoot(config.vaultPath, { home })
        if (await isCloudManagedVaultRoot(vault.root, { home })) {
          throw new MemoryError(
            'vault-cloud-managed',
            `the vault at ${vault.root} is under a cloud-managed directory; obsidian-mem refuses to read or write it until it is moved to a fully-downloaded local directory`,
          )
        }
        return vault.root
      })()
      // A refusal is not cached as an answer: the user may move the vault, so the
      // next call re-resolves instead of replaying a stale rejection.
      vaultPromise.catch(() => {
        vaultPromise = null
      })
    }
    return vaultPromise
  }

  /**
   * Publish a binding under the working directory it was resolved for.
   *
   * A resolution is memoized per cwd — including an *unbound* one, so a session
   * does not re-scan the filesystem on every call. That memo is exactly why a
   * bind has to come through here: an automatic first-write bind and an explicit
   * `mem_admin(action="bind")` both replace the miss, so the six tools work in
   * the session that bound the project instead of waiting for `close()`.
   *
   * @param {string} key - the cwd the resolution is memoized under.
   * @param {object} bound - a `kind:'bound'` resolution.
   */
  function rememberBinding(key, bound) {
    bindingByCwd.set(key, Promise.resolve(bound))
  }

  /**
   * Resolve the project binding for one call, or `null` when unbound.
   *
   * @param {object} [exec] - the tool execution context.
   * @returns {Promise<object|null>} the binding.
   */
  async function resolveProject(exec) {
    if (binding !== null) return binding
    const key = cwdOf(exec) ?? cwd
    let pending = bindingByCwd.get(key)
    if (pending === undefined) {
      pending = (async () => {
        const resolution = await resolveBinding({
          cwd: key,
          vaultRoot: config.vaultPath,
          mode: 'show',
          home,
        })
        return resolution !== null && resolution.kind === 'bound' ? resolution : null
      })()
      bindingByCwd.set(key, pending)
      pending.catch(() => bindingByCwd.delete(key))
    }
    return pending
  }

  /**
   * Bind a pointerless Git repository the way spec §5.2.3 describes, or refuse.
   *
   * The read-only probe is not decoration. `mode: 'local'` is also the explicit
   * action that binds a directory which is *not* a Git repository, and an
   * implicit first write must not take that step for the user: only a
   * `no-pointer` answer proceeds. Every other answer — no Git root, a corrupt or
   * unknown-schema pointer, a sibling worktree whose pointer cannot be read, a
   * registry the vault cannot parse, a cwd inside the vault — is a refusal, and
   * `resolveBinding`'s own guards do the refusing. An existing pointer is never
   * overwritten: the probe means this path is only reached when there is none,
   * and `mode: 'local'` reuses whatever identity it finds. A probe that answers
   * `bound` — a pointer another writer created since the memoized miss — is
   * adopted as this call's binding instead of being reported as a refusal.
   *
   * @param {object} exec - the tool execution context.
   * @returns {Promise<{binding: object|null, refusal: object|null}>} the new binding, or why not.
   */
  async function autoBindProject(exec) {
    const key = cwdOf(exec) ?? cwd
    const probe = await resolveBinding({
      cwd: key,
      vaultRoot: config.vaultPath,
      mode: 'show',
      home,
    })
    // Another writer can create the pointer between the memoized miss this call
    // is answering and this fresh probe. That is the binding, not a refusal: a
    // `bound` probe carries no `reason`/`message`, so reporting it as one printed
    // `cannot be bound (undefined): undefined`. Adopt it, and replace the
    // memoized miss so the rest of this session sees it too.
    if (probe.kind === 'bound') {
      rememberBinding(key, probe)
      return { binding: probe, refusal: null }
    }
    if (probe.kind !== 'unbound' || probe.reason !== 'no-pointer')
      return { binding: null, refusal: probe }
    const resolution = await resolveBinding({
      cwd: key,
      vaultRoot: config.vaultPath,
      mode: 'local',
      dataRoot,
      home,
    })
    if (resolution.kind !== 'bound') return { binding: null, refusal: resolution }
    try {
      await bootstrapVault(resolution, {
        initGitOnCreate: config.initGitOnCreate === true,
        home,
        dataRoot,
      })
    } catch (error) {
      // Releasing the identity is safe exactly when the bootstrap created no
      // project content: `bootstrapVault` attaches `vaultWritten` to everything
      // it throws, and it stays false until the first skeleton file or directory
      // is created or the registry row lands. A refusal before that — the §6.4
      // property preflight, a registry whose recorded sha256 does not cover its
      // body, a vault-root or template refusal — leaves the repository exactly as
      // the write found it, so the pointer goes back and the next write retries
      // the bind cleanly. A failure that *did* create content keeps the identity
      // (part of the skeleton may exist); `mem_admin(action="bind", mode="local")`
      // re-runs the bootstrap, because the write path never does.
      if (error?.vaultWritten !== true) await releaseCreatedPointer(resolution)
      throw error
    }
    rememberBinding(key, resolution)
    return { binding: resolution, refusal: null }
  }

  /**
   * Open (once) the index of one project.
   *
   * The vault root is taken from `vaultRoot()` first, so the R14 cloud-managed
   * refusal lands before the index is prepared or the vault is scanned — a scan
   * is a read of every note.
   *
   * @param {object|null} project - the bound project, or `null` for a global-only context.
   * @returns {Promise<object>} the object `openIndex` returns.
   */
  function indexFor(project) {
    const projectId = project === null ? null : project.projectId
    const key = projectId ?? ''
    let pending = indexByProject.get(key)
    if (pending === undefined) {
      pending = (async () => {
        const root = await vaultRoot()
        return openIndex({
          vaultRoot: root,
          dataRoot,
          backend: config.indexBackend,
          projectId,
          home,
        })
      })()
      indexByProject.set(key, pending)
      pending.catch((error) => {
        // The rejection is the caller's to handle — this only records that it
        // happened, because a failure here is otherwise indistinguishable from
        // "the index is empty" on every surface the model can see.
        recordDiagnostic(diagnostics, 'index', {
          outcome: 'open-failed',
          code: typeof error?.code === 'string' ? error.code : undefined,
          projectId: projectId ?? undefined,
        })
        indexByProject.delete(key)
      })
    }
    return pending
  }

  /**
   * Record one write-path decision: a committed transaction, or a coded refusal.
   *
   * The receipt stays the durable authority and the vault is the record; this is
   * the part neither can answer afterwards — that a write was refused *here*, in
   * this process, with this code — and it is deliberately the whole of what is
   * kept. `txId`, `code` and `projectId` correlate with the receipts; a refusal
   * that names the note it refused still does not put the note in the window.
   *
   * @param {object} project - the bound project.
   * @param {Function} run - the write to perform, returning a receipt or an envelope with one.
   * @returns {Promise<object>} whatever `run` returned.
   */
  async function transacted(project, run) {
    try {
      const value = await run()
      const receipt = value?.receipt ?? value
      recordDiagnostic(diagnostics, 'transaction', {
        outcome: 'committed',
        txId: typeof receipt?.txId === 'string' ? receipt.txId : undefined,
        projectId: project.projectId,
      })
      return value
    } catch (error) {
      recordDiagnostic(diagnostics, 'transaction', {
        outcome: 'refused',
        code: typeof error?.code === 'string' ? error.code : undefined,
        projectId: project.projectId,
      })
      throw error
    }
  }

  /**
   * Re-scan every open index after a committed write (spec §7: the index follows
   * a successful file write). The write is already durable, so a failed refresh
   * is not a failed write — the index reports itself `stale` on the next status.
   *
   * @returns {Promise<void>} resolves once every open index has been asked.
   */
  async function refreshOpenIndexes() {
    for (const pending of [...indexByProject.values()]) {
      let index
      try {
        index = await pending
      } catch {
        continue
      }
      try {
        await index.refresh()
      } catch {
        /* the next search retries through the ready barrier */
      }
    }
  }

  /**
   * The project a call needs, or an explicit refusal.
   *
   * Writes (`bind: true`) bind a pointerless Git repository first, exactly as
   * spec §5.2.3 / §5.3 promise: generate the slug, create the pointer
   * exclusively, bootstrap the skeleton, register the project. Reads never take
   * that step — a pointer must not appear in a repository the user only looked
   * at — so `mem_search`, `mem_read` and `mem_admin`'s maintenance actions keep
   * reporting an unbound resolution.
   *
   * @param {object} exec - the tool execution context.
   * @param {string} tool - the tool name, for the diagnostic.
   * @param {object} [options] - `bind: true` when the caller may create the binding.
   * @returns {Promise<object>} the binding.
   * @throws {MemoryError} with code `vault-cloud-managed` (R14) or `not-bound`.
   */
  async function requireProject(exec, tool, { bind = false } = {}) {
    // R14 first: "this vault is cloud-managed" is a more precise refusal than
    // "this repository is not bound", and it is the reason a write is refused.
    await vaultRoot()
    let project = await resolveProject(exec)
    let refusal = null
    if (project === null && bind) {
      const attempt = await autoBindProject(exec)
      project = attempt.binding
      refusal = attempt.refusal
    }
    if (project === null) {
      const detail =
        refusal === null
          ? 'this working directory has no .obsidian-mem pointer, and a non-bound resolution means no writes'
          : `this working directory cannot be bound (${refusal.reason}): ${refusal.message}`
      throw new MemoryError('not-bound', `${tool} needs a bound project: ${detail}`)
    }
    return project
  }

  /** One UI cue. Presentation can never turn a successful call into a failure. */
  function cue(sessionId, paths, kind) {
    if (typeof sessionId !== 'string' || sessionId === '' || paths.length === 0) return
    try {
      onAccess?.(sessionId, paths, kind)
    } catch {
      // Graph presentation cannot turn a successful vault call into an error.
    }
  }

  /** The paths a write published, or the one path it certainly wrote. */
  function publishedPaths(receipt, fallback) {
    const published = Array.isArray(receipt?.paths)
      ? receipt.paths.filter((path) => typeof path === 'string' && path !== '')
      : []
    if (published.length > 0) return published
    return fallback === null ? [] : [fallback]
  }

  return {
    async search(args, signal, exec) {
      const project = await resolveProject(exec)
      const index = await indexFor(project)
      const hits = await searchNotes(index, {
        query: args.query,
        scope: args.scope ?? 'project',
        type: args.type === undefined || args.type === null ? null : normalizeType(args.type),
        projectId: args.projectId ?? null,
        includeHistory: args.includeHistory === true,
        limit: args.limit ?? DEFAULT_SEARCH_LIMIT,
        signal,
      })
      cue(
        sessionIdOf(exec),
        hits.map((hit) => hit.path),
        'search',
      )
      return hits.map(toHitView)
    },

    async read(args, signal, exec) {
      const root = await vaultRoot()
      // After the await, before the vault read: cancellation must beat the I/O.
      assertNotAborted({ signal })
      const note = await readNote(root, args.path, args.section, { home })
      cue(sessionIdOf(exec), [note.path], 'read')
      return toNoteView(note)
    },

    async write(args, signal, exec) {
      const project = await requireProject(exec, 'mem_write', { bind: true })
      assertNotAborted({ signal })
      const request = { type: args.type, title: args.title, body: args.body }
      for (const key of WRITE_OPTIONS) {
        if (args[key] !== undefined) request[key] = args[key]
      }
      const session = sessionIdOf(exec)
      if (session !== null) request.session = session
      const written = await transacted(project, () =>
        writeMemory(project, request, { dataRoot, home }),
      )
      await refreshOpenIndexes()
      // The durable half of the automatic curation trigger, and the half the two
      // hosts share: Codex MCP has no worker to kick, so its write leaves the hint
      // for the next trusted hook, while DSH's turns it into a pass at once.
      // Deliberately *outside* the transaction (the enqueue takes the same vault
      // lock, which is not reentrant) and deliberately non-fatal: the receipt is
      // durable, so a hint that cannot be written is recorded and left for the next
      // full scan to repair. `autoCurate: false` disables the automatic half only —
      // the explicit `mem_admin(action="curation", operation="scan")` still scans.
      if (config.autoCurate !== false) {
        const hint = await queueCurationHint(project, written.path, {
          dataRoot,
          home,
          diagnostics,
        })
        // The pass is asked for only once the hint is durable (a pass that ran
        // first would find an empty queue and service nothing), and a trigger that
        // throws is recorded rather than thrown: the receipt exists.
        if (hint === true && typeof onCurationHint === 'function') {
          try {
            onCurationHint(project, [written.path])
          } catch (error) {
            recordDiagnostic(diagnostics, 'curation', {
              outcome: 'failed',
              code: typeof error?.code === 'string' ? error.code : undefined,
              projectId: project.projectId,
            })
          }
        }
      }
      cue(sessionIdOf(exec), publishedPaths(written.receipt, written.path), 'write')
      return { id: written.id, path: written.path, receipt: written.receipt }
    },

    async log(args, signal, exec) {
      const project = await requireProject(exec, 'mem_log', { bind: true })
      assertNotAborted({ signal })
      const hotSection =
        args.section === undefined ? undefined : HOT_SECTIONS_BY_SECTION.get(args.section)
      const session = args.session ?? sessionIdOf(exec)
      if (hotSection !== undefined) {
        const receipt = await transacted(project, () =>
          updateHot(
            project,
            {
              section: hotSection,
              text: args.text,
              ...(session === null || session === undefined ? {} : { session }),
              ...(args.idempotencyKey === undefined ? {} : { idempotencyKey: args.idempotencyKey }),
            },
            {
              dataRoot,
              home,
              capacityChars: config.hotCapacityChars,
              archiveRatio: config.hotArchiveRatio,
            },
          ),
        )
        await refreshOpenIndexes()
        cue(session, publishedPaths(receipt, null), 'write')
        return receipt
      }
      if (session === null || session === undefined) {
        throw new RangeError(
          'mem_log needs a session: this call carries no agent session, so pass session="<id>"',
        )
      }
      const receipt = await transacted(project, () =>
        appendLog(
          project,
          {
            text: args.text,
            session,
            ...(args.section === undefined ? {} : { section: args.section }),
            ...(args.idempotencyKey === undefined ? {} : { idempotencyKey: args.idempotencyKey }),
          },
          { dataRoot, home },
        ),
      )
      await refreshOpenIndexes()
      cue(session, publishedPaths(receipt, null), 'write')
      return receipt
    },

    async brief(_args, signal, exec) {
      const project = await resolveProject(exec)
      // R14: a non-bound resolution is "no memory for this session", reported as a
      // status. `buildBrief` refuses anything that is not bound, so the service is
      // the one place that has to answer without one.
      if (project === null) return { ...BRIEF_UNBOUND }
      const index = await indexFor(project)
      // Task 4: a complete stored view is an accelerator for the brief's
      // decisions/gotchas navigation. It is read here, at the service seam, so
      // `buildBrief` stays a pure composition step that never learns the data root;
      // an incomplete, absent or unreadable view is simply `null`, and the brief
      // then takes the source path it has always taken.
      const view = await readCurationView({ dataRoot, projectId: project.projectId })
      const value = await buildBrief(project, {
        index,
        config,
        mode: 'full',
        signal,
        home,
        curationView: view?.complete === true ? view : null,
        // The ring, so a view that fails verification is reported (`curation`,
        // `brief-fallback`, `source-changed`) instead of silently falling back — the
        // spec's "reports why" for the brief-time half of the view.
        diagnostics,
      })
      // After the await, before the value is returned: cancellation must beat the
      // answer, exactly as it does in `read`, `write` and `log`.
      assertNotAborted({ signal })
      return value
    },

    /**
     * The index handle the tools use for one call's project (Task 11 composes the
     * brief from the same object). Opening is memoised, so this can never create
     * a second handle for one project.
     *
     * @param {object} [exec] - the tool execution context that carries the cwd.
     * @returns {Promise<object>} the object `openIndex` returns.
     */
    async index(exec) {
      return indexFor(await resolveProject(exec))
    },

    /**
     * The index handle for an already-resolved binding (Task 16's queue worker).
     *
     * The worker resumes a job from its persisted project id and has no session
     * cwd to resolve, so it must not go through `resolveProject(exec)`: that would
     * bind whichever repository the process happens to sit in. Memoization is the
     * same `indexByProject` map, so the worker and the six tools share exactly one
     * handle per project.
     *
     * @param {object} binding - a `kind:'bound'` binding.
     * @returns {Promise<object>} the object `openIndex` returns.
     */
    async indexForBinding(binding) {
      return indexFor(binding ?? null)
    },

    async admin(args, signal, exec) {
      if (args.action === 'diagnostics') {
        // Before any binding or vault work, and without touching either: the
        // moment a developer needs this is usually the moment those refuse.
        return { action: 'diagnostics', result: diagnostics.snapshot() }
      }
      if (args.action === 'index') {
        const project = await resolveProject(exec)
        const index = await indexFor(project)
        const rebuilt = args.rebuild === true
        if (rebuilt) await index.refresh({ full: true })
        assertNotAborted({ signal })
        return { action: 'index', result: { ...toIndexStatusView(index.status()), rebuilt } }
      }
      if (args.action === 'projects') {
        const registry = await readRegistry(await vaultRoot())
        return { action: 'projects', result: { projects: registry.rows.map(toProjectRow) } }
      }
      if (args.action === 'bind')
        return bindAction(args, {
          config,
          dataRoot,
          home,
          cwd,
          exec,
          onBound: rememberBinding,
          diagnostics,
        })
      if (args.action === 'lint') {
        const project = await requireProject(exec, 'mem_admin(action="lint")')
        const index = await indexFor(project)
        // A maintenance report is worth a bounded wait: lint reports the real
        // readiness either way, but a scan that is still running would make
        // "not compared" the answer to every first call.
        if (typeof index.waitReady === 'function') {
          try {
            await index.waitReady(signal, DEFAULT_READY_TIMEOUT_MS)
          } catch {
            /* a cancelled or failed wait is reported by the lint itself */
          }
        }
        assertNotAborted({ signal })
        const report = await lintVault({
          binding: project,
          index,
          repoRoot: project.repoRoot ?? null,
          queueRoot,
          ignoreGlobs: config.ignoreGlobs ?? [],
          dataRoot,
          home,
          report: args.report === true,
          pruneHistory: args.prune === true,
          signal,
        })
        return { action: 'lint', result: toLintView(report) }
      }
      if (args.action === 'promote') {
        const project = await requireProject(exec, 'mem_admin(action="promote")')
        if (typeof args.path !== 'string' || args.path.trim() === '') {
          throw new RangeError(
            'mem_admin(action="promote") needs path: the vault-relative path of the note to promote',
          )
        }
        assertNotAborted({ signal })
        const promoted = await promoteNote(project, { path: args.path }, { dataRoot, home })
        await refreshOpenIndexes()
        return { action: 'promote', result: toPromoteView(promoted) }
      }
      if (args.action === 'curation') {
        // Read-only resolution, deliberately *not* `requireProject(..., {bind:true})`:
        // a status call must not mint a `.obsidian-mem` pointer, and neither must an
        // explicit scan — the user asked to curate a project, not to create one.
        const project = await requireProject(exec, 'mem_admin(action="curation")')
        assertNotAborted({ signal })
        const curationEnv = { dataRoot, home, config, diagnostics, curationBounds }
        return curationAction(project, args, curationEnv)
      }
      // `jobs` is the one action that needs no vault at all: the queue lives
      // under the data root, so a session whose repository is unbound can still
      // see and retry its failures.
      return {
        action: 'jobs',
        result: await jobsAction(args, { queueRoot, diagnostics, kickQueueWorker }),
      }
    },

    /**
     * One bounded curation pass for an already-resolved binding (Task 6's triggers).
     *
     * @param {object} binding - a `kind:'bound'` binding.
     * @param {object} [options] - the pass inputs (`dueOnly`, `force`, `changedPaths`, `maxNotes`, `maxMs`, `buildView`).
     * @returns {Promise<object|'unbound'>} the bounded curation result.
     */
    async curateForBinding(binding, options = {}) {
      // `buildView` is the test seam `curateForBinding` documents; a production
      // caller never passes it.
      const { buildView, ...pass } = options
      return curateForBinding(binding, pass, {
        dataRoot,
        home,
        config,
        diagnostics,
        buildView,
      })
    },

    /**
     * The same pass for this service's own working directory (Codex's hook).
     *
     * Reuses the read-only resolution — and therefore the R14 cloud-managed
     * refusal — rather than reimplementing a binding check at the adapter, so both
     * hosts agree about which project a pass may touch.
     *
     * @param {object} [options] - the pass inputs.
     * @returns {Promise<object|'unbound'>} the bounded curation result, or `'unbound'`.
     */
    async curateCurrentProject(options = {}) {
      const project = await resolveProject()
      if (project === null) return 'unbound'
      const { buildView, ...pass } = options
      return curateForBinding(project, pass, {
        dataRoot,
        home,
        config,
        diagnostics,
        buildView,
      })
    },

    async close() {
      const pending = [...indexByProject.values()]
      indexByProject.clear()
      bindingByCwd.clear()
      vaultPromise = null
      await Promise.all(
        pending.map(async (entry) => {
          try {
            const index = await entry
            await index.close()
          } catch {
            /* a handle that never opened has nothing to release */
          }
        }),
      )
    },
  }
}

/** How many queued changed-path hints one acknowledgement may drop at once. */
const MAX_ACK_PATHS = 512
/** How long a completed backfill counts as current before an automatic pass runs again. */
const CURATION_DUE_MS = 24 * 60 * 60 * 1000

/**
 * `mem_admin(action="curation")`: one bounded answer, and one optional pass.
 *
 * `operation` is validated here and not only by the schema: the service is reachable
 * from a caller other than the tool (Task 6 composes `curateForBinding` directly),
 * so an unknown operation is a refusal rather than a silent fall back to `status`.
 *
 * @param {object} project - the bound project.
 * @param {object} args - the forwarded `mem_admin` arguments (`operation` only; a bound never comes from here).
 * @param {object} env - `{dataRoot, home, config, diagnostics, curationBounds}`.
 * @returns {Promise<object>} the `mem_admin` value.
 * @throws {RangeError} when `operation` is not `status` or `scan`.
 */
async function curationAction(project, args, env) {
  const operation = args.operation ?? 'status'
  if (operation !== 'status' && operation !== 'scan') {
    throw new RangeError(
      `mem_admin(action="curation") does not accept operation=${JSON.stringify(operation)}; it accepts "status" or "scan"`,
    )
  }
  const result =
    operation === 'scan'
      ? // `curationBounds` reaches this function only through the factory, never
        // through `args`: the tool's own schema is unchanged.
        await curateForBinding(project, { force: true, ...(env.curationBounds ?? {}) }, env)
      : await curateForBinding(project, { readOnly: true }, env)
  return { action: 'curation', result }
}

/**
 * Record that one committed write's note wants a curation pass.
 *
 * One of the two write paths a committed note can come from — this module's `write`
 * (the tool, and Codex's MCP server). The queue worker has its own copy in
 * `lib/capture.js`, because that module may not import this one, and both share the
 * rule this function exists to keep: a hint that cannot be written never retracts
 * the receipt the transaction already produced.
 *
 * @param {object} binding - the bound project the note was written into.
 * @param {string} path - the vault-relative path the transaction committed.
 * @param {{dataRoot: string, home: string, diagnostics: object}} env - the private root and the ring.
 * @returns {Promise<boolean>} whether a pass is worth asking for.
 */
async function queueCurationHint(binding, path, env) {
  if (typeof path !== 'string' || path === '') return false
  try {
    const hint = await enqueueChangedSource({
      binding,
      dataRoot: env.dataRoot,
      path,
      home: env.home,
    })
    // The cap's drop is the one outcome here that a later pass does not repair by
    // itself: a covered path is trusted by its record's presence, so a dropped hint
    // for an edited note leaves the view entry holding the pre-edit hash. Count only —
    // no path, no note text — and one event per enqueue that dropped something.
    if (hint.dropped > 0) {
      recordDiagnostic(env.diagnostics, 'curation', {
        outcome: 'changed-path-dropped',
        projectId: binding.projectId,
        hits: hint.dropped,
      })
    }
    return true
  } catch (error) {
    // Content-free, and never rethrown: the vault byte is written and the
    // receipt is durable, so the worst case is that this note waits for the next
    // due full scan instead of being inspected now.
    recordDiagnostic(env.diagnostics, 'curation', {
      outcome: 'failed',
      code: typeof error?.code === 'string' ? error.code : undefined,
      projectId: typeof binding.projectId === 'string' ? binding.projectId : undefined,
    })
    return false
  }
}

/**
 * The shared curation orchestration both adapters trigger (Tasks 5–6).
 *
 * The order is the whole contract, and each step is where it is for a reason:
 *
 *   * **The stored view decides the traversal, then the queue decides its input.**
 *     A complete view may be merged into, so a queued hint becomes a changed-path
 *     pass with exactly those paths; without one the pass is a full backfill, whose
 *     manifest contains the hinted paths anyway. The queue is reread here rather
 *     than trusted from a caller, so a trigger that queued nothing still resumes the
 *     backfill it interrupted. The build is what enforces the rest: a changed-path
 *     pass over anything but a complete view is refused rather than merged.
 *   * **`dueOnly` with a fresh marker and nothing queued does no scan.** The marker
 *     is the private cursor's `scannedAt`, so a session start that runs every turn
 *     still scans once a day. A queued hint bypasses the marker because it is
 *     information the marker was never asked about.
 *   * **The view is written before the hints are acknowledged, and a build that
 *     fell back acknowledges nothing.** `buildCurationView` returns `fallback`
 *     *without writing* for an incomplete backfill, an unusable entry or an oversize
 *     document, so the return value — not the attempt — is what the acknowledgement
 *     is gated on: a crash between the two leaves the paths queued for replay, and so
 *     does a view that never landed. The other order would drop them with nothing
 *     built from them.
 *   * **The acknowledgement drops only the queued paths this pass inspected, once a
 *     view carrying them is durable.** A pass cut short by either bound leaves the
 *     paths it never reached queued, and what it did inspect is durable — a scan
 *     record plus the view entry written from it — which is what makes dropping
 *     those hints safe.
 *
 * @param {object} binding - a `kind:'bound'` binding.
 * @param {object} [options] - `dueOnly` (skip a pass that is not due), `force` (ignore the due marker), `readOnly` (report without scanning), `changedPaths` (inspect exactly these), `maxNotes`, `maxMs`.
 * @param {object} env - `{dataRoot, home, config, diagnostics}`.
 * @returns {Promise<object>} the bounded curation result.
 * @throws {RangeError} when the binding, an option or a changed path is invalid.
 * @throws {import('./paths.js').PathSafetyError} when a changed path escapes the vault.
 * @throws {import('./curation-state.js').CurationStateError} when private state cannot be read or written.
 */
async function curateForBinding(binding, options = {}, env) {
  const { dataRoot, home, config, diagnostics } = env
  // The view build is injectable so a test can force the one outcome no fixture
  // reaches through the service's own inputs: a build that reports `fallback` while
  // the pass really inspected a queued path. That combination is what the
  // acknowledgement gate exists for. Production passes nothing here.
  const buildView = env.buildView ?? buildCurationView
  const project = requireCurationBinding(binding)
  const {
    dueOnly = false,
    force = false,
    readOnly = false,
    changedPaths = null,
    maxNotes = DEFAULT_MAX_NOTES,
    maxMs = DEFAULT_MAX_MS,
  } = options
  const started = Date.now()

  let cursor = null
  // The first state problem this call met, reported as the `code` of its one
  // diagnostic rather than as an event of its own: one call makes one decision, and
  // an extra "skipped" event beside a "listed" one would read as two.
  let problem = null
  try {
    cursor = await readCurationCursor(dataRoot, project.projectId)
  } catch (error) {
    if (!(error instanceof CurationStateError)) throw error
    // A cursor that cannot be trusted cannot answer "is a pass due", so it is
    // treated as absent: a scan then rebuilds it from the vault, and the alternative
    // is a project whose due check never fires again.
    problem = error.code
  }

  // A caller that names changed paths supplies them; otherwise the durable queue
  // is the input, because that is what a committed write left behind.
  let queued = []
  if (changedPaths === null || changedPaths === undefined) {
    try {
      queued = await readChangedSources({ binding: project, dataRoot })
    } catch (error) {
      if (!(error instanceof CurationStateError)) throw error
      // The untrustworthy set is dropped rather than allowed to decide the
      // traversal: the writer replaces a corrupt set on the next enqueue, and a
      // full pass is the one traversal that repairs coverage without it.
      problem = problem ?? error.code
      queued = []
    }
  }
  const local = changedPaths === null || changedPaths === undefined ? queued : changedPaths
  const due = force || local.length > 0 || isCurationDue(cursor)
  if (dueOnly && !due) {
    return curationResult(project, { status: 'skipped', cursor, problem, env })
  }
  if (readOnly) {
    return curationResult(project, { status: 'listed', cursor, problem, env })
  }

  // A changed-path traversal is only worth running when a complete view exists for
  // it to merge into. Without one there is nothing to merge into, and the pass
  // certifies nothing while the interrupted backfill still has to happen — so the
  // hints would stay queued and every trigger would service them instead of walking
  // the project. An incomplete or absent view therefore makes this a full pass,
  // which inspects the hinted paths too, because they are in its manifest.
  const previous = await readCurationView({ dataRoot, projectId: project.projectId })
  const changed = previous?.complete === true ? local : []
  const scan = await scanCuration(project, {
    dataRoot,
    maxNotes,
    maxMs,
    changedPaths: changed.length === 0 ? null : changed,
    ignoreGlobs: config.ignoreGlobs ?? [],
    home,
  })
  // The build writes the view, and its own result says whether it did: every
  // non-`written` status returns *without* writing, so a pass whose build fell back
  // left the stored view exactly as it was. The reachable ones are
  // `backfill-incomplete`, `entry-unusable`, `view-oversize` and `view-unwritable:*`
  // — the last covers both the margin between the builder's compact serialisation
  // (`MAX_VIEW_DOCUMENT_BYTES`, 768 KiB) and the store's pretty-printed bound
  // (`MAX_VIEW_BYTES`, 1 MiB), which the store raises as a `CurationStateError`, and
  // a raw `fs` failure at the view path (`EISDIR` for a directory where the document
  // belongs, for instance), which `writePrivateJson` rethrows unchanged. Both are
  // caught inside the build and answered as a fallback, so nothing here can throw out
  // of the build and skip the findings and the acknowledgement below. The
  // committed document is what the projection below reads back, because only it
  // carries every entry after a changed-path merge.
  const view = await buildView({ binding: project, dataRoot, scan })
  // `recordCurationFindings` is what turns a judgment-dependent finding into a
  // review-only proposal. A single unreadable source refuses that one finding; it
  // is reported and skipped, never silently accepted, and never allowed to fail a
  // pass whose view has already been written.
  for (const finding of scan.findings) {
    try {
      await recordCurationFindings({
        binding: project,
        dataRoot,
        findings: [finding],
        home,
      })
    } catch (error) {
      recordDiagnostic(diagnostics, 'curation', {
        outcome: 'failed',
        code: typeof error?.code === 'string' ? error.code : undefined,
        projectId: project.projectId,
      })
    }
  }
  // Only now, and only when the build reports it landed. The scan's records are
  // durable either way, but the hints are the *only* handle on "this note was
  // changed since the last committed view": acknowledging them off a pass whose
  // build fell back would drop the batch from the view and from the queue at once,
  // so they stay queued and the next pass replays them. A crash before this point
  // leaves every path queued too, which is the order the plan requires.
  const serviced = new Set(scan.examinedPaths)
  const acknowledged = local.filter((path) => serviced.has(path)).sort()
  if (view.status === 'written' && acknowledged.length > 0) {
    await ackChangedSources({
      binding: project,
      dataRoot,
      // Sorted then cut, so dropping more than the bound allows always drops the
      // same ones; the rest replay on the next pass.
      paths: acknowledged.slice(0, MAX_ACK_PATHS),
      home,
    })
  }

  // Both `entries` and `complete` are read back from the stored view, which is
  // what a brief consumes and the only set that carries every entry after a
  // changed-path merge. Reading the scan's own list instead would report the
  // batch rather than the project.
  return curationResult(project, {
    status: 'scanned',
    cursor: scan.cursor,
    examined: scan.examined,
    truncated: scan.truncatedReason,
    counts: { findings: scan.counts.findings, unexamined: scan.counts.unexamined },
    // The state problem and the truncation reason are one `code` on one event; the
    // state problem outranks the truncation because it is the one this call had to
    // work around rather than the bound it chose. A build that fell back joins that
    // precedence: it is why nothing was published, so it wins over a state problem
    // the pass still finished through.
    problem: view.status === 'written' ? (problem ?? scan.truncatedReason) : view.reason,
    env,
    started,
  })
}

/**
 * Whether a completed backfill is old enough that an automatic pass should run.
 *
 * @param {object|null} cursor - the stored cursor.
 * @param {number} [dueMs] - the interval.
 * @returns {boolean} true when a pass is due (a missing or unusable marker is due).
 */
function isCurationDue(cursor, dueMs = CURATION_DUE_MS) {
  if (cursor === null) return true
  const scannedAt = Date.parse(cursor.scannedAt)
  if (!Number.isFinite(scannedAt)) return true
  return Date.now() - scannedAt >= dueMs
}

/**
 * Project one pass into the closed, bounded value `mem_admin(action="curation")`
 * returns and the automatic triggers consume.
 *
 * `entries` and `complete` always come from the committed view rather than from the
 * scan that just ran: the view is what a brief consumes, and after a changed-path
 * merge it is the only set that carries every entry. A pass that truncated says so
 * in `truncated`; the view then simply does not carry the entries that pass never
 * reached, and `complete: false` is what says the view is short.
 *
 * @param {object} project - the validated binding.
 * @param {object} input - `status`, the cursor, `examined`, `truncated`, `counts` and the state `problem` for a pass, `env`, and `started` for the duration.
 * @returns {Promise<object>} the curation result.
 */
async function curationResult(project, input) {
  const { env, status } = input
  const cursor = input.cursor ?? null
  const stored = await readCurationView({ dataRoot: env.dataRoot, projectId: project.projectId })
  const entries = stored?.entries ?? []
  const proposals = await curationProposals(env.dataRoot, project.projectId)
  recordDiagnostic(env.diagnostics, 'curation', {
    outcome: status,
    // One code per call, and the caller decides which. The state problem it worked
    // around outranks the pass's truncation — the alternative order is not the one
    // `curateForBinding` passes — and a build that fell back supplies its own reason
    // instead of either.
    code: typeof input.problem === 'string' ? input.problem : undefined,
    projectId: project.projectId,
    hits: input.examined ?? 0,
    ms: Math.max(0, Math.round(Date.now() - (input.started ?? Date.now()))),
  })
  return {
    status,
    operation: status === 'listed' ? 'status' : 'scan',
    projectId: project.projectId,
    complete: stored?.complete === true,
    cursor: cursor === null ? null : cursor.afterPath,
    scannedAt: cursor === null ? null : cursor.scannedAt,
    examined: input.examined ?? 0,
    // `entries` and `exactGroups` describe the project: they are the committed
    // view's own shape. The other two describe *this call's pass* — a scan's own
    // totals, and zero for a status read, which inspects nothing. A pass that
    // truncated reports its partial totals and says so in `truncated`, and a
    // changed-path pass reports the batch it inspected; neither is presented as a
    // project-wide count, which is why they are separate numbers rather than one.
    counts: {
      entries: entries.length,
      exactGroups: entries.filter((entry) => (entry.paths?.length ?? 0) > 1).length,
      findings: input.counts?.findings ?? 0,
      unexamined: input.counts?.unexamined ?? 0,
    },
    proposals,
    truncated: typeof input.truncated === 'string' ? input.truncated : null,
    // The same flag the gates read as `!== false`, reported as the boolean it is:
    // `lib/config.js` validates it (`z.boolean().default(true)`), so the two
    // readings agree on every config the host accepts.
    autoEnabled: env.config.autoCurate === true,
  }
}

/**
 * The bounded proposal queue of one project: counts, never a candidate's content.
 *
 * @param {string} dataRoot - the plugin data root.
 * @param {string} projectId - the owning project.
 * @returns {Promise<object>} `{total, pending, truncated, unreadable}`.
 */
async function curationProposals(dataRoot, projectId) {
  const all = await listCurationProposals({ dataRoot, projectId })
  const pending = await listCurationProposals({ dataRoot, projectId, state: 'pending' })
  return {
    total: all.total,
    pending: pending.total,
    truncated: all.truncated || pending.truncated,
    unreadable: all.unreadable,
  }
}

// ---------------------------------------------------------------------------
// Projections
// ---------------------------------------------------------------------------

/** The session id provenance is recorded from, when the call carries one. */
function sessionIdOf(exec) {
  const id = exec?.agent?.session?.header?.id
  return typeof id === 'string' && id !== '' ? id : null
}

/** The working directory a call runs in, when the call carries one. */
function cwdOf(exec) {
  const cwd = exec?.agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd !== '' ? cwd : null
}

/**
 * Project one index hit onto the promise spec §9 makes: path, id, project,
 * title, type, status, source, snippet and explainable ranking signals.
 *
 * @param {object} hit - a hit from `searchNotes`.
 * @returns {object} the `mem_search` hit view.
 */
function toHitView(hit) {
  const view = {
    path: String(hit.path),
    title: hit.title ?? '',
    type: hit.type ?? '',
    status: hit.status ?? '',
    source: hit.source ?? '',
    snippet: hit.snippet ?? '',
    scoreSignals: scoreSignalsOf(hit),
  }
  if (typeof hit.id === 'string') view.id = hit.id
  if (typeof hit.projectId === 'string') view.projectId = hit.projectId
  return view
}

/**
 * Turn the index's scoring signals into the ordered, human-readable list the
 * model can use to explain why a hit ranked where it did.
 *
 * @param {object} hit - a hit from `searchNotes`.
 * @returns {string[]} at least one signal.
 */
function scoreSignalsOf(hit) {
  const signals = hit.signals ?? {}
  const out = []
  if (typeof signals.matchedBy === 'string') out.push(`matched-by:${signals.matchedBy}`)
  if (signals.titleExact === true) out.push('title-exact')
  else if (signals.titleContains === true) out.push('title-contains')
  if (signals.phraseContains === true) out.push('phrase-contains')
  if (signals.substringMatch === true) out.push('substring-match')
  if (typeof signals.tokenHits === 'number') out.push(`token-hits:${signals.tokenHits}`)
  if (typeof signals.bm25 === 'number') out.push(`bm25:${signals.bm25}`)
  if (typeof signals.relevance === 'number') out.push(`relevance:${signals.relevance}`)
  if (typeof signals.typeWeight === 'number') out.push(`type-weight:${signals.typeWeight}`)
  if (typeof signals.freshness === 'number') out.push(`freshness:${signals.freshness}`)
  if (signals.history === true) out.push('history')
  if (signals.frontmatterBroken === true) out.push('frontmatter-broken')
  if (signals.repaired === true) out.push('cache-repaired')
  if (signals.verifiedSource === true) out.push('source-verified')
  if (typeof hit.score === 'number') out.push(`score:${hit.score}`)
  return out.length > 0 ? out : ['score:0']
}

/**
 * Project a `readNote` result onto the `Note` contract.
 *
 * `hash`, `size` and `body` are always present; the frontmatter map and the
 * parse error pass through unchanged (a note without a parseable block is still
 * readable — spec §7), and a field the note does not carry is omitted rather
 * than reported as a fake empty string.
 *
 * @param {object} note - the object `readNote` returns.
 * @returns {object} the `mem_read` view.
 */
function toNoteView(note) {
  const view = {
    path: note.path,
    hash: note.hash,
    size: note.size,
    body: note.body,
    frontmatter: note.frontmatter ?? null,
    tags: Array.isArray(note.tags) ? note.tags : [],
    parseError: note.parseError ?? null,
  }
  for (const key of ['id', 'type', 'title', 'status', 'projectId', 'updated']) {
    if (typeof note[key] === 'string') view[key] = note[key]
  }
  if (typeof note.section === 'string') view.section = note.section
  if (typeof note.sectionBody === 'string') view.sectionBody = note.sectionBody
  return view
}

/**
 * Project `openIndex().status()` onto the reported index status.
 *
 * The absolute `dbPath`/`indexDir` of the plugin's own data root are left out,
 * for the same reason the bind view strips `cwd`/`repoRoot`: a tool result
 * carries no machine-local path. Design §7 documents where the index lives
 * (`<dataRoot>/index/index-<sha256(realpath(vault))>.db`), so nothing is lost.
 *
 * @param {object} status - the index status.
 * @returns {object} the `mem_admin(action="index")` result (minus `rebuilt`).
 */
function toIndexStatusView(status) {
  return {
    backend: status.backend ?? null,
    requestedBackend: status.requestedBackend,
    degraded: status.degraded === true,
    reason: status.reason ?? null,
    ready: status.ready === true,
    scanning: status.scanning === true,
    stale: status.stale === true,
    notes: status.notes ?? 0,
    schemaVersion: status.schemaVersion ?? null,
    lastScan: status.lastScan ?? null,
    lastError: status.lastError ?? null,
    boundProjectId: status.boundProjectId ?? null,
    fts: status.fts === true,
  }
}

/**
 * Project one registry row onto the reported project row.
 *
 * @param {object} row - a row from `readRegistry`.
 * @returns {object} the project row.
 */
function toProjectRow(row) {
  return {
    projectId: row.projectId,
    dir: row.dir,
    displayName: row.displayName,
    remote: row.remote ?? '',
  }
}

/**
 * Project one `resolveBinding` result onto a reportable shape.
 *
 * Machine-local absolute paths (`cwd`, `repoRoot`, `projectDir`) stay out: the
 * report carries the vault-relative directory, which is the thing a caller can
 * act on, and never an invented `obsidian://` URI.
 *
 * @param {object} resolution - the result of `resolveBinding`.
 * @returns {object} the resolution view.
 */
function toResolutionView(resolution) {
  const view = { kind: resolution.kind }
  for (const key of ['reason', 'message', 'hint']) {
    if (typeof resolution[key] === 'string') view[key] = resolution[key]
  }
  if (resolution.kind === 'bound') {
    view.projectId = resolution.projectId
    view.slug = resolution.slug
    view.displayName = resolution.displayName
    view.relativeDir = resolution.relativeDir
    view.registered = resolution.registered
    view.pointerCreated = resolution.pointerCreated
    view.pointerInherited = resolution.pointerInherited
    view.vaultExists = resolution.vaultExists
    if (resolution.pointerReplaced === true) view.pointerReplaced = true
    if (typeof resolution.previousProjectId === 'string')
      view.previousProjectId = resolution.previousProjectId
    if (typeof resolution.remote === 'string') view.remote = resolution.remote
    if (typeof resolution.retained === 'boolean') view.retained = resolution.retained
  }
  return view
}

/**
 * Project one lint report onto the reported shape.
 *
 * The report carries a few facts a model does not need to read on every call
 * (`repository.scanned`, the per-snapshot oversized list, the retention policy
 * object); they are dropped or folded here so the schema stays closed and the
 * payload stays bounded, while every finding keeps its path and its reason.
 *
 * @param {object} report - the object `lintVault` returned.
 * @returns {object} the `mem_admin(action="lint")` result.
 */
function toLintView(report) {
  return {
    projectId: report.projectId,
    relativeDir: report.relativeDir,
    generatedAt: report.generatedAt,
    readOnly: report.readOnly === true,
    total: report.total,
    counts: { ...report.counts },
    findings: report.findings.map((finding) => ({
      kind: finding.kind,
      severity: finding.severity,
      path: finding.path ?? null,
      message: finding.message,
    })),
    index: {
      backend: report.index.backend ?? null,
      ready: report.index.ready === true,
      notes: report.index.notes ?? null,
      rows: report.index.rows ?? null,
      files: report.index.files,
      compared: report.index.compared === true,
      reason: report.index.reason ?? null,
    },
    history: {
      policy: { ...report.history.policy },
      directories: report.history.directories,
      bytes: report.history.bytes,
      prunable: report.history.prunable,
      pruned: [...report.history.pruned],
      needsRepair: [...report.history.needsRepair],
      oversized: report.history.oversized === true,
    },
    pending: {
      jobs: report.pending.jobs,
      failed: report.pending.failed,
      invalid: report.pending.invalid,
      known: report.pending.known === true,
    },
    repository: {
      scanned: report.repository.scanned,
      candidates: report.repository.candidates,
      truncated: report.repository.truncated === true,
      known: report.repository.known === true,
    },
    report: {
      status: report.report.status,
      path: report.report.path ?? null,
      message: report.report.message ?? null,
    },
    safetyExclusions: [...report.safetyExclusions],
    ignoreGlobs: [...report.ignoreGlobs],
    truncated: { vault: report.truncated.vault === true, repo: report.truncated.repo === true },
  }
}

/** Project a promotion onto the reported shape. */
function toPromoteView(promoted) {
  return {
    source: promoted.source,
    moved: false,
    id: promoted.id,
    path: promoted.path,
    receipt: promoted.receipt,
  }
}

/** One queued job as the `jobs` result reports it (no `safeInput`, no model text). */
function toJobView(job) {
  return {
    jobId: job.jobId,
    state: job.state,
    sessionId: job.sessionId,
    projectId: job.projectId,
    fromSeq: job.fromSeq,
    toSeq: job.toSeq,
    attempts: Number.isSafeInteger(job.attempts) ? job.attempts : 0,
    createdAt: typeof job.createdAt === 'string' ? job.createdAt : null,
    failedAt: typeof job.failedAt === 'string' ? job.failedAt : null,
    lastError: normalizeJobError(job.lastError),
    outputState: typeof job.output?.state === 'string' ? job.output.state : null,
  }
}

/**
 * `mem_admin(action="bind")`: show, or an explicit identity action.
 *
 * `show` never writes. `local` and `fork` change (or establish) this
 * repository's identity and then bootstrap the identity they produced, so the
 * very first bind creates the vault skeleton. `retain` confirms the current
 * binding and records the origin hint. A refusal — no pointer to fork, a taken
 * directory, an unreadable registry — is reported as `status: 'refused'` with the
 * resolution's own reason, never as a silent success.
 *
 * A bootstrap that refuses before it created project content hands the identity
 * back and does not publish the memo, exactly as the implicit first write does;
 * a bootstrap that writes and then fails keeps the identity, because the
 * skeleton it names really exists.
 *
 * @param {object} args - the forwarded `mem_admin` arguments.
 * @param {object} seams - `{config, dataRoot, home, cwd, exec, onBound}`.
 * @returns {Promise<object>} the `mem_admin` value.
 */
async function bindAction(args, { config, dataRoot, home, cwd, exec, onBound, diagnostics }) {
  const mode = args.mode ?? 'show'
  const key = cwdOf(exec) ?? cwd
  const resolution = await resolveBinding({
    cwd: key,
    vaultRoot: config.vaultPath,
    mode,
    dataRoot,
    home,
  })
  const view = toResolutionView(resolution)
  if (mode === 'show') {
    return { action: 'bind', result: { mode, status: 'shown', resolution: view } }
  }
  if (resolution.kind !== 'bound') {
    // A refusal is the answer a developer most often needs to explain after the
    // fact, and until now it existed only as a return value nobody kept.
    // The ring validates `code` itself and drops anything that is not a short
    // token, so a free-text reason cannot smuggle prose into the window.
    recordDiagnostic(diagnostics, 'bind', { outcome: 'refused', code: resolution.reason })
    return {
      action: 'bind',
      result: { mode, status: 'refused', resolution: view, message: resolution.message },
    }
  }
  if (mode === 'retain') {
    // `retain` confirms and records; it has no bootstrap to refuse, so the memo
    // is published straight away.
    if (typeof onBound === 'function') onBound(key, resolution)
    return {
      action: 'bind',
      result: {
        mode,
        status: 'retained',
        resolution: view,
        remote: resolution.remote,
        retained: resolution.retained === true,
      },
    }
  }
  let boot
  try {
    boot = await bootstrapVault(resolution, {
      initGitOnCreate: config.initGitOnCreate === true,
      home,
      dataRoot,
    })
  } catch (error) {
    // The same policy as the implicit first write: a refusal before the
    // bootstrap created any project content hands the identity back, so the next
    // call retries the bind cleanly instead of finding a pointer the vault never
    // accepted and skipping the preflight that just refused it. A failure after
    // the first write keeps the identity, exactly as `autoBindProject` does.
    if (error?.vaultWritten !== true) await releaseCreatedPointer(resolution)
    throw error
  }
  // Publish the identity this call established (or confirmed) for this working
  // directory, and only once the bootstrap succeeded: `resolveProject` memoizes
  // a miss, and without this the six tools would keep replaying it until the
  // plugin is reloaded — but publishing before the bootstrap would leave the
  // memo pointing at an identity a refusal had just handed back.
  if (typeof onBound === 'function') onBound(key, resolution)
  return {
    action: 'bind',
    result: {
      mode,
      status: mode === 'fork' ? 'forked' : 'bound',
      resolution: view,
      ...(typeof resolution.previousProjectId === 'string'
        ? { previousProjectId: resolution.previousProjectId }
        : {}),
      bootstrapped: true,
      registryUpdated: boot.registryUpdated === true,
      createdPaths: boot.createdPaths,
    },
  }
}

/**
 * `mem_admin(action="jobs")`: list the queue, inspect one job, or retry it.
 *
 * Retrying is never implicit: without `retry: true` the queue is only read.
 *
 * @param {object} args - the forwarded `mem_admin` arguments.
 * @param {object} seams - the queue root, the decisions ring, and `kickQueueWorker`:
 *   the wake-up a successful retry asks for (absent in a harness with no worker).
 * @returns {Promise<object>} the `jobs` result.
 */
async function jobsAction(args, { queueRoot, diagnostics, kickQueueWorker = null }) {
  const retry = args.retry === true
  const jobId = typeof args.jobId === 'string' && args.jobId !== '' ? args.jobId : null
  if (retry && jobId === null) {
    throw new RangeError(
      'mem_admin(action="jobs", retry=true) needs jobId: name the failed job to retry',
    )
  }
  const read = async () => {
    const { jobs } = await readPendingJobs(queueRoot)
    return jobs
  }
  if (retry) {
    let revived
    try {
      revived = await retryJob(jobId, { queueRoot })
    } catch (error) {
      if (typeof error?.code === 'string') {
        recordDiagnostic(diagnostics, 'job', {
          outcome: 'retry-refused',
          jobId,
          code: error.code,
        })
        const jobs = await read()
        return {
          status: 'refused',
          jobs: jobs.map(toJobView),
          failed: countFailed(jobs),
          message: `${error.code}: ${error.message}`,
        }
      }
      throw error
    }
    if (revived === null) {
      recordDiagnostic(diagnostics, 'job', { outcome: 'retry-missing', jobId })
      const jobs = await read()
      return {
        status: 'refused',
        jobs: jobs.map(toJobView),
        failed: countFailed(jobs),
        message: `no pending job named ${jobId} exists in the queue`,
      }
    }
    recordDiagnostic(diagnostics, 'job', {
      outcome: 'retried',
      jobId,
      projectId: revived.projectId,
    })
    // A revived job is due immediately, but nothing else would wake the worker: a
    // pass arms its next timer only while work is waiting, so an explicit retry is
    // the one caller that has to ask for one. Fire-and-forget by design — the tool
    // result must not wait for a model call.
    kickQueueWorker?.()
    const jobs = await read()
    return {
      status: 'retried',
      jobs: jobs.map(toJobView),
      failed: countFailed(jobs),
      message: null,
    }
  }
  const jobs = await read()
  const selected = jobId === null ? jobs : jobs.filter((job) => job.jobId === jobId)
  const message =
    jobId !== null && selected.length === 0
      ? `no pending job named ${jobId} exists in the queue`
      : null
  return { status: 'listed', jobs: selected.map(toJobView), failed: countFailed(jobs), message }
}

/** How many queued jobs are in the terminal `failed` state. */
function countFailed(jobs) {
  return jobs.filter((job) => job.state === 'failed').length
}
