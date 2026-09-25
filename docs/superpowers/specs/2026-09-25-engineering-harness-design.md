# dsh-obsidian-mem 工程框架设计文档

- **日期**：2026-09-25
- **状态**：用户确认的设计已完成独立复审；本次修正执行边界，待实施
- **路径**：`docs/superpowers/specs/2026-09-25-engineering-harness-design.md`
- **前置提交**：`e31fa13`（Phase 0 的真缺陷修复，见 §12）
- **一句话**：给这个仓库装上一套**可执行的**工程骨架——门禁自动化、运行时可见、结构约束可度量——让 agent 开发者与独立开发者能快速判断改动的影响与验证方法。

### 复审修正（2026-09-25）

复审保留 D1–D6 的用户决策，并修正原稿中会使实施失败或检查给出假结论的细节：`tsconfig.include` 不隔离被 import 的 JS；固定 33 个 tarball 条目与新增模块矛盾；Prettier 的 `.` 扫描范围大于基线测量范围；格式化后的 LOC 和拆分后的层级必须重新测量；诊断动作必须贯穿 DSH 与 Codex 两个入口及封闭的输出 schema；内存环只覆盖当前进程。以下各节已按这些结论修改。

### 复审补测（2026-09-25，第二轮，全部在锁定版本上复跑）

第一轮复审的结论**经复跑确认有效**（`include` 不隔离：`checkJs: true` + `files: ['root.js']` 时被 import 的 `child.js` 同样报错，`checkJs:false` + 标记时只报标记文件）。补测同时改掉了三处仍然失真或过度保守的结论：

1. **类型基线的数字必须带版本。** 同一范围：TypeScript 7.0.2 → 2,446 个 error；**锁定的 5.9.3 → 193 个**（§3.5）。原表只保留为历史记录。
2. **棘轮的实际代价比"先做 4 个文件"小得多。** opt-in 模型下逐文件实测：**9 个文件 0 错误**、3 个文件各 1 处，共 **12 个文件、3 处修复**（§7.3）。本轮改为纳入这 12 个。
3. **`skipLibCheck: true` 从"不许用"改为"必需"。** 实测不带它时，`lib/index.js`/`lib/tools.js`/`codex/server.mjs` 会在 `@deepseek-ai/dsh-llm` 的 `.d.ts` 内部报 TS2307/TS6200——第三方类型的冲突，不是本仓库源码问题（§7.4）。
4. **ESLint 的版本差要写明**：43 条是 10.11.0 的数，9.39.5 下只有 28 条，差额全部来自 10.x 新增的两条规则，因此**锁定 10 而不是 9**（§6.2）。

另外两项经复跑确认可用，无需改动：prettier `--check --stdin-filepath`（未格式化 → exit 1，已格式化 → exit 0）与 eslint `--stdin --stdin-filename`；以及 `npm pack --json` 会给出 `files[]` 与 `entryCount`，足以支撑不写死文件数的包校验。

---

## 1. 背景与目标

### 1.1 需求（用户原话归纳）

> 请帮我在该项目使用一种合适的工程框架，使得该插件更好的管理和优化，并且对于 agent 开发者和独立开发者的 debug 以及提交对应修改更加的友好。

用户在四个候选痛点中**全选**（除"换技术栈"外），即本文必须同时覆盖：

| # | 痛点 | 用户选择的措辞 |
|---|---|---|
| P1 | 验证靠自觉 | 没有 CI / lint / 格式 / 类型检查；AGENTS.md 的提交前五条命令全靠人肉执行 |
| P2 | 运行时排障靠猜 | `lib/` 没有日志/追踪开关；出问题只能读代码或重跑 smoke（要 API key） |
| P3 | 冷启动上下文太重 | 新 agent 要先读 ~200KB 散文才知道改哪儿 |
| P4 | 代码结构在变重 | `lib/` 已有 4 个文件 1685–1978 行 |

### 1.2 非目标（明确不做）

- **不迁 TypeScript**。`engines.node` 与运行时依赖（只有 `schemastery` 与 `yaml`）保持不变；本文只增加 **devDependencies**。
- **不换测试框架**。`node --test` 与 `scripts/run-tests.mjs` 的临时 `DSH_HOME` 隔离**原样保留**——那是 R42 事故换来的结构性保证（见 AGENTS.md 的 Commands 一节）。
- **不用 changesets**（用户 D4）。替代品见 §4.5。
- **不引入 seam 探针台**（用户 D1 否决了"seam 优先"骨架）。运行时可见性走 `ctx.logger` + 会话内诊断环（§9），不新建探针平台。
- **不让 Prettier 碰 Markdown 与夹具**（§5.2）。README 双语对的 blob hash 记在 `README.i18n.yaml`，格式化会打破 AGENTS.md 第 7 条。
- **不自动修改任何人的 git config**（§4.4）。`.githooks/` 入库，安装是显式 opt-in。
- **`prepack` 保持只读校验器**（AGENTS.md 第 2 条）：它仍是 `npm test && node scripts/verify-pack.mjs`，新增检查不进入它。

### 1.3 验收方式

| # | 目标 | 验收方式 |
|---|---|---|
| G1 | 一条命令等价于整套不依赖 Git 比较基线的门禁，本地与 CI 共用 | `npm run check` 在本地与 CI 都执行 lint、format、types、prepack 和真实 tarball 校验；CI 另执行需要 Git 基线的 CHANGELOG 检查 |
| G2 | 提交前快速挡住明显错误 | `.githooks/pre-commit` 检查暂存的 JS 与 CHANGELOG，再跑两个适应度测试；实测耗时并记录，5 秒是目标，不是未经测量的通过条件 |
| G3 | 当前进程中的运行时失败可被 agent 取到 | `mem_admin(action="diagnostics")` 返回有界结构化事件环；正文隐私哨兵测试通过；重启后的历史由既有收据与 pending 队列查看 |
| G4 | 结构不会在无人察觉时继续膨胀 | `test/architecture.test.js` 对 10 层分层表 + LOC 预算失败即红；实测当前状态为绿 |
| G5 | agent 冷启动只需读 `AGENTS.md` 的两张表 | `npm run` 命令表与"真相在哪"表；`test/repo-hygiene.test.js` 断言 `AGENTS.md` 与两份 README 里出现的每个 `npm run <name>` 都在 `package.json` 的 `scripts` 里存在 |
| G6 | 双语文档与 CHANGELOG 的既有约定由机器守 | blob hash 检查进入 `npm test`；`lib/` 改动而 Unreleased 未动则在 pre-commit/CI 失败 |

---

## 2. 决策记录

| # | 决策 | 值 | 决策者 |
|---|---|---|---|
| D1 | 骨架 | **标准技术栈**（ESLint + Prettier + TypeScript 逐文件 JS 检查 + GitHub Actions），而非"仓库内 harness"或"seam 探针台" | 用户 |
| D2 | debug 读者 | **两者都要**：保留 `ctx.logger` 的失败告警，另存实例内诊断环供 `mem_admin` 导出；Codex 用 stderr 作可选日志出口 | 用户 |
| D3 | `printWidth` | **100**（实测 58 文件 / +9,739 / −2,939 行） | 用户 |
| D4 | 发行工具 | **不用 changesets**，换成"lib/ 改了但 CHANGELOG 的 Unreleased 没动就失败"的检查 | 用户 |
| D5 | 结构 | **本轮就拆 `tools.js`**（schema / registerTools / createMemoryServices） | 用户 |
| D6 | Phase 0 | 先把 ESLint 首跑抓到的真缺陷**单独修好提交**，再走框架 | 用户 |
| D7 | 我提议砍掉的 | 上一轮我提的 `npm run where <症状>` 命令：**砍掉**。一张表就够，多一个命令是多一份维护面 | 我（用户未反对） |

---

## 3. 实测依据（决定设计的硬数据）

本节所有数字都在本机、本提交上跑出来。命令见 §14。

### 3.1 基线

| 事实 | 值 |
|---|---|
| `npm test` | **574 tests / 0 fail / 32.8s**（`e31fa13`，含新增的 1 个回归测试；此前 573 / 33.3s） |
| `npm run prepack` | `verify-pack: OK`：7 条 allowlist、6 个必需资产齐备、6 个工具已注册 |
| tarball | `npm pack --dry-run --ignore-scripts` = **33 files**（实打包 `tar -tzf` 同为 33，其中 `README*` 3 个） |
| 测试是否需要密钥 | **不需要**。`npm test` 只用临时目录；要 API key 的 smoke 不在 `test/*.test.js` 内 |
| 仓库 | `github.com/bonerush/dsh-obsidian-mem`，分支 `main`，无 `.github/`、无 `core.hooksPath`、无任何 lint/format/tsconfig |

### 3.2 `lib/` 结构实测

- 23 个模块 / **19,305 行**。
- **零 import 环**（对 `from './x.js'` 做环检测：`cycles: none`）。
- 最长路径分层实测为 **L0–L9**，且**零条**指向更高层的边（§8.1 的表由该算法产出，不是手写估计）。
- 四个大文件**内聚而非缠绕**：`index-db.js` 只依赖 2 个模块（frontmatter、paths），`transaction.js` 只依赖 3 个（frontmatter、paths、receipts），`capture.js` 6 个，`tools.js` 10 个。
- `tools.js`（1,686 行）的三段结构可按行号切开：`TOOL_NAMES`@60、`TOOL_PARAMETERS`@116（约 520 行 schema）、`registerTools`@638（约 223 行）、`createMemoryServices`@861（约 826 行）。

### 3.3 可观测性实测

- `lib/` 里**只有 `hooks.js` 会打日志**：一个 `logWarning(ctx, message)` 辅助函数（`lib/hooks.js:830`，可选读 `ctx.logger`），**9 个调用点，全部是 `warn`**。其余 18k 行零输出，`process.stderr` 零引用。
- `lib/` 有 **238 处 `catch`**，多数按设计静默（"fail open：一次 recall 异常不能毁掉整个回合"）。
- 宿主其实**有**分级日志：cordis 的 `LoggerService` 提供命名 logger、四级 `ERROR=0 / INFO=1 / WARN=2 / DEBUG=3`、exporter 与内部环形 buffer。
- 该阈值的方向已核实：`cordis/src/logger.ts:154-156` 对每个 exporter 算 `targetLevel = exporter.levels?.[name] ?? levels?.default ?? this.level ?? INFO`，然后 `if (targetLevel < level) continue`。**数字越小越严重，`level` 大于阈值就被丢弃。**
- 在已安装宿主里找到的 exporter 有**两个**，且都不接受 `debug`：
  - **cordis 自带一个**（`cordis/lib/index.js:598`）：把消息推进有界环形 buffer，只指定 `colors: 3`、**没有 `levels`**，于是阈值回落到 logger 自身的 level（默认 `INFO`=1）。按 `targetLevel < level` 判断，**这个 buffer 只收 error 与 info，连 warn(2) 都进不去**。
  - **`dsh-app-boot` 的启动 exporter**（`dsh-app-boot/lib/index.js:4056`）：`levels: { default: 2 }`，接受 error/info/warn、**丢弃 debug**；而它的回调只把 warn/error 收进 `startupLogs`（启动期诊断，不是通用日志出口）。
- **结论（有界、已测）**：`debug`(3) 被上面两个 exporter 全部丢弃，`info`(1) 两个都收。**未验证**：TUI/CLI 等其他 surface 是否另有 exporter——静态检索只命中上述两处，但那是**已安装包里**的命中，不等于运行期 exporter 的全集。因此 §9.1 的设计**不依赖 debug 级可见**：会话内诊断环是 agent 的主通道，而 `DSH_OBSIDIAN_MEM_DEBUG` 选 `info` 级，正是因为它被两个已知 exporter 同时接受。

### 3.4 Prettier 的爆炸半径（配置：`semi:false, singleQuote:true, arrowParens:always, trailingComma:all`）

| `printWidth` | 文件 | +行 | −行 |
|---|---|---|---|
| 80 | 58 | 17,626 | 4,664 |
| **100（D3）** | **58** | **9,739** | **2,939** |
| 120 | 53 | 5,562 | 2,130 |

按目录拆（width=100）：`lib` 24 文件 +3,205/−1,053；`test` 30 文件 +6,403/−1,842；`scripts` 2 文件 +74/−22；`codex` 2 文件 +57/−22。

这些数字来自显式 JS/MJS glob；格式化并新增配置后须重测实际文件集合。此处只说明原始基线，不作为后续 LOC 预算。

辅助事实：作用域内 38,730 行，均值 43.0 字符，最长 564 字符（注释）；**2,014 行超过 100 字符**、803 行超过 120。Prettier **不重排注释**，所以长注释不会被切开，实际改动集中在代码行。现有代码与候选配置**没有冲突**：单参箭头函数不带括号的写法出现 **0** 次（`arrowParens: always` 无副作用），行尾逗号已是既有风格（2,177 行以逗号结尾）。

### 3.5 `tsc --checkJs` 基线

**版本决定数字，所以数字必须带版本。** 原轮探测（TypeScript **7.0.2**）得 **2,446 个 error / 27 个文件**；本轮在计划锁定的 **TypeScript 5.9.3** 上复测同一范围（`checkJs: true`、`lib/**/*.js`、`skipLibCheck: true`）得 **193 个 error**：TS2339 165、TS2741 11、TS2739 4、TS2353 4、TS2322 4、TS2345 3、TS4104 1、TS2367 1。两者相差一个数量级，**所以 2,446 与下表都只作为历史记录**：下表的用途是说明"这些错误长什么样"，不是验收值。

**并且：`include`/`files` 不是检查范围的边界。** 本轮用两文件夹具在 TS 5.9.3 上实测：`checkJs: true` + `files: ['root.js']` 时，被 `root.js` import 的 `child.js` **同样报错**；`checkJs: false` 且只有 `root.js` 带 `// @ts-check` 时只报 `root.js`；把标记改放进 `child.js`，就只报 `child.js`。`--listFilesOnly` 显示两个文件都在程序里——**标记才是开关**。§7.3 的棘轮据此重写。

| 错误码 | 数量 | 含义 |
|---|---|---|
| TS2339 | 1,782 | 属性不存在（`@param {object} ctx` 这类未展开的 JSDoc） |
| TS7006 | 237 | 参数隐式 any |
| TS18046 | 128 | 值为 unknown |
| TS2322 | 67 | 类型不可赋值 |
| TS7053 | 49 | 隐式 any 索引 |
| TS7005 / TS7031 / TS7034 / TS18048 | 45 / 25 / 24 / 18 | 变量或绑定隐式 any |
| TS2741 / TS2739 / TS2353 | 12 / 5 / 4 | 属性缺失或多出 |
| **TS1005** | **5** | **JSDoc 语法错误（解析失败）** |
| **TS8032** | **8** | **JSDoc `@param` 缺前置声明** |

每文件 error 数（升序）：`paths` 2、`prepare.mjs` 2、`git` 6、`routing` 6、`search` 6、`index` 9、`run-tests.mjs` 9、`config` 10、`verify-pack.mjs` 13、`registry` 14、`assets` 15、`pointer` 18、`hot` 24、`server.mjs` 27、`receipts` 30、`frontmatter` 78、`distill` 93、`vault` 95、`brief` 103、`hooks` 131、`memory` 149、`pending` 157、`lint` 180、`tools` 256、`transaction` 270、`capture` 349、`index-db` 394。

**13 处 JSDoc 方言**是其中最便宜也最有价值的一档：`lib/hooks.js` 的 162/165/167/185 与 `lib/transaction.js` 的 844 行用了 Closure 风格的 `{function(string): Promise<object>}`，TypeScript 解析不了（`lib/` 里共 5 处 `{function(`，另有 24 处 `{Function}`）。后果不只是报错：**这些函数的类型对任何读者（人和工具）都是静默失效的**。

### 3.6 ESLint 基线（`js.configs.recommended` + node globals）

- 修 `e31fa13` 之前：**44 errors / 22 of 58 files**。修完：**43 / 22**，其中 `no-undef` **从 1 变 0**。
- 分布：`no-unused-vars` 20、`no-useless-assignment` 12、`no-control-regex` 6、`preserve-caught-error` 3、`no-misleading-character-class` 2。
- **首跑就抓到 shipped code 的真缺陷**：`lib/vault.js:504` 的 `error instanceof TransactionError` 引用了一个只被**再导出**、从未 import 的名字。`||` 左侧的 `BootstrapError` 短路了唯一在作用域内的分支，所以只有"注册表事务失败"这一条路会抛 `ReferenceError`。该 catch 自 `8c988dd` 起就是这个状态，且**没有任何测试**要求 `retain` 挺过一次失败的事务。已在 `e31fa13` 修好并加回归测试（§12 Phase 0）。

### 3.7 一份与格式化无关、但属于同一类问题的发现

在 `/tmp` 的副本里跑测试时 `test/codex-mcp.test.js` 失败。隔离变量后确认：**与 Prettier 无关**——未格式化的对照副本以完全相同方式失败；真因是 rsync 带过去的、由 `codex/prepare.mjs` 生成的 `.mcp.json` 里写着**原机器的绝对路径**。删掉该文件后（等价于一次全新 clone）该文件与**整套 574 个测试全绿**。

结论：CI 在全新 clone 上不会因此变红；但**复制过目录的开发者**会在那一个测试上看到失败，机械修法是 `node codex/prepare.mjs`。这条进 §11 的"真相在哪"表。

---

## 4. 门禁矩阵

### 4.1 一个入口

```json
"scripts": {
  "test":          "node scripts/run-tests.mjs",
  "lint":          "eslint .",
  "format":        "prettier --write \"lib/**/*.js\" \"test/**/*.js\" \"test/**/*.mjs\" \"scripts/**/*.mjs\" \"codex/**/*.mjs\" \"eslint.config.mjs\"",
  "format:check":  "prettier --check \"lib/**/*.js\" \"test/**/*.js\" \"test/**/*.mjs\" \"scripts/**/*.mjs\" \"codex/**/*.mjs\" \"eslint.config.mjs\"",
  "types":         "tsc --noEmit",
  "pack:check":    "node scripts/verify-tarball.mjs",
  "check":         "npm run lint && npm run format:check && npm run types && npm run prepack && npm run pack:check",
  "check:fast":    "node scripts/check-staged.mjs",
  "hooks:install": "node scripts/install-hooks.mjs",
  "prepack":       "npm test && node scripts/verify-pack.mjs"
}
```

`check` 通过 `npm run prepack` 复用发布闸门，**不复制**它的内容；`pack:check` 在 `prepack` 之后运行，故不会递归。格式化的显式 glob 覆盖 §3.4 测量的 JS/MJS 范围与新配置文件；Markdown、夹具、JSON/YAML 元数据不在格式化入口内。

### 4.2 时机与范围

| 时机 | 命令 | 内容 | 目标耗时 |
|---|---|---|---|
| 提交前 | `.githooks/pre-commit` → `npm run check:fast` | 对暂存的 `.js/.mjs` blob 跑 eslint + Prettier；再跑两个适应度测试与暂存 CHANGELOG 门 | 目标 < 5s，实测报告 |
| 手动 / CI / 发布 | `npm run check` | lint → format:check → types → prepack(test + verify-pack) → 真实 tarball 校验 | 运行后记录实测 |
| CI 附加 | `.github/workflows/ci.yml` | `npm run check` + 按 Git 基线校验 CHANGELOG + Node 矩阵 | 运行后记录实测 |

`check:fast` 从 `git diff --cached --name-only -z --diff-filter=ACMR` 取路径，再以 `git show :<path>` 读取**暂存 blob**送给 ESLint 的 `--stdin --stdin-filename` 和 Prettier 的 `--check --stdin-filepath`。适应度测试仍读取工作区；若适应度测试的输入文件同时存在暂存与未暂存改动，脚本须明确拒绝并提示先完成暂存或跑完整 `npm run check`，不得悄悄把工作区测试结果说成暂存内容通过。无暂存 JS 时跳过对应格式检查。

### 4.3 CI

`.github/workflows/ci.yml`，触发 `push` 与 `pull_request`：

[GitHub 官方 Node 工作流示例](https://docs.github.com/en/actions/tutorials/build-and-test-code/nodejs)支持 `setup-node` 指定版本、npm 缓存与 `npm ci`；Action 主版本在实施时核对当时的官方示例并在工作流中固定。

- `strategy.matrix.node: ['22.22.2', '24.x', 'node']`——`22.22.2` 是 `engines.node` 的下界（AGENTS.md 第 5 条：那是**测出来**的最低带 FTS5 的版本，不是估计值），必须实测它，否则下界只是一个声明。
- 步骤：`npm ci` → `npm run check` → `node scripts/verify-changelog.mjs --base <SHA>`。`pack:check` 在 `check` 内创建临时目录并调用 `npm pack --ignore-scripts --pack-destination <dir>`，列真实 tarball 条目；确认 `package.json`、`lib/` 每个现存 JS、六个必需资产与两份 README 均在包内，且无 `test/`、`docs/`、`research/`、`scratch/`、pending 或本机记录。条目数仅作报告，**不得写死为 33**，因为 §10 会新增三个 shipped 模块。`--ignore-scripts` 必须保留，以免 `npm pack` 重入 `prepack`。临时目录由脚本清理。
- Git 基线：PR 用 base SHA；push 用事件的 before SHA。checkout 使用 `fetch-depth: 0`，以保证比较对象可读。首次 push 的 before 为全零时，以默认分支的 merge-base 为基线；若基线不存在或等于 `HEAD`，明确失败并打印原因，不以空 diff 通过。
- **无 secrets**：`npm test` 不需要任何密钥（§3.1），所以工作流没有密钥面。smoke（需要 `DEEPSEEK_API_KEY`）**不进 CI**，它仍是手动、带独立 profile 的验证。
- 缓存 `~/.npm`；不使用需要写权限的 action。

### 4.4 `.githooks`：不自动改 git config

AGENTS.md 第 1 条的措辞是"任何脚本都不得增删改用户的 `cordis.patch.yml`"，其精神是**不做用户没要求的配置改动**。因此：

- `.githooks/pre-commit` 入库（普通文件，可审阅）。
- `npm run hooks:install` 是**显式 opt-in**：它只做一件事——`git config core.hooksPath .githooks`——并在改动前后各打印一次该键的值。
- `npm run check` **不安装任何东西**，也不写 git config。

### 4.5 CHANGELOG 门（替代 changesets，D4）

`scripts/verify-changelog.mjs --staged|--base <ref>`：若 `lib/` 下有文件改动，而比较两端的 `CHANGELOG.md` **`## Unreleased` 内容**未增加或修改，则失败，并指向该节。`--staged` 比较 `HEAD` 与暂存 blob；`--base` 比较给定提交与 `HEAD`。互斥，缺基线不得静默通过。只改已发布段落不能满足检查。

- 它**不在** `npm run check` 里，因为它需要一个基线引用，否则在干净树上是空洞的通过。位置：pre-commit（`--staged`）+ CI（`--base`）。纯格式化提交安排在该门禁安装之前；其余改动 `lib/` 的提交须同步更新 Unreleased。
- 它**不进** `prepack`：`prepack` 必须保持只读，且不依赖 git 上下文（AGENTS.md 第 2 条）。
- 与第 6 条的关系：这条检查只保证"有人写了"，不保证"写得诚实"——诚实仍是人的责任，检查只消除"忘了写"这一种失败。

---

## 5. 格式化（Prettier）

### 5.1 配置与理由

```json
{ "semi": false, "singleQuote": true, "printWidth": 100, "arrowParens": "always", "trailingComma": "all" }
```

这四项不是审美选择，而是把 AGENTS.md 的散文约定（"两空格、单引号、**无分号**"）变成可执行配置；`arrowParens` 与 `trailingComma` 的取值经实测与现状一致（§3.4），因此不会引入风格之争。

### 5.2 `.prettierignore`：每一条都有理由

| 条目 | 理由（不写的后果） |
|---|---|
| `*.md`（含两份 README、`CHANGELOG.md`、`docs/`、`skills/`） | README 双语对的 git blob hash 记在 `README.i18n.yaml`（第 7 条）。格式化会同时改动两份 README 并让哈希失效，把一次纯机械改动变成一次需要重新核对双语对等性的改动 |
| `test/fixtures/**` | 这些是**数据**：一个含 CJK、控制字符、危险运算符与坏 frontmatter 的 vault 夹具，测试正是拿它们验证解析与过滤。格式化它们等于改测试输入 |
| `research/`、`scratch/` | 调研与探测产物，不是代码，且已被 `.gitignore` |
| `package-lock.json` | npm 自己管 |
| `test/smoke/records/**` | smoke 的运行记录（证据） |

### 5.3 一个纯格式化的独立提交

格式化扫过 58 个文件、约 1.27 万行。它与任何逻辑改动**分开提交**，理由是可审计性：审阅者可以用 `git show --stat` 一眼确认那一提交只动了空白与换行，而 `git blame` 只被牺牲一次。

**证据**：格式化后的树上 `verify-pack` 报 `OK`，且**整套 574 个测试通过**——已在 `/tmp` 的副本上实测（§14 命令 C）。**这不是"格式化无害"的证明**（Prettier 是语义保持的打印器这一点靠它的文档而不是靠这次抽样），所以仍按 §12 Phase 1 的顺序：先格式化，再让门禁在格式化后的树上跑一遍。

**已点名的格式敏感点**：`scripts/verify-pack.mjs` 用正则 `/name:\s*'mem_[a-z]+'/g` 扫 `lib/tools.js` 找六个注册点。该正则要求"单引号字面量"，而配置里 `singleQuote: true` 恰好保持这一点，所以它能活下来——但这是**必须原地验证**的假设，不是可以推断的结论（§12 Phase 1 的验收里含这一条）。

---

## 6. 静态检查（ESLint）

### 6.1 配置

`eslint.config.mjs`（flat config）：推荐规则集 + Node ESM globals；`ignores` 与 `.prettierignore` 同源，另加 `node_modules`、`coverage`、`test/fixtures`。

**版本同样决定数字。** 本节 43 条来自 **ESLint 10.11.0** 的推荐集（22 个文件）；同一棵树在 **ESLint 9.39.5** 下只有 **28 条 / 15 个文件**，差异全部来自 10.x 新增进推荐集的两条规则——`no-useless-assignment`（12 条）与 `preserve-caught-error`（3 条）。两条都是有价值的信号（死存储、丢失的 `cause`），所以**计划锁定 ESLint 10 而不是 9**：低一个主版本等于少两条规则，而这两类发现已经逐条分诊完毕（两条都已在下面的表里）。

### 6.2 43 条的分诊（每条要么修，要么写明理由关闭）

| 规则 | 数量 | 处置 |
|---|---|---|
| `no-undef` | 1 → **0** | **已修**：`e31fa13`（§3.6）。此类规则**不允许关闭** |
| `no-unused-vars` | 20 | **修**。含 `lib/lint.js:501` 的 `folded`、`test/search.test.js:46` 的 `BETA_DIR`、`test/smoke/*.mjs` 的 6 个未用 import。测试里的死变量同样是缺陷：它们让"这个断言依赖什么"变得不可读 |
| `no-useless-assignment` | 12 | **逐条看**。多数是"先给默认值再在 try 里覆盖"的既有写法；确实多余的就删，属于控制流的（如 `lib/transaction.js:1483/1576/1584`）在行内写明为何保留 |
| `preserve-caught-error` | 3 | **修**：`lib/paths.js:179` 与 `scripts/verify-pack.mjs:121,126` 抛症状错误时丢掉 `cause`。按第 6 条"失败必须能被诊断"，把 `{ cause }` 带上 |
| `no-control-regex` | 6 | **逐处关闭并写理由**。`lib/config.js:122`、`lib/naming.js:49`、`lib/pointer.js:125,211`、`lib/registry.js:48`、`lib/vault.js:986` 都在**剥控制字符**（文件名与 frontmatter 清洗），是刻意为之，不是笔误 |
| `no-misleading-character-class` | 2 | **关闭并写理由**：`lib/naming.js:47` 的字符类处理 CJK 与组合字符，规则对它的误报是已知的 |

关闭一律用行内 `// eslint-disable-next-line <rule> -- <为什么>`，不用配置文件全局关闭：**理由必须留在现场**。

### 6.3 与 `verify-pack` 的关系

`scripts/verify-pack.mjs` 里有一套自己的扫描与校验逻辑，它会成为 `npm run lint` 的被检查对象。两者不是替代关系：verify-pack 保证**打包契约**（哪些文件进 tarball、六个工具是否注册），ESLint 保证**代码本身**。交叉部分是"六个工具"——它由 verify-pack 的正则与 `test/pack.test.js` 的夹具共同假设，§10.3 会给这次拆分带来的改动点名。

---

## 7. 类型检查棘轮（`tsc --checkJs`）

### 7.1 为什么不"直接开"

非严格模式已经 **2,446 个 error / 27 个文件**（§3.5）。把它设成门禁等于把门禁设成红的。"修完再说"也不成立：那意味着先给 19k 行补类型标注，是一次比这次框架本身大得多的改动，而且与"最小改动、可审计"冲突。

### 7.2 先修 13 处 JSDoc 方言

5 处 `{function(...)}`（`lib/hooks.js:162,165,167,185`；`lib/transaction.js:844`）+ 8 处 `@param` 缺前置声明（`lib/hooks.js:169,172,175,176,…`）。改成 TypeScript 认得的写法（如 `{(s: string) => Promise<object>}`，或先声明 `@param {object} deps`），让这些函数的类型**重新可读**。这一步独立成一个提交，先修，不依赖棘轮。

### 7.3 棘轮分档

**复审纠错**：`tsconfig.json` 的 `include`/`files` 是根文件列表，被根文件 import 的 JS 仍会进入程序；在 `checkJs: true` 下也会报错。用九个 `include` 条目隔离检查范围的原方案不可执行。改为 `allowJs: true`、`checkJs: false`，在选定源文件头部逐一加 `// @ts-check`；[TypeScript 官方文档](https://www.typescriptlang.org/tsconfig/checkJs.html)将此作为逐文件启用 JavaScript 诊断的方式。`files` 可列这批根文件，但它本身**不是**棘轮边界。复审时用 TypeScript 5.9.3 的两文件临时夹具确认：`checkJs:true` 对被 import 的错误文件和根文件都报 TS2345；`checkJs:false` 且仅根文件 `@ts-check` 时只报根文件的 TS2345。实施须在真实仓库复测。

**逐文件实测**（TS 5.9.3、`checkJs: false`、单文件 `@ts-check`、`skipLibCheck: true`，覆盖 28 个候选文件）。opt-in 模型下的代价**远低于**全量 `checkJs` 的错误数，因为未被标记的 import 目标不再把自己的推断噪声倒进被标记的文件里：

| 档 | 文件 | 每文件 error |
|---|---|---|
| **零成本（9 个）** | `lib/git.js`、`lib/index.js`、`lib/naming.js`、`lib/paths.js`、`lib/pointer.js`、`lib/receipts.js`、`lib/registry.js`、`lib/routing.js`、`scripts/verify-pack.mjs` | **0** |
| **一档（3 个，共 3 处）** | `codex/server.mjs`（TS18047 `memory` possibly null）、`lib/search.js`（TS2741）、`scripts/run-tests.mjs`（TS2345） | 1 / 1 / 1 |
| 二档（后续按需） | `codex/prepare.mjs` 0、`lib/assets.js` 2、`lib/hot.js` 2、`lib/frontmatter.js` 3、`lib/tools.js` 3、`lib/index-db.js` 4、`lib/config.js` 5、`lib/memory.js` 5、`lib/transaction.js` 5 | 0–5 |
| 明确不进 | `lib/hooks.js` 10、`lib/brief.js` 11、`lib/lint.js` 12、`lib/capture.js` 15、`lib/vault.js` 17、`lib/distill.js` 20、`lib/pending.js` 78 | 163 |

**本轮纳入零成本的 9 个与一档的 3 个 = 12 个文件、3 处修复**（`lib/index.js` 是入口，白拿）。这比"先做 4 个"更强而成本几乎相同。

`codex/prepare.mjs` 实测 0 错，但它**第 1 行是 shebang**：标记写在 shebang 之前是硬错误（TS18026 + TS1005，本轮已实测复现）。所以"标记落在 shebang 之后"必须由测试守住，而不是写在注释里。

### 7.4 棘轮的规则

- 只允许给新的文件增加 `// @ts-check`，或提高现有检查强度。把该标记从已纳管文件移除是放宽门禁，须由仓库测试以明确名单拦住；确需移除时，同一提交修改名单并在 CHANGELOG 写明理由。
- `tsconfig.json` 用 `noEmit: true`、`allowJs: true`、`checkJs: false`、`strict: false`、`module/moduleResolution: nodenext`、`types: ["node"]`、**`skipLibCheck: true`**。
- **`skipLibCheck: true` 是必需的，不是偷懒。** 实测：不带它时 `lib/index.js`、`lib/tools.js`、`codex/server.mjs` 会在 **`node_modules/@deepseek-ai/dsh-llm/lib/types/content.d.ts` 内部**报 TS2307（找不到 module）与 TS6200（定义冲突）——那是第三方类型之间的冲突，不是本仓库的源码问题。它只跳过 `.d.ts`；**禁止**的是用它掩盖源码诊断。
- **标记集合与 `files` 集合必须一致，两个方向都要测。** `checkJs: false` 下，一个带 `// @ts-check` 但既不在 `files` 里、也不被 `files` 中任何文件 import 的文件是**静默不受检**的。这是 opt-in 模型唯一的真空洞，所以 `test/repo-hygiene.test.js` 同时断言：`files` 里每一项都带标记，且磁盘上每个带标记的 `lib/`、`scripts/`、`codex/` 文件都在 `files` 里。
- 标记必须落在 shebang **之后**（实测：写在前面是 TS18026 + TS1005 硬错误）。测试要能识破这个位置错误。
- `npm run types` 的承诺是 **opt-in 文件的诊断为零**，不是全仓 JS 类型干净。AGENTS.md 命令表要写明这个边界。若某候选文件在最终配置下清零代价过高，先缩小一档集合并记实测理由，不在计划里硬承诺原探测的九个文件全部通过。

---

## 8. 适应度函数（放进测试套件）

两个测试文件不增加**运行时**依赖；结构测试复用 Phase 1 已加入的 TypeScript 开发依赖解析 ESM AST。放进 `test/*.test.js` 是刻意的：`npm test` 会跑它们 → `prepack` 会跑它们 → CI 会跑它们。

### 8.1 `test/architecture.test.js`

**规则 A：零内部模块环。** 用 TypeScript `createSourceFile` 的 AST，从 `lib/*.js` 的静态相对 `import`、副作用 `import` 与 `export ... from` 建图，做环检测；缺失目标也失败。现状的普通 `from './x.js'` 图实测为零，新增两种语法要有红灯测试。动态 `import()` 若出现，需在同一提交明确登记边与原因；不能默默跳过。

**规则 B：分层方向。** 下表是原始 24 个模块用"最长路径分层"算法实测出来的**拆分前基线**，不是拆分后的目标表。任何模块的内部依赖目标层号必须小于自身层号；新模块未经登记失败。§10 拆分完成的同一提交里重新测量、审阅并登记新层级，不允许为了让测试绿而自动接受它推出来的所有新边。

**这条基线的测量口径要说清**（否则测试一落地就会和实测对不上）：本轮按**全部边种**建图——`import ... from` **62 条**、`export ... from` **10 条**，**没有**副作用 `import './x.js'`，也**没有**动态 `import()`。在这个完整图上：**零环**，且**每一条边都严格向下**（目标的层号小于自身层号，没有同层边）。所以"严格小于"这条规则今天成立、可以被钉住；它比"最长路径算法"的输出更严，是有意为之——横向耦合同样应当是一次需要显式登记的决定。

| 层 | 模块 |
|---|---|
| L0 | `config`、`naming`、`paths`、`pointer` |
| L1 | `assets`、`frontmatter`、`git`、`registry`、`routing` |
| L2 | `distill`、`index-db`、`receipts` |
| L3 | `pending`、`search`、`transaction` |
| L4 | `vault` |
| L5 | `lint`、`memory` |
| L6 | `capture`、`hot` |
| L7 | `brief` |
| L8 | `hooks`、`tools` |
| L9 | `index` |

**规则 C：LOC 预算。** 每文件一个预算值，超了即失败。下表是**格式化前**的参考数据，不得直接复制为 Phase 2 的门禁；Phase 1 的纯格式化提交后，以实际行数按 **预算 =（行数 + 30）向上取到 50 的整数倍** 重新生成并人工核对。四个大文件按同一规则登记为已批准债务，不能让门禁一安装就因格式化而红。

| 文件 | 现值 | 预算 |
|---|---|---|
| `lib/index-db.js` | 1,977 | 2,050 |
| `lib/transaction.js` | 1,918 | 1,950 |
| `lib/tools.js` | 1,686 | 1,750 |
| `lib/capture.js` | 1,684 | 1,750 |
| `lib/vault.js` | 1,476 | 1,550 |
| `lib/memory.js` | 1,225 | 1,300 |
| `lib/lint.js` | 1,130 | 1,200 |
| `lib/pending.js` | 1,005 | 1,050 |
| `lib/brief.js` | 993 | 1,050 |
| `lib/frontmatter.js` | 967 | 1,000 |
| `lib/hooks.js` | 950 | 1,000 |
| `lib/distill.js` | 742 | 800 |
| `lib/assets.js` | 520 | 550 |
| `lib/hot.js` | 476 | 550 |
| `lib/registry.js` | 406 | 450 |
| `lib/routing.js` | 403 | 450 |
| `lib/receipts.js` | 353 | 400 |
| `lib/paths.js` | 251 | 300 |
| `lib/config.js` | 243 | 300 |
| `lib/pointer.js` | 230 | 300 |
| `lib/git.js` | 214 | 250 |
| `lib/naming.js` | 210 | 250 |
| `lib/search.js` | 130 | 200 |
| `lib/index.js` | 116 | 150 |

未列出的新文件默认预算 **600**，但新文件仍必须先登记层级。超预算时拆文件，或在同一个提交里抬高预算并在 CHANGELOG 说明；不能删解释性注释来凑数。Phase 4 拆分后同步收紧 `tools.js` façade 预算并为三个新文件登记预算。

### 8.2 `test/repo-hygiene.test.js`

- **README 双语对哈希**：按**文件字节**计算 git blob SHA-1：`sha1(Buffer.concat([Buffer.from('blob ' + bytes.length + '\0'), bytes]))`，与 `README.i18n.yaml` 的两个值比对；用 `git hash-object README.md README.zh.md` 交叉验证一次。不得把 Unicode 字符数当作字节数。
- **命令表不漂移**：扫描 `AGENTS.md` 与两份 README 里出现的每个 `npm run <name>`，断言 `package.json` 的 `scripts` 里确有同名项。§11 的两张表因此不会在半年后指向一个已删除的命令。
- **类型 opt-in 名单**：断言 §7 中受检文件保留 `// @ts-check`；新增受检文件须在同一名单登记，避免删一行注释就悄悄退出门禁。

### 8.3 为什么不是 ESLint 插件

这些是**模块图与仓库约定**层面的性质，ESLint 的逐文件规则不适合作为整仓模块图的唯一来源。测试直接复用类型检查已需要的 `typescript` 开发依赖，不另加解析器或运行时依赖；README 哈希和命令表仍用 Node 标准库。

---

## 9. 运行时可观测性（shipped code）

### 9.1 `lib/debug.js` 的契约

```js
createDiagnostics({ logger, capacity = 200, now = () => new Date() }) -> {
  event(name, fields),   // 记一条结构化事件；永不抛、永不同步 IO
  snapshot(),            // 返回 { window, events } 的独立副本，供 mem_admin 导出
  size(),
}
recordDiagnostic(diagnostics, name, fields) -> void  // 包住可注入的诊断实例，调用方也不因它抛错
```

- **通道 A（人）**：DSH 侧使用实测可调用的 `ctx.logger('obsidian-mem')`，Codex MCP 侧使用其现有 stderr sink；单个真实失败仍走既有 `warn` 路径（`hooks.js` 的 `ctx.logger.warn`），不把既有失败降级。
- **通道 B（agent）**：每个插件/服务实例一个进程内有界环形缓冲，默认容量 200 条，由 `mem_admin(action="diagnostics")` 读取。DSH 的 `apply` 与 Codex 的 `openMemory` 都创建并传入同一契约的实例；后者没有 `ctx`。事件环在宿主重启后归零，历史故障应查看持久 pending jobs、receipt 与 vault 历史。
- **`DSH_OBSIDIAN_MEM_DEBUG=1`**：把每条净化后的 trace 额外以 **`info`** 级发射一次。§3.3 在已安装宿主中找到两个 exporter，均接收 `info` 而丢弃 `debug`；这是基于该版本的测量，不能推断其他宿主或后续版本的 exporter 全集。Codex MCP 侧只有在同一开关打开时才写 stderr，绝不写协议 stdout。
- **默认完全静默**：env 未设时，新事件不产生任何日志输出；既有 warn 原样保留。环里的采集不写文件、不改变调用结果。
- **字段收敛**：`event` 只接受固定事件名和 `projectId / txId / jobId / outcome / attempts / ms / code` 的标量 allowlist；`code` 为受限机器码，拒绝自由文本、异常 `message`、路径、title、body、prompt、模型输出及嵌套对象。先净化并复制，再写环与可选 info 日志。`event`、日志失败都不得打断主流程；`snapshot` 返回独立副本。每条含 ISO `at` 与单调 `seq`，用以判断覆盖窗口。

### 9.2 提级点（现在静默的那几处）

每一处都是"今天出问题时无法回答的问题"：

| 事件 | 今天为什么答不出来 |
|---|---|
| capture 跳过或拒绝的原因（容量、路由、时长、去重） | 238 个 `catch` 里的静默分支之一 |
| distill 跳过或产出空结果的原因 | 同上 |
| index 打开或就绪失败 | 只有 `hooks.js:402` 一处 `warn`，无上下文 |
| bind 拒绝的 reason/code | 只作为返回值，不落任何轨迹 |
| 当前进程中的队列 job 结局（applied / deferred / refused / 重试次数） | 现有工具可读持久 job/receipt，但没有按时间排列的当前进程事件 |
| 事务恢复导致的写入拒绝（unresolved / `recovery-required`） | 现有 service 只把异常传回工具调用；详细的前滚/回滚仍由持久事务记录证明，不在本轮跨多层传递观察回调 |
| 简报注入的决策（注入了没有、多长、为何没注入） | 直接影响用户看到的行为，却零痕迹 |
| skill 同步结局 | 同上 |

### 9.3 `mem_admin` 的新 action

`action: "diagnostics"` → `{ window: { capacity, size, oldestSeq, newestSeq, dropped }, events: [...] }`。空环时 `oldestSeq/newestSeq` 为 `null`，`dropped` 为自实例创建以来被覆盖的条数。每条只含 `seq / at / event / projectId / txId / jobId / outcome / attempts / ms / code` 中适用字段。该动作无参数、不读 vault、不写文件；绑定失败的开发者也能取到当前进程诊断。它与现有 `jobs` 一样属于该插件实例的管理视图，可能含多个项目的机器标识；README 须说明这个信任范围。

### 9.4 隐私红线与哨兵测试

沿用 `test/smoke/README.md` 已经写明的口径（"记录里不含提示词、模型输出正文与笔记正文"）。**哨兵测试**：喂可识别的正文（如 `SENTINEL-BODY-<random>`）走写入与提炼的无密钥测试路径，再故意以 `body/title/message/path/prompt` 字段调用 `event`，断言 `snapshot()` 与 DEBUG 日志序列化后均不含哨兵或这些字段名。先证明把正文写入环的变异会让测试失败。

### 9.5 工具面不变，但动作枚举变了

`mem_admin` 的动作从 6 个变 7 个——这是一次**用户可见的接口变化**，因此：

- `README.md` 与 `README.zh.md` **都要改**（第 7 条），改完重登记 `README.i18n.yaml` 的两个 blob hash；
- `TOOL_PARAMETERS.mem_admin.action`、`ADMIN_ACTION_PARAMETERS`、封闭的 `ADMIN_OUTPUT.oneOf`、`createMemoryServices.admin` 四处同步；`test/tools.test.js` 要用真实 DSH tool seam 验证输出，不能只直调 service；
- `codex/server.mjs` 的输入 schema 由 `TOOL_PARAMETERS` 派生，但它直接调用 service，**不经过** `forwardAdminArguments` 或 DSH 的输出校验。更新 Codex 侧描述，并在 `test/codex-mcp.test.js` 做真实 `tools/call` 验证；无额外参数的动作必须在 service 入口也拒绝无关参数，不能只靠 DSH 适配层。

---

## 10. 结构：拆 `tools.js`

### 10.1 为什么只拆这一个

§3.2 的实测否掉了"大搬家"：`lib/` 零环、分层干净、四个大文件各自只依赖 2–10 个模块，且 `index-db`/`transaction`/`memory` 内部有 10–16 个分节——**大是内聚的结果，不是缠绕的结果**。真正装了**三件事**的只有 `tools.js`：

| 行号 | 内容 | 性质 |
|---|---|---|
| 60–115 | `TOOL_NAMES` | 对外契约（名字） |
| 116–637 | `TOOL_PARAMETERS` | 对外契约（schema，约 520 行） |
| 638–860 | `registerTools` | 适配层（把服务挂到宿主 tools 运行时） |
| 861–1686 | `createMemoryServices` | 组装层（约 826 行，服务图与缓存） |

### 10.2 façade + 再导出

拆成 `lib/tool-schema.js`（名称、参数 DSL、输出 schema 与动作参数规则）、`lib/tool-registry.js`（六个 DSH 工具定义和参数转发）、`lib/services.js`（六个服务、绑定、索引与投影），**`lib/tools.js` 保留为只再导出 `TOOL_NAMES`、`TOOL_PARAMETERS`、`registerTools`、`createMemoryServices` 的 façade**。跨文件共享的选项常量只在 schema 模块定义一份；不得为了拆分复制参数表或输出 schema。

这个模式在本仓库已有先例且写明了理由：`lib/vault.js` 的 "Task 7: the transaction engine and the receipt store are re-exported here too, so every importer keeps going through this module." 采用它意味着：`codex/server.mjs` 的导入、8 个测试文件的导入、`dsh.plugin.json` 的入口**全都不动**。

**`e31fa13` 的准确教训**：`export { X } from './x.js'` 只建立导出，**不**在当前模块建立局部绑定；仅当 façade 自己使用 `X` 时才另行 `import`。本轮 façade 没有本地使用，故只再导出即可。拆分测试须覆盖这个绑定语义，避免把无必要 import 当成安全措施。

### 10.3 必须一起改的两处门禁（提前点名）

| 位置 | 为什么会被这次拆分打破 | 改法 |
|---|---|---|
| `scripts/verify-pack.mjs` 的 `REGISTRATION_SITE` 扫描（读 `lib/tools.js` 找六个 `name: 'mem_x'`） | 注册点会搬到 `lib/tool-registry.js`，façade 里不再有它们 | 扫新文件，并核对 façade 四个再导出 |
| `test/pack.test.js` 的合成注册文件 | 同上 | 写到 `lib/tool-registry.js`，加缺一个 façade 再导出的反例 |

这两处**是门禁自身**，所以拆分提交的验收就是"门禁在改动后依然绿"，没有第三条路。

---

## 11. 文档：`AGENTS.md` 只加两张表

第 3 项的病因是**散文太多**，所以这一节刻意写少：

**表 1：命令表。** `npm run check` / `check:fast` / `hooks:install` 各一行，写清"什么时候用它"与"它到底跑了什么"。原来的五条手写命令序列合并为一条 `npm run check`。

**表 2："真相在哪"。** 症状 → 先看哪里。至少含：

| 症状 | 先看 |
|---|---|
| 一次写入没落地或落到别处 | `lib/transaction.js` + `test/transaction.test.js`；先看 `mem_admin(action="jobs")` 与诊断环 |
| 简报没注入，或注入了但不对 | `lib/brief.js` + `lib/hooks.js`；看诊断环里 `brief` 事件的 `outcome` |
| 提炼没产出 | `lib/distill.js`；看诊断环里 `distill` 事件 |
| 队列不动了 | `lib/pending.js`；`mem_admin(action="jobs")` |
| 复制过的 checkout 里 `codex-mcp` 测试失败 | `.mcp.json` 是生成物且含绝对路径——`node codex/prepare.mjs`（§3.7） |
| 打包契约 | `scripts/verify-pack.mjs`；`npm run prepack` |
| 宿主 seam（事件、`ctx.llm`、注入时机） | `docs/p0-compatibility.md`（先读它，别信 `lib/` 里的注释） |

同时更新 house style 一段：明确 **runtime dependencies**（仍只有 `schemastery`、`yaml`）与 **devDependencies**（新增 eslint、@eslint/js、globals、prettier、typescript、@types/node）的边界，使"加运行时依赖需要理由"这条规则与新现实一致。

---

## 12. 实施阶段与验收

每个阶段都以"门禁绿 + 明确证据"结束。**阶段之间可以单独提交与单独审阅**，这是本设计的核心可审计性保证。

| Phase | 内容 | 验收（命令 → 期望） |
|---|---|---|
| **0** ✅ 已完成 | 修 `lib/vault.js:504` 的 `TransactionError` 未绑定缺陷 + 回归测试 | 提交 `e31fa13`；`npm test` → **574 / 0 fail**；`npm run prepack` → `verify-pack: OK`；tarball 仍 33 文件。修复前该测试以 `ReferenceError: TransactionError is not defined`（`lib/vault.js:504`）失败 |
| **1** | 锁定开发依赖与格式范围 → 纯格式化独立提交 → ESLint/JSDoc 分诊 → 逐文件类型检查 → npm scripts、真实 tarball 校验和 CI | 格式化后 `npm run prepack` 仍 `OK`；注册点仍为 6；`npm run lint`、`npm run types`、`npm run check` 全绿；类型反例证明 import 的非 opt-in 文件不报诊断 |
| **2** | 按格式化后树建立结构/文档适应度测试 → `verify-changelog.mjs` → 暂存 blob hook | `npm test` 全绿；故意增加反向边与 README hash 漂移时变红；部分暂存不产生假绿；记录 `check:fast` 实测时间 |
| **3** | `lib/debug.js` + §9.2 八类服务/宿主边界事件 + `mem_admin(action="diagnostics")` + DSH/Codex 真实工具测试 + 哨兵测试 + README 双语对 | 故意把正文写进事件时测试变红；双语 hash 检查绿；默认没有新的日志；重启后的环为空这一边界写进文档 |
| **4** | 拆 `tools.js` → `tool-schema` / `tool-registry` / `services`，façade 保留；同步打包验证与结构基线 | `npm run check` 全绿；真实包内含三个新模块；六工具仍可注册；facade 四个导出保持；预算与层级按新图登记 |
| **5** | `AGENTS.md` 两张表 + house style + CHANGELOG 与证据更新 | 命令表检查绿；Unreleased 记载实际验证范围和 CI 最低 Node 的结果 |

**顺序的不可交换性**：Phase 1 必须在 Phase 2–4 之前（后面的每一刀都要由前面的门禁验证）；Phase 4 必须在 Phase 1 之后（否则格式化的 diff 与结构的 diff 叠在一起，无法审阅）。

---

## 13. 风险与未解问题

| # | 风险 | 影响 | 处理 |
|---|---|---|---|
| R1 | 格式化提交与进行中的分支冲突 | 一次 rebase | 单人开发，接受；该提交必须**孤立**，不与逻辑改动混合 |
| R2 | `verify-pack` 的注册点正则对格式敏感 | 门禁自己变红 | 已实测格式化后仍 `OK`（§14-C）；拆分时按 §10.3 同步改 |
| R3 | 原探测的一档 63 个错误数不能在最终配置下复现 | 错误估算可能失真 | 用 `checkJs:false` + `@ts-check` 逐文件复测；清零成本过高时缩小首档并写明实测范围 |
| R4 | 43 条 ESLint 里有 8 条是"关掉并写明理由" | 有可能掩盖真问题 | 关闭只允许行内 + 必写理由；`no-undef` 这类**不允许关闭** |
| R5 | 预算表可能被当作硬墙，于是有人删注释来凑数 | 伤害注释质量（本仓库注释是资产） | §8.1 末段写明"抬预算 + CHANGELOG 说明"是合法动作 |
| R6 | 诊断环有泄漏正文的风险 | 隐私 | 哨兵测试 + 只允许结构化字段 + 沿用 smoke 的既有口径（§9.4） |
| R7 | 复制过的 checkout 上 `codex-mcp` 测试失败 | 误判为回归 | 已定因（§3.7）并进"真相在哪"表 |
| R8 | CI 在 Node 22.22.2 上可能因 `node:sqlite`/FTS5 行为与 25.x 不同而失败 | 下界声明被证伪（这其实是**好事**） | 若失败，按第 5 条：改 `engines.node` 前必须**实测**新下界并说明测了什么 |
| **U1** | 未验证：本机没有 `22.22.2` 可执行文件，所以"CI 在 22.22.2 上绿"**尚未测过** | 下界声明在 CI 首次运行前仍是未验证的 | 明确写进 CHANGELOG 的未验证清单，直到 CI 首次在 22.22.2 上跑绿 |
| **U2** | 未验证：Prettier 对 58 个文件的改动是否**逐字节**只动格式 | 理论上可能改到语义（实际不会，但这是推理不是测量） | 以"格式化后 574 全绿 + verify-pack OK"作为**抽样证据**，并按第 6 条写成抽样而不是证明 |
| **U3** | 适应度测试仍读取工作区，部分暂存会产生错位 | 可能把工作区通过误报成暂存通过 | 受影响输入同时有暂存与未暂存改动时明确拒绝；lint/format 始终读取暂存 blob；以夹具测试证明 |
| **U4** | 诊断环是内存态，重启后窗口消失 | 排障时可能找不到上一进程的事件 | README 写明边界；持久状态仍以 `jobs`、收据与 vault 历史为准（§9.3） |
| **U5** | 未解：`chmod` 类测试（`receipt-store-unavailable`、read-only 目录）在 GitHub Actions 的 runner 上是否可复现 | 那几条会被 `t.skip`（它们已对 `getuid() === 0` 做了跳过） | CI 首次运行后按实际输出记录；若被跳过，在 CHANGELOG 写明"CI 上未覆盖" |

---

## 14. 附录：本次全部测量命令

原始探测脚本跑在 `scratch/`（该目录按 `.gitignore` 不入库），下面给出可重跑的内联形式。

**A. 结构与分层**（§3.2 / §8.1）：解析 `lib/*.js` 的 `from './x.js'`，做环检测、最长路径分层、上行边检查；再 `wc -l lib/*.js | sort -rn`。

**B. 格式化爆炸半径**（§3.4）

```sh
probe_dir=$(mktemp -d)
git archive HEAD | tar -x -C "$probe_dir"
cd "$probe_dir"
cat > .prettierrc.json <<'EOF'
{ "semi": false, "singleQuote": true, "printWidth": 100, "arrowParens": "always", "trailingComma": "all" }
EOF
git init -q && git add -A && git -c user.email=a@b -c user.name=p commit -qm base
npx --yes prettier@3.9.9 --write "lib/**/*.js" "test/**/*.js" "test/**/*.mjs" "scripts/**/*.mjs" "codex/**/*.mjs"
git diff --numstat | awk '{a+=$1; r+=$2; f++} END{print f, a, r}'
```

**C. 格式化后的门禁**（§5.3 的证据）：在已格式化的副本里跑 `node scripts/verify-pack.mjs`（→ `verify-pack: OK`），再跑
`test_dsh_home=$(mktemp -d); DSH_HOME="$test_dsh_home" node --test test/*.test.js`（→ 574 pass / 0 fail；临时目录按本机临时文件策略清理）。

**D. 类型检查基线**（§3.5）：`npm i -D typescript @types/node` 后
`npx tsc --noEmit --allowJs --checkJs --target esnext --module nodenext --moduleResolution nodenext --skipLibCheck --types node --pretty false lib/*.js`（按文本诊断中的 `TSxxxx` 聚合错误码；TypeScript CLI 没有这里可用的 `--format json` 选项）。

**E. ESLint 基线**（§3.6）：`npm i -D eslint @eslint/js globals` 后用 flat config 跑 `npx eslint lib scripts codex test --format json`，按 `ruleId` 聚合。

**F. 宿主日志阈值**（§3.3）：在 cordis 的 `src/logger.ts` 看 154–156 行的 `targetLevel` 与 `if (targetLevel < level) continue`；再在已安装宿主里枚举 exporter：
`grep -rn "logger.exporter\|\.exporter(" <dsh>/node_modules/@deepseek-ai/*/lib/*.js`。

**G. 新鲜 clone 等价性**（§3.7）：把仓库 rsync 到 `/tmp/fresh`，删掉 `codex/marketplace/plugins/dsh-obsidian-mem/.mcp.json`（生成物、含机器绝对路径），再跑整套测试 → 574 pass。
