# dsh-obsidian-mem

A **DeepSeek Harness host plugin** that keeps a project's documents and long-term
memory as plain Markdown in a dedicated [Obsidian](https://obsidian.md) vault.

One repository gets one stable `projectId`, one committed pointer file and one
fixed directory in the vault. The plugin writes there; Obsidian just shows you
the result. Obsidian does not need to be running, and no part of the vault
depends on DSH.

```
repository                          vault (~/Documents/dsh-memory)
├── .obsidian-mem   ───────────►    └── 项目/<slug>--<projectId 前8位>/
│     projectId, slug,                    ├── index.md          hub / MOC
│     displayName, schema: 1              ├── 文档/  决策/  约定/  踩坑/
└── src/ …                                ├── 日志/YYYY-MM-DD.md
                                          ├── 收件箱/           待分类
                                          └── _meta/hot.md      热记忆
```

Two layers, on purpose:

- **Protocol** (vault layout, the `.obsidian-mem` pointer, note frontmatter, the
  distillation output contract) is plain Markdown and is not DSH-specific. The
  shipped skill `skills/obsidian-mem/SKILL.md` follows the Agent Skills format,
  so it works in another harness too.
- **Adapter** is DSH-specific: six `mem_*` tools, one budgeted recall injection at
  the first step of a session, a `node:sqlite` search index kept outside the
  vault, and automatic distillation of completed turns.

> **Read [Honest limits](#honest-limits) before you enable automatic writes.**
> This plugin is careful about what it refuses, but it is young, and several
> behaviours have not been verified at all. They are listed, not buried.

---

## Requirements

| | Version | Why |
|---|---|---|
| Node | `>= 22.22.2` | The floor is a *measurement*. `node:sqlite` imports on Node 22.13.0, but that build has no FTS5; 22.22.2 and 25.9.0 do. Versions 22.14–22.21 were not tested, so the floor is the lowest version actually proven to work. |
| DSH | `0.1.5-rc.2` | The version every measurement in `docs/p0-compatibility.md` was taken on. The plugin uses only row `config:` and documented Cordis seams, so newer versions are likely fine — but "likely" is not "tested", so this is what it was verified against. |
| Obsidian | any recent version | Optional. Only needed to *read* the vault comfortably. |

Runtime dependencies are deliberately tiny: `@deepseek-ai/schemastery` for config
validation and `yaml` for frontmatter. `node:sqlite` is built into Node, so there
is no native module to compile.

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

This is the exact sequence that was tested:

```sh
cd /path/to/dsh-obsidian-mem           # the checkout of this plugin

# A clean DSH home for the trial run: nothing here touches your real ~/.dsh.
export DSH_HOME="$(mktemp -d)"

dsh plugin --profile memcheck add "link:$PWD"
#   dsh: initialized profile memcheck at /tmp/…/profiles/memcheck
#   dependencies:
#   + dsh-obsidian-mem link:/…/dsh-obsidian-mem

dsh --profile memcheck --dump-config | grep -n obsidian-mem
#   # == dsh-obsidian-mem
#   - id: obsidian-mem
#     name: dsh-obsidian-mem

unset DSH_HOME
```

`dsh plugin --profile <name> add "link:<abs path>"` creates the profile if it does
not exist, installs the checkout as a link (so your edits are live), and layers
this package's `cordis.patch.yml`, which is what mounts the `obsidian-mem` row.
If `--dump-config` shows no such row, stop here.

### 3. Install into the profile you actually use

```sh
dsh plugin --profile web add "link:$PWD"
dsh --profile web --dump-config | grep -n obsidian-mem
```

Replace `web` with your profile name.

### 4. Restart DSH and open a new session

Plugin code is loaded once per process: **restart `dsh web`** (or your harness)
and start a *new* session so the row is mounted and the pre-step injection has a
session to attach to. An existing session keeps the old plugin instance.

### 5. Open the vault in Obsidian

1. Obsidian → **Open folder as vault** → select the vault directory.
2. That is all. Nothing needs to be pre-created; the plugin bootstraps the project
   directory on first use.
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
| Project bound | `mem_admin(action="projects")` — with no pointer, a Git repository gets a fresh `.obsidian-mem` and a project skeleton on first write |
| Recall injected once | the first request of a session carries one `obsidian-mem` recall message (≤ `briefBudgetChars`) |
| CJK search works | write a note, then `mem_search` a two-character Chinese word |
| Vault files are real | `ls "$vault/项目/"` — plain Markdown, readable with the plugin uninstalled |

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
| `distill.minConfidence` | `0.75` | number 0–1 | Below this, a candidate goes to `收件箱/` instead of a memory note. |
| `distill.maxInputChars` | `24000` | integer 256–100000 | Input ceiling for the single model call. |
| `distill.maxOutputTokens` | `4000` | integer 128–32000 | Output ceiling for that call. |
| `distill.timeoutMs` | `60000` | integer 1000–300000 | Per-call timeout. |
| `distill.maxRetries` | `3` | integer 0–10 | Retries with exponential backoff before a job becomes terminally `failed`. |
| `distill.dryRun` | `false` | boolean | Writes receipts only: no memory note, no MOC, no hot update. **Start here.** |
| `indexBackend` | `auto` | `auto` \| `sqlite` \| `scan` | `auto` falls back to the scan backend and reports it when FTS5 is unavailable; `sqlite` fails loudly instead. |
| `ignoreGlobs` | `[]` | list of vault/repository-relative globs | Only `*`, `**`, `?` and ordinary path characters. Braces, character classes, negation and escapes are **refused** at startup rather than silently mis-matching. Absolute paths and `..` are refused. Safety-excluded paths cannot be re-included. |

One shape of stale documentation to ignore: the design document's §12 lists
fields this plugin does **not** have (`projectsDir`, `methodsDir`, `metaDir`,
`reservedPrefixes`, `docMirror`, `distill.mode`, `maxCostPerSession`). The plan's
field set — the table above — is the one the code implements. Directory names and
the pointer filename are protocol constants and are not configurable.

---

## Disabling Hindsight (a manual step)

This plugin and Hindsight both want to be the memory layer, and having two of
them is confusing. Switching Hindsight off is **your** edit, applied by hand.
Nothing in this repository will do it for you, and `npm run prepack` never writes
to a config file.

Append to `$DSH_HOME/cordis.patch.yml` (usually `~/.dsh/cordis.patch.yml`),
**keeping every row that is already in the file** — it is a patch layer, and
replacing it disables things you did not mean to touch:

```yaml
- id: hindsight
  disabled: true
```

Then confirm and restart:

```sh
dsh --profile web --dump-config | grep -n hindsight      # expect "disabled: true"
```

Restart `dsh web` afterwards and start a new session, so no old session keeps a
live Hindsight instance while the new one runs without it. To go back, delete
those two lines and restart again.

---

## Using it

### The six tools

| Tool | Arguments | What it does |
|---|---|---|
| `mem_search` | `query` (required), `scope` (`project`\|`global`\|`all`, default `project`), `type`, `projectId`, `includeHistory`, `limit` (default 8) | Searches titles, bodies and frontmatter. `project` is the bound project only and refuses a different `projectId` rather than quietly going cross-project; `global` covers `方法/` and the read-only `_meta/user.md`; `all` is required for cross-project. |
| `mem_read` | `path` (required, vault-relative), `section` | Returns body, parsed frontmatter and a content hash after re-verifying the file. Refuses internal directories such as `_meta/.history/`. |
| `mem_write` | `type`, `title`, `body` (required); `tags`, `status`, `confidence`, `assertion`, `supersedes`, `id`, `idempotencyKey` | The authoritative way to write project documents and memories. Without `id` it **creates** a note with a fresh id; with an existing `id` it updates. Superseding verifies the old id and writes both sides of the link. |
| `mem_log` | `text` (required); `session`, `section`, `idempotencyKey` | Appends one idempotent entry to today's log; `section: "hot"` targets the hot file's 进行中 zone instead. |
| `mem_brief` | — | Returns the same recall brief the session injected, so you can re-read or audit the budget. |
| `mem_admin` | `action` (required): `lint`, `index`, `bind`, `projects`, `promote`, `jobs`; plus `report`, `prune` (lint only), `rebuild` (index), `mode` (bind: `show`\|`local`\|`fork`\|`retain`), `path` (promote), `jobId`/`retry` (jobs) | Low-frequency maintenance. `lint` is read-only unless you pass `report: true` (writes a dated report note) and/or `prune: true` (deletes aged snapshots) — the two are independent on purpose. |

`mem_write` types route like this:

| `type` | Lands in | Notes |
|---|---|---|
| `doc` | `文档/<title>.md` + MOC update | Design docs, reports, guides. |
| `decision` | `决策/ADR-<n>-<slug>.md` | Context / Decision / Alternatives / Consequences. The number is allocated inside the vault lock and is for humans; the `id` is the identity. |
| `gotcha` | `踩坑/<slug>.md` | Symptom / cause / fix / evidence. |
| `convention` (alias `invariant`) | `约定/<slug>.md` | One fact per file. |
| `session-log` | `日志/YYYY-MM-DD.md` | Append-only, idempotent per session id. |
| `hub`, `glossary` | `index.md`, `文档/术语表.md` | MOCs and terminology. |
| low confidence / unclassified | `收件箱/<slug>.md` | Waiting for a human to sort it. |

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

Each item here is a real boundary of this release. Most are deliberate refusals;
the ones marked *not verified* have simply never been exercised, and you should
assume nothing about them.

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
  `$DSH_HOME/sessions/…/session.v3.jsonl.zstd` itself. This plugin never edits
  them.

### Not verified

These are not hedges. They are things that were not tested, listed so you can
decide what to trust:

1. **The live model call has been measured on exactly one host and one route.**
   `docs/smoke-results.md` records a real isolated-profile run (DSH
   `0.1.5-rc.2`, route `deepseek-official`/`deepseek-flash`) in which the queue
   worker distilled a real completed turn and applied the note, with a real
   `usage` and `attempts: 0`. No other provider or model has been exercised, and
   the request shape is pinned to the contract measured in
   `docs/p0-compatibility.md` §8.
2. **The automatic write needs a process that is still alive when the job comes
   due.** DSH disposes the plugin tree when a headless run's session completes
   (`docs/p0-compatibility.md` §9), so in a one-shot `dsh "…"` run a freshly
   captured turn is normally applied by the *next* run: the job stays `pending`
   and is resumed at startup. A long-lived host (the GUI server) applies it in
   the same process. Either way the guarantee is "at least once after the job is
   fsynced", never "immediately".
3. **No power-loss test.** Crash recovery is exercised by `SIGKILL` at specific
   barriers, not by cutting power or inducing a kernel flush failure.
4. **Cross-process lock contention is untested.** The vault lock is tested within
   one process and against a dead child process. Two live processes contending for
   the same vault have not been tested.
5. **Obsidian GUI rendering and typed properties are unverified.** The files are
   written to be readable and the frontmatter is validated against the vocabulary
   in the design, but nobody has opened this plugin's output in a running
   Obsidian and confirmed how tags, date properties and path-qualified links
   render.
6. **`fork` and `retain` are untested on a worktree-sibling layout.** Both modes
   have tests, but not on the multi-worktree arrangement they exist to handle.

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
| A job sits in `deferred` | No usable model route, or the repository is not bound. It retries on each idle window. | Set `distill.provider` + `distill.model`, or bind the project. |
| DSH crashed mid-write | An unfinished transaction is journalled under `$DSH_HOME/data/obsidian-mem/transactions/`. | Restart the session: recovery runs before new work. If a file was edited externally during the crash, both versions are kept and reported — nothing is overwritten. |
| A repository refuses to write | A remote-URL mismatch, a different `projectId` for the same directory, a sibling worktree with conflicting metadata, or an unreadable sibling. | `mem_admin(action="bind", mode="show")` reports the situation; `mode="retain"` or `mode="fork"` is the explicit fix. A stale worktree needs `git worktree prune`. |
| A plain directory stays read-only | It is not inside a Git repository, so the plugin will not add it to long-term memory on its own. | `mem_admin(action="bind", mode="local")` to bind it explicitly. |
| Memory is silently absent for a session | Any non-`bound` resolution means "no memory for this session" — by design, it never throws and never guesses. | Check `mem_admin(action="projects")` and the pointer file. |

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

Contribution rules, house style and the non-negotiable constraints are in
[`AGENTS.md`](./AGENTS.md). The measured host facts live in
[`docs/p0-compatibility.md`](./docs/p0-compatibility.md).

---

## License

MIT — see [`LICENSE`](./LICENSE).
