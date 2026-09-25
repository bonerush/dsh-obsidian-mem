# Running this memory layer under Codex

`dsh-obsidian-mem` is a **DSH host plugin**: its six tools are Cordis tool
registrations, its automation hangs off DSH events (`agent/session-start`,
`agent/turn-stopping`, the pre-step injection), and it is installed with
`dsh plugin add`. None of that exists in Codex, so the plugin itself cannot be
installed there. Its layers travel unevenly:

| Layer | Under Codex | How |
|---|---|---|
| **Protocol** — the vault layout, the `.obsidian-mem` pointer, the note frontmatter, routing, evidence/supersede rules | ships as an Agent Skills skill | `codex plugin add dsh-obsidian-mem@dsh-obsidian-mem-local` |
| **Adapter** — the six `mem_*` tools over the same `lib/` | ships as an MCP server in the same plugin | the plugin's `.mcp.json` |
| **Recall injection** — the brief, before the first model call | ships as a `SessionStart` hook in the same plugin | the plugin's `hooks/hooks.json`, approved once — see *Install* |
| **Distillation** — turning finished turns into notes | **not portable** | MCP offers tools, not turn boundaries; a note is written when the agent decides to write one |

There is exactly **one copy of the memory layer**. The MCP server is
`codex/server.mjs` and the hook is `codex/session-start.mjs`; both import `lib/`
from this checkout rather than vendoring a second copy, and the hook composes no
text of its own — it injects `brief.text` from `lib/brief.js`, the same field the
DSH pre-step injects. A fix in `lib/` reaches both harnesses.

## Install

Node `>= 22.22.2` (the same measured floor as the plugin) and `npm ci` in this
checkout, because the memory layer needs `yaml` and `@deepseek-ai/schemastery`
from `node_modules/`.

```sh
npm ci                       # once per checkout
node codex/prepare.mjs       # writes the generated .mcp.json and hooks/hooks.json

codex plugin marketplace add "$PWD/codex/marketplace"
codex plugin add dsh-obsidian-mem@dsh-obsidian-mem-local

codex plugin list            # expect dsh-obsidian-mem from dsh-obsidian-mem-local
codex mcp list               # expect obsidian-mem
```

`prepare.mjs` is not optional: Codex **materializes** a plugin — it copies the
plugin directory into `~/.codex/plugins/cache/<marketplace>/<plugin>/` — so a
relative path out of the plugin would break the moment it is installed. Both
generated files therefore name this checkout by absolute path. They are
git-ignored; re-run `prepare.mjs` after moving the checkout.

**Then approve the hook, once.** Start a session and Codex opens its startup hooks
review — a hook it has not seen before reads *"hooks are new or changed"* and
*"hooks need review before they can run"*, listed by source. Approve
`dsh-obsidian-mem`'s and the brief is injected from then on. Until you do, an
untrusted hook is skipped **in silence**: no error, no context, no memory. This is
measured, not assumed — a trusted run leaves an index under a fresh `DSH_HOME`
and an untrusted one leaves the directory empty (`test/codex-hooks.test.js`
carries the script half of that pair; `CHANGELOG.md` carries the transcript).

If you would rather not be asked — for automation that already vets what it runs —
`codex --dangerously-bypass-hook-trust …` runs enabled hooks without the review,
and Codex prints a warning item into the session saying so.

### The lighter variant: MCP only

If you want the tools without the skill, skip the marketplace entirely:

```sh
codex mcp add obsidian-mem --env DSH_HOME="$HOME/.dsh" -- node "$PWD/codex/server.mjs"
```

This variant has **no hook**: a hook belongs to a plugin, so registered this way
the agent must call `mem_brief` itself and nothing is injected for you.

## The `SessionStart` hook

`codex/session-start.mjs` is the whole of it, and it is a *reader*: it opens the
vault, asks for the brief for the session's own working directory, and answers.
What it does with the answer is the only decision in the file, and it is made in
`decide()`, where a test can read it:

- **`source: "startup"` and `"clear"`** — the two that open a conversation with no
  project context in it — inject.
- **`"resume"` and `"compact"`** do not. Both continue a conversation that already
  carries the earlier injection or its summary, so paying for the same brief twice
  is the one cost this hook can avoid for nothing.
- **A directory with no `.obsidian-mem` pointer** injects nothing. That is most
  directories on any machine, and it is not a refusal: the session starts as if the
  plugin were not installed.

Two measured details are worth knowing before you debug it, both from codex-cli
0.146.0. The hook's `matcher` is left as `"*"` — on this event Codex matches the
session's `source`, not a tool name, so a matcher would be a second place to state
the rule above. And `timeout` is 15 seconds: a vault that hangs costs a session
fifteen seconds and then is dropped, never its start.

**It cannot break a session.** Every path writes one JSON object and exits 0 —
unreadable stdin, an unbound directory, a vault that refuses to open. Failures go
to stderr, where they belong, and only when something actually went wrong; set
`OBSIDIAN_MEM_HOOK_DEBUG=1` to also hear the reasons for the quiet paths. To turn
it off, remove `hooks/hooks.json` from the installed copy or uninstall the plugin —
nothing else in the plugin depends on it.

## Verify

```sh
node codex/prepare.mjs --check          # 6 tools, skill and both generated files
node --test test/codex-mcp.test.js      # a real handshake, write and search over stdio
node --test test/codex-hooks.test.js    # the hook: injection, skipping, fail-open
```

Both test files drive the real thing as a subprocess — the server over stdio, the
hook through a `SessionStart` payload on stdin — with a throwaway `DSH_HOME`,
vault, home directory and git repository, so they never touch your vault, your
`~/.dsh` or `~/.codex`.

**What is verified, and what is not.** Verified on this machine, against
codex-cli 0.146.0: the marketplace and the plugin install (`codex plugin list`
reports `installed, enabled`), the plugin materialises with its skill, `.mcp.json`
and `hooks/hooks.json` intact, `codex mcp list` shows the `obsidian-mem` server
`enabled`, and the server's protocol, tool surface and a real write-then-search
round-trip pass over stdio. The hook is verified further than the tools are:
`hooks/list` reports it with `source: "plugin"` and this plugin's id, a session
start with the hook trusted runs it (a fresh `DSH_HOME` gains the index it built)
where an untrusted one does not, and the brief lands in the session's own rollout
as a `developer` message — Codex's role for hook context, where DSH uses a
`user` message with a plugin source. Same text, each harness's own convention.

**Not verified: that a live Codex turn then *acts* on any of it.** A turn needs a
model this account can run, and this machine's Codex CLI rejects both the
configured `gpt-6-sol` and `gpt-5-codex` with `not supported when using Codex
with a ChatGPT account` before a tool is ever reached. Discovery, the trust gate,
injection into the session and the tool protocol are all proven with the real
binary; what a model does with the context is not.

## Where the data goes

| What | Default | Override |
|---|---|---|
| Vault | `~/Documents/dsh-memory` (the plugin's own default) | `OBSIDIAN_MEM_VAULT`, or `vaultPath` in the DSH row |
| Index, locks, receipts, queue | `$DSH_HOME/data/obsidian-mem` — **shared with the DSH side** | `DSH_HOME` |
| Binding pointer | `<repository>/.obsidian-mem`, committed | — |
| Working directory the tools bind | the client's MCP `roots/list` answer | `OBSIDIAN_MEM_CWD` |

Sharing the data root is deliberate: one lock, one receipt set, one index for one
vault whichever harness is writing.

## What behaves differently

- **The brief is automatic; nothing else is.** A session that starts in a bound
  repository gets its recall injected before the first model call, whether or not
  the model asks. Everything after that is the agent's choice: the skill tells it
  to write what matters, and no turn is distilled — MCP has no turn boundary to
  hang that on. A session where the agent writes nothing still remembers nothing.
- **The working directory comes from the client.** Codex launches a plugin's MCP
  server with the plugin directory as its cwd, so the server asks for
  `roots/list` and uses the first root. A client that does not answer within two
  seconds leaves the server on `process.cwd()`, which binds the wrong project —
  set `OBSIDIAN_MEM_CWD` if you see that.
- **Two harnesses can write the same vault.** They serialize through the same
  vault lock; cross-process contention is the least-tested part of the plugin
  (see the repository README's *Honest limits*).
- **A note written by Codex is foreign to the DSH side.** Ownership is proven by a
  receipt, and a hand-written note has none, so the plugin will not modify it —
  it reports the conflict instead. That is the designed behaviour, not a bug.

## Uninstall

```sh
codex plugin remove dsh-obsidian-mem@dsh-obsidian-mem-local
codex plugin marketplace remove dsh-obsidian-mem-local   # optional
codex mcp remove obsidian-mem                            # if you used the lighter variant
```

Removing the plugin deletes Codex's copy in `~/.codex/plugins/cache/` — which
takes the `SessionStart` hook with it, so the next session injects nothing. The
vault and `$DSH_HOME/data/obsidian-mem` are untouched — that is the point of
keeping memory in plain Markdown.
