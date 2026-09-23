// The vault project registry (Task 4).
//
// `_meta/项目注册表.md` maps a project id to its fixed vault directory. The
// mapping is one-to-one in both directions, and the directory shape is R4's
// `项目/<slug>--<projectId 前8位>/`. The plugin-managed region is a fixed
// four-column Markdown table between `<!-- obsidian-mem:registry begin … -->`
// and `… end -->`; any `|` inside a cell is escaped as `\|` (spec §5.2), which
// is why the row splitter honours backslash escapes instead of a bare `split`.
//
// The registry path is resolved through `resolveVaultFile`, so the same
// segment-by-segment symlink rules own it: a symlinked `_meta` directory cannot
// redirect a registry read (or, in the tasks that follow, a registry write)
// outside the vault.
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { PathSafetyError, resolveVaultFile } from './paths.js'
import { isUuidV4, isValidSlug } from './pointer.js'

/** Vault directory holding one fixed directory per project (R4). */
export const PROJECTS_DIR = '项目'
/** Separator between the slug and the short project id in a project directory. */
export const PROJECT_DIR_SEPARATOR = '--'
/** Plugin-managed registry inside the vault. */
export const REGISTRY_RELATIVE_PATH = '_meta/项目注册表.md'

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

/**
 * The fixed vault-relative directory for a project: `项目/<slug>--<id8>`.
 *
 * @param {string} slug - validated slug.
 * @param {string} projectId - UUIDv4 project id.
 * @returns {string} vault-relative project directory.
 * @throws {RangeError} when the slug or project id cannot be rendered safely.
 */
export function projectRelativeDir(slug, projectId) {
  if (!isValidSlug(slug)) throw new RangeError('slug')
  if (!isUuidV4(projectId)) throw new RangeError('projectId')
  return `${PROJECTS_DIR}/${slug}${PROJECT_DIR_SEPARATOR}${projectId.slice(0, 8)}`
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
    const shape = parseProjectDir(row.dir)
    if (shape === null) {
      throw new RegistryError('registry-invalid', `${path} hub path is not ${PROJECTS_DIR}/<slug>--<id8>: ${row.dir}`)
    }
    if (shape.id8 !== row.projectId.slice(0, 8)) {
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
 * cloud provider that fails a read pauses binding instead of being ignored. A
 * symlink anywhere in the registry path is `registry-symlink`: the registry is
 * plugin-managed, so a redirected path is a refusal rather than a convenience.
 *
 * @param {string} vaultRoot - normalized vault root.
 * @returns {Promise<{path: string, regionPresent: boolean, rows: object[], byId: Map<string, object>, byDir: Map<string, string>}>} the registry.
 * @throws {RegistryError} when the registry exists but cannot be trusted.
 */
export async function readRegistry(vaultRoot) {
  const configuredPath = join(vaultRoot, REGISTRY_RELATIVE_PATH)
  let path
  try {
    path = await resolveVaultFile(vaultRoot, REGISTRY_RELATIVE_PATH)
  } catch (error) {
    if (error instanceof PathSafetyError) {
      throw new RegistryError('registry-symlink', error.message, { cause: error })
    }
    if (typeof error?.code === 'string') {
      throw new RegistryError('registry-unreadable', `cannot read ${configuredPath}: ${error.code}`, { cause: error })
    }
    throw error
  }
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

/**
 * Parse a project directory name into its slug and short id (R4).
 *
 * The last `--` separates the two halves, so a slug that itself contains `--`
 * still resolves correctly. Anything that is not exactly
 * `项目/<valid slug>--<8 lowercase hex>` returns `null`.
 *
 * @param {string} dir - vault-relative directory.
 * @returns {{slug: string, id8: string}|null} the parsed halves, or null when the shape is wrong.
 */
function parseProjectDir(dir) {
  if (typeof dir !== 'string' || !dir.startsWith(`${PROJECTS_DIR}/`)) return null
  const rest = dir.slice(PROJECTS_DIR.length + 1)
  const match = /^(.*)--([0-9a-f]{8})$/.exec(rest)
  if (match === null || !isValidSlug(match[1])) return null
  return { slug: match[1], id8: match[2] }
}
