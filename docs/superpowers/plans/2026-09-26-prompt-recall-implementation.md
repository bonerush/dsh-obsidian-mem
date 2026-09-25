# Prompt-scoped Recall Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a short, relevant project-memory index on new DSH and Codex user turns.

**Architecture:** `lib/prompt-recall.js` selects and formats project-scoped hits. DSH calls it from its existing `agent/pre-step` waterfall; Codex calls it from a generated `UserPromptSubmit` command. Both use the existing service search and leave full note reading to `mem_read`.

**Tech Stack:** ES modules, Node builtins, Cordis, `node --test`, Codex command hooks.

**Spec:** `docs/superpowers/specs/2026-09-26-prompt-recall-design.md`

## Global Constraints

- Never test with a real vault or the real `$DSH_HOME`; use `mktemp -d` fixtures.
- Keep `lib/tools.js` and the six public tool contracts unchanged.
- DSH plugin messages keep `source.kind: 'plugin:obsidian-mem'`.
- README changes must be paired in English and Chinese with fresh blob hashes.
- A new behavior test must fail before the production change and pass after it.
- Before a commit run `npm run check:fast`; before a push run `npm run check`.

---

### Task 1: Shared prompt-to-index policy

**Files:** Create `lib/prompt-recall.js` and `test/prompt-recall.test.js`; modify `test/architecture.test.js` to classify the new module.

**Interfaces:** `promptRecall({ prompt, search, seenPaths, maxChars, signal })` returns `null` or `{ text, paths }`. `search({ query, scope: 'project', limit: 8 }, signal, exec)` is the existing service seam.

- [x] Write a test using a controlled hit list: a decision whose title matches the user's question produces a path-only map; an unrelated hit produces `null`; a previously shown path is omitted. The expected text and paths are literal values, independent of the formatter.
- [x] Run `node --test test/prompt-recall.test.js`; observe `ERR_MODULE_NOT_FOUND` for the absent module.
- [x] Implement query extraction from the user prompt, relevance filtering using `scoreSignals`, a three-hit and 360-code-point cap, and safe path/title rendering. A too-short, blank, or aborted query returns `null` without searching.
- [x] Re-run `node --test test/prompt-recall.test.js` and the architecture test. Record the actual red and green results.

### Task 2: DSH per-turn adapter

**Files:** Modify `lib/hooks.js`, `lib/index.js`, and `test/hooks.test.js`.

**Interfaces:** `registerHooks` receives `search` as a dependency; the `agent/pre-step` payload's `messages`, `turn`, and `step` identify the real user prompt. The result is a `user`-role plugin message with source `{ kind: 'plugin:obsidian-mem', form: 'prompt-recall' }`.

- [x] Add a Cordis waterfall test with a real `source.kind === 'user'` message and a search seam returning one relevant hit. Assert one map on the first step, no repeat on the second step or a later turn for the same path, and no map from a plugin message.
- [x] Run `node --test test/hooks.test.js`; observe failure because the map is absent.
- [x] Call `promptRecall` in the existing recall cycle after `next()`. Limit its `maxChars` by the budget remaining after the brief and lint hint. Commit shown paths only when the extended decision exists. Preserve reject/abort/fail-open behavior.
- [x] Re-run `node --test test/hooks.test.js`; run the full suite before finalizing both adapters.

### Task 3: Codex `UserPromptSubmit` adapter

**Files:** Create `codex/prompt-submit.mjs`; modify `codex/prepare.mjs`, `test/codex-hooks.test.js`, `codex/README.md`, and the Codex skill.

**Interfaces:** The script consumes Codex's `UserPromptSubmit` JSON on stdin and emits exactly one JSON object. A bound project and relevant prompt produce `hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text }`; every skip and failure produces `{ continue: true }`.

- [x] Add a subprocess test that binds a temporary repository, submits a relevant prompt twice, and checks one map followed by a quiet duplicate. Add unbound and malformed-payload controls, and check `hooksConfig()` declares both commands.
- [x] Run `node --test test/codex-hooks.test.js`; observe failure because `UserPromptSubmit` is absent.
- [x] Implement the command with `openMemory`, a read-only binding probe, `promptRecall`, and a hashed, bounded session-state file under `dataRoot`; generate `hooks/hooks.json` through `node codex/prepare.mjs`.
- [x] Re-run `node --test test/codex-hooks.test.js` and `node codex/prepare.mjs --check`.

### Task 4: Documentation and full verification

**Files:** Modify `README.md`, `README.zh.md`, `README.i18n.yaml`, and `CHANGELOG.md`.

- [x] Explain the new per-turn map, when it is skipped, that note bodies require `mem_read`, and that Codex still has no automatic write pipeline.
- [x] Run `git hash-object README.md README.zh.md` and register both values in `README.i18n.yaml`.
- [x] Run `npm run check`, `git diff --check`, and an isolated Codex command-hook probe; report exact pass/fail evidence and any host-level limit.
- [x] Review the diff for generated files, secrets, and accidental real-vault access. Commit without a `Co-Authored-By` trailer after `npm run check:fast`.

Verification record: the shared-policy test first failed with `ERR_MODULE_NOT_FOUND`;
the DSH test failed with the map absent; and the Codex test failed with the hook
absent. After implementation, `npm run check` passed all 641 tests, type and
format checks, package contract verification, and the 38-entry tarball check.
An isolated codex-cli 0.146.0 `hooks/list` reported both plugin hooks with no
warnings or errors; live model use of the new prompt context remains unmeasured.
