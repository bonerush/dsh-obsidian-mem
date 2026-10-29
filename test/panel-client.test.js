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
  for (const label of ['概览', '图谱', '健康'])
    assert.ok(script.includes("label: '" + label + "'"), 'the strip has ' + label)
  assert.equal(script.includes("label: '检索'"), false, '检索 stopped being a tab')
})

test('the view index is exactly three folder tabs in the reviewed order, without ordinals', async () => {
  const { script } = await bundle()
  const start = script.indexOf('const MEMORY_VIEWS = [')
  const end = script.indexOf(']', start)
  assert.ok(start >= 0 && end > start, 'the view index is a literal list')
  assert.deepEqual(
    [...script.slice(start, end).matchAll(/id: '([a-z]+)'/gu)].map((match) => match[1]),
    ['overview', 'graph', 'health'],
    'three views, 检索 is no longer one of them',
  )
  for (const [id, label, icon] of [
    ['overview', '概览', 'overview'],
    ['graph', '图谱', 'graph'],
    ['health', '健康', 'health'],
  ])
    assert.ok(
      script.includes("{ id: '" + id + "', label: '" + label + "', icon: '" + icon + "' }"),
      'the strip lists ' + label + ' with its icon key',
    )
  assert.equal(script.includes("{ id: 'search'"), false, 'the 检索 view is gone')
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

test('the top bar is the tab strip itself, with the freshness line and refresh at its tail', async () => {
  const { script } = await bundle()
  // The dedicated masthead is gone: the project name and vault line repeated what
  // the host's own sidebar already says, and the panel is a tab strip over a body.
  // What survives is the one reading no other surface gives — how fresh the
  // figures are — carried small at the strip's tail, plus the refresh control.
  assert.equal(script.includes('function Masthead'), false, 'the separate header is retired')
  assert.equal(script.includes("className: 'mem-masthead'"), false, 'and its element with it')
  for (const marker of [
    "'mem-tabbar'",
    "'mem-tabbar-meta'",
    "'mem-clock'",
    "'mem-refresh'",
    "'数据截至 '",
    "'读取失败'",
    '正在读取…',
    '刷新记忆数据',
    "icon('refresh')",
  ])
    assert.ok(script.includes(marker), 'the strip carries ' + marker)
  // The clock stays guarded exactly as before: a tab that never polls must not
  // show a permanent "正在读取…" that will never resolve.
  assert.ok(
    script.includes('const hasClock = meta !== null || onRefresh !== null'),
    'the clock is withheld when no view reported and the tab has no poll',
  )
  const guard = script.indexOf('const hasClock = meta !== null || onRefresh !== null')
  assert.ok(
    script.indexOf("clock = '正在读取…'") > guard,
    'the fallback clock text sits behind the guard, not in the always-on row',
  )
  // The strip is the first thing in the panel and the search box follows it.
  const shell = script.slice(
    script.indexOf('function MemoryPanel'),
    script.indexOf('function SearchBox'),
  )
  const tabs = shell.indexOf('h(MemoryTabs,')
  const box = shell.indexOf('h(SearchBox,')
  assert.ok(tabs >= 0 && box >= 0, 'both the strip and the box are rendered by the shell')
  assert.ok(tabs < box, 'the tab strip is the top bar; the search box sits under it')
  assert.equal(shell.indexOf("className: 'mem-panel'") < tabs, true, 'the strip opens the panel')
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

test('the tab strip is a folder strip: flex, overlapping tabs, the active page merged into content', async () => {
  const { script } = await bundle()
  const css = panelCss(script)
  assert.equal(
    /grid-template-columns/iu.test(
      css.slice(css.indexOf('.mem-tabs{'), css.indexOf('}', css.indexOf('.mem-tabs{')) + 1),
    ),
    false,
    '.mem-tabs is not a grid any more',
  )
  const tabs = css.slice(
    css.indexOf('.mem-panel .mem-tabs{'),
    css.indexOf('}', css.indexOf('.mem-panel .mem-tabs{')) + 1,
  )
  for (const marker of ['display:flex', 'gap:0'])
    assert.ok(tabs.includes(marker), 'the folder strip declares ' + marker)
  // The strip's background and bottom rule belong to the row that now carries
  // both the leaves and the freshness tail (`mem-tabbar`), not to the tablist.
  const bar = css.slice(
    css.indexOf('.mem-panel .mem-tabbar{'),
    css.indexOf('}', css.indexOf('.mem-panel .mem-tabbar{')) + 1,
  )
  for (const marker of [
    'background:var(--dsw-alias-bg-layer-1)',
    'border-bottom:1px solid var(--dsw-alias-border-l1)',
    'padding:',
    'display:flex',
  ])
    assert.ok(bar.includes(marker), 'the top bar declares ' + marker)
  // Adjacent tabs overlap, and the active one sits above its neighbours so the
  // shared rounded edge reads as one folder leaf.
  assert.ok(css.includes('.mem-tab + .mem-tab{margin-left:-8px}'), 'adjacent tabs overlap by 8px')
  assert.ok(css.includes('z-index:2'), 'the active tab rides above the others')
  assert.ok(css.includes('z-index:0'), 'the resting tabs sit below it')
  for (const marker of [
    'height:32px',
    'margin-bottom:-1px',
    'border-radius:10px 10px 0 0',
    'border-bottom-color:var(--dsw-alias-bg-base)',
    'background:var(--dsw-alias-bg-base)',
    'box-shadow:var(--dsw-shadow-lv1)',
    'text-overflow:ellipsis',
    'transition:background-color 150ms ease,color 150ms ease',
    'mem-tab-icon',
    'border:1px solid var(--dsw-alias-border-l1)',
    'border-bottom-color:transparent',
  ])
    assert.ok(css.includes(marker), 'the folder tab contains ' + marker)
  assert.ok(
    css.includes('.mem-tab[aria-selected="true"]'),
    'the selected tab is the content surface',
  )
  assert.ok(css.includes('max-width:132px'), 'a tab never grows past the folder leaf width')
  assert.ok(css.includes('min-width:0'), 'tabs may truncate instead of overflowing')
  assert.ok(tabs.includes('flex-wrap:nowrap'), 'the leaves stay on one row')
  assert.equal(/overflow-x:(auto|scroll)/u.test(css), false, 'nothing scrolls sideways')
  for (const marker of ['flex:0 1 auto', 'align-items:flex-end'])
    assert.ok(css.includes(marker), 'the folder strip row contains ' + marker)
  // The 44px click target comes from the top bar's padding plus the leaf's own
  // upward hit extension — the leaf itself stays 32px so the folder look holds.
  // The padding moved from the tablist to `mem-tabbar` when the tile gained its
  // freshness tail; the geometry it buys is unchanged.
  assert.ok(
    bar.includes('padding:6px 14px 0'),
    'the top bar keeps the folder strip padding from the design',
  )
  assert.ok(css.includes('top:-12px'), 'the leaf extends its own hit area upward')
  assert.ok(css.includes('height:32px'), 'the leaf stays a 32px folder tab')
  assert.ok(css.includes('bottom:0'), 'the hit extension reaches the content surface')
  assert.ok(
    css.includes('.mem-tab:hover{background:var(--dsw-alias-interactive-bg-hover)'),
    'the resting leaf lifts on hover',
  )
  for (const marker of ['@container (max-width:359px)', '.mem-tab-icon{display:none}'])
    assert.ok(css.includes(marker), 'the 320px fallback contains ' + marker)
})

test('the shell keeps a persistent search box between the masthead and the tabs', async () => {
  const { script } = await bundle()
  for (const marker of [
    "role: 'search'",
    "className: 'mem-searchbar'",
    'mem-search-field',
    'mem-search-icon',
    'mem-search-input',
    'mem-search-clear',
    'mem-search-submit',
    'onSubmit:',
    "event.key === 'Escape'",
    'const [search, setSearch] = React.useState(null)',
    'SearchView',
  ])
    assert.ok(script.includes(marker), 'the shell search box contains ' + marker)
  // The search box is shell-level: MemoryPanel renders it directly under the tab
  // strip, so it is visible on every page and the results page only replaces the
  // mounted view body.
  const shell = script.slice(
    script.indexOf('function MemoryPanel'),
    script.indexOf('function SearchBox'),
  )
  const box = shell.indexOf('h(SearchBox,')
  const tabs = shell.indexOf('h(MemoryTabs,')
  assert.ok(box >= 0, 'the shell renders the search box itself, not a view')
  assert.ok(tabs >= 0, 'the shell renders the tab strip')
  assert.ok(tabs < box, 'tab strip → search box')
  assert.ok(shell.indexOf("className: 'mem-view'") > box, 'the one tabpanel follows the strip')
  // In search mode SearchView gets the shell's own state, not an internally owned form.
  for (const prop of [
    'sessionId',
    'query',
    'scope',
    'type',
    'status',
    'limit',
    'visible',
    'onClose',
  ])
    assert.ok(
      new RegExp('SearchView,\\s*\\{[^}]*\\b' + prop + '\\b', 'u').test(shell),
      'SearchView receives ' + prop + ' from the shell',
    )
  // 检索 is no longer a tab, so polling keeps to the two polling reads.
  assert.ok(
    script.includes("const polling = view === 'overview' || view === 'health'"),
    'polling covers 概览 and 健康 only',
  )
  assert.equal(script.includes("view === 'search'"), false, 'no search tab branch survives')
  // One search form: the shell owns it, and the retired page must not grow a second
  // one next to it (Task 4 deletes the view's own bar; until then the shell is the
  // only `role="search"` the bundle declares).
  const panelForm = [...script.matchAll(/role: 'search'/gu)]
  assert.equal(panelForm.length, 1, 'the bundle declares exactly one role="search" form')
  const formStart = script.lastIndexOf('mem-searchbar', panelForm[0].index)
  assert.ok(formStart >= 0 && panelForm[0].index - formStart < 200, 'the one form is the shell box')
  // The shell box owns the three exits; the retired view-owned form is gone.
  assert.equal(script.includes('mem-search-submit'), true, 'the box has a submit control')
  for (const marker of ['leaveSearch', 'clearSearch', 'chooseView', 'submitSearch'])
    assert.ok(script.includes('const ' + marker), 'the shell owns ' + marker)
})

test('the search box styles stay token-built and clear of hex literals', async () => {
  const { script } = await bundle()
  const css = panelCss(script)
  for (const hook of [
    'mem-searchbar',
    'mem-search-field',
    'mem-search-icon',
    'mem-search-input',
    'mem-search-clear',
  ]) {
    assert.match(css, new RegExp('\\.' + hook + '(?![a-z0-9-])', 'u'), 'styled: ' + hook)
  }
  for (const hook of ['mem-search-field', 'mem-search-icon', 'mem-search-input']) {
    const start = css.indexOf('.mem-panel .' + hook + '{')
    assert.ok(start >= 0, 'the shell search rule exists: ' + hook)
    const rule = css.slice(start, css.indexOf('}', start))
    assert.ok(rule.includes('var(--dsw-'), hook + ' is token-built')
  }
  const field = css.slice(
    css.indexOf('.mem-panel .mem-search-field{'),
    css.indexOf('}', css.indexOf('.mem-panel .mem-search-field{')),
  )
  assert.ok(field.includes('height:40px'), 'the shell field is 40px tall')
  assert.match(field, /border-radius:\s*10px/u, 'the shell field is a 10px rounded box')
})

test('every class the redesigned views consume is styled in the one stylesheet', async () => {
  const { script } = await bundle()
  const css = panelCss(script)
  const hooks = [
    'mem-panel',
    'mem-display',
    'mem-tabbar',
    'mem-tabbar-meta',
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
  for (const action of ['.mem-sheet-confirm', '.mem-sheet-cancel']) {
    const start = css.indexOf('.mem-panel ' + action + '{')
    assert.ok(start >= 0, 'the sheet styles ' + action)
    const rule = css.slice(start, css.indexOf('}', start))
    assert.ok(rule.includes('min-height:44px'), action + ' keeps its 44px hit area')
  }
  assert.ok(css.includes('grid-template-columns:repeat(2,minmax(0,1fr))'), 'overflow folds to 2x2')
  assert.ok(css.includes('-webkit-line-clamp:2'), 'snippets clamp to two lines')
})

test('the panel keeps a visible focus ring, one clear control and passive cells', async () => {
  const { script } = await bundle()
  const css = panelCss(script)
  assert.equal(
    css.includes('outline:none'),
    false,
    'the search input does not suppress the global focus ring',
  )
  assert.ok(css.includes(':focus-within'), 'the search field still tracks focus')
  assert.ok(
    css.includes(
      '.mem-panel .mem-search-input::-webkit-search-cancel-button{-webkit-appearance:none;display:none}',
    ),
    'the Chromium search clear affordance is suppressed',
  )
  const passive = css.indexOf('.mem-panel .mem-summary-item{')
  assert.ok(passive >= 0, 'the passive summary cells stay styled')
  const summary = css.slice(passive, css.indexOf('}', passive))
  assert.equal(
    summary.includes('cursor:pointer'),
    false,
    'a passive summary cell does not claim a click',
  )
  assert.equal(
    css.includes('.mem-summary-item:hover'),
    false,
    'a passive summary cell has no hover lift',
  )
  // The metadata rules that actually carry a line of CJK text sit on the CJK
  // line-height floor. `mem-tabbar-meta` is the flex slot around that text, not a
  // text rule of its own, so it is not in this list.
  for (const hook of ['mem-clock', 'mem-viewhead-meta', 'mem-label']) {
    const start = css.indexOf('.mem-panel .' + hook + '{')
    assert.ok(start >= 0, 'the metadata rule exists: ' + hook)
    const rule = css.slice(start, css.indexOf('}', start))
    assert.ok(rule.includes('line-height:1.6'), hook + ' sits on the CJK line-height floor')
  }
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
