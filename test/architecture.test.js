// Task 5: module boundaries and file size as tests, not as intentions.
//
// The design measured this repository before proposing anything: `lib/` has no
// import cycles and its 28 modules already fall into eleven layers with every
// edge pointing strictly downward. Several files are large because each is
// cohesive (a single measurement of the import graph shows `index-db.js`
// depending on two modules, `transaction.js` on three), which is why the
// structural work is a fitness function rather than a reorganisation.
//
// That held through the one structural change the plan did make: `lib/tools.js`
// was 2,006 lines holding three jobs, and Task 11 gave each job its own module
// behind an unchanged façade. The three new names below are not an exception to
// the layer rule but an application of it — `tools` now sits *above* the parts
// it re-exports, which is the only position from which a façade can exist.
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
  // `debug.js` imports nothing from `lib/`, so it sits at the bottom with the
  // other leaves; everything that records through it points downward.
  debug: 0,
  'diagnostic-codec': 1,
  'diagnostic-journal': 2,
  // The standalone report probes the complete plugin through dynamic imports;
  // it sits above the host entry rather than becoming an import of that entry.
  'diagnostic-report': 11,
  'diagnose-cli': 12,
  config: 0,
  // Browser-only code and the bounded activity/HTTP helpers do not import
  // another repository module; the host entry composes them at L10.
  client: 1,
  // The colour-slot table has no repository imports at all; the Canvas renderer
  // reads its slots through it, which is the one edge that puts the renderer above
  // it instead of beside it.
  'graph-palette': 0,
  // The finite recall clock and Canvas cue painting are independent leaves;
  // keeping them below the renderer preserves its geometry and label budget.
  'graph-recall': 0,
  // The panel's remembered controls: a pure browser-side leaf with no repository
  // import at all, so it sits at the bottom with the other leaves.
  'graph-settings': 0,
  'graph-renderer': 1,
  'graph-worker': 0,
  'graph-activity': 0,
  'graph-route': 0,
  'graph-links': 0,
  // Graph-only metadata reads and projection import path/link leaves; recall owns the index.
  'graph-data': 1,
  naming: 0,
  paths: 0,
  pointer: 0,
  // The note-level health rules — an overdue review date, a dead wikilink — that
  // the linter and the curation scanner both apply. A leaf with no repository
  // import at all, so both callers point down at it instead of each keeping a
  // copy that could drift.
  'note-health': 0,
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
  'prompt-recall': 3,
  transaction: 3,
  vault: 4,
  // The curation scanner's private state (cursor, per-path records, changed-path
  // queue) imports the transaction engine's lock and the path jail and nothing
  // above them, which is the same position `vault` holds. The scanner itself
  // applies the linter's fixed exclusions and reuses its note-health helpers, so
  // it has to sit above `lint` — that edge is what fixes L6 rather than L5.
  'curation-state': 4,
  // The durable proposal store: the review queue a risky candidate is parked in.
  // It reads the private curation state and the vault jail and writes nothing but
  // private JSON, which is the position `curation-state` holds — but it also has to
  // sit *below* `capture` (L6), because the queue worker is the layer that may
  // compose the store with `applyCandidate`. That edge is what fixes L5: L5 is the
  // highest layer strictly under capture, and `memory` (L5) is therefore a lateral
  // neighbour it may not import — which is exactly why the `propose` seam exists.
  'curation-proposals': 5,
  lint: 5,
  'curation-scan': 6,
  memory: 5,
  capture: 6,
  hot: 6,
  brief: 7,
  hooks: 8,
  // The tool contract reads `DEFAULT_LIMIT` from `index-db` (L2) and nothing
  // else, which puts it at L3; the registrations import the contract and nothing
  // else, which puts them at L4. Both were inside `tools.js` before Task 11.
  'tool-schema': 3,
  'tool-registry': 4,
  // The service layer calls `buildBrief`, so it sits above `brief`; that single
  // edge is what fixes its layer, and it is the reason the split is L8/L9/L10
  // rather than three files at the old `tools` layer.
  services: 8,
  // The façade: it imports its three parts and nothing else, so it has to be
  // above all of them. A module that re-exports is not a peer of what it
  // re-exports, which is exactly what the strict-downward rule encodes.
  tools: 9,
  index: 10,
}

/**
 * Approved debt, as of the formatting commit: the measured line count plus 30,
 * rounded up to the next 50. The four large files are registered here on the same
 * rule as every other file rather than with extra headroom.
 */
const BUDGETS = {
  // The optional support sink adds one failure-isolated observer to the existing
  // ring. It stays here so every call site still passes only one diagnostics seam.
  'lib/debug.js': 250,
  'lib/diagnostic-codec.js': 200,
  'lib/diagnostic-journal.js': 300,
  'lib/diagnostic-report.js': 350,
  'lib/diagnose-cli.js': 100,
  'lib/assets.js': 600,
  'lib/brief.js': 1150,
  // Raised from 1900 when the diagnostics call sites landed here. The alternative
  // was to move the emissions into a module of their own, which would have meant
  // re-exporting each of the ten skip reasons and the six queue outcomes — the
  // decision points are what is being recorded, and they are in this file. The
  // size rule is registered rather than waived, which is the whole point of it:
  // the next raise has to argue with this line.
  // Raised from 2050 by Task 3 (2086 measured). The proposal seam belongs here and
  // nowhere else: this is the only layer that may compose the store with
  // `applyCandidate`, and the alternative — having `memory.js` reach sideways for
  // it — is the lateral edge the layer rule above exists to refuse. What the lines
  // buy: the seam itself, the review outcome's diagnostic, the `proposalId` the
  // receipt carries, and the one branch that skips the index refresh for an item
  // that wrote nothing.
  'lib/capture.js': 2100,
  'lib/config.js': 300,
  // The curation plan's three Task 2 modules, on the same rule as every other
  // entry (measured plus 30, rounded up). What the size buys: the scanner carries
  // the coverage rules a bounded pass has to keep honest, the state module carries
  // the permission, size and version checks for three documents, and note-health
  // carries the linter's own wording so the two cannot drift.
  'lib/note-health.js': 300,
  'lib/curation-state.js': 800,
  // Raised from 900 in the Task 2 fix round, on the same measured-plus-30 rule
  // (987 lines at that commit; the 974 this comment first recorded was measured
  // before the round's own last edit). The review found three honesty gaps, and
  // each one is fixed where the fact is decided rather than in a caller: a resolver
  // that declines to judge targets outside its own project, so "a scan reports a
  // subset of the linter's dead links" is true as written; a `complete` that is
  // false whenever either bound truncated the pass, so a merge cannot drop the
  // paths it never inspected; and a record write that degrades one note to
  // `unexamined` — bounded entry fields plus a two-step recovery — instead of
  // throwing the whole pass on one note's frontmatter.
  // Raised again to 1115 (1085 measured, same rule) in the second fix round, which
  // closed the resolver's universe: it is now enumerated from the vault surface —
  // the project's whole file tree plus one vault-root `readdir` — instead of the
  // `.md` manifest, because the manifest cannot see a vault-root note or an
  // extension-less file, and calling those links dead invented findings the linter
  // never made. The lines buy that second enumeration and the `null` universe an
  // enumeration failure returns, so the resolver reads it as undecidable rather
  // than as an empty vault. The alternative was a resolver that reported files it
  // never looked for.
  // Raised again to 1217 (1187 measured at `fix: stop curation enumeration from
  // claiming unseen coverage`, same measured-plus-30 rule) in the third fix round,
  // which made the enumeration's own failures visible: a directory the walk cannot
  // read is now a state finding plus `complete: false` plus a cursor that stays put
  // (before, the pass claimed `complete: true` over a manifest that was one subtree
  // short), the resolver's file list got the count bound it never had, and a bound
  // that bites turns the list into `null` rather than a short one a link could be
  // called dead against. The two comments that described the linter's `filePaths` as
  // `.md`-only were also replaced with the relation that actually holds.
  // Raised again to 1257 (1227 measured formatted at `fix: keep curation coverage
  // and link claims exact`, same measured-plus-30 rule) in the fourth fix round, which closed
  // the fail-open the previous round's file bound introduced: the bound broke the
  // whole walk, so `manifest.paths` was truncated too while `truncated` and `denied`
  // stayed false — `complete: true` and a cursor written over a short fingerprint.
  // The two lists now stop separately, `maxManifestFiles` is a validated seam so the
  // manifest budget the file bound had made unreachable stays exercised, and the
  // truncation message names the bound that actually applied instead of the shipped
  // constant. The rest of the lines are the resolver comment rewritten to the literal
  // probe result, because three rounds of prose had each over-claimed.
  'lib/curation-scan.js': 1257,
  // The Task 3 module, on the same measured-plus-30 rule (1113 formatted lines,
  // 1115 with the two-line comment that makes the listing order intentional).
  // What the size buys: two proposal kinds with different operations, four
  // review-only finding kinds, an identity derivation and a content hash that have
  // to disagree in exactly the right places, an exclusive-create publication that
  // survives two processes racing one identity, and the scan→proposal recording
  // that has to replay rather than duplicate. Splitting the store from the recorder
  // would put one identity derivation in two files.
  'lib/curation-proposals.js': 1150,
  // Raised from 950 for the configurable item-count ceiling. The prompt must name
  // the ceiling the validator enforces (`too-many-items` refused a whole batch of
  // 21 against 16 because it did not), and a ceiling that comes from config cannot
  // be a literal in a module constant: it costs one exported slot, one substitution
  // helper and their JSDoc. The alternative — a second prompt string beside the
  // validator's vocabulary — is the drift this file's tests exist to prevent.
  'lib/distill.js': 975,
  'lib/frontmatter.js': 1100,
  'lib/git.js': 300,
  // Raised from 1050 for one per-turn prompt map beside the existing brief
  // state machine. The retrieval policy lives in prompt-recall.js; these lines
  // are the host decision assembly and its shared budget, not a second policy.
  // One post-commit recall cue is deliberately adjacent to the commit point.
  'lib/hooks.js': 1150,
  'lib/hot.js': 600,
  // The graph projection uses the existing SQLite links table and scan records;
  // keeping the two backend branches here avoids a second index implementation.
  'lib/index-db.js': 2300,
  // The loader owns React controls; the renderer owns cached labels, culling
  // and frame scheduling. Neither the renderer nor Worker imports React.
  // Raised from 600 when the panel's controls started outliving the page: the host
  // rebuilds this tab on every load and the graph route is read-only, so the restore
  // and its gated save live here. The record shape and its validation are the part
  // that earned a module of its own (`lib/graph-settings.js`), not the wiring.
  'lib/client.js': 650,
  'lib/graph-renderer.js': 700,
  // The eleven-slot table, its two CSS forms and the probe read, split out of the
  // renderer when the label-size work pushed that file past its budget.
  'lib/graph-palette.js': 160,
  // Raised from 200 when the cue kinds and the parked cues landed: a write takes
  // the tag colour instead of the accent, a search hit keeps 60% of the weight, and
  // a cue whose note the projection has not carried yet is parked (bounded, with a
  // TTL) instead of being dropped — without that last part a note the turn *creates*
  // is written and never lights up.
  'lib/graph-recall.js': 250,
  // The graph panel's remembered controls: the record shape, the per-field fallback
  // and the bounds that keep an edited `localStorage` entry from blanking the graph.
  'lib/graph-settings.js': 200,
  // Upstream minified D3 plus the reviewed source in client/graph-worker.js.
  'lib/graph-worker.js': 150,
  'lib/graph-activity.js': 100,
  'lib/graph-route.js': 200,
  // Both enabled entry points construct the private journal beside their ring;
  // this small assembly step belongs here, after the disabled early return.
  'lib/index.js': 200,
  'lib/lint.js': 1450,
  // Raised from 1400 by Task 3 (1499 measured). The gate itself is deliberately
  // here rather than in a helper module: the decision is "is this candidate risky",
  // and it is only answerable beside the ownership pre-check and the duplicate
  // lookup that produce its two inputs. The raise also covers the `propose` seam on
  // `normalizeDeps` and the two JSDoc blocks that record why the failure is closed
  // rather than falling through to a supersede.
  'lib/memory.js': 1500,
  'lib/naming.js': 250,
  'lib/paths.js': 300,
  'lib/pending.js': 1150,
  'lib/pointer.js': 300,
  'lib/receipts.js': 450,
  'lib/registry.js': 500,
  'lib/routing.js': 500,
  // Raised from 200 for the title-twin lookup: the duplicate rule needs the same
  // tokenizer and the same project-scoped search as `mem_search`, and putting it
  // anywhere else would either duplicate the tokenizer or point a layer upward.
  'lib/search.js': 250,
  // Raised from 150 for the decision object and the measured floor. The policy
  // now answers *why* it was silent (`RECALL_OUTCOMES`), which is what makes the
  // firing rate readable from `mem_admin(action="diagnostics")` instead of from
  // parsed session transcripts, and it carries the floor cap the replay chose.
  'lib/prompt-recall.js': 220,
  // Raised from 1950 when the diagnostics action's schema landed here. This file
  // is the one the split is for, so the raise is explicitly temporary: the next
  // structural change reduces it to a façade and lowers this number with it.
  // The four modules Task 11 produced, on the same rule as every other entry.
  // Before the split this was one 2,006-line file whose budget had been raised
  // to 2,050 with a note saying the raise was temporary; the façade is 22 lines,
  // so the number that replaces it is 100 rather than another raise.
  'lib/tools.js': 100,
  'lib/tool-schema.js': 900,
  'lib/tool-registry.js': 250,
  // Raised from 1100 when the explicit-retry wake-up landed here: `kickQueueWorker`
  // is threaded through the option record and the one action that owns retrying, so
  // a revived job runs now rather than at the next unrelated capture. The retry and
  // the wake-up it asks for are one decision, which is why they stay in one file
  // instead of the kick moving out to the assembly.
  // Raised from 1120 when the graph cues landed: every successful search and write
  // now reports the paths it touched through the same `onAccess` seam the read path
  // already used. The seam widening (`path` → `paths` + `kind`) and the one helper
  // that turns a write receipt into cue paths are what the 30 lines buy.
  'lib/services.js': 1150,
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
