#!/usr/bin/env node
// @ts-check
// The Codex turn adapter. It shares the retrieval policy and vault service with
// DSH; only the hook protocol and cross-process shown-path state live here.
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { promptRecall } from '../lib/prompt-recall.js'
import { resolveBinding } from '../lib/vault.js'
import { openMemory } from './server.mjs'

const CONTINUE = Object.freeze({ continue: true })
const MAX_SEEN = 64
const MAX_STATE_BYTES = 32768
const DEBUG = process.env.OBSIDIAN_MEM_HOOK_DEBUG === '1'

/** A safe, non-reversible state filename for Codex's session id. */
function statePath(dataRoot, sessionId) {
  const key = createHash('sha256').update(sessionId).digest('hex')
  return join(dataRoot, 'prompt-recall', `${key}.json`)
}

/** Read only the bounded list of previously offered paths. */
async function readSeen(path) {
  try {
    const stat = await lstat(path)
    if (!stat.isFile() || stat.size > MAX_STATE_BYTES) return new Set()
    const value = JSON.parse(await readFile(path, 'utf8'))
    if (!Array.isArray(value.paths)) return new Set()
    return new Set(
      value.paths
        .filter(
          (item) => typeof item === 'string' && item.length <= 512 && item.startsWith('Projects/'),
        )
        .slice(-MAX_SEEN),
    )
  } catch {
    return new Set()
  }
}

/** Atomically replace a private cache file; the vault is never the cache root. */
async function writeSeen(path, seen) {
  const dir = dirname(path)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const stat = await lstat(dir)
  if (!stat.isDirectory() || stat.isSymbolicLink()) return
  const temporary = join(dir, `${randomUUID()}.tmp`)
  try {
    const file = await open(temporary, 'wx', 0o600)
    try {
      await file.writeFile(`${JSON.stringify({ paths: [...seen].slice(-MAX_SEEN) })}\n`)
    } finally {
      await file.close()
    }
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

/**
 * One Codex `UserPromptSubmit` call. It always writes one valid response.
 *
 * @param {string} raw - hook stdin.
 * @param {{out?: {write: Function}, err?: {write: Function}, open?: Function}} [io] - test seams.
 * @returns {Promise<object>} the emitted protocol document.
 */
export async function runHook(raw, io = {}) {
  const out = io.out ?? process.stdout
  const err = io.err ?? process.stderr
  /** @type {object} */
  let answer = CONTINUE
  let memory
  try {
    const input = JSON.parse(raw)
    if (
      input?.hook_event_name === 'UserPromptSubmit' &&
      typeof input.cwd === 'string' &&
      input.cwd.trim() !== '' &&
      typeof input.session_id === 'string' &&
      input.session_id.trim() !== '' &&
      typeof input.prompt === 'string'
    ) {
      memory = (io.open ?? openMemory)({ cwd: input.cwd })
      const binding = await resolveBinding({
        cwd: input.cwd,
        vaultRoot: memory.config.vaultPath,
        mode: 'show',
        home: homedir(),
      })
      if (binding?.kind === 'bound') {
        const path = statePath(memory.dataRoot, input.session_id)
        const seen = await readSeen(path)
        const map = await promptRecall({
          prompt: input.prompt,
          search: memory.services.search,
          seenPaths: seen,
        })
        if (map !== null) {
          answer = {
            hookSpecificOutput: {
              hookEventName: 'UserPromptSubmit',
              additionalContext: map.text,
            },
          }
          for (const shown of map.paths) seen.add(shown)
          try {
            await writeSeen(path, seen)
          } catch (error) {
            if (DEBUG)
              err.write(`obsidian-mem(prompt): state write failed: ${error?.code ?? 'unknown'}\n`)
          }
        }
      }
    }
  } catch (error) {
    if (DEBUG) err.write(`obsidian-mem(prompt): recall skipped: ${error?.code ?? 'unknown'}\n`)
  } finally {
    try {
      await memory?.services?.close?.()
    } catch {
      // The hook's answer is always advisory; cleanup cannot block a prompt.
    }
  }
  out.write(`${JSON.stringify(answer)}\n`)
  return answer
}

async function readPayload() {
  if (process.stdin.isTTY === true) return ''
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

const isEntry = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`
if (isEntry) {
  try {
    await runHook(await readPayload())
  } catch {
    process.stdout.write(`${JSON.stringify(CONTINUE)}\n`)
  }
}
