import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { setImmediate } from 'node:timers/promises'
import { test } from 'node:test'

import { createMemoryViews } from '../lib/memory-panel.js'

const MODULE = new URL('../lib/memory-panel.js', import.meta.url)

// The suite has no React dependency: the views are real, the hook runtime is a
// four-hook stand-in that preserves state across renders and runs effect
// cleanup the way the host's mount does. Fetch is the browser boundary.
function mount(t, name, options = {}) {
  const values = []
  const effects = []
  let cursor = 0
  let pending = []
  const React = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useState(initial) {
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
      const index = cursor++
      if (!(index in values)) values[index] = { current: initial }
      return values[index]
    },
    useEffect(run, deps) {
      const index = cursor++
      const previous = effects[index]
      if (
        previous?.deps &&
        previous.deps.length === deps.length &&
        previous.deps.every((value, i) => Object.is(value, deps[i]))
      )
        return
      pending.push(() => {
        previous?.cleanup?.()
        effects[index] = { deps, cleanup: run() }
      })
    },
  }
  const View = createMemoryViews({ React, ...options })[name]
  t.after(() => effects.forEach((effect) => effect?.cleanup?.()))
  const focused = []
  // React attaches a DOM node to an object ref after mounting. This stand-in
  // attaches a focus stub to the same ref object so a test can prove the view
  // moved focus (the host has no DOM here). Refs are attached before the effects
  // run, the order the host mounts in.
  const attachRefs = (tree) => {
    for (const node of nodes(tree)) {
      const ref = node?.props?.ref
      if (ref === null || typeof ref !== 'object' || !('current' in ref)) continue
      if (typeof node.type !== 'string') continue
      // React attaches once and leaves the object alone afterwards; preserving a
      // live ref is what lets a test simulate a scroll position that survives a
      // re-render (the heat map pins its scroll once and must not yank it back).
      if (ref.current !== null && ref.current !== undefined) continue
      ref.current = {
        focus: () =>
          focused.push(node.type + (node.props.className ? ':' + node.props.className : '')),
        // The heat map's scroll box is the one ref a view reads numbers from: its
        // mount effect pins the first draw to the current week, and a DOM-less
        // runtime can only observe that through stubbed box numbers.
        ...(String(node.props.className ?? '')
          .split(' ')
          .includes('mem-heat-scroll')
          ? { scrollLeft: 0, scrollWidth: 648, clientWidth: 292 }
          : {}),
        // The tooltip's layout effect reads its RENDERED width, which is what the edge
        // clamp needs; the stub makes the DOM-less runtime take the measured path too.
        ...(String(node.props.className ?? '')
          .split(' ')
          .includes('mem-heat-tip')
          ? { getBoundingClientRect: () => ({ width: 120 }) }
          : {}),
      }
    }
  }
  const render = (props) => {
    cursor = 0
    const tree = View(props)
    attachRefs(tree)
    const runs = pending
    pending = []
    runs.forEach((run) => run())
    return tree
  }
  render.focused = focused
  return render
}

function nodes(tree) {
  if (!tree || typeof tree !== 'object') return [tree]
  // The stand-in React keeps function components as elements. Render them here
  // so a status/notice rendered by a small component is visible to the tree
  // assertions exactly as the host would render it. None of these components
  // use hooks; the views themselves are called directly by mount().
  const rendered = typeof tree.type === 'function' ? flat(tree.type(tree.props)) : []
  return [tree, ...flat(tree.props?.children ?? []).flatMap(nodes), ...rendered.flatMap(nodes)]
}
const flat = (value) => (Array.isArray(value) ? value.flat(Infinity) : [value])
function texts(tree) {
  return nodes(tree)
    .flatMap((node) => (Array.isArray(node?.props?.children) ? node.props.children : []))
    .flat(Infinity)
    .filter((value) => typeof value === 'string' || typeof value === 'number')
}
const find = (tree, predicate) => nodes(tree).find(predicate)
const byClass = (tree, className) =>
  nodes(tree).filter(
    (node) =>
      typeof node?.props?.className === 'string' &&
      node.props.className.split(' ').includes(className),
  )
const byText = (tree, text) =>
  nodes(tree).filter(
    (node) =>
      node?.type === 'button' &&
      flat(node.props.children ?? [])
        .flat(Infinity)
        .includes(text),
  )
/** How many rendered strings contain `text`. The duplicate-status guard. */
const countText = (tree, text) => texts(tree).filter((value) => String(value).includes(text)).length
/** Every live region a screen reader would announce. */
const liveRegions = (tree) =>
  nodes(tree).filter((node) => node?.props?.role === 'status' || node?.props?.role === 'alert')
const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

const ok = (value) => ({ ok: true, status: 200, json: async () => ({ ok: true, value }) })
const failure = (status, code, message) => ({
  ok: false,
  status,
  json: async () => ({ ok: false, error: { code, message } }),
})
/**
 * A 404 with NO envelope: in the browser that is the host answering "no such route",
 * which is what the startup race looks like before the plugin's route is registered.
 * An old host's coded session-missing also arrived as a 404 — but WITH an envelope.
 */
const plain404 = () => ({
  ok: false,
  status: 404,
  json: async () => {
    throw new SyntaxError('Unexpected token < in JSON at position 0')
  },
})

const PROJECT = {
  state: 'bound',
  name: 'repo',
  projectId: '05025725-00be-4852-aba6-4854f961cd01',
  vault: { display: '~/vault', basename: 'vault' },
  reason: null,
}
const healthValue = (overrides = {}) => ({
  project: PROJECT,
  index: {
    state: 'ready',
    backend: 'sqlite',
    fts: true,
    stale: false,
    scanning: false,
    notes: 12,
    lastScan: '2026-10-27T12:00:00.000Z',
    quarantined: 0,
    skipped: {},
    reason: null,
  },
  queue: {
    queued: 1,
    failed: 1,
    deferred: 0,
    failedJobs: [
      {
        jobId: 'job-0123456789abcdef0123456789abcdef',
        state: 'failed',
        projectId: PROJECT.projectId,
        attempts: 2,
        createdAt: '2026-10-26T00:00:00.000Z',
        failedAt: '2026-10-26T01:00:00.000Z',
        lastError: 'boom',
        outputState: null,
      },
    ],
  },
  hot: {
    missing: false,
    used: 7200,
    capacity: 9000,
    trigger: 6030,
    ratio: 0.8,
    archivable: 3,
    compactable: 5,
    sections: [
      { name: '已完成', chars: 1200, entries: 1, pointers: 2, moveable: 3 },
      { name: '进行中', chars: 5400, entries: 6, pointers: 0, moveable: 2 },
    ],
  },
  diagnostics: {
    window: { capacity: 100, size: 2, oldestSeq: 1, newestSeq: 2, dropped: 0 },
    events: [
      { seq: 1, at: '2026-10-27T12:00:00.000Z', event: 'brief', outcome: 'injected' },
      { seq: 2, at: '2026-10-27T12:05:00.000Z', event: 'search', outcome: 'ok' },
    ],
  },
  digest: {
    window: { days: 1 },
    notes: { created: 1, updated: 0, superseded: 0 },
    appraisal: { findings: [], total: 0, truncated: false },
    hot: null,
    queue: null,
    recent: [],
    snapshot: {
      at: '2026-10-27T12:00:00.000Z',
      basis: 'current-status-among-inspected-sources',
      fields: [],
    },
    collection: {
      basis: 'inspected-source-notes',
      inspected: 1,
      limit: 200,
      truncated: false,
      incomplete: false,
      reasons: [],
    },
  },
  capabilities: { mutations: ['retry-job', 'compact-hot', 'refresh-digest'] },
  ...overrides,
})
const overviewValue = (overrides = {}) => ({
  project: PROJECT,
  counts: {
    notes: 515,
    links: 8,
    orphans: 12,
    byType: [
      { type: 'convention', n: 506 },
      { type: 'decision', n: 7 },
      { type: 'hub', n: 2 },
    ],
    byStatus: [
      { status: 'active', n: 514 },
      { status: 'provisional', n: 1 },
    ],
  },
  health: { state: 'ready', notes: 12, lastScan: '2026-10-27T12:00:00.000Z' },
  queue: { queued: 0, failed: 0, deferred: 0, failedJobs: [] },
  hot: { capacity: 9000, used: 5145 },
  recent: [
    { path: 'a.md', title: '决策一', type: 'decision', updated: '2026-10-27T12:00:00.000Z' },
    { path: 'b.md', title: '约定一', type: 'convention', updated: '2026-10-27T11:00:00.000Z' },
  ],
  digest: null,
  capabilities: { mutations: ['retry-job', 'compact-hot', 'refresh-digest'] },
  ...overrides,
})

const hit = (path, title) => ({
  path,
  title,
  type: 'decision',
  status: 'active',
  source: 'title',
  snippet: '一段摘要',
  scoreSignals: ['title'],
})

const previewValue = (mutation = 'retry-job') => ({
  mutation,
  token: 'token-case-1',
  expiresAt: Date.now() + 60_000,
  preview: {
    title: '重试失败的作业',
    confirmLabel: '确认执行',
    facts: [
      { label: '任务', value: 'job-0123456789abcdef0123456789abcdef' },
      { label: '状态', value: 'failed' },
    ],
    effects: ['会把该作业重新放入队列'],
    warning: 'DSH 可能唤醒工作进程，Codex 只会重新排队。',
  },
})
const confirmValue = (mutation = 'retry-job', replayed = false) => ({
  mutation,
  replayed,
  result:
    mutation === 'retry-job'
      ? { status: 'retried', jobId: 'job-0123456789abcdef0123456789abcdef', state: 'pending' }
      : mutation === 'compact-hot'
        ? { status: 'compacted', moved: 3, folded: 2, reclaimed: 900, used: 5000, capacity: 9000 }
        : {
            status: 'created',
            path: 'Projects/repo/_meta/digest.md',
            id: 'doc-1',
            charCount: 900,
            txId: 'tx-1',
            window: { days: 1 },
          },
})

/** Record each fetch body/headers and answer from one handler. */
function stubFetch(t, handler) {
  const sent = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const body = JSON.parse(options.body)
    sent.push({ url, body, headers: options.headers ?? {} })
    return handler(body, sent.length)
  })
  return sent
}

/**
 * The props the shell hands `SearchView`. The box and the filters live in the
 * shell now, so a view test supplies them the way the shell would; `query` is the
 * one the box holds and `onFilter` is the shell's one filter setter.
 */
const searchProps = (overrides = {}) => ({
  sessionId: 'session-a',
  query: 'binding',
  scope: 'project',
  type: null,
  status: null,
  limit: 25,
  visible: true,
  onFilter: () => {},
  onClose: () => {},
  ...overrides,
})

test('the confirm sheet is a modal with a trap, Escape, live status and an in-flight lock', async () => {
  const source = await readFile(MODULE, 'utf8')
  for (const marker of [
    "role: 'alertdialog'",
    "'aria-modal': true",
    "event.key === 'Escape'",
    "event.key === 'Tab'",
    "'aria-live': 'polite'",
    "'确认执行'",
    "'取消'",
    "'正在执行…'",
    'disabled:',
    'mem-sheet',
  ])
    assert.ok(source.includes(marker), 'the sheet contains ' + marker)
})

test('mutations use the preview/confirm contract and are hidden without capabilities', async () => {
  const source = await readFile(MODULE, 'utf8')
  for (const marker of [
    "action: 'preview'",
    "action: 'confirm'",
    'mutation',
    'capabilities',
    'mutations',
    'failedJobs',
    "'preview-stale'",
    'replayed',
  ])
    assert.ok(source.includes(marker), 'the mutation seam names ' + marker)
  assert.equal(
    source.includes("action: 'retry-job'"),
    false,
    'the action vocabulary stays preview/confirm',
  )
})

// ---------------------------------------------------------------------------
// Overview, search and health as rendered views
// ---------------------------------------------------------------------------

test('the overview reports project, clock and refresh to the shell and bands its numbers', async (t) => {
  stubFetch(t, () => ok(overviewValue()))
  const render = mount(t, 'OverviewView')
  const reported = []
  const jumps = []
  const props = {
    sessionId: 'session-a',
    visible: true,
    onMeta: (meta) => reported.push(meta),
    onJump: (view) => jumps.push(view),
  }
  render(props)
  await setImmediate()
  const tree = render(props)
  const last = reported.at(-1)
  assert.equal(last.project.name, 'repo', 'the masthead learns the project')
  assert.equal(last.loading, false)
  assert.ok(last.updatedAt > 0, 'the clock has a time to show')
  assert.equal(typeof last.refresh, 'function', 'the masthead refresh reaches the poll')
  assert.deepEqual(
    byClass(tree, 'mem-kpi-value').map((node) => node.props.children[0]),
    ['515', '8', '12', '0'],
  )
  assert.equal(byClass(tree, 'mem-kpi').length, 4, 'the KPI band keeps its four cells')

  // Composition: one stacked track, one fill per type row, one legend row each.
  assert.equal(byClass(tree, 'mem-comp').length, 1)
  assert.equal(byClass(tree, 'mem-bar-track').length, 1, 'the parts share one track')
  assert.equal(byClass(tree, 'mem-bar-fill').length, 3, 'the three type segments are drawn')
  assert.deepEqual(
    byClass(tree, 'mem-comp-name').map((node) => node.props.children[0]),
    ['约定', '决策', 'hub'],
  )
  assert.deepEqual(
    byClass(tree, 'mem-comp-value').map((node) => node.props.children[0]),
    ['506', '7', '2'],
  )
  assert.deepEqual(
    byClass(tree, 'mem-comp-pct').map((node) => node.props.children[0]),
    ['98.3%', '1.4%', '0.4%'],
  )
  // The status distribution rides the composition legend's tail as one line, not
  // as a second chip row: two "share of the whole" readings on one block disagree
  // about what the whole is (design §3.4 item 4).
  assert.equal(byClass(tree, 'mem-comp-status').length, 1, 'status rides the legend tail')
  assert.deepEqual(
    byClass(tree, 'mem-comp-status-value').map((node) => node.props.children[0]),
    ['生效 514 · 待确认 1'],
  )

  // Recent: a GitHub-activity rail, one group per updated day. Both fixture rows
  // share a day, so they land in one group rather than two flat rows.
  assert.equal(byClass(tree, 'mem-recent-row').length, 0, 'the flat list is retired')
  assert.equal(byClass(tree, 'mem-recent-meta').length, 0, 'and its rules with it')
  const timeline = byClass(tree, 'mem-timeline')
  assert.equal(timeline.length, 1, '最近变化 is one rail timeline')
  const groups = byClass(tree, 'mem-timeline-group')
  assert.equal(groups.length, 1, 'both rows share one updated day, so one group')
  assert.equal(byClass(tree, 'mem-timeline-node').length, 1, 'a group is one rail node')
  assert.ok(
    nodes(groups[0]).some((node) => node?.type === 'svg'),
    'the node holds the inline note glyph',
  )
  assert.deepEqual(
    byClass(groups[0], 'mem-timeline-count').map((node) => node.props.children[0]),
    ['2 条'],
  )
  const items = byClass(groups[0], 'mem-timeline-item')
  assert.equal(items.length, 2, 'each row is an item under the group')
  assert.equal(byClass(groups[0], 'mem-timeline-dot').length, 2, 'each item carries a dot')
  assert.deepEqual(
    byClass(groups[0], 'mem-timeline-title').map((node) => node.props.children[0]),
    ['决策一', '约定一'],
  )
  assert.deepEqual(
    byClass(groups[0], 'mem-timeline-meta').map((node) => node.props.children[0]),
    ['决策 · 未标注', '约定 · 未标注'],
    'the meta is type · status, and a row with no status says so once',
  )
  assert.equal(byClass(groups[0], 'mem-stamp').length, 0, 'the type is not printed twice')

  // The health strip is passive and one action opens 健康.
  const strip = nodes(tree).find(
    (node) => node?.type === 'section' && node.props['aria-label'] === '健康',
  )
  assert.ok(strip, 'the overview keeps its health section')
  // The fixture has no failed jobs, so the strip carries 索引/扫描/热层.
  assert.equal(byClass(strip, 'mem-summary-item').length, 3)
  assert.ok(
    byClass(strip, 'mem-summary-item').every((cell) => cell.type !== 'button'),
    'the summary cells are not buttons',
  )
  assert.equal(byText(strip, '全部 →').length, 1, 'one action opens the health view')
})

test('each KPI cell is one label, one value line and its own unit, centred as a row', async (t) => {
  // The band is four equal cells; centring is a stylesheet job, so this test pins the
  // template it centres — every cell keeps exactly one label, one value line and one
  // unit, and only 记忆条目 carries the sparkline row. A cell that grew a second label
  // or lost its unit would centre the wrong reading.
  stubFetch(t, () =>
    ok(overviewValue({ activity: activityFixture(), tags: { items: [], total: 0 } })),
  )
  const render = mount(t, 'OverviewView')
  render(chartProps())
  await setImmediate()
  const tree = render(chartProps())
  const cells = byClass(tree, 'mem-kpi')
  assert.equal(cells.length, 4, 'four cells')
  assert.deepEqual(
    byClass(tree, 'mem-kpi-label').map((node) => node.props.children[0]),
    ['记忆条目', '关系', '孤立', '待处理'],
  )
  for (const cell of cells) {
    assert.equal(byClass(cell, 'mem-kpi-label').length, 1, 'one label per cell')
    assert.equal(byClass(cell, 'mem-kpi-line').length, 1, 'one value line per cell')
    assert.equal(byClass(cell, 'mem-kpi-value').length, 1, 'one value per cell')
    assert.equal(byClass(cell, 'mem-kpi-unit').length, 1, 'one unit per cell')
  }
  assert.equal(byClass(cells[0], 'mem-kpi-spark').length, 1, 'the growth shape rides 记忆条目')
  for (const cell of cells.slice(1)) assert.equal(byClass(cell, 'mem-kpi-spark').length, 0)
})

test('overview KPI cells jump: 待处理 opens 健康, the other three open 检索', async (t) => {
  stubFetch(t, () => ok(overviewValue()))
  const jumps = []
  const render = mount(t, 'OverviewView')
  const props = { sessionId: 'session-a', visible: true, onJump: (view) => jumps.push(view) }
  render(props)
  await setImmediate()
  const tree = render(props)
  const cells = byClass(tree, 'mem-kpi')
  assert.equal(cells.length, 4)
  for (const cell of cells) cell.props.onClick()
  assert.deepEqual(jumps, ['search', 'search', 'search', 'health'])
})

test('composed, the tab names the page: no duplicate heading and no search jump', async (t) => {
  // The shell mounts every view with `onMeta`, so that prop is the "composed" signal.
  // A "概览" headline under a 概览 tab is the same word twice, and a 去检索 jump
  // pointed at a box that is now permanently one row above the body.
  stubFetch(t, () =>
    ok(overviewValue({ activity: activityFixture(), tags: { items: [], total: 0 } })),
  )
  const render = mount(t, 'OverviewView')
  render({ sessionId: 'session-a', visible: true, onMeta: () => {}, onJump: () => {} })
  await setImmediate()
  const composed = render({
    sessionId: 'session-a',
    visible: true,
    onMeta: () => {},
    onJump: () => {},
  })
  assert.equal(byClass(composed, 'mem-viewhead').length, 0, 'no page heading when composed')
  assert.equal(byText(composed, '去检索').length, 0, 'no jump to a box that is always visible')
  // The composed body opens on a block, and that block paints the KPI band. The
  // panel stylesheet's first-block rule targets exactly that chain
  // (`.mem-view > .mem-ledger > .mem-block:first-child > .mem-kpiline`), so a
  // wrapper inserted between them would silently bring back the doubled inset.
  const renderChildren = (node) => {
    const expand = (value) => {
      if (value === null || value === undefined || value === false || value === true) return []
      if (Array.isArray(value)) return value.flat(Infinity).flatMap(expand)
      if (typeof value !== 'object') return []
      if (typeof value.type === 'function') return expand(value.type(value.props))
      return [value]
    }
    return expand(node?.props?.children ?? [])
  }
  const ledger = byClass(composed, 'mem-ledger')[0]
  assert.ok(ledger, 'the composed body is the ledger')
  const firstBlock = renderChildren(ledger)[0]
  assert.equal(
    firstBlock?.props?.className,
    'mem-block',
    'the body opens on a block, not a heading',
  )
  assert.equal(
    renderChildren(firstBlock)[0]?.props?.className,
    'mem-kpiline',
    'the first block paints the KPI band the first-block rule zeroes',
  )
  // Standalone (no `onMeta`) keeps the heading: there it is the only orientation.
  const alone = render({ sessionId: 'session-a', visible: true })
  assert.equal(byClass(alone, 'mem-viewhead').length, 1, 'standalone still says where it is')
})

// ---------------------------------------------------------------------------
// The five 概览 charts (design §3.4, acceptance §6.5)
// ---------------------------------------------------------------------------

/**
 * An activity series with a few busy days, so the buckets and weeks are non-zero.
 *
 * The default is the designed 84-day window; a wider panel asks for up to 182 days
 * (26 weeks), so the same generator with `days = 182` feeds the responsive tests.
 * The series always ends on 2026-10-29 (a Thursday).
 */
function activityFixture(days = 84) {
  const day = (offset) => {
    const date = new Date(2026, 9, 29)
    date.setDate(date.getDate() - offset)
    const pad = (n) => String(n).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  }
  const list = []
  for (let i = days - 1; i >= 0; i -= 1) list.push(day(i))
  return {
    from: list[0],
    to: list[days - 1],
    days: list,
    created: list.map((_d, index) => (index % 7 === 0 ? 2 : index % 5 === 0 ? 1 : 0)),
    updated: list.map((_d, index) => (index % 6 === 0 ? 1 : 0)),
  }
}

const chartProps = (overrides = {}) => ({ sessionId: 'session-a', visible: true, ...overrides })

test('the activity heat map is a fixed GitHub-style calendar of every served day', async (t) => {
  const activity = activityFixture()
  stubFetch(t, () => ok(overviewValue({ activity, tags: { items: [], total: 0 } })))
  const render = mount(t, 'OverviewView')
  render(chartProps())
  await setImmediate()
  const tree = render(chartProps())
  const grid = byClass(tree, 'mem-heat-grid')
  assert.equal(grid.length, 1, 'one grid')
  assert.equal(grid[0].props.role, 'img', 'the whole grid is a single image')
  assert.match(String(grid[0].props['aria-label']), /^近 \d+ 周活动，共 \d+ 条，峰值 \d+$/u)
  // Sunday-first columns laid out by the grid CSS from one flat run of cells, padded
  // to whole weeks. The head partial column is REAL DATA, not padding: every served
  // day gets a cell, so the printed total can never disagree with the series.
  const cells = byClass(tree, 'mem-heat-cell')
  assert.equal(cells.length % 7, 0, 'whole weeks only')
  const real = cells.filter((cell) => !(cell.props.className ?? '').split(' ').includes('is-void'))
  assert.equal(real.length, activity.days.length, 'every day in the window gets a cell')
  const voids = cells.filter((cell) => (cell.props.className ?? '').split(' ').includes('is-void'))
  assert.ok(voids.length > 0, 'an unaligned window is padded to whole weeks')
  for (const cell of voids) {
    assert.equal(cell.props['aria-hidden'], true, 'a void cell is hidden from AT')
    assert.equal(cell.props.tabIndex, undefined, 'a void cell is not focusable')
  }
  // A 10px cell is far below the 24px focus floor: a tabbable grid would be a
  // keyboard path nobody can use, so the reading stays on the section meta and the
  // cell's aria-label (the native title is gone so the styled tooltip is the only
  // tooltip on the page).
  for (const cell of cells) assert.equal(cell.props.tabIndex, undefined, 'no focusable cell')
  for (const cell of real) {
    assert.match(String(cell.props['aria-label']), /^\d{4}-\d{2}-\d{2} · \d+ 条$/u, 'date · value')
    assert.equal(cell.props.title, undefined, 'the native title is dropped')
    assert.equal(
      nodes(cell).some((node) => node?.type === 'title'),
      false,
      'no inert <title> inside an HTML cell',
    )
    assert.equal(typeof cell.props.onMouseEnter, 'function', 'hover handlers live on the cells')
    assert.equal(typeof cell.props.onMouseLeave, 'function')
  }
  // The GitHub form: a months row above, the sticky weekday gutter beside a fixed
  // 10px-cell grid, all of it inside its own horizontal scroll box.
  assert.equal(byClass(tree, 'mem-heat-scroll').length, 1, 'the calendar scrolls in its own box')
  const canvas = byClass(tree, 'mem-heat-canvas')
  assert.equal(canvas.length, 1)
  assert.match(String(canvas[0].props.style.width), /^\d+px$/u, 'the canvas width is computed')
  const months = byClass(tree, 'mem-heat-month')
  assert.ok(months.length > 0, 'month labels sit above the columns')
  for (const month of months) {
    assert.match(String(month.props.children[0]), /^\d{1,2}月$/u, 'the label is <month>月')
    assert.match(String(month.props.style.left), /^\d+px$/u, 'a label is positioned by its column')
  }
  assert.deepEqual(
    byClass(tree, 'mem-heat-weekday').map((node) => node.props.children[0]),
    ['一', '三', '五'],
    'the sticky gutter labels Monday, Wednesday and Friday',
  )
  assert.equal(byClass(tree, 'mem-heat-frame').length, 1, 'the gutter and the grid share one frame')
  assert.equal(byClass(tree, 'mem-heat-weekdays').length, 1)
  const legend = byClass(tree, 'mem-heat-legend')
  assert.equal(legend.length, 1)
  assert.equal(legend[0].props['aria-hidden'], true, 'the legend is decorative')
  assert.deepEqual(byClass(legend[0], 'mem-heat-swatch').length, 5, 'five buckets, zero included')
  assert.deepEqual(
    byClass(legend[0], 'mem-heat-legend-label').map((node) => node.props.children[0]),
    ['少', '多'],
  )
  // The printed total must equal the series it annotates — that equality is the
  // whole contract the meta text claims.
  const expectedTotal =
    activity.created.reduce((sum, n) => sum + n, 0) +
    activity.updated.reduce((sum, n) => sum + n, 0)
  const sectionNode = nodes(tree).find(
    (node) => node?.type === 'section' && node.props['aria-label'] === '活动热度',
  )
  const metaText = byClass(sectionNode, 'mem-meta').map((node) => node.props.children[0])
  assert.ok(
    metaText.some((text) => /^近 \d+ 周（\d+ 天）· 本周 \d+ 天有更新 · 合计 \d+ 条$/u.test(text)),
    'the meta names the window and states the numbers: ' + metaText.join('|'),
  )
  assert.ok(
    metaText.some((text) => String(text).includes('合计 ' + expectedTotal + ' 条')),
    '合计 equals every event in the window, not the cells that survived padding',
  )
  // Both charts read the same series, so one window cannot produce two totals.
  assert.equal(byClass(tree, 'mem-flow').length, 1, 'the flow chart is drawn from it too')
})

test('the heat map requests the 371-day year once, at any panel width', async (t) => {
  // The fixed calendar wants 53 whole weeks, so the view asks for the trailing year
  // ONCE (HEAT_REQUEST_DAYS) and never refetches on resize: the flow bars keep the
  // width-based window, the heat map does not.
  const year = activityFixture(371)
  const sent = stubFetch(t, () =>
    ok(overviewValue({ activity: year, tags: { items: [], total: 0 } })),
  )
  const realCells = (tree) =>
    byClass(tree, 'mem-heat-cell').filter(
      (cell) => !(cell.props.className ?? '').split(' ').includes('is-void'),
    ).length
  const bars = (tree) =>
    nodes(byClass(tree, 'mem-flow-svg')[0]).filter((node) => node?.type === 'title').length
  const render = mount(t, 'OverviewView')
  render(chartProps())
  await setImmediate()
  const tree = render(chartProps())
  assert.equal(sent.length, 1, 'one read, not one per resize')
  assert.equal(sent[0].body.days, 371, 'the view asks for the trailing year')
  assert.equal(realCells(tree), 371, 'the fixed calendar draws every served day, no trailing slice')
  const lead = new Date(year.days[0] + 'T00:00:00').getDay()
  const columns = Math.ceil((lead + 371) / 7)
  assert.ok(
    countText(tree, '近 ' + columns + ' 周（371 天）') >= 1,
    'the meta names the fixed window',
  )
  const floorBars = bars(tree)

  // A wide mount asks its own live poll for the same 371 days — the request is not a
  // function of width — and still draws all 371 cells.
  const wide = mount(t, 'OverviewView', { sankeyWidth: 631 })
  wide(chartProps())
  await setImmediate()
  const wideTree = wide(chartProps())
  assert.equal(sent.length, 2, 'each mounted view owns one read')
  assert.equal(sent[1].body.days, 371, 'a wide panel asks for the same fixed year')
  assert.equal(realCells(wideTree), 371, 'a resize never slices the heat map')
  assert.ok(bars(wideTree) > floorBars, 'while the flow bars keep their width-based window')
})

test('an older host that answers a shorter window is drawn as-is', async (t) => {
  // Version skew is a supported state (the panel asset and the host plugin upgrade
  // independently): a route that does not know the year window answers 84 days, and
  // a wide panel must draw exactly that window rather than a blank region.
  stubFetch(t, () =>
    ok(overviewValue({ activity: activityFixture(), tags: { items: [], total: 0 } })),
  )
  const render = mount(t, 'OverviewView', { sankeyWidth: 631 })
  render(chartProps())
  await setImmediate()
  const tree = render(chartProps())
  const real = byClass(tree, 'mem-heat-cell').filter(
    (cell) => !(cell.props.className ?? '').split(' ').includes('is-void'),
  )
  assert.equal(real.length, 84, 'the payload window is the ceiling, not the request')
  assert.ok(countText(tree, '近 13 周（84 天）') >= 1, 'and the meta still matches it')
})

test('the heat map starts at the current week and a refresh never yanks the scroll', async (t) => {
  // The first paint must land on the current week (the right end of a fixed year);
  // after that the reader owns the scroll position — a 15s background poll must not
  // drag them back. The ref stub carries the box numbers a DOM would answer.
  stubFetch(t, () =>
    ok(overviewValue({ activity: activityFixture(371), tags: { items: [], total: 0 } })),
  )
  const render = mount(t, 'OverviewView')
  render(chartProps())
  await setImmediate()
  const tree = render(chartProps())
  const ref = byClass(tree, 'mem-heat-scroll')[0].props.ref
  assert.equal(ref.current.scrollLeft, 648, 'the first draw is pinned to the current week')
  // The reader scrolls back to the left; a later data refresh must leave them there.
  ref.current.scrollLeft = 120
  render(chartProps())
  render(chartProps())
  assert.equal(ref.current.scrollLeft, 120, 'a refresh keeps the reader where they scrolled')
})

test('the heat map tooltip is the only hover reading, and scrolling hides it', async (t) => {
  stubFetch(t, () =>
    ok(overviewValue({ activity: activityFixture(371), tags: { items: [], total: 0 } })),
  )
  const render = mount(t, 'OverviewView')
  render(chartProps())
  await setImmediate()
  let tree = render(chartProps())
  const real = byClass(tree, 'mem-heat-cell').filter(
    (cell) => !(cell.props.className ?? '').split(' ').includes('is-void'),
  )
  assert.equal(byClass(tree, 'mem-heat-tip').length, 0, 'no tooltip before a hover')
  const busy = real.find((cell) => /· [1-9]\d* 条$/u.test(String(cell.props['aria-label'])))
  assert.ok(busy, 'the fixture has busy days')
  busy.props.onMouseEnter()
  tree = render(chartProps())
  const tip = byClass(tree, 'mem-heat-tip')
  assert.equal(tip.length, 1, 'the styled tooltip renders while a cell is hovered')
  assert.equal(tip[0].props['aria-hidden'], true, 'it is decorative, never a second announcement')
  assert.match(String(tip[0].props.children[0]), /^\d{4}-\d{2}-\d{2} · [1-9]\d* 条$/u)
  assert.match(String(tip[0].props.style.left), /^\d+px$/u, 'positioned over the hovered cell')
  assert.match(String(tip[0].props.style.top), /^\d+px$/u)
  // A quiet day says 无记录 in the tooltip while its aria-label keeps the honest count.
  const quiet = real.find((cell) => /· 0 条$/u.test(String(cell.props['aria-label'])))
  assert.ok(quiet, 'the fixture has quiet days')
  quiet.props.onMouseEnter()
  tree = render(chartProps())
  assert.match(String(byClass(tree, 'mem-heat-tip')[0].props.children[0]), /· 无记录$/u)
  quiet.props.onMouseLeave()
  tree = render(chartProps())
  assert.equal(byClass(tree, 'mem-heat-tip').length, 0, 'mouseleave hides the tooltip')
  busy.props.onMouseEnter()
  tree = render(chartProps())
  assert.equal(byClass(tree, 'mem-heat-tip').length, 1)
  byClass(tree, 'mem-heat-scroll')[0].props.onScroll()
  tree = render(chartProps())
  assert.equal(byClass(tree, 'mem-heat-tip').length, 0, 'scrolling hides it')
  // The clamp moves the tooltip's BOX, not just its anchor. The stub reports a 120px
  // rendered width in a 292px scroll box, so a right-edge cell must draw at 226px
  // (292 − 60 − 6) and a left-edge cell at 66px (60 + 6) — the measured round-4 defect
  // was the unclamped box hanging ~44px outside the panel at both ends.
  const scroll = byClass(tree, 'mem-heat-scroll')[0]
  scroll.props.ref.current.scrollLeft = 0
  real.at(-1).props.onMouseEnter()
  render(chartProps())
  tree = render(chartProps())
  assert.equal(
    byClass(tree, 'mem-heat-tip')[0].props.style.left,
    '226px',
    'the right edge of the box is clamped inside the scroll box',
  )
  real[0].props.onMouseEnter()
  render(chartProps())
  tree = render(chartProps())
  assert.equal(
    byClass(tree, 'mem-heat-tip')[0].props.style.left,
    '66px',
    'and the left edge too, once the rendered width is measured',
  )
})

test('the flow bars share one zero line and normalise to the larger side', async (t) => {
  const activity = activityFixture()
  stubFetch(t, () => ok(overviewValue({ activity, tags: { items: [], total: 0 } })))
  const render = mount(t, 'OverviewView')
  render(chartProps())
  await setImmediate()
  const tree = render(chartProps())
  const chart = byClass(tree, 'mem-flow')
  assert.equal(chart.length, 1)
  const svgNode = byClass(chart[0], 'mem-flow-svg')[0]
  assert.equal(svgNode.props.role, 'img')
  // One zero line, drawn once, shared by both streams.
  assert.equal(byClass(svgNode, 'mem-flow-zero').length, 1, 'the zero line is drawn once')
  const bars = nodes(svgNode).filter(
    (node) => node?.type === 'rect' && node.props.className?.startsWith('mem-flow-'),
  )
  assert.ok(bars.length > 0, 'the calendar weeks draw bars')
  assert.ok(
    bars.some((bar) => bar.props.className.includes('created')),
    'created is one stream',
  )
  assert.ok(
    bars.some((bar) => bar.props.className.includes('updated')),
    'updated is the other',
  )
  // Every bar starts or ends on the shared zero line: 40 in a 80-unit box.
  for (const bar of bars) {
    const { y, height } = bar.props
    assert.ok(
      Math.abs(y + height - 40) < 0.01 || Math.abs(y - 40) < 0.01,
      'a bar touches the zero line: y=' + y + ' h=' + height,
    )
  }
  // The bar is a plain rectangle, not a rounded one: a rounded corner at the zero
  // line leaves a notch on both streams (the reported defect — a visible gap where
  // created meets updated, and a pill-shaped bar), and rounding styles the data.
  for (const bar of bars)
    assert.equal(
      bar.props.rx,
      undefined,
      'a flow bar is square, found rx on ' + bar.props.className,
    )
  // A week that carries both streams joins them on the shared zero line: created's
  // bottom edge IS updated's top edge, and both are the same eight-unit bar.
  const weeks = new Map()
  for (const bar of bars) {
    const week = weeks.get(bar.props.x) ?? {}
    if (bar.props.className.includes('created')) week.created = bar.props
    else week.updated = bar.props
    weeks.set(bar.props.x, week)
  }
  const both = [...weeks.values()].filter((week) => week.created && week.updated)
  assert.ok(both.length > 0, 'the fixture has a week with both streams, so the join is measured')
  for (const week of both) {
    assert.equal(week.created.y + week.created.height, 40, 'created ends on the zero line')
    assert.equal(week.updated.y, 40, 'updated starts on the zero line')
    assert.equal(week.created.x, week.updated.x, 'the two streams share the bar')
    assert.equal(week.created.width, week.updated.width, 'and its width')
  }
  // sup erseded is a status snapshot, never a dated flow: no third stream exists.
  assert.equal(
    bars.some((bar) => bar.props.className.includes('superseded')),
    false,
    'no archived/superseded series is invented',
  )
  // Design §3.4 item 3 fixes the per-bar reading as `WW 周 · 新建 n · 更新 m`, and a
  // week number is only true if the bar IS that calendar week. This window starts on
  // Friday 2026-08-07 and ends on Thursday 2026-10-29, so it touches thirteen
  // Sunday-first weeks (2 + 11×7 + 5 days): the first bar holds only Aug 7-8 and the
  // last only Oct 25-29. The week numbers and (created, updated) pairs below are
  // re-derived from the fixture's day rule by hand; a trailing seven-day chunk would
  // produce different pairs and label days with a neighbouring week's number.
  const readings = nodes(svgNode)
    .filter((node) => node?.type === 'title')
    .map((node) => {
      const text = String(node.props.children[0])
      const match = /^(\d{2}) 周 · 新建 (\d+) · 更新 (\d+)$/u.exec(text)
      assert.ok(match, 'title is `WW 周 · 新建 n · 更新 m`: ' + text)
      return { week: Number(match[1]), created: Number(match[2]), updated: Number(match[3]) }
    })
  assert.deepEqual(
    readings.map((reading) => reading.week),
    [32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44],
    'one Sunday-first week of 2026 per bar, 32 through 44',
  )
  assert.deepEqual(
    readings.map((reading) => [reading.created, reading.updated]),
    [
      [2, 1],
      [3, 1],
      [4, 1],
      [3, 1],
      [3, 1],
      [3, 2],
      [3, 1],
      [4, 1],
      [3, 1],
      [3, 1],
      [3, 1],
      [3, 2],
      [1, 0],
    ],
    'each bar is exactly one calendar week, partial edge weeks included',
  )
  // Nothing is dropped: the readings sum to the series the window carries.
  const total = (values) => values.reduce((sum, value) => sum + value, 0)
  const createdTotal = total(activity.created)
  const updatedTotal = total(activity.updated)
  assert.equal(total(readings.map((reading) => reading.created)), createdTotal, 'created add up')
  assert.equal(total(readings.map((reading) => reading.updated)), updatedTotal, 'updated add up')
  // The week count and totals are stated numbers derived from the grouping, not
  // hard-coded twelves.
  const flowSection = nodes(tree).find(
    (node) => node?.type === 'section' && node.props['aria-label'] === '新建与更新',
  )
  assert.ok(
    byClass(flowSection, 'mem-meta').some(
      (node) => node.props.children[0] === '近 13 周净增 ' + (createdTotal - updatedTotal),
    ),
    'the meta states the calendar week count and the window net',
  )
  assert.equal(
    svgNode.props['aria-label'],
    '近 13 周新建 ' + createdTotal + ' 条，更新 ' + updatedTotal + ' 条',
    'the image label states the same window',
  )
  assert.equal(byClass(chart[0], 'mem-flow-legend').length, 1)
  assert.equal(byClass(chart[0], 'mem-flow-legend')[0].props['aria-hidden'], true)
})

test('every flow bar covers exactly one Sunday-first calendar week', async (t) => {
  // Day i is given the count i + 1, so a bar's total identifies precisely which days
  // it grouped. A calendar week is a contiguous in-window run, so the thirteen bar
  // totals are fixed; the old trailing seven-day chunks would group a 6-day head and
  // 7-day middles instead, producing different sums for the same window.
  const base = activityFixture()
  const activity = {
    from: base.days[0],
    to: base.days.at(-1),
    days: base.days,
    created: base.days.map((_day, index) => index + 1),
    updated: base.days.map(() => 0),
  }
  stubFetch(t, () => ok(overviewValue({ activity, tags: { items: [], total: 0 } })))
  const render = mount(t, 'OverviewView')
  render(chartProps())
  await setImmediate()
  const tree = render(chartProps())
  const svgNode = byClass(tree, 'mem-flow-svg')[0]
  const created = nodes(svgNode)
    .filter((node) => node?.type === 'title')
    .map((node) =>
      Number(/(\d+) 周 · 新建 (\d+) · 更新 \d+/u.exec(String(node.props.children[0]))[2]),
    )
  assert.deepEqual(
    created,
    [3, 42, 91, 140, 189, 238, 287, 336, 385, 434, 483, 532, 410],
    'a 2-day head, eleven whole weeks, then a 5-day tail',
  )
  assert.equal(
    created.reduce((sum, value) => sum + value, 0),
    (84 * 85) / 2,
    'the bars between them keep every day in the window',
  )
})

test('the flow bars drop leading all-zero weeks so the first bar starts at the left', async (t) => {
  // A wide panel draws a 26-week window, but a vault that only became active six
  // weeks ago used to render twenty empty weeks and six bars squeezed against the
  // right edge. Leading all-zero weeks are dropped (interior and trailing weeks are
  // never touched), so the first drawn bar sits at x = 0; the meta names the trimmed
  // window while the totals still cover every week.
  const base = activityFixture(182)
  // 182 days ending Thursday 2026-10-29 start on a Friday, so the calendar spans 27
  // Sunday-first columns and only the last six (day indexes 142..181) carry data.
  const activity = {
    ...base,
    created: base.days.map((_day, index) => (index >= 142 ? 1 : 0)),
    updated: base.days.map(() => 0),
  }
  stubFetch(t, () => ok(overviewValue({ activity, tags: { items: [], total: 0 } })))
  const render = mount(t, 'OverviewView', { sankeyWidth: 631 })
  render(chartProps())
  await setImmediate()
  const tree = render(chartProps())
  const svgNode = byClass(tree, 'mem-flow-svg')[0]
  const bars = nodes(svgNode).filter(
    (node) => node?.type === 'rect' && node.props.className?.startsWith('mem-flow-'),
  )
  assert.equal(bars.length, 6, 'six non-empty calendar weeks draw six bars')
  assert.equal(bars[0].props.x, 0, 'the first bar starts at the left edge')
  assert.deepEqual(
    bars.map((bar) => bar.props.x),
    [0, 12, 24, 36, 48, 60],
    'the bars keep the 8px bar + 4px gap pitch',
  )
  const titles = nodes(svgNode)
    .filter((node) => node?.type === 'title')
    .map((node) => String(node.props.children[0]))
  assert.deepEqual(
    titles.map((text) => /新建 (\d+)/u.exec(text)[1]),
    ['7', '7', '7', '7', '7', '5'],
    'the last six calendar weeks, partial tail included',
  )
  const flowSection = nodes(tree).find(
    (node) => node?.type === 'section' && node.props['aria-label'] === '新建与更新',
  )
  assert.ok(
    byClass(flowSection, 'mem-meta').some((node) => node.props.children[0] === '近 6 周净增 40'),
    'the meta names the trimmed window and the full-window net',
  )
  assert.equal(
    svgNode.props['aria-label'],
    '近 6 周新建 40 条，更新 0 条',
    'the image label follows the trimmed window',
  )
})

test('a short flow window caps the drawn bar width instead of stretching it', async (t) => {
  // The bars live in a viewBox and the svg is width:100% with preserveAspectRatio:none,
  // so a six-bar window used to stretch each 8-unit bar into a ~65-100px blocky band on
  // a wide panel. The cap is 3x the viewBox width: the 8-unit bar can never draw wider
  // than 24px on screen, and the svg stays left-aligned in its column. The cap only ever
  // trims SHORT windows: a long window's cap is larger than any panel body, so
  // width:100% still fills it (measured widths 320-720, content box up to 692px).
  const base = activityFixture(182)
  const short = {
    ...base,
    created: base.days.map((_day, index) => (index >= 142 ? 1 : 0)),
    updated: base.days.map(() => 0),
  }
  let reply = ok(overviewValue({ activity: short, tags: { items: [], total: 0 } }))
  stubFetch(t, () => reply)
  const render = mount(t, 'OverviewView', { sankeyWidth: 631 })
  render(chartProps())
  await setImmediate()
  const tree = render(chartProps())
  const svgNode = byClass(tree, 'mem-flow-svg')[0]
  const viewBoxWidth = Number(String(svgNode.props.viewBox).split(' ')[2])
  assert.equal(viewBoxWidth, 68, 'six weeks of 8px bar + 4px gap')
  assert.equal(svgNode.props.style.maxWidth, '204px', 'the cap is 3x the 68-unit viewBox')
  assert.ok(
    (8 * Number.parseFloat(svgNode.props.style.maxWidth)) / viewBoxWidth <= 24,
    'the widest on-screen bar stays at most 24px',
  )
  // A 26-week window (the widest width-based window) spans 27 Sunday-first columns for
  // this fixture, so its cap is 960px — above the 720px panel's 692px body, which keeps
  // width:100% in charge and the chart filling the body.
  reply = ok(overviewValue({ activity: activityFixture(371), tags: { items: [], total: 0 } }))
  const long = mount(t, 'OverviewView', { sankeyWidth: 631 })
  long(chartProps())
  await setImmediate()
  const longSvg = byClass(long(chartProps()), 'mem-flow-svg')[0]
  const longViewBox = Number(String(longSvg.props.viewBox).split(' ')[2])
  assert.equal(longViewBox, 320, 'a 26-week window spans 27 Sunday-first columns here')
  assert.equal(longSvg.props.style.maxWidth, '960px', 'a long window keeps width:100% in charge')
  assert.ok(
    Number.parseFloat(longSvg.props.style.maxWidth) >= 692,
    'the cap never limits a 320-720px panel body',
  )
})

test('the week-of-year convention numbers the week containing January 1 as 01', async (t) => {
  // Sunday-first weeks, week 1 = the Sun-Sat week containing 1 January. Jan 1 2027 is
  // a Friday, so that week starts Sunday 2026-12-27 and numbers 01 there; Dec 20 2026
  // (the Sunday before) is week 52, and 2027-01-03 is week 02.
  const days = []
  for (let offset = 0; offset < 21; offset += 1) {
    const date = new Date(2026, 11, 20)
    date.setDate(date.getDate() + offset)
    const pad = (n) => String(n).padStart(2, '0')
    days.push(date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()))
  }
  const activity = {
    from: days[0],
    to: days[20],
    days,
    created: days.map(() => 1),
    updated: days.map(() => 0),
  }
  stubFetch(t, () => ok(overviewValue({ activity, tags: { items: [], total: 0 } })))
  const render = mount(t, 'OverviewView')
  render(chartProps())
  await setImmediate()
  const tree = render(chartProps())
  const titles = nodes(byClass(tree, 'mem-flow-svg')[0])
    .filter((node) => node?.type === 'title')
    .map((node) => node.props.children[0])
  assert.deepEqual(titles, [
    '52 周 · 新建 7 · 更新 0',
    '01 周 · 新建 7 · 更新 0',
    '02 周 · 新建 7 · 更新 0',
  ])
})

test('the sparkline samples twelve weekly cumulative points from created', async (t) => {
  const activity = activityFixture()
  stubFetch(t, () => ok(overviewValue({ activity, tags: { items: [], total: 0 } })))
  const render = mount(t, 'OverviewView')
  render(chartProps())
  await setImmediate()
  const tree = render(chartProps())
  const spark = byClass(tree, 'mem-kpi-spark')
  assert.equal(spark.length, 1, 'the 记忆条目 cell carries the growth shape')
  assert.equal(
    spark[0].props['aria-hidden'],
    true,
    'the shape is decorative; the number is the reading',
  )
  const polyline = nodes(spark[0]).find((node) => node?.type === 'polyline')
  assert.ok(polyline, 'the sparkline is one polyline')
  const points = String(polyline.props.points)
    .trim()
    .split(/\s+/u)
    .map((pair) => pair.split(',').map(Number))
  // Design §3.4 item 1 asks for a 12-point line. One point per day drew 84 points in
  // a 60×16 box — a step thirty times finer than the box can resolve.
  assert.equal(points.length, 12, 'twelve weekly points for an 84-day window')
  assert.equal(points[0][0], 0, 'the line starts at the left edge')
  assert.equal(points.at(-1)[0], 60, 'and ends at the right edge')
  // Hard-coded from the fixture's day rule, not recomputed with the implementation's
  // loop: a day whose index is a multiple of 7 contributes 2 and one whose index is a
  // multiple of 5 contributes 1 (two such days can share one week), so the twelve
  // weekly `created` sums are 3,3,4,3,3,3,3,4,3,3,3,3. The line is scaled to its own
  // total, so each plotted value is recovered from its y and compared.
  const expected = [3, 6, 10, 13, 16, 19, 22, 26, 29, 32, 35, 38]
  const createdTotal = activity.created.reduce((sum, n) => sum + n, 0)
  assert.equal(expected.at(-1), createdTotal, 'the hard-coded series ends at the created total')
  const plotted = points.map(([, y]) => ((16 - y) / 16) * createdTotal)
  plotted.forEach((value, index) =>
    assert.ok(
      Math.abs(value - expected[index]) < 0.15,
      'point ' + index + ' plots ' + expected[index] + ', got ' + value,
    ),
  )
  assert.ok(Math.abs(plotted.at(-1) - createdTotal) < 0.001, 'the last point is the created total')
  assert.ok(
    plotted.every((value, index) => index === 0 || value >= plotted[index - 1]),
    'the running total never drops',
  )
})

test('a 30-day sparkline window groups its days from the window end', async (t) => {
  // 30 days is four full weeks plus two days, so the grouping direction is observable:
  // a trailing resample puts the two-day chunk first (cumulative 1,4,7,10,13), while a
  // start-aligned one would put it last (4,7,9,13,13). The sparkline's contract is a
  // bounded decorative series of weekly marks, so it keeps its own trailing resample —
  // deliberately not the calendar weeks the flow bars draw.
  const base = activityFixture()
  const activity = {
    ...base,
    from: base.days.slice(-30)[0],
    to: base.days.at(-1),
    days: base.days.slice(-30),
    created: base.created.slice(-30),
    updated: base.updated.slice(-30),
  }
  stubFetch(t, () => ok(overviewValue({ activity, tags: { items: [], total: 0 } })))
  const render = mount(t, 'OverviewView')
  render(chartProps())
  await setImmediate()
  const tree = render(chartProps())
  const polyline = nodes(byClass(tree, 'mem-kpi-spark')[0]).find(
    (node) => node?.type === 'polyline',
  )
  const points = String(polyline.props.points)
    .trim()
    .split(/\s+/u)
    .map((pair) => pair.split(',').map(Number))
  assert.equal(points.length, 5, 'four weeks plus the two-day tail is five points')
  const total = activity.created.reduce((sum, n) => sum + n, 0)
  assert.equal(total, 13, 'the window carries 13 new notes')
  const plotted = points.map(([, y]) => ((16 - y) / 16) * total)
  ;[1, 4, 7, 10, 13].forEach((value, index) =>
    assert.ok(
      Math.abs(plotted[index] - value) < 0.1,
      'point ' + index + ' plots ' + value + ', got ' + plotted[index],
    ),
  )
})

test('a window that cannot hold two weekly points draws no sparkline', async (t) => {
  const full = activityFixture()
  const short = {
    ...full,
    days: full.days.slice(-7),
    created: [0, 0, 0, 0, 0, 0, 4],
    updated: [0, 0, 0, 0, 0, 0, 0],
  }
  stubFetch(t, () => ok(overviewValue({ activity: short, tags: { items: [], total: 0 } })))
  const render = mount(t, 'OverviewView')
  render(chartProps())
  await setImmediate()
  const tree = render(chartProps())
  // Seven days is exactly one weekly point, and a one-point line has no shape: the
  // cell shows the number alone rather than a single dot.
  assert.equal(byClass(tree, 'mem-kpi-spark').length, 0)
})

test('a window longer than the panel draws is sliced, and the sparkline totals the drawn window', async (t) => {
  // The wire can carry more days than the charts draw: a wide panel asks the route for
  // 26 weeks, an older host might answer a year. The view slices the trailing days to
  // the measured body first, so the calendar, the flow bars and this cumulative line
  // all read one window — and "at most twelve points" holds on the DRAWN window.
  const end = new Date(2026, 9, 29)
  const days = []
  for (let offset = 364; offset >= 0; offset -= 1) {
    const date = new Date(end)
    date.setDate(date.getDate() - offset)
    const pad = (n) => String(n).padStart(2, '0')
    days.push(date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()))
  }
  // One created note per day: the 365-day payload carries 365, each drawn window its own.
  const activity = {
    from: days[0],
    to: days[364],
    days,
    created: days.map(() => 1),
    updated: days.map(() => 0),
  }
  const sparkPoints = (tree) => {
    const polyline = nodes(byClass(tree, 'mem-kpi-spark')[0]).find(
      (node) => node?.type === 'polyline',
    )
    return String(polyline.props.points)
      .trim()
      .split(/\s+/u)
      .map((pair) => pair.split(',').map(Number))
  }
  stubFetch(t, () => ok(overviewValue({ activity, tags: { items: [], total: 0 } })))
  const render = mount(t, 'OverviewView')
  render(chartProps())
  await setImmediate()
  const tree = render(chartProps())
  const points = sparkPoints(tree)
  assert.equal(points.length, 12, 'a 365-day wire still plots at most twelve points')
  // The default 292px body draws 84 days: twelve whole weeks, so no head folds and
  // the line closes on the window's own 84 created notes (not the payload's 365).
  const plotted = points.map(([, y]) => ((16 - y) / 16) * 84)
  ;[7, 14, 21, 28, 35, 42, 49, 56, 63, 70, 77, 84].forEach((value, index) =>
    assert.ok(
      Math.abs(plotted[index] - value) < 0.3,
      'point ' + index + ' plots the drawn window total ' + value + ', got ' + plotted[index],
    ),
  )
  assert.ok(Math.abs(points.at(-1)[1]) < 0.001, 'the last point is the drawn window total')
  for (let index = 1; index < points.length; index += 1)
    assert.ok(points[index][1] <= points[index - 1][1] + 0.001, 'the running total never drops')
  // A wide body draws 182 days; 26 weekly chunks fold the oldest 15 weeks into point one,
  // and the line still closes on the drawn window (182 created notes over 182 days).
  const wide = mount(t, 'OverviewView', { sankeyWidth: 631 })
  wide(chartProps())
  await setImmediate()
  const widePoints = sparkPoints(wide(chartProps()))
  assert.equal(widePoints.length, 12, 'the wide window is still twelve points')
  const widePlotted = widePoints.map(([, y]) => ((16 - y) / 16) * 182)
  assert.ok(Math.abs(widePlotted[0] - (182 - 11 * 7)) < 0.5, 'the wide head folds into point one')
  assert.ok(Math.abs(widePlotted.at(-1) - 182) < 0.5, 'and the tail is the whole 182-day window')
})

test('an all-zero window renders an empty sentence with its own week count', async (t) => {
  const flat = activityFixture()
  flat.created = flat.created.map(() => 0)
  flat.updated = flat.updated.map(() => 0)
  stubFetch(t, () => ok(overviewValue({ activity: flat, tags: { items: [], total: 0 } })))
  const render = mount(t, 'OverviewView')
  render(chartProps())
  await setImmediate()
  const tree = render(chartProps())
  assert.equal(byClass(tree, 'mem-flow-svg').length, 0, 'a zero window draws no bars')
  // The empty sentence counts the same calendar weeks the drawn chart would: the
  // 84-day fixture spans 13, not the static "12" the copy used to say.
  assert.equal(countText(tree, '近 13 周没有新建或更新记录。'), 1, 'the empty sentence, once')
  assert.equal(countText(tree, '近 12 周没有新建或更新记录。'), 0, 'never a hard-coded 12')
  assert.equal(byClass(tree, 'mem-kpi-spark').length, 0, 'a zero total has no shape to draw')
  // The heat map still draws: a zero window is a real reading, not a missing one.
  assert.equal(byClass(tree, 'mem-heat-grid').length, 1)
})

test('the empty-flow sentence names the short window’s own week count', async (t) => {
  // A 30-day window starting Wednesday 2026-09-30 touches five Sunday-first weeks, so
  // the empty state must derive its count from the grouping too: 5, not 13 or 12.
  const full = activityFixture()
  const activity = {
    ...full,
    from: full.days.slice(-30)[0],
    to: full.days.at(-1),
    days: full.days.slice(-30),
    created: full.created.slice(-30).map(() => 0),
    updated: full.updated.slice(-30).map(() => 0),
  }
  stubFetch(t, () => ok(overviewValue({ activity, tags: { items: [], total: 0 } })))
  const render = mount(t, 'OverviewView')
  render(chartProps())
  await setImmediate()
  const tree = render(chartProps())
  assert.equal(byClass(tree, 'mem-flow-svg').length, 0, 'a zero window draws no bars')
  assert.equal(countText(tree, '近 5 周没有新建或更新记录。'), 1, 'five calendar weeks, once')
})

// ---------------------------------------------------------------------------
// 最近变化 as a GitHub contribution-activity rail (item 4). One group per updated
// calendar day, newest first, read from the string's own date parts: a bare
// `YYYY-MM-DD` must never go through Date.parse, because that parses as UTC
// and shifts the day in every non-UTC zone.
// ---------------------------------------------------------------------------

/** A local calendar day, offset from today, as the wire's YYYY-MM-DD. */
function calendarDayFromToday(offset) {
  const date = new Date()
  date.setDate(date.getDate() + offset)
  const pad = (n) => String(n).padStart(2, '0')
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
}

test('最近变化 is a contribution-activity rail grouped by calendar day', async (t) => {
  const today = calendarDayFromToday(0)
  const yesterday = calendarDayFromToday(-1)
  const recent = [
    {
      path: 't2.md',
      title: '今天第二条',
      type: 'decision',
      status: 'active',
      updated: today + 'T23:30:00.000Z',
    },
    { path: 't1.md', title: '今天第一条', type: 'convention', status: 'accepted', updated: today },
    { path: 'y1.md', title: '昨天那条', type: 'gotcha', status: 'provisional', updated: yesterday },
    {
      path: 'o2.md',
      title: '旧日期带时间',
      type: 'doc',
      status: 'superseded',
      updated: '2020-01-02T23:30:00.000Z',
    },
    { path: 'o1.md', title: '旧日期', type: 'glossary', status: '', updated: '2020-01-02' },
    { path: 'u1.md', title: '没有日期', type: 'log', status: 'archived', updated: null },
  ]
  stubFetch(t, () => ok(overviewValue({ activity: null, tags: null, recent })))
  const render = mount(t, 'OverviewView')
  render(chartProps())
  await setImmediate()
  const tree = render(chartProps())
  const timeline = byClass(tree, 'mem-timeline')
  assert.equal(timeline.length, 1, 'one rail timeline')
  assert.equal(timeline[0].type, 'ol', 'the rail is an ordered list')
  assert.equal(byClass(tree, 'mem-recent-row').length, 0, 'the flat list is retired')
  assert.equal(byClass(tree, 'mem-dot').length, 0, 'and its dot rule with it')
  const groups = byClass(tree, 'mem-timeline-group')
  assert.equal(groups.length, 4, 'one group per calendar day plus the unknown bucket')
  assert.deepEqual(
    byClass(tree, 'mem-timeline-date').map((node) => node.props.children[0]),
    ['今天', '昨天', '2020-01-02', '未知'],
    'newest first, the unknown bucket last',
  )
  assert.deepEqual(
    byClass(tree, 'mem-timeline-count').map((node) => node.props.children[0]),
    ['2 条', '1 条', '2 条', '1 条'],
    'each group states how many updates it holds',
  )
  // A timestamp groups by its own date part, not by the UTC instant: 23:30Z on
  // 2020-01-02 belongs beside the bare 2020-01-02 row in every timezone.
  assert.deepEqual(
    byClass(groups[2], 'mem-timeline-title').map((node) => node.props.children[0]),
    ['旧日期带时间', '旧日期'],
    'the date part groups a timestamp with the bare date',
  )
  assert.deepEqual(
    byClass(groups[0], 'mem-timeline-title').map((node) => node.props.children[0]),
    ['今天第二条', '今天第一条'],
    'items keep the quiet order the wire sent',
  )
  assert.deepEqual(
    byClass(groups[0], 'mem-timeline-meta').map((node) => node.props.children[0]),
    ['决策 · 生效', '约定 · 已采纳'],
    'the meta is type · status',
  )
  assert.deepEqual(
    byClass(groups[1], 'mem-timeline-meta').map((node) => node.props.children[0]),
    ['踩坑 · 待确认'],
  )
  assert.deepEqual(
    byClass(groups[2], 'mem-timeline-meta').map((node) => node.props.children[0]),
    ['文档 · 已取代', '术语表 · 未标注'],
    'a row with no status says 未标注 once',
  )
  assert.deepEqual(
    byClass(groups[3], 'mem-timeline-meta').map((node) => node.props.children[0]),
    ['日志 · 已归档'],
  )
  // One node per group, each holding the inline note glyph; every item a 6px dot.
  for (const group of groups) {
    assert.equal(byClass(group, 'mem-timeline-node').length, 1, 'one node per group')
    assert.ok(
      nodes(group).some((node) => node?.type === 'svg'),
      'the node holds the inline note glyph',
    )
  }
  assert.equal(byClass(tree, 'mem-timeline-item').length, 6, 'every row is one item')
  assert.equal(byClass(tree, 'mem-timeline-dot').length, 6, 'every item carries its dot')
  assert.equal(byClass(tree, 'mem-timeline-body').length, 4, 'each group owns one body')
  // The section head keeps its jump action.
  const sectionNode = nodes(tree).find(
    (node) => node?.type === 'section' && node.props['aria-label'] === '最近变化',
  )
  assert.ok(sectionNode, 'the block is still 最近变化')
})

/** A minimal activity series: only the given day offsets carry changes. */
function activityOnDays(totalsByOffset) {
  const offsets = Object.keys(totalsByOffset).map(Number)
  const days = []
  const created = []
  const updated = []
  for (let offset = Math.min(...offsets); offset <= Math.max(...offsets); offset += 1) {
    days.push(calendarDayFromToday(offset))
    created.push(totalsByOffset[offset] ?? 0)
    updated.push(0)
  }
  return { from: days[0], to: days.at(-1), days, created, updated }
}

test('a busy day prints its activity total with a sample hint', async (t) => {
  // The route samples at most two rows per day while the day itself can hold dozens of
  // changes (the live digest said 45 created in the last day). The count must be the
  // DAY's total from the activity series, with a quiet hint when the rows are a sample.
  const today = calendarDayFromToday(0)
  const yesterday = calendarDayFromToday(-1)
  const older = calendarDayFromToday(-5)
  const quiet = calendarDayFromToday(-2) // activity, but no sampled row
  const recent = [
    { path: 't2.md', title: '今天第二条', type: 'decision', status: 'active', updated: today },
    { path: 't1.md', title: '今天第一条', type: 'convention', status: 'accepted', updated: today },
    { path: 'y2.md', title: '昨天第二条', type: 'decision', status: 'active', updated: yesterday },
    {
      path: 'y1.md',
      title: '昨天第一条',
      type: 'gotcha',
      status: 'provisional',
      updated: yesterday,
    },
    { path: 'o2.md', title: '更早第二条', type: 'doc', status: 'superseded', updated: older },
    { path: 'o1.md', title: '更早第一条', type: 'glossary', status: 'active', updated: older },
    { path: 'u1.md', title: '没有日期', type: 'log', status: 'archived', updated: null },
  ]
  stubFetch(t, () =>
    ok(
      overviewValue({
        activity: activityOnDays({ 0: 45, '-1': 7, '-2': 4, '-5': 2 }),
        tags: null,
        recent,
      }),
    ),
  )
  const render = mount(t, 'OverviewView')
  render(chartProps())
  await setImmediate()
  const tree = render(chartProps())
  const groups = byClass(tree, 'mem-timeline-group')
  assert.equal(groups.length, 4, 'three sampled days plus 未知')
  assert.deepEqual(
    byClass(tree, 'mem-timeline-date').map((node) => node.props.children[0]),
    ['今天', '昨天', older, '未知'],
    'newest first, 未知 last',
  )
  assert.deepEqual(
    byClass(tree, 'mem-timeline-count').map((node) => node.props.children[0]),
    ['共 45 条', '共 7 条', '2 条', '1 条'],
    'a sampled day states its total; a whole-truth group keeps its own count',
  )
  assert.deepEqual(
    byClass(tree, 'mem-timeline-more').map((node) => node.props.children[0]),
    ['仅显示最近 2 条', '仅显示最近 2 条'],
    'a sampled day says so once',
  )
  assert.equal(byClass(groups[0], 'mem-timeline-title').length, 2, 'the sampled rows stay listed')
  assert.deepEqual(
    byClass(groups[1], 'mem-timeline-title').map((node) => node.props.children[0]),
    ['昨天第二条', '昨天第一条'],
    'yesterday keeps its own rows',
  )
  // The unsampled day has activity but NO sampled row: aggregates are the worst-case
  // fallback only, so with several sampled days it must not appear.
  assert.equal(
    byClass(tree, 'mem-timeline-date').some((node) => node.props.children[0] === quiet),
    false,
    'no aggregate day when the sample already spans several days',
  )
})

test('when every sampled row is today, two older active days are aggregated', async (t) => {
  // The reported live bug: the newest 8 notes were all from today, so the rail showed
  // only 今天 although yesterday and the days before had changes. Up to two older days
  // with activity and no sampled row are unioned as aggregate-only groups.
  const today = calendarDayFromToday(0)
  const twoDaysAgo = calendarDayFromToday(-2)
  const threeDaysAgo = calendarDayFromToday(-3)
  const recent = [
    ...Array.from({ length: 7 }, (_x, index) => ({
      path: 't' + index + '.md',
      title: '今天第 ' + (index + 1) + ' 条',
      type: 'decision',
      status: 'active',
      updated: today,
    })),
    { path: 'u1.md', title: '没有日期', type: 'log', status: 'archived', updated: null },
  ]
  stubFetch(t, () =>
    ok(
      overviewValue({
        activity: activityOnDays({ 0: 45, '-1': 7, '-2': 3, '-3': 2 }),
        tags: null,
        recent,
      }),
    ),
  )
  const render = mount(t, 'OverviewView')
  render(chartProps())
  await setImmediate()
  const tree = render(chartProps())
  const groups = byClass(tree, 'mem-timeline-group')
  assert.deepEqual(
    byClass(tree, 'mem-timeline-date').map((node) => node.props.children[0]),
    ['今天', '昨天', twoDaysAgo, '未知'],
    'the two newest older active days are aggregated; 未知 stays last',
  )
  assert.deepEqual(
    byClass(tree, 'mem-timeline-count').map((node) => node.props.children[0]),
    ['共 45 条', '共 7 条', '共 3 条', '1 条'],
  )
  // An aggregate day lists nothing, but keeps the rail node/date/count geometry.
  for (const group of [groups[1], groups[2]]) {
    assert.equal(byClass(group, 'mem-timeline-node').length, 1, 'an aggregate group keeps its node')
    assert.ok(nodes(group).some((node) => node?.type === 'svg'))
    assert.equal(byClass(group, 'mem-timeline-items').length, 0, 'no item list')
    assert.equal(byClass(group, 'mem-timeline-item').length, 0)
    assert.equal(byClass(group, 'mem-timeline-more').length, 0, 'the count IS the whole day')
  }
  assert.equal(
    byClass(tree, 'mem-timeline-item').length,
    8,
    'only the sampled rows are items: seven today plus the undated row',
  )
  assert.equal(
    byClass(tree, 'mem-timeline-date').some((node) => node.props.children[0] === threeDaysAgo),
    false,
    'only two aggregate days are added',
  )
  assert.equal(byClass(groups[0], 'mem-timeline-more').length, 1, 'today keeps its sample hint')
})

test('an empty 最近变化 keeps its sentence instead of drawing an empty rail', async (t) => {
  stubFetch(t, () => ok(overviewValue({ activity: null, tags: null, recent: [] })))
  const render = mount(t, 'OverviewView')
  render(chartProps())
  await setImmediate()
  const tree = render(chartProps())
  assert.equal(byClass(tree, 'mem-timeline').length, 0, 'no rail for no rows')
  assert.equal(countText(tree, '还没有可显示的记录。'), 1, 'the empty sentence, once')
})

// ---------------------------------------------------------------------------
// 标签频率 as a squarified treemap. The chart's one quantitative channel is AREA,
// so every expectation below recomputes an area from the tile's own percentages
// and compares it with the tag's share — the layout is never taken on trust.
// ---------------------------------------------------------------------------

/**
 * The tiles of the 标签频率 treemap, in reading order, with their geometry.
 *
 * The layout runs in MEASURED pixel space — the map's box is the measured block
 * width by a height derived from it — so every style value here is a plain CSS
 * pixel string and the map's own inline height is the rectangle the tiles divide.
 * Reading percentages would silently rescale every area, which is exactly the
 * class of mistake this test exists to catch.
 */
function treemapTiles(tree) {
  return byClass(tree, 'mem-treemap-tile').map((node) => {
    const style = node.props.style
    const px = (value) => Number.parseFloat(String(value))
    const w = px(style.width)
    const h = px(style.height)
    return {
      node,
      tag: byClass(node, 'mem-treemap-name').map((name) => name.props.children[0])[0] ?? null,
      value: byClass(node, 'mem-treemap-value').map((label) => label.props.children[0])[0] ?? null,
      left: px(style.left),
      top: px(style.top),
      w,
      h,
      area: w * h,
      minor: (node.props.className ?? '').split(' ').includes('is-minor'),
      rank: (node.props.className ?? '').split(' ').find((name) => name.startsWith('is-rank')),
      title: node.props.title,
    }
  })
}

/** The rectangle the treemap divides: its measured width by its derived height. */
function treemapBox(tree) {
  const map = byClass(tree, 'mem-treemap')[0]
  const height = Number.parseFloat(String(map?.props.style?.height))
  // The component's default seed is the 292px design floor; the payload's own
  // measured width replaces it in the host, and the test asserts the seed.
  const width = Number.parseFloat(String(map?.props.style?.width)) || 292
  return { width, height, area: width * height }
}

test('the tag frequency chart is a treemap whose areas are the tag counts', async (t) => {
  // Ten distinct tags, five occurrences each; only the console payload's own
  // limit decides how many arrive, and the view must draw whatever it is given.
  const items = Array.from({ length: 10 }, (_x, index) => ({
    tag: 'dsh-mem/tag-' + index,
    n: 5,
  }))
  stubFetch(t, () =>
    ok(
      overviewValue({
        activity: activityFixture(),
        tags: { items, total: 50, distinct: 10 },
      }),
    ),
  )
  const render = mount(t, 'OverviewView')
  render(chartProps())
  await setImmediate()
  const tree = render(chartProps())

  // One chart, one image role, one label that states both units.
  assert.equal(byClass(tree, 'mem-freq-row').length, 0, 'the old eight-row list is gone')
  const treemap = byClass(tree, 'mem-treemap')
  assert.equal(treemap.length, 1, 'one treemap surface')
  assert.equal(treemap[0].props.role, 'img', 'the whole map is one image')
  assert.equal(
    treemap[0].props['aria-label'],
    '标签频率：10 个标签，共 50 次',
    'the image label names the tag count and the occurrence count, in their own units',
  )

  const tiles = treemapTiles(tree)
  assert.equal(tiles.length, 10, 'every tag the payload carries gets a tile')
  // Areas sum to the container and are proportional to the counts. Five
  // occurrences each means ten equal tiles, so each area is a tenth of the map's
  // own measured box — the rectangle the layout actually divided.
  const box = treemapBox(tree)
  assert.ok(box.height > 0, 'the map states its own height: ' + box.height)
  const mapArea = box.area
  const totalArea = tiles.reduce((sum, tile) => sum + tile.area, 0)
  assert.ok(
    Math.abs(totalArea - mapArea) < 0.5,
    'the tiles tile the map exactly: ' + totalArea + ' vs ' + mapArea,
  )
  for (const tile of tiles)
    assert.ok(
      Math.abs(tile.area - mapArea / 10) < 0.5,
      'a tile is a tenth of the map: ' + tile.area,
    )
  // No two tiles overlap: the layout's other promise. A percentage layout that
  // double-counted a cell would still sum to 100% and look wrong only visually.
  for (let i = 0; i < tiles.length; i += 1)
    for (let j = i + 1; j < tiles.length; j += 1) {
      const a = tiles[i]
      const b = tiles[j]
      const overlapX = Math.min(a.left + a.w, b.left + b.w) - Math.max(a.left, b.left)
      const overlapY = Math.min(a.top + a.h, b.top + b.h) - Math.max(a.top, b.top)
      assert.ok(overlapX <= 0.01 || overlapY <= 0.01, 'tiles never overlap: ' + i + ' vs ' + j)
    }
  // Each tile names its tag and states its count, and the count is the same
  // number the payload carried — no tile reads an estimate off its area.
  for (const tile of tiles) {
    assert.equal(tile.value, '5', 'the tile prints its own count')
    assert.match(String(tile.title), /^dsh-mem\/tag-\d · 5 次$/u, 'the native title is the reading')
  }
  assert.ok(
    tiles.filter((tile) => tile.tag !== null).length === 10,
    'ten 100×148-ish tiles all fit a name',
  )
  // Rank colour is identity only (0 = biggest) and the palette is six deep: a
  // seventh tint would be the same colour twice, which reads as a duplicate band,
  // so every tile past the fifth shares the last rank. Equal counts keep the
  // payload's own order — the sort belongs to the index, not to this view.
  assert.deepEqual(
    tiles.map((tile) => tile.rank),
    Array.from({ length: 10 }, (_x, index) => 'is-rank' + Math.min(index, 5)),
    'ranks follow the payload order and stop at the palette depth',
  )
  // The full list is in the accessibility tree, not only in a tooltip. It is the
  // 标签频率 section's own list — the heat map also owns a `mem-sr` span per cell —
  // so the lookup starts at that section rather than at the view root.
  const frequency = nodes(tree).find(
    (node) => node?.type === 'section' && node.props['aria-label'] === '标签频率',
  )
  assert.ok(frequency, 'the 标签频率 section exists')
  const spoken = byClass(frequency, 'mem-sr').map((node) => String(node.props.children[0]))
  assert.equal(spoken.length, 1, 'one screen-reader list')
  for (let index = 0; index < 10; index += 1)
    assert.ok(spoken[0].includes('dsh-mem/tag-' + index + ' 5'), 'the list names tag ' + index)

  // The two printed numbers are each in their own unit. The occurrence count is
  // the section meta's readable text; the tag count is the image label's, because
  // a shape cannot be counted by eye and the `role="img"` label is what states it.
  assert.equal(countText(tree, '50 次'), 1, 'occurrences are labelled 次 and printed once')
  assert.equal(countText(tree, '10 个标签'), 0, 'the tag count is not scattered through the body')
  assert.equal(countText(tree, '另有'), 0, 'every tag is drawn, so no remainder is claimed')
  assert.equal(countText(tree, '另有 10 个标签'), 0, 'never the occurrences they hold')
})

test('without a flow, the composition falls back to the capped bar and legend', async (t) => {
  // The fallback path: no `flow` on the wire (an older host, or the trimmer having
  // dropped the whole flow). Seven types, which is what a real vault looks like.
  // The previous guard asserted `<= 3` against a THREE-type fixture, so it passed
  // without testing a cap at all — while the code emitted one segment per type and
  // aliased the seventh back to the first colour. A guard is only a guard when its
  // input exceeds the limit.
  const byType = [
    { type: 'convention', n: 30 },
    { type: 'decision', n: 20 },
    { type: 'doc', n: 10 },
    { type: 'gotcha', n: 6 },
    { type: 'hub', n: 3 },
    { type: 'glossary', n: 2 },
    { type: 'misc', n: 1 },
  ]
  stubFetch(t, () =>
    ok(
      overviewValue({
        activity: activityFixture(),
        counts: {
          notes: 7,
          links: 1,
          orphans: 0,
          byType,
          byStatus: [
            { status: 'active', n: 65 },
            { status: 'contested', n: 7 },
          ],
        },
        tags: { items: [], total: 0 },
      }),
    ),
  )
  const render = mount(t, 'OverviewView')
  render(chartProps())
  await setImmediate()
  const tree = render(chartProps())
  assert.equal(byClass(tree, 'mem-bar-track').length, 1)
  const fills = byClass(tree, 'mem-bar-fill')
  assert.equal(fills.length, 3, 'three segments for seven types')
  // Each segment has its OWN colour class: a duplicate tint reads as a repeated band.
  const segClasses = fills.map((node) =>
    (node.props.className ?? '').split(' ').find((name) => name.startsWith('is-seg')),
  )
  assert.equal(
    new Set(segClasses).size,
    3,
    'no two segments share a colour: ' + segClasses.join(','),
  )
  // The two largest keep their own names; the rest fold into one honest 其他.
  const names = byClass(tree, 'mem-comp-name').map((node) => node.props.children[0])
  assert.deepEqual(names, ['约定', '决策', '文档', '踩坑', 'hub', '术语表', 'misc'])
  // The legend still lists every type with its exact count, and the segments add up:
  // 30 + 20 + (10+6+3+2+1).
  const values = byClass(tree, 'mem-comp-value').map((node) => node.props.children[0])
  assert.deepEqual(values, ['30', '20', '10', '6', '3', '2', '1'])
  const widths = fills.map((node) => Number.parseFloat(node.props.style.width))
  assert.ok(
    Math.abs(widths.reduce((sum, width) => sum + width, 0) - 100) < 0.5,
    'the three segments account for the whole: ' + widths.join('+'),
  )
  assert.equal(byClass(tree, 'mem-comp-status').length, 1, 'status is one line, not a chip row')
  void byType
})

test('the treemap stays honest at any payload length', async (t) => {
  // The route asks for TAG_LIMIT = 24 today, but the view must not depend on it:
  // an older host sends fewer, the trimmer may halve the list mid-flight, and a
  // vault may have one tag. Each case is checked for the same two invariants —
  // areas sum to the map, no two tiles overlap — plus the unit-correct printing.
  const cases = [
    {
      label: '24 tags, a Zipf tail',
      tags: {
        items: Array.from({ length: 24 }, (_x, index) => ({
          tag: 'dsh-mem/tag-' + index,
          n: Math.max(1, Math.round(200 / (index + 1))),
        })),
        total: 500,
        distinct: 24,
      },
    },
    { label: 'one tag', tags: { items: [{ tag: 'only', n: 9 }], total: 9, distinct: 1 } },
    {
      label: 'two tags, one dominant',
      tags: {
        items: [
          { tag: 'big', n: 3 },
          { tag: 'small', n: 1 },
        ],
        total: 4,
        distinct: 2,
      },
    },
    {
      label: 'a zero-count row that carries no area',
      tags: {
        items: [
          { tag: 'a', n: 5 },
          { tag: 'empty', n: 0 },
        ],
        total: 5,
        distinct: 2,
      },
    },
  ]
  for (const { label, tags } of cases) {
    stubFetch(t, () => ok(overviewValue({ activity: activityFixture(), tags })))
    const render = mount(t, 'OverviewView')
    render(chartProps())
    await setImmediate()
    const tree = render(chartProps())
    const tiles = treemapTiles(tree)
    const drawn = tags.items.filter((item) => item.n > 0)
    assert.equal(tiles.length, drawn.length, label + ': one tile per positive count')
    const box = treemapBox(tree)
    const mapArea = box.area
    assert.ok(mapArea > 0, label + ': the map states a positive area ' + mapArea)
    const totalArea = tiles.reduce((sum, tile) => sum + tile.area, 0)
    assert.ok(
      Math.abs(totalArea - mapArea) < 0.5,
      label + ': the tiles tile the map (' + totalArea + ' vs ' + mapArea + ')',
    )
    const total = drawn.reduce((sum, item) => sum + item.n, 0)
    drawn.forEach((item, index) => {
      const share = item.n / total
      assert.ok(
        Math.abs(tiles[index].area - mapArea * share) < 0.5,
        label + ': area is the count share for ' + item.tag,
      )
      // The printed count is the reading; the area is the shape. A tile too small
      // for a readable label says so with `is-minor`; every other tile prints its
      // tag leaf and lets the stylesheet ellipsize it.
      assert.equal(tiles[index].value, formatCountForTest(item.n))
      if (tiles[index].minor)
        assert.equal(tiles[index].tag, null, label + ': no name in a minor tile')
      else
        // A roomy tile prints the tag's LEAF, not the namespace it repeats with every
        // other tile: `dsh-mem/convention` needs about 120px at 11px bold, which no
        // tile in a 24-tag map has. The full tag is still the tile's native title and
        // its `mem-sr` line, which the assertions below check.
        assert.equal(
          tiles[index].tag,
          item.tag.slice(item.tag.lastIndexOf('/') + 1),
          label + ': a roomy tile prints its tag leaf',
        )
    })
    // The full list survives for assistive technology even when names are hidden.
    const frequency = nodes(tree).find(
      (node) => node?.type === 'section' && node.props['aria-label'] === '标签频率',
    )
    const spoken = byClass(frequency, 'mem-sr').map((node) => String(node.props.children[0]))
    for (const item of drawn)
      assert.ok(
        spoken[0].includes(item.tag + ' ' + formatCountForTest(item.n)),
        label + ': ' + item.tag,
      )
    // The remainder still counts TAGS, in its own unit.
    const remaining = tags.distinct - drawn.length
    assert.equal(
      countText(tree, '另有 ' + remaining + ' 个标签'),
      remaining > 0 ? 1 : 0,
      label + ': the remainder is ' + remaining + ' tags',
    )
  }
})

// ---------------------------------------------------------------------------
// The treemap's label decision is measured, and the three failures below were all
// visible in one real capture of this vault's own tag ranking: the biggest tile
// printed a bare "8" with no label, eight tail tiles printed their name at 2.5-8.1
// pixels, and the map's tiles reached a 3.59 aspect ratio at panel width. Each test
// pins the invariant that was missing, not the pixel count that happened to hold.
// ---------------------------------------------------------------------------

test('a tile the width of its own name is never reduced to a bare count', async (t) => {
  // The reported defect: at a wide panel the biggest tile renders ~211px wide but
  // was judged against a fixed 292-unit coordinate space, so it went minor and the
  // reader saw a number with no label. Area still has to be readable — the count is
  // printed either way — but a tile with ROOM for its name must print it.
  const tags = {
    items: [
      { tag: 'project/dsh-obsidian-mem', n: 8 },
      { tag: 'dsh-mem/hub', n: 7 },
      { tag: 'git', n: 3 },
      { tag: '架构', n: 2 },
      { tag: 'docs', n: 1 },
      { tag: 'npm', n: 1 },
    ],
    total: 22,
    distinct: 6,
  }
  stubFetch(t, () => ok(overviewValue({ activity: activityFixture(), tags })))
  // The wide panel is where the original defect showed (the tile was judged against
  // a fixed 292-unit space). This test pins the invariant: a tile with room for its
  // name prints it. The 292px floor is the truncation case and is pinned separately
  // below.
  const render = mount(t, 'OverviewView', { sankeyWidth: 590 })
  render(chartProps())
  await setImmediate()
  const tree = render(chartProps())
  const tiles = treemapTiles(tree)
  const box = treemapBox(tree)
  assert.ok(box.height >= 148, 'the map is at least the design floor: ' + box.height)
  // The name is one 11px bold line, the count a second; a tile that prints both
  // needs 41px of height, which is where the 26px threshold used to be wrong.
  for (const tile of tiles.filter((candidate) => !candidate.minor)) {
    assert.ok(tile.h >= 41, 'a named tile is tall enough for both lines: ' + tile.h)
    assert.ok(tile.tag !== null, 'a named tile prints a name')
  }
  // The dominant tag is the map's largest tile; it must be labelled.
  const dominant = tiles.find((tile) => String(tile.title).startsWith('project/dsh-obsidian-mem'))
  assert.ok(dominant, 'the dominant tag has a tile')
  assert.equal(
    dominant.minor,
    false,
    'the largest tile is labelled, not a bare number (' + dominant.w + 'x' + dominant.h + ')',
  )
})

test('a name that only fits truncated is printed, not dropped', async (t) => {
  // The reported user defect: once a long name's predicted width crossed the
  // threshold the tile printed a bare count, even when the tile was wide enough for
  // most of the name. The label decision now separates "does not fit" (ellipsize —
  // the stylesheet already declares `text-overflow:ellipsis`) from "cannot hold a
  // readable label at all" (count only). The full name stays in the native title and
  // the `mem-sr` list either way.
  const tags = {
    items: [
      { tag: 'project/dsh-obsidian-mem', n: 8 },
      { tag: 'dsh-mem/hub', n: 7 },
      { tag: 'git', n: 3 },
      { tag: '架构', n: 2 },
      { tag: 'docs', n: 1 },
      { tag: 'npm', n: 1 },
    ],
    total: 22,
    distinct: 6,
  }
  stubFetch(t, () => ok(overviewValue({ activity: activityFixture(), tags })))
  // The 292px design floor: the dominant tile is 106px wide. Its 16-character name
  // needs 150px under the retired per-character model (the real 11px face measures
  // 101.7px), so the old rule printed a bare "8". A 106px tile can hold most of the
  // name, so trimming the label is the honest answer — dropping the name is not.
  const render = mount(t, 'OverviewView')
  render(chartProps())
  await setImmediate()
  const tree = render(chartProps())
  const dominant = treemapTiles(tree).find((tile) =>
    String(tile.title).startsWith('project/dsh-obsidian-mem'),
  )
  assert.ok(dominant, 'the dominant tag has a tile')
  assert.equal(
    dominant.minor,
    false,
    'a tile with room for a truncated label is labelled (' + dominant.w + 'x' + dominant.h + ')',
  )
  assert.equal(dominant.tag, 'dsh-obsidian-mem', 'the label is the tag leaf')
  assert.equal(dominant.value, '8', 'the count is still printed beside it')
  // The remainder of the name is not lost: the title and the accessibility list
  // both carry the full tag.
  assert.match(
    String(dominant.title),
    /^project\/dsh-obsidian-mem · 8 次$/u,
    'the native title is the full reading even when the label is clipped',
  )
})

test('a count-only tile is one that genuinely cannot hold a readable label', async (t) => {
  // The complement of the tests above, and the invariant that keeps the label
  // floor honest: is-minor must be EARNED. A tile may print only its count when it
  // is too short for two lines (41px) or too narrow for any readable label (44px) —
  // never for a rank cut, and never merely because the full name needs trimming.
  const tags = {
    items: Array.from({ length: 24 }, (_x, index) => ({
      tag: 'dsh-mem/tag-' + index,
      n: Math.max(1, Math.round(200 / (index + 1))),
    })),
    total: 500,
    distinct: 24,
  }
  stubFetch(t, () => ok(overviewValue({ activity: activityFixture(), tags })))
  const render = mount(t, 'OverviewView')
  render(chartProps())
  await setImmediate()
  const tree = render(chartProps())
  const tiles = treemapTiles(tree)
  const countsOnly = tiles.filter((tile) => tile.minor)
  assert.ok(countsOnly.length > 0, 'a 24-tag map at the 292px floor does have tail tiles')
  for (const tile of countsOnly) {
    const tooShort = tile.h < 41
    // The label floor: below 44px wide even a truncated single line cannot hold a
    // useful word, so the tile prints its exact count instead. Both bounds are the
    // component's own constants; a count-only tile must fail at least one of them.
    const tooNarrow = tile.w < 44
    assert.ok(
      tooShort || tooNarrow,
      'a count-only tile is genuinely too small for a readable label: ' +
        tile.title +
        ' at ' +
        tile.w +
        'x' +
        tile.h,
    )
  }
  // ...and the complement: a tile tall enough and wide enough prints its name even
  // when the FULL name does not fit — the stylesheet ellipsizes it. In this fixture
  // `tag-4` is 48.9px wide (its 10-character name needs 52px under the retired
  // model), so it was the first tail tile the old rule dropped for no good reason.
  const firstTail = tiles.find((tile) => String(tile.title).startsWith('dsh-mem/tag-4 '))
  assert.ok(firstTail, 'tag-4 has a tile')
  assert.equal(
    firstTail.minor,
    false,
    'a 48.9px tile is wide enough for a truncated label (' + firstTail.w + 'x' + firstTail.h + ')',
  )
  assert.equal(firstTail.tag, 'tag-4', 'the truncated label still names the tag')
  // Every tile still states its exact count, so nothing is unreadable.
  for (const tile of tiles) assert.ok(String(tile.value).length > 0, 'every tile prints a count')
})

test('the map keeps its proportion as the panel widens', async (t) => {
  // The percentage layout scaled width with the panel and left height fixed, so the
  // aspect ratio of the average tile tripled between the 292px floor and a 590px
  // panel — the treemap stopped reading as a treemap. Height is now derived from the
  // measured width, so the map's own proportion is stable within its clamp.
  const tags = {
    items: [
      { tag: 'a', n: 8 },
      { tag: 'b', n: 7 },
      { tag: 'c', n: 3 },
      { tag: 'd', n: 2 },
    ],
    total: 20,
    distinct: 4,
  }
  stubFetch(t, () => ok(overviewValue({ activity: activityFixture(), tags })))
  const heights = []
  for (const sankeyWidth of [292, 375, 480, 590, 800]) {
    const render = mount(t, 'OverviewView', { sankeyWidth })
    render(chartProps())
    await setImmediate()
    const tree = render(chartProps())
    const box = treemapBox(tree)
    heights.push(box.height)
    assert.ok(box.height >= 148, 'never below the design floor at ' + sankeyWidth)
    assert.ok(box.height <= 300, 'never above the ceiling at ' + sankeyWidth)
    // Derived from the width, so a wider panel is never SHORTER than a narrow one.
    const expected = Math.min(300, Math.max(148, Math.round(sankeyWidth * 0.55)))
    assert.equal(box.height, expected, 'height follows the measured width at ' + sankeyWidth)
  }
  for (let index = 1; index < heights.length; index += 1)
    assert.ok(
      heights[index] >= heights[index - 1],
      'the map grows with the panel: ' + heights.join(' -> '),
    )
})
/** The panel's own thousands separator, so the test does not re-implement it twice. */
function formatCountForTest(value) {
  return String(Math.trunc(Number(value))).replace(/\B(?=(\d{3})+(?!\d))/gu, ',')
}

// ---------------------------------------------------------------------------
// The 构成 Sankey (joint type×status flow). The fixture's two margins add up on
// paper, and every layout number in the expectations is recomputable from those
// counts and the chart's declared 292×200 coordinate space: 180 usable units
// across 60 notes is 3 units per note, with a 4-unit gap between nodes.
// ---------------------------------------------------------------------------

/** 60 notes: 30 convention / 20 decision / 10 doc, and 45 active / 15 provisional. */
const FLOW_COUNTS = {
  notes: 60,
  links: 5,
  orphans: 2,
  byType: [
    { type: 'convention', n: 30 },
    { type: 'decision', n: 20 },
    { type: 'doc', n: 10 },
  ],
  byStatus: [
    { status: 'active', n: 45 },
    { status: 'provisional', n: 15 },
  ],
  // Every joint number is real: 25+5=30, 18+2=20, 2+8=10, 25+18+2=45, 5+2+8=15.
  flow: [
    { type: 'convention', status: 'active', n: 25 },
    { type: 'decision', status: 'active', n: 18 },
    { type: 'doc', status: 'provisional', n: 8 },
    { type: 'convention', status: 'provisional', n: 5 },
    { type: 'decision', status: 'provisional', n: 2 },
    { type: 'doc', status: 'active', n: 2 },
  ],
}

/** The first string child of an element's native <title> child. */
function titleOf(element) {
  const found = nodes(element).find((node) => node?.type === 'title')
  return found?.props?.children?.[0]
}

/** Render 概览 once with these counts; the chart data stays present so only 构成 changes. */
async function renderOverviewWith(t, counts, options) {
  stubFetch(t, () => ok(overviewValue({ counts, activity: activityFixture(), tags: null })))
  const render = mount(t, 'OverviewView', options)
  render(chartProps())
  await setImmediate()
  return render(chartProps())
}

test('the composition draws a Sankey whose geometry is the joint flow', async (t) => {
  const tree = await renderOverviewWith(t, FLOW_COUNTS)
  assert.equal(byClass(tree, 'mem-sankey').length, 1, 'one Sankey surface')
  assert.equal(byClass(tree, 'mem-comp').length, 0, 'the Sankey replaces the stacked bar')
  assert.equal(byClass(tree, 'mem-bar-track').length, 0, 'and its track')
  const svg = byClass(tree, 'mem-sankey-svg')
  assert.equal(svg.length, 1)
  assert.equal(svg[0].props.role, 'img', 'the whole chart is one image')
  assert.equal(svg[0].props.viewBox, '0 0 292 200', "the 320px floor's 292px content space")
  assert.equal(svg[0].props['aria-label'], '构成桑基图：共 60 条', 'the label names the total')
  // The section head prints the flow's own total, not a second aggregate.
  const sectionNode = nodes(tree).find(
    (node) => node?.type === 'section' && node.props['aria-label'] === '构成',
  )
  assert.ok(sectionNode, 'the 构成 section')
  assert.deepEqual(
    byClass(sectionNode, 'mem-meta').map((node) => node.props.children[0]),
    ['60 条'],
  )
  // Left column = byType order, height = n × 3 units; 4-unit gaps.
  const leftNodes = byClass(tree, 'mem-sankey-node').filter((node) =>
    node.props.className.split(' ').includes('is-type'),
  )
  assert.equal(leftNodes.length, 3)
  assert.deepEqual(
    leftNodes.map((node) => [node.props.x, node.props.y, node.props.width, node.props.height]),
    [
      [76, 6, 8, 90], // convention 30 × 3
      [76, 100, 8, 60], // decision 20 × 3 (6 + 90 + 4)
      [76, 164, 8, 30], // doc 10 × 3 (100 + 60 + 4)
    ],
  )
  // Right column = byStatus order; a two-node column is vertically centred.
  const rightNodes = byClass(tree, 'mem-sankey-node').filter((node) =>
    node.props.className.split(' ').includes('is-status'),
  )
  assert.equal(rightNodes.length, 2)
  assert.deepEqual(
    rightNodes.map((node) => [node.props.x, node.props.y, node.props.width, node.props.height]),
    [
      [204, 8, 8, 135], // active 45 × 3
      [204, 147, 8, 45], // provisional 15 × 3 (8 + 135 + 4)
    ],
  )
  // Every node carries its exact number in a native title (an SVG title is a real tooltip).
  assert.deepEqual(leftNodes.map(titleOf), ['约定 · 30 条', '决策 · 20 条', '文档 · 10 条'])
  assert.deepEqual(rightNodes.map(titleOf), ['生效 · 45 条', '待确认 · 15 条'])
  // Links: one filled closed band per joint row, stacked so a source's targets
  // follow the right column and a target's sources follow the left column.
  const links = byClass(tree, 'mem-sankey-link')
  assert.equal(links.length, 6)
  assert.deepEqual(
    links.map((node) => node.props.d),
    [
      'M84,6 C144,6 144,8 204,8 L204,83 C144,83 144,81 84,81 Z',
      'M84,81 C144,81 144,147 204,147 L204,162 C144,162 144,96 84,96 Z',
      'M84,100 C144,100 144,83 204,83 L204,137 C144,137 144,154 84,154 Z',
      'M84,154 C144,154 144,162 204,162 L204,168 C144,168 144,160 84,160 Z',
      'M84,164 C144,164 144,137 204,137 L204,143 C144,143 144,170 84,170 Z',
      'M84,170 C144,170 144,168 204,168 L204,192 C144,192 144,194 84,194 Z',
    ],
  )
  assert.deepEqual(links.map(titleOf), [
    '约定 → 生效 · 25 条',
    '约定 → 待确认 · 5 条',
    '决策 → 生效 · 18 条',
    '决策 → 待确认 · 2 条',
    '文档 → 生效 · 2 条',
    '文档 → 待确认 · 8 条',
  ])
  // numbers = geometry: each link's drawn thickness is its count × 3 units, a
  // node's outgoing links add up to the node's own height, and the two columns
  // are the same total (60 notes × 3).
  const thickness = (d) => {
    const numbers = String(d)
      .match(/-?\d+(?:\.\d+)?/gu)
      .map(Number)
    return numbers.at(-1) - numbers[1]
  }
  const printed = [25, 5, 18, 2, 2, 8]
  links.forEach((node, index) => {
    assert.equal(
      thickness(node.props.d),
      printed[index] * 3,
      'link thickness is the printed count: ' + printed[index],
    )
  })
  assert.equal(thickness(links[0].props.d) + thickness(links[1].props.d), 90, 'convention 30')
  assert.equal(thickness(links[2].props.d) + thickness(links[3].props.d), 60, 'decision 20')
  assert.equal(thickness(links[4].props.d) + thickness(links[5].props.d), 30, 'doc 10')
  assert.equal(
    thickness(links[0].props.d) + thickness(links[2].props.d) + thickness(links[4].props.d),
    135,
  )
  assert.equal(
    thickness(links[1].props.d) + thickness(links[3].props.d) + thickness(links[5].props.d),
    45,
  )
  // Labels and values are text, so no reading depends on colour alone.
  assert.deepEqual(
    byClass(tree, 'mem-sankey-label').map((node) => node.props.children[1]),
    ['约定', '决策', '文档', '生效', '待确认'],
  )
  assert.deepEqual(
    byClass(tree, 'mem-sankey-value').map((node) => node.props.children[0]),
    ['30', '20', '10', '45', '15'],
  )
  assert.equal(
    byClass(tree, 'mem-sankey-leader').length,
    0,
    'labels that already sit on their node centre need no leader',
  )
  // Colour is the type rank (left nodes + outgoing links); right nodes are neutral.
  assert.deepEqual(
    leftNodes.map((node) => node.props.className),
    [
      'mem-sankey-node is-type is-seg0',
      'mem-sankey-node is-type is-seg1',
      'mem-sankey-node is-type is-seg2',
    ],
  )
  assert.deepEqual(
    rightNodes.map((node) => node.props.className),
    ['mem-sankey-node is-status', 'mem-sankey-node is-status'],
  )
  assert.deepEqual(
    links.map((node) => node.props.className),
    [
      'mem-sankey-link is-seg0',
      'mem-sankey-link is-seg0',
      'mem-sankey-link is-seg1',
      'mem-sankey-link is-seg1',
      'mem-sankey-link is-seg2',
      'mem-sankey-link is-seg2',
    ],
  )
})

test('a long Sankey label truncates but keeps its full title', async (t) => {
  // A type name that is not one of the panel's own labels: clipped in the fixed
  // label column, with the full string in the native title next to it.
  const tree = await renderOverviewWith(t, {
    notes: 5,
    links: 0,
    orphans: 0,
    byType: [
      { type: 'decision', n: 3 },
      { type: 'a-very-long-type-name', n: 2 },
    ],
    byStatus: [{ status: 'active', n: 5 }],
    flow: [
      { type: 'decision', status: 'active', n: 3 },
      { type: 'a-very-long-type-name', status: 'active', n: 2 },
    ],
  })
  const labels = byClass(tree, 'mem-sankey-label')
  assert.equal(labels.length, 3, 'two type labels and one status label')
  const long = labels[1]
  assert.equal(
    nodes(long).find((node) => node?.type === 'title').props.children[0],
    'a-very-long-type-name',
  )
  const clipped = long.props.children[1]
  assert.notEqual(clipped, 'a-very-long-type-name', 'the column is bounded, so the text is clipped')
  assert.ok(String(clipped).endsWith('…'), 'clipping is visible: ' + clipped)
  assert.ok(String(clipped).length < 'a-very-long-type-name'.length)
})

// A realistic skewed vault (7 types, 3 statuses) packs six labels into the bottom
// third of the column. The single forward pass this replaces could push an earlier
// row past a later one there — measured at 200 units: 182 then 168, two labels 2px
// apart at the 11px font. The two-pass layout has to stay monotonic.
const SLIVER_COUNTS = {
  notes: 515,
  links: 0,
  orphans: 0,
  byType: [
    { type: 'convention', n: 420 },
    { type: 'decision', n: 60 },
    { type: 'doc', n: 20 },
    { type: 'gotcha', n: 8 },
    { type: 'hub', n: 4 },
    { type: 'glossary', n: 2 },
    { type: 'misc', n: 1 },
  ],
  byStatus: [
    { status: 'active', n: 500 },
    { status: 'provisional', n: 10 },
    { status: 'contested', n: 5 },
  ],
  flow: [
    { type: 'convention', status: 'active', n: 410 },
    { type: 'convention', status: 'provisional', n: 8 },
    { type: 'convention', status: 'contested', n: 2 },
    { type: 'decision', status: 'active', n: 56 },
    { type: 'decision', status: 'provisional', n: 2 },
    { type: 'decision', status: 'contested', n: 2 },
    { type: 'doc', status: 'active', n: 19 },
    { type: 'doc', status: 'contested', n: 1 },
    { type: 'gotcha', status: 'active', n: 8 },
    { type: 'hub', status: 'active', n: 4 },
    { type: 'glossary', status: 'active', n: 2 },
    { type: 'misc', status: 'active', n: 1 },
  ],
}

test('a sliver cluster keeps its label rows ordered and apart', async (t) => {
  const tree = await renderOverviewWith(t, SLIVER_COUNTS)
  const rows = byClass(tree, 'mem-sankey-label').map((node) => Number(node.props.y))
  assert.equal(rows.length, 10, 'seven type labels and three status labels')
  // The first seven rows belong to the left column, the last three to the right; 11px
  // is the token font size, so a correctly laid out column keeps at least that between
  // neighbouring rows (and the whole column orders top to bottom).
  for (const column of [rows.slice(0, 7), rows.slice(7)]) {
    for (let index = 1; index < column.length; index += 1) {
      const gap = column[index] - column[index - 1]
      assert.ok(gap >= 11, 'label rows stay ordered and apart, gap ' + gap + ' at ' + index)
    }
  }
})

test('a displaced label row is tied to its mark by a leader', async (t) => {
  const tree = await renderOverviewWith(t, SLIVER_COUNTS)
  const labels = byClass(tree, 'mem-sankey-label')
  const typeLabels = labels.filter((node) => node.props.x === 34)
  const statusLabels = labels.filter((node) => node.props.x === 252)
  const typeNodes = byClass(tree, 'mem-sankey-node').filter((node) =>
    node.props.className.split(' ').includes('is-type'),
  )
  const statusNodes = byClass(tree, 'mem-sankey-node').filter((node) =>
    node.props.className.split(' ').includes('is-status'),
  )
  const centreOf = (node) => Number(node.props.y) + Number(node.props.height) / 2
  const rowOf = (label) => Number(label.props.y) - 4
  // The expectation is the ASSOCIATION, not the layout formula: every row whose
  // baseline no longer sits on its mark's centre must own exactly one leader, and the
  // leader's two endpoints must be that row and that centre.
  const expected = [
    ...typeLabels.map((label, index) => ({
      x: 74,
      row: rowOf(label),
      centre: centreOf(typeNodes[index]),
    })),
    ...statusLabels.map((label, index) => ({
      x: 214,
      row: rowOf(label),
      centre: centreOf(statusNodes[index]),
    })),
  ].filter((entry) => Math.abs(entry.row - entry.centre) >= 0.5)
  assert.equal(expected.length, 8, 'six type rows and two status rows are displaced here')
  const leaderOf = (d) => {
    const match = /^M([\d.]+),([\d.]+)L([\d.]+),([\d.]+)$/u.exec(String(d))
    assert.ok(match, 'a leader is one vertical two-point path: ' + d)
    return {
      x: Number(match[1]),
      row: Number(match[2]),
      endX: Number(match[3]),
      centre: Number(match[4]),
    }
  }
  const leaders = byClass(tree, 'mem-sankey-leader').map((node) => leaderOf(node.props.d))
  assert.equal(
    leaders.length,
    expected.length,
    'one leader per displaced row, none for aligned rows',
  )
  leaders.forEach((leader, index) => {
    const wanted = expected[index]
    assert.equal(leader.x, wanted.x, 'the leader runs down its own label column')
    assert.equal(leader.endX, wanted.x, 'a leader is vertical')
    assert.ok(Math.abs(leader.row - wanted.row) < 0.01, 'the leader starts on the label row')
    assert.ok(Math.abs(leader.centre - wanted.centre) < 0.01, 'the leader ends on the node centre')
  })
})

test('a total that disagrees with the payload note count falls back to the bar', async (t) => {
  const tree = await renderOverviewWith(t, { ...FLOW_COUNTS, notes: 61 })
  assert.equal(byClass(tree, 'mem-sankey').length, 0, 'the claimed total is not the drawn total')
  assert.equal(byClass(tree, 'mem-bar-track').length, 1, 'the fallback bar answers')
})

test('the Sankey fills the measured block width and only its middle grows', async (t) => {
  const narrow = await renderOverviewWith(t, FLOW_COUNTS)
  const wide = await renderOverviewWith(t, FLOW_COUNTS, { sankeyWidth: 640 })
  const floored = await renderOverviewWith(t, FLOW_COUNTS, { sankeyWidth: 200 })
  const svgOf = (tree) => byClass(tree, 'mem-sankey-svg')[0]
  assert.equal(svgOf(narrow).props.viewBox, '0 0 292 200', 'the default is the 320px floor')
  assert.equal(svgOf(wide).props.viewBox, '0 0 640 200', 'a wide block gets a wide chart')
  assert.equal(svgOf(floored).props.viewBox, '0 0 292 200', 'never narrower than the floor')
  const typeNodes = (tree) =>
    byClass(tree, 'mem-sankey-node').filter((node) =>
      node.props.className.split(' ').includes('is-type'),
    )
  const statusNodes = (tree) =>
    byClass(tree, 'mem-sankey-node').filter((node) =>
      node.props.className.split(' ').includes('is-status'),
    )
  const vertical = (nodes) => nodes.map((node) => [node.props.y, node.props.height])
  // Only the horizontal positions move: the nodes' y/height, the link thickness and
  // the label rows are identical, so every printed number still equals its geometry.
  assert.deepEqual(vertical(typeNodes(wide)), vertical(typeNodes(narrow)))
  assert.deepEqual(vertical(statusNodes(wide)), vertical(statusNodes(narrow)))
  assert.deepEqual(
    typeNodes(wide).map((node) => node.props.x),
    [76, 76, 76],
    'the left column keeps its edge band',
  )
  assert.deepEqual(
    statusNodes(wide).map((node) => node.props.x),
    [552, 552],
    'the right column moves to the measured right edge (640 - 88)',
  )
  const linkOf = (tree) => String(byClass(tree, 'mem-sankey-link')[0].props.d)
  assert.ok(linkOf(narrow).startsWith('M84,'), 'links start at the left band edge')
  assert.ok(linkOf(narrow).includes(' 204,'), 'the narrow link ends at the right column')
  assert.ok(linkOf(wide).includes(' 552,'), 'the wide link ends at the measured right edge')
  assert.ok(
    byClass(wide, 'mem-sankey-label').some((node) => node.props.x === 600),
    'status labels hug the measured right edge (640 - 40)',
  )
  // The leaders that tie displaced rows to their slivers follow the same edge.
  const wideSliver = await renderOverviewWith(t, SLIVER_COUNTS, { sankeyWidth: 640 })
  const leaders = byClass(wideSliver, 'mem-sankey-leader').map((node) => String(node.props.d))
  assert.ok(
    leaders.some((d) => d.startsWith('M74,')),
    'type leaders stay on the left edge band',
  )
  assert.ok(
    leaders.some((d) => d.startsWith('M562,')),
    'status leaders follow the measured right edge (640 - 78)',
  )
})
test('a flow whose margins disagree falls back to the bar, never a lying chart', async (t) => {
  // Two host bugs (wrong type margin, wrong status margin). A Sankey drawn from
  // either would put link thickness next to printed totals that do not match.
  const mismatches = [
    {
      ...FLOW_COUNTS,
      flow: [
        { type: 'convention', status: 'active', n: 25 },
        { type: 'decision', status: 'active', n: 18 },
        { type: 'convention', status: 'provisional', n: 5 },
        { type: 'decision', status: 'provisional', n: 2 },
        { type: 'doc', status: 'active', n: 1 }, // doc's margin is 10, not 1
        { type: 'doc', status: 'provisional', n: 1 },
      ],
    },
    {
      ...FLOW_COUNTS,
      flow: [
        { type: 'convention', status: 'active', n: 30 }, // active's margin is 45
        { type: 'decision', status: 'active', n: 15 },
        { type: 'doc', status: 'provisional', n: 10 },
        { type: 'doc', status: 'active', n: 5 },
      ],
    },
  ]
  for (const counts of mismatches) {
    const tree = await renderOverviewWith(t, counts)
    assert.equal(byClass(tree, 'mem-sankey').length, 0, 'no Sankey from inconsistent margins')
    assert.equal(byClass(tree, 'mem-bar-track').length, 1, 'the old stacked bar answers instead')
    assert.equal(byClass(tree, 'mem-comp-legend').length, 1)
    assert.equal(byClass(tree, 'mem-comp-value').length, 3, 'and its legend still lists every type')
  }
})

test('an empty flow array is no chart either: the fallback bar answers', async (t) => {
  // The route's trimmer drops the flow WHOLE, so [] is a legitimate wire value
  // meaning "no joint counts". The view must read it as absent, not draw an
  // empty figure or a bar without its status line.
  const counts = {
    notes: 7,
    links: 1,
    orphans: 0,
    byType: [{ type: 'decision', n: 7 }],
    byStatus: [{ status: 'active', n: 7 }],
    flow: [],
  }
  stubFetch(t, () => ok(overviewValue({ counts })))
  const render = mount(t, 'OverviewView')
  render(chartProps())
  await setImmediate()
  const tree = render(chartProps())
  assert.equal(byClass(tree, 'mem-sankey').length, 0)
  assert.equal(byClass(tree, 'mem-bar-track').length, 1, 'the existing bar is the fallback')
  assert.equal(byClass(tree, 'mem-comp-status').length, 1, 'and its status line still rides along')
})

test('a payload without the chart fields draws no charts at all', async (t) => {
  // The route feature-detects `activity`/`tags` and answers null for an older index
  // build. That is "no chart", never an empty grid or an empty ranking block.
  stubFetch(t, () => ok(overviewValue({ activity: null, tags: null })))
  const render = mount(t, 'OverviewView')
  render(chartProps())
  await setImmediate()
  const tree = render(chartProps())
  assert.equal(byClass(tree, 'mem-kpi').length, 4, 'the KPI band still answers')
  assert.equal(byClass(tree, 'mem-heat-grid').length, 0, 'no heat map')
  assert.equal(byClass(tree, 'mem-flow').length, 0, 'no flow bars')
  assert.equal(byClass(tree, 'mem-freq-row').length, 0, 'no ranking')
  assert.equal(byClass(tree, 'mem-kpi-spark').length, 0, 'no sparkline either')
})

test('search is a results page: no field of its own, named filter groups and marked rows', async (t) => {
  const sent = stubFetch(t, (body) =>
    ok({
      query: body.query,
      hits: [
        {
          path: 'Projects/repo/Decisions/a.md',
          title: '决策一',
          type: 'decision',
          status: 'active',
          source: 'title',
          snippet: 'Binding memory notes',
          scoreSignals: ['title'],
        },
        {
          path: 'Projects/repo/Conventions/b.md',
          title: '约定一',
          type: 'convention',
          status: 'active',
          source: 'body',
          snippet: '另一段',
          scoreSignals: [],
        },
      ],
      limit: 25,
      hasMore: false,
      tookMs: 3,
    }),
  )
  const render = mount(t, 'SearchView')
  // The box belongs to the shell, so the results page must not carry a second one:
  // two `role="search"` forms in one DOM is two owners of the same query.
  let tree = render(searchProps())
  assert.equal(
    find(tree, (node) => node?.type === 'form'),
    undefined,
    'no form in the view',
  )
  assert.equal(byClass(tree, 'mem-searchbar').length, 0, 'no search bar in the view')
  assert.equal(
    find(tree, (node) => node?.type === 'input'),
    undefined,
    'no input in the view',
  )
  assert.equal(liveRegions(tree).length, 1, 'the body still owns one status region')
  assert.ok(
    texts(tree).some((text) => text === '本地记忆索引'),
    'the head names the local index',
  )
  assert.equal(
    texts(tree).some((text) => String(text).includes('FTS5')),
    false,
  )

  await setImmediate()
  tree = render(searchProps())
  assert.equal(sent.length, 1, 'mounting with a query runs exactly one read')
  assert.equal(sent[0].body.query, 'binding')
  assert.equal(sent[0].body.scope, 'project')
  assert.equal(byClass(tree, 'mem-result').length, 2)
  assert.equal(byClass(tree, 'mem-result-index').length, 0, 'result ordinals are retired')
  const groups = byClass(tree, 'mem-filter')
  assert.ok(groups.length >= 3, 'the three filter rows remain')
  for (const group of groups) {
    assert.equal(group.props.role, 'group', 'each filter row names its group')
    assert.ok(['类型', '状态', '范围'].includes(group.props['aria-label']))
    assert.ok(byClass(group, 'mem-filter-option').length >= 2, 'each group wraps its pills')
  }
  assert.ok(
    byClass(tree, 'mem-filter-option').some((node) => node.props['aria-pressed'] === true),
    'aria-pressed is retained',
  )
  assert.deepEqual(
    byClass(tree, 'mem-filter-option')
      .filter((node) => node.props['aria-pressed'] === true)
      .map((node) => node.props.children[0]),
    ['全部', '全部', '当前项目'],
    'the default selected pills are unchanged',
  )

  assert.ok(byClass(tree, 'mem-result-path').length === 2, 'every row carries its path')
  assert.ok(
    String(byClass(tree, 'mem-result-path')[0].props.children[0]).includes(
      'Projects/repo/Decisions/a.md',
    ),
  )
  assert.ok(
    byClass(tree, 'mem-chip').some((node) => node.props.children[0] === '决策'),
    'type is a chip',
  )
  assert.ok(
    byClass(tree, 'mem-chip').some((node) => node.props.children[0] === '生效'),
    'status is a chip',
  )
  assert.ok(
    byClass(tree, 'mem-chip').some((node) => String(node.props.children[0]).includes('来源 标题')),
  )
  const marks = nodes(tree).filter((node) => node?.type === 'mark')
  assert.deepEqual(
    marks.map((node) => node.props.children[0]),
    ['Binding'],
    'the snippet marks the query case-insensitively',
  )
  assert.equal(byClass(tree, 'mem-snippet').length, 2)
  assert.ok(texts(tree).some((text) => String(text).startsWith('共 2 条 · 用时 3 ms')))
})

test('a filter chip asks the shell for the change instead of owning filter state', async (t) => {
  const sent = stubFetch(t, () => ok({ hits: [], limit: 25, hasMore: false, tookMs: 1 }))
  const asked = []
  const render = mount(t, 'SearchView')
  render(searchProps({ onFilter: (field, value) => asked.push([field, value]) }))
  await setImmediate()
  let tree = render(searchProps({ onFilter: (field, value) => asked.push([field, value]) }))
  const before = sent.length
  byText(tree, '决策')[0].props.onClick()
  // The view reports the intent and does NOT run its own read: the shell rewrites
  // the search object, the new props arrive, and that is the one read.
  assert.deepEqual(asked, [['type', 'decision']])
  assert.equal(sent.length, before, 'a chip click is the shell’s run, not a second one')
  // Scope is filterable the same way; the unbound fallback is the view's one
  // self-initiated change, and it reports it through the same callback.
  assert.deepEqual(
    byClass(tree, 'mem-filter-option')
      .filter((node) => node.props['aria-pressed'] === true)
      .map((node) => node.props.children[0]),
    ['全部', '全部', '当前项目'],
  )
})

test('with no shell callback the chips still render and a run reads once', async (t) => {
  const sent = stubFetch(t, () => ok({ hits: [], limit: 25, hasMore: false, tookMs: 1 }))
  const render = mount(t, 'SearchView')
  render(searchProps({ onFilter: undefined }))
  await setImmediate()
  let tree = render(searchProps({ onFilter: undefined }))
  assert.equal(sent.length, 1)
  assert.equal(byClass(tree, 'mem-filter-option').length >= 6, true, 'the groups still render')
})

test('the results head offers 返回 only when the shell can close the search', async (t) => {
  stubFetch(t, () => ok({ hits: [hit('a.md', '决策一')], limit: 25, hasMore: false, tookMs: 1 }))
  const render = mount(t, 'SearchView')
  const closed = []
  const withClose = searchProps({ onClose: () => closed.push('close') })
  render(withClose)
  await setImmediate()
  let tree = render(withClose)
  const back = byText(tree, '返回')
  assert.equal(back.length, 1, 'one 返回 action when onClose is wired')
  back[0].props.onClick()
  assert.deepEqual(closed, ['close'], '返回 reports to the shell that owns the search state')
  // The view can also be mounted without the callback; then there is nowhere to go
  // back to and it must not offer a dead control.
  render(searchProps({ onClose: undefined }))
  await setImmediate()
  tree = render(searchProps({ onClose: undefined }))
  assert.equal(byText(tree, '返回').length, 0, 'no 返回 without a shell callback')
})

test('显示更多 reports the wider page to the shell instead of running its own read', async (t) => {
  const sent = stubFetch(t, () =>
    ok({ hits: [hit('a.md', '决策一')], limit: 25, hasMore: true, tookMs: 1 }),
  )
  const render = mount(t, 'SearchView')
  const limits = []
  const props = searchProps({ onLimit: (value) => limits.push(value) })
  render(props)
  await setImmediate()
  const tree = render(props)
  const more = byText(tree, '显示更多')
  assert.equal(more.length, 1, 'a partial page offers 显示更多')
  const before = sent.length
  more[0].props.onClick()
  // One owner for the page size: the view reports 50 upward and the shell's props
  // drive the next read, because a view-local 50 leaves the shell believing 25 and a
  // retry on the wider page silently drops rows.
  assert.deepEqual(limits, [50], 'the page size is reported, not owned')
  assert.equal(sent.length, before, 'the view itself starts no read')
})

test('the search footer reports a real total only for a complete page', async (t) => {
  const sent = stubFetch(t, (_body, call) =>
    ok({
      query: 'binding',
      hits: [
        {
          path: 'a.md',
          title: 'A',
          type: 'decision',
          status: 'active',
          source: 'title',
          snippet: 'a',
          scoreSignals: [],
        },
      ],
      limit: call === 1 ? 25 : 50,
      hasMore: call < 3,
      tookMs: 4,
    }),
  )
  const render = mount(t, 'SearchView')
  render(searchProps())
  await setImmediate()
  let tree = render(searchProps())
  assert.deepEqual(
    texts(tree).filter((text) => /条 · 用时/u.test(String(text))),
    ['已显示 1 条 · 用时 4 ms'],
    'a page with more rows says 已显示, never 共',
  )
  assert.equal(countText(tree, '共 1 条'), 0)
  assert.equal(byText(tree, '显示更多').length, 1)
  byText(tree, '显示更多')[0].props.onClick()
  await setImmediate()
  tree = render(searchProps())
  assert.equal(sent.at(-1).body.limit, 50, '显示更多 asks for the ceiling')
  assert.equal(countText(tree, '已达上限 50'), 1, 'the ceiling is named')
  // A new run at the ceiling (the shell would hand down a fresh limit, or the user
  // re-submits) turns the page complete: hasMore is false on the third answer.
  render(searchProps({ limit: 50 }))
  await setImmediate()
  tree = render(searchProps({ limit: 50 }))
  assert.deepEqual(
    texts(tree).filter((text) => /条 · 用时/u.test(String(text))),
    ['共 1 条 · 用时 4 ms'],
    'a complete page may claim 共',
  )
  assert.equal(countText(tree, '已显示 1 条'), 0)
})

test('search marks only terms of two or more characters, case-insensitively and literally', async (t) => {
  stubFetch(t, (body) =>
    ok({
      query: body.query,
      hits: [
        {
          path: 'a+b.md',
          title: 'T',
          type: 'doc',
          status: 'active',
          source: 'body',
          snippet: 'x A+B binding value',
          scoreSignals: [],
        },
      ],
      limit: 25,
      hasMore: false,
      tookMs: 1,
    }),
  )
  const render = mount(t, 'SearchView')
  // A query of two or more characters marks its terms; one character marks
  // nothing. Both are one mount each, because the query now arrives as a prop.
  render(searchProps({ query: 'x BINDING a+b' }))
  await setImmediate()
  let tree = render(searchProps({ query: 'x BINDING a+b' }))
  assert.deepEqual(
    nodes(tree)
      .filter((node) => node?.type === 'mark')
      .map((node) => node.props.children[0]),
    ['A+B', 'binding'],
    'the single-character term is ignored; the regex metacharacters stay literal',
  )
  render(searchProps({ query: 'x' }))
  await setImmediate()
  tree = render(searchProps({ query: 'x' }))
  assert.equal(
    nodes(tree).filter((node) => node?.type === 'mark').length,
    0,
    'one char marks nothing',
  )
})

test('the health page leads with gauges and keeps every reading a number', async (t) => {
  // The appraisal carries real findings so the 今日摘要 section draws its severity
  // bar chart; the empty-appraisal branch is asserted separately below.
  stubFetch(t, () =>
    ok(
      healthValue({
        digest: {
          ...healthValue().digest,
          appraisal: {
            findings: [
              { code: 'dead-link', severity: 'error', path: 'a.md', title: '死链' },
              { code: 'orphan', severity: 'warn', path: 'b.md', title: '孤立' },
              { code: 'stale', severity: 'info', path: 'c.md', title: '过期' },
              { code: 'dup', severity: 'error', path: 'd.md', title: '重名' },
            ],
            total: 4,
            truncated: false,
          },
        },
      }),
    ),
  )
  const render = mount(t, 'HealthView')
  render({ sessionId: 'session-a', visible: true })
  await setImmediate()
  const tree = render({ sessionId: 'session-a', visible: true })

  // The summary band is four gauges: a label, a printed reading and a small
  // track whose fill repeats the same ratio as a shape. It is a passive group,
  // not a button, and its cells never become a click target.
  const band = find(tree, (node) => node?.props?.['aria-label'] === '健康摘要')
  assert.ok(band, 'the summary band comes first')
  assert.equal(band.type, 'div')
  const gauges = byClass(band, 'mem-gauge')
  assert.equal(gauges.length, 4, 'four gauges: 索引/队列/热层/摘要')
  assert.deepEqual(
    byClass(band, 'mem-gauge-label').map((node) => node.props.children[0]),
    ['索引', '队列', '热层', '摘要'],
  )
  assert.deepEqual(
    byClass(band, 'mem-gauge-value').map((node) => node.props.children[0]),
    ['就绪', '2 个', '80%', '最近 1 天'],
    'each gauge states its own reading in digits or a one-word state',
  )
  // The fills are the same ratios as the readings: 索引 ready is full, the queue
  // is 1 failed of 2 pending, the hot zone is 7200/9000 and the digest exists.
  const fills = byClass(band, 'mem-gauge-fill')
  assert.deepEqual(
    fills.map((node) => node.props.style.width),
    ['100%', '50%', '80%', '100%'],
    'the fill is the reading, not a decoration',
  )
  assert.deepEqual(
    fills.map(
      (node) => (node.props.className ?? '').split(' ').filter((c) => c.startsWith('is-'))[0],
    ),
    ['is-ok', 'is-err', 'is-ok', 'is-ok'],
    'state colour rides the fill, and only alongside the printed reading',
  )
  for (const gauge of gauges) {
    const track = byClass(gauge, 'mem-gauge-track')
    assert.equal(track.length, 1, 'each gauge carries one track')
    assert.equal(track[0].props['aria-hidden'], true, 'the track is the reading’s echo')
  }

  // 索引: the six-row <dl> is now one figure grid plus the state stamp.
  assert.equal(byClass(tree, 'mem-facts').length, 0, 'the ledger rows are retired')
  const figures = byClass(tree, 'mem-figure')
  assert.ok(figures.length >= 6, 'every index fact keeps a cell: ' + figures.length)
  assert.deepEqual(
    byClass(tree, 'mem-figure-key')
      .map((node) => node.props.children[0])
      .slice(0, 6),
    ['笔记', '隔离', '全文检索', '扫描', '上次扫描', '后端'],
  )
  assert.ok(byClass(tree, 'mem-stamp').some((node) => node.props.children[0] === '就绪'))
  assert.equal(byClass(tree, 'mem-meter-track').length, 1, 'the hot meter is kept')
  // Each grid declares how many cells it holds, so a short card fills its row instead
  // of leaving the grid's own background showing through: 索引 prints six cells (two
  // rows of three), 热层 two, 今日摘要 four.
  assert.deepEqual(
    byClass(tree, 'mem-figures').map((node) => node.props['data-columns']),
    ['3', '2', '4'],
    'the grid column count follows the number of cells it prints',
  )

  // 待处理作业 is one stacked bar over 排队/失败/延迟, and its legend prints each
  // count: a segment width alone would be unreadable at 320px.
  const queueSection = find(
    tree,
    (node) => node?.type === 'section' && node.props['aria-label'] === '待处理作业',
  )
  const queueTrack = byClass(queueSection, 'mem-stackbar-track')[0]
  assert.ok(queueTrack, 'the queue section draws a stack bar')
  assert.equal(queueTrack.props.role, 'img', 'the stacked bar is one image')
  assert.equal(
    queueTrack.props['aria-label'],
    '待处理作业：排队 1 · 失败 1 · 延迟 0',
    'the label states every part with its count',
  )
  assert.deepEqual(
    byClass(queueSection, 'mem-stackbar-seg').map((node) => node.props.style.width),
    ['50%', '50%'],
    'a zero part draws no zero-width band',
  )
  assert.deepEqual(
    byClass(queueSection, 'mem-bar-name').map((node) => node.props.children[0]),
    ['排队', '失败', '延迟'],
  )
  assert.deepEqual(
    byClass(queueSection, 'mem-bar-value').map((node) => node.props.children[0]),
    ['1', '1', '0'],
    'the legend prints the counts the bar cannot',
  )

  // 热层: the meter, two figures and one zone stacked bar with its per-zone line.
  const hotSection = find(
    tree,
    (node) => node?.type === 'section' && node.props['aria-label'] === '热层',
  )
  assert.deepEqual(
    byClass(hotSection, 'mem-figure-key').map((node) => node.props.children[0]),
    ['可归档', '可压缩'],
  )
  const hotRows = byClass(hotSection, 'mem-stackbar-row')
  assert.equal(hotRows.length, 2, 'one legend row per hot zone')
  assert.deepEqual(
    byClass(hotSection, 'mem-bar-name').map((node) => node.props.children[0]),
    ['已完成', '进行中'],
  )
  assert.deepEqual(
    byClass(hotSection, 'mem-bar-value').map((node) => node.props.children[0]),
    ['1,200', '5,400'],
    'the segment length is the zone’s character count',
  )

  // 今日摘要: figures, a severity bar chart, and at most three named findings.
  assert.equal(byClass(tree, 'mem-digest').length, 1)
  assert.ok(texts(tree).some((text) => String(text).includes('今日摘要')))
  const digestSection = find(
    tree,
    (node) => node?.type === 'section' && node.props['aria-label'] === '今日摘要',
  )
  assert.deepEqual(
    byClass(digestSection, 'mem-figure-key').map((node) => node.props.children[0]),
    ['新建', '更新', '取代', '待复核'],
  )
  const severity = byClass(digestSection, 'mem-bar-row')
  assert.equal(severity.length, 3, 'one bar per severity, always all three')
  assert.deepEqual(
    byClass(digestSection, 'mem-bar-name').map((node) => node.props.children[0]),
    ['错误', '注意', '提示'],
    'the severity distribution is one bar chart, worst first',
  )
  assert.deepEqual(
    byClass(digestSection, 'mem-bar-value').map((node) => node.props.children[0]),
    ['2', '1', '1'],
    'each bar prints the count it encodes: two errors, one warn, one info',
  )
  // The bar lengths are proportional to the largest row, not to the total: the
  // question is "which severity dominates", so a shared max is the right scale.
  assert.deepEqual(
    byClass(digestSection, 'mem-bar-fill').map((node) => node.props.style.width),
    ['100%', '50%', '50%'],
    'bar length is count / max',
  )
  // At most three findings are named; the rest are counted, not listed.
  assert.equal(byClass(digestSection, 'mem-row-title').length, 3, 'three finding rows at most')
  assert.ok(countText(tree, '另有 1 条待复核') === 1, 'the unnamed remainder is counted once')

  // 诊断记录: an event-mix bar chart plus the three most recent rows.
  assert.ok(
    texts(tree).some((text) => String(text).includes('诊断记录')),
    'the section is retitled',
  )
  assert.equal(
    texts(tree).some((text) => String(text).includes('最近的决策')),
    false,
    'the old mislabel is gone',
  )
  const diagnostics = find(
    tree,
    (node) => node?.type === 'section' && node.props['aria-label'] === '诊断记录',
  )
  assert.deepEqual(
    byClass(diagnostics, 'mem-bar-name').map((node) => node.props.children[0]),
    ['brief', 'search'],
    'one bar per event kind, no repeated text row per event',
  )
  assert.deepEqual(
    byClass(diagnostics, 'mem-bar-value').map((node) => node.props.children[0]),
    ['1', '1'],
  )
  assert.equal(byClass(diagnostics, 'mem-event').length, 2, 'three recent rows at most')
  assert.equal(byClass(diagnostics, 'mem-event-dot').length, 2)
  assert.ok(
    byClass(diagnostics, 'mem-event').every(
      (event) => byClass(event, 'mem-event-dot').length === 1,
    ),
  )
})

// ---------------------------------------------------------------------------
// 検索: one derived status, one render site (the reported duplicate class)
// ---------------------------------------------------------------------------

test('search renders every status string at most once across idle, loading, results, empty and error', async (t) => {
  const first = deferred()
  let requests = 0
  const sent = stubFetch(t, () => {
    requests += 1
    if (requests === 1) return first.promise
    if (requests === 2) return ok({ hits: [], limit: 25, hasMore: false, tookMs: 1 })
    return failure(503, 'unavailable', 'memory panel unavailable')
  })
  const render = mount(t, 'SearchView')
  const idle = '输入关键词开始检索'
  // An empty query is the idle state and sends nothing: the shell's box already
  // refuses an empty submit, and the view must not spend a request on its own.
  render(searchProps({ query: '' }))
  await setImmediate()
  let tree = render(searchProps({ query: '' }))
  assert.equal(sent.length, 0, 'an empty query never reaches the route')
  assert.equal(countText(tree, idle), 1, 'the idle sentence renders once')
  assert.equal(liveRegions(tree).length, 1, 'one status region owns the idle state')

  // A query arrives: the loading state replaces the idle one, exactly once.
  // The run starts in an effect (the props changed), so the loading frame is the
  // next paint, the order the host mounts in.
  render(searchProps())
  tree = render(searchProps())
  assert.equal(requests, 1, 'one query is one request')
  assert.equal(countText(tree, '正在检索…'), 1, 'the loading status renders once')
  assert.equal(countText(tree, idle), 0, 'the idle sentence is gone while loading')
  assert.equal(liveRegions(tree).length, 1, 'one status region owns the loading state')

  // Results: the footer carries the count, and only for a complete page.
  first.resolve(
    ok({
      hits: [hit('a.md', '决策一'), hit('b.md', '约定一')],
      limit: 25,
      hasMore: false,
      tookMs: 3,
    }),
  )
  await setImmediate()
  tree = render(searchProps())
  assert.equal(byClass(tree, 'mem-result').length, 2)
  assert.equal(countText(tree, '共 2 条'), 1, 'the results footer renders once')
  assert.equal(countText(tree, '正在检索…'), 0)
  assert.equal(countText(tree, idle), 0)

  // Empty results: one empty line, no idle fallback.
  render(searchProps({ query: 'nothing-matches' }))
  await setImmediate()
  tree = render(searchProps({ query: 'nothing-matches' }))
  assert.equal(countText(tree, '没有匹配的记忆。'), 1, 'the empty status renders once')
  assert.equal(countText(tree, idle), 0)

  // A failure after results is a stale notice carrying the real last-read time.
  render(searchProps({ query: 'explode' }))
  await setImmediate()
  tree = render(searchProps({ query: 'explode' }))
  assert.equal(countText(tree, '上次更新 '), 1, 'the stale notice renders once')
  assert.equal(countText(tree, '上次更新 —'), 0, 'a stale error never shows a fabricated time')
  assert.equal(
    countText(tree, '读取记忆失败：'),
    0,
    'the stale branch replaces the fresh error text',
  )
  for (const copy of [idle, '正在检索…', '没有匹配的记忆。', '上次更新 ', '共 2 条'])
    assert.ok(countText(tree, copy) <= 1, 'the status string renders at most once: ' + copy)
  assert.equal(byClass(tree, 'mem-result').length, 0)
})

test('a filter chip with an empty query asks the shell and sends no request', async (t) => {
  const sent = stubFetch(t, () => ok({ hits: [], limit: 25, hasMore: false, tookMs: 1 }))
  const asked = []
  const render = mount(t, 'SearchView')
  let tree = render(
    searchProps({ query: '', onFilter: (field, value) => asked.push([field, value]) }),
  )
  await setImmediate()
  byText(tree, '约定')[0].props.onClick()
  tree = render(searchProps({ query: '', onFilter: (field, value) => asked.push([field, value]) }))
  assert.equal(sent.length, 0, 'the empty query is not sent to the route')
  assert.deepEqual(asked, [['type', 'convention']], 'the chip reports the intent to the shell')
  assert.equal(countText(tree, '输入关键词开始检索'), 1)
  byText(tree, '全部')[0].props.onClick()
  tree = render(searchProps({ query: '', onFilter: (field, value) => asked.push([field, value]) }))
  assert.equal(sent.length, 0)
  assert.deepEqual(
    asked,
    [
      ['type', 'convention'],
      ['type', null],
    ],
    'a second chip still reports without reading',
  )
  assert.equal(countText(tree, '输入关键词开始检索'), 1)
})

test('a filter chip with a query reports once and the shell’s new props do the read', async (t) => {
  const sent = stubFetch(t, () =>
    ok({ hits: [hit('a.md', '决策一')], limit: 25, hasMore: false, tookMs: 1 }),
  )
  const asked = []
  const render = mount(t, 'SearchView')
  render(searchProps({ onFilter: (field, value) => asked.push([field, value]) }))
  await setImmediate()
  let tree = render(searchProps({ onFilter: (field, value) => asked.push([field, value]) }))
  const before = sent.length
  byText(tree, '决策')[0].props.onClick()
  assert.deepEqual(asked, [['type', 'decision']])
  assert.equal(sent.length, before, 'the chip itself never reads')
  // The shell then hands down the refined filter; that is the one read.
  render(searchProps({ type: 'decision', onFilter: () => {} }))
  await setImmediate()
  tree = render(searchProps({ type: 'decision', onFilter: () => {} }))
  assert.equal(sent.length, before + 1, 'the refined filter runs exactly one more request')
  assert.equal(sent.at(-1).body.query, 'binding')
  assert.equal(sent.at(-1).body.type, 'decision')
  assert.equal(byClass(tree, 'mem-result').length, 1)
})

test('the unbound scope switch asks the shell and lets its single read carry the notice', async (t) => {
  const fallback = deferred()
  let requests = 0
  const sent = stubFetch(t, () => {
    requests += 1
    return requests === 1 ? failure(422, 'unbound', 'project unbound') : fallback.promise
  })
  const asked = []
  const onFilter = (field, value) => asked.push([field, value])
  const render = mount(t, 'SearchView')
  render(searchProps({ onFilter }))
  await setImmediate()
  let tree = render(searchProps({ onFilter }))
  // The view tried `project`, failed, and REPORTS the scope move. It must not also
  // run `all` itself: doing both spent a third request, and the props change then
  // started a fresh run that cleared the notice this branch exists to show.
  assert.equal(requests, 1, 'the failed project read is the only request so far')
  assert.deepEqual(asked, [['scope', 'all']], 'the view tells the shell the scope moved')
  assert.equal(
    countText(tree, '当前项目未绑定；正在搜索全部项目。'),
    1,
    'the notice is no longer dead copy and renders once',
  )
  assert.equal(countText(tree, '输入关键词开始检索'), 0)

  // The shell answers with the new scope — exactly one more read, and the carried
  // notice survives it rather than being replaced by a bare loading state.
  tree = render(searchProps({ scope: 'all', onFilter }))
  assert.equal(requests, 2, 'the shell-driven run is the second and only extra read')
  assert.equal(sent[1].body.scope, 'all', 'the fallback asks the all-project scope')
  assert.equal(
    countText(tree, '当前项目未绑定；正在搜索全部项目。'),
    1,
    'the notice survives the run it prompted',
  )
  fallback.resolve(ok({ hits: [hit('a.md', '决策一')], limit: 25, hasMore: false, tookMs: 2 }))
  await setImmediate()
  tree = render(searchProps({ scope: 'all', onFilter }))
  assert.equal(byClass(tree, 'mem-result').length, 1)
  assert.equal(
    countText(tree, '当前项目未绑定；正在搜索全部项目。'),
    0,
    'the run-scoped notice is replaced by the results status',
  )
  assert.equal(requests, 2, 'and no third request was ever spent')
  assert.ok(
    byClass(tree, 'mem-filter-option').some(
      (node) => node.props.children[0] === '全部' && node.props['aria-pressed'] === true,
    ),
    'the 范围 group shows the switched scope',
  )
})

test('the overview owns its loading announcement once, from the skeleton, then refreshes', async (t) => {
  const gates = [deferred(), deferred()]
  let calls = 0
  stubFetch(t, () => gates[Math.min(calls++, gates.length - 1)].promise)
  const render = mount(t, 'OverviewView')
  const props = { sessionId: 'session-a', visible: true }
  render(props)
  await setImmediate()
  let tree = render(props)
  assert.equal(countText(tree, '正在读取记忆…'), 1, 'the skeleton is the one loading announcement')
  assert.equal(liveRegions(tree).length, 1, 'one live region in the loading state')
  gates[0].resolve(ok(overviewValue()))
  await setImmediate()
  tree = render(props)
  assert.equal(countText(tree, '正在读取记忆…'), 0)
  const refreshing = { ...props, refreshKey: 1 }
  render(refreshing)
  tree = render(refreshing)
  assert.equal(
    countText(tree, '正在刷新…'),
    1,
    'the refresh status renders once, from the status line',
  )
  assert.equal(countText(tree, '正在读取记忆…'), 0, 'the skeleton does not announce a refresh')
  assert.equal(liveRegions(tree).length, 1)
})

test('a background interval poll updates silently; only a user refresh announces', async (t) => {
  // The 15 s poll exists so memory written by another process shows up without a
  // restart. Announcing every poll would flash a live region at the reader forever,
  // so only a user-triggered run (the refresh button / refreshKey / attempt) speaks.
  t.mock.timers.enable({ apis: ['setInterval'] })
  const gates = [deferred(), deferred(), deferred()]
  let calls = 0
  stubFetch(t, () => gates[Math.min(calls++, gates.length - 1)].promise)
  const render = mount(t, 'OverviewView')
  const props = { sessionId: 'session-a', visible: true }
  render(props)
  await setImmediate()
  gates[0].resolve(ok(overviewValue()))
  await setImmediate()
  let tree = render(props)
  assert.equal(countText(tree, '正在刷新…'), 0, 'a landed read announces nothing')
  t.mock.timers.tick(15000)
  await setImmediate()
  assert.equal(calls, 2, 'the interval started the second read')
  tree = render(props)
  assert.equal(countText(tree, '正在刷新…'), 0, 'an interval poll is silent')
  assert.equal(liveRegions(tree).length, 0, 'no live region flashes for a background poll')
  gates[1].resolve(ok(overviewValue()))
  await setImmediate()
  tree = render(props)
  assert.equal(countText(tree, '正在刷新…'), 0)
  // The refresh button is a reader action, so that run does announce while it runs.
  const refresh = byText(tree, '刷新')[0]
  assert.ok(refresh, 'the standalone 概览 can refresh')
  refresh.props.onClick()
  render(props)
  tree = render(props)
  assert.equal(countText(tree, '正在刷新…'), 1, 'the user refresh announces once')
  assert.equal(liveRegions(tree).length, 1)
  gates[2].resolve(ok(overviewValue()))
  await setImmediate()
  tree = render(props)
  assert.equal(countText(tree, '正在刷新…'), 0, 'and stops announcing when it lands')
})

test('the panel re-reads when the window regains focus, silently', async (t) => {
  // Coming back to the window is the second no-restart path. It is a background
  // read too (silent), and the listener must be removed on cleanup.
  const listeners = new Map()
  const added = []
  const removed = []
  globalThis.window = {
    addEventListener(type, listener) {
      added.push(type)
      listeners.set(type, listener)
    },
    removeEventListener(type) {
      removed.push(type)
      listeners.delete(type)
    },
  }
  t.after(() => {
    delete globalThis.window
  })
  const gates = [deferred(), deferred()]
  let calls = 0
  stubFetch(t, () => gates[Math.min(calls++, gates.length - 1)].promise)
  const render = mount(t, 'OverviewView')
  const props = { sessionId: 'session-a', visible: true }
  render(props)
  await setImmediate()
  gates[0].resolve(ok(overviewValue()))
  await setImmediate()
  render(props)
  assert.ok(added.includes('focus'), 'the poll listens for window focus')
  listeners.get('focus')()
  await setImmediate()
  assert.equal(calls, 2, 'focus started a fresh read')
  const tree = render(props)
  assert.equal(countText(tree, '正在刷新…'), 0, 'a focus read is a background read: silent')
  gates[1].resolve(ok(overviewValue()))
  await setImmediate()
  // A dependency change re-runs the effect, so cleanup runs here and the listener
  // is removed before it is re-added for the new run.
  render({ ...props, refreshKey: 1 })
  assert.ok(removed.includes('focus'), 'the focus listener is removed on cleanup')
})

test('every panel POST carries the same-origin fence header', async (t) => {
  // The desktop host's dsh-app:// proxy strips Origin before forwarding, so the
  // route's CSRF fence has to accept a header a web page cannot send cross-site
  // without a preflight the route never answers.
  const sent = stubFetch(t, () => ok(overviewValue()))
  const render = mount(t, 'OverviewView')
  render({ sessionId: 'session-a', visible: true })
  await setImmediate()
  assert.equal(sent.length, 1)
  assert.equal(sent[0].headers['content-type'], 'application/json')
  assert.equal(
    sent[0].headers['x-obsidian-mem-panel'],
    '1',
    'the panel header is on every POST, reads included',
  )
})

test('the health view owns its loading announcement once, from the skeleton', async (t) => {
  const gate = deferred()
  stubFetch(t, () => gate.promise)
  const render = mount(t, 'HealthView')
  const props = { sessionId: 'session-a', visible: true }
  render(props)
  await setImmediate()
  const tree = render(props)
  assert.equal(countText(tree, '正在读取记忆…'), 1, 'the skeleton is the one loading announcement')
  assert.equal(liveRegions(tree).length, 1, 'one live region in the loading state')
})

/** Render health until its first read lands. */
async function health(t) {
  const render = mount(t, 'HealthView')
  const props = { sessionId: 'session-a', visible: true }
  render(props)
  await setImmediate()
  return { render, props, tree: render(props) }
}

test('the sheet restores focus to its invoker and the busy trap keeps focus on the dialog', async (t) => {
  const confirmGate = deferred()
  stubFetch(t, (body) => {
    if (body.action === 'preview') return ok(previewValue('retry-job'))
    if (body.action === 'confirm') return confirmGate.promise
    return ok(healthValue())
  })
  const { render, props } = await health(t)
  let tree = render(props)
  const restored = []
  const invoker = { focus: () => restored.push('invoker') }
  byText(tree, '重新排队')[0].props.onClick({ currentTarget: invoker })
  await setImmediate()
  tree = render(props)
  assert.ok(
    find(tree, (node) => node?.props?.role === 'alertdialog'),
    'the preview opens the sheet',
  )
  assert.equal(render.focused.at(-1), 'button:mem-sheet-cancel', 'Cancel takes focus on open')

  byText(tree, '确认执行')[0].props.onClick()
  await setImmediate()
  tree = render(props)
  const dialog = find(tree, (node) => node?.props?.role === 'alertdialog')
  assert.ok(dialog, 'the sheet stays open while the confirm is in flight')
  assert.equal(
    find(tree, (node) => node?.props?.className === 'mem-sheet-panel').props.tabIndex,
    -1,
    'the dialog panel is focusable as the trap floor',
  )
  const prevented = []
  dialog.props.onKeyDown({
    key: 'Tab',
    shiftKey: false,
    target: null,
    preventDefault: () => prevented.push('tab'),
  })
  assert.deepEqual(prevented, ['tab'], 'the trap still handles Tab while busy')
  assert.equal(
    render.focused.at(-1),
    'div:mem-sheet-panel',
    'focus stays on the dialog instead of dropping to body',
  )

  confirmGate.resolve(failure(409, 'preview-stale', 'stale preview'))
  await setImmediate()
  tree = render(props)
  assert.equal(
    find(tree, (node) => node?.props?.role === 'alertdialog'),
    undefined,
    'the invalidating failure closes the sheet',
  )
  assert.deepEqual(restored, ['invoker'], 'focus returns to the control that opened the sheet')
})

test('the retry action previews facts then confirms one token and reports the outcome', async (t) => {
  const sent = stubFetch(t, (body) => {
    if (body.action === 'preview') return ok(previewValue('retry-job'))
    if (body.action === 'confirm') return ok(confirmValue('retry-job'))
    return ok(healthValue())
  })
  const { render, props } = await health(t)
  const ready = render(props)
  const retry = byText(ready, '重新排队')[0]
  assert.ok(retry, 'a failed job offers one retry affordance')
  retry.props.onClick()
  await setImmediate()
  let tree = render(props)
  const dialog = find(tree, (node) => node?.props?.role === 'alertdialog')
  assert.ok(dialog, 'the preview opens a sheet')
  assert.ok(byClass(tree, 'mem-sheet-fact').length >= 2, 'the facts are listed')
  const previewRequest = sent.filter((entry) => entry.body.action === 'preview').at(-1)
  assert.deepEqual(previewRequest.body, {
    sessionId: 'session-a',
    action: 'preview',
    mutation: 'retry-job',
    args: { jobId: 'job-0123456789abcdef0123456789abcdef' },
    // The panel's resolved locale rides every POST body, so the route never has to
    // guess from Accept-Language; zh is sent explicitly rather than left to the default.
    locale: 'zh',
  })
  assert.equal(
    sent.filter((entry) => entry.body.action === 'confirm').length,
    0,
    'a preview writes nothing',
  )
  const confirm = byText(tree, '确认执行')[0]
  assert.ok(confirm, 'the confirm label comes from the preview')
  confirm.props.onClick()
  await setImmediate()
  tree = render(props)
  const confirmRequest = sent.filter((entry) => entry.body.action === 'confirm').at(-1)
  assert.deepEqual(confirmRequest.body, {
    sessionId: 'session-a',
    action: 'confirm',
    token: 'token-case-1',
    locale: 'zh',
  })
  assert.equal(
    find(tree, (node) => node?.props?.role === 'alertdialog'),
    undefined,
    'the sheet closes',
  )
  // The success belongs to the card that owns the action: a notice at the top of the
  // long 健康 page is off-screen while the reader is at the queue, which is precisely
  // the "no visible feedback" bug.
  const queueNode = find(
    tree,
    (node) => node?.type === 'section' && node.props['aria-label'] === '待处理作业',
  )
  const inline = byClass(queueNode, 'mem-action-result')
  assert.equal(inline.length, 1, 'the outcome is drawn in the queue card')
  assert.equal(inline[0].props.role, 'status')
  assert.ok(
    texts(inline[0]).some((text) => String(text).includes('已重新排队')),
    'the outcome is named in words',
  )
  assert.ok(
    texts(inline[0]).some((text) => String(text).includes('刚刚')),
    'and carries the action time',
  )
  assert.equal(byClass(tree, 'mem-action-status').length, 0, 'no top-of-page notice for it')
})

test('Escape and cancel close the sheet without sending a request', async (t) => {
  const sent = stubFetch(t, (body) =>
    body.action === 'preview' ? ok(previewValue('retry-job')) : ok(healthValue()),
  )
  const { render, props } = await health(t)
  let tree = render(props)
  byText(tree, '重新排队')[0].props.onClick()
  await setImmediate()
  tree = render(props)
  const before = sent.length
  find(tree, (node) => node?.props?.role === 'alertdialog').props.onKeyDown({
    key: 'Escape',
    preventDefault() {},
  })
  await setImmediate()
  tree = render(props)
  assert.equal(
    find(tree, (node) => node?.props?.role === 'alertdialog'),
    undefined,
    'Escape closes it',
  )
  assert.equal(sent.length, before, 'closing sends nothing')

  byText(tree, '重新排队')[0].props.onClick()
  await setImmediate()
  tree = render(props)
  byText(tree, '取消')[0].props.onClick()
  await setImmediate()
  tree = render(props)
  assert.equal(
    find(tree, (node) => node?.props?.role === 'alertdialog'),
    undefined,
    'cancel closes it',
  )
  assert.equal(sent.length, before + 1, 'only the second preview was sent')
})

test('a 409 preview-stale invalidates the sheet, refreshes health and says so', async (t) => {
  const sent = stubFetch(t, (body) => {
    if (body.action === 'preview') return ok(previewValue('retry-job'))
    if (body.action === 'confirm') return failure(409, 'preview-stale', 'stale preview')
    return ok(healthValue())
  })
  const { render, props } = await health(t)
  let tree = render(props)
  byText(tree, '重新排队')[0].props.onClick()
  await setImmediate()
  tree = render(props)
  byText(tree, '确认执行')[0].props.onClick()
  await setImmediate()
  tree = render(props)
  assert.equal(
    find(tree, (node) => node?.props?.role === 'alertdialog'),
    undefined,
  )
  assert.ok(
    byClass(tree, 'mem-action-status').some((node) =>
      texts(node).some((text) => String(text).includes('预览已过期')),
    ),
  )
  assert.equal(
    sent.filter((entry) => entry.body.action === 'confirm').length,
    1,
    'one confirm attempt, then the sheet is gone',
  )
  assert.ok(
    sent.filter((entry) => entry.body.action === 'health').length >= 2,
    'the underlying view refreshes',
  )
})

test('a replayed confirmation names the same outcome and says nothing was written twice', async (t) => {
  stubFetch(t, (body) => {
    if (body.action === 'preview') return ok(previewValue('retry-job'))
    if (body.action === 'confirm') return ok(confirmValue('retry-job', true))
    return ok(healthValue())
  })
  const { render, props } = await health(t)
  let tree = render(props)
  byText(tree, '重新排队')[0].props.onClick()
  await setImmediate()
  tree = render(props)
  byText(tree, '确认执行')[0].props.onClick()
  await setImmediate()
  tree = render(props)
  const status = byClass(tree, 'mem-action-result')
    .map((node) => texts(node).join(''))
    .join(' ')
  assert.ok(status.includes('已重新排队'), 'the outcome is still named')
  assert.ok(status.includes('未重复'), 'the replay is explained')
})

test('compact-hot and refresh-digest open the same sheet with their own facts', async (t) => {
  stubFetch(t, (body) => {
    if (body.action === 'preview')
      return ok(
        body.mutation === 'compact-hot'
          ? {
              mutation: 'compact-hot',
              token: 'token-compact',
              expiresAt: Date.now() + 60_000,
              preview: {
                title: '压缩热层',
                confirmLabel: '确认执行',
                facts: [
                  { label: '使用', value: '7,200 / 9,000' },
                  { label: '可搬出', value: '3 条' },
                ],
                effects: ['折叠指针行并归档最旧条目'],
              },
            }
          : {
              ...previewValue('refresh-digest'),
              preview: {
                title: '刷新今日摘要',
                confirmLabel: '确认执行',
                facts: [
                  { label: '目标', value: 'Projects/repo/_meta/digest.md' },
                  { label: '窗口', value: '最近 1 天' },
                ],
                effects: ['重写项目自己的摘要笔记'],
              },
            },
      )
    if (body.action === 'confirm')
      return ok(confirmValue(body.token === 'token-compact' ? 'compact-hot' : 'refresh-digest'))
    return ok(healthValue())
  })
  const { render, props } = await health(t)
  let tree = render(props)
  byText(tree, '整理热层')[0].props.onClick()
  await setImmediate()
  tree = render(props)
  assert.ok(byClass(tree, 'mem-sheet-fact').some((node) => texts(node).join('').includes('使用')))
  byText(tree, '确认执行')[0].props.onClick()
  await setImmediate()
  tree = render(props)
  const hotNode = find(
    tree,
    (node) => node?.type === 'section' && node.props['aria-label'] === '热层',
  )
  assert.ok(
    byClass(hotNode, 'mem-action-result').some((node) =>
      texts(node).some((text) => String(text).includes('搬出 3')),
    ),
    'the outcome is drawn in the hot card',
  )
  byText(tree, '发布项目摘要')[0].props.onClick()
  await setImmediate()
  tree = render(props)
  assert.ok(
    byClass(tree, 'mem-sheet-fact').some((node) =>
      texts(node).join('').includes('_meta/digest.md'),
    ),
  )
  byText(tree, '取消')[0].props.onClick()
})

test('a transient confirm failure stays inline in the sheet and Cancel still closes it', async (t) => {
  const sent = stubFetch(t, (body) => {
    if (body.action === 'preview') return ok(previewValue('retry-job'))
    if (body.action === 'confirm') return failure(503, 'unavailable', 'memory panel unavailable')
    return ok(healthValue())
  })
  const { render, props } = await health(t)
  let tree = render(props)
  byText(tree, '重新排队')[0].props.onClick()
  await setImmediate()
  tree = render(props)
  byText(tree, '确认执行')[0].props.onClick()
  await setImmediate()
  tree = render(props)
  const sheet = find(tree, (node) => node?.props?.role === 'alertdialog')
  assert.ok(sheet, 'the sheet stays open so the preview is not lost')
  assert.ok(
    byClass(tree, 'mem-sheet-error').some((node) => texts(node).join('').includes('稍后重试')),
    'the refusal is named inline',
  )
  byText(tree, '取消')[0].props.onClick()
  await setImmediate()
  tree = render(props)
  assert.equal(
    find(tree, (node) => node?.props?.role === 'alertdialog'),
    undefined,
  )
  assert.equal(
    sent.filter((entry) => entry.body.action === 'preview').length,
    1,
    'no silent re-preview',
  )
})

test('without capabilities the panel is fully usable read-only and offers no confirm action', async (t) => {
  stubFetch(t, () => ok(healthValue({ capabilities: { mutations: [] } })))
  const { render, props } = await health(t)
  const tree = render(props)
  assert.equal(byText(tree, '重新排队').length, 0)
  assert.equal(byText(tree, '整理热层').length, 0)
  assert.equal(byText(tree, '发布项目摘要').length, 0)
  assert.ok(byClass(tree, 'mem-stamp').length > 0, 'the read-only view still renders')
})

test('an unavailable preview API hides the controls and leaves one clear notice', async (t) => {
  stubFetch(t, (body) =>
    body.action === 'preview'
      ? failure(503, 'unavailable', 'memory panel unavailable')
      : ok(healthValue()),
  )
  const { render, props } = await health(t)
  let tree = render(props)
  byText(tree, '重新排队')[0].props.onClick()
  await setImmediate()
  tree = render(props)
  assert.equal(byText(tree, '重新排队').length, 0, 'the mutation controls are gone')
  assert.ok(
    byClass(tree, 'mem-action-status').some((node) =>
      texts(node).some((text) => String(text).includes('只读')),
    ),
    'the panel says it fell back to read-only',
  )
  assert.ok(byClass(tree, 'mem-stamp').length > 0, 'reading keeps working')
})

// ---------------------------------------------------------------------------
// Round 5 — the startup race and the invisible mutation feedback.
// ---------------------------------------------------------------------------

test('a startup 404 retries fast as a status, never as a restart demand', async (t) => {
  // The panel can mount before the plugin's route is registered. A bodyless 404 there
  // is a boot race, so the poll retries once a second and the line is a pending status;
  // mapping it to the fatal restart copy (the reported bug) makes a slow start look
  // like a broken install.
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let calls = 0
  stubFetch(t, () => {
    calls += 1
    return calls < 3 ? plain404() : ok(healthValue())
  })
  const render = mount(t, 'HealthView')
  const props = { sessionId: 'session-a', visible: true }
  render(props)
  await setImmediate()
  let tree = render(props)
  const pending = find(
    tree,
    (node) =>
      node?.props?.role === 'status' &&
      texts(node).some((text) => String(text).includes('记忆接口正在启动')),
  )
  assert.ok(pending, 'the route-not-ready state is a status')
  assert.equal(pending.props['aria-live'], 'polite')
  assert.equal(countText(tree, '重启 dsh'), 0, 'no restart demand during the retry window')
  assert.equal(byClass(tree, 'mem-gauge').length, 0, 'no data yet')
  // One second later the fast retry runs — not the 15s poll.
  t.mock.timers.tick(1000)
  await setImmediate()
  tree = render(props)
  assert.equal(calls, 2, 'the fast retry ran after 1s')
  assert.equal(countText(tree, '记忆接口正在启动'), 1, 'still pending')
  t.mock.timers.tick(1000)
  await setImmediate()
  tree = render(props)
  assert.equal(calls, 3)
  assert.equal(countText(tree, '记忆接口正在启动'), 0, 'the pending line clears')
  assert.equal(byClass(tree, 'mem-gauge').length, 4, 'the health page arrives')
})

test('an old host coded 404 for a recovering session retries too', async (t) => {
  // Version skew: an older route answered session-missing as a coded 404 envelope. The
  // body must be parsed BEFORE the 404 is classified as the route being absent, or a
  // host that only lacks the new 503 status still shows the restart copy.
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let calls = 0
  stubFetch(t, () => {
    calls += 1
    return calls < 3
      ? failure(404, 'session-missing', 'the session is not live')
      : ok(healthValue())
  })
  const render = mount(t, 'HealthView')
  const props = { sessionId: 'session-a', visible: true }
  render(props)
  await setImmediate()
  let tree = render(props)
  assert.equal(countText(tree, '会话正在恢复'), 1, 'the session wait is named')
  assert.equal(countText(tree, '记忆接口正在启动'), 0, 'a coded envelope is not the route race')
  assert.equal(countText(tree, '重启 dsh'), 0, 'and not a restart demand')
  t.mock.timers.tick(1000)
  await setImmediate()
  t.mock.timers.tick(1000)
  await setImmediate()
  tree = render(props)
  assert.equal(calls, 3)
  assert.equal(countText(tree, '会话正在恢复'), 0, 'the session recovers')
  assert.equal(byClass(tree, 'mem-gauge').length, 4, 'the health page arrives')
})

test('the startup retry is bounded, and an exhausted plain 404 keeps the restart copy', async (t) => {
  // A genuinely unregistered route must end somewhere actionable instead of spinning
  // forever: 20 fast attempts, then the one restart sentence.
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const sent = stubFetch(t, () => plain404())
  const render = mount(t, 'HealthView')
  const props = { sessionId: 'session-a', visible: true }
  render(props)
  await setImmediate()
  let tree = render(props)
  assert.equal(countText(tree, '记忆接口正在启动'), 1)
  for (let index = 0; index < 20; index += 1) {
    t.mock.timers.tick(1000)
    await setImmediate()
  }
  tree = render(props)
  assert.equal(sent.length, 21, 'one attempt plus the 20-retry cap')
  assert.equal(
    countText(tree, '记忆接口正在启动'),
    0,
    'the pending line is not a permanent spinner',
  )
  const alert = find(tree, (node) => node?.props?.role === 'alert')
  assert.ok(alert, 'the exhausted race is an alert')
  assert.ok(
    texts(alert).some((text) => String(text).includes('重启 dsh')),
    'and names the one action that fixes it',
  )
  assert.equal(byClass(tree, 'mem-gauge').length, 0)
})

test('the hot card states whether the trigger line has been crossed', async (t) => {
  // Compact is a deliberate no-op below the trigger line, so the card says so BEFORE
  // the click instead of explaining zero afterwards.
  let reply = ok(healthValue())
  stubFetch(t, () => reply)
  const props = { sessionId: 'session-a', visible: true }
  const above = mount(t, 'HealthView')
  above(props)
  await setImmediate()
  let tree = above(props)
  let hotNode = find(
    tree,
    (node) => node?.type === 'section' && node.props['aria-label'] === '热层',
  )
  let state = byClass(hotNode, 'mem-hot-state')
  assert.equal(state.length, 1, 'the hot card carries one trigger state')
  assert.equal(state[0].props.children[0], '已超过触发线（会归档条目）')
  assert.ok(state[0].props.className.split(' ').includes('is-ok'))
  assert.equal(byClass(hotNode, 'mem-hot-state is-warn').length, 0)

  // The live case measured by the Lead: 5,728 used of 9,000, trigger 6,030.
  reply = ok(
    healthValue({ hot: { ...healthValue().hot, used: 5728, archivable: 14, compactable: 14 } }),
  )
  const below = mount(t, 'HealthView')
  below(props)
  await setImmediate()
  tree = below(props)
  hotNode = find(tree, (node) => node?.type === 'section' && node.props['aria-label'] === '热层')
  state = byClass(hotNode, 'mem-hot-state')
  assert.equal(state.length, 1)
  assert.equal(state[0].props.children[0], '未到触发线（整理不会搬出条目）')
  assert.ok(state[0].props.className.split(' ').includes('is-warn'))
})

test('整理热层 that moves nothing explains why inside the hot card', async (t) => {
  // The live result was moved 0 / folded 0 / reclaimed 0 because 5,728 < the 6,030
  // trigger. "已压缩热层：搬出 0，折叠 0，回收 0 字符" explained nothing; the outcome now
  // names the hot usage, the trigger line and the rule, in the card the reader is on.
  const hot = { ...healthValue().hot, used: 5728, archivable: 14, compactable: 14 }
  stubFetch(t, (body) => {
    if (body.action === 'preview') return ok(previewValue('compact-hot'))
    if (body.action === 'confirm')
      return ok({
        mutation: 'compact-hot',
        replayed: false,
        result: {
          status: 'compacted',
          moved: 0,
          folded: 0,
          reclaimed: 0,
          used: 5728,
          capacity: 9000,
          trigger: 6030,
        },
      })
    return ok(healthValue({ hot }))
  })
  const { render, props } = await health(t)
  let tree = render(props)
  byText(tree, '整理热层')[0].props.onClick()
  await setImmediate()
  tree = render(props)
  byText(tree, '确认执行')[0].props.onClick()
  await setImmediate()
  tree = render(props)
  const hotNode = find(
    tree,
    (node) => node?.type === 'section' && node.props['aria-label'] === '热层',
  )
  const result = byClass(hotNode, 'mem-action-result')
  assert.equal(result.length, 1, 'the outcome is drawn in the hot card')
  assert.equal(result[0].props.role, 'status')
  const text = texts(result[0]).join('')
  assert.ok(text.includes('未搬出内容'), 'it says nothing moved: ' + text)
  assert.ok(text.includes('5,728/9,000'), 'it states the hot usage: ' + text)
  assert.ok(text.includes('未到触发线 6,030'), 'it names the trigger line: ' + text)
  assert.ok(text.includes('刚刚'), 'and carries the action time')
  assert.equal(byClass(tree, 'mem-action-status').length, 0, 'no top-of-page notice for a success')
})

test('发布项目摘要 reports the written file and its size in the digest card', async (t) => {
  stubFetch(t, (body) => {
    if (body.action === 'preview') return ok(previewValue('refresh-digest'))
    if (body.action === 'confirm')
      return ok({
        mutation: 'refresh-digest',
        replayed: false,
        result: {
          status: 'updated',
          path: 'Projects/repo/_meta/digest.md',
          id: 'doc-1',
          charCount: 1625,
          txId: 'tx-1',
          window: { days: 1 },
        },
      })
    return ok(healthValue())
  })
  const { render, props } = await health(t)
  let tree = render(props)
  byText(tree, '发布项目摘要')[0].props.onClick()
  await setImmediate()
  tree = render(props)
  byText(tree, '确认执行')[0].props.onClick()
  await setImmediate()
  tree = render(props)
  const digestNode = find(
    tree,
    (node) => node?.type === 'section' && node.props['aria-label'] === '今日摘要',
  )
  const result = byClass(digestNode, 'mem-action-result')
  assert.equal(result.length, 1, 'the outcome is drawn in the digest card')
  const text = texts(result[0]).join('')
  assert.ok(text.includes('摘要已更新'), 'the write is named: ' + text)
  assert.ok(text.includes('Projects/repo/_meta/digest.md'), 'the path is named: ' + text)
  assert.ok(text.includes('1,625 字符'), 'the written size is named: ' + text)
  assert.ok(text.includes('刚刚'))
})

test('an unchanged digest says it wrote nothing', async (t) => {
  stubFetch(t, (body) => {
    if (body.action === 'preview') return ok(previewValue('refresh-digest'))
    if (body.action === 'confirm')
      return ok({ mutation: 'refresh-digest', replayed: false, result: { status: 'unchanged' } })
    return ok(healthValue())
  })
  const { render, props } = await health(t)
  let tree = render(props)
  byText(tree, '发布项目摘要')[0].props.onClick()
  await setImmediate()
  tree = render(props)
  byText(tree, '确认执行')[0].props.onClick()
  await setImmediate()
  tree = render(props)
  const digestNode = find(
    tree,
    (node) => node?.type === 'section' && node.props['aria-label'] === '今日摘要',
  )
  const text = texts(byClass(digestNode, 'mem-action-result')[0]).join('')
  assert.ok(text.includes('摘要无变化'), 'a no-op is stated as one: ' + text)
  assert.ok(text.includes('未写入文件'), 'and the file untouched: ' + text)
})

test('each action shows its own busy label while its preview is in flight', async (t) => {
  // The buttons were disabled globally but every label stayed static, so a click read
  // as "nothing happened" even while the request was running.
  const gates = {
    'compact-hot': deferred(),
    'refresh-digest': deferred(),
    'retry-job': deferred(),
  }
  stubFetch(t, (body) =>
    body.action === 'preview' ? gates[body.mutation].promise : ok(healthValue()),
  )
  const { render, props } = await health(t)
  let tree = render(props)
  byText(tree, '整理热层')[0].props.onClick()
  await setImmediate()
  tree = render(props)
  assert.equal(byText(tree, '整理中…').length, 1, 'the hot action says what it is doing')
  assert.equal(byText(tree, '整理热层').length, 0)
  gates['compact-hot'].resolve(ok(previewValue('compact-hot')))
  await setImmediate()
  tree = render(props)
  byText(tree, '取消')[0].props.onClick()
  await setImmediate()
  tree = render(props)
  assert.equal(byText(tree, '整理热层').length, 1, 'the label returns after the preview')

  byText(tree, '发布项目摘要')[0].props.onClick()
  await setImmediate()
  tree = render(props)
  assert.equal(byText(tree, '发布中…').length, 1, 'the digest action says what it is doing')
  gates['refresh-digest'].resolve(ok(previewValue('refresh-digest')))
  await setImmediate()
  tree = render(props)
  byText(tree, '取消')[0].props.onClick()
  await setImmediate()
  tree = render(props)

  byText(tree, '重新排队')[0].props.onClick()
  await setImmediate()
  tree = render(props)
  assert.equal(byText(tree, '重试中…').length, 1, 'the job action says what it is doing')
  gates['retry-job'].resolve(ok(previewValue('retry-job')))
  await setImmediate()
  tree = render(props)
  byText(tree, '取消')[0].props.onClick()
})

// ---------------------------------------------------------------------------
// English locale (i18n spec §2.5). Chinese stays the default: a mount with no
// locale option runs the same view the suite always has, because this harness
// has neither a window nor a navigator. Only an explicit `locale: 'en'` switches
// the catalogue, and then every POST body carries the panel's own locale so the
// route never has to guess from Accept-Language.
// ---------------------------------------------------------------------------

/** Every string a reader or screen reader sees in the rendered tree. */
const rendered = (tree) => texts(tree).map((value) => String(value))
/** Han ideographs: the English chrome must never contain one. */
const HAN = /[\u4e00-\u9fff]/u

test('an explicit en locale renders the overview chrome in English', async (t) => {
  const activity = activityFixture()
  const tags = {
    items: [
      { tag: 'dsh-mem/decision', n: 5 },
      { tag: 'dsh-mem/convention', n: 3 },
    ],
    total: 8,
    distinct: 2,
  }
  const recent = [
    {
      path: 'Projects/repo/Decisions/a.md',
      title: 'Decision note',
      type: 'decision',
      updated: '2026-10-27T12:00:00.000Z',
    },
    {
      path: 'Projects/repo/Conventions/b.md',
      title: 'Convention note',
      type: 'convention',
      updated: '2026-10-27T11:00:00.000Z',
    },
  ]
  const sent = stubFetch(t, () => ok(overviewValue({ activity, tags, recent })))

  // The default mount (no locale option, no DOM globals) keeps the zh catalogue.
  const zhRender = mount(t, 'OverviewView')
  zhRender(chartProps())
  await setImmediate()
  const zhTree = zhRender(chartProps())
  assert.ok(texts(zhTree).includes('最近变化'), 'the default mount stays Chinese')
  assert.ok(texts(zhTree).includes('概览'), 'and keeps the zh shell title')
  assert.equal(sent[0].body.locale, 'zh', 'even a zh body is tagged, not left to the route default')

  const enRender = mount(t, 'OverviewView', { locale: 'en' })
  // The "All →" strip actions only exist when the shell hands the view onJump;
  // pass one so the en run also covers that inline label.
  const composed = chartProps({ onJump: () => {} })
  enRender(composed)
  await setImmediate()
  const tree = enRender(composed)
  const strings = rendered(tree)
  for (const copy of [
    'Overview',
    'Recent changes',
    'Activity',
    'Created & updated',
    'Tag frequency',
    'Composition',
    'Memories',
    'Links',
    'Orphans',
    'Pending',
    'Health',
    'All →',
  ])
    assert.ok(strings.includes(copy), 'the en overview renders ' + copy)
  assert.equal(strings.includes('最近变化'), false, 'no Chinese chrome in the en overview')
  // The heat map's spoken count is built from the series, so pin its English
  // grammar rather than one fixture-dependent number.
  const grid = byClass(tree, 'mem-heat-grid')[0]
  assert.match(
    String(grid.props['aria-label']),
    /^Activity over the last \d+ weeks, \d+ entr(?:y|ies) in total, peak \d+$/u,
  )
  assert.ok(
    strings.some((value) =>
      /^Last \d+ weeks \(\d+ days\) · \d+ active days this week · \d+ entr(?:y|ies) total$/u.test(
        value,
      ),
    ),
    'the heat map meta line is English',
  )
  assert.equal(sent.at(-1).body.locale, 'en', 'an en mount tags every read body en')
  assert.deepEqual(
    strings.filter((value) => HAN.test(value)),
    [],
    'no Han-character chrome in the en overview',
  )
})

test('an empty recent list has English copy too', async (t) => {
  // The other en fixture always carries two recent notes, which is exactly why the
  // hardcoded zh empty state survived until independent verification: the en tests
  // never rendered it. Pin the empty branch itself.
  const sent = stubFetch(t, () => ok(overviewValue({ recent: [] })))
  const render = mount(t, 'OverviewView', { locale: 'en' })
  const props = chartProps({ onJump: () => {} })
  render(props)
  await setImmediate()
  const tree = render(props)
  const strings = rendered(tree)
  assert.ok(strings.includes('Nothing to show yet.'), 'the empty recent list is English')
  assert.deepEqual(
    strings.filter((value) => HAN.test(value)),
    [],
    'no Han-character chrome in the en empty recent list',
  )
  assert.equal(sent.at(-1).body.locale, 'en')
})

test('an explicit en locale renders the health cards and actions in English', async (t) => {
  // The hot file's section headings are the plugin's own three zone names, so this
  // feeds the REAL zh server data and pins the panel's translation of it rather than
  // pretending the wire already spoke English.
  const hot = {
    ...healthValue().hot,
    sections: [
      { name: '强约束', chars: 600, entries: 1, pointers: 0, moveable: 1 },
      { name: '已完成', chars: 1200, entries: 1, pointers: 2, moveable: 3 },
      { name: '进行中', chars: 5400, entries: 6, pointers: 0, moveable: 2 },
    ],
  }
  const sent = stubFetch(t, () => ok(healthValue({ hot })))
  const render = mount(t, 'HealthView', { locale: 'en' })
  const props = { sessionId: 'session-a', visible: true }
  render(props)
  await setImmediate()
  const tree = render(props)
  const strings = rendered(tree)
  for (const copy of [
    'Health',
    'Index',
    'Pending jobs',
    'Hot zone',
    'Digest',
    'Diagnostics',
    'Ready',
    // The zone headings are panel copy, not user data: each standard name has an
    // English label, and an unknown name would pass through as written.
    'Strong constraints',
    'In progress',
    'Completed',
  ])
    assert.ok(strings.includes(copy), 'the en health page renders ' + copy)
  // The figure grids are named by aria-label, not by a text child.
  for (const label of ['Index figures', 'Hot zone figures', 'Digest figures'])
    assert.ok(
      find(tree, (node) => node?.props?.['aria-label'] === label),
      'the en health page names the ' + label + ' group',
    )
  for (const copy of ['Retry job', 'Compact hot zone', 'Publish digest'])
    assert.ok(byText(tree, copy).length >= 1, 'the en action reads ' + copy)
  assert.equal(sent.at(-1).body.locale, 'en', 'the en health read is tagged en')
  assert.deepEqual(
    strings.filter((value) => HAN.test(value)),
    [],
    'no Han-character chrome on the en health page',
  )
})

test('an explicit en locale renders the search page and its empty state in English', async (t) => {
  const sent = stubFetch(t, () =>
    ok({
      query: 'binding',
      hits: [
        {
          path: 'Projects/repo/Decisions/a.md',
          title: 'Decision note',
          type: 'decision',
          status: 'active',
          source: 'title',
          snippet: 'Binding memory notes',
          scoreSignals: ['title'],
        },
      ],
      limit: 25,
      hasMore: false,
      tookMs: 2,
    }),
  )
  const render = mount(t, 'SearchView', { locale: 'en' })
  // An empty query is the idle state: the body shows the idle sentence and starts
  // no read at all.
  let tree = render(searchProps({ query: '' }))
  let strings = rendered(tree)
  assert.ok(strings.includes('Search'), 'the page head says Search')
  assert.ok(strings.includes('Local memory index'), 'the local index is named')
  assert.ok(
    strings.includes('Type a keyword to start searching the local memory index.'),
    'the idle sentence is English',
  )
  assert.equal(byText(tree, 'Back').length, 1, 'the way back is English')
  assert.deepEqual(
    byClass(tree, 'mem-filter')
      .map((node) => node.props['aria-label'])
      .sort(),
    ['Scope', 'Status', 'Type'],
    'the filter groups are named in English',
  )
  assert.deepEqual(
    byClass(tree, 'mem-filter-option')
      .filter((node) => node.props['aria-pressed'] === true)
      .map((node) => node.props.children[0]),
    ['All', 'All', 'Current project'],
    'the default filter pills are English',
  )
  assert.equal(sent.length, 0, 'an empty query reads nothing')

  render(searchProps({ query: 'binding' }))
  await setImmediate()
  tree = render(searchProps({ query: 'binding' }))
  assert.equal(sent.length, 1, 'a query runs exactly one read')
  assert.equal(sent[0].body.locale, 'en', 'the en search read is tagged en')
  strings = rendered(tree)
  for (const copy of ['Decision', 'Active', 'Source: Title'])
    assert.ok(strings.includes(copy), 'the en result row renders ' + copy)
  assert.ok(
    strings.some((value) => value === '1 entry in total · 2 ms'),
    'the footer counts in English',
  )
  assert.deepEqual(
    strings.filter((value) => HAN.test(value)),
    [],
    'no Han-character chrome on the en search page',
  )
})

test('an explicit en locale renders the confirm sheet in English', async (t) => {
  const englishPreview = {
    mutation: 'retry-job',
    token: 'token-case-1',
    expiresAt: Date.now() + 60_000,
    preview: {
      title: 'Retry failed job',
      confirmLabel: 'Confirm',
      facts: [
        { label: 'Job', value: 'job-0123456789abcdef0123456789abcdef' },
        { label: 'State', value: 'failed' },
      ],
      effects: ['The job re-enters the queue'],
      warning: 'DSH may wake a worker; Codex only requeues the job.',
    },
  }
  // The hot zone's section names are server data; feed English names so the
  // no-Han assertion can only trip on chrome the panel itself writes.
  const hot = {
    ...healthValue().hot,
    sections: [
      { name: 'Done', chars: 1200, entries: 1, pointers: 2, moveable: 3 },
      { name: 'In progress', chars: 5400, entries: 6, pointers: 0, moveable: 2 },
    ],
  }
  const sent = stubFetch(t, (body) =>
    body.action === 'preview' ? ok(englishPreview) : ok(healthValue({ hot })),
  )
  const render = mount(t, 'HealthView', { locale: 'en' })
  const props = { sessionId: 'session-a', visible: true }
  render(props)
  await setImmediate()
  let tree = render(props)
  byText(tree, 'Retry job')[0].props.onClick()
  await setImmediate()
  tree = render(props)
  const dialog = find(tree, (node) => node?.props?.role === 'alertdialog')
  assert.ok(dialog, 'the en preview opens the sheet')
  const strings = rendered(tree)
  for (const copy of [
    'Retry failed job',
    'Preview valid for 60 seconds',
    'Cancel',
    'Confirm',
    'Waiting for confirmation',
  ])
    assert.ok(strings.includes(copy), 'the en sheet renders ' + copy)
  assert.equal(sent.filter((entry) => entry.body.action === 'preview')[0].body.locale, 'en')
  assert.deepEqual(
    strings.filter((value) => HAN.test(value)),
    [],
    'no Han-character chrome in the en confirm sheet',
  )
  byText(tree, 'Cancel')[0].props.onClick()
  await setImmediate()
  tree = render(props)
  assert.equal(
    find(tree, (node) => node?.props?.role === 'alertdialog'),
    undefined,
  )
})

/**
 * A 60-note flow whose English labels are longer than the zh side columns: the left
 * band must fit "Convention", the right one "Superseded"/"Provisional". The margins
 * add up on paper — 30 convention = 20+8+2, 20 decision = 8+10+2, 10 doc = 2+2+6;
 * the same rows read down give 30 active, 20 superseded, 10 provisional.
 */
const EN_FLOW_COUNTS = {
  notes: 60,
  links: 5,
  orphans: 2,
  byType: [
    { type: 'convention', n: 30 },
    { type: 'decision', n: 20 },
    { type: 'doc', n: 10 },
  ],
  byStatus: [
    { status: 'active', n: 30 },
    { status: 'superseded', n: 20 },
    { status: 'provisional', n: 10 },
  ],
  flow: [
    { type: 'convention', status: 'active', n: 20 },
    { type: 'convention', status: 'superseded', n: 8 },
    { type: 'convention', status: 'provisional', n: 2 },
    { type: 'decision', status: 'active', n: 8 },
    { type: 'decision', status: 'superseded', n: 10 },
    { type: 'decision', status: 'provisional', n: 2 },
    { type: 'doc', status: 'active', n: 2 },
    { type: 'doc', status: 'superseded', n: 2 },
    { type: 'doc', status: 'provisional', n: 6 },
  ],
}

test('an en locale widens the heat map weekday gutter for its day names', async (t) => {
  // "Mon"/"Wed"/"Fri" are wider than 一/三/五, so the en chart reserves a 32px weekday
  // column where the zh chart keeps 14px. The canvas width, the months row's offset
  // and the frame's grid template all carry that number; the zh assertions above keep
  // their own geometry untouched.
  stubFetch(t, () =>
    ok(
      overviewValue({
        activity: activityFixture(),
        recent: [
          {
            path: 'a.md',
            title: 'Decision note',
            type: 'decision',
            updated: '2026-10-27T12:00:00.000Z',
          },
          {
            path: 'b.md',
            title: 'Convention note',
            type: 'convention',
            updated: '2026-10-27T11:00:00.000Z',
          },
        ],
      }),
    ),
  )
  const render = mount(t, 'OverviewView', { locale: 'en' })
  render(chartProps())
  await setImmediate()
  const tree = render(chartProps())
  assert.deepEqual(
    byClass(tree, 'mem-heat-weekday').map((node) => node.props.children[0]),
    ['Mon', 'Wed', 'Fri'],
    'the en gutter labels the same three rows in English',
  )
  const cells = byClass(tree, 'mem-heat-cell')
  assert.equal(cells.length % 7, 0, 'whole Sunday-first columns')
  const gridWidth = (cells.length / 7) * 12 - 2 // HEAT_PITCH 10 + 2, minus the trailing gap
  const canvas = byClass(tree, 'mem-heat-canvas')
  assert.equal(canvas.length, 1)
  assert.equal(
    canvas[0].props.style.width,
    32 + gridWidth + 'px',
    'the 32px gutter is part of the canvas width',
  )
  const months = byClass(tree, 'mem-heat-months')
  assert.equal(months.length, 1)
  assert.equal(months[0].props.style.width, gridWidth + 'px')
  assert.equal(
    months[0].props.style.marginLeft,
    '32px',
    'the months row starts right of the gutter',
  )
  const frame = byClass(tree, 'mem-heat-frame')
  assert.equal(frame.length, 1)
  assert.equal(frame[0].props.style.gridTemplateColumns, '32px auto')
  assert.deepEqual(
    rendered(tree).filter((value) => HAN.test(value)),
    [],
    'the en calendar is free of Han characters',
  )
})

test('an en locale measures the Sankey columns and scrolls the whole chart', async (t) => {
  const tree = await renderOverviewWith(t, EN_FLOW_COUNTS, { locale: 'en' })
  assert.equal(byClass(tree, 'mem-sankey').length, 1, 'one Sankey surface')
  // The chart lives in its own horizontal scroller: a narrow panel must be able to PAN
  // a measured chart instead of clipping "Convention" into "Con…". The canvas carries
  // the measured width and the SVG its viewBox, so both agree on the coordinate space.
  const scroll = byClass(tree, 'mem-sankey-scroll')
  const canvas = byClass(tree, 'mem-sankey-canvas')
  const svg = byClass(tree, 'mem-sankey-svg')
  assert.equal(scroll.length, 1, 'the chart sits in its own scroller')
  assert.equal(canvas.length, 1, 'and on a measured canvas')
  assert.equal(svg.length, 1)
  const order = nodes(tree)
  assert.ok(
    order.indexOf(scroll[0]) < order.indexOf(canvas[0]),
    'the canvas is inside the scroller',
  )
  assert.ok(order.indexOf(canvas[0]) < order.indexOf(svg[0]), 'the svg is inside the canvas')
  // "Convention" advances 10 × 6.2 = 62.000…, which ceil()s to 63, + 2 = 65;
  // "Provisional" advances 11 × 6.2 = 68.2 → 69, + 2 = 71. The value columns keep
  // their zh floors (38/36), so leftNodeX is 65+38+4 = 107, the right block
  // 12+36+71 = 119, and the 292px floor becomes 107+128+119 = 354.
  assert.equal(canvas[0].props.style.width, '354px')
  assert.equal(svg[0].props.viewBox, '0 0 354 200')
  assert.equal(svg[0].props['aria-label'], 'Composition Sankey: 60 notes in total')
  const labels = byClass(tree, 'mem-sankey-label')
  assert.deepEqual(
    labels.map((node) => node.props.children[1]),
    ['Convention', 'Decision', 'Document', 'Active', 'Superseded', 'Provisional'],
    'every en label prints in full',
  )
  assert.deepEqual(
    labels.filter((node) => String(node.props.children[1]).endsWith('…')),
    [],
    'no en label is clipped',
  )
  // The measured columns move both bands, not just the label strings.
  assert.deepEqual(
    labels.map((node) => node.props.x),
    [65, 65, 65, 283, 283, 283],
  )
  // Only the chart's own section is chrome: the fixture's recent titles live elsewhere.
  const sectionNode = nodes(tree).find(
    (node) => node?.type === 'section' && node.props['aria-label'] === 'Composition',
  )
  assert.ok(sectionNode, 'the Composition section')
  assert.deepEqual(
    rendered(sectionNode).filter((value) => HAN.test(value)),
    [],
    'no Han-character chrome inside the en Sankey',
  )
})

test('the composed en health tab drops its own heading and translates the zone names', async (t) => {
  // The shell passes onMeta from the 健康 tab; that tab already names the page, so the
  // view must not print the title a second time. The hot file's zone names are real zh
  // server data here, which also pins the panel's translation of them.
  const hot = {
    ...healthValue().hot,
    sections: [
      { name: '强约束', chars: 600, entries: 1, pointers: 0, moveable: 1 },
      { name: '已完成', chars: 1200, entries: 1, pointers: 2, moveable: 3 },
      { name: '进行中', chars: 5400, entries: 6, pointers: 0, moveable: 2 },
    ],
  }
  stubFetch(t, () => ok(healthValue({ hot })))
  const render = mount(t, 'HealthView', { locale: 'en' })
  const props = { sessionId: 'session-a', visible: true, onMeta: () => {} }
  render(props)
  await setImmediate()
  const tree = render(props)
  assert.equal(byClass(tree, 'mem-viewhead').length, 0, 'the tab already names the page')
  const strings = rendered(tree)
  for (const copy of ['Strong constraints', 'In progress', 'Completed'])
    assert.ok(strings.includes(copy), 'the en zone heading reads ' + copy)
  assert.equal(strings.includes('Health'), false, 'the page title is not repeated')
  assert.deepEqual(
    strings.filter((value) => HAN.test(value)),
    [],
    'the real zh zone names are translated rather than leaked',
  )
})

test('the composed zh health tab drops the repeated heading and keeps zone names literal', async (t) => {
  // Same rule in the default locale: the 健康 tab names the page, so the composed view
  // prints no 健康 heading. The zone names are still the server's own words.
  stubFetch(t, () => ok(healthValue()))
  const render = mount(t, 'HealthView')
  const props = { sessionId: 'session-a', visible: true, onMeta: () => {} }
  render(props)
  await setImmediate()
  const tree = render(props)
  assert.equal(byClass(tree, 'mem-viewhead').length, 0, 'the composed zh page drops the heading')
  assert.equal(
    texts(tree).filter((value) => value === '健康').length,
    0,
    'and no 健康 title is printed below the search box',
  )
  assert.equal(
    texts(tree).filter((value) => value === '已完成').length,
    1,
    'the zh zone name stays exactly as the server wrote it',
  )
})
