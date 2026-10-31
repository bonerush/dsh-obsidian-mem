# 面板第 5 轮 — 启动竞态 / 每日采样 / 真实动作回执（2026-10-31）

**Status: PASS** — 三个用户报告的 bug 都用真实代码路径验证：路由探针（真实
`registerPanelRoute` + 真实 index 快照）**17 PASS / 0 FAIL**；真人视图探针（真实
`lib/memory-panel.js` + 真实 `lib/client.js` 样式 + 真实 React 18 UMD + Playwright 点击）
**36 PASS / 0 FAIL**。合计 **53 PASS / 0 FAIL**。运行中的桌面宿主仍执行第 4 轮代码，
所以本轮全部是 code-only 验证（§7）。

## 1. Captured bytes

| item | value |
|---|---|
| base commit | `101b3b59efd14ed6d9977618e022dcc05d199f5b` (v0.4.4) + 未提交工作树 |
| `lib/memory-panel.js` | blob `fe487240` · **3,571 行** · sha256 `4ff118a7…` |
| `lib/client.js` | blob `88393104` · **1,467 行** · sha256 `85cdb1c3…` |
| `lib/panel-route.js` | blob `163949ce` · **974 行** · sha256 `1972c016…` |
| `lib/panel-actions.js` | blob `29c07394` · **870 行** · sha256 `c9313e6b…` |
| `lib/index-db.js` | blob `70b1d7da` · **2,753 行** |
| index 快照（第 4 轮 `sqlite3 .backup`） | 8,060,928 B · 1,236 notes · sha256 `472abf1e…` |
| 真实 vault 副本 | `/tmp/vault-r4-57QdQ7`（只读；index 的 dataRoot 是 mktemp） |
| 371 天 overview 真实路由回答 | **14,138 B** · sha256 `608aae03…` · activity 371 天 973/142 |
| compact-hot preview / confirm | 800 B / 173 B |
| refresh-digest preview / confirm | 592 B / 312 B |
| 截图 | `scratch/panel-ux-round4/out/` 13 张 `r5-*.png` |

20 KiB 上限：14,138 B —— 余量 **6,342 B**（比第 4 轮的 13,910 B 多 228 B，因为每日采样
把 8 条 recent 换成 4 天 × 2 条、标题/日期更长；仍在 ceiling 内）。

## 2. Method

### 2.1 路由探针（真实路由 + 真实 index，loopback HTTP）

运行中的宿主是第 4 轮构建，打不到第 5 轮路由，所以
`probe-route-r5.mjs` 用**发布代码** `registerPanelRoute` 在 `127.0.0.1` 上起真实 HTTP 服务：

- index：把第 4 轮的 index 快照**复制到** `indexFilePath(vault 副本, mktemp dataRoot)` 算出的
  路径，再用发布入口 `openIndex()` 打开（refresh 只增量扫副本），`status.notes = 1236`。
- binding/sessions：与桌面形状一致；`services.admin` 的四张卡取自实时 payload，hot 状态
  按要求覆盖为 **used 5728 / capacity 9000 / trigger 6030**，queue 清空。
- 请求都走真实 `fetch` + 真实 route handler：`{sessionId, action, ...}`，带
  `content-type: application/json` 和 `x-obsidian-mem-panel: 1`（桌面代理会剥 Origin）。
- 产出的真实 preview/confirm envelope 直接作为**视图 fixture**（见 2.2），所以浏览器里
  渲染的不是手写形状，而是路由真的发过的那份 wire。

### 2.2 视图探针（真实视图 + 真实 React）

`build-r5-pages.mjs` 生成自包含页面：真实 `createMemoryViews` 模块、真实
`lib/client.js` 的 `/* panel-css:start */…end */` 切片、从安装的 app.asar 提取的宿主
tokens（含第 4 轮补的 `--dsw-alias-bg-overlay` / `--dsw-shadow-lv1`）、真实 React 18
UMD。页面内 `fetch` 被替换成按 `action/mutation/token` 分发的探针响应：

| scenario | payload | 断言 |
|---|---|---|
| overview 320/659 | `out/r5-overview-371.json`（真实路由回答） | 多日时间线 |
| overview-single-day 659 | 同一 envelope，但 recent 全部改成今天（合成最坏情况） | aggregate-only 兜底 |
| health-hot 659 | `r5-health-fixture.json`（live health + hot 覆盖 5728/9000/6030） | 整理热层 pre/sheet/inline 回执 |
| health-digest 659 | 同一 health fixture | 发布项目摘要 pre/sheet/inline 回执 |
| startup 659 | 第一次 overview POST 返回 **bodyless 404**，之后成功 | 启动竞态提示 + 重试后出图 |

`capture-r5-views.mjs` 用 Playwright 1.64.1 + `channel:"chrome"` headless（DPR 1）
真实点击按钮、等待 React 状态，读 DOM 文本/角色/截图。

## 3. Route probe 结果（17/17 PASS）

### 3.1 371 天 overview：wire 与 day-diverse recent

- HTTP 200，**14,138 B ≤ 20 KiB**（余量 6,342 B）；activity 仍是真实 371 天
  （2025-10-26 → 2026-10-31，created 973 / updated 142）。
- recent 数组 **4 个不同 updated 日 × 每天 2 条**（旧行为：8 条全在一天）：

| day | rows | activity total (created+updated) | titles |
|---|---|---|---|
| 2026-10-31 | 2 | 23 | 收件箱 / CI 在 Node 27.0.0 上 test/pack.test.js 失败 |
| 2026-10-30 | 2 | 12 | 习惯：块名放不下时换方案而非隐藏名字 / gotcha：index-stats 窗口级互斥让更新柱恒为 0 |
| 2026-10-29 | 2 | 10 | 0.3.x 相对 0.2.x 无需 vault 迁移 / 插件升级后按文件哈希与 import 解析校验 |
| 2026-10-28 | 2 | 7 | release workflow 自动完成版本发布流程 / digest 测试写死 2026-10-27 会让 CI 每天失败 |

采样上限符合代码约定：`RECENT_MAX_DAYS = 4`、`RECENT_PER_DAY = 2`、
`RECENT_SCAN_LIMIT = 500`（内部宽页）；wire 仍 ≤ 8 行，ceiling 不受影响。

### 3.2 不存在的 sessionId

`POST overview {sessionId:"session-does-not-exist-r5"}` → **HTTP 503**，
`error.code = "session-missing"`（旧行为 404：浏览器把它读成"路由未注册"并显示重启提示）。
消息保持泛化的 `memory panel unavailable`，不泄露宿主内部状态。

### 3.3 同源围栏（mutation 半）

| request | 结果 |
|---|---|
| 读，无 Origin | 200 |
| mutation，无 Origin 无 `x-obsidian-mem-panel` | **403** |
| mutation，无 Origin + panel header | **200**（围栏放行） |
| mutation，matching Origin（`http://127.0.0.1:<port>`） | **200** |
| mutation，mismatched Origin + header | **403** |

### 3.4 真实 preview/confirm wire

- compact-hot：preview 200（800 B）→ `warning: "热层暂未超过触发线（5728 / 6030 码点）：本次整理不会搬出任何条目。"`，
  facts `使用 5728 / 9000 码点`、`触发线 6030 码点`、`可搬出 14 / 可归档 14` + 三个分区行；
  confirm 200 → `{"status":"compacted","moved":0,"folded":0,"reclaimed":0,"used":5728,"capacity":9000,"trigger":6030}`。
- refresh-digest：preview 200（592 B）→ 目标 `_meta/digest.md`、窗口最近 1 天、
  新建 45 / 更新 5 / 检查来源 50；confirm 200 → `{"status":"updated","path":"Projects/dsh-obsidian-mem--05025725/_meta/digest.md","charCount":1625,...}`。

## 4. View renders（36/36 PASS）

### 4.1 最近变化多日时间线（overview 320 / 659，真实 payload）

两宽度都是 **4 个 group**，与 §3.1 的 wire 一一对应；页面无横向溢出：

| group | 320px | 659px |
|---|---|---|
| 今天 | 共 23 条 · 仅显示最近 2 条 · 2 rows | 同左 |
| 昨天 | 共 12 条 · 仅显示最近 2 条 · 2 rows | 同左 |
| 2026-10-29 | 共 10 条 · 仅显示最近 2 条 · 2 rows | 同左 |
| 2026-10-28 | 共 7 条 · 仅显示最近 2 条 · 2 rows | 同左 |

- 日总数来自 activity 序列（不是"2 条"）——和 digest 报告的一天 23 条一致。
- `documentElement.scrollWidth === innerWidth` 且 `.mem-view.scrollWidth === clientWidth`
  （320:320/320；659:659/659）。
- 截图：`out/r5-overview-timeline-320.png`、`out/r5-overview-timeline-659.png`、
  `out/r5-overview-top-{320,659}.png`。

### 4.2 单日采样的 aggregate-only 兜底（合成最坏情况）

把 recent 全部压到"今天"后：`今天` 出现 8 行、count `共 23 条`（来自 activity 序列，
而非 8）、hint `仅显示最近 8 条`；两个更早的活跃日作为 **aggregate-only group** 补上：
`昨天 共 12 条`（0 items、无 hint）、`2026-10-29 共 10 条`（0 items、无 hint）。
截图：`out/r5-overview-single-day-timeline-659.png`。

### 4.3 整理热层：pre 状态 → preview sheet → inline 回执（health 659）

- pre-click：热层卡 `.mem-hot-state` = **未到触发线（整理不会搬出条目）**（`.is-warn`），
  meter `5,728 / 9,000 字符`、meta `触发线 6,030`，无 `.mem-action-result`。
- 点击 `整理热层` → sheet 标题 整理热层、confirmLabel 整理热层、facts 含
  `使用 5728 / 9000 码点`、`触发线 6030 码点`、三个分区行；warning =
  `热层暂未超过触发线（5728 / 6030 码点）：本次整理不会搬出任何条目。`
- 点击 sheet 的 confirm（写入按钮）→ 真实 confirm wire `{status:"compacted", moved:0, ...}`
  被视图投影为热层卡内 `.mem-action-result`（`role="status"`、`aria-live="polite"`）：
  **`未搬出内容：热层 5,728/9,000 字符，未到触发线 6,030（超过触发线后才会归档条目） · 刚刚`**；
  sheet 关闭、按钮回到 `整理热层`。
- 截图：`out/r5-health-hot-pre-659.png`、`out/r5-health-hot-sheet-659.png`、
  `out/r5-health-hot-after-659.png`、`out/r5-health-hot-top-659.png`。

### 4.4 发布项目摘要：inline 回执（health 659）

点击 `发布项目摘要` → sheet 标题 发布项目摘要 / confirmLabel 写入摘要、目标
`_meta/digest.md`、窗口最近 1 天、新建 45 / 更新 5 / 检查来源 50；confirm 后
今日摘要卡内 `.mem-action-result`（role=status）：
**`摘要已更新：Projects/dsh-obsidian-mem--05025725/_meta/digest.md（1,625 字符） · 刚刚`**，
sheet 关闭。截图：`out/r5-health-digest-sheet-659.png`、`out/r5-health-digest-after-659.png`。

### 4.5 启动竞态：404 → 提示 → 重试出图（overview 659）

第一次 overview POST 返回 **bodyless 404**（页面 fetch stub），视图不显示"重启 DSH"的
fatal 文案，而是：

- `.mem-notice` 文本 = **记忆接口正在启动，正在重试…**
- `role="status"`、`aria-live="polite"`、class `mem-notice is-stale`，
  **没有** `role="alert"`；
- 约 1 s 后（`STARTUP_RETRY_MS = 1000`）第二次 overview POST 成功：371 个 heat cell、
  4 个 timeline group 全部渲染，提示消失，`window.__stubCalls` 恰好 2 次 overview。
- 截图：`out/r5-startup-notice-659.png`、`out/r5-startup-after-659.png`。

## 5. Checks summary

| lane | checks | result |
|---|---|---|
| route probe（373 wire / recent / 503 / fence / preview+confirm） | 17 | **17 PASS / 0 FAIL** |
| view renders（timeline 320/659 / single-day fallback / hot / digest / startup） | 36 | **36 PASS / 0 FAIL** |
| 合计 | **53** | **53 PASS / 0 FAIL** |

原始断言日志：`node probe-route-r5.mjs`、`node capture-r5-views.mjs`（下面 §6 的命令）；
证据 JSON：`out/probe-route-r5-report.json`、`out/capture-r5-report.json`。

## 6. Commands

```sh
cd /Users/yukisala/subject/dsh-obsidian-mem/scratch/panel-ux-round4
node probe-route-r5.mjs        # 真实路由 + index 快照：17 PASS / 0 FAIL
node make-r5-fixtures.mjs      # health fixture（hot 5728/9000/6030）+ 单日 fixture
node build-r5-pages.mjs        # 真实视图 + 真实 React 页面（5 个 scenario）
node capture-r5-views.mjs      # Playwright 点击/断言/截图：36 PASS / 0 FAIL
```

## 7. Artifacts（`scratch/panel-ux-round4/`，未提交）

- 探针：`probe-route-r5.mjs`、`make-r5-fixtures.mjs`、`build-r5-pages.mjs`、
  `capture-r5-views.mjs`、`r5-health-fixture.json`、`r5-overview-single-day.json`。
- 真实 wire：`out/r5-overview-371.json`（14,138 B）、`out/r5-compact-preview.json`、
  `out/r5-compact-confirm.json`、`out/r5-digest-preview.json`、`out/r5-digest-confirm.json`。
- 报告：`out/probe-route-r5-report.json`、`out/capture-r5-report.json`。
- 页面：`pages/r5-{overview-320,overview-659,overview-single-day-659,health-hot-659,health-digest-659,startup-659}.html`。
- 截图（13 张）：`out/r5-overview-timeline-{320,659}.png`、
  `out/r5-overview-top-{320,659}.png`、`out/r5-overview-single-day-timeline-659.png`、
  `out/r5-health-hot-{pre,sheet,after,top}-659.png`、
  `out/r5-health-digest-{sheet,after}-659.png`、
  `out/r5-startup-{notice,after}-659.png`。

## 8. Unverified

- **运行中的桌面宿主仍是第 4 轮代码**：本轮没有重装/重启，真实 Electron 侧栏里的点击
  未观察。所有断言针对工作树源码 + 真实 React/Chrome 渲染 + 真实路由 handler。
- **真实服务的 mutation 未执行**：compact/digest 的 preview/confirm 由真实
  `panel-actions` 代码生成，但 `services.admin` 的 hot compact / digest refresh 答案是
  按用户报告的数值构造的；真实 hot 文件与 digest 写入没有在本轮改动（只读验证）。
- **启动竞态的 404 是页面 stub 造的**（无法在真实宿主的 1 秒启动窗口内注入 404）：
  提示文案/role/重试出图逻辑真实，`~1 s` 是代码常量 `STARTUP_RETRY_MS = 1000` 的行为，
  未用墙钟精确计时。
- health fixture 取自实时宿主的 health payload（5,572 B 形状）后覆盖 hot 数字；
  retry-job 路径本轮未点击（queue 为空）。
- 单日 aggregate-only fixture 是合成的（真实 wire 已是 4 天采样）。
- DPR≠1、Windows/Segoe UI 字体、<320 或 >720 面板宽度未覆盖。
