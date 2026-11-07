# Curation review in the panel, with automatic review — design

**Status:** frozen 2026-11-07
**Owner:** Lead (DSH session, worktree `feat/review-inbox`, base `39d1800` on `V2`)
**Amends:** `2026-10-05-memory-retrieval-efficiency-design.md` §curation (the review
route it defined is `lib/curation-cli.js` only)
**Evidence:** local source, file:line below; no external claim is load-bearing.

## Problem and evidence

1. **The only deciding route is a terminal CLI.** `lib/curation-cli.js:1-30` states
   the design: approval is deliberately *not* a tool, an admin action or an HTTP
   surface; it is a command run by the vault's owner, and it needs a TTY on stdin
   and stdout. Its output is plain text assembled by
   `renderCurationProposal` (`lib/curation-review.js:753-802`): no Markdown is
   rendered, no line can be clicked, and the decision must be typed
   byte-for-byte (`apply <id>` / `reject <id>`).
2. **Executable proposals therefore pile up.** A `supersede` or
   `create-separate` candidate is parked at `lib/curation-proposals.js:676`
   (`saveCurationProposal`) and only `reviewCurationProposal`
   (`lib/curation-review.js:545`) may consume it. With no panel route and no
   automatic decision, a user who does not open a terminal accumulates pending
   proposals for the life of the project. The shipped skill says the same:
   `skills/obsidian-mem/SKILL.md` §Automatic curation.
3. **Review-only findings never retire when they stop reproducing.**
   `recordCurationFindings` (`lib/curation-proposals.js:1017-1148`) retires a
   pending review-only proposal only when the *same* finding returns with
   different bytes. If a `dead-wikilink` / `missing-provenance` /
   `expired-review` finding disappears because the note was fixed, its old
   record stays `pending` forever. Nothing reconciles the queue with the scan
   that just examined the note.
4. **The panel already owns the safe write machinery.** The 健康 view
   (`lib/memory-panel.js:4015`) renders cards and runs preview → confirm
   mutations (`lib/panel-actions.js:26`, `lib/panel-route.js:615`): a preview
   token is bound to a fingerprint of the facts shown, and confirming re-reads
   them and refuses `preview-stale` if they moved
   (`lib/panel-actions.js:334-420`). Nothing in that machinery lets a proposal
   be decided.
5. **The owner's intent is a self-running memory system.** The memory pipeline
   already writes notes automatically (`autoCapture`, `autoCurate`); requiring a
   terminal visit for every semantic candidate contradicts it — the user asked
   to (a) make the rare human decision easy, on the panel, and (b) let a model
   decide the rest so months can pass without review.

## Goals / non-goals

**Goals (observable):**

- G1. The 健康 page shows the pending review queue (executable proposals and
  review-only findings named separately), each row openable into a sheet that
  renders the candidate body as Markdown, its sources and a supersede target's
  before/after, with 批准 / 拒绝 buttons; the decision runs the same
  `reviewCurationProposal` the CLI runs.
- G2. A configured model route lets the plugin review executable proposals on
  its own: apply or reject when the strict verdict is confident and the evidence
  has not moved, otherwise leave the row pending. Provenance is recorded.
- G3. A completed curation pass retires review-only findings it examined and no
  longer reproduces, so the queue cannot grow forever with fixed notes.
- G4. `autoReview: false` disables G2 only; no route (empty
  `distill.provider/model`) makes G2 a no-op with a stated reason; zero human
  action is required for the memory system to keep working.
- G5. README pair, shipped skill, CHANGELOG and docs guide describe the new
  routes truthfully; the CLAIM "approval is never something a model can do on
  your behalf" is replaced with the precise new rule (R4).
- G6. Tests cover each path red→green; `npm run check` is green.

**Non-goals:**

- No new `mem_*` tool and no new `mem_admin` action, parameter or enum value for
  approval (R4). The session model still cannot decide a proposal through tools.
- No change to `dsh-obsidian-mem-review`; the CLI stays the byte-for-byte route
  for a human at a terminal.
- No model decision for review-only findings (they are evidence, not plans).
- No new runtime dependency and no bundled Markdown library: the panel is served
  standalone and must keep rendering without a bundler.
- No proposal schema version bump: provenance fields are additive.
- No new panel read action and no new panel tab: the queue rides the existing
  `health` payload.

## Design

### Rulings

- **R1 — One write path.** A panel decision and an automatic decision both call
  `reviewCurationProposal` (`lib/curation-review.js:545`). It already reads the
  record, takes the proposal claim, re-reads under the claim, re-verifies every
  source hash, writes through `applyReviewedMemory`, and persists the decision
  last. No second check-then-write is added anywhere.
- **R2 — Two decisions.** `apply` and `reject` only, exactly the CLI vocabulary.
  A review-only row can be rejected (a human read the finding and dismissed it)
  but never applied; the panel hides the apply control for it. `retired` stays a
  store state written by scans and by the automatic reviewer, not a panel verb.
- **R3 — Route.** Automatic review uses `distill.provider` +
  `distill.model`; both must be set. An empty pair means "reuse the session's
  last recorded route", which a background curation trigger cannot know, so it
  is reported as `no-route` and the queue waits for the panel. `autoReview:
  true` (default) enables the reviewer; `false` disables only it.
- **R4 — No model-callable approval.** The review command stays the only *tool
  surface* route, and no `mem_admin` value changes. The automatic reviewer is
  plugin-internal: it is bounded (R7), it records provenance (R8), it is not
  reachable from a tool call. The README/skill sentence is rewritten to say
  exactly that, instead of the now-false stronger claim.
- **R5 — Verdict contract.** The judge is one tool-free `llm.stream()` call (the
  shape measured in `docs/p0-compatibility.md` §8.3 and already used by
  `lib/distill.js:907-1048`). It must answer one JSON object
  `{"verdict":"apply"|"reject"|"defer","confidence":0..1,"reason":string}`;
  unknown verdict, non-finite confidence, extra fields or prose are refused
  whole (that proposal defers). Only `apply`/`reject` at confidence ≥ 0.8 act.
  The candidate's body, its sources and — for a supersede — the target note's
  current title/status/body are the only inputs; nothing is read from another
  project.
- **R6 — Evidence re-check.** Before calling the reviewer, every source hash is
  re-read. A proposal whose evidence changed is **retired** with a decision note
  (`an automatic review found the evidence changed before a decision`), because
  no action could ever apply it; the panel never saw it either, and the next
  distillation produces a fresh candidate. A proposal that fails for any other
  executable reason is left pending and reported.
- **R7 — Bounds (measured constants, not config):** at most 3 proposals per
  pass; ≤ 12,000 characters of judge input per proposal; 45 s per call; a 5 min
  per-project cooldown and one in-flight pass per project; the judge is skipped
  when `ctx.get('llm')` has no `stream` (P0: the service is absent during
  `apply`).
- **R8 — Provenance, additive.** A decided record may carry
  `decidedBy: "human"|"auto"`, `decidedByModel: string|null` and
  `decisionNote: string|null` (≤ 2,048 chars). The reader tolerates their
  absence (old records) and refuses nothing new; `PROPOSAL_SCHEMA` stays 1.
  `markCurationProposal` accepts them in its transition input.
- **R9 — Deterministic retirement of review-only findings.** After a pass
  records its findings, a new store function reconciles pending review-only
  proposals against that pass. A row retires only when *all* of its source paths
  were inspected by this pass and no current finding has its key:
  `missing-provenance` and `expired-review` need the note itself examined;
  `dead-wikilink` additionally needs a complete link universe (`resolver-truncated`
  absent); a `near-duplicate` finding additionally needs a complete, untruncated
  pass. Anything less leaves it pending. Retired reason names the rule.
- **R10 — Transport.** The queue rides the existing `health` action as a
  `review` card (no fourth read action; the route pins its read vocabulary).
  The panel's mutation vocabulary grows by two: `apply-proposal` and
  `reject-proposal`, argument `{proposalId}` (64 lowercase hex). Preview
  assembles a bounded Markdown document host-side and returns it as an additive
  `preview.markdown` field; the panel renders it with a small dependency-free
  renderer (headings, paragraphs, lists, quotes, code fences, inline code,
  bold/italic, links) — React elements only, never `innerHTML`.
- **R11 — Config.** One new top-level boolean `autoReview: true`. The
  unknown-key refusal is derived from the schema
  (`lib/config.js:101-141`), so it needs no second list.
- **R12 — Nothing-to-do is free.** An empty queue, a disabled `autoReview`, a
  missing route, or a pass that found nothing to reconcile performs no model
  call and no vault write; a panel read performs no write at all.

### Data model and files

**Proposal record (additive, no version bump).**

```js
{
  // existing: version, proposalId, projectId, itemKey, kind, state, reason,
  // createdAt, seenAt, decidedAt, retiredAt, retiredReason, sources[], operation|null
  decidedBy: "human" | "auto" | undefined,
  decidedByModel: "provider/model" | null | undefined,
  decisionNote: string | null | undefined,
}
```

**New module `lib/curation-auto.js` (layer 7).** Imports `curation-review`
(L6) and `curation-proposals` (L5) only — both strictly below L7, so `services`
(L8) and `index` (L10) may import it, and no upward edge is created.

Exports:

- `AUTO_REVIEW_DEFAULTS = { maxPerPass: 3, minConfidence: 0.8,
  maxInputChars: 12000, timeoutMs: 45000, maxReasonChars: 500 }`
- `AUTO_REVIEW_SYSTEM_PROMPT: string` — rubric: when a supersede/create-separate
  candidate should be published, when its evidence is weak, that it must defer
  rather than guess, and the exact JSON shape.
- `buildAutoReviewRequest({ proposal, target })` → `{system, user}` (pure;
  bounded; testable without a model).
- `parseAutoReviewAnswer(text)` → `{verdict, confidence, reason}`; throws
  `AutoReviewError` with a code on a contract violation (never returns a guess).
- `autoReviewPendingProposals({ binding, dataRoot, home, config, llm, now,
  diagnostics?, maxPerPass?, minConfidence?, maxInputChars?, timeoutMs?,
  clock? })` → `{status:'reviewed'|'skipped'|'failed', reason?, inspected,
  applied:[ids], rejected:[ids], retired:[ids], deferred:[ids],
  refused:[{proposalId, code}], model}`. Applies through
  `reviewCurationProposal`; retires through `markCurationProposal`; records one
  content-free `curation` diagnostic with outcome `auto-reviewed`.

**`lib/curation-proposals.js`.** Add `curationFindingKey(kind, paths)` (factor
out of `recordCurationFindings`, same string) and
`reconcileCurationFindings({ binding, dataRoot, home, scan, now })` →
`{ retired: object[], reason: string|null }` implementing R9. Extend
`markCurationProposal` with `decidedBy` / `decidedByModel` / `decisionNote`
inputs written on every transition (bounded, validated). `listCurationProposals`
rows gain `decidedBy` (read-only projection).

**`lib/curation-review.js`.** `reviewCurationProposal` gains optional
`reviewer = { kind: 'human'|'auto', model?: string, note?: string }` (default
`{kind:'human'}`). It passes the three provenance fields to
`markCurationProposal`; a rejection's stored `reason` stays the existing
human sentence for a human reviewer and becomes `an automatic review rejected
this candidate: <note>` for an automatic one. No safety check changes.

**`lib/services.js`.** New instance methods (the panel and `index.js` call
them; no tool touches them):

- `reviewQueue()` → `{total, pending, truncated, items[], recent[]}` (bounded;
  `items` pending rows newest-first with `proposalId/kind/reason/reviewOnly/
  paths/createdAt`; `recent` ≤ 6 rows of any decided state newest-first with
  provenance).
- `reviewDetail(proposalId)` → `{proposalId, kind, state, reason, reviewOnly,
  itemKey, createdAt, sources:[{path,hash,currentHash,matched,missing}],
  operation:{kind,title,body,bodyTruncated,supersedesId,target}|null}` where
  `target` is `{path,title,status,body,bodyTruncated}` for a supersede (the note
  whose status the write moves). Every body is bounded (candidate 16,000 chars,
  target 4,000) and a `bodyTruncated` flag is set instead of silently clipping.
  Unknown id → coded error `proposal-missing` (404).
- `reviewDecision(proposalId, decision, reviewer?)` → the
  `reviewCurationProposal` value (`applied`/`rejected`/`refused`), no mapping
  that hides the refusal code.
- `retireProposal(proposalId, reason)` — internal only (used by the automatic
  reviewer through the store, not exposed to tools).
- `autoReviewQueue(binding, { llm, now })` → pass-through to
  `autoReviewPendingProposals` with the service's data root/route/config.
- `curateForBinding` calls `reconcileCurationFindings` after it records the
  pass's findings, and reports the retirement count in its result
  (`reconciled: {retired: n}`), so the existing curation result names it.

**`lib/panel-actions.js`.** `PANEL_MUTATIONS` becomes
`['retry-job','compact-hot','refresh-digest','apply-proposal','reject-proposal']`;
`normalizePanelArgs` requires one `{proposalId}`; preview builds facts plus a
bounded Markdown `markdown` string from `services.reviewDetail` (title, kind,
reason, body, sources with hash-match state, supersede effect, footer naming the
decision); the confirm fingerprint state is
`{proposalId, state, itemKey, sources:[{path,hash}]}`; the confirm mutation calls
`services.reviewDecision(proposalId, decision)` and maps `refused` codes to
`panelError` codes (`proposal-missing` 404, `proposal-not-current` 409,
`source-changed`/`review-only` 409, `review-recovery-required` 409,
otherwise `unavailable` 503).

**`lib/panel-route.js`.** `healthValue` reads `services.reviewQueue()` and adds:

```js
review: {
  pending: n, total: n, truncated: bool,
  items: [{proposalId, kind, reason, reviewOnly, paths:[≤5], createdAt}],  // ≤20
  recent: [{proposalId, kind, state, decidedBy, decidedAt, reason}],       // ≤6
  auto: { enabled: bool, routeConfigured: bool },
}
```

`fit()` drops `review.recent`, then halves `review.items`, then empties both for
the health action. The 32 KiB ceiling is unchanged; the card is bounded by
construction to well under 8 KiB.

**`lib/memory-panel.js`.** New 健康 card `reviewSection(review, actions)` placed
after the queue card: a stamp with the pending count, executable rows first
(kind label, clipped reason, paths, age, 批准… / 拒绝… buttons), review-only rows
under a sub-heading with one 忽略… button (a reject), an inline empty state, a
"自动审阅未启用 / 未配置模型路由" note when `auto.enabled` is false or
`auto.routeConfigured` is false, and a 最近自动处理 list from `recent`. The
sheet grows an optional rendered-Markdown body (`sheet.preview.markdown`) below
the facts; `MUTATION_COPY`/`MUTATION_BUSY`/`MUTATION_FAILURES` gain the two
mutations and the new refusal codes. `renderMarkdown` is a small pure renderer
returning React elements.

**`lib/client.js`.** Styles for the new classes (`.mem-review-*`, `.mem-md-*`)
using existing `--dsw-*` tokens only; the class-coverage contract in
`test/panel-client.test.js` holds.

**`lib/config.js`.** `autoReview: z.boolean().default(true)` after `autoCurate`.

**`lib/index.js`.** `curateNow`'s chain, after the pass settles, calls
`maybeAutoReview(binding)` when `config.autoReview !== false` and the route is
configured: an in-flight set + 5 min per-project cooldown + `ctx.get('llm')` at
use time; never awaited; failures recorded as one `curation` diagnostic.

**`lib/diagnostic-codec.js`.** `curation` outcomes gain `auto-reviewed`; any new
literal code the auto module emits is either already registered or added to the
derived family. `test/diagnostic-codec.test.js` stays the binding test.

### Read, write and failure paths

1. **Human, panel.** 健康 poll → `review` card. Button → POST
   `{action:'preview', mutation:'apply-proposal', args:{proposalId}}` → route
   resolves session/binding → `previewPanelAction` → `services.reviewDetail` →
   token + facts + markdown. Sheet shows it. Confirm → token fingerprint is
   re-read (`reviewDetail` again) and compared; mismatch = `preview-stale` and
   nothing is written. Match → `services.reviewDecision` →
   `reviewCurationProposal`; a vault write commits through the transaction
   engine, then the record is marked; the sheet closes and the health poll
   refreshes. A refusal code is shown in the sheet without discarding the
   preview unless it invalidates the token.
2. **Automatic.** `curateNow` settles → cooldown/route/gates → list pending
   executable proposals (oldest first) → per proposal: re-read sources, retire
   on moved evidence (R6), else one judge call → apply/reject/defer per R5 →
   mark with provenance → one diagnostic. Refusals are collected, never thrown;
   a pass never blocks a turn or a queue job.
3. **Deterministic retirement.** A pass records findings, then
   `reconcileCurationFindings` lists pending review-only rows and retires the
   ones the pass disproved under R9; a retirement is a state transition under
   the vault lock, no note is touched.
4. **Unbound / malformed.** An unbound project reads the empty review card; a
   malformed proposal id is a 400 from argument normalization; a missing record
   is `proposal-missing`; a stale preview is a 409; nothing falls back to a
   silent write.

### Token / context budget

- No change to the injected brief or per-turn recall budgets: the queue is not
  injected. The review card is bounded to ≤ 20 rows + 6 recent rows + clipped
  reason/path strings, ≤ 8 KiB of the existing 32 KiB health ceiling.
- Automatic review: ≤ 3 calls/pass, ≤ 12,000 chars input per call, 45 s timeout,
  5 min per-project cooldown. An idle project with no pending executable
  proposal makes no call at all.
- The Markdown document sent to the panel is assembled host-side and capped at
  24,000 characters (candidate 16,000 + target 4,000 + framing) in the preview
  payload, inside the existing 8 KiB *preview* ceiling after trimming? — no:
  preview answers are capped at 8 KiB, so the document is assembled to fit that
  ceiling **by construction** (candidate body clipped to 5,500 chars, target
  body to 1,500, sources/facts as short lines); the sheet scrolls.

### Compatibility and safety

- DSH host seam unchanged: no new inject; `ctx.get('llm')` read at use time.
- Vault rules unchanged: no note is written except through the existing
  reviewed-memory transaction; review-only retirement changes private JSON only;
  no deletes; `trust: owner` untouched.
- Panel transport unchanged: preview/confirm tokens, same-origin fence
  (`lib/panel-route.js:143-160`), per-session/project binding.
- Layer table: new `curation-auto: 7`; `services` (8) and `index` (10) may
  import it downward. Budgets are raised in the same commit with the measured
  numbers (architecture test is a reviewed decision).
- Old records read unchanged (R8); old clients ignore the new mutation names and
  the `review` card; a new client against an old host sees no capabilities for
  the two mutations and falls back to the read-only ledger.

## Alternatives considered

- **Keep CLI-only.** Rejected: that is the reported problem; printing plain text
  to a terminal is not reviewable at a glance and costs a context switch.
- **Add a `mem_admin` approval action.** Rejected: the shipped skill's security
  rule ("the model may not promote its own claims") and `curation-cli.js`'s
  design both forbid it; the session model would be able to approve its own
  parked candidates. R4 keeps that boundary.
- **Panel-only, no automatic review.** Rejected: does not satisfy "months
  without review"; the queue would still need routine visits.
- **Auto-apply every parked candidate.** Rejected: the parked set exists because
  semantic decisions are not mechanical; confidence-gated judging plus evidence
  re-verification is the smallest honest automation.
- **A real Markdown library (`marked`, `react-markdown`).** Rejected: the panel
  module is served standalone with no bundler, `package.json` has exactly two
  runtime deps, and a `dangerouslySetInnerHTML` route would create an injection
  surface for note text. A ~120-line element renderer is enough for note bodies.
- **A fourth read action `review`.** Rejected: the route pins its read
  vocabulary and every chart already rides `health`/`overview`; one poll fewer.
- **Deciding review-only findings with the model.** Rejected: they are evidence,
  not plans; a deterministic reconciliation is exact and free.

## Acceptance criteria

1. `npm test` green; new tests fail before the implementation (recorded in the
   task reports) — `test/curation-auto.test.js`,
   `test/panel-actions.test.js`, `test/panel-route.test.js`,
   `test/panel-ui.test.js`, `test/curation-proposals.test.js`,
   `test/config.test.js` additions.
2. A pending executable proposal is visible in the health payload with its
   bounded row shape, and `preview` returns a token + Markdown for its id; a
   concurrent state change makes the confirm answer `preview-stale` and writes
   nothing.
3. A confirm with the current state applies the proposal through
   `reviewCurationProposal` and the health read then omits it from `items`, and
   a rejection marks it `rejected` with `decidedBy: 'human'`.
4. A review-only row can be rejected but not applied (panel action refuses
   `review-only`); the health card names it `reviewOnly: true`.
5. With `autoReview: true` and a route, a fake `llm` returning a confident
   `apply` applies exactly that proposal and records `decidedBy: 'auto'` +
   model; a `defer`, a low confidence or a malformed answer changes nothing; a
   `reject` marks it rejected. No route / `autoReview: false` / no pending
   executable proposal ⇒ zero model calls.
6. A proposal whose source hash moved is retired by the auto pass, not applied.
7. A completed pass retires a pending `missing-provenance` finding whose note it
   examined and which it no longer reports; it does not retire one for a path it
   did not examine, for `dead-wikilink` when the link universe was truncated, or
   for `near-duplicate` in an incomplete pass.
8. The Markdown renderer renders headings/code/lists/links as React elements and
   never as HTML; a body containing `<script>` renders as text.
9. `npm run check` green (lint, format, types, suite, pack contract, tarball).
   `verify-tarball` reports the new module count (83 lib files, one more than
   base 82) and no new runtime dependency.
10. README pair hashes in `README.i18n.yaml` match
    (`git hash-object README.md README.zh.md`), the CHANGELOG `## Unreleased`
    section names the feature and its verified/unverified state, and
    `skills/obsidian-mem/SKILL.md` no longer claims the CLI is the only route.

## Risks and rollback

- **A bad automatic decision changes a note.** It is one reviewed-memory
  transaction, recorded in receipts and in the proposal's provenance; the
  pre-write snapshot lives in `_meta/.history/` like every transaction. Rollback
  for a user is the normal supersede/edit path; for the feature, set
  `autoReview: false` (no code change) or revert the release commit.
- **Model cost.** Bounded by R7; an idle queue costs nothing; the same route is
  already used by distillation.
- **Queue scan on every panel poll.** `listCurationProposals` reads every
  proposal file; the store is bounded by `MAX_LIST_LIMIT` 200 and records are
  small. The card is one read per 15 s poll; if measured too heavy, the service
  may cache one answer per project for the poll window without changing the
  contract.
- **Layer/budget churn.** New module + larger files are visible in
  `test/architecture.test.js` with measured numbers and a comment, as the
  repository requires.

---

## Amendments (post-freeze rulings, each with the evidence that forced it)

**A1 — 2026-11-07, `reconciled` stays service-only.** The §`lib/services.js` sentence
"reports the retirement count in its result (`reconciled: {retired: n}`), so the
existing curation result names it" is amended: the count is returned by the service
method, but it is stripped from the `mem_admin(action="curation")` projection because
`CURATION_RESULT` is a closed model-facing schema. Extending that schema would be a
tool-surface change for a diagnostic counter; R4's conservative reading keeps the
surface fixed. Direct service callers and tests receive it; the `lib/index.js` trigger
discards the curation result and does not use the count.

**A2 — 2026-11-07, the 健康 review card's measured size supersedes the design
estimate.** The §Token/context budget sentence "the card is bounded by construction to
well under 8 KiB" is amended by measurement: a realistic full card (20 pending rows
with two CJK-ish paths each + 6 recent rows) measures 10,267 B and the whole 健康
answer 11,000 B, because the frozen row bounds (20 rows, 200-char reasons, 240-char
paths) cannot fit in 8 KiB for CJK text. The row bounds win; the hard 32 KiB health
ceiling and the trim order (recent → half items → last-resort empties) are what the
tests pin. Numbers recorded in `docs/curation-review-panel-validation.md`.

**A3 — 2026-11-07, R9's "complete link universe" is `scan.complete === true`.**
The R9 parenthetical "(resolver-truncated absent)" names only the resolver's file bound;
the scanner also returns `files: null` and judges no link dead when a directory is
denied or the wall-clock deadline stops the walk, and neither produces a
`resolver-truncated` finding. The implementation therefore requires the pass's own
coverage claim for a `dead-wikilink` retirement (`scan.complete === true` in addition to
no `resolver-truncated`). Without this, a routine 500 ms-deadline pass could permanently
retire a real dead link (a replayed finding lands on the retired record).

**A4 — 2026-11-07, R6's moved-evidence retirement consults crash-recovery evidence.**
Before retiring a proposal because its sources moved, the automatic pass checks
`hasTransactionEvidence` for the proposal's item key; a committed/interrupted
application leaves the row `pending` and reports `review-recovery-required` instead, so
the human/CLI recovery route the executor defines stays reachable. This keeps R6's
"no action could ever apply it" honest for the crash window.

**A5 — 2026-11-07, a non-executable operation kind is a 409 at preview, not
`unavailable` 503.** The §`lib/panel-actions.js` refusal table's last row
("otherwise `unavailable` 503") is amended for one case: a stored record whose
`operation.kind` is outside `{supersede, create-separate}` now refuses the preview with
`operation-not-executable` mapped to **409**. The reason is that this is a property of
the record (a conflict the user must inspect/dismiss), not a transient service outage,
so 503 would invite a retry that can never succeed; the wire table keeps 503 for
genuinely unregistered codes. The store's own executor still refuses the same record
(`operation-not-executable`), and no write is attempted either way.

**A6 — 2026-11-07, `curation-auto`'s import set grew by the transaction ledger.**
The §Data model sentence "Imports `curation-review` (L6) and `curation-proposals` (L5)
only" is amended: A4's crash-recovery guard imports `hasTransactionEvidence` from
`lib/transaction.js` (L3). The layer conclusion is unchanged — L7 is still strictly
above every import — and the architecture test's edge check covers the new downward
edge; the guard is injectable so tests drive both branches without a real ledger throw.
