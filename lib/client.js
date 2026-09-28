/* global window */
// Source contracts and measured theme values: docs/obsidian-graph-source.md.
window.__ModuleLoader__.load({
  id: 'dsh-obsidian-mem',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    // `label` is this panel's own setting: app.js has no label-size slider.
    // The default follows the user's revised preference on 2026-09-28.
    const DISPLAY = { arrows: false, text: 0, size: 1, width: 1, label: 0.85 }
    const FORCES = {
      center: 1 - Math.log(0.109) / Math.log(0.01),
      repel: 10,
      link: 1,
      distance: 250,
    }
    const FILTER = { search: '', tags: false, attachments: false, existing: false, orphans: true }
    const initialGroups = () => []
    const forceValue = (value) => (Math.pow(0.01, 1 - value) - 0.01) / 0.99
    // Obsidian resolves every graph colour from the computed style of hidden
    // `.graph-view.color-*` probes (app.js `MQ` + `testCSS`). Keep that contract,
    // and bind the same graph variables to this host's theme tokens so the graph
    // follows the app theme exactly as it follows an Obsidian theme.
    const styles = [
      '.memgraph{--graph-text:var(--dsw-alias-label-primary,var(--text-normal,#dadada));--graph-line:var(--dsw-alias-label-dimmed,var(--color-base-35,#3f3f3f));--graph-node:var(--dsw-alias-label-secondary,var(--text-muted,#b3b3b3));--graph-node-unresolved:var(--dsw-alias-label-tertiary,var(--text-faint,#666666));--graph-node-focused:var(--dsw-alias-link,var(--text-accent,#8a5cf5));--graph-node-tag:var(--dsw-alias-state-success-primary,var(--color-green,#44cf6e));--graph-node-attachment:var(--dsw-alias-state-warn-primary,var(--color-yellow,#e0de71));--interactive-accent:var(--dsw-alias-link,var(--color-accent,#8a5cf5));--menu-background:var(--dsw-alias-bg-layer-2,var(--background-secondary,#262626));--menu-border-color:var(--dsw-alias-border-l2,var(--background-modifier-border,#363636));--menu-border-width:1px;--field-background:var(--dsw-alias-bg-base,var(--background-primary,#1e1e1e));--label-tertiary:var(--dsw-alias-label-tertiary,var(--text-faint,#8b8f96));--hover-background:var(--dsw-alias-interactive-bg-hover,#ffffff14);--track-color:var(--dsw-alias-label-dimmed,var(--menu-border-color,#3f3f3f));--error-color:var(--dsw-alias-state-error-primary,var(--color-red,#fb464c));position:relative;width:100%;height:100%;min-height:240px;overflow:hidden;color:var(--graph-text);font:14px/1.5 ui-sans-serif,-apple-system,BlinkMacSystemFont,system-ui,sans-serif}',
      '.memgraph .graph-view.color-fill{color:var(--graph-node)}',
      '.memgraph .graph-view.color-fill-focused{color:var(--graph-node-focused)}',
      '.memgraph .graph-view.color-fill-tag{color:var(--graph-node-tag)}',
      '.memgraph .graph-view.color-fill-attachment{color:var(--graph-node-attachment)}',
      '.memgraph .graph-view.color-fill-unresolved{color:var(--graph-node-unresolved);opacity:.5}',
      '.memgraph .graph-view.color-fill-1,.memgraph .graph-view.color-fill-2,.memgraph .graph-view.color-fill-3,.memgraph .graph-view.color-fill-4,.memgraph .graph-view.color-fill-5,.memgraph .graph-view.color-fill-6{color:var(--graph-node)}',
      '.memgraph .graph-view.color-arrow{color:var(--graph-text);opacity:.5}',
      '.memgraph .graph-view.color-circle{color:var(--graph-node-focused)}',
      '.memgraph .graph-view.color-line{color:var(--graph-line)}',
      '.memgraph .graph-view.color-text{color:var(--graph-text)}',
      '.memgraph .graph-view.color-fill-highlight{color:var(--interactive-accent)}',
      '.memgraph .graph-view.color-line-highlight{color:var(--interactive-accent)}',
      '.memgraph *{box-sizing:border-box}.memgraph canvas{display:block;width:100%;height:100%;touch-action:none;outline:none}.memgraph button,.memgraph input,.memgraph select{font:inherit}',
      '.memgraph .graph-controls{position:absolute;right:12px;top:12px;width:240px;max-width:calc(100% - 24px);padding:0;overflow:auto;background:var(--menu-background);border-radius:8px;z-index:3}',
      '.memgraph .graph-controls:not(.is-close){max-height:calc(100% - 16px);border:var(--menu-border-width) solid var(--menu-border-color);box-shadow:0 2px 8px #0002}.memgraph .graph-controls::-webkit-scrollbar{display:none}',
      '.memgraph .graph-controls.is-close{width:auto;background:var(--menu-background);border:1px solid transparent;padding:6px}.memgraph .graph-controls.is-close .graph-control-section{display:none}',
      '.memgraph .clickable-icon{display:flex;align-items:center;justify-content:center;border:0;border-radius:4px;padding:4px;background:transparent;color:var(--label-tertiary);cursor:pointer}.memgraph .clickable-icon:hover{background:var(--hover-background)}',
      '.memgraph .clickable-icon svg{width:18px;height:18px;stroke-width:1.7}.memgraph .graph-controls-button{display:none}.memgraph .graph-controls.is-close .mod-open,.memgraph .graph-controls.is-close .mod-animate{display:flex}.memgraph .mod-animate{margin-top:8px}',
      '.memgraph .graph-controls:not(.is-close) .mod-close,.memgraph .graph-controls:not(.is-close) .mod-reset{display:flex;position:absolute;top:6px;right:8px;z-index:1}.memgraph .graph-controls:not(.is-close) .mod-reset{right:36px}',
      '.memgraph .graph-control-section{padding:6px 12px;border-bottom:1px solid var(--menu-border-color)}.memgraph .graph-control-section:last-child{border-bottom:0}.memgraph .graph-control-section:last-child .tree-item-children{padding-bottom:16px}',
      '.memgraph .tree-item-self{display:flex;align-items:center;width:100%;padding:4px 0;border:0;background:none;color:var(--graph-text);cursor:pointer;text-align:left;font-weight:500;gap:6px}.memgraph .tree-item-self svg{width:12px;height:12px;flex-shrink:0;color:var(--label-tertiary)}',
      '.memgraph .tree-item-children{padding:4px 0}.memgraph .setting-item{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 0;margin-bottom:4px}.memgraph .setting-item-name{font-size:14px}',
      '.memgraph .setting-item.mod-slider{display:block}.memgraph .setting-item-control{display:flex;align-items:center;gap:10px}.memgraph .mod-slider .setting-item-control{padding-top:12px;width:100%}.memgraph .mod-slider output{font-variant-numeric:tabular-nums;min-width:28px}',
      '.memgraph input[type=range]{appearance:none;width:100%;height:4px;background:var(--track-color);border-radius:4px;cursor:pointer;margin:8px 0;accent-color:var(--interactive-accent)}.memgraph input[type=range]::-webkit-slider-thumb{appearance:none;width:30px;height:18px;border:0;border-radius:20px;background:#fff;box-shadow:0 1px 5px #0003}.memgraph input[type=range]::-moz-range-thumb{width:30px;height:18px;border:0;border-radius:20px;background:#fff}',
      '.memgraph .checkbox-container{position:relative;width:36px;height:16px;border-radius:20px;background:var(--track-color);flex-shrink:0;cursor:pointer}.memgraph .checkbox-container.is-enabled{background:var(--interactive-accent)}.memgraph .checkbox-container:after{content:"";position:absolute;top:2px;left:2px;width:20px;height:12px;border-radius:12px;background:#fff;pointer-events:none}.memgraph .checkbox-container.is-enabled:after{left:14px}.memgraph .checkbox-container input{opacity:0;width:100%;height:100%;margin:0;cursor:pointer}',
      '.memgraph input[type=text],.memgraph input[type=search],.memgraph select{min-width:0;width:100%;height:30px;border:1px solid var(--menu-border-color);border-radius:5px;background:var(--field-background);color:var(--graph-text);padding:4px 8px;outline:none}.memgraph input::placeholder{color:var(--label-tertiary)}',
      '.memgraph .search-input-container{position:relative;width:100%}.memgraph .search-input-container input{border-radius:18px;padding-left:30px}.memgraph .search-input-container svg{position:absolute;left:9px;top:7px;width:16px;height:16px;color:var(--label-tertiary)}',
      '.memgraph .graph-color-group{display:flex;align-items:center;padding-bottom:6px;gap:0}.memgraph .graph-color-group input[type=color]{appearance:none;width:18px;height:18px;flex-shrink:0;border:0;padding:0;margin:0 2px 0 6px;background:none;cursor:pointer}.memgraph input[type=color]::-webkit-color-swatch-wrapper{padding:0}.memgraph input[type=color]::-webkit-color-swatch{border:0;border-radius:50%}',
      '.memgraph .graph-color-group .clickable-icon{padding:4px}.memgraph .graph-color-group .clickable-icon svg{width:14px;height:14px}.memgraph .graph-color-button-container{margin:6px 0 10px}.memgraph .mod-cta{border:0;border-radius:6px;background:var(--interactive-accent);color:#ffffff;padding:6px 12px;font-weight:600;cursor:pointer}.memgraph .graph-color-button-container .mod-cta{width:100%}',
      '.memgraph .mod-playback{justify-content:flex-end}.memgraph .graph-message{position:absolute;left:20px;right:20px;top:45%;text-align:center;color:var(--label-tertiary);pointer-events:none}.memgraph .graph-message.error{color:var(--error-color)}',
    ].join('')

    async function post(payload) {
      const response = await fetch('obsidian-mem/graph', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const envelope = await response.json()
      if (!response.ok || envelope.ok !== true)
        throw new Error(envelope.error?.message ?? '图谱暂不可用')
      return envelope.value
    }

    function icon(name) {
      const paths = {
        settings:
          'M9.2 3.4h5.6l.6 2.4 2 1.2 2.4-.6 2.8 4.8-1.8 1.8v2.3l1.8 1.8-2.8 4.8-2.4-.6-2 1.2-.6 2.4H9.2l-.6-2.4-2-1.2-2.4.6-2.8-4.8 1.8-1.8V11l-1.8-1.8 2.8-4.8 2.4.6 2-1.2z',
        wand: 'M15 4l5 5M4 20l16-16-4-4L0 16zM20 15v4M18 17h4M5 2v4M3 4h4',
        reset: 'M3 11a9 9 0 1 1 3 7M3 3v8h8',
        close: 'M6 6l12 12M6 18L18 6',
        search: 'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
        down: 'M6 9l6 6 6-6',
        right: 'M9 6l6 6-6 6',
      }
      return h(
        'svg',
        {
          viewBox: name === 'settings' ? '0 0 24 28' : '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        h('path', { d: paths[name] }),
        name === 'settings' && h('circle', { cx: 12, cy: 14, r: 3 }),
      )
    }

    function matches(node, query) {
      const branches = query.toLowerCase().split(/\s+OR\s+/i)
      return branches.some((branch) => {
        const terms = branch.match(/\[[^\]]+\]|(?:[^\s"]+|"[^"]*")+/g) ?? []
        return terms.every((term) => {
          const negative = term.startsWith('-')
          term = (negative ? term.slice(1) : term)
            .replace(/^\[|\]$/g, '')
            .replace(/"/g, '')
            .trim()
          const colon = term.indexOf(':')
          const field = colon < 0 ? '' : term.slice(0, colon)
          const value = (colon < 0 ? term : term.slice(colon + 1)).trim()
          const text =
            field === 'type'
              ? node.type
              : field === 'tag'
                ? (node.tags ?? []).join(' ')
                : field === 'path'
                  ? node.path
                  : field === 'file'
                    ? node.path.split('/').pop()
                    : node.title + ' ' + node.path
          const found = String(text).toLowerCase().includes(value)
          return negative ? !found : found
        })
      })
    }

    function GraphCanvas({ graph, display, forces, groups, active, visible, onError }) {
      const ref = React.useRef(null)
      const state = React.useRef({ renderer: null, model: null, forces: null })
      const styling = React.useMemo(() => {
        const degree = new Map()
        for (const edge of graph.edges) {
          degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1)
          degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1)
        }
        const colors = new Map(
          graph.nodes.map((node) => [
            node.id,
            groups.find((group) => group.query.trim() && matches(node, group.query))?.color,
          ]),
        )
        return { degree, colors }
      }, [graph, groups])
      state.current.model = { graph, display, active, ...styling }
      state.current.forces = {
        centerStrength: forceValue(forces.center),
        repelStrength: forces.repel ** 3,
        linkStrength: forceValue(forces.link),
        linkDistance: forces.distance,
      }
      React.useEffect(() => {
        if (!visible) return undefined
        let cancelled = false
        let renderer
        void import('/obsidian-mem/graph-renderer.js')
          .then(({ createGraphRenderer }) => {
            if (cancelled) return
            renderer = createGraphRenderer(ref.current, onError)
            state.current.renderer = renderer
            renderer.update(state.current.model)
            renderer.setForces(state.current.forces)
          })
          .catch(() => {
            if (!cancelled) onError('图谱渲染暂不可用')
          })
        return () => {
          cancelled = true
          renderer?.destroy()
          state.current.renderer = null
        }
      }, [visible])
      React.useEffect(() => {
        state.current.renderer?.update(state.current.model)
      }, [graph, display, active, styling])
      React.useEffect(() => {
        state.current.renderer?.setForces(state.current.forces)
      }, [forces])
      return h('canvas', { ref, role: 'img', tabIndex: 0, 'aria-label': '可缩放的记忆关系图谱' })
    }

    function GraphView({ sessionId, visible }) {
      const [scope, setScope] = React.useState('all')
      const [graph, setGraph] = React.useState({ nodes: [], edges: [], total: 0 })
      const [error, setError] = React.useState('')
      const [active, setActive] = React.useState([])
      const [open, setOpen] = React.useState(false)
      const [expanded, setExpanded] = React.useState({})
      const [filter, setFilter] = React.useState(FILTER)
      const [groups, setGroups] = React.useState(initialGroups)
      const [display, setDisplay] = React.useState(DISPLAY)
      const [forces, setForces] = React.useState(FORCES)
      const [progression, setProgression] = React.useState(null)
      const cursor = React.useRef(0)
      React.useEffect(() => {
        if (!visible || !sessionId) return undefined
        let cancelled = false
        let loading = false
        const load = async () => {
          if (loading) return
          loading = true
          try {
            const value = await post({ sessionId, scope, action: 'snapshot' })
            if (!cancelled) {
              setGraph((previous) =>
                JSON.stringify(previous) === JSON.stringify(value) ? previous : value,
              )
              setError('')
            }
          } catch (cause) {
            if (!cancelled) setError(cause.message)
          } finally {
            loading = false
          }
        }
        void load()
        const timer = setInterval(load, 15000)
        return () => {
          cancelled = true
          clearInterval(timer)
        }
      }, [sessionId, scope, visible])
      React.useEffect(() => {
        cursor.current = 0
        setActive([])
      }, [sessionId])
      React.useEffect(() => {
        if (!visible || !sessionId) return undefined
        let cancelled = false
        let polling = false
        const poll = async () => {
          if (polling) return
          polling = true
          try {
            const value = await post({ sessionId, action: 'activity', cursor: cursor.current })
            if (cancelled) return
            cursor.current = value.cursor
            if (value.events.length)
              setActive((previous) =>
                [...previous, ...value.events]
                  .filter((event) => Date.now() - event.at < 3600)
                  .slice(-80),
              )
          } catch {
            /* Temporary activity failure does not invalidate a graph snapshot. */
          } finally {
            polling = false
          }
        }
        void poll()
        const timer = setInterval(poll, 700)
        return () => {
          cancelled = true
          clearInterval(timer)
        }
      }, [sessionId, visible])
      React.useEffect(() => {
        if (progression === null) return undefined
        const timer = setTimeout(
          () => setProgression((value) => (value + 1 >= graph.nodes.length ? null : value + 1)),
          50,
        )
        return () => clearTimeout(timer)
      }, [progression, graph.nodes.length])
      const filtered = React.useMemo(() => {
        let nodes = graph.nodes.filter(
          (node) =>
            matches(node, filter.search) && (!filter.existing || node.type !== 'unresolved'),
        )
        if (progression !== null) nodes = nodes.slice(0, progression)
        let ids = new Set(nodes.map((node) => node.id))
        let edges = graph.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target))
        if (filter.tags) {
          const tags = new Map()
          for (const node of nodes)
            for (const tag of node.tags ?? []) {
              const id = 'tag:' + tag
              tags.set(id, { id, path: '#' + tag, title: '#' + tag, type: 'tag' })
              edges.push({ source: node.id, target: id })
            }
          nodes = [...nodes, ...tags.values()]
        }
        if (!filter.orphans) {
          ids = new Set(edges.flatMap((edge) => [edge.source, edge.target]))
          nodes = nodes.filter((node) => ids.has(node.id))
        }
        return { nodes, edges }
      }, [graph, filter, progression])
      const button = (name, label, callback, cls) =>
        h(
          'button',
          {
            key: name,
            type: 'button',
            className: 'clickable-icon ' + cls,
            title: label,
            'aria-label': label,
            onClick: callback,
          },
          icon(name),
        )
      const section = (id, label, content) =>
        h(
          'div',
          { key: id, className: 'graph-control-section mod-' + id },
          h(
            'button',
            {
              className: 'tree-item-self',
              type: 'button',
              'aria-expanded': !!expanded[id],
              onClick: () => setExpanded((value) => ({ ...value, [id]: !value[id] })),
            },
            icon(expanded[id] ? 'down' : 'right'),
            h('span', { className: 'graph-control-section-header' }, label),
          ),
          expanded[id] && h('div', { className: 'tree-item-children' }, content),
        )
      const toggle = (label, checked, change, disabled = false) =>
        h(
          'label',
          { key: label, className: 'setting-item mod-toggle' },
          h('span', { className: 'setting-item-name' }, label),
          h(
            'span',
            { className: 'checkbox-container' + (checked ? ' is-enabled' : '') },
            h('input', {
              type: 'checkbox',
              checked,
              disabled,
              'aria-label': label,
              onChange: (event) => change(event.target.checked),
            }),
          ),
        )
      const slider = (label, field, state, change, min, max, step = 'any') =>
        h(
          'label',
          { key: label, className: 'setting-item mod-slider' },
          h('span', { className: 'setting-item-name' }, label),
          h(
            'span',
            { className: 'setting-item-control' },
            h('output', null, step === 1 ? String(state[field]) : state[field].toFixed(2)),
            h('input', {
              type: 'range',
              min,
              max,
              step,
              value: state[field],
              'aria-label': label,
              onChange: (event) =>
                change((previous) => ({ ...previous, [field]: Number(event.target.value) })),
            }),
          ),
        )
      const play = () => setProgression(0)
      const reset = () => {
        setFilter(FILTER)
        setGroups(initialGroups())
        setDisplay(DISPLAY)
        setForces(FORCES)
      }
      return h(
        'div',
        { className: 'memgraph' },
        h('style', null, styles),
        h(GraphCanvas, {
          key: sessionId + ':' + scope,
          graph: filtered,
          display,
          forces,
          groups,
          active,
          visible,
          onError: setError,
        }),
        h(
          'div',
          {
            className: 'graph-controls' + (open ? '' : ' is-close'),
            role: 'region',
            'aria-label': '图谱设置',
          },
          button('close', '关闭', () => setOpen(false), 'graph-controls-button mod-close'),
          button('settings', '打开图谱设置', () => setOpen(true), 'graph-controls-button mod-open'),
          button('wand', '开始播放动画', play, 'graph-controls-button mod-animate'),
          button('reset', '恢复默认设置', reset, 'graph-controls-button mod-reset'),
          section('filter', '筛选', [
            h(
              'div',
              { className: 'setting-item mod-search-setting', key: 'search' },
              h(
                'div',
                { className: 'search-input-container' },
                icon('search'),
                h('input', {
                  type: 'search',
                  placeholder: '搜索文件…',
                  value: filter.search,
                  'aria-label': '搜索文件',
                  onChange: (event) =>
                    setFilter((value) => ({ ...value, search: event.target.value })),
                }),
              ),
            ),
            toggle('标签', filter.tags, (tags) => setFilter((value) => ({ ...value, tags }))),
            toggle('附件', false, () => {}, true),
            toggle('仅显示已创建的笔记', filter.existing, (existing) =>
              setFilter((value) => ({ ...value, existing })),
            ),
            toggle('孤立文件', filter.orphans, (orphans) =>
              setFilter((value) => ({ ...value, orphans })),
            ),
            h(
              'label',
              { className: 'setting-item', key: 'scope' },
              h('span', { className: 'setting-item-name' }, '范围'),
              h(
                'select',
                {
                  value: scope,
                  style: { width: 108 },
                  'aria-label': '图谱范围',
                  onChange: (event) => setScope(event.target.value),
                },
                h('option', { value: 'all' }, '全部记忆'),
                h('option', { value: 'project' }, '当前项目'),
              ),
            ),
          ]),
          section('color-groups', '颜色组', [
            ...groups.map((group, index) =>
              h(
                'div',
                {
                  key: index,
                  className: 'graph-color-group',
                  draggable: true,
                  onDragStart: (event) => event.dataTransfer.setData('text/plain', String(index)),
                  onDragOver: (event) => event.preventDefault(),
                  onDrop: (event) => {
                    event.preventDefault()
                    const from = Number(event.dataTransfer.getData('text/plain'))
                    if (!Number.isInteger(from) || from < 0 || from >= groups.length) return
                    setGroups((value) => {
                      const next = [...value]
                      next.splice(index, 0, ...next.splice(from, 1))
                      return next
                    })
                  },
                },
                h('input', {
                  type: 'text',
                  value: group.query,
                  placeholder: '输入查询…',
                  'aria-label': '颜色组查询 ' + (index + 1),
                  onChange: (event) =>
                    setGroups((value) =>
                      value.map((item, i) =>
                        i === index ? { ...item, query: event.target.value } : item,
                      ),
                    ),
                }),
                h('input', {
                  type: 'color',
                  value: group.color,
                  title: '点击更换颜色，拖动调整顺序',
                  'aria-label': '颜色组颜色 ' + (index + 1),
                  onChange: (event) =>
                    setGroups((value) =>
                      value.map((item, i) =>
                        i === index ? { ...item, color: event.target.value } : item,
                      ),
                    ),
                }),
                button(
                  'close',
                  '删除颜色组 ' + (index + 1),
                  () => setGroups((value) => value.filter((_, i) => i !== index)),
                  '',
                ),
              ),
            ),
            h(
              'div',
              { key: 'new', className: 'graph-color-button-container' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'mod-cta',
                  onClick: () => setGroups((value) => [...value, { query: '', color: '#8a5cf5' }]),
                },
                '新建颜色组',
              ),
            ),
          ]),
          section('display', '外观', [
            toggle('箭头', display.arrows, (arrows) =>
              setDisplay((value) => ({ ...value, arrows })),
            ),
            slider('文本透明度', 'text', display, setDisplay, -3, 3, 0.1),
            slider('标题文字大小', 'label', display, setDisplay, 0.4, 1.6, 0.05),
            slider('节点大小', 'size', display, setDisplay, 0.1, 5),
            slider('连线粗细', 'width', display, setDisplay, 0.1, 5),
            h(
              'div',
              { className: 'setting-item mod-playback', key: 'play' },
              h('button', { type: 'button', className: 'mod-cta', onClick: play }, '播放动画'),
            ),
          ]),
          section('forces', '力度', [
            slider('图谱向心力', 'center', forces, setForces, 0, 1),
            slider('节点间的排斥力', 'repel', forces, setForces, 0, 20),
            slider('相连节点间的吸引力', 'link', forces, setForces, 0, 1),
            slider('连线长度', 'distance', forces, setForces, 30, 500, 1),
          ]),
        ),
        error && h('div', { className: 'graph-message error', role: 'status' }, error),
        !error &&
          graph.nodes.length === 0 &&
          h(
            'div',
            { className: 'graph-message', role: 'status' },
            !sessionId
              ? '打开一个会话以查看记忆图谱'
              : graph.unbound
                ? '当前项目尚未绑定记忆'
                : '暂无记忆',
          ),
      )
    }

    return {
      inject: ['betterSidebar'],
      apply(ctx) {
        ctx.effect(() =>
          ctx.betterSidebar.registerTab({
            id: 'obsidian-mem:graph',
            title: '记忆图谱',
            icon: (size) =>
              h(
                'svg',
                {
                  width: size,
                  height: size,
                  viewBox: '0 0 24 24',
                  fill: 'none',
                  stroke: 'currentColor',
                  strokeWidth: 1.7,
                },
                h('path', { d: 'M6 9v6M8.6 7.5l6.8 4M8.6 16.5l6.8-4' }),
                ...[
                  [6, 6],
                  [6, 18],
                  [18, 12],
                ].map(([cx, cy]) => h('circle', { key: cx + ':' + cy, cx, cy, r: 3 })),
              ),
            order: 35,
            single: true,
            component: (props) =>
              h(GraphView, { sessionId: props.scope?.sessionId, visible: props.visible }),
          }),
        )
      },
    }
  },
})
