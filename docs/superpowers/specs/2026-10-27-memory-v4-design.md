# Memory v0.4 — delivery receipts, rotation, digest, maintenance, and optional semantic retrieval

**Status:** approved 2026-10-27, staged. The digest read contract and its owned writer are implemented; delivery receipts, rotation, panel mutations and sparse/semantic retrieval remain unlanded. No semantic provider was selected, so semantic evaluation stays unverified.
**Scope:** all requested v0.4 deferrals; complete v0.3 acceptance independently first.
**Evidence:** [v0.3 design](2026-10-26-memory-v3-design.md), [retrieval design](2026-10-05-memory-retrieval-efficiency-design.md), [architecture audit](../../../research/codex-architecture-audit-2026-10.md), [host facts](../../p0-compatibility.md), [Codex hook measurements](../../codex-hook-validation.md). Current source was inspected with CodeGraph and focused reads; the audit's historical findings are not assumed still present.

## Recommendation and boundaries

Implement the shared delivery/state contracts first, then digest and confirmed maintenance, then retrieval evaluation. Recommend a deterministic sparse reranker as the measured baseline and an optional, explicitly configured local embedding service for genuine semantic candidates. Keep lexical retrieval as the default until the quality gate passes; install/download nothing automatically. Remote inference requires a separate explicit data-egress decision.

Markdown remains authoritative. Six tool names, existing default call shapes, Node floor, and runtime dependency budget remain unchanged. No automatic semantic merge, curation approval, arbitrary panel write, LLM digest, or claim that stored hot capacity equals resident model context. Policy belongs in `lib/`; DSH/Codex adapt events and protocols only.

## 1. Acknowledge actual hot delivery

Add `lib/hot-delivery.js` (pure selection/diff) and `lib/delivery-state.js` (private bounded persistence). Extend `buildBrief`/composition with `delivery: {emitted:[{id,version}], removed:[{id,previousVersion}], omitted, oversized, continuation}`. `version` hashes the complete injectable unit, including zone; the full current `hotItems` snapshot never proves delivery.

Internal shared interfaces:

```text
prepareDelivery({binding,sessionKey,epoch,budget}) -> {text,receipt,continuation}
ackDelivery(receipt,proof) -> {acknowledged,duplicate,conflict}
```

`receipt` contains a random delivery ID, final message hash, exact emitted/removal identities and optional rotation revision; no text. Persist preparation before returning output. Advance only the units present in that final message, after observing successful host insertion. Navigation truncation cannot block hot acknowledgement.

DSH acknowledges the corresponding committed producer-owned `session/event` message, rather than `plan.commit()` during waterfall assembly. Codex treats successful stdout writing as **pending**: the next trusted hook reconciles the exact delivery marker/hash against structured `hooks.additional_context` developer messages in its own supplied transcript. Reuse the existing 8 MiB read ceiling; quoted tool output cannot acknowledge. Missing/unreadable/over-cap evidence means unacknowledged, allowing repetition. Native probes must validate both receipts before delivery is called complete.

Select constraints before active units; skip/report an oversized unit and continue fitting later units. After the first brief, allow at most two automatic continuations per unchanged hot generation, at most one per user turn, each within `briefBudgetChars`. Remaining units stay addressable through `mem_brief(section='hot', cursor=...)`. Cursor is bounded to 256 characters and binds project, source hash and next position; changed source returns `stale-continuation` with a fresh handle. Oversized units expose an ID/source-reading route, never silently clipped facts. Explicit page reads do not acknowledge automatic insertion.

Removal notices identify only previously delivered IDs absent from the current injectable set; they withdraw their hot provenance without inventing “resolved” status. Acknowledge removals individually. Changed versions, interrupted preparation, failed insertion, navigation-only omission and unchanged overflow each have independent tests.

Private state lives under `dataRoot/delivery/<vaultHash>/<projectId>/<sessionHash>.json`: schema/epoch, ID/version map, pending receipts and counters; 128 KiB, 512 acknowledged identities, 16 pending receipts, 24-hour pending retention. Overflow resets suppression conservatively and reports degradation. Use private modes, symlink rejection, atomic replacement and a short per-state lock; never hold it across host I/O. Duplicate acknowledgements are idempotent; stale removals cannot erase a newer version. Compaction/clear or uncertain restored context starts a new epoch. These are delivery observations, not proof of later model attention.

## 2. Rotate convention previews across sessions

Add `lib/convention-rotation.js`. In summary mode select five eligible MOC units starting after a persisted anchor; flat mode and explicit paging retain MOC order. Store only schema, revision, inventory fingerprint and hashed anchor under `dataRoot/cursors/<vaultHash>/<projectId>/conventions.json` (8 KiB maximum).

Preparation reads a cursor revision; the delivery receipt records only actually emitted convention units. Successful acknowledgement advances under lock using compare-and-swap. Concurrent sessions may repeat a window; a stale acknowledgement never skips another window. Failure/cancellation leaves the cursor unchanged. Missing anchors resume at the first eligible unit; empty/corrupt state resets safely. Oversized previews remain counted/addressable and cannot be called covered. For a stable inventory whose five selected units fit, all N conventions appear within `ceil(N/5)` serial acknowledged session starts. No fairness promise is made under continuous inventory changes or absent host receipts.

## 3. Deterministic digest and an owned writer

Current code exposes `appraise`, a recent-50 findings action, while the v0.3 design specifies a richer `digest`. Preserve `appraise`; add `mem_admin(action='digest', days=1..30, operation='read'|'refresh')`, default `read`. Extract `lib/digest.js` for bounded collection/rendering and `lib/digest-write.js` for publication.

Return window, current-note created/updated/status counts, type breakdown, hot/queue snapshots, at most eight recent references, and at most twenty deterministic findings. Counts describe observable current records, not reconstructed historical status transitions. Inspect at most 200 source notes under a 500 ms collection deadline; distinguish incomplete collection from no findings. Inject the clock and stable sort order. No model or network call.

`refresh` explicitly creates/updates the project's owned `_meta/digest.md`, at most 8,000 code points including metadata. Reuse existing owned-container identity checks and `runTransaction`; never overwrite a human/unrecognized target. Verify target/source hashes inside the vault lock; conflict requires recomputation. Queue statistics remain a timestamped snapshot because queue and vault publication are different consistency domains. Same input/window fingerprint is a no-op. Exclude generated digest content from digest inputs and automatic fact retrieval to prevent self-amplification. Existing journal/receipt recovery applies; no timer, implicit hook refresh or new source authority.

## 4. Three confirmed panel operations

Extend `panel-route.js` and `memory-panel.js` with preview and confirm actions whose operation enum is exactly `retry-job`, `compact-hot`, `refresh-digest`. The UI shows job identity/state, compaction effects, or digest target/window, then requires a separate confirmation click. No bulk retry or approve/apply endpoint.

Issue a single-use random token with 60-second TTL, bound to session, binding, operation, arguments and preview fingerprint. Commit re-resolves binding and revalidates preconditions in the service's mutation lock; stale previews return `409 preview-stale`. Keep at most 128 tokens per process; duplicate submissions return the existing result/receipt when known. A lost response requires status refresh before another attempt.

Require exact same-origin JSON POST plus the existing loopback/body-size fence; reject missing Origin for mutations. Reuse `services.admin` and its ownership/path/transaction guards. Extend existing service preconditions where needed rather than check-then-write in HTTP code. Retry names one terminally failed job belonging to the displayed project; DSH may wake its worker, while Codex only requeues. Confirmation copy states this difference. The token prevents stale/replayed browser actions; it is not evidence of a cryptographically authenticated human.

## 5. Retrieval alternatives and provider contract

| Approach | Capability and cost | Decision |
| --- | --- | --- |
| A: sparse TF-IDF/cosine over existing CJK/Latin terms; deterministic exact-title/alias tie-breaks | Local vectors and reranking, no model/dependency/egress; still lexical, cannot establish synonym understanding | Implement/evaluate as baseline |
| B: explicitly installed loopback embedding service; optional local reranking service | Genuine semantic candidates, model/storage/latency costs; service must be independently configured and tested offline | Recommended semantic option, pending provider choice |
| C: explicit private/remote endpoint with embedding/rerank contract | Same protocol; note/query text leaves the plugin process and possibly the machine | Disabled unless separately approved |

Add `lib/retrieval-provider.js` (validation/transport), `lib/vector-index.js` (rebuildable cache), `lib/retrieval-rank.js` (sparse/fusion), wired through existing search/services. Proposed config: `retrievalEngine: lexical|sparse|semantic` (default lexical), `reranker: deterministic|service` (default deterministic), and an explicit provider/model fingerprint. A service is never inferred from existing LLM credentials.

Provider methods: `embed({texts,signal}) -> {model,dimensions,vectors}` and optional `rerank({query,candidates,signal}) -> [{id,score}]`. Validate finite dimensions/scores, IDs and model identity. Loopback mode accepts literal loopback addresses only and rejects redirects; remote mode needs an allowlisted endpoint. No default egress, auto-download or new runtime dependency; built-in transport suffices.

Start with source-verified, project-scoped chunks of at most 1,200 code points; 16 per indexing batch, explicit index refresh only. Cache under dataRoot by source hash/chunk/model/tokenizer version, capped at 100 MiB. Missing/stale vectors fall back to lexical. Retrieve at most 24 lexical and 24 vector candidates, fuse ranks with RRF k=60, then verify at most 24 distinct sources. Apply scope/status/type checks again after source changes. Optional rerank sees at most ten candidates/8,000 total text code points. Proposed query deadline: 700 ms across provider stages; timeout/cancellation never triggers remote fallback. Provider text excludes paths and metadata; diagnostics exclude queries, titles, bodies, embeddings and credentials.

## 6. Cleanup, acceptance and rollback

The current `applyCandidate` early proposal return proves its supersede-retry catch tail unreachable; characterize then remove that tail and `SUPERSEDE_REFUSALS`, preserving reviewed supersede. `autoApply`'s stale guard is already removed. Unused vocabularies/test wrappers/internal exports remain candidates until package/bin/facade, browser URLs, callbacks and documented imports are checked. Zero CodeGraph callers alone never authorizes deletion. Canonical-JSON consolidation needs byte-identical hash fixtures.

Decompose into independently reviewed slices: receipt/continuation; rotation; digest; panel; sparse baseline; selected semantic provider; proven cleanup. No implementation plan or code before human design approval.

Acceptance requires red/green behavior tests, fault injection around acknowledgement/publication, restart/concurrency/epoch tests, unchanged-overflow and giant-first fixtures, truthful coverage, CSRF/replay/stale-preview controls, digest ownership/crash recovery, provider-off zero-egress and timeout fallback. Reuse the earlier 48-query split, adding held-out synonym/paraphrase cases and distractors. Report grouped Recall@3/MRR@3, false injection, p50/p95, cold start/cache size, source verification and actual provider bytes. Require no safety regression and no grouped relevance regression versus lexical; semantic promotion additionally requires a measurable held-out synonym gain. Token claims require a tokenizer/host usage, otherwise null.

Run the complete repository gate and isolated native DSH/Codex acceptance; protocol success alone does not prove model receipt. Existing docs, paired READMEs/skills, architecture/type/diagnostic allowlists and real tarball checks move with implementation. Rollback disables optional retrieval, clears derived delivery/cursor/vector state and restores lexical/full delivery; retained owned digests and archives remain readable. No configuration or source-note rollback is automatic.

**Human decisions:** approve these contracts and staged delivery; for executed semantic evaluation choose the local service/model/endpoint or authorize a specific private remote endpoint and text-egress scope. Until that choice, semantic evaluation remains unverified and only the deterministic baseline can be completed.
