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
  // The fixed curation `code` vocabulary, added by the Task 5 fix round 2 (R33). It
  // imports nothing, which is what lets the four modules that raise these codes
  // (L4–L6) and the codec that persists them (L1) point at one list instead of the
  // codec holding a second copy. The alternative — the codec importing the emitters —
  // is the upward edge this table exists to refuse.
  'curation-codes': 0,
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
  // Server-side locale vocabulary (English panel UI): the panel's dialogs and the
  // route resolve zh/en here. The two browser assets cannot import it — each is
  // served standalone — so they inline the same primary-subtag rule instead.
  locale: 0,
  'graph-activity': 0,
  'graph-route': 1,
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
  // The note-level LANGUAGE rules (Task 17), and a leaf for the same reason as
  // `note-health`: `distill` (L2) tells the model how to write a note and reports
  // where its own note missed, while `lint` (L5) reports the same rules across a
  // vault written months earlier by an older prompt. One list, two readers — a
  // second copy would drift the moment either was tuned, and the drift would read
  // as a linter bug rather than a decision.
  'note-style': 0,
  // The failure signal (Task 18): a leaf like `note-style`, imported downward by
  // `hooks` (L8), which decides when to ask, and by `capture` (L6), which owns the
  // same event stream. Also read by the L1 failure-memory policy below distill:
  // this import-free event classifier belongs at L0 with the vocabulary leaves.
  // The filesystem primitives every durable writer shares (2026-10-28). A leaf
  // with no repository import, which is what lets the seven writers that had each
  // grown a private "temporary → fsync → rename → directory fsync" copy point down
  // at one definition instead of drifting: Windows fails that rename with EPERM
  // while another handle still holds the destination, and NTFS has no POSIX mode
  // bits, so both facts belong in exactly one module.
  'fs-atomic': 0,
  'failure-streak': 0,
  // The unbound-session notice: which refusal reasons get one injected hint, and
  // the wording of each. A leaf with no repository import at all — deliberately,
  // because a hint has to be answerable without reading a vault or a filesystem —
  // so `hooks` (L8) points down at it for the one decision it does not own.
  'init-hint': 0,
  'user-source': 0,
  'habit-semantic': 1,
  'habit-store': 4,
  'habit-curation': 4,
  'failure-memory': 1,
  assets: 1,
  frontmatter: 1,
  git: 1,
  registry: 1,
  routing: 1,
  distill: 2,
  // The shared tokenizer both the index and the v0.4 sparse ranker call. A leaf
  // with no repository import, so `retrieval-rank` (L1) can use it without the
  // lateral edge into `index-db` (L2) that a same-file tokenizer would create.
  'index-text': 0,
  'index-db': 2,
  // The pure halves of the 概览 aggregates: day arithmetic, the activity window
  // and bucketing, the project-scope predicate and the tag ranking. Extracted from
  // `index-db` (2) so the two backends call one projection instead of each keeping
  // a copy of the bucketing rule — the disagreement the index exists to prevent.
  // L1 rather than L0 only because the window needs today's local day from
  // `note-health` (L0); nothing here imports a backend or a filesystem.
  'index-stats': 1,
  receipts: 2,
  pending: 3,
  search: 3,
  // The v0.4 sparse retrieval baseline. The ranker imports the shared tokenizer
  // from the `index-text` leaf (L0) so the lexical and sparse sides cannot drift
  // without giving `search` (L3) a lateral edge; the provider contract imports
  // only Node builtins and stays a leaf.
  'retrieval-rank': 1,
  'retrieval-provider': 0,
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
  // The executor half of the same queue (Task 7): it reads the stored record, the
  // vault jail, the memory layer's ownership proof and the transaction engine, and
  // it must therefore sit *above* all of them — L6 is the first layer that is
  // strictly above `memory` (L5), which is also what lets a review be driven from
  // the command line without either of them importing the other. Its three L6
  // neighbours (`capture`, `hot`, `curation-scan`) are unrelated to it: no edge
  // exists in either direction, which is what the layer rule actually requires.
  'curation-review': 6,
  lint: 5,
  'curation-scan': 6,
  // The interactive review command (Task 7). It sits at the same layer as the
  // façade because it is an entry point above the whole library, and it imports
  // `curation-review` (L6) and `curation-proposals` (L5) rather than re-deriving
  // either. It is deliberately *not* below `tools`: nothing in the tool surface may
  // reach an approval, and an edge from `tools` to this module is the edge that
  // would create one.
  'curation-cli': 9,
  // The two pure halves the hot/brief refactor split out, and why they sit at the
  // bottom: `hot-text` is the hot file's format itself (no repository import at
  // all), `hot-archive` is the planner over it (the text layer only), and
  // `brief-coverage` is the brief's budget/render half (also import-free, so the
  // brief's L7 edge down at it cannot cycle through the hot layer). The three
  // callers keep their old layers — `hot` (L6) and `brief` (L7) — because a
  // module that composes a lower layer is not a peer of it.
  'hot-text': 0,
  'hot-archive': 1,
  'brief-coverage': 0,
  // The v0.4 delivery pair. `hot-delivery` is the pure decision over values and
  // imports only node:crypto, so the brief (L7) and hooks (L8) both point down at
  // it. `delivery-state` is the private persistence: it adds the shared receipts
  // I/O (L2) and routing hash (L1) on top of that leaf, which fixes L3; the
  // convention cursor (L4) reuses its state primitives instead of a second writer.
  'hot-delivery': 0,
  'delivery-state': 3,
  'convention-rotation': 4,
  // The browser route fence is import-free; the panel route receives the
  // services through its arguments but resolves the request locale (L0), reads
  // one date helper (L0) and calls the mutation state machine (L1), which fixes
  // L2. `appraisal` is the pure deterministic rule set the digest uses and
  // imports note-health (L0).
  'route-guard': 0,
  'panel-route': 2,
  // The panel's dialog copy is a vocabulary leaf like `hot-text` and `locale`:
  // import-free, one sentence per locale, read by `panel-actions` so a
  // translation never touches the mutation state machine.
  'panel-copy': 0,
  // The v0.4 confirmed-mutation state machine imports `node:crypto` and now
  // composes the locale vocabulary and the dialog copy (both L0); the route
  // passes the services and the preview clock in, so it still invents no
  // service-layer dependency. Raised from 0 to 1 by the English dialog copy.
  'panel-actions': 1,
  appraisal: 1,
  // The deterministic digest collector is injection-only: no repository import,
  // no filesystem of its own, and the service owns both readers.
  digest: 0,
  // The owned writer sits above `memory` (L5) because it proves the target's
  // ownership and publishes through the L3 transaction engine, never by a direct
  // file write.
  'digest-write': 6,
  // The one served browser module the panel shell imports at runtime. It has no
  // repository import (React arrives through createMemoryViews), so its layer is
  // the browser-entry layer rather than a host layer.
  'memory-panel': 1,
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
  // sites actually supply, declared as one list so the rule "a code a call site emits
  // is registered here" stays checkable in one place, which is the same argument the
  // `review` comment at `OUTCOMES` above makes for outcomes. The count that comment
  // gave — "the scanner's four truncation reasons, the eight state payloads …" — was
  // wrong in both halves, which is what round 2 exists to fix.
  // The Task 5 fix round 2 (R33) moves that list to `lib/curation-codes.js` and
  // *derives* it here, because the round-1 list was still incomplete: it held four of
  // the scanner's five truncation reasons (`manifest-budget` was missing), and the
  // cursor, state, changed-set, view and proposal families were absent, while the case
  // that looped it looped a hand-written copy that could not fail. The measured 233
  // lines are the derivation, the comments naming what stays dynamic
  // (`view-unwritable:<code>`) and the round trip the new case drives. Raised from 250
  // to 300 by the unbound-session notice (265 formatted lines measured; measured-plus-30
  // is 295, which rounds up to 300). What the 15 lines buy: the `bind-hint` code the
  // `brief` event now emits, the `vault`/`not-bound` refusals a `bind` diagnostic can
  // carry, and the comment recording which part of that vocabulary stays dynamic —
  // without them the journal wrote `other` where the ring had the token.
  'lib/diagnostic-codec.js': 300,
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
  // Raised from 1310 to 1400 (1356 formatted lines measured; measured-plus-30 is
  // 1386, so the raise stays inside the rule rather than following it). What the
  // 46 lines buy: the user's declared habits became a first-class section — the
  // group-label renderer that keeps 惯用方法 readable as a group and drops a heading
  // that has no bullet under it, so an untouched template injects nothing — and the
  // section moved above the recent-decisions list, with the comment that argues the
  // new order. Both are decisions a reader has to be able to audit in place.
  // Raised from 1400 by the coverage-first brief: the coverage return value, the
  // paging dispatcher and the conventions preview. Measured 1413 formatted lines;
  // measured-plus-30 is 1443, rounded to 1500.
  // Raised from 1500 by the v0.4 delivery half: the receipt-bearing composition
  // (`delivery.emitted/removed/continuation`), the oversized-unit skip that keeps
  // later units fitting, continuation windows that never clip a unit, the bounded
  // cursor paging for section "hot", and one shared `renderHotUnit` so the delivered
  // line, its version hash and the page cannot disagree. Measured 2068 formatted
  // lines; measured-plus-30 is 2143, rounded to 2150.
  'lib/brief.js': 2150,
  // The composition half extracted from `brief.js` (207 formatted lines measured;
  // measured-plus-30 is 237, which rounds up to 250). The budget fixpoint, the
  // section renderer and the footer are what a plain string can exercise, so they
  // live below the module that reads a vault.
  // Raised from 250 by the coverage note/footer and the small-budget fallback:
  // measured 362 formatted lines; measured-plus-30 is 392, rounded to 400.
  'lib/brief-coverage.js': 400,
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
  // Raising this from 2200 by the final whole-branch fix wave (2211 formatted lines
  // measured; measured-plus-30 is 2241, which rounds up to 2250). What the 11 lines
  // buy: the queue worker's copy of the changed-path cap report — the accumulated
  // `dropped` count and its one content-free `curation` diagnostic per job — beside a
  // comment that no longer claims a full pass re-reads the paths it already covered.
  'lib/capture.js': 2250,
  // Nested unknown-key validation and integrated distillation options.
  'lib/config.js': 400,
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
  // The Task 4 module (495 formatted lines at the Task 4 commit, 534 after the fix
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
  // Lowered to 1247 by Task 5 fix round 3, which deleted the 13-line
  // `CURATION_TRUNCATION_REASONS` copy this file carried: nothing imported it (the
  // codec derives the vocabulary from `lib/curation-codes.js`, which is the single
  // source) and its comment claimed a derivation that did not exist. 1247 is the
  // measured 1244 plus 3, so the deletion is spent as budget instead of slack and the
  // file is tighter than every round before it.
  // Raised from 1247 by the final whole-branch fix wave (1259 formatted lines measured;
  // measured-plus-30 is 1289, which rounds up to 1300). What the 12 lines buy: the
  // resolver comment now names the third silence shape (a bare dot-bearing target) and
  // states the probed carrier of the `[[LICENSE]]` answer instead of a vault-root copy
  // the matrix's fixture does not contain, and the `resolver-truncated` comment says
  // which two halves the covering case asserts. Both are the finding's demand that a
  // comment not name a shape the matrix does not pin.
  // Task 10 raises this to 1350 (1314 formatted lines at f22c982, plus 30 rounded to
  // 50; 1324 after the follow-up fix round moved the cursor snapshot before the walk).
  // Said plainly, because 1350 is now deliberately *inside* the rule above: 1324 + 30
  // is 1354, which would round up to 1400, so this budget was chosen as the nearest 50
  // rather than derived from the formula, leaving 26 lines of headroom.
  // The added lines preserve full-title near identity, explicitly rebuild legacy
  // records, distinguish operational write failures from programming defects,
  // and reject a stale cursor publication against another pass's snapshot.
  // No module or layer is added; the local date formatter is shared at L0.
  'lib/curation-scan.js': 1350,
  // The Task 3 module, on the same measured-plus-30 rule (1113 formatted lines,
  // 1115 with the two-line comment that makes the listing order intentional).
  // What the size buys: two proposal kinds with different operations, four
  // review-only finding kinds, an identity derivation and a content hash that have
  // to disagree in exactly the right places, an exclusive-create publication that
  // survives two processes racing one identity, and the scan→proposal recording
  // that has to replay rather than duplicate. Splitting the store from the recorder
  // would put one identity derivation in two files.
  'lib/curation-proposals.js': 1150,
  // The Task 7 executor, on the same measured-plus-30-rounded-to-50 rule (608
  // formatted lines measured). What the lines buy: the operation ledger that refuses
  // anything but `create-separate` and `supersede`, the explicit request-field list
  // that keeps a candidate's `id` out of the write (R6), the pre-transaction source
  // verification that names `source-changed` / `source-unsafe` / `human-owned`
  // instead of one generic refusal, the review claim that arbitrates two concurrent
  // reviewers, and the renderer a reviewer reads before typing a confirmation.
  // Raised from 650 by the Task 7 fix round 2 (764 formatted lines measured on
  // `fix: make the review claim exclusive and its refusals declared`, so 800 is the
  // same rule's number). What the 114 lines buy, each from a finding that a measurement
  // rather than a reading produced: the claim is now installed by `link()` and the
  // stale-claim retirement content-checks the bytes it moved, because the
  // rename-then-create this file used to describe let a second reclaimer move a *fresh*
  // claim and both reviewers proceeded (before: `renames=2 creates=2 applied=2`; after:
  // one applied); the ownership translation table so the three refusals
  // `assertPluginOwnedNote` raises are declared answers instead of codes escaping
  // through a dynamic emitter site; the private-state table and the wrapped first
  // record read so a corrupt cache is answered as `proposal-unreadable` rather than
  // thrown; and the prose that has to name the guarantee the mechanism actually
  // provides, since this module's earlier comments claimed one it did not.
  // Fix round 3 leaves this number alone — 787 formatted lines measured on
  // `fix: never reinstate a claim its owner released`, still inside the same rule. What
  // changed is one behaviour and the prose around it: the retirement now *withdraws* the
  // bytes it moved instead of linking them back, because a restore recreated a claim its
  // owner had already released, and the module names the three-reviewer window that
  // withdrawal opens instead of a mutual exclusion the mechanism does not provide.
  // Task 9 replaces that historical reclaim/withdrawal protocol with a short SQLite
  // guard around claim mutations. The module shrinks; the budget and layer stay unchanged.
  // Raised from 800 to 850 by the Windows claim-guard fix (803 formatted lines
  // measured; measured-plus-30 is 833, rounded up to 850). What the 17 lines buy: the
  // pre-open refusal of a named guard entry that is not a plain file. Without it,
  // `O_CREAT` follows a dangling symlink on a platform with no `O_NOFOLLOW` (Windows)
  // and creates the link's target outside the data root; the existing post-open
  // inode/hardlink check cannot catch that because the creation has already happened.
  'lib/curation-review.js': 850,
  // The interactive command is mostly argument handling and the refusal text a
  // person reads; 223 lines is the measured size and 250 is the rule's number.
  'lib/curation-cli.js': 250,
  // Raised from 950 for the configurable item-count ceiling. The prompt must name
  // the ceiling the validator enforces (`too-many-items` refused a whole batch of
  // 21 against 16 because it did not), and a ceiling that comes from config cannot
  // be a literal in a module constant: it costs one exported slot, one substitution
  // helper and their JSDoc. The alternative — a second prompt string beside the
  // validator's vocabulary — is the drift this file's tests exist to prevent.
  //
  // Raised again from 975 to 1050 by Task 17 (1011 formatted lines measured). What
  // the 36 lines over the old budget buy: the note-language rules in the prompt
  // (5 lines of text plus the comment recording which of STE's rules were measured
  // and refused), the style call in `validateItem` and its comment explaining why
  // only `language` reroutes a candidate while the other four rules are reported,
  // and the import. 1050 rather than the file's earned 1011: the next rule added
  // should not have to edit a budget, and the rules live in `note-style.js`, which
  // has its own entry. This one is over the "measured plus 30 rounded up" rule
  // deliberately — the prompt text is prose, and a prompt that is trimmed to fit a
  // line budget stops being a prompt.
  // Raised from 1050 to 1130 by the user-habit clause (1076 formatted lines measured;
  // measured-plus-30 is 1106, which rounds up to the next 50). What the 26 lines buy:
  // the habit prefix and tag constants, the prompt sentence that names them — including
  // the rule the validator refuses by, which is the property this file's contract tests
  // exist to keep — and the one per-item refusal that keeps a habit the user never stated
  // out of the vault. The alternative, asking a model for habits with no evidence rule
  // behind it, is the "preference nobody expressed" this pipeline is built not to write.
  'lib/distill.js': 1130,
  'lib/frontmatter.js': 1100,
  // The failure classifier and its streak (Task 18). Most of the file is the
  // pattern table and the comments recording what each pattern had to exclude:
  // two measured corrections to the soft signal (case folding made `\bE[A-Z]{3,}\b`
  // match `export`; unscoped, the signal fired in 31 of 60 sessions) live in those
  // comments, and a reader who cannot see them will reintroduce both.
  // Shared legacy/v4 envelopes, bounded call identities and nested-dispatch
  // de-duplication add host-format handling (formatted measurement below).
  // The one platform seam: retryable Windows rename, tolerant directory fsync and
  // the `isPrivateMode` predicate the diagnostics readers use. The repository's
  // measured-plus-30 rule (329 formatted lines measured, so 359 + rounding to 400)
  // rather than a guess; a fourth primitive is a decision to argue with this line.
  'lib/fs-atomic.js': 400,
  'lib/failure-streak.js': 550,
  // Recording is an independent pure policy below distill; no vault I/O or writer.
  'lib/failure-memory.js': 175,
  // Source guards, quoted proposals and queue composition replace the separate learner.
  'lib/user-source.js': 100,
  'lib/habit-semantic.js': 150,
  'lib/habit-store.js': 125,
  'lib/habit-curation.js': 175,
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
  // Raised from 1250 to 1400 by Task 18 (1362 formatted lines measured). What the
  // 112 lines over the old budget buy: the failure-triggered recall — reading the
  // session's new tool events, asking `failure-streak` whether this is a run rather
  // than a one-off, and planning that retrieval inside the SAME `recallBudgetChars`
  // the prompt-driven recall uses (a second budget would double the per-step
  // ceiling the 0.6%-firing-rate measurement is about) — plus the three comments
  // that record why the ordering is what it is. Raised to 1400 rather than the
  // earned 1362+30=1392 so the next event-shape fix does not have to edit a budget.
  // Raised from 1400 to 1500 by the unbound-session notice (1483 formatted lines
  // measured, so 1500 is inside the rule's measured-plus-30 by 17 lines). What the 66 lines buy: the resolution memo
  // now keeps the whole answer instead of only the bound half — `resolutionFor` plus
  // the `boundBinding` wrapper the four other call sites still use — the once-per-
  // session hint planner with the `header.cwd` guard that stops it describing the
  // process directory, `sessionCwdOf` split out of `cwdOf` for that guard, and the
  // `brief` diagnostic that reports `hint-only` with `bind-hint` instead of claiming
  // a brief was injected. The alternative was a second resolution pass per step,
  // which would let the two answers disagree.
  // Raised from 1500 by the coverage summary the brief diagnostic carries.
  // Measured 1514 formatted lines; measured-plus-30 is 1544, rounded to 1550.
  // Raised from 1550 by the v0.4 delivery seam: preparation before the host output
  // exists, the committed `session/event` acknowledgement that only advances what
  // the final message carried, the continuation planner with its two-per-generation
  // cap, discard-on-rejected-plan, and the epoch bump on clear/compact. Measured
  // 1841 formatted lines; measured-plus-30 is 1871, rounded to 1900.
  'lib/hooks.js': 1900,
  // Raised from 600 by the hot-zone deadlock fix (1069 formatted lines measured;
  // measured-plus-30 is 1099, which rounds up to 1100). What the 469 lines buy:
  // archival that can tell a pointer line from an entry — the reported bug, since
  // `HOT_ENTRY_PATTERN` matches both — an archive append that is idempotent per hot
  // id instead of filing its own output, a refusal that names every zone and the
  // route out of it, and the route itself: `hotStatus` plus `compactHot`, which
  // folds the 已完成 zone pointers into one line and drains 已完成 and 进行中 in
  // one transaction. The alternative was a second module for three functions that
  // share every one of those helpers, which would have moved the lines rather than
  // removed them.
  'lib/hot.js': 1100,
  // The two halves extracted from `hot.js`, on the same measured-plus-30 rule as
  // every entry here (222 and 267 formatted lines measured; 252 and 297 round up
  // to 300). Separate files, so a breach names the half that grew: the format and
  // its predicates in `hot-text`, the archive planner in `hot-archive`.
  'lib/hot-text.js': 300,
  // Raised from 300 by the aggregate-pointer fix: the one-archive-line-per-zone
  // planner, the legacy fold and the post-aggregate shrink test are cohesive in
  // this module. Measured 329 formatted lines; measured-plus-30 is 359, rounded
  // up to 400.
  'lib/hot-archive.js': 400,
  // The v0.4 delivery receipts, measured on the formatted tree: 301 and 1136 lines
  // after the acknowledgement-gating fix round; measured-plus-30 is 331 and 1166,
  // rounded to 350 and 1200. The pure half keeps
  // the version/selection rules and the cursor; the persistence half holds the
  // bounded state, private primitives (bounded JSON, atomic write, short lock,
  // symlink refusal), the 8 MiB structural transcript reconciler and discarded-plan
  // cleanup, which is why it is the larger file. The convention cursor is 261 lines;
  // 291 by the rule, rounded to 300.
  'lib/hot-delivery.js': 350,
  'lib/delivery-state.js': 1200,
  'lib/convention-rotation.js': 300,
  // Measured 83 and 263 formatted lines; measured-plus-30 is 113 and 293, rounded
  // to 150 and 300. `panel-route` is larger than the plan's estimate because it
  // owns the action allowlist, the asset list and the unbound state in one place
  // rather than splitting a 60-line helper out. The v0.4 preview/confirm fence,
  // capabilities and bounded failedJobs grew it to 623 measured (653 by the rule,
  // rounded to 700); the mutation state machine is its own 850-line module (880 by
  // the rule, rounded to 900) so the route keeps its read-only dispatch small.
  'lib/route-guard.js': 150,
  // Raised from 700 by the v0.4 chart data plane (Task 2): 概览 now carries the
  // 84-day `activity` series and the twelve-row `tags` ranking, and `shrink()`
  // follows a seven-stage order instead of halving the three lists it had. The
  // 49 added lines are that payload's feature-detected readers, the trimmer that
  // keeps days/created/updated/`from` in step, and the digest stage the order
  // was missing. Measured 749 formatted lines; measured-plus-30 is 779, rounded
  // up to 800. The mutation state machine stays in its own module.
  // The joint-flow trim stage measured 763 formatted lines; measured-plus-30 is
  // 793, inside the same ceiling.
  // Raised from 800 by the 2026-10-31 chart/live round (888 formatted lines measured;
  // measured-plus-30 is 918, rounded up to 950). What the 88 lines buy: the heat map's
  // year window (ACTIVITY_DAYS_MAX 182 -> 371) and the 20 KiB overview ceiling with
  // its measured evidence, the per-index refresh throttle that makes a memory written
  // by another process visible without a DSH restart (WeakMap + stamp-before-await +
  // scanning skip + swallowed failure), and the mutation fence rewritten for the
  // desktop GUI: its dsh-app:// proxy strips Origin, so the fence now accepts a
  // matching Origin or the panel's own x-obsidian-mem-panel header, which a cross-site
  // page cannot send without a preflight this route never answers. The route still
  // owns exactly the read dispatch and the two confirmed mutations; the mutation state
  // machine stays in lib/panel-actions.js.
  // Raised from 950 by the same day's round-5 fixes (974 formatted lines measured;
  // measured-plus-30 is 1004, rounded up to 1050). What the 24 lines buy:
  //   * the session-missing status moved from 404 to 503 — 404 is what the browser
  //     asset reads as "this route is not registered", so a session still resuming at
  //     startup used to show the fatal restart notice and stop polling;
  //   * the day-diverse 最近变化 feed: one internal index.recent({limit: 500}) scan,
  //     then up to 2 rows from each of the newest 4 updated days so a busy day cannot
  //     hide yesterday. The wire stays <=8 rows, so the byte ceiling is untouched —
  //     these are selection lines, not payload. The wide internal scan is why
  //     lib/index-db.js's recent() bound moved from 50 to 500 in the same round.
  'lib/panel-route.js': 1050,
  'lib/panel-actions.js': 900,
  'lib/appraisal.js': 300,
  // Measured 280 formatted lines; measured-plus-30 is 310, rounded to 350.
  // The collector owns the window, the 200-source/500 ms bound, the honest
  // incomplete reasons and the renderer; the service supplies every reader.
  'lib/digest.js': 350,
  // Measured 255 formatted lines; measured-plus-30 is 285, rounded to 300.
  // The writer owns the day-granular note projection, ownership proof, the
  // unchanged-byte no-op and the transaction request; the collector stays pure.
  'lib/digest-write.js': 300,
  // Measured 806 formatted lines; measured-plus-30 is 836, rounded up to 850.
  // The one module holds the three view components and their shared card kit;
  // the alternative was four assets and a second host-remount constraint.
  // Raised from 850 by the v0.4 vault-ledger redesign: the masthead, ordinal
  // tab index, ledger rows with tabular numerals, composition index, numbered
  // recent list, health stamps/meters, the newspaper digest column and the
  // preview→confirm sheet (focus trap, aria-live status, stale/replay handling)
  // all live in the one served asset. Measured 1329 formatted lines;
  // measured-plus-30 is 1359, rounded to 1400.
  // Raised from 1400 by the single-status phase (1416 formatted lines measured;
  // measured-plus-30 is 1446, rounded to 1450). What the 46 lines buy: the
  // derived status derivation and its one SearchStatus region, the run-scoped
  // unbound notice carried across its own continuation, the removal of the
  // second loading owner in StatusLine/refreshButton, and the real last-read
  // timestamp so a stale search error never says 上次更新 —.
  // Raised from 1450 by the modern-view markup phase (1606 formatted lines
  // measured; measured-plus-30 is 1636, rounded to 1650). What the 156 lines buy:
  // the KPI buttons and composition bar/legend, the ordinal-free recent rows, the
  // 検索 search field/clear control/named filter groups, the marked snippets and
  // chip rows, the 健康 summary band and 诊断记录 timeline, and the sheet's focus
  // restore plus a Tab trap that holds while both actions are busy.
  // Raised from 1650 by the five 概览 charts (Task 4b): the activity heat map, the
  // shared-zero-line flow bars, the tag ranking, the KPI sparkline and the
  // composition restyle. Measured 1861 formatted lines; measured-plus-30 is 1891,
  // rounded up to 1900. The module stays the one place a chart can live — it is
  // served to the browser as-is, so a charting dependency would have to be shipped
  // as a second asset, and the five shapes are less code than that dependency's
  // adapter. Nothing here duplicates the payload: every chart reads the same
  // `activity`/`tags` fields the route already sends.
  // Raised from 1900 to 2050 by the review fix round: the heat map now draws the whole
  // calendar instead of discarding its head column, each cell carries a date-and-value
  // reading, the tag remainder counts distinct tags rather than occurrences, and the
  // composition track folds its overflow into a real third segment instead of aliasing
  // a colour. Measured 1966 formatted lines; measured-plus-30 is 1996, rounded up to
  // 2050. This raise buys correctness, not new surface: no chart was added.
  // The review's Minor fix round kept the same ceiling: measured 2010 formatted lines
  // after it (void cells gain `aria-hidden`, the sparkline resamples to twelve weekly
  // points, the flow-bar title names the ISO week, and the `heatmap()` JSDoc stops
  // promising a `<title>` child the shipped markup cannot host); measured-plus-30 is
  // 2040, rounded up to 2050. The round after that (the re-review's I-1) measured 2019:
  // the flow bars became Sunday-first calendar weeks — the same buckets the heat map
  // draws — with their own week-of-year helper and the derived empty-state sentence,
  // which is the extra lines inside the idle ceiling (2049), so no raise was needed.
  // Raised from 2050 to 2400 by the 构成 Sankey: the joint type×status flow model
  // (`sankeyModel`), the unit-per-note layout with per-column centring and a
  // no-avoidable-crossing stack, the clipped-label row layout, and the SVG render
  // with one native <title> per node and link. Measured 2358 formatted lines at the
  // task handoff; the review fix round that followed (a two-pass label-row layout for
  // sliver clusters, the 1px leader per displaced label, the cross-column/notes total
  // guard, the status column's neutral moved off the type palette's seg3 tint, and the
  // chart-width cap) measured 2417; measured-plus-30 is 2447, inside the same ceiling.
  // What the 367 lines buy: one more
  // chart shape, built inline from the payload the route already sends (no charting
  // dependency), plus the consistency guard that refuses to draw when the joint
  // counts disagree with the margins. The previous bar+legend path stays in the
  // file as the fallback branch rather than being replaced line for line — an older
  // host, or a payload whose flow the trimmer dropped whole, still renders 构成.
  // Raised from 2450 to 2550 by the responsive-width round: the geometry became a
  // width-keyed function (only the side bands stay absolute; the link span is the
  // measured block width minus them), a measured-width hook walks the Overview
  // block with a ResizeObserver, and the width is threaded through the layout and
  // renderer so a wide panel draws a wider chart whose 11px type still renders
  // 1:1. Measured 2475 formatted lines; measured-plus-30 is 2505, rounded up to
  // 2550.
  // Raised from 2550 by the 图表 round (2836 formatted lines measured;
  // measured-plus-30 is 2866, rounded up to 2900). What the 286 lines buy, and why
  // they are not spread across files:
  //
  // * 标签频率 became a squarified treemap: the layout heuristic, the tile geometry
  //   and the minor-tile rule replaced an eight-row bar list that cost 35 lines and
  //   showed the same eight tags forever. A treemap needs real layout code, and the
  //   only place it can live is the one served asset — a charting dependency would
  //   have to be shipped beside it, which this panel deliberately does not have.
  // * 健康 turned from a ledger into a dashboard: the gauge band, the figure grid,
  //   the stack bar and the named-count bars, plus the sections that now ask for
  //   those shapes instead of printing `<dl>` rows. The page's text lines went from
  //   roughly thirty to under ten; the lines moved from prose to shared chart
  //   helpers, which is the trade this round is.
  //
  // The raise is inside the measured-plus-30 rule rather than above it, and it was
  // argued for rather than inherited: every one of the four new shapes is one shared
  // helper reused by two or more sections, so a fifth page section costs a call.
  // Raised from 2900 to 3000 by the treemap label fix (2940 formatted lines measured;
  // measured-plus-30 is 2970, rounded up to 3000, so the raise stays inside the rule).
  // What the 40 lines buy: the layout now runs in the measured pixel space instead of
  // a fixed 292 x 148 coordinate grid, so its height is derived from the measured
  // width inside a floor/ceiling clamp, and the minor-tile decision became a measured
  // predicate — a per-character-class width model plus the 41px two-line height. Each
  // of the three was a defect visible in one capture of this vault's own tag ranking:
  // the biggest tile printed a bare count with no label, eight tail tiles printed
  // their name at 2.5-8.1px, and the tiles' aspect ratio tripled between the 292px
  // floor and a 590px panel. The alternative to the width model is shipping a font
  // metrics table, which is the dependency this module exists without.
  // The next round (2026-10-30) measured 2964 lines, still inside this budget, so it
  // needed no raise: it calibrated that width model against the real font (the model
  // over-predicted latin by 32-52%), replaced the "complete name only" predicate with
  // a 44px floor that lets the existing CSS ellipsis render a truncated name, and
  // kept the 41px two-line height. The width model is still the alternative to a font
  // metrics table; it is now calibrated from measurement rather than assumed.
  // Raised from 3000 to 3400 by the 2026-10-31 GitHub-form charts round (3332
  // formatted lines measured; measured-plus-30 is 3362, rounded up to 3400). What
  // the 368 lines buy, all in the one asset the browser loads:
  //   * 活动热度 is a fixed GitHub-style calendar instead of a width-stretched grid:
  //     the 371-day window constant, the 10px/2px geometry, the month-label
  //     placement rule (first column, then every month change at least three
  //     labelled columns away), the sticky 一/三/五 gutter, the one-scroll-container
  //     canvas width computation, and the hover tooltip whose box is measured and
  //     edge-clamped in a layout effect (the verifier measured the first
  //     centre-only clamp 43.5px outside the panel at 320px).
  //   * 新建与更新 drops leading all-zero weeks so the first bar starts at the left
  //     edge, and the meta reports the trimmed window while the totals still cover
  //     the wire's whole window.
  //   * 最近变化 became GitHub's contribution-activity rail: day grouping from the
  //     string's own date parts (a bare YYYY-MM-DD is UTC and shifts in negative
  //     offsets), the node/dot rail markup, and the 今天/昨天 fallback wording.
  //   * The poll splits user-triggered runs (announced in one live region) from
  //     background interval/visibility/focus runs (silent), and the POST carries
  //     the x-obsidian-mem-panel header the route's desktop-proxy fence needs.
  // The alternative to any of the chart code is a charting dependency shipped as a
  // second served asset, which this panel has deliberately never had; the one
  // module stays the only place a chart can live.
  // Raised from 3400 by the same day's round-5 UX fixes (3571 formatted lines
  // measured; measured-plus-30 is 3601, rounded up to 3650). What the 171 lines buy:
  //   * the startup race: post() reads a 404 body before classifying it, and the poll
  //     treats route/session-missing as transient before the first data arrives
  //     (1 s retries, 20-attempt cap) with role=status copy instead of the fatal
  //     restart notice;
  //   * per-action feedback: outcome state per mutation rendered inline in the card
  //     that owns the action, per-button busy labels, truthful compact outcome copy
  //     (below trigger vs moved/folded/reclaimed), digest updated/unchanged copy with
  //     the char count, and the hot card's pre-click trigger state;
  //   * the day-diverse 最近变化 client: per-day totals taken from the activity
  //     series, the 仅显示最近 K 条 sample hint, and the two aggregate-only older-day
  //     groups that keep 昨天 visible when every sampled row is today.
  // All of it is copy and state in the one served view module; no chart library, no
  // second asset.
  // Raised from 3650 by the English UI round (2026-10-31; 4122 formatted lines
  // measured; measured-plus-30 is 4152, rounded up to 4200). What the 472 lines buy:
  //   * the zh strings this module rendered inline are collected into one catalog
  //     per centralized map (type/status/index/severity/reason/COPY/MUTATION_*),
  //     with the zh value kept byte-identical so the source stays the source;
  //   * a second catalog and a text(zh, en) helper cover every inline render string
  //     (heat map, flow bars, treemap, KPI, Sankey, health, recent timeline, search,
  //     preview/confirm sheet), plus the English-only plural forms (1 day ago,
  //     1 entry vs N entries);
  //   * detectLocale() is inlined because this asset is served standalone and cannot
  //     import lib/locale.js, and every POST body now carries locale so the route
  //     cannot be steered by the host browser's Accept-Language instead of the
  //     panel's own choice.
  // The alternative — a second served asset or a dependency — is still rejected: the
  // one view module stays the only place a chart and its copy can live.
  // Raised from 4200 by the 2026-10-31 English-UI fix round (m00644; 4247 formatted
  // lines measured; measured-plus-30 is 4277, rounded up to 4300). What the 47 lines
  // buy, all of it consequence of the panel now being switchable between two locales:
  //   * the en heat calendar's 32px weekday gutter (HEAT_WEEKDAY_COLUMN_LATIN,
  //     heatWeekdayGutter) reaching the canvas width, the months row and the frame's
  //     inline grid template, so "Mon"/"Wed"/"Fri" no longer overlap the first column;
  //   * the measured Sankey side columns (estimateTextWidth + englishSankeyColumns and
  //     the widened sankeyGeometry): an English chart grows to fit "Convention" and
  //     "Superseded" instead of clipping them, while the zh chart keeps the fixed
  //     34/38/36/40 columns byte-identically;
  //   * the .mem-sankey-scroll/.mem-sankey-canvas wrapper that turns a measured chart
  //     wider than the panel into a horizontal pan instead of a crop;
  //   * the zone-heading translation (ZONE_LABELS/zoneLabel, the same words
  //     lib/panel-copy.js uses) and the onMeta gate that stops the composed 健康 tab
  //     from printing its own title under the shell's search box.
  'lib/memory-panel.js': 4300,
  // The graph projection uses the existing SQLite links table and scan records;
  // keeping the two backend branches here avoids a second index implementation.
  // Raised from 2300 by the panel data plane: stats({scope}) and recent({limit})
  // are read projections over the existing notes/links tables and belong beside
  // the graph projection rather than in a second index implementation. Measured
  // 2490 formatted lines; measured-plus-30 is 2520, rounded to 2550.
  // Raised from 2550 by the source-status recheck and the digest source list:
  // measured 2660 formatted lines; measured-plus-30 is 2690, rounded to 2700.
  // Raised from 2700 by the 概览 chart aggregates (Task 1): the daily
  // `activity` window (local-calendar day arithmetic, the created/updated
  // mutuality rule the digest also applies — re-implemented here on purpose, because
  // this reader adds the spec's file-mtime fallback for `created` — and one SQL and
  // one scan reader) and the `tagFrequencies` ranking, each implemented twice so both
  // backends answer the same shape. Measured 2839 formatted lines after the review's
  // Minor fix round (2831 before it — the aabadae commit; 2827 was the b36d02a figure,
  // measured before the first fix wave added `tagFrequencies`' `distinct`; this round
  // dropped an unused parameter and corrected the two comments above);
  // measured-plus-30 is 2869, rounded up to 2900, so the round did not need a raise.
  // Nothing moved out of the file to pay for it:
  // the two aggregates are the first readers that bucket by calendar day, which is
  // why the day helpers had to live here beside the two backends rather than in a
  // caller.
  // Raised from 2900 to 2950 by the 概览 Sankey's joint flow: one scoped GROUP BY
  // on the SQLite backend and a nested type→status count in the scan backend's
  // existing eligible-row loop, with the same normalization and order on both
  // sides. Measured 2871 formatted lines; measured-plus-30 is 2901, rounded up to
  // 2950 — the raise is the headroom rule, not new surface beyond the one extra
  // reader per backend.
  // Lowered back to 2900 when the pure projections moved out to `index-stats`: the
  // day helpers, the activity window and bucketing, the project-scope predicate and
  // the tag ranking are not readers, so the sentence above that defended keeping the
  // day helpers "here beside the two backends" is now spent — they live in a module
  // both backends call. Measured 2748 formatted lines; measured-plus-30 is 2778,
  // rounded up to 2800, and the entry is left at 2900 rather than 2800 because the
  // next reader this file grows should not need an accounting round to land. The
  // gap is headroom on a file that just lost 131 lines, not standing debt.
  'lib/index-db.js': 2900,
  // The extracted 概览 projections. Measured 207 formatted lines; measured-plus-30
  // is 237, rounded up to 250. It is a move, not new surface: the code left
  // `index-db` and arrived here, and the two backends now call it.
  'lib/index-stats.js': 250,
  // Measured 119 formatted lines when the v0.4 sparse baseline moved the shared
  // tokenizer out of `index-db`; measured-plus-30 is 149, rounded to 150.
  'lib/index-text.js': 150,
  // The loader owns React controls; the renderer owns cached labels, culling
  // and frame scheduling. Neither the renderer nor Worker imports React.
  // Raised from 600 when the panel's controls started outliving the page: the host
  // rebuilds this tab on every load and the graph route is read-only, so the restore
  // and its gated save live here. The record shape and its validation are the part
  // that earned a module of its own (`lib/graph-settings.js`), not the wiring.
  // Measured 835 formatted lines; measured-plus-30 is 865, rounded up to 900.
  // Raised from 900 by the v0.4 shell redesign: the masthead (project name in the
  // serif display face, binding stamp, last-read clock, refresh), the ordinal
  // tablist (01–04) with roving focus, and the ledger chrome that replaces the
  // generic card shell. Measured 998 formatted lines; measured-plus-30 is 1028,
  // rounded to 1050.
  // Raised from 1050 by the modern panel redesign: the one token-only design
  // system for the shell and all three redesigned views (KPI/summary bands,
  // composition bar and legend, search field/filter pills/result rows, health
  // facts/meter/timeline, the preview→confirm sheet), the Chrome-form icon tab
  // strip, and the compact masthead with its icon refresh. Measured 1034 formatted
  // lines; measured-plus-30 is 1064, rounded up to 1100. The raised headroom buys
  // the stylesheet the views will consume without a second edit to this file, and
  // leaves the graph token block and `GraphCanvas`/`GraphView` untouched by the
  // redesign.
  // Raised from 1100 to 1250 by the v0.4 shell (Task 3): the tab list drops to the
  // three folder tabs, the strip becomes a flex row with overlapping leaves, and
  // 检索 stops being a tab — the new shell-level `SearchBox`, the `search`/`draft`
  // state and its three exits (Esc, clear, any tab) live in `MemoryPanel`, and the
  // results page now mounts with the shell's state as props. Measured 1182
  // formatted lines; measured-plus-30 is 1212, rounded up to 1250. The 68 lines of
  // headroom are the whole raise: Task 4's chart rules will have to argue for their
  // own. The 82 lines over the old budget buy one component (the box), one state
  // machine and the folder strip's own rules, not a second copy of the retired
  // view's form; the graph token block and `GraphCanvas`/`GraphView` stay untouched.
  // Raised from 1250 to 1350 by the chart stylesheet and the two search callbacks:
  // the five 概览 charts need their own rules (heat grid, flow bars, ranking rows,
  // sparkline, capped segment tints), and `refineSearch`/`widenSearch` keep the
  // query, the filters and the page size in the one search object the shell owns.
  // Measured 1260 formatted lines; measured-plus-30 is 1290, rounded up to 1350. The
  // previous comment claimed 1182 measured against a file that had already grown to
  // 1247 when the charts landed — that stale figure is corrected here rather than
  // left to read as headroom nobody spent.
  // The review's Minor fix round kept the same ceiling: measured 1262 formatted lines
  // after it (the heat grid's cap rose 262px → 292px so the chart container clears the
  // design's 280px floor at the 320px support width, and the rule's why-comment states
  // the arithmetic); measured-plus-30 is 1292, which the rule rounds to 1300 — the
  // 1350 ceiling is kept deliberately (it was set by the previous round and this one
  // did not spend it), not re-derived.
  // The panel-shell fix round measured 1309 formatted lines (1302 before the fix
  // round's Sankey status tint); the responsive-width round measured 1313 (the
  // stylesheet's two Sankey rules lost the cap and gained the fixed height).
  // round's Sankey status tint): the search field owns
  // the one rounded focus ring (the input no longer paints its square inset ring),
  // the tab row is the Chrome form at 36px with a 2px gap instead of the -8px
  // folded-folder overlap, and the 构成 Sankey's six fill classes plus their tint
  // variants join the chart stylesheet. Measured-plus-30 is 1332, inside the 1350
  // ceiling — no raise; it was set by the chart round and this round added 47 lines
  // to the stylesheet, so the headroom is 11 lines rather than the 88 the previous
  // figure suggested.
  // Raised from 1350 by the 图表 round (1374 formatted lines measured;
  // measured-plus-30 is 1404, rounded up to 1450). What the 24 lines over the old
  // ceiling buy: the 标签频率 treemap's six rank tints and its tile/name/value
  // rules, the 健康 gauge band, the figure grid, the stack bar and the named-count
  // bars. The previous eight-row ranking stylesheet is deleted rather than left
  // behind, so most of the chart CSS is a trade, not an addition: the frequency
  // block went from five rules to twelve and 健康 gained four shapes, which is
  // what makes the page read as charts instead of text.
  // Raised from 1450 by the 2026-10-31 GitHub-form round (1449 formatted lines
  // measured; measured-plus-30 is 1479, rounded up to 1500). The 32 lines over the
  // old ceiling are the replaced chart chrome: the heat calendar's scroll container,
  // canvas/months/frame/weekday-gutter rules and the edge-clamped tooltip; the
  // contribution-rail timeline that replaced the eight flat recent rows (13 rules in,
  // the old six .mem-recent*/.mem-dot rules out). The panel still carries one
  // token-only stylesheet and no hex/rgb/hsl literal.
  // Raised from 1500 by the English-UI round (1559 formatted lines measured;
  // measured-plus-30 is 1589, rounded up to 1600). The 59 lines over the old
  // ceiling are the shell's inline en catalog (tab titles, notices, search,
  // loading and error copy) plus the locale detection helper and the graph option
  // plumbing; the zh branch's rendered strings are unchanged.
  // Raised from 1600 by the same day's English-UI fix round (m00644; 1641 formatted
  // lines measured; measured-plus-30 is 1671, rounded up to 1700). The 41 lines buy
  // the shell half of the five fixes: storedLocale()/setLocale() with the
  // 'dsh-obsidian-mem:locale' key (browsers default to en, a missing localStorage —
  // tests, old hosts — still runs detectLocale), the '.mem-locale' toggle and its
  // token-only rules, the locale prop that rebuilds GraphCanvas' renderer and its
  // aria label, the search bar's 16px/8px padding that centres it in the gap, and the
  // Sankey scroller rules the view module's new wrapper needs.
  'lib/client.js': 1700,
  // Raised from 700 by the whole-graph round (716 formatted lines measured;
  // measured-plus-30 is 746, rounded up to 750). What the 16 lines buy: the
  // `spiralSeed` helper and the cold-frame branch that uses it, plus the comment
  // recording why the neighbour-mean rule is right for an increment and wrong for
  // the frame that carries the whole projection at once. The raise buys a first
  // frame that is already a graph instead of a random cloud, not new surface — the
  // culling that keeps a large graph cheap was already in the renderer.
  'lib/graph-renderer.js': 750,
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
  // Upstream minified D3 plus the reviewed source in client/graph-worker.js, which is
  // a 1:1 port of Obsidian sim.js's d3 fallback. The parity port removed the locally
  // tuned size policy and grid force, so the adapter measures 113 lines and the
  // generated asset 126 — inside the original 150-line budget, which stands.
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
  // Raised from 1500 by Task 7 (1573 formatted lines measured; measured-plus-30
  // rounds up to 1650, which is this number). What the 73 lines buy: the reviewed
  // apply's evidence preconditions (`expectedSourceHashes`) carried through
  // `normalizeDeps` and `buildCreatePlan` into the transaction request, the engine
  // seams (`recover`/`failAfter`/`notifyIndex`/`lockTimeoutMs`/`pollMs`/`io`) the
  // one composing caller needs to drive a crash, an index failure and a lock
  // timeout, the `transactionOptions` helper that keeps every existing caller's
  // options unchanged, and the explicit recovery that makes the exclusive-create
  // path idempotent after a crash between its publish and its receipt store.
  'lib/memory.js': 1650,
  'lib/naming.js': 250,
  // A leaf with no imports at all, so the whole file is rules, thresholds and the
  // comments recording which measurement each threshold came from. 375 is the
  // repository's usual rule — measured (351) plus 30, rounded up — rather than the
  // 350 this entry first held, which the four bug fixes the tests caught pushed it
  // past. Nothing here should grow except by adding a rule, and a rule that cannot
  // cite a measured hit rate on the corpus does not belong in the file.
  'lib/note-style.js': 375,
  'lib/paths.js': 300,
  'lib/pending.js': 1150,
  'lib/pointer.js': 300,
  'lib/receipts.js': 450,
  'lib/registry.js': 500,
  'lib/routing.js': 500,
  // Raised from 200 for the title-twin lookup: the duplicate rule needs the same
  // tokenizer and the same project-scoped search as `mem_search`, and putting it
  // anywhere else would either duplicate the tokenizer or point a layer upward.
  // Raised from 250 by the v0.4 sparse engine: measured 595 formatted lines;
  // measured-plus-30 is 625, rounded to 650. The engine lives here because Task 3
  // has no new module for it: chunking, source verification, the bounded candidate
  // set, the RRF fusion and the lexical fallback are one policy that the caller
  // must not be able to half-apply.
  'lib/search.js': 650,
  // The v0.4 sparse baseline: 302 and 607 formatted lines measured; measured-plus-30
  // is 332 and 637, rounded to 350 and 650. The ranker reuses `index-db`'s
  // tokenizer rather than copying it; the provider contract validates an explicitly
  // configured, disabled-by-default loopback service and imports only Node builtins.
  'lib/retrieval-rank.js': 350,
  'lib/retrieval-provider.js': 650,
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
  // Raised to 1100 by the hot-zone deadlock fix (1042 formatted lines measured;
  // measured-plus-30 is 1072, which rounds up to 1100). What the 42 lines buy: the
  // `hot` action enum value, its `operation` value `compact` and the description
  // that says what status and compact each answer, the `HOT_RESULT` arm with the
  // per-zone counters (`chars`/`entries`/`pointers`/`moveable`) a refusal quotes
  // too, and the `forwardAdminArguments` default that makes an omitted `operation`
  // the read-only answer. The alternative — reusing the curation arm — would let a
  // caller validate a hot result against curation’s shape.
  // Raised from 1100 by the mem_brief paging parameters/page arm, the brief
  // coverage object and the appraise action result. Measured 1142 formatted lines;
  // measured-plus-30 is 1172, rounded to 1200.
  // Raised from 1200 by the digest action/operation/days and its closed result
  // arm: measured 1275 formatted lines; measured-plus-30 is 1305, rounded to 1350.
  'lib/tool-schema.js': 1350,
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
  // Task 5's fix round raises it to 1600 (1578 formatted lines measured — the 1575 this
  // sentence first gave was a stale measurement of an earlier revision, and round 3's
  // comment correction makes the file 1582 today, still under this number). The rule
  // above would round 1578 + 30 = 1608 up to 1650, so 1600 is deliberately inside the
  // rule and the next raise has to argue with this line rather than inherit the
  // rounding. What the 31 lines buy: gating the
  // acknowledgement on `buildCurationView` returning `written` rather than on the
  // attempt — a `fallback` build writes nothing, so acknowledging off it would drop
  // the batch from the durable queue and from the view at once, which is the plan's
  // ordering guarantee made real — plus the reported fallback reason, the two-line
  // `buildView` seam that lets a case drive a fallback the service's own inputs
  // cannot reach, and the comments that withdraw the two claims the review found
  // false (the scanner's cursor, and the code precedence).
  // The final whole-branch fix wave raises it to 1650 (1619 formatted lines measured;
  // measured-plus-30 is 1649, which rounds up to 1650 — the rule's number, argued rather
  // than inherited). What the 19 lines buy: the `dropped` count `enqueueChangedSource`
  // returns is now reported as one content-free `curation` diagnostic in
  // `queueCurationHint` (a dropped hint is the one queue outcome a later pass does not
  // repair by itself), the diagnostics ring is threaded into `buildBrief` so the
  // brief-time verification fallback reports `brief-fallback`/`source-changed` instead of
  // falling back silently, and the `view-unwritable` comment no longer claims a raw `fs`
  // failure throws out of the build — `lib/curation-view.js` catches it now.
  // Raised from 1650 to 1700 by the refusal memo (1673 formatted lines measured, so
  // 1700 is inside the rule's measured-plus-30 by 27 lines). What the 17 lines
  // buy: `refusalByCwd` and `refusalFor`, so a read that resolves to no project
  // reports the refusal that actually happened instead of claiming the pointer is
  // absent — a false statement for a missing directory, a corrupt pointer and a cwd
  // inside the vault alike — and `mem_brief`'s unbound answer gains the
  // machine-readable `reason` its output schema now accepts.
  // Raised from 1700 to 1800 by the hot-zone deadlock fix (1750 formatted lines
  // measured; measured-plus-30 is 1780, which rounds up to 1800). What the 50 lines
  // buy the `mem_admin(action="hot")` branch: the same read-only resolution the
  // curation branch uses (a repair must not mint a binding), the service-level
  // narrowing of the shared `operation` enum to `status`/`compact`, the read-only
  // status answer, and the compact write — one `transacted` call, the index refresh,
  // the UI cue, and a status report read back after the commit so the numbers
  // describe the file the transaction left behind.
  // Raised from 1800 by the appraisal action and the coverage page dispatch;
  // measured 1802 formatted lines after the dead autoApply guard was removed.
  // measured-plus-30 is 1832, rounded to 1850.
  // Raised from 1850 by the digest action and the shared link resolver: measured
  // 1857 formatted lines; measured-plus-30 is 1887, rounded to 1900.
  // Raised from 1900 by the upstream digest clock seam and the appraise read
  // deadline together: measured 1920 formatted lines after rebasing. The clock
  // keeps the owned digest deterministic across UTC days; the deadline bounds
  // slow-disk reads. Measured-plus-30 is 1950; the existing 1950 budget holds.
  'lib/services.js': 1950,
  // Raised from 2200 by Task 7 (2229 formatted lines measured; measured-plus-30
  // rounds up to 2300, which is this number — the entry above the old one had no
  // note of its own, so this number states the rule it follows). What the 29 lines
  // buy: the `expectedSourceHashes` request field, its envelope validation, and
  // `assertExpectedSourceHashes` — the check that re-reads a reviewed apply's
  // evidence from inside the vault lock this transaction already holds, so an edit
  // landing between a plan and its write is refused instead of overwritten.
  'lib/transaction.js': 2300,
  // Raised from 1750 to 1800 by the `cwd-missing` refusal and the habits template
  // (1778 formatted lines measured, so 1800 is inside the rule's measured-plus-30
  // by 22 lines). What the 19 lines buy: `resolveBinding` answers a directory that
  // no longer exists with the refusal vocabulary instead of throwing `ENOENT` out of
  // `realpath` — the diagnosis that turned "no memory" into a silent, per-step retry
  // in every session whose recorded directory had moved — and `userTemplate` became
  // the habits questionnaire with its five sections and commented examples.
  'lib/vault.js': 1800,
  // The unbound-session notice, raised from 175 to 250 when the short form landed (207
  // formatted lines measured; measured-plus-30 is 237, which rounds up to 250). What the
  // 60 lines buy: a per-reason one-line notice — the message whose whole job is to ask
  // the user a question must not be the one `briefBudgetChars` drops, and two of the
  // detailed forms do not fit its 256 floor — plus `bindHintWithin`, the one chooser DSH
  // and the Codex hook both call, so the two harnesses cannot drift apart. The original
  // size bought the reason allowlist, the four wordings and `quotePath`, the one place an
  // untrusted path is made safe for a one-line injected message.
  'lib/init-hint.js': 250,
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
