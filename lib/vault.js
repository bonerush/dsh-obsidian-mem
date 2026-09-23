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
//   ./pointer.js     the four-field pointer (parse, read, exclusive create)
//   ./registry.js    the vault registry (parse, read, one-to-one validation)
//   ./git.js         git root discovery and sibling-worktree enumeration
//   ./transaction.js whole-vault write lock, snapshots, atomic publish, recovery
//   ./receipts.js    idempotency receipts, in the vault and in the data root
// Everything those modules exported through this file before the R20 split is
// re-exported at the bottom, so importers do not have to move.
import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { findGitRoot, runGit, scanSiblingPointers } from './git.js'
import { assertOwnedFrontmatter, validateKnownPropertyTypes } from './frontmatter.js'
import { isCloudManagedVaultRoot, isInside, PathSafetyError, resolveDataRoot, resolveVaultFile, resolveVaultRoot } from './paths.js'
import { newTransactionId, runTransaction } from './transaction.js'
import {
  createPointerExclusive,
  isValidSlug,
  isUuidV4,
  newPointer,
  POINTER_FILENAME,
  PointerError,
  readPointer,
  samePointer,
} from './pointer.js'
import {
  inspectRegistryRegion,
  parseProjectRelativeDir,
  parseRegistryMarkdown,
  PROJECTS_DIR,
  projectRelativeDir,
  readRegistry,
  REGISTRY_RELATIVE_PATH,
  renderRegistryDocument,
  renderRegistryRegion,
  RegistryError,
} from './registry.js'

/** Every bind mode the plugin understands (spec §5.2). */
export const BIND_MODES = Object.freeze(['show', 'local', 'fork', 'retain'])

/**
 * Resolve the vault project binding for a working directory.
 *
 * Resolution order (spec §5.2): normalize the vault root, refuse a cwd that is
 * inside the vault, refuse a cloud-managed vault root, find the git root, read
 * the pointer, validate or exclusively create it (inheriting a sibling
 * worktree's pointer when the current one has none), then check the vault
 * registry for id/directory conflicts and return the binding.
 *
 * The optional `mode` is what turns a resolution into an explicit binding
 * action (Task 17, spec §5.2):
 *
 *   * `show` (and no mode at all) reports; it never creates or repairs a pointer.
 *   * `local` binds this directory explicitly, including one that is not in a git
 *     repository (the pointer then lives in the directory itself). It never
 *     overwrites an existing pointer — an existing identity wins.
 *   * `fork` gives this worktree a *new* project id: it pre-checks the new id and
 *     its directory against the registry and the filesystem, then swaps the
 *     pointer atomically. It never moves the old project's content; the caller
 *     bootstraps the new identity afterwards.
 *   * `retain` confirms that this repository is still the same project and
 *     records the confirmed origin URL as the registry's remote hint. Nothing
 *     else in the row is touched.
 *
 * @param {object} options - resolution inputs.
 * @param {string} options.cwd - working directory to bind.
 * @param {string} options.vaultRoot - configured vault root (absolute or `~/…`).
 * @param {string} [options.mode] - `show` reports without writing; `local`/`fork`/`retain` are explicit identity actions.
 * @param {string} [options.dataRoot] - the plugin data root; required by `retain`, which rewrites the shared registry under the vault lock.
 * @param {string} [options.home] - home directory for `~/` expansion and cloud checks (test/host seam).
 * @returns {Promise<object>} a `kind:'bound'` binding, or a refusal object.
 * @throws {RangeError} when `cwd`, `vaultRoot`, `mode` or `dataRoot` is invalid.
 */
export async function resolveBinding({ cwd, vaultRoot, mode, dataRoot = null, home = homedir() } = {}) {
  if (typeof cwd !== 'string' || !cwd.trim()) throw new RangeError('cwd must be a non-blank path')
  if (typeof vaultRoot !== 'string' || !vaultRoot.trim()) throw new RangeError('vaultRoot must be a non-blank path')
  if (mode !== undefined && !BIND_MODES.includes(mode)) {
    throw new RangeError(`mode must be one of ${BIND_MODES.join(', ')}`)
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

  const gitRoot = await findGitRoot(cwdReal)
  let repoRoot = gitRoot
  // `local` is the one mode that may bind a directory that is not a repository:
  // the explicit action the design offers for a scratch or non-git directory.
  const unversionedLocal = repoRoot === null && mode === 'local'
  if (unversionedLocal) repoRoot = cwdReal
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

  if (mode === 'fork') {
    if (existing === null) {
      return refusal('no-pointer', `${pointerPath} does not exist, so there is no project identity to fork away from`, {
        repoRoot, vaultRoot: vault.root, pointerPath,
      })
    }
    return forkProject({ repoRoot, vaultRoot: vault.root, pointerPath, existing, home })
  }
  if (mode === 'retain') {
    if (existing === null) {
      return refusal('no-pointer', `${pointerPath} does not exist, so there is no binding to confirm`, {
        repoRoot, vaultRoot: vault.root, pointerPath,
      })
    }
    return retainProject({ repoRoot, vaultRoot: vault.root, pointerPath, existing, dataRoot, home })
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
  } else if (unversionedLocal) {
    // Nothing to inherit from and no sibling worktrees to scan: the explicit
    // local bind mints this directory's own identity.
    pointer = newPointer(repoRoot)
    pointerCreated = await createPointerExclusive(pointerPath, pointer)
    if (!pointerCreated) {
      const raced = await readPointerOrRefuse(repoRoot, { repoRoot, vaultRoot: vault.root, pointerPath })
      if (raced.refusal !== undefined) return raced.refusal
      pointer = raced.pointer
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
      const raced = await readPointerOrRefuse(repoRoot, { repoRoot, vaultRoot: vault.root, pointerPath })
      if (raced.refusal !== undefined) return raced.refusal
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
      return refusal('project-directory-not-a-directory', `${projectDir} is not a directory`, {
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
 * Re-read a pointer another writer may have just published.
 *
 * @param {string} repoRoot - the repository root.
 * @param {object} context - paths for the refusal message.
 * @returns {Promise<{pointer: object}|{refusal: object}>} the pointer, or a refusal.
 */
async function readPointerOrRefuse(repoRoot, context) {
  let raced
  try {
    raced = await readPointer(repoRoot)
  } catch (error) {
    if (error instanceof PointerError) return { refusal: refusal(error.code, error.message, context) }
    throw error
  }
  if (raced === null) {
    return { refusal: refusal('pointer-race', `${context.pointerPath} appeared and vanished while binding`, context) }
  }
  return { pointer: raced.pointer }
}

/**
 * Give this worktree a new project identity, leaving the old project alone.
 *
 * The target id and its vault directory are checked before anything is written,
 * then the pointer is replaced atomically under a hash guard (the bytes this call
 * read must still be the bytes on disk). The old project's directory, registry
 * row and notes are never touched — a fork separates identities, it does not move
 * content. A crash after the swap leaves a valid new pointer, so the next
 * resolution continues with the new identity and the caller's bootstrap
 * completes it.
 *
 * @param {{repoRoot: string, vaultRoot: string, pointerPath: string, existing: {bytes: Buffer, pointer: object}, home: string}} input - the current identity.
 * @returns {Promise<object>} the new binding, or a refusal.
 */
async function forkProject({ repoRoot, vaultRoot, pointerPath, existing, home }) {
  const next = newPointer(repoRoot)
  if (next.projectId === existing.pointer.projectId) {
    return refusal('fork-same-id', 'the fresh identity collided with the current one; nothing was changed', { repoRoot, vaultRoot, pointerPath })
  }
  const relativeDir = projectRelativeDir(next.slug, next.projectId)

  let registry
  try {
    registry = await readRegistry(vaultRoot)
  } catch (error) {
    if (error instanceof RegistryError) return refusal(error.code, error.message, { repoRoot, vaultRoot, pointerPath })
    throw error
  }
  if (registry.byId.has(next.projectId)) {
    return refusal('fork-id-taken', `${next.projectId} already owns ${registry.byId.get(next.projectId)} in the vault registry`, { repoRoot, vaultRoot, pointerPath })
  }
  const owner = registry.byDir.get(relativeDir)
  if (owner !== undefined) {
    return refusal('directory-taken', `${relativeDir} already belongs to project ${owner}`, { repoRoot, vaultRoot, relativeDir })
  }
  let projectDir
  try {
    projectDir = await resolveVaultFile(vaultRoot, relativeDir, { home })
  } catch (error) {
    if (error instanceof PathSafetyError) return refusal('project-directory-symlink', error.message, { repoRoot, vaultRoot, relativeDir })
    throw error
  }
  if ((await lstatOrNull(projectDir)) !== null) {
    return refusal('directory-taken', `${relativeDir} already exists in the vault, so the fork would write into an unowned directory`, { repoRoot, vaultRoot, relativeDir })
  }

  const swapped = await replacePointerAtomic(pointerPath, existing.bytes, next)
  if (swapped !== null) return refusal(swapped.reason, swapped.message, { repoRoot, vaultRoot, pointerPath })

  return {
    kind: 'bound',
    projectId: next.projectId,
    slug: next.slug,
    displayName: next.displayName,
    schema: next.schema,
    vaultRoot,
    vaultExists: true,
    repoRoot,
    pointerPath,
    pointerCreated: false,
    pointerInherited: false,
    pointerReplaced: true,
    previousProjectId: existing.pointer.projectId,
    relativeDir,
    projectDir,
    registered: false,
  }
}

/**
 * Replace a pointer atomically, only while its bytes still match what was read.
 *
 * `rename` publishes the whole new file or nothing, so a reader never observes a
 * half-written pointer; the pre-write comparison is what keeps a concurrent
 * writer's identity from being silently discarded.
 *
 * @param {string} pointerPath - the pointer path at the repository root.
 * @param {Buffer} expected - the bytes this call read.
 * @param {object} next - the new four-field pointer.
 * @returns {Promise<{reason: string, message: string}|null>} a refusal, or `null` on success.
 */
async function replacePointerAtomic(pointerPath, expected, next) {
  let current
  try {
    current = await fs.readFile(pointerPath)
  } catch (error) {
    return { reason: 'pointer-unreadable', message: `cannot re-read ${pointerPath}: ${error.code ?? error.message}` }
  }
  if (!current.equals(expected)) {
    return { reason: 'pointer-changed', message: `${pointerPath} changed after it was read; refusing to replace another writer's identity` }
  }
  const temporary = `${pointerPath}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o644 })
    await fs.rename(temporary, pointerPath)
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {})
    return { reason: 'pointer-write-failed', message: `cannot replace ${pointerPath}: ${error.code ?? error.message}` }
  }
  let written
  try {
    written = JSON.parse(await fs.readFile(pointerPath, 'utf8'))
  } catch (error) {
    return { reason: 'pointer-write-failed', message: `${pointerPath} is unreadable after the fork swap: ${error.code ?? error.message}` }
  }
  if (written.projectId !== next.projectId) {
    return { reason: 'pointer-write-failed', message: `${pointerPath} does not carry the new identity after the fork swap` }
  }
  return null
}

/**
 * Confirm the current binding and record the repository's origin as a remote hint.
 *
 * Only the registry row's `remote` cell changes. `dataRoot` is required because
 * the shared registry is rewritten under the whole-vault write lock, and a caller
 * that cannot name the plugin data root cannot participate in that lock.
 *
 * @param {{repoRoot: string, vaultRoot: string, pointerPath: string, existing: object, dataRoot: string|null, home: string}} input - the current identity.
 * @returns {Promise<object>} the binding (with `retained`), or a refusal.
 */
async function retainProject({ repoRoot, vaultRoot, pointerPath, existing, dataRoot, home }) {
  if (typeof dataRoot !== 'string' || dataRoot.trim() === '') {
    throw new RangeError('mode "retain" rewrites the vault registry and therefore needs the plugin data root')
  }
  const remote = await standardizedRemote(repoRoot)
  if (remote === null) {
    return refusal('no-remote', 'this repository has no origin remote, so there is no hint to confirm', { repoRoot, vaultRoot, pointerPath })
  }
  let registry
  try {
    registry = await readRegistry(vaultRoot)
  } catch (error) {
    if (error instanceof RegistryError) return refusal(error.code, error.message, { repoRoot, vaultRoot, pointerPath })
    throw error
  }
  const projectId = existing.pointer.projectId
  const row = registry.byId.get(projectId)
  if (row === undefined) {
    return refusal('unregistered', `${REGISTRY_RELATIVE_PATH} has no row for ${projectId}; bootstrap the project before confirming its remote`, { repoRoot, vaultRoot, pointerPath })
  }
  const binding = {
    kind: 'bound',
    projectId,
    slug: existing.pointer.slug,
    displayName: row.displayName,
    schema: existing.pointer.schema,
    vaultRoot,
    vaultExists: true,
    repoRoot,
    pointerPath,
    pointerCreated: false,
    pointerInherited: false,
    relativeDir: row.dir,
    registered: true,
    remote,
    retained: row.remote !== remote,
  }
  if (row.remote === remote) return binding
  try {
    await runTransaction(
      binding,
      {
        txId: newTransactionId(),
        updates: [{
          path: REGISTRY_RELATIVE_PATH,
          hash: '*',
          transform: (bytes) => retainRemoteTransform(bytes.toString('utf8'), projectId, remote),
        }],
        receipt: null,
      },
      { dataRoot, home },
    )
  } catch (error) {
    // A tampered registry, an unresolved earlier transaction or a failed lock is
    // a refusal to change the binding, reported like every other bind conflict
    // rather than thrown at the caller as an unexpected error.
    if (error instanceof BootstrapError || error instanceof TransactionError) {
      return refusal(error.code, error.message, { repoRoot, vaultRoot, pointerPath })
    }
    throw error
  }
  return binding
}

/**
 * The pure read-modify-write that records one confirmed remote hint.
 *
 * The generated region must still match its declared hash (R24) and must still
 * carry this project's row; every refusal happens before a byte is produced, so a
 * tampered or human-edited registry is never partially rewritten.
 *
 * @param {string} text - the current registry document.
 * @param {string} projectId - the project whose hint is being confirmed.
 * @param {string} remote - the standardized origin URL.
 * @returns {Buffer|null} the next document, or `null` when nothing changes.
 * @throws {BootstrapError} when the registry cannot be trusted.
 */
function retainRemoteTransform(text, projectId, remote) {
  const { rows } = parseRegistryMarkdown(text, { path: REGISTRY_RELATIVE_PATH })
  const region = inspectRegistryRegion(text)
  if (region === null) {
    throw new BootstrapError('registry-invalid', `${REGISTRY_RELATIVE_PATH} has no generated region to update`)
  }
  if (region.declaredHash === null) {
    throw new BootstrapError('registry-hash-missing', `${REGISTRY_RELATIVE_PATH} has no sha256 hash in its registry marker`)
  }
  if (!region.matches) {
    throw new BootstrapError('registry-hash-mismatch', `${REGISTRY_RELATIVE_PATH} does not match its recorded sha256; refusing to write it`)
  }
  const own = rows.find((entry) => entry.projectId === projectId)
  if (own === undefined) {
    throw new BootstrapError('registry-row-missing', `${REGISTRY_RELATIVE_PATH} no longer lists ${projectId}`)
  }
  if (own.remote === remote) return null
  const nextRows = rows.map((entry) => (entry.projectId === projectId ? { ...entry, remote } : entry))
  const nextText = spliceRegistryRegion(text, region, renderRegistryRegion(nextRows))
  assertRegistryDocument(nextText, REGISTRY_RELATIVE_PATH)
  return Buffer.from(nextText, 'utf8')
}

/**
 * The origin URL as the registry hint records it.
 *
 * A trailing slash and a trailing `.git` are removed because they are pure
 * spelling; the host and path are left exactly as the repository states them —
 * the hint is a human-confirmed diagnostic, never an identity.
 *
 * @param {string} repoRoot - the repository root.
 * @returns {Promise<string|null>} the standardized remote, or `null` when there is none.
 */
async function standardizedRemote(repoRoot) {
  let url
  try {
    url = (await runGit(repoRoot, ['remote', 'get-url', 'origin'])).trim()
  } catch {
    return null
  }
  if (url === '') return null
  return url.replace(/\/+$/, '').replace(/\.git$/i, '')
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

// ---------------------------------------------------------------------------
// Task 5: idempotent bootstrap of the vault skeleton and the registry
// ---------------------------------------------------------------------------

/** The user's own cross-project preferences file: read-only for the plugin (spec §5.1/§6.2, R21). */
const USER_RELATIVE_PATH = '_meta/user.md'
/** Per-project content directories (spec §5.1); each one owns an `index.md` MOC (R11). */
const MOC_DIRECTORIES = Object.freeze(['文档', '决策', '约定', '踩坑', '日志', '收件箱'])
/** The three fixed plugin-managed zones of `_meta/hot.md` (spec §6.1). */
const HOT_SECTIONS = Object.freeze(['强约束', '进行中', '已完成'])
/** Frontmatter keys whose value is a bare `YYYY-MM-DD` Date scalar (spec §6.4/R16). */
const BARE_DATE_KEYS = new Set(['created', 'updated', 'review_after'])
/** sha256 of an empty managed-region body — the hash of a freshly created MOC block. */
const EMPTY_REGION_SHA256 = createHash('sha256').update('').digest('hex')
const EMPTY_GENERATED_BEGIN = `<!-- obsidian-mem:generated begin sha256:${EMPTY_REGION_SHA256} -->`
const EMPTY_GENERATED_END = '<!-- obsidian-mem:generated end -->'
/** Only Obsidian's volatile machine-local state is ignored; memory is meant to be committed (spec §5.1). */
const VAULT_GITIGNORE = [
  '# Obsidian volatile state: the workspace layout and cache are machine-local.',
  '.obsidian/workspace.json',
  '.obsidian/workspace-mobile.json',
  '.obsidian/cache',
  '.trash/',
  '',
].join('\n')

/** A bootstrap request that cannot be honoured. */
export class BootstrapError extends Error {
  /**
   * @param {string} code - machine-readable reason (`binding-invalid`, `registry-hash-mismatch`, …).
   * @param {string} message - human-readable diagnostic naming the offending path.
   * @param {{ cause?: Error }} [options] - underlying failure, when there is one.
   */
  constructor(code, message, options) {
    super(message, options)
    this.name = 'BootstrapError'
    this.code = code
  }
}

/**
 * Create everything a bound project is missing in the vault, then register it.
 *
 * `bootstrapVault` only ever *adds*: directories through `mkdir(…, {recursive:true})`
 * and files through `open(…, 'wx')`. A path that already exists is read and
 * checked for the expected type and then left exactly as it is, so a second run
 * is byte- and mtime-identical and a hand-written `index.md` is never rewritten.
 * `_meta/user.md` belongs to the user (spec §5.1/§6.2): R21 gives it a template
 * when it is missing and never rewrites it afterwards. `git init` runs only for a vault this same call created, and only
 * when `initGitOnCreate` is true.
 *
 * The one file that can be rewritten is the registry document: a valid generated
 * region whose recorded sha256 matches its bytes may gain the project's row. A
 * region whose hash does not match, a missing hash, or a table the Task 4 parser
 * rejects stops the call before the first write, so a tampered registry cannot
 * leave a half-built skeleton.
 *
 * That registry update is a *transaction* (Task 7): `_meta/项目注册表.md` is shared
 * by every project in the vault, so it is rewritten under the whole-vault write
 * lock with a snapshot, an atomic publish and crash recovery instead of the direct
 * `replaceFile` Task 5 used. It carries no receipt, because `_meta/log.md` is not
 * part of the bootstrap skeleton. The data root defaults to `resolveDataRoot()`
 * (derived from `DSH_HOME`); tests pass a throwaway one explicitly.
 *
 * `createdPaths` and `existingPaths` are vault-relative POSIX paths in the order
 * this call visited them (parents before children); the vault root itself has no
 * vault-relative name and is reported through `vaultCreated` instead.
 *
 * Two further refusals happen before the first write. The file-level property
 * preflight reads the vault's visible frontmatter types: Obsidian registers a
 * property's type vault-wide by name, so a vault that already holds `tags: foo`
 * must not receive `tags: […]` (`property-type-conflict`), while unreadable or
 * unparsable notes and an exceeded scan bound are reported as
 * `property-preflight-conflict`. And every note template this call is about to
 * create is rendered and then verified against the same closed vocabulary
 * (`template-invalid`).
 *
 * @param {object} binding - a `kind:'bound'` binding from `resolveBinding`.
 * @param {{ initGitOnCreate?: boolean, home?: string, dataRoot?: string }} [options] - git opt-in, home for path decisions, and the transaction data root (defaults to `resolveDataRoot()`).
 * @returns {Promise<{projectId: string, slug: string, displayName: string, vaultRoot: string, relativeDir: string, projectDir: string, vaultCreated: boolean, gitInitialized: boolean, registryUpdated: boolean, createdPaths: string[], existingPaths: string[]}>} the bootstrap outcome.
 * @throws {BootstrapError} when the binding, the vault's visible property types, a note template, or the vault registry cannot be trusted.
 * @throws {RegistryError} when an existing registry table is invalid.
 * @throws {PathSafetyError} when a vault path would walk through a symlink.
 * @throws {TransactionError} when the registry transaction cannot be completed safely.
 */
export async function bootstrapVault(binding, { initGitOnCreate = false, home = homedir(), dataRoot = resolveDataRoot() } = {}) {
  if (typeof initGitOnCreate !== 'boolean') throw new RangeError('initGitOnCreate must be a boolean')
  const project = validateBootstrapBinding(binding)
  const vault = await resolveVaultRoot(binding.vaultRoot, { home })
  if (await isCloudManagedVaultRoot(vault.root, { home })) {
    throw new BootstrapError('vault-cloud-managed', `refusing to bootstrap the cloud-managed vault at ${vault.root}`)
  }

  // The file-level property preflight (spec §6.4/R18), before the first write.
  // Obsidian registers a property's type vault-wide by name, so writing
  // `tags: […]` into a vault that already holds `tags: foo` would pollute every
  // note that shares the name. `validateKnownPropertyTypes` itself only inspects
  // value types visible in note bytes and never repairs them — see the residual
  // limit documented in ./frontmatter.js.
  if (vault.exists) {
    const preflight = await validateKnownPropertyTypes(vault.root, { home })
    if (preflight.conflicts.length > 0) {
      const [first] = preflight.conflicts
      // The preflight reports several reasons (a type conflict, unparsable
      // frontmatter, an unreadable note, an exceeded scan bound). Only the first
      // of those is a property-type conflict, so the code says which it is
      // instead of labelling every refusal the same way.
      const reasons = new Set(preflight.conflicts.map((conflict) => conflict.reason))
      const code = reasons.size === 1 && reasons.has('type-conflict')
        ? 'property-type-conflict'
        : 'property-preflight-conflict'
      const error = new BootstrapError(
        code,
        preflight.conflicts.length === 1
          ? first.message
          : `${first.message} (and ${preflight.conflicts.length - 1} more conflict${preflight.conflicts.length === 2 ? '' : 's'})`,
      )
      error.conflicts = preflight.conflicts
      error.scanned = preflight.scanned
      throw error
    }
  }

  // Every refusal that depends on existing bytes happens before the first write.
  const registryEntry = {
    projectId: project.projectId,
    dir: project.relativeDir,
    displayName: project.displayName,
    remote: '',
  }
  const registry = await prepareRegistry(vault.root, registryEntry, { home })

  let vaultCreated = false
  if (vault.exists) {
    const stat = await fs.lstat(vault.root)
    if (!stat.isDirectory()) throw new BootstrapError('vault-root-not-directory', `${vault.root} is not a directory`)
  } else {
    await fs.mkdir(vault.root, { recursive: true })
    vaultCreated = true
  }
  const gitInitialized = vaultCreated && initGitOnCreate ? await initVaultGit(vault.root) : false

  const createdPaths = []
  const existingPaths = []
  const targets = bootstrapTargets(project, localDate())
  // A new note is serialized whole (spec §6.4), and the rendered bytes are
  // verified against the same closed vocabulary the preflight uses — before the
  // first write, so a template regression fails loudly instead of writing a note
  // whose frontmatter Obsidian reads differently from what the template meant.
  for (const target of targets) {
    if (target.kind !== 'file' || !target.path.endsWith('.md')) continue
    try {
      assertOwnedFrontmatter(target.contents, { path: target.path })
    } catch (error) {
      throw new BootstrapError('template-invalid', error.message, { cause: error })
    }
  }
  for (const target of targets) {
    const absolute = await resolveVaultFile(vault.root, target.path, { home })
    const created = target.kind === 'directory'
      ? await ensureDirectory(absolute, target.path)
      : await ensureFile(absolute, target.path, target.contents)
    if (created) createdPaths.push(target.path)
    else existingPaths.push(target.path)
  }

  let registryUpdated = false
  if (registry.changed) {
    // Task 7: `_meta/项目注册表.md` is shared by every project in the vault, so
    // its update goes through the transaction engine (whole-vault lock,
    // snapshot, atomic publish, crash recovery) rather than a direct write. The
    // row is appended inside the lock, so two projects binding at the same
    // moment both land their row instead of one failing a stale hash.
    await runTransaction(
      binding,
      {
        txId: newTransactionId(),
        creates: registry.created ? [{ path: registry.relativePath, contents: registry.nextText }] : [],
        updates: registry.created
          ? []
          : [{
            path: registry.relativePath,
            transform: (current) => current === null
              ? renderRegistryDocument([registryEntry])
              : registryNextText(current.toString('utf8'), registryEntry, registry.relativePath),
          }],
        receipt: null,
      },
      { dataRoot },
    )
    registryUpdated = true
  }
  if (registry.created) createdPaths.push(registry.relativePath)
  else existingPaths.push(registry.relativePath)

  return {
    projectId: project.projectId,
    slug: project.slug,
    displayName: project.displayName,
    vaultRoot: vault.root,
    relativeDir: project.relativeDir,
    projectDir: await resolveVaultFile(vault.root, project.relativeDir, { home }),
    vaultCreated,
    gitInitialized,
    registryUpdated,
    createdPaths,
    existingPaths,
  }
}

/**
 * Validate the subset of a binding that bootstrap depends on.
 *
 * `projectDir` is deliberately not trusted: it is recomputed from `vaultRoot`
 * and `relativeDir` so a caller cannot redirect a write. The directory name must
 * satisfy R4 (`项目/<slug>--<projectId 前8位>`), which is what keeps the registry
 * row the writer emits parseable; the slug half may differ from the pointer's
 * current slug because renaming a repository never moves vault content.
 *
 * @param {object} binding - candidate binding.
 * @returns {{projectId: string, slug: string, displayName: string, relativeDir: string}} the validated fields.
 * @throws {BootstrapError} when a field is missing or unsafe.
 */
function validateBootstrapBinding(binding) {
  if (binding === null || typeof binding !== 'object' || Array.isArray(binding)) {
    throw new BootstrapError('binding-invalid', 'bootstrapVault requires a bound project binding')
  }
  if (binding.kind !== undefined && binding.kind !== 'bound') {
    throw new BootstrapError('binding-invalid', `bootstrapVault requires a bound binding, not ${JSON.stringify(binding.kind)}`)
  }
  if (!isUuidV4(binding.projectId)) throw new BootstrapError('binding-invalid', 'binding.projectId must be a UUIDv4')
  if (!isValidSlug(binding.slug)) throw new BootstrapError('binding-invalid', 'binding.slug must be a vault slug')
  const { displayName } = binding
  if (
    typeof displayName !== 'string'
    || displayName.trim().length === 0
    || displayName.length > 200
    || /[\u0000-\u001f\u007f]/.test(displayName)
  ) {
    throw new BootstrapError('binding-invalid', 'binding.displayName must be a non-blank, control-character-free name of at most 200 characters')
  }
  if (typeof binding.vaultRoot !== 'string' || binding.vaultRoot.trim().length === 0) {
    throw new BootstrapError('binding-invalid', 'binding.vaultRoot must be a non-blank path')
  }
  const relativeDir = binding.relativeDir === undefined || binding.relativeDir === null
    ? projectRelativeDir(binding.slug, binding.projectId)
    : binding.relativeDir
  const shape = parseProjectRelativeDir(relativeDir)
  if (shape === null) {
    throw new BootstrapError('binding-invalid', `binding.relativeDir must be ${PROJECTS_DIR}/<slug>--<projectId 前8位>: ${relativeDir}`)
  }
  if (shape.id8 !== binding.projectId.slice(0, 8)) {
    throw new BootstrapError('binding-invalid', `binding.relativeDir ${relativeDir} does not carry project id ${binding.projectId}`)
  }
  return { projectId: binding.projectId, slug: binding.slug, displayName, relativeDir }
}

/**
 * Every path bootstrap ensures, directories first so parents precede children.
 *
 * @param {{relativeDir: string, displayName: string, slug: string, projectId: string}} project - validated binding fields.
 * @param {string} today - `YYYY-MM-DD` used for the notes' `created`/`updated`.
 * @returns {{kind: 'directory'|'file', path: string, contents?: string}[]} ordered targets.
 */
function bootstrapTargets(project, today) {
  const { relativeDir, displayName, slug, projectId } = project
  const directories = [
    '_meta',
    '_meta/.history',
    '方法',
    PROJECTS_DIR,
    relativeDir,
    `${relativeDir}/_meta`,
    ...MOC_DIRECTORIES.map((dir) => `${relativeDir}/${dir}`),
  ]
  const files = [
    { path: '.gitignore', contents: VAULT_GITIGNORE },
    // R21: the user's cross-project preferences file gets a template when it is
    // missing and is never rewritten afterwards — `ensureFile` is an exclusive
    // create, so a file the user has written stays the user's for good.
    { path: USER_RELATIVE_PATH, contents: userTemplate() },
    { path: '方法/index.md', contents: mocTemplate({ title: '方法', projectId: null, slug: null, today }) },
    { path: `${relativeDir}/index.md`, contents: mocTemplate({ title: displayName, projectId, slug, today, relativeDir }) },
    { path: `${relativeDir}/_meta/hot.md`, contents: hotTemplate({ projectId, slug, today }) },
    ...MOC_DIRECTORIES.map((dir) => ({
      path: `${relativeDir}/${dir}/index.md`,
      contents: mocTemplate({ title: dir, projectId, slug, today }),
    })),
  ]
  return [
    ...directories.map((path) => ({ kind: 'directory', path })),
    ...files.map((file) => ({ kind: 'file', ...file })),
  ]
}

/**
 * The one template `_meta/user.md` receives, and only when it is missing (R21).
 *
 * The file belongs to the user: bootstrap creates it once, no transaction ever
 * targets it, and the plugin only reads it. Its frontmatter carries `tags` — a
 * property the vault already registers as a list — so creating it can never
 * register a new property type or conflict with one.
 *
 * @returns {string} the template text.
 */
function userTemplate() {
  return [
    ...frontmatterLines({ tags: ['dsh-mem/user'] }),
    '# 用户偏好',
    '',
    '<!-- 本文件由 obsidian-mem 在首次引导时创建，之后插件永不改写（只读）。请在此写下跨项目的个人偏好。 -->',
    '',
  ].join('\n')
}

/**
 * A hub MOC note: frontmatter, a title, the hub's directory links, and an empty
 * generated block for the notes it will list (spec §6.4).
 *
 * @param {{title: string, projectId: string|null, slug: string|null, today: string, relativeDir?: string|null}} note - template inputs.
 * @returns {string} the note text.
 */
function mocTemplate({ title, projectId, slug, today, relativeDir = null }) {
  const lines = [
    ...frontmatterLines({
      // `hub` is one of the fixed id prefixes (spec §6.4); the id is minted once,
      // when the file is created, and never changes with a rename.
      id: `hub-${randomUUID()}`,
      type: 'hub',
      title,
      status: 'active',
      created: today,
      updated: today,
      tags: projectId === null ? ['dsh-mem/hub'] : ['dsh-mem/hub', `project/${slug}`],
      project: projectId,
      source: 'agent',
      harness: 'dsh',
      trust: 'agent',
    }),
    `# ${title}`,
    '',
  ]
  if (relativeDir !== null) {
    lines.push('## 目录', '')
    for (const dir of MOC_DIRECTORIES) lines.push(`- [[${relativeDir}/${dir}/index|${dir}]]`)
    lines.push('')
  }
  lines.push('## 条目', '', EMPTY_GENERATED_BEGIN, EMPTY_GENERATED_END)
  return `${lines.join('\n')}\n`
}

/**
 * The hot-memory file with its three fixed plugin-managed sections (spec §6.1).
 *
 * It carries no `id`: the spec's id-prefix table has no `hot` prefix, and hot
 * memory is a container of entries rather than a note.
 *
 * @param {{projectId: string, slug: string, today: string}} note - template inputs.
 * @returns {string} the hot file text.
 */
function hotTemplate({ projectId, slug, today }) {
  const lines = [
    ...frontmatterLines({
      type: 'hot',
      title: '热记忆',
      status: 'active',
      created: today,
      updated: today,
      tags: ['dsh-mem/hot', `project/${slug}`],
      project: projectId,
      source: 'agent',
      harness: 'dsh',
      trust: 'agent',
    }),
    '# 热记忆',
    '',
  ]
  for (const section of HOT_SECTIONS) lines.push(`## ${section}`, '')
  return `${lines.join('\n')}\n`
}

/**
 * Serialize the closed frontmatter vocabulary.
 *
 * Plain text and identifiers are quoted, `tags` is a flow list of quoted strings,
 * dates stay bare `YYYY-MM-DD` (Obsidian's Date type), and `null`/numbers stay
 * unquoted — the rules of spec §6.4/R5/R16/R21 in one place, so a template can
 * never write a silently coerced scalar.
 *
 * @param {Record<string, string|number|string[]|null|undefined>} fields - ordered frontmatter fields.
 * @returns {string[]} the `---`-delimited lines.
 */
function frontmatterLines(fields) {
  const lines = ['---']
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      lines.push(`${key}: [${value.map((item) => JSON.stringify(String(item))).join(', ')}]`)
    } else if (value === null) {
      lines.push(`${key}: null`)
    } else if (typeof value === 'number') {
      lines.push(`${key}: ${value}`)
    } else {
      const text = String(value)
      lines.push(
        BARE_DATE_KEYS.has(key) && /^\d{4}-\d{2}-\d{2}$/.test(text)
          ? `${key}: ${text}`
          : `${key}: ${JSON.stringify(text)}`,
      )
    }
  }
  lines.push('---')
  return lines
}

/**
 * Today's local date as `YYYY-MM-DD`, the only date format the vault uses.
 *
 * @param {Date} [now] - clock injection point for tests.
 * @returns {string} the formatted local date.
 */
function localDate(now = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/**
 * Read the registry and decide whether (and how) it must change.
 *
 * A missing document is rendered whole and created exclusively. An existing one
 * is parsed and, when it carries a generated region, hash-verified before any
 * new row is considered; a table the parser rejects or a hash that does not
 * match is a refusal, not a repair. A row that already exists is verified and
 * left untouched — bootstrap only adds what is missing.
 *
 * @param {string} vaultRoot - normalized vault root.
 * @param {{projectId: string, dir: string, displayName: string, remote: string}} entry - the row to ensure.
 * @param {{home: string}} options - home for `~/` expansion.
 * @returns {Promise<{path: string, relativePath: string, created: boolean, changed: boolean, nextText: string}>} the plan.
 * @throws {BootstrapError} when the registry exists but cannot be trusted.
 * @throws {RegistryError} when the registry document is invalid.
 */
async function prepareRegistry(vaultRoot, entry, { home }) {
  const relativePath = REGISTRY_RELATIVE_PATH
  const path = await resolveVaultFile(vaultRoot, relativePath, { home })
  const stat = await lstatOrNull(path)
  if (stat === null) {
    const nextText = renderRegistryDocument([entry])
    assertRegistryDocument(nextText, relativePath)
    return { path, relativePath, created: true, changed: true, nextText }
  }
  if (!stat.isFile()) {
    throw new BootstrapError('registry-not-a-file', `${relativePath} exists in the vault but is not a regular file`)
  }
  let bytes
  try {
    bytes = await fs.readFile(path)
  } catch (error) {
    throw new BootstrapError('registry-unreadable', `cannot read ${relativePath}: ${error.code ?? error.message}`, { cause: error })
  }
  const text = bytes.toString('utf8')
  const nextText = registryNextText(text, entry, relativePath)
  // `nextText === null` means this project's row is already there and verified.
  return { path, relativePath, created: false, changed: nextText !== null, nextText: nextText ?? text }
}

/**
 * The next registry document after adding one project's row, or `null` when the
 * row is already present.
 *
 * This is the whole read-modify-write of `_meta/项目注册表.md` as a pure
 * function of the bytes on disk, which is what lets the transaction engine run
 * it *inside* the whole-vault lock: two projects bootstrapping at the same
 * moment both append their row instead of one losing the other's update. Every
 * refusal (a conflicting id, a taken directory, a tampered generated region)
 * happens before any byte is produced, so a bad registry is never partially
 * rewritten.
 *
 * @param {string} text - current registry document.
 * @param {{projectId: string, dir: string, displayName: string, remote: string}} entry - the row to ensure.
 * @param {string} [relativePath] - path used in diagnostics.
 * @returns {string|null} the next document, or `null` when the row already exists.
 * @throws {BootstrapError} when the existing document cannot be trusted.
 * @throws {RegistryError} when the existing table is invalid.
 */
function registryNextText(text, entry, relativePath = REGISTRY_RELATIVE_PATH) {
  const { regionPresent, rows } = parseRegistryMarkdown(text, { path: relativePath })

  const own = rows.find((row) => row.projectId === entry.projectId)
  if (own !== undefined && own.dir !== entry.dir) {
    throw new BootstrapError('registry-id-conflict', `${relativePath} already maps ${entry.projectId} to ${own.dir}, not ${entry.dir}`)
  }
  const owner = rows.find((row) => row.dir === entry.dir)
  if (owner !== undefined && owner.projectId !== entry.projectId) {
    throw new BootstrapError('registry-directory-taken', `${entry.dir} already belongs to ${owner.projectId}`)
  }

  const region = regionPresent ? inspectRegistryRegion(text) : null
  if (regionPresent) {
    if (region === null) {
      throw new BootstrapError('registry-invalid', `${relativePath} has a registry region that cannot be located`)
    }
    if (region.declaredHash === null) {
      throw new BootstrapError('registry-hash-missing', `${relativePath} has no sha256 hash in its registry marker`)
    }
    if (!region.matches) {
      throw new BootstrapError('registry-hash-mismatch', `${relativePath} generated region does not match its recorded sha256; refusing to write it`)
    }
  }
  if (own !== undefined) return null

  const nextRegion = renderRegistryRegion([...rows, entry])
  const nextText = region === null ? appendRegistryRegion(text, nextRegion) : spliceRegistryRegion(text, region, nextRegion)
  assertRegistryDocument(nextText, relativePath)
  return nextText
}

/**
 * Re-parse a registry document this module just rendered.
 *
 * The Task 4 parser re-runs UUID, R4 directory-shape and both one-to-one checks
 * on the bytes about to be written, and the declared hash is re-verified, so a
 * renderer bug cannot be committed to the vault.
 *
 * @param {string} text - rendered document.
 * @param {string} relativePath - path used in diagnostics.
 * @returns {object[]} the parsed rows.
 * @throws {BootstrapError} when the rendered document is not a valid registry.
 */
function assertRegistryDocument(text, relativePath) {
  const { regionPresent, rows } = parseRegistryMarkdown(text, { path: relativePath })
  const region = inspectRegistryRegion(text)
  if (!regionPresent || region === null || !region.matches) {
    throw new BootstrapError('registry-invalid', `${relativePath} was not rendered as a valid generated region`)
  }
  return rows
}

/**
 * Replace the generated region inside an existing document, preserving every
 * byte outside it — including a user's own preamble and comments.
 *
 * @param {string} text - existing document.
 * @param {{start: number, end: number}} region - the located region.
 * @param {string} nextRegion - the freshly rendered region.
 * @returns {string} the spliced document.
 */
function spliceRegistryRegion(text, region, nextRegion) {
  let end = region.end
  if (text.startsWith('\r\n', end)) end += 2
  else if (text.charAt(end) === '\n') end += 1
  return `${text.slice(0, region.start)}${nextRegion}${text.slice(end)}`
}

/**
 * Append a generated region to a document that has none, keeping its bytes.
 *
 * @param {string} text - existing document.
 * @param {string} region - the rendered region.
 * @returns {string} the document with the region appended.
 */
function appendRegistryRegion(text, region) {
  if (text.length === 0) return region
  return `${text}${text.endsWith('\n') ? '\n' : '\n\n'}${region}`
}

/**
 * Ensure a directory exists, or verify that whatever is there already is one.
 *
 * @param {string} path - absolute path inside the vault.
 * @param {string} relativePath - vault-relative path for diagnostics.
 * @returns {Promise<boolean>} true when this call created the directory.
 * @throws {BootstrapError} when the path is occupied by something else.
 */
async function ensureDirectory(path, relativePath) {
  const stat = await lstatOrNull(path)
  if (stat !== null) {
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new BootstrapError('not-a-directory', `${relativePath} exists in the vault but is not a directory`)
    }
    return false
  }
  try {
    await fs.mkdir(path, { recursive: true })
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    const after = await lstatOrNull(path)
    if (after === null || after.isSymbolicLink() || !after.isDirectory()) {
      throw new BootstrapError('not-a-directory', `${relativePath} exists in the vault but is not a directory`)
    }
    return false
  }
  return true
}

/**
 * Create a file exclusively, or verify that an existing one is a regular file.
 *
 * `open(…, 'wx')` is the only create this module performs; a path that already
 * exists is never opened for writing, which is what keeps a second run
 * mtime-identical and a hand-written note untouched.
 *
 * @param {string} path - absolute path inside the vault.
 * @param {string} relativePath - vault-relative path for diagnostics.
 * @param {string} contents - file contents to create.
 * @returns {Promise<boolean>} true when this call created the file.
 * @throws {BootstrapError} when the path is occupied by a directory or symlink.
 */
async function ensureFile(path, relativePath, contents) {
  let handle
  try {
    handle = await fs.open(path, 'wx', 0o644)
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    const stat = await fs.lstat(path)
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new BootstrapError('not-a-file', `${relativePath} exists in the vault but is not a regular file`)
    }
    return false
  }
  try {
    await handle.writeFile(contents, 'utf8')
    await handle.sync()
  } catch (error) {
    await handle.close().catch(() => {})
    await fs.rm(path, { force: true }).catch(() => {})
    throw error
  }
  await handle.close()
  return true
}

/**
 * Initialise a git repository in a vault this call just created.
 *
 * `git init` is preparation for versioning, never a commit or a remote, and a
 * machine without git still gets a complete vault — absence of the binary is
 * reported as `false` rather than failing the bootstrap. Any other failure is
 * real and propagates.
 *
 * @param {string} vaultRoot - the freshly created vault root.
 * @returns {Promise<boolean>} true when `git init` succeeded.
 */
async function initVaultGit(vaultRoot) {
  try {
    await runGit(vaultRoot, ['init', '-q'])
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

// The public surface of this module before the R20 split — unchanged, so Task 5,
// 7 and 17 can keep importing it from here.
export { findGitRoot, scanSiblingPointers } from './git.js'
export { MAX_BASENAME_BYTES, safeBasename } from './naming.js'
export {
  assertOwnedFrontmatter,
  FRONTMATTER_SCAN_LIMIT,
  FrontmatterError,
  OWNED_FIELDS,
  OWNED_FIELD_TYPES,
  parseNote,
  patchOwnedFields,
  PROPERTY_PREFLIGHT_MAX_FILES,
  serializeOwnedValue,
  validateKnownPropertyTypes,
} from './frontmatter.js'
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
  escapeRegistryCell,
  inspectRegistryRegion,
  parseProjectRelativeDir,
  parseRegistryMarkdown,
  PROJECT_DIR_SEPARATOR,
  PROJECTS_DIR,
  projectRelativeDir,
  readRegistry,
  REGISTRY_COLUMNS,
  REGISTRY_RELATIVE_PATH,
  RegistryError,
  renderRegistryDocument,
  renderRegistryRegion,
} from './registry.js'
// Task 7: the transaction engine and the receipt store are re-exported here too,
// so every importer keeps going through this module.
export {
  DEFAULT_LOCK_POLL_MS,
  DEFAULT_LOCK_TIMEOUT_MS,
  listPendingIndexNotifications,
  markIndexNotified,
  newTransactionId,
  recoverTransactions,
  runTransaction,
  TRANSACTION_SCHEMA,
  TransactionError,
} from './transaction.js'
export {
  appendLogEntry,
  findReceipt,
  LOG_RELATIVE_PATH,
  makeReceipt,
  RECEIPT_SCHEMA,
  ReceiptError,
  receiptKeyHash,
  renderLogEntry,
  vaultIdentity,
} from './receipts.js'
