// Task 5: module boundaries and file size as tests, not as intentions.
//
// The design measured this repository before proposing anything: `lib/` has no
// import cycles and its 24 modules already fall into ten layers with every edge
// pointing strictly downward. Four files are large because each is cohesive (a
// single measurement of the import graph shows `index-db.js` depending on two
// modules, `transaction.js` on three), which is why the structural work is a
// fitness function rather than a reorganisation.
//
// The lists below are a *reviewed snapshot*, not an algorithm's output. That is
// the whole point: the check fails when a new module appears, when an edge points
// upward or sideways, and when a file grows past its approved size — so each of
// those becomes a decision someone makes on purpose instead of a drift nobody
// notices. Raising a budget is allowed; doing it silently is not.
//
// Two syntaxes are easy to miss and are handled explicitly, because the first
// version of this measurement used a regular expression that saw only
// `import ... from`: side-effect imports (`import './x.js'`) and re-exports
// (`export ... from './x.js'`). The latter are not hypothetical here — `lib/vault.js`
// re-exports from eight modules — so the graph is built from the AST.
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const LIB = join(ROOT, 'lib')

/**
 * The reviewed layer of every module, measured on the formatted tree.
 *
 * Lower layers may not import higher ones, and no edge may stay inside a layer:
 * lateral coupling is as much a decision as a cycle is.
 */
const LAYERS = {
  config: 0,
  naming: 0,
  paths: 0,
  pointer: 0,
  assets: 1,
  frontmatter: 1,
  git: 1,
  registry: 1,
  routing: 1,
  distill: 2,
  'index-db': 2,
  receipts: 2,
  pending: 3,
  search: 3,
  transaction: 3,
  vault: 4,
  lint: 5,
  memory: 5,
  capture: 6,
  hot: 6,
  brief: 7,
  hooks: 8,
  tools: 8,
  index: 9,
}

/**
 * Approved debt, as of the formatting commit: the measured line count plus 30,
 * rounded up to the next 50. The four large files are registered here on the same
 * rule as every other file rather than with extra headroom.
 */
const BUDGETS = {
  'lib/assets.js': 600,
  'lib/brief.js': 1150,
  'lib/capture.js': 1900,
  'lib/config.js': 300,
  'lib/distill.js': 950,
  'lib/frontmatter.js': 1100,
  'lib/git.js': 300,
  'lib/hooks.js': 1050,
  'lib/hot.js': 600,
  'lib/index-db.js': 2200,
  'lib/index.js': 150,
  'lib/lint.js': 1450,
  'lib/memory.js': 1400,
  'lib/naming.js': 250,
  'lib/paths.js': 300,
  'lib/pending.js': 1150,
  'lib/pointer.js': 300,
  'lib/receipts.js': 450,
  'lib/registry.js': 500,
  'lib/routing.js': 500,
  'lib/search.js': 200,
  'lib/tools.js': 1950,
  'lib/transaction.js': 2200,
  'lib/vault.js': 1750,
}

/** Every `lib/*.js` file, by basename without its extension. */
function libModules() {
  return readdirSync(LIB)
    .filter((name) => name.endsWith('.js'))
    .map((name) => name.slice(0, -3))
    .sort()
}

/** Lines in a file, counting a trailing newline as a terminator and not a line. */
function lineCount(path) {
  const text = readFileSync(path, 'utf8')
  return text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length
}

/**
 * Local module edges of one source text.
 *
 * @param {string} source - the file's contents.
 * @param {string} path - the file's path, for the unresolved-target message.
 * @returns {{edges: string[], problems: string[]}} local targets and hard problems.
 */
function localEdges(source, path) {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const edges = []
  const problems = []
  const record = (node, specifier) => {
    if (!specifier.startsWith('./') && !specifier.startsWith('../')) return
    if (!specifier.endsWith('.js')) {
      problems.push(`${path}: relative specifier that is not a .js module: ${specifier}`)
      return
    }
    const name = specifier.slice(specifier.lastIndexOf('/') + 1, -3)
    if (!existsSync(join(LIB, `${name}.js`))) {
      problems.push(`${path}: imports ${specifier}, which does not exist`)
      return
    }
    edges.push(name)
  }
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      if (ts.isStringLiteral(node.moduleSpecifier)) record(node, node.moduleSpecifier.text)
      else problems.push(`${path}: a non-literal import specifier cannot be reviewed`)
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [argument] = node.arguments
      if (argument && ts.isStringLiteral(argument)) record(node, argument.text)
      else problems.push(`${path}: a dynamic import with a computed specifier cannot be reviewed`)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return { edges, problems }
}

/**
 * Every edge of the real graph.
 *
 * @returns {{edges: Map<string, string[]>, problems: string[]}} the graph.
 */
function moduleGraph() {
  const edges = new Map()
  const problems = []
  for (const name of libModules()) {
    const path = join(LIB, `${name}.js`)
    const found = localEdges(readFileSync(path, 'utf8'), `lib/${name}.js`)
    edges.set(name, [...new Set(found.edges)].sort())
    problems.push(...found.problems)
  }
  return { edges, problems }
}

/**
 * Every cycle reachable in a graph.
 *
 * @param {Map<string, string[]>} edges - the graph.
 * @returns {string[]} one human-readable path per cycle.
 */
function findCycles(edges) {
  const state = new Map()
  const cycles = []
  const walk = (node, stack) => {
    if (state.get(node) === 'open') {
      cycles.push([...stack, node].join(' -> '))
      return
    }
    if (state.get(node) === 'done') return
    state.set(node, 'open')
    for (const next of edges.get(node) ?? []) walk(next, [...stack, node])
    state.set(node, 'done')
  }
  for (const node of edges.keys()) walk(node, [])
  return cycles
}

/**
 * Edges that break the layer rule, and modules with no declared layer.
 *
 * @param {Map<string, string[]>} edges - the graph.
 * @param {Record<string, number>} layers - the reviewed layers.
 * @returns {string[]} one message per violation.
 */
function layerViolations(edges, layers) {
  const problems = []
  for (const node of edges.keys()) {
    if (layers[node] === undefined) problems.push(`${node} has no declared layer`)
  }
  for (const [node, targets] of edges) {
    for (const target of targets) {
      if (layers[target] === undefined || layers[node] === undefined) continue
      if (layers[target] >= layers[node]) {
        problems.push(`${node} (L${layers[node]}) imports ${target} (L${layers[target]})`)
      }
    }
  }
  return problems
}

/**
 * Files over their approved size.
 *
 * @param {Record<string, number>} actual - measured lines per path.
 * @param {Record<string, number>} budgets - approved lines per path.
 * @returns {string[]} one message per over-budget file.
 */
function budgetViolations(actual, budgets) {
  const problems = []
  for (const [path, lines] of Object.entries(actual)) {
    const budget = budgets[path] ?? 600
    if (lines > budget) problems.push(`${path} has ${lines} lines, over its ${budget}-line budget`)
  }
  return problems
}

// ---------------------------------------------------------------------------
// The checks, on synthetic graphs, so the assertions above are known to bite.
// ---------------------------------------------------------------------------

test('findCycles reports a two-node cycle and passes an acyclic graph', () => {
  assert.deepEqual(
    findCycles(
      new Map([
        ['a', ['b']],
        ['b', []],
      ]),
    ),
    [],
  )
  assert.equal(
    findCycles(
      new Map([
        ['a', ['b']],
        ['b', ['a']],
      ]),
    ).length,
    1,
  )
})

test('layerViolations rejects an upward edge, a lateral edge and an undeclared module', () => {
  const layers = { a: 1, b: 3 }
  assert.deepEqual(layerViolations(new Map([['b', ['a']]]), layers), [])
  assert.equal(layerViolations(new Map([['a', ['b']]]), layers).length, 1)
  assert.equal(layerViolations(new Map([['a', ['a']]]), layers).length, 1)
  assert.equal(layerViolations(new Map([['c', []]]), layers).length, 1)
})

test('budgetViolations catches an over-budget file and defaults an unlisted one to 600', () => {
  assert.deepEqual(budgetViolations({ 'lib/a.js': 100 }, { 'lib/a.js': 200 }), [])
  assert.equal(budgetViolations({ 'lib/a.js': 201 }, { 'lib/a.js': 200 }).length, 1)
  assert.equal(budgetViolations({ 'lib/new.js': 601 }, {}).length, 1)
})

test('localEdges sees side-effect imports, re-exports and literal dynamic imports', () => {
  const source = [
    "import './paths.js'",
    "export { x } from './naming.js'",
    'export const y = await import("./config.js")',
  ].join('\n')
  const { edges, problems } = localEdges(source, 'lib/fixture.js')
  assert.deepEqual(edges.sort(), ['config', 'naming', 'paths'])
  assert.deepEqual(problems, [])
})

test('localEdges refuses an unresolvable target and a computed specifier', () => {
  assert.equal(localEdges("import './nope.js'", 'lib/fixture.js').problems.length, 1)
  assert.equal(localEdges('const p = "./paths.js"; import(p)', 'lib/fixture.js').problems.length, 1)
})

// ---------------------------------------------------------------------------
// The checks, on this repository.
// ---------------------------------------------------------------------------

test('lib/ has no import cycles', () => {
  const { edges, problems } = moduleGraph()
  assert.deepEqual(problems, [])
  assert.deepEqual(findCycles(edges), [])
})

test('every lib/ module has a declared layer and every edge points strictly down', () => {
  const { edges } = moduleGraph()
  assert.deepEqual(layerViolations(edges, LAYERS), [])
  assert.deepEqual(
    [...edges.keys()].sort(),
    Object.keys(LAYERS).sort(),
    'the layer table and the module list have to be edited together',
  )
})

test('every lib/ module is inside its approved size', () => {
  const actual = Object.fromEntries(
    libModules().map((name) => [`lib/${name}.js`, lineCount(join(LIB, `${name}.js`))]),
  )
  assert.deepEqual(budgetViolations(actual, BUDGETS), [])
})
