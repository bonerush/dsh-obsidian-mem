# 用户习惯的自动提炼、隔离与衰减设计

**日期：** 2026-10-11

**状态：** 设计草案 v2（**已按 Task 0 标定修正**）。**尚未实施，没有任何通过记录。**
本文的接口与阈值是实施要求，不是验收证据。

**⚠️ v2 的关键修正：** 初稿 §4.1 的 `toolchain:`/`ecosystem:`/`workflow:` 信号族**已被实测否证并删除**。
Task 0 在真实日志上回放发现：**99.0% 的工具选择不是用户要求的**（291/294），
计数工具调用测的是 **agent 的默认行为**，不是用户的习惯。详见
[`docs/habit-learning-results.md`](../../habit-learning-results.md) §5。

**调研依据：** [`research/habit-learning-prior-art.md`](../../../research/habit-learning-prior-art.md)
（Mem0 / LangMem / Zep / Letta / limbic / ECC / ExpeL / CAPTURE 等 13 个系统的源码级对照）。

**标定依据：** [`docs/habit-learning-results.md`](../../habit-learning-results.md)
（本机 137 个会话日志、40 个根会话、107 个可用回合、178 条真实用户消息的只读回放）。

**范围确认：** 用户要求三件事 —— (1) 习惯可**自动**提炼；(2) 长期不再出现的习惯可**自动剔除**；
(3) 用户仍可自行描述添加。本设计只做这三件，不改六个工具名，不改 frontmatter 封闭词表，不新增运行时依赖。

**基线：** 检查时 HEAD 为 `b3c20d1`（0.1.13）。实施前重新核对 HEAD 与工作区。

---

## 1. 问题与现状

### 1.1 现状（源码核对）

| 能力 | 现状 | 位置 |
|---|---|---|
| 用户**陈述**的习惯自动入库 | ✅ 已有 | `lib/distill.js` 的 `习惯：` 前缀 + `habit-not-stated` 拒绝 + `user-habit` 标签 |
| 用户**自己写**的习惯 | ✅ 已有，只读 | `_meta/user.md`，`lib/vault.js:userTemplate()` 建模板，插件永不改写 |
| 模型**观察**到的习惯 | ⚠️ 只有"请 agent 自己 `mem_write`"这条**手工**路径 | `skills/obsidian-mem/SKILL.md` §3.1 |
| 习惯的**衰减 / 剔除** | ❌ **完全没有** | —— |

`SKILL.md` 原文：*"The automatic pipeline cannot take this step, because one completed turn cannot show a
pattern; that is why it is yours and why the user should be the one to confirm it."*

**这句话是对的，但它把问题推给了人。** 用户要的正是让这个"跨回合的模式"由插件来发现。

### 1.2 为什么不能简单地"让模型写习惯"

这是本次调研最重要的一条，必须写在设计最前面。

- **Manufactured Confidence**（[arXiv 2606.29279](https://arxiv.org/abs/2606.29279)）实测：LLM 归并会把
  一句含糊表述改写成一句自信的断言，mem0 与 LangMem 都是 **100%（5/5 措辞）**，逐字存储的对照组是 **0%**。
  下游 agent 依据的是**措辞的自信度而不是来源**：自信措辞的未授权授予率 **0.81**，含糊措辞 **0.00**。
  论文结论：*"The defense must live in the store, not the agent."*
  并且**事后标注被证明无效**：被动标记 "unverified" 对计算不可见；主动 distrust 指令把
  false-escalation 拉到 1.00，是"放弃判断"而不是"分辨"。
- **When Memory Becomes Authority**（[arXiv 2608.01679](https://arxiv.org/abs/2608.01679)）实测
  7 种归并器 × 7 个底座，**49 组里 48 组**发生 authority collapse；崩塌记忆导致 **50.3%** 未授权动作率；
  把权威标签持久化后 **16.9% → 0.0%**，良性成功率不变。
- **本仓库自己已经踩过这个坑**：`docs/habit-extraction-validation.md` 记录，真实模型把**项目规矩**
  标成了个人习惯（2/2 次），加一句话才修好。

→ **结论：自动化的产物不能直接是"习惯"，只能是"隔离态候选"。** 见 §3。

### 1.3 关键实测：技能信号几乎不存在

在 80 个真实会话、**8,847 次工具调用**中：

| 信号 | 次数 |
|---|---|
| `skill` 工具被直接调用 | **1** |
| `skill` 经嵌套 PTC 路径调用 | 11 |
| 注入的 skill 目录条目 | 12 次注入，单次最多 **319 条** |

**≈ 0.14%。** agent 看得到几百个技能，几乎从不调用 `skill` 工具。

→ **本设计明确不承诺学习"技能使用偏好"。** 用户提到"识别用户怎么使用技能和框架"，
其中**框架/工具链**是可观测的（`node` 638、`python3` 600、`npx` 283、`npm` 249；
`js` 1709、`md` 440、`mjs` 96），**技能调用不是**。这个边界必须写进文档，不能靠实现时的乐观假设。

另一个实测陷阱：用户消息的 `source.kind` 里，注入的上下文（`plugin:obsidian-mem` 48、
`agent-instructions` 32、`runtime-context` 24、`skill-catalog` 12）**多于**真实用户消息（`user` 40）。
任何"用户行为"统计**必须先按 `source.kind === 'user'` 过滤**。

---

## 2. 设计目标与非目标

### 2.1 目标

1. **自动提炼**：插件自己从跨回合、跨会话的已提交证据里发现候选习惯，**不需要**模型在提炼时凭空断言。
2. **自动剔除**：一个长期不再被观察到的习惯，能自动退出注入，并最终归档；**不删除**。
3. **用户主导**：用户仍可自行描述添加；用户的显式陈述**永远**压过自动推导。
4. **可审计**：每一次提升、每一次降级、每一次剔除都有确定性的、可复现的理由。

### 2.2 非目标

- 不学习"技能偏好"（§1.3 实测不支持）。
- 不自动写入 `_meta/user.md`（§6.2 的既有硬边界，不变）。
- 不新增 frontmatter 属性名（§6.4 封闭词表，Obsidian 全库注册属性类型）。
- 不新增第七个 `mem_*` 工具。
- 不引入 embedding、向量库或新的运行时依赖。
- 不调用 LLM 做**衰减**判定（ExpeL 证明剪枝路径可以完全确定性）。

---

## 3. 核心机制：隔离候选 + 确定性计数 + 幂等衰减

三个机制各解决一个问题，互不替代。

### 3.1 隔离态（quarantine）：解决"自动提炼会不会污染"

借自 CAPTURE（[arXiv 2609.02265](https://arxiv.org/abs/2609.02265) §3.3），原文：

> *"A quarantined node is written into the ledger and decays like anything else, but it is
> **flagged non-retrievable**, so the selector cannot see it and it cannot influence a response."*
> *"…so it never influences a response while the decision is pending."*

映射到本仓库：

- 自动推导出的候选习惯，写入 `Conventions/习惯：<…>.md`，`assertion: observed`，
  **`status: provisional`**，打 `user-habit` 标签。
- **`provisional` 的习惯不进简报的「用户习惯」区。**
  依据：`lib/brief.js:isStaleEntry()` 已经按 `status` 决定约定目录条目是否注入；
  本设计把 `provisional` 加入**不注入**集合（但**不**加入 `SUPERSEDED_STATUSES`，
  因为它是待定而不是历史）。
- 隔离期内它**可以被 `mem_search` 搜到**（可审计、可人工提升），但**不会**作为行为指令进入上下文。

**这是与"直接写习惯"的关键区别，也是唯一能同时满足"自动化"与"防污染"的形状。**

### 3.2 确定性计数：解决"怎么算一个模式"

**不使用 LLM 判断"这是不是习惯"。** 使用可复现的计数：

- 每次一个**真实用户回合**（`source.kind === 'user'`）结束，从该回合已提交的工具事件里抽取
  **信号**（§4），与已有候选比对。
- 同一条候选被**独立回合**观察到第 N 次（**N 默认为 3**），从 `provisional` 提升为 `active`。
- **必须跨回合，不能同一回合重复计数** —— 一个回合里跑 50 次 `npm test` 只算 1 次。
  这直接对应用户原话"一个完成回合不能显示模式"。
- **计数与阈值都在代码里**，不在 prompt 里（ExpeL 的计数器也从不展示给 LLM）。

阈值 3 的依据：ExpeL 的 `+2 add / +1 agree` 意味着一条规则需要独立佐证才能存活；
CAPTURE 要求"repeated high-confidence evidence rather than a single assertion"，
并明说 *"which is what stops one sentence from redefining a user"*。

### 3.3 幂等衰减：解决"怎么自动剔除"

**形态直接借用 limbic `trust.py:apply_decay`，包括它记录的 bug。**

```
anchor      = max(last_reinforced_at, created_at, last_decayed_at)   // 三者最新
days_since  = (today - anchor) 的天数
new_score   = score * 0.5 ** (days_since / half_life_days)
```

四个必须照抄的细节，每一个都有实测理由：

1. **锚点是三者中最新者。** limbic 的 docstring 记录了只锚定 `last_retrieved` 的后果：
   *"the same 27 days of real time were charged ~5 times, driving a healthy 0.69 to 0.036
   (**10x the correct decay**)"* —— 因为衰减每回合都跑。**`last_decayed_at` 是幂等的来源。**
2. **`half_life_days = 30`。** limbic 默认 30；其引用的 Microsoft《Human-Inspired Memory Architecture》
   给出 *"decay half-life ~29 days optimal for production"*。取 30，不自己发明。
3. **衰减是排序/状态信号，不是过滤器。** mem0 的 `decay` 明确 "a soft ranking bias, **never a filter**"，
   乘数钳在 `[0.3, 1.5]`。**本设计里分数只决定"要不要退出注入"，从不直接删除任何笔记。**
4. **坏数据 fail open。** mem0：*"A bad date never makes a memory silently vanish."*
   日期缺失或不可解析 → 本次不衰减，记一条诊断。

**状态迁移（确定性，无 LLM）：**

| 条件 | 动作 |
|---|---|
| `score < demote_below`（默认 **0.5**，即约一个半衰期无强化） | `active` → `provisional`（**退出注入**，仍可搜索） |
| `provisional` 且 `score < archive_below`（默认 **0.15**） | `provisional` → `archived`（**归档，不删除**） |
| 任何时刻被重新观察到 | `score` 重置为 1.0，`last_reinforced_at` = 今天；`provisional` → `active` |
| 用户显式陈述 | `assertion: stated`，**不受衰减约束**（见下） |

`archive_below = 0.15` 取自 CAPTURE 的地板 `phi = 0.15`（其隔离率 0.135/天、14 天降到约 0.15）。

**为什么"归档"而不是删除**：本仓库既有规则就是「取代而非覆盖，**不删除旧笔记**」
（`docs/superpowers/specs/2026-09-23-…-design.md` §6.3）；
Graphiti 用双时间轴从不删除；MeClear 明确反对永久覆写
（*"permanent database overwrites prone to catastrophic cross-task performance regression"*）；
ForgetForge 到 Cold 也是归档。`archived` 已在 §6.4 状态词表里，**无需新增属性**。

### 3.4 用户陈述的习惯不衰减

`assertion: stated`（用户自己说的）**永不自动降级**。理由：
(a) 用户显式陈述是最高权威，本仓库既有规则就把它排在 `_meta/user.md` 之下、其他一切之上；
(b) 我们的证据是"用户说过"，而"用户后来不常提起"**不是**反证；
(c) 用户要的是"自动剔除**记录的动作**越来越少的习惯"，那正是 `observed` 的语义。

用户想移除一个 stated 习惯时，走既有的 `supersede` 路径（用户自己说"不再这样"）。
**这不是本设计新增的能力，是既有能力。**

---

## 4. 信号：只从已提交证据抽取

### 4.0 被否证的信号族（v1 的 §4.1，已删除）

v1 曾提议从工具调用抽取三族信号：`toolchain:<name>`（bash 首 token）、
`ecosystem:<ext>`（文件扩展名）、`workflow:<a>→<b>`（相邻工具序列）。

**Task 0 在真实日志上否证了它们。** 见 [`docs/habit-learning-results.md`](../../habit-learning-results.md)：

| 检验 | 结果 |
|---|---|
| `promoteAfter=3` 产出的候选数 | **149**（比 107 个可用回合还多）—— 过生成 |
| top 候选 | `workflow:bash→run_code`×72、`run_code→bash`×70、`toolchain:ls`×39 —— 机械信号 |
| 出现在 ≥50% 会话中的信号 | 12 个 —— 是这个插件的工具链形状，不是任何用户的习惯 |
| 只出现在单个项目中的信号 | **205/341（60%）** —— 项目属性 |
| **工具选择中未被用户要求的比例** | **99.0%（291/294）** |

最后一行是决定性的。测法：对每个回合，检查 agent 运行的每个工具是否在**该回合用户自己的消息**里被点名。

| 工具 | 用户点名 | agent 自行选择 |
|---|---|---|
| grep | 0 | 78 |
| git | 0 | 63 |
| python3 | 0 | 27 |
| curl | 0 | 21 |
| **合计** | **3** | **291** |

**计数工具调用，测的是 agent 的默认行为。** 它跨所有用户都是常数，对"这个用户是谁"零信息量。
按 v1 实现，会产出一个充满「习惯：使用 bash 和 run_code」这类同义反复的记忆库 ——
而且它在干净数据上**看起来是成功的**（149 条候选"有产出"）。

**已排除"因为没装所以没用"这个替代解释：** `rg` 已安装（15.1.0）却 grep:rg = 2012:2；
`pnpm` 已安装（11.22.0）却 npm:pnpm = 303:4。所以那些确实是真实的选择 ——
**只不过是 agent 做的选择。**

### 4.1 采用的信号：用户自己的话（跨会话复现）

唯一属于用户的信号是**用户说出口的持久指令**。
Task 0 用 12 条"持久指令"词表扫 178 条真实用户消息：

| 指令 | 会话数 | 项目数 |
|---|---|---|
| 提交（及时提交） | 18 | 3 |
| 规格与计划 | 10 | 3 |
| superpowers | 9 | 2 |
| 解释原因 | 5 | 4 |
| 中文回答 | 3 | 2 |
| 简洁 | 3 | 1 |

**≥3 会话复现的 6 个；跨 ≥2 项目的 5 个。**

**外部效度交叉验证：** vault 的 `Methods/` 里有 3 条真实的跨项目习惯（用户已确认），
**3/3 全部落在该信号集内**：

| 现存 Methods 习惯 | 对应信号 |
|---|---|
| 习惯：重大改动必须提交，小改动勤提交 | 提交（18 会话） |
| 习惯：产出文档按 superpowers 形态与规格书写 | superpowers / 规格与计划（9 / 10） |
| 习惯：任务工作流优先参考 superpowers | superpowers（9） |

**与既有 `习惯：` stated 路径不重复：** 既有的要求模型在**单回合**内注意到并输出；
本路径发现的是**单个回合无法显示的跨会话复现** —— 正是 `SKILL.md` 说的那个空缺。

**与工具信号的对比：**

| | 工具频率信号（已删） | 用户话语信号（采用） |
|---|---|---|
| `promoteAfter=3` 候选数 | 149 | **6** |
| top 候选 | `bash→run_code`（72 回合） | 提交（18 会话） |
| 归属 | agent（99% 非用户要求） | **用户（逐字）** |
| 证据可引用 | 否 | **是（就是用户原话）** |

**信号载体：** 用户消息文本本身（`capture.js` 已投影，且已过 `containsCredential`）。
本设计**不新增任何对工具参数或输出的读取**。

### 4.2 必须的过滤

1. **`source.kind === 'user'`**：只有真实用户消息参与计数（§1.3 实测）。
2. **根会话**：沿用 `isRootSession()`，子 agent 不计数。
3. **凭证扫描**：沿用 `containsCredential()`；命中的消息整条跳过。
4. **只存归一化标签**：状态里存的是**词表条目的 slug**（如 `提交`、`superpowers`），
   **不存用户原句**。原句留在会话日志里，需要引用时由人去看。
   这与 §10.3「不把原始对话写进收据」一致。

### 4.3 存哪里

**`$DSH_HOME/data/obsidian-mem/habits/<vaultHash>/<projectId>.json`**，与 `pending/`、`curation/`
同级，走既有 `resolveDataRoot()`。理由：这是**可重建的推导状态**，不是 vault 内容；
vault 里只放提升后的笔记。与「vault 永远不是插件的暂存空间」一致。

计数字段：`{label, sessions, firstSeen, lastReinforced, lastDecayed, score, noteId}`。
**计数单位是「会话」而不是「回合」** —— 实测每会话可用回合中位数只有 2（Task 0 §1），
按回合计数会让同一会话内的重复表达被反复计费。`noteId` 在提升时回填，使衰减能定位到要改状态的笔记。

**词表是封闭的，且必须可增长地维护。** 它无法覆盖所有习惯表达 ——
Task 0 的手写 12 条词表就是证据（其中 4 条命中 0 次）。词表是配置的一部分（§9），
未命中的表达**不产生信号**，而不是被猜成一个信号。这是 `failure-streak.js` 的同一种做法：
*"an unrecognised body contributes `unknown`, which is a poor query and an honest one."*

---

## 5. 数据流

```
session/event: turn/end(completed)          ← 既有钩子，capture.js 已在此处工作
  → 该回合是否有真实用户消息？               ← 没有则完全跳过
  → 对每条用户消息匹配封闭词表（无原文落盘）  ← 新增，纯函数
  → 更新习惯状态（会话级计数 / 幂等衰减）     ← 新增，纯函数 + 一次原子写
  → 会话数达阈值？ → 写 provisional 笔记     ← 走既有 applyCandidate 路径
  → 用户陈述？   → stated 笔记（既有路径不变）
```

**衰减在什么时候跑**：不引入常驻定时器（§11 既有约束：*"v1 不实现常驻定时器"*）。
衰减在**每次会话开始的绑定解析之后**跑一次，与 `mem_admin(action="lint")` 的"距上次 >7 天则提示"
是同一套"会话开始时顺带"的模式。幂等锚点保证跑多跑少结果一致。

**但衰减当前无作用对象**（Task 0 §6）：`observed` 习惯笔记为 0 条，且 `stated` 按 §3.4 免疫。
实施顺序因此是：**先上候选管线（信号 + 计数 + 隔离），衰减随其后** ——
而不是反过来先建一个空转的衰减器。

**注入时**：`lib/brief.js` 的 `preferences` 区（`_meta/user.md`，用户自己写的，不变）
与 `conventions` 区（项目约定目录）都已存在。**`provisional` 的习惯不进任何一区。**
`active` 的习惯本来就在 `Conventions/index.md` 里，走既有 `isStaleEntry()` 路径。

---

## 6. 与既有不变量的关系

| 既有规则 | 本设计如何遵守 |
|---|---|
| §6.4 frontmatter 封闭词表（17 个属性） | **不新增属性**。复用 `status`（`provisional`/`active`/`archived`）、`assertion`（`observed`/`stated`）、`confidence`、`review_after` |
| 「不删除旧笔记」 | 只做状态迁移，从不删除、从不移动 |
| `_meta/user.md` 只读 | 完全不碰 |
| vault 不是暂存空间 | 状态在 `$DSH_HOME/data/` |
| 六个工具名不变 | 不新增工具 |
| 无 `Co-Authored-By` | — |
| 路径 jail / 源哈希校验 / 项目过滤 | 提升走既有 `applyCandidate` → `createMemoryWithId`，全部继承 |
| 新模块登记层级与预算 | §8 列出 |

---

## 7. 验收标准（含"必须构造噪声"这一条）

TraceRetain（[arXiv 2606.29178](https://arxiv.org/abs/2606.29178)）证明：
*"pollution does not appear naturally at these horizons"* —— 干净数据上各策略差异落在置信区间内，
只有 75% 干扰项的受控压力下才显现（Precision@5 从 20.2% 掉到 12.4%）。
**所以本功能的验收必须在噪声写入压力下做，否则"跑通了"不构成任何证据。**

1. **确定性**：同一输入序列跑两次，状态迁移与结果笔记逐字节相同。
2. **幂等**：同一天内重复跑衰减 N 次，`score` 与只跑一次相同（limbic 的 10× bug 的回归测试）。
3. **隔离**：`provisional` 习惯不出现在 `buildBrief()` 的任何区。
4. **不可删除**：衰减到 `archived` 后文件仍在原路径，正文逐字节未变。
5. **stated 免疫**：`assertion: stated` 的习惯在任意长的时间跨度后仍为 `active`。
6. **噪声压力**：在注入干扰信号的 fixture 下，误提升率有上界，且**有数字**。
7. **真红/真绿**：每条行为先有失败测试，再有通过测试，两者都记录。
8. **归属**（Task 0 新增）：断言信号只来自 `source.kind === 'user'` 的消息；
   任何来自工具调用的输入都不得产生候选。这是对 v1 那个错误的回归测试。

### 7.1 Task 6 结果（2026-10-11 已执行）——**第 6 条验收给出了一个不利的数字**

实现完成后跑了噪声压力验收，**它改变了结论**，所以结果记在这里而不是只留在测试里。

| 语料 | 会话 | 结果 |
|---|---|---|
| 6 条真实偏好 × 5 会话 | 30 | **6/6 提升**（召回 100%） |
| 18 条偶发提及 × 1 会话 | 18 | **4/6 标签被提升 = 67%** |

第 6 条要求"误提升率有上界且有数字"。**目前的数字是 67%，上界钉在 75%**
（`test/habit-noise.test.js` 的 `MAX_FALSE_PROMOTION`，并附实测值）。

**原因是定义层面的，不是调参能修的：** 计数器测的是**词语复现**，偏好只是它的**子集**。
§7 的 Task 0 标定统计的是"每个词出现在多少会话"，从未区分偏好与提及 ——
`提交` 的 18 个会话里既有「以后改动完就提交」也有「把这段提交了吧」。
阈值救不了：常见词终究会复现；bar=9 能滤掉全部偶发语料，但也丢掉真实的
`解释原因`(5)、`中文回答`(3)、`简洁`(3)。

**决定：`promoteAfter` 保持 3（召回优先），精度由 §3.1 的隔离态承担。**
被误提升的候选内容仍然为真（"插件在 3 个会话里看到过这个词"），错的只是把它读作偏好；
代价是审阅队列里多一行，而不是简报里多一条错规则。SAFETY 用例对**真提升与误提升一视同仁**地断言了隔离。

**未做但指向明确：** 真实历史里的误提升率没有被测量（需要人工标注真实消息）。
改进方向是**指令形状过滤**（偏好多为一般性表述「以后…」「一律…」，偶发提及多指向具体对象「把这段…」），
但**它是一条未标定的启发式，本次不落地** —— 本轮已因"留了一条从不命中的词表条目"删过一次，
不在缺数据时再加一条。
**⚠️ 衰减的两条验收（第 2、4 条）当前无法完成。** Task 0 实测：
vault 中 `observed` 的习惯笔记 **0 条**（标题以 `习惯：` 开头的 9 条里，6 条 `stated`、3 条无 assertion），
且全部会话日志只跨 **67.9 天 = 2.26 个半衰期**（`archive_below = 0.15` 需要 82 天，不可达）。
**衰减的验收必须推迟到候选管线真正产出 `observed` 笔记之后，用当时的数据标定。**
在那之前，衰减只能做**单元测试**（合成输入），不能声称在生产数据上验证过。

---

## 8. 模块与预算（预估，实施时按实测调整）

| 新建 | 层级 | 预算 | 责任 |
|---|---|---|---|
| `lib/habit-signals.js` | L0 | 200 | 纯函数：对用户消息文本匹配封闭词表，产出标签。**不读工具参数** |
| `lib/habit-state.js` | L1 | 300 | 私有状态 IO、幂等衰减、状态迁移（无 vault 访问） |
| `lib/habit-learning.js` | L3 | 300 | 会话级计数、阈值、提升为候选；调用既有 memory 路径 |

`habit-signals.js` 的预算从 300 降到 200：v2 不再解析工具参数与命令，只做词表匹配。

修改：`lib/capture.js`（接一个钩子）、`lib/hooks.js`（会话开始跑衰减）、
`lib/brief.js`（`provisional` 不进注入）、`lib/config.js`（新增开关）、
`test/architecture.test.js`、`tsconfig.json`。

**全部新增模块为纯函数或私有状态，不碰 vault 写入路径** —— 写笔记仍只经 `applyCandidate`。

---

## 9. 配置（全部有默认值，可关）

```js
habitLearning: z.object({
  enabled:      z.boolean().default(true),   // 关掉即完全不产生候选
  promoteAfter: z.number().default(3),       // 独立【会话】数阈值（Task 0 标定，见下）
  markers:      z.array(z.string()).default([]), // 追加词表条目；空 = 用内置词表
  halfLifeDays: z.number().default(30),      // limbic / Microsoft 的实测值；当前未标定
  demoteBelow:  z.number().default(0.5),     // 约一个半衰期
  archiveBelow: z.number().default(0.15),    // CAPTURE 的 phi
})
```

沿用 `config.js` 既有的"未知键拒绝"与范围校验风格。

**`promoteAfter = 3` 现在是标定过的**（Task 0 §7）：在用户话语信号上，`>=3 会话` 给出 **6 个候选**，
`>=9` 给出 2 个。阈值取**偏低以保召回**，精度交给隔离态与人工确认 —— 这正是 CAPTURE 的
quarantine 设计意图。`>=2` 会引入只出现两次的弱信号（实测"先调研"仅 2 次）。

**`markers` 是配置的一部分，因为词表必然不完整。** Task 0 的手写 12 条里 4 条命中 0 次，
说明表达能力有限。用户可追加；未命中的表达**不产生信号**。

---

## 10. 未解决 / 需要实施时验证的问题

1. ~~`promoteAfter` 没有实测依据~~ → **已由 Task 0 标定为 3（会话级）**，见 §9。
2. **`halfLifeDays = 30` 仍是外部来源，且当前无法标定。** 语料只跨 67.9 天（2.26 个半衰期），
   且 `observed` 习惯笔记为 0 条。**这是本设计现在最大的未验证点**（从 `promoteAfter` 转移过来）。
3. **词表必然不完整。** Task 0 的 12 条手写词表命中 4 条为 0。它是配置项（§9），
   但"用户换一种说法"就学不到 —— 这是召回率的结构性上限，**无法靠调参解决**。
4. **跨项目提升**（项目习惯 → `Methods/`）本设计**不做**，留给既有的显式 `promote`。
   ECC 的自动提升阈值是 `avg >= 0.8` 且出现于 `>=2` 个项目，可作后续依据。
5. **没有量化过"用户纠正 agent"作为衰减信号的效果** —— 调研中**没有任何系统发表过这个数字**。
   本设计**不采用**该信号，因为无依据。
6. **样本很小**：40 个根会话、178 条用户消息、6 个项目、67.9 天，且 77% 的回合来自单个项目。
   所有比例区间很宽，`promoteAfter = 3` 应在数据积累后重新标定。

---

## 11. 被明确拒绝的方案及理由

| 方案 | 拒绝理由 |
|---|---|
| 让提炼器直接输出 `习惯：` 的 `observed` 条目 | Manufactured Confidence 与 AuthMem-Bench 各自独立测量了这条路径；本仓库 `habit-not-stated` 已是同一结论的实现 |
| 从 `skill` 工具调用学"技能偏好" | 实测 12/8,847 ≈ 0.14%，学到的会是噪声 |
| 从工具调用学"工具链偏好"（**v1 的方案**） | **Task 0 实测否证**：99.0%（291/294）的工具选择不是用户要求的，测的是 agent 的默认行为。见 §4.0 |
| 用 LLM 判断"这个习惯过时了吗" | ExpeL 证明剪枝可完全确定性；LLM 判定不可复现、不可审计，且要花钱 |
| 到期直接删除笔记 | 违反本仓库「不删除旧笔记」；MeClear 反对永久覆写；Graphiti 从不删除 |
| 只写在 prompt 里的衰减 | **ECC 的实测教训**：文档写了 `-0.02/week`，全仓库没有任何代码降低过 confidence |
| 给 stated 习惯加固定豁免层 | limbic 实测：固定/豁免机制产生 **79% 饱和**（182/231 被固定），且固定状态能扛过纠正、清零后 30 小时重新长回。*"There is no exemption class."* 本设计的 stated 豁免是**语义性**的（用户说过就是权威），不是"分数不再衰减"的固定层 |
