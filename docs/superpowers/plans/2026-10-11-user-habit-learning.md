# User Habit Learning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让插件从跨回合的已提交证据中自动发现候选习惯、在长期不再出现时自动让它退出注入并归档，同时保留用户自行描述添加的习惯，且**不**把自动推导的结果直接当成用户偏好注入。

**Architecture:** 三个新模块分层承担：`habit-signals`（L0，纯函数，从已提交事件抽取封闭词表信号）、`habit-state`（L1，私有 JSON 状态 + 幂等衰减 + 状态迁移）、`habit-learning`（L3，计数与阈值，提升时调用既有 `applyCandidate`）。写笔记的路径完全复用既有事务/收据/jail；本功能不新增任何写入原语，不新增工具，不新增 frontmatter 属性。

**Tech Stack:** Node `>=22.22.2`、ES modules、`node:` 内置模块、`node:test`、既有 Standard Schema；**不增加运行时依赖**（仍是 `@deepseek-ai/schemastery` 与 `yaml`）。

**Spec:** [用户习惯的自动提炼、隔离与衰减设计](../specs/2026-10-11-user-habit-learning-design.md)

**Prior art:** [`research/habit-learning-prior-art.md`](../../../research/habit-learning-prior-art.md)

**状态：** 2026-10-11 文稿 **v2（Task 0 已完成，计划已按其结论修正）**。
**所有任务尚未执行；本文的 Expected 与代码片段是实施要求，不是通过记录。**
执行前先审阅设计与标定结果，不因本文件存在而自动开始实现。

**Task 0 已完成，结论是负面的：** [`docs/habit-learning-results.md`](../../habit-learning-results.md)。
它否证了 v1 的 `toolchain:`/`ecosystem:`/`workflow:` 信号族（**99.0% 的工具选择不是用户要求的**），
并把信号改为**用户自己的话的跨会话复现**。本计划已按此重写 Task 1/3，并新增 Task 8（衰减延后）。

---

## Global Constraints

1. `engines.node` 保持 `>=22.22.2`；不增加运行时依赖。
2. ES modules、`node:` 前缀、两空格、单引号、无分号；导出函数写 JSDoc。
3. 六个工具名与 `lib/tools.js` 再导出门面不变；**不新增 `mem_*` 工具**。
4. **§6.4 frontmatter 封闭词表不变**：只用 `status`（`provisional`/`active`/`archived`）、`assertion`（`observed`/`stated`）、`confidence`。**不新增属性名**（Obsidian 全库注册属性类型）。
5. **从不删除笔记**：只做状态迁移。
6. `_meta/user.md` **永不写入**。
7. 所有私有状态在 `resolveDataRoot()` 派生的数据根下；测试只用临时 vault / 临时 home / 临时 `DSH_HOME`，**绝不指向真实 vault**（`~/Documents/dsh-memory`、`~/.dsh/data/obsidian-mem/`）。
8. 信号**只存封闭词表的枚举值**：不存命令原文、绝对路径、工具输出正文、凭证。
9. 新模块登记进 `test/architecture.test.js` 的层级与预算，带 `// @ts-check` 的登记进 `tsconfig.json`。
10. 不修改真实 DSH/Codex 配置；不安装 Git hooks；`prepack` 仅验证；提交不含 `Co-Authored-By`。
11. 宿主事件与注入时机以 `docs/p0-compatibility.md` 为依据。

---

## 执行约定

工作目录 `/Users/yukisala/subject/dsh-obsidian-mem`。检查时 HEAD 为 `b3c20d1`（0.1.13），工作区干净；实施前重新核对。

- 先读 spec、`AGENTS.md`、`docs/p0-compatibility.md`，再查当前源码；本计划不替代当前源码。
- 本仓库 `npm test` **不接受附加测试参数**，且负责临时 `DSH_HOME`。所有红/绿命令用 `npm test`，**不要**在真实 home 跑裸 `node --test`。
- 每个任务以可独立运行的行为测试结束；先红后绿，两者都记录。
- 每次提交前只暂存本任务文件，跑 `npm run check:fast`、`npm run check`、`git diff --check`。
- `docs/` 与 `research/` 被 `.gitignore` 忽略；只有本任务确实新增/更新的文稿需要 `git add -f <精确路径>`，**不** force-add 整个目录。
- 不自动 push，不发布。

---

## 文件与责任

| 创建/修改 | 文件 | 单一责任与约束 |
| --- | --- | --- |
| 创建 | `lib/habit-signals.js` | **L0 / 200 行**；纯函数。对**用户消息文本**匹配封闭词表，产出标签。**不解析工具参数、不读工具输出**。无仓库 import、无 `node:` import（与 `failure-streak`、`note-style` 同为叶子） |
| 创建 | `lib/habit-state.js` | **L1 / 300 行**；私有 JSON 状态 IO、**幂等衰减**、状态迁移判定。纯逻辑 + 一次原子写；**不读 vault** |
| 创建 | `lib/habit-learning.js` | **L3 / 300 行**；**会话级**计数、阈值、提升为候选；调用既有 `applyCandidate` 路径 |
| 修改 | `lib/capture.js` | 在既有 `turn/end(completed)` 处理里接一个钩子；**不改变既有白名单投影** |
| 修改 | `lib/hooks.js` | 会话开始时跑一次衰减（与既有 lint 提示同一模式） |
| 修改 | `lib/brief.js` | `provisional` 的习惯**不进**注入（改 `isStaleEntry` 的判定集合） |
| 修改 | `lib/config.js` | `habitLearning` 配置块 + 范围校验 |
| 修改 | `lib/debug.js`, `lib/diagnostic-codec.js` | 封闭诊断计数；**不记录信号原文、路径、命令** |
| 修改 | `test/architecture.test.js`, `tsconfig.json` | 登记三个新模块 |
| 创建 | `test/habit-signals.test.js`, `test/habit-state.test.js`, `test/habit-learning.test.js` | 单元与边界 |
| 创建 | `test/habit-noise.test.js` | **噪声写入压力**下的误提升率（验收第 6 条） |
| 创建 | `test/habit-attribution.test.js` | **归属回归**：断言信号只来自 `source.kind === 'user'`，工具调用不得产生候选（验收第 8 条，v1 那个错误的回归测试） |
| 修改 | `test/brief.test.js`, `test/config.test.js`, `test/capture.test.js`, `test/hooks.test.js` | 隔离、配置、钩子回归 |
| 修改 | `README.md`, `README.zh.md`, `README.i18n.yaml`, `skills/obsidian-mem/SKILL.md`, `codex/marketplace/plugins/dsh-obsidian-mem/skills/obsidian-mem/SKILL.md`, `CHANGELOG.md` | 双语言/双技能同步；更新两侧 blob hash |
| 运行后创建 | `docs/habit-learning-results.md` | 只记录真实命令与结果，含未验证项 |

**三个新模块必须首次出现时就登记层级、预算、JSDoc、`// @ts-check` 与 tsconfig**，不能留到最后。

---

## Task 0：阈值标定 —— ✅ **已完成，结论是负面的**

**产出：** [`docs/habit-learning-results.md`](../../habit-learning-results.md)。
**探针：** `scratch/habit-calibration/*.cjs`（git-ignored，不进包，只读日志）。

它跑出来的是**否证**，不是确认：

| 原假设 | 实测 | 结果 |
|---|---|---|
| 工具频率信号能选出候选习惯 | `promoteAfter=3` → **149 个候选**（比 107 个回合还多），top 是 `bash→run_code`×72 | ❌ 过生成 |
| 这些信号反映用户的习惯 | **99.0%（291/294）** 的工具选择**不是用户要求的** | ❌ **测的是 agent** |
| 半衰期 30 天可标定 | 语料仅 67.9 天（2.26 个半衰期），且 `observed` 习惯笔记 **0 条** | ❌ 无对象 |

**由此产生的三项修正**（已落进设计 v2）：
1. **删除** `toolchain:`/`ecosystem:`/`workflow:` 信号族。
2. **改用**用户话语的跨会话复现：`>=3 会话` → 6 个候选，且现存 3 条真实习惯 **3/3 命中**。
3. **衰减延后**：作用对象是空集，先上候选管线。

**已定的数字：** `promoteAfter = 3`（**会话级**，不是回合级 —— 每会话可用回合中位数只有 2）。

**仍未定：** `halfLifeDays`。它现在**无法标定**，见 Task 8。

---

## Task 1：`lib/habit-signals.js` — 用户话语的词表匹配 —— ✅ **已完成**

**Files:** 创建 `lib/habit-signals.js`；创建 `test/habit-signals.test.js`

**Interfaces:**
- `export const BUILTIN_MARKERS = Object.freeze([...])` —— `{label, pattern}` 的封闭表
- `export function labelsFromUserText(text, extraMarkers = []) -> string[]`

- [ ] **红**：测试断言 —— **只接受用户消息文本作为输入**。函数签名里**没有** events/tools 参数，
      从类型上排除 v1 那个错误。这是验收第 8 条的实现面。
- [ ] **红**：测试断言 —— 未命中任何词表条目的文本返回 `[]`，**不猜、不兜底**。
      依据 Task 0：手写 12 条词表里 4 条命中 0 次，说明表达能力有限；
      `failure-streak.js` 的做法是 *"an unrecognised body contributes `unknown`, which is a poor query
      and an honest one."*
- [ ] **红**：测试断言 —— 输出**只有标签**（如 `提交`、`superpowers`），
      **不含用户原句、不含路径、不含空白**（对输出跑"无空白、长度有界、在词表内"的断言）。
- [ ] **红**：测试断言 —— 空串、`null`、非字符串、超长文本都不抛错。
- [ ] **红**：测试断言 —— `extraMarkers` 能追加条目；重复标签去重。
- [ ] **红**：测试断言 —— 词表里的正则都是**字面量**，没有可被用户文本触发的灾难性回溯
      （用一条 10 万字符的输入跑一次并设时间上界）。
- [ ] **绿**：实现。纯函数，无 `node:` import，无仓库 import。
- [ ] 登记 L0 / 200 行、`// @ts-check`、tsconfig、architecture 预算。

---

## Task 2：`lib/habit-state.js` — 幂等衰减与状态迁移 —— ✅ **已完成**

**Files:** 创建 `lib/habit-state.js`；创建 `test/habit-state.test.js`

**Interfaces:**
- `export const HALF_LIFE_DAYS = 30`
- `export const DEMOTE_BELOW = 0.5`
- `export const ARCHIVE_BELOW = 0.15`
- `export function decayScore({score, lastReinforcedAt, createdAt, lastDecayedAt, today, halfLifeDays}) -> number`
- `export function nextStatus({score, status, assertion, demoteBelow, archiveBelow}) -> string`
- `export async function readHabitState(dataRoot, vaultHash, projectId)`
- `export async function writeHabitState(...)`

- [ ] **红（幂等，本设计最重要的一条回归测试）**：`decayScore` 用
      `anchor = max(lastReinforcedAt, createdAt, lastDecayedAt)`，且 `0.5 ** (days / halfLife)`。
      断言：**同一天内连续调用 N 次，结果与调用一次相同**。
      这条直接对应 limbic 记录的 bug —— 只锚定 `last_retrieved` 会把同一段真实时间重复计费约 5 次，
      把 0.69 打到 0.036（**10× 的错误衰减**）。
- [ ] **红**：锚点取三者最新者；只有 `lastDecayedAt` 前进而其他不变时，二次调用衰减量为 0。
- [ ] **红（fail open）**：日期缺失 / 不可解析 / 非字符串 → 返回原 `score` 且**不抛错**，并记一次诊断。
      依据 mem0：*"A bad date never makes a memory silently vanish."*
- [ ] **红**：`nextStatus` —— `score < 0.5` 且 `active` → `provisional`；
      `provisional` 且 `score < 0.15` → `archived`；
      **`assertion === 'stated'` 时任何分数都不降级**（返回原 status）。
- [ ] **红**：`archived` 是终态，不会因为再衰减而变成别的状态。
- [ ] **红**：`halfLifeDays <= 0` 时衰减为恒等（limbic 的 kill switch 语义），不除零。
- [ ] **绿**：实现。私有 JSON 在 `resolveDataRoot()` 下，原子写（复用 `receipts.js:writeJsonAtomic` 或等价）。
- [ ] 登记 L1 / 300 行。

---

## Task 3：`lib/habit-learning.js` — 会话级计数与提升 —— ✅ **已完成**

**Files:** 创建 `lib/habit-learning.js`；创建 `test/habit-learning.test.js`

**计数单位是「会话」，不是「回合」。** Task 0 实测每会话可用回合中位数只有 **2**，
按回合计数会让同一会话内的重复表达被反复计费。

- [ ] **红**：同一会话内重复出现同一标签只计 1；跨 `promoteAfter`（默认 3）个**独立会话**才提升。
- [ ] **红**：提升时走既有 `applyCandidate`，产出笔记带
      `assertion: 'observed'`、`status: 'provisional'`、`tags` 含 `user-habit`，标题以 `习惯：` 开头。
- [ ] **红**：**提升不新增 frontmatter 属性** —— 断言写出的笔记属性名集合是 `OWNED_FIELDS` 的子集。
- [ ] **红**：重新观察到已提升的标签 → `score` 重置为 1.0、`lastReinforcedAt` 更新，
      **且不新建第二条笔记**（复用 `noteId`）。
      **注意：不自动 `provisional` → `active`。** 提升为 `active` 需要人工确认
      （设计 §3.1：隔离期的意义就是"决定未定时不影响回答"）。重新观察只刷新衰减时钟。
- [ ] **红（归属，验收第 8 条）**：构造一个只含 `tool/call` 事件、**没有用户消息**的回合，
      断言它**不产生任何候选、不写任何状态**。这是 v1 那个错误的回归测试。
- [ ] **红**：`habitLearning.enabled === false` 时完全不产生候选，也不写状态。
- [ ] **红**：凭证命中（`containsCredential`）的用户消息不参与匹配。
- [ ] **红**：子会话（`isRootSession` 为假）不计数。
- [ ] **红**：状态里**不落盘用户原句** —— 断言 JSON 里只有标签与计数，没有消息文本。
- [ ] **绿**：实现。**写路径不新增原语**，全部经既有 `applyCandidate` → `createMemoryWithId`。
- [ ] 登记 L3 / 300 行。

---

## Task 4：隔离 — `provisional` 不进注入 —— ✅ **已完成**

**Files:** 修改 `lib/brief.js`；修改 `test/brief.test.js`

- [ ] **红**：`buildBrief()` 对一条 `status: 'provisional'` 的 `习惯：…` 约定，
      在**任何区**都不输出（`conventions` 与 `preferences` 都断言）。
- [ ] **红**：同一条改成 `status: 'active'` 后**必须**出现在 `conventions`（证明前一条不是"什么都没输出"的假绿）。
- [ ] **红**：`provisional` **不加入** `SUPERSEDED_STATUSES`/`HISTORY_STATUSES`
      （它仍是当前记忆，只是不进注入）—— 断言 `mem_search` 仍能搜到它。
- [ ] **绿**：实现。在 `isStaleEntry` 的判定里加入 `provisional`，**不改** `note-health.js` 的
      `HISTORY_STATUSES`（那会同时把它排除出默认搜索，与"可审计"矛盾）。
- [ ] 更新 `lib/brief.js` 的模块注释，说明为什么隔离集与历史集是两个不同的集合。

---

## Task 5：接线（`capture.js` / `hooks.js` / `config.js`） —— ✅ **已完成**

**Files:** 修改 `lib/capture.js`, `lib/hooks.js`, `lib/config.js`；修改对应测试

- [ ] **红**：`config.test.js` —— `habitLearning` 五个键的默认值与范围校验；
      未知键仍被拒绝（沿用既有 `rejectUnknownKeys`）。
- [ ] **红**：`hooks.test.js` —— 会话开始时衰减**只跑一次**；失败不阻断绑定与简报。
- [ ] **红**：`capture.test.js` —— **既有白名单投影逐字节不变**（本功能不往 `safeInput` 里加任何东西）。
- [ ] **绿**：接线。捕获路径**同步短小**（`session/event` 是 fire-and-forget 通知），
      重活放 tracked promise；衰减在会话开始跑，不引入常驻定时器（沿用 §11 既有约束）。
- [ ] 诊断：加封闭 code，**不记录信号原文**。

---

## Task 6：噪声写入压力验收 —— ✅ **已完成，结果是 67% 误提升**

**产出：** `test/habit-noise.test.js`（4 个用例）+ [`docs/habit-learning-results.md`](../../habit-learning-results.md) §10。

TraceRetain 的结论是干净数据上看不见污染，所以专做了一次噪声验收。**它给出的数字不利，并改变了结论：**

| 语料 | 会话 | 结果 |
|---|---|---|
| 6 条真实偏好 × 5 会话 | 30 | **6/6 提升**（召回 100%） |
| 18 条偶发提及 × 1 会话 | 18 | **4/6 标签提升 = 67%** |

**这不是 bug，是机制的定义暴露了：** 计数器测词语复现，偏好只是它的子集。
两个独立会话各提一次同一个词，与一条偏好被说三次，在它看来完全一样。
Task 0 的标定看不到这一点（它统计词出现次数，从未区分偏好与提及）。

**验收因此不是"误提升率为零"，而是三件事：**

1. **召回成立** —— 75% 噪声下 6/6 真实偏好仍被提升（阈值不能高到什么都不学）。
2. **误提升率被测量且有上界** —— 实测 67%，上界 75%，钉在测试常量里。
3. **安全属性成立** —— **两个语料一视同仁**地断言：每条被提升的候选都是隔离态
   （`status: provisional` + `assertion: observed`），所以错一条的代价是审阅队列多一行，
   而不是简报里多一条错规则。

外加第 4 个用例：更高的阈值对同一语料提升**严格更少**，把这个旋钮的实际作用写成测量而非信念。

**决定：`promoteAfter` 保持 3**，召回优先，精度由隔离态承担。
改进方向（指令形状过滤）**未落地** —— 它是未标定的启发式，不在缺数据时加入。

**Files:** 创建 `test/habit-noise.test.js`

TraceRetain（arXiv 2606.29178）证明污染在干净数据上看不见，只有受控噪声下才显现。
**在整洁输入上跑通不构成任何证据。**

- [ ] 构造一个 fixture：`k` 个真实习惯信号 + `m` 个一次性干扰信号（比例参照论文的 75% 干扰项）。
- [ ] 断言：误提升率（干扰信号被提升为候选的比例）**有一个上界**，且把该上界**写成数字**记进
      `docs/habit-learning-results.md`。
- [ ] 断言：真实信号在同样的噪声下**仍被提升**（防止"阈值调高到什么都不提升"这种假绿）。
- [ ] 跑 `promoteAfter` 的敏感性：至少 2、3、5 三个取值，记录各自的误提升率与漏提升率。

---

## Task 7：文档与门禁 —— ✅ **已完成**

- [ ] `README.md` + `README.zh.md` 同步（一个提交里一起改），然后
      `git hash-object README.md README.zh.md` 把两个值写回 `README.i18n.yaml`。
      中文侧新增的链接目标要加显式 `<a id="english-slug">`。
- [ ] 两份便携技能同步：`skills/obsidian-mem/SKILL.md` 与
      `codex/marketplace/plugins/dsh-obsidian-mem/skills/obsidian-mem/SKILL.md`。
- [ ] `CHANGELOG.md` 的 Unreleased 段：写清**已实测**与**未验证**的边界，
      明确写出 **"技能使用偏好不在本功能范围内，因为实测 12/8,847 ≈ 0.14%"**。
- [ ] 跑 `npm run check` 与 `git diff --check`；`docs/` 新增文稿用 `git add -f <精确路径>`。
- [ ] `docs/habit-learning-results.md` 只记真实命令与输出，含未验证项。

---

## Task 8：衰减的**延后**验收（Task 0 的直接后果）

**Task 0 §6 实测：衰减当前没有作用对象。** vault 中标题以 `习惯：` 开头的笔记 9 条
（6 条 `stated`、3 条无 assertion），**`observed` 习惯笔记 0 条**；
而设计 §3.4 规定 `stated` 免疫衰减。且全部日志只跨 **67.9 天 = 2.26 个半衰期**，
`archive_below = 0.15` 需要 82 天，**不可达**。

- [ ] **实施顺序：Task 1–7 先上（信号 + 计数 + 隔离 + 接线）。衰减随其后。**
      不要先建一个空转的衰减器 —— 那会是一段没有测试对象、也无法验收的代码。
- [ ] Task 2（`habit-state.js`）**仍然要做**，但只做**单元测试**（合成输入）。
      它可以在候选管线产出真实 `observed` 笔记之前就绪。
- [ ] **`halfLifeDays` 暂用 30 并在代码与文档里标注"未标定"**，不得声称已验证。
- [ ] **衰减的验收推迟到**：候选管线已产出 ≥ 若干条真实 `observed` 习惯笔记，
      且它们的 `firstSeen` 距今 ≥ 一个半衰期之后。届时应重新跑一次 Task 0 形态的探针，
      用真实笔记的年龄分布标定 `halfLifeDays` 与 `demoteBelow`。
- [ ] 在 `docs/habit-learning-results.md` 追加一节记录这次延后验收的触发条件是否达成。

**Expected:** 一份明确的"衰减尚未验收"记录，而不是一个看起来通过了的假绿。

---

## 已知的未验证点（实施时必须先解决或显式记录）

1. ~~`promoteAfter` 无本仓库依据~~ → **Task 0 已标定：3（会话级）**，见 Task 0。
2. **`halfLifeDays = 30` 仍是外部来源，且当前无法标定**（作用对象为空集、语料仅 2.26 个半衰期）。
   **这是本计划现在最大的未验证点**，见 Task 8。
3. ~~`workflow:` 信号的顺序窗口~~ → **该信号族已被 Task 0 否证并删除**，问题消失。
4. **词表必然不完整。** Task 0 的 12 条手写词表里 4 条命中 0 次。
   "用户换一种说法就学不到"是**召回率的结构性上限，无法靠调参解决**；`markers` 是配置项。
5. **跨项目提升**（→ `Methods/`）本计划**不做**，留给既有显式 `promote`。
6. **"用户纠正 agent"作为衰减信号**：调研中**没有任何系统发表过量化结果**，本计划**不采用**。
7. **样本很小**：40 个根会话、178 条用户消息、6 个项目、67.9 天，且 **77% 的回合来自单个项目**。
   `promoteAfter = 3` 应在数据积累后重新标定。
