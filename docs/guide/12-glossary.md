# 12 术语表

## 核心对象

| 术语 | 英文 | 含义 |
|---|---|---|
| 会话 | session | 一段连续对话，有独立 id |
| 回合 | turn | 一次请求与响应的完整过程 |
| 项目绑定 | binding | 工作目录到 vault 项目目录的对应关系 |
| 指针 | pointer | 仓库根的 `.obsidian-mem` 文件，四个字段 |
| 项目标识 | `projectId` | UUIDv4，项目的稳定身份 |
| vault | vault | 存放全部 Markdown 笔记的本地目录 |
| 项目目录 | project directory | `Projects/<slug>--<id8>/` |
| hub | hub / MOC | 项目首页 `index.md`，记忆入口 |
| frontmatter | frontmatter | Markdown 文件开头的 YAML 元数据 |
| 属性 | property | frontmatter 中的一个键，例如 `status` |

## 写入与恢复

| 术语 | 英文 | 含义 |
|---|---|---|
| 事务 | transaction | 一组要么全成功、要么全回滚的文件修改 |
| 回执 | receipt | 一次写入或一个 job 的持久记录 |
| 快照 | snapshot | 修改前保存的旧字节，放在 `_meta/.history/` |
| 引导 | bootstrap | 第一次绑定后创建 vault 骨架 |
| 幂等 | idempotent | 同一操作重复执行，结果与原结果相同 |
| 取代 | supersede | 用新笔记替换旧结论，旧笔记保留 |
| 争议 | contested | 两条结论冲突，等待人判断 |
| 所有权 | ownership | 判断插件能否修改一个文件的依据 |
| 热层 | hot layer | `_meta/hot.md`，每次会话注入 |
| 温层 | warm layer | vault 其余笔记，按需检索 |
| 冷层 | cold layer | `Daily/` 日志，只搜索不注入 |

## 检索与整理

| 术语 | 英文 | 含义 |
|---|---|---|
| 简报 | brief | 会话开始时注入的一页上下文 |
| 逐轮检索 | recall | 每个新提问时注入的相关笔记索引 |
| 捕获 | capture | 把完成的回合写成 pending job |
| 蒸馏 | distillation | 用模型把回合转成候选笔记 |
| 整理 | curation | 只读 Markdown 的重复检查与记忆视图 |
| 提案 | proposal | 停放中的候选，等待人工评审 |
| 索引 | index | SQLite FTS5 搜索缓存，可重建 |
| FTS5 | FTS5 | SQLite 的全文搜索模块 |
| MOC | Map of Content | 内容地图，即项目 hub |

## 工具与宿主

| 术语 | 英文 | 含义 |
|---|---|---|
| DSH | DeepSeek Harness | 运行这个插件的宿主 |
| Cordis | Cordis | DSH 的插件框架 |
| MCP | Model Context Protocol | Codex 侧的工具协议 |
| 工具面 | tool surface | 六个 `mem_*` 工具 |
| 数据根 | data root | `$DSH_HOME/data/obsidian-mem/` |
| 工作树 | worktree | 同一仓库的另一个检出目录 |
| ADR | Architecture Decision Record | 架构决策记录 |
| STE | ASD-STE100 | 受控英语写作标准 |

## 常见问题

### 1. 必须安装 Obsidian 吗？

不必须。
vault 是普通 Markdown 目录，任何编辑器都能读。
Obsidian 只提供阅读体验和双链导航。

### 2. 可以把 vault 放在 iCloud 或 Dropbox 吗？

不可以。
按需下载的占位符会让读取失败或阻塞。
插件会以 `vault-cloud-managed` 拒绝读写。
把 vault 放在本地磁盘，再用带版本的工具备份。

### 3. 多个仓库能共用一个 vault 吗？

可以。
每个项目有独立目录，注册表记录全部项目。
写锁按整个 vault 生效，两个项目不会交错写共享文件。

### 4. 换电脑怎么办？

克隆仓库，复制 vault，把新机器的 `vaultPath` 指向它。
指针不含绝对路径，`projectId` 保持不变。
如果只搬仓库不搬 vault，项目会重新 bootstrap。

### 5. 误删笔记能恢复吗？

插件从不删除笔记。
恢复取决于你的备份：Git、Time Machine 或 vault 副本。
`_meta/.history/` 只保存事务快照，不是完整备份。

### 6. 刚写的内容为什么搜不到？

搜索默认读索引。
索引未刷新时，先运行 `mem_admin(action="index")` 查看状态。
如果索引损坏，用 `rebuild=true` 重建。

### 7. 为什么整理提案没有自动应用？

这是设计。
合并、取代、归档都会改变事实，必须由人决定。
批准入口只有 `dsh-obsidian-mem-review` 命令。

### 8. agent 能代替我批准提案吗？

不能。
没有任何 `mem_admin` 动作、参数或枚举值可以批准提案。
评审命令要求真实终端和逐字输入。

### 9. 蒸馏会把什么发给模型？

只发白名单投影：

- 用户消息
- 最终助手文本
- 工具名与成功/失败标记
- 有上限的路径和行号

启用 `distill.learnHabits` 时，还会附带有限的项目习惯上下文。
不发插件注入、推理块、原始工具输出、工具参数和凭据。
细节见 [README 隐私边界](../../README.zh.md#隐私边界)。

### 10. 卸载插件后 vault 还能读吗？

能。
vault 是纯 Markdown，不依赖 DSH。
卸载后失去自动注入和工具，但文件仍在。

### 11. 为什么写入被拒绝为 `human-owned`？

目标笔记的 `trust` 是 `owner`。
这表示文件属于人，插件不能改写。
把新结论写到相邻笔记或 `Inbox/`，再链接到原笔记。

### 12. 怎么先关闭自动写入？

三种方式，作用不同：

| 配置 | 关闭什么 |
|---|---|
| `autoCapture: false` | 停止捕获新回合 |
| `distill.dryRun: true` | 保留蒸馏，只写回执 |
| `autoCurate: false` | 停止自动整理 |

改完都要重启宿主。

## 版本

- 文档对应版本：0.2.0
- 代码基线：`3947363`

返回目录：[README](README.md)
