# Windows 兼容验证 · 第 2 轮（2026-11-01）

**Status: PASS** — 全量门禁在本机 Windows 上通过，面板三个视图在真实 Windows Chrome 的
**432 个（宽度 × DPR × 语言 × 主题）状态上 0 布局违规**，图谱 >2,000 节点的 Windows
性能首次实测。本轮**修复了一条测试探针的 Windows 兼容缺陷**（真实归档契约用例在 Windows
上被误跳过，且 npm 安装与否无关），**没有发现需要在产品代码里修复的缺陷**；README 里
「Windows 未测」的两处说法换成本机实测数。

- 环境：Windows 11 专业版 Insider Preview（10.0.26220，build 26220），AMD Ryzen 7 4800H
- Node **v24.20.0**（engine 下限 22.22.2）、npm **12.0.2**、git **2.56.0.windows.2**
- 仓库：`G:\subject\dsh-obsidian-mem` @ `11fe068`（tag `v1.0.4`），
  `core.autocrlf=false`；`.gitattributes` 的 `* text=auto eol=lf` 把检出固定在 LF
  （抽检 `lib/fs-atomic.js`：CRLF 0 / LF 276）
- Chrome：**156.0.8078.74**（`--headless=new`，Windows x64，DevTools protocol 1.3）
- 上一轮记录：`docs/validation/windows-compat-2026-10-28.md`（基线 `feat/memory-v3`，
  7 个 Windows 缺陷修复）；本轮基线是 1.0.4，面板/图谱/i18n 都在那之后重写过。

---

## 1. 门禁（同一工作区）

修复前先完整跑过一次 `npm run check`，拿到基线与 skip 清单；修复探针后重跑：

| 命令 | 结果 |
| --- | --- |
| `npm run check`（lint → format:check → types → prepack → pack:check） | **exit 0** |
| `npm test`（`scripts/run-tests.mjs`，隔离 `DSH_HOME`） | **1,476 tests / 1,442 pass / 0 fail / 34 skipped** |
| `node scripts/verify-pack.mjs` | OK（files allowlist 7 entries、16 required assets、6 tools registered、4 names published） |
| `node scripts/verify-tarball.mjs` | OK（**89 entries、79 lib modules**，every required asset present） |
| `node scripts/build-graph-worker.mjs --check` | **graph worker assets: current** |

修复前同一条链是 **1,475 / 1,440 / 0 / 35**（全量套件单独重跑 373.6 s），差的正是
`test/pack.test.js` 被跳过的那一条与新增的探针用例（见 §3）。

---

## 2. 平台能力实测（本机，`scratch/win-round/env-probe.mjs`）

| 能力 | 实测结果 |
| --- | --- |
| file symlink / dir symlink | **EPERM**（非提权进程没有 SeCreateSymbolicLinkPrivilege） |
| junction | **ok**，且 `lstat().isSymbolicLink() === true` |
| `chmod(0o600)` 后的 `mode & 0o777` | **0o666**（NTFS 不表达 POSIX 位） |
| `chmod(0o444)` 后写文件 | **EPERM**，不是 EACCES |
| rename 覆盖「另一个句柄打开着」的目标 | **EPERM**；关闭句柄后 **ok** |
| 对目录 fd 做 fsync | **EPERM** |
| 路径中间一层是普通文件 | **ENOENT**（POSIX 是 ENOTDIR） |
| `constants.O_NOFOLLOW` | **undefined** |
| 普通文件 nlink | 1 |

与 2026-10-28 轮记录的同一组事实逐条一致 —— 说明那一轮为它们做的处置仍然必要且仍然有效
（`renameWithRetry`、`fsyncDirectory` 容忍 EPERM、`parentIsNotDirectory`、
`isPrivateMode`、`O_NOFOLLOW` 缺席时的拒绝路径，见 §7 的套件证据）。

---

## 3. 本轮修复：npm 可用性探针在 Windows 上误判（测试覆盖缺陷）

`test/pack.test.js` 里真实归档契约用例的环境门是：

```js
function npmRuns() {
  const probe = spawnSync('npm', ['--version'], { encoding: 'utf8' })
  return probe.status === 0
}
```

Windows 上 npm 是 `npm.cmd`，无 shell 的 `spawnSync` 报 **EINVAL**，所以即使 npm 12.0.2
已安装、`scripts/verify-tarball.mjs` 也能正常打包，这条用例仍被 skip —— 于是
`the archive this checkout really produces satisfies the contract` 在 Windows 上从未运行过。
而同一份「用本 Node 跑 `npm-cli.js`」的解析 1.0.1 就已经加进 `scripts/verify-tarball.mjs`
（那是 D7 的同类修复），测试里却另写了一份裸 `spawn('npm')`。

**修复**：

- `scripts/verify-tarball.mjs`：`npmCommand()` 改为导出（它的注释写明测试探针共用它）。
- `test/pack.test.js`：`npmRuns()` 改用 `npmCommand()`；新增一条纯修复无关的用例
  `the npm probe uses the npm JS entry through this Node, never a shell-less .cmd`，
  钉住「探针不 spawn `.cmd`」。
- 证据：修复后 `test/pack.test.js` 在 Windows 上 **27/27 通过、0 skip**，真实归档用例
  1.8 s 通过并打印 `verify-tarball: OK … 89 entries, 79 lib modules`；整仓套件的 skip
  从 35 降到 34，`npm run check` 仍 exit 0。

---

## 4. 面板布局：真实 Windows Chrome（`scratch/win-round/`）

### 4.1 方法与矩阵

- 视图来自**发布代码** `lib/memory-panel.js` 的 `createMemoryViews()`；样式是
  `lib/client.js` 里 `/* panel-css:start */ … /* panel-css:end */` 的**真实切片**求值；
  宿主 tokens 用 `extract-tokens.mjs` 从安装的 DSH `app.asar` 提取（明暗两套）。
- 视图用仓库自带、与 `test/panel-ui.test.js` 相同的四钩子 React 替身序列化成静态 DOM
  （仓库没有 React 依赖），再由**真实 Windows Chrome** 排版与测量；371 天 activity fixture
  （生产窗口）；構成桑基按页面宽度注入实测块宽 `max(292, width − 28)`，即宿主
  ResizeObserver 会量到的 `.mem-ledger` 宽度。
- 矩阵：**3 视图（概览/检索/健康）× 中英 × 明暗 × 9 宽度（300/320/375/480/590/659/660/720/760）
  × 4 DPR（1/1.25/1.5/2）= 432 个状态**，44 个自包含页面；宽度用 CDP
  `Emulation.setDeviceMetricsOverride` 设置（Chrome 真实窗口有 ~500px 下限，CSS 宽度
  只能靠 DevTools 设备模拟），字体 `document.fonts.ready` 后测量。

### 4.2 结果：**432 / 432 状态 0 违规**

| 断言 | 结果 |
| --- | --- |
| 页面级横向滚动（`scrollWidth > clientWidth`） | **0** 个状态 |
| 元素越出视口（滚动容器内部除外） | **0** 个状态 |
| 热度图几何 | 371 格 = **53 列 × 7 行**；格 **10×10**；列距/行距 **12/12**；grid **634×82**；月标签 13 个、**0 重叠**；320px 滚动盒 client/scroll **292/648**（中文）、**292/666**（英文）；760px 时 grid 完整可见 |
| KPI 条 | >559px 四格单行、`space-evenly`：590px 时格间距 51.14 与两端 52.13/52.16（≤1px）；≤559px 2×2 |
| 構成桑基 | 320px 中文 svg=**292**=块宽；760px 中文/英文 svg=**732**=块宽；320px 英文 svg=**354** > 292，落在按设计横向滚动的 `.mem-sankey-scroll` 内；SVG 文本越界 **0** |
| 健康卡片 figure 网格 | 6 项 → 3 列 2 行；4 项 → 宽屏 4 列、≤559px 2×2；2 项 → 2 列；**空槽 0** |
| 最近变化竖线 | 首组线从节点中心起（比组盒少 6px），其余组线盒与组盒等高（连续）；节点中心 x 一致 |
| DPR 无关性 | DPR 1/1.25/1.5/2 的 document/view/heat grid/sankey/KPI band 宽度差 **≤0.5px** |
| 文本截断 | 唯一被截断的 selector 是 `.mem-result-title`（CSS 明写 `white-space:nowrap; text-overflow:ellipsis`，长标题按设计省略），32 个状态出现 |

字体事实：打印元素的 `font-family` 解析为 `-apple-system, BlinkMacSystemFont, "Segoe UI",
sans-serif` → Windows 上实际是 **Segoe UI**；26px/600 实测样例宽 `约定 决策 文档 术语表` =
255.44 px、`515 8 12 2` = 114.54 px、`Windows performance` = 267.87 px。
本轮覆盖了 1.0.4 未验证清单点名的四项：**Windows 字体、DPR ≠ 1、<320px（300）、>720px（760）**。

截图（`scratch/win-round/shots/`）：`OverviewView-zh-light-{300,320,659,760}.png`、
`OverviewView-zh-dark-659.png`。

---

## 5. 图谱布局性能（README「>2,000 节点的 Windows 性能未测」的实测）

- 被测对象是**发布资产** `lib/graph-worker.js`，装载方式与 `test/graph-worker.test.js`
  完全相同（`node:vm` + 假 `self.postMessage`/`setTimeout`/时钟）。
- 图：确定性 LCG 生成「二叉局部格 + 0.6n 随机弦」，位置均匀分布，近似真实 vault 的
  邻居+弦密度；每个规模跑 340 个 tick（Obsidian 的 300 步 alpha 日程 + 余量），
  逐 tick 墙钟耗时。

| 节点 | 边 | 340 tick 总耗时 | **中位 tick** | p95 | 最大 |
| --- | --- | --- | --- | --- | --- |
| **1,236**（真实 vault 规模） | 1,974 | 4.04 s | **12.81 ms** | 16.19 ms | 42.49 ms |
| 2,500 | 3,997 | 8.99 s | **28.81 ms** | 34.87 ms | 66.80 ms |
| 4,000 | 6,399 | 15.73 s | **50.69 ms** | 59.01 ms | 128.89 ms |
| 6,000 | 9,599 | 31.26 s | **99.89 ms** | 125.96 ms | 162.88 ms |

四个规模都完整收敛（`cooled=true`、点数正确）。读数与 0.4.4「为 1:1 复刻 Obsidian 主动
接受 quadtree 碰撞成本」的取舍一致：**1,236 节点正好在 60 fps 预算边缘**（p95 已越
16.7 ms），超过约 2,000 节点后布局是**慢动画而不是坏几何**（2,500 节点约 35 fps 的 tick
节奏），并非本轮新缺陷。README 中英两半已把「Windows 未测」替换成本表数字，未验证清单
只剩「该规模下的拖拽重新升温」（本轮没测）。

---

## 6. 套件 skip 审计（34 条，修复后）

| 原因 | 条数 | 说明 |
| --- | --- | --- |
| 平台拒绝 file symlink（EPERM） | 14 | 2026-10-28 轮已把能用 junction/硬链接保住的覆盖拆成独立用例，剩下的只能跳过 |
| 无 expect(1) / pty 助手 | 10 | TTY 驱动用例，Windows 无 Tcl expect 与 pty helper |
| NTFS 不表达 POSIX 位 / 造不出「不可读」 | 8 | `chmod(0o000)` 后仍可读；对应的拒绝分支由注入式 read seam 用例覆盖（transaction / registry / pointer / repo walk） |
| `/dev/fd` 是 POSIX 视图 | 1 | 既有 skip |
| `MARKETPLACE_PROBE_LIVE=1` 既有 opt-in | 1 | 与 Windows 无关 |
| **npm 探针（本轮修掉的）** | **0**（原 1） | 见 §3；修复后真实归档用例在 Windows 上真实执行 |

没有一条是为变绿而跳；本轮新增的用例没有带来新的 skip。

---

## 7. 其余平台的既有处置仍在本机生效（证据）

- transaction / curation / diagnostic-journal / receipt 等需要 `renameWithRetry`、
  `fsyncDirectory` 容忍、`parentIsNotDirectory`、`isPrivateMode` 的用例在 Windows 全绿
  （套件 0 fail），说明 2026-10-28 轮的修补在这台机器上仍被真实执行，而不是只存在于注释里。
- 文档化的 Windows 限制仍在：curation review 依赖 `O_NOFOLLOW`，Windows 上以
  `review-lock-unavailable` 干净拒绝（`test/curation-review.test.js` 相关用例在本机通过；
  README「Failure recovery」的说明不变）。读取、写入、扫描不受影响。
- `scripts/build-graph-worker.mjs --check` 在本机 npm ci 布局下输出
  `graph worker assets: current`（上一台机器因 pnpm 严格布局而 skip 的那条检查，本机真实通过）。

---

## 8. 本轮没有测到的（边界）

- **真实桌面 Electron 侧栏的端到端点击**没有在本机跑：仓库文件是桌面 profile 的硬链接
  快照，需要完全退出 DSH 重开才会加载本树；本轮用真实视图 + 真实样式 + 真实 Windows
  Chrome 排版，而不是在宿主里点按钮。
- 面板视图用仓库自己的 React 替身序列化后再由浏览器排版，**不是真实 React 运行时**；
  平台相关的排版（字体/DPR/宽度）由真实 Chrome 完成，React 运行时本身不参与布局。
- 桑基块宽按视口注入了「宿主会量到的宽度」，页内 ResizeObserver 的那一次测量没有单独复验。
- 图谱只测了初始 340 tick 的布局成本，**>2,000 节点的拖拽重新升温**与 >6,000 节点没有测。
- 物理显示器缩放没有覆盖：DPR 用 CDP 设备模拟（对布局等价），不是在一台 125%/150%/200%
  缩放的真机上点过。
- 本轮没有重跑 macOS/Linux，也没有重跑 Node 22.22.2（engine 下限）；CI 的 Windows
  22.22.2 / 24.x 两条矩阵腿在上一提交（`defc6bf`）是全绿的。

---

## 9. 复现与产物

```sh
# 门禁
npm run check
node scripts/build-graph-worker.mjs --check

# 平台能力 / 图谱性能
node scratch/win-round/env-probe.mjs
node scratch/win-round/graph-bench.mjs

# 面板布局（渲染 44 页 → 真实 Chrome 432 状态 → 断言）
node scratch/win-round/render.mjs
node scratch/win-round/measure.mjs
node scratch/win-round/analyze.mjs   # FAIL: 0
```

产物都在 `scratch/win-round/`（`scratch/` 已 gitignore，不入库）：`results.json`（432 个
状态的原始测量）、`analysis.json`（断言与汇总，`FAIL: 0`）、`pages/`、`shots/`。
本轮入库改动：`docs/validation/windows-compat-2026-11-01.md`、`README.md`、
`README.zh.md` + `README.i18n.yaml` 的 hash 重记、`CHANGELOG.md` 的 Unreleased 条目、
以及 §3 的 `scripts/verify-tarball.mjs` / `test/pack.test.js`。
