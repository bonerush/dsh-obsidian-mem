# DSH agent / session lifecycle events — reverse-engineered from local evidence

Evidence root (read-only):
`/Users/yukisala/.nvm/versions/node/v25.9.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/`
Third-party plugin: `/Users/yukisala/.dsh/profiles/web/node_modules/@vectorize-io/hindsight-coding-agents/dist/dsh.js`
Real transcript: `/Users/yukisala/.dsh/sessions/--Users-yukisala-subject-dsh-obsidian-mem--/5dbe5d38-4f7c-4031-89ae-f7fd0084f8c4/session.v3.jsonl.zstd`
(18 concatenated zstd frames; frame 0 = header JSON, frames 1..n = one event per line)

Short names below: `RT` = `dsh-agent/lib/types/runtime-types.d.ts`, `AT` = `dsh-agent/lib/types/types.d.ts`,
`SI` = `dsh-session/lib/types/index.d.ts`, `ST` = `dsh-session/lib/types/types.d.ts`,
`CE` = `cordis/lib/types/events.d.ts`, `CES` = `cordis/src/events.ts`, `AL` = `dsh-agent-loop/lib/index.js`.

---

## 1. Complete list of agent/session lifecycle event names

### (A) `agent/*` — 13 events, declared in `dsh-agent/lib/types/runtime-types.d.ts`
(augmentation of `declare module '@deepseek-ai/cordis' { interface Events { … } }`, RT:212–418).

| # | exact name | kind | RT line | payload / signature |
|---|---|---|---|---|
| 1 | `agent/created` | **emit** | 224 | `(this: Scoped<Agent>, payload: { agent: Agent }): void` |
| 2 | `agent/disposed` | **emit** | 235 | `{ agent: Agent }` |
| 3 | `agent/status` | **emit** | 247 | `{ agent: Agent; status: AgentStatus }` |
| 4 | `agent/inbox/inserted` | **emit** | 258 | `{ agent: Agent; message: UserMessage }` |
| 5 | `agent/inbox/claimed` | **emit** | 272 | `{ agent: Agent; message: UserMessage; turn: number }` |
| 6 | `agent/inbox/discarded` | **emit** | 284 | `{ agent: Agent; message: UserMessage }` |
| 7 | `agent/session-start` | **emit** | 298 | `{ agent: Agent; source: SessionStartSource }` |
| 8 | `agent/pre-step` | **WATERFALL** | 313 | `(payload:{agent,messages,turn,step,signal}, next: () => Promise<PreStepDecision>) => Promise<PreStepDecision>` |
| 9 | `agent/request` | **WATERFALL** | 336 | `(payload:{agent,turn,step,signal}, next: () => Promise<LlmCallConfig>) => Promise<LlmCallConfig>` |
| 10 | `agent/request-error` | **WATERFALL** | 357 | `(payload:{agent,turn,step,provider,failure,retryPolicy,signal}, next: () => Promise<RequestErrorAction>) => Promise<RequestErrorAction>` |
| 11 | `agent/assistant-stream` | **emit** | 375 | `{ agent: Agent; frame: AssistantStreamFrame }` |
| 12 | `agent/turn-stopping` | **SERIAL** (not waterfall) | 396 | `(payload:{agent,turn,signal}): Promise<void> | void` — **no `next`** |
| 13 | `agent/error` | **emit** | 411 | `{ agent: Agent; turn: number; step: number; error: unknown }` |

Every one is marked `Scope-filtered dispatch (@deepseek-ai/dsh-scope)` in its JSDoc.
Exhaustive grep of every `@mode` doc block in the install returns exactly these 10 top-level
`agent/*` names plus the 3 `agent/inbox/*` names — no others exist in this build.

Exact quotes (RT:313–319, 288–301, 379–400):

```
        /**
         * The session lifecycle began, once before the first turn. Use
         * `agent.inject()` to seed model-facing context. This is a notification, not
         * a veto; disposal requested by a lifecycle owner is rechecked before the
         * driver starts.
         * @mode emit
         */
        'agent/session-start'(this: Scoped<Agent>, payload: {
            agent: Agent;
            source: SessionStartSource;
        }): void;
```
```
        /**
         * Reject a proposed step or replace the messages that enter it. Calling
         * `next()` preserves the current messages.
         * @param payload.signal - the current turn's cancellation signal.
         * @mode waterfall
         */
        'agent/pre-step'(this: Scoped<Agent>, payload: {
            agent: Agent;
            messages: UserMessage[];
            turn: number;
            step: number;
            signal: AbortSignal;
        }, next: () => Promise<PreStepDecision>): Promise<PreStepDecision>;
```
```
         * @mode serial
         */
        'agent/turn-stopping'(this: Scoped<Agent>, payload: {
            agent: Agent;
            turn: number;
            signal: AbortSignal;
        }): Promise<void> | void;
```

### (B) `session/*` — 4 events, `dsh-session/lib/types/index.d.ts`

| exact name | kind | SI line | signature |
|---|---|---|---|
| `session/created` | emit | 40 | `(this: Scoped<Session>, session: Session): void` |
| `session/disposed` | emit | 50 | `(this: Scoped<Session>, session: Session): void` |
| `session/event` | emit | 62 | `(this: Scoped<Session>, session: Session, event: SessionEvent): void` |
| `session/flush` | **parallel** (awaited barrier, no veto) | 71 | `(this: Scoped<Session>, session: Session): Promise<void> | void` |

### (C) `agent/session.header.id` / `.cwd` / `.origin` are **NOT EVENTS**

They do not exist as event names anywhere in this build. Grep over the whole install and over
`/Users/yukisala/.dsh/profiles/web/node_modules/` finds **zero** occurrences of the strings
`agent/session.header`, `session/header`, `'dispose'`. What does exist is the *property path*
`agent.session.header.<field>`:

* `/Users/yukisala/.dsh/profiles/web/node_modules/@vectorize-io/hindsight-coding-agents/dist/dsh.js`:
  ```js
  function workspaceRoot(agent) {
    return agent.session.header.cwd || process.cwd();
  }
  …
  if (agent.session.header.origin === "subagent") return void 0;
  …
  liveAgents.set(agent.session.header.id, agent);
  ```
* `dsh-tool-fs/lib/types/session-cwd.d.ts:3` — "the calling agent's per-session workspace
  (`exec.agent.session.header.cwd`)".

`sessions.header` is a **dotted sub-path of an object**, not an event namespace. There is no
dotted-event subscription mechanism; you subscribe to `agent/created` / `agent/session-start` /
`agent/disposed` (or `session/created`) and then read `agent.session.header.*`. See §3.

### (D) Adjacent lifecycle events seen but out of the agent/session pair (for completeness)
`subagent/start`, `subagent/end` (`dsh-subagent/lib/types/index.d.ts:85,94`);
`goal/activation-changed`, `goal/changed`; `tools/result`, `tools/change`;
`workflow/start|phase|log|agent-start|agent-end|end`; `api-session/added|removed|status|activity|error`;
`feedback/committed`; `fs/observed`; `agent-preset/selected`.

Emission order at agent publication (AL:1714–1720) — proves ordering:

```js
					detachSession = agent.ctx.sessions.enter(session);
					detachAgent = loopCtx.agents.enter(agent, parentAgent);
					agent.ctx.sessions.announce(session);      // -> session/created
					assertLive();
					loopCtx.agents.announce(agent);            // -> agent/created
					assertLive();
					emitAgentEvent(loopCtx, agent, "agent/session-start", { source });
```

`SessionStartSource` (RT:104–105):
```ts
/** Why a session lifecycle began; seeded creates are `startup`, while persisted loads are `resume`. */
export type SessionStartSource = 'startup' | 'resume' | 'clear' | 'compact';
```
Emitters: AL:1763 `return prepared.publish("startup").agent;` (create) and AL:1925
`… options.agentOptions ?? {}, options.setup, options.signal, "resume", owned, options.parentAgent)`.
`'clear'` and `'compact'` are declared but **UNKNOWN / no emitter** (dsh-agent README:174,184:
"the `SessionStartSource` values `'clear'`/`'compact'` are reserved with no emitter yet").

### (E) `agent/inbox/spliced` is a SESSION event, not a ctx event
`dsh-agent/lib/types/types.d.ts:73–87`:
```ts
declare module '@deepseek-ai/dsh-session/types' {
    interface SessionEventMap {
        'agent/inbox/spliced': {
            target: InboxTarget;
            start: number;
            removedCount?: number;
            inserted: UserMessage[];
            outcome?: 'canceled';
        };
    }
}
```

---

## 2. What is the `agent` object?

Base declaration — `dsh-agent/lib/types/types.d.ts:10–14`:
```ts
/** Public live-agent handle; the runtime face augments its live capabilities. */
export interface Agent {
    /** Session-backed Agent identity. */
    readonly id: SessionId;
}
```
Live face — `runtime-types.d.ts:138–211`:
```ts
declare module './types.ts' {
    interface Agent {
        /** The provider route and model this agent's requests use. */
        readonly options: AgentOptions;
        /** The live session this agent drives; its log is the durable source of truth. */
        readonly session: Session;
        /** Agent-owned access to durable pending work. */
        readonly inbox: Inbox;
        /** The current lifecycle state, mirrored on every `agent/status` transition. */
        readonly status: AgentStatus;
        /** Agent-scoped context; its contributions are agent-local, unwind on disposal, and reject registration afterward. */
        readonly ctx: Context;

        cancel(cause: AgentCancelCause, options?: CancelOptions): void;
        whenIdle(): Promise<void>;
        runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>;
        send(message: UserMessage, target: InboxTarget, wakeup: boolean): void;
        followup(message: UserMessage): void;
        steer(message: UserMessage): void;
        inject(message: UserMessage): void;
    }
}
```
`AgentStatus` (RT:83–90): `export type AgentStatus = 'idle' | 'running';`
`AgentOptions` (RT:21–30): `{ provider?, model?, reasoningEffort?, maxTokens? }`.
`Inbox` (RT:41–82): `readonly nextTurn`, `readonly nextStep`, `clear()`, `append(target,msg)`,
`prepend`, `replace(id,msg)`, `remove(id)`, `splice(target,start,deleteCount,inserted)`;
`export type InboxTarget = 'next-turn' | 'next-step';` (AT:25).

**There is no `agent.cwd` and no abort signal on the agent.** cwd lives on the session header;
the signal is a per-event payload field (§4).

Registry — `dsh-agent/lib/types/index.d.ts:199–375` (`ctx.agents`):
`currentInitiator()`, `requireInitiator()`, `withInitiator(agent, op)`, `withoutInitiator(op)`,
`setFactory()`, `create()`, `resume()`, `register()`, `enter()`, `announce()`, `get(id)`,
`isOwnedBy(id, owner)`, `list()`, `roots()`.

---

## 3. `agent.session` and `agent.session.header`

`runtime-types.d.ts:142–143`:
```ts
        /** The live session this agent drives; its log is the durable source of truth. */
        readonly session: Session;
```
`Session` — `SI:103` (plain class, **not** a Service; obtained via `ctx.sessions.create/get`,
`ctx.sessions.list()`, `ctx.sessions.fork()`, or `agent.session`).
`SI:109–117`:
```ts
    /**
     * Detached, deep-frozen creation metadata (format version, cwd, lineage,
     * and whether fork history exists). Supplied by the store via `ctx.sessions.create()`…
     * Kept out of the event log — it is a storage concern, not replayable conversation state.
     */
    readonly header: SessionHeader;
    /** The session identity, derived from its durable header's single copy. */
    get id(): SessionId;
```
`ST:58–95` — **all provable header fields**:
```ts
export interface SessionHeader {
    readonly version: typeof SESSION_FORMAT_VERSION;   // = 3 (ST:54)
    readonly id: SessionId;
    readonly createdAt: number;
    readonly cwd?: string;
    readonly parentSession?: SessionId;
    readonly isSeeded: boolean;
    readonly origin?: 'subagent';
    readonly delegationDepth?: number;
    readonly agentPreset?: string;
}
```
(`SESSION_FORMAT_VERSION = 3` at ST:54; the allow-list the store validates is `CreateSessionOptions.meta`,
ST:114–122 — note `version`/`id`/`createdAt` are filled by the store.)

**Real on-disk header** — frame 0 of a live `session.v3.jsonl.zstd` **is** this object:
```json
{"type":"session","version":3,"id":"5dbe5d38-4f7c-4031-89ae-f7fd0084f8c4","createdAt":1790149181611,
 "cwd":"/Users/yukisala/subject/dsh-obsidian-mem","parentSession":"b8e02487-0664-40a8-8f62-67413284f76c",
 "isSeeded":false,"origin":"subagent","delegationDepth":2,"agentPreset":"cordis"}
```

**How a plugin subscribes to header data:** there is no dotted subscription. Subscribe to the
lifecycle event and read the field:
```js
ctx.on("agent/session-start", ({ agent }) => { agent.session.header.cwd /* …id…origin… */ });
ctx.on("agent/created",       ({ agent }) => { … });
ctx.on("agent/disposed",      ({ agent }) => { … });
```
(hindsight `apply()`: `ctx.on("agent/session-start", hooks.sessionStart); … ctx.on("agent/disposed", hooks.disposed);`)
or `ctx.on('session/created', (session) => session.header.cwd)` (SI:40).

---

## 4. The `signal` field

It **is** an `AbortSignal`. It comes from the loop's per-activity `AbortController`:
`dsh-agent-loop/lib/index.js:846` (running/turn phase) and `:810` (maintenance phase):
```js
		this.setPhase({
			kind: "running",
			abort: new AbortController(),
			turn: this.phase.lastTurn,
			step: 0,
			wakeRequested: false
		});
```
It is the *current turn's* cancellation signal, taken at AL:886 `const signal = this.phase.abort.signal;`
and threaded into `agent/pre-step` (AL:894–899), `agent/request` (AL:1143), `agent/request-error`
(AL:1088) and `agent/turn-stopping` (AL:967). `cancel()` aborts it (AL:798–806):
```js
	cancel(cause, options = {}) {
		if (!options.keepInbox) { this.inbox.clear(); … }
		if (this.phase.kind !== "idle") this.phase.abort.abort(cause);
	}
```
so `signal.reason` is the `AgentCancelCause` (`ST:148–157`: `{kind:'user'} | {kind:'parent'} |
{kind:'hook', reason} | {kind:'disposed'}`; the durable form adds `{kind:'legacy'}`).

Purpose: cooperative cancellation. The loop re-checks after every waterfall
(`signal.throwIfAborted()` at AL:899, :1096, :1151) — a listener that ignores aborted state can
still mutate history, but the loop will throw immediately after. Listeners conventionally
early-return on it: `if (decision.kind === "reject" || signal.aborted) return decision;`
(`dsh-time-context/lib/index.js:217`; hindsight `preStep`). `runMaintenance(task)` also receives a
signal "aborted by {@link cancel}" (RT:170–174).

---

## 5. The WATERFALL protocol

### Cordis base contract
`CE:20–25`:
```ts
export type DispatchMode = 'emit' | 'parallel' | 'serial' | 'bail' | 'waterfall';
```
`CE:67–79` + `CES:234–241`:
```js
  waterfall(...args: any[]) {
    const cbs = this.dispatch('waterfall', args)
    const inner = args.pop()
    const next = () => {
      const cb = cbs.shift() ?? inner
      return cb(...args)
    }
    args.push(next)
    return next()
  }
```
Consequences (exact): the **last dispatch argument is the innermost `next`**;
listeners run **outermost-first**; `next()` **takes no argument** (any value passed is ignored —
`cb(...args)` re-passes the original argument list, whose last element is `next` itself);
not calling `next()` **vetoes the rest of the chain, including the built-in behaviour**
(`CE:70–71`: "calling `next()` invokes the next listener (finally the built-in behavior); not
calling it vetoes"). Bail (`isBailed`, `CE:4–10`) is a *separate* mode: `true unless value is null,
false, or undefined` — in this install used only by `slash/input-*` (`dsh-client-ui-conversation/.../input.d.ts:137–155`).

### Every documented return shape for agent waterfalls

```ts
/** Whether and with which messages the loop enters a proposed step. */      // RT:91-99
export type PreStepDecision = {
    kind: 'reject';
} | {
    kind: 'enter';
    messages: UserMessage[];
    /** Start a distinct model-message series before this step's admitted messages. */
    startsRequestSeries?: true;
};
```
```ts
/** Action returned by a listener that owns model-request recovery. */        // RT:101-103
export type RequestErrorAction = {
    kind: 'retry';
} | undefined;
```
* `agent/request` — return a replacement `LlmCallConfig`; `await next()` yields "the config the
  machine would use (agent options on the first request, the logged header afterwards)"
  (RT:320–328). "Model-visible content must use logged channels; this waterfall cannot mutate messages."
* `agent/turn-stopping` is `serial`, so a listener returns `Promise<void> | void` and steers inside
  the body instead of returning a decision (RT:379–395).
* `agent/assistant-stream` is emit-only; `AssistantStreamFrame` (RT:106–137) is the union
  `{type:'start',attemptId,revision,turn,step} | {type:'chunk',attemptId,revision,index,time,chunk} |
  {type:'end',attemptId,revision,index,outcome:{kind:'committed',eventType:'assistant/message'|'assistant/attempt',seq} | {kind:'abandoned'}}`
  — these are *published* frames, not return values.

### Short-circuit vs delegate — real listeners
* **Delegate then post-process** (hindsight `dist/dsh.js`):
  ```js
  async preStep({ agent, signal }, next) {
    const decision = await next();
    if (decision.kind !== "enter" || signal.aborted) return decision;
    …
    return { kind: "enter", messages: [...decision.messages, injectionMessage(injection)] };
  }
  ```
* **Inspect-then-reject, else delegate** (`dsh-goal-round-driver/lib/index.js:282–345`):
  ```js
  ctx.on("agent/pre-step", async ({ agent, messages, signal }, next) => {
    const submitted = messages.find((message) => isGoalRoundSource(message.source));
    if (submitted === void 0) return next();
    …
    if (!valid) { …; return { kind: "reject" }; }
    let decision = await next();
    …
    return { ...decision, startsRequestSeries: true };
  });
  ```
* **Veto on deny** (`dsh-hooks-claude-code/lib/index.js:230–245`):
  ```js
  ctx.on("agent/pre-step", async ({ agent, messages, turn, signal }, next) => {
    if (messages.length === 0) return next();
    const merged = await runPoint("UserPromptSubmit", "", …);
    if (merged.decision === "deny") return { kind: "reject" };
    const downstream = await next();
    const ours = contextFrom(merged);
    if (!ours || downstream.kind !== "enter") return downstream;
    return { ...downstream, messages: [...downstream.messages, ours] };
  });
  ```
* **Unconditional delegation** (`dsh-compaction-basic/lib/index.js:798–812`): side effect then
  `return next();`
* **Own recovery without delegating**: `agent/request-error` returning `{ kind: "retry" }`
  (`dsh-compaction-basic/lib/index.js:820–850`; loop honours it at AL:1088–1097).
* **`{ prepend: true }`** puts the listener *first/outermost*: `CES:254–260` `const method =
  options.prepend ? 'unshift' : 'push'`, and `waterfall` consumes `cbs.shift()`.

---

## 6. Reading a session transcript

Signature — `SI:179–187`:
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
Synchronous, returns a frozen **array** (not an iterator). Siblings on the same class:
`eventAt(seq): SessionEvent | undefined` (SI:178), `get seq(): SessionLogOffset` (SI:200),
`ownEvents(): readonly SessionEvent[]` (SI:192), `deriveMessages(): Message[]` (SI:285),
`get surface()` (SI:108), `requestHeader()` (SI:251), `requestContext()` (SI:260),
`append(type, data, ...opts)` (SI:238), `header` (SI:117), `id` (SI:121).
Real callers (grep `snapshotEvents(`): `dsh-api-session-controller/lib/index.js:904,946,1429`,
`dsh-session-projection/lib/index.js:381,407`, `dsh-session-query/lib/index.js:276`,
`dsh-session-title/lib/index.js:282`, `dsh-agent-loop/lib/index.js:1808`. Hindsight's defensive form:
```js
function dshSessionEvents(session) {
  return session.snapshotEvents?.() ?? session.events ?? [];
}
```

### Envelope — `ST:447–483`
```ts
export type SessionEvent<T extends SessionEventType = SessionEventType> = {
    [K in SessionEventType]: {
        type: K;
        /** Monotonic sequence number within the session. */
        seq: SessionSeq;
        /** Unix epoch milliseconds. */
        time: number;
        data: SessionEventMap[K];
        ignorable?: true;
    } & (K extends SurfaceEventType ? SurfaceIntent<K> : {
        surfaceOp?: never;
        sourceEventSeqs?: never;
    });
}[T];
```
`export type SurfaceEventType = 'system/message' | 'user/message' | 'assistant/message' | 'tool/result';` (ST:413)
`export type SurfaceOp = 'append' | { op: 'replace'; startSeq: SessionSeq; endSeq: SessionSeq };` (ST:429–433)

### `data` shapes — `ST:242–404` (core `SessionEventMap`)
| type | data shape | ST line |
|---|---|---|
| `turn/start` | `{ turn: number }` | 249 |
| `turn/end` | `{ turn: number; reason: TurnEndReason }` | 260 |
| `step/start` / `step/end` | `{ turn: number; step: number }` | 265 / 270 |
| `user/message` | `UserMessage` (the message itself is the payload) | 281 |
| `system/message` | `{ turn, step, message: SystemMessage }` | 294 |
| `assistant/message` | `{ turn, step, message: AssistantMessage; stream: AssistantStreamRecord[]; usage?: TokenUsage; interrupted?: true }` | 309 |
| `assistant/attempt` | `{ turn, step, stream: AssistantStreamRecord[] }` | 323 |
| `tool/call` | `{ turn, step, callId: ToolCallId; name: string; arguments: string }` (raw unparsed JSON string) | 333 |
| `tool/result` | `{ turn, step, message: ToolResultMessage; error?: {name,code}; meta?: JsonValue }` | 351 |
| `request/header` | `{ header: EpochHeader; reason: RequestHeaderReason; startsSeries?: true }` | 366 |
| `request/context` | `RequestContext` (provider, model, contextWindow?, systemPromptUpdate?) | 378 |
| `session/end-seed` | `{ inherited?: true }` | 401 |

`TurnEndReasonMap` (ST:165–199): `completed | aborted{reason} | blocked | error{error:LlmFailure} |
'max-tokens' | interrupted`.

### REAL example objects (this machine, this workspace)
Decoded from `session.v3.jsonl.zstd` (id `5dbe5d38-…`, a real subagent session):
```json
{"type":"turn/start","seq":6,"time":1790149181681,"data":{"turn":1}}
{"type":"step/start","seq":8,"time":1790149183548,"data":{"turn":1,"step":1}}
{"type":"user/message","seq":10,"time":1790149183550,"data":{"content":[{"type":"text","text":"You are researching …"}],
  "source":{"kind":"user"},"role":"user","id":"654eb46d-c88d-4096-9ab1-ee79eee64951"},"surfaceOp":"append"}
{"type":"user/message","seq":11,…,"data":{"content":[{"type":"text","text":"Current runtime context. …"}],
  "source":{"kind":"plugin","plugin":"@deepseek-ai/dsh-system-prompt","form":"snapshot",
            "sections":[{"name":"sandbox:policy","text":"…"},{"name":"approval:policy","text":"…"},
                        {"name":"subagent:delegation","text":"…"}]},
  "role":"user","id":"9efe7787-c952-4620-bccd-0d34bc89724e"},"surfaceOp":"append"}
{"type":"user/message","seq":12,…,"data":{"…","source":{"kind":"skill-catalog","form":"catalog","entries":[…]},…}}
{"type":"request/header","seq":13,…,"data":{"header":{"config":{"provider":"deepseek-official","model":"deepseek-flash",
  "reasoningEffort":"max","maxTokens":256000},"tools":[/*58 schemas*/]},"reason":"initial"}}
{"type":"request/context","seq":14,…,"data":{"provider":"deepseek-official","model":"deepseek-flash",
  "contextWindow":1000000,"systemPromptUpdate":"in-history"}}
{"type":"assistant/message","seq":16,…,"data":{"turn":1,"step":1,
  "message":{"id":"c041abc7-2dd1-4176-a1bc-9c6aae441a50","role":"assistant",
             "content":[{"type":"text",…},{"type":"tool-call",…},{"type":"tool-call",…}],
             "source":{"kind":"model","provider":"deepseek-official","model":"deepseek-flash"}},
  "usage":{"inputTokens":17302,"outputTokens":215,"totalTokens":36589,"cacheReadTokens":19072,"reasoningTokens":0},
  "stream":[{"type":"chunk","time":1790149184762,"chunk":{"type":"block-start","index":0,"blockType":"text"}}, /*…11 frames*/]}
  ,"surfaceOp":"append"}
{"type":"tool/call","seq":17,…,"data":{"turn":1,"step":1,"callId":"call_00_ET_9r4n9mAbP1NM1xqpqvAX3056","name":"bash",
  "arguments":"{\"command\": \"mkdir -p … && pwd && which curl gh && gh auth status 2>&1 | head -5\", \"description\": \"Check workspace and tooling\"}"}}
{"type":"tool/result","seq":18,…,"data":{"turn":1,"step":1,
  "message":{"source":{"kind":"tool","callId":"call_00_ET_9r4n9mAbP1NM1xqpqvAX3056"},
    "content":[{"type":"tool-result","toolCallId":"call_00_ET_9r4n9mAbP1NM1xqpqvAX3056",
                "content":[{"type":"text","text":"/Users/yukisala/subject/dsh-obsidian-mem\n…"}],"isError":false}],
    "role":"user","id":"bafbac1a-466c-41e0-b357-b31fee9db6fa"}},
  "sourceEventSeqs":[17],"surfaceOp":"append"}
{"type":"agent/inbox/spliced","seq":5,…,"data":{"target":"next-turn","start":0,"inserted":[{/*the user prompt*/}]}}
{"type":"agent/inbox/spliced","seq":7,…,"data":{"target":"next-turn","start":0,"removedCount":1,"inserted":[]}}
{"type":"session/title","seq":15,…,"data":{"title":"You are researching Obsidian vault","messageSeqs":[10],"source":{"kind":"fallback"}}}
```
Note `surfaceOp`/`sourceEventSeqs` are envelope-level (top-level of the event), **not** inside `data`.

**Complete runtime vocabulary (55 types)** — `dsh-session/lib/types/known-event-types.js:21–78`
(`KNOWN_SESSION_EVENT_TYPES`): `agent-preset/selected, agent/inbox/spliced, approval/asked,
approval/decided, approval/policy, assistant/attempt, assistant/message, command/done, command/run,
compaction/end, compaction/prune, compaction/start, compaction/summary, deliverables/presented,
feedback/message-delete, feedback/message-put, feedback/record, goal/change, hook/invoked,
hook/result, llm/retry, llm/retry-started, model/selection, permission/preset, plan/mode,
request/context, request/header, sandbox/mode, schedule/change, session-log-deepseek/delivery-accepted,
session/end-seed, session/title, session/title-llm-request, step/end, step/start, subagent/catalog,
subagent/descriptor, subagent/model-selection-policy, system/message, team/member,
team/message/delivered, team/message/queued, team/task, todo/write, tool-workflow/agent-end,
tool-workflow/agent-start, tool-workflow/run-end, tool-workflow/run-start, tool/call,
tool/ptc-dispatch, tool/ptc-dispatch-start, tool/result, turn/end, turn/start, user/message`.

Incremental alternative to re-snapshotting: `ctx.sessionProjections.stateOf(session, key)`
(`dsh-session-projection/lib/types/index.d.ts:150+`; the registry "subscribes to `session/event`
once; every committed event passes every registered unit's `apply`").

---

## 7. Observing SESSION END / AGENT DISPOSAL

| what | event | payload | mode | proof |
|---|---|---|---|---|
| agent left the registry | `agent/disposed` | `{ agent: Agent }` | emit | RT:227–237 |
| session left the store | `session/disposed` | `session: Session` | emit | SI:41–50 |
| durability barrier | `session/flush` | `session: Session` | parallel | SI:63–71 |
| per-append feed | `session/event` | `(session, event)` | emit | SI:51–62 |

`RT:227–237`:
```
         * An agent left the registry; AgentLoop emits this after driver quiescence
         * and scoped-registration unwind, but before session detachment. Custom
         * registry users own their driver-ordering contract.
         * @param payload.agent - the exact agent removed from the registry.
         * @mode emit
```
`SI:41–50`:
```
         * Emitted once when an announced session leaves the store, including
         * publication rollback, but never for an entry whose creation announcement
         * did not begin. Listener failures are logged and contained.
```
Teardown order (dsh-agent-loop/README.md:111): "Teardown runs stop-and-drain, closes the session's
write path, unwinds the scope, detaches the agent, then detaches the session".

**`ctx.on('dispose')` does NOT exist in this build.** `CE:216–239` declares the framework events
(`internal/plugin`, `internal/status`, `internal/config`, `internal/service`, `internal/update`,
`internal/get`, `internal/set`, `internal/listener`, `internal/dispatch`) — there is no `dispose`
event, and grep for `on('dispose'` / `on("dispose"` over the entire install returns nothing.
The mechanism is **`ctx.effect`**: `cordis/lib/types/fiber.d.ts:145–157`
```ts
    effect(execute: () => SyncEffect, label?: string): Disposable<Promise<void>>;
    effect(execute: () => Effect, label?: string): AsyncDisposable<Promise<void>>;
```
with `Disposable` = "Function returned by an effect to release resources during disposal.
Disposers run in reverse registration order when the owning fiber unloads" (`fiber.d.ts:36–41`).
Real pattern (`dsh-api-session-controller/lib/types/history.js:74–86`):
```js
        ctx.on('agent/assistant-stream', ({ agent, frame }) => { … }, { global: true });
        ctx.on('agent/disposed', ({ agent }) => {
            this.assistantStreams.delete(agent.session.id);
        }, { global: true });
        ctx.effect(() => () => {
            for (const close of this.closeFollowers) close();
            this.closeFollowers.clear();
        }, 'session-controller.history');
```

---

## 8. Injecting a context message into a session

Message value type — `dsh-llm/lib/types/message.d.ts:119–133`:
```ts
export interface Message {
    readonly id: MessageId;
    readonly role: 'system' | 'user' | 'assistant';
    readonly content: ContentBlock[];
    readonly source: MessageSource;
}
export interface UserMessage extends Message { readonly role: 'user'; }
```
Source vocabulary — `message.d.ts:90–104`:
```ts
export interface MessageSourceMap {
    user:   { kind: 'user' };
    plugin: { kind: 'plugin'; plugin: string } & ContextFormed;
    model:  ModelMessageSource;
    tool:   ToolMessageSource;   // { kind:'tool'; callId: ToolCallId }
}
```
`ContextFormed` (`message.d.ts:71–89`): `{form?: never} | {form:'instructions'} | {form:'catalog'} |
{form:'snapshot', sections: ContextSnapshotSection[]} | {form:'notice', summary: string} |
{form:'relay'} | {form:'recall'}`.

**Five injection APIs** (all end as a user-role surface message):
1. `agent.inject(message)` — RT:201–209 `Queue model-facing context for the next pre-step without
   waking the driver.` Loop impl `AL:794–796`: `inject(input) { this.send(input, "next-step", false); }`
   (vs `followup` → `"next-turn", true` AL:787–793, `steer` → `"next-step", true`).
2. `agent.followup(msg)` / `agent.steer(msg)` (RT:187–200).
3. `agent.inbox.append|prepend|replace|remove|splice|clear` (RT:41–82) — durable, each commits one
   `agent/inbox/spliced` session event.
4. `agent/pre-step` returning `{ kind:'enter', messages: [...] }` — the dominant pattern.
5. `session.append('user/message', message, { surfaceOp: 'append' })` (SI:238, ST:281) — the loop's
   own admission path (`AL:1025–1027`).

Real usage — **hindsight** (`dist/dsh.js`):
```js
function injectionMessage(text) {
  return {
    id: randomUUID2(),
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "plugin", plugin: HINDSIGHT_PLUGIN, form: "recall" }
  };
}
…
      return { kind: "enter", messages: [...decision.messages, injectionMessage(injection)] };
```
Real usage — **`dsh-agent-instructions`** (`lib/index.js:784–795`, `1211`, `1225–1231`):
```js
function workspaceContextMessage(text) {
	return createUserMessage({
		content: [{ type: "text", text }],
		source: { kind: "plugin", plugin: name }
	});
}
// merge-extended source kind + form:
function workspaceContextHook(text, changes) {
	return createUserMessage({
		content: [{ type: "text", text }],
		source: { kind: "agent-instructions", form: "instructions", changes }
	});
}
// inbox-based injection (durable pending input, not a decision rewrite):
	const syncInbox = (agent, claimed, desired) => {
		…
		const replaced = pending[0];
		if (replaced === void 0) agent.inbox.prepend("next-step", desired);
		else agent.inbox.replace(replaced.id, desired);
		…
	};
```
Real usage — **`agent/session-start` + `agent.inject`** (`dsh-hooks-claude-code/lib/index.js:220–228`):
```js
	function contextFrom(merged) {
		if (merged.additionalContext.length === 0) return void 0;
		return createUserMessage({
			content: merged.additionalContext.map((text) => ({ type: "text", text })),
			source: PLUGIN_SOURCE          // { kind: "plugin", plugin: "hooks-claude-code" }
		});
	}
	ctx.on("agent/session-start", ({ agent, source }) => {
		… .then((merged) => { const context = contextFrom(merged); if (context) agent.inject(context); })
	});
```
Also `dsh-plan-mode/lib/index.js:370–377` (`agent.inject(narration)` with
`source:{kind:'plugin',plugin:'plan-mode',form:'notice',summary:text}`),
`dsh-user-approval/lib/index.js:100–111`, `dsh-time-context/lib/index.js:215–252`
(returns `{...decision, messages:[...decision.messages, createUserMessage({…form:'snapshot',sections})]}`).

The `{kind:'plugin', plugin}` label is load-bearing — `dsh-repeat-tool-reminder/lib/index.js:1374–1377`:
```js
/**
* The `{kind:'plugin'}` source stamped on every reminder this guard injects —
* the label is load-bearing (an unlabeled context would render as a user
* prompt in derived history).
*/
```
Source kinds are **merge-extensible**: the real transcript above contains
`source.kind === "skill-catalog"` with `form: "catalog"` alongside the declared four.

---

## 9. Registration / disposal rules for `ctx.on`

`CE:80–97`:
```ts
        /**
         * Register an event listener owned by the current fiber.
         * @param name — the event name to listen for.
         * @param listener — called with the dispatch arguments.
         * @param options — listener options; a boolean is shorthand for `prepend`.
         * @returns a disposer removing the listener; `true` if it was still registered.
         */
        on<K extends keyof Events>(name: K, listener: Events[K], options?: boolean | EventOptions): () => boolean;
```
`CE:186–197` (implementation doc): "Register an event listener owned by the current fiber.
**The listener is removed automatically when the fiber unloads. Throws
`CordisError('INACTIVE_EFFECT')` if the fiber is already disposed.**"

Implementation — `CES:254–260` and `CES:288–301`:
```js
  register(label: string, hooks: Hook[], callback: any, options: EventOptions): () => void {
    const method = options.prepend ? 'unshift' : 'push'
    return this.ctx.fiber.effect(() => {
      hooks[method]({ ctx: this.ctx, callback, ...options })
      return () => this.unregister(hooks, callback)
    }, label)
  }
…
  on(name: string | symbol, listener: (...args: any) => any, options?: boolean | EventOptions) {
    if (typeof options !== 'object') { options = { prepend: options } }
    this.ctx.fiber.assertActive()
    listener = this.ctx.reflect.bind(listener)
    const result = this.bail(this.ctx, 'internal/listener', name, listener, options)
    if (result) return result
    const hooks = this._hooks[name] ||= []
    const label = `ctx.on(${typeof name === 'string' ? JSON.stringify(name) : name.toString()})`
    return this.register(label, hooks, listener, options)
  }
```
**Yes — auto-dispose with the owning fiber**, via `ctx.fiber.effect`, and the returned disposer is
single-shot. `once()` (`CES:302–308`) wraps `on` and disposes itself before invoking.

`EventOptions` (`CE:100–106`): `{ prepend?: boolean;  global?: boolean }`.
`global: true` bypasses scope filtering (used by the session controller to observe all agents:
`ctx.on('agent/assistant-stream', …, { global: true })`).

**Scope filtering** — `dispatch()` filters hooks through the dispatch `this`:
```js
    const filter = thisArg?.[Context.filter]
    return (this._hooks[name] || [])
      .filter(hook => hook.global || !filter || filter.call(thisArg, hook.ctx))
      .map(hook => hook.callback.bind(thisArg))
```
`dsh-scope/lib/types/index.d.ts:85–95`: "Build an opaque receiver that preserves the base filter,
admits untagged listeners globally, and admits tagged listeners for a matching key or any of its
ancestors … a listener owned by an enclosing scope receives every descendant scope's events,
which is what lets one standing composition observe each of the agents composed under it. A tag
**BELOW the dispatch key stays excluded — events flow up the chain, never down.**"

Agent-scoped registration (per-agent listeners that unwind with the agent) is
`agent.ctx.on(...)` / `agentCtx.on(...)` — see `installModelSelection` in
`dsh-agent/lib/index.js:143–176`:
```js
	const disposeRequest = agentCtx.on("agent/request", async (_payload, next) => { … });
	const disposeNotice = agentCtx.on("agent/pre-step", async ({ agent, messages, signal, step }, next) => { … }, { prepend: true });
	return () => { disposeAssembly(); disposeRequest(); disposeNotice(); };
```
Note `dsh-agent/lib/types/index.d.ts:293–296`: emits are scope-filtered "regardless of which
context invoked `register` (calling through `agent.ctx` scopes EFFECTS; dispatch scoping always
requires passing the carrier)" — the carrier is `scopeTarget(agent, agent)` / `agentCarrier(agent)`
(`dsh-agent/lib/types/dispatch.d.ts:83`), applied by the fused dispatcher `agentEvents`.

---

## UNKNOWN / not provable from local evidence
* Any `agent/session.header.*` **event** — verified absent (zero grep hits in the install and in
  `/Users/yukisala/.dsh/profiles/web/node_modules/`). Cannot rule out a future/other build.
* Runtime object identity/behaviour of `agent.ctx` beyond its declared type and documented
  "unwind on disposal, reject registration afterward".
* Emitters for `SessionStartSource` `'clear'` / `'compact'` — declared (RT:105) but the README
  itself says they are "reserved with no emitter yet".
* Whether `cwd` is always present at `agent/created` time: `SessionHeader.cwd` is optional (ST:69),
  and `dsh-agent-loop` config `agents[].cwd` is optional too.
* Any event signalling "session end" other than `session/disposed` / `agent/disposed` — none found.
