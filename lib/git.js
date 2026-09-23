// git discovery for project binding (Task 4).
//
// `findGitRoot` walks upward instead of shelling out, so a plain checkout still
// binds when the git binary is missing; `git` is only needed to enumerate the
// *sibling* worktrees of the same repository, which is what stops an old branch
// (created before the pointer was committed) from being treated as a new
// project.
//
// Both git calls go through `execFile` — never a shell — and the child
// environment is stripped of `GIT_DIR`-family variables, so a stray `GIT_DIR`
// cannot redirect sibling discovery at a different repository.
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

import { PointerError, POINTER_FILENAME, readPointer } from './pointer.js'

/** Environment variables that could redirect a git read at another repository. */
const GIT_ENV_STRIPPED = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
]

/**
 * Walk upward from `cwd` to the git root.
 *
 * The root is the directory that contains a `.git` entry — a directory for a
 * normal clone, a file for a linked worktree.
 *
 * @param {string} cwd - normalized working directory.
 * @returns {Promise<string|null>} the git root, or `null` when there is none.
 */
export async function findGitRoot(cwd) {
  let current = resolve(cwd)
  for (;;) {
    if ((await lstatOrNull(join(current, '.git'))) !== null) return current
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}

/**
 * The common git directory of a repository, as reported by git.
 *
 * @param {string} repoRoot - git root of the current worktree.
 * @returns {Promise<string>} `git rev-parse --git-common-dir` output.
 */
export async function gitCommonDir(repoRoot) {
  return (await runGit(repoRoot, ['rev-parse', '--git-common-dir'])).trim()
}

/**
 * Every worktree path git knows about, including the current one.
 *
 * @param {string} repoRoot - git root of the current worktree.
 * @returns {Promise<string[]>} worktree paths as git reported them.
 */
export async function listWorktrees(repoRoot) {
  return parseWorktreeList(await runGit(repoRoot, ['worktree', 'list', '--porcelain']))
}

/**
 * Enumerate the sibling worktrees of a repository and read their pointers.
 *
 * Every worktree of the same git common dir except `repoRoot` is inspected.
 * A sibling that cannot be resolved, is not a directory, or carries a pointer
 * that cannot be trusted is reported under `unreadable` — the caller decides,
 * but it must never guess an identity around one. Siblings without a pointer are
 * simply absent from `siblings`; they contribute no identity.
 *
 * @param {string} repoRoot - git root of the current worktree.
 * @returns {Promise<{ok: true, siblings: object[], unreadable: object[]}|{ok: false, reason: string, message: string, detail?: string}>} the scan.
 */
export async function scanSiblingPointers(repoRoot) {
  let commonDir
  let listed
  try {
    commonDir = await gitCommonDir(repoRoot)
    listed = await listWorktrees(repoRoot)
  } catch (error) {
    return {
      ok: false,
      reason: 'git-unavailable',
      message: error.code ?? error.message,
      detail: error.stderr?.trim() || undefined,
    }
  }
  if (!commonDir) {
    return { ok: false, reason: 'git-unavailable', message: 'git reported no common directory for this repository' }
  }

  const candidates = new Set(listed)
  candidates.add(dirname(isAbsolute(commonDir) ? commonDir : resolve(repoRoot, commonDir)))

  const siblings = []
  const unreadable = []
  for (const candidate of candidates) {
    let real
    try {
      real = await fs.realpath(candidate)
    } catch (error) {
      unreadable.push({ path: candidate, reason: error.code ?? 'unreadable' })
      continue
    }
    if (real === repoRoot) continue
    let stat
    try {
      stat = await fs.lstat(real)
    } catch (error) {
      unreadable.push({ path: real, reason: error.code ?? 'unreadable' })
      continue
    }
    if (!stat.isDirectory()) {
      unreadable.push({ path: real, reason: 'not-a-directory' })
      continue
    }
    let found
    try {
      found = await readPointer(real)
    } catch (error) {
      if (error instanceof PointerError) {
        unreadable.push({ path: join(real, POINTER_FILENAME), reason: error.code })
        continue
      }
      throw error
    }
    if (found !== null) siblings.push({ path: real, pointer: found.pointer })
  }
  return { ok: true, siblings, unreadable }
}

/**
 * Parse `git worktree list --porcelain` into worktree paths.
 *
 * @param {string} output - porcelain output.
 * @returns {string[]} absolute worktree paths as git reported them.
 */
function parseWorktreeList(output) {
  const paths = []
  for (const line of String(output).split(/\r?\n/)) {
    if (!line.startsWith('worktree ')) continue
    const value = unquoteGitPath(line.slice('worktree '.length).trim())
    if (value) paths.push(value)
  }
  return paths
}

/**
 * Undo git's C-style quoting for a path in porcelain output.
 *
 * @param {string} value - raw path token.
 * @returns {string} the unquoted path.
 */
function unquoteGitPath(value) {
  if (!value.startsWith('"') || !value.endsWith('"') || value.length < 2) return value
  return value.slice(1, -1).replace(/\\(.)/g, (whole, char) => {
    switch (char) {
      case 'n': return '\n'
      case 't': return '\t'
      case 'r': return '\r'
      case '"': return '"'
      case '\\': return '\\'
      default: return whole
    }
  })
}

/**
 * Run a git subcommand without a shell.
 *
 * `execFile` is used deliberately: these arguments are never shell-parsed, and
 * the environment is stripped of `GIT_DIR`-family variables that could silently
 * point a read at a different repository than the one being bound.
 *
 * @param {string} cwd - directory to run in.
 * @param {string[]} args - git arguments.
 * @returns {Promise<string>} stdout.
 */
export function runGit(cwd, args) {
  const env = { ...process.env }
  for (const key of GIT_ENV_STRIPPED) delete env[key]
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      'git',
      ['-c', 'core.quotepath=false', ...args],
      { cwd, env, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        if (error) rejectPromise(error)
        else resolvePromise(stdout)
      },
    )
  })
}

/**
 * `lstat` that reports absence as `null` and every other failure as a throw.
 *
 * @param {string} path - path to inspect.
 * @returns {Promise<import('node:fs').Stats|null>} the stat, or `null` when missing.
 */
async function lstatOrNull(path) {
  try {
    return await fs.lstat(path)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}
