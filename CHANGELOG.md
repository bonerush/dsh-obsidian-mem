# Changelog

All notable changes to this plugin are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The package is not published to a registry and carries no tag yet, so `0.1.0`
below is the version recorded in `package.json` and `dsh.plugin.json` during
development rather than a release artifact.

## Unreleased

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
- **Live model distillation is now verified end to end.** The isolated-profile
  smoke (`docs/smoke-results.md`) now scores the worker's own model-backed
  distill: a real completed turn, a real `deepseek-official`/`deepseek-flash`
  call with a real token `usage`, and either a `dry-run` receipt that wrote
  nothing or an `applied` receipt that wrote the note — both with `attempts: 0`.

### Changed

- **Honest limits corrected** (`README.md`, `docs/smoke-results.md`): the
  "no live model call has ever been made" item is replaced by what is still
  unmeasured (one host, one route; the one-shot timing window; the Obsidian GUI).

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
