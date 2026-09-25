# dsh-obsidian-mem

English | [中文](README.zh.md)

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Node >= 22.22.2](https://img.shields.io/badge/node-%3E%3D22.22.2-brightgreen.svg)](#requirements)
[![DSH plugin](https://img.shields.io/badge/DSH-plugin-blueviolet.svg)](https://github.com/topics/dsh-plugin)

A **DeepSeek Harness host plugin** that keeps a project's documents and long-term
memory as plain Markdown in a dedicated [Obsidian](https://obsidian.md) vault.

One repository gets one stable `projectId`, one committed pointer file and one
fixed directory in the vault. The plugin writes there; Obsidian just shows you
the result. Obsidian does not need to be running, and no part of the vault
depends on DSH.

```
repository                                vault (~/Documents/dsh-memory)
├── .obsidian-mem   ───────────►          └── Projects/<slug>--<projectId 前8位>/
│     projectId, slug,                    ├── index.md                hub / MOC
│     displayName, schema: 1              ├── Docs/  Decisions/  Conventions/  Pitfalls/
└── src/ …                                ├── Daily/YYYY-MM-DD.md
                                          ├── Inbox/                  待分类
                                          └── _meta/hot.md            热记忆
```

Two layers, on purpose:

- **Protocol** (vault layout, the `.obsidian-mem` pointer, note frontmatter, the
  distillation output contract) is plain Markdown and is not DSH-specific. The
  shipped skill `skills/obsidian-mem/SKILL.md` follows the Agent Skills format,
  so it works in another harness too — [`codex/`](./codex/README.md) installs that
  protocol *and* the same six operations into Codex CLI, through an MCP server that
  reuses `lib/` rather than copying it.
- **Adapter** is DSH-specific: six `mem_*` tools, one budgeted recall injection at
  the first step of a session, a `node:sqlite` search index kept outside the
  vault, and automatic distillation of completed turns.

> **Read [Honest limits](#honest-limits) before you enable automatic writes.**
> This plugin is careful about what it refuses, but it is young. What follows is
> what this release writes down, not a claim to be exhaustive; `CHANGELOG.md`
> keeps the running record of what has been verified and what has not.

---

## Requirements

| | Version | Why |
|---|---|---|
| Node | `>= 22.22.2` | The floor is a *measurement*. `node:sqlite` imports on Node 22.13.0, but that build has no FTS5; 22.22.2 and 25.9.0 do. Versions 22.14–22.21 were not tested, so the floor is the lowest version actually proven to work. |
| DSH | `0.1.5-rc.2`, `0.1.7-rc.2` | The two versions this plugin has been verified against; `docs/p0-compatibility.md` and `docs/smoke-results.md` record which measurement came from which. The plugin uses only row `config:` and documented Cordis seams, so other versions are likely fine — but "likely" is not "tested", so only measured versions are listed. |
| Obsidian | any recent version | Optional. Only needed to *read* the vault comfortably. |

Runtime dependencies are deliberately tiny: `@deepseek-ai/schemastery` for config
validation and `yaml` for frontmatter. `node:sqlite` is built into Node, so there
is no native module to compile.

The DSH floor is declared where the ecosystem declares it — `engines.dsh` in
`package.json`, with the same range in `dsh.plugin.json`. Measured: nothing in an
installed harness reads that key (a search for `engines.dsh` across every installed
`@deepseek-ai/*` package returns nothing), so it is a declaration for registry and
market tooling, not a gate DSH enforces.

---

## Install in five minutes

### 1. Choose a local vault directory

```sh
vault="$HOME/Documents/dsh-memory"     # any path on local disk; the default
mkdir -p "$vault"
```

Keep it on **local disk** — see [the vault must be local](#the-vault-must-be-local).
Do not point it at a personal vault you already maintain; this plugin writes
project directories into the vault root, and while it refuses to touch files it
does not own, a dedicated vault keeps the two from ever meeting.

### 2. Verify on a throwaway profile first

This is the exact sequence that was tested, and it needs no checkout — `github:` is
the ecosystem's shorthand for a GitHub repository:

```sh
# A clean DSH home for the trial run: nothing here touches your real ~/.dsh.
export DSH_HOME="$(mktemp -d)"

dsh plugin --profile memcheck add github:bonerush/dsh-obsidian-mem

dsh --profile memcheck --dump-config | grep -n obsidian-mem
#   # == dsh-obsidian-mem
#   - id: obsidian-mem
#     name: dsh-obsidian-mem

unset DSH_HOME
```

`dsh plugin --profile <name> add <spec>` creates the profile if it does not exist,
installs the package and layers its `cordis.patch.yml`, which is what mounts the
`obsidian-mem` row. If `--dump-config` shows no such row, stop here.

The output above is measured, not illustrative: against the published repository
the command resolves to `dsh-obsidian-mem github:bonerush/dsh-obsidian-mem` and
`--dump-config` prints the three lines shown.

Pin a revision when you want a fixed one: `github:bonerush/dsh-obsidian-mem#<commit>`.
The harness's own plugin search prints the same command shape and gives the same
advice — a third-party plugin is code you run, so review it and pin it.

### 3. Install into the profile you actually use

```sh
dsh plugin --profile web add github:bonerush/dsh-obsidian-mem
dsh --profile web --dump-config | grep -n obsidian-mem
```

Replace `web` with your profile name.

Working from a local checkout instead? Every `github:…` above becomes `"link:$PWD"`
run from the checkout: the package is linked rather than copied, so your edits are
live. That is how this repository is developed, and it is the form the smoke and
dogfood runs used.

### 4. Restart DSH and open a new session

Plugin code is loaded once per process: **restart `dsh web`** (or your harness)
and start a *new* session so the row is mounted and the pre-step injection has a
session to attach to. An existing session keeps the old plugin instance.

### 5. Open the vault in Obsidian

1. Obsidian → **Open folder as vault** → select the vault directory.
2. That is all. Nothing needs to be pre-created; the plugin bootstraps the project
   directory on first use — for a Git repository, the first `mem_write` or
   `mem_log` (see [Project bound](#verify-it-works)).
3. The plugin never writes `.obsidian/types.json`, never edits your existing
   notes, and never runs a Git command in the vault except `git init` on a
   directory it just created.

The first time the plugin touches an existing vault it runs a **property
preflight**: it reads candidate notes and refuses to bootstrap if a property name
it needs (`tags`, `created`, `status`, …) already holds an incompatible value
type. A refusal names the file and the property. Fix it in the vault, or point
`vaultPath` at an empty directory — the plugin will not "repair" your notes. The
preflight can only see value types visible in note bytes; see
[the property registry is not readable offline](#the-property-registry-is-not-readable-offline).

### Verify it works

Start a session in any Git repository and ask, or just check the tools are there:

| Check | How |
|---|---|
| Row mounted | `dsh --profile web --dump-config \| grep obsidian-mem` |
| Project bound | `mem_admin(action="projects")` reports the resolution. A Git repository with **no** `.obsidian-mem` is bound by its **first write**: `mem_write` or `mem_log` generates the slug, creates the pointer exclusively, bootstraps the skeleton and registers the project, then proceeds — and the binding is visible to the next call in the same session. An existing pointer is never overwritten or repaired, and a refusal (a corrupt or unknown-schema pointer, an unreadable sibling worktree, an unreadable registry, a cloud-managed vault) is reported with its reason instead of minting. Reads never bind: `mem_search` and `mem_read` stay read-only on a pointerless repository, and a directory that is **not** in Git stays read-only until `mem_admin(action="bind", mode="local")`. |
| Recall injected once | the first request of a session carries one `obsidian-mem` recall message (≤ `briefBudgetChars`) |
| CJK search works | write a note, then `mem_search` a two-character Chinese word |
| Vault files are real | `ls "$vault/Projects/"` — plain Markdown, readable with the plugin uninstalled |

---

## Configuration

Configuration lives in the plugin row, and a row's inline `config:` **replaces the
whole object** — DSH patch layers do not deep-merge. So an override must list
every field, `distill` included. Put it in the home-level patch layer,
`$DSH_HOME/cordis.patch.yml`, alongside whatever is already there:

```yaml
# $DSH_HOME/cordis.patch.yml
- id: obsidian-mem
  config:
    enabled: true
    vaultPath: "~/Documents/dsh-memory"
    initGitOnCreate: true
    injectBrief: true
    briefBudgetChars: 6000
    hotCapacityChars: 9000
    hotArchiveRatio: 0.67
    autoCapture: true
    captureIdleMs: 90000
    distill:
      provider: ""
      model: ""
      maxItems: 12
      minConfidence: 0.75
      maxInputChars: 24000
      maxOutputTokens: 4000
      timeoutMs: 60000
      maxRetries: 3
      dryRun: false
    indexBackend: auto
    ignoreGlobs: []
```

Omitting the `config:` block entirely gives you exactly those defaults.
`enabled: false` registers nothing at all — no tools, no hooks, no data root, no
lock.

**An unknown key is an error, not a no-op.** The table below is the complete field
set: a key it does not list (at the top level or inside `distill`) makes the row
fail to load and the error names the key. This matters because a typo would
otherwise keep the intended field's default — a row that says `vaultpath: "/tmp/x"`
would silently use `~/Documents/dsh-memory` and bootstrap it. The error also lists
the design document's deliberately-dropped fields (`projectsDir`, `methodsDir`,
`metaDir`, `reservedPrefixes`, `docMirror`, `distill.mode`,
`distill.maxCostPerSession`) so a config copied from there fails with an
explanation instead of doing nothing.

| Field | Default | Accepted | What it does |
|---|---|---|---|
| `enabled` | `true` | boolean | `false` mounts nothing. |
| `vaultPath` | `~/Documents/dsh-memory` | non-blank path; `~` is expanded | The vault root. Must be local disk. |
| `initGitOnCreate` | `true` | boolean | `git init` **only** on a vault directory this plugin just created, and only if `git` is available. Never commits, never sets a remote. |
| `injectBrief` | `true` | boolean | Whether the first step of a session gets the recall message. |
| `briefBudgetChars` | `6000` | integer 256–20000 | Hard ceiling for one injection, in Unicode code points. |
| `hotCapacityChars` | `9000` | integer 1024–50000 | Capacity of `_meta/hot.md`. Storage capacity, *not* injection budget. |
| `hotArchiveRatio` | `0.67` | open interval (0,1) | Above this fill level the plugin archives 已完成 entries before writing. |
| `autoCapture` | `true` | boolean | Capture completed turns. `false` stops new capture but still drains jobs already queued. |
| `captureIdleMs` | `90000` | integer 1000–3600000 | Idle debounce before a captured turn is distilled. |
| `distill.provider` | `""` | string | Model route. Must be set together with `model`, or both left empty (empty = reuse the session's last recorded route). |
| `distill.model` | `""` | string | See above. |
| `distill.maxItems` | `12` | integer 1–50 | Maximum candidates accepted from one distillation. |
| `distill.minConfidence` | `0.75` | number 0–1 | Below this, a candidate goes to `Inbox/` instead of a memory note. |
| `distill.maxInputChars` | `24000` | integer 256–100000 | Input ceiling for the single model call. |
| `distill.maxOutputTokens` | `4000` | integer 128–32000 | Output ceiling for that call. |
| `distill.timeoutMs` | `60000` | integer 1000–300000 | Per-call timeout. |
| `distill.maxRetries` | `3` | integer 0–10 | Retries with exponential backoff before a job becomes terminally `failed`. |
| `distill.dryRun` | `false` | boolean | Writes receipts only: no memory note, no MOC, no hot update. **Start here.** |
| `indexBackend` | `auto` | `auto` \| `sqlite` \| `scan` | `auto` falls back to the scan backend and reports it when FTS5 is unavailable; `sqlite` fails loudly instead. |
| `ignoreGlobs` | `[]` | list of vault/repository-relative globs | Only `*`, `**`, `?` and ordinary path characters. Braces, character classes, negation and escapes are **refused** at startup rather than silently mis-matching. Absolute paths and `..` are refused. Safety-excluded paths cannot be re-included. |

One shape of stale documentation to ignore: the design document's §12 lists
fields this plugin does **not** have (`projectsDir`, `methodsDir`, `metaDir`,
`reservedPrefixes`, `docMirror`, `distill.mode`, `distill.maxCostPerSession`). The
plan's field set — the table above — is the one the code implements. Directory
names and the pointer filename are protocol constants and are not configurable.
Those seven fields are **refused**, not ignored: a row carrying one fails to load
with an error that says the field was dropped by design.

---

## Using it

### The six tools

| Tool | Arguments | What it does |
|---|---|---|
| `mem_search` | `query` (required), `scope` (`project`\|`global`\|`all`, default `project`), `type`, `projectId`, `includeHistory`, `limit` (default 8) | Searches titles, bodies and frontmatter. `project` is the bound project only and refuses a different `projectId` rather than quietly going cross-project; `global` covers `Methods/` and the read-only `_meta/user.md`; `all` is required for cross-project. |
| `mem_read` | `path` (required, vault-relative), `section` | Returns body, parsed frontmatter and a content hash after re-verifying the file. Refuses internal directories such as `_meta/.history/`. |
| `mem_write` | `type`, `title`, `body` (required); `tags`, `status`, `confidence`, `assertion`, `supersedes`, `id`, `idempotencyKey` | The authoritative way to write project documents and memories. Without `id` it **creates** a note with a fresh id; with an existing `id` it updates. Superseding verifies the old id and writes both sides of the link. |
| `mem_log` | `text` (required); `session`, `section`, `idempotencyKey` | Appends one idempotent entry to today's log; `section: "hot"` targets the hot file's 进行中 zone instead. |
| `mem_brief` | — | Returns the same recall brief the session injected, so you can re-read or audit the budget. |
| `mem_admin` | `action` (required): `lint`, `index`, `bind`, `projects`, `promote`, `jobs`, `diagnostics`; plus `report`, `prune` (lint only), `rebuild` (index), `mode` (bind: `show`\|`local`\|`fork`\|`retain`), `path` (promote), `jobId`/`retry` (jobs) | Low-frequency maintenance. `lint` is read-only unless you pass `report: true` (writes a dated report note) and/or `prune: true` (deletes aged snapshots) — the two are independent on purpose. `diagnostics` is the one action that reads nothing: it returns this process's own ring of decisions — at most 200 events, drawn from the closed set `capture`, `distill`, `index`, `bind`, `job`, `transaction`, `brief`, `skill` (of which `brief`, `bind` and `skill` emit today), each with an outcome and machine identifiers and never a note body, a title or a prompt. It needs no binding and no vault, so it still answers when every other action refuses, and it empties when the process exits — use `jobs` and the receipts for anything that has to survive a restart. Set `DSH_OBSIDIAN_MEM_DEBUG=1` to additionally emit each event through the host logger at `info` level; whether the host shows that line is the host's decision, not this plugin's. |

`mem_write` types route like this:

| `type` | Lands in | Notes |
|---|---|---|
| `doc` | `Docs/<title>.md` + MOC update | Design docs, reports, guides. |
| `decision` | `Decisions/ADR-<n>-<slug>.md` | Context / Decision / Alternatives / Consequences. The number is allocated inside the vault lock and is for humans; the `id` is the identity. |
| `gotcha` | `Pitfalls/<slug>.md` | Symptom / cause / fix / evidence. |
| `convention` (alias `invariant`) | `Conventions/<slug>.md` | One fact per file. |
| `session-log` | `Daily/YYYY-MM-DD.md` | Append-only, idempotent per session id. |
| `hub`, `glossary` | `index.md`, `Docs/glossary.md` | MOCs and terminology. |
| low confidence / unclassified | `Inbox/<slug>.md` | Waiting for a human to sort it. |

Supersede never overwrites: the old note stays where it is, marked
`status: superseded` with `superseded_by`, and the new note links back. Two claims
that cannot be ranked become `status: contested` — no silent winner. `assertion`
records *how strong* a claim is (`stated`, `inferred`, `observed`), and `observed`
requires re-checkable evidence, not a model saying "verified".

### Automatic distillation

With `autoCapture: true`, a completed root turn is (1) captured after commit,
(2) filtered and stored as a `0600` job under
`$DSH_HOME/data/obsidian-mem/pending/`, (3) after an idle window, distilled by
**one** no-tool model call, (4) validated against its cited evidence sequence
numbers, and (5) applied idempotently as `decision` / `gotcha` / `convention`
notes. Aborted and errored turns are recorded but never become conclusions;
`doc` and `glossary` notes are only ever created through `mem_write`.

Start with:

```yaml
    distill:
      dryRun: true
```

and watch a few turns. `mem_admin(action="jobs")` lists the queue; a `failed` job
keeps its reason and can be revived with `mem_admin(action="jobs", jobId="…", retry=true)`.
Turn it live by setting `dryRun: false` and restarting.

### Where the plugin keeps its own data

Everything outside the vault lives under the data root, which is derived from
`DSH_HOME` in exactly one place (`$DSH_HOME`, or `~/.dsh` when unset):

```
$DSH_HOME/data/obsidian-mem/
├── index/          rebuildable SQLite search index (never authoritative)
├── locks/          whole-vault write lock
├── transactions/   journal for crash recovery
├── receipts/       per-write and per-job receipts
├── pending/        queued distillation jobs (0700/0600)
└── processed/      per-session processed floor (0700/0600)
```

Set `DSH_HOME` to an isolated directory and the plugin can never write into your
real `~/.dsh` — that is how the test suite runs, and how you should try anything
new.

---

## Privacy boundary

Automatic distillation sends text to a model. Here is exactly what crosses that
line.

**What is staged locally.** Completed turns are written to
`$DSH_HOME/data/obsidian-mem/pending/` at mode `0700`/`0600` *before* any model
call, so a restart can resume without calling the model again. Raw transcripts are
never written into the vault.

**What is sent.** A whitelist projection of a committed turn: real user messages,
final assistant text, tool names with a success/failure flag, and bounded file
paths with line numbers. Plugin injections, reasoning blocks, raw tool output,
tool arguments, subagent transcripts, the credential store, credential files and
environment variables are never read into it.

**What is scrubbed.** A deterministic scan skips any message matching a common
credential shape (common API-key prefixes, PEM blocks, and similar). A hit skips
the **whole message**, and the receipt records that it did.

**What is not guaranteed.** That scan is not an exhaustive secret scanner. If you
paste a secret into a session in an unrecognised format, the text of that message
is a normal part of the turn and may reach the model route. Treat the session as
you would any conversation with a model provider.

**Where it goes.** Only to the LLM route you configure, or to the session's last
recorded route when `distill.provider`/`model` are empty. Resolving no route is a
`deferred` state, not a call with default settings. There is no telemetry and no
other network egress.

**What is on disk.** The vault and the pending queue are plain local files, so
whatever backs them up or syncs them — Git, Time Machine, Obsidian Sync, a cloud
folder — will see them. If that matters for a user message, do not let it be
captured.

---

## Backup and migration

**The vault is the source of truth.** The SQLite index is a *rebuildable cache*:
delete `$DSH_HOME/data/obsidian-mem/index/` and it is rebuilt by scanning, or ask
for `mem_admin(action="index", rebuild=true)`. Nothing is recovered *from* the
index, ever.

**Git initialization is not backup.** `initGitOnCreate` only prepares a
newly-created vault for versioning. The plugin never commits, never configures a
remote and never treats Git as a rollback mechanism. Configure commits and remotes
yourself if you want them.

**Snapshots are not backup either.** Before modifying a file it owns, the plugin
copies the previous bytes to `_meta/.history/<txId>/`. Those copies are recovery
material for a failed transaction, they are not indexed, and `mem_admin(action="lint", prune=true)`
deletes aged ones under the vault lock. An out-of-repo index or a history
directory on the same disk is not a backup.

**Moving a repository to another machine.** Clone normally. `.obsidian-mem`
contains no absolute path — only `projectId`, `slug`, `displayName` and
`schema` — so set `vaultPath` to *that* machine's vault and the project keeps its
identity. If the vault comes along too, the project directory is reused as is.

**Renaming.** Renaming the repository or the display name does not move the
project directory; the directory name is fixed at first bind. `mem_admin(action="bind", mode="show")`
reports the binding without changing it.

**More than one copy of the repository.** Worktrees of the same repository share
one `projectId` and therefore one vault directory. A `fork` (a genuinely different
repository) gets a new id via `mem_admin(action="bind", mode="fork")`, and
`mode="retain"` confirms that a changed remote is still the same project. Neither
is automatic: a remote-URL mismatch pauses automatic writes and asks you.

**Retention.** `mem_admin(action="lint")` checks orphan rows, dead links,
duplicate basenames, frontmatter gaps, expired notes, file↔index mismatches and
queue backlog. `prune` removes aged `.history/` snapshot directories only when no
manifest or failure record still refers to them, and does so under the vault lock.

---

## External Markdown is audited, not controlled

`mem_write(type="doc")` is the authoritative path for project documentation, and
it is the only path the plugin can guarantee. Markdown that *you* create with an
editor, a `sed` one-liner, a code generator or another tool is invisible to it —
no plugin can intercept a shell write.

`mem_admin(action="lint")` reports repository Markdown that no vault note
references, so the gap is *visible*. It reports and never moves, rewrites or
adopts your files. Treat the report as a worklist, not as enforcement.

`README.md`, `AGENTS.md`, licenses and build configuration belong in the
repository and stay there; the vault holds the long-form documents people read.

---

## Honest limits

Each item here is a real boundary of this release. Most are deliberate refusals.
This is what is written down, not a claim to be exhaustive: `CHANGELOG.md` carries
the running record of what has been verified and what has not.

### The index is a cache, never the source of truth

Search results, briefs and `mem_admin(action="index")` are all derived from the
Markdown in the vault. A corrupt or stale index is recoverable, and the plugin
prefers re-scanning to serving you deleted content. If the vault and the index
ever disagree, the vault wins.

### The vault must be local

Automatic writes require a vault on **local disk**. Three reasons, in order of how
often they bite:

- **On-demand files.** iCloud Drive and `~/Library/CloudStorage/` mounts
  (Dropbox, OneDrive, Google Drive) can replace file contents with a placeholder
  and download them later. Reading such a file can block or fail with `EDEADLK`
  in a background process. A vault under `~/Library/Mobile Documents/` or
  `~/Library/CloudStorage/` is therefore refused for **reads as well as writes**
  (`vault-cloud-managed`), because a dataless read is as unsafe as a dataless
  write.
- **Sync clients can misread placeholders.** Obsidian Sync — and sync clients
  generally — may interpret an offloaded placeholder as a deletion. Combining
  Obsidian Sync with on-demand download in the same folder is the pattern most
  likely to lose work. Pick one, or keep the vault purely local and back it up
  with versioned copies.
- **Unknown providers cannot be recognised by path.** Only the two documented
  macOS roots are claimed. For any other provider, the plugin's defence is to
  pause on a file-level read failure and report it, rather than to guess from a
  directory name. `~/Documents` is deliberately *not* assumed to be
  provider-managed.

An offloaded or temporarily unreadable file pauses that file's update and is
reported. It is never overwritten as if it were empty.

### The property registry is not readable offline

Obsidian registers a property's *type* vault-wide in
`.obsidian/types.json`, and that file is a GUI-side artifact this plugin cannot
trust offline (and does not write). The property preflight therefore only sees
value types that are **visible in the note bytes it reads**: a property whose type
was fixed in Obsidian's UI while no note currently carries a value for it cannot
be detected. The first write to such a property may still conflict in Obsidian.
Closing this needs either a vault-side `types.json` reader or a live DOM probe;
neither is in this version.

The preflight reads at most the first 64 KiB of a note looking for the end of
frontmatter (so a vault full of large attachments does not trigger a mass
download) and stops after a bounded number of files, reporting the bound.

### File timestamps are never a date source

`created`, `updated` and `review_after` are dates, and dates come from the
calendar and the session — never from `mtime`, `ctime` or `birthtime`. A copied,
restored or checked-out file has a timestamp that has nothing to do with when the
fact was true. The index *does* use `mtime`/size as a cheap staleness hint, which
is a different job: it decides whether to hash a file, not what a note says.

### Hard links and bind mounts are invisible

The path jail resolves symlinks and refuses them at every level, and rejects
`..`, absolute paths and device paths. It cannot see the difference between an
ordinary file and a **hard link** or a **bind mount** that points somewhere else.
A same-user process that can write inside the vault could use one to make a write
land elsewhere.

Related, and unavoidable: there is a **TOCTOU window** between the `lstat` that
validates a path and the `open` that uses it. The transaction engine narrows the
damage (exclusive create, hash verification before every replacement, snapshot
before change, rollback that refuses to overwrite a concurrent edit), but it
cannot close a window the filesystem does not offer an atomic operation for.

The threat model is a single-user local vault. This is not a multi-tenant
sandbox.

### Other boundaries worth knowing

- **The write lock only restrains this plugin.** It is a whole-vault lock keyed
  by `realpath(vaultPath)`, so two projects cannot interleave a registry or
  receipt write. Obsidian and any other editor ignore it, which is why every
  replacement re-checks the file's hash first.
- **`withVaultLock` is not re-entrant.** A nested acquisition in the same process
  would deadlock, so no code path may nest one.
- **A job with no binding or no route re-arms indefinitely.** It is never marked
  terminally failed; it retries on each idle window (at least one queue-file write
  per window) until a binding or a route appears. Bounded, but not free.
- **Refusal audits are capped.** A job's refusal audit keeps at most 32 entries,
  so a receipt can say 32 when more candidates were dropped.
- **A human edit stops the write.** Generated blocks carry the hash of the body
  they declare. If the hash no longer matches, a person edited that block, and the
  plugin reports a conflict instead of rewriting it. This is by design and it
  means a hand-edited MOC or registry needs a human to reconcile it.
- **`dsh.plugin.json` is inert.** Nothing in DSH core reads it. It is a registry
  convention, which is exactly why `prepack` fails when it disagrees with
  `package.json`.
- **Session logs are DSH's, not this plugin's.** DSH writes
  `$DSH_HOME/sessions/…/session.v3.jsonl.zstd`, or `session.v4.jsonl.zstd` on
  the 0.1.7 line and later, itself. This plugin never edits them.

---

## Failure recovery

| Symptom | What it means | What to do |
|---|---|---|
| `vault-cloud-managed` | The vault root is under a known macOS cloud root, or the project was resolved from one. Reads and writes both refuse. | Move the vault to local disk and update `vaultPath`. |
| A note stops updating; the receipt names a read error | The file is offloaded or temporarily unreadable. The plugin pauses that update instead of overwriting. | Download the file (open it), or move the vault off the sync root. |
| `property-type-conflict` on bootstrap | An existing note uses one of the plugin's property names with an incompatible value type (`tags: foo` instead of a list, a quoted date, …). | Fix the note, or use an empty vault. The plugin will not rewrite your frontmatter. |
| A generated block reports a conflict | A human edited that block, so its declared hash no longer matches. | Reconcile by hand: restore the generated content, or decide the human version is authoritative and keep it — the plugin keeps reporting the same conflict until the declared hash matches the body again. |
| Search returns nothing, or says not-ready | The index is missing, unreadable or still scanning. | `mem_admin(action="index")` for status, `mem_admin(action="index", rebuild=true)` to rebuild. The vault is untouched. |
| A distillation job is `failed` | The model call or validation failed `maxRetries` times. The job keeps its reason. | `mem_admin(action="jobs")` to inspect, then `mem_admin(action="jobs", jobId="…", retry=true)`. |
| A job sits in `deferred` | No usable model route, the repository is not bound, or the model's output was refused by validation (`truncated`, `too-many-items`) and the job is backing off. It retries on each idle window. | Set `distill.provider` + `distill.model`, bind the project, or raise `distill.maxOutputTokens` / `distill.maxItems` for those two refusal codes. |
| DSH crashed mid-write | An unfinished transaction is journalled under `$DSH_HOME/data/obsidian-mem/transactions/`. | Restart the session: recovery runs before new writes. If a file was edited externally during the crash, both versions are kept and reported — nothing is overwritten. |
| `lock-corrupt` | The vault's write lock file (`$DSH_HOME/data/obsidian-mem/locks/vault-<hash>.lock`) exists but is unreadable — typically zero-length or truncated, from a process killed between creating it and writing its record. The plugin never treats an unreadable lock as "nobody holds it" and never steals it, so every write waits out the timeout and then refuses with this code. | Read the path named in the error and delete that **one file** by hand (`rm`), then retry. Nothing else needs cleaning: the lock is re-created on the next write, and no vault content depends on it. |
| `lock-timeout` | Another live process holds the vault's write lock, or a process died while holding a lock whose record is still readable and whose pid has not been observed as gone yet. | Wait for the other session to finish and retry. If you are sure the holder is dead, the lock is broken automatically once its recorded pid is gone — do not delete a readable lock by hand while a `dsh` process may still be running. |
| A repository refuses to write | A remote-URL mismatch, a different `projectId` for the same directory, a sibling worktree with conflicting metadata, or an unreadable sibling. The refusal names the reason and leaves the pointer exactly as it was — it never repairs or replaces one. | `mem_admin(action="bind", mode="show")` reports the situation; `mode="retain"` or `mode="fork"` is the explicit fix. A stale worktree needs `git worktree prune`. |
| A plain directory stays read-only | It is not inside a Git repository, so the plugin will not add it to long-term memory on its own — an implicit first write binds Git repositories only. | `mem_admin(action="bind", mode="local")` to bind it explicitly; the binding is live for the same session. |
| Memory is silently absent for a session | Any non-`bound` resolution means "no memory for this session" — by design, it never throws and never guesses. Reads never bind a repository, and a Git repository with no pointer is bound by its first write; a repository whose pointer or registry the plugin refuses to trust stays unbound until that is resolved. | Check `mem_admin(action="projects")` and the pointer file, then write once (a Git repository) or run `mem_admin(action="bind", mode="local")` (any directory) — both take effect in the same session. |

---

## Development

```sh
npm ci                                   # exact lockfile
npm test                                 # whole suite
npm run prepack                          # npm test + scripts/verify-pack.mjs
npm pack --dry-run --ignore-scripts      # manifest only
```

`npm test` is `node scripts/run-tests.mjs`: it creates a throwaway directory, sets
`DSH_HOME` to it, runs `node --test test/*.test.js`, and deletes the directory
afterwards. That is why the suite cannot write into your real `~/.dsh`.

`npm run prepack` is the release gate and it **only verifies**: the test suite,
then a static check that `package.json` and `dsh.plugin.json` agree on version,
plugin identity and entry point, that the `files` allowlist covers the assets the
tarball must carry (including `skills/obsidian-mem/SKILL.md`), that nothing in the
allowlist could pack `scratch/`, `research/`, `docs/`, `test/`, `node_modules/`,
probe records or pending queue data, and that `lib/tools.js` still carries a
`name: 'mem_x'` registration site for each of the six tools — and no seventh,
because the surface is capped on purpose. It never edits a configuration file and
never launches Obsidian.

`npm pack` itself runs `prepack`, so a plain `npm pack --dry-run` runs the whole
suite before printing the manifest — pass `--ignore-scripts` when you only want
the file list, and run `npm run prepack` explicitly when you want the gate.

Editing `README.md` means editing `README.zh.md` in the same change: the two sides
carry equal authority, and `README.i18n.yaml` records the git blob hash of each as
of the last confirmed-consistent state. Re-record both hashes with
`git hash-object README.md README.zh.md` and compare each value against the file
before you commit. The first-party verifier for this convention
(`verify-translation-pairing`) ships with the harness monorepo, not with this
plugin, so here that one command *is* the check.

Contribution rules, house style and the non-negotiable constraints are in
[`AGENTS.md`](./AGENTS.md). The measured host facts live in
[`docs/p0-compatibility.md`](./docs/p0-compatibility.md).

---

## License

MIT — see [`LICENSE`](./LICENSE).
