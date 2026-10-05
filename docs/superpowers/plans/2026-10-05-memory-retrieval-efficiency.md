# Memory Retrieval Efficiency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不引入模型、不修改源记忆的前提下，降低检索输出与自动注入的冗余，同时保持来源验证、项目隔离和旧工具兼容性。

**Architecture:** Markdown 是唯一内容权威，SQLite 是可重建的小节与词法索引。共享 `lib/` 提供局部读取、预算组织、组合检索、查询规划与版本去重，DSH/Codex 仅适配宿主协议。首个发布保持 legacy 默认，focused 显式开启，语义检索不进入本计划。

**Tech Stack:** Node `>=22.22.2`、ES modules、`node:sqlite`/FTS5、现有 CJK tokenizer、`node:test`、现有 Standard Schema/DSH 与 Codex MCP；不增加运行时依赖。

**Spec:** [记忆检索与上下文消耗优化设计](../specs/2026-10-05-memory-retrieval-efficiency-design.md)

**状态：** 2026-10-05 文稿，所有任务尚未执行；本文的 Expected 和代码片段是实施要求，不是通过记录。用户已确认首版无需模型，语义检索为后续阶段。执行前先审阅设计与计划，不因本文件存在而自动开始实现。

## Global Constraints

1. `engines.node` 保持 `>=22.22.2`，不增加运行时依赖；运行时依赖仍是 `@deepseek-ai/schemastery` 和 `yaml`。
2. ES modules、`node:` 内置模块、两空格、单引号、无分号；导出函数写 JSDoc。
3. 六个工具名称及 `lib/tools.js` 再导出门面保持不变。旧调用的输入语义和返回形状保持兼容，包括指定旧 `section` 时的旧全文结果。
4. 所有缓存和会话状态在 `resolveDataRoot()` 派生的数据根下。测试和探针只使用临时 vault、临时 home、临时 `DSH_HOME`；不读取真实 vault 做评测。
5. 不修改真实 DSH/Codex 配置；不安装 Git hooks；`prepack` 仅验证。提交不含 `Co-Authored-By`。
6. `README.md` 与 `README.zh.md` 同步，更新 `README.i18n.yaml` 的两侧 blob hash；两份便携技能同步描述工具新参数。
7. 索引、整理视图和召回缓存不能授权源笔记修改。历史引用是数据，当前用户指令优先。
8. 源哈希验证、路径 jail、项目过滤、历史状态过滤、取消处理和显式截断不能为了性能被省略。
9. 新模块加入 `test/architecture.test.js` 的层级与预算；带 `// @ts-check` 的模块加入 `tsconfig.json`。不通过大范围提高层级或预算隐藏依赖问题。
10. 宿主事件及注入时机以 `docs/p0-compatibility.md` 为依据。协议测试和真实会话投递分开记录。

---

## 执行约定

工作目录为 `/Users/yukisala/subject/dsh-obsidian-mem`。当前检查的 HEAD 为 `e76c231`，不是未来执行时的固定提交。已有未提交修改涉及 `.prettierignore`、`lib/curation-cli.js`、`lib/diagnose-cli.js`、`package.json`、`scripts/check-staged.mjs`、`test/repo-hygiene.test.js`；先记录，不恢复或混入本功能提交。

- 实施者先读 spec、`AGENTS.md`、`docs/p0-compatibility.md`，再用 CodeGraph 查询当前结构；本计划不替代当前源码。
- 每个任务以可独立运行的行为测试结束。代码片段定义关键行为和接口，不要求把大模块改写成示例。
- 每条实施子步骤控制为一个动作；遇到较长实现，按列出的独立测试用例逐个红/绿循环，不把所有用例集中到最后。
- 本仓库的 `npm test` 不接受附加测试参数，且负责临时 `DSH_HOME`。本文所有红/绿命令使用 `npm test`；不要改成在真实 home 运行裸 `node --test`。
- 每次提交前只暂存本任务文件，运行 `npm run check:fast`、`npm run check` 和 `git diff --check`。门禁失败先区分原有问题与本任务问题，不为通过门禁改掉无关用户修改。
- `docs/` 被 `.gitignore` 忽略；只有本任务确实新增/更新的文稿需要 `git add -f <精确路径>`，不 force-add 整个目录。
- 不自动 push，不发布，不把 focused 改为默认。用户审阅文稿后，另行选择逐任务内联实施或 subagent-driven 实施。

## 文件与责任

| 创建/修改  | 文件                                                                                                                                                                                                                                                                                          | 单一责任与约束                                                               |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 创建       | `lib/retrieval-budget.js`                                                                                                                                                                                                                                                                     | L0 / 200 行；纯码点计数、最终 JSON 预算与闭合限值                            |
| 创建       | `lib/markdown-sections.js`                                                                                                                                                                                                                                                                    | L0 / 300 行；ATX、围栏、正文行/UTF-16 offset、索引窗口                       |
| 创建       | `lib/section-index.js`                                                                                                                                                                                                                                                                        | L1 / 350 行；SQLite 小节表与查询，tokenizer 注入，不读 vault                 |
| 创建       | `lib/read-projection.js`                                                                                                                                                                                                                                                                      | L3 / 300 行；通过既有 `readNote` 做有界摘录和批量读取                        |
| 创建       | `lib/retrieval-query.js`                                                                                                                                                                                                                                                                      | L3 / 200 行；复用 `indexText` 的确定性词法查询规划                           |
| 创建       | `lib/memory-context.js`                                                                                                                                                                                                                                                                       | L4 / 350 行；scope、种子、受限链接、来源证据与组合预算                       |
| 创建       | `lib/brief-navigation.js`                                                                                                                                                                                                                                                                     | L0 / 150 行；纯导航单位，不读取或摘要源内容                                  |
| 创建       | `lib/recall-state.js`                                                                                                                                                                                                                                                                         | L1 / 250 行；版本 key、v2 有界状态、私有缓存 IO                              |
| 修改       | `lib/index-db.js`, `lib/search.js`                                                                                                                                                                                                                                                            | 索引生命周期、候选来源验证、scope/readiness；旧 search 不改评分              |
| 修改       | `lib/tool-schema.js`, `lib/tool-registry.js`, `lib/services.js`                                                                                                                                                                                                                               | 显式视图、共用参数验证、闭合输出；新增内部 recall，不新增 MCP 工具           |
| 修改       | `lib/config.js`, `lib/brief.js`, `lib/prompt-recall.js`, `lib/hooks.js`                                                                                                                                                                                                                       | legacy/focused、导航、最终消息和投递后登记                                   |
| 修改       | `codex/server.mjs`, `codex/prompt-submit.mjs`, `codex/session-start.mjs`                                                                                                                                                                                                                      | 模式配置与协议适配；SessionStart 已有 openMemory，只有需要传递配置时才改入口 |
| 修改       | `lib/debug.js`, `lib/diagnostic-codec.js`                                                                                                                                                                                                                                                     | 封闭诊断计数，不记录查询、正文、标题或路径                                   |
| 修改       | `test/architecture.test.js`, `tsconfig.json`                                                                                                                                                                                                                                                  | 注册新模块；仅 prompt-recall 从 L3 到 L5，其余既有层级不变                   |
| 创建       | `test/retrieval-world.js`, `test/fixtures/retrieval-efficiency.json`                                                                                                                                                                                                                          | 临时 fixture 与独立人工标签，复用 `makeCurationWorld`                        |
| 创建       | `test/retrieval-baseline.test.js`, `test/retrieval-budget.test.js`, `test/markdown-sections.test.js`, `test/read-projection.test.js`, `test/section-index.test.js`, `test/memory-context.test.js`, `test/retrieval-query.test.js`, `test/recall-state.test.js`, `test/retrieval-eval.test.js` | 边界、兼容与质量回归；只采用 node:test                                       |
| 创建       | `scripts/run-retrieval-benchmark.mjs`                                                                                                                                                                                                                                                         | 显式临时环境、字符/质量/延迟的 JSON 报告，不自动写 vault 或上传              |
| 修改       | `test/tools.test.js`, `test/codex-mcp.test.js`, `test/brief.test.js`, `test/brief-view.test.js`, `test/prompt-recall.test.js`, `test/hooks.test.js`, `test/codex-hooks.test.js`, `test/debug.test.js`, `test/diagnostic-codec.test.js`, `test/config.test.js`                                 | 真实宿主/schema seam 与旧行为回归，执行前确认现有名称                        |
| 修改       | `README.md`, `README.zh.md`, `README.i18n.yaml`, `skills/obsidian-mem/SKILL.md`, `codex/marketplace/plugins/dsh-obsidian-mem/skills/obsidian-mem/SKILL.md`, `CHANGELOG.md`, `AGENTS.md`                                                                                                       | 双语言/双技能、证据边界、实测 pack 内容说明                                  |
| 运行后创建 | `docs/retrieval-efficiency-results.md`                                                                                                                                                                                                                                                        | 仅记录真实命令、结果和未验证项，不改写 P0/smoke/dogfood 历史                 |

新模块首次出现时立即登记层级、预算、JSDoc、`// @ts-check` 与 tsconfig；不能留到末尾。行数超限先收敛职责，预算确需调整要有格式化后的测量与理由。

文档交付还修改现有 `codex/README.md`，同步显式模式环境变量、hook信任和v2缓存边界；它不属于双语言README hash记录。

## Task 1: 固定隔离评测材料与旧行为基线

**Files:** Create `test/retrieval-world.js`, `test/fixtures/retrieval-efficiency.json`, `test/retrieval-baseline.test.js`.

**Interfaces:** Consumes `makeCurationWorld(t,{config,cwd})`。Produces `makeRetrievalWorld(t,{backend='sqlite',scale=1,retrievalMode='legacy'}={}) -> { ...world, notes, labels, sourceHashes }`，notes 以人工 ID 映射实际 path/hash；`snapshotSourceHashes(vault) -> Map<relativePath,sha256>`。标签只依赖人工 ID 和 heading，不依赖 search 结果。后续任务按下面明确的签名扩展这个测试 helper。

- [ ] **Step 1: 写旧契约和源只读测试。** 使用服务写入临时 fixture，再关闭写阶段；至少固定以下用例。

```js
test('legacy section read retains the existing full body', async (t) => {
  const world = await makeRetrievalWorld(t)
  const path = world.notes.release.path
  const note = await world.services.read({ path, section: 'Rollback' })
  assert.ok(note.body.includes('Unrelated background'))
  assert.ok(note.sectionBody.includes('Never delete the previous release'))
  const hits = await world.services.search({ query: 'release rollback' })
  assert.ok(Array.isArray(hits))
  assert.deepEqual(await snapshotSourceHashes(world.vault), world.sourceHashes)
})
```

- [ ] **Step 2: 运行 `npm test`。** Expected：新测试因 helper 未实现失败；已有测试不得被改为跳过。记录原有失败与新失败的区别。
- [ ] **Step 3: 建立 fixture 与冻结标签。** helper 使用 `makeCurationWorld(t,{config:{autoCurate:false,indexBackend:backend}})`，`services.write({type:'doc',title,body})` 返回的 path 只作 ID 定位。利用临时文件 IO 建立 aliases、历史状态、第二项目和坏 frontmatter；两个项目各用自己的临时 repo。所有 setup 完成后取源哈希。

```js
const release = await world.services.write({
  type: 'doc',
  title: 'Release policy',
  body:
    '# Release\n## Rollback\nRelease rollback procedure.\nNever delete the previous release.\n' +
    '## Background\nUnrelated background\n' +
    'background line\n'.repeat(600),
})
const notes = { release: { path: release.path, heading: 'Rollback' } }
```

人工素材还包括：`cjk` 的“功耗限制/调度”两小节；`alias` 的 `aliases:['NPU budget','功耗预算']`；`sensor` 的“接收极性/发射极性”不同数值；`duplicate` 两个同名标题；`fence` 围栏内假标题；`plain` 无标题；`links` 链接至本项目、另一项目、历史项、缺失项；`oversize` 257 个窗口和巨长单行。为 release fixture 在 Rollback 正文加入链接，关系测试查询 release 才能实际覆盖扩展。两套模式使用相同源事实。测试辅助 ID 不是公开工具新增短 ID。

48 查询按下表各行八条，前四为开发、后四为验收。每条独立记录 `id/group/split/prompt/expectedNoteIds/expectedHeadings/expectSilence`；读取与续问场景还记录显式 read 参数或前一轮 fixture 引用。生成这些标签时不得调用检索实现。

| 组             | 开发四条输入                                                  | 验收四条输入                                                                |
| -------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 精确名词       | release rollback；接收极性；功耗限制；Release policy          | 发射极性；NPU scheduling；Rollback；独立无标题事实                          |
| 中文/aliases   | 功耗预算；NPU budget；中文中英文混合词；单字“功”              | 中文别名；Latin alias；别名加精确标题；不相关别名对照                       |
| 长提示中间     | 中间“release rollback”的 17/32/64/128 词提示                  | 中间“接收极性”的 17/32/64/128 词提示                                        |
| 小节读取       | Rollback；重复标题；围栏假标题；父含子标题                    | body 行范围；无标题行；巨长行预算；257 窗口后的事实                         |
| 明确短追问     | 继续+有效引用；继续吧+有效引用；接着+无引用；那个方案+旧 hash | 上一个方案+有效引用；继续+跨项目引用；接着+已删除来源；任意短句不做指代扩展 |
| 隔离/过期/无关 | 历史项；另一项目；未解析链接；恶意指令正文                    | 修改后的旧事实；删除项；重命名旧路径；无关查询                              |

正例用人工来源与对应章节；单字和无关案例按源事实决定是否有正例，不强行设置通过标签。将最终素材、标签文件的 SHA 写入基线记录，验收分区不能用于调阈值。

- [ ] **Step 4: 运行 `npm test`。** Expected：基线通过；旧 section 仍含全文，旧 service 数组形状保持；临时 source hash 未变化。
- [ ] **Step 5: 只提交本任务三文件。** 暂存后运行执行约定的门禁，commit message 为 `test: pin isolated memory retrieval baseline`。

## Task 2: 最终序列化预算助手

**Files:** Create `lib/retrieval-budget.js`, `test/retrieval-budget.test.js`; Modify `test/architecture.test.js`, `tsconfig.json`.

**Interfaces:** Produces `countChars(text) -> number`、`serializedChars(value) -> number`、`packPayload({items,maxChars,build}) -> object`。build 接受 `{items,omitted,chars}`，返回完整闭合 envelope；helper 不修改调用者 items，不按字符裁剪事实。

- [ ] **Step 1: 写完整信封预算测试。** 同时覆盖 emoji 码点、JSON 转义、遗漏数从 9 到 10、计数字段增长及最小信封超限。

```js
test('packing counts the final envelope, not just text', () => {
  const result = packPayload({
    items: Array.from({ length: 20 }, () => ({ text: 'x'.repeat(80) })),
    maxChars: 512,
    build: ({ items, omitted, chars }) => ({
      view: 'compact',
      hits: items,
      meta: { chars, maxChars: 512, omitted, truncated: omitted > 0 },
    }),
  })
  assert.equal(result.meta.chars, [...JSON.stringify(result)].length)
  assert.ok(result.meta.chars <= 512)
  assert.ok(result.meta.omitted > 0)
})
```

- [ ] **Step 2: 运行 `npm test`。** Expected：新增导入/行为失败。
- [ ] **Step 3: 实现稳定计数和尾部单位移除。** 使用 `Array.from(text).length`；每次移除后重新构建遗漏字段。build 的 items 是已选完整单位；没有单位时仍超限，抛带 `code:'budget-too-small'` 的错误。

```js
export function countChars(text) {
  return [...text].length
}
export function serializedChars(value) {
  return countChars(JSON.stringify(value))
}
```

把 `DEFAULT_RESULT_CHARS=4000`、`MIN_RESULT_CHARS=512`、`MAX_RESULT_CHARS=24000`、`MAX_READ_PATHS=8`、`MAX_READ_LINES=200` 定义在这里并在参数服务复用。稳定求值先令 chars=0，重建并计数直到两次相等；若单位移除后改变长度，重新求值，不靠预估常量。

- [ ] **Step 4: 运行 `npm test`。** Expected：每个成功信封的实际长度都不超预算；超限没有半截正文。登记 L0/200 与 tsconfig 后架构/类型门禁通过。
- [ ] **Step 5: 只暂存上述四文件并运行门禁。** Commit `feat: enforce final retrieval payload budgets`。

## Task 3: Markdown 小节与源码范围

**Files:** Create `lib/markdown-sections.js`, `test/markdown-sections.test.js`; Modify `test/architecture.test.js`, `tsconfig.json`.

**Interfaces:** Produces `extractMarkdownSections({path,body,aliases=[]}) -> {sections,sectionsTruncated}`，section 含 `sectionId/heading/fromLine/toLine/startOffset/endOffset/text/ordinal`；`locateExcerpt(body,{section,fromLine,maxLines}) -> {fromLine,toLine,startOffset,endOffset,text}`。所有公开行号均相对 body。

- [ ] **Step 1: 写围栏与范围测试。** 再逐个补重复标题拒绝、父子章节、CRLF、emoji、无标题、Setext 普通正文、256 窗口截断、长行切窗的 red/green。

````js
test('ATX headings inside fences do not create sections', () => {
  const body = '# Policy\n```md\n## Fake\n```\n## Rollback\nKeep the old release.\n'
  const { sections } = extractMarkdownSections({ path: 'Projects/p-a/Docs/p.md', body })
  assert.equal(
    sections.some((section) => section.heading === 'Fake'),
    false,
  )
  const excerpt = locateExcerpt(body, { section: 'Rollback' })
  assert.equal(excerpt.fromLine, 5)
  assert.ok(excerpt.text.includes('Keep the old release.'))
  assert.equal(body.slice(excerpt.startOffset, excerpt.endOffset), excerpt.text)
})
````

- [ ] **Step 2: 运行 `npm test`。** Expected：模块缺失/结构解析未实现失败。
- [ ] **Step 3: 实现围栏状态机、标题层级和窗口。** 独立维护行号和 UTF-16 offset；围栏 opener/closer 按 backtick 或 tilde、至少三字符及相同字符/足够长度判断，缩进最多三空格。ATX 标题最多六级，去除合法尾部 closing hashes。摘录父章节到下一同级/上级；正文窗口段落优先、最多 1,200 码点；长行用码点累计 UTF-16 offset 切窗。

```js
const sectionId = createHash('sha256')
  .update(JSON.stringify([path, breadcrumb, occurrence, ordinal]))
  .digest('hex')
  .slice(0, 24)
```

breadcrumb、occurrence、ordinal 在同一 body 内稳定；源变化后仍必须验证完整 hash。重复摘录标题抛 `ambiguous-section`，不存在抛 `section-not-found`；不改 `index-db.js:extractSection` 的旧行为。

- [ ] **Step 4: 运行 `npm test`。** Expected：文本是源切片，范围可逆、上限显式，不把围栏或 Setext 错当小节。
- [ ] **Step 5: 只暂存四文件并运行门禁。** Commit `feat: index bounded Markdown section windows`。

## Task 4: 真正局部与有界批量读取，两个工具入口同步

**Files:** Create `lib/read-projection.js`, `test/read-projection.test.js`; Modify `lib/services.js`, `lib/tool-schema.js`, `lib/tool-registry.js`, `codex/server.mjs`, `test/tools.test.js`, `test/codex-mcp.test.js`, `test/architecture.test.js`, `tsconfig.json`.

**Interfaces:** Consumes `readNote(vaultRoot,path,undefined,{home})`、`locateExcerpt`、预算助手。Produces `readProjectedNotes({vaultRoot,paths,section,fromLine,maxLines,maxChars,home,signal}) -> EXCERPT_OUTPUT`；共享 `validateReadArguments(args)`；`READ_OUTPUT=oneOf[NOTE_SCHEMA,EXCERPT_OUTPUT]`。schema 与 spec §5.1 完全一致。

- [ ] **Step 1: 写服务与真实协议测试。** helper 复用 Task 1；同一请求经 DSH 实际 Standard Schema 和 `callMemoryTool` 执行，不只测镜像 schema。

```js
test('explicit excerpt never returns full body or frontmatter', async (t) => {
  const world = await makeRetrievalWorld(t)
  const result = await world.services.read({
    path: world.notes.release.path,
    view: 'excerpt',
    section: 'Rollback',
    maxChars: 512,
  })
  assert.equal(result.view, 'excerpt')
  assert.equal(result.notes[0].lineBase, 'body')
  assert.ok(result.notes[0].text.includes('Never delete the previous release'))
  assert.equal('body' in result.notes[0], false)
  assert.equal('frontmatter' in result.notes[0], false)
  assert.ok([...JSON.stringify(result)].length <= 512)
})
```

补充：旧调用形状；path 与 paths 双有/全无；九路径/重复；section 与 fromLine/maxLines；NaN/分数/超 safe integer；未知参数；缺失项+成功项；错误本身超过预算；巨长行整行省略；fromLine越界的range-not-found、空body一空行；frontmatter 行号；绝对/`..`/symlink/internal；读取前与批次中取消。

- [ ] **Step 2: 运行 `npm test`。** Expected：新参数被拒绝或仍返回旧 body；不得删掉旧 NOTE_SCHEMA 必需字段来通过。
- [ ] **Step 3: 实现显式分支与共享验证。** path 在参数表中不再单独 required，但服务执行 XOR 验证；paths 只允许 excerpt。错误只返回索引与闭合 code，不泄露失败路径或 OS 消息。

```js
if ((args.path !== undefined) === (args.paths !== undefined)) {
  throw new RangeError('mem_read requires exactly one of path or paths')
}
if (args.view === 'excerpt') {
  return readProjectedNotes({
    vaultRoot: root,
    paths: args.paths ?? [args.path],
    section: args.section,
    fromLine: args.fromLine,
    maxLines: args.maxLines,
    maxChars: args.maxChars,
    home,
    signal,
  })
}
```

投影逐文件使用 jailed `readNote`，按完整行选取；调用前后及每次 IO 后检查取消。batch 按输入顺序，在全局信封预算不足时停止启动新的读取并统计省略，最多八次文件读。`EXCERPT_OUTPUT` 闭合定义 notes/errors/meta；更新 DSH registration 的 outputSchema。Codex 的 jsonSchemaFor 只扩展有测试支持的参数属性，不另写校验规则。旧 `{path,section?}` 继续走原始 toNoteView。

- [ ] **Step 4: 运行 `npm test`。** Expected：双入口新旧读取均合法，旧结果字节形状不被“统一”，成功/局部错误结果都符合预算和取消语义。
- [ ] **Step 5: 只暂存本任务列出的文件并运行门禁。** Commit `feat: add bounded excerpt and batch memory reads`。至此是可独立使用的第一交付点，不宣称后续检索已经优化。

## Task 5: 可重建的 SQLite/scan 小节索引与源验证

**Files:** Create `lib/section-index.js`, `test/section-index.test.js`; Modify `lib/index-db.js`, `lib/search.js`, `test/retrieval-world.js`, `test/architecture.test.js`, `tsconfig.json`.

**Interfaces:** Consumes `extractMarkdownSections`、注入 `indexText` 与既有 scope descriptor。Produces `createSectionSchema(db)`、`replaceSections(db,record,{tokenize})`、`removeSections(db,path)`、`selectSectionCandidates(db,plan,filters,limit)`；index 新方法 `searchSections({query,filters,limit,signal})`、`neighbors({paths,filters,limit,signal})`、`recallTopics({refs,filters,limit,signal})`；search 新导出 `searchSections(index,options)`。

- [ ] **Step 1: 写同一套 sqlite/scan 行为测试。** 通过临时 `openIndex` 的公开 seam 检索；补更新/删除/rename/同 size+mtime 改字节、坏 frontmatter、未就绪、取消、历史、全 scope、单字 CJK、旧缓存版本隔离、每篇窗口上限。

```js
for (const backend of ['sqlite', 'scan']) {
  test(`${backend} sections reject stale source text`, async (t) => {
    const world = await makeRetrievalWorld(t, { backend })
    const before = await world.services.search({ query: 'release rollback' })
    await writeFile(
      join(world.vault, world.notes.release.path),
      (await readFile(join(world.vault, world.notes.release.path), 'utf8')).replace(
        'Never delete the previous release',
        'Keep three verified versions',
      ),
    )
    // 从公开 index helper 调用新 searchSections；helper 不绕开 scope/readiness。
    const after = await world.searchSections({ query: 'verified versions' })
    assert.ok(after.hits.some((hit) => hit.text.includes('three verified versions')))
    assert.equal(
      after.hits.some((hit) => hit.hash === before[0].hash),
      false,
    )
  })
}
```

在 `test/retrieval-world.js` 给测试提供 `searchSections(options)`：用同一 dataRoot 和绑定 projectId 打开第二个只读检索 handle，t.after 先 close，调用共享 `lib/search.js:searchSections`；不要引用 services 内部私有 index。

- [ ] **Step 2: 运行 `npm test`。** Expected：新 index API 缺失；索引测试不能以 search 结果反向生成预期标签。
- [ ] **Step 3: 实现小节 schema 与同步生命周期。** 递增 schema version；复用现有旧版本隔离/重建。record 增加规范化 aliases：最多八条，每条 64 码点；旧整篇 tokens 保持原值。`sections` 至少含 path、source_hash、section_id、heading、body 范围/offset、text、ordinal；`sections_fts` 含 title/heading/aliases/tokens，并通过 notes 关联过滤状态与项目。

```js
db.exec('BEGIN IMMEDIATE')
try {
  // existing note upsert 在本事务中执行，再更新该篇派生窗口。
  replaceSections(db, record, { tokenize: indexText })
  db.exec('COMMIT')
} catch (error) {
  db.exec('ROLLBACK')
  throw error
}
```

不要在既有外层事务内再 BEGIN：将 replaceSections 放入同一现有事务，helper 自己不启动事务。删除/候选修复同时清理小节。raw candidate 可来自缓存，返回前必须读当前 jailed 文件、hash 验证、必要时重建并重匹配；仅 stat 相同不足以证明来源相同。scan 使用相同 parser 与已有扫描上限，不为了小节功能扩大 vault 遍历范围。

- [ ] **Step 4: 实现新候选方法并逐例测试。** searchSections 返回 `{hits,meta}`；meta 内部含 backend/truncated/candidatesScored/sourceRejected/sectionsTruncated。neighbors 复用显式 wikilink resolver 和同一过滤谓词，模糊目标拒绝；recallTopics 最多三条，验证 hash+sectionId 后只输出 title/heading。ready/cancel 失败不假报空结果。
- [ ] **Step 5: 运行 `npm test`。** Expected：两个 backend 的关键命中与拒绝集合一致；来源修改后没有旧窗口/offset；旧 hits 基线通过。
- [ ] **Step 6: 只暂存本任务文件及 helper 并运行门禁。** Commit `feat: add source-verified lexical section retrieval`。

## Task 6: compact/context 检索与受限一跳关系

**Files:** Create `lib/memory-context.js`, `test/memory-context.test.js`; Modify `lib/services.js`, `lib/tool-schema.js`, `lib/tool-registry.js`, `test/tools.test.js`, `test/codex-mcp.test.js`, `test/architecture.test.js`, `tsconfig.json`.

**Interfaces:** Consumes `searchNotes`、`searchSections`、`resolveScope`、index.neighbors/recallTopics、预算助手。Produces `buildMemoryContext({index,vaultRoot,query,scope,type,projectId,includeHistory,limit,relatedLimit,maxChars,home,signal}) -> CONTEXT_OUTPUT`、`verifyRecallTopics({index,refs,signal}) -> {title,heading}[]`，共享 `validateSearchArguments(args)`；SEARCH_OUTPUT 包含旧 `{hits}` 与新 compact/context 闭合信封。

- [ ] **Step 1: 写组合结果与旧协议测试。** 注意 legacy service/Codex 仍是数组、DSH 仍是 `{hits}`；新视图在两边都是显式信封。

```js
test('context relations never widen project scope', async (t) => {
  const world = await makeRetrievalWorld(t)
  const result = await world.services.search({
    query: 'release rollback',
    view: 'context',
    relatedLimit: 3,
    limit: 3,
    maxChars: 2000,
  })
  assert.equal(result.view, 'context')
  assert.ok(result.entries.length <= 3)
  assert.ok(result.entries.every((entry) => entry.path !== world.notes.otherProject.path))
  assert.ok(result.meta.relatedRejected > 0)
  assert.equal(result.meta.chars, [...JSON.stringify(result)].length)
})
```

补充：compact 字段闭合；默认三/上限八；relatedLimit 对非 context 拒绝；hits 的 maxChars 拒绝；跨项目/历史/type 过滤；同名不折叠；链接不推断因果；更新后 hash+offset；小节上限 note-fallback；没有正例与预算不足的显式 meta。

- [ ] **Step 2: 运行 `npm test`。** Expected：新视图缺失；旧协议不能为新测试被改成另一种返回形状。
- [ ] **Step 3: 实现确定性融合和证据投影。** 笔记与小节两路各最多 24，`1/(60+rank)` 融合，rank 从 1 开始；同一路相同 path+sectionId 只贡献一次。标题精确命中优先，type/freshness 仅作同分 tie break，最后用 path/sectionId 保证稳定。

```js
const score =
  (noteRank === null ? 0 : 1 / (60 + noteRank)) +
  (sectionRank === null ? 0 : 1 / (60 + sectionRank))
```

最多验证 24 篇不同来源，跨两路复用一次请求内的 fresh read；这不允许跨请求跳过 hash。种子优先，每篇最多两段。默认 limit=3、relatedLimit=1；有余量才查看种子真实 wikilink，最多 12 目标，并共享总来源验证上限。来源预算耗尽停止扩展，meta.truncated 为 true。扩展也占 limit/字符预算。排除 index.md/hot 扩展，目标缺失/模糊/不合 scope 计数，不返回旧缓存。

- [ ] **Step 4: 接入显式服务/DSH/Codex 视图。** 只给新模式生成 compact/context schema；原分支继续原 toHitView。移除 TOOL_PARAMETERS.mem_search.limit 的静态 DSL default，保留两模式默认值描述；共享服务补 hits/compact=8、context=3，不再由注册层无条件补8。DSH execute 对旧数组包装，对新信封直接透传。

```js
const value = await services.search(forwarded, exec.signal, exec)
return Array.isArray(value) ? { hits: value } : value
```

signals/fallbackReason 用 spec 封闭词汇，所有 meta 计入 packPayload。verifyRecallTopics 使用 project scope+readiness，不通过手动 mem_read 扩大权限。参数编译测试验证不显式给limit时的新默认值，不能仅在直接service测试中通过。

- [ ] **Step 5: 运行 `npm test`。** Expected：source、scope、history 不因关系扩展失效；旧 hits 评分与既有 fixture 次序不变；两工具入口均通过真实 schema。
- [ ] **Step 6: 只暂存本任务文件并运行门禁。** Commit `feat: compose bounded memory evidence contexts`。这是一条可独立显式使用的第二交付点。

## Task 7: 稳定查询规划与版本感知召回状态

**Files:** Create `lib/retrieval-query.js`, `lib/recall-state.js`, `test/retrieval-query.test.js`, `test/recall-state.test.js`; Modify `test/architecture.test.js`, `tsconfig.json`.

**Interfaces:** Consumes `indexText`、已验证 `{title,heading}` topics。Produces `planRecallQuery(prompt,{verifiedTopics=[]}={}) -> {query,kind}`；kind 为 direct/continuation/no-query。状态 API 为 `emptyRecallState(projectId)`、`deliveryKey(entry)`、`advanceRecallState(state,entries)`、`loadRecallState(path,projectId)`、`saveRecallState(path,state)`；entry 至少含 path/hash/sectionId/text。

- [ ] **Step 1: 写确定性 query 与 key 测试。** 旧 `promptRecall` 的 query 算法不替换，focused 使用新 planner。

```js
test('delivered evidence keys distinguish versions and sections', () => {
  const entry = {
    path: 'Projects/p-a/Docs/n.md',
    hash: 'a'.repeat(64),
    sectionId: '1'.repeat(24),
    text: 'Keep three versions.',
  }
  assert.notEqual(deliveryKey(entry), deliveryKey({ ...entry, hash: 'b'.repeat(64) }))
  assert.notEqual(deliveryKey(entry), deliveryKey({ ...entry, sectionId: '2'.repeat(24) }))
  assert.notEqual(deliveryKey(entry), deliveryKey({ ...entry, text: 'Keep four versions.' }))
})
```

再补：17/32/64/128 token 中间主题，围栏只含代码，短 continuation 有/无 topics，非 allowlist 短句；旧 paths、项目变化、坏 JSON、过长值、>32KiB、leaf/parent symlink、0600/0700、并发 conservative repeat、64 key/3 ref 上限、状态不含 query/title/body。

- [ ] **Step 2: 运行 `npm test`。** Expected：模块/API 缺失。
- [ ] **Step 3: 实现 4+8+4 采样与 allowlist。** tokens 去重后 <=16 全用；超长取 head4/tail4，middle 区间均匀八点。索引 `floor(i*(middle.length-1)/7)`，不足时去重不补词；只对五个 spec 精确短句使用 verifiedTopics。

```js
const positions = Array.from({ length: 8 }, (_, i) => Math.floor((i * (middle.length - 1)) / 7))
const selected = [...head, ...positions.map((i) => middle[i]), ...tail]
const query = [...new Set(selected)].join(' ')
```

- [ ] **Step 4: 实现 v2 状态与私有 IO。** key 使用 SHA-256 的 path、完整源 hash、小节 key 和实际 text hash，以 NUL 分隔。advance 只添加调用者实际投递的 entries，返回新的 `{version:2,projectId,keys,refs}`；去重 keys 后取末64，refs 取本次最多三条实际投递引用。IO 上限32KiB；使用 lstat 拒绝链接，私有目录+wx临时文件+rename，失败不改源笔记。旧 `{paths}` 不用于抑制新证据；所有字段闭合验证，项目不符返回 empty。

```js
const excerptHash = createHash('sha256').update(entry.text).digest('hex')
return createHash('sha256')
  .update([entry.path, entry.hash, entry.sectionId, excerptHash].join('\0'))
  .digest('hex')
```

- [ ] **Step 5: 运行 `npm test`。** Expected：文件状态可损坏/可重建但不跨项目；旧路径缓存不永久抑制新版；无 prompt/正文持久化。
- [ ] **Step 6: 只暂存六文件并运行门禁。** Commit `feat: plan lexical recalls and track evidence versions`。

## Task 8: focused 配置与精简简报

**Files:** Create `lib/brief-navigation.js`; Modify `lib/config.js`, `lib/brief.js`, `codex/server.mjs`, `test/retrieval-world.js`, `test/config.test.js`, `test/brief.test.js`, `test/brief-view.test.js`, `test/codex-mcp.test.js`, `test/architecture.test.js`, `tsconfig.json`.

**Interfaces:** Produces Config 的 `retrievalMode:'legacy'|'focused'`，default legacy；`compactNavigation({relativeDir,recent}) -> {units,omitted}`；`openMemory({retrievalMode,...existingOptions})` 使用共享配置校验，显式 option 优先于 `OBSIDIAN_MEM_RETRIEVAL_MODE`。

- [ ] **Step 1: 写模式、必要区与导航预算测试。** 两种模式同一 fixture 比较；保留旧 brief-view 精确字符数等 legacy 断言。

```js
test('focused briefing keeps mandatory blocks while shrinking navigation', async (t) => {
  const world = await makeRetrievalWorld(t)
  const legacy = await world.buildBrief({ retrievalMode: 'legacy' })
  const focused = await world.buildBrief({ retrievalMode: 'focused' })
  assert.ok(focused.text.includes('Never delete the previous release'))
  assert.ok(focused.text.includes('Conventions/index.md'))
  assert.ok(focused.navigationChars <= legacy.navigationChars * 0.7)
  assert.ok(focused.chars <= 6000)
})
```

给 test helper 增加 `buildBrief({retrievalMode})`，直接调用既有 buildBrief 的实际参数签名与相同 binding/index；navigationChars 从 fixture 中逐块测量，仅测试内部使用，不擅自新增工具字段。补强必要区>1800时扩展、>原预算完整块省略及 hot 重试、完整投递后快照推进、delta 不重发、损坏 view 源回退、非法模式、显式 option/env 优先级。

- [ ] **Step 2: 运行 `npm test`。** Expected：配置未知或 focused 仍输出全目录。
- [ ] **Step 3: 添加模式配置与纯导航单位。** 新 Config 字段共享验证；openMemory 合并 explicit/env，非法值抛出。Conventions 使用一个 index 入口，recent 最多三项，仍来自当前源或已验证 curation view。路径、标题各显示一次，省略数含被导航入口替代的条目。

```js
const mode = options.retrievalMode ?? process.env.OBSIDIAN_MEM_RETRIEVAL_MODE
const config = validateConfig({
  ...(vaultPath === undefined ? {} : { vaultPath }),
  ...(mode === undefined ? {} : { retrievalMode: mode }),
})
```

- [ ] **Step 4: 在已有简报组装中接入 focused。** 先组必要区：绑定、数据声明、hot 强约束/当前状态、prefs、index 状态。目标 min(originalBudget,1800)，必要区过目标可扩展至原预算并标记诊断；不把没投递的 hot 块写入已投递快照。保留 delta 与 curation view 来源完整性判断，不改模型整理流程。
- [ ] **Step 5: 运行 `npm test`。** Expected：legacy 不变，focused 导航达 fixture 目标，强约束不因缩短被悄悄标成已送达。
- [ ] **Step 6: 只暂存本任务文件并运行门禁。** Commit `feat: add opt-in compact memory briefings`。

## Task 9: 共享 focused 逐轮召回与双宿主投递

**Files:** Modify `lib/prompt-recall.js`, `lib/services.js`, `lib/hooks.js`, `codex/prompt-submit.mjs`, `lib/debug.js`, `lib/diagnostic-codec.js`, `test/retrieval-world.js`, `test/prompt-recall.test.js`, `test/hooks.test.js`, `test/codex-hooks.test.js`, `test/debug.test.js`, `test/diagnostic-codec.test.js`, `test/architecture.test.js`.

**Interfaces:** Consumes context/query/state API。Produces `focusedPromptRecall({prompt,index,vaultRoot,state,maxChars,home,signal}) -> {outcome,text,paths,hits,chars,entries}`，entries 只含实际投递的证据；内部 `services.recall({prompt,state},signal,exec)` 解析项目/index 并委托共享函数。不加入 TOOL_NAMES/SERVICE_KEYS；legacy 原路径保持。

- [ ] **Step 1: 写实际消息预算与状态时机测试。** 先 focused 核心，再宿主失败场景逐个 red/green。

```js
test('only rendered focused entries advance the delivery state', async (t) => {
  const world = await makeRetrievalWorld(t, { retrievalMode: 'focused' })
  const state = emptyRecallState(world.projectId)
  const decision = await world.services.recall({ prompt: 'release rollback', state })
  assert.notEqual(decision.text, null)
  assert.ok(decision.chars <= 900)
  assert.equal(decision.chars, [...decision.text].length)
  assert.ok(decision.entries.length > 0)
  assert.equal(state.keys.length, 0)
  const next = advanceRecallState(state, decision.entries)
  assert.equal(next.keys.length, decision.entries.length)
})
```

helper 新增 projectId 来源：通过 setup 后 `resolveBinding({cwd:repo,vaultRoot:vault,mode:'show',home})` 取真实绑定，不虚构 id。补版本更新再召回、不同section、samekey静默、预算省略不登记、短追问验证hash/项目/历史、小节无证据不只投目录、恶意源指令引用化、非真实 user/source 静默、取消与不 ready、MCP-only 无自动注入、两个 adapter 同来源集合。

- [ ] **Step 2: 运行 `npm test`。** Expected：共享 recall 方法/新导出缺失。
- [ ] **Step 3: 实现共享 focused 决策。** query 规划前验证 continuation refs；组合 context 后使用原有词法精度 floor（最少三、最多四）。完整规范化query在标题、heading、alias或正文直接匹配可以进入；否则计算当前证据token交集，section-match/body-match标签本身不能绕过floor。alias-match需保留经当前来源验证的完整别名匹配证据，不把任意词overlap当精确别名。先过滤已有 deliveryKey，再按引用化后的最终文本选择完整证据单位，最多三条；前缀/路径/数据声明全计入900。窗口太长容不下则省略，不裁半句或伪造完整事实。只给最终文本中的 entries 返回投递 keys 所需内容。

```js
const topics = await verifyRecallTopics({ index, refs: state.refs, signal })
const plan = planRecallQuery(prompt, { verifiedTopics: topics })
if (plan.kind === 'no-query') return noRecall('no-query')
```

`noRecall` 可复用模块现有私有构造器，保持既有 outcome 词汇；新决定加 entries 空数组。登记 prompt-recall L5 是为 import memory-context L4，不提高 hooks/services/brief 及上游层级。

- [ ] **Step 4: 接入 DSH 与 Codex adapter。** DSH focused 状态按 session+project 进程内保存，原真实用户 prompt 提取不变；消息入队成功后 advance。Codex focused 使用现有哈希 session 文件与新 v2 IO，additionalContext 成功写出后保存；无输出/异常不写新 keys。legacy 仍读写旧 paths 状态，不能把 focused 状态误解释为 legacy 已见路径。模式切换允许一次保守重复，不跨项目复用 refs。

```js
if (decision.text !== null) {
  answer = {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: decision.text,
    },
  }
  // 先完成协议输出，再保存 advanceRecallState(state, decision.entries)。
}
```

重构 runHook 时保证 stdout 恰好一份 JSON；保存失败不再输出第二份 CONTINUE。DSH/Codex 异常均继续任务并 close；新数据根/配置不写真实安装文件。检查 `SessionStart` 已经通过 openMemory 采用同一模式，只有需要传递配置时才改现有入口。

- [ ] **Step 5: 更新诊断 allowlist 并测试。** 字段只允许 mode/stage/outcome/code/chars/omitted/durationMs/backend/candidatesScored/sourceRejected/relatedRejected；`mandatory-over-target` 用封闭 code。测试 round-trip 拒绝 query/path/title/text，模拟日志 sink 异常不阻断召回。
- [ ] **Step 6: 运行 `npm test`。** Expected：核心与两个协议通过，状态时机和源验证正确，旧 promptRecall/legacy hooks 不变。
- [ ] **Step 7: 只暂存本任务文件并运行门禁。** Commit `feat: share focused prompt recall across DSH and Codex`。

## Task 10: 质量与字符/延迟评测，保留未通过案例

**Files:** Create `test/retrieval-eval.test.js`, `scripts/run-retrieval-benchmark.mjs`; Modify `test/retrieval-world.js`; Create `docs/retrieval-efficiency-results.md` only after execution.

**Interfaces:** Benchmark CLI `node scripts/run-retrieval-benchmark.mjs --split dev|acceptance --scale 100|1000 --runs 30`。输出单个 JSON 报告至 stdout；source/label hashes、SHA、Node、backend、mode、quality、chars、latency、token/usage字段。未提供实测 tokenizer/usage 时 `tokens:null`；不调用模型或下载 tokenizer。

- [ ] **Step 1: 写公平质量指标与只读测试。** 同一 path 标签计算旧 hits 与新 context；section 另测，负例不计 MRR。

```js
test('MRR compares distinct paths instead of incompatible result shapes', () => {
  const actual = ['a.md', 'a.md', 'b.md']
  const ranked = [...new Set(actual)].slice(0, 3)
  const position = ranked.findIndex((path) => path === 'b.md')
  assert.equal(position < 0 ? 0 : 1 / (position + 1), 0.5)
})
```

测试脚本参数拒绝未知 split、scale和runs非法值，任何 vault/home 参数均不接受；子运行只建临时world；source hashes 前后相同。path Recall@3 为 top3 relevant paths/该查询相关paths数，MRR@3 为首个相关path倒数；EvidenceRecall@3 使用人工 path+heading 标签。拒绝/无关组测误投递率，不能将无正例计零混进 MRR。

- [ ] **Step 2: 运行 `npm test`。** Expected：新 benchmark/metrics helper 缺失。
- [ ] **Step 3: 实现隔离 benchmark。** 复用 fixture helper，自己创建临时 DSH_HOME 环境后启动子进程，不依赖调用者 home；t.after/finally 关闭服务再删树。100/1000 scale 只增加可重现无关笔记，相关素材/标签不变。预热独立记录，30 runs用 performance.now，A/B 顺序交替。

```js
const ordered = samples.toSorted((a, b) => a - b)
const p95 = ordered[Math.ceil(ordered.length * 0.95) - 1]
```

输出冷 index readiness 时间、热 recall p50/p95、每模式实际返回/消息字符与工具调用数。吞吐与索引增长分别记录，不把省字符当成省 token。测试 helper 若用 node:test context，在脚本中提供专用 cleanup registry 而不是制造假的通过 TAP。

- [ ] **Step 4: 运行 `npm test` 和开发评测。** Commands：`node scripts/run-retrieval-benchmark.mjs --split dev --scale 100 --runs 30`，再 scale1000。Expected：逐组质量不降，长文 excerpt/导航fixture字符目标达到，p95符合 spec。只在 dev 调参数，失败先保留case再修改。
- [ ] **Step 5: 冻结候选 SHA、素材与标签哈希后运行验收。** 相同两条命令改 `--split acceptance`。验收失败阻断交付；修复后标明本次验收已被观察，增加新的未观察人工案例再进行最终验收，不把反复调参的集合称为 untouched held-out。
- [ ] **Step 6: 填写真实报告。** 记录每组 path Recall/MRR、section EvidenceRecall、误投递、总字符/往返、冷/热性能、source未变化、实际命令和退出码。没有 tokenizer/hostusage则 token:null，保留 failures 和 unverified；不写预设成功百分比。
- [ ] **Step 7: 只暂存本任务文件，report 用精确 `git add -f`，运行门禁。** Commit `test: benchmark lexical memory retrieval and payloads`。

## Task 11: 真实隔离会话证据与回退核对

**Files:** Modify `docs/retrieval-efficiency-results.md`, `CHANGELOG.md`; 如现有 `test/p0/` 探针不足，新建 `test/p0/retrieval-delivery-probe.mjs` 并限定仅写事件元数据，不复制历史记录。

**Interfaces:** 输出验证状态包括 `protocol-tested`、`live-verified` 或 `unverified`，二者不能互相代替。事件只保存 source form、阶段、计数、char length、投递次序；不保存 prompts/正文/凭据。

- [ ] **Step 1: 明确观察点并先验证负例。** 探针的空事件文件必须失败，只有 hook 配置/信任状态不得算成功；DSH 在新 prompt 的首次模型请求前出现 focused引用消息，Codex受信 UserPromptSubmit 输出被实际会话消费才算 live。

```js
assert.ok(events.some((event) => event.kind === 'focused-recall' && event.chars > 0))
assert.ok(events.some((event) => event.kind === 'request-after-recall'))
```

具体宿主事件以当前 API 和 P0 文档核对，不能凭上述归一化事件名假定宿主原生有这个事件。probe 只将已观察到的真实事件映射到上述测试字段。

- [ ] **Step 2: 运行探针断言的空输入测试。** Expected：无真实投递证据必须失败；记录失败命令。不得启动真实vault的会话来凑证据。
- [ ] **Step 3: 分别在临时 DSH_HOME/Codex home、临时 repo/vault中运行人工会话。** 使用fixture：第一轮精确Rollback，第二轮继续，第三轮改来源后同主题。每轮只核对注入位置、引用path/hash、字符、去重和更新；任何凭据仅经环境传入，不记录。hook 信任只能为这个隔离profile显式批准，不能改全局配置。
- [ ] **Step 4: 验证 legacy 回退与 MCP-only。** 相同 fixture 切回 legacy 比较原形状；无受信 hook 的 Codex只能显式调用新参数，不宣称自动投递。无法获取宿主/凭据/请求边界时，该宿主标记 unverified，不伪造输出，也不为测试安装或升级全局宿主。
- [ ] **Step 5: 更新报告及 Unreleased 未验证项。** 只有实际跑过的场景才移出未验证列表；不是 live-verified 的宿主不计为 spec 全验收通过。
- [ ] **Step 6: 只暂存本任务新增/修改文件并运行门禁。** Commit `test: record isolated focused recall delivery evidence`；如果只有未验证说明，使用 `docs: record focused recall verification limits`。

## Task 12: 双语言文档、技能、pack 与交付门禁

**Files:** Modify `README.md`, `README.zh.md`, `README.i18n.yaml`, `codex/README.md`, `skills/obsidian-mem/SKILL.md`, `codex/marketplace/plugins/dsh-obsidian-mem/skills/obsidian-mem/SKILL.md`, `CHANGELOG.md`, `AGENTS.md`; 仅当新增资产契约需要时修改 `scripts/verify-pack.mjs`, `scripts/verify-tarball.mjs`, `test/pack.test.js`。

**Interfaces:** 文档例子与共享 TOOL_PARAMETERS 一致；npm 继续只发布原allowlist范围，不发布 docs/test/research/codex/cache。新 lib 模块正常随 lib 发布，不固定文件总数来阻止新增模块。

- [ ] **Step 1: 写包契约测试再运行红例。** 新模块都须入tarball，文稿/cache/fixture不入；原 pack若已经正确纳入lib，不人为制造失败，明确“现有contract已覆盖”，新增资产清单断言只在缺口处做TDD。

```js
assert.ok(files.includes('lib/retrieval-budget.js'))
assert.ok(files.includes('lib/memory-context.js'))
assert.equal(
  files.some((file) => file.startsWith('docs/')),
  false,
)
```

- [ ] **Step 2: 运行 `npm test`。** Expected：contract有缺口时失败；已有contract充分时记录通过，不把它描述为功能先红后绿。
- [ ] **Step 3: 更新双 README 与双技能的相同契约。** 示例给 `mem_search({query,view:'compact',maxChars:2000})`、`mem_search({query,view:'context',relatedLimit:1})`、`mem_read({path,view:'excerpt',section:'Rollback'})` 与 batch。说明 body 行号、全结果预算、旧section仍全文、focused默认关闭、900消息预算、字符不是token、source约束和未受信hook限制；中文新链接增加英文slug anchor。Codex README 同步环境变量的显式开启/回退、受信hook前提与v2状态缓存边界，不要求修改全局安装配置。
- [ ] **Step 4: 更新 hash 与证据记录。** Run `git hash-object README.md README.zh.md`，将实际两值填回 README.i18n.yaml。CHANGELOG 写接口、默认不变、缓存schema重建、实际测量和未验证项。`npm run pack:check` 实测tarball后更新 AGENTS 的内容/数量说明；没有事实变化的段落不改。
- [ ] **Step 5: 运行最终门禁。** Commands：`npm run check`、`git diff --check`、`git status --short`。Expected：lint/format/types/suite/pack contract/真实archive全部通过；dirty状态只有已有用户修改和本任务文件，不新增配置/vault/temp资产。失败必须修复本功能或明确既有阻碍，不能隐藏失败。
- [ ] **Step 6: 只暂存文档与必要pack契约文件，运行 staged门禁后提交。** Commit `docs: document bounded memory retrieval and focused mode`。不push、不改默认；交付时给出真实测试结果、评测报告、未验证宿主以及已有工作区修改仍被保留。

## 验收追踪与暂停点

| Spec 范围                | 任务             | 交付判定                                                   |
| ------------------------ | ---------------- | ---------------------------------------------------------- |
| §3 全局安全与工程约束    | 全部；12最终核对 | 配置/真实vault不被修改，六工具不变，门禁真实通过           |
| §5.1 局部/批量读取       | 2、3、4          | 旧形状不变；摘录不带全文；全信封预算与错误/取消准确        |
| §5.2 compact/context     | 5、6             | 双入口闭合schema；有出处、scope/history/source一致         |
| §6 预算与token含义       | 2、4、6、9、10   | 实际JSON/消息计数；无字符转token冒充实测                   |
| §7 小节/aliases/查询规划 | 3、5、7          | bounded、可重建、只词法、continuation只用已验证引用        |
| §8 一跳关系              | 5、6             | 不复用展示图权限；只真实wikilink，不越界、不推断因果       |
| §9 focused简报/召回      | 7、8、9、11      | default legacy、强约束保留、投递后登记、v2私有有界状态     |
| §10 模块/接口            | 每模块首次出现   | 层级无环、仅prompt-recall有理由调整，类型ratchet包含新模块 |
| §11 失败/诊断            | 4、5、6、7、9    | 取消/过期/降级可区分，日志allowlist无敏感内容              |
| §12 质量/成本/宿主验收   | 1、10、11、12    | 逐组指标及真实会话分层，未运行明确标记                     |
| §13 语义检索             | 不实现           | 只保存词法不足案例，另立spec/plan后评测                    |

Task 4 后可审阅局部读取，Task 6 后可审阅显式组合检索，Task 9 后可审阅 focused 自动行为。任一发布质量门槛未通过，都保留 legacy 默认并停止发布推进；不以“任务已提交”替代用户验收。

## 本次文稿自审

本次已完成文稿层面的 spec 覆盖、跨任务接口、闭合字段、现有路径、默认值、模块层级、测试隔离、旧shape、字符/token边界与源只读检查，并修正静态limit默认值、新信封包装和Codex技能实际路径。执行前再次核对当前源码；自审不是新功能已经实现或宿主已验证的证据。
