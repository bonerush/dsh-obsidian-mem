#!/usr/bin/env node
// P0 assertions for the two remaining blockers of `dsh-obsidian-mem`.
//
// Section A — minimum-environment matrix. Proves, on the Node binary that runs
// this file, that `node:sqlite` exposes FTS5 and that the filesystem primitives
// the transaction design depends on behave atomically: a file `fsync`, an
// exclusive `link` publish (the second `link` must fail with `EEXIST`), a
// same-directory `rename` that atomically replaces the target, and a directory
// `fsync`. Every sub-assertion is recorded independently, so one unsupported
// API cannot hide the state of the others. Run this section alone under each
// candidate Node version with `--env-only`.
//
// Section B — LLM route contract. Reads the JSONL written by
// `test/p0/probe-plugin.js` (located through
// `DSH_OBSIDIAN_MEM_LLM_PROBE_RECORD`) and asserts what
// `ctx.get('llm').stream()` actually accepts and emits: an explicit
// provider/model route, an empty route, caller cancellation through an
// `AbortSignal`, and a timeout signal. The record carries field names, chunk
// order, terminal outcome, and duration only — never prompt or response text.
//
// Both sections run by default. The script exits non-zero when any assertion
// fails or when required evidence is missing; an empty or absent record must
// never pass.

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { link, mkdtemp, open, readFile, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

const ENV_ONLY = process.argv.includes('--env-only')

/** @type {{section:string, name:string, ok:boolean, detail:string}[]} */
const results = []

/** Run one assertion, recording pass and failure side by side. */
async function check(section, name, fn) {
  try {
    const detail = await fn()
    results.push({ section, name, ok: true, detail: detail === undefined ? '' : String(detail) })
  } catch (error) {
    results.push({
      section,
      name,
      ok: false,
      detail: `${error?.name ?? 'Error'}: ${error?.message ?? error}`,
    })
  }
}

/** One throwaway directory per filesystem assertion. */
async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-obsidian-mem-p0-fs-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** Run-length summary of an observed chunk-type sequence (deltas dominate). */
function summarizeChunks(chunkTypes) {
  const runs = []
  for (const type of chunkTypes) {
    const last = runs[runs.length - 1]
    if (last !== undefined && last.type === type) last.count += 1
    else runs.push({ type, count: 1 })
  }
  return runs.map((run) => (run.count === 1 ? run.type : `${run.type}×${run.count}`)).join(' ')
}

/** Write bytes and `fsync` the file handle; returns the closed path. */
async function writeAndSync(path, text) {
  const handle = await open(path, 'wx')
  try {
    await handle.writeFile(text)
    await handle.sync()
  } finally {
    await handle.close()
  }
  return path
}

// --- Section A: minimum-environment matrix ---------------------------------

await check('environment', 'node:sqlite import + FTS5', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(':memory:')
  try {
    db.exec('CREATE VIRTUAL TABLE x USING fts5(body)')
    db.exec("INSERT INTO x(body) VALUES ('调度器')")
    const whole = Number(db.prepare("SELECT count(*) AS n FROM x WHERE x MATCH '调度器'").get().n)
    assert.equal(whole, 1, "expected MATCH '调度器' to return 1 row")
    // The CJK retrieval design depends on this: unicode61 keeps `调度器` as one
    // token, so a 2-character prefix is NOT a match and must return 0 rows.
    const bigram = Number(db.prepare("SELECT count(*) AS n FROM x WHERE x MATCH '调度'").get().n)
    assert.equal(bigram, 0, "expected 2-character CJK MATCH '调度' to return 0 rows")
    const sqlite = String(db.prepare('SELECT sqlite_version() AS v').get().v)
    return `sqlite=${sqlite} MATCH'调度器'=1 MATCH'调度'=0`
  } finally {
    db.close()
  }
})

await check('environment', 'file fsync', async () => {
  return withTempDir(async (dir) => {
    const path = await writeAndSync(join(dir, 'a'), 'one')
    assert.equal(await readFile(path, 'utf8'), 'one')
    return 'open(wx)+write+sync ok'
  })
})

await check('environment', 'link exclusive publish (second link -> EEXIST)', async () => {
  return withTempDir(async (dir) => {
    const a = await writeAndSync(join(dir, 'a'), 'one')
    const b = join(dir, 'b')
    await link(a, b)
    let code = null
    try {
      await link(a, b)
    } catch (error) {
      code = error?.code ?? error?.name ?? 'no-error'
    }
    assert.equal(code, 'EEXIST', `expected the second link to fail with EEXIST, got ${code}`)
    assert.equal(await readFile(b, 'utf8'), 'one')
    return 'first link ok, second link EEXIST'
  })
})

await check('environment', 'same-directory rename replace', async () => {
  return withTempDir(async (dir) => {
    const a = await writeAndSync(join(dir, 'a'), 'one')
    const b = join(dir, 'b')
    await link(a, b)
    const c = await writeAndSync(join(dir, 'c'), 'two')
    await rename(c, b)
    assert.equal(await readFile(b, 'utf8'), 'two', 'rename must replace the target in place')
    assert.equal(await readFile(a, 'utf8'), 'one', 'rename must leave the source link intact')
    assert.equal(existsSync(c), false, 'rename must move, not copy')
    return 'rename over existing target ok'
  })
})

await check('environment', 'directory fsync', async () => {
  return withTempDir(async (dir) => {
    const handle = await open(dir, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
    return 'open(dir,r)+sync ok'
  })
})

// --- Section B: LLM route contract -----------------------------------------

const EXPECTED_CASES = ['explicit-route', 'empty-route', 'abort-caller', 'timeout']

if (!ENV_ONLY) {
  const recordPath = process.env.DSH_OBSIDIAN_MEM_LLM_PROBE_RECORD
  let records = null

  if (typeof recordPath !== 'string' || recordPath.trim() === '') {
    results.push({
      section: 'llm',
      name: 'probe record input',
      ok: false,
      detail: 'DSH_OBSIDIAN_MEM_LLM_PROBE_RECORD is not set',
    })
  } else if (!existsSync(recordPath)) {
    results.push({
      section: 'llm',
      name: 'probe record input',
      ok: false,
      detail: `probe record does not exist: ${recordPath}`,
    })
  } else {
    const lines = readFileSync(recordPath, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
    if (lines.length === 0) {
      results.push({
        section: 'llm',
        name: 'probe record input',
        ok: false,
        detail: `probe record is empty: ${recordPath}`,
      })
    } else {
      records = []
      lines.forEach((line, index) => {
        try {
          records.push(JSON.parse(line))
        } catch (error) {
          results.push({
            section: 'llm',
            name: 'probe record JSON',
            ok: false,
            detail: `line ${index + 1} is not valid JSON: ${error.message}`,
          })
        }
      })
      if (records.length !== lines.length) records = null
    }
  }

  if (records !== null) {
    const catalog = records.find((r) => r?.name === 'probe/llm-catalog')
    const cases = new Map(
      records.filter((r) => r?.name === 'probe/llm-case').map((r) => [r.case, r]),
    )

    await check('llm', 'llm service reachable', async () => {
      assert.ok(catalog, 'expected one probe/llm-catalog record')
      assert.equal(catalog.hasLlm, true, 'expected ctx.get("llm") to be defined at the probe point')
      assert.ok(
        Number(catalog.providerCount) >= 1,
        `expected at least one registered provider route, got ${catalog.providerCount}`,
      )
      return `providers=${catalog.providerCount} model=${catalog.provider}/${catalog.model}`
    })

    await check('llm', 'all four cases recorded', async () => {
      assert.ok(catalog, 'expected one probe/llm-catalog record')
      const missing = EXPECTED_CASES.filter((name) => !cases.has(name))
      assert.deepEqual(missing, [], `missing LLM probe cases: ${missing.join(', ')}`)
      assert.equal(
        cases.size,
        EXPECTED_CASES.length,
        `expected exactly ${EXPECTED_CASES.length} distinct cases, got ${cases.size}`,
      )
      for (const entry of cases.values()) {
        assert.equal(entry.name, 'probe/llm-case')
        assert.ok(Array.isArray(entry.chunkTypes) && entry.chunkTypes.length >= 1, `${entry.case} saw no chunk`)
      }
      return EXPECTED_CASES.join(', ')
    })

    await check('llm', 'explicit route: request accepted, chunks observed', async () => {
      const entry = cases.get('explicit-route')
      assert.ok(entry, 'expected an explicit-route case')
      assert.equal(entry.threwName, null, `stream() threw: ${entry.threwName} ${entry.threwMessage ?? ''}`)
      assert.equal(entry.hasAsyncIterator, true, 'stream() must return an AsyncIterable')
      assert.ok(
        ['stop', 'max-tokens', 'tool-calls'].includes(entry.finishKind),
        `expected a successful terminal finish, got ${entry.finishKind}`,
      )
      assert.ok(entry.textDeltaCount >= 1, `expected at least one text-delta, got ${entry.textDeltaCount}`)
      assert.ok(entry.chunkTypes.includes('block-end'), 'expected a block-end chunk')
      assert.ok(entry.blockEndTypes.includes('text'), 'expected the block-end chunk to carry a text block')
      assert.ok(entry.chunkTypes.includes('usage'), 'expected a usage chunk')
      for (const field of ['inputTokens', 'outputTokens']) {
        assert.ok(entry.usageFields.includes(field), `expected usage.${field} in ${entry.usageFields.join(',')}`)
      }
      const usageAt = entry.chunkTypes.indexOf('usage')
      const finishAt = entry.chunkTypes.lastIndexOf('finish')
      assert.ok(usageAt >= 0 && usageAt < finishAt, 'expected usage before the terminal finish chunk')
      return `${summarizeChunks(entry.chunkTypes)} (${entry.ms}ms)`
    })

    await check('llm', 'empty route: terminal error chunk, no throw', async () => {
      const entry = cases.get('empty-route')
      assert.ok(entry, 'expected an empty-route case')
      assert.equal(entry.threwName, null, `empty route threw: ${entry.threwName} ${entry.threwMessage ?? ''}`)
      assert.equal(entry.finishKind, 'error', `expected a terminal error finish, got ${entry.finishKind}`)
      assert.ok(
        typeof entry.finishFailureCode === 'string' && entry.finishFailureCode.length > 0,
        'expected a non-empty failure code on the terminal error chunk',
      )
      return `finish=error code=${entry.finishFailureCode}`
    })

    await check('llm', 'caller AbortSignal: terminal aborted chunk, no throw', async () => {
      const entry = cases.get('abort-caller')
      assert.ok(entry, 'expected an abort-caller case')
      assert.ok(entry.abortAfterChunk > 0, 'expected the caller abort to be issued after a chunk was observed')
      assert.equal(entry.threwName, null, `caller abort threw: ${entry.threwName} ${entry.threwMessage ?? ''}`)
      assert.equal(entry.finishKind, 'aborted', `expected a terminal aborted finish, got ${entry.finishKind}`)
      return `aborted after ${entry.abortAfterChunk} chunk(s) in ${entry.ms}ms`
    })

    await check('llm', 'timeout signal: terminal aborted chunk, no throw', async () => {
      const entry = cases.get('timeout')
      assert.ok(entry, 'expected a timeout case')
      assert.equal(entry.signalAborted, true, 'expected the timeout signal to have fired')
      assert.equal(entry.threwName, null, `timeout threw: ${entry.threwName} ${entry.threwMessage ?? ''}`)
      assert.equal(entry.finishKind, 'aborted', `expected a terminal aborted finish, got ${entry.finishKind}`)
      assert.ok(entry.ms < 30000, `expected prompt settlement, took ${entry.ms}ms`)
      return `finish=aborted reason=${entry.signalReasonName} in ${entry.ms}ms`
    })
  }
}

// --- Report ----------------------------------------------------------------

const PASS = 'PASS'
const FAIL = 'FAIL'
let lastSection = null
for (const result of results) {
  if (result.section !== lastSection) {
    lastSection = result.section
    console.log(`llm-sqlite-probe: ${result.section} section`)
  }
  console.log(`  ${result.ok ? PASS : FAIL}  ${result.name}${result.detail === '' ? '' : ` — ${result.detail}`}`)
}

const failed = results.filter((result) => !result.ok)
const envSection = `node ${process.version} ${process.platform}/${process.arch}`
if (failed.length > 0) {
  console.error(`llm-sqlite-probe: FAIL — ${failed.length} of ${results.length} assertion(s) failed (${envSection})`)
  process.exit(1)
}
console.log(
  `llm-sqlite-probe: OK — ${results.length} assertion(s) passed${ENV_ONLY ? ' (environment only; LLM evidence not checked)' : ''} (${envSection})`,
)
