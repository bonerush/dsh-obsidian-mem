import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { test } from 'node:test'
import { createMemoryViews } from '../lib/memory-panel.js'

// Preserve state and run dependency-aware effect cleanup across renders, as the
// host's React mount does. Fetch is the browser boundary; the views are real.
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
      if (effects[index]?.deps?.every((value, i) => Object.is(value, deps[i]))) return
      pending.push(() => {
        effects[index]?.cleanup?.()
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
  return [tree, ...(tree.props?.children ?? []).flat(Infinity).flatMap(nodes)]
}
const response = (value) => ({ ok: true, status: 200, json: async () => ({ ok: true, value }) })
const project = (name) => ({
  project: { state: 'bound', name },
  counts: { notes: 1 },
  queue: {},
  recent: [],
})
const cardName = (tree) =>
  nodes(tree).find((node) => node?.type?.name === 'ProjectCard')?.props.project.name
const button = (tree, text) =>
  nodes(tree).find((node) => node?.type === 'button' && node.props.children[0] === text)
const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

/**
 * The props the shell hands `SearchView`. The box and the filters belong to the
 * shell now, so a behaviour test drives the view the way the shell does: a new
 * query or filter is a new set of props, and `onFilter` is the shell's setter.
 */
const searchProps = (overrides = {}) => ({
  sessionId: 'a',
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

test('a cleared filter arrives as an explicit null and restores matching results', async (t) => {
  const sent = []
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const args = JSON.parse(options.body)
    sent.push(args)
    const titles = args.type || args.status ? ['filtered'] : ['first', 'second']
    return response({
      hits: titles.map((title) => ({ path: title, title })),
      limit: 25,
      hasMore: false,
    })
  })
  const render = mount(t, 'SearchView')
  const asked = []
  const shell = (overrides = {}) =>
    searchProps({ onFilter: (field, value) => asked.push([field, value]), ...overrides })
  for (const [label, groupLabel, field, wanted] of [
    ['约定', '类型', 'type', 'convention'],
    ['待确认', '状态', 'status', 'provisional'],
  ]) {
    render(shell())
    await setImmediate()
    let tree = render(shell())
    button(tree, label).props.onClick()
    assert.deepEqual(asked.at(-1), [field, wanted], 'the chip reports the field and the value')
    // The shell answers with the refined filter; that is the single read.
    render(shell({ [field]: wanted }))
    await setImmediate()
    tree = render(shell({ [field]: wanted }))
    assert.equal(sent.at(-1)[field], wanted)
    assert.equal(nodes(tree).filter((node) => node?.props?.className === 'mem-result').length, 1)
    // Clearing is the same contract with an explicit null: a `??` merge would turn
    // it into a silent no-op, so the reported value must be null, not omitted.
    const group = nodes(tree).find(
      (node) => node?.props?.className === 'mem-filter' && nodes(node).includes(groupLabel),
    )
    button(group, '全部').props.onClick()
    assert.deepEqual(asked.at(-1), [field, null], 'the cleared field is an explicit null')
    render(shell({ [field]: null }))
    await setImmediate()
    tree = render(shell({ [field]: null }))
    assert.equal(sent.at(-1)[field], null)
    assert.equal(nodes(tree).filter((node) => node?.props?.className === 'mem-result').length, 2)
  }
})

test('clearing one filter sends an explicit null for it and keeps the sibling filter applied', async (t) => {
  const sent = []
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    sent.push(JSON.parse(options.body))
    return response({ hits: [{ path: 'kept', title: 'kept' }], limit: 25, hasMore: false })
  })
  const render = mount(t, 'SearchView')
  render(searchProps({ type: 'convention', status: 'provisional' }))
  await setImmediate()
  render(searchProps({ type: 'convention', status: 'provisional' }))
  assert.equal(sent.at(-1).type, 'convention', 'the type filter is applied')
  assert.equal(sent.at(-1).status, 'provisional', 'the status filter is applied')
  // Clear only 类型 by re-rendering with the sibling untouched. 状态 travels in the
  // same request and must survive the clear, so a future "clear resets every
  // filter" regression cannot pass unnoticed.
  render(searchProps({ type: null, status: 'provisional' }))
  await setImmediate()
  const cleared = render(searchProps({ type: null, status: 'provisional' }))
  assert.equal(sent.at(-1).type, null, 'the cleared field is an explicit null')
  assert.equal(sent.at(-1).status, 'provisional', 'the sibling filter is still applied')
  assert.equal(nodes(cleared).filter((node) => node?.props?.className === 'mem-result').length, 1)
})

test('polling keeps last-good data on same-session refresh but hides it while another session loads or fails', async (t) => {
  const next = deferred()
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () =>
    ++calls === 1 ? response(project('Project A')) : next.promise,
  )
  const render = mount(t, 'OverviewView')
  const props = { sessionId: 'a', visible: true }
  render(props)
  await setImmediate()
  let tree = render(props)
  assert.equal(cardName(tree), 'Project A')
  button(tree, '刷新').props.onClick()
  tree = render(props)
  assert.equal(cardName(tree), 'Project A')
  tree = render({ ...props, sessionId: 'b' })
  assert.equal(cardName(tree), undefined)
  next.reject(new Error('offline'))
  await setImmediate()
  tree = render({ ...props, sessionId: 'b' })
  assert.equal(cardName(tree), undefined)
})

test('search hides another session results and ignores its out-of-order response', async (t) => {
  const delayed = deferred()
  // The pending answer belongs to session a's second read only. Session b's own
  // read gets its own promise, which never settles: the point is that a's late
  // answer cannot paint under b, not that b eventually shows something.
  const stalled = new Promise(() => {})
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1
    if (calls === 1) return response({ hits: [{ path: 'a', title: 'Project A' }] })
    if (calls === 2) return delayed.promise
    return stalled
  })
  const render = mount(t, 'SearchView')
  render(searchProps())
  await setImmediate()
  let tree = render(searchProps())
  assert.equal(nodes(tree).filter((node) => node?.props?.className === 'mem-result').length, 1)
  // A second read for session a is still in flight when the shell switches to b:
  // the snapshot is session-keyed, so b's first paint must show nothing from a.
  render(searchProps({ query: 'second' }))
  tree = render(searchProps({ sessionId: 'b' }))
  assert.equal(nodes(tree).filter((node) => node?.props?.className === 'mem-result').length, 0)
  delayed.resolve(response({ hits: [{ path: 'a-late', title: 'Late A' }] }))
  await setImmediate()
  tree = render(searchProps({ sessionId: 'b' }))
  assert.equal(
    nodes(tree).filter((node) => node?.props?.className === 'mem-result').length,
    0,
    'the late answer belongs to session a and never paints under b',
  )
})
