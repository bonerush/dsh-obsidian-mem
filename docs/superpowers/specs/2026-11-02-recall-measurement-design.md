# Recall measurement: a diagnostics funnel and a reproducible baseline

Status: frozen 2026-11-02. Owner: lead. Scope: Phase 0 of research/litreview/00-memory-framework-diagnosis-and-roadmap-2026-11.md §6, implementing it rather than re-deciding it.
Evidence this spec is built on: 00 §6 (the four Phase 0 deliverables and their acceptance rules); research/litreview/04-current-system-diagnosis.md lines 9, 10, 22, 79, 138, 144 and 187 (P@3 23.6% of 72, 6 sessions and 14 injections, 33 diagnostic runs and 3,219 events, the gate table, the R5 evaluation blind spot); research/litreview/probes/README.md (the 24-probe protocol and rubric); research/litreview/probes/probe-results.json (the recorded top-8 lists and gate decisions).

## Problem and evidence

1. The only quality numbers we have were produced by a throwaway probe script. The script is not in the repository, the corpus is 24 hand-written queries, one person judged relevance, and every number in 04 is therefore reproducible only by rerunning the script from memory. A rerun of 23.6% P@3 today would not prove the same thing tomorrow.
2. The plugin cannot answer its own retrieval questions. Across 33 runs and 3,219 events (04 line 22) there is no search event at all, recall records how many candidates came back and how many characters were injected but not how many passed the gate, and brief records coverage but not character count. The 14-injection sample in 04 had to be classified by reading session transcripts, which is exactly the measurement that cannot be automated and therefore cannot guard a change.
3. The consequence is a gating problem, not a reporting problem. Phase 1 of 00 changes what the index can match; without a frozen baseline and a same-harness rerun, any observed improvement can be attributed to the new corpus, a different annotator, or a changed gate with equal plausibility.

## Goals

G1. Additive diagnostics: one search event per services.search call; recall gains accepted and injected; brief gains chars. Privacy unchanged and enforced by the existing closed allowlist and sentinel tests.
G2. One command rebuilds an index from the real vault into a temporary data root and scores a corpus with the same gate code the prompt path uses. The vault stays read-only; nothing is written under the user's DSH home.
G3. Replay proof: the harness, given the recorded probe queries, reproduces the recorded top-8 path lists in order (zero diffs) and the recorded P@3 of 23.6% (17/72).
G4. Corpus protocol: 200 query-to-gold records, five classes of 40 (exact, paraphrase, cross-lingual, concept, deictic), eight no-answer controls per class, a real-versus-synthetic column, and two independent annotations with Cohen kappa at least 0.6 on 30 shared records.

## Non-goals

- No change to ranking, gate thresholds, prompt budget or brief budget. This spec measures the system as it is.
- No embedding, reranker, query rewrite or new runtime dependency.
- No vault writes and no edit to any user configuration.
- The corpus and baseline live under research/, which this repository deliberately does not ship. They are evidence, not product.
- No model-generated labels for the corpus. The model under test is not its own judge.

## Design

### Diagnostics data model (lib/debug.js allowlist)

- search: outcome is ok or failed; hits is an integer >= 0 (the result count); ms is an integer >= 0 (wall time of the service call). One event per services.search call, so the per-turn prompt recall and an explicit mem_search are both counted. The caller is not distinguished in this version; that would need a field the tool layer does not have yet.
- recall: rejects nothing it accepted before. adds accepted (integer >= 0: candidates that passed the useful() gate) and injected (integer >= 0: paths actually written into the turn map). hits keeps its current meaning, the pre-gate candidate count.
- brief: adds chars (integer >= 0: the injected text charCount). It keeps coverage as is.
- No field carries a query, path, title, body or duration histogram. The allowlist in lib/debug.js stays the single gate, and lib/tool-schema.js's diagnostics enum and properties stay equal to it (test/debug.test.js holds both equal).
- lib/diagnostic-codec.js gains the search outcome set ok/failed; without it the durable journal would coarsen both to other.

### Harness

Path: research/litreview/eval/harness.mjs (not shipped). Arguments: --vault, --corpus, --out, --selftest, --replay, --limit 8, --engine lexical.

Flow: mkdtemp a data root; openIndex({vaultRoot, dataRoot, backend: sqlite, projectId}) using the projectId from the vault binding; waitReady; for each corpus record call index.search({query, scope: project, limit}); apply the same floorFor and useful() the prompt path applies (both exported from lib/prompt-recall.js with no behaviour change); compute per-class and pooled P@1, P@3, recall@8 over known-gold records, MRR, gate pass rate, precision within the gate, injected characters and p50/p95 latency; write one JSON.

Selftest: build a temporary vault from test/fixtures/search/corpus, index it, and assert the paths that test/search.test.js already pins. This proves the harness imports and calls the real seams correctly without touching the user's vault.

Replay: read probe-results.json, run its 24 queries against the live vault, require each top-8 path array to equal the recorded array exactly, and then require 17/72 = 23.6% top-3 precision. Exit 1 and print the first differing row on failure. The replay also records current vault statistics (note count and newest mtime from the index status) so that a legitimate vault change is visible rather than silently changing the baseline; it warns, it does not hide the diff.

### Corpus protocol (research/litreview/eval/corpus/queries.jsonl)

One JSON object per line: id, class (exact, paraphrase, cross-lingual, concept, deictic), source (real or synthetic), query, gold (array of vault-relative paths), noAnswer (boolean), notes. Gold paths are the notes that answer the query, judged before retrieval. Real queries are extracted from the user's own session logs with a redaction pass; synthetic queries are derived from a note while its title tokens are masked. Rubric: 3 = directly answers, 2 = key clue, 1 = same topic but does not answer, 0 = irrelevant. Two annotators label the top-8 lists independently on 30 shared records; Cohen kappa is computed on those labels and must reach 0.6 before the corpus is frozen. Reports always show real and synthetic columns separately.

### Failure paths

- Missing vault or index failure: print the failing path and exit 1 with no partial metrics.
- Corpus schema violation: validate counts, class distribution, no-answer controls and unique ids before indexing; refuse to score.
- Replay differences caused by a changed vault: report them, never auto-accept. The baseline artifact names the capture date, commit and vault statistics it was taken under.
- Diagnostic write failure: recordDiagnostic already swallows, and services.search's instrumentation must not change the call's result; the event is best effort, the search result is not.

## Token/context budget

No host budget changes: briefBudgetChars stays 6000 and recallBudgetChars stays 900. Diagnostics never enter a message; they live in the ring and the local journal and are read only through mem_admin. The corpus is 200 lines of JSONL, and the harness runs offline, so no model tokens are spent by measuring.

## Compatibility and safety

- lib/services.js already receives the ring as options.diagnostics and creates one when absent (lib/services.js:162), and the durable journal sink is already wired in lib/index.js:86-94. The new event only adds a recordDiagnostic call on an existing path.
- Adding fields is additive for old readers; the one real break risk is the two-list equality (EVENT_NAMES versus the output enum), which is why both lists and the tests change in one commit.
- The harness writes only to an OS temporary directory and reads the vault. It never writes the vault, ~/.dsh, the user's configuration or the repository.
- No new dependency; node builtins only.

## Alternatives rejected

- Production telemetry alone: cannot label relevance and would make the diagnostic ring content-bearing.
- Reusing the 24 probes as the corpus: one annotator, no kappa, top-3 only, no no-answer controls, and hand-written queries that the author also knew how to answer.
- LLM-as-judge labels: the model under test would grade itself, no independent kappa, and the label set would not be auditable.
- Snapshotting the whole 9.6 MB index into research/: not portable, not diffable. The corpus plus recorded vault statistics is the compromise.

## Acceptance criteria

1. A new test in test/debug.test.js fails before implementation (search rejected as unknown category, accepted/injected dropped as unknown fields) and passes after.
2. promptRecall fired decisions carry accepted and injected; below-floor decisions carry accepted 0 and injected 0; the existing tests that read paths still pass.
3. A tools-level test: one mem_search appends a search event with outcome ok, integer hits (> 0 on the fixture), integer ms, and the serialized event contains no query key.
4. An injected brief event carries chars equal to the injected text length.
5. node --test test/debug.test.js test/prompt-recall.test.js test/tools.test.js test/diagnostic-codec.test.js test/hooks.test.js is green.
6. node research/litreview/eval/harness.mjs --selftest is green on the fixture corpus.
7. node research/litreview/eval/harness.mjs --replay prints zero path differences and P@3 = 23.6% on the real vault.
8. The corpus validates at 200 records with the class counts and no-answer controls above.

## Risks and rollback

- The ring and the output schema drift apart: caught by the existing equality test; rollback is one revert of the instrumentation commit.
- Replay becomes flaky because the vault keeps growing: mitigated by recorded vault statistics and by reporting the diff instead of asserting vault immutability; the frozen baseline is the artifact that matters, not a permanently identical vault.
- Privacy regression: caught by the sentinel tests in test/debug.test.js, which must keep passing unchanged.
- Kappa below 0.6: revise the rubric and relabel, do not quietly keep one annotator.
