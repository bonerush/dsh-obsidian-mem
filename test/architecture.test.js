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
  // The compact, source-verified navigation view (Task 4). Its content, merge and
  // verification sit here — L5, one below the scanner that produces the entries it
  // groups — because it imports the private state (L4), the vault jail (L4), the
  // shared history list (L0) and the byte-safe hash (L2) and *nothing* from
  // `curation-scan`. That last part is deliberate and load-bearing: the view
  // re-applies the history and exact-group rules instead of importing the
  // scanner's, because it also groups a merge of a stored view and a changed-path
  // batch, which is data the scanner never saw. Importing even one constant from
  // `curation-scan` would put this module at L7, which is `brief`'s own layer: the
  // edge would no longer point strictly down, so `brief` would have to rise to L8
  // and `hooks`, `services`, `tools`, `index`, `diagnostic-report` and `diagnose-cli`
  // with it — the seven raises an earlier revision of this table made and the review
  // withdrew (R27) — all of that for a string bound. L5 is also what lets `brief`
  // (L7) and `services` (L8) import this module downward, which is the only shape in
  // which the brief can verify before it injects.
  'curation-view': 5,
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
  // `hooks` imports `DEFAULT_BRIEF_BUDGET_CHARS` from `brief` (L7), which puts it at
  // L8; Task 4's view work left that layer where it was (R27).
  hooks: 8,
  // The tool contract reads `DEFAULT_LIMIT` from `index-db` (L2) and nothing
  // else, which puts it at L3; the registrations import the contract and nothing
  // else, which puts them at L4. Both were inside `tools.js` before Task 11.
  'tool-schema': 3,
  'tool-registry': 4,
  // The service layer calls `buildBrief`, so it sits above `brief`; that single
  // edge is what fixes its layer, and it is the reason the split is L7/L8/L9/L10
  // rather than three files at the old `tools` layer.
  //
  // Task 4 put the view verification inside `buildBrief`, so this file imports
  // `curation-view` (L5) too — an edge that points down from L8 and therefore needs
  // no raise. An earlier revision raised `brief` (and this file with it) on the
  // false premise that the import required one; the review withdrew those seven
  // raises (R27) and this table is the reviewed numbers without them.
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
  // Raised from 200 by the Task 5 fix round (210 formatted lines measured; the
  // file's rule is measured plus 30 rounded to the next 50, so 250 is the rule's
  // number). What the 10 lines buy: the closed `code` vocabulary the curation call
  // sites actually supply — the scanner's four truncation reasons, the eight state
  // payloads whose read is refused, the view build's two judged refusals and the
  // binding refusal — declared as one list so the rule "a code a call site emits is
  // registered here" stays checkable in one place, which is the same argument the
  // `review` comment at `OUTCOMES` above makes for outcomes.
  'lib/diagnostic-codec.js': 250,
  'lib/diagnostic-journal.js': 300,
  'lib/diagnostic-report.js': 350,
  'lib/diagnose-cli.js': 100,
  'lib/assets.js': 600,
  // Raised from 1150 by Task 4 (1275 formatted lines measured at the Task 4 commit,
  // 1278 after the fix round's own edit, where the rendered-length selection replaced
  // the `budget / 64` divisor). The rule elsewhere is measured plus 30 rounded up to
  // the next 50, which for this file would be 1350: 1310 is deliberately inside that
  // (measured plus 32), so the entry hides no debt behind the rounding. What the 128
  // lines over the old 1150 buy: the `view` section between the conventions and the
  // recent list, the
  // substitution rule that only replaces that list when the view provably carries
  // every path it would have shown, the cross-section path dedupe that keeps one
  // fact from arriving twice under two headings, the entry renderer that spells out
  // every alternative path of a collapsed group, and the verify-then-inject helper
  // that hashes the selected entries through the vault jail before one line of them
  // is emitted. The alternative — having `services` verify and hand `brief` a
  // pre-approved list — moves the decision the plan puts inside `buildBrief` out of
  // it, and would leave the one function that injects the text unable to say why it
  // fell back. Five of the lines over the pre-comment measurement are the prose about
  // why a cut entry is dropped *before* the budget — the first draft of the comment
  // claimed the budget would have covered it, and that is not true.
  'lib/brief.js': 1310,
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
  // Raised from 2100 by Task 6 (2157 formatted lines measured; measured-plus-30
  // would round to 2200). What the 56 lines buy: the `onCurationCompleted` seam on
  // `processQueue` and its context field, the collected committed-path list, the
  // durable hint enqueue and the advisory call after it, and the worker's
  // `setOnCurationCompleted` plus the re-read of the callback on every pass. The
  // alternative was for the assembly to infer "did this job write" from the receipt,
  // which is exactly the guess R5 forbids: a parked candidate's receipt has no path.
  // The raise stays inside the measured-plus-30 rule rather than following it.
  // Raised again from 2160 by the Task 6 fix round (2194 formatted lines measured;
  // measured-plus-30 would round to 2250, so this stays inside the rule as the
  // previous raise did). What the 34 lines buy: the wrapper that makes the advisory
  // curation callback unable to fail, delay or go unobserved for a job whose vault
  // writes are already durable — a synchronous throw used to reach this pass's catch
  // and become a `failJob` attempt, which at `maxAttempts` marked a fully applied job
  // `failed` with no receipt, and a rejected promise used to be an unhandled
  // rejection. The alternative, letting the callback's owner be the only guard, is
  // what the review found: the seam has no owner when the wiring omits one.
  'lib/capture.js': 2200,
  'lib/config.js': 300,
  // The curation plan's three Task 2 modules, on the same rule as every other
  // entry (measured plus 30, rounded up). What the size buys: the scanner carries
  // the coverage rules a bounded pass has to keep honest, the state module carries
  // the permission, size and version checks for three documents, and note-health
  // carries the linter's own wording so the two cannot drift.
  'lib/note-health.js': 300,
  // Raised from 800 by Task 4 (890 formatted lines measured). The view document's
  // bytes moved in here rather than into `lib/curation-view.js`, which is what the
  // plan's file map asks for ("view-file IO with size/version checks"): the path, the
  // version and project check, the size bound and the atomic replace are the same
  // three checks the cursor and the records already carry, and the reader is the one
  // place that can answer "are these trustworthy bytes?" without importing a view
  // concept. The lines are those two functions plus the module comment that says why
  // a damaged view is a cache miss where a damaged cursor is an error.
  'lib/curation-state.js': 950,
  // The Task 4 module (491 formatted lines at the Task 4 commit, 534 after the fix
  // round's comment corrections). Its measured-plus-30 rounded number would be 600;
  // 550 is deliberately inside that (measured plus 16), so — as with `brief.js` —
  // the next raise has to argue with this line rather than inherit the rounding.
  // What the size buys: the
  // stored entry shape and its bounds, the exact-group rule re-applied over a merge
  // of two different sources, the merge itself, the all-members verification, and
  // the build's three cases — replace, merge, or refuse an incomplete backfill.
  'lib/curation-view.js': 550,
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
  // Measured again at 1243 formatted lines on `fix: pin every curation link claim to
  // a probe row` (the fifth and last Task 2 fix round, measured-plus-30 would be
  // 1273). The budget stays at 1257 rather than following that rule upward: the
  // round added no code, only the probe-pinned rewrite of the resolver comment, the
  // sentence stating when a truncated-universe link finding comes back, and the
  // matching prose in `lib/note-health.js`, and the raise has to be argued for by
  // what the lines buy.
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
  // Raised from 1150 by the Task 6 fix round (1208 formatted lines measured;
  // measured-plus-30 rounds up to 1250, which is this number). What the 58 lines buy:
  // the once-per-session due request (`planCurationDue`) at the same activity seam as
  // the weekly hint — the DSH half of the brief's "a due check on DSH session
  // activity", which no DSH path implemented before this round — plus the
  // `onCurationDue` seam, its state flag and the comments that say why the request is
  // handed to its owner instead of awaited. The alternative was a lifetime hook in
  // `lib/index.js` polling for activity, which would be a timer this plugin
  // deliberately does not have.
  'lib/hooks.js': 1250,
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
  // Raised from 200 by the Task 6 fix round (221 formatted lines measured;
  // measured-plus-30 rounds up to 300, so 250 is deliberately inside the rule and the
  // next raise has to argue with this line). What the 21 lines buy: the second
  // automatic trigger — the due callback `lib/hooks.js` fires once per session — the
  // `disposed` flag that stops a pass from being scheduled after the fiber unloads,
  // and the one comment that records why the two automatic gates read
  // `autoCurate !== false` while the result reports `=== true`.
  'lib/index.js': 250,
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
  // Raised from 900 by Task 5 (948 formatted lines measured). What the 48 lines
  // buy: the `curation` result arm (the bounded status/scan shape a caller reads),
  // the `operation` parameter with its `status`/`scan` enum and its description, the
  // new action in `mem_admin`'s enum, and `forwardAdminArguments` applying that
  // parameter's documented default. The alternative — a second schema module for
  // one action — would put the action list in two files, which is the drift the
  // diagnostics enum comment above already records once.
  // Raised to 1000 by the Task 5 fix round on the file's own measured-plus-30 rule:
  // 948 measured plus 30 is 978, which rounds up to 1000 — the rule's number, as the
  // sibling `lib/services.js` entry spells out its own. 950 was inside that rule
  // without saying which number it was inside, which is the debt this line removes;
  // the fix round added no line to this file, so the raise is bookkeeping rather than
  // new space.
  'lib/tool-schema.js': 1000,
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
  // Raised from 1150 by Task 5 (1477 formatted lines measured). The curation
  // orchestration belongs here rather than in a module of its own: it is the layer
  // that already owns the read-only project resolution and the R14 cloud-managed
  // refusal, and `curateCurrentProject` exists precisely so the Codex adapter calls
  // one shared method instead of reimplementing those guards. What the 327 lines
  // buy: `curateForBinding` (the view-then-queue traversal choice, the 24-hour due
  // marker, the acknowledgement that follows the view write and covers only the
  // paths a pass inspected), the scan→proposal call into `recordCurationFindings`,
  // the closed and bounded response projection shared by `status` and `scan`, the
  // proposal listing, and the `curation` diagnostics that record an outcome and
  // counts without a path or a note. Splitting the policy out would put one
  // decision in two files. The measured-plus-30 rule would round to 1550; 1500 was
  // deliberately inside it, so — as with `brief.js` and `curation-view.js` — the
  // next raise has to argue with this line rather than inherit the rounding.
  // Task 6 argues for it: 1544 formatted lines. What the 44 lines buy: the
  // `queueCurationHint` helper for the tool write path, the `onCurationHint` seam it
  // calls once the hint is durable, the `autoCurate` guard around both and the catch
  // that keeps a throwing trigger from retracting a committed receipt. The
  // alternative — the assembly enqueueing for the write path itself — would put the
  // private curation state in two modules and the R14/binding guards in two places.
  // Task 5's fix round raises it to 1600 (1575 formatted lines measured; measured
  // plus 30 rounds up to 1600 on the rule above). What the 31 lines buy: gating the
  // acknowledgement on `buildCurationView` returning `written` rather than on the
  // attempt — a `fallback` build writes nothing, so acknowledging off it would drop
  // the batch from the durable queue and from the view at once, which is the plan's
  // ordering guarantee made real — plus the reported fallback reason, the two-line
  // `buildView` seam that lets a case drive a fallback the service's own inputs
  // cannot reach, and the comments that withdraw the two claims the review found
  // false (the scanner's cursor, and the code precedence).
  'lib/services.js': 1600,
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
