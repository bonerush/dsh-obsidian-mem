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

- **`AGENTS.md` now opens with two tables instead of a list of commands to
  remember.** The first says when to run what — `check:fast` before a commit,
  `check` before a push, `prepack` for a release, `hooks:install` once and only
  if you want it — and what each one actually runs, so the five-command manual
  sequence is gone. The second is "where the truth lives": ten symptoms mapped to
  the file, test or tool call that answers them, including the two that cost the
  most time to rediscover — a copied checkout failing `codex-mcp` because the
  generated `.mcp.json` holds absolute paths, and anything touching sessions or
  injection timing starting from `docs/p0-compatibility.md` rather than a comment
  in `lib/`. The house style now states the dependency split explicitly: two
  runtime dependencies, everything else a pinned devDependency.

  The `tools.js` budget was raised from 1,950 to 2,050 lines to land the new
  schema, which is the fitness function asking for a decision rather than a
  failure: the raise is registered in the table with the reason and flagged as
  temporary, because the split that follows is what replaces it with a façade.

- **`mem_admin(action="diagnostics")` answers "why did that happen?" without a
  reproduction.** `lib/debug.js` is a bounded ring — 200 events — that records
  decisions from a closed set of categories and a closed set of scalar fields,
  and `lib/index.js` hands one instance to both the services and the hooks so a
  single call answers for the whole plugin. It reads no vault and needs no
  binding, so it still answers when every other action refuses, which is usually
  exactly when it is wanted; and it empties when the process exits, so `jobs` and
  the receipts remain the only things to trust across a restart.
  The privacy boundary is enforced at the door rather than documented and hoped
  for: field names are an allowlist, values are shape-checked, and a note body, a
  title, a path or a prompt is dropped before it can be stored. The test feeds a
  sentinel body through a real call site and requires it to be absent from the
  serialised snapshot, so a future "just one more field, it will help debugging"
  change fails a test instead of shipping. Nothing in the channel can change an
  outcome either — a throwing logger, a throwing clock and a broken injected seam
  are all tested to leave the caller's result untouched.
  Events are emitted today for three of the eight categories: `brief` (injected,
  hint-only or none — the case a developer cannot see any other way), `bind`
  refusals with their code, and the `skill` sync outcome. `capture`, `distill`,
  `index`, `job` and `transaction` are accepted by the ring and by the closed
  output schema but have no call sites yet, which the READMEs say plainly rather
  than implying a completeness this change does not have.
  `DSH_OBSIDIAN_MEM_DEBUG=1` also emits each event through the host logger, at
  `info` rather than `debug` on measurement: the host's exporter uses
  `levels: { default: 2 }` and drops anything above the threshold, so `debug` would
  be asking for a channel that is known to be closed. Unset, the plugin's logging
  surface is byte-for-byte what it was. The DSH side and the Codex MCP server each
  hold their own instance, so the tool always describes the process the caller is
  talking to; the Codex sink writes to stderr and only under the same flag.

- **CI runs the same gate a contributor runs, on three Node versions.** A check
  that exists only in CI is one that passes locally and fails on push, so
  `.github/workflows/ci.yml` runs `npm ci` and then `npm run check` — the identical
  command — across `22.22.2`, `24.x` and `node`. The floor is listed first on
  purpose: `engines.node` claims 22.22.2 is the lowest version with `node:sqlite`
  and FTS5, and an unmeasured floor is a claim rather than a fact. The only steps
  CI adds are the two things a local run cannot supply: the Unreleased gate's
  comparison base and the matrix. There are no secrets, because `npm test` needs
  none, and `permissions: contents: read` is the whole token surface.
  The base is chosen by `scripts/ci-base.mjs` rather than by shell inside the
  workflow, so the one piece of interesting logic is also the one piece with tests:
  a pull request's base commit wins, then a push's previous head, then the merge
  base against the default branch. An all-zero `before` — GitHub's way of saying
  the ref is new — is skipped rather than compared against; a base that is not a
  commit in the clone, or that *is* `HEAD`, exits 1 with the reason instead of
  handing the gate an empty diff to pass. `test/repo-gates.test.js` pins the
  workflow's shape too: the matrix entries, `npm ci` before `npm run check`,
  `fetch-depth: 0` (without it the base commit is not in the clone), and the
  read-only permission.

- **Three rules that were prose now run before a commit.** `npm run check:fast`,
  wired into `.githooks/pre-commit` by the opt-in `npm run hooks:install`, checks
  the *index* rather than the working tree: sources come from `git show :<path>`
  and go into `eslint --stdin` and `prettier --check --stdin-filepath`, both
  pointed at this repository's configs explicitly so a checkout without its own
  config is judged by the same rules. That distinction is the point — with a
  worktree check, `git add -p` lets a commit carry a file whose staged copy fails
  while the check reports green. The two fitness tests still read the worktree, so
  the script refuses rather than guess when any of their inputs has both a staged
  and an unstaged edit. Measured: 1.02 s to reject a staged `lib/` change with no
  changelog entry, 1.47 s to accept one with it, both well inside the five-second
  target the design set.
  `scripts/verify-changelog.mjs` is the Unreleased gate in two modes —
  `--staged` against `HEAD`, `--base <ref>` for CI — and it deliberately stays out
  of `npm run check`, because a check with no comparison base passes vacuously and
  a green that means nothing is worse than no check. A change under `lib/` needs an
  added or amended `## Unreleased` body; an edit to an already-released section does
  not count, and a fix left in the working tree cannot satisfy a staged check.
  A missing ref is an error (exit 2), never an empty success.
  `scripts/install-hooks.mjs` is the only thing in this repository that changes git
  configuration, it must be asked for by name, and it prints `core.hooksPath`
  before and after. `test/repo-gates.test.js` exercises all of it in disposable
  repositories — nine cases, including both directions of the staged-versus-worktree
  distinction — and never touches this checkout's git config.

- **The release gate checks the archive npm really builds, not a frozen count.**
  `scripts/verify-tarball.mjs` (`npm run pack:check`) packs this checkout into a
  temporary directory with `npm pack --json --ignore-scripts` — the flag is
  mandatory, since a bare `npm pack` re-enters `prepack` and would run the suite
  from inside a pack — lists the real `.tgz` and cross-checks the listing against
  npm's own file list. It requires every extant `lib/**/*.js`, the ten mandatory
  assets including both READMEs and `README.i18n.yaml`, and refuses anything from
  `test/`, `docs/`, `research/`, `scratch/` or a vault's `_meta/`, plus any
  `pending/`, `locks/`, `transactions/`, `.jsonl`, `.lock` or probe artefact.
  The design's earlier "33 files" assertion is gone on purpose: it would have
  turned the `tools.js` split into a red build for a change that is supposed to
  add modules. `test/pack.test.js` pins the failure modes against synthetic
  listings — a missing asset, a module on disk that did not ship, a packed
  development tree, a packed vault path — and runs the verifier against this
  checkout once, so the report cannot rot into a comment.

- **The module graph and the repository's own conventions are now tests.** `test/architecture.test.js`
  builds the `lib/` import graph from the TypeScript AST — not a regular
  expression, which is how the first measurement of this graph missed
  `export ... from` and side-effect imports — and fails on a cycle, on an edge
  that points upward *or* sideways between the ten reviewed layers, on a module
  with no declared layer, on a relative import that resolves to nothing, and on a
  file past its approved size. The layer table and the size budgets are a
  reviewed snapshot, so a new module or a grown file becomes a decision someone
  makes rather than a drift nobody sees; `lib/tools.js` and the three files that
  replace it in the split are the first entries to be re-registered under it.
  `test/repo-hygiene.test.js` adds the two conventions that were prose until now:
  `README.i18n.yaml`'s recorded blob hashes must match both READMEs, computed
  from bytes with `node:crypto` so CI and a bare checkout agree, and every
  `npm run` command named in `AGENTS.md` or either README must exist in
  `package.json`. Both were shown to fail — a stale hash record and a documented
  command that does not exist each turn exactly one assertion red — and the
  structural checks were shown to fail four ways: an upward edge, a lateral edge,
  a new module, and a file padded past its budget.

- **Twelve source files are type-checked, and the set can only grow.** `npm run
  types` runs `tsc --noEmit` over an explicit `files` list with
  `checkJs: false`, so each file opts in with a `// @ts-check` marker. The
  mechanism is not a style preference: a checked root file pulls its imports into
  the program, and with `checkJs: true` TypeScript reports on those imports too.
  Measured on a two-file fixture — `checkJs: true` + `files: ['root.js']` reports
  the imported `child.js`; `checkJs: false` with the marker only in the root does
  not; move the marker and the reporting follows it. So `files` is a root list, not
  a boundary, and the marker is the switch.
  The initial twelve were chosen by measuring each candidate alone: nine report
  **zero** diagnostics (`lib/git.js`, `lib/index.js`, `lib/naming.js`,
  `lib/paths.js`, `lib/pointer.js`, `lib/receipts.js`, `lib/registry.js`,
  `lib/routing.js`, `scripts/verify-pack.mjs`) and three report one each, now
  fixed: a `null`-narrowed memo in `codex/server.mjs` whose declared type was
  restored (`TS18047`), an `options = {}` default that contradicted a required
  JSDoc field in `lib/search.js` (`TS2741`), and a signal name typed as `string`
  where `child.kill` wants `Signals` in `scripts/run-tests.mjs` (`TS2345`).
  `skipLibCheck: true` is part of the configuration and is load-bearing: without
  it those same files report `TS2307` and `TS6200` from inside
  `@deepseek-ai/dsh-llm`'s own declarations, which is a conflict between
  third-party types rather than anything in this repository.
  `test/repo-hygiene.test.js` asserts the marked set and the `files` list are equal
  in both directions — a marker outside the program would be silently unchecked —
  and that no shebang has been pushed off line 1, which is what a marker written
  above one does. Both were proven able to fail: dropping a marker, marking an
  unlisted file, and moving a marker above a shebang each turn exactly one
  assertion red.

- **The memory layer now runs under Codex CLI, through an MCP server that reuses
  `lib/` instead of copying it.** `codex/server.mjs` speaks MCP on stdio and
  dispatches the same six operations the DSH tools expose —
  `mem_search`/`mem_read`/`mem_write`/`mem_log`/`mem_brief`/`mem_admin` — to the
  same `createMemoryServices()`; the argument schemas are derived from
  `TOOL_PARAMETERS` and the names from `TOOL_NAMES`, so the two surfaces cannot
  drift apart. A local marketplace (`codex/marketplace/`) ships a Codex edition of
  the skill plus the generated `.mcp.json`, installed with
  `codex plugin marketplace add` and `codex plugin add`; `codex/README.md`
  documents the lighter `codex mcp add` variant. **What does not carry over is
  stated rather than implied**: there is no distillation of finished turns and no
  recall injection, because MCP offers tools and not turn boundaries. Measured end
  to end in `test/codex-mcp.test.js` (6 cases): a real stdio handshake, a write and
  a search against a throwaway vault, plus the one seam that would otherwise bind
  the wrong project — the working directory comes from the client's `roots/list`,
  not from the plugin directory Codex launches the server in. That seam also
  produced the bug the test now pins: awaiting the `roots/list` answer inside the
  `initialize` handler deadlocks the serialised message queue, because the answer
  is itself a queued message.
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

### Changed

- **`lib/tools.js` is a 22-line façade instead of a 2,006-line file, and the
  three jobs it held are three modules.** Task 11 of the harness plan named this
  as the structural change the other eleven tasks only made safe, and it is the
  only place this round moved code rather than adding it:

  | Module | Lines | Owns |
  |---|---|---|
  | `lib/tool-schema.js` | 847 | the parameter specs, the closed output schemas, and the argument rules every `execute` shares |
  | `lib/tool-registry.js` | 198 | the six `defineTool` definitions and `registerTools` |
  | `lib/services.js` | 1,024 | service lifetimes, binding/index caches, admin dispatch, projections |
  | `lib/tools.js` | 22 | four re-exports and nothing else |

  **Nothing outside `lib/` changed an import.** `lib/index.js`, `codex/server.mjs`
  and all nine test files still do `import … from './tools.js'` (or
  `'../lib/tools.js'`), which is the point: a façade both entry points already
  import *is* the seam, so the move is invisible to them and a future move will be
  too. Two new tests hold that: `test/tools-facade.test.js` asserts that the
  façade exports exactly the four published names, that each one is the *same
  value* the owning module holds rather than a structurally equal copy, and that
  the DSH runtime and the Codex `listTools()` describe the same six tools; the
  pack fixture asserts that dropping a re-export fails the package check.
  Measured, not asserted: removing the `registerTools` re-export fails the whole
  file at import time, and rebuilding `TOOL_NAMES` as a local `Object.freeze([...])`
  — which compiles, type-checks and behaves identically — fails on reference
  identity with `TOOL_NAMES must be re-exported, not rebuilt`.

  The package verifier moved with it, because a check that reads the old path
  reports success about a file that no longer contains a registration:
  `scripts/verify-pack.mjs` now scans `lib/tool-registry.js` for the six
  `name: 'mem_x'` sites **and** reads `lib/tools.js` for the four re-exports, as
  two separate checks that fail for two different reasons. The verification
  output says so: `6 tools registered and 4 names published`.

  The move also made one deliberate asymmetry visible enough to write down. The
  MCP adapter closes the argument root (`additionalProperties: false`) and the DSH
  runtime leaves it open, which is the entire reason `assertKnownArguments` exists
  — DSH hands an undeclared key to `execute`, the adapter refuses it at the
  schema. That difference is now asserted per tool instead of being rediscovered;
  so is the adapter's habit of always writing `required`, which DSH omits when it
  is empty. `test/architecture.test.js` records the new layers
  (`tool-schema` L3, `tool-registry` L4, `services` L8, the façade L9, `index` L10)
  and the four budgets, on the same rule as every other file: the façade's budget
  is 100 lines, which *replaces* the temporary 2,050 rather than extending it.

- **Every vault path is ASCII now: the directory names, and the file names the
  plugin fixes itself.** `项目/`→`Projects/`, `文档/`→`Docs/`, `决策/`→`Decisions/`,
  `约定/`→`Conventions/`, `踩坑/`→`Pitfalls/`, `日志/`→`Daily/`, `收件箱/`→`Inbox/`,
  `方法/`→`Methods/`; the project registry moved to `_meta/registry.md` (was
  `_meta/项目注册表.md`), the glossary to `Docs/glossary.md` and the hot archive to
  `Docs/hot-archive.md`. A vault path now survives a shell that is not UTF-8, an
  archive round-trip, a URL, and any tool that mangles CJK — which is the whole
  reason it changed. **A note's own file name is unchanged in kind**: it is still
  derived from the title in whatever language the writer used, because the name is
  a rendering and frontmatter `id` is the identity. That distinction is now written
  down in `README.md`/`README.zh.md`, in the shipped skill
  (`skills/obsidian-mem/SKILL.md`, "Every directory name is ASCII…") and in
  `AGENTS.md`. The suite was updated with it: 566/566 pass, and the fixtures'
  directories were renamed while their *note* file names stayed Chinese, which is
  exactly the rule.
- **A breaking change with no automatic migration.** The plugin does not convert an
  existing vault: notes stay where they are, but the project directory, the
  registry path and every MOC wikilink still name the old directories, so
  `mem_admin(action="projects")` will not resolve the project and `nextAdrNumber`
  will not see existing ADRs. The vault this repository dogfoods was migrated by
  hand instead: directories renamed, path-qualified wikilinks and the
  generated-region declared hashes rewritten, the registry rewritten, and the
  receipt path keys in `$DSH_HOME/data/obsidian-mem/receipts/` remapped so that
  "this plugin owns this file" still checks out. A running harness must be
  restarted afterwards — plugin code is loaded once per process.
- **The frozen design document still shows the old names.**
  `docs/superpowers/specs/2026-09-23-dsh-obsidian-mem-design.md` (D5, §5.1, §6.1)
  records the decision as it was taken; the code, the shipped skill, the tests and
  the README pair describe the current tree. Likewise `docs/dogfood-results.md`,
  `docs/smoke-results.md` and `test/smoke/records/smoke-record.json` are records of
  runs that really happened under the old names, and rewriting them would claim
  something that never occurred.

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

### Remaining from the engineering-harness plan

Stated here rather than left to be discovered, because rule 6 puts the untested
and unfinished list in this file. The plan's structural task — `lib/tools.js`
split into `tool-schema.js`, `tool-registry.js` and `services.js` behind an
unchanged façade — **is done**, and is written up under *Changed*. What follows is
what is still open.

- **Five of the eight diagnostics categories have no call sites.** `brief`,
  `bind` and `skill` emit today; `capture`, `distill`, `index`, `job` and
  `transaction` are accepted by the ring and by the closed output schema but
  nothing writes them yet, so a window will often be sparse. The READMEs say so.
  Adding them is additive — no schema or contract change is needed.
- **CI has never run.** The workflow is committed and its shape is tested locally,
  but nothing has been pushed, so the `22.22.2` leg of the matrix is unmeasured —
  and that is the leg that decides whether `engines.node` stays honest. Until
  GitHub reports it green, the floor is measured on one machine only.
- **The type ratchet covers twelve files of twenty-eight candidates.** The full
  per-file counts are in the design at
  `docs/superpowers/specs/2026-09-25-engineering-harness-design.md` §7.3;
  `lib/pending.js` alone reports 78 and is why the first tier stopped where it did.
- **The smoke suite was not re-run.** It needs a model credential and an isolated
  profile, so nothing in this release has exercised a real DSH session end to end.
  The repository checks passing says nothing about that, and this entry is the
  only claim either way.

### Fixed

- **The callback JSDoc in `lib/hooks.js` and `lib/transaction.js` now parses
  under TypeScript 7 as well as 5.9.** Five `@param {function(string): T}` type
  expressions used the Closure dialect, which TypeScript 7.0.2 — today's
  `latest` on npm — rejects with `TS1005`, and the rejection cost the eight
  `@param deps.*` entries below them their binding (`TS8032`). Measured on the
  same two files with `checkJs: true`: **5 + 8 diagnostics under 7.0.2, 0 + 0
  under the pinned 5.9.3**, and 0 + 0 under both after this change. The pinned
  compiler never reported it, so this is portability rather than a repair: the
  arrow form is accepted by both, and it can name its parameter, which the
  Closure form cannot. `test/jsdoc.test.js` freezes the form and its failure
  message states the measurement, so the next person sees why the rule exists.
- **ESLint's first honest run over this tree found 43 problems; all 43 are now
  either fixed or disabled at the site with the reason.** The repository had no
  linter, so nothing had ever looked. Twelve dead stores (`let corrupt = false`,
  `let record = null`, `let age = 0`, `let gitInitialized = false` and eight
  more) were overwritten before any read and are now bare declarations; twenty
  unused bindings and imports are gone, including a whole `seedSpecs` object in
  the smoke runner that nothing had read since a refactor; `lib/paths.js` and
  both `scripts/verify-pack.mjs` rethrows now attach `{ cause }` instead of
  discarding the failure underneath the wrapper. The eight that remain are
  deliberate and stay visible: six `no-control-regex` sites and two
  `no-misleading-character-class` sites strip control characters and match emoji
  code points one at a time, so each carries an inline
  `eslint-disable-next-line` naming that reason. `no-undef` is never disabled —
  it is the rule that found the `TransactionError` defect fixed in `e31fa13`.
  Behaviour is unchanged: 574 tests pass before and after, and the pack verifier
  still reports `OK`.

- **A `retain` whose registry transaction failed threw `ReferenceError:
  TransactionError is not defined` instead of the refusal it documents.**
  `lib/vault.js` re-exports `TransactionError` — "every importer keeps going
  through this module" — but a re-export puts a name in the export namespace and
  not in the module's own scope, and the `catch` that decides between a refusal
  and a rethrow tested `error instanceof TransactionError`. The `||` beside
  `error instanceof BootstrapError` hid it for the one error type that was
  genuinely in scope, so the only path that broke was the bind-conflict path the
  catch exists for. Introduced with the catch in `8c988dd` and never covered: no
  test asked a `retain` to survive a failed transaction. Found by ESLint's
  `no-undef` on the first run over the tree — one finding in 58 files — which is
  the engineering-gate work this entry's neighbours will describe. Regression
  test: `test/lint.test.js`, where a real unresolved transaction (a
  fault-injected write to the project index, then an external edit to that same
  file) now yields `{kind: 'conflict', reason: 'recovery-required'}` and leaves
  the externally edited file byte-identical. Before the fix that test failed with
  exactly the `ReferenceError` above, at `lib/vault.js:504`.

- **Every turn in a bound project failed on DSH 0.1.7 with `format v4 message
  requires a producer-owned source kind`.** Recall injection stamps a `source` on
  the `user/message` it inserts, and `lib/hooks.js` stamped the retired
  `{kind: 'plugin', plugin: 'obsidian-mem'}` wrapper. Session format v4 refuses
  `kind === 'plugin'` outright — both on write, in the gate that runs before
  `encodeEvent`, and on read — so the message could not be persisted and the turn
  aborted (`本轮运行失败`), which is the failure a real user hit. The source is now
  `{kind: 'plugin:obsidian-mem', form: 'recall'}`: the host's own producer-kind
  convention for a third-party plugin, and the exact value the v3→v4 converter
  derives from the old wrapper (`producerKind()` in
  `dsh-session-format-v3-to-v4`), so a session converted from v3 and a session
  written under v4 name the same producer. `engines.dsh: ">=0.1.5-rc.2"` stays
  honest because the 0.1.5-line writer admits the new kind verbatim — a
  `user/message` there only requires a nonempty string kind, and it is the
  *v2→v3* migration's allow-list, not the current writer, that ever named
  `plugin`. Measured with `test/p0/run-v4-source-probe.mjs`, which drives the
  installed host's own gates rather than a reimplementation of them, and records
  four cases in `docs/p0-compatibility.md` §10: (A) the retired wrapper is refused
  by v4's `assertV4RowAdmission` with exactly the error above; (B) the new kind is
  admitted; (C) the real catalog restore over a real v3 session
  (`zstd -dc` — the files are concatenated frames, and Node's
  `zstdDecompressSync` reads only the first) derives
  `{"kind":"plugin:obsidian-mem","form":"recall"}` for this producer; (D) a
  0.1.5-line `encodeCurrentEvent` stores the new kind verbatim. A corpus
  cross-check of 258 of the user's session files found 14 messages carrying the
  retired wrapper and none carrying the v4 kind, which is what makes the diagnosis
  the only one consistent with the evidence. Regression tests:
  `test/hooks.test.js` — the injected message's `source` asserted field by field,
  plus a host-free pin of the v4 rule (`assert.notEqual(RECALL_SOURCE.kind,
  'plugin')` and `assert.equal(RECALL_SOURCE.kind, \`plugin:${PLUGIN_ID}\`)`, both
  hardcoded, so the value cannot move with the module). The two recall filters in
  `test/lint.test.js` are not themselves regression tests — they find the
  plugin's messages by importing `RECALL_SOURCE`, so they would follow the module
  — but the second one is what caught the first, incomplete version of this fix,
  because it still matched the retired `source.plugin`: only running the whole
  suite reported it.
- **The shipped skill no longer claims a `not-ready-in-p1` status the code cannot
  produce.** All six `mem_admin` actions were implemented in Task 17 and
  `test/tools.test.js` asserts the marker is absent from a result; the sentence
  survived in `skills/obsidian-mem/SKILL.md` and was copied into the new Codex
  edition before anyone re-read it. Both now name the two real "cannot answer yet"
  shapes — `mem_brief` answers `status: 'unbound'` for an unbound repository, and
  an index-backed search raises `index-not-ready` until the first scan finishes —
  and both list `report`/`prune` among `mem_admin`'s arguments, which they had also
  omitted.
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
- **Not verified: the 0.1.5 line's read/replay side for a `plugin:` kind.**
  `docs/p0-compatibility.md` §10 measured that line's *writer* admits the kind the
  recall source now carries, but no real session was replayed through it here, so
  whether its reader adds any further kind filtering is not known. The 0.1.7 read
  side *is* covered — the conversion in §10 case C runs the production catalog
  restore over a real v3 session.
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
