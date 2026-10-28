# Memory panel modernisation — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `subagent-driven-development`. Steps use
> checkbox syntax for tracking. One implementer owns one task's file set; commits happen per
> task, not per plan.

**Goal:** ship the frozen design at `docs/superpowers/specs/2026-10-28-memory-panel-modern-design.md`
as version `0.3.0`: modern host-token panel (Chrome-form tabs, modern typography, banded data),
single-source search status (duplicate idle copy removed), unchanged graph body, and Windows
CI/line-ending hardening.
**Architecture:** no new modules; restyle `lib/client.js` (shell + the one injected stylesheet)
and `lib/memory-panel.js` (three views), re-pin their tests deliberately, add Windows CI.
**Tech Stack:** Node 24 test runner, React `h()` (no JSX/build step), token-only CSS in one
served asset, GitHub Actions.
**Base commit:** `92806c1` (`chore(release): 0.2.2`).
**Spec:** `docs/superpowers/specs/2026-10-28-memory-panel-modern-design.md`
**Evidence:** `research/panel-ui-references-2026-10.md`, `research/panel-audit-windows-2026-10.md`.

## Global Constraints

- No new runtime dependency, no new `lib/` module, no new file served by `panel-route`.
- The graph body is frozen: `GraphCanvas`/`GraphView`, the `.memgraph` token block and the
  `graph-renderer`/`graph-settings` imports must not change. Only the `.mem-view` wrapper chrome
  around it may change.
- Panel CSS stays inside the `/* panel-css:start */ … /* panel-css:end */` markers in
  `lib/client.js`, injected once through the existing marker/dedupe selector.
- Colours: only `var(--dsw-*)` (plus `color-mix(in srgb, var(--dsw-*) N%, transparent)`); no
  hex/rgb/hsl literals; no gradients. Shadows only `var(--dsw-shadow-lv1)` /
  `var(--dsw-shadow-lv3)`. Radii ≤ 16px. No custom `font-family` (host `font:` tokens only).
- Preserve: tablist ids/labels/order, roving tabIndex + Arrow/Home/End, `onMeta` report shape,
  `role="search"` form submit path, `aria-pressed` filters and their explicit-`null` clear
  semantics, preview→confirm mutation contract, read-only fallback, the served module's
  no-import/three-export constraint.
- Tests: use direct `node test/<file>.test.js`. Do **not** run `npm test` (the sandbox denies the
  runner's child-process pipes with EPERM; the Lead runs the full gate with full access).
- Format with `node node_modules/prettier/bin/prettier.cjs --write <touched js files>`.
- Conventional commits, no agent trailer. Any commit touching `lib/` appends an honest
  `## Unreleased` entry in `CHANGELOG.md`.
- Architecture budgets may be raised only with the reasoned-comment rule (measured + 30, rounded).

## Task 3 — shell: design system, Chrome tab strip, masthead (implementer `shell-dev`)

**Files:** `lib/client.js`, `test/panel-client.test.js`, `test/panel-ui.test.js` (remove only the
shell-static tests), `test/architecture.test.js` (client budget), `CHANGELOG.md`.
**Detailed brief:** `.superpowers/sdd/2026-10-28-memory-panel-modern-implementation/task-3-brief.md`.

Deliver the complete token-only design-system stylesheet (shell **and** every class the views will
use), the Chrome-form tab strip with per-tab icons, the modern compact masthead, and the tabpanel
ARIA repair. Re-pin the shell static tests in `panel-client.test.js`; move the four shell-static
tests out of `panel-ui.test.js` (they live in `panel-client.test.js` from now on). Graph view body
untouched.

## Task 4 — views: one search status source, then the modern 概览/检索/健康 (implementer `view-dev`)

**Blocked by:** Task 3 (needs the class contract in `client.js`).
**Files:** `lib/memory-panel.js`, `test/panel-ui.test.js`, `test/memory-panel-behavior.test.js`,
`test/panel-assets.test.js`, `test/architecture.test.js` (memory-panel budget), `CHANGELOG.md`.
**Detailed brief:** `.superpowers/sdd/2026-10-28-memory-panel-modern-implementation/task-4-brief.md`.

Two commits: (a) single derived search status + regression test (fixes the reported duplicate
idle copy and the dead unbound notice) while keeping the current markup; (b) the visual
modernisation of all three views against the Task 3 class contract, with test re-pins, the real
stale timestamp, retitled diagnostics, composition bar/legend, filter groups, `mark` snippets and
sheet focus restore.

## Task 5 — Windows hardening (implementer `win-dev`, parallel with Task 3)

**Files:** create `.gitattributes`; modify `.github/workflows/ci.yml`,
`test/repo-gates.test.js`, `test/hooks.test.js`, `CHANGELOG.md`.
**Detailed brief:** `.superpowers/sdd/2026-10-28-memory-panel-modern-implementation/task-5-brief.md`.

Pin LF checkout (`* text=auto eol=lf`), add a `windows-latest` leg running the same
`npm ci` + `npm run check`, assert both in `repo-gates`, and fix the measured Windows flake
(`test/hooks.test.js` asks `fetch()` to reach an ephemeral port that can be Fetch-forbidden; use
`node:http`).

## Task 6 — README pair (implementer `docs-dev`, parallel with Task 4)

**Blocked by:** Task 3 (the panel description is final once the shell commit lands).
**Files:** `README.md`, `README.zh.md`, `README.i18n.yaml`. Do not touch `CHANGELOG.md`.
**Detailed brief:** `.superpowers/sdd/2026-10-28-memory-panel-modern-implementation/task-6-brief.md`.

Both languages in one commit: Windows/macOS/Linux platform statement + curation limitation named,
the new panel description (Chrome tabs, modern data bands, single search status, new copy),
`README.i18n.yaml` hashes re-recorded with `git hash-object`.

## Task 7 — independent review (`reviewer`, blocked by 3, 4, 5, 6)

Read spec + plan + the `.superpowers/sdd/.../review-<base>..<head>.diff` package. Return
spec-compliance and quality verdicts with Critical/Important/Minor and file:line. May run direct
`node test/*.test.js` suites; must not edit code. Write
`.superpowers/sdd/2026-10-28-memory-panel-modern-implementation/review.md`.

## Task 8 — final gate, release, push (Lead)

`npm run check` with full access (approval required), `git diff --check`; fix wave only if the
reviewer finds Critical/Important. Force-add the spec + plan (docs/ is git-ignored by policy,
frozen records are force-added by precedent). Bump `0.3.0` across `package.json`,
`package-lock.json`, `dsh.plugin.json`, `codex/server.mjs`; cut `## 0.3.0 — 2026-10-28` from
`## Unreleased` with `node scripts/changelog-order.mjs --cut 0.3.0 2026-10-28`; verify the
release-notes extractor pair still works; commit `chore(release): 0.3.0`; push `main`. The release
workflow's bootstrap branch tags `v0.3.0` and publishes the changelog section as the release
notes.

## Verification matrix

| Gate | Command | Owner |
|---|---|---|
| Shell contract | `node test/panel-client.test.js` | shell-dev |
| Views + behaviour | `node test/panel-ui.test.js`, `node test/memory-panel-behavior.test.js` | view-dev |
| Served asset + copy | `node test/panel-assets.test.js` | view-dev |
| Structure/budgets | `node test/architecture.test.js` | both |
| Windows CI gate | `node test/repo-gates.test.js`, `node test/hooks.test.js` | win-dev |
| Release notes | `node test/release-notes.test.js` | Lead |
| Full gate | `npm run check` (full access) + `git diff --check` | Lead |
