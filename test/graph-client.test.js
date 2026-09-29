import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'

test('browser bundle registers one memory graph tab through Better Sidebar', async () => {
  const script = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  let module
  const window = {
    __ModuleLoader__: {
      load(value) {
        module = value
      },
    },
  }
  runInNewContext(script, { window })
  assert.equal(module.id, 'dsh-obsidian-mem')
  const exports = module.factory((name) => {
    assert.equal(name, 'react')
    return { createElement: (...args) => ({ args }) }
  })
  assert.deepEqual(Array.from(exports.inject), ['betterSidebar'])
  let tab
  const ctx = {
    betterSidebar: {
      registerTab(value) {
        tab = value
        return () => {
          tab = undefined
        }
      },
    },
    effect(callback) {
      this.dispose = callback()
    },
  }
  // The renderer resolves colour from `.graph-view.color-*` probes, so the browser
  // half must define all eleven slots; a missing rule silently falls back to grey.
  const slots = [
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
  ]
  for (const slot of slots) {
    assert.ok(
      script.includes('.memgraph .graph-view.' + slot + '{'),
      'the bundle defines the ' + slot + ' slot',
    )
  }
  assert.equal(
    /--mg-[a-z-]+:/u.test(script),
    false,
    'no bespoke colour variables survive beside the Obsidian slots',
  )
  // The renderer reads `display.label`; the panel has to offer it, with the
  // default requested by the user on 2026-09-28.
  assert.ok(
    script.includes("slider('标题文字大小', 'label', display, setDisplay"),
    'the display section exposes the title-size slider',
  )
  assert.ok(script.includes('label: 0.85'), 'the title-size default is 0.85')
  // The panel's own controls have to outlive the page: the host builds this tab from
  // scratch on every load and the route that feeds it is read-only, so the bundle
  // restores through the settings module the route serves — and saves only after
  // that read lands, because the first render still holds the built-in defaults and
  // writing those would erase the record.
  assert.ok(
    script.includes("import('/obsidian-mem/graph-settings.js')"),
    'the bundle loads the settings module beside it',
  )
  assert.ok(script.includes('createGraphSettingsStore({'), 'the panel binds one store')
  assert.match(
    script,
    /if \(!restored\) return\s+store\.current\?\.write\(/u,
    'the save is gated on the restore landing first',
  )
  exports.apply(ctx)
  assert.equal(tab.id, 'obsidian-mem:graph')
  assert.equal(tab.single, true)
  assert.equal(typeof tab.component, 'function')
  const view = tab.component({ scope: { sessionId: 'session-case' }, visible: true })
  assert.equal(view.args[1].sessionId, 'session-case')
  assert.equal(view.args[1].visible, true)
  ctx.dispose()
  assert.equal(tab, undefined)
})
