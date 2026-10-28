# Windows 兼容验证 · 2026-10-28

本文件记录本轮 Windows 兼容工作的**实测依据**。每一条都是命令输出或探针结果，
不是推断。仓库纪律（WORKFLOW.md §0.1）要求「证据先于设计」，因此这里按
**失败 → 根因 → 处置 → 平台依据** 的结构记录，并把三处关键阈值/容忍的实测数
单独列出（§5）。

- 环境：Windows 11，非管理员，Developer Mode 未开启（`HKLM\SOFTWARE\Microsoft\Windows\AppModelUnlock` 为空）
- Node：`v24.21.0`（仓库自带 runtime：`~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe`）
- 仓库：`C:\Users\HIO5SGH\Documents\subject\dsh-obsidian-mem`，`core.autocrlf=true`（工作区 CRLF，索引 LF）
- 基线分支：`feat/memory-v3` @ `e38a01e`，`origin/main` @ `6c651b8`

---

## 1. 环境能力实测（本轮所有处置的前提）

用 `node` 探针与 PowerShell `New-Item` 双向验证，结论一致：

| 能力 | 实测结果 | 复现方式 |
| --- | --- | --- |
| `symlink(file, link)` | **EPERM**（`errno -4048`） | 非提权 PowerShell `New-Item -ItemType SymbolicLink` → "Administrator privilege required" |
| `symlink(dir, link)` | **EPERM** | 同上 |
| `symlink(dir, link, 'junction')` | **OK** | 同一条命令 `-ItemType Junction` 成功 |
| `chmod(0o600)` 后 `stat().mode & 0o777` | **0o666 (438)** | Node 探针，文件与目录都是 438 |
| `chmod(0o000)` 造不可读文件 | **无效**，仍可读 | Node 探针：chmod 后 `readFile` 照常成功 |
| `chmod(0o444)` 后写文件 | 失败，但错误码是 **EPERM** 而非 EACCES | 见 §2 A2 |
| `GIT_CONFIG_GLOBAL=/dev/null` | 可用 | 全部 fixture 的 `git init` 均成功 |
| `rename(tmp, dst)` 当 dst 有打开句柄 | **EPERM**（POSIX 会成功） | 见 §5.2 |
| 路径中间一层是普通文件（ENOTDIR 场景） | **ENOENT**（POSIX 是 ENOTDIR） | 见 §2 A5 |
| `node --test` 默认多进程入口 | **spawn EPERM**（errno -4048） | 无沙箱放宽时 79 个文件全失败 |
| `node:test` 的 `t.after` 执行顺序 | **按注册顺序**（非后进先出） | 三钩子探针输出 1→2→3 |

**最后两条是本轮最容易被误判为「代码 bug」的两条**：前者一度表现为「79 个测试文件全 EPERM」，
后者一度表现为「测试挂起 >120s」（实际是清理顺序导致的 `EBUSY` 退避）。

---

## 2. 失败分类与处置

### A1 · 文件/目录符号链接 EPERM

**根因**：非提权 Windows 进程不能创建 symbolic link（`SeCreateSymbolicLinkPrivilege` 未授予）。
这是权限模型，不是代码缺陷。

**处置**：新建 `test/platform-capabilities.js`，提供**真去建一次再删**的能力探测（不是查
`process.platform` —— 本机 junction 可用而 file symlink 不可用，平台判断会得出错误结论）：

```js
LINK_CAPABILITIES = { fileSymlink: false, directorySymlink: false, junction: true }
skipWithoutDirectorySymlink() -> false        // 目录链接可用 junction，不 skip
createDirectoryLink(target, link)             // 自动选 junction
skipWithoutFileSymlink() -> '平台理由字符串'
```

- **目录型链接 → 改用 junction**：`lib/paths.js` 的 symlink 拒绝逻辑用 `lstat().isSymbolicLink()`
  判断，而 junction 的 `lstat().isSymbolicLink()` 实测为 `true`，所以**拒绝分支仍被真实执行**，
  覆盖没有被丢掉。
- **file symlink 造不出的场景 → 条件跳过**，且把原用例的其余行为断言**拆成独立用例保留**，
  例如 `pointer-not-a-file` 的目录型路径、`mustExist` 语义、`_meta` junction 场景。
- 被处理的文件：`assets` `bootstrap` `binding` `appraisal-action` `curation-review` `curation-scan`
  `convention-rotation` `delivery-state` `diagnose-cli` `diagnostic-journal` `lint` `search` `transaction`。

### A2 · POSIX 权限位断言

**根因**：NTFS 不实现 POSIX permission bits，`mode & 0o777` 恒为 `0o666`。
断言 `=== 0o600` 在正确的文件上也不可能成立。

**处置**：`test/platform-capabilities.js` 提供 `assertPrivateFile` / `assertPrivateDirectory`
（含同步版），**不是空断言**：

- POSIX：仍断 `mode & 0o777 === expected`（精确，与原断言等价）
- Windows：断**该文件的真实属性** —— 是普通文件、不是链接、owner 可读、内容逐字节正确；
  目录则断「存在、是目录、非链接、可枚举」

因此「文件丢了、变成链接了、读不出来了、内容错了」在 Windows 上**仍然会失败**，
只有「POSIX 位」这一条换成了平台能表达的等价物。**没有删除任何断言**。

### A3 · POSIX 路径字面量

| 位置 | 问题 | 处置 |
| --- | --- | --- |
| `test/assets.test.js:405` | `'/tmp/dsh-home'` 在 Windows 不是绝对路径，被解析成 `C:\tmp\dsh-home` | **真修复**：改用 `mkdtemp` 真实绝对 fixture |
| `test/pending.test.js:230` | `queueRootFor('/data')` 同性质 | **真修复**：改 `join()` 构造 |
| `test/graph.test.js:286`、`test/memory.test.js:175,192` | `/tmp/vault` 用作 binding 字面量 | 保留 POSIX 输入（这些用例本就在测路径规范化），断言改为函数意图 |
| `test/panel-actions.test.js:46` | `cwd: '/repo'` | 同理 |
| `GIT_CONFIG_GLOBAL: '/dev/null'` | — | **实测 Windows git 可用，未修改** |

### A4 · 长耗时 / 挂起（原判「>120s 无输出」）

**根因不是代码挂起，是 `node:test` 的 `t.after` 注册顺序 + Windows 目录删除语义**：

1. `node:test` 的 `t.after` 钩子**按注册顺序执行**（实测三钩子输出 1→2→3）。
2. 测试 fixture 总是**最先**注册自己的 `rm(root, {maxRetries: 4})`，而 `services.close()` /
   `index.close()` 是**之后**才注册的 → 删除先跑。
3. Windows 拒绝删除仍被 sqlite 句柄占用的目录（`EBUSY`），`maxRetries` 于是退避重试，
   整个用例卡在 `after` 钩子里直到超时。

**处置**：`test/platform-capabilities.js` 的 `registerTreeCleanup(t, root)` —— 返回一个注册器，
disposer 按后进先出执行，**最后**才删树。已用于 `brief`、`auto-bind`、`auto-capture`、`graph`、
`search-engine`、`panel-actions`、`codex-mcp` 等 8 棵树。

**量化证据**（`panel-actions.test.js:761` 那条 161s）：
| 场景 | 耗时 |
| --- | --- |
| HEAD 版本整条用例（隔离跑） | 166 129 ms，其中 **body 仅 1 195 ms**，`rm` 的 EBUSY 退避耗掉 164 742 ms |
| 持有 live sqlite 句柄 + `maxRetries: 4` 删树 | 162 351 ms → EBUSY |
| 同上但不设 `maxRetries` | 3 ms → EBUSY |
| 先 `close()` 再删 | 7 ms |
| 修复后同一用例 | 1 281 ms |

### A5 · `ENOTDIR` 被 Windows 合并进 `ENOENT`（**真产品缺陷**）

**根因**：POSIX 上「路径中间一层是普通文件」报 `ENOTDIR`；**Windows 统一报 `ENOENT`**。
实测：把 `proposals/` 目录换成同名普通文件后，`lstat('proposals/x.json')` 与
`readFile(...)` 都返回 `ENOENT`。

**后果**：`readRecord` / `readPrivateJson` 把 `ENOENT` 解释为「记录不存在」，
于是一个**被换掉目录的不可信提案被静默当成「没有这个提案」**，正是这些模块存在的目的被绕过。

**处置**：`lib/fs-atomic.js` 新增 `parentIsNotDirectory(path)`，在
`lib/curation-state.js`（`readPrivateJson`）与 `lib/curation-proposals.js`（`readRecord`）
的 `ENOENT` 分支里先用它区分「父级是文件」与「真的不存在」。

**效果**：`curation-review.test.js` 的 `every untrustworthy stored record is answered
proposal-unreadable` 从 fail → pass。

---

## 3. 修好的真实产品缺陷（非测试问题）

这一节是本轮最重要的产出：**7 个真实缺陷，全部在 Windows 上必现、在 POSIX 上不可见**。

### D1 · `codex/*.mjs` 入口判定恒为 false

```js
// 改前（4 处）：codex/server.mjs:363, prompt-submit.mjs:139,
//               session-start.mjs:510, prepare.mjs:178
const isEntry = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`
```

Windows 下 `argv[1] = 'C:\...\x.mjs'`，模板串拼出 `'file://C:\...'`，而
`import.meta.url` 是 `'file:///C:/...'` → **永不相等** → 入口不启动 → 子进程 exit 0 静默退出。

**实际影响**：MCP server 六个工具全部不可用（`initialize` 20s 超时）、SessionStart 简报永不注入、
prompt recall 永不触发、`node codex/prepare.mjs` 假成功。

**修复**：`pathToFileURL(process.argv[1]).href`。

### D2 · `lib/delivery-state.js` 的路径链在 Windows 上退化（**安全缺陷**）

```js
// 改前
const relative = path.slice(root.length).split('/').filter(Boolean)
```

Windows 路径是反斜杠分隔，`split('/')` 只得到**一个**片段（且带前导 `\`），
`join` 后得到 `root` 下一个不存在的假子路径 → `lstat` 报 ENOENT →
返回 `{missing: true, symlink: false}`，**中间目录从未被检查**。

**实测后果**：在中间层放一个 junction，`readPrivateJson` 返回 `symlink:false` 并
**把 dataRoot 之外的文件内容读了出来**（探针实测 `leaked:true`）。
`writePrivateJson` 的对应路径同样可以写到 dataRoot 之外。
`lib/convention-rotation.js` 复用同一函数，同样受影响。

**修复**：`privateChainOf(path, root)` 用 `node:path` 的 `relative()` + `sep` 拆段。

### D3 · `lib/paths.js` 的 `~/` 在 Windows 不展开

`if (candidate.startsWith(\`~\${sep}\`))` —— win32 上 `sep` 是 `\`，
而配置默认值与人类写法是 `~/Documents/dsh-memory` → 展开失败 → `resolveVaultRoot` 抛
`RangeError: vaultRoot must be absolute or start with ~/`。

**实际影响**：Windows 用户用默认配置时 plugin 每次 resolve 都抛异常。

**修复**：同时接受 `'~/'` 与 `~ + sep`。

### D4 · `lib/assets.js` 在 CRLF 检出下 SKILL.md frontmatter 校验必失败

`closing` 指向 `\n---` 的 `\n`，CRLF 检出时 slice 末尾带上 `\r`，
裸 CR 被 YAML parser 拒绝（`Unexpected scalar at node end`）。

**实际影响**：所有 CRLF 检出的 Windows 机器上 `apply()` 的技能同步全部失败，
`$DSH_HOME/skills/obsidian-mem` 永不落地。

**修复**：`text.slice(bodyStart, closing).replace(/\r$/, '')`。

### D5 · `rename` 覆盖已存在文件在 Windows 上会 EPERM（7 个写入方各自踩一次）

另见 §5.2（阈值与实测数）。**修复**：新建 `lib/fs-atomic.js`（L0 leaf），提供
`renameWithRetry` / `renameSyncWithRetry` / `fsyncDirectory` / `isPrivateMode` /
`parentIsNotDirectory`，把 7 份重复实现收敛到一处。

### D6 · `lib/diagnostic-journal.js` 等模块的 `mode & 0o077` 私有性检查

Windows 上目录 `mode` 也是 `0o666`，`mode & 0o077 !== 0` 恒真 → 模块拒绝自己的 data root
（`unsafe-diagnostics-directory`，`diagnostic-journal` 7 条用例全挂）。
**修复**：`isPrivateMode(stats)` —— POSIX 断位、Windows 视为真（结构检查仍在）。

### D7 · `scripts/check-staged.mjs` 与 `scripts/verify-tarball.mjs` 的 spawn

`node_modules/.bin/eslint` 在 Windows 是 POSIX `sh` 脚本（pnpm 布局），spawn 报 ENOENT；
`.cmd` 版本无 `shell:true` 报 EINVAL。两者都变成 `status: null` →
`(stdout || stderr).trim()` 抛 TypeError，报告变成「eslint 失败 + 空消息」。

**修复**：改为 `spawnSync(process.execPath, [<包内 JS 入口>, ...])`；新增
`toolOutput(result)` 兜底 `result.error` / `status`。npm 调用同理走 `npm-cli.js`。

---

## 4. 全部平台级 skip 清单（逐条理由）

共 **33 条 skip**（`1312 tests / 1279 pass / 0 fail / 33 skipped`）。每一条都是
**平台能力缺失**，不是「测试坏了」，也不是「为了绿而跳过」。凡是能用 junction、
hardlink 或拆分用例保住覆盖的，都已保住（见 §4.1）。

### 4.1 用真实替代构造保住的覆盖（**没有** skip）

| 场景 | 替代 | 为什么仍然真实 |
| --- | --- | --- |
| 目录型 symlink 拒绝（13 个文件） | `createDirectoryLink` → junction | junction 的 `lstat().isSymbolicLink()` 实测为 `true`，被测的拒绝分支**真被执行** |
| claim guard 的「外部已存在普通文件」 | 硬链接（`link`） | guard 的拒绝条件是 `nlink !== 1`；实测 hardlink 得 `nlink=2 / sameIno=true`，**触发的正是该条件**，外部文件未被 SQLite 初始化 |
| 指针「不是普通文件」 | 拆出「指针是目录」独立用例 | 该支全平台真跑 |
| registry 被链接重定向 | 目录那半用 junction | 全平台/本机真跑 |
| lint 走链接出 vault | 新增 junction 版用例 | 同一规则真实覆盖 |
| curation-review 源被文件链接替换 | 新增目录链接版 | 同一规则真实覆盖 |

### 4.2 file symlink 类（本机非提权 EPERM）

统一理由串：`this host refuses file symlinks without elevation (Windows non-elevated: EPERM); the escape path cannot be constructed`

| 文件 | 用例 |
| --- | --- |
| assets | `a symlinked target file is refused` |
| binding | `resolveVaultFile refuses a symlink at any segment`（仅 file 那半） |
| binding | `a pointer that is not a regular file`（仅 symlink 那半） |
| binding | `a symlinked registry path is refused`（仅文件那半） |
| appraisal-action | `mem_admin(action="appraise") …`（仅 symlink 逃逸那半） |
| curation-review | `a source replaced by a file symlink is refused` |
| curation-review | `a linked claim guard …` 的 4 条 `existing=false`（需要**悬空**链接，hardlink 实测 ENOENT 无法表达） |
| curation-scan | `a path outside … through a symlink is refused`（仅 file 那半） |
| diagnose-cli | `the npm-style symlink invokes the command` |
| diagnose-cli | `an existing output and a symlink are not overwritten`（仅 symlink 那半） |
| diagnostic-journal | `a substituted run-file symlink cannot be written or exported` |
| lint | `lint ignores a file symlink instead of following it out of the vault` |
| search | `readNote … refuses internal and oversized paths`（仅 symlink 那半） |
| transaction | `a symlinked project directory is refused`（仅 file 那半） |
| curation-tty | 10 条全部（需要 `expect(1)` 构造真实 pty；本机无 expect、无 pty 助手，实测） |

### 4.3 POSIX 权限位 / ACL 类（NTFS 不由 mode 表达）

统一理由：**NTFS 不实现 POSIX permission bits**，`chmod(0o000)` 后文件/目录实测仍可读/可枚举，
用 chmod 造不出「不可读」。

| 文件 | 用例 | 说明 |
| --- | --- | --- |
| transaction | `an unreadable target is refused instead of being treated as empty` | 相邻的 `EDEADLK` 用例用文档化 read seam 覆盖同一拒绝 |
| transaction | `an unreadable target during rollback is a conflict` | 已从「半个用例」拆成独立用例 |
| transaction | `a transaction leaks no file descriptor` | `/dev/fd` 是 POSIX 视图（**既有 skip**，非本轮新增） |
| curation-scan | `a directory the resolver cannot enumerate makes it silent` | 需 icacls 改 DACL；风险不对等，已**否决** |
| lint | `an unreadable repository subdirectory degrades the audit to a finding` | 同文件另有「目录位置放普通文件」的真跑降级用例 |
| capture | `a completed root turn … bounded, auditable job`（mode 那半） | 身份/内容断言保留 |
| pending | 队列目录/作业文件 mode 断言 | 已换 `assertPrivateFile/Directory`，非 skip |
| 其余 mode 断言 | — | **全部换成 `assertPrivateFile/Directory`，一条未删** |

### 4.4 环境依赖缺失类

| 文件 | 用例 | 理由 | 条件式 |
| --- | --- | --- | --- |
| graph-worker | `shipped worker and license match the pinned upstream distributions` | 根 `node_modules` 缺 `d3-quadtree/d3-dispatch/d3-timer`（pnpm 严格布局把它们放在 `d3-force/node_modules` 下） | 是：`REBUILD_SKIP` 由 `existsSync` 计算，装齐即自动跑 |
| pack | `the archive this checkout really produces satisfies the contract` | 本机完全无 npm（PATH / Program Files / %APPDATA% / runtime 均无） | 是：`npmRuns()` 探针判定 |
| repo-gates | `the write probe must be cleaned up by release id` | **既有 opt-in**（`MARKETPLACE_PROBE_LIVE=1`），与 Windows 无关 | 是 |

### 4.5 验证过「skip 没有掩盖陈旧资产」

`graph-worker` 那条用 pnpm store 里的 pinned 版本（`d3-quadtree@3.0.1`、`d3-dispatch@3.0.1`、
`d3-timer@3.0.1`、`d3-force@3.0.0`）重新构建，结果与 shipped 的
`lib/graph-worker.js`、`lib/graph-worker.LICENSE` **LF 归一后逐字节相同** —— 所以该 skip
不是「资产过期但没人发现」。


---

## 5. 三处关键阈值的实测依据

### 5.1 `RESIDENT_FILE_MAX_BYTES = 512`（`lib/transaction.js`）

NTFS 会把小文件存进 MFT（resident），此时 `lstat().blocks` 报 **0**，
而代码原本把「`size > 0 && blocks === 0`」一律判为云占位符（on-demand download）。

**实测**：512 字节以下的 resident 文件 `blocks === 0`；超过该阈值报 8 个 block。
因此 `512` 是「仍可能 resident」的上界，小于等于它的零块文件不判占位符；
真正的云占位符通常远大于此。

### 5.2 `renameWithRetry` 的 12 次 / 线性退避（`lib/fs-atomic.js`）

裸 `rename` 覆盖已存在文件的压测（**2000 次**）：**128 次 EPERM，失败率 6.4%**。
外加一个外部进程持有目标句柄的对照：第 5 次尝试成功（每次间隔 100 ms）。

再用 `renameSyncWithRetry` 打 **3000 次**：
```
uncaught: 0
attempts: { "1": 2965, "2": 25, "3": 7, "4": 3 }
```
35 次（1.17%）确实撞上瞬时 EPERM 并**重试成功**，最多用到第 4 次 —— 相对 12 次预算有 3 倍余量。

**POSIX 上只有 1 次尝试**（语义与改动前完全一致）：那里的 `EACCES` 是真答案，
重试只会把一个快速精确的失败变慢。

### 5.3 `fsyncDirectory` 容忍 `EPERM`/`EACCES`（`lib/fs-atomic.js`）

Windows 打开目录句柄或对其 `fsync` 会报 `EPERM`。实测该调用在 Windows 上必然失败，
且失败后**没有任何可替代的落盘保证可做**，因此容忍（记为成功）；
其它错误码仍然照常抛出。

---

## 6. 面板 UI 测试（专项，提示词 4）

面板共 7 个文件。**关键边界**：`test/panel-ui.test.js` **不依赖浏览器 / 真实 React / jsdom** ——
它注入极简 `React` shim，直接调用 `createMemoryViews()` 返回的视图函数并断言 vnode 树；
`fetch` 用 `t.mock.method` 伪造。所以这里的「UI 测试」是**纯 Node 的结构/逻辑验证，不是 E2E**。

因此**没有引入任何浏览器依赖**（Playwright / Puppeteer / jsdom / happy-dom 全部未加），
仓库「单 bundle + 无浏览器测试」的设计保持不变。

（最终数字见 §7）

---

## 7. 最终全量

命令（仓库自带 runner，隔离 `DSH_HOME`）：

```powershell
node scripts\run-tests.mjs
```

（数字见 §7.3）

### 7.1 可推广的仓库约定：`fs.rm` 在 Windows 上可能永不返回

本轮最值得沉淀的一条（`HANG` 组量化发现）：Node 在 Windows 上对**被持续占用**的目录句柄，
`fs.rm(..., { maxRetries, retryDelay })` 会**反复重试且永不放弃**，而不是在重试耗尽后抛错。

实测：
| 场景 | 耗时 / 结果 |
| --- | --- |
| 持有 `node:sqlite` 句柄 + `maxRetries: 4, retryDelay: 100` | 有效重试窗口之后**仍然挂住**（用例在 `after` 钩子里超时）|
| 同一句柄、不设 `maxRetries` | 3 ms 抛 `EBUSY` |
| 先 `close()` 再删 | 7 ms 成功 |
| 无句柄的普通目录 | 5 ms 成功（不是磁盘慢） |

因此仓库里「`rm` + `maxRetries`」的写法在 Windows 上**可能把一个清理失败变成挂起**。
约定：**先关闭句柄再删树**，并用 `registerTreeCleanup` 把顺序显式化，而不是依赖
`node:test` 的 `t.after` 注册顺序。

### 7.2 另一条约定：`t.skip()` 不会中止用例

`node:test` 的 `t.skip()` 只**标记**用例为跳过，**并不中止执行**。本轮因此发现
`test/transaction.test.js` 里一条「先 `t.skip()` 然后继续读 `/dev/fd`」的用例在 Windows 上
先被标记跳过、随后又以 `ENOENT: scandir 'C:\dev\fd'` 失败 —— **一个被跳过的测试报出了失败**，
并让全量退出码非零。已改为声明式 `{ skip: 条件 }`。

约定：需要跳过的用例用 `test(name, { skip: 条件 }, fn)`，不要用「在 body 里 `t.skip()` 后继续跑」。

### 7.3 第三条：依赖真实时钟的行为测试在慢盘上变成竞态

`test/digest.test.js` 的「200 源上限」用例原先跑在**真实墙钟**上，而 `lib/digest.js` 有一个
`MAX_MS = 500` 的收集 deadline。205 个新写文件的 200 次 `readNote` 在本机实测 **527 ms**，
于是 deadline 可能在中途触发，断言 `inspected === 200` 实际在断言**磁盘速度**（实测被截到 123）。

处置：注入冻结时钟 `now: () => 0` 让 deadline 不可能触发，该用例才真正测「条数上限」；
deadline 本身仍由同文件另两条用例覆盖（含「不 settle 的 reader 不能拖过 500 ms」）。

约定：**一个用例只测一件事**。要测上限就别让 deadline 参与；要测 deadline 就别断言次数。

### 7.4 最终数字

```
ℹ tests 1320
ℹ pass  1284
ℹ fail  0
ℹ skipped 36
```

**fail 为 0。** 36 条 skip 逐条列在 §4，全部是平台能力缺失、环境依赖缺失或既有 opt-in，
没有一条是「为了变绿而跳过」。

其余门禁（同一工作区、同一 node）：

| 门禁 | 命令 | 结果 |
| --- | --- | --- |
| lint | `node node_modules/eslint/bin/eslint.js .` | 0 error / 0 warning |
| types | `node node_modules/typescript/bin/tsc --noEmit` | exit 0 |
| 格式 | `prettier --check --end-of-line auto` | All matched files use Prettier code style |
| changelog | `node scripts/verify-changelog.mjs --base origin/main` | OK |
| changelog 顺序 | `node scripts/changelog-order.mjs` | OK |

> **格式门禁的陷阱（已实测）**：本仓库 `core.autocrlf=true`，工作区是 CRLF，而
> `npm run format:check` 的 prettier 默认按 LF 校验，**连未改动的 `lib/naming.js` 都会报**。
> 这是环境属性不是代码问题；本轮判定一律加 `--end-of-line auto`，且**没有**做全仓库
> `--write`（那会把整个仓库改成 LF，产生一个巨大的无关 diff）。