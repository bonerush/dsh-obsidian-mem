// Discardable smoke-test driver for `dsh-obsidian-mem`.
//
// It is never shipped with the plugin. It is installed with `link:` into an
// isolated `DSH_HOME` profile beside the plugin and does three jobs there:
//
//   1. **Drives the real tools.** On the first `agent/pre-step` it calls the
//      plugin's own registered `mem_*` tools through `ctx.tools.get(name)
//      .execute(args, exec)` — the same definitions the model would call — and
//      records only receipts, paths, ids, statuses, counts and hashes.
//   2. **Witnesses the real lifecycle.** It records every committed
//      `session/event` that matters (plugin recall messages, `turn/end`) as
//      metadata only.
//   3. **Holds the process open at the durability boundary.** The queue worker's
//      own timer is `unref()`-ed, so a headless run can exit before the worker
//      applies the job it just captured. The driver keeps a *referenced* interval
//      alive: either it waits for the result receipt (`..._WAIT_RECEIPT=1`) or it
//      SIGKILLs the process as soon as the job is durable (`..._KILL=1`). It also
//      snapshots the vault tree on both sides of that apply, which is what makes
//      "dryRun wrote nothing" a hash comparison instead of a claim.
//
// No prompt text, no model output, no note body and no credential ever reaches
// the record. The record is a JSONL file at `DSH_OBSIDIAN_MEM_SMOKE_RECORD`.
//
// Environment:
//   DSH_OBSIDIAN_MEM_SMOKE_RECORD   append-only JSONL path (required to record)
//   DSH_OBSIDIAN_MEM_SMOKE_VAULT    absolute temp vault root (for the external edit)
//   DSH_OBSIDIAN_MEM_SMOKE_SCENARIO `0` disables the tool scenario
//   DSH_OBSIDIAN_MEM_SMOKE_WAIT_RECEIPT `1` hold the process until the receipt exists
//   DSH_OBSIDIAN_MEM_SMOKE_KILL     `1` SIGKILL once the completed turn's job is durable

import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

/** Stable Cordis plugin name. */
export const name = 'dsh-obsidian-mem-smoke-driver'
/** The six tools live on this service, and the driver calls them by name. */
export const inject = ['tools']

const RECORD_PATH = process.env.DSH_OBSIDIAN_MEM_SMOKE_RECORD ?? ''
const VAULT_ROOT = process.env.DSH_OBSIDIAN_MEM_SMOKE_VAULT ?? ''
const RUN_SCENARIO = process.env.DSH_OBSIDIAN_MEM_SMOKE_SCENARIO !== '0'
const WAIT_RECEIPT = process.env.DSH_OBSIDIAN_MEM_SMOKE_WAIT_RECEIPT === '1'
const KILL_ON_TURN_END = process.env.DSH_OBSIDIAN_MEM_SMOKE_KILL === '1'
const DSH_HOME = process.env.DSH_HOME ?? ''
const QUEUE_ROOT = DSH_HOME === '' ? '' : join(DSH_HOME, 'data', 'obsidian-mem', 'pending')

/** The Chinese search term the scenario writes a document for and then looks up. */
const CN_DOC_TITLE = '冒烟文档：中文检索目标'
const CN_DOC_BODY = '这是一段用于验证中文全文检索的正文，包含独特词元：蓝鲸协议。'
const CN_QUERY = '蓝鲸协议'

/** Append one record. Probing must never break the host session. */
function record(entry) {
  if (RECORD_PATH === '') return
  try {
    appendFileSync(RECORD_PATH, `${JSON.stringify(entry)}\n`)
  } catch {
    /* a driver failure must not fail the host run */
  }
}

/** sha256 hex of a string or buffer. */
function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

/** Read a vault file's bytes, or `null` when it is gone. */
function readVaultFile(relativePath) {
  try {
    return readFileSync(join(VAULT_ROOT, relativePath))
  } catch {
    return null
  }
}

/** Detached, record-safe description of one thrown value (no body, no prompt). */
function describeError(error) {
  return {
    threwName: error?.name ?? 'Error',
    threwCode: typeof error?.code === 'string' ? error.code : null,
    threwMessage: String(error?.message ?? '').slice(0, 200),
  }
}

/** A stable hash of every file under the temp vault (bodies included, never recorded). */
function hashTree() {
  if (VAULT_ROOT === '' || !existsSync(VAULT_ROOT)) return null
  const parts = []
  const walk = (directory, prefix) => {
    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) walk(join(directory, entry.name), relative)
      else if (entry.isFile()) {
        try {
          parts.push(`${relative}:${sha256(readFileSync(join(directory, entry.name)))}`)
        } catch {
          /* a file that vanished is not part of the hash */
        }
      }
    }
  }
  walk(VAULT_ROOT, '')
  return sha256(parts.join('\n'))
}

/** A hand-built `ToolRunContext`: the six tools read `exec.agent` and `exec.signal`. */
function makeExec(agent, toolName, args, controller) {
  const counter = (makeExec.counter += 1)
  const callId = `smoke-${toolName}-${counter}`
  return {
    callId,
    rootCallId: callId,
    name: toolName,
    arguments: args,
    ...(agent === undefined ? {} : { agent }),
    signal: controller.signal,
    token: `smoke-token-${counter}`,
    deferContext() {},
    concludeTurn() {},
  }
}
makeExec.counter = 0

/** The `mem_*` tool surface this smoke exercises. */
const TOOL_NAMES = ['mem_search', 'mem_read', 'mem_write', 'mem_log', 'mem_brief', 'mem_admin']

/**
 * Call one registered plugin tool exactly as the runtime would.
 *
 * @param {object} ctx - the Cordis context.
 * @param {object} agent - the live agent (cwd + signal owner).
 * @param {string} toolName - one of the six `mem_*` names.
 * @param {object} args - the tool arguments.
 * @returns {Promise<{ok: true, value: any}|{ok: false, error: object}>} the outcome.
 */
async function callTool(ctx, agent, toolName, args) {
  const registry = typeof ctx.get === 'function' ? ctx.get('tools') : undefined
  const definition = registry === undefined || registry === null ? undefined : registry.get(toolName)
  if (definition === undefined) return { ok: false, error: { threwName: 'MissingTool', threwCode: 'missing-tool', threwMessage: toolName } }
  const controller = new AbortController()
  try {
    const value = await definition.execute(args, makeExec(agent, toolName, args, controller))
    return { ok: true, value }
  } catch (error) {
    return { ok: false, error: describeError(error) }
  }
}

// ---------------------------------------------------------------------------
// The deterministic tool scenario
// ---------------------------------------------------------------------------

/**
 * Exercise the plugin's tools against the temporary vault, once per process.
 *
 * Every stage records its own outcome, so one failing stage cannot hide the
 * others: the verifier fails on the missing observation.
 *
 * @param {object} ctx - the Cordis context.
 * @param {object} agent - the live agent.
 * @returns {Promise<void>}
 */
async function runScenario(ctx, agent) {
  record({ name: 'smoke/tools', available: TOOL_NAMES.filter((toolName) => ctx.get('tools')?.get(toolName) !== undefined), expected: TOOL_NAMES.length })

  // --- 1. bind the temporary repository to the temporary vault --------------
  const bind = await callTool(ctx, agent, 'mem_admin', { action: 'bind', mode: 'local' })
  const bindResult = bind.ok ? (bind.value?.result ?? null) : null
  const resolution = bindResult?.resolution ?? null
  const projectDir = typeof resolution?.relativeDir === 'string' ? resolution.relativeDir : null
  record({
    name: 'smoke/stage',
    stage: 'bind',
    ok: bindResult?.status === 'bound' && projectDir !== null,
    status: bindResult?.status ?? null,
    kind: resolution?.kind ?? null,
    projectId: resolution?.projectId ?? null,
    relativeDir: projectDir,
    pointerCreated: resolution?.pointerCreated === true,
    bootstrapped: bindResult?.bootstrapped === true,
    registryUpdated: bindResult?.registryUpdated === true,
    ...(bind.ok ? {} : { error: bind.error }),
  })

  // --- 2. write one document into the vault ---------------------------------
  const doc = await callTool(ctx, agent, 'mem_write', {
    type: 'doc',
    title: CN_DOC_TITLE,
    body: CN_DOC_BODY,
    tags: ['smoke', '中文'],
    status: 'active',
  })
  const docPath = doc.ok ? doc.value.path : null
  const docBytes = docPath === null ? null : readVaultFile(docPath)
  record({
    name: 'smoke/stage',
    stage: 'doc-write',
    ok: doc.ok && typeof docPath === 'string' && docBytes !== null,
    path: docPath,
    id: doc.ok ? doc.value.id : null,
    bytes: docBytes === null ? null : docBytes.length,
    sha256: docBytes === null ? null : sha256(docBytes),
    receiptAction: doc.ok ? (doc.value.receipt?.action ?? null) : null,
    ...(doc.ok ? {} : { error: doc.error }),
  })

  // --- 3. Chinese full-text search -----------------------------------------
  const search = await callTool(ctx, agent, 'mem_search', { query: CN_QUERY, scope: 'project' })
  const hits = search.ok && Array.isArray(search.value?.hits) ? search.value.hits : []
  record({
    name: 'smoke/stage',
    stage: 'search-cn',
    ok: search.ok && docPath !== null && hits.some((hit) => hit.path === docPath),
    queryChars: [...CN_QUERY].length,
    hitCount: hits.length,
    hitPaths: hits.map((hit) => hit.path).slice(0, 8),
    matchedDocPath: docPath !== null && hits.some((hit) => hit.path === docPath),
    ...(search.ok ? {} : { error: search.error }),
  })

  // --- 4. supersede chain ---------------------------------------------------
  const oldWrite = await callTool(ctx, agent, 'mem_write', { type: 'decision', title: '冒烟决策（旧）', body: '旧结论正文。', status: 'accepted' })
  const oldId = oldWrite.ok ? oldWrite.value.id : null
  const oldPath = oldWrite.ok ? oldWrite.value.path : null
  const newWrite = oldId === null
    ? { ok: false, error: { threwName: 'Skipped', threwCode: 'no-old-id', threwMessage: 'the old decision was not written' } }
    : await callTool(ctx, agent, 'mem_write', { type: 'decision', title: '冒烟决策（新）', body: '新结论正文，取代旧结论。', status: 'accepted', supersedes: oldId })
  const oldRead = oldPath === null ? { ok: false, error: { threwCode: 'no-old-path' } } : await callTool(ctx, agent, 'mem_read', { path: oldPath })
  const newId = newWrite.ok ? newWrite.value.id : null
  const defaultSearch = await callTool(ctx, agent, 'mem_search', { query: '冒烟决策', scope: 'project' })
  const historySearch = await callTool(ctx, agent, 'mem_search', { query: '冒烟决策', scope: 'project', includeHistory: true })
  const pathsOf = (result) => (result.ok && Array.isArray(result.value?.hits) ? result.value.hits.map((hit) => hit.path) : [])
  const defaultPaths = pathsOf(defaultSearch)
  const historyPaths = pathsOf(historySearch)
  const oldStatus = oldRead.ok ? (oldRead.value?.status ?? null) : null
  const oldSupersededBy = oldRead.ok ? (oldRead.value?.frontmatter?.superseded_by ?? null) : null
  record({
    name: 'smoke/stage',
    stage: 'supersede',
    ok:
      oldId !== null &&
      newWrite.ok &&
      readVaultFile(oldPath ?? '') !== null &&
      oldStatus === 'superseded' &&
      oldSupersededBy === newId &&
      !defaultPaths.includes(oldPath) &&
      defaultPaths.includes(newWrite.ok ? newWrite.value.path : null) &&
      historyPaths.includes(oldPath),
    oldId,
    newId,
    oldPath,
    newPath: newWrite.ok ? newWrite.value.path : null,
    oldFileStillExists: oldPath !== null && readVaultFile(oldPath) !== null,
    oldStatus,
    oldSupersededBy,
    defaultSearchHasOld: oldPath !== null && defaultPaths.includes(oldPath),
    defaultSearchHasNew: defaultPaths.includes(newWrite.ok ? newWrite.value.path : null),
    historySearchHasOld: oldPath !== null && historyPaths.includes(oldPath),
    ...(newWrite.ok ? {} : { error: newWrite.error }),
  })

  // --- 5. an external edit survives -----------------------------------------
  // A plugin-owned note that a human then edits. Two things must hold: the
  // plugin's own relink keeps the human line, and a `trust:owner` file is never
  // rewritten at all. The latter is the byte-identity check the verifier fails on.
  const extWrite = await callTool(ctx, agent, 'mem_write', { type: 'doc', title: '外部编辑目标文档', body: '初始正文。', status: 'active' })
  const extId = extWrite.ok ? extWrite.value.id : null
  const extPath = extWrite.ok ? extWrite.value.path : null
  const HUMAN_LINE = '人工外部编辑的一行：这一行必须存活。'
  let externalEdit = { ok: false, reason: 'no-target' }
  if (extPath !== null && VAULT_ROOT !== '') {
    const absolute = join(VAULT_ROOT, extPath)
    const edited = `${readFileSync(absolute, 'utf8')}\n${HUMAN_LINE}\n`
    // Deliberately NOT via write-file-atomic or any plugin helper: this is the
    // external editor's write.
    writeFileSync(absolute, edited)
    const hashBeforeSupersede = sha256(readFileSync(absolute))
    const supersedeAttempt = await callTool(ctx, agent, 'mem_write', {
      type: 'doc',
      title: '外部编辑后的候选文档',
      body: '候选正文。',
      status: 'active',
      supersedes: extId,
    })
    const after = readVaultFile(extPath)
    const afterText = after === null ? '' : after.toString('utf8')
    const relink = await callTool(ctx, agent, 'mem_read', { path: extPath })
    externalEdit = {
      ok: after !== null && afterText.includes(HUMAN_LINE),
      path: extPath,
      hashBeforeSupersede,
      hashAfterSupersede: after === null ? null : sha256(after),
      humanLineSurvived: afterText.includes(HUMAN_LINE),
      candidateWritten: supersedeAttempt.ok,
      refusalCode: supersedeAttempt.ok ? null : (supersedeAttempt.error?.threwCode ?? null),
      statusAfter: relink.ok ? (relink.value?.status ?? null) : null,
    }
  }
  record({ name: 'smoke/stage', stage: 'external-edit', ...externalEdit })

  // --- 6. a human-owned note is never rewritten -----------------------------
  let humanOwned = { ok: false, reason: 'no-project-dir' }
  if (projectDir !== null && VAULT_ROOT !== '') {
    const humanRelative = `${projectDir}/Conventions/人写的约定.md`
    const humanId = `con-${randomUUID()}`
    const humanBytes = Buffer.from(
      `---\nid: "${humanId}"\ntype: "convention"\ntitle: "人写的约定"\ntrust: "owner"\nharness: "obsidian"\n---\n\n人类手写的约定正文。\n`,
      'utf8',
    )
    mkdirSync(join(VAULT_ROOT, projectDir, 'Conventions'), { recursive: true })
    const humanAbsolute = join(VAULT_ROOT, humanRelative)
    writeFileSync(humanAbsolute, humanBytes)
    const hashBefore = sha256(readFileSync(humanAbsolute))
    const attemptUpdate = await callTool(ctx, agent, 'mem_write', { id: humanId, type: 'convention', title: '人写的约定', body: '插件改写。' })
    const hashAfterUpdate = sha256(readFileSync(humanAbsolute))
    const attemptSupersede = await callTool(ctx, agent, 'mem_write', { type: 'convention', title: '取代人写约定的候选', body: '候选正文。', supersedes: humanId })
    const hashAfterSupersede = sha256(readFileSync(humanAbsolute))
    humanOwned = {
      ok: hashBefore === hashAfterUpdate && hashBefore === hashAfterSupersede,
      path: humanRelative,
      id: humanId,
      hashBefore,
      hashAfterUpdate,
      hashAfterSupersede,
      survivedUpdate: hashBefore === hashAfterUpdate,
      survivedSupersede: hashBefore === hashAfterSupersede,
      updateRefusalCode: attemptUpdate.ok ? null : (attemptUpdate.error?.threwCode ?? null),
      supersedeRefusalCode: attemptSupersede.ok ? null : (attemptSupersede.error?.threwCode ?? null),
      bytesOnDisk: readVaultFile(humanRelative)?.length ?? null,
    }
  }
  record({ name: 'smoke/stage', stage: 'human-owned', ...humanOwned })

  // --- 7. the read-only paths never write -----------------------------------
  const lintBefore = hashTree()
  const lint = await callTool(ctx, agent, 'mem_admin', { action: 'lint' })
  const lintAfter = hashTree()
  const lintResult = lint.ok ? (lint.value?.result ?? null) : null
  record({
    name: 'smoke/stage',
    stage: 'lint-readonly',
    ok: lint.ok && lintBefore !== null && lintBefore === lintAfter && lintResult?.readOnly === true,
    total: lintResult?.total ?? null,
    readOnly: lintResult?.readOnly ?? null,
    counts: lintResult?.counts ?? null,
    pendingJobs: lintResult?.pending?.jobs ?? null,
    treeHashBefore: lintBefore,
    treeHashAfter: lintAfter,
    treeUntouched: lintBefore !== null && lintBefore === lintAfter,
    ...(lint.ok ? {} : { error: lint.error }),
  })

  // --- 8. the brief is buildable and inside budget --------------------------
  const brief = await callTool(ctx, agent, 'mem_brief', {})
  record({
    name: 'smoke/stage',
    stage: 'brief-tool',
    ok: brief.ok && typeof brief.value?.text === 'string' && brief.value?.truncated === false,
    charCount: brief.ok ? (brief.value?.charCount ?? null) : null,
    textChars: brief.ok && typeof brief.value?.text === 'string' ? [...brief.value.text].length : null,
    indexStatus: brief.ok ? (brief.value?.indexState?.status ?? null) : null,
    hotItems: brief.ok ? (brief.value?.hotItems?.length ?? null) : null,
    truncated: brief.ok ? brief.value?.truncated === true : null,
    ...(brief.ok ? {} : { error: brief.error }),
  })

  // --- 9. one in-context LLM round trip, for contrast with the worker -------
  if (process.env.DSH_OBSIDIAN_MEM_SMOKE_LLM_PROBE === '1') await probeLlm(ctx)

  // --- 10. a log entry lands in the vault -----------------------------------
  const log = await callTool(ctx, agent, 'mem_log', { text: '冒烟日志：记录一条完成回合之外的运行事实。' })
  record({
    name: 'smoke/stage',
    stage: 'log-write',
    ok: log.ok && Array.isArray(log.value?.paths) && log.value.paths.length > 0,
    paths: log.ok ? (log.value?.paths ?? null) : null,
    ...(log.ok ? {} : { error: log.error }),
  })
}

// ---------------------------------------------------------------------------
// The durability hold
// ---------------------------------------------------------------------------

/** The pending job files in the temp queue, right now. */
function pendingJobs() {
  if (QUEUE_ROOT === '') return []
  try {
    return readdirSync(QUEUE_ROOT).filter((fileName) => fileName.endsWith('.json'))
  } catch {
    return []
  }
}

/** The result receipt of one job, if the worker has written it. */
function findReceipt(jobId) {
  const receiptsRoot = join(QUEUE_ROOT, 'receipts')
  let projects
  try {
    projects = readdirSync(receiptsRoot, { withFileTypes: true })
  } catch {
    return null
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const candidate = join(receiptsRoot, project.name, `${jobId}.json`)
    if (existsSync(candidate)) return candidate
  }
  return null
}

/** A small, record-safe view of one receipt (counts and ids, never note bodies). */
function receiptView(jobId) {
  const path = findReceipt(jobId)
  if (path === null) return null
  try {
    const receipt = JSON.parse(readFileSync(path, 'utf8'))
    return {
      jobId: receipt.jobId,
      projectId: receipt.projectId,
      result: receipt.result,
      dryRun: receipt.dryRun === true,
      attempts: receipt.attempts,
      itemCount: Array.isArray(receipt.items) ? receipt.items.length : 0,
      itemPaths: Array.isArray(receipt.items) ? receipt.items.map((item) => item.path ?? null) : [],
      itemIds: Array.isArray(receipt.items) ? receipt.items.map((item) => item.id ?? null) : [],
      refusedCount: receipt.refusedCount ?? null,
      index: receipt.index ?? null,
      at: receipt.at,
    }
  } catch (error) {
    return { jobId, unreadable: describeError(error).threwMessage }
  }
}

/** The plugin's own host-log lines, which otherwise reach no surface at all. */
function pluginLogs(ctx) {
  try {
    const buffer = ctx?.logger?.buffer
    if (!Array.isArray(buffer)) return null
    return buffer
      .map((message) => ({
        type: String(message?.type ?? ''),
        text: (Array.isArray(message?.args) ? message.args : [message?.args]).map((part) => (typeof part === 'string' ? part : '')).join(' '),
      }))
      .filter((message) => message.text.includes('obsidian-mem'))
      .map((message) => ({ type: message.type, text: message.text.slice(0, 300) }))
      .slice(-40)
  } catch {
    return null
  }
}

/** A record-safe view of one pending job: state and error codes, never its input text. */
function jobView(jobId) {
  if (jobId === null || QUEUE_ROOT === '') return null
  try {
    const job = JSON.parse(readFileSync(join(QUEUE_ROOT, `${jobId}.json`), 'utf8'))
    return {
      jobId: job.jobId,
      sessionId: job.sessionId,
      projectId: job.projectId,
      fromSeq: job.fromSeq,
      toSeq: job.toSeq,
      state: job.state,
      attempts: job.attempts,
      deferredReason: job.deferredReason ?? null,
      route: job.route ?? null,
      outputState: job.output?.state ?? null,
      lastErrorCode: job.lastError?.code ?? null,
      lastErrorName: job.lastError?.name ?? null,
      lastErrorMessage: typeof job.lastError?.message === 'string' ? job.lastError.message.slice(0, 200) : null,
      lastErrorAt: job.lastError?.at ?? null,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      failedAt: job.failedAt ?? null,
      nextAttemptAt: job.nextAttemptAt ?? null,
      safeInputChars: typeof job.safeInput === 'string' ? job.safeInput.length : null,
      allowedEvents: Array.isArray(job.allowedEvents) ? job.allowedEvents.length : null,
    }
  } catch (error) {
    return { jobId, unreadable: describeError(error).threwMessage }
  }
}

/** What this context can still see: plugin tools, and two host services for baseline. */
function serviceVisibility(ctx) {
  const registry = typeof ctx.get === 'function' ? ctx.get('tools') : undefined
  return {
    registered: registry !== undefined && registry !== null,
    toolsVisible: registry === undefined || registry === null ? null : TOOL_NAMES.filter((toolName) => registry.get(toolName) !== undefined),
    hasLlm: typeof ctx.get === 'function' ? ctx.get('llm') !== undefined : null,
    hasSessions: typeof ctx.get === 'function' ? ctx.get('sessions') !== undefined : null,
  }
}

/**
 * One in-context LLM round trip, recorded as metadata only.
 *
 * The queue worker's distill call runs from a bare timer, i.e. outside any Cordis
 * invocation. This probe runs inside the first `agent/pre-step` waterfall, where
 * P0 measured the route working, so the two outcomes can be compared directly:
 * if this says `stop` while the worker says `aborted`, the difference is the call
 * context and not the credential or the route.
 *
 * @param {object} ctx - the Cordis context.
 * @returns {Promise<void>}
 */
async function probeLlm(ctx) {
  const llm = ctx.get('llm')
  if (llm === null || llm === undefined || typeof llm.stream !== 'function') {
    record({ name: 'smoke/llm-probe', ok: false, reason: 'no-llm-service' })
    return
  }
  const provider = process.env.DSH_SMOKE_DISTILL_PROVIDER ?? 'deepseek-official'
  const model = process.env.DSH_SMOKE_DISTILL_MODEL ?? 'deepseek-flash'
  const started = Date.now()
  const entry = { name: 'smoke/llm-probe', provider, model, finishKind: null, failureCode: null, textChars: 0, chunks: 0 }
  try {
    const stream = await llm.stream({
      provider,
      model,
      system: 'Compatibility probe. Answer with one word.',
      messages: [{ id: randomUUID(), role: 'user', content: [{ type: 'text', text: 'Reply with the single word OK.' }], source: { kind: 'user' } }],
      maxTokens: 64,
      signal: AbortSignal.timeout(60000),
    })
    for await (const chunk of stream) {
      entry.chunks += 1
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') entry.textChars += chunk.text.length
      if (chunk?.type === 'finish') {
        entry.finishKind = chunk.reason?.kind ?? null
        entry.failureCode = chunk.reason?.failure?.code ?? null
      }
    }
    entry.ok = entry.finishKind === 'stop'
  } catch (error) {
    entry.ok = false
    Object.assign(entry, describeError(error))
  }
  entry.ms = Date.now() - started
  record(entry)
}

/**
 * Hold the process open until the completed turn's outcome is durable.
 *
 * The queue worker's own timer is `unref()`-ed (it must never be the reason a
 * host process stays alive), so a headless run can otherwise exit before the
 * worker applies the job it just captured. This driver keeps a *referenced*
 * interval alive on purpose, and that is the only thing the smoke needs from it.
 * The vault tree is hashed on both sides of the apply, so "the dry run wrote
 * nothing" and "the live apply wrote something" are both observed facts.
 */
function holdUntilDurable(ctx, agentOf) {
  if (QUEUE_ROOT === '') {
    record({ name: 'smoke/hold', ok: false, reason: 'no-dsh-home' })
    return
  }
  const started = Date.now()
  const budgetMs = Number(process.env.DSH_OBSIDIAN_MEM_SMOKE_HOLD_MS ?? '') > 0
    ? Number(process.env.DSH_OBSIDIAN_MEM_SMOKE_HOLD_MS)
    : 90_000
  const deadline = started + budgetMs
  let jobId = null
  let treeAtJob = null
  let lastState = null
  let nextJobsPoll = 0
  let nextToolsPoll = 0
  // Decisive probe: are unref'd timers starved in this process? The queue
  // worker's retry is an unref'd timer, so if these never fire, a stranded job
  // is the host's event loop and not the plugin's scheduling.
  for (const delay of [500, 1500, 5000]) {
    const probe = setTimeout(() => record({ name: 'smoke/unref-timer', delay, ms: Date.now() - started }), delay)
    if (typeof probe.unref === 'function') probe.unref()
  }
  const timer = setInterval(async () => {
    if (jobId === null) {
      const jobs = pendingJobs()
      if (jobs.length > 0) {
        jobId = jobs[0].replace(/\.json$/, '')
        treeAtJob = hashTree()
        record({ name: 'smoke/hold', ok: true, action: 'job-observed', jobId, ms: Date.now() - started, job: jobView(jobId) })
        if (KILL_ON_TURN_END) {
          clearInterval(timer)
          // The job file is durable; now interrupt the process for real.
          process.kill(process.pid, 'SIGKILL')
          return
        }
      }
    } else {
      // The pass that touches the job is the observation the smoke otherwise
      // cannot make: a stranded job never leaves `pending`.
      const view = jobView(jobId)
      const signature = view === null ? null : `${view.state}|${view.attempts}|${view.deferredReason}|${view.lastErrorCode}`
      if (signature !== lastState) {
        lastState = signature
        record({ name: 'smoke/poll', jobId, ms: Date.now() - started, job: view })
      }
      const clock = Date.now()
      if (clock >= nextToolsPoll) {
        nextToolsPoll = clock + 5000
        record({ name: 'smoke/tools-poll', ms: clock - started, ...serviceVisibility(ctx) })
      }
      // Ask the plugin's own `mem_admin(action="jobs")` every few seconds: it is
      // the queue as the plugin reads it, which distinguishes "the worker never
      // passed" from "the worker's own reader refuses this file".
      if (clock >= nextJobsPoll && agentOf() !== null) {
        nextJobsPoll = clock + 5000
        const listing = await callTool(ctx, agentOf(), 'mem_admin', { action: 'jobs' })
        record({
          name: 'smoke/jobs-listing',
          ms: clock - started,
          ok: listing.ok,
          status: listing.ok ? (listing.value?.result?.status ?? null) : null,
          failed: listing.ok ? (listing.value?.result?.failed ?? null) : null,
          jobs: listing.ok ? (listing.value?.result?.jobs ?? null) : null,
          ...(listing.ok ? {} : { error: listing.error }),
        })
      }
      if (WAIT_RECEIPT) {
        const receipt = receiptView(jobId)
        if (receipt !== null) {
          clearInterval(timer)
          record({
            name: 'smoke/hold',
            ok: true,
            action: 'receipt',
            jobId,
            ms: Date.now() - started,
            receipt,
            treeHashAtJob: treeAtJob,
            treeHashAtReceipt: hashTree(),
            vaultChangedByApply: treeAtJob !== hashTree(),
            logs: pluginLogs(ctx),
          })
          return
        }
      }
    }
    if (Date.now() > deadline) {
      clearInterval(timer)
      record({
        name: 'smoke/hold',
        ok: false,
        reason: 'timeout',
        jobId,
        ms: Date.now() - started,
        job: jobView(jobId),
        logs: pluginLogs(ctx),
      })
    }
  }, 100)
}

// ---------------------------------------------------------------------------
// Lifecycle witnessing
// ---------------------------------------------------------------------------

/** Apply the driver's lifecycle listeners to one Cordis context. */
export function apply(ctx) {
  let scenarioRan = false
  let firstRequestSeen = false
  let briefsBeforeFirstRequest = 0
  let briefsTotal = 0
  let holdStarted = false
  let liveAgent = null

  record({
    name: 'smoke/apply',
    scenario: RUN_SCENARIO,
    waitReceipt: WAIT_RECEIPT,
    killOnTurnEnd: KILL_ON_TURN_END,
    dshHomeIsTemp: DSH_HOME.startsWith(tmpdir()) || DSH_HOME.startsWith('/tmp/') || DSH_HOME.startsWith('/private/tmp/'),
  })

  // The host wires `ctx.logger` to a level-1 filter, so `warn` (2) and `debug`
  // (3) are dropped and never even buffered (P0 §7.5 measured this). Installing
  // one exporter is the documented way to see them, and a plugin warning is
  // exactly the evidence this smoke needs when a pass fails silently.
  const logger = typeof ctx.get === 'function' ? (ctx.get('logger') ?? ctx.logger) : ctx.logger
  if (logger !== null && logger !== undefined && typeof logger.exporter === 'function') {
    try {
      ctx.effect(() => logger.exporter({
        levels: { default: 3 },
        export: (message) => {
          const text = (Array.isArray(message?.args) ? message.args : [message?.args])
            .map((part) => (typeof part === 'string' ? part : ''))
            .join(' ')
          // Only this plugin's own diagnostics: the record stays free of any
          // unrelated host chatter.
          if (!text.includes('obsidian-mem')) return
          record({ name: 'smoke/log', level: String(message?.type ?? ''), text: text.slice(0, 400) })
        },
      }), 'obsidian-mem-smoke-driver log exporter')
      record({ name: 'smoke/log-exporter', installed: true })
    } catch (error) {
      record({ name: 'smoke/log-exporter', installed: false, error: describeError(error).threwMessage })
    }
  } else {
    record({ name: 'smoke/log-exporter', installed: false, reason: 'no-exporter-api' })
  }

  ctx.on('session/event', (session, event) => {
    const id = session.header.id
    if (event.type === 'request/header') {
      firstRequestSeen = true
      return
    }
    if (event.type === 'user/message') {
      const source = event.data?.source
      if (source?.plugin !== 'obsidian-mem') return
      const content = Array.isArray(event.data?.content) ? event.data.content : []
      const text = content.map((block) => (block?.type === 'text' ? String(block.text ?? '') : '')).join('')
      briefsTotal += 1
      if (!firstRequestSeen) briefsBeforeFirstRequest += 1
      // Metadata only: the brief's text is never recorded.
      record({
        name: 'smoke/recall',
        id,
        seq: event.seq,
        form: typeof source.form === 'string' ? source.form : null,
        chars: [...text].length,
        sha256: sha256(text),
        beforeFirstRequest: !firstRequestSeen,
        briefsBeforeFirstRequest,
        briefsTotal,
      })
      return
    }
    if (event.type === 'turn/end') {
      record({
        name: 'smoke/turn',
        id,
        seq: event.seq,
        turn: typeof event.data?.turn === 'number' ? event.data.turn : null,
        reason: typeof event.data?.reason?.kind === 'string' ? event.data.reason.kind : null,
      })
      if ((WAIT_RECEIPT || KILL_ON_TURN_END) && event.data?.reason?.kind === 'completed' && !holdStarted) {
        holdStarted = true
        // Deferred one tick so the capture notification path is not re-entered
        // from inside its own append callback.
        setTimeout(() => holdUntilDurable(ctx, () => liveAgent), 0)
      }
    }
  })

  // The awaited flush barrier fires inside a Cordis invocation, so it is the
  // in-band baseline the out-of-band interval polls are compared against.
  ctx.on('session/flush', (session) => {
    record({ name: 'smoke/flush', seq: session.seq, ...serviceVisibility(ctx) })
  })

  ctx.on('agent/pre-step', async ({ agent, turn, step, signal }, next) => {
    liveAgent = agent
    const decision = await next()
    if (!scenarioRan && RUN_SCENARIO && turn === 1) {
      scenarioRan = true
      try {
        await runScenario(ctx, agent)
      } catch (error) {
        record({ name: 'smoke/stage', stage: 'scenario', ok: false, ...describeError(error) })
      }
    }
    record({
      name: 'smoke/pre-step',
      id: agent.session.header.id,
      turn,
      step,
      decisionKind: decision?.kind ?? null,
      decisionMessages: Array.isArray(decision?.messages) ? decision.messages.length : 0,
      pluginMessagesInDecision: Array.isArray(decision?.messages)
        ? decision.messages.filter((message) => message?.source?.plugin === 'obsidian-mem').length
        : 0,
      aborted: signal?.aborted === true,
    })
    return decision
  })
}
