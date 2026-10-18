# 10 开发指南

这页面向修改代码的人。
内容包括目录、命令、测试、代码规则和发布。

## 目录地图

| 路径 | 内容 | 随包发布 |
|---|---|---|
| `lib/` | 插件代码，59 个 JS 模块 | 是 |
| `client/` | 图谱 Worker 的消息契约（构建输入） | 否，生成物在 `lib/` |
| `skills/obsidian-mem/` | 可移植的方法技能 | 是 |
| `codex/` | Codex MCP 适配器与钩子 | 否 |
| `test/` | `node --test` 测试 | 否 |
| `scripts/` | 校验、构建、发布脚本 | 否 |
| `docs/` | 本机维护文档与实测记录 | 否 |
| `research/`、`scratch/` | 调研与临时产物 | 否 |

`docs/`、`research/`、`scratch/` 和 `AGENTS.md` 默认不进版本库。
本套文档位于 `docs/guide/`，同样属于本机文档。

## 常用命令

| 时机 | 命令 | 作用 |
|---|---|---|
| 一次 | `npm ci` | 按 lockfile 安装依赖 |
| 改完代码 | `npm test` | 跑完整测试套件 |
| 提交前 | `npm run check:fast` | 只检查暂存区，约 1 秒 |
| 推送前 | `npm run check` | 跑完整闸门 |
| 发布前 | `npm run prepack` | 测试加包清单校验 |
| 打包后 | `npm run pack:check` | 打出真实 tarball（打包归档）并检查 |
| 可选 | `npm run hooks:install` | 安装 pre-commit 钩子 |

`npm run check` 依次执行：

1. `eslint .`
2. `prettier --check`
3. `tsc --noEmit`（只检查登记过的文件）
4. `npm test` 加 `verify-pack`
5. 打出真实 tarball，检查归档内容

CI 跑同一条命令。
只存在于 CI 的检查，等于本地通过、推送失败。

## 测试隔离

`npm test` 不是直接运行 `node --test`。
`scripts/run-tests.mjs` 会：

1. 创建一次性目录。
2. 把 `DSH_HOME` 指向这个目录。
3. 运行 `node --test test/*.test.js`。
4. 删除临时目录。

所以测试写不进真实的 `~/.dsh`。
写新测试时仍要传显式临时 `dataRoot`，不要依赖默认值。

绝不要把测试或手工探测指向：

- 真实的 `~/Documents` vault
- 真实 `$DSH_HOME/data/obsidian-mem/`
- 任何你不想丢的笔记

需要临时目录时用 `mktemp -d`。

## 代码规则

- 使用 ES modules 和 `node:` 前缀的内置模块。
- 两个空格缩进，单引号，不写分号。
- 导出函数写 JSDoc。
- 注释解释“为什么”，不重复代码。
- 运行时依赖只有两个：`schemastery` 和 `yaml`。
- 开发依赖固定版本。

架构规则也是测试：

- 每个模块有层号。
- 依赖只能向下。
- 同层不能互相 import。
- 每个文件有行数预算。

新增模块必须修改 `test/architecture.test.js`。
这样做让“结构变化”成为一次显式决定。

## 类型检查是棘轮（只收紧，不放松）

`npm run types` 只检查 `tsconfig.json` 列出且带 `// @ts-check` 的文件。
不在列表里的文件不被检查。

`test/repo-hygiene.test.js` 保证两个列表一致。
标记不能悄悄失效。

## 发布

本仓库不发布到 npm 注册表。
一次发布等于一个 git tag 加一个 GitHub Release。

| 版本变化 | 时机 | 谁做 |
|---|---|---|
| 补丁号 | 每次 push 进 `main` | workflow 自动 |
| 次版本号 | 值得标注的功能 | 人工，在 push 前 |
| 主版本号 | 破坏性变更 | 人工，在 push 前 |

workflow 依次：

1. 在待发布提交上跑 `npm run check`。
2. 询问远端这个版本是否已有 tag。
3. 没有 tag：打 tag，发布，结束。
4. 有 tag：检查 `## Unreleased`，移动条目，递增补丁号，同步清单，提交并发布。

发布后 `## Unreleased` 为空。
下一次改 `lib/` 时要主动添加条目，否则 push 会被拒绝。

`prepack` 只校验，不构建。
它不启动 Obsidian，不写 vault，不运行 `npm pack`。

## README 双语规则

`README.md` 和 `README.zh.md` 权威对等。
改一侧必须在同一次改动中改另一侧。

改完后更新哈希记录：

```sh
git hash-object README.md README.zh.md
```

把两个值写回 `README.i18n.yaml`。
中文侧被链接的标题要加显式 `<a id="英文-slug"></a>`，让同一个锚点从两种语言都能到达。

## 修改宿主接缝前

涉及会话事件、`ctx.llm`、注入时机的改动，先读：

```text
docs/p0-compatibility.md
```

那里是实测的宿主事实。
代码注释不是事实来源。

## 提交前检查

```sh
npm run check
git diff --check
```

第一条跑完整闸门。
第二条检查空白损坏。

本地通过再提交。
推送后 CI 会跑同一条命令。

## 下一步

你已知道如何开发和发布。
下一页看 Codex 适配器。

下一页：[11 Codex 适配](11-codex.md)
