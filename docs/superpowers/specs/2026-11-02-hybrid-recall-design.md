# Hybrid recall design (loopback dense candidate channel)

- Status: frozen 2026-11-02; implemented 2026-11-03 (see docs/validation/retrieval-hybrid-2026-11-02.md)
- Owner: lead
- Supersedes: ADR-53 / ADR-80 / Conventions 无向量 hard constraint (needs an explicit supersede record; this spec changes the read path only when the user opts in)
- Evidence: research/litreview/00-memory-framework-diagnosis-and-roadmap-2026-11.md, research/litreview/eval/baseline-2026-11-02.md, research/litreview/eval/replay-2026-11-02.json, /tmp/embtest (experiment scripts, not shipped)

## 1. Problem and evidence

The read path is lexical only: FTS5 with CJK bigrams and BM25. The measured
baseline on the frozen 200-query corpus (corpus v2, kappa 0.893) is pooled
P@3 44.4% (71/160 relevant top3 hits), in-gate precision 20.1%, no-answer
false-positive rate 50.0%, p50 latency 233.4 ms. The per-class P@3 is exact
96.9, paraphrase 53.1, concept 37.5, deictic 18.8, cross-lingual 15.6. The
failure is not ranking quality inside a lexical candidate set; it is that the
candidate set is often empty or wrong for paraphrases, cross-lingual queries
and concept queries (Lead probes: 0/3 relevant for two synonym queries and a
cross-lingual query).

A loopback dense channel closes most of that gap. Using multilingual-e5-small
(384 dimensions, ONNX, CPU) over the same 1089 project notes:

- dense-only: paraphrase P@1 0.469, concept recall@8 0.812, exact P@1 0.531.
- lexical top50 + dense top50 weighted RRF (lexical weight 1.0, dense weight
  2.0, k=60) with an adaptive lexical guard (top1 titleExact or tokenHits>=8
  keeps the lexical order): pooled P@3 61.25% (98/160), exact 96.9 preserved,
  paraphrase 84.4, cross-lingual 21.9, concept 59.4, deictic 43.8.
- without the adaptive guard the same fusion drops exact to 87.5, so the guard
  is part of the design, not an optimization.

Gate simulation over hybrid top3 shows a remaining problem: title/phrase exact
evidence almost never fires on whole-sentence prompts, so the gate is driven by
token hits. exact-or-token>=6 gives in-gate precision 39.8% and no-answer FPR
5.0%; token>=8 gives 58.6% and 0%. Phase 2 therefore raises the gate to
title/phrase OR token-hits>=max(6, floor) and adds a near-miss tier for
semantic-only candidates. That is a separate spec section but the constants
are chosen here to avoid re-tuning twice.

## 2. Goals

G1. Add a third retrieval engine, hybrid, that keeps the lexical candidate
    generation intact and adds a dense candidate channel behind an explicit
    opt-in provider. Default behaviour stays lexical; a missing or broken
    provider must degrade to lexical, never fail the request.
G2. Measure the same frozen corpus in lexical and hybrid mode with the same
    harness; the acceptance numbers are in section 10.
G3. Cache note embeddings under the data root, keyed by vault and model, so a
    re-index or a vault edit only re-embeds changed notes.
G4. Keep context cost roughly flat: the injected brief/recall budget does not
    change; only the ordering of candidates changes, plus optional context
    text for deictic prompts (not injected, used as the dense query only).

## 3. Non-goals

N1. No change to the lexical engine, its SQL, its BM25 weights, or its
    signals. A lexical replay must stay byte-identical.
N2. No remote providers, no cloud embeddings, no API keys. Only literal
    loopback endpoints (127.0.0.1 / ::1) already enforced by
    lib/retrieval-provider.js.
N3. No automatic re-embedding on every write in this phase; the store warms in
    the background and refreshes lazily.
N4. No distillation prompt change, no write-side retrieval fields (that is the
    Phase 3 write-side retrieval surface), no gate threshold change in this
    spec beyond what section 10 states.
N5. No new runtime dependency: embeddings arrive over HTTP from a local
    process; the plugin only does cosine math and JSON/SQLite caching.


## 4. Design

### 4.1 Config surface

lib/config.js gains:

- retrievalEngine: existing enum extends to lexical | sparse | hybrid.
- retrievalProvider: { enabled: false, endpoint: "", model: "", dimensions: 0,
  timeoutMs: 500, rerank: false }. endpoint must be loopback when enabled.
  dimensions must be a positive integer when enabled, 384 for e5-small.
- A hybrid engine with no enabled provider is a configuration error
  (invalid-config) rather than a silent lexical fallback; a hybrid engine with
  an enabled provider that is unreachable at runtime is a lexical fallback
  with a diagnostic reason.

Defaults leave every existing install byte-identical: retrievalEngine stays
lexical, retrievalProvider stays disabled, no network code runs.

### 4.2 Provider contract

lib/retrieval-provider.js already speaks POST <endpoint>/embed with
{ model, texts } and expects { model, dimensions, vectors }. It gains one
optional field, kind: "query" | "passage", sent only when the caller passes it
explicitly, so the existing test that asserts the exact body keeps passing for
callers that do not. e5-family models need "query: " and "passage: " prefixes;
the prefix itself stays the server's job (the plugin sends kind, not text
prefixes), because the model name is a provider detail.

Error mapping stays provider-* and must never include the embedded text:
provider-disabled, provider-loopback-only, provider-unreachable,
provider-timeout, provider-invalid-response, provider-dimension-mismatch.

### 4.3 Embedding store (new module lib/embedding-store.js, layer L1)

File path: <dataRoot>/index/embeddings-<vaultTag>-<modelTag>-<dim>.json
where vaultTag = sha256(realpath(vaultRoot)).slice(0,16) and modelTag =
sha256(model).slice(0,16). Format:

{ "version": 1, "model": "...", "dimensions": 384, "vaultRootHash": "...",
  "generatedAt": "ISO", "vectors": { "<note path>": [float, ...] } }

Sync algorithm:
1. Open the file if it exists and the header matches model/dimensions/vault
   hash; otherwise start empty (a corrupt or mismatched file is removed and
   rebuilt, never merged).
2. Enumerate candidate notes through a new index method candidateNotes({
   scope, type, statuses }) that reuses the same SQL filters as search, so the
   store contains exactly the notes search can return (project scope by
   default; all scope for the CLI warm path).
3. For each note, compare the note hash reported by the index with the hash
   recorded in the store; embed only changed or new notes, batch up to 16
   texts, truncate each text to 1200 code points (title plus newline plus
   body, same convention as the offline experiment).
4. Write atomically through lib/fs-atomic.js. Keep entries for notes that no
   longer exist out of the file on the next full sync.
5. Loading for query time reads the JSON once per process and keeps the
   vectors in memory (1089 x 384 x 4 bytes is about 1.7 MB); refresh notes the
   mtime and reloads only if the file changed.

The format is JSON rather than SQLite on purpose: it works with both index
backends (sqlite and scan), it is inspectable, and 1.7 MB is small enough that
a full load is cheaper than a query. A sidecar hash map is not needed because
note hash lives in the value.


### 4.4 Candidate enumeration (lib/index-db.js)

candidateNotes({ scope, type, statuses }) returns the same columns search
already selects: path, title, type, status, hash, updated, project, body. It
must reuse resolveScope filters exactly; a unit test asserts that
candidateNotes filtered by project returns exactly the paths that a lexical
search with a matching query can return (superset check by set equality on a
small fixture).

### 4.5 Hybrid search (new module lib/hybrid-search.js, layer L2)

hybridSearch({ lexicalTop, denseTop, availablePaths, limit }) is pure and
testable:

1. ShouldKeepLexical(top1): true when the top lexical hit has titleExact or
   titleContains or phraseContains or tokenHits >= 8. Then return lexicalTop
   in order, with no embedding call at all (the guard avoids both fusion drift
   and provider cost on queries that already have a literal anchor).
2. Otherwise weighted RRF over two rankings: lexicalTop (weight 1.0) and
   denseTop (weight 2.0), k = 60. Score = sum over rankings of weight /
   (k + rank + 1). Ties break by lexical rank, then path.
3. Dense candidates that are not in lexicalTop become hits whose body is read
   from the index candidate map (already in memory from the embedding sync),
   signals contain semantic-score and hybrid-rank.
4. Return at most limit hits in fused order. If denseTop is empty (store
   warming, provider error) return lexicalTop unchanged.

Dense ranking: cosine over the in-scope vector set. Store vectors are already
normalized by the provider; hybrid-search still normalizes defensively. Top 50
by cosine, then RRF; the offline experiment showed that increasing dense
weight beyond 2.0 starts to displace exact hits and does not improve pooled P@3.

### 4.6 Wiring

- lib/services.js: services.search resolves engine hybrid; when the engine is
  hybrid it asks the hybrid path with the same scope/type/status filters. The
  hybrid path itself calls lexical search first through the existing
  searchNotes lexical branch and then index.candidateNotes plus the embedding
  store and provider. The provider client and store are created once per
  project service instance and disposed with it. A background warm starts on
  first successful index open; recall never blocks on the first warm and falls
  back to lexical with reason store-warming.
- lib/prompt-recall.js: gains an optional context string (the previous user
  turn, capped at 400 code points). The lexical query stays queryFor(prompt);
  the dense query becomes prompt + newline + context when context exists, so a
  deictic prompt like 继续修那个 can still retrieve by its resolved subject.
  The gate (useful) is unchanged in this phase except section 10 item 4.
- lib/hooks.js: records the previous prompt in session state for the context
  above; resets on session start.
- lib/services.js projectHits/scoreSignalsOf: add the new signal names to the
  allowlist (semantic-score, hybrid-rank, hybrid-fallback:<reason>) so the
  model and diagnostics can see why a hit was returned.

### 4.7 Diagnostics

The search event already records outcome, hits and ms. It gains engine
(lexical | sparse | hybrid), denseCandidates (count), embedMs (count), and
fallback (reason string, empty when none). No query text, note ids or note
paths are recorded, matching the existing privacy rule. prompt-recall records
the hybrid fallback reason in the recall event so a silent lexical week is
visible.


### 4.8 Migration

None for the vault. The store is created under the data root on first hybrid
run; deleting it is safe. Existing installs never touch the new code path
until both retrievalEngine is hybrid and retrievalProvider.enabled is true.
A config with hybrid but no provider fails validation at load, with a message
naming both keys.

## 5. Token and context budget

- Brief: unchanged (6000 code points).
- Prompt recall: unchanged (900 chars, 3 hits max). Hybrid changes ordering,
  not the amount injected.
- New model-visible text: none. semantic-score and hybrid-rank appear only in
  tool result scoreSignals, which are already part of search results.
- The dense query uses prompt plus previous turn, capped at 1200 code points
  for the provider call and never injected.
- Provider request body stays under the existing 1200-char per-text limit and
  16 texts per embed batch.

## 6. Compatibility and safety

- No new runtime dependency. node:sqlite is untouched; the store is JSON.
- Old Node floor is unchanged.
- Loopback-only enforcement and the no-redirect, 1 MB response cap stay in
  retrieval-provider.js.
- The provider never sees more than the note text already stored in the vault
  and the user prompt already sent to the model provider; both stay on the
  machine because the endpoint is loopback.
- No change to write paths, transactions, the lock, or the vault. A failed
  hybrid search never writes.
- Existing lexical and sparse replays must stay byte-identical: the harness
  replay gate runs in lexical mode on the frozen snapshot after the change.

## 7. Alternatives considered

A1. Replace the lexical engine with dense. Rejected: exact queries regress
    (P@1 0.531 vs 0.906) and the plugin would need a vector path in the index.
A2. RRF without the lexical guard. Rejected: exact P@3 drops from 96.9 to
    87.5, violating the no-class-decrease rule.
A3. Linear score blending. Measured worse than weighted RRF on the same data
    (pooled P@3 below 53%).
A4. Write-side retrieval fields first (the Phase 3 B route). Still valuable
    and now planned after hybrid because its measured gain is smaller (+5 to
    +8 pp) than the dense channel (+16.9 pp pooled) and it needs 1098 notes
    re-distilled before any gain appears.
A5. sqlite-vec or a native vector index. Rejected for now: an extra extension
    with platform builds, while brute-force cosine over 1089 vectors is
    under 1 ms in Node.

## 8. Acceptance criteria

A. Lexical replay on vault-2026-11-02 is unchanged: 0 path / gate / floor
   differences and pooled P@3 44.4%.
B. Hybrid corpus run on the same corpus reaches pooled P@3 >= 60%
   (96/160 or better), exact >= 96.9% (no drop), no class drops more than
   3 pp, in-gate precision >= 35%, no-answer FPR <= 25%, p50 latency
   <= 1.5x the lexical baseline (350 ms).
C. The same corpus run with provider disabled equals the lexical baseline
   exactly.
D. Provider error paths return lexical results and record a fallback reason;
   a unit test drives timeout, unreachable, invalid response and dimension
   mismatch.
E. A note edited between two syncs is re-embedded once; an unchanged vault
   triggers zero embed calls on the second sync.
F. Config validation rejects hybrid without an enabled provider and rejects a
   non-loopback endpoint.
G. Repo gates: npm run check (lint, format, types, full suite, pack) is green;
   architecture budgets updated for every changed module; tarball asset count
   re-measured if lib module count changes.

## 9. Risks and rollback

R1. e5-small cosine is poorly separated at the top of the distribution
    (gold p50 0.897 vs non-gold p50 0.882 in the gate simulation). Mitigation:
    hybrid never relies on a cosine threshold for injection; Phase 2 only uses
    cosine for a near-miss hint. Rollback: keep retrievalEngine lexical.
R2. The local provider is not running on a fresh machine. Mitigation: engine
    hybrid is opt-in, fallback is lexical and visible in diagnostics. Rollback:
    set retrievalProvider.enabled false, no restart of the vault needed.
R3. Embedding cost on large vaults. Mitigation: hash-based incremental sync,
    16-text batches, first warm in the background. Rollback: delete the store
    file, nothing else depends on it.
R4. Cross-lingual stays weak (21.9%). This spec does not claim to fix it;
    Phase 2 near-miss and a stronger model are the follow-ups.
R5. A stale store serves removed notes. Mitigation: candidate set comes from
    the live index (candidateNotes), so a removed note cannot be returned even
    if its vector is still in the file; the next full sync prunes it.

## 10. Open questions

Q1. Should prompt-recall pass the full prompt as the dense query instead of
    the truncated lexical query? The offline experiment used the full prompt
    and the product must match it; confirm with the corpus run.
Q2. Does the deictic context need more than one previous turn? Measure with
    context lengths 1 and 2 on the 40 deictic queries before Phase 2.
Q3. Is a rerank call worth adding once the candidate channel exists? Deferred
    to Phase 2; the provider already exposes rerank.
