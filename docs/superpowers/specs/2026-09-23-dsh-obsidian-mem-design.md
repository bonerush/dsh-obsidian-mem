# dsh-obsidian-mem 设计文档

- **日期**：2026-09-23
- **状态**：设计复审版（保留已批准的产品方向；本文新增的实施约束仍须经原型验证）
- **复审日期**：2026-09-23
- **路径**：`docs/superpowers/specs/2026-09-23-dsh-obsidian-mem-design.md`
- **一句话**：一个 DeepSeek Harness（DSH）主机侧插件，把 Obsidian vault 变成每个项目的**文档底座 + 长期记忆底座**，人可读、可版本化、可脱离 AI 独立运作。

---

## 1. 背景与目标

### 1.1 需求（用户原话归纳）

> 在后续每个项目中撰写的**所有文档**和项目所必须的**记忆**，都使用 Obsidian 来管理。

拆成可验收的目标：

| # | 目标 | 验收方式 |
|---|---|---|
| G1 | 经插件创建的项目文档以 vault 为权威副本，在 Obsidian 里可浏览、双链、搜索；仓库里由其他工具直接写出的 Markdown 必须被发现并报告 | `mem_write(type=doc)` 后可在 Obsidian 浏览；仓库文档审计能列出未纳入 vault 的文件；不声称插件能拦截所有外部文件写入 |
| G2 | 项目长期记忆（决策、踩坑、约定、任务态、环境事实）自动沉淀，并在新会话开始时自动回到上下文 | 索引就绪时首轮携带简报；首扫超时先报告状态、就绪后补发；`mem_search` 能命中旧决策 |
| G3 | 完成的用户回合在空闲后自动提炼，失败任务可在下次启动后重试，无需人工触发 | 真实会话产生经校验的笔记或明确的空结果/失败收据；崩溃后重启不重复写同一条目 |
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
- **不重组既有目录**：调研实测在 Obsidian 内移动文件夹会锁住 App 数分钟并触发 Sync 全量重传；bootstrap 只**创建**缺失项，`mem_admin(action=lint)` 只**报告**，永不移动/重命名用户的目录。
- **不使用符号链接**（Obsidian 官方明确劝阻，且已有竞品因此设计失败）。
- 不承诺拦截 DSH 以外的编辑器、shell 命令或其他插件写入；对「所有项目文档」采用**指定权威写入路径 + 漏检审计**，范围见 §5.4。

---

## 2. 决策记录

| # | 决策 | 备选与被否原因 |
|---|---|---|
| **D1** | **单一全局 vault**：插件创建的项目文档与记忆都进 `~/Documents/dsh-memory` | 曾考虑①仓库内项目 vault + 全局记忆 vault，②仓库外每项目一 vault。单库便于跨项目召回；代码协作必需的仓库级文档仍留仓库，边界见 §5.4。 |
| **D2** | 全局 vault 与个人知识库 `~/Documents/knowledge` **完全隔离** | 个人库是用户手写、精心策展的资产，agent 产物体量大、信噪比低（调研：`dsh-obsidian-sync` 式的原始归档会让检索质量随体量衰减）。 |
| **D3** | 仓库侧只提交一个不含本机路径的 `.obsidian-mem`：稳定 `projectId` + 人读名称；vault 位置由本机插件配置决定 | 调研范围内的竞品依赖目录名推断。固定 ID 允许 clone/worktree 共用项目，目录重命名不改变身份；fork 需要显式分离。原先将 `vault` 绝对路径、remote 和时间写进提交文件，会使跨机器克隆误绑定。 |
| **D4** | 完成回合空闲后**全自动**提炼写回 | 用户明确选择全自动；DSH 长会话未必有明确的“会话结束”时刻，因此以完成回合 + debounce 为可实现触发，硬边界见 §10。 |
| **D5** | 记忆与文档**同库不同域**：`项目/<固定目录>/` 放项目域，`方法/` 与 `_meta/` 放跨项目域 | 类似 Hindsight 的“bank per repo”，但人类可读、可 diff。 |
| **D6** | 检索用 **SQLite FTS5 + CJK bigram**，索引库放 vault **之外**；索引是可重建缓存，读结果前重验源文件 | 调研：`unicode61` 对连续汉字不适合直接按词召回，`trigram` 漏 2 字词；两侧预分词。索引不进入 Obsidian Sync。 |
| **D7** | 禁用 Hindsight（用户选择），Obsidian 为唯一记忆层 | 两套自动记忆会互相污染并重复占用上下文。**不代用户改配置**，只给一行 patch 步骤（§13.3）。 |
| **D8** | v1 不实现文档镜像；代码依赖的 `README.md`、`AGENTS.md` 等仓库文件仍在仓库，项目报告、设计稿等经 `mem_write` 写入 vault | 镜像会产生双权威副本和同步冲突；只有定义好单向同步、冲突处理与泄漏边界后才加入。 |
| **D9** | 随包资产（技能）幂等同步到 `~/.dsh/skills/obsidian-mem/` | 复用 `dsh-ultramath` 已验证的 bundle 资产同步机制；技能不依赖 npm 包被自动扫描。 |

---

## 3. 调研依据（决定设计的硬约束）

来源：`research/` 下 4 份报告（共 6400+ 行，其中 102 条引用 URL、28 项目对照）。以下每条都直接约束实现。

| # | 发现 | 约束 |
|---|---|---|
| R1 | 2026-09-23 的调研样本记录了 **8 个** npm 已发布的 DSH/Obsidian 相关插件（名单见研究报告），数量会随时间变化 | “能给 agent 读写 vault”已有同类；本方案重点验证显式项目绑定、记忆生命周期与可恢复自动提炼，不能仅凭竞品数量宣称独占优势 |
| R2 | 实践者复盘（Railly，agent-brain v2）：*"I made context too big… the deletion was the feature. Persistent memory does not mean permanent attention."* | 注入必须**预算化 + 导航式**；正文按需读；热层必须能归档 |
| R3 | CJK 检索：`unicode61` 整段中文=1 token；`trigram` 漏 2 字词 | 索引与查询两侧都做**重叠二元分词** |
| R4 | Obsidian 属性（properties）类型是 **vault 全局按名注册**（[官方属性文档](https://obsidian.md/help/properties)） | 专用 vault 内使用封闭词表；若同名属性已有不同类型，停止写入，不在无 App 场景下声称能读取其 GUI 类型设置 |
| R5 | frontmatter 中的 wikilink **必须加引号**：`related: "[[Note]]"`、数组内 `- "[[Note]]"` | 写入器必须**序列化** YAML，不能拼字符串（这是 agent 破坏笔记的头号方式） |
| R6 | 更新笔记时应**保留未知键**（`cssclasses`、插件字段、Dataview 内联字段） | 只做**逐键外科式**更新，禁止整体重写 frontmatter |
| R7 | Obsidian 的最短唯一链接依赖文件名是否冲突；[官方设置](https://obsidian.md/help/settings)和[内部链接文档](https://obsidian.md/help/links)支持 vault 根相对路径 | 生成链接统一使用 vault 根相对路径；`mem_admin(action=lint)` 检测大小写折叠后的重名与死链 |
| R8 | 索引若在后台扫描未完成时就被读取，会注入「空记忆」的假象 | 注入前必须有 **ready 屏障**（`waitReady()`） |
| R9 | DSH 插件陷阱（本地实测反推，`research/dsh-plugin-api-reference.md`）：`ctx.logger` **不落盘**（仅 1000 条内存环形缓冲，warn/debug 都不进）、改插件源码**必须重启**、patch 的 `config` **整体替换不深合并**、对可选服务硬 `inject` 会让插件永久 PENDING | 验证手段用 `--dump-config` 与 GUI 插件清单，不靠日志；配置显式写全；可选服务用 `ctx.get()` |
| R10 | 主流三类严肃设计（`claude-obsidian`、`obsidian-memory-for-ai`、`agent-brain`）**独立收敛到按 `type` 路由** | 目录按 **type** 分（文档/决策/踩坑/日志/收件箱），topic 交给链接与标签 |
| R11 | MOC（Maps of Content）是「最适合注入的形状」：短、策展、链接密集，回答"从哪开始"而不含内容 | 每个目录维护 `index.md` MOC；项目 hub 即注入入口 |
| R12 | `obsidian-memory-for-ai` v4.1 展示了事实单文件、取代链、来源/可信度和预算化简报等可借鉴机制；其完整双时间模型不适合作为 v1 必要字段 | §6.4 采用精简 schema，§8 采用预算化注入；这些是设计选择，不宣称“最佳实现”已有比较实验 |
| R13 | 来源标记（Hindsight `retainTags`/`retainMetadata`：`source:chat`、`harness:<id>`、`knowledge:<kind>`）用于回答「这条记忆哪来的」 | 每篇笔记带 `source` / `session` / `harness` 来源字段（§6.4） |
| R14 | 矛盾处理原则（`claude-obsidian`）：*"Preserve contradictions and source lineage; do not silently select a winner."* | 冲突标记 `status: contested` 并保留双方证据链接，而不是覆盖 |
| R15 | **本机实测**：Obsidian 关闭时 `obsidian version` 打印 *"The CLI is unable to find Obsidian…"* 并 **exit 1**（并不像其文档所称会启动 App）；REST API 是 renderer 内 Express，关闭时 `ECONNREFUSED` | **纯文件系统是唯一可靠通路**；CLI/REST 只能作为「App 恰好开着」时的可选加速器，v1 不依赖 |
| R16 | frontmatter 具体陷阱（本机实测）：单数键 `tag:`/`alias:`/`cssclass:` 自 1.9 起失效；`tags` **必须是列表**（`tags: foo` 不被识别）；`#` 在 YAML 里是注释起始；frontmatter 必须从**字节 0** 开始、无 BOM、必须闭合；`toISOString()` 的日期**不保证被解析**；Obsidian 在模板插入等场景会**重排 frontmatter 并丢注释** | 写入器：永不写 BOM、首字节即 `---`、写后校验闭合；日期统一 `YYYY-MM-DD`（需要时间时 `YYYY-MM-DD HH:mm:ss`）；`tags` 只写列表；**外科式拼接**，不做全文重写 |
| R17 | **本机实测**：iCloud 离载文件读取可能透明下载，也可能在后台 I/O 策略下报 `EDEADLK`；`stat.flags` 不能可靠识别，`blocks===0 && size>0` 可作线索但不是通用判据。[Obsidian Sync FAQ](https://obsidian.md/help/sync/faq) 说明在线文件可能被当作删除同步 | 已识别的按需下载位置拒绝自动写入；未知云盘提供商无法仅凭路径可靠识别，逐文件读失败或离载线索一律暂停，且索引扫描有界，不承诺识别所有云盘 |
| R18 | 属性类型按**属性名全 vault 全局**注册；社区有 `getAllPropertyInfos()` 导致周期性 renderer 卡顿的报告，不能写成本机测量 | **封闭属性词表**：只使用 §6.4 列出的字段名，不调用全量属性 API |
| R19 | 竞品采用从零到数千字符不等的注入预算；具体 6000 字符是本设计的初始参数，不是比较实验证出的最优点 | 简报默认 **6000 字符**；热文件容量 9000，超过 67%（约 6030 字符）启动归档；后续用真实会话评估预算 |
| R20 | **专用 agent vault 的机制性论证**：作者来源不是 Obsidian 各功能的统一隔离维度；Excluded files 会隐藏搜索/图谱/未链接提及并弱化快速切换与建议，但不是完整隔离（[官方设置](https://obsidian.md/help/settings)）。kepano 原话的镜像来源尚未核验，作为观点而非事实证明 | **验证 D2**：`~/Documents/dsh-memory` 与个人库分离。[官方文档](https://obsidian.md/help/data-storage)说明内部链接只在 vault 内；跨 vault 使用 [Obsidian URI](https://help.obsidian.md/Extending%2BObsidian/Obsidian%2BURI) 或普通引用 |
| R21 | **本机版本的 YAML 解析器实测**：Obsidian 1.12.7 用 eemeli/`yaml` v2.7.0 + YAML 1.2 core schema；`0123` 会失去前导零。此实现细节可能随 Obsidian 升级变化 | 使用 `yaml` v2.x 并作往返测试；普通文本/标识符强制加引号，Date 属性按[官方格式](https://obsidian.md/help/properties)写 `YYYY-MM-DD`，数值保持数值，不对所有标量机械加引号 |
| R22 | Obsidian 自己的**可移植文件名政策**（比任何 OS 都严）：避免 `/ \ : * ? " < > \|`、结尾空格或句点、Windows 设备名、链接字符 `# ^ [ ]`，以及「多个连续句点」与 emoji（部分 Android 设备拒绝）。长度上：macOS 是 **255 UTF-16 code unit**，而 **Linux ext4 是 255 字节**（对中文/emoji 才是约束） | 文件名清洗必须覆盖上述全集；**预算 ≤200 UTF-8 字节**。改用 Markdown 链接**不能**救回链接破坏字符（Obsidian 只转义反斜杠/控制符/空格），**只能在写入时排除** |
| R23 | 样本普查（32 仓库 / 7399 文件）提示日期字段常有未渲染占位符；文件系统 `ctime` 也可能被批量编辑重置。样本频数不代表整个生态 | **显式且通过格式验证的 frontmatter 值**才可作笔记日期；不以文件系统时间戳替代。`updated` 只在正文或语义状态变化时更新；mtime 可用于索引候选检测，但不回写 frontmatter |

---

## 4. 架构总览

```
┌──────────────────────── DSH 主机进程 ────────────────────────┐
│  dsh-obsidian-mem（host 半侧，纯 node ESM，无浏览器半侧）        │
│                                                              │
│  apply(ctx)                                                  │
│   ├─ Vault 解析 & 绑定      projectId ⇄ 项目/<固定目录>/        │
│   ├─ 引导 bootstrap         首次自动建骨架 + MOC               │
│   ├─ 索引 Index             node:sqlite FTS5 + CJK bigram     │
│   ├─ 工具 tools.register    mem_brief / mem_search / …        │
│   ├─ 钩子 ctx.on            session-start / pre-step /        │
│   │                         session/event / disposed          │
│   ├─ systemPrompt.section   记忆平面公告 + 路由规则            │
│   └─ 资产同步                skills/ → ~/.dsh/skills/obsidian-mem│
└───────────────┬──────────────────────────────┬───────────────┘
                │                              │
   读/写纯文本 .md│                              │按需读
                ▼                              ▼
   ~/Documents/dsh-memory（专用 vault）       ~/.dsh/data/obsidian-mem/
   ├─ _meta/{user.md, 项目注册表.md, log.md}   ├─ index/<vaultHash>.db
   ├─ 方法/                                    └─ pending/（0600 临时任务）
   └─ 项目/<固定目录>/{index.md, _meta/hot.md,
        文档/, 决策/, 约定/, 踩坑/, 日志/, 收件箱/}
```

**分层职责**：vault 是**已提交项目文档和记忆**的权威副本；索引是可重建缓存。下文的 `~/.dsh/data/obsidian-mem/` 指默认 DSH home；若设置了 `DSH_HOME`，实际数据根必须是 `$DSH_HOME/data/obsidian-mem/`，不能在独立测试 profile 中回写真实 home。自动提炼的待处理任务需要受限的本机持久队列（§10），因此不能宣称删掉整个数据根只会重建索引；只能安全删除其中的 `index/`。

**vault 位置约束（R17）**：必须在**本地可用目录**，不得与 iCloud/Dropbox/OneDrive 的按需下载目录及 Obsidian Sync 叠用。`~/Documents` 是否受 iCloud 管理因机器而异，不能由路径名推断；启动时检查真实路径、云盘标记和文件可读性，不能证明安全时停止自动写入并给出诊断。离载文件可能透明下载，也可能在后台进程里报 `EDEADLK`；无论何种情况都不能解释为「空文件」或「文件不存在」。[Obsidian Sync FAQ](https://obsidian.md/help/sync/faq) 明确说明在线文件可能被当作删除同步。

---

## 5. Vault 布局与绑定协议

### 5.1 目录结构

```
~/Documents/dsh-memory/                 # 专用 vault；新建时可 git init，备份仍需用户配置
├── .gitignore                          # 忽略 .obsidian/workspace*.json 等易变文件
├── _meta/
│   ├── user.md                         # 用户自行维护的全局偏好；插件只读
│   ├── 项目注册表.md                    # 所有项目 hub 的索引（MOC）
│   ├── log.md                          # 写入收据（追加在文件末尾）
│   ├── .history/                       # 变更前快照与事务恢复材料，不参与检索
│   └── Lint Report <date>.md           # mem_admin(action=lint) 可选报告
├── 方法/                               # 跨项目可复用方法论（promote 目标）
│   └── <slug>.md
└── 项目/
    └── <slug>--<projectId前8位>/       # 固定目录名；displayName 可改，不自动搬迁
        ├── index.md                    # 项目 hub / MOC（注入入口）
        ├── 约定/                        # 一条约定一文件 + index.md 汇总
        ├── _meta/hot.md                # 热记忆（≤9000 字符，>67% 触发归档）
        ├── 文档/                        # 项目文档 + index.md MOC
        ├── 决策/                        # ADR 式决策 + index.md MOC
        ├── 踩坑/                        # 症状/根因/修复/证据 + index.md MOC
        ├── 日志/YYYY-MM-DD.md           # append-only 会话日志（冷层）
        └── 收件箱/                      # 未定归属 / 低置信候选
```

约定：目录层级 **≤3 层**；目录名按 **type**（R10）；topic 关系交给 `[[链接]]` 与 `tags`。

### 5.2 绑定协议（`.obsidian-mem`）

仓库根下的 `.obsidian-mem`（**提交进仓库**，JSON，极小；不含用户本机路径和远端地址）：

```json
{
  "projectId": "1c392abb-7b08-42f7-871d-2a379caf9448",
  "slug": "dsh-obsidian-mem",
  "displayName": "dsh Obsidian memory",
  "schema": 1
}
```

解析顺序（**显式优先；猜测仅用于首次创建名称，不能决定既有项目身份**）：

1. 由当前工作目录向上查找仓库根（兼容 `.git` 目录或 worktree 的 `.git` 文件）；仅在仓库根读取 `.obsidian-mem`。校验 JSON schema、UUID、slug、文件大小和路径形态，未知 schema 停止写入。
2. 指针存在时按 `projectId` 查 vault 注册表；存在即复用固定目录。指针 ID 在 vault 中不存在时可新建，但如果目录已被其他 ID 占用，停止并报告冲突。不同 worktree 使用同一 ID。
3. 首次进入没有指针的 Git 仓库时，先按 `git rev-parse --git-common-dir` 找同一仓库的其他 worktree：若它们提供完全一致的有效四字段指针，则独占创建相同指针；若有不同 ID 或同 ID 但元数据不一致，停止并要求显式绑定。确实没有已知指针时，才以 `basename(root)` 建议 slug，生成 UUID，使用**独占创建**写指针，再建项目骨架与注册表。这避免“旧分支没有新提交的指针”被误当成新项目。远端 URL 只作 fork 诊断线索：将标准化的 host/仓库路径与注册表上次记录比较；不一致时暂停自动写入并报告，用户可明确选择 `mem_admin(action=bind, mode=fork)` 分配新 ID，或 `mode=retain` 确认仍是同一项目。不能凭远端自动改绑。
4. 非 Git 目录不共用 `_scratch`；默认只读并提示显式 `mem_admin(action=bind, mode=local)`，在可写目录生成指针。临时目录不会无意混入长期记忆。
5. 当前工作目录若落在 vault 内部，不把 vault 自身的 `.git` 识别成普通项目；返回 vault 管理上下文，避免递归创建 `项目/dsh-memory/`。

本机 `vaultPath` 仅在配置中指定；克隆到另一台机器后使用同一项目 ID 和该机器的 vault 路径。项目目录名只在首次绑定时确定，改仓库名或显示名不搬迁目录。注册表记录 `projectId → vault 相对目录`，两个不同 ID 绝不指向同一目录。

`_meta/项目注册表.md` 的插件管理区使用固定列的 Markdown 表格：`projectId | vault 相对 hub 路径 | displayName | 上次标准化 remote`，由 `<!-- obsidian-mem:registry begin sha256:<内容哈希> -->` / `<!-- obsidian-mem:registry end -->` 包围。表格单元格中的 `|` 与换行须转义，解析后对 UUID、相对路径、一对一关系重新校验；生成区哈希不匹配就停止写入。该表兼作人可读的项目 MOC，不在 frontmatter 新增属性名。remote 只是 fork 诊断线索，不作为项目身份；用户可能在不同机器上使用不同 remote，误报时用显式 `retain` 确认。

`mem_admin(action=bind)` 可查看和修复绑定；修复不得静默覆盖已有 ID。显式绑定是调研样本中的主要差异点（R1/D3）。

### 5.3 引导（bootstrap）

首次进入一个项目时自动创建：项目目录骨架、`index.md`（含 frontmatter 与空章节模板）、`_meta/hot.md`、各 type 目录的 `index.md`，并登记注册表。
**幂等**：已存在的文件永不覆盖；只补缺失项。若 vault 根不存在则创建；仅对插件**刚创建的空目录**，在 `initGitOnCreate=true` 且 Git 可用时执行 `git init`。已有 vault 不动；插件不自动 commit 或配置 remote。Git 初始化只是可版本化的准备，用户仍需另行配置提交与备份，不能把「仓库已初始化」等同于「可回滚」。

### 5.4 文档写入边界

- `mem_write(type=doc)` 是项目设计稿、报告、指南的权威写入入口；返回 vault 相对路径及 Obsidian 可用链接。技能与 system prompt 指示 agent 优先用它写这些文档。
- Obsidian 首次使用时需由用户在 App 中执行“Open folder as vault”；若该目录尚未注册为 vault，工具只返回文件相对路径，不伪造可用的 `obsidian://` 链接。
- `README.md`、`AGENTS.md`、许可证、构建配置旁的说明等直接影响代码仓库运行或协作的文件仍在仓库；它们不是 vault 文档的镜像。若同一主题需要人读长文档，在 vault 写权威说明，在仓库留短链接/摘要。
- `mem_admin(action=lint)` 扫描仓库中新增或改动的 Markdown（可配置忽略生成物），报告没有 vault 链接或映射的候选。由于任意 shell/编辑器写入不能被该插件拦截，G1 的保证仅覆盖插件写入；审计负责发现缺口，不自动搬动用户文件。

---

## 6. 记忆模型

### 6.1 三层（参考用户提供的三层分级记忆方法论）

| 层 | 载体 | 访问方式 | 预算 |
|---|---|---|---|
| **热** | `项目/<目录>/_meta/hot.md` + 只读的 `_meta/user.md` | 首个 `pre-step` 注入一次；热文件变更后只在后续 `pre-step` 注入经过校验的增量 | 热文件硬上限 `hotCapacityChars`（默认 9000）；简报预算 `briefBudgetChars`（默认 6000）；超过 `hotArchiveRatio`（默认 67%）启动归档 |
| **温** | vault 全部笔记 | 按需 `mem_search` → `mem_read` | 不注入 |
| **冷** | `日志/YYYY-MM-DD.md` | 只搜索，不注入 | 不注入 |

热层只放**高频变动且每次都需要**的内容：当前活跃工作、强约束、最近被纠正的项目约定。`hot.md` 固定分为“强约束 / 进行中 / 已完成”三个插件管理区，每条带稳定 ID 与来源链接；只允许从“已完成”区自动归档。归档在写入前完成：先写温层笔记，再把热层原文替换为指针；找不到可归档条目时拒绝超限写入并报告，不截断。“强约束”只能显式解除或取代。`_meta/user.md` 不由提炼器修改。

### 6.2 内容路由（type → 落点）

| type | 落点 | 说明 |
|---|---|---|
| `doc` | `文档/<标题>.md` + 更新 `文档/index.md` | 项目文档（设计、报告、指南、方案） |
| `decision` | `决策/ADR-<n>-<slug>.md` | Context / Decision / Alternatives / Consequences；`status: proposed\|accepted\|superseded` |
| `gotcha` | `踩坑/<slug>.md` | 症状 / 根因 / 修复 / 证据——价值最高、体量最小 |
| `convention`（输入别名 `invariant`） | `约定/<slug>.md`，登记到 `约定/index.md`；热层仅保留必要短指针 | 一条事实一文件，才能独立标证据、过期与 supersede；不能因为约定变长而把全文升入热层 |
| `session-log` | `日志/YYYY-MM-DD.md` | append-only，按会话分节，幂等（同 session id 不重复写） |
| `hub` | `index.md` | MOC，注入入口 |
| `glossary` | `文档/术语表.md` | 领域词表 |
| 未定 / 低置信 | `收件箱/<slug>.md` | 待人工分类 |
| 跨项目方法 | 提升到 `方法/<slug>.md` | 由 `mem_admin(action=promote)` 显式触发 |
| 用户 / 环境 | `_meta/user.md` | 用户自行维护；插件只读，自动提炼不写入 |

### 6.3 生命周期规则

- **取代而非覆盖（supersede）**：结论变化时写新笔记，旧笔记置 `status: superseded` + `superseded_by: "<新 id>"`；新笔记写 `supersedes: "<旧 id>"`，正文生成带 vault 路径的双向 `[[链接]]`。稳定 ID 是身份，路径是导航；**不删除旧笔记**。
- **矛盾不选赢家**：无法判定时标 `status: contested`，保留双方证据链接（R14）。
- **可信度分级**：`assertion: stated | inferred | observed`（用户明确陈述 / 模型推断 / 有可复查工具证据）+ `confidence: 0..1`。`observed` 必须有可核查证据和执行结果，模型自称「已验证」不算。
- **过期复核**：`review_after: YYYY-MM-DD`；`mem_admin(action=lint)` 输出过期清单。
- **来源可追**：`source: human | chat | git | agent`、`session:`、`harness: dsh`（R13）。

### 6.4 笔记 schema

**基线 frontmatter**（插件创建的笔记；用户自维护的 `_meta/user.md` 不强制改造）：

```yaml
---
id: "dec-5d46ff43-1bf8-496d-8b9f-c11e89d4e2aa" # 稳定身份；改名不改 id
type: "decision"                 # doc|decision|gotcha|convention|session-log|hub|glossary|method|hot
title: "调度器改为可插拔后端"
status: "accepted"               # active|proposed|accepted|superseded|deprecated|provisional|contested|archived
created: 2026-09-23
updated: 2026-09-23
tags: ["dsh-mem/decision", "project/xeros"]
project: "1c392abb-7b08-42f7-871d-2a379caf9448" # projectId，不是易变 slug
source: "chat"                   # human|chat|git|agent：证据来源渠道
session: "20260923-155100-a1b2" # 产生它的会话；可空
harness: "dsh"
trust: "agent"                   # owner|agent|external：作者/控制权
confidence: 0.9                 # 0..1，可空
assertion: "stated"              # stated|inferred|observed，可空
supersedes: "dec-09a26ee7-3630-468e-86bf-30a843829db7" # 稳定 id；正文另放可点击链接
superseded_by: null
review_after: 2027-03-23         # 可空
---
```

**封闭属性词表**（R18）：上表就是全部允许的属性名；实现中不得新增属性名（Obsidian 按属性名全 vault 注册类型，新名字一旦写错类型会污染整个 vault）。用户既有笔记中的其他属性名一律原样保留、不改类型。

跨项目的 `方法/` 笔记令 `project: null`，在正文列出来源项目链接。`日志/YYYY-MM-DD.md` 可含多个 session 分节，frontmatter 的 `session` 置 `null`，每节标题记录具体 session ID；不能把整天日志误归到一个会话。

规则：
- 只用 Obsidian 原生属性类型；`tags` 是**列表**（`tags: foo` 不被识别）；wikilink 值一律**加引号**（R5）。
- **序列化器用 `yaml` v2.x**（与当前实测 Obsidian 同族解析器 / YAML 1.2 core）。普通文本和标识符强制加引号；`created/updated/review_after` 按 Obsidian 官方 Date 示例写未加引号的 `YYYY-MM-DD` 并作类型往返验证；`confidence` 保持数值。绝不写未加引号的**前导零标识符**（`0123` 会被静默吞成 `123`，R21）。
- **日期一律 `YYYY-MM-DD`**（需要时间时 `YYYY-MM-DD HH:mm:ss`），**不用** `toISOString()`（R16）。
- **frontmatter 从字节 0 开始、无 BOM、必须闭合**；写入器写后自校验（R16）。
- 新文件可以整体序列化；更新既有文件时用 `yaml` 的文档节点定位待改值的原始范围，**只替换允许的字段和值**；允许键缺失时只在 frontmatter 闭合标记前最小插入。`tags` 等列表按实际 YAML 值类型序列化；目标字段内部注释无法无损保留时拒改。未知键、注释、顺序和正文原字节保留。若重复键、无效 YAML、类型冲突或无法定位范围，则停止写入并生成冲突报告；不以全量序列化掩盖错误。
- **显式 frontmatter 值是日期的唯一来源**：不用文件系统时间戳推断；**绝不为了「刷新元数据」而重写文件**（R23）；`updated` 只在正文或语义状态真正变化时更新。
- 生成域带**带命名空间与完整性哈希的标记**（控制器裁决 R24，取代早先的 `<!-- generated … -->` 写法）：
  - 注册表区块：`<!-- obsidian-mem:registry begin sha256:<区块正文哈希> -->` … `<!-- obsidian-mem:registry end -->`
  - 其他自动区块（各目录 `index.md` 的 MOC 自动区、`Lint Report` 生成区）：`<!-- obsidian-mem:generated begin sha256:<区块正文哈希> -->` … `<!-- obsidian-mem:generated end -->`
  - 规则：只重写「声明哈希与当前区块正文一致」的自动区块；人工改过的自动区块**停止覆盖并报告冲突**。哈希是让「插件所有」可判定的唯一依据，因此不得省略。

**文件名与链接清洗**（R22，写入时强制）：

- 禁用字符集：`/ \ : * ? " < > |`、`#`、`^`、`[`、`]`、结尾空格或句点、连续多句点、emoji、Windows 保留设备名（`CON`/`PRN`/`AUX`/`NUL`/`COM1`…）。
- 名字长度 **≤200 UTF-8 字节**（Linux ext4 的 255 **字节**才是真约束，不是 macOS 的 255 UTF-16 单元）。
- 清洗是**唯一**安全策略：改用 Markdown 链接不能救回这些字符（Obsidian 只转义反斜杠、控制符与空格）。
- 同目录内 basename 必须唯一；冲突时追加短哈希后缀，并在链接歧义处使用**路径限定** wikilink（R7）。

**id 生成规则**（消除歧义，实现按此执行）：

```
id = "<type 三字母前缀>-<crypto.randomUUID() 的 UUIDv4>"
前缀：doc→doc, decision→dec, gotcha→got, convention→con, session-log→log,
      hub→hub, glossary→glo, method→met
```

- 标题和日期都**不是身份**：同日同标题可能是两条不同决策，改标题也不应产生新事实。交互式 `mem_write` 未传 `id` 时创建随机 ID；更新时必须传已有 `id`，不得靠标题命中。可选 `idempotencyKey` 使工具重试返回同一结果。
- 自动提炼先把模型原始输出持久化；校验后按 `<sessionId>:<toSeq>:<itemIndex>` 建立幂等键，给每条候选**分配一次随机 UUIDv4**，并把键→ID 映射连同校验结果原子持久化到 pending，之后才写 vault。重启只读已存映射，不重新生成 ID 或再次请求模型；内容重复检测只提示合并候选，不自动覆盖。
- 对外 `mem_write(id=...)` 始终表示更新既有 ID；自动提炼使用**不暴露给工具参数**的内部 `createMemoryWithId(preassignedId, idempotencyKey, ...)` 创建新笔记，先检查该 ID 尚不存在并复用已成功收据。这样可同时满足公开工具的更新语义和崩溃重试的 UUIDv4 稳定性。
- **ADR 编号分配**：`决策/ADR-<n>-<slug>.md` 的 `n` 在全 vault 写锁内取该项目最大编号 +1，并以独占创建落盘；编号仅供人读排序，**身份始终是 `id`**。锁或文件冲突时重试分配，不覆盖。

---

## 7. 检索与索引

- **后端**：`node:sqlite`（`DatabaseSync`）FTS5；FTS5 不可用时使用等价过滤的扫描后端并明确报告降级。`DatabaseSync` 是同步 API，初扫必须分批、让出事件循环，限制单文件大小和并发读取。**实测（P0 Task 2，见 `docs/p0-compatibility.md`）**：`node:sqlite` 在 Node 22.13.0 上已可免标志 `import`，但该版本内置的 SQLite 3.47.2 **没有编译 `ENABLE_FTS5`**（`CREATE VIRTUAL TABLE … USING fts5` 报 `no such module: fts5`，加 `--experimental-sqlite` 亦然）。Node 22.22.2（SQLite 3.51.2）与 25.9.0（3.51.3）的 `compile_options` 含 `ENABLE_FTS5` 且实测可用。**去实验标志与 FTS5 可用是两件事**，因此声明的下限取实测最低可用版本 **`engines.node >= 22.22.2`**，不是 22.13；22.14.0–22.21.x 未实测。`indexBackend='auto'` 在这类版本上必须落到扫描后端并报告，显式 `sqlite` 必须失败。
- **位置**：`~/.dsh/data/obsidian-mem/index/index-<sha256(realpath(vaultPath))>.db`（WAL）；索引不进 vault。数据库损坏可隔离后重建，不得清除 `pending/` 待处理任务。
- **分词**：拉丁小写化；CJK 连续段切重叠二元组。索引和查询使用同一个纯函数；单字 CJK 查询走安全的原文子串分支。FTS 查询对每个 token 加引号并设长度/数量上限，避免用户文本被解释为 FTS 运算符；多词召回先 OR，再以命中数和字段权重排序，不要求每个词同时出现。
- **表**：`notes(path, mtime, size, id, type, title, status, project, updated, hash)`、`notes_fts(title, body, tokens)`、`fm_kv(note_id, key, value)`、`tags(note_id, tag)`、`links(src_id, target, resolved_id)`、`kv(key, value)`（含 `schema_version`、`last_scan`）。
- **增量**：路径 + `mtimeNs` + size 用于廉价候选筛选；首次扫描、定期校验和命中读取时计算内容哈希，覆盖“同大小、同时间戳”的外部编辑。只索引允许的 `.md`：全局 `_meta/` 仅 `_meta/user.md` 可检索，忽略 `_meta/log.md`、`_meta/项目注册表.md`、Lint 报告和 `_meta/.history/`；同时忽略待处理队列、`.obsidian/` 和 symlink；`收件箱/` 可检索但不进默认简报。
- **一致性**：写文件成功后再更新索引；`mem_admin(action=lint)` 做 file↔db 哈希核对（孤儿行、缺失行、死链）。索引更新失败时标为 stale，查询重扫源文件或降级扫描，不返回已删除文件的缓存正文。
- **ready 屏障**：`waitReady(signal, timeout)`——首次查询等待首扫结束；首轮注入在 `pre-step` 等待有上限的时间，超时写明“索引尚未就绪”，后续 `pre-step` 在同一会话补发一次简报。不得把超时当作空 vault。
- **排序**：SQLite FTS5 的 `bm25()` **越小越相关**（本机验证为负值）；先按 `bm25 ASC`，再在有界候选集上增加标题/精确子串/类型权重与可控的新鲜度加分，稳定按路径打破同分。默认排除 superseded/archived，除非查询指定历史。返回路径、标题、原文片段、来源和可解释的排序信号。
- **不依赖 frontmatter 完整性**：解析失败的文件仍可按纯文本检索（调研：真实 vault 仅 ~17% 笔记有 frontmatter）。

---

## 8. 注入策略

**只注入导航与关键约束**（R2/R11/R12），不注入正文。

会话开始只准备项目绑定；**首个 `agent/pre-step`** 通过 waterfall `await next()` 后，对 `kind: 'enter'` 的决定附加一条消息（`source: {kind:'plugin', plugin:'obsidian-mem', form:'recall'}`）注入简报。不能仅在 `session-start` 调用 `agent.inject()`：DSH 文档说明它可能错过已经 claim 的 pre-step。简报内容：

```
1. 用户维护的全局偏好（_meta/user.md 精炼版；若存在）
2. 项目标识与绑定（projectId、目录、显示名）
3. 项目 hub index.md 的**大纲**（标题树 + 链接，正文不展开）
4. `约定/index.md` 中仍有效的关键条目（标题、短摘要、路径，不展开正文）
5. 最近 N 条决策 / 踩坑的标题 + 路径（默认 N=5，按 updated 倒序）
6. 当前任务态（hot.md 的「进行中」区）
7. 新鲜度与预算脚注：<!-- brief: 3120/6000 chars, hot 3120/9000, updated 2026-09-22, index ready -->
```

- **存储容量 ≠ 注入预算**（R19）：热文件最多 9000 字符，每会话简报硬上限 `briefBudgetChars`（默认 **6000**）；在完整条目边界裁剪并给出省略计数，优先级为当前任务/强约束 > hub 路标 > 最近决策/踩坑 > 可选偏好。按 Unicode code point 计数，最终消息再校验上限。
- 每次注入都在脚注报告实际用量，模型可感知「还有多少预算」。
- 后续 `agent/pre-step` 仅当热层内容哈希变化时注入**差异摘要**（最多一次/版本，同样受预算限制）；每次都用 `{kind:'enter', messages:[...decision.messages, injected]}`，不得重复附加同一版本。
- 简报内容**每会话只注入一次**，不做每轮重注（避免上下文单调膨胀）。
- 注入文本把 vault 内容标为**可引用的数据而非指令**；笔记中即使出现“忽略上文”等语句，也不得提升为系统/用户命令。若索引未就绪，注入状态说明并在就绪后补发一次，不制造“空记忆”假象。

---

## 9. 工具面（`mem_*`）

`tools.register(defineTool({...}))`；`parameters` 用 DSH 简写 DSL（逐属性 `required: true`，对象节点必须写 `additionalProperties`）。

**工具面刻意收敛到 6 个**：工具 schema 每轮都在上下文里，竞品调研的结论是「5 个小工具」优于大工具面（`dsh-obsidian` 的 12 个工具是纯管道、没有记忆模型）。高频动作用专用工具保证可发现性，低频维护动作折叠进 `mem_admin`。

| 工具 | 入参 | 行为 |
|---|---|---|
| `mem_search` | `query`（必）, `scope`（`project`\|`global`\|`all`，默认 `project`）, `type`, `projectId`, `includeHistory`（默认 false）, `limit`（默认 8） | 项目域默认隔离；跨项目检索需显式 `all`。返回路径、标题、片段、来源和排序信号 |
| `mem_read` | `path`（必，vault 相对路径）, `section`（可选标题） | 只读允许索引的 `.md`，拒绝 `.history/` 等内部目录；重验源文件后返回正文、frontmatter、内容哈希；大小超限时明确报错 |
| `mem_write` | `type`（必）, `title`（必）, `body`（必）, `tags`/`status`/`confidence`/`assertion`/`supersedes`/`id`/`idempotencyKey`（可选） | type→目录；未传 id 只创建，传 id 才尝试更新；持久快照、MOC、收据和索引按 §10.4 的事务协议处理；supersede 必须验证旧 ID |
| `mem_log` | `text`（必）, `session`?/`section`?/`idempotencyKey`? | 日志按会话和序号追加且幂等；`section: hot` 用受控区块更新，容量不足时先归档或拒绝 |
| `mem_brief` | — | 返回当前热简报（与注入同源，便于模型主动重读或核对预算） |
| `mem_admin` | `action`（必：`lint`\|`index`\|`bind`\|`projects`\|`promote`\|`jobs`）, `path`?/`rebuild`?/`mode`（bind: `show`\|`fork`\|`retain`\|`local`）?/`jobId`?/`retry`? | 低频维护；lint 默认为只读，明确请求生成报告时才写入；jobs 查看失败任务并显式重试；promote 只读源笔记并创建方法笔记，保留来源链接 |

`mem_search.scope=project` 只查当前绑定项目，传入不同的 `projectId` 时拒绝而不是静默跨项目；`global` 查 `方法/` 和只读的 `_meta/user.md`；`all` 才允许跨项目并可再用 `projectId` 过滤。无项目绑定的上下文只能用 `global`，`project` 返回明确未绑定状态。

**工具写入边界**：任何对人类笔记、无插件写入记录的既有文件、或自上次插件写入后被外部编辑的文件的修改一律拒绝，转为收件箱建议（§10.3）。`source` 仅是证据渠道；`source: human` 也可能是 agent 整理用户原话，不能单独决定文件所有权。

---

## 10. 自动提炼（会话结束写回）与安全边界

### 10.1 链路

```
session/event 中的 turn/end(completed)
  → 记录 (sessionId, fromSeq, toSeq)，只捕获有真实用户消息的根会话
  → 截取已提交事件，白名单过滤并持久化 0600 pending job
  → 空闲 90s 后单飞提炼；新回合到来则重设 debounce
  → ctx.llm.stream 单次无工具调用 → 提取 JSON → schema/证据校验
  → 把校验后的结果先写回 pending job，再逐项幂等应用
  → 写成功/空结果/失败收据；完成后清理 pending job
```

`agent/turn-stopping` 在回合边界提交**之前**，不能当作完成事件；`agent/disposed` 是通知，不能等待异步提炼，更不能假设此时还能安全派生 subagent。它只用于催促把已有 pending job 落盘。`session/event` 是**提交后、fire-and-forget** 通知，因此只做短小的同步捕获/排队。P0 实测（`docs/p0-compatibility.md`）：`session/flush` 是**每请求检查点**，在回合开始前也会触发，收到 flush 不得假定回合刚结束；但在 `turn/end` 之后的 flush 里 `session.snapshotEvents()` 含全部已提交 `turn/end`，所以**存活进程内**可在 flush 的 awaited barrier 补扫未入队的完成回合。若进程在 90 秒内退出，下次插件启动扫描 pending 队列继续；**尚未 fsync 到 pending 的极短崩溃窗口无法仅凭该通知保证不丢**：flush 只能读已提交事件，不能恢复从未提交的回合；DSH 持久会话日志（`$DSH_HOME/sessions/<slug>/<id>/session.v3.jsonl.zstd`）确实存在、重启补扫原理上可行，但 P0 未验证其多帧读取路径，因此 G3 按“成功入队后至少一次”验收，不宣称更强。停止运行期间不声称已完成提炼。`turn/end.reason` 只有 `completed` 才进入常规提炼；中止/错误只记状态，不把未完成草稿当结论。

同一根会话在 debounce 内的多个完成回合合并成一个 pending job，范围从上次成功收据的 `toSeq` 到最新 `turn/end.seq`；正在提炼时到来的新回合另建后继 job。只取最后一条不含 tool-call 的已提交 assistant 文本作为该回合结论，排除中间工具调用前的草稿。任务失败采用有上限的指数退避（默认 `maxRetries=3`），之后标为 `failed` 保留供 `mem_admin(action=jobs)` 查看和显式重试，不在每次启动无限调用模型。

提炼采用可选的 `ctx.get('llm')` 服务和当前会话最后一次已记录的 provider/model 路由；缺服务或路由时保留 pending 并记 `deferred`，不凭空生成摘要。v1 不借用 subagent，避免子会话递归触发提炼和父 agent 销毁后的生命周期问题。单次调用使用 `maxInputChars`、`maxOutputTokens`、超时与 AbortSignal；实际 token/耗时只作审计，不用未知模型价格假装能预先保证美元成本。

**实测的 `ctx.llm.stream()` 契约（P0 Task 2，字段级证据见 `docs/p0-compatibility.md`）**：`stream({provider,model,messages,system,maxTokens,signal})` 直接返回 `AsyncIterable<StreamChunk>`（无 `llm/stream` 监听器时同步返回，不是 Promise；`messages` 每条需 `id`/`role`/`content`/`source`）。一次成功流的块序是 `block-start → (reasoning-delta|text-delta) → block-end → usage → finish`，`usage` 在终止块之前，`finish.reason.kind` 取 `stop|max-tokens|tool-calls|aborted|error`。**路由失败、取消与超时都不会向调用方抛错**——它们都归一化为终止块：空路由（`provider:''`/`model:''`）得到 `finish.reason.kind='error'`、`failure.code='NO_ADAPTER'`；调用方 `AbortSignal` 与 `AbortSignal.timeout()` 触发后得到 `finish.reason.kind='aborted'`（`failure.code='ABORTED'`，且 `failure.message` 不区分超时与用户取消）。因此提炼实现必须：先解析出非空路由再调用（空路由不可能成功）；以终止块的 `reason.kind` 作为唯一结果判据，不靠 try/catch 捕获"取消"；容忍 `aborted` 流没有 `usage`、没有 `block-end`。

只送入真实用户消息、已提交的 assistant 最终文本、已验证的工具名称/退出状态及有限的路径与行号。根会话用 `session.header.parentSession`/`origin` 排除子 agent。绝不读取 DSH 的凭据配置、环境变量、推理块、原始工具输出、插件注入和子 agent 转写；用户消息/最终文本仍可能自行包含未知密钥，故对常见凭据格式做确定性扫描，命中时跳过整条消息并报告，不能宣称已穷尽所有敏感信息。超限按最近完成的回合裁剪并记录省略范围。只提取项目决策、约定、踩坑，排除对网页/论文/个人材料的摘要或“见解”。外部文本是数据，提炼器不得把其中的命令当系统指令；该 LLM 调用不附带工具 schema。待处理快照位于 `~/.dsh/data/obsidian-mem/pending/`，权限 `0700/0600`，不进 vault、Git 或日志；用户可关闭自动提炼。README 明示本地暂存、二次模型调用和剩余隐私风险。

### 10.2 提炼输出契约（严格 JSON）

```json
{ "items": [
  { "type": "decision",
    "title": "调度器改为可插拔后端", "body": "简短结论与适用范围",
    "tags": ["dsh-mem/decision"], "confidence": 0.91,
    "assertion": "stated", "status": "accepted",
    "supersedesId": null, "evidenceSeqs": [42, 48] }
] }
```

自动提炼只生成 `decision|gotcha|convention` 候选；完整 `doc` 与 `glossary` 必须显式经 `mem_write` 创作，不能把会话摘要冒充成文档。上限 `distill.maxItems`（默认 12）。每个 `evidenceSeqs` 必须指向本次允许的、已提交事件；无证据、类型错误、超长内容或跨项目路径直接拒绝。`accepted` 决策须引用用户明确确认；“代码已改”只能证明实施事实，不能替用户批准决策，否则降为 `provisional`。`observed` 不能只凭模型叙述或工具退出码，须由插件对所引用的文件/结果再做确定性复核，否则降为 `inferred`。`confidence < minConfidence`（默认 0.75）进入收件箱，不能自动取代已有结论。空结果合法，并写 `no-memory` 收据。

### 10.3 硬边界（补偿 D4 的全自动风险）

1. **路径边界**：写目标必须在当前项目预定的 `文档/决策/约定/踩坑/日志/收件箱/_meta/`；`方法/` 仅显式 promote 可写，`_meta/user.md` 永远只读。路径规范化后逐级 `lstat`，拒绝 symlink/别名跳出 vault、`..`、绝对路径和设备路径；创建使用独占语义。
2. **人类文件零修改**：`trust: owner`、缺少插件所有权记录、或文件哈希与上次插件写入不符，都不得改动。`source` 不表示作者。也**不自动追加**“相关（agent）”到人类笔记；只另建收件箱建议并链接原文件。
3. **不丢历史**：取代旧结论时旧笔记留在原路径，仅作带快照的状态更新。普通 agent 文件、MOC、hot 等发生修改前复制旧字节到 `_meta/.history/<txId>/`，再原位原子替换；不用“移走旧文件再写新文件”的空窗。快照不参与检索。
4. **收据与恢复**：收据记录事务 ID、session/seq、动作、路径、前后哈希和结果，按时间追加。Git 可由用户另行配置为备份，但既无自动 commit，也不作为事务回滚前提。
5. **可关与试跑**：`autoCapture` 关闭时不产生任务；`distill.dryRun` 只写结果收据，不改记忆笔记、MOC、hot。dryRun 可用于先观察提炼质量。
6. **降级诚实**：LLM 不可用、超时或校验失败时任务保持 pending/failed 状态，收据写原因；确定性日志只记会话 ID、时间与状态，不存原始对话，更不冒充已提炼的知识。
7. **成本护栏**：输入字符、输出 token、单次超时和失败重试次数均有硬上限；收据记录实际可得的 token 与耗时。模型价格未知时不作虚假的货币预算保证。
8. **隔离**：专用 vault 是隔离边界。Obsidian 的 Excluded files 只减少部分界面的可见性，不能当作与个人 vault 隔离的替代品；[官方设置说明](https://obsidian.md/help/settings)对其作用范围有明确描述。
9. **离载文件保护**：已识别为按需下载的根路径拒绝自动写入；未知提供商不能可靠按路径识别。dataless 或暂时性 I/O 错误视为“不可安全读写”，暂停该文件的更新并显式报错；`blocks===0 && size>0` 只是 macOS 的提示，不是跨平台的唯一判据，不允许按空文件覆盖。

### 10.4 多文件写入与幂等协议

1. 在 vault 外取得按 `realpath(vaultPath)` 哈希划分的**全 vault 写锁**；锁路径为 `~/.dsh/data/obsidian-mem/locks/vault-<sha256(realpath(vaultPath))>.lock`，未完成事务清单在同一数据根下的 `transactions/<vaultHash>/<txId>.json`，记录 PID、启动时间与事务 ID。测试必须把数据根重定向到临时目录。`_meta/项目注册表.md` 与 `_meta/log.md` 是跨项目共享文件，只有按项目分别加锁会让不同项目的写入互相覆盖；v1 单人场景采用全 vault 串行，避免双锁顺序与死锁。锁陈旧时先检查进程与未完成事务，不能仅按时间抢锁。Obsidian/其他编辑器仍可能并发编辑，所以写锁之外还须比较源文件哈希。
2. 校验目标路径、schema、所有权、原始哈希、空间和输出大小；先将全部新内容写临时文件并 `fsync`，保存所有将被改动文件的旧字节快照和事务清单。禁止部分校验通过就开始写。
3. 按“新笔记 → 旧笔记状态 → MOC/热层/注册表 → 收据”应用，并对每一步记录完成状态；改旧文件前立即复核哈希，再用同目录原子 `rename`。新文件先写并 `fsync` 同目录临时文件，再以 `link(temp, target)` 独占发布（或经平台测试的等价方法），不使用会覆盖目标的 `rename`。目录项变动也需 `fsync`。任一步失败，先逐个比对当前文件哈希是否仍等于本事务刚写出的哈希：**只有相等才可**把新建文件移入 `.history/<txId>/`、用快照恢复已修改文件；若外部编辑已经介入，保留当前文件和快照，标记冲突并停止后续自动写入，绝不以回滚覆盖外部编辑。恢复失败保留清单，`mem_admin(action=lint)` 明示需人工修复。
4. 恢复或重试依稳定 ID、`idempotencyKey` 和内容哈希识别已完成步骤。收据成功后才更新索引；索引失败不会撤销 vault 事务，但标记 stale 并重建。进程崩溃后先恢复未完成事务，再处理新任务。

写锁只协调本插件的进程，Obsidian 和其他编辑器不遵守它。哈希复核能发现常见并发改动，但本地文件系统没有跨应用的“比较哈希后原子替换”操作；极短竞态是剩余风险，P1 集成测试要覆盖两个不同项目同时写入共享注册表/收据，以及回滚期间外部编辑同一文件，冲突时保留两份内容并停止自动改写。

---

## 11. 维护与治理

| 节奏 | 动作 | 触发方式 |
|---|---|---|
| 每次写入 | 收据 + MOC 登记 + 索引更新 | 自动（写入协议内） |
| 每次会话 | 简报预算检查；hot 超过 67% 时尝试搬出已完成条目，无法安全搬出则提示并拒绝超限写入 | 自动 |
| 每周 | `mem_admin(action=lint)` 体检（孤儿、死链、重名、frontmatter 缺口、过期、file↔db 不一致、仓库文档漏检、pending 积压） | 会话开始时若距上次 >7 天则提示运行（v1 不引入常驻定时器） |
| 需要时 | `mem_admin(action=promote)` 提升跨项目方法 | 模型或用户显式触发 |

> v1 不实现常驻定时器：DSH 无插件级 daemon 定时器（`dsh-schedule` 是会话内提醒工具），维护动作以「会话开始时提示 + 工具显式调用」实现。

---

## 12. 配置

`Config` 用 schemastery（Standard Schema v1），在 `apply` 前**急切校验**；行内 `config:` 为**整体替换**（R9）。v1 以 row config 为唯一权威配置入口，避免把可选 settings 服务当作依赖；将来若增加 GUI 编辑，须证明两处配置的优先级和迁移规则。

```js
z.object({
  enabled: z.boolean().default(true),
  vaultPath: z.string().default('~/Documents/dsh-memory'),
  initGitOnCreate: z.boolean().default(true),
  injectBrief: z.boolean().default(true),
  briefBudgetChars: z.number().default(6000),   // 注入预算（R19）
  hotCapacityChars: z.number().default(9000),   // 热文件容量（存储 ≠ 注入）
  hotArchiveRatio: z.number().default(0.67),
  autoCapture: z.boolean().default(true),
  captureIdleMs: z.number().default(90000),
  distill: z.object({
    provider: z.string().default(''),        // 空 = 使用会话最后的已记录路由
    model: z.string().default(''),
    maxItems: z.number().default(12),
    minConfidence: z.number().default(0.75),
    maxInputChars: z.number().default(24000),
    maxOutputTokens: z.number().default(4000),
    timeoutMs: z.number().default(60000),
    maxRetries: z.number().default(3),
    dryRun: z.boolean().default(false),
  }),
  indexBackend: z.union([z.const('auto'), z.const('sqlite'), z.const('scan')]).default('auto'),
  ignoreGlobs: z.array(z.string()).default([]), // 只追加排除项；安全必排目录不可取消
})
```

实现层的 v1 范围校验：`briefBudgetChars` 为整数 256–20000（须容纳状态脚注），`hotCapacityChars` 为整数 1024–50000（须容纳固定分区模板），`captureIdleMs` 为整数 1000–3600000；`distill.maxItems` 为整数 1–50、`maxInputChars` 为整数 256–100000、`maxOutputTokens` 为整数 128–32000（须容纳最小 JSON）、`timeoutMs` 为整数 1000–300000、`maxRetries` 为整数 0–10；`hotArchiveRatio` 严格在 `(0,1)`，`minConfidence` 在 `[0,1]`。`vaultPath` 不可为空；显式路由的 `provider` 和 `model` 必须同时填写或同时留空。完整配置示例须写出 `distill` 对象，因为 DSH patch 不深合并。目录名、指针名和保留前缀属于协议常量，v1 不开放可改配置，避免配置漂移后误写到别处。

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
│   ├── transaction.js    # 项目锁、快照、原子写入、恢复与幂等
│   ├── index-db.js       # FTS5 + CJK bigram + 增量
│   ├── tools.js          # mem_* 注册
│   ├── hooks.js          # 会话钩子与注入
│   ├── capture.js        # turn/end 采集、持久队列、过滤与提炼
│   ├── lint.js           # 体检
│   └── assets.js         # 技能幂等同步
├── skills/obsidian-mem/SKILL.md   # 随包技能（方法论）
├── test/                 # node --test
├── docs/                 # 本设计与实施计划
└── README.md / CHANGELOG.md / LICENSE(MIT) / AGENTS.md
```

**运行期依赖**（保持极小）：`schemastery`（配置 schema）、`yaml` v2.x（frontmatter 解析/定点序列化）。索引用 Node 内置 `node:sqlite`（无原生依赖）；不需要 `better-sqlite3`、embedding 库或常驻文件 watcher。`engines.node` 至少覆盖实测可运行的 Node 版本；发布前在声明的最低版本上跑完整测试。

### 13.2 安装与验证
```sh
dsh plugin --profile web add link:/Users/yukisala/subject/dsh-obsidian-mem
dsh --profile web --dump-config | grep -n obsidian-mem      # 确认行已装配
# 重启 dsh web；插件源码改动必须重启（R9）
```

**验证清单**（也是 §15 的验收用例）：行出现在 `--dump-config`；首个 `pre-step` 恰好注入一次简报且 ≤ 预算；`mem_search "调度器"` 能命中中文笔记；`mem_write` 落点正确、MOC 与收据更新；supersede 生成两篇状态正确的笔记；真实回合完成后产生 pending→结果→收据；中途重启不重复写；外部改过的文件不被覆盖。

### 13.3 禁用 Hindsight（用户决策 D7，**只给步骤不代改**）

在 `/Users/yukisala/.dsh/cordis.patch.yml` 追加：

```yaml
- id: hindsight
  disabled: true
```

该文件是 home 级 patch 层，追加时必须保留现有 `agent-presets` 等行。先用 `dsh --profile web --dump-config` 确认 `hindsight` 行已禁用；web profile 的 `patchReload: live` 可能使新会话热应用，但为避免旧会话仍持有插件实例，切换记忆层时重启 `dsh web` 并新建会话验收。

---

## 14. 测试策略

| 层级 | 内容 |
|---|---|
| 单元（`node --test`） | projectId/指针/工作树绑定；YAML 字节保真更新与冲突；路径 traversal/symlink 拒绝；标题同日不合并；idempotencyKey 重试；CJK 二元组和单字回退；BM25 方向；热层完整条目裁剪；只允许证据 seq 的提炼输出 |
| 集成 | 临时 vault + 仓库：bootstrap 不移动既有文件；并发改文件后写入必须拒绝；在“新笔记已写、MOC 未写”“收据未写”“索引未更新”三个故障点强制中断并恢复；二次执行无重复 ADR/日志；人类笔记零修改 |
| 生命周期冒烟 | 真实 DSH 临时 profile：`turn/end(completed)` 在已提交转写之后可见；首轮 pre-step 注入一次；abort/error 不产生结论；90 秒内进程停止后启动能恢复 pending；无 LLM 服务时进入 deferred 而不丢任务 |
| 检索验收 | 至少含中英混合、两字词、单字、同名标题、superseded、同 mtime/size 改写、损坏 frontmatter 的固定语料；比较 SQLite 与 scan 后端的范围/状态过滤一致性和前 8 命中，记录时延 |
| 回归 | 用本项目作 dogfood：vault 内固定 ID 目录 + 仓库 `.obsidian-mem`；先 dryRun，再核对收据、笔记质量与仓库文档漏检报告 |

---

## 15. 实施阶段与验收标准

| 阶段 | 交付 | 验收 |
|---|---|---|
| **P0 兼容性原型** | 用当前安装的 DSH 建最小插件，证明 `session/event → turn/end`、`pre-step` 注入、`ctx.get('llm').stream` 路由和取消、`node:sqlite` FTS5；不用真实 vault | 保存事件顺序/输出契约证据（Task 1 见 `docs/p0-compatibility.md`）；任一关键 API 不满足则先修订本设计再实施 |
| **P1 骨架与读写** | 包结构、指针/固定目录绑定、bootstrap、frontmatter、事务恢复、索引、六个工具 | 临时 vault 全链路测试通过；重复写入/崩溃重试幂等；人类或外部编辑文件不被覆盖；中文检索命中 |
| **P2 注入与技能** | session-start/pre-step、ready 屏障、预算简报、systemPrompt 区块、随包技能 | 首个请求有一次简报且 ≤ `briefBudgetChars`；超时后就绪能补发；技能出现在 `~/.dsh/skills/obsidian-mem/` |
| **P3 自动提炼与治理** | 持久 pending、过滤、直接 LLM 提炼、`mem_admin{promote,lint,projects,jobs}`、离载文件保护 | 完成回合自动入队；中止回合不沉淀结论；重启恢复且无重复；低置信进收件箱；dryRun 只写收据；外部改动零覆盖 |
| **P4 文档与发布** | README/CHANGELOG/AGENTS.md、测试补齐、dogfood 记录、npm 打包校验（`prepack` 校验脚本） | `npm pack` 内容正确；`node --test` 全绿；README 能让第三方 5 分钟内装上 |

---

## 16. 风险与未解问题

| # | 风险 | 应对 |
|---|---|---|
| 1 | **文档不随代码走**：他人克隆仓库看不到 vault 中的报告/设计稿；换机器需单独同步 vault | README 明示；提交的指针只有 projectId；用户自行选 Git 或 Obsidian Sync 的一种同步/备份方式，不在 v1 假设镜像开关已存在 |
| 2 | **DSH API 迭代快** | P0 锁定当前安装版的 `session/event`、`pre-step`、`llm.stream` 契约；v1 只用 row config，不依赖可能变化的 settings 注册 |
| 3 | **调试困难**：`ctx.logger` 不落盘、改源码需重启 | 验证以 `--dump-config` + 文件系统断言为主；`mem_admin(action=index)` 状态与收据可读 |
| 4 | **全自动写入产生噪声** | 硬边界（§10.3）+ `maxItems` + 置信阈值 + `review_after` + lint 的「收件箱积压」检查 + 先跑 dryRun |
| 5 | **中文检索质量** | CJK bigram（R3）+ 类型权重 + 片段自研（bigram token 无法映射回原文） |
| 6 | **vault 同步冲突** | 预检按需下载目录；插件写入比较哈希并保存旧字节；用户若启用 Git，自己设置 ignore/remote/备份；不得把 Obsidian Sync 与云盘按需下载叠用 |
| 7 | **重名 basename 导致链接歧义** | 写入时保证 basename 唯一（冲突加后缀）；lint 检测；必要时路径限定链接 |
| 8 | **提炼成本与延迟** | 空闲 debounce、单飞、输入/输出/超时硬上限；失败保留 pending 并报告，不以空日志伪装成功 |
| 9 | **与既有 in-repo vault 并存**（如 `~/subject/Xerintosh/doc`） | v1 不动、不迁移；lint 输出「可纳入候选」清单 |
| 10 | **模型路由**：提炼用哪个 provider/model | 优先显式配置，否则取最后一次已记录路由；路由缺失则 deferred，待下次可用时恢复。**P0 实测：空路由不是"用默认值"，而是终止块 `finish.reason.kind='error'`、`failure.code='NO_ADAPTER'`**，所以解析不出路由时绝不可发起调用 |
| 11 | **文档覆盖率无法从插件单方面保证** | 权威 `mem_write` + 只读仓库 Markdown 审计；README 写清外部编辑器/命令产生的缺口 |

**P0 必须关闭的风险**：① `session/event` 对完成回合的顺序和作用域（Task 1 已关闭，见 `docs/p0-compatibility.md`）；② `llm.stream` 对当前 provider/model、超时与取消的真实行为（**Task 2 已关闭**：显式路由返回 `AsyncIterable<StreamChunk>`，成功块序 `block-start→…→usage→finish`，空路由与取消/超时都归一化为终止块而**不抛错**；见 `docs/p0-compatibility.md` §8）；③ 同一回合首个 pre-step 的注入时机（Task 1 已关闭：首个 `request/header` 晚于 pre-step 5 个事件）；④ 最低受支持 Node 版本的 FTS5 与文件写入 API（**Task 2 已关闭**：`engines.node >= 22.22.2`；Node 22.13.0 实测**无** `ENABLE_FTS5`，22.22.2/25.9.0 实测 FTS5 与全部文件原语可用，22.14–22.21 未实测）。

---

## 17. 附录

### 17.1 与竞品的差异化（15 个对照，详见 `research/obsidian-agent-memory-prior-art.md` §2.8）

| 维度 | 竞品现状 | 本设计 |
|---|---|---|
| repo↔vault 绑定 | 调研样本中多靠 basename 推断 | 稳定 projectId 的 `.obsidian-mem` 指针 + vault 注册表（调研样本中未见同等实现） |
| 文档与记忆 | 要么只管记忆，要么只管 vault 访问 | 同一 type 路由协议同时治理文档与记忆 |
| 记忆生命周期 | 仅 `dsh-math-memory`/`memory-for-ai` 涉及；DSH 侧普遍无 supersede | supersede/contested/confidence/assertion/review_after 全套 |
| 注入 | 两极：全注入或零注入 | 预算化导航注入 + 增量 + 新鲜度脚注 |
| 自动提炼 | 归档原始转写（反模式）或无 | 结构化蒸馏 + 硬边界 + 收据 |
| 索引位置 | 多数在 vault 内 | vault 外（不污染、不进同步） |
| 可移植性 | 各插件自成一派 | vault 内的协议是**纯 Markdown + frontmatter**，DSH 插件只是第一个适配器（§17.2） |

### 17.2 可移植性定位

调研的最终建议是：做**可移植的、带生命周期的项目记忆协议**，而不是又一个 vault 包装器。因此本设计的产物分两层：

- **协议层（可移植、无 DSH 依赖）**：目录约定 + §6.4 的 frontmatter 词表 + §10.2 的提炼输出契约 + `.obsidian-mem` 指针文件。任何 harness（Claude Code / Codex / Cursor）都能读懂并遵守；随包技能 `SKILL.md` 用 Agent Skills 格式书写，本身即可跨 harness 复用。
- **适配器层（DSH 专属）**：`tools.register` 的工具面、`ctx.on` 的钩子、`systemPrompt.section` 公告、`node:sqlite` 索引。

这样即使 DSH 的 cordis API 迭代（已有两个上游插件因此停摆），协议与 vault 内容不受影响。

### 17.3 调研产出

| 文件 | 内容 |
|---|---|
| `research/obsidian-agent-memory-prior-art.md` | 1263 行 / 103 条引用 URL / 19 项本机实测 / 18 处显式 UNVERIFIED / 28 项目对照：竞品、方法论、frontmatter 契约与普查、访问路径实测、同步与数据丢失路径、文件名政策、未解问题 |
| `research/dsh-plugin-api-reference.md` | 3064 行：DSH 插件契约（包/补丁/模块/服务/事件/持久化/安装调试），自 240 个第一方包实现级反推 |
| `research/dsh-agent-session-events.md` | 761 行：13 个 agent 事件 + 4 个 session 事件 + 转写读取 + 五种注入 API |
| `research/dsh-tools-register-api.md` | 1369 行：`tools.register` 完整契约与参数 DSL |

### 17.4 参考的方法论（用户提供）

三层分级记忆（热 9000 字符 / 温 vault 文件按需读 / 冷每日笔记）+ 内容路由规则 + 维护节奏（每周孤儿清理、每月结构审计）+ 「Obsidian 四理由」（纯文本无依赖、反链图谱、可搜索历史、脱离 AI 独立运作）。

### 17.5 证据质量声明

- **「agent 是否该写进人类 vault」这一问题上没有任何定量证据**，也没有论坛大讨论：R20 是从第一方设计陈述（kepano/Späti）出发的**推理综合**，不是有实测结果的共识。引用的 kepano 原话来自 X 帖镜像站，**未能对 X 原帖验证**（标记 UNVERIFIED）。
- 相邻的唯一定量结果是 Chroma 的 *Context Rot*（18 个模型），它衡量的是**模型行为**，不是 vault 行为。
- Reddit 的 JSON API 全路径 403（仅 `.rss` 可用），r/ObsidianMD 的情绪样本偏少。
- R15–R17 与 R21 的部分行为来自本机 Obsidian 1.12.7/Node 25.9.0 实测；R18 的性能数据是社区报告，不是本机测量；R20 是设计推论。特定版本的观察不能推广为所有未来 Obsidian/Node 版本的 API 保证。
- DSH 生命周期语义来自当前安装版类型声明与实现，P0 必须在真实事件序列中再确认。对人类阅读体验与自动提炼质量没有量化结论，先用 `distill.dryRun` 观察，再核对实际笔记。

### 17.6 本次复审核对的第一方资料

| 资料 | 对设计的直接影响 |
|---|---|
| [Obsidian 属性](https://obsidian.md/help/properties)与[标签](https://obsidian.md/help/tags) | 同名属性全 vault 同类型；`tags` 写列表 |
| [Obsidian 文件存储](https://obsidian.md/help/data-storage)、[设置](https://obsidian.md/help/settings)、[内部链接](https://obsidian.md/help/links) | 外部文件写入可被刷新；内部链接为 vault 内；Excluded files 作用有限；路径限定链接可用 |
| [Obsidian Sync FAQ](https://obsidian.md/help/sync/faq)与[切换同步指南](https://obsidian.md/help/sync/switch) | 云盘在线文件和双重同步会造成冲突或远端误删除；`~/Documents` 不天然安全 |
| [Node `node:sqlite`](https://nodejs.org/api/sqlite.html)、[SQLite FTS5](https://www.sqlite.org/fts5.html) | `DatabaseSync` 是同步 API；FTS5 评分方向和查询语法需正确实现 |
| 本机 `dsh-session`、`dsh-agent`、`dsh-llm` 类型声明（DSH 0.1.5-rc.2）及 `research/dsh-agent-session-events.md` | `session/event` 是提交后通知，`session/flush` 是 awaited barrier，`agent.inject()` 存在错过 pre-step 的时序，`ctx.llm.stream` 需要明确 provider/model |

### 17.7 复审后仍须用原型验证的边界

1. `session/flush` 与 DSH 持久会话读取能否覆盖事件通知到 pending fsync 之间的崩溃窗口；不能则把 G3 的持久保证严格限定为“入队以后”。
2. 最低 Node 版本、DSH profile 组合和 Obsidian 打开/关闭两种状态下，索引、frontmatter 与并发编辑是否都按本设计工作。
3. 用真实项目回合评估自动提炼的精度、噪声和成本；若证据不足，保持候选在收件箱，不用更激进的自动覆盖换取表面召回率。
