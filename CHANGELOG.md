# Changelog

All notable changes to this plugin are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The package is not published to a registry. A release here is a git tag plus a
GitHub Release, so `0.1.0` below — dated 2026-09-23 — records the development
baseline that was never tagged, and every version from `0.1.1` on is a tagged
release artifact. The versioning policy is in the README, under Development.

## Unreleased

### Added

- **A bounded curation scan and the note-health rules the linter now shares**
  (work in progress; nothing user-visible changes yet — no config field, no new
  tool, no automatic pass). `lib/curation-scan.js` inspects one bound project
  under both a note-count and a wall-clock bound, resumes from a private cursor
  instead of recounting earlier notes, restarts when the path manifest moves under
  a running backfill, and reports a partial result as partial; it never writes a
  byte inside a vault. `lib/curation-state.js` owns that cursor, one rebuildable
  record per inspected path and the durable changed-path queue, all under
  `<dataRoot>/curation/` with `0700`/`0600` permissions and atomic renames.
  `lib/note-health.js` holds the overdue-review and dead-wikilink rules, and
  `lib/lint.js` now applies those instead of keeping its own copies, so a scan and
  a lint cannot disagree about one note. `lib/index-db.js` keeps exporting
  `SUPERSEDED_STATUSES` as an alias of the shared history list.
  **Continuing into Task 3:** `lib/curation-proposals.js` is the durable review
  queue for the candidates the plugin may not apply on its own — the supersede a
  distillation proposed, and the restatement a title lookup called a duplicate —
  stored one JSON document per proposal under `<dataRoot>/curation/proposals/` with
  the same `0700`/`0600`, atomic and size-bounded rules as the cursor, and with an
  identity derived from the project, the item (or the scan finding) and the source
  hashes, so replaying a candidate returns the same record instead of growing the
  queue. An identity that already exists with different content is refused with
  `proposal-conflict` rather than overwritten; two processes racing one identity
  have one winner (an exclusive create) and the loser re-reads it instead of
  clobbering it; and a state transition is the only thing there that takes the vault
  lock. A `near-duplicate`, `expired-review`, `dead-wikilink` or
  `missing-provenance` finding recorded from a scan carries **no** operation: it is
  a record to read, and a plan on such a kind is refused. In the apply path,
  `applyCandidate` classifies a risky item — a `supersedesId` that survived the
  ownership pre-check, or a twin from the duplicate lookup — *before* it creates
  anything: it parks the candidate whole through the new `propose` seam and returns
  `{review: true, proposalId, skipped: false}` with nothing written to the vault,
  and a `review` item is recorded in `appliedItems` and in the receipt **without** an
  index refresh, because no note exists for an index to look at. With no `propose`
  seam the call throws `propose-unavailable` and writes nothing: falling through to
  the old automatic supersede, or to the old silent `skipped`, would lose a
  validated candidate. Three files carry it:
  - `lib/curation-proposals.js` — the two executable kinds and the four review-only
    ones, `snapshotProposalSources` reading each source's exact bytes through the
    vault jail, and `recordCurationFindings` turning a scan's judgment-dependent
    findings into stable proposals. A finding edited between passes retires the
    record built from bytes that no longer exist and records the current one, and no
    source note is ever changed.
  - `lib/memory.js` — the `propose` seam on `normalizeDeps` (it can no longer import
    the store: both sit at L5 and that lateral edge is refused) plus the fail-closed
    gate above.
  - `lib/capture.js` (L6) — the real seam, which snapshots the evidence and calls
    `saveCurationProposal`. This is the only layer that may compose the two.
  Measured: `npm test` 809 tests / 808 pass / 1 skipped / 0 fail, and a test
  asserts every source-note hash is unchanged before and after every kind of pass.
  Untested: no scan currently emits a *suspected contradiction* finding, so the
  review-only path is exercised for the four kinds the scanner does produce and a
  contradiction would be recorded by the same code path without a case of its own.
  A pass that hits either bound reports `complete: false` even when the backfill
  behind it is finished, every note-supplied string an entry carries is bounded,
  and a record the private store refuses degrades that one note to `unexamined`
  instead of failing the pass. The scan's link resolver is applied to a wider set
  than the notes it inspects: every file of the bound project's tree plus the vault
  root's entries, so a link to a vault-root note, a vault-root `Makefile` or an
  extension-less file beside the linking note is not called dead. The narrower set
  plus its bare-basename rule makes the scan's dead-link findings a **subset** of
  the linter's — the scan never reports a link the linter resolved — and the one
  shape it stays silent about is a **partially qualified target whose basename
  matches a file anywhere in the project or the vault root** (`[[Docs/LICENSE]]`
  with no `Docs/LICENSE` but a `LICENSE` elsewhere), because the scan additionally
  accepts a bare basename; `lintVault`'s `filePaths` is every swept *file*, not a
  `.md`-only note set, so the bare `[[LICENSE]]` spelling is the same shape.
  A directory that either half of that universe cannot be enumerated in makes the
  resolver silent rather than guessing, and the pass now says so instead of
  certifying what it did not read: a `readdir` refused for anything but `ENOENT`
  reports an `enumeration-failed` state finding, sets `complete: false` and leaves
  the cursor where it was, and the resolver's own file list carries a
  `MAX_RESOLVER_FILES` count bound whose truncation makes every target undecidable
  (a `resolver-truncated` finding names it) rather than checking links against half
  a tree.
  Measured at the Task 2 fix round that landed this: `npm test` 810 tests / 809 pass
  / 1 skipped / 0 fail.
  Untested: the >50 000-note manifest bound, the >50 000-file resolver bound at its
  shipped value (the covering test lowers it through the `maxFiles` option) and the
  oversize branch of the record degradation (after the entry bound, a note whose
  frontmatter can be parsed cannot reach the 64 KB record bound; the same recovery
  path is exercised by an unwritable record). Known limitation: the wall-clock
  bound is now consulted after the manifest walk, so neither it nor `maxNotes`
  bounds the enumeration itself — pre-existing, and named rather than implied away.

### Fixed

- **The parked-candidate signal is no longer thrown away, and the retry barrier is
  pinned** (Task 3 review round). `review` was missing from the diagnostic codec's
  `distill` outcome set, so the one durable record of *why* a parked item produced
  no note was persisted as `other` — a green suite could not see it because the
  in-process ring carries the token fine and only the disk format coarsens it.
  `lib/diagnostic-codec.js` now lists it, a case loops the whole `distill`
  vocabulary through encode/decode, and a second case reads the token off the real
  ring after a parked pass. `parkRiskyCandidate` also accepted a seam that resolved
  *something* without an identity: `proposalId: null` went into `appliedItems` and
  the receipt and the item was then `continue`d past, so the job completed with the
  candidate recorded as parked and no durable record of it anywhere. A `propose`
  seam that answers without a non-empty string identity is now refused with
  `propose-failed`, the same code a refusing seam raises, which keeps the job
  `validated` and retryable instead of completing it on a lost candidate.
  Measured: `npm test` **809 tests / 808 pass / 1 skipped / 0 fail**; the
  round-trip case fails on the pre-fix codec with `review is not coarsened`, and the
  guard case fails with `Missing expected rejection: a seam answering undefined must
  throw`. The brief's mandated retry-barrier case is now pinned by
  `test/auto-capture.test.js` (a throwing `propose` seam through the real
  `processQueue`: `state: 'validated'`, `attempts: 1`, `lastError.code` of
  `propose-failed`, `nextAttemptAt` in the future, no receipt, byte-identical
  vault) — that behaviour already held, so the case is a regression guard rather
  than a fix, and it passes on the pre-fix code too.
  Untested: the guard is reached only through a caller-supplied seam, so the case
  drives a `writeMemory` wrapper with a throwing `propose` rather than a second
  production seam.

## 0.1.10 — 2026-09-29

### Changed

- **`docs/`, `research/` and `AGENTS.md` are local files now.** The repository
  ignores them and they left the index, so the public tree is the plugin, its tests,
  its gates and the two READMEs — not the maintainer's working material: the frozen
  specs and plans, the measured-fact records, the investigation output and the agent
  instructions. They stay on disk and in the history. A fresh clone has to keep
  passing, so two consequences are handled in the same change:
  `test/repo-hygiene.test.js` now checks the documents a checkout actually carries
  instead of requiring `AGENTS.md`, and the README pair no longer links to either
  path. The `docs/p0-compatibility.md` citations under `lib/` and `test/` still
  name the measurements they were written from, but that file is beside the checkout
  now rather than in it.
- **A run whose release is already published no longer reports itself as failed.**
  The marketplace step runs last, after the tag, the tarball and the GitHub Release
  exist, and it exited 1 when `MARKETPLACE_TOKEN` could not write the fork — so the
  notification for a *successful* release read "release: All jobs have failed". It
  probes the credential first (`--check-token`) and downgrades a refusal to a
  `::warning::` that names the permission to grant; nothing is swallowed, and the
  stale entry stays visible in the annotations. Measured on 2026-09-29: the
  marketplace PR pointed at v0.1.6 while v0.1.9 was published and tagged, and the
  local `gh` credential wrote the fork without complaint
  (`marketplace-entry: credentials can write bonerush/awesome-dsh-plugin`) — which is
  what identified the Actions secret, not the account, as the broken link.

## 0.1.9 — 2026-09-29

### Added

- **The graph panel's controls outlive the page now.** They were plain component
  state, and the sidebar is rebuilt from scratch on every load, so a reload — or a
  host restart — put scope, filters, colour groups, display and forces back at their
  built-in values. They are stored in this browser's `localStorage` under one
  versioned key (`dsh-obsidian-mem:graph-settings`), read through a new browser
  module served beside the renderer (`lib/graph-settings.js`) and written back only
  after that read lands: the first render still holds the built-in defaults, and
  saving those would erase the record. Storage is not trusted in either direction —
  every field is validated and falls back field by field, a record from another
  version is ignored rather than migrated, colour groups are bounded, and a storage
  that refuses to be read or written (a private window, a full quota) leaves a graph
  that works. The graph route stays read-only. The unit matrix covers the round trip,
  the per-field fallback, the version fence, the group bounds and both storage
  failures; `graph-route.test.js` now loads every module the client names by URL, so
  a name with no route fails the suite instead of 404-ing inside the panel.
- **A new asset needs one plugin remount, and the README now says so.** The route
  list is captured when the plugin mounts, so `/obsidian-mem/graph-settings.js`
  answered 404 on the live host while `graph-renderer.js` answered 200 from the same
  process — measured, not assumed. A reload is enough for a change to an asset that
  already has a route; a file that is new to the list needs the remount.

### Fixed

- **Two notes lit in the same second no longer disagree about the size of their
  titles.** While the graph was zoomed out, a lit label was drawn at
  `rootScale + (1 - rootScale) * weight`, so its size followed its own cue's weight:
  a `mem_search` hit keeps 0.6 of a read, so it stayed visibly smaller than the
  `mem_read` beside it, and the size moved under the reader as each cue faded in and
  out. The pin is now the frame's largest cue weight, which draws every lit label at
  one size at any instant while the fade stays in the alpha. The hovered label keeps
  app.js's own `1 / scale` pin, and a single cue behaves exactly as it did — the
  pre-existing release test still passes unchanged, and the new one fails on the old
  formula and passes on this one.

## 0.1.8 — 2026-09-29

### Added

- **The memory graph follows the agent's own file work now, not only `mem_read`.**
  A turn that wrote 24 notes, ran 10 admin actions and read the vault through the
  host's `read` tool lit nothing, because the activity feed had exactly two
  producers: a successful `mem_read` and an injected recall map. It now also cues a
  `mem_search`'s hits (the same accent at a lower weight — finding a note is weaker
  evidence of use than opening it), a `mem_write`/`mem_log` (the tag colour, so
  "this note changed" does not read as "this note was read"), and any host
  `read`/`edit`/`write`/`grep` whose arguments name one `.md` inside the vault.
  `bash`, `run_code` and `glob` are excluded deliberately: their arguments are
  command text, program text or a search root, and that one turn mentioned vault
  paths in 25 `bash` and 36 `run_code` calls without opening a note. The event
  shapes are measured in `docs/p0-compatibility.md` §12 — `tool/call` carries
  `arguments` as a JSON string and `tool/ptc-dispatch` as an object, and only the
  latter reports `isError`, which is why a failed nested call is skipped and an
  unparsable argument is simply not a cue. Pinned by tests for the pure mapping, the
  two new service cues, the widened `onAccess` seam, the hook forwarding and the
  cue kinds.

## 0.1.7 — 2026-09-29

  Watching that work on a live host caught one defect in it: the config keeps the
  vault root in its human `~/Documents/dsh-memory` form, and every other consumer
  expands it through the home seam, but the cue mapper compared absolute note paths
  against that literal `~` and matched nothing. The `mem_*` cues lit and host tool
  calls stayed dark, which is exactly what a session's activity ring showed. The
  root is expanded once at mount now, and an assembly-level test mounts the plugin,
  emits a `tool/ptc-dispatch` read and posts to the real graph route — it fails on
  the unexpanded root and passes on the expanded one.

### Fixed

- **A title ending in `.md` no longer produces a file with two extensions.** A MOC
  entry is the note's path minus one `.md`, so a note whose *title* already ends in
  `.md` used to land on disk as `X.md.md` while every link to it said `X.md` — a
  file that does not exist, in a link nobody can open, with nothing in the plugin
  able to repair it. `sanitizeStem` strips a trailing extension now (after
  truncation, before the final trim, case-insensitively, so `.MD` behaves too).
  Routing is pinned by a test that asserts the invariant instead of the string: a
  MOC line's target plus `.md` is the path the note actually has. Measured in a
  live vault before the fix: 6 notes across two projects and 7 MOC entries.

- **A wikilink inside code is no longer read as a link.** The dead-link scan ran
  its pattern over the whole body, so a note that *discusses* link syntax
  (`- [[target|alias]]` in prose about MOCs), quotes a shell test
  (`[[ "$x" == y ]]` in a workflow) or quotes the linter's own message was reported
  as linking to something that does not exist — 5 of the 6 findings left in a live
  vault were this, including one the linter wrote about itself. Fenced blocks (a
  fence of three or more backticks or tildes, closed by the same character at least
  as long, unclosed running to the end of the note) and code spans (a backtick run
  closed by a run of the same length) are blanked before the scan. One limit is
  deliberate and stated in the code: a span crossing a line break is not paired,
  because pairing across lines would let one stray backtick hide every link after
  it. The test drives a note carrying all four shapes — real links, a code span, a
  double-backtick span around a single one, a fenced block and a shell `[[` test —
  and reported 6 dead links before the fix, the 2 real ones after.

- **A failed marketplace step now says what is still true.** When it failed on the
  read-only token, the run went red at the last step and read like the release
  itself had failed — while the tag and its asset were already published and only
  the marketplace entry was behind. Both branches now wrap the call and emit an
  annotation naming that state and the fix. There is deliberately no
  `continue-on-error` and no summary step: a step that swallowed its own failure
  would leave the entry stale with nothing red to notice, which is the failure the
  whole job exists to prevent. Simulated with the read-only token: the script's
  own diagnosis, then the two annotations, then exit 1.

- **The marketplace step now learns about a read-only token before it does any
  work, and says what to grant.** The first real release through it failed at the
  very end — clone, edit, validate with the list's own tooling, commit, then a 403
  from `git push` reading `Permission … denied to <user>`, which sounds like the
  wrong account rather than a missing permission. A fine-grained token exposes no
  scope list to compare against (`X-OAuth-Scopes` is a classic-token header), so
  the script now probes `contents: write` with a draft release on the fork, before
  the clone, and names the two permissions to grant. `authHint` does the same for
  a push that fails anyway.

  Two defects were found while building the probe, both by running it: `gh api
  --raw-field` sends every value as a string, so `draft=true` reached the API as
  `"true"` and was refused with 422 (a boolean needs `--field`); and `DELETE
  /repos/{owner}/{repo}/releases/tags/{tag}` answers 404 for a *draft*, so the
  by-tag cleanup failed silently and left the probe release behind — it is deleted
  by id now, and the cleanup is attempted before the error is rethrown. That second
  one is pinned by an opt-in test (`MARKETPLACE_PROBE_LIVE=1`) that measures both
  the by-tag failure and the by-id success against the real fork, because a
  measurement of a live API is the only thing that can pin it.

## 0.1.6 — 2026-09-29

### Added

- **A release now points the marketplace entry at itself.** Both release branches
  call `scripts/marketplace-entry.mjs`, so the pull request that moves the
  entry's `tarball:` to the new tag appears on its own after a release — the entry
  pins a tag, so every release owes the curated list one line. The step needs a
  `MARKETPLACE_TOKEN` secret: the fine-grained token that may write the fork and
  open the pull request upstream, since this repository's own token cannot. The
  script uses two credentials deliberately — `GITHUB_TOKEN` to read this
  repository's releases and `MARKETPLACE_TOKEN` for everything on the listed
  repository — so the fine-grained token does not have to be scoped here too.
  When the secret is missing the step fails with a message naming the secret
  rather than surfacing `gh api`'s "Bad credentials", which names the symptom
  instead of the configuration.

- **`scripts/marketplace-entry.mjs` moves the marketplace entry's `tarball:` to a
  release.** The entry pins a tag, because `releases/latest/download/<file>`
  resolves `latest` per request but reads the filename literally, so a version in
  the asset name makes the link 404 on the next release — every release therefore
  owes the curated list one line. It runs on whatever credentials the caller
  already has (`GH_TOKEN`, or the token `gh auth token` reads from the local
  keyring), so the local path stores no secret at all. It looks up the fork and
  the PR before creating either, rewrites an existing PR on the same branch
  instead of opening a second one, and validates the entry with the listed
  repository's own `readEntries`/`validateEntries`/`tarballProblem` from a fresh
  clone. `setTarball` is pure and carries the tests: a non-GitHub host, a
  non-https URL, anything that is not a `.tgz`, and the `latest/download/` shape
  the marketplace accepts but which cannot survive a release.

## 0.1.5 — 2026-09-29

### Added

- **Every Release now carries the packed plugin as a `.tgz` asset.** The
  marketplace entry for this plugin can point a `tarball:` field at a pinned
  asset URL, which the storefront prefers over the build-from-source command —
  and unlike `github:bonerush/dsh-obsidian-mem`, it does not make a user approve
  a `prepare` script through pnpm's `allowBuilds` before anything installs. Both
  release branches pack with `npm pack --ignore-scripts` (the gate above has
  already run `prepack`, and the default would run the whole suite twice) and
  attach the archive: the bootstrap branch on `gh release create`, the bump
  branch on `create` or `upload --clobber` when the Release already exists.

  Verified by installing the packed archive into an isolated `DSH_HOME`:
  `dsh plugin --profile web add ./dsh-obsidian-mem-0.1.4.tgz` resolved five
  packages in 495 ms with no `allowBuilds` prompt, and the installed copy's
  `dsh-obsidian-mem-diagnose` wrote a report whose `package-files` check passes.
  `v0.1.4` carries the asset and the URL answers a ranged request with `206`,
  which is what the marketplace's own tarball probe asks for.

### Fixed

- **The release guard inlined the commit message into its shell script, so a
  multi-line message broke bash.** The step compared
  `"${{ github.event.head_commit.message }}"` against `chore(release):*`, which
  splices arbitrary commit text into the script: the body's newlines split the
  `[[ … ]]` test across lines and the run died with `conditional binary operator
  expected`, and its backticks were executed as command substitution first. The
  message now arrives through the environment (`COMMIT_MESSAGE`) and the script
  quotes a variable, which is the only shape that treats a commit body as data.
  Found by the failure itself: earlier commits had single-line subjects, so the
  bug first appeared on the release that was adding this file's own feature.

- **The harness peer range silently excluded a version this repository had
  measured.** node-semver only lets a prerelease satisfy a range when some
  comparator in the same set shares its exact `major.minor.patch` tuple *and*
  carries a prerelease tag, so `^0.1.5-rc.1 || ^0.2.0-rc.1` accepted
  `0.1.5-rc.2` and `0.2.0-rc.1` but excluded `0.1.7-rc.2` — one of the two
  versions the README lists as verified. Nothing failed loudly; a user on that
  version would have met an `ERESOLVE` and worked around it by hand. The range is
  now `^0.1.5-rc.1 || ^0.1.7-rc.1 || ^0.2.0-rc.1`, which opts in each measured
  tuple. `test/pack.test.js` asserts the rule rather than the string: for each
  measured version, it is satisfied or its tuple is one the range opts in, read
  out of the parsed range. Red first — the new case failed with
  `silently excludes 0.1.7-rc.2: no comparator opts in the 0.1.7 tuple`. It also
  needs `semver` as an exactly-pinned devDependency; the runtime dependency
  budget is unchanged at two.

## 0.1.4 — 2026-09-29

### Fixed

- **A release section could be inserted above a newer one, and nothing checked
  the order.** The workflow put each new section directly after `## Unreleased`,
  which is right only while releases ship in the order they are written. They did
  not: `v0.1.1` was tagged by hand after `v0.1.2` had been released, so the file
  read `0.1.3`, `0.1.1`, `0.1.2`, `0.1.0` — a sequence the numbers do not have,
  in the one file whose job is to describe them. `scripts/changelog-order.mjs` now
  owns both halves: the release cut places a section by version number instead of
  by position, and a check fails a disordered file. It runs in the fast staged
  gate, in CI as its own named step, and inside `test/repo-gates.test.js`, which
  also asserts this repository's own changelog is newest-first — so the defect
  cannot come back without a test failing. Verified red then green: the check
  refused the real disordered file, `--fix` reordered it to
  `0.1.3, 0.1.2, 0.1.1, 0.1.0`, and the same check then passed.

## 0.1.3 — 2026-09-29

### Fixed

- **The release workflow re-tagged an already-published version, and then would
  never have bumped again.** Two defects, both found by running it rather than by
  reading it. First: "does this version carry a tag?" was asked with
  `git rev-parse`, but a checkout fetches no tags, so after `v0.1.1` was published
  by hand the next run decided the version was untagged and died on `git tag` with
  exit 128. Second, and worse: the same branch then took over every subsequent
  push, so a repository whose declared version was already tagged would only
  re-tag it and never release the next patch. The check now asks
  `git ls-remote --tags origin` and is idempotent, the push is classified into one
  of two branches through an explicit result rather than an `if:` chain, and each
  branch owns its own Release. Verified against a throwaway bare remote: with the
  tag present remotely the run classifies as a bump (`resolved=false`), with the
  tag deleted it classifies as a bootstrap (`resolved=true`), and the bootstrap
  branch tags nothing when the tag is already there.

- **The first release out of the automated path skipped its own bootstrap.** The
  workflow only tags a version that carries no tag, and that step was written as
  the *else* of the guard that skips a release commit. On the very push that
  added the workflow there was no tag yet, so the guard and the bootstrap were
  mutually exclusive: `0.1.1` was declared and never tagged, and the push
  released `0.1.2` instead. `v0.1.1` was then tagged at the commit whose
  `package.json` says 0.1.1, so the number now names the content it always
  described, and this file lists 0.1.1 above 0.1.2 because that is the order the
  numbers run in. Both tags and both Releases exist.

## 0.1.2 — 2026-09-29

### Added

- **A push into `main` is a release, and the version now moves with it.** This
  repository publishes no npm package, so a release is a git tag plus a GitHub
  Release, and `.github/workflows/release.yml` mints both. The policy is
  documented under Development in the README: `0.0.1` per push, `0.1` for a
  notable feature, `1` for a breaking change — so the patch bump is mechanical
  and a major bump is a person editing `package.json` before the push.

  The workflow releases the version already declared when it carries no tag (that
  path produced the `v0.1.1` release), and otherwise verifies the tree with
  `npm run check`, refuses the push when `lib/` changed without a real
  `## Unreleased` entry, bumps the patch, moves the changelog section under the
  new number, updates `dsh.plugin.json` and the Codex server identity, commits as
  `chore(release): <version>`, tags, and publishes the Release from that
  changelog section.

  Two failure modes are designed out rather than discovered later: pushing with
  the default credential helper attributes the commit to `github-actions[bot]`,
  which suppresses `GITHUB_TOKEN` on the resulting push event, so the workflow
  would see "no tag for this version" on every run and bump forever — the remote
  URL carries the token instead; and a release commit has nothing left to
  release, because it moves every entry out of `## Unreleased`, so its own push
  is skipped after the bootstrap step that only tags.

  Honest limits: the skip guard matches the commit subject `chore(release):*`, so
  a person who writes exactly that subject for an unrelated commit would skip
  their own release; and a human push into `main` now fails unless the changelog
  entry lands with it. Neither has been exercised on a real GitHub runner yet —
  the inline steps were run against copies of `CHANGELOG.md`, `dsh.plugin.json`
  and `codex/server.mjs` for both the empty-section refusal and the successful
  cut, and the YAML parses clean, but the workflow itself has not run.

## 0.1.1 — 2026-09-29

### Changed

- **DSH 0.2.0-rc.1 is admitted by the plugin's host peer range.** The
  `@deepseek-ai/dsh-tools` peer now accepts `^0.1.5-rc.1 || ^0.2.0-rc.1`;
  the exact development fixtures move to tools `0.2.0-rc.1` and Cordis
  `4.0.4`. Before the change, the first-party compatibility checker rejected
  this plugin on `0.2.0-rc.1` because of its tools peer. After the change it
  accepts the measured `0.1.5-rc.2`, `0.1.7-rc.2` and `0.2.0-rc.1` lines.

  Verification on 2026-09-29, Node v25.9.0: `npm run check` passed all
  **735 tests**, lint, formatting, types, the pack verifier and the real archive
  contract (52 entries, 42 lib modules). `node codex/prepare.mjs --check`
  also passed. An isolated native Web host and the updated installed Web host
  both report the memory plugin as `enabled: true`, `fiberPhase: active`;
  the refreshed browser renders its memory graph. This update does not measure
  a new model turn, recall delivery or automatic distillation on the 0.2 line.
  The commands and evidence boundary are recorded in
  `docs/p0-compatibility.md` section 11.

- **Recall feedback now uses a finite focus cue.** A read note lights with a
  stationary soft halo, its incident edges sweep outward once, and its title
  releases opacity and pinned size over the final 600 ms of a 2.6-second cue.
  Neighbor nodes are not marked as read. The cue starts when the polling client
  receives the event, uses monotonic time, and does not replay on an unchanged
  model refresh. Reduced-motion preferences retain static emphasis without edge
  travel; the listener and event state are disposed with the renderer.

  Four renderer regressions failed against the previous implementation (15 pass,
  4 fail) and pass with the new one (19 pass, 0 fail). The browser-module route
  regression also failed on the new helper's missing route before it was added;
  focused renderer, client, route, architecture and package checks then passed
  all 51 tests. The recall helper is a separate browser leaf within its 200-line
  budget, keeping the renderer within 700 lines; the package and archive contracts
  require both the helper and palette. Design references and motion timings are
  recorded in `docs/obsidian-graph-source.md`.

  Final verification on 2026-09-29: `npm run check` passed all **734 tests**,
  lint, formatting, the configured type ratchet and both package contracts
  (52 archive entries, 42 lib modules). The in-app browser loaded the shipped
  renderer through the registered routes with 12 temporary notes and the real
  `mem_read` service/activity path: single/continuous reads, expiry, sidebar
  resize and the reduced-motion preference control were checked without console
  warnings or errors. The restarted native host served renderer, palette and
  recall-helper bytes matching source. Measurements and limits are in
  `research/graph-recall-verification-2026-09-29.json`.

### Fixed

- **The distillation prompt now names the item-count ceiling it will be refused
  for exceeding.** The validator refuses a whole batch larger than
  `distill.maxItems` (`too-many-items`), but the system prompt never said how many
  items were allowed: it interpolated the `type`/`assertion`/`status`
  vocabularies and nothing else. A real job returned 21 well-formed items against
  a ceiling of 16, passed every other check, and spent all three attempts on that
  one refusal. `SYSTEM_PROMPT` now reserves a `maxItems` slot and the new
  `distillerPrompt(settings)` substitutes the configured number at the call site,
  so the prompt cannot carry a ceiling the validator does not apply.

  Red first: the new case
  `the system prompt names the item-count ceiling the validator refuses to exceed`
  reads the ceiling back out of the refusal message
  (`beyond distill.maxItems=N`), asserts the prompt actually sent names `N`, and
  asserts the unsubstituted slot never reaches the model. It failed on the old
  code with `the prompt never names the item-count ceiling 3`, and the existing
  request-shape case now also pins `at most 12 items` with `maxItems` absent from
  the sent text. `test/distill.test.js` is 64/64. The file's size budget is
  registered as 950 → 975 in `test/architecture.test.js` with the reason: a
  configurable ceiling cannot be a literal in a module constant.

  Verified live on 2026-09-29, not only in tests: the ceiling was raised to 21 in
  the profile patch, the plugin row hot-reloaded (a fresh `skill` event opened a
  new diagnostics run), and `mem_admin(action="jobs", jobId="…", retry=true)`
  settled `job-95018bdb…` — the job that had been terminally `failed` since
  09-27 — as `result: applied`, **21 items applied, 0 refused, `index:
  refreshed`, in 14 ms with no model call**, because a `raw-durable` retry
  re-validates the stored text. The vault gained exactly those 21 notes
  (341 → 362 in-project `.md`, `_meta/log.md` 4987 → 5197 lines) and the index
  absorbed them (488 → 517 `notes_fts` rows). The profile patch keeps the raised
  value with the incident recorded inline.

- **The graph's browser module chain now loads through the host routes.** The
  renderer imports `graph-palette.js`, but the default asset routes omitted that
  file, producing a 404 and a blank graph after refresh. The route now serves it;
  a regression fetches the renderer and its imports through the real registered
  handlers, including the same-origin fence. It failed on that 404 before the
  change and passes afterwards. The earlier resize fixture manually supplied the
  palette and did not cover this failure; it now uses the real plugin routes.
  After reloading the local web host, Chrome rendered 495 nodes and the label-size
  control showed 0.85. The final `npm run check` passed all 730 tests and package
  checks. Measurements are in `research/graph-loading-label-verification-2026-09-28.json`.

- **Zoomed labels retain enough pixels for the current screen.** Their cached
  raster resolution now increases in powers of two with zoom and device pixel
  ratio instead of stretching a fixed resolution-2 image. Labels reuse the
  sharper cache within a tier; existing text stays visible while the per-frame
  raster budget fills. The font default is now **0.85**, as requested, in both
  the panel and renderer fallback. Default-size, zoom-resolution and denser-screen
  regressions failed before the change and pass afterwards; hover, recall and
  square-root scaling regressions also pass.

- **Resizing the graph sidebar no longer exposes a cleared Canvas frame.**
  Resize notifications now schedule drawing; bitmap dimensions change inside
  that drawing callback, and unchanged dimensions are not assigned again.
  Two renderer regressions failed before the fix and passed after it. In an
  isolated browser page using the shipped client and Worker with 240 generated
  nodes, 48 consecutive width changes left the bitmap blank after all 48 resize
  callbacks before the fix and after none of them afterwards.

  The reported constant-size large node was not reproduced in this fixture:
  large and small nodes both shrank to about 0.667 of their initial radius and
  grew to about 1.487, matching Obsidian's square-root zoom rule within its 1%
  interpolation tolerance. A regression now covers a hub whose base radius
  reaches the 30-unit cap, including zooming beyond that base cap. This does not
  establish what caused the user's original large-node symptom.

### Added

- **A called memory shows which file it was.** Its label stays visible during the
  cue even when ambient labels are hidden, and the canvas caption lists up to
  three file names. Verified with the shipped renderer in a Node harness at
  reduced zoom (`test/graph-renderer.test.js`); the finite release described above
  replaces the original pulse-ring and moving-particle presentation.

- **A memory graph tab for DSH's native right sidebar via Better Sidebar.**
  The browser view resolves Obsidian's colour slots from the host theme, draws internal Markdown and wiki links, supports
  project/all scopes, and briefly pulses notes and branches used by `mem_read`
  or an injected relevant-note map. The host route is read-only and local
  same-origin; activity is bounded and process-local. SQLite and scan graph
  projections, route fencing, activity, and tab registration have automated
  tests. The view follows the installed Obsidian 1.13.7 core graph's controls,
  renderer rules and D3 fallback force model, with the core default palette;
  the extracted-source hashes and adaptation boundaries are recorded in
  `docs/obsidian-graph-source.md`. Pinned D3 browser assets and their ISC
  notices ship locally, with a read-only freshness check in the suite.

  On 2026-09-28 the installed DSH web profile rendered 461 nodes in Chrome;
  `[type:decision]` filtering left 109 nodes, and reset restored 461 nodes and
  the original slider defaults. An isolated seven-note temporary vault ran
  the real registered `mem_read` tool through the service, activity route and
  browser view: its connected branch showed particles and the node showed
  an expanding ring, then returned to idle. This does not verify a live LLM
  choosing that tool or the recall animation during a live agent turn.
  Canvas 2D replaces Obsidian's Pixi/WASM renderer; the graph is capped at
  500 nodes, and attachment filtering is disabled.

  A second comparison found omitted administrative bridges and historical
  notes, plus differences in relative links, YAML links, escaped table aliases,
  bracketed aliases, literal backticks in filenames and repeated `.md`
  extensions. The graph now includes those relationships and uncreated targets
  while administrative notes remain outside recall; the existing-files-only
  filter works. Parser-version migration refreshes cached links even when the
  notes themselves have not changed. After a restart, Chrome's rendered graph
  and Obsidian's runtime metadata agreed on 478 nodes, 503 directed edges and
  component sizes of 471 plus seven isolates; their sorted edge-set SHA-256
  hashes matched. These figures cover the current Markdown vault with tags and
  attachments excluded, not every possible Obsidian search or attachment mode.

  The initial label port followed `xQ.getDisplayText/getTextStyle` and the installed Pixi
  text cache: file basenames, the full font fallback chain, natural glyph
  widths, word wrapping and resolution 2. Six Chinese/English samples at
  three node font sizes matched the original `PIXI.Text` cache pixel for
  pixel in Chrome. The higher-resolution zoom cache described above intentionally
  extends this initial resolution-2 behaviour. The renderer caches labels through zoom, culls offscreen
  geometry, batches equal-style links and stops after 60 idle frames;
  interaction and memory activity wake it. Source-matched wheel scaling
  includes `deltaMode` conversion. Regression cases failed before their
  fixes and passed afterwards; detailed browser measurements and their
  limits are recorded in `docs/obsidian-graph-source.md`.

  Clicks no longer leave a permanent label highlight. Ordinary labels resume
  Obsidian's square-root zoom scaling after the pointer leaves; only hover and
  drag retain the original minimum text size below scale 1. The click/unhover
  regression failed before the change and passed afterwards. Measuring the
  installed browser canvas gave a 0.8166 shrink ratio and a 1.4871 enlargement
  ratio, within the renderer's 1% zoom stopping tolerance of the source rules.

  At the user's subsequent request, the initial type-colour groups were removed
  and the Wasp palette was replaced with Obsidian's core `app.css` defaults for
  both light and dark modes: neutral nodes and lines, purple hover/recall cues,
  and faint uncreated targets. Custom colour groups remain available. The
  renderer, browser registration and route tests passed after this change.

- **The diagnostic report is available as an npm command.** Run
  `dsh-obsidian-mem-diagnose --output <file.json>`, inspect the JSON, and attach
  it manually to an Issue. The package and real-archive checks require the CLI
  entry. The report has a 256 KiB ceiling and never uploads itself. The full
  local gate passed.

  The packed command has now been exercised three ways. An offline installation
  of the real tarball by itself ran its npm binary and produced a private JSON
  report with `package-files: pass`, while `plugin-smoke` stayed `unavailable`:
  that install has no optional DSH host peers, and the check reports the missing
  evidence instead of a pass. Installing the same tarball with
  `@deepseek-ai/dsh-tools` and `@deepseek-ai/cordis` present turned that one
  check into `plugin-smoke: pass`. A real host session then closed the loop: in
  a throwaway `DSH_HOME` on Node v25.9.0 with DSH `0.1.7-rc.2`, the tarball's
  installed package was mounted with `link:` in a `headless` profile and one
  real session ran against a throwaway vault. The host wrote
  `data/obsidian-mem/diagnostics/<uuid>.jsonl` — directory `0700`, run file
  `0600`, a header carrying the config summary and three events
  (`skill: synced`, `brief: hint-only`, `capture: skipped-unbound`) whose only
  fields are `seq`, `at`, `event` and `outcome`. Reading that home back with the
  packed command gave `data-root: pass`, `diagnostic-journal: pass` and
  `plugin-smoke: pass`, with three events in the window and nothing dropped,
  corrupt or expired. That session ran with `autoCapture: false`, so it created
  no queue directory and `pending-files` stayed `unavailable` rather than
  reporting a count.

  The installed path was then exercised for real on the machine that wrote this
  change: after a restart, the host that mounts this checkout with `link:` under
  the default `~/.dsh` home reported all seven checks `pass` — `data-root`,
  `diagnostic-journal` and `pending-files` (`count: 0`) included — over the four
  events that session wrote (`skill: unchanged`, `recall: below-floor` with 8
  hits, `brief: injected`, `brief: none`). Those four are exactly what the
  in-process `mem_admin(action="diagnostics")` ring answered for the same
  session, which is the one record with two views the design asks for. The Codex
  entry's journal is still covered by tests only; no live Codex session has
  exercised it.

- **A closed disk format for future user diagnostic reports.**
  `lib/diagnostic-codec.js` projects the existing in-process events into reviewed
  outcomes, coarse error codes, counts and per-run identifier aliases. Tests
  verify that conversation-like fields, paths and original IDs are absent from
  the serialized result.

- **A bounded local diagnostic journal is available for the host entries.**
  Run files use private permissions, keep at most 200 events, and expire after
  seven days of inactivity. Reader tests cover corrupt records, symlink
  substitution, concurrent processes and the latest config summary.

- **Both host entries now write their content-free decisions into the journal.**
  DSH constructs it only for an enabled plugin; Codex uses its existing data
  root. A failed journal open or append leaves the in-process diagnostic ring
  and the original tool outcome intact. Host-seam tests use temporary homes and
  confirm the vault and pending queue are untouched by journal startup.

- **A standalone JSON report command and isolated self-check are implemented.**
  The command accepts an explicit output path, refuses an existing destination,
  creates a private JSON file, and maps plugin smoke failures to fixed codes
  while still reporting Node, FTS5, package, journal and queue metadata.
  Tests confirm that an unreadable conversation-like queue file is counted
  without parsing its content.

- **Recall now answers "did it fire?" through `mem_admin(action="diagnostics")`.**
  A new `recall` event records one decision per user turn — `fired`,
  `no-query`, `no-hits`, `below-floor`, `all-seen`, `budget`, `aborted` or
  `search-failed` — with the hit count and the injected size in code points.
  `promptRecall` returns that decision instead of `null`, so both adapters can
  record it; the Codex adapter and every caller check `text !== null` now.

  This closes a hole measured live: on a real session the diagnostics showed one
  `brief injected` line and nothing about retrieval, because `brief` is recorded
  whenever the *brief* is injected whatever the map did — the answer was only
  recoverable by parsing the session transcript. `test/debug.test.js` pins the new
  event and its two count fields to the same content-free allowlist as the rest:
  a prompt and a path pushed alongside them still never reach the ring.

- **Per-turn recall has its own ceiling, `recallBudgetChars` (default 900).**
  Retrieval used to spend whatever the one-shot session brief left of
  `briefBudgetChars`, which starved exactly the first turn — see *Changed* below
  for the measurement. The two injections are now bounded separately, so one step
  carries at most `briefBudgetChars + recallBudgetChars`. The range check is
  256–20000, the same as the brief's.

- **Prompt-scoped recall now runs in DSH and Codex.** Both adapters use
  `lib/prompt-recall.js` and the existing project-scoped search service. A new
  user prompt can receive up to three strongly matching note paths and titles
  within 360 Unicode characters; note bodies require an explicit `mem_read`.
  Directory indexes, weak matches and paths already offered in the session are
  skipped. DSH invokes the policy from `agent/pre-step` for a real user message
  and spends only the remaining `briefBudgetChars`; Codex adds a
  `UserPromptSubmit` command hook. Its per-session shown-path file lives under
  the data root, contains only relative paths, and is bounded to 64 entries.
  Both adapters fail open. Codex still has no automatic distillation or write.

  Red tests first failed for the absent shared module, DSH map, and Codex hook;
  the targeted suites now pass with a real temporary vault and hook subprocess.
  In an isolated `CODEX_HOME`, codex-cli 0.146.0's `hooks/list` discovered both
  hooks with their intended event names, commands and 15-second timeouts, with
  no warnings or errors. The new hook's delivery to a live model has not yet
  been verified.

- **The Codex side injects the recall brief at session start now, exactly as DSH
  does.** `codex/session-start.mjs` is a `SessionStart` hook: Codex hands it the
  session as JSON on stdin and adds what it answers with —
  `hookSpecificOutput.additionalContext` — to the conversation before the first
  model call. It composes no text of its own: what it injects is `brief.text` from
  `lib/brief.js`, the same field the DSH pre-step injects, so the two harnesses
  still share one memory layer and one brief. This closes the hole a tool cannot
  fill — a session where nothing calls `mem_brief` used to recall nothing — and it
  is the reason `codex/README.md` no longer says "nothing is automatic". It does
  not make distillation portable; MCP still has no turn boundary, so a note is
  still written when the agent decides to write one.

  The one decision the hook owns is which session starts are worth paying for, and
  it lives in `decide()` where a test can read it: `startup` and `clear` inject,
  `resume` and `compact` do not, because both continue a conversation that already
  carries the earlier injection or its summary. A directory with no `.obsidian-mem`
  pointer injects nothing, and that is not a refusal — it is most directories on any
  machine, and the session starts as if the plugin were not installed.

  Five facts about the contract were measured against codex-cli 0.146.0 rather than
  read off a specification, and three of them changed the implementation:
  a plugin's hooks live at `<plugin>/hooks/hooks.json`, while a manifest may **not**
  declare them — the plugin-authoring spec the same binary carries says validation
  "rejects unsupported manifest fields such as `hooks`"; this event's `matcher`
  matches the session's `source`, not a tool name, so a matcher would be a second
  place to state the rule above and is left as `"*"`; `timeout` is in seconds and is
  15 of them, so a vault that hangs costs a session fifteen seconds and then is
  dropped, never its start; the output is schema-validated, and anything but one
  `session-start.command.output` document is discarded with "hook returned invalid
  session start JSON output"; and a hook is **untrusted until the client records a
  trust hash for it** — an untrusted hook is skipped in silence, with no error and
  no context.

  That last one is the install step a reader would otherwise miss, so it is a
  numbered step in `codex/README.md` rather than a footnote, and both directions
  are measured instead of described: with the hook trusted, a session start under a
  fresh `DSH_HOME` leaves behind the index the hook built; without it, the same
  directory stays empty. The injected brief then appears in the session's own
  rollout as a `developer` message — Codex's role for hook context, where DSH uses
  a `user` message with a plugin source. Same text, each harness's own convention.
  `codex --dangerously-bypass-hook-trust` skips the review for automation that
  already vets what it runs, and Codex says so in a visible item when it is used.

  **The hook cannot break a session.** Every path writes one JSON object and exits
  0 — unreadable stdin, junk that is not JSON, an unbound directory, a vault that
  refuses to open — and reasons go to stderr, where they cannot be mistaken for
  protocol, under `OBSIDIAN_MEM_HOOK_DEBUG=1` or on an actual failure.
  `test/codex-hooks.test.js` drives the real script as a process through a real
  `SessionStart` payload and a throwaway home, data root, vault and repository:
  seven cases, including a negative control that only means something because the
  repository is bound *before* it — against an unbound directory every source looks
  identical and the control proves nothing. Two deliberate regressions were run to
  see the tests fail: adding `resume` to `INJECT_SOURCES` fails the decision case
  and the vault-opening control, and one stray write to stdout fails three
  process-level cases.

  `codex/prepare.mjs` generates `hooks/hooks.json` beside `.mcp.json`, with this
  checkout's absolute path for the same reason: Codex copies the plugin into
  `~/.codex/plugins/cache/…`, so a relative path would resolve inside that copy.
  Both generated files are git-ignored, both are checked by `prepare.mjs --check`,
  and `codex/session-start.mjs` joins `codex/server.mjs` in the opt-in type ratchet.

  **What is still not verified: that a live Codex turn acts on the injected
  context.** Every link up to it is proven with the real binary — discovery, the
  trust gate, execution, and the brief's arrival in the session — but a turn needs
  a model this account can run, and this machine's Codex CLI rejects both the
  configured `gpt-6-sol` and `gpt-5-codex` with `not supported when using Codex
  with a ChatGPT account` before a tool is ever reached. That is the same wall the
  MCP tools have been behind since they shipped, and it is why this entry claims
  injection and not usefulness.

- **`AGENTS.md` now opens with two tables instead of a list of commands to
  remember.** The first says when to run what — `check:fast` before a commit,
  `check` before a push, `prepack` for a release, `hooks:install` once and only
  if you want it — and what each one actually runs, so the five-command manual
  sequence is gone. The second is "where the truth lives": ten symptoms mapped to
  the file, test or tool call that answers them, including the two that cost the
  most time to rediscover — a copied checkout failing `codex-mcp` because the
  generated `.mcp.json` holds absolute paths, and anything touching sessions or
  injection timing starting from `docs/p0-compatibility.md` rather than a comment
  in `lib/`. The house style now states the dependency split explicitly: two
  runtime dependencies, everything else a pinned devDependency.

  The `tools.js` budget was raised from 1,950 to 2,050 lines to land the new
  schema, which is the fitness function asking for a decision rather than a
  failure: the raise is registered in the table with the reason and flagged as
  temporary, because the split that follows is what replaces it with a façade.

- **`mem_admin(action="diagnostics")` answers "why did that happen?" without a
  reproduction.** `lib/debug.js` is a bounded ring — 200 events — that records
  decisions from a closed set of categories and a closed set of scalar fields,
  and `lib/index.js` hands one instance to both the services and the hooks so a
  single call answers for the whole plugin. It reads no vault and needs no
  binding, so it still answers when every other action refuses, which is usually
  exactly when it is wanted; and it empties when the process exits, so `jobs` and
  the receipts remain the only things to trust across a restart.
  The privacy boundary is enforced at the door rather than documented and hoped
  for: field names are an allowlist, values are shape-checked, and a note body, a
  title, a path or a prompt is dropped before it can be stored. The test feeds a
  sentinel body through a real call site and requires it to be absent from the
  serialised snapshot, so a future "just one more field, it will help debugging"
  change fails a test instead of shipping. Nothing in the channel can change an
  outcome either — a throwing logger, a throwing clock and a broken injected seam
  are all tested to leave the caller's result untouched.
  **All eight categories emit.** `brief` (injected, hint-only or none — the case
  a developer cannot see any other way) and `bind` refusals came first; this round
  added the five that were accepted by the ring and by the closed output schema
  but had no call sites: `capture`, `distill`, `index`, `job` and `transaction`.

  `capture` is the one that needed a new seam rather than a new call.
  `enqueueTurn` returned a bare `null` from ten different conditions —
  `autoCapture: false`, a turn that is not a completed root turn end, a missing
  session or project id, a projection with no user message, a turn the durable
  floor already covers — so "a turn ended and nothing was captured" was one
  indistinguishable outcome. It now takes an advisory `onSkip(reason)` sink and
  names each one; the sink is called through a catch, so a broken one still
  returns the pre-existing `null` and the capture is enqueued anyway, which is
  asserted rather than assumed. `distill` records whether the model produced
  nothing (`no-memory`), the run was a `dry-run`, or items were `applied`, with
  the bounded duration; `job` records `completed`, `failed`, `retry`, `deferred`
  with `no-binding`, and the three retry outcomes of the `jobs` action; `index`
  records `open-failed` (the refusal `indexFor` used to swallow), a per-item
  `refresh-failed` with its code, and the pass's `refreshed`/`none` summary;
  `transaction` records the `txId` of a committed write or a coded refusal.

  What reaches the ring is unchanged and is still the point: one wrapper around
  the three write paths records only `txId`/`code`/`projectId`, so a refusal that
  names the note it refused still does not put the note in the window. The new
  tests inject `SENTINEL-BODY-<uuid>` through real capture, distillation and write
  paths and require it to be absent from the serialised snapshot.
  `DSH_OBSIDIAN_MEM_DEBUG=1` also emits each event through the host logger, at
  `info` rather than `debug` on measurement: the host's exporter uses
  `levels: { default: 2 }` and drops anything above the threshold, so `debug` would
  be asking for a channel that is known to be closed. Unset, the plugin's logging
  surface is byte-for-byte what it was. The DSH side and the Codex MCP server each
  hold their own instance, so the tool always describes the process the caller is
  talking to; the Codex sink writes to stderr and only under the same flag.

- **CI runs the same gate a contributor runs, on three Node versions.** A check
  that exists only in CI is one that passes locally and fails on push, so
  `.github/workflows/ci.yml` runs `npm ci` and then `npm run check` — the identical
  command — across `22.22.2`, `24.x` and `node`. The floor is listed first on
  purpose: `engines.node` claims 22.22.2 is the lowest version with `node:sqlite`
  and FTS5, and an unmeasured floor is a claim rather than a fact. The only steps
  CI adds are the two things a local run cannot supply: the Unreleased gate's
  comparison base and the matrix. There are no secrets, because `npm test` needs
  none, and `permissions: contents: read` is the whole token surface.
  The base is chosen by `scripts/ci-base.mjs` rather than by shell inside the
  workflow, so the one piece of interesting logic is also the one piece with tests:
  a pull request's base commit wins, then a push's previous head, then the merge
  base against the default branch. An all-zero `before` — GitHub's way of saying
  the ref is new — is skipped rather than compared against; a base that is not a
  commit in the clone, or that *is* `HEAD`, exits 1 with the reason instead of
  handing the gate an empty diff to pass. `test/repo-gates.test.js` pins the
  workflow's shape too: the matrix entries, `npm ci` before `npm run check`,
  `fetch-depth: 0` (without it the base commit is not in the clone), and the
  read-only permission.

- **Three rules that were prose now run before a commit.** `npm run check:fast`,
  wired into `.githooks/pre-commit` by the opt-in `npm run hooks:install`, checks
  the *index* rather than the working tree: sources come from `git show :<path>`
  and go into `eslint --stdin` and `prettier --check --stdin-filepath`, both
  pointed at this repository's configs explicitly so a checkout without its own
  config is judged by the same rules. That distinction is the point — with a
  worktree check, `git add -p` lets a commit carry a file whose staged copy fails
  while the check reports green. The two fitness tests still read the worktree, so
  the script refuses rather than guess when any of their inputs has both a staged
  and an unstaged edit. Measured: 1.02 s to reject a staged `lib/` change with no
  changelog entry, 1.47 s to accept one with it, both well inside the five-second
  target the design set.
  `scripts/verify-changelog.mjs` is the Unreleased gate in two modes —
  `--staged` against `HEAD`, `--base <ref>` for CI — and it deliberately stays out
  of `npm run check`, because a check with no comparison base passes vacuously and
  a green that means nothing is worse than no check. A change under `lib/` needs an
  added or amended `## Unreleased` body; an edit to an already-released section does
  not count, and a fix left in the working tree cannot satisfy a staged check.
  A missing ref is an error (exit 2), never an empty success.
  `scripts/install-hooks.mjs` is the only thing in this repository that changes git
  configuration, it must be asked for by name, and it prints `core.hooksPath`
  before and after. `test/repo-gates.test.js` exercises all of it in disposable
  repositories — nine cases, including both directions of the staged-versus-worktree
  distinction — and never touches this checkout's git config.

- **The release gate checks the archive npm really builds, not a frozen count.**
  `scripts/verify-tarball.mjs` (`npm run pack:check`) packs this checkout into a
  temporary directory with `npm pack --json --ignore-scripts` — the flag is
  mandatory, since a bare `npm pack` re-enters `prepack` and would run the suite
  from inside a pack — lists the real `.tgz` and cross-checks the listing against
  npm's own file list. It requires every extant `lib/**/*.js`, the ten mandatory
  assets including both READMEs and `README.i18n.yaml`, and refuses anything from
  `test/`, `docs/`, `research/`, `scratch/` or a vault's `_meta/`, plus any
  `pending/`, `locks/`, `transactions/`, `.jsonl`, `.lock` or probe artefact.
  The design's earlier "33 files" assertion is gone on purpose: it would have
  turned the `tools.js` split into a red build for a change that is supposed to
  add modules. `test/pack.test.js` pins the failure modes against synthetic
  listings — a missing asset, a module on disk that did not ship, a packed
  development tree, a packed vault path — and runs the verifier against this
  checkout once, so the report cannot rot into a comment.

- **The module graph and the repository's own conventions are now tests.** `test/architecture.test.js`
  builds the `lib/` import graph from the TypeScript AST — not a regular
  expression, which is how the first measurement of this graph missed
  `export ... from` and side-effect imports — and fails on a cycle, on an edge
  that points upward *or* sideways between the ten reviewed layers, on a module
  with no declared layer, on a relative import that resolves to nothing, and on a
  file past its approved size. The layer table and the size budgets are a
  reviewed snapshot, so a new module or a grown file becomes a decision someone
  makes rather than a drift nobody sees; `lib/tools.js` and the three files that
  replace it in the split are the first entries to be re-registered under it.
  `test/repo-hygiene.test.js` adds the two conventions that were prose until now:
  `README.i18n.yaml`'s recorded blob hashes must match both READMEs, computed
  from bytes with `node:crypto` so CI and a bare checkout agree, and every
  `npm run` command named in `AGENTS.md` or either README must exist in
  `package.json`. Both were shown to fail — a stale hash record and a documented
  command that does not exist each turn exactly one assertion red — and the
  structural checks were shown to fail four ways: an upward edge, a lateral edge,
  a new module, and a file padded past its budget.

- **Twelve source files are type-checked, and the set can only grow.** `npm run
  types` runs `tsc --noEmit` over an explicit `files` list with
  `checkJs: false`, so each file opts in with a `// @ts-check` marker. The
  mechanism is not a style preference: a checked root file pulls its imports into
  the program, and with `checkJs: true` TypeScript reports on those imports too.
  Measured on a two-file fixture — `checkJs: true` + `files: ['root.js']` reports
  the imported `child.js`; `checkJs: false` with the marker only in the root does
  not; move the marker and the reporting follows it. So `files` is a root list, not
  a boundary, and the marker is the switch.
  The initial twelve were chosen by measuring each candidate alone: nine report
  **zero** diagnostics (`lib/git.js`, `lib/index.js`, `lib/naming.js`,
  `lib/paths.js`, `lib/pointer.js`, `lib/receipts.js`, `lib/registry.js`,
  `lib/routing.js`, `scripts/verify-pack.mjs`) and three report one each, now
  fixed: a `null`-narrowed memo in `codex/server.mjs` whose declared type was
  restored (`TS18047`), an `options = {}` default that contradicted a required
  JSDoc field in `lib/search.js` (`TS2741`), and a signal name typed as `string`
  where `child.kill` wants `Signals` in `scripts/run-tests.mjs` (`TS2345`).
  `skipLibCheck: true` is part of the configuration and is load-bearing: without
  it those same files report `TS2307` and `TS6200` from inside
  `@deepseek-ai/dsh-llm`'s own declarations, which is a conflict between
  third-party types rather than anything in this repository.
  `test/repo-hygiene.test.js` asserts the marked set and the `files` list are equal
  in both directions — a marker outside the program would be silently unchecked —
  and that no shebang has been pushed off line 1, which is what a marker written
  above one does. Both were proven able to fail: dropping a marker, marking an
  unlisted file, and moving a marker above a shebang each turn exactly one
  assertion red.

- **The memory layer now runs under Codex CLI, through an MCP server that reuses
  `lib/` instead of copying it.** `codex/server.mjs` speaks MCP on stdio and
  dispatches the same six operations the DSH tools expose —
  `mem_search`/`mem_read`/`mem_write`/`mem_log`/`mem_brief`/`mem_admin` — to the
  same `createMemoryServices()`; the argument schemas are derived from
  `TOOL_PARAMETERS` and the names from `TOOL_NAMES`, so the two surfaces cannot
  drift apart. A local marketplace (`codex/marketplace/`) ships a Codex edition of
  the skill plus the generated `.mcp.json`, installed with
  `codex plugin marketplace add` and `codex plugin add`; `codex/README.md`
  documents the lighter `codex mcp add` variant. **What does not carry over is
  stated rather than implied**: there is no distillation of finished turns and no
  recall injection, because MCP offers tools and not turn boundaries. Measured end
  to end in `test/codex-mcp.test.js` (6 cases): a real stdio handshake, a write and
  a search against a throwaway vault, plus the one seam that would otherwise bind
  the wrong project — the working directory comes from the client's `roots/list`,
  not from the plugin directory Codex launches the server in. That seam also
  produced the bug the test now pins: awaiting the `roots/list` answer inside the
  `initialize` handler deadlocks the serialised message queue, because the answer
  is itself a queued message.
- **The package now declares itself the way the ecosystem does.** `package.json`
  gains `keywords`, `repository`, `homepage`, `bugs` and `engines.dsh` — the
  position the plugin market reads. The GitHub repository carries the
  `dsh-plugin` topic that the harness's own plugin search queries. The install
  instructions lead with the ecosystem's `github:bonerush/dsh-obsidian-mem` spec
  instead of a local checkout. Nothing about the plugin's runtime behaviour
  changed; `engines.node` is untouched.
  Measured end to end against the published repository: in a throwaway
  `DSH_HOME`, `dsh plugin --profile memcheck add
  github:bonerush/dsh-obsidian-mem` resolves to
  `dsh-obsidian-mem github:bonerush/dsh-obsidian-mem` and `--dump-config` then
  prints the `obsidian-mem` row.
- **`README.zh.md`, a Chinese README that carries equal authority with the
  English one.** It follows the convention the first-party packages use:
  the `[English](README.md) | 中文` switcher, an explicit `<a id="…">` for every
  heading a link targets so one anchor resolves from either language, and
  `README.i18n.yaml` recording the git blob hash of each side as of the last
  confirmed-consistent state. Measured in one installed harness: of 240 packages
  under `@deepseek-ai/`, the 231 that ship a README ship all three files, and the
  eight English-only ones are vendored upstream packages (`cordis`,
  `schemastery`, `cosmokit`, `cordis-plugin-*`). The translation is not reviewed
  by a native reader; that stays listed in the untested inventory at the end of
  this file.
- **The repository is public at
  <https://github.com/bonerush/dsh-obsidian-mem>.** This is the project's remote;
  `main` is the published history. It remains unpublished to npm and untagged.

### Changed

- **The graph now takes its colours from the host theme through Obsidian's own
  slots.** The renderer resolves the eleven `.graph-view.color-*` values from the
  computed style of hidden probes, exactly as Obsidian's `testCSS` does, and the
  browser half binds Obsidian's `--graph-*` variables to this host's
  `--dsw-alias-*` tokens. A theme switch therefore repaints the graph with no other
  change. Measured in Chrome on 2026-09-28: dark resolves nodes `rgb(179,179,179)`,
  text `rgb(218,218,218)` and lines `rgb(67,69,74)`; light resolves nodes
  `rgb(92,92,92)`.

- **Labels rasterize at 50% of Obsidian's `14 + node size / 4`, and the factor is
  now a setting.** This is a deliberate deviation requested by the user, not an
  attempt at parity: the graph lives in a narrow sidebar, where the original size
  reads as oversized next to a fitted graph. The display section gained a
  **标题文字大小** slider (0.4–1.6, step 0.05, default 0.5) that drives the raster
  font size, so the reduction is adjustable rather than hard-coded. Position, the
  `sqrt(scale)` scaling, the fade threshold and the pinned size of a highlighted
  node are unchanged and are measured in `docs/obsidian-graph-source.md`.

- **A long prompt no longer raises the bar above four token hits.** The floor was
  `max(3, ceil(0.3 × queryTokens))` with the query capped at 16 tokens, so its top
  bucket demanded five token hits — and the extra tokens of a long
  natural-language prompt are mostly function-word bigrams that can never match a
  note. Measured through the shipped policy over the same 154 real prompts, by
  setting the cap back to the old value and replaying: **22.1% of prompts
  produced a map before, 56.5% after**, at 1.9 notes and 595 code points per map.
  The floor never drops below three, so a weak match still stays silent.

  The additions were read before the change was kept. Of the 53 prompts the cap
  adds, the overwhelming majority pair a note with a prompt that is on topic for
  it — `README edits are paired EN/ZH` for code-review turns, `CodeGraph MCP is
  the preferred lookup` for search-and-retrieval work, and, for 「请修复这个三个
  问题并且提交，随后 push 到 main」, the vault's own 「修复流程：改完提交并 push 到
  main，以 CI 绿 + 全量 check」. A minority are topical neighbours rather than
  answers (`Project figures are being restyled` for a prompt about agent skills),
  and they are the reason the cap is four and not lower.

- **A relevant turn now receives the matched excerpt, and no longer waits for
  the session brief to finish.** Both numbers below come from replaying the 154
  real user prompts of the two bound repos through the shipped policy and the
  shipped index, on a throwaway copy of the vault:

  * **Turn 1 was starved.** The production brief spends essentially the whole
    session budget (measured in this repository's own bound project: 5,896 of
    6,000 code points), so the map was handed the 104 left over — which fits
    nothing. Against the old code, **0.6% of prompts produced a map on turn 1**
    (1 of 154) against **22.1%** (34 of 154) once the brief was out of the way.
    With `recallBudgetChars` the same replay yields **22.1%** (34 of 154) with no
    turn-1 penalty at all, at an average of 1.7 notes and 484 code points per map.
  * **A pointer is not memory.** Across 277 DSH sessions and 31,718 tool calls,
    `mem_read` was dispatched 18 times: following a pointer is a second voluntary
    tool call, and the model almost never makes it. Each line now carries the
    excerpt `lib/index-db.js` already computes *for that query* — `buildSnippet`
    centres a ±60-code-point window on the matching needle — flattened to one
    line and clamped to 200 code points. `_meta/hot.md` is skipped, because the
    brief already injects the hot layer.

  The boundaries that did not move: the map is still quoted vault data and never
  a command, `mem_read` is still the way to a full note, `useful()` still refuses
  weak matches (the replay's 22.1% is a firing rate, not a widening), and the
  Codex per-session state file still stores **paths only** — the excerpt reaches
  the model and never the disk. The two tests that asserted "never copies its
  body" were rewritten deliberately, and the Codex one keeps its `doesNotMatch`
  assertion against the saved state, which is the invariant that actually
  mattered.

  **Red first, then a deliberate regression.** `MAX_SNIPPET_CHARS` did not exist
  and the full-size-brief case produced no map. Two new DSH cases and the
  existing Codex case pin the behaviour: one drives the real waterfall over a
  real `mktemp -d` vault with the shipped `buildBrief`, the shipped index and
  the shipped service `search`, and asserts the first turn receives the excerpt;
  `test/codex-hooks.test.js` drives the real hook script as a subprocess and
  asserts the excerpt reaches `additionalContext` while the saved state stays
  paths-only. Reverting the one changed line to the old
  `briefBudgetChars - spent` expression makes **both** DSH cases fail and nothing
  else, which is the evidence that they test the mechanism rather than the
  fixture. The suite is green at 652 tests.

- **`lib/tools.js` is a 22-line façade instead of a 2,006-line file, and the
  three jobs it held are three modules.** Task 11 of the harness plan named this
  as the structural change the other eleven tasks only made safe, and it is the
  only place this round moved code rather than adding it:

  | Module | Lines | Owns |
  |---|---|---|
  | `lib/tool-schema.js` | 847 | the parameter specs, the closed output schemas, and the argument rules every `execute` shares |
  | `lib/tool-registry.js` | 198 | the six `defineTool` definitions and `registerTools` |
  | `lib/services.js` | 1,024 | service lifetimes, binding/index caches, admin dispatch, projections |
  | `lib/tools.js` | 22 | four re-exports and nothing else |

  **Nothing outside `lib/` changed an import.** `lib/index.js`, `codex/server.mjs`
  and all nine test files still do `import … from './tools.js'` (or
  `'../lib/tools.js'`), which is the point: a façade both entry points already
  import *is* the seam, so the move is invisible to them and a future move will be
  too. Two new tests hold that: `test/tools-facade.test.js` asserts that the
  façade exports exactly the four published names, that each one is the *same
  value* the owning module holds rather than a structurally equal copy, and that
  the DSH runtime and the Codex `listTools()` describe the same six tools; the
  pack fixture asserts that dropping a re-export fails the package check.
  Measured, not asserted: removing the `registerTools` re-export fails the whole
  file at import time, and rebuilding `TOOL_NAMES` as a local `Object.freeze([...])`
  — which compiles, type-checks and behaves identically — fails on reference
  identity with `TOOL_NAMES must be re-exported, not rebuilt`.

  The package verifier moved with it, because a check that reads the old path
  reports success about a file that no longer contains a registration:
  `scripts/verify-pack.mjs` now scans `lib/tool-registry.js` for the six
  `name: 'mem_x'` sites **and** reads `lib/tools.js` for the four re-exports, as
  two separate checks that fail for two different reasons. The verification
  output says so: `6 tools registered and 4 names published`.

  The move also made one deliberate asymmetry visible enough to write down. The
  MCP adapter closes the argument root (`additionalProperties: false`) and the DSH
  runtime leaves it open, which is the entire reason `assertKnownArguments` exists
  — DSH hands an undeclared key to `execute`, the adapter refuses it at the
  schema. That difference is now asserted per tool instead of being rediscovered;
  so is the adapter's habit of always writing `required`, which DSH omits when it
  is empty. `test/architecture.test.js` records the new layers
  (`tool-schema` L3, `tool-registry` L4, `services` L8, the façade L9, `index` L10)
  and the four budgets, on the same rule as every other file: the façade's budget
  is 100 lines, which *replaces* the temporary 2,050 rather than extending it.

- **Every vault path is ASCII now: the directory names, and the file names the
  plugin fixes itself.** `项目/`→`Projects/`, `文档/`→`Docs/`, `决策/`→`Decisions/`,
  `约定/`→`Conventions/`, `踩坑/`→`Pitfalls/`, `日志/`→`Daily/`, `收件箱/`→`Inbox/`,
  `方法/`→`Methods/`; the project registry moved to `_meta/registry.md` (was
  `_meta/项目注册表.md`), the glossary to `Docs/glossary.md` and the hot archive to
  `Docs/hot-archive.md`. A vault path now survives a shell that is not UTF-8, an
  archive round-trip, a URL, and any tool that mangles CJK — which is the whole
  reason it changed. **A note's own file name is unchanged in kind**: it is still
  derived from the title in whatever language the writer used, because the name is
  a rendering and frontmatter `id` is the identity. That distinction is now written
  down in `README.md`/`README.zh.md`, in the shipped skill
  (`skills/obsidian-mem/SKILL.md`, "Every directory name is ASCII…") and in
  `AGENTS.md`. The suite was updated with it: 566/566 pass, and the fixtures'
  directories were renamed while their *note* file names stayed Chinese, which is
  exactly the rule.
- **A breaking change with no automatic migration.** The plugin does not convert an
  existing vault: notes stay where they are, but the project directory, the
  registry path and every MOC wikilink still name the old directories, so
  `mem_admin(action="projects")` will not resolve the project and `nextAdrNumber`
  will not see existing ADRs. The vault this repository dogfoods was migrated by
  hand instead: directories renamed, path-qualified wikilinks and the
  generated-region declared hashes rewritten, the registry rewritten, and the
  receipt path keys in `$DSH_HOME/data/obsidian-mem/receipts/` remapped so that
  "this plugin owns this file" still checks out. A running harness must be
  restarted afterwards — plugin code is loaded once per process.
- **The frozen design document still shows the old names.**
  `docs/superpowers/specs/2026-09-23-dsh-obsidian-mem-design.md` (D5, §5.1, §6.1)
  records the decision as it was taken; the code, the shipped skill, the tests and
  the README pair describe the current tree. Likewise `docs/dogfood-results.md`,
  `docs/smoke-results.md` and `test/smoke/records/smoke-record.json` are records of
  runs that really happened under the old names, and rewriting them would claim
  something that never occurred.

### Removed

- **The README no longer explains how to disable another memory plugin.** The
  step-by-step walkthrough that named one specific third-party plugin — and told
  readers to append a row to their own `$DSH_HOME/cordis.patch.yml` — is gone from
  both language sides, and no shipped document names that plugin any more. It read
  as though this plugin needed that done before it would work. It does not: this
  plugin mounts one row, requires nothing of what else is mounted, and does not
  care which other memory layer is present. The constraint the section was
  illustrating is unchanged and still enforced — no script in this repository
  edits a user's configuration, and `prepack` stays a read-only verifier
  (`AGENTS.md` rule 1).
- **The README no longer carries the "DSH plugin conventions" table.** The eight
  conventions are unchanged and still followed — the bundle patch, the ESM entry,
  the `github:` install spec, the `dsh-plugin` topic, `engines.dsh`, the registry
  manifest, the portable skill and the bilingual pair. What is gone is the table
  that named them in one place, so the measurements it cited are kept here rather
  than lost: nothing in an installed harness reads `engines.dsh`, and 231 of the
  240 packages under `@deepseek-ai/` ship the three-file bilingual README set.
- **The README no longer carries a "Not verified" list.** The list was cut to keep
  the landing page short; no item on it stopped being true. The untested inventory
  now lives only in this changelog — the `Not verified:` bullets under `0.1.0`'s
  *Known limitations and remaining risks*, plus every Unreleased entry — and the
  README now says plainly that its boundaries are what it writes down rather than
  a complete set. `AGENTS.md` rule 6 keeps the requirement and names this file as
  the list's home.

### Verified end to end

- **The plugin still works as a *mounted DSH host plugin*, not just as a library
  under `node --test`.** The isolated-profile smoke suite was re-run at
  `ca286a7` — after both the `tools.js` split and the diagnostics call sites —
  and it is the only check in this repository that says so. `run-smoke.mjs`
  installs this checkout into a throwaway `DSH_HOME`, drives real headless
  sessions against a throwaway vault, and **SIGKILLs the process at the durability
  boundary** so the next process has to recover the job; `verify.mjs` then
  re-derives every fact from the temp vault. Measured: **25 checks, 0 failures,
  1 honest UNVERIFIED** (the Obsidian GUI half), and `negative-controls.mjs`
  **11 negative controls + 1 positive control, all as expected** — so the checker
  is known to fail for each condition it claims to detect rather than merely
  having passed once.

  What the run actually established, in its own numbers: the plugin row was
  present in `--dump-config`; exactly one recall brief reached the first step
  (109 code points, inside the 6,000 budget) and none later; a Chinese document
  written through `mem_write` was found again by a four-character Chinese query;
  the supersede chain left the old note with `status: superseded` and its
  `superseded_by`, dropped from default search and present under
  `includeHistory: true`; both model lanes were real distils (dry-run: 234 output
  tokens, vault unchanged; live: 278 output tokens, vault changed) with exactly
  one result receipt for the killed job and **no duplicate note id anywhere**;
  an edit made outside the plugin survived, and a `trust: owner` file the plugin
  tried to update *and* supersede was byte-identical afterwards; a read-only lint
  changed nothing; 21 notes re-parsed under `yaml`, with the tag lists, ISO day
  fields and wikilinks checked; and the real `~/.dsh` fingerprint was identical
  before and after.

  **The run's record is deliberately not committed**, for the reason
  `docs/smoke-results.md` §1 and §7 already give: a passing model lane writes a
  note whose title the model wrote, so the transcript now contains model output,
  and this repository does not commit that. The tracked
  `test/smoke/records/smoke-record.json` therefore stays what it is — the
  Task 18 pre-fix transcript, which describes a run whose model lane produced no
  receipt — and it is *not* evidence for the numbers above. The evidence for
  those is this entry plus the commands it names; the record was rewritten,
  inspected, and reverted rather than left in the tree, and `git log` on that
  path shows no commit here.

### Remaining from the engineering-harness plan

Stated here rather than left to be discovered, because rule 6 puts the untested
and unfinished list in this file. The plan's structural task — `lib/tools.js`
split into `tool-schema.js`, `tool-registry.js` and `services.js` behind an
unchanged façade — **is done**, and is written up under *Changed*. What follows is
what is still open.

- **The GitHub workflow has now run, and all three legs pass.** This was the last
  item on this list that a local run could not close, and pushing closed it:
  [run 36130730692](https://github.com/bonerush/dsh-obsidian-mem/actions/runs/36130730692)
  on `f6adb46` reports `conclusion: success` for `check (22.22.2)`,
  `check (24.x)` (Node v24.21.0) and `check (node)` (Node v26.10.0). Each leg ran
  the same `npm ci` → `npm run check` — **634 tests, 634 pass, 0 fail** plus
  `verify-pack: OK` and `verify-tarball: OK` — with `found 0 vulnerabilities` from
  the install, and each finished the Unreleased gate with
  `verify-changelog: OK — lib/ changed and ## Unreleased moved with it`. The job
  times were 38 s, 37 s and 41 s.
  That also settles what the previous revision of this entry left open: GitHub's own
  runner, both non-floor matrix legs, and `scripts/ci-base.mjs` choosing a base from
  a real push event — the gate's own output is the evidence that it was handed one.
  What is still untested is `ci-base.mjs` against a `pull_request` event and against
  an all-zero `before`; the push path is the one this repository's work actually
  takes, and it is now measured rather than assumed. The earlier hand-run baseline
  stands behind it for the floor specifically: in a clean `git archive` tree with no
  `node_modules`, `npm ci` under Node 22.22.2 installed the lockfile (including the
  two optional peers) with `found 0 vulnerabilities`, and `npm run check` exited 0
  with 627 tests at the time.
- **The type ratchet covers twelve files of twenty-eight candidates.** The full
  per-file counts are in the design at
  `docs/superpowers/specs/2026-09-25-engineering-harness-design.md` §7.3;
  `lib/pending.js` alone reports 78 and is why the first tier stopped where it did.
- **Obsidian GUI behaviour is still unverified.** The smoke run below is a
  filesystem result; nothing in it says a tag renders as a property list or that a
  wikilink is clickable, because the vault was never opened in Obsidian.

### Fixed

- **The graph painted the light palette inside a dark DSH.** The panel keyed its
  two palettes off `.dark` and `[data-theme=dark]`; this host marks dark mode as
  `body[data-ds-dark-theme]`, so the selectors never matched and a dark UI got the
  white canvas described above. The palette is now resolved from the theme tokens
  themselves, which removes the class-name coupling rather than adding a third
  selector to keep in step.

- **Every graph line was nearly invisible.** The line slot was bound to
  `--dsw-alias-border-l2`, and this host's border tokens are translucent
  (`#ffffff1f`, i.e. 12% alpha, on the dark theme). Multiplied by the slot's own
  opacity this put edges at roughly a tenth of the intended contrast. The line now
  uses `--dsw-alias-label-dimmed`, a solid grey that matches Obsidian's
  `--color-base-35` roles in both themes.

- **A changed graph asset kept running the previous build until the host
  restarted.** `registerGraphRoute` read `graph-renderer.js` and
  `graph-worker.js` once at registration and served that buffer forever, so edits
  under `lib/` were invisible to the browser no matter how often the page was
  reloaded. Both are now read per request, and
  `test/graph-route.test.js` rewrites a temporary asset between two fetches to
  pin it: with the cached handler that case fails, with this one it passes.

- **`mem_admin(action="diagnostics")` failed its own output validation as soon as
  a `recall` event existed.** The diagnostics channel has two closed sets, and
  they are the same fact written twice: `lib/debug.js` refuses to *record* a name
  or field it does not know, and `lib/tool-schema.js` refuses to *return* one it
  does not list. The previous change extended the first and not the second, so the
  ring accepted the event and the tool rejected the whole snapshot —
  `"value" must match exactly one oneOf branch (matched 0)`. Found by the first
  live `mem_admin(action="diagnostics")` after a restart, which is exactly the
  surface neither unit suite covers: the ring tests call the ring, and the hook
  tests inject their own ring, so nothing compared the two lists.

  The schema's `event` enum and its `hits`/`chars` properties now carry the
  `recall` event, and `test/debug.test.js` holds the two sets equal in both
  directions: every name the ring records must be in the enum, every field it
  writes must be a property, and the schema may publish nothing the ring cannot
  write beyond its own `seq`/`at`/`event`. Red first: the guard failed with
  "the schema does not list the event recall".

- **Distillation no longer writes a second note for a fact the vault already
  holds.** Every distilled candidate asks one question before it creates anything:
  does the bound project already have a note with this title? The lookup is
  `lib/search.js`'s `findTitleTwin` — the same project scope, the same
  superseded/archived exclusions and the same tokenizer as `mem_search`, narrowed
  to the candidate's own type — and the comparison is the **overlap coefficient**
  of the two titles' tokens, not Jaccard: a distilled title is usually a reworded
  superset, and Jaccard punishes the length difference, scoring the pair this was
  measured on 0.60 against overlap's 0.80.

  Measured on this repository's own vault: **42 same-type pairs** are near
  duplicates, and the two a reader finds first — a distilled pitfall beside the
  agent-written one, and a distilled ADR restating another — score 0.80 and 0.72.
  The threshold is 0.8, at the top of that gap, because the errors are not
  symmetric: a missed twin leaves a duplicate, a false twin silently discards a
  distilled fact.

  A skip is reported, never silent: the receipt names the note that already covers
  the fact, and a `distill` diagnostic records `outcome: "duplicate"`. The check
  is skipped for an explicit supersede — its target is by definition the note being
  replaced — and it **fails open**: a wiring whose index handle only refreshes, or
  a lookup that throws, applies the candidate exactly as before and records
  `duplicate-check-failed` instead of refusing the write. Red first: the new
  `applyCandidate` case failed on the missing `skipped` result, and the new
  end-to-end case failed with `2 !== 1` notes until the seam was wired; commenting
  the one wiring line out makes it fail again and nothing else.

- **The distillation prompt now names the `status` vocabulary, and cannot drift
  from the validator again.** Two of the three enumerated fields were spelled out in
  `SYSTEM_PROMPT` and `status` was not, while `validateItem` refuses any status
  outside `STATUSES` — so the model had to guess an enum the plugin would reject.
  Measured on a real home: an output was refused with `distill item 2: status must
  be one of active, proposed, … (got "completed")`, and every candidate in it was
  discarded with it. All three vocabularies (`type`, `assertion`, `status`) are now
  interpolated from the exported `DISTILL_TYPES`/`ASSERTIONS`/`STATUSES`, so a value
  added to one is a value the model is told about in the same edit. Red first: the
  new case in `test/distill.test.js` drives one bad value per enumerated field
  through `validateDistillation`, reads the accepted list back out of the refusal
  message, and requires the prompt to name every value in it — it failed with "the
  prompt never names the status value active" and passes after.
- **An explicit `mem_admin(action="jobs", retry=true)` now wakes the queue worker
  instead of waiting for something unrelated to.** `retryJob` revived the job and
  stopped there, and a pass arms its next timer only while work is already waiting
  — `processQueue` returns `nextDueAt: null` for a queue whose only job is terminal
  — so a revived job sat untouched until the next captured turn or a plugin reload.
  Measured on a real home: two revived jobs stayed untouched through four minutes of
  polling with the host otherwise idle. `registerHooks` now announces the worker it
  builds through a new `onQueueWorker` dep, `lib/index.js` hands that worker to the
  services as a late-bound `kickQueueWorker`, and `jobsAction` calls it exactly once
  after a successful revive — never for a listing, a refusal, or a job id that names
  nothing. Red first: the new case in `test/integration-write-read.test.js` drives
  the real `apply()` assembly, writes a terminally failed job into the
  `DSH_HOME`-derived queue and fails with "no diagnostics event named job-revive-1
  within 5000 ms" without the kick, because a pass is observable only through the
  decision it records; it also caught the first attempt, where the kicker reached
  `createMemoryServices` but not the module-level `jobsAction` that owns the retry.
  `test/lint.test.js` pins the contract at the service seam: one kick per
  successful retry, none for a listing, a refusal or a missing id, and a
  non-function `kickQueueWorker` is refused where it is supplied.
- **`mem_admin(action="jobs")` reports why a job failed instead of `null`.** The
  queue stores `lastError` as an object — `{code, message, at}` — because the
  reason, the line and the time are each useful to a reader of the job file, while
  `JOB_SCHEMA` declares a single string. The view was built with a string-only
  check, so a terminally failed job listed as `lastError: null` and the reason —
  the one thing this action exists to show — was visible only by reading
  `$DSH_HOME/data/obsidian-mem/pending/*.json` by hand. `normalizeJobError` in
  `lib/pending.js` is now the one place the two shapes meet; it prepends the code
  only when the stored message does not already carry it, because a stored
  `message` is `describeError`'s output and the naive join prints
  `too-many-items: too-many-items: …`. Red first: the new assertion in
  `test/lint.test.js` read `null` for a job document carrying the object the
  writer actually stores (45 tests pass in the two touched files afterwards);
  `test/pending.test.js` covers the remaining shapes — bare message, code only,
  legacy string, empty, `null` and a non-object. The README pair also names the
  configuration gap behind a queue that never drains: a session imported from
  another harness has no recorded route, so imported history waits for
  `distill.provider`/`model` to be set.
- **The callback JSDoc in `lib/hooks.js` and `lib/transaction.js` now parses
  under TypeScript 7 as well as 5.9.** Five `@param {function(string): T}` type
  expressions used the Closure dialect, which TypeScript 7.0.2 — today's
  `latest` on npm — rejects with `TS1005`, and the rejection cost the eight
  `@param deps.*` entries below them their binding (`TS8032`). Measured on the
  same two files with `checkJs: true`: **5 + 8 diagnostics under 7.0.2, 0 + 0
  under the pinned 5.9.3**, and 0 + 0 under both after this change. The pinned
  compiler never reported it, so this is portability rather than a repair: the
  arrow form is accepted by both, and it can name its parameter, which the
  Closure form cannot. `test/jsdoc.test.js` freezes the form and its failure
  message states the measurement, so the next person sees why the rule exists.
- **ESLint's first honest run over this tree found 43 problems; all 43 are now
  either fixed or disabled at the site with the reason.** The repository had no
  linter, so nothing had ever looked. Twelve dead stores (`let corrupt = false`,
  `let record = null`, `let age = 0`, `let gitInitialized = false` and eight
  more) were overwritten before any read and are now bare declarations; twenty
  unused bindings and imports are gone, including a whole `seedSpecs` object in
  the smoke runner that nothing had read since a refactor; `lib/paths.js` and
  both `scripts/verify-pack.mjs` rethrows now attach `{ cause }` instead of
  discarding the failure underneath the wrapper. The eight that remain are
  deliberate and stay visible: six `no-control-regex` sites and two
  `no-misleading-character-class` sites strip control characters and match emoji
  code points one at a time, so each carries an inline
  `eslint-disable-next-line` naming that reason. `no-undef` is never disabled —
  it is the rule that found the `TransactionError` defect fixed in `e31fa13`.
  Behaviour is unchanged: 574 tests pass before and after, and the pack verifier
  still reports `OK`.

- **A `retain` whose registry transaction failed threw `ReferenceError:
  TransactionError is not defined` instead of the refusal it documents.**
  `lib/vault.js` re-exports `TransactionError` — "every importer keeps going
  through this module" — but a re-export puts a name in the export namespace and
  not in the module's own scope, and the `catch` that decides between a refusal
  and a rethrow tested `error instanceof TransactionError`. The `||` beside
  `error instanceof BootstrapError` hid it for the one error type that was
  genuinely in scope, so the only path that broke was the bind-conflict path the
  catch exists for. Introduced with the catch in `8c988dd` and never covered: no
  test asked a `retain` to survive a failed transaction. Found by ESLint's
  `no-undef` on the first run over the tree — one finding in 58 files — which is
  the engineering-gate work this entry's neighbours will describe. Regression
  test: `test/lint.test.js`, where a real unresolved transaction (a
  fault-injected write to the project index, then an external edit to that same
  file) now yields `{kind: 'conflict', reason: 'recovery-required'}` and leaves
  the externally edited file byte-identical. Before the fix that test failed with
  exactly the `ReferenceError` above, at `lib/vault.js:504`.

- **Every turn in a bound project failed on DSH 0.1.7 with `format v4 message
  requires a producer-owned source kind`.** Recall injection stamps a `source` on
  the `user/message` it inserts, and `lib/hooks.js` stamped the retired
  `{kind: 'plugin', plugin: 'obsidian-mem'}` wrapper. Session format v4 refuses
  `kind === 'plugin'` outright — both on write, in the gate that runs before
  `encodeEvent`, and on read — so the message could not be persisted and the turn
  aborted (`本轮运行失败`), which is the failure a real user hit. The source is now
  `{kind: 'plugin:obsidian-mem', form: 'recall'}`: the host's own producer-kind
  convention for a third-party plugin, and the exact value the v3→v4 converter
  derives from the old wrapper (`producerKind()` in
  `dsh-session-format-v3-to-v4`), so a session converted from v3 and a session
  written under v4 name the same producer. `engines.dsh: ">=0.1.5-rc.2"` stays
  honest because the 0.1.5-line writer admits the new kind verbatim — a
  `user/message` there only requires a nonempty string kind, and it is the
  *v2→v3* migration's allow-list, not the current writer, that ever named
  `plugin`. Measured with `test/p0/run-v4-source-probe.mjs`, which drives the
  installed host's own gates rather than a reimplementation of them, and records
  four cases in `docs/p0-compatibility.md` §10: (A) the retired wrapper is refused
  by v4's `assertV4RowAdmission` with exactly the error above; (B) the new kind is
  admitted; (C) the real catalog restore over a real v3 session
  (`zstd -dc` — the files are concatenated frames, and Node's
  `zstdDecompressSync` reads only the first) derives
  `{"kind":"plugin:obsidian-mem","form":"recall"}` for this producer; (D) a
  0.1.5-line `encodeCurrentEvent` stores the new kind verbatim. A corpus
  cross-check of 258 of the user's session files found 14 messages carrying the
  retired wrapper and none carrying the v4 kind, which is what makes the diagnosis
  the only one consistent with the evidence. Regression tests:
  `test/hooks.test.js` — the injected message's `source` asserted field by field,
  plus a host-free pin of the v4 rule (`assert.notEqual(RECALL_SOURCE.kind,
  'plugin')` and `assert.equal(RECALL_SOURCE.kind, \`plugin:${PLUGIN_ID}\`)`, both
  hardcoded, so the value cannot move with the module). The two recall filters in
  `test/lint.test.js` are not themselves regression tests — they find the
  plugin's messages by importing `RECALL_SOURCE`, so they would follow the module
  — but the second one is what caught the first, incomplete version of this fix,
  because it still matched the retired `source.plugin`: only running the whole
  suite reported it.
- **The shipped skill no longer claims a `not-ready-in-p1` status the code cannot
  produce.** All six `mem_admin` actions were implemented in Task 17 and
  `test/tools.test.js` asserts the marker is absent from a result; the sentence
  survived in `skills/obsidian-mem/SKILL.md` and was copied into the new Codex
  edition before anyone re-read it. Both now name the two real "cannot answer yet"
  shapes — `mem_brief` answers `status: 'unbound'` for an unbound repository, and
  an index-backed search raises `index-not-ready` until the first scan finishes —
  and both list `report`/`prune` among `mem_admin`'s arguments, which they had also
  omitted.
- **The queue worker no longer reports the host's shutdown as a caller
  cancellation.** DSH disposes the whole plugin tree when a headless run's
  session completes; the worker's fiber disposer ran `controller.abort()` inside
  that teardown, which the LLM service reports as a terminal
  `finish.reason.kind === 'aborted'`. Every such pass therefore recorded a failed
  attempt the model never produced (`lastError.code === 'aborted'`), consumed the
  R43 retry bound, and left the headline path — completed turn → real
  distillation → automatic write — unverified on a real host. Measured in
  `docs/p0-compatibility.md` §9 with a disposable probe
  (`test/p0/run-teardown-probe.mjs`, 13 assertions): the tree teardown does *not*
  kill an in-flight stream (a 7.2 s stream finished 4.7 s after its provider
  fiber was `DISPOSED`), so `stop()` now stops scheduling and lets the in-flight
  pass settle, while a new `abort()` keeps the real cancellation path (and its
  truthful `aborted` reason). Regression tests:
  `test/auto-capture.test.js` (`a host unload mid-call lets the job finish
  instead of reporting a caller abort (Task 18b)`, and the explicit-`abort()`
  counterpart).
- **A settling pass finishes exactly one job — the one already in flight.** A pass
  snapshots `llm` once and iterates every due job, so letting it settle without a
  boundary re-created the same defect one job later: after the disposal the
  snapshotted handle answers `NO_ADAPTER`, `distill.js`'s route check still
  accepts it, and each remaining job would record a failure the model never
  produced until it terminally failed. The worker now hands the pass an
  `isStopped` predicate; once it is stopping, the remaining due jobs are deferred
  as `unloaded` and are not written at all, so the next process resumes them with
  `attempts` untouched. Regression test: `a pass that outlives the plugin tree
  defers the rest of the queue instead of failing it (Task 18b)` (two due jobs,
  RED before the fix with `2 !== 1`).
- **Live model distillation is now verified end to end.** The isolated-profile
  smoke (`docs/smoke-results.md`) now scores the worker's own model-backed
  distill: a real completed turn, a real `deepseek-official`/`deepseek-flash`
  call with a real token `usage`, and either a `dry-run` receipt that wrote
  nothing or an `applied` receipt that wrote the note — both with `attempts: 0`.
  The checker only treats a lane as "skipped" when the runner sets an explicit
  `skipped: true` (`--only`); a lane that ran and captured nothing is a failure,
  so the acceptance can no longer pass on a total capture failure.
  `test/smoke/negative-controls.mjs` covers both model-lane mutations.

- **A Git repository with no `.obsidian-mem` is bound by its first write, and a
  bind is visible in the session that made it.** The dogfood run measured
  (`docs/dogfood-results.md` §10 F1) that every internal seam resolved with
  `mode: "show"`, so a pointerless repository had no reachable automatic bind
  path at all — `mem_write` refused with `not-bound` — and that the unbound
  resolution was memoized per working directory for the life of the loaded
  plugin, so even an explicit `mem_admin(action="bind", mode="local")` left the
  six tools refusing until a new session. `mem_write` and `mem_log` now resolve a
  `no-pointer` Git repository exactly as spec §5.2.3 / §5.3 describe — slug from
  the Git root, exclusive pointer create, skeleton, registry row — and then
  proceed; a successful bind (automatic or explicit) replaces the per-cwd miss,
  so the next call in the same session sees it. Every fail-closed guard is
  unchanged and still refuses rather than minting: a non-Git directory, a corrupt
  or unknown-schema pointer, an unreadable registry, a taken directory, a
  cloud-managed vault and an unreadable sibling worktree. A resolution that
  already minted a pointer and then refuses now removes the pointer it created,
  so a one-off refusal cannot become a sticky one; an automatic bind that meets a
  bootstrap refusal releases the pointer only when the bootstrap created no
  project content (`vaultWritten`), so the §6.4 property preflight, a registry
  whose recorded sha256 does not cover its body and every other pre-write refusal
  leave the repository exactly as the write found it. Reads still never bind. The
  README "Project bound" row and the "A repository refuses to write", "A plain
  directory stays read-only" and "Memory is silently absent" recovery rows now
  describe this, replacing the Task 20 text that documented the defect instead.
  Regression tests: `test/auto-bind.test.js` (15 cases through the shipped tool
  runtime; 14 fail against the previous `lib/` — the one pass is the
  cloud-managed guard, which refuses before any binding work).
  A `deferred` job can also be a validation refusal (`truncated`,
  `too-many-items`) backing off, which the recovery table previously attributed
  only to a missing route or binding.
- **A transaction manifest read from disk is no longer trusted with a path.**
  `txId` and `vaultHash` are the two manifest fields that name one:
  `discard()` removes `_meta/.history/<txId>/` inside the vault, and
  `writeManifest`/`removeManifest` write or delete
  `<dataRoot>/transactions/<vaultHash>/<txId>.json`. Both were taken verbatim, so
  a manifest carrying `txId: "../../.."` or a traversing `vaultHash` deleted or
  wrote **outside** the vault. Every manifest read from disk — recovery,
  `listPendingIndexNotifications` and `markIndexNotified` — and every act site
  that joins one of those fields re-applies the request-path rules
  (`[A-Za-z0-9][A-Za-z0-9._-]{0,127}` and 64 lowercase hex) and refuses with
  `manifest-corrupt` instead of acting on it. This is hardening rather than a
  fixed violated invariant: it takes a same-user process rewriting
  `$DSH_HOME/data/obsidian-mem/transactions/`. Regression tests:
  `test/transaction.test.js` (`a manifest whose txId traverses is refused, and
  nothing outside the vault is deleted`, and its `vaultHash` twin) — both
  falsified against the previous `lib/`.
- **The smoke checker no longer passes a model lane that is absent.** A record
  with no `capture.modelLane` (or one missing a lane) scored both
  `model-lane-*-real-distill` checks as PASS, because `lane === undefined` was
  read as "skipped by `--only`". The runner also dropped the `skipped` sentinel
  when it rebuilt the lane, so a real `--only live` / `--only dry-run` run
  *failed* a lane that never ran. Absence is now a failure, only the runner's
  explicit `skipped: true` marks a lane as not run, and the runner projects that
  flag. `test/smoke/negative-controls.mjs` covers both directions (absent lane and
  the absent-`modelLane` shape fail; the sentinel still passes).

### Changed

- **Honest limits corrected** (`README.md`, `docs/smoke-results.md`): the
  "no live model call has ever been made" item is replaced by what is still
  unmeasured (one host, one route; the one-shot timing window; the Obsidian GUI).
- **An unknown config key is now refused instead of silently ignored.**
  schemastery's `z.object` passes unknown keys through, so a hand-written row with
  a typo (`vaultpath`) kept `vaultPath`'s default and pointed the plugin — and its
  bootstrap — at a different vault. `validateConfig` now refuses an unknown
  top-level or `distill` key, names it, and lists the design document's
  deliberately-dropped fields (`projectsDir`, `methodsDir`, `metaDir`,
  `reservedPrefixes`, `docMirror`, `distill.mode`, `distill.maxCostPerSession`).
  **Action for anyone who copied the design document's §12 block:** those fields
  now produce a loud error where they used to be a silent no-op. Remove them; the
  accepted field set is the README table.

## 0.1.0 — 2026-09-23

First version. Everything here was built and reviewed inside this repository;
no pack of this plugin has been installed from a registry.

### Added

- **A dedicated-vault project memory protocol written in plain Markdown.** A
  committed four-field `.obsidian-mem` pointer (`projectId`, `slug`,
  `displayName`, `schema`) binds a repository to one fixed directory,
  `项目/<slug>--<projectId 前8位>/`, inside the vault. The pointer carries no
  absolute path, so one project ID and one vault path per machine are enough to
  move a checkout.
- **Idempotent bootstrap.** First contact creates only what is missing: the
  project skeleton, `index.md`, `_meta/hot.md`, one MOC per type directory and
  the vault registry row. Existing files are never overwritten, existing vaults
  are never restructured, and `initGitOnCreate` runs `git init` only on a
  directory this plugin just created (it never commits and never configures a
  remote).
- **Three-tier memory.** A hot file (`_meta/hot.md`, ≤ `hotCapacityChars`,
  default 9000) with 强约束 / 进行中 / 已完成 zones, a warm layer of on-demand
  notes reached through `mem_search` → `mem_read`, and an append-only daily
  cold log — plus a read-only `_meta/user.md` for preferences the plugin never
  writes.
- **One budgeted recall injection.** After the first `agent/pre-step` of a
  session, a single recall message (≤ `briefBudgetChars`, default 6000 code
  points, with a footer reporting the exact usage) is appended. Later steps only
  receive a delta when the hot layer's content hash changes. A not-ready index is
  reported as not-ready, never as "no memory".
- **Six tools**: `mem_search`, `mem_read`, `mem_write`, `mem_log`, `mem_brief`
  and `mem_admin` (actions `lint`, `index`, `bind`, `projects`, `promote`,
  `jobs`). Deliberately capped at six.
- **A rebuildable search index outside the vault** — `node:sqlite` FTS5 with CJK
  overlap-bigram tokenisation and a scan fallback (`indexBackend: auto`) that
  reports the degradation instead of pretending it did not happen.
- **A transaction engine for multi-file writes**: a whole-vault write lock keyed
  by `realpath(vaultPath)`, pre-write snapshots under `_meta/.history/<txId>/`,
  exclusive publish via `link(2)`, per-step receipts and crash recovery from a
  journal under `$DSH_HOME/data/obsidian-mem/transactions/`. A file whose hash no
  longer matches what this plugin wrote is a conflict, and conflicts stop the
  write rather than overwriting the edit.
- **Automatic distillation of completed turns** into `decision` / `gotcha` /
  `convention` candidates: a durable 0600 pending queue, credential scrubbing,
  an idle debounce (`captureIdleMs`, default 90 s), a single no-tool model call,
  strict JSON validation against the evidence sequence numbers, and idempotent
  application keyed by `sessionId:toSeq:itemIndex`. Below-threshold candidates go
  to `收件箱/`; `dryRun: true` writes receipts only.
- **Governance**: supersede instead of overwrite, `contested` when two claims
  cannot be ranked, `assertion` (`stated` / `inferred` / `observed`) and
  `confidence`, `review_after` expiry, and `mem_admin(action="lint")` health
  reports (orphans, dead links, frontmatter gaps, expiry, file↔index mismatch,
  unreferenced repository Markdown, queue backlog) that are read-only unless a
  write is explicitly requested.
- **A portable skill** (`skills/obsidian-mem/SKILL.md`) synced idempotently into
  `$DSH_HOME/skills/obsidian-mem/`, written in the Agent Skills format so it
  survives a change of harness.
- **Packaging**: an explicit `files` allowlist, a `prepack` gate
  (`npm test` + `scripts/verify-pack.mjs`) and `npm test` running inside a
  throwaway `DSH_HOME`.

### Fixed

- `npm test` now runs with `DSH_HOME` set to a fresh temporary directory. An
  earlier version relied on per-test convention and a test that activated the
  plugin installed a skill into the real `~/.dsh/skills/`.
- `@deepseek-ai/cordis` and `@deepseek-ai/dsh-tools` are declared as
  `devDependencies`. They are *optional* peers, so npm deliberately does not
  install them; the suite used to pass only because hand-made symlinks happened
  to sit in the gitignored `node_modules/`, and a clean `npm ci` failed at import.
- `skills/obsidian-mem/SKILL.md` had a mangled sentence about file timestamps
  ("Use never file timestamps to invent a date"); it now reads "Never use file
  timestamps to invent a date".
- **The full suite now passes on the declared minimum Node (22.22.2).** The
  timeout case in `test/distill.test.js` waited on an `AbortSignal.timeout()`
  timer, which is unref'd, so on Node 22.22.2 that subtest and the five after it
  were cancelled with `Promise resolution is still pending but the event loop has
  already resolved` and `npm test` exited 1. A ref'd keep-alive timer now holds
  the loop open until the 20 ms timeout fires. This was found by Task 19's
  minimum-Node regression run, which had not been repeated since the case was
  added.

### Security

- Path handling refuses symlinks at every level, `..`, absolute paths and device
  paths, and refuses to treat an I/O failure (`EACCES`, `EDEADLK`, `EIO`) as
  "file absent" — on cloud-backed storage that is exactly how an offloaded file
  looks.
- A vault under a known macOS cloud root (`~/Library/Mobile Documents/`,
  `~/Library/CloudStorage/`) refuses **reads as well as writes**
  (`vault-cloud-managed`), because an on-demand file is as unsafe to read as it
  is to write.
- Every generated block carries a content hash in its marker
  (`<!-- obsidian-mem:registry begin sha256:… -->` and the `generated` variant).
  A block whose declared hash no longer matches has been edited by a human: the
  write stops and reports a conflict.
- The distillation input is a whitelist projection (real user messages, final
  assistant text, tool names and exit status, bounded paths). It never reads the
  credential store or environment, reasoning blocks, raw tool output, plugin
  injections or subagent transcripts, and a deterministic scan skips any message
  that matches a common credential shape.

### Known limitations and remaining risks

These are stated here as well as in `README.md` because they are properties of
this release, not caveats about it. Nothing in this list is a bug report; each
one is a boundary that was measured, or explicitly not measured.

- **Not verified: no live model call.** `ctx.llm.stream` was measured against the
  installed host in `docs/p0-compatibility.md` §8, but the distillation code path
  itself has only ever run against stubs built to those measured shapes. It has
  never distilled a real turn on a real route.
  *(Superseded by Unreleased: the isolated-profile smoke now distils a real turn
  through the real route — `docs/smoke-results.md`.)*
- **Not verified: no power-loss test.** Crash recovery is exercised with
  `SIGKILL` at specific barriers, not with an actual power cut or a kernel-level
  flush failure.
- **Not verified: cross-process lock contention.** The whole-vault write lock is
  exercised within one process and against a dead child; two live processes
  contending for the same vault have not been tested. The lock does not restrain
  Obsidian or any other editor at all.
- **Not verified: Obsidian's own rendering.** GUI rendering, typed properties and
  the property-type registry (`.obsidian/types.json`) have not been checked
  against a running Obsidian. The write preflight can only see types visible in
  note bytes.
- **Not verified: `fork` / `retain` across sibling worktrees.** Both modes have
  tests, but not on the worktree-sibling layout they exist for.
- **Not verified: the 0.1.5 line's read/replay side for a `plugin:` kind.**
  `docs/p0-compatibility.md` §10 measured that line's *writer* admits the kind the
  recall source now carries, but no real session was replayed through it here, so
  whether its reader adds any further kind filtering is not known. The 0.1.7 read
  side *is* covered — the conversion in §10 case C runs the production catalog
  restore over a real v3 session.
- **Residual path-jail limits.** Hard links and bind mounts are indistinguishable
  from ordinary files, and there is a classic `lstat` → `open` TOCTOU window on
  the write path.
- **`withVaultLock` is not re-entrant.** A nested acquisition would deadlock.
- **A `no-binding` or `no-route` job re-arms indefinitely** rather than becoming
  terminal, at a bounded rate of at least one queue-file write per idle window.
- **`MAX_REFUSED_ENTRIES = 32` caps a job's refusal audit**, so a receipt can
  report 32 when more candidates were dropped.
- **`dsh.plugin.json` is inert.** Nothing in DSH core reads it, so a stale
  version there has no runtime effect — which is exactly why `prepack` fails when
  it disagrees with `package.json`.
- **The Chinese README has not been reviewed by a native reader.**
  `README.i18n.yaml` records the two blob hashes as consistent, which proves the
  pair is the revision that was intended, not that the Chinese reads well. A
  wording fix on that side is a welcome pull request.
