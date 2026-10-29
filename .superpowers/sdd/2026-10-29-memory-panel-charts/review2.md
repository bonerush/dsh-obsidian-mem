# 记忆面板 v0.4 图表化 — 独立复核（第 2 轮，只读）

**Range:** `aabadae` plus the uncommitted working-tree diff — 9 files, +804/−144, no
commits (`git log aabadae..HEAD` is empty by construction). Untracked run records:
`progress.md`, `task-A-report.md`, `task-B-report.md`, `task-C-report.md`, this file.
**Contract:** the committed review `review.md` (written at b36d02a, committed in
aabadae). The frozen spec it cites is not in this checkout — `docs/` is git-ignored
(`.gitignore:20`) and the originating session's files did not travel — so the
ledger's "Record gap" ruling stands and the review's quoted clauses are the standard
applied here. I did not invent spec text.
**Reviewer:** independent, read-only. Read-only git only; no `lib/`, `test/` or
`CHANGELOG` edits; behavioural and mutation probes ran from `/tmp` copies; this file
is the only repository write.

## Verdict

The second fix wave does close the twelve Minor findings, the missing 320px
measurement and the invented host token, and every headline number it prints
reproduces. All eight suites I ran are green, and the seven counts the CHANGELOG names
reproduce exactly; `2839 / 2010 / 1262` are the real formatted line counts; the 24-name token
allowlist is exactly the set of `var(--dsw-*)` the bundle reads, and every one of the
24 is defined in the installed host build (405 `--dsw-*:` names; zero occurrences of
the retired `--dsw-font-xs-regular-13`); and the capture artifacts actually contain
the record's numbers (196/196 checks, heat grid `clientWidth` 292 at a true emulated
320px). The Minor prose fixes are accurate against the code, M4/M6/M7 are guarded by
tests I could falsify by mutation, and M11's silent no-op is now a reported skip in
both files. But I cannot sign this off as-is: (1) the new flow-bar `<title>` names an
ISO week the bar itself does not cover — the bar is a trailing seven-day chunk, so the
fixture's "32 周" bar aggregates 2026-08-07..13, four of whose seven days are ISO week
33 — which is the I1/I2 printed-number-vs-picture defect in the one annotation M7
was meant to fix; (2) the M10 "guard" is still a frozen literal that only reads
`lib/client.js`, so it cannot fail when the views add or rename a class, and the
CHANGELOG's "a rename on either side fails" is not true (proved by probe); (3) the
320px validation record the CHANGELOG makes the evidence for M5/§6.6 is git-ignored
and currently untracked, so the committed CHANGELOG would cite a path that is not in
the repository. None of these is data loss, security or a crash; the runtime diff is
small and every edited runtime line is comment prose, a dropped parameter, two CSS
declarations, one attribute, one resampler, one title string and one helper.

**Verdict: NOT YET — 0 Critical, 3 Important, 9 Minor.** Fix I-1, I-2 (either the
test or the sentence) and I-3 (force-add the record) and I would sign.

## Method

Read `review.md`, `progress.md` (including the Record gap and the rulings),
`task-A/B/C-report.md` including their follow-ups (task-6/7/8),
`docs/validation/panel-charts-2026-10-29.md`, `CHANGELOG.md` `## Unreleased` (both
bullets), `WORKFLOW.md` §5–§6, the whole `git diff aabadae` and the current
`lib/memory-panel.js`, `lib/client.js`, `lib/index-db.js`, and the changed tests.

Ran per file (not the full `npm test` — the Lead's `npm run check` gate runs
concurrently):

| command | result |
|---|---|
| `node test/panel-ui.test.js` | 35 tests / 35 pass / 0 fail |
| `node test/panel-client.test.js` | 18 / 18 / 0 |
| `node test/index-stats.test.js` | 21 / 21 / 0 |
| `node --no-experimental-sqlite --test test/index-stats.test.js` | 12 tests / 11 pass / **1 skipped** (`node:sqlite is unavailable on this host`) / exit 0 |
| `node test/architecture.test.js` | 8 / 8 / 0 |
| `node test/panel-route.test.js` | 26 / 26 / 0 |
| `node test/memory-panel-behavior.test.js` | 4 / 4 / 0 |
| `node test/search.test.js` | 33 / 33 / 0 |
| `node test/panel-assets.test.js` | 7 / 7 / 0 |
| `node --no-experimental-sqlite --test test/search.test.js` | 33 tests / 6 pass / **26 fail / 1 skipped** / exit 1 — pre-existing, unchanged (see Critical) |
| `npx prettier --check` all nine changed files | `All matched files use Prettier code style!` |
| `npx eslint` all nine changed files | exit 0 |
| `git diff --check` | clean |

Measured, not taken from the reports: `wc -l` gives `lib/index-db.js` **2839**,
`lib/memory-panel.js` **2010**, `lib/client.js` **1262** — equal to the "formatted"
counts because all three are prettier-clean; `git show aabadae:lib/index-db.js | wc -l`
is **2831** (2827 is b36d02a). Token measurement against the installed build
(`C:/Users/bonerush/AppData/Local/Programs/DeepSeek Harness/resources/app.asar`,
182,434,783 bytes): **405** defined `--dsw-*:` names, **0** matches for
`--dsw-font-xs-regular-13:`, `--dsw-font-xs-13:13px/20px var(--dsw-font-family)`, and
all **24** names the bundle reads are host-defined.

Behavioural probes (never written to the repo): the real views were driven through the
suites' own four-hook React stand-in with an instrumented `fetch` from a `/tmp` copy;
the capture artifacts and PNGs were read directly; and **nine mutation probes** were
run against a `/tmp` copy of `lib/` + the two test files, each reverted after the run:

| mutation | intended test | result |
|---|---|---|
| drop void-cell `aria-hidden` | heat-map case | **fails** (1) |
| flow title back to `第 N 周` | flow-bars case | **fails** (1) |
| sparkline back to one point per day | both sparkline cases | **fails** (2) |
| disable the >12-week fold | year-long case | **fails** (1) |
| raise the composition `CAP` | composition case | **fails** (1) |
| remove `onClear()` from Escape | persistent search box case | **fails** (1) |
| break `aria-controls` | one-tabpanel case | **fails** (1) |
| pass no `React` into `createMemoryViews` | served-module wiring case | **fails** (1) |
| `End` mapped to `index + 1` | tablist case | **fails** (1) |
| add a new view class (`mem-heat-canvas`) | class-coverage case | **passes** — see I-2 |

Line numbers are the working tree.

### New breakage, and what I could not verify

No new breakage found in the paths the suites and the capture cover. The runtime diff
is deliberately inert: `activityRequest` lost a parameter that had no other caller
(`grep -rn activityRequest lib/ test/` → definition + one call), the heat-grid cap
262→292 cannot overflow (`width:100%` still bounds the grid — measured 292 at 320px
with no horizontal overflow at 320/375), and the resampler's changed output only affects
windows the shipped route cannot produce (route asks 84 days; the trimmer's smallest
activity window is `ACTIVITY_TRIM_DAYS = 28`, i.e. four weekly points).

Cannot verify from diff (named, not guessed):

- the **real host cascade and the shell chrome**: the capture page omits
  `mem-tabbar`/`mem-searchbar` (record §7), so the 13px search-field font the token fix
  restores is not rendered or measured anywhere. The record lists that gap itself.
- **native tooltip rendering** of the heat-cell `title` attributes and the SVG
  `<title>` children: the attributes/titles are verified present, the OS tooltip is
  not.
- the **composed shell → `SearchView` wire**: the served module sits behind a dynamic
  import a vm context cannot resolve, so the shell test pins the prop names in source
  and `panel-ui` mounts the view side. I probed the view side directly (I6/I7 hold),
  but the two halves in one real DOM are not exercised by any test.
- the shell tests use a **hand-written four-hook React stand-in**, not the host's
  React build; hook-order/DOM-semantics differences are invisible to this suite (same
  limitation the existing panel-ui suite already documents).
- **a sqlite-less full suite** was not run (the CHANGELOG names this); the two
  `--no-experimental-sqlite` runs above are the local proxy.

## Spec compliance — run-2 scope

Every verdict is against the committed `review.md` clauses (the absent frozen spec's
quotes) and the wave's own extra items.

| item | verdict | showing line(s) |
|---|---|---|
| **M1** unused `state` dropped | **PASS** | `lib/index-db.js:1025` `function activityRequest(options)`, `:1051` the only call; repo-wide grep = 2 hits |
| **M2** `MAX_ACTIVITY_DAYS` comment | **PASS** | `lib/index-db.js:941-948` now says "widest window… the heat map draws whatever window it is handed whole"; `ACTIVITY_DAYS = 84` at `lib/panel-route.js:67`; heat map draws the window whole (`lib/memory-panel.js:454-475`) |
| **M3** digest "reused" claim | **PASS** | `lib/index-db.js:1000-1013` says re-implemented + mtime fallback; verified `lib/digest.js:200-202` has the rule with no `mtime`, and `bucketOneDay` (`:1015-1022`) does `created ?? mtimeDay`; the architecture comment's "shared with the digest" is gone (`test/architecture.test.js:700-704`) |
| **M4** void cells `aria-hidden` | **PASS** | `lib/memory-panel.js:504-511`; asserted `test/panel-ui.test.js:519-527` (and the fixture's voids are asserted non-empty); capture 7/7 |
| **M5** chart floor ≥ 280px | **PASS** | `lib/client.js:283` `max-width:292px`; `test/panel-client.test.js:527-542`; measured `clientWidth` 292 at 320px (`measure-light-320.json`, record §3/§4) |
| **M6** 12-point sparkline | **PASS** | `lib/memory-panel.js:716-741` (weekly resample + oldest-weeks fold); tests `:629-737`; capture 12 polyline points; mutations 3–4 above fail the intended cases |
| **M7** flow-bar reading `WW 周` | **PASS (form)** | `lib/memory-panel.js:631` `pad(weekNo) + ' 周 · 新建 …'`; `test/panel-ui.test.js:621-624` pins 32/43; the reading's semantics are I-1 |
| **M10** chart hooks in the class-coverage list | **PASS (list)** | `test/panel-client.test.js:788-924` (130 entries; static extraction: views emit 108, 24 added, 0 unguarded today); the guard's mechanism/claim is I-2 |
| **M11** silent sqlite no-op | **PASS** | `test/index-stats.test.js:389-404`, `test/search.test.js:1105-1138`; `--no-experimental-sqlite` reports the named skip in both; `grep -rn 'if (!HAS_SQLITE) return' test/` → none |
| **M12** unfalsifiable assertions | **PASS** | shell tests mounted through a four-hook stand-in (`test/panel-client.test.js:17-146` harness, `:179-350`, `:621-757`); tombstones deleted (`test/panel-ui.test.js` diff); the three remaining source-shape seams are narrowed and commented; nine of the ten probes above fail the intended test (the tenth is the I-2 gap probe) |
| **extra — host token** `--dsw-font-xs-regular-13` → `--dsw-font-xs-13` + measured allowlist | **PASS** | `lib/client.js:203`; guard `test/panel-client.test.js:453-525`; independently measured 405 defined names / 0 retired-token matches / used set == the 24-name allowlist and all 24 host-defined |
| **extra — budget comments 2839/2010/1262** | **PASS (figures)** | measured exactly; comments at `test/architecture.test.js:686-690`, `:700-712`, `:755-758`; the history/rounding prose in two of them is M-2 |
| **I1** heat map draws the whole window | **PASS** | `lib/memory-panel.js:454-475` (no `slice(-12)`; columns from the calendar); asserted `test/panel-ui.test.js:516-527,553-569`; capture 13 columns / 84 data / 7 void |
| **I2** remainder counts tags | **PASS** | `lib/index-db.js:1169-1173` `distinct`; `lib/memory-panel.js:682-686,710`; `test/panel-ui.test.js:755-785` (ten tags × five, total 50, distinct 10, "另有 2 个标签") |
| **I3** one fallback request, notice carried | **PASS** | `lib/memory-panel.js:1166-1195` report-only when composed; `:1204-1216` carried notice; `test/panel-ui.test.js:1257-1308` asserts 2 requests after the shell re-render, notice visible then replaced by results |
| **I4** three real composition segments | **PASS** | `lib/memory-panel.js:829-842` cap/其他, `:860-881` distinct tints; `test/panel-ui.test.js:787-849` (seven types, 3 segments, 3 distinct classes) |
| **I5** cell reading date · value | **PASS** | `lib/memory-panel.js:512-525` `title` + `aria-label` + `mem-sr`, no inert child; asserted `test/panel-ui.test.js:537-548`; capture 84/84 |
| **I6** `onClose` honoured | **PASS (code)** | `lib/client.js:1113` passes it; `lib/memory-panel.js:1341-1351` renders 返回 and calls it. My probe: 1 button when passed, calls the callback, absent when not. No automated test — M-4 |
| **I7** one owner for `limit` | **PASS (code)** | `lib/client.js:1078-1080,1112`; `lib/memory-panel.js:1374-1383` reports upward. My probe: `onLimit(50)` fires and no extra request is sent; standalone fallback unchanged. No automated test — M-4 |

## Critical

None. The two candidate classes were checked and rejected:

- **The skip conversions cannot hide a failure.** On a sqlite-less host the parity test
  is reported skipped with its reason, and the file's remaining tests are the
  scan-only variants (11 pass, exit 0). `test/search.test.js` is red on such a host
  (26 failures, exit 1) but that is the pre-existing `harness()` hard-coding
  `backend: 'sqlite'`, not the converted test and not changed by this wave; the pass
  count moves 7→6 and skips 0→1 exactly as the task-A report measured. Nothing that
  used to be checked is now silently green.
- **The CSS/attribute edits cannot regress a data path.** `max-width` 262→292 is
  bounded by `width:100%` (measured: 292 at 320px, no horizontal overflow at 320/375,
  and the grid still fills the 292px floor); `aria-hidden` on a `role="img"`
  descendant is inert to the pointer/keyboard; the font token is a CSS-only change;
  and the resampler only changes the decorative sparkline's sampling — its one
  behavioural edge (no chart below two weekly points) needs a window under 14 days,
  which neither `ACTIVITY_DAYS = 84` nor the 28-day trim floor can produce.

No data loss, no security regression, no crash path; the route payload shape and the
public exports are untouched (`git status` shows no `lib/panel-route.js`, no
`package.json`).

---

## Important

### I-1. The new flow-bar title names an ISO week the bar does not cover

`lib/memory-panel.js:573-582` groups the series into seven-day chunks **backwards from
the window's last day**; `:624-632` then labels each bar with the ISO week of that
chunk's **first day**:

```
title: pad(weekOfYear(week.start)) + ' 周 · 新建 ' + week.created + ' · 更新 ' + week.updated
```

Measured on the suite's own 84-day fixture (window 2026-08-07..2026-10-29, starts
Friday), driven through the real `OverviewView`:

```
bar 1 covers : 2026-08-07 .. 2026-08-13
title        : 32 周 · 新建 3 · 更新 2
ISO week 32  : 2026-08-03 .. 2026-08-09   <- 08-10..08-13 are week 33
```

Every bar straddles two ISO weeks unless the window happens to end on a Sunday: in the
fixture, three of the bar's seven days are in the week the title names and four are in
the next one, and the named week also contains days the bar's counts omit. The
`weekOfYear()` helper itself
is correct — I probed the year boundary (`52/53/01` for chunks starting 2026-12-23,
2026-12-29, 2027-01-05) — the defect is the label-to-chunk mapping.

Why it matters: this is exactly the class of bug the review already graded Important
twice (I1: "two different answers for one window"; I2: "an occurrence count labelled
as a tag count"). The design's own premise is that the printed reading equals the
picture. `第 1 周` was at least an honest ordinal; `32 周 · 新建 3` now reads as "week
32's activity" and is not. `test/panel-ui.test.js:623-624` pins the wrong semantics
(`32 周`/`43 周`), so it encodes the defect instead of catching it — the I2 pattern.

Fix (pick one, and move the test with it):
- label the covered range instead of the week: `'8/7–8/13 · 新建 3 · 更新 2'` and
  record the deviation from §3.4 item 3 in the spec revision log; or
- group by ISO-week boundaries (the last bar is the current partial week) and derive
  the window/bar count from the grouping, so "WW 周" is true; or
- truncate the activity window server-side to whole ISO weeks ending on the last
  complete week (the review's own alternative for I1) and say so in the flow meta.
Either way the assertion at `test/panel-ui.test.js:623-624` must be re-derived from
the chosen rule (date range, or the corrected week boundaries), not copied from the
implementation.

### I-2. The M10 "guard" is a frozen literal, and the CHANGELOG overstates what it proves

`test/panel-client.test.js:788-924` is a hand-written 130-entry list; `:925-930` only
asserts that each listed hook has a stylesheet rule. The test never reads
`lib/memory-panel.js`, so nothing binds the list to the classes the views emit. I
reproduced the task-C report's extraction (comments stripped, quoted `mem-*` tokens):
the views emit 108 classes, the pre-wave list held 106, the wave added 24, and
"unguarded" is 0 **today** — the list is correct as a snapshot. But the mechanism is
not a guard: in a `/tmp` copy I added one new class to the heat grid
(`className: 'mem-heat-grid mem-heat-canvas'`) and `node test/panel-client.test.js`
stayed **18/18 green**. A view-side rename of any of the 108 would likewise not fail
this test unless some other test happens to name the class.

`CHANGELOG.md:90-92` says: "The list now guards all 108 classes the views emit (24
were unguarded), and every one has a stylesheet rule, **so a rename on either side
fails**." The first half is true as a one-time snapshot; the second half is only true
for the stylesheet side. `task-C-report.md:141-143` itself says C2 "was green on first
run because the chart styles had already landed in aabadae — the missing part was the
guard", i.e. no test can fail on the old code for this item.

Fix (cheap, and it reuses work the wave already did): inside the same test, extract
the emitted set from `lib/memory-panel.js` — strip comments, match quoted literals,
keep `^mem-[a-z0-9-]+$` tokens — and assert it is a subset of `hooks` (or equality
against the views-owned subset). Then the 108/24/130 numbers are enforced rather than
narrated, and a new chart class fails until it is styled and listed. If the extraction
is not added, narrow the CHANGELOG to "the 24 chart classes were added to the reviewed
list" and drop the "rename on either side" claim.

### I-3. The 320px evidence the CHANGELOG relies on is git-ignored and untracked

The record that closes the wave's headline verification is
`docs/validation/panel-charts-2026-10-29.md`. It exists and it is good — I checked its
artifacts: `summary.json` is `{"total":196,"passed":196,"failed":[]}`; the four PNGs
are 320×1679 / 375×1610 with byte sizes and sha256 matching the record's table; the
four `measure-*.json` files reproduce every floor the record prints (heat/flow/freq/
composition 292, KPI 290 at 320px; 13 columns, 84 data cells, 7 void cells, 12
sparkline points, 12 flow titles). But:

```
$ git check-ignore -v docs/validation/panel-charts-2026-10-29.md
.gitignore:20:docs/  docs/validation/panel-charts-2026-10-29.md
$ git ls-files docs/validation/
docs/validation/retrieval-sparse-2026-10-27.md
docs/validation/v0.4-acceptance-2026-10-27.md
docs/validation/windows-compat-2026-10-28.md   <- the three earlier records are tracked
```

The current file is not in the index and is not in `git status` (ignored), while
`CHANGELOG.md:80-81` and `:111-118` cite it by path twice ("Measured at a true
320px viewport … (see `docs/validation/panel-charts-2026-10-29.md`)", "The 320px claim
is now a measurement …"). If the Lead commits the working tree as-is, the permanent
CHANGELOG will point at a file the repository does not contain, and the M5/§6.6
"measured, not inferred" claim loses its evidence trail.

Fix: force-add the record in the same commit —
`git add -f docs/validation/panel-charts-2026-10-29.md` — following the precedent of
the three tracked validation records, or inline the essential measured table into the
CHANGELOG and drop the path. (The record itself is written to be committed: it has no
local-only content and cites the installation only as a measurement source.)

---

## Minor

### M-1. The 84-day sparkline test recomputes its expectation with the implementation's own grouping, and its fixture cannot see the grouping at all

`test/panel-ui.test.js:654-670` builds the expected series with the same trailing
seven-day loop the implementation uses (`:657-661`), so a wrong grouping choice
agrees with the test; and the fixture is exactly 12×7 days with a chunk sum of 3 in
every week, which makes grouping-from-the-end and grouping-from-the-start produce
identical values — the fixture cannot distinguish them at all. The 365-day fold
assertion (`:729-736`) is genuinely independent (it derives `365 − 11×7` by hand), so
the fold is pinned; the 84-day series is not.

Fix: hard-code the expected cumulative series for the fixture — the twelve seven-day
sums are 3 each, so the plotted values are `3, 6, 9, … 36` — and add one
non-multiple-of-7 window (e.g. 30 or 90 days) so the partial first chunk makes the
grouping direction observable.

### M-2. Two budget-comment figures are wrong even though the three measured figures are right

- `test/architecture.test.js:705-707` — "Measured 2839 formatted lines after the
  review's Minor fix round (2827 before it: …)". The Minor round's base is **aabadae,
  2831** (`git show aabadae:lib/index-db.js | wc -l`); 2827 is **b36d02a**, before
  aabadae added `tagFrequencies`' `distinct`. Fix: "(2831 before it; 2827 was the
  b36d02a figure, before the first fix wave added `distinct`)".
- `test/architecture.test.js:755-758` — "measured-plus-30 is 1292, rounded up to
  1350." By the rule stated at `:255-258` (measured+30 rounded up to the next 50),
  1292 → 1300. 1350 is a deliberately kept old ceiling (the precedent for saying so is
  `lib/curation-scan.js`'s comment at `:451-455`). Fix: "measured-plus-30 is 1292, which
  the rule rounds to 1300; the 1350 ceiling is kept deliberately, not derived".
  (The memory-panel and index-db current figures, 2010+30→2050 and 2869→2900, are
  correct.)

### M-3. The `heatmap()` header comment is stale in the same function the wave edited

`lib/memory-panel.js:441` says "活动热度图: 12 columns × 7 rows of 6px squares", and
`:443` repeats "A 6px square". The code deliberately draws 13 columns when the window
is unaligned (`:454-459`) and the CSS now scales cells (measured `rectWidth` 20.61 at
320px). task-7 fixed only the `<title>` sentence (:446-448); the header still
contradicts the I1 fix and the CSS. Fix: "a 13×7 calendar of square cells sized by the
grid; the focus-target argument still holds because the measured cell is ~21px, below
the 24px floor" — and this is exactly the comment-vs-code class M2/M8 exist for.

### M-4. The I6/I7 fixes work but have no automated coverage, and the shell test's prop list shows it

`test/panel-client.test.js:737-746` pins `SearchView`'s props as
`sessionId, query, scope, type, status, limit, visible, onClose` — it omits
`onFilter` and `onLimit`, the two callbacks the single-owner model (and I6/I7) depend
on. `grep -rn onLimit test/` returns nothing; no test renders the 返回 button or
clicks it. I verified both paths by probe (返回 appears and calls `onClose`; with
`onLimit` wired, 显示更多 reports 50 and sends no request), so the code is right, but a
regression that dropped either prop would keep the suite green.

Fix: add `onFilter` and `onLimit` to the `:737` list, and add two assertions to
`test/panel-ui.test.js`: with `onClose` passed, `byText(tree,'返回')[0].props.onClick()`
calls it (and no 返回 without it); with `onLimit` passed, clicking 显示更多 calls it
with 50 and leaves the request count unchanged. These are 6 lines each and they pin
the two behaviours the round-1 CHANGELOG claims are fixed.

### M-5. The M5 floor test hard-codes the CSS constant it derives from

`test/panel-client.test.js:527-542` asserts the heat-grid cap is in `[280, 320 − 2×14]`
but never asserts that `.mem-view` really has 14px horizontal padding. If the padding
changed (the derived number lives only in this comment), the real container at 320px
could fall below the 280px floor while this test still passes — the authoritative
measurement would silently disagree with the guard.

Fix: assert the `.mem-view` rule contains the 14px padding in the same test (or read
both numbers and fail loudly if either moves), so the arithmetic cannot drift.

### M-6. The round-2 CHANGELOG's blanket test claim is not true for five of the closed items

`CHANGELOG.md:61-63`: "each item was read in the code before it changed, **every fix
has a test that fails on the old code**, and the measured numbers are in the review
file…". That is true for M4/M5/M6/M7 and the token fix, but false for M1/M2/M3
(comment/parameter-only: `task-A-report.md:15-37` records no red run — no test can
observe a comment), M10 (`task-C-report.md:141-143` says C2 "was green on first run"),
and M11 (on this host the old code passed; the sqlite-less change converts a silent
pass into a reported skip — a count change, not a failing test). The round-1 entry
has the same blanket sentence at `CHANGELOG.md:18`, which is also untrue for I6/I7.

Fix: scope it — "every behavioural fix has a test that fails on the old code; the
comment/parameter items were re-read against the code (digest.js:200-202 for M3), and
M10/M11 are verified by the extraction/skip counts quoted here."

### M-7. The round-1 tail and the round-2 intro disagree about what was still open

`CHANGELOG.md:56-58` (edited in this wave) says that round "left the review's **twelve**
Minor findings and the 320px re-capture open", while `:63-64` correctly says the first
round "had already closed M8, M9 and part of M10". Only ten Minors (plus part of
M10) were open.

Fix: "left most of the Minor findings (M1–M7, M10–M12) and the 320px re-capture open".

### M-8. The `weekOfYear` fallback is unreachable and would print an ordinal in the `WW` slot

`lib/memory-panel.js:624`: `weekOfYear(week.start) ?? index + 1`. Every chunk comes
from a non-empty slice of `activity.days`, so `start` is always a day string and
`weekOfYear` returns a number; the fallback can only fire for a malformed payload, and
if it ever did it would print `01 周` — an ordinal in the week-of-year position, the
confusion the comment at `:622-623` says it avoids. Fix: drop the fallback (the
grouping contract guarantees a day) or make the fallback a date range / `—` and test
it with `start: null`.

### M-9. The capture page embeds the pre-task-8 stylesheet; the record should say which revision it captured

`docs/validation/panel-charts-2026-10-29.md:32-34` says the record evaluates "the real
stylesheet … the `panel-css` slice of `lib/client.js`". I diffed the captured panel
stylesheet against the current `PANEL_CSS` rule by rule: all clean except **one** —
the captured `.mem-search-input` still says
`font:var(--dsw-font-xs-regular-13)` (the retired token), because the capture ran at
21:28 and `lib/client.js` was edited at 21:30. No measured number changes (the capture
page does not render the searchbar, and record §8 F2 documents the follow-up fix), but
"the real stylesheet" is not the committed one, and a future reader cannot tell which
revision produced the artifacts. Fix: name the `lib/client.js` revision in §1, or
re-run `scratch/panel-capture/capture.mjs` (idempotent) after the final CSS edit so
the recorded artifacts come from the committed tree.

---

## What is good

- **The twelve Minor findings are actually closed**, not merely relabelled. M1–M3 are
  correct prose against the real code (I re-read `digest.js:200-202` — same mutuality
  rule, no `mtime` fallback; `bucketOneDay` does `created ?? mtimeDay`); M4/M5/M6/M7
  each have the named acceptance criterion implemented; M10's list genuinely extends
  to all 108 emitted classes; M11 is honest in both files; M12's shell assertions are
  real behaviour now.
- **The new chart tests are falsifiable, and I falsified them.** Five independent
  mutations of `lib/memory-panel.js` each failed exactly the intended panel-ui case
  (void `aria-hidden`, week title, weekly sparkline, the >12-week fold, the three-
  segment cap). That is the property the review's M12 demanded, delivered for the
  chart half.
- **The shell test rewrite is the strongest part of the wave.** `shellReact()`
  (`test/panel-client.test.js:17-146`) is the same four-hook shape the panel-ui suite
  already uses, and the tests now mount the real `MemoryPanel`/`MemoryTabs`/
  `SearchBox`: tablist roles/roving tabindex/focus movement, one tabpanel whose
  `aria-labelledby` follows a tab click, and a controlled search box with all three
  exits and the empty-query guard. Four mutations of `lib/client.js` each failed the
  intended test; the source-shape assertions that remain are the two seams that
  genuinely cannot be mounted (the dynamic import and the served-view props), and
  each says so in a comment.
- **The token fix is measured, not asserted.** Independently of the reports: 405
  defined `--dsw-*:` names in the installed build, zero for the retired name,
  `--dsw-font-xs-13:13px/20px var(--dsw-font-family)`, and the 24-name used set is
  exactly the allowlist with all names host-defined. The guard is derived from the
  bundle (both directions fail: an unverified name and a stale entry), and the one
  defect is pinned by name at the declaration that broke. This is the right posture
  for a host-token dependency CI cannot measure.
- **The M11 fix is honest in both directions.** With `--no-experimental-sqlite` the
  parity test is reported skipped with its reason (11 pass / 1 skipped / exit 0), so a
  green is no longer mistaken for proof; and the task report does not hide that
  `test/search.test.js` is red on such a host (26 pre-existing failures, unchanged
  counts before/after, `:1381` unchanged) — the pass 7→6 / skip 0→1 delta is exactly
  the conversion.
- **The measured numbers are genuine.** `2839 / 2010 / 1262` are the `wc -l` of the
  current files (and equal the formatted counts because prettier is clean); the
  CHANGELOG's seven "Verified" counts reproduce exactly; the capture artifacts
  reproduce every number the record and the CHANGELOG print, including the 292px grid
  at a true 320px viewport and "no horizontal overflow" at both widths.
- **The `--window-size` method finding (F1) is recorded, not silently ignored.** The
  record's §5 quotes the probe (`innerWidth = 500` for `--window-size=320,1200`), keeps
  the evidence JSON (`window-size-flag-probe.json`), says any future visual validation
  should use CDP emulation, and the CHANGELOG repeats the warning. This is exactly how
  a method finding should survive into the record.
- **The I1–I7 fixes are intact under this wave.** I re-read each one and re-ran its
  guard: the whole-window heat map and `合计 = series sum` contract, the distinct-tag
  remainder, the two-request unbound fallback with the carried notice, the three real
  composition segments, the date · value cell reading, and (by probe) `onClose` /
  `onLimit`; the only in-diff edit to those paths is the `aria-hidden` attribute on
  the void cells.
- **Working-tree hygiene is clean:** no whitespace damage, prettier/eslint clean on
  all nine files, no new dependency, no route/public-surface change, and the tests
  were extended rather than weakened. The only edits to pre-existing assertions are
  the deliberate replacements — the two skip conversions, the `mem-stamps`/substring
  deletions the mounted tests supersede, and the strengthened heat/sparkline/flow
  cases — and `git diff -w` shows the `search`/`index-stats` bodies are otherwise
  re-indent-only.
