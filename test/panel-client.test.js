import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'

const source = () => readFile(new URL('../lib/client.js', import.meta.url), 'utf8')

/** Register the bundle the way the host does, and return its factory exports. */
async function bundle() {
  const script = await source()
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
  return { script, exports }
}

test('the shell keeps the graph tab id, retitles it 记忆 and renders the panel', async () => {
  const { exports } = await bundle()
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
  exports.apply(ctx)
  assert.equal(tab.id, 'obsidian-mem:graph', 'the tab id is what Better Sidebar keys open tabs by')
  assert.equal(tab.title, '记忆')
  assert.equal(tab.description, '项目的记忆：概览、图谱、检索与健康')
  assert.equal(tab.order, 35)
  assert.equal(tab.single, true)
  assert.equal(typeof tab.component, 'function')
  const view = tab.component({ scope: { sessionId: 'session-case' }, visible: true })
  assert.equal(view.args[1].sessionId, 'session-case')
  assert.equal(view.args[1].visible, true)
  ctx.dispose()
  assert.equal(tab, undefined)
})

test('the shell loads the one served module and passes React into it', async () => {
  const { script } = await bundle()
  assert.ok(
    script.includes("import('/obsidian-mem/memory-panel.js')"),
    'dynamic import of the served module',
  )
  assert.ok(script.includes('createMemoryViews({ React })'), 'React is passed into the module')
  assert.ok(
    script.includes("import('/obsidian-mem/graph-renderer.js')"),
    'the graph renderer stays',
  )
  assert.ok(
    script.includes("import('/obsidian-mem/graph-settings.js')"),
    'the settings module stays',
  )
})

test('the view strip is a real tablist with roving focus and keyboard navigation', async () => {
  const { script } = await bundle()
  for (const marker of [
    "role: 'tablist'",
    "role: 'tab'",
    "'aria-selected'",
    "'aria-controls'",
    "role: 'tabpanel'",
    "'aria-labelledby'",
    'tabIndex: value === view.id ? 0 : -1',
    "event.key === 'ArrowRight'",
    "event.key === 'ArrowLeft'",
    "event.key === 'Home'",
    "event.key === 'End'",
  ])
    assert.ok(script.includes(marker), 'the shell contains ' + marker)
  for (const label of ['概览', '图谱', '检索', '健康'])
    assert.ok(script.includes("label: '" + label + "'"), 'the strip has ' + label)
})

test('the injected panel CSS is token-only, injected once and motion-gated', async () => {
  const { script } = await bundle()
  const start = script.indexOf('/* panel-css:start */')
  const end = script.indexOf('/* panel-css:end */')
  assert.ok(start >= 0 && end > start, 'the panel stylesheet is marked for scanning')
  const css = script.slice(start, end)
  assert.equal(/#[0-9a-f]{3,8}\b/iu.test(css), false, 'no hex colour literal')
  assert.equal(/\brgba?\(/u.test(css), false, 'no rgb() colour literal')
  assert.equal(/\bhsla?\(/u.test(css), false, 'no hsl() colour literal')
  const tokens = css.match(/var\(--[a-z0-9-]+/gu) ?? []
  assert.ok(tokens.length > 0, 'the stylesheet reads theme tokens')
  for (const token of tokens) assert.match(token, /var\(--dsw-/u, 'not a --dsw-* alias: ' + token)
  assert.ok(css.includes('prefers-reduced-motion'), 'motion is gated')
  assert.ok(css.includes(':focus-visible'), 'focus is visible')
  assert.ok(script.includes('data-plugin-css="dsh-obsidian-mem/panel"'), 'the sheet is tagged')
  assert.ok(script.includes('querySelector('), 'the injection dedupes by selector')
  assert.ok(
    script.includes('document.head.appendChild(style)'),
    'the sheet lands in head exactly once',
  )
})

test('the graph keeps its canvas and gains the truncation notice', async () => {
  const { script } = await bundle()
  assert.ok(script.includes("role: 'img', tabIndex: 0"), 'the canvas is still the graph')
  assert.ok(
    script.includes("import('/obsidian-mem/graph-renderer.js')"),
    'the renderer is unchanged',
  )
  assert.ok(script.includes('graph.truncated === true'), 'the snapshot truncation is rendered')
  assert.ok(script.includes('仅显示前 '), 'the notice names the shown count')
  assert.ok(script.includes("' 个节点；共有 '"), 'the notice names the total')
})

test('the shell adds a ledger masthead and ordinal tab index above the body', async () => {
  const { script } = await bundle()
  for (const marker of [
    "'mem-masthead'",
    'mem-masthead-name',
    "'mem-clock'",
    "'mem-refresh'",
    "'已绑定'",
    "'未绑定'",
    'onMeta',
  ])
    assert.ok(script.includes(marker), 'the shell contains ' + marker)
  for (const [id, label, ordinal] of [
    ['overview', '概览', '01'],
    ['graph', '图谱', '02'],
    ['search', '检索', '03'],
    ['health', '健康', '04'],
  ])
    assert.ok(
      script.includes("{ id: '" + id + "', label: '" + label + "', ordinal: '" + ordinal + "' }"),
      'the strip lists ' + ordinal + ' ' + label,
    )
})

test('the panel sheet is a token-only editorial ledger with no floating furniture', async () => {
  const { script } = await bundle()
  const start = script.indexOf('/* panel-css:start */')
  const end = script.indexOf('/* panel-css:end */')
  const css = script.slice(start, end)
  for (const face of ['Iowan Old Style', 'Palatino', 'Songti SC'])
    assert.ok(css.includes(face), 'the display face names ' + face)
  assert.ok(css.includes('font-variant-numeric:tabular-nums'), 'numbers are tabular')
  for (const marker of ['mem-masthead-name', 'mem-kpi-value', 'mem-stamp', 'mem-sheet'])
    assert.ok(css.includes(marker), 'the sheet styles ' + marker)
  assert.ok(
    css.includes('min-height:40px') && css.includes('min-height:44px'),
    'hit areas are 40-44px',
  )
  const radii = [...css.matchAll(/border-radius:\s*([^;}]+)/gu)].map((match) => match[1].trim())
  assert.ok(radii.length > 0, 'the sheet declares radii')
  for (const radius of radii)
    for (const value of radius.match(/[0-9.]+/gu) ?? [])
      assert.ok(Number(value) <= 4, 'radius stays 0-4px, found ' + radius)
  assert.equal(/box-shadow/iu.test(css), false, 'no floating card shadow')
  assert.equal(/linear-gradient|radial-gradient/iu.test(css), false, 'no gradient furniture')
})

test('the view entrance is one 160ms stagger that reduced motion removes', async () => {
  const { script } = await bundle()
  const css = script.slice(
    script.indexOf('/* panel-css:start */'),
    script.indexOf('/* panel-css:end */'),
  )
  assert.ok(css.includes('@keyframes mem-enter'), 'the entrance is named')
  assert.ok(css.includes('animation:mem-enter 160ms'), 'the entrance runs 160ms')
  assert.deepEqual(
    [...css.matchAll(/animation-delay:([0-9]+)ms/gu)].map((match) => Number(match[1])),
    [20, 40, 60, 80],
    'children stagger by 20ms',
  )
  assert.match(css.slice(css.indexOf('prefers-reduced-motion')), /animation:none/u)
})
