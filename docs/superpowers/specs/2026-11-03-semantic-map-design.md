# Semantic map design (embedding visualization in the memory panel)

- Status: reverted 2026-11-05 — implemented (commits 0bed9fd..858b07a), shipped to the
  desktop profile for a real-vault trial, then removed by the owner because the 2D
  cloud did not help them read retrieval and cost too much memory. This spec and its
  plan are kept as the historical record; the embedding search itself (hybrid recall)
  stays untouched.
- Owner: lead
- Scope: the memory panel's graph tab (a layout switch), four new read-only actions on
  the existing `/obsidian-mem/graph` route, and one process-local capture channel for
  recall traces
- Supersedes: none — this spec is additive and read-only; it changes no retrieval
  ranking, no tool output, no diagnostic format and no persisted vault content
- Evidence: `docs/superpowers/specs/2026-11-02-hybrid-recall-design.md`,
  `docs/validation/retrieval-latency-and-semantic-gate-2026-11-03.md`,
  `docs/superpowers/specs/2026-10-28-memory-panel-modern-design.md`, ADR-260/261/266/
  267/268 (vault project `dsh-obsidian-mem--05025725`), and the 2026-11-03
  brainstorming session whose four decisions are recorded in section 3

## 1. Problem and evidence

### 1.1 What the user asked for

Two quotations fix the scope (both are the user's own words from the 2026-11-03
section):

> 我想在当前的可视化界面里加入对 embedding 部分的可视化，但是我现在没有一个很好的方案可以展示出来。并且在调用记忆的时候，用户可以直观地看到，是如何通过 embedding 点来改善原有的纯文本搜索记忆的。

> 我想说如果做了语义地图，那原先的 Obsidian 知识图谱图咋办

The first sentence names the deliverable (a visualization of the embedding space and
of how it changes recall); the second names the constraint that shapes it (the existing
`[[wikilink]]` graph must not be replaced or made to compete with it).

### 1.2 Why today's panel cannot answer it

- The panel's search is lexical only. `lib/panel-route.js:677` calls `index.search`
  directly, not `services.search`, so a panel search never reaches the dense channel.
- The agent path does use embeddings, but the evidence is discarded before any surface
  sees it. `lib/hybrid-recall.js:251-257` drops the fused score, `lexicalRank`,
  `denseRank` and `source`; only `signals.semanticScore` and `signals.hybridRank` reach
  `mem_search` as strings (`lib/services.js:1594-1607`, `:1616-1637`), and
  `denseCandidates`/`embedMs`/`fallback` exist only in the diagnostic ring
  (`lib/services.js:608-626`).
- The persisted diagnostic journal cannot be replayed per candidate, by design:
  `lib/diagnostic-codec.js:141-155` writes only `seq, at, event, outcome, code,
  attempts, ms, hits, chars`, the header keeps five configuration keys, and the
  privacy rule in the hybrid spec (`:190-193`) forbids query text and note paths.
- Therefore a truthful replay needs a new, explicitly ephemeral channel. Nothing in
  the existing log can be "just read back".

### 1.3 Why embeddings are worth showing (measured, not asserted)

From `docs/validation/retrieval-latency-and-semantic-gate-2026-11-03.md` on the frozen
200-query corpus (1089 project notes, kappa 0.893):

| mode | pooled P@3 | exact | paraphrase | cross-lingual | concept | deictic | p50 |
|---|---|---|---|---|---|---|---|
| lexical | 44.375% (71/160) | 96.9 | 53.1 | 15.6 | 37.5 | 18.8 | 233.4 ms |
| hybrid | 61.25% (98/160) | 96.9 | 84.4 | 21.9 | 59.4 | 43.8 | — |

The gain is concentrated exactly where a pure-text search visibly fails: paraphrase
(+31.3 pts), concept (+21.9), deictic (+25.0), cross-lingual (+6.3), while exact-title
queries are preserved by the lexical guard (`lib/hybrid-search.js:40-46`). A
visualization that shows the guard firing is as important as one that shows the wins —
it explains why the graph sometimes does not move.

### 1.4 The coexistence answer

The two graphs answer different questions over the same nodes. The link graph's edges
are `[[wikilink]]`s — structure (who cites whom, which notes are islands). The semantic
graph's edges are vector neighbours — content (who talks about the same thing). Neither
subsumes the other. The chosen shape is one graph with a layout switch, so filters,
colours, search and recall highlighting are built once, and the semantic layout can
point at "content neighbours with no link yet" without rewriting a single note.

## 2. Goals and non-goals

### 2.1 Goals

G1. Render the note embeddings as a 2-D semantic layout inside the existing graph tab,
    switchable with the existing link layout over the same node set.
G2. Show a recall — live (after an agent memory call) or manually replayed — on the
    same renderer: projected query point, lexical vs dense contributions, fused order,
    and an honest explanation of what the embedding changed, including cases where it
    was intentionally not used.
G3. Keep the replay data ephemeral and local: process memory only, bounded, no vault or
    data-root writes, no diagnostic-format change, vectors never leave the process.
G4. Add no runtime dependency, no bundler, no server-rendered HTML; stay inside the
    panel's token-only theme and its Obsidian-graph visual baseline.

### 2.2 Non-goals

N1. No change to retrieval ranking, fusion weights, gate constants, tool output,
    diagnostic events, or the panel's lexical search surface. This spec only observes.
N2. No automatic `[[wikilink]]` writing, no link suggestion persistence. "Should link"
    is a read-only hint in the inspector.
N3. No kNN force-directed semantic layout (the alternative "乙" in section 3.4), no
    UMAP/t-SNE, no new projection dependency.
N4. No cross-process or cross-session history: closing the process discards all traces.
N5. No new sidebar tab. The graph tab keeps its three-view tab literal; search stays
    the fourth, non-tab surface.
N6. No route that triggers `warm()`/`sync()` — reads must not write the embedding
    store (the store is warmed by the existing agent path, `lib/services.js:433-453`).

## 3. Decisions (brainstorming session, 2026-11-03)

D1. **Coexistence**: one graph, a layout switch (user choice "A. 同一张图，加「布局」
   切换"). Default remains the link layout; semantic is a second layout, not a second
    tab. Rationale in 1.4.
D2. **Trigger**: live capture plus manual replay on the same renderer (user choice
    "C. 实时捕获 + 同一渲染器的手动复现"). One code path for both is what makes the
    replay trustworthy; two implementations would drift.
D3. **Privacy**: keep the full replay data in process memory (user choice "A. 内存内
   保留完整回放数据"), bounded at 20 traces per session and 64 sessions. No disk, no
   vault, no diagnostic journal. This deliberately extends the privacy-safe diagnostics
   stance to a channel that dies with the process.
D4. **Projection**: PCA to 2-D, deterministic and cacheable (user choice "甲. 投影星
   图"). Alternatives considered and rejected for phase 1:
    - "乙. 语义簇图": server top-k≈6 neighbour edges + client force layout. Best cluster
      shape, but non-deterministic coordinates, a new kNN precompute/cache, a query
      point approximated by a neighbour centroid, and a harder test story.
    - "丙. 不换布局的语义叠加": keep the link layout and overlay semantic edges only.
      Cheapest, but no point-cloud sense of space.
    If phase 1's point cloud proves hard to read, phase 2 adds 乙's kNN edges as a
    second layer inside the semantic layout rather than replacing coordinates.
D5. **Visual baseline**: "对齐 Obsidian 知识图谱的那种极简分子" (user correction,
    2026-11-03). Small filled dots, thin subdued edges, labels by zoom threshold, no
    permanent decoration; emphasis (halo/sweep/ring) exists only during a recall; the
    explanation card is low-saturation and token-only. This is a hard constraint on the
    implementation, not a preference.
D6. **Read-only routes**: `semantic`/`recall`/`explain`/`neighbors` never call
    `warm()`/`sync()` and never write; a missing map is reported, not built.
D7. **Deterministic and honest projection**: the map reports the variance its first two
    components explain; it is only served when it covers every embeddable note, so a
    half-written warm checkpoint cannot move points under the user.

## 4. Design

### 4.1 Data flow

```
agent turn / panel replay
  searchNotes -> hybrid.rank (lib/hybrid-recall.js)
      └─ non-enumerable hits.hybridTrace (query vector, lexical/dense ranks, fused, fallback)
  services.search
      ├─ returns projectHits(hits)  (bytes unchanged)
      └─ recall-trace.record(sessionId, source, queryText, hybridTrace)
              ↓ (process memory, bounded)
  POST /obsidian-mem/graph  {action:'recall'|'explain'}
      ├─ semantic-map.projectQuery(vector) -> {x,y}
      └─ traceView (vector removed, text truncated)
              ↓
  lib/graph-semantic.js  (poll, overlay model, card, replay)
      ├─ renderer.setOverlay(painter)  / layout:'semantic'
      └─ explanation card DOM
  POST /obsidian-mem/graph {action:'semantic'} -> quantized 2-D points (once per store identity)
```

### 4.2 Projection engine — `lib/semantic-map.js` (new)

Pure module (no fs, no http). Input is `snapshot()` from `lib/embedding-store.js`
(`{vectors: Map<path, Float64Array>, size, generatedAt}`); output is coordinates and an
explanation of how much of the space two dimensions keep.

- Mean-centre the vector set, then run `PCA_ITERATIONS = 24` power iterations of the
  covariance operator directly on the centred vectors (no d×d covariance matrix is
  materialized, which is what keeps the pass inside the latency budget), with
  Gram–Schmidt deflation of the first component before the second. The start vector
  is derived from a fixed coordinate hash, so the result is deterministic and
  independent of `Map` insertion order after sorting paths.
- Normalize coordinates into the unit square preserving aspect; return
  `{state:'ready', points: Map<path,{x,y}>, count, total, explained, generatedAt,
  mapKey}` where `explained = (λ1+λ2) / Σλ`.
- **Completeness gate**: the map is only `ready` when the store covers every
  embeddable note the index knows — the same row set `warm()` embeds
  (`index.candidateNotes({kind:'all', excludeStatuses:[], type:null})`,
  `lib/hybrid-recall.js:178-181`), so "covered" has one definition. A warm checkpoint
  writes every 8 batches or 30 s (`lib/embedding-store.js` sync), so a partial map
  would visibly rearrange itself mid-warm; `warming` carries `{covered,total}`
  instead.
- **Cache**: one entry keyed by the store's file identity (path + mtime + size) plus
  note count. First computation target ≤300 ms for ~1404 × 1024; subsequent reads are
  a map lookup. No on-disk cache — the embedding store already is the cache and is
  rebuildable (rule 4).
- **Query projection**: `projectQuery(vector)` uses the cached basis → `{x,y}`; the
  vector itself is never serialized and never leaves the process.
- **Degenerate**: zero first-two-component variance → `{state:'degenerate'}`; the
  layout switch is disabled with the reason.
- **Failure**: store unreadable/corrupt → `{state:'unavailable', reason}`; no throw.

### 4.3 Recall trace store — `lib/recall-trace.js` (new)

Process-local ring with a monotonic cursor, modelled on `lib/graph-activity.js`:

- `RECALL_TRACE_MAX_SESSIONS = 64`, `RECALL_TRACE_MAX_PER_SESSION = 20`,
  `RECALL_QUERY_TEXT_MAX = 200` code points.
- One trace: `{cursor, at, source: 'tool'|'prompt'|'panel', queryText, queryVector
  Float32Array, engine, fallback, guard, denseCandidates, embedMs, tookMs,
  lexicalTop: [{path, rank}] (≤50), denseTop: [{path, rank, score}] (≤50),
  fusedTop: [{path, source, lexicalRank, denseRank, semanticScore, hybridRank,
  lexicalHit}] (≤20)}`.
- `record(sessionId, trace) -> cursor` and `since(sessionId, after?)`; the first call
  omits `after` and returns the retained window with the current cursor, later calls
  are incremental. Bounded eviction is oldest-first per session.
- **No fs, no vault, no diagnostics**; no network. A `traceView` projection (section
  4.5) is the only thing that leaves the ring.

### 4.4 Capture seam

- `lib/hybrid-recall.js`: `rank()`/the lexical-guard branch attach a **non-enumerable**
  `hybridTrace` to the returned array — the same pattern as the existing
  non-enumerable hybrid facts, so array identity, iteration and JSON are unchanged.
  The trace carries the query vector and every rank list before the fusion projection
  drops them. `hybrid-recall` grows by ~20 lines.
- `lib/services.js`: after `searchNotes` returns and before `projectHits`, read
  `hits.hybridTrace` (when present) and `recallTrace.record(sessionIdOf(exec), source,
  args.query, trace)`. `source` is `'prompt'` when the internal caller set
  `args.traceSource = 'prompt'` (the prompt-recall path, `lib/prompt-recall.js:119`)
  and `'tool'` otherwise. The tool response is unchanged: `projectHits` still produces
  the same objects, and the existing fingerprint test remains the guard.
- Fallback branches (`provider-disabled`, warming, guard, provider error during
  explain) record a trace with the reason and whatever lists ran. A lexical-only search
  therefore still explains itself.
- `explain` for manual replay shares one internal helper with `search` (extract the
  `resolveProject → indexFor → hybridFor → searchNotes` sequence) so replay and live
  recall cannot compute different numbers. It records a `source:'panel'` trace and
  returns the trace view directly.
- `lib/index.js` needs no new wiring: `createServices` owns the ring (it already owns
  the session-keyed cue path), so the zero-headroom `lib/index.js` stays untouched.

### 4.5 Route contract — extend `POST /obsidian-mem/graph`

The existing route is already session-scoped, guarded and read-only; adding actions
keeps the panel route's byte ceilings and mutation vocabulary out of this feature.
New request actions (unknown action → 400, as today):

| action | request | response `value` |
|---|---|---|
| `semantic` | — | `{state:'ready'\|'warming'\|'unavailable'\|'degenerate', count, total, explained, generatedAt, mapKey, points:[[path,x,y],…]}` with x,y quantized to 0–4095 |
| `recall` | `cursor?` | `{cursor, events:[traceView]}` (first call omits cursor → retained window + current cursor) |
| `explain` | `{query}` | `{trace: traceView}`; query length ≤200; runs the shared pipeline with the session's binding scope (`all` when unbound, flagged in the view) |
| `neighbors` | `{path}` | `{path, neighbors:[{path,score,rank}]}` top 8 by cosine; `linked` is decided client-side from the loaded edges, server stays unaware of links |

`traceView` replaces `queryVector` with `{text, x, y|null}` (projected at response time
with the current basis; `mapKey` mismatch is carried so the card can say the map was
regenerated), caps text at 200 code points and caps lists at 50/50/20. Server-side
budgets: `semantic` ≤48 KB, one `traceView` ≤12 KB (drop the lowest dense scores, then
the lexical tail, keep fused; set `truncated:true`), idle `recall` ≤2 KB. All routes
use the existing `trusted()` fence, session lookup, `body ≤4096`, no-store/nosniff and
`GET`-only handling for assets. They never call `warm()`/`sync()`.

The served-module list gains `graph-semantic.js` next to the five existing assets; the
route test that walks `from` imports transitively covers its reachability.

### 4.6 Client architecture

- **New `lib/graph-semantic.js`** (served ES module, ~400–500 lines): recall poll;
  pure `overlayModel(trace, map, nodeIds)` builder; explanation-card state machine and
  its DOM mount; manual replay; semantic-neighbour inspector; layout controller. It
  imports only sibling served modules (relative URLs) and never `lib/locale.js`.
- **`lib/graph-renderer.js`**: a static-layout mode (`layout:'semantic'` with positions
  supplied) that ignores worker frames while active, interpolates positions over
  `LAYOUT_TRANSITION_MS = 600` (immediate under reduced motion), re-seeds the worker
  when switching back to link layout; plus `setOverlay(painter)` — one hook called after
  the node pass with the current transform, screen points and reduced-motion flag. Link
  mode's drawing path keeps its current behaviour so `test/graph-renderer.test.js` still
  pins it.
- **`lib/graph-settings.js`**: add `layout: 'link'|'semantic'` (default `link`) and
  `semanticEdges: boolean` (default false) to the sanitized record. The version stays
  2: an old record simply lacks the fields and falls back, so a user's colour groups
  are not reset. Bad values fall back field-by-field like every other control.
- **`lib/client.js`**: GraphView reads/writes the two fields through the existing
  settings store, fetches the semantic map once per store identity, feeds polled traces
  to the graph-semantic controller, and adds the new token-only classes to the existing
  injected stylesheet. No new tab, no panel-route change, no new URL literal that is
  not route-served.
- **i18n**: browser modules keep their local `t(zh,en)` convention; every card string
  and control label lands in both languages (section 4.7 and appendix B).
- **Obsidian visual baseline** (D5): nodes are the existing small filled circles, edges
  the existing thin lines; the semantic layout adds no permanent edges (the optional
  link-edge overlay is a low-opacity dashed line). No new hex colours, no gradients, no
  custom font families; only the existing 11 palette slots and allowlisted `--dsw-*`
  tokens.

### 4.7 Interaction

**Layout switch.** A "布局 / Layout" control in the graph controls: 链接 (default) and
语义. Semantic is disabled with a reachable reason while the map is
warming/unavailable/degenerate; a stored semantic preference falls back to link and
switches automatically once the map is ready. Switching to semantic interpolates the
nodes from their current positions; switching back hands the current coordinates to the
force worker. Filters, colour groups, scope and search apply unchanged; scope=project
only hides non-project nodes, it does not re-project.

**Recall overlay (semantic layout).** The projected query point (hollow double ring,
"查询/query" label); lexical hits marked with a square ring; dense-only hits with a
dashed outer ring and a small satellite dot; fused top-3 with numbered badges; up to
`DENSE_LINE_MAX = 12` thin query→hit lines whose width/alpha follow cosine; no lines for
lexical hits (keeps the cloud quiet). Emphasis animates in over `OVERLAY_DURATION_MS =
900` (immediate under reduced motion) and then stays until the next trace or a manual
clear. A "locate" action pans the view to a listed node, or to the query point when it
falls outside the current viewport. A live recall and a manual replay use the same
painter and the same trace shape.

**Link layout.** Existing `graph-recall` cues are untouched. A non-blocking pill
("新召回 · 查看解释 / New recall · explain") appears; opening it shows the card, which
offers "切到语义布局定位 / locate in semantic layout" instead of forcing a layout
switch.

**Explanation card.** Bottom overlay, collapsed to a one-line status bar by default,
expandable, closable, keyboard-reachable, not covering the canvas's pointer target when
collapsed. Content: query text (≤80 shown, full on expand), source (mem_search / auto
recall / manual replay), engine badge and `embedMs`/`tookMs`, three defined counts —
lexical hits (fused hits with `lexicalHit`), dense-only additions (fused hits with a
dense hit and no lexical hit), fused promotions (fused hits whose `hybridRank` beats
their `lexicalRank`) — a list of dense-only additions (title, cosine, locate), and a
status area driven by this state machine (pure function + copy table, DOM only mounts
it): `idle`, `replaying`, `hybrid`, `guard`, `warming`,
`provider-disabled`, `provider-error`, `map-unavailable`, `route-error`. Every state
says *why* the embedding did or did not participate. The replay field ("复现 /
Replay") sits at the bottom of the card and posts `explain`; it does not touch the
search view's box. One line states the privacy rule: "仅本机内存，进程退出即清除 /
Memory only; cleared when the process exits".

**Semantic neighbours.** Selecting a node opens the neighbour view: top 8 cosine
neighbours, each marked 已链接/未链接 from the loaded edges; unlinked entries can be
located in the graph. An optional `semanticEdges` toggle draws dotted lines to unlinked
neighbours of the selected/hovered node (default off). Read-only: nothing is written.

**Accessibility.** Canvas `aria-label` gains the layout and a short last-recall summary;
the card and replay field are reachable; automatic recall is not announced (no
`aria-live`), a manual replay announces its result once via `aria-live="polite"`.
Reduced motion and the 320–375 px sidebar both have explicit paths (immediate overlay,
collapsed card).

### 4.8 Privacy and degradation matrix

Privacy is a hard constraint, tested:

- Traces live only in the process ring (4.3). A capture leaves the data root, the vault
  and the diagnostic journal byte-identical; a new process has an empty ring.
- Query text is capped at 200 code points; the vector never leaves the process (only
  projected `{x,y}`); list caps and per-response ceilings bound the surface.
- Routes reuse the trusted/loopback fence; no new persisted configuration; the embed
  provider remains loopback-only.

| state | semantic layout | replay / card | tested |
|---|---|---|---|
| provider disabled | switch disabled with how-to-enable reason | lexical-only + "no embedding provider" | yes |
| store warming (covered<total) | hidden / "warming X/Y" | fallback record `warming` | yes |
| store unreadable/corrupt | unavailable + reason | same, no throw | yes |
| degenerate projection | disabled + reason | candidate lists still shown, no query point | yes |
| store identity changed | recompute (cached after) | projected with the new basis, card notes it | yes |
| provider timeout/error during replay | map kept | lexical-only + `provider-error` | yes |
| unbound project | unchanged unbound snapshot behavior | replay runs with `all` scope and says so | yes |
| reduced motion / narrow sidebar | immediate overlay, collapsed card | same content, no animation | yes |

### 4.9 Performance budgets

- PCA first computation ≤300 ms for ~1404×1024 (once per store identity; measured value
  recorded in `docs/validation/`). Correctness asserted in tests with a generous bound;
  a wall-clock assertion tight enough to be meaningful would be flaky in CI.
- `semantic` payload ≤48 KB quantized; one `traceView` ≤12 KB; idle `recall` ≤2 KB;
  tested as byte ceilings on the route.
- `explain` end-to-end target p50 ≤350 ms (loopback embed ~99 ms + cosine <1 ms + route
  overhead); measured on the real vault for acceptance, not asserted in CI.
- Recall polling runs only while the graph view is visible (`RECALL_POLL_MS = 1500`);
  the map is fetched once per store identity and cached client-side; no new runtime
  dependency, no bundler, no build step.

## 5. Test matrix (TDD: fail first, then pass)

| layer | test file | assertion |
|---|---|---|
| projection | `test/semantic-map.test.js` (new) | determinism (same input → same coords); explained-variance sum; unit-square normalization; `projectQuery(v)` equals dot(v−mean, basis); zero-variance → degenerate; completeness gate (partial → warming); cache identity on mtime/size change; corrupt input → unavailable |
| trace store | `test/recall-trace.test.js` (new) | per-session cap/eviction; session isolation; cursor monotonic; 200-cp truncation; no fs writes (temp data root unchanged); vector absent from `JSON.stringify(traceView)` |
| capture | `test/hybrid-recall.test.js` (extend) | hybrid success trace fields (lexical/dense ranks, fused, guard=false); guard path skips dense and records `guard:true`; fallback reasons; **tool output bytes unchanged** (existing fingerprint test stays) |
| route | `test/graph-route.test.js` (extend) | four action contracts; unknown action 400; cross-origin 403; missing session; unbound; byte ceilings; `GET` asset for `graph-semantic.js`; import closure reachability |
| renderer | `test/graph-renderer.test.js` (extend) | semantic layout ignores worker frames and uses supplied coords; layout interpolation endpoints and reduced-motion immediacy; overlay geometry (≤12 dense lines, lexical mark set, query screen position); semantic drag mutates only its node; link-mode drawing unchanged |
| client model | `test/graph-semantic.test.js` (new) | `overlayModel` classifies lexical-only / dense-only / fused top-3; card state machine covers all states; both locales; replay flow with fake fetch; poll dedupe and cursor; neighbour linked/unlinked flags |
| settings | `test/graph-client.test.js` (extend) | old v2 record lacking `layout` → `link`; invalid value → `link`; `semanticEdges` boolean; version stays 2; colour groups not reset |
| panel surface | `test/panel-client.test.js` (extend) | tab literal unchanged; every new `mem-*`/`graph-*` class has a style; token allowlist respected |
| architecture | `test/architecture.test.js` (extend) | `LAYERS` entries for the three new modules; budgets raised with a recorded reason; import edges point downward |
| packaging/docs | `npm run check` | tarball/module count re-measured (AGENTS.md paragraph), README pair + `README.i18n.yaml` blob hashes, CHANGELOG Unreleased entries mark measured vs untested |

## 6. Acceptance criteria (evidence required)

A1. `npm run check` is green.
A2. On the real vault (~1404 notes, Qwen3-Embedding-0.6B 1024-d): the semantic layout
    renders in ≤300 ms on first use and from cache afterwards; switching layouts has no
    visible hitch; the map reports its explained variance honestly.
A3. Replaying a known paraphrase query shows at least one "dense-only" addition in the
    card; replaying an exact-title query shows the guard state; stopping the embed
    server and replaying shows the provider-error fallback. Screenshots and measured
    numbers go to `docs/validation/semantic-map-2026-11-03.md`.
A4. Capturing a recall leaves the vault's `git status` clean and adds no file under the
    data root; the ring is bounded in memory.
A5. README.md + README.zh.md describe the feature as a pair and `README.i18n.yaml` is
    updated; CHANGELOG Unreleased separates what was measured from what was not (rule 6);
    AGENTS.md's tarball/module paragraph is re-measured.

## 7. Risks and mitigations

| risk | mitigation |
|---|---|
| 2-D projection crowds locally | honest explained-variance label; select/hover isolates neighbours; phase 2 can add kNN edges without replacing coordinates |
| points jump when the store changes | cache by store identity; recompute only when identity changes; animate the transition; `mapKey` on traces explains a mismatch |
| trace projected with a basis that changed | project at response time, carry `mapKey`, card states it |
| renderer budget growth breaks the pinned link behaviour | static mode behind a flag; link-mode tests unchanged; budget raised with a reason in the architecture table |
| DOM card tests become pixel-brittle | card is a pure state machine; DOM only mounts it; assertions on state and copy, never pixels |
| privacy regression | tests assert no writes and no vector serialization; review checklist item on the capture seam |
| real-vault scale exceeds payload/perf budgets | quantization, list caps, byte ceilings measured; acceptance records real numbers |
| provider down mid-session | every fallback is a test; `explain` never throws, it reports |
| automatic recall becomes noisy | card collapsed by default; no aria-live for automatic traces |
| old localStorage record loses settings | layout fields are defaulted, not version-bumped; colour groups untouched |

## 8. Implementation outline (input to the plan; not the plan itself)

1. `lib/semantic-map.js` + tests (pure projection).
2. `lib/recall-trace.js` + tests (pure ring).
3. Capture seam: `hybrid-recall` non-enumerable trace, `services.search` recording and
   shared `explain` helper, prompt source label; tool-bytes guard.
4. Route actions in `lib/graph-route.js` + route tests.
5. Renderer static layout + overlay hook + renderer tests.
6. `lib/graph-semantic.js` overlay model + client-model tests.
7. Card, replay, poll, neighbour view + DOM/state tests.
8. Settings fields, GraphView wiring, CSS/token/class tests.
9. Architecture budgets, i18n, README pair, CHANGELOG; full `npm run check`.
10. Real-vault acceptance run + `docs/validation/semantic-map-2026-11-03.md`.

## 9. Files and budgets

| file | now | budget now → after |
|---|---|---|
| `lib/semantic-map.js` | — | new, 300 |
| `lib/recall-trace.js` | — | new, 220 |
| `lib/graph-semantic.js` | — | new, 520 |
| `lib/graph-renderer.js` | 727 | 750 → 820 |
| `lib/graph-settings.js` | 150 | 200 (unchanged) |
| `lib/graph-route.js` | 151 | 200 → 300 |
| `lib/hybrid-recall.js` | 276 | 320 (unchanged) |
| `lib/services.js` | 2038 | 2100 → 2150 |
| `lib/client.js` | 1742 | 1750 → 1830 |
| `lib/index.js` | 250 | 250 (unchanged — the ring lives in services) |

`lib/search.js`, `lib/embedding-store.js`, `lib/panel-route.js`, `lib/hybrid-search.js`,
`lib/retrieval-*` are unchanged. Budget increases are decisions recorded in
`test/architecture.test.js` together with their reason, as the architecture test's own
comment asks.

## Appendix A — payload sketches

```jsonc
// action: "semantic"
{ "ok": true, "value": { "state": "ready", "count": 1404, "total": 1404,
  "explained": 0.31, "generatedAt": 1762199999999, "mapKey": "mtime-size-hash",
  "points": [["Projects/a.md", 1024, 3071], ["Projects/b.md", 2210, 118]] } }

// action: "recall" (one event)
{ "cursor": 42, "events": [{
  "cursor": 42, "at": 1762199999999, "source": "tool",
  "query": { "text": "上次改 hybrid 检索的那个决定", "x": 0.42, "y": 0.77 },
  "engine": "hybrid", "fallback": null, "guard": false,
  "denseCandidates": 50, "embedMs": 99, "tookMs": 240,
  "lexical": [{ "path": "Decisions/ADR-266.md", "rank": 1 }],
  "dense":   [{ "path": "Decisions/ADR-266.md", "rank": 1, "score": 0.91 }],
  "fused":   [{ "path": "Decisions/ADR-266.md", "source": "lexical", "lexicalRank": 1,
                "denseRank": 1, "semanticScore": 0.91, "hybridRank": 1, "lexicalHit": true }],
  "truncated": false, "mapKey": "mtime-size-hash" }] }
```

## Appendix B — card copy (zh / en)

| key | 中文 | English |
|---|---|---|
| layout | 布局 | Layout |
| layout.link | 链接 | Links |
| layout.semantic | 语义 | Semantic |
| card.title | 本轮解释 | This recall |
| card.idle | 还没有召回记录。让 agent 搜一次记忆，或在下面输入 query 复现。 | No recall yet. Let the agent search memory, or replay a query below. |
| card.hybrid | 词法命中 {lexical} · 仅语义新增 {denseOnly} · 融合提升 {promoted} | lexical {lexical} · dense-only {denseOnly} · promoted {promoted} |
| card.guard | 这次命中了词法保护（标题/短语精确命中），语义没有参与排序——这是有意为之。 | Lexical guard fired (exact title/phrase); semantics stayed out of the order on purpose. |
| card.warming | 向量索引预热中（{covered}/{total}），稍后再试。 | Embeddings warming ({covered}/{total}); try again shortly. |
| card.providerDisabled | 未启用 embedding provider，本次是纯词法检索。 | No embedding provider is enabled; this was lexical only. |
| card.providerError | embedding 服务不可达，已回退词法检索。 | Embedding service unreachable; fell back to lexical. |
| card.mapUnavailable | 语义地图不可用，无法定位查询点；命中列表照常显示。 | Semantic map unavailable, so the query point cannot be placed; hits are still listed. |
| card.replay | 复现 | Replay |
| card.replaying | 查询中… | Searching… |
| card.privacy | 仅本机内存，进程退出即清除 | Memory only; cleared when the process exits |
| neighbors.title | 语义近邻 | Semantic neighbours |
| neighbors.linked | 已链接 | linked |
| neighbors.unlinked | 未链接 | unlinked |
| recall.pill | 新召回 · 查看解释 | New recall · explain |
