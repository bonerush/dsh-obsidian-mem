# DSH plugin API — Config / schemastery / settings, and durable storage for plugin-owned state

**Scope.** Reverse-engineered from LOCAL EVIDENCE ONLY on this machine. No network used.
All paths below are absolute; `$DSH` = the vendored package root:

```
$DSH = /Users/yukisala/.nvm/versions/node/v25.9.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai
```

Installed version of the harness: `dsh@0.1.5-rc.2`
(`/Users/yukisala/.nvm/versions/node/v25.9.0/lib/node_modules/@deepseek-ai/dsh/package.json`).
Vendored `@deepseek-ai/cordis@4.0.2`, `@deepseek-ai/dsh-settings@0.1.5-rc.2`.

Every claim below is either:

* **PROVEN** — quoted source line, or a live experiment executed against the vendored code (experiments are reproducible; scripts were run from `/tmp/dsh-probe/`), or
* **INFERRED** — explicitly marked,
* **UNKNOWN** — explicitly marked.

---

## 0. TL;DR

| Question | Answer |
|---|---|
| Config export shape | `export const Config = <Standard Schema v1>` — schemastery (`z.object({...})`) is the convention, **but any Standard Schema v1 validator works** (zod v4 proven). A plain object or a function **throws at load**. |
| Exact invalid-config error | `` `invalid config:\n  - <issue.message> (at <issue.path.join('.')>)` `` — class `ValidationError extends TypeError` |
| Row `config:` → `apply(ctx, config)` | **Yes, 1:1**, and schema defaults **are** applied before `apply`. Validated **eagerly, before apply runs**. |
| Does `Config` surface into `settings.yaml`? | **NO, not in this version.** `dsh-settings` never reads loader entries. Namespaces are registered explicitly by the plugin. |
| settings.yaml key | The **namespace string the plugin passes to `ctx.settings.register(ns, schema)` / `installSection(...)`** — a top-level YAML key. Grammar `/^[a-z][a-z0-9-]*$/`. Not derived from `name`. |
| Row config vs user settings | Row config = deployment-fixed, load-time, `Config`-validated, needs restart-on-change. User settings = runtime-editable, separate schema, **hot-reloaded**. |
| Durable storage for plugins | `ctx.storageDomain.open(defineDomain({...}))` — schema-validated KV domains (**zod** record schemas) over a registered backend. On disk: `<root>/<unit>.json` or `<root>/<unit>/<table>/<key>.json`. |
| sqlite exposed to plugins? | **NO.** No `dsh-storage-sqlite` package is installed. Only `dsh-session-query-sqlite` exists (a `sessionQuery` FTS5 service, not a storage backend). |

---

## 1. The `Config` export convention

### 1.1 The contract is Standard Schema v1, not schemastery

`$DSH/cordis/src/registry.ts:98-111`:

```ts
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

  export interface Transform<S, T> {
    /** Marks the transform object as a schema/config transform. */
    schema?: true
    /** Convert user-facing config to runtime config. */
    Config: (config: S) => T
  }
  ...
  /** Object plugin with an `apply(ctx, config)` method. */
  export interface Object<T = any> extends Base<T> {
    apply(ctx: Context, config: T): any
  }
```

Note `import type { StandardSchemaV1 } from '@standard-schema/spec'` at
`$DSH/cordis/src/registry.ts:3`; `@standard-schema/spec` is a direct dependency
(`$DSH/cordis/package.json`, `"dependencies": { "@standard-schema/spec": "^1.1.0", ... }`).

The four accepted plugin shapes — `$DSH/cordis/src/registry.ts:8-10, 91-95, 120-133`:

```ts
function isApplicable(object: Plugin) {
  return object && typeof object === 'object' && typeof object.apply === 'function'
}

export type Plugin<T = any> =
  | Plugin.Function<T>      // (ctx, config) => any
  | Plugin.Constructor<T>   // new (ctx, config)
  | Plugin.Object<T>        // { apply(ctx, config) }
```

**A module namespace object with `apply` is a valid plugin.** `unwrapExports`
(`$DSH/cordis-plugin-loader/src/index.ts:192-199`) only unwraps `default`/`__esModule`:

```ts
  unwrapExports(exports: any) {
    if (isNullable(exports)) return exports
    exports = exports.default ?? exports
    // https://github.com/evanw/esbuild/issues/2623
    // https://esbuild.github.io/content-types/#default-interop
    if (!exports.__esModule) return exports
    return exports.default ?? exports
  }
```

This is why `export const Config = ...` / `export const inject = [...]` /
`export function apply(...)` in a plain ESM module works: the loader passes the
**whole namespace object**, and `plugin.Config` / `plugin.inject` / `plugin.apply`
are read off it (verified: `$DSH/dsh-storage-json/lib/index.js` and
`$DSH/dsh-storage-domain/lib/index.js` have **no default export** — only
`Config, inject, name, apply`; `dsh-storage` and `dsh-settings-file` **do** have
defaults).

### 1.2 Where it is read and validated

**(a) Read once per plugin callback, into the registry runtime record** —
`$DSH/cordis/src/registry.ts:322-330`:

```ts
    let runtime = this._internal.get(callback)
    if (!runtime) {
      let name = plugin.name
      if (name === 'apply') name = undefined
      runtime = { name, callback, fibers: new DisposableList(), Config: plugin.Config }
      this._internal.set(callback, runtime)
    }

    const fiber = new Fiber(this.ctx, config, Inject.resolve(plugin.inject), runtime, getOuterStack)
```

**(b) Validated on every (re)load** — `$DSH/cordis/src/fiber.ts:50-62`:

```ts
export function resolveConfig(runtime: Plugin.Runtime, config: any) {
  if (!runtime.Config) return config
  // TODO: async validation
  const result = runtime.Config['~standard'].validate(config)
  if ('then' in result) {
    throw new TypeError('Async config validation is not supported')
  }
  if (result.issues) {
    throw new ValidationError(result.issues)
  } else {
    return result.value
  }
}
```

`$DSH/cordis/src/fiber.ts:641-644` and `:646-664`:

```ts
  private _resolveConfig(config: any) {
    config = this.context.waterfall(this, 'internal/config', config, () => config)
    return this.runtime ? resolveConfig(this.runtime, config) : config
  }

  private async _reload() {
    this.store = { ...this._store }
    const oldEpoch = this._runner.epoch
    try {
      await Promise.resolve()
      if (this._runner.epoch === oldEpoch) {
        this.config = this._resolveConfig(this._config)
        await this._execute(this._runner)
        this._error = undefined
      }
    } catch (reason) {
      this.ctx.logger.error(reason)
      this._error = reason
      this._runner.epoch = INACTIVE
    }
```

**(c) `apply` is called with the validated value** — `$DSH/cordis/src/fiber.ts:247-263`:

```ts
      this._runner = {
        epoch: INACTIVE,
        getOuterStack,
        execute: function () {
          if (isConstructor(runtime.callback)) {
            // eslint-disable-next-line new-cap
            const instance = new runtime.callback(this.ctx, this.config)
            for (const hook of instance?.[symbols.initHooks] ?? []) {
              hook()
            }
            return instance?.[symbols.init]?.()
          } else {
            return runtime.callback(this.ctx, this.config)
          }
        },
        collect,
      }
```

### 1.3 The EXACT error message for an invalid config

`$DSH/cordis/src/fiber.ts:16-40`:

```ts
const kValidationError = Symbol.for('ValidationError')

/** Error raised when plugin configuration fails standard-schema validation. */
export class ValidationError extends TypeError {
  name = 'ValidationError'

  constructor(issues: readonly StandardSchemaV1.Issue[]) {
    super(`invalid config:\n` + issues.map(issue => {
      if (issue.path) {
        return `  - ${issue.message} (at ${issue.path.join('.')})`
      } else {
        return `  - ${issue.message}`
      }
    }).join('\n'))
  }
}

Object.defineProperty(ValidationError.prototype, kValidationError, {
  value: true,
})
```

**LIVE PROOF** (executed against the vendored `schemastery` + `cordis`):

```
$ node -e ... resolveConfig(runtime, {})   # Config = z.object({enabled:..default, count:..default, name:z.string().required()})
name= ValidationError | instanceof TypeError= true | constructor= ValidationError
message(raw):
invalid config:
  - $.name missing required value (at name)
```

and through a live `ctx.plugin(plugin, { a: 'not-a-number' })`:

```
name= ValidationError message= "invalid config:\n  - $.a expected number but got not-a-number (at a)"
```

The `$.name missing required value` text comes from schemastery itself
(`$DSH/schemastery/lib/index.cjs:242`): `` throw new ValidationError(`missing required value`, options) `` with the `$`-rooted path prefixed by `Schema.ValidationError`.

This matches the shipped skill documentation
`$DSH/dsh-agent-presets/presets/cordis/skills/editing-cordis-compositions/SKILL.md:110`:

```
- a row whose config is invalid (`invalid config: $.<field> missing required value`);
```

### 1.4 `Config` must actually BE a Standard Schema — plain object/function THROW

**LIVE PROOF** (`/tmp/dsh-probe/t6.mjs`):

```
1) plain object as Config:
  THREW TypeError: Cannot read properties of undefined (reading 'validate')
2) function as Config:
  THREW TypeError: Cannot read properties of undefined (reading 'validate')
3) hand-rolled Standard Schema:
  apply config = {"b":2,"normalized":true}
4) schemastery Config with defaults:
  apply config = {"a":5,"b":2}
```

`if (!runtime.Config) return config` (`fiber.ts:51`) is a **truthiness** test, so a
plain object skips the passthrough and dies on `['~standard'].validate`.

**zod works too** — `$DSH/../zod@4.4.3` implements Standard Schema v1.
LIVE PROOF (`/tmp/dsh-probe/t7.mjs`, zod resolved from
`/Users/yukisala/.dsh/profiles/web/node_modules/zod`):

```
  zod-config apply config = {"a":9,"b":2}
  zod invalid -> ValidationError: "invalid config:\n  - Invalid input: expected number, received string (at b)"
```

**Independent corroboration from a third-party plugin.** `dsh-context@0.54.4`,
`/Users/yukisala/.dsh/profiles/web/node_modules/dsh-context/lib/index.js:2400-2413`:

```js
//#region src/host/config.ts
/**
* dsh-context host configuration — the `config:` block of the `dsh-context`
* loader row in cordis.yml.
*
* Cordis validates the entry config against this exported `Config` schema
* (any Standard Schema v1 validator — zod is ours) before `apply` runs, fills
* per-field defaults, and fails the load loudly on invalid or unknown keys
* (`.strict()`). The official plugin-config principle this answers: "anything
* that two deployments may want to set differently is a configuration field".
...
const Config = z.preprocess((v) => v ?? {}, z.object({ ... }).strict());
```

with `import { z } from "zod";` at `lib/index.js:2` and
`import z$1 from "@deepseek-ai/schemastery";` at `lib/index.js:7` — one plugin
using **both** (zod for `Config`, schemastery for its settings schema).

### 1.5 How schemastery exposes `~standard`

`$DSH/schemastery/src/index.ts:275-291`:

```ts
Object.defineProperty(Schema.prototype, '~standard', {
  get(this: Schema) {
    return {
      version: 1,
      vendor: 'schemastery',
      validate: (value: unknown) => {
        try {
          return { value: Schema.resolve(value, this, {})[0] }
        } catch (error) {
          if (ValidationError.is(error)) {
            return { issues: [{ message: error.message, path: error.options.path }] }
          }
          throw error
        }
      },
    }
  },
})
```

Note the asymmetry, which is a real footgun:

```
Config({name:"a"})                -> {"enabled":true,"count":3,"name":"a"}     # OK
Config({})                        -> THREW ValidationError: $.name missing required value
Config['~standard'].validate({})  -> {"issues":[{"message":"$.name missing required value","path":["name"]}]}
```

Calling the schema directly **throws**; going through `~standard` **returns issues**.
Cordis always uses `~standard`.

### 1.6 The `Config` export is NOT required

No `Config` → raw config is passed through **by reference, unvalidated, uncloned**
(`fiber.ts:51`).

LIVE PROOF:

```
--- bare plugin apply config --- {"z":1} typeof object
--- bare plugin apply config --- undefined typeof undefined
```

`dshmarket@1.58.0` does exactly this — `/Users/yukisala/.dsh/profiles/web/node_modules/dshmarket/lib/index.js`
has **no `Config` export at all** (grep for `Config` returns nothing) and reads
defensively:

```js
const useLaunchedDir = config?.profile === undefined && launched !== undefined;
const resolved = {
    profile: config?.profile ?? launched?.name ?? argvProfile() ?? 'web',
    ...
    allowRestart: config?.allowRestart,
    maxSnapshots: config?.maxSnapshots,
};
```

`dsh-ivory@0.2.12` (`/Users/yukisala/.dsh/profiles/web/node_modules/dsh-ivory/lib/index.js:5-7`):

```js
export const name = 'dsh-ivory';

export function apply() {}
```

### 1.7 Two more shapes: class plugins and class-static `Config`

`dsh-settings-file` is a **class** plugin and puts `Config` on the **static**:

`$DSH/dsh-settings-file/lib/index.js:87-93`:

```js
/** File-backed settings provider (`settings.yaml`/`.json`). */
var FileSettingsProvider = class extends SettingsProvider {
	config;
	static Config = z.object({
		path: z.string(),
		dshHome: z.string(),
		watch: z.boolean().default(true),
		debounceMs: z.number().min(0).default(100)
	});
```

`plugin.Config` reads the static member, so this works with the same
`runtime.Config = plugin.Config` line. Same pattern in
`$DSH/dsh-agent-default-model/lib/index.js:26-30` and
`dsh-session-projection-cache`.

---

## 2. Does a row's `config:` map 1:1 onto `apply(ctx, config)`?

### 2.1 The call chain (PROVEN, end to end)

**Step 1 — YAML row → entry options.** `EntryOptions` carries the config —
`$DSH/cordis-plugin-loader/src/config/entry.ts:8-22`:

```ts
/** Serialized plugin entry options stored in loader config files. */
export interface EntryOptions {
  /** Stable id inside the containing entry tree. */
  id: string
  /** Module specifier imported by the entry tree. */
  name: string
  /** Config passed to the plugin. */
  config?: any
  /** Marks this entry as a nested group. */
  group?: boolean | null
  /** Prevents this entry and descendants from running. */
  disabled?: boolean | null
  /** Required services or service intercept config for this entry. */
  inject?: Inject | null
}
```

**Step 2 — entry start passes it straight to the registry** —
`$DSH/cordis-plugin-loader/src/config/entry.ts:291-302`:

```ts
  private async _start(plugin: any) {
    let fiber: Fiber | undefined
    try {
      await this._patchContext([])
      this.loader.showLog(this, 'apply')
      fiber = this.fiber = this.ctx.registry.plugin(plugin, this.options.config, this.getOuterStack)
      await fiber.await()
    } catch (error) {
      await this._dispose(fiber)
      throw error
    }
  }
```

**Step 3 — registry → Fiber → `_resolveConfig` → `runtime.callback(ctx, this.config)`.**
Quoted in §1.2 above.

**Step 4 — a live config edit goes through `fiber.update`** —
`$DSH/cordis-plugin-loader/src/config/entry.ts:114-122`:

```ts
  private async _patchContext(diff: string[]) {
    await this.context.waterfall('loader/patch-context', this, async () => {
      Object.setPrototypeOf(this.ctx, this.parent.ctx)

      if (this.fiber?.uid && (diff.includes('config') || this.options.group)) {
        await this.fiber.update(this.options.config, true)
      }
    })
  }
```

and `$DSH/cordis/src/fiber.ts:736-753` (`update`) re-runs `_resolveConfig`
(validate + defaults) and then `restart()`.

### 2.2 `!!js` interpolation happens BEFORE validation

`$DSH/cordis-plugin-loader/src/index.ts:93-101`:

```ts
    ctx.on('internal/config', function (this: Fiber, _config, next) {
      const config = next()
      if (!this.entry || this.parent.fiber?.entry === this.entry) return config
      // Tree carriers (Group, Include) keep their configs literal: their
      // entry and patch lists hold other rows' configs, whose `!!js`
      // expressions belong to those rows' own fibers.
      const plugin = this.runtime?.callback as Record<PropertyKey, unknown> | undefined
      if (plugin?.[EntryGroup.key]) return config
      return interpolate(this.ctx, config)
    }, { global: true })
```

with `interpolate`/`evaluate` in `$DSH/cordis-plugin-loader/src/config/utils.ts:1-26`.
So the order inside `Fiber._resolveConfig` is:

1. `waterfall('internal/config')` → `!!js` expressions evaluated against the loader ctx
2. `runtime.Config['~standard'].validate(...)` → defaults + validation
3. `runtime.callback(ctx, validated)`

**Live evidence** in the real composition — `$DSH/dsh-base/cordis.patch.yml:141-152`:

```yaml
    - id: storage-json
      name: '@deepseek-ai/dsh-storage-json'
      config:
        root: !!js dshHomePath('storages')
```

→ on disk: `/Users/yukisala/.dsh/storages/`.

### 2.3 Config WRITE-BACK uses schemastery `simplify()`

`$DSH/cordis-plugin-loader/src/index.ts:102-109`:

```ts
    ctx.on('internal/update', async function (config, noSave, next) {
      if (!this.entry || noSave || this.parent.fiber?.entry === this.entry) return next()
      await next()
      const unparse = this.runtime?.Config?.['simplify']
      this.entry.options.config = unparse ? unparse(config) : config
      this.entry.parent.tree.write()
    }, { global: true, prepend: true })
```

`schemastery`'s `simplify` doc — `$DSH/schemastery/README.md:255-267`:

```
### schema.simplify(value)

Normalize a value by removing parts that are equal to schema defaults. This is
useful when storing user configuration and keeping persisted files compact.
```

### 2.4 Are defaults applied before apply? Are they validated eagerly?

**YES and EAGERLY (before apply).** LIVE PROOF (`/tmp/dsh-probe/t3.mjs`,
`Config = z.object({ a: z.number().default(1), b: z.string().default('hi') })`):

```
--- what apply received (partial config {b:"given"}) ---
[ { "config": { "a": 1, "b": "given" }, "cfgType": "object" } ]
--- fiber.config (validated) --- {"a":1,"b":"given"}
--- fiber._config (raw) --- {"b":"given"}
--- second fiber, config {} --- {"a":1,"b":"hi"}
--- invalid config rejection ---
name= ValidationError message= "invalid config:\n  - $.a expected number but got not-a-number (at a)"
--- bare plugin apply config --- undefined typeof undefined
```

Third-party confirmation of the semantics, `dsh-ultramath@0.6.3`
`/Users/yukisala/.dsh/profiles/web/node_modules/dsh-ultramath/lib/index.js:509-517`:

```js
/**
 * 挂载插件：把打包的 presets 同步进 DSH 的 agent-presets 根，再通过 systemPrompt 区块公告。
 * @param ctx 携带 systemPrompt 的宿主插件上下文。
 * @param config 解析后的插件配置（schema 默认值已由 loader 应用）。
 */
export function apply(ctx, config) {
  const resolve = () => ({
    announceToAgent: config?.announceToAgent ?? DEFAULT_ANNOUNCE,
```

("resolved plugin config — schema defaults have already been applied by the loader")

### 2.5 Gotcha: `this` inside `apply` is the Runtime record, not the plugin object

`$DSH/cordis/src/fiber.ts:259` calls `runtime.callback(this.ctx, this.config)` — a
**method call on `runtime`**. LIVE PROOF of `Object.keys(this)` inside `apply`:

```
"thisKeys": ["name","callback","fibers","Config"]
```

So `this` === `Plugin.Runtime` (`$DSH/cordis/src/registry.ts:135-145`). It has
**no `ctx` property** (`this.ctx.logger` threw
`TypeError: Cannot read properties of undefined (reading 'logger')` in my probe).
Never rely on `this` inside `apply`; use the `ctx` argument.

### 2.6 Gotcha: patch rows REPLACE config wholesale, they do not deep-merge

`$DSH/dsh-app-boot/lib/index.js:88-92`:

```js
		for (const [key, value] of Object.entries(overrides)) {
			if (key === "id") continue;
			target[key] = value;
		}
```

`target['config'] = value` is a whole-object assignment. Corroborated by the
README `$DSH/dsh-app-boot/README.md:144`:

```
- **A user patch replaces the whole matched config** — an id-targeted patch does not deep-merge, so a profile override restates the bundle fields it keeps.
```

and by the user's own `/Users/yukisala/.dsh/cordis.patch.yml`:

```
#   * A non-insert patch entry REPLACES the named field wholesale, and `config`
#     is replaced as a whole object — restate every field you want to keep.
```

### 2.7 What a boot failure looks like

`$DSH/cordis-plugin-loader/src/config/entry.ts:24-27`:

```ts
function updateError(stage: 'import' | 'dispose' | 'apply' | 'rollback', options: EntryOptions, cause: unknown) {
  const detail = cause instanceof Error ? cause.message : String(cause)
  return new Error(`failed to ${stage} loader entry ${options.id} (${options.name}): ${detail}`, { cause })
}
```

`$DSH/dsh-app-boot/lib/index.js:1489-1493`:

```js
	if (failures.length > 0) {
		...
		throw new Error(`${binName}: ${String(failures.length)} ${noun} did not activate\n${failures.join("\n")}`);
	}
```

with `failures.push(\`${entry.options.name}: ${formatActivationError(error)}\`)` (`:1479`)
and, for a never-satisfied inject,
`` failures.push(`${entry.options.name}: pending (waiting for ${subject}: ${missing.join(", ") || "unknown"})`) `` (`:1486`).

---

## 3. Does a plugin's `Config` schema surface into `$DSH_HOME/settings.yaml`?

### 3.1 Answer for the INSTALLED version: NO

**PROVEN by absence + live behaviour + corroboration:**

* `$DSH/dsh-settings/lib/index.js` contains **no reference** to loader entries,
  fibers, or `entry.options` — grep for `fiber.entry|entry\.options|loader`
  returns nothing.
* `$DSH/dsh-api-settings-controller/lib/index.js:429` serves exactly
  `settings.describe({ redactSecrets: true })`, i.e. only **registered** namespaces:
  ```js
  				namespaces: settings.describe({ redactSecrets: true }).map(namespaceView)
  ```
* The shipped skill `dsh-client-ui-settings-plugins/README.md:44-46` says the tab
  "reads which settings namespaces the Host serves and dispatches one slot key
  per namespace, so what renders is the intersection of two ledgers: the
  namespaces a live Host plugin registered, and the cards registered under those
  keys."
* **Every key actually present in `/Users/yukisala/.dsh/settings.yaml` maps to an
  explicit namespace constant in a DSH/plugin source file** (verified by grep):

  | settings.yaml key | declared in |
  |---|---|
  | `ui-theme` | `$DSH/dsh-client-ui-theme/lib/index.js:11` — `const THEME_SETTINGS_NAMESPACE = "ui-theme";` |
  | `agent-presets` | `$DSH/dsh-agent-presets/lib/index.js:1145` — `const SETTINGS_NAMESPACE = "agent-presets";` |
  | `permission` | `$DSH/dsh-permission-presets/lib/index.js:24` — `const PERMISSION_SETTINGS_NAMESPACE = "permission";` |
  | `ui-onboarding` | `$DSH/dsh-client-ui-settings-general/lib/index.js:5` — `const ONBOARDING_SETTINGS_NAMESPACE = "ui-onboarding";` |
  | `ui-conversation` | `$DSH/dsh-client-ui-conversation/lib/index.js:5` — `const CONVERSATION_SETTINGS_NAMESPACE = "ui-conversation";` |
  | `agent-default-model` | `$DSH/dsh-agent-default-model/lib/index.js:11` — `const AGENT_DEFAULT_MODEL_SETTINGS_NAMESPACE = "agent-default-model";` |
  | `dsh-better-sidebar` | `dsh-better-sidebar/lib/index.js:26` — `const SIDEBAR_PREFS_NS = "dsh-better-sidebar";` |
  | `chat-import` | `dsh-chat-import/lib/import-prefs.mjs:92` — `export const IMPORT_SETTINGS_NAMESPACE = 'chat-import'` |
  | `dsh-remote-ssh` | `@zhangfengshun/dsh-remote-ssh/lib/index.js:25` — `const NS = "dsh-remote-ssh";` |

### 3.2 **IMPORTANT**: a NEWER DSH changes this. Mark as version-sensitive.

`dsh-chat-import@0.19.3` — a plugin that supports **both** models —
`/Users/yukisala/.dsh/profiles/web/node_modules/dsh-chat-import/lib/import-prefs.mjs:17-33`:

```
// ── DSH 0.1.5 → 0.1.7 设置模型迁移（双版兼容）──────────────────────────────────
// 0.1.7 删除了 settings.register()：命名空间不再是插件自持的名字，而是 profile 里该
// 插件条目的 id，schema 是该条目的 Config（本模块导出的 Config，由 loader 校验）。0.1.5
// 及更早则相反（插件按名字 register）。本模块同时兼容两版，按宿主能力探测：
//   forms  —— settings 服务有 describe() 且名单里有本插件的**裸条目 id** → 按条目 id
//             走 describe / update（0.1.7）；并 settings.configure({auto:false}) 声明
//             本插件自带设置页（不生成宿主自动页）。
//   legacy —— 否则若 settings.register 是函数 → 自持命名空间 'chat-import'（0.1.5）。
//   none   —— 两者皆无 → 读回默认、写不持久化（available:false），导入照常。
```

Translation: *"DSH 0.1.7 removed `settings.register()`: the namespace is no longer
a name the plugin owns itself but the **id of the plugin's entry in the profile**,
and the schema is **that entry's `Config`** (the `Config` this module exports,
validated by the loader). 0.1.5 and earlier is the opposite (plugins register by
name)."* — It also mentions a `settings.configure({auto:false})` API, and
`.volatile()` on schemastery fields.

**In THIS install (0.1.5-rc.2) none of that exists.** Verified:

* `$DSH/schemastery` has no `volatile` (`grep -rn volatile` → no matches; live:
  `typeof z.boolean().volatile = undefined`).
* `dsh-settings` exports only `SettingsConflictError, SettingsProvider, redactSecrets`
  (`$DSH/dsh-settings/lib/index.js` last line; no `settingsNamespace`, no
  `configure`).
* `settings.configure`, `auto:`, and a settings namespace derived from entry id
  appear nowhere in the shipped packages.

> **If the deployment is ever upgraded past 0.1.7, re-verify this section.** Treat
> §3.1 as true for 0.1.5-rc.2 only.

### 3.3 The settings `section` / `register` API — exact quotes

Service key: `ctx.settings` (class `SettingsProvider extends Service`, registered
under the literal name `"settings"`) — `$DSH/dsh-settings/lib/index.js:223-239`:

```js
var SettingsProvider = class extends Service {
	registrations = new Map();
	...
	constructor(ctx) {
		super(ctx, "settings");
	}
```

**Namespace grammar** — `$DSH/dsh-settings/lib/index.js:82-86`:

```js
const NAMESPACE_PATTERN = /^[a-z][a-z0-9-]*$/;
function parseSettingsNamespace(value) {
	if (!NAMESPACE_PATTERN.test(value)) throw new TypeError(`settings namespace "${value}" must match ${String(NAMESPACE_PATTERN)}`);
	return value;
}
```

**`register(ns, schema, options)`** — `$DSH/dsh-settings/lib/index.js:281-315`:

```js
	register(ns, schema, options) {
		const parsedNs = parseSettingsNamespace(ns);
		if (this.registrations.has(parsedNs)) throw new Error(`settings namespace "${parsedNs}" is already registered`);
		const registration = {
			ns: parsedNs,
			schema,
			base: options?.base,
			applies: options?.applies ?? "live",
			...options?.validate === void 0 ? {} : { validate: options.validate },
			resolved: deepFreeze(this.resolve(schema, options?.base, this.section(parsedNs), options?.validate)),
			revision: 0,
			watchers: new Set()
		};
		this.ctx.effect(() => {
			this.registrations.set(parsedNs, registration);
			return () => this.registrations.delete(parsedNs);
		}, `settings.register(${JSON.stringify(String(parsedNs))})`);
		return {
			get: () => registration.resolved,
			watch: (callback) => { ... },
			update: (patch) => this.update(parsedNs, patch),
			replace: (section) => this.replace(parsedNs, section)
		};
	}
```

Note: **`register()` is an effect on the calling fiber** (`this.ctx.effect(...)`) —
the namespace disappears when the plugin unloads. Live-proven below.

**`installSection(owner, ns, schema, entry, hooks)`** — the *recommended* path for
a plugin whose composition entry should act as the base layer with graceful
fallback — `$DSH/dsh-settings/lib/index.js:327-343`:

```js
	installSection(owner, ns, schema, entry, hooks) {
		const scope = this.register(ns, schema, {
			base: entry,
			...hooks.validate === void 0 ? {} : { validate: hooks.validate }
		});
		hooks.setSource(() => scope.get());
		this.ctx.effect(() => () => {
			if (isUnloading(owner)) return;
			hooks.setSource(() => entry);
			hooks.onChange();
		});
		hooks.onChange();
		scope.watch(() => {
			if (isUnloading(owner)) return;
			hooks.onChange();
		});
	}
```

**Resolution order** — `$DSH/dsh-settings/lib/index.js:502-513`:

```js
	/** Read one namespace's raw user section, rejecting non-object sections. */
	section(ns) {
		const section = this.document[ns];
		if (section === void 0) return void 0;
		if (!isPlainObject(section)) throw new TypeError(`settings section "${ns}" must be an object of keys`);
		return section;
	}
	/** Resolve one namespace value: schema defaults, then `base`, then the user layer. */
	resolve(schema, base, section, validate) {
		const value = schema(mergeLayers(base, section));
		validate?.(value);
		return value;
	}
```

So the document is flat: **`document[namespace] = userSection`**.

**Write path** — `$DSH/dsh-settings/lib/index.js:443-472` (the write errors below are
live-proven).

### 3.4 The `dsh-settings-file` document — key layout and hot reload

`$DSH/dsh-settings-file/lib/index.js:26-46`:

```js
const FORMATS = {
	".yaml": "yaml",
	".yml": "yaml",
	".json": "json"
};
...
function resolveSpec(config) {
	const filename = resolve(config.path ?? join(resolveDshHome(config.dshHome), "settings.yaml"));
	const format = FORMATS[extname(filename)];
	if (format === void 0) throw new Error(`settings-file: extension "${extname(filename)}" is not supported (use .yaml, .yml, or .json)`);
	return {
		filename,
		format,
		watch: config.watch ?? true,
		debounceMs: config.debounceMs ?? 100
	};
}
```

Mount row in the real composition — `$DSH/dsh-base/cordis.patch.yml:87-91`:

```yaml
    # User-settings document (`$DSH_HOME/settings.yaml`, hot-reloaded): a
    # `llm-deepseek:` or `llm-pi-ai:` section there overrides the adapter entries
    # below without a restart, and is what the web Models page writes.
    - id: settings
      name: '@deepseek-ai/dsh-settings-file'
```

(no `config:` → defaults to `$DSH_HOME/settings.yaml`, `watch: true`, `debounceMs: 100`)

README `$DSH/dsh-settings-file/README.md:53`:

```
The document is a YAML or JSON mapping of namespace to user section. Users can edit it directly: any change takes effect automatically, and deleting the file resets every namespace to defaults and `base`.
```

Real file, `/Users/yukisala/.dsh/settings.yaml` (abridged):

```yaml
ui-onboarding:
  welcomeNoticeVersion: 2026-08-13.1
agent-default-model:
  provider: deepseek-official
  model: deepseek-flash
  reasoningEffort: max
llm-deepseek: {}
permission:
  defaultPreset: danger-full-access
ui-theme:
  preference: system
dsh-better-sidebar:
  tabsEnabled:
    git: true
  agentOpenTools: false
chat-import:
  importSystemPrompt: true
...
dsh-remote-ssh:
  profiles:
    - id: pmtv5ihqjc1r9
      ...
```

**LIVE PROOF of the exact on-disk shape** (`/tmp/dsh-probe/t4.mjs`) — a namespace
registered with `base: {limit:7}`, then `scope.update({limit:42})`:

```yaml
demo-plugin:
  limit: 42
```

i.e. **only user-overridden keys are written; `base` is not persisted.**

### 3.5 How a plugin reads settings at runtime — live-proven lifecycle

`/tmp/dsh-probe/t5.mjs` output:

```
ctx.get("settings") before mount = undefined
ctx.get("settings") after mount = object
[apply] config = {"enabled":true,"limit":7} (schema defaults applied by cordis)
resolved = {"enabled":true,"limit":7}
[watch] next={"enabled":false,"limit":99} prev={"enabled":true,"limit":7}
after external edit resolved = {"enabled":false,"limit":99}
[effect] demo cleanup ran
after fiber dispose, describe = []
get(NAME) after dispose = undefined
write after dispose -> settings namespace "demo-plugin" is not registered
```

`/tmp/dsh-probe/t4.mjs` output (errors):

```
dup register -> settings namespace "demo-plugin" is already registered
bad ns -> TypeError settings namespace "BAD_NS" must match /^[a-z][a-z0-9-]*$/
non-json write -> settings update for "demo-plugin" must contain only JSON-compatible data (found a Date at $.when)
describe = [{"ns":"demo-plugin","value":{"enabled":true,"limit":42},"user":{"limit":42},"base":{"limit":7},"revision":1,"applies":"live"}]
```

`/tmp/dsh-probe/t9.mjs` output (hard vs optional dependency):

```
hard-inject fiber state = 0 (2=ACTIVE, 0=PENDING) uid= 1
OPT applied, ctx.get(settings) = undefined
opt state = 2
HARD applied
OPT settings appeared
OPT registered, value = {"x":1}
hard-inject fiber state after provider mount = 2
```

→ **A plugin with a hard `inject: ['settings']` never activates in a composition
without a settings provider** (boot diagnostic:
`pending (waiting for service: settings)`). The shipped pattern is
`ctx.get('settings')` for optional reads and `ctx.inject(['settings'], cb)` for
optional registration.

### 3.6 The canonical shipped pattern: `installSection`

`$DSH/dsh-agent-default-model/lib/index.js:24-56`:

```js
var AgentDefaultModelConfig = class extends Service {
	static Config = z.object({
		provider: z.string().required(),
		model: z.string().required()
	});
	source;
	constructor(ctx, config) {
		super(ctx, "agentDefaultModel");
		const entry = {
			provider: config.provider,
			model: config.model
		};
		this.source = () => entry;
		ctx.inject(["settings"], (settingsCtx) => {
			settingsCtx.settings.installSection(ctx, AGENT_DEFAULT_MODEL_SETTINGS_NAMESPACE, AGENT_DEFAULT_MODEL_SETTINGS_SCHEMA, entry, {
				setSource: (current) => {
					this.source = current;
				},
				onChange: () => {}
			});
		});
	}
	currentSelection() {
		return selection(this.source());
	}
	async saveSelection(next) {
		await this.ctx.get("settings")?.replace(AGENT_DEFAULT_MODEL_SETTINGS_NAMESPACE, { ... });
	}
};
```

The *"don't break the plugin when settings is absent"* rule is written out in the
class JSDoc: *"The composition entry remains usable without a settings provider;
when one is mounted, its user layer is read live."*

### 3.7 The third-party pattern: `register()` inside `ctx.inject`

`dsh-better-sidebar@0.19.1`, `/Users/yukisala/.dsh/profiles/web/node_modules/dsh-better-sidebar/lib/index.js:4888-4910`:

```js
	ctx.inject(["settings"], (sctx) => {
		const ns = SIDEBAR_PREFS_NS;
		const scope = sctx.settings.register(ns, PrefsSchema);
		const viewOf = () => {
			const descriptor = sctx.settings.describe({ redactSecrets: true }).find((candidate) => candidate.ns === ns);
			return descriptor === void 0 ? { value: void 0, revision: void 0 } : { value: descriptor.value, revision: descriptor.revision };
		};
		...
		settingsFace = {
			get: viewOf,
			externalDisable,
			update: async (patch, expectedRevision) => {
				await sctx.settings.update(ns, patch, expectedRevision);
				return viewOf();
			}
		};
		syncToolsGate(scope);
```

`dsh-context@0.54.4`, `/Users/yukisala/.dsh/profiles/web/node_modules/dsh-context/lib/index.js:3159-3188`:

```js
const SETTINGS_NAMESPACE = "dsh-context";
const SettingsSchema = z$1.object({ ... });
/** Serve the namespace while a settings provider with the register face is composed; inert otherwise. */
function installSettings(ctx) {
	ctx.inject(["settings"], (sctx) => {
		const service = sctx.settings;
		if (typeof service.register !== "function") return;
		service.register(SETTINGS_NAMESPACE, SettingsSchema);
	});
}
```

`@zhangfengshun/dsh-remote-ssh@2.4.14`, `/Users/yukisala/.dsh/profiles/web/node_modules/@zhangfengshun/dsh-remote-ssh/lib/index.js:25, 1765-1780`:

```js
const NS = "dsh-remote-ssh";
...
  ctx.inject(["settings"], (sctx) => {
    // settings 命名空间直接传插件 id（匹配 /^[a-z][a-z0-9-]*$/）。不再依赖
    // @deepseek-ai/dsh-settings 的 legacy `settingsNamespace` 构造器（该导出仅为
    // alpha.2 之前的插件保留，未来可能移除）；恒等语义下两种写法存储键完全一致。
    const scope = sctx.settings.register(NS, PrefsSchema);
```

Note its `Config` is an **empty schema** — `/Users/yukisala/.dsh/profiles/web/node_modules/@zhangfengshun/dsh-remote-ssh/lib/index.js:19-23`:

```js
/** Plugin identity for cordis.yml rows. */
const name = "@zhangfengshun/dsh-remote-ssh";
/** Services required before mounting. */
const inject = ["webServer", "subprocess", "tools", "workspaceRegistry"];
/** Composition config schema（本插件暂无配置项）。 */
const Config = z.object({});
```

→ `name` = `"@zhangfengshun/dsh-remote-ssh"` while the settings namespace = `"dsh-remote-ssh"`.
**Hard proof that the settings key is NOT derived from the plugin's `name`.** Same
for `dsh-chat-import`: `name = 'import-claude'` (`lib/index.mjs:50`) but namespace
`'chat-import'`.

---

## 4. Row `config` vs user settings — which to use, and what is hot-reloaded

| | Row `config:` (composition) | User settings (`settings.yaml`) |
|---|---|---|
| Where it lives | `cordis.yml` / bundle patch / `$DSH_HOME/cordis.patch.yml` / `--patch` | `$DSH_HOME/settings.yaml` (or the provider's `path`) |
| Schema | the plugin's exported `Config` (Standard Schema) | the schema passed to `register()` / `installSection()` — **a separate schema** |
| Validated | eagerly, before `apply`, on every load/reload | on register, and on every reload of the document; an invalid stored section keeps the last good value and warns |
| Editable by | the deployment author (a file edit) | the end user (the file, or a configuration UI) |
| Visible to the model / UI | no UI surface; not listed by `describe()` | listed by `ctx.settings.describe()`; the Settings → Plugins tab renders registered namespaces |
| Delivered to the plugin as | the 2nd argument of `apply(ctx, config)` | `scope.get()` / `scope.watch(cb)` — the plugin must read it itself |
| Hot-reloaded | **only if a patch layer changes** (`patchReload: live` re-composes and calls `fiber.update(...)`, which re-validates and **restarts the plugin fiber**) | **yes** — watch the document; `scope.watch` fires after each committed change, no restart |
| Write path | `fiber.update(config)` (Loader write-back) | `scope.update(patch)` / `settings.update(ns, patch)` / `replace` / `mutate` |

**Which one for user-editable values?** The settings namespace — that is exactly
what `dsh-settings`'s README says (`$DSH/dsh-settings/README.md:12`):

> "Use this package when users must change a plugin's configuration at runtime
> without restarting or rereading `cordis.yml`. … Writes affect only user
> overrides, are serialized per namespace, and may reject stale revisions instead
> of overwriting newer changes. **Durable runtime edits require configured settings
> storage; without it, the plugin continues with its composed configuration.**"

and `$DSH/dsh-settings/README.md:32`:

> "It is unnecessary when configuration is fixed at load time: without a provider
> mounted, nothing changes and configuration stays exactly as composed."

The idiomatic combination (proven in `dsh-agent-default-model`, `dsh-llm-deepseek`,
`dsh-bash-local`, `dsh-permission-presets`, `dsh-web-search-deepseek`) is
**`installSection(owner, ns, schema, entry, hooks)`**: the row `config` is the
`base` layer *and* the fallback, and the user layer resolves above it.

**What is hot-reloaded, precisely:**

1. `settings.yaml` edits → the chokidar watcher (`watch: true`, `debounceMs: 100`)
   → `SettingsProvider.publish(doc)` → re-resolve each registered namespace →
   `settings/updated` + `scope.watch` callbacks. **No plugin restart.**
   Live-proven in §3.5.
2. `cordis.patch.yml` edits → only for profiles with `patchReload: live`
   (`$DSH/dsh-app-boot/README.md:55-57`). This re-composes entries and calls
   `fiber.update(config, true)` — the fiber **unloads and reloads**, and `apply`
   runs again with the new validated config.

---

## 5. Durable storage — every API that can be proven

### 5.1 The three-package stack and how it is actually mounted

`$DSH/dsh-base/cordis.patch.yml:138-152` (the real, running composition):

```yaml
    # Durable KV storage: the storage hub, the json backend, and the
    # schema-validated domain form over them. Session-layer persistence (the
    # projection cache below; workspace in web layers)
    # routes through this stack, so it belongs to the shared base.
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

→ `root` resolves to `/Users/yukisala/.dsh/storages/`, confirmed on disk.

### 5.2 `ctx.storage` — the hub (`dsh-storage`)

Class surface, `$DSH/dsh-storage/lib/index.js:104-138` (live-proven prototype keys:
`constructor,mount,form,domain`; and `backend` is an own field):

```js
var Storage = class extends Service {
	/** Named backend table; multiple backends stay mounted side by side. */
	backend = new BackendRegistry();
	forms = new Map();
	constructor(ctx) {
		super(ctx, "storage");
	}
	mount(form, facility) {
		if (this.forms.has(form)) throw new StorageError("duplicate-mount", `storage form '${String(form)}' is already mounted`);
		this.forms.set(form, facility);
		return () => {
			if (this.forms.get(form) === facility) this.forms.delete(form);
		};
	}
	form(form) {
		if (!this.forms.has(form)) throw new StorageError("form-not-mounted", `storage form '${String(form)}' is not mounted`);
		return this.forms.get(form);
	}
	/** Domain data form; present once the domain layer plugin is loaded. */
	get domain() {
		return this.form("domain");
	}
};
```

`BackendRegistry`, `$DSH/dsh-storage/lib/index.js:35-69`:

```js
var BackendRegistry = class {
	backends = new Map();
	register(name, backend) {
		if (this.backends.has(name)) throw new StorageError("duplicate-backend", `storage backend '${name}' is already registered`);
		this.backends.set(name, backend);
		return () => {
			if (this.backends.get(name) === backend) this.backends.delete(name);
		};
	}
	get(name) {
		const backend = this.backends.get(name);
		if (!backend) throw new StorageError("backend-not-found", `storage backend '${name}' is not registered (registered: ${[...this.backends.keys()].join(", ") || "none"})`);
		return backend;
	}
	names() {
		return [...this.backends.keys()];
	}
};
```

**There is no `ctx.storage.get` / `ctx.storage.set`.** Persistence is not a
key-value API on the hub; the hub is a registry only ("The hub never performs IO",
`$DSH/dsh-storage/README.md:72`).

`StorageError` codes — `$DSH/dsh-storage/lib/types/error.d.ts:6`:

```ts
export type StorageErrorCode = 'backend-not-found' | 'form-not-mounted' | 'duplicate-backend' | 'duplicate-mount' | 'version-mismatch' | 'malformed-medium' | 'closed';
```

Lifecycle-only service key for race-free activation —
`$DSH/dsh-storage/lib/index.js:97-99`:

```js
function storageBackendServiceKey(name) {
	return `storage.backend.${name}`;
}
```

**LIVE PROOF** (`/tmp/dsh-probe/t8.mjs`):

```
storage svc keys = constructor,mount,form,domain
backend registry keys = constructor,register,get,names
ctx.get("storageDomain") before mount = undefined
storage.domain before mount -> StorageError form-not-mounted storage form 'domain' is not mounted
form("domain") -> StorageError form-not-mounted storage form 'domain' is not mounted
backend.get(nope) -> StorageError backend-not-found storage backend 'nope' is not registered (registered: none)
register returned function
after disposer names = []
after json backend, names = ["json"]
ctx.get("storage.backend.json") = object
second json backend row -> duplicate-backend storage backend 'json' is already registered
ctx.get("storageDomain") after mount = object
```

### 5.3 `dsh-storage-json` — on-disk layout under `$DSH_HOME/storages`

Plugin surface — `$DSH/dsh-storage-json/lib/index.js:547-604`:

```js
const name = "storage-json";
const inject = ["storage"];
const Config = z.object({ root: z.string().required() });
...
function apply(ctx, config) {
	const backend = new JsonStorageBackend(config.root);
	ctx.effect(() => {
		const unregister = ctx.storage.backend.register("json", backend);
		return async () => {
			unregister();
			await backend.close();
		};
	});
	ctx.provide(storageBackendServiceKey("json"), backend);
}
```

`$DSH/dsh-storage-json/lib/types/index.d.ts:22-29`:

```ts
/**
 * Plugin configuration.
 * `root` has NO default on purpose: a `process.cwd()` fallback would scatter
 * unit files wherever the process happens to start; assemblies state the
 * location explicitly.
 */
export interface Config {
    /** Directory holding one `<unit>.json` file (or `<unit>/` tree) per unit. */
    root: string;
}
```

**Two layouts** (`$DSH/dsh-storage-json/README.md:78-88`):

````
A `single` document carries the unit identity, global singleton, and all tables:

```json
{
  "unit": { "name": "workspace", "version": 1 },
  "global": null,
  "tables": { "workspaces": { "<key>": { "path": "/work/demo" } } }
}
```

A `per-record` table document at `<root>/<unit>/<table>/<key>.json` has the form `{ "version": 1, "record": <value> }`; the optional global value uses `<root>/<unit>/global.json`.
````

**REAL ON-DISK EVIDENCE** on this machine:

`/Users/yukisala/.dsh/storages/workspace.json` (single layout, `version: 2`):

```json
{
  "unit": {
    "name": "workspace",
    "version": 2
  },
  "global": {
    "initialized": true,
    "workspaceIds": [ "a82b7ee8-7ae9-410b-a907-e0454cbba89b", ... ],
    "archivedSessionIds": [ ... ]
  },
  ...
```

`/Users/yukisala/.dsh/storages/session_projcache/sessions/4272c42d-…json` (per-record layout, `version: 7`):

```json
{
  "version": 7,
  "record": {
    "identity": { "formatVersion": 3, "createdAt": 1789182998314, "cwd": "/Users/yukisala/.dsh/remote-workspaces/wmtv5j9crcio5", ... },
    "rows": { "title": { "ver": 1, "seq": 193, "val": "You are doing a READ-ONLY" }, ... }
  }
}
```

`find /Users/yukisala/.dsh/storages -type f` shows both
`session_projcache.json` (the legacy whole-unit file, left in place) and the
`session_projcache/sessions/*.json` tree — matching the documented bootstrap
("An empty `per-record` tree can initialize its declared tables from a valid
`<root>/<unit>.json` whole-unit document … The backend leaves that source file
unchanged").

**Record-key safety** (`$DSH/dsh-storage-json/README.md:56`):

```
Record keys must match `[a-zA-Z0-9_-]+`; an unsafe key rejects before any file operation.
```

**No cross-process locking** — `$DSH/dsh-storage-json/README.md:142`:

```
- **No cross-process write locking** — two processes writing the same unit can interleave replacements; writes to the same file use last-completion wins.
```

### 5.4 `dsh-storage-domain` — schema-validated domain form (`ctx.storageDomain`)

**Plugin surface** — `$DSH/dsh-storage-domain/lib/index.js:309-315, 439-455`:

```js
/** Cordis plugin name. */
const name = "storage-domain";
/** The storage hub must be present before the form can mount. */
const inject = ["storage"];
const Config = z.object({
	backend: z.string().required(),
	routes: z.dict(z.string()).default({})
});
...
function apply(ctx, config) {
	const backendServices = [...new Set([config.backend, ...Object.values(config.routes ?? {})])].map(storageBackendServiceKey);
	const fiber = ctx.inject(backendServices, (domainCtx) => {
		const facility = new DomainFacility(domainCtx, config);
		domainCtx.effect(() => {
			const unmount = domainCtx.storage.mount("domain", facility);
			return async () => {
				await facility.closeAll();
				unmount();
			};
		});
		domainCtx.provide("storageDomain", facility);
	});
	return Promise.resolve(fiber).then(() => {});
}
```

`inject` in this package **waits for `storage.backend.<name>` service keys**, so
row order between backend and domain form is not a failure mode
(`$DSH/dsh-storage/README.md:75-76`).

**Declaring a domain** — `defineDomain` / `domainTable`, with **zod** record
schemas — `$DSH/dsh-storage-domain/lib/index.js:53-82`:

```js
function domainTable(schema) {
	return { valueSchema: schema };
}
...
function defineDomain(spec) {
	if (!UNIT_NAME_RE.test(spec.name)) throw new Error(`domain name '${spec.name}' must match ${UNIT_NAME_RE}`);
	if (!Number.isInteger(spec.version) || spec.version < 0) throw new Error(`domain '${spec.name}' version must be a non-negative integer, got ${spec.version}`);
	for (const compat of spec.compatibleVersions ?? []) if (!Number.isInteger(compat) || compat < 0 || compat >= spec.version) throw new Error(`domain '${spec.name}' compatibleVersions entries must be non-negative integers below version ${spec.version}, got ${compat}`);
	if (spec.layout !== void 0) {
		const layout = spec.layout;
		if (layout !== "single" && layout !== "per-record") throw new Error(`domain '${spec.name}' layout must be 'single' or 'per-record', got ${layout}`);
	}
	if (spec.invalidRecords !== void 0) {
		const policy = spec.invalidRecords;
		if (policy !== "backup-and-skip") throw new Error(`domain '${spec.name}' invalidRecords must be 'backup-and-skip' when present, got ${policy}`);
	}
	for (const table of Object.keys(spec.tables)) if (!UNIT_NAME_RE.test(table)) throw new Error(`domain '${spec.name}' table name '${table}' must match ${UNIT_NAME_RE}`);
	if (spec.global !== void 0 && spec.global.schema.safeParse(null).success) throw new Error(`domain '${spec.name}' global schema must not accept null: null is the medium's "never written" sentinel, so a stored null could not round-trip`);
	return spec;
}
```

`UNIT_NAME_RE` — `$DSH/dsh-storage/lib/index.js:80`:

```js
/** Allowed format for unit and table names: safe as a file name and as a SQL identifier segment without escaping. */
const UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/;
```

**LIVE PROOF of every `defineDomain` rejection** (`/tmp/dsh-probe/t8.mjs`):

```
defineDomain -> domain name 'Bad-Name' must match /^[a-z][a-z0-9_]*$/
defineDomain -> domain 'ok' version must be a non-negative integer, got 1.5
defineDomain -> domain 'ok' table name 'Bad Table' must match /^[a-z][a-z0-9_]*$/
defineDomain -> domain 'ok' global schema must not accept null: null is the medium's "never written" sentinel, so a stored null could not round-trip
```

**SPEC SPLIT (important)**: `$DSH/dsh-storage-domain/lib/types/spec.d.ts:1-10`:

```
 * it once with {@link defineDomain} and both the type surface and the runtime
 * (validation, descriptor projection) derive from it. Record schemas are zod
 * (`z.infer` keeps types un-duplicated and the same schemas later project to
 * RPC wire schemas); plugin `Config` stays schemastery.
```

and `src/index.ts` header (`$DSH/dsh-storage-domain/lib/types/index.d.ts:5-6`):
"Plugin `Config` is schemastery; record schemas inside domain specs are zod."

So inside one plugin you may legitimately use **three** schema libraries:
schemastery (or zod) for `Config`, zod for storage-domain records, schemastery for
settings namespaces.

**Opening a domain** — `$DSH/dsh-storage-domain/lib/index.js:355-400` (abridged):

```js
	async open(spec) {
		if (this.reserved.has(spec.name)) throw new DomainError("already-open", `domain '${spec.name}' is already open`);
		this.reserved.add(spec.name);
		try {
			const backendName = this.config.routes?.[spec.name] ?? this.config.backend;
			const backend = this.ctx.storage.backend.get(backendName);
			if (!backend.kv) throw new DomainError("facet-unsupported", `backend '${backendName}' routed for domain '${spec.name}' has no kv facet`);
			const unit = await backend.kv.open(descriptorOf(spec));
			try {
				const snapshot = await unit.loadAll();
				...
```

**Facility API** — `$DSH/dsh-storage-domain/lib/types/index.d.ts:52-99`:
`open(spec): Promise<Domain<S>>`, `get(name): DomainImpl | undefined`,
`closeAll(): Promise<void>`.

**Domain handle API** — `$DSH/dsh-storage-domain/lib/types/domain.d.ts:36-105`:

| Member | Signature |
|---|---|
| `domain.name` | `string` |
| `domain.global` | `{ get(): G; set(value: G): Promise<void> }` (throws if the spec declares no global) |
| `domain.table(name)` | `KvTable<K,V>` |
| `domain.close()` | `Promise<void>` — "reject new writes immediately, drain already-queued writes (their events still emit), release the backend unit, then free the domain name"; idempotent |
| `table.get(key)` | `V \| undefined` — **synchronous, from memory** |
| `table.entries()` / `table.keys()` / `table.size` | snapshot iterators / count |
| `table.put(key, value)` | `Promise<void>` — durable before it resolves |
| `table.delete(key)` | `Promise<boolean>` — `false` when already absent (no write, no event) |
| `table.update(key, fn)` | `Promise<V>` — atomic read-modify-write on the write chain, `missing-key` if absent |

"Records are plain immutable data: returned values are the stored objects
themselves (no defensive copies) and must not be mutated in place"
(`domain.d.ts:32-35`).

**Errors** — `$DSH/dsh-storage-domain/lib/types/error.d.ts:6`:

```ts
export type DomainErrorCode = 'already-open' | 'facet-unsupported' | 'invalid-record' | 'missing-key' | 'closed';
```

Backend failures (`backend-not-found`, `version-mismatch`) pass through as
`StorageError`, **not** rewrapped (`error.d.ts:21-24`).

**LIVE PROOF:**

```
double open -> already-open domain 'probe' is already open
update missing -> missing-key | domain 'probe' table 'rows' has no record 'missing' to update
use after close -> closed domain 'probe' is closed
reopen after close OK
```

**The change event** — `$DSH/dsh-storage-domain/lib/types/events.d.ts:38-49`:

```ts
declare module '@deepseek-ai/cordis' {
    interface Events {
        /**
         * A domain record or the global singleton changed, emitted once per write
         * strictly after the backend acknowledged durability. Events of one
         * domain arrive in its write-chain order.
         * @param change - domain, table (`''` for global), key (`''` for global),
         * operation discriminant, and on `put` the new snapshot.
         * @mode emit
         */
        'domain/changed'(change: DomainChanged): void;
    }
}
```

Emitted via `this.ctx.emit("domain/changed", change)` (`$DSH/dsh-storage-domain/lib/index.js:214-216`).
**LIVE PROOF** of the payload:

```
[domain/changed] {"domain":"demo_counter","table":"counters","key":"hits","operation":"put","value":{"value":1}}
```

### 5.5 The backend contract (for completeness / for writing a backend)

`$DSH/dsh-storage/lib/types/backend.d.ts:15-130` — `StorageBackend { kv?: KvFacet; close(): Promise<void> }`;
`KvFacet.open(descriptor): Promise<KvUnit>`;
`KvUnit { loadAll(); putRecord(table,key,value); deleteRecord(table,key); backupRecord?(table,key); setGlobal(value); close() }`.

> "The unit does NOT serialize concurrent writes — write ordering is the caller's
> responsibility … each single call is atomic on the medium and durable once
> resolved".
> "`kv` is the only facet" — the `log` facet for session event logs is deferred
> (`$DSH/dsh-storage/README.md:131`).

**A plugin is not supposed to talk to a backend directly** —
`$DSH/dsh-storage-domain/README.md:12`: *"Product packages use domain handles
instead of accessing storage backends directly."*

### 5.6 Is anything sqlite-backed exposed to plugins?

**NO storage-sqlite backend is installed.** `ls -d $DSH/*sqlite*` yields only:

```
$DSH/dsh-session-query-sqlite
```

which is **not** a storage backend — it is a separate `ctx.sessionQuery` FTS5
service for session history (`$DSH/dsh-session-query-sqlite/README.md`: "The SQLite
FTS5 full-text search backend for session history"). The JSON backend README
references a sibling `../storage-sqlite/README.md` and a `sqlite` backend name
(`$DSH/dsh-storage-json/README.md:32, 112`), but that package is **not part of
this installation**:

```
$ ls -d $DSH/dsh-storage-*
$DSH/dsh-storage-domain
$DSH/dsh-storage-json
```

Consequently, in this deployment the only backend name a domain may route to is
`"json"`. `routes` may still name a `sqlite` backend, which would fail at
`open()` with `backend-not-found`.

Also NOT a plugin-facing durable store: session logs
(`$DSH/dsh-session-persistence-jsonl`, `~/.dsh/sessions/`), credentials
(`~/.dsh/.credentials.yaml`). Those belong to their own seams.

### 5.7 The canonical durable-write consumer to copy

`$DSH/dsh-session-projection-cache/lib/index.js:89-97` (the domain declaration):

```js
const projectionCacheDomainSpec = defineDomain({
	name: "session_projcache",
	version: 7,
	compatibleVersions: [
		3,
		4,
		5,
		6
	],
	invalidRecords: "backup-and-skip",
	layout: "per-record",
	tables: { sessions: domainTable(checkpointRecord) }
});
```

`$DSH/dsh-session-projection-cache/lib/index.js:151-152` (the lifecycle):

```js
		const domain = await this.ctx.storageDomain.open(projectionCacheDomainSpec);
		this.ctx.effect(() => () => domain.close(), "sessionProjectionCache.domainClose");
```

The service declares `static inject = ["storageDomain", "sessionProjections", "sessions"]`.

---

## 6. Complete, copy-pasteable minimal example

**Status:** every line below was executed against the vendored packages. Output
included. Certainty markers at the end.

Paths are absolute because a plugin installed into
`~/.dsh/profiles/<p>/node_modules` cannot resolve `@deepseek-ai/*` by bare
specifier (see the note in `dsh-chat-import/lib/import-prefs.mjs:47-58` about
schemastery resolution anchors). In a **bundle** package you would instead declare
`schemastery` (or `zod`) as a dependency and import normally — that is what
`dsh-ultramath` does: `import z from "schemastery";`
(`/Users/yukisala/.dsh/profiles/web/node_modules/dsh-ultramath/lib/index.js:15`,
`package.json` → `"dependencies": { "schemastery": "^3.18.0" }`).

### `demo-counter.js`

```js
import z from '@deepseek-ai/schemastery'            // or: import z from 'schemastery'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z as zod } from 'zod'

export const name = 'demo-counter'
export const inject = ['storageDomain', 'settings']  // hard deps; see caveat below

/** (a) Composition config. Defaults are applied by Cordis BEFORE apply() runs. */
export const Config = z.object({
  label: z.string().default('counter'),
  start: z.number().default(0),
})

/** (d) Independent user-settings namespace: /^[a-z][a-z0-9-]*$/, NOT derived from `name`. */
export const SETTINGS_NS = 'demo-counter'
export const SettingsSchema = z.object({ step: z.number().default(1) })

/** (c) Durable domain. name + table names must match /^[a-z][a-z0-9_]*$/; records are zod. */
const counterSpec = defineDomain({
  name: 'demo_counter',
  version: 1,
  tables: { counters: domainTable(zod.object({ value: zod.number() })) },
})

export async function apply(ctx, config) {
  // (b) merged config — `start` arrives as 0 even though the row omitted it.
  ctx.logger.info('demo-counter config = %o', config)

  // (d) user layer resolves ABOVE the composition entry; register() is a fiber effect.
  const scope = ctx.settings.register(SETTINGS_NS, SettingsSchema, { base: { step: 1 } })
  scope.watch((next) => ctx.logger.info('demo-counter settings -> %o', next))
  const step = () => scope.get().step

  // (c) durable counter
  const domain = await ctx.storageDomain.open(counterSpec)
  ctx.effect(() => () => domain.close(), 'demo-counter: close domain')   // (Q7)

  const table = domain.table('counters')
  const KEY = config.label
  if (table.get(KEY) === undefined) await table.put(KEY, { value: config.start })

  await table.update(KEY, (row) => ({ value: row.value + step() }))
  await table.update(KEY, (row) => ({ value: row.value + step() }))
  ctx.logger.info('demo-counter durable value = %d', table.get(KEY).value)
}
```

The composition rows it needs (already present in the shipped base):

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
- id: settings
  name: '@deepseek-ai/dsh-settings-file'
- id: demo-counter
  name: '<specifier or file URL>'
  config:
    label: hits          # `start` omitted -> default 0 applied by the loader
```

### Harness used to run it

```js
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'      // no default export
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'  // no default export
import SettingsFile from '@deepseek-ai/dsh-settings-file'

const root = new Context()
await root.plugin(Storage)
await root.plugin(StorageJson, { root: '/tmp/demo/storages' })
await root.plugin(StorageDomain, { backend: 'json' })
await root.plugin(SettingsFile, { path: '/tmp/demo/settings.yaml' })

const plug = await import('./demo-counter.js')
const fiber = root.plugin(plug, { label: 'hits' })
await fiber
await fiber.dispose()
```

### VERIFIED OUTPUT

```
[apply] merged config = {"label":"hits","start":0}
[domain/changed] {"domain":"demo_counter","table":"counters","key":"hits","operation":"put","value":{"value":1}}
[domain/changed] {"domain":"demo_counter","table":"counters","key":"hits","operation":"put","value":{"value":2}}
[apply] durable value = 2 | step = 1
SETTINGS WRITE ->
[settings] -> {"step":10}
settings.yaml =
demo-counter:
  step: 10

[apply] merged config = {"label":"counter","start":0}     <-- row omitted config: entirely
[domain/changed] {"domain":"demo_counter","table":"counters","key":"counter","operation":"put","value":{"value":10}}
[domain/changed] {"domain":"demo_counter","table":"counters","key":"counter","operation":"put","value":{"value":20}}
[apply] durable value = 20 | step = 10
unit file =
{
  "unit": { "name": "demo_counter", "version": 1 },
  "global": null,
  "tables": {
    "counters": {
      "hits":    { "value": 2  },
      "counter": { "value": 20 }
    }
  }
}
```

### Certainty markers

* **CERTAIN (source + live):** `Config` = Standard Schema, defaults merged before
  `apply`, `apply(ctx, config)` signature, exact `invalid config:` message,
  `ctx.settings.register(ns, schema, {base})` + `scope.get/watch/update/replace`,
  `settings.yaml` = `namespace: section`, namespace grammar, fiber-effect disposal
  of a registration, `defineDomain`/`domainTable`/`open`/`table.*`/`close`,
  `StorageError`/`DomainError` codes, `UNIT_NAME_RE`, `domain/changed` payload,
  `<root>/<unit>.json` + `<root>/<unit>/<table>/<key>.json` layout,
  `ctx.storage.backend.register/get/names`, `ctx.storage.mount/form/domain`.
* **CERTAIN (source, not live-executed):** the Loader `Entry` → `registry.plugin`
  hop (`entry.ts:296`) and `!!js` interpolation ordering; I proved the
  `registry.plugin` → `apply` half live and read the Entry half.
* **INFERRED:** that a plugin installed as a *bundle* resolves
  `@deepseek-ai/dsh-*` by bare specifier — proven for `@deepseek-ai/schemastery`
  only via `dsh-better-sidebar` (`import z from "schemastery"` is the *upstream*
  package; `dsh-context` uses `import z$1 from "@deepseek-ai/schemastery"`
  successfully, which is the direct evidence). `dsh-chat-import`'s comment claims
  linked installs cannot resolve it — situational, not universal.
* **UNKNOWN:** whether a future DSH (>= 0.1.7) will auto-derive settings
  namespaces from entry `Config`; `dsh-chat-import` says it will, no such code
  exists in this installation.

---

## 7. Disposal / cleanup requirements for storage handles

Every one of these is an **effect on the owning fiber** — disposing/unloading the
plugin fiber runs them, in reverse registration order
(`$DSH/cordis/src/fiber.ts:427-442`).

| Handle | Required cleanup | Evidence |
|---|---|---|
| `ctx.settings.register(...)` | **none** — the API does it for you: `this.ctx.effect(() => { this.registrations.set(...); return () => this.registrations.delete(...) }, 'settings.register("<ns>")')` | `$DSH/dsh-settings/lib/index.js:294-297` |
| `scope.watch(cb)` | returns a disposer; **not** auto-tied to the fiber — "After the disposer returns, no further invocation starts"; service disposal drains started ones | `$DSH/dsh-settings/lib/types/index.d.ts:87-96`; `lib/index.js:300-311` |
| `ctx.storageDomain.open(spec)` | **CALLER owns it**: `domain.close()`, "typically as its own `ctx.effect` disposer"; the facility also `closeAll()`s leftovers on unmount | `$DSH/dsh-storage-domain/lib/types/index.d.ts:76-82`; `lib/index.js:443-452` |
| `ctx.storage.mount(form, facility)` | returns an unmount disposer | `$DSH/dsh-storage/lib/index.js:118-124` |
| `ctx.storage.backend.register(name, backend)` | returns an unregister disposer; **"Disposal does NOT close the backend — the owning plugin closes it after unregistering"** | `$DSH/dsh-storage/lib/index.js:38-51`; `$DSH/dsh-storage/README.md:74` |
| `backend.close()` | the backend owner must call it; "Drain in-flight writes across all open units and release the medium. Idempotent" | `$DSH/dsh-storage/lib/types/backend.d.ts:18-23` |
| `KvUnit.close()` | "Drain this unit's in-flight writes and release it. Idempotent"; any call after close rejects `closed` | `$DSH/dsh-storage/lib/types/backend.d.ts:125-129` |
| `ctx.provide('storage.backend.<n>', backend)` | automatic with the fiber | `$DSH/dsh-storage-json/lib/index.js:601-604` |

**Canonical backend-owner cleanup** — `$DSH/dsh-storage-json/lib/index.js:598-604`:

```js
function apply(ctx, config) {
	const backend = new JsonStorageBackend(config.root);
	ctx.effect(() => {
		const unregister = ctx.storage.backend.register("json", backend);
		return async () => {
			unregister();
			await backend.close();
		};
	});
	ctx.provide(storageBackendServiceKey("json"), backend);
}
```

**Canonical domain-consumer cleanup** — `$DSH/dsh-session-projection-cache/lib/index.js:151-152`:

```js
		const domain = await this.ctx.storageDomain.open(projectionCacheDomainSpec);
		this.ctx.effect(() => () => domain.close(), "sessionProjectionCache.domainClose");
```

**Canonical form-owner cleanup** — `$DSH/dsh-storage-domain/lib/index.js:443-452`
(closeAll before unmount):

```js
		domainCtx.effect(() => {
			const unmount = domainCtx.storage.mount("domain", facility);
			return async () => {
				await facility.closeAll();
				unmount();
			};
		});
```

### 7.1 One more disposal trap (live-proven)

`register()` is **process-wide and single-registration**. Mounting the same plugin
twice (two rows, or two fibers of one callback) with the same namespace throws:

```
Error: settings namespace "demo-counter" is already registered
```

Mounted a second fiber while the first was still live. Same class of failure as
`duplicate-backend` for a second `dsh-storage-json` row (live-proven) and
`already-open` for a second `open()` of the same domain name (live-proven). A
plugin that uses a fixed settings namespace is therefore **one-per-process**;
`dsh-settings` gives no per-fiber namespacing.

---

## Appendix A — Probe scripts (reproducible)

Written to `/tmp/dsh-probe/` (outside the repo, disposable):

| File | Proves |
|---|---|
| `t1.mjs`, `t2.mjs` | schemastery `~standard` shape, `resolveConfig` error string, no `.volatile()` |
| `t3.mjs` | live `apply(ctx, config)`: defaults merged, `this` === Runtime, invalid → `ValidationError` |
| `t4.mjs` | `settings.register` + `update`, on-disk YAML shape, namespace errors, non-JSON rejection, `describe()` |
| `t5.mjs` | early `ctx.get('settings')`, hot reload of settings.yaml, fiber-dispose removes the namespace |
| `t6.mjs` | `Config` must be Standard Schema (plain object/function throw) |
| `t7.mjs` | zod v4 works as `Config` (same `invalid config:` wrapper) |
| `t8.mjs` | full storage/domain API + every error code |
| `t9.mjs` | hard `inject:['settings']` stays PENDING without a provider |
| `demo/counter.js`, `demo/run2.mjs` | the §6 example, end to end |

## Appendix B — Paths cited

```
$DSH/cordis/src/registry.ts                                  (Config contract, runtime record, plugin())
$DSH/cordis/src/fiber.ts                                     (ValidationError, resolveConfig, _resolveConfig, execute)
$DSH/cordis/src/logger.ts, src/service.ts
$DSH/schemastery/README.md, src/index.ts, lib/types/index.d.ts
$DSH/cordis-plugin-loader/src/config/entry.ts                (EntryOptions.config, _start, _patchContext)
$DSH/cordis-plugin-loader/src/config/group.ts, src/index.ts  (internal/config interpolate, internal/update simplify)
$DSH/cordis-plugin-loader/src/config/utils.ts                (evaluate/interpolate/isJsExpr)
$DSH/dsh-base/cordis.patch.yml                               (settings + storage rows)
$DSH/dsh-settings/README.md, lib/index.js, lib/types/index.d.ts
$DSH/dsh-settings-file/README.md, lib/index.js
$DSH/dsh-api-settings-controller/lib/index.js
$DSH/dsh-storage/README.md, lib/index.js, lib/types/{index,backend,error,registry}.d.ts
$DSH/dsh-storage-json/README.md, lib/index.js, lib/types/index.d.ts
$DSH/dsh-storage-domain/README.md, lib/index.js, lib/types/{index,spec,domain,events,error}.d.ts
$DSH/dsh-app-boot/README.md, lib/index.js
$DSH/dsh-agent-presets/presets/cordis/skills/editing-cordis-compositions/SKILL.md
$DSH/dsh-session-projection-cache/lib/index.js
$DSH/dsh-agent-default-model/lib/index.js
/Users/yukisala/.dsh/profiles/web/node_modules/dsh-ultramath/lib/index.js
/Users/yukisala/.dsh/profiles/web/node_modules/dsh-context/lib/index.js
/Users/yukisala/.dsh/profiles/web/node_modules/dsh-better-sidebar/lib/index.js
/Users/yukisala/.dsh/profiles/web/node_modules/dsh-chat-import/lib/{index.mjs,import-prefs.mjs}
/Users/yukisala/.dsh/profiles/web/node_modules/dshmarket/lib/index.js
/Users/yukisala/.dsh/profiles/web/node_modules/dsh-ivory/lib/index.js
/Users/yukisala/.dsh/profiles/web/node_modules/@zhangfengshun/dsh-remote-ssh/lib/index.js
/Users/yukisala/.dsh/settings.yaml
/Users/yukisala/.dsh/storages/{workspace.json,session_projcache/}
/Users/yukisala/.dsh/cordis.patch.yml
/Users/yukisala/.dsh/profiles/web/{cordis.yml,cordis.patch.yml,package.json}
```
