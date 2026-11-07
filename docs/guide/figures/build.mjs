// Build the hand-laid diagrams for docs/guide.
//
// Run: node docs/guide/figures/build.mjs
//
// The generator measures text before it draws, so a label that does not fit
// fails the build instead of overlapping its neighbour. Every figure uses the
// same palette, type scale and arrow style.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = HERE

const INK = '#1e293b'
const MUTED = '#64748b'
const ACCENT = '#4f46e5'
const ACCENT_BG = '#eef2ff'
const SURFACE = '#f8fafc'
const BORDER = '#cbd5e1'
const WARM = '#fff7ed'
const WARM_BORDER = '#f59e0b'
const WHITE = '#ffffff'

const FONT =
  "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Noto Sans CJK SC', 'Microsoft YaHei', sans-serif"

const esc = (s) =>
  String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')

function charWidth(ch) {
  if (/[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]/u.test(ch)) return 1
  if (ch === ' ') return 0.3
  if (/[A-Z]/.test(ch)) return 0.64
  if (/[a-z0-9]/.test(ch)) return 0.56
  if ('.,:;!?/()[]{}<>|`~-'.includes(ch)) return 0.34
  return 0.5
}

function measure(text, size) {
  let width = 0
  for (const ch of text) width += charWidth(ch) * size
  return width
}

function wrap(text, maxWidth, size) {
  const out = []
  for (const raw of String(text).split('\n')) {
    if (raw === '') {
      out.push('')
      continue
    }
    let line = ''
    for (const ch of raw) {
      const next = line + ch
      if (line !== '' && measure(next, size) > maxWidth) {
        out.push(line.trimEnd())
        line = ch === ' ' ? '' : ch
      } else {
        line = next
      }
    }
    if (line !== '') out.push(line.trimEnd())
  }
  return out
}

function text({ x, y, value, size = 14, weight = 400, color = INK, anchor = 'start', opacity = 1 }) {
  return `<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${color}" text-anchor="${anchor}" opacity="${opacity}">${esc(value)}</text>`
}

function roundRect({ x, y, w, h, fill = WHITE, stroke = BORDER, rx = 10, dash = null, width = 1.2 }) {
  const dashAttr = dash === null ? '' : ` stroke-dasharray="${dash}"`
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${fill}" stroke="${stroke}" stroke-width="${width}"${dashAttr}/>`
}

/**
 * Draw a titled box. The box refuses to render when its text does not fit.
 */
function box({
  x,
  y,
  w,
  h,
  title = '',
  sub = [],
  fill = WHITE,
  stroke = BORDER,
  titleSize = 15,
  subSize = 12.5,
  align = 'center',
  dash = null,
  width = 1.2,
  titleColor = INK,
  subColor = MUTED,
}) {
  const pad = 14
  const lh = subSize + 6
  const subLines = sub.flatMap((line) => wrap(line, w - pad * 2, subSize))
  const titleHeight = title === '' ? 0 : titleSize + 6
  const total = titleHeight + subLines.length * lh
  if (total > h - 12) {
    throw new Error(`box does not fit: ${title || sub[0]} needs ${total}, has ${h - 12}`)
  }
  let cursor
  if (align === 'top') cursor = y + 16
  else cursor = y + (h - total) / 2

  const parts = [roundRect({ x, y, w, h, fill, stroke, dash, width })]
  if (title !== '') {
    parts.push(
      text({
        x: x + w / 2,
        y: cursor + titleSize,
        value: title,
        size: titleSize,
        weight: 650,
        color: titleColor,
        anchor: 'middle',
      }),
    )
    cursor += titleSize + 6
  }
  for (const line of subLines) {
    parts.push(
      text({
        x: x + w / 2,
        y: cursor + subSize,
        value: line,
        size: subSize,
        color: subColor,
        anchor: 'middle',
      }),
    )
    cursor += lh
  }
  return parts.join('')
}

function label({ x, y, value, size = 12, color = MUTED, anchor = 'middle', bg = WHITE, weight = 500 }) {
  const width = measure(value, size) + 10
  const height = size + 8
  const left = anchor === 'middle' ? x - width / 2 : anchor === 'end' ? x - width : x
  return [
    `<rect x="${left}" y="${y - size - 1}" width="${width}" height="${height}" rx="5" fill="${bg}" opacity="0.96"/>`,
    text({ x, y, value, size, color, anchor, weight }),
  ].join('')
}

function arrow({ points, dashed = false, color = MUTED, marker = true, width = 1.6 }) {
  const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p[0]} ${p[1]}`).join(' ')
  const dashAttr = dashed ? ' stroke-dasharray="6 5"' : ''
  const end = marker ? ' marker-end="url(#arrow)"' : ''
  return `<path d="${d}" fill="none" stroke="${color}" stroke-width="${width}"${dashAttr}${end}/>`
}

function circle({ x, y, r = 14, fill = ACCENT_BG, stroke = ACCENT, n = null, size = 12 }) {
  const parts = [`<circle cx="${x}" cy="${y}" r="${r}" fill="${fill}" stroke="${stroke}" stroke-width="1.4"/>`]
  if (n !== null) {
    parts.push(text({ x, y: y + size * 0.36, value: n, size, weight: 650, color: ACCENT, anchor: 'middle' }))
  }
  return parts.join('')
}

function svg(width, height, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img">
<defs>
  <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
    <path d="M 0 0 L 10 5 L 0 10 z" fill="${MUTED}"/>
  </marker>
</defs>
<rect width="${width}" height="${height}" fill="${WHITE}"/>
<style>text { font-family: ${FONT}; }</style>
${body}
</svg>
`
}

// ---------------------------------------------------------------------------
// Figure 1: the three places
// ---------------------------------------------------------------------------
function overview() {
  const w = 1200
  const h = 450
  const parts = []

  parts.push(text({ x: 50, y: 46, value: '你的代码仓库', size: 18, weight: 650 }))
  parts.push(box({ x: 50, y: 76, w: 280, h: 120, title: '.obsidian-mem', sub: ['projectId', 'slug', 'displayName', 'schema: 1'], fill: ACCENT_BG, stroke: ACCENT, align: 'top' }))
  parts.push(box({ x: 50, y: 220, w: 280, h: 90, title: '源码', sub: ['README / 构建配置'], fill: WHITE, align: 'top' }))

  parts.push(text({ x: 440, y: 46, value: 'DSH 宿主进程', size: 18, weight: 650 }))
  parts.push(box({ x: 440, y: 76, w: 320, h: 230, title: 'obsidian-mem 插件', sub: ['六个 mem_* 工具', '会话钩子：简报 / 检索', '捕获 → 蒸馏 → 整理', '事务写入'], fill: SURFACE, align: 'top', titleSize: 16 }))
  parts.push(box({ x: 440, y: 346, w: 320, h: 70, title: '模型路由', sub: ['只在蒸馏时调用'], fill: WHITE, titleSize: 14 }))

  parts.push(text({ x: 880, y: 46, value: 'Obsidian vault（本地目录）', size: 16, weight: 650 }))
  parts.push(box({ x: 880, y: 76, w: 270, h: 230, title: 'Projects/<slug>--<id8>/', sub: ['Docs/', 'Decisions/', 'Conventions/', 'Pitfalls/', 'Daily/', 'Inbox/', '_meta/hot.md'], fill: WHITE, align: 'top', titleSize: 13.5, subSize: 12.5 }))

  parts.push(arrow({ points: [[330, 136], [440, 136]] }))
  parts.push(label({ x: 385, y: 126, value: 'projectId', size: 11.5 }))
  parts.push(arrow({ points: [[760, 240], [880, 240]] }))
  parts.push(label({ x: 820, y: 230, value: '写 Markdown', size: 11.5 }))
  parts.push(arrow({ points: [[600, 306], [600, 346]] }))
  parts.push(label({ x: 690, y: 332, value: '蒸馏调用', size: 11.5 }))

  return svg(w, h, parts.join('\n'))
}

// ---------------------------------------------------------------------------
// Figure 2: layers
// ---------------------------------------------------------------------------
function layers() {
  const w = 1200
  const h = 790
  const parts = []

  parts.push(text({ x: 50, y: 26, value: '依赖只能向下', size: 13, weight: 600, color: MUTED }))
  parts.push(arrow({ points: [[70, 42], [70, 748]] }))

  const band = (y, height, name, fill = SURFACE) => {
    parts.push(roundRect({ x: 130, y, w: 1020, h: height, fill, stroke: BORDER, rx: 12, width: 1 }))
    parts.push(`<line x1="236" y1="${y + 12}" x2="236" y2="${y + height - 12}" stroke="${BORDER}" stroke-width="1" stroke-dasharray="3 4"/>`)
    const lines = name.split('\n')
    const baseY = y + height / 2 - ((lines.length - 1) * 18) / 2 + 5
    lines.forEach((line, i) => {
      parts.push(text({ x: 183, y: baseY + i * 18, value: line, size: 13.5, weight: 650, color: MUTED, anchor: 'middle' }))
    })
  }

  band(40, 64, '宿主 API')
  parts.push(text({ x: 255, y: 78, value: "ctx.tools · ctx.on · ctx.get('llm')", size: 13.5, color: MUTED }))

  band(122, 92, '入口\nL10 / L9')
  parts.push(box({ x: 255, y: 140, w: 420, h: 56, title: 'index.js', sub: ['装配：配置、服务、工具、钩子'], titleSize: 14, subSize: 12 }))
  parts.push(box({ x: 695, y: 140, w: 420, h: 56, title: 'tools.js', sub: ['稳定对外导出面'], titleSize: 14, subSize: 12 }))

  band(232, 126, '编排\nL8 / L7')
  parts.push(box({ x: 255, y: 256, w: 280, h: 78, title: 'services.js', sub: ['六个工具的服务'], titleSize: 14, subSize: 12 }))
  parts.push(box({ x: 550, y: 256, w: 280, h: 78, title: 'hooks.js', sub: ['会话事件与注入'], titleSize: 14, subSize: 12 }))
  parts.push(box({ x: 845, y: 256, w: 280, h: 78, title: 'brief.js', sub: ['预算内组装简报'], titleSize: 14, subSize: 12 }))

  band(376, 156, '领域\nL5 / L6')
  const domain = [
    ['memory.js', '笔记与取代'],
    ['vault.js', '绑定与注册表'],
    ['capture.js', '队列与重试'],
    ['hot.js', '热层与归档'],
    ['curation', '整理与提案'],
  ]
  domain.forEach(([title, sub], i) => {
    parts.push(box({ x: 255 + i * 180, y: 406, w: 170, h: 96, title, sub: [sub], titleSize: 13, subSize: 11.5 }))
  })

  band(550, 116, '基础\nL0–L4')
  const base = [
    ['transaction.js', '锁与恢复'],
    ['search / index-db', '检索与索引'],
    ['frontmatter / pointer', '解析与路径'],
    ['note-style.js', '语言规则'],
  ]
  base.forEach(([title, sub], i) => {
    parts.push(box({ x: 255 + i * 210, y: 573, w: 195, h: 70, title, sub: [sub], titleSize: 12.5, subSize: 11.5 }))
  })

  band(684, 86, '存储', '#f1f5f9')
  const storage = [
    ['vault Markdown', '事实来源'],
    ['SQLite 索引', '可重建缓存'],
    ['数据根', '锁 / 队列 / 回执'],
  ]
  storage.forEach(([title, sub], i) => {
    parts.push(box({ x: 255 + i * 300, y: 703, w: 280, h: 50, title, sub: [sub], titleSize: 12.5, subSize: 11.5 }))
  })

  for (const y of [210, 364, 538, 666]) {
    parts.push(arrow({ points: [[600, y], [600, y + 12]] }))
  }

  parts.push(text({ x: 1170, y: 782, value: '简化视图：真实层号 0–12，59 个模块', size: 11.5, color: MUTED, anchor: 'end' }))
  return svg(w, h, parts.join('\n'))
}

// ---------------------------------------------------------------------------
// Figure 3: write path
// ---------------------------------------------------------------------------
function writePath() {
  const w = 1200
  const h = 640
  const parts = []
  const steps = [
    { n: 1, title: '解析绑定', sub: 'mode: show', x: 55, y: 60 },
    { n: 2, title: '取整仓锁', sub: '超时 15 秒', x: 340, y: 60 },
    { n: 3, title: '快照旧字节', sub: '写入 .history/', x: 625, y: 60 },
    { n: 4, title: '预检并计算', sub: '读取、哈希、最终字节', x: 910, y: 60 },
    { n: 5, title: '发布新字节', sub: 'link / rename', x: 910, y: 285 },
    { n: 6, title: '写回执', sub: '提交点 steps.receipted', x: 625, y: 285 },
    { n: 7, title: '通知索引', sub: '失败不回滚提交', x: 340, y: 285 },
    { n: 8, title: '释放锁', sub: '事务结束', x: 55, y: 285 },
  ]
  for (const step of steps) {
    parts.push(box({ x: step.x, y: step.y, w: 235, h: 92, title: step.title, sub: [step.sub], fill: WHITE, align: 'top', titleSize: 14, subSize: 11.5 }))
    parts.push(circle({ x: step.x + 18, y: step.y + 18, r: 12, n: step.n, size: 11 }))
  }
  parts.push(arrow({ points: [[290, 106], [340, 106]] }))
  parts.push(arrow({ points: [[575, 106], [625, 106]] }))
  parts.push(arrow({ points: [[860, 106], [910, 106]] }))
  parts.push(arrow({ points: [[1027, 152], [1027, 285]] }))
  parts.push(arrow({ points: [[910, 331], [860, 331]] }))
  parts.push(arrow({ points: [[625, 331], [575, 331]] }))
  parts.push(arrow({ points: [[340, 331], [290, 331]] }))

  parts.push(text({ x: 55, y: 430, value: '失败分支', size: 13, weight: 650, color: MUTED }))
  parts.push(box({ x: 55, y: 448, w: 340, h: 92, title: '提交点之前', sub: ['回滚已发布目标', '外部编辑则转人工'], fill: WARM, stroke: WARM_BORDER, titleSize: 13, subSize: 11.5 }))
  parts.push(box({ x: 430, y: 448, w: 340, h: 92, title: '提交点之后', sub: ['索引失败只记录', 'vault 写入已生效'], fill: SURFACE, titleSize: 13, subSize: 11.5 }))
  parts.push(box({ x: 805, y: 448, w: 340, h: 92, title: '崩溃恢复', sub: ['下次写入前运行', '按清单状态前进或回退'], fill: SURFACE, titleSize: 13, subSize: 11.5 }))
  parts.push(text({ x: 55, y: 585, value: '提交点 = 回执写入。它是全有或全无的分界。', size: 12.5, color: MUTED }))
  return svg(w, h, parts.join('\n'))
}

// ---------------------------------------------------------------------------
// Figure 4: triage lane
// ---------------------------------------------------------------------------
function troubleshoot() {
  const w = 1200
  const h = 720
  const parts = []
  const rows = [
    ['mem_* 工具存在吗？', '查 --dump-config；重启宿主；新建会话'],
    ['项目已绑定吗？', '看 reason：bind / 新会话 / 报告'],
    ['简报正常吗？', '查 injectBrief；hot status；预算'],
    ['检索正常吗？', '查 index 状态；rebuild；scope'],
    ['写入正常吗？', '按拒绝码处理（见 09 第五节）'],
    ['蒸馏 / 整理正常吗？', '查 autoCapture；dryRun；jobs；路由'],
  ]
  const startY = 60
  const gap = 92
  rows.forEach(([question, answer], i) => {
    const y = startY + i * gap
    parts.push(box({ x: 350, y, w: 330, h: 62, title: question, fill: ACCENT_BG, stroke: ACCENT, titleSize: 13.5 }))
    parts.push(circle({ x: 320, y: y + 31, r: 15, n: i + 1, size: 12 }))
    parts.push(arrow({ points: [[680, y + 31], [800, y + 31]] }))
    parts.push(label({ x: 740, y: y + 22, value: '否', size: 11, bg: WHITE }))
    parts.push(box({ x: 800, y, w: 340, h: 62, title: answer, fill: WHITE, titleSize: 12.5 }))
    if (i < rows.length - 1) {
      parts.push(arrow({ points: [[515, y + 62], [515, y + gap]] }))
      parts.push(label({ x: 528, y: y + 76, value: '是', size: 10.5, anchor: 'start', bg: WHITE }))
    }
  })
  const last = startY + (rows.length - 1) * gap
  parts.push(arrow({ points: [[515, last + 62], [515, last + 96]] }))
  parts.push(box({ x: 350, y: last + 96, w: 790, h: 62, title: '都正常：mem_admin(action="diagnostics") → 生成报告', fill: SURFACE, titleSize: 13 }))
  parts.push(text({ x: 50, y: 700, value: '每一步的“否”都给出一个可执行动作；不要在未确认绑定时改索引或热层。', size: 12, color: MUTED }))
  return svg(w, h, parts.join('\n'))
}

// ---------------------------------------------------------------------------
// Figure 5: job states
// ---------------------------------------------------------------------------
function jobStates() {
  const w = 1200
  const h = 540
  const parts = []
  parts.push(box({ x: 50, y: 90, w: 170, h: 70, title: '回合完成', sub: ['turn/end'], fill: WARM, stroke: WARM_BORDER, titleSize: 13.5, subSize: 11.5 }))
  parts.push(box({ x: 280, y: 90, w: 190, h: 70, title: 'pending', sub: ['等待空闲窗口'], titleSize: 14 }))
  parts.push(box({ x: 550, y: 90, w: 190, h: 70, title: 'distilling', sub: ['调用模型'], titleSize: 14 }))
  parts.push(box({ x: 820, y: 90, w: 210, h: 70, title: '完成（applied）', sub: ['校验通过并写入'], titleSize: 13.5 }))

  parts.push(arrow({ points: [[220, 125], [280, 125]] }))
  parts.push(label({ x: 250, y: 115, value: '捕获', size: 10.5 }))
  parts.push(arrow({ points: [[470, 125], [550, 125]] }))
  parts.push(label({ x: 510, y: 115, value: '空闲 90 秒', size: 10.5 }))
  parts.push(arrow({ points: [[740, 125], [820, 125]] }))
  parts.push(label({ x: 780, y: 115, value: '校验通过', size: 10.5 }))

  parts.push(box({ x: 400, y: 310, w: 220, h: 86, title: 'deferred', sub: ['无路由 / 无绑定', '每个空闲窗口重试'], titleSize: 13.5 }))
  parts.push(box({ x: 740, y: 310, w: 220, h: 86, title: 'failed', sub: ['达到 maxRetries', '终态；可显式 retry'], titleSize: 13.5 }))

  parts.push(arrow({ points: [[590, 160], [510, 310]] }))
  parts.push(label({ x: 520, y: 238, value: '无路由 / 无绑定', size: 10.5, anchor: 'end' }))
  parts.push(arrow({ points: [[700, 160], [800, 310]] }))
  parts.push(label({ x: 780, y: 238, value: '达到上限', size: 10.5, anchor: 'start' }))

  parts.push(text({ x: 50, y: 470, value: 'pending / deferred 不是失败；failed 是终态，只能显式重试。', size: 12, color: MUTED }))
  return svg(w, h, parts.join('\n'))
}

// ---------------------------------------------------------------------------
// Figure 6: reading path
// ---------------------------------------------------------------------------
function readingPath() {
  const w = 1200
  const h = 380
  const parts = []
  const axisY = 190
  const xFor = (minute) => 80 + minute * 17.5
  parts.push(arrow({ points: [[80, axisY], [1140, axisY]] }))
  for (let m = 0; m <= 60; m += 10) {
    parts.push(`<line x1="${xFor(m)}" y1="${axisY - 5}" x2="${xFor(m)}" y2="${axisY + 5}" stroke="${BORDER}" stroke-width="1.2"/>`)
  }
  parts.push(text({ x: 80, y: axisY + 22, value: '0 分钟', size: 11, color: MUTED, anchor: 'middle' }))
  parts.push(text({ x: 1120, y: axisY + 22, value: '60 分钟', size: 11, color: MUTED, anchor: 'middle' }))

  const stations = [
    { at: 2.5, title: '本页', sub: '判断与路线', up: true },
    { at: 10, title: '01 项目是什么', sub: '定位、边界', up: false },
    { at: 25, title: '02 快速开始', sub: '安装、第一条记忆', up: true },
    { at: 42.5, title: '03 + 05', sub: '概念、会话', up: false },
    { at: 55, title: '09 + 12', sub: '排障、术语', up: true },
  ]
  for (const s of stations) {
    const x = xFor(s.at)
    parts.push(`<circle cx="${x}" cy="${axisY}" r="7" fill="${ACCENT}" stroke="${WHITE}" stroke-width="2"/>`)
    const boxY = s.up ? 56 : 244
    parts.push(box({ x: x - 90, y: boxY, w: 180, h: 78, title: s.title, sub: [s.sub], fill: s.up ? ACCENT_BG : WHITE, stroke: s.up ? ACCENT : BORDER, titleSize: 13, subSize: 11 }))
    parts.push(arrow({ points: s.up ? [[x, boxY + 78], [x, axisY - 7]] : [[x, axisY + 7], [x, boxY]], marker: false }))
  }
  parts.push(text({ x: 50, y: 360, value: '一小时只需要这条主线；04、06、07、08、10、11 按需查阅。', size: 12, color: MUTED }))
  return svg(w, h, parts.join('\n'))
}

mkdirSync(OUT, { recursive: true })
const figures = {
  'fig-overview.svg': overview(),
  'fig-layers.svg': layers(),
  'fig-write-path.svg': writePath(),
  'fig-troubleshoot.svg': troubleshoot(),
  'fig-job-states.svg': jobStates(),
  'fig-reading-path.svg': readingPath(),
}
for (const [name, content] of Object.entries(figures)) {
  writeFileSync(join(OUT, name), content)
  process.stdout.write(`wrote ${name}\n`)
}
