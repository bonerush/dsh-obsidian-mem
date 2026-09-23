# 独立 profile 冒烟实测（Task 18）

- **日期**：2026-09-24
- **状态**：验收脚本 23/23 通过；3 项**未验证**（见 §5）
- **被测环境**：DSH `0.1.5-rc.2`；Node `v25.9.0`；`darwin arm64`；蒸馏路由 `deepseek-official` / `deepseek-flash`
- **产物**：`test/smoke/`（runner + checker + 负控 + 驱动插件）、`test/smoke/records/smoke-record.json`（脱敏后的冻结记录）
- **计划要求**：`docs/superpowers/plans/2026-09-23-dsh-obsidian-mem-implementation.md` Task 18

> 本文件只记录**观察到的事实**：版本、计数、哈希、事件/seq 号与 PASS/未验证。不含任何提示词、模型输出正文、笔记正文或凭据。

## 1. 方法

在临时 `DSH_HOME` 下（`mkdtemp`，用完删除）从随包 `headless` 模板创建 profile `smoke`，把本仓库与一次性驱动插件 `test/smoke/driver` 以 `link:` 装入，然后跑真实的 headless 会话：

```sh
node test/smoke/run-smoke.mjs --out /tmp/smoke-record.json
node test/smoke/verify.mjs /tmp/smoke-record.json          # 独立重算 vault 事实后才判定
node test/smoke/negative-controls.mjs /tmp/smoke-record.json
```

驱动插件通过 `ctx.tools.get(name).execute(args, exec)` 调用**插件自己注册的六个 `mem_*` 工具**（与模型调用的是同一批定义），只记录收据、路径、id、状态、计数与哈希。

两条通道：

- **模型通道**：真实完成回合 → 捕获为 durable pending job → 在“job 已 fsync”边界 `SIGKILL` → 重启恢复。
- **恢复通道**：同样捕获并 `SIGKILL`，但重启前把 job 的 `output` 改写为设计文档定义的 `raw-durable`（“字节已 durable，重新校验即为恢复路径”），由**真实 worker 在真实进程里**完成 apply，全程不调用模型。

第二条通道是**故障注入**，它在记录里逐字标注（`capture.*Injection`），不得被读成“验证了真实模型调用”。

## 2. 检查器结果（原始输出）

```
verify: OK (23 checks, 20 vault notes)
  PASS plugin-row-in-dump-config — dump-config has "- id: obsidian-mem": true (11208 chars)
  PASS brief-injected-exactly-once — firstStepBriefCount=1 (session total 1)
  PASS brief-within-budget — 109 code points <= 6000
  PASS chinese-search-hit — queryChars=4 hitCount=1 matchedDocPath=true
  PASS supersede-chain-correct — status=superseded superseded_by=<new id> defaultHasOld=false historyHasOld=true
  PASS interrupted-process-was-killed — killedBy=SIGKILL injected=raw-durable
  PASS restart-recovered-exactly-once — result receipts: 1
  PASS restart-live-apply-succeeded — live receipt: applied dryRun=false
  PASS restart-wrote-to-the-vault — vault changed across the live restart: true
  PASS no-duplicate-note-ids — duplicate ids: []
  PASS dry-run-wrote-nothing — dry-run receipt: dry-run vaultChanged=false
  PASS external-edit-survived — humanLineSurvived=true onDiskAfterAllPasses=true
  PASS human-owned-file-byte-identical — update=human-owned supersede=human-owned byteIdentical=true
  PASS read-only-lint-never-writes — findings=2 treeUntouched=true
  PASS real-dsh-home-unchanged — real ~/.dsh fingerprint unchanged: true
  PASS frontmatter-parses-under-yaml-v2 — 20 notes parsed
  PASS tags-is-a-list — 17 notes carry a tags list
  PASS date-fields-are-iso-days — 32 date fields shaped YYYY-MM-DD
  PASS wikilinks-resolve — 16 wikilinks resolved by path or basename
  PASS obsidian-directory-untouched
  UNVERIFIED the queue worker's own model-backed distill produced no receipt in this run; ...
  UNVERIFIED in-context llm.stream() probe: finish=stop ms=383 (the worker's out-of-context call is the one that aborts)
  UNVERIFIED Obsidian GUI checks ...: the vault was never opened in Obsidian
```

`test/smoke/negative-controls.mjs` 逐条破坏一个验收条件并断言检查器非零退出：

```
negative-controls: OK (7 negative controls)
  PASS plugin-row-missing -> verify exit=1
  PASS duplicate-brief -> verify exit=1
  PASS over-budget-brief -> verify exit=1
  PASS no-chinese-hit -> verify exit=1
  PASS wrong-supersede -> verify exit=1
  PASS pending-restart-duplicate -> verify exit=1
  PASS external-edit-overwritten -> verify exit=1
  PASS refuses-personal-vault-path -> verify exit=2
```

`npm test`：**522/522 通过**（`node scripts/run-tests.mjs`，全量回归未受本任务影响）。

## 3. 逐项证据

| 检查项 | 结论 | 证据（原始观察） |
|---|---|---|
| 插件 row 装配 | PASS | `--dump-config` 含 `- id: obsidian-mem`（11208 字符的合成配置）；`profile.bundles` 含 `dsh-obsidian-mem` |
| 首轮简报恰好一次 | PASS | 第一步内、首个 `request/header` 之前提交的插件 recall 消息数 = 1（会话总数 1），seq=10 |
| 简报不超预算 | PASS | 109 码点 ≤ `briefBudgetChars` 6000 |
| 中文检索命中 | PASS | `mem_search`（4 字查询）命中写入的文档路径，`hitCount=1` |
| 文档写入 vault | PASS | `项目/<slug>/文档/冒烟文档：中文检索目标.md`，frontmatter 可被 `yaml` v2 解析 |
| 取代链 | PASS | 旧笔记仍在，`status=superseded`、`superseded_by` = 新 id；默认检索不再返回旧笔记，`includeHistory:true` 返回 |
| 完成回合被捕获 | PASS | 真实 `turn/end:completed` → 恰好一个 pending job 落盘（`fromSeq=4,toSeq=19`，`route` 非空） |
| 进程中断 | PASS | 驱动在 job 文件出现后 `process.kill(pid,'SIGKILL')`；子进程退出信号 = `SIGKILL` |
| 重启恢复不重复 | PASS | 该 job 的 result receipt 恰好 1 份；vault 内无重复 note id |
| dryRun 零写入 | PASS | receipt `result=dry-run`、`dryRun=true`；重启前后 vault 树哈希映射**完全相同** |
| 自动写入（临时 vault） | PASS | receipt `result=applied`；vault 树新增 `约定/恢复通道约定（live）.md` 并更新其 `index.md` 与 `_meta/log.md` |
| 外部编辑存活 | PASS | 插件自有笔记被外部追加一行后，取代写入后该行仍在磁盘上 |
| 人工文件零覆盖 | PASS | 手写 `trust: owner` 笔记在 `mem_write(id=…)` 与 `mem_write(supersedes=…)` 后两次哈希不变，拒绝码均为 `human-owned` |
| 只读 lint 零写入 | PASS | `readOnly=true`，findings=2，前后全树哈希相同 |
| Obsidian 文件事实 | PASS | 20 篇笔记 YAML 可解析；17 篇 `tags` 为列表；32 个日期字段为 `YYYY-MM-DD`；16 个 wikilink 按路径或 basename 解析成功 |
| `.obsidian/` 未被触碰 | PASS | 运行前后 `.obsidian/` 全树哈希相同 |
| 真实 home 未被写入 | PASS | 见 §4 |

## 4. 安全与隔离（硬约束逐条）

- **真实 `~/.dsh` 逐字节不变**：`~/.dsh/profiles/**`（排除 `node_modules`）的 26 个文件、以及 `~/.dsh/cordis.patch.yml`、`~/.dsh/settings.yaml`、`~/.dsh/.credentials.yaml` 的 SHA-256 在全部运行前后**完全一致**（`diff` 空、exit 0）。`~/.dsh/profiles/web` 本身只在只读指纹中出现。
- **`~/.dsh/data` 不存在**：插件的数据根始终解析到临时 `DSH_HOME`（`resolveDataRoot()` 只认 `DSH_HOME`），真实 home 下从未出现 `data/`。
- **`~/.dsh/skills` 只有 `ultramath`**：插件自带的技能只同步进临时 home（`obsidian-mem` 未落进真实 skills 目录）。
- **`~/Documents/dsh-memory` 不存在**：配置里的 `vaultPath` 一直是临时 vault，默认路径从未被创建。
- **凭据只走子进程环境**：`DEEPSEEK_API_KEY` 从环境或 `~/.dsh/.credentials.yaml` 的 `refs` 读出后只注入子进程 `env`；从不打印、不写进临时 home、不写进记录。未使用“把凭据文件复制进临时 home”的兜底路由。
- **无真实会话正文入库**：驱动只记录元数据；提交的记录与本文档不含提示词、模型输出正文或笔记正文（笔记正文只存在于临时 vault，运行后删除）。
- **提交卫生**：本次只新增 `test/smoke/**` 与 `docs/smoke-results.md`；未触碰 `lib/`。

## 5. 未验证项（明确不作为 PASS）

1. **worker 自己的模型蒸馏调用在本环境无法完成。** 队列 worker 的 `llm.stream()` 每次都在终端块给出 `finish.reason.kind='aborted'`，`lastError.code='aborted'`（原文 `aborted: distill-finish:aborted (aborted)`），因此不产生 result receipt；job 按 R43 在 `maxRetries` 次后进入 `failed` 并被保留（不自动重试）——这条“有界失败、可查可重试”的行为本身是符合设计的。
   对照实验：**同一个 provider/model/凭据**，在 `agent/pre-step`（Cordis 调用内）里做的 `llm.stream()` 探针返回 `finish=stop`（383–624 ms，`textChars=2`）；而 worker 的调用从裸定时器回调发起，即在任何 Cordis 调用之外。两次唯一的差别是**调用上下文**。
   因此“完成回合 → 真实模型蒸馏 → 自动写笔记”这一条在本环境**未验证**；本次的 apply 证据来自设计定义的 `raw-durable` 恢复路径（§1）。这是需要交回 Task 16 / 宿主层定位的问题，不应被读成通过。
2. **Obsidian GUI 行为。** 本环境未打开 Obsidian，因此“`tags` 渲染为属性列表”“日期字段显示为 Date 属性”“路径限定双链可点击”三项**未验证**。可验证的文件系统一半（YAML/列表/日期形状/双链解析/`.obsidian/` 未动）已由 `verify.mjs` 在磁盘上真实验证。
3. **会话中途的重试。** 在 8 次隔离运行中，捕获到的 job 从未在**捕获它的那个会话内**被 worker 应用（`attempts` 始终为 0 直到重启）；重启后的 boot pass 能应用它。这与第 1 条同源，一并作为未验证项列出。

## 6. 剩余风险

- `distill` 的模型调用依赖**调用上下文**这一事实若在别的部署成立，会让“自动写入”整体失效；本文件不给跨环境结论，只给本机测量。
- 提交的 `test/smoke/records/smoke-record.json` 已把临时根路径替换为 `<tmp>/smoke`，是**冻结记录**而非可重跑输入：其 vault 已删除，`verify.mjs` 对它只会以 exit 2 拒绝（"the temporary vault is gone"），这是设计使然。
- 外部编辑器不受锁约束、凭据扫描不能穷尽未知格式、未入队崩溃窗口——与设计文档一致，未因本次冒烟而收紧。
- 提交的冻结记录由**修正前**的 runner 产出：runner 当时用 `!==` 比较两张树映射（对象引用），因此记录里的 `vaultChanged` 布尔值不可信；记录保留了原始 `treeBefore`/`treeAfter` 映射，`verify.mjs` 自行重算后才判定（dryRun 两张映射完全相同 → 零写入；live 映射新增一篇笔记 → 有写入）。runner 已改为规范串比较，下一次跑出的记录会自带正确布尔值。
