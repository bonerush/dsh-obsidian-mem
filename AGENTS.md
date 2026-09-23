# AGENTS.md — working on `dsh-obsidian-mem`

This file is for anyone (human or agent) changing this repository. It is *not*
part of the published package: `package.json`'s `files` allowlist ships `lib/`,
the portable skill, the two manifests, `README.md`, `CHANGELOG.md` and
`LICENSE`, and deliberately excludes this file, `docs/`, `test/`, `scripts/`,
`research/` and `scratch/`.

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
- `docs/p0-compatibility.md` — the measured host facts every design decision
  rests on. Read it before changing anything that touches sessions, events or
  `ctx.llm`.
- `docs/superpowers/{specs,plans}/` — the frozen design and the task plan.
- `test/` — `node --test` only, no test framework.
- `scripts/verify-pack.mjs` — the pack verifier `prepack` runs.
- `research/`, `scratch/` — investigation output. Not shipped, not authoritative.

## Commands

```sh
npm ci                 # install exactly the lockfile
npm test               # the whole suite, with DSH_HOME pointed at a temp dir
npm run prepack        # npm test, then the pack verifier
npm pack --dry-run --ignore-scripts   # inspect the tarball manifest only
```

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

## Rules that are not negotiable

1. **Never edit a user's configuration.** No script here may add, remove or
   rewrite a row in a real `$DSH_HOME/cordis.patch.yml`, and `prepack` in
   particular must stay a read-only verifier. The Hindsight change is documented
   for the user to apply by hand in `README.md`.
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
   written as unverified, not as passing. `README.md` has a "Not verified"
   section and `CHANGELOG.md` carries the same list; keep both honest when you
   land work, and move an item out only with a command and its output.

## House style

- ES modules, `node:`-prefixed builtins, no dependency beyond `schemastery` and
  `yaml` at runtime. Adding a runtime dependency needs a reason in the PR text.
- Two-space indent, single quotes, **no semicolons**, JSDoc on exported
  functions. Comments explain *why* a decision was made and what it costs if it
  is wrong; they do not restate the code.
- Tests assert behaviour through the real seam (the same Standard Schema entry
  the host uses, the same lock, the real `@deepseek-ai/dsh-tools`) rather than a
  mirror of the implementation.
- New behaviour gets a test that fails before it and passes after. Report both.

## Verifying a change before you commit

```sh
git diff --check                      # no whitespace damage
npm test                              # full suite
npm run prepack                       # suite + pack contract
npm pack --dry-run --ignore-scripts   # eyeball the manifest
```

(`npm pack` runs `prepack`, so a bare `--dry-run` runs the whole suite before it
prints anything. `--ignore-scripts` keeps the two checks separate.)

For anything that touches packaging, also build a real tarball and list it:

```sh
pack_dir=$(mktemp -d)
npm pack --ignore-scripts --pack-destination "$pack_dir"
tar -tf "$pack_dir"/dsh-obsidian-mem-*.tgz
```

For anything that touches the host seam (events, `ctx.llm`, injection timing),
re-read `docs/p0-compatibility.md` first and put the measurement back there
rather than trusting the comment in `lib/`.
