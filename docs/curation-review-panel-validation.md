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

## 9. Plugin-page settings (second feature, same branch, 2026-11-07)

The same typed branch `feat/review-inbox` was then extended with the graphical
settings feature requested after the review panel landed (see
`docs/superpowers/specs/2026-11-07-plugin-settings-panel-design.md`, frozen
2026-11-07, amendments A1–A5; briefs/reports in the same
`.superpowers/sdd/2026-11-07-curation-review-panel/` workspace as
`task-{6..8}-*`). Goal: edit the ~30 config fields on DSH's own Plugins page
instead of hand-editing the profile patch. Non-goals stayed non-goals: the page
never writes the home layer (`$DSH_HOME/cordis.patch.yml`), never exposes the
tool surface, and does not implement volatile semantics.

### 9.1 Shape landed

| Unit | Measured | Budget (architecture.test.js) |
|---|---|---|
| `lib/settings-route.js` (new) | 750 formatted lines | 800 |
| `lib/config.js` | 547 | 600 |
| `lib/index.js` | 340 | 400 |
| `lib/client.js` | 2669 | 2700 |
| `test/settings-route.test.js` (new) | 819 lines, 25 cases | unbudgeted |
| `test/panel-client.test.js` | 52 tests (+10 settings) | unbudgeted |

- `lib/settings-route.js` serves exactly `/obsidian-mem/settings` (GET = read;
  POST read/save/status) behind the existing trusted-origin + `x-obsidian-mem-panel: 1`
  + JSON fence with a 64 KiB body bound. It reads the **live** row
  (`entry.options.config`, so the home layer is visible), projects
  `fields`/`defaults` from `describeConfigFields()` plus `CONFIG_RANGES`, and
  decides writability by comparing live values against
  `configuration().override` (non-empty) else `inherited`.
- Saving validates before writing, refuses a non-writable row with
  409 `not-writable`, guards a second save while a pending record is younger
  than `SETTINGS_PENDING_TTL_MS = 120000`, writes an atomic pending record, then
  schedules `configEditor.edit()` **after** replying `{scheduled, attempt}` (the
  edit remounts this plugin) and records applied/failed for status polling.
- Client: nested optional `slots` inject registers `plugins.bundle.config` keyed
  `dsh-obsidian-mem`; the form is generated from the host schema (boolean,
  enum, integer/number with bounds, string, stringArray), grouped by dotted path
  prefix, bilingual labels, defaults hints, inline range/integer and
  distill-pair validation, dirty tracking, 恢复默认/刷新, reason-aware read-only
  banners (`layer-override` names `$DSH_HOME/cordis.patch.yml` and the
  migration; `config-invalid`/readError shows the error and offers no save).
- `lib/config.js` gained one `CONFIG_RANGES` table (11 bounded fields) shared by
  `validateConfig()` and the projection, so the form cannot drift from the
  validator; the projection is 33 leaves (all except `enabled`).

### 9.2 Final repository gate (after settings review fix waves and budget re-derivation)

```sh
npm run check        # lint, format:check, types, full suite, prepack, pack:check
```

Result: **exit 0** (2026-11-07).

- `npm run lint` — clean.
- `npm run format:check` — clean.
- `npm run types` — clean (`tsc --noEmit`).
- Full suite: **1714 tests / 1713 pass / 1 skipped / 0 fail**, 253 s
  (the one skip is the pre-existing live-marketplace probe).
- `verify-pack`: OK — version 2.0.3, files allowlist 7 entries, 16 required
  assets present and covered, 6 tools registered, 4 names published.
- `verify-tarball`: OK — **94 entries, 84 lib modules**, every required asset
  present (feature baseline: 93/83; settings adds `lib/settings-route.js`).
- `git diff --check` — clean.

### 9.3 Independent review and fix waves

- Round 1 (`review-settings`, fresh context, diff vs `0120868`, DSH 0.2.2-rc.1
  package sources as ground truth): **SPEC fail / QUALITY fail — 1 Critical,
  3 Important, 12 Minor**. Security fence judged sound.
  - **C1 (Critical):** the read used `configEditor.configuration()` (bundle +
    profile layers only); the **home patch** `$DSH_HOME/cordis.patch.yml`
    outranks it and holds the owner's real `- id: obsidian-mem` row (19 keys),
    so the page showed defaults and every save was refused as overridden.
    Fixed by reading the live row and returning `writable:false, reason:
    'layer-override'` with the literal `$DSH_HOME/cordis.patch.yml` migration
    hint; the page never writes that layer.
  - **I1:** a read error returned defaults and still allowed save (a save would
    have silently replaced stored values) → read-only `config-invalid`.
  - **I2:** a stale `pending` record wedged saves forever → 120 s TTL (stale
    status answers failed; a newer save may proceed).
  - **I3:** docs claimed schema defaults and inline validation that were not
    implemented → `CONFIG_RANGES` + projected flags + client defaults/inline
    validation.
- Fix waves were applied by `impl-host` / `impl-ui` / `impl-docs`; re-review
  verdict: **SPEC pass / QUALITY pass — 0 Critical, 0 Important, 15 Minor**.
  N1 (save not gated by the read-only decision) fixed by sharing one
  `rowDecision()` between read and save (409 `not-writable` for all four
  read-only shapes, nothing written or scheduled); N3 (docs said "restart DSH
  or refresh") corrected to **restart DSH** because the host does not watch
  patch files; N5 skipped (integer wire shape already pinned by the projection
  test).

### 9.4 Deferred minors (recorded, not silent)

- **N2** — layer-equality corner: the "row or its config" nuance when a
  higher layer overrides only part of the row; the resolved-row decision is
  conservative (read-only) and the copy explains migration.
- **N4** — 409/timeout copy does not state "retry in up to 2 minutes" (TTL
  behaviour is tested; wording not).
- **N6** — older-editor fallback path untested (this desktop ships the
  documented `configEditor` surface).
- **M1** — status-without-attempt ordering/JSDoc nuance.
- **M2** — response ceilings hold by construction, not a measured cap, for
  user-supplied `ignoreGlobs` (bounded elsewhere).
- **M5** — client budget comment numbers drift from measured lines (budget
  itself is enforced by the architecture test).
- **M6** — LAYERS comment placement.
- **M8** — glob trim in a fixture.
- **M10** — the "~1–2 s reload" wording is reasoned, not measured.
- **M11** — diagnostics hint in the timeout copy is frozen by the spec.
- **M12** — projection error branches are not all exercised; save completeness
  is not asserted for every field type.
- **Not run live:** the page was exercised through the real host route with the
  dashboard harness and real loopback HTTP, not yet in the running DSH desktop
  UI; the owner restart is the live check. The host does not watch patch files,
  so a restart (not a page refresh) is required after changing the home layer.

### 9.5 Known user-facing consequence (home layer)

The owner's current configuration lives in the home patch
(`$DSH_HOME/cordis.patch.yml`, one `- id: obsidian-mem` row with 19 keys), and
that layer outranks the profile. Until those keys are removed from the home
layer and DSH is restarted, the new settings page correctly reports
**read-only — overridden by a higher layer** instead of silently writing a
profile patch that would never apply. This is the C1 fix behaving as designed,
not a bug; the page itself never edits the home layer.

## 10. Toggle switches and home-layer migration (owner follow-up, 2026-11-07)

**Trigger.** After the settings page shipped in `b537039` and was installed, the owner
reported that the form could not be used at all: every control was grey/inert. The same
message asked for a second change: replace the boolean checkboxes with phone-style toggle
buttons.

**Cause.** Exactly the case §9.5 predicted. The owner's configuration lived in the home
patch (`$DSH_HOME/cordis.patch.yml`, one `- id: obsidian-mem` row, 19 top-level keys);
that layer outranks the profile, so the route correctly answered `writable:false,
reason:'layer-override'` and the client correctly disabled the controls. The plugin code
was not broken; the installed config location was.

**Migration (operator action, explicit owner consent).** The owner chose "迁移到 profile
层，现在帮我做" when asked. `/tmp/migrate-obsidian-config.mjs --apply` then:

- backed the home patch up to `~/.dsh/cordis.patch.yml.bak-2026-11-07T13-19-14`
  (1,359 B, mode 600) and replaced the file with the four general comment lines, a note
  naming the backup, and `[]` (435 B, mode 600);
- appended the row text verbatim (`- id: obsidian-mem` + the full `config:` block) to
  `~/.dsh/profiles/desktop/cordis.patch.yml` (3,866 B, mode 600);
- verified with the repo-resolvable `yaml` package that the home file parses to `[]`,
  the profile file parses to 19 entries, and the migrated `config` deep-equals the
  original 19-key object. The page still never writes the home layer; a restart (not a
  refresh) remains required because the host does not watch patch files.

**Toggle switches (presentation only).** The `boolean` branch in `lib/client.js` now
renders a real `<button type="button" role="switch" aria-checked aria-label>` with an
inline-styled track/knob using the verified tokens (`--dsw-alias-border-l2` off,
`--dsw-alias-brand-primary` on), plus the same click-to-dirty path the checkbox had. It
is still inline styles only — the form adds no stylesheet class — and `disabled` still
follows the host's writable decision. `test/panel-client.test.js` was updated (checkbox
assertions removed, new test "boolean fields are toggle switches and a click dirties the
form"): 53 tests / 53 pass. `test/architecture.test.js` budget for `lib/client.js` was
raised 2,700 → 2,750 (2,716 formatted lines measured; measured-plus-30 is 2,746).

**Gate.** `npm run check` exit 0: 1715 tests / 1714 pass / 1 skipped; `verify-pack`
16 required assets present and covered, 6 tools registered and 4 names published;
`verify-tarball` 94 entries / 84 lib modules.

**Spec.** Amendments A6 (toggles) and A7 (migration) were appended to
`docs/superpowers/specs/2026-11-07-plugin-settings-panel-design.md`.

**Not changed.** No host route, schema, default, or tool surface changed in this
follow-up; the read-only decision still applies whenever a higher layer really is present.
