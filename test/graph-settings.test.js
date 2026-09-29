import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  createGraphSettingsStore,
  GRAPH_SETTINGS_KEY,
  GRAPH_SETTINGS_VERSION,
  readGraphSettings,
  writeGraphSettings,
} from '../lib/graph-settings.js'

/** The panel's built-in controls, as `lib/client.js` seeds them. */
const defaults = () => ({
  scope: 'all',
  filter: { search: '', tags: false, attachments: false, existing: false, orphans: true },
  groups: [],
  display: { arrows: false, text: 0, size: 1, width: 1, label: 0.85 },
  forces: { center: 0.5, repel: 10, link: 1, distance: 250 },
})

/** A `Storage`-like object that can be asked to misbehave like a real one. */
function storage(initial = {}, { read = true, write = true } = {}) {
  const map = new Map(Object.entries(initial))
  return {
    map,
    getItem(key) {
      if (!read) throw new Error('storage is disabled')
      return map.has(key) ? map.get(key) : null
    },
    setItem(key, value) {
      if (!write) throw new Error('quota exceeded')
      map.set(key, String(value))
    },
  }
}

test('an empty browser remembers nothing and the panel keeps its built-in controls', () => {
  const empty = storage()
  assert.deepEqual(readGraphSettings(defaults(), empty), defaults())
  // A fresh object every time: the panel mutates what it is handed.
  const first = readGraphSettings(defaults(), empty)
  first.filter.search = 'changed'
  first.groups.push({ query: 'x', color: '#000000' })
  assert.deepEqual(readGraphSettings(defaults(), empty), defaults())
})

test('what the panel remembers comes back unchanged', () => {
  const store = storage()
  const settings = {
    scope: 'project',
    filter: {
      search: '[type:decision]',
      tags: true,
      attachments: false,
      existing: true,
      orphans: false,
    },
    groups: [
      { query: '[type:gotcha]', color: '#fb464c' },
      { query: '[tag:graph]', color: '#8a5cf5' },
    ],
    display: { arrows: true, text: -1.5, size: 2.4, width: 0.6, label: 1.2 },
    forces: { center: 0.9, repel: 3, link: 0.4, distance: 90 },
  }
  writeGraphSettings(settings, defaults(), store)
  assert.deepEqual(readGraphSettings(defaults(), store), settings)
})

test('one versioned key holds the five control fields and nothing else', () => {
  const store = storage()
  writeGraphSettings({ ...defaults(), scope: 'project', extra: 'dropped' }, defaults(), store)
  assert.deepEqual(
    [...store.map.keys()],
    [GRAPH_SETTINGS_KEY],
    'the panel owns exactly one key on this origin',
  )
  const saved = JSON.parse(store.map.get(GRAPH_SETTINGS_KEY))
  assert.equal(saved.version, GRAPH_SETTINGS_VERSION)
  assert.deepEqual(
    Object.keys(saved).sort(),
    ['display', 'filter', 'forces', 'groups', 'scope', 'version'],
    'nothing outside the panel record is persisted',
  )
  assert.equal(saved.extra, undefined)
})

test('a hand-edited record falls back field by field, not as a whole', () => {
  const store = storage({
    [GRAPH_SETTINGS_KEY]: JSON.stringify({
      version: GRAPH_SETTINGS_VERSION,
      scope: 'project',
      filter: { search: 42, orphans: 'yes' },
      groups: 'not an array',
      display: { arrows: true, label: 9, size: 'big' },
      forces: { distance: 9999, repel: null, center: -4 },
    }),
  })
  const read = readGraphSettings(defaults(), store)
  assert.equal(read.scope, 'project', 'a field that is still valid survives its neighbours')
  assert.equal(read.filter.search, '', 'a non-string search falls back')
  assert.equal(read.filter.orphans, true, 'a non-boolean toggle falls back')
  assert.equal(read.display.arrows, true)
  assert.equal(read.display.label, 1.6, 'a slider value above its range is clamped')
  assert.equal(read.display.size, 1, 'a slider value of the wrong type falls back')
  assert.equal(read.forces.distance, 500)
  assert.equal(read.forces.center, 0)
  assert.equal(read.forces.repel, 10)
  assert.deepEqual(read.groups, [], 'a record that is not a list of groups colours nothing')
})

test('an unreadable or foreign record is a fresh panel', () => {
  const foreign = storage({
    [GRAPH_SETTINGS_KEY]: JSON.stringify({ version: 2, scope: 'project' }),
  })
  assert.deepEqual(readGraphSettings(defaults(), foreign), defaults())
  const broken = storage({ [GRAPH_SETTINGS_KEY]: '{not json' })
  assert.deepEqual(readGraphSettings(defaults(), broken), defaults())
  const nothing = storage({ [GRAPH_SETTINGS_KEY]: 'null' })
  assert.deepEqual(readGraphSettings(defaults(), nothing), defaults())
  // `null` is a browser that has no storage object at all, which is not the same
  // as a storage that is there and throws.
  assert.deepEqual(readGraphSettings(defaults(), null), defaults())
  assert.doesNotThrow(() => writeGraphSettings(defaults(), defaults(), null))
})

test('colour groups are bounded and a malformed one is dropped', () => {
  const store = storage()
  const many = Array.from({ length: 40 }, (_, index) => ({
    query: 'q' + index,
    color: '#8a5cf5',
  }))
  many.push({ query: 'no colour', color: 'red' }, { query: 'no query' }, null, '#8a5cf5')
  writeGraphSettings({ ...defaults(), groups: many }, defaults(), store)
  const read = readGraphSettings(defaults(), store)
  // 32 is the module's own ceiling; a vault cannot colour more note types than that.
  assert.equal(read.groups.length, 32)
  assert.deepEqual(read.groups.at(-1), { query: 'q31', color: '#8a5cf5' })
  writeGraphSettings(
    { ...defaults(), groups: [{ query: 'x'.repeat(500), color: '#abc' }] },
    defaults(),
    store,
  )
  const long = readGraphSettings(defaults(), store).groups
  assert.equal(long.length, 1)
  assert.equal(long[0].query.length, 200)
  assert.equal(long[0].color, '#abc', 'a three-digit colour is still a colour')
})

test('a storage that refuses to be read or written never breaks the view', () => {
  assert.deepEqual(readGraphSettings(defaults(), storage({}, { read: false })), defaults())
  const closed = storage({}, { write: false })
  assert.doesNotThrow(() =>
    writeGraphSettings({ ...defaults(), scope: 'project' }, defaults(), closed),
  )
  assert.equal(closed.map.size, 0, 'a refused write leaves nothing behind')
})

test('the bound store reads and writes through the same defaults', () => {
  const store = storage()
  const bound = createGraphSettingsStore(defaults(), store)
  assert.deepEqual(bound.read(), defaults())
  bound.write({ ...defaults(), display: { ...defaults().display, label: 1.4 } })
  assert.equal(bound.read().display.label, 1.4)
})
