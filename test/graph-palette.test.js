// The colour-slot contract on its own: Obsidian's `MQ` table, the `{a, rgb}` shape
// `testCSS()` produces, and the probe read that fills it in. The renderer's own
// test covers the painting; this one pins the resolution rules.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  COLOR_SLOTS,
  FALLBACK_RGB,
  colorOf,
  parseColor,
  resolvePalette,
  withCss,
} from '../lib/graph-palette.js'

test("the slot table is Obsidian's eleven .graph-view classes", () => {
  assert.deepEqual(Object.values(COLOR_SLOTS), [
    'color-fill',
    'color-fill-focused',
    'color-fill-tag',
    'color-fill-unresolved',
    'color-fill-attachment',
    'color-arrow',
    'color-circle',
    'color-line',
    'color-text',
    'color-fill-highlight',
    'color-line-highlight',
  ])
})

test('parseColor reads every form a theme or a colour input can produce', () => {
  assert.deepEqual(parseColor('rgb(92, 92, 92)'), { a: 1, rgb: 0x5c5c5c })
  assert.deepEqual(parseColor('rgba(255, 255, 255, 0.12)').a, 0.12)
  assert.deepEqual(parseColor('#b3b3b3'), { a: 1, rgb: 0xb3b3b3 })
  assert.deepEqual(parseColor('#fff'), { a: 1, rgb: 0xffffff })
  assert.equal(parseColor('transparent'), null)
  assert.equal(parseColor(''), null)
  assert.equal(parseColor(undefined), null)
  assert.equal(parseColor('rgb(1, 2)'), null)
})

test('a slot carries both a colour and an opacity, and its two CSS forms', () => {
  const slot = withCss({ a: 0.5, rgb: 0x234567 })
  assert.equal(slot.css, 'rgba(35, 69, 103, 0.5)')
  assert.equal(slot.opaque, 'rgb(35, 69, 103)')
  // A translucent host token must keep its alpha: the graph multiplies the slot's
  // own opacity by it, so a lost alpha is a lost contrast factor.
  assert.equal(parseColor('rgba(67, 69, 74, 0.25)').a, 0.25)
})

test('resolvePalette reads colour x opacity per slot and falls back to grey', () => {
  const appended = []
  const host = {
    appendChild: (probe) => appended.push(probe.className),
    removeChild: () => {},
  }
  const document = {
    createElement: () => ({ className: '', style: {}, setAttribute() {} }),
  }
  const theme = {
    'graph-view color-fill': { color: 'rgb(92, 92, 92)', opacity: '1' },
    'graph-view color-fill-unresolved': { color: 'rgb(171, 171, 171)', opacity: '0.5' },
    'graph-view color-line': { color: 'rgb(212, 212, 212)', opacity: '1' },
  }
  const win = {
    getComputedStyle: (probe) => theme[probe.className] ?? { color: 'transparent', opacity: '1' },
  }
  const palette = resolvePalette({ document, win, host })
  assert.equal(palette.fill.opaque, 'rgb(92, 92, 92)')
  assert.equal(palette.fillUnresolved.a, 0.5, 'color-fill-unresolved keeps its 50% opacity')
  assert.equal(palette.line.opaque, 'rgb(212, 212, 212)')
  // No declaration for these, so Obsidian's grey default applies at full opacity.
  assert.deepEqual({ a: palette.text.a, rgb: palette.text.rgb }, { a: 1, rgb: FALLBACK_RGB })
  assert.equal(appended.length, Object.keys(COLOR_SLOTS).length, 'one probe per slot')
  assert.ok(appended.every((name) => name.startsWith('graph-view color-')))
})

test('colorOf prefers a colour-group value and falls back when it is unreadable', () => {
  const slot = withCss({ a: 1, rgb: 0x5c5c5c })
  assert.equal(colorOf('#8a5cf5', slot).opaque, 'rgb(138, 92, 245)')
  assert.equal(colorOf('', slot), slot)
  assert.equal(colorOf(null, slot), slot)
})
