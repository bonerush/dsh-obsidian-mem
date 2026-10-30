import { resolveVaultFile } from './paths.js'
import { createLinkResolver } from './graph-links.js'

/** Read graph-only administrative metadata without putting it in the recall index. */
export async function readGraphAdminNotes(state, parseRecord) {
  let entries
  try {
    const directory = await resolveVaultFile(state.vaultRoot, '_meta')
    entries = await state.io.readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  const records = []
  for (const entry of entries) {
    if (
      !entry.isFile() ||
      entry.name.startsWith('.') ||
      !entry.name.endsWith('.md') ||
      entry.name === 'user.md'
    )
      continue
    const path = '_meta/' + entry.name
    try {
      const absolute = await resolveVaultFile(state.vaultRoot, path)
      const stat = await state.io.stat(absolute)
      if (stat.size > state.maxFileBytes) continue
      const bytes = await state.io.readFile(absolute)
      if (bytes.length > state.maxFileBytes) continue
      records.push(parseRecord(path, bytes, { hash: '', mtime: 0, size: bytes.length }))
    } catch (error) {
      if (error.code === 'ENOENT') continue
      throw error
    }
  }
  return records
}

/**
 * Project the file/link topology; graph visibility is independent of recall status.
 *
 * `limit: null` (the shipped panel's request) returns the whole projection in
 * scope, sorted by degree and then path so the most connected notes lay out first
 * — the force worker seeds new points beside their neighbours, so a stable order
 * is what keeps a large graph from re-arranging itself on every refresh. A numeric
 * `limit` still answers a bounded page and reports `truncated`.
 *
 * @param {object[]} rows - every indexed note, from both backends.
 * @param {object[]} rawLinks - `{src_id, target}` rows before resolution.
 * @param {{scope: 'project'|'all', projectId: string|null, limit: number|null}} options - scope, identity and cap.
 * @returns {{nodes: object[], edges: object[], truncated: boolean, total: number}} the projection.
 */
export function projectGraph(rows, rawLinks, { scope, projectId, limit }) {
  const eligible = rows.filter(
    (row) =>
      scope === 'all' ||
      row.project === projectId ||
      (row.project == null && row.project_id8 === projectId.slice(0, 8)),
  )
  const byId = new Map(eligible.map((row) => [row.id ?? row.path, row]))
  const resolve = createLinkResolver(rows)
  const ghosts = new Map()
  const allEdges = []
  const seen = new Set()
  const degree = new Map()
  for (const link of rawLinks) {
    const source = byId.get(link.src_id)
    if (!source) continue
    let target = resolve(source, link.target)
    if (target && !byId.has(target.id ?? target.path)) continue
    if (!target) {
      const path = link.target.replace(/\.md$/i, '')
      target = ghosts.get(path)
      if (!target) {
        target = { id: 'unresolved:' + path, path, title: path, type: 'unresolved', tags: [] }
        ghosts.set(path, target)
      }
    }
    const sourceId = source.id ?? source.path,
      targetId = target.id ?? target.path
    const key = sourceId + '\0' + targetId
    if (sourceId === targetId || seen.has(key)) continue
    seen.add(key)
    allEdges.push({ source: sourceId, target: targetId })
    degree.set(sourceId, (degree.get(sourceId) ?? 0) + 1)
    degree.set(targetId, (degree.get(targetId) ?? 0) + 1)
  }
  const candidates = [...eligible, ...ghosts.values()]
  const ranked = candidates.sort(
    (a, b) =>
      (degree.get(b.id ?? b.path) ?? 0) - (degree.get(a.id ?? a.path) ?? 0) ||
      a.path.localeCompare(b.path),
  )
  const selected = limit === null || limit === undefined ? ranked : ranked.slice(0, limit)
  const nodes = selected.map((row) => ({
    id: row.id ?? row.path,
    path: row.path,
    title: row.title ?? row.path.split('/').pop().replace(/\.md$/i, ''),
    type: row.type ?? 'untyped',
    tags: row.tags ?? [],
  }))
  const selectedIds = new Set(nodes.map((node) => node.id))
  const edges = allEdges.filter(
    (edge) => selectedIds.has(edge.source) && selectedIds.has(edge.target),
  )
  return {
    nodes,
    edges,
    truncated: limit !== null && limit !== undefined && candidates.length > limit,
    total: candidates.length,
  }
}
