import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const MODULE = new URL('../lib/memory-panel.js', import.meta.url)
const source = () => readFile(MODULE, 'utf8')

test('the served module imports nothing and exports exactly the three views', async () => {
  const text = await source()
  assert.equal(/^\s*import\s/mu.test(text), false, 'no static import')
  assert.equal(/\brequire\s*\(/u.test(text), false, 'no require')
  assert.equal(/\bfrom\s+['"]/u.test(text), false, 'no module source')
  const { createMemoryViews } = await import(MODULE)
  assert.equal(typeof createMemoryViews, 'function')
  assert.throws(() => createMemoryViews({}), /requires React/u)
  const views = createMemoryViews({ React: { createElement: () => null } })
  assert.deepEqual(Object.keys(views).sort(), ['HealthView', 'OverviewView', 'SearchView'])
  for (const name of ['OverviewView', 'SearchView', 'HealthView']) {
    assert.equal(typeof views[name], 'function')
    assert.equal(views[name].name, name)
  }
})

test('the module reads the read-only panel route and nothing else', async () => {
  const text = await source()
  assert.ok(text.includes('obsidian-mem/panel'), 'the one endpoint is the panel route')
  assert.ok(text.includes('fetch(PANEL_URL'), 'the module names its only request')
  for (const action of ['overview', 'search', 'health'])
    assert.ok(text.includes("action: '" + action + "'"), 'the module requests ' + action)
  for (const forbidden of ['bind', 'compact', 'promote', 'lint', 'delete'])
    assert.equal(
      text.includes("action: '" + forbidden + "'"),
      false,
      'no write action: ' + forbidden,
    )
})

test('polling is one AbortController per run, visible-gated and stale-safe', async () => {
  const text = await source()
  assert.ok(text.includes('new AbortController()'), 'one controller per run')
  assert.ok(text.includes('document.hidden'), 'a hidden document pauses the poll')
  assert.ok(text.includes('visibilitychange'), 'returning to the tab resumes immediately')
  assert.ok(text.includes('setInterval('), 'a visible-gated interval drives refresh')
  assert.match(text, /if \(!visible \|\| !sessionId\) return undefined/u)
  assert.match(text, /if \(disposed \|\| cause\?\.name === 'AbortError'\) return/u)
  assert.match(text, /controller\?\.abort\(\)/u, 'cleanup aborts the in-flight run')
  assert.ok(text.includes('setError(cause)'), 'a failure is recorded')
  const posted = text.indexOf('const next = await post(')
  const guarded = text.indexOf('if (disposed) return', posted)
  const stored = text.indexOf('setValue(next)', posted)
  assert.ok(posted > 0 && guarded > posted && stored > guarded, 'stale responses are rejected')
  assert.equal(
    text.includes('setValue(null)'),
    false,
    'a failed run never clears the last good data',
  )
})

test('every state the panel can show has Chinese copy', async () => {
  const text = await source()
  for (const copy of [
    '正在读取记忆…',
    '正在刷新…',
    '数据可能已过期，上次更新 ',
    '读取记忆失败：',
    '记忆接口未就绪（路由未注册）；重启 dsh 后重试',
    '当前项目尚未绑定记忆',
    '这个项目还没有记忆',
    '没有匹配的记忆。',
    '队列为空。',
    '热层',
    '最近的决策',
  ])
    assert.ok(text.includes(copy), 'the copy is present: ' + copy)
  assert.ok(text.includes("role: stale ? 'status' : 'alert'"), 'errors are announced as alerts')
  assert.ok(text.includes("'aria-live': 'polite'"), 'status changes are announced politely')
})

test('every asset URL the shell names resolves to a shipped lib module', async () => {
  const script = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  const names = [...script.matchAll(/import\('\/obsidian-mem\/([a-z0-9.-]+\.js)'\)/gu)].map(
    (match) => match[1],
  )
  assert.ok(names.includes('memory-panel.js'), 'the shell names the panel module')
  for (const name of names) await readFile(new URL('../lib/' + name, import.meta.url))
})
