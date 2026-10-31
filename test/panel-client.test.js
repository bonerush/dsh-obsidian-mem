import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'

const source = () => readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
/** The served views — the producer side of the class-coverage contract below. */
const viewsSource = () => readFile(new URL('../lib/memory-panel.js', import.meta.url), 'utf8')

/**
 * Drop `//` and block comments while respecting string quotes. The class
 * extraction below must not be satisfied by a class named only in a comment, and
 * — measured — matching quotes across an unstripped comment desynchronises on an
 * apostrophe and finds 67 of the views' 108 classes instead of 108. The views
 * compose some class names at runtime (`'mem-heat-cell is-l' + level`,
 * `'mem-flow-swatch ' + level`, `span('mem-stamp' + …)`), so the extraction
 * splits a quoted literal on spaces and keeps the `mem-*` token; the composed
 * suffixes (`is-l1`, `is-created`, …) are stylesheet variants, covered by the
 * variant assertions in the same test.
 */
function stripComments(text) {
  let stripped = ''
  let index = 0
  let quote = null
  while (index < text.length) {
    const char = text[index]
    if (quote !== null) {
      stripped += char
      if (char === '\\') {
        stripped += text[index + 1] ?? ''
        index += 2
        continue
      }
      if (char === quote) quote = null
      index += 1
      continue
    }
    if (char === '/' && text[index + 1] === '/') {
      while (index < text.length && text[index] !== '\n') index += 1
      continue
    }
    if (char === '/' && text[index + 1] === '*') {
      index += 2
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) index += 1
      index += 2
      continue
    }
    if (char === "'" || char === '"' || char === '`') quote = char
    stripped += char
    index += 1
  }
  return stripped
}

/**
 * The shell's React stand-in. The bundle only receives React through
 * `require('react')`, so a test supplies it. Most tests below need
 * `createElement` alone and scan the source; the behavioural shell tests mount
 * the shell's own components, which use state and refs, so this stand-in keeps
 * one component's state across renders the way the host's renderer does. It is
 * the same hook shape test/panel-ui.test.js uses for the served views — the
 * suite has no React dependency to test the shell against otherwise.
 */
function shellReact() {
  const slots = new Map()
  let current = null
  let cursor = 0
  const slot = () => {
    let state = slots.get(current)
    if (state === undefined) slots.set(current, (state = { values: [] }))
    return state
  }
  return {
    React: {
      createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
      useState(initial) {
        const { values } = slot()
        const index = cursor++
        // React calls a function initializer instead of storing it; GraphView
        // passes `initialGroups` that way, so the stand-in has to as well.
        if (!(index in values)) values[index] = typeof initial === 'function' ? initial() : initial
        return [
          values[index],
          (next) => {
            values[index] = typeof next === 'function' ? next(values[index]) : next
          },
        ]
      },
      useRef(initial) {
        const { values } = slot()
        const index = cursor++
        if (!(index in values)) values[index] = { current: initial }
        return values[index]
      },
      // The shell's two effects are the stylesheet injection (this context has no
      // `document`) and the served-module import (the vm has no dynamic-import
      // hook). Neither can run here and no assertion below reads them, so the hook
      // is counted for the cursor and nothing else.
      useEffect() {
        cursor += 1
      },
      // GraphView and GraphCanvas memoize their filtered graph and styling; the
      // stand-in recomputes on every render instead, which is what these tests read.
      useMemo(factory) {
        return factory()
      },
    },
    render(component, props) {
      current = component
      cursor = 0
      return component(props)
    },
  }
}

/** Register the bundle the way the host does, and return its factory exports. */
async function bundle(react = shellReact().React, globals = {}) {
  const script = await source()
  let module
  const window = {
    __ModuleLoader__: {
      load(value) {
        module = value
      },
    },
  }
  runInNewContext(script, { window, ...globals })
  assert.equal(module.id, 'dsh-obsidian-mem')
  const exports = module.factory((name) => {
    assert.equal(name, 'react')
    return react
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

/**
 * Every element in a rendered tree, depth-first. Function components are left as
 * elements — call one through the runtime when its output is what you assert.
 */
function nodes(tree) {
  const found = []
  const visit = (value) => {
    for (const node of Array.isArray(value) ? value.flat(Infinity) : [value]) {
      if (node === null || typeof node !== 'object') continue
      found.push(node)
      visit(node.props?.children ?? [])
    }
  }
  visit(tree)
  return found
}

const component = (tree, name) =>
  nodes(tree).find((node) => typeof node.type === 'function' && node.type.name === name)
const byRole = (tree, role) => nodes(tree).find((node) => node.props?.role === role)
const byClass = (tree, className) =>
  nodes(tree).filter(
    (node) =>
      typeof node.props?.className === 'string' &&
      node.props.className.split(' ').includes(className),
  )

/**
 * Mount the shell the way the host does: register the tab, then call the panel
 * component the tab renders through the hook stand-in. `render` re-renders it
 * against the same state, which is how a test sees a state change land.
 */
async function mountShell(sessionId = 'session-shell', globals = {}) {
  const shell = shellReact()
  const { script, exports } = await bundle(shell.React, globals)
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
  const panel = tab.component({ scope: { sessionId }, visible: true })
  return {
    script,
    shell,
    tab,
    render: (overrides) => shell.render(panel.type, { sessionId, visible: true, ...overrides }),
  }
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
  assert.equal(view.props.sessionId, 'session-case')
  assert.equal(view.props.visible, true)
  ctx.dispose()
  assert.equal(tab, undefined)
})

test('the shell loads the one served module and passes React into it', async () => {
  const { script } = await bundle()
  assert.ok(
    script.includes("import('/obsidian-mem/memory-panel.js')"),
    'dynamic import of the served module',
  )
  // The served module's factory runs behind that dynamic import, and a vm context
  // has no dynamic-import hook to resolve it, so this is source-shape by
  // necessity: it pins the wiring rather than a renamed substring. The argument
  // handed to `createMemoryViews` must be the bundle's own `React` binding — the
  // object `require('react')` returned — not a second global or a re-require.
  assert.match(script, /const React = require\('react'\)/u, 'React comes through require')
  assert.match(
    script,
    /createMemoryViews\(\{\s*React,\s*locale\s*\}\)/u,
    'the served factory receives React and the resolved locale',
  )
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
  const { shell, render } = await mountShell()
  const strip = (overrides = {}) => {
    const element = component(render(), 'MemoryTabs')
    assert.ok(element, 'the shell renders the strip')
    return shell.render(element.type, { ...element.props, ...overrides })
  }
  const tabs = (tree) => nodes(tree).filter((node) => node.props?.role === 'tab')
  const selected = (tree) => tabs(tree).map((node) => node.props['aria-selected'])
  const selectedIndex = () => selected(strip()).indexOf(true)

  let tree = strip()
  assert.equal(nodes(tree).filter((node) => node.props?.role === 'tablist').length, 1)
  assert.deepEqual(
    tabs(tree).map((node) => node.props.id),
    ['obsidian-mem-tab-overview', 'obsidian-mem-tab-graph', 'obsidian-mem-tab-health'],
    'three tabs, 检索 is no longer one of them',
  )
  assert.deepEqual(selected(tree), [true, false, false], 'the mounted view is the selected tab')
  assert.deepEqual(
    tabs(tree).map((node) => node.props.tabIndex),
    [0, -1, -1],
    'roving tabindex: only the selected tab is in the tab order',
  )

  // Roving state is a prop: selecting another tab moves both markers with it.
  tree = strip({ value: 'graph' })
  assert.deepEqual(selected(tree), [false, true, false])
  assert.deepEqual(
    tabs(tree).map((node) => node.props.tabIndex),
    [-1, 0, -1],
  )

  // Keyboard navigation is behaviour, not a source marker: each key must move the
  // shell's selection and the focus, and unhandled keys must leave both alone.
  const focused = []
  const press = (key, index) => {
    const buttons = tabs(strip())
    buttons.forEach((button, position) => {
      button.props.ref({ focus: () => focused.push(position) })
    })
    let prevented = false
    buttons[index].props.onKeyDown({
      key,
      preventDefault: () => {
        prevented = true
      },
    })
    return prevented
  }
  const cases = [
    ['End', 0, 2],
    ['Home', 2, 0],
    ['ArrowRight', 0, 1],
    ['ArrowLeft', 0, 2],
    ['ArrowRight', 2, 0],
    ['ArrowLeft', 2, 1],
  ]
  for (const [key, from, to] of cases) {
    focused.length = 0
    assert.equal(press(key, from), true, key + ' is consumed by the tablist')
    assert.equal(selectedIndex(), to, key + ' selects view ' + to)
    assert.deepEqual(focused, [to], key + ' moves focus to view ' + to)
  }
  focused.length = 0
  assert.equal(press('Tab', 0), false, 'an unhandled key is not consumed')
  assert.equal(selectedIndex(), 1, 'an unhandled key leaves the selection alone')
  assert.deepEqual(focused, [], 'an unhandled key leaves the focus alone')
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
  const { script, shell, render } = await mountShell()
  const panel = () => byRole(render(), 'tabpanel')
  assert.ok(panel(), 'the shell mounts one panel')
  assert.equal(nodes(render()).filter((node) => node.props?.role === 'tabpanel').length, 1)
  assert.equal(
    panel().props.id,
    'obsidian-mem-panel',
    'the one mounted panel carries the id the tabs name',
  )
  assert.equal(
    panel().props['aria-labelledby'],
    'obsidian-mem-tab-overview',
    'the panel is labelled by the selected tab',
  )
  const tabs = () => {
    const element = component(render(), 'MemoryTabs')
    return nodes(shell.render(element.type, element.props)).filter(
      (node) => node.props?.role === 'tab',
    )
  }
  for (const tab of tabs())
    assert.equal(tab.props['aria-controls'], panel().props.id, 'every tab points at that panel')
  // A tab click answers in the shell's state: the mounted panel relabels itself
  // for the new view, so the `aria-controls`/`aria-labelledby` pair stays live.
  const graph = tabs().find((node) => node.props.id === 'obsidian-mem-tab-graph')
  graph.props.onClick()
  assert.equal(panel().props['aria-labelledby'], 'obsidian-mem-tab-graph', 'the panel follows')
  assert.deepEqual(
    tabs().map((node) => node.props['aria-selected']),
    [false, true, false],
  )
  // The retired per-view panel ids stay retired; the behaviour above only proves
  // the one panel exists, so this keeps "a second panel per view" from returning.
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

test('the graph keeps its canvas and counts what it drew instead of truncating', async () => {
  const { script } = await bundle()
  assert.ok(script.includes("role: 'img', tabIndex: 0"), 'the canvas is still the graph')
  assert.ok(
    script.includes("import('/obsidian-mem/graph-renderer.js')"),
    'the renderer is unchanged',
  )
  // 图谱 draws every node in scope: a "first N nodes" notice is the defect the
  // change removed, so the panel must not carry the vocabulary for it either.
  assert.equal(script.includes('graph.truncated'), false, 'no truncation state is rendered')
  assert.equal(script.includes('仅显示前 '), false, 'the old partial-projection sentence is gone')
  assert.ok(script.includes('graph-count'), 'the drawn count is stated instead')
  assert.ok(script.includes("' 个节点 · '"), 'the count names the node total')
  assert.ok(script.includes("' 条连接'"), 'and the edge total beside it')
  // The route, not the client, is where a cap used to live: pin that it asks for the
  // unscoped projection, because a reintroduced limit would silently hide nodes.
  const route = await readFile(new URL('../lib/graph-route.js', import.meta.url), 'utf8')
  assert.ok(route.includes('index.graph({ scope })'), 'the route requests the whole graph')
  assert.equal(/index\.graph\(\{\s*scope,\s*limit/.test(route), false, 'no cap is passed')
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

test('the bundle reads only host tokens on the measured allowlist', async () => {
  const { script } = await bundle()
  const css = panelCss(script)
  // MEASURED 2026-10-29 against the installed DSH build at
  //   C:/Users/bonerush/AppData/Local/Programs/DeepSeek Harness/resources/app.asar
  //   (182,434,783 bytes), where the host defines 405 `--dsw-*:` names. Command shape:
  //   grep -a -o -- '--dsw-[a-z0-9-]*:' '<app.asar>' | sort -u     # -> 405 names
  //   grep -a -o -- '--dsw-font-xs-regular-13:' '<app.asar>'       # -> 0 matches
  // The second command is why this guard exists: the search input's `font:`
  // shorthand once named `--dsw-font-xs-regular-13`, a token this host build does
  // not define, so the shorthand was invalid at computed-value time and the input
  // silently inherited 12px. The host's real 13px token is
  // `--dsw-font-xs-13:13px/20px var(--dsw-font-family)`.
  //
  // CI has no host build to measure against, so this allowlist is a reviewed
  // decision in the same posture as the architecture LAYERS/BUDGETS tables: a name
  // is added only after it is checked against a host build, and its entry is
  // deleted when the stylesheet stops reading it. The scan covers both stylesheet
  // strings in the bundle — the graph token block (3 of these names) and the marked
  // panel sheet (21) — which is exactly the set the measurement cross-checked.
  const verified = [
    '--dsw-alias-bg-base',
    '--dsw-alias-bg-layer-1',
    '--dsw-alias-bg-layer-2',
    '--dsw-alias-bg-overlay',
    '--dsw-alias-border-l1',
    '--dsw-alias-border-l2',
    '--dsw-alias-interactive-bg-hover',
    '--dsw-alias-label-dimmed',
    '--dsw-alias-label-primary',
    '--dsw-alias-label-secondary',
    '--dsw-alias-label-tertiary',
    '--dsw-alias-link',
    '--dsw-alias-state-business-primary',
    '--dsw-alias-state-error-primary',
    '--dsw-alias-state-success-primary',
    '--dsw-alias-state-warn-primary',
    '--dsw-font-s-strong-14',
    '--dsw-font-xs-13',
    '--dsw-font-xxs-12',
    '--dsw-font-xxs-strong-12',
    '--dsw-font-xxxs-11',
    '--dsw-font-xxxs-strong-11',
    '--dsw-shadow-lv1',
    '--dsw-shadow-lv3',
  ]
  const used = [
    ...new Set([...script.matchAll(/var\((--dsw-[a-z0-9-]+)/gu)].map((match) => match[1])),
  ].sort()
  const unverified = used.filter((name) => !verified.includes(name))
  assert.deepEqual(
    unverified,
    [],
    'host tokens the stylesheet reads but has not been verified against: ' + unverified.join(', '),
  )
  const stale = verified.filter((name) => !used.includes(name))
  assert.deepEqual(
    stale,
    [],
    'allowlist entries the stylesheet no longer uses: ' + stale.join(', '),
  )
  // The one defect this guard was born from, pinned by name: the allowlist alone
  // would accept any other verified token, so the search field's size is asserted
  // at the declaration that broke.
  const input = css.slice(
    css.indexOf('.mem-panel .mem-search-input{'),
    css.indexOf('}', css.indexOf('.mem-panel .mem-search-input{')),
  )
  assert.ok(
    input.includes('font:var(--dsw-font-xs-13)'),
    'the search input uses the host 13px shorthand',
  )
})

test('the heat map is a fixed 10px GitHub-style calendar in its own scroll box', async () => {
  const { script } = await bundle()
  const css = panelCss(script)
  // A fixed calendar, not a fluid one: 10px cells on a 2px gap are the same size at
  // every panel width. When the panel is narrower than the calendar the chart scrolls
  // inside its own box, so the page itself never grows a horizontal scrollbar (the
  // round-3 defect: cells shrank into stripes to fit instead).
  const scrollStart = css.indexOf('.mem-panel .mem-heat-scroll{')
  assert.ok(scrollStart >= 0, 'the heat scroll box rule exists')
  const scrollRule = css.slice(scrollStart, css.indexOf('}', scrollStart))
  assert.ok(scrollRule.includes('overflow-x:auto'), 'the calendar scrolls inside its own box')
  assert.equal(scrollRule.includes('overflow-y:auto'), false, 'it is a horizontal scroll only')
  assert.ok(scrollRule.includes('scrollbar-width:thin'), 'a thin scrollbar for the calendar')
  const gridStart = css.indexOf('.mem-panel .mem-heat-grid{')
  assert.ok(gridStart >= 0, 'the heat grid rule exists')
  const gridRule = css.slice(gridStart, css.indexOf('}', gridStart))
  for (const declaration of [
    'grid-template-rows:repeat(7,10px)',
    'grid-auto-flow:column',
    'grid-auto-columns:10px',
    'gap:2px',
  ])
    assert.ok(gridRule.includes(declaration), 'the fixed grid declares ' + declaration)
  assert.equal(/minmax\(0,1fr\)/u.test(gridRule), false, 'no width-sharing columns')
  const cellStart = css.indexOf('.mem-panel .mem-heat-cell{')
  assert.ok(cellStart >= 0, 'the heat cell rule exists')
  const cellRule = css.slice(cellStart, css.indexOf('}', cellStart))
  assert.ok(cellRule.includes('width:10px'), 'a heat cell is a fixed 10px: ' + cellRule)
  assert.ok(cellRule.includes('height:10px'), 'and a fixed 10px tall')
  assert.equal(cellRule.includes('aspect-ratio'), false, 'a fixed-size cell needs no aspect ratio')
  // The weekday gutter rides inside the scroll box and sticks to its left edge.
  const weekdaysStart = css.indexOf('.mem-panel .mem-heat-weekdays{')
  assert.ok(weekdaysStart >= 0, 'the weekday gutter rule exists')
  const weekdaysRule = css.slice(weekdaysStart, css.indexOf('}', weekdaysStart))
  assert.ok(weekdaysRule.includes('position:sticky'), 'the weekday labels stick: ' + weekdaysRule)
  assert.ok(weekdaysRule.includes('left:0'))
  assert.ok(
    weekdaysRule.includes('background:var(--dsw-alias-bg-base)'),
    'the sticky gutter paints over the cells it covers',
  )
  const frameStart = css.indexOf('.mem-panel .mem-heat-frame{')
  assert.ok(frameStart >= 0, 'the frame rule exists')
  const frameRule = css.slice(frameStart, css.indexOf('}', frameStart))
  assert.ok(frameRule.includes('grid-template-columns:14px auto'), '14px gutter + auto grid')
  // Month labels above the columns, and the styled tooltip above the cell.
  const monthsStart = css.indexOf('.mem-panel .mem-heat-months{')
  assert.ok(monthsStart >= 0, 'the months row rule exists')
  assert.ok(css.slice(monthsStart, css.indexOf('}', monthsStart)).includes('position:relative'))
  const monthStart = css.indexOf('.mem-panel .mem-heat-month{')
  assert.ok(monthStart >= 0, 'the month label rule exists')
  assert.ok(css.slice(monthStart, css.indexOf('}', monthStart)).includes('position:absolute'))
  const tipStart = css.indexOf('.mem-panel .mem-heat-tip{')
  assert.ok(tipStart >= 0, 'the styled tooltip rule exists')
  const tipRule = css.slice(tipStart, css.indexOf('}', tipStart))
  assert.ok(tipRule.includes('position:absolute'), 'the tooltip floats over the cell: ' + tipRule)
  assert.ok(tipRule.includes('pointer-events:none'), 'the tooltip never steals the hover')
  // The scroll box gets the same thin, token-built scrollbar as the view body.
  assert.ok(
    css.includes('.mem-panel .mem-heat-scroll::-webkit-scrollbar{height:8px'),
    'the webkit heat scrollbar is 8px',
  )
})

test('the heat map keeps the blue business-primary ramp, token-only', async () => {
  const { script } = await bundle()
  const css = panelCss(script)
  for (const level of [
    'color-mix(in srgb,var(--dsw-alias-state-business-primary) 28%,transparent)',
    'color-mix(in srgb,var(--dsw-alias-state-business-primary) 50%,transparent)',
    'color-mix(in srgb,var(--dsw-alias-state-business-primary) 72%,transparent)',
    'color-mix(in srgb,var(--dsw-alias-state-business-primary) 92%,transparent)',
  ])
    assert.ok(css.includes(level), 'the ramp keeps ' + level)
  assert.ok(
    css.includes('color-mix(in srgb,var(--dsw-alias-label-secondary) 16%,transparent)'),
    'the empty cell is the label-secondary 16% mix',
  )
  // The token-only contract is asserted for the whole sheet elsewhere; this pins the
  // heat map's own slice while it was redrawn, since it is the most colour-heavy block.
  const heat = css.slice(css.indexOf('.mem-heat-scroll{'), css.indexOf('.mem-panel .mem-flow{'))
  assert.ok(heat.length > 0, 'the heat slice is present')
  assert.equal(/#[0-9a-f]{3,8}\b/iu.test(heat), false, 'no hex in the heat rules')
  assert.equal(/\brgba?\(/u.test(heat), false, 'no rgb() in the heat rules')
  assert.equal(/\bhsla?\(/u.test(heat), false, 'no hsl() in the heat rules')
})

test('最近变化 is a token-built activity rail, and the flat list rules are gone', async () => {
  const { script } = await bundle()
  const css = panelCss(script)
  // The rail: one continuous 1px border-token line through the 12px node column.
  const groupStart = css.indexOf('.mem-panel .mem-timeline-group{')
  assert.ok(groupStart >= 0, 'the timeline group rule exists')
  const groupRule = css.slice(groupStart, css.indexOf('}', groupStart))
  assert.ok(
    groupRule.includes('grid-template-columns:12px minmax(0,1fr)'),
    'node column + body: ' + groupRule,
  )
  const railStart = css.indexOf('.mem-panel .mem-timeline-group::before{')
  assert.ok(railStart >= 0, 'the rail pseudo-element exists')
  const railRule = css.slice(railStart, css.indexOf('}', railStart))
  assert.ok(railRule.includes('width:1px'), 'the rail is a hairline: ' + railRule)
  // border-l1 is rgba(0,0,0,.04) on the host's light theme — measured invisible in the
  // round-4 capture. A 22% label-secondary mix is still token-only and reads as one
  // continuous hairline on both themes.
  assert.ok(
    railRule.includes(
      'background:color-mix(in srgb,var(--dsw-alias-label-secondary) 22%,transparent)',
    ),
    'the rail is a visible token-only hairline: ' + railRule,
  )
  assert.equal(railRule.includes('--dsw-alias-border-l1'), false, 'not the 4% border token')
  assert.ok(railRule.includes('bottom:0'), 'the rail continues into the next group')
  const nodeStart = css.indexOf('.mem-panel .mem-timeline-node{')
  assert.ok(nodeStart >= 0, 'the node rule exists')
  const nodeRule = css.slice(nodeStart, css.indexOf('}', nodeStart))
  assert.ok(nodeRule.includes('width:12px') && nodeRule.includes('height:12px'), 'a 12px node')
  assert.ok(nodeRule.includes('border-radius:16px'), 'the node is a circle')
  assert.ok(
    nodeRule.includes('background:var(--dsw-alias-state-business-primary)'),
    'the node is a filled accent circle',
  )
  assert.ok(
    nodeRule.includes('border:2px solid var(--dsw-alias-bg-base)'),
    'a bg-base ring separates the node from the rail',
  )
  const dotStart = css.indexOf('.mem-panel .mem-timeline-dot{')
  assert.ok(dotStart >= 0, 'the item dot rule exists')
  const dotRule = css.slice(dotStart, css.indexOf('}', dotStart))
  assert.ok(dotRule.includes('width:6px') && dotRule.includes('height:6px'), 'a 6px item dot')
  // Retired rules must be gone from BOTH sides: a stale rule is dead CSS, and a test
  // that only checked the markup would never notice it.
  for (const retired of ['.mem-panel .mem-recent{', '.mem-panel .mem-dot{'])
    assert.equal(css.includes(retired), false, 'retired rule is gone: ' + retired)
  assert.equal(script.includes('mem-recent-row'), false, 'and its markup with it')
})

test('the panel POST and the route fence share one same-origin header name', async () => {
  // Two files own the two halves of the fence: the served browser module sends the
  // header, and lib/panel-route.js accepts it when the desktop proxy stripped Origin.
  // They cannot import each other (the served module is standalone), so the literals
  // are pinned from BOTH sources here — a rename on either side fails this test
  // instead of only a live 403 in the desktop app.
  const client = await viewsSource()
  const route = await readFile(new URL('../lib/panel-route.js', import.meta.url), 'utf8')
  const nameIn = (text) => /'(x-obsidian-mem-panel)'/u.exec(text)?.[1] ?? null
  const valueIn = (text) => /PANEL_HEADER_VALUE\s*=\s*'([^']+)'/u.exec(text)?.[1] ?? null
  const clientName = nameIn(client)
  const routeName = nameIn(route)
  assert.equal(clientName, 'x-obsidian-mem-panel', 'the served module sends the header literal')
  assert.equal(routeName, clientName, 'the route accepts the same literal it is sent')
  assert.equal(valueIn(client), '1', 'the served module sends the value 1')
  assert.ok(routeName, 'the route half has landed (a missing literal is the failure to fix)')
  assert.equal(valueIn(route), valueIn(client), 'both halves agree on the value')
})

test('the composed overview starts on the body inset, not on a doubled margin', async () => {
  const { script } = await bundle()
  const css = panelCss(script)
  // 概览's first block in the composed shell has no view head above it: the shell
  // passes `onMeta`, so the view drops its own heading and the KPI band is the
  // first thing the body paints. The band's `margin-top:14px` belongs to the
  // standalone layout (a view head or project card above it); left in the composed
  // layout it doubles the body inset — measured 42px from the search field to the
  // KPI card instead of the 28px 健康 and 检索 start from. The first block is
  // zeroed; every later KPI band keeps its separation.
  assert.ok(
    css.includes(
      '.mem-panel .mem-view>.mem-ledger>.mem-block:first-child>.mem-kpiline{margin-top:0}',
    ),
    "the composed overview zeroes the first KPI band's standalone top margin",
  )
  const start = css.indexOf('.mem-panel .mem-kpiline{')
  assert.ok(start >= 0, 'the KPI band rule exists')
  const rule = css.slice(start, css.indexOf('}', start))
  assert.ok(
    rule.includes('margin-top:14px'),
    'every non-first KPI band keeps the standalone separation',
  )
  // Round 2 left 28px from the search field to the first content (10px search-row
  // padding + 18px body inset); the user asked for 16–20px, so the body's top inset
  // dropped to 8px. The two declarations that compose the gap are asserted as a sum:
  // the number the user sees is the contract, not either padding alone.
  const searchStart = css.indexOf('.mem-panel > .mem-searchbar{')
  assert.ok(searchStart >= 0, 'the shell search row rule exists')
  const searchRule = css.slice(searchStart, css.indexOf('}', searchStart))
  const searchPadding = /padding:(\d+)px (\d+)px (\d+)px/u.exec(searchRule)
  assert.ok(searchPadding, 'the search row declares the three-value padding: ' + searchRule)
  const viewStart = css.indexOf('.mem-panel .mem-view{')
  assert.ok(viewStart >= 0, 'the view body rule exists')
  const viewRule = css.slice(viewStart, css.indexOf('}', viewStart))
  const viewPadding = /padding:(\d+)px (\d+)px (\d+)px/u.exec(viewRule)
  assert.ok(viewPadding, '.mem-view declares the three-value padding: ' + viewRule)
  const gap = Number(searchPadding[3]) + Number(viewPadding[1])
  assert.ok(gap >= 16 && gap <= 20, 'search field to first content is ' + gap + 'px (target 16–20)')
})

test('every KPI cell centres its content and the sparkline stays a bounded shape', async () => {
  const { script } = await bundle()
  const css = panelCss(script)
  const start = css.indexOf('.mem-panel .mem-kpi{')
  assert.ok(start >= 0, 'the KPI cell rule exists')
  const rule = css.slice(start, css.indexOf('}', start))
  // The four cells are equal quarters of the band. Left-aligned content pinned each
  // reading to its quarter's left edge and left the wide panel's right side empty
  // (measured 87px of unused content width in the 659px band's 记忆条目 cell), so the
  // rows are centred. The quarter dividers stay.
  assert.ok(rule.includes('align-items:center'), 'the cell rows share one centre line: ' + rule)
  const sparkStart = css.indexOf('.mem-panel .mem-kpi-spark{')
  assert.ok(sparkStart >= 0, 'the sparkline rule exists')
  const sparkRule = css.slice(sparkStart, css.indexOf('}', sparkStart))
  assert.ok(sparkRule.includes('width:100%'), 'the shape may use the cell: ' + sparkRule)
  assert.ok(
    /max-width:120px/u.test(sparkRule),
    'and stops growing on a wide cell so it stays a shape, not a rule: ' + sparkRule,
  )
})

test('the tab strip is a Chrome-like row: separate roomy leaves, the active page merged', async () => {
  const { script } = await bundle()
  const css = panelCss(script)
  assert.equal(
    /grid-template-columns/iu.test(
      css.slice(css.indexOf('.mem-tabs{'), css.indexOf('}', css.indexOf('.mem-tabs{')) + 1),
    ),
    false,
    '.mem-tabs is not a grid',
  )
  // Chrome's tab strip separates its tabs instead of folding them into one another:
  // a 2px gap, a roomier leaf (36px tall, up to 180px wide) and a 16px glyph. The
  // active leaf still merges into the content surface below the strip.
  const tabs = css.slice(
    css.indexOf('.mem-panel .mem-tabs{'),
    css.indexOf('}', css.indexOf('.mem-panel .mem-tabs{')) + 1,
  )
  for (const marker of ['display:flex', 'gap:2px'])
    assert.ok(tabs.includes(marker), 'the tab row declares ' + marker)
  assert.equal(css.includes('margin-left:-8px'), false, 'tabs no longer overlap')
  // The strip's background and bottom rule belong to the row that carries both the
  // leaves and the freshness tail (`mem-tabbar`), not to the tablist.
  const bar = css.slice(
    css.indexOf('.mem-panel .mem-tabbar{'),
    css.indexOf('}', css.indexOf('.mem-panel .mem-tabbar{')) + 1,
  )
  for (const marker of [
    'background:var(--dsw-alias-bg-layer-1)',
    'border-bottom:1px solid var(--dsw-alias-border-l1)',
    'padding:8px 14px 0',
    'display:flex',
  ])
    assert.ok(bar.includes(marker), 'the top bar declares ' + marker)
  for (const marker of [
    'height:36px',
    'padding:0 14px',
    'max-width:180px',
    'margin-bottom:-1px',
    'border-radius:10px 10px 0 0',
    'border-bottom-color:var(--dsw-alias-bg-base)',
    'background:var(--dsw-alias-bg-base)',
    'box-shadow:var(--dsw-shadow-lv1)',
    'text-overflow:ellipsis',
    'transition:background-color 150ms ease,color 150ms ease',
  ])
    assert.ok(css.includes(marker), 'the tab leaf contains ' + marker)
  assert.ok(
    css.includes('.mem-tab[aria-selected="true"]'),
    'the selected tab is the content surface',
  )
  assert.ok(css.includes('z-index:2'), 'the active tab rides above the strip rule')
  assert.ok(css.includes('min-width:0'), 'tabs may truncate instead of overflowing')
  assert.ok(tabs.includes('flex-wrap:nowrap'), 'the leaves stay on one row')
  // Nothing at the page level scrolls sideways. Two measured drawings are the
  // exceptions, and each scrolls inside its own box: the fixed heat calendar and
  // the composition Sankey, whose English labels are too wide to shrink without
  // truncating them. That split is what keeps a 634px calendar and a full-label
  // Sankey usable in a 320px panel without the body gaining a scrollbar.
  const sideways = [...css.matchAll(/([^{}]+)\{[^}]*overflow-x:(?:auto|scroll)/gu)].map((match) =>
    match[1].split('\n').at(-1).trim().replace(/^'|'$/gu, ''),
  )
  assert.deepEqual(
    sideways,
    ['.mem-panel .mem-heat-scroll', '.mem-panel .mem-sankey-scroll'],
    'only the heat calendar and the Sankey scroll sideways, each inside its own box',
  )
  for (const marker of ['flex:0 1 auto', 'align-items:flex-end'])
    assert.ok(css.includes(marker), 'the tab row contains ' + marker)
  // The 44px click target is the strip's 8px top padding plus the 36px leaf: the
  // leaf extends its own hit area upward by that padding so the whole 44px is
  // clickable, while the drawn leaf stays 36px tall.
  assert.ok(css.includes('top:-8px'), 'the leaf extends its own hit area upward')
  assert.ok(css.includes('bottom:0'), 'the hit extension reaches the content surface')
  assert.ok(
    css.includes('.mem-tab:hover{background:var(--dsw-alias-interactive-bg-hover)'),
    'the resting leaf lifts on hover',
  )
  const icon = css.slice(
    css.indexOf('.mem-tab-icon{'),
    css.indexOf('}', css.indexOf('.mem-tab-icon{')) + 1,
  )
  assert.ok(icon.includes('width:16px') && icon.includes('height:16px'), 'the glyph is 16px')
  // The narrow-panel step is 374px, not 359: measured, the 359 breakpoint made 360px
  // WORSE than 359px, because the icon came back and ate 22px of a strip that gained
  // only 6 (label widths 19/24 at 360 against 24/24 at 359). The step also tightens
  // the leaves' padding and the row's gap, which is what clears truncation across
  // the whole 280-374 band instead of only below it.
  for (const marker of [
    '@container (max-width:374px)',
    '.mem-tab-icon{display:none}',
    '.mem-tab{padding:0 8px;gap:4px}',
  ])
    assert.ok(css.includes(marker), 'the narrow-panel step contains ' + marker)
  assert.equal(
    css.includes('@container (max-width:359px)'),
    false,
    'the 359 step is gone: it was the defect, not the fallback',
  )
})

test('the shell keeps one persistent search box between the tab strip and the view body', async () => {
  const { script, shell, render } = await mountShell('session-search')
  const panel = () => render()
  const boxElement = (tree = panel()) => component(tree, 'SearchBox')
  const boxTree = (overrides = {}) => {
    const element = boxElement()
    assert.ok(element, 'the shell renders the search box itself, not a view')
    return shell.render(element.type, { ...element.props, ...overrides })
  }
  const input = () => byClass(boxTree(), 'mem-search-input')[0]
  const form = (tree = boxTree()) => nodes(tree).find((node) => node.type === 'form')

  // The box is shell chrome: one form directly between the strip and the one view
  // body, so it survives every tab and a tab only replaces the mounted view.
  const tree = panel()
  const positioned = nodes(tree)
  const stripNode = component(tree, 'MemoryTabs')
  const boxNode = boxElement(tree)
  assert.ok(positioned.indexOf(stripNode) < positioned.indexOf(boxNode), 'tab strip → search box')
  assert.ok(
    positioned.indexOf(boxNode) < positioned.indexOf(byRole(tree, 'tabpanel')),
    'search box → the one tabpanel',
  )
  assert.equal(form().props.className, 'mem-searchbar')
  const box = boxTree()
  assert.equal(nodes(box).filter((node) => node.props?.role === 'search').length, 1)
  for (const hook of [
    'mem-search-field',
    'mem-search-icon',
    'mem-search-input',
    'mem-search-submit',
  ])
    assert.equal(byClass(box, hook).length, 1, 'the box has one ' + hook)
  assert.equal(byClass(box, 'mem-search-clear').length, 0, 'no clear control while empty')

  // The shell owns the draft: typing is one shell state change and the field is
  // controlled by it — the box never grows a state of its own.
  input().props.onChange({ target: { value: '绑定' } })
  assert.equal(boxElement().props.value, '绑定', 'typing updates the shell-owned draft')
  assert.equal(input().props.value, '绑定', 'the field renders that draft back')
  assert.equal(byClass(boxTree(), 'mem-search-clear').length, 1, 'the clear control appears')

  // Escape is one of the three exits: it empties the field.
  let prevented = 0
  input().props.onKeyDown({
    key: 'Escape',
    preventDefault: () => {
      prevented += 1
    },
  })
  assert.equal(prevented, 1, 'Escape is consumed by the box')
  assert.equal(boxElement().props.value, '', 'Escape empties the shell-owned draft')
  assert.equal(byClass(boxTree(), 'mem-search-clear').length, 0)

  // The clear control is the same exit and hands the caret back to the field.
  input().props.onChange({ target: { value: 'x' } })
  let focused = 0
  input().props.ref.current = {
    focus: () => {
      focused += 1
    },
  }
  byClass(boxTree(), 'mem-search-clear')[0].props.onClick()
  assert.equal(focused, 1, 'the clear control hands focus back to the field')
  assert.equal(boxElement().props.value, '', 'the clear control empties the draft too')

  // Clicking anywhere in the field puts the caret in the input: the icon and the
  // padding are part of one control, not decoration. A click that starts on a
  // button (the clear control) is excluded — it owns its own focus handoff.
  let fieldFocused = 0
  input().props.ref.current = {
    focus: () => {
      fieldFocused += 1
    },
  }
  const field = () => byClass(boxTree(), 'mem-search-field')[0]
  field().props.onClick({ target: { closest: () => null } })
  assert.equal(fieldFocused, 1, 'a click on the field focuses the input')
  field().props.onClick({ target: { closest: () => ({ tagName: 'BUTTON' }) } })
  assert.equal(fieldFocused, 1, 'a click that starts on a button does not steal its focus')

  const tab = (id) => {
    const element = component(panel(), 'MemoryTabs')
    return nodes(shell.render(element.type, element.props)).find(
      (node) => node.props?.id === 'obsidian-mem-tab-' + id,
    )
  }
  tab('graph').props.onClick()
  assert.ok(component(panel(), 'GraphView'), '图谱 mounts the graph view')
  assert.ok(boxElement(), 'the search box survives the tab switch')

  // Submitting enters search mode: the shell replaces the view body with the
  // results page. The served module cannot load in this context, so the observable
  // is the body swap; the props crossing that seam are pinned in the source below.
  const submit = () => {
    let submitted = 0
    form().props.onSubmit({
      preventDefault: () => {
        submitted += 1
      },
    })
    return submitted
  }
  input().props.onChange({ target: { value: '绑定' } })
  assert.equal(submit(), 1, 'the form submit is consumed by the shell')
  assert.equal(component(panel(), 'GraphView'), undefined, 'a submitted query replaces the body')
  // A tab click is the second exit: search mode drops even when the tab is the one
  // that is already mounted. The typed text survives a tab click by design, so the
  // field is emptied first for the empty-query guard below.
  tab('graph').props.onClick()
  assert.ok(component(panel(), 'GraphView'), 'a tab click leaves search mode')
  input().props.onKeyDown({ key: 'Escape', preventDefault: () => {} })
  assert.equal(boxElement().props.value, '', 'Escape empties the field')
  // An empty query is not a search (design §6.3): no request, no mode change.
  assert.equal(submit(), 1)
  assert.ok(component(panel(), 'GraphView'), 'an empty query does not enter search mode')
  // Escape is the third exit, from the input itself.
  input().props.onChange({ target: { value: '绑定' } })
  submit()
  assert.equal(component(panel(), 'GraphView'), undefined)
  input().props.onKeyDown({ key: 'Escape', preventDefault: () => {} })
  assert.ok(component(panel(), 'GraphView'), 'Escape leaves search mode')

  // The served view is behind the dynamic import a vm context cannot resolve, so
  // the props contract across that seam is the source-shape seam: what it pins is
  // that the results page mounts with the shell's own state plus its callbacks,
  // never an internally owned form. panel-ui.test.js mounts the view side.
  const shellSource = script.slice(
    script.indexOf('function MemoryPanel'),
    script.indexOf('function SearchBox'),
  )
  for (const prop of [
    'sessionId',
    'query',
    'scope',
    'type',
    'status',
    'limit',
    'visible',
    // The two callbacks the single-owner model depends on (I6/I7): the view
    // reports filter changes and page-size changes upward instead of owning them.
    'onFilter',
    'onLimit',
    'onClose',
  ])
    assert.ok(
      new RegExp('SearchView,\\s*\\{[^}]*\\b' + prop + '\\b', 'u').test(shellSource),
      'SearchView receives ' + prop + ' from the shell',
    )
  // 检索 is no longer a tab, so polling keeps to the two polling reads.
  assert.ok(
    script.includes("const polling = view === 'overview' || view === 'health'"),
    'polling covers 概览 and 健康 only',
  )
  assert.equal(script.includes("view === 'search'"), false, 'no search tab branch survives')
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
    // Round 2: the in-panel language switch the shell paints beside the clock.
    'mem-locale',
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
    'mem-action-status',
    // Round 5: the per-mutation outcome line drawn in the owning section, and the hot
    // card's trigger state beside its 整理热层 action.
    'mem-action-result',
    'mem-hot-state',
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
    'mem-kpi-spark',
    'mem-summary',
    'mem-summary-item',
    'mem-summary-value',
    // The 概览 charts landed with the chart redesign and are what this list is
    // really for: each hook is emitted by `lib/memory-panel.js` and has a rule in
    // the stylesheet, so a renamed class in either place fails here.
    // The heat map is a fixed GitHub-style calendar now: a horizontal scroll box, a
    // computed canvas, the months row, the sticky weekday gutter, the tooltip and the
    // bottom legend. The cell/legend classes survive their redraw.
    'mem-heat',
    'mem-heat-scroll',
    'mem-heat-canvas',
    'mem-heat-months',
    'mem-heat-month',
    'mem-heat-frame',
    'mem-heat-weekdays',
    'mem-heat-weekday',
    'mem-heat-grid',
    'mem-heat-cell',
    'mem-heat-tip',
    'mem-heat-hint',
    'mem-heat-legend',
    'mem-heat-legend-label',
    'mem-heat-swatch',
    'mem-flow',
    'mem-flow-svg',
    'mem-flow-created',
    'mem-flow-updated',
    'mem-flow-zero',
    'mem-flow-legend',
    'mem-flow-swatch',
    'mem-flow-legend-label',
    // 标签频率 is a squarified treemap now: area is the count, and each tile prints
    // its own digits. The five `mem-freq*` bar classes are retired with their
    // producer (the ranked list they styled is gone, not merely unused).
    'mem-treemap',
    'mem-treemap-tile',
    'mem-treemap-name',
    'mem-treemap-value',
    // 健康's charts: the gauge band, the figure grid, and the two bar shapes.
    'mem-gauges',
    'mem-gauge',
    'mem-gauge-label',
    'mem-gauge-value',
    'mem-gauge-track',
    'mem-gauge-fill',
    'mem-figures',
    'mem-figure',
    'mem-figure-value',
    'mem-figure-key',
    'mem-stackbar',
    'mem-stackbar-track',
    'mem-stackbar-seg',
    'mem-stackbar-legend',
    'mem-stackbar-row',
    'mem-bars',
    'mem-bar-row',
    'mem-bar-name',
    'mem-bar-value',
    'mem-chart-empty',
    'mem-block',
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
    // `mem-stamps` is retired with its producer: the status distribution is one line
    // at the composition legend's tail now, not a second chip row.
    'mem-comp-status',
    'mem-comp-status-label',
    'mem-comp-status-value',
    // The 构成 Sankey: an SVG drawn only from the real type×status joint counts; the
    // bar above stays as the fallback when the wire carries no flow.
    'mem-sankey',
    // Round 2: the Sankey's own horizontal scroll box and the canvas inside it.
    'mem-sankey-scroll',
    'mem-sankey-svg',
    'mem-sankey-canvas',
    'mem-sankey-node',
    'mem-sankey-link',
    'mem-sankey-label',
    'mem-sankey-value',
    'mem-sankey-leader',
    // 最近变化 is a GitHub contribution-activity rail: one group per updated day, a
    // node per group, items with their own dots. The flat mem-recent* list and its
    // mem-dot are retired with their producer (not merely unused).
    'mem-timeline',
    'mem-timeline-group',
    'mem-timeline-node',
    'mem-timeline-body',
    'mem-timeline-head',
    'mem-timeline-date',
    'mem-timeline-count',
    'mem-timeline-items',
    'mem-timeline-item',
    'mem-timeline-dot',
    'mem-timeline-main',
    'mem-timeline-title',
    'mem-timeline-meta',
    // Round 5: the quiet '仅显示最近 K 条' hint under a sampled day's total.
    'mem-timeline-more',
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
  // The list is only a guard if it is bound to the producer: read the served
  // views and extract every class token they emit from quoted literals (comments
  // stripped first, see `stripComments`). Every one must be in the list, so a new
  // or renamed view class fails here until the list and the stylesheet follow. The
  // count is asserted as well: the subset check would pass vacuously if the scan
  // ever stopped seeing the views (a quoting change, all names moving into template
  // literals), and deleting an emitted class should force the list and this count
  // to be re-derived.
  const emitted = [
    ...new Set(
      [
        ...stripComments(await viewsSource()).matchAll(
          /'([^'\\]*(?:\\.[^'\\]*)*)'|"([^"\\]*(?:\\.[^"\\]*)*)"/gu,
        ),
      ]
        .flatMap((match) => (match[1] ?? match[2]).split(/\s+/))
        .filter((token) => /^mem-[a-z0-9-]+$/u.test(token)),
    ),
  ].sort()
  const unguarded = emitted.filter((name) => !hooks.includes(name))
  assert.deepEqual(
    unguarded,
    [],
    'classes the views emit but the list does not guard: ' + unguarded.join(', '),
  )
  // Re-derived for the round-4 UI: 132 before it, minus the six retired `mem-recent*`
  // and `mem-dot` hooks, plus the nine the GitHub-style heat map and the thirteen the
  // activity rail add. Round 5 adds the inline outcome line, the hot trigger state and
  // the sampled-day hint on the activity rail; round 2 adds the composition Sankey's
  // scroll box and canvas pair. The count is what makes a deleted producer fail even
  // when the list happens to still cover the rest — the subset check alone would pass
  // on a shrunken view.
  assert.equal(
    emitted.length,
    153,
    'the views scan still sees every emitted class (re-derive the count with the list)',
  )
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
    '.mem-action-result.is-error',
    '.mem-hot-state.is-ok',
    '.mem-hot-state.is-warn',
    '.mem-snippet mark',
    '.mem-filter-option[aria-pressed="true"]',
    '.mem-sankey-node.is-status',
    '.mem-sankey-node.is-seg0',
    '.mem-sankey-link.is-seg0',
  ])
    assert.ok(css.includes(variant), 'the stylesheet styles ' + variant)
  for (const action of ['.mem-sheet-confirm', '.mem-sheet-cancel']) {
    const start = css.indexOf('.mem-panel ' + action + '{')
    assert.ok(start >= 0, 'the sheet styles ' + action)
    const rule = css.slice(start, css.indexOf('}', start))
    assert.ok(rule.includes('min-height:44px'), action + ' keeps its 44px hit area')
  }
  assert.ok(css.includes('grid-template-columns:repeat(2,minmax(0,1fr))'), 'overflow folds to 2x2')
  // The Sankey's coordinate width is the MEASURED block width, so the chart fills a
  // wide panel instead of capping itself or scaling its 11px type; only the height is
  // the fixed vertical coordinate space.
  const sankey = css.indexOf('.mem-panel .mem-sankey{')
  assert.ok(sankey >= 0, 'the Sankey wrapper rule exists')
  const sankeyRule = css.slice(sankey, css.indexOf('}', sankey))
  assert.equal(
    sankeyRule.includes('max-width'),
    false,
    'the chart is not capped: it fills its block',
  )
  const sankeySvg = css.indexOf('.mem-panel .mem-sankey-svg{')
  assert.ok(sankeySvg >= 0, 'the Sankey svg rule exists')
  const sankeySvgRule = css.slice(sankeySvg, css.indexOf('}', sankeySvg))
  assert.ok(sankeySvgRule.includes('width:100%'), 'the svg fills its measured block')
  assert.ok(sankeySvgRule.includes('height:200px'), 'the height stays the fixed coordinate space')
  assert.ok(css.includes('-webkit-line-clamp:2'), 'snippets clamp to two lines')
})

test('the search field owns one rounded focus ring; the input paints no second box', async () => {
  const { script } = await bundle()
  const css = panelCss(script)
  // The measured defect this replaces: the panel-wide :focus-visible rule drew a
  // 2px ring at 2px offset on the square .mem-search-input, INSIDE the rounded field
  // that already turns its own border on :focus-within. Two blue indicators for one
  // focus, one of them square and inset (user screenshot: outer x11..579/y83..122,
  // inner x42..572/y80..125 at 646px). The field now owns the single ring.
  assert.ok(
    css.includes(
      '.mem-panel :focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}',
    ),
    'every other control keeps the global focus ring',
  )
  assert.ok(
    css.includes('.mem-panel .mem-search-input:focus-visible{outline:none}'),
    'the input paints no second, square ring inside the rounded field',
  )
  const start = css.indexOf('.mem-panel .mem-search-field:focus-within{')
  assert.ok(start >= 0, 'the field still tracks focus')
  const field = css.slice(start, css.indexOf('}', start))
  assert.ok(
    field.includes('border-color:var(--dsw-alias-state-business-primary)'),
    'the field edge turns on focus',
  )
  assert.ok(
    field.includes('outline:2px solid var(--dsw-alias-state-business-primary)'),
    'the field paints the one rounded ring the input no longer paints',
  )
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
    const hookStart = css.indexOf('.mem-panel .' + hook + '{')
    assert.ok(hookStart >= 0, 'the metadata rule exists: ' + hook)
    const rule = css.slice(hookStart, css.indexOf('}', hookStart))
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

// The English locale. The bundle's detectLocale() is gated on `window` because
// Node ships a global navigator (language "en-US") — the vm harness supplies the
// fake window, so a sandbox with no navigator still resolves zh, and these tests
// define the browser's navigator to exercise the inferred-English path.

const enSandbox = () => ({ navigator: { language: 'en-US' } })

/** Every string a rendered tree would put in front of the reader. */
function chromeText(tree) {
  const found = []
  for (const node of nodes(tree)) {
    for (const child of node.props?.children ?? []) if (typeof child === 'string') found.push(child)
    for (const key of ['title', 'aria-label', 'placeholder', 'description'])
      if (typeof node.props?.[key] === 'string') found.push(node.props[key])
  }
  return found
}

const hasHan = (values) => values.some((value) => /[\u3400-\u9fff]/u.test(value))

test('the shell infers English from the browser language and keeps zh otherwise', async () => {
  const register = async (globals) => {
    const { exports } = await bundle(undefined, globals)
    let tab
    exports.apply({
      betterSidebar: {
        registerTab(value) {
          tab = value
        },
      },
      effect(callback) {
        callback()
      },
    })
    return tab
  }
  const en = await register(enSandbox())
  assert.equal(en.title, 'Memory', 'an en-US navigator selects the English tab title')
  assert.equal(en.description, 'Project memory: overview, graph, search and health')
  const zh = await register({})
  assert.equal(zh.title, '记忆', 'a window without navigator keeps the source locale')
  const zhTag = await register({ navigator: { languages: ['zh-CN', 'en-US'] } })
  assert.equal(zhTag.title, '记忆', 'the first supported tag wins')
  const unsupported = await register({ navigator: { language: 'fr-FR' } })
  assert.equal(unsupported.title, 'Memory', 'an unsupported tag still selects English')
})

test('the English shell renders its tab strip, search box, clock and loading copy in English', async () => {
  const { shell, render } = await mountShell('session-en', enSandbox())
  const panel = () => render()
  const renderChild = (name) => {
    const element = component(panel(), name)
    assert.ok(element, 'the shell renders ' + name)
    return shell.render(element.type, element.props)
  }
  const tabs = () => renderChild('MemoryTabs')
  const metaTree = () => {
    const element = component(tabs(), 'TabbarMeta')
    assert.ok(element, 'the strip renders the freshness meta')
    return shell.render(element.type, element.props)
  }
  assert.deepEqual(
    byClass(tabs(), 'mem-tab-label').map((node) => node.props.children.join('')),
    ['Overview', 'Graph', 'Health'],
    'the three tabs are English',
  )
  assert.equal(byRole(tabs(), 'tablist').props['aria-label'], 'Memory view')
  const meta = metaTree()
  assert.ok(chromeText(meta).includes('Loading…'), 'the clock says loading, not 正在读取…')
  const refresh = byClass(meta, 'mem-refresh')[0]
  assert.equal(refresh.props.title, 'Refresh memory data')
  assert.equal(refresh.props['aria-label'], 'Refresh memory data')
  const box = renderChild('SearchBox')
  const input = byClass(box, 'mem-search-input')[0]
  assert.equal(input.props.placeholder, 'Search memories…')
  assert.equal(input.props['aria-label'], 'Search memories')
  const submit = byClass(box, 'mem-search-submit')[0]
  assert.equal(submit.props['aria-label'], 'Search')
  assert.deepEqual(submit.props.children, ['Search'])
  assert.ok(
    chromeText(panel()).includes('Loading memories…'),
    'the served-module wait says loading in English',
  )
  assert.equal(
    hasHan([
      ...chromeText(panel()),
      ...chromeText(tabs()),
      ...chromeText(box),
      ...chromeText(meta),
    ]),
    false,
    'English shell chrome renders no Han characters',
  )
})

test('the English graph controls localize every control and the empty state', async () => {
  const { shell, render } = await mountShell('session-graph-en', enSandbox())
  const panel = () => render()
  const tabs = () => {
    const element = component(panel(), 'MemoryTabs')
    return shell.render(element.type, element.props)
  }
  const graphTab = nodes(tabs()).find((node) => node.props?.id === 'obsidian-mem-tab-graph')
  assert.ok(graphTab, 'the graph tab is in the strip')
  graphTab.props.onClick()
  const graph = () => {
    const element = component(panel(), 'GraphView')
    assert.ok(element, 'the graph tab mounts GraphView')
    return shell.render(element.type, element.props)
  }
  let tree = graph()
  assert.equal(byRole(tree, 'region').props['aria-label'], 'Graph settings')
  // Every section starts collapsed; opening all four is what renders their controls.
  const headers = byClass(tree, 'tree-item-self')
  assert.equal(headers.length, 4, 'the four control sections are there')
  for (const header of headers) header.props.onClick()
  tree = graph()
  const canvas = shell.render(
    component(tree, 'GraphCanvas').type,
    component(tree, 'GraphCanvas').props,
  )
  assert.equal(canvas.props['aria-label'], 'Zoomable memory graph')
  // The per-group row copy only exists once a group does; an empty section
  // renders just its add button.
  const addGroup = nodes(tree).find(
    (node) =>
      node.props?.className === 'mod-cta' && node.props?.children?.includes('New color group'),
  )
  assert.ok(addGroup, 'the color-group section offers its add button')
  addGroup.props.onClick()
  tree = graph()
  const text = [...chromeText(tree), ...chromeText(canvas)]
  for (const copy of [
    'Close',
    'Open graph settings',
    'Start animation',
    'Reset to defaults',
    'Filters',
    'Search notes…',
    'Search notes',
    'Tags',
    'Attachments',
    'Show created notes only',
    'Orphans',
    'Scope',
    'Graph scope',
    'All memories',
    'Current project',
    'Color groups',
    'Enter a query…',
    'Color group query 1',
    'Click to change color; drag to reorder',
    'Color group color 1',
    'Delete color group 1',
    'New color group',
    'Appearance',
    'Arrows',
    'Text opacity',
    'Label size',
    'Node size',
    'Link thickness',
    'Play animation',
    'Force',
    'Center force',
    'Repel force',
    'Link force',
    'Link distance',
    'No memories yet',
  ])
    assert.ok(text.includes(copy), 'English graph copy: ' + copy)
  assert.equal(hasHan(text), false, 'English graph chrome renders no Han characters')
})

test('the English copy only a live graph can reach is still in the bundle', async () => {
  const { script } = await bundle()
  for (const copy of [
    "'Graph unavailable'",
    "'Graph rendering unavailable'",
    "' · All memories'",
    "'Open a session to see its memories'",
    "'Search memories…'",
    "'Clear search'",
    "'Graph settings'",
  ])
    assert.ok(script.includes(copy), 'the bundled fallback copy exists: ' + copy)
  assert.match(script, /quantity\(/u, 'the node/link count pluralizes through quantity()')
  assert.match(
    script,
    /if \(locale === 'en'\) clock = 'Loading…'/u,
    'the clock has its English branch',
  )
  assert.ok(
    script.includes("'正在读取…'"),
    'the Chinese loading literal stays for the default render',
  )
  assert.ok(
    script.includes("' 个节点 · '"),
    'the Chinese count literal stays for the default render',
  )
})

// ---------------------------------------------------------------------------
// Round-2 shell fixes: the in-panel language switch (default English, persisted
// in the host page's localStorage), the search row centred in the gap it opens,
// and the Sankey's own horizontal scroll box.

/** A localStorage stand-in: one fixed stored value, plus a log of every write. */
function storeSandbox(stored = null) {
  const writes = []
  return {
    writes,
    globals: {
      localStorage: {
        getItem: () => stored,
        setItem: (key, value) => writes.push([key, value]),
      },
    },
  }
}

test('the panel opens in English by default and switches to Chinese in place', async () => {
  const store = storeSandbox()
  const { script, shell, render, tab } = await mountShell('session-locale-toggle', store.globals)
  assert.equal(tab.title, 'Memory', 'a browser hosting the panel opens it in English by default')
  const panel = () => render()
  const renderChild = (name) => {
    const element = component(panel(), name)
    assert.ok(element, 'the shell renders ' + name)
    return shell.render(element.type, element.props)
  }
  const tabs = () => renderChild('MemoryTabs')
  const metaTree = () => {
    const element = component(tabs(), 'TabbarMeta')
    assert.ok(element, 'the strip renders the freshness meta')
    return shell.render(element.type, element.props)
  }
  const switchButton = () => {
    const button = byClass(metaTree(), 'mem-locale')[0]
    assert.ok(button, 'the strip carries the language switch')
    return button
  }
  assert.deepEqual(
    byClass(tabs(), 'mem-tab-label').map((node) => node.props.children.join('')),
    ['Overview', 'Graph', 'Health'],
    'the tabs are English before any interaction',
  )
  assert.equal(byRole(tabs(), 'tablist').props['aria-label'], 'Memory view')
  const meta = metaTree()
  const localeIndex = nodes(meta).indexOf(byClass(meta, 'mem-locale')[0])
  const clockIndex = nodes(meta).indexOf(byClass(meta, 'mem-clock')[0])
  assert.ok(localeIndex >= 0 && clockIndex > localeIndex, 'the switch sits before the clock')
  let button = switchButton()
  assert.deepEqual(button.props.children, ['ZH'], 'the switch names the language it offers')
  assert.equal(button.props['aria-label'], 'Switch to Chinese')
  assert.equal(button.props.title, 'Switch to Chinese')
  assert.equal(button.props.type, 'button', 'the switch is a real button, not a link')
  button.props.onClick()
  assert.deepEqual(
    store.writes,
    [['dsh-obsidian-mem:locale', 'zh']],
    'the choice is persisted for the next session',
  )
  assert.deepEqual(
    byClass(tabs(), 'mem-tab-label').map((node) => node.props.children.join('')),
    ['概览', '图谱', '健康'],
    'the strip re-renders in Chinese without a reload',
  )
  assert.equal(byRole(tabs(), 'tablist').props['aria-label'], '记忆视图')
  const box = renderChild('SearchBox')
  assert.equal(byClass(box, 'mem-search-input')[0].props.placeholder, '搜索记忆…')
  assert.ok(chromeText(metaTree()).includes('正在读取…'), 'the clock re-renders in Chinese')
  button = switchButton()
  assert.deepEqual(button.props.children, ['EN'], 'the switch now offers English back')
  assert.equal(button.props['aria-label'], '切换到英文')
  button.props.onClick()
  assert.deepEqual(
    store.writes,
    [
      ['dsh-obsidian-mem:locale', 'zh'],
      ['dsh-obsidian-mem:locale', 'en'],
    ],
    'switching back persists the English choice too',
  )
  assert.deepEqual(
    byClass(tabs(), 'mem-tab-label').map((node) => node.props.children.join('')),
    ['Overview', 'Graph', 'Health'],
  )
  // The served views are built from the module locale, so the import effect must
  // depend on the rendered value as well: otherwise a switch leaves the old
  // locale's view tree mounted under the new chrome.
  assert.ok(
    script.includes('[visible, attempt, localeValue]'),
    'the served-module import effect re-runs when the language switches',
  )
})

test('a stored language choice beats the browser language in both directions', async () => {
  const register = async (globals) => {
    const { exports } = await bundle(undefined, globals)
    let tab
    exports.apply({
      betterSidebar: {
        registerTab(value) {
          tab = value
        },
      },
      effect(callback) {
        callback()
      },
    })
    return tab
  }
  const storedEn = await register({
    ...storeSandbox('en').globals,
    navigator: { language: 'zh-CN' },
  })
  assert.equal(storedEn.title, 'Memory', 'a stored English choice wins over a Chinese navigator')
  const storedZh = await register({
    ...storeSandbox('zh').globals,
    navigator: { language: 'en-US' },
  })
  assert.equal(storedZh.title, '记忆', 'a stored Chinese choice wins over an English navigator')
  const unknown = await register(storeSandbox('fr').globals)
  assert.equal(unknown.title, 'Memory', 'an unknown stored value still opens English')
  const quiet = await register({})
  assert.equal(quiet.title, '记忆', 'no store at all keeps the old detected default')
})

test('switching the language rebuilds the graph canvas into the new locale', async () => {
  const store = storeSandbox()
  const { script, shell, render } = await mountShell('session-locale-graph', store.globals)
  const panel = () => render()
  const tabs = () => {
    const element = component(panel(), 'MemoryTabs')
    assert.ok(element, 'the shell renders the strip')
    return shell.render(element.type, element.props)
  }
  const meta = () => {
    const element = component(tabs(), 'TabbarMeta')
    assert.ok(element, 'the strip renders the freshness meta')
    return shell.render(element.type, element.props)
  }
  const graphTab = nodes(tabs()).find((node) => node.props?.id === 'obsidian-mem-tab-graph')
  assert.ok(graphTab, 'the graph tab is in the strip')
  graphTab.props.onClick()
  const canvasOf = () => {
    const graphElement = component(panel(), 'GraphView')
    assert.ok(graphElement, 'the graph tab mounts GraphView')
    const graphTree = shell.render(graphElement.type, graphElement.props)
    const canvasElement = component(graphTree, 'GraphCanvas')
    assert.ok(canvasElement, 'GraphView mounts the canvas')
    const canvas = shell.render(canvasElement.type, canvasElement.props)
    return { graphElement, canvasElement, canvas }
  }
  let seen = canvasOf()
  assert.equal(seen.graphElement.props.locale, 'en', 'GraphView receives the live locale')
  assert.equal(seen.canvasElement.props.locale, 'en', 'GraphCanvas is rebuilt for the locale')
  assert.equal(seen.canvas.props['aria-label'], 'Zoomable memory graph')
  byClass(meta(), 'mem-locale')[0].props.onClick()
  seen = canvasOf()
  assert.equal(seen.graphElement.props.locale, 'zh', 'GraphView re-renders with the new locale')
  assert.equal(seen.canvasElement.props.locale, 'zh', 'GraphCanvas re-renders with the new locale')
  assert.equal(seen.canvas.props['aria-label'], '可缩放的记忆关系图谱')
  // The canvas import effect must depend on the locale tag, or the mounted
  // renderer would keep drawing the previous language's aria label.
  assert.ok(
    script.includes('[visible, localeTag]'),
    'the renderer import effect re-runs when the language switches',
  )
})

test('the search row is centred in the gap it opens above and below', async () => {
  const { script } = await bundle()
  const css = panelCss(script)
  const searchStart = css.indexOf('.mem-panel > .mem-searchbar{')
  assert.ok(searchStart >= 0, 'the shell search row rule exists')
  const searchRule = css.slice(searchStart, css.indexOf('}', searchStart))
  const searchPadding = /padding:(\d+)px (\d+)px (\d+)px/u.exec(searchRule)
  assert.ok(searchPadding, 'the search row declares the three-value padding: ' + searchRule)
  const viewStart = css.indexOf('.mem-panel .mem-view{')
  assert.ok(viewStart >= 0, 'the view body rule exists')
  const viewRule = css.slice(viewStart, css.indexOf('}', viewStart))
  const viewPadding = /padding:(\d+)px (\d+)px (\d+)px/u.exec(viewRule)
  assert.ok(viewPadding, '.mem-view declares the three-value padding: ' + viewRule)
  const above = Number(searchPadding[1])
  const below = Number(searchPadding[3]) + Number(viewPadding[1])
  assert.equal(above, 16, '16px above the field')
  assert.equal(below, 16, '16px below the field: 8px row padding + 8px body inset')
})

test('the Sankey scrolls inside its own horizontal box', async () => {
  const { script } = await bundle()
  const css = panelCss(script)
  const start = css.indexOf('.mem-panel .mem-sankey-scroll{')
  assert.ok(start >= 0, 'the Sankey scroll box rule exists')
  const rule = css.slice(start, css.indexOf('}', start))
  for (const marker of [
    'overflow-x:auto',
    'overflow-y:hidden',
    'scrollbar-width:thin',
    'padding-bottom:2px',
  ])
    assert.ok(rule.includes(marker), 'the Sankey scroll box declares ' + marker)
  assert.ok(
    css.includes('.mem-panel .mem-sankey-scroll::-webkit-scrollbar{width:8px;height:8px}'),
    'the webkit fallback is the same 8px bar as the view',
  )
  assert.ok(
    css.includes(
      '.mem-panel .mem-sankey-scroll::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--dsw-alias-label-secondary) 35%,transparent);border-radius:4px}',
    ),
    'the thumb is the view scrollbar mix, rounded',
  )
  assert.ok(
    css.includes('.mem-panel .mem-sankey-scroll::-webkit-scrollbar-track{background:transparent}'),
    'the track stays invisible',
  )
  assert.ok(css.includes('.mem-panel .mem-sankey-canvas{display:block}'), 'the canvas is a block')
})
