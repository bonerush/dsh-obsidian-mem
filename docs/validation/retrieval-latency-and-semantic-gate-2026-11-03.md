# Retrieval latency and the calibrated semantic gate — validation record

Date: 2026-11-03
Status: accepted
Applies to: 24e2fb8, 7456d84, d299b29, plus the docs commit that
adds this record. This is the follow-up to
`docs/validation/retrieval-hybrid-2026-11-02.md`; that record is left as it was
written, including its latency failure.

## 1. Scope

Four changes landed after the Phase 1/2 acceptance run:

1. the filtered token query stops scanning `notes_fts` end to end;
2. source verification overlaps its reads;
3. `embedding-store` bisects a timed-out batch instead of failing the warm;
4. the recall gate accepts a calibrated semantic slot.

Every number below comes from the frozen corpus
`research/litreview/eval/corpus/queries.jsonl` (200 queries: 160 answerable and
40 no-answer controls), the frozen snapshot
`research/litreview/eval/vault-2026-11-02` (1,361 indexed notes), and one
machine. Corpus quality numbers are therefore directly comparable with
`baseline-2026-11-02-v2.json` and the two Phase 1/2 baselines.

## 2. Latency: where the ~200 ms went

Symptom. On a 40-query slice with `limit: 8` the lexical path needed p50
233.7 ms / p95 268.9 ms, and hybrid 444.6 ms. This was not SQLite being slow in
general: the same `MATCH` with no project/status filter ran in p50 1.82 ms and
a path-only query in 0.84 ms.

Cause. The filtered query was planned as a MULTI-INDEX OR over the `notes`
table columns, after which SQLite scanned the whole `notes_fts` virtual table to
compute `bm25` (p50 202.5 ms for that shape). Two rewrites were measured:
unary `+` prefixes on the filtered columns (p50 1.51 ms) and a CTE (1.58 ms).
The unary form was chosen because it needs no second statement parameter set.

Fix. `lib/index-db.js` now takes a fourth `{ unindexed }` argument in
`applySqlFilters`; the token branch goes through the exported
`tokenSourceStatement(filters)`, which emits `+n.project` / `+n.status` and
pins `bm25(notes_fts, 10, 1, 4)` with `BM25_WEIGHTS = [10, 1, 4]`. The weights
are explicit because the default bm25 weighting changes the ranking once the
plan changes.

Result.

| measurement | before | after |
|---|---|---|
| 40-query lex8, p50 / p95 | 233.7 / 268.9 ms | 24.3 / 57.5 ms |
| corpus lexical, p50 / p95 | 233.4 / 347.1 ms | 22.3 / 45.0 ms |
| corpus hybrid, p50 / p95 | 444.6 / 557.9 ms | 121.2 / 173.6 ms |

Equivalence. 200 token queries were replayed through the old and the new
statement: the returned path lists had 0 differences. Corpus quality is
bit-identical to the Phase 1/2 numbers (lexical P@3 44.375%, hybrid P@3
61.25%, every per-class figure unchanged), and the lexical run reproduces the
frozen ranking exactly.

What the latency claim is. Spec B froze a p50 ceiling of `<= 1.5x the lexical
baseline`, which was 233.4 ms then, so 350 ms was recorded as an absolute
ceiling. The fix moved the lexical baseline itself to 22.3 ms, so hybrid is now
5.4x lexical while still far under 350 ms. The absolute ceiling is met; the
ratio claim is withdrawn, and the residual ~99 ms is one loopback embedding
round trip per query. No further latency work is claimed here.

## 3. Overlapping source verification

`search()` used to verify each cached candidate one at a time. It now batches
`page.rows` and awaits at most `VERIFY_CONCURRENCY = 16` reads at once, then
pushes hits in the original row order. The accepted window is filled by the
same rule, so the returned set is unchanged; a test asserts a candidate window
of 32, 32 scored candidates, 8 hits, an in-flight peak above 1 and at most 16.
Measured effect is small: lex8 p50 19.0 ms against 22.4 ms with concurrency 1
(n=40, one machine, one run). It is kept for I/O overlap, not as the latency
fix.

## 4. Slow-model batch bisection

The e5-base ONNX model has no `token_type_ids` input, which the research
server needed to handle separately, and its forward pass is slow enough that
16 passages of 1,200 code points need about 5.4 s on CPU. The provider ceiling
(`timeoutMs` may not exceed 5000) therefore made the first warm fail every
time with `provider-timeout`, even though a single 1,200-code-point passage
answers well inside the limit.

`lib/embedding-store.js` now calls `embedSlice(slice)`: on `provider-timeout`
with more than one text it halves the slice and recurses, concatenating the two
answers; a single text that still times out is reported as an error. `batches`
counts only successful provider requests. Evidence: two new tests (4 notes with
a fake provider that times out above 2 texts yields calls [4,2,2] and
`{embedded:4, batches:2}`; two texts that both time out reject with
`provider-timeout`), file 15/15. Real run: e5-base first warm embedded 1,361
notes in 171 batches and 423 s.

## 5. Semantic gate

Design. `useful()` already accepted a hit on a title/phrase signal or on enough
token hits. Hybrid hits also carry `semantic-score` and `hybrid-rank`, and the
gate now accepts a top-three fused slot whose dense score is at least 0.92:
`SEMANTIC_GATE_SCORE = 0.92`, `SEMANTIC_GATE_RANK = 2` (zero-based, so rank 0-2).
Both must be present, so lexical results without those signals are unaffected.

Threshold calibration on the frozen corpus (e5-small/384):

| threshold | gate pass | in-gate precision | no-answer FPR |
|---|---|---|---|
| no semantic branch (Phase 2) | 24.58% | 39.83% | 5.0% |
| 0.88 | 71.7% | 24.7% | 62.5% |
| 0.90 | 40.0% | 36.5% | 5.0% |
| 0.92 | 27.9% | 41.8% | 5.0% |
| 0.94 | 24.8% | 40.3% | 5.0% |

At 0.92 the gate accepts 16 extra top-three slots, 9 of them relevant, and 9
queries that had no injection gain one. Pooled P@3 stays 61.25% because the
gate does not reorder. Deictic queries receive their first injections: 8 slots,
5 relevant (class in-gate precision 62.5%). With e5-base/768 the branch adds a
single relevant slot (gate pass 24.79 -> 25.0%, in-gate 39.5 -> 40.0%, FPR
2.5%), so the threshold is a calibration for the documented e5-small default,
not a model-independent constant.

The harness `gateView` was extended with the same two signals so its gate
recomputation matches the product, and two product tests pin the branch (one
positive at score 0.93 / rank 2, one negative at 0.91 / rank 1 and 0.99 / rank
3).

## 6. What was swept and rejected

- Fusion weights: lexical 0.5-2.0 against dense 1.0-3.0 moved macro P@3 by at
  most +0.2 pp and sometimes cost recall@8; the frozen 1:2 weighting stays.
- Adaptive guard threshold 4/6/8/10/12: 8 remains the local optimum for P@3.
- Candidate counts (lexical 20/30/50, dense 30/50/100): top-8 is unchanged;
  50/50 stays.
- Cosine-weighted fusion instead of RRF, dense floor 0.5-0.8, and dense weight
  3-6 for short queries: all below +1 pp or recall-negative.
- Dense context length 400 vs 1,000 characters: every metric bit-identical.

## 7. The optional e5-base channel

e5-base/768 reaches pooled P@3 62.5%, P@1 45.0%, recall@8 68.0%, MRR 54.0%,
gate pass 25.0%, in-gate 40.0%, FPR 2.5% and p50 138.7 ms on the same corpus.
Against e5-small that is +1.25 pp P@3, +1.9 pp P@1, a lower FPR, but -0.6 pp
recall@8, deictic P@3 43.8 -> 40.6 (-3.2 pp) and a 1.1 GB model whose first
warm needs 7 minutes. e5-small stays the documented default; e5-base is a
documented option, not a new default.

## 8. Replay fixture refresh

The Phase 0 fixture `research/litreview/probes/probe-results.json` recorded the
Phase 0 gate (token floor 4, no semantic branch). Replaying it with the current
code reports 20 gate differences and 18/72 accepted against its recorded 30/72:
that is the intended Phase 2 gate change plus the explicit bm25 weights, not a
regression. The old fixture is kept because the 00 and 04 reports cite it as
history. A new recorder, `research/litreview/eval/record-probe-baseline.mjs`,
writes `research/litreview/probes/probe-baseline-2026-11-03.json` with
expectations (relevantTop3 17, gatePassedTop3 18, gateRelevantTop3 10), and
`harness --replay` now reads its expectations from the fixture. The new record
replays with 0 floor / 0 gate / 0 path differences; P@3 stays 17/72 = 23.6%.

## 9. Repository gate

`npm run check` exits 0 on 2026-11-03: lint, `format:check` and `types` pass; the
suite runs 1,549 tests with 1,548 passing, 0 failing and 1 skipped in 161.3 s;
`verify-pack` reports v1.0.7 with 7 allowlist entries, 16 required assets and 6
tools; `verify-tarball` reports 92 entries and 82 lib modules. That is the same
tarball shape as 1.0.7, so AGENTS.md keeps its 92 / 83 entries (82 modules plus
the graph-worker license) figure.

## 10. Reproduction

    node --test test/search.test.js test/embedding-store.test.js \
      test/prompt-recall.test.js test/architecture.test.js

    # lexical and hybrid corpus runs against the snapshot
    node research/litreview/eval/harness.mjs \
      --corpus research/litreview/eval/corpus/queries.jsonl \
      --out /tmp/lexical-postfix.json
    node research/litreview/eval/harness.mjs \
      --corpus research/litreview/eval/corpus/queries.jsonl --engine hybrid \
      --data-root /tmp/obsidian-mem-hybrid-small \
      --out /tmp/hybrid-semgate.json

    # e5-base channel (server on 127.0.0.1:8766, store pre-warmed)
    node research/litreview/eval/harness.mjs \
      --corpus research/litreview/eval/corpus/queries.jsonl --engine hybrid \
      --endpoint http://127.0.0.1:8766 --model intfloat/multilingual-e5-base \
      --dimensions 768 --data-root /tmp/obsidian-mem-hybrid-base \
      --out /tmp/hybrid-e5-base-semgate.json

    # replay against the refreshed fixture
    node research/litreview/eval/harness.mjs \
      --replay research/litreview/probes/probe-baseline-2026-11-03.json

The embedding server used for the runs is `research/litreview/eval/embed-server.py`
(research only, not shipped); the plugin itself ships no provider and defaults
to lexical.

## 11. Limits and what this does not prove

- Corpus and snapshot are frozen and small (200 queries, 1,361 notes, one
  annotation pair). Results do not establish live-session gains.
- Timings are one machine, one run per configuration; the p50 differences
  between 121.2 and 22.3 ms are meaningful, the last few milliseconds are not.
- The semantic branch is calibrated on e5-small and near-neutral on e5-base;
  another model needs a new threshold.
- Cross-lingual P@3 21.9% and deictic 43.8% are bounded by candidate recall: the
  candidate oracle shows the gold note absent from the lexical union for 44% of
  cross-lingual and 37.5% of deictic queries. Fusion and the gate cannot fix
  that; write-side bilingual keys or a different candidate source would.
- Live-session hybrid trigger rate, the 900-character injection budget,
  near-miss production frequency and dense-only snippet quality are still
  unmeasured. The gate branch can now be observed through
  `recall.outcome` and `injected`.
