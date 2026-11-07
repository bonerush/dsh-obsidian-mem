# Curation review in the panel, with automatic review — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (- [ ]) syntax for tracking.

**Goal:** The 健康 panel lists the pending memory-review queue and decides it
(apply/reject) with rendered Markdown; a bounded model reviewer drains
executable proposals automatically; a completed pass retires review-only
findings it disproved.
**Architecture:** One write path — every decision calls
`reviewCurationProposal`; a new `lib/curation-auto.js` (L7) adds the judge, the
panel transport gains two preview/confirm mutations, the panel UI gains one
card and a mini Markdown renderer, and `curateForBinding` reconciles findings.
**Tech Stack:** Node ≥ 22 ESM host plugin, dependency-free browser ES module
panel, `node:test`, Cordis.
**Spec:** `docs/superpowers/specs/2026-11-07-curation-review-panel-design.md`
(frozen 2026-11-07)

## Global Constraints

- Base commit `39d1800`, branch `feat/review-inbox` (typed branch cut from `V2`).
- **Do not commit.** The Lead commits per task after review; keep your writes
  inside your task's file set.
- **Do not edit `test/architecture.test.js`** (LAYERS/BUDGETS): the Lead owns the
  measured integration update. Its failure is expected until then.
- No new runtime dependency. `package.json` `dependencies` stays
  `schemastery` + `yaml`.
- No new `mem_*` tool, no new `mem_admin` action/parameter/enum value.
- Never touch a real vault, `~/.dsh` data root, or a user config. Tests use
  `mktemp` fixtures only.
- Red → green: write the failing test first, run it, then implement; record both
  outputs in the task report.
- Format with `npx prettier --write <files>`; lint with
  `npx eslint <files>`; JSDoc on every new exported function (the repo type
  ratchet reads `// @ts-check` files and `test/jsdoc.test.js` refuses
  Closure-style function types).
- One writer per file set. If you need a file another task owns, message the
  Lead instead of editing it.
- Chinese user-facing copy in the panel is the source string; English is the
  sibling (`text('zh','en')` pattern in `lib/memory-panel.js`).
- Everything the panel sends is bounded and free of absolute paths (mask home
  to `~`).

---

### Task 1: Host review engine (auto-review + reconciliation)

**Files:**
- Create: `lib/curation-auto.js`, `test/curation-auto.test.js`
- Modify: `lib/config.js`, `lib/curation-proposals.js`, `lib/curation-review.js`,
  `lib/services.js`, `lib/index.js`, `lib/diagnostic-codec.js`
- Tests: `test/config.test.js`, `test/curation-proposals.test.js`,
  `test/curation-review.test.js`, `test/diagnostic-codec.test.js`

**Interfaces:**
- Produces (consumed by Task 2): service methods
  `reviewQueue() -> {total,pending,truncated,items,recent}`,
  `reviewDetail(proposalId) -> detail` (shape in spec §Data model),
  `reviewDecision(proposalId, decision, reviewer?) -> reviewCurationProposal value`.
- Produces (consumed by Task 4 docs): config key `autoReview`, default `true`,
  route = `distill.provider` + `distill.model`.
- Produces (consumed by no other task): `reconcileCurationFindings`,
  `autoReviewPendingProposals`, `parseAutoReviewAnswer`,
  `buildAutoReviewRequest`, `AUTO_REVIEW_DEFAULTS`, `AUTO_REVIEW_SYSTEM_PROMPT`;
  `reviewCurationProposal({..., reviewer})` provenance.

**Steps**

- [ ] **Step 1: config.** Add `autoReview: z.boolean().default(true)` after
  `autoCurate` in `lib/config.js`. Test in `test/config.test.js`: default true,
  `false` accepted, a non-boolean refused, and the unknown-key error still names
  all top-level keys. Run `node --test test/config.test.js`.
- [ ] **Step 2: store.** In `lib/curation-proposals.js`:
  (a) export `curationFindingKey(kind, paths)` = `` `scan:${kind}:${[...paths].sort().join('|')}` ``;
  use it in `recordCurationFindings` (byte-identical key);
  (b) export `reconcileCurationFindings({binding,dataRoot,home,scan,now})`
  implementing spec R9 exactly;
  (c) `markCurationProposal` accepts `{decidedBy, decidedByModel, decisionNote}`
  and persists them on the updated record (validated: decidedBy one of
  `human|auto|null`; both strings bounded by `MAX_REASON_CHARS`, clipped);
  (d) `listCurationProposals` rows gain `decidedBy`.
  Tests: retire only when all sources examined + finding absent; keep when a
  source was not examined; keep `dead-wikilink` when `scan.findings` carries
  `resolver-truncated`; keep `near-duplicate` when `scan.complete !== true` or
  `scan.truncated === true`; retired reason recorded; zero pending rows = no
  write; provenance fields round-trip and old records (absent fields) still read.
- [ ] **Step 3: review provenance.** In `lib/curation-review.js` add optional
  `reviewer = {kind:'human'|'auto', model?: string, note?: string}`; validate
  `kind`; pass `decidedBy`/`decidedByModel`/`decisionNote` to
  `markCurationProposal` on both decision branches; auto rejection's stored
  `reason` becomes `an automatic review rejected this candidate: <note>` (the
  human path keeps today's sentence byte-for-byte). No safety check changes.
  Tests: human decision records `decidedBy:'human'`; auto apply records
  `'auto'` + model; auto reject stores the new reason and the note.
- [ ] **Step 4: curation-auto.** Create `lib/curation-auto.js` per spec
  §R5/R7/R8: constants, system prompt, pure `buildAutoReviewRequest`
  (bounded, scenario-specific: `supersede` includes the target's current
  title/status/body; `create-separate` includes the twin note),
  `parseAutoReviewAnswer` (strict single JSON object; unknown verdict, missing or
  non-finite confidence, extra keys or prose throw `AutoReviewError` with a
  code), and `autoReviewPendingProposals` (oldest-first pending executable
  proposals; re-read sources and retire on moved evidence per R6; one
  `llm.stream` call per proposal collecting text from `block-delta` chunks like
  `lib/distill.js:907-1048` does; apply/reject at ≥ minConfidence only; all
  outcomes collected; one content-free diagnostic; `{status,reason,inspected,
  applied,rejected,retired,deferred,refused,model}`). Tests with a fake async
  iterable llm: confident apply → `reviewCurationProposal` applied +
  provenance; `defer`/low confidence/malformed/no route/`autoReview:false` →
  nothing; reject path; source-changed → retired; maxPerPass cap; terminal
  `aborted`/`error` chunk tolerated.
- [ ] **Step 5: services.** Add `reviewQueue`, `reviewDetail`,
  `reviewDecision`, `autoReviewQueue` to `lib/services.js` (shapes in spec;
  detail bodies bounded with `bodyTruncated`; source hash re-read; unknown id →
  coded error `proposal-missing`; `reviewDecision` returns the review value
  unchanged). In `curateForBinding`, after the findings loop call
  `reconcileCurationFindings` and add `reconciled: {retired: n}` to the
  result. Tests: `test/curation-auto.test.js` may not import services; add the
  service assertions to `test/curation-proposals.test.js`? No — add them to
  `test/panel-route.test.js` is Task 2's file. Put service-level tests in a new
  `test/services-review.test.js` (yours). Drive `createMemoryServices` with a
  temp `DSH_HOME`/vault fixture like `test/tools.test.js` does.
- [ ] **Step 6: trigger.** In `lib/index.js`, after `services.curateForBinding`
  settles in `curateNow`'s chain, call a local `maybeAutoReview(binding)`:
  skip when `config.autoReview === false`, when the route is incomplete, when
  `disposed`, when another pass for the project is in flight, or inside a
  5-minute per-project cooldown; read `ctx.get('llm')` at call time; never
  await; record one `curation` diagnostic (`auto-reviewed` outcome with counts,
  or `failed` + code). Keep `lib/index.js` within a small diff.
- [ ] **Step 7: codec.** Add `auto-reviewed` to the `curation` outcome set in
  `lib/diagnostic-codec.js`; add any new literal code family member if the auto
  module emits codes that are not already registered (prefer reusing
  `no-route`, `failed`, and the review codes). Update
  `test/diagnostic-codec.test.js` only for the new outcome.
- [ ] **Step 8: verify.** `npx prettier --write <files> && npx eslint <files>`,
  then `node --test test/config.test.js test/curation-proposals.test.js
  test/curation-review.test.js test/curation-auto.test.js
  test/services-review.test.js test/diagnostic-codec.test.js
  test/curation-scan.test.js test/curation-cli.test.js`. Report exact commands
  and tails. `test/architecture.test.js` failing on layer/budget is expected.

---

### Task 2: Panel transport (mutations + health review card)

**Files:**
- Modify: `lib/panel-actions.js`, `lib/panel-route.js`, `lib/panel-copy.js`
- Tests: `test/panel-actions.test.js`, `test/panel-route.test.js`

**Interfaces:**
- Consumes (from Task 1, contract frozen in spec): `services.reviewQueue()`,
  `services.reviewDetail(proposalId)`, `services.reviewDecision(proposalId,
  decision, reviewer?)`.
- Produces (consumed by Task 3): mutation names `apply-proposal`,
  `reject-proposal`, args `{proposalId}`; preview payload `{title, confirmLabel,
  facts, effects, markdown?, warning?}`; health payload `review` card shape
  (spec §Data model); refusal codes listed in spec §Design.

**Steps**

- [ ] **Step 1: copy.** In `lib/panel-copy.js` add `applyProposal` and
  `rejectProposal` catalogs (zh + en): title, confirmLabel, labels
  (kind/reason/state/sources/effect), effects, warning (supersede moves the
  target's status to superseded; reject changes no note; review-only has no
  apply), `decisionLabel(kind)`, `reviewOnlyNote`, `dismissLabel`. Keep the
  module import-free.
- [ ] **Step 2: mutations.** `lib/panel-actions.js`: extend `PANEL_MUTATIONS`;
  `normalizePanelArgs` accepts exactly `{proposalId}` matching
  `/^[0-9a-f]{64}$/u` for the two mutations; `previewOf` calls a new
  `proposalPreview` that reads `services.reviewDetail`, refuses
  `proposal-missing` (404), `proposal-not-current` when state !== pending (409),
  `review-only` for apply on a review-only row (409), builds facts, effects and
  the Markdown document (candidate title/reason/body, sources with
  match/missing marks, supersede target effect, footer "confirm the decision")
  bounded to fit the 8 KiB preview ceiling; also add `markdown` to the
  `previewPanelAction` return; `revalidate` re-reads `reviewDetail` and returns
  the fingerprint state `{proposalId, state, itemKey, sources:[{path,hash}]}`;
  `mutate` calls `services.reviewDecision(id, 'apply'|'reject', {kind:'human'})`
  and maps a `refused` result's code to `panelError` per spec.
- [ ] **Step 3: health card.** `lib/panel-route.js`: `healthValue` awaits
  `services.reviewQueue()` (feature-detected: a service without it returns the
  empty card, so an older host still answers); build the bounded card
  (`MAX_REVIEW_ITEMS = 20`, `MAX_REVIEW_PATHS = 5`, `MAX_REVIEW_RECENT = 6`,
  reason clipped 200 chars); add to `shrink()` for the health action (recent
  first, then half items) and to the last-resort required-shape branch. The
  unbound value keeps `review: null`? — use the empty card shape
  `{pending:0,total:0,truncated:false,items:[],recent:[],auto:{enabled:false,
  routeConfigured:false}}` so the client has one shape. `CAPABILITIES` gains the
  two mutations automatically from `PANEL_MUTATIONS`.
- [ ] **Step 4: tests.** `test/panel-actions.test.js`: normalize rejects bad
  ids; preview of a pending executable returns token + markdown + facts and
  writes nothing; preview refuses missing/decided/review-only-apply; confirm
  applies via the real `reviewCurationProposal` on a fixture store (or a stub
  service returning `refused` codes for the mapping table); fingerprint
  mismatch = `preview-stale`; replay returns the same result. `test/panel-route.test.js`:
  health carries the bounded review card; unbound project gets the empty card;
  capabilities include the two mutations; trimming drops recent then items; an
  oversized queue still fits the 32 KiB ceiling.
- [ ] **Step 5: verify.** prettier + eslint on the three files, then
  `node --test test/panel-actions.test.js test/panel-route.test.js
  test/panel-digest.test.js test/locale.test.js`. Report commands and tails.

---

### Task 3: Panel UI (健康 review card + Markdown sheet)

**Files:**
- Modify: `lib/memory-panel.js`, `lib/client.js`
- Tests: `test/panel-ui.test.js`

**Interfaces:**
- Consumes (frozen in spec): health payload `review` card (Task 2), mutations
  `apply-proposal`/`reject-proposal` with `{proposalId}` args, preview
  `markdown` field and refusal codes.

**Steps**

- [ ] **Step 1: failure/copy vocabularies.** Add entries to `MUTATION_COPY`,
  `MUTATION_BUSY`, `MUTATION_FAILURES` for the two mutations and the codes
  `proposal-missing`, `proposal-not-current`, `review-only`, `source-changed`,
  `review-recovery-required`, `proposal-unreadable` (zh + en, `text()`).
- [ ] **Step 2: `renderMarkdown(source)`.** Pure function inside
  `createMemoryViews` (or module scope) returning React elements: fenced code,
  headings h1–h6, blockquote, ul/ol items (one level, nested lists allowed via
  indent), hr, paragraphs, and inline code / **bold** / *italic* / `[label](url)`
  links (http/https only, rendered as text + href, `rel="noreferrer"`; other
  schemes stay text). No `dangerouslySetInnerHTML`; an unknown construct renders
  as text. Cap input at 24,000 chars defensively. Tests assert tags/classes and
  that `<script>alert(1)</script>` is text.
- [ ] **Step 3: sheet.** In `renderSheet`, when `sheet.preview.markdown` is a
  non-empty string render it under the facts in a scrollable
  `.mem-sheet-markdown` region; keep the existing facts/effects/actions and the
  a11y contract (`aria-describedby` still names the body).
- [ ] **Step 4: review card.** Add `reviewSection(review, actions)` to the 健康
  view after `queueSection`: stamp with pending count (err tone when an
  executable row is pending), executable rows first with 批准…/拒绝… buttons,
  a 只读发现 sub-list with 忽略… buttons (mutation `reject-proposal`), inline
  empty state ("没有待审阅的记忆"), the auto-review status note when disabled or
  when `auto.routeConfigured` is false, and a 最近处理 list from `recent`
  (kind, state, decidedBy, time). Wire it into `HealthView`'s block list and
  route its two mutations through the existing `preview`/`confirm` functions
  (busy/pending per mutation, outcome line in the card like the other
  mutations). Refuse to render apply for `reviewOnly` rows.
- [ ] **Step 5: styles.** `lib/client.js`: `.mem-review-*` and `.mem-md-*`
  classes (headings, paragraph spacing, list markers, code block background,
  inline code, blockquote border, link colour, truncation for reasons,
  source rows) using existing `--dsw-*` tokens. The class-coverage contract in
  `test/panel-client.test.js` must pass: every `mem-*` class used in the views
  has a stylesheet rule.
- [ ] **Step 6: tests.** `test/panel-ui.test.js`: mount `HealthView` with a
  health fixture carrying a review card; assert both row groups and the auto
  note; click 批准… posts
  `{action:'preview', mutation:'apply-proposal', args:{proposalId}}`; the sheet
  renders markdown (heading/code/list/link elements) and confirms via
  `{action:'confirm', token}`; a `preview-stale` failure closes the sheet and
  refreshes; a review-only row offers no apply control; rendering is
  DOM-free-safe. Report commands and tails.
- [ ] **Step 7: verify.** prettier + eslint on the two files, then
  `node --test test/panel-ui.test.js test/panel-client.test.js
  test/memory-panel-behavior.test.js test/panel-assets.test.js`.

---

### Task 4: Documentation, shipped skill, changelog

**Files:**
- Modify: `README.md`, `README.zh.md`, `README.i18n.yaml`, `CHANGELOG.md`,
  `skills/obsidian-mem/SKILL.md`, `docs/guide/07-tools.md`,
  `docs/guide/08-reliability.md` (as needed)
- No test file; verification is the repo's own gates (README hash pair,
  changelog staged gate, skill/pack contracts).

**Interfaces:** the frozen spec, plan and Task 1's config/routes. Do not invent
names beyond: `autoReview`, `apply-proposal`, `reject-proposal`, the panel card
labels, and the three decision routes (panel / CLI / automatic).

**Steps**

- [ ] **Step 1: README configuration.** Add `autoReview: true` to the example
  config block and the field table (default `true`, boolean; needs
  `distill.provider`/`model` for the automatic reviewer; `false` disables only
  the automatic reviewer). Run the English and Chinese READMEs together, same
  section order.
- [ ] **Step 2: README curation loop.** Rewrite "Automatic curation" §"The
  everyday loop": three routes — 健康 panel card (preview/confirm, Markdown,
  no terminal), the CLI (unchanged, byte-for-byte), automatic review (bounded,
  provenance, when it defers). Replace the false sentence "approval is never
  something a model can do on your behalf" with the precise rule: no tool or
  `mem_admin` value approves; the panel is the human route; the built-in
  reviewer decides only confident executable proposals and records
  `decidedBy:'auto'`; review-only findings are retired deterministically. State
  the honest "what is not automatic" list. Mirror into `README.zh.md`.
- [ ] **Step 3: skill.** `skills/obsidian-mem/SKILL.md` §Automatic curation:
  a pending proposal now has three routes (panel, CLI, automatic reviewer);
  the session model still never approves through a tool; `reviewOnly` rows are
  evidence and are retired by scans; mention `autoReview` and provenance.
- [ ] **Step 4: guide.** `docs/guide/07-tools.md` (curation/review bullet) and
  `docs/guide/08-reliability.md` (review queue story) get one short paragraph
  each if they already document the review command; do not widen scope.
- [ ] **Step 5: changelog.** Add one `## Unreleased` entry in Chinese, repo
  style (what changed, why, what is verified vs not: suite totals measured by
  the Lead later — write "验证：全量 npm run check（见 validation 记录）" and do
  not invent numbers; the Lead fills the final counts).
- [ ] **Step 6: readme pair hash.** Run
  `git hash-object README.md README.zh.md && cat README.i18n.yaml` and update the
  two recorded hashes to the printed values, changing nothing else.
- [ ] **Step 7: verify.** `node -e "require('yaml').parse(...)"` sanity for the
  YAML, `node scripts/verify-changelog.mjs --staged` after the Lead stages (or
  `--base 39d1800` on the committed state), and re-read both README locales for
  equal section structure. Report the hash pair.

---

### Integration (Lead only)

- [ ] Review packages per task, fix loops, then `test/architecture.test.js`:
  add `curation-auto: 7` to `LAYERS`, raise each touched file's budget to its
  measured formatted line count (rule: measured + 30, rounded up to the next 50)
  with one comment per raise naming what the lines buy, and re-run the suite.
- [ ] Full `npm run check`, `git diff --check`; validation record
  `docs/curation-review-panel-validation.md`; commits per task; CHANGELOG counts
  filled from the measured run; final branch review; push only if the user asks.
