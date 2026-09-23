# P0 宿主兼容性实测（Task 1：隔离宿主探针与事件顺序）

- **日期**：2026-09-23
- **状态**：P0 实测记录（Task 1 + Task 2 的阻断门槛均已关闭；Task 1 结论见 §2/§3，Task 2 结论见 §8）
- **被测环境**：DSH `0.1.5-rc.2`；Node `v25.9.0`（Task 1）/ `v22.13.0`、`v22.22.2`、`v25.9.0`（Task 2）；`Darwin 27.0.0 arm64`（macOS 27.0）
- **探针**：`test/p0/`（`dsh-obsidian-mem-probe`，丢弃式，不随插件发布）
- **断言脚本**：`test/p0/run-probe.mjs`（Task 1）、`test/p0/llm-sqlite-probe.mjs`（Task 2）
- **设计要求**：计划 `docs/superpowers/plans/2026-09-23-dsh-obsidian-mem-implementation.md` Task 1 Step 4、Task 2 Step 4

## 1. 方法

在一个**隔离的 `DSH_HOME`**（`/tmp` 下 `mktemp -d`，用完删除）里，从随包 `headless` 模板创建 profile `mem-probe`，再把 `test/p0` 以 `link:` 装入该 profile。探针只把事件元数据（事件名、session ID、`seq`、`turn`、`reason`、`decision.kind`、快照可见性）追加到 `$DSH_OBSIDIAN_MEM_PROBE_RECORD`，**不记录任何会话正文**。

模型凭据按 DSH 的解析顺序（继承的进程环境 > `$DSH_HOME/.credentials.yaml` > `.env` 回退）处理：本机 `~/.dsh/.credentials.yaml` 里只有引用名 `DEEPSEEK_API_KEY`，其值被程序化读出后**只以 `DEEPSEEK_API_KEY` 环境变量注入子进程**，从不打印、从不落盘、从不进入本仓库。实测**生效的是环境路由**（第 1 个场景一轮完成，退出码 0），因此不需要把凭据文件复制进临时 home 的 `.env` 回退路由。

```sh
export DSH_HOME="$(mktemp -d /tmp/dsh-obsidian-mem-p0-XXXXXX)"
dsh --profile mem-probe --from-default-profile headless --dump-config
dsh plugin --profile mem-probe add "link:$(pwd)/test/p0"
dsh --profile mem-probe --dump-config            # 确认出现 `- id: obsidian-mem-probe`

export DEEPSEEK_API_KEY=…                        # 只进环境；值不记录
export DSH_OBSIDIAN_MEM_PROBE_RECORD="$DSH_HOME/probe-events.jsonl"

# 场景 1：完整一轮（任一短任务即可）
dsh --profile mem-probe "<one short task>"

# 场景 2：取消一轮（探针在 pre-step waterfall 内对第 1 回合调用 agent.cancel）
export DSH_OBSIDIAN_MEM_PROBE_RECORD="$DSH_HOME/probe-events-cancel.jsonl"
DSH_OBSIDIAN_MEM_PROBE_CANCEL=1 dsh --profile mem-probe "<one short task>"

# 场景 3：无模型服务（隔离 home 无凭据、环境无凭据）
unset DEEPSEEK_API_KEY
export DSH_OBSIDIAN_MEM_PROBE_RECORD="$DSH_HOME/probe-events-nomodel.jsonl"
dsh --profile mem-probe "<one short task>"

# 断言
DSH_OBSIDIAN_MEM_PROBE_RECORD="$DSH_HOME/probe-events.jsonl" node test/p0/run-probe.mjs
```

探针订阅的最小面（与计划 Step 3 一致）：

```js
ctx.on('session/event', (session, event) => record({ name:'session/event', id:session.header.id, seq:event.seq, type:event.type, reason:event.data?.reason }))
ctx.on('session/flush', async session => record({ name:'session/flush', id:session.header.id }))
ctx.on('agent/pre-step', async ({ turn, signal }, next) => { const d = await next(); record({ name:'agent/pre-step', turn, kind:d.kind, aborted:signal.aborted }); return d })
```

另外：`agent/session-start`、flush 时的 `session.snapshotEvents()` 范围、以及一次**显式** `ctx.sessions.flush(session)`（从不直接派发原始 `session/flush`）。

## 2. 结论（计划 Step 4 的四个问题）

| # | 问题 | 实测结论 | 关键证据 |
|---|---|---|---|
| 1 | 版本 | DSH `0.1.5-rc.2` / Node `v25.9.0` / Darwin 27.0.0 arm64 | `dsh --version`、`node --version`、`uname -srm` |
| 2 | pre-step 是否早于首请求 | **是**（早 5 个事件） | 第 1 回合第 1 步 pre-step 进入时 `seqAtEnter=6`，可见类型**不含** `request/header`；首个 `request/header` 在 `seq=11` |
| 3 | `turn/end` 是否已可从 snapshot 读到 | **是**，通知发出时该 `seq` 已在日志里 | 完成回合 `turn/end` = `seq 17`，该通知 `snapshotHasSeq: true`、`snapshotLen: 18` |
| 4 | flush 是否能补扫 | **存活进程内能**；跨进程（崩溃后）**未验证**，故不收紧保证 | `turn/end` 之后的 `session/flush` 记录 `turnEnds:["completed"]`、`completedTurnEnds:1`；显式 `ctx.sessions.flush()` 返回 `participated:true` |

**计划假设被原样证实**：真实事件就是 `session/event` 通知、`event.type === 'turn/end'`、`event.data.reason.kind === 'completed'`。没有出现需要"按现实弱化断言"的偏差。

`run-probe.mjs` 的三条断言（计划 Step 1 原文，未改写）：

```js
assert.equal(events.filter(e => e.name === 'agent/pre-step' && e.turn === 1).length >= 1, true)
assert.equal(events.some(e => e.name === 'session/event' && e.type === 'turn/end' && e.reason === 'completed'), true)
assert.equal(events.some(e => e.name === 'session/flush'), true)
```

## 3. 其他实测发现（对设计有约束力）

1. **`session/flush` 是"每请求检查点"，不是"回合结束"。** 完整一轮里 flush 在 `seq 3 / 6 / 13 / 15 / 18` 各触发一次，**全部在 `turn/start` 之前或回合中途**；只有 `turn/end` 之后的 flush 能看到完成回合。任何"收到 flush 就当回合结束"的实现都是错的，必须自己去 `snapshotEvents()` 里找未处理的 `turn/end`。
2. **flush 屏障能补扫完成回合。** 在 `turn/end`(seq 17) 之后触发的 flush 里，`session.snapshotEvents()` 含 `turnEnds:["completed"]`，与 fire-and-forget 的 `session/event` 通知相互独立。因此 §10.1 里"在 `session/flush` 的 awaited barrier 再核对未入队的完成回合"对**同一存活进程**成立。
3. **flush 不能恢复从未提交的回合。** flush 只有已提交事件可读；进程在 `turn/end` 提交前死掉时，flush 不是恢复手段。
4. **`agent/session-start` 的次序**：在 `permission/preset`、`sandbox/mode`、`approval/policy` 三个事件和**首次 flush**（`seq 3`）之后、`turn/start`（`seq 4`）之前。source 为 `'startup'`。
5. **pre-step 注入确实落在首个请求前**：pre-step 返回后依次提交 `step/start`(6)、`system/message`(7)、三条 `user/message`(8,9,10)，然后才是 `request/header`(11)。§8 的注入时机成立。
6. **`ctx.get('llm')` 在插件 `apply` 时不存在，到 `agent/session-start` 才存在**（`probe/apply` 记录 `hasLlm:false`，`agent/session-start` 记录 `hasLlm:true`）。这印证了"可选服务用 `ctx.get()`、禁止硬注入 `inject: ['llm']`"：硬注入会让探针在 `apply` 前一直 pending。
7. **取消回合可被确定性区分**：`turn/end.reason.kind === 'aborted'`，`abortCause: 'user'`，无 `request/header`、无 `assistant/message`；headless 退出码 1、stdout 为空。
8. **无模型服务回合**：隔离 home 无凭据时，路由存在但不可用，宿主原文错误为
   `MISSING_CREDENTIAL: llm-deepseek: no API key for provider route "deepseek-official"; store DEEPSEEK_API_KEY through the credentials service …, or export DEEPSEEK_API_KEY in the launching environment`（只含插件/提供方名，无语义正文）。
   该回合以 `turn/end.reason.kind === 'error'`、`errorCode: 'MISSING_CREDENTIAL'` 结束，**没有 `assistant/message`**，只有 `assistant/attempt`。§10.1"只有 `completed` 才进入常规提炼"在事件层可判别。
9. **持久会话日志确实存在**：`$DSH_HOME/sessions/<cwd-slug>/<session-id>/session.v3.jsonl.zstd`（`0600`，逐事件多帧 zstd）、以及 `$DSH_HOME/storages/session_projcache/sessions/<session-id>.json`。所以"崩溃后重启补扫"在**原理上可行**；但本任务只用 Node 标准库单帧解压成功（只能读出头部帧），**未验证多帧读取路径**，因此不据此收紧保证。
10. **凭据路由**：环境变量路由生效（场景 1 退出码 0）。未把 `~/.dsh/.credentials.yaml` 复制进临时 home 的 `.env`/凭据回退路由。三份记录文件都实测**零次**出现凭据值或其 4 字符前缀。

## 4. 原始事件记录

`seq` 为会话内单调序号；`snapshotLen` = 通知时的 `session.seq`；`snapshotHasSeq` = 该事件在通知时已能被 `snapshotEvents(seq, seq+1)` 读到。**不含任何会话正文。**

### 4.1 场景 1 —— 完整一轮（断言目标，31 行）

```jsonl
{"name":"probe/apply","id":"probe","hasSessions":true,"hasLlm":false,"hasAgents":true}
{"name":"session/event","id":"session-c9a87a65-17a6-44e5-a180-67b6547bdfee","seq":0,"type":"permission/preset","snapshotLen":1,"snapshotHasSeq":true}
{"name":"session/event","id":"session-c9a87a65-17a6-44e5-a180-67b6547bdfee","seq":1,"type":"sandbox/mode","snapshotLen":2,"snapshotHasSeq":true}
{"name":"session/event","id":"session-c9a87a65-17a6-44e5-a180-67b6547bdfee","seq":2,"type":"approval/policy","snapshotLen":3,"snapshotHasSeq":true}
{"name":"session/flush","id":"session-c9a87a65-17a6-44e5-a180-67b6547bdfee","seq":3,"snapshotLen":3,"turnEnds":[],"completedTurnEnds":0}
{"name":"agent/session-start","id":"session-c9a87a65-17a6-44e5-a180-67b6547bdfee","source":"startup","hasLlm":true}
{"name":"session/event","id":"session-c9a87a65-17a6-44e5-a180-67b6547bdfee","seq":3,"type":"agent/inbox/spliced","snapshotLen":4,"snapshotHasSeq":true}
{"name":"session/event","id":"session-c9a87a65-17a6-44e5-a180-67b6547bdfee","seq":4,"type":"turn/start","snapshotLen":5,"snapshotHasSeq":true,"turn":1}
{"name":"session/event","id":"session-c9a87a65-17a6-44e5-a180-67b6547bdfee","seq":5,"type":"agent/inbox/spliced","snapshotLen":6,"snapshotHasSeq":true}
{"name":"agent/pre-step/enter","id":"session-c9a87a65-17a6-44e5-a180-67b6547bdfee","turn":1,"step":1,"seqAtEnter":6,"typesAtEnter":["permission/preset","sandbox/mode","approval/policy","agent/inbox/spliced","turn/start"]}
{"name":"session/flush","id":"session-c9a87a65-17a6-44e5-a180-67b6547bdfee","seq":6,"snapshotLen":6,"turnEnds":[],"completedTurnEnds":0}
{"name":"agent/pre-step","id":"session-c9a87a65-17a6-44e5-a180-67b6547bdfee","turn":1,"step":1,"kind":"enter","aborted":false,"seqAtExit":6}
{"name":"session/event","id":"session-c9a87a65-17a6-44e5-a180-67b6547bdfee","seq":6,"type":"step/start","snapshotLen":7,"snapshotHasSeq":true,"turn":1}
{"name":"session/event","id":"session-c9a87a65-17a6-44e5-a180-67b6547bdfee","seq":7,"type":"system/message","snapshotLen":8,"snapshotHasSeq":true,"turn":1}
{"name":"session/event","id":"session-c9a87a65-17a6-44e5-a180-67b6547bdfee","seq":8,"type":"user/message","snapshotLen":9,"snapshotHasSeq":true,"turn":1}
{"name":"session/event","id":"session-c9a87a65-17a6-44e5-a180-67b6547bdfee","seq":9,"type":"user/message","snapshotLen":10,"snapshotHasSeq":true,"turn":1}
{"name":"session/event","id":"session-c9a87a65-17a6-44e5-a180-67b6547bdfee","seq":10,"type":"user/message","snapshotLen":11,"snapshotHasSeq":true,"turn":1}
{"name":"session/event","id":"session-c9a87a65-17a6-44e5-a180-67b6547bdfee","seq":11,"type":"request/header","snapshotLen":12,"snapshotHasSeq":true,"reason":"initial"}
{"name":"session/event","id":"session-c9a87a65-17a6-44e5-a180-67b6547bdfee","seq":12,"type":"request/context","snapshotLen":13,"snapshotHasSeq":true}
{"name":"session/flush","id":"session-c9a87a65-17a6-44e5-a180-67b6547bdfee","seq":13,"snapshotLen":13,"turnEnds":[],"completedTurnEnds":0}
{"name":"session/event","id":"session-c9a87a65-17a6-44e5-a180-67b6547bdfee","seq":13,"type":"session/title","snapshotLen":14,"snapshotHasSeq":true}
{"name":"session/event","id":"session-c9a87a65-17a6-44e5-a180-67b6547bdfee","seq":14,"type":"session/title-llm-request","snapshotLen":15,"snapshotHasSeq":true}
{"name":"session/flush","id":"session-c9a87a65-17a6-44e5-a180-67b6547bdfee","seq":15,"snapshotLen":15,"turnEnds":[],"completedTurnEnds":0}
{"name":"session/event","id":"session-c9a87a65-17a6-44e5-a180-67b6547bdfee","seq":15,"type":"assistant/message","snapshotLen":16,"snapshotHasSeq":true,"turn":1}
{"name":"session/event","id":"session-c9a87a65-17a6-44e5-a180-67b6547bdfee","seq":16,"type":"step/end","snapshotLen":17,"snapshotHasSeq":true,"turn":1}
{"name":"session/event","id":"session-c9a87a65-17a6-44e5-a180-67b6547bdfee","seq":17,"type":"turn/end","snapshotLen":18,"snapshotHasSeq":true,"turn":1,"reason":"completed"}
{"name":"session/flush","id":"session-c9a87a65-17a6-44e5-a180-67b6547bdfee","seq":18,"snapshotLen":18,"turnEnds":["completed"],"completedTurnEnds":1}
{"name":"session/flush","id":"session-c9a87a65-17a6-44e5-a180-67b6547bdfee","seq":18,"snapshotLen":18,"turnEnds":["completed"],"completedTurnEnds":1}
{"name":"probe/flush-call","id":"session-c9a87a65-17a6-44e5-a180-67b6547bdfee"}
{"name":"session/flush","id":"session-c9a87a65-17a6-44e5-a180-67b6547bdfee","seq":18,"snapshotLen":18,"turnEnds":["completed"],"completedTurnEnds":1}
{"name":"probe/flush-return","id":"session-c9a87a65-17a6-44e5-a180-67b6547bdfee","participated":true}
```

`dsh` 退出码 `0`，stdout = 该任务要求的固定回复（探针不记录其内容）。

### 4.2 场景 2 —— 取消一轮（`session-51b5bea2-…`）

前缀与 4.1 相同（`probe/apply` … `turn/start`），差异从 pre-step 起：

```jsonl
{"name":"agent/pre-step/enter","id":"session-51b5bea2-…","turn":1,"step":1,"seqAtEnter":6,"typesAtEnter":["permission/preset","sandbox/mode","approval/policy","agent/inbox/spliced","turn/start"]}
{"name":"session/flush","id":"session-51b5bea2-…","seq":6,"snapshotLen":6,"turnEnds":[],"completedTurnEnds":0}
{"name":"agent/pre-step","id":"session-51b5bea2-…","turn":1,"step":1,"kind":"enter","aborted":false,"seqAtExit":6}
{"name":"probe/cancel-issued","id":"session-51b5bea2-…","turn":1}
{"name":"session/event","id":"session-51b5bea2-…","seq":6,"type":"turn/end","snapshotLen":7,"snapshotHasSeq":true,"turn":1,"reason":"aborted","abortCause":"user"}
{"name":"session/flush","id":"session-51b5bea2-…","seq":7,"snapshotLen":7,"turnEnds":["aborted"],"completedTurnEnds":0}
{"name":"session/flush","id":"session-51b5bea2-…","seq":7,"snapshotLen":7,"turnEnds":["aborted"],"completedTurnEnds":0}
{"name":"probe/flush-call","id":"session-51b5bea2-…"}
{"name":"session/flush","id":"session-51b5bea2-…","seq":7,"snapshotLen":7,"turnEnds":["aborted"],"completedTurnEnds":0}
{"name":"probe/flush-return","id":"session-51b5bea2-…","participated":true}
```

`dsh` 退出码 `1`，stdout 为空；无 `request/header`、无 `assistant/message`。
（记录中 session ID 为完整 UUID，此处为排版截断；原文完整可复现。）

### 4.3 场景 3 —— 无模型服务（`session-d74af1df-…`）

前缀同 4.1，差异：

```jsonl
{"name":"session/event","id":"session-d74af1df-…","seq":13,"type":"session/title","snapshotLen":14,"snapshotHasSeq":true}
{"name":"session/event","id":"session-d74af1df-…","seq":14,"type":"session/title-llm-request","snapshotLen":15,"snapshotHasSeq":true}
{"name":"session/flush","id":"session-d74af1df-…","seq":15,"snapshotLen":15,"turnEnds":[],"completedTurnEnds":0}
{"name":"session/event","id":"session-d74af1df-…","seq":15,"type":"assistant/attempt","snapshotLen":16,"snapshotHasSeq":true,"turn":1}
{"name":"session/event","id":"session-d74af1df-…","seq":16,"type":"step/end","snapshotLen":17,"snapshotHasSeq":true,"turn":1}
{"name":"session/event","id":"session-d74af1df-…","seq":17,"type":"turn/end","snapshotLen":18,"snapshotHasSeq":true,"turn":1,"reason":"error","errorCode":"MISSING_CREDENTIAL"}
{"name":"session/flush","id":"session-d74af1df-…","seq":18,"snapshotLen":18,"turnEnds":["error"],"completedTurnEnds":0}
{"name":"session/flush","id":"session-d74af1df-…","seq":18,"snapshotLen":18,"turnEnds":["error"],"completedTurnEnds":0}
{"name":"probe/flush-call","id":"session-d74af1df-…"}
{"name":"session/flush","id":"session-d74af1df-…","seq":18,"snapshotLen":18,"turnEnds":["error"],"completedTurnEnds":0}
{"name":"probe/flush-return","id":"session-d74af1df-…","participated":true}
```

关键差异：`assistant/attempt` 取代了 `assistant/message`，`reason` 为 `error`。`dsh` 退出码 `1`。

## 5. 断言脚本的负向行为（不接受空记录/未完成回合）

| 输入 | 命令 | 结果 |
|---|---|---|
| 未设 `DSH_OBSIDIAN_MEM_PROBE_RECORD` | `node test/p0/run-probe.mjs` | 退出 1，`DSH_OBSIDIAN_MEM_PROBE_RECORD is not set` |
| 空文件 | 同上 + 空记录 | 退出 1，`probe record is empty: …` |
| 文件不存在 | 同上 | 退出 1，`probe record does not exist: …` |
| 有记录但无 `turn === 1` 的 pre-step | 合成记录 | AssertionError: `expected at least one agent/pre-step record with turn === 1` |
| 有 pre-step 但无完成回合 | 合成记录 | AssertionError: `expected a session/event record with type 'turn/end' and reason 'completed'` |
| 有 pre-step + 完成回合但无 flush | 合成记录 | AssertionError: `expected a session/flush record` |
| 场景 2（取消）真实记录 | 真实记录 | 退出 1，缺 `turn/end completed` |
| 场景 3（无模型）真实记录 | 真实记录 | 退出 1，缺 `turn/end completed` |

场景 1 的真实记录通过（GREEN）：

```
run-probe: OK — 31 records across 1 session(s)
  session session-c9a87a65-17a6-44e5-a180-67b6547bdfee
    eventTypes: permission/preset,sandbox/mode,approval/policy,agent/inbox/spliced,turn/start,agent/inbox/spliced,step/start,system/message,user/message,user/message,user/message,request/header,request/context,session/title,session/title-llm-request,assistant/message,step/end,turn/end
    preStepTurn1: true
    preStepBeforeFirstRequest: true
    turnEndReasons: 1:completed
    turnEndInSnapshotAtNotice: true
    flushObserved: true
    flushCompletedTurnEnds: 1
```

## 6. 对设计的修正（已应用）

因为**无法证明**进程崩溃后能从 DSH 持久会话补扫完成回合（只确认了存活进程内 flush 可补扫，持久日志存在但未验证多帧读取），本轮**不收紧** G3 的保证，并把 §10.1 的措辞改成与实测一致：flush 是每请求检查点、可在存活进程内补扫、但保证仍是"pending fsync 后至少一次"。§15 的 P0 行改指向本文件作为证据。

## 7. 安全与清理

- 凭据只在子进程环境里；三份记录文件对凭据值与 4 字符前缀均为 0 命中；本仓库任何文件都不含凭据。
- 临时 home 全部在 `/tmp` 下，实测完成后删除；未写入真实 `~/.dsh`（只读 `~/.dsh/.credentials.yaml` 取引用值）。
- 本文件不含真实会话正文、不含模型输出、不含用户主目录绝对路径（只用 `~` 与 `/tmp` 形式）。

---

## 8. Task 2 实测：LLM 路由/取消与最低 Node 环境矩阵

- **结论一句话**：`ctx.llm.stream()` 的路由失败、取消与超时**都归一化为终止块，不向调用方抛错**；空路由得到 `finish.reason.kind='error'` / `failure.code='NO_ADAPTER'`，因此实现必须**先解析出非空路由**再调用。可实测的最低 Node 下界是 **22.22.2**（22.13.0 的 `node:sqlite` 能免标志载入，但内置 SQLite **没有** `ENABLE_FTS5`）。
- **P0 四项证据（本文件 §2 + 本节）全部关闭**，没有出现需要返工的关键 API 偏差；只需按 §8.3 收紧实现措辞。

### 8.1 方法

复用一个隔离 `DSH_HOME`（`/tmp` 下 `mktemp -d`，用完删除）与同一丢弃式 `mem-probe` profile；`test/p0` 仍以 `link:` 装入。`test/p0/probe-plugin.js` 在**首个 `agent/pre-step` waterfall**（宿主会 await 它，因此四个用例都在本会话首个请求前结清）里跑一次 LLM 用例，只把**字段名、块顺序、终止结果与耗时**追加到 `$DSH_OBSIDIAN_MEM_LLM_PROBE_RECORD`；prompt、响应、推理文本一律不记录。文件系统与 FTS5 断言由 `test/p0/llm-sqlite-probe.mjs` 在临时目录内完成，**每个子断言独立记录通过/失败**。

```sh
export DSH_HOME="$(mktemp -d /tmp/dsh-obsidian-mem-p0llm-XXXXXX)"
dsh --profile mem-probe --from-default-profile headless --dump-config
dsh plugin --profile mem-probe add "link:$(pwd)/test/p0"
dsh --profile mem-probe --dump-config            # 确认出现 `- id: obsidian-mem-probe`

# (a) 最低环境矩阵：不读 LLM 记录，可在任意候选 Node 上单独跑
~/.nvm/versions/node/v22.13.0/bin/node test/p0/llm-sqlite-probe.mjs --env-only   # 22.13.0：FTS5 失败
~/.nvm/versions/node/v22.22.2/bin/node test/p0/llm-sqlite-probe.mjs --env-only
node test/p0/llm-sqlite-probe.mjs --env-only

# (b) LLM 路由用例（真实路由；凭据只进子进程环境，取值从不打印）
export DSH_OBSIDIAN_MEM_LLM_PROBE_RECORD="$DSH_HOME/llm-route.jsonl"
export DSH_OBSIDIAN_MEM_LLM_PROBE_PROVIDER=deepseek-official
export DSH_OBSIDIAN_MEM_LLM_PROBE_MODEL=deepseek-flash
DEEPSEEK_API_KEY=… dsh --profile mem-probe "<one short task>"

# (c) 断言：默认同时校验环境矩阵与 LLM 记录（缺证据即失败）
DSH_OBSIDIAN_MEM_LLM_PROBE_RECORD="$DSH_HOME/llm-route.jsonl" node test/p0/llm-sqlite-probe.mjs
DSH_OBSIDIAN_MEM_LLM_PROBE_RECORD="$DSH_HOME/llm-route.jsonl" ~/.nvm/versions/node/v22.22.2/bin/node test/p0/llm-sqlite-probe.mjs
```

探针记录的 LLM 用例字段名：`case`、`provider`、`model`、`maxTokens`、`signalKind`、`timeoutMs`、`hasAsyncIterator`、`hasThen`、`chunkTypes`、`textDeltaCount`、`blockEndTypes`、`usageFields`、`finishKind`、`finishFailureCode`、`finishFailureMessage`、`finishFields`、`abortAfterChunk`、`signalAborted`、`signalReasonName`、`threwName`、`threwCode`、`threwMessage`、`ms`。

### 8.2 最低 Node 环境矩阵（计划 Step 1）

| Node | 内置 SQLite | `CREATE VIRTUAL TABLE … USING fts5` | `PRAGMA compile_options` 含 `ENABLE_FTS5` | `MATCH '调度器'` | `MATCH '调度'` | file `fsync` | `link` 第二次 `EEXIST` | 同目录 `rename` 替换 | 目录 `fsync` |
|---|---|---|---|---|---|---|---|---|---|
| **v22.13.0** | 3.47.2 | **失败**：`no such module: fts5`（加 `--experimental-sqlite` 同样失败） | **否**（只有 `ENABLE_PREUPDATE_HOOK,ENABLE_SESSION`） | 无法测 | 无法测 | 通过 | 通过 | 通过 | 通过 |
| **v22.22.2** | 3.51.2 | 通过 | 是 | 1 行 | **0 行** | 通过 | 通过 | 通过 | 通过 |
| **v25.9.0** | 3.51.3 | 通过 | 是 | 1 行 | **0 行** | 通过 | 通过 | 通过 | 通过 |

- **实测 Node 下界 = `22.22.2`**（三版中唯一经实测同时满足 FTS5 与全部文件原语的最低版本）。`22.13.0` 是**已实测不支持**（不是"未验证"）；`22.14.0–22.21.x` 未实测。因此 Task 3 的 `package.json` 应声明 `engines.node: ">=22.22.2"`，`indexBackend='auto'` 在更旧版本上必须降级到扫描后端并报告。
- 本节结论**取代**计划中"先测 22.13"的候选假设；计划文件不在本任务 Step 5 的提交文件清单内，故该计划行由控制器另行更新。
- **去实验标志 ≠ FTS5 可用**：22.13.0 只打印 `ExperimentalWarning` 就能 `import 'node:sqlite'`，但 SQLite 构建里根本没有 FTS5。
- **CJK 分词实测复现**：单行 `调度器` 下，`MATCH '调度器'` 命中 1 行，`MATCH '调度'`（2 字）命中 **0** 行 —— `unicode61` 把连续汉字当**一个 token**，所以索引与查询两侧都必须先做 bigram 预分词，不能直接拿用户查询喂 FTS5。
- 文件原语全部按计划 Step 1 的语义通过：`link` 独占发布（第二次必须 `EEXIST`）、同目录 `rename` 原子替换且源链接保留、文件句柄与目录句柄 `fsync` 均可用。

### 8.3 LLM 请求/响应契约（计划 Step 3）

请求形状 `ctx.get('llm').stream({ provider, model, messages, system, maxTokens, signal })`：

- **返回**：`AsyncIterable<StreamChunk>`。实测 `hasAsyncIterator:true`、`hasThen:false` —— 未挂 `llm/stream` 监听器时**同步返回迭代器，不是 Promise**（`stream()` 内部经 `ctx.waterfall` 组合）。
- **`messages`**：每条 `{ id, role, content: [{ type:'text', text }], source: { kind:'user' } }`（运行时 id 就是普通字符串）。`system` 传字符串即可。`maxTokens: 4000`（= 设计默认 `distill.maxOutputTokens`）被接受。

| 用例 | 触发方式 | 观察到的块序列（仅字段名） | 终止块 | 耗时 | 是否抛错 |
|---|---|---|---|---|---|
| `explicit-route` | 显式 `deepseek-official/deepseek-flash` + `AbortSignal.timeout(60000)` | `block-start` `reasoning-delta`×N `block-start` `text-delta` `block-end`×2（`reasoning`,`text`）`usage` `finish` | `reason.kind='stop'` | 670 / 921 ms | 否 |
| `empty-route` | `provider:''`、`model:''` | `finish` | `reason.kind='error'`，`failure.code='NO_ADAPTER'`，`failure.message='no adapter registered for provider ""'` | 0 / 1 ms | 否 |
| `abort-caller` | 调用方 `AbortController`，在第 3 个块后 `abort()` | `block-start` `reasoning-delta`×2 `finish` | `reason.kind='aborted'`，`failure.code='ABORTED'`，`signal.reason.name='AbortError'` | 266 / 658 ms | 否 |
| `timeout` | `AbortSignal.timeout(1)`（派发前即触发） | `finish` | `reason.kind='aborted'`，`failure.code='ABORTED'`，`signal.reason.name='TimeoutError'` | 2 / 3 ms | 否 |

（耗时列的两个值是同一份探针代码两次独立运行的观测，用 `A / B` 表示；`N` 是 `reasoning-delta` 个数，两次分别为 15 与 80。**块类型集合、顺序与终止结果两次完全一致**；只有推理增量个数与总耗时会随模型输出变化，因此断言只检查类型/顺序/终止块，不检查增量计数与绝对毫秒数。）

输出契约：

1. **终止块是唯一判据**。`aborted`/`error` 是**数据而不是异常**；`threwName` 在四个用例里全为 `null`。实现必须以 `finish.reason.kind` 决定结果，`try/catch` 只作兜底（宿主只在中间件/嵌套调用/清理/消费者失败时才抛）。
2. **空路由不可能成功**，且错误码是 `NO_ADAPTER`。`distill.provider/model` 为空时必须先解析"最后一次已记录路由"，解析不出就记 `deferred`，**绝不发起空路由调用**。
3. **`usage` 一定早于终止块**（成功流），字段为 `inputTokens`、`outputTokens`、`totalTokens`、`cacheReadTokens`、`reasoningTokens`；但 `aborted`/`error` 流**没有 `usage`、没有 `block-end`**，token 审计必须允许缺失。
4. **取消与超时无法从 `failure.message` 区分**（两者都是 "…aborted by caller"），只有 `signal.reason.name`（`AbortError` vs `TimeoutError`）和调用方上下文能区分；实现不得靠 message 文本判断原因。
5. **终止块字段**：`Object.keys(finish)` = `['reason','type']`（成功与失败一致），本次未见 `replayState`，实现不得依赖它。
6. 取消/超时后流**立即结清**（2 ms / 266 ms），没有悬挂；超时用 `AbortSignal.timeout(distill.timeoutMs)` 即可，不需要额外的看门狗。
7. **降级规则**：`llm` 服务缺失（`ctx.get('llm') === undefined`）或不支持的 `finishKind` → pending 保持并记 `deferred/failed`；`aborted` → 记中止收据，不产生结论。无模型服务回合的可判别性沿用 §3.8（`turn/end.reason.kind='error'` + `MISSING_CREDENTIAL`）。

### 8.4 断言脚本的负向行为（不接受空记录/缺证据）

| 输入 | 命令 | 结果 |
|---|---|---|
| 未设 `DSH_OBSIDIAN_MEM_LLM_PROBE_RECORD` | `node test/p0/llm-sqlite-probe.mjs` | 退出 1，`DSH_OBSIDIAN_MEM_LLM_PROBE_RECORD is not set`（环境矩阵仍独立打印 5 条 PASS） |
| 文件不存在 | 同上 | 退出 1，`probe record does not exist: …` |
| 空文件 | 同上 | 退出 1，`probe record is empty: …` |
| 合成记录缺少 `abort-caller` 用例 | 同上 | 退出 1，`AssertionError: expected an abort-caller case` |
| 合成记录把取消写成抛错（`threwName='AbortError'`、`finishKind=null`） | 同上 | 退出 1，`expected a terminal aborted finish, got null` |
| `--env-only` | 同上 | 仅跑环境矩阵并**显式打印**「LLM evidence not checked」；不用于放行 |

四版真实记录（Node 25 全量 11 条断言、Node 22.22.2 全量 11 条断言）均通过：

```
llm-sqlite-probe: OK — 11 assertion(s) passed (node v25.9.0 darwin/arm64)
llm-sqlite-probe: OK — 11 assertion(s) passed (node v22.22.2 darwin/arm64)
llm-sqlite-probe: FAIL — 1 of 5 assertion(s) failed (node v22.13.0 darwin/arm64)   # 仅 FTS5
```

### 8.5 安全与清理

- 凭据仍走**环境路由**（本次 `dsh` 退出码 0、stdout 为固定回复），未使用 `/tmp` home 凭据回退，也未把 `~/.dsh/.credentials.yaml` 复制到任何临时 home。
- `llm-route.jsonl` 与整个仓库对凭据值及其 4 字符前缀均为 **0 命中**，对 `$HOME` 绝对路径 0 命中；宿主错误文本已把 `$HOME` 归一为 `~` 并截断 300 字符。
- 记录不含 prompt/响应/推理正文，只有 §8.1 列的字段名、状态与耗时；LLM 用例在隔离 profile 的真实路由上跑一次，不进入生产路径。
- 临时 home 全部在 `/tmp` 下、实测后删除；未写入真实 `~/.dsh`（仅只读取出凭据值）。为测候选下限额外执行了 `nvm install 22.13.0`（只写 `~/.nvm`，与 DSH home 无关）。

### 8.6 对设计的修正（已应用）

1. §7 后端条目：写明"去实验标志 ≠ FTS5 可用"，下界改为实测的 `engines.node >= 22.22.2`，并说明 22.13.0 实测不支持、22.14–22.21 未实测。
2. §10.1：新增实测的 `ctx.llm.stream()` 契约与三条实现约束（先解析非空路由；只以终止块判定；容忍 `aborted` 流无 `usage`/`block-end`）。
3. §16 风险 10 与"P0 必须关闭的风险"②④：改为实测结论（②③④ 现均为已关闭）。

---

## 9. Task 18b 实测：会话结束时整棵插件树被处置，以及"谁结束了在飞的模型调用"

- **结论一句话**：`ctx.get('llm')` 的可见性**只**取决于**提供该服务的 fiber 是否仍处于 ACTIVE**；真正的宿主事实是 DSH 在 headless 会话跑完后**立即处置整棵插件树**（`llm`/`tools`/`sessions` 的实现被注销，plugin fiber 变 `DISPOSED`）。worker 的模型调用**不是因为"不在 Cordis 调用里"而失败**：同一个 provider/model/凭据，从**裸定时器**在存活窗口内发起返回 `stop`（实测）。把在飞调用变成 `finish.reason.kind='aborted'` 的，是**队列 worker 自己的 disposer 调用了 `controller.abort()`**；而**处置本身杀不掉在飞的流**（实测：一个 7190 ms 的流在 provider fiber 已 `DISPOSED` 之后 4.7 s 仍正常收尾）。
- **被测环境**：DSH `0.1.5-rc.2`；Node `v25.9.0`；`darwin arm64`；路由 `deepseek-official` / `deepseek-flash`。
- **探针**：`test/p0/teardown/`（`dsh-obsidian-mem-teardown-probe`，丢弃式，不随插件发布）+ 断言/运行脚本 `test/p0/run-teardown-probe.mjs`。

### 9.1 方法与复现命令

在隔离 `DSH_HOME`（`mktemp -d`，用完删除）里从随包 `headless` 模板派生 profile `mem-teardown`，把探针以 `link:` 装入，跑一轮真实 headless 会话：

```sh
node test/p0/run-teardown-probe.mjs          # 自建临时 home、装 link:、跑一轮、打印记录并断言 13 条
node test/p0/run-teardown-probe.mjs --keep    # 保留临时目录以便人工查看
```

凭据按 §1 的路由只进子进程环境（`DEEPSEEK_API_KEY`），从不打印、从不落盘。记录只含标签、服务可见性、provider fiber 名称/状态、块计数、终止 `finish.reason.kind`/`failure.code` 与耗时；**不含** prompt、响应、推理正文、笔记正文或凭据。断言脚本在任一契约不成立时非零退出。

探针做四件事：

1. 每个 `session/flush`、`agent/session-start`、`agent/pre-step`、以及一个每 500 ms 的 `setInterval` 里记录 `ctx.get(name)` 与 `ctx.get(name, false)` 的结果、服务提供者 fiber 的名称/状态、以及该 ctx 的 isolate key；
2. 在 `agent/pre-step` 里做一次**在处理器内**的对照调用（§8.3 的成功路径）；
3. 在 plugin boot 时按 `createQueueWorker` 的形状做一次 boot pass，并挂一个 1000 ms 的**裸定时器**，在存活窗口内发起一次调用；
4. 用**两个**只在"谁可以取消它"上不同的调用跨越处置窗口：一个 compose 了 worker 形状的 `AbortController`（其 disposer 会 `abort()`），一个没有任何我们 abort 的 signal。

### 9.2 原始记录（字段级，脱敏）

```jsonl
{"t":254,"rec":"apply","dshHomeIsTemp":true}
{"t":255,"rec":"vis","label":"apply","pluginFiber":"LOADING","llm":{"strictHas":false,"looseHas":false,"providerFiber":null,"isolateKey":"none"}}
{"t":255,"rec":"boot-pass","strictHas":false}
{"t":404,"rec":"vis","label":"flush","seq":3,"pluginFiber":"ACTIVE","llm":{"strictHas":true,"looseHas":true,"providerFiber":"LlmRuntime","providerState":"ACTIVE","isolateKey":"Symbol(llm)"}}
{"t":1029,"rec":"llm","label":"in-handler-control","chunks":35,"usageFields":5,"finishKind":"max-tokens","ms":606}
{"t":1255,"rec":"vis","label":"boot-timer-fires","pluginFiber":"ACTIVE","llm":{"strictHas":true,"providerFiber":"LlmRuntime","providerState":"ACTIVE"}}
{"t":1691,"rec":"llm","label":"bare-timer-live-window","chunks":24,"finishKind":"stop","ms":435}
{"t":2343,"rec":"vis","label":"turn-end","pluginFiber":"ACTIVE","llm":{"strictHas":true,"providerFiber":"LlmRuntime","providerState":"ACTIVE"}}
{"t":2344,"rec":"capture","hasHandle":true,"hasAgentHandle":true}
{"t":2885,"rec":"disposer","workerControllerAbortedBefore":false}
{"t":2888,"rec":"llm","label":"live-window-worker-signal","chunks":325,"finishKind":"aborted","failureCode":"ABORTED","failureMessage":"DeepSeek request aborted by caller","ms":2484,"finishedAt":2888,"callerAbortedAtFinish":true}
{"t":2889,"rec":"vis","label":"interval","pluginFiber":"DISPOSED","llm":{"strictHas":false,"looseHas":false,"providerFiber":null,"isolateKey":"Symbol(llm)"}}
{"t":3346,"rec":"llm","label":"post-run-fresh-lookup","chunks":0,"reason":"no-service"}
{"t":3347,"rec":"llm","label":"post-run-captured-handle","chunks":1,"finishKind":"error","failureCode":"NO_ADAPTER","failureMessage":"no adapter registered for provider \"deepseek-official\""}
{"t":7595,"rec":"llm","label":"live-window-private-signal","chunks":1504,"usageFields":5,"finishKind":"max-tokens","ms":7190,"finishedAt":7595,"callerAbortedAtFinish":false}
```

断言脚本输出（同一份记录）：

```
  PASS service-is-live-with-an-active-provider-fiber — label=flush provider=LlmRuntime/ACTIVE isolateKey=Symbol(llm)
  PASS in-handler-call-is-a-real-answer — finish=max-tokens chunks=35 ms=606
  PASS bare-timer-in-the-live-window-is-a-real-answer — finish=stop chunks=24 ms=435
  PASS the-tree-is-disposed-at-the-end-of-the-run — disposer t=2885; after it, ctx.get('llm') strict=false loose=false at t=2889
  PASS an-in-flight-stream-survives-the-disposal — finish=max-tokens ms=7190 finishedAt=7595 (disposer t=2885)
  PASS the-worker-signal-disposer-abort-is-what-produces-aborted — finish=aborted failureCode=ABORTED callerAbortedAtFinish=true finishedAt=2888 (disposer t=2885)
  PASS no-lookup-path-works-after-the-disposal — fresh=no-service/- captured=error/NO_ADAPTER
run-teardown-probe: OK (13 assertion(s))
```

### 9.3 三个候选解释的判定

| 候选 | 判定 | 反证 |
|---|---|---|
| (a) 服务只在事件处理器内解析，所以要"在存活事件里捕获 handle 再交给 worker" | **否证** | 解析不依赖调用点：`apply`/boot 时 `isolateKey:"none"`（服务还没被 provide），此后任何调用点（`session/flush`、裸定时器）都解析成功；反过来处置后**严格与非严格** `ctx.get('llm')` 都是 `false`，而此时**在存活窗口捕获的同一个 handle** 调用得到 `NO_ADAPTER`（adapter 注册表随卸载清空）。→ 捕获 handle **不能**跨越处置，也没有"ctx.get 失效但 handle 仍活"的窗口 |
| (b) 调用必须运行在拥有该作用域的 Cordis invocation/fork 内 | **否证** | 裸定时器（任何 Cordis invocation 之外）在存活窗口内返回 `stop`；`finish.kind='aborted'` 只在**disposer 调用了我们自己的 `controller.abort()`** 的那 3 ms 内出现（`callerAbortedAtFinish:true`） |
| (c) 宿主**卸载 ≠ 调用方取消**（其余为实测事实） | **成立** | 在飞的流**不被处置杀死**（7190 ms 的流在 `DISPOSED` 后 4.7 s 正常收尾）；被杀死的是我们自己的 abort |

因此 Task 18 记录的 `aborted: distill-finish:aborted (aborted)` / `lastError.code='aborted'` 的成因是：**队列 worker 在插件卸载时 `controller.abort()`，把宿主的生命周期卸载翻译成了"调用方取消"**，于是 `distill.js` 以终止块判定为失败、R43 记一次失败尝试并最终终态 `failed`——即"边界失败、可查可重试"的词汇是对的，但**原因不真实**，而且被消耗的是从未发生过的模型失败。

### 9.4 对设计与后续任务有约束力的推论

1. **`ctx.get()` 的可见性 = 提供者 fiber 的状态**。`ctx.get(name, false)`（非严格）也救不了场：处置时 `store[key]` 被注销，`isolateKey` 还在但 impl 已经没了。任何"缓存/捕获服务引用以便稍后使用"的设计都必须先回答"这个引用会不会跨过一次卸载"——本机实测答案是**会失效**。
2. **生命周期卸载（fiber disposer / 插件卸载 / `agent/disposed`）不是调用方取消。** 把卸载翻译成 `finish.kind='aborted'` 会把宿主生命周期记成模型失败，消耗 R43 的尝试上限。插件侧的正确形状是：卸载时**停止调度**，让在飞调用自然收尾（或由进程退出把它留给下一次恢复），只有真正的取消才 `abort()`。
3. **在飞的 `llm.stream()` 会跨过插件树处置继续产出**（本机 7190 ms，处置后 4.7 s 收尾）。因此"让在飞调用自然收尾"是可行的；但**进程退出**仍会丢失它——此时 job 保持 `pending`，由下一次恢复接手（这是既有的崩溃契约）。
4. **一次 headless 运行在 turn 结束后的存活窗口只有秒级**（本机 `turn-end` → disposer ≈ 2.4–3.4 s，且 disposer 之前定时器会被推迟）。因此"回合结束后再等一个 debounce/backoff 才发起的模型调用"在一次性运行的宿主里**必然赶不上**；能完成的路径只有"存活窗口内发起 + 不在卸载时自杀"。
5. **处置之后 `services.close()` 已经跑过**（`lib/tools.js` 的 fiber effect）。此时仍可能发生的 apply 是纯文件工作（事务引擎、receipt、floor、job 删除），索引刷新会重新打开一个 handle 并在进程退出时释放；索引刷新失败只记在 receipt 的 `index` 字段上，绝不回滚已提交的 vault 事务（既有约束 6）。
6. 本节的**非**结论：本机没有测"多帧持久日志恢复"、"Obsidian GUI"、"跨进程锁竞争"；也不给跨环境结论——本节只声明本机测量。

### 9.5 安全与清理

- 凭据只走环境路由；仓库与记录对凭据值及其 4 字符前缀 0 命中（探针不打印任何凭据，`run-teardown-probe.mjs` 的断言含真实 home 指纹、`~/.dsh/data` 不存在、`~/.dsh/skills` 只有 `ultramath`、`~/Documents/dsh-memory` 不存在）。
- 临时 home/vault/repo 全在系统临时根下，默认跑完即删（`--keep` 才保留）；真实 `~/.dsh` 只读。
- 记录与本节不含 prompt、响应、推理正文、笔记正文；模型输出的正文从不落盘。

### 9.6 追加实测推论（Task 18b 评审后）：settling pass 只能"收尾一个 job"

9.4 的第 2 条只说"卸载时停止调度、让在飞调用收尾"，不足以描述**一次 pass 里有多个到期 job** 的情形：`processQueue` 在 pass 开始时**快照一次** `llm`（`lib/capture.js` 的 `pass()`），随后 `runQueuePass` 会**遍历所有到期 job**。处置之后这个快照已经死了（§9.2 的 `post-run-captured-handle` → `finish=error` / `failure.code=NO_ADAPTER`），而 `distill.js` 的 `hasRoute()` 只检查"服务对象有 `stream` 且路由非空"，因此它**仍然接受**这个死 handle，调用立刻得到 `NO_ADAPTER` 终止块 → 记一次**模型从未产生的失败尝试**，并在 `maxRetries` 后把 job 打成终态 `failed`。

实测复现（真实 `createQueueWorker` + 真实 `processQueue`，只把"处置后的 handle"按 §9.2 的实测形状 stub）：队列里两个到期 job 时，旧形状 `stop()` → **2 次模型调用**、第二个 job 拿到 `{attempts:1, code:'no-adapter'}`；而旧的 `abort()` → 1 次调用、第二个 job `{attempts:0}`。也就是说"不许消耗 R43 上限"这条保证在旧形状下**只对第一个 job 成立**。

因此宿主事实的完整形状是：**一旦插件树开始处置，这次 pass 只能收尾它已经开始的**那一个** job**；其余到期 job 必须**推迟**（`reason='unloaded'`）并且**不写 job 文件、不消耗尝试**，留给下一次进程。实现就是把 `isStopped: () => stopped` 交给 `processQueue`，并在 job 循环顶部检查（`lib/capture.js`）；回归用例 `test/auto-capture.test.js` 的 `a pass that outlives the plugin tree defers the rest of the queue instead of failing it (Task 18b)`（修正前 RED：`2 !== 1`）。
