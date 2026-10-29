import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { setImmediate } from 'node:timers/promises'
import { test } from 'node:test'

import { createMemoryViews } from '../lib/memory-panel.js'

const MODULE = new URL('../lib/memory-panel.js', import.meta.url)

// The suite has no React dependency: the views are real, the hook runtime is a
// four-hook stand-in that preserves state across renders and runs effect
// cleanup the way the host's mount does. Fetch is the browser boundary.
function mount(t, name) {
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
  const View = createMemoryViews({ React })[name]
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
      ref.current = {
        focus: () =>
          focused.push(node.type + (node.props.className ? ':' + node.props.className : '')),
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

/** Record each fetch body and answer from one handler. */
function stubFetch(t, handler) {
  const sent = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const body = JSON.parse(options.body)
    sent.push({ url, body })
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
  assert.equal(byClass(tree, 'mem-stamps').length, 1, 'status chips ride the composition surface')

  // Recent: ordinals retired, the type appears once, the meta is type · time.
  assert.equal(byClass(tree, 'mem-recent-row').length, 2)
  assert.equal(byClass(tree, 'mem-recent-index').length, 0, 'the numbered index is retired')
  assert.equal(byClass(tree, 'mem-dot').length, 2, 'each recent row carries a type dot')
  const recentMeta = byClass(tree, 'mem-recent-meta').map((node) => node.props.children[0])
  assert.ok(
    recentMeta.every((text) => /^(决策|约定) · /u.test(text)),
    'meta is type · time',
  )
  assert.equal(
    byClass(tree, 'mem-recent-row').reduce((sum, row) => sum + byClass(row, 'mem-stamp').length, 0),
    0,
    'the type is no longer printed twice',
  )

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

test('health bands its summary, meter, digest and 诊断记录 timeline', async (t) => {
  stubFetch(t, () => ok(healthValue()))
  const render = mount(t, 'HealthView')
  render({ sessionId: 'session-a', visible: true })
  await setImmediate()
  const next = render({ sessionId: 'session-a', visible: true })
  const summary = find(next, (node) => node?.props?.['aria-label'] === '健康摘要')
  assert.ok(summary, 'the summary band comes first')
  assert.equal(byClass(next, 'mem-summary-item').length, 4, 'a 2x2 band of 索引/队列/热层/摘要')
  assert.deepEqual(
    byClass(next, 'mem-label')
      .map((node) => node.props.children[0])
      .slice(0, 4),
    ['索引', '队列', '热层', '摘要'],
  )
  assert.ok(byClass(next, 'mem-stamp').some((node) => node.props.children[0] === '就绪'))
  assert.ok(byClass(next, 'mem-meter-track').length === 1)
  assert.ok(byClass(next, 'mem-digest').length === 1)
  assert.ok(texts(next).some((text) => String(text).includes('今日摘要')))
  assert.ok(byClass(next, 'mem-row-title').some((node) => node.props.children[0] === '已完成'))
  assert.ok(
    texts(next).some((text) => String(text).includes('诊断记录')),
    'the section is retitled',
  )
  assert.equal(
    texts(next).some((text) => String(text).includes('最近的决策')),
    false,
    'the old mislabel is gone',
  )
  assert.equal(byClass(next, 'mem-event').length, 2)
  assert.equal(byClass(next, 'mem-event-dot').length, 2, 'each event is a timeline dot')
  assert.ok(
    byClass(next, 'mem-event').every((event) => byClass(event, 'mem-event-dot').length === 1),
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

test('the unbound scope switch reports its notice once, then the fallback results', async (t) => {
  const fallback = deferred()
  let requests = 0
  const sent = stubFetch(t, () => {
    requests += 1
    return requests === 1 ? failure(422, 'unbound', 'project unbound') : fallback.promise
  })
  const asked = []
  const render = mount(t, 'SearchView')
  render(searchProps({ onFilter: (field, value) => asked.push([field, value]) }))
  await setImmediate()
  let tree = render(searchProps({ onFilter: (field, value) => asked.push([field, value]) }))
  assert.equal(requests, 2, 'the unbound fallback runs one more request')
  assert.equal(sent[1].body.scope, 'all', 'the fallback asks the all-project scope')
  assert.deepEqual(asked, [['scope', 'all']], 'the view tells the shell the scope moved')
  assert.equal(
    countText(tree, '当前项目未绑定；正在搜索全部项目。'),
    1,
    'the notice is no longer dead copy and renders once',
  )
  assert.equal(countText(tree, '输入关键词开始检索'), 0)
  fallback.resolve(ok({ hits: [hit('a.md', '决策一')], limit: 25, hasMore: false, tookMs: 2 }))
  await setImmediate()
  tree = render(searchProps({ scope: 'all', onFilter: () => {} }))
  assert.equal(byClass(tree, 'mem-result').length, 1)
  assert.equal(
    countText(tree, '当前项目未绑定；正在搜索全部项目。'),
    0,
    'the run-scoped notice is replaced by the results status',
  )
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
  })
  assert.equal(
    find(tree, (node) => node?.props?.role === 'alertdialog'),
    undefined,
    'the sheet closes',
  )
  assert.ok(
    byClass(tree, 'mem-action-status').some((node) =>
      texts(node).some((text) => String(text).includes('已重新排队')),
    ),
    'the outcome is named in words',
  )
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
  const status = byClass(tree, 'mem-action-status')
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
  assert.ok(
    byClass(tree, 'mem-action-status').some((node) =>
      texts(node).some((text) => String(text).includes('搬出 3')),
    ),
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
