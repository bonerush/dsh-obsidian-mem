# Isolated-profile smoke test

This directory proves that `dsh-obsidian-mem` works as a **mounted DSH host
plugin** — not just as a library under `node --test`. It installs this checkout
into a throwaway `DSH_HOME` with `link:`, drives real headless sessions against a
throwaway vault, and checks the result.

Nothing here is shipped: `package.json`'s `files` allowlist excludes `test/`.

## Files

| File | What it is |
|---|---|
| `run-smoke.mjs` | The runner. Builds the temp home/vault/repo, installs the plugin and driver, drives the passes, writes one run record. |
| `verify.mjs` | The acceptance checker. Reads a run record, re-derives the Obsidian facts from the temp vault, and exits non-zero on any failure. |
| `negative-controls.mjs` | Breaks one acceptance condition at a time and asserts `verify.mjs` fails for each. |
| `driver/` | A discardable DSH row (its own bundle patch) installed beside the plugin. It calls the plugin's six real `mem_*` tools, witnesses the lifecycle, and holds the process open at the durability boundary. |

## Safety

The runner never touches a real profile or a real vault.

- Every path lives under the OS temp root. `run-smoke.mjs` refuses a `--base`
  outside it, and `verify.mjs` refuses any record or vault path outside it.
- `DSH_HOME` is always set for every child process, so the plugin's data root
  (`$DSH_HOME/data/obsidian-mem`) is the temp one.
- The model credential only ever enters a child process environment. It is read
  from `DEEPSEEK_API_KEY`, or from the `refs` entry of `~/.dsh/.credentials.yaml`
  when it is not set, and is never printed, written into the temp home, or put in
  a record.
- The record and the vault contain no prompts, no model output bodies and no note
  bodies: versions, counts, ids, paths, hashes, event/seq numbers and PASS/FAIL
  only.
- The run record fingerprints the real `~/.dsh` before and after; a difference
  fails the checker.

## Running it

```sh
# 1. Capture a record. Prints the record path and the temp base directory.
node test/smoke/run-smoke.mjs --out /tmp/smoke-record.json

# 2. Check it. Re-reads the temp vault, so run it before deleting that directory.
node test/smoke/verify.mjs /tmp/smoke-record.json

# 3. Prove the checker can fail.
node test/smoke/negative-controls.mjs /tmp/smoke-record.json

# 4. Clean up (the runner deliberately keeps the tree for step 2).
rm -rf "$(node -e 'console.log(require(process.argv[1]).paths.baseDir)' /tmp/smoke-record.json)"
```

Optional environment: `DSH_SMOKE_DISTILL_PROVIDER` / `DSH_SMOKE_DISTILL_MODEL`
pin the distill route (default: the profile's own `agent-default-model` row),
`DSH_SMOKE_OBSIDIAN_VERSION` records the Obsidian version you opened the vault
with, and `DSH_BIN` overrides the `dsh` executable.

## What it actually drives

Real sessions in the isolated profile:

1. **The row is mounted** — `dsh --profile smoke --dump-config` contains
   `- id: obsidian-mem` with the runner's config.
2. **First-step recall** — on the first step of the first session exactly one
   plugin recall message is committed before the first `request/header`, and its
   length is inside `briefBudgetChars`.
3. **The six tools** — a driver pass calls `mem_admin` (bind + read-only lint),
   `mem_write`, `mem_search`, `mem_read`, `mem_brief` and `mem_log` through
   `ctx.tools.get(name).execute(args, exec)`, i.e. the same definitions the model
   calls.
4. **A document write** — a Chinese document is written into the temp vault and
   found again by a Chinese query.
5. **A supersede chain** — the old note survives with `status: superseded` and
   `superseded_by`, the default search drops it, `includeHistory: true` finds it.
6. **Capture and apply** — a completed turn is captured into a durable pending
   job; the process is then SIGKILLed at that boundary. The restart's worker
   resumes the job, once with `distill.dryRun: true` (the vault must not change
   across the apply) and once with `dryRun: false` (the vault must change).
7. **Restart recovery is not duplicated** — exactly one result receipt exists for
   the killed job, and no note id appears twice in the vault.
8. **An external edit survives** — a plugin-owned note is edited outside the
   plugin, and a `trust: owner` file the plugin tries to update and supersede is
   byte-identical afterwards.

## What it does not prove

- **Obsidian GUI behaviour.** Anything that needs the Obsidian application (that
  `tags` renders as a property list, that a date field shows as a date, that a
  wikilink is clickable) is recorded as *unverified* unless someone opens the
  temp vault and says otherwise. The filesystem half — YAML parses under `yaml`
  v2, `tags` is an array, date fields are `YYYY-MM-DD`, every wikilink resolves by
  basename or path, `.obsidian/` is untouched — is checked for real, by
  `verify.mjs`, against the vault on disk.
- **The in-process retry.** A captured job is applied by the worker's boot pass on
  the next start. See `docs/smoke-results.md` for the measured behaviour of an
  in-session retry, which is reported there rather than assumed here.
- **Anything outside a temp vault.** Real user vaults, cloud-managed vaults and a
  real `~/.dsh` are out of scope by construction.
