# 记忆面板 v0.4 图表化 — 独立复核（第 3 轮，只读）

**Range:** `aabadae` plus the uncommitted working tree — 9 files, +1210/−170. HEAD is
still `aabadae`; this review covers the fix wave for `review2.md` on top of it
(`git diff aabadae`), not the earlier rounds that `review2.md` already judged.
**Contract:** `review.md` + `review2.md` (this reviewer's findings), the
`task-B-report.md` / `task-C-report.md` "Round 3" and task-13 sections, the round-3
`docs/validation/panel-charts-2026-10-29.md` (Task D), `CHANGELOG.md` `## Unreleased`
and `test/architecture.test.js` (Lead edits). The frozen spec remains absent
(`docs/` is git-ignored, the originating session's files are not in this checkout);
the committed reviews' quoted clauses are the standard applied.
**Reviewer:** independent, read-only. Read-only git only; the only repository write is
this file; all probes and mutations ran in `/tmp` copies that were discarded.

## Verdict

**APPROVED** — all three Important and all nine Minor findings of `review2.md` are
closed (I-3 closing with the commit described in §Commit requirements), and the new
behaviour is truthful and falsifiable rather than bookkeeping: the flow bars are now
the heat map's own calendar-week buckets (verified 1:1 against the heat map for every
window shape I could construct, 13 bars / 12-or-13 per 84-day window), the class
guard derives its set from `lib/memory-panel.js` and now fails on a new view class,
the sparkline and sparkline-window expectations are hard-coded from the fixture rule,
and the re-run capture is bound to this exact tree by `git hash-object` ids, sha256s
and a before/after stability snapshot (220/220 checks). 0 Critical / 0 Important /
1 new non-blocking Minor.

## Method

Read `review2.md`, the round-3 sections of the task reports and progress.md rulings,
the updated validation record, `CHANGELOG.md`, `test/architecture.test.js`, and the
full `git diff aabadae`.

Ran per file (not the full `npm run check` — the Lead's gate runs concurrently):

| command | result |
|---|---|
| `node test/panel-ui.test.js` | **41** tests / 41 pass / 0 fail |
| `node test/panel-client.test.js` | **18** / 18 / 0 |
| `node test/panel-route.test.js` | **26** / 26 / 0 |
| `node test/memory-panel-behavior.test.js` | **4** / 4 / 0 |
| `node test/panel-assets.test.js` | **7** / 7 / 0 |
| `node test/architecture.test.js` | **8** / 8 / 0 |
| `node test/index-stats.test.js` | **21** / 21 / 0 |
| `node test/search.test.js` | **33** / 33 / 0 |
| `npx prettier --check` (CHANGELOG + the five changed source/test files) | clean |
| `npx eslint` (lib/memory-panel.js + the three changed test files) | exit 0 |
| `git diff --check` | clean |

SQLite-less variants were not re-run: `test/index-stats.test.js` and
`test/search.test.js` did not change after review2, where I measured them
(12 tests / 11 pass / 1 reported skip / exit 0; and 33 / 6 pass / 26 pre-existing
failures / 1 skip / exit 1 respectively).

Measured against the record and the tree: `git hash-object lib/client.js` =
`9c3b1545f7ae…`, `lib/memory-panel.js` = `19fc3c7fd6e0…` and their sha256/byte sizes
equal the record's §1 rows; current evaluated `PANEL_CSS` sha256 =
`ab577a09348d…` equals the record's embedded-stylesheet sha256; the four PNGs' sha256s
equal the record's table; `summary.json` = `{"total":220,"passed":220,"failed":[]}`
(220/220, `source.stable=true`), flow 13 bars / titles 32…44 / created 38 / updated 14, heat
13 columns / 84 data / 7 void, sparkline 12 points, floors 292/290 at 320px; the
captured panel stylesheet is rule-identical to the current `PANEL_CSS` (226/226
rules; the only extra captured rules are the capture page's own two shell rules);
`wc -l` = 2839 / **2019** / 1262. I also opened `capture-light-320.png`: the heat meta
reads `近 13 周（84 天）· 本周 3 天有更新 · 合计 52 条`, the heat map shows the
head/tail calendar gaps, and the flow block sits under `近 13 周净增 24` with its
rightmost bar created-only (the DOM measurement records 13 created / 12 updated
rects, x positions 0…144).

Independent probes (in `/tmp`, no repository writes):

1. **Week convention, exhaustively.** I extracted the shipped
   `sundayWeekOfYear()` from `lib/memory-panel.js` and ran it over every Sunday
   1999–2040 (2,192 dates): always 1–53 (never 0 or 54), consecutive +1 within a
   year, week 1 always covers a 1 January, and 8 of the 42 years have a week 53 —
   the documented convention holds.
2. **Flow ↔ heat 1:1.** Driving the real `OverviewView` through the four-hook
   stand-in for 13 windows — all seven weekday alignments of an 84-day window, plus
   30/60/90/95/7-day and two year-boundary windows: bar count always equals the heat
   map's column count, every bar's `created+updated` equals the matching heat
   column's sum, every bar's `WW` equals an independent reference implementation of
   the documented rule, and the SVG width/zero line equal `bars×12−4`. The 84-day
   window is 13 bars when unaligned and 12 when it starts on a Sunday.
3. **Derived strings.** Meta and empty sentence follow the grouping for 84/90/30/7-day
   windows: `近 13 周净增 …` / `近 12 周…` / `近 14 周…` / `近 5 周…` /
   `近 2 周…`, and `近 N 周没有新建或更新记录。` uses the same N (13/12/5) — no
   hard-coded 12 survives (`grep` for `近 12 周` in `lib/` is empty).
4. **Mutation probes** (ten, in a `/tmp` copy of `lib/` + the two test files, each
   reverted): trailing seven-day chunks instead of calendar weeks, ordinal title,
   week number off by one, dropping the head column, a new view class, a renamed
   view class, start-aligned sparkline resampling, the 返回 button removed, the
   `onLimit` branch made to run its own read, and `.mem-view` padding changed to
   24px. Every one failed exactly the intended test; quoted examples:
   `✖ classes the views emit but the list does not guard: mem-heat-canvas`
   (18 tests / 17 pass / 1 fail for I-2), and
   `✖ the cap fits the 320px content box: cap 292, content box 272` (M-5).
   The start-aligned sparkline mutation failed the 30-day and year-long cases while
   the 84-day case stayed green — the documented blind spot M-1 named.

Caveats on the evidence hierarchy, not defects: the capture fixture
(`scratch/panel-capture/fixture.mjs:131-186`) computes its flow expectations with a
second implementation of the same documented rule, so the 220 checks corroborate the
DOM against the contract rather than prove the week convention independently — the
independent pin is the hard-coded unit tests, which I re-derived by hand for every
value. The capture page still omits shell chrome, as the record's §8 says, so the
search-input font and tooltip rendering remain unverified there.

## Per-finding table (review2 → round 3)

| # | Status | Evidence |
|---|---|---|
| **I-1** flow title named a week its bar did not cover | **CLOSED** | `lib/memory-panel.js:574-650` groups by the heat map's own column index (`floor((lead+index)/7)`), so a bar *is* one Sun–Sat week; the title uses the bar's own Sunday via `sundayWeekOfYear()` (`:549-560`, `:630-632`); bar count, geometry, meta, aria-label and empty sentence derive from the grouping (`:592`, `:604`, `:614-622`). Fixture: 13 bars, titles 32…44, pairs summing to 38/14 (`test/panel-ui.test.js:574-676`); a year-boundary case pins 52/01/02 (`:714-745`); I verified 1:1 against the heat map for 13 window shapes and mutated it four ways (all fail). |
| **I-2** class guard was a frozen literal | **CLOSED** | `test/panel-client.test.js:8,21` read `lib/memory-panel.js` (string-aware `stripComments`), `:1000-1025` extract the emitted `mem-*` set, assert every one is guarded and pin the count (108 emitted / 130 guarded / 22 shell-owned). My review2 probe now fails and names the class (`mem-heat-canvas`); a rename fails too. |
| **I-3** 320px record was git-ignored and untracked | **CLOSED with the commit** | The working-tree record is the round-3 one (`docs/validation/panel-charts-2026-10-29.md:1,23-64`: base commit + both `git hash-object` ids + sha256s + embedded-stylesheet sha256 + `stable=true`), and I confirmed every hash against the current tree. The force-add plan is sufficient iff the commit meets §Commit requirements below. |
| **M-1** sparkline test mirrored the implementation's grouping | **CLOSED** | `test/panel-ui.test.js:747-792` hard-codes the 84-day cumulative series `[3,6,10,13,16,19,22,26,29,32,35,38]` (re-derived from the fixture rule; review2's illustration `3,6,9…36` was wrong and the report says so), and `:794-840` adds a 30-day window whose `[1,4,7,10,13]` distinguishes trailing from start-aligned grouping; mutations confirm. |
| **M-2** two budget-comment figures wrong | **CLOSED** | `test/architecture.test.js:708-713` now says 2839 after / 2831 before (`aabadae`) / 2827 was `b36d02a`; `:760-765` says 1292 rounds to 1300 and the 1350 ceiling is deliberately kept. Measured 2839/2019/1262 today; aabadae's `lib/index-db.js` is 2831. |
| **M-3** stale `heatmap()` header | **CLOSED** | `lib/memory-panel.js:438-450` now describes a calendar grid of square cells with the measured ~21px CSS size (capture: 20.61px at 320) and the real reading mechanism; no "6px square" claim remains. |
| **M-4** no automated coverage for the I6/I7 callbacks | **CLOSED** | Prop list now includes `onFilter`/`onLimit` (`test/panel-client.test.js:810-811`); `test/panel-ui.test.js:1185-1203` pins 返回 exists iff `onClose` is wired and calls it, `:1205-1228` pins 显示更多 reports `onLimit(50)` and starts no read. Both mutations fail the intended test. |
| **M-5** floor test hard-coded the padding | **CLOSED** | `test/panel-client.test.js:574-606` reads the `.mem-view` rule's horizontal padding from the panel CSS and derives the cap's upper bound from it; padding→24px fails with `cap 292, content box 272`. |
| **M-6** blanket "every fix has a failing test" claim | **CLOSED** | `CHANGELOG.md:60-66` now scopes it to behavioural fixes, names the comment-only items as re-read (M3 against `lib/digest.js:200-202`), and calls out M10/M11 as measurement-proof; the round-1 entry's claim is left as committed history. |
| **M-7** round-1 tail contradicted the round-2 intro | **CLOSED** | `CHANGELOG.md:54-58` now says that round left "most of the Minor findings (M1–M7, M10–M12; M8, M9 and part of M10 were already closed)". |
| **M-8** unreachable ISO fallback in the `WW` slot | **CLOSED** | The ISO `weekOfYear()` and its `?? index + 1` fallback are gone (`grep 'index + 1' lib/memory-panel.js` → none); `sundayWeekOfYear()` documents the deliberate non-ISO convention and is pinned by the year-boundary test (and by my 2,192-date probe). |
| **M-9** capture page carried the pre-task-8 stylesheet | **CLOSED** | The record re-ran on this tree: §1 names base commit, both lib blob ids and sha256s, the embedded stylesheet sha256 and a before/after stability snapshot; I verified the hashes against the current files and the captured panel CSS is now rule-identical to the current `PANEL_CSS` (retired token absent, `--dsw-font-xs-13` present). |

## New findings

**Critical:** none. **Important:** none.

### N-1 (Minor, non-blocking). A malformed day string prints `NaN 周` in the flow title

`lib/memory-panel.js:630-632` derives the bar's Sunday from `first` and calls
`sundayWeekOfYear(sunday)` without a validity guard. `heatmap()` guards exactly this
input one screen up (`:461`, `Number.isNaN(first.getTime()) ? 0 : first.getDay()`), but
the title path does not. Probed through the real view with
`days: ['bad-1','bad-2','bad-3']`:

```
flow title : NaN 周 · 新建 3 · 更新 0
heat aria  : 近 1 周活动，共 3 条，峰值 1
```

The route cannot produce this today (it always sends `YYYY-MM-DD` days), so it is a
degraded-payload only cosmetic path, not a shipped defect. Concrete fix: guard the
derived Sunday the way the heat map guards its lead — e.g.
`const weekNo = Number.isNaN(sunday.getTime()) ? index + 1 : sundayWeekOfYear(sunday)`
— and add one malformed-day case so the two charts degrade the same way.

## Commit requirements (closing I-3)

The record is the right one, and its content is verified against the tree. For the
force-add plan to close I-3, the commit must contain all of the following (the record
is git-ignored, so `-f` is required; `.superpowers/` is *not* ignored, so plain `add`
works there):

1. `docs/validation/panel-charts-2026-10-29.md` force-added, unchanged from the
   reviewed content — its blob is `94595b182701490b41616ac6e019da9a479a606a`.
   After the commit, `git rev-parse HEAD:docs/validation/panel-charts-2026-10-29.md`
   must equal that id, and `git ls-tree HEAD docs/validation/` must list it.
   (If the Lead edits the record after this review, it must be re-reviewed — the
   revision table and the 220/220 figure are the evidence I verified.)
2. The two captured runtime files committed unchanged: `git rev-parse
   HEAD:lib/client.js` = `9c3b1545f7ae0e03ed0deac2618985ef700de944` and
   `HEAD:lib/memory-panel.js` = `19fc3c7fd6e0684706e38a588ea0732156c98008`. These are
   the record's §1 ids; if either blob differs, the record's revision claim is false
   and the capture must be re-run (or the claim corrected) before commit.
3. `review2.md` and `review3.md` added — the CHANGELOG now cites both re-review
   records (`CHANGELOG.md:117-119`), and `review2.md` is currently untracked. Add
   `.superpowers/sdd/2026-10-29-memory-panel-charts/review2.md` and `review3.md`
   explicitly.
4. Use explicit paths, not `git add -A`: `.superpowers/sdd/2026-10-28-…/` (15
   untracked files from a previous plan) must stay out of this commit. The run
   reports and `progress.md` may stay local, matching the earlier convention of
   committing only the review records.
5. After the commit, the CHANGELOG's "force-added with this change" sentence is then
   literally true; nothing else in the changed set references the record.

## What is good

- **I-1 was solved better than either option I proposed.** Rather than relabelling
  trailing chunks with a date range or amending the spec, the bars became the
  heat map's own buckets, so `WW 周` is true, both charts share one week definition,
  the partial edge bars are drawn like the heat map's edge columns, and the sums
  equal the window totals. The printed count now equals the picture — the criterion
  this review series has applied from I1 onward.
- **The convention is stated, not implied.** Sunday-first (not ISO), week 1 = the
  Sun–Sat week containing 1 January, Dec 26–31 owning the next year, 52/53 weeks:
  documented in `sundayWeekOfYear()` and the CHANGELOG, pinned by a year-boundary
  test, and I confirmed it exhaustively over 2,192 Sundays — no 00/54, no gaps.
- **The tests are independent now.** Flow pairs, week numbers, the 84-day sparkline
  series and the 30-day grouping direction are hard-coded/re-derived from the
  fixture's day rule; the report even corrects review2's wrong illustrative series.
  Ten mutations each failed the intended test, including the four that would have
  let a wrong grouping/title through.
- **I-2's guard has teeth.** A string-aware comment stripper (justified by the
  measured 67-vs-108 difference), emitted-set derivation from the producer, a subset
  assertion that names the offender, and a pinned count so a blind scan cannot pass
  vacuously. The review2 probe reproduces as a failure now.
- **The capture is bound to this tree.** Base commit, both `git hash-object` ids,
  sha256s, embedded-stylesheet sha256 and a before/after stability snapshot make the
  artifacts matchable against the eventual commit; the panel CSS is now rule-identical
  to the current stylesheet, and the 220/220 checks include the new flow geometry,
  aria and stylesheet identity. The light-320 PNG visibly shows the 13-bar block with
  the last created-only bar, and the record is honest about what it does not cover.
- **Hygiene and honesty held through the fix wave.** No route/export/dependency
  change, prettier/eslint/whitespace clean, all eight covering suites at the
  CHANGELOG's counts, the abandoned static "近 12 周" empty copy removed and replaced
  by a derived sentence, and the final CHANGELOG describes the re-review, its
  findings and their closure rather than claiming the first attempt was right.

## Out-of-diff release note (not a blocker)

The shipped README pair still quotes the pre-fix chart copy — `README.md:186-187`
and `README.zh.md:172-173` say `近 12 周 · 本周 N 天有更新 · 合计 M 条` and "6px
square". That text was written by the 0.4.0 release commit (`b36d02a`, which rewrote
both READMEs and re-recorded their hashes), and the real meta has been
`近 13 周（84 天）· …` since the first fix round; this diff's flow change makes the
copy no less stale. Since `b36d02a`'s pattern is that the release commit rewrites the
README pair and its `README.i18n.yaml` hashes, fold the update into the 0.4.1 release
commit rather than this fix commit: quote `近 N 周（84 天）· 本周 N 天有更新 · 合计 M 条`,
replace "6px square" with the grid cell, then
`git hash-object README.md README.zh.md` into `README.i18n.yaml`.
