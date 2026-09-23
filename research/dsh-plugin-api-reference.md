# DSH Host-Plane Plugin Authoring Contract — Reverse-Engineered Reference

**Scope.** Everything below is derived from the local DSH installation on this machine. No internet
documentation was consulted. Every claim carries a `file:line` citation or a quoted snippet.

**Evidence roots** (abbreviated below):

| Alias | Absolute path |
|---|---|
| `$DSH` | `/Users/yukisala/.nvm/versions/node/v25.9.0/lib/node_modules/@deepseek-ai/dsh/` |
| `$PKG` | `$DSH/node_modules/@deepseek-ai/` — 240 first-party packages, each with `README.md` + `lib/types/*.d.ts` |
| `$WEB` | `/Users/yukisala/.dsh/profiles/web/node_modules/` — installed third-party plugins |
| `$HOME_DSH` | `/Users/yukisala/.dsh/` |

Installed DSH version: `0.1.5-rc.2` (`$DSH/package.json`). Cordis version: `4.0.2`
(`$PKG/cordis/package.json`). **The Cordis package ships its original TypeScript source** at
`$PKG/cordis/src/*.ts` — that is the highest-fidelity evidence available for the `ctx` contract, and
where a `.d.ts` and a `.ts` disagree, the `.ts` is the implementation.

---

## 1. Package shape

### 1.1 The only package.json field DSH core reads for a bundle: `dsh.bundle.patch`

The authoritative type is `$PKG/dsh-package-manifest/lib/types/types.d.ts`:

```ts
/** The `dsh` property of an npm manifest; a package may declare several roles. */
export interface DshManifest {
    /** Bundle metadata consumed by the profile launcher. */
    bundle?: DshBundleManifest;
    /** Profile metadata consumed by the profile launcher. */
    profile?: DshProfileManifest;
    /** Client module loading and build metadata. */
    client?: DshClientManifest;
    /** Config directories consumed by the experimental deployment-image packer. */
    configTrees?: DshConfigTreeDeclaration[];
    /** Adjacent Session migration metadata consumed by the workspace catalog generator. */
    sessionFormatMigration?: DshSessionFormatMigrationManifest;
    /** @internal Launcher-generated module proxy metadata, not an author configuration entry. */
    moduleFallback?: DshModuleFallbackManifest;
}

/** The configuration layer exported by a bundle package. */
export interface DshBundleManifest {
    /** Patch file path relative to the declaring package root. */
    patch: string;
}

/** The bundle composition declared by a profile directory. */
export interface DshProfileManifest {
    /** Ordered bundle layer list, using installed package names. */
    bundles?: string[];
    /** User patch lifecycle; omitted means `live` for custom profiles. */
    patchReload?: ProfilePatchReload;
}
export type ProfilePatchReload = 'live' | 'startup';
```

The reader is `$PKG/dsh-app-boot/lib/index.js:851` (inside `loadProfileDirectory`):

```js
const declared = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")).dsh?.bundle?.patch;
if (declared === void 0) throw new Error(
  `${binName}: profile bundle ${JSON.stringify(packageName)} declares no dsh.bundle in its package.json`);
const patchPath = join(packageDir, declared);
```

So `dsh.bundle.patch` is **required to be a bundle at all**. A listed bundle without it is a hard boot
failure, not "no patches" (`$PKG/dsh-app-boot/lib/index.js:867-871`).

The reconcile step that decides whether a newly installed dependency becomes a bundle
(`$DSH/lib/plugin-Ddi42qoW.js`):

```js
function exportsPatch(packageName, profileDir) {
	let dir;
	try { dir = resolveBundleDir(NAME, packageName, INSTALL_ANCHOR, profileDir); } catch { return false; }
	return readProfileManifest(NAME, dir).dsh?.bundle?.patch !== void 0;
}
```

…and the non-bundle warning, printed once per newly-added plain dependency:

```js
} else if (!isBundle && !beforeDeps.has(packageName)) process.stderr.write(
  `${NAME}: warning: ${packageName} declares no dsh.bundle — installed as a plain dependency, not a profile layer (a later update that gains one activates it automatically)\n`);
```

### 1.2 Minimum viable `package.json`

The minimum that makes `dsh plugin --profile <name> add <pkg>` mount the plugin is **three things**:
`dsh.bundle.patch`, a resolvable ESM entry, and `"type": "module"`.

`dsh-ultramath` is the local minimal reference (`$WEB/dsh-ultramath/package.json`) — a complete,
working, third-party host-plane bundle:

```json
{
  "name": "dsh-ultramath",
  "version": "0.6.3",
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/index.d.ts",
  "license": "MIT",
  "engines": { "node": "^22.19.0 || >=24.0.0" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "dependencies": { "schemastery": "^3.18.0" },
  "peerDependencies": { "@deepseek-ai/cordis": "^4.0.1" },
  "files": ["lib", "lib/**", "cordis.patch.yml", "dsh.plugin.json", "SKILL.md", "README.md", "..."]
}
```

Field-by-field, with evidence:

| Field | Required? | Why |
|---|---|---|
| `name` | **yes** | The row's `name:` resolves to it; reconciliation is by installed package name (`plugin-Ddi42qoW.js`). |
| `version` | **yes** | `packageProxySource` throws without it: `dsh: installed package ${name} must declare a non-empty version` (`dsh-app-boot/lib/index.js:503`). |
| `type: "module"` | **effectively yes** | Loader imports go through Node ESM (`cordis-plugin-loader/lib/index.js:271-278`); every first-party and third-party package examined sets it. |
| `main` and/or `exports` | **yes** | `main` alone is accepted: `packageProxySource` falls back to `main ?? "index"` and throws `dsh: installed package ${name} main entry is missing at ${entry}` if it does not resolve (`dsh-app-boot/lib/index.js:505-518`). `exports` is preferred when present. |
| `dsh.bundle.patch` | **yes** | Above. |
| `exports` | recommended | Controls which subpaths a row may name (see §2.3). |
| `files` | no (packaging hygiene) | Not read by DSH; controls what `npm publish` ships. |
| `peerDependencies` | recommended | Not enforced by the loader (pnpm `autoInstallPeers: false` in `$HOME_DSH/profiles/web/pnpm-workspace.yaml`). The marketplace reads it — see §1.4. |
| `engines.node` | recommended | `dsh-ultramath` declares `^22.19.0 || >=24.0.0`. Cordis README: *"the scaffolder requires Node 22 or newer."* |

`dsh-ultramath`'s patch file is as small as it gets (`$WEB/dsh-ultramath/cordis.patch.yml`):

```yaml
- insert:
    - id: ultramath
      name: dsh-ultramath
```

**Note the bare package name here.** This is legal in a bundle patch (see §2.3) and disproves any
assumption that row names must be prefixed — the `./`/`@`/`cordis:` rule belongs to *agent presets*
(`agent.cordis.yml`), a different file with a different validator.

### 1.3 What `dsh.plugin.json` does, and who reads it — **nothing in DSH core**

Rigorous check over the whole installation:

```
$ grep -rl "dsh\.plugin\.json" /Users/yukisala/.nvm/versions/node/v25.9.0/lib/node_modules/@deepseek-ai/dsh/
(count: 0)
```

**Zero references.** It is not read by the loader, the profile boot, the plugin reconciler, or the
marketplace plugin (`grep -rl "dsh.plugin.json" dshmarket/` → no matches). It is an
**ecosystem/registry convention**, not a DSH API. Example content
(`$WEB/dsh-ultramath/dsh.plugin.json`):

```json
{
  "id": "dsh-ultramath",
  "version": "0.6.2",
  "main": "lib/index.js",
  "description": "…",
  "engines": { "dsh": ">=0.0.1" },
  "contributes": { "tools": [], "skills": ["ultramath"] }
}
```

Consequences an author must know:

- Nothing validates it, so a stale `"version": "0.6.2"` beside `package.json`'s `"0.6.3"` (exactly
  what `dsh-ultramath` ships) has no runtime effect.
- Its `engines.dsh` is **not** what the market reads. `dshmarket` reads `engines.dsh` **from
  `package.json`** (`$WEB/dshmarket/lib/discovery-compatibility.js`):

```js
export function manifestFacts(value) {
    const manifest = record(value) ?? {};
    const engines = record(manifest.engines);
    // #577: the ecosystem declares the host requirement in BOTH shapes —
    // top-level `engines.dsh` and `dsh.engines.dsh` under the manifest's own
    // `dsh` field … Neither position is authoritative, so read both; when a
    // manifest carries both, the top-level declaration wins.
    const dshEngines = record(record(manifest.dsh)?.engines);
    const peers = record(manifest.peerDependencies);
    …
    return { version: …, enginesDsh: range(engines?.dsh) ?? range(dshEngines?.dsh), peerDependencies };
}
```

  So if you want the market to gate your plugin on a DSH version, declare
  `"engines": { "dsh": ">=0.1.5-rc.2" }` in **`package.json`**, not in `dsh.plugin.json`.
- `dsh.plugin.json` is still worth shipping for registry/publication tooling. `dsh-at-file` lists it
  in `files` (`$WEB/dsh-at-file/package.json`), confirming it is a published convention.

### 1.4 Is there a registry/marketplace metadata schema?

There are **three distinct schemas**, and it matters which is which.

**(a) The core manifest schema** — `package.json.dsh`, quoted in full in §1.1. This is the only
machine-enforced one.

**(b) The marketplace catalog schema** — not a file you author. `dshmarket` README (`$WEB/dshmarket/README.md:85`):

> **This repo is the market app, not the catalog.** The plugin list comes from the curated
> [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) registry — to get
> your plugin listed in the market, open a PR **there** (one entry in the list; the site and this
> market pick it up automatically, usually within a day).

and `README.md:95`:

> Fetched live on every open from [awesome-dsh-plugin.com/plugins.json](https://awesome-dsh-plugin.com/plugins.json)
> — curated entries, npm mapping, and star counts refreshed daily by CI.

Listing is therefore a **pull request against a GitHub list**, not a manifest field.

**(c) The market's local discovery cache schema** — proves what facts the market checks. Real file
`$HOME_DSH/profiles/web/.dsh-market/discovery-compatibility-v1.json`:

```json
{"schema":"dsh-market/discovery-compatibility-cache/v1",
 "entries":{"dsh-mnemon":{"checkedAt":1790147465843,
   "facts":{"version":"0.5.13","enginesDsh":null,
            "peerDependencies":{"@deepseek-ai/cordis":"^4.0.1","@deepseek-ai/dsh-typert-protocol":"…"}}}}}
```

The market also writes hot-enable/disable rows into the profile's own patch layer
(`$WEB/dshmarket/README.md:46`):

> **Hot disable / enable** — toggles write `- id: …` + `disabled: true|false` into the profile's
> `cordis.patch.yml` … DSH's HMR re-composes within ~1s, no restart.

Real generated file `$HOME_DSH/profiles/web/.dsh-market/hot-1.yml`, which also demonstrates that a
row `name` may be an absolute `file://` URL:

```yaml
- id: 'mkt-client--dsh-community-dsh-paste-input'
  name: 'file:///Users/yukisala/.dsh/profiles/web/node_modules/@dsh-community/dsh-paste-input/lib/index.js'
```

**Bottom line:** there is no DSH-core registry schema; `dsh.plugin.json` is unvalidated community
metadata; the market gates on `package.json` `engines.dsh` + `@deepseek-ai/*` `peerDependencies`;
listing happens via the awesome-dsh-plugin list.

---

## 2. Bundle patch contract

### 2.1 The exact algorithm — `applyEntryPatches`

This function is **the** patch semantics, shared by boot and `--dump-config` so a dump can never
drift from what boots (`$PKG/dsh-app-boot/lib/index.js:52-108`). Quoted in full because every
detail matters:

```js
function applyEntryPatches(data, patches, warn) {
	data = structuredClone(data);
	if (!patches?.length) return data;
	const entryMap = new Map();
	const buildMap = (entries) => {
		for (const entry of entries) {
			if (entry.id) entryMap.set(entry.id, entry);
			if (entry.group && Array.isArray(entry.config)) buildMap(entry.config);
		}
	};
	buildMap(data);
	for (const patch of patches) {
		const { id, insert, name, ...overrides } = patch;
		if (insert) {
			if (id) {
				const target = entryMap.get(id);
				if (!target) { warn("patch insert: entry %C not found", id); continue; }
				if (!target.group) { warn("patch insert: entry %C is not a group", id); continue; }
				if (!Array.isArray(target.config)) target.config = [];
				target.config.push(...insert);
			} else data.push(...insert);
			buildMap(insert);
			continue;
		}
		if (!id) { warn("patch: id is required for non-insert patches"); continue; }
		const target = entryMap.get(id);
		if (!target) { warn("patch: entry %C not found", id); continue; }
		if (name && name !== target.name) {
			warn("patch: name mismatch for %C (expected %C, got %C), skipping", id, target.name, name);
			continue;
		}
		for (const [key, value] of Object.entries(overrides)) {
			if (key === "id") continue;
			target[key] = value;
		}
	}
	return data;
}
```

Derived rules:

1. **Insert without `id`** appends to the root list. `- insert: [...]` is the top-level bundle form.
2. **Insert with `id`** targets an existing entry that must be a **group** (`target.group` truthy) and
   pushes into its `config` array. A non-group target warns and is skipped — a *silent* no-op
   (`warn`, not `throw`).
3. **Inserted entries are indexed as added** (`buildMap(insert)`), so a later patch in the same list
   can target a row an earlier patch inserted. This is what lets a *user* patch override a bundle's row.
4. **Non-insert patch = assertion + wholesale replacement.** `name`, when present, is an *assertion*,
   not a selector. A mismatch **skips the whole patch** with a warning.
5. **`config` is replaced as a whole object.** The loop does `target[key] = value`. There is no deep
   merge. Confirmed three independent times:
   - `$PKG/dsh-app-boot/README.md` "Known Limitations": *"**A user patch replaces the whole matched config**
     — an id-targeted patch does not deep-merge, so a profile override restates the bundle fields it keeps."*
   - `$DSH/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml` header: *"A patch replaces the targeted
     row's whole `config` rather than merging into it, so a row whose value differs by mode does NOT
     live here."*
   - `$HOME_DSH/cordis.patch.yml` header: *"A non-insert patch entry REPLACES the named field
     wholesale, and `config` is replaced as a whole object — restate every field you want to keep."*
6. **Warnings, not errors, for unmatched patches.** `.dshmarket/README.md:46` and
   `dsh-app-boot/README.md` both note a patch naming a nonexistent entry prints a stderr warning. A
   typo therefore fails *quietly*.
7. **Input is never mutated**; the result is always detached (`structuredClone`), specifically so
   hot-reloads can revert a removed patch.

### 2.2 Row fields

| Field | Type | Meaning |
|---|---|---|
| `id` | string | Entry identity. Required on every non-insert patch. Duplicates make targeting ambiguous. |
| `name` | string | Module specifier — see §2.3. In a patch it is an assertion for non-insert patches. |
| `insert` | array | Child rows appended to root (no `id`) or to a group (`id`). |
| `disabled` | boolean \| `!!js` expr | Effective disabled state; also disables descendants. |
| `config` | any | Passed to `apply(ctx, config)` — see §2.4. For a group row, it is the **child row array**. |
| `group` | `true` | Marks the row as a container. Required for `insert: {id}` targeting. |
| `isolate` | `{ serviceName: true \| 'label' }` | Per-entry service realm — see §2.5. |
| `intercept` | `{ serviceName: config }` | Merged into that service's resolved config for this subtree. |

`disabled` is read by the loader (`$PKG/cordis-plugin-loader/lib/index.js:359-378`):

```js
	/** True when this entry or any owning parent entry is disabled. */
	get disabled() { return this._disabled(this.options); }
	_disabled(options) {
		if (this.disabledOf(options)) return true;
		… if (this.disabledOf(entry.options)) return true;   // ancestors
	}
	disabledOf(options) {
		return isJsExpr(options.disabled) ? Boolean(this.evaluate(options.disabled.__jsExpr))
		                                  : Boolean(options.disabled);
	}
```

Groups are always considered enabled themselves, but disabling a group prevents children running
(`$PKG/cordis-plugin-group/README.md`). **Important:** `$PKG/dsh-base/cordis.patch.yml` states
`config cannot disable a row` — `disabled` is a row field, not a config field. `DSH_TELEMETRY_DISABLED`
works by *generating* a `{id, disabled: true}` patch (`$DSH/lib/profile-boot-Dk-7KqJc.js`,
`resolveTelemetryPatch`).

### 2.3 `name` resolution rules

Resolution happens in `$PKG/cordis-plugin-loader/lib/index.js:268-280`:

```js
	/** Import a plugin module from a specifier or `cordis:` builtin. */
	import(name, getOuterStack) {
		if (name.startsWith("cordis:")) return this.ctx.loader.builtins[name.slice(7)];
		return composeError(async (info) => {
			info.offset += 3;
			if (this.ctx.loader.internal) return await this.ctx.loader.internal.import(name, this.ctx.baseUrl, {});
			else if (name.startsWith(".")) return await import(__rewriteRelativeImportExtension(
				new URL(name, this.ctx.baseUrl).href));
			else return await import(__rewriteRelativeImportExtension(name));
		}, getOuterStack);
	}
```

| Form | Resolution | Evidence |
|---|---|---|
| `cordis:<x>` | `ctx.loader.builtins[x]`. DSH registers exactly two: `include` and `group`. | loader:271; `mountRootInclude` sets `ctx.loader.builtins.include = Include; ctx.loader.builtins.group = Group` (`dsh-app-boot/lib/index.js:1323,1334`) |
| `./x` or `../x` | `new URL(name, ctx.baseUrl)` — relative to the **config file's directory**, i.e. the profile dir for a patch, the preset dir for a preset. | loader:274-275 |
| absolute path | Converted to a `file://` URL. | `dsh-app-boot/lib/index.js:1169-1176` and `1532` |
| bare `pkg` | Node ESM through the loader's internal resolver, anchored at `baseUrl` (= config dir). | loader:273; `dsh-base/cordis.patch.yml`: *"Bare plugin specifiers resolve through the Loader from the config directory."* |
| `@scope/pkg` | same as bare. | `@vectorize-io/hindsight-coding-agents` in `$WEB` |
| `@scope/pkg/subpath` | Resolved through the package's `exports` map. | `$WEB/@vectorize-io/hindsight-coding-agents/cordis.patch.yml` → `name: "@vectorize-io/hindsight-coding-agents/dsh"`, backed by `"./dsh": "./dist/dsh.js"` in its `exports` |

**Subpath exports are real and used in practice.** `packageEntryFromPackage`
(`dsh-app-boot/lib/index.js:491-508`) resolves via `resolve.exports` under Node ESM conditions and
throws a precise error on failure:

```js
		throw new Error(`dsh: cannot resolve ESM export ${specifier} from installed package ${packageName}`, { cause: error });
```

and rejects escapes from the package:

```js
		if (!target.startsWith("./") || /^\.\.(?:[\\/]|$)/u.test(relativeEntry)) throw new Error(
			`dsh: installed package ${packageName} export ${subpath} resolves outside its package: ${target}`);
```

**Absolute and relative paths are converted to file URLs only inside `insert` rows and nested
groups** — `$PKG/dsh-app-boot/README.md`:

> Patch loading converts absolute paths and patch-relative `./` or `../` paths to file URLs within
> `insert` rows and their nested groups; existing-entry name assertions and replacement `config`
> values remain literal.

That is the load-bearing sentence for anyone tempted to write a non-insert patch with a relative
`name`: it stays literal and the assertion will mismatch.

**Restriction on agent presets.** `agent.cordis.yml` is validated separately, and there `name` must
start with `./`, `@`, or `cordis:` — bare package names are **not** allowed. This is the validator
inside `dsh-ultramath` (`$WEB/dsh-ultramath/lib/index.js:55-58, 84-86`), which reproduces the DSH
loader's rule:

```js
/** dsh agent-presets loader 允许挂载的 name 前缀形式。 */
const NAME_PREFIX_RE = /^(\.\/|@|cordis:)/;
…
    } else if (!NAME_PREFIX_RE.test(current.name)) {
      errors.push('row "' + current.id + '": name "' + current.name + '" must start with "./", "@" or "cordis:"');
    }
    if (current.group === "true" && current.name !== "cordis:group") {
      errors.push('row "' + current.id + '": "group: true" requires name "cordis:group"');
    }
```

So: `dsh-ultramath`'s *bundle patch* legally uses `name: dsh-ultramath`, while its *presets* must use
prefixed names. **Two files, two rules.**

### 2.4 How `config` reaches `apply(ctx, config)`

The chain, with the exact call sites:

1. The loader's `internal/config` waterfall interpolates `!!js` expressions per fiber
   (`cordis-plugin-loader/lib/index.js:682-689`):
   ```js
   	ctx.on("internal/config", function(_config, next) {
   		const config = next();
   		if (!this.entry || this.parent.fiber?.entry === this.entry) return config;
   		if ((this.runtime?.callback)?.[EntryGroup.key]) return config;
   		return interpolate(this.ctx, config);
   	}, { global: true });
   ```
   `interpolate` evaluates through `new Function("ctx","expr", "with (ctx) { return eval(expr) }")`
   (`loader/lib/index.js:288-292`), which is why `dshHomePath('sessions')` is available in `!!js`.
2. `Fiber._resolveConfig` runs the `internal/config` waterfall then validates
   (`$PKG/cordis/src/fiber.ts`):
   ```ts
   private _resolveConfig(config: any) {
     config = this.context.waterfall(this, 'internal/config', config, () => config)
     return this.runtime ? resolveConfig(this.runtime, config) : config
   }
   ```
3. `resolveConfig` validates against the plugin's `Config` schema **before** `apply` runs
   (`cordis/src/fiber.ts`):
   ```ts
   export function resolveConfig(runtime: Plugin.Runtime, config: any) {
     if (!runtime.Config) return config
     const result = runtime.Config['~standard'].validate(config)
     if ('then' in result) throw new TypeError('Async config validation is not supported')
     if (result.issues) { throw new ValidationError(result.issues) }
     else { return result.value }
   }
   ```
4. `_reload` calls the callback with the validated value (`cordis/src/fiber.ts`):
   ```ts
   this.config = this._resolveConfig(this._config)
   await this._execute(this._runner)
   ```
   and the runner executes `runtime.callback(this.ctx, this.config)` for a function plugin, or
   `new runtime.callback(this.ctx, this.config)` for a class plugin.

**Answers:** yes, `config:` maps 1:1 onto `apply`'s second argument; schema **defaults are applied
before `apply`**; validation is **eager** (before `apply`, on every activation and reload). The
invalid-config error message is constructed by `ValidationError` (`cordis/src/fiber.ts`):

```ts
    super(`invalid config:\n` + issues.map(issue => {
      if (issue.path) { return `  - ${issue.message} (at ${issue.path.join('.')})` }
      else { return `  - ${issue.message}` }
    }).join('\n'))
```

This is the same string the preset mount audit surfaces as
`invalid config: $.<field> missing required value`.

**`!!js` rule.** The YAML schema is `yaml.JSON_SCHEMA.extend(JsExpr)`
(`dsh-app-boot/lib/index.js:30-31`) — i.e. **JSON schema plus the `!!js` tag**, so no YAML 1.1
extras like `yes`/`no` booleans or sexagesimals. `--dump-config` renders `!!js` verbatim and does not
evaluate it (`$DSH/lib/dump-config-lFgMwK8i.js`: *"without booting or evaluating `!!js`"*).

### 2.5 `group` and `isolate`

A group row in a DSH composition (`$PKG/dsh-agent-presets/presets/cordis/agent.cordis.yml:94-101`):

```yaml
- id: planning
  name: cordis:group
  group: true
  isolate:
    planMode: true
  config:
    - id: plan-mode
      name: '@deepseek-ai/dsh-plan-mode'
      config:
        section: |
          You are in plan mode. …
```

`isolate` semantics, from `$PKG/cordis-plugin-loader/lib/index.js:591-599`:

```js
	function access(entry, name, create = false) {
		let realm;
		const label = entry.options.isolate?.[name];
		if (!label) return;
		if (label === true) realm = entry.realm ??= new LocalRealm(entry);
		else if (create) realm = realms[label] ??= new GlobalRealm(label);
		else realm = realms[label];
		return realm?.access(name, create);
	}
```

- `true` → a **private realm per mounted entry** (per session, for a preset).
- `'label'` → a **shared realm** joined by every entry naming that label. It does *not* pool
  instances: `provide()` still throws on a second registration under the same symbol.
- A consumer left outside its provider's realm resolves the host's registry instead — the failure
  mode the skill calls out as "a row that never activated".

The near-universal mistake: **`config` on a `cordis:group` row is the child-row array, not a
settings object.** Groups take no other config.

### 2.6 How a user disables or overrides a row

Edit `$HOME_DSH/profiles/<name>/cordis.patch.yml` (or the home-level `$HOME_DSH/cordis.patch.yml`,
which outranks it). Both are non-empty YAML arrays. To disable:

```yaml
- id: hindsight
  disabled: true
```

This exact snippet is documented in the plugin's own patch header
(`$WEB/@vectorize-io/hindsight-coding-agents/cordis.patch.yml`):

```yaml
# To turn it off for one profile without uninstalling, patch this row in the profile's own
# cordis.patch.yml:
#
#   - id: hindsight
#     disabled: true
```

To override config, restate **every** field you keep (§2.1 rule 5). **An empty or comments-only
patch file fails boot** — use `[]`:

> The file must stay a non-empty YAML array. An empty or comments-only file fails boot; use `[]` to
> disable this layer. — `$HOME_DSH/cordis.patch.yml`

The exact validation (`$PKG/dsh-app-boot/lib/index.js:1192-1204`) and its three error strings:

```js
function parsePatchList(binName, file, content, label) {
	let parsed;
	try { parsed = yaml.load(content, { schema: userPatchesSchema }); }
	catch (error) { throw new Error(`${binName}: failed to parse ${label} ${file}: ${String(error)}`); }
	if (!Array.isArray(parsed)) throw new Error(`${binName}: ${label} ${file} must be a top-level YAML array of loader patch entries`);
	parsed.forEach((entry, index) => {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new Error(`${binName}: ${label} entry ${index + 1} in ${file} must be a mapping (a loader patch entry)`);
	});
	return anchorInsertedPluginNames(parsed, file);
}
```

A comments-only file parses to `null`, which is not an array — hence the boot failure. A **missing**
file is fine (`loadOptionalPatches` returns `undefined` on `ENOENT`), which is why deleting the file
also disables the layer. And a present-but-unappliable file must never be silently skipped:

> a present patch file that cannot apply is a misconfiguration and must fail loud at boot, never be
> silently skipped. — `$PKG/dsh-app-boot/lib/index.js:1134-1136`

### 2.7 Layer order

`composeProfile` / `allPatches` (`$DSH/lib/profile-boot-Dk-7KqJc.js`):

```js
/** The full patch stack of one composed profile, in application order. */
function allPatches(composed) {
	return [ ...composed.bundlePatches, ...composed.profile.patches, ...composed.homePatches, ...composed.overlays ];
}
```

1. each bundle patch, in `dsh.profile.bundles` order
2. the profile's own `cordis.patch.yml`
3. `$DSH_HOME/cordis.patch.yml` (home level — deliberately outranks the profile's)
4. `--patch` overlays, in argv order
5. the `DSH_TELEMETRY_DISABLED` switch

Bundle resolution order: **the dsh installation first, then the profile's own `node_modules`**
(`$DSH/README.md`):

> Bundles named in `dsh.profile.bundles` resolve from the dsh installation first (`@deepseek-ai/dsh-base`,
> `@deepseek-ai/dsh-web-app`, …), then from the profile's own `node_modules`, where pnpm installs
> out-of-tree plugins.

---

## 3. Plugin module contract

### 3.1 Accepted shapes

`$PKG/cordis/src/registry.ts`:

```ts
/** Supported plugin entrypoint shapes. */
export type Plugin<T = any> = Plugin.Function<T> | Plugin.Constructor<T> | Plugin.Object<T>

export namespace Plugin {
  /** Shared metadata understood by the plugin registry and related tooling. */
  export interface Base<T = any> {
    /** Display name used for fiber diagnostics and logger names. */
    name?: string
    /** Standard-schema validator applied to config before the plugin starts. */
    Config?: StandardSchemaV1<any, T>
    /** Services the plugin requires; it only loads while all are available. */
    inject?: Inject
    /** Service name(s) the plugin provides (read by `Service` and by loaders). */
    provide?: string | string[]
    /** Service names whose intercept config the plugin declares it consumes. */
    intercept?: Dict<boolean>
  }

  /** Function plugin called with `(ctx, config)`. */
  export interface Function<T = any> extends Base<T> { (ctx: Context, config: T): any }
  /** Class plugin constructed with `(ctx, config)`. */
  export interface Constructor<T = any> extends Base<T> { new (ctx: Context, config: T): any }
  /** Object plugin with an `apply(ctx, config)` method. */
  export interface Object<T = any> extends Base<T> { apply(ctx: Context, config: T): any }
}
```

Three equivalent shapes:

```js
// (a) named exports — the DSH house style, used by every first-party plugin
export const name = 'my-plugin'
export const inject = ['tools']
export const Config = z.object({ greeting: z.string().default('hi') })
export function apply(ctx, config) { /* … */ }

// (b) default-export an object
export default { name: 'my-plugin', inject: ['tools'], Config, apply(ctx, config) {} }

// (c) default-export a function
export default Object.assign((ctx, config) => {}, { name: 'my-plugin', inject: ['tools'] })
```

Evidence for (a): `$PKG/dsh-tool-todo/lib/index.js` ends with
`export { Config, apply, inject, name };` and starts with `const name = "tool-todo"; const inject = ["tools", "sessionProjections"];`.
`dsh-ultramath` (`$WEB/dsh-ultramath/lib/index.js:465-514`) is a third-party example of the same shape:

```js
/** 稳定 cordis 插件名。 */
export const name = "ultramath";
/** 公告区块依赖 systemPrompt 装配。 */
export const inject = ["systemPrompt"];
/** 插件配置，由同名 schemastery schema 校验。 */
export const Config = z.object({
  enabled: z.boolean().default(true),
  announceToAgent: z.boolean().default(true),
});
export function apply(ctx, config) { … }
```

`name` is inherited for diagnostics: `Fiber.name` walks up to the nearest named ancestor and
otherwise returns `'root'` (`cordis/src/fiber.ts`). The registry drops a literal `'apply'` name
(`registry.ts`: `let name = plugin.name; if (name === 'apply') name = undefined;`).

### 3.1.1 `this` inside `apply` is not a `ctx`

A subtle trap worth stating: when a **function-shaped** plugin runs, `this` is the shared
`Plugin.Runtime` record — `{ name, callback, fibers, Config }` — **not** a context. It has no `ctx`
property, and `this.ctx` is `undefined`.

```js
export function apply(ctx, config) {
  this.ctx            // WRONG — undefined; `this` has no ctx
  this.name           // the plugin name (the Runtime record)
  ctx                 // CORRECT — always use the first parameter
}
```

Use the parameter. `this` is only useful if you deliberately want the runtime record (e.g. to inspect
`this.fibers`).

### 3.2 `Config` must be a Standard Schema

`Config` is typed `StandardSchemaV1<any, T>`, and validation reads the **`'~standard'`** property
(`cordis/src/fiber.ts`). Schemastery provides it; so does zod. `dsh-storage-domain/README.md`
documents the split explicitly:

> Record schemas are zod so `z.infer` keeps consumer types un-duplicated; plugin `Config` stays
> schemastery.

`dsh-tool-todo/lib/index.js` imports both and uses each for its own job:

```js
import z from "@deepseek-ai/schemastery";
import { z as z$1 } from "zod";
```
…`const Config = z.object({ allowParallelInProgress: z.boolean().required() });` (schemastery, plugin
config) versus `todosProjectionSchema = z$1.union([…])` (zod, domain record).

Note `z.boolean().required()` — **schemastery's `.required()` means "must be supplied by config"**;
without it the field is optional. Contrast `z.string().default('hi')`, which makes it optional with a
default. Cordis refuses async validation: `TypeError('Async config validation is not supported')`.

### 3.3 `inject` and missing services — the key behaviour

`inject` accepts an array or a name→config map (`cordis/src/registry.ts`):

```ts
export type Inject<M = Dict> = (keyof M)[] | { [K in keyof M]?: M[K] }
```

Normalization (`Inject.resolve`) turns the array form into `{ name: null }` entries.

**A missing service does not throw and does not fail boot by itself — the plugin simply never
activates.** `Fiber._refresh` (`cordis/src/fiber.ts`) computes an epoch from the resolved
implementations; if any injected service is absent the epoch is `INACTIVE` and the fiber stays
`PENDING`, never running `apply`:

```ts
  _refresh() {
    let epoch: string | boolean = false
    epoch = ''
    for (const name of Object.keys(this.inject)) {
      const impl = this._store[name]
      if (!impl) { epoch = INACTIVE; break }
      epoch += ':' + impl.fiber.uid
    }
    this._setEpoch(epoch)
  }
```

It re-evaluates automatically when the service appears, because `ReflectService.notify()` walks the
registry and refreshes every fiber that injects the changed name (`cordis/src/reflect.ts`).

Two payoffs:

1. **Row order carries no load semantics.** `dsh-base/cordis.patch.yml` header: *"Row order carries
   no load semantics (activation is service-availability driven)."* A plugin may be listed before
   its dependency.
2. **A never-activating row is reported at boot** with the exact services it waited for
   (`dsh-app-boot/lib/index.js:1483-1492`):
   ```js
   		if (state === FIBER_PENDING) {
   			const missing = Object.keys(fiber.inject).filter((service) => fiber.ctx.get(service) === void 0);
   			const subject = missing.length === 1 ? "service" : "services";
   			failures.push(`${entry.options.name}: pending (waiting for ${subject}: ${missing.join(", ") || "unknown"})`);
   		} else failures.push(`${entry.options.name}: fiber state ${String(state)}`);
   …
   		throw new Error(`${binName}: ${String(failures.length)} ${noun} did not activate\n${failures.join("\n")}`);
   ```

Reading an injected service as a `ctx` property **without** declaring it throws
(`cordis/src/reflect.ts`):

```js
      const error = new Error(`cannot get property "${prop}" without inject`)
      …
              error.message = `cannot get required service "${prop}" in inactive context`
```

**The safe pattern for optional dependencies** is `ctx.get(name)` and an `undefined` check — `get`
never throws (`cordis/src/reflect.ts`):

```ts
     * @param strict — when `true` (default), only return implementations
     * whose providing fiber is currently active.
     * @returns the service value, or `undefined` when not (yet) provided.
     */
    get<K extends string & keyof this>(name: K, strict?: boolean): undefined | this[K]
```

`dsh-ultramath` guards defensively with optional chaining even for a declared injection:
`ctx.logger?.warn?.(...)`. Cordis's own guidance (`cordis/src/registry.ts`) puts the distinction
plainly: *"`inject` tells Cordis which services must exist before the plugin runs."*

---

## 4. Services available on `ctx`

### 4.1 The core mixins — what exists on every `ctx` with no injection

`ReflectService`'s constructor installs the mixins (`$PKG/cordis/src/reflect.ts`):

```ts
    this.mixin('reflect', ['get', 'set', 'provide', 'accessor', 'mixin'])
    this.mixin('fiber', ['runtime', 'effect'])
    this.mixin('registry', ['inject', 'plugin'])
    this.mixin('events', ['on', 'once', 'parallel', 'emit', 'serial', 'bail', 'waterfall'])
```

The root context (`cordis/src/context.ts`) always installs four services:

```ts
    this.fiber = new Fiber(self, {}, Object.create(null), null, () => [])
    this.reflect = new ReflectService(self)
    this.registry = new RegistryService(self)
    this.events = new EventsService(self)
    this.logger = new LoggerService(self)
```

So **always available with no `inject`**: `ctx.effect`, `ctx.on`/`once`/`emit`/`parallel`/`serial`/`bail`/`waterfall`,
`ctx.get`/`set`/`provide`/`accessor`/`mixin`, `ctx.inject`/`plugin`, `ctx.fiber`, `ctx.logger`,
`ctx.root`, `ctx.baseUrl`.

### 4.2 Exact signatures — core

```ts
// Effect — cordis/src/fiber.ts
effect(execute: () => SyncEffect, label?: string): Disposable<Promise<void>>
effect(execute: () => Effect, label?: string): AsyncDisposable<Promise<void>>
// accepted Effect shapes: Disposable | Iterable<Disposable> | Promise<Disposable> | AsyncIterable<Disposable>
// Returns a disposer; also awaitable (its .then awaits setup then disposal).
// Throws CordisError('INACTIVE_EFFECT') = 'cannot create effect on inactive context' if already disposed.

// Events — cordis/src/events.ts
on<K extends keyof Events>(name: K, listener: Events[K], options?: boolean | EventOptions): () => boolean
once<K extends keyof Events>(name: K, listener: Events[K], options?: boolean | EventOptions): () => boolean
// EventOptions = { prepend?: boolean; global?: boolean }
emit(name, ...args): void
parallel(name, ...args): Promise<void>
serial(name, ...args): Promisify<ReturnType>
bail(name, ...args): ReturnType
waterfall(name, ...args): ReturnType   // last arg is the innermost `next`

// Services — cordis/src/reflect.ts
get(name: string, strict?: boolean): any          // strict=true default; returns undefined when absent
set(name: string, value: any): void               // only the providing fiber; throws otherwise
provide(name: string, value?: any): () => void
accessor(name: string, options: { get, set? }): void
mixin(source, mixins): void

// Plugin loading — cordis/src/registry.ts
plugin<P extends Plugin>(plugin: P, ...args): Fiber & PromiseLike<Fiber>
inject(deps: Inject, callback: Plugin.Function<void>): Fiber & PromiseLike<Fiber>

// Logger — cordis/src/logger.ts ; callable: ctx.logger(name) returns a named facade
ctx.logger.info(format, ...args)
ctx.logger.warn(format, ...args)
ctx.logger.error(format, ...args)
ctx.logger.debug(format, ...args)
// printf placeholders: %s %d %i %f %o %O %c %C ; an Error first arg is unwrapped to its stack
```

`ctx.effect` returns a disposer **and** is awaitable; `on` returns a disposer that reports whether
the listener was still registered. Both are auto-removed when the owning fiber unloads
(`EventsService.register` wraps `ctx.fiber.effect`, `cordis/src/events.ts`).

### 4.3 Complete provable service inventory

Extracted mechanically from every package's `declare module '@deepseek-ai/cordis' { interface Context { … } }`
augmentation across all 240 packages in `$PKG`. **These are the real service names.**

| Service | Owning package |
|---|---|
| `agentDefaultModel` | dsh-agent-default-model |
| `agentLoop` | dsh-agent-loop |
| `agentPresets` | dsh-agent-presets |
| `agents` | dsh-agent |
| `approval` | dsh-user-approval |
| `attachments` | dsh-attachment |
| `authorization` | dsh-authorization |
| `clientModules` | dsh-client-modules |
| `cmdlineArgs`, `appExit`, `appReady` | dsh-cmdline |
| `codeRuntime` | dsh-code-runtime |
| `commands` | dsh-commands |
| `compaction` | dsh-compaction |
| `credentials` | dsh-credentials |
| `deepseekLlmApiExtensions` | dsh-deepseek-llm-api-extensions |
| `directoryPicker` | dsh-host-directory-picker |
| `dshHomePath` | dsh-app-boot (`ctx.provide("dshHomePath", dshHomePath)` at `lib/index.js:1530`) |
| `fileReferences` | dsh-file-reference |
| `fileUploads` | dsh-client-file-upload |
| `fs` | dsh-fs |
| `goals` | dsh-goal |
| `invariants` | dsh-invariants |
| `jobs` | dsh-jobs |
| `launchEnvironment` | dsh-launch-environment |
| `llm` | dsh-llm |
| `messageFeedback` | dsh-message-feedback |
| `permissionPresets` | dsh-permission-presets |
| `planMode` | dsh-plan-mode |
| `sandbox` | dsh-sandbox |
| `sandboxPolicy` | dsh-sandbox-policy |
| `sessionController` | dsh-api-session-controller |
| `sessionFeedback` | dsh-command-feedback |
| `sessionPersistence` | dsh-session-persistence |
| `sessionProjectionCache` | dsh-session-projection-cache |
| `sessionProjections` | dsh-session-projection |
| `sessionQuery` | dsh-session-query |
| `sessionReferenceResolver` | dsh-session-reference |
| `sessionTelemetry` | dsh-session-telemetry |
| `sessionTitle` | dsh-session-title |
| `sessions` | dsh-session |
| `settings` | dsh-settings |
| `settingsController` | dsh-api-settings-controller |
| `shell` | dsh-shell |
| `shellEnv` | dsh-shell-env |
| `skills` | dsh-skill |
| `spillStore` | dsh-spill |
| `storage` | dsh-storage |
| `storageDomain` | dsh-storage-domain |
| `subagents` | dsh-subagent |
| `subprocess` | dsh-subprocess |
| `systemPrompt` | dsh-system-prompt |
| `terminals` | dsh-terminal |
| `tokenMeter` | dsh-token-meter |
| `tools` | dsh-tools |
| `toolResultPruner` | dsh-compaction-tool-result-pruner |
| `userQuestions` | dsh-user-questions |
| `web` | dsh-web |
| `webServer` | dsh-host-webserver |
| `webhookRuntime` | dsh-webhook |
| `workflowEngine` | dsh-workflow |
| `workspaceController` | dsh-api-workspace-controller |
| `workspaceFiles` | dsh-api-workspace-files |
| `workspaceRegistry` | dsh-workspace |

Plus `dynamicCordisRunner` (dsh-cordis-host-runner), `sessionProjectionCache`, and the Cordis
core four (`reflect`, `registry`, `events`, `logger`, `fiber`).

**You must still `inject` anything outside the core four.** Only `ctx.get(name)` reads them safely
without injection.

### 4.4 `tools.register` — the complete option object

**Signature** (`$PKG/dsh-tools/lib/types/index.d.ts:601`) — **one argument, no `register(name, tool)` overload**:

```ts
    register(definition: ToolDefinition): () => void;
```

The real body (`$PKG/dsh-tools/lib/index.js:2773-2782`) — this is where register-time validation lives:

```js
	register(definition) {
		const name = definition.name;
		const output = definition.output;
		if (output === void 0 || typeof output !== "object" || typeof output.render !== "function" || output.presentationMeta !== void 0 && typeof output.presentationMeta !== "function") throw new TypeError(`tool "${name}" must declare output { schema, render, presentationMeta? }`);
		assertSupportedJsonSchema(output.schema);
		const timeoutMs = definition.timeoutMs;
		if (timeoutMs !== void 0 && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) throw new TypeError(`tool "${name}" timeoutMs must be a positive finite number`);
		if (name === "run_code") throw new Error(`tool name "${RUN_CODE_NAME}" is reserved for the PTC mode presentation transport and cannot be registered or shadowed`);
		return this.layers.effect(this.ctx, (layer) => layer.tools.insert(name, definition), { label: "tools.register()" });
	}
```

Note what `register` validates and what it does not: `output` and `timeoutMs` yes; **`parameters` and
`execute` are not touched at all** (`defineTool` is what compiles `parameters`). The returned value is
the Cordis effect disposer, and the undo is idempotent — double-dispose is safe.

**`ToolDefinition`** (`dsh-tools/lib/types/index.d.ts:96-172`, abbreviated to the type surface):

```ts
export interface ToolOutputDefinition {
    readonly schema: JsonSchemaNode;                                  // raw supported JSON Schema
    render(args: unknown, value: JsonValue): ContentBlock[];
    presentationMeta?(args: unknown, value: JsonValue): JsonValue;
}

export interface ToolDefinition extends ToolSchema {                  // ToolSchema = { name, description, parameters }
    readonly output: ToolOutputDefinition;                            // MANDATORY
    execute(args: unknown, exec: ToolRunContext): Promise<unknown>;
    finalizeContent?(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): ContentBlock[] | undefined;
    timeoutMs?: number;                                               // cooperative; never model-visible
    isConcurrencySafe?(args: unknown): boolean;                       // only literal `true` opts in
    presentCall?(args: unknown): ToolCallView | undefined;
    presentResult?(args: unknown, result: ToolResult): ToolResultView | undefined;
}
```

…where `ToolSchema` (`$PKG/dsh-llm/lib/types/types.d.ts:397-402`) is:

```ts
export interface ToolSchema {
    name: string;
    description: string;
    /** JSON Schema object for the arguments. */
    parameters: Record<string, unknown>;
}
```

**The ergonomic path is `defineTool`**, exported from `@deepseek-ai/dsh-tools`
(`dsh-tools/lib/types/schema.d.ts:239`):

```ts
export declare function defineTool<const S extends ParameterSchemaSpec, const O extends ValueSchemaSpec>(
  options: DefineToolOptions<S, O>): ToolDefinition;
```

`DefineToolOptions` (`dsh-tools/lib/types/schema.d.ts:178-231`):

```ts
export interface DefineToolOptions<S extends ParameterSchemaSpec, O extends ValueSchemaSpec> {
    readonly name: string;
    readonly description: string;
    /** Per-property parameter schema compiled to an implicit open object root. */
    readonly parameters: S;
    readonly output: {
        readonly schema: O;
        render(args: InferArgs<S>, value: InferValue<NoInfer<O>>): ContentBlock[];
        presentationMeta?(args: InferArgs<S>, value: InferValue<NoInfer<O>>): JsonValue;
    };
    readonly timeoutMs?: number;
    isConcurrencySafe?(args: InferArgs<S>): boolean;
    execute(args: InferArgs<S>, exec: ToolRunContext): Promise<InferValue<NoInfer<O>>>;
    finalizeContent?(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): ContentBlock[] | undefined;
    presentCall?(args: InferArgs<S>): ToolCallView | undefined;
    presentResult?(args: InferArgs<S>, result: ToolResult): ToolResultView | undefined;
}
```

**Answering the specific questions:**

- *Permission / approval fields:* **there are none on the tool definition.** Verified by grepping
  `dsh-tools/lib/types/{schema,index}.d.ts` for `permission|approval|hidden|readOnly` — only prose
  comments, zero field declarations. Approval is a separate policy layer with two mechanisms:
  1. the **`tools/pre-execute` waterfall**, whose decision type is
     (`dsh-tools/lib/types/index.d.ts:419-427`):
     ```ts
     export type PreToolDecision = { kind: 'allow' } | { kind: 'deny'; reason: string } | { kind: 'ask'; reason?: string };
     ```
     `{ kind: 'ask' }` is what triggers user approval; it resolves through `ctx.get('approval')`.
     Input rewriting is deliberately excluded — *"arguments are already logged and presented."*
  2. **`ctx.tools.guard(fn)`** — a monotonic guard after the waterfall: *"Any matching guard may deny
     by returning a reason, while no guard can force-allow a call another guard already denied."*
  The design intent is explicit in `dsh-tool-bash/lib/index.js`: *"TODO(permissions): deployment policy
  belongs in `tools/pre-execute` and sandboxing executors."*
- *Concurrency fields:* `isConcurrencySafe?(args)` — **fail-closed: only a literal `true` opts into
  parallel dispatch.** Omission, an exception, a non-`true` return, or invalid `defineTool` arguments
  are all exclusive. Sibling scheduling is `{kind:'parallel'}` vs `{kind:'exclusive'}`.
- *`timeoutMs`:* cooperative and **declarative only — the registry never enforces it.**
  `dsh-tools/README.md` is explicit: *"the registry never enforces deadlines; enforcement requires the
  `@deepseek-ai/dsh-tool-call-timeout-policy` wrapper"*, which is a `tools/execute` listener reading
  `ctx.tools.get(exec.name, exec.agent)?.timeoutMs`. Declaring it **asserts your tool forwards
  `exec.signal`**.

**Tool names are never prefixed or namespaced.** `schemaOf` returns `{name, description, parameters}`
through to the wire unchanged. Presets and agents separate tools by **registry layer**, not by name
(`dsh-agent-presets/lib/index.js`: `const key = { agentPreset: preset.id }; const scope = createScope(this.selfCtx, key)`).
A scoped registration **shadows** a global one with the same name — it does not coexist under a
different name. `ctx.tools.restrict({ allow?, deny? })` masks *inherited* tools for a scope and never a
scope's own registrations.

**`ToolRunContext`** — the second argument to `execute` (`dsh-tools/lib/types/index.d.ts:261-300`):

```ts
export interface ToolExecutionInput {
    readonly callId: ToolCallId;
    readonly rootCallId?: ToolCallId;
    readonly name: string;
    readonly arguments: unknown;
    readonly agent?: Agent;                        // set by the agent loop
    readonly parent?: ToolExecutionToken;          // PTC nested dispatch only
    readonly signal: AbortSignal;                  // required caller-owned cancellation
}
export interface ToolExecution extends ToolExecutionInput {
    readonly rootCallId: ToolCallId;               // resolved for every execution
    readonly token: ToolExecutionToken;            // registry-assigned opaque identity
}
export interface ToolRunContext extends ToolExecution {
    deferContext(context: UserMessage): void;      // emit context after this result
    concludeTurn(): void;                          // mark success terminal for the turn
}
```

So `exec` gives you: `callId`, `rootCallId`, `name`, `arguments`, `agent` (may be `undefined`),
`token`, `parent`, `signal`, plus `deferContext`/`concludeTurn`. `exec.agent.session` is the route
to the transcript, and `exec.signal` is what a long-running tool must observe.

### 4.5 The `parameters` dialect — a shorthand DSL, NOT plain JSON Schema

This is the single most commonly guessed-wrong part. `parameters` is a **property map with an
implicit open object root**, not a full JSON Schema document
(`dsh-tools/lib/types/schema.d.ts:81-88`):

```ts
export type ParameterSchemaSpec = {
    [key: string]: ParameterPropertySpec;
    [key: symbol]: never;
};
/** Raw JSON Schema projection of the implicit parameter object. */
export interface ParameterJsonSchema extends ObjectJsonSchema {
    properties: Record<string, JsonSchemaNode>;
}
```

Each property is a typed spec with `required`, `description`, `enum`, `items`, `properties`, and the
shared annotations (`dsh-tools/lib/types/schema.d.ts:1-45`):

```ts
export interface ValueSchemaAnnotations {
    description?: string;
    title?: string;
    default?: JsonValue;      // non-validating annotation
    examples?: JsonValue;
}
export interface StringValueSchemaSpec extends ValueSchemaAnnotations {
    type: 'string'; enum?: readonly string[]; const?: string;
}
export interface NumberValueSchemaSpec  extends ValueSchemaAnnotations { type: 'number';  enum?: readonly number[]; const?: number }
export interface IntegerValueSchemaSpec extends ValueSchemaAnnotations { type: 'integer'; enum?: readonly number[]; const?: number }
export interface BooleanValueSchemaSpec extends ValueSchemaAnnotations { type: 'boolean'; enum?: readonly boolean[]; const?: boolean }
export interface NullValueSchemaSpec    extends ValueSchemaAnnotations { type: 'null';    enum?: readonly boolean[]; const?: boolean }
```

**Requiredness is a property-level `required: true`**, not a root `required: [...]` array, and the value
must be the literal `true`:

```ts
export type ParameterPropertySpec = ValueSchemaSpec & { required?: true };
export type ParameterSchemaSpec = { [key: string]: ParameterPropertySpec; [key: symbol]: never };
```

Any other spelling is rejected: `unsupported JSON schema: parameters.q.required must be true when present`.
The compiler (`dsh-tools/lib/index.js`) emits
`{type:'object', properties:{…}, required:[…]}` from it, so the two forms are mutually exclusive as
**input** — feeding raw JSON Schema to `defineTool` throws
`unsupported JSON schema: parameters.type must be a value schema object`.

The `InferArgs` helper derives the TS type (`schema.d.ts:96-100`):

```ts
/** Keys of a property map marked `required: true`. */
type RequiredKeys<S> = {
    [K in StringKeyOf<S>]: S[K] extends { required: true; } ? K : never;
}[StringKeyOf<S>];
```

**The DSL has a closed key vocabulary.** Per node the whitelist is: annotations
`description`, `title`, `default`, `examples`; scalars `type`, `enum`, `const`; `array` plus `items`;
`object` plus `properties`, `additionalProperties`; the author-only `json`; and `oneOf` (≥2 branches,
no sibling `type`). Anything else is
`unsupported JSON schema: parameters.q.<key> is not supported by the value schema DSL` — notably
**`minimum`/`maximum`/`pattern`/`minLength` do not exist**, so numeric and string constraints must be
enforced inside `execute`.

**`additionalProperties` is MANDATORY on every object node** — in `parameters`, in nested `items`, and
in `output.schema`. Omitting it is a hard failure
(`dsh-tools/lib/index.js:698`):

```js
if (!Object.hasOwn(input, "additionalProperties") || typeof input.additionalProperties !== "boolean")
  authorError(`${path}.additionalProperties must be explicitly true or false`);
```

`dsh-tool-todo` sets `additionalProperties: false` everywhere for a substantive reason, explained in
its own source: *"the logged snapshot must equal what the model believes it wrote, so a nested/extended
item shape fails loud at the schema boundary instead of silently flattening."* The shipped convention
for **inputs** is usually `true` (permissive) and for **outputs** `false` (exact).

Exports confirm the DSL↔JSON-Schema relationship: `valueSchemaSpecToJsonSchema`,
`parameterSchemaSpecToJsonSchema`, `validateArgs`, plus `jsonSchemaToTs`/`jsonSchemaToPy` for the PTC
SDK renderers.

**A real, complete registration** — `$PKG/dsh-tool-todo/lib/index.js`, quoted verbatim. This is the
single best template to copy:

```js
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";

const name = "tool-todo";
const inject = ["tools", "sessionProjections"];
const Config = z.object({ allowParallelInProgress: z.boolean().required() });

function apply(ctx, config) {
	const allowParallel = config.allowParallelInProgress;
	ctx.tools.register(defineTool({
		name: "todo_write",
		description: describe(allowParallel),
		parameters: { todos: {
			type: "array",
			required: true,
			description: "The COMPLETE task list, replacing any previous list.",
			items: {
				type: "object",
				additionalProperties: false,
				properties: {
					content: { type: "string", required: true, description: "…" },
					status:  { type: "string", required: true, enum: [...STATUSES], description: "…" }
				}
			}
		} },
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					todos: { type: "array", required: true, items: { /* … */ } },
					counts: {
						type: "object", additionalProperties: false, required: true,
						properties: {
							pending:    { type: "integer", required: true },
							inProgress: { type: "integer", required: true },
							completed:  { type: "integer", required: true }
						}
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: `Updated todo list: ${value.counts.pending} pending, ${value.counts.inProgress} in progress, ${value.counts.completed} completed.`
			}]
		},
		execute(args, exec) {
			const todos = toTodoList(args.todos, allowParallel);
			if (!exec.agent) throw new Error("todo_write requires an owning agent session");
			exec.agent.session.append("todo/write", { todos });
			const count = (status) => todos.filter((t) => t.status === status).length;
			return Promise.resolve({
				todos: todos.map((todo) => ({ content: todo.content, status: todo.status })),
				counts: { pending: count("pending"), inProgress: count("in_progress"), completed: count("completed") }
			});
		},
		presentCall: (args) => ({ card: "generic", title: "Update todo list", kind: "other", rawInput: args.todos })
	}));
}

export { Config, apply, inject, name };
```

Note the two-level nesting style: `items: { type: 'object', additionalProperties: false, properties: {...} }`.
`additionalProperties: false` at the output root is deliberate — the comment in the source explains
that the logged snapshot must equal what the model believes it wrote.

### 4.6 How a tool's return value reaches the model

Three stages, all provable:

1. `execute` returns the **canonical value** declared by `output.schema` — *"Run one accepted call and
   return only its canonical lossless-JSON value"* (`ToolDefinition.execute` doc).
2. The registry **validates** that value against `output.schema`; a violation throws
   `ToolFailure` ("Thrown when a tool body or post-policy value violates its declared output",
   `dsh-tools/lib/types/index.d.ts:383`).
3. `output.render(args, value)` returns `ContentBlock[]` — **that array is the model-facing content.**
   `ToolOutputDefinition.render` is *"Pure projection from validated arguments and value to
   Native/model content."*

`ContentBlock` is a merge-extensible tagged union with six built-in variants
(`dsh-llm/lib/types/types.d.ts:91-102`): `text`, `reasoning`, `image`, `file`, `tool-call`,
`tool-result`. In `render` you will almost always return `[{ type: 'text', text }]`.

`finalizeContent?(exec, result)` is the last-mile hook, invoked *"exactly once for every normalized
outcome, including pipeline failures that bypass `tools/post-execute`"*, and must be total and must
not throw.

Two things are **never** model-visible: `timeoutMs` and `isConcurrencySafe` —
*"`schemas()` whitelists only name/description/parameters"* (`dsh-tools/lib/types/index.d.ts:134-136`).
Presentation metadata takes a separate durable path: `output.presentationMeta` →
`tool/result`'s `meta` field → `presentResult`.

### 4.7 `systemPrompt.section` and `systemPrompt.context`

`$PKG/dsh-system-prompt/lib/types/index.d.ts:225-252`:

```ts
    /**
     * Register an ordered prompt section in the calling context's scope. A scoped
     * section shadows a global section with the same name; duplicates within one
     * layer and non-finite orders throw. Registration and disposal emit
     * `system-prompt/change`.
     * @returns the exact Cordis effect disposer.
     */
    section(section: PromptSection): () => void;
    context(context: PromptContext): () => void;
```

```ts
export interface PromptSection {
    /** Unique name — a duplicate registration throws. */
    readonly name: string;
    /** Sections are concatenated in ascending order. Equal orders use code-unit name order. */
    readonly order: number;
    /** Static text or a provider evaluated at each assembly. May reference `{{variable}}`s. */
    readonly text: string | ((context: AssembleContext) => string);
    /** Treat this contribution as the complete system prompt. More than one effective complete
     *  section makes assembly fail. */
    readonly complete?: boolean;
}
export interface PromptContext {
    readonly name: string;
    readonly order: number;
    readonly text: string | ((context: AssembleContext) => string);
}
```

Real usage (`$WEB/dsh-ultramath/lib/index.js:556-563`):

```js
      disposeSection = ctx.systemPrompt.section({
        name: "plugin:dsh-ultramath",
        order: SECTION_ORDER,
        text: ultramathGuidance(),
      });
```

`section()` returns the effect disposer, so it must be disposed — `dsh-ultramath` stores it and
disposes on teardown. Relevant assembly errors
(`dsh-system-prompt/lib/index.js`): `multiple complete prompt sections are active: …`,
`unknown prompt variable "{{name}}" in ${kind} "${input.name}"`, and
`malformed prompt variable reference "{{…}}" in ${kind} "${input.name}" (references are complete simple {{name}} groups)`.

`PromptContext` is the right choice for *dynamic* content: it is materialized as a durable
user-role snapshot rather than prompt text.

### 4.8 `tools` events (for policy/wrapping)

From `dsh-tools/lib/types/index.d.ts:38-96`:

```ts
'tools/pre-execute'(this: Scoped<ToolRuntime>, exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision>;
'tools/execute'(this: Scoped<ToolRuntime>, exec: ToolDispatchExecution, next: () => Promise<ToolExecutionResult>): Promise<ToolExecutionResult>;
'tools/post-execute'(this: Scoped<ToolRuntime>, exec: ToolExecution, result: Readonly<ToolExecutionResult>, next: () => Promise<PostToolDecision>): Promise<PostToolDecision>;
'tools/ptc-dispatch-log'(this: Scoped<ToolRuntime>, dispatch: PtcDispatchLog, next: () => Promise<ContentBlock[]>): Promise<ContentBlock[]>;
'tools/result'(this: Scoped<ToolRuntime>, exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): undefined;
'tools/change'(): void;
```

### 4.9 Registration errors you will actually hit

| Error string (verbatim) | Cause |
|---|---|
| `tool "${name}" must declare output { schema, render, presentationMeta? }` | Missing/malformed `output` or a non-function `render` — `dsh-tools/lib/index.js:2776` (TypeError) |
| `tool "${name}" timeoutMs must be a positive finite number` | Bad `timeoutMs` at `register` — `:2779` (TypeError) |
| `unsupported JSON schema: <violations>` | `output.schema` rejected by `assertSupportedJsonSchema` — `:2782`; this is the umbrella for the DSL messages in §4.5 (`JsonSchemaError`, code `UNSUPPORTED_SCHEMA`) |
| `tool "${name}" is already registered (for a per-agent variant, register through that agent's \`agent.ctx\` instead)` | Duplicate name in the global layer — `:2538` |
| `tool "${name}" is already registered in this scope` | Duplicate within one agent scope — `:2538` |
| `tool name "run_code" is reserved for the PTC mode presentation transport and cannot be registered or shadowed` | Name collision with PTC — `:2780` |
| `defineTool(${name}): timeoutMs must be a positive finite number` | Bad `timeoutMs` at `defineTool` — `:845` |
| `invalid description: expected a non-empty string` | Blank `description` — `:1124` |
| `tool arguments must be lossless JSON: …` / `… (call the tool with an arguments object, e.g. \`{}\`)` | Non-JSON args — `:967-969` |
| `tool "${n}" parameters must be lossless JSON before schema projection` | Non-JSON `parameters` — `:2937` |
| `invalid arguments: missing required property "q"; "n" must be a number` | Argument validation failure (`ToolArgsError`, code `INVALID_ARGS`) — `:816` |
| `tool "${n}" returned invalid output: "value.a" must be a string` | Canonical value violates `output.schema` (`ToolOutputError`, code `INVALID_TOOL_OUTPUT`) — `:2458` |
| `unknown tool "${toolName}"` (code `UNKNOWN_TOOL`) | Dispatch of an unregistered name — `:2449` |
| `tool call aborted before dispatch` | `signal` already aborted (`ABORTED_BEFORE_DISPATCH`) |
| `tools.presentAs() requires a scoped context (agent.ctx): a context-global presentation is the \`mode\` config field on the tools row` | Scoping misuse — `:2707` |
| `property "${name}" is already declared as ${type}` | `ctx.provide` collision — `cordis/src/reflect.ts` |
| `service "${name}" has been registered at <${fiber.name}>` | Second provider of one service in one realm — `cordis/src/reflect.ts` |
| `cannot get property "${prop}" without inject` | Reading an undeclared service as a `ctx` property — `cordis/src/reflect.ts` |
| `cannot set property "${name}" in multiple fibers` | `ctx.set` from a fiber other than the provider — `cordis/src/reflect.ts` |
| `cannot create effect on inactive context` | `ctx.effect`/`ctx.on` after disposal (`CordisError` code `INACTIVE_EFFECT`) |

Every non-success tool outcome is materialized for the model as exactly ``Error: ${message}`` —
the registry wraps the failure through `toolErrorResult` (`dsh-tools/lib/index.js:3490-3501`). A tool
that throws a plain `Error('boom')` therefore renders as `Error: boom` in the transcript, which is why
error messages should be written as model-facing prose.

### 4.10 Disposal semantics — precise

`Fiber.effect` (`cordis/src/fiber.ts`) documents the contract:

> `execute` runs immediately; the disposers it produces are collected and run **(in reverse order)**
> either when the returned disposer is called or when the fiber unloads, whichever comes first.
> **Calling the disposer twice is a no-op.** Throws `CordisError('INACTIVE_EFFECT')` if the fiber is
> already disposed, and `TypeError` if `execute` returns an invalid shape.

Also relevant: `Fiber.assertActive()` throws `INACTIVE_EFFECT` once `uid === null`; `Fiber.effect`
additionally rejects while `state === UNLOADING`. `EventsService.on` calls `assertActive()` before
registering, so **a plugin cannot register a listener from a disposal callback**.

### 4.11 Not to be confused with: dynamic Cordis plugins

A **dynamic Cordis plugin** — the in-process, ephemeral mechanism you drive with `cordis_define` /
`cordis_run` — does **not** import `defineTool` from `@deepseek-ai/dsh-tools`. Its sandbox exposes a
different pair (`$PKG/dsh-cordis-host-runner/lib/types/sandbox.d.ts`):

```ts
harness.defineTool(definition: ToolDefinition): ToolDefinition
harness.registerTool(ctx: Context, tool: ToolDefinition): () => void
```

and registering anything else throws
`dynamic tool registration must use a tool returned by harness.defineTool(...)`. Inside the sandbox
`ctx.tools` is a three-verb façade (`register(tool)`, `schemas()`, `get(name)`).

Two behavioural differences matter if you are porting code between the two worlds:

1. The dynamic `harness.defineTool` accepts **either** the shorthand DSL **or** the JSON-Schema
   wrapper form `{type:'object', properties:{…}, required:[…]}` for `parameters`. That is the *only*
   place raw JSON Schema is legitimately accepted as input.
2. A dynamic tool's `execute` return crosses a cross-realm JSON clone, so only lossless JSON may come
   back; and `render`'s return is asserted separately with the message
   `output.render returned <preview> — it must return an ARRAY of content blocks: ✓ return [{ type: 'text', text: String(value) }]`.

Dynamic tools land in the **root/global** layer. **This document is about the shipped-package form** —
a `package.json` + `cordis.patch.yml` + `lib/index.js` bundle installed into a profile. Both surfaces
exist; do not mix their imports.

---

## 5. Agent lifecycle events

### 5.1 The complete, authoritative event list

Extracted from the `declare module '@deepseek-ai/cordis' { interface Events { … } }` block in
`$PKG/dsh-agent/lib/types/runtime-types.d.ts`. **`agent`, `agent.session`, `agent.session.header.id`,
`agent.session.header.cwd`, and `agent.session.header.origin` are NOT events.** The header is a plain
object property. Every real event, with its dispatch mode:

| Event | Mode | Payload |
|---|---|---|
| `agent/created` | emit | `{ agent: Agent }` |
| `agent/disposed` | emit | `{ agent: Agent }` |
| `agent/status` | emit | `{ agent: Agent; status: 'idle' \| 'running' }` |
| `agent/inbox/inserted` | emit | `{ agent: Agent; message: UserMessage }` |
| `agent/inbox/claimed` | emit | `{ agent: Agent; message: UserMessage; turn: number }` |
| `agent/inbox/discarded` | emit | `{ agent: Agent; message: UserMessage }` |
| `agent/session-start` | emit | `{ agent: Agent; source: 'startup' \| 'resume' \| 'clear' \| 'compact' }` |
| `agent/pre-step` | **waterfall** | `{ agent, messages: UserMessage[], turn: number, step: number, signal: AbortSignal }` |
| `agent/request` | **waterfall** | `{ agent, turn, step, signal }` → `LlmCallConfig` |
| `agent/request-error` | **waterfall** | `{ agent, turn, step, provider, failure, retryPolicy, signal }` |
| `agent/assistant-stream` | emit | `{ agent: Agent; frame: AssistantStreamFrame }` |
| `agent/turn-stopping` | **serial** | `{ agent, turn, signal }` → `Promise<void> \| void` |
| `agent/error` | emit | `{ agent, turn, step, error: unknown }` |

Every one of these is dispatched with a **scope-filtered `this`** typed `Scoped<Agent>`:
*"Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent."*
That is what lets a single host-plane registration serve every session without cross-talk.

**Read `payload.agent`, never `this`.** The dispatch `this` is typed `Scoped<Agent>`, which is
deliberately opaque (`dsh-scope/lib/types/index.d.ts:18-20`):

```ts
/**
 * A routing-only event receiver built by {@link scopeTarget}. The type
 * parameter records the subject type for dispatch checking; the carrier does
 * not expose the subject's properties. Event payloads carry the real subject.
 */
export type Scoped<T extends object> = object & { readonly [ScopedBrand]: T };
```

So `ctx.on('agent/pre-step', function (payload, next) { this.agent /* WRONG — undefined */ })` is a
bug; the agent is `payload.agent`. `this` exists only as the routing key the scope filter reads.

**`agent/turn-stopping` is SERIAL, not a waterfall — its listener receives no `next`.** It is the one
member of the "lifecycle hook" family that is not a waterfall, and writing
`ctx.on('agent/turn-stopping', async (payload, next) => next())` silently gets `next === undefined`.
The documented contract is data-driven, not veto-driven:

> Awaited before the boundary commits — a listener that objects **steers** (`agent.steer(...)`) and the
> machine re-reads its inbox: fresh steering runs another step, none closes the turn. **Data decides,
> so listener order cannot change the outcome.**

**Publication order** (`dsh-agent-loop/lib/index.js`), exact:

```
sessions.enter → agents.enter → agent.ctx.sessions.announce(session)   // = session/created
               → loopCtx.agents.announce(agent)                        // = agent/created
               → emitAgentEvent(loopCtx, agent, 'agent/session-start', { source })
```

`SessionStartSource` is `'startup' | 'resume' | 'clear' | 'compact'`, but only `'startup'` (fresh
create) and `'resume'` have emitters in this build; `'clear'` and `'compact'` are declared with none.

**A complete host-plane subscription set** — this is what a real plugin registers
(`$WEB/@vectorize-io/hindsight-coding-agents/dist/dsh.js`):

```js
ctx.on("agent/session-start", hooks.sessionStart);
ctx.on("agent/pre-step", hooks.preStep, { prepend: true });
ctx.on("agent/turn-stopping", hooks.turnStopping);
ctx.on("agent/disposed", hooks.disposed);
```

Note `{ prepend: true }` — the waterfall runs **outermost-first**, and `prepend` uses `unshift`
(`cordis/src/events.ts`), so it puts this listener *first in the chain*. `{ global: true }` bypasses
scope filtering; `dsh-api-session-controller` uses it on `agent/disposed` to observe every agent from
one registration.

Session events (`$PKG/dsh-session/lib/types/index.d.ts`):

| Event | Mode | Payload |
|---|---|---|
| `session/created` | emit | `(session: Session)` — a synchronous throw vetoes creation |
| `session/disposed` | emit | `(session: Session)` — emitted once when a session leaves the store |
| `session/event` | emit | `(session: Session, event: SessionEvent)` — post-commit fire-and-forget append feed |
| `session/flush` | **parallel** | `(session: Session)` — awaited durability checkpoint, no veto |

Agent-preset event: `agent-preset/selected(sessionId, agentPreset)` (`dsh-agent-presets/lib/types/types.d.ts`).

### 5.2 The `agent` object

`$PKG/dsh-agent/lib/types/types.d.ts` + the augmentation in `runtime-types.d.ts`:

```ts
export interface Agent {
    /** Session-backed Agent identity. */
    readonly id: SessionId;
}
// augmented:
    readonly options: AgentOptions;        // { provider?, model?, reasoningEffort?, maxTokens? }
    readonly session: Session;             // the live session; its log is the durable source of truth
    readonly inbox: Inbox;
    readonly status: AgentStatus;          // 'idle' | 'running'
    readonly ctx: Context;                 // AGENT-SCOPED context
    cancel(cause: AgentCancelCause, options?: CancelOptions): void;
    whenIdle(): Promise<void>;
    runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>;
    send(message: UserMessage, target: InboxTarget, wakeup: boolean): void;
    followup(message: UserMessage): void;
    steer(message: UserMessage): void;
    inject(message: UserMessage): void;    // <-- context injection
```

`agent.ctx` is the crucial one for registration:

> Agent-scoped context; its contributions are **agent-local, unwind on disposal, and reject
> registration afterward**.

A plugin that registers tools through `agent.ctx` gets per-agent tools that vanish with the agent —
this is exactly the mechanism the duplicate-name error message points at.

### 5.3 `agent.session` and the session header

`agent.session` is *"The live session this agent drives; its log is the durable source of truth."*
`Session` is a **plain class, not a Service** — the store service is `ctx.sessions` (plural), and
**there is no `ctx.session`**.

`session.header` is *"Detached, deep-frozen creation metadata … Kept out of the event log — it is a
storage concern, not replayable conversation state."* Complete field list
(`$PKG/dsh-session/lib/types/types.d.ts`):

| Field | Type | Notes |
|---|---|---|
| `version` | `typeof SESSION_FORMAT_VERSION` | `3` in this build |
| `id` | `SessionId` | Mirrors `session.id` |
| `createdAt` | `number` | Unix epoch ms |
| `cwd` | `string \| undefined` | **Optional** — the session's working directory |
| `parentSession` | `SessionId \| undefined` | Fork lineage |
| `isSeeded` | `boolean` | Whether a fork-inherited prefix exists |
| `origin` | `'subagent' \| undefined` | *"Coarse product classification"* |
| `delegationDepth` | `number \| undefined` | Absent (zero) for a top-level session |
| `agentPreset` | `string \| undefined` | The preset this session's agent was composed from |

A **real header** from this machine's own session log
(`$HOME_DSH/sessions/…/session.v3.jsonl.zstd`, frame 0):

```json
{"type":"session","version":3,"id":"5dbe5d38-4f7c-4031-89ae-f7fd0084f8c4",
 "createdAt":1790149181611,"cwd":"/Users/yukisala/subject/dsh-obsidian-mem",
 "parentSession":"b8e02487-…","isSeeded":false,"origin":"subagent",
 "delegationDepth":2,"agentPreset":"cordis"}
```

The idiomatic access pattern — subscribe to a lifecycle event, then read the field:

```js
ctx.on('agent/session-start', ({ agent }) => {
  const cwd = agent.session.header.cwd ?? process.cwd()
  if (agent.session.header.origin === 'subagent') return   // skip child sessions
})
ctx.on('session/created', (session) => { /* session.header.cwd */ })
```

This is exactly what `hindsight` does (`dist/dsh.js`):
`function workspaceRoot(agent) { return agent.session.header.cwd || process.cwd(); }`, and
`$PKG/dsh-tool-fs` documents the same route for tools: *"the calling agent's per-session workspace
(`exec.agent.session.header.cwd`)"*. **`cwd` is optional**, so always fall back.

### 5.4 The `signal`

An `AbortSignal`, always *"the current turn's cancellation signal"* (`agent/pre-step` doc) or
*"the current turn's explicit abort signal"* (`agent/request`, `agent/turn-stopping`). It is
per-**turn**, not per-session. It originates from the loop's per-activity `AbortController`
(`dsh-agent-loop/lib/index.js`: `{ kind: "running", abort: new AbortController() }`), is captured once
as `const signal = this.phase.abort.signal`, and is threaded into every waterfall. `agent.cancel()`
does `this.phase.abort.abort(cause)`, so **`signal.reason` is the `AgentCancelCause`** —
`{kind:'user'} | {kind:'parent'} | {kind:'hook', reason} | {kind:'disposed'}`. The loop re-checks with
`signal.throwIfAborted()` after each waterfall; `dsh-agent-instructions` does the same after each
`await`:

```js
		const desired = await compose(agent, signal, messages, pending);
		signal.throwIfAborted();
```

**There is no abort signal on the `agent` object itself, and no `agent.cwd`** — `agent` is
`{ readonly id: SessionId }` plus the augmented live face. The working directory is
`agent.session.header.cwd`.

### 5.5 The waterfall protocol — exact

`$PKG/cordis/src/events.ts`:

```ts
  /**
   * Compose listeners around the final `next` callback.
   *
   * The last dispatch argument is treated as the innermost `next`. Listeners
   * run outermost-first; a listener that does not call `next()` vetoes the
   * rest of the chain, including the built-in behavior.
   */
  waterfall(...args: any[]) {
    const cbs = this.dispatch('waterfall', args)
    const inner = args.pop()
    const next = () => { const cb = cbs.shift() ?? inner; return cb(...args) }
    args.push(next)
    return next()
  }
```

And the registry's rule (`cordis/src/registry.ts`): *"`next` tells Cordis which services must exist
before the plugin runs"* — for waterfalls, the docblock on `agent/pre-step` states it directly:
**"Calling `next()` preserves the current messages."**

**`agent/pre-step` return type** (`$PKG/dsh-agent/lib/types/runtime-types.d.ts`):

```ts
/** Whether and with which messages the loop enters a proposed step. */
export type PreStepDecision = {
    kind: 'reject';
} | {
    kind: 'enter';
    messages: UserMessage[];
    /** Start a distinct model-message series before this step's admitted messages. */
    startsRequestSeries?: true;
};
```

So the documented return shapes are exactly **`{ kind: 'reject' }`** and
**`{ kind: 'enter', messages }`** (optionally `startsRequestSeries: true`).

**`agent/request-error` return type:**

```ts
/** Action returned by a listener that owns model-request recovery. */
export type RequestErrorAction = { kind: 'retry' } | undefined;
```

> A listener returns `{ kind: 'retry' }` without calling `next()` when it owns recovery, or calls
> `next()` to delegate. The default `undefined` leaves the failure terminal.

**Short-circuit vs delegate, four worked patterns:**

```js
// 1. Pure observer — must still call next() and return its result, or the chain is vetoed.
ctx.on('agent/pre-step', async (payload, next) => next())

// 2. Observe-then-delegate, then rewrite the decision (dsh-agent-instructions, lib/index.js:1270)
ctx.on("agent/pre-step", async ({ agent, messages, step, signal }, next) => {
    const decision = await next();
    // …compute `desired`…
    if (decision.kind === "reject" || step === 1 && decision.messages.length === 0) return decision;
    const lastClaimedIndex = decision.messages.findLastIndex((m) => messages.includes(m));
    const entered = decision.messages.toSpliced(lastClaimedIndex + 1, 0, desired);
    return { ...decision, messages: entered };
});

// 3. Reject the step outright
ctx.on('agent/pre-step', async () => ({ kind: 'reject' }))

// 4. Own recovery without delegating
ctx.on('agent/request-error', async (payload, next) => { /* repair */ return { kind: 'retry' } })
```

Pattern 2 is the canonical "inject context" implementation and is worth reading in full.

### 5.6 Reading a session transcript

`Session.snapshotEvents` (`$PKG/dsh-session/lib/types/index.d.ts:187`):

```ts
    /**
     * Materialize an immutable snapshot of a half-open event sequence range.
     * A full current snapshot is reused until the next append; every previously
     * returned snapshot remains stable after later appends.
     * @param fromSeq - non-negative inclusive sequence number; defaults to the log start.
     * @param toSeqExclusive - non-negative exclusive sequence number; defaults to the current end.
     * @returns a frozen array of the selected deeply frozen events.
     */
    snapshotEvents(fromSeq?: SessionLogOffset, toSeqExclusive?: SessionLogOffset): readonly SessionEvent[];
```

Synchronous, returns a frozen array. Companions: `eventAt(seq)`, `ownEvents()`, `isOwnSeq(seq)`,
`get seq()`, `get surface()`.

**`SessionEvent` shapes** (`$PKG/dsh-session/lib/types/types.d.ts`, `SessionEventMap`):

```ts
'turn/start':      { turn: number }
'turn/end':        { turn: number; reason: TurnEndReason }
'step/start':      { turn: number; step: number }
'step/end':        { turn: number; step: number }
'user/message':    UserMessage                        // payload IS the message
'system/message':  { turn: number; step: number; message: SystemMessage }
'assistant/message': { turn, step, message: AssistantMessage, stream: AssistantStreamRecord[],
                       usage?: TokenUsage, interrupted?: true }
'assistant/attempt': { turn, step, stream: AssistantStreamRecord[] }
'tool/call':       { turn, step, callId: ToolCallId, name: string, arguments: string }  // raw JSON string
'tool/result':     { turn, step, message: ToolResultMessage, error?: {name,code}, meta?: JsonValue }
'request/header':  …
'request/context': RequestContext
'session/end-seed': …
```

Plus plugin-extensible entries, e.g. `dsh-agent` adds
`'agent/inbox/spliced': { target: InboxTarget; start: number; removedCount?: number; inserted: UserMessage[]; outcome?: 'canceled' }`
and `dsh-tool-todo` appends `'todo/write'`.

The `tool/call` doc is explicit that arguments are unparsed: *"the raw `arguments` JSON string exactly
as the model produced it (unparsed). `callId` pairs the call with its `tool/result`."*

A realistic fold:

```js
const transcript = session.snapshotEvents();
for (const event of transcript) {
  switch (event.type) {
    case 'user/message':      console.log('user:', event.data.content); break;
    case 'assistant/message': console.log('assistant:', event.data.message.content); break;
    case 'tool/call':         console.log('call', event.data.name, JSON.parse(event.data.arguments)); break;
    case 'tool/result':       console.log('result', event.data.message.content, event.data.error); break;
  }
}
```

Note the envelope: `event.type` and `event.data` (`snapshotSessionEvent` doc: *"a detached event
snapshot with a validated, deeply frozen message"*). The full envelope is
`{ type, seq: SessionSeq, time: number, data: SessionEventMap[T], ignorable?: true }`, plus — **only
for `SurfaceEventType` = `'system/message' | 'user/message' | 'assistant/message' | 'tool/result'`** —
two extra **top-level** (not inside `data`) fields:

```ts
surfaceOp?: 'append' | { op: 'replace'; startSeq: SessionSeq; endSeq: SessionSeq }
sourceEventSeqs?: SessionSeq[]
```

**Do not read `event.data.surfaceOp`** — it is a sibling of `data`.

Real decoded events from this machine's own session log:

```json
{"type":"turn/start","seq":6,"data":{"turn":1}}
{"type":"user/message","seq":10,"surfaceOp":"append","data":{"id":"654eb46d-…","role":"user","content":[{"type":"text","text":"…"}],"source":{"kind":"user"}}}
{"type":"tool/call","seq":17,"data":{"turn":1,"step":1,"callId":"call_00_ET_…","name":"bash","arguments":"{\"command\": \"mkdir -p …\"}"}}
{"type":"tool/result","seq":18,"surfaceOp":"append","sourceEventSeqs":[17],"data":{"turn":1,"step":1,"message":{"id":"bafbac1a-…","role":"user","source":{"kind":"tool","callId":"call_00_ET_…"},"content":[{"type":"tool-result","toolCallId":"call_00_ET_…","content":[{"type":"text","text":"/Users/…"}],"isError":false}]}}}
{"type":"assistant/message","seq":16,"surfaceOp":"append","data":{"turn":1,"step":1,"message":{"source":{"kind":"model","provider":"deepseek-official","model":"deepseek-flash"}},"usage":{"inputTokens":17302,"outputTokens":215,"totalTokens":36589,"cacheReadTokens":19072,"reasoningTokens":0},"stream":[{"type":"chunk","time":…,"chunk":{"type":"block-start","index":0,"blockType":"text"}}]}}
```

The complete 55-value runtime vocabulary is `KNOWN_SESSION_EVENT_TYPES`
(`$PKG/dsh-session/lib/types/known-event-types.js`).

**`ctx.session` does not exist.** The service is the plural **`ctx.sessions`** (`SessionStore`,
`dsh-session/lib/index.js`: `super(ctx, "sessions")`). A live `Session` reaches you three ways: as
`agent.session` on an event payload, as the argument to `session/created` / `session/event` /
`session/disposed`, or via `ctx.sessions`. Reading `ctx.session` yields the
`cannot get property "session" without inject` error.

**Two other access routes:** `session.deriveMessages(): Message[]` for the folded LLM history
directly, and `ctx.sessionProjections.stateOf(session, key)` for incremental projection state — the
registry subscribes to `session/event` once and maintains per-session keyed state, so a plugin that
only needs "what is the current X" does not re-scan the log. Third-party plugins written defensively
against older builds use `session.snapshotEvents?.() ?? session.events ?? []`.

### 5.7 Observing session end / agent disposal

Three distinct seams, in increasing specificity:

```js
// 1. The agent left the registry — AgentLoop emits this after driver quiescence and scoped-registration
//    unwind, but before session detachment.
ctx.on('agent/disposed', ({ agent }) => { /* flush per-agent state */ })

// 2. The session left the store (also fires on creation rollback: "including publication rollback,
//    but never for an entry whose creation announcement did not begin").
ctx.on('session/disposed', (session) => { /* … */ })

// 3. Your own plugin's teardown — the general mechanism.
ctx.effect(() => () => { /* runs on plugin unload / HMR */ }, 'my cleanup')
```

`ctx.on`'s disposer and `ctx.effect`'s disposer both fire automatically on plugin unload, so
per-plugin bookkeeping usually needs no explicit end-event listener.

**There is no `ctx.on('dispose')`.** A grep for `on('dispose'` / `on("dispose"` across the entire
installation returns **zero hits**, and the framework `Events` interface (`cordis/src/events.ts`)
lists only `internal/plugin`, `internal/status`, `internal/config`, `internal/service`,
`internal/update`, `internal/get`, `internal/set`, `internal/listener`, `internal/dispatch`. A plugin
that wants to run code on its own teardown returns a disposer from `ctx.effect` — that is the only
mechanism. `internal/plugin(fiber)` fires on creation *and* on disposal-with-uid-cleared if you truly
need a framework-level hook.

The composition's teardown order (documented in `$PKG/dsh-agent-loop/README.md`) is:
stop-and-drain → close session write path → unwind scope → detach agent → detach session.

### 5.8 Injecting context into a session

`UserMessage` is the vehicle. The type (`$PKG/dsh-llm/lib/types/message.d.ts`):

```ts
export interface Message {
    readonly id: MessageId;
    readonly role: 'system' | 'user' | 'assistant';
    readonly content: ContentBlock[];
    readonly source: MessageSource;
}
export interface UserMessage extends Message { readonly role: 'user' }
```

**Source kinds** — `MessageSourceMap` is *"Merge-extensible sum type — plugins add their own `kind`s"*:

```ts
export interface MessageSourceMap {
    user:   { kind: 'user' };
    plugin: { kind: 'plugin'; plugin: string } & ContextFormed;
    model:  ModelMessageSource;   // { kind: 'model'; provider; model; replayState? }
    tool:   ToolMessageSource;    // { kind: 'tool'; callId: ToolCallId }
}
export type MessageSource = MessageSourceMap[keyof MessageSourceMap];
```

A plugin adds its own kind by declaration merging; `dsh-agent-instructions` defines
`kind: 'agent-instructions'` with `form: 'instructions'`.

**`ContextForm`** — the semantic vocabulary, explicitly *"SEMANTIC, never visual"*:

```
'instructions' | 'catalog' | 'snapshot' | 'notice' | 'relay' | 'recall'
```

with per-form required fields: `snapshot` needs `sections: readonly ContextSnapshotSection[]`;
`notice` needs `summary: string`. Omitting `form` is the documented default (opaque content).

**Constructors:**

```ts
createUserMessage<T extends NewUserMessage>(input: T): T & Pick<UserMessage, 'id' | 'role'>
createMessage<T extends NewMessage>(input: T): T & Pick<Message, 'id'>
createSystemMessage(text: string, plugin: string): SystemMessage
createAssistantMessage(input: NewAssistantMessage): AssistantMessage
createToolResultMessage(input: ToolResultMessageInput): ToolResultMessage
freezeMessage<T extends Message>(message: T): T
boundContextSummary(summary: string): string
```

Real construction (`$PKG/dsh-agent-instructions/lib/index.js:766-777`):

```js
function workspaceContextMessage(text) {
	return createUserMessage({
		content: [{ type: "text", text }],
		source: { kind: "plugin", plugin: name }
	});
}
```

…and with a richer custom source (`lib/index.js:1170-1179`):

```js
				authorityMessages.push(createUserMessage({
					content: baselineContent,
					source: {
						kind: "agent-instructions",
						form: "instructions",
						baseline: true,
						baselineIdentity: identity,
						changes: baselineChanges
					}
				}));
```

**Four ways to deliver it**, in increasing intrusiveness:

```js
// (a) Queue for the next pre-step WITHOUT waking the driver (non-disruptive).
agent.inject(message)

// (b) Steer the nearest step; an idle driver starts a turn.
agent.steer(message)

// (c) Start a fresh turn.
agent.followup(message)

// (d) Insert into the entering batch of the step under decision (dsh-agent-instructions).
ctx.on('agent/pre-step', async ({ agent, messages, step, signal }, next) => {
  const decision = await next()
  if (decision.kind === 'reject') return decision
  const msg = createUserMessage({ content: [{type:'text', text:'…'}], source: { kind:'plugin', plugin: name } })
  return { ...decision, messages: [...decision.messages, msg] }
})
```

`agent.inject`'s doc is the most informative about timing:

> Queue model-facing context for the next pre-step without waking the driver. A running driver claims
> it at the nearest later step boundary; idle drivers leave it pending until follow-up or steering
> wakes them. **It may miss a request whose pre-step already claimed its batch.** Cancellation or
> disposal may discard pending context.

Three facts that make injected context *durable*: it becomes an ordinary sourced `user/message`
event, so it replays, compacts, and resumes like other history
(`dsh-agent-instructions/README.md`: *"Baseline and refresh messages are ordinary sourced
`user/message` events, so they replay, compact, and resume exactly like other history"*), and
`Session.append` validates all event data with `isJsonValue`, so **any `meta` must be
JSON-serializable** or it is rejected at the source.

**The `plugin` label is load-bearing, not decorative.** `dsh-repeat-tool-reminder` states the reason
outright: *"an unlabeled context would render as a user prompt in derived history."* A
`{ kind: 'user' }` source is indistinguishable from a human prompt; `{ kind: 'plugin', plugin: '<name>' }`
is what the UI and derived history use to attribute the message correctly. **Always set a real
`plugin` name.**

`ToolRunContext.deferContext(context: UserMessage)` is the tool-side equivalent: *"the loop appends it
only after the `tool/result`."*

**Source `kind`s are genuinely merge-extensible in shipping code.** A real transcript from this machine
contains sources beyond the built-in four:

```json
"source": {"kind":"plugin","plugin":"@deepseek-ai/dsh-system-prompt","form":"snapshot","sections":[{"name":"sandbox:policy","text":"…"}]}
"source": {"kind":"skill-catalog","form":"catalog","entries":[…]}
```

So a plugin may declare its own `kind` via `declare module '@deepseek-ai/dsh-llm' { interface MessageSourceMap { … } }`
and use it, exactly as `dsh-agent-instructions` does with `kind: 'agent-instructions'`.

---

## 6. Persistence and configuration

### 6.1 Two independent mechanisms — pick deliberately

| | Row `config` in a composition | `ctx.settings` namespace |
|---|---|---|
| Where stored | `cordis.patch.yml` (bundle, profile, home, `--patch`) | `$DSH_HOME/settings.yaml` |
| Who edits | Whoever edits YAML | The user, at runtime, via UI or file |
| Reload | Per `patchReload` (`live` re-composes profiles) | Hot, per namespace, no restart |
| Validated by | Plugin `Config` (Standard Schema) | Namespace schema (schemastery) |
| Read in `apply` | Second argument | `scope.get()` / `ctx.settings.get(ns)` |
| Fixed at load | Yes | No |

`dsh-settings` README states the rule:

> Choose settings when a plugin's configuration should be changeable at runtime — by the user editing
> a document or by a configuration UI — without restarting or re-reading `cordis.yml`. … It is
> unnecessary when configuration is fixed at load time: without a provider mounted, nothing changes
> and configuration stays exactly as composed.

**A plugin's `Config` schema does NOT automatically surface into `settings.yaml`.** Nothing in the
loader writes user settings; `Config` is a load-time validator only. To appear in `settings.yaml` you
must **register a namespace** explicitly.

### 6.2 The settings API

From `$PKG/dsh-settings/README.md` (quoted; the README is the contract here):

```text
const scope = ctx.settings.register('ui-theme', ThemeSchema, {
  base: config,   // composition entry config; the user layer resolves above it
})
const theme = scope.get()              // deep-frozen resolved snapshot
scope.update({ density: 'compact' })   // merges into the user section and persists
```

> `ctx.settings.installSection(owner, ns, schema, entry, hooks)` packages the optional-service wiring
> for a consumer plugin: while a settings service exists it registers the namespace with the plugin's
> composition entry as `base`; when the service goes away the plugin falls back to its entry config
> and keeps working exactly as composed.

Full method set — exact declarations from `$PKG/dsh-settings/lib/types/index.d.ts`:

```ts
    /** @throws {TypeError} when `ns` is not a lowercase hyphenated identifier. */
    register<const Namespace extends string, T>(
      ns: Namespace, schema: z<T>, options?: SettingsRegisterOptions<T>): SettingsScope<T>;

    installSection<const Namespace extends string, T>(
      owner: Context, ns: Namespace, schema: z<T>, entry: T, hooks: SettingsSectionHooks<T>): void;

    describe(options?: SettingsDescribeOptions): SettingsDescriptor[];
    get<const Namespace extends string>(ns: Namespace): unknown;

/** Owner-facing handle for one registered namespace. */
export interface SettingsScope<T> {
    get(): T;
    watch(callback: (next: T, prev: T) => void | Promise<void>): () => void;
    update(patch: object): Promise<void>;
    replace(section: object): Promise<void>;
}
```

| Call | Behaviour |
|---|---|
| `ctx.settings.register(ns, schema, { base })` | Returns a `SettingsScope<T>`; the schema is a **schemastery** `z<T>`; `ns` must be a lowercase hyphenated identifier or it throws `TypeError` |
| `ctx.settings.get(ns)` | Resolved value; `undefined` while unregistered |
| `ctx.settings.installSection(owner, ns, schema, entry, hooks)` | The optional-provider wiring: registers while settings exists, falls back to `entry` when it detaches |
| `ctx.settings.describe({ redactSecrets })` | One `SettingsDescriptor` per namespace, in registration order |
| `scope.get()` | Resolved value — *"schema defaults, then `base`, then the user layer"* |
| `scope.watch(cb)` | `(next, prev)` after each commit; one callback runs one at a time in commit order; a rejection is contained and logged |
| `scope.update(patch)` | **Deep-merges into the user section only** — never into `base`; validates then persists |
| `scope.replace(section)` | Sets the user section wholesale; `replace({})` resets to `base` + defaults |
| `ctx.settings.mutate(ns, ops)` | Ordered `{ op: 'set' \| 'unset', path }` edits, for callers holding a redacted (incomplete) view |

`describe()`'s `redactSecrets` is a **requirement, not an option**, for any wire surface: *"Every wire
surface MUST pass this; the verbatim default exists for same-process configuration UIs only."*

**Namespace naming:** the grammar is exactly `/^[a-z][a-z0-9-]*$/`
(`$PKG/dsh-settings/lib/index.js:82-84`):

```js
const NAMESPACE_PATTERN = /^[a-z][a-z0-9-]*$/;
	if (!NAMESPACE_PATTERN.test(value)) throw new TypeError(`settings namespace "${value}" must match ${String(NAMESPACE_PATTERN)}`);
```

**The key is the namespace string you pass, not the plugin's `name`.** Proof from a real package —
`@zhangfengshun/dsh-remote-ssh/lib/index.js` has `const name = "@zhangfengshun/dsh-remote-ssh"` but
`const NS = "dsh-remote-ssh"`; `dsh-chat-import` has `name = 'import-claude'` but namespace
`'chat-import'`. **A scoped package name cannot be a namespace verbatim** (the `/` and `@` fail the
grammar) — use a hyphenated slug. The convention is the unscoped package name; real `$HOME_DSH/settings.yaml`
keys are `dsh-better-sidebar`, `dsh-remote-ssh`, `chat-import`, `ui-theme`, `agent-presets`, `permission`.

`SettingsConflictError` (`code: 'SETTINGS_CONFLICT'`) carries `expected` and `actual` revisions, so an
optimistic writer can detect that it lost a race.

### 6.2.1 **Do not hard-`inject: ['settings']`**

This is a real trap. `settings` is an **optional** provider — a composition without the settings row is
valid. A plugin that declares `inject: ['settings']` stays `PENDING` forever on such a composition, and
the boot audit reports it as `pending (waiting for service: settings)`.

```js
// FRAGILE — the plugin never loads where no settings provider is mounted.
export const inject = ['settings']

// CORRECT — degrade to the composition config.
export const inject = ['tools']                      // hard deps only
export function apply(ctx, config) {
  const settings = ctx.get('settings')               // undefined when absent
  if (settings !== undefined) { /* register a namespace */ }
  else { /* use `config` exactly as composed */ }
}

// ALSO CORRECT — the built-in sugar for exactly this shape:
ctx.inject(['settings'], (ctx) => { /* runs only while settings exists */ })
```

`ctx.settings.installSection(...)` exists precisely to package this wiring: *"while a settings service
exists it registers the namespace with the plugin's composition entry as `base`; when the service goes
away the plugin falls back to its entry config and keeps working exactly as composed."* Shipped users:
`dsh-agent-default-model`, `dsh-llm-deepseek`, `dsh-bash-local`, `dsh-permission-presets`,
`dsh-web-search-deepseek`.

### 6.2.2 ⚠️ Forward-compatibility warning: this API changes in DSH 0.1.7

**The installed DSH is 0.1.5-rc.2, and everything in §6.2 describes 0.1.5-rc.2 only.** A third-party
plugin on this machine carries a compatibility shim documenting that **DSH 0.1.7 removes
`settings.register()`**
(`$WEB/dsh-chat-import/lib/import-prefs.mjs:16-34`, verbatim):

> 0.1.7 删除了 settings.register()：命名空间不再是插件自持的名字，而是 profile 里该
> [entry 的 id]
> … 并 settings.configure({auto:false}) 声明 …
> 条目 id 的坑：0.1.7 的 loader 把 ctx.fiber.entry.id 报成 `"<kind>:<id>"`

Translated and expanded, the shim asserts that in 0.1.7:

| 0.1.5-rc.2 | 0.1.7 |
|---|---|
| The plugin picks its namespace string | The **profile entry id** is the namespace |
| A separate settings schema | The entry's own `Config` schema |
| `settings.get(ns)` exists | `get` is gone — use `describe()` |
| schemastery has no `.volatile()` | **`.volatile()`** marks a field editable; writing a non-volatile field errors `"is not volatile"` |
| — | `settings.configure({ auto: false })` |
| — | `ctx.fiber.entry.id` reported as `"<kind>:<id>"` |
| — | a `loader/volatile-update` event, with volatile config fields updated in place |

Verified locally: `z.boolean().volatile` is `undefined` in the installed schemastery, and
`dsh-settings` exports only `SettingsConflictError`, `SettingsProvider`, and `redactSecrets` — so
**none of the 0.1.7 surface exists here.** The shim's own defense is worth copying if you want to
survive the transition: feature-detect (`typeof settings.register === 'function'`) and construct the
volatile schema inside a `try`/`catch`, because *"旧版构造它会在模块加载期抛 'volatile is not a
function' 直接报废插件"* — building it unconditionally on 0.1.5 throws at module load and kills the
plugin outright.

Failures and events:

> Every write rejects non-JSON-compatible data (a `Date`, `Map`, `BigInt`, non-finite number, or
> circular reference fails with its `$`-rooted path before anything persists), rejects on a read-only
> provider, and accepts an optional `expectedRevision`: … a namespace that moved past it refuses the
> write with `SettingsConflictError`.
>
> `settings/updated (ns, next, prev, source)` fires after each committed change … `settings/document-updated (ns, revision)`
> fires whenever the raw user section changed, even when the resolved value did not.
>
> A stored section the schema rejects keeps the namespace's last good value and warns on reload; at
> registration the same failure rejects the registration itself.

The provider row is mounted by `dsh-base` (`- id: settings / name: '@deepseek-ai/dsh-settings-file'`),
documented as *"User-settings document (`$DSH_HOME/settings.yaml`, hot-reloaded)"*.

**The key is the namespace string you choose.** Real `$HOME_DSH/settings.yaml` shows the convention is
the plugin's package name:

```yaml
dsh-better-sidebar:
  tabsEnabled: { git: true }
  agentOpenTools: false
chat-import:
  importSystemPrompt: true
dsh-remote-ssh:
  profiles: [ … ]
ui-theme:
  preference: system
agent-presets:
  default: ptc
```

### 6.3 Durable storage — `ctx.storageDomain`

The shipped durable KV API for plugin-owned state. `$PKG/dsh-storage/README.md`:

> Use this package to give a composition durable, non-session storage: mount it together with backend
> and domain-form packages, and host-side packages read and write validated records through
> `ctx.storageDomain`. … It is available only to host code and has no model-visible effect.

Mounting (already done in `dsh-base/cordis.patch.yml`):

```yaml
- id: storage
  name: '@deepseek-ai/dsh-storage'
- id: storage-json
  name: '@deepseek-ai/dsh-storage-json'
  config:
    root: !!js dshHomePath('storages')
- id: storage-domain
  name: '@deepseek-ai/dsh-storage-domain'
  config:
    backend: json
```

**Declare a domain** (`$PKG/dsh-storage-domain/README.md`, verbatim):

```text
// Owning package, once:
const workspaceSpec = defineDomain({
  name: 'workspace',
  version: 1,
  tables: { workspaces: domainTable(workspaceRecordSchema) },
})
```

**Open and use it:**

```text
const domain = await ctx.storageDomain.open(workspaceSpec)
await domain.table('workspaces').put(id, { path: '/work/demo' })
const record = domain.table('workspaces').get(id) // synchronous, from memory
domain.table('workspaces').update(id, (r) => ({ ...r, path: newPath }))
```

Handle surface (`$PKG/dsh-storage-domain/lib/types/domain.d.ts`): `KvTable` has
`get(key)`, `entries()`, `keys()`, `size`, `delete(key)`, `update(key, fn)`, and `put(key, value)`;
`DomainGlobal` has `get()` and `set(value)`; `Domain` has `close()`.

**Schema dialect split:** *"Record schemas are zod so `z.infer` keeps consumer types un-duplicated;
plugin `Config` stays schemastery."* `defineDomain` *"fails loud at module load on a bad name, a
non-integer version, or a global schema that accepts `null`."*

**Naming grammar — note the underscore.** The domain name **and every table name** must match
`UNIT_NAME_RE` (`$PKG/dsh-storage/lib/index.js:80`):

```js
const UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/;
```

`defineDomain` throws at module load otherwise: `domain name 'Bad-Name' must match /^[a-z][a-z0-9_]*$/`,
`table name '…' must match …`, `version must be a non-negative integer`,
`global schema must not accept null`. **This differs from the settings namespace grammar
(`/^[a-z][a-z0-9-]*$/`), which uses hyphens** — domains use underscores, settings namespaces use
hyphens. Record **keys** must additionally match `[a-zA-Z0-9_-]+`.

**Change event** — one per committed write, emitted strictly after durability:

```js
ctx.on('domain/changed', (change) => { /* { domain, table, key, operation: 'put' | 'deleted', value? } */ })
```

**`ctx.storage` is a registry, not a KV store.** The hub exposes only `backend`
(`BackendRegistry`: `register`/`get`/`names`), `mount(form, facility)`, `form(form)`, and a `domain`
getter. It has **no `get`/`set`** — reading and writing records goes through `ctx.storageDomain`.
Hub error codes: `backend-not-found`, `form-not-mounted`, `duplicate-backend`, `duplicate-mount`,
`version-mismatch`, `malformed-medium`, `closed`.

**On-disk layouts** (root is `$DSH_HOME/storages`, set by
`root: !!js dshHomePath('storages')` in `dsh-base/cordis.patch.yml`):

| `layout` | Path | Shape |
|---|---|---|
| `'single'` (default) | `<root>/<unit>.json` | `{unit:{name,version}, global, tables:{<table>:{<key>: value}}}` |
| `'per-record'` | `<root>/<unit>/<table>/<key>.json` + `<root>/<unit>/global.json` | `{version, record}` per file |

Both are present in reality: `storages/workspace.json` (single) and
`storages/session_projcache/sessions/<id>.json` (per-record). Choose `per-record` for units *"whose
records are large, sparse, or individually disposable"* — it scopes version checks per record.

**Lifecycle (explicit ownership):**

> the CALLER owns the returned handle and closes it via `Domain.close()` (typically as its own
> `ctx.effect` disposer) — the facility does not tie the domain to any consumer fiber.

```js
const domain = await ctx.storageDomain.open(mySpec)
ctx.effect(() => () => domain.close(), 'my-plugin: domain')
```

Shipped precedent: `dsh-session-projection-cache` does exactly this. Domains still open when the
facility unmounts are closed by the plugin disposer.

**Two disposal subtleties:**

- `scope.watch(cb)` returns a disposer that is **not** auto-tied to your fiber — call it yourself.
  (`ctx.settings.register()` *is* a fiber effect, so that half needs nothing.)
- `ctx.storage.backend.register(name, backend)` returns an unregister disposer but **does not close the
  backend** — the owning plugin closes it after unregistering, as `dsh-storage-json` does:
  ```js
  ctx.effect(() => { const unregister = ctx.storage.backend.register("json", backend); return async () => { unregister(); await backend.close() } })
  ```

**Error codes** (stable, from the README):

| Code | Meaning |
|---|---|
| `already-open` | The name is open or still closing |
| `backend-not-found` | The routed backend is not mounted |
| `facet-unsupported` | The backend serves no `kv` facet |
| `invalid-record` | A stored record fails its schema (names table and key) |
| `missing-key` | `update` on an absent record |
| `closed` | Any use after close |
| `version-mismatch` | Stored domain version ≠ spec version |

**On-disk layout** — real `$HOME_DSH/storages/`:

```
storages/session_projcache.json          # single layout: one document per unit
storages/session_projcache/sessions/<id>.json   # per-record layout
storages/workspace.json
```

Matching `DomainSpec.layout?: 'single' | 'per-record'`.

**Is sqlite available to plugins?** A sqlite-backed ***session query** engine* exists
(`dsh-session-query-sqlite`, mounted with `path: ':memory:'` and `openAt: never` in `dsh-base`), but
it is a session-search engine exposed as `ctx.sessionQuery`, **not** a general plugin KV store. The
plugin-facing durable KV store is `ctx.storageDomain`. **UNKNOWN:** whether a plugin may mount its own
sqlite backend through the storage hub — no shipped `storage-sqlite` package exists in `$PKG`
(verified: the only storage packages are `dsh-storage`, `-json`, `-domain`).

### 6.4 Complete skeleton: config + durable state

```js
import z from 'schemastery'
import { z as zod } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

export const name = 'my-plugin'
export const inject = ['storageDomain']

export const Config = z.object({
  greeting: z.string().default('hi'),        // optional, defaults applied before apply()
  limit:    z.number().required(),           // MUST be supplied by the composition
})

const counterRecord = zod.object({ n: zod.number() })
const counterSpec = defineDomain({
  name: 'my-plugin-counters',                // must match UNIT_NAME_RE
  version: 1,
  tables: { counters: domainTable(counterRecord) },
})

export function apply(ctx, config) {
  ctx.logger.info('my-plugin loaded with limit=%d', config.limit)

  // Durable state: open once, own the handle, close on unload.
  let domain
  ctx.effect(() => () => domain?.close(), 'my-plugin: domain')
  void ctx.storageDomain.open(counterSpec).then((d) => { domain = d })

  // Optional runtime settings layered above the composition entry.
  const settings = ctx.get('settings')
  if (settings !== undefined) {
    const scope = settings.register('my-plugin', Config, { base: config })
    ctx.logger.info('greeting is now %s', scope.get().greeting)
  }
}
```

---

## 7. Local dev / install / test loop

### 7.1 (a) Create a profile

```sh
# Shipped templates auto-initialize on first use:
dsh web                      # alias of --profile web
dsh --profile headless "task"

# A NEW custom profile from a shipped template:
dsh --profile myprof --from-default-profile web
```

Templates and their bundle lists (`$PKG/dsh-app-boot/lib/index.js:328-357`):

```js
const PROFILE_TEMPLATES = {
	acp:          { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-acp-app"],       patchReload: "startup" },
	web:          { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"],       patchReload: "live" },
	headless:     { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"],      patchReload: "startup" },
	sdk:          { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-sdk-app"],       patchReload: "startup" },
	"sdk-minimal":{ bundles: ["@deepseek-ai/dsh-sdk-minimal"],                            patchReload: "startup" },
};
const DEFAULT_PROFILE_BUNDLES = ["@deepseek-ai/dsh-base"];
const DEFAULT_PROFILE_PATCH_RELOAD = "live";   // custom profiles
```

`initProfile` writes three files and **never overwrites** (`dsh-app-boot/lib/index.js:379-398`):

```json
{ "name": "dsh-profile-myprof", "private": true, "dependencies": {},
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base"], "patchReload": "live" } } }
```
plus `cordis.patch.yml` (containing `[]`) and `pnpm-workspace.yaml`
(`packages: [.]`, `nodeLinker: hoisted`, `autoInstallPeers: false`).

Constraints: shipped names are reserved; the target dir must not exist; the `desktop` name is
rejected for boot/dump/plugin by the CLI. Profile names may not contain `/`, `\`, `.`, `..`, or equal
`node_modules` (`resolveProfileDir`, `dsh-app-boot/lib/index.js:323-326`).

### 7.2 (b) Install a plugin

`dsh plugin --profile <name> <pnpm args>` is a **thin pnpm forwarder plus a reconcile pass**
(`$DSH/lib/plugin-Ddi42qoW.js`). It initializes the profile on first use if needed.

```sh
# From a local directory (recommended for development — symlink, live edits):
dsh plugin --profile web add link:/abs/path/to/my-plugin
dsh plugin --profile web add file:/abs/path/to/my-plugin     # copy
dsh plugin --profile web add /abs/path/to/my-plugin          # bare absolute path

# Relative paths are anchored to the INVOKING directory, not the profile dir
# (anchorPathSpec rewrites `.`, `..`, `file:.`, `link:..` against process.cwd()).
cd /abs/path/to/my-plugin && dsh plugin --profile web add .

# From a tarball:
dsh plugin --profile web add /abs/path/to/my-plugin-0.1.0.tgz

# From a registry / git / github:
dsh plugin --profile web add my-plugin
dsh plugin --profile web add github:owner/repo
dsh plugin --profile web add git+https://github.com/owner/repo.git

# Remove:
dsh plugin --profile web remove my-plugin
```

`anchorPathSpec` (`$DSH/lib/plugin-Ddi42qoW.js`) — the reason relative paths "just work":

```js
function anchorPathSpec(argument, cwd) {
	const match = /^(?<prefix>(?:file|link):)?(?<path>\.{1,2}(?:[/\\].*)?)$/.exec(argument);
	if (match?.groups?.path === void 0) return argument;
	return `${match.groups.prefix ?? ""}${resolve(cwd, match.groups.path)}`;
}
```

with the doc explaining the hazard it prevents: *"pnpm runs with cwd = the profile directory, so a
bare `.` or `../plugin` (or their `file:`/`link:` forms) would silently resolve inside the profile —
`add .` from a plugin checkout would self-link the profile."*

**You do not edit `dsh.profile.bundles` by hand.** After a successful pnpm run, `reconcilePlugins`
reads the installed state and appends every dependency whose package declares `dsh.bundle.patch`.
Two useful consequences: git/path/tarball/alias specs reconcile by their **true installed package
name**, and `pnpm update` activates a package that *gained* a `dsh.bundle` declaration in a newer
version. A dependency that stops declaring one is removed from the layer list.

**Git-hosted plugins need an explicit build allow** — `dsh` prints this hint when pnpm exits nonzero
on a git spec:

```
dsh: git-hosted plugins build on install via their prepare script, which pnpm blocks until allowed —
add the exact key pnpm printed above under allowBuilds in <profile>/pnpm-workspace.yaml, then re-run
```

The live profile already does this (`$HOME_DSH/profiles/web/pnpm-workspace.yaml`):

```yaml
allowBuilds:
  cpu-features: true
  node-pty: true
  ssh2: true
```

**`pnpm` must be on PATH** or `dsh plugin` exits 127 with
`dsh: pnpm not found on PATH — install pnpm to manage profile plugins`.

### 7.3 (c) See the composed config

```sh
dsh --profile web --dump-config             # full tree: bundles + profile patch + home patch + --patch
dsh --profile web --dump-default-config     # bundle layers ONLY (no user layer, no --patch)
dsh --profile web --dump-config --patch ./extra.yml
```

Both are **boot-free**: *"without booting or evaluating `!!js`"* (`$DSH/lib/dump-config-lFgMwK8i.js`).
`--dump-default-config` *"prints the bundle layers and takes no `--patch`"* and is the recovery
diagnostic for a broken `cordis.patch.yml`, *"which is then never parsed"*. Dumps take no app
arguments. Output is *"one loadable YAML document"* with `# ==` provenance comments naming each
source file and which layers patched each row. There is **no byte-stability promise**
(`dsh-app-boot/README.md`: *"decide whether the dump becomes a serialization contract before anything
consumes it programmatically"*), so grep it, do not diff it.

### 7.4 (d) Boot the web GUI and verify the row mounted

```sh
dsh web                  # or: dsh --profile web
```

`dsh web` is a hardcoded alias of `--profile web`. Port and host are **app** flags, not launcher flags —
the first token the launcher does not recognize starts them. The web app's own `--help` lists exactly:

```
Options:
  --host <host>                  bind host
  --no-open                      do not open the Web UI in the default browser
  --port <port>                  listen port; pass 0 to let the OS pick a free one
  --trusted-host <authority...>  extra authority the /api browser-trust fence accepts (host or host:port; repeatable)
  -h, --help                     show this help
```

Defaults come from the bundle patch, not the CLI (`$PKG/dsh-web-app/cordis.patch.yml`):

```yaml
        host: !!js ctx.webStartup.host ?? '127.0.0.1'
        port: !!js ctx.webStartup.port ?? 3080
```

So `dsh web` listens on `127.0.0.1:3080` by default, and `--host 0.0.0.0` is rejected at startup.
Startup prints an **authenticated** URL; a bare `curl http://127.0.0.1:3080/` answers `401`.

**Four ways to verify your row mounted, best first:**

1. `dsh --profile web --dump-config | grep <row-id>` — the documented check, proving the row is in the
   *composed* tree.
2. **The GUI's plugin inventory** (`pluginInventory/list` Remote, `@deepseek-ai/dsh-host-plugin-inventory`)
   — this reads **live** Loader entries, one per non-group row: *"its entry id, the exact module
   specifier, the effective enablement … and the current root Fiber phase. `pending` … `active` …
   `failed`"*. This is the only view of what actually mounted, and there is **no CLI equivalent**.
3. **A boot failure.** A row that never activates fails the whole boot with a nonzero exit, naming the
   services it waited for.
4. **An observable contribution** — a registered tool in the tool list, a `systemPrompt.section` in the
   assembled prompt.

**Reading a failed `apply()`.** The error chain is nested, and the innermost frame names your row. Each
stage of the loader wraps the previous error
(`$PKG/cordis-plugin-loader/lib/index.js:307-310`):

```js
function updateError(stage, options, cause) {
	const detail = cause instanceof Error ? cause.message : String(cause);
	return new Error(`failed to ${stage} loader entry ${options.id} (${options.name}): ${detail}`, { cause });
}
```

with stages `import`, `apply`, `dispose`, and `rollback`. A real thrown error therefore surfaces as:

```
dsh: plugin tree failed to load: failed to apply loader entry include (cordis:include): failed to apply loader entry boom (./boom.js): BOOM_FROM_APPLY
Error: BOOM_FROM_APPLY  at new apply (file:///…boom.js:4:9) … at file:///tmp/…#boom  at file:///tmp/…#include
```

The outer stage label is one of two (`$PKG/dsh-app-boot/lib/index.js:1527-1533`):

```js
	let stage = "host preparation failed";     // a `prepare` throw before any entry mounted
	…
	stage = "plugin tree failed to load";
```

and two other audit messages exist for the non-throwing cases:

```
dsh: plugin(s) failed to load: <names>; Cordis startup failed because these plugin(s) could not be resolved (see the error(s) logged above)
dsh: <N> entry/entries did not activate
<name>: <activation error>
<name>: pending (waiting for service: <missing>)
```

The `at file:///…#boom` / `#include` frames come from `Entry.getOuterStack` — **that is how you find
which row threw.**

A missing `apply` is reported usefully too:
`invalid plugin, expect function or object with an "apply" method, received object`.

### 7.5 (e) Reading host logs — **`ctx.logger` output goes nowhere**

This is the most counter-intuitive part of the whole dev loop, so it is stated as a correction to the
obvious assumption: **there is no host log file, and `ctx.logger.info/warn/debug` prints nothing to
stdout or stderr either.**

**No log file.** No `logs/` directory and no `*.log` anywhere under `$HOME_DSH` (verified by `find`).
The only log files on this machine are plugin-owned, not host-owned:
`$HOME_DSH/profiles/web/.dsh-market/log.ndjson` (dshmarket's own sink) and
`.plugin-manager/logs/operation-*/pnpm.log` (pnpm captures).

**`ctx.logger` is not wired to a console.** `LoggerService`'s constructor installs exactly **one**
exporter — an in-memory ring buffer (`$PKG/cordis/src/logger.ts`):

```js
	self.exporter({ colors: 3, export: (message) => {
		self.buffer.push(message);
		if (self.buffer.length > self.bufferSize) self.buffer = self.buffer.slice(-self.bufferSize);
	} });
```

`bufferSize = 1000`. A grep for any other `.exporter(` registration across the DSH CLI and all 240
first-party packages finds **none** (the OTel session-telemetry row is unrelated). And the level filter
is:

```js
	if ((exporter.levels?.[this.name] ?? exporter.levels?.default ?? this.level ?? 1) < level) continue;
```

With no configuration that threshold is **1**, so `error`(0) and `info`(1) reach the buffer while
**`warn`(2) and `debug`(3) are silently dropped entirely.** Reproduced on this machine against the
installed Cordis:

```
$ node /tmp/logtest.mjs
--- calling loggers ---
--- stdout/stderr above? ---
exporter count = 1
buffer = [ 'error:E0-line', 'info:I1-line' ]
```

Four calls, zero output lines, and `warn`/`debug` not even buffered. So `dsh-ultramath`'s
`ctx.logger?.info?.(...)` calls are invisible in this deployment — the defensive optional chaining is
idiomatic for a reason, but the calls themselves are no-ops on the surface.

**What this means for verifying `apply()` ran.** Do not reach for a log grep; use one of these:

| Method | Proves |
|---|---|
| `dsh --profile web --dump-config \| grep <row-id>` | The row is in the composed tree (documented check; `dsh-ultramath/AGENTS.md`: *"确认 row-id 已注入"*) |
| The GUI's plugin inventory (`pluginInventory/list` Remote, `@deepseek-ai/dsh-host-plugin-inventory`) | The **live** fiber phase per row: *"Each row is one non-group Loader entry: its entry id, the exact module specifier, the effective enablement … and the current root Fiber phase. `pending` … `active` … `failed`"* — this is what actually mounted |
| A boot failure | A row that never activates fails the whole boot, nonzero, naming the services it waited for |
| Your own observable contribution | A registered tool appears in the tool list; a `systemPrompt.section` appears in the assembled prompt |
| Write a file from `apply()` | Unambiguous, and survives the process |

**Boot failures DO reach stderr** — those paths use `process.stderr.write`, not `ctx.logger`
(`profile-boot-Dk-7KqJc.js`, `dsh-app-boot/lib/index.js`, `installFailLoud`). The loader's own
per-entry "apply plugin X" info lines are off by default as well
(`showLog` returns early unless `entry.parent.tree.enableLogs`, and the root include is created
without it). So:

```sh
dsh web 2>&1 | tee /tmp/dsh-web.log    # captures boot failures, NOT ctx.logger output
```

**If you need plugin logs on the surface**, install your own exporter, or write to stderr directly —
which is what DSH itself does:

```js
ctx.logger.exporter({ levels: { default: 3 }, export: (m) => process.stderr.write(`${m.type}: ${m.args.join(' ')}\n`) })
```

In-process, `ctx.logger.buffer` holds the last 1000 messages — but it is not on disk and does not
survive a restart.

### 7.6 Restart vs hot reload

| Change | Effect |
|---|---|
| Editing the profile's `cordis.patch.yml` | **Hot**, on a `patchReload: live` profile (the shipped `web` profile). *"a valid edit recomposes without restart, while a rejected edit leaves the last good app running."* |
| Editing `$DSH_HOME/cordis.patch.yml` | **Hot** on a live profile — both files are watched (`watchUserPatches` is called twice in `runProfile`). |
| Editing your plugin's **source** | **Hot only if** `link:`-installed *and* the `hmr` row is enabled. `dsh-base` ships `- id: hmr / name: '@deepseek-ai/cordis-plugin-hmr' / disabled: true` with the comment *"Module reload is opt-in per profile. `patchReload: live` config watching uses the launcher's watch-only fallback and does not require this row."* The launcher injects a watch-only HMR fallback when the row is absent (`runProfile`: `if (ctx.get("hmr") === void 0) { … await ctx.loader.create({ name: "@deepseek-ai/cordis-plugin-hmr", config: { root: [] } }) }`) — **watch-only**, so config changes apply but module code does not reload. |
| Installing/removing a package | **Restart.** `dsh plugin` runs in a separate process; the running server keeps its old module graph. |
| Adding a row that provides a new **service** | Usually hot after a restart-free patch edit, since activation is service-availability driven. But a *newly installed package* is not in the running process's resolution — restart. |
| `patchReload: startup` profiles (`headless`, `sdk`, `acp`, `sdk-minimal`) | **No watchers at all.** Restart required. |

The `patchReload` field is validated (`dsh-app-boot/lib/index.js:848-850`):

```js
	if (rawPatchReload !== void 0 && rawPatchReload !== "live" && rawPatchReload !== "startup")
		throw new Error(`${binName}: profile manifest ${join(dir, "package.json")} dsh.profile.patchReload must be "live" or "startup"`);
```

**What is watched, exactly** — `watchUserPatches` registers a watcher on **one file path**
(`$PKG/dsh-app-boot/lib/index.js:1109-1129`):

```js
async function watchUserPatches(ctx, options) {
	const { binName, filename, compose = (patches) => patches } = options;
	const hmr = ctx.get("hmr");
	if (hmr === void 0) throw new Error(`${binName}: user patch-layer watching requires the Cordis HMR service`);
	const entry = bootstrapIncludes.get(ctx);
	if (entry === void 0) throw new Error(`${binName}: user patch-layer watching requires the root Include entry`);
	const register = hmr.registerConfig(filename, async () => {
		const { patches: _previousPatches, ...includeConfig } = entry.options.config;
		const patches = compose(loadOptionalPatches(binName, filename) ?? []);
		await entry.update({ config: { ...includeConfig, patches } });
	});
	…
}
```

`runProfile` calls it twice — once for `composed.profile.patchPath`, once for `homePatchPath()`. Those
are **the only two paths watched**. Consequences, stated as a rule:

- **`package.json` is not watched.** `dsh.profile.bundles` is read once at boot by `loadProfile` →
  `loadProfileDirectory`. Installing, updating, or removing a package changes that file, so **a
  restart is required** for the change to take effect. `dsh plugin` runs as a separate process against
  the profile directory; the already-running server keeps its old module graph and bundle list.
- **Your plugin's source is not watched by default.** The `hmr` row ships `disabled: true` in
  `dsh-base/cordis.patch.yml`, with the note *"Module reload is opt-in per profile. `patchReload: live`
  config watching uses the launcher's watch-only fallback and does not require this row."* The
  launcher's fallback creates `@deepseek-ai/cordis-plugin-hmr` with `config: { root: [] }` — an **empty
  root**, i.e. watch-only. So on a default `web` profile, **editing `lib/index.js` does nothing until
  you restart.** To get real module HMR, remove `disabled: true` from the `hmr` row and set
  `root: ['.']` in the profile's own patch layer, and install your plugin with `link:` so the running
  process resolves the file you are editing.
- **Rejected edits are safe.** *"a valid edit recomposes without restart, while a rejected edit leaves
  the last good app running."*
- **`startup` profiles have no watchers at all** — the shipped `headless`, `sdk`, `acp`, and
  `sdk-minimal` templates set `patchReload: "startup"`; *"A `startup` profile installs neither those
  watchers nor the launcher's watch-only HMR fallback."*

### 7.7 What `cordis.yml` is — do not edit it

The profile root is an **empty entry list**, rewritten on every boot
(`$DSH/lib/profile-boot-Dk-7KqJc.js`):

```js
/** The empty root entry list every profile tree patches over. */
const PROFILE_ROOT_CONFIG = `# dsh profile root — an empty entry list. The tree is composed as patches:
# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any
# --patch overlays. Edit cordis.patch.yml, not this file.
[]
`;
```

`prepareProfile` does `writeFileSync(join(profile.dir, PROFILE_ROOT_FILENAME), PROFILE_ROOT_CONFIG)`
on every boot, deliberately: *"The root is always rewritten: the whole composition is patch layers,
and the vendored Loader's tree write-back (a plugin self-disposing persists the current tree) can bake
composed rows into this file — which would duplicate every bundle insert on the next boot."*
**Any edit to `cordis.yml` is silently discarded.** Verified on disk: `$HOME_DSH/profiles/web/cordis.yml`
is exactly that `[]` document.

---

## 8. Pitfalls, each provable

### P1. Ship plain ESM JavaScript — there is no build step at load time

**Author ESM, ship prebuilt JS.** Every one of the 240 first-party packages under `$PKG` declares
`"type": "module"` except one binary addon, and so does every third-party plugin installed in this
profile. The loader imports through Node ESM (`$PKG/cordis-plugin-loader/lib/index.js:269-284`) and
nothing transforms TypeScript, JSX, or anything else at load time — `import` resolves a real file.

DSH's own packages publish only built output (`"files": ["lib/index.js", "lib/types/**/*.d.ts"]`), and
the README is explicit that *"Production runs require built package and frontend artifacts."*
`dsh-ultramath` ships `lib/index.js`; `dsh-chat-import` ships `lib/index.mjs`;
`@vectorize-io/hindsight-coding-agents` ships `dist/index.js`.

**Two refinements that matter, both empirically confirmed on this machine:**

1. **ESM is a convention, not a loader-enforced rule.** There is no `.cjs` rejection. A row
   `name: './cjs.cjs'` with `module.exports = { name, apply }` **boots and runs** — the loader
   normalizes the interop result via `unwrapExports`
   (`$PKG/cordis-plugin-loader/lib/index.js:745-751`). So CommonJS survives, but nothing in the
   ecosystem ships it; do not be the first.
2. **`.ts` "works" only by accident of the local Node version.** On Node 25 a row `name: './ok.ts'`
   with type annotations boots — because **Node 25's own strip-only type stripping** handled it, not
   DSH. It breaks immediately on non-erasable syntax (`TypeScript enum is not supported in strip-only
   mode`) and under `node --no-experimental-strip-types`
   (`Unknown file extension ".ts"` / `ERR_UNKNOWN_FILE_EXTENSION`). The loader's only TypeScript
   accommodation is rewriting a relative `./x.ts` specifier to `./x.js`
   (`__rewriteRelativeImportExtension`) — it does not transform anything.

**Consequence — `exports` matters.** A subpath you did not declare is unreachable:
`dsh: cannot resolve ESM export ${specifier} from installed package ${packageName}`
(`$PKG/dsh-app-boot/lib/index.js:496-499`). This is exactly how hindsight exposes a *different* entry
for DSH (`"./dsh": "./dist/dsh.js"` alongside a generic `"."`). Declare every entry point you intend a
composition row to name.

### P2. Node version — the floor is 22, enforced in code, not in a manifest

**`@deepseek-ai/dsh` declares no `engines` field at all** (verified by JSON inspection and by absence
from `package-lock.json`'s root entry). The only packages in the whole install declaring `engines` are
the two `node-addon-system*` binary addons, which say `{"node": ">=20"}`.

The real floor is functional and hard-coded in the loader
(`$PKG/cordis-plugin-loader/lib/index.js`):

```js
const [major] = process.versions.node.split(".").map(Number);
if (major < 22) return;   // no internal loader below 22
```

Below Node 22 there is no internal module loader, so bare package specifiers and HMR have no path.
That matches Cordis's README (*"the scaffolder requires **Node 22 or newer**"*).

Third-party declarations on this machine cluster at the same floor:
`dsh-ultramath`, `dsh-ivory`, `dsh-context`, and `@linxin666/dsh-client-ui-git-graph` all declare
`"node": "^22.19.0 || >=24.0.0"`; `dsh-chat-import` says `>=22.13`; `dsh-better-sidebar` and
`@zhangfengshun/dsh-remote-ssh` are looser at `>=20`; `dshmarket`, `dsh-at-file`, `dsh-find-plugin`,
`@dsh-community/dsh-paste-input`, and `@vectorize-io/hindsight-coding-agents` declare none.

**Recommendation:** declare `"engines": { "node": "^22.19.0 || >=24.0.0" }` to match the strictest
peers, and remember that the *host* requirement is a different field — `engines.dsh` (or
`dsh.engines.dsh`), read by the marketplace (§1.3). Host here: Node `v25.9.0`.

API baseline: the shipped packages use `Array.prototype.toSpliced` and `findLastIndex`
(`dsh-agent-instructions`, `dsh-tool-todo`), so Node 20+ language features are safe.

### P3. `config` replaces wholesale — restate every field

Three independent sources (§2.1 rule 5). The practical trap: a user adds
`- id: my-plugin / config: { debug: true }` intending to tweak one field and silently deletes every
other config value, because the loader does `target[key] = value`. This is not a deep merge under any
circumstances.

### P4. Everything registered must be disposable, or it leaks

The rule (`cordis/src/fiber.ts`): *"Effects, event listeners, and services are removed when their
owning fiber is disposed."* That is a promise about what the framework does **for** you, and it only
holds if you go through `ctx.effect` / `ctx.on` / `ctx.provide` / `ctx.plugin`. Anything you register
by hand — a `setInterval`, a file watcher, a raw socket, a resource obtained via `ctx.get('x')` with a
`close()` — is yours, and **must** be returned from a `ctx.effect` body:

```js
// CORRECT — the disposer is collected and runs on unload, in reverse order.
ctx.effect(() => {
  const timer = setInterval(tick, 1000)
  return () => clearInterval(timer)
}, 'my-plugin: ticker')

// WRONG — a leaked timer outlives the plugin, and hot reload accumulates them.
setInterval(tick, 1000)
```

The reverse-order guarantee is explicit (`Fiber.effect` doc): *"the disposers it produces are
collected and run (in reverse order)."* Double disposal is safe (*"Calling the disposer twice is a
no-op"*). `ctx.on` and `ctx.provide` are already effect-wrapped internally
(`EventsService.register`, `ReflectService.provide` both call `this.ctx.fiber.effect`), so their
returned disposers are redundant — but a `section()` from `systemPrompt` returns *"the exact Cordis
effect disposer"* and `dsh-ultramath` double-wraps it, which is harmless and defensive.

**Registering after disposal throws** (`CordisError` code `INACTIVE_EFFECT`,
`'cannot create effect on inactive context'`), which is what makes an `await` before registration
dangerous:

```js
// WRONG — if the plugin unloads during the await, the registration throws.
export async function apply(ctx) {
  const data = await fetchSomething()
  ctx.on('agent/pre-step', handler)   // CordisError: INACTIVE_EFFECT
}
```

Note `apply` may return a promise (the fiber awaits it), but nothing about disposal is suspended for
it. Guard with `ctx.fiber.assertActive()` or re-check after long awaits.

**There is no leak warning. Nothing will tell you.** A grep for `leak|undisposed|not disposed|still
active` across Cordis and the loader matches only a doc line. A leaked timer, an open file handle, or a
forgotten `scope.watch()` subscription produces no diagnostic — it just accumulates across reloads
until something breaks. The framework removes what *it* owns; the rest is silently yours.

**On errors thrown from `apply`:** the fiber is marked `FAILED`, the error is logged through
`ctx.logger.error(reason)` by `Fiber._reload`, and `fiber.await()` rethrows it — which is what
`assertEntriesActivated` awaits to build the loud boot failure. The plugin does **not** retry and does
**not** bring down unrelated rows; but on a `patchReload: live` profile, a config edit that re-composes
the row will re-run `apply`. (And because `ctx.logger` has no console exporter — §7.5 — that
`logger.error(reason)` is itself invisible; the *boot failure* is what you actually see.)

### P5. Row order carries no load semantics — but activation does, and typos are silent

Two failure modes that look nothing alike:

**(a) A silent no-op.** A patch whose `id` does not match any row prints a `warn` to stderr and is
**skipped** — it does not throw. `patch: entry %C not found`, `patch insert: entry %C not found`,
`patch insert: entry %C is not a group`, `patch: name mismatch for %C (expected %C, got %C), skipping`.
On a long boot log, `my-plugin` simply does nothing and the user sees no error. **Always confirm with
`--dump-config`.**

**(b) A pending row that never activates.** Since activation is service-availability driven
(`dsh-base/cordis.patch.yml`: *"Row order carries no load semantics"*), a row listed *before* its
dependency is fine — but a row whose dependency is never mounted stays `PENDING` forever. This does
fail loud at boot (`N entry(s) did not activate` / `pending (waiting for service: X)`), so it is
findable — but only at startup, and only as a name list.

The complement: **declaring a dependency you do not use buys a hard startup failure.** `inject` is a
hard gate, not a hint. If a service may or may not be mounted, use `ctx.get(name)` and check for
`undefined` rather than `inject`.

### P6. Service-name collisions and the realm rule

Registering a service name already provided in the same scope throws
`service "${name}" has been registered at <${fiber.name}>` (`cordis/src/reflect.ts`). And per the
composition model, **a row that publishes a service may not sit loose in an agent preset** — it must
sit behind an `isolate` realm or move to the host composition. This is a real, load-bearing rule for
plugin authors: if your host-plane plugin publishes a service, it belongs in `dsh-base`-style host
composition (or a group carrying `isolate`), never loose in a per-session preset.

### P7. `!!js` is JSON-schema YAML plus one tag

`const schema = entryListSchema = yaml.JSON_SCHEMA.extend(JsExpr)` (`dsh-app-boot/lib/index.js:30-31`).
So no YAML 1.1 conveniences, and `!!js` is evaluated with `with (ctx) { return eval(expr) }` at
per-fiber config resolution. In `dsh-base` the useful scope entries are `dshHomePath` (provided at
`dsh-app-boot/lib/index.js:1530`) and `process`:

```yaml
config:
  root: !!js dshHomePath('sessions')
  mode: !!js process.env.DSH_TELEMETRY_MODE || 'FEEDBACK_ONLY'
```

Note `process.env.*` is read **at boot**, not per request. And `--dump-config` echoes `!!js` verbatim
rather than evaluating it, so a dump is not a resolved value.

### P8. The empty-patch-file trap

An empty or comments-only `cordis.patch.yml` **fails boot**. `$HOME_DSH/cordis.patch.yml` says so
plainly: *"The file must stay a non-empty YAML array. An empty or comments-only file fails boot; use
`[]` to disable this layer."* The shipped template already writes `[]` plus comments
(`PROFILE_PATCH_TEMPLATE`), so a hand-truncated file is the usual cause. Recover with
`--dump-default-config`, which never parses the user layer.

### P9. `cordis.yml` edits vanish

See §7.7. Rewritten on every boot by design. Edit `cordis.patch.yml`.

### P10. `dsh.plugin.json` is inert

See §1.3. Zero core readers. A DSH-version gate written there does nothing; put `engines.dsh`
in `package.json`.

### P11. The tool schema DSL is a closed vocabulary with one mandatory key

Three traps in one, all in `dsh-tools`:

1. **`parameters` is not JSON Schema.** `required` is per-property and must be the literal `true`.
2. **`additionalProperties` is mandatory on every object node**, including nested `items` and
   `output.schema` — `unsupported JSON schema: <path>.additionalProperties must be explicitly true or false`.
3. **Common JSON Schema keywords are rejected by name.** `minimum`, `maximum`, `pattern`, `minLength`
   and friends produce `… is not supported by the value schema DSL`. Validate those inside `execute`
   and throw a plain `Error` — the registry wraps it as an error result for the model.

A fourth, quieter one: **`description` is not enforced at registration.** `defineTool` will happily
accept a tool with no `description`, and the schema sent to the model simply omits the key — so a
forgotten description degrades the model's tool choice with no error anywhere.

### P12. `timeoutMs` does nothing on its own

`dsh-tools/README.md`: *"the registry never enforces deadlines; enforcement requires the
`@deepseek-ai/dsh-tool-call-timeout-policy` wrapper."* Declaring `timeoutMs: 30_000` on a tool whose
`execute` ignores `exec.signal` produces a tool with **no effective timeout** and a false sense of
safety. Two obligations go together: declare the budget **and** forward `exec.signal` to the underlying
work. The same signal discipline applies without `timeoutMs` — every `execute` receives
`exec.signal` and *"async work must observe or forward `exec.signal` and settle only after its owned
work reaches quiescence."*

### P13. Editing your plugin's source changes nothing until you restart

The single most likely thing to waste an afternoon. On a stock `web` profile (`patchReload: live`),
only two files are watched: the profile's `cordis.patch.yml` and `$DSH_HOME/cordis.patch.yml`
(§7.6). The `hmr` row — the thing that reloads **modules** — ships `disabled: true` in `dsh-base`.

So this loop does **not** work by default:

```sh
# WRONG EXPECTATION: edit lib/index.js, see the change
dsh plugin --profile web add link:/path/to/my-plugin
dsh web
# … edit lib/index.js … nothing happens, ever
```

What actually works:

1. **Patch/config changes** (adding or disabling a row, editing `config:`) — hot on a `live` profile.
   This is the fast path for iterating on composition.
2. **Plugin source changes** — restart `dsh web`, or enable the `hmr` row explicitly in the profile's
   patch layer and install with `link:`.
3. **Package add/remove/update** — always restart; `package.json` is not watched.

For quick iteration, prefer proving the *composition* with `--dump-config` and a restart over expecting
module reload.

### P14. A `warn`, not an error, is the default failure for a mistargeted patch

Repeated from §2.1 because it is the pitfall most likely to cost real time: an `insert` or override
naming an `id` that does not exist, or asserting a `name` that does not match, **does not throw**. It
prints one line to stderr and is skipped. In a boot log full of plugin chatter, that line is easy to
miss, and the plugin simply does nothing. `--dump-config` is the only reliable check — the composed
output shows exactly which rows exist and which layer contributed them.

### P15. A duplicated row `id` is a hard boot failure

The one patch mistake that *is* fatal. The loader pre-scans ids and refuses duplicates
(`$PKG/cordis-plugin-loader/lib/index.js:88-93`):

```js
		const seen = new Set();
		for (const options of config) {
			const id = this.tree.ensureId(options);
			if (seen.has(id)) throw new TypeError(`duplicate loader entry id: ${id}`);
```

Empirically, a bundle `insert` of an id the user layer also inserts produces
`dsh: plugin tree failed to load: … duplicate loader entry id: same`. Third-party corroboration,
because it shaped a real design: `dshmarket`'s hot-mount module documents that *"a crash can never
leave a file that collides with the bundle layer (**inserting an id the bundle layer also inserts is a
hard boot failure**)"*. So a plugin that inserts rows into a user-editable patch file must namespace
its generated ids, as `dshmarket` does (`mkt-client--<slug>`).

### P16. In an `insert` row your `./path` is rewritten; in a patch assertion it is not

The anchoring asymmetry is the sharpest edge in the patch format
(`$PKG/dsh-app-boot/lib/index.js:1169-1178`):

```js
/** Convert inserted filesystem paths to file URLs, anchoring relative paths beside the patch; keep assertion names literal. */
function anchorInsertedPluginNames(patches, file) {
	const base = dirname(resolve(file));
	const visit = (entry) => {
		if (typeof entry.name === "string" && (isAbsolute(entry.name) || entry.name.startsWith("./") || entry.name.startsWith("../")))
			entry.name = pathToFileURL(resolve(base, entry.name)).href;
		if (entry.group && Array.isArray(entry.config)) entry.config.forEach(visit);
	};
	for (const patch of patches) patch.insert?.forEach(visit);
	return patches;
}
```

An `insert` row's `./x.js` becomes `file:///…/x.js`. A **non-insert** patch's `name` stays literal, so
asserting `name: ./x.js` against an anchored row **cannot match** and the whole patch is skipped with

```
patch: name mismatch for "js-row" (expected "file:///tmp/…/p.js", got "./WRONG.js"), skipping
```

**Rule: use `./x.js` in `insert` rows, and *omit* `name` in id-targeted patches** — or repeat the
post-anchoring `file://` URL exactly. `id` alone is a sufficient selector.

### P17. `disabled: 0` starts the row

`disabled` is coerced with `Boolean(...)`
(`$PKG/cordis-plugin-loader/lib/index.js:377-379`):

```js
	disabledOf(options) {
		return isJsExpr(options.disabled) ? Boolean(this.evaluate(options.disabled.__jsExpr)) : Boolean(options.disabled);
	}
```

So `disabled: 0` — and `disabled: ""`, `disabled: null` — **enable** the row. Only `true` (or a truthy
`!!js` result) disables it. `dsh-agent-presets` guards against exactly this in its own checker, noting
that such a row *"DOES start and must be checked"*. Write `disabled: true`.

### P18. `ctx.logger` output is invisible — do not debug with it

Fully explained in §7.5, repeated here because it wastes the most time: the only exporter installed is
an in-memory 1000-message ring buffer, there is no console exporter, and the default level threshold
makes `warn`/`debug` unreachable. `ctx.logger.info('reached apply')` prints **nothing**, anywhere.

Confirm `apply()` ran by another route: `--dump-config | grep <row-id>` for composition, the GUI's
plugin inventory for live fiber phase, a boot error if it never activated, or an observable
contribution (a registered tool, a prompt section). Boot *failures* do reach stderr — those paths call
`process.stderr.write` directly. If you want logs on the surface, install your own exporter with
`ctx.logger.exporter({ levels: { default: 3 }, export: (m) => process.stderr.write(…) })`.

---

## Uncertain / not provable from local evidence

Items I could not establish. **None of these are guesses in the sections above** — where I did not
know, I said so there too.

1. **Whether `agent/session.header.id`, `.cwd`, `.origin` ever existed.** The user's prompt
   hypothesized these event names. The current `Events` augmentation in
   `$PKG/dsh-agent/lib/types/runtime-types.d.ts` contains **no** such events — the header is the plain
   property `agent.session.header` with fields `version`, `id`, `createdAt`, `cwd?`, `parentSession?`,
   `isSeeded`, `origin?`, `delegationDepth?`, `agentPreset?`. Whether an older DSH emitted dotted
   header events is not determinable from this installation (only version `0.1.5-rc.2` is present).
2. **A complete list of `!!js` scope bindings.** I proved `dshHomePath` (provided explicitly) and the
   `with (ctx)` evaluation mechanism, and observed `process.env` usage in shipped patches. I did not
   enumerate every name reachable in that scope.
3. **The exact `ContentBlock` variant set.** **RESOLVED** — `ContentBlockMap`
   (`dsh-llm/lib/types/types.d.ts:91-102`) has exactly six variants: `'text': TextBlock`,
   `'reasoning': ReasoningBlock`, `'image': ImageBlock`, `'file': FileBlock`,
   `'tool-call': ToolCallBlock`, `'tool-result': ToolResultBlock`, and
   `ContentBlock = ContentBlockMap[ContentBlockType]` is *"merge-extensible"*. In `output.render`
   you will almost always return `[{ type: 'text', text }]`. What remains unverified is each
   variant's **field list** (I read only the tag vocabulary, not `TextBlock`/`ImageBlock` bodies).
4. **`ctx.storage` (the hub) direct call surface.** The README states it is *"a host-side registration
   table"* and that consumers should use `ctx.storageDomain`; I did not extract the `Storage` class
   method signatures. **Use `ctx.storageDomain`, not `ctx.storage`.**
5. **Whether a plugin can mount its own storage backend (e.g. sqlite).** No `storage-sqlite` package
   exists in the installation; the backend contract is documented only in a repo-relative doc
   (`docs/subsystems/storage.md`) not shipped in this install.
6. **`dsh.engines` vs top-level `engines.dsh` precedence in the *registry* (as opposed to the market
   client).** `dshmarket` reads both and prefers top-level; the awesome-dsh-plugin registry's own
   server-side schema is not on this machine.
7. **`awesome-dsh-plugin.com/plugins.json` entry schema.** The file is fetched live from the network;
   no local copy exists.
8. **The complete `ToolCallView` / `ToolResultView` variant set.** **PARTIALLY RESOLVED** —
   `ToolCallView = GenericCallView | TerminalCallView | DiffCallView` and
   `ToolResultView = GenericResultView | TerminalResultView | DiffResultView | SearchResultView | ReadResultView | WebResultView`
   (`dsh-tools/lib/types/presentation.d.ts:41,130`), each discriminated by `card`
   (`'generic' | 'terminal' | 'diff' | 'search' | 'read' | 'web'`). I did not read every variant's
   full field list. `GenericCallView` alone is confirmed: `{ card: 'generic'; title: string; kind?: ToolCallKind; … }`.
9. **The full `Scoped<T>` / scope-key model.** **PARTIALLY RESOLVED** — `Scoped<T>` is
   `object & { readonly [ScopedBrand]: T }` (`dsh-scope/lib/types/index.d.ts:18-20`), documented as
   *"A routing-only event receiver built by `scopeTarget`. … the carrier does not expose the subject's
   properties. Event payloads carry the real subject."* So **the `this` of an agent event is not the
   agent — read `payload.agent`.** `bindScopeParent`/`ScopeParentBinding` and `scopeTarget` exist; I did
   not read the filter predicate contract in full.
10. **Whether `defineTool` is importable from the package root.** **RESOLVED** —
    `dsh-tools/package.json` `exports["."]` is the runtime entry (`./lib/index.js`), and `lib/index.js:837`
    defines `function defineTool(options)`. So
    `import { defineTool } from '@deepseek-ai/dsh-tools'` is correct. The package also exposes
    `./invariant`, `./types`, `./presentation`, `./src/*`.
11. **Windows/macOS/Linux behavioural differences.** `dsh-sandbox-windows-acl`, `dsh-win32-process`,
    and `node-addon-system-darwin-arm64` exist; I did not investigate platform gating beyond seeing
    `disabled: !!js process.platform === 'win32'` used in shipped presets.
12. **How `output.presentationMeta` values are consumed by GUI renderers.** The host-side contract
    (`JsonValue` persisted on `tool/result.meta`) is clear; the client-side consumer is out of scope
    for a host-plane plugin reference.
13. **Every emitter and every consumer of `session/flush`.** I confirmed the parallel dispatch mode and
    its purpose (*"Awaited parallel durability checkpoint"*) but did not trace which packages subscribe.
14. **No CLI subcommand lists *mounted* rows.** `lib/bin.js` has no `plugin list` / `status`; the
    `plugin` subcommand requires `--profile` plus pnpm arguments. The only live view of fiber phase is
    the GUI's `pluginInventory/list` Remote (§7.4). Whether an undocumented CLI equivalent exists:
    **UNKNOWN.**
15. **Whether a local `.tgz` file path is accepted by `dsh plugin add`.** The installed plugins document
    an **https `.tar.gz` URL** (`https://github.com/omddev/…/archive/refs/tags/v0.7.0.tar.gz`). DSH
    forwards any non-relative spec verbatim to pnpm (`anchorPathSpec`), so local-tarball support is
    pnpm's behaviour, not DSH's — **UNKNOWN** without running pnpm.
16. **Whether a third-party plugin may register additional `cordis:` builtins.** `ctx.loader.builtins`
    is a plain property on a null-prototype object, so `ctx.loader.builtins.myThing = …` is technically
    possible, and `import()` would resolve `cordis:myThing`. **No installed plugin does this**, and it
    is not documented as a supported contract — treat it as **UNKNOWN / unsupported**.
17. **Whether DSH transforms or validates a tool name's format.** No name-format validation exists in
    `dsh-tools`, `dsh-llm`, or `dsh-system-prompt`; the DeepSeek adapter passes `name` through
    verbatim. Provider-specific constraints are therefore **UNKNOWN**.
18. **`dsh-ultramath`'s `scripts/validate-package.mjs` is not shipped** in the installed package, so its
    README's `npm run check` / `node scripts/validate-package.mjs --pack` commands are unverifiable from
    this install. (`scripts/` contains only `check_*.py` and `review_loop/`.) Its `package.json` `files`
    list confirms only the Python scripts are published. This is a packaging discrepancy in that
    third-party plugin, **not** a DSH API fact.
19. **Cross-referenced repository docs are absent.** Many package READMEs link to `docs/subsystems/*.md`,
    `docs/config-catalog.md`, `docs/cookbook/*.md`, `docs/api/core.md`, and `.agents/notes/*`. The
    installed checkout ships only `lib/`, `node_modules/`, `package.json`, `README.md`, and
    `README.zh.md` — **none of those referenced documents exist locally**, so any contract documented
    only there is unavailable. Everything in this reference comes from shipped code, shipped READMEs,
    shipped type declarations, or live probes.
