# Curation review panel + automatic review — validation record

**Date:** 2026-11-07
**Branch:** `feat/review-inbox` (from `V2` @ `39d1800`), worktree
`.agents/worktrees/dsh-25414cda-e87f`
**Spec:** `docs/superpowers/specs/2026-11-07-curation-review-panel-design.md`
(frozen 2026-11-07; amendments A1–A6)
**Plan:** `docs/superpowers/plans/2026-11-07-curation-review-panel-implementation.md`
**Run workspace:** `.superpowers/sdd/2026-11-07-curation-review-panel/`
(`progress.md`, `task-{1..4}-brief.md`, `task-{1..4}-report.md`,
`review-host.diff` / `review-panel.diff` (pre-fix), `review-host-final.diff` /
`review-panel-final.diff`, `review-host.md`, `review-panel.md` with re-review
sections)

This file records what was actually run and observed. Numbers are outputs, not
estimates; anything not run is marked "not run".

## 1. Baseline (before the feature, this worktree)

| Command | Result |
|---|---|
| `npm ci` | 111 packages, 670 ms |
| `npm test` | `tests 1577 / pass 1576 / fail 0 / skipped 1`, 168 s |
| pack shape (base release text) | 92 tarball entries, 82 lib modules |

## 2. Final repository gate (after the review fix waves)

```sh
npm run check        # lint, format:check, types, full suite, prepack, pack:check
```

Result: **exit 0**.

- `npm run lint` — clean.
- `npm run format:check` — clean.
- `npm run types` — clean (`tsc --noEmit`, the ratchet's listed files).
- Full suite: **1670 tests / 1669 pass / 1 skipped / 0 fail**, 250 s
  (the one skip is the pre-existing live-marketplace probe, opt-in).
- `verify-pack`: OK — version 2.0.3, files allowlist 7 entries, 16 required
  assets present and covered, 6 tools registered, 4 names published.
- `verify-tarball`: OK — **93 entries, 83 lib modules**, every required asset
  present (base: 92/82; the feature adds `lib/curation-auto.js`).
- `git diff --check` — clean.

## 3. Task-level targeted runs (final, from the task reports)

| Run | Result |
|---|---|
| Task 1: `node --test test/curation-auto.test.js test/curation-proposals.test.js test/services-review.test.js` (+ broader curation/config/codec/tools list) | 60/60 pass; 238/238 pass on the wider list |
| Task 2: `node --test test/panel-actions.test.js test/panel-route.test.js` (+ digest/locale/route-guard) | 89/89 pass; 93/93 on the wider list |
| Task 3: `node --test test/panel-ui.test.js test/panel-client.test.js test/memory-panel-behavior.test.js test/panel-assets.test.js test/brief-view.test.js` | 158/158 pass |
| `node --test test/repo-hygiene.test.js` | 5/5 pass (README pair hash + both skill editions + curation-switch needles) |
| `node --test test/architecture.test.js` | 8/8 pass after the Lead's LAYERS/BUDGETS update |
| `npx prettier --check` / `npx eslint` on every changed file | clean (per task report tails) |
| `npx tsc --noEmit` (task reports) | exit 0 |

Red-first evidence (each implementer recorded the failing run before
implementing): task 1 per step — config `36/4 fail`, store missing-export,
provenance `42/3`, services `5/2`; task 1 fix waves — 59 tests `49/10` then
green, plus the residual pins; task 2 — 21 failures, fix wave 2 `86/81/5`,
fix wave 3 `41/40/1`; task 3 — 10 failures, then `104/103/1` for the final
residual; task 4 is docs (no red phase). Exact tails are in the task reports.

## 4. Independent review and fix waves

Two fresh-context reviewers, each with the frozen spec, plan, brief, report and
a review package:

- **review-host (Task 1):** first verdict SPEC **fail** / QUALITY pass —
  0 Critical, **1 Important** (R9: a pass with an unusable link universe —
  denied directory or the 500 ms deadline — has no `resolver-truncated` finding
  and could retire a `dead-wikilink`), 11 Minor. After the fix wave:
  **SPEC pass / QUALITY pass**, 0 Critical / 0 Important.
- **review-panel (Tasks 2+3):** SPEC **pass** / QUALITY **pass** — 0 Critical,
  0 Important, 10 Minor (wire masking, empty-state count, unclosed-fence
  framing, stale comments, dead copy, executable-kind preview consistency,
  measured-card-size deviation, test gaps). After the fix waves: re-confirmed
  **SPEC pass / QUALITY pass**, 0 Critical / 0 Important; the re-reviewer
  reconstructed the pre-fix tree from base+package and diffed it: exactly
  24 hunks / 8 files, no assertion removed or relaxed.
- Fix wave 1 (all three implementers), fix wave 2 (review-host residuals: docs
  drift, load-sensitive fixture, fail-closed branch pin), fix wave 3
  (review-panel residuals: fourth review-only rule, `create-separate` coverage
  + two-source executable-kind pin, missing 409 copy). Verified by
  review-host and review-panel scoped re-reviews.

## 5. Measurements that shaped the design

- **Preview document size** (real preview answer, ceiling 8 KiB = 8,192 B):
  realistic CJK supersede fixture = 2,239 B; service-cap body (16,000 CJK chars)
  fitted to 8,158 B; pathological 20,000 ASCII chars fitted to 8,160 B. The
  document cap is 24,000 chars, but the byte ceiling binds first; the assembler
  trims candidate body → target body → source lines and marks each clip
  (`…（已截断）` / `… (truncated)`).
- **健康 review card** (spec A2): 20 pending rows × 2 CJK paths + 6 recent
  decisions = card **10,267 B**, whole 健康 answer **11,000 B** (32 KiB ceiling).
  The frozen row bounds win over the design's "well under 8 KiB" estimate; the
  hard 32 KiB ceiling and trim order are tested.
- **Auto-review bounds** (code constants): 3 proposals/pass, oldest-first; judge
  input ≤ 12,000 chars; 45 s call timeout composed with the caller signal; 5-min
  per-project cooldown and one in-flight pass; no route or no `llm.stream` ⇒
  zero calls. Confidence gate 0.8.
- **Deterministic retirement** (R9 + A3): review-only kinds only; every source
  path inspected by the pass and its finding key absent; `dead-wikilink` also
  requires `scan.complete === true` (a denied directory / deadline pass has no
  usable link universe even without a `resolver-truncated` finding);
  `near-duplicate` requires a complete untruncated pass; executable proposals are
  never retired by reconciliation. Reconciliation walks the whole store, not the
  newest-200 listing (201-row test).
- **Crash-window guard** (A4): before retiring moved evidence the pass asks the
  transaction ledger; a committed/interrupted apply leaves the row pending with
  `review-recovery-required`; a ledger error fails closed.
- **Zero model call, zero write** when the queue is empty, the reviewer is
  disabled, the route is incomplete, or a scan examined nothing to reconcile.
  A panel read performs no write; the only write path is a confirmed decision.

## 6. Acceptance criteria (spec §Acceptance criteria)

| # | Criterion | Evidence |
|---|---|---|
| 1 | New tests fail before the change, pass after; suites green | task report red→green tails; §2/§3 |
| 2 | Pending executable proposal visible in health `review`; preview returns token + Markdown; moved record ⇒ `preview-stale` and no write | `test/panel-actions.test.js`, `test/panel-route.test.js`, task-2 end-to-end smoke |
| 3 | Confirm applies through `reviewCurationProposal`; health omits it; reject records `decidedBy: 'human'` | task-2 smoke (`{pending:2}` → apply confirm 257 B → post-confirm `recent[0]=applied/human`); `test/curation-review.test.js` |
| 4 | Review-only row rejects but cannot apply (`review-only`); card names `reviewOnly` | over-the-wire 409 case; panel-actions refusal table; panel-ui no-apply test |
| 5 | Confident fake-LLM `apply` applies with `decidedBy:'auto'` + model; defer/low confidence/malformed/no route/disabled change nothing | `test/curation-auto.test.js`; `test/services-review.test.js` |
| 6 | Moved source hash ⇒ auto pass retires, not applies — **except** the A4 crash-recovery case, which stays pending with `review-recovery-required` | `test/curation-auto.test.js` moved-evidence + injected-ledger cases |
| 7 | Reconciliation retires only examined, no-longer-reproducing findings; never for unexamined paths / unusable link universe / incomplete pass | `test/curation-proposals.test.js` R9 cases incl. denied-directory/time-budget shapes; 201-row store walk |
| 8 | Markdown renderer returns elements only; `<script>` renders as text | `test/panel-ui.test.js` (tree + source assertions) |
| 9 | `npm run check` green; tarball 83 lib modules; no new dependency | §2; `package.json` dependencies unchanged (2) |
| 10 | README pair hashes recorded; CHANGELOG names feature + verified state; skill no longer claims CLI-only | `test/repo-hygiene.test.js`; hash pair below; docs cross-check fixes M2–M6 |

Final README pair recorded in `README.i18n.yaml`:

```
README.md    05d74a44d1c001d3c218a3ff3f78ff6c3ca072d2
README.zh.md c5378339c94190bd7cbf51b8a6b8f34c2da079e3
```

## 7. Safety checks specific to this feature

- **No new tool surface and no approval via tools.** `lib/tool-registry.js`,
  `lib/tools.js`, `lib/curation-cli.js` have no diff; `lib/tool-schema.js` changes
  only the model-facing `operation` description plus two comments (no enum,
  default or parameter). The "mem_admin exposes no approval operation"
  assertions stay green.
- **The CLI is unchanged** — TTY on stdin and stdout, byte-for-byte
  `apply <id>`/`reject <id>`, one proposal per run, no `--all`.
- **One write path.** Panel and automatic decisions both call
  `reviewCurationProposal` (claim → re-read under claim → source-hash re-verify →
  reviewed-memory transaction → record marked last). No second
  check-then-write.
- **No note is touched by a rejection, a dismissal or a retirement.**
- **No new runtime dependency; no new inject; `ctx.get('llm')` read at use
  time.**
- **Diagnostics stay content-free**: the `auto-reviewed` event carries counts
  only.
- **Old records read unchanged**: `PROPOSAL_SCHEMA` stays 1; the three
  provenance fields are optional and bounded.
- **Wire paths are home-masked** in the preview document, the confirm result and
  the health review card (review fix M2).
- **Platform note (pre-existing, unchanged):** curation review still relies on
  `O_NOFOLLOW`; the feature adds no new platform dependency.

## 8. Adjudicated limits (deferred, not silent)

- **The `lib/index.js` trigger has no black-box test.** The engine, gates and
  bounds are unit-tested; the assembly wiring (disposed / in-flight / cooldown /
  route / switch, `ctx.get('llm')` at call time) is review-only. A cheap test
  needs two seams in the existing `curationBed` harness; deferred as a Minor.
- **A transient source-read failure (non-ENOENT) during the automatic pass is
  classified with the moved-evidence case and can retire a candidate as
  "evidence changed".** `reviewCurationProposal` itself distinguishes
  `source-changed` from `source-unsafe`; the automatic pass does not. Narrow
  (requires a read failure exactly during the pass); deferred as a Minor,
  recorded here rather than fixed in this feature.
- **`TimeoutError → 'timeout'` classification** is covered for caller aborts
  (`AbortSignal.any` path) but not for a waited-out 45 s timeout; a deterministic
  test needs a fake-timer seam. Deferred (R5).
- **`reconciled` is service-only** (spec A1): the trigger discards the curation
  result and `mem_admin(action="curation")` does not expose the counter; the tool
  surface stays closed.
- **健康 review card can reach ~10.3 KiB** vs the design's "≤ 8 KiB" sentence
  (spec A2): frozen row bounds win; the 32 KiB hard ceiling and trim order are
  tested.
- **M8's 409** for a non-executable operation kind is spec A5; the frozen table's
  "otherwise 503" still holds for genuinely unknown codes.
- **Not run:** a live end-to-end against a real Obsidian vault or the Codex
  adapter (no automatic reviewer exists there by design); Windows-specific
  filesystem paths. Both are stated in the README/skill and unchanged by this
  feature.
