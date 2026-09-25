# AGENTS.md — working on `dsh-obsidian-mem`

This file is for anyone (human or agent) changing this repository. It is *not*
part of the published package: `package.json`'s `files` allowlist ships `lib/`,
the portable skill, the two manifests, `README.md`, `CHANGELOG.md` and
`LICENSE`, and deliberately excludes this file, `docs/`, `test/`, `scripts/`,
`codex/`, `research/` and `scratch/`. Two files ride along without being listed,
because npm packs a root `README*` regardless of `files`: measured on npm 11.12.1
with `npm pack --ignore-scripts`, the tarball is 33 files and carries
`package/README.zh.md` and `package/README.i18n.yaml`.

> An earlier revision of this paragraph said 32 files and that
> `README.i18n.yaml` was **not** packed. That was wrong: it was inferred from a
> run made before the file existed. The counts above come from running the pack
> with both files on disk, and the commit message that introduced the wrong
> figure is left as it stands rather than rewritten.

## What this repository is

A DeepSeek Harness **host-side** plugin. It writes project documents and
long-term memory into a dedicated Obsidian vault as plain Markdown. The vault
content is the product; the plugin is one adapter for a protocol that any harness
could read.

- `lib/` — the plugin. The only shipped code.
- `skills/obsidian-mem/SKILL.md` — the portable methodology skill, synced into
  `$DSH_HOME/skills/obsidian-mem/` at activation.
- `cordis.patch.yml` — the bundle patch that mounts the plugin row.
- `dsh.plugin.json` — ecosystem/registry metadata. **Nothing in DSH core reads
  it**; it is a published convention (see `research/dsh-plugin-api-reference.md`
  §1.3). It ships anyway because registry tooling expects it.
- `README.md` + `README.zh.md` — the bilingual documentation pair. Both sides
  carry equal authority; see rule 7.
- `README.i18n.yaml` — the blob-hash record that says which two revisions of that
  pair were last confirmed consistent.
- `docs/p0-compatibility.md` — the measured host facts every design decision
  rests on. Read it before changing anything that touches sessions, events or
  `ctx.llm`.
- `docs/superpowers/{specs,plans}/` — the frozen design and the task plan.
- `test/` — `node --test` only, no test framework.
- `codex/` — the Codex CLI adapter. An MCP server that imports `lib/` rather than
  copying it, a Codex edition of the portable skill, and a local marketplace so
  `codex plugin add` installs both. It is the *second* entry point into `lib/`,
  which is why `test/codex-mcp.test.js` pins the tool surface against
  `TOOL_NAMES`/`TOOL_PARAMETERS`. Not shipped.
- `scripts/verify-pack.mjs` — the pack verifier `prepack` runs.
- `research/`, `scratch/` — investigation output. Not shipped, not authoritative.

## Commands

| When | Command | What it actually runs |
|---|---|---|
| Once | `npm ci` | install exactly the lockfile |
| Before every commit | `npm run check:fast` | eslint and prettier over the **staged blobs**, the two fitness tests, and the Unreleased gate. Measured at 1.0–1.5 s for a one-file change; wire it up with `npm run hooks:install` |
| Before every push | `npm run check` | `lint` → `format:check` → `types` → `prepack` (the suite, then the pack verifier) → `pack:check` (packs for real and reads the archive) |
| Release | `npm run prepack` | the suite and `scripts/verify-pack.mjs`. Still read-only, still no build step |
| Opt in | `npm run hooks:install` | sets `core.hooksPath` to `.githooks` for this checkout, printing the value before and after. The **only** command here that writes git configuration, and it has to be asked for |

`npm test` is `node scripts/run-tests.mjs`. That wrapper creates a throwaway
directory, sets `DSH_HOME` to it, runs `node --test test/*.test.js`, and removes
the directory afterwards. **Keep it that way.** One earlier change shipped a test
that installed into the real `~/.dsh` because the isolation was convention-only;
the wrapper makes it structural. If you add a test that activates the plugin with
`enabled: true`, still pass an explicit temporary `dataRoot`/`DSH_HOME` — the
wrapper protects the home, not the test's own assumptions.

Never point a test, a probe or a manual run at `~/Documents/knowledge`, at
`$DSH_HOME/data/obsidian-mem/` of a real home, or at any real vault. Use
`mktemp -d`.

## Where the truth lives

Read this before searching the tree. Each row is a symptom, where to look first,
and — where one exists — the command that answers it.

| Symptom | Look here |
|---|---|
| A write did not land, or landed somewhere unexpected | `lib/transaction.js` and `test/transaction.test.js`. `mem_admin(action="jobs")` for the queue, `mem_admin(action="diagnostics")` for this process's decisions |
| The brief did not arrive, or arrived wrong | `lib/brief.js` and `lib/hooks.js`; the `brief` event in the diagnostics window carries `injected`/`hint-only`/`none` |
| Distillation produced nothing | `lib/distill.js`; the queue state is in `mem_admin(action="jobs")` |
| A bind was refused | `lib/vault.js`; the `bind` event carries the refusal code |
| The queue stopped moving | `lib/pending.js` and `mem_admin(action="jobs")` |
| The skill did not sync | the `skill` event, then `lib/assets.js` |
| The package is wrong | `scripts/verify-pack.mjs` (manifest contract) and `scripts/verify-tarball.mjs` (the real archive). `npm run pack:check` |
| A `codex-mcp` test fails after copying the checkout | `.mcp.json` is generated and holds absolute paths — run `node codex/prepare.mjs` |
| Anything touching sessions, events, `ctx.llm` or injection timing | `docs/p0-compatibility.md` **first**. It holds the measured host facts; a comment in `lib/` does not |
| The module layout, or a file that grew | `test/architecture.test.js`. The layer table and the size budgets are there, and growing past one is meant to be a decision |

## Rules that are not negotiable

1. **Never edit a user's configuration.** No script here may add, remove or
   rewrite a row in a real `$DSH_HOME/cordis.patch.yml`, and `prepack` in
   particular must stay a read-only verifier. Disabling or removing another
   plugin is the user's edit and not this repository's business: the README
   deliberately names no other plugin, because doing so was read as a
   requirement. This plugin requires nothing of the sort — it does not care what
   else is mounted.
2. **`prepack` verifies; it does not build.** It runs the suite and
   `scripts/verify-pack.mjs`. It must not launch Obsidian, must not write inside
   a vault, and must not run `npm pack` (that re-enters `prepack`).
3. **No `Co-Authored-By` lines.** Commits carry no trailer attributing an agent.
4. **The vault is never the plugin's scratch space.** Caches, locks, receipts,
   the transaction journal and the pending queue live under
   `$DSH_HOME/data/obsidian-mem/`, derived from `DSH_HOME` in exactly one place
   (`resolveDataRoot()`); the index is rebuildable and never the source of truth.
5. **`engines.node` is a measurement, not an estimate.** It is `>=22.22.2`
   because that is the lowest version tested to have `node:sqlite` **with
   FTS5**. Node 22.13.0 imports `node:sqlite` but has no FTS5; 22.14–22.21 are
   untested. If you want to move the floor, measure it first and say what you
   measured — do not round a guess into a guarantee.
6. **A claim needs evidence in this repository.** If something was not run, it is
   written as unverified, not as passing, and an item moves out of the untested
   list only with a command and its output. That list lives in `CHANGELOG.md` —
   `0.1.0`'s *Known limitations and remaining risks*, plus every Unreleased entry
   — and no longer in the README, which carries the boundaries a reader needs
   before enabling writes and says plainly that it is not exhaustive. Keep the
   changelog honest when you land work.
7. **The README pair moves together.** `README.md` and `README.zh.md` carry equal
   authority, so one commit edits both or neither. `README.i18n.yaml` records the
   git blob hash of each side as of the last confirmed-consistent state; after
   touching either side, run `git hash-object README.md README.zh.md` and put the
   two values back into that file. The first-party verifier for this convention
   (`verify-translation-pairing`) belongs to the harness monorepo, not to this
   plugin, so that one command is the whole check here. A heading that a link
   targets carries an explicit `<a id="…">` in the Chinese side, spelled with the
   English slug, so that one anchor resolves from either language — add one
   whenever you add such a link.

## House style

- ES modules, `node:`-prefixed builtins, and **two runtime dependencies**:
  `schemastery` and `yaml`. Adding a third needs a reason in the PR text. The
  devDependencies are a separate budget and a looser one — eslint, `@eslint/js`,
  globals, prettier, typescript and `@types/node` are pinned exactly, and none of
  them is loaded by the plugin at runtime.
- Two-space indent, single quotes, **no semicolons**, JSDoc on exported
  functions. Comments explain *why* a decision was made and what it costs if it
  is wrong; they do not restate the code.
- Tests assert behaviour through the real seam (the same Standard Schema entry
  the host uses, the same lock, the real `@deepseek-ai/dsh-tools`) rather than a
  mirror of the implementation.
- New behaviour gets a test that fails before it and passes after. Report both.

## Verifying a change before you commit

```sh
npm run check                         # the whole gate: lint, format, types, suite, pack contract, real archive
git diff --check                      # no whitespace damage
```

`npm run check` is the same command CI runs, deliberately: a check that exists only
in CI is one that passes locally and fails on push.

`npm run types` is a **ratchet**, not a whole-tree claim: it checks the files
listed in `tsconfig.json` and marked `// @ts-check`, and a file outside that list
is unchecked no matter how it looks. `test/repo-hygiene.test.js` keeps the two
lists equal in both directions so a marker cannot be silently inert.

For packaging, `npm run pack:check` already builds a real tarball, lists it, and
checks it against the contract, so there is no manual step left to remember.
(`npm pack` on its own runs `prepack`, so a bare `--dry-run` runs the whole suite
before it prints anything; `--ignore-scripts` keeps the two checks separate.)
For anything that touches the host seam (events, `ctx.llm`, injection timing),
re-read `docs/p0-compatibility.md` first and put the measurement back there
rather than trusting the comment in `lib/`.
