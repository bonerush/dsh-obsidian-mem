---
name: obsidian-mem
description: "Project memory as plain Markdown in a dedicated Obsidian vault, run from Codex CLI. Use it whenever the working directory has a `.obsidian-mem` pointer, when the user asks to recall or save project knowledge (决策 / 踩坑 / 约定 / 文档 / 术语表), or when you are about to repeat a mistake the project already recorded. Covers the four-field binding, type routing, the six `mem_*` tools when the companion MCP server is registered with `codex mcp`, the evidence/supersede/contested lifecycle, and the `rg` + edit fallback that does the same work when those tools are absent."
---

# Obsidian project memory

A project's long-term memory is plain Markdown in a directory the user opened as an Obsidian vault. The protocol below is harness-independent. Read this skill before writing into the vault, and again before you claim a fact is "remembered".

## 1. What Codex changes

- **The six `mem_*` tools are optional.** They exist only when the companion MCP server for this vault is installed and registered — installing the Codex plugin adds both that server and this skill — and then they are the same six names with the same meanings as under DSH (§8). If they are not in your tool list, §9 does the same work with `rg`, your file-read tool and edits.
- **Recall is automatic with the installed plugin.** `SessionStart` injects the project brief and `UserPromptSubmit` may offer a short map of relevant note titles and paths. Open the cited note with `mem_read` before relying on its contents. The hooks are absent in an MCP-only setup; then call `mem_brief` yourself or read `_meta/hot.md`. No finished turn is distilled automatically under Codex: call `mem_log`/`mem_write`, or edit Markdown, when something is worth keeping.
- **Nothing here touches DSH.** No DSH configuration is read or written, DSH need not be installed, and the vault depends on neither harness.

## 2. The binding: `.obsidian-mem`

The repository root's `.obsidian-mem` is committed and carries **exactly four fields**:

```json
{
  "projectId": "05025725-00be-4852-aba6-4854f961cd01",
  "slug": "dsh-obsidian-mem",
  "displayName": "dsh-obsidian-mem",
  "schema": 1
}
```

- `projectId` — a UUIDv4 and the **identity**: it never changes when the repository, the display name or the directory name changes. `slug` (used to build the project directory on first binding) is a label, not an identity.
- `displayName` — human-readable name for the project hub.
- `schema` — the protocol version. **An unknown schema means stop writing**: an older skill must not write into a newer vault.

Rules:

- The binding lives **only** at the repository root. Find the root first (the directory holding `.git`, or a worktree's `.git` file) and read the pointer there; a pointer deeper in the tree is not a binding.
- Worktrees of one repository share a `projectId` and a vault directory. Never mint a second id for a worktree, never edit the pointer to change identity, never invent a `projectId`, and never create a pointer: binding a repository is a user decision, not an effect of reading memory.
- The vault directory is `Projects/<slug>--<projectId first 8 hex>/`, fixed at first binding. Renaming a repository or a `displayName` never moves it; a directory renamed by hand is reported, not repaired.
- A vault path is machine-local. Never write the vault path or a remote URL into the pointer.

If the working directory has no pointer, you have no project memory: say so. Cross-project knowledge (`Methods/`, `_meta/user.md`) is still readable.

## 3. Vault layout

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
    ├── Docs/               # documents, glossary.md, hot-archive.md
    ├── Decisions/          # ADR-style decisions
    ├── Conventions/        # one convention per file
    ├── Pitfalls/           # gotchas: symptom / root cause / fix / evidence
    ├── Daily/YYYY-MM-DD.md # append-only session log (cold layer)
    ├── Inbox/              # unclassified or low-confidence candidates
    └── _meta/hot.md        # hot memory, ≤9000 chars, three controlled zones
```

**Every directory name is ASCII, and so is every file name the protocol fixes itself** — `index.md`, `glossary.md`, `registry.md`, `hot.md`, `hot-archive.md`, `YYYY-MM-DD.md`. That is what keeps a vault readable from a shell, an archive, a URL or a tool that is unhappy with CJK paths. A **note's own file name follows whatever language the writer used**, since it is derived from the title: `Decisions/ADR-4-发布到 GitHub.md` is a correct path. The name is a rendering — frontmatter `id` is the identity, so renaming a note never creates a new fact.

Directory depth stays ≤3 levels: **topic relatedness is expressed by `[[wikilinks]]` and `tags`, never by inventing a deeper tree.**

`_meta/hot.md` is the one file worth reading on *every* turn, so it holds only what every turn needs — active work, hard constraints, recently corrected conventions — under ≤9000 characters. Everything else belongs in the warm layer (the rest of the vault, read on demand) or the cold layer (day logs, searched, never read wholesale).

## 4. Type routing — where a note goes

Pick `type` first; it decides the destination. This is the whole routing table:

| type | Destination | Notes |
|---|---|---|
| `doc` | `Docs/<title>.md` (+ `Docs/index.md`) | designs, reports, guides, plans |
| `decision` | `Decisions/ADR-<n>-<slug>.md` | Context / Decision / Alternatives / Consequences; `status: proposed \| accepted \| superseded` |
| `gotcha` | `Pitfalls/<slug>.md` | symptom / root cause / fix / evidence — the highest-value, smallest notes |
| `convention` (alias `invariant`) | `Conventions/<slug>.md` (+ registry in `Conventions/index.md`) | **one fact per file**, so each can be given evidence, expired or superseded independently |
| `session-log` | `Daily/YYYY-MM-DD.md` | append-only, one section per session, idempotent per session id |
| `hub` | `Projects/<dir>/index.md` | MOC, the entry point |
| `glossary` | `Docs/glossary.md` | domain vocabulary |
| unclassified / low confidence | `Inbox/<slug>.md` | awaiting human classification |
| cross-project method | `Methods/<slug>.md` | only through an explicit promotion |
| user / environment | `_meta/user.md` | **user-maintained; never written by the agent** |

Never put a long convention into `hot.md` just because it grew: a convention that needs evidence, expiry or a successor must be its own file in `Conventions/`, with at most a short pointer in the hot layer.

## 5. Note frontmatter (closed vocabulary)

```yaml
---
id: "dec-5d46ff43-1bf8-496d-8b9f-c11e89d4e2aa"  # stable identity; rename keeps it
type: "decision"                  # doc|decision|gotcha|convention|session-log|hub|glossary|method|hot
title: "Scheduler becomes a pluggable backend"
status: "accepted"                # active|proposed|accepted|superseded|deprecated|provisional|contested|archived
created: 2026-09-23
updated: 2026-09-23
tags: ["dsh-mem/decision", "project/dsh-obsidian-mem"]
project: "05025725-00be-4852-aba6-4854f961cd01"  # the projectId, never the slug
source: "chat"                    # human|chat|git|agent — the evidence channel
session: "20260923-155100-a1b2"   # nullable
harness: "codex"                  # the harness that wrote the file
trust: "agent"                    # owner|agent|external — who controls the file
confidence: 0.9                   # 0..1, nullable
assertion: "stated"               # stated|inferred|observed, nullable
supersedes: "dec-09a26ee7-…"      # stable id of the note this one replaces
superseded_by: null
review_after: 2027-03-23          # nullable
---
```

This list is **closed**. Do not invent property names: Obsidian registers a property's type across the whole vault, so one badly typed new name pollutes every note. If another tool's note has extra properties, leave them exactly as they are. (That registry, `.obsidian/types.json`, is a GUI-side artifact you cannot read reliably from the filesystem — do not write it.)

- `id` is the identity: `"<3-letter type prefix>-<UUIDv4>"` (`doc`, `dec`, `got`, `con`, `log`, `hub`, `glo`, `met`). Titles and dates are **not** identity: the same title on the same day can be two different facts, and renaming a note must not create a new one.
- `trust` records control, not authorship: `owner` = the human owns the file, `agent` = the plugin/agent owns it, `external` = another tool owns it. `source: human` does **not** make a file human-owned.
- `assertion` says how strong the claim is: `stated` (the user said it), `inferred` (the model concluded it), `observed` (re-checkable tool evidence exists). A model calling itself "verified" is not evidence.
- Dates are `YYYY-MM-DD` (or `YYYY-MM-DD HH:mm:ss`); never `toISOString()`. Never use file timestamps to invent a date — a copied file carries an `mtime` unrelated to when the fact was true — and never rewrite a file just to refresh `updated`.

## 6. Evidence, supersede, contested

**Evidence before assertion.** Every note that states a fact should say where it came from: `source`, `session`, and for `observed` the concrete command or file the claim rests on. A candidate that cannot point at evidence goes to `Inbox/` with low `confidence` — or is not written at all.

**Supersede, never overwrite.** When a conclusion changes, write a *new* note:

1. The new note carries `supersedes: "<old id>"` and links to the old note.
2. The old note is marked `status: superseded` and `superseded_by: "<new id>"`, and the two notes get bidirectional `[[wikilinks]]` in their bodies.
3. **The old note is never deleted or edited into something else.** Identity is the `id`; the path is only navigation.

**Contested instead of a winner.** If two facts genuinely conflict and you cannot settle it from evidence, do not pick one. Mark both `status: contested` and keep each side's evidence links, so the human can decide.

**Expiry.** A fact that may go stale gets `review_after: YYYY-MM-DD`; a check lists expired notes. Nothing expires silently.

**Receipts.** A write appends a receipt to `_meta/log.md`. A receipt is how a retry tells "already written" from "not yet written"; when a tool offers `idempotencyKey`, pass the same key on a retry and you get the original result instead of a duplicate note.

## 7. Document authority: where long documents live

- A new file under `Docs/` (or `mem_write(type=doc)` when the server is present) is the **authority** for project designs, reports, guides and plans. Report an Obsidian link only for a directory the user has actually registered as a vault; a fabricated `obsidian://` URI looks clickable and does nothing.
- Files that make the repository run or that collaborators need — `README.md`, `AGENTS.md`, licence, build configuration, a CI-published `docs/` page — stay in the repository and are **not** mirrored into the vault. If a topic needs both, write the long-form authority in the vault and leave a short summary/pointer in the repository.
- Mirroring the vault back into the repository (or the reverse) is never automatic. Neither side is "the copy".

## 8. The six tools — only when the MCP server is registered

These keep their DSH names and meanings. Codex exposes an MCP server's tools as `mcp__<server>__<tool>`, so the bundled server registered as `obsidian-mem` gives you `mcp__obsidian-mem__mem_search` and the rest. **Your tool list is the authority**: if the six `mem_*` names are not in it, you do not have them, whatever `codex mcp list`, a plugin manifest or the user's description suggests. Then use §9 — that is the normal case, not a degraded one.

| Tool | Arguments | What it does |
|---|---|---|
| `mem_search` | `query` (required), `scope` (`project`\|`global`\|`all`, default `project`), `type`, `projectId`, `includeHistory` (default false), `limit` (default 8) | Searches the vault. `scope=project` only ever searches the bound project — passing another `projectId` is refused, never silently crossed. `global` covers `Methods/` and `_meta/user.md`. `all` crosses projects. Superseded/archived notes are excluded unless `includeHistory` is set. |
| `mem_read` | `path` (required, vault-relative), `section` (optional ATX heading) | Reads a retrievable `.md` note and returns body, frontmatter and content hash. Absolute paths, `..`, symlinks and internal paths (`_meta/.history/`, generated reports) are refused. |
| `mem_write` | `type`, `title`, `body` (all required), `tags`, `status`, `confidence`, `assertion`, `supersedes`, `id`, `idempotencyKey` | Creates a note at the routed destination and updates the MOC, receipts and index transactionally. **Without `id` it always creates a new note; to update, you must pass the existing `id`.** `supersedes` is validated against the old note's id. |
| `mem_log` | `text` (required), `session`, `section`, `idempotencyKey` | Appends one entry to today's log, idempotently per session. `section: hot` (or 强约束/进行中/已完成) updates that controlled hot zone instead; if it would exceed the hot capacity it archives first or refuses. |
| `mem_brief` | — | Returns the current hot brief — call it when you start work on a project, since nothing injects it for you — and use it to check the budget; an unbound directory answers `status: 'unbound'`. |
| `mem_admin` | `action` (required: `lint`\|`index`\|`bind`\|`projects`\|`promote`\|`jobs`), `path`, `rebuild`, `mode`, `jobId`, `retry`, `report`, `prune` | Low-frequency maintenance; all six actions are implemented. `lint` is read-only unless a report is explicitly requested (`report: true`); `index` rebuilds the search index; `bind mode=show` reports the binding without writing; `projects` lists registered projects; `promote` copies a note into `Methods/` keeping its source link; `jobs` inspects and explicitly retries failed background jobs. |

Working rules:

- An action that cannot answer yet says so instead of faking a result: `mem_brief` returns `status: 'unbound'` for a repository with no binding, and an index-backed search raises `index-not-ready` until the first scan finishes. Read those as "there is nothing to report from here", never as "there is nothing to remember".
- **Prefer `mem_search` → `mem_read` over guessing.** The vault is the source of truth for project decisions, conventions and gotchas; the conversation is not.
- When a tool refuses a write (human-owned file, no ownership record, a file changed since the last write), do **not** work around it with a direct file edit or a shell command. Write the finding to `Inbox/` and tell the user which file refused and why.
- The user decides whether this vault gets an MCP server. Never edit the user's Codex configuration to give yourself these tools.

## 9. The file-tool fallback

Every rule above still holds; only the mechanism changes. There is no index, no lock and no snapshot under Codex, so **append rather than rewrite** anything shared, and re-read a file immediately before you replace it.

### Locate the project

```sh
root=$(git rev-parse --show-toplevel)   # the pointer lives at the repository root
cat "$root/.obsidian-mem"               # four fields; read projectId out of it
ls -d "$vault"/Projects/*--"${projectId:0:8}"   # id8 identifies the project; the slug is a label
```

`$vault` is machine-local: `OBSIDIAN_MEM_VAULT` names it when it is set, and `~/Documents/dsh-memory` is the default rather than a rule. If the project directory is not there, ask the user — never guess a vault path, and never create one.

### Search, then read

```sh
rg -n --glob '!**/.history/**' -e '<query>' "$vault/Projects/<slug>--<id8>"
rg -n -e '<query>' "$vault/Methods" "$vault/_meta/user.md"   # cross-project scope
```

`rg` ships with Codex, so this is your index. Before relying on a hit, read its frontmatter: a note with `status: superseded` or `archived` is history, not current truth, and `_meta/.history/` is never cited.

### Write a note

1. Route it: `type` → directory (§4). A `decision` is `ADR-<n>-<slug>.md`, where `n` is the highest existing `ADR-` number **+ 1**; never reuse a number, never renumber an old note.
2. Mint the id: `<prefix>-<UUIDv4>`, lowercase — `uuidgen | tr 'A-Z' 'a-z'`.
3. Write the frontmatter from §5 and the body, with dates from the calendar (`date +%F`), never from the file.
4. Put `harness: "codex"`. That field names the writer, and only the writer's own harness may claim a file: a note written here carries no DSH ownership record, so the DSH-side plugin treats it as foreign and will not modify it — which is correct. Never claim `harness: "dsh"` for a file you wrote by hand.
5. **Create** the file; never overwrite one. A taken name is not the same fact — add a distinguishing suffix or re-title, and keep the old file.
6. If the destination has an `index.md`, add one entry line inside its `obsidian-mem:generated` region (below). If the region's declared hash does not match its body, a human edited it: leave it alone and say the MOC entry is missing.
7. Append a receipt to `_meta/log.md`: a `## <YYYY-MM-DD> — <action>` heading and the vault-relative path(s) you touched.

**Generated region rule.** A managed region is bounded by `<!-- obsidian-mem:generated begin sha256:<64 hex> -->` … `<!-- obsidian-mem:generated end -->`, and the hash covers exactly the bytes between those marker lines, excluding the newline that precedes the closing marker. Append the line (`- [[<path without .md>|<title>]]`), then write the sha256 of the new body back into the opening marker. **Only rewrite a region whose declared hash still matches its body** — that check is the only thing between a human's edit and silent reversion. Never hand-edit `_meta/registry.md` markers.

### Append to the day log

`Daily/YYYY-MM-DD.md` is created if missing (frontmatter type `session-log`) and otherwise only appended to, one block per session: a `## <session> · <section>` heading, the entry, and the marker `<!-- mem-log:<session>:<section> -->`. If the marker is already in the file the entry is already there — do nothing; that marker is the idempotence rule. Append into an existing `## ` section of the same name, otherwise at the end, and never reorder or reflow existing entries. Use the Codex session id as `<session>` if you know it, otherwise a label you will reuse for this session; it only has to be unique within the day.

### Supersede by hand

1. Write the new note with `supersedes: "<old id>"` and a link to the old note.
2. Touch the old note's frontmatter and its link line only: `status: superseded`, `superseded_by: "<new id>"`, and the reciprocal `[[link]]`.
3. Never delete, rename or repurpose the old note. Nothing snapshots it for you here, so the old bytes *are* the undo.
4. Two facts you cannot rank become `status: contested`, both kept with their evidence — no silent winner, no tie-break by recency.

### Hot memory by hand

Entry lines look like `- [hot-<UUIDv4>] <one line>`; the marker is what makes a line archivable and deduplicable. Before the file would pass 9000 characters, move *complete* 已完成 lines into `Docs/hot-archive.md` and leave a pointer behind (`- [hot-<id>] 已归档 → [[Docs/hot-archive|<archive title>]]`). A line without that marker was not written by this protocol: never move it, and never truncate an entry to fit — stop and report.

### What has no fallback

`lint`, `index`, `bind`, `projects`, `promote` and index-backed search exist only with the MCP server. You may inspect the vault by hand, but never present a hand inspection as a `mem_admin` result and never write a lint report or a `Methods/` promotion yourself.

## 10. Safety: hard prohibitions

These are not preferences. A violation can destroy the user's personal notes.

1. **Never write `_meta/user.md`.** The user maintains it; it is read-only for you, including automatic extraction.
2. **Never modify a note whose `trust: owner`.** That file is human-owned: do not rewrite it, reformat it, "fix" its frontmatter or append to it — not even a courtesy link. Create a separate note in the relevant directory (or `Inbox/`) and link from there.
3. **Never delete or move anything** — no notes, no directories, no vault files. The only sanctioned transitions are `status: superseded`, `archived` or `contested`; `Projects/<slug>--<id8>/` is fixed at first binding, and a rename is reported, never "repaired".
4. **Never modify a file this protocol did not write.** Ownership needs evidence: `trust: agent` with a `<known prefix>-<UUIDv4>` id and a path that fits §4. Everything else is foreign — report the conflict and stop.
5. **Never edit a generated block into disagreement.** Registry tables, MOC regions and reports are bounded by the `sha256` markers above; if a human edited inside one, stop and report instead of reverting it.
6. **Never write outside the vault.** No absolute paths, no `..`, no symlinks, no writes into the repository's own files as an "improvement", and no scratch files inside the vault — use the system temp directory. The vault must be on local disk: under `~/Library/Mobile Documents/` or `~/Library/CloudStorage/` a read can stall on an on-demand placeholder and a sync client can read one as a deletion, so refuse and tell the user.
7. **Never copy this vault into another memory system**, and never edit another tool's configuration to point it at the vault.

When any of these blocks a write you believe is valuable, say so plainly and leave the candidate in `Inbox/` with its evidence. Silence is the failure mode.
