# Sparse retrieval (Phase B) — validation record

**Date:** 2026-10-27
**Branch:** `feat/memory-v3` (base `7295de1`), plan
`docs/superpowers/plans/2026-10-27-v4-remaining-implementation.md` Task 3, spec
`docs/superpowers/specs/2026-10-27-memory-v4-design.md` §5.
**Agent:** `retrieval` (task-3). No commits made by the agent; the Lead owns
integration and the final gate.
**Status:** DONE_WITH_CONCERNS — the deterministic sparse baseline is wired and
measured; **semantic retrieval is UNVERIFIED** (no embedding/rerank provider was
configured, selected or contacted, and none is reachable from the config schema).

## What this record is

The honest measurement behind `retrievalEngine: 'sparse'`: a fixed local fixture,
ten-plus queries in three groups, and grouped Recall@3 / MRR@3 / false injection
plus p50/p95 latency for **lexical vs sparse** on the same index and the same
machine. It is *not* a semantic-retrieval evaluation. Sparse ranks the same
CJK-bigram/Latin-word terms the lexical index uses; it can reorder a bounded
lexical candidate set, it cannot understand a synonym the lexical index did not
find.

## What was implemented (Phase B)

- `lib/config.js`: `retrievalEngine: lexical|sparse`, default `lexical`. Unknown
  keys are refused as before (including `retrievalengine`, `retrieval.engine`);
  `semantic` is deliberately **not** a schema value because no provider has been
  selected.
- `lib/search.js`: `searchNotes(index, { engine })`. The default path is
  byte-identical (same single `index.search` call — asserted by a test). The
  `sparse` path:
  1. retrieves at most **24** lexical candidates (`SPARSE_MAX_SOURCES`),
  2. re-reads each candidate's source with `readNote` and keeps only candidates
     whose sha256 still equals the index hit's hash (**source-verified**),
  3. chunks the text into at most **1,200**-code-point chunks and builds at most
     **256** ranker records, selected round-robin by chunk index
     (`SPARSE_MAX_RECORDS`),
  4. `rankSparse` (TF-IDF + cosine, Phase A) ranks the records; a note takes its
     best chunk's position,
  5. fuses the lexical and sparse note orders with **RRF k=60**, then breaks
     equal fused scores by an **exact title/alias** match and finally by path,
  6. falls back to the lexical order (reporting why on the result array) when the
     vault root is unavailable, no candidate is source-verified, or the query has
     no sparse term (a lone CJK character).
- `lib/services.js` (Lead-owned): one pass-through line,
  `engine: config.retrievalEngine` in the `services.search` call. Verified by the
  tool-level test listed below.
- Kept from Phase A unchanged: `lib/retrieval-rank.js` (only its tokenizer import
  moved to Lead's new `lib/index-text.js` leaf, and the exact-name fold became an
  additive export so search and ranker share one definition), and
  `lib/retrieval-provider.js` (disabled by default, no egress, untouched).
- **No `lib/vector-index.js` was added.** The sparse baseline reranks lexical
  candidates and needs no vector cache; a vector index would only be justified by
  the semantic option, which has no selected provider.

## Fixture

23 notes in one project, created in a `mkdtemp` vault; the fixed data lives inline
in `test/search-engine.test.js` (`MEASUREMENT_NOTES`, `MEASUREMENT_QUERIES`) so the
focused cases and the measurement cannot drift. Nothing touches a real vault,
`~/.dsh`, `$DSH_HOME` or the network.

| # | note | type | role |
|---|---|---|---|
| 1 | `Docs/retry-backoff.md` "重试退避" | doc | dev target |
| 2 | `Decisions/retry-idempotent.md` "重试必须幂等" | decision | dev/paraphrase target |
| 3 | `Pitfalls/cache-hash.md` "缓存失效按内容哈希" | gotcha | dev target |
| 4 | `Conventions/hot-capacity.md` "热点文件容量" | convention | dev target |
| 5 | `Docs/scheduler-window.md` "调度器窗口" | doc | distractor material |
| 6 | `Docs/cache-size.md` "缓存大小" | doc | distractor |
| 7 | `Conventions/hash-naming.md` "文件名使用内容哈希" | convention | distractor |
| 8 | `Docs/panel-render.md` "面板重绘" | doc | paraphrase target |
| 9 | `Conventions/panel-focus.md` "面板命中区域" | convention | filler |
| 10 | `Decisions/index-backend.md` "索引后端默认 sqlite" | decision | filler |
| 11 | `Conventions/vault-binding.md` "绑定指针只在仓库根" | convention | distractor |
| 12 | `Pitfalls/journal-recovery.md` "事务中断后按日志恢复" | gotcha | distractor |
| 13 | `Docs/token-budget.md` "提示词预算" | doc | distractor |
| 14 | `Decisions/distill-route.md` "蒸馏必须显式配置" | decision | filler |
| 15 | `Conventions/config-unknown.md` "未知配置键直接拒绝" | convention | distractor |
| 16 | `Docs/panel-search.md` "面板搜索框" | doc | distractor |
| 17 | `Docs/graph-render.md` "图谱渲染" | doc | distractor |
| 18 | `Conventions/habit-clause.md` "用户习惯只在明确陈述时记录" | convention | distractor |
| 19 | `Docs/delivery-receipt.md` "投递回执" | doc | filler |
| 20 | `Methods/backoff-method.md` "Methods 退避策略" | method | distractor |
| 21 | `Decisions/retry-policy.md` "重试决策" | decision, fresh | type-weighted distractor |
| 22 | `Docs/jitter-sample.md` "抖动采样" | doc | rare-term-only distractor |
| 23 | `Docs/backoff-jitter.md` "退避抖动" | doc | dev target (both terms) |

Queries (11; `target = null` means no note in the fixture answers it):

| group | query | target |
|---|---|---|
| development | 指数退避 | retry-backoff |
| development | 内容哈希 缓存 | cache-hash |
| development | 热点文件 压缩 | hot-capacity |
| development | 幂等 重试 | retry-idempotent |
| development | 重试 抖动 | backoff-jitter |
| **paraphrase (held out)** | 错误反复出现时暂停多久 | retry-backoff |
| **paraphrase (held out)** | 写操作提交两次会不会执行两遍 | retry-idempotent |
| **paraphrase (held out)** | 页面刷新时如何避免跳动 | panel-render |
| **paraphrase (held out)** | 长时间不用之后体积怎么缩小 | hot-capacity |
| distractor | 缓存目录放在哪个磁盘分区 | none |
| distractor | 调度器的端口号是多少 | none |

## Exact command and output

```sh
node --test --test-name-pattern='measurement' test/search-engine.test.js
```

(No `DSH_HOME` needed: `openIndex` is given an explicit `mkdtemp` vault and data
root. The command was run in the repository root on Node v25.9.0.)

```text
measurement: fixed local fixture, 11 queries, limit=3, engine=sparse|lexical
group        engine   Recall@3  MRR@3   false-injection@3  (queries)
development  lexical  1.000     0.867    2.000               (5)
development  sparse   1.000     0.900    2.000               (5)
paraphrase   lexical  0.000     0.000    1.750               (4)
paraphrase   sparse   0.000     0.000    1.750               (4)
distractor   lexical  n/a       n/a      2.000               (2)
distractor   sparse   n/a       n/a      2.000               (2)
latency      lexical  p50=2.55ms p95=4.08ms (n=121)
latency      sparse   p50=4.85ms p95=7.97ms (n=121)
held-out-overlap "错误反复出现时暂停多久" shared-tokens=0 []
held-out-overlap "写操作提交两次会不会执行两遍" shared-tokens=0 []
held-out-overlap "页面刷新时如何避免跳动" shared-tokens=0 []
held-out-overlap "长时间不用之后体积怎么缩小" shared-tokens=0 []
query development  "指数退避"
  lexical: Docs/retry-backoff.md > Docs/backoff-jitter.md > Methods/backoff-method.md
  sparse : Docs/retry-backoff.md > Docs/backoff-jitter.md > Methods/backoff-method.md
query development  "内容哈希 缓存"
  lexical: Pitfalls/cache-hash.md > Conventions/hash-naming.md > Pitfalls/journal-recovery.md
  sparse : Pitfalls/cache-hash.md > Conventions/hash-naming.md > Docs/cache-size.md
query development  "热点文件 压缩"
  lexical: Conventions/hot-capacity.md > Conventions/hash-naming.md > Pitfalls/cache-hash.md
  sparse : Conventions/hot-capacity.md > Conventions/hash-naming.md > Docs/token-budget.md
query development  "幂等 重试"
  lexical: Decisions/retry-idempotent.md > Decisions/retry-policy.md > Docs/retry-backoff.md
  sparse : Decisions/retry-idempotent.md > Decisions/retry-policy.md > Docs/retry-backoff.md
query development  "重试 抖动"
  lexical: Decisions/retry-policy.md > Decisions/retry-idempotent.md > Docs/backoff-jitter.md
  sparse : Decisions/retry-policy.md > Docs/backoff-jitter.md > Decisions/retry-idempotent.md
query paraphrase   "错误反复出现时暂停多久"
  lexical:
  sparse :
query paraphrase   "写操作提交两次会不会执行两遍"
  lexical: Pitfalls/journal-recovery.md > Docs/panel-search.md
  sparse : Docs/panel-search.md > Pitfalls/journal-recovery.md
query paraphrase   "页面刷新时如何避免跳动"
  lexical: Conventions/config-unknown.md > Conventions/habit-clause.md > Docs/graph-render.md
  sparse : Conventions/config-unknown.md > Docs/graph-render.md > Conventions/habit-clause.md
query paraphrase   "长时间不用之后体积怎么缩小"
  lexical: Pitfalls/cache-hash.md > Docs/cache-size.md
  sparse : Docs/cache-size.md > Pitfalls/cache-hash.md
query distractor   "缓存目录放在哪个磁盘分区"
  lexical: Conventions/vault-binding.md > Pitfalls/cache-hash.md > Docs/cache-size.md
  sparse : Conventions/vault-binding.md > Docs/cache-size.md > Pitfalls/cache-hash.md
query distractor   "调度器的端口号是多少"
  lexical: Docs/scheduler-window.md
  sparse : Docs/scheduler-window.md
semantic: UNVERIFIED — no embedding/rerank provider is configured; no network or model was called.
```

The test runner echoes the same lines a second time as `ℹ` diagnostics; the block
above is the one true copy. It is verbatim except that the trailing spaces on the
two empty per-query lines (`lexical:` / `sparse :`) are not reproduced.

## Findings

1. **No grouped relevance regression.** Development Recall@3 is 1.000 for both
   engines and the development MRR@3 **improves** 0.867 → 0.900. The improvement is
   one query: "重试 抖动" — lexical puts the type-weighted/fresh distractor
   `Decisions/retry-policy.md` first and the correct `Docs/backoff-jitter.md`
   third, while sparse's IDF weighting puts the target second. Every other
   development query keeps its order.
2. **False injection does not increase.** Development and paraphrase groups return
   the same number of irrelevant notes in their top 3 for both engines
   (2.000 and 1.750 per query); the distractor group returns 2.000 for both, i.e.
   both engines still return notes for unanswerable queries — the measurement
   reports that honestly instead of hiding it. Sparse changes order, not the
   candidate set, so it cannot invent a result the lexical search did not find.
3. **Held-out paraphrases gain nothing.** All four held-out queries share **zero**
   index tokens with their target's title/body, so the lexical index cannot find
   the target at all; both engines score Recall@3 = 0.000 and MRR@3 = 0.000 on the
   group. **This is the expected result for a lexical method: the group measures
   that sparse is not semantic, not that it is worse.**
4. **Latency.** Warm, 121 samples per engine: lexical p50 2.55 ms / p95 4.08 ms,
   sparse p50 4.85 ms / p95 7.97 ms. Sparse costs roughly one extra
   source-verified read per candidate (24 notes on this fixture) plus a wider
   index candidate window, so ~2x p50 is the expected shape. A second run made
   while other agents were testing on the same machine measured
   lexical p50 21.92 / p95 84.19 ms and sparse p50 29.16 / p95 75.95 ms, so these
   numbers are **indicative, not a controlled benchmark** — this is a shared
   single machine and a 23-note fixture, not a production vault.

## Semantic retrieval: unverified

- No embedding or rerank provider was configured, selected, installed or
  contacted; the config schema has no `semantic` value and
  `lib/retrieval-provider.js` remains disabled by default with zero egress.
- No model, network call, download or new dependency was used for this record.
- Therefore **no synonym/paraphrase quality claim is made**. Promoting semantic
  retrieval still requires a separate human choice of provider/endpoint, a
  measured held-out synonym gain, and provider-byte accounting — none of which
  happened here.

## Limitations (stated, not hidden)

- 23 notes / 11 queries / one query set — this is a sanity baseline, not the
  spec's 48-query replay; it cannot establish statistical significance.
- One machine, one Node version (v25.9.0), one index backend (`sqlite`); the
  `scan` backend was not measured for latency.
- Sparse only reranks a bounded lexical candidate window, so recall is capped by
  the lexical index by construction.
- A match past the 256-record chunk budget is not seen by the sparse side; the
  note keeps its lexical rank only.
- Latency was sampled while three other agents shared the machine; the two runs
  above differ by ~8x in p50, which is why the record quotes both.

## How to reproduce

```sh
node --test test/search-engine.test.js                     # 11/11 behaviour + measurement
node --test test/config.test.js                            # engine schema + unknown keys
node --test test/retrieval-rank.test.js test/retrieval-provider.test.js
```

The fixture is inline in the test file; the measurement case fails if sparse's
grouped Recall@3/MRR@3 drops below lexical's or if it injects more notes for the
unanswerable queries.
