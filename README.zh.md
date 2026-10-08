# dsh-obsidian-mem

[English](README.md) | 中文

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Node >= 22.22.2](https://img.shields.io/badge/node-%3E%3D22.22.2-brightgreen.svg)](#requirements)
[![DSH plugin](https://img.shields.io/badge/DSH-plugin-blueviolet.svg)](https://github.com/topics/dsh-plugin)

一个 **DeepSeek Harness 宿主端插件**，把项目的文档和长期记忆以纯 Markdown 存进一
个专用的 [Obsidian](https://obsidian.md) 仓库(vault)里。

一个代码仓库对应一个稳定的 `projectId`、一个提交进版本库的指针文件，以及仓库里一
个固定目录。插件往那里写；Obsidian 只负责把结果展示给你。Obsidian 不需要处于运行
状态，仓库的任何部分也不依赖 DSH。

```
repository                                vault (~/Documents/dsh-memory)
├── .obsidian-mem   ───────────►          └── Projects/<slug>--<projectId 前8位>/
│     projectId, slug,                    ├── index.md                hub / MOC
│     displayName, schema: 1              ├── Docs/  Decisions/  Conventions/  Pitfalls/
└── src/ …                                ├── Daily/YYYY-MM-DD.md
                                          ├── Inbox/                  待分类
                                          └── _meta/hot.md            热记忆
```

分成两层，这是刻意的：

- **协议层**（仓库布局、`.obsidian-mem` 指针文件、笔记 frontmatter、蒸馏输出契
  约）是纯 Markdown，与 DSH 无关。随包发布的技能 `skills/obsidian-mem/SKILL.md`
  遵循 Agent Skills 格式，所以在别的 harness 里也能用——[`codex/`](./codex/README.md)
  把这份协议**连同同样那六个操作**装进 Codex CLI，走的是一个复用 `lib/`（而不是复
  制一份）的 MCP server，另加会话简报与每次新提问的相关笔记索引钩子。
- **适配层**是 DSH 专属的：六个 `mem_*` 工具、一个放在仓库之外的 `node:sqlite`
  搜索索引，以及对已完成回合的自动蒸馏。召回注入已经不在这一层：两个 harness 现在
  用同一个 `buildBrief` 合成它，各自用自己 harness 的扩展点投递。

> **在开启自动写入之前，先读[诚实边界](#honest-limits)。**
> 本插件对自己拒绝什么很谨慎，但它还很年轻。下面写的是本版本愿意写下来的边界，不声
> 称穷尽；`CHANGELOG.md` 里是"验证过什么、还没验证什么"的持续记录。
>
> 出问题时，本包可以生成一份由你自己附到 Issue 上的报告：先生成，读一遍 JSON，再
> 自行附上。见[用于 Issue 的诊断报告](#diagnostic-report-for-an-issue)。

---

<a id="requirements"></a>
## 环境要求

| | 版本 | 原因 |
|---|---|---|
| Node | `>= 22.22.2` | 这个下限是一次*实测*。`node:sqlite` 在 Node 22.13.0 上能 import，但那个构建没有 FTS5；22.22.2 和 25.9.0 有。22.14–22.21 未测试，所以这个下限是实际被证明可用的最低版本。 |
| DSH | `0.1.5-rc.2`、`0.1.7-rc.2` | 这是插件实际被验证过的两个版本；哪条测量出自哪个版本，`docs/p0-compatibility.md` 和 `docs/smoke-results.md` 各有记录。插件只用了行内 `config:` 和已有文档的 Cordis 接缝，所以别的版本很可能没问题——但“很可能”不等于“已测试”，因此这里只列被测量过的版本。 |
| Obsidian | 任何较新版本 | 可选。只在你想舒服地*阅读*仓库时才需要。 |

运行时依赖刻意做得极小：配置校验用 `@deepseek-ai/schemastery`，frontmatter 用
`yaml`。`node:sqlite` 是 Node 内置的，所以没有需要编译的原生模块。

DSH 下限声明在生态约定的位置上——`package.json` 里的 `engines.dsh`，
`dsh.plugin.json` 里是同一个区间。实测：已安装的 harness 里没有任何代码读这个键
（在所有已安装的 `@deepseek-ai/*` 包里搜 `engines.dsh` 没有任何命中），所以它是给
注册表和市场工具看的声明，不是 DSH 会强制的门槛。

---

## 五分钟安装

### 1. 选择本地仓库目录

```sh
vault="$HOME/Documents/dsh-memory"     # any path on local disk; the default
mkdir -p "$vault"
```

把它放在**本地磁盘**上——见[仓库必须在本地磁盘](#the-vault-must-be-local)。不要把它指
向你已经在维护的个人仓库；本插件会把项目目录写进仓库根目录，虽然它拒绝碰不属于自
己的文件，但用一个专用仓库可以让两者永不相遇。

### 2. 先在一次性 profile 上验证

下面是被实测过的确切步骤，而且不需要 checkout——`github:` 是生态里指代 GitHub 仓库
的简写：

```sh
# A clean DSH home for the trial run: nothing here touches your real ~/.dsh.
export DSH_HOME="$(mktemp -d)"

dsh plugin --profile memcheck add github:bonerush/dsh-obsidian-mem

dsh --profile memcheck --dump-config | grep -n obsidian-mem
#   # == dsh-obsidian-mem
#   - id: obsidian-mem
#     name: dsh-obsidian-mem

unset DSH_HOME
```

`dsh plugin --profile <name> add <spec>` 会在 profile 不存在时创建它，安装这个包，
并叠加它的 `cordis.patch.yml`——正是它挂载了 `obsidian-mem` 这一行。如果
`--dump-config` 里看不到这一行，就到此为止。

上面的输出是实测结果，不是示意：在已发布的仓库上，这条命令解析成
`dsh-obsidian-mem github:bonerush/dsh-obsidian-mem`，`--dump-config` 打印的就是那
三行。

想固定到某个版本就用 `github:bonerush/dsh-obsidian-mem#<commit>`。harness 自带的
插件搜索打印的是同样的命令形状，给的建议也一样——第三方插件就是你要运行的代码，所以
先读源码、再固定版本。

### 3. 装进你实际使用的 profile

```sh
dsh plugin --profile web add github:bonerush/dsh-obsidian-mem
dsh --profile web --dump-config | grep -n obsidian-mem
```

把 `web` 换成你的 profile 名。

如果你是从本地 checkout 开发：上面每个 `github:…` 都换成在 checkout 目录里执行的
`"link:$PWD"`——包是被链接而不是被复制，所以你的改动即时生效。本仓库自己就是这么开
发的，smoke 和 dogfood 跑的也是这个形式。

### 4. 重启 DSH 并新建会话

插件代码每个进程只加载一次：**重启 `dsh web`**（或你的 harness），并开一个*新*会
话，这样这一行才会被挂载，pre-step 注入才有会话可挂。已存在的会话仍然持有旧的插
件实例。

### 5. 在 Obsidian 中打开仓库

1. Obsidian → **Open folder as vault** → 选择仓库目录。
2. 就这些。不需要预先创建任何东西；插件会在第一次使用时引导生成项目目录——对 Git
   仓库来说，就是第一次 `mem_write` 或 `mem_log`（见[项目绑定](#verify-it-works)
   ）。
3. 插件从不写 `.obsidian/types.json`，从不改你已有的笔记，也从不在仓库里跑 Git
   命令，唯一例外是对它刚创建的目录执行 `git init`。

插件第一次接触一个已有仓库时会跑一次**属性预检**：它读取候选笔记，如果它需要的某
个属性名（`tags`、`created`、`status` 等）已经存在类型不兼容的值，就拒绝引导生
成。拒绝信息会指出文件名和属性名。你要么在仓库里改掉它，要么把 `vaultPath` 指向
一个空目录——插件不会“修复”你的笔记。预检只能看到在笔记字节里可见的值类型；见
[属性注册表无法离线读取](#the-property-registry-is-not-readable-offline)。

<a id="verify-it-works"></a>
### 验证是否生效

在任意 Git 仓库里开一个会话然后问它，或者直接检查工具在不在：

| 检查项 | 怎么做 |
|---|---|
| 行已挂载 | `dsh --profile web --dump-config \| grep obsidian-mem` |
| 项目已绑定 | `mem_admin(action="projects")` 会报告解析结果。一个**没有** `.obsidian-mem` 的 Git 仓库由它的**第一次写入**完成绑定：`mem_write` 或 `mem_log` 会生成 slug、以独占方式创建指针文件、引导生成骨架并注册项目，然后继续执行——而且这次绑定对同一会话里的下一次调用就可见。已存在的指针文件从不会被覆盖或修复；任何拒绝（指针文件损坏或 schema 未知、同级 worktree 不可读、注册表不可读、云托管仓库）都会连原因一起报告，而不是硬造一个绑定。读取永不触发绑定：在没有指针文件的仓库上，`mem_search` 和 `mem_read` 始终只读；一个**不在** Git 里的目录在 `mem_admin(action="bind", mode="local")` 之前也保持只读。 |
| 召回注入一次 | 会话的第一次请求会带一条 `obsidian-mem` 召回消息（≤ `briefBudgetChars`） |
| 提示相关笔记 | 已绑定项目的新用户提问最多可收到三条匹配笔记，每条含标题和索引命中的摘录，受各自每轮上限约束（≤ `recallBudgetChars`）；用 `mem_read` 读取全文 |
| 中文搜索可用 | 写一条笔记，然后用 `mem_search` 搜一个两字中文词 |
| 仓库文件是真的 | `ls "$vault/Projects/"`——纯 Markdown，卸载插件后照样能读 |

### 在 DSH 侧边栏查看记忆图谱

在 DSH `0.1.7-rc.2` 和 `dsh-better-sidebar` `0.21.1` 下，打开右侧原生侧边栏，
选择 **+ → 记忆图谱**。设置按钮打开与 Obsidian 关系图谱相同的四个区块：筛选、
颜色组、外观、力度。筛选中的 **范围** 可切换全部记忆/当前项目，初始显示全部记忆。
配色按 Obsidian 关系图谱的方式解析：从宿主主题读取十一个 `.graph-view.color-*` 槽位，
所以视图跟随 DSH 的浅色/深色主题，就像 Obsidian 的图谱跟随它自己的主题一样。默认是灰色
节点与连线，悬停和记忆调用用强调色高亮；颜色组初始为空。标签按 Obsidian 的
`14 + 节点大小 / 4` 的 50% 栅格化（默认值，可在滑块里调），因为它位于窄侧栏；位置、`√缩放` 缩放和悬停节点的
固定字号都与原版一致；外观区块的 **标题文字大小** 滑块可在 0.4–1.6 之间调整这个系数。
连线按 Obsidian 的文件名和相对路径规则，
解析双链、Markdown 链接、嵌入及 YAML 中的双链。
滚轮可缩放，拖动画布可平移，也可拖动节点；悬停显示标签并突出相关分支。颜色组支持
`[type:decision]` 等类型查询。视图一次最多显示 500 个节点，优先保留有链接的
中心节点和分支。全部记忆范围包含历史笔记、未创建的链接目标，以及连接项目的管理
Markdown 链接。管理笔记仍排除在记忆检索之外，图谱只显示其标签和关系。
**仅显示已创建的笔记** 可隐藏未创建目标；附件不在此 Markdown 视图中，对应控件仍禁用。

这个 DSH 进程对记忆做成一件事时，对应节点和相邻连线会短暂发光，并在任何缩放下显示
文件名，看得出动的是哪一篇：成功 `mem_read`，或宿主 `read`/`grep` 打开 vault 里的笔记
（**读**，强调色）；`mem_search` 返回的笔记（同色更轻）；`mem_write`/`mem_log`，或宿主
`edit`/`write` 写下的笔记（**写**，标签色）。一次对话里实际注入了相关笔记索引时，那些
笔记也会点亮。宿主调用只有在参数点名 vault 内某一个 `.md` 时才算触碰——`bash` 与
`run_code` 有意不算，它们的参数是命令或程序文本。动效按会话区分，只保存在进程内；宿主重启后会清空。
提示只改标签的颜色与不透明度，不改字号：同一帧里点亮的标签字号一致，同一秒内被触碰的两篇笔记不会一大一小。
图谱接口只读，仅接受本机 DSH 页面同源请求。未安装 Better Sidebar 时，六个记忆工具照常使用。

面板参数本身会被记住，不像动效那样随进程清空：范围、筛选、颜色组、外观和力度保存在本浏览器的
`localStorage` 里，单个键 `dsh-obsidian-mem:graph-settings`，刷新页面和重启宿主后依然生效。
它们属于浏览器 profile 与来源（origin），所以 `127.0.0.1:3080` 与 `localhost:3080` 是两个各自独立的面板；
这些值不会离开浏览器，上面的图谱接口保持只读。**恢复默认设置** 会把内置默认值写回存储。
别的版本写下的记录、或被手工改过的记录不会被直接信任：每个字段都会校验，不合格就回落到默认值——
一个 `NaN` 力度会让图谱直接空白，而不只是看起来不对。

浏览器资产在每次请求时重新读取：改完 `lib/` 只要刷新页面即可生效，不必等宿主重启。唯一例外是
**新增**资产：路由表在插件挂载时注册，所以新加一个文件需要宿主重新挂载一次才能被取到。

界面与力布局、绘制规则来自对本机 Obsidian 关系图谱源码的检查。Canvas 按原版
的节点大小、标签淡入和缩放规则绘制，Worker 使用原版的 D3 回退力模型。包内附带精确
固定的上游 D3 代码与完整 ISC 声明，不请求 CDN，也不增加运行时依赖。本包未包含
Obsidian 应用程序代码。

---

## 配置

配置写在插件行里，而行内的 `config:` 会**整体替换整个对象**——DSH 的 patch 层不做
深合并。所以要覆盖就必须列出每一个字段，包括 `distill`。把它写进 home 级 patch
层 `$DSH_HOME/cordis.patch.yml`，和文件里已有的内容放在一起：

```yaml
# $DSH_HOME/cordis.patch.yml
- id: obsidian-mem
  config:
    enabled: true
    vaultPath: "~/Documents/dsh-memory"
    initGitOnCreate: true
    injectBrief: true
    briefBudgetChars: 6000
    recallBudgetChars: 900
    hotCapacityChars: 9000
    hotArchiveRatio: 0.67
    autoCapture: true
    autoCurate: true
    captureIdleMs: 90000
    distill:
      provider: ""
      model: ""
      maxItems: 12
      minConfidence: 0.75
      maxInputChars: 24000
      maxOutputTokens: 4000
      timeoutMs: 60000
      maxRetries: 3
      dryRun: false
    indexBackend: auto
    ignoreGlobs: []
```

完全省略 `config:` 块，得到的就是这些默认值。`enabled: false` 什么都不注册——没有
工具、没有 hook、没有 data root、没有锁。

**未知的键是错误，不是静默忽略。** 下面的表就是完整字段集：表里没列出的键（无论
在最外层还是在 `distill` 里）都会让这一行加载失败，错误信息会点出这个键。这一点
很重要，否则一个拼写错误会让本该生效的字段保持默认值——写成 `vaultpath: "/tmp/x"`
的行会悄悄使用 `~/Documents/dsh-memory` 并在那里引导生成。错误信息还会列出设计文
档里被刻意砍掉的字段（`projectsDir`、`methodsDir`、`metaDir`、
`reservedPrefixes`、`docMirror`、`distill.mode`、`distill.maxCostPerSession`），
这样从设计文档抄来的配置会带着解释失败，而不是什么都不做。

| 字段 | 默认值 | 接受值 | 作用 |
|---|---|---|---|
| `enabled` | `true` | boolean | `false` 什么都不挂载。 |
| `vaultPath` | `~/Documents/dsh-memory` | 非空路径；`~` 会被展开 | 仓库根目录。必须是本地磁盘。 |
| `initGitOnCreate` | `true` | boolean | **只**对本插件刚创建的仓库目录执行 `git init`，且仅在 `git` 可用时。从不 commit，从不设置 remote。 |
| `injectBrief` | `true` | boolean | 是否注入会话简报和逐轮相关笔记索引。 |
| `briefBudgetChars` | `6000` | 整数 256–20000 | 会话简报与每周提醒的硬上限，单位是 Unicode 码点。 |
| `recallBudgetChars` | `900` | 整数 256–20000 | 逐轮相关笔记索引的上限，单位是 Unicode 码点。它与 `briefBudgetChars` 刻意分开：若按简报剩余额度计费，首轮命中率只有 0.6%，而后续轮次是 22.1%。 |
| `failureRecall` | `true` | boolean | 原生 DSH 工具重复失败时检索相关记忆。与提示词回忆共用每步的 `recallBudgetChars` 上限；不控制留档。 |
| `hotCapacityChars` | `9000` | 整数 1024–50000 | `_meta/hot.md` 的容量。是存储容量，*不是*注入预算。 |
| `hotArchiveRatio` | `0.67` | 开区间 (0,1) | 填充率高于此值时，插件在写入前先归档已完成条目。 |
| `autoCapture` | `true` | boolean | 捕获已完成的回合。`false` 停止新的捕获，但仍会排空已入队的 job。 |
| `autoCurate` | `true` | boolean | 自动整理（curation）回合。`false` 只关掉自动触发：`mem_admin(action="curation", operation="scan")` 和评审命令照常可用，而且两种取值都不会改动任何源笔记。 |
| `captureIdleMs` | `90000` | 整数 1000–3600000 | 被捕获的回合进入蒸馏前的空闲去抖时间。 |
| `distill.provider` | `""` | string | 模型路由。必须和 `model` 一起设置，或者两个都留空（留空 = 复用会话最近记录的路由）。从别的 harness 导入的会话没有这条路由，所以导入的历史会一直停在 `deferred`，直到设了这一项。 |
| `distill.model` | `""` | string | 见上。 |
| `distill.maxItems` | `12` | 整数 1–50 | 一次蒸馏最多接受多少个候选，包括失败留档的兜底候选。同一个数字会写进 system prompt，模型因此知道超过多少条会被拒绝；超限是整批拒绝，绝不裁剪。 |
| `distill.minConfidence` | `0.75` | number 0–1 | 低于此值的候选进入 `Inbox/`，而不是成为记忆笔记。 |
| `distill.maxInputChars` | `24000` | 整数 256–100000 | 那次模型调用的输入上限。 |
| `distill.maxOutputTokens` | `4000` | 整数 128–32000 | 那次调用的输出上限。 |
| `distill.timeoutMs` | `60000` | 整数 1000–300000 | 单次调用超时。 |
| `distill.maxRetries` | `3` | 整数 0–10 | **总尝试次数**，不是额外重试次数：`3` = 一次尝试加两次指数退避重试，之后 job 变成终态 `failed` 并保留原始输出。 |
| `distill.dryRun` | `false` | boolean | 只写回执：不写记忆笔记、不更新 MOC、不更新热记忆。**从这里开始。** |
| `indexBackend` | `auto` | `auto` \| `sqlite` \| `scan` | FTS5 不可用时，`auto` 回退到 scan 后端并报告此事；`sqlite` 则直接大声失败。 |
| `ignoreGlobs` | `[]` | 仓库/代码库相对路径的 glob 列表 | 只支持 `*`、`**`、`?` 和普通路径字符。花括号、字符类、取反和转义在启动时就被**拒绝**，而不是静默匹配错。绝对路径和 `..` 被拒绝。被安全策略排除的路径无法再被包含回来。 |

有一种过期文档要忽略：设计文档的 §12 列出了本插件**没有**的字段（`projectsDir`、
`methodsDir`、`metaDir`、`reservedPrefixes`、`docMirror`、`distill.mode`、
`distill.maxCostPerSession`）。代码实现的是计划里的字段集——也就是上面的表。目录
名和指针文件名是协议常量，不可配置。那七个字段是被**拒绝**的，不是被忽略：带了其
中任何一个的行都会加载失败，错误说明该字段按设计已砍掉。

---

## 使用

### 六个工具

| 工具 | 参数 | 作用 |
|---|---|---|
| `mem_search` | `query`（必填）、`scope`（`project`\|`global`\|`all`，默认 `project`）、`type`、`projectId`、`includeHistory`、`limit`（默认 8） | 搜索标题、正文和 frontmatter。`project` 只搜已绑定的项目，遇到不同的 `projectId` 会直接拒绝，而不是悄悄跨项目；`global` 覆盖 `Methods/` 和只读的 `_meta/user.md`；跨项目必须显式用 `all`。 |
| `mem_read` | `path`（必填，仓库相对路径）、`section` | 重新校验文件后返回正文、解析出的 frontmatter 和内容哈希。拒绝 `_meta/.history/` 这类内部目录。 |
| `mem_write` | `type`、`title`、`body`（必填）；`tags`、`status`、`confidence`、`assertion`、`supersedes`、`id`、`idempotencyKey` | 写项目文档和记忆的权威途径。不带 `id` 时**创建**一条带新 id 的笔记；带已存在的 `id` 时更新。取代会校验旧 id，并把链接的两端都写上。 |
| `mem_log` | `text`（必填）；`session`、`section`、`idempotencyKey` | 往今天的日志追加一条幂等条目；`section: "hot"` 则改为写热记忆文件的进行中区域。 |
| `mem_brief` | — | 返回会话注入过的那份召回简报，方便你重读或审计预算。 |
| `mem_admin` | `action`（必填）：`lint`、`index`、`bind`、`projects`、`promote`、`jobs`、`curation`、`diagnostics`；外加 `report`、`prune`（仅 lint）、`rebuild`（index）、`mode`（bind：`show`\|`local`\|`fork`\|`retain`）、`path`（promote）、`jobId`/`retry`（jobs）、`operation`（curation：`status`\|`scan`） | 低频维护。`lint` 默认只读，除非你传 `report: true`（写一条带日期的报告笔记）和/或 `prune: true`（删除过期快照）——这两者刻意保持独立。`curation` 读取或运行下文那条有界的整理回合；它永远不会应用某条待评审提案。`diagnostics` 是唯一什么都不读的动作：它返回**本进程**自己的决策环——最多 200 条事件，取值来自封闭集合 `capture`、`distill`、`index`、`bind`、`job`、`transaction`、`brief`、`skill`、`recall`、`curation`（十类现在都会写入），每条带一个结局与机器标识，永不包含笔记正文、标题或提示词。因此一个窗口能回答那些否则必须靠复现才能回答的问题：一个已结束的回合为什么没被捕获（`capture` 事件给出原因）、蒸馏是真的没产出还是根本没跑（`distill`、`job`）、索引有没有跟上一次写入（`index`）、一次写入是提交了还是带着错误码被拒绝（`transaction`）。它不需要绑定、不读仓库，所以在其他所有动作都拒绝时它仍能回答；进程退出后它即清空——上文所述的独立本地日志会为用户自行生成的报告保留缩减后的事件。设 `DSH_OBSIDIAN_MEM_DEBUG=1` 可额外把每条事件以 `info` 级写进宿主日志；宿主是否显示这一行由宿主决定，不由本插件决定。 |

`mem_write` 的 type 这样路由：

| `type` | 落在 | 说明 |
|---|---|---|
| `doc` | `Docs/<title>.md` + 更新 MOC | 设计文档、报告、指南。 |
| `decision` | `Decisions/ADR-<n>-<slug>.md` | Context / Decision / Alternatives / Consequences。编号在仓库锁内分配，是给人看的；`id` 才是身份。 |
| `gotcha` | `Pitfalls/<slug>.md` | 症状 / 原因 / 修复 / 证据。 |
| `convention`（别名 `invariant`） | `Conventions/<slug>.md` | 一个文件一件事。 |
| `session-log` | `Daily/YYYY-MM-DD.md` | 只追加，按 session id 幂等。 |
| `hub`、`glossary` | `index.md`、`Docs/glossary.md` | MOC 和术语。 |
| 低置信度 / 未分类 | `Inbox/<slug>.md` | 等人来分类。 |

取代从不覆盖：旧笔记留在原位，标上 `status: superseded` 和 `superseded_by`，新笔
记反向链接它。两条无法排序的结论会变成 `status: contested`——不允许有隐形的赢家。
`assertion` 记录结论*有多强*（`stated`、`inferred`、`observed`），而 `observed`
需要可复查的证据，不是模型说一句“已验证”。

### 自动蒸馏

开启 `autoCapture: true` 时，一个已完成的根回合会：(1) 在提交后被捕获；(2) 过滤
后以 `0600` 权限存成 job，放在 `$DSH_HOME/data/obsidian-mem/pending/` 下；(3) 空
闲窗口之后，由**一次**不带工具的模型调用蒸馏；(4) 用它所引用的证据序号做校验；
(5) 以 `decision` / `gotcha` / `convention` 笔记幂等地落地。被中止和报错的回合只
被记录，永不成为结论；`doc` 和 `glossary` 笔记只能通过 `mem_write` 创建。

原生 DSH 的重复硬失败也进入这条证据链。同一捕获回合内，同一工具失败三次后，
可以生成 `gotcha`：模型遗漏时补低置信度的 `Inbox/` 候选；模型候选只有引用了该工具
后续的已验证成功，以及文字说明，才可进入 Pitfalls。候选仍保持 `inferred`、
`provisional`，不自动取代旧笔记；重试成功不能证明根因。成功结果中的软错误文本
只提示回忆，也不能作为恢复证据。留档遵守 `autoCapture`、`distill.dryRun`、模型路由
和 `distill.maxItems`；模型输出失败仍留在现有重试队列。同名候选等待评审。
Codex 共用库和写作规则，但其 MCP 适配器收不到原生 DSH 工具事件；Codex skill 说明
显式回忆和留档的方法。

语言检查对句长（60 个 CJK 字符或 25 个英文词）、笔记长度（五句）、模糊措辞与悬空
指代给出提示，排除行内代码和 wikilink。只有标题与正文语言不一致才把蒸馏候选转入
Inbox。这些是参考 ASD-STE100 的项目规则，不表示标准认证或召回质量已提高。

一个普通候选——既不取代任何笔记、也不与任何已有笔记同名——会像其他任何一次写入
一样，走同一套事务引擎落地。有两种形态不走，因为它们是插件不该自行做出的判断：

- 标题与已绑定项目中某条笔记相同的候选会被**停放**，而不是跳过，所以新事实绝不会
  被悄悄丢弃。判定用的是与 `mem_search` 相同的项目范围、相同的分词器，并收窄到候选
  自己的类型。批准后的孪生笔记会作为**单独一条**笔记发布在已有笔记旁边。
- 提出要取代某条笔记的候选同样会被**停放**。批准后的取代会写入新笔记、把前身标为
  `status: superseded`，并把两条互相链接——与显式 `mem_write` 取代完全一致。

两者在由你决定之前都只是待评审记录，具体说明与批准方式见下文《自动整理》。

先这样开始：

```yaml
    distill:
      dryRun: true
```

然后观察几个回合。`mem_admin(action="jobs")` 会列出队列；`failed` 的 job 会保留
失败原因，可以用 `mem_admin(action="jobs", jobId="…", retry=true)` 复活。把
`dryRun: false` 设上再重启，就正式启用。

### 自动整理

`autoCurate: true`（默认值）时，插件还会检查仓库里已有的笔记，并维护一份当前项目的
紧凑导航视图。有两点要先说清楚：这项检查只读 Markdown，**不调用模型**；而且
**不会有任何语义动作自己发生**——没有笔记会被合并、归档、取代、提升或删除。一个
finding 要么成为视图条目，要么被停放，等你决定。

#### 日常流程

什么都不做也是正常用法：自动回合会维持视图，被停放的提案就那样等着。想看它发现了
什么时：

1. **先看状态。** `mem_admin(action="curation", operation="status")` 读取已存储的
   游标、已提交的视图和有界的提案队列。它不检查任何笔记，所以它的 `examined`、
   `counts.findings` 和 `counts.unexamined` 按设计就是 `0`——那几个数字描述的是
   "一趟"，不是项目。
2. **想立刻跑检查就扫。**
   `mem_admin(action="curation", operation="scan")` 跑一趟有界整理，并报告这一趟做了
   什么。项目大于一趟是正常情况：重复 `operation="scan"`，直到结果里
   `complete: true`。别指望下一次会话替你跑完——见下文《一趟没跑完的时候》。
3. **挑一条提案来定。** 结果里的 `proposals.items` 最多返回 200 条待评审记录，最新
   在前，每行恰好有 `proposalId`、`kind`、`reason`、`reviewOnly` 四个键。区分两种
   形态要看 `reviewOnly`，不要看 `kind`：`near-duplicate` 两种都可能。如果
   `proposals.truncated` 是 `true`，说明待评审的比返回的多——先把列出的定完，再看一次
   状态。
4. **运行评审命令**，在已绑定项目的目录下，用与宿主相同的 `DSH_HOME`：

   ```sh
   dsh-obsidian-mem-review --vault /绝对路径/vault <提案 id>
   ```

   从本仓库的检出运行时，`node /绝对路径/repo/lib/curation-cli.js --vault … <提案 id>`
   是同一条命令——若已绑定项目是另一个仓库，就用绝对脚本路径。它会打印提案的确切操作
   与来源，并且只接受逐字节输入的 `apply <id>` 或 `reject <id>`，一次一条提案：没有
   `--all`，也没有默认答案。`reject` 不改动任何源笔记。
5. **再看一次。** `status` 里那条已决定的记录不再出现；下一次简报或扫描会反映批准后的
   改动。

**没有任何 `mem_admin` 动作、参数或枚举值能应用、批准或拒绝提案**，所以批准永远不是
模型能代你做的事。评审命令是唯一途径，而且它要求 stdin **和** stdout 都是终端。

#### 哪些能批准，哪些只能自己修

只有带操作的提案才提供 `apply`——也就是列表里 `reviewOnly: false` 的那些。它们有两
种，都是上文《自动蒸馏》里被停放的候选：

| 被停放的候选 | `apply` 做什么 |
|---|---|
| 与已有笔记孪生的候选 | 作为**单独一条**笔记发布在已有笔记旁边。 |
| 提出取代某条笔记的候选 | 写入新笔记，把前身标为 `status: superseded`，并把两条互相链接。 |

`reviewOnly: true` 那行是 finding，不是计划：`review_after` 过期、wikilink 指向不存在
的笔记、插件自有笔记缺少来源、或扫描器自己发现的疑似重复。`apply` 修不了它，评审命令
也不会为它提供操作。请按 finding 指出的问题改源笔记——编辑笔记、修正链接、刷新或退场
——然后再跑一次 `operation="scan"`；笔记不再出现该问题时，finding 就会消失。不同意的
finding 直接 reject 即可，它会记录这个决定且不改动任何笔记。

命令宁可拒绝也不猜，每个拒绝都是一个可以据以行动的代码。`source-changed` 表示某处来源
在扫描与批准之间被改动了：提案保持 `pending`，再评审一次即可。**健康**的并发评审——两个人
同时决定同一条提案——得到的是 `proposal-not-current`；`review-lock-unavailable` 是另一
种答案，表示私有的 claim guard 根本没拿到：另一个评审正处在它那段很短的 claim 临界区里，
或者 guard 存储不可用。`review-recovery-required` 表示这条提案已经有一部分或已提交的
应用：某个进程在发布笔记与记录决定之间死掉了。用 `apply` 批准会把这次尝试结清——没提交
就回滚、已提交就向前推进——然后发布这条候选；reject 会被拒绝，因为那会留下一条已发布的
笔记配一条 `rejected` 记录。

#### 一趟没跑完的时候

一趟最多检查 256 条笔记，并在整理工作累计 500 ms 之后停止**开始**新的检查。撞上任一
上限的一趟会如实说明并保住自己的位置：已经检查完的留在记录里，没轮到的等下一趟。有两
个数刻意不作为承诺：一次慢的文件系统调用可能越过 500 ms，而清单遍历本身根本不受它约束。

项目大于一趟时，重复 `operation="scan"`，直到 `complete: true`。自动触发比这更弱：撞上
上限的完整扫描会在扫描过程中写下新的到期标记，所以之后一次提示队列为空的会话开始只会得到
`skipped`，回填就此等待。项目再次到期只有三条路径——一次提交的写入排队了一条**变更路径
提示**（它只看那条队列，不看到期标记）、你主动 `operation="scan"`、或 24 小时到期标记
过期。所以比一趟更大的仓库，其**自动**回填在每个项目上最多每 24 小时前进一批，直到某次
写入为它排入一条提示；而你主动 `operation="scan"` 不受这条约束——这正是上面让你重复扫描
的原因。

#### 自动回合按宿主不同

DSH 侧，一次提交的写入会把笔记入队，会话活动时检查项目是否到期；整理在模型请求之外运行，
失败永远不会让你的回合失败。Codex 侧，整理运行在已安装且**被信任**的 `SessionStart`
钩子里——未受信任的钩子会被 Codex 静默跳过；只装 MCP（没有钩子）的安装方式只有显式的
`mem_admin` 扫描，**完全没有自动回合**。`autoCurate: false` 时
`operation="status"` 与 `operation="scan"` 都仍然可用，停掉的只有自动触发。

#### 视图是缓存，永远不是第二事实来源

游标、逐路径扫描记录、变更路径队列和视图都在
`$DSH_HOME/data/obsidian-mem/curation/` 下。每个视图条目都带着它据以构建的字节的
sha256；简报使用某条之前会重新哈希它代表的**每一个**路径——包括被折叠的完全重复组里的
每一个成员——只要源缺失、被编辑、不可读或过大，简报就回退到视图出现之前那套按源导航的
路径。完全重复组只会显示成一条列出所有路径的条目；**没有任何笔记被删除或合并**。只有被
标为 `complete` 的视图才会被注入：撞上任一上限的完整扫描发布 `complete: false`，而变更
路径的扫描只允许合并进一个已经完整的视图（否则就是 `backfill-incomplete`），所以不完整
的回填永远不会被当作项目的导航发布出去。

删掉那四份可重建的文档——游标、逐路径扫描记录、变更路径队列和视图——代价只是一次扫描，
别无其他。同一目录里有两样**不可弃置**：`proposals/` 保存着每一条被停放的候选及其决定
记录，扫描无法再造，删掉就丢掉了评审工作（源笔记不受影响）；正在跑的评审还会在记录旁边
保留一个私有的 claim 文件，让两个评审不可能同时决定一条提案——评审在跑时，两者都不要删。

在一台机器上、一个 600 条笔记的临时仓库里实测（探针与原始输出见 `CHANGELOG.md`）：
一趟完整整理检查 256 条笔记，15 轮的中位数 136 ms、最差 171 ms；一次真实的
`SessionStart` 钩子运行比同一进程跳过整理的那次多付中位数 172 ms、最差 179 ms。
在这个规模上 500 ms 截止时间从未被触及——先撞上的是笔记数上限——所以这些数字说明
上限在这里不是约束，而**不**说明 256/500 就是最优；大到让截止时间真正生效的项目，
本仓库没有跑过。未验证清单在 `CHANGELOG.md`，这里不重复。

### 插件自己的数据放在哪里

仓库之外的一切都在 data root 下，而 data root 只在一个地方从 `DSH_HOME` 推导出来
（`$DSH_HOME`，未设置时是 `~/.dsh`）：

```
$DSH_HOME/data/obsidian-mem/
├── index/          rebuildable SQLite search index (never authoritative)
├── locks/          whole-vault write lock
├── transactions/   journal for crash recovery
├── receipts/       per-write and per-job receipts
├── pending/        queued distillation jobs (0700/0600)
├── curation/       可重建的整理状态：游标、逐路径扫描记录、
│                   变更路径队列与紧凑视图 (0700/0600)
│   └── proposals/  持久保存、不可重建：每一个停放中的候选及其决策记录 (0700/0600)
├── diagnostics/    不含正文的限量决策日志 (0700/0600)
└── processed/      per-session processed floor (0700/0600)
```

把 `DSH_HOME` 指向一个隔离目录，插件就永远写不进你真正的 `~/.dsh`——测试套件就是
这么跑的，你试任何新东西时也该这么做。

---

<a id="diagnostic-report-for-an-issue"></a>
## 用于 Issue 的诊断报告

如果安装方式把本包的 npm 命令加入了可执行路径，可自行生成报告：

```sh
dsh-obsidian-mem-diagnose --output ./obsidian-mem-diagnostics.json
```

在源码目录下，`node lib/diagnose-cli.js --output ./obsidian-mem-diagnostics.json`
运行的是同一命令。即使宿主插件加载失败，命令仍可执行基础检查。它不会上传文件、修改
DSH 配置或读取真实 vault；必须明确指定输出路径，且拒绝覆盖已有文件。生成的 JSON 权
限为 `0600`，大小不超过 256 KiB。请先用文本编辑器打开检查，再自行附到 Issue。
**[公开 GitHub 仓库的附件](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/attaching-files)任何人都能查看**，包括未登录 GitHub 的人；事件时间可能透露
你使用插件的时段。

报告包含插件和 Node 版本、操作系统类型与架构、有日志时可取得的非身份性配置开关、
固定格式的自检状态，以及近期决策事件。事件只保留时间、类别、获准的结果或粗粒度错
误码、计数，以及 `p1`、`j1` 这样的每次运行内别名。命令只数 pending 目录中的 job
文件项，不打开文件；它检查 Node、内存 FTS5、随包文件、诊断日志状态，并在一次性
home 和 vault 中检查 `mem_admin` 的诊断结果结构。它**无法**证明真实 vault、模型路
由、宿主会话钩子或队列任务内容正常。证据缺失、不完整或损坏时标为 `unavailable` 或
`partial`；没有日志不代表先前的调用成功。
如果没有安装可选的 DSH 宿主包，隔离插件自检可能标为 `unavailable`，基础报告仍能生成。

启用的 DSH 插件和 Codex 适配器默认把缩减后的事件流写到本机
`$DSH_HOME/data/obsidian-mem/diagnostics/`，目录和文件权限分别为 `0700`、
`0600`。每个进程最多保留 200 条事件、128 KiB。下次插件启动时清除最后写入已超过
七天的运行文件；导出会忽略过期文件，插件停止期间没有后台清理。进程内的
`mem_admin(action="diagnostics")` 决策环仍独立存在。日志写入失败不改变原调用的结果。

日志和报告**不会包含对话文本、提示词、模型输出、笔记正文或标题、工具参数、宿主原
始日志、pending job 正文、配置文件、凭据、环境变量值、路径、原始项目/job/事务
ID、主机名或仓库 remote**。命令不会发起网络请求。这些边界约束的是新增的诊断通
路；自动蒸馏的模型调用边界见下文。

---

## 隐私边界

自动蒸馏会把文本发给模型。下面写清楚到底有什么越过了这条线。

**本地暂存了什么。** 已完成的回合会在任何模型调用*之前*以 `0700`/`0600` 权限写入
`$DSH_HOME/data/obsidian-mem/pending/`，这样重启后可以继续而不必再次调用模型。原
始会话记录从不写入仓库。

**发送了什么。** 一句已提交回合的白名单投影：真实的用户消息、最终的助手文本、带
成功/失败标记的工具名，以及带上限的文件路径与行号。插件注入、推理块、原始工具输
出、工具参数、子代理会话记录、凭据存储、凭据文件和环境变量从不被读入其中。

**清洗掉了什么。** 一次确定性扫描会跳过任何匹配常见凭据形态的消息（常见 API key
前缀、PEM 块之类）。一旦命中就跳过**整条消息**，回执里会记下这次跳过。

**什么没有保证。** 那个扫描不是穷尽的密钥扫描器。如果你用无法识别的格式把密钥粘
进会话，这条消息的文本就是回合的正常组成部分，可能到达模型路由。请像对待任何与模
型供应商的对话一样对待这个会话。

**发到哪里。** 只发给你配置的 LLM 路由；当 `distill.provider`/`model` 为空时，发
给会话最近记录的路由。解析不到路由是一种 `deferred` 状态，而不是用默认设置发起调
用。没有遥测，也没有别的网络出口。

**磁盘上有什么。** 仓库和 pending 队列都是普通本地文件，所以任何备份或同步它们的
东西——Git、Time Machine、Obsidian Sync、云盘目录——都会看到它们。如果某条用户消息
对此敏感，就别让它被捕获。

---

## 备份与迁移

**仓库才是事实来源。** SQLite 索引只是一个*可重建的缓存*：删掉
`$DSH_HOME/data/obsidian-mem/index/`，它会被扫描重建；或者调用
`mem_admin(action="index", rebuild=true)`。任何时候都不会*从*索引里恢复任何东
西。

**Git 初始化不是备份。** `initGitOnCreate` 只是让新建的仓库具备做版本管理的前
提。插件从不 commit、从不配置 remote，也从不把 Git 当回滚机制。想要 commit 和
remote 就自己配。

**快照也不是备份。** 在修改自己拥有的文件之前，插件会把先前的字节复制到
`_meta/.history/<txId>/`。这些副本是失败事务的恢复材料，它们不被索引，
`mem_admin(action="lint", prune=true)` 会在仓库锁内删除过期的那些。仓库之外的索
引、或者同一块磁盘上的 history 目录，都不算备份。

**把代码库搬到另一台机器。** 正常 clone 即可。`.obsidian-mem` 里没有任何绝对路径
——只有 `projectId`、`slug`、`displayName` 和 `schema`——所以把 `vaultPath` 设成
*那台*机器的仓库，项目身份就保持不变。如果仓库也一起搬过去，项目目录原样复用。

**改名。** 改代码库名或显示名不会移动项目目录；目录名在第一次绑定时就固定了。
`mem_admin(action="bind", mode="show")` 报告绑定情况而不做改动。

**同一个代码库有多份副本。** 同一代码库的多个 worktree 共享一个 `projectId`，因
此也共享一个仓库目录。真正的另一个代码库（`fork`）通过
`mem_admin(action="bind", mode="fork")` 拿到新 id，而 `mode="retain"` 用于确认换
了 remote 的仍是同一个项目。两者都不是自动的：remote URL 不匹配会暂停自动写入并
来问你。

**保留策略。** `mem_admin(action="lint")` 会检查孤儿行、死链、重名文件、
frontmatter 缺失、过期笔记、文件↔索引不一致和队列积压。`prune` 只在没有任何清单
或失败记录仍引用它们时删除过期的 `.history/` 快照目录，并且在仓库锁内执行。

---

## 外部 Markdown 只被审计，不被管控

`mem_write(type="doc")` 是项目文档的权威途径，也是插件唯一能保证的途径。*你*用编
辑器、一行 `sed`、代码生成器或别的工具创建的 Markdown 对它来说是不可见的——没有插
件能拦截一次 shell 写入。

`mem_admin(action="lint")` 会报告没有被任何仓库笔记引用的代码库 Markdown，于是这
个缺口是*可见的*。它只报告，从不移动、改写或收编你的文件。把这份报告当作待办清
单，而不是强制手段。

`README.md`、许可证和构建配置属于代码库，就留在那里；仓库收的是给人读的长文档。

---

<a id="honest-limits"></a>
## 诚实边界

这里每一条都是本版本真实的边界，大多数是刻意做出的拒绝。它是写下来的部分，不声称穷
尽：`CHANGELOG.md` 里持续记录着哪些被验证过、哪些还没有。

### 索引只是缓存，从不是事实来源

搜索结果、简报和 `mem_admin(action="index")` 全都从仓库里的 Markdown 推导而来。
索引损坏或过期是可以恢复的，插件宁可重新扫描，也不把已删除的内容端给你。仓库和索
引一旦不一致，以仓库为准。

<a id="the-vault-must-be-local"></a>
### 仓库必须在本地磁盘

自动写入要求仓库在**本地磁盘**上。三个原因，按咬人的频率排序：

- **按需文件。** iCloud Drive 和 `~/Library/CloudStorage/` 挂载（Dropbox、
  OneDrive、Google Drive）能把文件内容换成占位符，之后再下载。在后台进程里读这种
  文件可能阻塞，或以 `EDEADLK` 失败。因此位于 `~/Library/Mobile Documents/` 或
  `~/Library/CloudStorage/` 下的仓库会被拒绝，**读和写都拒绝**
  （`vault-cloud-managed`），因为没有数据的读和没有数据的写一样不安全。
- **同步客户端可能误读占位符。** Obsidian Sync——以及一般的同步客户端——可能把被卸
  载的占位符当成一次删除。在同一个目录里同时用 Obsidian Sync 和按需下载，是最容
  易丢工作的组合。二选一，或者让仓库保持纯本地、用带版本的副本做备份。
- **未知的供应商无法靠路径识别。** 只认这两个有文档的 macOS 根目录。对别的供应
  商，插件的防线是在文件级读取失败时暂停并报告，而不是从目录名去猜。
  `~/Documents` 被刻意*不*假定为受供应商托管。

被卸载或暂时读不了的文件会让它自己的更新暂停并被报告。它绝不会被当成空文件覆盖
掉。

<a id="the-property-registry-is-not-readable-offline"></a>
### 属性注册表无法离线读取

Obsidian 把某个属性的*类型*登记在仓库级的 `.obsidian/types.json` 里，那个文件是
GUI 侧的产物，本插件离线时无法信任它（也不写它）。因此属性预检只能看到
**在它读到的笔记字节里可见**的值类型：如果某个属性的类型已在 Obsidian UI 里确
定，而当前没有任何笔记携带它的值，那就检测不到。对这类属性的第一次写入仍可能在
Obsidian 里冲突。要补上这个缺口，要么在仓库侧读 `types.json`，要么做实时 DOM 探
测；两者都不在这个版本里。

预检最多读取一条笔记的前 64 KiB 来找 frontmatter 的结尾（这样满是大型附件的仓库
不会触发大规模下载），并且在文件数达到上限后停止，并报告这个上限。

### 文件时间戳从不是日期来源

`created`、`updated` 和 `review_after` 是日期，日期来自日历和会话——绝不来自
`mtime`、`ctime` 或 `birthtime`。被复制、恢复或 checkout 出来的文件，其时间戳与
事实成立的时间毫无关系。索引*确实*会用 `mtime`/大小作为廉价的新旧提示，但那是另
一回事：它决定要不要对一个文件做哈希，而不是决定笔记写了什么。

### 硬链接与 bind mount 不可见

路径 jail 会解析符号链接并在每一层拒绝它，也会拒绝 `..`、绝对路径和设备路径。它
看不出普通文件与指向别处的**硬链接**或 **bind mount** 之间的区别。一个与插件同用
户、且能写仓库内部的进程，可以用其中之一让写入落到别的地方。

相关的、且无法避免的一点：在校验路径的 `lstat` 和使用它的 `open` 之间存在一个
**TOCTOU 窗口**。事务引擎会缩小危害（独占创建、每次替换前校验哈希、改动前先快
照、拒绝覆盖并发编辑的回滚），但文件系统没有提供原子操作的地方，它无法把这个窗口
关上。

威胁模型是单用户的本地仓库。这不是多租户沙箱。

### 其他值得知道的边界

- **写锁只约束本插件。** 它是以 `realpath(vaultPath)` 为键的整仓锁，所以两个项目
  无法交错写注册表或回执。Obsidian 和任何别的编辑器都无视它，这也是每次替换前都
  要先重新校验文件哈希的原因。
- **`withVaultLock` 不可重入。** 同一进程里嵌套获取会死锁，所以任何代码路径都不
  得嵌套获取。
- **既没有绑定也没有路由的 job 会无限重新排队。** 它永远不会被标记为终态失败；它
  在每个空闲窗口重试（每个窗口至少写一次队列文件），直到出现绑定或路由。有上限，
  但不是零成本。
- **拒绝审计有上限。** 一个 job 的拒绝审计最多保留 32 条，所以当被丢弃的候选更多
  时，回执上可能只写 32。
- **人工编辑会中止写入。** 生成块携带它声明的正文哈希。如果哈希不再匹配，说明有
  人编辑过那个块，插件会报告冲突而不是重写它。这是设计使然，也意味着手工改过的
  MOC 或注册表需要人来调停。
- **`dsh.plugin.json` 是惰性的。** DSH 核心里没有任何东西读它。它是一个注册表约
  定，正因如此，当它与 `package.json` 不一致时 `prepack` 会失败。
- **会话日志属于 DSH，不属于本插件。** DSH 自己写
  `$DSH_HOME/sessions/…/session.v3.jsonl.zstd`（0.1.7 线及以后是
  `session.v4.jsonl.zstd`）。本插件从不编辑它们。

---

## 故障恢复

| 症状 | 意味着什么 | 怎么做 |
|---|---|---|
| `vault-cloud-managed` | 仓库根目录位于已知的 macOS 云根目录下，或项目是从那里解析出来的。读和写都会被拒绝。 | 把仓库移到本地磁盘，并更新 `vaultPath`。 |
| 笔记停止更新；回执指出一次读取错误 | 文件被卸载或暂时不可读。插件暂停这次更新，而不是覆盖它。 | 下载该文件（打开它），或把仓库移出同步根目录。 |
| bootstrap 时 `property-type-conflict` | 一条已有笔记用了插件的某个属性名，但值类型不兼容（`tags: foo` 而不是列表、被加了引号的日期等）。 | 改掉那条笔记，或用一个空仓库。插件不会重写你的 frontmatter。 |
| 一个生成块报告冲突 | 有人编辑过那个块，所以它声明的哈希不再匹配。 | 手工调停：恢复生成的内容，或者认定人工版本是权威并保留它——在声明的哈希重新与正文匹配之前，插件会一直报告同一个冲突。 |
| 搜索没有结果，或提示 not-ready | 索引缺失、不可读，或者仍在扫描。 | `mem_admin(action="index")` 查看状态，`mem_admin(action="index", rebuild=true)` 重建。仓库不受影响。 |
| 一个蒸馏 job 是 `failed` | 模型调用或校验失败达到 `maxRetries` 次。job 会保留原因。 | `mem_admin(action="jobs")` 查看，然后 `mem_admin(action="jobs", jobId="…", retry=true)`。 |
| 一个 job 停在 `deferred` | 没有可用的模型路由、代码库未绑定，或者模型输出被校验拒绝（`truncated`、`too-many-items`）而 job 正在退避。它在每个空闲窗口重试。 | 设置 `distill.provider` + `distill.model`、绑定项目，或者针对这两个拒绝码调大 `distill.maxOutputTokens` / `distill.maxItems`。 |
| 一个 job 因 `too-many-items` 进入终态 `failed` | 模型返回的条数超过上限，整批被拒（不是裁剪）。原始输出仍在（`outputState: raw-durable`），所以把 `distill.maxItems` 抬到高于 `lastError` 里报的条数后，**不需要重新调用模型**：重试会重新校验那份已存的文本。 | 先调大 `distill.maxItems`，再 `mem_admin(action="jobs", jobId="…", retry=true)`。不调大就重试，等于用同一份字节对同一个上限再校验一次，必然再失败。 |
| DSH 在写入中途崩溃 | 未完成的事务被记在 `$DSH_HOME/data/obsidian-mem/transactions/` 下。 | 重启会话：恢复会在新的写入之前运行。如果崩溃期间文件被外部编辑过，两个版本都会被保留并报告——没有任何内容被覆盖。 |
| `lock-corrupt` | 仓库的写锁文件（`$DSH_HOME/data/obsidian-mem/locks/vault-<hash>.lock`）存在但不可读——通常是零长度或被截断，因为进程在创建它和写入记录之间被杀掉。插件从不把不可读的锁当作“没人持有”，也从不抢占它，所以每次写入都会等完超时，然后以这个错误码拒绝。 | 读出错误里给出的路径，手工（`rm`）删掉**那一个文件**，然后重试。不需要清理别的：锁会在下一次写入时重建，仓库内容也不依赖它。 |
| `lock-timeout` | 另一个活着的进程持有仓库的写锁，或者某个进程死了但它持有的锁记录仍可读、其 pid 尚未被观察到消失。 | 等其他会话结束再重试。如果你确定持有者已死，一旦记录的 pid 消失，锁会被自动打破——在可能还有 `dsh` 进程在跑时，不要手工删除一个可读的锁。 |
| 一个代码库拒绝写入 | remote URL 不匹配、同一个目录对应了不同的 `projectId`、同级 worktree 元数据冲突，或者同级不可读。拒绝信息会说明原因，并让指针文件保持原样——它从不修复或替换指针文件。 | `mem_admin(action="bind", mode="show")` 报告现状；`mode="retain"` 或 `mode="fork"` 是显式的修正手段。过期的 worktree 需要 `git worktree prune`。 |
| 一个普通目录保持只读 | 它不在 Git 仓库里，所以插件不会自行把它纳入长期记忆——隐式的第一次写入只绑定 Git 仓库。 | 用 `mem_admin(action="bind", mode="local")` 显式绑定它；绑定在同一会话里立即生效。 |
| 某个会话的记忆悄悄缺席 | 任何非 `bound` 的解析结果都意味着“这个会话没有记忆”——这是设计使然，它从不抛错，也从不猜。读取永不绑定代码库；没有指针文件的 Git 仓库由它的第一次写入完成绑定；指针文件或注册表不被插件信任的代码库会保持未绑定，直到问题解决。 | 检查 `mem_admin(action="projects")` 和指针文件，然后写一次（Git 仓库）或跑 `mem_admin(action="bind", mode="local")`（任何目录）——两者都在同一会话内生效。 |
| 有一条整理提案停在 `pending`，但没有笔记被改动 | 这就是设计：疑似近似重复、或模型提出的取代，会被停放等待评审，绝不自动应用。 | 用 `mem_admin(action="curation", operation="status")` 查看队列（每行带一个 id）；用 `dsh-obsidian-mem-review --vault <绝对路径> <提案 id>` 批准或拒绝其中一条。拒绝不改动任何源笔记。 |
| 评审报 `review-recovery-required` | 这条提案已经有一部分或已提交的应用：某个进程在发布笔记与记录决定之间死掉了，此时拒绝会留下一条已发布的笔记配一条 `rejected` 记录。 | 再跑一次评审并用 `apply <id>` 批准：它会把这次尝试结清（没提交就回滚、已提交就向前推进）并发布这条候选。在这份证据被解决之前，拒绝会一直被拒。 |
| 评审报 `review-lock-unavailable` | 私有的 claim guard 根本没拿到：另一个评审正处在它那段很短的 claim 临界区里，或者 guard 文件不可读、所在存储不支持。健康的并发评审得到的是 `proposal-not-current`。 | 稍等片刻后重试；若确认没有评审在跑却仍然如此，再去检查数据根。在可能有评审存活时不要删除 guard。 |
| 在没有 `O_NOFOLLOW` 的平台上，任何提案的评审都报 `review-lock-unavailable` | claim guard 拒绝打开一个它无法证明是普通单链接文件的路径，而部分平台（Windows 上的 Node）不提供 `O_NOFOLLOW`。这个拒绝是有意的：guard 保护的正是唯一的批准途径。 | 在更安全的回退方案落地之前，请在 macOS 或 Linux 上评审整理提案。读取、写入与扫描不受影响。 |
| 评审报 `source-changed` | 某处来源笔记在扫描与批准之间被编辑了。提案保持 `pending`，不会自行 rebase 到没人评审过的字节上。 | 看清新状态后重新决定。 |
| 简报不再显示紧凑导航，或某个声称的重复组消失了 | 已存视图只是缓存：它的某个源被改动、消失或变得不可读，于是简报回退到按源导航的路径，而不是注入一条过时的行。 | 无需修复。下一次完整整理会重建它；`mem_admin(action="curation", operation="scan")` 可以立刻跑一趟，并报告 `complete` 与任何截断原因。 |

如果症状不在上表，或者按上表的做法仍未解决，请生成诊断报告并把 JSON 附到 Issue
上——见[用于 Issue 的诊断报告](#diagnostic-report-for-an-issue)。命令不会自动上传：
文件由你自己检查、自行附上。

---

## 开发

```sh
npm ci                                   # exact lockfile
npm test                                 # whole suite
npm run prepack                          # npm test + scripts/verify-pack.mjs
npm pack --dry-run --ignore-scripts      # manifest only
```

`npm test` 就是 `node scripts/run-tests.mjs`：它创建一个一次性目录，把
`DSH_HOME` 指向它，运行 `node --test test/*.test.js`，结束后删掉这个目录。这就是
测试套件写不进你真正的 `~/.dsh` 的原因。

`npm run prepack` 是发布闸门，它**只做校验**：先跑测试套件，然后静态检查
`package.json` 和 `dsh.plugin.json` 在版本、插件身份和入口上是否一致，`files` 白
名单是否覆盖 tarball 必须携带的资产（包括 `skills/obsidian-mem/SKILL.md`），白名
单里有没有任何东西会打包进 `scratch/`、`research/`、`docs/`、`test/`、
`node_modules/`、探针记录或 pending 队列数据，`lib/tool-registry.js` 是否仍为六
个工具各自保留一处 `name: 'mem_x'` 注册点——而且没有第七个，因为这个面是刻意封顶
的——以及 `lib/tools.js` 是否仍转出两个入口都要的四个名字（`TOOL_NAMES`、
`TOOL_PARAMETERS`、`registerTools`、`createMemoryServices`）。两项检查分开是
因为它们会分别失败：六个工具可以注册得完全正确，却因为门面不再转出而全部不可见。
它从不编辑配置文件，也从不启动 Obsidian。

`npm pack` 自身会跑 `prepack`，所以一条简单的 `npm pack --dry-run` 会先跑完整套
测试再打印清单——只想要文件列表就加 `--ignore-scripts`，想要那道闸门就显式跑
`npm run prepack`。

改 `README.md` 就要在同一次改动里改 `README.zh.md`：两侧权威对等，
`README.i18n.yaml` 记录两侧在上一次确认一致时的 git blob 哈希。用
`git hash-object README.md README.zh.md` 重新记录，并在提交前把每个值和你手上的文件
对一遍。这个约定的官方校验器（`verify-translation-pairing`）随 harness 的
monorepo 发布、不随本插件发布，所以在这里那一条命令*就是*校验。

### 发布

本仓库不发布 npm 包。一次发布 = **一个 git tag 加一个 GitHub Release**，
`.github/workflows/release.yml` 负责把两者都造出来。

| 递增 | 时机 | 由谁 |
|---|---|---|
| `0.0.1` | 每次 push 进 `main` | workflow 自动 |
| `0.1` | 一次值得标注的功能 | 人，在 push 之前 |
| `1` | 破坏性变更 | 人，在 push 之前 |

只有补丁号是自动的：没有任何东西能从 diff 里推断出「值得标注的功能」或「破坏性变更」，
所以次版本号和主版本号是手工编辑 `package.json`，并为它写好 changelog 段落。

每个 Release 还会带上打包好的 `dsh-obsidian-mem-<version>.tgz`，于是安装可以跳过源码
构建那条路——那条路需要在 pnpm 的 `allowBuilds` 里批准 `prepare` 脚本——直接取预构建
归档。本插件的商城条目按 tag 钉住这个资产：`releases/latest/download/<file>` 这种写法
只在请求时解析 `latest`，文件名却是照字面取的，所以资产名里带版本号会在下一次发版时
把这个链接变成死链。

workflow 依次做这些事：

1. `npm run check`——在即将发布的那个提交上跑完整闸门。
2. 向远端询问 `package.json` 里的版本是否已经有 tag，据此给这次 push 分类。
   `actions/checkout` 不抓取 tag，所以这个问题在本地无法回答。
3. 若没有：给该版本打 tag、原样发布、结束。这是引导分支，手工准备好的 `0.1` 或 `1`
   就是靠它发布的，而不会被反手降成下一个补丁号。
4. 若有：跳过 `chore(release):` 提交；当 `lib/` 有改动而 `## Unreleased` 里没有真实
   条目时拒绝这次 push；然后把 `## Unreleased` 的内容移到
   `## <version> — <date>` 下，递增补丁号，同步 `dsh.plugin.json` 与 Codex server 的
   身份串，以 `chore(release): <version>` 提交、打 tag，并用那段 changelog 发布 Release。

发布之后 `## Unreleased` 是空的，这是有意的；随手把条目写上，否则下一次 push 会被拒绝。

这个 workflow 已经在真实的 GitHub runner 上跑过：它发布了 `v0.1.2`；而 `v0.1.1`
是人工在声明它的那个提交上发布的，所以引导分支本身仍未被执行过。跑起来之后发现了两个
缺陷，都记在 `CHANGELOG.md` 的 Unreleased 里：`actions/checkout` 不会抓取 tag，所以
判定必须去问远端；而「给未发布的版本打 tag」那条分支，不能同时成为已发布版本唯一能走的
分支，否则补丁号再也不会递增。

贡献规则、代码风格和不可谈判的约束在本机的 `AGENTS.md`，实测的宿主事实在本机的
`docs/p0-compatibility.md`。两者都放在检出目录旁边而不是版本库里——本仓库忽略它们
（见 `.gitignore`，理由记在 `CHANGELOG.md`）——所以 `lib/` 注释里引用的是本机文件，
不是仓库文件。随包发布的、以及启用写入前需要知道的内容，就是这份 README 与变更记录。

---

## 许可证

MIT——见 [`LICENSE`](./LICENSE)。
