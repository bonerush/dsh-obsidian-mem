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
        if (!(index in values)) values[index] = initial
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
    },
    render(component, props) {
      current = component
      cursor = 0
      return component(props)
    },
  }
}

/** Register the bundle the way the host does, and return its factory exports. */
async function bundle(react = shellReact().React) {
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
async function mountShell(sessionId = 'session-shell') {
  const shell = shellReact()
  const { script, exports } = await bundle(shell.React)
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
  assert.match(script, /createMemoryViews\(\{\s*React\s*\}\)/u, 'the served factory receives React')
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

test('the heat-map grid clears the chart-container floor without outgrowing the section', async () => {
  const { script } = await bundle()
  const css = panelCss(script)
  const start = css.indexOf('.mem-panel .mem-heat-grid{')
  assert.ok(start >= 0, 'the heat grid rule exists')
  const rule = css.slice(start, css.indexOf('}', start))
  const cap = /max-width:(\d+)px/u.exec(rule)
  assert.ok(cap, 'the grid declares a pixel cap so the squares stop growing on a wide panel')
  // The floor arithmetic is derived from the panel's own layout rather than
  // repeating its constant here: read `.mem-view`'s horizontal padding (currently
  // 14px, so the 320px panel's content box is 320 - 2×14 = 292px) and use it as
  // the cap's upper bound. If the padding moves, this fails loudly instead of
  // silently disagreeing with the stylesheet; the `width:100%` beside the cap
  // already keeps the grid inside the section, so the cap only has to fill the
  // narrowest supported content box without overshooting it.
  const viewStart = css.indexOf('.mem-panel .mem-view{')
  assert.ok(viewStart >= 0, 'the view body rule exists so the floor arithmetic has a source')
  const viewRule = css.slice(viewStart, css.indexOf('}', viewStart))
  const padding = /padding:\d+px (\d+)px \d+px/u.exec(viewRule)
  assert.ok(padding, '.mem-view declares the three-value padding the arithmetic reads')
  const viewPadding = Number(padding[1])
  // Design §6.6: every chart container is at least 280px wide in the panel's
  // supported range, so the cap must land in [280, 320 − 2×padding].
  assert.ok(Number(cap[1]) >= 280, 'the chart container clears the 280px floor, found ' + cap[1])
  assert.ok(
    Number(cap[1]) <= 320 - 2 * viewPadding,
    'the cap fits the 320px content box: cap ' +
      cap[1] +
      ', content box ' +
      (320 - 2 * viewPadding),
  )
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
    'mem-heat',
    'mem-heat-grid',
    'mem-heat-cell',
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
    'mem-freq',
    'mem-freq-row',
    'mem-freq-name',
    'mem-freq-track',
    'mem-freq-fill',
    'mem-freq-value',
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
  // The list is only a guard if it is bound to the producer: read the served
  // views and extract every class token they emit from quoted literals (comments
  // stripped first, see `stripComments`). The extraction finds 108 classes on
  // this tree — the 24 chart hooks plus the 84 the earlier views already owned —
  // and every one must be in the list, so a new or renamed view class fails here
  // until the list and the stylesheet follow. The count is asserted as well: the
  // subset check would pass vacuously if the scan ever stopped seeing the views
  // (a quoting change, all names moving into template literals), and deleting an
  // emitted class should force the list and this count to be re-derived.
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
  assert.equal(
    emitted.length,
    108,
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
