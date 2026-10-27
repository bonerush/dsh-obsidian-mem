# Memory v0.4 remaining + panel redesign implementation plan

Base: `7295de1` (feat/memory-v3), gate at intake: 1,163 tests / 1,162 pass / 1 skip /
0 fail, pack 78 entries / 68 lib modules. Spec: `docs/superpowers/specs/2026-10-27-memory-v4-design.md`;
UI addendum: `docs/superpowers/specs/2026-10-27-memory-panel-redesign-design.md`.

## Global constraints

- No real vault, real home, real `$DSH_HOME`, user configuration or git remote edits.
- Every test uses `mktemp -d` / explicit temporary roots.
- TDD: covering test first; report red and green outputs.
- No agent commits. The Lead owns integration, the final gate and commits.
- One writer per file set. Do not edit another task's files; report a needed interface change instead.
- Keep the six tools, the Node floor, the two runtime dependencies and the read-only default.
- Update architecture layer/budget and the export-surface test only in the integration task.
- Markdown remains authoritative; private state is bounded and rebuildable.

## Tasks

### Task 1 — hot delivery receipts, continuation and convention rotation

Owner: `delivery-rotation`. Write scope: new `lib/hot-delivery.js`,
`lib/delivery-state.js`, `lib/convention-rotation.js`; `lib/brief.js`, `lib/hooks.js`,
`codex/session-start.mjs`, covering tests, and a report. Do not touch `lib/services.js`,
`lib/panel-route.js`, `lib/memory-panel.js`, `lib/client.js`, `lib/search.js`, or
`lib/tool-schema.js`.

Implement the design's §1–2 minimum complete slice: a receipt records the exact
hot ids/versions and convention units actually emitted; success advances only those
units; removals are acknowledged separately; an unchanged overflow is not re-sent
blindly; a changed source invalidates a cursor with `stale-continuation`; the
convention preview rotates across sessions and only advances after acknowledgement.
State is private, bounded, atomic and never in the vault. Codex stdout is pending
until a later trusted hook reconciles the exact marker/hash. Provide focused
tests for: first delivery, removal, changed version, unchanged overflow, cursor
stale/changed, rotation wrap, concurrent preparations, duplicate ack, corrupt state.

### Task 2 — panel preview/confirm operations

Owner: `panel-backend`. Write scope: `lib/panel-route.js`, new
`lib/panel-actions.js`, `lib/services.js` panel-action dispatch only,
`test/panel-route.test.js`, new panel-action tests. Do not touch `lib/client.js`
or `lib/memory-panel.js`.

Implement exactly three operations: `retry-job`, `compact-hot`, `refresh-digest`.
Every mutation needs a preview and a separate confirm. Preview tokens are
single-use, 60s TTL, bound to session/binding/operation/arguments/fingerprint,
bounded to 128 per process, and revalidated under the service's mutation lock;
stale previews return `409 preview-stale`; replay returns the prior result when
known. Require strict same-origin + loopback + JSON for mutations; reject a
missing Origin. Reuse `services.admin` ownership/path/transaction guards. The
route must expose a preview/confirm contract that the UI can render without
source text. Tests: preview does not write, confirm does, stale/replay/expired,
cross-session, cross-project, wrong origin, oversized body, unknown operation.

### Task 3 — deterministic sparse retrieval baseline

Owner: `retrieval`. Write scope: new `lib/retrieval-rank.js`,
`lib/retrieval-provider.js`, `lib/vector-index.js` if needed; `lib/search.js`,
`lib/config.js`, `lib/services.js` search wiring only, covering tests and report.
Do not touch `lib/panel-route.js`, `lib/client.js`, `lib/memory-panel.js`,
`lib/brief.js`, `lib/tool-schema.js`.

Add `retrievalEngine: lexical|sparse` default lexical, no network/model/dependency.
Sparse is a deterministic local TF-IDF/cosine rerank over source-verified note
chunks (or an equivalently bounded representation), fused with lexical ranks by
RRF k=60. Keep lexical default byte-identical when disabled. Add a provider
contract module for an explicitly configured loopback embedding service, disabled
by default, with validation and no egress; do not invent a provider or credentials.
Measure grouped Recall@3/MRR@3 on a small fixed fixture; report sparse vs lexical
and mark semantic unverified. Tests: default unchanged, deterministic order,
CJK/Latin terms, stale source fallback, provider-off zero egress.

### Task 4 — panel UI redesign

Owner: `panel-ui`. Write scope: `lib/client.js`, `lib/memory-panel.js`,
`test/panel-client.test.js`, `test/panel-assets.test.js`, new DOM/UI tests.
Do not touch route/service/schema files.

Direction: **vault ledger / editorial field notebook**, not generic cards.
Use DSH tokens only (the CSS test forbids hex/rgb/hsl). Warm paper-like layered
surface, serif display for project/view headings, compact sans body, hairline
rules, tabular numerals, a single business accent plus semantic state colors.
Structure the panel as: masthead (project, binding, freshness) → index tabs with
ordinal numerals → ledger body. Overview = large KPI numerals, composition as
index bars, numbered recent entries, health strip. Search = border-bottom search,
underlined filter groups, numbered result rows, readable snippets. Health =
status stamps, thin meters, digest as a newspaper column. Add a confirm sheet for
the three Task 2 operations (preview → confirm, focus trap, Escape, cancel).
Motion: one staggered view entrance, 120–180ms, disabled by reduced motion.
A11y: tablist and keyboard retained, 40–44px hit areas, visible focus,
aria-live status, no horizontal overflow at 320/375/768.

Keep the existing DOM classes where tests depend on them, but replace the visual
system and structure where it improves hierarchy. Keep the graph tab and its
renderer untouched except the shell chrome. The UI must work read-only when the
mutation API is absent (feature-detect and hide confirm actions).

### Task 5 — integration, docs and gate

Owner: Lead. Wire the new modules through `lib/index.js`, `lib/tools.js`,
`lib/tool-schema.js` if the model-visible surface changes, architecture budgets,
README pair/i18n hashes, changelog, skill copies and pack count. Run
`npm run check`, `git diff --check`, independent review, then commit/push.

## Acceptance

- All task tests red before the fix and green after; full gate green.
- No automatic write, config edit or real-vault access.
- Receipts/rotation are conservative on missing evidence and never claim delivery.
- Panel mutations cannot be replayed or preview-crossed; UI confirms once.
- Lexical default unchanged; sparse measurable and deterministic.
- UI passes 320/375/768 DOM/geometry checks and the existing accessibility cases.
