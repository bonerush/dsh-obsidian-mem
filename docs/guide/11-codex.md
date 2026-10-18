# 11 Codex 适配

Codex 不能安装这个 DSH 插件本身。
插件依赖 Cordis 工具注册和 DSH 会话事件，这些在 Codex 中不存在。

Codex 适配器提供四条能力，并明确缺少一条。

| 能力 | Codex 中的形式 | 说明 |
|---|---|---|
| 协议 | Agent Skills 技能 | vault 布局、frontmatter、笔记规则 |
| 六个工具 | MCP（Model Context Protocol）server | 复用同一套 `lib/` |
| 会话简报 | `SessionStart` 钩子 | 首次模型调用前注入 |
| 逐轮相关笔记 | `UserPromptSubmit` 钩子 | 使用同一检索策略 |
| 自动蒸馏 | **不可移植** | MCP 只有工具，没有回合边界 |

记忆层只有一份代码。
MCP server 与两个钩子都从本仓库的 `lib/` 导入，不复制第二份。

## 安装

前置条件：Node `>= 22.22.2`，并在检出目录执行过 `npm ci`。

```sh
npm ci
node codex/prepare.mjs

codex plugin marketplace add "$PWD/codex/marketplace"
codex plugin add dsh-obsidian-mem@dsh-obsidian-mem-local

codex plugin list
codex mcp list
```

`prepare.mjs` 不是可选步骤。
Codex 会把插件目录复制到 `~/.codex/plugins/cache/`。
生成的两份声明文件必须写绝对路径，复制后才不会断。
移动检出目录后，重新运行 `prepare.mjs`。

期望结果：

- `codex plugin list` 显示 `dsh-obsidian-mem`。
- `codex mcp list` 显示 `obsidian-mem`。

## 批准钩子

第一次启动会话时，Codex 会要求审查新钩子。

必须批准 `dsh-obsidian-mem` 的钩子。
未批准的钩子会被**静默跳过**：没有报错，也没有上下文。

只在你信任要运行的代码时使用这个开关。
`--dangerously-bypass-hook-trust` 会跳过审查，并在会话中打印警告。

```sh
codex --dangerously-bypass-hook-trust
```

## 只装 MCP

如果只想要工具，不要技能和钩子：

```sh
codex mcp add obsidian-mem --env DSH_HOME="$HOME/.dsh" -- node "$PWD/codex/server.mjs"
```

这个变体没有钩子。
会话开始时不会自动注入简报。
agent 必须自己调用 `mem_brief` 和 `mem_search`。

## 行为差异

| 行为 | DSH | Codex（完整插件） |
|---|---|---|
| 自动捕获回合 | 是 | 否 |
| 自动蒸馏 | 是 | 否 |
| 自动整理 | 是 | 仅在受信任的 `SessionStart` 钩子中 |
| 六工具 | 是 | 是 |
| 会话简报 | 是 | 是 |
| 逐轮检索 | 是 | 是 |
| 写入方式 | 工具与自动蒸馏 | 主要靠显式 `mem_write` / `mem_log` |

Codex 没有自动蒸馏。
事实只在显式写入时留下。
这要求用户或 agent 主动决定“这条要记住”。

## 钩子的细节

`SessionStart` 钩子读取会话工作目录，构造简报，然后输出一个 JSON 对象。

它处理四种来源：

| source | 行为 |
|---|---|
| `startup` | 注入 |
| `clear` | 注入 |
| `compact` | 注入，因为压缩会丢掉简报 |
| `resume` | 读 rollout：简报仍在时不重复注入 |

钩子的超时是 15 秒。
无论成功失败，它都退出 0，不会阻断会话。

`UserPromptSubmit` 钩子在每个新提问时检索相关笔记。
它使用与 DSH 相同的 `lib/prompt-recall.js`。

## 排障

| 症状 | 检查 |
|---|---|
| 没有简报 | 先看钩子是否已批准，再看 `hooks/list` 的 `trustStatus` |
| 工具不存在 | `codex mcp list` 是否有 `obsidian-mem` |
| 工具报未绑定 | 当前目录是否有 `.obsidian-mem` |
| 数据写到了别处 | `DSH_HOME` 是否与 DSH 侧一致 |
| 移动目录后失效 | 重新运行 `node codex/prepare.mjs` |

未受信任的钩子不会给出错误。
这是最容易漏掉的一项。

## 下一步

你已知道 Codex 侧能做什么。
下一页是术语表和常见问题。

下一页：[12 术语表](12-glossary.md)
