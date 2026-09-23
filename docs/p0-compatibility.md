# P0 宿主兼容性实测（Task 1：隔离宿主探针与事件顺序）

- **日期**：2026-09-23
- **状态**：P0 实测记录（阻断门槛已关闭，结论见 §3）
- **被测环境**：DSH `0.1.5-rc.2`；Node `v25.9.0`；`Darwin 27.0.0 arm64`（macOS 27.0）
- **探针**：`test/p0/`（`dsh-obsidian-mem-probe`，丢弃式，不随插件发布）
- **断言脚本**：`test/p0/run-probe.mjs`
- **设计要求**：计划 `docs/superpowers/plans/2026-09-23-dsh-obsidian-mem-implementation.md` Task 1 Step 4

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
