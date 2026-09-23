# The `tools` service and `tools.register(...)` — reverse-engineered from local evidence

Scope: `/Users/yukisala/.nvm/versions/node/v25.9.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/`
No network was used. Every claim below is either (a) a quoted source line with file+line, or (b) an **EMPIRICALLY VERIFIED** result from executing the shipped code with `node` (probe scripts run in `/tmp`, since deleted).

Package versions: `@deepseek-ai/dsh-tools` **0.1.5-rc.2**, `@deepseek-ai/cordis` **4.0.2**, `@deepseek-ai/schemastery` **3.18.2**.

---

## 0. TL;DR

| Question | Answer |
|---|---|
| `register` signature | `register(definition: ToolDefinition): () => void` — **one argument**, a whole definition object. Returns the disposer. |
| Who builds the definition | `defineTool(options)` from `@deepseek-ai/dsh-tools` (a free function, **not** a method). It is optional: `register` accepts a hand-built object too. |
| `parameters` dialect | **Custom shorthand DSL**, *not* plain JSON Schema: `{ path: { type: 'string', required: true } }`. `required` is a **per-property `true`**, not an array. `defineTool` compiles it to raw JSON Schema. A raw JSON Schema is only accepted by the *raw* `register()` path (and by the dynamic-plugin `harness.defineTool`, which unwraps it). |
| `execute` 2nd arg | `exec: ToolRunContext`. Verified live keys: `token, callId, rootCallId, name, arguments, signal, deferContext, concludeTurn` (+ optional `agent`, `parent`). **No `cwd`, no `approval`, no `session`** (cwd comes from `exec.agent.session.header.cwd`). |
| Tool result → model | `execute` returns a JSON **value** → validated against `output.schema` → `output.render(args, value)` returns `ContentBlock[]` → that array *is* the model-visible tool result. |
| Hidden/permission/timeout fields | `timeoutMs` yes (declarative only), `isConcurrencySafe` yes. **No `permission`, `approval`, `hidden`, `readOnly` fields exist.** Approval is a separate `tools/pre-execute` gate. |
| Registry scope | One process-global Cordis **Service** named `tools`, with per-scope *layers*. Presets **do not** prefix tool names. |

---

## 1. The exact signature of `tools.register(...)`

### 1.1 The real definition

`dsh-tools/lib/index.js:2767-2782`:

```js
	/**
	* Register globally or in the calling agent scope. Scoped tools shadow
	* globals; duplicates within one layer and the reserved `run_code` name fail.
	* @param definition - tool schema, execution, and optional finalization/presentation callbacks.
	* @returns the exact disposer that unregisters the tool.
	*/
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

### 1.2 The declared signature

`dsh-tools/lib/types/index.d.ts:595-601`:

```ts
    /**
     * Register globally or in the calling agent scope. Scoped tools shadow
     * globals; duplicates within one layer and the reserved `run_code` name fail.
     * @param definition - tool schema, execution, and optional finalization/presentation callbacks.
     * @returns the exact disposer that unregisters the tool.
     */
    register(definition: ToolDefinition): () => void;
```

### 1.3 Answer

**It is `register(tool)` — one argument.** There is **no** `register(name, tool)` overload anywhere: `grep -n "register(" dsh-tools/lib/index.js` yields exactly two hits (line 2773 the definition, line 2781 the internal call site). The name comes from `definition.name`. Registration returns the Cordis effect disposer.

### 1.4 How `ctx.tools` exists at all

`dsh-tools/lib/index.js:2567-2576` and `2605-2614`:

```js
var ToolRuntime = class extends Service {
	static inject = ["systemPrompt"];
	static Config = z.object({
		mode: z.union([
			"native",
			"ptc",
			"both"
		]).default("native"),
		maxParallelSubCalls: z.natural().min(1).default(10)
	});
```
```js
	constructor(ctx, config = {}) {
		super(ctx, "tools");
		this.defaultMode = config.mode ?? "native";
		this.maxParallelSubCalls = resolveMaxParallelSubCalls(config.maxParallelSubCalls);
		ctx.systemPrompt.tools((context) => this.wireSchemas(context.scope));
```

`super(ctx, "tools")` is the Cordis `Service` constructor, which is what makes `ctx.tools` a service property (and what makes it a `declare module '@deepseek-ai/cordis' { interface Context { tools: ToolRuntime } }` merge — `dsh-tools/lib/types/index.d.ts:24-27`).

A plugin therefore needs `inject: ['tools']` to *read* `ctx.tools` as a property. Without the declaration Cordis throws literally:

```
Error: cannot get property "tools" without inject
```
(EMPIRICALLY VERIFIED.) The escape hatch without inject is `ctx.get('tools')` — used by the dynamic-plugin sandbox.

---

## 2. The COMPLETE option object shape

Two nested shapes matter, and they are *different* types:

* `DefineToolOptions<S, O>` — what **you** write, passed to `defineTool(...)`.
* `ToolDefinition` — what **`register`** actually receives.

### 2.1 `DefineToolOptions` — the complete author-facing shape

`dsh-tools/lib/types/schema.d.ts:177-231` (abridged only in comments; every field is listed):

```ts
/** Options for {@link defineTool}. */
export interface DefineToolOptions<S extends ParameterSchemaSpec, O extends ValueSchemaSpec> {
    /** Tool name (must be unique). */
    readonly name: string;
    /** Human-readable description sent to the model. */
    readonly description: string;
    /** Per-property parameter schema compiled to an implicit open object root. */
    readonly parameters: S;
    /** Canonical output schema plus pure Native and presentation projections. */
    readonly output: {
        /** Schema enforced against every successful body or policy-replaced value. */
        readonly schema: O;
        /** Pure Native/model rendering of one validated canonical value. */
        render(args: InferArgs<S>, value: InferValue<NoInfer<O>>): ContentBlock[];
        /** Pure replayable presentation metadata for direct top-level calls. */
        presentationMeta?(args: InferArgs<S>, value: InferValue<NoInfer<O>>): JsonValue;
    };
    /** Optional positive cooperative timeout budget in milliseconds. */
    readonly timeoutMs?: number;
    /**
     * Pure classifier for sibling overlap.
     * @param args - typed validated arguments.
     * @returns Whether the call may join a parallel group.
     */
    isConcurrencySafe?(args: InferArgs<S>): boolean;
    /**
     * Execute the tool after argument validation.
     * @param args - typed validated arguments.
     * @param exec - execution identity, caller, cancellation, and nesting data.
     * @returns The canonical value declared by `output.schema`.
     */
    execute(args: InferArgs<S>, exec: ToolRunContext): Promise<InferValue<NoInfer<O>>>;
    /**
     * Optional last-mile content transform for every normalized outcome. ...
     */
    finalizeContent?(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): ContentBlock[] | undefined;
    presentCall?(args: InferArgs<S>): ToolCallView | undefined;
    presentResult?(args: InferArgs<S>, result: ToolResult): ToolResultView | undefined;
}
```

So the **complete author-facing field list** is exactly 10 keys:

`name`, `description`, `parameters`, `output{schema, render, presentationMeta?}`, `timeoutMs`, `isConcurrencySafe`, `execute`, `finalizeContent`, `presentCall`, `presentResult`.

**There is no `permission`, `approval`, `hidden`, `readOnly`, `presentation`, `concurrency`, or `namespace` field.** `grep -n "hidden\|readOnly\|permission" dsh-tools/lib/types/schema.d.ts dsh-tools/lib/types/index.d.ts` returns only two hits, both in prose comments (“hidden” describing the *invisible tool* case, “permission” describing guard semantics) — none in a field declaration. `grep -n "hidden\|readOnly" dsh-tools/lib/index.js` returns one hit, a comment at line 2946.

This is corroborated by the project's own TODO, `dsh-tool-bash/lib/index.js:106-108`:

```js
* TODO(permissions): deployment policy belongs in `tools/pre-execute` and
* sandboxing executors; see docs/architecture.md § Where new behavior goes.
```

### 2.2 `ToolDefinition` — the complete registered shape

`dsh-tools/lib/types/index.d.ts:105-172` (exact):

```ts
/** A registered tool: its schema plus the execution function. */
export interface ToolDefinition extends ToolSchema {
    /** Mandatory canonical output declaration. */
    readonly output: ToolOutputDefinition;
    execute(args: unknown, exec: ToolRunContext): Promise<unknown>;
    finalizeContent?(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): ContentBlock[] | undefined;
    timeoutMs?: number;
    isConcurrencySafe?(args: unknown): boolean;
    presentCall?(args: unknown): ToolCallView | undefined;
    presentResult?(args: unknown, result: ToolResult): ToolResultView | undefined;
}
```

`ToolSchema` is imported from `@deepseek-ai/dsh-llm` (`dsh-tools/lib/types/index.d.ts:9`) and defined in `dsh-llm/lib/types/types.d.ts:390-402`:

```ts
/**
 * JSON-schema description of a tool, as sent to the model.
 *
 * Declared here (not in dsh-tools) because it is part of {@link GenerateOptions};
 * dsh-tools' ToolDefinition and dsh-system-prompt's PromptAssembly both import
 * it from this package.
 */
export interface ToolSchema {
    name: string;
    description: string;
    /** JSON Schema object for the arguments. */
    parameters: Record<string, unknown>;
}
```

`dsh-tool-cordis/lib/index.js:8201-8204` re-publishes the same declarations to the model as inspectable types, and `8190-8192`:

```js
		name: "ToolDefinition",
		declaration: "export interface ToolDefinition extends ToolSchema {\n    readonly output: ToolOutputDefinition;\n    execute(args: unknown, exec: ToolRunContext): Promise<unknown>;\n    finalizeContent?(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): ContentBlock[] | undefined;\n    timeoutMs?: number;\n    isConcurrencySafe?(args: unknown): boolean;\n    presentCall?(args: unknown): ToolCallView | undefined;\n    presentResult?(args: unknown, result: ToolResult): ToolResultView | undefined;\n}"
```

### 2.3 What `defineTool` actually produces at runtime

`dsh-tools/lib/index.js:837-883` (exact, complete):

```js
function defineTool(options) {
	const userExecute = options.execute;
	const userFinalizeContent = options.finalizeContent;
	const userRender = options.output.render;
	const userPresentationMeta = options.output.presentationMeta;
	const userPresentCall = options.presentCall;
	const userPresentResult = options.presentResult;
	const userIsConcurrencySafe = options.isConcurrencySafe;
	if (options.timeoutMs !== void 0 && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) throw new Error(`defineTool(${options.name}): timeoutMs must be a positive finite number`);
	const parameters = parameterSchemaSpecToJsonSchema(options.parameters);
	const outputSchema = valueSchemaSpecToJsonSchema(options.output.schema);
	const validate = (args) => validateJsonSchemaValue(parameters, args, "");
	const tool = {
		name: options.name,
		description: options.description,
		parameters,
		output: {
			schema: outputSchema,
			render(args, value) {
				return userRender(args, value);
			},
			...userPresentationMeta !== void 0 ? { presentationMeta(args, value) {
				return userPresentationMeta(args, value);
			} } : {}
		},
		...options.timeoutMs !== void 0 ? { timeoutMs: options.timeoutMs } : {},
		async execute(args, exec) {
			const violations = validate(args);
			if (violations.length > 0) throw new ToolArgsError(violations);
			return userExecute(args, exec);
		}
	};
	if (userFinalizeContent) tool.finalizeContent = (exec, result) => userFinalizeContent(exec, result);
	if (userPresentCall) tool.presentCall = (args) => {
		if (validate(args).length > 0) return void 0;
		return userPresentCall(args);
	};
	if (userPresentResult) tool.presentResult = (args, result) => {
		if (validate(args).length > 0) return void 0;
		return userPresentResult(args, result);
	};
	if (userIsConcurrencySafe) tool.isConcurrencySafe = (args) => {
		if (validate(args).length > 0) return false;
		return userIsConcurrencySafe(args);
	};
	return tool;
}
```

EMPIRICALLY VERIFIED: `Object.keys(defineTool({...}))` === `[ 'name', 'description', 'parameters', 'output', 'execute' ]` for a definition declaring only those. Note `defineTool` does *no* key-whitelisting — an unknown option key (e.g. `foo: 1`) is silently ignored, because the function reads only the seven known names.

### 2.4 The second `execute` parameter — `exec: ToolRunContext`

`dsh-tools/lib/types/index.d.ts:284-301`:

```ts
export interface ToolRunContext extends ToolExecution {
    /**
     * Defer one context ... until this tool's final result reaches the agent loop. ...
     */
    deferContext(context: UserMessage): void;
    /**
     * Mark a successful final result as terminal for the current agent turn. ...
     */
    concludeTurn(): void;
}
```

`ToolExecution` (`:261-266`) `extends ToolExecutionInput` and adds `rootCallId` + `token`; `ToolExecutionInput` (`:197-221`) is:

```ts
export interface ToolExecutionInput {
    readonly callId: ToolCallId;
    readonly rootCallId?: ToolCallId;
    readonly name: string;
    /** Losslessly JSON-serializable parsed arguments (tools validate their own schema). */
    readonly arguments: unknown;
    /** The agent on whose behalf the call runs (set by the agent loop). */
    readonly agent?: Agent;
    readonly parent?: ToolExecutionToken;
    /** Required caller-owned cancellation for this invocation. */
    readonly signal: AbortSignal;
}
```

**EMPIRICALLY VERIFIED** by running a real tool through `ctx.tools.execute(...)`:

```
EXEC KEYS: ["token","callId","rootCallId","name","signal","deferContext","concludeTurn","arguments"]
EXEC callId/name/args: ["call-1","probe_tool",{"q":"hi","n":2}]
EXEC signal ctor: AbortSignal | agent: undefined | parent: undefined | token: symbol
EXEC deferContext/concludeTurn: function function
```

So: **no `cwd`**, **no `session`**, **no `approval`**, **no `toolCallId`** (it is `callId`), **no `logger`**. The canonical way to reach the working directory is the shipped pattern in `dsh-tool-present/lib/index.js:76-82`:

```js
		async execute(args, exec) {
			if (exec.agent === void 0) throw new Error("present requires an agent Session");
			const boundary = ctx.sessionProjections.stateOf(exec.agent.session, "turnBoundary");
			if (boundary === void 0 || boundary.openTurnStartSeq === null) throw new Error("present requires an open turn");
			if (args.files.length === 0 || args.files.length > config.maxFiles) throw new Error(`present accepts 1 to ${config.maxFiles} files`);
			const cwd = exec.agent.session.header.cwd;
			if (cwd === void 0) throw new Error("present requires a workspace");
```

and cancellation via `exec.signal`, e.g. `dsh-tool-present/lib/index.js:85-90` (`signal: exec.signal`) and `:98` (`exec.signal.throwIfAborted();`).

The dynamic-plugin sandbox calls this out too — `dsh-cordis-host-runner/lib/types/guard.js:576`: “`ToolRuntime.execute` — identity protection, pre-policy, monotonic guards, around dispatch, post-policy, final observation, and result normalization.”

### 2.5 Fields that are declarative-only

`dsh-tools/README.md:226`:

> - **`timeoutMs` on a definition is declarative only** — the registry never enforces deadlines; enforcement requires the `@deepseek-ai/dsh-tool-call-timeout-policy` wrapper.

Enforcement is an around-dispatch wrapper, `dsh-tool-call-timeout-policy/README.md`:

> One `tools/execute` listener reads the dispatched tool's declared limit from the registry (`ctx.tools.get(exec.name, exec.agent)?.timeoutMs`); a tool without a limit delegates untouched.

Real usage: `dsh-tool-web/lib/index.js:305-306` (`timeoutMs, isConcurrencySafe: () => true`), `:801-802`.

`isConcurrencySafe` is fail-closed — `dsh-tools/lib/index.js:2951-2959`:

```js
	executionMode(exec) {
		const tool = this.resolveExecution(exec.name, exec.agent, exec.parent !== void 0);
		if (!tool?.isConcurrencySafe) return { kind: "exclusive" };
		try {
			return tool.isConcurrencySafe(exec.arguments) === true ? { kind: "parallel" } : { kind: "exclusive" };
		} catch {
			return { kind: "exclusive" };
		}
	}
```

### 2.6 Presentation fields (`presentCall` / `presentResult` / `presentationMeta`)

`ToolCallView` / `ToolResultView` are `card`-tagged pure render intents (`dsh-tools/lib/types/presentation.d.ts:13-41, 130-136`): `card: 'generic' | 'terminal' | 'diff'` for calls, and `'generic' | 'terminal' | 'diff' | 'search' | 'read' | 'web'` for results. `presentCall` returns `ToolCallView | undefined`; `presentResult` returns `ToolResultView | undefined` and receives `ToolResult` (`dsh-tools/lib/types/index.d.ts:174-186`):

```ts
export interface ToolResult {
    /** The final model-facing content (or the rendered error text on failure). */
    content: ContentBlock[];
    /** Whether the call failed. */
    isError: boolean;
    meta?: JsonValue;
}
```

Smallest real example, `dsh-tool-todo/lib/index.js:187-192`:

```js
		presentCall: (args) => ({
			card: "generic",
			title: "Update todo list",
			kind: "other",
			rawInput: args.todos
		})
```

`presentationMeta` is different: it is a **JsonValue** projector persisted on the result as `meta`, computed only for top-level (non-nested) calls — `dsh-tools/lib/index.js:3427-3436`:

```js
		let meta;
		if (exec.parent === void 0 && tool.output.presentationMeta !== void 0) {
			let projected;
			try {
				projected = tool.output.presentationMeta(exec.arguments, value);
			} catch (error) {
				throw projectionError(tool.name, "presentationMeta", error);
			}
			meta = snapshotProjection(tool.name, "presentationMeta", projected);
		}
```

Real usage: `dsh-tool-web/lib/index.js:303` (`presentationMeta: (_args, value) => searchMetaFromValue(value)`).

Important caveat, `dsh-tools/README.md:88-89`:

> A tool can retain pure `presentCall()` and `presentResult()` methods for Host-local consumers. **The built-in Web Client does not consume those values.** It selects a renderer through `tool.call.toolview` and derives card props from raw call arguments, result content, failure state, and persisted metadata.

---

## 3. The `parameters` schema dialect

### 3.1 It is NOT plain JSON Schema, and NOT schemastery

`parameters` is a **custom per-property shorthand DSL** (`ParameterSchemaSpec`), compiled by `defineTool` to raw JSON Schema.

`dsh-tools/lib/types/schema.d.ts:73-88`:

```ts
/** One implicit parameter-root property, optionally required. */
export type ParameterPropertySpec = ValueSchemaSpec & {
    required?: true;
};
/**
 * Tool parameter schema. The map itself is an implicit open object root;
 * requiredness remains a per-property `required: true` annotation.
 */
export type ParameterSchemaSpec = {
    [key: string]: ParameterPropertySpec;
    [key: symbol]: never;
};
/** Raw JSON Schema projection of the implicit parameter object. */
export interface ParameterJsonSchema extends ObjectJsonSchema {
    properties: Record<string, JsonSchemaNode>;
}
```

Note `required?: true` — the literal `true`, not `boolean`.

### 3.2 The compiler

`dsh-tools/lib/index.js:796-810`:

```js
function parameterSchemaSpecToJsonSchema(spec) {
	const compiled = compilePropertyMap(spec, "parameters");
	const schema = {
		type: "object",
		properties: compiled.properties,
		...compiled.required === void 0 ? {} : { required: compiled.required }
	};
	assertSupportedJsonSchema(schema);
	return schema;
}
```

and the per-property requiredness rule, `dsh-tools/lib/index.js:600-603`:

```js
		if (task.kind === "property") {
			if (!isJsonSchemaRecord(task.property)) authorError(`${task.path} must be a value schema object`);
			if (Object.hasOwn(task.property, "required") && task.property.required !== true) authorError(`${task.path}.required must be true when present`);
			if (Object.hasOwn(task.property, "required") && task.property.required === true) task.required.push(task.key);
```

The allowed author keys are strictly whitelisted (`dsh-tools/lib/index.js:536-556`):

```js
const ANNOTATION_KEYS = [
	"description",
	"title",
	"default",
	"examples"
];
/** Throw one author-schema violation through the shared schema error type. */
function authorError(message) {
	throw new JsonSchemaError([message]);
}
...
/** Reject author-only keys outside one node's declared vocabulary. */
function assertAuthorKeys(source, path, allowed) {
	for (const key of Object.keys(source)) if (!allowed.includes(key)) authorError(`${path}.${key} is not supported by the value schema DSL`);
}
```

Per-type allowed keys (`dsh-tools/lib/index.js:686-751`): scalars allow `type`/`enum`/`const`; `array` allows `type`/`items`; `object` allows `type`/`properties`/`additionalProperties` and **requires explicit `additionalProperties`**; `json` is author-only unconstrained JSON; `oneOf` requires ≥2 branches and forbids a sibling `type`.

### 3.3 EMPIRICALLY VERIFIED compile + rejections

Input:

```js
parameters: {
  path:   { type: 'string', required: true, description: 'Absolute file path' },
  offset: { type: 'number' },
  mode:   { type: 'string', enum: ['a','b'] },
}
```

Output (`defineTool(...).parameters`):

```json
{
  "type": "object",
  "properties": {
    "path": { "type": "string", "description": "Absolute file path" },
    "offset": { "type": "number" },
    "mode": { "type": "string", "enum": ["a","b"] }
  },
  "required": ["path"]
}
```

Rejections, all with the live error text:

| Input | Error thrown (verbatim) |
|---|---|
| `parameters: { type:'object', properties:{q:{type:'string'}}, required:['q'] }` | `JsonSchemaError: unsupported JSON schema: parameters.type must be a value schema object` |
| `parameters: { q: { type:'string', required:['x'] } }` | `JsonSchemaError: unsupported JSON schema: parameters.q.required must be true when present` |
| `parameters: { q: { type:'string', minimum:3 } }` | `JsonSchemaError: unsupported JSON schema: parameters.q.minimum is not supported by the value schema DSL` |
| `parameters` omitted | `JsonSchemaError: unsupported JSON schema: parameters must be an object of value schemas` |
| output `{type:'object', properties:{...}}` without `additionalProperties` | `JsonSchemaError: unsupported JSON schema: schema.additionalProperties must be explicitly true or false` |

### 3.4 The shorthand in real shipped tools

`dsh-tool-todo/lib/index.js:95-119` — the smallest complete shipped tool:

```js
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
					content: {
						type: "string",
						required: true,
						description: "What the task is — a short imperative line."
					},
					status: {
						type: "string",
						required: true,
						enum: [...STATUSES],
						description: "pending (not started) | in_progress (now) | completed (done)."
					}
				}
			}
		} },
```

`parameters: {}` is legal and common — `dsh-tool-goal/lib/index.js:264-268`:

```js
	ctx.tools.register(defineTool({
		name: "get_goal",
		description: GET_DESCRIPTION,
		parameters: {},
		output: GOAL_OUTPUT,
```

Third-party confirmation that this DSL is the public contract — `dsh-find-plugin/lib/index.js:22-45`:

```js
    ctx.tools.register(defineTool({
        name: 'find_dsh_plugin',
        description: '...',
        parameters: {
            query: {
                type: 'string',
                required: true,
                description: 'Keywords describing the capability, e.g. "wechat notifications", "TUI", "跨会话记忆"',
            },
            limit: {
                type: 'number',
                description: 'Max results to return (default 8, max 20)',
            },
```
…and `@zhangfengshun/dsh-remote-ssh/lib/index.js:2184-2189`:
```js
  const register = (tool) => ctx.tools.register(defineTool(tool));

  register({
    name: "remote_ssh_profiles",
    description: "列出 Remote-SSH 插件中已保存的 SSH 连接配置...",
    parameters: {},
```

### 3.5 The RAW path — raw JSON Schema *is* accepted by `register` itself

`register()` validates `output.schema` (`assertSupportedJsonSchema(output.schema)`) but **never touches `parameters`**. EMPIRICALLY VERIFIED:

```js
ctx.tools.register({
  name: 'raw_tool', description: 'Raw.',
  parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'], additionalProperties: false },
  output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
  async execute(args) { return args.q },
})
```
→ `schemas()` returns `{"name":"raw_tool","description":"Raw.","parameters":{"type":"object","properties":{"q":{"type":"string"}},"required":["q"],"additionalProperties":false}}` and a call succeeds. No argument validation runs (the raw `execute` receives the raw arguments) — `defineTool` is what adds validation.

This raw path is acknowledged in the source: `dsh-tools/lib/index.js:1967-1972`:

```
*   worst case. Reachable only through a raw `register()` whose `parameters`
*   is an array reached from the root through `oneOf` arms alone — the root
*   array itself, or one nested under any depth of unions, since an arm
*   inherits the enclosing depth unchanged (`A | B` opens no bracket). An
*   object ancestor takes it out of this case: its fields restart the chain at
*   the 181 site. `defineTool` compiles an object root, so the annotation is a
*   bare TypedDict class name or a one-bracket `dict[str, Any]` when that
*   object degrades — never a chain.
```

If `parameters` is not lossless JSON, the failure is deferred to projection time (EMPIRICALLY VERIFIED):

```
Error | tool "bad_params" parameters must be lossless JSON before schema projection
```
(`dsh-tools/lib/index.js:2936-2937`.)

All shipped first-party tools use `defineTool`. The **only** place a JSON-Schema-shaped `parameters` is normalized for authors is the dynamic-plugin sandbox (see §8.2).

---

## 4. The `output` contract and the value → model-text path

### 4.1 Declaration

`dsh-tools/lib/types/index.d.ts:96-104`:

```ts
/** Tool-owned canonical output contract used after the body returns a JSON value. */
export interface ToolOutputDefinition {
    /** Raw supported JSON Schema enforced against every successful canonical value. */
    readonly schema: JsonSchemaNode;
    /** Pure projection from validated arguments and value to Native/model content. */
    render(args: unknown, value: JsonValue): ContentBlock[];
    /** Pure replayable presentation projection, computed only for top-level calls. */
    presentationMeta?(args: unknown, value: JsonValue): JsonValue;
}
```

* `output.schema` — **raw JSON Schema** (already compiled for `defineTool`, or hand-written). It is enforced against the body's return value; a mismatch becomes `ToolOutputError`. It is also projected to the model in **PTC mode** only (`sdkSchemas`, `dsh-tools/lib/index.js:2922-2931`).
* `output.render(args, value) -> ContentBlock[]` — **the only thing that becomes the model-visible tool result.** It receives the same frozen parsed `arguments` and the validated, deep-frozen canonical value. It must return a **lossless-JSON array of `{type:'text', text}`-style blocks**.
* `output.presentationMeta(args, value) -> JsonValue` — optional, top-level calls only, persisted as `meta`.

### 4.2 The exact conversion code path

**Step 1 — render.** `dsh-tools/lib/index.js:3414-3445`:

```js
	/** Snapshot, validate, render, and optionally project one successful body value. */
	createSuccessResult(exec, tool, candidate) {
		const detached = snapshotToolValue(tool.name, candidate);
		const violations = validateJsonSchemaValue(tool.output.schema, detached, "value");
		if (violations.length > 0) throw new ToolOutputError(tool.name, violations);
		const value = deepFreeze(detached);
		let rendered;
		try {
			rendered = tool.output.render(exec.arguments, value);
		} catch (error) {
			throw projectionError(tool.name, "render", error);
		}
		const content = snapshotProjection(tool.name, "render", rendered);
		...
		const concludesTurn = this.concludingExecutions.has(exec);
		return this.markCanonical(exec, this.materializeFinalResult({
			isError: false,
			value,
			content,
			...meta !== void 0 ? { meta } : {},
			...concludesTurn ? { concludesTurn: true } : {}
		}));
	}
```

Helper error text (`dsh-tools/lib/index.js:2463-2488`):

```js
function projectionError(toolName, projector, error) {
	return new ToolOutputError(toolName, [`output.${projector} failed: ${errorMessage(error)}`]);
}
/** Snapshot one projector result before later durable-result materialization. */
function snapshotProjection(toolName, projector, candidate) {
	try {
		const detached = snapshotJsonValue(candidate);
		if (detached === void 0) throw new ToolOutputError(toolName, [`output.${projector} returned non-lossless JSON`]);
		return detached;
	} catch (error) {
		if (error instanceof ToolOutputError) throw error;
		throw projectionError(toolName, projector, error);
	}
}
```

**Step 2 — the loop logs it verbatim.** `dsh-agent-loop/lib/index.js:696-713`:

```js
/** Append a model-ordered result linked to its call event. */
function appendToolResult(session, turn, step, block, result, callSeq) {
	const message = createToolResultMessage({
		callId: block.id,
		content: result.content,
		isError: result.isError
	});
	session.append("tool/result", {
		turn,
		step,
		message,
		...result.error?.info ? { error: result.error.info } : {},
		...result.meta !== void 0 ? { meta: result.meta } : {}
	}, {
		surfaceOp: "append",
		sourceEventSeqs: [callSeq]
	});
}
```

**Step 3 — the message shape.** `dsh-llm/lib/index.js:94-107`:

```js
function createToolResultMessage(input) {
	return createUserMessage({
		source: {
			kind: "tool",
			callId: input.callId
		},
		content: [{
			type: "tool-result",
			toolCallId: input.callId,
			content: input.content,
			isError: input.isError
		}]
	});
}
```

**Step 4 — projection into model history.** `dsh-session/lib/index.js:209-219`:

```js
function deriveEventMessage(event) {
	switch (event.type) {
		case "user/message": return event.data;
		case "system/message":
		case "assistant/message":
			if (event.data.message.content.length === 0) return null;
			return event.data.message;
		case "tool/result": return event.data.message;
		default: return null;
	}
}
```

### 4.3 Failure rendering — everything becomes `Error: <message>`

`dsh-tools/lib/index.js:3490-3501`:

```js
function toolErrorResult(error) {
	const info = errorInfo(error);
	const message = errorMessage(error);
	return {
		content: [{
			type: "text",
			text: `Error: ${message}`
		}],
		isError: true,
		error: {
			message,
			...info ? { info } : {}
		}
	};
}
```

**EMPIRICALLY VERIFIED** whole-pipeline results (`ctx.tools.execute(...)` return values, JSON):

| Scenario | Result |
|---|---|
| success | `{"isError":false,"content":[{"type":"text","text":"rendered:hi:2"}],"meta":{"echoed":"hi"},"value":{"echoed":"hi"}}` |
| invalid args | `{"isError":true,"error":{"message":"invalid arguments: missing required property \"q\"; \"n\" must be a number","info":{"name":"ToolArgsError","code":"INVALID_ARGS"}},"content":[{"type":"text","text":"Error: invalid arguments: missing required property \"q\"; \"n\" must be a number"}]}` |
| unknown tool | `{"isError":true,"error":{"message":"unknown tool \"nope\"","info":{"name":"ToolNotFoundError","code":"UNKNOWN_TOOL"}},"content":[{"type":"text","text":"Error: unknown tool \"nope\""}]}` |
| thrown body | `{"isError":true,"error":{"message":"boom"},"content":[{"type":"text","text":"Error: boom"}]}` |
| bad output value | `{"isError":true,"error":{"message":"tool \"liar\" returned invalid output: \"value.a\" must be a string","info":{"name":"ToolOutputError","code":"INVALID_TOOL_OUTPUT"}},"content":[{"type":"text","text":"Error: tool \"liar\" returned invalid output: \"value.a\" must be a string"}]}` |
| aborted before dispatch | `{"isError":true,"error":{"message":"tool call aborted before dispatch","info":{"name":"AbortError","code":"ABORTED_BEFORE_DISPATCH"}},"content":[{"type":"text","text":"Error: tool call aborted before dispatch"}]}` |

Note the successful shape: `{isError:false, content, meta?, value}` — `value` is the canonical JSON value, `content` is the rendered `ContentBlock[]`. The `value` is deliberately omitted from durable events (`dsh-tools/lib/types/index.d.ts:392`: “Execution-local canonical value; deliberately omitted from durable events.”).

### 4.4 `finalizeContent` — the post-hoc rewrite of model-visible content

`dsh-tools/lib/index.js:3275-3277`:

```js
		const finalizeContent = this.contentFinalizers.get(exec);
		if (finalizeContent === void 0) return result;
		const content = finalizeContent(exec, result);
```

Real usage, `dsh-tool-jobs/lib/index.js:246` (`finalizeContent: finalizeTaskContent`) with the implementation at `:184-201` returning either a replacement `ContentBlock[]` or `undefined`.

---

## 5. Where the tool NAME becomes visible to the model

### 5.1 The chain, with exact lines

1. **Registration** — `definition.name` is the key in the scope layer. `dsh-tools/lib/index.js:2774` `const name = definition.name;` → `:2781` `layer.tools.insert(name, definition)`.

2. **Projection to the wire schema** — `dsh-tools/lib/index.js:2933-2943`:

```js
	/** Project one definition onto the model-facing schema fields. */
	schemaOf(definition, detachParameters) {
		const { name, description, parameters } = definition;
		const detached = detachParameters ? snapshotJsonValue(parameters) : parameters;
		if (detached === void 0) throw new Error(`tool "${name}" parameters must be lossless JSON before schema projection`);
		return {
			name,
			description,
			parameters: detached
		};
	}
```

3. **Prompt-assembly provider registration** — `dsh-tools/lib/index.js:2609`:

```js
		ctx.systemPrompt.tools((context) => this.wireSchemas(context.scope));
```

4. **Assembly collects and orders** — `dsh-system-prompt/lib/index.js:317-330` and `:348`:

```js
		const providers = [...this.layers.global.toolProviders.values(), ...scopeLayers.flatMap((layer) => [...layer.toolProviders.values()])];
		const collected = [];
		const knownNames = /* @__PURE__ */ new Set();
		for (const provider of providers) {
			const result = provider(context);
			const schemas = result.schemas.map(({ name, description, parameters }) => ({
				name,
				description,
				parameters: structuredClone(parameters)
			}));
			const acceptedKnownNames = result.knownNames ?? schemas.map((tool) => tool.name);
			collected.push(...schemas);
			for (const name of acceptedKnownNames) knownNames.add(name);
		}
```
```js
			tools: orderTools(collected, this.toolOrder, knownNames),
```

5. **Ordering rule** — `dsh-system-prompt/lib/index.js:82-90`:

```js
function orderTools(tools, toolOrder, knownNames) {
	if (tools.find((tool) => tool.name === "<unlisted-tools>") !== void 0) throw new Error(`tool provider returned reserved tool name "${TOOL_ORDER_REST}" (reserved for toolOrder's rest entry)`);
	if (toolOrder === void 0) return tools.sort(compareToolNames);
	const unknown = toolOrder.filter((name) => name !== "<unlisted-tools>" && !knownNames.has(name));
	if (unknown.length > 0) throw new Error(`toolOrder lists unregistered tool${unknown.length > 1 ? "s" : ""} ${unknown.map((name) => `"${name}"`).join(", ")}; known tools: ${[...knownNames].sort().join(", ") || "(none)"}`);
	const listed = new Set(toolOrder);
	const rest = tools.filter((tool) => !listed.has(tool.name)).sort(compareToolNames);
	return toolOrder.flatMap((name) => name === "<unlisted-tools>" ? rest : tools.filter((tool) => tool.name === name));
}
```

Default order is **lexicographic by name** (`compareToolNames`, `:99-102`), overridable by the `toolOrder` config on the system-prompt row.

6. **Into the request** — `dsh-agent-loop/lib/index.js:1030` `this.buildRequest(config, preparedCall, assembly.tools, startsRequestSeries, signal)`, then `:1166-1173`:

```js
	buildRequest(config, preparedCall, tools, startsRequestSeries, signal) {
		const { session } = this;
		const surfaceGeneration = session.surface.replaceGeneration;
		const header = canonicalHeader({
			config,
			...preparedCall === void 0 ? {} : { adapterDefaults: preparedCall.adapterDefaults },
			...tools.length > 0 ? { tools } : {}
		});
```

7. **Onto the wire** — `dsh-llm-deepseek/lib/index.js:227-235`:

```js
function requestWithMessages(options, messages, defaults) {
	const tools = options.tools?.map((tool) => ({
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters
		}
	}));
```

So the model sees `tools[].function.name` = `definition.name`, byte-for-byte.

### 5.2 Namespacing / prefixing per agent preset — **NO**

* `schemaOf` returns `name` unmodified. There is no prefix/suffix/namespace logic anywhere in the projection path (`dsh-tools/lib/index.js:2918-2943`).
* Presets separate tools by **registry layer**, not by name: `dsh-agent-presets/lib/index.js:1778-1780`:

```js
				const key = { agentPreset: preset.id };
				const scope = createScope(this.selfCtx, key);
```

* Agents separate by **scope key = the Agent object itself** — `dsh-agent-loop/lib/index.js:761-762`:

```js
		this.scope = createScope(loopCtx, this);
		this.ctx = this.scope.ctx;
```

* Consequence (EMPIRICALLY VERIFIED): the **same name can exist in a global layer and a scope layer**, and the nearer scope wins:

```
global view : [{"name":"shared_name","description":"GLOBAL.","parameters":{...}}]
scoped view : [{"name":"shared_name","description":"SCOPED SHADOW.","parameters":{...}}]
get(global) : GLOBAL.
get(scoped) : SCOPED SHADOW.
global sees scoped_only: false
scoped sees scoped_only: true
```

  i.e. **shadowing, not namespacing**. Two different presets can both register `foo` and each agent sees only its own.
* The plane rule is stated plainly in code — `dsh-agent-tool-presentation/lib/index.js:7-13`:

```
* The tool registry itself stays on the host plane — the agent loop's
* scheduler, the API proxy's presenters, and every tool plugin are all its
* consumers, so it cannot move into a preset. What a preset CAN own is the
* presentation: `ctx.tools.presentAs()` declares it for the mounting SCOPE,
* which is the preset's standing mount, so the declaration covers every agent
* joined to that preset and a PTC mode preset runs beside native ones in one
* process. One row per composition, not one per session.
```

### 5.3 How the scoping actually works mechanically (important gotcha)

`ctx.tools` returns a **Cordis traceable proxy** per accessing context, not the raw singleton — `cordis/lib/index.js:131-146`, `:762-763`:

```js
function createTraceable(ctx, value, tracker) {
	if (ctx[symbols.shadow] && !tracker.noShadow) ctx = Object.getPrototypeOf(ctx);
	const proxy = new Proxy(value, {
		get: (target, prop, receiver) => {
			if (prop === symbols.original) return target;
			if (prop === tracker.property) return ctx;
```
```js
	get(name, strict = true) {
		return getTraceable(this.ctx, this._getImpl(name, strict)?.value);
	}
```

The proxy's `ctx` symbol returns the **accessing** context, so `ToolRuntime.register` reads `scopeOf(this.ctx)` = the *caller's* scope. EMPIRICALLY VERIFIED: `scope.ctx.get('tools') === rootCtx.tools` is `false`, yet both are `ToolRuntime` instances, and the registration genuinely landed in the scope layer.

---

## 6. Throwing / validation errors, and which fields are required

### 6.1 Every registry error string found (with file+line)

| # | Message | Where |
|---|---|---|
| 1 | `tool "${name}" must declare output { schema, render, presentationMeta? }` | `dsh-tools/lib/index.js:2776` (TypeError) |
| 2 | `unsupported JSON schema: <violations joined by "; ">` | `JsonSchemaError`, `dsh-tools/lib/index.js:25-33` + `:322-326` |
| 3 | `tool "${name}" timeoutMs must be a positive finite number` | `dsh-tools/lib/index.js:2779` (TypeError) |
| 4 | `tool name "run_code" is reserved for the PTC mode presentation transport and cannot be registered or shadowed` | `dsh-tools/lib/index.js:2780` |
| 5 | `tool "${name}" is already registered (for a per-agent variant, register through that agent's \`agent.ctx\` instead)` | `dsh-tools/lib/index.js:2538` (global layer) |
| 6 | `tool "${name}" is already registered in this scope` | `dsh-tools/lib/index.js:2538` (scoped layer) |
| 7 | `tool "${name}" parameters must be lossless JSON before schema projection` | `dsh-tools/lib/index.js:2937` |
| 8 | `tool "${name}" output schema must be lossless JSON before SDK projection` | `dsh-tools/lib/index.js:2926` |
| 9 | `defineTool(${options.name}): timeoutMs must be a positive finite number` | `dsh-tools/lib/index.js:845` |
| 10 | `invalid arguments: ${violations.join("; ")}` | `ToolArgsError`, `dsh-tools/lib/index.js:811-819` |
| 11 | `tool "${toolName}" returned invalid output: ${violations.join("; ")}` | `ToolOutputError`, `dsh-tools/lib/index.js:2454-2461` |
| 12 | `unknown tool "${toolName}"` / `unknown tool "${toolName}": ${reachableFrom}` | `ToolNotFoundError`, `dsh-tools/lib/index.js:2441-2451` |
| 13 | `output.${projector} failed: ${message}` / `output.${projector} returned non-lossless JSON` | `dsh-tools/lib/index.js:2464-2476` |
| 14 | `value is not lossless JSON` / `value snapshot failed: ${message}` | `dsh-tools/lib/index.js:2479-2488` |
| 15 | `tools.restrict() requires a scoped context (agent.ctx): a context-global restriction would mask every agent — deny the tool for the intended agent instead` | `dsh-tools/lib/index.js:2792` |
| 16 | `tools.restrict({}) is a no-op: pass \`allow\` and/or \`deny\` (an empty filter is almost always a materialized-empty-config bug)` | `dsh-tools/lib/index.js:2795` |
| 17 | `tools.restrict() cannot name reserved PTC mode presentation transport "run_code"; restrict end-capability tools instead` | `dsh-tools/lib/index.js:2800` |
| 18 | `tools.restrict() names unknown global tool${…} …; known global tools: …` | `dsh-tools/lib/index.js:2803` |
| 19 | `tools.presentAs() requires a scoped context (agent.ctx): a context-global presentation is the \`mode\` config field on the tools row` | `dsh-tools/lib/index.js:2707` |
| 20 | `tools.presentAs("${mode}") conflicts with "${layer.mode}" already declared for this scope; one composition selects one presentation` | `dsh-tools/lib/index.js:2710` |
| 21 | `dsh-tools: mode "${mode}" requires a code runtime — load a ctx.codeRuntime implementation (e.g. @deepseek-ai/dsh-code-runtime-worker-thread) or set tools mode to "native"` | `dsh-tools/lib/index.js:2760` |
| 22 | `dsh-tools: no SDK renderer registered for runtime language ${…} (known: ${…})` | `dsh-tools/lib/index.js:2763` |
| 23 | `maxParallelSubCalls must be a positive integer` | `dsh-tools/lib/index.js:2560` |
| 24 | `tool provider returned reserved tool name "<unlisted-tools>" (reserved for toolOrder's rest entry)` | `dsh-system-prompt/lib/index.js:83` |
| 25 | `toolOrder lists "${name}" more than once` / `toolOrder must contain the "<unlisted-tools>" rest entry (where unlisted tools are inserted)` / `toolOrder lists unregistered tool…` | `dsh-system-prompt/lib/index.js:71, 74, 86` |
| 26 | `tools/post-execute accept decision cannot replace both value and content` / `tools/post-execute cannot replace the value of a failed result` | `dsh-tools/lib/index.js:3389, 3392` |
| 27 | `tool result must be losslessly JSON-serializable` | `dsh-tools/lib/index.js:2512` |

DSL-specific (`JsonSchemaError`, 1 violation per message, `assertSupportedJsonSchema` collects all):

* `${path} must be a value schema object` — `:601`, `:651`
* `${path}.required must be true when present` — `:602`
* `${path} must be an object of value schemas` — `:618`
* `${path} must be an object of value schemas` (property-map root; this is the **missing-parameters** error) — `:618`, EMPIRICALLY `unsupported JSON schema: parameters must be an object of value schemas`
* `${path} is circular` — `:619`, `:652`
* `${path}.${key} is not supported by the value schema DSL` — `:555`
* `${path}.enum must be a non-empty array of scalar values` — `:745`
* `${path}.type must be string/number/integer/boolean/null/array/object/json, or use oneOf` — `:750`
* `${path}.oneOf must be an array of at least two value schemas` — `:668`
* `${path} cannot declare both type and oneOf` — `:667`
* `${path}.additionalProperties must be explicitly true or false` — `:698`
* `${path}.required must be an array of strings` / `${path}.required names "${key}" which is not in properties` / `${path}.additionalProperties must be a boolean` — `dsh-tools/lib/index.js:155, 161, 163`

EMPIRICALLY VERIFIED registrations (exact output):

```
DUP ERROR: Error | tool "demo_tool" is already registered (for a per-agent variant, register through that agent's `agent.ctx` instead)
SCOPED DUP ERROR: tool "shared_name" is already registered in this scope
RESERVED ERROR: Error | tool name "run_code" is reserved for the PTC mode presentation transport and cannot be registered or shadowed
NOOUTPUT ERROR: TypeError | tool "no_output" must declare output { schema, render, presentationMeta? }
BADSCHEMA ERROR: JsonSchemaError | unsupported JSON schema: schema.required names "nope" which is not in properties | ["schema.required names \"nope\" which is not in properties"]
TIMEOUT ERROR: TypeError | tool "bad_timeout" timeoutMs must be a positive finite number
RESTRICT-GLOBAL ERROR: tools.restrict() requires a scoped context (agent.ctx): ...
RESTRICT-EMPTY ERROR: tools.restrict({}) is a no-op: ...
RESTRICT-UNKNOWN ERROR: tools.restrict() names unknown global tool "nope"; known global tools: shared_name
RESTRICT-RUNCODE ERROR: tools.restrict() cannot name reserved PTC mode presentation transport "run_code"; restrict end-capability tools instead
PRESENTAS-GLOBAL ERROR: tools.presentAs() requires a scoped context (agent.ctx): ...
```

### 6.2 Is `parameters` required? Is `description` required?

| Field | TypeScript | Runtime |
|---|---|---|
| `name` | required (`schema.d.ts:180`) | **not validated** by `register`; but a missing name breaks duplicate detection & projection |
| `description` | required (`schema.d.ts:182`) | **NOT required.** EMPIRICALLY VERIFIED: `defineTool({name:'no_desc', parameters:{}, output:{...}, execute})` succeeds, `description === undefined`, and the projected schema is `{"name":"no_desc","parameters":{"type":"object","properties":{}}}` — the `description` key is **omitted from the JSON entirely**. |
| `parameters` | required (`schema.d.ts:184`) | **REQUIRED** through `defineTool`: `JsonSchemaError: unsupported JSON schema: parameters must be an object of value schemas`. Through **raw** `register` it is not validated at all, but a non-lossless-JSON value fails later at projection. |
| `output` | required | **REQUIRED** and shape-checked by `register` (error #1 above) |
| `output.schema` | required | Required; asserted against the supported JSON Schema subset by `register` |
| `output.render` | required | Required, `typeof ... === "function"` checked by `register` |
| `execute` | required | **Not validated by `register`** — a missing `execute` yields a dispatch-time failure, not a registration error. (`defineTool` also does not validate it, but will throw `TypeError: userExecute is not a function` when called.) |

The registry never validates the *name format*. No `^[a-zA-Z0-9_-]{1,64}$`-style check exists in `dsh-tools`, `dsh-llm`, or `dsh-system-prompt` (grep for such a regex finds only storage-key rules in `dsh-storage-json/lib/index.js:302`). Whether a *provider* rejects an exotic name is **UNKNOWN** from local evidence.

---

## 7. `dispose` / unregister semantics; per-session or process-global

### 7.1 The disposer

`register` returns `this.layers.effect(this.ctx, …)`, which is `ctx.effect(...)` — a Cordis effect disposer. `dsh-scope/lib/index.js:182-218`:

```js
	effect(ctx, action, options) {
		const scope = scopeOf(ctx);
		const notify = options.notify ?? true;
		return ctx.effect(function* () {
			let layer;
			let created = false;
			if (scope === void 0) layer = this.global;
			else {
				const existing = this.scoped.get(scope);
				if (existing === void 0) {
					layer = this.createLayer(scope);
					this.scoped.set(scope, layer);
					created = true;
				} else layer = existing;
			}
			let undo;
			try {
				undo = action(layer);
			} catch (error) {
				if (scope !== void 0 && created && layer.isEmpty()) this.scoped.delete(scope);
				throw error;
			}
			yield () => {
				undo();
				if (scope !== void 0 && layer.isEmpty()) this.scoped.delete(scope);
				if (notify) this.onChange();
			};
			if (notify) this.onChange();
		}.bind(this), options.label);
	}
```

The undo itself is idempotent — `dsh-scope/lib/index.js:15-38`:

```js
var NamedEntries = class {
	duplicateError;
	data = /* @__PURE__ */ new Map();
	constructor(duplicateError) {
		this.duplicateError = duplicateError;
	}
	insert(name, value) {
		const data = this.data;
		if (data.has(name)) throw this.duplicateError(name);
		data.set(name, value);
		let active = true;
		return () => {
			if (!active) return;
			active = false;
			data.delete(name);
			if (data.size === 0 && this.data === data) this.data = /* @__PURE__ */ new Map();
		};
	}
```

EMPIRICALLY VERIFIED:

```
schemas after register: [{"name":"demo_tool",...}]
schemas after dispose: []
double dispose ok
AFTER PLUGIN DISPOSE, schemas: 0
```

Consequences:
* The disposer removes **exactly one** registration and is safe to call repeatedly.
* A scope layer is created lazily and **reclaimed when it becomes empty**.
* `tools/change` is emitted on every register and unregister — `dsh-tools/lib/index.js:2592-2594`:

```js
	layers = new ScopedLayers((scope) => new ToolLayer(scope), () => {
		this.ctx.emit("tools/change");
	});
```
  documented at `dsh-tools/lib/types/index.d.ts:84-93`: *“An UNFILTERED registry-subject notification, deliberately not scope-filtered dispatch: a global change concerns every agent's next assembly, so a scoped listener subscribing here sees every change, not just its own scope's.”*
* Because registration is a Cordis **fiber effect**, a plugin's tools vanish automatically when its fiber is disposed (proven above). The dynamic-plugin runner relies on exactly this — `dsh-cordis-host-runner/lib/index.js:900-906`: *“Stopping needs no helper — a host half unwinds through an ordinary awaited `fiber.dispose()`, because everything the plugin registered is an effect on its fiber.”*
* A duplicate registration in the dynamic runner gets extra guidance — `dsh-cordis-host-runner/lib/index.js:925`:

```js
		if (message.includes("already registered")) throw new Error(`${message} — to REPLACE something an earlier dynamic package registered, first cordis_stop that package's id (find it with cordis_runtime_inspect what:"temporary"), then run the new version.`);
```

### 7.2 Per-session or process-global?

**Both, at different levels:**

* **The service is process/deployment-global.** One `ToolRuntime` Cordis `Service` named `tools`, created once by whichever composition mounts the row (`super(ctx, "tools")`). It is host-plane and cannot live in a preset (`dsh-agent-tool-presentation/lib/index.js:7-11`, quoted in §5.2).
* **Registrations are per-scope.** A layer per scope key, created on demand. Scope keys in practice:
  * `undefined` → the global layer (host composition / an unscoped plugin / **dynamic Cordis plugins**, which mount under `rootCtx.plugin({name:'cordis-dynamic', …})` — `dsh-cordis-host-runner/lib/index.js:2554-2558`).
  * `{ agentPreset: '<id>' }` → a preset's standing mount (`dsh-agent-presets/lib/index.js:1778`).
  * the `Agent` object itself → one session's agent (`dsh-agent-loop/lib/index.js:761`).
* **It is NOT per-session in the sense of “one registry per session.”** There is one registry; sessions differ only by which layers their scope chain resolves. A tool registered into a *session's* `agent.ctx` is visible only to that agent (EMPIRICALLY VERIFIED: `global sees scoped_only: false`, `scoped sees scoped_only: true`).

### 7.3 `restrict` — the per-agent *mask* (not a per-tool field)

`dsh-tools/lib/types/index.d.ts:471-480` + `dsh-tools/lib/index.js:2790-2805`. Restrictions intersect, apply only to *inherited* tools, never to a scope's own registrations, and lift when disposed. Note the important exemption documented at `dsh-tools/lib/index.js:2839-2844`:

```
	* A restriction filters what a scope inherits — the global layer and every
	* ancestor layer on its chain — and never what its OWN layer registers.
```

Real usage — per-child capability filtering, `dsh-subagent/lib/index.js:554`:

```js
	if (composition.toolFilter !== void 0) childCtx.tools.restrict(composition.toolFilter);
```

### 7.4 How approval / permissions actually attach (there is no tool field)

Approval is a **pipeline stage**, not a definition field:

* `PreToolDecision` — `dsh-tools/lib/types/index.d.ts:419-427`: `{kind:'allow'} | {kind:'deny', reason} | {kind:'ask', reason?}`.
* The waterfall — `dsh-tools/lib/index.js:3116`: `const gate = await this.ctx.waterfall(carrier, "tools/pre-execute", exec, () => Promise.resolve({ kind: "allow" }));`
* The `ask` resolution comment — `dsh-tools/lib/types/index.d.ts:782-792`: *“Resolve an `ask` decision to allow/deny through the approval seam. The seam is consumed opportunistically with `ctx.get('approval')` — a deployment that composes no ApprovalService keeps the historical degrade to deny…”*
* The only shipped producer of `ask` in this install is `dsh-hooks-claude-code/lib/index.js:248-260`. Real listeners: `dsh-tool-jobs/lib/index.js:179`, `dsh-hooks-codex/lib/index.js:232`.
* `ctx.tools.guard(guard)` (`dsh-tools/lib/index.js:2816-2821`) registers a *monotonic* denial after pre-execute: `ToolGuard = (execution: Readonly<ToolExecution>) => string | undefined` (`index.d.ts:489`).
* `dsh-user-approval` is a separate service with its own config (`policy: ask|never`), and `dsh-permission-presets` bundles sandbox mode + approval policy — **neither adds a field to a tool definition**.

---

## 8. Minimal complete copy-pasteable example

### 8.1 Host-plane plugin — **VERIFIED BY EXECUTION**

Certain: the export shape (`name` / `inject` / `apply`) is exactly how shipped tool plugins declare themselves (`dsh-tool-todo/lib/index.js:196` exports `{ Config, apply, inject, name }`; `dsh-find-plugin/lib/index.js:12-13` exports `name` + `inject = ['tools']`; `dsh-tool-present/lib/index.js:6-14` exports `name` + `Config` + `inject` + `apply`).
Certain: the `defineTool({...})` body is copied from the shipped pattern.
Inferred: the composition row that mounts it (`cordis` row with `name: <your-package>`), which I did not read for a third-party package.

```js
// my-tool-plugin/lib/index.js
import { defineTool } from '@deepseek-ai/dsh-tools'

/** Cordis plugin name (conventional; dsh-tool-todo/dsh-tool-present all export one). */
export const name = 'my-tool-plugin'

/** Cordis: declare the services this plugin reads as properties. */
export const inject = ['tools']

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  // The disposer is a fiber effect: it is called automatically when this
  // plugin's fiber stops. Keep it only if you need to unregister early.
  const dispose = ctx.tools.register(defineTool({
    name: 'greet',
    description: 'Greet one person by name.',
    // ── the shorthand DSL: one entry per property; `required: true` per property ──
    parameters: {
      who: { type: 'string', required: true, description: 'Name to greet.' },
      times: { type: 'number', description: 'How many times (default 1).' },
    },
    // ── the output contract ──
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,          // MANDATORY on every object node
        properties: { greeting: { type: 'string', required: true } },
      },
      // (args, value) => ContentBlock[]  — this array IS the model-visible result
      render: (_args, value) => [{ type: 'text', text: value.greeting }],
    },
    // ── the body: returns ONLY the canonical value declared by output.schema ──
    async execute(args, exec) {
      exec.signal.throwIfAborted()            // cooperative cancellation
      return { greeting: `Hello ${args.who}`.repeat(args.times ?? 1) }
    },
  }))
  void dispose
}
```

Verified output of running exactly this plugin against a real `ToolRuntime`:

```
SCHEMAS: [
  {
    "name": "greet",
    "description": "Greet one person by name.",
    "parameters": {
      "type": "object",
      "properties": {
        "who": { "type": "string", "description": "Name to greet." },
        "times": { "type": "number", "description": "How many times (default 1)." }
      },
      "required": ["who"]
    }
  }
]
RUN: {"isError":false,"content":[{"type":"text","text":"Hello Ada"}],"value":{"greeting":"Hello Ada"}}
AFTER PLUGIN DISPOSE, schemas: 0
```

**Rules the example encodes (all proven above):**
1. `parameters` uses the DSL, **not** JSON Schema — `required` is a per-property `true`.
2. Every `type: 'object'` node (in `parameters` *and* in `output.schema`) needs an explicit `additionalProperties`.
3. `execute` returns a **value**, not text; `render` turns it into content blocks.
4. `render` must return an **array** of `{type:'text', text}`-shaped blocks (lossless JSON).
5. Nothing else is model-visible: `output`, `execute`, `timeoutMs`, presenters never reach the wire (`dsh-tools/lib/types/index.d.ts:134-138`: *“it is NEVER sent to the model — `schemas()` whitelists only name/description/parameters”*).

### 8.2 Dynamic Cordis Plugin (browser/page-authored) — different API surface

A dynamic plugin's host half does **not** import `defineTool`. It uses the sandbox `harness` object. `dsh-cordis-host-runner/lib/types/sandbox.js:16-41`:

```js
export const HOST_BUILTIN_INSPECTION = [
    ...
    {
        name: 'harness',
        description: 'Host helpers for Package-private Client RPC and model-visible dynamic Tools.',
        signatures: [
            'harness.handle(method: string, handler: (args: JsonValue) => JsonValue | Promise<JsonValue>): () => void',
            'harness.defineTool(definition: ToolDefinition): ToolDefinition',
            'harness.registerTool(ctx: Context, tool: ToolDefinition): () => void',
        ],
    },
```

`dsh-cordis-host-runner/lib/types/guard.js:560-563`:

```js
export function sandboxRegisterTool(ctx, tool) {
    assertDynamicTool(tool);
    return ctx.tools.register(tool);
}
```

`assertDynamicTool` (`:436-440`) enforces that the tool came from `harness.defineTool`:

```js
function assertDynamicTool(tool) {
    if (!isPlainRecord(tool) || tool[DYNAMIC_TOOL] !== true) {
        throw new Error('dynamic tool registration must use a tool returned by harness.defineTool(...)');
    }
}
```

Inside the sandbox, `ctx.tools` is a 3-verb façade (`guard.js:580-587`):

```js
function sandboxTools(ctx) {
    // Resolve reads and writes through the package's own scope.
    return {
        register: (tool) => sandboxRegisterTool(ctx, tool),
        schemas: () => ctx.tools.schemas(scopeOf(ctx)),
        get: (name) => ctx.tools.schemas(scopeOf(ctx)).find(schema => schema.name === name),
    };
}
```

`harness.defineTool` **also accepts the JSON-Schema-style wrapper form** — the one place raw JSON Schema for `parameters` is legitimately accepted (`guard.js:191-220`):

```js
function normalizeParameterSchemaSpec(value, path = 'parameters') {
    if (!isPlainRecord(value)) {
        throw new Error(`harness.defineTool ${path} must be a ParameterSchemaSpec object`);
    }
    if (value.type === 'object') {
        assertSchemaKeys(value, path, ['type', 'properties', 'required', 'additionalProperties', ...ANNOTATION_KEYS]);
        if (!isPlainRecord(value.properties)) {
            throw new Error(`harness.defineTool ${path}.properties must be an object of schemas`);
        }
        if (Object.hasOwn(value, 'additionalProperties') && value.additionalProperties !== true) {
            throw new Error(`harness.defineTool ${path}.additionalProperties must be true or omitted because the implicit parameter root is open`);
        }
        ...
        const required = normalizeRequiredNames(value.required, value.properties, `${path}.required`);
```

So in a dynamic plugin: `parameters` may be **either** the DSL **or** `{type:'object', properties:{...}, required:[...]}`. The `required` array is validated against declared properties (`guard.js:222-239`: `harness.defineTool ${path} names undeclared property ${JSON.stringify(name)}`), and root `additionalProperties` may only be `true`/omitted. `render`'s return is separately asserted (`guard.js:469-475`):

```js
function assertRenderedContent(value) {
    if (Array.isArray(value) && value.every(isContentBlockShape)) {
        return value;
    }
    throw new Error(`output.render returned ${describeReturn(value)} — it must return an ARRAY of content blocks:\n`
        + '  ✓ return [{ type: \'text\', text: String(value) }]');
}
```

Dynamic tools register into the **root/global** layer by default, since the group fiber is created from `rootCtx` (`dsh-cordis-host-runner/lib/index.js:2554-2558`).

---

## 9. Quick reference — everything proven, one screen

```
register(definition: ToolDefinition): () => void          // ONE argument; returns disposer
defineTool(options: DefineToolOptions): ToolDefinition    // free function from '@deepseek-ai/dsh-tools'

DefineToolOptions = {
  name, description,                                      // required by TS; description unchecked at runtime
  parameters: { <prop>: { type, required?: true, description?, title?, default?, examples?,
                          enum?, const?, items?, properties?, additionalProperties?, oneOf? } },
  output: {
    schema: <same DSL, any JSON root>,
    render(args, value) => ContentBlock[],
    presentationMeta?(args, value) => JsonValue,          // → result.meta, top-level calls only
  },
  timeoutMs?,                                             // positive finite; DECLARATIVE ONLY
  isConcurrencySafe?(args) => boolean,                    // only exact `true` opts into parallel
  execute(args, exec) => Promise<value>,                  // value must satisfy output.schema
  finalizeContent?(exec, result) => ContentBlock[] | undefined,
  presentCall?(args) => ToolCallView | undefined,
  presentResult?(args, result) => ToolResultView | undefined,
}

exec: ToolRunContext = {
  token, callId, rootCallId, name, arguments, signal,     // always present (verified live)
  agent?, parent?,                                        // agent absent for agent-less dispatch
  deferContext(context), concludeTurn(),                  // methods
}
// NO cwd, NO session, NO approval, NO toolCallId.
```

---

## 10. Explicitly UNKNOWN (could not be proven locally)

1. **Provider-specific tool-name constraints.** The shipped DeepSeek adapter passes `name` through verbatim (`dsh-llm-deepseek/lib/index.js:231`); no local code validates name format. Whether any provider rejects e.g. a 70-char or non-ASCII name is not determinable here.
2. **The referenced docs are not shipped.** `dsh-tools/README.md` cross-references `docs/subsystems/tools.md`, `docs/tool-catalog.md`, `docs/cookbook/adding-a-tool.md`, and several `.agents/notes/*.md`. `/Users/yukisala/.nvm/versions/node/v25.9.0/lib/node_modules/@deepseek-ai/dsh/` contains only `lib/`, `node_modules/`, `package.json`, `README.md` — **no `docs/` and no `.agents/`**. Those specific documents could not be read.
3. **Whether `presentCall`/`presentResult` are consumed by the shipped Web client.** The README explicitly says they are **not** (`dsh-tools/README.md:88-89`), which I quote but did not independently verify in client code.
4. **Cross-realm guarantees of the dynamic sandbox.** `dsh-cordis-host-runner/lib/types/sandbox.js:6-7` says it “is not containment: host-realm helper functions remain an escape route.” I did not test that.
5. **`generate_config`/config-catalog output** for `dsh-tools`' `mode`/`maxParallelSubCalls` — the catalog doc is absent; the schemastery schema is quoted instead (`dsh-tools/lib/index.js:2569-2576`).
