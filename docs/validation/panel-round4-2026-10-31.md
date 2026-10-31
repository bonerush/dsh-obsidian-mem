# 面板第 4 轮 — 固定格子热度图 / 分流柱起点 / 活动时间线 / 实时刷新 / 同源修复（2026-10-31）

**Status: PASS** — 全部 after 状态都用真实 payload、真实 view 模块、真实样式表、真实宿主
tokens 在 headless Chrome 里量过并截图（320 / 375 / 480 / 590 / 659 / 660 / 720 px），
tooltip 用真实 React 18 + Playwright hover 验证；371 天 wire size 用**真实路由 + 真实 index**
在 loopback 上量到 **13,910 B < 20 KiB**。自动聚合的 **220 条检查 220 PASS / 0 FAIL**
（`scratch/panel-ux-round4/out/analysis.txt`）。task-6 的最终 polish（flow 渲染宽度
cap + rail 颜色）在 2026-10-31 12:07–12:09 整组复测（§4.8）。宿主 Electron 侧栏本身
没有重拍（§9）。

## 1. Captured bytes

| item | value |
|---|---|
| base commit | `101b3b59efd14ed6d9977618e022dcc05d199f5b` (v0.4.4)，工作树干净时冻结基线源 |
| HEAD `lib/memory-panel.js`（基线） | blob `6ae578ae` · 2,998 行 · sha256 `a72dc8e5…` |
| HEAD `lib/client.js`（基线） | blob `4ed24333` · 1,417 行 · sha256 `bde2c794…` |
| HEAD `lib/panel-route.js`（基线） | blob `e5cd9705` · 796 行 · sha256 `721ffe10…` |
| 最终 `lib/memory-panel.js`（含 task-6 polish） | blob `98dcccb2` · **3,339 行** · sha256 `951d7112…` |
| 最终 `lib/client.js`（含 task-6 polish） | blob `1c5bb90b` · **1,453 行** · sha256 `981de491…` |
| 最终 `lib/panel-route.js` | blob `16213797` · **888 行** · sha256 `01168f38…` |
| 最终 `lib/index-stats.js` / `lib/index-db.js` | blob `41f35d1d` / `10873f12` · sha256 `b39f8ff0…` / `c5d858f9…` |
| 实时 overview payload（days:182，真实宿主） | **10,697 B** · activity 182 天（2026-05-03 → 2026-10-31）· created 973 / updated 142 · sha256 `d0639bb1…` |
| 实时 health payload | **5,391 B** · sha256 `fd19b795…` |
| live index 快照（`sqlite3 .backup`） | 8,060,928 B · 1,236 notes / 16,248 fm_kv · sha256 `472abf1e…` |
| 真实 371 天 activity 序列 | **6,400 B** · 2025-10-26 → 2026-10-31 · created 973 / updated 142 · sha256 `3d3c5d96…` |
| 合并估算 envelope | **13,910 B** · sha256 `c8d39653…` |
| **真实路由** 371 天 answer（`probe-route-371.mjs`） | **13,910 B** · activity 371 天 / 973 / 142 / 6,400 B · 与合并估算除 `health.lastScan` 外逐字节相同 |
| **真实路由** 182 天 answer | **10,697 B** · 与实时 payload 除 `health.lastScan` 外逐字节相同 |
| 默认（无 days）84 天 answer | 9,031 B |
| 采集页面 | overview 7 宽度 × (static + real-React) + health 4 宽度 + timeline fixture 1 页 + flow 26 周长窗口 fixture 7 宽度 |
| 截图 | `scratch/panel-ux-round4/out/` 共 174 张 PNG（after 126 / baseline 41 / 其他 7） |

体量闸门：20 KiB = 20,480 B。真实 371 天 envelope **13,910 B**，余量 **6,570 B**；实时
182 天 10,697 B，扩到 371 天只多 **3,213 B**（activity 3,187 → 6,400）。

## 2. Method

全部脚手架在 `scratch/panel-ux-round4/`（`scratch/` 被 .gitignore 忽略，不随发布），
从第 3 轮 `/tmp/panel-ux` 复制后把路径改指 repo 与本目录。基线源文件在任何人改 `lib/`
之前就 `git show HEAD:` 冻结为 `head/memory-panel-head.js`、`head/client-head.js`，
所以 before/after 用**同一个 builder**，只换视图源与 payload。

### 2.1 Payload（真实宿主）

```sh
curl -sS -o scratch/panel-ux-round4/live-overview-182.json -X POST \
  http://127.0.0.1:52074/obsidian-mem/panel \
  -H 'content-type: application/json' \
  --data-binary '{"sessionId":"session-3aca8158-1224-438e-b552-e5e3eb6572d5","action":"overview","days":182}'
# -> HTTP 200, 10,697 bytes
```

桌面宿主代理转发时会剥掉 Origin（item 5 根因），所以这次 curl 复现的是**没有 Origin 的
桌面形状**；读请求按 `trusted()` 的既有容忍返回 200。当前运行中的宿主仍是重装前的旧路由
（`ACTIVITY_DAYS_MAX = 182`），371 天行为由 §2.3/§2.4 的生产路径探针证明。

### 2.2 真实 371 天序列（不是 fixture）

`sqlite3 "<live index>" ".backup scratch/panel-ux-round4/index/index.db"` 取一致性快照
（WAL 一起 checkpoint，避免只拷 .db 丢掉 4 MB 未 checkpoint 的事务），再用**发布代码**的
`activityWindow()` / `bucketActivity()` / `normalizeActivityRow()`（`lib/index-stats.js`）
从 `notes` + `fm_kv` 聚合：

- 先复算 **182 天**窗口并与实时 payload 的 `activity` 逐字段（from/to/days/created/updated）
  比较：**相等**。
- 再把同一批 973 行扩到 **371 天**：2025-10-26 → 2026-10-31，created 973 / updated 142。
  事件分布：created 只有 22 个非零日、updated 7 个；53 个 Sunday-first 周里只有第 47–52 周
  有数据（201/0、408/98、149/0、87/3、6/0、122/41），前 47 周全空 —— 这正是 item 2
  「分流柱从左边开始」与 item 3「初始滚动到右端」要用到的真实形状。
- `prep-payload-371.mjs` 把 371 天序列替换进实时 envelope 的 `value.activity`，得到
  `overview-371.json`（13,910 B）——除 activity 外每个字节都是宿主的真实回答。

### 2.3 Shipped-reader 探针（371 天窗口能不能被生产读路径接受）

发现并上报过一个真实的生产断点：路由 `readActivity()` 调
`index.activity({ scope:'project', days })`，而 `lib/index-stats.js` 的
`MAX_ACTIVITY_DAYS = 365` 会 `RangeError`，路由 `catch` 后返回 `activity: null` ——
只把路由的 `ACTIVITY_DAYS_MAX` 改成 371 会让真实宿主的热度图/分流柱**无数据**。
Lead 把 index 侧修复交给 task-2（`MAX_ACTIVITY_DAYS` 365 → 371、`index-db.js` JSDoc、
`test/index-stats.test.js` 边界），已落地。

`probe-shipped-reader.mjs` 用**生产入口**验证（不是只看单测）：

```
openIndex({ vaultRoot: <真实 vault 的临时副本>, dataRoot: <mktemp>, backend:'sqlite',
            projectId:'05025725-00be-4852-aba6-4854f961cd01' })
  -> status: backend=sqlite ready=true notes=1236
  -> activity({days:182}) 与实时 payload 逐字段相等: TRUE
  -> 修复前: activity({days:371}) -> RangeError: activity days must be an integer between 7 and 365
  -> 最终树: activity({days:371}) -> 371 天, 973/142, 6,400 B, 与快照复算序列相等: TRUE
```

真实 vault 只读、不写：索引在 `/tmp/vault-r4-*` 的副本上重建，dataRoot 是 `mktemp`；
证据原文 `out/probe-reader-pre.txt` / `out/probe-reader-final.txt`。

### 2.4 Shipped-route 探针（真实 371 天 wire size）

运行中的宿主仍是旧路由，curl 打不到 371 天。`probe-route-371.mjs` 因此用**发布代码**
`registerPanelRoute` 在 loopback 上起一个真实 HTTP 路由，`services.indexForBinding` 返回
§2.3 那个真实 index（vault 副本 + 临时 dataRoot）；`services.admin` 的四张卡按实时 payload
自己的值喂入（`jobs`/`hot`/`digest` 只被路由投影，内容不是伪造的），`resolveBinding`
返回实时 payload 的同一 binding（vaultRoot 用真实路径，只为让 `projectOf()` 输出
`~/Documents/dsh-memory` 的显示形状）。最终树重跑结果：

| request | bytes | 结论 |
|---|---|---|
| `days:182` | 10,697 | 与实时 payload 仅 `health.lastScan` 不同（新开 index 会重扫，该字段本就随时间移动；归一化后逐字节相等） |
| `days:371` | **13,910** | activity 371 天 / 973 / 142（6,400 B）· **< 20 KiB**（余量 6,570 B） |
| 无 days | 9,031 | activity 84 天，设计窗口回归不变 |

同源围栏矩阵（item 5 的服务端半）：读请求无 Origin → 200；mutation 无 Origin 无 header →
403；无 Origin + `x-obsidian-mem-panel: 1` → 400 bad-request（**围栏已放行**，后续参数校验
拒绝）；错 Origin + header → 403 forbidden。证据 `out/probe-route-final.txt`、
`out/probe-route-report.json`、`route-overview-371.json`。

关键点：`route-overview-371.json`（路由真实回答）与 `overview-371.json`（实时 payload +
复算 activity 的估算）**除 health.lastScan 外逐字节相同** —— wire size 不再是估算。

### 2.5 渲染与量测

- **视图与样式是发布代码**：真实 `createMemoryViews`、`lib/client.js` 的
  `/* panel-css:start */…end */` 切片、从已安装 DSH app.asar 提取的宿主 tokens
  （`tokens.css`），shell 的 tabbar/searchbar/mem-view 与 `lib/client.js` 结构一致。
  tokens 在 Lead 审阅 UI diff 时补过一轮：新 tooltip 用 `--dsw-alias-bg-overlay`
  （= `--dsw-static-neutral-bluish-150:#e9ecf2`）、tooltip/确认单用 `--dsw-shadow-lv1`；
  三者都在采集前从同一个 app.asar 重新提取（light 主题里 lv1 是 `0 2px 4px 0 #0000000d`
  = `rgba(0,0,0,.05)`，第 3 轮采集脚本里的 `0 1px 2px .06` 是错的），否则 tooltip
  会是透明底、截图会低估设计。
- **两套 builder**：
  - `build-pages.mjs`：四 hook React 替身把虚拟树序列化成静态 HTML（几何量测用），
    页面走 `file://`；
  - `build-react-pages.mjs` + `capture-after-react.mjs`：**真实 React 18 UMD**
    （装在 `scratch/panel-ux-round4/runtime/`，只作采集用，不随发布）挂载真实视图模块，
    页面经 loopback HTTP 提供 —— 悬停 tooltip、初始滚动位置、滚动隐藏这些**行为**必须
    在真 DOM 里跑。
- **量测**：Playwright 1.64.1 + `channel:"chrome"` headless，DPR 1；
  `getBoundingClientRect` / `getComputedStyle` / SVG 属性读取，逐宽度截图；
  每个宽度同时检查 `documentElement.scrollWidth == innerWidth`、
  `.mem-view.scrollWidth == clientWidth`（页面自身绝不能横向滚动）。
- 静态 builder 的 inline style 序列化在最终 polish 复测时修正过：它此前把
  `style={maxWidth}` 原样写成 `maxWidth:`（无效 CSS，被浏览器丢弃），于是静态页面上
  flow 看不出 cap（量到 81px 柱宽），而真实 React 页面正确应用 `max-width`（24px）。
  修正后 static 与 real-React 两套页面给出同一组数字（§4.8），本记录以修正后的采集为准。
- 自动聚合：`analyze-after.mjs` 读全部 JSON 产出 **220** 条 PASS/FAIL 检查
  （`out/analysis.txt`），本记录的数字都从这些 artifact 复算，不靠手抄。

### 2.6 时间线的多日 fixture

真实 live payload 的 8 条 recent **全部是「今天」**（2026-10-31），只会渲染 1 个 group，
不足以观察跨 group 的轨道连续性。`make-timeline-fixture.mjs` 只替换 `value.recent` 的
`updated` 为今天/昨天/10-29/10-29/10-29/10-21/09-30/null，其余字段（含 activity）仍是
真实 371 天 envelope，得到 `overview-timeline-fixture.json`（13,902 B）。真实 payload 验证
单 group 形态，fixture 验证 6 group 的 rail 几何；两者都在记录里标明来源。

## 3. Before（基线：HEAD 101b3b5 + 实时 182 天 payload）

| panel px | heat grid w | cols | cells | cell px | pitch px | flow viewBox | first bar x | recent rows | page overflow |
|---|---|---|---|---|---|---|---|---|---|
| 320 | 292 | 12 | 84  | 22.50 | 24.50    | 0 0 140 80 | 72  | 8 | 无 |
| 375 | 347 | 15 | 105 | 21.27 | 23.2656  | 0 0 176 80 | 108 | 8 | 无 |
| 480 | 452 | 19 | 133 | 21.89 | 23.8906  | 0 0 224 80 | 156 | 8 | 无 |
| 590 | 562 | 24 | 168 | 21.50 | 23.50    | 0 0 284 80 | 216 | 8 | 无 |
| 659 | 631 | 26 | 182 | 22.34 | 24.3438  | 0 0 308 80 | 240 | 8 | 无 |
| 660 | 632 | 26 | 182 | 22.38 | 24.375   | 0 0 308 80 | 240 | 8 | 无 |
| 720 | 692 | 26 | 182 | 24.69 | 26.6875  | 0 0 308 80 | 240 | 8 | 无 |

- 基线热度图是「随宽度变长的 12–26 周尾部切片」：cell 21.27–24.69 px 不固定、没有滚动
  容器/月份/星期标签/hover tooltip；payload 只有 182 天，320px 只画 84 格。
- 基线分流柱从窗口左端画起：first bar x = 72/108/156/216/240/240/240（前导空周占 x）；
  基线 SVG 是裸 `width:100%` 无 cap，柱子被拉伸到 15.77–17.97px（320→720 各不相同）。
- 基线「最近变化」是平铺 8 行 `.mem-recent` 列表（每行 h≈57.69），无时间线。
- 基线健康：文档宽度在每个宽度都等于视口；五个 section 的 y/h 在所有宽度完全相同
  （y=337.19/500.56/570.75/864.31/1088.88，h=139.38/46.19/267.56/200.56/149.06）。
- 截图：`out/baseline-overview-{top,heat,flow,recent}-{w}.png`、
  `out/baseline-health-top-{w}.png`；量测 `out/measure-baseline-{overview,health}.json`。

## 4. After（最终工作树）

### 4.1 热度图：固定 10px 日历（item 3）

所有宽度统一 53 列 × 371 格、cell **10×10 px**、pitch **12 px**（gap 2 px）、grid 高
**82 px**（7×10 + 6×2）；容器 292–692 px 之间变化，日历固定 634 px 宽 + 14 px 星期槽 =
648 px canvas，**只有 `.mem-heat-scroll` 自己横向滚动，页面本身从不溢出**。

| panel px | before（cols/cells/cell） | after（cols/cells/cell） | heat scroll box client/scroll (max) | page overflow |
|---|---|---|---|---|
| 320 | 12 / 84 / 22.50 px | 53 / 371 / 10×10 px | 292 / 648 (356) | 无 |
| 375 | 15 / 105 / 21.27 px | 53 / 371 / 10×10 px | 347 / 648 (301) | 无 |
| 480 | 19 / 133 / 21.89 px | 53 / 371 / 10×10 px | 452 / 648 (196) | 无 |
| 590 | 24 / 168 / 21.50 px | 53 / 371 / 10×10 px | 562 / 648 (86) | 无 |
| 659 | 26 / 182 / 22.34 px | 53 / 371 / 10×10 px | 631 / 648 (17) | 无 |
| 660 | 26 / 182 / 22.38 px | 53 / 371 / 10×10 px | 632 / 648 (16) | 无 |
| 720 | 26 / 182 / 24.69 px | 53 / 371 / 10×10 px | 692 / 692 (0，日历比正文窄 44px) | 无 |

- **初始滚动位置**：真实 React 挂载后 `scrollLeft` 直接等于 `maxScrollLeft`
  （320:356、375:301、480:196、590:86、659:17、660:16；720 无滚动为 0）——首屏落在当前周。
- **滚动只在自己的盒子里**：scrollLeft 0 与 max 两态下 `documentElement.scrollWidth`
  始终 == 视口（320:320、375:375、480:480、590:590、659:659、660:660、720:720）；
  scrollLeft=0 时第一格在 x=28（盒内），max 时最后一格右沿 == 盒右沿（320:306、375:361…）。
  截图 `out/after-overview-heat-{320,375}-scroll-{zero,max}.png` 与
  `out/after-react-{320,375}-heat-scroll-{zero,max}.png`。
- **月份标签**：13 个（10月 0px、11月 36、12月 72、1月 120、2月 168、3月 216、4月 276、
  5月 324、6月 384、7月 432、8月 480、9月 540、10月 588），所有宽度两两不重叠
  （最近间距 > 2px），符合 GitHub「首个 + 每月变化且距上一个已标列 ≥3 列」规则。
- **星期标签**：槽宽 14px，行 2/4/6 为 一/三/五（Sunday-first）。
- **meta / aria / legend**：meta = `近 53 周（371 天）· 本周 6 天有更新 · 合计 1115 条`；
  aria-label = `近 53 周活动，共 1115 条，峰值 322`；legend = 悬停查看每天 + 少 +
  `is-l0..is-l4` 5 个色块 + 多；每格保留 `<date> · n 条` 的 aria-label 与 `.mem-sr`
  文本，**没有任何 cell 带原生 `title`**（371/371 格有 sr 文本、0 格有 title）。
- 截图：`out/after-overview-heat-{w}.png`、`out/after-react-{w}-heat-{zero,max}.png`。

### 4.2 Tooltip：发现缺陷 → 修复 → 复测（item 3 的 clamp）

本轮验证中真实 Chrome 曾测出一个 **clamp 缺陷**（已上报 panel-ui）：旧实现把
**中心点**夹进 `[16, clientWidth-16]`，而 CSS 是 `translate(-50%)` + `white-space:nowrap`，
~120–125px 的盒子在两端各溢出约半个宽度。修复前 320px 量到：

| hover | tooltip rect | `.mem-heat` rect | 结论 |
|---|---|---|---|
| 最左可见格（scrollLeft 0） | x=-29.55 .. 95.55 | x=14 .. 306 | **左溢 43.5px（已在视口外）** |
| 最右可见格（scrollLeft max） | x=229.88 .. 350.13 | x=14 .. 306 | **右溢 44.1px** |

panel-ui 改为**两遍夹盒子边缘**（首帧用字形数估算，layout effect 用
`getBoundingClientRect().width` 实测重新夹：centre = round(max(w/2+6, min(anchor, box-w/2-6)))，
并把宽度记进状态避免抖动）。最终树复测（真实 React 18 + Playwright hover）：

| 宽度 | 场景 | tooltip rect | 盒内余量（左/右） | inside |
|---|---|---|---|---|
| 320 | 左侧第一格 | x=20.45 .. 145.55 | 6.45 / 160.45 | 是 |
| 320 | 右端最后一格 | x=179.88 .. 300.13 | 165.88 / **5.87** | 是 |
| 375 | 左侧第一格 | x=20.45 .. 145.55 | 6.45 / 215.45 | 是 |
| 375 | 右端最后一格 | x=234.88 .. 355.13 | 220.88 / **5.87** | 是 |
| 720 | 右侧最后一格（无滚动） | x=579.88 .. 700.13 | 565.88 / **5.87** | 是 |

- 文本形态正确：有记录 `2026-09-24 · 89 条`、零记录 `2025-10-26 · 无记录`，
  右端最后一格 `2026-10-31 · 23 条`（19 created + 4 updated 同日不重复计数后仍为 23 条）。
- 出现/消失：hover 出现；`.mem-heat-scroll` 滚动后消失；mouseleave 后消失
  （320/375/480/590/659/660 均验证；720 无滚动可触发，故该态保持显示 —— 无 scroll 事件）。
- 截图：`out/after-react-{320,375}-tip-{nonzero,zero,edge-left,edge-right}.png`。

### 4.3 分流柱从左边开始（item 2）

真实 371 天数据只有 6 个有事件的周（第 47–52 周），修复前它们被画在窗口右端；
最终树 after：`viewBox 0 0 68 80`，**firstBarX = 0**、lastBarRight = 68，8 根 rect
（6 周 × 2 序列，零值周不画柱），零线 `y1=y2=40`，无 `rx`。meta 用裁剪后的周数：
`近 6 周净增 831`（created 973 − updated 142），所有 7 个宽度一致。

task-6 polish 后渲染宽度有 cap：SVG `max-width = viewBoxWidth × 3`（`FLOW_RENDER_SCALE = 3`），
CSS 仍 `width:100%` → 6 数据周窗口在**所有** 7 个宽度下渲染 **204px**（68×3）、柱子
**24px**、左边对齐（leftInset 0），不再随面板拉伸（旧行为 320px 下柱子 81px 量级）。
截图：`out/after-overview-flow-{w}.png`（复测后已用 cap 版覆盖）。

### 4.4 最近变化 → 活动时间线（item 4）

真实 payload（8 条全部「今天」）渲染 1 个 group：`今天 / 8 条`，12px 强调色圆点
（`rgb(65,118,230)`、2px `rgb(255,255,255)` ring、radius 16px）+ 1px
`color-mix(in srgb, var(--dsw-alias-label-secondary) 22%, transparent)` 的 `::before`
轨道（计算值 `color(srgb 0.380392 0.4 0.419608 / 0.22)`，高 395.5px，覆盖整个 group），内部 8 条 item
各带 6px 圆点 + title + `<typeLabel> · <statusLabel>`。

跨 group 连续性用 §2.6 的 6 组 fixture 量（720px）：

| group | 今天 | 昨天 | 2026-10-29 | 2026-10-21 | 2026-09-30 | 未知 |
|---|---|---|---|---|---|---|
| count | 2 条 | 1 条 | 2 条 | 1 条 | 1 条 | 1 条 |
| node y | 1263.19 | 1392.56 | 1477.25 | 1606.63 | 1691.31 | 1776 |

- 6 个 node 中心 x 全为 20（spread 0）；相邻 group 盒 top/bottom 相接（gap 0，链式）；
  每个 group 的 `::before` 高度 == 该 group 盒高（首个 group 按 CSS 少 6px，即从 node 上方
  6px 起笔），整条轨道由相邻盒 + 1px 线连续覆盖，无断点。
- 排序：日期新→旧，`未知` 永远最后；日期标签 今天/昨天/YYYY-MM-DD 全部正确。
- 截图：`out/after-overview-timeline-{w}.png`、
  `out/after-fixture-overview-timeline-720.png`。

### 4.5 实时刷新（item 1）与同源修复（item 5）的验证边界

- item 5 的**服务端围栏**由 §2.4 的真实路由矩阵证明（无 Origin + header 放行；无 header
  403；错 Origin 403）；**客户端**的 `x-obsidian-mem-panel: 1` 由 task-1 的双源测试钉住
  （owner 报告，本记录未在浏览器里发真实 mutation —— 桌面宿主仍是旧构建）。
- item 1 的服务端 refresh 节流与客户端 15s 静默轮询由 task-1/task-2 的单元测试覆盖
  （owner 报告）；本轮截图不等待 15s 轮询，**实时刷新的端到端行为未在本记录中实测**（§8）。

### 4.6 健康视图回归（320 / 375 / 659 / 720）

4 个宽度均无横向溢出（doc/client 相等），五个 section 的 y/h 与基线**完全相同**
（y=337.19/500.56/570.75/864.31/1088.88，h=139.38/46.19/267.56/200.56/149.06）——
本轮改动没有顺手改变健康视图布局。截图 `out/after-health-top-{w}.png`。

### 4.7 自动检查汇总

`analyze-after.mjs` 对 before/after/fixture/flow26/health/react 全部 JSON 做 **220** 条断言：
**220 PASS / 0 FAIL**（`out/analysis.txt`）。覆盖：无页面横向溢出、固定 53×7 日历 /
10px cell / 12px pitch / 82px 高、月份不重叠、星期 一/三/五、heat meta/aria/legend、
初始滚动到右端、两态滚动不撑宽页面、flow firstBarX=0 + viewBox 68 + meta、tooltip
出现/夹取/滚动隐藏/mouseleave 隐藏/无原生 title/371 格 sr 文本、时间线 6 组顺序与计数/
node 同心/轨道连续/6px item 点、健康 section 与基线相同、wire size < 20 KiB、
182 天路由回答 == 实时 payload（归一化 lastScan）。

### 4.8 Final polish 复测（task-6，2026-10-31 12:07–12:09）

panel-ui 在 task-6 里加了两处 polish，触发整组复测。复测树：
`lib/memory-panel.js` blob `98dcccb2` · 3,339 行 · sha256 `951d7112…`；
`lib/client.js` blob `1c5bb90b` · 1,453 行 · sha256 `981de491…`（其余文件不变）。

**(a) 新建与更新渲染宽度 cap。** `flowBars` 给 SVG 加 inline
`max-width = viewBoxWidth × FLOW_RENDER_SCALE`（3），CSS 保持 `width:100%`。
真实 6 数据周 payload（viewBox 68）：

| panel px | svg clientWidth | max-width | 容器宽 | 柱宽（渲染） | scale | left inset |
|---|---|---|---|---|---|---|
| 320 | **204** | 204px | 292 | **24 px** | 3 | 0 |
| 375 | **204** | 204px | 347 | **24 px** | 3 | 0 |
| 480 | **204** | 204px | 452 | **24 px** | 3 | 0 |
| 590 | **204** | 204px | 562 | **24 px** | 3 | 0 |
| 659 | **204** | 204px | 631 | **24 px** | 3 | 0 |
| 660 | **204** | 204px | 632 | **24 px** | 3 | 0 |
| 720 | **204** | 204px | 692 | **24 px** | 3 | 0 |

7 个宽度数字完全相同（不再随面板拉伸），SVG 左对齐、firstBarX 仍为 0；
真实 React 页面用 `getBoundingClientRect()` 量到同一组值（svg 204 / bar 24）。

**(b) 长窗口仍然填满正文。** 26 数据周 fixture（`overview-flow26-fixture.json`，
synthetic activity：只有尾部 26 个周有事件，其余字段仍是真实 payload）。布局是
**宽度驱动窗口**：窄面板只画 12–24 周，659/660/720 才画满 26 周（viewBox
`26×12−4 = 308`，cap `924px`）：

| panel px | 画出周数 | viewBox | max-width | svg clientWidth | 容器宽 | 柱宽 | 是否填满 |
|---|---|---|---|---|---|---|---|
| 320 | 12 | 140 | 420px | 292 | 292 | 16.69 | 是（cap 高于容器） |
| 375 | 15 | 176 | 528px | 347 | 347 | 15.77 | 是 |
| 480 | 19 | 224 | 672px | 452 | 452 | 16.14 | 是 |
| 590 | 24 | 284 | 852px | 562 | 562 | 15.83 | 是 |
| 659 | 26 | 308 | 924px | 631 | 631 | 16.39 | 是 |
| 660 | 26 | 308 | 924px | 632 | 632 | 16.42 | 是 |
| 720 | 26 | 308 | 924px | 692 | 692 | 17.97 | 是 |

长窗口下 cap（924）高于正文宽（≤692），`width:100%` 照旧填满；只有短窗口
（6 周、viewBox 68、cap 204）会被 cap 收窄。所有宽度无页面横向溢出。
截图：`out/after-flow26-overview-flow-{320,375,480,590,659,660,720}.png`。

**(c) 时间线轨道颜色。** `.mem-timeline-group::before` 由
`var(--dsw-alias-border-l1)`（4% 黑）改为
`color-mix(in srgb, var(--dsw-alias-label-secondary) 22%, transparent)`。
fixture 6 组量到：计算宽度 **1px**、背景
`color(srgb 0.380392 0.4 0.419608 / 0.22)`（= label-secondary rgb(97,102,107) 22%，
肉眼可见的 hairline，不是 4% 的近透明）；每组 `::before` 高度仍 == group 盒高
（首组按 CSS 少 6px），相邻盒 gap 0 → 轨道连续。
截图：`out/after-fixture-overview-timeline-720.png`（已覆盖为 22% 版本）。

**(d) 工程侧发现。** 复测第一步就发现静态 builder 把 `style={maxWidth}` 序列化成
无效的 `maxWidth:` CSS 属性（浏览器丢弃），静态页量到 81px 柱宽；修正成与 React 一致的
kebab-case 后 static 与 real-React 数字一致（§2.5 已记录）。这也是本轮把 flow 数字
同时用两套 builder 交叉验证的原因。

**(e) 复测结论。** 220 条自动检查 **220 PASS / 0 FAIL**；heat / tooltip / timeline /
health / 页面溢出 / 371 天 wire size 全部与 §4.1–§4.7 一致（数字未回退）；
仅 flow 渲染宽度（新增 cap 数字）与 rail 颜色（新增计算值）两项是 polish 后的新证据。

## 5. 371 天 wire size 与 20 KiB 上限

| payload | bytes |
|---|---|
| 实时 182 天 overview（旧路由真实回答） | 10,697 |
| 其中 activity 182 天 | 3,187 |
| 真实 activity 371 天 | 6,400（+3,213） |
| 合并估算 371 天 envelope | **13,910** |
| 真实路由 371 天 answer（最终树） | **13,910**（与估算除 `lastScan` 外逐字节相同） |
| 默认（无 days）84 天 answer | 9,031 |
| 新 ceiling（20 KiB） | 20,480 |
| 余量 | **6,570** |

spec 估算「fully active year ~16.5 KB」仍低于 20 KiB；真实数据 13,910 B 说明 371 天窗口在
当前 vault 上不会触发 `shrink()` 的第一级（把 activity 收回 84 天）。

## 6. Test counts（owner 报告，本记录未重跑）

- owner 报告（task-1/task-2 完成时）：panel-ui 65 / panel-client 23（共 88）· panel-route 37 ·
  index-stats 29，全部 pass；task-6 polish 这两处改动后 owner 未再报告计数，本记录不重跑
  套件。最终行数（task-6 后）：`memory-panel.js` **3,339** / `client.js` **1,453** /
  `panel-route.js` 888 / `index-stats.js` 221。
- `test/architecture.test.js` 预算由 Lead 上调：panel-route 800 → 950、
  memory-panel 3,000 → 3,400（按 measured-plus-30 规则）。

## 7. Commands

```sh
# 真实 payload / 序列 / 探针
curl -sS -o scratch/panel-ux-round4/live-overview-182.json -X POST http://127.0.0.1:52074/obsidian-mem/panel \
  -H 'content-type: application/json' \
  --data-binary '{"sessionId":"session-3aca8158-1224-438e-b552-e5e3eb6572d5","action":"overview","days":182}'
node scratch/panel-ux-round4/real-activity-371.mjs     # 182 天回归 + 371 天真实序列
node scratch/panel-ux-round4/prep-payload-371.mjs      # -> overview-371.json (13,910 B)
node scratch/panel-ux-round4/probe-shipped-reader.mjs  # 生产读路径 182/371
node scratch/panel-ux-round4/probe-route-371.mjs       # 真实路由 182/371 + 同源围栏矩阵

# 基线页（HEAD 源 + 实时 182 天 payload）
MEMORY_PANEL_SRC=…/head/memory-panel-head.js CLIENT_SRC=…/head/client-head.js \
  PAGE_PREFIX=baseline-overview PAYLOAD_FILE=…/live-overview-182.json \
  node scratch/panel-ux-round4/build-pages.mjs --view=overview 320 375 480 590 659 660 720
MEMORY_PANEL_SRC=…/head/memory-panel-head.js CLIENT_SRC=…/head/client-head.js \
  PAGE_PREFIX=baseline-health PAYLOAD_FILE=…/live-health.json \
  node scratch/panel-ux-round4/build-pages.mjs --view=health 320 375 480 590 659 660 720
node scratch/panel-ux-round4/measure-round4.mjs --view=overview --tag=baseline --prefix=baseline-overview 320 375 480 590 659 660 720
node scratch/panel-ux-round4/measure-round4.mjs --view=health   --tag=baseline --prefix=baseline-health   320 375 480 590 659 660 720

# after 页（最终工作树 + 真实 371 天 payload）
PAGE_PREFIX=after-overview PAYLOAD_FILE=…/overview-371.json \
  node scratch/panel-ux-round4/build-pages.mjs --view=overview 320 375 480 590 659 660 720
PAGE_PREFIX=after-health PAYLOAD_FILE=…/live-health.json \
  node scratch/panel-ux-round4/build-pages.mjs --view=health 320 375 659 720
PAGE_PREFIX=after-fixture PAYLOAD_FILE=…/overview-timeline-fixture.json \
  node scratch/panel-ux-round4/build-pages.mjs --view=overview 720
PAYLOAD_FILE=…/overview-371.json node scratch/panel-ux-round4/build-react-pages.mjs --view=overview --tag=after 320 375 480 590 659 660 720
node scratch/panel-ux-round4/measure-round4.mjs --view=overview --tag=after --prefix=after-overview 320 375 480 590 659 660 720
node scratch/panel-ux-round4/measure-round4.mjs --view=health --tag=after --prefix=after-health 320 375 659 720
node scratch/panel-ux-round4/measure-round4.mjs --view=overview --tag=after-fixture --prefix=after-fixture 720
node scratch/panel-ux-round4/capture-after-react.mjs --tag=after 320 375 480 590 659 660 720
node scratch/panel-ux-round4/capture-after-react.mjs --tag=after 320 375 480 590 659 660 720
node scratch/panel-ux-round4/analyze-after.mjs         # 220 PASS / 0 FAIL

# final polish（task-6）复测：双 builder、同一组断言
PAGE_PREFIX=after-flow26 PAYLOAD_FILE=…/overview-flow26-fixture.json \
  node scratch/panel-ux-round4/build-pages.mjs --view=overview 320 375 480 590 659 660 720
node scratch/panel-ux-round4/measure-round4.mjs --view=overview --tag=after-flow26 --prefix=after-flow26 320 375 480 590 659 660 720
```

## 8. Artifacts（`scratch/panel-ux-round4/`，未提交）

- 页面：`pages/page-{baseline,after}-{overview,health}-{w}.html`、
  `pages/react-after-overview-{w}.html`、fixture 页。
- 截图（`out/`，共 174 张）：基线 `baseline-overview-{top,heat,flow,recent}-{w}.png`、
  `baseline-health-top-{w}.png`；after `after-overview-{top,heat,flow,timeline}-{w}.png`、
  `after-overview-heat-{320,375,480,590,659,660}-scroll-{zero,max}.png`、
  `after-react-{w}-{heat-scroll,tip-*}.png`、`after-health-top-{w}.png`、
  `after-fixture-overview-timeline-720.png`；
  task-6 polish 复测新增 `after-flow26-overview-flow-{320,375,480,590,659,660,720}.png`，
  并把 `after-overview-flow-{w}.png` / `after-overview-timeline-{w}.png` /
  `after-fixture-overview-timeline-720.png` 覆盖为 polish 后版本。
- 量测：`out/measure-{baseline,after}-*.json`、`out/capture-after-react.json`、
  `out/analysis.txt`、`out/probe-reader-*.txt`、`out/probe-route-*.json|txt`、
  `overview-371.json`、`route-overview-371.json`、`activity-371.json`、
  `live-overview-182.json`、`live-health.json`、`index/index.db`（一致性快照）。

## 9. Unverified

- **桌面 Electron 侧栏本身没有重拍**：验证的是真实 view 模块 + 真实样式表 + 真实宿主
  tokens 在 headless Chrome 里的渲染。桌面 profile 是仓库文件的硬链接快照，用户要重装/
  完全重开 DSH 才能看到新面板。
- **运行中的桌面宿主进程没有加载新路由**（仍是旧构建，182 天 clamp）：371 天 wire size
  与同源围栏由「真实 index 读路径」+「真实 `registerPanelRoute` 的 loopback HTTP 探针」
  证明（§2.3/§2.4）；桌面宿主本身未实测。
- **item 1 实时刷新的端到端行为未实测**：服务端 refresh 节流与客户端 15s 静默轮询由
  task-1/task-2 单元测试覆盖（owner 报告）；本验证不等待 15s 轮询观察跨进程新记忆出现。
- item 5 的真实 mutation（整理热层/发布摘要）未在浏览器里点过：桌面宿主加载不到新路由，
  客户端 header 只由双源测试钉住。
- 原生滚动条外观、DPR≠1、Windows/Segoe UI 字体、<320 或 >720 面板未覆盖。
- 跨 DST 的 371 天窗口未单独构造时区测试（与 84 天窗口同一套 localDate/shiftDay）。