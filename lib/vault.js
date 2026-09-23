// Stable project binding for the obsidian-mem vault (Task 4, orchestrator).
//
// Binding answers one question per session: which vault project directory does
// this working directory belong to? Identity lives in the `.obsidian-mem`
// pointer at the git root — exactly four fields, no machine-local path, no
// remote address (spec §5.2 / ruling D3) — and in the vault's
// `_meta/项目注册表.md`. The directory name `项目/<slug>--<projectId 前8位>/` is a
// rendering of that identity, never the identity itself, which is why renaming a
// repository or a display name never moves vault content and why a directory
// rename is reported instead of repaired.
//
// A worktree that has no pointer (an older branch, a fresh checkout) inherits
// the unique valid pointer of its siblings through the git common dir rather
// than minting a new project id. Sibling paths that cannot be read stop
// resolution: guessing would silently create a second project for the same
// repository.
//
// This module owns the *policy*; the contracts live next door:
//   ./pointer.js   the four-field pointer (parse, read, exclusive create)
//   ./registry.js  the vault registry (parse, read, one-to-one validation)
//   ./git.js       git root discovery and sibling-worktree enumeration
// Everything those modules exported through this file before the R20 split is
// re-exported at the bottom, so importers do not have to move.
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { findGitRoot, scanSiblingPointers } from './git.js'
import { isCloudManagedVaultRoot, isInside, PathSafetyError, resolveVaultFile, resolveVaultRoot } from './paths.js'
import {
  createPointerExclusive,
  newPointer,
  POINTER_FILENAME,
  PointerError,
  readPointer,
  samePointer,
} from './pointer.js'
import { projectRelativeDir, readRegistry, RegistryError } from './registry.js'

/** Every bind mode the plugin will eventually understand (T17). */
export const BIND_MODES = Object.freeze(['show', 'local', 'fork', 'retain'])
/** Modes that change identity; they must be reached through an explicit bind action. */
const UNAVAILABLE_BIND_MODES = Object.freeze(['local', 'fork', 'retain'])

/**
 * Resolve the vault project binding for a working directory.
 *
 * Resolution order (spec §5.2): normalize the vault root, refuse a cwd that is
 * inside the vault, refuse a cloud-managed vault root, find the git root, read
 * the pointer, validate or exclusively create it (inheriting a sibling
 * worktree's pointer when the current one has none), then check the vault
 * registry for id/directory conflicts and return the binding.
 *
 * @param {object} options - resolution inputs.
 * @param {string} options.cwd - working directory to bind.
 * @param {string} options.vaultRoot - configured vault root (absolute or `~/…`).
 * @param {string} [options.mode] - only explicit bind actions pass a mode; `show` reports without writing.
 * @param {string} [options.home] - home directory for `~/` expansion and cloud checks (test/host seam).
 * @returns {Promise<object>} a `kind:'bound'` binding, or a refusal object.
 * @throws {RangeError} when `cwd`, `vaultRoot` or `mode` is invalid.
 */
export async function resolveBinding({ cwd, vaultRoot, mode, home = homedir() } = {}) {
  if (typeof cwd !== 'string' || !cwd.trim()) throw new RangeError('cwd must be a non-blank path')
  if (typeof vaultRoot !== 'string' || !vaultRoot.trim()) throw new RangeError('vaultRoot must be a non-blank path')
  if (mode !== undefined && !BIND_MODES.includes(mode)) {
    throw new RangeError(`mode must be one of ${BIND_MODES.join(', ')}`)
  }
  if (UNAVAILABLE_BIND_MODES.includes(mode)) {
    return {
      kind: 'conflict',
      reason: 'bind-mode-unavailable',
      mode,
      message: `bind mode "${mode}" changes project identity and is not available yet; resolve without a mode, or with mode "show"`,
    }
  }

  const cwdReal = await fs.realpath(cwd)
  const vault = await resolveVaultRoot(vaultRoot, { home })
  if (isInside(cwdReal, vault.root)) {
    return {
      kind: 'vault',
      vaultRoot: vault.root,
      cwd: cwdReal,
      message: 'the working directory is inside the memory vault; the vault itself is not a project',
    }
  }
  if (await isCloudManagedVaultRoot(vault.root, { home })) {
    return {
      kind: 'conflict',
      reason: 'vault-cloud-managed',
      vaultRoot: vault.root,
      message: `the vault at ${vault.root} is under a cloud-managed directory; move it to a fully-downloaded local directory before enabling automatic writes`,
    }
  }

  const repoRoot = await findGitRoot(cwdReal)
  if (repoRoot === null) {
    return {
      kind: 'unbound',
      reason: 'no-git-root',
      cwd: cwdReal,
      vaultRoot: vault.root,
      message: 'this directory is not in a git repository, so it stays read-only and is not added to long-term memory',
      hint: 'bind it explicitly with mem_admin(action="bind", mode="local")',
    }
  }

  const pointerPath = join(repoRoot, POINTER_FILENAME)
  let existing
  try {
    existing = await readPointer(repoRoot)
  } catch (error) {
    if (error instanceof PointerError) {
      return refusal(error.code, error.message, { repoRoot, vaultRoot: vault.root, pointerPath })
    }
    throw error
  }

  let pointer
  let pointerCreated = false
  let pointerInherited = false
  if (existing !== null) {
    pointer = existing.pointer
  } else if (mode === 'show') {
    return {
      kind: 'unbound',
      reason: 'no-pointer',
      cwd: cwdReal,
      repoRoot,
      pointerPath,
      vaultRoot: vault.root,
      message: 'this repository has no .obsidian-mem pointer yet',
    }
  } else {
    const inheritance = await inheritSiblingPointer(repoRoot)
    if (inheritance.failure) return { ...inheritance.failure, repoRoot, vaultRoot: vault.root }
    pointer = inheritance.pointer ?? newPointer(repoRoot)
    pointerInherited = inheritance.pointer !== null
    pointerCreated = await createPointerExclusive(pointerPath, pointer)
    if (pointerCreated) {
      // Two worktrees binding for the first time at the same moment would each
      // mint an id. Re-enumerate siblings and refuse instead of leaving one
      // repository bound to two project ids; full serialization is Task 7's.
      const duplicate = await detectConcurrentBind(repoRoot, pointer.projectId)
      if (duplicate !== null) {
        const unwound = await removeOwnPointer(repoRoot, pointer.projectId)
        return { ...duplicate, repoRoot, vaultRoot: vault.root, pointerPath, unwound }
      }
    } else {
      // Another writer created the pointer first: its identity wins, and an
      // existing pointer is never overwritten by this stage.
      let raced
      try {
        raced = await readPointer(repoRoot)
      } catch (error) {
        if (error instanceof PointerError) {
          return refusal(error.code, error.message, { repoRoot, vaultRoot: vault.root, pointerPath })
        }
        throw error
      }
      if (raced === null) {
        return refusal('pointer-race', `${pointerPath} appeared and vanished while binding`, {
          repoRoot, vaultRoot: vault.root, pointerPath,
        })
      }
      pointer = raced.pointer
      pointerInherited = false
    }
  }

  let registry
  try {
    registry = await readRegistry(vault.root)
  } catch (error) {
    if (error instanceof RegistryError) {
      return refusal(error.code, error.message, { repoRoot, vaultRoot: vault.root })
    }
    throw error
  }

  const registered = registry.byId.get(pointer.projectId) ?? null
  let relativeDir
  if (registered !== null) {
    relativeDir = registered.dir
  } else {
    relativeDir = projectRelativeDir(pointer.slug, pointer.projectId)
    const owner = registry.byDir.get(relativeDir)
    if (owner !== undefined && owner !== pointer.projectId) {
      return refusal('directory-taken', `${relativeDir} already belongs to project ${owner}`, {
        repoRoot, vaultRoot: vault.root, relativeDir,
      })
    }
  }

  let projectDir
  try {
    projectDir = await resolveVaultFile(vault.root, relativeDir, { home })
  } catch (error) {
    if (error instanceof PathSafetyError) {
      return refusal('project-directory-symlink', error.message, {
        repoRoot, vaultRoot: vault.root, relativeDir,
      })
    }
    throw error
  }
  if (registered !== null) {
    const projectStat = await lstatOrNull(projectDir)
    if (projectStat === null) {
      return refusal('registry-directory-missing', `${registry.path} lists ${relativeDir}, but it does not exist in the vault`, {
        repoRoot, vaultRoot: vault.root, relativeDir, projectDir,
      })
    }
    if (!projectStat.isDirectory()) {
      return refusal('project-directory-not-directory', `${projectDir} is not a directory`, {
        repoRoot, vaultRoot: vault.root, relativeDir, projectDir,
      })
    }
  }

  return {
    kind: 'bound',
    projectId: pointer.projectId,
    slug: pointer.slug,
    displayName: pointer.displayName,
    schema: pointer.schema,
    vaultRoot: vault.root,
    vaultExists: vault.exists,
    repoRoot,
    pointerPath,
    pointerCreated,
    pointerInherited,
    relativeDir,
    projectDir,
    registered: registered !== null,
  }
}

/**
 * Build a refusal object shared by every non-throwing failure path.
 *
 * @param {string} reason - machine-readable reason code.
 * @param {string} message - human-readable diagnostic.
 * @param {object} [extra] - additional fields to expose (paths, ids).
 * @returns {{kind: 'conflict', reason: string, message: string}} the refusal.
 */
function refusal(reason, message, extra = {}) {
  return { kind: 'conflict', reason, message, ...extra }
}

/**
 * Find the pointer a sibling worktree already carries.
 *
 * All valid sibling pointers must agree on all four fields; one agreed pointer
 * is inherited by exclusive creation, and a repository with no known pointer
 * gets a fresh identity. An unreadable sibling (deleted checkout, permission
 * failure, invalid pointer) stops resolution instead of guessing.
 *
 * @param {string} repoRoot - git root of the current worktree.
 * @returns {Promise<{pointer: object|null}|{failure: object}>} the inherited pointer or a refusal.
 */
async function inheritSiblingPointer(repoRoot) {
  const scan = await scanSiblingPointers(repoRoot)
  if (!scan.ok) {
    return {
      failure: refusal('git-unavailable', `cannot enumerate sibling worktrees: ${scan.message}`, {
        detail: scan.detail,
      }),
    }
  }
  if (scan.unreadable.length > 0) {
    return {
      failure: refusal('sibling-unreadable', 'a sibling worktree could not be read, so no new project id is invented', {
        details: scan.unreadable,
      }),
    }
  }
  const pointers = scan.siblings.map((sibling) => sibling.pointer)
  if (pointers.length === 0) return { pointer: null }
  const [first, ...rest] = pointers
  for (const other of rest) {
    if (!samePointer(first, other)) {
      return {
        failure: refusal('sibling-disagreement', 'sibling worktrees carry different .obsidian-mem pointers; bind explicitly', {
          details: [first, other],
        }),
      }
    }
  }
  return { pointer: first }
}

/**
 * After creating a pointer, look for a sibling that holds a *different* id.
 *
 * Two fresh worktrees can both pass the inheritance scan before either writes a
 * pointer, each minting its own id. Re-enumerating siblings after the exclusive
 * create turns that race into a refusal — and the caller unwinds the pointer it
 * just wrote — instead of a repository permanently bound to two project ids. A
 * re-check that cannot be performed is also a refusal: an unverifiable create
 * must not be trusted.
 *
 * @param {string} repoRoot - git root of the current worktree.
 * @param {string} projectId - the id this call just wrote.
 * @returns {Promise<object|null>} a refusal when a sibling disagrees, otherwise null.
 */
async function detectConcurrentBind(repoRoot, projectId) {
  const scan = await scanSiblingPointers(repoRoot)
  if (!scan.ok) {
    return refusal('git-unavailable', `cannot re-check sibling worktrees after writing ${POINTER_FILENAME}: ${scan.message}`)
  }
  for (const sibling of scan.siblings) {
    if (sibling.pointer.projectId !== projectId) {
      return refusal(
        'concurrent-bind',
        `${POINTER_FILENAME} was created with ${projectId}, but ${sibling.path} already binds this repository to ${sibling.pointer.projectId}`,
        { details: [{ path: sibling.path, projectId: sibling.pointer.projectId }] },
      )
    }
  }
  if (scan.unreadable.length > 0) {
    return refusal('sibling-unreadable', 'a sibling worktree could not be re-read after writing the pointer', {
      details: scan.unreadable,
    })
  }
  return null
}

/**
 * Remove the pointer this call just created, if it still carries this call's id.
 *
 * The read-back guard means a concurrent writer's file is never deleted: when
 * the file no longer holds our id, it is left exactly as it is.
 *
 * @param {string} repoRoot - git root of the current worktree.
 * @param {string} projectId - the id this call just wrote.
 * @returns {Promise<boolean>} whether the pointer was removed.
 */
async function removeOwnPointer(repoRoot, projectId) {
  let current
  try {
    current = await readPointer(repoRoot)
  } catch {
    return false
  }
  if (current === null || current.pointer.projectId !== projectId) return false
  try {
    await fs.rm(current.path, { force: true })
    return true
  } catch {
    return false
  }
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

// The public surface of this module before the R20 split — unchanged, so Task 5,
// 7 and 17 can keep importing it from here.
export { findGitRoot, scanSiblingPointers } from './git.js'
export { isCloudManagedVaultRoot, resolveVaultFile, resolveVaultRoot, splitRelativeVaultPath } from './paths.js'
export {
  createPointerExclusive,
  isUuidV4,
  isValidSlug,
  MAX_POINTER_BYTES,
  newPointer,
  parsePointerBytes,
  POINTER_FILENAME,
  POINTER_SCHEMA,
  PointerError,
  readPointer,
  samePointer,
  slugify,
} from './pointer.js'
export {
  parseRegistryMarkdown,
  PROJECT_DIR_SEPARATOR,
  PROJECTS_DIR,
  projectRelativeDir,
  readRegistry,
  REGISTRY_RELATIVE_PATH,
  RegistryError,
} from './registry.js'
