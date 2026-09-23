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
- The vault directory for a project is `项目/<slug>--<projectId first 8 hex>/`.
  It is fixed at first binding; renaming a repository or a `displayName` never
  moves it, and a directory that has been renamed by hand is reported, not
  repaired.
- A vault path is machine-local. Never write the vault path or a remote URL into
  the pointer.

If the working directory has no pointer, you have no project memory: say so.
Cross-project knowledge (`方法/`, `_meta/user.md`) is still readable.

## 2. Vault layout

```
<vault>/
├── _meta/
│   ├── user.md            # user-maintained global preferences — READ ONLY
│   ├── 项目注册表.md       # index of every project hub (plugin-managed region)
│   ├── log.md             # append-only write receipts
│   └── .history/          # pre-write snapshots; never indexed, never cited
├── 方法/<slug>.md          # cross-project methods (promotion target)
└── 项目/<slug>--<id8>/
    ├── index.md           # project hub / MOC — the recall entry point
    ├── 约定/              # one convention per file
    ├── _meta/hot.md       # hot memory, ≤9000 chars, three controlled zones
    ├── 文档/              # project documents + 术语表.md
    ├── 决策/              # ADR-style decisions
    ├── 踩坑/              # gotchas: symptom / root cause / fix / evidence
    ├── 日志/YYYY-MM-DD.md # append-only session log (cold layer)
    └── 收件箱/            # unclassified or low-confidence candidates
```

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
| `doc` | `文档/<title>.md` (+ `文档/index.md`) | designs, reports, guides, plans |
| `decision` | `决策/ADR-<n>-<slug>.md` | Context / Decision / Alternatives / Consequences; `status: proposed \| accepted \| superseded` |
| `gotcha` | `踩坑/<slug>.md` | symptom / root cause / fix / evidence — the highest-value, smallest notes |
| `convention` (input alias `invariant`) | `约定/<slug>.md` (+ registry in `约定/index.md`) | **one fact per file**, so each can be given evidence, expired or superseded independently |
| `session-log` | `日志/YYYY-MM-DD.md` | append-only, one section per session, idempotent per session id |
| `hub` | `项目/<dir>/index.md` | MOC, the injection entry point |
| `glossary` | `文档/术语表.md` | domain vocabulary |
| unclassified / low confidence | `收件箱/<slug>.md` | awaiting human classification |
| cross-project method | `方法/<slug>.md` | only via an explicit `promote` action |
| user / environment | `_meta/user.md` | **user-maintained; never written by the agent** |

Never put a long convention into `hot.md` just because it grew: a convention
that needs evidence, expiry or a successor must be its own file in `约定/`,
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

## 5. Evidence, supersede, contested

**Evidence before assertion.** Every note that states a fact should be able to
say where it came from: `source`, `session`, and for `observed` the concrete
command or file the claim rests on. A candidate that cannot point at evidence
goes to `收件箱/` with low `confidence` — or is not written at all.

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

- `mem_write(type=doc)` (or, without tools, a new file under `文档/`) is the
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
| `mem_search` | `query` (required), `scope` (`project`\|`global`\|`all`, default `project`), `type`, `projectId`, `includeHistory` (default false), `limit` (default 8) | Searches the vault. `scope=project` only ever searches the bound project — passing another `projectId` is refused, never silently crossed. `global` covers `方法/` and `_meta/user.md`. `all` crosses projects. Superseded/archived notes are excluded unless `includeHistory` is set. |
| `mem_read` | `path` (required, vault-relative), `section` (optional ATX heading) | Reads a retrievable `.md` note and returns body, frontmatter and content hash. Absolute paths, `..`, symlinks and internal paths (`_meta/.history/`, generated reports) are refused. |
| `mem_write` | `type`, `title`, `body` (all required), `tags`, `status`, `confidence`, `assertion`, `supersedes`, `id`, `idempotencyKey` | Creates a note at the routed destination and updates the MOC, receipts and index transactionally. **Without `id` it always creates a new note; to update, you must pass the existing `id`.** `supersedes` is validated against the old note's id. |
| `mem_log` | `text` (required), `session`, `section`, `idempotencyKey` | Appends one entry to today's log, idempotently per session. `section: hot` (or 强约束/进行中/已完成) updates that controlled hot zone instead; if it would exceed the hot capacity it archives first or refuses. |
| `mem_brief` | — | Returns the current hot brief — the same text injected at session start — so you can re-read or check the budget. |
| `mem_admin` | `action` (required: `lint`\|`index`\|`bind`\|`projects`\|`promote`\|`jobs`), `path`, `rebuild`, `mode`, `jobId`, `retry` | Low-frequency maintenance. `lint` is read-only unless a report is explicitly requested; `index` rebuilds the search index; `bind mode=show` reports the binding without writing; `projects` lists registered projects; `promote` copies a note into `方法/` keeping its source link; `jobs` inspects and explicitly retries failed background jobs. |

Working rules:

- A maintenance action that this build has not implemented answers with an
  explicit `not-ready-in-p1` status instead of a faked result. Read that as "not
  implemented here", never as "nothing to do"; do not substitute a hand edit for
  a missing maintenance action.
- **Prefer `mem_search` → `mem_read` over guessing.** The vault is the source of
  truth for project decisions, conventions and gotchas; the conversation is not.
- When a plugin tool refuses a write (human-owned file, no ownership record, a
  file changed since the last plugin write), do **not** work around it with a
  direct file edit or a shell command. Write the finding to `收件箱/` instead and
  tell the user which file refused and why.
- Without `mem_*` tools, perform the equivalent edit by hand: pick the routed
  path, write the full frontmatter from §4, update the directory `index.md` if
  one exists, and append a receipt line to `_meta/log.md`.

## 8. Safety: hard prohibitions

These are not preferences. A violation can destroy the user's personal notes.

1. **Never write `_meta/user.md`.** The user maintains it; it is read-only for
   you, including automatic extraction.
2. **Never modify a note whose `trust: owner`.** A file declaring `trust: owner`
   is human-owned. Do not rewrite it, reformat it, "fix" its frontmatter, or
   append to it — not even a courtesy link. Create a separate note in the
   relevant directory (or `收件箱/`) and link to it from there.
3. **Never delete anything** — no notes, no directories, no vault files. The
   only sanctioned transitions are marking `status: superseded`, `archived` or
   `contested`.
4. **Never move or rename a user directory.** `项目/<slug>--<id8>/` and its
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
leave the candidate in `收件箱/` with its evidence. Silence is the failure mode.
