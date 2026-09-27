# Privacy-Safe Diagnostic Bundle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a user-run command that produces a reviewable JSON Issue attachment from bounded, content-free plugin decisions and isolated health checks.

**Architecture:** Extend the existing in-process diagnostics ring with a separately validated, bounded local journal under the plugin data root. A Node-only command reads that journal through a second allowlist, performs checks without reading user content, and writes one JSON report at an explicit output path. The DSH and Codex entries share the same journal module; no host logs or vault files enter the report.

**Tech Stack:** Node.js ES modules and builtins (`node:fs`, `node:sqlite`, `node:test`); existing `@deepseek-ai/schemastery` and `yaml` runtime dependencies only.

**Spec:** `docs/superpowers/specs/2026-09-27-privacy-safe-diagnostic-bundle-design.md`

## Global Constraints

- Node floor remains `>=22.22.2`; no third runtime dependency.
- No conversation, pending job content, model output, note, raw host log, prompt, path, credential, environment value, original identifier, exception message or stack may reach the journal or report.
- Journal directory is under `resolveDataRoot()` at `diagnostics/` with mode `0700`; files use `0600`. One run keeps at most 200 events and 128 KiB; files idle for more than 7 days are cleaned on next plugin start and ignored by export.
- The CLI requires `--output`, does not upload or modify user configuration or vault contents, and refuses an existing destination or symlink.
- A diagnostic failure never changes the result of an existing plugin call; absent or invalid evidence is `partial` or `unavailable`, never `pass`.
- Use a throwaway `DSH_HOME` and vault in every test; preserve the user-owned untracked `research/query-side-survey.md`.
- README EN/ZH move together, update `README.i18n.yaml` with `git hash-object`, and keep remaining unverified claims in CHANGELOG.
- Before each commit run `npm run check:fast`; before any push run `npm run check` and `git diff --check`. Do not add a `Co-Authored-By` trailer.

## File Map

| File | Responsibility |
|---|---|
| `lib/diagnostic-codec.js` | Closed event/config vocabulary, identifier aliasing, and strict decode shared by writer and reader; imports no plugin service. |
| `lib/diagnostic-journal.js` | Per-run file creation, append/compaction, expiry cleanup, safe read, and error counts. |
| `lib/debug.js` | Keep existing ring semantics and call the optional journal sink after ring sanitization. |
| `lib/index.js`, `codex/server.mjs` | Construct one journal at each enabled host entry and pass its sink to the ring. |
| `lib/diagnostic-report.js` | Node-only checks, isolated plugin smoke call, fixed JSON report, size bound and exclusive output. |
| `lib/diagnose-cli.js` | Shebang, strict `--output` argument handling, user-facing result codes. |
| `test/diagnostic-codec.test.js`, `test/diagnostic-journal.test.js`, `test/diagnose-cli.test.js` | Privacy and lifecycle behavior through real seams and temporary homes. |
| `test/debug.test.js`, `test/hooks.test.js`, `test/codex-mcp.test.js` | Regression coverage for both runtime entry points and fail-open behavior. |
| `test/architecture.test.js` | Register new modules in the import-layer and size-budget ratchet. |
| `package.json`, `scripts/verify-pack.mjs`, `scripts/verify-tarball.mjs`, `test/pack.test.js` | Publish and verify the CLI binary in the actual tarball. |
| `README.md`, `README.zh.md`, `README.i18n.yaml`, `CHANGELOG.md` | Manual workflow, privacy boundary, limitations and paired hashes. |

---

### Task 1: Closed diagnostic wire format

**Files:** Create `lib/diagnostic-codec.js`, `test/diagnostic-codec.test.js`; modify `test/architecture.test.js`.

**Interfaces:** `createAliases()` returns an aliasing state scoped to one run. `encodeDiagnosticEvent(event, aliases)` returns a new safe event or `null`. `decodeDiagnosticEvent(value)` returns a validated safe event or `null`. `safeConfigSummary(config)` returns only the five approved config fields. This module has no filesystem access.

- [ ] **Step 1: Write a failing test for content and ID removal.** Use an input with `body`, `prompt`, `path`, `message`, `title`, raw UUIDs and an unknown `code`; assert none of those bytes survives `JSON.stringify(encodeDiagnosticEvent(...))`, while two events referring to the same job receive the same `j1` alias.

```js
const aliases = createAliases()
const first = encodeDiagnosticEvent({
  seq: 1, at: '2026-09-27T00:00:00.000Z', event: 'job', outcome: 'failed',
  jobId: 'raw-job-123', code: 'private-user-text', body: 'SENTINEL-BODY',
}, aliases)
const second = encodeDiagnosticEvent({
  seq: 2, at: '2026-09-27T00:00:01.000Z', event: 'job', outcome: 'retry',
  jobId: 'raw-job-123',
}, aliases)
assert.equal(first.job, 'j1')
assert.equal(second.job, 'j1')
assert.equal(first.code, 'other')
assert.equal(JSON.stringify([first, second]).includes('SENTINEL-BODY'), false)
assert.equal(JSON.stringify([first, second]).includes('raw-job-123'), false)
```

- [ ] **Step 2: Run the failing test.** `node --test test/diagnostic-codec.test.js` must fail because the module does not exist.
- [ ] **Step 3: Implement the codec.** Use `EVENT_NAMES` only as a source for the event-name set. The reviewed outcome lists are: `capture` = `captured`, `skipped-unbound`, `auto-capture-off`, `not-turn-end`, `not-root-session`, `no-session-id`, `no-project-id`, `no-end-seq`, `no-user-messages`, `no-segments`, `already-processed`; `distill` = `deferred`, `no-memory`, `dry-run`, `duplicate`, `duplicate-check-failed`, `applied`; `index` = `open-failed`, `refresh-failed`, `none`, `refreshed`; `bind` = `refused`; `job` = `retry-refused`, `retry-missing`, `retried`, `deferred`, `completed`, `failed`, `retry`; `transaction` = `committed`, `refused`; `brief` = `none`, `hint-only`, `injected`; `skill` = `synced`, `unchanged`, `failed`; `recall` = `fired`, `no-query`, `no-hits`, `below-floor`, `all-seen`, `budget`, `aborted`, `search-failed`. Start the code whitelist with `no-binding`, `no-route`, `no-pointer`, `vault-cloud-managed`, `unsafe-path`, `recovery-required`, `job-corrupt`, `schema`, `evidence`; unknown tokens become `other`. Decode with the same fixed keys and primitive shape checks, rejecting extra keys and invalid timestamps/counts rather than copying them. Never stringify an unknown input object before projection.

```js
export function safeConfigSummary(config) {
  return {
    enabled: config?.enabled === true,
    autoCapture: config?.autoCapture === true,
    injectBrief: config?.injectBrief === true,
    indexBackend: ['auto', 'sqlite', 'scan'].includes(config?.indexBackend)
      ? config.indexBackend : 'unavailable',
    dryRun: config?.distill?.dryRun === true,
  }
}
```

- [ ] **Step 4: Run tests and register architecture.** `node --test test/diagnostic-codec.test.js test/architecture.test.js` must pass; document the new module's dependency layer and measured file-size budget in `test/architecture.test.js` instead of silently raising a budget.
- [ ] **Step 5: Commit.** Stage only this task's files; run `npm run check:fast`; commit `feat: define privacy-safe diagnostic event format`.

### Task 2: Bounded local journal

**Files:** Create `lib/diagnostic-journal.js`, `test/diagnostic-journal.test.js`; modify `test/architecture.test.js`.

**Interfaces:** `openDiagnosticJournal({dataRoot, config, now})` returns `{path, record(event), close()}`; `path` is for local tests and is never exported in a report. `readDiagnosticJournal({dataRoot, now})` returns `{events, dropped, corrupt, expired, status, config}` without raw bytes. Both functions use the Task 1 codec; reader does not mutate the data root.

- [ ] **Step 1: Write failing tests.** Use `mkdtempSync` to create a dedicated fake data root. Assert `0700`/`0600`, two distinct run files, 201 appends retaining only the latest 200, compaction below 128 KiB, a 7-day-old file ignored by read and removed on a later open, a symlink refused, a corrupt line counted but never echoed, and no raw ID or sentinel in any file. Restore permissions before test cleanup.

```js
const journal = openDiagnosticJournal({dataRoot, config: {enabled: true}})
journal.record({seq: 1, at: new Date().toISOString(), event: 'capture',
  outcome: 'captured', projectId: 'raw-project', body: 'SENTINEL-BODY'})
assert.equal(readFileSync(journal.path, 'utf8').includes('SENTINEL-BODY'), false)
assert.equal(readFileSync(journal.path, 'utf8').includes('raw-project'), false)
```

- [ ] **Step 2: Run the failing test.** `node --test test/diagnostic-journal.test.js` must fail for the missing module.
- [ ] **Step 3: Implement the writer and reader.** Name files with `randomUUID()`, reject existing symlinked directory/files with `lstat`, use no-follow open flags where available, and keep a per-run alias map. Store only a schema/versioned header with `safeConfigSummary` and encoded events. Append a safe event, then compact to the newest 200 or 128 KiB through a same-directory temporary file and rename. Keep a dropped count in the header. On startup delete files whose last write is older than 7 days; on export ignore them. If a held run file has been cleaned while idle, start a new run before the next append. Reject files larger than 128 KiB during read.

```js
export function openDiagnosticJournal({dataRoot, config, now = () => new Date()}) {
  const aliases = createAliases()
  const runId = randomUUID()
  return {
    path: runPathFor(dataRoot, runId),
    record(event) {
      const safe = encodeDiagnosticEvent(event, aliases)
      if (safe !== null) appendBoundedRun(dataRoot, runId, safe, config, now)
    },
    close() {},
  }
}
```

`runPathFor` and `appendBoundedRun` are private to this file; the latter is responsible for file permissions, compaction, and recovery from a removed idle file. The test should observe real disk bytes, not mirror that function.

- [ ] **Step 4: Verify.** `node --test test/diagnostic-journal.test.js test/architecture.test.js` must pass. Test a second process with a separate run ID, because two JavaScript objects in one process do not exercise process-safe file naming.
- [ ] **Step 5: Commit.** Stage task files, run `npm run check:fast`, and commit `feat: retain bounded content-free diagnostic decisions`.

### Task 3: Connect the journal to both hosts without changing outcomes

**Files:** Modify `lib/debug.js`, `lib/index.js`, `codex/server.mjs`, `test/debug.test.js`, `test/hooks.test.js`, `test/codex-mcp.test.js`, `test/architecture.test.js`.

**Interfaces:** `createDiagnostics({logger, capacity, now, sink})`; `sink.record(record)` receives only the ring's already-sanitized event. Both entry points call `openDiagnosticJournal({dataRoot, config})` after resolving the data root and supply it as `sink`.

- [ ] **Step 1: Write failing host-seam tests.** Inject a sink that throws and assert the original `mem_admin` diagnostic result and a real capture/write path still succeed. Under an explicit temporary `DSH_HOME`, activate the DSH plugin and start the Codex adapter separately; assert each produces its own private run file. Assert `enabled: false` creates no diagnostics directory.

```js
const ring = createDiagnostics({sink: {record() { throw new Error('sink failed') }}})
ring.event('job', {outcome: 'failed', body: 'SENTINEL-BODY'})
assert.equal(ring.snapshot().events[0].outcome, 'failed')
```

- [ ] **Step 2: Run targeted tests and record the red result.** `node --test test/debug.test.js test/hooks.test.js test/codex-mcp.test.js` must fail on the new sink/host assertions.
- [ ] **Step 3: Wire the sink.** Call it inside the existing `event()` try/catch after the ring creates `record`, without changing the `mem_admin` output schema. Construct the journal only after `enabled` is confirmed in `lib/index.js`; make journal-construction failures leave a ring with no sink. Use the same rule in `codex/server.mjs` and keep MCP stdout reserved for protocol messages.

```js
const journal = tryOpenDiagnosticJournal({dataRoot, config})
const diagnostics = createDiagnostics({logger, sink: journal})
```

`tryOpenDiagnosticJournal` is a small local wrapper that catches `openDiagnosticJournal` errors and returns `null`; it must never emit the exception text to host logs. Do not add a new session hook or read session content.

- [ ] **Step 4: Verify.** Run the three targeted test files and `test/architecture.test.js`; compare the before/after `mem_admin(action="diagnostics")` schema and assert the same ring output for the same event.
- [ ] **Step 5: Commit.** Run `npm run check:fast`; commit `feat: record host diagnostics locally without affecting calls`.

### Task 4: Standalone report and command

**Files:** Create `lib/diagnostic-report.js`, `lib/diagnose-cli.js`, `test/diagnose-cli.test.js`; modify `test/architecture.test.js`.

**Interfaces:** `buildDiagnosticReport({dataRoot, packageRoot, now, smoke})` returns a fixed object. `writeDiagnosticReport(report, outputPath)` creates a `0600` JSON file exclusively and atomically or throws an error with a fixed machine `code`; the CLI maps that code to its exit status without printing the raw message. `main(argv)` in the CLI requires exactly `--output <path>`; the command's top-level launcher sets `process.exitCode` from `main`.

- [ ] **Step 1: Write failing CLI tests.** Spawn the real CLI in an isolated `DSH_HOME`. Assert a parseable JSON report from no plugin installation, fixed statuses for Node/version/FTS5/package/data-root/journal/queue checks, no source path or environment value in JSON, no overwrite or symlink follow, no partial output after a write failure, and output size at most 256 KiB. Inject an import failure into `buildDiagnosticReport`'s `smoke` seam and assert the basic report still exists with `plugin-smoke: unavailable`.

```js
const report = await buildDiagnosticReport({
  dataRoot: temporaryDataRoot,
  packageRoot: repositoryRoot,
  smoke: async () => { throw new Error('SENTINEL-PRIVATE-STACK') },
})
assert.equal(JSON.stringify(report).includes('SENTINEL-PRIVATE-STACK'), false)
assert.equal(report.checks.find((check) => check.id === 'plugin-smoke').status, 'unavailable')
```

- [ ] **Step 2: Run the failing tests.** `node --test test/diagnose-cli.test.js` must fail because the CLI/report modules are absent.
- [ ] **Step 3: Implement Node-only checks.** Read the package manifest adjacent to the installed CLI, parse Node and DSH versions when reliably resolvable, and run `CREATE VIRTUAL TABLE probe USING fts5(value)` in an in-memory `DatabaseSync`. Use `lstat`/`readdir` to check directory type, permissions, journal state and count `*.json` regular entries directly under `pending/`; never open a job. Call the plugin smoke only inside `mkdtemp` with explicit temporary `DSH_HOME`, data root and vault, then remove it in `finally`. Dynamically import plugin modules so failure yields `unavailable` rather than preventing the report.

```js
const checks = [
  {id: 'node-floor', status: nodeAtLeast(process.versions.node, '22.22.2') ? 'pass' : 'fail'},
  await checkFts5InMemory(),
  await checkPluginSmokeInTemporaryHome(smoke),
]
```

- [ ] **Step 4: Implement output and verify.** Build only the spec's fixed top-level keys; add recent events until adding one would exceed 256 KiB, then increase `eventWindow.truncated`. Require `--output`; use an exclusive temporary file in the destination directory, fsync it, and publish without overwriting the target. Sanitize terminal errors to fixed codes. Re-run `test/diagnose-cli.test.js` and `test/architecture.test.js`.

```js
const bytes = Buffer.from(JSON.stringify(report, null, 2) + '\n')
if (bytes.length > 256 * 1024) {
  throw Object.assign(new Error('report-size-limit'), {code: 'report-size-limit'})
}
```

- [ ] **Step 5: Commit.** Run `npm run check:fast`; commit `feat: generate reviewable diagnostics without plugin startup`.

### Task 5: Package, document, and prove the complete path

**Files:** Modify `package.json`, `scripts/verify-pack.mjs`, `scripts/verify-tarball.mjs`, `test/pack.test.js`, `README.md`, `README.zh.md`, `README.i18n.yaml`, `CHANGELOG.md`; extend `test/diagnose-cli.test.js` if the packed binary reveals a missing path.

**Interfaces:** npm exposes `dsh-obsidian-mem-diagnose` as `./lib/diagnose-cli.js`; no new `mem_*` tool is added. The real archive verifier requires `package/lib/diagnose-cli.js` and confirms the manifest's `bin` target exists.

- [ ] **Step 1: Make packaging tests fail.** Add a fixture case where `package.json.bin['dsh-obsidian-mem-diagnose']` points to a missing file, and require the CLI entry in `REQUIRED_ENTRIES`. Run `node --test test/pack.test.js` to see the new assertions fail.

```json
"bin": { "dsh-obsidian-mem-diagnose": "./lib/diagnose-cli.js" }
```

- [ ] **Step 2: Update the package and verifiers.** Add the `bin` field and the explicit asset/target checks to both verifiers. Keep `prepack` read-only and never call `npm pack` from it. `pack:check` may pack with `--ignore-scripts` as it already does.
- [ ] **Step 3: Update user docs and limitations.** In both READMEs show the same command, all included and excluded fields, 7-day/200-event limits, manual JSON inspection and upload, public-Issue visibility, and failure statuses. Record verified tests and remaining limitations in `CHANGELOG.md`. Run `git hash-object README.md README.zh.md` and place the two exact values in `README.i18n.yaml`.
- [ ] **Step 4: Run the complete gate and a packed CLI smoke test.** `npm run check`, `git diff --check`, and a real `npm pack --ignore-scripts` into a throwaway directory must pass. Install/extract that tarball in a throwaway directory, run its published binary with a temporary `DSH_HOME`, parse its JSON, and assert the archive contains no generated diagnostic data. Report red/green test results and any unverified live-host behavior honestly.
- [ ] **Step 5: Commit.** Stage only the task's files, run `npm run check:fast`, and commit `docs: ship and explain privacy-safe diagnostic bundle`. Do not push unless requested; `npm run check` is the gate if a push is later requested.

## Final Review

Confirm spec coverage: manual CLI, default local retention, content exclusion, both host entries, isolated checks, fail-open behavior, exclusive output, real tarball, bilingual docs, and honest evidence boundaries. Run `git status --short`, inspect staged/untracked files, and keep unrelated user work untouched. If a real DSH or Codex smoke test was not run, label that limit explicitly rather than claiming the packaged self-test proves host integration.
