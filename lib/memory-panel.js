// The 记忆 panel's 概览 / 检索 / 健康 views, served as one browser ES module by
// lib/panel-route.js. The shell dynamic-imports it and passes React; this file
// imports nothing. Read-only by default: three read actions over one POST, and
// three confirmed mutations whose preview/confirm tokens are feature-detected
// from the read's capabilities — without them the panel stays fully usable.
/* global document */
const PANEL_URL = 'obsidian-mem/panel'
const REFRESH_MS = 30000
const TYPE_LABELS = Object.freeze({
  decision: '决策',
  convention: '约定',
  gotcha: '踩坑',
  doc: '文档',
  glossary: '术语表',
  log: '日志',
  untyped: '未分类',
})
const STATUS_LABELS = Object.freeze({
  active: '生效',
  accepted: '已采纳',
  provisional: '待确认',
  contested: '有争议',
  superseded: '已取代',
  archived: '已归档',
  untyped: '未标注',
})
const INDEX_LABELS = Object.freeze({
  ready: '就绪',
  degraded: '降级',
  starting: '启动中',
  closed: '已关闭',
})
const SEVERITY_LABELS = Object.freeze({ info: '提示', warn: '注意', error: '错误' })
const REASON_COPY = Object.freeze({
  'no-pointer':
    '当前项目尚未绑定记忆。运行一次写入，或 mem_admin(action="bind", mode="local")，即可启用。',
  'no-git-root': '当前目录不在 Git 仓库内，记忆默认只读；在仓库根绑定后即可写入。',
  'cwd-missing': '会话记录的工作目录已不存在。换一个目录或重新打开会话。',
  'pointer-corrupt':
    '绑定指针无法读取（pointer-corrupt）。插件不会自动修复指针，请手工检查 .obsidian-mem。',
  'pointer-unsupported-schema':
    '绑定指针的版本不受支持（pointer-unsupported-schema）。请手工检查 .obsidian-mem。',
  'pointer-unreadable': '绑定指针无法读取（pointer-unreadable）。请手工检查 .obsidian-mem。',
  'pointer-not-a-file': '绑定指针不是文件（pointer-not-a-file）。请手工检查 .obsidian-mem。',
  'pointer-oversize': '绑定指针过大（pointer-oversize）。请手工检查 .obsidian-mem。',
})
const COPY = Object.freeze({
  loading: '正在读取记忆…',
  refreshing: '正在刷新…',
  // The masthead owns the last-read clock, so the views deliberately have no
  // "数据截至" copy of their own; the stale/error notices below still need time.
  stale: (time) => '数据可能已过期，上次更新 ' + time,
  error: (message) => '读取记忆失败：' + message,
  route: '记忆接口未就绪（路由未注册）；重启 dsh 后重试',
  retry: '重试',
  refresh: '刷新',
  emptyOverview: '这个项目还没有记忆。第一次 mem_write 会自动建立绑定并写入第一条。',
  searchIdle: '输入关键词开始检索，结果来自本地记忆索引。',
  searchIndex: '本地记忆索引',
  searchEmpty: '没有匹配的记忆。',
  searchLimit: '已达上限 50',
  searchLoading: '正在检索…',
  searchUnbound: '当前项目未绑定；正在搜索全部项目。',
  recent: '最近变化',
  composition: '构成',
  // The five 概览 charts (design §3.4). Each title names what the chart answers, so
  // the section head is a question the reader already knows the answer to.
  activity: '活动热度',
  flow: '新建与更新',
  flowEmpty: '近 12 周没有新建或更新记录。',
  frequency: '标签频率',
  health: '健康',
  index: '索引',
  queue: '待处理作业',
  hot: '热层',
  diagnostics: '诊断记录',
  digest: '今日摘要',
  queueEmpty: '队列为空。',
  unboundTitle: '当前项目未绑定记忆',
  unboundSearch: '去检索（搜索全部记忆）',
  overviewTitle: '概览',
  searchTitle: '检索',
  healthTitle: '健康',
  coldRead: '只读',
})
// The three reviewed mutations, in the panel's own words. They only ever reach
// the route as preview/confirm pairs — the action vocabulary stays two verbs.
const MUTATION_COPY = Object.freeze({
  'retry-job': { label: '重新排队', title: '重新排队失败任务' },
  'compact-hot': { label: '整理热层', title: '整理热层' },
  'refresh-digest': { label: '发布项目摘要', title: '发布项目摘要' },
})
const MUTATION_FAILURES = Object.freeze({
  'preview-stale': '预览已过期，已刷新；请重新操作。',
  'preview-expired': '预览已过期；请重新操作。',
  'preview-unknown': '预览已失效；请重新操作。',
  'preview-mismatch': '预览不属于当前会话或项目，已丢弃；请重新操作。',
  'preview-in-progress': '上一次确认仍在执行，请稍后再试。',
  'job-missing': '作业已不存在，已刷新队列。',
  'job-foreign': '该作业不属于当前项目，已刷新队列。',
  'job-not-retryable': '作业状态已变化，已刷新队列。',
  'hot-missing': '热层文件尚未创建，已刷新。',
  'digest-unavailable': '摘要接口不可用，已刷新。',
})
const PUBLIC_CODES = Object.freeze(['route', 'unavailable', 'bad-request', 'response-too-large'])
const CONFIRM_FALLBACK = '确认执行'
const CONFIRM_BUSY = '正在执行…'
const CANCEL = '取消'
const PREVIEW_TTL_HINT = '预览 60 秒内有效'
function formatTime(value) {
  if (value === null || value === undefined || value === '') return '未知'
  const stamp = typeof value === 'number' ? value : Date.parse(value)
  if (!Number.isFinite(stamp)) return '未知'
  const delta = Date.now() - stamp
  if (delta < 60_000) return '刚刚'
  if (delta < 3_600_000) return Math.floor(delta / 60_000) + ' 分钟前'
  if (delta < 86_400_000) return Math.floor(delta / 3_600_000) + ' 小时前'
  if (delta < 7 * 86_400_000) return Math.floor(delta / 86_400_000) + ' 天前'
  const date = new Date(stamp)
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
}
function formatClock(value) {
  const stamp = Number(value)
  if (!Number.isFinite(stamp) || stamp <= 0) return '—'
  const date = new Date(stamp)
  return pad(date.getHours()) + ':' + pad(date.getMinutes())
}
function formatCount(value) {
  const n = Number(value)
  const whole = Number.isFinite(n) ? Math.trunc(n) : 0
  return String(whole).replace(/\B(?=(\d{3})+(?!\d))/gu, ',')
}
const pad = (value) => String(value).padStart(2, '0')
const typeLabel = (type) => TYPE_LABELS[type] ?? (type || '未分类')
const statusLabel = (status) => STATUS_LABELS[status] ?? (status || '未标注')
const sourceLabel = (source) =>
  ({ title: '标题', body: '正文', path: '路径' })[source] ?? (source || '索引')
const reasonCopy = (reason) =>
  REASON_COPY[reason] ??
  (reason
    ? '当前项目未绑定记忆（' + reason + '）。在仓库根运行一次写入即可启用。'
    : '当前项目尚未绑定记忆。运行一次写入即可启用。')
const indexLabel = (state) => INDEX_LABELS[state] ?? (state || '未知')
function withUnit(value, unit) {
  const n = Number(value)
  return (Number.isFinite(n) ? formatCount(n) : '0') + ' ' + unit
}
const TYPE_KEYS = ['decision', 'convention', 'gotcha', 'doc', 'glossary']
const STATUS_KEYS = ['active', 'provisional', 'contested']
const SCOPE_LABELS = { project: '当前项目', all: '全部' }
const FILTER_GROUPS = [
  ['类型', 'type', [null, ...TYPE_KEYS]],
  ['状态', 'status', [null, ...STATUS_KEYS]],
  ['范围', 'scope', ['project', 'all']],
]
const mutationsOf = (value) => {
  const capabilities = value?.capabilities
  const mutations = Array.isArray(capabilities?.mutations) ? capabilities.mutations : []
  return mutations.filter((name) => typeof name === 'string')
}
const previewFactsOf = (preview) => (Array.isArray(preview?.facts) ? preview.facts : [])
const previewEffectsOf = (preview) => (Array.isArray(preview?.effects) ? preview.effects : [])
const outcomeOf = (mutation, value) => {
  const result = value?.result ?? {}
  const replay = value?.replayed === true ? '（此前已执行，本次未重复写入）' : ''
  if (mutation === 'retry-job')
    return '已重新排队：状态 ' + String(result.state ?? 'pending') + replay
  if (mutation === 'compact-hot')
    return (
      '已压缩热层：搬出 ' +
      formatCount(result.moved) +
      '，折叠 ' +
      formatCount(result.folded) +
      '，回收 ' +
      formatCount(result.reclaimed) +
      ' 字符' +
      replay
    )
  const status = String(result.status ?? 'done')
  const text =
    status === 'unchanged' ? '摘要无变化' : status === 'updated' ? '摘要已更新' : '摘要已生成'
  return text + '：' + String(result.path ?? '完成') + replay
}
/**
 * The three read views, constructed against the host's React instance.
 *
 * @param {{React: object}} options - React is the only peer; the host resolves it.
 * @returns {{OverviewView: Function, SearchView: Function, HealthView: Function}} the views.
 */
export function createMemoryViews({ React } = {}) {
  if (React === undefined || React === null) throw new Error('createMemoryViews requires React')
  const h = React.createElement
  const span = (className, ...children) => h('span', { className }, ...children)
  const meta = (text) => span('mem-meta', text)
  const stamp = (text, kind) => span('mem-stamp' + (kind ? ' is-' + kind : ''), text)
  const button = (text, onClick, className = 'mem-btn', disabled = false) =>
    h('button', { type: 'button', className, onClick, disabled }, text)
  const viewhead = (title, right) =>
    h(
      'div',
      { className: 'mem-viewhead' },
      h('h2', { className: 'mem-viewhead-title mem-display' }, title),
      right ?? null,
    )
  // A section: one strong secondary heading on a hairline, then its entries. No
  // card, no fill, no radius — the rule and the spacing carry the grouping.
  const section = (title, right, ...body) =>
    h(
      'section',
      { className: 'mem-section', 'aria-label': title },
      h(
        'div',
        { className: 'mem-section-head' },
        h('h2', { className: 'mem-display' }, title),
        right ?? null,
      ),
      ...body,
    )
  const facts = (pairs) =>
    h(
      'dl',
      { className: 'mem-facts' },
      pairs.flatMap(([key, value], index) => [
        h('dt', { key: 'k' + index }, key),
        h('dd', { key: 'v' + index }, value),
      ]),
    )
  // A KPI/summary cell became a button so it can jump, so the control resets the
  // UA button chrome; colours, type and spacing still come from its class and the
  // host tokens (the stylesheet owns the look — this only removes the default).
  const controlReset = {
    background: 'none',
    border: 0,
    color: 'inherit',
    font: 'inherit',
    textAlign: 'left',
    cursor: 'pointer',
  }
  const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const termsOf = (query) =>
    String(query ?? '')
      .split(/\s+/u)
      .filter(Boolean)
  // A snippet keeps its two-line clamp; the query's terms (two characters or
  // more, case-insensitive, regex-escaped) are the only marked spans inside it.
  function highlight(text, query) {
    const source = String(text ?? '')
    const wanted = termsOf(query)
      .filter((term) => term.length >= 2)
      .sort((left, right) => right.length - left.length)
      .map(escapeRegExp)
    if (wanted.length === 0) return source
    const pattern = new RegExp('(' + wanted.join('|') + ')', 'giu')
    return source
      .split(pattern)
      .map((part, index) => (index % 2 === 1 ? h('mark', { key: 'mark' + index }, part) : part))
  }
  // A 404 is "route not registered", not a data error: name the cause and the next action.
  async function post(payload, signal) {
    const response = await fetch(PANEL_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    })
    if (response.status === 404) {
      const missing = new Error(COPY.route)
      missing.code = 'route'
      throw missing
    }
    let envelope
    try {
      envelope = await response.json()
    } catch {
      const broken = new Error('记忆接口返回了无法读取的内容')
      broken.code = 'unavailable'
      throw broken
    }
    if (!response.ok || envelope.ok !== true) {
      const failure = new Error(envelope.error?.message ?? '读取记忆失败')
      failure.code = envelope.error?.code ?? 'unavailable'
      throw failure
    }
    return envelope.value
  }
  // One poll, one AbortController, last-good data kept on failure, visible-gated.
  function usePanelPoll({
    sessionId,
    action,
    visible,
    intervalMs = REFRESH_MS,
    params,
    refreshKey,
  }) {
    const [snapshot, setSnapshot] = React.useState(null)
    const [failure, setFailure] = React.useState(null)
    const [loading, setLoading] = React.useState(true)
    const [updatedAt, setUpdatedAt] = React.useState(0)
    const [attempt, setAttempt] = React.useState(0)
    const key = JSON.stringify(params ?? null)
    const identity = JSON.stringify([sessionId, action, key])
    const value = snapshot?.identity === identity ? snapshot.value : null
    const error = failure?.identity === identity ? failure.error : null
    React.useEffect(() => {
      if (!visible || !sessionId) return undefined
      let disposed = false
      let running = false
      let fatal = false
      let timer = null
      let controller = null
      const run = async () => {
        if (running || fatal) return
        if (typeof document !== 'undefined' && document.hidden) return
        running = true
        controller = new AbortController()
        setLoading(true)
        try {
          const next = await post({ sessionId, action, ...(params ?? {}) }, controller.signal)
          if (disposed) return
          setSnapshot({ identity, value: next })
          setFailure(null)
          setUpdatedAt(Date.now())
        } catch (cause) {
          if (disposed || cause?.name === 'AbortError') return
          if (cause?.code === 'route') fatal = true
          setFailure({ identity, error: cause })
        } finally {
          running = false
          if (!disposed) setLoading(false)
        }
      }
      const wake = () => {
        if (typeof document !== 'undefined' && document.hidden) return
        void run()
      }
      void run()
      if (intervalMs > 0) {
        timer = setInterval(wake, intervalMs)
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', wake)
      }
      return () => {
        disposed = true
        if (timer !== null) clearInterval(timer)
        if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', wake)
        controller?.abort()
      }
      // `key` projects `params`; the object itself is recreated every render.
    }, [sessionId, action, visible, intervalMs, key, attempt, refreshKey])
    return {
      value,
      error,
      loading: value === null && error === null ? true : loading,
      updatedAt: value === null ? 0 : updatedAt,
      refresh: () => setAttempt((count) => count + 1),
    }
  }
  function StatusLine({ loading, error, stale, updatedAt, onRetry }) {
    if (error) {
      const className = stale ? 'mem-notice is-stale' : 'mem-notice is-error'
      const text = stale
        ? COPY.stale(formatClock(updatedAt))
        : COPY.error(error.message ?? '未知错误')
      return h(
        'div',
        { className, role: stale ? 'status' : 'alert', 'aria-live': stale ? 'polite' : undefined },
        h('span', null, text),
        button(COPY.retry, onRetry),
      )
    }
    // The skeleton is the one announcement of "no data yet"; this line speaks
    // only about refreshing data already on screen. Two owners could only ever
    // announce the same loading state twice (audit A3.1).
    if (!loading || updatedAt <= 0) return null
    return h('p', { className: 'mem-meta', role: 'status', 'aria-live': 'polite' }, COPY.refreshing)
  }
  // The button is a bare action: its label never repeats the status line's
  // loading/refresh copy, so one state string has one owner.
  const refreshButton = (poll) => button(COPY.refresh, poll.refresh, 'mem-btn', poll.loading)
  function Loading() {
    return h(
      'div',
      { className: 'mem-skeleton', role: 'status', 'aria-live': 'polite' },
      h('span', null, COPY.loading),
      h('span', null, ''),
      h('span', null, ''),
    )
  }
  function ProjectCard({ project }) {
    const bound = project?.state === 'bound'
    const id = project?.projectId ? String(project.projectId).slice(0, 8) : null
    const pairs = [['名称', project?.name ?? '未命名项目']]
    if (id) pairs.push(['projectId', id])
    if (project?.vault?.basename) pairs.push(['vault', project.vault.basename])
    return section('项目', stamp(bound ? '已绑定' : '未绑定', bound ? 'ok' : 'warn'), facts(pairs))
  }
  function UnboundSection({ project, onJump }) {
    return section(
      COPY.unboundTitle,
      stamp('未绑定', 'warn'),
      h('p', null, reasonCopy(project?.reason ?? null)),
      meta('绑定指针：仓库根的 .obsidian-mem（插件不会自动修复）'),
      onJump ? button(COPY.unboundSearch, () => onJump('search'), 'mem-btn') : null,
    )
  }
  /**
   * The five 概览 charts (design §3.4). Every one is inline SVG or plain divs: the
   * panel has no charting dependency and adding one to a browser module served
   * without a build step would outweigh what these five shapes need.
   *
   * Two rules hold across all of them. A chart carries no pronoun-free number the
   * reader has to estimate from an area: hue and area are the least precise visual
   * channels (research §S6), so the section meta states the digit and the mark only
   * shows the shape. And a chart with no series is not drawn at all — the route
   * feature-detects `activity`/`tags` and answers `null` when its index build cannot
   * produce them, so "absent" means "no chart", never "empty grid".
   */

  /** 12 weeks of daily buckets, oldest first, from the payload's two series. */
  function activityTotals(activity) {
    const days = Array.isArray(activity?.days) ? activity.days : []
    const created = Array.isArray(activity?.created) ? activity.created : []
    const updated = Array.isArray(activity?.updated) ? activity.updated : []
    return days.map((day, index) => ({
      day,
      created: Number(created[index] ?? 0),
      updated: Number(updated[index] ?? 0),
    }))
  }

  /** The bucket a count falls in, 0–4, scaled to the window's own maximum. */
  function heatLevel(value, maximum) {
    if (value <= 0 || maximum <= 0) return 0
    const ratio = value / maximum
    if (ratio > 0.75) return 4
    if (ratio > 0.5) return 3
    if (ratio > 0.25) return 2
    return 1
  }

  /**
   * 活动热度图: 12 columns × 7 rows of 6px squares.
   *
   * The grid is ONE `role="img"` with an `aria-label` and no focusable cell. A 6px
   * square is far below the 24px minimum focus target, so a tabbable grid would be a
   * keyboard path that cannot be used; the numbers are read from the section meta
   * instead and each cell keeps a `<title>` for the pointer.
   */
  function heatmap(activity) {
    const buckets = activityTotals(activity)
    if (buckets.length === 0) return null
    const values = buckets.map((bucket) => bucket.created + bucket.updated)
    // Sunday-first rows, as the design fixes the week. 84 days is twelve weeks only
    // when the window happens to start on a Sunday; otherwise the calendar spans a
    // thirteenth, partial column. The grid is defined as twelve COMPLETE weeks, so
    // any partial column at the head is dropped, and the maximum/total/head are
    // computed from the cells actually drawn — the printed number always equals
    // the picture, which is the whole point of printing it.
    const first = new Date(buckets[0].day + 'T00:00:00')
    const lead = Number.isNaN(first.getTime()) ? 0 : first.getDay()
    const cells = []
    for (let index = 0; index < lead; index += 1) cells.push(null)
    for (const value of values) cells.push(value)
    while (cells.length % 7 !== 0) cells.push(null)
    const allColumns = []
    for (let start = 0; start < cells.length; start += 7)
      allColumns.push(cells.slice(start, start + 7))
    const columns = allColumns.slice(-12)
    const drawn = columns.flat().filter((value) => value !== null)
    const maximum = Math.max(...drawn, 0)
    const total = drawn.reduce((sum, value) => sum + value, 0)
    // "本周" is the last seven cells, which is the trailing week of the window.
    const thisWeek = drawn.slice(-7).filter((value) => value > 0).length
    const label = '近 ' + columns.length + ' 周活动，共 ' + total + ' 条，峰值 ' + maximum
    return section(
      COPY.activity,
      meta('近 ' + columns.length + ' 周 · 本周 ' + thisWeek + ' 天有更新 · 合计 ' + total + ' 条'),
      h(
        'div',
        { className: 'mem-heat' },
        h(
          'div',
          { className: 'mem-heat-grid', role: 'img', 'aria-label': label },
          // One flat run of cells in column-major order: the grid CSS
          // (`grid-auto-flow:column`, 7 rows) turns it into twelve Sunday-first
          // columns without a wrapper per column, so a cell can never drift out of
          // its week. No `tabIndex`: see the rule at the top of this block.
          columns.flatMap((column, columnIndex) =>
            column.map((value, rowIndex) =>
              value === null
                ? h('span', {
                    className: 'mem-heat-cell is-void',
                    key: 'c' + columnIndex + 'r' + rowIndex,
                  })
                : h(
                    'span',
                    {
                      className: 'mem-heat-cell is-l' + heatLevel(value, maximum),
                      key: 'c' + columnIndex + 'r' + rowIndex,
                    },
                    h('title', null, value + ' 条'),
                  ),
            ),
          ),
        ),
        h(
          'div',
          { className: 'mem-heat-legend', 'aria-hidden': true },
          span('mem-heat-legend-label', '少'),
          ['is-l0', 'is-l1', 'is-l2', 'is-l3', 'is-l4'].map((level) =>
            h('span', { className: 'mem-heat-swatch ' + level, key: level }),
          ),
          span('mem-heat-legend-label', '多'),
        ),
      ),
    )
  }

  /**
   * 分流柱: twelve weekly bars above and below one shared zero line.
   *
   * The two series are the only two real event streams the vault records — a note
   * appeared, or a note was edited — and they are mutually exclusive per note per
   * day (design §3.3). `superseded` is deliberately absent: it is a status snapshot,
   * and drawing it as a flow would invent the day a note reached it.
   */
  function flowBars(activity) {
    const buckets = activityTotals(activity)
    if (buckets.length === 0) return null
    // Group into whole weeks from the end, so the last bar is the current week.
    const weeks = []
    for (let end = buckets.length; end > 0; end -= 7) {
      const chunk = buckets.slice(Math.max(0, end - 7), end)
      weeks.unshift({
        created: chunk.reduce((sum, bucket) => sum + bucket.created, 0),
        updated: chunk.reduce((sum, bucket) => sum + bucket.updated, 0),
      })
    }
    const createdTotal = weeks.reduce((sum, week) => sum + week.created, 0)
    const updatedTotal = weeks.reduce((sum, week) => sum + week.updated, 0)
    if (createdTotal === 0 && updatedTotal === 0) {
      return section(COPY.flow, null, h('p', { className: 'mem-chart-empty' }, COPY.flowEmpty))
    }
    const scale = Math.max(...weeks.map((week) => Math.max(week.created, week.updated)), 1)
    // A zero line through the middle: created grows up, updated grows down, so the
    // bar's own side says which stream it is before the colour does.
    const MID = 40
    const HALF = 36
    const BAR = 8
    const GAP = 4
    const width = weeks.length * (BAR + GAP) - GAP
    return section(
      COPY.flow,
      meta('近 ' + weeks.length + ' 周净增 ' + (createdTotal - updatedTotal)),
      h(
        'div',
        { className: 'mem-flow' },
        h(
          'svg',
          {
            className: 'mem-flow-svg',
            viewBox: '0 0 ' + width + ' ' + MID * 2,
            preserveAspectRatio: 'none',
            role: 'img',
            'aria-label':
              '近 ' +
              weeks.length +
              ' 周新建 ' +
              createdTotal +
              ' 条，更新 ' +
              updatedTotal +
              ' 条',
          },
          weeks.map((week, index) => {
            const x = index * (BAR + GAP)
            const up = Math.round((week.created / scale) * HALF)
            const down = Math.round((week.updated / scale) * HALF)
            return h(
              'g',
              { key: 'w' + index },
              h(
                'title',
                null,
                '第 ' + (index + 1) + ' 周 · 新建 ' + week.created + ' · 更新 ' + week.updated,
              ),
              up === 0
                ? null
                : h('rect', {
                    className: 'mem-flow-created',
                    x,
                    y: MID - up,
                    width: BAR,
                    height: up,
                    rx: 2,
                  }),
              down === 0
                ? null
                : h('rect', {
                    className: 'mem-flow-updated',
                    x,
                    y: MID,
                    width: BAR,
                    height: down,
                    rx: 2,
                  }),
            )
          }),
          h('line', { className: 'mem-flow-zero', x1: 0, y1: MID, x2: width, y2: MID }),
        ),
        h(
          'div',
          { className: 'mem-flow-legend', 'aria-hidden': true },
          h('span', { className: 'mem-flow-swatch is-created' }),
          span('mem-flow-legend-label', '新建'),
          h('span', { className: 'mem-flow-swatch is-updated' }),
          span('mem-flow-legend-label', '更新'),
        ),
      ),
    )
  }

  /**
   * 频率排行: at most eight tag rows, each a name, an inline bar and a count.
   *
   * The bar is proportional to the ranking's own maximum, so the shape says "these
   * are the big ones" and the printed count says how big. `total` is every tag
   * occurrence in scope, so the remainder line is a real number rather than the
   * count of rows this page happens to show.
   */
  function frequencyRows(tags) {
    const rows = Array.isArray(tags?.items) ? tags.items : []
    const total = Number(tags?.total ?? 0)
    if (rows.length === 0 || total === 0) return null
    const visible = rows.slice(0, 8)
    const maximum = Math.max(...visible.map((row) => Number(row?.n ?? 0)), 1)
    const shownTotal = visible.reduce((sum, row) => sum + Number(row?.n ?? 0), 0)
    const remaining = total - shownTotal
    return section(
      COPY.frequency,
      meta(withUnit(total, '次')),
      h(
        'div',
        { className: 'mem-freq' },
        visible.map((row, index) => {
          const n = Number(row?.n ?? 0)
          return h(
            'div',
            { className: 'mem-freq-row', key: String(row?.tag ?? index) },
            span('mem-freq-name', String(row?.tag ?? '')),
            h(
              'span',
              { className: 'mem-freq-track', 'aria-hidden': true },
              h('span', {
                className: 'mem-freq-fill',
                style: { width: Math.round((n / maximum) * 100) + '%' },
              }),
            ),
            span('mem-freq-value', formatCount(n)),
          )
        }),
        remaining > 0 ? meta('另有 ' + remaining + ' 个标签') : null,
      ),
    )
  }

  /** The 记忆条目 cell's 12-point growth sparkline, cumulative from `created`. */
  function sparkline(activity) {
    const buckets = activityTotals(activity)
    if (buckets.length < 2) return null
    // Cumulative, never `created − updated`: the two are different events and their
    // difference has no meaning, while a running total is monotonic by construction
    // and cannot read as a drop just because a week had no edits (design §3.4).
    const series = []
    let running = 0
    for (const bucket of buckets) {
      running += bucket.created
      series.push(running)
    }
    const last = series[series.length - 1]
    if (last === 0) return null
    const W = 60
    const H = 16
    const points = series
      .map((value, index) => {
        const x = (index / (series.length - 1)) * W
        const y = H - (value / last) * H
        return x.toFixed(1) + ',' + y.toFixed(1)
      })
      .join(' ')
    return h(
      'svg',
      {
        className: 'mem-kpi-spark',
        viewBox: '0 0 ' + W + ' ' + H,
        preserveAspectRatio: 'none',
        'aria-hidden': true,
        key: 'spark',
      },
      h('polyline', { points, fill: 'none', stroke: 'currentColor', strokeWidth: 1.4 }),
    )
  }

  function kpiBand(counts, queue, onJump, activity) {
    const pending = Number(queue?.queued ?? 0) + Number(queue?.failed ?? 0)
    const spark = sparkline(activity)
    const items = [
      ['记忆条目', counts?.notes, '条', 'search', spark],
      ['关系', counts?.links, '条', 'search', null],
      ['孤立', counts?.orphans, '条', 'search', null],
      ['待处理', pending, '个', 'health', null],
    ]
    return h(
      'div',
      { className: 'mem-kpiline', 'aria-label': '关键数字' },
      items.map(([name, value, unit, target, extra]) =>
        h(
          'button',
          {
            type: 'button',
            className: 'mem-kpi',
            key: name,
            style: controlReset,
            title: target === 'health' ? '查看健康' : '查看检索',
            onClick: () => onJump?.(target),
          },
          span('mem-kpi-label', name),
          h(
            'div',
            { className: 'mem-kpi-line' },
            span('mem-kpi-value', formatCount(value)),
            span('mem-kpi-unit', unit),
          ),
          // The sparkline sits UNDER the number, not inside its line: at 320px that
          // line already holds a 26px value plus its unit, so an inline glyph there
          // either overlaps the digits or is squeezed into a single stroke. As its
          // own row it gets the cell's full width and cannot collide.
          extra ?? null,
        ),
      ),
    )
  }
  // One stacked composition bar and one legend: the parts share a single track,
  // the legend carries the numbers the bar cannot say at 320px. The status
  // distribution rides along as a quiet chip row instead of a second block.
  function composition(counts) {
    const rows = Array.isArray(counts?.byType) ? counts.byType : []
    const total = rows.reduce((sum, entry) => sum + Number(entry?.n ?? 0), 0)
    if (rows.length === 0) return null
    const parts = rows.map((entry) => {
      const n = Number(entry?.n ?? 0)
      return {
        label: typeLabel(entry?.type),
        n,
        pct: total === 0 ? 0 : Math.round((n / total) * 1000) / 10,
      }
    })
    const statuses = Array.isArray(counts?.byStatus) ? counts.byStatus : []
    return section(
      COPY.composition,
      meta(withUnit(total, '条')),
      h(
        'div',
        { className: 'mem-comp' },
        h(
          'div',
          {
            className: 'mem-bar-track',
            role: 'img',
            'aria-label': '构成：共 ' + withUnit(total, '条'),
          },
          parts.map((part, index) =>
            h('span', {
              key: 'bar' + index,
              className: 'mem-bar-fill is-seg' + (index % 6),
              style: { width: part.pct + '%' },
            }),
          ),
        ),
        h(
          'div',
          { className: 'mem-comp-legend' },
          parts.map((part, index) =>
            h(
              'div',
              { className: 'mem-comp-row', key: 'row' + index },
              h('span', {
                className: 'mem-comp-dot is-seg' + (index % 6),
                'aria-hidden': true,
              }),
              span('mem-comp-name', part.label),
              span('mem-comp-value', formatCount(part.n)),
              span('mem-comp-pct', part.pct + '%'),
            ),
          ),
          // The status distribution rides at the legend's tail as one quiet line,
          // not as a second chip row: the block already owns one "share of the
          // whole" reading and two would disagree about what the whole is.
          statuses.length === 0
            ? null
            : h(
                'div',
                { className: 'mem-comp-status' },
                span('mem-comp-status-label', '状态'),
                span(
                  'mem-comp-status-value',
                  statuses
                    .map((entry) => statusLabel(entry?.status) + ' ' + formatCount(entry?.n))
                    .join(' · '),
                ),
              ),
        ),
      ),
    )
  }
  // The overview's health summary is a passive band: the cells state the numbers
  // and one action in the section head opens the view that can explain them. Four
  // buttons that all did the same thing were an affordance that lied (audit A3.12).
  function healthStrip(data, onJump) {
    const items = []
    if (data?.health)
      items.push([
        '索引',
        indexLabel(data.health.state) + ' · ' + withUnit(data.health.notes, '条'),
        data.health.state === 'ready' ? null : 'warn',
      ])
    if (data?.health?.lastScan) items.push(['扫描', formatTime(data.health.lastScan), null])
    if (data?.queue?.failed) items.push(['失败', withUnit(data.queue.failed, '个'), 'err'])
    if (data?.hot?.capacity)
      items.push(['热层', formatCount(data.hot.used) + '/' + formatCount(data.hot.capacity), null])
    if (items.length === 0) return null
    return section(
      COPY.health,
      onJump ? button('全部 →', () => onJump('health'), 'mem-action') : null,
      h(
        'div',
        { className: 'mem-summary', 'aria-label': COPY.health },
        items.map(([name, value, kind]) =>
          h(
            'div',
            { className: 'mem-summary-item', key: name },
            span('mem-label', name),
            span('mem-summary-value' + (kind ? ' is-' + kind : ''), value),
          ),
        ),
      ),
    )
  }
  function recentList(rows, onJump) {
    const entries = (Array.isArray(rows) ? rows : []).slice(0, 8)
    return section(
      COPY.recent,
      onJump ? button('全部 →', () => onJump('search'), 'mem-action') : null,
      entries.length === 0
        ? meta('还没有可显示的记录。')
        : h(
            'ul',
            { className: 'mem-recent' },
            entries.map((entry, index) =>
              h(
                'li',
                { className: 'mem-recent-row', key: String(entry?.path ?? entry?.title ?? index) },
                h('span', { className: 'mem-dot', 'aria-hidden': true }),
                h(
                  'div',
                  { className: 'mem-recent-main' },
                  span('mem-recent-title', entry?.title || entry?.path || '未命名'),
                  span(
                    'mem-recent-meta',
                    typeLabel(entry?.type) +
                      ' · ' +
                      formatTime(entry?.updated ?? entry?.mtime ?? null),
                  ),
                ),
              ),
            ),
          ),
    )
  }
  /**
   * 概览: a KPI band whose cells jump, one composition surface, the recent
   * changes and a passive health summary. The identity line lives in the shell
   * masthead when composed, so this view adds its own heading in standalone mode
   * only (where the masthead is absent).
   */
  function OverviewView({ sessionId, visible, onJump, onMeta, refreshKey }) {
    const poll = usePanelPoll({ sessionId, action: 'overview', visible, refreshKey })
    const data = poll.value
    const project = data?.project ?? null
    const unbound = project?.state === 'unbound'
    const empty = data !== null && !unbound && Number(data.counts?.notes ?? 0) === 0
    React.useEffect(() => {
      if (!onMeta) return
      onMeta({
        project,
        updatedAt: poll.updatedAt,
        loading: poll.loading,
        error: poll.error,
        refresh: poll.refresh,
      })
    }, [onMeta, project, poll.updatedAt, poll.loading, poll.error])
    return h(
      'div',
      { className: 'mem-ledger' },
      h(StatusLine, {
        loading: poll.loading,
        error: poll.error,
        stale: data !== null && poll.error !== null,
        updatedAt: poll.updatedAt,
        onRetry: poll.refresh,
      }),
      // Composed, the tab names the page: a "概览" headline under a 概览 tab is the same
      // word twice, and the "去检索" jump pointed at a box that is now always one row
      // above it. Standalone — no shell, so no tabs and no box — keeps both, because
      // there the heading is the only thing that says where you are.
      onMeta
        ? null
        : viewhead(COPY.overviewTitle, h('div', { className: 'mem-actions' }, refreshButton(poll))),
      data === null && poll.error === null && poll.loading ? h(Loading, null) : null,
      onMeta ? null : project ? h(ProjectCard, { project }) : null,
      unbound
        ? h(UnboundSection, { project, onJump })
        : empty
          ? h('div', { className: 'mem-notice is-empty', role: 'status' }, COPY.emptyOverview)
          : data !== null
            ? [
                // The charts come first, directly under the KPI band: the round's
                // whole point is that a reader sees the shape of the memory before
                // the sentences (design §3.4). Each one renders nothing at all when
                // its payload is absent, so a degraded index shows no hollow grid.
                kpiBand(data.counts, data.queue, onJump, data.activity),
                heatmap(data.activity),
                flowBars(data.activity),
                composition(data.counts),
                frequencyRows(data.tags),
                recentList(data.recent, onJump),
                healthStrip(data, onJump),
              ].map((node, index) =>
                node ? h('div', { key: 'block' + index, className: 'mem-block' }, node) : null,
              )
            : null,
    )
  }
  // The one status region of 检索. It owns idle/loading/empty/notice/error copy
  // and nothing else renders any of those strings (audit A2/A3.1-5). `results`
  // is deliberately silent here: a page of results speaks for itself and its
  // footer below carries the counts.
  function SearchStatus({ kind, text, stale, retry }) {
    if (kind === null || kind === 'results') return null
    if (kind === 'error')
      return h(
        'div',
        {
          className: 'mem-notice ' + (stale ? 'is-stale' : 'is-error'),
          role: stale ? 'status' : 'alert',
          'aria-live': stale ? 'polite' : undefined,
        },
        h('span', null, text),
        button(COPY.retry, retry),
      )
    if (kind === 'empty')
      return h(
        'div',
        { className: 'mem-notice is-empty', role: 'status', 'aria-live': 'polite' },
        h('span', null, text),
      )
    return h(
      'p',
      {
        className: 'mem-status' + (kind === 'idle' ? ' is-idle' : ''),
        role: 'status',
        'aria-live': 'polite',
      },
      h('span', null, text),
    )
  }
  function SearchView({ sessionId, query, scope, type, status, limit, visible, onFilter }) {
    const [snapshot, setSnapshot] = React.useState(null)
    const value = snapshot?.sessionId === sessionId ? snapshot.value : null
    const [loading, setLoading] = React.useState(false)
    const [failure, setFailure] = React.useState(null)
    const error = failure?.sessionId === sessionId ? failure.error : null
    // The only status-ish value kept in state: a run-scoped notice carrying the
    // session that produced it. It is cleared when the next user-started run
    // begins and survives the automatic unbound→all continuation, which is what
    // makes it visible at all (audit A3.4).
    const [notice, setNotice] = React.useState(null)
    const runNotice = notice?.sessionId === sessionId ? notice : null
    const [updatedAt, setUpdatedAt] = React.useState(0)
    const controller = React.useRef(null)
    const session = React.useRef(sessionId)
    session.current = sessionId
    // The query and the three filters are the SHELL's now: the field lives in the
    // top bar, so this view must not keep a second copy of what the box shows —
    // that is exactly the duplicate-state class the 检索 page was retired for.
    // `onFilter(field, value)` asks the shell to change one filter and re-run;
    // without it the chips still render but cannot change the read, which is how
    // the view behaves when the shell has not wired it.
    React.useEffect(() => {
      setNotice(null)
      setLoading(false)
      setUpdatedAt(0)
      return () => controller.current?.abort()
    }, [sessionId])
    // `continuation` is the unbound→all retry: it belongs to the run that
    // produced the notice, so it neither announces loading again nor clears the
    // notice. Everything else is a user-started run that resets the notice.
    const run = async (options = {}, continuation = null) => {
      const text = String(options.query ?? query ?? '').trim()
      // An empty query is not a search: no request, and the shell keeps the
      // caret. The idle sentence is what the body shows in that state.
      if (text === '') return
      // `hasOwn` rather than `??`: the 全部 chip passes `type: null` /
      // `status: null` on purpose — a nullish merge would fall back to the
      // current value and make the clear-filter chip a silent no-op. The same
      // spelling covers `scope`, so a future "不限" chip cannot be a silent no-op.
      const nextScope = Object.hasOwn(options, 'scope') ? options.scope : scope
      const nextType = Object.hasOwn(options, 'type') ? options.type : type
      const nextStatus = Object.hasOwn(options, 'status') ? options.status : status
      const nextLimit = options.limit ?? limit ?? 25
      controller.current?.abort()
      const current = new AbortController()
      controller.current = current
      if (continuation === null) {
        setLoading(true)
        setNotice(null)
      }
      try {
        const next = await post(
          {
            sessionId,
            action: 'search',
            query: text,
            scope: nextScope,
            type: nextType,
            status: nextStatus,
            limit: nextLimit,
          },
          current.signal,
        )
        if (
          current.signal.aborted ||
          controller.current !== current ||
          session.current !== sessionId
        )
          return
        setSnapshot({ sessionId, query: text, value: next })
        setFailure(null)
        setUpdatedAt(Date.now())
      } catch (cause) {
        if (
          cause?.name === 'AbortError' ||
          current.signal.aborted ||
          controller.current !== current ||
          session.current !== sessionId
        )
          return
        if (cause?.code === 'unbound' && nextScope === 'project') {
          const fallback = { sessionId, text: COPY.searchUnbound }
          onFilter?.('scope', 'all')
          setNotice(fallback)
          setLoading(false)
          void run(
            {
              query: text,
              scope: 'all',
              type: nextType,
              status: nextStatus,
              limit: nextLimit,
            },
            fallback,
          )
          return
        }
        setFailure({ sessionId, error: cause })
      } finally {
        if (controller.current === current && session.current === sessionId) setLoading(false)
      }
    }
    // One run per (query, filter) the shell hands down. The view does not poll and
    // does not retry on its own: a new run is the shell's decision, so an idle
    // body cannot spend requests behind the user's back.
    const runKey = [sessionId, query, scope, type, status, limit].join('\u0000')
    const lastRun = React.useRef(null)
    React.useEffect(() => {
      if (!visible) return
      if (lastRun.current === runKey) return
      lastRun.current = runKey
      void run({ query, scope, type, status, limit })
      // `run` closes over the current props; the key is what decides a new read.
    }, [runKey, visible])
    const values = { type, status, scope }
    // A filter chip asks the shell for the change AND the re-run, in one call, so
    // the filter is never applied twice or applied without a read.
    const refine = (field, key) => {
      if (onFilter) {
        onFilter(field, key)
        return
      }
      void run({ [field]: key, limit: 25 })
    }
    const filterRows = FILTER_GROUPS.map(([title, field, keys]) =>
      h(
        'div',
        { className: 'mem-filter', key: field, role: 'group', 'aria-label': title },
        span('mem-filter-label', title),
        h(
          'div',
          { className: 'mem-filter-options' },
          keys.map((key) =>
            h(
              'button',
              {
                type: 'button',
                key: String(key),
                className: 'mem-filter-option',
                'aria-pressed': values[field] === key,
                onClick: () => refine(field, key),
              },
              key === null
                ? '全部'
                : field === 'type'
                  ? typeLabel(key)
                  : field === 'status'
                    ? statusLabel(key)
                    : SCOPE_LABELS[key],
            ),
          ),
        ),
      ),
    )
    const results = Array.isArray(value?.hits) ? value.hits : []
    // The highlight terms are the ones the displayed page was searched with, not
    // whatever is typed in the field after the run.
    const appliedQuery = snapshot?.sessionId === sessionId ? String(snapshot.query ?? '') : ''
    // One derived status, one render site. No status string lives in state; the
    // derivation is the only place that can decide what the view is doing, so
    // the duplicate-idle class (two owners, two lifecycles) cannot come back.
    const statusKind = error
      ? 'error'
      : loading
        ? 'loading'
        : value === null
          ? runNotice !== null
            ? 'notice'
            : 'idle'
          : results.length === 0
            ? 'empty'
            : 'results'
    const stale = statusKind === 'error' && value !== null && updatedAt > 0
    const statusText =
      statusKind === 'error'
        ? stale
          ? COPY.stale(formatClock(updatedAt))
          : COPY.error(error?.message ?? '未知错误')
        : statusKind === 'loading'
          ? COPY.searchLoading
          : statusKind === 'notice'
            ? runNotice.text
            : statusKind === 'idle'
              ? COPY.searchIdle
              : statusKind === 'empty'
                ? COPY.searchEmpty
                : null
    // One row per hit: title with type/status chips, path breadcrumb, a two-line
    // snippet with the query marked, then the source/ranking signals as chips.
    const rows = results.map((entry, index) => {
      const chips = []
      if (entry?.source)
        chips.push(
          h('span', { className: 'mem-chip', key: 'source' }, '来源 ' + sourceLabel(entry.source)),
        )
      for (const [signalIndex, signal] of (Array.isArray(entry?.scoreSignals)
        ? entry.scoreSignals
        : []
      ).entries())
        chips.push(
          h('span', { className: 'mem-chip', key: 'signal' + signalIndex }, String(signal)),
        )
      return h(
        'li',
        { className: 'mem-result', key: String(entry?.path ?? '') + ':' + index },
        h(
          'div',
          { className: 'mem-result-main' },
          h(
            'div',
            { className: 'mem-result-head' },
            span('mem-result-title', entry?.title || entry?.path || '未命名'),
            h(
              'span',
              { className: 'mem-chips' },
              span('mem-chip', typeLabel(entry?.type)),
              span('mem-chip', statusLabel(entry?.status)),
            ),
          ),
          h(
            'span',
            { className: 'mem-result-path', title: String(entry?.path ?? '') },
            String(entry?.path ?? ''),
          ),
          entry?.snippet
            ? h('p', { className: 'mem-snippet' }, highlight(entry.snippet, appliedQuery))
            : null,
          chips.length === 0 ? null : h('span', { className: 'mem-chips' }, chips),
        ),
      )
    })
    return h(
      'div',
      { className: 'mem-ledger' },
      // The title says which question this body answers; the field itself lives in
      // the shell's top bar, above the strip. Two forms would be two owners of the
      // query and a duplicated `role="search"` in the same DOM.
      viewhead(COPY.searchTitle, meta(COPY.searchIndex)),
      ...filterRows,
      h(SearchStatus, {
        kind: statusKind,
        text: statusText,
        stale,
        retry: () => void run({ limit }),
      }),
      rows.length === 0 ? null : h('ol', { className: 'mem-results' }, rows),
      statusKind === 'results'
        ? value.hasMore
          ? h(
              'div',
              { className: 'mem-more' },
              meta(
                '已显示 ' +
                  formatCount(results.length) +
                  ' 条 · 用时 ' +
                  formatCount(value.tookMs) +
                  ' ms',
              ),
              Number(value.limit) < 50
                ? button('显示更多', () => void run({ limit: 50 }))
                : meta(COPY.searchLimit),
            )
          : meta(
              '共 ' +
                formatCount(results.length) +
                ' 条 · 用时 ' +
                formatCount(value.tookMs) +
                ' ms',
            )
        : null,
    )
  }
  // The 健康 summary is one 2×2 raised band: the four things a user checks first,
  // each carrying its state colour, before the banded sections that explain them.
  function healthSummary(data) {
    const index = data?.index ?? {}
    const queue = data?.queue ?? {}
    const hot = data?.hot ?? {}
    const queued = Number(queue.queued ?? 0)
    const failed = Number(queue.failed ?? 0)
    const deferred = Number(queue.deferred ?? 0)
    const pending = queued + failed + deferred
    const capacity = Number(hot.capacity ?? 0)
    const used = Number(hot.used ?? 0)
    const percent = capacity > 0 ? Math.min(100, Math.round((used / capacity) * 100)) : 0
    const items = [
      ['索引', indexLabel(index.state), index.state === 'ready' ? null : 'warn'],
      ['队列', pending === 0 ? '空' : withUnit(pending, '个'), failed > 0 ? 'err' : null],
      ['热层', capacity > 0 ? percent + '%' : '不可用', percent >= 100 ? 'err' : null],
      [
        '摘要',
        data?.digest?.window?.days ? '最近 ' + data.digest.window.days + ' 天' : '未生成',
        null,
      ],
    ]
    return h(
      'div',
      { className: 'mem-summary', 'aria-label': '健康摘要' },
      items.map(([name, value, kind]) =>
        h(
          'div',
          { className: 'mem-summary-item', key: name },
          span('mem-label', name),
          span('mem-summary-value' + (kind ? ' is-' + kind : ''), value),
        ),
      ),
    )
  }
  function indexSection(index) {
    if (!index) return null
    const state = String(index.state ?? '')
    return section(
      COPY.index,
      stamp(indexLabel(state), state === 'ready' ? 'ok' : state === 'degraded' ? 'warn' : null),
      facts([
        ['后端', index.backend ?? '未知'],
        ['全文检索', index.fts ? 'FTS5 可用' : '不可用'],
        ['扫描', index.scanning ? '正在扫描' : index.stale ? '可能过期' : '最新'],
        ['上次扫描', formatTime(index.lastScan)],
        ['隔离', withUnit(index.quarantined, '个')],
        ['笔记', withUnit(index.notes, '条')],
      ]),
      index.degraded || index.reason
        ? h(
            'p',
            { className: 'mem-meta mem-warn' },
            '降级：' + String(index.reason ?? '原因未知') + '（检索仍可用，召回质量可能下降）',
          )
        : null,
    )
  }
  function queueSection(queue, actions) {
    const queued = Number(queue?.queued ?? 0)
    const failed = Number(queue?.failed ?? 0)
    const deferred = Number(queue?.deferred ?? 0)
    const jobs = Array.isArray(queue?.failedJobs) ? queue.failedJobs : []
    return section(
      COPY.queue,
      failed > 0 ? stamp(withUnit(failed, '个失败'), 'err') : null,
      queued + failed + deferred === 0
        ? meta(COPY.queueEmpty)
        : facts([
            ['排队', withUnit(queued, '个')],
            ['失败', withUnit(failed, '个')],
            ['延迟', withUnit(deferred, '个')],
          ]),
      jobs.length === 0
        ? null
        : h(
            'ul',
            { className: 'mem-rows' },
            jobs.map((job) =>
              h(
                'li',
                { className: 'mem-row', key: String(job?.jobId ?? '') },
                h(
                  'div',
                  { className: 'mem-recent-main' },
                  span('mem-row-title', '作业 ' + String(job?.jobId ?? '')),
                  meta(
                    '失败于 ' +
                      formatTime(job?.failedAt ?? null) +
                      ' · 尝试 ' +
                      formatCount(job?.attempts),
                  ),
                ),
                actions.retry
                  ? button(
                      MUTATION_COPY['retry-job'].label,
                      (event) => actions.retry(job, event),
                      'mem-action',
                      actions.busy,
                    )
                  : null,
              ),
            ),
          ),
    )
  }
  function hotSection(hot, actions) {
    if (hot === null || hot === undefined) return section(COPY.hot, null, meta('热层状态不可用。'))
    const capacity = Number(hot.capacity ?? 0)
    const used = Number(hot.used ?? 0)
    const percent = capacity > 0 ? Math.min(100, Math.round((used / capacity) * 100)) : 0
    const sections = Array.isArray(hot.sections) ? hot.sections : []
    return section(
      COPY.hot,
      stamp(percent >= 100 ? '热层已满' : '已用 ' + percent + '%', percent >= 100 ? 'err' : 'warn'),
      h(
        'div',
        { className: 'mem-meter' },
        span('mem-meter-head', formatCount(used) + ' / ' + formatCount(capacity) + ' 字符'),
        meta('触发线 ' + formatCount(hot.trigger)),
        h(
          'div',
          { className: 'mem-meter-track', role: 'img', 'aria-label': '热层已用 ' + percent + '%' },
          h('div', {
            className: 'mem-meter-fill' + (percent >= 100 ? ' is-warn' : ''),
            style: { width: percent + '%' },
          }),
        ),
      ),
      hot.missing ? meta('热层文件尚未创建。') : null,
      facts([
        ['可归档', withUnit(hot.archivable, '条')],
        ['可压缩', withUnit(hot.compactable, '条')],
      ]),
      sections.length === 0
        ? null
        : h(
            'ul',
            { className: 'mem-rows' },
            sections.map((zone) =>
              h(
                'li',
                { className: 'mem-row', key: String(zone?.name ?? '') },
                span('mem-row-title', String(zone?.name ?? '未命名区')),
                meta(
                  withUnit(zone?.chars, '字符') +
                    ' · ' +
                    withUnit(zone?.entries, '条') +
                    ' · ' +
                    withUnit(zone?.pointers, '指针'),
                ),
              ),
            ),
          ),
      actions.compact
        ? h(
            'div',
            { className: 'mem-more' },
            meta('压缩会折叠指针行并归档最旧的已完成条目'),
            button(MUTATION_COPY['compact-hot'].label, actions.compact, 'mem-action', actions.busy),
          )
        : null,
    )
  }
  function digestSection(digest, actions) {
    const notes = digest?.notes ?? {}
    const appraisal = digest?.appraisal ?? null
    const findings = Array.isArray(appraisal?.findings) ? appraisal.findings : []
    return h(
      'div',
      { className: 'mem-digest' },
      section(
        COPY.digest,
        digest?.window?.days ? stamp('最近 ' + digest.window.days + ' 天') : null,
        facts([
          ['新建', withUnit(notes.created, '条')],
          ['更新', withUnit(notes.updated, '条')],
          ['取代', withUnit(notes.superseded, '条')],
          ['待复核', withUnit(appraisal?.total ?? 0, '条')],
        ]),
        findings.length === 0
          ? meta('没有需要复核的条目。')
          : h(
              'ul',
              { className: 'mem-rows' },
              findings
                .slice(0, 8)
                .map((finding, index) =>
                  h(
                    'li',
                    { className: 'mem-row', key: String(finding?.path ?? index) },
                    stamp(
                      SEVERITY_LABELS[finding?.severity] ?? String(finding?.severity ?? '提示'),
                    ),
                    span('mem-row-title', String(finding?.title ?? finding?.code ?? '')),
                    meta(String(finding?.code ?? '')),
                  ),
                ),
            ),
        appraisal?.truncated ? meta('扫描已截断，仅显示部分结果。') : null,
        actions.refresh
          ? h(
              'div',
              { className: 'mem-more' },
              meta(
                digest?.publication?.path
                  ? '已发布 ' + String(digest.publication.path)
                  : '写入项目 _meta/digest.md',
              ),
              button(
                MUTATION_COPY['refresh-digest'].label,
                actions.refresh,
                'mem-action',
                actions.busy,
              ),
            )
          : null,
      ),
    )
  }
  // 诊断记录 is a timeline, not a decisions ledger: the old label mislabelled
  // brief/search events (audit A3.8). A dot per event and one line per event.
  function diagnosticsSection(diagnostics) {
    const events = Array.isArray(diagnostics?.events) ? diagnostics.events : []
    return section(
      COPY.diagnostics,
      diagnostics === null || diagnostics === undefined
        ? null
        : meta(withUnit(events.length, '条')),
      diagnostics === null || diagnostics === undefined
        ? meta('诊断不可用。')
        : events.length === 0
          ? meta('还没有记录。')
          : h(
              'ul',
              { className: 'mem-events' },
              events.map((event, index) =>
                h(
                  'li',
                  { className: 'mem-event', key: String(event?.seq ?? index) },
                  h('span', { className: 'mem-event-dot', 'aria-hidden': true }),
                  h(
                    'div',
                    null,
                    span('mem-row-title', String(event?.event ?? '未知')),
                    meta(
                      formatTime(event?.at) + (event?.outcome ? ' · ' + String(event.outcome) : ''),
                    ),
                  ),
                ),
              ),
            ),
    )
  }
  // The confirm sheet renders the preview's own facts, warning and consequence
  // lines; the confirm click is a separate, single-use token. It is the only
  // modal in the panel, so it may float above the ledger with a scrim.
  function renderSheet({
    sheet,
    busy,
    error,
    panelRef,
    confirmRef,
    cancelRef,
    onCancel,
    onConfirm,
  }) {
    const preview = sheet.preview ?? {}
    const facts = previewFactsOf(preview)
    const effects = previewEffectsOf(preview)
    const trap = (event) => {
      if (event.key === 'Tab') {
        // While busy both action buttons are disabled, and focus() on a disabled
        // button is a no-op — the trap would drop focus to <body>. Keep it on the
        // dialog panel instead (audit A4).
        const order = (
          busy ? [panelRef?.current] : [cancelRef?.current, confirmRef?.current]
        ).filter(Boolean)
        if (order.length === 0) return
        event.preventDefault()
        const at = order.indexOf(event.target)
        const step = event.shiftKey ? -1 : 1
        const next = at < 0 ? order[0] : order[(at + step + order.length) % order.length]
        next?.focus?.()
        return
      }
      if (event.key === 'Escape' && !busy) {
        event.preventDefault()
        onCancel()
      }
    }
    // Alert-dialog semantics (Radix): Cancel takes focus, the scrim does not
    // dismiss, Escape does, and only a settled POST may close the sheet.
    return h(
      'div',
      { className: 'mem-sheet' },
      h('div', { className: 'mem-sheet-scrim' }),
      h(
        'div',
        {
          className: 'mem-sheet-panel',
          ref: panelRef,
          role: 'alertdialog',
          'aria-modal': true,
          'aria-labelledby': 'obsidian-mem-sheet-title',
          'aria-describedby': 'obsidian-mem-sheet-body',
          tabIndex: -1,
          onKeyDown: trap,
        },
        h(
          'div',
          { className: 'mem-sheet-head' },
          h(
            'h2',
            { className: 'mem-sheet-title mem-display', id: 'obsidian-mem-sheet-title' },
            String(preview.title ?? MUTATION_COPY[sheet.mutation]?.title ?? '确认操作'),
          ),
          meta(PREVIEW_TTL_HINT),
        ),
        h(
          'div',
          { className: 'mem-sheet-body', id: 'obsidian-mem-sheet-body' },
          error ? h('p', { className: 'mem-sheet-error', role: 'alert' }, String(error)) : null,
          facts.map((fact, index) =>
            h(
              'div',
              { className: 'mem-sheet-fact', key: 'fact' + index },
              span('mem-label', String(fact?.label ?? '')),
              span('mem-fact-value', String(fact?.value ?? '')),
            ),
          ),
          effects.length > 0
            ? h(
                'ul',
                { className: 'mem-sheet-effects' },
                effects.map((text, index) => h('li', { key: 'effect' + index }, String(text))),
              )
            : null,
          preview.warning
            ? h('p', { className: 'mem-sheet-warning mem-meta' }, String(preview.warning))
            : null,
        ),
        h(
          'div',
          { className: 'mem-sheet-actions' },
          h(
            'button',
            {
              type: 'button',
              className: 'mem-sheet-cancel',
              ref: cancelRef,
              disabled: busy,
              onClick: onCancel,
            },
            CANCEL,
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'mem-sheet-confirm',
              ref: confirmRef,
              disabled: busy,
              onClick: onConfirm,
            },
            busy ? CONFIRM_BUSY : String(preview.confirmLabel ?? CONFIRM_FALLBACK),
          ),
        ),
        h(
          'span',
          { className: 'mem-sr', role: 'status', 'aria-live': 'polite' },
          busy ? CONFIRM_BUSY : '等待确认',
        ),
      ),
    )
  }
  /**
   * 健康: the index/hot/queue/digest ledger plus the three confirmed mutations.
   * Every mutation is preview-first; the sheet reads a token the route issued and
   * a confirm is the only write this view can cause. Without capabilities the
   * view renders as a read-only ledger.
   */
  function HealthView({ sessionId, visible, onJump, onMeta, refreshKey }) {
    const poll = usePanelPoll({ sessionId, action: 'health', visible, refreshKey })
    const data = poll.value
    const capabilities = mutationsOf(data)
    const [sheet, setSheet] = React.useState(null)
    const [busy, setBusy] = React.useState(false)
    const [notice, setNotice] = React.useState(null)
    const [sheetError, setSheetError] = React.useState('')
    const [apiDown, setApiDown] = React.useState(false)
    const confirmRef = React.useRef(null)
    const cancelRef = React.useRef(null)
    const panelRef = React.useRef(null)
    // The control that opened the sheet gets focus back when it closes (audit
    // A4); the panel ref is the Tab-trap floor while both actions are busy.
    const returnFocusRef = React.useRef(null)
    const wasOpen = React.useRef(false)
    const alive = React.useRef(true)
    React.useEffect(
      () => () => {
        alive.current = false
      },
      [],
    )
    React.useEffect(() => {
      if (!onMeta) return
      onMeta({
        project: data?.project ?? null,
        updatedAt: poll.updatedAt,
        loading: poll.loading,
        error: poll.error,
        refresh: poll.refresh,
      })
    }, [onMeta, data?.project, poll.updatedAt, poll.loading, poll.error])
    React.useEffect(() => {
      if (sheet !== null) {
        wasOpen.current = true
        cancelRef.current?.focus?.()
        return
      }
      if (!wasOpen.current) return
      wasOpen.current = false
      returnFocusRef.current?.focus?.()
    }, [sheet])
    React.useEffect(() => {
      if (sheet === null || typeof document === 'undefined') return undefined
      const listen = (event) => {
        if (event.key === 'Escape' && !busy) {
          event.preventDefault()
          setSheet(null)
        }
      }
      document.addEventListener('keydown', listen)
      return () => document.removeEventListener('keydown', listen)
    }, [sheet, busy])
    const can = (name) => !apiDown && capabilities.includes(name)
    // A refusal that invalidates the token (or the facts behind it) closes the
    // sheet and refreshes the read; a transient failure stays inside the sheet so
    // the user can retry or cancel without losing the preview (Sentry's pattern).
    const invalidating = [
      'preview-stale',
      'preview-expired',
      'preview-unknown',
      'preview-mismatch',
      'job-missing',
      'job-foreign',
      'job-not-retryable',
      'hot-missing',
      'digest-unavailable',
    ]
    const fail = (cause) => {
      const code = typeof cause?.code === 'string' ? cause.code : ''
      const message = MUTATION_FAILURES[code]
      if (invalidating.includes(code)) {
        setSheet(null)
        setSheetError('')
        setNotice({ tone: 'error', text: message })
        poll.refresh()
        return
      }
      if (code === 'preview-in-progress') {
        setSheetError(message)
        return
      }
      if (PUBLIC_CODES.includes(code) || code === '') {
        if (sheet !== null) {
          setSheetError('确认接口暂不可用；可稍后重试或取消。')
          return
        }
        setApiDown(true)
        setNotice({ tone: 'error', text: '确认接口不可用；记忆面板保持只读。' })
        return
      }
      const text = '操作失败（' + code + '）：' + String(cause?.message ?? '未知错误')
      if (sheet !== null) setSheetError(text)
      else setNotice({ tone: 'error', text })
    }
    const preview = async (mutation, args, invoker) => {
      if (busy) return
      if (invoker?.currentTarget) returnFocusRef.current = invoker.currentTarget
      setBusy(true)
      setNotice(null)
      setSheetError('')
      try {
        const value = await post({ sessionId, action: 'preview', mutation, args })
        if (!alive.current) return
        if (
          value === null ||
          typeof value !== 'object' ||
          typeof value.token !== 'string' ||
          value.preview === null ||
          typeof value.preview !== 'object'
        ) {
          setApiDown(true)
          setNotice({ tone: 'error', text: '预览格式无法识别；记忆面板保持只读。' })
          return
        }
        setSheet({ mutation, token: value.token, preview: value.preview })
      } catch (cause) {
        if (alive.current) fail(cause)
      } finally {
        if (alive.current) setBusy(false)
      }
    }
    const confirm = async () => {
      if (busy || sheet === null) return
      setBusy(true)
      setSheetError('')
      try {
        const value = await post({ sessionId, action: 'confirm', token: sheet.token })
        if (!alive.current) return
        const mutation = sheet.mutation
        setSheet(null)
        if (value === null || typeof value !== 'object' || value.result === undefined) {
          setNotice({ tone: 'error', text: '确认返回无法识别；已刷新。' })
        } else {
          setNotice({ tone: 'ok', text: outcomeOf(mutation, value) })
        }
        poll.refresh()
      } catch (cause) {
        if (alive.current) fail(cause)
      } finally {
        if (alive.current) setBusy(false)
      }
    }
    const dataValue = data
    const unbound = dataValue?.project?.state === 'unbound'
    return h(
      'div',
      { className: 'mem-ledger' },
      h(StatusLine, {
        loading: poll.loading,
        error: poll.error,
        stale: dataValue !== null && poll.error !== null,
        updatedAt: poll.updatedAt,
        onRetry: poll.refresh,
      }),
      viewhead(
        COPY.healthTitle,
        h('div', { className: 'mem-actions' }, onMeta ? null : refreshButton(poll)),
      ),
      notice
        ? h(
            'div',
            {
              className: 'mem-action-status' + (notice.tone === 'error' ? ' is-error' : ''),
              role: 'status',
              'aria-live': 'polite',
            },
            notice.text,
          )
        : null,
      dataValue === null && poll.error === null && poll.loading ? h(Loading, null) : null,
      unbound
        ? h(UnboundSection, { project: dataValue.project, onJump })
        : dataValue !== null
          ? [
              healthSummary(dataValue),
              indexSection(dataValue.index),
              queueSection(dataValue.queue, {
                busy,
                retry: can('retry-job')
                  ? (job, invoker) =>
                      void preview(
                        'retry-job',
                        {
                          jobId: String(job?.jobId ?? ''),
                        },
                        invoker,
                      )
                  : null,
              }),
              hotSection(dataValue.hot, {
                busy,
                compact: can('compact-hot')
                  ? (invoker) => void preview('compact-hot', {}, invoker)
                  : null,
              }),
              dataValue.digest
                ? digestSection(dataValue.digest, {
                    busy,
                    refresh: can('refresh-digest')
                      ? (invoker) => void preview('refresh-digest', { days: 1 }, invoker)
                      : null,
                  })
                : null,
              diagnosticsSection(dataValue.diagnostics),
            ].map((node, index) =>
              node ? h('div', { key: 'block' + index, className: 'mem-block' }, node) : null,
            )
          : null,
      sheet
        ? renderSheet({
            sheet,
            busy,
            error: sheetError,
            panelRef,
            confirmRef,
            cancelRef,
            onCancel: () => {
              if (!busy) {
                setSheet(null)
                setSheetError('')
              }
            },
            onConfirm: () => void confirm(),
          })
        : null,
    )
  }
  return { OverviewView, SearchView, HealthView }
}
