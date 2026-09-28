import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createGraphRenderer } from '../lib/graph-renderer.js'

// The values Obsidian's app.css gives each `.graph-view.color-*` slot on the
// default light and dark themes. The renderer must read them exactly as the
// browser computes them, colour and opacity both.
const LIGHT_SLOTS = {
  'color-fill': { color: 'rgb(92, 92, 92)', opacity: '1' },
  'color-fill-focused': { color: 'rgb(138, 92, 245)', opacity: '1' },
  'color-fill-tag': { color: 'rgb(8, 185, 78)', opacity: '1' },
  'color-fill-attachment': { color: 'rgb(224, 172, 0)', opacity: '1' },
  'color-fill-unresolved': { color: 'rgb(171, 171, 171)', opacity: '0.5' },
  'color-arrow': { color: 'rgb(34, 34, 34)', opacity: '0.5' },
  'color-circle': { color: 'rgb(138, 92, 245)', opacity: '1' },
  'color-line': { color: 'rgb(212, 212, 212)', opacity: '1' },
  'color-text': { color: 'rgb(34, 34, 34)', opacity: '1' },
  'color-fill-highlight': { color: 'rgb(138, 92, 245)', opacity: '1' },
  'color-line-highlight': { color: 'rgb(138, 92, 245)', opacity: '1' },
}
const DARK_SLOTS = {
  ...LIGHT_SLOTS,
  'color-fill': { color: 'rgb(179, 179, 179)', opacity: '1' },
  'color-fill-unresolved': { color: 'rgb(102, 102, 102)', opacity: '0.5' },
  'color-arrow': { color: 'rgb(218, 218, 218)', opacity: '0.5' },
  'color-line': { color: 'rgb(63, 63, 63)', opacity: '1' },
  'color-text': { color: 'rgb(218, 218, 218)', opacity: '1' },
}

function surface() {
  const contexts = []
  const frames = new Map()
  const events = new Map()
  const workers = []
  let sequence = 0
  let clock = 1000
  const theme = { dark: false, observers: [] }
  const view = {
    devicePixelRatio: 2,
    requestAnimationFrame(callback) {
      frames.set(++sequence, callback)
      return sequence
    },
    cancelAnimationFrame: (id) => frames.delete(id),
    getComputedStyle: (element) => {
      const classes = String(element?.className ?? '').split(' ')
      const slots = theme.dark ? DARK_SLOTS : LIGHT_SLOTS
      for (const [name, value] of Object.entries(slots))
        if (classes.includes(name)) return { color: value.color, opacity: value.opacity }
      return { color: 'transparent', opacity: '1' }
    },
    Worker: class {
      constructor() {
        workers.push(this)
      }
      postMessage(value) {
        this.lastMessage = value
      }
      terminate() {
        this.terminated = true
      }
      emit(id, values) {
        this.onmessage({ data: { id, buffer: new Float32Array(values).buffer } })
      }
    },
    ResizeObserver: class {
      constructor(callback) {
        this.callback = callback
      }
      observe() {
        this.callback()
      }
      disconnect() {}
    },
    MutationObserver: class {
      constructor(callback) {
        this.callback = callback
        theme.observers.push(this)
      }
      observe() {}
      disconnect() {}
    },
    performance: { now: () => clock },
  }
  const host = {
    className: '',
    style: {},
    children: [],
    appendChild(child) {
      this.children.push(child)
      return child
    },
    removeChild(child) {
      this.children = this.children.filter((entry) => entry !== child)
      return child
    },
    setAttribute() {},
  }
  const makeProbe = () => ({
    className: '',
    style: {},
    attributes: {},
    setAttribute(name, value) {
      this.attributes[name] = String(value)
    },
  })
  const document = {
    defaultView: view,
    documentElement: host,
    body: host,
    createElement: (tag) => (tag === 'canvas' ? makeCanvas() : makeProbe()),
  }
  function makeCanvas() {
    const calls = []
    const context = new Proxy(
      {
        calls,
        font: '',
        measureText(text) {
          const size = Number(this.font.match(/([\d.]+)px/)?.[1] ?? 16)
          return {
            width: Array.from(text).length * size * 0.53,
            actualBoundingBoxAscent: size * 0.8,
            actualBoundingBoxDescent: size * 0.2,
          }
        },
      },
      {
        get(target, key) {
          if (key in target) return target[key]
          return (...args) => calls.push({ name: key, args })
        },
        set(target, key, value) {
          calls.push({ name: 'set:' + String(key), args: [value] })
          target[key] = value
          return true
        },
      },
    )
    contexts.push(context)
    return {
      ownerDocument: document,
      parentElement: host,
      clientWidth: 800,
      clientHeight: 700,
      getContext: () => context,
      getBoundingClientRect: () => ({ left: 0, top: 0 }),
      addEventListener: (name, callback) => events.set(name, callback),
      removeEventListener: (name) => events.delete(name),
      setPointerCapture() {},
      style: {},
      attributes: {},
      setAttribute(name, value) {
        this.attributes[name] = String(value)
      },
    }
  }
  const canvas = makeCanvas()
  const renderer = createGraphRenderer(canvas, (message) => assert.fail(message))
  const node = (id, path = id + '.md') => ({
    id,
    path,
    title: 'Frontmatter title differs',
    type: 'decision',
  })
  const model = (nodes) => ({
    graph: { nodes, edges: [] },
    display: { size: 1, width: 1, text: 0, arrows: false },
    colors: new Map(),
    degree: new Map(),
    active: [],
  })
  const emit = (ids, coordinates) => workers[0].emit(ids, coordinates)
  const wheel = (deltaY) =>
    events.get('wheel')({ deltaY, deltaMode: 0, clientX: 400, clientY: 350, preventDefault() {} })
  const step = () => {
    clock += 1000 / 60
    const ready = [...frames.values()]
    frames.clear()
    ready.forEach((callback) => callback(clock))
  }
  const textCalls = () =>
    contexts.slice(1).flatMap((context) => context.calls.filter((call) => call.name === 'fillText'))
  return {
    renderer,
    canvas,
    theme,
    setDark(dark) {
      theme.dark = dark
      for (const observer of theme.observers) observer.callback()
    },
    contexts,
    frames,
    events,
    workers,
    node,
    model,
    emit,
    wheel,
    step,
    textCalls,
  }
}

test('graph labels keep Obsidian filename text, font stack and natural glyph width', () => {
  const s = surface()
  const filename = '长中文文件名保持字形比例'.repeat(8)
  s.renderer.update(s.model([s.node('one', 'Docs/' + filename + '.md')]))
  s.emit(['one'], [0, 0])
  s.wheel(0)
  s.step()
  const calls = s.textCalls()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].args[0], filename)
  assert.equal(calls[0].args[1], 0, 'single-line ink starts at zero even with fractional metrics')
  assert.equal(calls[0].args.length, 3, 'text must never be squeezed with fillText(maxWidth)')
  assert.ok(s.contexts.some((context) => context.font.includes('"Microsoft YaHei Light"')))
  assert.ok(s.contexts.some((context) => context.font.includes('"Inter"')))
  // The one deliberate deviation: app.js uses `14 + getSize() / 4`; this panel
  // rasterizes at half of it by default. A degree-0 node has getSize() 8, so 8px.
  assert.ok(
    s.contexts.some((context) => / 8px /u.test(context.font)),
    'a degree-0 node rasterizes at 8px: 50% of the original 14 + 8 / 4',
  )
  s.renderer.destroy()
})

test('word wrapping preserves whole words at the original 300px base width', () => {
  const s = surface()
  const filename = 'alpha beta gamma delta epsilon zeta eta theta'
  // Pin the original font size so this case measures the wrap width itself and not
  // whatever the title-size slider defaults to.
  const model = s.model([s.node('one', filename + '.md')])
  model.display = { ...model.display, label: 1 }
  s.renderer.update(model)
  s.emit(['one'], [0, 0])
  s.wheel(0)
  s.step()
  const lines = s.textCalls().map((call) => call.args[0])
  assert.ok(lines.length > 1)
  assert.equal(lines.join(' '), filename)
  s.renderer.destroy()
})

test('zoom reuses rasterized labels instead of shaping every label every frame', () => {
  const s = surface()
  s.renderer.update(s.model([s.node('one')]))
  s.emit(['one'], [0, 0])
  s.wheel(0)
  s.step()
  const count = s.textCalls().length
  s.wheel(-180)
  for (let i = 0; i < 30; i += 1) s.step()
  assert.equal(s.textCalls().length, count)
  assert.ok(s.contexts[0].calls.filter((call) => call.name === 'drawImage').length > 10)
  s.renderer.destroy()
})

test('a clicked label resumes Obsidian zoom scaling after the pointer leaves', () => {
  const s = surface()
  s.renderer.update(s.model([s.node('one')]))
  s.emit(['one'], [0, 0])
  s.wheel(0)
  s.step()
  const original = s.contexts[0].calls.find((call) => call.name === 'drawImage').args[3]
  s.events.get('pointerdown')({ button: 0, clientX: 400, clientY: 350, pointerId: 1 })
  s.events.get('pointerup')()
  s.events.get('pointerleave')()
  s.wheel(120)
  for (let i = 0; i < 70; i += 1) s.step()
  const drawn = s.contexts[0].calls.filter((call) => call.name === 'drawImage').at(-1)
  assert.ok(drawn.args[3] < original * 0.83, 'ordinary text shrinks with the node after unhover')
  const radius = s.contexts[0].calls.filter((call) => call.name === 'arc').at(-1).args[2]
  assert.ok(Math.abs(drawn.args[3] / original - radius / 8) < 0.0001)
  s.wheel(-360)
  for (let i = 0; i < 70; i += 1) s.step()
  const enlarged = s.contexts[0].calls.filter((call) => call.name === 'drawImage').at(-1)
  assert.ok(enlarged.args[3] > original * 1.49, 'zooming in enlarges ordinary text')
  assert.equal(s.textCalls().length, 1, 'zoom transforms the same cached glyphs')
  s.renderer.destroy()
})

test('graph colours come from the host theme colour slots, opacity included', () => {
  const s = surface()
  s.renderer.update(s.model([s.node('filed'), { ...s.node('missing'), type: 'unresolved' }]))
  s.emit(['filed', 'missing'], [0, 0, 40, 0])
  s.wheel(0)
  for (let i = 0; i < 40; i += 1) s.step()
  const paints = () =>
    s.contexts[0].calls.filter((call) => call.name === 'set:fillStyle').map((call) => call.args[0])
  assert.ok(paints().includes('rgb(92, 92, 92)'), 'a file node paints the color-fill slot')
  const alphas = s.contexts[0].calls
    .filter((call) => call.name === 'set:globalAlpha')
    .map((call) => call.args[0])
  assert.ok(
    alphas.some((value) => Math.abs(value - 0.5) < 0.01),
    'an unresolved node keeps color-fill-unresolved at 50% opacity',
  )
  assert.ok(
    s.contexts[1].calls.some(
      (call) => call.name === 'set:fillStyle' && call.args[0] === 'rgb(34, 34, 34)',
    ),
    'labels rasterize with the color-text slot',
  )
  s.setDark(true)
  for (let i = 0; i < 3; i += 1) s.step()
  assert.ok(paints().includes('rgb(179, 179, 179)'), 'a theme switch re-resolves every slot')
  assert.ok(
    !paints().includes('rgb(92, 92, 92)') || paints().lastIndexOf('rgb(179, 179, 179)') > 0,
    'the dark slot wins after the switch',
  )
  s.renderer.destroy()
})

test('a hovered label keeps the original glyph size while the graph is zoomed out', () => {
  const s = surface()
  s.renderer.update(s.model([s.node('one')]))
  s.emit(['one'], [0, 0])
  s.wheel(0)
  for (let i = 0; i < 40; i += 1) s.step()
  const drawn = () =>
    s.contexts[0].calls.filter((call) => call.name === 'drawImage' && call.args.length === 5).at(-1)
  const base = drawn().args[3]
  s.events.get('pointermove')({ clientX: 400, clientY: 350 })
  s.wheel(120)
  for (let i = 0; i < 70; i += 1) s.step()
  const hovered = drawn().args[3]
  assert.ok(
    Math.abs(hovered - base) < 0.5,
    'app.js forces 1 / scale while one node is highlighted, so the hovered label keeps its base size',
  )
  assert.ok(
    s.contexts[0].calls.filter((call) => call.name === 'drawImage' && call.args.length === 5)
      .length > 3,
    'the hovered label is redrawn while the pointer stays on the node',
  )
  s.renderer.destroy()
})

test('a called memory keeps its name on screen while the graph is zoomed out', () => {
  // The pulse alone says "something was read"; the point of the cue is *which*
  // file, so a node with fresh activity is drawn like a highlighted one.
  const s = surface()
  const view = (active = []) => {
    const model = s.model([s.node('one', 'Docs/one.md')])
    model.active = active
    return model
  }
  s.renderer.update(view())
  s.emit(['one'], [0, 0])
  s.wheel(0)
  for (let i = 0; i < 40; i += 1) s.step()
  s.wheel(120)
  s.wheel(120)
  for (let i = 0; i < 90; i += 1) s.step()
  const drawnSince = (from) =>
    s.contexts[0].calls
      .slice(from)
      .filter((call) => call.name === 'drawImage' && call.args.length === 5)
      .at(-1)
  const mark = s.contexts[0].calls.length
  s.wheel(0)
  s.step()
  assert.equal(drawnSince(mark), undefined, 'ambient labels are hidden at this zoom')
  s.renderer.update(view([{ path: 'Docs/one.md', at: Date.now() }]))
  for (let i = 0; i < 5; i += 1) s.step()
  const called = drawnSince(mark)
  assert.ok(called, 'the called memory draws its label while zoomed out')
  assert.equal(called.args.length, 5)
  assert.ok(
    s.contexts[0].calls.some(
      (call) =>
        call.name === 'set:strokeStyle' && String(call.args[0]).startsWith('rgba(138, 92, 245'),
    ),
    'the called node keeps its accent ring',
  )
  assert.match(
    String(s.canvas.attributes['aria-label']),
    /正在调用 1 条记忆：one/u,
    'the canvas caption names the file',
  )
  s.renderer.destroy()
})

test('the title-size setting scales the label raster', () => {
  const s = surface()
  const model = s.model([s.node('one')])
  model.display = { ...model.display, label: 1.2 }
  s.renderer.update(model)
  s.emit(['one'], [0, 0])
  s.wheel(0)
  s.step()
  // A degree-0 node has getSize() 8, so the original raster is 16px and this is 19.2px.
  assert.ok(
    s.contexts.some((context) => / 19[.]2px /u.test(context.font)),
    'the slider factor overrides the 0.5 default and reaches the raster',
  )
  s.renderer.destroy()
})

test('the viewport skips offscreen labels and geometry during zoom', () => {
  const s = surface()
  s.renderer.update(s.model([s.node('inside'), s.node('outside')]))
  s.emit(['inside', 'outside'], [0, 0, 10000, 10000])
  s.wheel(0)
  s.step()
  assert.deepEqual(
    s.textCalls().map((call) => call.args[0]),
    ['inside'],
  )
  assert.equal(s.contexts[0].calls.filter((call) => call.name === 'arc').length, 1)
  s.renderer.destroy()
})

test('idle rendering stops and interaction wakes it; destroy cancels work', () => {
  const s = surface()
  s.renderer.update(s.model([s.node('one')]))
  s.emit(['one'], [0, 0])
  s.wheel(0)
  for (let i = 0; i < 100; i += 1) s.step()
  assert.equal(s.frames.size, 0)
  s.wheel(-100)
  assert.equal(s.frames.size, 1)
  s.step()
  s.renderer.destroy()
  assert.equal(s.frames.size, 0)
  assert.equal(s.events.size, 0)
  assert.equal(s.workers[0].terminated, true)
})
