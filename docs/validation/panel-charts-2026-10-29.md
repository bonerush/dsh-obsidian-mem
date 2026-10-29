# Panel charts — 320px / 375px capture and measurement (2026-10-29, round 3)

**Status: PASS** — the real 概览 views were rendered, measured and screenshotted at
320px and 375px in light and dark; **220/220** harness checks pass. This record closes
the open verification claim in `CHANGELOG.md`:

> “Not verified: the fixes were not re-captured at 320px …”

**Scope:** the `lib/memory-panel.js` chart fixes (including the round-3 flow-block
rewrite) and the `lib/client.js` `.mem-heat-grid` cap + search-input token fixes,
measured against the committed review contract
`.superpowers/sdd/2026-10-29-memory-panel-charts/review.md` (M4/M5/M6/M7 and the
§6.5/§6.6 acceptance quotes; the frozen design file itself is absent from this
checkout — see `progress.md` “Record gap”) and the round-3 contract in
`task-B-report.md` / `task-C-report.md` “Round 3”.

**Environment (measured, not assumed):** Windows 11 host · Node `v24.20.0` ·
Google Chrome `154.0.8037.98` headless driven over CDP · page devicePixelRatio `1` ·
host theme token values extracted from the installed
`C:/Users/bonerush/AppData/Local/Programs/DeepSeek Harness/resources/app.asar` ·
capture run `2026-10-29T14:01:21Z` (22:01 +08:00).

## 1. Captured revision (read this before trusting the artifacts)

The capture page is generated from the working tree at run time, so the artifacts are
only meaningful with the revision they were built from. That revision is:

| item | value |
|---|---|
| base commit (`git rev-parse HEAD`) | `aabadaee6769273bf30e50adcfda59561cff50ec` (`aabadae`, “fix(panel): correct the seven behaviour bugs the review measured”) |
| `lib/client.js` captured bytes (`git hash-object`) | `9c3b1545f7ae0e03ed0deac2618985ef700de944` · 79,981 B · sha256 `50cbbeb6776c4a095b142cc126933b6bcd4b5fabbe02882d09d068298e79bb3a` |
| `lib/memory-panel.js` captured bytes (`git hash-object`) | `19fc3c7fd6e0684706e38a588ea0732156c98008` · 80,314 B · sha256 `0c3a08e78f7c7f64e0766f5afe13aeb8e3ea96ad120d902c81c012b2941ad1cb` |
| `git diff --numstat` vs HEAD | `lib/client.js` 15+/13−, `lib/memory-panel.js` 77+/24− — `2 files changed, 92 insertions(+), 37 deletions(-)` |
| embedded panel stylesheet sha256 | `ab577a09348d2b8401762e7ccf5de0cf29bafb3c8b153a8071448f7faa6cdbc9` |
| source-stability check | harness snapshotted both files before and after the run: **identical** (`stable=true`), so the PNGs were produced by exactly the bytes above |

Git object hashes are content-addressed: if the Lead commits these files unchanged,
the two blob ids above remain valid identifiers for the captured bytes even though the
commit hash and `HEAD` move — a later reader can match the artifacts to the commit’s
tree with `git rev-parse <commit>:lib/client.js` and the same for the panel module.

**The captured tree is HEAD (`aabadae`) plus the uncommitted run-2/round-3 edits**,
and the artifacts include these working-tree changes that postdate the previous
capture:

- `lib/client.js` — round-3/task-8: `.mem-search-input` now uses the host’s real
  `font: var(--dsw-font-xs-13)`; the retired `--dsw-font-xs-regular-13` is gone. The
  capture-page stylesheet is re-evaluated from this file every run, and the harness
  asserts the new token is present and the retired one absent (§5).
- `lib/memory-panel.js` — round 3: the flow block now draws **Sunday-first calendar
  weeks** (the same columns the heat map draws), the bar count/geometry/meta/the
  week-of-year title derive from that grouping, the stale heat-map `<title>` comment
  was corrected, and the task-13 follow-up derives the empty-flow sentence from the
  same week count (`lib/memory-panel.js:592` in the captured blob:
  `const empty = '近 ' + weeks.length + ' 周没有新建或更新记录。'`). The empty state is
  **not exercised by this non-empty fixture**; its presence changes no measured
  number here, but it is part of the captured revision.
- The record therefore supersedes the round-2 capture: that page embedded the
  pre-task-8 stylesheet (`font: var(--dsw-font-xs-regular-13)`) and the old 12-bar
  flow contract; both changed numbers below are re-measured, not edited by hand.

Revision evidence was produced with read-only git commands only
(`git rev-parse HEAD`, `git hash-object`, `git diff --stat`/`--numstat`); no git
write command was run.

## 2. What was captured

The **real view module**, not a reimplementation:

- `lib/memory-panel.js` → `createMemoryViews({ React })` → `OverviewView`, mounted
  with the same four-hook React stand-in `test/panel-ui.test.js` uses
  (`createElement`/`useState`/`useRef`/`useEffect`), composed props (`onMeta`,
  `onJump`, `visible`, `sessionId`), and a stubbed `fetch` that answers the real
  `{ sessionId, action: 'overview' }` request with one fixture payload shaped like
  `lib/panel-route.js:349-372`.
- The **real stylesheet**: the `/* panel-css:start */ … /* panel-css:end */` slice of
  `lib/client.js` is evaluated the way the bundle evaluates it (`[…].join('')`), not
  retyped. It includes the `max-width:292px` heat-grid cap and the current
  `--dsw-font-xs-13` search-input token.
- The **real shell body slot**: the view is wrapped in
  `<div class="mem-panel"><div class="mem-view" role="tabpanel" id="obsidian-mem-panel" …>`
  exactly as `lib/client.js:1136-1163` does. The tab strip and search box live in
  sibling rows and are not drawn (see §8).
- **Real host tokens**, not invented ones: `tokens.css` is generated from the
  installed DSH build — the static palette, the `body` light alias block, the
  `body[data-ds-dark-theme]` dark alias block and the font/shadow tokens. Dark mode
  is the host’s own `data-ds-dark-theme` attribute. The capture page therefore proves
  the dark values the host really ships (`rgb(255,255,255)` light /
  `rgb(21,21,23)` dark background were both measured in the computed style).

**Fixture** (`scratch/panel-capture/fixture.mjs`): 515 notes; 7 note types; 3
statuses; 10 distinct tags with varied counts; one queued + one failed job; an 84-day
activity window from **2026-08-07 (a Friday)** through **2026-10-29**. The Friday
start is deliberate: it is the unaligned-window case that once made the heat map drop
real days (review I1) and it is now also the case where the flow block must draw 13
calendar-week bars rather than a forced 12. The derived expectations are computed from
the view’s documented rules (13 calendar columns, 84 data cells, 7 void cells, 13
Sunday-first flow bars, created 38 / updated 14 / total 52 / net 24), not copied from
a screenshot or pasted from the round-3 report.

## 3. Exact commands

```bash
# 1. Extract the host theme tokens from the installed DSH build -> tokens.css
node scratch/panel-capture/extract-tokens.mjs

# 2. Render the real view to the two capture pages (light + dark)
node scratch/panel-capture/render-overview.mjs

# 3. Run the whole capture: tokens -> pages -> viewport emulation -> measure ->
#    screenshots -> checks + revision identity. Writes the PNGs, per-viewport JSON
#    and summary.json. Exit code 0 means all 220 checks passed and the source tree
#    held still during the run.
node scratch/panel-capture/capture.mjs
```

`capture.mjs` runs steps 1–2 itself, so step 3 alone reproduces everything. Final run
output (abridged):

```
source: head=aabadaee6769 client.js=9c3b1545f7ae memory-panel.js=19fc3c7fd6e0
--window-size probe: innerWidth=500 (expected 320 for a real 320px layout)
captured light @320px -> ...\capture-light-320.png (320x1679, 69720 bytes)
captured light @375px -> ...\capture-light-375.png (375x1610, 70076 bytes)
captured dark  @320px -> ...\capture-dark-320.png  (320x1679, 71669 bytes)
captured dark  @375px -> ...\capture-dark-375.png  (375x1610, 71795 bytes)

flow (round-3 Sunday-first calendar weeks):
 320 light bars=13 created=13 updated=12 viewBox=0 0 152 80  titles 32 周 · 新建 2 · 更新 1 … 44 周 · 新建 1 · 更新 0
 ...
source captured: head aabadaee6769 · lib/client.js 9c3b1545… · lib/memory-panel.js 19fc3c7f… · stable=true
embedded panel stylesheet sha256: ab577a09348d2b8401762e7ccf5de0cf29bafb3c8b153a8071448f7faa6cdbc9
checks passed: 220/220
```

Artifacts (`scratch/panel-capture/`, all git-ignored):

| Artifact | Size | Purpose |
|---|---|---|
| `capture-light-320.png` | 320×1679 · 69,720 B · `sha256:2f67466fa7209ffeaeea1a22801f1c856b43110190cda64b431bca71a2af28d5` | 320px light screenshot |
| `capture-light-375.png` | 375×1610 · 70,076 B · `sha256:36977467b9ed08879ffe68bf031868ed7fa55a31f563d3a6124d7b55294e1e21` | 375px light screenshot |
| `capture-dark-320.png` | 320×1679 · 71,669 B · `sha256:c615a642270c9d831f71cf31ea1ee1de5ad7242eb5ddd46f436cb9e425b29ce3` | 320px dark screenshot |
| `capture-dark-375.png` | 375×1610 · 71,795 B · `sha256:1fd1dacbd0905772e6646b51de66e032995fe22ea13e62c5786db703893053ee` | 375px dark screenshot |
| `measure-{light,dark}-{320,375}.json` | ~24 KB each | the full DOM measurement per viewport |
| `summary.json` | 12.8 KB | environment, captured revision, per-viewport floors/overflow/flow, all 220 checks |
| `window-size-flag-probe.json` | 602 B | the `--window-size=320` clamp evidence (§6) |
| `capture-light.html` / `capture-dark.html` | ~88.5 KB each | self-contained captures (real tokens + real stylesheet + view markup) |
| `fixture.mjs`, `render-overview.mjs`, `measure-inline.js`, `cdp.mjs`, `extract-tokens.mjs`, `capture.mjs`, `tokens.css` | — | the harness |

## 4. Measured numbers per width

Measurement viewport height 1200px, scrollbars hidden, devicePixelRatio 1. All
`clientWidth` values are CSS px. `.mem-view` `clientWidth` includes its own
`2×14px` padding, so its content box is 292px at a 320px viewport and 347px at 375px.

| theme | viewport innerWidth | `.mem-panel` | `.mem-view` | `.mem-heat-grid` | `.mem-flow` | `.mem-freq` | composition track | KPI band | `document.scrollWidth` | `.mem-view.scrollWidth` |
|---|---|---|---|---|---|---|---|---|---|---|
| light | 320 | 320 | 320 | **292** | **292** | **292** | **292** | **290** | 320 | 320 |
| light | 375 | 375 | 375 | **292** | **347** | **347** | **347** | **345** | 375 | 375 |
| dark  | 320 | 320 | 320 | **292** | **292** | **292** | **292** | **290** | 320 | 320 |
| dark  | 375 | 375 | 375 | **292** | **347** | **347** | **347** | **345** | 375 | 375 |

Supporting numbers (identical per width in both themes):

| reading | 320px | 375px |
|---|---|---|
| heat-grid computed `max-width` | `292px` | `292px` |
| heat-grid columns (computed `grid-template-columns` count) | **13** | **13** |
| heat cells / data cells / void cells | 91 / **84** / **7** | 91 / **84** / **7** |
| KPI sparkline points (`polyline` coordinates) | **12** | **12** |
| KPI band columns (`@container max-width:359px` in effect) | **2** | **4** |
| flow bars — one per Sunday-first calendar week | **13** | **13** |
| flow created rects / updated rects (last bar updated = 0) | **13 / 12** | **13 / 12** |
| flow SVG `viewBox` / shared zero line x2 | `0 0 152 80` / `152` | same |
| flow meta · SVG aria-label | `近 13 周净增 24` · `近 13 周新建 38 条，更新 14 条` | same |
| composition segments / legend rows | 3 / 7 | 3 / 7 |
| `.mem-view` horizontal padding | `14px` left + `14px` right | same |
| panel computed font | `12px`, `…"Segoe UI", sans-serif` | same |
| panel computed background | light `rgb(255,255,255)` / dark `rgb(21,21,23)` | same |

The 13 flow-bar titles, measured from the DOM (each title is the bar’s own
Sunday-first week-of-year, two digits; the counts are that calendar week’s
created/updated sums):

```
32 周 · 新建 2 · 更新 1    33 周 · 新建 3 · 更新 1    34 周 · 新建 4 · 更新 1
35 周 · 新建 3 · 更新 1    36 周 · 新建 3 · 更新 1    37 周 · 新建 3 · 更新 2
38 周 · 新建 3 · 更新 1    39 周 · 新建 4 · 更新 1    40 周 · 新建 3 · 更新 1
41 周 · 新建 3 · 更新 1    42 周 · 新建 3 · 更新 1    43 周 · 新建 3 · 更新 2
44 周 · 新建 1 · 更新 0
```

Independent cross-checks on those bars: created sums 38 and updated sums 14, which
equal the window’s series totals (nothing dropped); bar count 13 equals the heat-map
column count 13; the geometry is `13 × (8+4) − 4 = 152` in the 80-unit box; the last
bar has `updated = 0`, which is why 13 created rects but only 12 updated rects exist
(the zero side simply draws nothing, it is not a dropped week).

## 5. Acceptance: pass/fail

### §6.6 chart-container floor — **PASS**

Every chart container’s `clientWidth ≥ 280` at a 320px viewport, in both themes:

| container | 320px | 375px |
|---|---|---|
| `.mem-heat-grid` (M5 fix) | **292** | 292 (capped, centred) |
| `.mem-flow` | 292 | 347 |
| `.mem-freq` | 292 | 347 |
| `.mem-bar-track` (composition) | 292 | 347 |
| `.mem-kpiline` (KPI band, 1px border each side) | 290 | 345 |

The `lib/client.js` cap fix is confirmed as sufficient **and** correctly bounded: the
heat grid fills its 292px content box exactly at 320px (cap = content width, 12px of
headroom over the floor), while at 375px the cap holds it at 292px so the cell
squares do not stretch (the other charts use the full 347px).

### No horizontal overflow — **PASS**

- `document.documentElement.scrollWidth` equals the viewport exactly: 320 at 320px,
  375 at 375px — no document-level horizontal scroll.
- `.mem-view` (the `overflow:auto` body) `scrollWidth === clientWidth`: 320 = 320,
  375 = 375. No inner horizontal scroll either.
- No element paints outside the viewport: the measurement script walks every
  `body *` element and compares each paint box with the viewport; `wideElements` is
  `[]` in all four runs.
- Stress check with a real (non-hidden) classic scrollbar engaged — 600px-tall
  viewport, so `.mem-view` actually scrolls, measured scrollbar width 10px:
  - 320px: heat grid **282**, flow **282**, track **282**, KPI band **280**;
    `document.scrollWidth` 320, no wide elements. **Still passes the 280 floor.**
  - 375px: heat grid 292, flow 337, track 337, KPI band 335. Passes.
  - Note the zero margin on the KPI band in the 320px scrollbar case (§9 F3).

### Captured stylesheet identity (review2 M-9) — **PASS**

The page is rebuilt from the current source on every run, and the harness now checks
the embedded stylesheet itself instead of trusting the file path:

- `font:var(--dsw-font-xs-13)` present → yes; the retired
  `--dsw-font-xs-regular-13` absent → yes; `max-width:292px` heat-grid cap present →
  yes. Embedded stylesheet sha256:
  `ab577a09348d2b8401762e7ccf5de0cf29bafb3c8b153a8071448f7faa6cdbc9`.
- The harness also snapshots `git hash-object`-style SHA-1s of `lib/client.js` and
  `lib/memory-panel.js` before and after the run and fails if either moved; the
  recorded run is `stable=true` (§1).

### Specific fixes re-captured at 320px/375px — **PASS**

| review finding / spec quote | evidence at 320px (and 375px) |
|---|---|
| I1 — heat map must draw the whole window: 84 days must give 84 data cells, not 82 | 13 calendar columns, **84 data cells**, meta **“近 13 周（84 天）· 本周 3 天有更新 · 合计 52 条”**; 52 = fixture created 38 + updated 14. The head 5 void cells (Friday start) and 2 tail void cells are drawn as gaps, not dropped data. |
| round-3 flow / review2 I-1 — a bar must be the calendar week it names, and the printed count must match the picture | **13** bars = the same 13 Sunday-first weeks the heat map draws; meta **“近 13 周净增 24”** (38 − 14) now prints the bar count, not a hard-coded 12; SVG aria-label “近 13 周新建 38 条，更新 14 条”; titles 32…44 carry each week’s own created/updated sums (sums 38/14 = window totals). |
| §3.4 item 2 / §6.5 — void cells `aria-hidden`, no focusable cell | **7/7** void cells carry `aria-hidden="true"`; **91/91** cells have no `tabindex`; grid is one `role="img"` with aria-label “近 13 周活动，共 52 条，峰值 3”; legend aria-hidden. |
| I5 / §6.5 — heat cell reading must be date · value and reachable in HTML | **84/84** data cells carry `title="YYYY-MM-DD · n 条"` matching `/^\d{4}-\d\d-\d\d · \d+ 条$/u` and the same sentence on `aria-label`; no inert `<title>` child inside the cell. (Tooltip rendering itself is outside this capture — §8.) |
| M6 / §3.4 item 1 — sparkline must be 12 weekly cumulative points, not 84 daily | `polyline` has **12** coordinate pairs, ends at the created total, aria-hidden; spread over the cell’s own row (125px wide at 320, 66px at 375). |
| M7 / §3.4 item 3 — flow-bar `<title>` must be `WW 周 · 新建 n · 更新 m` | **13/13** titles match the pattern and the Sunday-first week-of-year convention; first `32 周 · 新建 2 · 更新 1`, last `44 周 · 新建 1 · 更新 0`; one shared zero line spanning `0→152`. |
| I4 — composition three-segment cap must be real | **3** segments with three distinct tint classes, **7** legend rows (all types still listed), segment widths 237.8+34.09+20.11 = 292.0 = the track width; status folded to one line “生效 500 · 待确认 10 · 有争议 5”. |
| narrow-panel layout (`@container` in `lib/client.js`) — KPI band responds | 2 columns at 320px, 4 at 375px; values `515 / 8 / 12 / 2`. |

Harness self-check: **220/220** assertions pass — the previous 196 plus the round-3
flow-geometry/aria checks, the three embedded-stylesheet checks, and the
source-did-not-move check. Failures include viewport identity (`innerWidth ===
320/375`), screenshot dimensions, theme application, and revision stability; the
harness exits non-zero on any mismatch (it does not degrade to warnings).

## 6. Why the capture does not use the literal `--window-size` command

The suggested command was attempted once and measured
(`window-size-flag-probe.json`):

```
"C:\Program Files\Google\Chrome\Application\chrome.exe" --headless=new --disable-gpu \
  --hide-scrollbars --window-size=320,1200 --dump-dom file:///…/capture-light.html
→ page viewport measured: innerWidth = 500, innerHeight = 1105, dpr = 1
```

Chrome clamps a real window to a ~500px minimum, so the page lays out at **500 CSS
px** and a 320px screenshot merely crops that layout (4-col KPI band, clipped right
edge). That is how a capture can look plausible while measuring the wrong width. The
harness therefore sets the viewport with CDP
`Emulation.setDeviceMetricsOverride` (the DevTools device-toolbar mechanism) and
captures with `Page.captureScreenshot`; the page’s own `innerWidth` is recorded in
every measurement JSON. Any future visual validation of this panel should do the same.

## 7. Screenshots — inspected, not just produced

All four PNGs were re-opened with the image-reading tool after this run:

- **`capture-light-320.png`** (320×1679): KPI band in a 2×2 grid with the sparkline
  under 515; 13-column heat map fully inside the body with visible calendar gaps at
  the head, all 84 data squares visible, legend “少 … 多”; the flow block now shows
  **13 calendar-week bars** under the meta “近 13 周净增 24” — 13 green created bars
  and blue updated bars below the shared zero line, with the rightmost (last) bar
  **created-only** (a short green stub above the zero line, no blue band under it),
  which is the `updated = 0` week; composition track with 3 tints, 7 legend rows and
  the status line; 8 tag rows with bars and the “另有 2 个标签” tail; recent list and
  health band. No clipped text, no horizontal cut-off, no scrollbar.
- **`capture-light-375.png`** (375×1610): same sections; KPI band is now 4 across;
  heat map stays 292px wide and is centred in the wider body (the M5 cap doing its
  job); the 13 flow bars are spaced wider but still 13 with the same last-bar
  created-only shape; flow/ranking/composition use the full 347px. Nothing clips.
- **`capture-dark-320.png`** (320×1679) and **`capture-dark-375.png`**
  (375×1610): the same geometry on the host’s dark palette (`rgb(21,21,23)`
  background); heat-map tints, flow green/blue, borders, secondary text and the
  sparkline all remain legible against the dark surface; no light-only leftovers.
  Values, labels, bar counts and totals identical to light.

Titles/labels are legible at 1× in both themes; the 11–12px metadata is small but
crisp (Segoe UI at dpr 1). The screenshots are the view body only — the shell’s tab
strip and search box are absent by design (§8).

## 8. What this does NOT verify

- **The host *cascade*.** Token names and values come from the installed DSH build,
  but they are applied by a static page. Not verified: user-customised themes /
  accent overrides, runtime theme switching, and the host’s own embedded Chromium
  (measured here with Chrome 154 headless; sub-pixel layout or font-raster
  differences from the host window are possible). The page reproduces `<body>` light
  and `<body data-ds-dark-theme>` dark exactly as the host declares them, but not the
  host’s surrounding application CSS.
- **The real vault.** The payload is a fixed fixture. It is representative (515
  notes, 7 types, 10 tags, 84-day unaligned window) but not a live index read, so it
  does not verify the route’s SQLite/in-memory aggregates — only the views’ layout
  and drawing of a valid payload.
- **The host sidebar’s own width.** The page width equals the panel width equals the
  viewport. If the real sidebar is narrower than the viewport (host chrome around the
  panel), every container width moves down by that amount. The capture verifies the
  design’s 320px support floor (`320 − 2×14 = 292`), not a host chrome measurement.
- **Shell chrome**: `mem-tabbar` (tab strip) and `mem-searchbar` (search box) are not
  rendered. They are sibling rows and cannot change the body’s width, but their own
  layout, hover/focus states, and the search input’s rendering (which now uses the
  current host font token in the embedded stylesheet, §5) are not covered here.
- **Empty / zero-series states and the round-3 empty-flow sentence.** The fixture is
  non-empty, so the empty chart paths (including the task-13 derived
  “近 N 周没有…” sentence present in the captured revision) are code-level only, not
  exercised.
- **The other views** (图谱/健康/SearchView) and the mutation confirmation sheet.
- **Interactive states**: hover, focus-visible, refresh/polling, tooltip rendering
  (the heat-cell `title` attributes are verified present; the native tooltip does not
  appear in a screenshot), reduced-motion, and `document.hidden` behaviour.
- **DPI scaling**: captured at devicePixelRatio 1; Windows 125%/150% scaling is not
  covered (the research file flags sub-pixel risk for the 1–2px rules at scaling).
- **Long-content resilience**: very long tag names/titles truncate via CSS ellipsis,
  but the fixture does not stress the extreme lengths.
- **The React stand-in**: the views are the real code, but React is a hand-written
  four-hook stand-in (as in `test/panel-ui.test.js`) and the DOM serializer is
  hand-written. It mirrors React’s attribute semantics (`className`→`class`,
  camelCase SVG attributes, `aria-hidden={true}`→`"true"`), but it is not the host’s
  React build; DOM shape could differ in ways this harness cannot see.

## 9. Findings

**F1 — the documented `--window-size` capture recipe cannot produce a 320px layout
(method note, not a product defect).** Measured: `innerWidth = 500` for
`--window-size=320,1200` (§6). Anyone re-running the CHANGELOG-era recipe without
device emulation gets a 500px layout cropped to 320px, which can silently “verify” a
grid that never saw a 320px viewport. Use CDP/DevTools emulation and check the page’s
own `innerWidth` (it is recorded in every `measure-*.json`).

**F2 — RESOLVED in the captured revision (kept for provenance).** The round-2 capture
embedded the pre-task-8 stylesheet: `.mem-search-input` then used
`font: var(--dsw-font-xs-regular-13)`, a token the installed DSH build does not
define (the host’s token is `--dsw-font-xs-13`). The captured revision now carries
`font: var(--dsw-font-xs-13)`, the retired token is gone from `lib/client.js`, and
the harness asserts both facts against the embedded stylesheet (§5). The search box
is still not part of a 概览 capture, so this is proven at the stylesheet level, not
by a screenshot of the input.

**F3 — the KPI band clears the 280px floor with zero margin when a real scrollbar
is engaged at 320px (risk note).** Stress measurement: with a 10px classic vertical
scrollbar and a scrolling `.mem-view`, the heat grid/flow/track measure 282px and
`.mem-kpiline` measures exactly **280px** (its 2px of border consume the rest of
282px). It passes, but there is no slack left on that container. If the host adds
chrome that narrows the panel, or a platform uses a wider classic scrollbar, the KPI
band can fall under the floor even though the heat-grid cap is correct. The records
above are the baseline to re-check against if the panel’s host width changes.

## 10. Reproduce / clean up

Everything is git-ignored and re-creatable from `node scratch/panel-capture/capture.mjs`
(idempotent: it regenerates `tokens.css`, the two pages, the four PNGs and the JSON
records, and it snapshots the captured revision itself; Chrome profile dirs live under
`scratch/panel-capture/chrome-profile*`). The harness fails if the source files move
during the run, so a future reader can trust the recorded `git hash-object` values.
No `git` write command was run and nothing outside `scratch/` and this record was
written by the capture task. The capture pages are self-contained; opening
`capture-*.html` directly in a browser reproduces the layout at that window’s width.

**Verdict:** at a true 320px viewport the heat-map box is **292px** (§6.6 floor 280 →
pass, +12px), all chart containers are ≥280px, nothing overflows horizontally
(document and inner scroll widths equal the viewport, no wide elements), the heat map
draws all 84 window days as 13 honest columns, void cells are aria-hidden, the KPI
sparkline is 12 weekly points, and the flow block draws **13 Sunday-first calendar
weeks** — one per heat-map column, with titles `32…44 周 · 新建 n · 更新 m` whose sums
equal the window totals (38 created / 14 updated), meta “近 13 周净增 24”, and the
composition cap is three real segments — in both light and dark, against the captured
revision named in §1 (HEAD `aabadae` + the round-3 working-tree edits). The
CHANGELOG’s “not re-captured at 320px” claim is verified for the real view component;
the residual gaps are the ones listed in §8.
