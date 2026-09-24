# Running this memory layer under Codex

`dsh-obsidian-mem` is a **DSH host plugin**: its six tools are Cordis tool
registrations, its automation hangs off DSH events (`agent/session-start`,
`agent/turn-stopping`, the pre-step injection), and it is installed with
`dsh plugin add`. None of that exists in Codex, so the plugin itself cannot be
installed there. Two of its three layers can:

| Layer | Under Codex | How |
|---|---|---|
| **Protocol** — the vault layout, the `.obsidian-mem` pointer, the note frontmatter, routing, evidence/supersede rules | ships as an Agent Skills skill | `codex plugin add dsh-obsidian-mem@dsh-obsidian-mem-local` |
| **Adapter** — the six `mem_*` tools over the same `lib/` | ships as an MCP server in the same plugin | the plugin's `.mcp.json` |
| **Automation** — distillation of finished turns, recall injection at session start | **not portable** | MCP offers tools, not turn boundaries; the agent calls `mem_brief` and `mem_write` itself |

There is exactly **one copy of the memory layer**. The MCP server is
`codex/server.mjs`, and it imports `lib/` from this checkout rather than vendoring
a second copy, so a fix in `lib/` reaches both harnesses.

## Install

Node `>= 22.22.2` (the same measured floor as the plugin) and `npm ci` in this
checkout, because the memory layer needs `yaml` and `@deepseek-ai/schemastery`
from `node_modules/`.

```sh
npm ci                       # once per checkout
node codex/prepare.mjs       # writes the plugin's generated .mcp.json

codex plugin marketplace add "$PWD/codex/marketplace"
codex plugin add dsh-obsidian-mem@dsh-obsidian-mem-local

codex plugin list            # expect dsh-obsidian-mem from dsh-obsidian-mem-local
codex mcp list               # expect obsidian-mem
```

`prepare.mjs` is not optional: Codex **materializes** a plugin — it copies the
plugin directory into `~/.codex/plugins/cache/<marketplace>/<plugin>/` — so a
relative path out of the plugin would break the moment it is installed. The
generated `.mcp.json` therefore names this checkout by absolute path. That file is
git-ignored; re-run `prepare.mjs` after moving the checkout.

### The lighter variant: MCP only

If you want the tools without the skill, skip the marketplace entirely:

```sh
codex mcp add obsidian-mem --env DSH_HOME="$HOME/.dsh" -- node "$PWD/codex/server.mjs"
```

## Verify

```sh
node codex/prepare.mjs --check          # 6 tools, skill and .mcp.json present and current
node --test test/codex-mcp.test.js      # a real handshake, write and search over stdio
```

The test file drives the server as a subprocess with a throwaway `DSH_HOME`,
vault, home directory and git repository, so it never touches your vault, your
`~/.dsh` or `~/.codex`.

**What is verified, and what is not.** Verified on this machine: the marketplace
and the plugin install (`codex plugin list` reports `installed, enabled`), the
plugin materialises with its skill and `.mcp.json` intact, `codex mcp list` shows
the `obsidian-mem` server `enabled` with the generated command and environment,
and the server's protocol, tool surface and a real write-then-search round-trip
pass over stdio (`npm test` → 572 cases). **Not verified: that a live Codex turn
actually calls one of these tools.** A turn needs a model the account can run, and
this machine's Codex CLI rejects both the configured `gpt-6-sol` and `gpt-5-codex`
with `not supported when using Codex with a ChatGPT account` before a tool is ever
reached. Registration and protocol are proven; the model call is not.

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

- **Nothing is automatic.** No turn is distilled and no brief is injected. The
  skill tells the agent to call `mem_brief` when it starts work and to write what
  matters; if it does not, nothing is remembered.
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

Removing the plugin deletes Codex's copy in `~/.codex/plugins/cache/`. The vault
and `$DSH_HOME/data/obsidian-mem` are untouched — that is the point of keeping
memory in plain Markdown.
