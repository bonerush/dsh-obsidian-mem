# 02 快速开始

这页带你完成四件事：安装、重启、写第一条记忆、验证结果。
全程约 20 分钟。

## 前置条件

| 条件 | 要求 | 检查命令 |
|---|---|---|
| Node | `>= 22.22.2` | `node -v` |
| DSH | `0.1.5-rc.2` 或 `0.1.7-rc.2` 实测通过 | `dsh --version` |
| Git（版本控制工具） | 隐式绑定需要一个 Git 仓库 | `git --version` |
| Obsidian | 可选，只用于阅读 | 无 |
| vault 目录 | 本地磁盘，例如 `~/Documents/dsh-memory` | `echo $HOME` |

Node 的下限来自实测。`node:sqlite` 需要 FTS5，22.22.2 是已验证可用的最低版本。
原因见 [README 环境要求](../../README.zh.md#requirements)。

## 步骤 1：创建 vault 目录

不要指向你已有的个人 vault。
插件会往 vault 根写项目目录和 `_meta/`。专用目录能避免两者相遇。

```sh
vault="$HOME/Documents/dsh-memory"
mkdir -p "$vault"
```

如果换了路径，把插件配置的 `vaultPath` 指向它。

## 步骤 2：在一次性 profile（DSH 配置档）中试装

这一步不碰你真实的 `~/.dsh`。

```sh
export DSH_HOME="$(mktemp -d)"
dsh plugin --profile memcheck add github:bonerush/dsh-obsidian-mem
dsh --profile memcheck --dump-config | grep -n obsidian-mem
unset DSH_HOME
```

最后一条命令应输出三行，其中包含：

```text
# == dsh-obsidian-mem
- id: obsidian-mem
  name: dsh-obsidian-mem
```

看不到 `obsidian-mem` 就停在这里。先查安装错误，不要继续。

## 步骤 3：装进日常 profile

把 `web` 换成你平时使用的 profile 名。

```sh
dsh plugin --profile web add github:bonerush/dsh-obsidian-mem
dsh --profile web --dump-config | grep -n obsidian-mem
```

要固定版本，在包名后加 `#<commit>`。

然后重启 `dsh web`（或你的宿主启动命令），并新建一个会话。

两个动作都不能省：

- **重启宿主**：插件代码每个进程只加载一次。
- **新建会话**：旧会话持有旧的插件实例。

如果你在开发这个插件，用本地路径安装：

```sh
dsh plugin --profile web add "link:$PWD"
```

`link:` 不复制文件，改动立即生效。

## 步骤 4：写第一条记忆

在一个 Git 仓库中打开新会话，对 agent 说：

```text
把「索引使用 SQLite FTS5，不使用向量库」写进项目记忆，类型 convention。
```

期望发生三件事：

1. 仓库根出现 `.obsidian-mem`。这是第一次写入触发的绑定。
2. vault 中出现项目目录 `Projects/<slug>--<id8>/`。
3. 目录中出现 `Conventions/` 下的 Markdown 笔记。

如果仓库已有指针，插件不会覆盖它。已有的身份永远优先。

## 步骤 5：验证

| 检查项 | 怎么做 | 期望 |
|---|---|---|
| 插件行已挂载 | `dsh --profile web --dump-config \| grep obsidian-mem` | 出现 `- id: obsidian-mem` |
| 项目已绑定 | 让 agent 调用 `mem_admin(action="projects")` | 报告当前项目与 vault 路径 |
| 笔记已写入 | `ls "$vault/Projects/"` | 看到 `<slug>--<id8>` 目录 |
| 搜索可用 | 让 agent 调用 `mem_search`，查询 `FTS5` | 返回刚写的笔记 |
| 简报存在 | 让 agent 调用 `mem_brief` | 返回 `text`、`charCount` 等字段 |

`mem_brief` 返回的就是会话开始时注入的那段文本。
如果它返回 `status: "unbound"`，说明当前目录还没有绑定。
下面的常见失败表给出下一步。

## 步骤 6：用 Obsidian 阅读（可选）

1. 打开 Obsidian。
2. 选择 **Open folder as vault**。
3. 选择 vault 目录。

不需要预先创建文件。插件在第一次写入时生成骨架。
打开 `Projects/` 下的项目目录，从 `index.md` 开始读。
插件不写 `.obsidian/types.json`，也不改你已有的笔记。

## 安全起步：先看，再放开

自动蒸馏默认开启。它会在回合结束后调用模型，并写入真实笔记。
第一次使用时，先观察：

```yaml
distill:
  dryRun: true
```

在插件行的 `config:` 中设置这一项。改完重启宿主。
`dryRun: true` 只写回执，不写记忆笔记。
观察几个回合后，把值改为 `false`，再重启。

如果你已经在 `config:` 中改过别的字段，覆盖时要一起列出。
完整字段表见 [README 配置](../../README.zh.md#配置)。

## 三个常见失败

| 现象 | 常见原因 | 去哪查 |
|---|---|---|
| 工具列表没有 `mem_*` | 插件行未挂载，或宿主未重启 | [09 故障排查](09-troubleshooting.md) |
| 写入被拒绝，码为 `no-git-root` | 当前目录不是 Git 仓库 | 用 `mem_admin(action="bind", mode="local")` |
| 搜索返回 `index-not-ready` | 索引仍在首次扫描 | 等扫描结束，或运行 `mem_admin(action="index")` |

完整症状表在 [09 故障排查](09-troubleshooting.md)。

## 下一步

你已跑通第一条记忆。
下一页解释七个核心概念，让你知道每一步为什么这样设计。

下一页：[03 核心概念](03-concepts.md)
