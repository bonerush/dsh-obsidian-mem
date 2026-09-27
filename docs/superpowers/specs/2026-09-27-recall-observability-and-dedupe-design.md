# Recall observability, the floored gate, and distillation dedupe

Three defects found by testing the plugin against its own history rather than
against its fixtures. Each one is fixed at its root, and each fix carries the
measurement that chose it.

## Defect 1 — retrieval was invisible

`mem_admin(action="diagnostics")` could not answer "did recall fire?" because the
only related event was `brief`, recorded whenever the *brief* is injected,
whatever the map did. Measured live in a bound session: three events, one of them
`brief injected`, and nothing about retrieval; the answer existed only in the
session transcript.

`promptRecall` now returns a **decision** — `{outcome, text, paths, hits, chars}`
— instead of `null`, with a closed vocabulary (`RECALL_OUTCOMES`: `fired`,
`no-query`, `no-hits`, `below-floor`, `all-seen`, `budget`, `aborted`).
`lib/hooks.js` records one `recall` diagnostic per user turn, and
`lib/debug.js` gains the event name plus two integer fields, `hits` and
`chars`. Both adapters test `text !== null`; the Codex state file still stores
paths only, and the content-free allowlist still refuses a prompt or a path.

## Defect 2 — the gate punished verbosity

The floor was `max(3, ceil(0.3 × queryTokens))` with the query capped at 16
tokens, so a long prompt demanded five token hits. Most bigrams of a long Chinese
prompt are function words that cannot match a note, so the bar rose exactly where
the evidence was thinnest.

Measured through the shipped policy over the same 154 real prompts, by setting the
cap back to the old value and replaying the identical harness:

| floor | prompts that produce a map | notes/map | code points/map |
|---|---|---|---|
| `max(3, ceil(0.3 × qt))` (old) | **34 / 154 = 22.1%** | 1.7 | 484 |
| capped at 4 (new) | **87 / 154 = 56.5%** | 1.9 | 595 |

The additions were read before the change was kept — the whole list, not a sample.
Most pair a note with a prompt that is on topic for it: `README edits are paired
EN/ZH` for code-review turns, `CodeGraph MCP is the preferred lookup` for
search-and-retrieval work, and for 「请修复这个三个问题并且提交，随后 push 到 main」
the vault's own 「修复流程：改完提交并 push 到 main，以 CI 绿 + 全量 check」. A minority
are topical neighbours rather than answers. That minority is why the cap is four.

**Rejected on measurement**, not on taste:

* *Dominance rule* — accept when the top hit has four token hits and twice the
  runner-up. Adds exactly one prompt over the current gate, and that one is a
  false positive.
* *Ratio 0.15* — 77.9% of prompts, with a visibly weaker tail.
* *Relaxing `useful()` itself* — unchanged. The floor moved; the requirement for
  a direct textual match or a token overlap did not.

## Defect 3 — distillation duplicated the vault

A distilled pitfall was written beside the agent-written pitfall for the same
fact, and a distilled ADR beside the ADR it restated. Measured on this
repository's own vault: **42 same-type pairs** are near duplicates.

`lib/search.js` gains `findTitleTwin(index, {title, type})` and `titleOverlap`,
`lib/memory.js`'s `applyCandidate` consults an optional `findDuplicate` seam and
skips the create when it answers, and `lib/capture.js` builds that seam from the
index handle it already holds.

Three decisions worth naming:

* **Overlap coefficient, not Jaccard.** A distilled title is a reworded
  *superset*; dividing by the smaller token set asks "does an existing note
  already cover this?". Jaccard punishes the length difference — the pair scores
  0.80 under overlap and 0.60 under Jaccard, below the threshold.
* **Threshold 0.8, at the top of the measured gap** (unrelated same-type titles
  sit below 0.5). The errors are not symmetric: a missed twin leaves a duplicate,
  a false twin silently discards a distilled fact.
* **Skip, never supersede.** Replacing an existing note with a model-written
  restatement risks losing detail; the vault's convention reserves supersede for
  a *changed* conclusion. The check is skipped when the candidate carries an
  explicit supersede, whose target is by definition the note being replaced.

The check **fails open**. A wiring whose index handle only refreshes, or a lookup
that throws, applies the candidate exactly as before and records
`duplicate-check-failed`; an auxiliary rule must never refuse a write.

## Verification

Red first, for every piece: the decision object (`MAX_SNIPPET_CHARS`-style
missing export and four failed assertions), the `recall` event (no such category,
so no event was recorded), the gate (`below-floor` where `fired` was required),
the skip (`applyCandidate` wrote a second note) and the wiring (`2 !== 1` notes).

Two deliberate regressions were run and reverted:

* commenting out `findDuplicate: duplicateLookup(context)` fails the end-to-end
  duplicate case and nothing else;
* setting `MAX_FLOOR` back to the old value reproduces 22.1% exactly, which is
  what makes the 56.5% a like-for-like number rather than two measurements of
  different harnesses.

`npm run check` green: lint, format, types, 661 tests, verify-pack, and a real
tarball.

## Constraints

* No user DSH or Codex configuration is edited, and `prepack` stays a read-only
  verifier.
* `lib/tools.js` and the six tool contracts are untouched; the MCP surface for
  Codex is unchanged.
* The diagnostics ring stays content-free: the new event carries a decision and
  two counts, and the sentinel test still passes.
* Two size budgets were raised rather than waived —
  `lib/prompt-recall.js` 150 → 220 and `lib/search.js` 200 → 250 — each with the
  reason recorded beside it in `test/architecture.test.js`.
* `README.md` and `README.zh.md` were not touched: no configuration key or
  documented behaviour changed, so `README.i18n.yaml` still records the current
  pair.
