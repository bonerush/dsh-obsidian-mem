// Stable project binding for the obsidian-mem vault (Task 4).
//
// Binding answers one question per session: which vault project directory does
// this working directory belong to? Identity lives in `.obsidian-mem` at the git
// root — exactly four fields, no machine-local path, no remote address (spec
// §5.2 / ruling D3) — and in the vault's `_meta/项目注册表.md`. The directory
// name `项目/<slug>--<projectId 前8位>/` is a rendering of that identity, never
// the identity itself, which is why renaming a repository or a display name
// never moves vault content and why a directory rename is reported instead of
// repaired.
//
// A worktree that has no pointer (an older branch, a fresh checkout) inherits
// the unique valid pointer of its siblings through the git common dir rather
// than minting a new project id. Sibling paths that cannot be read stop
// resolution: guessing would silently create a second project for the same
// repository.
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

import { isCloudManagedVaultRoot, isInside, PathSafetyError, resolveVaultFile, resolveVaultRoot } from './paths.js'

/** Repository-root pointer file (committed; four fields, no machine-local path). */
export const POINTER_FILENAME = '.obsidian-mem'
/** The only pointer schema this plugin understands. */
export const POINTER_SCHEMA = 1
/** Upper bound for the pointer file; anything larger is not a pointer. */
export const MAX_POINTER_BYTES = 4096
/** Vault directory holding one fixed directory per project (R4). */
export const PROJECTS_DIR = '项目'
/** Separator between the slug and the short project id in a project directory. */
export const PROJECT_DIR_SEPARATOR = '--'
/** Plugin-managed registry inside the vault. */
export const REGISTRY_RELATIVE_PATH = '_meta/项目注册表.md'
/** Every bind mode the plugin will eventually understand (T17). */
export const BIND_MODES = Object.freeze(['show', 'local', 'fork', 'retain'])
/** Modes that change identity; they must be reached through an explicit bind action. */
const UNAVAILABLE_BIND_MODES = Object.freeze(['local', 'fork', 'retain'])

/** A pointer that exists but cannot be trusted. */
export class PointerError extends Error {
  /**
   * @param {string} code - machine-readable reason (`pointer-corrupt`, …).
   * @param {string} message - human-readable diagnostic naming the file.
   * @param {{ cause?: Error }} [options] - underlying failure, when there is one.
   */
  constructor(code, message, options) {
    super(message, options)
    this.name = 'PointerError'
    this.code = code
  }
}

/** The vault registry exists but cannot be trusted. */
export class RegistryError extends Error {
  /**
   * @param {string} code - machine-readable reason (`registry-invalid`, …).
   * @param {string} message - human-readable diagnostic naming the file.
   * @param {{ cause?: Error }} [options] - underlying failure, when there is one.
   */
  constructor(code, message, options) {
    super(message, options)
    this.name = 'RegistryError'
    this.code = code
  }
}

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const SLUG_SOURCE = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?'
const SLUG_PATTERN = new RegExp(`^${SLUG_SOURCE}$`)
const PROJECT_DIR_PATTERN = new RegExp(`^${PROJECTS_DIR}/(${SLUG_SOURCE})${PROJECT_DIR_SEPARATOR}([0-9a-f]{8})$`)

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
 * Whether a value is a UUIDv4.
 *
 * @param {unknown} value - candidate.
 * @returns {boolean} true when `value` is a lowercase UUIDv4 string.
 */
export function isUuidV4(value) {
  return typeof value === 'string' && UUID_V4_PATTERN.test(value)
}

/**
 * Turn a repository directory name into a vault-safe slug.
 *
 * Only used to *name* a brand-new project; identity always comes from the
 * pointer, so a rename here never rebinds anything.
 *
 * @param {unknown} name - directory or display name.
 * @returns {string} a 1–63 character lowercase slug, `project` when nothing survives.
 */
export function slugify(name) {
  const cleaned = String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/g, '')
  return cleaned || 'project'
}

/**
 * The fixed vault-relative directory for a project: `项目/<slug>--<id8>`.
 *
 * @param {string} slug - validated slug.
 * @param {string} projectId - UUIDv4 project id.
 * @returns {string} vault-relative project directory.
 * @throws {RangeError} when the slug or project id cannot be rendered safely.
 */
export function projectRelativeDir(slug, projectId) {
  if (typeof slug !== 'string' || !SLUG_PATTERN.test(slug)) throw new RangeError('slug')
  if (!isUuidV4(projectId)) throw new RangeError('projectId')
  return `${PROJECTS_DIR}/${slug}${PROJECT_DIR_SEPARATOR}${projectId.slice(0, 8)}`
}

/**
 * Parse and validate pointer bytes.
 *
 * Enforces the whole contract in one place: size, JSON object shape, exactly the
 * four fields, a supported schema, a UUIDv4 identity, a safe slug and a
 * non-blank display name. Unknown schemas are reported separately from corrupt
 * files so a future format can be diagnosed instead of "repaired".
 *
 * @param {Buffer} bytes - raw pointer file contents.
 * @param {{ path?: string }} [options] - path used in diagnostics.
 * @returns {Readonly<{projectId: string, slug: string, displayName: string, schema: number}>} the pointer.
 * @throws {PointerError} when the bytes are not a valid schema-1 pointer.
 */
export function parsePointerBytes(bytes, { path = POINTER_FILENAME } = {}) {
  if (bytes.length > MAX_POINTER_BYTES) {
    throw new PointerError('pointer-oversize', `${path} is larger than ${MAX_POINTER_BYTES} bytes`)
  }
  let text = bytes.toString('utf8')
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  let value
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new PointerError('pointer-corrupt', `${path} is not valid JSON: ${error.message}`, { cause: error })
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new PointerError('pointer-corrupt', `${path} must be a JSON object`)
  }
  if (value.schema !== POINTER_SCHEMA) {
    throw new PointerError(
      'pointer-unsupported-schema',
      `${path} uses schema ${JSON.stringify(value.schema)}; only schema ${POINTER_SCHEMA} is supported`,
    )
  }
  const expected = ['displayName', 'projectId', 'schema', 'slug']
  const actual = Object.keys(value).sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new PointerError(
      'pointer-corrupt',
      `${path} must contain exactly ${expected.join(', ')} (found ${actual.length ? actual.join(', ') : 'nothing'})`,
    )
  }
  if (!isUuidV4(value.projectId)) throw new PointerError('pointer-corrupt', `${path} has no UUIDv4 projectId`)
  if (typeof value.slug !== 'string' || !SLUG_PATTERN.test(value.slug)) {
    throw new PointerError('pointer-corrupt', `${path} has an invalid slug`)
  }
  if (
    typeof value.displayName !== 'string'
    || value.displayName.trim().length === 0
    || value.displayName.length > 200
    || /[\u0000-\u001f\u007f]/.test(value.displayName)
  ) {
    throw new PointerError('pointer-corrupt', `${path} has an invalid displayName`)
  }
  return Object.freeze({
    projectId: value.projectId,
    slug: value.slug,
    displayName: value.displayName,
    schema: POINTER_SCHEMA,
  })
}

/**
 * Read the pointer at a repository root, if there is one.
 *
 * Absence is `null`; every other failure (a symlink, a directory, a permission
 * error, a corrupt body) throws, so a caller can never mistake "unreadable" for
 * "absent" and create a second identity over a file it failed to read.
 *
 * @param {string} repoRoot - git root of the working tree.
 * @returns {Promise<{path: string, pointer: object, bytes: Buffer}|null>} the pointer, or null.
 * @throws {PointerError} when a pointer exists but cannot be trusted.
 */
export async function readPointer(repoRoot) {
  const path = join(repoRoot, POINTER_FILENAME)
  let stat
  try {
    stat = await fs.lstat(path)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw new PointerError('pointer-unreadable', `cannot read ${path}: ${error.code ?? error.message}`, { cause: error })
  }
  if (!stat.isFile()) {
    throw new PointerError('pointer-not-a-file', `${path} is not a regular file`)
  }
  let bytes
  try {
    bytes = await fs.readFile(path)
  } catch (error) {
    throw new PointerError('pointer-unreadable', `cannot read ${path}: ${error.code ?? error.message}`, { cause: error })
  }
  return { path, pointer: parsePointerBytes(bytes, { path }), bytes }
}

/**
 * Parse the plugin-managed region of a registry document.
 *
 * The table is a fixed four-column Markdown table (`projectId | hub | displayName
 * | remote`) inside `<!-- obsidian-mem:registry begin … -->` / `… end -->`. Rows
 * are validated for UUID identity, the R4 directory shape
 * `项目/<slug>--<projectId 前8位>`, and both one-to-one directions (an id maps to
 * exactly one directory, and a directory belongs to exactly one id). A missing
 * region is reported as `regionPresent:false` with no rows: this stage only
 * reads the registry, so it must not invent a refusal the writer task owns.
 *
 * @param {string} text - registry document contents.
 * @param {{ path?: string }} [options] - path used in diagnostics.
 * @returns {{ regionPresent: boolean, rows: object[] }} parsed rows.
 * @throws {RegistryError} when the region or a row cannot be trusted.
 */
export function parseRegistryMarkdown(text, { path = REGISTRY_RELATIVE_PATH } = {}) {
  const body = String(text)
  const begins = body.match(/<!--\s*obsidian-mem:registry begin/g)?.length ?? 0
  const ends = body.match(/<!--\s*obsidian-mem:registry end/g)?.length ?? 0
  if (begins !== ends) throw new RegistryError('registry-invalid', `${path} has an unterminated registry region`)
  if (begins > 1) throw new RegistryError('registry-invalid', `${path} has more than one registry region`)
  if (begins === 0) return { regionPresent: false, rows: [] }
  const match = /<!--\s*obsidian-mem:registry begin[^>]*-->([\s\S]*?)<!--\s*obsidian-mem:registry end\s*-->/.exec(body)
  if (!match) throw new RegistryError('registry-invalid', `${path} has a malformed registry region`)

  const rows = []
  const byId = new Map()
  const byDir = new Map()
  const lines = match[1].split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith('|'))
  for (let index = 0; index < lines.length; index += 1) {
    const cells = splitTableCells(lines[index])
    if (isSeparatorRow(cells)) continue
    if (cells.length === 4 && cells[0].toLowerCase() === 'projectid') continue
    if (cells.length !== 4) {
      throw new RegistryError('registry-invalid', `${path} row ${index + 1} must have exactly 4 columns`)
    }
    const [projectId, hubCell, displayName, remote] = cells
    if (!isUuidV4(projectId)) {
      throw new RegistryError('registry-invalid', `${path} row ${index + 1} has no UUIDv4 projectId`)
    }
    const dir = hubCellToDir(hubCell)
    if (!dir) throw new RegistryError('registry-invalid', `${path} row ${index + 1} has no hub path`)
    if (byId.has(projectId)) {
      throw new RegistryError('registry-duplicate-id', `${path} lists ${projectId} more than once`)
    }
    const owner = byDir.get(dir)
    if (owner !== undefined && owner !== projectId) {
      throw new RegistryError(
        'registry-duplicate-directory',
        `${path} maps both ${owner} and ${projectId} to ${dir}`,
      )
    }
    byId.set(projectId, dir)
    byDir.set(dir, projectId)
    rows.push({ projectId, dir, displayName, remote })
  }
  for (const row of rows) {
    const shape = PROJECT_DIR_PATTERN.exec(row.dir)
    if (!shape) {
      throw new RegistryError('registry-invalid', `${path} hub path is not ${PROJECTS_DIR}/<slug>--<id8>: ${row.dir}`)
    }
    if (shape[2] !== row.projectId.slice(0, 8)) {
      throw new RegistryError('registry-invalid', `${path} hub path ${row.dir} does not match ${row.projectId}`)
    }
  }
  return { regionPresent: true, rows }
}

/**
 * Read and validate the vault registry.
 *
 * A missing registry file is an empty registry (the vault may predate binding);
 * a read failure is not, and is reported as `registry-unreadable` so an unknown
 * cloud provider that fails a read pauses binding instead of being ignored.
 *
 * @param {string} vaultRoot - normalized vault root.
 * @returns {Promise<{path: string, regionPresent: boolean, rows: object[], byId: Map<string, object>, byDir: Map<string, string>}>} the registry.
 * @throws {RegistryError} when the registry exists but cannot be trusted.
 */
export async function readRegistry(vaultRoot) {
  const path = join(vaultRoot, REGISTRY_RELATIVE_PATH)
  let stat
  try {
    stat = await fs.lstat(path)
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { path, regionPresent: false, rows: [], byId: new Map(), byDir: new Map() }
    }
    throw new RegistryError('registry-unreadable', `cannot read ${path}: ${error.code ?? error.message}`, { cause: error })
  }
  if (!stat.isFile()) throw new RegistryError('registry-invalid', `${path} is not a regular file`)
  let bytes
  try {
    bytes = await fs.readFile(path)
  } catch (error) {
    throw new RegistryError('registry-unreadable', `cannot read ${path}: ${error.code ?? error.message}`, { cause: error })
  }
  const { regionPresent, rows } = parseRegistryMarkdown(bytes.toString('utf8'), { path })
  return {
    path,
    regionPresent,
    rows,
    byId: new Map(rows.map((row) => [row.projectId, row])),
    byDir: new Map(rows.map((row) => [row.dir, row.projectId])),
  }
}

/**
 * Walk upward from `cwd` to the git root.
 *
 * The root is the directory that contains a `.git` entry — a directory for a
 * normal clone, a file for a linked worktree. Discovery is a walk rather than a
 * `git` call so a plain checkout still binds when the git binary is missing;
 * `git` is only needed to enumerate *siblings*.
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
 * Resolve the vault project binding for a working directory.
 *
 * Resolution order (spec §5.2): normalize the vault root, refuse a cwd that is
 * inside the vault, refuse a cloud-managed vault root, find the git root, read
 * the pointer, validate or exclusively create it (inheriting a sibling
 * worktree's pointer when the current one has none), then check the vault
 * registry for id/directory conflicts and return the binding.
 *
 * Nothing here modifies an existing pointer, renames a project directory or
 * touches vault content. Refusals are returned as `{kind, reason, message}`
 * objects rather than thrown, so a caller can report them without a try/catch
 * and can never mistake them for a binding.
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
    if (!pointerCreated) {
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
 * Create a pointer with exclusive semantics, or report that one already existed.
 *
 * `open(…, 'wx')` is the only write this stage performs. A half-written pointer
 * from a crash is removed again rather than left behind, because the next
 * resolution would otherwise stop on a file that no user ever wrote.
 *
 * @param {string} path - pointer path at the repository root.
 * @param {object} pointer - the four-field pointer to write.
 * @returns {Promise<boolean>} true when this call created the file.
 */
async function createPointerExclusive(path, pointer) {
  const bytes = Buffer.from(`${JSON.stringify(pointer, null, 2)}\n`, 'utf8')
  let handle
  try {
    handle = await fs.open(path, 'wx', 0o644)
  } catch (error) {
    if (error.code === 'EEXIST') return false
    throw error
  }
  try {
    await handle.writeFile(bytes)
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
 * Derive a brand-new identity for a repository that has no pointer and no
 * sibling that could supply one.
 *
 * @param {string} repoRoot - git root used to suggest slug and display name.
 * @returns {{projectId: string, slug: string, displayName: string, schema: number}} a fresh pointer.
 */
function newPointer(repoRoot) {
  const name = basename(repoRoot)
  const displayName = name
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200) || slugify(name)
  return { projectId: randomUUID(), slug: slugify(name), displayName, schema: POINTER_SCHEMA }
}

/**
 * Find the pointer a sibling worktree already carries.
 *
 * Every sibling worktree of the same git common dir is inspected. All valid
 * pointers must agree on all four fields; one agreed pointer is inherited by
 * exclusive creation, and a repository with no known pointer gets a fresh
 * identity. An unreadable sibling (deleted checkout, permission failure, invalid
 * pointer) stops resolution instead of guessing.
 *
 * @param {string} repoRoot - git root of the current worktree.
 * @returns {Promise<{pointer: object|null}|{failure: object}>} the inherited pointer or a refusal.
 */
async function inheritSiblingPointer(repoRoot) {
  let commonDir
  let worktreeList
  try {
    commonDir = (await runGit(repoRoot, ['rev-parse', '--git-common-dir'])).trim()
    worktreeList = await runGit(repoRoot, ['worktree', 'list', '--porcelain'])
  } catch (error) {
    return {
      failure: refusal('git-unavailable', `cannot enumerate sibling worktrees: ${error.code ?? error.message}`, {
        detail: error.stderr?.trim() || undefined,
      }),
    }
  }
  if (!commonDir) {
    return { failure: refusal('git-unavailable', 'git reported no common directory for this repository') }
  }

  const candidates = new Set(parseWorktreeList(worktreeList))
  candidates.add(dirname(isAbsolute(commonDir) ? commonDir : resolve(repoRoot, commonDir)))

  const pointers = []
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
    if (found !== null) pointers.push(found.pointer)
  }

  if (unreadable.length > 0) {
    return {
      failure: refusal('sibling-unreadable', 'a sibling worktree could not be read, so no new project id is invented', {
        details: unreadable,
      }),
    }
  }
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
 * Whether two pointers carry identical identity metadata.
 *
 * @param {object} left - first pointer.
 * @param {object} right - second pointer.
 * @returns {boolean} true when all four fields match.
 */
function samePointer(left, right) {
  return left.projectId === right.projectId
    && left.slug === right.slug
    && left.displayName === right.displayName
    && left.schema === right.schema
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
function runGit(cwd, args) {
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

/**
 * Split a Markdown table row into cells, honouring `\|` escapes.
 *
 * @param {string} line - raw table row.
 * @returns {string[]} trimmed cell values.
 */
function splitTableCells(line) {
  let body = line.trim()
  if (body.startsWith('|')) body = body.slice(1)
  if (body.endsWith('|')) body = body.slice(0, -1)
  const cells = []
  let current = ''
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]
    if (char === '\\' && (body[index + 1] === '|' || body[index + 1] === '\\')) {
      current += body[index + 1]
      index += 1
      continue
    }
    if (char === '|') {
      cells.push(current.trim())
      current = ''
      continue
    }
    current += char
  }
  cells.push(current.trim())
  return cells
}

/**
 * Whether a row is the Markdown table separator.
 *
 * @param {string[]} cells - row cells.
 * @returns {boolean} true when every cell is a dash run.
 */
function isSeparatorRow(cells) {
  return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell))
}

/**
 * Extract the vault-relative directory from a registry hub cell.
 *
 * Accepts the vault-relative wikilink the writer emits (`[[项目/x--id8/index|alias]]`),
 * a bare wikilink, and a plain relative path, with or without a trailing
 * `/index(.md)`. Anything else is returned as-is and then rejected by the
 * directory-shape check.
 *
 * @param {string} cell - hub cell contents.
 * @returns {string} the vault-relative project directory.
 */
function hubCellToDir(cell) {
  let value = String(cell).trim()
  const wikilink = /^\[\[([^\]|]+)(?:\|[^\]]*)?\]\]$/.exec(value)
  if (wikilink) value = wikilink[1].trim()
  value = value.replace(/^\.\//, '')
  while (value.endsWith('/')) value = value.slice(0, -1)
  return value.replace(/\/index(?:\.md)?$/, '')
}
