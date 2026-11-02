# Recall Measurement Implementation Plan

> **For agentic workers:** REQUIRED SUb-SKILL: use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Make retrieval quality measurable from the repository: a durable diagnostics funnel, a one-command baseline harness that can replay the recorded probes exactly, and a corpus protocol that can gate Phase 1.

**Architecture:** Three additive layers. First, the existing diagnostics ring learns a search event and two recall counts and one brief count, all inside the closed allowlist. Second, a research-only harness reuses the shipped search and gate code against a temporary index of the real vault. Third, a corpus and a paired annotation protocol turn the harness output into a baseline that can be frozen. No retrieval behaviour changes.

**Tech Stack:** Node.js ES modules and builtins (node:fs, node:os, node:sqlite, node:test); existing runtime dependencies only.

**Spec:** docs/superpowers/specs/2026-11-02-recall-measurement-design.md

## Global Constraints

- No change to ranking, gate thresholds, prompt budget, brief budget, tool contracts or config schema.
- The diagnostics ring stays content-free: no query, path, title, body, prompt or model output may reach it. The sentinel tests in test/debug.test.js must keep passing unchanged.
- EVENT_NAMES and the diagnostics output enum/properties move in one change; test/debug.test.js holds them equal.
- The harness never writes the vault, ~/.dsh or the repository; it uses a temporary data root.
- research/ is gitignored and not shipped; corpus and baseline are evidence, not product.
- No new runtime dependency; Node floor stays >=22.22.2.
- Before each commit run npm run check:fast; before push run npm run check and git diff --check. No Co-Authored-By trailer.
- Use a throwaway vault and data root in every test; never point a probe at the user's real vault or DSH home.

## File Map

| File | Responsibility |
|---|---|
| lib/debug.js | EVENT_NAMES gains search; FIELDS gains accepted, injected. |
| lib/tool-schema.js | diagnostics output enum gains search; properties gain accepted, injected. |
| lib/diagnostic-codec.js | search outcome set ok, failed. |
| lib/prompt-recall.js | decisions gain accepted and injected; floorFor and useful exported for the harness. |
| lib/hooks.js | recall records accepted/injected; brief records chars. |
| lib/services.js | services.search records one search event, timing it, rethrowing failures unchanged. |
| test/debug.test.js, test/prompt-recall.test.js, test/tools.test.js | red-first assertions for the fields, the event and privacy. |
| research/litreview/eval/harness.mjs | temporary index, scoring, selftest, replay. |
| research/litreview/eval/corpus/queries.jsonl | 200 corpus records. |
| research/litreview/eval/README.md | how to run, what the numbers mean, capture metadata. |

---

### Task 1: Diagnostics funnel (implement now) -- DONE 2026-11-02

**Files:** Modify lib/debug.js, lib/tool-schema.js, lib/diagnostic-codec.js, lib/prompt-recall.js, lib/hooks.js, lib/services.js; modify test/debug.test.js, test/prompt-recall.test.js, test/tools.test.js.

**Interfaces:** createDiagnostics keeps its signature. promptRecall returns {outcome, text, paths, hits, accepted, injected, chars}. services.search returns exactly what it returned before; side effect is one diagnostic event.

- [x] Step 1: Write failing assertions. Red output: the search category was dropped (2 events kept, 3 expected) and accepted/injected were undefined on a fired recall.
- [x] Step 2: Run the failing tests. node --test test/debug.test.js test/prompt-recall.test.js test/tools.test.js -> failed exactly as above.
- [x] Step 3: Implement the allowlist and schema. Event name and output enum moved in one change; accepted/injected added to FIELDS and output properties; search outcomes ok, failed added to the codec.
- [x] Step 4: Implement the emitters. silent defaults 0/0; fired carries gate-passed accepted and paths injected; all-seen and budget carry their real accepted; hooks records both recall counts and the brief char count; services.search times the call, records ok/failed and rethrows unchanged.
- [x] Step 5: Run the tests. debug + prompt-recall + codec: 35 pass. tools: 41 pass. hooks: 64 pass / 1 fail, the fail being the architecture budget for lib/services.js (1920 -> 1968 lines), raised 1950 -> 2000 with the table comment. Full suite: 1,505 tests, 1,504 pass, 1 skip, 0 fail.
- [x] Step 6: Report. See progress.md in the sdd directory; the diff stays uncommitted until the user asks.

### Task 2: Harness and replay (implement now) -- DONE 2026-11-02

**Files:** Create research/litreview/eval/harness.mjs and research/litreview/eval/README.md; modify lib/prompt-recall.js exports only.

**Interfaces:** harness --vault DIR --corpus FILE --out FILE --limit 8 --engine lexical; --selftest runs the fixture vault; --replay FILE reruns probe-results.json. Exit non-zero on any failed assertion. Output JSON: meta (vault stats, capture date, commit, engine, limit), records (query, class, budget-free metrics, paths), summary (pooled and by class).

- [x] Step 1: Write the harness skeleton with argument parsing, temporary data root and openIndex. Deviation: written whole, so the requested red selftest run was not captured; the selftest compares against the paths test/search.test.js pins.
- [x] Step 2: Wire scoring. floorFor and useful imported from lib/prompt-recall.js; P@1, P@3 (macro and micro), recall@8, MRR, gate pass rate, in-gate precision, no-answer false positive and latency p50/p95 recorded.
- [x] Step 3: Selftest. Fixture vault copied to a temporary vault; all 9 checks pass, including the no-answer query returning nothing.
- [x] Step 4: Replay. The live vault changed at 22:15 (two notes written by capture/distill), so the capture state was reconstructed from the snapshot and replayed: 0 floor, 0 gate, 0 path diffs, P@3 17/72, gate 30/72, in-gate 13/30. The live vault now fails with an explicit vault-drift message instead of a misleading diff.
- [x] Step 5: Document and run. eval/README.md records provenance, privacy warning, commands, report schema, the corpus protocol and limits; replay-2026-11-02.json is the frozen report.
- [x] Step 6 (2026-11-02 late): corpus mode now shares resolveVault, so it also defaults to the frozen snapshot and refuses a snapshot whose index is not 1361 notes; report meta carries vaultKind/expectedNotes. Smoke run on a 3-record mini corpus (2 exact + 1 no-answer) exited 0 and printed all requested metrics. This is harness-only; no ranking behaviour changed.

### Task 3: Corpus v1 → v2 (done 2026-11-02)

**Files:** Create research/litreview/eval/extract-queries.mjs, research/litreview/eval/corpus/queries.jsonl, research/litreview/eval/corpus/README.md.

- [x] Step 1: Extract real user prompts from session logs (zstd), redact names and secrets, and classify candidates by surface form. The target is at least 20 real prompts per class; fill the remainder synthetically with masked-title queries.
  - Reality check 2026-11-02 (A-level): only 10 of 39 session directories contain a log, and they hold 42 user-authored prompts in total (426 user/message events, 42 with source.kind=user). The 20-real-per-class target is unreachable. Deviation: use all real prompts in their natural classes, synthesize the rest from snapshot note titles/content, keep 40 records and 8 no-answer controls per class, and state the real/synthetic split in the corpus README.
- [x] Step 2: For each record record gold paths by reading the vault, not by watching what the current system returns; the no-answer records require a search to be attempted before writing them. Result: 200 records (exact 3 real/29 synth/8 no-answer; paraphrase 15/17/8; cross-lingual 0/32/8; concept 0/32/8; deictic 0/32/8), 167 unique gold paths, every no-answer phrase grep-verified in the snapshot. Adversarial review (corpus/review.md, CONCERNS) then forced v2: 2 gold mappings corrected, 11 no-answer controls replaced, 8 exact pseudo-titles turned into natural questions, session-UUID/job-id scrub fixed. v2 passes validate-corpus.mjs with VALIDATION PASSED; the resolution table is appended to corpus/review.md.
- [x] Step 3: Label 30 shared records twice; compute Cohen kappa; if below 0.6, revise the rubric and repeat. Result: two independent annotators produced 30×3 labels; κ(3-class) = 0.893, binary κ = 1.0, gold slot labeled 2 by both on 30/30; per-class κ 0.786–1.0; report in corpus/kappa-2026-11-02.json. The four records whose candidate pool changed in v2 were re-labeled by both annotators and matched on all 12 labels; the other 26 v1 labels were carried over. Caveat recorded in corpus/README.md: hard negatives are easy by construction, so κ is an upper bound.
- [x] Step 4: Freeze the corpus with a README that states provenance, counts, the rubric, the kappa and the date. Frozen as v2 on 2026-11-02; corpus/README.md documents the v2 revision record, per-class counts, κ, the known limits and the reproduction commands.

### Task 4: Baseline artifact and gate (baseline done 2026-11-02; CHANGELOG deferred)

**Files:** Create research/litreview/eval/baseline-2026-11.md and update research/litreview/README.md; update CHANGELOG.md Unreleased once the numbers are verified.

- [x] Step 1: Run the harness on the frozen corpus and record the pooled/per-class table, vault statistics and command. Result: research/litreview/eval/baseline-2026-11-02-v2.json (737,897 B) + baseline-2026-11-02.md. 200 records against 1361 indexed notes (build 2642 ms, commit abf12b5): pooled P@1 32.5%, P@3 44.4% (macro) / 14.8% (micro, 71/480), recall@8 53.6%, MRR 39.2%, gate pass 61.0%, in-gate precision 20.1%, no-answer FPR 50.0%, p50 233.4 ms / p95 347.1 ms. Per-class P@3: exact 96.9, paraphrase 53.1, concept 37.5, deictic 18.8, cross-lingual 15.6.
- [x] Step 2: State the Phase 1 acceptance threshold against that baseline (for example P@3 improvement and in-gate precision) and the falsifier that would reject it. Written in baseline-2026-11-02.md: pooled P@3 +8pp with bootstrap CI excluding 0; no class down >3pp; in-gate precision +8pp; FPR up ≤5pp; exact down ≤2pp; p50 ≤1.5×. Falsifiers: pooled P@3 gain <5pp, any class down >5pp, FPR up >10pp, cross-lingual P@3 gain <5pp.
- [ ] Step 3: Add the reproduction commands to the research README and the honest verified/untested line to CHANGELOG. Research README updated; CHANGELOG deliberately deferred until the uncommitted Task 1 diagnostic change set is reviewed and committed with the user's confirmation (it describes shipped lib/ behaviour, not harness-only research).
