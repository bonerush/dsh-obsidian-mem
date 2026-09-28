import { posix } from 'node:path'

const wiki = /\[\[([^\]|]*?)(?:\\?\|[^]*?)?\]\]/g
const markdown =
  /!?\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|((?:\\.|[^\s()\\]|\([^()]*\))+))(?:\s+["'][^\n]*?["'])?\s*\)/g

function proseOnly(body) {
  let fence = null
  const lines = []
  for (const line of body.split('\n')) {
    const mark = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (fence) {
      if (mark?.[0] === fence[0] && mark.length >= fence.length) fence = null
    } else if (mark) fence = mark
    else lines.push(line)
  }
  return lines.join('\n').replace(/<!--[^]*?-->|%%[^]*?%%/g, '')
}

/** Extract internal body links, embeds and wikilinks in YAML string values. */
export function extractNoteLinks(body, frontmatter = {}) {
  const targets = new Set()
  const add = (raw, decode = false) => {
    let target = raw.trim().replace(/\\([\s()[\]#])/g, '$1')
    if (decode) {
      try {
        target = decodeURIComponent(target)
      } catch {
        /* A literal percent can be a filename. */
      }
    }
    target = target.split('#')[0]
    if (target && !/^[a-z][a-z\d+.-]*:/i.test(target)) targets.add(target)
  }
  const text = proseOnly(String(body))
  const wikiText = text.replace(/(\[\[[^]*?\]\])|(`+)[^]*?\2/g, (_, link) => link ?? '')
  for (const match of wikiText.matchAll(wiki)) add(match[1])
  // Obsidian's metadata cache also records Markdown destinations inside inline code.
  for (const match of text.matchAll(markdown)) add(match[1] ?? match[2], true)
  const definitions = new Map()
  const reference = /^ {0,3}\[([^\]\n]+)\]:\s*(?:<([^>\n]+)>|(\S+))/gm
  for (const match of text.matchAll(reference))
    definitions.set(match[1].toLowerCase(), match[2] ?? match[3])
  const withoutDefinitions = text.replace(reference, '')
  for (const match of withoutDefinitions.matchAll(/!?\[([^\]\n]+)\](?:\[([^\]\n]*)\])?/g)) {
    const target = definitions.get((match[2] || match[1]).toLowerCase())
    if (target) add(target, true)
  }
  const visit = (value) => {
    if (typeof value === 'string') for (const match of value.matchAll(wiki)) add(match[1])
    else if (value && typeof value === 'object')
      for (const child of Object.values(value)) visit(child)
  }
  visit(frontmatter)
  return [...targets]
}

/** Resolve filenames with Obsidian's case, relative path and nearest-folder rules. */
export function createLinkResolver(rows) {
  const byPath = new Map(rows.map((row) => [row.path.toLowerCase(), row]))
  const byId = new Map(rows.filter((row) => row.id).map((row) => [row.id, row]))
  const byName = new Map()
  for (const row of rows) {
    const name = posix.basename(row.path).toLowerCase()
    const matches = byName.get(name) ?? []
    matches.push(row)
    byName.set(name, matches)
  }
  return (source, raw) => {
    let path = raw.toLowerCase()
    if (!byName.has(posix.basename(path))) path += '.md'
    const directory = posix.dirname(source.path).toLowerCase()
    if (path.startsWith('./') || path.startsWith('../')) {
      const relative = byPath.get(posix.normalize(posix.join(directory, path)))
      if (relative) return relative
    }
    const direct = byPath.get(path.replace(/^\//, ''))
    if (direct || path.startsWith('/')) return direct
    const candidates = (byName.get(posix.basename(path)) ?? [])
      .filter((row) => row.path.toLowerCase().endsWith(path))
      .sort((a, b) => {
        const localA = directory !== '.' && a.path.toLowerCase().startsWith(directory)
        const localB = directory !== '.' && b.path.toLowerCase().startsWith(directory)
        return Number(localB) - Number(localA) || a.path.length - b.path.length
      })
    // Memory tools also accept stable note IDs; filenames take precedence in the graph.
    return candidates[0] ?? byId.get(raw)
  }
}
