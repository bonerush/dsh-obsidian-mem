# Hybrid retrieval and calibrated recall gate — validation (2026-11-02)

This record covers the opt-in hybrid engine (`retrievalEngine: "hybrid"`) and the
Phase 2 gate with its near-miss tier. Both were measured on a frozen evaluation
corpus that lives outside the package (`research/litreview/`, git-ignored) so the
numbers below are reproducible from a checkout but the vault snapshot is never
shipped.

## What was measured

- Corpus: 200 queries, 40 per class (exact, paraphrase, cross-lingual, concept,
  deictic), each class with 8 no-answer controls. Two independent annotators on a
  30-query shared set: Cohen's kappa 0.893 over 90 labels (three classes 0/1/2);
  binary kappa (answers vs not) 1.0.
- Store: a frozen markdown-only snapshot of 1,361 indexed notes. The snapshot is
  required because the plugin writes to its own memory while it is measured.
- Baseline commit: bf56892.
- Engine runs: lexical (no provider) and hybrid with a loopback FastAPI-style
  Python server serving intfloat/multilingual-e5-small (384 dimensions) through
  onnxruntime. The server is research tooling and is not shipped.
- Harness: `research/litreview/eval/harness.mjs` imports `lib/index-db.js`,
  `lib/search.js` and the gate exports of `lib/prompt-recall.js`, so the measured
  code is the shipped read path. It uses a temporary data root and writes only its
  report.

## Pooled results

| Engine / gate | P@3 | in-gate precision | no-answer FPR | p50 |
|---|---|---|---|---|
| lexical, old gate (Phase 0 baseline) | 44.4% | 20.1% | 50.0% | 233.4 ms |
| hybrid, old gate | 61.25% | 27.9% | 32.5% | 408.2 ms |
| lexical, new gate | 44.4% | 33.8% | 2.5% | 307.7 ms |
| hybrid, new gate | 61.25% | 39.8% | 5.0% | 444.6 ms |

Hybrid also moved P@1 32.5% → 43.1%, recall@8 53.6% → 68.6% and MRR 39.2% →
52.3%. Per-class hybrid P@3: exact 96.9% (flat), paraphrase 53.1% → 84.4%,
concept 37.5% → 59.4%, cross-lingual 15.6% → 21.9%, deictic 18.8% → 43.8%; no
class regressed.

The gate changes acceptance only. The lexical and hybrid reports before and after
the gate change have bit-identical ranking metrics per class, which is the
regression evidence that the gate does not reorder.

## Acceptance

Phase 1 thresholds (from the Phase 0 baseline):

| Condition | Required | Measured | Result |
|---|---|---|---|
| pooled P@3 | >= 52.4% (+8pp) | 61.25% (+16.9pp) | pass |
| any class P@3 drop | <= 3pp | none (all flat or up) | pass |
| in-gate precision | >= 28.1% (+8pp) | 39.8% | pass |
| no-answer FPR | <= 55% | 5.0% | pass |
| exact P@3 | no more than -2pp | 96.9% (flat) | pass |
| latency p50 | <= 350 ms (1.5x) | 444.6 ms | **fail** |

Falsifiers: pooled gain < 5pp (measured +16.9pp), any class -5pp (none), FPR +10pp
(measured -45pp), cross-lingual gain < 5pp (measured +6.25pp). None triggered.

The latency failure is the implementation cost of the hybrid engine: every query
embeds the query text through the loopback provider, about 150-400 ms per round
trip on the measurement machine, and the corpus harness runs queries serially.
The gate change does not add this cost (hybrid alone p50 was 408.2 ms; the 36 ms
difference is run-to-run noise). Hybrid is opt-in for this reason, and the
shipped default remains lexical.

## Reproduce

```sh
# 1) the harness can fail before its numbers are trusted
node research/litreview/eval/harness.mjs --selftest

# 2) lexical corpus
node research/litreview/eval/harness.mjs \
  --corpus research/litreview/eval/corpus/queries.jsonl \
  --out /tmp/lexical.json

# 3) hybrid corpus (start the loopback embedding server first)
EMBED_MODEL_DIR=/tmp/embtest/model /tmp/embtest/venv/bin/python \
  research/litreview/eval/embed-server.py 8765
node research/litreview/eval/harness.mjs \
  --corpus research/litreview/eval/corpus/queries.jsonl \
  --engine hybrid --endpoint http://127.0.0.1:8765 \
  --model intfloat/multilingual-e5-small --dimensions 384 --timeout 5000 \
  --data-root /tmp/obsidian-mem-hybrid-small --out /tmp/hybrid.json
```

The full report schema, corpus protocol and limits are documented in
`research/litreview/eval/README.md`; `baseline-2026-11-02-phase1-2-validation.md`
holds the four-run comparison and the acceptance mapping.

## Repository gate

`npm run check` exits 0 on the final tree: lint, `format:check` and `types` pass;
the suite reports 1,543 tests, 1,542 pass, 0 fail, 1 skipped (176.7 s);
`verify-pack` and `verify-tarball` pass with **92 entries / 82 lib modules** after
the three new modules (`embedding-store`, `hybrid-search`, `hybrid-recall`) were
registered. `AGENTS.md`'s tarball paragraph was re-measured to the same figures.

## What is not verified

- The real-session firing rate and the 900-character injection budget. Corpus
  metrics score ranking and gate acceptance, not what a live session injects.
- The near-miss injection path is covered by unit tests only; the corpus harness
  recomputes the gate and does not replay `promptRecall`'s message. Production
  evidence will be `recall.outcome: "near-miss"` and `injected: 1` in the
  diagnostics ring.
- `retrievalProvider.rerank`: the provider contract can call a `/rerank`
  endpoint, but the hybrid ranking does not use it yet; setting it true changes
  nothing in the fused order.
- A larger embedding model (768-d) was downloaded but produced no report, so no
  claim is made about it.
- cross-lingual remains the weakest class (P@3 21.9%). The hybrid engine narrows
  the gap; it does not close it.
