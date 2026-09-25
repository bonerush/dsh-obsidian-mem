# dsh-obsidian-mem Engineering Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add reproducible repository checks, bounded runtime diagnostics, and a focused `tools.js` split so contributors can locate, verify, and debug changes with less context.

**Architecture:** Keep the Node ESM plugin and six-tool contract. Development checks run through `npm run check`; an opt-in hook checks staged content; a process-local diagnostics object is shared by each entry point's services and hooks. Split `tools.js` by contract, DSH registration, and service assembly behind its existing imports.

**Tech Stack:** Node.js `>=22.22.2`, `node:test`, ESLint flat config, Prettier 3, TypeScript 5.9 JS diagnostics, GitHub Actions, Cordis/DSH and the existing Codex MCP adapter.

**Spec:** `docs/superpowers/specs/2026-09-25-engineering-harness-design.md` (reviewed 2026-09-25). Read its §4–§13 before execution; the 2026-09-23 plugin protocol spec remains authoritative for vault and host behavior.

## Global Constraints

- Keep `engines.node: ">=22.22.2"`, Node ESM, the six `mem_*` tools, and the runtime dependency set (`@deepseek-ai/schemastery`, `yaml`) unchanged. New lint/format/type packages are devDependencies only.
- Keep `npm test` as `node scripts/run-tests.mjs` with its temporary `DSH_HOME`; tests and probes use disposable vaults and data roots. Never point them at `~/Documents/knowledge` or a real `$DSH_HOME/data/obsidian-mem/`.
- Keep `prepack` exactly a read-only verifier (`npm test && node scripts/verify-pack.mjs`). Actual `npm pack --ignore-scripts` belongs in the separate `pack:check` script.
- Do not edit a user's `cordis.patch.yml`, install hooks without `npm run hooks:install`, or write a Git `Co-Authored-By` trailer.
- If either README changes, update both in one commit and refresh both `README.i18n.yaml` blob hashes. Update `CHANGELOG.md` Unreleased alongside each post-hook `lib/` change.
- Re-read `docs/p0-compatibility.md` before changing DSH event, `ctx.llm`, or injection wiring. Every behavior change gets a red-then-green test through the real seam.
- The CodeGraph index initialized for the design review is local generated state (`.codegraph/`); do not package or commit it. Verify the branch/worktree and preserve unrelated local edits before every commit.

## Execution order and review gates

The first task establishes formatter scope, then makes **one isolated format-only commit**. Tasks 2–4 make static gates green. Tasks 5–8 add repository and CI gates. Tasks 9–10 deliver diagnostics. Task 11 performs the code split. Task 12 closes docs and evidence. Review each commit after its task; stop if a gate that the task promises remains red. Phase 0 (`e31fa13`) is already completed and must not be repeated.

At the 2026-09-25 review baseline, `npm test` passed 574/574 with no skip (32.3 s), and `npm pack --dry-run --ignore-scripts --json` reported the existing package. The original spec's TypeScript error counts and 33-file tarball count are **historical baselines**, not future acceptance constants.

---

### Task 1: Pin formatter scope and isolate the format commit

**Files:** Modify `package.json`, `package-lock.json`; create `.prettierrc.json`, `.prettierignore`; format only `lib/**/*.js`, `test/**/*.js`, `test/**/*.mjs`, `scripts/**/*.mjs`, `codex/**/*.mjs`, `eslint.config.mjs` once the latter exists. This task creates an empty initial `eslint.config.mjs` with the flat-config ignore list; Task 2 fills the rules.

**Interfaces:** Produces `npm run format` and `npm run format:check` with identical, explicit globs. The `prepack` script stays byte-for-byte unchanged.

- [ ] **Step 1: Record the tree and pin development dependencies.** Run `git status --short`, `git rev-parse HEAD`, `node --version`, `npm --version`; this review started at `0225fc8`, and execution must record any changed baseline before edits. Do not stage `.codegraph/`. Use `npm install --save-dev --save-exact eslint@9 @eslint/js@9 globals@16 prettier@3.9.9 typescript@5.9.3 @types/node@22`. Record resolved versions with `npm ls --depth=0` and include the lockfile. If a pinned package cannot be installed, resolve that package's actual compatible patch before changing the design; do not leave an unlocked range.
- [ ] **Step 2: Add formatter configuration and scripts.** `.prettierrc.json` is exactly:

  ```json
  { "semi": false, "singleQuote": true, "printWidth": 100, "arrowParens": "always", "trailingComma": "all" }
  ```

  `.prettierignore` contains `*.md`, `test/fixtures/**`, `test/smoke/records/**`, `research/**`, `scratch/**`, `package-lock.json`, `.codegraph/**`; `package.json` gets the two explicit-glob scripts from spec §4.1. The initial `eslint.config.mjs` is `export default [{ ignores: ['node_modules/**', '.codegraph/**', 'test/fixtures/**', 'research/**', 'scratch/**'] }]` so the formatter's named file exists; Task 2 replaces it.
- [ ] **Step 3: Prove the formatter gate starts red, then format.** Run `npm run format:check` (expect a nonzero exit on the current JS/MJS tree), `npm run format`, then `npm run format:check` (expect success). Inspect `git diff --stat` and `git diff --check`. Commit only config/scripts/lockfile as `chore: pin developer checks and formatter scope`, after `npm run prepack` passes. Then stage **only** the mechanical JS/MJS changes and commit `style: format JavaScript at width 100`. Do not mix logic fixes with this second commit; run `npm run prepack` again before it. If the formatter touched a file outside the measured globs, correct the scope before either commit.

### Task 2: Make ESLint an honest code gate

**Files:** Modify `eslint.config.mjs`, the exact JS files reported by `npm run lint`, and `CHANGELOG.md` when a `lib/` fix changes behavior.

**Interfaces:** Produces `npm run lint` (`eslint .`) with `no-undef` enabled, Node globals, the project's ignore paths, and zero errors on the current tree.

- [ ] **Step 1: Replace the starter config.** Use the flat config below; the `test/smoke` scripts remain in scope, while records and fixtures do not:

  ```js
  import js from '@eslint/js'
  import globals from 'globals'

  export default [
    { ignores: ['node_modules/**', '.codegraph/**', 'test/fixtures/**', 'test/smoke/records/**', 'research/**', 'scratch/**'] },
    js.configs.recommended,
    { files: ['**/*.{js,mjs}'], languageOptions: { globals: globals.node } },
  ]
  ```

  Add `"lint": "eslint ."` to `package.json`. Run it and save the rule/file counts in the task note; this is the required red baseline.
- [ ] **Step 2: Triage every finding.** Remove genuinely unused names and useless assignments. Add `{ cause: error }` to the three symptom-error wrappers identified in spec §6.2. For intentional control-character regexes, use a *single-line local* `// eslint-disable-next-line no-control-regex -- strips unsafe control characters from protocol input` immediately before each expression; handle the two misleading-character-class findings with a local explanation, not global rule disable. Do not disable `no-undef`. For any remaining finding, record file, rule, and reason in the commit message or CHANGELOG rather than broadening config ignores.
- [ ] **Step 3: Verify and commit.** Run `npm run lint`, `npm run format:check`, `npm run prepack`, `git diff --check`. Expect zero lint errors and the existing tests/pack verifier to pass. Add an Unreleased `Fixed` entry only for actual behavior fixes; stage only inspected paths and commit `chore: enforce ESLint and resolve baseline findings`.

### Task 3: Repair JSDoc syntax before opting files into type checks

**Files:** Modify `lib/hooks.js`, `lib/transaction.js`; add one focused assertion in `test/repo-hygiene.test.js` or a tiny `test/jsdoc.test.js`; modify `CHANGELOG.md` Unreleased.

**Interfaces:** Existing runtime functions keep identical arguments/returns. TypeScript can parse the five Closure-style function types and eight orphan `@param` blocks.

- [ ] **Step 1: Add a failing parser check.** Use the installed `typescript` API with `allowJs:true` and `checkJs:true` over the two source files. The test should find no `TS1005` or `TS8032` JSDoc diagnostics in `ts.getPreEmitDiagnostics(program)`; assert the original baseline produces at least one such code before editing. Filter to these codes rather than requiring all of `hooks.js` or `transaction.js` to typecheck.
- [ ] **Step 2: Replace the exact 13 dialect cases from spec §7.2.** For example, replace `{function(string): Promise<object>}` with `{(value: string) => Promise<object>}` and attach each orphan `@param` to its containing declaration (or a named `@typedef`). Preserve the runtime source and public JSDoc meaning; inspect `git diff --word-diff` for accidental logic edits.
- [ ] **Step 3: Run `node --test test/jsdoc.test.js` (or the selected repo-hygiene test), `npm run lint`, `npm run format:check`, `npm run prepack`, `git diff --check`; expect all green. Update Unreleased with the JSDoc tooling repair and commit `docs: make callback JSDoc parseable by TypeScript`.

### Task 4: Establish a real opt-in JavaScript type ratchet

**Files:** Create `tsconfig.json`; modify `package.json`; add `// @ts-check` to `lib/paths.js`, `lib/git.js`, `lib/routing.js`, `codex/prepare.mjs`; add/extend `test/repo-hygiene.test.js`; modify `CHANGELOG.md` if source behavior is corrected.

**Interfaces:** `npm run types` runs `tsc --noEmit` over explicitly opted-in JS; a source-file list test guards the four markers. It does not claim every `lib/` file is clean.

- [ ] **Step 1: Prove why the original include-only design fails.** In a temporary two-file JS fixture, make `root.js` import `child.js` and call `parseInt(3)` in both. With `checkJs:true` and `files:['root.js']`, TypeScript 5.9.3 must report two TS2345 errors; with `checkJs:false` and `// @ts-check` only in `root.js`, it must report only the root error. Keep the fixture/test under `test/` if it is stable on both Node matrix versions; otherwise record the exact command and output in the task note.
- [ ] **Step 2: Add `tsconfig.json`.** Use `allowJs:true`, `checkJs:false`, `noEmit:true`, `strict:false`, `module:'NodeNext'`, `moduleResolution:'NodeNext'`, `target:'ESNext'`, `types:['node']`, and `files` listing those four paths. Add `"types": "tsc --noEmit"`. Put `// @ts-check` on the first parseable line after any shebang. Add a test that reads those four files and fails if a marker disappears.
- [ ] **Step 3: Red/green each file in order.** After adding a marker, run `npm run types -- --pretty false`; fix only its reported errors with accurate JSDoc or genuinely correct runtime guards. Do not use `@ts-ignore`, `@ts-nocheck`, `any` casts, or `skipLibCheck` to suppress a source error. If a candidate reveals a broad dependency error despite `checkJs:false`, stop and document it before reducing the opt-in set; the minimum deliverable is `paths.js` plus one other nontrivial module. Use `tsc --listFilesOnly` to confirm imported files are present in the program but do not yield diagnostics merely from being imported.
- [ ] **Step 4: Verify the four-file target, run `npm run lint`, `npm run format:check`, `npm run prepack`, `git diff --check`, then commit `chore: add opt-in JavaScript type checking`. Record the exact checked-file list and any candidate deferred for a separate future ratchet step.

### Task 5: Turn structure and repository conventions into tests

**Files:** Create `test/architecture.test.js`; extend `test/repo-hygiene.test.js`; modify the two READMEs and `README.i18n.yaml` only if existing `npm run` examples prove stale.

**Interfaces:** The architecture test owns a reviewed `Map<basename, layer>` and `Map<basename, maxLines>`; the hygiene test owns the README blob-hash check, command-reference check, and Task 4's type opt-in list.

- [ ] **Step 1: Red-test graph edges.** Use `typescript.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)` for every `lib/*.js`. Collect string-literal module specifiers from `ImportDeclaration` and `ExportDeclaration`, and literal dynamic `import()` calls; reject nonliteral dynamic imports until a reviewed edge is declared. In an isolated graph fixture, assert a missing relative target, a two-node cycle, and an `L1 → L3` import all fail. Include one `export ... from` and one side-effect `import './x.js'` so the test cannot silently ignore those syntaxes.
- [ ] **Step 2: Register the *post-format* baseline.** Run a small one-off report from the AST edges and `readFileSync(file,'utf8').split('\n').length` (normalize the final newline), inspect every edge and calculate each budget as `Math.ceil((actualLines + 30) / 50) * 50`. Record the reviewed L0–L9 table and budget map in `test/architecture.test.js`, not the old line numbers in spec §8.1. Test unknown modules fail; adding one requires a reviewed layer and budget entry. Deliberately add and remove a bad edge to see the red result.
- [ ] **Step 3: Test README and command references.** For each README, calculate:

  ```js
  const bytes = readFileSync(path)
  const blob = Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])
  const hash = createHash('sha1').update(blob).digest('hex')
  ```

  Compare with `README.i18n.yaml` parsed through the existing `yaml` dependency. Scan the three documents for literal `npm run <script>` commands and assert `package.json.scripts[script]` exists. A fixture with a wrong hash and one with `npm run absent-script` must fail before correcting them. Cross-check the two real hashes once with `git hash-object README.md README.zh.md`.
- [ ] **Step 4: Run `node --test test/architecture.test.js test/repo-hygiene.test.js`, then `npm run lint`, `npm run format:check`, `npm run types`, `npm run prepack`, `git diff --check`. If the README pair needed correction, edit both together and refresh both recorded hashes. Commit `test: guard module boundaries and repository conventions`.

### Task 6: Verify the actual npm archive without a frozen file count

**Files:** Create `scripts/verify-tarball.mjs`; extend `test/pack.test.js`; modify `package.json`.

**Interfaces:** `npm run pack:check` invokes the script. It creates a disposable destination, calls `npm pack --json --ignore-scripts --pack-destination <dir>`, reads the real `.tgz` listing, and reports a stable success/failure exit. `npm run check` reuses `prepack` then `pack:check`.

- [ ] **Step 1: Add a failing pack test.** Export `verifyTarballEntries(entries, libFiles)` from the new script. Assert it rejects a missing `lib/index.js`, a missing `README.zh.md`, a packed `test/pack.test.js`, and a packed `lib/pending/queue.json`; assert that adding an ordinary new `lib/new-module.js` changes the expected set rather than a numeric count. Call the script against the real package in one integration test. The first run must fail because the verifier is absent.
- [ ] **Step 2: Implement with isolated output.** Export the pure `verifyTarballEntries` helper and guard CLI execution with `if (process.argv[1] === fileURLToPath(import.meta.url))`. Use `mkdtempSync(join(tmpdir(),'obsidian-mem-pack-'))`, `spawnSync('npm',['pack','--json','--ignore-scripts','--pack-destination',dir],{cwd:root,encoding:'utf8'})`, then `spawnSync('tar',['-tf',tgz])`. Compare normalized `package/` paths with npm's JSON `files` array; require `package.json`, `CHANGELOG.md`, `LICENSE`, `cordis.patch.yml`, `dsh.plugin.json`, `skills/obsidian-mem/SKILL.md`, `README.md`, `README.zh.md`, `README.i18n.yaml` and every extant `lib/**/*.js`. Reject `.codegraph/`, `test/`, `docs/`, `scratch/`, `research/`, vault/pending artifacts, and an absent required file. Clean only the newly created temporary directory in a `finally`; never call plain `npm pack` from `prepack`.
- [ ] **Step 3: Add `"pack:check": "node scripts/verify-tarball.mjs"` and `"check": "npm run lint && npm run format:check && npm run types && npm run prepack && npm run pack:check"`. Run the failing tests green, `npm run check`, `git diff --check`; report actual archive paths/count for information only. Commit `test: verify the real npm archive`.

### Task 7: Enforce Unreleased changes and check staged code accurately

**Files:** Create `scripts/verify-changelog.mjs`, `scripts/check-staged.mjs`, `scripts/install-hooks.mjs`, `.githooks/pre-commit`, `test/repo-gates.test.js`; modify `package.json`.

**Interfaces:** `verify-changelog.mjs --staged` compares `HEAD` to the index; `--base <ref>` compares ref to `HEAD`. `check:fast` invokes it in staged mode and checks staged JS blobs. `hooks:install` is the only command that changes local `core.hooksPath`.

- [ ] **Step 1: Build temporary Git-repository fixtures.** Test four states: staged `lib/x.js` without an Unreleased edit fails; staged `lib/x.js` plus a new Unreleased line passes; a change only in a released CHANGELOG section fails; a working-tree fix that is **not staged** cannot satisfy a staged check. Test `--base` over two commits. The test must never edit this checkout's git config.
- [ ] **Step 2: Implement the changelog reader.** Invoke Git via `execFileSync` with argument arrays (no shell). For `--staged`, inspect `git diff --cached --name-only -z HEAD -- lib/`, read `:CHANGELOG.md` with `git show` when staged (otherwise `HEAD:CHANGELOG.md`), and compare its `## Unreleased` slice to `HEAD:CHANGELOG.md`. For `--base`, inspect `git diff --name-only -z <ref> HEAD -- lib/` and compare the same slice in `<ref>:CHANGELOG.md` and `HEAD:CHANGELOG.md`. Missing refs/files are errors, never empty success. A `lib/` change needs an added or changed Unreleased body, not just a heading or released section.
- [ ] **Step 3: Test staged lint/format behavior.** In a disposable Git repo with partial staging, make the staged `x.js` valid and working tree invalid, then reverse them; an exported `checkStagedSources(root,{eslintBin,prettierBin})` helper must report the staged result both times. Resolve both bins and the ESLint config from this repository's script directory, while Git runs with `cwd:root`; the fixture does not need its own `node_modules`. Read `git diff --cached --name-only -z --diff-filter=ACMR` and `git show :path`; pipe each blob into local `eslint --stdin --stdin-filename path` and `prettier --check --stdin-filepath path` using `spawnSync` with `input`. The main `check:fast` also runs `node --test test/architecture.test.js test/repo-hygiene.test.js` against the checkout worktree only if neither test's inputs have both staged and unstaged edits; otherwise fail with a clear partial-stage message. Deleted files are omitted from per-file lint.
- [ ] **Step 4: Make hook installation explicit.** `.githooks/pre-commit` runs `npm run check:fast`. `install-hooks.mjs` checks the current local `core.hooksPath`, prints it, runs `git config --local core.hooksPath .githooks`, prints the new value, and refuses to operate outside this repo. Test that script only inside a disposable Git repository. Do **not** run `npm run hooks:install` in the user's checkout as part of this plan.
- [ ] **Step 5: Add scripts, make the hook executable, run `node --test test/repo-gates.test.js`, `npm run check`, `git diff --check`, and measure `time npm run check:fast` with a representative staged one-file change in a temporary clone. Record the result; if over 5 seconds, keep the honest measured value and trim redundant fast-path work in a follow-up review. Commit `chore: add staged checks and changelog gate`.

### Task 8: Run the same baseline gates on GitHub Actions

**Files:** Create `.github/workflows/ci.yml`; extend `test/repo-gates.test.js` if the SHA-selection helper is a local script; modify `CHANGELOG.md` Unreleased only if the CI behavior needs a note.

**Interfaces:** CI runs `npm ci`, `npm run check`, then `verify-changelog --base <SHA>` on `push` and `pull_request`; no secrets or write token are required.

- [ ] **Step 1: Add the workflow.** Use `actions/checkout@v7` with `fetch-depth: 0`, `actions/setup-node@v7` with `node-version` matrix `['22.22.2','24.x','node']` and `cache: npm`, followed by `npm ci` and `npm run check`. These action majors and the `node` alias were confirmed against their official README during review; recheck them at implementation. Use `github.event.pull_request.base.sha` for PRs and `github.event.before` for pushes. For an all-zero before SHA, compute `git merge-base HEAD` against the remote ref named by `github.event.repository.default_branch`; if unavailable or equal to `HEAD`, fail rather than accepting an empty diff. Pass the resulting SHA to `node scripts/verify-changelog.mjs --base`.
- [ ] **Step 2: Validate YAML and baseline logic locally.** Parse the workflow with the existing `yaml` dependency; assert exactly the three Node matrix entries, `npm ci` before `npm run check`, `fetch-depth: 0`, and a nonempty change base for each event fixture. Run `npm run check` locally. Do not claim the 22.22.2 job passed until GitHub has actually run it.
- [ ] **Step 3: Commit `ci: run repository gates across supported Node versions`. After pushing during the later implementation phase, inspect every matrix result and skipped test count; update `CHANGELOG.md` limitations with observed evidence. This planning task itself performs no push.

### Task 9: Add a bounded diagnostics channel and its tool action

**Files:** Create `lib/debug.js`, `test/debug.test.js`; modify `lib/index.js`, `lib/tools.js`, `codex/server.mjs`, `test/tools.test.js`, `test/codex-mcp.test.js`, `test/architecture.test.js`, `README.md`, `README.zh.md`, `README.i18n.yaml`, `CHANGELOG.md` Unreleased.

**Interfaces:** `createDiagnostics({logger,capacity=200,now})` returns `{event(name,fields), snapshot(), size()}`. `snapshot()` returns `{window:{capacity,size,oldestSeq,newestSeq,dropped},events}`. `createMemoryServices({...,diagnostics})` accepts an optional instance and otherwise creates its own. `mem_admin({action:'diagnostics'})` returns `{action:'diagnostics',result:snapshot}` without reading the vault.

- [ ] **Step 1: Write a red unit test for the ring.** Verify 201 events retain only the latest 200 in sequence, `dropped===1`, oldest/newest sequence numbers are correct, and mutating a returned snapshot cannot mutate the ring. Inject a fake clock and fake `logger.info`; verify `DSH_OBSIDIAN_MEM_DEBUG` unset gives zero new info calls and `=1` writes only sanitized records. Test a malformed event, logger throw, and extra `body/title/message/path/prompt` fields do not throw or appear.
- [ ] **Step 2: Implement `lib/debug.js` with one field allowlist.** Accepted names are `capture`, `distill`, `index`, `bind`, `job`, `transaction`, `brief`, `skill`. Copy only `projectId`, `txId`, `jobId`, `outcome`, `attempts`, `ms`, `code` after type and length checks. IDs and codes use short ASCII token patterns; numeric fields are finite nonnegative integers. Add `seq` and ISO `at` internally. Never stringify an error object or unknown field. Catch any clock/logger failure inside `event`; `snapshot` returns a deep-enough scalar copy. Log `JSON.stringify(sanitizedRecord)` via `logger.info` only with the env flag. Export `recordDiagnostic(diagnostics,name,fields)` as the one no-throw adapter around a possibly faulty injected diagnostics object; Task 10 uses it at every call site.
- [ ] **Step 3: Red-test the DSH tool seam.** In `test/tools.test.js`, call the registered `mem_admin` through the real `@deepseek-ai/dsh-tools` seam with `{action:'diagnostics'}` and assert the closed output shape. Assert `{action:'diagnostics',path:'x'}` is rejected. In `test/codex-mcp.test.js`, make a real `tools/call` after `initialize`; assert the same shape and that an irrelevant argument is rejected as `isError`. Those tests must fail before adding the action.
- [ ] **Step 4: Wire all schema/dispatch points.** Add `diagnostics` to `TOOL_PARAMETERS.mem_admin.action.enum` and `ADMIN_ACTION_PARAMETERS` as an empty option list; add a precise diagnostics arm to `ADMIN_OUTPUT.oneOf`. At the start of `services.admin`, normalize with `forwardAdminArguments(args)` so Codex's direct service call gets the same cross-parameter validation DSH already gets. Return `diagnostics.snapshot()` before binding/vault work. In `lib/index.js:apply`, create one diagnostics instance using the named Cordis logger and pass it to both services and hooks; in `codex/server.mjs:openMemory`, pass a per-server instance whose optional info sink writes only to stderr. Update the Codex `mem_admin` description. Add `lib/debug.js` to the architecture layer/budget map in the same commit.
- [ ] **Step 5: Document the new action in both READMEs in this same user-visible change.** State that it reads a process-local ring without vault I/O and contains machine identifiers only; refresh both `README.i18n.yaml` hashes using `git hash-object README.md README.zh.md`. Run `node --test test/debug.test.js test/tools.test.js test/codex-mcp.test.js`, `npm run check`, `git diff --check`. Add an Unreleased entry stating the ring's lifetime. Commit `feat: expose bounded diagnostics through mem_admin`.

### Task 10: Emit useful decisions without leaking note content

**Files:** Modify `lib/index.js`, `lib/hooks.js`, `lib/capture.js`, `lib/tools.js` (later `services.js`), `test/auto-capture.test.js`, `test/hooks.test.js`, `test/tools.test.js`, `test/debug.test.js`, `README.md`, `README.zh.md`, `README.i18n.yaml`, `CHANGELOG.md` Unreleased.

**Interfaces:** Existing method results and `warn` calls remain unchanged. Each new event uses Task 9's fixed names and scalar fields; no new persistent diagnostics file is created.

- [ ] **Step 1: Add failing behavior tests at real seams.** Give `registerHooks`/`createCapture`/`createQueueWorker` the same diagnostics instance and inject a `SENTINEL-BODY-${randomUUID()}` safe-input text. Assert a skipped capture, a failed distillation attempt, a queue outcome, a brief decision, and a skill-sync result each produce the expected event name/outcome with no body. Toggle `DSH_OBSIDIAN_MEM_DEBUG=1` with a fake info sink and assert neither the ring nor info output contains the sentinel or forbidden field names. Prove the privacy test can fail by temporarily adding `body` to the event allowlist, then revert that local mutation.
- [ ] **Step 2: Add the eight boundary categories from spec §9.2.** Pass diagnostics from `apply` into `registerHooks`; from `registerHooks` into `createCapture` and `createQueueWorker`. Use Task 9's `recordDiagnostic` at each call site. Emit `brief` at plan/commit decisions and `index` on an index-open/readiness refusal in `hooks.js` or the services' `indexFor` boundary; emit `capture`, `distill`, and `job` at the existing queue outcome branches in `capture.js`; emit `bind` on `autoBindProject` refusal and `transaction` when a service write gets `recovery-required` or another coded transaction refusal; emit `skill` from the resolved `syncBundledSkill` outcome in `index.js`. Record only `code`, `outcome`, IDs, attempts, and bounded elapsed milliseconds. Keep the detailed forward/rollback report in existing persistent receipts rather than threading a new callback through every transaction API.
- [ ] **Step 3: Preserve fail-open behavior.** Run tests with a diagnostics instance whose `event()` throws to confirm that capture, brief injection, tool writes, worker settlement, and skill sync still return their pre-feature results. Do not add an awaited diagnostic write or a new network call on any host seam. Check that the pre-existing `hooks.js` warnings still fire exactly where before and that DEBUG unset adds no info/stderr output.
- [ ] **Step 4: Document the trust and lifetime boundary in both READMEs.** Explain that `mem_admin(action="diagnostics")` shows at most 200 current-process machine events, may contain IDs from more than one project served by the same instance, and empties on restart; use `jobs` and receipts for persistent state. Refresh both hashes using `git hash-object README.md README.zh.md` and write them to `README.i18n.yaml`. Run `node --test test/debug.test.js test/auto-capture.test.js test/hooks.test.js test/tools.test.js`, `npm run check`, `git diff --check`; commit `feat: trace memory decisions without storing content`.

### Task 11: Split `tools.js` behind the unchanged public façade

**Files:** Create `lib/tool-schema.js`, `lib/tool-registry.js`, `lib/services.js`; reduce `lib/tools.js` to four re-exports; modify `scripts/verify-pack.mjs`, `test/pack.test.js`, `test/architecture.test.js`, `CHANGELOG.md` Unreleased. Do not change imports in `codex/server.mjs` or existing tests just to follow the move.

**Interfaces:** `import {TOOL_NAMES,TOOL_PARAMETERS,registerTools,createMemoryServices} from './lib/tools.js'` retains the same values/functions. `tool-schema.js` owns the parameter/output contracts and shared argument rules. `tool-registry.js` owns the six `defineTool` definitions. `services.js` owns service lifetimes, binding/index caches, admin dispatch, and projections.

- [ ] **Step 1: Pin the façade contract before moving source.** Add a test that imports all four names through `lib/tools.js`, registers the six tools through the real tools seam, and compares Codex's `listTools()` names and JSON Schema keys. Add a pack-fixture test that fails when one façade export is omitted. These tests are red after deliberately removing an export, then restored before extraction.
- [ ] **Step 2: Move declarations by dependency direction.** Move lines currently in `tools.js` around 60–624 to `tool-schema.js`; export the shared `TOOL_PARAMETERS`, `TOOL_NAMES`, output schemas, option lists, `ADMIN_ACTION_PARAMETERS`, and `forwardAdminArguments` needed by both consumers. Keep `HOT_SECTIONS_BY_SECTION`, binding/index work, admin actions, and projections with `createMemoryServices` in `services.js`. Move the six tool definitions and `registerTools` into `tool-registry.js`, importing schema constants rather than copying them. Where a moved function uses a name, add a real import; a re-export alone does not create a local binding. `tools.js` itself has no local use and consists only of four `export { ... } from './...'` statements.
- [ ] **Step 3: Update package guards in the same change.** `verify-pack.mjs` scans registration sites in `lib/tool-registry.js` and checks the four façade re-exports; `test/pack.test.js` puts synthetic `name: 'mem_*'` sites in the new file and checks both a dropped tool and a missing façade export. Run `node scripts/verify-pack.mjs` before the full suite. `pack:check` must now include the three new `lib/*.js` files without changing a hardcoded count.
- [ ] **Step 4: Recompute the import graph after extraction.** Review each new edge, then update `test/architecture.test.js` layers and LOC budgets for the three new modules and the small façade. A cycle or unreviewed upward edge is a reason to adjust module ownership, not a reason to disable the test. Run `node --test test/architecture.test.js test/pack.test.js test/tools.test.js test/codex-mcp.test.js`, then `npm run check`, `git diff --check`; update Unreleased and commit `refactor: separate tool contracts registration and services`.

### Task 12: Put a short maintainer map in front of the long design history

**Files:** Modify `AGENTS.md`, `CHANGELOG.md` Unreleased and remaining-risk list; modify `README.md`, `README.zh.md`, `README.i18n.yaml` only if the final user-facing command list needs correction.

**Interfaces:** `AGENTS.md` has one command table (`check`, `check:fast`, `hooks:install`, `prepack`, `pack:check`) and one symptom-to-source table. The command-reference hygiene test guards every literal `npm run` link.

- [ ] **Step 1: Replace the manual verification recipe with the command table.** State that `npm run check` includes lint/format/opt-in types/tests/pack, `check:fast` checks staged blobs plus two worktree fitness tests, `hooks:install` explicitly changes local `core.hooksPath`, and `prepack` remains a read-only publish verifier. Keep the runtime-vs-dev dependency distinction explicit.
- [ ] **Step 2: Add a compact "truth lives here" table.** Map write refusal → transaction/service + `jobs`/diagnostics; missing brief → brief/hooks; distillation → capture/distill/pending; package mismatch → `verify-pack`/`verify-tarball`; host seam → `docs/p0-compatibility.md`; copied checkout MCP failure → regenerate `.mcp.json` with `node codex/prepare.mjs`. Avoid adding another lookup command.
- [ ] **Step 3: Final evidence.** Run `git diff --check`, `npm run check` (which already includes tests, `prepack`, and actual archive verification), and `npm pack --dry-run --ignore-scripts --json`. On a branch descended from the reviewed baseline, run `node scripts/verify-changelog.mjs --base 0225fc8`; if execution started on a different base, use the real SHA recorded in Task 1 and verify it is an ancestor with `git merge-base --is-ancestor`. Inspect the dry-run file list and confirm `.codegraph/`, `docs/`, `test/`, `research/`, and `scratch/` are absent. If CI has run, record matrix pass/fail/skip and command output in `CHANGELOG.md`; if not, leave the Node 22.22.2 CI verification explicitly untested.
- [ ] **Step 4: Commit `docs: map maintenance commands and evidence`. Report to the user the final commit IDs, check output, CI status, and any remaining risks. Do not install hooks, write a real vault, publish npm, or claim runtime dogfooding from the repository checks.

## Plan self-check before implementation

- [ ] Compare each goal and boundary in spec §1, §4–§13 with Tasks 1–12; add any missing task before writing code.
- [ ] Search this plan for `TBD`, `TODO`, an undefined symbol, a command that would recurse into `prepack`, and a fixed 33-file acceptance. Correct any hit before execution.
- [ ] Confirm every new `lib/` commit after Task 7 includes an Unreleased change, every README edit is paired and re-hashed, and every new `lib/` module is entered in the architecture table in the same commit.
