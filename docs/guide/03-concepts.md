# 03 核心概念

这页解释七个概念。每个概念只在下表中定义一次。
后面的页面直接使用这些词。

| 概念 | 一句话 | 存在哪里 |
|---|---|---|
| 仓库与 vault | 代码在仓库，记忆在 vault | 两个独立目录 |
| 指针 | 仓库的身份证明 | `<repo>/.obsidian-mem` |
| 项目目录 | 一个项目在 vault 中的家 | `Projects/<slug>--<id8>/` |
| 笔记 | 一条可独立阅读的事实 | `Docs/`、`Decisions/` 等 |
| 简报与检索 | 自动带回上下文，按需取全文 | 会话消息 |
| 三层记忆 | 热、温、冷 | `_meta/hot.md`、vault、`Daily/` |
| 证据与生命周期 | 结论可追溯，旧结论不删除 | 笔记 frontmatter |

## 1. 仓库与 vault

**仓库**保存代码、构建配置、README 和许可证。
**vault**保存项目文档和长期记忆，全部是 Markdown。

两个目录不自动镜像。

- 仓库里的长文档可以留在仓库。
- 需要长期检索的设计、决策、踩坑写进 vault。
- 同一主题不需要两边各写一份。

判断方法：文件让代码跑起来，留在仓库。文件让人以后想起来，写进 vault。

## 2. 指针 `.obsidian-mem`

指针是一个 JSON（键值对文本）文件，位于 Git 仓库根。
它只有四个字段：

```json
{
  "projectId": "05025725-00be-4852-aba6-4854f961cd01",
  "slug": "dsh-obsidian-mem",
  "displayName": "dsh-obsidian-mem",
  "schema": 1
}
```

| 字段 | 含义 | 会变吗 |
|---|---|---|
| `projectId` | UUIDv4（全局唯一标识），项目身份 | 不变 |
| `slug` | 第一次绑定时用于建目录 | 标签，可变但不迁移 |
| `displayName` | 给人看的名字 | 可变 |
| `schema` | 协议版本 | 不认识就停止写入 |

规则：

- 指针只在仓库根生效。子目录中的同名文件不是绑定。
- 同一个仓库的多个 worktree（另一份检出）共享 `projectId`，也共享一个 vault 目录。
- 不要手工改 `projectId`。换身份用 `mem_admin(action="bind", mode="fork")`。

## 3. 项目目录

vault 中的项目目录名是：

```text
Projects/<slug>--<projectId 前 8 位>/
```

例如：`Projects/dsh-obsidian-mem--05025725/`。

目录在第一次绑定时固定。改仓库名或显示名不会移动它。
手工改过的目录会被报告，不会被自动修复。

固定文件名使用 ASCII，例如 `index.md`、`glossary.md`、`hot.md`。
笔记自身的文件名来自标题，可以使用中文。

## 4. 笔记与路由

一条笔记是一个 Markdown 文件，开头有 YAML frontmatter（文件元数据）。
`type` 决定笔记放在哪个目录。

| type | 目录 | 用途 |
|---|---|---|
| `doc` | `Docs/` | 设计、报告、指南 |
| `decision` | `Decisions/` | 决策记录（ADR），含背景与后果 |
| `gotcha` | `Pitfalls/` | 症状、原因、修复、证据 |
| `convention` | `Conventions/` | 一条约定一个文件 |
| `session-log` | `Daily/` | 追加式会话日志 |
| `hub` / `glossary` | `index.md` / `Docs/glossary.md` | 导航与术语 |

蒸馏候选低于 `minConfidence` 时进入 `Inbox/`。

三条写作规则：

- **一个文件一条事实。** 正文超过五句，就拆成多条笔记。
- **正文语言跟随标题。** 标题是中文，正文也用中文。
- **`id` 才是身份。** 标题和路径只是导航，改名不产生新事实。

完整字段表见 [07 工具手册](07-tools.md#mem_write)。那里也列出 `status`、`trust`、`assertion`。

## 5. 简报与逐轮检索

插件有两种注入，作用不同。

| | 会话简报 | 逐轮检索 |
|---|---|---|
| 何时 | 会话开始时一次 | 每个新用户提问 |
| 内容 | 热记忆、hub 大纲、约定、用户习惯、最近决策 | 最多 3 条匹配笔记的标题和摘录 |
| 上限 | `briefBudgetChars`，默认 6000 码点 | `recallBudgetChars`，默认 900 码点 |
| 目的 | 建立全局上下文 | 提示当前问题相关的笔记 |

简报只注入一次。检索失败不会中断会话。
两者注入的 vault 内容都标记为“引用数据”，不是指令。

`injectBrief: false` 同时关闭两种注入。

## 6. 三层记忆

| 层 | 位置 | 是否自动注入 | 适合放什么 |
|---|---|---|---|
| 热 | `_meta/hot.md` | 是，每次会话 | 强约束、进行中的工作 |
| 温 | vault 其余笔记 | 否，按需检索 | 决策、约定、踩坑、文档 |
| 冷 | `Daily/YYYY-MM-DD.md` | 否，只搜索 | 会话流水、历史细节 |

热层有硬上限，默认 9000 字符。
它有三个受控区：`强约束`、`进行中`、`已完成`。
超过容量时，插件先归档`已完成`条目，再写入新内容。

热层只放每次会话都需要的内容。长约定应放进 `Conventions/`。

## 7. 证据与生命周期

每条结论都应能回答“从哪里来”。

| 字段 | 取值 | 含义 |
|---|---|---|
| `source` | `human` / `chat` / `git` / `agent` | 证据渠道 |
| `session` | 会话 id | 来自哪次会话 |
| `assertion` | `stated` / `inferred` / `observed` | 用户说的、模型推断的、可复查的 |
| `confidence` | 0 到 1 | 置信度 |

结论变化时，不覆盖旧笔记。

1. 写一条新笔记，填写 `supersedes: <旧 id>`。
2. 把旧笔记标为 `status: superseded`，填写 `superseded_by`。
3. 两条笔记互相链接。

两条结论冲突且无法判断时，两条都标为 `contested`。
插件不选赢家，等人决定。

任何情况下都不删除笔记。可用的退场状态是 `superseded`、`archived`、`contested`。

## 下一步

你已知道七个概念。
下一页看代码如何分层，以及为什么这样分。

下一页：[04 架构](04-architecture.md)
