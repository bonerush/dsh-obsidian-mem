# WORKFLOW.md — building `dsh-obsidian-mem`

> **Status:** canonical, reusable development workflow for this repository.
> It composes the Superpowers process skills with the ECC gated pipeline, and
> adds the one thing neither ships: the exact gates, records and model routing
> this plugin needs. Use it for any change that needs more than one commit or
> more than one agent. A one-file typo fix may skip to Phase 4.

This file is *how* work is done here. It is not the product documentation
(`README.md`), not the host facts (`docs/p0-compatibility.md`) and not a
substitute for a frozen spec (`docs/superpowers/specs/`). When they disagree,
the spec and the measured facts win; update this file rather than bending the
record.

---

## 0. Operating principles

1. **Evidence before design.** A claim is sourced, measured, read from the
   repository, or explicitly marked inference. "I think Mem0 works this way"
   is not evidence. A file:line is evidence for code; a URL and date is
   evidence for an external system; a command and its output is evidence for
   behaviour.
2. **Artifact-first.** Every phase leaves a file, not a chat message. A task
   brief is a file, a report is a file, a review package is a diff file. Chat
   is for coordination; files are the recovery map after compaction.
3. **Gates are binary.** A phase does not "mostly" pass. If a gate cannot be
   met, write the ruling and the cost, then decide. Silent skips are the
   failure mode this workflow exists to prevent.
4. **One writer per file set.** Parallel agents are cheap; conflicting writes
   are expensive. Every shared task declares `write_scopes`; two agents never
   own the same file.
5. **The vault is never scratch.** Tests, probes and experiments use
   `mktemp -d`. Do not point a test at `~/Documents/knowledge`, a real
   `$DSH_HOME/data/obsidian-mem/`, or any real vault.
6. **Never edit a user's configuration.** No row in a real
   `$DSH_HOME/cordis.patch.yml`, no "disable the other plugin" step, no
   `prepack` that writes.
7. **No agent trailers.** Commits carry no `Co-Authored-By` and no
   `Generated-by` line.
8. **Tests before claims.** New behaviour gets a test that fails before it and
   passes after; report both. If it was not run, write "not run".

---

## 1. Roles and model routing

| Role | Who | Default model | Owns | Never does |
|---|---|---|---|---|
| **Lead / controller** | the DSH session | session model | scope, rulings, ledger, task board, final answer | fixing code directly in the controller session |
| **Researcher** | teammate, fresh context | session model | one research file; web + local evidence | editing `lib/`, tests or the vault |
| **Codex analyst** | bundled Codex CLI | `gpt-6.1-sol`, `xhigh` | audits, spec/plan drafts, adversarial review, experiment design | committing, touching the real vault, editing a user config |
| **Implementer** | teammate, fresh or resumed | session model | one task's files, tests, commits | editing another task's files |
| **Task reviewer** | teammate, fresh context | session model | spec-compliance + quality verdict on one diff | fixing the code |
| **Final reviewer** | Codex or teammate | `gpt-6.1-sol` xhigh for risk | whole-branch review | merging or pushing |

### When to spend the strong model

Use Codex `gpt-6.1-sol` + `xhigh` for decisions that are expensive to
reverse:

- the architecture/dead-code audit before a large refactor;
- synthesis across multiple research files (not the first web search);
- the spec's design alternatives and the plan's task decomposition;
- adversarial review of a security-, data- or token-sensitive diff;
- experiment design where a wrong metric would mislead the whole project.

Do **not** use it for mechanical edits, renames, formatting, or a question the
repository already answers. A strong model reading 35k lines is not free; give
it a narrow question and a file list.

### Codex availability (measured 2026-10-26)

The `codex` on `PATH` was `0.146.0` and **refused** `gpt-6.1-sol` under the
ChatGPT account:

```
ERROR: The 'gpt-6.1-sol' model is not supported when using Codex with a
ChatGPT account. code=model_not_found
```

The CLI bundled with the desktop app supports it:

```
/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex
-> codex-cli 0.163.0-alpha.11
```

Use that binary when the request names 6.1 Sol. Before a long run, prove the
route with a one-line prompt; do not assume a future app update keeps the path.

```sh
CODEX_BIN="/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex"
"$CODEX_BIN" --version
```

---

## 2. The flow

```
Phase 0  Intake & recon                 Lead
   |
Phase 1  Research & reuse               researchers + Codex synthesis
   |      (evidence files, labels, dates)
Phase 2  Spec                           Codex draft -> Lead freezes
   |      GATE S: spec has problem, evidence, non-goals, acceptance
Phase 3  Plan                           Codex detailed plan -> Lead preflight
   |      GATE 1: plan approved + task briefs + ledger
Phase 4  Implement (TDD)                one implementer per task
   |      GATE T: task review clean (spec + quality)
Phase 5  Verify & review                gates + Codex/teammate final review
   |      GATE 4: all commands green + no open Critical/Important
Phase 6  Commit & push                  conventional commits, changelog, README pair
   |      GATE 2: diff summary + messages confirmed
Phase 7  Memory & retro                 mem_write + workflow update if needed
```

**Tiering.** Use the ECC size classifier before Phase 1:

| Tier | Signals | Phases |
|---|---|---|
| trivial | 1 file, obvious, no contract | 0 → 4 → 5 → 6 |
| small | 1 file / 1 function, clear once read | (1 light) → 4 → 5 → 6 |
| standard | 2–5 files, one real choice | 1 → 2 → 4 → 5 → 6 |
| large | many files, new contract/dependency, or a spec doc | 0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 |

Anything touching sessions, hooks, injection timing, `ctx.llm`, the
transaction engine or a public tool schema is **at least standard**, even if
the diff is small.

---

## 3. Phases

### Phase 0 — Intake and recon (Lead)

**Input:** the user's request, the current branch, `git status`, the vault
brief if this repository is bound.

**Do:**

1. Restate the request as an objective with a measurable end state.
2. Read `AGENTS.md`, `docs/p0-compatibility.md` (if the change touches the
   host seam), and the relevant module headers before proposing anything.
3. Measure the baseline: `npm test`, `npm run lint`, `npm run types`,
   `npm run pack:check` — or the narrow subset the change can affect. Record
   the commands and the result.
4. Classify the size (table above) and list the files that are likely to move.
5. Create the ledger and the shared tasks. Record the base commit
   (`git rev-parse HEAD`).

**Output:** a short intake note in the ledger + a task list.

**Exit:** the objective, the baseline and the affected surfaces are written
down. No code yet.

### Phase 1 — Research and reuse (ECC `research-ops`)

**Input:** the intake note.

**Do:**

- Search local code and docs first. The answer may already be in
  `docs/superpowers/specs/` or a module comment.
- For external work, run at most **two researchers in parallel**, each writing
  one file under `research/`. Require: URL + date for every external claim,
  a clear distinction between sourced fact / inference / recommendation, and
  at least one "what would falsify this" note.
- Ask Codex 6.1 xhigh to **synthesize after** the evidence files exist — not
  to invent the evidence. Give it the file paths and ask for a decision memo
  with a recommendation, tradeoffs and open questions.
- For a design question that can be measured (hot overflow, token counts,
  retrieval hit rate), write the experiment before the opinion. Use
  `mktemp -d`; never the real vault.

**Output:** `research/<topic>-YYYY-MM.md` (one per researcher), and a Codex
synthesis or experiment result.

**Exit:** every load-bearing claim in the spec has a source or a measurement.
If it does not, it is marked as an assumption and gets an experiment.

### Phase 2 — Spec (Superpowers `brainstorming` → `writing-plans` input)

**Input:** research files + the intake note.

**Do:**

1. If the request is still ambiguous, use `brainstorming`'s questions on the
   *user's* intent, not on implementation details. Ask only what changes the
   design; decide the rest and record the ruling.
2. Write the spec to
   `docs/superpowers/specs/YYYY-MM-DD-<slug>-design.md`. Required sections:
   - problem and evidence (with links to `research/`)
   - goals / non-goals
   - design (data model, files, APIs, migration, failure paths)
   - token/context budget (what is injected, when, how much, how measured)
   - compatibility and safety (DSH host facts, vault rules, privacy)
   - alternatives considered and why rejected
   - acceptance criteria (observable, testable)
   - risks and rollback
3. Codex 6.1 xhigh may draft or attack the spec. The Lead validates every
   claim against the repository and the research; Codex text is input, not
   authority.
4. Freeze the spec. `Status: frozen YYYY-MM-DD`; later changes are amendments
   with a reason, not silent edits.

**GATE S:** the spec has evidence, non-goals, acceptance criteria and a
token budget where relevant. Without it, do not plan.

### Phase 3 — Plan (Superpowers `writing-plans` + ECC plan gate)

**Input:** the frozen spec.

**Do:**

1. Write `docs/superpowers/plans/YYYY-MM-DD-<slug>-implementation.md` using
   the plan template in §8. It must start with the standard header, list the
   global constraints, and contain bite-sized tasks with **exact file paths,
   exact test commands, expected failures and expected passes**.
2. Ask Codex 6.1 xhigh to produce or review the task decomposition. Require:
   no placeholders; every task independently testable; every interface
   consumed/produced named; the refactor slices ordered by risk.
3. Lead preflight: for every pair of tasks that share a file or an interface,
   write one row (producer, consumer, verdict). Check every task against the
   spec. Fix gaps before dispatching.
4. Create the run workspace:
   `.superpowers/sdd/<plan-basename>/` with `progress.md`,
   `global-constraints.md`, and one `task-N-brief.md` per task.
5. Create shared tasks with `write_scopes`, `blocked_by` and acceptance
   criteria. One task owns one file set.

**GATE 1 (ECC):** the plan is approved, the preflight table is in the ledger,
and every task has a brief. Do not write implementation code before this.

### Phase 4 — Implement (Superpowers `subagent-driven-development`, ECC TDD)

**Input:** the plan + task briefs.

**Per task:**

1. Record `BASE=$(git rev-parse HEAD)`.
2. Dispatch one implementer with: the brief path, the report path, the
   interfaces from earlier tasks, and the ruling on any ambiguity. The brief
   is the single source of requirements; do not paste the whole plan.
3. Implementer follows red → green → refactor. It runs the covering tests,
   commits one logical change, and writes a report with
   `DONE` / `DONE_WITH_CONCERNS` / `NEEDS_CONTEXT` / `BLOCKED`, the
   commands it ran, and the outputs.
4. Generate a review package (`git diff -U10 BASE..HEAD` to a file) and
   dispatch a fresh task reviewer with the brief, the report and the package.
   The reviewer returns **spec compliance** and **quality** verdicts.
5. Fix loop: rounds 1–3 resume the implementer; rounds 4–5 use a fresh,
   stronger implementer. Every round ends with a scoped re-review. At round 5,
   adjudicate each open finding and record the ruling; never silently discard.
6. On clean review, append `Task N: complete (commits a..b, review clean)`
   to the ledger and mark the shared task complete.

**Parallelism:** one implementer per task; different tasks may run in parallel
only when their `write_scopes` are disjoint and no interface depends on an
unfinished task. Refactors that touch shared seams run sequentially.

**Hard stops:** an irreversible/destructive operation, a security-sensitive
action, a side effect outside the worktree (merge, push to a shared branch,
publish), or a plan so broken every path is a guess. Everything else is a
ruling, not a stall.

### Phase 5 — Verify and review (Superpowers `verification-before-completion` + ECC `code-review`)

**Do:**

1. Run the repository gates, not a proxy:
   ```sh
   npm run check          # lint, format, types, suite, pack contract, real archive
   git diff --check       # whitespace damage
   ```
   Record the commands and the tail of the output. If a gate is red, fix it
   before review; do not ask a reviewer to find what the gate already found.
2. For host-seam changes, re-read `docs/p0-compatibility.md` and put the
   measurement back there if it changed.
3. Independent review: a fresh DSH reviewer **and**, for a large or risky
   change, Codex 6.1 xhigh on the whole-branch diff. Give both the spec, the
   plan, the ledger's deferred/parked lines and the diff file. Ask for
   Critical / Important / Minor, with file:line and a concrete fix.
4. One fix wave for the final findings, then one scoped re-review. Residual
   load-bearing findings go to the user; do not hide them.

**GATE 4:** all gates green, no open Critical/Important, and the deferred
Minors are listed with a decision.

### Phase 6 — Commit and push (ECC GATE 2)

**Do:**

1. Review `git status` and the diff yourself. The Lead owns the final diff.
2. Conventional commits, one logical change each; the subject says what
   changed, the body says why and what it costs. No agent trailer.
3. Changelog: every Unreleased entry states what is verified and what is not.
   Move an item out of "untested" only with a command and its output.
4. README pair: edit `README.md` and `README.zh.md` together, then update
   the two blob hashes in `README.i18n.yaml` (`git hash-object`).
5. If a `lib/` module was added or removed, re-run the tarball measurement
   from `AGENTS.md`; do not adjust the count by hand.
6. Push the branch. Do not force-push a shared branch; do not merge without
   the user's explicit instruction.

**GATE 2:** present the diff summary and proposed messages; commit only after
the Lead's own review (and the user's confirmation when the user asked for
one).

### Phase 7 — Memory and retro

**Do:**

- `mem_write` the decisions, gotchas and conventions this run produced —
  only durable rules, not a diary. Supersede, never overwrite.
- If the workflow itself failed (a gate was skipped, a record was lost, a
  model route was wrong), edit this file and say what changed and why.
- Leave the run's spec, plan and validation record in `docs/` for the next
  maintainer; leave the transient briefs/reports/diffs in
  `.superpowers/sdd/<plan-basename>/` (git-ignored).

---

## 4. Codex 6.1 Sol xhigh — the contract

### What it is for

- **Read-only audit:** architecture, dead code, coupling, exact truncation
  paths, token accounting, refactor slices.
- **Synthesis:** turn `research/*.md` into a decision memo with a
  recommendation and rejected alternatives.
- **Spec/plan drafting:** the design alternatives and the task decomposition,
  after the evidence exists.
- **Adversarial review:** attack a diff, a budget, a privacy claim or a
  migration. Ask for falsification, not approval.
- **Experiment design:** define the metric, the fixture, the control and the
  acceptance threshold before anyone writes the feature.

### Command shape

```sh
CODEX_BIN="/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex"
# 1. Write the prompt to a file so shell quoting cannot mangle it.
# 2. Run read-only unless the task explicitly needs to write an artifact.
cat > /tmp/codex-prompt.md <<'EOF'
... the prompt ...
EOF

"$CODEX_BIN" exec \
  -m gpt-6.1-sol \
  -c 'model_reasoning_effort="xhigh"' \
  -s read-only \
  --color never \
  --ephemeral \
  --dangerously-bypass-hook-trust \
  --skip-git-repo-check \
  -o /tmp/codex-answer.md \
  - < /tmp/codex-prompt.md
```

Use `-s workspace-write` only when the task is "write this spec/plan to this
path". Use `-C <repo>` to pin the working root. A background job is the
default for a long audit; collect it with `job_output`.

### Prompt contract

Every Codex prompt must include:

1. the repository and the exact question;
2. the files it must read first (and the files it may ignore);
3. the output format, section by section;
4. the evidence rule: file:line or URL, and a confidence tag;
5. the boundary: read-only, no vault, no `~/.dsh`, no git mutation;
6. the deliverable path and the "final message is the artifact" instruction;
7. a word/size target and a "say not run" rule.

Do not ask Codex to "review everything". Narrow it. A good prompt is a
research brief, not a wish.

### Validation

The Lead reads the answer and checks every load-bearing claim against the
repository. Codex can be wrong about a line number, a config default or an
external product's current state. Record what was accepted and what was
rejected, with the reason. A Codex claim that cannot be checked is labeled
**unverified**, not repeated as fact.

### Time box and the fallback

Codex is an accelerator, not a blocking gate. Set a wall-clock cap before the
run and keep it:

- **Read-only audit:** 30-45 minutes. The 2026-10-26 architecture audit produced
  339 lines / 47 KB in about 40 minutes at `gpt-6.1-sol` xhigh; that is the
  observed upper end, not a target.
- **Spec or plan drafting:** 20-30 minutes. A 5,000-word spec run exceeded 30
  minutes and was killed; the Lead froze the spec from the completed research
  instead. That is the correct response, not a reason to wait.
- **Scoped review:** 10-20 minutes. Give it the diff file, the spec and the
  ledger's deferred lines; do not ask it to re-derive the repository.

If the cap is hit, kill the job, write `Ruling: Codex did not finish within the
cap; the Lead freezes the spec from evidence X and Codex reviews the diff` in
the ledger, and continue. A frozen spec with a Codex review is better than a
session parked on a slow generation. The Codex output is an input to the
record, never the record itself.

---

## 5. Agent-team contract

### Shared tasks

Every delegated work item is a shared task with:

- a subject and a complete description;
- `write_scopes` (workspace-relative files/directories);
- `blocked_by` when order matters;
- acceptance criteria and the artifact path.

The owner claims the task with the current revision before working, and
completes it only after the artifact exists and the tests pass. The Lead
re-lists after a wakeup; a teammate being `inactive` is not a result.

### Briefs and reports

- `task-N-brief.md` is the single source of requirements. It contains the
  exact files, interfaces, test commands and expected results. The implementer
  never receives the whole plan.
- `task-N-report.md` is the persistent memory of the task. It contains the
  status, commits, commands, outputs, concerns and the self-review.
- Reports and review packages are files, not chat dumps.

### Review package

```sh
git log --oneline BASE..HEAD  > review.txt
git diff --stat BASE..HEAD   >> review.txt
git diff -U10 BASE..HEAD     >> review.txt
```

Use the recorded `BASE`, never `HEAD~1` (a multi-commit task loses commits).

### The fix loop

Five rounds maximum. Rounds 1–3 resume the implementer; rounds 4–5 use a
fresh implementer on a stronger model. Each round appends a ledger line with
the addressed/open findings and the commit range. At the cap, adjudicate each
finding: fix, park with a ruling, or escalate. "Minor" findings are deferred
to the final review, never silently dropped.

### Ledger

`.superpowers/sdd/<plan-basename>/progress.md`:

```
# SDD ledger — plan: docs/superpowers/plans/<plan>.md
Base: <sha>
Task 1: complete (commits a1b2c3d..d4e5f6a, review clean)
Task 2: fix round 1/5 (2 addressed, 0 open; commits ...)
Ruling: <decision> — <why> — <what it costs if wrong>
```

After compaction, trust the ledger and `git log` over recollection. The ledger
is the recovery map; a workspace without it is a session that will re-dispatch
completed work.

---

## 6. Repository gates and non-negotiables

| Gate | Command | Proves |
|---|---|---|
| Fast staged gate | `npm run check:fast` | eslint + prettier on staged blobs, fitness tests, Unreleased gate |
| Full gate | `npm run check` | lint, format, types, full suite, pack contract, real archive |
| Tests | `npm test` | isolated suite under a throwaway `DSH_HOME` |
| Types ratchet | `npm run types` | only the files listed in `tsconfig.json` and marked `// @ts-check` |
| Pack | `npm run pack:check` | real tarball content against `files`/manifest |
| Whitespace | `git diff --check` | no whitespace damage |
| Workflow | this file | phases, records and rulings were followed |

**Non-negotiables** (from `AGENTS.md`, repeated because agents forget):

- Never edit a user's configuration; `prepack` verifies, does not build.
- No `Co-Authored-By`; no agent attribution.
- The vault is not scratch; data root derives from `DSH_HOME` in one place.
- `engines.node >=22.22.2` is a measurement, not an estimate.
- A claim needs evidence; "not run" is written as "not run".
- README pair moves together; update `README.i18n.yaml` hashes.
- New runtime dependency needs a reason in the PR text (two today:
  `schemastery`, `yaml`).
- The architecture test's `LAYERS` and `BUDGETS` are reviewed decisions, not
  auto-derived numbers. A new module or a larger file edits them together and
  says why in the commit.

### Refactor-specific rules

- A behaviour-preserving refactor starts and ends with the full suite green.
- Move first, rename second, change behaviour third — never in one commit.
- Keep a façade (e.g. `lib/tools.js`) when an external import path or a public
  tool surface depends on it.
- Every split updates `test/architecture.test.js` (layer table, module list,
  budgets) and runs the suite. A stale layer table fails the gate by design.
- Dead-code removal is evidence-based: an export is dead only when no
  non-test import, package export, bin entry or documented public API reaches
  it. Codex's inventory is a candidate list; the Lead verifies each one.
- No drive-by rewrites of a file a task does not own.

---

## 7. Artifact layout

```
WORKFLOW.md                                  this file (tracked)
AGENTS.md                                    house rules (tracked, local-only by ignore)
docs/p0-compatibility.md                     measured host facts
docs/<topic>-validation.md                   measured acceptance records
docs/superpowers/specs/YYYY-MM-DD-<slug>-design.md
docs/superpowers/plans/YYYY-MM-DD-<slug>-implementation.md
research/<topic>-YYYY-MM.md                  evidence files (local, git-ignored)
.superpowers/sdd/<plan-basename>/            transient run workspace (git-ignored)
  progress.md
  global-constraints.md
  task-N-brief.md
  task-N-report.md
  review-<base>..<head>.diff
```

`docs/` and `research/` are git-ignored by `.gitignore` for local maintenance
material. Important frozen records are force-added deliberately (the existing
`docs/superpowers` files are precedent); a transient brief or an experiment
output is not.

---

## 8. Templates

### 8.1 Spec header

```md
# <Feature> design

**Status:** frozen YYYY-MM-DD
**Owner:** <name>
**Amends:** <previous spec, if any>
**Evidence:** research/<file>, docs/<validation>, issue/<link>

## Problem and evidence
## Goals / non-goals
## Design
### Data model and files
### Read, write and failure paths
### Token / context budget
### Compatibility and safety
## Alternatives considered
## Acceptance criteria
## Risks and rollback
```

### 8.2 Plan header and task

```md
# <Feature> implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (- [ ]) syntax for tracking.

**Goal:** ...
**Architecture:** ...
**Tech Stack:** ...
**Spec:** docs/superpowers/specs/<spec>.md

## Global Constraints
- <exact values, version floors, naming, budgets>

---

### Task N: <Component>

**Files:**
- Create: `lib/<file>.js`
- Modify: `lib/<existing>.js:120-160`
- Test: `test/<file>.test.js`

**Interfaces:**
- Consumes: `function(args) -> {shape}`
- Produces: `function(args) -> {shape}`

- [ ] **Step 1: Write the failing test**
```js
test('...', async () => { ... })
```
- [ ] **Step 2: Run it and see it fail** — `node --test test/<file>.test.js`
- [ ] **Step 3: Implement the minimal change** — `lib/<file>.js`
- [ ] **Step 4: Run the covering tests and see them pass**
- [ ] **Step 5: Commit** — `git add ... && git commit -m "feat: ..."`
```

### 8.3 Task brief

```md
# Task N — <title>

**Plan:** docs/superpowers/plans/<plan>.md (Task N)
**Goal:** one sentence.
**Files:** exact paths.
**Interfaces:** consumes / produces, exact names.
**Constraints:** the plan's global constraints that bind this task.
**Steps:** the plan's steps, copied verbatim.
**Verification:** exact commands and expected output.
**Report:** write task-N-report.md with status, commits, commands, outputs.
```

### 8.4 Task report

```md
# Task N report

**Status:** DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED
**Commits:** <range>
**What changed:** files and one-line rationale.
**Tests run:** command + output tail (pass/fail).
**Concerns:** correctness, scope, or follow-up.
**Self-review:** what I checked and what I did not.
```

### 8.5 Codex prompt

```md
You are Codex (gpt-6.1-sol, xhigh) doing <audit | synthesis | plan | review>
for /Users/yukisala/subject/dsh-obsidian-mem.

READ FIRST: <files>.
QUESTION: <one narrow question>.
EVIDENCE: file:line for code; URL + date for external claims; mark inference;
say "not run" for anything you did not execute.
OUTPUT: <section list>, <word target>.
BOUNDARY: read-only; no vault; no ~/.dsh; no git mutation; /tmp only.
FINAL MESSAGE IS THE ARTIFACT.
```

### 8.6 Review prompt

```md
You are a task/whole-branch reviewer. Read:
- spec: <path>
- plan: <path>
- brief/report: <paths>
- diff: <review package path>
- ledger deferred/parked: <path>
Return:
1. Spec compliance: PASS/FAIL, each requirement with file:line.
2. Quality: APPROVED / CHANGES, Critical / Important / Minor, each with a
   concrete fix.
3. New breakage in the fix diff only.
Do not fix the code. Do not pre-judge findings. "Cannot verify from diff" is
allowed; name what is missing.
```

### 8.7 Ledger

```md
# SDD ledger — plan: docs/superpowers/plans/<plan>.md
Base: <sha>
Preflight: <table rows or "clean">
Task 1: complete (commits <a7>..<b7>, review clean)
Task 2: fix round 1/5 (<x> addressed, <y> open; commits <a7>..<b7>)
Ruling: <decision> — <why> — <what it costs if wrong>
```

---

## 9. Failure modes and countermeasures

| Failure | Symptom | Countermeasure |
|---|---|---|
| Research without evidence | a confident paragraph with no URL/file:line | reject at GATE S; ask for the source or mark assumption |
| Codex route wrong | `model_not_found` or an old CLI | use the bundled 0.163+ binary; smoke-test before a long run |
| Stale plan | an implementer builds against an amended spec | freeze the spec; amendments get a new revision and a ledger line |
| Overlapping writes | two agents edit one module, one diff disappears | `write_scopes` + one implementer per task; re-list after wakeup |
| Refactor without a net | suite was red before the move | baseline green; full suite at start and end; move-only commits |
| Hot overflow regression | brief truncates items with no manifest | acceptance metric: 100% of hot IDs visible or addressable; test at 6k/9k/20k |
| Test home pollution | a test writes into `~/.dsh` | `mktemp -d`, explicit `dataRoot`/`DSH_HOME`; never a real vault |
| Docs drift | README pair diverges; changelog claims unrun tests | README pair in one commit; "not run" is a valid entry; i18n hashes |
| Context loss | controller re-dispatches completed tasks | ledger + git log are the recovery map; read them first |
| Gate skipped under time pressure | "ship it, review later" | the gate is the product; write the ruling and the cost, or stop |

---

## 10. This run — 2026-10 memory v3

- Research: `research/memory-landscape-2026-10.md`,
  `research/dsh-plugin-ui-survey-2026-10.md`
- Audit: `research/codex-architecture-audit-2026-10.md`
- Spec: `docs/superpowers/specs/2026-10-26-memory-v3-design.md`
- Plan: `docs/superpowers/plans/2026-10-26-memory-v3-implementation.md`
- Ledger: `.superpowers/sdd/2026-10-26-memory-v3-implementation/progress.md`

The run is the worked example: research files first, a Codex 6.1 xhigh audit,
then a Lead-frozen spec and three plans, disjoint implementers, task reviews, a
full gate and a push. The Codex spec run exceeded its 30-minute cap and was
killed; §4 records that fallback. The coverage task reverted a red first pass and
the Lead finished it from the saved patches: a green tree, a precise report and a
saved patch are cheaper than a red commit.

---

## 11. Copy-paste checklist

**Before research**
- [ ] `git status` clean or the local edits are explained
- [ ] baseline commands run and recorded
- [ ] ledger created; base commit recorded
- [ ] size tier named

**Before spec**
- [ ] every external claim has a URL + date
- [ ] every code claim has file:line
- [ ] the experiment (if any) used `mktemp -d`
- [ ] non-goals written

**Before plan**
- [ ] spec frozen with acceptance criteria
- [ ] task files/interfaces/test commands exact
- [ ] preflight table for shared files/interfaces
- [ ] shared tasks have `write_scopes`

**Before commit**
- [ ] `npm run check` green (or the narrow gate for the tier)
- [ ] `git diff --check` clean
- [ ] task reviews clean; final review clean
- [ ] changelog honest; README pair + hashes
- [ ] no agent trailer; no user config edit; no vault scratch
- [ ] pack check if `files`/manifest/module count changed

**Before push**
- [ ] branch is the intended one; no force-push
- [ ] commit messages are conventional and scoped
- [ ] remote is correct; push reported
