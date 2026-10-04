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
  reuses `lib/` rather than copying it, plus hooks for the session brief and a
  small relevant-note map on each new user prompt.
- **Adapter** is DSH-specific: six `mem_*` tools, a `node:sqlite` search index kept
  outside the vault, and automatic distillation of completed turns. The recall
  injection left that list: both harnesses compose it from the same `buildBrief`,
  and each delivers it through its own extension point.

> **Read [Honest limits](#honest-limits) before you enable automatic writes.**
> This plugin is careful about what it refuses, but it is young. What follows is
> what this release writes down, not a claim to be exhaustive; `CHANGELOG.md`
> keeps the running record of what has been verified and what has not.
>
> When something misbehaves, the package can produce a report you attach to an
> Issue yourself: generate it, read the JSON, then attach it. See
> [Diagnostic report for an Issue](#diagnostic-report-for-an-issue).

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
| Relevant notes offered | a bound project's new user turn may receive up to three matching notes, each with its title and the excerpt the index matched, inside a per-turn ceiling of its own (≤ `recallBudgetChars`); read the full note with `mem_read` |
| CJK search works | write a note, then `mem_search` a two-character Chinese word |
| Vault files are real | `ls "$vault/Projects/"` — plain Markdown, readable with the plugin uninstalled |

### Memory graph in the DSH sidebar

On DSH `0.1.7-rc.2` with `dsh-better-sidebar` `0.21.1`, open the native right
sidebar and choose **+ → 记忆图谱 (Memory graph)**. The settings button opens
the same four sections as Obsidian's graph: filters, colour groups, display and
forces. Under filters, **Scope** switches all memory/current project; all memory
is the initial view.
Colours are resolved the way Obsidian's graph resolves them: the eleven
`.graph-view.color-*` slots are read from the host theme, so the view follows the
DSH light/dark theme exactly as Obsidian's graph follows its own. The defaults are
neutral nodes and lines with an accent highlight for hover and memory access;
colour groups start empty. Labels are rasterized at 50% of Obsidian's
`14 + node size / 4` because this graph lives in a narrow sidebar, and the display
section's **标题文字大小** slider moves that factor between 0.4 and 1.6; position,
`sqrt(scale)` scaling and the pinned size of a hovered node are unchanged.
Lines resolve wikilinks, Markdown links, embeds and YAML
wikilinks with Obsidian's filename and relative-path rules. Scroll to zoom, drag the canvas or a node,
and hover to reveal its label and connected branch. Colour groups support note
type queries such as `[type:decision]`. The view displays at most 500 nodes,
prioritising connected hubs and branches. All-memory scope includes historical
notes, unresolved targets and the administrative Markdown links that connect
projects. Administrative notes remain excluded from memory retrieval; the graph
exposes only their labels and relationships. **Existing files only** hides
unresolved targets. Attachments are outside this Markdown view and remain disabled.

When this DSH process does something to memory, the matching node and adjacent links
pulse briefly and that node's file name stays on screen at any zoom, so the cue
names what was touched: a successful `mem_read`, or a host `read`/`grep` that opens
a note in the vault (a **read**, in the accent colour); the notes a `mem_search`
returned (the same colour, lighter); and the notes a `mem_write`/`mem_log`, or a
host `edit`/`write`, wrote (a **write**, in the tag colour). Injecting a
relevant-note map into a turn lights its notes too. A host call counts only when
its arguments name one `.md` inside the vault — `bash` and `run_code` deliberately
do not, because their arguments are command or program text. These cues
are per session and kept in memory only; reloading the host clears them. A cue moves
a label's colour and opacity but never its size: every lit label in a frame is drawn
at one size, so two notes touched in the same second cannot disagree. The graph
endpoint is read-only and accepts same-origin requests from the local DSH web UI.
Without Better Sidebar, the six memory tools continue to work.

The controls themselves are remembered, unlike the cues: scope, filters, colour
groups, display and forces are kept in this browser's `localStorage` under one key
(`dsh-obsidian-mem:graph-settings`), so they survive a page reload and a host
restart. They belong to the browser profile and the origin, which makes
`127.0.0.1:3080` and `localhost:3080` two separate panels; nothing about them leaves
the browser, and the endpoint above stays read-only. **恢复默认设置** writes the
built-in values back over the stored record. A record another version wrote, or one
edited by hand, is never trusted as it stands: every field is checked and falls back
to its default, because a `NaN` force blanks the graph instead of merely looking
wrong.

The browser assets are re-read on every request, so a change under `lib/` reaches the
page on reload instead of waiting for the host to restart. A **new** asset is the one
exception: the route list is registered when the plugin mounts, so adding a file needs
one remount before the browser can fetch it.

The interface and force/rendering rules were adapted by inspecting the installed
Obsidian graph source. Canvas drawing uses its node-size, label-fade and
zoom rules; the worker uses the same D3 fallback force model. The package bundles
pinned upstream D3 code and its ISC notices, with no CDN request or additional
runtime dependency. No Obsidian application code is included in the package.

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
    recallBudgetChars: 900
    hotCapacityChars: 9000
    hotArchiveRatio: 0.67
    autoCapture: true
    autoCurate: true
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
| `injectBrief` | `true` | boolean | Whether the session brief and per-turn relevant-note map are injected. |
| `briefBudgetChars` | `6000` | integer 256–20000 | Hard ceiling for the session brief and the weekly hint, in Unicode code points. |
| `recallBudgetChars` | `900` | integer 256–20000 | Per-turn ceiling for the relevant-note map, in Unicode code points. Deliberately separate from `briefBudgetChars`: charged against the brief's leftovers, the map fired on 0.6% of first turns against 22.1% of later ones. |
| `hotCapacityChars` | `9000` | integer 1024–50000 | Capacity of `_meta/hot.md`. Storage capacity, *not* injection budget. |
| `hotArchiveRatio` | `0.67` | open interval (0,1) | Above this fill level the plugin archives 已完成 entries before writing. |
| `autoCapture` | `true` | boolean | Capture completed turns. `false` stops new capture but still drains jobs already queued. |
| `autoCurate` | `true` | boolean | Automatic curation passes. `false` disables the automatic triggers only: `mem_admin(action="curation", operation="scan")` and the review command keep working, and no source note is changed either way. |
| `captureIdleMs` | `90000` | integer 1000–3600000 | Idle debounce before a captured turn is distilled. |
| `distill.provider` | `""` | string | Model route. Must be set together with `model`, or both left empty (empty = reuse the session's last recorded route). A session imported from another harness has no recorded route, so imported history stays `deferred` until this is set. |
| `distill.model` | `""` | string | See above. |
| `distill.maxItems` | `12` | integer 1–50 | Maximum candidates accepted from one distillation. The same number is written into the system prompt, so the model is told the ceiling it would be refused for exceeding; a batch over it is refused whole, never trimmed. |
| `distill.minConfidence` | `0.75` | number 0–1 | Below this, a candidate goes to `Inbox/` instead of a memory note. |
| `distill.maxInputChars` | `24000` | integer 256–100000 | Input ceiling for the single model call. |
| `distill.maxOutputTokens` | `4000` | integer 128–32000 | Output ceiling for that call. |
| `distill.timeoutMs` | `60000` | integer 1000–300000 | Per-call timeout. |
| `distill.maxRetries` | `3` | integer 0–10 | **Total attempts**, not extra retries: `3` means one attempt plus two retries with exponential backoff, after which the job becomes terminally `failed` and keeps its raw output. |
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
| `mem_admin` | `action` (required): `lint`, `index`, `bind`, `projects`, `promote`, `jobs`, `curation`, `diagnostics`; plus `report`, `prune` (lint only), `rebuild` (index), `mode` (bind: `show`\|`local`\|`fork`\|`retain`), `path` (promote), `jobId`/`retry` (jobs), `operation` (curation: `status`\|`scan`) | Low-frequency maintenance. `lint` is read-only unless you pass `report: true` (writes a dated report note) and/or `prune: true` (deletes aged snapshots) — the two are independent on purpose. `curation` reads or runs the bounded curation pass described below; it never applies a review proposal. `diagnostics` is the one action that reads nothing: it returns this process's own ring of decisions — at most 200 events, drawn from the closed set `capture`, `distill`, `index`, `bind`, `job`, `transaction`, `brief`, `skill`, `recall`, `curation` (all ten emit today), each with an outcome and machine identifiers and never a note body, a title or a prompt. A window therefore answers the questions that otherwise need a reproduction: why a finished turn was not captured (the `capture` event names the reason), whether distillation produced nothing or was never attempted (`distill`, `job`), whether the index followed a write (`index`), and whether a write was committed or refused with a code (`transaction`). It needs no binding and no vault, so it still answers when every other action refuses, and it empties when the process exits — the separate local journal above preserves reduced events for the user-run report. Set `DSH_OBSIDIAN_MEM_DEBUG=1` to additionally emit each event through the host logger at `info` level; whether the host shows that line is the host's decision, not this plugin's. |

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

A candidate whose title already exists in the bound project is **skipped**, not
written twice: the lookup is the same project scope and the same tokenizer as
`mem_search`, narrowed to the candidate's own type, and a skip names the note
that already covers the fact in the job's receipt. Superseding a note explicitly
is exempt — that is the one case where writing beside an existing title is the
point.

Start with:

```yaml
    distill:
      dryRun: true
```

and watch a few turns. `mem_admin(action="jobs")` lists the queue; a `failed` job
keeps its reason and can be revived with `mem_admin(action="jobs", jobId="…", retry=true)`.
Turn it live by setting `dryRun: false` and restarting.

### Automatic curation

With `autoCurate: true` (the default) the plugin also keeps a compact,
rebuildable navigation view of the current project and inspects notes for
curation work. It is deliberately weaker than the memory layer around it:

- **Nothing semantic happens on its own.** An edited note, a past `review_after`,
  a broken link or an exact-duplicate group only produces a view entry or a
  review-only finding. A suspected near duplicate, a differing number or date, or
  a supersede a model proposed is **parked** as a durable proposal under
  `$DSH_HOME/data/obsidian-mem/curation/proposals/` instead of being applied, and
  every source fact stays exactly where it is.
- **The review command is the only approval route.** From the installed package:
  `dsh-obsidian-mem-review --vault <absolute-path> <proposal-id>`; from a
  checkout, `node lib/curation-cli.js --vault … <proposal-id>`. It prints the
  proposal's exact operation and sources, requires a terminal on stdin *and*
  stdout, and accepts only `apply <id>` or `reject <id>` typed byte-for-byte, one
  proposal per run — there is no `--all` and no default answer. `reject` changes
  no source byte. **No `mem_admin` action, parameter or enum value applies,
  approves or rejects a proposal**, so approval is never model-callable. A
  proposal whose source changed between the scan and the approval is refused and
  stays `pending` rather than rebasing itself.
- **The view is a cache, never a second source of truth.** The cursor, the
  per-path scan records, the changed-path queue and the view live under
  `$DSH_HOME/data/obsidian-mem/curation/`. Every view entry carries the sha256 of
  the bytes it was built from; before a brief uses one it re-hashes every path it
  stands for — including every member of a collapsed exact-duplicate group — and
  a missing, edited, unreadable or oversized source makes the brief fall back to
  the source-navigation path it used before the view existed. Deleting those four
  rebuildable documents — the cursor, the per-path records, the changed-path queue
  and the view — costs one scan and nothing else. The `proposals/` subtree of the
  same directory is **not** rebuildable: it holds every parked candidate and its
  decision record, so deleting it discards review work that no scan can recreate
  (the source notes are untouched, but the parked candidate and its reason are
  gone). A view is injected only when it is
  marked `complete`: a full pass that stopped at either bound publishes
  `complete: false`, and a changed-path pass may merge only into a view that is
  already complete (`backfill-incomplete` otherwise), so a partial backfill can
  never be published as the project's navigation.
- **Automatic passes are bounded, host-specific, and resume only when the project
  is due again.** In DSH a committed write queues its note and session activity
  checks a due project; the pass runs outside the model request and a failure
  never fails your turn. In Codex the pass runs in the installed, **trusted**
  `SessionStart` hook — Codex skips an untrusted hook in silence, and an MCP-only
  install (no hooks) gets the explicit `mem_admin` scan and **no automatic pass at
  all**. One pass examines at most 256 notes and stops *starting* new inspections
  once 500 ms of curation work has elapsed. A pass that hits either bound says so
  (`truncated`, `complete: false`) and keeps its position: the notes it finished
  are recorded and the ones it never reached are picked up by the next pass. That
  next pass is **not** the next session by itself. Both automatic triggers ask only
  whether the project is due, and a full pass truncated by the note or time bound
  records a fresh due marker as it scans, so a later session start with an empty hint
  queue answers `skipped` and the backfill waits. A pass truncated by the *manifest*
  bound (`manifest-budget`) is the exception: it deliberately leaves the cursor
  alone, so no fresh marker is written and whether the next trigger finds the project
  due is decided by whatever marker was already stored. A project becomes due again
  in exactly three ways: a
  committed write queues a **changed-path hint**, which is weighed against that
  queue and not against the marker, so it re-opens the project well inside the 24
  hours; you request `mem_admin(action="curation", operation="scan")`; or the
  24-hour marker expires. A completed project is due again on those same three
  conditions — so a vault larger than one pass advances its backfill at most once
  per 24 hours per project until a write queues a hint for it.

`mem_admin(action="curation", operation="status")` reads the cursor, the
committed view and the bounded proposal queue without inspecting anything;
`operation="scan"` runs one bounded pass now and adds the pass's own inspected
count and truncation reason. Both remain available when `autoCurate: false`;
only the automatic triggers stop.

Measured on one 600-note temporary vault on this machine (the probe and its raw
output are in `CHANGELOG.md`): a full pass inspected 256 notes with a median of
136 ms and a worst case of 171 ms over 15 rounds, and a real `SessionStart` hook
run paid a median of 172 ms and a worst case of 179 ms more than the identical
run that skipped the pass. The 500-ms deadline was never reached at that size —
the note bound binds first — so these numbers confirm the ceiling is not the
binding constraint here; they do not claim that 256/500 is optimal, and a project
large enough to make the deadline bind is not a case this repository has run.
The untested list is in `CHANGELOG.md`; it is not repeated here.

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
├── curation/       rebuildable curation state: cursor, per-path scan records,
│                   changed-path queue, compact view and parked proposals (0700/0600)
├── diagnostics/    bounded content-free decision journal (0700/0600)
└── processed/      per-session processed floor (0700/0600)
```

Set `DSH_HOME` to an isolated directory and the plugin can never write into your
real `~/.dsh` — that is how the test suite runs, and how you should try anything
new.

---

## Diagnostic report for an Issue

When the installed package exposes its npm binary, generate a report yourself:

```sh
dsh-obsidian-mem-diagnose --output ./obsidian-mem-diagnostics.json
```

From a checkout, `node lib/diagnose-cli.js --output ./obsidian-mem-diagnostics.json`
runs the same command. It works even if the host plugin fails to load. The command
never uploads the file, edits DSH configuration or reads a real vault. It requires
an explicit output path and refuses to overwrite an existing file. The completed
JSON has mode `0600` and a 256 KiB limit. Open it in a text editor and review it
before attaching it to an Issue. **[Attachments to a public GitHub repository](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/attaching-files) can
be viewed by anyone**, including people without a GitHub account; event times
may reveal when you used the plugin.

The report contains the plugin and Node versions, OS type and architecture,
non-identifying configuration switches when a journal is available, fixed self-check
statuses, and recent decision events. Events have times, categories, approved
outcomes or coarse error codes, counts and per-run aliases such as `p1` or `j1`.
The command counts pending job files by directory entry without opening them. It
checks Node and in-memory FTS5, package files, local journal health, and the
`mem_admin` diagnostics contract in a disposable home and vault. It does **not**
check your real vault, model route, host session hooks or the contents of queued
jobs. Unavailable, incomplete or damaged evidence is marked `unavailable` or
`partial`; a missing journal is not proof that earlier calls succeeded.
Without the optional DSH host packages, the isolated plugin check can be
`unavailable` while the basic report still succeeds.

The enabled DSH plugin and Codex adapter record this reduced event stream locally
by default under `$DSH_HOME/data/obsidian-mem/diagnostics/`, with mode
`0700`/`0600`. Each process keeps at most 200 events and 128 KiB. On the next
plugin start, run files idle for over seven days are removed; export ignores
expired files, and no background cleanup runs while the plugin is stopped. The
in-process `mem_admin(action="diagnostics")` ring remains separate. A journal
failure does not change a plugin call's outcome.

The journal and report **never include conversation text, prompts, model output,
note bodies or titles, tool arguments, raw host logs, pending job bodies,
configuration files, credentials, environment variable values, paths, original
project/job/transaction IDs, hostnames or repository remotes**. The command makes
no network request. These exclusions apply to the diagnostic route; automatic
distillation follows the model-call boundary below.

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

`README.md`, licenses and build configuration belong in the repository and stay
there; the vault holds the long-form documents people read.

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
| A job is terminally `failed` on `too-many-items` | The model returned more items than the ceiling allowed, and the batch is refused whole rather than trimmed. The raw output is kept (`outputState: raw-durable`), so raising `distill.maxItems` above the item count the job reports in `lastError` needs **no new model call**: a retry re-validates that stored text. | Raise `distill.maxItems`, then `mem_admin(action="jobs", jobId="…", retry=true)`. A retry without the raise re-validates the same bytes against the same ceiling and fails again. |
| DSH crashed mid-write | An unfinished transaction is journalled under `$DSH_HOME/data/obsidian-mem/transactions/`. | Restart the session: recovery runs before new writes. If a file was edited externally during the crash, both versions are kept and reported — nothing is overwritten. |
| `lock-corrupt` | The vault's write lock file (`$DSH_HOME/data/obsidian-mem/locks/vault-<hash>.lock`) exists but is unreadable — typically zero-length or truncated, from a process killed between creating it and writing its record. The plugin never treats an unreadable lock as "nobody holds it" and never steals it, so every write waits out the timeout and then refuses with this code. | Read the path named in the error and delete that **one file** by hand (`rm`), then retry. Nothing else needs cleaning: the lock is re-created on the next write, and no vault content depends on it. |
| `lock-timeout` | Another live process holds the vault's write lock, or a process died while holding a lock whose record is still readable and whose pid has not been observed as gone yet. | Wait for the other session to finish and retry. If you are sure the holder is dead, the lock is broken automatically once its recorded pid is gone — do not delete a readable lock by hand while a `dsh` process may still be running. |
| A repository refuses to write | A remote-URL mismatch, a different `projectId` for the same directory, a sibling worktree with conflicting metadata, or an unreadable sibling. The refusal names the reason and leaves the pointer exactly as it was — it never repairs or replaces one. | `mem_admin(action="bind", mode="show")` reports the situation; `mode="retain"` or `mode="fork"` is the explicit fix. A stale worktree needs `git worktree prune`. |
| A plain directory stays read-only | It is not inside a Git repository, so the plugin will not add it to long-term memory on its own — an implicit first write binds Git repositories only. | `mem_admin(action="bind", mode="local")` to bind it explicitly; the binding is live for the same session. |
| Memory is silently absent for a session | Any non-`bound` resolution means "no memory for this session" — by design, it never throws and never guesses. Reads never bind a repository, and a Git repository with no pointer is bound by its first write; a repository whose pointer or registry the plugin refuses to trust stays unbound until that is resolved. | Check `mem_admin(action="projects")` and the pointer file, then write once (a Git repository) or run `mem_admin(action="bind", mode="local")` (any directory) — both take effect in the same session. |
| A curation proposal is `pending` and no note changed | That is the design: a suspected near duplicate or a model-proposed supersede is parked for review and never applied automatically. | `mem_admin(action="curation", operation="status")` lists the queue; approve or reject one proposal with `dsh-obsidian-mem-review --vault <absolute-path> <proposal-id>`. Rejecting touches no source note. |
| The brief no longer shows the compact navigation, or a claimed duplicate group disappeared | The stored view is a cache: one of its sources changed, vanished or became unreadable, so the brief fell back to the source-navigation path instead of injecting a stale line. | Nothing to repair. The next complete pass rebuilds it; `mem_admin(action="curation", operation="scan")` runs one now and reports `complete` and any truncation reason. |

If a symptom is not in this table, or the fix above did not work, generate the
diagnostic report and attach the JSON to an Issue — see
[Diagnostic report for an Issue](#diagnostic-report-for-an-issue). The command
never uploads anything: you inspect the file and attach it yourself.

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
probe records or pending queue data, that `lib/tool-registry.js` still carries a
`name: 'mem_x'` registration site for each of the six tools — and no seventh,
because the surface is capped on purpose — and that `lib/tools.js` still
re-exports all four names both entry points import (`TOOL_NAMES`,
`TOOL_PARAMETERS`, `registerTools`, `createMemoryServices`). The two checks are
separate because they fail separately: every tool can be registered correctly and
still be invisible if the façade stops publishing it. It never edits a
configuration file and never launches Obsidian.

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

### Releases

This repository publishes no npm package. A release is a **git tag plus a GitHub
Release**, and `.github/workflows/release.yml` creates both.

| Bump | When | Who |
|---|---|---|
| `0.0.1` | every push into `main` | the workflow, mechanically |
| `0.1` | a notable feature | a person, before the push |
| `1` | a breaking change | a person, before the push |

Only the patch bump is automated: nothing infers "a notable feature" or
"breaking" from a diff, so a minor or major release is `package.json` edited by
hand with the changelog section written for it.

Every Release also carries the packed plugin as `dsh-obsidian-mem-<version>.tgz`,
so an install can skip the build-from-source path — which needs a `prepare`
approval in pnpm's `allowBuilds` — and take the prebuilt archive instead. The
marketplace entry for this plugin pins that asset by tag, because the
`releases/latest/download/<file>` form resolves `latest` at request time while
taking the filename literally, so a version in the asset name would rot the link
on the next release.

What the workflow does, in order:

1. `npm run check` — the whole gate, on the commit about to be released.
2. Classifies the push by asking the remote whether the version in
   `package.json` already carries a tag. A checkout fetches no tags, so this
   cannot be answered locally.
3. If it does not: tags that version, releases it as it stands, and stops. This
   is the bootstrap branch, and it is how a hand-prepared `0.1` or `1` becomes a
   release instead of being bumped back down to a patch.
4. If it does: skips a `chore(release):` commit, refuses a push that changed
   `lib/` without a real `## Unreleased` entry, then bumps the patch, moves the
   changelog section under `## <version> — <date>`, updates `dsh.plugin.json` and
   the Codex server identity, commits as `chore(release): <version>`, tags, and
   publishes the Release from that section.

After a release `## Unreleased` is empty on purpose; add an entry as you work, or
the next push is refused.

The workflow has now run on a real GitHub runner: it published `v0.1.2`, and
`v0.1.1` was published by hand at the commit that declared it, so the bootstrap
branch itself has still not been exercised. Two defects were found by running it
and are recorded in `CHANGELOG.md` under Unreleased: a checkout fetches no tags,
so the classification has to ask the remote; and the branch that tags an
untagged version must not also be the only branch a tagged version can take, or
nothing would ever bump again.

Contribution rules, house style and the non-negotiable constraints live in the
maintainer's `AGENTS.md`, and the measured host facts in
`docs/p0-compatibility.md`. Both are kept beside the checkout rather than in it —
this repository ignores them (see `.gitignore`, and `CHANGELOG.md` for why) — so the
citations of them under `lib/` name local files, not repository ones. What ships,
and what a reader needs before enabling writes, is this README and the changelog.

---

## License

MIT — see [`LICENSE`](./LICENSE).
