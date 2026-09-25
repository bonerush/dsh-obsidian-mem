# dsh-obsidian-mem 工程框架设计文档

- **日期**：2026-09-25
- **状态**：设计已获用户逐段确认（骨架、debug 读者、格式化宽度、发行工具、结构拆分边界），待实施计划
- **路径**：`docs/superpowers/specs/2026-09-25-engineering-harness-design.md`
- **前置提交**：`e31fa13`（Phase 0 的真缺陷修复，见 §12）
- **一句话**：给这个仓库装上一套**可执行的**工程骨架——门禁自动化、运行时可见、结构约束可度量——让 agent 开发者与独立开发者不必先读 200KB 散文才知道"改这里会不会踩雷"。

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
| G1 | 一条命令等价于"整套门禁"，本地与 CI 跑的是同一条 | `npm run check` 在干净树与 CI 上都绿；CI 不引入本地没有的步骤 |
| G2 | 提交前 5 秒内挡住明显错误 | `.githooks/pre-commit` 只对改动文件跑 lint/format，加两个适应度测试；实测耗时须 < 5s |
| G3 | 运行时失败可在**不重跑宿主**的前提下被 agent 取到 | `mem_admin(action="diagnostics")` 返回结构化事件环；隐私哨兵测试证明正文不泄漏 |
| G4 | 结构不会在无人察觉时继续膨胀 | `test/architecture.test.js` 对 10 层分层表 + LOC 预算失败即红；实测当前状态为绿 |
| G5 | agent 冷启动只需读 `AGENTS.md` 的两张表 | `npm run` 命令表与"真相在哪"表；`test/repo-hygiene.test.js` 断言 `AGENTS.md` 与两份 README 里出现的每个 `npm run <name>` 都在 `package.json` 的 `scripts` 里存在 |
| G6 | 双语文档与 CHANGELOG 的既有约定由机器守 | blob hash 检查进入 `npm test`；`lib/` 改动而 Unreleased 未动则在 pre-commit/CI 失败 |

---

## 2. 决策记录

| # | 决策 | 值 | 决策者 |
|---|---|---|---|
| D1 | 骨架 | **标准技术栈**（ESLint + Prettier + `tsc --checkJs` + GitHub Actions），而非"仓库内 harness"或"seam 探针台" | 用户 |
| D2 | debug 读者 | **两者都要**：默认走 `ctx.logger` 分级日志，另存会话内诊断环供 `mem_admin` 导出 | 用户 |
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

辅助事实：作用域内 38,730 行，均值 43.0 字符，最长 564 字符（注释）；**2,014 行超过 100 字符**、803 行超过 120。Prettier **不重排注释**，所以长注释不会被切开，实际改动集中在代码行。现有代码与候选配置**没有冲突**：单参箭头函数不带括号的写法出现 **0** 次（`arrowParens: always` 无副作用），行尾逗号已是既有风格（2,177 行以逗号结尾）。

### 3.5 `tsc --checkJs` 基线

非严格模式、`allowJs + checkJs + nodenext`、`@types/node` 就位：**2,446 个 error / 27 个文件**。

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
  "format":        "prettier --write .",
  "format:check":  "prettier --check .",
  "types":         "tsc --noEmit",
  "check":         "npm run lint && npm run format:check && npm run types && npm run prepack",
  "check:fast":    "node scripts/check-staged.mjs",
  "hooks:install": "node scripts/install-hooks.mjs",
  "prepack":       "npm test && node scripts/verify-pack.mjs"
}
```

`check` 通过 `npm run prepack` 复用发布闸门，**不复制**它的内容：发布时跑的与提交前跑的是同一条链。`check` 包含 `prepack` 是结构性的，不是约定。

### 4.2 时机与范围

| 时机 | 命令 | 内容 | 目标耗时 |
|---|---|---|---|
| 提交前 | `.githooks/pre-commit` → `npm run check:fast` | 对 `git diff --cached` 的 `.js/.mjs` 跑 eslint + `prettier --check`；再跑两个适应度测试；再跑 CHANGELOG 门 | < 5s |
| 手动 / CI / 发布 | `npm run check` | lint → format:check → types → prepack(test + verify-pack) | ~45s |
| CI 附加 | `.github/workflows/ci.yml` | `npm run check` + tarball 文件数核对 + Node 矩阵 | ~2min |

`check:fast` 有一条**已知且写明的**限制：它对工作区文件运行，不区分"暂存内容"与"工作区内容"，所以部分暂存（`git add -p`）时它检查的是工作区版本。

### 4.3 CI

`.github/workflows/ci.yml`，触发 `push` 与 `pull_request`：

- `strategy.matrix.node: ['22.22.2', '24.x', 'node']`——`22.22.2` 是 `engines.node` 的下界（AGENTS.md 第 5 条：那是**测出来**的最低带 FTS5 的版本，不是估计值），必须实测它，否则下界只是一个声明。
- 步骤：`npm ci` → `npm run check` → 核对 tarball（把 AGENTS.md 里靠人肉的那一步变成机器检查；当前期望 **33** 个条目）。核对用
  `npm pack --ignore-scripts --pack-destination "$(mktemp -d)"`：**`--ignore-scripts` 不是可选项**——裸 `npm pack` 会重入 `prepack`，而 `prepack` 会再跑一遍整套测试。AGENTS.md 已经在 dry-run 那条注里写明这件事，但把检查搬进 CI 时最容易漏掉它。
- **无 secrets**：`npm test` 不需要任何密钥（§3.1），所以工作流没有密钥面。smoke（需要 `DEEPSEEK_API_KEY`）**不进 CI**，它仍是手动、带独立 profile 的验证。
- 缓存 `~/.npm`；不使用需要写权限的 action。

### 4.4 `.githooks`：不自动改 git config

AGENTS.md 第 1 条的措辞是"任何脚本都不得增删改用户的 `cordis.patch.yml`"，其精神是**不做用户没要求的配置改动**。因此：

- `.githooks/pre-commit` 入库（普通文件，可审阅）。
- `npm run hooks:install` 是**显式 opt-in**：它只做一件事——`git config core.hooksPath .githooks`——并在改动前后各打印一次该键的值。
- `npm run check` **不安装任何东西**，也不写 git config。

### 4.5 CHANGELOG 门（替代 changesets，D4）

`scripts/verify-changelog.mjs --base <ref>`：若 `lib/` 下有文件改动而 `CHANGELOG.md` 未在同一次 diff 里改动，则失败，并打印"该往 `## Unreleased` 的哪一节写"。

- 它**不在** `npm run check` 里，因为它需要一个基线引用，否则在干净树上是空洞的通过。位置：pre-commit（base=`HEAD`）+ CI（base=PR base SHA 或 push 的 before SHA）。
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

`tsconfig.json` 的 `include` **只列已经干净的文件**。棘轮只许变严。

| 档 | 文件（当前 error 数） | 小计 |
|---|---|---|
| **一档（本轮）** | `lib/paths.js` 2、`lib/git.js` 6、`lib/search.js` 6、`lib/routing.js` 6、`lib/index.js` 9、`lib/config.js` 10、`scripts/run-tests.mjs` 9、`scripts/verify-pack.mjs` 13、`codex/prepare.mjs` 2 | **63** |
| 二档（后续按需） | `lib/registry.js` 14、`lib/assets.js` 15、`lib/pointer.js` 18、`lib/hot.js` 24、`lib/receipts.js` 30 | 101 |
| 明确不进 | `index-db` 394、`capture` 349、`transaction` 270、`tools` 256 | 1,269 |

一档的选取标准是"被依赖最多 + 错误最少"：`paths.js` 被 11 个模块依赖、只有 2 个 error，先让它干净带回的收益最大。`lib/index.js` 是入口，9 个 error 里多数来自它对松散 JSDoc 的传递依赖，修完顺带让入口的类型变准。

### 7.4 棘轮的规则

- 只允许**往 `include` 里加**文件（且加进去必须当场干净），或**减少**已列文件里的 error。二者都让门禁更严。
- 想从 `include` 里移除一个文件，必须在提交信息里说明，并由 CHANGELOG 记录——因为那是**放宽**门禁。
- `tsconfig.json` 用 `noEmit: true`、`allowJs: true`、`checkJs: true`、`strict: false`（与当前错误数一致，不装作严格模式）。
- **`npm run types` 的作用域就是这个棘轮**：它读 `tsconfig.json` 的 `include`，所以"`npm run types` → 0 error"指的是**已登记的文件**为 0，不是全仓为 0。这一点必须写在 `AGENTS.md` 的命令表里，否则下一个人会把棘轮误读成"全仓类型干净"。

---

## 8. 适应度函数（放进测试套件）

两个**零依赖**的测试文件。放进 `test/*.test.js` 是刻意的：`npm test` 会跑它们 → `prepack` 会跑它们 → CI 会跑它们，**它们不可能被忘掉**。

### 8.1 `test/architecture.test.js`

**规则 A：零 import 环。** 解析 `lib/*.js` 的 `from './x.js'`，做环检测。现状实测为零。

**规则 B：分层方向。** 下表是 §3.2 用"最长路径分层"算法**实测**出来的，不是手写估计。规则是：任何模块的 import 目标层号必须小于等于自身层号；表里没有的模块直接失败（新增模块必须在此表登记，即"必须有人做一次决定"）。

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

**规则 C：LOC 预算。** 每文件一个预算值，超了即失败。规则是可计算的：**预算 =（当前行数 + 30）向上取到 50 的整数倍**，留出约 3%–15% 的余量；四个大文件按同一规则登记为**已批准债务**，没有额外宽限。

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

未列出的新文件默认预算 **600**。超预算时的正确动作是**拆文件**，或者在同一个提交里抬高预算并在 CHANGELOG 说明——预算是"必须有人做一次显式决定"的机制，不是不可逾越的墙。这一点必须写明，否则下一个人会以为预算是硬的，然后去删注释来凑数。

### 8.2 `test/repo-hygiene.test.js`

- **README 双语对哈希**：用 `node:crypto` 自己算 git blob 的 sha1（`sha1('blob ' + len + '\0' + content)`，**不依赖 git 二进制**，因此 CI 与本地同解），与 `README.i18n.yaml` 里记录的两个值比对。这把第 7 条从"记得跑 `git hash-object`"变成"忘了就红"。
- **命令表不漂移**：扫描 `AGENTS.md` 与两份 README 里出现的每个 `npm run <name>`，断言 `package.json` 的 `scripts` 里确有同名项。§11 的两张表因此不会在半年后指向一个已删除的命令。

### 8.3 为什么不是 ESLint 插件

这三条都是**模块图与仓库约定**层面的性质，ESLint 的规则模型（AST 节点）表达不了模块图。用 80 行零依赖脚本解决，与 `scripts/verify-pack.mjs` 的既有做法同源，也比引入一个自定义插件少一层维护面。

---

## 9. 运行时可观测性（shipped code）

### 9.1 `lib/debug.js` 的契约

```js
createDiagnostics({ logger, capacity = 200 }) -> {
  event(name, fields),   // 记一条结构化事件；永不抛、永不同步 IO
  snapshot(),            // 返回事件数组（副本），供 mem_admin 导出
  size(),
}
```

- **通道 A（人）**：`ctx.logger('obsidian-mem')`。级别按 cordis 语义使用；**单个真实失败仍走 `warn`**（与今天 `logWarning` 的行为一致，不改变用户已经依赖的可见性）。
- **通道 B（agent）**：进程内**有界环形缓冲**，默认容量 200 条，**永远采集**（有界、结构化、无正文，成本可忽略），由 `mem_admin(action="diagnostics")` 读取。
- **`DSH_OBSIDIAN_MEM_DEBUG=1`**：把每条 trace 额外以 **`info`** 级发射一次。**为什么是 info 而不是 debug**：§3.3 实测宿主唯一 exporter 的阈值是 `default: 2`，而 `targetLevel < level` 就丢弃——`debug`(3) 必被丢弃，`info`(1) 不会。这是一个**基于测量**的选择；若宿主将来改变阈值，这条注释要跟着改。
- **默认完全静默**：env 未设时，日志发射面与今天**完全一致**（即只有既有的 9 处 `warn`）。环里的采集不产生任何输出、不写文件、不改行为。

### 9.2 提级点（现在静默的那几处）

每一处都是"今天出问题时无法回答的问题"：

| 事件 | 今天为什么答不出来 |
|---|---|
| capture 跳过或拒绝的原因（容量、路由、时长、去重） | 238 个 `catch` 里的静默分支之一 |
| distill 跳过或产出空结果的原因 | 同上 |
| index 打开或就绪失败 | 只有 `hooks.js:402` 一处 `warn`，无上下文 |
| bind 拒绝的 reason/code | 只作为返回值，不落任何轨迹 |
| 队列 job 结局（applied / deferred / refused / 重试次数） | 跨进程重启后无从追溯 |
| 事务恢复（rolled back / rolled forward / unresolved） | 只在 vault 的 `_history` 里留痕，插件侧无轨迹 |
| 简报注入的决策（注入了没有、多长、为何没注入） | 直接影响用户看到的行为，却零痕迹 |
| skill 同步结局 | 同上 |

### 9.3 `mem_admin` 的新 action

`action: "diagnostics"` → `{ window: { capacity, size, since }, events: [...] }`。**只返回结构化字段**：`at / event / projectId / txId / jobId / outcome / ms / code`，不含笔记正文、不含提示词、不含模型输出。

### 9.4 隐私红线与哨兵测试

沿用 `test/smoke/README.md` 已经写明的口径（"记录里不含提示词、模型输出正文与笔记正文"）。**哨兵测试**：喂一个可识别的正文（如 `SENTINEL-BODY-<random>`）走完整条写入与提炼路径，然后断言 `snapshot()` 序列化后**不含**该串，也不含任何 `title`/`body` 字段名。这条测试的意义是：将来有人为了"更好排障"往事件里塞正文时，测试会红。

### 9.5 工具面不变，但动作枚举变了

`mem_admin` 的动作从 6 个变 7 个——这是一次**用户可见的接口变化**，因此：

- `README.md` 与 `README.zh.md` **都要改**（第 7 条），改完重登记 `README.i18n.yaml` 的两个 blob hash；
- `test/tools.test.js` 里断言动作枚举的那条要同步；
- `codex/server.mjs` 的参数 schema 由 `TOOL_PARAMETERS` 派生（`test/codex-mcp.test.js` 会盯住），所以 Codex 侧自动跟随——这正是当初让两侧共用同一份 schema 的收益。

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

拆成 `lib/tool-schema.js`（`TOOL_NAMES`/`TOOL_PARAMETERS`）、`lib/tool-registry.js`（`registerTools`）、`lib/services.js`（`createMemoryServices`），**`lib/tools.js` 保留为 façade 并再导出这四个名字**。

这个模式在本仓库已有先例且写明了理由：`lib/vault.js` 的 "Task 7: the transaction engine and the receipt store are re-exported here too, so every importer keeps going through this module." 采用它意味着：`codex/server.mjs` 的导入、8 个测试文件的导入、`dsh.plugin.json` 的入口**全都不动**。

**并附带一条刚学到的教训**：`e31fa13` 修的缺陷正是"只再导出、没 import"。所以 `lib/tools.js` 作为 façade **必须 import 它要再导出的名字**（而不是只写 `export { … } from …`）——否则下一个人会再踩一次同一个坑。新 façade 的注释要写明这一点。

### 10.3 必须一起改的两处门禁（提前点名）

| 位置 | 为什么会被这次拆分打破 | 改法 |
|---|---|---|
| `scripts/verify-pack.mjs` 的 `REGISTRATION_SITE` 扫描（读 `lib/tools.js` 找六个 `name: 'mem_x'`） | 注册点会搬到 `lib/tool-registry.js`，façade 里不再有它们 | 扫新文件 |
| `test/pack.test.js`（把 `name: 'mem_x',` 写进合成的 `lib/tools.js`，第 70/172/196/209 行附近） | 同上 | 写到 `lib/tool-registry.js` |

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
| **1** | Prettier（一个纯格式化提交）→ ESLint 分诊 → 13 处 JSDoc 方言 → tsc 一档 → npm scripts → CI → `.githooks` | 格式化后 `npm run prepack` 仍 `OK` 且 574 全绿（已在副本实测，§14-C）；`verify-pack` 的注册点正则仍匹配 6 个；`npm run lint` → 0 error；`npm run types` → 0 error；`npm run check` → 全绿；`check:fast` 实测 < 5s |
| **2** | 两个适应度测试 + `verify-changelog.mjs` | `npm test` 全绿（新测试在**当前**树上必须绿，否则预算表就是错的）；故意加一条 L1→L3 的 import，确认它变红，再撤回 |
| **3** | `lib/debug.js` + 8 类提级点 + `mem_admin(action="diagnostics")` + 哨兵测试 + README 双语对 + `README.i18n.yaml` 重登记 | 哨兵测试在"故意往事件里塞正文"时变红（先证明它会红）；哈希检查绿；默认静默：env 未设时既有的 9 处 `warn` 之外无新输出 |
| **4** | 拆 `tools.js` → `tool-schema` / `tool-registry` / `services`，façade 保留；同步改 `verify-pack.mjs` 与 `pack.test.js`；更新预算表 | `npm run check` 全绿；`verify-pack` 仍报 "6 tools registered"；`tools.js` 降到 façade 量级，`test/architecture.test.js` 的预算随之收紧 |
| **5** | `AGENTS.md` 两张表 + house style 更新 + CHANGELOG 条目 | 命令表检查绿；CHANGELOG 的 Unreleased 有对应条目 |

**顺序的不可交换性**：Phase 1 必须在 Phase 2–4 之前（后面的每一刀都要由前面的门禁验证）；Phase 4 必须在 Phase 1 之后（否则格式化的 diff 与结构的 diff 叠在一起，无法审阅）。

---

## 13. 风险与未解问题

| # | 风险 | 影响 | 处理 |
|---|---|---|---|
| R1 | 格式化提交与进行中的分支冲突 | 一次 rebase | 单人开发，接受；该提交必须**孤立**，不与逻辑改动混合 |
| R2 | `verify-pack` 的注册点正则对格式敏感 | 门禁自己变红 | 已实测格式化后仍 `OK`（§14-C）；拆分时按 §10.3 同步改 |
| R3 | tsc 一档要先把 63 个类型错误清零才见绿 | 一次性的前期投入 | 已按"错误最少 + 被依赖最多"排序（§7.3）；二档与四大文件明确不进棘轮 |
| R4 | 43 条 ESLint 里有 8 条是"关掉并写明理由" | 有可能掩盖真问题 | 关闭只允许行内 + 必写理由；`no-undef` 这类**不允许关闭** |
| R5 | 预算表可能被当作硬墙，于是有人删注释来凑数 | 伤害注释质量（本仓库注释是资产） | §8.1 末段写明"抬预算 + CHANGELOG 说明"是合法动作 |
| R6 | 诊断环有泄漏正文的风险 | 隐私 | 哨兵测试 + 只允许结构化字段 + 沿用 smoke 的既有口径（§9.4） |
| R7 | 复制过的 checkout 上 `codex-mcp` 测试失败 | 误判为回归 | 已定因（§3.7）并进"真相在哪"表 |
| R8 | CI 在 Node 22.22.2 上可能因 `node:sqlite`/FTS5 行为与 25.x 不同而失败 | 下界声明被证伪（这其实是**好事**） | 若失败，按第 5 条：改 `engines.node` 前必须**实测**新下界并说明测了什么 |
| **U1** | 未验证：本机没有 `22.22.2` 可执行文件，所以"CI 在 22.22.2 上绿"**尚未测过** | 下界声明在 CI 首次运行前仍是未验证的 | 明确写进 CHANGELOG 的未验证清单，直到 CI 首次在 22.22.2 上跑绿 |
| **U2** | 未验证：Prettier 对 58 个文件的改动是否**逐字节**只动格式 | 理论上可能改到语义（实际不会，但这是推理不是测量） | 以"格式化后 574 全绿 + verify-pack OK"作为**抽样证据**，并按第 6 条写成抽样而不是证明 |
| **U3** | 未解：`check:fast` 对部分暂存（`git add -p`）的行为 | 可能检查到工作区版本而非暂存版本 | 已写明为已知限制（§4.2）；若实际困扰，再考虑读 `git show :file` |
| **U4** | 未解：`chmod` 类测试（`receipt-store-unavailable`、read-only 目录）在 GitHub Actions 的 runner 上是否可复现 | 那几条会被 `t.skip`（它们已对 `getuid() === 0` 做了跳过） | CI 首次运行后按实际输出记录；若被跳过，在 CHANGELOG 写明"CI 上未覆盖" |

---

## 14. 附录：本次全部测量命令

原始探测脚本跑在 `scratch/`（该目录按 `.gitignore` 不入库），下面给出可重跑的内联形式。

**A. 结构与分层**（§3.2 / §8.1）：解析 `lib/*.js` 的 `from './x.js'`，做环检测、最长路径分层、上行边检查；再 `wc -l lib/*.js | sort -rn`。

**B. 格式化爆炸半径**（§3.4）

```sh
cp -R . /tmp/probe && cd /tmp/probe
cat > .prettierrc.json <<'EOF'
{ "semi": false, "singleQuote": true, "printWidth": 100, "arrowParens": "always", "trailingComma": "all" }
EOF
git init -q && git add -A && git -c user.email=a@b -c user.name=p commit -qm base
npx --yes prettier@3.9.9 --write "lib/**/*.js" "test/**/*.js" "test/**/*.mjs" "scripts/**/*.mjs" "codex/**/*.mjs"
git diff --numstat | awk '{a+=$1; r+=$2; f++} END{print f, a, r}'
```

**C. 格式化后的门禁**（§5.3 的证据）：在已格式化的副本里跑 `node scripts/verify-pack.mjs`（→ `verify-pack: OK`），再跑
`home=$(mktemp -d); DSH_HOME="$home" node --test test/*.test.js; rm -rf "$home"`（→ 574 pass / 0 fail）。

**D. 类型检查基线**（§3.5）：`npm i -D typescript @types/node` 后
`npx tsc --noEmit --allowJs --checkJs --target esnext --module nodenext --moduleResolution nodenext --skipLibCheck --types node lib/*.js`（用 `--format json` 之类的方式聚合错误码计数）。

**E. ESLint 基线**（§3.6）：`npm i -D eslint @eslint/js globals` 后用 flat config 跑 `npx eslint lib scripts codex test --format json`，按 `ruleId` 聚合。

**F. 宿主日志阈值**（§3.3）：在 cordis 的 `src/logger.ts` 看 154–156 行的 `targetLevel` 与 `if (targetLevel < level) continue`；再在已安装宿主里枚举 exporter：
`grep -rn "logger.exporter\|\.exporter(" <dsh>/node_modules/@deepseek-ai/*/lib/*.js`。

**G. 新鲜 clone 等价性**（§3.7）：把仓库 rsync 到 `/tmp/fresh`，删掉 `codex/marketplace/plugins/dsh-obsidian-mem/.mcp.json`（生成物、含机器绝对路径），再跑整套测试 → 574 pass。




