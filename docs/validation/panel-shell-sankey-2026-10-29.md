# Panel shell + 构成 Sankey — independent measurement record (2026-10-29)

Verifier record for the run `2026-10-29-panel-shell-and-composition`. Every number below came
from a command in this file; the artifacts are git-ignored scratch files under
`scratch/panel-capture/`. Source bytes measured (sha256, verified with `sha256sum`):

| file | sha256 |
| --- | --- |
| lib/client.js (pre-fix baseline snapshot) | `50cbbeb6776c4a095b142cc126933b6bcd4b5fabbe02882d09d068298e79bb3a` |
| lib/client.js (frozen, fix wave 1) | `2f9982cd92917994474c32f6a2c3f9ff3ed4f9907d0bac2469a6475d5ec9b420` — superseded by the FINAL section below |
| lib/memory-panel.js (frozen, fix wave 1) | `85dbe763b485dfdb8552db8c9a9a987ad335ff8b542ff8487dfe6cbeb82fd9ef` — superseded by the FINAL section below |
| lib/client.js (FINAL, fix wave 2) | `9efeebe924c74c520fe6af5cf7ddab0d59560b776c40489956fde3ecb0a4d9a3` |
| lib/memory-panel.js (FINAL, fix wave 2) | `f9d48b1ba9817fe9281b587d9fde01671a19c597c319a38b7909fa8d6dbc040d` |
| test/panel-ui.test.js FINAL | `4dc438bcff6b8ff34e9fe45f49bac2289677e50b9c5ee4d35a38a2e7cb93c414` |
| test/panel-client.test.js FINAL | `aaba6b9feb1ea3d21a2c531fa63a72c2b801f2c0b40ac8eefbd95a8a3eeb4dff` |
| test/architecture.test.js FINAL | `4554576afe9cda83f9c1f23aceb8d4f8e58e25d03fc07d61c52ccb06abe371af` |
| lib/index-db.js (frozen post-fix) | `7573ddb1c502623f6f88fdb8c625ad1254c2079289e6e53e99602ee4c7f3805d` |
| lib/panel-route.js (frozen post-fix) | `6371e9370691bf15d213f3967f8c0c926f01fd917eba130501e839e25a6f0a53` |

Baseline bytes are pinned in `scratch/panel-capture/shell/baseline-src/`; all Phase A numbers
were taken from that snapshot, which the harness can never race against a source edit.
The capture pages record the exact client.js hash they rendered (`<prefix>-page-meta.json`) and
the Sankey capture aborts if the two source files move while it runs (it did once, and was
re-run on the frozen bytes; the final run reports `stable=true`).

## 1. Shell: real `MemoryTabs` + `SearchBox` in headless Chrome

### Harness

`lib/client.js` is evaluated in a real (headless) Chrome page against a DOM-producing React
stand-in and a fake `betterSidebar`, then the registered tab component is mounted with
`{scope:{sessionId:'probe'}, visible:true}` — the same wiring the host uses. Tokens are the
measured host theme (`scratch/panel-capture/tokens.css`, extracted from the installed DSH
build), the panel stylesheet is the real `PANEL_CSS` slice of lib/client.js evaluated as the
bundle does, and the component's own `injectPanelCss()` dedupes on the marker the page
pre-creates. The shell's dynamic import of `/obsidian-mem/memory-panel.js` rejects under
`file://`; the failure notice renders in the body slot and cannot affect the tab strip or the
search box (both are shell chrome).

Chrome 154.0.8037.98, viewports 646 / 659 / 320 px wide (CDP
`Emulation.setDeviceMetricsOverride`), dark and light.

Commands:
```
PANEL_PREFIX=shell PANEL_CLIENT_SRC=scratch/panel-capture/shell/baseline-src/client.js \
  node scratch/panel-capture/shell/build-pages.mjs
PANEL_PREFIX=shell PANEL_CONTRACT=baseline node scratch/panel-capture/shell/capture-shell.mjs
PANEL_PREFIX=live PANEL_CLIENT_SRC=lib/client.js node scratch/panel-capture/shell/build-pages.mjs
PANEL_PREFIX=live PANEL_CONTRACT=fixed node scratch/panel-capture/shell/capture-shell.mjs
node scratch/panel-capture/shell/compare-focus.mjs
node scratch/panel-capture/shell/analyze-png.mjs          # the user's screenshots
node scratch/panel-capture/shell/control-plain.mjs        # plain-page controls, below
```
Result: baseline contract 226/226 checks pass on the fix-wave-1 bytes (232/232 after the
tokens.css fixture correction), post-fix 238/238 on fix-wave-1 and 244/244 on the FINAL bytes
below (every reported defect reproduced on the baseline; every fixed contract met after the fix). Artifacts: `shell-summary.json`, `live-summary.json`,
`shell-<theme>-<width>.json`, `live-<theme>-<width>.json`, `*-focus-click*.png`,
`focus-compare.json`, `control-plain.json`, `user-analysis.json`.

### The user screenshot is a 646px crop of a 659px-wide panel

Pixel-decoding `scratch/panel-capture/user/searchbox.png` (independent of the brief's numbers;
`analyze-png.mjs`): the blue focus indicators cross mid-row y102 at x11, x42–43, x571–572, x579
and mid-column x295 at y80–81, y83, y122, y124–125. That is field border-box x11..579 y83..122
(569×40, rounded ring) plus a square outline x42..572 y80..125 (the input's own outline: input
box inset 35px from the field, outline 2px at offset 2px). The whole row also decodes only if
the panel is 659 CSS px wide: field 569 = 659−90, submit 54px at x588..641, right padding would
be 14 → 659. The screenshot is therefore a crop starting 3px into the panel with the right 13px
cut off. At a 659px viewport the baseline capture reproduces the user geometry exactly (field
border-box 569×40 at x14, outline bbox x45..575 y49..94 = user x42..572 y80..125 shifted by the
3px crop and the 31px host TabBar row above the panel). 646px is still measured because it is
the screenshot width; 659px is the honest arithmetic comparison.

### Focus ring: exactly one indicator after the fix

Baseline (pinned snapshot) reproduced the reported defect. With a real CDP mouse click on the
input (the interaction in the user's screenshot), Chrome matched `:focus-visible` and painted
TWO blue indicators: the rounded field ring (`:focus-within` border colour, 1px, radius 10px)
and the input's own square outline (2px solid, offset 2px, border-radius 0). Computed styles:
`.mem-search-input` `outline: rgb(122,170,255) solid 2px`, `outline-offset: 2px`; a
programmatic `.focus()` in a document with no prior user input does not match
`:focus-visible` (see controls), which is why the baseline capture focuses by real click/keyboard.

Post-fix measured on the frozen bytes (`live-<theme>-<width>.json`, `focus-compare.json`):

| width | field box | painted indicator (computed) | outline bbox | horizontal scan | vertical scan | inner-square side columns (blue px) | inner-square corner ink |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 646 | 14,58 556×40 | 1: `.mem-search-field`, 2px solid business blue, offset 0, radius 10px | 12,56 560×44 | 2 strokes (was 4) | 2 strokes (was 4) | 0 (baseline 100, user PNG 96) | 1/64 (rounded, antialias; baseline square 43/64) |
| 659 | 14,58 569×40 | same | 12,56 573×44 | 2 (was 4) | 2 (was 4) | 0 | 1/64 |
| 320 | 14,58 230×40 | same | 12,56 234×44 | 2 (was 4) | 2 (was 4) | 0 | 1/64 |

Both themes identical apart from the token colour (dark `rgb(122,170,255)`, light
`rgb(65,118,230)`). Ring thickness 3px per side = 1px blue border (`:focus-within
border-color`) + 2px outline at offset 0. The focused input's own outline is `none`, and the
panel's painted-outline inventory contains exactly one element (`.mem-search-field`).
Every interaction that used to paint two was re-measured: real mouse click on the input, click
on the icon, click on the field padding, and keyboard Tab focus — all one indicator.

### Click target

Real CDP mouse clicks inside `.mem-search-field` now focus the input: icon centre, left
padding (x = field.left+5), right padding (x = field.right−5) and the text area all end with
`document.activeElement === .mem-search-input` in all six theme×width runs. Baseline: only the
input element itself focused; icon/padding clicks left `activeElement` on `BODY`.

### IME + Enter: production path does not submit; the first "submit" was a dispatch artifact

`:focus-visible` and IME dispatch were both isolated on a plain form page in the same headless
Chrome (`control-plain.mjs`, `control-plain.json`):

* `:focus-visible` — JS `.focus()` with no prior input event: no focus-visible (the headless
  document has no focus; `document.hasFocus()===false`); real CDP mouse click on the field, Tab
  from the body, and JS focus after any real input: focus-visible true. This is why the baseline
  double ring is captured through a real click — the same interaction as the screenshot.
* IME dispatch form (Chrome 154): `Input.imeSetComposition('绑定')` then
  `Input.dispatchKeyEvent{type:'rawKeyDown', key:'Enter'}` → keydown `isComposing=true`,
  **submits 0**, and with `preventDefault` removed the page does not navigate (no submission
  starts). The same composition then `{type:'keyDown', text:'\r'}` → **submits 1**; and
  `rawKeyDown` with no composition also gives submits 0 (implicit submission is driven by the
  character-event path in this Chrome). The raw-key form is the production model (a real OS
  IME confirm); the text-bearing form is a scripted-dispatch artifact.
* Shell capture re-run with the production form: `productionSubmits = 0` in all six
  theme×width runs with keydown `isComposing=true`; the synthetic-char variant is kept as a
  separately labelled artifact (`syntheticCharSubmits = 1`). No panel guard is needed or
  requested; the earlier "IME submits" claim was the artifact and is superseded here.

### Tabs (ours vs the host's)

The row this record measures is the repo's `.mem-tabbar > .mem-tabs > button.mem-tab`
(概览/图谱/健康). The 记忆 × + row in the user screenshot is dsh-better-sidebar's TabBar, not
this repo — measured only for context: 31px strip band, 28px tab, ~100px tab width
(`user-analysis.json`).

| metric | baseline @646 | fixed @646/659 | fixed @320 |
| --- | --- | --- | --- |
| tab rect | 66×32 (x14, y6) | 76×36 (x14/92/170, y8) | 54×36 (x14/70/126) |
| row gap | 0px | 2px | 2px |
| margin-left (folder overlap) | −8px | 0px | 0px |
| max-width | 132px | 180px | 180px (content 54, cap not exercised) |
| padding | 0 10px | 0 14px | 0 14px |
| icon | 15×15 | 16×16 | display:none (container query) |
| tabbar height / top padding | 38px / 6px | 44px / 8px | 44px / 8px |
| `.mem-tab::after` hit area | 44px (top −12) | 44px (top −8) | 44px (top −8) |

The row stays Chrome-like in kind (bigger leaves, real 2px gaps, 44px hit area) while remaining
content-sized; the 180px max-width is unexercised by these three labels, so this capture cannot
prove how a longer label truncates — covered by the CSS contract test.

## 2. 概览 Sankey (both themes, 320 and 375 px)

Commands:
```
node scratch/panel-capture/render-overview.mjs
node scratch/panel-capture/capture.mjs
```
`capture.mjs` renders the real `createMemoryViews({React}).OverviewView` from
lib/memory-panel.js with the fixture payload (counts.notes 515, 7 types, 3 statuses, 12 joint
type×status rows), in exactly the shell's body slot, with the real stylesheet + measured tokens.
Fix-wave-1 result: **312/312 checks pass**, all four rows (light/dark × 320/375), source
`stable=true`. The FINAL fix-wave-2 run is **328/328** (see the FINAL section below). Artifacts: `summary.json`, `measure-<theme>-<width>.json`,
`capture-<theme>-<width>.png`.

Measured geometry (identical in both themes; `sankey-summary.json`):

| width | content box | svg | viewBox | nodes/links | type column | status column | distinct fills | titles |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 320 | 292px | 292×200 (1:1) | 0 0 292 200 | 10 / 12 | Σ=164, top 6 | Σ=164, top 14 | 8 | 32 |
| 375 | 347px | 347×237.66 (scale 1.188) — superseded by the FINAL section: now 292×200 capped and centred | 0 0 292 200 | 10 / 12 | Σ=164, top 6 | Σ=164, top 14 | 8 | 32 |

The unit is `(200−12−6×4)/515 = 164/515 = 0.3184466` px per note (one vertical unit = one
note). Checks with measured detail:

* node heights: every one of the 10 node rects = printed count × unit (max |height−n·unit| <
  0.02px); type node gaps exactly 4 units; the taller column's gaps set the unit for both
  columns, so both columns sum to 164 units; left column starts at 6, the 3-row status column is
  centred at 14.
* links: 12 closed band paths; every band's thickness = printed count × the same unit at BOTH
  ends (max error < 0.02px); each node's outgoing/incoming bands sum to its own height
  (max |Σbands−height| < 0.02px); band x1=84, x2=204 from the 292 coordinate space.
* totals: left column counts 420+60+20+8+4+2+1 = 515, right column 500+10+5 = 515; the section
  meta prints "515 条"; printed values 420/60/20/8/4/2/1/500/10/5 match the node titles.
* text: 10 labels + 10 values; 22 mark titles (10 nodes + 12 links) + 10 label titles = 32
  <title> elements, all unique; labels/values never paint outside the 292×200 viewBox; pixel
  scan of the two label columns finds 7 separate painted lines on the type side and 3 on the
  status side at every width/theme (no visual collision); no label is clipped in this fixture
  (the truncation path is covered by the unit test with a long type name).
* aria: one `role="img"` SVG with `aria-label="构成桑基图：共 515 条"`; no mark is focusable.
* floor: at 320 the view content box is 292px and the svg is exactly 292px wide; document
  scrollWidth = 320, no element paints outside the 320px viewport; the stress run with a real
  (non-hidden) 10px scrollbar at 600px tall still gives every chart container ≥282px. At 375 the
  svg fills the 347px content box and still does not overflow.
* fallback honesty: with the fixture's real joint flow the Sankey replaces the stacked bar
  (`mem-bar-track` count 0); the inconsistent-margin and empty-flow cases fall back to the bar
  and are covered by node unit tests (not by this browser capture). The route's trimmer drops
  `flow` whole before halving `byType`/`byStatus` (lib/panel-route.js:713–721), so a trimmed
  payload shows the old bar rather than a chart whose link sum disagrees with its printed totals.

### Bug found by this capture during the run

The first Sankey capture run (memory-panel.js 98eb6390…) failed the label-row check: the
single-pass `sankeyLabelRows` could leave rows non-monotonic in the sliver cluster (the
fixture's 6 lower-left labels); painted ink rows were separated at 320 but the font-box rows
were not. The Lead fixed it with the forward-pass/clamp/backward-pass layout and raised the
label gap to 16 units so the 375px 1.188× upscale cannot close the ink gap; the frozen run
above is the verified result. (A colour collision — status nodes reusing the `is-seg3` type
tint — was found by the same run and fixed to a 72% neutral; measured distinct fills = 8.)

## 3. What this capture cannot prove

* **Physical IME behaviour.** The dispatch-form control shows what Chrome does with a raw
  keydown versus a synthetic char event; whether a given OS IME consumes Enter before the page
  sees any key cannot be observed from CDP/headless. No defect was reproducible in the
  production-model path.
* **The real React renderer.** The shell page mounts the real components through a DOM-producing
  React stand-in, not ReactDOM: hooks and DOM are real, but reconciler-specific behaviour is not
  exercised. The 概览 page is server-side serialization of the real view tree.
* **Host integration.** The host dsh-better-sidebar wrapper (its TabBar, its layout) is not part
  of this repo and is rendered by neither page; the 记忆 × + row is measured only from the user
  screenshot.
* **Live theme differences.** Tokens are `tokens.css` extracted from the installed DSH build;
  the live web GUI answers 401 so its asset CSS could not be fetched to compare. The first
  fixture FORGOT `--dsw-font-xs-13` even though the installed build defines it
  (`grep -a -o -- '--dsw-font-xs-13:[^;]*;' "<app.asar>"` → `--dsw-font-xs-13:13px/20px
  var(--dsw-font-family);`, 11 occurrences); that made `.mem-search-input`'s valid `font`
  shorthand invalid at computed-value time and it inherited 12px. The fixture now extracts the
  token: `tokens.css` resolves 22/22 panel tokens (none undefined) and the input measures
  13px/20.8px. This was a harness-fixture defect, not a lib/ defect.
* **Trim behaviour at the byte ceiling.** The trimmer is verified by node tests, not by the
  browser capture: the fixture payload is far below the ceiling, so the page always draws the
  full Sankey and never exercises the trimmed/fallback wire.
* **Fonts/AA across hosts.** Label ink scanning depends on the installed CJK font and
  antialiasing; the recorded numbers are for this Windows host.

## Commands run for this record (all exit 0 unless noted)

```
node scratch/panel-capture/shell/analyze-png.mjs
node scratch/panel-capture/shell/control-plain.mjs
PANEL_PREFIX=shell PANEL_CONTRACT=baseline node scratch/panel-capture/shell/capture-shell.mjs   # 226/226
PANEL_PREFIX=live  PANEL_CONTRACT=fixed    node scratch/panel-capture/shell/capture-shell.mjs   # 238/238
node scratch/panel-capture/shell/compare-focus.mjs
node scratch/panel-capture/render-overview.mjs
node scratch/panel-capture/capture.mjs                                                         # 312/312
```

Panel client test file (contract the implementation must keep): test/panel-client.test.js
includes the exact stylesheet strings asserted here (the `:focus-visible{outline:none}` input
rule, the field `:focus-within` ring, the 36px/2px-gap/180px-cap tab row, the 8 Sankey class
names and the `is-status`/`is-seg0` contract); test/panel-ui.test.js asserts the Sankey's
drawn geometry (exact `d` strings, node y/height, link thickness sums, label ordering) and the
sliver-cluster label regression; test/index-stats.test.js asserts both backends' joint flow and
its margins; test/panel-route.test.js asserts the all-or-nothing flow trim.

## FINAL re-verification — fix wave 2 (frozen bytes)

Frozen sha256: lib/client.js `9efeebe924c74c520fe6af5cf7ddab0d59560b776c40489956fde3ecb0a4d9a3`,
lib/memory-panel.js `f9d48b1ba9817fe9281b587d9fde01671a19c597c319a38b7909fa8d6dbc040d`,
test/panel-ui.test.js `4dc438bc…`, test/panel-client.test.js `aaba6b9f…`,
test/architecture.test.js `4554576a…` (line counts: client 1310, memory-panel 2417 — budget 2450).

Commands (re-run on the frozen bytes):

- `PANEL_PREFIX=shell PANEL_CONTRACT=baseline node scratch/panel-capture/shell/capture-shell.mjs` → 232/232
- `PANEL_PREFIX=live PANEL_CONTRACT=fixed node scratch/panel-capture/shell/capture-shell.mjs` → 244/244
- `node scratch/panel-capture/render-overview.mjs && node scratch/panel-capture/capture.mjs` → 328/328
- `DSH_HOME=$(mktemp -d) node --test test/architecture.test.js test/panel-client.test.js test/panel-ui.test.js test/index-stats.test.js test/panel-route.test.js` → 128/128

What changed, measured:

* **Width cap (fix for the 375px upscaling).** The chart is now **292×200 at BOTH 320 and 375**
  (`.mem-sankey{width:100%;max-width:292px;margin-inline:auto}`). At 375 the content box is
  347px, the capped chart sits at x41.5 with 27.5px gutters on both sides (centred), and the
  11px type renders 1:1 instead of 13.07px. The capture's old 1.188× height check is replaced by
  a strict 292×200 assertion.
* **Leader lines (fix for the detached sliver labels).** 8 leaders measured:
  type-side rows 112/128/144/160/176/192 at x74 → node centres 153.3009708737864 /
  170.0388349514563 / 178.49708737864074 / 184.40776699029124 / 189.36310679611648 /
  193.84077669902908; status-side x214: 176 → 178.81553398058253 and 192 →
  185.20388349514565. Each starts on a displaced label row and ends on its mark's centre
  (checked within 0.01); the two aligned rows get none; the x sits in the value/node gutter
  (crosses no band or node); the stroke resolves to the 1px `--dsw-alias-border-l2` token
  (light rgba(0,0,0,0.1), dark rgba(255,255,255,0.12)).
* **Total guard.** `sankeyModel` now refuses a payload whose cross-column totals disagree or
  whose integer `counts.notes` differs from the flow total (lib/memory-panel.js:900-907); the
  fallback bar answers. The notes-mismatch case has a unit test (panel-ui:1354); the
  cross-column guard stays defence-in-depth without a direct test — observation, not a blocker.
* **tokens.css fixture correction (harness defect, not lib/).** The installed build defines the
  token the panel consumes: `grep -a -o -- '--dsw-font-xs-13:[^;]*;' "<app.asar>"` →
  `--dsw-font-xs-13:13px/20px var(--dsw-font-family);` (11 occurrences). The first tokens.css
  fixture omitted it, so the input's `font` shorthand was invalid at computed-value time and
  inherited 12px. `extract-tokens.mjs` now extracts the token and fails loudly on a missing
  required one; regenerated tokens.css resolves **22/22** panel tokens with
  "undefined in host: none"; the re-measured search input is **13px / line-height 20.8px** (new
  shell check passes in all six runs).
* Shell numbers otherwise unchanged: one focus indicator, click-to-focus on icon/padding,
  production-model IME 0 submits, 36px tab leaves / 2px gaps / 44px hit area / container-query
  icon hide. Baseline 232/232 and post-fix 244/244 checks pass; targeted suite 128/128
  (architecture 8, panel-client 18, panel-ui 48, index-stats 26, panel-route 28).
