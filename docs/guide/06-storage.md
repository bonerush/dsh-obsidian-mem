# 06 存储布局

这页回答三个问题：

- 磁盘上有什么？
- 哪些文件可以删？
- 哪个副本是事实来源？

## 三个位置

| 位置 | 内容 | 谁的 |
|---|---|---|
| 代码仓库 | 源码、README、`.obsidian-mem` | 你的 |
| vault | 项目文档、决策、约定、踩坑 | 你的，插件代写 |
| 数据根 | 索引、锁、队列、回执、诊断 | 插件 |

数据根默认是 `$DSH_HOME/data/obsidian-mem/`。
`DSH_HOME` 未设置时是 `~/.dsh`。

三个位置分离是有意的：

- vault 可以单独备份或迁移。
- 数据根的索引和视图可以删除。队列与提案不能删。
- 卸载插件后，vault 仍然可读。

## vault 布局

```text
<vault>/
├── _meta/
│   ├── user.md                 用户习惯，只读
│   ├── registry.md             项目注册表
│   ├── log.md                  写入回执
│   └── .history/               写入前快照
├── Methods/<slug>.md           跨项目方法
└── Projects/<slug>--<id8>/
    ├── index.md                项目 hub / MOC
    ├── Docs/
    │   ├── glossary.md         术语表
    │   └── hot-archive.md      热记忆归档
    ├── Decisions/              ADR 式决策
    ├── Conventions/            一条约定一个文件
    ├── Pitfalls/               症状 / 原因 / 修复 / 证据
    ├── Daily/YYYY-MM-DD.md     会话日志
    ├── Inbox/                  待分类
    └── _meta/hot.md            热记忆
```

规则：

- 插件命名的文件使用 ASCII，例如 `index.md`、`hot.md`、`log.md`。
- 笔记文件名来自标题，可以使用中文。
- 目录深度不超过 3 层。主题关系用双链和标签表达。
- `_meta/user.md` 由你维护。插件只读，永不写入。

## 数据根布局

```text
<data-root>/
├── index/          可重建的 SQLite 搜索索引
├── locks/          整仓写锁
├── transactions/   事务日志，崩溃恢复用
├── receipts/       每次写入与每个 job 的回执
├── pending/        待蒸馏 job（0700 / 0600）
├── curation/       整理状态
│   └── proposals/  待评审提案（不可重建）
├── diagnostics/    不含正文的决策日志（0700 / 0600）
└── processed/      会话已处理范围（0700 / 0600）
```

`pending/`、`curation/`、`diagnostics/`、`processed/` 含敏感信息。
它们的目录权限是 `0700`，文件权限是 `0600`。
不要把这些目录同步到公共位置。

## 哪些文件可以删

| 路径 | 可以删吗 | 后果 |
|---|---|---|
| `index/` | 可以 | 下次扫描重建 |
| `curation/` 的游标、记录、记忆视图 | 可以 | 重新扫描 |
| `curation/proposals/` | **不可以** | 丢失待评审工作 |
| `pending/` | 不要手工删 | 丢失待蒸馏回合 |
| `transactions/` | 不要手工删 | 破坏崩溃恢复 |
| `locks/` | 只删错误指名的损坏锁文件 | 其他写入等待超时 |
| `diagnostics/` | 由插件自动清理 | 7 天前的运行文件 |
| vault 笔记 | **不可以** | 丢失事实 |

`_meta/.history/` 是恢复材料，不是备份。
`mem_admin(action="lint", prune=true)` 会在仓库锁内清理过期快照。

## 事实来源

| 数据 | 事实来源 | 缓存？ |
|---|---|---|
| 笔记正文 | vault 的 Markdown | 否 |
| 搜索结果 | vault | 索引是缓存 |
| 简报中的记忆视图 | vault | 视图是缓存 |
| 写入状态 | 回执与事务日志 | 否 |
| 待评审提案 | 数据根的 `proposals/` | 否 |
| 页面中的图谱 | vault 与索引 | 是 |

冲突时以 vault 为准。
索引损坏、记忆视图过期、图谱空白，都可以通过重建恢复。

## 备份与迁移

**备份 vault。** 它包含全部记忆。
用 Git、Time Machine 或你信任的工具复制整个目录。

**不要备份索引。** 它是缓存，重建即可。
`mem_admin(action="index", rebuild=true)` 可以立刻重建。

**迁移仓库。** 正常 clone 即可。
`.obsidian-mem` 不含绝对路径，只有四个字段。
在新机器上把 `vaultPath` 指向新 vault，项目身份不变。

**改名。** 改仓库名或显示名不会移动项目目录。
目录名在第一次绑定时固定。
`mem_admin(action="bind", mode="show")` 只报告，不改动。

**多份副本。** 同一仓库的 worktree 共享 `projectId`。
真正的 fork（独立项目）用 `mem_admin(action="bind", mode="fork")` 获取新身份。
换了远程仓库地址，但仍想保留身份，用 `mode="retain"`。

## 本地磁盘限制

vault 必须在本地磁盘。
以下目录会被拒绝，读和写都拒绝：

- `~/Library/Mobile Documents/`（iCloud Drive）
- `~/Library/CloudStorage/`（Dropbox、OneDrive、Google Drive 等）

原因是按需下载文件会产生占位符。
后台进程读取占位符有两种失败：阻塞，或返回 `EDEADLK`。

拒绝码是 `vault-cloud-managed`。
修复方法：把 vault 移到本地磁盘，并更新 `vaultPath`。

## 文件所有权

插件只改自己写的文件。判断依据包括：

- `trust: agent`
- `harness: dsh`
- 有效的笔记 `id`
- 清单或哈希与上一次写入匹配

以下文件永远不碰：

- `_meta/user.md`
- `trust: owner` 的笔记
- 插件没有写入记录的外部 Markdown

生成块带有哈希标记。
如果你手工改过生成块，插件会报告冲突，不会覆盖。

## 下一步

你已知道文件放在哪里，以及哪些能删。
下一页是六个工具的完整参考。

下一页：[07 工具手册](07-tools.md)
