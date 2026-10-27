import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { setImmediate } from 'node:timers/promises'
import { test } from 'node:test'

import { createMemoryViews } from '../lib/memory-panel.js'

const CLIENT = new URL('../lib/client.js', import.meta.url)
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
  return (props) => {
    cursor = 0
    const tree = View(props)
    const runs = pending
    pending = []
    runs.forEach((run) => run())
    return tree
  }
}

function nodes(tree) {
  if (!tree || typeof tree !== 'object') return [tree]
  return [tree, ...flat(tree.props?.children ?? []).flatMap(nodes)]
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

// ---------------------------------------------------------------------------
// Static shell and stylesheet contract
// ---------------------------------------------------------------------------

const cssOf = (script) => {
  const start = script.indexOf('/* panel-css:start */')
  const end = script.indexOf('/* panel-css:end */')
  assert.ok(start >= 0 && end > start, 'the panel stylesheet is marked for scanning')
  return script.slice(start, end)
}

test('the shell masthead names the project, stamps the binding and keeps the last-read clock', async () => {
  const script = await readFile(CLIENT, 'utf8')
  for (const marker of [
    "'mem-masthead'",
    'mem-masthead-name',
    'mem-display',
    "'mem-clock'",
    "'mem-refresh'",
    "'已绑定'",
    "'未绑定'",
    "'数据截至 '",
    "'正在读取…'",
    "'刷新'",
  ])
    assert.ok(script.includes(marker), 'the masthead contains ' + marker)
  assert.ok(script.includes('onMeta'), 'the views report the masthead state up to the shell')
  assert.ok(script.includes('React.useState(null)'), 'the shell keeps the reported state')
})

test('the tab strip carries ordinals 01-04 in the reviewed order', async () => {
  const script = await readFile(CLIENT, 'utf8')
  for (const [id, label, ordinal] of [
    ['overview', '概览', '01'],
    ['graph', '图谱', '02'],
    ['search', '检索', '03'],
    ['health', '健康', '04'],
  ]) {
    const pattern = new RegExp(
      "\\{ id: '" + id + "', label: '" + label + "', ordinal: '" + ordinal + "' \\}",
      'u',
    )
    assert.ok(pattern.test(script), 'the strip lists ' + ordinal + ' ' + label)
  }
  assert.ok(script.includes('mem-tab-index'), 'the ordinal is a real text node, not a CSS counter')
})

test('the panel stylesheet is a token-only ledger with a serif display face and tight radii', async () => {
  const script = await readFile(CLIENT, 'utf8')
  const css = cssOf(script)
  for (const face of ['Iowan Old Style', 'Palatino', 'Songti SC'])
    assert.ok(css.includes(face), 'the display stack names ' + face)
  assert.match(css, /serif/u, 'the display stack falls back to serif')
  assert.ok(css.includes('font-variant-numeric:tabular-nums'), 'figures are tabular')
  assert.ok(css.includes('mem-masthead-name'), 'the masthead name is styled here')
  for (const rule of ['min-height:40px', 'min-height:44px'])
    assert.ok(css.includes(rule), 'hit areas use ' + rule)
  const radii = [...css.matchAll(/border-radius:\s*([^;}]+)/gu)].map((match) => match[1].trim())
  assert.ok(radii.length > 0, 'the sheet declares radii')
  for (const radius of radii) {
    for (const value of radius.match(/[0-9.]+/gu) ?? [])
      assert.ok(Number(value) <= 4, 'radius stays 0-4px, found ' + radius)
  }
  assert.equal(/box-shadow/iu.test(css), false, 'no floating card shadow')
  assert.equal(/linear-gradient|radial-gradient/iu.test(css), false, 'no gradient furniture')
})

test('one 160ms staggered entrance is the only view motion and reduced motion removes it', async () => {
  const script = await readFile(CLIENT, 'utf8')
  const css = cssOf(script)
  assert.match(css, /@keyframes mem-enter/u, 'the one entrance is named')
  assert.match(css, /animation:mem-enter 160ms/u, 'the entrance runs 160ms')
  const delays = [...css.matchAll(/animation-delay:([0-9]+)ms/gu)].map((match) => Number(match[1]))
  assert.deepEqual(delays, [20, 40, 60, 80], 'children stagger by 20ms')
  const reduced = css.slice(css.indexOf('prefers-reduced-motion'))
  assert.match(reduced, /animation:none/u, 'reduced motion removes the entrance')
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

test('the overview reports project, clock and refresh to the shell and numbers its entries', async (t) => {
  stubFetch(t, () => ok(overviewValue()))
  const render = mount(t, 'OverviewView')
  const reported = []
  const props = { sessionId: 'session-a', visible: true, onMeta: (meta) => reported.push(meta) }
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
  assert.equal(byClass(tree, 'mem-recent-index').length, 2)
  assert.deepEqual(
    byClass(tree, 'mem-recent-index').map((node) => node.props.children[0]),
    ['01', '02'],
  )
  assert.equal(byClass(tree, 'mem-bar-fill').length, 3, 'the composition is drawn as index bars')
})

test('search keeps a border-bottom field, underlined filter groups and numbered result rows', async (t) => {
  stubFetch(t, (body) =>
    ok({
      query: body.query,
      hits: [
        {
          path: 'Projects/repo/Decisions/a.md',
          title: '决策一',
          type: 'decision',
          status: 'active',
          source: 'title',
          snippet: '一段摘要',
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
  let tree = render({ sessionId: 'session-a' })
  find(tree, (node) => node?.type === 'input').props.onChange({ target: { value: 'binding' } })
  tree = render({ sessionId: 'session-a' })
  find(tree, (node) => node?.type === 'form').props.onSubmit({ preventDefault() {} })
  await setImmediate()
  tree = render({ sessionId: 'session-a' })
  assert.equal(byClass(tree, 'mem-result').length, 2)
  assert.deepEqual(
    byClass(tree, 'mem-result-index').map((node) => node.props.children[0]),
    ['01', '02'],
  )
  assert.ok(byClass(tree, 'mem-stamp').some((node) => node.props.children[0] === '决策'))
  assert.ok(byClass(tree, 'mem-filter').length >= 3, 'each filter group is an underlined row')
  assert.ok(byClass(tree, 'mem-filter-option').length >= 8)
  assert.ok(texts(tree).some((text) => String(text).includes('来源 标题')))
  assert.ok(byClass(tree, 'mem-snippet').length === 2)
})

test('health renders status stamps, a thin hot meter and the digest column', async (t) => {
  stubFetch(t, () => ok(healthValue()))
  const render = mount(t, 'HealthView')
  render({ sessionId: 'session-a', visible: true })
  await setImmediate()
  const next = render({ sessionId: 'session-a', visible: true })
  assert.ok(byClass(next, 'mem-stamp').some((node) => node.props.children[0] === '就绪'))
  assert.ok(byClass(next, 'mem-meter-track').length === 1)
  assert.ok(byClass(next, 'mem-digest').length === 1)
  assert.ok(byClass(next, 'mem-event').length === 2)
  assert.ok(texts(next).some((text) => String(text).includes('今日摘要')))
  assert.ok(byClass(next, 'mem-row-title').some((node) => node.props.children[0] === '已完成'))
})

// ---------------------------------------------------------------------------
// The confirm sheet over the real view
// ---------------------------------------------------------------------------

/** Render health until its first read lands. */
async function health(t) {
  const render = mount(t, 'HealthView')
  const props = { sessionId: 'session-a', visible: true }
  render(props)
  await setImmediate()
  return { render, props, tree: render(props) }
}

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
