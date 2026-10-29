# 记忆面板 v0.4 图表化 — 独立评审（只读）

**Range:** `2f4d69f..b36d02a`（6 commits）
**Spec:** `docs/superpowers/specs/2026-10-29-memory-panel-charts-design.md`（frozen 2026-10-29）
**Plan:** `docs/superpowers/plans/2026-10-29-memory-panel-charts-implementation.md`
**Reviewer:** independent, read-only. Tree clean at `b36d02a`.

## Verdict

The redesign lands the four user requirements: the 检索 tab is gone (`MEMORY_VIEWS` is exactly
概览/图谱/健康), a persistent shell-level search box replaces it and owns the query, the strip is a
genuine folder form (flex, 8px overlap, active leaf merging into the content surface), and 概览 now
opens on five charts with the numbers in the section meta instead of paragraphs. The data layer is
the strongest part: both aggregates are implemented twice, compared field-by-field, and the day
arithmetic is local-calendar throughout — `toISOString()` never appears in the new path, and the
`created`/`updated` mutuality is the digest's rule. But I cannot sign this off: two charts state
**different totals for the same 12-week window** (heat map drops up to 6 real days and prints a
smaller 合计 than the flow bars' 净增), the ranking's "另有 N 个标签" prints an *occurrence* count
labelled as a *tag* count, the search view's unbound→all fallback fires **three** requests for one
search and loses its own notice, and the composition "3-段上限" is asserted by a test that cannot
fail. Several spec acceptance criteria (§6.5 `<title>` contents, §6.5 空格子 `aria-hidden`, §6.6
container ≥280px, §3.4 12-point sparkline) are unmet or untested while `CHANGELOG.md` claims them
verified. None of these is a data-loss or security critical; the top issues are Important.

## Method

Read the frozen spec and plan, `git diff 2f4d69f..HEAD -- lib/ test/`, `WORKFLOW.md`'s quality bar,
`lib/digest.js:189-210`. Ran `node test/panel-ui.test.js` (32/32), `node
test/memory-panel-behavior.test.js` (4/4), `node test/panel-client.test.js` (16/16) — all green at
`b36d02a`. Verified the behavioural findings by driving the real views through the suites' own
four-hook React stand-in with instrumented `fetch` (probes only; no files written). Line numbers are
`b36d02a`.

---

## Critical

None. No data loss, no security regression, no crash path. The route still exposes exactly
`overview|search|health`; the panel stays read-only; the byte ceiling still throws rather than
shipping an oversized envelope.

Two candidate Criticals were investigated and downgraded after measurement:
- *Overview exceeding 16 KB* — no. At 50 notes + 84 days the untrimmed payload fits (§6.8 holds;
  `test/panel-route.test.js` asserts `days === 84`, `tags === 12`, `digest !== null` at ≤16 KB), and
  `fit()` still throws `response-too-large` if the hard trim cannot reach the ceiling.
- *A stale response painting under the wrong session* — no. Both the abort generation
  (`controller.current !== current`) and the session guard (`session.current !== sessionId`) are
  checked on the success **and** the error path (`lib/memory-panel.js:1040-1050`), and the snapshot
  is session-keyed (`memory-panel.js:976-977`).

---

## Important

### I1. The heat map silently drops real days, so two charts disagree about the same window

`lib/memory-panel.js:462-473` — measured on an 84-day window ending 2026-10-29:

```
window days: 84 | true event total: 84
grid cells: 84 | non-void cells: 82
heat meta: 近 12 周 · 本周 7 天有更新 · 合计 82 条
flow meta: 近 12 周净增 84
```

An 84-day window only starts on a Sunday when the calendar happens to cooperate; otherwise it spans
13 partial columns. `heatmap()` pads the head with `null`s (`:459-463`) and then discards the partial
column with `allColumns.slice(-12)` (`:467`). The dropped cells are **real data**, not padding — up to
6 days / 6 events, and 84 days starting on a Monday loses 6.

Why it matters: the spec's own premise (design §3.4 item 2, and the CHANGELOG's own words — "色相只作
形状，数字才是读数") is that the printed number equals the picture. Here 合计 82 directly under a
grid that represents 84 days of events, next to a flow block that says 净增 84, is two different
answers for one window. A reader comparing them concludes the heat map is broken.

Fix: do not drop the partial head column. Render `allColumns.slice(-13)` and let the grid be
13 columns when the window does not align (the CSS is `grid-template-columns:repeat(12,1fr)`, so it
also needs `repeat(auto-fit,…)` or a column count computed from `columns.length`), **or** truncate the
payload window server-side to a whole number of weeks ending on the last complete week and say so in
the meta ("近 12 周（至 M/D）"). Either way `maximum`/`total`/`thisWeek` must be computed from the drawn
cells **and** the cells drawn must be the whole window. Whichever is chosen, add an assertion that
`合计` equals `sum(created)+sum(updated)` over the window — that is the contract the meta text is
claiming.

### I2. "另有 N 个标签" prints an occurrence count, not a tag count

`lib/memory-panel.js:635-636,660` — `remaining = total − shownTotal`, where `total` is *every tag
occurrence in scope* (design §3.3: "`total`… 全部标签条目数（非去重）"). Measured on 10 tags where the
two unseen tags have `n = 2` each:

```
true extra tags: 2  (ranks 9,10)
remainder label: 另有 4 个标签
rows rendered: 8
```

The label claims four tags exist; two do. It is only correct in the degenerate case where every
remaining tag has `n === 1` — which is exactly the case the test fixture uses
(`test/panel-ui.test.js:642-651` computes the expected value with the *same* wrong formula, so the
test encodes the bug rather than catching it).

Fix: the remainder must count *rows the ranking did not print*, i.e. `tags.items.length − visible.length`
plus the tags beyond the page — but the payload cannot answer the latter, so either (a) have
`tagFrequencies` also return `distinct` (the number of distinct tags in scope), then print
`另有 {{distinct − visible.length}} 个标签`; or (b) change the copy to what the number actually is —
`另有 {{remaining}} 次`. Option (a) is the honest one and costs one integer in the payload.

### I3. The unbound→all fallback fires a third request and loses its own notice

`lib/memory-panel.js:1056-1071` + `lib/client.js:1097` — the view does `onFilter('scope','all')` **and**
immediately `void run({… scope:'all' …}, fallback)`. The shell then re-renders with `scope: 'all'`,
which changes `runKey` (`:1081`), so the effect fires a *second* run with `continuation === null`,
which calls `setNotice(null)` (`:1024`). Measured with the real shell wiring:

```
requested scopes: project,all,all
unbound notice visible? false
results rendered: 1
```

Two defects in one line: one user search spends three round trips, and the notice the whole branch
exists to show is cleared by its own duplicate run before it can be read.

The existing test cannot see this: `test/panel-ui.test.js:1079` asserts `requests === 2` *before* it
ever re-renders with the shell's new `scope`, so the third request and the notice's disappearance are
both outside the assertion window.

Fix: when `onFilter` is wired (the composed case), **do not** run. Report the scope change, keep
`setNotice(fallback)`, and let the shell-driven run be the single read — but make that run preserve
the notice: pass the fallback through, e.g. `run(props, lastRun.current === null ? null : pendingNotice)`,
or move the notice out of run-scoped state into state keyed by `(sessionId, query)` so a scope
refinement cannot clear it. Then assert `requests === 2` **after** the shell re-render, and
`countText(notice) === 1` in the settled tree.

### I4. The composition bar's "3 段上限" is not implemented, and the test that guards it is vacuous

`lib/memory-panel.js:773` — `className: 'mem-bar-fill is-seg' + (index % 6)` for *every* `byType` row.
Measured with a realistic seven-type vault:

```
byType rows: 7 | bar segments: 7
classes: is-seg0 | is-seg1 | … | is-seg5 | is-seg0
```

The seventh segment reuses `is-seg0`, so a multi-type vault renders a duplicate colour band and the
legend shows duplicate dots. The guard, `test/panel-ui.test.js:656`:

```js
assert.ok(byClass(tree, 'mem-bar-fill').length <= 3, 'the segment cap holds')
```

passes only because its fixture supplies exactly three types (`:640-650`) — replace the fixture and it
fails immediately, so it asserts nothing about a cap. Design §6.5 says "构成条段数 = `byType.length`
（…**不合并**…，保持现状 3 段上限语义）" — the spec is self-contradictory here (段数 = length *and*
3-段上限), and the plan repeats it. Baseline `2f4d69f` also had no slice, so the "现状 3 段上限语义"
premise is simply wrong.

Fix: decide one rule. If the cap is real, `parts.slice(0, 3)` plus an "其他 n 条" remainder segment and
a test fixture with 7 types asserting `length === 3` and a real remainder. If `不合并` is the rule,
delete the word "上限" from the spec/plan and fix `is-seg' + (index % 6)` to a distinct
`is-seg' + Math.min(index, 5)` so the 4th–7th segments share the "other" tint deliberately instead of
aliasing back to the first colour. Either way the assertion must use a fixture with more types than
the cap.

### I5. Heat-map `<title>` cannot work in HTML, and omits the date the spec requires

`lib/memory-panel.js:499-501` — `h('title', null, value + ' 条')` is rendered inside a `<span>` cell.
`<title>` is an SVG element (and an HTML metadata element only inside `<head>`); inside a body-level
`<span>` it is inert — no hover tooltip is produced. Spec §3.4 item 2 promises "各格 `<title>` 提供悬停读数",
and §6.5 requires "有数据格子有 `<title>` 且含日期与数值". The shipped title carries the value but **not
the date**, and it is unreachable by the pointer anyway.

Why it matters: the heat map is the one chart where the per-cell reading is otherwise unavailable
(the grid is deliberately non-focusable, which is correct). The spec's compensating mechanism is this
title; it does not function. Today the only per-cell reading path is the section meta's aggregate.

Fix: give each data cell a `title` **attribute** (`title: day + ' · ' + value + ' 条'`, i.e. the native
HTML tooltip the spec's §3.7 calls "浏览器原生 tooltip") instead of a `<title>` child, and drop the
child element. Keep the grid non-focusable. If the spec's §3.7 wording ("格子可聚焦并显示 `<title>`") is
taken literally it contradicts §3.4 item 2 and the §8 revision note that added "格子不可聚焦" — the
code correctly follows §3.4/§8, but §3.7 should be corrected in the spec, because as written an
implementer reading §3.7 would add `tabIndex` to 6px cells.

### I6. `onClose` is passed by the shell and ignored by the view — the spec'd prop is dead

`lib/client.js:1098` passes `onClose: leaveSearch`; `lib/memory-panel.js:975` destructures
`{ sessionId, query, scope, type, status, limit, visible, onFilter }` — no `onClose`, and
`grep -n onClose lib/memory-panel.js` returns nothing. Spec §3.5 fixes the signature as
`{…, visible, onClose }`; the plan's Task 4(a) repeats it. The shipped signature instead adds
`onFilter`, so the documented contract and the real one disagree, and every consumer of the view now
carries a prop that does nothing.

Why it matters: `SearchView` is an exported contract (`test/panel-assets.test.js` pins the export
names). A future caller who reads the spec will wire `onClose` to its back button and find it dead.
Fix: either honour it (call `onClose()` from an Esc handler on the results region or a 返回 button in
the viewhead) or remove the prop from `client.js:1098` and amend spec §3.5 to the real signature
`{ sessionId, query, scope, type, status, limit, visible, onFilter }`. Do not leave a documented prop
wired to nothing.

### I7. `limit` has two owners: the shell and the view

`lib/memory-panel.js:1235` — "显示更多" calls `void run({ limit: 50 })` directly, leaving the shell's
`search.limit` at 25. `retry` (`:1219`) and `refine` (`:1093`) read the **prop** `limit`, so after one
"显示更多" the view displays 50 rows while the shell still believes 25; a retry after an error on that
page silently drops back to 25 rows, and the two numbers in the same component disagree.

Fix: make "显示更多" report upward — `onFilter` is the wrong channel (it resets `limit` to 25 by
design, `client.js:1066`), so add `onLimit(50)` to the shell's callbacks and let the shell rewrite
`search.limit`. That keeps the "one owner" property the CHANGELOG claims, which currently holds for
query and filters but not for `limit`.

---

## Minor

### M1. `activityRequest(state, options)` takes an unused `state`
`lib/index-db.js:1017` — `state` is never referenced in the body. Dead parameter; drop it and update
the caller at `:1035`.

### M2. Stale/incorrect doc comment on `MAX_ACTIVITY_DAYS`
`lib/index-db.js:941-942` — `/** Twelve weeks — the heat map's column count. */ export const
MAX_ACTIVITY_DAYS = 365`. 365 is not twelve weeks. Fix the comment to "the widest window the panel may
ask for (a year); the heat map only draws twelve weeks of it" or move the twelve-week constant to the
route (already `ACTIVITY_DAYS = 84`, `panel-route.js:67`).

### M3. The "reused, not re-derived" claim about the digest rule is not true
`lib/index-db.js:1001-1005` says "kept here by calling into this one predicate instead of re-deriving
it", and `CHANGELOG.md` says "the same mutuality rule `lib/digest.js` already applies, reused rather
than re-derived". In fact `bucketOneDay` (`:1007-1015`) re-implements the rule inline, and
`lib/digest.js:200-202` keeps its own copy (`const created = inWindow(…); const updated = !created &&
inWindow(…)`). The *rule* matches; the *code* is duplicated. Also `digest.js` has **no**
`created`→mtime fallback (`grep mtime lib/digest.js` is empty) whereas `activity` adds one — which the
spec §3.3 explicitly requires, so the divergence is sanctioned, but the prose claims a reuse that
does not exist.

Fix: either extract `createOrUpdateDay(created, updated)` from digest and call it from both, or change
the comment/CHANGELOG to "re-implements the digest's mutuality rule deliberately, adding the
spec-required mtime fallback for `created`". Since `WORKFLOW.md` asks for honest evidence in the
CHANGELOG, the second is the minimum.

### M4. Heat-map cells violate §6.5's "空格子 `aria-hidden`"
`lib/memory-panel.js:488-493` — the `is-void` cells carry no `aria-hidden`. The grid's
`role="img"` means AT ignores descendants anyway, so this is cosmetic rather than a barrier, but it is
a named acceptance criterion that is neither implemented nor asserted. Add `'aria-hidden': true` to
the void cell, or amend §6.5 to say the parent `role="img"` covers it.

### M5. The heat-map grid max width breaks acceptance §6.6 (chart container `clientWidth ≥ 280`)
`lib/client.js:277` — `max-width:262px` on `.mem-heat-grid`. §6.6 requires every chart container to be
≥280px wide. 262 < 280. Either the criterion or the cap is wrong; as shipped the acceptance test (if
written) fails. Pick one: raise the cap to 280+ (12 cells of ~21px still fit 335px), or amend §6.6.

### M6. The sparkline is 84 points, not the spec's 12
`lib/memory-panel.js:666-682` — the polyline iterates every bucket. Design §3.4 item 1 asks for a
"12 点 sparkline" derived from cumulative `created`. It is still monotonic (the property the spec cares
about), but a daily 84-point line in a 60×16 box is a different chart from the designed weekly one,
and at 320px the last 12 points are sub-pixel. Also the spec places it "格内右侧"; it moved to its own
row (CHANGELOG admits and justifies this — the overlap was real). Fix: sample weekly
(`created` summed per 7 days, cumulative) to get 12 points as specified; keep the own-row placement
(the admission is reasonable, but record it in the spec's revision log so the frozen contract and the
code agree).

### M7. Flow-bar `<title>` text deviates from §3.4 item 3
`lib/memory-panel.js:583` — `'第 ' + (index + 1) + ' 周 · 新建 …'` where the spec says `WW 周 · 新建 n ·
更新 m`. Cosmetic, but the spec is the contract; either fix the string to the week-of-year form or
amend the spec. (The single shared zero line and the absence of any superseded series are both
correct — see "what is good".)

### M8. The architecture budget comment for `client.js` is already stale, and the charts spent its headroom
`test/architecture.test.js:726-727` says "Measured 1182 formatted lines… rounded up to 1250. The 68
lines of headroom are the whole raise: Task 4's chart rules will have to argue for their own."
`lib/client.js` at `b36d02a` is **1247** lines: the chart CSS landed in the same file without the
argument the comment demands, leaving 3 lines of headroom. The budget still passes (1250), so the
gate is green while its own stated process was skipped.

Fix: re-measure honestly (1247 → measured-plus-30 = 1277 → round to 1300) and rewrite the comment to
name the chart rules as the second raise. `WORKFLOW.md`'s "实测 + 30 取整 + 理由注释" rule is satisfied
in form only if the measured figure matches the committed file.

### M9. Dead CSS left by the rewrite
`lib/client.js:183` — `.mem-panel .mem-stamps{…}` has no producer (`grep "'mem-stamps'" lib/` → 0
hits); `statusStamps()` was retired, and the tests assert its absence. The CSS rule and the
`mem-stamps` entry in the class-coverage hook list (`test/panel-client.test.js:484`) both outlive the
component. `WORKFLOW.md` asks for dead code to be removed in the same pass. Delete the rule and the
hook entry.

### M10. `mem-heat-legend-label` is used twice and styled zero times
`lib/memory-panel.js:508,512` emits `span('mem-heat-legend-label', '少'/'多')`; `grep '\.mem-heat-legend-label'
lib/client.js` → 0. It inherits the legend's font, so it looks correct, but it is an unstyled hook in a
codebase whose own test asserts "every class the redesigned views consume is styled"
(`test/panel-client.test.js:432-500`) — a test that does not list the new chart classes at all, so the
new hooks are unguarded. Either give it the legend's text rule or drop the class; and extend the hook
list to cover `mem-heat*`, `mem-flow*`, `mem-freq*`, `mem-comp-status`, `mem-kpi-spark`.

### M11. Backend-parity test silently no-ops without SQLite
`test/index-stats.test.js:384` — `if (!HAS_SQLITE) return`. On a host without `node:sqlite` the one
test that proves the two backends agree *passes* while proving nothing, and the per-backend loops
(`BACKENDS`, `:121`) shrink to scan-only. This is the single most important guarantee of Task 1
(design §6.7). Use `t.skip('no sqlite')` so the run reports it, or assert `HAS_SQLITE` on CI and skip
only locally.

### M12. Weakest assertions (test honesty)
These assert the shape of the source, not behaviour. Quoted verbatim:

- `test/panel-client.test.js:76` — `assert.ok(script.includes('createMemoryViews({ React })'), 'React is passed into the module')` — proves a substring, not that React is passed.
- `test/panel-client.test.js:99` — `for (const marker of [...]) assert.ok(script.includes(marker), 'the shell contains ' + marker)` — ten markers, all substring matches, including `"event.key === 'End'"`, so a broken `press()` handler that still *contains* the literal passes.
- `test/panel-client.test.js:143` — `assert.ok(script.includes("id: 'obsidian-mem-panel'"), …)` — the id exists somewhere in the bundle; it does not prove `aria-controls` resolves to a live element (the behaviour test at `:130-140` does that better — keep that one, drop this).
- `test/panel-client.test.js:355` — the search-box test is `assert.ok(script.includes(marker))` over 12 markers, then regex-scans `SearchView,\s*\{[^}]*\bquery\b` on the source. It never mounts the shell. Delete-the-feature can be caught; break-the-feature cannot.
- `test/panel-ui.test.js:656` — `assert.ok(byClass(tree,'mem-bar-fill').length <= 3, 'the segment cap holds')` (see I4 — the fixture makes it unfalsifiable).
- `test/panel-ui.test.js:515` — `assert.equal(cells.length, 12 * 7, 'twelve weeks of seven days')` — the exact assertion that hides I1: it counts *cells including voids*, so a grid of 84 cells holding 82 real days passes.
- `test/panel-ui.test.js:524` — `for (const cell of cells) assert.equal(cell.props.tabIndex, undefined, 'no focusable cell')` — good and load-bearing; the one to keep.
- `test/panel-ui.test.js:401,658` — `assert.equal(byClass(tree,'mem-stamps').length, 0)` — proves a class was removed, not that status is shown; the `mem-comp-status` assertion next to it (`:402-406`) is the real one.
- `test/panel-ui.test.js:642-651` — the remainder test recomputes the expected label with the implementation's own `total − shown` formula, so it cannot catch I2 (it asserts the arithmetic, not the semantics).

`CHANGELOG.md` claims not covered by the tests: §6.5's "<title> 且含日期与数值" (I5 — no test reads the
title text); §6.5's "空格子 aria-hidden" (M4 — no assertion); §6.6's 320/375px and `clientWidth ≥ 280`
(no viewport test exists; the CHANGELOG itself says the 320px capture was "not retaken" after the
spacing fix); §6.7's backend parity on a host without sqlite (M11); the "3 段上限" phrase repeated in
both CHANGELOG entries (I4). The CHANGELOG's "Verified: … 32 pass" counts are accurate at `b36d02a` —
I re-ran the three suites — but a passing count is not the same claim as the six behaviours above.

---

## What is good

- **The user's four requirements are genuinely met**, not approximated. 检索 is not a tab; the strip is
  flex with real overlap (`client.js:94-97`) and the active leaf's `border-bottom-color:bg-base` merge;
  the search box is shell chrome above the strip and survives every tab (`client.js:1130-1137`); and
  概览 leads with charts, not prose (`memory-panel.js:924-936` orders kpi → heat → flow → composition →
  ranking → recent).
- **One derived status, one render site** survived the SearchView rewrite. `statusKind`
  (`memory-panel.js:1137-1147`) is computed once and rendered once through `SearchStatus`
  (`:1215`); the
  duplicate-idle class the spec warned about has not come back. The `runKey` effect is correct for
  session changes too — `sessionId` is the first key component (`:1081`), so switching session re-runs,
  and the abort/session guards make an out-of-order answer unpaintable on both the success and error
  paths.
- **Single ownership of query and filters is real.** `SearchBox` is dumb (`client.js:1156-1215`), the
  shell holds one `search` object plus a separate `draft` (`:1005-1006`), `refineSearch` rewrites that
  object (`:1060-1068`), and the chips report through `onFilter` instead of mutating local state —
  verified by probe: a chip click produces one state change and one read, not two. Only `limit` still
  leaks (I7).
- **The day arithmetic is exemplary.** `shiftDay` (`index-db.js:961-970`) builds from local calendar
  parts and documents why `toISOString()` would lie for UTC+8 after 16:00; `activityWindow` uses the
  existing `localDate()`; `localDayOfMicros` uses local getters. There is no `toISOString` anywhere in
  the new path. The window is computed from the day *before* bucketing, so DST and month lengths are
  handled by `Date`.
- **The two backends really do agree**, and the parity test compares whole objects
  (`index-stats.test.js:384-400`), not hand-picked fields. The SQL and scan readers share the
  bucketing predicate and the project-scope predicate (`eligibleForProject`), which is exactly the
  discipline that prevents drift. Tag counting matches because both count occurrences, ties break on
  tag text, and the fingerprints (`COALESCE(n.id, n.path)` in SQL vs `record.id ?? record.path` in scan)
  are the same.
- **The no-`archived` decision is honoured end to end.** There is no third series anywhere:
  `activity()` returns exactly `{from,to,days,created,updated}`, `flowBars` colours only two
  rect classes, and `test/panel-ui.test.js:551-556` asserts no `superseded` bar exists. The spec's
  reasoning (`superseded` is a status snapshot, not an event) is carried into three separate code
  comments — this is the spec's best idea and it was implemented faithfully.
- **The trim order is monotonic and matches §3.6 exactly** (`panel-route.js:700-721`): tags → byType →
  byStatus → activity(→28d, all three arrays in step, `from` moved) → hot.sections → recent → digest.
  Every step strictly shrinks the payload or nulls a field, so `fit`'s 64-guard cannot spin; the
  7-stage ladder test (`panel-route.test.js:600-780`) is the strongest test in the change — it pads one
  target past the ceiling per stage and asserts the *preceding* stages paid and the following ones did
  not.
- **The hard trim leaves a renderable shape.** `activity: null`/`tags: null` (`panel-route.js:674-676`)
  make every chart return `null` (`memory-panel.js:449,527,631`), which is precisely the "no chart"
  path, and `test/panel-ui.test.js:660-676` proves a null payload draws the KPI band and no hollow grid.
  Empty-state handling is right too: an all-zero window prints a sentence, not twelve zero bars.
- **Feature detection rather than assumption** (`panel-route.js:385-417`): a pre-v0.4 index answers
  `null` instead of failing the 概览 read, and both the absent-method and throwing-method cases are
  tested. This is the correct two-halves-upgrade-independently posture.
- **`health` gaining `project`** (`panel-route.js:419-423`) is a real bug fix with the reasoning
  recorded and a route-level assertion (`panel-route.test.js:1358-1366`) — the header would otherwise
  relabel itself on a tab switch.
- Build hygiene is clean: prettier and eslint pass on all four `lib/` files at `b36d02a`, the CSS is
  token-only with no hex/rgb/hsl and no gradients, `prefers-reduced-motion` covers the new controls,
  and the folder strip's 44px hit target is achieved with a documented `::after` extension rather than
  by deforming the 32px leaf.