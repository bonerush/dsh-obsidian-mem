// Task 13: the idempotent, hash-tracked sync of the packaged skill tree.
//
// Every case below runs against REAL temporary filesystems, because what is
// under test is exactly what `mkdir`, `lstat`, `rename`, `fsync` and `symlink`
// do on this machine — a mocked `fs` could not tell a foreign file from one
// this plugin wrote. Nothing here reads or writes the user's real `~/.dsh`, the
// personal vault or the Hindsight configuration: the target is always a
// `mkdtemp` directory, and the two `apply()` cases point `DSH_HOME` at a
// throwaway root so the shipped default (`$DSH_HOME/skills/obsidian-mem`)
// resolves inside it.
//
// The hash assertions are recomputed here with `node:crypto` from the bytes on
// disk rather than read back out of the plugin's own result, so the manifest
// cannot make its own evidence pass.
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import toolsPlugin from '@deepseek-ai/dsh-tools'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { parse as parseYaml } from 'yaml'

import {
  AssetSyncError,
  MANIFEST_FILENAME,
  SKILL_NAME,
  bundledSkillSourceDir,
  resolveSkillTargetDir,
  syncBundledSkill,
  syncSkill,
} from '../lib/assets.js'
import { apply } from '../lib/index.js'

/** A minimal but valid Agent Skills document — frontmatter, then a body. */
const SKILL_MD = `---
name: obsidian-mem
description: Portable project-memory protocol for a dedicated Obsidian vault.
---

# Obsidian memory
`

/** The six tools the plugin registers. */
const SIX = Object.freeze(['mem_admin', 'mem_brief', 'mem_log', 'mem_read', 'mem_search', 'mem_write'])

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

/** One throwaway directory, removed with the test even when it fails. */
async function tempDir(t, prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 4 }))
  return dir
}

/**
 * A packaged-skill source directory: `sourceDir/` holding the given files, with
 * a valid `SKILL.md` unless the caller supplies its own.
 *
 * @param {import('node:test').TestContext} t - the running test.
 * @param {Record<string, string>} [files] - `relative path -> contents`.
 * @returns {Promise<string>} the source directory.
 */
async function sourceFixture(t, files = {}) {
  const root = await tempDir(t, 'obsidian-mem-t13-src-')
  const source = join(root, SKILL_NAME)
  await mkdir(source, { recursive: true })
  const entries = Object.keys(files).length === 0 ? { 'SKILL.md': SKILL_MD } : files
  for (const [relative, body] of Object.entries(entries)) {
    const absolute = join(source, ...relative.split('/'))
    await mkdir(dirname(absolute), { recursive: true })
    await writeFile(absolute, body)
  }
  return source
}

/** A target path that does NOT exist yet: `<temp root>/obsidian-mem`. */
async function targetFixture(t) {
  return join(await tempDir(t, 'obsidian-mem-t13-dst-'), SKILL_NAME)
}

/** Lowercase hex sha256 of a byte sequence. */
function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Lowercase hex sha256 of a file's current bytes. */
async function hashFile(path) {
  return sha256(await readFile(path))
}

/** `{ relative path -> status }`, the shape the sync result is asserted through. */
function statuses(result) {
  return Object.fromEntries(result.files.map((file) => [file.path, file.status]))
}

/** The manifest the sync wrote into the target directory. */
async function readManifest(targetDir) {
  return JSON.parse(await readFile(join(targetDir, MANIFEST_FILENAME), 'utf8'))
}

/** The agent shape the `agent/pre-step` payload carries. */
function agentFor(cwd) {
  return { session: { header: { id: 'session-t13', cwd } } }
}

/** Poll until `predicate` holds, so an async sync is waited for, never slept on. */
async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return true
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

/** Run `body` with `DSH_HOME` pointed at `root`, restoring the previous value. */
async function withDshHome(t, root, body) {
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = root
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  })
  return body()
}

// ---------------------------------------------------------------------------
// syncSkill: copy, idempotence, updates
// ---------------------------------------------------------------------------

test('the first sync copies every packaged asset and reports changed', async (t) => {
  const source = await sourceFixture(t, { 'SKILL.md': SKILL_MD, 'notes/extra.md': '# extra\n' })
  const target = await targetFixture(t)

  const result = await syncSkill({ sourceDir: source, targetDir: target })

  assert.equal(result.changed, true)
  assert.deepEqual(result.conflicts, [])
  assert.deepEqual(statuses(result), { 'SKILL.md': 'created', 'notes/extra.md': 'created' })
  assert.equal(await readFile(join(target, 'SKILL.md'), 'utf8'), SKILL_MD)
  assert.equal(await readFile(join(target, 'notes', 'extra.md'), 'utf8'), '# extra\n')

  // The manifest records the hash of the bytes this plugin wrote, which are the
  // bytes still on disk — recomputed here, not taken from the result.
  const manifest = await readManifest(target)
  assert.equal(manifest.skill, SKILL_NAME)
  assert.equal(manifest.assets['SKILL.md'], await hashFile(join(target, 'SKILL.md')))
  assert.equal(manifest.assets['notes/extra.md'], await hashFile(join(target, 'notes', 'extra.md')))

  // Nothing but the assets and the manifest — no temporary file was left behind.
  assert.deepEqual((await readdir(target)).sort(), [MANIFEST_FILENAME, 'SKILL.md', 'notes'].sort())
})

test('a second sync of unchanged assets is a no-op', async (t) => {
  const source = await sourceFixture(t, { 'SKILL.md': SKILL_MD, 'notes/extra.md': '# extra\n' })
  const target = await targetFixture(t)
  await syncSkill({ sourceDir: source, targetDir: target })
  const manifestBefore = await hashFile(join(target, MANIFEST_FILENAME))
  const skillStat = await stat(join(target, 'SKILL.md'))

  const result = await syncSkill({ sourceDir: source, targetDir: target })

  assert.equal(result.changed, false)
  assert.deepEqual(result.conflicts, [])
  assert.deepEqual(statuses(result), { 'SKILL.md': 'unchanged', 'notes/extra.md': 'unchanged' })
  assert.equal(await hashFile(join(target, MANIFEST_FILENAME)), manifestBefore)
  assert.equal((await stat(join(target, 'SKILL.md'))).mtimeMs, skillStat.mtimeMs, 'an unchanged file must not be rewritten')
})

test('a changed packaged asset updates exactly that file', async (t) => {
  const source = await sourceFixture(t, { 'SKILL.md': SKILL_MD, 'notes/extra.md': '# extra\n' })
  const target = await targetFixture(t)
  await syncSkill({ sourceDir: source, targetDir: target })
  const skillBytes = await readFile(join(target, 'SKILL.md'))
  const skillStat = await stat(join(target, 'SKILL.md'))

  await writeFile(join(source, 'notes', 'extra.md'), '# extra v2\n')
  const result = await syncSkill({ sourceDir: source, targetDir: target })

  assert.equal(result.changed, true)
  assert.deepEqual(statuses(result), { 'SKILL.md': 'unchanged', 'notes/extra.md': 'updated' })
  assert.equal(await readFile(join(target, 'notes', 'extra.md'), 'utf8'), '# extra v2\n')
  assert.deepEqual(await readFile(join(target, 'SKILL.md')), skillBytes, 'the untouched asset keeps its exact bytes')
  assert.equal((await stat(join(target, 'SKILL.md'))).mtimeMs, skillStat.mtimeMs, 'only the changed asset is written')
  assert.equal((await readManifest(target)).assets['notes/extra.md'], await hashFile(join(target, 'notes', 'extra.md')))
})

test('a packaged asset deleted from the target is restored', async (t) => {
  const source = await sourceFixture(t)
  const target = await targetFixture(t)
  await syncSkill({ sourceDir: source, targetDir: target })
  const recorded = (await readManifest(target)).assets['SKILL.md']

  await rm(join(target, 'SKILL.md'))
  const result = await syncSkill({ sourceDir: source, targetDir: target })

  assert.equal(result.changed, true)
  assert.equal(statuses(result)['SKILL.md'], 'created')
  assert.equal(await readFile(join(target, 'SKILL.md'), 'utf8'), SKILL_MD)
  assert.equal((await readManifest(target)).assets['SKILL.md'], recorded)
})

// ---------------------------------------------------------------------------
// Path safety: symlinks, missing sources
// ---------------------------------------------------------------------------

test('a symlinked target directory is refused', async (t) => {
  const source = await sourceFixture(t)
  const root = await tempDir(t, 'obsidian-mem-t13-link-')
  const elsewhere = join(root, 'elsewhere')
  await mkdir(elsewhere)
  await mkdir(join(root, 'skills'))
  const target = join(root, 'skills', SKILL_NAME)
  await symlink(elsewhere, target, 'dir')

  await assert.rejects(() => syncSkill({ sourceDir: source, targetDir: target }), /symlink/i)

  assert.deepEqual(await readdir(elsewhere), [], 'nothing may be written through the link')
  assert.equal((await lstat(target)).isSymbolicLink(), true, 'the link itself is left in place')
})

test('a symlinked target file is refused', async (t) => {
  const source = await sourceFixture(t)
  const target = await targetFixture(t)
  await mkdir(target, { recursive: true })
  const outside = join(dirname(target), 'outside.md')
  await writeFile(outside, 'someone else\n')
  await symlink(outside, join(target, 'SKILL.md'), 'file')

  await assert.rejects(() => syncSkill({ sourceDir: source, targetDir: target }), /symlink/i)

  assert.equal(await readFile(outside, 'utf8'), 'someone else\n')
  assert.equal((await lstat(join(target, 'SKILL.md'))).isSymbolicLink(), true)
})

test('a source asset that is missing is an explicit error', async (t) => {
  const source = await sourceFixture(t, { 'notes/extra.md': '# extra\n' })
  const target = await targetFixture(t)

  await assert.rejects(
    () => syncSkill({ sourceDir: source, targetDir: target }),
    (error) => {
      assert.equal(error instanceof AssetSyncError, true, 'the failure must be a named sync error')
      assert.match(error.message, /SKILL\.md/)
      return true
    },
  )
  assert.equal(existsSync(target), false, 'a missing source must not leave a half-copied target')
})

test('a target that already holds valid assets is untouched when the source is invalid', async (t) => {
  const good = await sourceFixture(t)
  const target = await targetFixture(t)
  await syncSkill({ sourceDir: good, targetDir: target })
  const before = await readFile(join(target, 'SKILL.md'))

  const noFrontmatter = await sourceFixture(t, { 'SKILL.md': '# no frontmatter here\n' })
  await assert.rejects(() => syncSkill({ sourceDir: noFrontmatter, targetDir: target }), /frontmatter/i)

  const wrongName = await sourceFixture(t, { 'SKILL.md': '---\nname: other-skill\ndescription: nope\n---\n\n# x\n' })
  await assert.rejects(() => syncSkill({ sourceDir: wrongName, targetDir: target }), /name/)

  assert.deepEqual(await readFile(join(target, 'SKILL.md')), before, 'an invalid packaged skill must not touch the target')
})

// ---------------------------------------------------------------------------
// The manifest contract: foreign files are never overwritten
// ---------------------------------------------------------------------------

test('an externally edited target file is reported as a conflict and not overwritten', async (t) => {
  const source = await sourceFixture(t, { 'SKILL.md': SKILL_MD, 'notes/extra.md': '# extra\n' })
  const target = await targetFixture(t)
  await syncSkill({ sourceDir: source, targetDir: target })
  const recorded = (await readManifest(target)).assets['SKILL.md']

  // The user edits the installed skill by hand; then the package ships a new one.
  await writeFile(join(target, 'SKILL.md'), 'EXTERNAL EDIT\n')
  await writeFile(join(source, 'SKILL.md'), `${SKILL_MD}\nv2\n`)
  const result = await syncSkill({ sourceDir: source, targetDir: target })

  assert.equal(result.changed, false)
  assert.deepEqual(statuses(result), { 'SKILL.md': 'conflict', 'notes/extra.md': 'unchanged' })
  assert.deepEqual(result.conflicts.map((conflict) => conflict.path), ['SKILL.md'])
  assert.match(result.conflicts[0].reason, /external|conflict|changed/i)
  assert.equal(await readFile(join(target, 'SKILL.md'), 'utf8'), 'EXTERNAL EDIT\n', 'a foreign file is never clobbered')
  assert.equal((await readManifest(target)).assets['SKILL.md'], recorded, 'the conflict keeps the old record, so it is reported again')
})

test('a foreign target file with no manifest record is reported as a conflict', async (t) => {
  const source = await sourceFixture(t)
  const target = await targetFixture(t)
  await mkdir(target, { recursive: true })
  await writeFile(join(target, 'SKILL.md'), 'written by someone else\n')

  const result = await syncSkill({ sourceDir: source, targetDir: target })

  assert.equal(result.changed, false)
  assert.deepEqual(result.conflicts.map((conflict) => conflict.path), ['SKILL.md'])
  assert.equal(await readFile(join(target, 'SKILL.md'), 'utf8'), 'written by someone else\n')
  assert.equal(existsSync(join(target, MANIFEST_FILENAME)), false, 'a refused sync must not claim ownership')
})

test('a target file identical to the packaged one is left alone and not adopted', async (t) => {
  const source = await sourceFixture(t)
  const target = await targetFixture(t)
  await mkdir(target, { recursive: true })
  await writeFile(join(target, 'SKILL.md'), SKILL_MD)

  const result = await syncSkill({ sourceDir: source, targetDir: target })

  assert.equal(result.changed, false)
  assert.equal(statuses(result)['SKILL.md'], 'unchanged')
  // Identical bytes need no write, but the file has no plugin record, so the
  // manifest must not start claiming it: if the package changes later, that
  // file is reported as a conflict instead of being overwritten.
  assert.equal(existsSync(join(target, MANIFEST_FILENAME)), false)
  const again = await syncSkill({ sourceDir: source, targetDir: target })
  assert.equal(again.changed, false)
})

test('a corrupt manifest is rebuilt instead of trusted', async (t) => {
  const source = await sourceFixture(t)
  const target = await targetFixture(t)
  await syncSkill({ sourceDir: source, targetDir: target })
  await writeFile(join(target, MANIFEST_FILENAME), '{ this is not json')

  await writeFile(join(source, 'SKILL.md'), `${SKILL_MD}\nv2\n`)
  const result = await syncSkill({ sourceDir: source, targetDir: target })

  // Without a trustworthy record the file cannot be proven to be ours, so it is
  // refused and reported rather than overwritten.
  assert.equal(result.changed, false)
  assert.equal(statuses(result)['SKILL.md'], 'conflict')
  assert.match(result.warnings.join(' '), /manifest/i)
})

// ---------------------------------------------------------------------------
// resolveSkillTargetDir: the DSH_HOME-derived default
// ---------------------------------------------------------------------------

test('the default target is derived from DSH_HOME and nothing else', async (t) => {
  assert.equal(resolveSkillTargetDir({ dshHome: '/tmp/dsh-home' }), join('/tmp/dsh-home', 'skills', SKILL_NAME))
  assert.throws(() => resolveSkillTargetDir({ dshHome: 'relative/path' }), RangeError)
  assert.throws(() => resolveSkillTargetDir({ dshHome: '   ' }), RangeError)

  await withDshHome(t, '/tmp/dsh-home-env', () => {
    assert.equal(resolveSkillTargetDir(), join('/tmp/dsh-home-env', 'skills', SKILL_NAME))
    return Promise.resolve()
  })
  const previous = process.env.DSH_HOME
  delete process.env.DSH_HOME
  try {
    assert.equal(resolveSkillTargetDir(), join(homedir(), '.dsh', 'skills', SKILL_NAME))
  } finally {
    if (previous !== undefined) process.env.DSH_HOME = previous
  }
})

// ---------------------------------------------------------------------------
// syncBundledSkill: the never-throwing wrapper apply() uses
// ---------------------------------------------------------------------------

test('syncBundledSkill reports failures and conflicts instead of rejecting', async (t) => {
  const source = await sourceFixture(t)
  const warnings = []
  const ctx = { logger: { warn: (...args) => warnings.push(args.map(String).join(' ')) } }

  const root = await tempDir(t, 'obsidian-mem-t13-wrap-')
  await mkdir(join(root, 'skills'))
  const elsewhere = join(root, 'elsewhere')
  await mkdir(elsewhere)
  const linkTarget = join(root, 'skills', SKILL_NAME)
  await symlink(elsewhere, linkTarget, 'dir')

  const failed = await syncBundledSkill({ ctx, sourceDir: source, targetDir: linkTarget })
  assert.equal(failed.ok, false)
  assert.equal(failed.changed, false)
  assert.match(failed.error, /symlink/i)
  assert.equal(warnings.length, 1, 'a failed sync is reported exactly once')
  assert.match(warnings[0], /obsidian-mem/)
  assert.match(warnings[0], /symlink/i)
  assert.deepEqual(await readdir(elsewhere), [])

  const target = await targetFixture(t)
  const synced = await syncBundledSkill({ ctx, sourceDir: source, targetDir: target })
  assert.equal(synced.ok, true)
  assert.equal(synced.changed, true)
  assert.deepEqual(synced.conflicts, [])

  await writeFile(join(target, 'SKILL.md'), 'EXTERNAL\n')
  await writeFile(join(source, 'SKILL.md'), `${SKILL_MD}\nv2\n`)
  const conflicted = await syncBundledSkill({ ctx, sourceDir: source, targetDir: target })
  assert.equal(conflicted.ok, true)
  assert.equal(conflicted.changed, false)
  assert.equal(conflicted.conflicts.length, 1)
  assert.match(warnings.at(-1), /conflict/i, 'a conflict is reported, not swallowed')
  assert.equal(await readFile(join(target, 'SKILL.md'), 'utf8'), 'EXTERNAL\n')
})

test('syncBundledSkill needs no logger at all', async (t) => {
  const source = await sourceFixture(t)
  const target = await targetFixture(t)
  const result = await syncBundledSkill({ ctx: {}, sourceDir: source, targetDir: target })
  assert.equal(result.ok, true)
  assert.equal(result.changed, true)
})

test('syncBundledSkill reports an unusable DSH_HOME instead of rejecting', async (t) => {
  const warnings = []
  const ctx = { logger: { warn: (...args) => warnings.push(args.map(String).join(' ')) } }
  await withDshHome(t, 'relative/home', async () => {
    // Nothing is passed for targetDir, so the default resolution runs — and it
    // must fail into the result, not out of the promise `apply` never awaits.
    const result = await syncBundledSkill({ ctx })
    assert.equal(result.ok, false)
    assert.match(result.error, /absolute/i)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /obsidian-mem/)
  })
})

// ---------------------------------------------------------------------------
// apply(): the shipped skill, and failure isolation
// ---------------------------------------------------------------------------

/** A bare Cordis context with DSH's own tools plugin mounted, as in the host. */
async function mountedContext(t) {
  const ctx = new Context()
  ctx.provide('systemPrompt', { tools: () => () => {} })
  const fork = ctx.plugin(toolsPlugin)
  await fork
  t.after(() => fork.dispose().catch(() => {}))
  return ctx
}

test('apply() ships the packaged skill into the DSH skill root', async (t) => {
  const root = await tempDir(t, 'obsidian-mem-t13-apply-ok-')
  const ctx = await mountedContext(t)
  await withDshHome(t, root, async () => {
    const vault = join(root, 'vault')
    const dispose = apply(ctx, { enabled: true, vaultPath: vault })
    t.after(() => dispose())

    const installed = join(root, 'skills', SKILL_NAME, 'SKILL.md')
    const manifestPath = join(root, 'skills', SKILL_NAME, MANIFEST_FILENAME)
    // The manifest is written LAST, after every asset, so its appearance is the
    // sync's completion signal — waiting on SKILL.md alone would race it.
    const finished = await waitFor(() => existsSync(manifestPath))
    assert.equal(finished, true, 'the packaged skill must appear under $DSH_HOME/skills')
    assert.equal(existsSync(installed), true)

    const packaged = await readFile(join(bundledSkillSourceDir(), 'SKILL.md'))
    assert.deepEqual(await readFile(installed), packaged, 'the synced bytes are the packaged bytes')

    const manifest = await readManifest(join(root, 'skills', SKILL_NAME))
    assert.equal(manifest.assets['SKILL.md'], sha256(packaged))

    // The frontmatter DSH's skill discovery requires is present in the shipped
    // asset itself — asserted from the installed copy.
    const frontmatter = parseYaml(packaged.toString().split('---')[1])
    assert.equal(frontmatter.name, SKILL_NAME)
    assert.equal(typeof frontmatter.description, 'string')
    assert.ok(frontmatter.description.trim().length > 0)

    const again = await syncSkill({ sourceDir: bundledSkillSourceDir(), targetDir: join(root, 'skills', SKILL_NAME) })
    assert.equal(again.changed, false, 'a repeat sync of what the plugin wrote is a no-op')
  })
})

test('a failed skill sync is reported without stranding the plugin', async (t) => {
  const root = await tempDir(t, 'obsidian-mem-t13-apply-fail-')
  const ctx = await mountedContext(t)
  await withDshHome(t, root, async () => {
    // `$DSH_HOME/skills/obsidian-mem` already exists as a symlink, which the
    // sync refuses — the shape of an unwritable or hijacked skill root.
    const elsewhere = join(root, 'elsewhere')
    await mkdir(elsewhere)
    await mkdir(join(root, 'skills'), { recursive: true })
    await symlink(elsewhere, join(root, 'skills', SKILL_NAME), 'dir')

    const captured = []
    const disposeExporter = ctx.logger.exporter({ levels: { default: 9 }, export: (message) => captured.push(message) })
    t.after(() => disposeExporter())

    const cwd = join(root, 'repo')
    await mkdir(cwd, { recursive: true })
    const dispose = apply(ctx, { enabled: true, vaultPath: join(root, 'vault') })
    t.after(() => dispose())

    // Registered synchronously: a failed sync must not keep the tools or the
    // hooks from mounting (the fiber would stay PENDING).
    assert.deepEqual(ctx.tools.schemas().map((schema) => schema.name).sort(), SIX)
    const decision = await ctx.waterfall(
      'agent/pre-step',
      { agent: agentFor(cwd), messages: [], turn: 1, step: 1, signal: new AbortController().signal },
      async () => ({ kind: 'enter', messages: [] }),
    )
    assert.equal(decision.kind, 'enter')

    const reported = await waitFor(() =>
      captured.some((message) => message.type === 'warn' && message.args.some((arg) => String(arg).includes('obsidian-mem'))))
    assert.equal(reported, true, 'the failure must be reported, not swallowed')
    assert.deepEqual(await readdir(elsewhere), [], 'nothing may be written through the symlink')
    assert.equal(existsSync(join(elsewhere, 'SKILL.md')), false)
    assert.deepEqual(ctx.tools.schemas().map((schema) => schema.name).sort(), SIX, 'the tools survive the failed sync')
  })
})

test('unloading the plugin fiber waits for the in-flight skill sync', async (t) => {
  const root = await tempDir(t, 'obsidian-mem-t13-unload-')
  const ctx = await mountedContext(t)
  await withDshHome(t, root, async () => {
    // The host mounts `apply` inside the plugin's own fiber, so the sync is that
    // fiber's effect: disposal has to wait for the file work instead of racing a
    // teardown that is already removing the tree it writes into. No polling here
    // on purpose — the assertion is about the lifecycle, not about timing.
    const fork = ctx.plugin({ name: 'obsidian-mem-probe', apply })
    await fork
    await fork.dispose()

    const installed = join(root, 'skills', SKILL_NAME, 'SKILL.md')
    assert.equal(existsSync(installed), true, 'disposal waited for the sync to finish')
    assert.deepEqual(await readFile(installed), await readFile(join(bundledSkillSourceDir(), 'SKILL.md')))
  })
})
