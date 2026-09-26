# Recall delivery: an excerpt, and a ceiling of its own

This supersedes two decisions of `2026-09-26-prompt-recall-design.md` — "includes
only paths and short titles" and "spends only the remaining `briefBudgetChars`"
— and leaves the rest of that design standing. It exists because that spec's own
*Verification* section says that "any claim of end-to-end model use needs a
separate real Codex and DSH session measurement; unit tests alone do not
establish it", and that measurement had not been taken.

## What was measured

Two corpora, both read-only:

* Every DSH session under `$DSH_HOME/sessions` — 277 sessions, 31,718 tool
  dispatches, counted from `tool/ptc-dispatch` and `tool/call` records rather
  than from substrings, which tool-list repetition in request headers inflates
  by orders of magnitude.
* The 154 real user prompts of the two bound repositories, replayed through the
  shipped policy and the shipped index against a `mktemp -d` copy of the vault.

Four facts came out, and each one names a change:

1. **The map almost never fired — and never on turn 1.** `maxChars` was
   `briefBudgetChars − spent − hintSpent`, so the first user turn of every
   session received whatever the one-shot brief left behind. The measured brief
   is 5,896 of 6,000 code points, leaving 104: a ceiling that fits neither the
   header nor one entry. Replay: **0.6% fired on turn 1, 22.1% on later turns.**
2. **A pointer is not memory.** `mem_read` was dispatched **18 times across 277
   sessions and 31,718 tool calls**. A pointer map is only useful if the model
   then chooses to spend a second call on it, and it does not.
3. **The excerpt already existed.** `lib/index-db.js` computes `snippet` with
   `buildSnippet(record, [needle, ...tokens])` — a ±60-code-point window centred
   on the phrase that matched — and the policy discarded it.
4. **The hot layer is already resident.** The brief injects `_meta/hot.md` every
   session, so offering that note back spends the turn's ceiling on text the
   model already has.

## The policy now

`lib/prompt-recall.js` keeps its trigger, its source filter, its scope rules and
its `useful()` precision gate. Three things change:

* `maxChars` defaults to `MAX_CHARS = 900` and the DSH adapter passes
  `config.recallBudgetChars` — a ceiling for retrieval alone, not a remainder.
  A step therefore carries at most `briefBudgetChars + recallBudgetChars`
  instead of at most `briefBudgetChars`; that is the deliberate trade, and it is
  why the README documents both keys.
* Each accepted hit contributes its path, its title, and the index's excerpt —
  whitespace-collapsed to one line and clamped to `MAX_SNIPPET_CHARS = 200`.
  The header still frames everything as quoted vault data and still names
  `mem_read` for full text.
* `_meta/hot.md` joins `index.md` as a path the policy will not offer.

Unchanged on purpose: `useful()` still demands a title/phrase match or
`≥ max(3, ⌈0.3 × queryTokens⌉)` token hits. 22.1% is a firing rate measured with
that gate in place; relaxing it would widen recall without evidence that the
extra hits are wanted, and a single distractor measurably degrades reading.

## Privacy and storage

The excerpt reaches the model in the injected message and nowhere else. Neither
adapter persists it: DSH keeps shown **paths** in session state, and the Codex
`UserPromptSubmit` state file still stores `{"paths": [...]}` — its test keeps
the `doesNotMatch` assertion that pins note text out of that file. No prompt is
retained by either adapter, and no vault path is written into a pointer.

## Verification

Red first: `test/prompt-recall.test.js` failed on the absent
`MAX_SNIPPET_CHARS` export, and `test/hooks.test.js` failed the new
"a full-size brief does not starve the per-turn recall on the first turn" case,
which drives the real waterfall with a `BUDGET − 100` brief — the production
shape the old unit fixtures missed by using a four-character brief.

Green after: 652 tests.

Two of them are end to end rather than fixture-level, because the original
starvation was invisible to fixtures that used a four-character brief:

* `test/hooks.test.js` drives the real waterfall over a `mktemp -d` vault with
  the shipped `buildBrief`, the shipped `openIndex` and the shipped
  `services.search`, at the production ratio (`briefBudgetChars: 400`), and
  asserts the first turn receives the map **with** its excerpt.
* `test/codex-hooks.test.js` drives the real hook script as a subprocess and
  asserts the excerpt reaches `additionalContext` while the saved state file
  still never contains note text.

**The regression was run deliberately.** Putting the one changed line back to
`briefBudgetChars - spent` fails both DSH cases and nothing else; leaving it in
place keeps all 652 green. That is what separates "the fixture passes" from "the
mechanism is tested".

## Constraints

* No user DSH or Codex configuration is edited by anything here, and `prepack`
  stays a read-only verifier.
* `lib/tools.js` and the six tool contracts are untouched; the MCP surface for
  Codex is unchanged.
* The DSH producer-owned source kind `plugin:obsidian-mem` is preserved, and the
  message stays a `user`-role message.
* `README.md` and `README.zh.md` moved together; `README.i18n.yaml` was
  re-registered from `git hash-object`.
