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

/** The marked panel stylesheet, exactly the slice the static rules scan. */
function panelCss(script) {
  const start = script.indexOf('/* panel-css:start */')
  const end = script.indexOf('/* panel-css:end */')
  assert.ok(start >= 0 && end > start, 'the panel stylesheet is marked for scanning')
  return script.slice(start, end)
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

test('the view index is four icon tabs in the reviewed order, without ordinals', async () => {
  const { script } = await bundle()
  for (const [id, label, icon] of [
    ['overview', '概览', 'overview'],
    ['graph', '图谱', 'graph'],
    ['search', '检索', 'search'],
    ['health', '健康', 'health'],
  ])
    assert.ok(
      script.includes("{ id: '" + id + "', label: '" + label + "', icon: '" + icon + "' }"),
      'the strip lists ' + label + ' with its icon key',
    )
  assert.equal(script.includes('ordinal'), false, 'the 01-04 ordinals retired')
  for (const name of ['overview', 'graph', 'search', 'health', 'refresh'])
    assert.ok(script.includes(name + ": '"), 'icon() defines the ' + name + ' glyph')
  for (const marker of ["className: 'mem-tab-icon'", "'aria-hidden': true", 'icon(view.icon)'])
    assert.ok(script.includes(marker), 'each tab carries ' + marker)
  assert.ok(script.includes("className: 'mem-tab-label'"), 'each tab keeps a text label')
  assert.ok(
    script.indexOf("className: 'mem-tab-icon'") < script.indexOf("className: 'mem-tab-label'"),
    'the icon precedes the label',
  )
})

test('every tab controls the one mounted tabpanel', async () => {
  const { script } = await bundle()
  assert.ok(
    script.includes("'aria-controls': 'obsidian-mem-panel'"),
    'the tabs point at the one panel id',
  )
  assert.ok(script.includes("id: 'obsidian-mem-panel'"), 'the mounted panel carries that id')
  assert.ok(
    script.includes("'aria-labelledby': 'obsidian-mem-tab-' + view"),
    'the panel is labelled by the selected tab',
  )
  assert.equal(
    script.includes("'obsidian-mem-panel-' + view"),
    false,
    'the unmounted per-view panel ids are gone',
  )
})

test('the injected panel CSS is token-only, injected once and motion-gated', async () => {
  const { script } = await bundle()
  const css = panelCss(script)
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

test('the masthead is a compact modern header with an icon refresh and no inert clock', async () => {
  const { script } = await bundle()
  for (const marker of [
    "'mem-masthead'",
    'mem-masthead-top',
    'mem-masthead-name',
    'mem-masthead-sub',
    'mem-masthead-meta',
    "'mem-clock'",
    "'mem-refresh'",
    "'已绑定'",
    "'未绑定'",
    "'数据截至 '",
    "'读取失败'",
    '正在读取…',
    '刷新记忆数据',
    "icon('refresh')",
    'onMeta: report.current',
    'React.useState(null)',
  ])
    assert.ok(script.includes(marker), 'the shell masthead contains ' + marker)
  assert.ok(script.includes('mem-display'), 'the name keeps the headline hook')
  assert.equal(script.includes("'刷新'"), false, 'the underlined 刷新 text button retired')
  assert.ok(
    script.includes('const hasClock = meta !== null || onRefresh !== null'),
    'the clock is withheld when no view reported and the tab has no poll',
  )
  const guard = script.indexOf('const hasClock = meta !== null || onRefresh !== null')
  assert.ok(
    script.indexOf('正在读取…') > guard,
    'the fallback clock text sits behind the guard, not in the always-on row',
  )
})

test('the stylesheet is a token-only host-type design system with bounded radii', async () => {
  const { script } = await bundle()
  const css = panelCss(script)
  assert.equal(/font-family/iu.test(css), false, 'no custom font-family declaration')
  assert.equal(/serif/iu.test(css), false, 'the serif display face is retired')
  assert.ok(css.includes('var(--dsw-font-'), 'the host font shorthands are used')
  for (const token of [
    'font:var(--dsw-font-s-strong-14)',
    'font:var(--dsw-font-xxs-strong-12)',
    'font:var(--dsw-font-xxs-12)',
    'font:var(--dsw-font-xxxs-11)',
  ])
    assert.ok(css.includes(token), 'the type scale uses ' + token)
  assert.ok(css.includes('letter-spacing:0'), 'no negative tracking')
  assert.ok(css.includes('font-variant-numeric:tabular-nums'), 'numbers are tabular')
  assert.ok(css.includes('line-height:1.6'), 'CJK line-height is 1.55-1.7')

  const radii = [...css.matchAll(/border-radius:\s*([^;}]+)/gu)].map((match) => match[1].trim())
  assert.ok(radii.length > 0, 'the design system declares radii')
  for (const radius of radii)
    for (const value of radius.match(/[0-9.]+/gu) ?? [])
      assert.ok(Number(value) <= 16, 'radius stays 0-16px, found ' + radius)

  const shadows = [...css.matchAll(/box-shadow:\s*([^;}]+)/gu)].map((match) => match[1].trim())
  assert.ok(shadows.length > 0, 'the two token shadows are used')
  for (const shadow of shadows)
    assert.ok(
      ['var(--dsw-shadow-lv1)', 'var(--dsw-shadow-lv3)'].includes(shadow),
      'shadow is lv1 or lv3, found ' + shadow,
    )
  assert.equal(/gradient/iu.test(css), false, 'no gradient furniture')
  assert.equal(/color-scheme/iu.test(css), false, 'the host owns the colour scheme')
})

test('the tab strip is the Chrome form: 34px tab in a 42px strip, top radius merged with content', async () => {
  const { script } = await bundle()
  const css = panelCss(script)
  for (const marker of [
    'height:42px',
    'padding:6px 6px 0',
    'grid-template-columns:repeat(4,minmax(0,1fr))',
    'background:var(--dsw-alias-bg-layer-1)',
    'border-bottom:1px solid var(--dsw-alias-border-l1)',
    'height:34px',
    'margin-bottom:-1px',
    'border:1px solid transparent',
    'border-bottom:0',
    'border-radius:10px 10px 0 0',
    'background:var(--dsw-alias-interactive-bg-hover)',
    'border-bottom-color:var(--dsw-alias-bg-base)',
    'box-shadow:var(--dsw-shadow-lv1)',
    'transition:background-color 150ms ease,color 150ms ease',
    'mem-tab-icon',
    'flex:0 0 auto',
    '@container (max-width:359px)',
    '.mem-tab-icon{display:none}',
  ])
    assert.ok(css.includes(marker), 'the Chrome strip contains ' + marker)
  assert.ok(
    css.includes('.mem-tab[aria-selected="true"]'),
    'the selected tab is the content surface',
  )
  assert.ok(css.includes('min-width:0'), 'tabs may truncate instead of overflowing')
})

test('every class the redesigned views consume is styled in the one stylesheet', async () => {
  const { script } = await bundle()
  const css = panelCss(script)
  const hooks = [
    'mem-panel',
    'mem-display',
    'mem-masthead',
    'mem-masthead-top',
    'mem-masthead-name',
    'mem-masthead-sub',
    'mem-masthead-meta',
    'mem-clock',
    'mem-refresh',
    'mem-tabs',
    'mem-tab',
    'mem-tab-icon',
    'mem-tab-label',
    'mem-view',
    'mem-ledger',
    'mem-sr',
    'mem-stamp',
    'mem-viewhead',
    'mem-viewhead-title',
    'mem-viewhead-meta',
    'mem-actions',
    'mem-action',
    'mem-btn',
    'mem-btn-primary',
    'mem-btn-quiet',
    'mem-label',
    'mem-meta',
    'mem-warn',
    'mem-notice',
    'mem-status',
    'mem-empty',
    'mem-skeleton',
    'mem-more',
    'mem-kpiline',
    'mem-kpi',
    'mem-kpi-label',
    'mem-kpi-line',
    'mem-kpi-value',
    'mem-kpi-unit',
    'mem-summary',
    'mem-summary-item',
    'mem-summary-value',
    'mem-section',
    'mem-section-head',
    'mem-section-meta',
    'mem-comp',
    'mem-bar-track',
    'mem-bar-fill',
    'mem-comp-legend',
    'mem-comp-row',
    'mem-comp-dot',
    'mem-comp-name',
    'mem-comp-value',
    'mem-comp-pct',
    'mem-stamps',
    'mem-recent',
    'mem-recent-row',
    'mem-recent-main',
    'mem-recent-title',
    'mem-recent-meta',
    'mem-dot',
    'mem-searchbar',
    'mem-search-field',
    'mem-search-icon',
    'mem-search-input',
    'mem-search-clear',
    'mem-search-submit',
    'mem-filter',
    'mem-filter-label',
    'mem-filter-options',
    'mem-filter-option',
    'mem-results',
    'mem-result',
    'mem-result-main',
    'mem-result-head',
    'mem-result-title',
    'mem-result-path',
    'mem-snippet',
    'mem-chips',
    'mem-chip',
    'mem-facts',
    'mem-rows',
    'mem-row',
    'mem-row-title',
    'mem-row-time',
    'mem-meter',
    'mem-meter-head',
    'mem-meter-track',
    'mem-meter-fill',
    'mem-events',
    'mem-event',
    'mem-event-dot',
    'mem-digest',
    'mem-sheet',
    'mem-sheet-scrim',
    'mem-sheet-panel',
    'mem-sheet-head',
    'mem-sheet-title',
    'mem-sheet-body',
    'mem-sheet-fact',
    'mem-fact-value',
    'mem-sheet-effects',
    'mem-sheet-warning',
    'mem-sheet-error',
    'mem-sheet-actions',
    'mem-sheet-confirm',
    'mem-sheet-cancel',
  ]
  for (const hook of hooks)
    assert.match(
      css,
      new RegExp('\\.' + hook + '(?![a-z0-9-])', 'u'),
      'the stylesheet styles ' + hook,
    )
  for (const variant of [
    '.mem-stamp.is-ok',
    '.mem-stamp.is-warn',
    '.mem-stamp.is-err',
    '.mem-notice.is-stale',
    '.mem-notice.is-error',
    '.mem-notice.is-empty',
    '.mem-status.is-error',
    '.mem-status.is-idle',
    '.mem-summary-value.is-warn',
    '.mem-summary-value.is-err',
    '.mem-meter-fill.is-warn',
    '.mem-snippet mark',
    '.mem-filter-option[aria-pressed="true"]',
  ])
    assert.ok(css.includes(variant), 'the stylesheet styles ' + variant)
  assert.ok(css.includes('grid-template-columns:repeat(2,minmax(0,1fr))'), 'overflow folds to 2x2')
  assert.ok(css.includes('-webkit-line-clamp:2'), 'snippets clamp to two lines')
})

test('motion is one 160ms entrance plus explicit transitions that reduced motion removes', async () => {
  const { script } = await bundle()
  const css = panelCss(script)
  assert.ok(css.includes('@keyframes mem-enter'), 'the entrance is named')
  assert.ok(css.includes('animation:mem-enter 160ms'), 'the entrance runs 160ms')
  assert.deepEqual(
    [...css.matchAll(/animation-delay:([0-9]+)ms/gu)].map((match) => Number(match[1])),
    [20, 40, 60, 80],
    'children stagger by 20ms',
  )
  assert.equal(/transition:all/iu.test(css), false, 'transitions name their properties')
  const reduced = css.slice(css.indexOf('prefers-reduced-motion'))
  assert.match(reduced, /animation:none/u, 'reduced motion removes the entrance')
  assert.match(reduced, /transition:none/u, 'reduced motion removes the transitions')
})

test('the view scrolls its own thin, token-built scrollbar', async () => {
  const { script } = await bundle()
  const css = panelCss(script)
  assert.ok(css.includes('scrollbar-width:thin'), 'thin scrollbar for the narrow column')
  assert.ok(
    css.includes(
      'scrollbar-color:color-mix(in srgb,var(--dsw-alias-label-secondary) 35%,transparent) transparent',
    ),
    'the scrollbar colour is a token mix',
  )
  assert.ok(css.includes('::-webkit-scrollbar{width:8px'), 'the webkit fallback is 8px')
  assert.ok(
    css.includes(
      '::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--dsw-alias-label-secondary) 35%,transparent)',
    ),
    'the webkit thumb is the same mix',
  )
})
