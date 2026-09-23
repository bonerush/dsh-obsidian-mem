# 本项目 dogfood 与最终验收（Task 20）

- **日期**：2026-09-24
- **分支**：`feat/dsh-obsidian-mem`
- **验证的 commit**：`bc8ef697e7233cac2c83e59652effec05f532bb1`（`fix: defer the rest of a settling pass and stop scoring an uncaptured lane`）。启用实写**之前**与提交之前各核对一次 HEAD，两次相同（§8）。
- **环境**：Node `v25.9.0`；DSH `0.1.5-rc.2`；`darwin arm64`；蒸馏路由 `deepseek-official` / `deepseek-flash`。
- **计划**：`docs/superpowers/plans/2026-09-23-dsh-obsidian-mem-implementation.md` Task 20。**本任务没有 `task-20-brief.md`**（brief 生成器停在 task-16），因此按计划 Task 20 正文的五步执行。
- **设计**：`docs/superpowers/specs/2026-09-23-dsh-obsidian-mem-design.md` §1（G1–G6）、§5、§10、§15（P0–P4）。
- **结论摘要**：清单 12 项中 **10 项 PASS、0 项失败、2 项只在隔离 vault 复现**；§1 G1–G6 与 §15 P0–P4 **全部 PASS**，其中 6 条带「未验证的一半」并逐条列出；发现 **1 个必须在发布前处理的行为缺陷**（§10 F1）与 1 个被本任务自己弄红的 P0 探针前置断言（§10 F2）。

> 本文件只记录**观察到的事实**：路径、计数、哈希、版本、字段名与 PASS / 未验证。不含任何模型输出正文、会话正文、提示词、笔记正文、凭据或本机绝对路径；**模型生成的笔记标题不写入本文**（这正是 `test/smoke/records/` 里修正前的记录不提交的同一个理由），落地笔记一律以**目录 + 插件颁发的 id**表述。`~/Documents/dsh-memory` 用 `~` 形式书写，仓库内路径一律相对本仓库根。

---

## 0. 两条范围裁决（执行前写定）

1. **dogfood 宿主 = 隔离的 `DSH_HOME`（`mkdtemp`），真实 vault = `~/Documents/dsh-memory`，真实仓库 = 本检出。**
   本任务被告知 `~/.dsh/cordis.patch.yml`、`~/.dsh/settings.yaml` 与真实 `~/.dsh/profiles/web` 只读；把行装进真实 profile 必须修改 `profiles/web`，因此不可行。隔离宿主是 T18（`docs/smoke-results.md` §1）已经建立、并在 `test/smoke/` 内可复现的形态，也与仓库 Global Constraint「测试使用临时目录和独立 DSH home/profile」一致。被 dogfood 的对象是**真实仓库 + 真实 vault + 真实模型路由**；唯一被隔离的是宿主配置与插件数据根（索引/收据/队列），它们本就设计为可重建、可丢弃。
   **推论（明确写出）**：把行装进用户**日常使用的 profile** 并切到 `dryRun: false`，仍是 `README.md` §3 + 「Automatic distillation」里的**人工步骤**，Task 20 不代做，本提交也不包含它。
2. **「包含实质项目变更的完成回合」= 在本仓库里真实跑起来的 DSH 会话回合**，内容含真实的项目工作。按 D1 / §5.4，本项目的**权威文档副本**就是 vault，因此写进 `文档/`、`决策/`、`约定/` 的条目是项目变更，而不是插件状态。这些会话被明确要求**不修改仓库里已存在的文件**（唯一例外：§5.2 的绑定指针必须由插件在仓库根创建，这正是 Task 20 要交付的东西）；「零仓库改动」在 §8 以 `git status --short` / `git diff --stat` 复验。

---

## 1. 验收清单（执行前冻结，结果列已回填）

清单项来自计划 Task 20 Step 1 点名的八项，加上 §1 / §15 的两组门。判定只认**一条被记录下来的观察**（命令 + 原始输出或哈希/计数），没有观察就写「未验证」并给出阻断原因。本表在跑任何真实会话**之前**写入本文件（第 1 次提交前的文件版本即为此表）。

| # | 清单项 | 观察方式 | 结果 |
|---|---|---|---|
| C1 | `.obsidian-mem` 恰为四字段（`projectId`/`slug`/`displayName`/`schema:1`），不含本机绝对路径、remote、时间 | 读仓库根指针的键集合与值形态 | **PASS** — 真实仓库：140 字节，键 = `displayName,projectId,schema,slug`，`projectId` 为 UUIDv4，`slug`=`dsh-obsidian-mem`，无 `/`、无 `http`、无时间字段；隔离 vault 那次 116 字节、同样四键（§3.1、§5.1） |
| C2 | vault 相对项目目录与 §5.1 骨架、注册表登记 | 列 `项目/<slug>--<8hex>/` 全树 + 读 `_meta/项目注册表.md` | **PASS** — 真实 vault：`项目/dsh-obsidian-mem--05025725/`，含 `index.md`、`_meta/hot.md`、`约定|文档|决策|踩坑|日志|收件箱/index.md`；`_meta/user.md`、`.gitignore`、`方法/index.md`；注册表生成区一行四列，`projectId | hub 相对路径 | displayName | remote`（§7） |
| C3 | bootstrap 只创建缺失项：对已有文件零改写 | 执行前后对全树逐文件哈希 | **PASS** — 第二次 `mem_admin(action="bind", mode="local")` 返回 `createdPaths: []`、`registryUpdated: false`；首次 bootstrap 创建 12 个文件，其后 5 个会话结束时 **7/12 逐字节不变**，变化的 5 个正是收到笔记的子目录 MOC `index.md`（插件声明哈希的生成区，§3.2、§7） |
| C4 | 首轮简报恰好一次且 ≤ `briefBudgetChars` | 会话内插件 recall 消息数 + 码点数 | **PASS** — 隔离宿主：`brief-injected-exactly-once`（第一步 1 条、会话共 1 条）、`brief-not-repeated-later`、`brief-within-budget` 109 码点 ≤ 6000；真实 vault：`mem_brief` 自报 `charCount: 1381`，尾注 `brief: 1381/6000 chars`，索引 `ready`、22 篇笔记、`truncated: false`（§3.2） |
| C5 | 中文检索命中 | `mem_search` 中文查询命中已写文档 | **PASS** — 隔离宿主：4 字查询 `hitCount=1`、`matchedDocPath=true`；真实 vault：`队列`→5 条、`文档漏检`→5 条、`bootstrap`→4 条，首位命中分别是蒸馏落地笔记、会话写入文档、约定笔记（§3.2） |
| C6 | `dryRun` 收据：只写收据、零 vault 变更 | receipt `result`/`dryRun` + 前后树哈希 | **PASS** — 3 份 dry-run 收据（`dryRun: true`、`index: none`、`refused: 0`），隔离宿主 `dry-run-wrote-nothing vaultChanged=false`；这三轮期间 vault 树没有因蒸馏新增任何文件（§6） |
| C7 | 低置信候选入 `收件箱/` | receipt `inbox: true` + 磁盘路径 | **PASS** — 17 个候选中 6 个 `inbox: true`；落地后 `收件箱/` 有 **4 篇**笔记（id `con-a07bfdf7-…`、`con-84df8aab-…` 等），其 frontmatter `confidence: 0.65 / 0.5 / 0.7`，均 < `minConfidence 0.75`（§6、§7） |
| C8 | 文档漏检报告：列出未纳入 vault 的仓库 Markdown，且不搬动文件 | `mem_admin(action=lint)` findings + 前后树哈希 | **PASS** — 真实仓库一次只读 lint：`repository.scanned=107`、`candidates=106`、`truncated=false`，另报 `dead-wikilink` 与 `pending-backlog`；隔离宿主 `read-only-lint-never-writes`：`readOnly=true`、`findings=2`、`treeUntouched=true`（§3.2） |
| C9 | 外部编辑与人工文件零覆盖 | 人工追加行存活 + `trust: owner` 笔记逐字节不变 | **PASS（隔离 vault）** — `external-edit-survived`（`humanLineSurvived=true`、`onDiskAfterAllPasses=true`）、`human-owned-file-byte-identical`（`update=human-owned`、`supersede=human-owned`、`byteIdentical=true`）。**真实 vault 未复现**：那里没有人工文件，我**故意没有**手写一个进去污染用户 vault（§9 U8） |
| C10 | 取代链：旧笔记 `status: superseded` + `superseded_by`，无删除 | 读两篇笔记 frontmatter | **PASS（隔离 vault）** — `supersede-chain-correct`：旧 `dec-5087549d…` `status=superseded`、`superseded_by=dec-2e685596…`，默认检索不返回、`includeHistory` 返回。**真实 vault 未发生取代**：落地笔记 `supersedes: null`，无删除（§9 U8） |
| C11 | 崩溃恢复恰好一次、无重复 note id | SIGKILL → 重启 → receipt 数 + 重复 id 扫描 | **PASS（隔离 vault）** — `interrupted-process-was-killed`（`killedBy=SIGKILL`）、`restart-recovered-exactly-once`（该 job 恰好 1 份 result receipt）、`no-duplicate-note-ids`（`[]`）。**真实 vault 未做 SIGKILL**（§9 U8） |
| C12 | 随包技能同步到 `$DSH_HOME/skills/obsidian-mem/` | 列隔离 home 的 skills 目录 | **PASS** — 两个隔离 home 都有 `skills/obsidian-mem/SKILL.md`（15367 字节）；dogfood 会话在日志里明确 `skill` 载入成功；真实 `~/.dsh/skills` 仍只有 `ultramath`（§8） |

| 门 | 要求（§1 / §15） | 判定依据 | 结果 |
|---|---|---|---|
| G1 | 插件写的项目文档以 vault 为权威副本、可浏览/双链/搜索；仓库里其他工具写的 Markdown 被发现并报告 | C2/C5/C8 + 文件级 Obsidian 事实 | **PASS**（GUI 那半 未验证，§9 U1） |
| G2 | 长期记忆自动沉淀并在新会话首轮回到上下文 | C4 + C5 + 跨会话召回 | **PASS**（本行是对 `bc8ef69` 的判定：当时首次绑定需显式动作，见 F1；F1 的自动绑定已由 Task 20b 实现） |
| G3 | 完成回合空闲后自动提炼；失败可重试；崩溃后不重复 | C6/C11 + 真实 receipt | **PASS**（同进程一次性 apply 未验证，§9 U3） |
| G4 | 记忆可取代、可标争议、无删除 | C10 | **PASS**（取代在隔离 vault 复现；真实 vault 未发生） |
| G5 | 方法论可复用、可脱离插件运转 | C12 + 独立 SDK 依赖 | **PASS** |
| G6 | 参考 Hindsight：自动摄取、来源标记、按项目边界、按预算注入 | C4/C6/C11 + 逐条对应 | **PASS** |
| P0 | 宿主要害契约有实测证据（事件顺序、注入时机、`llm.stream`、FTS5） | `docs/p0-compatibility.md` + 本次重跑的两条探针 | **PASS**（探针 13/13；dogfood 当时 12/13，唯一红项是前置断言，已由 Task 20b 修好，见 F2） |
| P1 | 骨架/读写：全链路、幂等、外部编辑不覆盖、中文检索 | C1–C3/C5/C9 | **PASS** |
| P2 | 注入与技能：首轮一次 ≤ 预算、超时补发、技能落位 | C4/C12 + 定向用例 | **PASS** |
| P3 | 自动提炼：入队、中止不沉淀、重启不重复、低置信入收件箱、dryRun 只写收据、外部改动零覆盖 | C6/C7/C9/C11 + 定向用例 | **PASS** |
| P4 | 文档与发布：`npm pack` 内容正确、`node --test` 全绿、README 五分钟可装 | §8 的 prepack / pack / 全量测试 | **PASS** |

---

## 2. 执行记录：Step 2 —— 先在临时 vault 跑完整清单

计划 Step 2 要求「在临时 vault 完整执行一次，确认所有清单项通过」。用的是 T18 建立的隔离 runner（临时 home + 临时 vault + 临时仓库，本仓库与一次性驱动插件以 `link:` 装入），在**本 HEAD** 上重跑一次：

```sh
env -u DSH_HOME node test/smoke/run-smoke.mjs --out /tmp/dshsmoke-task20.json
env -u DSH_HOME node test/smoke/verify.mjs /tmp/dshsmoke-task20.json
env -u DSH_HOME node test/smoke/negative-controls.mjs /tmp/dshsmoke-task20.json
```

`verify.mjs` 原始输出（**逐字**，只删去了与本次无关的重复行；它只含驱动插件写下的确定性路径与插件颁发的 id，不含模型生成标题）：

```
verify: /tmp/dshsmoke-task20.json
  versions: dsh=0.1.5-rc.2 node=v25.9.0 obsidian=(not supplied; GUI checks unverified)
  PASS plugin-row-in-dump-config — dump-config has "- id: obsidian-mem": true (11208 chars)
  PASS plugin-row-line-recorded — - id: obsidian-mem
  PASS brief-injected-exactly-once — firstStepBriefCount=1 (session total 1)
  PASS brief-not-repeated-later — sessionBriefCount=1
  PASS brief-within-budget — 109 code points <= 6000
  PASS chinese-search-hit — queryChars=4 hitCount=1 matchedDocPath=true
  PASS document-write-on-disk — 项目/repo--4c2bcc54/文档/冒烟文档：中文检索目标.md
  PASS supersede-chain-correct — old=dec-5087549d-2e8f-45c9-a513-8fb79242aea7 status=superseded superseded_by=dec-2e685596-bd26-432e-ae1c-336b92305720 defaultHasOld=false historyHasOld=true
  PASS interrupted-process-was-killed — killedBy=SIGKILL jobId=job-ea6c8c4c37c5ebd1a6c838507439368b injected=raw-durable
  PASS restart-recovered-exactly-once — result receipts for job-ea6c8c4c37c5ebd1a6c838507439368b: 1 (total 4)
  PASS restart-live-apply-succeeded — live receipt: applied dryRun=false
  PASS restart-wrote-to-the-vault — vault changed across the live restart: true (receipt applied)
  PASS no-duplicate-note-ids — duplicate ids: []
  PASS dry-run-wrote-nothing — dry-run receipt: dry-run vaultChanged=false
  PASS model-lane-dry-run-real-distill — result=dry-run attempts=0 outputTokens=511 durationMs=2459 vaultChanged=false
  PASS model-lane-live-real-distill — result=applied attempts=0 outputTokens=241 durationMs=1571 vaultChanged=true
  PASS external-edit-survived — path=项目/repo--4c2bcc54/文档/外部编辑目标文档.md humanLineSurvived=true onDiskAfterAllPasses=true
  PASS human-owned-file-byte-identical — path=项目/repo--4c2bcc54/约定/人写的约定.md update=human-owned supersede=human-owned byteIdentical=true
  PASS read-only-lint-never-writes — findings=2 treeUntouched=true
  PASS real-dsh-home-unchanged — real ~/.dsh fingerprint unchanged: true
  PASS frontmatter-parses-under-yaml-v2 — 21 notes parsed
  PASS tags-is-a-list — 18 notes carry a tags list
  PASS date-fields-are-iso-days — 34 date fields shaped YYYY-MM-DD
  PASS wikilinks-resolve — 17 wikilinks resolved by path or basename
  PASS obsidian-directory-untouched — externalEdit.obsidianUntouched=true
  UNVERIFIED Obsidian GUI checks (rendered tag list, date property, clickable wikilink): the vault was never opened in Obsidian
verify: OK (25 checks, 21 vault notes)
```

退出码 `0`。负控（逐条破坏一个验收条件，断言检查器非零退出）：

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
  PASS refuses-personal-vault-path -> verify exit=2
negative-controls: OK (9 negative controls)
```

退出码 `0`。清单里临时 vault 覆盖不到的 C1 / C12 用同一批产物直接观察：临时仓库根 `.obsidian-mem` 是四键 116 字节；临时 home `skills/obsidian-mem/SKILL.md` 存在（15367 字节）。

**Step 2 结论：清单在临时 vault 全项通过，没有把失败场景带进真实 vault。**

---

## 3. 执行记录：Step 3 —— 真实 vault 的绑定、dryRun 门与实写

### 3.1 宿主与配置（除 vault 外不写任何真实路径）

```sh
# 只在 /tmp/dshdogfood 下工作；DSH_HOME 是全新 mkdtemp，真实 ~/.dsh 只被只读读取
dsh --profile dogfood --from-default-profile headless --dump-config
dsh plugin --profile dogfood add "link:$PWD"          # 本检出以 link: 装入
# 隔离 home 的 settings.yaml 只写 permission.defaultPreset: danger-full-access
# 隔离 profile 的 cordis.patch.yml 写 obsidian-mem 行 config（vaultPath=~/Documents/dsh-memory）
dsh --profile dogfood --dump-config | grep -n 'id: obsidian-mem'
```

`--dump-config` 第 350 行是 `- id: obsidian-mem`，行内 config 与 README 的完整示例逐字段一致。真实会话一律以仓库根为 cwd 运行：

```sh
DSH_HOME=/tmp/dshdogfood/home dsh --profile dogfood "<prompt>"   # ×11 次
```

共 **11 次真实 headless 会话**（都在本仓库里、都走真实 `deepseek-official`/`deepseek-flash` 路由）：

| 会话 | 目的 | 捕获 | 结果 |
|---|---|---|---|
| `a` | 首次（无指针）尝试写 vault | **无 job** | `mem_write` 被 `not-bound` 拒绝 → 证实「无指针 = 本会话没有记忆」（§10 F1） |
| `a2` | 显式 `mem_admin(action="bind", mode="local")` + 写项目文档 | job-cafe6d22 | 指针 + 全套骨架建成 |
| `b` | 写 3 条约定 + 复跑 bootstrap | job-21d53bb5 | `createdPaths: []` |
| `c` | 只读 lint + 写文档漏检报告 | job-85cb2df3 | `scanned=107 candidates=106` |
| `d` | 写一条 ADR | job-b68a65da | — |
| `d2` | 观察队列 + 写日志 | job-e196ce08 | — |
| `e` `f` `g` | 短任务（列目录/看队列） | job-913facbe / job-5cc38ab1 / job-114f51af | 含 2 份 `no-memory` |
| `h` | 三次中文 `mem_search` | job-fd15950f | 检索命中（§3.2） |
| `i` | `mem_admin(projects)` + `mem_brief` | job-27411ee6 | 简报 1381 码点 |

**11 次会话 = 10 个被捕获的完成回合**（`a` 因为未绑定，按设计没有 job）；其中 **8 个产生了 result receipt**，2 个在临时 home 被删除时仍是 `pending`（最后一次会话的回合，按 at-least-once 契约留给下一个进程——这正是 §9 U3 的实测形状）。

### 3.2 真实 vault 的观察（原始输出摘要）

**绑定与骨架**（会话 `a2` 之后）：

```
$ cat .obsidian-mem
{ "projectId": "05025725-00be-4852-aba6-4854f961cd01", "slug": "dsh-obsidian-mem",
  "displayName": "dsh-obsidian-mem", "schema": 1 }          # 140 字节，四键
$ find ~/Documents/dsh-memory -not -path '*/.git/*'
VAULT/{.gitignore, _meta/{user.md,项目注册表.md,.history/}, 方法/index.md,
       项目/dsh-obsidian-mem--05025725/{index.md, _meta/hot.md,
         约定|文档|决策|踩坑|日志|收件箱/index.md}}          # 12 个文件
```

**bootstrap 幂等**（会话 `b` 里 `mem_admin(action="bind", mode="local")` 的返回，模型原文转述）：

```json
{"mode":"local","status":"bound","pointerCreated":false,"registered":true,
 "vaultExists":true,"bootstrapped":true,"registryUpdated":false,"createdPaths":[]}
```

配合全树哈希：首次 bootstrap 的 12 个文件里，**7 个在后续 5 个会话之后仍逐字节相同**；变化的 5 个恰好是收到笔记的子目录 MOC `index.md`（`约定|文档|决策|踩坑|收件箱`）——它们本来就带 `<!-- obsidian-mem:generated begin sha256:… -->` 声明哈希区，属于有意更新，不是 bootstrap 重写。

**中文检索**（会话 `h`，`scope="project"`）：`队列` → 5 条（首位是蒸馏落地的决策笔记，次位是会话手写的 ADR）；`文档漏检` → 5 条（首位是会话写入的文档）；`bootstrap` → 4 条（首位是约定笔记）。默认 `limit=8`，三次都没触顶。

**只读 lint**（会话 `c`）：`repository.scanned=107`、`candidates=106`、`truncated=false`，另有 `dead-wikilink` 与 `pending-backlog` 两类 finding；`mem_admin(action="lint")` 未加 `report`/`prune`，前后全树哈希不变（C8）。**独立复核**：`find . -name '*.md' -not -path './.git/*' -not -path './node_modules/*'` 在本仓库得到 **145** 个 Markdown，其中 `.superpowers/` 占 **38** 个；145 − 38 = **107**，与 lint 自报的 `scanned` 完全一致（即它排除了点目录），所以 `candidates=106` 不是转录噪声。

**简报**（会话 `i`）：`mem_brief` 自报 `charCount: 1381`、尾注 `brief: 1381/6000 chars`、`hot 265/9000`、索引 `ready`、22 篇笔记、`truncated: false`；`mem_admin(action="projects")` 报唯一绑定 `projectId 05025725-…`、vault 相对目录 `项目/dsh-obsidian-mem--05025725`、remote 为空。

---

## 4. dryRun 观察与放行决定

### 4.1 观察到的回合数

在 `distill.dryRun: true` 期间被捕获的完成回合共 **5 个**（`a2`、`b`、`c`、`d`、`d2`）。其中 **3 个产生了 dry-run 收据**（在下一进程启动时被真实 worker 用真实模型调用蒸馏）：

| job | 回合 | result | dryRun | attempts | outputTokens | durationMs | index | 候选 | refused |
|---|---|---|---|---|---|---|---|---|---|
| `job-cafe6d22…` | a2 | `dry-run` | true | 1 | 1950 | 8328 | none | 3 | 0 |
| `job-21d53bb5…` | b | `dry-run` | true | 1 | 2122 | 11 | none | 5 | 0 |
| `job-85cb2df3…` | c | `dry-run` | true | 1 | 4549 | 18689 | none | 3 | 0 |

另 2 个回合（`d`、`d2`）在**放行之后**才被蒸馏，因此自然变成 `applied`（§4.4）。dryRun 是在 **apply 时**读的，不是在 capture 时——这是本次实测到的一条语义。

### 4.2 逐条核对（独立于插件自己的记账）

我在每个 job 被排空前，先把队列文件里的 `allowedEvents` **只取 seq / kind / ok 元数据**快照到 `/tmp/dshdogfood/evidence/`（不复制任何回合正文），再用独立脚本把收据里的 `evidenceSeqs` 映射回事件种类：

```sh
node /tmp/dshdogfood/snapshot-jobs.mjs <label>   # seq→kind/ok 元数据 + 凭据包含性测试
node /tmp/dshdogfood/verify-gate.mjs             # 逐候选判定，退出 0/1
```

结果（`verify-gate.mjs` 原始 JSON 的关键字段）：

```json
{ "receipts": 6, "results": ["dry-run/dryRun","dry-run/dryRun","applied","applied","dry-run/dryRun","applied"],
  "candidates": 17, "acceptedCandidates": 0, "observedVerified": 8,
  "evidenceLess": 0, "foreignSeq": 0,
  "snapshotMissing": ["job-913facbe4309677c0cad28592e83f8e6"],
  "queueFiles": 16, "queueFilesContainingCredentialValue": 0, "findings": [] }
```

（写成收据时共 6 份；之后又落了 2 份 `no-memory`，最终 8 份，见 §6。）

- **零无证据候选**：17 个候选 `evidenceSeqs` 全部非空（`evidenceLess: 0`），且每个 seq 都在该 job 的白名单事件里（`foreignSeq: 0`）。schema 本身也拒绝空数组：`distill item N: evidenceSeqs must be a non-empty array of committed seqs`。
- **`accepted` 必须指向用户明确确认的 seq**：本样本里**模型确实试图把一条候选标成 `accepted`**，而它的证据 seq 全部是工具事件、没有 `user` 事件。插件把它降级为 `provisional` 并写下 `downgrades: ["accepted-without-user-confirmation"]`（`job-b68a65d…`，唯一一条 downgrade）。我的独立脚本同样判定「该候选的证据里没有 user 事件」，因此这条降级是"被解释的"（`unexplainedDowngrades: 0`）。落盘笔记的 frontmatter 印证：`status: "provisional"`、`assertion: "stated"`、`confidence: 0.95`。**这比"零 accepted 候选"强——它真的走了一遍用户确认门。**
- **`observed` 必须有独立复核**：8 个 `assertion: observed` 候选，每一个的证据里都至少有 1 个 `kind=tool && ok=true` 事件（`observedVerified: 8`、`observedUnverified: 0`）。
- **零凭据泄漏**：真实 `DEEPSEEK_API_KEY` 的值在 **16 个队列文件里 0 命中**（`queueFilesContainingCredentialValue: 0`），每份 job 快照的 `credentialSkips: 0`，收据的 `refusedCount` 全为 0。
- **零人工文件修改**：见 §8（`git diff --stat` 空、`git status --short` 只有指针与本文；真实 home 九个指纹项逐字节不变）。

### 4.3 样本质量与两次「正确的拒绝」

样本不是一路绿：`job-85cb2df3…` 第一次蒸馏被 **`truncated: distill-finish:max-tokens — the output is incomplete and is never a candidate`** 拒绝，`job-21d53bb5…` 第一次被 **`too-many-items: the model returned 5 items, beyond distill.maxItems=3`** 拒绝。两次都是**插件拒绝接受不完整/超限的模型输出**，job 保持 `pending`、带 `nextAttemptAt` 退避、`attempts` 只加 1，重试后成功。我的配置在这两次失败后把 `distill.maxOutputTokens` 从 2000 提到 4000、再提到 16000，`maxItems` 从 3 回到 12——**这是放宽模型输出上限，不是放宽证据门**；证据门（白名单 seq、user 确认、tool 复核、dry-run 零写）一条没动。

### 4.4 决定

**通过，开启实写。** 依据：3 个 dryRun 回合（远超计划要求的 3 个）各自的收据逐候选过关，零无证据候选、零未复核的 `observed`、零未被用户确认的 `accepted`（唯一一条 attempted-accepted 被插件降级并落成 `provisional`）、零凭据泄漏、零人工文件改动；两次模型输出拒绝说明插件在真宿主里也会拒绝坏输出而不是写进去。

放行后：

```sh
# 隔离 profile 的 cordis.patch.yml：distill.dryRun: false
git rev-parse HEAD    # bc8ef697e7233cac2c83e59652effec05f532bb1 —— 与开始时相同
```

---

## 5. 真实 vault 的落地内容（Step 3 收尾）

放行后到 `job-27411ee6` 为止，真实 vault 里的内容：

| 目录 | 篇数（不含 `index.md`） | 来源 |
|---|---|---|
| `文档/` | 1 | 会话 `c` 用 `mem_write(type=doc)` 写的漏检报告 |
| `决策/` | 2 | 会话 `d` 手写 1 篇；蒸馏落地 1 篇（`dec-02cda7d7-…`，`status: provisional`） |
| `约定/` | 3 | 会话 `b` 写的三条硬约定（`assertion: observed`） |
| `踩坑/` | 1 | 蒸馏落地（`got-549dd769-…`） |
| `收件箱/` | 4 | 蒸馏落地的低置信候选（`con-a07bfdf7-…` 等，`confidence` 0.5–0.7） |
| `日志/` | 1（按天） | `mem_log` 追加 |
| 其它 | `index.md` × 7、`_meta/{user.md,项目注册表.md,hot.md}`、`方法/index.md`、`.gitignore` | bootstrap |

- 全树 `*.md`（不含 `_meta/.history/`）共 **24 篇**；`_meta/.history/` 有 **14 个** txId 快照目录（每次改写插件自有文件前的原字节副本）。
- **无删除**：没有任何笔记消失（插件也没有删除笔记的路径）。
- **vault 里 `git init` 过但没有 commit**（`git rev-list --count HEAD` 报 `unknown revision`，即 0 个提交），与 README「只 `git init`、从不 commit、从不配 remote」一致。
- 每篇落地笔记都带 `project: 05025725-…`、`source: agent`、`session: session-…`、`harness: dsh`、`trust: agent`、`assertion`、`confidence`、`supersedes/superseded_by`（来源标记，G6）。
- 子目录 MOC 的生成区带 `<!-- obsidian-mem:generated begin sha256:… -->`，与注册表的 `<!-- obsidian-mem:registry begin sha256:… -->` 同一套声明哈希机制（R24）。

**未落地的**：2 个 job 在临时 home 被删除时还是 `pending`（最后一次会话的 `ls` 类回合，以及被卸载推迟的 `h` 回合）——即「job 已 fsync 后至少一次」的下一进程接手路径，不是丢失。

---

## 6. 收据总账与其余观察

8 份 result receipt（3 `dry-run` + 3 `applied` + 2 `no-memory`），17 个候选，累计 13343 个真实 output token，`refusedCount` 全 0，`attempts` 只有 3 个 dry-run job 各为 1（那三次失败重试，§4.3）、其余为 0。

- `applied` 三份的 `index: refreshed`，`dry-run`/`no-memory` 的 `index: none`。
- **`no-memory` 是显式的空结果收据**：两个短回合返回 `{"items": []}` 得到 `result: no-memory`，不是静默丢弃——对应 P3 的「明确的空结果收据」。
- **thin turn 的噪声**：一个只让模型 `ls -a` 并说一句话的回合，蒸馏出 **2 个**候选并（放行后）落进 `收件箱/`。也就是说浅回合不会被静默忽略，而是被 `minConfidence` 挡在记忆目录之外、停进收件箱。这是设计意图，但用户需要自己清收件箱（插件不删）——列为 §10 F3。
- **bc8ef69 的「一次 pass 只收尾一个 job」在真宿主里复现了**：`c` 的 job 蒸馏耗时 18.7 s，期间插件树已被会话结束处置，队列里另一个到期 job 因此以 `unloaded` 推迟——`attempts` 保持 0、不写 `lastError`、job 文件保持 `pending`（`job-b68a65da…` 在 `d2` 启动时就是这样被推后的）。这正是 T18b 修复要保证的形状。

---

## 7. §15 P0–P4 逐项与本次重跑的命令

| 阶段 | 本次跑过的命令与结果 |
|---|---|
| **P0** | `env -u DSH_HOME node test/p0/run-teardown-probe.mjs` → **12 PASS / 1 FAIL**，退出 1；唯一红项是 `default-vault-absent`（本任务**自己**把 `~/Documents/dsh-memory` 建出来了，该前置断言因此在构造上必然失败——见 §10 F2）。通过项包括：`service-is-live-with-an-active-provider-fiber`、`in-handler-call-is-a-real-answer`（finish=stop，17 chunks，1042 ms）、`bare-timer-in-the-live-window-is-a-real-answer`（finish=stop，16 chunks，982 ms）、`the-tree-is-disposed-at-the-end-of-the-run`（disposer t=4108）、`an-in-flight-stream-survives-the-disposal`（finish=stop，7133 ms，disposer 后 3.3 s 收尾）、`the-worker-signal-disposer-abort-is-what-produces-aborted`、`no-lookup-path-works-after-the-disposal`（`NO_ADAPTER`）、`real-dsh-home-unchanged`、`real-data-dir-absent`、`real-skills-only-ultramath`。<br>`DSH_HOME=$(mktemp -d) node test/p0/llm-sqlite-probe.mjs --env-only` → **5/5 PASS**：`node:sqlite`+FTS5（sqlite 3.51.3，`MATCH'调度器'=1`、`MATCH'调度'=0`，即 CJK bigram 生效）、文件 fsync、`link` 独占发布（第二次 EEXIST）、同目录 rename 替换、目录 fsync。两次运行都用临时 home，真实 home 事后指纹不变。 |
| **P1** | C1–C3/C5/C9：见 §1 与 §3.2/§5；隔离 vault 的 `no-duplicate-note-ids`、`human-owned-file-byte-identical`、`external-edit-survived` 都已计分。 |
| **P2** | C4/C12 见 §1；补发路径用定向用例取证：`DSH_HOME=$(mktemp -d) node --test --test-name-pattern="re-sends exactly once when ready" test/hooks.test.js` → `tests 1 / pass 1 / fail 0`；另有 `an index that never becomes ready still injects exactly one not-ready status` 在套件内。 |
| **P3** | C6/C7/C9/C11 见 §1；中止回合不沉淀：`--test-name-pattern="a cancelled turn and an errored turn never enter the input snapshot" test/capture.test.js` → `1/1 pass`；低置信路由：`--test-name-pattern="low confidence goes to the inbox and cannot supersede an established conclusion" test/distill.test.js` → `1/1 pass`；真取消仍被记账：`--test-name-pattern="an explicit worker.abort() still cancels an in-flight model call" test/auto-capture.test.js` → `1/1 pass`；队列推迟：`--test-name-pattern="a pass that outlives the plugin tree defers the rest of the queue instead of failing it"` → `1/1 pass`。 |
| **P4** | §8 的 `npm run prepack`（543/543 + `verify-pack: OK`）、`npm pack --dry-run --ignore-scripts` 清单、README 的安装路径在隔离 home 里被真实执行（`--from-default-profile headless` → `plugin add link:` → `--dump-config` 出现 `- id: obsidian-mem`）。 |

---

## 8. Step 4 —— 完整最终验证（在最终树、HEAD 未变）

```sh
git rev-parse HEAD        # bc8ef697e7233cac2c83e59652effec05f532bb1  （与开始、与放行时相同）
npm run prepack           # exit 0 —— ℹ tests 543 / pass 543 / fail 0 / cancelled 0
                          #            verify-pack: OK … version 0.1.0, files allowlist 7 entries,
                          #            6 required assets present and covered, 6 tools registered
npm pack --dry-run --ignore-scripts
git diff --check          # 无空白损坏
git status --short
```

- **真实 `~/.dsh` 逐字节不变**：`cordis.patch.yml`、`settings.yaml`、`.credentials.yaml`、`profiles/web/{package.json,cordis.patch.yml,pnpm-lock.yaml}`、`profiles/` 目录清单，九个指纹项前后**完全相同**；`data/` 仍为 `absent`（dogfood 的数据根始终在临时 home）；`skills/` 仍只有 `ultramath`。
- **真实 vault 是唯一新增的真实路径**：`~/Documents/dsh-memory`（本任务获批创建）。`~/Documents/knowledge` 从未被打开或读写；只有它的名字出现在一次 `ls -la ~/Documents/` 的父目录列表里，以及一次 `ls -d` 存在性探测（仅目录元数据，未读内容、未写入）——如实披露。
- **仓库改动只有该有的**：`git status --short` = `?? .obsidian-mem`、`?? docs/dogfood-results.md`（提交前）；`git diff --stat` 对已跟踪文件的改动只有 `README.md` 与 `CHANGELOG.md` 的实测修正（§10 F1）。dogfood 会话没有改过任何仓库文件。

---

## 9. 未验证项（明确不作为 PASS）

继承自 `README.md` 的 *Not verified* 与 `docs/smoke-results.md` §5，逐条说明本次有没有挪动：

1. **Obsidian GUI 渲染与类型化属性未验证（U1）。** 本环境没有打开 Obsidian。文件级那一半（YAML 可解析、`tags` 是列表、日期是 `YYYY-MM-DD`、双链可按路径/basename 解析、`.obsidian/` 未被触碰）由隔离 runner 在磁盘上真实验证；**GUI 那一半没有移动**，阻断原因：没有可用的 Obsidian 会话。
2. **真实模型调用只在单一宿主、单一路由上测过（U2）。** 本次仍只有 DSH `0.1.5-rc.2` / Node `v25.9.0` / `darwin arm64` / `deepseek-official`+`deepseek-flash`。**没有移动**。
3. **一次性 `dsh "…"` 运行里的同进程 apply 未验证（U3）。** 本次实测到它的形状而不是反证它：回合结束时插件树被处置，`captureIdleMs` 到期前进程已退出，job 保持 `pending` 交给下一个进程（临时 home 被删除时仍有 2 个 pending）。**没有移动**。
4. **没有断电测试（U4）。** 崩溃恢复只由 SIGKILL 在特定屏障上取证。**没有移动**。
5. **跨进程锁竞争未测（U5）。** 进程内与对死进程有测试；两个活进程争同一个 vault 没测。**没有移动**。
6. **`fork` / `retain` 在 worktree-sibling 布局上未测（U6）。** 有测试，但不是它们要处理的多 worktree 排列，本次也没做。**没有移动**。
7. **崩溃后跨进程补扫 `session.v3.jsonl.zstd` 未验证（U7）。** 本次顺带测到一条可写进文档的事实：隔离 home 里那些 dogfood 会话的 `session.v3.jsonl.zstd` 只含 **1 行**（会话头），因此无法从 DSH 持久日志反推 `seq → kind`。**没有移动**（也不据此收紧保证）。
8. **C9/C10/C11 的真实 vault 那一半未验证（U8）。** 真实 vault 里没有人工文件、没有发生取代、没有 SIGKILL。**阻断原因都是刻意的**：往用户 vault 手写一个 `trust: owner` 测试文件、或为了取证人为造一条取代链，都是往用户的专用记忆库里塞测试垃圾；这三项的证据留在隔离 vault（临时目录，已删除）。
9. **一份收据的证据 seq 未能独立重映射（U9）。** `job-913facbe…`（2 个候选、0 downgrade）在排空前没有留下元数据快照，所以那 2 个候选的 `evidenceSeqs` 只有插件自己的记账可查。这是**本次取证的缺口**，不是插件缺陷。
10. **dryRun 样本规模（U10）。** 3 份 dry-run 收据 / 11 个候选 / 1 条 attempted-accepted，够过门但并不大；3 次模型输出拒绝（`truncated`×2、`too-many-items`×1）说明同一提示词换一个回合就可能换一种拒绝。

---

## 10. 用真东西跑出来的发现

### F1（重要，必须处理）无指针的仓库没有任何自动绑定路径，而 README 说"first write"会给一个

代码（**行号是 dogfood 时点 `bc8ef69` 的 `lib/`**，Task 20b 的修复让它们整体下移；下面引用的行为是当时的）：`lib/index.js:80`（注入/捕获用的 seam）与 `lib/tools.js:931`（六个工具）**都**以 `mode: 'show'` 调 `resolveBinding`；`mode: 'show'` 在无指针时返回 `kind:'unbound' / reason:'no-pointer'`（`lib/vault.js:170-179`），只有 `mem_admin(action="bind", mode="local")` 走 `lib/tools.js:1485` 把模式透传下去才会铸指针。实测：会话 `a` 里 `mem_write` 返回 `mem_write needs a bound project: this working directory has no .obsidian-mem pointer`，并且**负结果被按 cwd 记忆化**（`lib/tools.js:925-938`，只在 `close()` 清空），所以同一会话里即使随后 `mem_admin(action="bind", mode="local")` 建好了指针，六个工具仍然一直报 `not-bound`，必须换一个会话。

影响：一个全新项目的第一天不会有任何记忆，而且第一次 `bind` 之后还要重启一次才对工具生效。README 的 *Verify it works* 表原本写着「with no pointer, a Git repository gets a fresh `.obsidian-mem` and a project skeleton on first write」，**这句话被本次实测证伪**（设计 §5.2.3 描述的自动铸指针在实现里没有可达路径）。

本任务的处理：**只改文档，不改 `lib/`**（本任务的改动面被限定为指针 + 报告 + 必要的文档修正；改 `lib/` 会重开一次行为变更与评审，而且会移动「已验证 commit」）。已按实测修正 `README.md` 三处（*Verify it works* 的 Project bound 行、`deferred` 恢复行、`memory is silently absent` 恢复行）与 `CHANGELOG.md` 一条。**建议**：把「首个有指针的写入自动铸指针」要么实现成 `mem_write` 在 `no-pointer` 且是 Git 仓库时降级为一次 `local` 绑定，要么明确把 `mem_admin(action="bind", mode="local")` 写成安装步骤第 6 步；无论哪种都要在 `bind` 成功后失效该 cwd 的负缓存。

**处理结果（Task 20b，本文件写于修复之后）**：建议的前半段被采纳并实现——`mem_write` / `mem_log` 在 `mode: 'show'` 给出 `kind:'unbound' / reason:'no-pointer'` 时，改用 `mode: 'local'` 重新解析一次，走的正是本节引用的 `lib/vault.js` 创建分支（独占写指针、继承 sibling worktree 指针、注册表冲突检查），成功后再 `bootstrapVault`（`lib/tools.js` 的 `autoBindProject`），然后继续这次写入；`mode: 'show'` 的探测保证**读不铸指针**、**非 Git 目录不铸指针**、**任何拒绝原因（`pointer-corrupt` / `pointer-unsupported-schema` / `sibling-unreadable` / 注册表不可读 / cloud-managed）都不会被绕过**。`bind` 成功后用一个 `rememberBinding(key, bound)` 覆盖 `bindingByCwd` 里那条 miss，显式 `mem_admin(action="bind", …)` 也走同一个回调，所以**同一会话**内六个工具立刻生效，不再需要新会话。另：解析在铸指针之后才拒绝时（注册表不可读、目录被占）会把这次自己创建的指针收回，避免一次拒绝变成永久粘住的半绑定。README 的 *Verify it works* Project bound 行与「A repository refuses to write」「A plain directory stays read-only」「Memory is silently absent」三处恢复表行已按上面的行为重写。

**补（复审后 Task 20b 第 2 轮）**：上面那句「解析在铸指针之后才拒绝时」原本只覆盖 `resolveBinding` 内部的拒绝。自动绑定还会在**铸完指针之后**调 `bootstrapVault`，而 bootstrap 的拒绝发生在第一次写入**之前**（§6.4 属性预检；以及注册表区显式声明的 sha256 与其正文不符——`readRegistry` 不校验该哈希，`prepareRegistry` 在写任何东西之前拒绝，`registry-hash-mismatch`。`vault-root-not-directory` 与 `template-invalid` 同属 pre-write，但经工具 seam 到不了：前者会先被 `resolveBinding` 的注册表读取拒掉）。这类拒绝此前会把指针留在磁盘上：仓库被绑到一个 vault 从未接受的身份，且下一次写入会以 `bound` 解析、跳过刚刚拒绝它的那道预检。现在 `bootstrapVault` 把 `vaultWritten`（是否已创建骨架文件**或目录**、或提交注册表行；仅创建 vault 根目录不算）附在它抛出的每个错误上，`autoBindProject` 只在 `vaultWritten !== true` 时调 `releaseCreatedPointer`：**pre-write 拒绝一律归还指针**，下一次写入干净地重试绑定；**确实写入了内容的失败保留身份**（骨架可能只建了一半），修复办法是显式 `mem_admin(action="bind", mode="local")`——它每次都会重跑 bootstrap，而写入路径不会。两条分支各有一个用例钉住（见下）。

证据（修复本身）：新增 `test/auto-bind.test.js`，15 个用例全部走真实 `@deepseek-ai/dsh-tools` 运行时 + 临时 git 仓库/临时 vault，`npm test` 558/558。其中 (a) 首次 `mem_write` 铸出四字段指针（无绝对路径）并落地笔记、(b) 同一会话下一次调用可见（自动与显式各一条）、(c) 第二次写入指针逐字节不变、(d) 新的 worktree 继承同一 projectId、(e) 八类拒绝仍拒绝且不铸指针（非 Git 目录、指针损坏、schema 未知、注册表解析失败、注册表哈希不符、sibling worktree 不可读、属性预检、cloud-managed），且属性预检与哈希不符两条还断言**第二次写入以同样理由再拒**、(f) post-skeleton 失败（`dataRoot/transactions` 是一个普通文件）断言**身份保留、骨架仍在、注册表行缺失**，并验证显式 `mem_admin(action="bind", mode="local")` 用**同一 projectId** 补上注册表行；`mem_log` 单列一条。**falsification**：`git archive 2e55641`（修复前的 `lib/`）只保留新测试文件 → 14/15 失败，唯一通过的是 cloud-managed 那条（它在 `vaultRoot()` 处就拒绝，与绑定路径无关）；`git archive 4cffa6e`（第 1 轮修复后、第 2 轮之前）→ 14 通过 / 1 失败，失败的正是不符的哈希那条，断言停在 `Missing expected rejection`（指针仍在磁盘上）。

### F2（小，本任务造成）P0 teardown 探针在 dogfood 当时 12/13

`env -u DSH_HOME node test/p0/run-teardown-probe.mjs` 在创建 vault 之前是 13/13，现在稳定（连跑两次）报：

```
  FAIL default-vault-absent — ~/Documents/dsh-memory does not exist
run-teardown-probe: 1 FAILED (13 assertion(s))     # exit 1
```

唯一红项就是「默认 vault 不存在」这条**前置断言**，而本任务按批准创建了该 vault，所以它必然红。12 条行为断言（含 T18b 机制的 6 条）全部仍 PASS。`test/p0/` 不在 `npm test` 里，所以套件不受影响。**没有修**：这是 test-only 的改动，且会把探针的护栏从「不存在」改成「前后指纹不变」，属于需要自己 TDD 与评审的改动，不在 Task 20 的改动面内；建议在 `lib/` 那个缺陷一起处理时把前置断言改成 before/after 指纹。

**处理结果（Task 20b）**：按上面的建议改了前置断言，未动其余 12 条行为断言：`default-vault-absent`（要求 `~/Documents/dsh-memory` 不存在）换成 `default-vault-unchanged`——探针开始前后各取一次该目录的**元数据指纹**（`lstat` 遍历：每个条目的相对路径 + 类型 + 大小；符号链接记为叶子 `-> target` 而**不跟随**，因此不会成环，也不会把别人的树算成证据；目录不存在时记为 `absent`），要求两次相同。不读任何笔记正文，也**不比较 mtime**（同步或编辑器 touch 不是本探针的写入，放进来只会让断言抖动；条目集合与大小仍能抓住新建/删除/改名/改写）。护栏的含义没变（这个探针不写真实 vault），但不再要求 vault 不存在，因此现在也适用于 vault 已存在的这台机器。实测：`env -u DSH_HOME node test/p0/run-teardown-probe.mjs` → `run-teardown-probe: OK (13 assertion(s))`，exit 0。

### F3（观察）浅回合也会产出候选，落在收件箱

只让模型 `ls -a` 并说一句话的回合蒸馏出 2 个候选，放行后进 `收件箱/`。`minConfidence` 把它挡在记忆目录外是设计意图，但插件不删，用户需要自己清收件箱。本次 `收件箱/` 因此有 4 篇。值得在 README 的收件箱说明里点明"导航类回合也可能进收件箱"。

### F4（观察）模型输出上限是真实运行参数

`maxOutputTokens` 2000/4000 与 `maxItems` 3 各造成一次正确的拒绝（`truncated`、`too-many-items`），重试后才成功；`durationMs` 随输出长度从 1.4 s 涨到 18.7 s。默认值（4000/12）在这台机器上对长回合偏紧。已作为 `deferred` 的第二种成因写进 README 恢复表。

### F5（观察）真实环境没看到"低置信即不落记忆目录"之外的失真

17 个候选里 16 个 `active`、1 个 `provisional`（被降级的那条），`refusedCount` 全 0，没有 `foreign-target`、没有 `inbox-supersede-cleared`。也就是说本次没有触发路径边界/取代清空的拒绝分支——它们只有隔离套件的证据。

---

## 11. 证据卫生

- **不提交的东西**：真实 vault 的收据/队列（含模型生成的标题）、11 次会话的 `dsh` 日志（含推理与正文）、`/tmp/dshdogfood/` 全部中间物、隔离 runner 的记录 `/tmp/dshsmoke-task20.json`（模型通道真的写了笔记，含模型标题）。
- **保留但不提交的东西**：为了让人能独立复核本文件里的计数，`/tmp/dshdogfood/{home,evidence,*.log}`（隔离 home 的收据/队列 + seq→kind 元数据快照 + 会话日志）与隔离 runner 的 baseDir、`/tmp/dshsmoke-task20.json` **都留在 `/tmp` 不动**，它们不在仓库里、也不会被任何提交带走。复核者可用 `/tmp/dshdogfood/inspect.mjs`、`verify-gate.mjs`、`tree-hash.mjs` 复算 §4/§6/§7 的数字；复用完请自行删除（这些文件含模型生成内容，不要复制进仓库）。
- **提交的东西**：仅四字段指针 `.obsidian-mem`、本报告、`README.md`/`CHANGELOG.md` 的实测修正，共 4 个路径；`lib/`、`test/`、`scripts/`、`package.json`、两个 manifest 与验证 commit `bc8ef69` 逐字节相同。
- 本文件与提交内容里对凭据值的 4 字符前缀命中为 **0**。
- 帮助复核者可复算的计数：receipts 8（`dry-run` 3 / `applied` 3 / `no-memory` 2）；items 17（`inbox: true` 6）；`downgrades` 1（`accepted-without-user-confirmation`）；`refusedCount` 0；dry-run outputTokens 1950 / 2122 / 4549；applied outputTokens 2358 / 1116 / 835；vault `*.md` 24 篇；`_meta/.history/` 14 个 txId；真实 home 指纹 9 项全同。
