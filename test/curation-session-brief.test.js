// The DSH automatic recall entrance consumes the curation view (Task 4 + Task 6).
//
// The view is written by every pass and read at `services.brief` — which is what the
// Codex side and the tool call. DSH's session start does not go through that service:
// it composes its brief through the `buildBrief` seam `lib/index.js` hands to
// `registerHooks`, and that seam had no view at all, so on DSH the view was written by
// every pass and read by nobody. These cases mount the shipped plugin (`apply`) on a
// real Cordis context, drive a real `agent/pre-step`, and assert that the injected
// brief is the view's — and that one changed byte falls it back to the source path.
//
// Without the assembly's own read, the first case fails on the missing
// `记忆视图（引用数据）` heading; the second is the half that keeps the wiring honest.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import toolsPlugin from '@deepseek-ai/dsh-tools'

import { scanCuration } from '../lib/curation-scan.js'
import { buildCurationView } from '../lib/curation-view.js'
import { apply } from '../lib/index.js'
import { resolveBinding } from '../lib/vault.js'
import { makeCurationWorld } from './curation-world.js'

/** A sentence only the view's bounded description renders; the source list shows titles. */
const VIEW_ONLY = '只有视图会渲染这句话'

/** The view section's heading, and the source section it replaces. */
const VIEW_HEADING = '记忆视图（引用数据）'
const SOURCE_HEADING = '最近决策 / 踩坑（引用数据）'

/**
 * A bound world with a complete stored view, and the shipped plugin mounted on it.
 *
 * `autoCurate: false` on the plugin row on purpose: this file is about the brief, and
 * an automatic pass rewriting the view mid-case would make the two assertions race a
 * background write. The view the cases read is the one this setup wrote.
 *
 * @param {object} t - the node:test context.
 * @returns {Promise<{world: object, written: object, binding: object, ctx: object}>} the bed.
 */
async function sessionBriefBed(t) {
  const world = await makeCurationWorld(t)
  const written = await world.services.write({
    type: 'decision',
    title: '视图消费探针',
    body: `${VIEW_ONLY}。\n`,
  })
  const binding = await resolveBinding({
    cwd: world.repo,
    vaultRoot: world.vault,
    mode: 'show',
    home: world.home,
  })
  assert.equal(binding.kind, 'bound', JSON.stringify(binding))
  // The shipped 500 ms bound belongs to a session-hook pass; this bed's claim is
  // that the view it stores is complete, so the deadline is set where a busy
  // machine cannot reach it (the same reasoning `test/integration-write-read.test.js`
  // records for its own view). Without it, running this file beside the rest of the
  // suite turns `complete` into a coin toss about CPU share, not about the code.
  const scan = await scanCuration(binding, {
    dataRoot: world.dataRoot,
    home: world.home,
    maxNotes: 1000,
    maxMs: 60_000,
  })
  assert.equal(scan.complete, true)
  assert.equal(
    (await buildCurationView({ binding, dataRoot: world.dataRoot, scan })).status,
    'written',
  )
  // One handle per private index at a time: the world's services opened one during
  // setup and `apply` opens its own for the same project.
  await world.services.close()

  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = world.dshHome
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  })

  const ctx = new Context()
  ctx.provide('systemPrompt', { tools: () => () => {} })
  const fork = ctx.plugin(toolsPlugin)
  await fork
  // Mounted in its own fiber, the way the host mounts a plugin (test/assets.test.js
  // does the same). Two reasons, both load-bearing on Windows:
  //
  //   * `registerTools` opens the project index and closes it through a fiber
  //     effect. An `apply(ctx, …)` on the root context hands back only the hook
  //     disposer, so those handles outlive the whole case; a fiber disposal runs
  //     that effect.
  //   * The world registers its `rm` before this bed runs, and `node:test` runs
  //     `t.after` hooks in registration order — so the removal would otherwise
  //     execute first, while the sqlite handle is still open, and Windows answers
  //     `EBUSY` (a retrying removal that never finishes). This machine measured
  //     the stalled removal; POSIX deletes an open file happily, which is why only
  //     Windows hung. The bed therefore has to be torn down *inside* the case,
  //     before the fixture's own hook can run: `close()` below.
  const memory = ctx.plugin({
    name: 'obsidian-mem-probe',
    apply: (inner) => apply(inner, { vaultPath: world.vault, autoCurate: false }),
  })
  await memory
  return {
    world,
    written,
    binding,
    ctx,
    async close() {
      await memory.dispose()
      await fork.dispose().catch(() => {})
    },
  }
}

/**
 * Drive one fresh session's pre-step and return everything it injected, as text.
 *
 * A fresh session id per call on purpose: the hook's state is per session, and a
 * second call on the same one would take the delta path rather than compose a brief.
 *
 * @param {object} ctx - the mounted context.
 * @param {object} world - the bed's world.
 * @returns {Promise<string>} the injected messages, joined.
 */
async function injectedBrief(ctx, world) {
  const agent = { session: { header: { id: `sess-${randomUUID()}`, cwd: world.repo } } }
  const decision = await ctx.waterfall(
    'agent/pre-step',
    { agent, messages: [], turn: 1, step: 1, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [] }),
  )
  const messages = Array.isArray(decision?.messages) ? decision.messages : []
  return messages.map((message) => message?.content?.[0]?.text ?? '').join('\n')
}

test('a DSH session start composes its brief from a complete stored view', async (t) => {
  const bed = await sessionBriefBed(t)
  const { world, written, ctx } = bed
  try {
    const text = await injectedBrief(ctx, world)
    assert.ok(text.includes(VIEW_HEADING), text)
    assert.ok(text.includes(written.path), text)
    // The view's bounded description is what the session reads, and the source section
    // it replaced is not there at all — so the heading above is the view's, not the
    // source list's.
    assert.ok(text.includes(VIEW_ONLY), text)
    assert.equal(text.includes(SOURCE_HEADING), false, text)
  } finally {
    // Closes the index before the world's own `t.after` removes the tree (Windows:
    // an open sqlite handle makes that removal EBUSY). See `sessionBriefBed`.
    await bed.close()
  }
})

test('one changed byte falls the DSH session brief back to the source path', async (t) => {
  const bed = await sessionBriefBed(t)
  const { world, written, ctx } = bed
  try {
    const absolute = join(world.vault, ...written.path.split('/'))
    const raw = await readFile(absolute, 'utf8')
    await writeFile(absolute, `${raw}\n补充一行。\n`, 'utf8')

    const text = await injectedBrief(ctx, world)
    assert.equal(text.includes(VIEW_HEADING), false, text)
    assert.ok(text.includes(SOURCE_HEADING), text)
    // The source list renders a wikilink, which drops the `.md`; the path is asserted
    // without it so the check is about the note and not about the rendering form.
    assert.ok(text.includes(written.path.replace(/\.md$/u, '')), text)
  } finally {
    // Closes the index before the world's own `t.after` removes the tree (Windows).
    await bed.close()
  }
})
