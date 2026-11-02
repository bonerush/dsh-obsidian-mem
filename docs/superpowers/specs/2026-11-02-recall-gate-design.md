# Recall gate and near-miss design (Phase 2)

- Status: frozen 2026-11-02
- Owner: lead
- Depends on: docs/superpowers/specs/2026-11-02-hybrid-recall-design.md (frozen)
- Evidence: research/litreview/eval/baseline-2026-11-02-v2.json (lexical gate:
  in-gate precision 20.1%, no-answer FPR 50.0%), research/litreview/eval/
  baseline-2026-11-02-hybrid-small.json (hybrid ranking: pooled P@3 61.25%),
  /tmp/embtest/gate-sim2.py (offline gate sweep), Lead probes in
  research/litreview/05-lead-firsthand-friction-log.md.

## 1. Problem and evidence

Hybrid ranking fixes candidate quality but the shipped gate still decides what
reaches the prompt. Measured on the frozen corpus, the gate passes 61.0% of
top-3 slots and only 20.1% of what it passes is relevant; 50.0% of no-answer
controls still pass. The gate's title/phrase branch almost never fires on
whole-sentence prompts, so the token-hits branch carries the decision with a
floor of 3–4 — too low to separate a topical near-hit from an answer.

The hybrid baseline's per-class gate rows show the same split from the other
side: exact queries pass 82.3% of top-3 slots (38.0% relevant), paraphrase
38.5% (32.4%), concept 58.3% (26.8%), cross-lingual 52.1% (8.0%), deictic 4.2%
(50.0%, self-silencing). A higher token floor plus an explicit weak tier is the
cheapest change that moves precision without making deictic recall impossible.

Offline sweep (real lexical ranks + real note vectors, python replay of the
gate rule): title/phrase OR token-hits >= 6 gives in-gate precision 39.8% and
no-answer FPR 5.0%; >=8 gives 58.6% / 0.0% but rejects too many paraphrase
answers. Six is the smallest floor that clears the Phase 2 acceptance target
(in-gate >= 35%, FPR <= 25%) with margin on the corpus.

## 2. Goals

G1. Raise the automatic-recall gate to title/phrase evidence OR
    token-hits >= max(6, floor). No other branch changes; deictic turns keep
    self-silencing rather than injecting noise.
G2. Add a third decision, near-miss: when no candidate clears the gate but the
    hybrid shortlist has a dense-only candidate whose semantic score >= 0.88
    and hybrid rank <= 3, inject exactly one hint line naming the note and
    saying it is a weak match. Never inject its body or excerpt.
G3. Keep the automatic path's cost flat: one hint line stays inside the
    existing recall budget (900 code points default) and the near-miss outcome
    is visible in diagnostics.
G4. Keep lexical behaviour unchanged in one direction only: a lexical query
    has no semantic score, so it can only fire or stay silent exactly as
    before, minus the stricter token floor.

## 3. Non-goals

N1. No change to hybrid fusion weights, the lexical guard, ranking, store or
    provider contract.
N2. No near-miss in the one-shot brief; this is per-turn recall only.
N3. No model call, reranker or LLM judge on the read path.
N4. No new config key: the constants are code constants for this phase, and
    the falsifier below is what would justify making them configurable.
N5. No change to mem_search's explicit results — the gate lives on the
    automatic recall path only.

## 4. Design

### 4.1 Gate

`useful(hit, floor)` keeps every eligibility rule it has (path must be a
project note, not an index/hot note, status automatically eligible) and then:

    title-exact | title-contains | phrase-contains  -> accept
    token-hits >= max(6, floor)                      -> accept
    otherwise                                        -> reject

`floor` is still `floorFor(queryTokens)` (max(3, min(4, ceil(0.3*tokens))))
so the effective bound is 6 for every query; the max() documents intent and
keeps the expression correct if the floor is retuned later.

### 4.2 Near-miss

After the accept loop, when `paths.length === 0`:

1. Parse each hit's `scoreSignals` (`semantic-score:<float>`,
   `hybrid-rank:<int>`, produced by lib/services.js).
2. Keep candidates with semantic score >= 0.88 and hybrid rank <= 3.
3. Pick the best by (hybrid rank ascending, semantic score descending).
4. Emit `HEAD` + one line:

       - [weak match] "<path>" · "<title>" — 语义相近但没有达到直接引用的门槛，
         需要时用 mem_read 核实全文。

   The line names the note and says it is weak; it carries no body and no
   excerpt. One line only, and only when it fits `maxChars`.
5. Return outcome `near-miss`, `accepted: 0`, `injected: 1`,
   `paths: [path]` so the session dedupe records it.

Threshold rationale: e5-small cross-lingual queries that are correct
neighbours score 0.88–0.94 in the offline sweep, while unrelated no-answer
controls sit below 0.82 except for shared-topic notes; hybrid rank <= 3 keeps
the tier to the fusion's own top shortlist. Both constants are falsified by
the acceptance run below, not by taste.

### 4.3 Diagnostics

`recall` outcomes gain `near-miss` (lib/diagnostic-codec.js). The event keeps
the fields Task 1 added: `hits`, `accepted`, `injected`, `chars`; near-miss
therefore records accepted 0 / injected 1, which is how the injection rate can
be read without storing note paths.

### 4.4 Harness mirroring

The evaluation harness reuses `useful()` from lib/prompt-recall.js, so the
gate change is measured by the same code the plugin runs. Near-miss is not part
of the harness's gate metric (it only asks whether a top-3 slot passes the
gate); Phase 2 additionally re-runs the hybrid corpus and reports gate-pass
rate and in-gate precision before/after.

## 5. Token and context budget

- Automatic recall ceiling stays 900 code points (`recallBudgetChars`).
- A near-miss line is bounded by path + title (60 code points) + fixed copy
  (~80 code points), so it costs about 150–220 code points, well inside the
  ceiling; if it does not fit, the decision is silent (`budget`).
- The brief is untouched; no new context is injected at session start.

## 6. Acceptance criteria

A1. Red->green tests: token-hits 5 rejected where 4 was accepted before;
    token-hits 6 accepted at floor 3 and floor 4; title/phrase still accepted.
A2. Near-miss emits exactly one line, no excerpt, only for semantic-score
    >= 0.88 and hybrid-rank <= 3; below threshold stays silent; no-body rule
    asserted on the text.
A3. Diagnostics accept `near-miss` as a recall outcome; codec round-trip test
    keeps the outcome (not `other`).
A4. Corpus replay in hybrid mode with the new gate reaches in-gate precision
    >= 35% and no-answer FPR <= 25%, with pooled P@3 still >= 60% and no class
    losing > 3pp versus baseline-2026-11-02-hybrid-small.json. The replay is
    archived as research/litreview/eval/baseline-2026-11-02-hybrid-gate-v2.json.
A5. Lexical corpus replay's gate metrics are recorded before/after in the
    validation doc; lexical P@3 must not move (ranking untouched).
A6. Full suite + npm run check green.

## 7. Risks and rollback

R1. Stricter floor silences paraphrase/deictic answers that token-hits 4–5
    used to surface. Falsifier: any class loses > 3pp P@3 in hybrid replay;
    rollback is restoring the floor expression to `floor`.
R2. Near-miss injects noise when the dense channel is semantically close but
    wrong. Falsifier: near-miss lines that are irrelevant exceed 50% on a
    30-case manual read; rollback is removing the near-miss branch (one
    function-local block) while keeping the gate.
R3. Threshold drift: a different embedding model changes the cosine scale.
    The near-miss branch is only active when hybrid signals exist; a model
    swap must re-run A4 before shipping.

Rollback is a code revert only; no vault, index schema or config changes.

## 8. Alternatives considered

- **Gate on hybrid rank only** (accept top1–2 fused hits): higher pass rate
  but 8.0% in-gate precision on cross-lingual controls; rejected.
- **Dense-only gate** (semantic score >= threshold): needs a calibrated
  per-model threshold and cannot fire for lexical-only deployments; rejected
  as the primary path, kept as the near-miss tier only.
- **Silence everything below 6**: cheapest and highest precision, but deictic
  and paraphrase answers would be lost silently; the near-miss tier is the
  explicit "there may be something, go check" channel instead.
