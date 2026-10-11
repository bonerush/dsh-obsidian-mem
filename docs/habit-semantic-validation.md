# Integrated habit distillation validation — 2026-10-12

This validates the replacement of the unpublished independent habit learner.
`docs/habit-learning-results.md` and `docs/habit-extraction-validation.md` remain
historical records; their measurements are not acceptance of this implementation.

## Semantic calibration

A scratch-only real-model classifier used 24 reviewer-labelled cases (8 positives,
16 negatives), selected from earlier user-message excerpts plus synthetic controls.
Several excerpts were already clipped to 160 characters. These same inputs were
used while adjusting the prompt: the labels and sample are not an independent test
set. Two final runs detected 7/8 and 5/8 positives, each with 0/16 negative detections
and no unsupported evidence quotes. This demonstrates variance and a useful
project-requirement control, not a production accuracy estimate. The production
pipeline uses its own combined distillation prompt.

No model outputs or real conversation excerpts are committed. Temporary outputs
remain outside the repository. Credentials are read only for an environment route,
never printed or written into a probe configuration.

## Deterministic seams

`node --test test/habit-semantic.test.js test/capture.test.js`

Result: 48 tests passed, 0 failed. New coverage includes:

- exact user quotes, unsupported/assistant/injected evidence refusal;
- bounded memory context in one existing model call and durable-output resume;
- real vault matching without authority changes or a counter state;
- curation source selection, queue replay and processed-source deduplication;
- memory-derived authority-upgrade refusal and no self-reinforcement;
- changed sources before replay and under the actual transaction lock;
- partial completion followed by source change retains the earlier receipt item;
- imported instruction blocks labelled as user are excluded during capture.

The initial new test run failed with the missing module; curation tests also failed
before the queue signatures were corrected. The partial-completion regression first
failed when an advisory index failure was used as the crash seam; switching to the
next-item apply seam exercised the intended crash boundary. The final behaviour
passes through the real queue, writer and transaction lock, not mirrored helpers.

## Full repository gate

`npm run check` passed after the source-hash and partial-completion additions:
1059 tests, 1058 passed, 1 skipped, 0 failed (127328 ms). Lint, formatting and the
checkJs ratchet passed. `verify-pack` passed; `verify-tarball` read the real archive
and reported `69 entries, 59 lib modules, every required asset present`.
`git diff --check` passed.

Pack measurement: `npm pack --ignore-scripts --dry-run --json` reported 69 entries,
60 under `lib/`, including 59 JavaScript modules. Four removed habit modules are
replaced by four shared source/semantic/context/curation modules; no runtime
dependency was added.

## Native DSH and real model

The final probe passed. The executable entry is `test/p0/run-habit-probe.mjs`:

```sh
DSH_BIN='/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh' \
  node test/p0/run-habit-probe.mjs
```

The installed CLI reports DSH 0.2.0-rc.2; the orchestrating Node is v25.9.0. The
probe creates a temporary home, Git repository, vault and driver, seeds one stated
learning preference, and asks a synthetic software-requirement control. The probe
holds the host's awaited final flush for a bounded wait while memory curation settles before headless
teardown. It never calls a separate distiller or modifies real user configuration.
The final process exited 0 (3 stdout bytes, 0 stderr bytes), with 1 memory-curation
receipt and 1 observed/provisional habit note. No memory-curation job remained;
1 captured root turn remained pending and had not been distilled before headless
teardown. Real configuration fingerprints were unchanged. This is acceptance of
the memory-curation path; the final run does not claim native acceptance of the
pending software-requirement control. Earlier prototype runs did process that
control as an ordinary convention, but their stricter whole-queue/path assertions
failed, so those are exploratory observations rather than final gate passes.

The probe checks both Conventions and Inbox through committed receipt paths.
An earlier probe incorrectly counted only Conventions and missed a low-confidence
candidate in Inbox; that was a probe error, not an extraction failure.

A passing native run proves this isolated route and source-to-note path. It does
not prove population accuracy, cross-project inference, long-term retention, Codex
background automation or unchanged host behaviour in every version.
