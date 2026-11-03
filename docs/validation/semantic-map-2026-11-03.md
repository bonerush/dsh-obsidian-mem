# Semantic map — real-vault acceptance (2026-11-04)

Record of the Task 11 acceptance run for the semantic-map design
(`docs/superpowers/specs/2026-11-03-semantic-map-design.md`). It ran on the
author's machine, against the real vault, at the code state of commit
`b0eeab2` (Tasks 1-9) plus the Task 10 documentation changes.

## Environment

| Fact | Value |
|---|---|
| Host / time | macOS, 2026-11-04 00:13–00:15 Asia/Shanghai |
| Node | the worktree's pinned toolchain (`npm ci` at `282b5ce`) |
| Vault | `/Users/yukisala/Documents/dsh-memory` (project `dsh-obsidian-mem--05025725`, 1,417 Markdown files under `Projects/`) |
| Embedding store | `~/.dsh/data/obsidian-mem/index/embeddings-11efec180ba514d0-caa978c0b35471f1-1024.json`, 14,088,174 B, 1,422 vectors, 1,024 dimensions |
| Provider | `curl http://127.0.0.1:8790/health` → `{"status":"ok","model":"Qwen/Qwen3-Embedding-0.6B","dimensions":1024,"device":"mps","attention":"sdpa","maxTokens":512,"queryInstruction":true,"pid":53096}` |
| Panel | **not** exercised in a browser: the live DSH instance still mounts the installed 2.0.2 plugin, and installing this worktree into the user's host was not allowed by the "never edit a user's configuration" rule. All browser-only claims below are marked unverified. |

The probe is a throwaway Node script under `/tmp`; it imports `lib/` directly
through the same `createMemoryServices` / `validateConfig` seams the plugin uses
and passes the real vault, data root and project binding. No file under the
vault, the repo or `~/.dsh/data/obsidian-mem` was written by the probe.

## 1. Semantic map: first call vs cached call

Command: `node /tmp/semantic-acceptance.mjs` (trimmed output).

```json
{"step":"semanticMap","firstMs":1315,"secondMs":11,"bytes":174915,
 "state":"ready","count":1422,"total":1422,
 "explained":0.0913,"mapKey":"1793719895796-14088174-1422","points":1422}
```

- `state: ready` with `count === total === 1422`: the map covers every embeddable
  note, so it is a complete projection, not a silent partial one.
- The second call took **11 ms**, showing the projection cache (store identity +
  note count) works.
- The first call took **1,315 ms**, not the ≤300 ms budget in spec §4.9. It
  includes opening the index handle, `waitReady()`, parsing the 14 MB embedding
  JSON, and the 24 PCA iterations over 1,422 × 1,024 floats. The budget was
  written for the PCA itself; this measurement is end-to-end and does not
  separate the phases, so the honest statement is: **end-to-end first call
  1.3 s, cached 11 ms**.
- The payload is **174,915 B**, not the ≤48 KB budget in spec §4.9. At 1,422
  notes the vault-relative path strings dominate the JSON; coordinates are
  already quantized to 0–4095. Over loopback the transfer is still trivial, but
  the byte contract is **not met** as written.
- `explained` is **0.0913**: the first two principal components cover ~9% of the
  variance. The card must show this number rather than implying the 2-D map is a
  faithful summary.

## 2. Paraphrase replay: embedding changes the answer

Query 「为什么发布总是卡住」, `services.explainSearch({binding, query, sessionId:'acceptance'})`:

```json
{"source":"panel","engine":"hybrid","guard":false,"fallback":null,
 "denseCandidates":50,"embedMs":520,"tookMs":696,
 "counts":{"lexical":50,"dense":19,"fused":8}}
```

- `denseOnly: 1` — one fused hit has `lexicalHit: false`, i.e. the lexical
  channel never proposed it and only embedding put it in the result:
  `Pitfalls/取消发布 run 与发布步骤存在竞态.md`, dense rank 1, cosine 0.5476,
  fused rank 8.
- `promoted: 7` — seven fused hits outrank their lexical position. Top example:
  `Decisions/ADR-237-面板操作结果显示在按钮所属卡片内.md`, lexical rank 23 →
  dense rank 2 → fused rank 1 (cosine 0.4962). This is exactly the "embedding
  improved the pure-text search" evidence the feature exists to show.
- `embedMs: 520` and `tookMs: 696` are above the spec's ~99 ms / ≤350 ms
  loopback figures; the first query after a cold provider call on this machine
  paid model latency. A second run was not recorded, so this is **one run, not
  a p50** (see §6).

## 3. Exact-title replay: the lexical guard still wins

Query `ADR-266 决策：obsidian-mem 检索引擎设为 hybrid`:

```json
{"guard":true,"source":"panel",
 "fusedTop":[
  {"path":"…/Decisions/ADR-266-决策：obsidian-mem 检索引擎设为 hybrid.md",
   "lexicalRank":1,"denseRank":null,"semanticScore":null,"hybridRank":1,"lexicalHit":true},
  {"path":"…/Decisions/index.md","lexicalRank":2,"denseRank":null,"hybridRank":2,"lexicalHit":true},
  {"path":"…/Decisions/ADR-260-hybrid 检索通道保持 opt-in 默认关闭.md",
   "lexicalRank":3,"denseRank":null,"hybridRank":3,"lexicalHit":true}
]}
```

`guard: true` and no dense ranks: the adaptive guard kept the lexical order for a
title-exact query, and the card should render the guard state (embedding
deliberately not used). This matches the 2026-11-02 calibration.

## 4. Semantic neighbours

`services.semanticNeighbors({path: 'Projects/dsh-obsidian-mem--05025725/Conventions/回归测试断言不变量而非字面字符串.md'})`
returned `state: ready`, 8 neighbours, top cosine 0.5867
(`Conventions/改动交付前的红-绿验证与全量闸门.md`). This is the panel's
"semantic neighbours" surface exercised at the service layer; the DOM inspector
was not opened (see the panel row above).

## 5. Provider failure falls back to lexical

Instead of stopping the user's LaunchAgent, the probe used a second service
instance pointed at a closed loopback port (`http://127.0.0.1:8791`):

```json
{"step":"provider-unreachable-map","state":"ready"}
{"step":"provider-unreachable-explain","fallback":"provider-error","guard":false,
 "denseTop":0,
 "fusedTop":[{"path":"…/Decisions/ADR-240-….md","source":"lexical","lexicalRank":1,"denseRank":null,"semanticScore":null,"hybridRank":1,"lexicalHit":true}, …]}
```

The map stays `ready` because it is built from the store, not from the provider;
the replay falls back to the lexical order with `fallback: "provider-error"` and
no dense candidates. That is the designed D6/§4.8 behaviour (read-only map,
degrade to lexical explanation), exercised with an unreachable endpoint rather
than by stopping the real server.

## 6. Vault and data-root cleanliness

- `git status --short` in the vault lists 8 modified files, all with mtimes
  between 22:26 and 23:49 on 2026-11-03 — **before** the probe started at 00:13.
  The probe added no vault writes; the dirt is pre-existing user/Obsidian state.
- `~/.dsh/data/obsidian-mem/` kept the same top-level entries
  (`curation`, `cursors`, `delivery`, `diagnostics`, `index`, `locks`,
  `pending`, `receipts`, `transactions`) and the index directory kept the same
  four files. The probe created no new file name there.

## 7. Deviations and unverified items

**Not met, recorded rather than hidden:**

1. First `semantic` call 1,315 ms vs the ≤300 ms design budget (end-to-end,
   includes index open + 14 MB store parse + PCA).
2. Semantic payload 174,915 B vs the ≤48 KB design budget at 1,422 notes.
3. `embedMs` 520 ms / `tookMs` 696 ms on the one paraphrase run, vs the ~99 ms /
   ≤350 ms figures in the spec's loopback notes.
4. `explained` 0.0913 means the 2-D cloud is a weak global summary; the card copy
   must keep telling that truth.

**Unverified (no claim made):**

- The browser surface: switching link ↔ semantic, the recall overlay painter,
  the explanation card states (idle/hybrid/guard/provider-disabled/warming) and
  reduced-motion behaviour. The live panel mounts 2.0.2, not this branch; no
  screenshots were taken.
- The `provider-disabled` card state with a genuinely disabled provider: the
  probe only exercised an unreachable provider (`provider-error`).
- A repeat of the paraphrase query to report a p50 rather than one reading.
- Real-vault behaviour above 1,422 notes (the payload/latency trend is not
  extrapolated here).

All of these are recorded in `CHANGELOG.md` as measured-with-deviations or as
unverified; none is written as passing.
