# Plugin settings on the DSH plug-in page — design and plan

**Status:** frozen 2026-11-07 (second pass on the same typed branch: the owner asked
for graphical settings on the DSH plugin detail page, edited on `feat/review-inbox`,
no separate branch)
**Owner:** Lead (DSH session)
**Evidence:** DSH desktop 0.2.2-rc.1 (profile `desktop`), machine-read contracts below;
all paths quoted as `file:line` inside the DSH app.asar where relevant.

## Problem and evidence

- The plugin has ~28 config fields (`lib/config.js`). Today they only change by
  editing `$DSH_HOME/cordis.patch.yml` by hand, which the owner reports as too
  error-prone and too much work.
- DSH already renders, on a plugin bundle's page in the Plugins section, a
  configuration section fed by the slot `plugins.bundle.config`, keyed by the
  bundle's package name (`@deepseek-ai/dsh-client-ui-plugin-manager/lib/client.js:6019-6023`;
  the section renders only when the bundle registered that key,
  `configured = ledger.bundles.has(pkg.name)`, `:7297`). dshmarket, a third-party
  bundle, already registers there (`dshmarket/src/client/index.ts:355-364`), which
  proves the seat is open to third-party bundles.
- The host service `configEditor` is the sanctioned persistence primitive:
  `entries()`, `configuration()`, `edit(entry, change)` — "Persist complete raw
  configs and apply them through the normal Loader path"
  (`@deepseek-ai/dsh-config-editor/lib/index.js:1-137`). Editing a non-volatile field
  re-resolves that row, i.e. the plugin remounts with the new config.
- The client service `configForms` and the `form` prop of the slot only expose
  *volatile* fields (`@deepseek-ai/dsh-settings/lib/index.js:118-158`,
  `:488-516`); converting 28 fields to volatile references would touch every reader
  in `lib/` and is not needed: `configEditor.edit` plus a normal remount is the
  correct lifecycle for a settings save.

## Goals / non-goals

- G1. DSH Plugins page → `dsh-obsidian-mem` detail page shows a **配置** form with all
  meaningful fields, grouped, with current values, defaults and inline validation.
- G2. Saving persists through `configEditor.edit` (profile patch) and the plugin
  remounts; the page reports pending → applied/failed.
- G3. No drift between the form and `Config`: the host projects the schema; the
  client renders whatever the host sends (unknown future keys still render).
- G4. Same-typed-branch delivery: new commits on `feat/review-inbox`; no merge to
  V2 without an explicit request.
- Non-goals: editing `enabled` (the plugin page's own switch owns it); exposing
  volatile/live update semantics; editing the home-level patch from the browser
  without the host service; any change to the `mem_*` tool surface or the panel.

## Design

### Host: `lib/settings-route.js` (new, layer 3)

Imports `route-guard` (L0), `config` (L1) and `debug` (L0). Registers two exact
routes on `webServer`:

- `GET /obsidian-mem/settings` → `{ok:true, value}`; POST handles JSON actions.
  (Read is POST too, to match the panel's shape and keep one code path.)
- `POST /obsidian-mem/settings` with `x-obsidian-mem-panel: 1` and
  `content-type: application/json` (same fence as the panel mutations; a cross-site
  page cannot send that header without a preflight this route never answers).
  Body: `{action:'read'}` | `{action:'save', values}` | `{action:'status', attempt}`.

`read` resolves the current entry through `ctx.get('configEditor')` at request time
(`editor.entries()` filtered by `options.name === 'dsh-obsidian-mem'`; absent service
→ `writable:false` and a reason). Effective raw config = the profile override when
one exists, else the inherited layer row (`editor.configuration()`), then normalized
with `validateConfig` so the client sees every default-filled value. The response
also carries `fields`: a flat projection of `Config` leaves produced by a new
`describeConfigFields()` in `lib/config.js` — `{path, segments, type, default, enum?,
min?, max?, integer?}`, where `path` is the dotted wire form (e.g. `'distill.provider'`, the
shape the landed client consumes) and `segments` is the same path as string[] for tests and
future consumers — plus `lastWrite` and `entry` identity. Hidden paths: `enabled`.

`save` validates `payload.values` with `validateConfig` (all v1 range checks and the
`distill.route` pair rule run before any write); it writes a `pending` status record
to `<dataRoot>/settings-write.json`, then schedules `editor.edit(entry, () => next)`
without awaiting it in the request (the edit remounts this very plugin, so the
response must leave first), and returns `{scheduled:true, attempt}`. The edit's
outcome rewrites the status record `applied` / `failed` with the error message. A
refusal before scheduling is a 400 with the validation message.

`status` returns the stored record for the attempt the page is polling.

`describeConfigFields()` walks `Config.toJSON()`'s ref table to leaf nodes, keeps
schema `meta.default` (resolved through `refs`), `meta.range` bounds where present,
union-of-const nodes as `enum`, arrays as `array` of the inner type, and drops
`enabled`. It is exported for tests and is the single source the client renders.

Wiring: `lib/index.js` registers the route in the same `ctx.inject(['webServer',
'sessions'], ...)` effect as the panel route, with `editor: () => ctx.get('configEditor')`,
`dataRoot`, `diagnostics`, and the plugin's own package name.

### Client: settings section in `lib/client.js`

Inside the existing client module factory, after the better-sidebar tab:

```js
ctx.inject(['slots'], (scoped) => {
  scoped.slots.inject('plugins.bundle.config', () => scoped.slots.register(
    { name: 'plugins.bundle.config', key: PACKAGE_NAME },
    (owner) => owner?.view === 'summary' ? summaryLine() : h(SettingsSection, {}),
  ))
})
```

`SettingsSection` is a React component that:

1. fetches `obsidian-mem/settings` with `{action:'read'}` on mount; states: loading,
   error, ready;
2. renders groups in a fixed order — 基础 / 采集与整理 / 上下文预算 / 模型蒸馏 / 检索 /
   其他 — using a bilingual label dictionary keyed by path (unknown paths fall back to
   the raw key and the host description); field controls by host `type`:
   boolean → checkbox (role switch style), enum → select, integer/number → number
   input, string → text input, string array → textarea one item per line;
3. keeps a local draft; inline range/pair checks are advisory, the host's `save`
   response is authority; shows the host validation message on refusal;
4. on save POSTs `{action:'save', values}`, then polls `{action:'status', attempt}`
   every 600 ms up to 20 s; on `applied` re-reads the values and shows 已保存；on
   `failed` shows the message; on timeout says the plugin did not answer and points
   at `mem_admin(action="diagnostics")`;
5. offers 恢复默认 (draft := schema defaults) and 刷新 (re-read), and sends nothing
   else. `view:'summary'` renders one quiet line (记忆与整理配置).

All UI copy goes through the module's existing zh/en `text()`; styling is inline
using only `--dsw-alias-*` tokens (`label-primary`, `label-secondary`, `border-l1`,
`bg-layer-1`, `state-error-primary`, `state-success-primary`, `brand-primary`) so no
stylesheet or class contract is added.

### Required values and bounds

- Response body ≤ 16 KiB read / 8 KiB status; body input ≤ 64 KiB; `values` must be
  JSON-shaped and is validated by `validateConfig` (which refuses unknown keys).
- No session, no vault binding and no vault read are involved; the route reads and
  writes only the profile config row.

## Failure paths

- `configEditor` absent → `writable:false`, reason `editor-unavailable`; the form
  renders read-only with a hint that configuration must be edited in the profile.
- No entry (plugin row not installed through the Loader) → `writable:false`, reason
  `entry-missing`.
- Invalid values → 400 `{code:'invalid-config', message}`; nothing written.
- `edit` rejects (home patch overrides the row, entry replaced, fiber not active) →
  status `failed` with the message; the client shows it.
- Save while another save is pending → 409 `save-in-flight`.
- The plugin remounts after a successful write; the page's next poll re-reads the
  new values through the re-registered route. A page left open through the remount
  keeps polling and recovers.

## Acceptance criteria

1. `GET/POST /obsidian-mem/settings` read returns `fields` (projection of `Config`),
   `values` (defaults-filled), `defaults`, `writable`, `entry`, `lastWrite`.
2. Save with invalid values is a 400 and writes nothing; save with valid values
   schedules exactly one `editor.edit`, and the status record goes pending → applied.
3. The fence refuses a missing header or non-JSON body; the body bound refuses an
   oversized payload.
4. `describeConfigFields()` covers exactly the `Config` keys minus `enabled`, and a
   test pins that.
5. The client registers `plugins.bundle.config` keyed `dsh-obsidian-mem` through a
   nested `slots` inject, renders the groups, and never crashes when the slot/view is
   summary, when the route 404s, or when `writable:false`.
6. Client save flow: POST save → poll status → applied shows success and re-reads;
   failed shows the message; timeout shows the restart hint.
7. `npm run check` green; README pair gains a "在插件页配置" section (both languages,
   hash pair updated), the shipped skill notes the page, CHANGELOG Unreleased names
   the feature and the measured gate.
8. No merge into V2 and no push; delivery is commits on `feat/review-inbox` and a
   reinstalled desktop snapshot for the owner's test.

## Tasks

- **Task 6 (host)** — new `lib/settings-route.js`, `describeConfigFields()` in
  `lib/config.js`, wiring in `lib/index.js`, tests `test/settings-route.test.js`
  (fake `webServer`/`configEditor` like `test/panel-route.test.js`'s harness).
- **Task 7 (client)** — settings section in `lib/client.js` (nested slots inject,
  schema-driven form, save/poll), tests in `test/panel-client.test.js` (existing vm
  harness + fake fetch), no stylesheet/class additions.
- **Task 8 (docs)** — README pair (new 插件页配置 section + config intro sentence,
  i18n hash pair), shipped skill paragraph, CHANGELOG Unreleased entry with the
  measured gate, guide pointer where the config is documented.
- **Lead** — plan/preflight, LAYERS + BUDGETS for the new module and grown files,
  independent review, `npm run check`, commits on `feat/review-inbox`, update the
  detached main-worktree head and reinstall the desktop snapshot for testing.

## Risks and rollback

- **Self-remount during save**: the response is sent before the edit is scheduled; a
  poll recovers. If the plugin fails to remount (invalid config that passed
  validation but breaks apply), the page's poll times out and the owner can revert
  with `git`/the profile patch; the previous config remains in `_meta/.history` of
  the profile? (config writes are atomic YAML replaces; `configEditor.edit` restores
  the previous document when reconcile throws).
- **Home-patch override**: `edit` refuses when a home patch overrides the row; the
  page reports it rather than pretending a save landed. Rollback is config-only; no
  vault is touched by this feature.
- **Slot contract drift**: the seat is read from the live slot catalog; if a future
  host renames it the registration silently never fires (no page), which is the same
  fail-open direction dshmarket documents.

---

## Amendments (post-freeze rulings, 2026-11-07)

**A1 — the read rule is the live row config, not the profile layers.** The §Host
"read" paragraph said the effective raw config comes from the profile
override/inherited layers via `configEditor.configuration()`. The independent review
proved that layer excludes the **home** patch (`$DSH_HOME/cordis.patch.yml`), which
outranks the profile and is where the owner's config actually lives: the page would
show defaults and every save would be refused. The rule is now:
`values` = `entry.options.config` (the composition the plugin actually runs with),
normalized by `validateConfig`; `configuration()` is consulted only for the write
decision, `writable` = canonical-JSON equality between the live config and
`override` (non-empty) else `inherited` else `{}`. A mismatch answers
`writable:false, reason:'layer-override'` with the literal `$DSH_HOME/cordis.patch.yml`
hint. The page never writes the home layer; the README pair gains a one-time
migration paragraph (delete the home-layer row/config, restart DSH).

**A2 — invalid stored config is read-only, never savable-over.** A stored config the
schema cannot read answers `writable:false, reason:'config-invalid'` plus
`readError`; the defaults are shown for inspection only, because a save from them
would silently replace values the page never displayed.

**A3 — a stale pending record expires.** `SETTINGS_PENDING_TTL_MS` (120 s): a save
is refused 409 `save-in-flight` only while the pending record is younger than the
TTL; an older record is overwritten by the next attempt and `status` answers the
stale attempt as `failed` with "previous save did not finish; a newer save may be
attempted". A hard crash therefore cannot wedge the page forever.

**A4 — bounds have one source.** `CONFIG_RANGES` (exported, frozen) feeds both
`validateConfig`'s range loop and `describeConfigFields()`'s `min/max/integer/
exclusiveMin/exclusiveMax`, so the client's inline validation cannot drift from the
host's refusal.

**A5 — the save action re-checks writability.** A save POST for a row whose read
would be read-only is refused with a coded 409 (`not-writable`) before anything is
scheduled, so a stale page cannot overwrite a row it can no longer read correctly.
