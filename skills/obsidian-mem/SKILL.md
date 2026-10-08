---
name: obsidian-mem
description: "Project memory as plain Markdown in a dedicated Obsidian vault. Use it whenever the working directory has a `.obsidian-mem` pointer, when the user asks to recall or save project knowledge (决策 / 踩坑 / 约定 / 文档 / 术语表), or when you are about to repeat a mistake the project already recorded. Covers the four-field binding, type routing, the six mem_* tools, the evidence/supersede/contested lifecycle, the document-authority path, and the safety rules that must never be broken."
---

# Obsidian project memory

This vault is the long-term memory for a project: plain Markdown files in a
directory the user opened as an Obsidian vault. Nothing here depends on a
particular harness — if your environment has no `mem_*` tools, do the same work
with ordinary file edits, following exactly the protocol below.

Read this skill before writing anything into the vault, and again before you
claim a fact is "remembered".

## 1. The binding: `.obsidian-mem`

The repository root contains a small JSON file named `.obsidian-mem`. It is
committed to the repository and carries **exactly four fields**:

```json
{
  "projectId": "1c392abb-7b08-42f7-871d-2a379caf9448",
  "slug": "dsh-obsidian-mem",
  "displayName": "dsh Obsidian memory",
  "schema": 1
}
```

- `projectId` — a UUIDv4 and the **identity**. It never changes when the
  repository, the display name or the directory name changes.
- `slug` — the name used to build the project directory on first binding. It is
  a label, not an identity.
- `displayName` — human-readable name for the project hub.
- `schema` — the protocol version. **An unknown schema means stop writing**: an
  older skill must not write into a newer vault.

Rules:

- The binding lives **only** at the repository root. Find the root first (the
  directory holding `.git`, or a worktree's `.git` file), then read the pointer
  there. A pointer deeper in the tree is not a binding.
- Different worktrees of the same repository share one `projectId`; they resolve
  to the same vault directory. Never mint a second id for a worktree.
- Never edit the pointer to change identity, and never invent a `projectId`.
  Creating a pointer for a repository that has none is a user decision, not a
  side effect of reading memory.
- The vault directory for a project is `Projects/<slug>--<projectId first 8 hex>/`.
  It is fixed at first binding; renaming a repository or a `displayName` never
  moves it, and a directory that has been renamed by hand is reported, not
  repaired.
- A vault path is machine-local. Never write the vault path or a remote URL into
  the pointer.

If the working directory has no pointer, you have no project memory: say so.
Cross-project knowledge (`Methods/`, `_meta/user.md`) is still readable.

## 2. Vault layout

```
<vault>/
├── _meta/
│   ├── user.md             # user-maintained global preferences — READ ONLY
│   ├── registry.md         # index of every project hub (plugin-managed region)
│   ├── log.md              # append-only write receipts
│   └── .history/           # pre-write snapshots; never indexed, never cited
├── Methods/<slug>.md       # cross-project methods (promotion target)
└── Projects/<slug>--<id8>/
    ├── index.md            # project hub / MOC — the recall entry point
    ├── Docs/               # project documents + glossary.md
    ├── Decisions/          # ADR-style decisions
    ├── Conventions/        # one convention per file
    ├── Pitfalls/           # gotchas: symptom / root cause / fix / evidence
    ├── Daily/YYYY-MM-DD.md # append-only session log (cold layer)
    ├── Inbox/              # unclassified or low-confidence candidates
    └── _meta/hot.md        # hot memory, ≤9000 chars, three controlled zones
```

**Every directory name is ASCII, and so is every file name the plugin fixes
itself** — `index.md`, `glossary.md`, `registry.md`, `hot.md`, `hot-archive.md`,
`Lint Report <date>.md`, `YYYY-MM-DD.md`. That is what keeps a vault readable
from a shell, an archive, a URL or a tool that is unhappy with CJK paths.

A **note's own file name is the writer's choice**: it is derived from the title,
so it is normally in the language the writer used. `Decisions/ADR-4-发布到 GitHub`
is a correct path. The name is a rendering — frontmatter `id` is the identity, so
renaming a note never creates a new fact.

Directory depth stays ≤3 levels: **topic relatedness is expressed by
`[[wikilinks]]` and `tags`, never by inventing a deeper directory tree.**

`_meta/hot.md` is the only file injected at session start. It has three
controlled zones — 强约束 / 进行中 / 已完成 — and holds only what is needed on
*every* turn: active work, hard constraints, recently corrected conventions.
Everything else belongs in the warm layer (the rest of the vault, read on
demand) or the cold layer (daily logs, searched but never injected).

## 3. Type routing — where a note goes

Pick `type` first; it decides the destination. This is the whole routing table:

| type | Destination | Notes |
|---|---|---|
| `doc` | `Docs/<title>.md` (+ `Docs/index.md`) | designs, reports, guides, plans |
| `decision` | `Decisions/ADR-<n>-<slug>.md` | Context / Decision / Alternatives / Consequences; `status: proposed \| accepted \| superseded` |
| `gotcha` | `Pitfalls/<slug>.md` | symptom / root cause / fix / evidence — the highest-value, smallest notes |
| `convention` (input alias `invariant`) | `Conventions/<slug>.md` (+ registry in `Conventions/index.md`) | **one fact per file**, so each can be given evidence, expired or superseded independently |
| `session-log` | `Daily/YYYY-MM-DD.md` | append-only, one section per session, idempotent per session id |
| `hub` | `Projects/<dir>/index.md` | MOC, the injection entry point |
| `glossary` | `Docs/glossary.md` | domain vocabulary |
| unclassified / low confidence | `Inbox/<slug>.md` | awaiting human classification |
| cross-project method | `Methods/<slug>.md` | only via an explicit `promote` action |
| user / environment | `_meta/user.md` | **user-maintained; never written by the agent** |

Never put a long convention into `hot.md` just because it grew: a convention
that needs evidence, expiry or a successor must be its own file in `Conventions/`,
with at most a short pointer in the hot layer.

## 4. Note frontmatter (closed vocabulary)

```yaml
---
id: "dec-5d46ff43-1bf8-496d-8b9f-c11e89d4e2aa"  # stable identity; rename keeps it
type: "decision"                  # doc|decision|gotcha|convention|session-log|hub|glossary|method|hot
title: "Scheduler becomes a pluggable backend"
status: "accepted"                # active|proposed|accepted|superseded|deprecated|provisional|contested|archived
created: 2026-09-23
updated: 2026-09-23
tags: ["dsh-mem/decision", "project/xeros"]
project: "1c392abb-7b08-42f7-871d-2a379caf9448"  # the projectId, never the slug
source: "chat"                    # human|chat|git|agent — the evidence channel
session: "20260923-155100-a1b2"   # nullable
harness: "dsh"
trust: "agent"                    # owner|agent|external — who controls the file
confidence: 0.9                   # 0..1, nullable
assertion: "stated"               # stated|inferred|observed, nullable
supersedes: "dec-09a26ee7-…"      # stable id of the note this one replaces
superseded_by: null
review_after: 2027-03-23          # nullable
---
```

This list is **closed**. Do not invent property names: Obsidian registers a
property's type across the whole vault, so one badly typed new name pollutes
every note. If another tool's note has extra properties, leave them exactly as
they are.

- `id` is the identity: `"<3-letter type prefix>-<UUIDv4>"` (`doc`, `dec`,
  `got`, `con`, `log`, `hub`, `glo`, `met`). Titles and dates are **not**
  identity: the same title on the same day can be two different facts, and
  renaming a note must not create a new one.
- `trust` records control, not authorship: `owner` = the human owns the file,
  `agent` = the plugin/agent owns it, `external` = another tool owns it.
  `source: human` does **not** make a file human-owned.
- `assertion` says how strong the claim is: `stated` (the user said it),
  `inferred` (the model concluded it), `observed` (there is re-checkable tool
  evidence). A model calling itself "verified" is not evidence.
- Dates are `YYYY-MM-DD` (or `YYYY-MM-DD HH:mm:ss`); never `toISOString()`.
  Never use file timestamps to invent a date, and never rewrite a file just to
  refresh `updated`.

### 4.1 The language a note is measured against

There is no `lang` field: the title is the language. Write the **body in the
title's language**, and keep tool, file, package and command names in their
original spelling (`FTS5`, `node:sqlite`, `[[path|label]]`, `dsh-obsidian-mem`
are not translatable). Do not translate an imported note's title and leave its
body in the original language: search matches the words a note is written in, so
a body in another language is not found by the title a reader will recall it by.

**A note is read alone, out of order, possibly years later.** Write each title
and body to stand on its own:

- **One fact per note.** A body needing more than five sentences is several
  facts sharing one file — each of which should carry its own evidence, its own
  expiry and its own successor. (ASD-STE100 Rule 6.6 allows six in a descriptive
  paragraph; a memory note gets five, because nothing follows it that could
  supply the missing context.)
- **Never refer to something outside the note.** `该` / `此` / `上述` / `前者` and
  "the above" have no referent at read time. Name the object instead. Measured:
  26% of the notes in this vault do this, which is why the rule is worth stating
  even though it reads as obvious.
- **No open-ended qualifier.** `可能` / `也许` / `应该` / `建议` / `尽量`, and
  `should` / `probably` / `roughly`, record a doubt whose ground was never
  written down: a later reader can neither obey nor contradict the note. State
  the bound you actually know (`约 15s`, `≤9000 字符`, `最多 21 条`) — a number is
  not a hedge. `应` in a quoted GB/T clause is a normative verb, not a hedge;
  `应该` is.
- **Keep a sentence under 60 characters** (25 words in English). The threshold is
  calibrated on this vault's own 739 fact notes, not translated from STE: 40
  characters would flag 27% of the existing corpus and 60 flags 4%, and the
  50–60 band holds legitimate sentences that carry their reason inside them.

Two rules that look like they belong here and deliberately do not:

- **Tense is not restricted.** `已` / `将` is correct in an ADR, which records
  what was decided at a point in time, and wrong in a convention, which is
  timeless. One rule cannot cover both, so the split is by `type`, not by
  vocabulary.
- **Mixing Chinese with Latin identifiers is not a defect.** 37% of the notes
  here interleave them and are right to. What is worth avoiding is two full
  clauses in two languages inside one sentence.

`lib/note-style.js` measures these, `lib/distill.js` applies them to each
distilled candidate, and `mem_admin(action="lint")` reports them across the vault
as `style-<rule>` findings. A lint pass never rewrites a note. All four rules
above are advisory — "would read better" must never move a fact out of the
directory it was routed to. Only a body whose language is not its title's sends a
distilled candidate to `Inbox/` instead of its destination; a lint report shows
that case as `style-language` at `error` severity.

### 4.2 Repeated failure and recovery

After three hard failures, search existing project gotchas before retrying the
same approach. Use the tool name and a closed error category or ordinary error
code; never copy private output, commands, paths or credentials into a query.
Two soft error-text matches inside one step may suggest the same lookup, but
cannot justify a failure note or verify recovery.

Record the symptom, attempted remedy, successful check and evidence separately.
A successful retry proves the outcome, not its cause: keep an inferred diagnosis
as `assertion: inferred`, `status: provisional`, and never automatically supersede
an existing note. Unresolved or unsupported candidates belong in `Inbox/`.
Search before recording; a twin waits for review rather than overwriting a note.
Native DSH captures qualifying hard runs through its existing queue. The Codex
MCP adapter does not observe those native events; use `mem_search` and `mem_write`
explicitly when this workflow applies and the session authorizes memory writes.

## 5. Evidence, supersede, contested

**Evidence before assertion.** Every note that states a fact should be able to
say where it came from: `source`, `session`, and for `observed` the concrete
command or file the claim rests on. A candidate that cannot point at evidence
goes to `Inbox/` with low `confidence` — or is not written at all.

**Supersede, never overwrite.** When a conclusion changes, write a *new* note:

1. The new note carries `supersedes: "<old id>"` and links to the old note.
2. The old note is marked `status: superseded` and `superseded_by: "<new id>"`,
   and the two notes get bidirectional `[[wikilinks]]` in their bodies.
3. **The old note is never deleted or edited into something else.** Identity is
   the `id`; the path is only navigation.

**Contested instead of a winner.** If two facts genuinely conflict and you
cannot settle it from evidence, do not pick one. Mark both `status: contested`
and keep each side's evidence links, so the human can decide.

**Expiry.** A fact that may go stale gets `review_after: YYYY-MM-DD`; a lint
pass lists expired notes. Nothing expires silently.

**Receipts.** Every plugin write appends a receipt to `_meta/log.md`. A receipt
is how a retry tells "already written" from "not yet written"; when a tool
offers `idempotencyKey`, pass the same key on a retry and you will get the
original result instead of a duplicate note.

## 6. Document authority: where long documents live

- `mem_write(type=doc)` (or, without tools, a new file under `Docs/`) is the
  **authority** for project designs, reports, guides and plans. It returns the
  vault-relative path; an Obsidian link is only ever reported for a directory the
  user has actually registered as a vault, because a fabricated `obsidian://`
  URI would look clickable and do nothing.
- Files that make the code repository run or that collaborators need — the
  `README.md`, `AGENTS.md`, licence, build configuration, a `docs/` page that
  CI publishes — stay in the repository. They are **not** mirrored into the
  vault. If a topic needs both, write the long-form authority in the vault and
  leave a short summary/pointer in the repository.
- Mirroring the vault back into the repository (or the reverse) is never
  automatic. Neither side is "the copy".

## 7. The six tools

| Tool | Arguments | What it does |
|---|---|---|
| `mem_search` | `query` (required), `scope` (`project`\|`global`\|`all`, default `project`), `type`, `projectId`, `includeHistory` (default false), `limit` (default 8) | Searches the vault. `scope=project` only ever searches the bound project — passing another `projectId` is refused, never silently crossed. `global` covers `Methods/` and `_meta/user.md`. `all` crosses projects. Superseded/archived notes are excluded unless `includeHistory` is set. |
| `mem_read` | `path` (required, vault-relative), `section` (optional ATX heading) | Reads a retrievable `.md` note and returns body, frontmatter and content hash. Absolute paths, `..`, symlinks and internal paths (`_meta/.history/`, generated reports) are refused. |
| `mem_write` | `type`, `title`, `body` (all required), `tags`, `status`, `confidence`, `assertion`, `supersedes`, `id`, `idempotencyKey` | Creates a note at the routed destination and updates the MOC, receipts and index transactionally. **Without `id` it always creates a new note; to update, you must pass the existing `id`.** `supersedes` is validated against the old note's id. |
| `mem_log` | `text` (required), `session`, `section`, `idempotencyKey` | Appends one entry to today's log, idempotently per session. `section: hot` (or 强约束/进行中/已完成) updates that controlled hot zone instead; if it would exceed the hot capacity it archives first or refuses. |
| `mem_brief` | — | Returns the current hot brief — the same text injected at session start — so you can re-read or check the budget. |
| `mem_admin` | `action` (required: `lint`\|`index`\|`bind`\|`projects`\|`promote`\|`jobs`\|`curation`\|`diagnostics`), `path`, `rebuild`, `mode`, `jobId`, `retry`, `report`, `prune`, `operation` (curation: `status`\|`scan`) | Low-frequency maintenance. All eight actions are implemented. `lint` is read-only unless a report is explicitly requested (`report: true`); `index` rebuilds the search index; `bind mode=show` reports the binding without writing; `projects` lists registered projects; `promote` copies a note into `Methods/` keeping its source link; `jobs` inspects and explicitly retries failed background jobs; `curation` reads or runs one bounded curation pass (see below) and never applies a proposal; `diagnostics` returns this process's own content-free decision ring. |

Working rules:

- An action that cannot answer yet says so instead of faking a result: `mem_brief`
  returns `status: 'unbound'` for a repository with no binding, and an index-backed
  search raises `index-not-ready` until the first scan finishes. Read those as
  "there is nothing to report from here", never as "there is nothing to remember";
  do not substitute a hand edit for a maintenance action.
- **Prefer `mem_search` → `mem_read` over guessing.** The vault is the source of
  truth for project decisions, conventions and gotchas; the conversation is not.
- When a plugin tool refuses a write (human-owned file, no ownership record, a
  file changed since the last plugin write), do **not** work around it with a
  direct file edit or a shell command. Write the finding to `Inbox/` instead and
  tell the user which file refused and why.
- Without `mem_*` tools, perform the equivalent edit by hand: pick the routed
  path, write the full frontmatter from §4, update the directory `index.md` if
  one exists, and append a receipt line to `_meta/log.md`.

### Automatic curation, and what a proposal is

With `autoCurate: true` (the default) the plugin also runs bounded curation
passes and keeps a rebuildable navigation view of the project. What that means
for you:

- **A curation proposal is not a fact, and it is not an outcome.** A suspected
  near duplicate, a same-title claim with a different number or date, or a
  supersede a model proposed is *parked* under the plugin's own data root
  (outside the vault) and changes nothing. Never tell the user such a change
  happened, and never write it yourself to "finish the job".
- **There is no model-callable approval.** No `mem_admin` action, parameter or
  value applies or rejects a proposal, and you cannot approve one on the user's
  behalf. The only route is the interactive command shipped with the package:
  `dsh-obsidian-mem-review --vault <absolute-path> <proposal-id>`, which needs a
  real terminal and a byte-for-byte typed `apply <id>` or `reject <id>`. Point
  the user at it; do not simulate it by editing the source notes.
- `mem_admin(action="curation", operation="status")` lists the queue and reads
  the private cursor and the committed view without inspecting anything;
  `operation="scan"` runs one bounded pass now and reports `complete` and any
  truncation reason. `autoCurate: false` disables only the automatic passes —
  both operations still work.
- **The queue is selectable, and `reviewOnly` is the signal.** `status` and
  `scan` return `proposals.items`: up to 200 pending rows, newest first, each with
  exactly `proposalId`, `kind`, `reason` and `reviewOnly`. Hand the user the
  `proposalId` of the row they want. A `reviewOnly: true` row is a finding with no
  operation — `apply` cannot repair it, so the fix is the source edit the finding
  names followed by another `operation="scan"`. `proposals.truncated: true` means
  more pending rows exist than were returned; the user decides the listed ones and
  asks again. It says nothing about source notes having disappeared.
- **A refusal is an answer to report, not a failure to retry blindly.**
  `source-changed` leaves the proposal `pending` for another review; a healthy
  competing review is answered `proposal-not-current`, while
  `review-lock-unavailable` means the claim guard could not be taken at all
  (another review inside its short critical section, or unusable guard storage);
  and `review-recovery-required` means an earlier attempt was interrupted after
  publishing a note, so the user approves with `apply` — which rolls that attempt
  back if it never committed and forward if it did, then publishes the candidate.
  That one is never a rejection, and never something you resolve by editing notes.
- **A curation pass reads Markdown and makes no model call**, and it never merges,
  archives, supersedes, promotes or deletes a note. An exact-duplicate group is one
  displayed entry naming every path; no note is removed.
- **The claim file beside the records is not scratch.** A running review holds a
  private claim file so two reviewers cannot both decide one proposal, and
  `proposals/` is durable review work no scan can recreate. Never delete either,
  and never present deleting them as routine recovery.
- **The compact navigation in the brief is a cache.** Every line it adds was
  re-hashed against its source before injection, and any changed, missing or
  unreadable source makes the brief fall back to reading the vault. A fallback
  is not a memory outage: use `mem_search` → `mem_read`, as always.

## 8. Safety: hard prohibitions

These are not preferences. A violation can destroy the user's personal notes.

1. **Never write `_meta/user.md`.** The user maintains it; it is read-only for
   you, including automatic extraction.
2. **Never modify a note whose `trust: owner`.** A file declaring `trust: owner`
   is human-owned. Do not rewrite it, reformat it, "fix" its frontmatter, or
   append to it — not even a courtesy link. Create a separate note in the
   relevant directory (or `Inbox/`) and link to it from there.
3. **Never delete anything** — no notes, no directories, no vault files. The
   only sanctioned transitions are marking `status: superseded`, `archived` or
   `contested`.
4. **Never move or rename a user directory.** `Projects/<slug>--<id8>/` and its
   `displayName` are fixed at first binding; a rename is reported, never
   "repaired" by moving files.
5. **Never modify a file the plugin did not write.** Ownership needs a record:
   `trust: agent`, `harness: dsh`, a valid note id, or a manifest/hash matching
   the plugin's last write for that exact path. Everything else is foreign —
   report the conflict and stop.
6. **Never edit generated blocks into disagreement.** Auto-managed regions
   (registry table, MOC regions, lint reports) are bounded by
   `<!-- obsidian-mem:… begin sha256:<hash> -->` markers. Only rewrite a block
   whose declared hash still matches its body; if a human edited inside it, stop
   and report.
7. **Never write outside the vault.** No absolute paths, no `..`, no symlinks,
   no writes into the repository's own files as an "improvement". The plugin's
   own caches live under the harness home directory, not in the vault.
8. **Never touch the user's other memory systems** — do not enable, disable or
   reconfigure another memory plugin, and do not copy this vault into one.

When any of these blocks a write you believe is valuable, say so plainly and
leave the candidate in `Inbox/` with its evidence. Silence is the failure mode.
