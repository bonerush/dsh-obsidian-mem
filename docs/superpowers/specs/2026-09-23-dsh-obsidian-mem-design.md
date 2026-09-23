# dsh-obsidian-mem 设计文档

- **日期**：2026-09-23
- **状态**：已批准（用户批准于 2026-09-23，准入实施计划阶段）
- **路径**：`docs/superpowers/specs/2026-09-23-dsh-obsidian-mem-design.md`
- **一句话**：一个 DeepSeek Harness（DSH）主机侧插件，把 Obsidian vault 变成每个项目的**文档底座 + 长期记忆底座**，人可读、可版本化、可脱离 AI 独立运作。

---

## 1. 背景与目标

### 1.1 需求（用户原话归纳）

> 在后续每个项目中撰写的**所有文档**和项目所必须的**记忆**，都使用 Obsidian 来管理。

拆成可验收的目标：

| # | 目标 | 验收方式 |
|---|---|---|
| G1 | Agent 在任意项目里写的项目文档，落在 Obsidian vault 中，在 Obsidian 里可正常浏览、双链、搜索 | 打开 vault 能看到笔记；`[[链接]]` 可解析；`index.md` MOC 可导航 |
| G2 | 项目长期记忆（决策、踩坑、约定、任务态、环境事实）自动沉淀，并在新会话开始时自动回到上下文 | 新会话首轮即携带记忆简报；`mem_search` 能命中旧决策 |
| G3 | 会话结束**全自动**提炼写回，无需人工触发 | 一次真实会话结束后，vault 中出现结构化笔记；`_meta/log.md` 有收据 |
| G4 | 记忆有生命周期：可被取代、可标争议、不会静默失真 | `supersede` 产生新笔记 + 旧笔记 `status: superseded`；无删除 |
| G5 | 方法论可复用、可脱离本插件运转 | 随包技能 `skills/obsidian-mem/SKILL.md` 同步到 `~/.dsh/skills/obsidian-mem/` |
| G6 | 参考 Hindsight 的设计思路（自动摄取、来源标记、按项目划分记忆边界、按预算注入） | 见 §6 / §10，逐条对应 |

### 1.2 非目标（明确不做）

- 不做 Obsidian 社区插件（不写 TypeScript、不跑在 Obsidian 内部、不依赖 Obsidian 运行）。
- 不依赖 Obsidian Local REST API / MCP server（需要 App 常驻 + 自签证书 + 端口 + API key；headless 场景不可用）。
- 不做向量检索 / embedding 服务（1k 量级笔记下 FTS5 + 链接图足够；保持「纯文本 + 无外部服务」）。
- 不做多用户并发写入治理（事务/提案/评审那套对单人编码 agent 是过度设计）。
- v1 不做浏览器 UI 面板。
- **不写「关于用户资料的见解」**：调研引述的最强反对意见是 *"A summary of a PDF is noise. An insight I had from reading the PDF is signal."*（经由 kepano）与 Späti 的 *Keep AI Out of Your (Obsidian) Vault*（*"I don't know anymore whether the content was written by me or by an AI"*）。本插件只写**机器自有域**（项目决策、约定、踩坑、任务态、项目文档）；对用户从文献/网页/书籍得来的内容只做**引用与链接**，绝不代写「知识」或「见解」。
- **不重组既有目录**：调研实测在 Obsidian 内移动文件夹会锁住 App 数分钟并触发 Sync 全量重传；bootstrap 只**创建**缺失项，`mem_lint` 只**报告**，永不移动/重命名用户的目录。
- **不使用符号链接**（Obsidian 官方明确劝阻，且已有竞品因此设计失败）。

---

## 2. 决策记录

| # | 决策 | 备选与被否原因 |
|---|---|---|
| **D1** | **单一全局 vault**：所有项目文档与记忆都进 `~/Documents/dsh-memory` | 曾考虑①混合制（仓库内 `doc/` 作项目 vault + 全局 vault 沉淀）②仓库外每项目一 vault。调研（`research/obsidian-agent-memory-prior-art.md` §5.4）指出混合制等于「两套 schema、两条检索路径」，正是本插件要消除的碎片化；且只有全局 vault 能提供跨项目召回与「人类只开一个窗口」。用户最终选择单一全局 vault。代价见 §16。 |
| **D2** | 全局 vault 与个人知识库 `~/Documents/knowledge` **完全隔离** | 个人库是用户手写、精心策展的资产，agent 产物体量大、信噪比低（调研：`dsh-obsidian-sync` 式的原始归档会让检索质量随体量衰减）。 |
| **D3** | 仓库侧只提交一个指针文件 `.obsidian-mem` | 15 个竞品全部靠 `basename(git rev-parse --show-toplevel)` 推断项目，重命名 / fork / monorepo / worktree 必失联。调研原文：显式 repo↔vault 绑定是「the single highest-value structural decision available，**no surveyed project does it**」。 |
| **D4** | 会话结束**全自动**提炼写回 | 用户明确选择全自动（备选是「策展优先：只读自动 + 写入显式」）。因生态共识是「静默改用户笔记」为头号错误，本方案以 §10 的硬边界补偿。 |
| **D5** | 记忆与文档**同库不同域**：`项目/<slug>/` 放项目域，`方法/` 与 `_meta/` 放跨项目域 | 等价于 Hindsight 的「bank per repo」，但人类可读、可 diff。 |
| **D6** | 检索用 **SQLite FTS5 + CJK bigram**，索引库放 vault **之外** | 调研：`dsh-plugin-vault-memory` 与 `dsh-obsidian-sync` 独立收敛到同一答案；FTS5 的 `unicode61` 会把整段中文当**一个** token、`trigram` 漏 2 字词，两侧都必须预分词。索引入 vault 会污染 vault 并进入 Obsidian Sync。 |
| **D7** | 禁用 Hindsight（用户选择），Obsidian 为唯一记忆层 | 两套自动记忆会互相污染并重复占用上下文。**不代用户改配置**，只给一行 patch 步骤（§13.3）。 |
| **D8** | 文档镜像回仓库默认**关闭**（`docMirror: off`） | 默认把个人 vault 内容写进他人可见的仓库有泄漏风险；需要时一个开关打开，不需重构。 |
| **D9** | 随包资产（技能）幂等同步到 `~/.dsh/skills/obsidian-mem/` | 复用 `dsh-ultramath` 已验证的 bundle 资产同步机制；技能不依赖 npm 包被自动扫描。 |

---

## 3. 调研依据（决定设计的硬约束）

来源：`research/` 下 4 份报告（共 6400+ 行，其中 102 条引用 URL、28 项目对照）。以下每条都直接约束实现。

| # | 发现 | 约束 |
|---|---|---|
| R1 | 该赛道已有 **8 个** npm 已发布的 DSH 插件（`dsh-obsidian`、`dsh-plugin-vault-memory`、`dsh-obsidian-sync`、`dsh-client-ui-obsidian-memory`、`@qiqiangvae/dsh-obsidian`、`dsh-plugin-wiki-tools`、`dsh-math-memory`、`obsidian-dsh-acp`） | 差异化只能来自**显式 repo↔vault 绑定**与**记忆生命周期**，不能来自「给 agent 一个 vault 工具」 |
| R2 | 实践者复盘（Railly，agent-brain v2）：*"I made context too big… the deletion was the feature. Persistent memory does not mean permanent attention."* | 注入必须**预算化 + 导航式**；正文按需读；热层必须能归档 |
| R3 | CJK 检索：`unicode61` 整段中文=1 token；`trigram` 漏 2 字词 | 索引与查询两侧都做**重叠二元分词** |
| R4 | Obsidian 属性（properties）类型是 **vault 全局按名注册**：一旦某属性名被定为 Number，全 vault 同名属性都变 Number | 永不改用户既有属性的类型；写入前先读既有同名属性的类型 |
| R5 | frontmatter 中的 wikilink **必须加引号**：`related: "[[Note]]"`、数组内 `- "[[Note]]"` | 写入器必须**序列化** YAML，不能拼字符串（这是 agent 破坏笔记的头号方式） |
| R6 | 更新笔记时应**保留未知键**（`cssclasses`、插件字段、Dataview 内联字段） | 只做**逐键外科式**更新，禁止整体重写 frontmatter |
| R7 | `[[链接]]` 默认按**最短路径/basename** 解析，重名会产生歧义 | 目录内有重名 basename 时改用**路径限定**链接；`mem_lint` 检测重名 |
| R8 | 索引若在后台扫描未完成时就被读取，会注入「空记忆」的假象 | 注入前必须有 **ready 屏障**（`waitReady()`） |
| R9 | DSH 插件陷阱（本地实测反推，`research/dsh-plugin-api-reference.md`）：`ctx.logger` **不落盘**（仅 1000 条内存环形缓冲，warn/debug 都不进）、改插件源码**必须重启**、patch 的 `config` **整体替换不深合并**、对可选服务硬 `inject` 会让插件永久 PENDING | 验证手段用 `--dump-config` 与 GUI 插件清单，不靠日志；配置显式写全；可选服务用 `ctx.get()` |
| R10 | 主流三类严肃设计（`claude-obsidian`、`obsidian-memory-for-ai`、`agent-brain`）**独立收敛到按 `type` 路由** | 目录按 **type** 分（文档/决策/踩坑/日志/收件箱），topic 交给链接与标签 |
| R11 | MOC（Maps of Content）是「最适合注入的形状」：短、策展、链接密集，回答"从哪开始"而不含内容 | 每个目录维护 `index.md` MOC；项目 hub 即注入入口 |
| R12 | 记忆生命周期最佳实现（`obsidian-memory-for-ai` v4.1）：一份事实一文件、取代而非覆盖、`valid_from/valid_to/recorded_at` 双时间、`supersedes` 链、`assertion`、`trust`、`confidence`、`review_after`、字符预算的 `_views/bootstrap.md` | §6.4 的 schema 与 §7 的预算注入直接采用其精简版 |
| R13 | 来源标记（Hindsight `retainTags`/`retainMetadata`：`source:chat`、`harness:<id>`、`knowledge:<kind>`）用于回答「这条记忆哪来的」 | 每篇笔记带 `source` / `session` / `harness` 来源字段（§6.4） |
| R14 | 矛盾处理原则（`claude-obsidian`）：*"Preserve contradictions and source lineage; do not silently select a winner."* | 冲突标记 `status: contested` 并保留双方证据链接，而不是覆盖 |
| R15 | **本机实测**：Obsidian 关闭时 `obsidian version` 打印 *"The CLI is unable to find Obsidian…"* 并 **exit 1**（并不像其文档所称会启动 App）；REST API 是 renderer 内 Express，关闭时 `ECONNREFUSED` | **纯文件系统是唯一可靠通路**；CLI/REST 只能作为「App 恰好开着」时的可选加速器，v1 不依赖 |
| R16 | frontmatter 具体陷阱（本机实测）：单数键 `tag:`/`alias:`/`cssclass:` 自 1.9 起失效；`tags` **必须是列表**（`tags: foo` 不被识别）；`#` 在 YAML 里是注释起始；frontmatter 必须从**字节 0** 开始、无 BOM、必须闭合；`toISOString()` 的日期**不保证被解析**；Obsidian 在模板插入等场景会**重排 frontmatter 并丢注释** | 写入器：永不写 BOM、首字节即 `---`、写后校验闭合；日期统一 `YYYY-MM-DD`（需要时间时 `YYYY-MM-DD HH:mm:ss`）；`tags` 只写列表；**外科式拼接**，不做全文重写 |
| R17 | **数据丢失路径（本机实测）**：iCloud 逐出（eviction）后文件为 dataless，`fs.readFileSync` 或透明下载或硬失败 `EDEADLK`（取决于 `getiopolicy_np`，交互=ON、launchd=OFF，子进程继承父策略）；dataless 对 `fs.statSync` 不可见（判据 `blocks===0 && size>0`）。**Obsidian Sync 会把离载文件读作「已删除」并从远端移除** | vault 必须放**本地磁盘**，明确不建议 iCloud/Dropbox；读取时若 `blocks===0 && size>0` 判为 dataless 并**拒绝当作空文件**处理 |
| R18 | 属性类型按**属性名全 vault 全局**注册；`getAllPropertyInfos()` 实测造成 **280 ms renderer 卡顿 / 2 s** 级开销 | **封闭属性词表**：只使用 §6.4 列出的字段名，绝不发明新属性；不调用全量属性 API |
| R19 | 注入失败的共识：`dsh-obsidian-sync` 零注入、`dsh-math-memory` 导航式 ≤18k 字符、`obsidian-memory-for-ai` 6k 字符 bootstrap、`hippocampus` hot.md ≤500 词；并佐以 Chroma 的 *Context Rot*（18 个 LLM，2025） | 会话开始快照默认 **6000 字符**（而非 9000）；热**文件**容量仍是 9000（67% 即 6000 触发归档），**存储容量 ≠ 注入预算** |
| R20 | **专用 agent vault 的机制性论证**（kepano）：*"Keep your personal vault clean and create a messy vault for your agents… Search, bases, quick switcher, backlinks, graph, etc., will no longer be scoped to your knowledge."* 关键在于 Obsidian 的检索面是 **vault 级、没有「作者」维度**——无法一次排除某子树出图/反链/快速切换/Bases。**因此「在人 vault 里开一个 agent 子目录」等于没有隔离。** 判定规则：用户若**没有**个人 vault，单 vault 亦可；有则必须分开（**探测而非假设**）。 | **验证 D2**：`~/Documents/dsh-memory` 与人库 `~/Documents/knowledge` 必须完全分离。代价要写清：Obsidian 链接是 **vault 内**的，跨 vault 只能退化为 `obsidian://open?vault=…&file=…` URI——项目记忆与个人 Zettelkasten 本就是不同域，可接受 |
| R21 | **YAML 解析器真相（推翻常见建议）**：Obsidian 用 **eemeli/`yaml` v2.7.0 + YAML 1.2 core schema**（不是 js-yaml，也不是 YAML 1.1）。因此 `yes/no/on/off` 是**字符串**；`1_000` 是字符串；**`0123` → 十进制 `123`，前导零被静默丢弃**（不是八进制 83）——这是标识符/编号的静默碰撞 | **写入器必须与 Obsidian 同族解析器（`yaml` v2.x）**；**所有字符串值一律加引号**；绝不写未加引号的前导零数字（如 `ADR-0123` 应作字符串或用 `ADR-123`） |
| R22 | Obsidian 自己的**可移植文件名政策**（比任何 OS 都严）：避免 `/ \ : * ? " < > \|`、结尾空格或句点、Windows 设备名、链接字符 `# ^ [ ]`，以及「多个连续句点」与 emoji（部分 Android 设备拒绝）。长度上：macOS 是 **255 UTF-16 code unit**，而 **Linux ext4 是 255 字节**（对中文/emoji 才是约束） | 文件名清洗必须覆盖上述全集；**预算 ≤200 UTF-8 字节**。改用 Markdown 链接**不能**救回链接破坏字符（Obsidian 只转义反斜杠/控制符/空格），**只能在写入时排除** |
| R23 | frontmatter 普查（32 仓库 / 7399 文件）：`links`/`see also`/`sources`/`updated` 出现次数为 **0**；`created`/`updated` 是社区惯例且常损坏（33 个 `created` 中 22 个是未渲染占位符）；有记录的一次批量编辑**重置了全部 53 篇笔记的 `file.ctime`**，导致基于日期的 Base 视图失效 | **显式 frontmatter 值是唯一可信来源**，绝不用文件系统时间戳替代；**绝不为了「刷新元数据」而重写文件**（只在内容真正变化时更新 `updated`）。索引用 mtime 做变更检测是允许的（派生数据），但不得回写进 frontmatter |

---

## 4. 架构总览

```
┌──────────────────────── DSH 主机进程 ────────────────────────┐
│  dsh-obsidian-mem（host 半侧，纯 node ESM，无浏览器半侧）        │
│                                                              │
│  apply(ctx)                                                  │
│   ├─ Vault 解析 & 绑定      .obsidian-mem ⇄ 项目/<slug>/       │
│   ├─ 引导 bootstrap         首次自动建骨架 + MOC               │
│   ├─ 索引 Index             node:sqlite FTS5 + CJK bigram     │
│   ├─ 工具 tools.register    mem_brief / mem_search / …        │
│   ├─ 钩子 ctx.on            session-start / pre-step /        │
│   │                         turn-stopping / disposed          │
│   ├─ systemPrompt.section   记忆平面公告 + 路由规则            │
│   └─ 资产同步                skills/ → ~/.dsh/skills/obsidian-mem│
└───────────────┬──────────────────────────────┬───────────────┘
                │                              │
   读/写纯文本 .md│                              │按需读
                ▼                              ▼
   ~/Documents/dsh-memory（独立 git 仓库）    ~/.dsh/data/obsidian-mem/
   ├─ _meta/{user.md, 项目注册表.md, log.md}   index-<vaultHash>.db
   ├─ 方法/                                    （索引在 vault 外，
   └─ 项目/<slug>/{index.md, _meta/hot.md,       不污染 vault、不进同步）
        文档/, 决策/, 踩坑/, 日志/, 收件箱/, 约定.md}
```

**分层职责**：vault 是唯一权威副本（source of truth）；索引是可重建的派生数据；插件不持有隐藏状态——删掉 `~/.dsh/data/obsidian-mem/` 只是重建索引。

**vault 位置约束（R17）**：必须在**本地磁盘**、非 iCloud/Dropbox 目录。iCloud 离载文件会导致读取硬失败，且 **Obsidian Sync 会把离载文件读作「已删除」并从远端移除**——这是调研中唯一确认的数据丢失路径。默认路径 `~/Documents/dsh-memory` 满足该约束（`~/Documents` 未启用 iCloud 同步时）。

---

## 5. Vault 布局与绑定协议

### 5.1 目录结构

```
~/Documents/dsh-memory/                 # 独立 git 仓库（插件首次运行 git init）
├── .gitignore                          # 忽略 .obsidian/workspace*.json 等易变文件
├── _meta/
│   ├── user.md                         # 用户画像 / 沟通偏好 / 环境事实（全局热记忆）
│   ├── 项目注册表.md                    # 所有项目 hub 的索引（MOC）
│   ├── log.md                          # 写入收据（append-only，最新在上）
│   └── Lint Report <date>.md           # mem_lint 输出
├── 方法/                               # 跨项目可复用方法论（promote 目标）
│   └── <slug>.md
└── 项目/
    └── <slug>/                         # 一个项目域 = 一个「记忆 bank」
        ├── index.md                    # 项目 hub / MOC（注入入口）
        ├── 约定.md                      # 不变量与约定（超预算升入 hot.md）
        ├── _meta/hot.md                # 热记忆（≤ budget，>67% 触发归档）
        ├── 文档/                        # 项目文档 + index.md MOC
        ├── 决策/                        # ADR 式决策 + index.md MOC
        ├── 踩坑/                        # 症状/根因/修复/证据 + index.md MOC
        ├── 日志/YYYY-MM-DD.md           # append-only 会话日志（冷层）
        └── 收件箱/                      # 未定归属 / 低置信候选
```

约定：目录层级 **≤3 层**；目录名按 **type**（R10）；topic 关系交给 `[[链接]]` 与 `tags`。

### 5.2 绑定协议（`.obsidian-mem`）

仓库根下的 `.obsidian-mem`（**提交进仓库**，JSON，极小）：

```json
{
  "slug": "dsh-obsidian-mem",
  "vault": "~/Documents/dsh-memory",
  "remote": "git@github.com:user/dsh-obsidian-mem.git",
  "boundAt": "2026-09-23T07:51:00Z",
  "schema": 1
}
```

解析顺序（**显式优先，绝不猜**）：

1. 仓库根存在 `.obsidian-mem` → 用它（校验 `项目/<slug>/` 存在，不存在则建）。
2. 否则向上找 `.git` 得仓库根 → 生成 slug：`basename(root)`；若 vault 中已存在**同 slug 但 remote 不同**的项目 → 追加短哈希 `basename-3f9a`。
3. 写 `.obsidian-mem` + 建骨架 + 在 `_meta/项目注册表.md` 登记。
4. 非 git 目录（如临时目录）→ 使用 `项目/_scratch/`，不写指针文件。

`mem_bind` 工具可查看/重建绑定。**这是本插件与 15 个竞品的核心差异**（R1/D3）。

### 5.3 引导（bootstrap）

首次进入一个项目时自动创建：项目目录骨架、`index.md`（含 frontmatter 与空章节模板）、`_meta/hot.md`（含填写提示）、各 type 目录的 `index.md`、`约定.md`，并登记注册表。
**幂等**：已存在的文件永不覆盖；只补缺失项。若 vault 根不存在则创建并 `git init`（不自动 commit、不自动配置 remote）。

---

## 6. 记忆模型

### 6.1 三层（参考用户提供的三层分级记忆方法论）

| 层 | 载体 | 访问方式 | 预算 |
|---|---|---|---|
| **热** | `项目/<slug>/_meta/hot.md` + `_meta/user.md` | 会话开始注入一次；热文件变更时注入增量 | 热**文件**容量 `hotCapacityChars`（默认 9000）；注入**预算** `briefBudgetChars`（默认 6000）；热文件 > `hotArchiveRatio`（默认 67%）触发归档 |
| **温** | vault 全部笔记 | 按需 `mem_search` → `mem_read` | 不注入 |
| **冷** | `日志/YYYY-MM-DD.md` | 只搜索，不注入 | 不注入 |

热层只放**高频变动且每次都需要**的内容：当前活跃工作、强约束、最近被纠正的偏好。稳定下来的条目归档为温层笔记，热层只留指针。

### 6.2 内容路由（type → 落点）

| type | 落点 | 说明 |
|---|---|---|
| `doc` | `文档/<标题>.md` + 更新 `文档/index.md` | 项目文档（设计、报告、指南、方案） |
| `decision` | `决策/ADR-<n>-<slug>.md` | Context / Decision / Alternatives / Consequences；`status: proposed\|accepted\|superseded` |
| `gotcha` | `踩坑/<slug>.md` | 症状 / 根因 / 修复 / 证据——价值最高、体量最小 |
| `convention` / `invariant` | `约定.md`（超预算升入 `hot.md`） | 「这个仓库部署到 Windows」「测试是 `pnpm test`」「不要碰 legacy/」 |
| `session-log` | `日志/YYYY-MM-DD.md` | append-only，按会话分节，幂等（同 session id 不重复写） |
| `hub` | `index.md` | MOC，注入入口 |
| `glossary` | `文档/术语表.md` | 领域词表 |
| 未定 / 低置信 | `收件箱/<slug>.md` | 待人工分类 |
| 跨项目方法 | 提升到 `方法/<slug>.md` | 由 `mem_promote` 显式触发 |
| 用户 / 环境 | `_meta/user.md` | 全局域 |

### 6.3 生命周期规则

- **取代而非覆盖（supersede）**：结论变化时写新笔记，旧笔记置 `status: superseded` + `superseded_by: "[[新笔记]]"`；新笔记写 `supersedes: "[[旧笔记]]"`。**永不删除**，历史可查。
- **矛盾不选赢家**：无法判定时标 `status: contested`，保留双方证据链接（R14）。
- **可信度分级**：`assertion: stated | inferred | observed`（用户说的 / 推断的 / 实测的）+ `confidence: 0..1`。
- **过期复核**：`review_after: YYYY-MM-DD`；`mem_lint` 输出过期清单。
- **来源可追**：`source: human | chat | git | agent`、`session:`、`harness: dsh`（R13）。

### 6.4 笔记 schema

**基线 frontmatter**（全部笔记）：

```yaml
---
id: dec-xeros-adr-0007          # 稳定身份：去重/upsert 键，改名不改 id
type: decision                  # doc|decision|gotcha|convention|session-log|hub|glossary|method|hot
title: 调度器改为可插拔后端
status: active                  # active|proposed|accepted|superseded|deprecated|provisional|contested|archived
created: 2026-09-23
updated: 2026-09-23
tags: [dsh-mem/decision, project/xeros]
project: xeros                  # 项目域归属
source: chat                    # human|chat|git|agent
session: 20260923-155100-a1b2   # 产生它的会话（可空）
harness: dsh
trust: agent                    # owner|agent|external —— 谁写的（Hindsight 式来源标记）
confidence: 0.9                 # 0..1，可空
assertion: stated               # stated|inferred|observed，可空
supersedes: "[[决策/ADR-0003-old-scheduler]]"   # 必须加引号（R5）
superseded_by: null
review_after: 2027-03-23        # 可空
---
```

**封闭属性词表**（R18）：上表就是全部允许的属性名；实现中不得新增属性名（Obsidian 按属性名全 vault 注册类型，新名字一旦写错类型会污染整个 vault）。用户既有笔记中的其他属性名一律原样保留、不改类型。

规则：
- 只用 Obsidian 原生属性类型；`tags` 是**列表**（`tags: foo` 不被识别）；wikilink 值一律**加引号**（R5）。
- **序列化器用 `yaml` v2.x**（与 Obsidian 同族解析器 / YAML 1.2 core），**所有字符串值一律加引号**；绝不写未加引号的**前导零**数字（`0123` 会被静默吞成 `123`，R21）。
- **日期一律 `YYYY-MM-DD`**（需要时间时 `YYYY-MM-DD HH:mm:ss`），**不用** `toISOString()`（R16）。
- **frontmatter 从字节 0 开始、无 BOM、必须闭合**；写入器写后自校验（R16）。
- 更新时**逐键合并**，保留未知键（R6）；不改动同名属性的既有类型（R4）；**外科式拼接**，绝不整体重写（Obsidian 自身会重排 frontmatter 并丢注释）。
- **显式 frontmatter 值是日期的唯一来源**：不用文件系统时间戳推断；**绝不为了「刷新元数据」而重写文件**（R23）；`updated` 只在正文真正变化时更新。
- 生成域（`index.md` 的自动区块、`Lint Report`）带 `<!-- generated … -->` 标记，人可手改非生成区块。

**文件名与链接清洗**（R22，写入时强制）：

- 禁用字符集：`/ \ : * ? " < > |`、`#`、`^`、`[`、`]`、结尾空格或句点、连续多句点、emoji、Windows 保留设备名（`CON`/`PRN`/`AUX`/`NUL`/`COM1`…）。
- 名字长度 **≤200 UTF-8 字节**（Linux ext4 的 255 **字节**才是真约束，不是 macOS 的 255 UTF-16 单元）。
- 清洗是**唯一**安全策略：改用 Markdown 链接不能救回这些字符（Obsidian 只转义反斜杠、控制符与空格）。
- 同目录内 basename 必须唯一；冲突时追加短哈希后缀，并在链接歧义处使用**路径限定** wikilink（R7）。

**id 生成规则**（消除歧义，实现按此执行）：

```
id = "<type 三字母前缀>-<标题 slug 截断 40>-<sha256(项目 slug + 标题 + created)[0:8]>"
前缀：doc→doc, decision→dec, gotcha→got, convention→con, session-log→log,
      hub→hub, glossary→glo, method→met
```

- 显式传入 `id` 时以传入值为准（用于 upsert 既有笔记）。
- 未传 `id` 时按上式生成：同项目 + 同标题 + 同日期 → 幂等命中同一篇；不同日期 → 视为新笔记（需要取代旧结论时由调用方显式给 `supersedes`）。
- **ADR 编号分配**：`决策/ADR-<n>-<slug>.md` 的 `n` 在写入时取该项目 `决策/` 下现有 `ADR-*` 的最大编号 +1（写者唯一，无并发分配）。编号仅用于人读排序，**身份始终是 `id`**，改名或重排编号不影响引用。

---

## 7. 检索与索引

- **后端**：`node:sqlite`（`DatabaseSync`，Node ≥22.5，零原生依赖）FTS5；失败时回退到「全盘扫描 + 子串匹配」。
- **位置**：`~/.dsh/data/obsidian-mem/index-<sha256(vaultPath)>.db`（WAL）。索引在 vault 之外，不污染 vault、不进 Obsidian 同步（R6 先例 / 竞品已验证）。
- **分词**：拉丁小写化；**CJK 连续段切成重叠二元组**（索引与查询两侧都切），FTS 查询按 AND 组合并做引号转义（R3）。
- **表**：`notes(path, mtime, size, id, type, title, status, project, updated, hash)`、`notes_fts(title, body, tokens)`、`fm_kv(note_id, key, value)`、`tags(note_id, tag)`、`links(src_id, target, resolved_id)`、`kv(key, value)`（含 `schema_version`、`last_scan`）。
- **增量**：mtime + size 变化才重解析；`_meta/` 下的生成文件与 `收件箱/` 参与索引但权重降低。
- **一致性**：`mem_lint` 做一次 file↔db 核对（孤儿行、缺失行、`dead links`）。
- **ready 屏障**：`waitReady()`——注入与首次检索必须等首次全量扫描完成，避免「空记忆」假象（R8）。
- **排序**：BM25 分数 × 类型权重（决策/踩坑 > 文档 > 日志）× 新鲜度衰减；返回带 `path / 标题 / 命中片段 / frontmatter 摘要`。
- **不依赖 frontmatter 完整性**：解析失败的文件仍可按纯文本检索（调研：真实 vault 仅 ~17% 笔记有 frontmatter）。

---

## 8. 注入策略

**只注入导航与关键约束**（R2/R11/R12），不注入正文。

会话开始（`agent/session-start` → `agent.inject(msg)`，消息 `source: {kind:'plugin', plugin:'obsidian-mem', form:'recall'}`）注入一份简报：

```
1. 用户与环境（_meta/user.md 精炼版）
2. 项目标识与绑定（slug、repo remote、绑定时间）
3. 项目 hub index.md 的**大纲**（标题树 + 链接，正文不展开）
4. 约定.md 的条目（不变量、命令、禁忌）
5. 最近 N 条决策 / 踩坑的标题 + 路径（默认 N=5，按 updated 倒序）
6. 当前任务态（hot.md 的「进行中」区）
7. 新鲜度与预算脚注：<!-- brief: 3120/6000 chars, hot 3120/9000, updated 2026-09-22, index ready -->
```

- **存储容量 ≠ 注入预算**（R19）：热文件最多可写 9000 字符，但每会话注入的简报硬上限 `briefBudgetChars`（默认 **6000**）；超预算按优先级截断（约定 > 项目 hub > 决策/踩坑标题 > 用户画像）。
- 每次注入都在脚注报告实际用量，模型可感知「还有多少预算」。
- `agent/pre-step`（`prepend: true`）：仅当 `hot.md` 的 mtime+hash 在会话内发生变化时注入**增量**（同样有硬上限）。
- 简报内容**每会话只注入一次**，不做每轮重注（避免上下文单调膨胀）。
- 若索引未就绪：注入「记忆正在建立索引」的说明，而不是注入空简报（R8）。

---

## 9. 工具面（`mem_*`）

`tools.register(defineTool({...}))`；`parameters` 用 DSH 简写 DSL（逐属性 `required: true`，对象节点必须写 `additionalProperties`）。

**工具面刻意收敛到 6 个**：工具 schema 每轮都在上下文里，竞品调研的结论是「5 个小工具」优于大工具面（`dsh-obsidian` 的 12 个工具是纯管道、没有记忆模型）。高频动作用专用工具保证可发现性，低频维护动作折叠进 `mem_admin`。

| 工具 | 入参 | 行为 |
|---|---|---|
| `mem_search` | `query`（必）, `scope`（`project`\|`global`\|`all`，默认 `all`）, `type`, `project`, `limit`（默认 8） | 统一检索两个域，返回路径 + 标题 + 片段 + frontmatter 摘要 + 分数 |
| `mem_read` | `path`（必）, `section`（可选标题） | 读取笔记（可只取某章节），返回正文 + frontmatter |
| `mem_write` | `type`（必）, `title`（必）, `body`（必）, `tags`/`status`/`confidence`/`assertion`/`supersedes`/`id`（可选） | **路由式写入**：type→目录、frontmatter 补全、id 去重 upsert、MOC 登记、`_meta/log.md` 收据、索引更新、supersede 时同步旧笔记状态 |
| `mem_log` | `text`（必）, `session`?/`section`? | 追加到当日 `日志/YYYY-MM-DD.md`（按会话分节、幂等）；`section: hot` 时追加到 `_meta/hot.md` 的指定区块 |
| `mem_brief` | — | 返回当前热简报（与注入同源，便于模型主动重读或核对预算） |
| `mem_admin` | `action`（必：`lint`\|`index`\|`bind`\|`projects`\|`promote`）, `path`?/`query`?/`rebuild`?/`write`? | 低频维护：体检报告 / 索引状态与重建 / 查看重建绑定 / 项目清单与跨项目检索 / 提升为跨项目方法 |

**工具只做「建议 + 受控写入」**：任何对**人类笔记**的改动（`source: human` 或 `trust: owner`）一律拒绝，改为建议写入收件箱（§10.3）。

---

## 10. 自动提炼（会话结束写回）与安全边界

### 10.1 链路

```
agent/turn-stopping ──► 标记会话脏（不阻塞回合）
        │
        ├─ 空闲 debounce（captureIdleMs，默认 90s）──┐
        └─ agent/disposed ──────────────────────────┤
                                                    ▼
                        守卫：单飞（同项目同时只跑一个）、转写过短跳过、
                              冷却期、dryRun 检查
                                                    ▼
              读 session.snapshotEvents()（user/message、assistant/message、tool/call）
                                                    ▼
              提炼器（subagent 或一次 llm.stream），严格 JSON 输出 + schema 校验
                                                    ▼
              应用：按 type 路由 → mem_write 同一路径 → 去重/取代/低置信入收件箱
                                                    ▼
              收据写 _meta/log.md（session id、条目数、每条落点）
```

### 10.2 提炼输出契约（严格 JSON）

```json
{ "items": [
  { "type": "decision|gotcha|convention|glossary|doc",
    "title": "…", "body": "markdown，含证据与文件路径",
    "tags": ["…"], "confidence": 0.0, "assertion": "stated|inferred|observed",
    "supersedes": "路径或 null", "evidence": ["相对路径:行号"] }
] }
```

上限 `distill.maxItems`（默认 12）；`confidence < distill.minConfidence`（默认 0.5）→ 收件箱。空结果合法（一次会话不产生记忆是正常的）。

### 10.3 硬边界（补偿 D4 的全自动风险）

1. **只写保留前缀**：`项目/<slug>/{文档,决策,踩坑,日志,收件箱,_meta}/`、`约定.md`、`方法/`、`_meta/`。越界写入直接拒绝并记收据。
2. **绝不修改 `source: human` 的笔记**：只允许「追加一个 `## 相关（agent）` 区块」或在收件箱提建议。这是「静默改用户笔记」这一头号错误的结构性防线。
3. **永不删除**：覆盖前旧文件移入 `项目/<slug>/_meta/.trash/<date>/`。
4. **可回滚**：vault 是独立 git 仓库；每次写入在 `_meta/log.md` 留收据（时间、会话、文件、动作）。
5. **可关**：`autoCapture` / `autoCapture.dryRun` 两个开关；dryRun 只写收据不落笔记，用于先观察一周。
6. **降级**：LLM 不可用或超时 → 至少写入确定性的会话日志条目（无 LLM 依赖），并在收据标注 `distill: skipped`。
7. **成本护栏**：每次提炼记录 token 估算与耗时到收据；超过 `distill.maxCostPerSession` 时跳过。
8. **机器自有域可隔离**：所有 agent 产物都在 `项目/<slug>/`、`方法/`、`_meta/` 之下且 `trust: agent`，用户若想彻底隔离，可把 `项目/` 加入 Obsidian 的「Excluded files」或在阅读时按 `trust` 过滤——**插件不写「关于用户资料的见解」**（§1.2）。
9. **离载文件保护**（R17）：读取前检查 `blocks===0 && size>0`（iCloud dataless 判据）；命中则记为「不可读」并跳过，**绝不当成空文件**覆盖写入。

---

## 11. 维护与治理

| 节奏 | 动作 | 触发方式 |
|---|---|---|
| 每次写入 | 收据 + MOC 登记 + 索引更新 | 自动（写入协议内） |
| 每次会话 | 热简报预算检查；hot 文件 >67% 时在简报里提示归档 | 自动 |
| 每周 | `mem_lint` 体检（孤儿、死链、重名、frontmatter 缺口、过期、file↔db 不一致、promote 候选） | 会话开始时若距上次 >7 天则提示模型运行（v1 不引入常驻定时器） |
| 需要时 | `mem_promote` 提升跨项目方法 | 模型或用户显式触发 |

> v1 不实现常驻定时器：DSH 无插件级 daemon 定时器（`dsh-schedule` 是会话内提醒工具），维护动作以「会话开始时提示 + 工具显式调用」实现。

---

## 12. 配置

`Config` 用 schemastery（Standard Schema v1），在 `apply` 前**急切校验**；行内 `config:` 为**整体替换**（R9）。同时用 `ctx.get('settings')` 注册可编辑命名空间（若 DSH 0.1.7 移除 `settings.register()`，退化为纯 row config，见 §16）。

```js
z.object({
  enabled: z.boolean().default(true),
  vaultPath: z.string().default('~/Documents/dsh-memory'),
  projectPointer: z.string().default('.obsidian-mem'),
  projectsDir: z.string().default('项目'),
  methodsDir: z.string().default('方法'),
  metaDir: z.string().default('_meta'),
  injectBrief: z.boolean().default(true),
  briefBudgetChars: z.number().default(6000),   // 注入预算（R19）
  hotCapacityChars: z.number().default(9000),   // 热文件容量（存储 ≠ 注入）
  hotArchiveRatio: z.number().default(0.67),
  autoCapture: z.boolean().default(true),
  captureIdleMs: z.number().default(90000),
  distill: z.object({
    mode: z.union([z.const('subagent'), z.const('llm')]).default('subagent'),
    provider: z.string().default(''),        // 空 = 继承默认模型路由
    model: z.string().default(''),
    maxItems: z.number().default(12),
    minConfidence: z.number().default(0.5),
    maxCostPerSession: z.number().default(0),   // 0 = 不限制
    dryRun: z.boolean().default(false),
  }),
  docMirror: z.union([z.const('off'), z.const('repo')]).default('off'),
  indexBackend: z.union([z.const('sqlite'), z.const('scan')]).default('sqlite'),
  ignoreGlobs: z.array(z.string()).default(['.obsidian/**', '.trash/**', '**/*.png', '**/*.pdf']),
  reservedPrefixes: z.array(z.string()).default(['文档', '决策', '踩坑', '日志', '收件箱', '_meta', '方法']),
})
```

---

## 13. 打包、安装与验证

### 13.1 包结构

```
dsh-obsidian-mem/
├── package.json          # type:module, main:lib/index.js, dsh.bundle.patch
├── cordis.patch.yml      # - insert: [{ id: obsidian-mem, name: dsh-obsidian-mem }]
├── dsh.plugin.json       # 市场元数据（id/version/main/contributes）
├── lib/
│   ├── index.js          # 插件入口：name/inject/Config/apply
│   ├── vault.js          # 路径解析、绑定、bootstrap
│   ├── frontmatter.js    # yaml v2 解析/序列化（引号规则、逐键合并、BOM/闭合校验）
│   ├── naming.js         # 文件名清洗（R22 全集）、长度预算、重名消解
│   ├── routing.js        # type→目录、命名与重名处理
│   ├── index-db.js       # FTS5 + CJK bigram + 增量
│   ├── tools.js          # mem_* 注册
│   ├── hooks.js          # 会话钩子与注入
│   ├── distill.js        # 会话结束提炼
│   ├── lint.js           # 体检
│   └── assets.js         # 技能幂等同步
├── skills/obsidian-mem/SKILL.md   # 随包技能（方法论）
├── test/                 # node --test
├── docs/                 # 本设计与实施计划
└── README.md / CHANGELOG.md / LICENSE(MIT) / AGENTS.md
```

**运行期依赖**（保持极小）：`schemastery`（配置 schema，peer 惯例同 `dsh-ultramath`）、`yaml` v2.x（frontmatter 序列化，必须与 Obsidian 同族解析器 R21）。索引用 Node 内置 `node:sqlite`（无原生依赖）；不需要 `better-sqlite3`、不需要 embedding 库、不需要 `chokidar`（用 mtime 扫描）。

### 13.2 安装与验证
```sh
dsh plugin --profile web add link:/Users/yukisala/subject/dsh-obsidian-mem
dsh --profile web --dump-config | grep -n obsidian-mem      # 确认行已装配
# 重启 dsh web；插件源码改动必须重启（R9）
```

**验证清单**（也是 §15 的验收用例）：行出现在 `--dump-config`；新会话首轮有记忆简报且 ≤ 预算；`mem_search "调度器"` 能命中中文笔记；`mem_write` 落点正确、MOC 与收据更新；supersede 生成两篇状态正确的笔记；一次真实会话后 vault 只新增保留前缀内的文件。

### 13.3 禁用 Hindsight（用户决策 D7，**只给步骤不代改**）

在 `/Users/yukisala/.dsh/cordis.patch.yml` 追加：

```yaml
- id: hindsight
  disabled: true
```

然后重启 `dsh web`。该文件是 home 级 patch 层，`patchReload: live`，但插件行的启停以重启为准。

---

## 14. 测试策略

| 层级 | 内容 |
|---|---|
| 单元（`node --test`） | vault 路径解析与 slug 生成/冲突消解；`.obsidian-mem` 读写；frontmatter 解析/序列化（引号 wikilink、未知键保留、类型保持、`tags` 列表、日期格式、无 BOM、字节 0 起始、闭合校验）；type 路由与文件名清洗；id 生成与 upsert 幂等；ADR 编号分配；supersede 状态机；CJK 二元分词与 FTS 查询构造；冲突检测；越界写入拒绝；`trust: owner` 笔记保护；dataless 判据（`blocks===0 && size>0`） |
| 集成 | 临时 vault + 临时仓库：bootstrap 幂等且**不移动既有文件**、写入协议全链路（文件 + MOC + 收据 + 索引）、lint 能发现预置缺陷、人类笔记零改动 |
| 冒烟 | 以真实 DSH 启动（`--dump-config` 断言行；临时 profile 启动一次会话断言简报注入与工具可见） |
| 回归 | 用本项目自身作为 dogfood：vault 内 `项目/dsh-obsidian-mem/` + 仓库 `.obsidian-mem`，每个阶段结束跑一次全链路 |

---

## 15. 实施阶段与验收标准

| 阶段 | 交付 | 验收 |
|---|---|---|
| **P1 骨架与读写** | 包结构、`cordis.patch.yml`、`dsh.plugin.json`、vault 解析/绑定/bootstrap、frontmatter 模块（引号/日期/BOM/闭合/逐键合并）、索引（FTS5+CJK）、`mem_search/mem_read/mem_write/mem_log/mem_brief/mem_admin` | 安装后 `--dump-config` 可见；临时 vault 全链路测试通过；中文检索命中；重复写入幂等；写入的 frontmatter 无 BOM、字节 0 起始、闭合 |
| **P2 注入与技能** | 会话钩子（session-start/pre-step）、简报构建与预算、systemPrompt 区块、随包技能同步 | 新会话首轮有简报且 ≤ `briefBudgetChars`；索引未就绪时不注入空简报；技能出现在 `~/.dsh/skills/obsidian-mem/` |
| **P3 自动提炼与治理** | `distill.js`、`mem_admin{promote,lint,projects}`、硬边界校验、离载文件保护 | 一次真实会话后仅保留前缀内新增；低置信进收件箱；dryRun 只写收据；lint 报告可复现；`source: human` 笔记零改动 |
| **P4 文档与发布** | README/CHANGELOG/AGENTS.md、测试补齐、dogfood 记录、npm 打包校验（`prepack` 校验脚本） | `npm pack` 内容正确；`node --test` 全绿；README 能让第三方 5 分钟内装上 |

---

## 16. 风险与未解问题

| # | 风险 | 应对 |
|---|---|---|
| 1 | **文档不再随代码走**（D1 的代价）：他人克隆仓库看不到 agent 的项目文档；换机器需单独同步 vault | `docMirror: repo` 开关；vault 独立 git + remote；README 明确说明该取舍 |
| 2 | **DSH API 迭代快**：第三方记录 DSH 0.1.7 将移除 `settings.register()`（当前 0.1.5-rc.2 尚存） | 配置以 row `config` 为准，settings 命名空间为可选增强；锁定已实测的 API（`tools.register`/`systemPrompt.section`/`ctx.on`/`ctx.effect`） |
| 3 | **调试困难**：`ctx.logger` 不落盘、改源码需重启 | 验证以 `--dump-config` + 文件系统断言为主；插件自建可读状态（`mem_index` 状态、收据） |
| 4 | **全自动写入产生噪声** | 硬边界（§10.3）+ `maxItems` + 置信阈值 + `review_after` + lint 的「收件箱积压」检查 + 先跑 dryRun |
| 5 | **中文检索质量** | CJK bigram（R3）+ 类型权重 + 片段自研（bigram token 无法映射回原文） |
| 6 | **vault 同步冲突**（若用户日后放到 iCloud/Dropbox） | 明确建议用 git（vault 自有仓库）而非 iCloud；`.obsidian/workspace*.json` 进 `.gitignore` |
| 7 | **重名 basename 导致链接歧义** | 写入时保证 basename 唯一（冲突加后缀）；lint 检测；必要时路径限定链接 |
| 8 | **提炼成本与延迟** | 空闲 debounce、单飞、转写过短跳过、成本上限、失败降级为确定性日志 |
| 9 | **与既有 in-repo vault 并存**（如 `~/subject/Xerintosh/doc`） | v1 不动、不迁移；lint 输出「可纳入候选」清单 |
| 10 | **模型路由**：提炼用哪个 provider/model | 默认 `subagent` 模式继承当前默认路由；可显式配置；空配置时降级为确定性日志 |

**未解问题（实施中验证）**：① `ctx.subagents` 在 `agent/disposed` 时是否仍可派生（若不可，改在 `turn-stopping` + debounce 内完成）；② 一次 `llm.stream` 调用的 provider/model 解析来源；③ FTS5 在本机 `node:sqlite` 构建中是否启用（否则回退 scan 后端）。

---

## 17. 附录

### 17.1 与竞品的差异化（15 个对照，详见 `research/obsidian-agent-memory-prior-art.md` §2.8）

| 维度 | 竞品现状 | 本设计 |
|---|---|---|
| repo↔vault 绑定 | 全部靠 basename 推断 | 显式 `.obsidian-mem` 指针 + 注册表（**无人做过**） |
| 文档与记忆 | 要么只管记忆，要么只管 vault 访问 | 同一 type 路由协议同时治理文档与记忆 |
| 记忆生命周期 | 仅 `dsh-math-memory`/`memory-for-ai` 涉及；DSH 侧普遍无 supersede | supersede/contested/confidence/assertion/review_after 全套 |
| 注入 | 两极：全注入或零注入 | 预算化导航注入 + 增量 + 新鲜度脚注 |
| 自动提炼 | 归档原始转写（反模式）或无 | 结构化蒸馏 + 硬边界 + 收据 |
| 索引位置 | 多数在 vault 内 | vault 外（不污染、不进同步） |
| 可移植性 | 各插件自成一派 | vault 内的协议是**纯 Markdown + frontmatter**，DSH 插件只是第一个适配器（§17.4） |

### 17.4 可移植性定位（第三条未占领轴）

调研的最终建议是：做**可移植的、带生命周期的项目记忆协议**，而不是又一个 vault 包装器。因此本设计的产物分两层：

- **协议层（可移植、无 DSH 依赖）**：目录约定 + §6.4 的 frontmatter 词表 + §10.2 的提炼输出契约 + `.obsidian-mem` 指针文件。任何 harness（Claude Code / Codex / Cursor）都能读懂并遵守；随包技能 `SKILL.md` 用 Agent Skills 格式书写，本身即可跨 harness 复用。
- **适配器层（DSH 专属）**：`tools.register` 的工具面、`ctx.on` 的钩子、`systemPrompt.section` 公告、`node:sqlite` 索引。

这样即使 DSH 的 cordis API 迭代（已有两个上游插件因此停摆），协议与 vault 内容不受影响。

### 17.2 调研产出

| 文件 | 内容 |
|---|---|
| `research/obsidian-agent-memory-prior-art.md` | 1263 行 / 103 条引用 URL / 19 项本机实测 / 18 处显式 UNVERIFIED / 28 项目对照：竞品、方法论、frontmatter 契约与普查、访问路径实测、同步与数据丢失路径、文件名政策、未解问题 |
| `research/dsh-plugin-api-reference.md` | 3064 行：DSH 插件契约（包/补丁/模块/服务/事件/持久化/安装调试），自 240 个第一方包实现级反推 |
| `research/dsh-agent-session-events.md` | 761 行：13 个 agent 事件 + 4 个 session 事件 + 转写读取 + 五种注入 API |
| `research/dsh-tools-register-api.md` | 1369 行：`tools.register` 完整契约与参数 DSL |

### 17.3 参考的方法论（用户提供）

三层分级记忆（热 9000 字符 / 温 vault 文件按需读 / 冷每日笔记）+ 内容路由规则 + 维护节奏（每周孤儿清理、每月结构审计）+ 「Obsidian 四理由」（纯文本无依赖、反链图谱、可搜索历史、脱离 AI 独立运作）。

### 17.4 证据质量声明（必须随设计一起被审视）

- **「agent 是否该写进人类 vault」这一问题上没有任何定量证据**，也没有论坛大讨论：R20 是从第一方设计陈述（kepano/Späti）出发的**推理综合**，不是有实测结果的共识。引用的 kepano 原话来自 X 帖镜像站，**未能对 X 原帖验证**（标记 UNVERIFIED）。
- 相邻的唯一定量结果是 Chroma 的 *Context Rot*（18 个模型），它衡量的是**模型行为**，不是 vault 行为。
- Reddit 的 JSON API 全路径 403（仅 `.rss` 可用），r/ObsidianMD 的情绪样本偏少。
- 相反，§3 中标 **R15–R18、R21–R23 的条目都是本机第一手实测**（19 项），可信度高于外推结论。
- 因此本设计对「机制类」约束（解析器、文件名、检索、注入预算、绑定）有把握；对「人类阅读体验」类取舍（§16 风险 1）保留人工观察期（`autoCapture.dryRun`）。
