# 独立 profile 冒烟实测（Task 18 / Task 18b / 终修波）

- **日期**：2026-09-24
- **状态**：验收脚本 **25/25 通过**；负控 **11/11** + 正控 **1/1** 通过；**1 项未验证**（Obsidian GUI，见 §5）。**同样的 25/25 在 DSH `0.1.7-rc.2`（会话格式 v4）上复现**，见 §7
- **被测环境**：DSH `0.1.5-rc.2`；Node `v25.9.0`；`darwin arm64`；蒸馏路由 `deepseek-official` / `deepseek-flash`
- **产物**：`test/smoke/`（runner + checker + 负控 + 驱动插件）、`test/smoke/records/smoke-record.json`（Task 18 的**修正前**冻结记录）、`docs/p0-compatibility.md` §9（Task 18b 定位到的宿主事实）
- **计划要求**：`docs/superpowers/plans/2026-09-23-dsh-obsidian-mem-implementation.md` Task 18

> 本文件只记录**观察到的事实**：版本、计数、哈希、事件/seq 号与 PASS/未验证。不含任何提示词、模型输出正文、笔记正文或凭据。
>
> **Task 18b 的变化**：Task 18 时"完成回合 → 真实模型蒸馏 → 自动写笔记"这条主路径在本环境**未验证**——queue worker 自己的模型调用每次都得到终止块 `finish.reason.kind='aborted'`。原因已定位并修复（`docs/p0-compatibility.md` §9：DSH 在会话跑完后立即处置整棵插件树，而 worker 的 disposer 把自己的卸载翻译成了"调用方取消"，`controller.abort()` 把在飞的流终止成 `aborted`）。修复后本节记录的主路径**已由真实冒烟验证**（§3 的 `model-lane-*` 两行，checker 计分）。

## 1. 方法

在临时 `DSH_HOME` 下（`mkdtemp`，用完删除）从随包 `headless` 模板创建 profile `smoke`，把本仓库与一次性驱动插件 `test/smoke/driver` 以 `link:` 装入，然后跑真实的 headless 会话：

```sh
node test/smoke/run-smoke.mjs --out /tmp/dshsmoke-final4.json
node test/smoke/verify.mjs /tmp/dshsmoke-final4.json        # 独立重算 vault 事实后才判定
node test/smoke/negative-controls.mjs /tmp/dshsmoke-final4.json
```

下文引用的数字来自**终修波在最终 runner + 最终 checker 下的独立运行**（`/tmp/dshsmoke-final4.json`，2026-09-24）。Task 18b 的三次运行（`/tmp/dshsmoke-fix.json`、`/tmp/dshsmoke-fix2.json`、`/tmp/dshsmoke-fix3.json`）在**同样 25/25** 下给出同样结论；终修波新增的 `--only` 证据见 §2.1。

`verify.mjs` 只把**显式带 `skipped: true`**（由 `--only` 分支写入，终修波起由 runner 投影进 `capture.modelLane.*`）的通道当作"未运行"；一条**真的跑了但没有捕获到任何 job**（`jobId` 为 null 且无该标记）的通道是**失败**——acceptance 不允许在"什么都没捕获"时通过。终修波补上两个方向：**通道整个缺失**（记录里没有 `capture.modelLane`，或少了某条 channel）同样是**失败**，因为"没有证据"不是证据；显式的 `skipped: true` 仍然通过。负控 `model-lane-captured-nothing`、`model-lane-absent`、`model-lane-absent-at-the-top` 与正控 `model-lane-explicitly-skipped` 就是这两条断言的守卫。

驱动插件通过 `ctx.tools.get(name).execute(args, exec)` 调用**插件自己注册的六个 `mem_*` 工具**（与模型调用的是同一批定义），只记录收据、路径、id、状态、计数与哈希。

两条通道：

- **模型通道（主路径，checker 计分）**：真实完成回合 → 捕获为 durable pending job → 在"job 已 fsync"边界 `SIGKILL` → 重启 → **真实 worker 用真实模型调用完成蒸馏并 apply**。这就是设计里 queue 存在的理由（跨进程至少一次），`verify.mjs` 以 `model-lane-dry-run-real-distill` / `model-lane-live-real-distill` 两条断言计分：receipt 的 `result` 正确、`attempts === 0`、`usage.outputTokens > 0`、`durationMs > 0`，且 dryRun 通道零写入、live 通道有写入。
- **恢复通道（故障注入）**：同样捕获并 `SIGKILL`，但重启前把 job 的 `output` 改写为设计文档定义的 `raw-durable`（"字节已 durable，重新校验即为恢复路径"），由**真实 worker 在真实进程里**完成 apply，全程不调用模型。它是 apply 半段的干净证据，在记录里逐字标注（`capture.*Injection`），不得被读成"验证了真实模型调用"——模型半段由上面那条通道单独计分。

两条通道互补：模型通道证明"真实模型调用 + 真实蒸馏 + 真实写入"，恢复通道证明"没有模型调用时 apply 仍然正确、幂等、不重复"。

驱动插件的 referenced interval 是必需的：DSH 在会话跑完后立即处置插件树（`docs/p0-compatibility.md` §9），一次性 headless 进程需要被**引用计时器**留住，在飞的模型调用才有时间收尾；否则 job 保持 `pending`，由下一次进程接手（既有崩溃契约）。

**本次的运行记录（`/tmp/dshsmoke-fix.json`、`/tmp/dshsmoke-fix2.json`、`/tmp/dshsmoke-fix3.json`）不提交**：它现在包含模型自己生成的笔记标题与由标题派生的路径（主路径真的写了笔记），而本仓库不提交模型输出或会话正文。提交的 `test/smoke/records/smoke-record.json` 仍是 **Task 18 的修正前冻结记录**（其内容不含模型正文），作为"无模型 apply 半段"的对照证据保留。

## 2. 检查器结果（原始输出）

```
verify: /tmp/dshsmoke-final4.json
  versions: dsh=0.1.5-rc.2 node=v25.9.0 obsidian=(not supplied; GUI checks unverified)
  PASS plugin-row-in-dump-config — dump-config has "- id: obsidian-mem": true (11208 chars)
  PASS plugin-row-line-recorded — - id: obsidian-mem
  PASS brief-injected-exactly-once — firstStepBriefCount=1 (session total 1)
  PASS brief-not-repeated-later — sessionBriefCount=1
  PASS brief-within-budget — 109 code points <= 6000
  PASS chinese-search-hit — queryChars=4 hitCount=1 matchedDocPath=true
  PASS document-write-on-disk — 项目/repo--32f56b1f/文档/冒烟文档：中文检索目标.md
  PASS supersede-chain-correct — old=dec-a90b1e96-7af3-4ec6-8af5-56fc652ae946 status=superseded superseded_by=dec-94d99d6d-beab-450e-9020-cb54ddaae7b8 defaultHasOld=false historyHasOld=true
  PASS interrupted-process-was-killed — killedBy=SIGKILL jobId=job-927547faa187e4322b3aac494df2bac0 injected=raw-durable
  PASS restart-recovered-exactly-once — result receipts for job-927547faa187e4322b3aac494df2bac0: 1 (total 4)
  PASS restart-live-apply-succeeded — live receipt: applied dryRun=false
  PASS restart-wrote-to-the-vault — vault changed across the live restart: true (receipt applied)
  PASS no-duplicate-note-ids — duplicate ids: []
  PASS dry-run-wrote-nothing — dry-run receipt: dry-run vaultChanged=false
  PASS model-lane-dry-run-real-distill — result=dry-run attempts=0 outputTokens=419 durationMs=2101 vaultChanged=false
  PASS model-lane-live-real-distill — result=applied attempts=0 outputTokens=216 durationMs=1568 vaultChanged=true
  PASS external-edit-survived — path=项目/repo--32f56b1f/文档/外部编辑目标文档.md humanLineSurvived=true onDiskAfterAllPasses=true
  PASS human-owned-file-byte-identical — path=项目/repo--32f56b1f/约定/人写的约定.md update=human-owned supersede=human-owned byteIdentical=true
  PASS read-only-lint-never-writes — findings=2 treeUntouched=true
  PASS real-dsh-home-unchanged — real ~/.dsh fingerprint unchanged: true
  PASS frontmatter-parses-under-yaml-v2 — 21 notes parsed
  PASS tags-is-a-list — 18 notes carry a tags list
  PASS date-fields-are-iso-days — 34 date fields shaped YYYY-MM-DD
  PASS wikilinks-resolve — 17 wikilinks resolved by path or basename
  PASS obsidian-directory-untouched — externalEdit.obsidianUntouched=true
  UNVERIFIED Obsidian GUI checks (rendered tag list, date property, clickable wikilink): the vault was never opened in Obsidian
verify: OK (25 checks, 21 vault notes)      # exit=0
```

`test/smoke/negative-controls.mjs` 逐条破坏一个验收条件并断言检查器非零退出，另有一条正控断言显式 `skipped: true` 仍然通过：

```
negative-controls: clean record exit=0 (expected 0)
  PASS plugin-row-missing -> verify exit=1
  PASS duplicate-brief -> verify exit=1
  PASS over-budget-brief -> verify exit=1
  PASS no-chinese-hit -> verify exit=1
  PASS wrong-supersede -> verify exit=1
  PASS pending-restart-duplicate -> verify exit=1
  PASS external-edit-overwritten -> verify exit=1
  PASS model-lane-lost-its-receipt -> verify exit=1
  PASS model-lane-captured-nothing -> verify exit=1
  PASS model-lane-absent -> verify exit=1
  PASS model-lane-absent-at-the-top -> verify exit=1
  PASS model-lane-explicitly-skipped -> verify exit=0
  PASS refuses-personal-vault-path -> verify exit=2
negative-controls: OK (11 negative controls, 1 positive control)   # exit=0
```

### 2.1 `--only` 的 skip 通道（终修波新增证据）

`--only dryRun` 让 dry-run 通道真跑、live 通道不跑。此时 runner 必须把 `skipped: true` 投影进记录，checker 才分得清"没跑"与"跑了但什么都没捕获"。同一份 `--only dryRun` 记录，修正前/后的 checker 只差这一条：

```
# 终修波（runner 投影了 skipped；checker 认 sentinel）
  PASS model-lane-dry-run-real-distill — result=dry-run attempts=0 outputTokens=406 durationMs=2125 vaultChanged=false
  PASS model-lane-live-real-distill — the live lane carries the runner's explicit skipped: true (--only); nothing to verify
verify: 4 FAILED (25 checks, 19 vault notes)      # exit=1

# 修正前（runner 丢掉 skipped；checker 把它当成"跑了却没捕获"）
  PASS model-lane-dry-run-real-distill — result=dry-run attempts=0 outputTokens=411 durationMs=2042 vaultChanged=false
  FAIL model-lane-live-real-distill — no job was captured on this lane, so there is nothing the worker could have distilled
verify: 5 FAILED (25 checks, 19 vault notes)      # exit=1
```

两边的 4 条共同 FAIL 是 `--only` 的固有结果（live 的恢复通道没跑，所以 `interrupted-process-was-killed` / `restart-recovered-exactly-once` / `restart-live-apply-succeeded` / `restart-wrote-to-the-vault` 无从判定）——`--only` 只选模型通道，不是一次全绿运行；差别只在那条 model-lane 断言：修正前一条合法的 `--only` 运行会**失败一条从未运行的通道**，修正后该通道以 sentinel 记为 pass。

`npm test`：**566/566 通过**（`node scripts/run-tests.mjs`；Task 18 之后新增 18b 的 3 条与终修波的 8 条）。

## 3. 逐项证据

| 检查项 | 结论 | 证据（原始观察） |
|---|---|---|
| 插件 row 装配 | PASS | `--dump-config` 含 `- id: obsidian-mem`（11208 字符的合成配置）；`profile.bundles` 含 `dsh-obsidian-mem` |
| 首轮简报恰好一次 | PASS | 第一步内、首个 `request/header` 之前提交的插件 recall 消息数 = 1（会话总数 1） |
| 简报不超预算 | PASS | 109 码点 ≤ `briefBudgetChars` 6000 |
| 中文检索命中 | PASS | `mem_search`（4 字查询）命中写入的文档路径，`hitCount=1` |
| 文档写入 vault | PASS | `项目/<slug>/文档/冒烟文档：中文检索目标.md`，frontmatter 可被 `yaml` v2 解析 |
| 取代链 | PASS | 旧笔记仍在，`status=superseded`、`superseded_by` = 新 id；默认检索不再返回旧笔记，`includeHistory:true` 返回 |
| 完成回合被捕获 | PASS | 真实 `turn/end:completed` → 恰好一个 pending job 落盘（`fromSeq=4,toSeq=19`，`route` 非空） |
| 进程中断 | PASS | 驱动在 job 文件出现后 `process.kill(pid,'SIGKILL')`；子进程退出信号 = `SIGKILL` |
| **主路径：真实模型蒸馏** | **PASS** | 模型通道两轮各自的 receipt（字段级）：dryRun 轮 `result=dry-run`、`dryRun=true`、`attempts=0`、1 个 item（`type=convention`）、`outputTokens=419`、`durationMs=2101`、`index=none`、`refusedCount=0`、无 `lastError`；live 轮 `result=applied`、`dryRun=false`、`attempts=0`、1 个 item（`type=decision`）、`outputTokens=216`、`durationMs=1568`、`index=refreshed`、`refusedCount=0`、vault 树跨重启发生变化。两轮 `holdReceipt=true`（驱动在 hold 窗口内看到 receipt）。四次独立运行的 token 计数与耗时不同（`415/2257`、`267/1840`；`409/2178`、`186/1312`；`419/2101`、`216/1568`），结论相同 |
| 验收器不 fail-open | PASS | 终修波前：`capture.modelLane` 缺失时两条 `model-lane-*-real-distill` 都记 PASS（负控 `model-lane-absent` / `model-lane-absent-at-the-top` 对修正前 checker 退出 0，即**没抓住**）；终修波后两者都退出 1，显式 `skipped: true` 的正控仍然退出 0。同一份真实 `--only dryRun` 记录在修正前会额外 FAIL 一条从未运行的通道（见 §2.1） |
| 对照探针（in-context） | PASS | 驱动在首个 `agent/pre-step` 内的 `ctx.get('llm').stream()`：`finish=stop`、23 chunks、414 ms——与主路径同路由、同凭据的独立对照 |
| 重启恢复不重复 | PASS | 恢复通道的 job 其 result receipt 恰好 1 份；vault 内无重复 note id（21 篇） |
| dryRun 零写入 | PASS | receipt `result=dry-run`、`dryRun=true`；重启前后 vault 树哈希映射**完全相同** |
| 自动写入（临时 vault） | PASS | receipt `result=applied`；模型通道的 live 轮写入 1 篇 `决策/ADR-*.md`（21 篇笔记中的一篇），恢复通道的 live 轮写入 `约定/恢复通道约定（live）.md`；两者都更新 `index.md` 与 `_meta/log.md` |
| 外部编辑存活 | PASS | 插件自有笔记被外部追加一行后，取代写入后该行仍在磁盘上 |
| 人工文件零覆盖 | PASS | 手写 `trust: owner` 笔记在 `mem_write(id=…)` 与 `mem_write(supersedes=…)` 后两次哈希不变，拒绝码均为 `human-owned` |
| 只读 lint 零写入 | PASS | `readOnly=true`，findings=2，前后全树哈希相同 |
| Obsidian 文件事实 | PASS | 21 篇笔记 YAML 可解析；18 篇 `tags` 为列表；34 个日期字段为 `YYYY-MM-DD`；17 个 wikilink 按路径或 basename 解析成功 |
| `.obsidian/` 未被触碰 | PASS | 运行前后 `.obsidian/` 全树哈希相同 |
| 真实 home 未被写入 | PASS | 见 §4 |
| Task 18b 回归（离线） | PASS | `test/auto-capture.test.js` 三条：① `a host unload mid-call lets the job finish instead of reporting a caller abort (Task 18b)`（RED：`summary.completed 0 !== 1`，job 被记 `lastError.code='aborted'`；GREEN：receipt `applied`、note 落盘、`attempts` 不增长）；② `a pass that outlives the plugin tree defers the rest of the queue instead of failing it (Task 18b)`（两个到期 job：RED `llm.calls 2 !== 1`；GREEN 只调用 1 次、第二个 job 以 `deferred/unloaded` 推迟、`attempts=0`、`lastError` 未写、job 文件保持 `pending`）；③ `an explicit worker.abort() still cancels an in-flight model call`（真正的取消仍然是被记账的中止） |
| Task 18b 宿主事实（隔离探针） | PASS | `node test/p0/run-teardown-probe.mjs` → `OK (13 assertion(s))`；见 `docs/p0-compatibility.md` §9 |

## 4. 安全与隔离（硬约束逐条）

- **真实 `~/.dsh` 逐字节不变**：本次运行前后 `~/.dsh` 的 `cordis.patch.yml`、`settings.yaml`、`.credentials.yaml`、`profiles/**` 指纹完全一致（`checks.realHomeUnchanged=true`；`docs/p0-compatibility.md` §9 的探针也断言同一件事）。
- **`~/.dsh/data` 不存在**：插件的数据根始终解析到临时 `DSH_HOME`（`resolveDataRoot()` 只认 `DSH_HOME`），真实 home 下从未出现 `data/`。
- **`~/.dsh/skills` 只有 `ultramath`**：插件自带的技能只同步进临时 home（`obsidian-mem` 未落进真实 skills 目录）。
- **`~/Documents/dsh-memory` 不存在**：配置里的 `vaultPath` 一直是临时 vault，默认路径从未被创建。
- **凭据只走子进程环境**：`DEEPSEEK_API_KEY` 从环境或 `~/.dsh/.credentials.yaml` 的 `refs` 读出后只注入子进程 `env`；从不打印、不写进临时 home、不写进记录。
- **无真实会话正文入库**：驱动只记录元数据；stderr 只记字节数（DSH 会把模型推理打到 stderr）。修复后的运行记录**不提交**，因为它包含模型生成的笔记标题与路径；提交的冻结记录仍是修正前那份（不含模型正文）。
- **提交卫生**：Task 18b 改动 `lib/capture.js`、`lib/hooks.js`、`test/auto-capture.test.js`、`test/smoke/{run-smoke,verify,negative-controls}.mjs`、`test/p0/teardown/**`、`test/p0/run-teardown-probe.mjs`、`docs/{p0-compatibility,smoke-results}.md`、`README.md`、`CHANGELOG.md`；终修波只再动 `test/smoke/{run-smoke,verify,negative-controls}.mjs` 与 `docs/smoke-results.md`（外加与冒烟无关的 `lib/`、`test/`、README/CHANGELOG/dogfood 修正，见终修波报告）；仓库内对凭据值及其 4 字符前缀 0 命中。

## 5. 未验证项（明确不作为 PASS）

1. **Obsidian GUI 行为。** 本环境未打开 Obsidian，因此"`tags` 渲染为属性列表""日期字段显示为 Date 属性""路径限定双链可点击"三项**未验证**。可验证的文件系统一半（YAML/列表/日期形状/双链解析/`.obsidian/` 未动）已由 `verify.mjs` 在磁盘上真实验证。
2. **一次性进程内的自动 apply（同一个会话里捕获、同一个会话里落盘）。** 模型通道按设计在"job 已 durable"边界 `SIGKILL`，所以捕获它的那个进程里看不到 apply；而新捕获的 job 受 `captureIdleMs`（冒烟配置 15 s，默认 90 s）的合并窗口约束，一次性 headless 运行在窗口到期前就已经结束（`inProcessApplied.anySeedSawAnAttempt=false`）。因此这条**未验证**，但它的成因不再是"worker 的调用会失败"：
   - 在**长期存活的宿主**（例如 GUI 服务进程）里，窗口到期时插件树仍在，worker 的定时器正常发起调用；修复后即使那一刻恰好遇到插件树卸载，在飞的调用也会自然收尾（`docs/p0-compatibility.md` §9）。
   - 在**一次性 `dsh "…"` 运行**里，进程在 job 到期前退出，job 保持 `pending`，由**下一次进程**接手——这正是 queue 的至少一次契约。
3. **重启后的即时恢复（跨进程补扫持久会话日志）**未验证：本文件只证明存活进程内 `session/flush` 可补扫（`docs/p0-compatibility.md` §2/§3.2），不据此收紧保证。

## 6. 剩余风险

- **一次性运行的时序窗口只有秒级**（本机 `turn-end` → 插件树 disposer ≈ 2.4–3.4 s）。因此"回合结束后再等一个 debounce/backoff 才发起的模型调用"在一次性运行的宿主里赶不上；能否在**同一进程**内完成取决于宿主是否在 job 到期前仍然存活。这是宿主的生命周期事实，不是模型或插件接线问题；插件侧的保证仍是"pending fsync 后至少一次"。
- **在飞调用依赖进程存活。** 插件树卸载不会杀掉在飞的 `llm.stream()`（实测 7190 ms 的流在 `DISPOSED` 后 4.7 s 正常收尾），但**进程退出会**；此时 job 保持 `pending`，由下一次恢复接手。
- **卸载之后仍可能发生一次 apply**（在飞调用收尾之后）。它是纯文件工作（事务引擎、receipt、floor、job 删除），索引刷新会重新打开一个 handle 并在进程退出时释放；索引刷新失败只记在 receipt 的 `index` 字段，绝不回滚已提交的 vault 事务。未测"卸载后 apply 期间再次 SIGKILL"的窗口。
- `distill` 的调用契约（`docs/p0-compatibility.md` §8.3）与本次的卸载语义对**别家部署**是否同样成立，本文件不给跨环境结论，只给本机测量。
- 提交的 `test/smoke/records/smoke-record.json` 是 Task 18 的**修正前**冻结记录：它在仓库里，所以 `verify.mjs` 直接以 exit 2 拒绝（"the run record must be a temporary path"）；复制到 `/tmp` 也会因临时 vault 已删除而以 exit 2 拒绝（"the temporary vault is gone"）。即使 vault 还在，它也会**故意失败**新的 `model-lane-*-real-distill` 两条断言——因为它正是"模型通道没有 receipt"的那份修正前证据。它的价值在于保存了"无模型 apply 半段"的原始树哈希与 receipt。
- 外部编辑器不受锁约束、凭据扫描不能穷尽未知格式、未入队崩溃窗口——与设计文档一致，未因本次冒烟而收紧。

## 7. 在 DSH `0.1.7-rc.2`（会话格式 v4）上复跑（Task 19）

- **日期**：2026-09-25
- **被测环境**：DSH `0.1.7-rc.2`；Node `v25.9.0`；`darwin arm64`；同一条蒸馏路由
- **命令**：

```sh
node test/smoke/run-smoke.mjs --out /tmp/smoke-017rc2.json --timeout-ms 300000
node test/smoke/verify.mjs /tmp/smoke-017rc2.json
```

- **结果**：`verify: OK (25 checks, 21 vault notes)`，退出码 0。与 §2 的 25/25 同一套断言，无一条因换宿主而变。
- **本次要证的那一条**：`PASS brief-injected-exactly-once — firstStepBriefCount=1 (session total 1)`（配 `PASS brief-not-repeated-later — sessionBriefCount=1`）。这是会话格式 v4 的 **source 准入**在真实宿主上的端到端证据：注入消息现在带 `{kind:'plugin:obsidian-mem', form:'recall'}`，走的是 v4 里**写前那道 gate**——也就是升级后把每个回合打成 `format v4 message requires a producer-owned source kind` 的同一道 gate。0.1.7 宿主接受了它，回合跑完，驱动观测到 1 条简报且只有 1 条。定位与逐例实测见 `docs/p0-compatibility.md` §10。
- **其余关键事实**：`plugin-row-in-dump-config` 通过（`dump-config` 12240 字符，0.1.5 线上是 11208——宿主自身变长，与插件无关）；模型通道两轮真实蒸馏 `outputTokens=204` / `234`、`durationMs=1639` / `1661`、`attempts=0`（`dry-run` 零写入 / `applied` 有写入）；`restart-recovered-exactly-once`、`interrupted-process-was-killed`（`injected=raw-durable`）、`read-only-lint-never-writes`、`real-dsh-home-unchanged=true` 全部照旧通过。
- **未验证项不变**：§5 的三项（Obsidian GUI、一次性进程内的自动 apply、跨进程即时补扫）在 0.1.7 上同样未测，不因本次复跑而收紧。
- **记录不提交**：`/tmp/smoke-017rc2.json` 与 §1 同因——它含模型自己生成的笔记标题与派生路径。`test/smoke/records/smoke-record.json` 仍只有那份 Task 18 的修正前冻结记录。
- **本次改动的提交面**：`lib/hooks.js`（`RECALL_SOURCE`）、`lib/capture.js`（仅一条注释：示例 kind 由 `plugin` 改为 `plugin:<name>`）、`test/hooks.test.js`、`test/lint.test.js`、`test/smoke/driver/index.js`（驱动侧把期望写成字面量 `plugin:obsidian-mem`）、`test/p0/run-v4-source-probe.mjs`（新增，证据探针，`files` 白名单不含 `test/`，不进包）、`docs/{p0-compatibility,smoke-results}.md`、`CHANGELOG.md`。全部测试 **573 通过 / 0 失败**；`npm run prepack`（含 `verify-pack`）与 `npm pack --dry-run --ignore-scripts`（33 个文件，零 `test/` 条目）均通过。

## 8. 在 `tools.js` 拆分与诊断通道之后复跑（2026-09-25，`ca286a7`）

- **被测环境**：DSH `0.1.7-rc.2`；Node `v25.9.0`；`darwin arm64`；同一条蒸馏路由。
- **为什么跑**：本仓库唯一能回答"它作为**挂载的 DSH 宿主插件**还能用吗"的检查就是这一套。本轮改了 `lib/tools.js` 的模块边界（拆成 `tool-schema` / `tool-registry` / `services` 加一个门面）和捕获/蒸馏/索引/事务的写入点，两处都不在 `node --test` 的覆盖范围内：前者由两个入口的 import 决定，后者由真实 worker 决定。
- **命令与结果**：

```sh
node test/smoke/run-smoke.mjs --out /tmp/smoke-record-2026.json
node test/smoke/verify.mjs /tmp/smoke-record-2026.json          # verify: OK (25 checks, 21 vault notes)
node test/smoke/negative-controls.mjs /tmp/smoke-record-2026.json  # OK (11 negative controls, 1 positive control)
```

  三条退出码均为 0。逐项与 §2/§7 同一套断言，无一条因本轮改动而变；`UNVERIFIED` 仍只有 Obsidian GUI 一项。
- **本轮特有的关键事实**：简报 109 码点、恰好一次；中文文档写入后四字中文查询命中；`SIGKILL` 边界后 `restart-recovered-exactly-once`（该 job 恰好 1 条 receipt）、`no-duplicate-note-ids` 为空；两条模型通道都是真实蒸馏（dry-run 234 output tokens / live 278，`attempts=0`，dry-run 零写入、live 有写入）；外部编辑与 `trust: owner` 文件均逐字节存活；只读 lint 未动树；真实 `~/.dsh` 指纹前后一致。
- **记录不提交**，理由与 §1/§7 相同（含模型自拟标题与派生路径）。因此 `test/smoke/records/smoke-record.json` **仍**是 Task 18 的修正前冻结记录——它**不是**本节数字的证据。本节的证据是本节的命令与输出，以及 `CHANGELOG.md` 的 *Verified end to end* 条目。
- **顺带实测的 CI 等价项**：在 `git archive` 出来的干净树里、Node `22.22.2` 下执行 `npm ci`（lockfile 连两个可选 peer 一并装上，0 vulnerabilities）后跑 `npm run check`，退出码 0（627 tests / 0 fail，`verify-pack: OK`、`verify-tarball: OK`）。CI 工作流本身仍未在 GitHub 上跑过。
