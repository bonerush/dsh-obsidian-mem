# 07 工具手册

插件向模型提供六个工具。
这页是参数与返回值的参考。概念解释在 [03 核心概念](03-concepts.md)。

## 先选工具

| 你想做的事 | 用哪个工具 |
|---|---|
| 找以前写过的内容 | `mem_search`，再 `mem_read` |
| 保存一条决策或踩坑 | `mem_write` |
| 记录今天发生的事 | `mem_log` |
| 查看会话注入的简报 | `mem_brief` |
| 修索引、热层、队列 | `mem_admin` |
| 把方法提升为跨项目 | `mem_admin(action="promote")` |

## mem_search

搜索标题、正文和 frontmatter。

| 参数 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `query` | 是 | 无 | 搜索词。中文两字词也可用 |
| `scope` | 否 | `project` | `project`、`global`、`all` |
| `type` | 否 | 无 | 只搜某一类笔记 |
| `projectId` | 否 | 当前项目 | 仅 `scope=all` 时可用 |
| `includeHistory` | 否 | `false` | 是否包含已取代或归档的笔记 |
| `limit` | 否 | `8` | 最多返回条数 |

`scope` 的含义：

- `project`：只搜当前绑定项目。传入其他 `projectId` 会被拒绝。
- `global`：搜 `Methods/` 与 `_meta/user.md`。
- `all`：跨项目搜索。

返回结果包含路径、标题、摘录和类型。
摘录用于判断相关性，不替代全文。

## mem_read

读取一条笔记的全文。

| 参数 | 必填 | 说明 |
|---|---|---|
| `path` | 是 | vault 相对路径 |
| `section` | 否 | 只取某个 ATX 标题下的正文 |

返回正文、解析后的 frontmatter 和内容哈希。

拒绝的情况：

- 绝对路径
- 包含 `..` 的路径
- 符号链接
- `_meta/.history/` 等内部路径

写入后立刻读取，可以校验内容哈希。

## mem_write

写入一条项目笔记。

| 参数 | 必填 | 说明 |
|---|---|---|
| `type` | 是 | 决定目录，见下表 |
| `title` | 是 | 标题，也是文件名来源 |
| `body` | 是 | 正文，不含 frontmatter |
| `tags` | 否 | 标签数组 |
| `status` | 否 | 生命周期状态 |
| `confidence` | 否 | 0 到 1 |
| `assertion` | 否 | `stated`、`inferred`、`observed` |
| `supersedes` | 否 | 被取代笔记的 `id` |
| `id` | 否 | 已存在笔记的 `id`，用于更新 |
| `idempotencyKey` | 否 | 重试时返回原结果 |

两条最重要的行为：

- **不带 `id` 一定创建新笔记。** 更新必须传已有 `id`。
- **`supersedes` 会校验旧 id。** 旧笔记标为 `superseded`，两边互相链接。

`type` 与目录：

| `type` | 目录 |
|---|---|
| `doc` | `Docs/` |
| `decision` | `Decisions/` |
| `gotcha` | `Pitfalls/` |
| `convention` | `Conventions/` |
| `session-log` | `Daily/` |
| `hub` | 项目 `index.md` |
| `glossary` | `Docs/glossary.md` |

`Inbox/` 不是 `type`。低置信度候选的路由见 [03 核心概念](03-concepts.md)。

`status` 的取值：

`active`、`proposed`、`accepted`、`superseded`、`deprecated`、`provisional`、`contested`、`archived`。

写入成功返回 vault 相对路径。
写入失败返回错误码，不改动任何文件。

## mem_log

向今天的日志追加一条记录。

| 参数 | 必填 | 说明 |
|---|---|---|
| `text` | 是 | 一条记录 |
| `session` | 否 | 会话 id |
| `section` | 否 | 日志标题，或热层区域 |
| `idempotencyKey` | 否 | 重试时返回原结果 |

`section` 的保留值：

- `hot`：写入热层的`进行中`区。
- `强约束`、`进行中`、`已完成`：直接写入对应区域。

日志按会话幂等。
同一个会话重复调用，不会追加第二条相同记录。

热层超过容量时，写入会先归档。
无法腾出空间时，返回 `hot-over-capacity`。
修复方法见 [09 故障排查](09-troubleshooting.md)。

## mem_brief

无参数。

绑定时，返回当前会话注入的简报：

| 字段 | 含义 |
|---|---|
| `text` | 简报正文 |
| `charCount` | 实际长度，单位是码点 |
| `truncated` | 是否因预算裁剪过 |
| `omitted` | 被裁掉的完整条目数 |
| `hotItems` | 热层条目数组（id、区域、正文、来源） |

未绑定时，返回 `status: "unbound"`，并附带机器可读的 `reason`。

常见 `reason`：

| reason | 含义 |
|---|---|
| `no-pointer` | 仓库没有 `.obsidian-mem` |
| `no-git-root` | 目录不在 Git 仓库中 |
| `cwd-missing` | 会话记录的目录已不存在 |
| `pointer-corrupt` | 指针存在但无法解析 |
| `pointer-unsupported-schema` | 指针的 `schema` 不认识 |

`mem_brief` 不写任何文件。

## mem_admin

低频维护入口。所有动作都需要 `action`。

| `action` | 额外参数 | 作用 |
|---|---|---|
| `lint` | `report`、`prune` | 体检 vault，默认只读 |
| `index` | `rebuild` | 查看或重建搜索索引 |
| `bind` | `mode` | 查看或执行绑定 |
| `projects` | 无 | 列出已登记项目 |
| `promote` | `path` | 把笔记复制到 `Methods/` |
| `jobs` | `jobId`、`retry` | 查看或重试队列任务 |
| `curation` | `operation` | 读取或运行整理 |
| `hot` | `operation` | 查看或压缩热层 |
| `diagnostics` | 无 | 读取本进程的决策环 |

`bind` 的 `mode`：

- `show`：只报告，不写。
- `local`：显式绑定当前目录，普通目录也可用。
- `fork`：为 worktree 创建新身份。
- `retain`：确认当前身份，记录 remote 提示。

`curation` 的 `operation`：

- `status`：读取游标、记忆视图和提案队列，不扫描。
- `scan`：立即跑一趟有界扫描。

`hot` 的 `operation`：

- `status`：报告容量、每区字符数、条目数、指针数。
- `compact`：折叠指针行，归档最旧的可搬出条目。

`jobs` 的 `retry` 只对终态失败的 job 有效。
如果 job 已保存模型输出，重试只重新校验，不再次调用模型。
如果还没有输出，重试会重新调用模型。

## 失败时怎么处理

| 拒绝 | 含义 | 做法 |
|---|---|---|
| `human-owned` | 文件属于用户 | 不改，写到 `Inbox/` 并报告 |
| `hash-mismatch` | 文件在读取后被改动 | 重新读取，再决定 |
| `index-not-ready` | 索引仍在首次扫描 | 等待或 `mem_admin(action="index")` |
| `hot-over-capacity` | 热层没有可归档条目 | `mem_admin(action="hot", operation="compact")` |
| `vault-cloud-managed` | vault 在云托管目录 | 移到本地磁盘 |
| `no-git-root` | 当前目录不是 Git 仓库 | `mem_admin(action="bind", mode="local")` |

完整症状表见 [09 故障排查](09-troubleshooting.md)。

## 三条工作规则

1. **先搜再猜。** 项目结论以 vault 为准，不以对话记忆为准。
2. **拒绝不要绕过。** 工具拒绝写入时，不要用 shell 直接改文件。
3. **提案不是结果。** 整理提案只有人工评审命令能批准，工具不能。

## 下一步

你已知道每个工具的参数。
下一页看写入为什么要事务，以及崩溃后如何恢复。

下一页：[08 可靠性](08-reliability.md)
