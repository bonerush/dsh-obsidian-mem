// Idempotent, hash-tracked sync of the packaged skill (Task 13).
//
// The plugin ships a portable skill (`skills/obsidian-mem/SKILL.md`) that has to
// exist on disk at `$DSH_HOME/skills/obsidian-mem/` for the harness to discover
// it. Copying it on every start would be wrong in two directions: it would
// rewrite an unchanged file (a new mtime, a watcher storm) and it would happily
// overwrite a file the user edited by hand. So the mechanism — mirrored from the
// proven asset sync in the installed `dsh-ultramath` bundle — is:
//
//   * the target directory carries `.obsidian-mem-manifest.json`, in which this
//     plugin records the sha256 of every asset **it** wrote;
//   * an asset whose source hash equals its target hash is a no-op;
//   * an asset whose target hash still equals the recorded hash is this plugin's
//     previous version and is replaced (temporary file, `fsync`, same-directory
//     `rename`, directory `fsync` — the same primitive `lib/transaction.js`
//     uses, so a crash leaves either the old bytes or the new bytes);
//   * an asset whose target bytes match **neither** the source nor the record
//     was changed outside this plugin. It is refused and reported as a conflict;
//     the manifest keeps its old record so the conflict is reported again
//     instead of being silently adopted;
//   * a source asset that is missing or invalid is an explicit error *before*
//     anything is written, never a silent skip.
//
// Two deliberate differences from the reference implementation: this plugin
// never deletes or prunes anything inside the target (deletion is not
// recoverable and the user may have added files), and a sync failure is
// reported through the logger instead of thrown out of `apply` — an unwritable
// `~/.dsh/skills` must not keep the six tools or the pre-step injection from
// mounting and leave the fiber PENDING.
//
// Path safety follows `lib/paths.js`: the target directory itself and every
// entry below it are `lstat`-ed and a symlink is refused, while symlinked
// *ancestors* (macOS `/var`, a symlinked home) are tolerated exactly as
// `resolveVaultRoot` tolerates them by resolving the existing chain.
import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parse as parseYaml } from 'yaml'

import { PathSafetyError, splitRelativeVaultPath } from './paths.js'

/** The skill id, which is also its directory name under the DSH skill root. */
export const SKILL_NAME = 'obsidian-mem'

/** The Agent Skills document DSH discovery requires, relative to the source dir. */
export const SKILL_DOCUMENT = 'SKILL.md'

/** The records file this plugin owns inside the target directory. */
export const MANIFEST_FILENAME = '.obsidian-mem-manifest.json'

/** Manifest schema version written by this module. */
export const MANIFEST_VERSION = 1

/** Upper bound on one packaged asset, so a stray huge file cannot be slurped. */
const MAX_ASSET_BYTES = 8 * 1024 * 1024

/** Raised when the packaged skill cannot be synced for a reason worth reporting. */
export class AssetSyncError extends Error {
  /**
   * @param {string} message - names the offending asset or path.
   */
  constructor(message) {
    super(message)
    this.name = 'AssetSyncError'
    this.code = 'asset-sync'
  }
}

/**
 * The target directory for the packaged skill: `<DSH_HOME>/skills/obsidian-mem`.
 *
 * `DSH_HOME` is honoured for the same reason `resolveDataRoot` honours it — an
 * isolated profile must never write into the user's real `~/.dsh` — and a blank
 * or relative value is refused rather than resolved against the process cwd.
 *
 * @param {{ dshHome?: string }} [options] - absolute DSH home override.
 * @returns {string} absolute path to the skill directory (not created here).
 * @throws {RangeError} when the home is not an absolute, non-blank path.
 */
export function resolveSkillTargetDir({
  dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh'),
} = {}) {
  if (typeof dshHome !== 'string' || !dshHome.trim() || !isAbsolute(dshHome)) {
    throw new RangeError('dshHome must be an absolute, non-blank path')
  }
  return join(resolve(dshHome), 'skills', SKILL_NAME)
}

/**
 * The packaged skill source directory inside this plugin.
 *
 * @returns {string} absolute path to `<package>/skills/obsidian-mem/`.
 */
export function bundledSkillSourceDir() {
  return fileURLToPath(new URL('../skills/obsidian-mem/', import.meta.url))
}

/**
 * Sync the packaged skill into the target directory, idempotently.
 *
 * @param {{ sourceDir: string, targetDir: string }} options - source directory
 *   (holding `SKILL.md`) and the target directory to create/update.
 * @returns {Promise<{changed: boolean, files: Array<{path: string, status: string}>, conflicts: Array<{path: string, reason: string}>, warnings: string[]}>}
 *   `changed` is true when at least one asset byte was written; `files` reports
 *   one entry per packaged asset with status `created` | `updated` |
 *   `unchanged` | `conflict`.
 * @throws {AssetSyncError} when a packaged asset is missing, unreadable or not a
 *   valid skill document, so a broken package never half-syncs.
 * @throws {PathSafetyError} when the target or one of its entries is a symlink.
 */
export async function syncSkill({ sourceDir, targetDir } = {}) {
  const assets = await readSourceAssets(sourceDir)
  const target = await inspectTargetDir(targetDir)
  await preflightTargetEntries(target, assets)

  const { manifest, warning } = await readManifest(target)
  const warnings = warning === null ? [] : [warning]
  // Start from the recorded set so an asset that is no longer packaged keeps its
  // record: it is never deleted, and if it returns it is still recognised as
  // this plugin's file.
  const recorded = { ...manifest.assets }
  const files = []
  const conflicts = []
  let changed = false

  for (const asset of assets) {
    const absolute = join(target, ...asset.path.split('/'))
    const current = await lstatOrNull(absolute)
    const currentHash = current === null ? null : await hashFile(absolute)
    if (currentHash === asset.hash) {
      files.push({ path: asset.path, status: 'unchanged' })
      continue
    }
    const previous = manifest.assets[asset.path]
    if (currentHash !== null && currentHash !== previous) {
      // Neither the packaged bytes nor this plugin's own last write: someone
      // else owns these bytes. Refuse, and do not claim them: `recorded` keeps
      // whatever it had (usually nothing), so the conflict repeats.
      conflicts.push({
        path: asset.path,
        reason:
          previous === undefined
            ? 'the target file has no record of being written by this plugin, so it was left untouched'
            : 'the target file was changed outside the plugin since its last recorded write, so it was left untouched',
      })
      files.push({ path: asset.path, status: 'conflict' })
      continue
    }
    await writeFileAtomic(absolute, asset.bytes)
    recorded[asset.path] = asset.hash
    changed = true
    files.push({ path: asset.path, status: currentHash === null ? 'created' : 'updated' })
  }

  if (changed) {
    await writeFileAtomic(
      join(target, MANIFEST_FILENAME),
      Buffer.from(
        `${JSON.stringify(
          {
            plugin: 'dsh-obsidian-mem',
            skill: SKILL_NAME,
            version: MANIFEST_VERSION,
            assets: sortAssets(recorded),
          },
          null,
          2,
        )}\n`,
      ),
    )
  }

  return { changed, files, conflicts, warnings }
}

/**
 * Sync the packaged skill and report the outcome through `ctx.logger`.
 *
 * This is the only entry point `apply` calls, and it **never rejects**: an
 * unwritable, symlinked or otherwise hostile `$DSH_HOME/skills` has to be a log
 * line, not a rejection that keeps the plugin's fiber PENDING and takes the six
 * tools down with it.
 *
 * @param {{ ctx?: object, sourceDir?: string, targetDir?: string }} [options] -
 *   the plugin context, and optional source/target overrides (tests, tools).
 * @returns {Promise<{ok: boolean, changed: boolean, files: Array<object>, conflicts: Array<object>, warnings: string[], error?: string}>}
 *   the sync result plus `ok`, or `ok:false` with `error` when the sync failed.
 */
export async function syncBundledSkill({ ctx, sourceDir, targetDir } = {}) {
  const warn = (message) => {
    try {
      ctx?.logger?.warn?.(message)
    } catch {
      // A logger that throws must not become the plugin's failure mode.
    }
  }
  let target
  try {
    // Resolved *inside* the try on purpose: a relative `DSH_HOME` makes
    // `resolveSkillTargetDir` throw, and that must be a log line like any other
    // sync failure — never a rejection `apply` cannot handle.
    const source = sourceDir ?? bundledSkillSourceDir()
    target = targetDir ?? resolveSkillTargetDir()
    const result = await syncSkill({ sourceDir: source, targetDir: target })
    for (const message of result.warnings) warn(`obsidian-mem: skill sync: ${message}`)
    for (const conflict of result.conflicts) {
      warn(`obsidian-mem: skill sync conflict: ${conflict.path} — ${conflict.reason}`)
    }
    if (result.changed) {
      try {
        ctx?.logger?.info?.(`obsidian-mem: skill synced into ${target}`)
      } catch {
        // See above: logging is best-effort.
      }
    }
    return { ok: true, ...result }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    warn(`obsidian-mem: skill sync failed: ${message}`)
    return { ok: false, changed: false, files: [], conflicts: [], warnings: [], error: message }
  }
}

// ---------------------------------------------------------------------------
// Source side
// ---------------------------------------------------------------------------

/**
 * Collect and validate every packaged asset.
 *
 * Validation happens before any target write, so a package missing `SKILL.md`
 * (or shipping one DSH cannot discover) fails whole instead of half-syncing.
 *
 * @param {string} sourceDir - the packaged skill directory.
 * @returns {Promise<Array<{path: string, bytes: Buffer, hash: string}>>} assets, sorted by relative path.
 * @throws {AssetSyncError} when the directory, `SKILL.md` or an entry is unusable.
 */
async function readSourceAssets(sourceDir) {
  if (typeof sourceDir !== 'string' || !sourceDir.trim() || !isAbsolute(sourceDir)) {
    throw new RangeError('sourceDir must be an absolute, non-blank path')
  }
  const root = resolve(sourceDir)
  const rootStat = await lstatOrNull(root)
  if (rootStat === null)
    throw new AssetSyncError(`the packaged skill directory does not exist: ${root}`)
  if (!rootStat.isDirectory())
    throw new AssetSyncError(`the packaged skill source is not a directory: ${root}`)

  const assets = []
  await collectAssets(root, '', assets)
  const document = assets.find((asset) => asset.path === SKILL_DOCUMENT)
  if (document === undefined) {
    throw new AssetSyncError(`${SKILL_DOCUMENT} is missing from the packaged skill: ${root}`)
  }
  validateSkillDocument(document.bytes, document.path)
  assets.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  return assets
}

/**
 * Recursively collect regular files, refusing anything else.
 *
 * @param {string} root - the source directory.
 * @param {string} prefix - POSIX relative path of the directory being walked.
 * @param {Array<{path: string, bytes: Buffer, hash: string}>} into - accumulator.
 * @returns {Promise<void>} resolves once the tree is walked.
 * @throws {AssetSyncError} on a symlink, a non-regular entry or an oversized file.
 */
async function collectAssets(root, prefix, into) {
  const directory = join(root, ...prefix.split('/').filter(Boolean))
  const entries = await fs.readdir(directory)
  for (const entry of entries) {
    const absolute = join(directory, entry)
    const relative = prefix === '' ? entry : `${prefix}/${entry}`
    const stat = await fs.lstat(absolute)
    if (stat.isSymbolicLink()) {
      throw new AssetSyncError(
        `the packaged skill contains a symlink, which is never shipped: ${relative}`,
      )
    }
    if (stat.isDirectory()) {
      await collectAssets(root, relative, into)
      continue
    }
    if (!stat.isFile()) {
      throw new AssetSyncError(`the packaged skill contains a non-regular file: ${relative}`)
    }
    if (stat.size > MAX_ASSET_BYTES) {
      throw new AssetSyncError(
        `the packaged asset is larger than ${MAX_ASSET_BYTES} bytes: ${relative}`,
      )
    }
    const bytes = await fs.readFile(absolute)
    into.push({ path: relative, bytes, hash: sha256(bytes) })
  }
}

/**
 * Validate the Agent Skills frontmatter DSH discovery depends on.
 *
 * @param {Buffer} bytes - the packaged `SKILL.md`.
 * @param {string} label - path to name in the message.
 * @returns {void}
 * @throws {AssetSyncError} when the document is not a valid skill.
 */
function validateSkillDocument(bytes, label) {
  const text = bytes.toString('utf8')
  if (!/^---\r?\n/.test(text)) {
    throw new AssetSyncError(`${label} must begin with YAML frontmatter (---)`)
  }
  const bodyStart = text.indexOf('\n') + 1
  const closing = text.indexOf('\n---', bodyStart)
  if (closing === -1) throw new AssetSyncError(`${label} frontmatter is not closed with ---`)
  let data
  try {
    data = parseYaml(text.slice(bodyStart, closing))
  } catch (error) {
    throw new AssetSyncError(
      `${label} frontmatter is not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new AssetSyncError(`${label} frontmatter must be a mapping`)
  }
  if (data.name !== SKILL_NAME) {
    throw new AssetSyncError(
      `${label} frontmatter name must be "${SKILL_NAME}", found ${JSON.stringify(data.name)}`,
    )
  }
  if (typeof data.description !== 'string' || !data.description.trim()) {
    throw new AssetSyncError(`${label} frontmatter needs a non-blank description`)
  }
}

// ---------------------------------------------------------------------------
// Target side
// ---------------------------------------------------------------------------

/**
 * Normalize the target directory and refuse a symlinked or non-directory target.
 *
 * @param {string} targetDir - caller-supplied target.
 * @returns {Promise<string>} the resolved absolute target path.
 * @throws {PathSafetyError} when the target exists as a symlink or a plain file.
 */
async function inspectTargetDir(targetDir) {
  if (typeof targetDir !== 'string' || !targetDir.trim() || !isAbsolute(targetDir)) {
    throw new RangeError('targetDir must be an absolute, non-blank path')
  }
  const target = resolve(targetDir)
  const stat = await lstatOrNull(target)
  if (stat?.isSymbolicLink()) {
    throw new PathSafetyError(`symlink is not allowed as a skill target: ${target}`)
  }
  if (stat !== null && !stat.isDirectory()) {
    throw new PathSafetyError(`the skill target is not a directory: ${target}`)
  }
  return target
}

/**
 * Refuse a symlink (or a non-file collision) anywhere the sync is about to write.
 *
 * This runs over every asset and the manifest **before** the first write, so a
 * refusal never leaves a partially synced tree. Directory segments are checked
 * from the target down; the target itself was checked by `inspectTargetDir`.
 *
 * @param {string} target - resolved target directory.
 * @param {Array<{path: string}>} assets - the packaged assets.
 * @returns {Promise<void>} resolves when every destination is safe to write.
 * @throws {PathSafetyError} on a symlink, `AssetSyncError` on a non-file collision.
 */
async function preflightTargetEntries(target, assets) {
  const relatives = [...assets.map((asset) => asset.path), MANIFEST_FILENAME]
  for (const relative of relatives) {
    const segments = assetSegments(relative)
    let current = target
    for (const segment of segments.slice(0, -1)) {
      current = join(current, segment)
      const stat = await lstatOrNull(current)
      if (stat === null) break
      if (stat.isSymbolicLink()) {
        throw new PathSafetyError(`symlink is not allowed in the skill target: ${relative}`)
      }
      if (!stat.isDirectory()) {
        throw new AssetSyncError(`${relative} cannot be written: ${segment} is not a directory`)
      }
    }
    const destination = join(target, ...segments)
    const stat = await lstatOrNull(destination)
    if (stat?.isSymbolicLink()) {
      throw new PathSafetyError(`symlink is not allowed in the skill target: ${relative}`)
    }
    if (stat !== null && !stat.isFile()) {
      throw new AssetSyncError(`${relative} exists in the skill target as a non-file entry`)
    }
  }
}

/**
 * Read this plugin's records file.
 *
 * A missing file is an empty record; an unreadable or malformed one is ignored
 * (reported as a warning) rather than trusted. Ignoring it is the safe failure:
 * every existing target file then counts as foreign, so nothing is overwritten
 * and the conflict is reported.
 *
 * @param {string} target - resolved target directory.
 * @returns {Promise<{manifest: {assets: Record<string, string>}, warning: string|null}>} the records.
 */
async function readManifest(target) {
  const path = join(target, MANIFEST_FILENAME)
  let raw
  try {
    raw = await fs.readFile(path, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return { manifest: { assets: {} }, warning: null }
    throw error
  }
  try {
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('not a mapping')
    const source = parsed.assets
    if (source === null || typeof source !== 'object' || Array.isArray(source))
      throw new Error('assets is not a mapping')
    const assets = {}
    for (const [key, value] of Object.entries(source)) {
      if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value))
        throw new Error(`bad hash for ${key}`)
      assets[assetSegments(key).join('/')] = value
    }
    if (parsed.skill !== undefined && parsed.skill !== SKILL_NAME)
      throw new Error('written by another skill')
    return { manifest: { assets }, warning: null }
  } catch (error) {
    return {
      manifest: { assets: {} },
      warning: `the skill manifest was ignored (${error instanceof Error ? error.message : String(error)}), so no target file can be proven to be plugin-owned`,
    }
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * Split a POSIX relative asset path, refusing anything that escapes the target.
 *
 * @param {string} relative - e.g. `notes/extra.md`.
 * @returns {string[]} the checked segments.
 * @throws {PathSafetyError} when the path is absolute or contains `..`.
 */
function assetSegments(relative) {
  return splitRelativeVaultPath(relative)
}

/** Lowercase hex sha256 of a byte sequence. */
function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Lowercase hex sha256 of a file's current bytes. */
async function hashFile(path) {
  return sha256(await fs.readFile(path))
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

/** A stable key order, so an unchanged record set produces identical bytes. */
function sortAssets(assets) {
  return Object.fromEntries(
    Object.entries(assets).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  )
}

/**
 * Replace a file through a same-directory temporary file, `fsync` and `rename`.
 *
 * The primitive is the one `lib/transaction.js` uses: the temporary file lives
 * beside its target so the rename stays on one filesystem and atomic, and the
 * directory is `fsync`-ed so the rename itself is durable.
 *
 * @param {string} path - destination.
 * @param {Buffer} bytes - replacement contents.
 * @returns {Promise<void>} resolves once the bytes are durable.
 */
async function writeFileAtomic(path, bytes) {
  const directory = dirname(path)
  await fs.mkdir(directory, { recursive: true })
  const temporary = join(directory, `.${basename(path)}.${randomUUID()}.tmp`)
  const handle = await fs.open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } catch (error) {
    await handle.close().catch(() => {})
    await fs.rm(temporary, { force: true }).catch(() => {})
    throw error
  }
  await handle.close()
  try {
    await fs.rename(temporary, path)
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {})
    throw error
  }
  await fsyncDirectory(directory)
}

/**
 * `fsync` a directory, tolerating platforms where a directory cannot be opened.
 *
 * @param {string} directory - directory to sync.
 * @returns {Promise<void>} resolves once the sync was attempted.
 */
async function fsyncDirectory(directory) {
  let handle
  try {
    handle = await fs.open(directory, 'r')
  } catch {
    return
  }
  try {
    await handle.sync()
  } catch {
    // Not every platform supports fsync on a directory; the rename is still atomic.
  } finally {
    await handle.close().catch(() => {})
  }
}
