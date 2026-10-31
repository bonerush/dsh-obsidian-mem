# Changelog

All notable changes to this plugin are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The package is not published to a registry. A release here is a git tag plus a
GitHub Release, so `0.1.0` below — dated 2026-09-23 — records the development
baseline that was never tagged, and every version from `0.1.1` on is a tagged
release artifact. The versioning policy is in the README, under Development.

## Unreleased

### Fixed

- **`test/pack.test.js` 的 npm 可用性探针在 Windows 上必然误判，导致真实归档契约用例被跳过。**
  探针直接 `spawnSync('npm', ['--version'])`：Windows 上 npm 是 `npm.cmd`，无 shell 的
  spawn 报 EINVAL，于是 npm 12.0.2 已装好的本机也被判成「npm 不可用」，
  `the archive this checkout really produces satisfies the contract` 一直 skip ——
  而同一份解析早在 1.0.1 就改成了「用本 Node 跑 `npm-cli.js`」（`scripts/verify-tarball.mjs`），
  只是测试里另写了一份。现在探针复用已导出的 `npmCommand()`，并新增一条用例钉住
  「探针走本 Node 的 npm JS 入口，不 spawn `.cmd`」。
  - 证据：修复前整仓套件 1,475 tests / 1,440 pass / 0 fail / **35 skipped**（其中一条就是它）；
    修复后 `test/pack.test.js` 在本机 Windows 上 **27/27 通过、0 skip**，真实归档用例
    耗时 1.8 s 并打印 `verify-tarball: OK … 89 entries, 79 lib modules`。

### Changed

- **Windows 兼容验证第 2 轮：全量门禁、面板布局与图谱性能在 Windows 上实测；除上面那条
  测试探针外没有发现产品缺陷。** 本机 Windows 11（10.0.26220）+ Node v24.20.0 + npm 12.0.2
  + 真实 Chrome 156.0.8078.74：
  - `npm run check` 全绿：**1,476 tests / 1,442 pass / 0 fail / 34 skipped**；
    `verify-pack` 与 `verify-tarball` 均 OK（89 entries / 79 lib modules）；
    `scripts/build-graph-worker.mjs --check` 输出 `graph worker assets: current`。
  - 面板三个视图（概览 / 检索 / 健康）× 中英 × 明暗 × 300–760 px 九个宽度 × DPR
    1 / 1.25 / 1.5 / 2：**432 个真实 Chrome 状态、0 布局违规** —— 无页面横向滚动、无元素
    越出视口；371 天热度图 53×7 格（10×10、列距 12）、月标签 0 重叠；KPI 宽屏单行
    space-evenly、≤559 px 2×2；構成桑基铺满实测块宽（320 px 中文 292、760 px 732，
    英文窄屏按设计横向滚动）；健康卡片 figure 网格空槽 0；DPR 变化时关键盒宽差 ≤0.5 px。
    字体解析为 Segoe UI；唯一被截断的是 CSS 明写 ellipsis 的 `.mem-result-title`。
  - README 里「Windows 上 >2,000 节点的性能未测」换成本机实测：**1,236 节点真实规模
    中位 12.8 ms/tick（p95 16.2 ms）**，2,500 节点 28.8 ms、4,000 节点 50.7 ms、
    6,000 节点 99.9 ms —— 与 0.4.4「为 1:1 复刻 Obsidian 付 quadtree 碰撞代价」的已知
    取舍一致，不是本轮新缺陷；中英两半同步改写，`README.i18n.yaml` 的 blob hash 一并重记。
  - 34 条 skip 全部是平台能力缺失或既有 opt-in（14 file symlink EPERM、10 expect/pty、
    8 NTFS mode/ACL、1 `/dev/fd`、1 `MARKETPLACE_PROBE_LIVE`），没有一条为绿而跳。
  - 证据：`docs/validation/windows-compat-2026-11-01.md`；测量产物在 `scratch/win-round/`
    （已 gitignore，不入库）。

## 1.0.4 — 2026-10-31

### Changed

- **语言切换按钮改用翻译图标，不再印 `EN`/`ZH`。** 两字母徽标读起来像「当前是什么
  语言」的状态标签，而不是「点它会切到哪一个」的动作；现在画的是常见翻译标记（文/A 组合，
  Material translate 的实心路径，16px），`title` 与 `aria-label` 仍然写明目标语言
  （英文界面 *Switch to Chinese*、中文界面「切换到英文」），按钮仍是 28×28 的方形热区，
  与刷新按钮同高对齐。外壳与三个视图的语言行为本身不受影响。

### Fixed

- **关键数字条的四格按内容宽度分配空白，不再等宽四等分。** 等宽时每格内容各自居中，
  但读数宽窄差很大：第一条带着 120px 的折线，最后一条 "0 个" 只有 29px。实测 593px
  面板下整条墨迹左边空 25px、右边空 69px，看起来既没居中、左右空隙也不一致。改为
  `display:flex; justify-content:space-evenly`：每格宽度由自身内容决定，剩余空白在格间
  与两端平均分配；代价是宽布局里去掉了 1px 竖分隔线（格宽不等时它们会落在不均匀的
  位置），改由空白分组。559px 及以下仍折成 2×2 等宽网格并恢复分隔线。证据：headless
  Chrome 用真实样式实测 593px 中文左右各 46.67px、英文 35.86/35.88px；560/570/600/
  640px 四个宽度的格间距与两端空隙逐项相等（误差 <0.03px），
  `scrollWidth-clientWidth` 全为 0。
- **健康页三张数字卡片的内容居中，短行不再露出灰色空格。** 固定三列网格在项数不是
  3 的倍数时，空出的格子会露出网格容器的边框底色：热层数字（2 项）右侧 1 个灰块、
  今日摘要（4 项）第二行 2 个灰块。现在 `figures()` 把项数写进 `data-columns`
  （≤4 项时一项一列铺满，6 项仍是 2 行 3 列），单元格内容从左上对齐改为居中。证据：
  headless Chrome 实测三张卡片 holes 均为 0（索引 3 列×2 行、热层 2 列×1 行、摘要
  4 列×1 行），每格文字左右墨迹差 <0.03px；559px 及以下摘要的 4 列回退为 2×2。
- 证据：`DSH_HOME=$(mktemp -d) node --test test/panel-client.test.js test/panel-ui.test.js`
  118/118 通过（断言更新：KPI 条含 flex/space-evenly、折线显式 120px 与
  `max-width:100%`、三张卡片的 `data-columns` 为 3/2/4、figure 单元格居中、折叠规则
  改为第 2/4 格的左边线与第 3/4 格的上边线并含 4 列→2 列回退；原有中文断言未改）。

## 1.0.3 — 2026-10-31

### Added

- **面板内可以切换界面语言，真实浏览器默认英文。** 标签条右上角新增语言按钮：英文界面
  显示 `ZH`（提示 *Switch to Chinese*），中文界面显示 `EN`（提示「切换到英文」）。
  点击后外壳与三个视图立即换语言，选择写入 `localStorage` 的
  `dsh-obsidian-mem:locale`，下次打开沿用。语言仍是中英两种：没有 `localStorage` 的
  环境（`node --test`、旧宿主）保持原来的 `navigator` 探测与中文兜底，所以既有中文断言
  不需要改写。侧栏标签页的标题与描述在插件注册时确定，切换语言后需刷新页面才更新；面板
  内部立即生效。
- **英文界面的排版与漏翻补齐：**
  - Activity 热图的星期栏在英文下留 32px（`Mon/Wed/Fri` 不再压住第一列色块），中文
    仍是 14px；画布宽度、月份行偏移、网格列宽与 tooltip 锚点用同一个宽度。
  - Composition 桑基按本次实际打印的英文标签测宽（`Convention`、`Superseded` 等），
    图表放进 `.mem-sankey-scroll`：窄面板下横向滚动看完整文字，而不是把标签截成
    `Con…`。中文列宽保持原来的 34/38/36/40，几何与既有断言逐字不变。
  - 健康页热层分区的三个标准区名翻成英文（强约束 → Strong constraints、进行中 →
    In progress、已完成 → Completed），与 `lib/panel-copy.js` 的对话框用词一致；
    用户自定义区名是数据，原样保留。

### Fixed

- **搜索框在上下空隙中垂直居中。** `.mem-searchbar` 的 padding 由 14/10 改为 16/8：
  加上视图区的 8px 上内边距后，搜索框上方 16px、下方 16px，不再偏上。
- **健康页不再重复标题。** 外壳的健康标签页把 `onMeta` 传给视图，页面不再在搜索框下面
  再印一个「健康 / Health」标题；独立渲染（无 `onMeta`）仍保留标题，概览页的既有门控
  行为不变。
- **热图月份行滑到星期栏下方时不再露出半截。** 星期栏的遮罩过去只和网格同高，
  横向滚动后月份标签会从 `Mon/Wed/Fri` 上方探出半个字。现在给 `.mem-heat-weekdays`
  加一个向上 14px 的同色伪元素（`::before`，与月份行同高），遮罩正好盖住整条月份行，
  中文标签只在星期栏右侧出现。中文 14px 与英文 32px 的星期栏通用，布局与网格尺寸未变。

- 证据：`DSH_HOME=$(mktemp -d) node --test test/panel-ui.test.js` 85/85 通过（新增 4
  条：英文热图 gutter、英文桑基测宽与滚动、组合健康页的中英标题门控）；同法
  `test/panel-client.test.js` 32/32 通过（新增 5 条：默认英文、点击切换并持久化、
  存储优先、renderer 随语言重建、居中与滚动条 CSS）；`test/architecture.test.js`
  8/8 通过（两个越界文件的预算按实测行数 +30 向上取整后抬到 4300/1700，理由写在
  预算注释里）。中文行为与 1.0.2 逐字节一致，`test/panel-ui.test.js` 原有 81 条与
  `test/panel-client.test.js` 原有 27 条断言零改动通过（唯一调整是「只有热图横滚」的
  断言改为同时承认桑基的滚动容器）。

## 1.0.2 — 2026-10-31

### Added

- **英文界面：面板、图谱外壳与健康操作的对话框都能按系统语言显示英文，默认仍是中文。**
  只新增一份英文文案，没有引入新的运行时或开发依赖；中文文案与改动前逐字节一致，
  所以既有的中文断言不需要改写。语言解析集中在新文件 `lib/locale.js`：
  - **解析顺序**：请求体 `locale` → 请求头 `Accept-Language` →（浏览器内）
    `navigator.languages` / `navigator.language` → 兜底 `zh`。显式 `zh` 赢过英文
    请求头；`fr-FR` 这类既非中英的明确偏好显示英文（界面只有两种语言，英文是唯一
    能跨语种的兜底）；`*` 不算偏好——Node 的 `fetch` 默认就发
    `accept-language: *`，把它当成英文会让不带偏好的请求凭空变英文。
  - **面板**（`lib/memory-panel.js`）：概览 KPI、热图/流量条/树图/桑基、健康、最近
    变化、检索结果、操作单与确认/预览全部按 locale 取词；`createMemoryViews({ React,
    locale })` 可显式传入，未传时在浏览器里按 `navigator` 探测；每个 `POST` body
    都带 `locale`，面板自己决定语言，不让路由被宿主浏览器的请求头改掉。
  - **外壳与图谱**（`lib/client.js`、`lib/graph-renderer.js`）：标签页、搜索框、错误
    与空状态、通知、图谱设置/筛选/滑块、画布 `aria-label` 与 worker 失败文案中英
    双语。这两个资产由路由按文件原样送出，运行时不能 `import`，所以语言规则在各自
    文件里内联一份；无 `window` 的环境（`node --test`）固定回中文，既有中文断言
    不变。
  - **服务端对话框**（新文件 `lib/panel-copy.js`，`lib/panel-actions.js` 与
    `lib/panel-route.js` 接入）：重试失败任务、整理热层、发布项目摘要的标题、按钮、
    字段、效果与警告按请求 locale 取英文；中文副本与改动前逐字节同一份。
  - 证据：`DSH_HOME=$(mktemp -d) node --test` 定向套件全绿——`test/locale.test.js`、
    `test/panel-route.test.js`、`test/panel-actions.test.js`、
    `test/panel-client.test.js`、`test/graph-renderer.test.js`、
    `test/panel-ui.test.js`；真实路由 seam 上，body 的 `locale` 胜过英文请求头、
    只有 `Accept-Language: en-US` 得英文、两者都没有得中文、只有 `*` 得中文。
    整仓 `npm run check` 全绿：1467 条测试 1466 pass / 0 fail / 1 skipped，verify-pack 与
    verify-tarball 均 OK（归档 89 entries、79 lib modules，与 AGENTS.md 记录一致）。独立
    验证（`scratch/i18n-verify.md`）另跑了真实路由与真实视图探针：route 导出与 HEAD 全等、
    默认中文渲染文本逐串等于 HEAD、en 三视图与预览/确认单无汉字；唯一发现的空
    "最近变化" 中文硬编码已修复并补了回归测试。
  - **未验证**：真实桌面侧栏在系统语言为英文时的自动探测没有在真实 Electron 窗口里
    点过（浏览器探测只有 DOM 级测试）；README 中英两半和 `README.i18n.yaml` 未改，
    因为用户明确说 README 已有双语、不必处理。

## 1.0.1 — 2026-10-31

### Fixed

- **CI 的浮动 `node` 平台不再被 npm 12 的 `npm pack --json` 输出形状打红。** 该平台实际装的是 Node `27.0.0-alpha.0.0.0` + npm `12.1.0`；npm 12 把这个输出从数组 `[{…}]` 改成按包名索引的对象 `{"dsh-obsidian-mem": {…}}`，而 `scripts/verify-tarball.mjs` 原有的 `const [packed] = JSON.parse(run.stdout)` 对对象解构会抛 `object is not iterable`，于是 `the archive this checkout really produces satisfies the contract` 断言 `2 !== 0`、job 退出 1（run 41176291759）。这不是 1.0.0 引入的：0.4.4 的推送在同一平台上已因同一原因红（run 41093967549）。现在 `parsePackReport(stdout)` 同时接受数组与按包名索引的对象两种信封，并且只接受**恰好一个**归档记录：0 个或多个都抛出带数量的错误，不再静默挑一个；真实打包与归档检查路径不变。
  - 证据：在隔离目录安装 npm `12.1.0`、用假 `node` 布局实测本仓库 `npm pack --json` 返回 `isArray false`、`keys ["dsh-obsidian-mem"]`、`files 87`；同一布局下 `scripts/verify-tarball.mjs` 输出 `87 entries, 77 lib modules, every required asset present`，`node --test --test-name-pattern='archive this checkout' test/pack.test.js` 通过；npm 11（本机默认）的同一命令与完整 `npm run check` 也通过。`test/pack.test.js` 新增两条纯函数测试：两种信封得到同一记录；0 个、2 个、缺 `filename` 的记录全部被拒绝。

### Changed

- **README 的 DSH 支持范围改为实际支持的范围。** 需求表此前只列 `0.1.5-rc.2` 与 `0.1.7-rc.2` 两个"已验证"版本，读起来像其余版本未获支持；现在写明下限 `>= 0.1.5-rc.2`、当前版本 `0.2.1-rc.5`，以及两者之间的每个版本都受支持（每个中间版本都对照插件实际使用的行内 `config:` 与 Cordis 接缝核查过，没有发现不兼容）。面板段落的环境同步为当前实测组合：DSH `0.2.1-rc.5` + `dsh-better-sidebar` `0.28.1`。中英两半同改，`README.i18n.yaml` 的 blob hash 一并重记。

## 1.0.0 — 2026-10-31

**第一个稳定版本。** 从 1.0.0 起，六个 `mem_*` 工具的名字与参数、vault 协议（指针文件、
笔记 frontmatter 与随包技能）以及配置键按 SemVer 承诺向后兼容——其中任何一项的破坏性
变更需要主版本号；行为修正与面板/图谱改进仍落在次版本与补丁版本。"稳定"承诺的是这些
接口，不是宣称所有边界都已穷尽，本节末尾的未验证清单照旧保留。

### Added

- **记忆面板能实时反映记忆变化，不再需要退出 DSH 重开。** 之前面板每 30 秒轮询一次，
  但项目索引只会在**同一进程**写入之后重扫（`lib/services.js` 的
  `refreshOpenIndexes`）；另一个进程写下的记忆（另一个 DSH profile、Codex 适配器、
  Obsidian 本身）永远不会出现在已经打开的面板里，看起来就像"要重启才更新"。现在：
  - 服务端（`lib/panel-route.js`）：概览与健康在回答前先让项目索引做一次
    mtime/size 增量重扫，同一索引句柄最多每 `PANEL_REFRESH_INTERVAL_MS` = 5000 ms
    一次（模块级 `WeakMap` 记时间戳）；索引自己在扫描时跳过；时间戳在 await 之前
    落章，所以重叠的两次轮询只会触发一次扫描；重扫失败被吞掉，读仍用上一次扫描回答。
    检索与未绑定读不重扫（读动作词汇不变）。
  - 客户端（`lib/memory-panel.js`）：轮询间隔 30 s → **15 s**，窗口重新获得焦点时
    也读一次；背景轮询**静默**（不再每 15 秒闪一次"正在刷新…"的 `aria-live` 区域），
    只有用户点刷新（masthead / refreshKey）时才播报一次。
  - 证据：真实宿主路由探针（`registerPanelRoute` over loopback + 生产
    `openIndex` 读 vault 副本）182 天回答与实时 payload 逐字段一致（仅
    `health.lastScan` 变化），说明读取路径本身能拿到最新索引；5 条路由测试覆盖节流
    窗口/扫描中跳过/先落章后 await/失败不失败读/检索与未绑定不重扫。
  - **未验证**：真实桌面 Electron 侧栏里"别的进程写入 → 面板 15 s 内变化"的端到端
    点击/观察没有在浏览器里跑过（见本节末 Untested）。

- **活动热度图改成 GitHub contribution graph 的形式。** 用户要求"像 GitHub 上那种"，
  同时保留本面板的蓝色配色（不抄 GitHub 的绿色）。现在：
  - **固定尺寸日历**：每格 **10×10 px、2 px 间隙（12 px 列距）**，不再随面板宽度拉伸
    （0.4.4 的 21–25 px 变宽格子是上一轮的形状）；371 天 = **53 个整周列**，
    视图一次请求 `days: 371`，resize 不再重取。
  - **横向滚动只发生在图内**：面板比日历年窄时只有 `.mem-heat-scroll` 滚动
    （细 token 滚动条），页面本身任何宽度都不出现横向滚动；首次挂载把滚动位置钉到
    最右（当前周），后续刷新不会把读者滚回去。
  - **月份与星期标签**：月份行按 GitHub 的间距规则标注（首列，其后每次月份变化且
    距上一个**已标注**列 ≥3 列才再标；实测 13 个标签、0 重叠）；左侧 **一/三/五**
    星期槽位 sticky 在滚动区左边缘。
  - **悬停 tooltip**：格子悬停显示 `YYYY-MM-DD · n 条`（0 显示"无记录"），
    在 `.mem-heat` 内按**测得的自身宽度**做边缘夹取（第一版只夹中心点，实测在
    320px 面板左右各溢出 43.5/44.1 px；现在左右边距 6.45/5.87 px），滚动与
    mouseleave 时隐藏；同时去掉原生 `title`，保证只有这一个 tooltip。格子仍带
    `aria-label`，网格仍是单个 `role="img"`（10 px 格子低于 24 px 焦点下限，
    不做键盘网格）。
  - 配色仍是 business-primary 的 28/50/72/92% 蓝色阶，空值为 label-secondary 16%。
  - 证据：184 项自动化检查 **184 PASS / 0 FAIL**（320/375/480/590/659/660/720
    七个宽度）：格子恒 10×10、列距 12、7 行 82 px；滚动盒 client/scroll
    292/648 … 692/692；初始 `scrollLeft == maxScrollLeft`；两种滚动状态下
    `documentElement.scrollWidth == innerWidth`；标签无重叠。真实 payload 的
    371 天 activity 系列 6,400 B。

- **最近变化改成 GitHub contribution-activity 的竖线时间线。** 原来是 8 行扁平列表；
  现在是 `ol.mem-timeline > li.mem-timeline-group`：每组一个带 note 图标的 12 px
  节点、连续 1 px 竖线、组内每行一个 6 px 圆点 + 标题 + `类型 · 状态`。按记忆的
  `updated` 日分组（今天 / 昨天 / YYYY-MM-DD，**从字符串自己的日期部分**读，避免
  `Date.parse('YYYY-MM-DD')` 的 UTC 偏移把行标到前一天；无日期行进最后的"未知"组），
  日期组按新到旧排序。真实 payload 是 1 组「今天/8 条」；6 天 fixture 验证了
  「今天 2 / 昨天 1 / 2026-10-29 2 / 2026-10-21 1 / 2026-09-30 1 / 未知 1」
  六组的竖线连续性（节点中心 x=20、相邻组盒间距 0、每组 `::before` 高度等于组盒高度）。

### Changed

- **概览的活动窗口扩展为整年，线上限从 16 KiB 提到 20 KiB。** 路线
  `ACTIVITY_DAYS_MAX` 182 → **371**（84..371 钳制，缺省/非法仍回落 84），
  `lib/index-stats.js` 的 `MAX_ACTIVITY_DAYS` 365 → **371**（53 个整周；
  两个上界互相镜像，任何一边单独移动都会让真实宿主要么裁掉日历、要么直接拒绝概览读）。
  `CEILINGS.overview` 16 KiB → **20 KiB**：实测 371 天 activity 系列 6,399 B、
  真实 182 天概览回答 10,697 B、同一回答装真实整年系列 **13,910 B**（余 6,570 B）；
  新增的"满年 fixture"（371 天、每天两位数 created/updated 加真实形状的
  counts/tags/recent/digest）**15,209 B** 且**不被裁剪**。若仍停在 16 KiB，
  `shrink()` 的第一级就会把宽窗口收回 84 天，热度图会静默缩回 12 周。
  `shrink()` 顺序不变。

- **README 双语对重写为 1.0.0 形态（两份文档仍然对等）。** 参考 DSH 生态插件的
  README 结构补上：顶部徽章与一句话定位、**亮点表**（从纯 Markdown 记忆、协议/适配器、
  六个工具、混合检索、蒸馏与整理，到实时记忆面板与知识图谱）、**截图**一节（概览的
  GitHub 式活动日历、最近变化活动轨、健康仪表盘与就地结果、检索、图谱；图片放在仓库
  根 `assets/`，不进 npm 包）、以及把面板与图谱拆成 `#### 概览 / 最近变化 / 健康 /
  图谱` 四个小节。图谱部分改正了一个早已过时的说法（"最多显示 500 个节点"——0.4.3 起
  画全部节点），并写清 0.4.x 的实际能力：全量投影 + 视口剔除、Obsidian D3 回退的 1:1
  移植（位置逐点一致、真实 1,236 节点不合并、静止最小邻距约 112）、设置按 origin
  持久化、读/写/检索/注入召回的图谱提示。releases 一节新增 **1.0.0 兼容承诺**的说明。

### Fixed

- **「整理热层」与「发布项目摘要」在桌面版报 "same-origin request required"。**
  根因不是 CSRF 校验写错，而是桌面 GUI 的传输层：DSH 桌面版用 `dsh-app://` 自定义
  协议装载界面，主进程的 `forwardWebRequest` 在转发到 loopback 之前删掉
  `host`/`origin`/`cookie`/`sec-fetch-site`，于是每个面板 POST 到达路由时都**没有
  Origin**；而会话/绑定等读请求因为 `trusted()` 容忍缺 Origin 而正常工作，只有
  preview/confirm 的"必须有 Origin"栅栏把它们全部 403 掉。在真实宿主上用 curl 复现：
  无 Origin → 403 forbidden，带 Origin → 200。
  修复：变更请求现在要求 JSON content-type，并且**要么**带匹配的 Origin（`trusted()`
  已经比对），**要么**带面板自己的 `x-obsidian-mem-panel: 1` 头。为什么这仍是同源栅栏：
  网页无法在没有预检的情况下发送自定义头或 application/json，而这条路由从不应答
  预检；`trusted()` 仍强制 loopback + Host + sec-fetch-site。客户端在每次面板 POST
  上带该头；两半的标记字面量由一条读两个源文件的测试钉住。真实路由探针的栅栏矩阵：
  无 Origin 无头 → 403；无 Origin 带头 → 通过栅栏；坏 Origin → 403。

- **「新建与更新」柱状图从左边开始。** 窗口按宽度仍是 12..26 个周日开头的周，但
  只在**开头**丢弃 `created + updated === 0` 的空周，所以第一根柱子落在 x = 0
  （实测 320px 下 firstBarX 从 72 → **0**，6 个数据周画 6 根柱），中间的安静周和
  窗口尾部的周都保留；分节标题改报裁剪后的周数（真实数据 `近 6 周净增 831`），
  总量仍覆盖线上窗口的全部周，全零时的空句子保留完整窗口周数。
  柱子的屏幕宽度也加了上限（再长的窗口不会把每根柱压成细线，再短的窗口也不会把
  6 根柱拉成 65 px 的色块）。

- **热度图 tooltip 的边缘夹取。** 见上面 Added 里的 tooltip 一条：第一版只夹中心点，
  实测在 320px 面板上左右各溢出约 44 px；现在按测得宽度夹取盒子边缘。

- **最近变化竖线的对比度**：第一版竖线用 `border-l1`（实测约 4% alpha，在截图里几乎不可见），
  现在改用 `label-secondary` 22% 的 1px 发丝线，仍连续、仍只用 token。

- **健康视图零改动**：320/375/659/720 四个宽度下五个分节的 y/高度与基线逐项一致。

- **打开面板时的启动竞态不再被误报为「记忆接口未就绪（路由未注册）」。** 用户重启 DSH 后第一次打开面板
  会看到「重启 dsh 后重试」。根因有两层：面板的 `post()` 把**任何** 404 都当成"路由未注册"并置为
  fatal（停止轮询）；而路由又把 `session-missing` 映射成 404 —— 启动瞬间面板可能先于插件路由/会话
  就绪而发第一次读（这不是永久故障，一秒内就会好）。实测：不存在的 sessionId 让路由回
  `404 {error:{code:'session-missing'}}`。修复：
  - 路由的 `session-missing` 改为 **503**（`error.code` 与文案不变），404 从此只表示"这条 HTTP 路由
    确实不存在"；
  - `post()` 遇到 404 先读响应体：带 `error.code` 的信封按编码错误处理（兼容旧宿主仍回 404 的
    session 错误），只有无信封的 404 才是路由缺失；
  - 轮询在拿到第一份数据之前把 `route`/`session-missing` 当**瞬时**状态：不清空、不置 fatal，
    额外做约 1 秒一次的快速重试（连续最多 20 次，与 15 秒轮询并存），期间用 `role=status`
    显示「记忆接口正在启动，正在重试…」/「会话正在恢复，正在重试…」；只有快速重试用尽后才回落到
    原来的重启提示。测试：plain-404 → 快速重试后恢复、旧宿主编码 404 → 会话重试、20 次上限后
    的文案、瞬时状态不产生 alert。

- **「整理热层」「发布项目摘要」给出可见且诚实的反馈。** 用户在健康页点这两个按钮后"感觉没反应、
  看不到整理痕迹"。实测两件事：
  - **发布项目摘要确实在工作**：确认后 `_meta/digest.md` 的内容 SHA-256 与 mtime 都变了
    （`status: updated`，1,625 字符），只是唯一的成功提示在**页面最顶部**，用户站在热层/摘要卡片
    处根本看不到；
  - **整理热层这一步是设计上的 no-op**：热层 5,728 码点 < 触发线 6,030，`planArchive` 在未超过
    触发线时不搬出任何条目，所以确认结果就是搬出 0/折叠 0/回收 0 —— 但旧预览却写着
    「可搬出 14 / 本次最多搬出 14 条」，把人误导成"会整理一批"。
  修复：
  - 预览按 `used <= trigger` 说真话：warning 写明「热层暂未超过触发线（5,728 / 6,030 码点）：
    本次整理不会搬出任何条目」，effects 不再承诺搬出数量，只说明可能折叠旧式逐条指针行；
    超过触发线时保持原来的承诺；
  - 健康页把每个操作的结果**就地**画在拥有该按钮的卡片里（热层/今日摘要/队列），带操作时间
    （`role=status`），不再依赖页面顶部提示；按钮在预览/确认期间显示「整理中…/发布中…/重试中…」；
  - 结果文案：未搬出 → 「未搬出内容：热层 5,728/9,000 字符，未到触发线 6,030（超过触发线后才会
    归档条目）」；搬出 → 「已整理：搬出 N 条、折叠 M 行、回收 C 字符」；摘要 → 「摘要已更新：
    path（N 字符）」/「摘要无变化：内容与上次一致，未写入文件」；
  - 热层卡片在按钮旁提前显示「已超过触发线（会归档条目）/ 未到触发线（整理不会搬出条目）」；
    服务端 `mutateHot` 结果补 `trigger` 字段（admin compact 的 hotStatus 已带，零额外读取）。

- **最近变化不再只剩"今天"。** 用户反馈记忆改动多时只能看到今天的分组。根因是路线固定返回
  `index.recent({limit: 8})` 的 8 条最新笔记，而忙碌的一天里这 8 条可能全是今天（实测该 payload
  8/8 行 `updated`=2026-10-31，同日 digest 报 45 条新建）。修复：
  - 路线改为**按天取样**：内部扫最近 500 条（`RECENT_SCAN_LIMIT`），按行 `updated` 的日期分组，
    取最新 **4 个不同日期**、每天最多 **2 条**，线上 `recent` 数组形状与长度（≤8）不变，所以
    16→20 KiB 的 payload 上限不受影响；无 `updated` 的行进最后的"未知"桶，且不会挤掉有日期的天；
  - `lib/index-db.js` 的 `recent()` 内部上限从 50 提到 500（只放宽内部扫描，返回给浏览器的仍然 ≤8 条）；
  - 客户端用概览已有的 371 天 activity 系列算每天的总变化数：被抽样的天显示「共 N 条」+ 一行
    「仅显示最近 K 条」；最坏情况（抽样 8 条仍全是同一天）再从 activity 补最多 **2 个更早的日期**
    作为只有日期和「共 N 条」的汇总组，未知组仍在最后。测试：忙碌日 fixture（今天 45 条只抽 2 条、
    昨天 7 条抽 2 条、更早两天各 2 条）断言分组、计数、抽样提示与顺序；另有一条"全部行都是今天"
    的 fixture 断言补出的两个汇总组。


### Untested / known limits for this round

- 桌面 Electron 侧栏本身没有重新截图：仓库文件是桌面 profile 的硬链接快照，本轮改动
  需要**完全退出 DSH 重开**后才会出现在用户的侧栏里；验证用的是真实 view 模块、
  真实样式表、真实宿主 tokens 在 headless Chrome 里的渲染与真实路由探针。
- 运行中的宿主仍然挂着旧路由；371 天窗口与 Origin 栅栏是用真实代码的 loopback 探针
  证明的，不是在运行中的 GUI 里点按钮证明的。
- 实时刷新与两个维护按钮的真实浏览器点击没有端到端跑过（各自有单元测试覆盖）。
- 本轮（round-5）的三个 bug 都用真实运行宿主复现过（curl）：不存在的 session 回
  `404 {code:'session-missing'}`；`compact-hot` 确认回 `moved 0/folded 0/reclaimed 0`
  （5,728 < 触发线 6,030）；`refresh-digest` 确认真的改写了 `_meta/digest.md`
  （内容 hash 与 mtime 变化，1,625 字符）。**修复后的服务端行为**（503 session 状态、
  按天取样的 recent、预览文案、`mutateHot.trigger`）由单元测试覆盖，但真实宿主仍需
  重启加载新代码后才能在 GUI 里点按钮做端到端复验；客户端新 UI（就地结果、按钮繁忙文案、
  启动重试提示）由面板测试覆盖，未在真实侧栏里重新截图。
- DPR ≠ 1、Windows 字体、<320px 与 >720px 面板宽度没有覆盖。

## 0.4.4 — 2026-10-30

### Fixed

- **图谱 1:1 复刻 Obsidian 的模拟器，移动中的节点也不再挤成环带。** 用户重启后反馈：
  静止时的环带已减轻，但**只要节点在动**（刚进入页面、拖拽加热）又复现；要求按 Obsidian
  实现一比一复刻。根因是此前两处本地改动：`client/graph-worker.js` 在 d3 fallback 上
  加了 `distanceMax(2500)`/`theta(1.2)`，并按节点数换用/丢弃碰撞；`lib/graph-renderer.js`
  给冷启动加了 phyllotaxis spiral 播种（Obsidian 没有这个分支）。这次按本机 Obsidian
  1.14.4 的 `obsidian.asar` 提取件重做：`/sim.js`（17,693 B，sha256 `549be2f…`，与
  2026-09-28 记录相同）的 d3 fallback 逐常量照搬（forceX/Y 0.1、link 250、charge
  -1000/distanceMin 30、collide 60/0.5 始终开启、alpha 300 步、velocityDecay 0.6），
  删除了大小策略与网格碰撞；`app.js` 的 `setData` 播种规则（邻居均值 ± sqrt(3600·新增)
  抖动；无已放置邻居时随机角 + 环）与拖拽消息（alpha .3 / alphaTarget .3 / 释放
  alphaTarget 0）也按原样复刻，删除了 spiral 冷启动。验证：同一 400 节点/592 边真实
  子图、同一初始位置，300 tick 后新 worker 与 Obsidian `sim.js` fallback 的节点位置
  **逐点完全一致（max/mean delta = 0.000）**，旧 worker 相对它最大偏差 530.1、均值
  144.5；真实 1,236 节点初始布局动画帧（480×800，t=150/350/700/1400/3000 ms）的
  最小对距 2.2/1.6/2.8/11.0/10.7 → **7.6/15.6/19.1/29.7/36.5**，静止后最小邻距中位
  仍约 112。未复制 Obsidian 的 wasm 模拟器（其自有二进制）与 SharedArrayBuffer 快路径；
  fallback 的 quadtree 碰撞在超大图（>2000 节点）比此前的本地调优慢，这是 1:1 行为的
  代价，Windows 性能未复测。测试：`test/graph-worker.test.js` 的策略用例改为 parity
  不变量（902 叶子密环最小对距 > 40），`test/graph-renderer.test.js` 新增「冷启动播种
  与 app.js 一致、拖拽协议与 app.js 一致」用例；记录见 `docs/obsidian-graph-source.md`
  2026-10-31 节。

- **概览「新建与更新」的「更新」不再恒为 0。** 根因是 `lib/index-stats.js` 的
  `bucketOneDay` 把互斥做在了**窗口**级：只要 `created` 落在窗口内就直接 `return`，
  永远不再计 `updated`。概览用 84 天窗口，而本 vault 的 950 条笔记全部创建于窗口内，
  于是 13 周的更新柱被数学上钉死为 0——同一份数据「健康」页今日摘要却能报出 5 条更新，
  两个视图自相矛盾。修复改为**同日互斥**：同日创建 + 编辑仍算一次创建，跨日编辑算一次
  更新（即使创建也在窗口内）；`lib/digest.js` 的 `renderDigest` 对齐同一规则，digest
  的 days=7/30 也不再出现「窗口越大更新越少」的非单调。真实 vault 只读复算：84 天
  created 950 / updated **0 → 142**（123 条 supersede 重链 + 13 条正文编辑 + 6 条 hub
  维护写），digest days=30 的 updated 13 → 40。注意这仍是「frontmatter `updated` 有
  变化」的口径；只看正文编辑是 13 条，若要更窄口径需另定。
  `test/index-stats.test.js`（28）与 `test/digest.test.js`（16）新增三情形回归，
  旧实现 red、新实现 green。

- **标签频率的长名字不再被直接隐掉。** 0.4.3 的 treemap 判定
  `box.w < nameWidthOf(name)` 要求**完整名字**的预测宽度，而宽度模型把 latin 预估为
  9 px/字符，真实字体（11px）实测只有 5.0–6.4 px/字符，多预测 32–52%：用户 659px 面板
  下 24 个块只显示 16 个名字，被隐的 8 个里 7 个其实放得下（`verification` 实测
  60.01px vs 块内宽 79px），最大块 `obsidian-mem` 的名字只在 581–707px 窗口出现
  （580px 时差 0.1px），更窄或更宽都消失。修复：宽度模型校准为
  `{cjk:11, latin:6.6, digit:7, other:5.6}`，判定改为「完整名字放不下**且**块宽 < 44px」
  才降级为只显示数字；其余一律渲染名字，溢出交给既有的 CSS 省略号（`title` 与
  `mem-sr` 全量清单不变）。真实 payload 实测各宽度显示名字数 320/375/480/590/659/720
  = 3/4/10/18/16/17 → **8/15/20/23/24/24**，659px 下只剩 `dsh-obsidian-mem` 一个
  省略号；旧的「破碎字形」缺陷来自 26px 高度门槛，已由 41px 两行门槛解决，与宽度
  省略号无关。记录见 `docs/validation/panel-label-and-spacing-2026-10-30.md`。

- **新建与更新分流柱改成直角矩形，KPI 四格居中。** 分流柱的 created/updated 两个
  `rect` 各带 `rx:2`，圆角把两段从共享零线处各切掉一块，视觉上出现缝隙、短柱像压扁的
  药丸；几何本身已保证 `created.y + height = updated.y = 40`，删掉 `rx` 后两段在零线处
  干净相接（测试钉住：无 rx、同周两段下沿 = 上沿 = 零线、x/width 一致）。KPI 四格此前
  左对齐，宽面板下每格右侧大片留白、整组看起来偏左：`.mem-kpi` 改 `align-items:center`，
  sparkline 限宽 120px 并随格心居中——659px 实测四格中心 x=93.63，标签/数值行/spark
  中心都对齐到 93.63；320px 的 2×2 布局与区块高度不回归。

- **概览的搜索框与首块内容之间的间距最终收到 18px。** 组合进 shell 后 viewhead 被隐藏，
  `.mem-kpiline` 作为第一张图的 14px 顶部间距没有撤掉，与搜索行 10px 底部内边距、
  `.mem-view` 18px 顶部内边距叠成 42px（健康/检索/图谱首内容当时是 28px）。两轮修复：
  先把首个 `.mem-kpiline` 的 margin 归零（42→28），再把 `.mem-view` 顶部内边距 18→8
  （28→**18px**）——搜索行 10 + 正文 8，四个视图共用同一条内边距，实测
  320/375/480/590/659/720 全部 18px。

- **活动热度图随面板变宽展示更长时段。** 旧实现固定 12 周、`max-width:292px` 居中，
  宽面板两侧各空出约 169px。现在视图一次请求 `days:182`（26 周），按测得正文宽取尾部
  整周切片（12→26 周，cell 约 21-22px），grid 填满正文：实测 320px 292/12 周（不变）、
  375px 347/15、480px 452/19、590px 562/24、659px 631/26、720px 692/26（24.7px 封顶），
  无横向溢出；flowBars 共用同一窗口（659px 下 viewBox 140→308，每柱约 16.4px 仍有
  自己的周 title）。路由新增 `days` 参数并把窗口钳在 84..182（缺省/非法→84，>182→182，
  旧视图不发 days 时行为完全不变），`shrink()` 第一步先把超设计窗口的 activity 收回
  84 天再走原 §3.6 顺序。真实数据 182 天 envelope **10,704B**（84 天 9,038B），距 16KB
  上限余 5,680B；84 天复算与实时 payload 逐字节相等后扩窗验证。

## 0.4.3 — 2026-10-30

### Added

- **图谱画出范围内的每一个节点，不再按连接数截断。** 之前路由传 `limit: 500`，
  投影再按度数排序取前 N 并回一个 `truncated` 标记，节点一多就变成"只显示最能连的
  那一小撮"——被藏起来的节点连同通向它的边一起消失，因为一条边指到一个没画出的
  目标时，那条边也就没人能看见。现在 `index.graph()` 省略 `limit`（默认 `null`）即返回
  整个投影，路由不再传上限，`truncated` 只在调用方显式要一个有界页时才可能为真。
  约束从一个"数据层丢事实"的问题变成一个"渲染层丢工作"的问题：画布逐帧剔除视口外
  的节点、边和标签，这是唯一能在不丢事实的前提下丢弃计算的层。验证：
  `test/graph.test.js` 双后端新增一例，断言无 limit 时 `nodes.length === total`、
  25 条孤立笔记与被链接的笔记同时在列、`truncated === false`，并保留一例证明显式
  `limit: 2` 仍返回有界页且 `truncated === true`；`test/panel-client.test.js` 断言路由
  不再传 limit、面板不再带截断词汇、以及"N 个节点 · M 条连接"的读数。

- **健康页从台账变成仪表盘。** 用户的原话是"健康的部分文字也太多了，我更多的是需要图"。
  索引卡的 6 行 `<dl>` 变数字格、队列的 3 行 `<dl>` 变排队/失败/延迟堆叠条、热层的
  逐区 `<ul>` 变区域字符堆叠条、摘要的 8 条 findings 变严重度横条（最多留 3 条 + 余项）、
  诊断的 20 行时间线变事件类型频率横条（最近 3 条）。摘要带本身是四格仪表：每格一个
  读数加一条按状态着色的计量条。每节实测文字行：索引 0、队列 ≤1、热层 0、摘要 4、
  诊断 3。所有读数仍由数字承担，色相只做身份——这是仓库自己的调研结论（面积与色相
  是精度最低的通道，不许单独承载数字）。

### Changed

- **标签频率改成 squarified treemap。** 原来的 8 行横条把同一批标签画了又画、把长尾
  整条藏掉，且与"构成"图重复表达同一件事。现在 292×148 的矩形被精确铺满（面积 ∝
  出现次数，逐块可验：面积和等于容器、两两不重叠），24 个标签连长尾一起可见，每块
  印自己的次数。标签页上限由路由从 12 提到 24；`distinct` 仍是真实余数，所以"另有 N
  个标签"仍是标签个数而不是出现次数。

  关键实现细节，都是测量逼出来的：瓦片印**标签叶**而不是完整名字
  （`dsh-mem/convention` 在 11px 粗体下要 ~120px，24 标签的图里没有任何一块有那么宽；
  完整名字仍在 native `title` 与永不截断的 `mem-sr` 清单里）；`is-minor` 按每块**自身**
  宽高判定，不按排名切——排名切会在第 9 名的窄条印名字、第 10 名的宽块留白。

- **窄面板的两处实测缺陷修好。** `@container` 断点原来是 `max-width:359px`：359px 时图标
  隐藏、三个 24px 标签刚好放得下，而 360px 图标复活吃掉 22px、标签只多拿 6px，于是
  **360 反而比 359 更挤**（实测 280–307px 与 360–374px 两段共 40 个宽度点全部是省略号）。
  断点改为 374px 并同时收紧叶片 padding 与条带 gap，280–480 逐像素扫描截断归零，375+
  完全不变。分区标题在 ≤320px 把"活动热度"折成"活动热/度"，因为 flex 行让标题与右侧
  读数各自 `flex-shrink:1` 且 `white-space:normal`；改为让**行**换行、标题不拆字、读数
  溢出时右对齐落到第二行，视图头同构同修。两处都有注入式 A/B 与逐像素复测。

- **图谱布局按规模自适应，实测数据支撑。** 逐 force 计时（4000 节点 300 tick）：charge
  占 72%、collision 26%、link 0.9%——能动的只有前两个。charge 加 `distanceMax(2500)` 与
  `theta(1.2)` 后 2000 节点单 tick 32.7→9.7ms、4000 节点 50.2→20.9ms，而布局几乎无损
  （800 节点最小间距 108.8px、零重叠）；`distanceMax(600)` 不采用，它会把铺开尺寸从
  5597 压到 3158。节点数超过 800 时关掉 collision（>1500 再把 alphaDecay 减半），2000
  节点收敛 9.86→3.10s、4000 节点 15.06→6.76s。稳定后 worker 直接停止 tick，所以天花板的
  真实代价是进场那几秒与拖拽重升温；约 1500–2000 节点是"全画"可用的上限，4000 需要
  布局缓存，不在本轮。

  **第一次进场也不再是一团随机云**：旧规则把新节点种在已落位邻居的均值处，那对"一次
  加一个"是对的，对"整张图同时到达"则每个节点都没有已落位邻居，于是全落在越来越大的
  环上的随机构点。现在冷启动用黄金角螺旋播种（与力模拟自己给未定位节点用的同一
  打包），第一帧就已经是一张图。

- **概览图表的纯投影从 `index-db.js` 抽成 `lib/index-stats.js`。** 索引模块是仓库最大的
  一个文件（2879 行），其中日算术（`shiftDay`/`localDayOfMicros`/`normalizeDay`）、活动
  窗口与分桶（`activityWindow`/`bucketOneDay`）、项目范围谓词（`eligibleForProject`）和
  标签排名（排序 → 截断 → `distinct`）没有一处碰数据库句柄、记录 Map 或文件系统——它们
  只吃行、只回数字。这些搬走后两个后端（sqlite 与 scan）调同一份投影，而不是各自留一份
  分桶规则；这正是索引模块存在的理由（两个后端不能各说各话）从"注释里承诺"变成"代码上
  不可能"。

  新模块落在 L1 而不是 L0，唯一原因是活动窗口需要 `note-health.js`（L0）的今日本地日期；
  它不导入任何后端或文件系统。层表与预算同步各加一行，理由写在那两处，因为仓库存量文件
  的预算必须逐条论证而不是默默抬高。`index-db.js` 2879 → 2750 行。

### Removed

- **四个零引用导出与十九行无人按名导入的再导出。** `CURATION_FINDING_KINDS`（唯一引用是
  声明本身，codec 的码表靠扫 emitter 字面量、不读它）、`pointerLine`（v0.4 已改聚合行，
  解析端只读不写）、`RECALL_OUTCOMES`（只被一处注释提到，且与 `diagnostic-codec.js` 的
  真实词域已漂移——codec 多一个 `search-failed`）、`HOT_DELIVERY_SCHEMA`（与
  `delivery-state.js` 的 `DELIVERY_SCHEMA` 重复且两者都无人引用）。

- **八份逐字节相同的 `lstatOrNull` 合成一份。** 收进 `lib/fs-atomic.js`（本就是 L0 且被
  11 个模块导入的叶子），七个模块改指它。`lib/paths.js` 保留自己的副本并在注释里写明
  理由：它也是 L0 叶子且被二十个模块导入，叶子不能横向指另一个叶子——那份注释就是
  这条规则的记录，第三份会被层规则直接拒绝。

### Fixed

- **标签频率图在三处把名字丢掉了**（用户截图报告）。用这个 vault 自己的 24 个标签
  （43 次 · 27 个不同）把真实组件渲染出来量，三处缺陷各自独立、且都能复现：

  1. **最大的那块印了个光秃秃的「8」。** 判定用的是固定的 292 单位坐标系，而图上那块
     实际有 211px 宽——够放名字，但判定说不够，于是它就是 `is-minor`。读者看到的是
     一个没有标签的数字。
  2. **八块的标题被压成 2.5–8.1px 高**（正常一行是 14.8px）。旧的
     `TREEMAP_MIN_NAME_HEIGHT = 26` 只量了**一行**，而一块要同时放名字和次数需要 41px；
     26–40px 高的块于是把名字印进了装不下的盒子，得到撕碎的字符——比「只有数字」更糟，
     因为名字和数字都不完整。
  3. **图在宽面板里不再像 treemap。** 瓦片用百分比定位，宽度随面板缩放、高度不变，于是
     平均宽高比从 292px 的 1.78 涨到 590px 的 3.59。

  改法：布局改在**实测像素空间**里跑（瓦片盒就是读者看到的盒），高度由同一宽度推导
  （`0.55 × 宽`，钳在 148–300px），两行阈值改成实测的 41px，名字宽度改成**按字符类**
  预测（CJK 恰好 11px/字，小写均值 6.3、大写 7.8、数字 6.8、标点 5.5），四个数都取在实测
  均值**之上**：高估只会让一块退成「只印次数」（数字仍然准确），低估才会印出被截断的名字。
  旧模型按每字固定 6.4px 算，把每个中文词低估 72%（「可视化」预测 29.2px、实测 33.0）。

  验证：对 292/375/480/590/659 五个宽度，从真实组件里把每块发出的
  `left/top/width/height` 读出来复核——面积和恰好等于图面积（填充率 100.0%，无重叠），
  **零**块「够宽却被降级为只有次数」，也**零**块「印了名字却装不下」。有名字的块数随
  宽度上升：292px 3/24、375px 8/24、590px 17/24、659px 18/24。
  `test/panel-ui.test.js` 新增三例分别钉住这三条不变量，全量 53/53。

- **图谱 worker 的重建检查在本机从未真正跑过。** `scripts/build-graph-worker.mjs` 假设
  `node_modules/<name>/` 是扁平布局，而 pnpm 把三个 d3 依赖放在
  `node_modules/.pnpm/d3-force@…/node_modules/`，于是 `--check` 以 ENOENT 失败、测试
  以"依赖未安装"永久跳过——发布资产与上游分发的等价保证实际上一直没有被校验。现在按
  Node 自己的解析方式定位（从 d3-force 的**已解析**目录起锚，因为 hoisted 的
  `node_modules/d3-force` 是符号链接、它的词法邻居不是它的依赖），并避开 `exports` 里
  没有的 `./package.json` 子路径。测试里的 skip 探针同步改成真实解析，那一例从
  "skipped" 变成真的会失败。

## 0.4.2 — 2026-10-29

### Fixed

- **The search box painted two focus rings for one focus.** Measured from the reported
  646×162 panel capture: the 40px rounded field's border turns blue on focus (x11..579 /
  y83..122), and a second, square-cornered blue outline sat at x42..572 / y80..125 — the
  panel-wide `:focus-visible` rule ringing the square `.mem-search-input` at 2px offset
  inside the 10px-radius pill. The input now paints no outline of its own; the field owns
  exactly one rounded ring (business-blue border plus a 2px blue outline at offset 0). A
  click anywhere in the field puts the caret in the input — icon and padding included,
  while a click that starts on the clear control stays with it — and the shell's CSS
  contract test pins the three rules. A composing Enter does not submit the production
  form: a plain-page Chrome control shows a raw-key Enter during composition is suppressed
  while the CDP synthetic character event (`keyDown` with `text: '\r'`) is not — in this
  Chrome the implicit submission trigger is the char path, not the raw keydown — so the
  review harness's submit was its own artifact. No IME guard was added because no
  production defect reproduces; the control is recorded in the validation record. Verified:
  `test/panel-client.test.js` 18/18; shell capture at 646/659/320px in light and dark,
  244/244 checks — exactly one painted outline (`.mem-search-field`, 2px solid, offset 0)
  whose box is the field border-box +2px on each side (560×44 at 646px), the inner
  square's blue pixels fall to 0 (4 blue strokes per scan line become 2), and real CDP
  mouse clicks on the icon or either padding focus the input at every width. The
  reported 646×162 capture is reconciled as a crop of a 659 CSS px panel: the baseline
  capture reproduces its field box (569×40) and inner square geometry exactly.

### Changed

- **The panel tab row is the Chrome form, sized up.** The three leaves were 32px tall
  with a -8px folded-folder overlap, 10px side padding and a 15px glyph; they are now
  36px tall with a 2px gap, 14px side padding, a 16px glyph, a 180px max width, and an
  8px strip top padding that keeps the leaf's own upward hit extension at a 44px click
  target. The active leaf still merges into the content surface and the glyph still
  yields at the 320px floor. Verified: the stylesheet contract test re-derives every
  number from the emitted rules, and the shell capture measures 76×36 leaves (54×36 with
  the glyph hidden at the 320px floor), a 2px gap, a 44px tab strip band, 14px side
  padding, a 16px glyph and a 44px hit area; the pre-fix row measured 66×32 with the -8px
  overlap, a 38px strip, 132px max width and a 15px glyph.

- **概览 构成 is a Sankey built from real joint type×status counts.** `index.stats()` now
  carries `flow` — one row per non-zero type×status pair (`n DESC, type ASC, status
  ASC`, the same `untyped` normalization as the two margins) — from both backends: one
  scoped GROUP BY on SQLite and a nested count in the scan backend's existing
  eligible-row loop. The chart draws only when the flow is present and its margins agree
  with `byType`/`byStatus`: nodes and links share one unit-per-note scale (a node's bands
  sum to its own height; both columns total the section head's number), names and counts
  are real `<text>`, every mark carries its exact number in a native `<title>`, and
  colour is the type's rank over eight distinct tints (the status column's neutral is
  deliberately a shade the type palette does not use, so the two ends never read as
  one list), and a sliver cluster's labels are laid out in two passes so the rows
  stay monotonic — the single pass could draw two labels 2px apart at 320px. A row
  the clamp had to displace is tied back to its mark with a 1px leader line (no
  leader when the row already sits on the node centre). The chart's coordinate width
  is the MEASURED block width, so it fills a wide panel — and follows it when the
  sidebar is resized — while its 11px type and one-unit-per-note geometry stay 1:1;
  the side label bands hug the edges and only the middle link span grows (height
  fixed at 200). The flow is also refused when the two columns and the
  payload's note count disagree with each other. The wire is all-or-nothing — the
  overview trimmer drops `flow` whole before halving either margin — so a partial chart
  is impossible, and an older host falls back to the unchanged stacked bar + legend.
  Verified: `test/index-stats.test.js` 26/26 on both backends, `test/panel-ui.test.js`
  49/49 (hand-written geometry, label-leader association, responsive width, truncation,
  margin-mismatch and fallback branches), `test/panel-route.test.js` 28/28 (trim order
  and the 16 KB ceiling), and the 概览 capture at 320/375/659px in light and dark:
  514/514 checks. Seeded at each viewport's real content width (292/347/631) the svg
  renders 1:1 in both axes — viewBox `0 0 W 200`, height 200 at every width, 11px type,
  the right band at W−88/W−76/W−78/W−40, nothing outside the viewport — while node
  heights, label rows and link thickness are bit-identical across the three widths
  (10 nodes / 12 links, both columns 164 units = the printed `515 条`, 8 distinct
  fills). A separate DOM probe mounts the real view and resizes the block
  320→659→320→500: viewBox 292→631→292→472 with no reload, 15/15 checks
  (`docs/validation/panel-shell-sankey-2026-10-29.md`).

## 0.4.1 — 2026-10-29

### Fixed

- **Review round: seven behaviour bugs, each one measured before it was fixed.** An
  independent review of `2f4d69f..HEAD` drove the real views through instrumented
  `fetch` and found these; every fix has a test that fails on the old code.
  1. **The heat map dropped real days.** An 84-day window spans 13 partial columns
     unless it starts on a Sunday, and `slice(-12)` discarded the head column — real
     data, not padding. Measured: 84 events rendered as 82 cells, so this chart
     printed 合计 82 beside a flow block reading 净增 84. The grid now draws every day
     of the window (column count follows the calendar), the meta names the window
     (`近 N 周（84 天）· … · 合计 M 条`), and a test asserts 合计 equals the series sum.
  2. **"另有 N 个标签" counted occurrences as tags.** Measured: "另有 4 个标签" where
     two tags existed. `tagFrequencies` now also returns `distinct`, and the remainder
     is `distinct − shown`; the old test computed its expectation with the same wrong
     formula, so it encoded the bug — it now uses ten tags of five occurrences each.
  3. **The unbound→all fallback spent a third request and erased its own notice.**
     The view both reported the scope change and re-ran; the shell's props change then
     started a fresh run that cleared the notice. Measured scopes: `project,all,all`,
     notice visible: false. The view now reports only, shows the notice immediately,
     and carries it into the single shell-driven run — asserted as two requests with
     the notice still on screen.
  4. **The composition bar's "3-段上限" did not exist.** It emitted one segment per
     type and aliased the seventh back to the first colour; its guard passed only
     because the fixture had exactly three types. The track now carries three real
     segments (two named types plus 其他) with three distinct tints, the legend still
     lists every type, and the test uses seven types and asserts distinct colours.
  5. **The heat map's `<title>` was inert.** `<title>` inside a body-level `<span>`
     produces no tooltip, and it carried no date. Each cell now exposes
     `title`/`aria-label`/`sr` text with date and value, and still takes no `tabIndex`.
  6. **`onClose` was passed and never used, and `limit` had two owners.** "显示更多"
     ran with 50 while the shell kept 25, so a retry on that page silently dropped to
     25 rows. `onLimit` now moves the page size in the shell's one search object, and
     `onClose` is honoured by a 返回 action in the results head.
  7. **Spec/plan corrected where they contradicted the shipped code** (heat-map column
     count, cell reading mechanism, segment cap, `distinct`, and the real `SearchView`
     signature) — recorded as a revision entry in §8 rather than silently rewritten.

  Also removed: the dead `.mem-stamps` rule (its producer `statusStamps` was retired)
  and the unstyled `mem-heat-legend-label` hook; corrected `lib/client.js`'s budget
  comment, which still claimed 1182 measured lines against a 1247-line file.
  Verified for that round: `node test/panel-ui.test.js` 32 pass,
  `node test/panel-route.test.js` 26 pass, `node test/index-stats.test.js` 21 pass,
  `node test/architecture.test.js` 8 pass, eslint and prettier clean. That round left most
  of the Minor findings (M1–M7, M10–M12; M8, M9 and part of M10 were already closed) and the
  320px re-capture open; the round below closes both.

- **Review round 2: the twelve Minor findings, the 320px capture that was missing, and one
  host token the panel had invented.** Same review, same method: each item was read in the
  code before it changed, every behavioural fix has a test that fails on the old code, and
  the comment-only items were re-read against the code they describe (M3 against
  `lib/digest.js:200-202`). M10 and M11 are the two items whose proof is a measurement rather
  than a failing test — the extraction count and the skip counts quoted below — and the
  sentence that claimed otherwise was wrong; an independent re-review caught it. The review's
  numbering is kept (M1–M12); the first round had already closed M8, M9 and part of M10.
  1. **M1/M2/M3 — the activity block's own comments were wrong.** `activityRequest` took a
     `state` parameter its body never read; `MAX_ACTIVITY_DAYS` was documented as "twelve
     weeks — the heat map's column count" while holding 365; and the created/updated
     mutuality rule was documented as *reusing* `lib/digest.js`'s predicate when it
     re-implements it. The parameter is gone, and both comments now say what the code does:
     the digest applies the same rule, this reader deliberately duplicates it because the
     spec additionally requires the file-mtime fallback for `created`, and the two must be
     kept in step by hand. The architecture budget comment that repeated the "shared with
     the digest" claim is corrected too.
  2. **M4 — the heat map's void cells had no `aria-hidden`.** The grid's `role="img"` already
     hides them from assistive technology, but the acceptance criterion names the cell; each
     void cell is now `aria-hidden` and still takes no `tabIndex`.
  3. **M5 — the chart container was smaller than the design's own floor.** `.mem-heat-grid`
     was capped at 262px, below §6.6's 280px. The cap is 292px = the 320px support width
     minus the view's 2×14px padding, so the grid fills its content box at the floor and
     stops the squares stretching on a wide panel. Measured at a true 320px viewport:
     `.mem-heat-grid` `clientWidth` **292** (see `docs/validation/panel-charts-2026-10-29.md`).
  4. **M6 — the sparkline was drawn per day, not per week.** It plotted 84 points into a
     60×16 box; design §3.4 item 1 asks for twelve. It now sums `created` per seven-day
     chunk and accumulates (folding older weeks into the first point when the window exceeds
     twelve, so the last point stays the window's total), and the tests pin point count,
     monotonicity and the plotted values for both the 84-day and the 365-day window.
  5. **M7 — the flow-bar reading was a bar ordinal, not a week.** `<title>` now reads
     `WW 周 · 新建 n · 更新 m`. The re-review below then showed that the first version of
     this fix named a week its seven-day chunk straddled, so the bars themselves are now
     the calendar weeks the heat map draws — 12 or 13 per 84-day window, each labelled with
     its own Sunday-first week number.
  6. **M10 — the chart classes were not covered by the class-coverage guard.** The list now
     guards all 108 classes the views emit (24 were unguarded), the test derives that set
     from `lib/memory-panel.js` on every run so a new or renamed class fails, and every one
     has a stylesheet rule.
  7. **M11 — the backend-parity test passed silently without `node:sqlite`.** `if
     (!HAS_SQLITE) return` is now a reported skip in `test/index-stats.test.js`, and in the
     same pattern in `test/search.test.js` (found while fixing it). Proved with Node's own
     `--no-experimental-sqlite`, which reports the test as skipped with its reason instead of
     a green that proves nothing.
  8. **M12 — assertions that could not fail on a behaviour change.** The tablist, tabpanel
     and search-box checks now mount the shell through a four-hook React stand-in and drive
     state, focus and search-mode transitions; six mutation probes each failed the intended
     test before the probe was reverted. The `mem-stamps` tombstones and duplicate substring
     checks are gone; the three remaining source-shape seams (dynamic-import wiring,
     served-view props, retired ids) are narrowed and commented as such.
  9. **The search field named a host token the host does not define.** `--dsw-font-xs-regular-13`
     appears nowhere in the installed DSH build (405 `--dsw-*:` names); the real token is
     `--dsw-font-xs-13` (`13px/20px var(--dsw-font-family)`). The invalid `font:` shorthand
     made the input inherit 12px. Fixed, and guarded: a new test requires every
     `var(--dsw-*)` the bundle reads to equal a measured 24-name allowlist (fail on an
     unverified name *and* on a stale entry).

  An independent re-review of that round then returned NOT YET with three Important findings
  and nine Minor ones; all twelve are closed here. The re-review's own records are
  `.superpowers/sdd/2026-10-29-memory-panel-charts/review2.md` and `review3.md`.
  1. **The new flow-bar title named a week the bar did not cover.** The bars were trailing
     seven-day chunks counted back from the window end, labelled with the ISO week of their
     first day: the fixture's first bar covered 2026-08-07..13 but printed "32 周" while four
     of its seven days are ISO week 33. The bars are now Sunday-first calendar weeks — the
     same buckets the heat map draws — so `WW 周` is the bar's own week. The numbering is
     defined (week 1 is the Sun–Sat week containing 1 January; 52 or 53 weeks a year) and
     deliberately not ISO 8601, because ISO weeks are Monday-first while the design fixes
     Sunday-first weeks and the two charts must not disagree about where a week starts.
     Partial edge weeks are drawn, not dropped, exactly like the heat map's edge columns; the
     geometry, the meta and the empty-state sentence all derive from the grouping.
  2. **The class-coverage guard was a frozen list.** It read only the stylesheet, so adding a
     view class kept the suite green; the test now extracts the emitted classes from
     `lib/memory-panel.js` and requires them to be guarded, with the extraction count pinned
     so a blind scan cannot pass vacuously.
  3. **The 320px record was not in the repository.** It is force-added with this change, like
     the three validation records before it, because the CHANGELOG cites it as the evidence
     for the measurement.
  The nine Minors were: an 84-day sparkline test that recomputed its expectation with the
  implementation's own grouping (now hard-coded, plus a 30-day window where the grouping
  direction is observable); two arithmetic slips in the architecture budget comments (the
  "before" figure was the pre-first-wave commit, and 1292 rounds to 1300 by the rule — the
  1350 ceiling is kept deliberately, not re-derived); a stale `heatmap()` header that still
  described fixed 6px cells; no automated coverage for the two round-1 callbacks (`onClose`'s
  返回 and `onLimit`'s 显示更多 now have behavioural tests); a floor test that hard-coded the
  padding its bound was derived from (it now reads the `.mem-view` rule); a claim — "every fix
  has a test that fails on the old code" — that was false for the comment-only and
  measurement items (corrected above); the round-1/round-2 wording about what was still open;
  an unreachable week-of-year fallback; and a capture taken against the pre-fix stylesheet
  (re-run against the final tree, and the record now names the revisions it captured).

  The 320px claim is now a measurement, not an inference:
  `docs/validation/panel-charts-2026-10-29.md` renders the real `OverviewView` and the real
  stylesheet under the host's own light/dark token values at emulated 320px and 375px
  viewports (CDP device emulation — note that Chrome's `--window-size=320` clamps the layout
  to ~500px and crops, so the old recipe cannot prove a 320px layout; the page's own
  `innerWidth` is recorded in every measurement). Measured:
  heat grid / flow / ranking / composition 292px and KPI band 290px at 320px (all ≥ 280), no
  horizontal overflow at either width, 13 calendar columns drawing 84 data cells + 7
  aria-hidden void cells, 12-point sparkline, 13 `WW 周` bars whose week numbers are the
  weeks they draw. 220/220 harness checks pass, and the record names the exact `lib/`
  blobs it captured (with before/after source-stability checks) so the artifacts can be
  matched to this commit's tree. The record also supersedes the earlier captures: the
  `--window-size` recipe cannot produce a 320px layout (Chrome clamps to ~500px and crops),
  so the shipped measurement uses CDP device emulation and records the page's own
  `innerWidth`.
  Also re-measured: the architecture budget comments for `lib/index-db.js`,
  `lib/memory-panel.js` and `lib/client.js` carry the post-round figures (2839 / 2019 / 1262
  formatted lines); no ceiling moved.
  Verified: `node test/panel-ui.test.js` 41 pass, `node test/panel-client.test.js` 18 pass,
  `node test/index-stats.test.js` 21 pass, `node test/search.test.js` 33 pass,
  `node test/architecture.test.js` 8 pass, `node test/memory-panel-behavior.test.js` 4 pass,
  `node test/panel-route.test.js` 26 pass, `node test/panel-assets.test.js` 7 pass, eslint
  and prettier clean.
  Not verified: the capture renders the real view and stylesheet on a static page with the
  host's token values — it does not verify the running host's application CSS, a real vault
  payload, the host sidebar's own width, the shell chrome (tab strip/search box), the other
  views, hover/focus/tooltip rendering, or DPI scaling other than devicePixelRatio 1 (the
  validation record lists each gap); and the `--no-experimental-sqlite` runs exercise only
  the files named above, not the whole suite on a sqlite-less host.

## 0.4.0 — 2026-10-29

### Added

- **概览 now opens on five charts instead of paragraphs: a 12-week activity heat
  map, new-vs-updated flow bars, the tag ranking, the composition bar and a KPI
  sparkline.** The round's premise was that a reader wants the shape of the memory
  before the sentences, so the charts sit directly under the KPI band and each one
  prints its number in the section meta rather than asking the reader to estimate an
  area — hue and area are the least precise visual channels. The heat map is a single
  12×7 calendar (`role="img"`, no focusable cell: a 6px square is far below the 24px
  focus-target floor, so a tabbable grid would be a keyboard path nobody can use; the
  numbers live in 「近 12 周 · 本周 N 天有更新 · 合计 M 条」). The flow bars put
  created above and updated below one shared zero line, normalised to the larger
  side, and there is deliberately **no** archived/superseded series: `superseded` is
  a current status snapshot and nothing records the day a note reached it, so drawing
  it as a flow would invent a transition the data cannot prove. The ranking shows at
  most eight tags with a real remainder line, the composition bar keeps its
  three-segment cap and folds the status distribution into one line at the legend's
  tail instead of a second chip row (`statusStamps` is retired), and the KPI band's
  记忆条目 cell gains a sparkline over the **cumulative** `created` series — never
  `created − updated`, because those are different events and their difference has no
  meaning. A payload without `activity`/`tags` draws no chart at all rather than an
  empty grid. `lib/memory-panel.js`'s budget rises 1650 → 1900 for the 1861 measured
  lines (measured plus 30 rounded up) with the reason beside it.

  Also fixed, found by rendering the real components to screenshots: the heat map's
  `space-between` row of 6px columns scattered into dots at the measured 335px
  content width, so it is now a real 12-column grid whose cells scale to the panel;
  the sparkline overlapped the 128 it annotates, so it is its own row under the value;
  `mem-block` had no layout rule, so the section margins collapsed and left a dead
  gap between 新建与更新 and 标签频率; and `accepted` was missing from
  `STATUS_LABELS`, so the status line read "accepted 18" in mixed script.

  Verified: `node test/panel-ui.test.js` 31 pass (six new chart cases covering the
  spec §6.5 checks), `node test/architecture.test.js` 8 pass, `node
  test/panel-client.test.js` 16 pass, `node test/memory-panel-behavior.test.js` 4
  pass, eslint and prettier clean, and 375px and 320px dark captures of the **real**
  shell and views (`scratch/preview-real.mjs`, not shipped) confirming all five
  charts draw and the KPI band falls to two columns without overflow. Not verified:
  light theme in the running host, and the charts against a real vault — the capture
  uses a fixed fixture.

- **`overview` now carries the two aggregates the 概览 charts are drawn from:
  an 84-day daily `activity` series and a twelve-row `tags` ranking.** Both are
  implemented twice — once over SQLite and once over the in-memory scan records —
  and compared field-by-field across the two backends, so a degraded index cannot
  quietly answer a different vault from the primary one. `activity` returns
  `{from, to, days, created, updated}` on the local calendar: a note counts on the
  day its frontmatter `created` says, falling back to the day its file was
  written, and an update counts only when the note was *not* created that day —
  the same mutuality rule `lib/digest.js` already applies, reused rather than
  re-derived. There is no `archived` series on purpose: `superseded` is a current
  status snapshot and nothing records the day a note reached it, so drawing it as
  a dated flow would invent a transition the data cannot prove.
  `tagFrequencies` returns `{items, total}`, where `total` is every occurrence in
  scope so the panel can say "另有 N 个" without a second read. `overview`
  feature-detects both readers and answers `null` for a missing or failing one, so
  a browser asset and a host plugin upgraded at different times degrade to "no
  chart" instead of failing the whole 概览 read; the unbound value keeps its
  pre-chart shape exactly. `shrink()` follows the design's seven-stage order — tags,
  byType, byStatus, the activity window (cut to four weeks with `from` moving and
  all three arrays in step), hot sections, recent, and finally the digest card — so
  the chart data is trimmed before the text lists rather than after them. `fit()`'s
  loop guard rises 8 → 64 because a seven-stage order with halving stages cannot
  reach its later stages inside eight steps. `lib/index-db.js`'s budget rises
  2700 → 2900 for the 2827 measured lines (measured plus 30 rounded up) and
  `lib/panel-route.js`'s 700 → 800 for 749, each with its reasoned comment.
  Verified: `node test/index-stats.test.js` (21 pass), `node
  test/panel-route.test.js` (26 pass), `node test/architecture.test.js`, and the
  full suite at `tests 1355 / pass 1319 / fail 0 / skipped 36` plus eslint,
  prettier and `tsc --noEmit`. Not verified: any chart drawing these fields — the
  views that consume them land in a later task, and this entry's own payload has
  no consumer yet.

### Changed

- **The duplicated page title and the retired search jump are gone, and the heat map
  is centred.** Composed, the tab already names the page, so a "概览" or "健康"
  headline directly under it said the same word twice; the "去检索" action pointed at
  a box that is now permanently one row above the body. Both are kept for the
  standalone mount (no shell, so no tabs and no box, where the heading is the only
  orientation there is). The activity heat map is capped at 262px and centred in its
  row with its legend on the same centre line: left-aligned in a 335px body it read as
  a fragment that had failed to fill its column. Verified: `node
  test/panel-ui.test.js` 32 pass (one new case pins the composed/standalone split),
  `node test/panel-client.test.js` 16 pass, and 375px and 320px captures of the real
  shell and views.

- **The panel's vertical rhythm is one measure per gap again, and the air is back.**
  Three real spacing bugs, all found by looking at a rendered panel rather than at a
  test: the strip and the search box sat 0px apart (the box's own row had no top
  padding), `mem-block` — the stacking slot every chart is wrapped in — had no
  `margin-top`, so the section margins collapsed and the charts came within a few
  pixels of each other, and a later rule zeroed the first child's margin in *every*
  block, which since each block holds exactly one section removed the gap between all
  of them. The spacing now lives on the slot (`24px`, `:first-child` excluded) instead
  of on a margin that may or may not collapse, each chart body has `14px` of padding
  between its section rule and its marks, the search row has `14px/10px` above and
  below, and the view body has `18px/32px`. Verified: `node
  test/panel-client.test.js` 16 pass, `node test/panel-ui.test.js` 31 pass,
  `node test/architecture.test.js` 8 pass, plus a 375px capture of the real
  shell and views. Not verified: the same capture at 320px was not retaken after the
  rhythm change.

- **The top bar is now the tab strip itself, and 检索 is a results page rather than
  a page with its own search box.** The dedicated header — project name, vault line,
  binding stamp — repeated what the host's own sidebar already shows, and a panel
  that is a tab strip over a body should open on its tabs. What survives is the one
  reading no other surface gives: the freshness clock, set small at the strip's tail
  beside the refresh control (`mem-tabbar` / `mem-tabbar-meta`). The 44px hit area,
  the 8px leaf overlap and the active leaf's merge into the content surface are
  unchanged; they belong to the row that now holds both the leaves and that tail.
  `SearchView` loses the field, the submit button and the `role="search"` form it
  used to render — the shell's box above the strip is the one owner of the query —
  and gains `{ sessionId, query, scope, type, status, limit, visible, onFilter }`:
  the query and the three filters arrive as props, and a filter chip reports its
  intent through `onFilter` instead of keeping a second copy of the filter state.
  One run per `(query, filter)` a new set of props announces; an empty query stays
  idle and spends no request. The unbound→all fallback reports the scope change
  through the same callback, so it is still one owner. Retired with the form:
  `searchIcon`, `clearIcon`, the `svg` helper, `searchPlaceholder`, `searchSubmit`
  and the internal `query/scope/type/status/limit` state, which the shell would
  otherwise have shadowed. Also fixed: `health` now returns `project`, the identity
  `overview` already carried — without it the masthead relabelled itself "项目记忆"
  as soon as the user opened 健康, since it reads the project from whichever view
  reported last. Verified: `node test/panel-client.test.js` 16 pass, `node
  test/panel-ui.test.js` 25 pass, `node test/memory-panel-behavior.test.js` 4 pass,
  `node test/panel-route.test.js` 26 pass, `node test/panel-assets.test.js` 7 pass,
  `node test/architecture.test.js` 8 pass, eslint, prettier and `tsc --noEmit`
  clean. Not verified: the 320/375px visual pass — no browser drove this tree yet.

- **The memory panel's tab strip has three folder-form tabs and no longer has a 检索
  page; searching moves to a persistent shell-level box.** The 检索 tab is gone, so
  `MEMORY_VIEWS` is exactly 概览 / 图谱 / 健康, and `.mem-tabs` is a flex row instead
  of a four-column grid: adjacent leaves overlap by 8px, the active leaf paints
  `--dsw-alias-bg-base` with `margin-bottom:-1px` and a matching
  `border-bottom-color` so it merges into the content surface, and the strip's top
  padding lifts the 32px leaf to a 44px hit target. A 40px search field with a
  leading icon and a clear button now sits between the masthead and the strip on
  every page; submitting enters search mode and mounts `SearchView` in the body with
  the shell's state — `sessionId, query, scope, type, status, limit, visible,
  onClose` — while Esc, the clear button, or any tab leaves that mode. The search
  field's own `role="search"` form lives in the shell, the field keeps its text in
  search mode, and an empty query is not a search (no request, no mode change).
  `polling` covers 概览 and 健康 only, since the results page owns its own runs.
  `lib/client.js`'s budget rises 1100 → 1250 for the 1182 measured lines (measured
  plus 30 rounded up) and the reasoned comment. Verified: `node
  test/panel-client.test.js` (16 pass), `node test/architecture.test.js` and
  `node test/graph-client.test.js`, `node test/panel-assets.test.js`,
  `node test/export-surface.test.js`, `node test/pack.test.js`, plus eslint and
  prettier on the touched files. Not verified: the 320px/375px visual pass and the
  charts that will consume the new payload fields — both land in later tasks.

## 0.3.1 — 2026-10-28

### Fixed

- **The two private-file writers now refuse symlinks on Windows too, so the Windows CI legs go
  green.** The first `windows-latest` run (0.3.0) executed fourteen cases this non-elevated host
  skips because it cannot create file symlinks, and six of them failed: two writers had only ever
  proved symlink safety with `O_NOFOLLOW`, which Windows does not define. The diagnostic journal's
  append followed a run file substituted with a symlink and wrote through to the link's target,
  and the curation review claim guard's `O_CREAT` created a dangling symlink's target outside the
  data root *before* its post-open inode/hardlink check could run. Both now inspect the named entry
  before opening it — a symlink, a directory or any non-plain file is refused, so the create cannot
  happen — and keep the post-open identity comparison; POSIX still relies on `O_NOFOLLOW`. The
  previously skipped `a linked claim guard never creates or modifies outside or vault targets` and
  `a substituted run-file symlink cannot be written or exported` groups now pass on the Windows
  leg. `lib/curation-review.js`'s budget rises 800 → 850 for the 803 measured lines plus the
  reasoned comment.
- **The digest window compares calendar dates in the vault's own calendar.** Notes store
  `created: YYYY-MM-DD` from the host's local calendar, but the digest parsed that value as UTC
  midnight against a rolling UTC instant window. On a host east of UTC this excluded a note written
  "today" between local midnight and UTC midnight, so `mem_admin(action="digest")` and the panel's
  health view reported `created: 0` for a fresh write — measured 2026-10-29 00:10 +08 (window ended
  2026-10-28T16:10Z). Date-only values are now compared as local calendar dates against the window's
  local dates, while full timestamps keep the instant comparison; a regression test pins the three
  cases (inside, after, before). This also removes the two tests that failed a local Windows
  `npm run check` only in that eight-hour window.

## 0.3.0 — 2026-10-28

The memory panel gets its first host-native redesign and Windows becomes a gated platform. The
vault format, the six `mem_*` tools, the panel routes, the preview/confirm mutation contract and
the graph's data/rendering behaviour are unchanged; nothing migrates.

Verified on Windows 11 with Node 24.20.0: `npm run check` is green — 1,335 tests, 1,300 pass, 35
platform skips, **0 failures**, plus eslint, prettier, `tsc`, the pack contract and a real archive
listing. The new `windows-latest` CI legs run for the first time with this push; the POSIX-only
cases this host cannot construct (mode bits, file symlinks) stay skipped on Windows as before. The
panel was not visually re-checked in this environment (the DSH web UI requires its own auth); the
static and rendered-tree contracts are what the gate proves.

### Added

- **Windows is now part of the gate.** The check workflow runs the same `npm run check` on
  `windows-latest` for Node 22.22.2 and 24.x, and a new `.gitattributes` pins every checkout to LF
  so `format:check` measures code instead of `core.autocrlf`. `test/repo-gates.test.js` asserts both
  and refuses a leg that tolerates failure or forks on `runner.os`.

### Changed

- **The memory panel shell now has a modern host-native design system.** The sidebar opens with a
  compact masthead whose refresh is an icon button and a Chrome-style tab strip — one icon per tab,
  no `01`–`04` ordinals — above a single mounted tabpanel, so every tab's `aria-controls` points at
  a panel that exists and the 图谱/检索 tabs no longer show a permanently inert freshness clock.
  The one injected `<style>` sheet is token-only (no hex/rgb/hsl, no `font-family`, no gradients,
  radii ≤16px, shadows only `--dsw-shadow-lv1`/`--dsw-shadow-lv3`) and carries the whole class
  contract the redesigned 概览/检索/健康 views build on; the graph body is untouched.
- **概览/检索/健康 now wear the modern view markup.** 概览 opens with KPI cells that jump (待处理
  to 健康, the rest to 检索) above one stacked composition bar + legend and a quiet status-chip row;
  the numbered recent index is retired for a type dot and a `type · relative time` line, and the
  health summary is a passive band with one `全部 →` action. 検索 gets a raised search field with a
  clear control, named filter groups (类型/状态/范围), ordinal-free result rows with type/status
  chips, a path breadcrumb and the query marked inside the two-line snippet, and a footer that says
  `共 N 条` only for a complete page (`已显示 N 条` while 显示更多 is offered); its head meta claims
  `本地记忆索引` instead of a static FTS5. 健康 opens with a 2×2 summary band, then banded sections —
  index facts with a state pill, the queue with the same preview/confirm retry, the 6px hot-layer
  meter, today's digest, and a `诊断记录` timeline replacing the mislabelled `最近的决策` — and the
  confirm sheet now restores focus to the control that opened it and keeps its Tab trap on the
  dialog while both actions are busy. No payload, action or backend change; the graph body and the
  three mutation capabilities are unchanged.
- **The README pair states the support level and the modern panel.** Both languages now describe
  the Chrome-style tabs, host-native typography and banded views, add an OS row (Windows, macOS and
  Linux; portable Node; no native module; the same gate on the Linux and Windows CI legs), and
  name the curation `O_NOFOLLOW` limitation as part of that support level. `README.i18n.yaml`
  re-records both README blob hashes.

### Fixed

- **检索 now has one status source.** The idle sentence was owned twice — a `notice` state and an
  always-on trailing meta — so a filter click with an empty query printed it twice, and the class
  of duplicate statuses could not be fixed by deleting one line. Every 检索 status (idle, loading,
  empty, notice, error) is now derived once and rendered by one `mem-status` region; a filter chip
  with an empty query sends no request and returns focus to the search field. The same change
  removes the second loading owner in 概览/健康 (the skeleton announces a first read; the status
  line only a refresh), makes the unbound→all scope notice visible instead of being wiped by its
  own retry, and passes the real last-read time so a stale search error never says `上次更新 —`.
  The masthead refresh now also reaches the 概览 poll, which previously dropped the shell's
  `refreshKey`.
- **The graph-activity test no longer depends on Fetch-allowed ports.** The case posted to its own
  loopback server with `fetch()`; Node's Fetch refuses the Fetch-spec bad ports (10080 among them)
  before opening a socket, and this host's Windows dynamic range starts at 1024, so `listen(0)`
  could return a port the client then refused (`TypeError: fetch failed`, cause `bad port`). The
  case now uses `node:http`, so it measures the route instead of the client's port policy.
- **The Windows pack gate lists the tarball by relative name.** `scripts/verify-tarball.mjs` listed
  the packed archive with `tar -tf <absolute path>`, and GNU tar 1.35 (Git Bash's `/usr/bin/tar`)
  reads the `C:` in `C:\Users\…` as a remote host — `tar: Cannot connect to C: resolve failed`,
  exit 128 — so `npm run pack:check` failed on Windows for a valid archive even though bsdtar
  accepts that path. The listing now runs from the archive's own directory and names it
  relatively, the form both tars accept; it trims the CRLF endings a Windows bsdtar emits, so the
  `windows-latest` leg compares clean entry paths; and a failure without stderr reports tar's own
  spawn error instead of printing `undefined`.
- **The checks workflow exempts release commits from the Unreleased gate.** A release prepared in
  one push cuts `## Unreleased` into the new version section, so the push base and HEAD can both
  have an empty Unreleased while `lib/` changed; `verify-changelog --base` then failed and blocked
  a green `main` for exactly the release it was shipping. The `checks` workflow now skips that one
  step for `chore(release):` commits, mirroring the exemption the `release` workflow already had;
  every other gate still runs and pull-request events are unaffected.
- **The final review pass fixed the search field's focus ring and its duplicate clear
  affordance.** The 検索 input no longer suppresses the global `:focus-visible` ring, Chromium's
  own `::-webkit-search-cancel-button` is hidden so only the panel's clear control renders, the
  passive health-summary cells stopped showing a pointer cursor and hover lift, the 11px metadata
  lines sit on the CJK line-height floor, and the sheet's 44px action height is re-pinned in
  `test/panel-client.test.js`.

## 0.2.2 — 2026-10-28

### Fixed

- **The plugin now runs on Windows.** Seven defects were platform-only, each
  measured rather than inferred, and every one of them made a shipped feature
  fail on a default Windows install:
  - The Codex hooks and MCP server never started. All four entry points tested
    `import.meta.url === \`file://\${process.argv[1]}\``, which on Windows compares
    `file:///C:/…` against `file://C:\…` and is therefore never true: the process
    exited 0 in silence. `node codex/prepare.mjs` faked success without writing a
    file, the MCP server never answered `initialize`, and SessionStart injection
    and prompt recall never fired. They use `pathToFileURL(...).href` now.
  - Delivery state and the convention cursor read outside their own data root.
    `path.slice(root.length).split('/')` degrades to **one** bogus segment on a
    backslash path, so no intermediate directory was `lstat`-ed: a junction planted
    mid-chain was followed and the refused read returned bytes from outside
    `dataRoot`. Path segments now come from `node:path`'s `relative()` + `sep`.
  - `~/` never expanded. The check compared against `~\${sep}`, so the documented
    default `~/Documents/dsh-memory` stayed relative and every resolution threw
    `RangeError: vaultRoot must be absolute or start with ~/`. Both separators are
    accepted now.
  - The packaged skill never synced. On a CRLF checkout the frontmatter slice kept
    its trailing `\r`, which the YAML parser rejects, so `apply()` reported a
    failure on every Windows machine and `$DSH_HOME/skills/obsidian-mem` was never
    written.
  - Replacing a file could fail forever. `rename` over a destination that was
    published with `fs.link` answers `EPERM` on NTFS and does not clear: 400
    attempts over 10 s still failed, while plain-written destinations in the same
    directory failed 0/60. New `lib/fs-atomic.js` retries the transient codes and,
    for a spent `EPERM` budget, unlinks and retries once; the seven modules that
    each had a private copy of the temporary-fsync-rename sequence now share it.
  - `O_NOFOLLOW` is `undefined` on win32, `chmod` does not set NTFS permission
    bits, and `fsync` on a directory handle raises `EPERM`. The curation claim
    guard validates the opened file instead of relying on the flag, the private-mode
    checks ask the platform what it can prove, and the directory sync tolerates the
    refusal.
  - `scripts/check-staged.mjs` and `scripts/verify-tarball.mjs` spawned
    `node_modules/.bin/*` shims and `npm`: on Windows those are `sh` scripts
    (ENOENT) or `.cmd` files (`EINVAL` without a shell), so the gate reported
    "eslint failed" with an empty message. Both go through `process.execPath` and
    the packages' own JS entry files.
- **An unreadable record could be read as an absent one.** Windows collapses
  `ENOTDIR` into `ENOENT`, so a proposal directory replaced by a regular file
  answered "no such proposal" instead of `state-unreadable`, and the same shape
  defeated the diagnostics-journal privacy refusal. `parentIsNotDirectory()`
  re-reads the parent before concluding "missing".
- **The coverage-first brief silently changed what `truncated` means.** The
  refactor measured it against the section-aware `considered` count, so a
  conventions preview (5 shown of 50 considered, the default
  `briefConventionMode:'summary'`) reported `truncated:true` even when the
  budget had cut nothing — and hooks' R38 hot-snapshot logic reads that flag as
  hot-view completeness, so any project with more than five conventions got a
  held snapshot and a redundant full-hot-layer re-injection on the next change.
  `truncated` now measures the units the sections carry again; the preview cut
  stays visible in `coverage`, the 记忆覆盖 note and the footer, and a
  regression test pins the contract.
- **The panel's 全部 (clear-filter) chip was a silent no-op.** The search view
  merged request options with `??`, so the chip's explicit `type: null` /
  `status: null` fell back to the current value: once a filter was set it could
  never be cleared. The merge now distinguishes a passed key from an absent one.
- **`mem_admin(action="appraise")` could never report `dead-link`.** The action
  passed no link resolver, so the code the CHANGELOG advertised was impossible
  from the tool. It now collects the window's wikilink targets, asks the index
  in one batched `statusesForPaths` call, and answers from that snapshot; a
  statuses refusal leaves the resolver absent rather than failing the appraisal.
  The read loop also stops at a wall-clock deadline and reports the cut, so a
  slow disk cannot turn the bounded action into 50 unbounded reads.
- **`fsyncDirectory` now tolerates an `EPERM`/`EACCES` on the `sync` itself.**
  Some Windows runs refuse to flush a directory handle they did open; the
  function already tolerated a refused open, and the sync refusal is the same
  "nothing more this code can do" class.
- **`readGuarded` no longer misreads an MFT-resident file as offloaded.** NTFS
  stores small files resident in the master file table and reports
  `blocks === 0` for them; the measured boundary on this filesystem is 512
  bytes, so files at or below it are read instead of refused as cloud
  placeholders. A genuine on-demand placeholder is far larger and is still
  refused.
- **The panel's `hasMore` with a status filter no longer over-reports.** A full
  index page with zero rows matching the filter claimed "more" from
  `candidatesScored`, but 显示更多 would re-request the same page and yield
  nothing; with a filter active, only rows the filter kept beyond the visible
  window prove more. The hooks' coverage diagnostic now reuses the footer's
  `coverageFooterField`, so the event and the injected text name the same cut
  sections in the same order.
- **The curation review guard dead-ended on Windows.** The claim guard refused
  every operation on a platform without `O_NOFOLLOW` (`node:constants` leaves
  it `undefined` on win32), so an approved review could never apply there. The
  post-open validation (regular file, one hardlink, same inode through both
  `fstat` and `lstat`) is the symlink guard on such platforms; POSIX still
  closes the creation window with the flag.

## 0.2.1 — 2026-10-28

### Added

- **A coverage-first brief with addressable paging.** `buildBrief` now returns a
  machine-readable `coverage` object — per section and in total,
  `shown + omitted === considered` — and the footer carries the same counts
  (`coverage=...`). When a section is cut, the brief prints one bounded plugin
  notice naming the section, its shown/total and the exact
  `mem_brief(section="…", offset="…")` call; the note costs at most 300 code
  points and is dropped in favour of the short omission count when the budget is
  too small to carry both. `mem_brief` keeps its no-argument full-brief answer and
  gains optional `section`/`offset`/`limit`, returning one bounded page
  (1–50 lines, at most 8,000 code points) from the same private readers the brief
  uses. A new `briefConventionMode` (default `summary`) renders five MOC lines
  and makes the rest pageable; `flat` is the pre-0.3 list. Measured above: a
  2,000-line MOC now builds in about 23 ms (was about 81 s when every note was read
  for its status), because the statuses come from one batched
  `index.statusesForPaths` call.
- **A read-only 记忆 panel in the DSH sidebar.** The tab id stays
  `obsidian-mem:graph`; the title becomes 记忆 and the panel adds 概览/图谱/检索/健康
  views. 概览 shows the project, note/link/orphan/pending counts, type composition
  and recent changes; 检索 uses the local index and shows excerpts; 健康 shows
  index, queue, hot and diagnostics cards. The graph is unchanged except for a
  `显示 X / 共 Y` truncation notice. The panel's only endpoint is a read-only
  `POST /obsidian-mem/panel` behind the same loopback/same-origin fence and a
  4 KB body cap; it never exposes a write action or the cross-project registry.
  One route-served browser module (`lib/memory-panel.js`, 799 lines) is imported
  by the shell, which keeps the single-bundle constraint.
- **Deterministic memory appraisal.** `mem_admin(action="appraise")` reads at
  most the 50 most recent notes and returns bounded findings from a closed
  vocabulary: `review-overdue`, `dead-link`, `unverified`,
  `duplicate-title`, `contested`, with `error`/`warn`/`info` severities. It
  is read-only, makes no model call and returns `scanned`/`truncated` rather
  than pretending it saw the whole vault.
- **A deterministic digest read and owned writer.** `mem_admin(action="digest",
  days=1..30)` now returns the frozen v3 digest: the UTC window, created/updated/superseded counts,
  a type breakdown, hot and queue snapshots, at most eight recent references and
  at most twenty findings from the same closed appraisal vocabulary. It inspects at
  most 200 source notes under a 500 ms deadline, excludes its own generated
  `_meta/digest.md`, and reports `truncated`/`incomplete` instead of inventing a
  missing record. `operation="refresh"` renders the same disclosure into the
  project's owned `_meta/digest.md` through the transaction engine: at most 8,000
  code points, day-granular so an unchanged refresh is a byte-for-byte no-op, and
  a human-owned or unmarked target is refused rather than replaced. The health view
  now shows the card through the real service.
- **A shared source-link resolver for appraisal.** `index.linkResolver()` exposes
  the same Obsidian case/relative-path/basename rules the graph uses, and both
  `appraise` and `digest` pass it into the rules. Appraisal now parses links with
  the graph extractor, so inline-code samples are not treated as broken links.
- **One automatic-injection eligibility predicate.** `lib/note-health.js` now
  owns `AUTOMATIC_EXCLUDED_STATUSES` and `isAutomaticallyEligible`; the brief's
  convention index, the stored-view navigation, prompt recall and the recent
  decisions section all use it. `superseded`, `archived` and `provisional`
  no longer reach an automatic prompt by any of those paths. Explicit search is
  unchanged: a provisional note remains findable for the human who must confirm it.
- **Aggregate hot archive lines and a working compact.** Archiving no longer leaves
  one pointer per entry; each affected zone gets one
  `- 已归档 N 条 → [[…/hot-archive]]` line, and `foldPointers` migrates legacy
  per-entry pointers. `compactHot` now evaluates the post-aggregate text and can
  free short 进行中 entries: the 104-entry fixture at 8,983/9,000 cp is refused
  before the pass and succeeds after it, with every moved payload preserved once in
  the archive and no pointer ever archived.
- **A reusable development workflow.** `WORKFLOW.md` composes the Superpowers
  process (brainstorming → plan → subagent-driven TDD → verification) with the ECC
  gated pipeline (research → plan gate → TDD → review → commit gate). It records the
  Codex `gpt-6.1-sol` xhigh route (the bundled 0.163 CLI, not the PATH 0.146
  one that refuses the model), the time-box/fallback rule, the task-board and
  review-package conventions, the measured repository gates, and the artifact
  layout. `AGENTS.md` points at it.

- **v0.4 hot delivery receipts, bounded continuations and convention rotation.**
  The hot half of the brief is now versioned per injectable unit — the version
  hashes id, zone, text and source, because "the same id" is not "the same bytes
  the model read" — and a private receipt under
  `dataRoot/delivery/<vaultHash>/<projectId>/<sessionHash>.json` records exactly
  the ids/versions a composed message emitted (128 KiB, 512 acknowledged
  identities, 16 pending, 24 h retention, private modes, symlink refusal, atomic
  replace, one short per-state lock, idempotent duplicate acknowledgements, epoch
  reset on restore/clear/compact). A unit too large for the page is skipped and
  named with its source route instead of clipping later units; an unchanged
  overflow is not re-sent blindly; removals are acknowledged separately and
  withdraw provenance without inventing "resolved"; a changed source invalidates
  the cursor with `stale-continuation` and a fresh handle. After the first brief
  at most two automatic continuations per unchanged hot generation (one per user
  turn) each fit `briefBudgetChars`, and the rest is addressable through the new
  `mem_brief(section="hot", cursor=…)` page. DSH acknowledges the committed
  producer-owned `session/event` that carried the final message; Codex stdout is
  a pending receipt until the next trusted hook reconciles the exact marker/hash
  against its own transcript (8 MiB ceiling), and missing evidence leaves the unit
  unacknowledged. In `summary` mode the five convention lines rotate across
  acknowledged sessions behind
  `dataRoot/cursors/<vaultHash>/<projectId>/conventions.json` (8 KiB, CAS
  advance), so a long MOC is not the same five forever.
- **Three confirmed panel maintenance operations.** The 记忆 panel can now run
  exactly `retry-job`, `compact-hot` and `refresh-digest`, each through a
  preview and a separate confirmation: a single-use 32-byte token, 60 s TTL,
  bound to session/project/operation/arguments/canonical fingerprint, at most 128
  per process, revalidated before the service runs. A stale preview answers
  `409 preview-stale`; a replayed confirmation returns the recorded result instead
  of writing twice; previews write nothing. Mutations require loopback + a present
  same-origin `Origin` + JSON and keep the 4 KB body cap; they reuse the existing
  `services.admin` ownership/path/transaction guards. Read values gain
  `capabilities.mutations` and a bounded `queue.failedJobs` (5), so the panel
  stays fully usable read-only when the route is absent. The route's read-only
  action list and its single served asset are unchanged.
- **Deterministic sparse retrieval (v0.4 §5 baseline) and a disabled-by-default
  provider contract.** New `retrievalEngine: lexical|sparse` (default
  `lexical`; `semantic` is deliberately not a schema value). `sparse` retrieves
  at most 24 lexical candidates, re-reads and hash-verifies each source, chunks at
  1,200 code points, ranks at most 256 records with local TF-IDF/cosine
  (`lib/retrieval-rank.js`), fuses lexical and sparse orders with RRF k=60, and
  breaks ties by exact title/alias then path; stale or missing sources fall back to
  lexical with a named reason. The default lexical path stays one `index.search`
  call (byte-identical, asserted). The loopback embedding/rerank contract
  (`lib/retrieval-provider.js`) validates configuration, refuses non-loopback
  endpoints, never follows redirects, validates every returned number and makes
  zero requests while disabled; no provider or model is selected and no semantic
  quality is claimed. The shared tokenizer moved to the import-free
  `lib/index-text.js` leaf so the ranker can use it without a lateral edge on
  `search`.
- **The 记忆 panel is now a vault ledger.** The sidebar tab keeps its id
  `obsidian-mem:graph` and title 记忆 but is restyled as an editorial ledger: a
  masthead with the project name in the serif display stack (Iowan Old Style,
  Palatino, Songti SC, serif), a binding stamp, vault/project metadata, the
  last-read clock and refresh; ordinal tabs `01 概览 / 02 图谱 / 03 检索 / 04 健康`;
  large tabular KPI numerals, a composition index, numbered recent rows, health
  stamps and thin meters in place of a card grid; a border-bottom search field
  with underlined filter groups and numbered rows; a newspaper-column digest. One
  preview sheet serves all three mutations (`alertdialog`, Cancel focused, scrim
  does not dismiss, Escape closes, busy until the POST settles, inline stale/error
  states, replay named as "not written twice"). One staggered 160 ms entrance is
  removed under `prefers-reduced-motion`; the tablist keeps roles, roving focus,
  Arrow/Home/End and aria-live status; the graph tab and renderer/settings are
  untouched except shell chrome. The single served module
  `lib/memory-panel.js` remains import-free (React is passed in).
- **`mem_brief` gained a `cursor` page option.** Section `"hot"` accepts the bounded
  continuation handle a cut brief prints in place of `offset`; a source that moved
  underneath it answers `stale-continuation` with a fresh handle. The result shape
  and the closed output schema are unchanged.

### Fixed

- **The owned-digest tests pinned a date the real clock had to agree with.** The
  writer test wrote a note dated `2026-10-27` and then asserted that a real-clock
  `mem_admin(action="digest", operation="refresh")` was a byte-for-byte no-op.
  That is true only while the process's UTC date is 2026-10-27, so the first CI
  run after the v0.4 merge (2026-10-28T00:00Z, the release workflow's `npm run
  check`) failed with `updated` instead of `unchanged`, and every later day
  would have failed the same way. `createMemoryServices` now accepts an internal
  `clock` seam (`() => Date`, default the real clock) that the digest action uses
  for its day-granular window, snapshot date and owned-note date; the collector's
  deadline still reads `Date.now`, so a pinned clock cannot disable the 500 ms
  bound. Both digest tests pin the clock and the note's creation date to their
  fixture day.
- **Cached statuses could quarantine-bypass after an external edit.** The batch
  status path trusted an eligible cached row without checking the source. A
  convention edited from `active` to `provisional` stayed injectable until the
  next refresh. The batch now re-reads source status under a bounded parallel
  read (and treats an unreadable/missing source as navigation), preserving the
  sub-second 2,000-line MOC test.
- **A hot unit larger than one page could not advance.** An 8,100-cp constraint
  fits the 9,000-cp hot cap but cannot fit the 8,000-cp page ceiling; the old page
  returned `[]`, `hasMore:true` and the same `nextOffset` forever. `pageBrief` now
  refuses with `brief-unit-too-large`, names the source `mem_read` path and tells
  the caller to continue at `offset + 1`; the following page reaches later items.
- **A view page applied the brief preview cut before the offset.** The view page
  reconstructed only the prefix that fit `briefBudgetChars`, so entries in the
  tail disappeared from `total`. Paging now enumerates the complete eligible view
  and verifies only the requested page; the brief still renders a verified prefix.
- **The panel filter’s “全部” kept the previous type/status.** `options.type ?? type`
  treated an explicit `null` as absent, so the request and the pressed state
  disagreed. The handlers now distinguish a missing option from an explicit null.
- **Panel data outlived a session switch.** Overview/health and search could show
  project A while project B loaded or failed. Poll state is now keyed by
  session/action/params, stale responses are generation-checked, and last-good
  data survives only a refresh of the same identity.
- **A status-filtered search could miss matches below the first 50 hits.** The
  route fetched 50 unfiltered rows and filtered afterwards. The exact status
  predicate now runs in the index before ranking/page limiting on both backends,
  and the returned rows are rechecked against source bytes so an externally
  edited status cannot leak into the result.
- **The appraise action advertised `dead-link` but never enabled it.** The service
  now injects the shared vault link resolver, so a real missing target is found;
  aliases, relative paths, headings, case variants and inline-code samples resolve
  or stay silent as appropriate.
- **Two response-envelope defects.** Byte ceilings measured the value before the
  `{ok,value}` envelope (a 32,788-byte response could pass a 32,768-byte check),
  and the request guard decoded each HTTP chunk separately, corrupting a Chinese
  character split across chunks. The ceiling now measures the final envelope and
  the guard counts raw bytes then decodes once; exact-boundary and every-split
  cases are covered.
- **Provisional memory could reach an automatic prompt.** The brief excluded
  provisional conventions, but prompt recall could still fire on one, a stored
  curation view could inject one, and the recent-decisions section could show one.
  All three now use the same predicate; a regression test covers each path.
- **`compactHot` could not free short 进行中 entries.** A per-entry pointer line
  is about 100 code points and a short entry about 86, so `mustHelp` refused every
  batch and the recovery path was a no-op. Aggregate lines plus a post-fold shrink
  test make the pass free space; a refused write at the cap succeeds after it.
- **The brief's omission count was the only honest half of a cut.** The footer said
  `omitted N` but the model could not name the omitted items. The coverage note,
  the returned coverage object and the paging call close that gap.
- **The graph's truncation was silent.** The route already returned
  `truncated`/`total`; the view now renders `仅显示前 X / 共 Y`.
- **An unreachable `autoApply` config guard was removed.** `validateConfig`
  refuses unknown keys, so `config.autoApply !== false` could never be false; the
  curation enqueue now depends only on the worker seam. The audit's other
  dead-code candidates are recorded for a focused cleanup rather than removed in
  this release.
- **The panel's status filter and overview ceiling had two measured bugs.** A
  status filter was applied after the index page was cut, so a page with no
  matching row could report `hasMore:false` while matches sat beyond it. The exact
  predicate now runs in the index before ranking/page limiting on both backends,
  and the returned rows are rechecked against source bytes. The overview could
  exceed its 16 KB ceiling when its type/status lists were large; it now halves
  those lists and, if the fixed fields alone still overflow, answers a bounded
  `response-too-large` error instead of an unvalidated payload.

### Validation and remaining risks

- **v0.4 gate (2026-10-27, final tree).** `npm run check` exited 0: eslint,
  prettier, `tsc --noEmit`, the suite, `scripts/verify-pack.mjs` and the real archive
  all passed. The suite reported **1,309 tests / 1,308 pass / 1 optional skip /
  0 fail**; `verify-pack: OK`; `verify-tarball: OK — 85 entries, 75 lib modules,
  every required asset present`. `git diff --check` exited 0.
- **Mounted browser evidence (v0.4).** An isolated native DSH host (validation
  profile, separate `DSH_HOME`, synthetic repo + vault under `/tmp`) mounted the
  redesigned 记忆 tab against a bound project: the ledger rendered its counts
  (515 notes / 8 links / 512 orphans / 0 pending), the masthead project name
  computed to the serif stack, the ordinal tablist switched all four views, the
  graph tab kept its canvas, and the panel had no horizontal overflow at
  320/375/768/1440. Screenshots are under `scratch/ui-shots/` (git-ignored). The
  three mutation confirmations were **not** clicked against the live route: they
  are covered by 37 contract/route tests (preview → confirm → replay) and a
  mocked-fetch UI suite; this is a rendering check, not a mutation receipt.
- **Measured sparse retrieval.** Fixed 23-note fixture, 11 queries (5 development,
  4 held-out paraphrases, 2 distractors): development Recall@3 1.000 for both
  engines, MRR@3 0.867 lexical → 0.900 sparse; both paraphrase groups 0.000
  because they share no index token with the target; false injection identical;
  warm latency p50 2.55 ms lexical / 4.85 ms sparse in the quiet run (a loaded run
  measured 21.9/29.2 ms; both are in the record). This is a small-fixture baseline,
  not a relevance guarantee, and **semantic retrieval is unverified**.
- **Measured panel geometry (taste-skill inspect).** `inspect.mjs --app` over the
  shipped CSS + mirrored DOM at 1440/768/375/320 reports 0 FAIL and one accepted
  WARN per page (`tiny-text`: the body is the host's 12 px token) with 0 px
  horizontal overflow at 320/375; `lint.mjs --app` reports 0 FAIL/0 WARN. The
  harness is a static mirror, so this is a layout measurement; the native mount
  above is the visual acceptance.
- **Not run.** Native DSH `session/event` acknowledgement against a live session
  and native `codex exec` reconciliation against a real rollout (both are tested
  against measured message shapes only); two-OS-process lock contention; token
  (vs code-point) costs. The Codex `gpt-6.1-sol` xhigh independent review could
  not run — the bundled CLI reported the account usage limit until 2026-10-28
  01:46 — so the independent review is a fresh DSH reviewer; that ruling is in the
  SDD ledger.
- **Known residuals.** Panel mutations keep a TOCTOU window between the
  fingerprint read and the service's own revalidation (the service still refuses a
  stale precondition), and a lost confirmation can only be replayed inside 60 s;
  sparse retrieval caps at 24 hits and is lexical; automatic hot continuation is
  bounded at two per unchanged generation, so a very large unchanged hot layer may
  need an explicit `mem_brief` page rather than arriving in one session.

- **Measured (E1, 2026-10-26, synthetic `mkdtemp` vaults).** At 100/500/2,000
  conventions the old brief showed 45/44/44 lines (45.0%/8.8%/2.2% coverage) and
  0/5 recent decisions; the conventions preview plus the paging note frees about
  4,700 code points (note cost 77–79 cp). A 2,000-line MOC built in about 23 ms
  with the batch status path; the per-note path measured about 81 s at that size.
  These are synthetic-vault measurements, not a promise about a user's vault.
- **Measured (hot).** 104 entries fill 8,983/9,000 cp; at a 6,000-cp brief the old
  text carried 66/104 ids. After the pass, `compactHot` reclaims space and a
  subsequent write at the boundary succeeds; the paging test walks all 104 ids
  exactly once.
- **Tests run.** `test/brief.test.js`, `test/brief-page.test.js`,
  `test/tools.test.js`, `test/config.test.js`, `test/hooks.test.js`,
  `test/appraisal.test.js`, `test/appraisal-action.test.js`,
  `test/digest.test.js`, `test/digest-action.test.js`,
  `test/digest-write.test.js`, `test/panel-digest.test.js`,
  `test/status-search.test.js`,
  `test/route-guard.test.js`, `test/memory-panel-behavior.test.js`,
  `test/export-surface.test.js`, `test/hot-planner.test.js`,
  `test/memory.test.js`, `test/panel-route.test.js`,
  `test/panel-client.test.js`, `test/panel-assets.test.js`,
  `test/recall-eligibility.test.js`, `test/architecture.test.js`, plus
  `npm run lint`, `npm run types` and `npm run format:check`. `npm test` on
  2026-10-27: **1,163 tests, 1,162 pass, 1 skipped, 0 fail**. `npm run check`
  (lint, format, types, prepack, pack:check) also passed on the final tree:
  `verify-pack: OK`, and the real archive reported `78 entries, 68 lib modules`.
- **Mounted browser and real-data evidence.** Codex ran a mounted browser
  check on an isolated native DSH host before the repair wave: all four views
  mounted, the 500-node truncation notice rendered, keyboard Home and the live
  region resolved, and the 375/768 viewports did not overflow. That run also
  reproduced the 全部 filter failure and found the digest card absent; both are
  fixed in this tree, but the mounted browser check was not re-run afterward.
  A read-only project snapshot measured the base 0b3cbae brief at 2,135/6,000
  cp, recent 5/5, conventions 176/176 exact through 26 pages, and a 156.7 ms
  warm median; the source fingerprint was unchanged. The snapshot was not
  re-measured after these repairs.
- **Not run.** No post-fix mounted-browser or native DSH/Codex receipt check;
  no real-vault performance re-measurement after the repairs. The Codex
  `gpt-6.1-sol` xhigh spec run exceeded its 30-minute cap and was stopped; the
  Lead froze the spec from the completed research, and the read-only
  architecture audit did finish (339 lines,
  `research/codex-architecture-audit-2026-10.md`). The v0.4 contract was
  approved at that time and has since landed; its own evidence is in the newer
  Validation bullets above.

## 0.2.0 — 2026-10-12

### Fixed

- **The hot layer could strand itself at its cap with no way back.** Archival of
  `_meta/hot.md` treated a *pointer line* — the `- [hot-…] 已归档 → [[…]]` trace an
  archived entry leaves behind — as an entry eligible for archiving, because a
  pointer matches `HOT_ENTRY_PATTERN` exactly as an entry does. Replacing a pointer
  with an identical pointer frees nothing, so a 已完成 zone holding only pointers
  turned every later write into `hot-over-capacity`, and the batch that "moved"
  them was rendered into `Docs/hot-archive.md`: that is how one id came to appear
  eight times in the archive note, seven of them the note filing its own output.
  Pointer lines are now inert candidates, the archive append is idempotent per hot
  id and never files a pointer, and a refusal states every zone's characters,
  entry and pointer counts plus the route out, instead of claiming that no complete
  已完成 entry can be archived. Reported with a reproduction in
  `docs/issue-hot-zone-deadlock-2026-10-12.md`.
- A pointer line is never injected as a fact. The brief injects 强约束 and 进行中,
  and a pointer carries the same `hot-` marker an entry does, so a 进行中 entry
  drained by the recovery action below would otherwise have reached every session
  prompt as "- [ ] 已归档 → [[…]]".
- **A queued habit-curation job could wait for a clock that never advanced.**
  `enqueueHabitCuration` stamped its queue record with the real clock, while
  `runQueuePass` compares that stamp against the clock *the pass was handed*, so a
  caller that injects one — the `now` seam `capture.js` already documents as "clock,
  for tests" — wrote jobs that looked as if they were created after the pass's now
  and were deferred as `debounce` on every pass. Measured with the real clock at
  2026-10-12T10:35Z and a pass clock of 2026-10-12T00:00Z: `deferred`, `dueAt`
  10:35Z, `completed: 0`. The producer now reads the same seam as its sibling,
  which is what the three `habit-semantic` cases that were red on `main` needed —
  they fail identically at `5dfb13a` and pass after this change.
- **The bootstrap release branch had never been exercised, and it could not have
  worked.** `git tag -a` needs a committer and a fresh runner has no git identity,
  while only the bump branch configured one. The first hand-prepared version
  (`0.2.0`) therefore died at the tag step with `fatal: empty ident name` and exit
  128 before anything was pushed: no tag, no Release, and no half-state to clean up.
  The bootstrap branch now sets the same identity the bump branch sets. This is
  recorded because a real runner ran it — no test can exercise one, which is why
  the branch stayed untested through fifteen releases.

### Added

- `mem_admin(action="hot")`, the recovery path a `hot-over-capacity` refusal now
  names, with two operations. `status` reports the file against `hotCapacityChars`
  and `hotArchiveRatio` and, per zone, its characters, complete non-pointer
  entries, pointer lines and movable entries. `compact` runs in one transaction
  with one receipt: it folds the 已完成 zone's pointer lines into a single summary
  line that keeps every id, then drains the oldest movable entries — 已完成 first,
  then 进行中, which only an explicit call may cross, because spec §6.1 restricts
  *automatic* archival to 已完成. It never grows the file and never refuses for
  being over the cap; it reports what it could not free. A hand edit is not an
  alternative: `spliceBody` verifies the bytes it read, so any external change
  between read and write fails the transaction with `hash-mismatch`.

### Validation and remaining risks

- The three defects in `docs/issue-hot-zone-deadlock-2026-10-12.md` §2–§4 were
  reproduced against the shipped transaction engine and measured again after the
  fix: a 已完成 zone of pointers refuses with the new message and writes nothing,
  no pointer line reaches `hot-archive.md`, and `compact` recovers the reported
  shape (pointers folded, 进行中 drained, the refused write then landing). The
  fixture is a `mkdtemp` vault, not the reporter's; their `hot.md` and
  `hot-archive.md` were never read or written here.
- §5's third item is not a coupling and nothing was changed for it: `mem_log`
  takes the hot branch or the day-log branch and never both (`lib/services.js`),
  so a refused hot write cannot cost the same call a day-log block.
- `compact` cannot always reach the trigger. Moving an entry whose text is shorter
  than its pointer line costs bytes, so a pass takes only what shrinks the file and
  reports `reclaimed: 0` when nothing does. The lever there is `hotCapacityChars`,
  not another automatic move; no threshold makes that case self-healing, and none
  is claimed.

## 0.1.15 — 2026-10-11

### Fixed

- Release notes now go to the notes file instead of overwriting `CHANGELOG.md`
  before packing. Both release branches are covered by regression tests that
  execute their inline extractors and check the source remains unchanged.

## 0.1.14 — 2026-10-11

### Changed

- Habits now arise inside ordinary LLM memory distillation and bounded curation.
  The unpublished vocabulary, session counter and independent decay pass are removed.
  `distill.learnHabits` defaults to true; existing project habits supply matching
  context to the same turn-distillation call. Curation queues up to twelve stated
  conventions through the existing durable worker. Memory-derived candidates cannot
  claim fresh user confirmation, and changed source hashes cancel their application.
- Observed habits keep an exact short source quote and remain provisional, searchable
  and excluded from the brief. Matching never supersedes a confirmed note. Existing
  duplicate review, source ownership and curation lifecycle apply; `_meta/user.md`
  remains user-owned. No separate automatic age-based archive is promised.

### Validation and remaining risks

- The earlier counter measurements are historical evidence, preserved in
  `docs/habit-learning-results.md`, not acceptance of the new implementation.
- A 24-case semantic calibration after prompt adjustment produced 7/8 and 5/8
  positive detections in two runs, with 0/16 negative detections in each. This small,
  partly truncated sample is prompt calibration, not a production accuracy estimate.
- Full integration and native-host measurements are recorded in
  `docs/habit-semantic-validation.md`. Model classifications can vary and inferred
  preferences still need confirmation; no automatic preference confirmation exists.
- Curation requires DSH's existing worker and an explicit or captured model route;
  jobs without a route wait. Codex supplies memory tools, not automatic distillation.
  Context is project-scoped and bounded; long histories and cross-project induction
  are unverified. Source hashes are rechecked under the existing transaction lock.
  No production longevity or retirement threshold is claimed.

## 0.1.13 — 2026-10-10

### Fixed

- **A session whose recorded directory no longer exists lost memory in silence, and
  every unbound reason was reported as the same wrong one.** Reported by the user as
  memory failing for imported conversations, and confirmed here rather than guessed:
  `resolveBinding` called `fs.realpath` on the session's `header.cwd` and let a
  missing directory throw `ENOENT` out of the function. DSH keeps `header.cwd` for
  the life of a session, and an imported conversation carries the directory it was
  *recorded* in — the import tool ships `cwdRemap` for exactly that reason — so this
  was not an edge case: reading the first line of every session log under
  `$DSH_HOME/sessions` (`zstd -dc <log> | head -1`, then `os.path.isdir(header.cwd)`)
  finds **64 of 491 session logs whose recorded `cwd` does not exist on this
  machine**, across **9 distinct directories** — including
  `/Users/yukisala/Documents/ChatGPT/玉雯` and `/Users/yukisala/subject/A题`. What
  each caller did with the throw was measured too:
  - The pre-step's blanket catch turned it into "attach nothing", so the session got
    no brief and no recall, retried the same failing resolution on **every step**
    (the per-session memo clears itself on rejection by design), and logged one
    `warn` per session. Its `recordDiagnostic('brief', {outcome:'none'})` read
    exactly like a directory that simply had no memory yet.
  - The six tools returned the raw filesystem error, and a *read* that resolved to no
    project still told the model "this working directory has no `.obsidian-mem`
    pointer" — a false statement for a missing directory, a corrupt pointer and a cwd
    inside the vault alike.

  Fixed at the source: `cwd-missing` is an ordinary refusal now (`kind: 'unbound'`,
  carrying the `ENOENT`/`ENOTDIR` code, the path and a hint) for `show` and for every
  write mode, because nothing can be minted in a directory that is not there. The
  services layer keeps the refusal per cwd (`refusalByCwd`/`refusalFor`), so
  `requireProject` and `mem_brief` answer with the reason that actually happened, and
  `mem_brief`'s unbound arm gained an optional machine-readable `reason` and, when the
  resolution knows it, `repoRoot` — so a caller composing its own notice names the
  repository rather than the session's subdirectory. The `kind: 'vault'` arm gained a
  `reason` of its own for the same reason: it was the one remaining refusal without
  one, which is how "your cwd is inside the vault" still read as "no pointer yet".
  `resolveBinding` still throws for every other `realpath` failure: `EACCES` is not
  "missing". The survey behind the claim — the command, the 64-of-491 count and its
  evidence boundary — is recorded in `docs/p0-compatibility.md` §14.
- **The changelog gate gained the check that would have caught this entry's own
  insertion.** Appending an entry with its own `### Added` while `## Unreleased`
  already had one left two headings of the same name, and every entry written before
  the second one was silently re-labelled — the Fixed notes of an earlier change read
  as Added. The file parsed and the versions stayed in order, so nothing failed.
  `scripts/changelog-order.mjs` now reports a duplicate `###` heading, and
  `npm run check:fast` and CI both run it; the failure is scoped to `## Unreleased`
  because `0.1.1` legitimately repeats `### Changed` and a released section is
  history rather than this gate's to rewrite.
- **Both harness skills and the DSH system-prompt section now state the
  initialization protocol**: a pointerless directory is bound by the user's decision,
  so the model asks before calling `mem_admin(action="bind", …)`. `mem_admin`'s own
  tool description carries the same sentence — the one channel Codex reads without a
  session-start code path.

### Added

- **An unbound session is now told so, once, and asked what to do about it**
  (`lib/init-hint.js`, `bindHint`, default `true`). Reported by the user first as a
  discovery problem: a project with no pointer injected nothing at all, so no model
  ever learned that binding it was an option and no user was ever asked — the only
  path that ever created a pointer was a write. CodeGraph closes the same hole by
  answering "not initialized" from a tool call and printing the follow-up question in
  its agent instructions; this is that half for DSH, plus the answer for the
  missing-directory case above.
  - **What is worded, and what stays silent.** `BIND_HINT_REASONS` is a closed
    allowlist — `no-pointer`, `cwd-missing`, `no-git-root`, and the five
    untrustworthy-pointer codes — and a test requires every listed reason to have
    wording, so a reason cannot be added to the list and stay silent. Reasons with no
    user decision in them stay silent: a cwd inside the vault, a lost
    `pointer-race`, a registry conflict.
  - **Once per session, budget-checked, and never a brief.** `state.bindHintChecked`
    is set even when the message does not fit, so the decision is not re-made every
    step; the notice goes through the same `fits(text, config)` ceiling as the brief;
    and the `brief` diagnostic records `outcome: "hint-only"` with
    `code: "bind-hint"` instead of claiming an injection. It never opens the index,
    never calls `buildBrief` and writes nothing — asserted through the real waterfall.
  - **The promise is true inside the session that was asked.** The resolution memo
    no longer outlives an *actionable* refusal: `no-pointer`, `cwd-missing`,
    `no-git-root` and the pointer codes are re-resolved on the next pre-step, so when
    the user says yes and the model calls `mem_admin(action="bind", mode="local")`,
    the brief arrives in that same session. A bound answer, and a refusal the user
    cannot act on (a cwd inside the vault, a registry conflict), stay memoised as
    before. The cost is one `realpath` and a walk per step, and only while the
    directory is unusable.
  - **The code survives to disk.** `bind-hint` joined the codec's registered codes
    (`lib/diagnostic-codec.js`), together with the refusal reasons a `bind`
    diagnostic can carry (`cwd-missing`, `no-git-root`, `vault`, the pointer family).
    Without that registration the ring kept the token and the private journal wrote
    `other` — the same trap `review` and the curation outcomes fell into.
  - **A session that recorded no `cwd` gets no notice.** `cwdOf` falls back to the
    process directory, and a notice about the DSH server's own directory would be a
    message about a project nobody opened; `sessionCwdOf` exists so `planBindHint`
    can tell the two apart.
  - **The path is the only untrusted input, and it is made safe.** `quotePath` strips
    newlines, backticks and control characters and clamps to 200 code points, so a
    directory name cannot start a line of its own or end the quoted span. The words
    are static plugin text, never vault text.
  - **Codex gets the same notice**, so the two harnesses agree: the `SessionStart`
    hook used to inject nothing for a pointerless directory; it now composes the
    notice from `brief.status === "unbound"` + `reason` + `repoRoot` through the same
    module, and still opens no vault beyond the resolution, runs no curation pass, and
    exits 0 with one document on every path. It reads its own switch
    (`OBSIDIAN_MEM_BIND_HINT=0`; the hook is a separate process with no Cordis row), so
    the README's claim that the notice is a switch is true on both harnesses.
    `codex/README.md` and the hook's own decision comment were updated with it.
  - **Codex `compact` now injects, on a measurement rather than a preference.** A
    rollout records what compaction leaves the model with in its `compacted` record's
    `replacement_history`, and the brief is not in it: in
    `~/.codex/sessions/2026/10/04/rollout-…01a106b0…jsonl` (4.0 MB, 813 lines) the
    injection is at line 9 as a `hooks.additional_context` developer message, and the
    `compacted` record at line 400 replaces the context with 102 KB containing no
    `obsidian-mem:brief` while the AGENTS.md message survives. The old rule ("resume and
    compact both continue a conversation that already carries it or its summary") was
    therefore false for compaction, so `compact` joined `startup`/`clear`.
  - **Codex `resume` is now decided per session from the rollout.** `resumeVerdict()`
    reads at most 8 MiB of `transcript_path` and answers `present` (the injection is the
    latest of the two records and the file was read whole), `absent` (no injection at
    all — a plugin installed mid-thread, or a rollout imported from another agent — or a
    compaction after it) or `unknown` (unreadable, not a rollout, or past the cap). Only
    `absent` injects; `unknown` keeps the previous behaviour of not paying twice. The
    scan matches the serialized injection rather than the bare string, because the bare
    string also appears in this repository's own AGENTS.md and in any rollout that
    grepped for it — a false "present" would silence the reinjection exactly when it is
    needed. **Now verified with the real binary** (`docs/codex-hook-validation.md`):
    `codex exec` delivers `source:"startup"` with a populated `transcript_path`, and
    `codex exec resume --last` delivers `source:"resume"` with the same existing rollout
    path, readable when the hook runs. Six real runs then drove every branch: one
    injection at startup, none on a resume whose rollout still carries it, a new one
    after a `compacted` record (in both JSON spellings), and a new one for a rollout that
    never had a brief. The needles were widened to accept the spaced spelling after a
    probe showed the compact-only form missing it — the misses are not symmetric, since
    missing a compaction reads as "the brief is still there". A read-only survey of all
    132 rollouts on this machine found 111 `absent` / 19 `unknown` (exactly the 19 over
    the 8 MiB cap) / 2 `present`, a 24 ms worst case on a 70.2 MiB rollout, and the known
    compacted rollout answering `absent` with its marker present. **Still not
    reproduced:** a live `source:"compact"` firing, which needs a completing model turn;
    the reason compact injects is measured on a real compaction record instead.
  - **Every reason also has a one-line form, so no budget above the floor is silent.**
    The detailed notices are 176–270 code points and `briefBudgetChars` goes down to
    256, so at its floor the two longest (`no-pointer` at 261, `no-git-root` at 270)
    did not fit — and `state.bindHintChecked` made that silence final for the session.
    Each reason now has a compact form of 66–94 code points, and `bindHintWithin` (one
    chooser in `lib/init-hint.js`, called by DSH's pre-step and by the Codex hook)
    sends the detailed wording when the budget carries it, the one-line form when only
    that fits, and nothing when neither does. The budget itself stays hard: nothing is
    truncated and no floor is invented.
- **The user's own habits are a first-class brief section, and the vault asks for
  them.** Reported by the user as the memory not accounting for their habits
  (framework, skills, habitual approach per problem class).
  - **The template is a questionnaire, not a blank page.** `_meta/user.md` (created
    once by bootstrap, R21, and never rewritten) now carries 技术与框架偏好 /
    常用技能与工具 / 惯用方法（按问题类型）/ 产出与沟通偏好 / 禁忌 with commented
    examples: the empty file it used to be collected nothing, because a user with no
    prompt writes no preferences. Every example is an HTML comment and
    `preferenceUnits` strips comments per line, so an untouched template injects
    **nothing** — asserted by reading the shipped template's bytes and requiring the
    brief to carry no `用户习惯` section at all.
  - **Habits render under the user's own headings, and an empty group renders
    neither.** The section was renamed from 可选偏好 to 用户习惯, and
    `preferenceUnits` now groups bullets under their `##`/`###` label, dropping a
    heading with no bullet under it — which is what keeps the five-section template
    from injecting five empty labels. `- 先复现再二分` under 惯用方法 is not the same
    fact as the same bullet under 禁忌, and the label is what carries that.
  - **The section now ranks above the recent list.** `SECTION_ORDER` places
    `preferences` directly after `conventions` and above `view`/`recent`: a declared
    habit is a standing rule every answer has to obey, while the recent list is
    navigation to facts the project already wrote down. The old last place dropped the
    user's habits first, and this repository's own brief reaches its 6000-character
    ceiling — so a memory layer that knew its user was the one thing it threw away.
    The two assertions that pinned "optional preferences are dropped first" were
    rewritten to the new order, and a new one asserts the habits section precedes the
    recent list at a budget where both fit.
  - **Learned habits are not preferences, and a *stated* habit is now learned
    automatically.** Both harness skills and the DSH system prompt say where a habit
    goes — `Conventions/习惯：….md` in the project (one habit per file), promoted to
    `Methods/` when it outlives the repository, and never into `_meta/user.md`, which
    stays the user's file — and the type vocabulary is deliberately **not** widened
    (§6.4 forbids it, and `convention` already routes there). The automatic path was
    missing, so the pipeline was asked for habits and given a rule to obey:
    - **The prompt asks, and the validator enforces.** A convention titled `习惯：…`
      (either colon) must carry `assertion: stated` and cite a user seq; anything else
      is refused per item as `habit-not-stated`, with the escape in the refusal —
      record the same content without the prefix, or leave it to the agent's own
      `mem_write` after the user confirms. `distill.test.js` reads the refusal
      vocabulary back and requires the prompt to name the rule, which is the same
      contract the enumerated fields already had.
    - **Why only `stated`.** A habit is a claim about the user, and one completed turn
      can prove the user *said* something and nothing else. `observed` habits stay the
      agent's explicit `mem_write`: an automatic extractor that generalises a pattern
      from a single turn is the "preference nobody expressed" this pipeline exists not
      to write. Both skills say so where a reader will look for it.
    - **The marker is the plugin's.** An accepted habit gets the deterministic
      `user-habit` tag, so `mem_search` finds it without reading titles; the prompt
      never asks for the tag, because a marker the model must remember is one the
      validator cannot enforce.
    - **End to end, through the real queue:** `auto-capture.test.js` drives a stated
      habit from the stubbed model output to `Conventions/…` with the tag and
      `assertion: stated`, and drives an inferred one to a receipt whose refusal is
      `habit-not-stated` with no vault change at all.
    - **Measured against the real model** (`docs/habit-extraction-validation.md`, probe
      `scratch/habit-probe/run.mjs`): a user-stated habit produced `习惯：` conventions
      with `assertion: stated` and the plugin tag on every stated-habit run (6 items over
      2 runs × 2 cases), and a control where only the *assistant* proposed a workflow
      produced none. The same probe found the boundary this entry's first draft left
      implicit: a user-stated **project** rule was also titled `习惯：…` (2 of 2 control
      runs), which would have made a repository rule promotable as a personal habit. One
      prompt sentence fixed it — the control became a plain convention (0 of 2 prefixed)
      while the stated-habit yield did not fall (7 items over the same two rounds) — and
      `test/distill.test.js` now requires that sentence, since it is a measured fix and
      not a style choice.
  - **What is still not done:** nothing measures whether a habit line changes an
    answer, and the extraction is bounded by the turn — a habit stated once in a
    session that is never distilled (dryRun, no route, capture off) is not recorded.
    Budgets moved and are recorded in `test/architecture.test.js`: `lib/brief.js`
    1310 → 1400 (measured 1356), `lib/hooks.js` 1400 → 1500 (1489), `lib/services.js`
    1650 → 1700 (1673), `lib/vault.js` 1750 → 1800 (1778), `lib/init-hint.js` 175 →
    250 (measured 207), `lib/distill.js` 1050 → 1130 (measured 1076), and
    `lib/diagnostic-codec.js` 250 → 300 (measured 265).

## 0.1.12 — 2026-10-08

### Fixed

- Completed failure recall and recording after the language-standard investigation.
  Prompt lookup on an earlier step no longer suppresses failure recall in the same
  turn. Legacy/v4 tool envelopes and PTC nested outcomes are recognized without
  copying output; related successes reset counters and soft steps include the turn.
  Retrieval uses fixed English/Chinese category aliases. A same-tool hard run omitted
  by a valid model result can leave a bounded Inbox candidate through the existing
  queue. Recovery needs cited verified success and a written description; causes stay
  inferred/provisional, with no automatic supersede. Title twins remain review-only.
  Late evidence from a long failure run is still linked after the saved seq list
  reaches its bound. Soft output and the model's own summary cannot alone justify a gotcha; the refusal
  is audited in the receipt. User statements remain independent evidence.
- Count one- and two-letter English words in sentence limits, and exclude inline code,
  wikilinks and quoted prose from hedge, reference and language checks. Correct the
  mistaken attribution that ASD-STE100 forbids simple future: Rule 3.2 allows it.
  The bilingual README and both harness skills now describe these rules and boundaries.
- Verification: native DSH 0.2.0-rc.2 on Node v25.9.0, isolated temporary home/repo/vault.
  The failure probe passed eight assertions: three hard errors, same-turn recall
  (230 code points <= 900), verified recovery, SIGKILL after durable capture, restart
  receipt, inferred/provisional candidate and unchanged real-home fingerprints.
  The ordinary real-model smoke passed 25 checks and its checker passed 11 negative
  controls plus one positive control. Queue tests cover Inbox/Pitfalls, restart,
  duplicates, soft-evidence refusal and byte-identical dryRun. Package measured as
  64 entries over 55 lib assets (54 modules and the worker license).
  `npm run check`: 1010 tests, 1009 pass, one skipped optional smoke wrapper, zero
  failures; lint, format, types, pack contract and real tarball all passed (176 s).
  Full default-parallel runs hit scan/startup timeouts (three cases, then two);
  the 24 Codex adapter tests passed in isolation. The isolated-home runner now
  caps file concurrency at two, preserving scan budgets, handshake timeouts and
  assertions; the complete gate passed with that cap. Large hosts trade some
  file parallelism for less competition between native/SQLite fixtures.
  Metadata only: `test/smoke/records/failure-record.json`. Commands and local
  standard-source evidence: `docs/failure-memory-validation.md`.
- Remaining limits: these tests do not measure production solving time or retrieval
  quality, and the earlier 739-note/60-session rates have not been re-calibrated.
  Obsidian GUI rendering was not exercised. Codex MCP receives no native DSH tool
  events; its explicit skill workflow and shared library do not imply automatic
  detection of arbitrary Codex tool failures. Fallbacks obey maxItems and require
  a valid distillation; unavailable/truncated model output stays in the retry queue.

### Added

- **A session that is failing can now recall what the project already learned, and
  the trigger fires on a measured run rather than on a single error** (Task 18).
  Reported by the user as a TIMING problem: retrieval was only offered at turn
  boundaries and keyed to the user's prompt, so a session stuck in a loop of
  failing tools had no prompt-shaped text to match on and got nothing from memory.
  - **The signal comes from events this plugin already reads.** `tool/result`
    carries `message.isError`, and a tool's name is resolved from `tool/call`
    through `message.toolCallId` — the same pairing `lib/capture.js` already does
    for the distillation snapshot. What is new is a decision about it: nothing
    looked at those outcomes before.
  - **Two kinds of failure, and the second one was invisible.** `hard` is the
    host's verdict (`message.isError`, or `data.error`); `soft` is a call the host
    reported as SUCCESS whose body is error text. Measured over 60 sessions and
    6,442 tool results: **150 hard failures (2.3%)** and **370 successful results
    carrying error text** — more than twice as many. The soft signal is not
    hypothetical: while researching this change, `web_fetch` returned
    `isError: false`, `len= 0` on every attempt with a body full of
    `ToolCallError: URL hostname … resolves to a non-public IP address`, and the
    work only continued after switching to `curl`. An `isError`-only design cannot
    see that class at all.
  - **Thresholds, calibrated on the corpus rather than chosen.** Three consecutive
    hard failures, or two soft matches inside one step. A single failure is not a
    signal at a 2.3% base rate; a run is (5 of 60 sessions had a run of three or
    more, the longest being 13). End to end the trigger fires in **6 of 60**
    sessions, and every one of the six is a session that repeated the same
    failure — a `subagent` failing three times, a `web_fetch`/`run_code` pair
    hitting unresolvable hosts, a bash step emitting `[A-Z]+` errors.
  - **Soft failures may suggest a recall and may never justify a write.** That is
    the user's own boundary, and the repository's privacy rules agree with it:
    `capture.js` records "name and outcome only: the result body is raw tool
    output and is never copied", and the distillation contract downgrades a claim
    without a verified tool result from `observed` to `inferred`. A pattern match
    on raw output can do neither, so it cannot open a write path.
  - **What may become a query is a closed vocabulary**: the tool's name plus one
    error kind from the fixed table in `lib/failure-streak.js` (ordered so a
    specific signature outranks a general one). No command text, no path, no URL
    and no output fragment crosses that boundary, because that text can hold
    credentials and the vault is a document store rather than a log.
  - **It shares `recallBudgetChars` rather than adding a budget.** The prompt
    recall is planned first, so a step carries at most one retrieval; a run that
    arrives after this step's injection waits for the next step. A second budget
    would double the per-step ceiling that the existing 0.6%-versus-22.1% firing
    rate measurement is about. The new `failureRecall` config switch (`true` by
    default) turns the path off for anyone who wants retrieval keyed strictly to
    their own prompts.
  - **Four defects were found by the tests, and three of them made the signal
    useless.** The soft pattern used `\bE[A-Z]{3,}\b` under `/i`, which under case
    folding matches any word beginning with `e` — `export`, `Evenly`, `emit`,
    `emitanaka` — and fired on **63.7% of successful results**. Scoping the scan to
    the tools whose success can hide a failure (shells, fetchers, code runners)
    removed the `read`/`grep` false positives that made it fire in 31 of 60
    sessions. The step number was read from `event.step` instead of
    `event.data.step`, so the per-step counter silently degraded to a per-session
    one. And the read was gated on a flag that only a competing injection could
    set, so a session with no prompt never triggered the path at all. Each has a
    case in `test/failure-streak.test.js` or `test/hooks.test.js`.
  - **Verified:** `npm run check` — 994 tests, 993 pass, 1 skipped (the opt-in
    `test/smoke/` lane, not run), 0 fail; `npm run types` clean; `verify-pack` and
    `verify-tarball` OK, the tarball now 63 files over 54 `lib/` entries. The
    classifier was re-measured against the 60-session corpus after every fix: hard
    **150 of 150 found, none missed**, soft 313, triggers 6/60.
  - **Unverified:** nothing measures whether a failure-triggered recall makes a
    problem get solved faster — the 6/60 rate counts how often the trigger speaks,
    not whether it helped, and the machine-local diagnostics under
    `~/.dsh/data/obsidian-mem/` are test runs (`project p1`) that were deliberately
    not used as evidence. The recording half of the user's request — turning a
    RESOLVED failure run into a `gotcha` candidate — is **not** in this change; only
    the read path is. The soft-signature table was tuned on one machine's sessions
    and its false-negative rate on other toolchains is unmeasured (`unknown` is the
    honest fallback for a hard failure with no signature). Budgets moved and are
    recorded in `test/architecture.test.js`: `lib/hooks.js` from 1250 to 1400
    (measured 1364) and the new `lib/failure-streak.js` at 430 (measured 415).

## 0.1.11 — 2026-10-04

### Added

- **Automatic curation is documented, replayed for quality and measured for cost**
  (Task 8, the plan's last task). No runtime API changes: this entry is the record of
  what was run, what it measured and what stayed unverified.
  - **The same-fixture quality comparison** — one throwaway vault
    (`test/integration-write-read.test.js`, *a stored curation view changes no
    retrieval answer on the baseline fixture*) holding a cross-project twin of a project
    fact, an old superseded conclusion, an exact duplicate, a same-title/different-number
    pair, a same-title/different-date pair, a note whose only relation to its query is
    shared vocabulary, and a cold-but-relevant note. That last class is the one this
    entry first mis-framed, and the framing is corrected here: the note is relevant to
    its own query and no fixture activity had recalled it, but it is **not** "never
    retrieved" — the test's own pre-scan loop queries it by name, and the superseded
    and vocabulary queries return it in passing — so the class asserts what the design
    actually needs, that a note the view had no history for still reaches the brief by
    name, and not that an unretrieved note survives. Every class is queried
    once with no view at all and again after the shipped
    `mem_admin(action="curation", operation="scan")` wrote a complete one (asserted:
    `complete: true`, and a second project's view file is still absent). All eight
    classes are **PASS**, and the test emits its rows as test diagnostics, so this table
    is the run's own output rather than a restatement: retrieved source ids are
    *identical* before and after for cross-project, superseded, superseded-with-history,
    exact-duplicate, near-duplicate, differing-date, irrelevant-high-similarity and
    cold-relevant; every returned path reads back through `mem_read` (4/4, 5/5, 6/6, 4/4,
    4/4, 3/3, 5/5, 3/3); the brief goes from 1128 to 1325 code points against the 6000
    budget with `omitted` 0 before and after; the exact pair is one line carrying both
    paths while the near pair keeps two lines; and the superseded and cross-project
    paths are in neither brief. **No quality regression was found.** This is a
    comparison on one fixture, not a retrieval-quality benchmark.
  - **Both adapters over one data root** (`test/codex-hooks.test.js`, *the automatic pass
    parks a real candidate, and the other adapter reads it back*): an MCP write pair with
    one title and two different bodies leaves a durable hint, the real
    `codex/session-start.mjs` process runs its due pass (exit 0, exactly one JSON line
    carrying the real brief), the pass parks the scanner's near-duplicate finding as a
    proposal, and the MCP-side `mem_admin(action="curation", operation="status")` reads
    back the same project id, `complete: true`, `examined: 0`, at least one pending
    proposal, both notes through `mem_search`/`mem_read`, and the durable receipts under
    the one `$DSH_HOME`-derived data root.
  - **The hook ceiling, measured** — probe and raw JSON under the git-ignored
    `docs/superpowers/plans/`. A 600-note temporary vault (above one 256-note batch)
    with the cursor removed before every round: a full pass inspected **256** notes and
    truncated with `file-budget` — never `time-budget` — at p50 **135.7 ms** / p95
    **171.2 ms** over 15 rounds; a real hook process paid p50 **+172.4 ms** / p95
    **+178.9 ms** more than the identical process skipping the pass on a fresh cursor
    (5 pairs; every cold run `scanned` 256, every warm run `skipped`). Both percentiles
    are nearest-rank, so at these sample counts they are the observed maximum. **No pass
    started an inspection after the deadline:** with `maxMs: 1` a pass did the untimed
    manifest walk and nothing else (13.7 ms, `examined: 0`, `time-budget`), so the
    observed overrun is that walk, not a read. A 5 000-note replay measured the same
    walk at 30.4 ms and a full pass at 149.3 ms for 256 notes, still `file-budget`. No
    hook failure was observed in the probe — its saved JSON records exit status **0 for
    all ten hook runs**, and records exit statuses only: it counted no stdout lines, so
    "one JSON line" is *not* a claim this probe supports. That half of the hook contract
    is asserted for a single run by `test/codex-hooks.test.js`
    (`run.lines.length === 1`), not measured across ten. **No constant
    was reduced** — and 256/500 are explicitly **not** claimed optimal: the note bound
    binds first at this size, and a project large enough for the deadline to bind was not
    run.
  - **Documentation**: both READMEs (the `autoCurate` field in the example and the
    config table, a new *Automatic curation* section, `curation`/`operation` in the
    `mem_admin` row, the `curation/` entry in the data-root tree, two failure-recovery
    rows) and both portable skill editions (`skills/obsidian-mem/SKILL.md` and the Codex
    marketplace copy) now state automatic versus reviewed actions, the trusted-hook
    condition, `autoCurate`, the status/scan calls, the review CLI, and fallback and
    recovery. Both READMEs also state the resume cadence the code actually has (fix round
    1): a pass that hits either bound keeps its position, and the next pass happens when
    the project is next due — a committed write's changed-path hint, an explicit
    `operation="scan"`, or the 24-hour marker — not simply on the next eligible session,
    which is what both sides had said. Both skill editions' `mem_admin` row had listed six
    actions and omitted
    `diagnostics` and `curation`; they list all eight now.
    `test/repo-hygiene.test.js` gains one check that all four documents name
    `autoCurate` and `dsh-obsidian-mem-review`, so the switch and its only approval
    route cannot be documented on one side (or in one language) only.
    `README.i18n.yaml` records the new blob hashes (re-recorded in fix round 1, after
    the cadence correction below).
  - Measured: `npm test` **911 tests / 910 pass / 1 skipped / 0 fail** (908/907/1/0
    before this task's three added cases, measured on `7c4cd8f`); `node
    codex/prepare.mjs --check` → `prepare --check: ok (6 tools, skill, .mcp.json and
    both hooks)` (the regenerated manifests stay git-ignored); `npm run check` → lint,
    format, types, `prepack` (the suite plus `verify-pack: OK`) and `pack:check`
    (`verify-tarball: OK`, 61 entries, 51 lib modules) all pass. The measured latency
    numbers below come from the probe's own JSON, saved beside it under the ignored
    `docs/superpowers/plans/`.
  - **Unverified, stated as such.** *Live delivery is unverified:* no real DSH session
    and no real `codex exec` session was run against a real vault. There is no `dsh` on
    this machine's `PATH` at all, and a Codex session would need the user's own
    credentials and a live model call, which this task did not make — discovery, hook
    trust and injection are covered at the protocol level only
    (`test/codex-hooks.test.js` drives the real hook process, `test/codex-mcp.test.js` a
    real MCP handshake). Also unverified: the deadline-binding case (a project big enough
    that the 500 ms deadline truncates a pass); the manifest walk at its own
    `MAX_MANIFEST_FILES` bound of 50 000 paths (measured only to 5 000, and it is the one
    part of a pass the deadline does not bound); any *quality* comparison on a fixture
    other than this one; and the review command driven from a real interactive shell
    rather than the pseudo-terminal Task 7's cases create.
  - **Known limitation — the backfill of a vault larger than one pass advances at most
    once per 24 hours per project until a write hints it** (recorded in fix round 1 under
    controller ruling R45). The *due* automatic triggers pass `{dueOnly: true}` and
    nothing else on the DSH session-activity half, while Codex's `SessionStart` passes
    `{dueOnly: true, maxNotes: 256, maxMs: 500}`; the DSH write-path trigger passes
    `changedPaths` instead and is weighed against the hint queue rather than the marker
    (`lib/index.js`, `codex/session-start.mjs`), so "exactly `{dueOnly: true}`" was
    never true of the trigger set. `isCurationDue` reads only the
    cursor's `scannedAt` (`lib/services.js`), which a truncated full pass writes fresh as
    it scans. So such a pass keeps its position but does **not** resume on the next
    eligible session: with an empty hint queue the next `dueOnly` trigger answers
    `skipped`, and the backfill waits for the 24-hour marker, an explicit
    `operation="scan"`, or a new committed write's changed-path hint — which is weighed
    against the queue, not the marker. Measured on throwaway worlds
    (`docs/superpowers/plans/task-8-fix-cadence-probe.mjs`, raw JSON beside it): a project
    bound by `mem_admin(action="bind")` with no write, so its queue really is empty and
    nothing is removed by hand, takes pass 1 `{status: 'scanned', complete: false,
    truncated: 'file-budget', examined: 1}`, then pass 2 `{status: 'skipped', complete:
    false, examined: 0}` at the unchanged `scannedAt`, then pass 3 after one committed
    write `{status: 'scanned', complete: true}`. The knob is the test seam
    (`maxNotes: 1`), standing in for a vault larger than one batch; the reviewer's route,
    removing the changed-path document after a truncated pass, reproduces the same two
    steps. A full pass cut by the *manifest* bound is the exception the same code shows:
    `truncated !== 'manifest-budget'` gates the cursor write, so that pass leaves the
    stored marker exactly as it was (`lib/curation-scan.js:1172`). **The other direction
    is source-inspected, not measured:** `due = force || local.length > 0 ||
    isCurationDue(cursor)` (`lib/services.js`) makes a queued hint due whatever the marker
    says, but no run in these records measures a pass on every eligible session start
    while a hint is queued — the hook probe above removed the cursor to measure a single
    pass, so it does not show that.
    **The trigger cadence is deliberately unchanged** — the plan's Task 6 step 3 says only
    that "Background DSH passes may continue incomplete cursors while the worker is
    active", which permits this, and changing behaviour inside a documentation fix round
    would invalidate two completed task reviews. Both READMEs state the shipped cadence
    rather than the per-session resume they described before.

- **One parked curation proposal can now be reviewed and applied, through the same
  transaction engine every other write uses** (Task 7). `lib/curation-review.js` is the
  executor the Task 3 review found missing: nothing in the tree applied a parked
  `supersede`, and re-applying one through `applyCandidate` would have classified it as
  risky a second time and parked it again. `reviewCurationProposal({dataRoot,
  proposalId, decision, binding, now})` reads the record, refuses anything that is not a
  pending `create-separate` or `supersede` with a named code (`review-only`,
  `operation-not-executable`, `proposal-not-current`, `proposal-missing`), answers a
  stored record whose bytes cannot be read as `proposal-unreadable` instead of throwing
  — all eight keys of that table are now driven by a case, not only the corrupt-JSON one
  (fix round 3) —
  verifies every source through the vault jail and the memory layer's ownership proof
  (`human-owned`, `ownership-unproven`, `ownership-mismatch`, the layer's own names),
  applies exactly the approved operation, and only then marks the proposal `applied`. `decision:
  'reject'` marks it `rejected` and changes no source byte. **A stale proposal never
  auto-rebases:** the record's own `sources` travel into the transaction request as
  `expectedSourceHashes`, which `lib/transaction.js` re-reads and re-hashes *inside the
  vault lock it already holds* — no second, reentrant lock is taken anywhere — so an
  edit that lands between the scan and the approval refuses with `source-changed` and
  leaves the record `pending` for another review. The write request is built from an
  explicit field list and goes through `createMemoryWithId`, so a candidate that carries
  an `id` cannot turn an approved create into an update (R6); that path is the R6 guard
  made structural, because it never reads `id` at all. **Historical claim protocol
  (Task 7 fix rounds 2–3; superseded by the Task 9 concurrency fix below):**
  the following concurrency discussion records the mechanism and limits at that revision.
  Two reviewers of one proposal are
  arbitrated by a per-proposal claim file beside the record: one decides, the other is
  refused, and the shared idempotency key would in any case have replayed the winner's
  transaction rather than minting a second note. The claim is taken before **either**
  decision, so a rejection cannot mark `rejected` a proposal an apply is publishing —
  at two reviewers, which is the width the claim is exclusive at (fix round 3).
  **The reclaim of a stale claim is decided by an exclusive `link`, not by the rename
  that clears the way for it**: the new claim is written to a per-process name and
  linked into place (`EEXIST` for every claimant but one), and a reclaimer whose rename
  lands after another review installed its claim content-checks the bytes it moved,
  **withdraws** them and refuses. A case that forces that ordering shows exactly one of
  two reclaimers proceeding, where the earlier rename-then-create let both through and
  published a note behind a `rejected` record. The withdrawal replaced a restore in fix
  round 3, because a restore is the one operation that can create the claim file: a case
  that holds a reclaimer between its rename and its content check until the claim's owner
  has released it (*a claim its owner released is never reinstated by the reclaimer that
  moved it*, RED against `405ce07`) shows the restored file surviving the release
  (pre-fix), which answers every later review "another review is deciding it" until the
  owner's pid disappears or the 15-minute bound passes, while the fixed file is gone and a
  later review applies the proposal. That window is also why the claim is **not mutual
  exclusion at three reviewers**: with the path empty, a third review installs its own
  claim while the review whose bytes were moved is still running — a case drives that
  ordering and observes two claims for one proposal and two applies — and what still
  leaves one note and one `applied` record is the shared idempotency key, which replays
  the winner's transaction for the second claimant. **The same window has a second
  outcome the idempotency key does not repair, disclosed here rather than left to be
  found:** a third claimant that decides `reject` can mark the record `rejected` while
  the review whose claim bytes were moved is still applying, so an apply racing a reject
  at three reviewers can leave a published note behind a `rejected` record. The key makes
  two *applies* one note; it does not make an apply and a reject agree. The review
  command is TTY-only and decides one proposal per run, which is what keeps this a
  three-way race rather than a routine one. Measured on this round's tree, every
  run under a throwaway `DSH_HOME`: `node --test test/curation-review.test.js
  test/curation-cli.test.js test/curation-tty.test.js test/transaction.test.js
  test/architecture.test.js` → 92 tests / 92 pass / 0 skipped / 0 fail, and `npm test` →
  **916 tests / 915 pass / 1 skipped / 0 fail** twice (the skip is the suite's own
  `MARKETPLACE_PROBE_LIVE` case).
  A crash between the publish and the receipt store is
  replayed by `recover` (the explicit half of `mem_admin(action='jobs')`), which rolls
  the committed manifest forward before the
  identity check so the retry returns the receipt the first attempt published instead of
  refusing with `id-taken`; the module-level replay is covered by a case that passes
  `recover: true`, and the CLI does pass it — the CLI's own call is **not** exercised by
  a test, so "the human route can replay that window" is a reading of the argument list,
  not a measurement.
  - `lib/curation-cli.js` — the `dsh-obsidian-mem-review` command, the **only** approval
    route. It requires an absolute `--vault`, resolves the project from the working
    directory in `show` mode, prints the proposed operation, its sources and their
    scanned hashes, and accepts exactly `apply <id>` or `reject <id>` — byte-for-byte,
    one proposal per run, no `--all` and no default answer. Both stdin and stdout must be
    terminals (`interactive-tty-required`), so a piped answer exits non-zero. That is not
    a proof a person is present: a process able to allocate a pty can drive this prompt,
    and a case does exactly that — the defence is the exact-typed confirmation plus the
    read-only binding and the proposal-state checks behind it, not the terminal.
    **No model-callable approval exists:** `mem_admin(action='curation')` still takes
    `operation` alone, and a case asserts the compiled action enum and every `mem_admin`
    parameter name carry no `apply`/`approve`/`reject`/`review`.
  - `package.json` declares the second `bin`, and `scripts/verify-pack.mjs` now requires
    `lib/curation-cli.js` to exist **and** the bin entry to target it: a `bin` entry is
    the one asset no other pack check would miss, because `lib` is a directory entry.
    `test/pack.test.js` covers the missing file, the dropped bin entry and a bin target
    that escapes the package root.
  - **Untested, stated as such:** the TTY-driving cases need `expect(1)`, the pty utility
    this repository uses instead of `script(1)` (the BSD implementation refuses a child a
    terminal when its own stdin is a socket). The cases are run and asserted here, and
    they report a skip rather than a pass on a machine without it — the exit-code half of
    that lane is therefore verified on this machine and not on a CI image that lacks it.
    Live host delivery of the command is unverified: no case runs it from a real
    interactive shell, only from a pseudo-terminal the test creates.
  Measured (fix round 1): `npm test` **908 tests / 907 pass / 1 skipped / 0 fail**; the
  same tree's covering files
  (`test/curation-review.test.js`, `test/curation-cli.test.js`, `test/curation-tty.test.js`,
  `test/transaction.test.js`, `test/memory.test.js`, `test/architecture.test.js`) measure
  **117 tests / 117 pass / 0 skipped / 0 fail** under a throwaway `DSH_HOME`. The `1
  skipped` is the suite's own pre-existing skip, not this lane: `expect(1)` is installed
  here, so every TTY case ran and passed. `npm run pack:check` passes and the archive
  lists `lib/curation-cli.js`. Budgets raised with the argument beside each one in
  `test/architecture.test.js`: `lib/memory.js` 1500 → 1650, and `lib/transaction.js`
  2200 → 2300; `lib/curation-review.js` stays inside its 650-line budget. Two modules
  registered: `curation-review` (L6) and `curation-cli` (L9), no existing layer
  renumbered.
  - **An earlier entry here recorded `895 tests / 893 pass / 1 skipped / 0 fail` for this
    work, which does not add up and disagrees with the report's `901 / 900 / 1 / 0`.**
    Both were measured on revisions that no longer exist (later commits added the
    curation-scan and trigger cases); the number above is the one this round measured, and
    the report now carries it too.

- **A bounded curation scan and the note-health rules the linter now shares**
  (work in progress; nothing user-visible changes yet — no config field, no new
  tool, no automatic pass). `lib/curation-scan.js` inspects one bound project
  under both a note-count and a wall-clock bound, resumes from a private cursor
  instead of recounting earlier notes, restarts when the path manifest moves under
  a running backfill, and reports a partial result as partial; it never writes a
  byte inside a vault. `lib/curation-state.js` owns that cursor, one rebuildable
  record per inspected path and the durable changed-path queue, all under
  `<dataRoot>/curation/` with `0700`/`0600` permissions and atomic renames.
  `lib/note-health.js` holds the overdue-review and dead-wikilink rules, and
  `lib/lint.js` now applies those instead of keeping its own copies, so a scan and
  a lint cannot disagree about one note. `lib/index-db.js` keeps exporting
  `SUPERSEDED_STATUSES` as an alias of the shared history list.
  **Continuing into Task 3:** `lib/curation-proposals.js` is the durable review
  queue for the candidates the plugin may not apply on its own — the supersede a
  distillation proposed, and the restatement a title lookup called a duplicate —
  stored one JSON document per proposal under `<dataRoot>/curation/proposals/` with
  the same `0700`/`0600`, atomic and size-bounded rules as the cursor, and with an
  identity derived from the project, the item (or the scan finding) and the source
  hashes, so replaying a candidate returns the same record instead of growing the
  queue. An identity that already exists with different content is refused with
  `proposal-conflict` rather than overwritten; two processes racing one identity
  have one winner (an exclusive create) and the loser re-reads it instead of
  clobbering it; and a state transition is the only thing there that takes the vault
  lock. A `near-duplicate`, `expired-review`, `dead-wikilink` or
  `missing-provenance` finding recorded from a scan carries **no** operation: it is
  a record to read, and a plan on such a kind is refused. In the apply path,
  `applyCandidate` classifies a risky item — a `supersedesId` that survived the
  ownership pre-check, or a twin from the duplicate lookup — *before* it creates
  anything: it parks the candidate whole through the new `propose` seam and returns
  `{review: true, proposalId, skipped: false}` with nothing written to the vault,
  and a `review` item is recorded in `appliedItems` and in the receipt **without** an
  index refresh, because no note exists for an index to look at. With no `propose`
  seam the call throws `propose-unavailable` and writes nothing: falling through to
  the old automatic supersede, or to the old silent `skipped`, would lose a
  validated candidate. Three files carry it:
  - `lib/curation-proposals.js` — the two executable kinds and the four review-only
    ones, `snapshotProposalSources` reading each source's exact bytes through the
    vault jail, and `recordCurationFindings` turning a scan's judgment-dependent
    findings into stable proposals. A finding edited between passes retires the
    record built from bytes that no longer exist and records the current one, and no
    source note is ever changed.
  - `lib/memory.js` — the `propose` seam on `normalizeDeps` (it can no longer import
    the store: both sit at L5 and that lateral edge is refused) plus the fail-closed
    gate above.
  - `lib/capture.js` (L6) — the real seam, which snapshots the evidence and calls
    `saveCurationProposal`. This is the only layer that may compose the two.
  Measured: `npm test` 809 tests / 808 pass / 1 skipped / 0 fail, and a test
  asserts every source-note hash is unchanged before and after every kind of pass.
  Untested: no scan currently emits a *suspected contradiction* finding, so the
  review-only path is exercised for the four kinds the scanner does produce and a
  contradiction would be recorded by the same code path without a case of its own.
  A pass that hits the note-count or wall-clock bound reports `complete: false` even
  when the backfill behind it is finished, every note-supplied string an entry
  carries is bounded,
  and a record the private store refuses degrades that one note to `unexamined`
  instead of failing the pass. The scan's link resolver is applied to a wider set
  than the notes it inspects: every file of the bound project's tree plus the vault
  root's entries, so a link to a vault-root note, a vault-root `Makefile` or an
  extension-less file beside the linking note is not called dead. The narrower set
  plus its last-segment rule makes the scan's dead-link findings a **subset** of
  the linter's — the scan never reports a link the linter resolved. The relation was
  probed rather than assumed, and it is only this: **for a target the scan can
  decide, its findings are a subset of the linter's; for a target it cannot decide —
  any slash-bearing target that does not name a path under this project, and
  everything when the enumeration failed or was truncated — the scan reports nothing
  and the linter may still report it.** The probe found nine rows where the scan is
  silent and the linter reports a dead link, in three shapes. Six are slash-bearing
  targets outside the project prefix, answered `true` before any name is looked at:
  `[[Docs/nomatch]]` (nothing named `nomatch` anywhere), `[[Methods/并不存在]]`,
  `[[Docs/txt.txt]]`, `[[Docs/LICENSE]]`, `[[other/LICENSE]]` and `[[Other/a]]`,
  whose basename *is* carried by an enumerated file — the match changes nothing.
  Two are the last-segment rule's own under-report: the bare `[[README]]`, whose only
  carrier is the project-root `README` one directory above the linking note and so
  out of reach of the linter's directory-bound candidates, and the project-prefixed
  `[[<project>/Other/a]]`, where those candidates miss while the scan answers through
  the `a` of `<project>/Docs/a/a`. The ninth is the unconditional dot: a bare
  `[[nomatch.png]]` names nothing anywhere and `lintVault` reports it dead, while the
  scan's last-segment branch answers `true` before it consults any name at all, so the
  answer does not depend on what that set holds — it is built from every file's last
  segment with only a trailing `.md` stripped, so it does carry `txt.txt` and `图.png`.
  The covering case asserts that whole matrix, scan against `lintVault`, row by row,
  nineteen rows in all (`nine` silent/dead,
  `eight` silent/silent, `two` dead/dead). The silent/silent `[[LICENSE]]` row is the
  one whose *attribution* is probed rather than written down, and the final wave
  corrected the direction of that probe: both surfaces' `true` is carried by the
  extension-less `<project>/Docs/LICENSE` **beside the linking note** — the linter's
  own directory-append candidate — not by any vault-root `LICENSE`, which this
  fixture does not contain. The asserted probes are that the project-root copy alone
  answers `false`, that the beside-note copy alone answers `true`, and that
  `['LICENSE']` alone answers `true` only as what a vault-root copy *would* answer.
  `lintVault`'s `filePaths` is every swept *file* (not a `.md`-only
  note set), so the linter's own answer for those targets is a real dead link and the
  scan's silence is the safe direction.
  A directory that either half of that universe cannot be enumerated in makes the
  resolver silent rather than guessing, and the pass now says so instead of
  certifying what it did not read: a `readdir` refused for anything but `ENOENT`
  reports an `enumeration-failed` state finding, sets `complete: false` and leaves
  the cursor where it was, and the resolver's own file list carries a
  `MAX_RESOLVER_FILES` count bound whose truncation makes every target undecidable
  (a `resolver-truncated` finding names it) rather than checking links against half
  a tree. That file bound no longer stops the *note* walk: it used to break the whole
  enumeration, which truncated `manifest.paths` too while `truncated` and `denied`
  stayed false — `complete: true` and a cursor written over the short fingerprint,
  notes nobody had read. The two lists now stop separately, the manifest stays whole,
  and the bound is named in the finding with the value that actually applied.
  The fourth Task 2 fix round also replaced one over-narrow attribution in
  `lib/note-health.js` — the comment that described the scan's silence as "both
  differences under-report" without saying which targets — with the same literal
  relation the resolver comment and the covering test now carry. It was written as
  "the last" one at the time; the fifth round below found two more sentences that
  still stated what a probe contradicts.
  Measured at the Task 2 fix round that landed this: `npm test` 810 tests / 809 pass
  / 1 skipped / 0 fail.
  Measured again at the fourth fix round on `fix: keep curation coverage and link
  claims exact`: `npm test` 811 tests / 810 pass / 1 skipped / 0 fail.
  The fifth and last Task 2 fix round on `fix: pin every curation link claim to a
  probe row` enforced the rule that a comment may not name a shape or an attribution
  the covering matrix does not pin, and it corrected the two sentences the re-review
  falsified. The resolver comment no longer credits the project-root `LICENSE` for the
  scan's `[[LICENSE]]` answer — which copy carried either surface's answer is now said
  only where the covering case re-probes `createVaultLinkResolver` directly, and the
  linter's own rule given the project-root copy alone is asserted to answer `false` —
  and its claim that the under-report is only "a bare name carried by an enumerated
  file the linter cannot reach" is replaced by the two shapes the matrix asserts: a
  slash-bearing target outside the project prefix (`[[Other/a]]` among them, basename
  match and all) and the last-segment branch's own under-report (the bare `[[README]]`,
  plus the project-prefixed `[[<project>/Other/a]]`). That round's own rewritten
  sentence still credited a **vault-root** `LICENSE` the fixture does not hold; the
  final whole-branch wave below deleted it, named the beside-note carrier and added the
  third silence shape. That round's matrix grew from thirteen asserted rows to
  eighteen, including two agreement rows for a plain extension-less
  file and a `.png`; `lib/note-health.js` and this entry carry the same account. Two
  deferred Minors went with them: the file-bound case now asserts the persisted
  cursor's manifest fingerprint equals the whole manifest's rather than only that the
  cursor exists, and the `resolver-truncated` comment states that the missing link
  finding is not a deferral — an unchanged note is verified by its record's presence
  and never re-read, so the finding stays absent until the linking note's own bytes
  change, which the same case asserts with a second whole-universe pass (the final wave
  added the other half: editing the note and asking a changed-path pass brings the
  finding back).
  Measured at the fifth fix round: `npm test` 835 tests / 834 pass / 1 skipped / 0 fail,
  and the covering pair `node --test test/curation-scan.test.js test/lint.test.js`
  52 tests / 52 pass under a fresh `mktemp -d` `DSH_HOME`.
  Untested: the >50 000-note manifest bound, the >50 000-file resolver bound at its
  shipped value (the covering test lowers it through the `maxFiles` option) and the
  oversize branch of the record degradation (after the entry bound, a note whose
  frontmatter can be parsed cannot reach the 64 KB record bound; the same recovery
  path is exercised by an unwritable record). Known limitation: the wall-clock
  bound is now consulted after the manifest walk, so neither it nor `maxNotes`
  bounds the enumeration itself — pre-existing, and named rather than implied away.
  **Continuing into Task 4:** `lib/curation-view.js` is the compact,
  source-verified navigation view, and `mem_brief` now composes its
  decisions/gotchas navigation from one when a complete view is stored under
  `<dataRoot>/curation/view/<projectId>.json`. Each entry carries one bounded
  description (120 code points, no leading block prefix, so a hostile note line can
  never arrive as a heading), its vault path, its type, its status, the sha256 of
  the bytes it was built from and the scanner's `exactKey`; an exact-match group is
  displayed once and names
  **every** alternative path, and it stays collapsed across a changed-path merge —
  the stored entry keeps the identity key the scanner computed, and a merge has no
  note body to re-derive it from, so without that field a merge would regroup every
  stored entry by its own path and print each duplicate pair as two lines until the
  next full pass. The document holds at most **2000** displayed entries
  (`VIEW_ENTRY_LIMIT`), a bound applied to the grouped list so it can never split a
  collapsed group or drop one of its alternative paths. Whether that count cut or the
  768 KiB compact-size bound decides first is a property of the entries rather than a
  constant, and the final wave measured both ends: 2000 minimal entries — one-character
  path, type and title, empty description, a sha256 `exactKey` so none of them group —
  serialize to 673 878 bytes and stay under the bound, while 2000 entries carrying a
  real vault path, title and description serialize to 1 287 878 and are refused as
  `view-oversize` before the count can cut. So the count bound is a backstop for
  unusually small documents, not the cut a real project meets — a scan that examined
  more current facts than that keeps the first entries in path order, which bounds the
  projection and leaves the scan's own `complete` flag untouched, but the earlier
  sentence here described that cut as the one a large project meets. Historical
  statuses are excluded at build time, as
  current search already excludes them. A full pass replaces the view; a
  changed-path pass merges into a view that is already complete and recomputes the
  affected groups from the merge (it never replaces the view with the changed
  subset), and refuses with `backfill-incomplete` when the stored view is not
  complete. `readCurationView` answers `null` for a view that is absent, corrupt,
  mis-versioned, over its bound or written for another project — a cache miss, never
  a partial view — and `verifyCurationEntries` re-hashes **every** path of every
  selected entry, including every member of a collapsed group, through the existing
  vault jail; one changed member is `fallback`/`source-changed`, and a failed check
  never yields a ready-but-empty view. `buildBrief` takes the view as an optional
  input and, when verification fails or no view is given, runs exactly the source
  extraction path it ran before: the budget, the whole-block truncation, `omitted`,
  the hot priority and `indexState` are unchanged. The view can only replace the
  decisions/gotchas list, and only when it provably carries every path that list
  would have shown; the binding, the hot layer, the hub outline, the convention
  index and the user's preferences are still derived from the source, and a path a
  higher-priority section already names is not repeated under the view's heading.
  `mem_search` and `mem_read` are untouched, so a view cannot narrow retrieval.
  The brief verifies a bounded slice, not the whole view: the longest prefix of the
  candidates whose own rendered lines — path, every alternative path and description —
  fill its character budget, computed from those strings rather than from a divisor
  over an assumed line length. The slice is exact in both directions: the renderer
  emits a prefix of the same list, so nothing is injected unhashed, and one entry
  past the slice would need more than the whole budget for the view section alone, so
  no entry that could have been rendered is left unverified. A 2000-entry view costs
  the hashes of the entries that could
  actually appear rather than 2000 reads at session start. The cut is a real cost and
  is named as one: on a view larger than one brief could carry, an entry in the tail
  of the path order does not reach this navigation at all — it stays in the view for
  the next budget and is still reachable through the hub, the convention index or
  `mem_search`.
  The view's file IO (path, version and project check, 1 MiB reader bound, `0700`/
  `0600`, exclusive temporary file plus atomic rename) lives in
  `lib/curation-state.js`; its content, merge and verification live in
  `lib/curation-view.js`. Measured at the Task 4 commit, for the fixture the covering
  test builds: the pre-view brief was **1125** code points and the same fixture with a
  verified complete view is **1185** (1161 at the Task 4 commit; the fix round put the
  hostile note's `## …` line first in its body, which lengthens that one description
  by 24), both under the default 6000 budget with
  `truncated: false` and `omitted: 0`. The view is *not* the smaller brief — it
  carries every current entry with a bounded description rather than five titles, and
  the claims it earns are that each path is source-verified before it is injected and
  that a collapsed exact group names every copy.
  Measured: `npm test` 832 tests / 831 pass / 1 skipped / 0 fail (the 811/810/1
  before this task's two new test files and one new integration case).
  The Task 4 fix round on `fix: bound and merge the curation view honestly` enforced
  the entry bound, stored the group key, reverted the seven layer raises the review
  withdrew (R27: an edge needs only a strictly lower target, so `brief` at L7 may
  import `curation-view` at L5) and replaced the line-length divisor with the
  rendered-length slice above; it also corrected the `brief.js` budget comment that
  claimed the rounding rule where the number is deliberately inside it.
  Measured at that round: `npm test` 835 tests / 834 pass / 1 skipped / 0 fail.
  Untested: no task yet *writes* a view from a service action (Task 5 does), so the
  integration case builds one by calling `scanCuration` + `buildCurationView`
  directly; the two *write-side* oversize fallbacks (`view-oversize`, and the
  store's own `view-unwritable`) need a vault or a data root no fixture here builds,
  so they are named as boundaries rather than shown working — the reader's own
  1 MiB bound over the same document *is* covered; and a view is never read across
  two processes in one test.

- **Bounded curation administration, and the switch that will drive it** (Task 5).
  `mem_admin` gains one action, `curation`, whose `operation` is exactly
  `status` or `scan` — there is deliberately no `apply`, `approve` or `reject`
  value, in the DSL, in the compiled schema or in the router, because approval is
  the TTY-only command Task 7 adds and never a model-callable action. `lib/config.js`
  gains `autoCurate: z.boolean().default(true)`; `false` disables automatic passes
  only, and the explicit `scan` stays available. Both host descriptions name the new
  action, and `test/tools.test.js` and `test/codex-mcp.test.js` assert the two hosts
  expose the same six tools and the same closed `operation` pair.
  `lib/services.js` gains the internal `curateForBinding(binding, options)` and
  `curateCurrentProject(options)` seams, and the action is a thin projection of the
  same result they return: `{status, operation, projectId, complete, cursor,
  scannedAt, examined, counts, proposals, truncated, autoEnabled}`. `status` reads
  the private cursor, the committed view and the bounded proposal listing and scans
  nothing; `scan` runs one bounded pass. Both resolve the project through the
  existing read-only `resolveProject` path, so neither mints a `.obsidian-mem`
  pointer — a case asserts the pointer is still absent after both, and that a
  pointerless repository gets `not-bound` (the tool) and `'unbound'` (the adapter
  seam) rather than a pass over whatever project the process sits in.
  The pass order is the contract, and each half is asserted rather than asserted
  about: the durable changed-path queue is read first and chooses the traversal;
  `dueOnly` skips a pass when a complete scan is younger than 24 hours (the marker
  is the cursor's `scannedAt`, and a queued hint bypasses it because it is
  information the marker was never asked about); the view is written **before** the
  hints are acknowledged, so a crash between the two leaves them queued for replay;
  and the acknowledgement drops only the queued paths the pass actually inspected,
  sorted and cut at 512, so a pass cut short by either bound leaves the rest queued.
  One thing the tests forced into the open: a changed-path pass can never satisfy
  `complete`, so a rule of "acknowledge only a `complete` pass" would replay hints
  forever and never resume the interrupted backfill. When no complete view exists yet,
  `curateForBinding` therefore runs a **full** pass even with hints queued (they are in
  its manifest, so they are inspected), and a changed-path merge is only used over a
  complete view. (An earlier revision of this entry attributed that to the scanner
  writing a coverage cursor from a changed-path pass. It does not: the write is guarded
  by `if (fullPass && …)` with `fullPass = requested.length === 0`, so a changed-path
  pass writes no cursor, and `nextAfter` falls back to `lastInspected` unless the pass
  covered its scope, so a `file-budget` pass records its resumption point rather than
  the last manifest path. The workaround is still needed, for the reason stated here.)
  Wiring R28: the same call now invokes `recordCurationFindings`, which Task 3 built
  and left uncalled — a judgment-dependent scan finding becomes a stable, review-only
  proposal. Each finding is recorded on its own, so an unreadable source refuses that
  one finding instead of failing a pass whose view is already written; the refusal is
  reported as a `curation` diagnostic whose outcome is `failed` and whose code is the
  error's own code, absent when the error carries none.
  Diagnostics: one new `curation` category, in sync across `EVENT_NAMES`, the
  `mem_admin` output schema's enum and the disk codec's `OUTCOMES` — `listed` /
  `scanned` / `skipped` / `failed` — carrying an outcome, a project id, one code, an
  examined count and a duration. The code is the scanner's truncation reason
  (`file-budget`, `time-budget`, `manifest-changed`, `records-missing`), the state
  problem the call worked around (the `CurationStateError` payloads) or a view build's
  refusal (`entry-unusable`, `view-oversize`, `backfill-incomplete`), and every one of
  them is registered in the codec's `CODES` so none is persisted as `other`. A case
  drives a real pass over a note whose body and title carry random sentinels and
  requires neither the text, the vault-relative note path, nor the private cursor path
  to appear in `mem_admin(action="diagnostics")`.
  Measured: `npm test` **846 tests / 845 pass / 1 skipped / 0 fail** (`c02bda1`
  measured 835 tests / 834 pass / 1 skipped / 0 fail on the same checkout, so this
  task adds eleven cases and no failure).
  Budgets: `lib/services.js` 1150 → 1500 and `lib/tool-schema.js` 900 → 950, both
  with the argument for the lines beside them in `test/architecture.test.js`;
  `lib/diagnostic-codec.js` stays at 200 (199 measured) and `lib/config.js`,
  `lib/debug.js` and `lib/tool-registry.js` stay inside their existing ones.
  Untested: no automatic trigger calls `curateForBinding` yet (Task 6 is that step),
  so `dueOnly`'s 24-hour branch is covered only through the seam's own call — the
  `skipped` outcome is pinned by the diagnostic vocabulary but no case drives a
  due-marker skip; the `scan` action's behaviour when the vault's root is
  cloud-managed is the existing R14 refusal reached through `requireProject`, not a
  case added here; and the proposal listing is exercised empty, so a populated
  queue's counts are exercised by the proposal module's own tests rather than here.

- **Both adapters run the incremental curation pass themselves** (Task 6). Nothing
  new is user-visible: the six tools are unchanged, no config key is added, and
  `autoCurate: false` still disables automatic passes only — the explicit
  `mem_admin(action="curation", operation="scan")` keeps working, which a case now
  drives on the same project after the switch has suppressed every automatic one.
  **The DSH side** gains one seam and two triggers. A committed vault write queues
  its note in the durable changed-path set: `lib/services.js`'s `write` (the
  `mem_write` tool, and Codex's MCP `mem_write`) does it through a new shared
  `queueCurationHint`, and the queue worker's apply path does it for each item that
  really committed a transaction — a **parked** candidate contributes no path,
  because the note it describes does not exist and a hint for it would send the
  next pass to inspect nothing (R5). The hint is written outside the vault
  transaction (the enqueue takes the same vault lock and it is not reentrant) and
  its failure is a content-free `curation` diagnostic rather than an error: the
  receipt is already durable, so the worst case is that the note waits for the next
  due full scan. After the hint is on disk, a new `onCurationHint` seam asks this
  host for a pass, and `lib/index.js` runs `curateForBinding` with a per-project
  in-flight set: a second request while one pass is running is dropped rather than
  queued, the call is never awaited, and its refusal is recorded as an outcome and
  a code — never a path — so a curation failure cannot fail a completed user turn.
  A worker teardown starts no new pass: `stop()` makes both `kick()` and an
  explicit `pass()` answer with nothing.
  **The Codex side** runs its due pass inside `SessionStart`, after the brief is
  built and before the hook answers, with the 256-note limit and the 500-ms
  deadline, reading the 24-hour marker from private state through the shared
  `curateCurrentProject` (so the binding rules and the R14 cloud-managed refusal
  stay in one place). Its failure changes neither the injected brief nor the exit
  code — a case makes the scan throw and requires the same one valid JSON line on
  stdout — and an MCP-only install claims no pass at all, because the pass lives in
  the hook: `resume`, `compact`, an unbound directory and an untrusted hook all
  leave the counterfactual data root uncreated.
  Measured: `npm test` **857 tests / 856 pass / 1 skipped / 0 fail** (`a1a4417`
  measured 846 / 845 / 1 / 0 on the same checkout with this task's test edits
  stashed, so this task adds eleven cases and no failure).
  Also measured: `test/codex-hooks.test.js` and `test/hooks.test.js` drive the
  signal in-process through the injected `open` seam where the assertion is about
  the decision, and as real hook processes where it is about stdout and the file
  system.
  Fixed in passing: `failed` was missing from the disk codec's `curation` outcome
  set, so the per-finding refusal `lib/services.js` has emitted since Task 5 was
  persisted as `other` — the same trap `review` fell into. `lib/diagnostic-codec.js`
  lists it now and the round-trip case loops it.
  Budgets: `lib/capture.js` 2100 → 2160 (2157 formatted lines measured) and
  `lib/services.js` 1500 → 1550 (1544 measured), each with its argument beside it in
  `test/architecture.test.js`; `lib/index.js` (199 measured), `lib/hooks.js`,
  `lib/diagnostic-codec.js` (200 measured) and `codex/session-start.mjs` stay inside
  their existing ones.
  Untested: **live host delivery is unverified.** No case here runs a real DSH
  session against a real vault and observes the pass happen, and none runs
  `codex exec` with the hook trusted — the two adapters are driven at their seams
  (the registered tools through a real `Context`, the hook through `runHook` and
  as a child process), which is what the suite can do without a host. Three
  narrower gaps: the *ordering* of the DSH pass against a turn's own tail is
  asserted only as "the callback is advisory and nothing waits on it", since the
  receipt path is synchronous and the pass is not; the Codex 500-ms deadline is
  asserted as the value the adapter passes, not as a measured wall-clock stop, and
  the same for the 256-note bound; and no case exercises two hosts curating the
  same project at the same moment, which is the cross-process vault lock rather
  than this task's single-flight set.

- **Notes are measured against a language standard, and the calibration is the
  author's own vault** (Task 17). `lib/note-style.js` is a new leaf module holding
  five rules; `lib/distill.js` states them in the prompt and reports them per
  candidate, and `lib/lint.js` reports them across the vault. The rules are
  calibrated on **739** existing fact notes (`Conventions/` 243, `Pitfalls/` 285,
  `Decisions/` 211), measured by `scratch/vault-style-probe.mjs`; the whole study is
  in `research/memory-note-language-standard.md`.
  - **The starting point was ASD-STE100, and its two most famous rules were
    refused by the corpus.** A tense restriction (`已`/`将` forbidden) hit **39%**
    of notes and is *correct* in an ADR, which records what was decided at a point
    in time — a rule whose hit rate is explained by the genre is not a rule. A ban
    on mixing Chinese with Latin identifiers hit **37%** and is wrong for `FTS5`,
    `node:sqlite` and `[[path|label]]`, which cannot be translated. What
    transferred is STE's *structure*: a sentence-length budget applied per text
    type (STE Rules 5.1/5.2/6.3/6.6), not one rule set for everything.
  - **The rules, with their measured hit rates on the existing corpus:** a sentence
    over **60 CJK characters** or 25 Latin words (4% — the first threshold tried,
    40, hit 27% and was rejected, and 50 hit 16%); more than **5 sentences** in one
    note (13%); an open-ended qualifier such as `可能`/`应该`/`建议`/`should` where a
    bound belongs (8%); and a reference outside the note — `该`/`此`/`上述`/`前者` —
    which is unresolvable when a note is read alone (26%). A bound is never a
    hedge: `约 15s`, `≤9000 字符` and `最多 21 条` pass.
  - **The severity split is the decision that could lose a fact, and it was
    measured.** Only the language rule (4 notes say `body script differs from the
    title script`) *reroutes* a candidate to `Inbox/`; the other four are recorded
    on the item as `style-<rule>` and never move it. Treating all five as reroutes
    would have sent **326 of 739 notes (44%)** to `Inbox/` instead of the directory
    each was distilled for. A language downgrade also clears `supersedesId`: a note
    not recalled by its own title is unfit to replace an established conclusion.
  - **Four defects were found by the tests this change adds, three of them in the
    first draft of the counting rules.** `\b[A-Za-z][A-Za-z-]{2,}\b` never matched
    `FTS5` or `UTF8` (a digit is a word character, so that boundary does not
    exist), letting a sentence of identifiers measure as zero words and pass any
    ceiling; a letters-only remainder then counted `FTS5` as one word but `ES6` as
    none; a lookahead could not exclude `应该` from the deictic rule, so that single
    word reported as both a hedge and a deictic; and reading a CJK share of zero as
    "unclassifiable" switched the language rule off for every English note. Each fix
    is pinned by a case in `test/note-style.test.js`.
  - **Verified:** `npm run check` — 978 tests, 977 pass, 1 skipped (the opt-in
    `test/smoke/` lane, which was not run), 0 fail; `npm run types` clean (the module
    carries `// @ts-check` and is listed in `tsconfig.json`); `verify-pack` and
    `verify-tarball` OK, the tarball now 62 entries over 52 `lib/` modules. The probe
    over the author's vault reports 314 of 739 notes with at least one finding and
    **4** that would reroute. `test/distill.test.js` adds four cases covering the
    prompt-and-validator contract and the reroute path.
  - **Unverified:** the thresholds were *tuned* on this vault, so fewer findings is
    not evidence that recall improved — no retrieval-quality measurement was made,
    and the machine-local diagnostics and recall cache under
    `~/.dsh/data/obsidian-mem/` are all from test runs (`project p1`), so they were
    deliberately not used as evidence for one. The prompt now carries four more
    rules and no case measures what a model produces in response; published
    instruction-following evidence (arXiv 2607.19257) argues for short rule lists,
    which is why the prompt states four rather than nine. The reported hit rates are
    counts on one vault at one time, not a benchmark. Budgets moved and are recorded
    in `test/architecture.test.js`: `lib/note-style.js` at 375 (measured 351) and
    `lib/distill.js` from 975 to 1050 (measured 1011).

### Fixed

- **Curation scanner/store residuals and selectable status** (Task 10): status and
  scan now expose up to 200 pending `proposals.items` with only `proposalId`, `kind`,
  bounded `reason` and `reviewOnly` (from the stored operation, including both forms
  of near duplicate). The six tools and their inputs stay unchanged; choose an ID
  from that listing for interactive review. Proposal bytes are fsynced privately
  before exclusive atomic publication, and findings process every queue row for
  retirement while retaining only metadata. Creation/replay accounting comes from
  the publishing producer; `updated` remains empty because candidates are immutable.
  Full titles drive near identity; legacy records are reinspected. Scan enumeration
  uses the indexer's vault-relative depth, concurrent cursor updates preserve a
  newer manifest or equal-prefix timestamp, and programming defects escape both
  record-write catches. Local date formatting is shared without a new dependency.
  New regressions failed before the changes: seven confirmed residual failures in
  the initial focused run, cleanup registration 1/1, ToolRuntime/MCP selection 2/2,
  and equal-prefix/retry defects 2/2. Identity ordering, findings byte caps and the
  compact/pretty persistence boundary add coverage for existing behavior. The first
  boundary fixture was incorrect and corrected; it is not counted as a product
  defect. Live host/model delivery, timing
  optimality and historical run/commit limitations remain unchanged and disclosed;
  the controller runs the whole-branch gate after the follow-up tasks.
  - **Fix round 1 corrected the cursor ordering the task review falsified.** The
    conditional publication compared the re-read cursor against a snapshot that was
    itself read *after* the manifest walk, so a pass that had already enumerated an
    older manifest could read a newer pass's cursor as its own starting point; the
    equal-snapshot check then had nothing to catch and the older fingerprint and its
    older `scannedAt` overwrote the newer one. Measured in the review's isolated
    probe: `newerFingerprint 4de77ac3…`, `storedFingerprint dc3a0af5…` (the older
    walk's), `newerDate 2026-10-04`, `storedDate 2026-10-03`,
    `overwroteNewerCursor: true`. The snapshot is now read before
    `walkManifest`, which is what makes the equal-snapshot check mean "nobody
    published between my snapshot and this write". Same-manifest progress and the
    equal-prefix timestamp merge are unchanged, and the vault lock stays short.
    RED/GREEN on the new case (*a pass that has not yet read a cursor cannot adopt a
    newer one as its snapshot*, gated on the cursor-path `lstat`): against
    `f22c982`'s scanner it fails with the stored cursor carrying the older
    `manifestFingerprint e1946da1…` and `scannedAt 2026-10-03T00:00:00.000Z` where
    the newer pass wrote `1bf8db01…` and `2026-10-04T00:00:00.000Z`; with the fix
    it passes, and the focused lane (`test/curation-residual.test.js`,
    `test/curation-proposals.test.js`, `test/curation-scan.test.js`,
    `test/curation-view.test.js`, `test/curation-baseline.test.js`,
    `test/tools.test.js`, `test/codex-mcp.test.js`) is **116/116**.

- **Review claims remain exclusive across competing apply/reject reviewers**
  (Task 9). A private `0600` `.review-lock.sqlite` beside the existing proposal JSON
  serializes claim read/check/replacement and release in short SQLite transactions.
  The guard contains no proposal data and is released before any vault transaction;
  no nested vault lock or new runtime dependency is introduced. A live owner never
  loses its claim merely for age; only confirmed process death (`ESRCH`) permits
  reclamation. Invalid claims, unavailable SQLite, initialization failures and busy
  guards fail closed with the declared `review-lock-unavailable` refusal. A wedged
  live owner must be stopped before recovery; PID reuse can conservatively delay it.
  Stop old review processes before upgrading: they do not participate in this guard.
  - RED on `49c7eb1`, under a fresh `DSH_HOME`: changing the old deterministic
    three-reviewer probe's third decision to reject and requiring refusal,
    `node --test --test-name-pattern='three reviewers cannot' test/curation-review.test.js`
    → **1 test / 0 pass / 1 fail**, actual `rejected`, expected `refused`.
    The replacement behavioural cases, before implementation,
    `node --test --test-name-pattern='three reviewers cannot|unavailable claim guard'
    test/curation-review.test.js` → **2 tests / 0 pass / 2 fail**: a competing apply
    proceeded behind an old live owner, and an unavailable guard did not refuse.
  - GREEN under a fresh `DSH_HOME`: `node --test test/curation-review.test.js
    test/curation-cli.test.js test/curation-tty.test.js test/transaction.test.js
    test/architecture.test.js` → **95 tests / 95 pass / 0 skipped / 0 fail** on
    Node v26.0.0. This includes a real `--no-experimental-sqlite` child, a busy
    SQLite transaction released by `SIGKILL`, and `0600` claim/guard permissions.
    `npm run types` and focused ESLint passed. The controller runs the full final gate.
  - The former tests encoding the deliberately weak two-reviewer guarantee are
    replaced by active-owner exclusion, release/retry, real process death with two
    reclaimers and a third rejection, missing SQLite, busy-guard process death and
    unavailable-storage checks. Existing source-hash, ownership, crash replay,
    idempotent create and CLI-only approval checks remain. The model tool surface
    stays at six. The older Task 7 disclosures above remain historical records.
  - **Fix round 1 closed two findings from the task review, one of them an escape
    the first implementation introduced.** The guard was opened with
    `openSync(guard, 'a', 0o600)` and then handed to SQLite by pathname, so a
    pre-existing `.review-lock.sqlite` **symlink** made even a *rejection* create a
    4096-byte SQLite file at the link target — measured in an isolated snapshot with
    the guard pointing at a path inside the bound vault. It is now opened with
    `O_NOFOLLOW` and must be a regular file with one hardlink whose `ino`/`dev`
    match the descriptor, so a symlink and a hardlinked outside file are both
    refused. Second, a **dead apply** can leave a published note behind a still
    `pending` proposal, and the reject path marked it `rejected` without looking:
    reproduced with `failAfter: 'receipt'` (status `rejected`, record `rejected`,
    one published note). Rejection now consults durable application evidence first —
    the receipt store *and* the transaction manifests, under the vault lock, through
    the new `hasTransactionEvidence` read-only seam — and fails closed with the
    declared `review-recovery-required` when evidence exists or cannot be
    established. `apply` still opts into recovery and finishes the interrupted
    attempt. Both findings have cases that fail against `1af7bbd`; the covering lane
    (`test/curation-review.test.js`, `test/curation-cli.test.js`,
    `test/curation-tty.test.js`, `test/transaction.test.js`) is **104/104** with
    lint, Prettier, `npm run types` and `git diff --check` clean.

- **An automatic curation trigger can no longer fail a committed job, and DSH session
  activity now consults the 24-hour marker** (Task 6 review round). `lib/capture.js`
  called `onCurationCompleted` bare, after the job's transactions were durable and
  before its receipt: a synchronous throw reached the pass's catch and became a
  `failJob` attempt, which at `maxAttempts` marked a fully applied job `failed` for good
  with its note on disk and no receipt, and a rejected promise was never observed, so it
  surfaced as an unhandled rejection. Probed by reverting the wrapper: the pass summary
  came back `failed: 1` with `reason: trigger-threw`, the job on disk was
  `state: 'failed'` with `appliedItems` already naming the written path, and the receipt
  list was empty. The call is now wrapped — a throw and a rejection each become one
  content-free `curation` diagnostic, nothing is awaited, and the receipt is written
  either way — and two cases drive both outcomes at the real seam, failing without the
  wrapper.
  `lib/hooks.js` gains the DSH half of the brief's "a due check on DSH session
  activity", which no DSH path implemented: a new `planCurationDue` asks the
  once-per-session activity seam (the one the weekly `lintHint` already uses) for one
  bounded pass with `dueOnly: true`, through a new `onCurationDue` seam. The request is
  handed to its owner rather than awaited, so nothing about a turn waits for it; a
  missing seam, an unbound repository, a throwing owner and an owner that answers with
  a rejected promise all leave the turn as it was. `lib/index.js` arms it only while
  `autoCurate !== false`, drops it once the fiber's disposer has run, and gives both
  automatic triggers the one per-project in-flight guard. That closes the coverage
  Task 5 deferred: a case drives a fresh marker to `skipped`, a stale marker plus a
  `mem_log` day log — a note that entered the vault outside `mem_write` — to `scanned`
  with the day log in the committed view, and the fresh marker the pass wrote back to
  `skipped` again.
  Also in this round: the worker's "two kicks" case claimed a callback `await` kept the
  pass in flight (it is never awaited) and raced `completeJob`'s fs latency — it now
  proves the answer is the running pass's own summary, and a new case drives two
  automatic triggers for one project while the test holds the vault lock the pass needs
  to write its cursor, failing when the guard line is deleted (3 events instead of 2);
  `codex/session-start.mjs`'s comments no longer call the pass "a quarter of a second"
  or the 256-note/500-ms bounds "this adapter's own" — they are `lib/curation-scan.js`'s
  shared defaults, which the DSH paths get by passing nothing — and the bounds are now
  those imported constants; `onCurated` moved inside the `try` that protects the pass;
  all four automatic gates read `autoCurate !== false` while the result's `autoEnabled`
  still reports `=== true`, with the reason beside it; the codec comment now names
  `skipped`'s one producer (a `dueOnly` request whose marker was fresh and whose queue
  was empty) and `lib/debug.js`'s category note no longer says the config switch
  produces a record — with the switch off no caller reaches the pass at all, which the
  new case's empty ring asserts; and the real-child Codex case
  now asserts the pass really ran — a cursor and a committed view for the queued note
  under the throwaway `DSH_HOME`, which an MCP-only write cannot produce.
  Measured: `npm test` **864 tests / 863 pass / 1 skipped / 0 fail** (`cbbfc8e` measured
  859 / 858 / 1 / 0, so this round adds five cases); the covering command
  `node --test test/auto-capture.test.js test/hooks.test.js test/codex-hooks.test.js test/tools.test.js test/architecture.test.js`
  reports **153 tests / 153 pass / 0 fail / 0 skipped**.
  Budgets: `lib/capture.js` 2160 → 2200 (2194 measured), `lib/hooks.js` 1150 → 1250
  (1208 measured, the measured-plus-30 rule) and `lib/index.js` 200 → 250 (221
  measured), each with its argument beside it in `test/architecture.test.js`; no layer
  number moved. Untested, unchanged from Task 6: live host delivery — no case runs a
  real DSH session or a trusted `codex exec` — and the Codex 500-ms deadline and
  256-note bound are still asserted as the values the adapter passes, not as a measured
  wall-clock stop.

- **A curation pass no longer acknowledges hints whose view did not commit, and the
  category's vocabulary is registered** (Task 5 review round). `lib/services.js`
  discarded `buildCurationView`'s result and acknowledged the queued paths off
  `scan.examinedPaths`, but that call returns `{status:'fallback'}` **without writing**
  for `backfill-incomplete`, `entry-unusable` and `view-oversize`: the batch was then
  dropped from the durable queue while the stored view never learned about it — the one
  outcome the plan's write-then-acknowledge order exists to prevent. The
  acknowledgement is now gated on `status === 'written'`, a fallback is reported as the
  pass's one code, and the phrase "the scan's records and the view are both durable"
  (false in exactly that case) is gone. A case injects a `fallback` verdict through a
  new test-only `buildView` seam, after the real scan has examined the queued path,
  and requires the hint to survive; it fails on the pre-fix branch with the queue
  emptied. The same round registered what the category persists:
  `lib/diagnostic-codec.js`'s `CODES` gains the scanner's four truncation reasons
  (`file-budget`, `time-budget`, `manifest-changed`, `records-missing`), the state
  payloads whose read is refused (`state-not-a-file`, `state-corrupt`,
  `state-oversize`, `cursor-invalid`, `record-invalid`, `changed-invalid`,
  `view-invalid`, `view-oversize`) and the view build's refused values
  (`entry-unusable`, `backfill-incomplete`), so a call that reports why it wrote
  nothing is no longer persisted as `other`; the `curation` outcome set keeps
  `failed`, which the per-finding refusal and Task 6's trigger catches emit. Two
  cases loop the whole outcome set and the whole code set through encode/decode, and
  the fallback case feeds the event a real pass recorded through the codec — both fail
  on the pre-fix codec (`file-budget is not coarsened`; `actual: 'other'`). That list
  was still incomplete and this entry's "the four-name list" framing was wrong;
  **see the round-2 entry below, which enumerates the families it missed and replaces
  the loop that could not fail.** Also
  corrected here: the Task 5 entry above stated the scanner writes a coverage cursor
  from a changed-path pass (it is guarded by `if (fullPass && …)`, and `fullPass` is
  `requested.length === 0`), said a per-finding refusal is "reported with code
  `failed`" (`failed` is the outcome; the code is the error's own), and claimed the
  disk vocabulary was in sync while `failed` and every code were absent from it. And
  the `view-unwritable:<code>` fallback was reported as unreachable: the probe behind
  that was a raw `fs` failure at the view path, which is not wrapped as a
  `CurationStateError`, so `fs.rename`'s `EISDIR` escapes `buildCurationView` as a
  throw (probed with a directory standing in for the view file). That is one route,
  not the whole family — see the round-2 entry, which records the reachable route the
  review measured and the residual this entry wrongly closed.
  Measured: `npm test` **859 tests / 858 pass / 1 skipped / 0 fail** (the same tree
  with this round's edits stashed measured 857 / 856 / 1 / 0, so this round adds two
  cases); the covering command
  `node --test test/tools.test.js test/debug.test.js test/diagnostic-codec.test.js test/config.test.js test/codex-mcp.test.js`
  reports **95 tests / 95 pass / 0 fail / 0 skipped**, and Task 6's adapters
  (`test/hooks.test.js`, `test/auto-capture.test.js`, `test/codex-hooks.test.js`) are
  green in the same run at 203 / 203.
  Budgets: `lib/services.js` 1550 → 1600 (1578 formatted lines measured — the 1575 this
  sentence first gave was a stale measurement, corrected in fix round 3; the file's
  own rule would round 1578 + 30 = 1608 up to 1650, so 1600 is deliberately inside the
  rule rather than its number, which the entry beside it in `test/architecture.test.js`
  now says — as first written it claimed measured-plus-30 rounded to 1600, which is
  false arithmetic), `lib/diagnostic-codec.js` 200 → 250 (210 measured, same rule) and
  `lib/tool-schema.js` 950 → 1000 (948 measured, the same rule the sibling service
  entry uses), each with its argument beside it in
  `test/architecture.test.js`.

- **Every fixed curation code is registered, and nothing claims the vocabulary is
  complete** (Task 5 review round 2, R33). The round above registered 15 codes and
  three places called that list the vocabulary; the reviewer measured it incomplete
  four ways. `lib/curation-codes.js` is new: a leaf module (L0, it imports nothing)
  holding the four families that can reach a `curation` event's `code` — the scanner's
  five `truncatedReason` values (`file-budget`, `time-budget`, **`manifest-budget`,
  which the round above omitted**, `manifest-changed`, `records-missing`), the private
  state store's sixteen (`state-unreadable`, `state-not-a-file`, `state-corrupt`,
  `state-oversize`, `cursor-invalid`/`-version`/`-project`, `record-invalid`/`-version`/
  `-mismatch`, `changed-invalid`/`-version`/`-project`, `view-invalid`/`-version`/
  `-project`), the proposal store's thirteen `proposal-*` codes plus the four state
  refusals its record reader repeats, and the view builder's five fixed fallback
  reasons. `lib/diagnostic-codec.js` derives `CODES` from that module, which is why it
  is a leaf: the codec is L1 and the four emitters are L4–L6, so having the codec import
  the emitters is the upward edge `test/architecture.test.js` refuses, and a second copy
  in the codec is the drift this removes. The test
  `test/diagnostic-codec.test.js`'s "every code a curation emitter can produce survives
  the round trip" now **derives** its loop from those families and parses the four
  emitters with the TypeScript AST, requiring each module's thrown/returned codes to
  equal the list declared for it — the case it replaces looped a hand-written copy of
  `CODES` and could not fail for an unregistered code, the self-fulfilling-name defect
  the first review named. It also pins the derived union, so adding a code to an emitter
  without registering it fails. Two things this does **not** claim: `view-unwritable:
  <code>` appends a raw filesystem error's code and is a dynamic family no list can
  enumerate, so it is coarsened to `other` on purpose (the comment in
  `lib/diagnostic-codec.js` and the `CURATION_VIEW_CODES` comment say so), and
  `view-unwritable` itself **is** reachable — the review measured a legal ≤2000-entry
  document inside the margin between the builder's **compact** serialisation check
  (`MAX_VIEW_DOCUMENT_BYTES`, 768 KiB, `lib/curation-view.js`, measured on
  `JSON.stringify(document)`) and the store's **pretty-printed** bound (`MAX_VIEW_BYTES`,
  1 MiB, `lib/curation-state.js`, measured on `JSON.stringify(value, null, 2)`), so the
  round above's "unreachable rather than merely untested" was an
  over-claim about one probe (a directory standing in for the view file, `EISDIR`). The
  underlying defect — the raw filesystem failure escaping `buildCurationView` as a throw
  — remains a recorded final-fix-wave item and is not fixed here. Also corrected: the
  budget entry and the round above said "1575 measured; measured plus 30 rounds up to
  1600", which is arithmetic that does not hold (1575 + 30 = 1605, whose rule number is
  1650); both now use the "deliberately inside the rule" wording of the sibling entries,
  and 1600 is stricter than the rule so no debt is hidden.
  Measured: `npm test` **864 tests / 863 pass / 1 skipped / 0 fail** — the same totals
  as `95d08eb`, because this round replaces a case rather than adding one; the covering
  command
  `node --test test/diagnostic-codec.test.js test/tools.test.js test/debug.test.js test/architecture.test.js`
  reports **60 tests / 60 pass / 0 fail / 0 skipped**. `lib/diagnostic-codec.js` is
  **233** formatted lines against its 250 budget, `lib/curation-codes.js` is under the
  600-line default and the layer table gains one leaf (`curation-codes: 0`) with its
  reason beside it. Falsification: removing `manifest-budget` from
  `lib/curation-codes.js` fails the round-trip case with
  `lib/curation-scan.js names codes lib/curation-codes.js does not declare, or the
  reverse`; adding `view-budget` to both the declared list and an emitter's `reason`
  fails the same case at the pin of the derived union. Both mutations were reverted and
  never committed.

- **The curation code list has one source, and the check that guards it tells the truth**
  (Task 5 fix round 3). Round 2 moved the vocabulary into `lib/curation-codes.js` but left
  a second, unconsumed `CURATION_TRUNCATION_REASONS` in `lib/curation-scan.js`, whose
  comment claimed "the persisted diagnostic vocabulary is derived from the module that
  produces the value" — it is not: the codec derives from the leaf, nothing imported the
  scanner's copy, and the copy was unchecked. Measured: with the round-2 scanner restored
  and `manifest-budget` deleted from that copy, the codec test file still reports **9 tests
  / 9 pass / 0 fail**, because the AST scan reads `truncatedReason:` properties and never
  the export array. The copy is deleted — the file drops from 1257 to 1244 lines and its
  budget from 1257 to 1247, so the deletion is spent rather than banked — and both comments
  now describe what actually binds the four emitters: no emitter imports the leaf to raise
  a code, and the binding is `test/diagnostic-codec.test.js`'s per-module equality, which
  parses the scanner, the state store, the view builder and the proposal store and requires
  each module's code literals to *equal* the family declared for it. The same case read
  only a **literal** first argument to `CurationError`/`CurationStateError`, so a code bound
  to a name was invisible while `lib/diagnostic-codec.js` promised "a fixed code an emitter
  can produce and this set lacks is a failing test rather than a silent `other`". Measured:
  the reviewer's probe (`const hidden = 'curation-blindspot'` plus
  `throw new CurationStateError(hidden, 'probe')` in `lib/curation-state.js`) leaves the
  committed round-2 case at **7 tests / 7 pass** and fails the extended one with
  `lib/curation-state.js names codes lib/curation-codes.js does not declare, or the
  reverse`, naming `curation-blindspot`. The scan now resolves an identifier or a ternary
  through the module's own bindings and keeps the literal-only path as the control that
  shows what it misses; the codec comment states the residual it still does not cover — a
  code that reaches a constructor through a helper's parameter
  (`requireText(input.kind, …, 'proposal-kind')` in `lib/curation-proposals.js`) is in that
  module's found set only because the neighbouring throw repeats the literal. Two coverage
  gaps close with it. `not-bound`, the one code the codec adds by hand and the one the
  derived union cannot contain, now has a guard: deleting it from `CODES` fails the case
  (`expected: 'not-bound'`) instead of leaving all four covering files green. And the
  **second** coarsened dynamic family is disclosed and pinned: `writePrivateJson` rethrows
  a raw filesystem error unchanged, so a hint or an acknowledgement that cannot be written
  hands a raw errno to the catch sites that record `error.code` — probed by putting a file
  where the private `curation/` directory belongs, which makes `writeCurationViewJson`
  throw a plain `Error` with `code: 'ENOTDIR'` rather than a `CurationStateError`, and the
  codec persists that errno as `other`. The codec comment previously read as if
  `view-unwritable:<code>` were the only such family. `lib/services.js` also said "the
  reachable ones are `backfill-incomplete`, `entry-unusable` and `view-oversize`" while
  `view-unwritable:state-oversize` is reachable through the margin between the builder's
  **compact** check (768 KiB) and the store's **pretty-printed** bound (1 MiB); the comment
  now names all four and says which route does *not* reach them. `lib/services.js` measured
  **1578** formatted lines, not the 1575 both entries gave, and those two numbers are
  corrected in place. Finally, `test/curation-scan.test.js` reads the wall clock only
  through the stepping clock its `scan` helper injects (the file's own seam), because the
  500-ms default turned `complete` and `truncatedReason === null` into assertions about
  machine load. Measured, and wider than the one case the review saw: with only that case
  fixed, a full suite under eight concurrent fsync loaders (3.2x) failed **four** other
  cases in this file with `time-budget` — `a directory the resolver cannot enumerate makes
  it silent, never a false dead link`, `a truncated link universe makes the resolver silent
  rather than confident`, `the manifest budget is a coverage truncation the pass names and
  never hides`, and `verifying the covered prefix obeys the deadline`. The injected clock
  cannot reach a 500-ms budget from a fixture of a handful of notes, and the two cases that
  are *about* the deadline still exercise it: `maxMs: 0` truncates before the first read,
  and the case that raises the clock by 100 ms per consultation still reaches its 250-ms
  budget after two notes. The whole file is **20 tests / 20 pass / 0 fail** under that same
  load, and the loaded full suite reports no failure. Probed on a scanner where one note
  read costs 120 ms, the pre-round-3 case fails its `complete` assertion and the round-3
  case passes. Measured: the covering command
  `node --test test/diagnostic-codec.test.js test/tools.test.js test/debug.test.js test/architecture.test.js test/curation-scan.test.js`
  reports **82 tests / 82 pass / 0 fail / 0 skipped**, and `npm test` reports **901 tests /
  900 pass / 1 skipped / 0 fail** twice — 69.7 s idle and 138.1 s with the eight fsync
  loaders — so the totals no longer depend on load. Task 7's concurrent commit
  `b4eccce` carried this round's `lib/curation-codes.js` header rewrite, its
  `test/architecture.test.js` budget lines (1247 and 1578) and its two `1578` corrections;
  the rest of the round is in this commit, and nothing in it moves a layer number or the
  six-tool surface.

- **The parked-candidate signal is no longer thrown away, and the retry barrier is
  pinned** (Task 3 review round). `review` was missing from the diagnostic codec's
  `distill` outcome set, so the one durable record of *why* a parked item produced
  no note was persisted as `other` — a green suite could not see it because the
  in-process ring carries the token fine and only the disk format coarsens it.
  `lib/diagnostic-codec.js` now lists it, a case loops the whole `distill`
  vocabulary through encode/decode, and a second case drives the real journal sink
  and reads the token back off disk after a parked pass (this sentence said "the real
  ring" until fix round 2: the ring holds the token whatever the codec does, so that
  assertion could not fail for the reason the case claims). `parkRiskyCandidate` also
  accepted a seam that resolved
  *something* without an identity: `proposalId: null` went into `appliedItems` and
  the receipt and the item was then `continue`d past, so the job completed with the
  candidate recorded as parked and no durable record of it anywhere. A `propose`
  seam that answers without a non-empty string identity is now refused with
  `propose-failed`, the same code a refusing seam raises, which keeps the job
  `validated` and retryable instead of completing it on a lost candidate.
  Measured: `npm test` **810 tests / 809 pass / 1 skipped / 0 fail** (the 809 round 1
  measured predates Task 2's `06a6a43`, whose nineteenth
  `test/curation-scan.test.js` case is the one added test); the
  round-trip case fails on the pre-fix codec with `review is not coarsened`, the
  guard case fails with `Missing expected rejection: a seam answering undefined must
  throw`, and the persisted-record case fails on a codec without `review` because the
  record read back off disk is `other`. The brief's mandated retry-barrier case is now
  pinned by
  `test/auto-capture.test.js` (a throwing `propose` seam through the real
  `processQueue`: `state: 'validated'`, `attempts: 1`, `lastError.code` of
  `propose-failed`, `nextAttemptAt` in the future, no receipt, byte-identical
  vault) — that behaviour already held, so the case is a regression guard rather
  than a fix, and it passes on the pre-fix code too.
  Untested: the guard is reached only through a caller-supplied seam, so the case
  drives a `writeMemory` wrapper with a throwing `propose` rather than a second
  production seam.

- **Two `lib/memory.js` comments corrected, and one round-1 report claim withdrawn**
  (Task 3 review round 2). The block above `createNote`'s request called the kept
  `supersedes`/`expectedSupersedesHash` shape "the wire contract `updateNote` uses":
  `updateNote` refuses `supersedes` outright and never reads that field, and the
  consumer is `createNote`. The same JSDoc listed the live pre-check refusals as
  `note-not-found`/`human-owned` while `ownership-unproven` lands there too, which is
  also what a MOC container raises. Both comments now name the real consumer and the
  complete live set. Nothing executable changed. The round-1 report claimed a
  `test/auto-capture.test.js` comment ("the engine saw `hash-mismatch`") had been
  corrected; that line is byte-identical between `3f9d429` and `18b15a3` and is
  accurate history, so no change happened and none was needed — the claim is
  withdrawn rather than the record rewritten.

- **The curation scan action takes an internal bound, so its coverage cases no longer
  ride the wall clock** (Task 5, R40). `createMemoryServices` accepts an optional
  `curationBounds` (`{maxNotes?, maxMs?}`, default `null`) which the admin `scan` action
  threads into its one pass; `test/tools.test.js` supplies generous limits for the five
  assertions that claim `complete`, and a case with a tiny bound shows the limit is live.
  **Nothing user-visible changed:** the option is not a tool parameter, not in
  `TOOL_PARAMETERS`, and not in the `mem_admin` description — the six tools' names,
  descriptions and compiled input schemas are byte-identical to the pre-change output — and
  no production caller passes it. It is recorded here because any change under `lib/` has
  to move this section, and the one line of shipped code that exists for the tests should
  be visible rather than smuggled in with them. Measured on this change: three
  back-to-back `npm test` runs, identical totals **903 tests / 902 pass / 1 skipped / 0
  fail**.

- **The whole-branch review's findings land in one wave, and two of them were behaviour
  rather than prose** (final fix wave). The automatic recall entrance now actually reads
  the view it writes, a filesystem failure at the view path is a fallback instead of a
  throw that skipped every finding, and the changed-path cap's eviction is reported.
  - **`lib/index.js` consumes the stored view for DSH's own brief.** It handed
    `registerHooks` the raw `buildBrief`, and `lib/hooks.js` called it with no
    `curationView`; only `services.brief` passed one. So on DSH the view was written by
    every pass and read by nobody — the automatic recall entrance its module header says
    it exists for. The assembly now reads `readCurationView({dataRoot, projectId})` and
    passes `curationView: view?.complete === true ? view : null`, mirroring
    `services.brief`, and passes the diagnostics ring so the brief-time verification
    fallback is reported. `test/curation-session-brief.test.js` mounts the shipped
    `apply` on a real Cordis context, drives a real `agent/pre-step`, and asserts both
    halves: the injected brief carries the `记忆视图（引用数据）` section and the view's
    bounded description, and one changed byte falls it back to the source section. The
    first case is RED against the un-wired `d73d337` (measured: 1 pass / 1 fail).
  - **A raw `fs` failure at the view path is a fallback, not a throw.** `buildCurationView`
    caught only `CurationStateError`, while `writePrivateJson` rethrows an `fs.open`/
    `fs.rename` failure unchanged. With a directory where `<dataRoot>/curation/view/
    <projectId>.json` belongs, the build threw a plain `EISDIR` out of
    `curateForBinding` — before `recordCurationFindings` and the acknowledgement — so that
    project's automatic passes failed on every trigger and its findings never became
    proposals. The catch is now unconditional and answers
    `fallback`/`view-unwritable:${code}`; `test/curation-view.test.js` adds the failing
    case (RED against `d73d337`: `Error: EISDIR: illegal operation on a directory, rename
    …`). This also closes the deferred "untested `view-oversize`/`view-unwritable`" item
    for the raw-`fs` route; `view-oversize` was already covered by the injected-build case
    in `test/tools.test.js`.
  - **The changed-path cap's drop is visible.** `MAX_CHANGED_PATHS = 512` evicts the
    oldest hint and returns `dropped`; both callers discarded it, so the spec's "any
    truncation … is visible in the curation status" was violated. `queueCurationHint`
    (`lib/services.js`) and the queue worker's copy (`lib/capture.js`) now record a
    content-free `curation` diagnostic — `outcome: 'changed-path-dropped'`, `hits: n`,
    the project id, and no path or note text — and the codec's closed outcome set and its
    two test lists carry the new token. `test/tools.test.js` fills the durable queue to
    its cap, commits one real write through the service, and asserts one event with
    `hits: 1`, the newest hint still queued and the evicted one gone (RED against
    `d73d337`: no `curation` event at all). **The two comments that justified the drop are
    corrected:** a full pass does *not* re-read a covered path (it trusts the record's
    presence), so a dropped hint for an edited, already-covered note leaves the stored
    record and the view entry holding the pre-edit hash and the brief falls back until
    that path is queued again — the cap is unchanged, the claim is not.
  - **Both READMEs no longer promise that deleting `curation/` costs one scan and nothing
    else.** That directory also holds the durable proposal store at `curation/proposals/
    <projectId>/`, so the sentence is now scoped to the four rebuildable documents — the
    cursor, the per-path scan records, the changed-path queue and the view — and states
    plainly that `proposals/` is not rebuildable and that deleting it discards review work
    no scan recreates. `README.i18n.yaml` carries the re-recorded blob hashes of both
    sides.
  - **Nine prose and count claims corrected, each against a probe or the code.** (i) The
    link-matrix attribution: both surfaces' `true` for `[[LICENSE]]` is carried by
    `<project>/Docs/LICENSE` beside the linking note, not by a vault-root copy the fixture
    does not contain; the resolver comment, the covering case and the Task 2 entry above
    now say so, and the case asserts the three resolver probes directly. (ii) The matrix's
    silent-scan/dead-lint count was stated as seven and the asserted rows were eight; the
    dot-bearing row makes it nine, and the test comment, the resolver comment,
    `lib/note-health.js` and the Task 2 entry now name three shapes and nineteen rows.
    (iii) `lib/curation-scan.js`'s "the covering test asserts both halves" over-claimed:
    the second half — editing the linking note and asking a changed-path pass brings the
    dead link back — is now asserted in `test/curation-scan.test.js`. (iv) The READMEs
    listed nine diagnostics events where the code holds ten (`curation`); both now say
    ten. (v) `lib/curation-proposals.js` said a kind outside its review set "is an error"
    while the code counts it in `skipped` and continues; the prose matches the code, and
    the stale state-finding parenthetical gained `enumeration-failed` and
    `resolver-truncated`. (vi) `lib/brief.js`'s "the coverage answer is about the whole
    view, never about the slice" was contradicted by the caller reading `renderedPaths`,
    and "can only make the selection shorter" had the sign backwards (the `+ 3` over-counts
    the last line by one, but the view section's 14-code-point heading is never charged, so
    the prefix can run *longer*); both now say what the code does. (vii) The READMEs' "a
    truncated full pass records a fresh due marker" is false for `manifest-budget`, which
    deliberately leaves the cursor alone; both qualify it. (viii) This entry's own cadence
    paragraph said the triggers pass "exactly `{dueOnly: true}`" (Codex also passes
    `maxNotes`/`maxMs`, the DSH write trigger passes `changedPaths`) and that "the opposite
    direction is measured as well" (no run measures it); both corrected, the second as
    source-inspected. (ix) The `VIEW_ENTRY_LIMIT` sentence described a cut a real project
    never meets; measured, 2000 minimal entries are 673 878 compact bytes against the
    768 KiB bound while 2000 realistic ones are 1 287 878 and are refused as
    `view-oversize` first.
  - **Three smaller fixes with tests.** `lib/curation-cli.js` answered a stored record it
    cannot read as `proposal-missing` — a false statement about a record that is there —
    where the review module answers `proposal-unreadable`; `test/curation-tty.test.js`
    drives the command over a real pty against a corrupt record and asserts the code.
    `lib/tool-schema.js` publishes "256 notes / 500 ms" to the model and
    `DEFAULT_MAX_NOTES`/`DEFAULT_MAX_MS` were pinned by no test;
    `test/tools.test.js` now asserts both constants and that the published description
    contains them. `lib/capture.js` re-reported an already-parked item as
    `skipped: true` without its `proposalId`, losing the one handle to the proposal on a
    replay; the field is carried through. The width-3 apply/reject race was disclosed
    beside the then-current claim limit: an apply racing a reject at three reviewers
    could leave a published note behind a `rejected` record, which the shared
    idempotency key did not repair. Task 9 closes that race; this remains the record
    of what this earlier wave verified.
  - Measured on this wave, every run under a fresh `mktemp -d` `DSH_HOME`: `npm run
    check` **exit 0** — lint, format, types, `prepack` and `pack:check` — with the full
    suite at **923 tests / 922 pass / 1 skipped / 0 fail** (916/915/0/1 before the
    wave), `verify-pack: OK` (16 required assets, 6 tools) and `verify-tarball: OK` (61
    entries, 51 lib modules — no new module, so the archive is the size it was);
    `git diff --check` clean. The new cases are
    `test/curation-session-brief.test.js` (2), the raw-`fs` fallback case, the
    cap-diagnostic case, the replayed-parked-item case, the `proposal-unreadable` CLI
    case and the scan-bounds case, plus the changed-path-return assertion (an added
    assertion, not a new case). The four falsifications are recorded above; the wave's
    report (`.superpowers/sdd/2026-10-03-automatic-memory-curation/
    final-wave-report.md`) carries the raw command output. **Unverified:** a single job
    whose committed paths alone reach 512 hints. The queue worker's own copy of the cap
    diagnostic (`lib/capture.js`) sums a job's per-enqueue drops into one event, where
    the service emits one event per enqueue with that enqueue's own count, and only the
    residual wave below pins it (a two-item job against a full queue, `hits: 2`); the
    codec round-trip case pins the outcome's vocabulary on the service path only.

- **The re-review's six residuals close, and one of them was behaviour** (final residual
  wave). The queue worker's changed-path cap report sums a job's drops, the delta
  pre-step stops reading a view it discards, and the rest are claims corrected against
  the code.
  - **Both READMEs no longer call the whole `curation/` directory rebuildable.** The
    data-root tree still listed "parked proposals" among the rebuildable documents — the
    same claim the previous wave corrected in the bullet above, and one that costs every
    parked candidate and its decision record when a reader acts on it. The tree now
    splits the label: the cursor, the per-path scan records, the changed-path queue and
    the compact view are rebuildable, and `proposals/` is shown as the durable child it
    is. `README.i18n.yaml` carries the re-recorded blob hashes of both sides.
  - **"`names` holds only dot-free stems" was false at four sites.** The resolver adds
    every file's last segment and strips only a trailing `.md`, so this fixture's set does
    hold `txt.txt` and `图.png`. The conclusion — a dot-bearing bare target is answered
    `true` without a set lookup — holds for the other reason the sentence already leaned
    on: the `name.includes('.')` branch returns before the set is consulted. The resolver
    block and the branch comment (`lib/curation-scan.js`), `lib/note-health.js` and the
    Task 2 entry above now say that.
  - **Two stale citations in this entry.** The `truncated !== 'manifest-budget'` gate is
    now cited at `lib/curation-scan.js:1172` rather than `:1154`, and the Task 2 entry's
    "the matrix grew … to eighteen" reads "that round's matrix grew …", because the
    nineteen the final wave left is the current count (`:336`, `:970`).
  - **The worker's cap diagnostic reports the job's total, not its largest single
    drop.** `lib/capture.js` kept `droppedHints` with `if (hint.dropped > droppedHints)`
    while its comment said "Accumulated", so a job that dropped five hints reported
    `hits: 1` — and `mergeChangedPaths` evicts at most one hint per enqueue, so that is
    the shape a many-item job actually has. It now sums, and
    `test/auto-capture.test.js` drives a two-item job against a queue already at
    `MAX_CHANGED_PATHS` and asserts one event with `hits: 2` (RED against the previous
    line: `actual: 1, expected: 2`).
  - **A `delta` pre-step no longer reads the stored curation view.** `lib/index.js` read
    and parsed the view on every pre-step, but `buildBrief` returns for `mode: 'delta'`
    before it looks at `curationView`, and that pre-step runs on every turn after the
    first brief. The read is skipped for that mode; the `full` path is unchanged.
  - **Two claims in `lib/curation-codes.js` reworded to what the code does.**
    `source-changed` is not consumed by `lib/brief.js` "rather than the diagnostics
    ring": a view that fails verification is recorded there as `curation`/`brief-fallback`
    with exactly that code. And the dynamic half of `view-unwritable:<code>` is not
    coarsened to `other` — the ring's own `code` validator (`lib/debug.js`) admits a
    lowercase token with no colon, so `view-unwritable:EISDIR` never reaches a recorded
    event at all: the field is dropped outright.
  - Measured on this wave under a fresh `mktemp -d` `DSH_HOME`: `npm run check` exit 0 —
    lint, format, types, `prepack` and `pack:check` — with the full suite at
    **924 tests / 923 pass / 1 skipped / 0 fail**; `git diff --check` clean. The new case
    is the two-drop cap case in `test/auto-capture.test.js`; the cap is unchanged, only
    the count it reports.

- **The final follow-up review's findings land, and one of them was a contract the
  shipped documents got wrong** (release-gate fix round). `proposals.truncated` was
  `all.truncated || pending.truncated` while `items` is the **pending** selection, and
  a proposal record is never deleted — so once a project had parked more than
  `MAX_LIST_LIMIT` (200) candidates the flag latched on the all-states listing and
  stayed `true` for the rest of the project's life, even when every pending row was
  returned. All four shipped documents state the contract the other way round ("more
  pending rows exist than were returned"). The reviewer's probe (206 records, 1
  pending) measured `{total: 206, allTruncated: true, pending: 1, pendingTruncated:
  false, reportedTruncated: true, itemsLength: 1}`. The projection now reports
  `pending.truncated`; `total` still carries the all-states count. RED/GREEN: the new
  case *the pending queue reports its own truncation, not the whole never-deleted
  store* (`test/tools.test.js`, >200 retired records and 3 pending, through the real
  tool output validation) fails against the previous projection with
  `actual: true, expected: false` and passes after it.
  - The remaining findings were documentation precision and are corrected in both
    READMEs and both skill editions: `review-lock-unavailable` no longer reads as
    "another review may be running" (a healthy competing review is answered
    `proposal-not-current`; the guard is held only for one synchronous critical
    section), "apply finishes the interrupted attempt" now says it rolls a
    non-committed attempt back and a committed one forward, and the 24-hour cadence
    sentence has its **automatic** qualifier back (an explicit `operation="scan"`
    runs `force` and is not bound by it).
  - `publishExclusive`'s JSDoc no longer promises a `'written'|'exists'` return it
    cannot produce (it always returns `'written'` and throws `EEXIST` for the loser
    of the exclusive `link`, which the caller branches on), the architecture budget
    comment re-measures `lib/curation-scan.js` at 1324 formatted lines after the
    cursor-order fix (1350 budget, unchanged), and the reject path's evidence match
    is documented as exact for one candidate's own interrupted attempt and
    deliberately conservative for the positional-key collision the reviewer named.
  - **One platform limit is now disclosed where it ships.** `withClaimGuard` refuses
    `review-lock-unavailable` when `O_NOFOLLOW` is not a usable integer, which is the
    case for Node on Windows: every `apply` and `reject` refuses there, so curation
    is read-only until a symlink-safe fallback ships. This is fail-closed and was
    already stated in the task report, but reports are not shipped; `README.md`'s
    failure-recovery table now carries the row and says to review on macOS or Linux.
    Reads, writes and scans are unaffected. No such platform was run here — the
    disclosure is from the code path and the constant's documented absence, not from
    a measurement on Windows.
  - Measured after this round, under a throwaway `DSH_HOME`: the Task 10 focused lane
    `test/tools.test.js` green, and the controller's full `npm run check` is the gate
    for the push.

### Changed

- **Both READMEs and both portable skills now describe curation as a workflow a
  reader can follow** (Task 11). The curation section leads with the loop — check
  `operation="status"`, `operation="scan"` when you want the check now, take a
  `proposalId` from `proposals.items`, run the review command from the bound
  project's directory with the host's own `DSH_HOME`, then look again — and only
  then explains the implementation. It states that `reviewOnly` (not `kind`) is
  what separates a decidable proposal from a finding, that a `reviewOnly: true`
  finding is fixed by editing the source it names and rescanning rather than by
  `apply`, that a pass makes no model call, and that an exact-duplicate group is one
  displayed entry — no note is deleted or merged. It names
  `review-recovery-required`, `review-lock-unavailable` and `source-changed` with
  what each means and what to do, and both failure-recovery tables carry the first
  two as rows. The claim file a running review holds is called out as
  non-disposable alongside `proposals/`. For a project larger than one pass the
  reader is told to repeat `operation="scan"` until `complete: true`, and the
  500 ms bound is stated as a bound on *starting* inspections rather than a hard
  wall-clock ceiling.
  - The *Automatic distillation* prose on both sides was stale and is corrected: a
    candidate whose title twins an existing note is **parked** for review rather
    than silently skipped, and a candidate that proposes to supersede one is parked
    too. The cases that still apply automatically — no twin, no supersede — are
    stated beside them.
  - `README.i18n.yaml` records the new blob hashes of both sides, and the six
    English-slug anchors the pair already carried are unchanged: this change adds no
    link to a new heading.
  - Documentation only: no `lib/` behaviour changes and no new tests. The document
    checks in `test/repo-hygiene.test.js` (both READMEs and both skill editions
    naming `autoCurate` and `dsh-obsidian-mem-review`, and the recorded hash
    matching each side) are what gate the edit, and the controller's full
    `npm run check` follows.

## 0.1.10 — 2026-09-29

### Changed

- **`docs/`, `research/` and `AGENTS.md` are local files now.** The repository
  ignores them and they left the index, so the public tree is the plugin, its tests,
  its gates and the two READMEs — not the maintainer's working material: the frozen
  specs and plans, the measured-fact records, the investigation output and the agent
  instructions. They stay on disk and in the history. A fresh clone has to keep
  passing, so two consequences are handled in the same change:
  `test/repo-hygiene.test.js` now checks the documents a checkout actually carries
  instead of requiring `AGENTS.md`, and the README pair no longer links to either
  path. The `docs/p0-compatibility.md` citations under `lib/` and `test/` still
  name the measurements they were written from, but that file is beside the checkout
  now rather than in it.
- **A run whose release is already published no longer reports itself as failed.**
  The marketplace step runs last, after the tag, the tarball and the GitHub Release
  exist, and it exited 1 when `MARKETPLACE_TOKEN` could not write the fork — so the
  notification for a *successful* release read "release: All jobs have failed". It
  probes the credential first (`--check-token`) and downgrades a refusal to a
  `::warning::` that names the permission to grant; nothing is swallowed, and the
  stale entry stays visible in the annotations. Measured on 2026-09-29: the
  marketplace PR pointed at v0.1.6 while v0.1.9 was published and tagged, and the
  local `gh` credential wrote the fork without complaint
  (`marketplace-entry: credentials can write bonerush/awesome-dsh-plugin`) — which is
  what identified the Actions secret, not the account, as the broken link.

## 0.1.9 — 2026-09-29

### Added

- **The graph panel's controls outlive the page now.** They were plain component
  state, and the sidebar is rebuilt from scratch on every load, so a reload — or a
  host restart — put scope, filters, colour groups, display and forces back at their
  built-in values. They are stored in this browser's `localStorage` under one
  versioned key (`dsh-obsidian-mem:graph-settings`), read through a new browser
  module served beside the renderer (`lib/graph-settings.js`) and written back only
  after that read lands: the first render still holds the built-in defaults, and
  saving those would erase the record. Storage is not trusted in either direction —
  every field is validated and falls back field by field, a record from another
  version is ignored rather than migrated, colour groups are bounded, and a storage
  that refuses to be read or written (a private window, a full quota) leaves a graph
  that works. The graph route stays read-only. The unit matrix covers the round trip,
  the per-field fallback, the version fence, the group bounds and both storage
  failures; `graph-route.test.js` now loads every module the client names by URL, so
  a name with no route fails the suite instead of 404-ing inside the panel.
- **A new asset needs one plugin remount, and the README now says so.** The route
  list is captured when the plugin mounts, so `/obsidian-mem/graph-settings.js`
  answered 404 on the live host while `graph-renderer.js` answered 200 from the same
  process — measured, not assumed. A reload is enough for a change to an asset that
  already has a route; a file that is new to the list needs the remount.

### Fixed

- **Two notes lit in the same second no longer disagree about the size of their
  titles.** While the graph was zoomed out, a lit label was drawn at
  `rootScale + (1 - rootScale) * weight`, so its size followed its own cue's weight:
  a `mem_search` hit keeps 0.6 of a read, so it stayed visibly smaller than the
  `mem_read` beside it, and the size moved under the reader as each cue faded in and
  out. The pin is now the frame's largest cue weight, which draws every lit label at
  one size at any instant while the fade stays in the alpha. The hovered label keeps
  app.js's own `1 / scale` pin, and a single cue behaves exactly as it did — the
  pre-existing release test still passes unchanged, and the new one fails on the old
  formula and passes on this one.

## 0.1.8 — 2026-09-29

### Added

- **The memory graph follows the agent's own file work now, not only `mem_read`.**
  A turn that wrote 24 notes, ran 10 admin actions and read the vault through the
  host's `read` tool lit nothing, because the activity feed had exactly two
  producers: a successful `mem_read` and an injected recall map. It now also cues a
  `mem_search`'s hits (the same accent at a lower weight — finding a note is weaker
  evidence of use than opening it), a `mem_write`/`mem_log` (the tag colour, so
  "this note changed" does not read as "this note was read"), and any host
  `read`/`edit`/`write`/`grep` whose arguments name one `.md` inside the vault.
  `bash`, `run_code` and `glob` are excluded deliberately: their arguments are
  command text, program text or a search root, and that one turn mentioned vault
  paths in 25 `bash` and 36 `run_code` calls without opening a note. The event
  shapes are measured in `docs/p0-compatibility.md` §12 — `tool/call` carries
  `arguments` as a JSON string and `tool/ptc-dispatch` as an object, and only the
  latter reports `isError`, which is why a failed nested call is skipped and an
  unparsable argument is simply not a cue. Pinned by tests for the pure mapping, the
  two new service cues, the widened `onAccess` seam, the hook forwarding and the
  cue kinds.

## 0.1.7 — 2026-09-29

  Watching that work on a live host caught one defect in it: the config keeps the
  vault root in its human `~/Documents/dsh-memory` form, and every other consumer
  expands it through the home seam, but the cue mapper compared absolute note paths
  against that literal `~` and matched nothing. The `mem_*` cues lit and host tool
  calls stayed dark, which is exactly what a session's activity ring showed. The
  root is expanded once at mount now, and an assembly-level test mounts the plugin,
  emits a `tool/ptc-dispatch` read and posts to the real graph route — it fails on
  the unexpanded root and passes on the expanded one.

### Fixed

- **A title ending in `.md` no longer produces a file with two extensions.** A MOC
  entry is the note's path minus one `.md`, so a note whose *title* already ends in
  `.md` used to land on disk as `X.md.md` while every link to it said `X.md` — a
  file that does not exist, in a link nobody can open, with nothing in the plugin
  able to repair it. `sanitizeStem` strips a trailing extension now (after
  truncation, before the final trim, case-insensitively, so `.MD` behaves too).
  Routing is pinned by a test that asserts the invariant instead of the string: a
  MOC line's target plus `.md` is the path the note actually has. Measured in a
  live vault before the fix: 6 notes across two projects and 7 MOC entries.

- **A wikilink inside code is no longer read as a link.** The dead-link scan ran
  its pattern over the whole body, so a note that *discusses* link syntax
  (`- [[target|alias]]` in prose about MOCs), quotes a shell test
  (`[[ "$x" == y ]]` in a workflow) or quotes the linter's own message was reported
  as linking to something that does not exist — 5 of the 6 findings left in a live
  vault were this, including one the linter wrote about itself. Fenced blocks (a
  fence of three or more backticks or tildes, closed by the same character at least
  as long, unclosed running to the end of the note) and code spans (a backtick run
  closed by a run of the same length) are blanked before the scan. One limit is
  deliberate and stated in the code: a span crossing a line break is not paired,
  because pairing across lines would let one stray backtick hide every link after
  it. The test drives a note carrying all four shapes — real links, a code span, a
  double-backtick span around a single one, a fenced block and a shell `[[` test —
  and reported 6 dead links before the fix, the 2 real ones after.

- **A failed marketplace step now says what is still true.** When it failed on the
  read-only token, the run went red at the last step and read like the release
  itself had failed — while the tag and its asset were already published and only
  the marketplace entry was behind. Both branches now wrap the call and emit an
  annotation naming that state and the fix. There is deliberately no
  `continue-on-error` and no summary step: a step that swallowed its own failure
  would leave the entry stale with nothing red to notice, which is the failure the
  whole job exists to prevent. Simulated with the read-only token: the script's
  own diagnosis, then the two annotations, then exit 1.

- **The marketplace step now learns about a read-only token before it does any
  work, and says what to grant.** The first real release through it failed at the
  very end — clone, edit, validate with the list's own tooling, commit, then a 403
  from `git push` reading `Permission … denied to <user>`, which sounds like the
  wrong account rather than a missing permission. A fine-grained token exposes no
  scope list to compare against (`X-OAuth-Scopes` is a classic-token header), so
  the script now probes `contents: write` with a draft release on the fork, before
  the clone, and names the two permissions to grant. `authHint` does the same for
  a push that fails anyway.

  Two defects were found while building the probe, both by running it: `gh api
  --raw-field` sends every value as a string, so `draft=true` reached the API as
  `"true"` and was refused with 422 (a boolean needs `--field`); and `DELETE
  /repos/{owner}/{repo}/releases/tags/{tag}` answers 404 for a *draft*, so the
  by-tag cleanup failed silently and left the probe release behind — it is deleted
  by id now, and the cleanup is attempted before the error is rethrown. That second
  one is pinned by an opt-in test (`MARKETPLACE_PROBE_LIVE=1`) that measures both
  the by-tag failure and the by-id success against the real fork, because a
  measurement of a live API is the only thing that can pin it.

## 0.1.6 — 2026-09-29

### Added

- **A release now points the marketplace entry at itself.** Both release branches
  call `scripts/marketplace-entry.mjs`, so the pull request that moves the
  entry's `tarball:` to the new tag appears on its own after a release — the entry
  pins a tag, so every release owes the curated list one line. The step needs a
  `MARKETPLACE_TOKEN` secret: the fine-grained token that may write the fork and
  open the pull request upstream, since this repository's own token cannot. The
  script uses two credentials deliberately — `GITHUB_TOKEN` to read this
  repository's releases and `MARKETPLACE_TOKEN` for everything on the listed
  repository — so the fine-grained token does not have to be scoped here too.
  When the secret is missing the step fails with a message naming the secret
  rather than surfacing `gh api`'s "Bad credentials", which names the symptom
  instead of the configuration.

- **`scripts/marketplace-entry.mjs` moves the marketplace entry's `tarball:` to a
  release.** The entry pins a tag, because `releases/latest/download/<file>`
  resolves `latest` per request but reads the filename literally, so a version in
  the asset name makes the link 404 on the next release — every release therefore
  owes the curated list one line. It runs on whatever credentials the caller
  already has (`GH_TOKEN`, or the token `gh auth token` reads from the local
  keyring), so the local path stores no secret at all. It looks up the fork and
  the PR before creating either, rewrites an existing PR on the same branch
  instead of opening a second one, and validates the entry with the listed
  repository's own `readEntries`/`validateEntries`/`tarballProblem` from a fresh
  clone. `setTarball` is pure and carries the tests: a non-GitHub host, a
  non-https URL, anything that is not a `.tgz`, and the `latest/download/` shape
  the marketplace accepts but which cannot survive a release.

## 0.1.5 — 2026-09-29

### Added

- **Every Release now carries the packed plugin as a `.tgz` asset.** The
  marketplace entry for this plugin can point a `tarball:` field at a pinned
  asset URL, which the storefront prefers over the build-from-source command —
  and unlike `github:bonerush/dsh-obsidian-mem`, it does not make a user approve
  a `prepare` script through pnpm's `allowBuilds` before anything installs. Both
  release branches pack with `npm pack --ignore-scripts` (the gate above has
  already run `prepack`, and the default would run the whole suite twice) and
  attach the archive: the bootstrap branch on `gh release create`, the bump
  branch on `create` or `upload --clobber` when the Release already exists.

  Verified by installing the packed archive into an isolated `DSH_HOME`:
  `dsh plugin --profile web add ./dsh-obsidian-mem-0.1.4.tgz` resolved five
  packages in 495 ms with no `allowBuilds` prompt, and the installed copy's
  `dsh-obsidian-mem-diagnose` wrote a report whose `package-files` check passes.
  `v0.1.4` carries the asset and the URL answers a ranged request with `206`,
  which is what the marketplace's own tarball probe asks for.

### Fixed

- **The release guard inlined the commit message into its shell script, so a
  multi-line message broke bash.** The step compared
  `"${{ github.event.head_commit.message }}"` against `chore(release):*`, which
  splices arbitrary commit text into the script: the body's newlines split the
  `[[ … ]]` test across lines and the run died with `conditional binary operator
  expected`, and its backticks were executed as command substitution first. The
  message now arrives through the environment (`COMMIT_MESSAGE`) and the script
  quotes a variable, which is the only shape that treats a commit body as data.
  Found by the failure itself: earlier commits had single-line subjects, so the
  bug first appeared on the release that was adding this file's own feature.

- **The harness peer range silently excluded a version this repository had
  measured.** node-semver only lets a prerelease satisfy a range when some
  comparator in the same set shares its exact `major.minor.patch` tuple *and*
  carries a prerelease tag, so `^0.1.5-rc.1 || ^0.2.0-rc.1` accepted
  `0.1.5-rc.2` and `0.2.0-rc.1` but excluded `0.1.7-rc.2` — one of the two
  versions the README lists as verified. Nothing failed loudly; a user on that
  version would have met an `ERESOLVE` and worked around it by hand. The range is
  now `^0.1.5-rc.1 || ^0.1.7-rc.1 || ^0.2.0-rc.1`, which opts in each measured
  tuple. `test/pack.test.js` asserts the rule rather than the string: for each
  measured version, it is satisfied or its tuple is one the range opts in, read
  out of the parsed range. Red first — the new case failed with
  `silently excludes 0.1.7-rc.2: no comparator opts in the 0.1.7 tuple`. It also
  needs `semver` as an exactly-pinned devDependency; the runtime dependency
  budget is unchanged at two.

## 0.1.4 — 2026-09-29

### Fixed

- **A release section could be inserted above a newer one, and nothing checked
  the order.** The workflow put each new section directly after `## Unreleased`,
  which is right only while releases ship in the order they are written. They did
  not: `v0.1.1` was tagged by hand after `v0.1.2` had been released, so the file
  read `0.1.3`, `0.1.1`, `0.1.2`, `0.1.0` — a sequence the numbers do not have,
  in the one file whose job is to describe them. `scripts/changelog-order.mjs` now
  owns both halves: the release cut places a section by version number instead of
  by position, and a check fails a disordered file. It runs in the fast staged
  gate, in CI as its own named step, and inside `test/repo-gates.test.js`, which
  also asserts this repository's own changelog is newest-first — so the defect
  cannot come back without a test failing. Verified red then green: the check
  refused the real disordered file, `--fix` reordered it to
  `0.1.3, 0.1.2, 0.1.1, 0.1.0`, and the same check then passed.

## 0.1.3 — 2026-09-29

### Fixed

- **The release workflow re-tagged an already-published version, and then would
  never have bumped again.** Two defects, both found by running it rather than by
  reading it. First: "does this version carry a tag?" was asked with
  `git rev-parse`, but a checkout fetches no tags, so after `v0.1.1` was published
  by hand the next run decided the version was untagged and died on `git tag` with
  exit 128. Second, and worse: the same branch then took over every subsequent
  push, so a repository whose declared version was already tagged would only
  re-tag it and never release the next patch. The check now asks
  `git ls-remote --tags origin` and is idempotent, the push is classified into one
  of two branches through an explicit result rather than an `if:` chain, and each
  branch owns its own Release. Verified against a throwaway bare remote: with the
  tag present remotely the run classifies as a bump (`resolved=false`), with the
  tag deleted it classifies as a bootstrap (`resolved=true`), and the bootstrap
  branch tags nothing when the tag is already there.

- **The first release out of the automated path skipped its own bootstrap.** The
  workflow only tags a version that carries no tag, and that step was written as
  the *else* of the guard that skips a release commit. On the very push that
  added the workflow there was no tag yet, so the guard and the bootstrap were
  mutually exclusive: `0.1.1` was declared and never tagged, and the push
  released `0.1.2` instead. `v0.1.1` was then tagged at the commit whose
  `package.json` says 0.1.1, so the number now names the content it always
  described, and this file lists 0.1.1 above 0.1.2 because that is the order the
  numbers run in. Both tags and both Releases exist.

## 0.1.2 — 2026-09-29

### Added

- **A push into `main` is a release, and the version now moves with it.** This
  repository publishes no npm package, so a release is a git tag plus a GitHub
  Release, and `.github/workflows/release.yml` mints both. The policy is
  documented under Development in the README: `0.0.1` per push, `0.1` for a
  notable feature, `1` for a breaking change — so the patch bump is mechanical
  and a major bump is a person editing `package.json` before the push.

  The workflow releases the version already declared when it carries no tag (that
  path produced the `v0.1.1` release), and otherwise verifies the tree with
  `npm run check`, refuses the push when `lib/` changed without a real
  `## Unreleased` entry, bumps the patch, moves the changelog section under the
  new number, updates `dsh.plugin.json` and the Codex server identity, commits as
  `chore(release): <version>`, tags, and publishes the Release from that
  changelog section.

  Two failure modes are designed out rather than discovered later: pushing with
  the default credential helper attributes the commit to `github-actions[bot]`,
  which suppresses `GITHUB_TOKEN` on the resulting push event, so the workflow
  would see "no tag for this version" on every run and bump forever — the remote
  URL carries the token instead; and a release commit has nothing left to
  release, because it moves every entry out of `## Unreleased`, so its own push
  is skipped after the bootstrap step that only tags.

  Honest limits: the skip guard matches the commit subject `chore(release):*`, so
  a person who writes exactly that subject for an unrelated commit would skip
  their own release; and a human push into `main` now fails unless the changelog
  entry lands with it. Neither has been exercised on a real GitHub runner yet —
  the inline steps were run against copies of `CHANGELOG.md`, `dsh.plugin.json`
  and `codex/server.mjs` for both the empty-section refusal and the successful
  cut, and the YAML parses clean, but the workflow itself has not run.

## 0.1.1 — 2026-09-29

### Changed

- **DSH 0.2.0-rc.1 is admitted by the plugin's host peer range.** The
  `@deepseek-ai/dsh-tools` peer now accepts `^0.1.5-rc.1 || ^0.2.0-rc.1`;
  the exact development fixtures move to tools `0.2.0-rc.1` and Cordis
  `4.0.4`. Before the change, the first-party compatibility checker rejected
  this plugin on `0.2.0-rc.1` because of its tools peer. After the change it
  accepts the measured `0.1.5-rc.2`, `0.1.7-rc.2` and `0.2.0-rc.1` lines.

  Verification on 2026-09-29, Node v25.9.0: `npm run check` passed all
  **735 tests**, lint, formatting, types, the pack verifier and the real archive
  contract (52 entries, 42 lib modules). `node codex/prepare.mjs --check`
  also passed. An isolated native Web host and the updated installed Web host
  both report the memory plugin as `enabled: true`, `fiberPhase: active`;
  the refreshed browser renders its memory graph. This update does not measure
  a new model turn, recall delivery or automatic distillation on the 0.2 line.
  The commands and evidence boundary are recorded in
  `docs/p0-compatibility.md` section 11.

- **Recall feedback now uses a finite focus cue.** A read note lights with a
  stationary soft halo, its incident edges sweep outward once, and its title
  releases opacity and pinned size over the final 600 ms of a 2.6-second cue.
  Neighbor nodes are not marked as read. The cue starts when the polling client
  receives the event, uses monotonic time, and does not replay on an unchanged
  model refresh. Reduced-motion preferences retain static emphasis without edge
  travel; the listener and event state are disposed with the renderer.

  Four renderer regressions failed against the previous implementation (15 pass,
  4 fail) and pass with the new one (19 pass, 0 fail). The browser-module route
  regression also failed on the new helper's missing route before it was added;
  focused renderer, client, route, architecture and package checks then passed
  all 51 tests. The recall helper is a separate browser leaf within its 200-line
  budget, keeping the renderer within 700 lines; the package and archive contracts
  require both the helper and palette. Design references and motion timings are
  recorded in `docs/obsidian-graph-source.md`.

  Final verification on 2026-09-29: `npm run check` passed all **734 tests**,
  lint, formatting, the configured type ratchet and both package contracts
  (52 archive entries, 42 lib modules). The in-app browser loaded the shipped
  renderer through the registered routes with 12 temporary notes and the real
  `mem_read` service/activity path: single/continuous reads, expiry, sidebar
  resize and the reduced-motion preference control were checked without console
  warnings or errors. The restarted native host served renderer, palette and
  recall-helper bytes matching source. Measurements and limits are in
  `research/graph-recall-verification-2026-09-29.json`.

### Fixed

- **The distillation prompt now names the item-count ceiling it will be refused
  for exceeding.** The validator refuses a whole batch larger than
  `distill.maxItems` (`too-many-items`), but the system prompt never said how many
  items were allowed: it interpolated the `type`/`assertion`/`status`
  vocabularies and nothing else. A real job returned 21 well-formed items against
  a ceiling of 16, passed every other check, and spent all three attempts on that
  one refusal. `SYSTEM_PROMPT` now reserves a `maxItems` slot and the new
  `distillerPrompt(settings)` substitutes the configured number at the call site,
  so the prompt cannot carry a ceiling the validator does not apply.

  Red first: the new case
  `the system prompt names the item-count ceiling the validator refuses to exceed`
  reads the ceiling back out of the refusal message
  (`beyond distill.maxItems=N`), asserts the prompt actually sent names `N`, and
  asserts the unsubstituted slot never reaches the model. It failed on the old
  code with `the prompt never names the item-count ceiling 3`, and the existing
  request-shape case now also pins `at most 12 items` with `maxItems` absent from
  the sent text. `test/distill.test.js` is 64/64. The file's size budget is
  registered as 950 → 975 in `test/architecture.test.js` with the reason: a
  configurable ceiling cannot be a literal in a module constant.

  Verified live on 2026-09-29, not only in tests: the ceiling was raised to 21 in
  the profile patch, the plugin row hot-reloaded (a fresh `skill` event opened a
  new diagnostics run), and `mem_admin(action="jobs", jobId="…", retry=true)`
  settled `job-95018bdb…` — the job that had been terminally `failed` since
  09-27 — as `result: applied`, **21 items applied, 0 refused, `index:
  refreshed`, in 14 ms with no model call**, because a `raw-durable` retry
  re-validates the stored text. The vault gained exactly those 21 notes
  (341 → 362 in-project `.md`, `_meta/log.md` 4987 → 5197 lines) and the index
  absorbed them (488 → 517 `notes_fts` rows). The profile patch keeps the raised
  value with the incident recorded inline.

- **The graph's browser module chain now loads through the host routes.** The
  renderer imports `graph-palette.js`, but the default asset routes omitted that
  file, producing a 404 and a blank graph after refresh. The route now serves it;
  a regression fetches the renderer and its imports through the real registered
  handlers, including the same-origin fence. It failed on that 404 before the
  change and passes afterwards. The earlier resize fixture manually supplied the
  palette and did not cover this failure; it now uses the real plugin routes.
  After reloading the local web host, Chrome rendered 495 nodes and the label-size
  control showed 0.85. The final `npm run check` passed all 730 tests and package
  checks. Measurements are in `research/graph-loading-label-verification-2026-09-28.json`.

- **Zoomed labels retain enough pixels for the current screen.** Their cached
  raster resolution now increases in powers of two with zoom and device pixel
  ratio instead of stretching a fixed resolution-2 image. Labels reuse the
  sharper cache within a tier; existing text stays visible while the per-frame
  raster budget fills. The font default is now **0.85**, as requested, in both
  the panel and renderer fallback. Default-size, zoom-resolution and denser-screen
  regressions failed before the change and pass afterwards; hover, recall and
  square-root scaling regressions also pass.

- **Resizing the graph sidebar no longer exposes a cleared Canvas frame.**
  Resize notifications now schedule drawing; bitmap dimensions change inside
  that drawing callback, and unchanged dimensions are not assigned again.
  Two renderer regressions failed before the fix and passed after it. In an
  isolated browser page using the shipped client and Worker with 240 generated
  nodes, 48 consecutive width changes left the bitmap blank after all 48 resize
  callbacks before the fix and after none of them afterwards.

  The reported constant-size large node was not reproduced in this fixture:
  large and small nodes both shrank to about 0.667 of their initial radius and
  grew to about 1.487, matching Obsidian's square-root zoom rule within its 1%
  interpolation tolerance. A regression now covers a hub whose base radius
  reaches the 30-unit cap, including zooming beyond that base cap. This does not
  establish what caused the user's original large-node symptom.

### Added

- **A called memory shows which file it was.** Its label stays visible during the
  cue even when ambient labels are hidden, and the canvas caption lists up to
  three file names. Verified with the shipped renderer in a Node harness at
  reduced zoom (`test/graph-renderer.test.js`); the finite release described above
  replaces the original pulse-ring and moving-particle presentation.

- **A memory graph tab for DSH's native right sidebar via Better Sidebar.**
  The browser view resolves Obsidian's colour slots from the host theme, draws internal Markdown and wiki links, supports
  project/all scopes, and briefly pulses notes and branches used by `mem_read`
  or an injected relevant-note map. The host route is read-only and local
  same-origin; activity is bounded and process-local. SQLite and scan graph
  projections, route fencing, activity, and tab registration have automated
  tests. The view follows the installed Obsidian 1.13.7 core graph's controls,
  renderer rules and D3 fallback force model, with the core default palette;
  the extracted-source hashes and adaptation boundaries are recorded in
  `docs/obsidian-graph-source.md`. Pinned D3 browser assets and their ISC
  notices ship locally, with a read-only freshness check in the suite.

  On 2026-09-28 the installed DSH web profile rendered 461 nodes in Chrome;
  `[type:decision]` filtering left 109 nodes, and reset restored 461 nodes and
  the original slider defaults. An isolated seven-note temporary vault ran
  the real registered `mem_read` tool through the service, activity route and
  browser view: its connected branch showed particles and the node showed
  an expanding ring, then returned to idle. This does not verify a live LLM
  choosing that tool or the recall animation during a live agent turn.
  Canvas 2D replaces Obsidian's Pixi/WASM renderer; the graph is capped at
  500 nodes, and attachment filtering is disabled.

  A second comparison found omitted administrative bridges and historical
  notes, plus differences in relative links, YAML links, escaped table aliases,
  bracketed aliases, literal backticks in filenames and repeated `.md`
  extensions. The graph now includes those relationships and uncreated targets
  while administrative notes remain outside recall; the existing-files-only
  filter works. Parser-version migration refreshes cached links even when the
  notes themselves have not changed. After a restart, Chrome's rendered graph
  and Obsidian's runtime metadata agreed on 478 nodes, 503 directed edges and
  component sizes of 471 plus seven isolates; their sorted edge-set SHA-256
  hashes matched. These figures cover the current Markdown vault with tags and
  attachments excluded, not every possible Obsidian search or attachment mode.

  The initial label port followed `xQ.getDisplayText/getTextStyle` and the installed Pixi
  text cache: file basenames, the full font fallback chain, natural glyph
  widths, word wrapping and resolution 2. Six Chinese/English samples at
  three node font sizes matched the original `PIXI.Text` cache pixel for
  pixel in Chrome. The higher-resolution zoom cache described above intentionally
  extends this initial resolution-2 behaviour. The renderer caches labels through zoom, culls offscreen
  geometry, batches equal-style links and stops after 60 idle frames;
  interaction and memory activity wake it. Source-matched wheel scaling
  includes `deltaMode` conversion. Regression cases failed before their
  fixes and passed afterwards; detailed browser measurements and their
  limits are recorded in `docs/obsidian-graph-source.md`.

  Clicks no longer leave a permanent label highlight. Ordinary labels resume
  Obsidian's square-root zoom scaling after the pointer leaves; only hover and
  drag retain the original minimum text size below scale 1. The click/unhover
  regression failed before the change and passed afterwards. Measuring the
  installed browser canvas gave a 0.8166 shrink ratio and a 1.4871 enlargement
  ratio, within the renderer's 1% zoom stopping tolerance of the source rules.

  At the user's subsequent request, the initial type-colour groups were removed
  and the Wasp palette was replaced with Obsidian's core `app.css` defaults for
  both light and dark modes: neutral nodes and lines, purple hover/recall cues,
  and faint uncreated targets. Custom colour groups remain available. The
  renderer, browser registration and route tests passed after this change.

- **The diagnostic report is available as an npm command.** Run
  `dsh-obsidian-mem-diagnose --output <file.json>`, inspect the JSON, and attach
  it manually to an Issue. The package and real-archive checks require the CLI
  entry. The report has a 256 KiB ceiling and never uploads itself. The full
  local gate passed.

  The packed command has now been exercised three ways. An offline installation
  of the real tarball by itself ran its npm binary and produced a private JSON
  report with `package-files: pass`, while `plugin-smoke` stayed `unavailable`:
  that install has no optional DSH host peers, and the check reports the missing
  evidence instead of a pass. Installing the same tarball with
  `@deepseek-ai/dsh-tools` and `@deepseek-ai/cordis` present turned that one
  check into `plugin-smoke: pass`. A real host session then closed the loop: in
  a throwaway `DSH_HOME` on Node v25.9.0 with DSH `0.1.7-rc.2`, the tarball's
  installed package was mounted with `link:` in a `headless` profile and one
  real session ran against a throwaway vault. The host wrote
  `data/obsidian-mem/diagnostics/<uuid>.jsonl` — directory `0700`, run file
  `0600`, a header carrying the config summary and three events
  (`skill: synced`, `brief: hint-only`, `capture: skipped-unbound`) whose only
  fields are `seq`, `at`, `event` and `outcome`. Reading that home back with the
  packed command gave `data-root: pass`, `diagnostic-journal: pass` and
  `plugin-smoke: pass`, with three events in the window and nothing dropped,
  corrupt or expired. That session ran with `autoCapture: false`, so it created
  no queue directory and `pending-files` stayed `unavailable` rather than
  reporting a count.

  The installed path was then exercised for real on the machine that wrote this
  change: after a restart, the host that mounts this checkout with `link:` under
  the default `~/.dsh` home reported all seven checks `pass` — `data-root`,
  `diagnostic-journal` and `pending-files` (`count: 0`) included — over the four
  events that session wrote (`skill: unchanged`, `recall: below-floor` with 8
  hits, `brief: injected`, `brief: none`). Those four are exactly what the
  in-process `mem_admin(action="diagnostics")` ring answered for the same
  session, which is the one record with two views the design asks for. The Codex
  entry's journal is still covered by tests only; no live Codex session has
  exercised it.

- **A closed disk format for future user diagnostic reports.**
  `lib/diagnostic-codec.js` projects the existing in-process events into reviewed
  outcomes, coarse error codes, counts and per-run identifier aliases. Tests
  verify that conversation-like fields, paths and original IDs are absent from
  the serialized result.

- **A bounded local diagnostic journal is available for the host entries.**
  Run files use private permissions, keep at most 200 events, and expire after
  seven days of inactivity. Reader tests cover corrupt records, symlink
  substitution, concurrent processes and the latest config summary.

- **Both host entries now write their content-free decisions into the journal.**
  DSH constructs it only for an enabled plugin; Codex uses its existing data
  root. A failed journal open or append leaves the in-process diagnostic ring
  and the original tool outcome intact. Host-seam tests use temporary homes and
  confirm the vault and pending queue are untouched by journal startup.

- **A standalone JSON report command and isolated self-check are implemented.**
  The command accepts an explicit output path, refuses an existing destination,
  creates a private JSON file, and maps plugin smoke failures to fixed codes
  while still reporting Node, FTS5, package, journal and queue metadata.
  Tests confirm that an unreadable conversation-like queue file is counted
  without parsing its content.

- **Recall now answers "did it fire?" through `mem_admin(action="diagnostics")`.**
  A new `recall` event records one decision per user turn — `fired`,
  `no-query`, `no-hits`, `below-floor`, `all-seen`, `budget`, `aborted` or
  `search-failed` — with the hit count and the injected size in code points.
  `promptRecall` returns that decision instead of `null`, so both adapters can
  record it; the Codex adapter and every caller check `text !== null` now.

  This closes a hole measured live: on a real session the diagnostics showed one
  `brief injected` line and nothing about retrieval, because `brief` is recorded
  whenever the *brief* is injected whatever the map did — the answer was only
  recoverable by parsing the session transcript. `test/debug.test.js` pins the new
  event and its two count fields to the same content-free allowlist as the rest:
  a prompt and a path pushed alongside them still never reach the ring.

- **Per-turn recall has its own ceiling, `recallBudgetChars` (default 900).**
  Retrieval used to spend whatever the one-shot session brief left of
  `briefBudgetChars`, which starved exactly the first turn — see *Changed* below
  for the measurement. The two injections are now bounded separately, so one step
  carries at most `briefBudgetChars + recallBudgetChars`. The range check is
  256–20000, the same as the brief's.

- **Prompt-scoped recall now runs in DSH and Codex.** Both adapters use
  `lib/prompt-recall.js` and the existing project-scoped search service. A new
  user prompt can receive up to three strongly matching note paths and titles
  within 360 Unicode characters; note bodies require an explicit `mem_read`.
  Directory indexes, weak matches and paths already offered in the session are
  skipped. DSH invokes the policy from `agent/pre-step` for a real user message
  and spends only the remaining `briefBudgetChars`; Codex adds a
  `UserPromptSubmit` command hook. Its per-session shown-path file lives under
  the data root, contains only relative paths, and is bounded to 64 entries.
  Both adapters fail open. Codex still has no automatic distillation or write.

  Red tests first failed for the absent shared module, DSH map, and Codex hook;
  the targeted suites now pass with a real temporary vault and hook subprocess.
  In an isolated `CODEX_HOME`, codex-cli 0.146.0's `hooks/list` discovered both
  hooks with their intended event names, commands and 15-second timeouts, with
  no warnings or errors. The new hook's delivery to a live model has not yet
  been verified.

- **The Codex side injects the recall brief at session start now, exactly as DSH
  does.** `codex/session-start.mjs` is a `SessionStart` hook: Codex hands it the
  session as JSON on stdin and adds what it answers with —
  `hookSpecificOutput.additionalContext` — to the conversation before the first
  model call. It composes no text of its own: what it injects is `brief.text` from
  `lib/brief.js`, the same field the DSH pre-step injects, so the two harnesses
  still share one memory layer and one brief. This closes the hole a tool cannot
  fill — a session where nothing calls `mem_brief` used to recall nothing — and it
  is the reason `codex/README.md` no longer says "nothing is automatic". It does
  not make distillation portable; MCP still has no turn boundary, so a note is
  still written when the agent decides to write one.

  The one decision the hook owns is which session starts are worth paying for, and
  it lives in `decide()` where a test can read it: `startup` and `clear` inject,
  `resume` and `compact` do not, because both continue a conversation that already
  carries the earlier injection or its summary. A directory with no `.obsidian-mem`
  pointer injects nothing, and that is not a refusal — it is most directories on any
  machine, and the session starts as if the plugin were not installed.

  Five facts about the contract were measured against codex-cli 0.146.0 rather than
  read off a specification, and three of them changed the implementation:
  a plugin's hooks live at `<plugin>/hooks/hooks.json`, while a manifest may **not**
  declare them — the plugin-authoring spec the same binary carries says validation
  "rejects unsupported manifest fields such as `hooks`"; this event's `matcher`
  matches the session's `source`, not a tool name, so a matcher would be a second
  place to state the rule above and is left as `"*"`; `timeout` is in seconds and is
  15 of them, so a vault that hangs costs a session fifteen seconds and then is
  dropped, never its start; the output is schema-validated, and anything but one
  `session-start.command.output` document is discarded with "hook returned invalid
  session start JSON output"; and a hook is **untrusted until the client records a
  trust hash for it** — an untrusted hook is skipped in silence, with no error and
  no context.

  That last one is the install step a reader would otherwise miss, so it is a
  numbered step in `codex/README.md` rather than a footnote, and both directions
  are measured instead of described: with the hook trusted, a session start under a
  fresh `DSH_HOME` leaves behind the index the hook built; without it, the same
  directory stays empty. The injected brief then appears in the session's own
  rollout as a `developer` message — Codex's role for hook context, where DSH uses
  a `user` message with a plugin source. Same text, each harness's own convention.
  `codex --dangerously-bypass-hook-trust` skips the review for automation that
  already vets what it runs, and Codex says so in a visible item when it is used.

  **The hook cannot break a session.** Every path writes one JSON object and exits
  0 — unreadable stdin, junk that is not JSON, an unbound directory, a vault that
  refuses to open — and reasons go to stderr, where they cannot be mistaken for
  protocol, under `OBSIDIAN_MEM_HOOK_DEBUG=1` or on an actual failure.
  `test/codex-hooks.test.js` drives the real script as a process through a real
  `SessionStart` payload and a throwaway home, data root, vault and repository:
  seven cases, including a negative control that only means something because the
  repository is bound *before* it — against an unbound directory every source looks
  identical and the control proves nothing. Two deliberate regressions were run to
  see the tests fail: adding `resume` to `INJECT_SOURCES` fails the decision case
  and the vault-opening control, and one stray write to stdout fails three
  process-level cases.

  `codex/prepare.mjs` generates `hooks/hooks.json` beside `.mcp.json`, with this
  checkout's absolute path for the same reason: Codex copies the plugin into
  `~/.codex/plugins/cache/…`, so a relative path would resolve inside that copy.
  Both generated files are git-ignored, both are checked by `prepare.mjs --check`,
  and `codex/session-start.mjs` joins `codex/server.mjs` in the opt-in type ratchet.

  **What is still not verified: that a live Codex turn acts on the injected
  context.** Every link up to it is proven with the real binary — discovery, the
  trust gate, execution, and the brief's arrival in the session — but a turn needs
  a model this account can run, and this machine's Codex CLI rejects both the
  configured `gpt-6-sol` and `gpt-5-codex` with `not supported when using Codex
  with a ChatGPT account` before a tool is ever reached. That is the same wall the
  MCP tools have been behind since they shipped, and it is why this entry claims
  injection and not usefulness.

- **`AGENTS.md` now opens with two tables instead of a list of commands to
  remember.** The first says when to run what — `check:fast` before a commit,
  `check` before a push, `prepack` for a release, `hooks:install` once and only
  if you want it — and what each one actually runs, so the five-command manual
  sequence is gone. The second is "where the truth lives": ten symptoms mapped to
  the file, test or tool call that answers them, including the two that cost the
  most time to rediscover — a copied checkout failing `codex-mcp` because the
  generated `.mcp.json` holds absolute paths, and anything touching sessions or
  injection timing starting from `docs/p0-compatibility.md` rather than a comment
  in `lib/`. The house style now states the dependency split explicitly: two
  runtime dependencies, everything else a pinned devDependency.

  The `tools.js` budget was raised from 1,950 to 2,050 lines to land the new
  schema, which is the fitness function asking for a decision rather than a
  failure: the raise is registered in the table with the reason and flagged as
  temporary, because the split that follows is what replaces it with a façade.

- **`mem_admin(action="diagnostics")` answers "why did that happen?" without a
  reproduction.** `lib/debug.js` is a bounded ring — 200 events — that records
  decisions from a closed set of categories and a closed set of scalar fields,
  and `lib/index.js` hands one instance to both the services and the hooks so a
  single call answers for the whole plugin. It reads no vault and needs no
  binding, so it still answers when every other action refuses, which is usually
  exactly when it is wanted; and it empties when the process exits, so `jobs` and
  the receipts remain the only things to trust across a restart.
  The privacy boundary is enforced at the door rather than documented and hoped
  for: field names are an allowlist, values are shape-checked, and a note body, a
  title, a path or a prompt is dropped before it can be stored. The test feeds a
  sentinel body through a real call site and requires it to be absent from the
  serialised snapshot, so a future "just one more field, it will help debugging"
  change fails a test instead of shipping. Nothing in the channel can change an
  outcome either — a throwing logger, a throwing clock and a broken injected seam
  are all tested to leave the caller's result untouched.
  **All eight categories emit.** `brief` (injected, hint-only or none — the case
  a developer cannot see any other way) and `bind` refusals came first; this round
  added the five that were accepted by the ring and by the closed output schema
  but had no call sites: `capture`, `distill`, `index`, `job` and `transaction`.

  `capture` is the one that needed a new seam rather than a new call.
  `enqueueTurn` returned a bare `null` from ten different conditions —
  `autoCapture: false`, a turn that is not a completed root turn end, a missing
  session or project id, a projection with no user message, a turn the durable
  floor already covers — so "a turn ended and nothing was captured" was one
  indistinguishable outcome. It now takes an advisory `onSkip(reason)` sink and
  names each one; the sink is called through a catch, so a broken one still
  returns the pre-existing `null` and the capture is enqueued anyway, which is
  asserted rather than assumed. `distill` records whether the model produced
  nothing (`no-memory`), the run was a `dry-run`, or items were `applied`, with
  the bounded duration; `job` records `completed`, `failed`, `retry`, `deferred`
  with `no-binding`, and the three retry outcomes of the `jobs` action; `index`
  records `open-failed` (the refusal `indexFor` used to swallow), a per-item
  `refresh-failed` with its code, and the pass's `refreshed`/`none` summary;
  `transaction` records the `txId` of a committed write or a coded refusal.

  What reaches the ring is unchanged and is still the point: one wrapper around
  the three write paths records only `txId`/`code`/`projectId`, so a refusal that
  names the note it refused still does not put the note in the window. The new
  tests inject `SENTINEL-BODY-<uuid>` through real capture, distillation and write
  paths and require it to be absent from the serialised snapshot.
  `DSH_OBSIDIAN_MEM_DEBUG=1` also emits each event through the host logger, at
  `info` rather than `debug` on measurement: the host's exporter uses
  `levels: { default: 2 }` and drops anything above the threshold, so `debug` would
  be asking for a channel that is known to be closed. Unset, the plugin's logging
  surface is byte-for-byte what it was. The DSH side and the Codex MCP server each
  hold their own instance, so the tool always describes the process the caller is
  talking to; the Codex sink writes to stderr and only under the same flag.

- **CI runs the same gate a contributor runs, on three Node versions.** A check
  that exists only in CI is one that passes locally and fails on push, so
  `.github/workflows/ci.yml` runs `npm ci` and then `npm run check` — the identical
  command — across `22.22.2`, `24.x` and `node`. The floor is listed first on
  purpose: `engines.node` claims 22.22.2 is the lowest version with `node:sqlite`
  and FTS5, and an unmeasured floor is a claim rather than a fact. The only steps
  CI adds are the two things a local run cannot supply: the Unreleased gate's
  comparison base and the matrix. There are no secrets, because `npm test` needs
  none, and `permissions: contents: read` is the whole token surface.
  The base is chosen by `scripts/ci-base.mjs` rather than by shell inside the
  workflow, so the one piece of interesting logic is also the one piece with tests:
  a pull request's base commit wins, then a push's previous head, then the merge
  base against the default branch. An all-zero `before` — GitHub's way of saying
  the ref is new — is skipped rather than compared against; a base that is not a
  commit in the clone, or that *is* `HEAD`, exits 1 with the reason instead of
  handing the gate an empty diff to pass. `test/repo-gates.test.js` pins the
  workflow's shape too: the matrix entries, `npm ci` before `npm run check`,
  `fetch-depth: 0` (without it the base commit is not in the clone), and the
  read-only permission.

- **Three rules that were prose now run before a commit.** `npm run check:fast`,
  wired into `.githooks/pre-commit` by the opt-in `npm run hooks:install`, checks
  the *index* rather than the working tree: sources come from `git show :<path>`
  and go into `eslint --stdin` and `prettier --check --stdin-filepath`, both
  pointed at this repository's configs explicitly so a checkout without its own
  config is judged by the same rules. That distinction is the point — with a
  worktree check, `git add -p` lets a commit carry a file whose staged copy fails
  while the check reports green. The two fitness tests still read the worktree, so
  the script refuses rather than guess when any of their inputs has both a staged
  and an unstaged edit. Measured: 1.02 s to reject a staged `lib/` change with no
  changelog entry, 1.47 s to accept one with it, both well inside the five-second
  target the design set.
  `scripts/verify-changelog.mjs` is the Unreleased gate in two modes —
  `--staged` against `HEAD`, `--base <ref>` for CI — and it deliberately stays out
  of `npm run check`, because a check with no comparison base passes vacuously and
  a green that means nothing is worse than no check. A change under `lib/` needs an
  added or amended `## Unreleased` body; an edit to an already-released section does
  not count, and a fix left in the working tree cannot satisfy a staged check.
  A missing ref is an error (exit 2), never an empty success.
  `scripts/install-hooks.mjs` is the only thing in this repository that changes git
  configuration, it must be asked for by name, and it prints `core.hooksPath`
  before and after. `test/repo-gates.test.js` exercises all of it in disposable
  repositories — nine cases, including both directions of the staged-versus-worktree
  distinction — and never touches this checkout's git config.

- **The release gate checks the archive npm really builds, not a frozen count.**
  `scripts/verify-tarball.mjs` (`npm run pack:check`) packs this checkout into a
  temporary directory with `npm pack --json --ignore-scripts` — the flag is
  mandatory, since a bare `npm pack` re-enters `prepack` and would run the suite
  from inside a pack — lists the real `.tgz` and cross-checks the listing against
  npm's own file list. It requires every extant `lib/**/*.js`, the ten mandatory
  assets including both READMEs and `README.i18n.yaml`, and refuses anything from
  `test/`, `docs/`, `research/`, `scratch/` or a vault's `_meta/`, plus any
  `pending/`, `locks/`, `transactions/`, `.jsonl`, `.lock` or probe artefact.
  The design's earlier "33 files" assertion is gone on purpose: it would have
  turned the `tools.js` split into a red build for a change that is supposed to
  add modules. `test/pack.test.js` pins the failure modes against synthetic
  listings — a missing asset, a module on disk that did not ship, a packed
  development tree, a packed vault path — and runs the verifier against this
  checkout once, so the report cannot rot into a comment.

- **The module graph and the repository's own conventions are now tests.** `test/architecture.test.js`
  builds the `lib/` import graph from the TypeScript AST — not a regular
  expression, which is how the first measurement of this graph missed
  `export ... from` and side-effect imports — and fails on a cycle, on an edge
  that points upward *or* sideways between the ten reviewed layers, on a module
  with no declared layer, on a relative import that resolves to nothing, and on a
  file past its approved size. The layer table and the size budgets are a
  reviewed snapshot, so a new module or a grown file becomes a decision someone
  makes rather than a drift nobody sees; `lib/tools.js` and the three files that
  replace it in the split are the first entries to be re-registered under it.
  `test/repo-hygiene.test.js` adds the two conventions that were prose until now:
  `README.i18n.yaml`'s recorded blob hashes must match both READMEs, computed
  from bytes with `node:crypto` so CI and a bare checkout agree, and every
  `npm run` command named in `AGENTS.md` or either README must exist in
  `package.json`. Both were shown to fail — a stale hash record and a documented
  command that does not exist each turn exactly one assertion red — and the
  structural checks were shown to fail four ways: an upward edge, a lateral edge,
  a new module, and a file padded past its budget.

- **Twelve source files are type-checked, and the set can only grow.** `npm run
  types` runs `tsc --noEmit` over an explicit `files` list with
  `checkJs: false`, so each file opts in with a `// @ts-check` marker. The
  mechanism is not a style preference: a checked root file pulls its imports into
  the program, and with `checkJs: true` TypeScript reports on those imports too.
  Measured on a two-file fixture — `checkJs: true` + `files: ['root.js']` reports
  the imported `child.js`; `checkJs: false` with the marker only in the root does
  not; move the marker and the reporting follows it. So `files` is a root list, not
  a boundary, and the marker is the switch.
  The initial twelve were chosen by measuring each candidate alone: nine report
  **zero** diagnostics (`lib/git.js`, `lib/index.js`, `lib/naming.js`,
  `lib/paths.js`, `lib/pointer.js`, `lib/receipts.js`, `lib/registry.js`,
  `lib/routing.js`, `scripts/verify-pack.mjs`) and three report one each, now
  fixed: a `null`-narrowed memo in `codex/server.mjs` whose declared type was
  restored (`TS18047`), an `options = {}` default that contradicted a required
  JSDoc field in `lib/search.js` (`TS2741`), and a signal name typed as `string`
  where `child.kill` wants `Signals` in `scripts/run-tests.mjs` (`TS2345`).
  `skipLibCheck: true` is part of the configuration and is load-bearing: without
  it those same files report `TS2307` and `TS6200` from inside
  `@deepseek-ai/dsh-llm`'s own declarations, which is a conflict between
  third-party types rather than anything in this repository.
  `test/repo-hygiene.test.js` asserts the marked set and the `files` list are equal
  in both directions — a marker outside the program would be silently unchecked —
  and that no shebang has been pushed off line 1, which is what a marker written
  above one does. Both were proven able to fail: dropping a marker, marking an
  unlisted file, and moving a marker above a shebang each turn exactly one
  assertion red.

- **The memory layer now runs under Codex CLI, through an MCP server that reuses
  `lib/` instead of copying it.** `codex/server.mjs` speaks MCP on stdio and
  dispatches the same six operations the DSH tools expose —
  `mem_search`/`mem_read`/`mem_write`/`mem_log`/`mem_brief`/`mem_admin` — to the
  same `createMemoryServices()`; the argument schemas are derived from
  `TOOL_PARAMETERS` and the names from `TOOL_NAMES`, so the two surfaces cannot
  drift apart. A local marketplace (`codex/marketplace/`) ships a Codex edition of
  the skill plus the generated `.mcp.json`, installed with
  `codex plugin marketplace add` and `codex plugin add`; `codex/README.md`
  documents the lighter `codex mcp add` variant. **What does not carry over is
  stated rather than implied**: there is no distillation of finished turns and no
  recall injection, because MCP offers tools and not turn boundaries. Measured end
  to end in `test/codex-mcp.test.js` (6 cases): a real stdio handshake, a write and
  a search against a throwaway vault, plus the one seam that would otherwise bind
  the wrong project — the working directory comes from the client's `roots/list`,
  not from the plugin directory Codex launches the server in. That seam also
  produced the bug the test now pins: awaiting the `roots/list` answer inside the
  `initialize` handler deadlocks the serialised message queue, because the answer
  is itself a queued message.
- **The package now declares itself the way the ecosystem does.** `package.json`
  gains `keywords`, `repository`, `homepage`, `bugs` and `engines.dsh` — the
  position the plugin market reads. The GitHub repository carries the
  `dsh-plugin` topic that the harness's own plugin search queries. The install
  instructions lead with the ecosystem's `github:bonerush/dsh-obsidian-mem` spec
  instead of a local checkout. Nothing about the plugin's runtime behaviour
  changed; `engines.node` is untouched.
  Measured end to end against the published repository: in a throwaway
  `DSH_HOME`, `dsh plugin --profile memcheck add
  github:bonerush/dsh-obsidian-mem` resolves to
  `dsh-obsidian-mem github:bonerush/dsh-obsidian-mem` and `--dump-config` then
  prints the `obsidian-mem` row.
- **`README.zh.md`, a Chinese README that carries equal authority with the
  English one.** It follows the convention the first-party packages use:
  the `[English](README.md) | 中文` switcher, an explicit `<a id="…">` for every
  heading a link targets so one anchor resolves from either language, and
  `README.i18n.yaml` recording the git blob hash of each side as of the last
  confirmed-consistent state. Measured in one installed harness: of 240 packages
  under `@deepseek-ai/`, the 231 that ship a README ship all three files, and the
  eight English-only ones are vendored upstream packages (`cordis`,
  `schemastery`, `cosmokit`, `cordis-plugin-*`). The translation is not reviewed
  by a native reader; that stays listed in the untested inventory at the end of
  this file.
- **The repository is public at
  <https://github.com/bonerush/dsh-obsidian-mem>.** This is the project's remote;
  `main` is the published history. It remains unpublished to npm and untagged.

### Changed

- **The graph now takes its colours from the host theme through Obsidian's own
  slots.** The renderer resolves the eleven `.graph-view.color-*` values from the
  computed style of hidden probes, exactly as Obsidian's `testCSS` does, and the
  browser half binds Obsidian's `--graph-*` variables to this host's
  `--dsw-alias-*` tokens. A theme switch therefore repaints the graph with no other
  change. Measured in Chrome on 2026-09-28: dark resolves nodes `rgb(179,179,179)`,
  text `rgb(218,218,218)` and lines `rgb(67,69,74)`; light resolves nodes
  `rgb(92,92,92)`.

- **Labels rasterize at 50% of Obsidian's `14 + node size / 4`, and the factor is
  now a setting.** This is a deliberate deviation requested by the user, not an
  attempt at parity: the graph lives in a narrow sidebar, where the original size
  reads as oversized next to a fitted graph. The display section gained a
  **标题文字大小** slider (0.4–1.6, step 0.05, default 0.5) that drives the raster
  font size, so the reduction is adjustable rather than hard-coded. Position, the
  `sqrt(scale)` scaling, the fade threshold and the pinned size of a highlighted
  node are unchanged and are measured in `docs/obsidian-graph-source.md`.

- **A long prompt no longer raises the bar above four token hits.** The floor was
  `max(3, ceil(0.3 × queryTokens))` with the query capped at 16 tokens, so its top
  bucket demanded five token hits — and the extra tokens of a long
  natural-language prompt are mostly function-word bigrams that can never match a
  note. Measured through the shipped policy over the same 154 real prompts, by
  setting the cap back to the old value and replaying: **22.1% of prompts
  produced a map before, 56.5% after**, at 1.9 notes and 595 code points per map.
  The floor never drops below three, so a weak match still stays silent.

  The additions were read before the change was kept. Of the 53 prompts the cap
  adds, the overwhelming majority pair a note with a prompt that is on topic for
  it — `README edits are paired EN/ZH` for code-review turns, `CodeGraph MCP is
  the preferred lookup` for search-and-retrieval work, and, for 「请修复这个三个
  问题并且提交，随后 push 到 main」, the vault's own 「修复流程：改完提交并 push 到
  main，以 CI 绿 + 全量 check」. A minority are topical neighbours rather than
  answers (`Project figures are being restyled` for a prompt about agent skills),
  and they are the reason the cap is four and not lower.

- **A relevant turn now receives the matched excerpt, and no longer waits for
  the session brief to finish.** Both numbers below come from replaying the 154
  real user prompts of the two bound repos through the shipped policy and the
  shipped index, on a throwaway copy of the vault:

  * **Turn 1 was starved.** The production brief spends essentially the whole
    session budget (measured in this repository's own bound project: 5,896 of
    6,000 code points), so the map was handed the 104 left over — which fits
    nothing. Against the old code, **0.6% of prompts produced a map on turn 1**
    (1 of 154) against **22.1%** (34 of 154) once the brief was out of the way.
    With `recallBudgetChars` the same replay yields **22.1%** (34 of 154) with no
    turn-1 penalty at all, at an average of 1.7 notes and 484 code points per map.
  * **A pointer is not memory.** Across 277 DSH sessions and 31,718 tool calls,
    `mem_read` was dispatched 18 times: following a pointer is a second voluntary
    tool call, and the model almost never makes it. Each line now carries the
    excerpt `lib/index-db.js` already computes *for that query* — `buildSnippet`
    centres a ±60-code-point window on the matching needle — flattened to one
    line and clamped to 200 code points. `_meta/hot.md` is skipped, because the
    brief already injects the hot layer.

  The boundaries that did not move: the map is still quoted vault data and never
  a command, `mem_read` is still the way to a full note, `useful()` still refuses
  weak matches (the replay's 22.1% is a firing rate, not a widening), and the
  Codex per-session state file still stores **paths only** — the excerpt reaches
  the model and never the disk. The two tests that asserted "never copies its
  body" were rewritten deliberately, and the Codex one keeps its `doesNotMatch`
  assertion against the saved state, which is the invariant that actually
  mattered.

  **Red first, then a deliberate regression.** `MAX_SNIPPET_CHARS` did not exist
  and the full-size-brief case produced no map. Two new DSH cases and the
  existing Codex case pin the behaviour: one drives the real waterfall over a
  real `mktemp -d` vault with the shipped `buildBrief`, the shipped index and
  the shipped service `search`, and asserts the first turn receives the excerpt;
  `test/codex-hooks.test.js` drives the real hook script as a subprocess and
  asserts the excerpt reaches `additionalContext` while the saved state stays
  paths-only. Reverting the one changed line to the old
  `briefBudgetChars - spent` expression makes **both** DSH cases fail and nothing
  else, which is the evidence that they test the mechanism rather than the
  fixture. The suite is green at 652 tests.

- **`lib/tools.js` is a 22-line façade instead of a 2,006-line file, and the
  three jobs it held are three modules.** Task 11 of the harness plan named this
  as the structural change the other eleven tasks only made safe, and it is the
  only place this round moved code rather than adding it:

  | Module | Lines | Owns |
  |---|---|---|
  | `lib/tool-schema.js` | 847 | the parameter specs, the closed output schemas, and the argument rules every `execute` shares |
  | `lib/tool-registry.js` | 198 | the six `defineTool` definitions and `registerTools` |
  | `lib/services.js` | 1,024 | service lifetimes, binding/index caches, admin dispatch, projections |
  | `lib/tools.js` | 22 | four re-exports and nothing else |

  **Nothing outside `lib/` changed an import.** `lib/index.js`, `codex/server.mjs`
  and all nine test files still do `import … from './tools.js'` (or
  `'../lib/tools.js'`), which is the point: a façade both entry points already
  import *is* the seam, so the move is invisible to them and a future move will be
  too. Two new tests hold that: `test/tools-facade.test.js` asserts that the
  façade exports exactly the four published names, that each one is the *same
  value* the owning module holds rather than a structurally equal copy, and that
  the DSH runtime and the Codex `listTools()` describe the same six tools; the
  pack fixture asserts that dropping a re-export fails the package check.
  Measured, not asserted: removing the `registerTools` re-export fails the whole
  file at import time, and rebuilding `TOOL_NAMES` as a local `Object.freeze([...])`
  — which compiles, type-checks and behaves identically — fails on reference
  identity with `TOOL_NAMES must be re-exported, not rebuilt`.

  The package verifier moved with it, because a check that reads the old path
  reports success about a file that no longer contains a registration:
  `scripts/verify-pack.mjs` now scans `lib/tool-registry.js` for the six
  `name: 'mem_x'` sites **and** reads `lib/tools.js` for the four re-exports, as
  two separate checks that fail for two different reasons. The verification
  output says so: `6 tools registered and 4 names published`.

  The move also made one deliberate asymmetry visible enough to write down. The
  MCP adapter closes the argument root (`additionalProperties: false`) and the DSH
  runtime leaves it open, which is the entire reason `assertKnownArguments` exists
  — DSH hands an undeclared key to `execute`, the adapter refuses it at the
  schema. That difference is now asserted per tool instead of being rediscovered;
  so is the adapter's habit of always writing `required`, which DSH omits when it
  is empty. `test/architecture.test.js` records the new layers
  (`tool-schema` L3, `tool-registry` L4, `services` L8, the façade L9, `index` L10)
  and the four budgets, on the same rule as every other file: the façade's budget
  is 100 lines, which *replaces* the temporary 2,050 rather than extending it.

- **Every vault path is ASCII now: the directory names, and the file names the
  plugin fixes itself.** `项目/`→`Projects/`, `文档/`→`Docs/`, `决策/`→`Decisions/`,
  `约定/`→`Conventions/`, `踩坑/`→`Pitfalls/`, `日志/`→`Daily/`, `收件箱/`→`Inbox/`,
  `方法/`→`Methods/`; the project registry moved to `_meta/registry.md` (was
  `_meta/项目注册表.md`), the glossary to `Docs/glossary.md` and the hot archive to
  `Docs/hot-archive.md`. A vault path now survives a shell that is not UTF-8, an
  archive round-trip, a URL, and any tool that mangles CJK — which is the whole
  reason it changed. **A note's own file name is unchanged in kind**: it is still
  derived from the title in whatever language the writer used, because the name is
  a rendering and frontmatter `id` is the identity. That distinction is now written
  down in `README.md`/`README.zh.md`, in the shipped skill
  (`skills/obsidian-mem/SKILL.md`, "Every directory name is ASCII…") and in
  `AGENTS.md`. The suite was updated with it: 566/566 pass, and the fixtures'
  directories were renamed while their *note* file names stayed Chinese, which is
  exactly the rule.
- **A breaking change with no automatic migration.** The plugin does not convert an
  existing vault: notes stay where they are, but the project directory, the
  registry path and every MOC wikilink still name the old directories, so
  `mem_admin(action="projects")` will not resolve the project and `nextAdrNumber`
  will not see existing ADRs. The vault this repository dogfoods was migrated by
  hand instead: directories renamed, path-qualified wikilinks and the
  generated-region declared hashes rewritten, the registry rewritten, and the
  receipt path keys in `$DSH_HOME/data/obsidian-mem/receipts/` remapped so that
  "this plugin owns this file" still checks out. A running harness must be
  restarted afterwards — plugin code is loaded once per process.
- **The frozen design document still shows the old names.**
  `docs/superpowers/specs/2026-09-23-dsh-obsidian-mem-design.md` (D5, §5.1, §6.1)
  records the decision as it was taken; the code, the shipped skill, the tests and
  the README pair describe the current tree. Likewise `docs/dogfood-results.md`,
  `docs/smoke-results.md` and `test/smoke/records/smoke-record.json` are records of
  runs that really happened under the old names, and rewriting them would claim
  something that never occurred.

### Removed

- **The README no longer explains how to disable another memory plugin.** The
  step-by-step walkthrough that named one specific third-party plugin — and told
  readers to append a row to their own `$DSH_HOME/cordis.patch.yml` — is gone from
  both language sides, and no shipped document names that plugin any more. It read
  as though this plugin needed that done before it would work. It does not: this
  plugin mounts one row, requires nothing of what else is mounted, and does not
  care which other memory layer is present. The constraint the section was
  illustrating is unchanged and still enforced — no script in this repository
  edits a user's configuration, and `prepack` stays a read-only verifier
  (`AGENTS.md` rule 1).
- **The README no longer carries the "DSH plugin conventions" table.** The eight
  conventions are unchanged and still followed — the bundle patch, the ESM entry,
  the `github:` install spec, the `dsh-plugin` topic, `engines.dsh`, the registry
  manifest, the portable skill and the bilingual pair. What is gone is the table
  that named them in one place, so the measurements it cited are kept here rather
  than lost: nothing in an installed harness reads `engines.dsh`, and 231 of the
  240 packages under `@deepseek-ai/` ship the three-file bilingual README set.
- **The README no longer carries a "Not verified" list.** The list was cut to keep
  the landing page short; no item on it stopped being true. The untested inventory
  now lives only in this changelog — the `Not verified:` bullets under `0.1.0`'s
  *Known limitations and remaining risks*, plus every Unreleased entry — and the
  README now says plainly that its boundaries are what it writes down rather than
  a complete set. `AGENTS.md` rule 6 keeps the requirement and names this file as
  the list's home.

### Verified end to end

- **The plugin still works as a *mounted DSH host plugin*, not just as a library
  under `node --test`.** The isolated-profile smoke suite was re-run at
  `ca286a7` — after both the `tools.js` split and the diagnostics call sites —
  and it is the only check in this repository that says so. `run-smoke.mjs`
  installs this checkout into a throwaway `DSH_HOME`, drives real headless
  sessions against a throwaway vault, and **SIGKILLs the process at the durability
  boundary** so the next process has to recover the job; `verify.mjs` then
  re-derives every fact from the temp vault. Measured: **25 checks, 0 failures,
  1 honest UNVERIFIED** (the Obsidian GUI half), and `negative-controls.mjs`
  **11 negative controls + 1 positive control, all as expected** — so the checker
  is known to fail for each condition it claims to detect rather than merely
  having passed once.

  What the run actually established, in its own numbers: the plugin row was
  present in `--dump-config`; exactly one recall brief reached the first step
  (109 code points, inside the 6,000 budget) and none later; a Chinese document
  written through `mem_write` was found again by a four-character Chinese query;
  the supersede chain left the old note with `status: superseded` and its
  `superseded_by`, dropped from default search and present under
  `includeHistory: true`; both model lanes were real distils (dry-run: 234 output
  tokens, vault unchanged; live: 278 output tokens, vault changed) with exactly
  one result receipt for the killed job and **no duplicate note id anywhere**;
  an edit made outside the plugin survived, and a `trust: owner` file the plugin
  tried to update *and* supersede was byte-identical afterwards; a read-only lint
  changed nothing; 21 notes re-parsed under `yaml`, with the tag lists, ISO day
  fields and wikilinks checked; and the real `~/.dsh` fingerprint was identical
  before and after.

  **The run's record is deliberately not committed**, for the reason
  `docs/smoke-results.md` §1 and §7 already give: a passing model lane writes a
  note whose title the model wrote, so the transcript now contains model output,
  and this repository does not commit that. The tracked
  `test/smoke/records/smoke-record.json` therefore stays what it is — the
  Task 18 pre-fix transcript, which describes a run whose model lane produced no
  receipt — and it is *not* evidence for the numbers above. The evidence for
  those is this entry plus the commands it names; the record was rewritten,
  inspected, and reverted rather than left in the tree, and `git log` on that
  path shows no commit here.

### Remaining from the engineering-harness plan

Stated here rather than left to be discovered, because rule 6 puts the untested
and unfinished list in this file. The plan's structural task — `lib/tools.js`
split into `tool-schema.js`, `tool-registry.js` and `services.js` behind an
unchanged façade — **is done**, and is written up under *Changed*. What follows is
what is still open.

- **The GitHub workflow has now run, and all three legs pass.** This was the last
  item on this list that a local run could not close, and pushing closed it:
  [run 36130730692](https://github.com/bonerush/dsh-obsidian-mem/actions/runs/36130730692)
  on `f6adb46` reports `conclusion: success` for `check (22.22.2)`,
  `check (24.x)` (Node v24.21.0) and `check (node)` (Node v26.10.0). Each leg ran
  the same `npm ci` → `npm run check` — **634 tests, 634 pass, 0 fail** plus
  `verify-pack: OK` and `verify-tarball: OK` — with `found 0 vulnerabilities` from
  the install, and each finished the Unreleased gate with
  `verify-changelog: OK — lib/ changed and ## Unreleased moved with it`. The job
  times were 38 s, 37 s and 41 s.
  That also settles what the previous revision of this entry left open: GitHub's own
  runner, both non-floor matrix legs, and `scripts/ci-base.mjs` choosing a base from
  a real push event — the gate's own output is the evidence that it was handed one.
  What is still untested is `ci-base.mjs` against a `pull_request` event and against
  an all-zero `before`; the push path is the one this repository's work actually
  takes, and it is now measured rather than assumed. The earlier hand-run baseline
  stands behind it for the floor specifically: in a clean `git archive` tree with no
  `node_modules`, `npm ci` under Node 22.22.2 installed the lockfile (including the
  two optional peers) with `found 0 vulnerabilities`, and `npm run check` exited 0
  with 627 tests at the time.
- **The type ratchet covers twelve files of twenty-eight candidates.** The full
  per-file counts are in the design at
  `docs/superpowers/specs/2026-09-25-engineering-harness-design.md` §7.3;
  `lib/pending.js` alone reports 78 and is why the first tier stopped where it did.
- **Obsidian GUI behaviour is still unverified.** The smoke run below is a
  filesystem result; nothing in it says a tag renders as a property list or that a
  wikilink is clickable, because the vault was never opened in Obsidian.

### Fixed

- **The graph painted the light palette inside a dark DSH.** The panel keyed its
  two palettes off `.dark` and `[data-theme=dark]`; this host marks dark mode as
  `body[data-ds-dark-theme]`, so the selectors never matched and a dark UI got the
  white canvas described above. The palette is now resolved from the theme tokens
  themselves, which removes the class-name coupling rather than adding a third
  selector to keep in step.

- **Every graph line was nearly invisible.** The line slot was bound to
  `--dsw-alias-border-l2`, and this host's border tokens are translucent
  (`#ffffff1f`, i.e. 12% alpha, on the dark theme). Multiplied by the slot's own
  opacity this put edges at roughly a tenth of the intended contrast. The line now
  uses `--dsw-alias-label-dimmed`, a solid grey that matches Obsidian's
  `--color-base-35` roles in both themes.

- **A changed graph asset kept running the previous build until the host
  restarted.** `registerGraphRoute` read `graph-renderer.js` and
  `graph-worker.js` once at registration and served that buffer forever, so edits
  under `lib/` were invisible to the browser no matter how often the page was
  reloaded. Both are now read per request, and
  `test/graph-route.test.js` rewrites a temporary asset between two fetches to
  pin it: with the cached handler that case fails, with this one it passes.

- **`mem_admin(action="diagnostics")` failed its own output validation as soon as
  a `recall` event existed.** The diagnostics channel has two closed sets, and
  they are the same fact written twice: `lib/debug.js` refuses to *record* a name
  or field it does not know, and `lib/tool-schema.js` refuses to *return* one it
  does not list. The previous change extended the first and not the second, so the
  ring accepted the event and the tool rejected the whole snapshot —
  `"value" must match exactly one oneOf branch (matched 0)`. Found by the first
  live `mem_admin(action="diagnostics")` after a restart, which is exactly the
  surface neither unit suite covers: the ring tests call the ring, and the hook
  tests inject their own ring, so nothing compared the two lists.

  The schema's `event` enum and its `hits`/`chars` properties now carry the
  `recall` event, and `test/debug.test.js` holds the two sets equal in both
  directions: every name the ring records must be in the enum, every field it
  writes must be a property, and the schema may publish nothing the ring cannot
  write beyond its own `seq`/`at`/`event`. Red first: the guard failed with
  "the schema does not list the event recall".

- **Distillation no longer writes a second note for a fact the vault already
  holds.** Every distilled candidate asks one question before it creates anything:
  does the bound project already have a note with this title? The lookup is
  `lib/search.js`'s `findTitleTwin` — the same project scope, the same
  superseded/archived exclusions and the same tokenizer as `mem_search`, narrowed
  to the candidate's own type — and the comparison is the **overlap coefficient**
  of the two titles' tokens, not Jaccard: a distilled title is usually a reworded
  superset, and Jaccard punishes the length difference, scoring the pair this was
  measured on 0.60 against overlap's 0.80.

  Measured on this repository's own vault: **42 same-type pairs** are near
  duplicates, and the two a reader finds first — a distilled pitfall beside the
  agent-written one, and a distilled ADR restating another — score 0.80 and 0.72.
  The threshold is 0.8, at the top of that gap, because the errors are not
  symmetric: a missed twin leaves a duplicate, a false twin silently discards a
  distilled fact.

  A skip is reported, never silent: the receipt names the note that already covers
  the fact, and a `distill` diagnostic records `outcome: "duplicate"`. The check
  is skipped for an explicit supersede — its target is by definition the note being
  replaced — and it **fails open**: a wiring whose index handle only refreshes, or
  a lookup that throws, applies the candidate exactly as before and records
  `duplicate-check-failed` instead of refusing the write. Red first: the new
  `applyCandidate` case failed on the missing `skipped` result, and the new
  end-to-end case failed with `2 !== 1` notes until the seam was wired; commenting
  the one wiring line out makes it fail again and nothing else.

- **The distillation prompt now names the `status` vocabulary, and cannot drift
  from the validator again.** Two of the three enumerated fields were spelled out in
  `SYSTEM_PROMPT` and `status` was not, while `validateItem` refuses any status
  outside `STATUSES` — so the model had to guess an enum the plugin would reject.
  Measured on a real home: an output was refused with `distill item 2: status must
  be one of active, proposed, … (got "completed")`, and every candidate in it was
  discarded with it. All three vocabularies (`type`, `assertion`, `status`) are now
  interpolated from the exported `DISTILL_TYPES`/`ASSERTIONS`/`STATUSES`, so a value
  added to one is a value the model is told about in the same edit. Red first: the
  new case in `test/distill.test.js` drives one bad value per enumerated field
  through `validateDistillation`, reads the accepted list back out of the refusal
  message, and requires the prompt to name every value in it — it failed with "the
  prompt never names the status value active" and passes after.
- **An explicit `mem_admin(action="jobs", retry=true)` now wakes the queue worker
  instead of waiting for something unrelated to.** `retryJob` revived the job and
  stopped there, and a pass arms its next timer only while work is already waiting
  — `processQueue` returns `nextDueAt: null` for a queue whose only job is terminal
  — so a revived job sat untouched until the next captured turn or a plugin reload.
  Measured on a real home: two revived jobs stayed untouched through four minutes of
  polling with the host otherwise idle. `registerHooks` now announces the worker it
  builds through a new `onQueueWorker` dep, `lib/index.js` hands that worker to the
  services as a late-bound `kickQueueWorker`, and `jobsAction` calls it exactly once
  after a successful revive — never for a listing, a refusal, or a job id that names
  nothing. Red first: the new case in `test/integration-write-read.test.js` drives
  the real `apply()` assembly, writes a terminally failed job into the
  `DSH_HOME`-derived queue and fails with "no diagnostics event named job-revive-1
  within 5000 ms" without the kick, because a pass is observable only through the
  decision it records; it also caught the first attempt, where the kicker reached
  `createMemoryServices` but not the module-level `jobsAction` that owns the retry.
  `test/lint.test.js` pins the contract at the service seam: one kick per
  successful retry, none for a listing, a refusal or a missing id, and a
  non-function `kickQueueWorker` is refused where it is supplied.
- **`mem_admin(action="jobs")` reports why a job failed instead of `null`.** The
  queue stores `lastError` as an object — `{code, message, at}` — because the
  reason, the line and the time are each useful to a reader of the job file, while
  `JOB_SCHEMA` declares a single string. The view was built with a string-only
  check, so a terminally failed job listed as `lastError: null` and the reason —
  the one thing this action exists to show — was visible only by reading
  `$DSH_HOME/data/obsidian-mem/pending/*.json` by hand. `normalizeJobError` in
  `lib/pending.js` is now the one place the two shapes meet; it prepends the code
  only when the stored message does not already carry it, because a stored
  `message` is `describeError`'s output and the naive join prints
  `too-many-items: too-many-items: …`. Red first: the new assertion in
  `test/lint.test.js` read `null` for a job document carrying the object the
  writer actually stores (45 tests pass in the two touched files afterwards);
  `test/pending.test.js` covers the remaining shapes — bare message, code only,
  legacy string, empty, `null` and a non-object. The README pair also names the
  configuration gap behind a queue that never drains: a session imported from
  another harness has no recorded route, so imported history waits for
  `distill.provider`/`model` to be set.
- **The callback JSDoc in `lib/hooks.js` and `lib/transaction.js` now parses
  under TypeScript 7 as well as 5.9.** Five `@param {function(string): T}` type
  expressions used the Closure dialect, which TypeScript 7.0.2 — today's
  `latest` on npm — rejects with `TS1005`, and the rejection cost the eight
  `@param deps.*` entries below them their binding (`TS8032`). Measured on the
  same two files with `checkJs: true`: **5 + 8 diagnostics under 7.0.2, 0 + 0
  under the pinned 5.9.3**, and 0 + 0 under both after this change. The pinned
  compiler never reported it, so this is portability rather than a repair: the
  arrow form is accepted by both, and it can name its parameter, which the
  Closure form cannot. `test/jsdoc.test.js` freezes the form and its failure
  message states the measurement, so the next person sees why the rule exists.
- **ESLint's first honest run over this tree found 43 problems; all 43 are now
  either fixed or disabled at the site with the reason.** The repository had no
  linter, so nothing had ever looked. Twelve dead stores (`let corrupt = false`,
  `let record = null`, `let age = 0`, `let gitInitialized = false` and eight
  more) were overwritten before any read and are now bare declarations; twenty
  unused bindings and imports are gone, including a whole `seedSpecs` object in
  the smoke runner that nothing had read since a refactor; `lib/paths.js` and
  both `scripts/verify-pack.mjs` rethrows now attach `{ cause }` instead of
  discarding the failure underneath the wrapper. The eight that remain are
  deliberate and stay visible: six `no-control-regex` sites and two
  `no-misleading-character-class` sites strip control characters and match emoji
  code points one at a time, so each carries an inline
  `eslint-disable-next-line` naming that reason. `no-undef` is never disabled —
  it is the rule that found the `TransactionError` defect fixed in `e31fa13`.
  Behaviour is unchanged: 574 tests pass before and after, and the pack verifier
  still reports `OK`.

- **A `retain` whose registry transaction failed threw `ReferenceError:
  TransactionError is not defined` instead of the refusal it documents.**
  `lib/vault.js` re-exports `TransactionError` — "every importer keeps going
  through this module" — but a re-export puts a name in the export namespace and
  not in the module's own scope, and the `catch` that decides between a refusal
  and a rethrow tested `error instanceof TransactionError`. The `||` beside
  `error instanceof BootstrapError` hid it for the one error type that was
  genuinely in scope, so the only path that broke was the bind-conflict path the
  catch exists for. Introduced with the catch in `8c988dd` and never covered: no
  test asked a `retain` to survive a failed transaction. Found by ESLint's
  `no-undef` on the first run over the tree — one finding in 58 files — which is
  the engineering-gate work this entry's neighbours will describe. Regression
  test: `test/lint.test.js`, where a real unresolved transaction (a
  fault-injected write to the project index, then an external edit to that same
  file) now yields `{kind: 'conflict', reason: 'recovery-required'}` and leaves
  the externally edited file byte-identical. Before the fix that test failed with
  exactly the `ReferenceError` above, at `lib/vault.js:504`.

- **Every turn in a bound project failed on DSH 0.1.7 with `format v4 message
  requires a producer-owned source kind`.** Recall injection stamps a `source` on
  the `user/message` it inserts, and `lib/hooks.js` stamped the retired
  `{kind: 'plugin', plugin: 'obsidian-mem'}` wrapper. Session format v4 refuses
  `kind === 'plugin'` outright — both on write, in the gate that runs before
  `encodeEvent`, and on read — so the message could not be persisted and the turn
  aborted (`本轮运行失败`), which is the failure a real user hit. The source is now
  `{kind: 'plugin:obsidian-mem', form: 'recall'}`: the host's own producer-kind
  convention for a third-party plugin, and the exact value the v3→v4 converter
  derives from the old wrapper (`producerKind()` in
  `dsh-session-format-v3-to-v4`), so a session converted from v3 and a session
  written under v4 name the same producer. `engines.dsh: ">=0.1.5-rc.2"` stays
  honest because the 0.1.5-line writer admits the new kind verbatim — a
  `user/message` there only requires a nonempty string kind, and it is the
  *v2→v3* migration's allow-list, not the current writer, that ever named
  `plugin`. Measured with `test/p0/run-v4-source-probe.mjs`, which drives the
  installed host's own gates rather than a reimplementation of them, and records
  four cases in `docs/p0-compatibility.md` §10: (A) the retired wrapper is refused
  by v4's `assertV4RowAdmission` with exactly the error above; (B) the new kind is
  admitted; (C) the real catalog restore over a real v3 session
  (`zstd -dc` — the files are concatenated frames, and Node's
  `zstdDecompressSync` reads only the first) derives
  `{"kind":"plugin:obsidian-mem","form":"recall"}` for this producer; (D) a
  0.1.5-line `encodeCurrentEvent` stores the new kind verbatim. A corpus
  cross-check of 258 of the user's session files found 14 messages carrying the
  retired wrapper and none carrying the v4 kind, which is what makes the diagnosis
  the only one consistent with the evidence. Regression tests:
  `test/hooks.test.js` — the injected message's `source` asserted field by field,
  plus a host-free pin of the v4 rule (`assert.notEqual(RECALL_SOURCE.kind,
  'plugin')` and `assert.equal(RECALL_SOURCE.kind, `plugin:${PLUGIN_ID}`)`, both
  hardcoded, so the value cannot move with the module). The two recall filters in
  `test/lint.test.js` are not themselves regression tests — they find the
  plugin's messages by importing `RECALL_SOURCE`, so they would follow the module
  — but the second one is what caught the first, incomplete version of this fix,
  because it still matched the retired `source.plugin`: only running the whole
  suite reported it.
- **The shipped skill no longer claims a `not-ready-in-p1` status the code cannot
  produce.** All six `mem_admin` actions were implemented in Task 17 and
  `test/tools.test.js` asserts the marker is absent from a result; the sentence
  survived in `skills/obsidian-mem/SKILL.md` and was copied into the new Codex
  edition before anyone re-read it. Both now name the two real "cannot answer yet"
  shapes — `mem_brief` answers `status: 'unbound'` for an unbound repository, and
  an index-backed search raises `index-not-ready` until the first scan finishes —
  and both list `report`/`prune` among `mem_admin`'s arguments, which they had also
  omitted.
- **The queue worker no longer reports the host's shutdown as a caller
  cancellation.** DSH disposes the whole plugin tree when a headless run's
  session completes; the worker's fiber disposer ran `controller.abort()` inside
  that teardown, which the LLM service reports as a terminal
  `finish.reason.kind === 'aborted'`. Every such pass therefore recorded a failed
  attempt the model never produced (`lastError.code === 'aborted'`), consumed the
  R43 retry bound, and left the headline path — completed turn → real
  distillation → automatic write — unverified on a real host. Measured in
  `docs/p0-compatibility.md` §9 with a disposable probe
  (`test/p0/run-teardown-probe.mjs`, 13 assertions): the tree teardown does *not*
  kill an in-flight stream (a 7.2 s stream finished 4.7 s after its provider
  fiber was `DISPOSED`), so `stop()` now stops scheduling and lets the in-flight
  pass settle, while a new `abort()` keeps the real cancellation path (and its
  truthful `aborted` reason). Regression tests:
  `test/auto-capture.test.js` (`a host unload mid-call lets the job finish
  instead of reporting a caller abort (Task 18b)`, and the explicit-`abort()`
  counterpart).
- **A settling pass finishes exactly one job — the one already in flight.** A pass
  snapshots `llm` once and iterates every due job, so letting it settle without a
  boundary re-created the same defect one job later: after the disposal the
  snapshotted handle answers `NO_ADAPTER`, `distill.js`'s route check still
  accepts it, and each remaining job would record a failure the model never
  produced until it terminally failed. The worker now hands the pass an
  `isStopped` predicate; once it is stopping, the remaining due jobs are deferred
  as `unloaded` and are not written at all, so the next process resumes them with
  `attempts` untouched. Regression test: `a pass that outlives the plugin tree
  defers the rest of the queue instead of failing it (Task 18b)` (two due jobs,
  RED before the fix with `2 !== 1`).
- **Live model distillation is now verified end to end.** The isolated-profile
  smoke (`docs/smoke-results.md`) now scores the worker's own model-backed
  distill: a real completed turn, a real `deepseek-official`/`deepseek-flash`
  call with a real token `usage`, and either a `dry-run` receipt that wrote
  nothing or an `applied` receipt that wrote the note — both with `attempts: 0`.
  The checker only treats a lane as "skipped" when the runner sets an explicit
  `skipped: true` (`--only`); a lane that ran and captured nothing is a failure,
  so the acceptance can no longer pass on a total capture failure.
  `test/smoke/negative-controls.mjs` covers both model-lane mutations.

- **A Git repository with no `.obsidian-mem` is bound by its first write, and a
  bind is visible in the session that made it.** The dogfood run measured
  (`docs/dogfood-results.md` §10 F1) that every internal seam resolved with
  `mode: "show"`, so a pointerless repository had no reachable automatic bind
  path at all — `mem_write` refused with `not-bound` — and that the unbound
  resolution was memoized per working directory for the life of the loaded
  plugin, so even an explicit `mem_admin(action="bind", mode="local")` left the
  six tools refusing until a new session. `mem_write` and `mem_log` now resolve a
  `no-pointer` Git repository exactly as spec §5.2.3 / §5.3 describe — slug from
  the Git root, exclusive pointer create, skeleton, registry row — and then
  proceed; a successful bind (automatic or explicit) replaces the per-cwd miss,
  so the next call in the same session sees it. Every fail-closed guard is
  unchanged and still refuses rather than minting: a non-Git directory, a corrupt
  or unknown-schema pointer, an unreadable registry, a taken directory, a
  cloud-managed vault and an unreadable sibling worktree. A resolution that
  already minted a pointer and then refuses now removes the pointer it created,
  so a one-off refusal cannot become a sticky one; an automatic bind that meets a
  bootstrap refusal releases the pointer only when the bootstrap created no
  project content (`vaultWritten`), so the §6.4 property preflight, a registry
  whose recorded sha256 does not cover its body and every other pre-write refusal
  leave the repository exactly as the write found it. Reads still never bind. The
  README "Project bound" row and the "A repository refuses to write", "A plain
  directory stays read-only" and "Memory is silently absent" recovery rows now
  describe this, replacing the Task 20 text that documented the defect instead.
  Regression tests: `test/auto-bind.test.js` (15 cases through the shipped tool
  runtime; 14 fail against the previous `lib/` — the one pass is the
  cloud-managed guard, which refuses before any binding work).
  A `deferred` job can also be a validation refusal (`truncated`,
  `too-many-items`) backing off, which the recovery table previously attributed
  only to a missing route or binding.
- **A transaction manifest read from disk is no longer trusted with a path.**
  `txId` and `vaultHash` are the two manifest fields that name one:
  `discard()` removes `_meta/.history/<txId>/` inside the vault, and
  `writeManifest`/`removeManifest` write or delete
  `<dataRoot>/transactions/<vaultHash>/<txId>.json`. Both were taken verbatim, so
  a manifest carrying `txId: "../../.."` or a traversing `vaultHash` deleted or
  wrote **outside** the vault. Every manifest read from disk — recovery,
  `listPendingIndexNotifications` and `markIndexNotified` — and every act site
  that joins one of those fields re-applies the request-path rules
  (`[A-Za-z0-9][A-Za-z0-9._-]{0,127}` and 64 lowercase hex) and refuses with
  `manifest-corrupt` instead of acting on it. This is hardening rather than a
  fixed violated invariant: it takes a same-user process rewriting
  `$DSH_HOME/data/obsidian-mem/transactions/`. Regression tests:
  `test/transaction.test.js` (`a manifest whose txId traverses is refused, and
  nothing outside the vault is deleted`, and its `vaultHash` twin) — both
  falsified against the previous `lib/`.
- **The smoke checker no longer passes a model lane that is absent.** A record
  with no `capture.modelLane` (or one missing a lane) scored both
  `model-lane-*-real-distill` checks as PASS, because `lane === undefined` was
  read as "skipped by `--only`". The runner also dropped the `skipped` sentinel
  when it rebuilt the lane, so a real `--only live` / `--only dry-run` run
  *failed* a lane that never ran. Absence is now a failure, only the runner's
  explicit `skipped: true` marks a lane as not run, and the runner projects that
  flag. `test/smoke/negative-controls.mjs` covers both directions (absent lane and
  the absent-`modelLane` shape fail; the sentinel still passes).

### Changed

- **Honest limits corrected** (`README.md`, `docs/smoke-results.md`): the
  "no live model call has ever been made" item is replaced by what is still
  unmeasured (one host, one route; the one-shot timing window; the Obsidian GUI).
- **An unknown config key is now refused instead of silently ignored.**
  schemastery's `z.object` passes unknown keys through, so a hand-written row with
  a typo (`vaultpath`) kept `vaultPath`'s default and pointed the plugin — and its
  bootstrap — at a different vault. `validateConfig` now refuses an unknown
  top-level or `distill` key, names it, and lists the design document's
  deliberately-dropped fields (`projectsDir`, `methodsDir`, `metaDir`,
  `reservedPrefixes`, `docMirror`, `distill.mode`, `distill.maxCostPerSession`).
  **Action for anyone who copied the design document's §12 block:** those fields
  now produce a loud error where they used to be a silent no-op. Remove them; the
  accepted field set is the README table.

## 0.1.0 — 2026-09-23

First version. Everything here was built and reviewed inside this repository;
no pack of this plugin has been installed from a registry.

### Added

- **A dedicated-vault project memory protocol written in plain Markdown.** A
  committed four-field `.obsidian-mem` pointer (`projectId`, `slug`,
  `displayName`, `schema`) binds a repository to one fixed directory,
  `项目/<slug>--<projectId 前8位>/`, inside the vault. The pointer carries no
  absolute path, so one project ID and one vault path per machine are enough to
  move a checkout.
- **Idempotent bootstrap.** First contact creates only what is missing: the
  project skeleton, `index.md`, `_meta/hot.md`, one MOC per type directory and
  the vault registry row. Existing files are never overwritten, existing vaults
  are never restructured, and `initGitOnCreate` runs `git init` only on a
  directory this plugin just created (it never commits and never configures a
  remote).
- **Three-tier memory.** A hot file (`_meta/hot.md`, ≤ `hotCapacityChars`,
  default 9000) with 强约束 / 进行中 / 已完成 zones, a warm layer of on-demand
  notes reached through `mem_search` → `mem_read`, and an append-only daily
  cold log — plus a read-only `_meta/user.md` for preferences the plugin never
  writes.
- **One budgeted recall injection.** After the first `agent/pre-step` of a
  session, a single recall message (≤ `briefBudgetChars`, default 6000 code
  points, with a footer reporting the exact usage) is appended. Later steps only
  receive a delta when the hot layer's content hash changes. A not-ready index is
  reported as not-ready, never as "no memory".
- **Six tools**: `mem_search`, `mem_read`, `mem_write`, `mem_log`, `mem_brief`
  and `mem_admin` (actions `lint`, `index`, `bind`, `projects`, `promote`,
  `jobs`). Deliberately capped at six.
- **A rebuildable search index outside the vault** — `node:sqlite` FTS5 with CJK
  overlap-bigram tokenisation and a scan fallback (`indexBackend: auto`) that
  reports the degradation instead of pretending it did not happen.
- **A transaction engine for multi-file writes**: a whole-vault write lock keyed
  by `realpath(vaultPath)`, pre-write snapshots under `_meta/.history/<txId>/`,
  exclusive publish via `link(2)`, per-step receipts and crash recovery from a
  journal under `$DSH_HOME/data/obsidian-mem/transactions/`. A file whose hash no
  longer matches what this plugin wrote is a conflict, and conflicts stop the
  write rather than overwriting the edit.
- **Automatic distillation of completed turns** into `decision` / `gotcha` /
  `convention` candidates: a durable 0600 pending queue, credential scrubbing,
  an idle debounce (`captureIdleMs`, default 90 s), a single no-tool model call,
  strict JSON validation against the evidence sequence numbers, and idempotent
  application keyed by `sessionId:toSeq:itemIndex`. Below-threshold candidates go
  to `收件箱/`; `dryRun: true` writes receipts only.
- **Governance**: supersede instead of overwrite, `contested` when two claims
  cannot be ranked, `assertion` (`stated` / `inferred` / `observed`) and
  `confidence`, `review_after` expiry, and `mem_admin(action="lint")` health
  reports (orphans, dead links, frontmatter gaps, expiry, file↔index mismatch,
  unreferenced repository Markdown, queue backlog) that are read-only unless a
  write is explicitly requested.
- **A portable skill** (`skills/obsidian-mem/SKILL.md`) synced idempotently into
  `$DSH_HOME/skills/obsidian-mem/`, written in the Agent Skills format so it
  survives a change of harness.
- **Packaging**: an explicit `files` allowlist, a `prepack` gate
  (`npm test` + `scripts/verify-pack.mjs`) and `npm test` running inside a
  throwaway `DSH_HOME`.

### Fixed

- `npm test` now runs with `DSH_HOME` set to a fresh temporary directory. An
  earlier version relied on per-test convention and a test that activated the
  plugin installed a skill into the real `~/.dsh/skills/`.
- `@deepseek-ai/cordis` and `@deepseek-ai/dsh-tools` are declared as
  `devDependencies`. They are *optional* peers, so npm deliberately does not
  install them; the suite used to pass only because hand-made symlinks happened
  to sit in the gitignored `node_modules/`, and a clean `npm ci` failed at import.
- `skills/obsidian-mem/SKILL.md` had a mangled sentence about file timestamps
  ("Use never file timestamps to invent a date"); it now reads "Never use file
  timestamps to invent a date".
- **The full suite now passes on the declared minimum Node (22.22.2).** The
  timeout case in `test/distill.test.js` waited on an `AbortSignal.timeout()`
  timer, which is unref'd, so on Node 22.22.2 that subtest and the five after it
  were cancelled with `Promise resolution is still pending but the event loop has
  already resolved` and `npm test` exited 1. A ref'd keep-alive timer now holds
  the loop open until the 20 ms timeout fires. This was found by Task 19's
  minimum-Node regression run, which had not been repeated since the case was
  added.

### Security

- Path handling refuses symlinks at every level, `..`, absolute paths and device
  paths, and refuses to treat an I/O failure (`EACCES`, `EDEADLK`, `EIO`) as
  "file absent" — on cloud-backed storage that is exactly how an offloaded file
  looks.
- A vault under a known macOS cloud root (`~/Library/Mobile Documents/`,
  `~/Library/CloudStorage/`) refuses **reads as well as writes**
  (`vault-cloud-managed`), because an on-demand file is as unsafe to read as it
  is to write.
- Every generated block carries a content hash in its marker
  (`<!-- obsidian-mem:registry begin sha256:… -->` and the `generated` variant).
  A block whose declared hash no longer matches has been edited by a human: the
  write stops and reports a conflict.
- The distillation input is a whitelist projection (real user messages, final
  assistant text, tool names and exit status, bounded paths). It never reads the
  credential store or environment, reasoning blocks, raw tool output, plugin
  injections or subagent transcripts, and a deterministic scan skips any message
  that matches a common credential shape.

### Known limitations and remaining risks

These are stated here as well as in `README.md` because they are properties of
this release, not caveats about it. Nothing in this list is a bug report; each
one is a boundary that was measured, or explicitly not measured.

- **Not verified: no live model call.** `ctx.llm.stream` was measured against the
  installed host in `docs/p0-compatibility.md` §8, but the distillation code path
  itself has only ever run against stubs built to those measured shapes. It has
  never distilled a real turn on a real route.
  *(Superseded by Unreleased: the isolated-profile smoke now distils a real turn
  through the real route — `docs/smoke-results.md`.)*
- **Not verified: no power-loss test.** Crash recovery is exercised with
  `SIGKILL` at specific barriers, not with an actual power cut or a kernel-level
  flush failure.
- **Not verified: cross-process lock contention.** The whole-vault write lock is
  exercised within one process and against a dead child; two live processes
  contending for the same vault have not been tested. The lock does not restrain
  Obsidian or any other editor at all.
- **Not verified: Obsidian's own rendering.** GUI rendering, typed properties and
  the property-type registry (`.obsidian/types.json`) have not been checked
  against a running Obsidian. The write preflight can only see types visible in
  note bytes.
- **Not verified: `fork` / `retain` across sibling worktrees.** Both modes have
  tests, but not on the worktree-sibling layout they exist for.
- **Not verified: the 0.1.5 line's read/replay side for a `plugin:` kind.**
  `docs/p0-compatibility.md` §10 measured that line's *writer* admits the kind the
  recall source now carries, but no real session was replayed through it here, so
  whether its reader adds any further kind filtering is not known. The 0.1.7 read
  side *is* covered — the conversion in §10 case C runs the production catalog
  restore over a real v3 session.
- **Residual path-jail limits.** Hard links and bind mounts are indistinguishable
  from ordinary files, and there is a classic `lstat` → `open` TOCTOU window on
  the write path.
- **`withVaultLock` is not re-entrant.** A nested acquisition would deadlock.
- **A `no-binding` or `no-route` job re-arms indefinitely** rather than becoming
  terminal, at a bounded rate of at least one queue-file write per idle window.
- **`MAX_REFUSED_ENTRIES = 32` caps a job's refusal audit**, so a receipt can
  report 32 when more candidates were dropped.
- **`dsh.plugin.json` is inert.** Nothing in DSH core reads it, so a stale
  version there has no runtime effect — which is exactly why `prepack` fails when
  it disagrees with `package.json`.
- **The Chinese README has not been reviewed by a native reader.**
  `README.i18n.yaml` records the two blob hashes as consistent, which proves the
  pair is the revision that was intended, not that the Chinese reads well. A
  wording fix on that side is a welcome pull request.
