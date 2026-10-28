# Memory panel modernisation — design

**Status:** frozen 2026-10-28
**Owner:** Lead (DSH session)
**Amends:** `2026-10-27-memory-panel-redesign-design.md` (the "vault ledger" direction is retired)
**Evidence:** `research/panel-ui-references-2026-10.md`, `research/panel-audit-windows-2026-10.md`,
measured baseline on this Windows host at `92806c1` (1320 tests / 1284 pass / 1 fail / 35 skipped;
the one failure is the Fetch-forbidden-port flake in `test/hooks.test.js`), live
`client/Theme.listTokens` (2026-10-28), and the user's report in this session.

## Problem and evidence

The user (Chinese, Windows) reports the sidebar panel is ugly and dated and asks for a modern
look, a Chrome-browser-style top tab strip, modern typography, rational/intuitive/beautiful data
display referencing `dsh-context` and memory plugins (not a pile of stacked panels), a modernised
検索 tab with its duplicate idle sentence removed, and stronger Windows testing before a new
release is pushed.

Evidence for each load-bearing claim is in the two research files. The load-bearing defects:

1. **Dated type = one line.** `lib/client.js:69` forces `Iowan Old Style / Palatino / Songti SC /
   serif` on the masthead, every view title, section head and sheet title. On Windows the CJK
   fallback is SimSun and the Latin fallback Palatino Linotype — the measured cause of the
   "dated" look.
2. **Tabs are an underline index, not tabs.** `.mem-tabs` (`lib/client.js:82-88`) is a 4-column
   grid with `01`–`04` ordinals and a 2px underline; the user asked for Chrome's tab form.
3. **Duplicate idle copy has a class cause.** `COPY.searchIdle` is rendered by two owners with
   two lifecycles: `setNotice(COPY.searchIdle)` (`lib/memory-panel.js:598-603`) and the
   always-on trailing `meta(COPY.searchIdle)` (`:797-801`). The measured probe shows 1 idle line
   on mount, 2 after one filter click, stable at 2. A one-line deletion fixes the instance, not
   the class.
4. **Further duplicated/dead copy** (audit A3): loading text owned by both `StatusLine` and
   `Loading` in all three views; three simultaneous search-loading strings; stale search error
   with a fake `上次更新 —`; the unbound-scope notice is dead copy (`:656` is wiped by `:624`);
   type printed twice per recent row; `共 N 条` contradicting `还有更多`; a hard-coded `FTS5`
   claim; `最近的决策` mislabels diagnostics; an inert masthead clock on 图谱/检索.
5. **Windows claim is not gated.** CI runs `ubuntu-latest` only; no `.gitattributes`, so a
   default `autocrlf=true` checkout fails prettier's `format:check`; the repo has no Windows
   CI leg to catch platform regressions. One measured Windows-only flake exists today
   (`fetch` against an ephemeral port that can be on the Fetch-spec forbidden list).

## Goals / non-goals

**Goals.** A modern, host-native panel at 320–375px: Chrome-form tab strip, modern sans
typography via host font tokens, one-surface data bands instead of stacked bordered cards, a
single status source per view, modernised 検索 with the duplicate class removed, unchanged graph
body, and Windows evidence strong enough to claim support (CI leg + line-ending pin + flake fix).
A new version `0.3.0` with release notes after the full gate is green.

**Non-goals.** No change to the graph body (`GraphCanvas`/`GraphView`/`.memgraph` styles/renderer
imports), no change to `/obsidian-mem/panel` actions or payloads, no new runtime dependency, no
new backend data (健康 stays status-only; review/history from `dsh-memory`'s IA is noted but not
built), no information-architecture change to the four views, no custom `font-family` (host font
tokens are the modernisation), no invented theme tokens.

## Design

### Type and surface system (token-only)

- Delete the serif family and negative letter-spacing. `.mem-display` becomes a headline hook:
  `font: var(--dsw-font-s-strong-14)`, `letter-spacing: 0`. No `font-family` is declared anywhere
  in the panel; the host `font:` shorthands carry the modern sans + CJK stack.
- Scale: masthead name `--dsw-font-s-strong-14`; view title `--dsw-font-s-strong-14` (15px visual
  via the token); section head `--dsw-font-xxs-strong-12` in `--dsw-alias-label-secondary`;
  body/rows `--dsw-font-xxs-12`; metadata `--dsw-font-xxxs-11`; micro-label
  `--dsw-font-xxxs-strong-11`. Numbers keep `font-variant-numeric: tabular-nums`. CJK line-height
  1.55–1.7; no negative tracking.
- One surface per tab, separated by 12–16px rhythm and 1px `--dsw-alias-border-l1`/hairline rules;
  no nested bordered card stacks. Only two raised surfaces per view maximum: the KPI/summary band
  and the search field (or the sheet).
- Radii (deliberate re-pin; the old 0–4px cap is retired): controls 8px, active tab 10px top,
  raised bands 12px, sheet 16px top. Shadows only via `--dsw-shadow-lv1` (active tab) and
  `--dsw-shadow-lv3` (sheet/popover); no gradients.
- Motion: keep the pinned one-entrance `mem-enter` 160ms / 20/40/60/80ms stagger; add explicit
  150ms transitions on tab/chip/button background+color only, all removed by
  `prefers-reduced-motion: reduce`.
- Tokens allowed: any `--dsw-*`; visual review restricted to the Theme manifest set plus the
  already-shipped `--dsw-alias-label-tertiary`, `--dsw-alias-state-business-primary`,
  `--dsw-alias-interactive-bg-hover`, `--dsw-font-*`, `--dsw-shadow-lv1/lv3`. Tints only via
  `color-mix(in srgb, var(--token) N%, transparent)`.
- Windows: `scrollbar-width: thin` + token `scrollbar-color`, webkit scrollbar thumb built from
  `color-mix` of `--dsw-alias-label-secondary`, so the native 15–17px classic scrollbar never
  appears in a 320px column.

### Shell (`lib/client.js`)

- **Masthead** (modern header, 12–14px padding): row 1 project name in the headline hook + binding
  pill (`.mem-stamp`, pill radius, state-tinted); row 2 `.mem-masthead-sub`; row 3
  `.mem-masthead-meta` = clock (11px secondary, tabular) + refresh icon button
  (`.mem-refresh`, 28–32px ghost square, icon + `aria-label="刷新记忆数据"`; the visible-underlined
  text button is retired). The shell hides the clock when no view has reported yet and the
  current tab has no poll (`meta === null && !polling` → clock omitted) so 图谱/检索 no longer show
  a permanently inert `正在读取…`.
- **Chrome tab strip.** `.mem-tabs`: height 42px, `padding: 6px 6px 0`, `gap: 2px`,
  `background: var(--dsw-alias-bg-layer-1)`, `border-bottom: 1px solid border-l1`.
  `.mem-tab`: `height: 34px`, `min-width: 0`, `margin-bottom: -1px`, transparent background,
  `border: 1px solid transparent; border-bottom: 0; border-radius: 10px 10px 0 0`,
  `font: var(--dsw-font-xxs-strong-12)`, secondary label, 15px icon; hover =
  `--dsw-alias-interactive-bg-hover` + primary label; selected =
  `background: var(--dsw-alias-bg-base)`, `border-color: var(--dsw-alias-border-l1)`,
  `border-bottom-color: var(--dsw-alias-bg-base)`, `box-shadow: var(--dsw-shadow-lv1)`, primary
  label/icon. `role="tablist"/"tab"`, `aria-selected`, roving `tabIndex`, Arrow/Home/End and the
  `aria-controls`/`aria-labelledby` pairing stay; `aria-controls` now points at the one mounted
  tabpanel id. Ordinals are retired in favour of a small inline icon per tab (overview grid, graph
  nodes, search magnifier, health pulse); icons are `aria-hidden`.
- The panel's one `<style>` injection (markers, dedupe selector, `data-plugin-css`) is unchanged.
- Graph view is mounted byte-for-byte as today; only the wrapper `.mem-view` chrome changes.

### 概览 (`lib/memory-panel.js`)

- KPI band as one 4-cell raised surface (2×2 under 360px) — keep `.mem-kpiline/.mem-kpi/
  .mem-kpi-value/.mem-kpi-label` class names and the values/order (记忆条目/关系/孤立/待处理);
  待处理 cells jump to 健康, the other cells jump to 检索.
- Composition becomes one stacked bar + legend: keep 3 `.mem-bar-fill` segments (width %), one
  `.mem-bar-track`; legend rows carry type, count, percent. Merge the separate status-stamp row
  into a quiet chip row (keep `.mem-stamp` class and `is-warn` for contested).
- Recent list: numbered index retired; row = type dot + title (`--dsw-font-xxs-strong-12`) +
  meta `type · relative time` (11px); keep semantic list markup and max 8.
- Health strip: keep `.mem-summary`/`.mem-summary-item` as a 2×2 jump grid; each item keeps its
  state colour.
- Every view has exactly one status/notice source (see 検索 model) — the duplicate loading owner
  is removed.

### 検索 (the reported bug)

- **Single status model.** No status string is stored in state. Derive exactly one status and
  render it in exactly one place:
  `error | loading | idle | empty | results | notice`, where `notice` is a run-scoped flag with
  the identity of the run that produced it (e.g. the unbound→all scope switch), cleared when the
  next run starts. The pre-search hint is the idle state of that one region; no second render
  site falls back to it. Filter chips with an empty query do not start a run and do not set any
  status — they focus the field. Acceptance: a rendered-tree test asserts every status string
  appears at most once across mount / chip clicks / loading / results / error.
- Modern field: rounded `.mem-search-field` (40px, radius 10, raised surface, hairline, 16px
  search icon, 13px input, clear button when non-empty) and a compact primary submit button.
  Keep `role="search"`, the form submit path and the request contract.
- Filter chips: pill toggles (30px high, radius 999) in three groups; each group gets a
  `role="group"` + `aria-label` (类型/状态/范围); `aria-pressed` unchanged; the `全部` clear chip
  still sends an explicit `null`.
- Results: rows without ordinals; title, type/status chips, path breadcrumb, 2-line snippet with
  the query matched inside `<mark>` (token background), score signals as micro chips. Footer
  shows a real total wording (never `共 N 条` when `hasMore`), plus 显示更多/上限 50.
- Head meta stops claiming FTS5 statically; it says 本地记忆索引 (health still reports the real
  backend).
- Copy: idle becomes `输入关键词开始检索，结果来自本地记忆索引。` — rendered once.

### 健康

- Summary 2×2 raised band (索引/队列/热层/摘要) with state colours; then banded sections:
  索引 facts grid + status pill; 队列 counts + failed-job rows with the existing preview/confirm
  retry; 热层 with a 6px rounded meter + zone rows + 整理热层; 今日摘要 facts/findings + publish;
  诊断记录 timeline (retitled from 最近的决策) with time + event + outcome.
- Keep `.mem-stamp`, `.mem-facts`, `.mem-meter-track/.mem-meter-fill`, `.mem-row`, `.mem-event`
  hooks so behaviour tests keep their anchors; the preview→confirm sheet keeps its contract and
  gains 16px top radius, `--dsw-shadow-lv3`, 44px actions and focus restore to the invoking
  control after close.
- Fix the audit's copy defects that are cheap and in-scope: no duplicate type in a row, no
  duplicated loading announcement, no fake stale timestamp (pass the real last-read), retitle the
  diagnostics section, keep the same three mutation capabilities and read-only fallback.

### Windows hardening

- `.gitattributes`: `* text=auto eol=lf` (binaries auto-detected) so a Windows checkout is
  format-clean; extend `test/repo-gates.test.js` to pin the file and the Windows CI leg.
- `.github/workflows/ci.yml`: add a `windows-latest` leg for the supported Node versions running
  the same `npm ci` + `npm run check` (no `if: runner.os` shortcuts); release stays ubuntu-only.
- Fix the measured Windows flake: `test/hooks.test.js` must not `fetch()` an ephemeral port that
  can be Fetch-forbidden; use `node:http` for the loopback request (or retry a forbidden port).
- README pair: state the supported platforms (Windows/macOS/Linux), preserve the documented
  curation `O_NOFOLLOW` limitation as a named limitation, update the panel section to the new
  design, re-record `README.i18n.yaml` hashes.

## Alternatives considered

1. **Keep the editorial "vault ledger" serif direction and only restyle details.** Rejected: the
   user explicitly reports the serif/type as the dated part; the only Windows-rendered faces are
   Palatino Linotype and SimSun.
2. **A card-grid dashboard (dsh-context's full Insights page).** Rejected: at 320px it is exactly
   the "pile of stacked panels" the user rejected; we take its grammar (KPI band, one composition
   view, count-carrying chips, fold-don't-scroll) not its grid.
3. **Add a component library or a CSS framework.** Rejected: the panel is one served asset with no
   bundler and no new runtime dependency is permitted; token CSS and `h()` markup already suffice.
4. **Add `dsh-memory`'s review/history IA to 健康.** Deferred: it needs new backend actions;
   out of scope for this design, recorded as a follow-up.

## Acceptance criteria

- `npm run check` green on Windows (lint, format, types, 1320-test suite, pack contract, archive)
  and the full suite has zero failures; `node test/panel-client.test.js`,
  `node test/panel-ui.test.js`, `node test/memory-panel-behavior.test.js`,
  `node test/panel-assets.test.js`, `node test/architecture.test.js` green individually.
- A regression test proves every 検索 status string renders at most once (mount, empty-chip
  click, loading, results, error, unbound notice).
- Static CSS tests re-pinned deliberately: token-only colours, no hex/rgb/hsl, radii ≤16px,
  shadows only as the two tokens, no gradients, reduced-motion gate, `:focus-visible`, host font
  token present and no serif display stack.
- Tablist keyboard/ARIA preserved; one mounted tabpanel; filter groups named; sheet restores
  focus.
- Windows: `.gitattributes` pinned, windows-latest CI leg present in the workflow and in
  `test/repo-gates.test.js`, the hooks flake fixed, README platform statement updated.
- Version `0.3.0` in `package.json`, `package-lock.json`, `dsh.plugin.json`, `codex/server.mjs`;
  a `## 0.3.0 — 2026-10-28` changelog section (release notes) with honest verification lines;
  README pair + `README.i18n.yaml` hashes consistent.
- Graph body diff is empty for `lib/client.js` lines 24–735 except the surrounding view wrapper.

## Risks and rollback

- **Token absence:** an unshipped `--dsw-*` name resolves to nothing (property ignored). Mitigated
  by restricting to the manifest-confirmed set plus already-shipped names, and by visual check.
- **Chrome strip on a narrow column:** four tabs with icons may crowd at 320px. Mitigated by
  `min-width:0`, icon 15px, 12px labels and a `@container (max-width:359px)` fallback that hides
  icons; no horizontal scroll.
- **Test re-pins hide a real regression:** every relaxed static rule is replaced by a narrower
  assertion in the same commit, and behaviour tests are not deleted.
- **Rollback:** the change is confined to `lib/client.js`, `lib/memory-panel.js`, their tests,
  CI/README/version files; `git revert` of the interface commits restores the 0.2.2 UI with no
  data migration (no payload/schema changes).

## Amendments

**2026-10-28 — health summary is a passive band (amends *概览* line 119).**
The design bullet above asked for `.mem-summary/.mem-summary-item` to stay "a 2×2 jump grid" with
every item keeping its action. The audit it cited at §A3.12 found the opposite problem in the
0.2.2 build: all four cells called the same `onJump('health')`, so the affordance promised four
targets and delivered one. The shipped view therefore keeps the 2×2 band and its state colours but
makes the cells passive; one `全部 →` action in the section head opens 健康, and the KPI band keeps
its own jumps (待处理 → 健康, the rest → 检索). The style contract drops `cursor:pointer`/`:hover`
from `.mem-summary-item` so the band no longer looks clickable. The CHANGELOG and README describe
this shape; the old "jump grid" sentence is superseded rather than silently contradicted.

**2026-10-28 — acceptance wording errata.** Two statements above are clarified, not changed in
intent: the graph-body proof says "lines 24–735", which cannot be literal because the panel
stylesheet sits inside that span and is the thing being redesigned — the intent (and the recorded
proof) is that the graph token block and `GraphCanvas`/`GraphView` are untouched. The test-suite
size in the first acceptance bullet was 1320 at the time of writing; the delivered suite is larger
(1332 tests) and the criterion is "zero failures", not a fixed count. A Windows-only pack defect
found by the final full gate (GNU tar reading `C:\…` as a remote host) was fixed before release.

