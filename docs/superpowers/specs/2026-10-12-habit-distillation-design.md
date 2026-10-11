# Habits inside distillation and curation

Direction requested by the user on 2026-10-12: abandon the independent habit
construction and generate habits naturally when memory is distilled and curated.
This replaces the unpublished 2026-10-11 vocabulary/counter/decay design. Historical
measurements and the old frozen spec remain records of that earlier approach.

## Contract

- Markdown remains authoritative. Habit notes use existing conventions, assertions,
  statuses, tags, the transaction writer and review operations.
- Ordinary turn distillation uses its existing one no-tool LLM request. Bounded
  existing project habits supply matching context, not fresh evidence.
- An explicit standing preference cites a real user event and uses `stated`.
  A proposed preference uses `observed` and `provisional`, with one exact contiguous
  source quote of 6–400 characters. There is no vocabulary or recurrence gate.
- Software features, project requirements, one-off requests, imported instruction
  blocks and agent tool choices are not personal preferences. The semantic judgment
  belongs to the model; exact evidence and quarantine are enforced in code.
- Curation re-distills at most twelve active/accepted stated conventions examined
  by its existing bounded scan. Input excerpts are bounded to 1200 code points each
  and to the existing total input budget. Habit notes are excluded as fresh evidence.
- Curation uses the existing pending queue, output barriers, idempotency receipts,
  retry limits and processed ranges. Jobs identify their exact source hashes; the
  writer checks them under the existing vault transaction lock. Changed sources
  cancel unfinished work while preserving already recorded completed items.
- Memory-derived candidates always remain observed/provisional. A matching hint
  cannot supersede or confirm an existing rule. Changed evidence follows duplicate
  review; `_meta/user.md` is never automatically edited.
- Existing curation and review govern retirement. No separate session counter,
  private habit state, half-life or automatic age-based archive remains.

## Adapters and limits

`distill.learnHabits` defaults to true. Turning it off disables observed induction
in new model outputs, while explicit declarations still follow normal distillation.
DSH supplies the background worker; curation can inherit a captured route only from
its own project, or use the configured distillation route. No route means deferred.
Codex has no completed-turn boundary or background distiller; its portable skill
uses the same memory methodology through explicit tools.

Model accuracy is not guaranteed. Project scope, twelve-note limits and exact quote
requirements limit coverage. Cross-project induction, production longevity and a
new semantic retirement policy have not been measured. A standalone classifier's
small calibration is not acceptance of the production prompt or a population
accuracy estimate. Native and deterministic evidence belong in the validation
record, not in this specification.
