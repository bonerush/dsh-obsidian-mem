// The 记忆 panel's 概览 / 检索 / 健康 views, served as one browser ES module by
// lib/panel-route.js. The shell dynamic-imports it and passes React; this file
// imports nothing. Read-only: one POST to obsidian-mem/panel, three actions.
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
  updated: (time) => '数据截至 ' + time,
  stale: (time) => '数据可能已过期，上次更新 ' + time,
  error: (message) => '读取记忆失败：' + message,
  route: '记忆接口未就绪（路由未注册）；重启 dsh 后重试',
  retry: '重试',
  refresh: '刷新',
  emptyOverview: '这个项目还没有记忆。第一次 mem_write 会自动建立绑定并写入第一条。',
  searchIdle: '输入关键词开始检索；结果来自本地索引（FTS5）。',
  searchEmpty: '没有匹配的记忆。',
  searchMore: '还有更多',
  searchLimit: '已达上限 50',
  searchPlaceholder: '搜索记忆（支持中文两字词）',
  searchSubmit: '检索',
  searchLoading: '正在检索…',
  searchUnbound: '当前项目未绑定；正在搜索全部项目。',
  recent: '最近变化',
  composition: '构成',
  health: '健康',
  index: '索引',
  queue: '待处理作业',
  hot: '热层',
  diagnostics: '最近的决策',
  digest: '今日摘要',
  queueEmpty: '队列为空。',
  unboundTitle: '当前项目未绑定记忆',
  unboundSearch: '去检索（搜索全部记忆）',
})
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
/**
 * The three read-only views, constructed against the host's React instance.
 *
 * @param {{React: object}} options - React is the only peer; the host resolves it.
 * @returns {{OverviewView: Function, SearchView: Function, HealthView: Function}} the views.
 */
export function createMemoryViews({ React } = {}) {
  if (React === undefined || React === null) throw new Error('createMemoryViews requires React')
  const h = React.createElement
  const span = (className, ...children) => h('span', { className }, ...children)
  const meta = (text) => span('mem-meta', text)
  const badge = (text) => span('mem-badge', text)
  const chip = (text, className = 'mem-chip') => span(className, text)
  const button = (label, onClick, className = 'mem-btn', disabled = false) =>
    h('button', { type: 'button', className, onClick, disabled }, label)
  const chipButton = (label, pressed, onClick) =>
    h(
      'button',
      { type: 'button', className: 'mem-chip mem-chip-button', 'aria-pressed': pressed, onClick },
      label,
    )
  const row = (className, ...children) =>
    h('div', { className: 'mem-row ' + className }, ...children)
  const card = (title, head, ...body) =>
    h(
      'section',
      { className: 'mem-card', 'aria-label': title },
      h('div', { className: 'mem-card-head' }, h('h3', null, title), head ?? null),
      ...body,
    )
  const facts = (pairs) =>
    h(
      'dl',
      { className: 'mem-facts' },
      pairs.flatMap(([label, value], index) => [
        h('dt', { key: 'k' + index }, label),
        h('dd', { key: 'v' + index }, value),
      ]),
    )
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
  function usePanelPoll({ sessionId, action, visible, intervalMs = REFRESH_MS, params }) {
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
    }, [sessionId, action, visible, intervalMs, key, attempt])
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
      const className = stale ? 'mem-notice mem-stale' : 'mem-notice mem-error'
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
    if (!loading && updatedAt === 0) return null
    const text = loading
      ? updatedAt > 0
        ? COPY.refreshing
        : COPY.loading
      : COPY.updated(formatClock(updatedAt))
    return h('p', { className: 'mem-meta', role: 'status', 'aria-live': 'polite' }, text)
  }
  const refreshButton = (poll) =>
    button(poll.loading ? COPY.refreshing : COPY.refresh, poll.refresh, 'mem-btn', poll.loading)
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
    return card(
      '项目',
      chip(bound ? '已绑定' : '未绑定', bound ? 'mem-chip mem-ok' : 'mem-chip mem-warn'),
      h(
        'div',
        { className: 'mem-project' },
        span('mem-project-name', project?.name ?? '未命名项目'),
        id ? meta('projectId ' + id) : null,
        project?.vault?.basename ? meta('vault ' + project.vault.basename) : null,
      ),
    )
  }
  function UnboundCard({ project, onJump }) {
    return card(
      COPY.unboundTitle,
      null,
      h('p', null, reasonCopy(project?.reason ?? null)),
      meta('绑定指针：仓库根的 .obsidian-mem（插件不会自动修复）'),
      onJump ? button(COPY.unboundSearch, () => onJump('search')) : null,
    )
  }
  function KpiBand({ counts, queue }) {
    const pending = Number(queue?.queued ?? 0) + Number(queue?.failed ?? 0)
    const items = [
      ['记忆条目', counts?.notes, '条'],
      ['关系', counts?.links, '条'],
      ['孤立', counts?.orphans, '条'],
      ['待处理', pending, '个'],
    ]
    return h(
      'div',
      { className: 'mem-kpis', 'aria-label': '关键数字' },
      items.map(([label, value, unit]) =>
        h(
          'div',
          { className: 'mem-kpi', key: label },
          span('mem-kpi-label', label),
          span('mem-kpi-value', withUnit(value, unit)),
        ),
      ),
    )
  }
  function Composition({ counts }) {
    const rows = Array.isArray(counts?.byType) ? counts.byType : []
    const total = rows.reduce((sum, entry) => sum + Number(entry?.n ?? 0), 0)
    if (rows.length === 0) return null
    return card(
      COPY.composition,
      meta(withUnit(total, '条')),
      rows.map((entry, index) => {
        const n = Number(entry?.n ?? 0)
        const pct = total === 0 ? 0 : Math.round((n / total) * 100)
        return h(
          'div',
          { className: 'mem-bar-row', key: String(entry?.type ?? index) },
          span('mem-bar-label', typeLabel(entry?.type)),
          h(
            'span',
            {
              className: 'mem-bar-track',
              role: 'img',
              'aria-label': typeLabel(entry?.type) + ' ' + withUnit(n, '条') + '，占 ' + pct + '%',
            },
            h('span', {
              className: 'mem-bar-fill s' + (index % 6),
              style: { width: Math.max(2, pct) + '%' },
            }),
          ),
          span('mem-bar-value', formatCount(n)),
          meta(pct + '%'),
        )
      }),
    )
  }
  function StatusChips({ counts }) {
    const rows = Array.isArray(counts?.byStatus) ? counts.byStatus : []
    if (rows.length === 0) return null
    return h(
      'div',
      { className: 'mem-chips', 'aria-label': '状态分布' },
      rows.map((entry) => chip(statusLabel(entry?.status) + ' ' + formatCount(entry?.n))),
    )
  }
  function HealthStrip({ data, onJump }) {
    const chips = []
    if (data?.health)
      chips.push(
        '索引 ' + indexLabel(data.health.state) + ' · ' + withUnit(data.health.notes, '条'),
      )
    if (data?.health?.lastScan) chips.push('上次扫描 ' + formatTime(data.health.lastScan))
    if (data?.queue?.failed) chips.push('失败 ' + withUnit(data.queue.failed, '个'))
    if (data?.hot?.capacity)
      chips.push('热层 ' + formatCount(data.hot.used) + '/' + formatCount(data.hot.capacity))
    if (chips.length === 0) return null
    return h(
      'div',
      { className: 'mem-chips', 'aria-label': COPY.health },
      chips.map((text) => chipButton(text, false, () => onJump('health'))),
    )
  }
  function RecentList({ rows, onJump }) {
    const list = (Array.isArray(rows) ? rows : []).slice(0, 8)
    return card(
      COPY.recent,
      onJump ? button('全部 →', () => onJump('search'), 'mem-btn mem-btn-quiet') : null,
      list.length === 0
        ? meta('还没有可显示的记录。')
        : h(
            'ul',
            { className: 'mem-rows' },
            list.map((entry) =>
              h(
                'li',
                { className: 'mem-row', key: String(entry?.path ?? entry?.title ?? '') },
                span('mem-row-time', formatTime(entry?.updated ?? entry?.mtime ?? null)),
                span('mem-row-title', entry?.title || entry?.path || '未命名'),
                badge(typeLabel(entry?.type)),
              ),
            ),
          ),
    )
  }
  function OverviewView({ sessionId, visible, onJump }) {
    const poll = usePanelPoll({ sessionId, action: 'overview', visible })
    const data = poll.value
    const project = data?.project ?? null
    const unbound = project?.state === 'unbound'
    const empty = data !== null && !unbound && Number(data.counts?.notes ?? 0) === 0
    return h(
      'div',
      { className: 'mem-stack' },
      h(StatusLine, {
        loading: poll.loading,
        error: poll.error,
        stale: data !== null && poll.error !== null,
        updatedAt: poll.updatedAt,
        onRetry: poll.refresh,
      }),
      row(
        'mem-row-end',
        refreshButton(poll),
        onJump ? button('去检索', () => onJump('search'), 'mem-btn mem-btn-quiet') : null,
        onJump ? button('看健康', () => onJump('health'), 'mem-btn mem-btn-quiet') : null,
      ),
      data === null && poll.error === null && poll.loading ? h(Loading, null) : null,
      project ? h(ProjectCard, { project }) : null,
      unbound
        ? h(UnboundCard, { project, onJump })
        : empty
          ? h('div', { className: 'mem-notice mem-empty', role: 'status' }, COPY.emptyOverview)
          : data !== null
            ? [
                h(KpiBand, { key: 'kpi', counts: data.counts, queue: data.queue }),
                h(Composition, { key: 'composition', counts: data.counts }),
                h(StatusChips, { key: 'statuses', counts: data.counts }),
                h(HealthStrip, { key: 'health', data, onJump }),
                h(RecentList, { key: 'recent', rows: data.recent, onJump }),
              ]
            : null,
    )
  }
  function SearchView({ sessionId }) {
    const [query, setQuery] = React.useState('')
    const [scope, setScope] = React.useState('project')
    const [type, setType] = React.useState(null)
    const [status, setStatus] = React.useState(null)
    const [limit, setLimit] = React.useState(25)
    const [snapshot, setSnapshot] = React.useState(null)
    const value = snapshot?.sessionId === sessionId ? snapshot.value : null
    const [loading, setLoading] = React.useState(false)
    const [failure, setFailure] = React.useState(null)
    const error = failure?.sessionId === sessionId ? failure.error : null
    const [notice, setNotice] = React.useState('')
    const controller = React.useRef(null)
    const session = React.useRef(sessionId)
    session.current = sessionId
    React.useEffect(() => {
      setNotice('')
      setLoading(false)
      return () => controller.current?.abort()
    }, [sessionId])
    const run = async (options = {}) => {
      const text = String(options.query ?? query).trim()
      if (text === '') {
        setNotice(COPY.searchIdle)
        return
      }
      const nextScope = options.scope ?? scope
      const nextType = Object.hasOwn(options, 'type') ? options.type : type
      const nextStatus = Object.hasOwn(options, 'status') ? options.status : status
      const nextLimit = options.limit ?? limit
      setLimit(nextLimit)
      controller.current?.abort()
      const current = new AbortController()
      controller.current = current
      setLoading(true)
      setNotice('')
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
        setSnapshot({ sessionId, value: next })
        setFailure(null)
      } catch (cause) {
        if (
          cause?.name === 'AbortError' ||
          current.signal.aborted ||
          controller.current !== current ||
          session.current !== sessionId
        )
          return
        if (cause?.code === 'unbound' && nextScope === 'project') {
          setScope('all')
          setNotice(COPY.searchUnbound)
          setLoading(false)
          void run({
            query: text,
            scope: 'all',
            type: nextType,
            status: nextStatus,
            limit: nextLimit,
          })
          return
        }
        setFailure({ sessionId, error: cause })
      } finally {
        if (controller.current === current && session.current === sessionId) setLoading(false)
      }
    }
    const values = { type, status, scope }
    const setters = { type: setType, status: setStatus, scope: setScope }
    const filterRows = FILTER_GROUPS.map(([title, field, keys]) =>
      h(
        'div',
        { className: 'mem-filter', key: field },
        meta(title),
        keys.map((key) =>
          chipButton(
            key === null
              ? '全部'
              : field === 'type'
                ? typeLabel(key)
                : field === 'status'
                  ? statusLabel(key)
                  : SCOPE_LABELS[key],
            values[field] === key,
            () => {
              setters[field](key)
              void run({ [field]: key, limit: 25 })
            },
          ),
        ),
      ),
    )
    const results = value?.hits ?? []
    return h(
      'div',
      { className: 'mem-stack' },
      h(
        'form',
        {
          className: 'mem-search',
          role: 'search',
          onSubmit: (event) => {
            event.preventDefault()
            void run({ limit: 25 })
          },
        },
        h(
          'label',
          { className: 'mem-search-label' },
          h('span', { className: 'mem-sr' }, '搜索记忆'),
          h('input', {
            type: 'search',
            className: 'mem-input',
            value: query,
            placeholder: COPY.searchPlaceholder,
            'aria-label': '搜索记忆',
            onChange: (event) => setQuery(event.target.value),
          }),
        ),
        h(
          'button',
          { type: 'submit', className: 'mem-btn mem-btn-primary', disabled: loading },
          loading ? COPY.searchLoading : COPY.searchSubmit,
        ),
      ),
      ...filterRows,
      h(StatusLine, {
        loading,
        error,
        stale: value !== null && error !== null,
        updatedAt: 0,
        onRetry: () => void run({ limit }),
      }),
      notice
        ? h('p', { className: 'mem-meta', role: 'status', 'aria-live': 'polite' }, notice)
        : null,
      loading && value === null && error === null ? h(Loading, null) : null,
      value !== null
        ? results.length === 0
          ? h('div', { className: 'mem-notice mem-empty', role: 'status' }, COPY.searchEmpty)
          : h(
              'ul',
              { className: 'mem-results' },
              results.map((entry, index) =>
                h(
                  'li',
                  { className: 'mem-result', key: String(entry?.path ?? '') + ':' + index },
                  h(
                    'div',
                    { className: 'mem-result-head' },
                    span('mem-result-title', entry?.title || entry?.path || '未命名'),
                    badge(typeLabel(entry?.type)),
                    badge(statusLabel(entry?.status)),
                  ),
                  meta(String(entry?.path ?? '') + ' · 来源 ' + sourceLabel(entry?.source)),
                  entry?.snippet ? h('p', { className: 'mem-snippet' }, entry.snippet) : null,
                  Array.isArray(entry?.scoreSignals) && entry.scoreSignals.length > 0
                    ? meta(entry.scoreSignals.join(' · '))
                    : null,
                ),
              ),
            )
        : null,
      value !== null && value.hasMore
        ? row(
            'mem-row-between',
            meta(COPY.searchMore),
            Number(value.limit) < 50
              ? button('显示更多', () => void run({ limit: 50 }))
              : meta(COPY.searchLimit),
          )
        : null,
      value !== null
        ? meta(
            '共 ' + formatCount(results.length) + ' 条 · 用时 ' + formatCount(value.tookMs) + ' ms',
          )
        : meta(COPY.searchIdle),
    )
  }
  function IndexCard({ index }) {
    if (!index) return null
    const warn = index.state === 'ready' ? 'mem-chip mem-ok' : 'mem-chip mem-warn'
    return card(
      COPY.index,
      chip(indexLabel(index.state), warn),
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
  function QueueCard({ queue }) {
    const queued = Number(queue?.queued ?? 0)
    const failed = Number(queue?.failed ?? 0)
    const deferred = Number(queue?.deferred ?? 0)
    return card(
      COPY.queue,
      failed > 0 ? chip(withUnit(failed, '个失败'), 'mem-chip mem-warn') : null,
      queued + failed + deferred === 0
        ? meta(COPY.queueEmpty)
        : facts([
            ['排队', withUnit(queued, '个')],
            ['失败', withUnit(failed, '个')],
            ['延迟', withUnit(deferred, '个')],
          ]),
    )
  }
  function HotCard({ hot }) {
    if (hot === null || hot === undefined) return card(COPY.hot, null, meta('热层状态不可用。'))
    const capacity = Number(hot.capacity ?? 0)
    const used = Number(hot.used ?? 0)
    const percent = capacity > 0 ? Math.min(100, Math.round((used / capacity) * 100)) : 0
    const sections = Array.isArray(hot.sections) ? hot.sections : []
    return card(
      COPY.hot,
      chip('热层已用 ' + percent + '%', percent >= 100 ? 'mem-chip mem-err' : 'mem-chip'),
      meta('热层 ' + formatCount(used) + '/' + formatCount(capacity)),
      h(
        'div',
        { className: 'mem-meter' },
        h(
          'div',
          { className: 'mem-meter-track', role: 'img', 'aria-label': '热层已用 ' + percent + '%' },
          h('div', {
            className: 'mem-meter-fill' + (percent >= 100 ? ' is-warn' : ''),
            style: { width: Math.max(2, percent) + '%' },
          }),
        ),
      ),
      hot.missing ? meta('热层文件尚未创建。') : null,
      facts([
        ['触发线', formatCount(hot.trigger)],
        ['可归档', withUnit(hot.archivable, '条')],
        ['可压缩', withUnit(hot.compactable, '条')],
      ]),
      sections.length > 0
        ? h(
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
          )
        : null,
    )
  }
  function DiagnosticsCard({ diagnostics }) {
    const events = Array.isArray(diagnostics?.events) ? diagnostics.events : []
    return card(
      COPY.diagnostics,
      null,
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
                  meta(formatTime(event?.at)),
                  badge(String(event?.event ?? '未知')),
                  event?.outcome ? meta(String(event.outcome)) : null,
                ),
              ),
            ),
    )
  }
  function DigestCard({ digest }) {
    const notes = digest?.notes ?? {}
    const appraisal = digest?.appraisal ?? null
    const findings = Array.isArray(appraisal?.findings) ? appraisal.findings : []
    return card(
      COPY.digest,
      digest?.window?.days ? chip('最近 ' + digest.window.days + ' 天') : null,
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
                  badge(SEVERITY_LABELS[finding?.severity] ?? String(finding?.severity ?? '提示')),
                  span('mem-row-title', String(finding?.title ?? finding?.code ?? '')),
                  meta(String(finding?.code ?? '')),
                ),
              ),
          ),
      appraisal?.truncated ? meta('扫描已截断，仅显示部分结果。') : null,
    )
  }
  function HealthView({ sessionId, visible, onJump }) {
    const poll = usePanelPoll({ sessionId, action: 'health', visible })
    const data = poll.value
    const unbound = data?.project?.state === 'unbound'
    return h(
      'div',
      { className: 'mem-stack' },
      h(StatusLine, {
        loading: poll.loading,
        error: poll.error,
        stale: data !== null && poll.error !== null,
        updatedAt: poll.updatedAt,
        onRetry: poll.refresh,
      }),
      row(
        'mem-row-end',
        refreshButton(poll),
        onJump ? button('去检索', () => onJump('search'), 'mem-btn mem-btn-quiet') : null,
      ),
      data === null && poll.error === null && poll.loading ? h(Loading, null) : null,
      unbound
        ? h(UnboundCard, { project: data.project, onJump })
        : data !== null
          ? [
              h(IndexCard, { key: 'index', index: data.index }),
              h(QueueCard, { key: 'queue', queue: data.queue }),
              h(HotCard, { key: 'hot', hot: data.hot }),
              h(DiagnosticsCard, { key: 'diagnostics', diagnostics: data.diagnostics }),
              data.digest ? h(DigestCard, { key: 'digest', digest: data.digest }) : null,
            ]
          : null,
    )
  }
  return { OverviewView, SearchView, HealthView }
}
