# Prompt-scoped recall for DSH and Codex

## Goal and scope

Give an agent a small pointer to relevant project notes when a new user turn
arrives. The agent reads full notes with `mem_read` when useful. This change
covers retrieval in DSH and Codex; automatic Codex distillation is a separate
write pipeline with different privacy and lifecycle requirements.

## Shared retrieval policy

`lib/prompt-recall.js` owns the policy. It takes the current user prompt, a
project-scoped search function, a set of paths already shown in this session,
and a character budget. It searches at most eight candidates, selects at most
three with substantial lexical overlap or an exact/containing title or phrase
match, and emits a maximum of 360 Unicode code points. The output identifies
results as quoted vault data, includes only paths and short titles, and directs
the agent to `mem_read` for full text. It never copies a note body into the
automatic message. Prompts and titles are never saved as recall state.

Only a real user message supplies a query. Plugin messages, runtime context,
empty prompts, and a prompt too short to give a meaningful search are ignored.
The search defaults to the bound project and excludes superseded/archived
notes, inheriting `mem_search`'s scope and index readiness rules. A failed
search is a visible diagnostic where a process logger exists and a quiet
no-op for the model; it never blocks a turn.

## DSH adapter

`agent/pre-step` receives the claimed user messages before the model request.
After `await next()`, the existing brief/hot-delta path continues as before.
At most once per turn, the adapter extracts text from `source.kind === 'user'`,
calls the shared policy through the same `services.search` instance used by
`mem_search`, and appends one separate plugin-source user message if the policy
returns a map. It keeps shown paths in the session's existing state map and
spends only the remaining `briefBudgetChars` for that step. A rejected,
aborted, or disabled decision receives no map. State is committed only after
the extended decision is assembled.

## Codex adapter

The installed plugin keeps `SessionStart` and adds `UserPromptSubmit`. The new
script reads Codex's JSON payload, confirms the cwd belongs to a bound project,
opens the same `lib/` service layer as the MCP server, and returns one
`hookSpecificOutput.additionalContext` map or `{ "continue": true }`. It
always exits successfully and writes protocol JSON only to stdout. The command
uses the generated absolute path, as `SessionStart` does.

Codex starts a new hook process per prompt. A tiny state file under the plugin
data root stores only the paths previously shown for the session. Its filename
is a hash of the session id, its content is bounded, and writes are atomic with
private permissions. No vault path, prompt, or note text goes into this file.
An absent or unreadable state file means an empty set; a state-write failure
does not block the user prompt.

## Verification

Tests first demonstrate a failing shared-policy case, a failing real Cordis
waterfall case, and a failing Codex subprocess/config case. Isolated fixtures
cover a bound and an unbound project, irrelevant queries, duplicate paths,
source filtering, budget, and fail-open behavior. Run `npm run check`,
`git diff --check`, generated-file verification, and a Codex hook probe with a
temporary home and vault. Any claim of end-to-end model use needs a separate
real Codex and DSH session measurement; unit tests alone do not establish it.

## Constraints

- Do not edit user DSH or Codex configuration, a real vault, or the npm package
  contents outside the existing `files` contract.
- Keep `lib/tools.js` and the six tool contracts stable.
- Preserve the DSH producer-owned source kind `plugin:obsidian-mem`.
- Keep `README.md` and `README.zh.md` paired and refresh
  `README.i18n.yaml` if either changes.
