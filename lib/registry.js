// The vault project registry (Task 4).
//
// `_meta/registry.md` maps a project id to its fixed vault directory. The
// mapping is one-to-one in both directions, and the directory shape is R4's
// `Projects/<slug>--<projectId 前8位>/`. The plugin-managed region is a fixed
// four-column Markdown table between `<!-- obsidian-mem:registry begin … -->`
// and `… end -->`; any `|` inside a cell is escaped as `\|` (spec §5.2), which
// is why the row splitter honours backslash escapes instead of a bare `split`.
//
// The registry path is resolved through `resolveVaultFile`, so the same
// segment-by-segment symlink rules own it: a symlinked `_meta` directory cannot
// redirect a registry read (or, in the tasks that follow, a registry write)
// outside the vault.
//
// This module also owns the *write* half of the generated region (Task 5):
// rendering the fixed four-column table, escaping a cell, and computing the
// `sha256:<内容哈希>` in the begin marker. Both halves live together so the row
// splitter that reads escaped cells and the escaper that writes them cannot
// drift apart. The hash covers exactly the bytes between the two markers, which
// is the only self-consistent definition — a hash that covered its own marker
// could not be verified.
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { basename, join } from 'node:path'

import { PathSafetyError, resolveVaultFile } from './paths.js'
import { isUuidV4, isValidSlug } from './pointer.js'

/** Vault directory holding one fixed directory per project (R4). */
export const PROJECTS_DIR = 'Projects'
/** Separator between the slug and the short project id in a project directory. */
export const PROJECT_DIR_SEPARATOR = '--'
/** Plugin-managed registry inside the vault. */
export const REGISTRY_RELATIVE_PATH = '_meta/registry.md'
/**
 * The fixed columns of the plugin-managed table (spec §5.2), in order:
 * `projectId | vault 相对 hub 路径 | displayName | 上次标准化 remote`.
 */
export const REGISTRY_COLUMNS = Object.freeze(['projectId', 'hub 相对路径', 'displayName', 'remote'])

/**
 * Matches the whole registry region: the begin-marker attributes, the line
 * terminator that ends that marker line (not part of the hashed body), and the
 * body up to the end marker.
 */
const REGISTRY_REGION_PATTERN = /<!--\s*obsidian-mem:registry begin([^>]*)-->(\r?\n)?([\s\S]*?)<!--\s*obsidian-mem:registry end\s*-->/
/** Control characters cannot survive a single-line table cell. */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/
/**
 * The document preamble for a brand-new registry. It deliberately does NOT spell
 * out the literal begin/end marker comments: `parseRegistryMarkdown` counts
 * those, so a documentation copy of them would read as a second region.
 */
const REGISTRY_PREAMBLE = [
  '# 项目注册表',
  '',
  '已绑定项目的 hub 索引（MOC）。由 dsh-obsidian-mem 生成的区块带有 `obsidian-mem:registry` 标记，',
  '区块内容哈希写在起始标记里；手工修改该区块会使哈希失配，插件将停止写入并报告冲突。',
  '',
  '',
].join('\n')

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
 * The fixed vault-relative directory for a project: `Projects/<slug>--<id8>`.
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
 * `Projects/<slug>--<projectId 前8位>`, and both one-to-one directions (an id maps to
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
    const shape = parseProjectRelativeDir(row.dir)
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
 * Escape one Markdown table cell.
 *
 * A `|` inside a cell would split the row into five columns and make the whole
 * registry unparseable, so it is written as `\|` — and a literal backslash is
 * doubled first, so the parser's escape handling round-trips exactly
 * (`a\|b` → `a\\\|b` → `a\|b`). Control characters cannot be escaped in a
 * single-line table row, so they are refused instead of silently mangled; the
 * pointer contract already forbids them in a display name.
 *
 * @param {unknown} value - cell value.
 * @returns {string} the escaped cell.
 * @throws {RangeError} when the value contains a control character.
 */
export function escapeRegistryCell(value) {
  const text = String(value ?? '')
  if (CONTROL_CHARACTERS.test(text)) {
    throw new RangeError('a registry cell must not contain control characters')
  }
  return text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|')
}

/**
 * The hub cell for a project: a vault-root-relative wikilink to its `index.md`.
 *
 * The alias is the directory basename, matching the shape Task 4's fixtures use
 * and `hubCellToDir` reads back.
 *
 * @param {string} dir - vault-relative project directory.
 * @returns {string} the unescaped cell contents.
 */
export function registryHubCell(dir) {
  return `[[${dir}/index|${basename(dir)}]]`
}

/**
 * Render one registry table row (raw separators, escaped cells).
 *
 * @param {{projectId: string, dir: string, displayName?: string, remote?: string}} row - row to render.
 * @returns {string} a Markdown table row.
 */
export function registryRowText(row) {
  const cells = [
    escapeRegistryCell(row.projectId),
    escapeRegistryCell(registryHubCell(row.dir)),
    escapeRegistryCell(row.displayName),
    escapeRegistryCell(row.remote ?? ''),
  ]
  return `| ${cells.join(' | ')} |`
}

/**
 * Render the plugin-managed region, markers included.
 *
 * The body is the fixed four-column table ending in a newline; the hash in the
 * begin marker is the sha256 of exactly those bytes.
 *
 * @param {object[]} rows - rows to render, in order.
 * @returns {string} the region text, ending with the end marker and a newline.
 */
export function renderRegistryRegion(rows) {
  const body = [
    `| ${REGISTRY_COLUMNS.join(' | ')} |`,
    `| ${REGISTRY_COLUMNS.map(() => '---').join(' | ')} |`,
    ...rows.map(registryRowText),
  ].join('\n') + '\n'
  return `<!-- obsidian-mem:registry begin sha256:${sha256Hex(body)} -->\n${body}<!-- obsidian-mem:registry end -->\n`
}

/**
 * Locate the generated region in a registry document.
 *
 * `body` is the text between the two marker lines, without the line terminator
 * that ends the begin-marker line — the exact bytes the declared hash covers.
 *
 * @param {string} text - registry document contents.
 * @returns {{regionText: string, body: string, declaredHash: string|null, matches: boolean, start: number, end: number}|null}
 *   the region, or `null` when the document has none.
 */
export function inspectRegistryRegion(text) {
  const match = REGISTRY_REGION_PATTERN.exec(String(text))
  if (match === null) return null
  const body = match[3]
  const declared = /sha256:([0-9a-f]{64})/.exec(match[1])
  const declaredHash = declared === null ? null : declared[1]
  return {
    regionText: match[0],
    body,
    declaredHash,
    matches: declaredHash !== null && declaredHash === sha256Hex(body),
    start: match.index,
    end: match.index + match[0].length,
  }
}

/**
 * Render a complete registry document containing just the given rows.
 *
 * @param {object[]} rows - rows to render.
 * @returns {string} the new document (preamble + generated region).
 */
export function renderRegistryDocument(rows) {
  return `${REGISTRY_PREAMBLE}${renderRegistryRegion(rows)}`
}

/**
 * The lowercase hex sha256 of a UTF-8 string.
 *
 * @param {string} value - text to hash.
 * @returns {string} 64 hex characters.
 */
export function sha256Hex(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex')
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
 * Accepts the vault-relative wikilink the writer emits (`[[Projects/x--id8/index|alias]]`),
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
 * `Projects/<valid slug>--<8 lowercase hex>` returns `null`. The bootstrap writer
 * uses this same function so it can never mint a directory the parser would
 * reject.
 *
 * @param {string} dir - vault-relative directory.
 * @returns {{slug: string, id8: string}|null} the parsed halves, or null when the shape is wrong.
 */
export function parseProjectRelativeDir(dir) {
  if (typeof dir !== 'string' || !dir.startsWith(`${PROJECTS_DIR}/`)) return null
  const rest = dir.slice(PROJECTS_DIR.length + 1)
  const match = /^(.*)--([0-9a-f]{8})$/.exec(rest)
  if (match === null || !isValidSlug(match[1])) return null
  return { slug: match[1], id8: match[2] }
}
