// Spec §1/§2 end to end: the brief emits a receipt, the host observes a committed
// insertion, the acknowledgement advances only those units, an unchanged
// generation gets at most two automatic continuations, and the convention
// preview rotates across sessions. Every case runs against a real temporary
// vault, the shipped buildBrief/openIndex/updateHot and the shipped hooks; the
// Codex case runs the shipped SessionStart hook with a synthetic rollout, and
// nothing here reads or writes a real vault, a real home or a real ~/.dsh.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { buildBrief, pageBrief } from '../lib/brief.js'
import { validateConfig } from '../lib/config.js'
import { updateHot } from '../lib/hot.js'
import { openIndex } from '../lib/index-db.js'
import { registerHooks } from '../lib/hooks.js'
import { ackDelivery, readDeliveryState } from '../lib/delivery-state.js'
import { readConventionCursor } from '../lib/convention-rotation.js'
import { createMemoryServices } from '../lib/tools.js'
import { bootstrapVault } from '../lib/vault.js'
import { runHook } from '../codex/session-start.mjs'

const PROJECT_ID = '1c392abb-7b08-42f7-871d-2a379caf9448'
const RELATIVE_DIR = 'Projects/demo--1c392abb'
const PRODUCER = 'plugin:obsidian-mem'
const BUDGET = 6000
const HOT_CAPACITY = 9000

/** A throwaway vault, data root, home and repository. */
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'obsidian-mem-delivery-int-'))
  const vault = join(root, 'vault')
  const dataRoot = join(root, 'data')
  const home = join(root, 'home')
  const repo = join(root, 'repo')
  await mkdir(dataRoot, { recursive: true })
  await mkdir(home, { recursive: true })
  await mkdir(repo, { recursive: true })
  const binding = {
    kind: 'bound',
    projectId: PROJECT_ID,
    slug: 'demo',
    displayName: 'Demo Project',
    schema: 1,
    vaultRoot: vault,
    repoRoot: repo,
    relativeDir: RELATIVE_DIR,
  }
  await bootstrapVault(binding, { dataRoot, home })
  let index = null
  t.after(async () => {
    if (index !== null) await index.close().catch(() => {})
    await rm(root, { recursive: true, force: true, maxRetries: 4 })
  })
  const open = async () => {
    if (index === null)
      index = await openIndex({
        vaultRoot: vault,
        dataRoot,
        backend: 'sqlite',
        projectId: PROJECT_ID,
      })
    return index
  }
  return { root, vault, dataRoot, home, repo, binding, open }
}

/** Add one hot entry through the shipped writer. */
async function addHot(env, section, text) {
  return updateHot(env.binding, { section, text }, { dataRoot: env.dataRoot, home: env.home })
}

/** The config the brief and the hooks are built with. */
function configOf(budget = BUDGET) {
  return {
    briefBudgetChars: budget,
    hotCapacityChars: HOT_CAPACITY,
    recallBudgetChars: 900,
    injectBrief: true,
  }
}

/** One full/delta/continuation brief with an optional delivery context. */
async function brief(env, options = {}) {
  return buildBrief(env.binding, {
    index: await env.open(),
    config: options.config ?? configOf(),
    ...(options.mode === undefined ? {} : { mode: options.mode }),
    ...(options.previousHotItems === undefined
      ? {}
      : { previousHotItems: options.previousHotItems }),
    ...(options.delivery === undefined ? {} : { delivery: options.delivery }),
    home: env.home,
  })
}

const codePoints = (text) => [...text].length
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')
/** The exact message hash an automatic brief's insertion would carry. */
const hashOf = (value) => sha256(value.text)

/** A session-event proof, the shape the DSH hook observes after a committed insertion. */
const eventProof = { kind: 'session-event', verified: true, sourceKind: PRODUCER }

/**
 * A DSH-shaped session harness: the real hooks over the real brief, with a
 * stubbed binding/index seam (the test's temporary fixture is the binding).
 *
 * @param {object} t - the node:test context.
 * @param {object} env - the fixture.
 * @returns {object} the harness.
 */
function dshBed(t, env, options = {}) {
  const ctx = new Context()
  const config = options.config ?? configOf()
  const build =
    options.buildBrief ?? ((binding, opts) => buildBrief(binding, { ...opts, home: env.home }))
  const disposers = registerHooks(ctx, {
    resolveBinding: async () => options.binding ?? env.binding,
    index: async () => env.open(),
    buildBrief: build,
    config,
    dataRoot: env.dataRoot,
    home: env.home,
  })
  t.after(async () => {
    for (const dispose of disposers) await dispose()
  })
  const agentFor = (id) => ({ session: { header: { id, cwd: env.repo } } })
  return {
    ctx,
    config,
    start(id, source = 'startup') {
      const agent = agentFor(id)
      ctx.emit('agent/session-start', { agent, source })
      return agent
    },
    preStep(id, turn = 1, step = 1) {
      const agent = agentFor(id)
      return ctx.waterfall(
        'agent/pre-step',
        { agent, messages: [], turn, step, signal: new AbortController().signal },
        async () => ({ kind: 'enter', messages: [] }),
      )
    },
    /** Emit the committed user/message the host writes after the brief is injected. */
    committed(id, text) {
      ctx.emit(
        'session/event',
        { header: { id } },
        {
          type: 'user/message',
          seq: 8,
          data: { source: { kind: PRODUCER, form: 'recall' }, content: [{ type: 'text', text }] },
        },
      )
    },
  }
}

/** The one recall message of a decision, or null. */
function recallOf(decision) {
  const messages = (decision?.messages ?? []).filter(
    (message) => message?.source?.kind === PRODUCER,
  )
  if (messages.length === 0) return null
  return messages[0].content[0].text
}

/** Wait for a fire-and-forget acknowledgement to land, bounded. */
async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return true
    if (Date.now() > deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/** The delivery state of one session. */
async function deliveryState(env, sessionKey, epoch) {
  const read = await readDeliveryState({
    binding: env.binding,
    dataRoot: env.dataRoot,
    sessionKey,
    epoch,
    home: env.home,
  })
  return read.state
}

// ---------------------------------------------------------------------------
// buildBrief: the receipt, oversized units, continuation
// ---------------------------------------------------------------------------

test('a full brief returns the exact emitted identities and persists a pending receipt', async (t) => {
  const env = await fixture(t)
  await addHot(env, '强约束', '所有写入必须幂等')
  await addHot(env, '进行中', '实现 delivery receipt')
  const delivery = { dataRoot: env.dataRoot, sessionKey: 'session-int-1', epoch: 1, turn: 1 }
  const built = await brief(env, { delivery })
  assert.equal(built.delivery.emitted.length, 2)
  assert.deepEqual(
    built.delivery.emitted.map((unit) => unit.id).sort(),
    built.hotItems.map((item) => item.id).sort(),
  )
  for (const unit of built.delivery.emitted) {
    assert.match(unit.version, /^[0-9a-f]{64}$/u)
  }
  assert.equal(built.delivery.removed.length, 0)
  assert.equal(built.delivery.omitted, 0)
  assert.equal(built.delivery.oversized.length, 0)
  assert.equal(built.text.includes(built.delivery.emitted[0].id), true)
  const state = await deliveryState(env, 'session-int-1', 1)
  assert.equal(state.pending.length, 1)
  assert.deepEqual(state.acked, {}, 'preparation advances nothing')
  // The receipt hash is the hash of the exact text the host will commit.
  assert.equal(state.pending[0].messageHash, hashOf(built))
  assert.deepEqual(state.pending[0].emitted, built.delivery.emitted)
})

test('a committed insertion acknowledges exactly the emitted units, idempotently', async (t) => {
  const env = await fixture(t)
  await addHot(env, '进行中', 'ack 只推进真实插入的单位')
  const delivery = { dataRoot: env.dataRoot, sessionKey: 'session-int-2', epoch: 1, turn: 1 }
  const built = await brief(env, { delivery })
  const ack = (hash, proof = eventProof) =>
    ackDelivery({
      binding: env.binding,
      dataRoot: env.dataRoot,
      sessionKey: 'session-int-2',
      epoch: 1,
      messageHash: hash,
      proof,
      producerKind: PRODUCER,
      home: env.home,
    })
  const first = await ack(hashOf(built))
  assert.equal(first.acknowledged, true)
  const after = await deliveryState(env, 'session-int-2', 1)
  const expected = Object.fromEntries(built.delivery.emitted.map((unit) => [unit.id, unit.version]))
  assert.deepEqual(after.acked, expected)
  const again = await ack(hashOf(built))
  assert.equal(again.duplicate, true)
  assert.equal(again.acknowledged, false)
  // A proof that is not this plugin's committed message changes nothing.
  const other = await brief(env, { delivery: { ...delivery, sessionKey: 'session-int-2' } })
  const bad = await ack(hashOf(other), {
    kind: 'session-event',
    verified: true,
    sourceKind: 'plugin:other',
  })
  assert.equal(bad.conflict, true)
})

test('an oversized first unit is skipped, reported with a route, and later units still arrive', async (t) => {
  const env = await fixture(t)
  await addHot(env, '强约束', 'x'.repeat(1200))
  await addHot(env, '强约束', '正常约束')
  await addHot(env, '进行中', '正常进行')
  const delivery = { dataRoot: env.dataRoot, sessionKey: 'session-int-3', epoch: 1, turn: 1 }
  const built = await brief(env, { delivery, config: configOf(1000) })
  assert.equal(built.delivery.oversized.length, 1)
  assert.equal(built.delivery.oversized[0].chars > 1000, true)
  assert.ok(!built.text.includes('x'.repeat(1200)), 'the giant unit is never clipped into the text')
  assert.ok(built.text.includes(built.delivery.oversized[0].id), 'the notice names the id')
  assert.ok(built.text.includes('正常约束'))
  assert.ok(built.text.includes('正常进行'))
  assert.deepEqual(
    built.delivery.emitted.map((unit) => unit.id),
    built.hotItems
      .filter((item) => item.id !== built.delivery.oversized[0].id)
      .map((item) => item.id),
  )
})

test('an unchanged generation continues at most twice, once per turn, then answers with a cursor', async (t) => {
  const env = await fixture(t)
  for (let index = 0; index < 16; index += 1) {
    await addHot(
      env,
      '进行中',
      '续读条目-' + String(index).padStart(2, '0') + '-' + '内容'.repeat(30),
    )
  }
  const delivery = { dataRoot: env.dataRoot, sessionKey: 'session-int-4', epoch: 1, turn: 1 }
  const config = configOf(700)
  const full = await brief(env, { delivery, config })
  assert.equal(full.delivery.continuation.available, true)
  assert.match(full.delivery.continuation.cursor, /^hd1:/u)
  assert.ok(full.delivery.emitted.length < full.hotItems.length)

  /** The acknowledgement of one prepared message, as the DSH hook would observe it. */
  const ack = (value) =>
    ackDelivery({
      binding: env.binding,
      dataRoot: env.dataRoot,
      sessionKey: 'session-int-4',
      epoch: 1,
      messageHash: sha256(value.text),
      proof: eventProof,
      producerKind: PRODUCER,
      home: env.home,
    })

  // Before the full brief is observed, the plan is not spendable (spec §1): the
  // continuation would name units the model may never have received.
  const beforeAck = await brief(env, { mode: 'continuation', delivery, config })
  assert.equal(beforeAck.text, '')
  assert.equal(full.delivery.continuation.acknowledged, false)
  assert.equal((await ack(full)).continuationAcknowledged, true)

  const first = await brief(env, { mode: 'continuation', delivery, config })
  assert.notEqual(first.text, '')
  assert.ok(first.delivery.emitted.length > 0)
  const firstIds = new Set(full.delivery.emitted.map((unit) => unit.id))
  for (const unit of first.delivery.emitted) {
    assert.equal(firstIds.has(unit.id), false, 'a continuation never re-sends an emitted unit')
  }
  // Within one user turn there is at most one continuation preparation.
  const sameTurn = await brief(env, { mode: 'continuation', delivery, config })
  assert.equal(sameTurn.text, '')
  assert.equal((await ack(first)).acknowledged, true)

  const turn2 = { ...delivery, turn: 2 }
  const second = await brief(env, { mode: 'continuation', delivery: turn2, config })
  assert.notEqual(second.text, '')
  assert.ok(second.delivery.emitted.length > 0)
  for (const unit of second.delivery.emitted) {
    assert.equal(firstIds.has(unit.id), false)
  }
  assert.equal((await ack(second)).acknowledged, true)
  const state = await deliveryState(env, 'session-int-4', 1)
  assert.equal(state.continuation.acked, 2)
  const third = await brief(env, {
    mode: 'continuation',
    delivery: { ...delivery, turn: 3 },
    config,
  })
  assert.equal(third.text, '', 'the allowance is two')
})

test('a cursor page is bounded and a changed hot source is a stale continuation with a fresh handle', async (t) => {
  const env = await fixture(t)
  for (let index = 0; index < 8; index += 1) {
    await addHot(env, '进行中', '游标条目-' + index + '-' + '内容'.repeat(30))
  }
  const delivery = { dataRoot: env.dataRoot, sessionKey: 'session-int-5', epoch: 1, turn: 1 }
  const built = await brief(env, { delivery, config: configOf(700) })
  assert.equal(built.delivery.continuation.available, true)
  const cursor = built.delivery.continuation.cursor
  const page = await pageBrief(env.binding, {
    section: 'hot',
    cursor,
    limit: 2,
    index: await env.open(),
    config: configOf(700),
    home: env.home,
  })
  assert.equal(page.total, 8)
  assert.equal(page.lines.length, 2)
  assert.ok(built.delivery.continuation.offset <= page.offset)

  await addHot(env, '进行中', '游标条目-新增')
  const staleIndex = await env.open()
  await assert.rejects(
    () => pageBrief(env.binding, { section: 'hot', cursor, index: staleIndex, home: env.home }),
    (error) =>
      error.code === 'stale-continuation' &&
      /cursor="hd1:/u.test(error.message) &&
      Boolean(error.freshCursor),
  )
})

// ---------------------------------------------------------------------------
// DSH hooks: prepare, observe, acknowledge; rotation across sessions
// ---------------------------------------------------------------------------

test('the DSH pre-step prepares, the committed user/message acknowledges, and only then the next continuation may fire', async (t) => {
  const env = await fixture(t)
  for (let index = 0; index < 6; index += 1) {
    await addHot(env, '进行中', 'hook 条目-' + index + '-' + '内容'.repeat(40))
  }
  const bed = dshBed(t, env, { config: configOf(700) })
  const session = 'session-hooks-1'
  bed.start(session)
  const first = await bed.preStep(session, 1)
  const text = recallOf(first)
  assert.ok(
    text !== null && text.includes('obsidian-mem:brief mode=full'),
    'the full brief was injected',
  )
  assert.equal(
    (await deliveryState(env, session, 1)).acked
      ? Object.keys((await deliveryState(env, session, 1)).acked).length
      : 0,
    0,
  )
  assert.equal((await deliveryState(env, session, 1)).pending.length, 1)

  // The same turn may not spend a continuation preparation.
  const sameTurn = await bed.preStep(session, 1, 2)
  assert.equal(recallOf(sameTurn), null)

  // A later turn after an UNOBSERVED full brief must not continue. Nothing proves
  // the model received the emitted units, so the untouched window is not skipped.
  const beforeAck = await deliveryState(env, session, 1)
  assert.equal(beforeAck.continuation.acknowledged, false)
  const unprepared = await bed.preStep(session, 2)
  assert.equal(
    recallOf(unprepared),
    null,
    'no continuation may fire before the full brief is acknowledged',
  )
  const afterBlocked = await deliveryState(env, session, 1)
  assert.equal(afterBlocked.continuation.offset, beforeAck.continuation.offset)
  assert.equal(afterBlocked.pending.length, 1, 'the blocked turn prepared nothing')

  // The host commits the injected message: that is the observation the ack needs.
  bed.committed(session, text)
  const acknowledged = await waitFor(async () => {
    const state = await deliveryState(env, session, 1)
    return state.continuation?.acknowledged === true && Object.keys(state.acked).length > 0
  })
  assert.equal(acknowledged, true, 'the committed message acknowledged the delivery')
  const afterAck = await deliveryState(env, session, 1)
  assert.equal(afterAck.pending.length, 0)
  assert.equal(afterAck.continuation.acknowledged, true)

  // Turn 3: the acknowledged full brief opens the next unchanged window.
  const second = await bed.preStep(session, 3)
  const continued = recallOf(second)
  assert.ok(
    continued !== null && continued.includes('mode=continuation'),
    'the acknowledged full brief opens the next window',
  )
  const beforeContinuationAck = (await deliveryState(env, session, 1)).continuation.acked
  bed.committed(session, continued)
  assert.equal(
    await waitFor(async () => {
      const state = await deliveryState(env, session, 1)
      return state.pending.length === 0 && state.continuation.acked === beforeContinuationAck + 1
    }),
    true,
    'the committed continuation advanced the window',
  )
})

test('two serial DSH sessions receive different convention windows', async (t) => {
  const env = await fixture(t)
  const conventionsDir = join(env.vault, ...RELATIVE_DIR.split('/'), 'Conventions')
  await mkdir(conventionsDir, { recursive: true })
  const lines = Array.from({ length: 12 }, (_, index) => {
    const number = index + 1
    return '- [[Conventions/约定-' + number + '|约定 ' + number + ']]'
  })
  await writeFile(join(conventionsDir, 'index.md'), lines.join('\n') + '\n', 'utf8')

  const bed = dshBed(t, env)
  const firstSession = 'session-rotation-a'
  bed.start(firstSession)
  const first = recallOf(await bed.preStep(firstSession, 1))
  assert.ok(first !== null && first.includes('约定 1]]') && first.includes('约定 5]]'))
  assert.ok(!first.includes('约定 6]]'))
  bed.committed(firstSession, first)
  assert.equal(
    await waitFor(async () => (await deliveryState(env, firstSession, 1)).pending.length === 0),
    true,
  )
  // The rotation advances after the delivery ack; wait for the cursor itself so
  // the second session cannot race a window the first one already covered.
  assert.equal(
    await waitFor(async () => {
      const cursor = await readConventionCursor({
        binding: env.binding,
        dataRoot: env.dataRoot,
        home: env.home,
      })
      return cursor.state.revision === 1
    }),
    true,
  )

  const secondSession = 'session-rotation-b'
  bed.start(secondSession)
  const second = recallOf(await bed.preStep(secondSession, 1))
  assert.ok(second !== null)
  assert.ok(
    second.includes('约定 6]]'),
    'the second session continues after the acknowledged anchor',
  )
  assert.ok(!second.includes('约定 1]]'))
})

// ---------------------------------------------------------------------------
// Codex: stdout is pending until a trusted hook reconciles the rollout
// ---------------------------------------------------------------------------

/** One rollout line: a developer message carrying the injected text. */
function developerLine(text) {
  return JSON.stringify({
    type: 'response_item',
    payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text }] },
  })
}

/** One rollout line: a tool output that quotes the injected text. */
function toolOutputLine(text) {
  return JSON.stringify({
    type: 'response_item',
    payload: { type: 'function_call_output', output: { text } },
  })
}

/**
 * Open the memory layer for a temporary Codex fixture: the same brief the DSH
 * path builds, with the service seam reduced to what the hook touches.
 *
 * @param {object} env - the fixture.
 * @param {string} cwd - the session directory.
 * @returns {{memory: object, briefs: string[]}} the opened layer and the emitted texts.
 */
function codexMemory(env, cwd) {
  // The REAL service set and index behind the hook, not a stub: this is the path a
  // Codex install takes, including services.brief's internal delivery pass-through
  // (dataRoot + args.delivery into buildBrief). Each hook invocation opens and
  // closes its own layer exactly as the shipped process does.
  const config = validateConfig({ vaultPath: env.vault })
  const services = createMemoryServices({
    config,
    dataRoot: env.dataRoot,
    home: env.home,
    cwd,
  })
  const memory = { dataRoot: env.dataRoot, config, diagnostics: null, services }
  return { memory, cwd }
}

test('a Codex SessionStart writes a pending receipt, and only a structured developer message reconciles it', async (t) => {
  const env = await fixture(t)
  await addHot(env, '进行中', 'Codex 交付回执')
  const repo = env.repo
  execFileSync('git', ['init', '-q'], { cwd: repo })
  // The pointer is written directly with the fixture's project id: a `local` bind
  // would mint a new identity, and the hook path must resolve to the same project
  // the fixture vault is bound to.
  await writeFile(
    join(repo, '.obsidian-mem'),
    JSON.stringify({
      projectId: PROJECT_ID,
      slug: 'demo',
      displayName: 'Demo Project',
      schema: 1,
    }) + '\n',
    'utf8',
  )
  const opened = codexMemory(env, repo)
  const sessionId = 'codex-session-1'
  const rollout = join(env.root, 'rollout.jsonl')
  const first = await runHook(
    JSON.stringify({
      session_id: sessionId,
      transcript_path: rollout,
      cwd: repo,
      hook_event_name: 'SessionStart',
      source: 'startup',
    }),
    {
      open: () => opened.memory,
      out: { write() {} },
      err: { write() {} },
      read: async () => null,
    },
  )
  const injected = first?.hookSpecificOutput?.additionalContext
  assert.equal(typeof injected, 'string')
  const stateAfterPrepare = await deliveryState(env, sessionId, 1)
  assert.equal(stateAfterPrepare.pending.length, 1)
  const firstEmitted = stateAfterPrepare.pending[0].emitted
  assert.ok(firstEmitted.length > 0)

  // A rollout the real resume verdict reads as "the brief was compacted away".
  const sessionMeta = JSON.stringify({ type: 'session_meta', payload: {} })
  const compactedLine = JSON.stringify({ type: 'compacted', payload: { replacement_history: [] } })
  const resumeWith = async (lines) => {
    await writeFile(rollout, [sessionMeta, ...lines, compactedLine].join('\n') + '\n', 'utf8')
    return runHook(
      JSON.stringify({
        session_id: sessionId,
        transcript_path: rollout,
        cwd: repo,
        hook_event_name: 'SessionStart',
        source: 'resume',
      }),
      {
        open: () => opened.memory,
        out: { write() {} },
        err: { write() {} },
        read: async () => ({ text: await readFile(rollout, 'utf8'), truncated: false }),
      },
    )
  }

  // A rollout that only quotes the brief inside tool output cannot acknowledge it.
  await resumeWith([toolOutputLine(injected)])
  const afterQuote = await deliveryState(env, sessionId, 1)
  assert.deepEqual(afterQuote.acked, {}, 'quoted tool output is not evidence')

  // The structured developer message is the trusted evidence: the startup receipt
  // is acknowledged before the new resume brief is prepared.
  await resumeWith([developerLine(injected)])
  const state = await deliveryState(env, sessionId, 1)
  assert.ok(
    Object.keys(state.acked).length > 0,
    'the structured injection acknowledged the receipt',
  )
  for (const unit of firstEmitted) {
    assert.equal(state.acked[unit.id], unit.version)
  }
})

// ---------------------------------------------------------------------------
// The brief itself still carries no delivery field for the tool path
// ---------------------------------------------------------------------------

test('a brief without a delivery context carries no receipt-shaped field and writes no state', async (t) => {
  const env = await fixture(t)
  await addHot(env, '进行中', '无交付上下文的简报')
  const built = await brief(env)
  assert.equal(Object.prototype.hasOwnProperty.call(built, 'delivery'), false)
  assert.ok(codePoints(built.text) <= BUDGET)
})
