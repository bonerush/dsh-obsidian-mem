# Changelog

All notable changes to this plugin are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The package is not published to a registry and carries no tag yet, so `0.1.0`
below is the version recorded in `package.json` and `dsh.plugin.json` during
development rather than a release artifact. The source is public on GitHub; that
is a repository, not a release.

## Unreleased

### Added

- **The package now declares itself the way the ecosystem does.** `package.json`
  gains `keywords`, `repository`, `homepage`, `bugs` and `engines.dsh` — the
  position the plugin market reads. The GitHub repository carries the
  `dsh-plugin` topic that the harness's own plugin search queries. The install
  instructions lead with the ecosystem's `github:bonerush/dsh-obsidian-mem` spec
  instead of a local checkout. Nothing about the plugin's runtime behaviour
  changed; `engines.node` is untouched.
  Measured end to end against the published repository: in a throwaway
  `DSH_HOME`, `dsh plugin --profile memcheck add
  github:bonerush/dsh-obsidian-mem` resolves to
  `dsh-obsidian-mem github:bonerush/dsh-obsidian-mem` and `--dump-config` then
  prints the `obsidian-mem` row.
- **`README.zh.md`, a Chinese README that carries equal authority with the
  English one.** It follows the convention the first-party packages use:
  the `[English](README.md) | 中文` switcher, an explicit `<a id="…">` for every
  heading a link targets so one anchor resolves from either language, and
  `README.i18n.yaml` recording the git blob hash of each side as of the last
  confirmed-consistent state. Measured in one installed harness: of 240 packages
  under `@deepseek-ai/`, the 231 that ship a README ship all three files, and the
  eight English-only ones are vendored upstream packages (`cordis`,
  `schemastery`, `cosmokit`, `cordis-plugin-*`). The translation is not reviewed
  by a native reader; that stays listed in the untested inventory at the end of
  this file.
- **The repository is public at
  <https://github.com/bonerush/dsh-obsidian-mem>.** This is the project's remote;
  `main` is the published history. It remains unpublished to npm and untagged.

### Removed

- **The README no longer explains how to disable another memory plugin.** The
  step-by-step walkthrough that named one specific third-party plugin — and told
  readers to append a row to their own `$DSH_HOME/cordis.patch.yml` — is gone from
  both language sides, and no shipped document names that plugin any more. It read
  as though this plugin needed that done before it would work. It does not: this
  plugin mounts one row, requires nothing of what else is mounted, and does not
  care which other memory layer is present. The constraint the section was
  illustrating is unchanged and still enforced — no script in this repository
  edits a user's configuration, and `prepack` stays a read-only verifier
  (`AGENTS.md` rule 1).
- **The README no longer carries the "DSH plugin conventions" table.** The eight
  conventions are unchanged and still followed — the bundle patch, the ESM entry,
  the `github:` install spec, the `dsh-plugin` topic, `engines.dsh`, the registry
  manifest, the portable skill and the bilingual pair. What is gone is the table
  that named them in one place, so the measurements it cited are kept here rather
  than lost: nothing in an installed harness reads `engines.dsh`, and 231 of the
  240 packages under `@deepseek-ai/` ship the three-file bilingual README set.
- **The README no longer carries a "Not verified" list.** The list was cut to keep
  the landing page short; no item on it stopped being true. The untested inventory
  now lives only in this changelog — the `Not verified:` bullets under `0.1.0`'s
  *Known limitations and remaining risks*, plus every Unreleased entry — and the
  README now says plainly that its boundaries are what it writes down rather than
  a complete set. `AGENTS.md` rule 6 keeps the requirement and names this file as
  the list's home.

### Fixed

- **The queue worker no longer reports the host's shutdown as a caller
  cancellation.** DSH disposes the whole plugin tree when a headless run's
  session completes; the worker's fiber disposer ran `controller.abort()` inside
  that teardown, which the LLM service reports as a terminal
  `finish.reason.kind === 'aborted'`. Every such pass therefore recorded a failed
  attempt the model never produced (`lastError.code === 'aborted'`), consumed the
  R43 retry bound, and left the headline path — completed turn → real
  distillation → automatic write — unverified on a real host. Measured in
  `docs/p0-compatibility.md` §9 with a disposable probe
  (`test/p0/run-teardown-probe.mjs`, 13 assertions): the tree teardown does *not*
  kill an in-flight stream (a 7.2 s stream finished 4.7 s after its provider
  fiber was `DISPOSED`), so `stop()` now stops scheduling and lets the in-flight
  pass settle, while a new `abort()` keeps the real cancellation path (and its
  truthful `aborted` reason). Regression tests:
  `test/auto-capture.test.js` (`a host unload mid-call lets the job finish
  instead of reporting a caller abort (Task 18b)`, and the explicit-`abort()`
  counterpart).
- **A settling pass finishes exactly one job — the one already in flight.** A pass
  snapshots `llm` once and iterates every due job, so letting it settle without a
  boundary re-created the same defect one job later: after the disposal the
  snapshotted handle answers `NO_ADAPTER`, `distill.js`'s route check still
  accepts it, and each remaining job would record a failure the model never
  produced until it terminally failed. The worker now hands the pass an
  `isStopped` predicate; once it is stopping, the remaining due jobs are deferred
  as `unloaded` and are not written at all, so the next process resumes them with
  `attempts` untouched. Regression test: `a pass that outlives the plugin tree
  defers the rest of the queue instead of failing it (Task 18b)` (two due jobs,
  RED before the fix with `2 !== 1`).
- **Live model distillation is now verified end to end.** The isolated-profile
  smoke (`docs/smoke-results.md`) now scores the worker's own model-backed
  distill: a real completed turn, a real `deepseek-official`/`deepseek-flash`
  call with a real token `usage`, and either a `dry-run` receipt that wrote
  nothing or an `applied` receipt that wrote the note — both with `attempts: 0`.
  The checker only treats a lane as "skipped" when the runner sets an explicit
  `skipped: true` (`--only`); a lane that ran and captured nothing is a failure,
  so the acceptance can no longer pass on a total capture failure.
  `test/smoke/negative-controls.mjs` covers both model-lane mutations.

- **A Git repository with no `.obsidian-mem` is bound by its first write, and a
  bind is visible in the session that made it.** The dogfood run measured
  (`docs/dogfood-results.md` §10 F1) that every internal seam resolved with
  `mode: "show"`, so a pointerless repository had no reachable automatic bind
  path at all — `mem_write` refused with `not-bound` — and that the unbound
  resolution was memoized per working directory for the life of the loaded
  plugin, so even an explicit `mem_admin(action="bind", mode="local")` left the
  six tools refusing until a new session. `mem_write` and `mem_log` now resolve a
  `no-pointer` Git repository exactly as spec §5.2.3 / §5.3 describe — slug from
  the Git root, exclusive pointer create, skeleton, registry row — and then
  proceed; a successful bind (automatic or explicit) replaces the per-cwd miss,
  so the next call in the same session sees it. Every fail-closed guard is
  unchanged and still refuses rather than minting: a non-Git directory, a corrupt
  or unknown-schema pointer, an unreadable registry, a taken directory, a
  cloud-managed vault and an unreadable sibling worktree. A resolution that
  already minted a pointer and then refuses now removes the pointer it created,
  so a one-off refusal cannot become a sticky one; an automatic bind that meets a
  bootstrap refusal releases the pointer only when the bootstrap created no
  project content (`vaultWritten`), so the §6.4 property preflight, a registry
  whose recorded sha256 does not cover its body and every other pre-write refusal
  leave the repository exactly as the write found it. Reads still never bind. The
  README "Project bound" row and the "A repository refuses to write", "A plain
  directory stays read-only" and "Memory is silently absent" recovery rows now
  describe this, replacing the Task 20 text that documented the defect instead.
  Regression tests: `test/auto-bind.test.js` (15 cases through the shipped tool
  runtime; 14 fail against the previous `lib/` — the one pass is the
  cloud-managed guard, which refuses before any binding work).
  A `deferred` job can also be a validation refusal (`truncated`,
  `too-many-items`) backing off, which the recovery table previously attributed
  only to a missing route or binding.
- **A transaction manifest read from disk is no longer trusted with a path.**
  `txId` and `vaultHash` are the two manifest fields that name one:
  `discard()` removes `_meta/.history/<txId>/` inside the vault, and
  `writeManifest`/`removeManifest` write or delete
  `<dataRoot>/transactions/<vaultHash>/<txId>.json`. Both were taken verbatim, so
  a manifest carrying `txId: "../../.."` or a traversing `vaultHash` deleted or
  wrote **outside** the vault. Every manifest read from disk — recovery,
  `listPendingIndexNotifications` and `markIndexNotified` — and every act site
  that joins one of those fields re-applies the request-path rules
  (`[A-Za-z0-9][A-Za-z0-9._-]{0,127}` and 64 lowercase hex) and refuses with
  `manifest-corrupt` instead of acting on it. This is hardening rather than a
  fixed violated invariant: it takes a same-user process rewriting
  `$DSH_HOME/data/obsidian-mem/transactions/`. Regression tests:
  `test/transaction.test.js` (`a manifest whose txId traverses is refused, and
  nothing outside the vault is deleted`, and its `vaultHash` twin) — both
  falsified against the previous `lib/`.
- **The smoke checker no longer passes a model lane that is absent.** A record
  with no `capture.modelLane` (or one missing a lane) scored both
  `model-lane-*-real-distill` checks as PASS, because `lane === undefined` was
  read as "skipped by `--only`". The runner also dropped the `skipped` sentinel
  when it rebuilt the lane, so a real `--only live` / `--only dry-run` run
  *failed* a lane that never ran. Absence is now a failure, only the runner's
  explicit `skipped: true` marks a lane as not run, and the runner projects that
  flag. `test/smoke/negative-controls.mjs` covers both directions (absent lane and
  the absent-`modelLane` shape fail; the sentinel still passes).

### Changed

- **Honest limits corrected** (`README.md`, `docs/smoke-results.md`): the
  "no live model call has ever been made" item is replaced by what is still
  unmeasured (one host, one route; the one-shot timing window; the Obsidian GUI).
- **An unknown config key is now refused instead of silently ignored.**
  schemastery's `z.object` passes unknown keys through, so a hand-written row with
  a typo (`vaultpath`) kept `vaultPath`'s default and pointed the plugin — and its
  bootstrap — at a different vault. `validateConfig` now refuses an unknown
  top-level or `distill` key, names it, and lists the design document's
  deliberately-dropped fields (`projectsDir`, `methodsDir`, `metaDir`,
  `reservedPrefixes`, `docMirror`, `distill.mode`, `distill.maxCostPerSession`).
  **Action for anyone who copied the design document's §12 block:** those fields
  now produce a loud error where they used to be a silent no-op. Remove them; the
  accepted field set is the README table.

## 0.1.0 — 2026-09-23

First version. Everything here was built and reviewed inside this repository;
no pack of this plugin has been installed from a registry.

### Added

- **A dedicated-vault project memory protocol written in plain Markdown.** A
  committed four-field `.obsidian-mem` pointer (`projectId`, `slug`,
  `displayName`, `schema`) binds a repository to one fixed directory,
  `项目/<slug>--<projectId 前8位>/`, inside the vault. The pointer carries no
  absolute path, so one project ID and one vault path per machine are enough to
  move a checkout.
- **Idempotent bootstrap.** First contact creates only what is missing: the
  project skeleton, `index.md`, `_meta/hot.md`, one MOC per type directory and
  the vault registry row. Existing files are never overwritten, existing vaults
  are never restructured, and `initGitOnCreate` runs `git init` only on a
  directory this plugin just created (it never commits and never configures a
  remote).
- **Three-tier memory.** A hot file (`_meta/hot.md`, ≤ `hotCapacityChars`,
  default 9000) with 强约束 / 进行中 / 已完成 zones, a warm layer of on-demand
  notes reached through `mem_search` → `mem_read`, and an append-only daily
  cold log — plus a read-only `_meta/user.md` for preferences the plugin never
  writes.
- **One budgeted recall injection.** After the first `agent/pre-step` of a
  session, a single recall message (≤ `briefBudgetChars`, default 6000 code
  points, with a footer reporting the exact usage) is appended. Later steps only
  receive a delta when the hot layer's content hash changes. A not-ready index is
  reported as not-ready, never as "no memory".
- **Six tools**: `mem_search`, `mem_read`, `mem_write`, `mem_log`, `mem_brief`
  and `mem_admin` (actions `lint`, `index`, `bind`, `projects`, `promote`,
  `jobs`). Deliberately capped at six.
- **A rebuildable search index outside the vault** — `node:sqlite` FTS5 with CJK
  overlap-bigram tokenisation and a scan fallback (`indexBackend: auto`) that
  reports the degradation instead of pretending it did not happen.
- **A transaction engine for multi-file writes**: a whole-vault write lock keyed
  by `realpath(vaultPath)`, pre-write snapshots under `_meta/.history/<txId>/`,
  exclusive publish via `link(2)`, per-step receipts and crash recovery from a
  journal under `$DSH_HOME/data/obsidian-mem/transactions/`. A file whose hash no
  longer matches what this plugin wrote is a conflict, and conflicts stop the
  write rather than overwriting the edit.
- **Automatic distillation of completed turns** into `decision` / `gotcha` /
  `convention` candidates: a durable 0600 pending queue, credential scrubbing,
  an idle debounce (`captureIdleMs`, default 90 s), a single no-tool model call,
  strict JSON validation against the evidence sequence numbers, and idempotent
  application keyed by `sessionId:toSeq:itemIndex`. Below-threshold candidates go
  to `收件箱/`; `dryRun: true` writes receipts only.
- **Governance**: supersede instead of overwrite, `contested` when two claims
  cannot be ranked, `assertion` (`stated` / `inferred` / `observed`) and
  `confidence`, `review_after` expiry, and `mem_admin(action="lint")` health
  reports (orphans, dead links, frontmatter gaps, expiry, file↔index mismatch,
  unreferenced repository Markdown, queue backlog) that are read-only unless a
  write is explicitly requested.
- **A portable skill** (`skills/obsidian-mem/SKILL.md`) synced idempotently into
  `$DSH_HOME/skills/obsidian-mem/`, written in the Agent Skills format so it
  survives a change of harness.
- **Packaging**: an explicit `files` allowlist, a `prepack` gate
  (`npm test` + `scripts/verify-pack.mjs`) and `npm test` running inside a
  throwaway `DSH_HOME`.

### Fixed

- `npm test` now runs with `DSH_HOME` set to a fresh temporary directory. An
  earlier version relied on per-test convention and a test that activated the
  plugin installed a skill into the real `~/.dsh/skills/`.
- `@deepseek-ai/cordis` and `@deepseek-ai/dsh-tools` are declared as
  `devDependencies`. They are *optional* peers, so npm deliberately does not
  install them; the suite used to pass only because hand-made symlinks happened
  to sit in the gitignored `node_modules/`, and a clean `npm ci` failed at import.
- `skills/obsidian-mem/SKILL.md` had a mangled sentence about file timestamps
  ("Use never file timestamps to invent a date"); it now reads "Never use file
  timestamps to invent a date".
- **The full suite now passes on the declared minimum Node (22.22.2).** The
  timeout case in `test/distill.test.js` waited on an `AbortSignal.timeout()`
  timer, which is unref'd, so on Node 22.22.2 that subtest and the five after it
  were cancelled with `Promise resolution is still pending but the event loop has
  already resolved` and `npm test` exited 1. A ref'd keep-alive timer now holds
  the loop open until the 20 ms timeout fires. This was found by Task 19's
  minimum-Node regression run, which had not been repeated since the case was
  added.

### Security

- Path handling refuses symlinks at every level, `..`, absolute paths and device
  paths, and refuses to treat an I/O failure (`EACCES`, `EDEADLK`, `EIO`) as
  "file absent" — on cloud-backed storage that is exactly how an offloaded file
  looks.
- A vault under a known macOS cloud root (`~/Library/Mobile Documents/`,
  `~/Library/CloudStorage/`) refuses **reads as well as writes**
  (`vault-cloud-managed`), because an on-demand file is as unsafe to read as it
  is to write.
- Every generated block carries a content hash in its marker
  (`<!-- obsidian-mem:registry begin sha256:… -->` and the `generated` variant).
  A block whose declared hash no longer matches has been edited by a human: the
  write stops and reports a conflict.
- The distillation input is a whitelist projection (real user messages, final
  assistant text, tool names and exit status, bounded paths). It never reads the
  credential store or environment, reasoning blocks, raw tool output, plugin
  injections or subagent transcripts, and a deterministic scan skips any message
  that matches a common credential shape.

### Known limitations and remaining risks

These are stated here as well as in `README.md` because they are properties of
this release, not caveats about it. Nothing in this list is a bug report; each
one is a boundary that was measured, or explicitly not measured.

- **Not verified: no live model call.** `ctx.llm.stream` was measured against the
  installed host in `docs/p0-compatibility.md` §8, but the distillation code path
  itself has only ever run against stubs built to those measured shapes. It has
  never distilled a real turn on a real route.
  *(Superseded by Unreleased: the isolated-profile smoke now distils a real turn
  through the real route — `docs/smoke-results.md`.)*
- **Not verified: no power-loss test.** Crash recovery is exercised with
  `SIGKILL` at specific barriers, not with an actual power cut or a kernel-level
  flush failure.
- **Not verified: cross-process lock contention.** The whole-vault write lock is
  exercised within one process and against a dead child; two live processes
  contending for the same vault have not been tested. The lock does not restrain
  Obsidian or any other editor at all.
- **Not verified: Obsidian's own rendering.** GUI rendering, typed properties and
  the property-type registry (`.obsidian/types.json`) have not been checked
  against a running Obsidian. The write preflight can only see types visible in
  note bytes.
- **Not verified: `fork` / `retain` across sibling worktrees.** Both modes have
  tests, but not on the worktree-sibling layout they exist for.
- **Residual path-jail limits.** Hard links and bind mounts are indistinguishable
  from ordinary files, and there is a classic `lstat` → `open` TOCTOU window on
  the write path.
- **`withVaultLock` is not re-entrant.** A nested acquisition would deadlock.
- **A `no-binding` or `no-route` job re-arms indefinitely** rather than becoming
  terminal, at a bounded rate of at least one queue-file write per idle window.
- **`MAX_REFUSED_ENTRIES = 32` caps a job's refusal audit**, so a receipt can
  report 32 when more candidates were dropped.
- **`dsh.plugin.json` is inert.** Nothing in DSH core reads it, so a stale
  version there has no runtime effect — which is exactly why `prepack` fails when
  it disagrees with `package.json`.
- **The Chinese README has not been reviewed by a native reader.**
  `README.i18n.yaml` records the two blob hashes as consistent, which proves the
  pair is the revision that was intended, not that the Chinese reads well. A
  wording fix on that side is a welcome pull request.
