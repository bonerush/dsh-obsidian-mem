// The graph panel is rebuilt from scratch on every page load, so a control the user
// moved went back to its default after a reload. Obsidian keeps graph state in the
// workspace layout and this panel has no such file; the graph route is deliberately
// read-only, which leaves the browser's own storage as the only place the panel can
// remember anything.
//
// A value read back is untrusted input on the way in *and* on the way out:
// `localStorage` is shared with every other page on this origin, editable by hand,
// and it outlives the version that wrote it. A `NaN` force or a colour group with no
// colour would reach the renderer and blank the graph, so every field is rebuilt
// from a known shape here instead of being trusted, and a record written by another
// version is ignored rather than migrated: the fallback is always a graph that works.

/** Where the panel remembers its controls. One key, one record. */
export const GRAPH_SETTINGS_KEY = 'dsh-obsidian-mem:graph-settings'
/** The record's shape version. A different number is ignored, not migrated. */
export const GRAPH_SETTINGS_VERSION = 1
/** A group query is a search string; the panel's own box is a single-line input. */
const MAX_QUERY = 200
/** Enough groups to colour every note type a vault has, and bounded. */
const MAX_GROUPS = 32
const COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/iu

/** A stored value that is not an object carries nothing, not an error. */
const record = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
const section = (value, name) => record(record(value)[name])
const flag = (value, fallback) => (typeof value === 'boolean' ? value : fallback)
const text = (value, fallback) => (typeof value === 'string' ? value.slice(0, MAX_QUERY) : fallback)

/**
 * One number inside its slider's range.
 *
 * The bounds are the panel's own slider bounds (see the `slider(...)` calls in
 * `client.js`) and have to move with them. Out of range is clamped rather than
 * rejected: it is still the user's intent, from a version whose range differed.
 */
const number = (value, fallback, min, max) =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback

/** The colour groups, with a malformed entry dropped rather than drawn. */
function groups(value, fallback) {
  if (!Array.isArray(value)) return fallback
  return value.slice(0, MAX_GROUPS).flatMap((group) => {
    const entry = record(group)
    if (typeof entry.query !== 'string' || !COLOR.test(String(entry.color))) return []
    return [{ query: entry.query.slice(0, MAX_QUERY), color: entry.color }]
  })
}

/** A complete record built from `value`, every field falling back to `defaults`. */
function sanitize(value, defaults) {
  const source = record(value)
  const filter = section(source, 'filter')
  const display = section(source, 'display')
  const forces = section(source, 'forces')
  const builtin = {
    filter: section(defaults, 'filter'),
    display: section(defaults, 'display'),
    forces: section(defaults, 'forces'),
  }
  return {
    scope: source.scope === 'project' || source.scope === 'all' ? source.scope : defaults.scope,
    filter: {
      search: text(filter.search, builtin.filter.search),
      tags: flag(filter.tags, builtin.filter.tags),
      attachments: flag(filter.attachments, builtin.filter.attachments),
      existing: flag(filter.existing, builtin.filter.existing),
      orphans: flag(filter.orphans, builtin.filter.orphans),
    },
    groups: groups(source.groups, defaults.groups),
    display: {
      arrows: flag(display.arrows, builtin.display.arrows),
      text: number(display.text, builtin.display.text, -3, 3),
      size: number(display.size, builtin.display.size, 0.1, 5),
      width: number(display.width, builtin.display.width, 0.1, 5),
      label: number(display.label, builtin.display.label, 0.4, 1.6),
    },
    forces: {
      center: number(forces.center, builtin.forces.center, 0, 1),
      repel: number(forces.repel, builtin.forces.repel, 0, 20),
      link: number(forces.link, builtin.forces.link, 0, 1),
      distance: number(forces.distance, builtin.forces.distance, 30, 500),
    },
  }
}

/**
 * Read the controls this browser remembered, falling back field by field.
 *
 * Never throws. A browser with storage switched off (a private window, a hardened
 * profile, a full quota) and a record someone edited by hand both have to end at a
 * graph that works, so a storage that refuses to be read is simply no record.
 *
 * @param {object} defaults - the panel's built-in record: `scope`, `filter`, `groups`, `display`, `forces`.
 * @param {object} [storage] - a `Storage`-like object; defaults to this window's `localStorage`.
 * @returns {object} a complete record, safe to hand to the renderer as it stands.
 */
export function readGraphSettings(defaults, storage = globalThis.localStorage) {
  let saved = null
  try {
    saved = JSON.parse(storage?.getItem(GRAPH_SETTINGS_KEY) ?? 'null')
  } catch {
    /* A disabled storage, or a record someone edited into invalid JSON: no record. */
  }
  if (record(saved).version !== GRAPH_SETTINGS_VERSION) return sanitize(null, defaults)
  return sanitize(saved, defaults)
}

/**
 * Remember the controls, dropping anything the renderer could not draw.
 *
 * A refused write is not an error the panel can act on: the controls keep working
 * for this page, they are simply not remembered. Nothing is reported because the
 * only caller has nothing better to do with the answer.
 *
 * @param {object} settings - the panel's current controls.
 * @param {object} defaults - the built-in record, as in {@link readGraphSettings}.
 * @param {object} [storage] - a `Storage`-like object; defaults to `localStorage`.
 */
export function writeGraphSettings(settings, defaults, storage = globalThis.localStorage) {
  const value = { version: GRAPH_SETTINGS_VERSION, ...sanitize(settings, defaults) }
  try {
    storage?.setItem(GRAPH_SETTINGS_KEY, JSON.stringify(value))
  } catch {
    /* A full or disabled storage must not break the view it is remembering. */
  }
}

/**
 * Bind the record to one defaults object, so the panel holds one closure instead of
 * repeating its built-in controls at every call.
 *
 * @param {object} defaults - the panel's built-in record.
 * @param {object} [storage] - a `Storage`-like object; defaults to `localStorage`.
 * @returns {{read: Function, write: Function}} the bound pair.
 */
export function createGraphSettingsStore(defaults, storage = globalThis.localStorage) {
  return {
    read: () => readGraphSettings(defaults, storage),
    write: (settings) => writeGraphSettings(settings, defaults, storage),
  }
}
