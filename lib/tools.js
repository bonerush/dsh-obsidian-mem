// The six `mem_*` tools and the host-side service layer behind them (Task 10,
// spec §9).
//
// The tool surface is deliberately six tools and no more. `mem_search`,
// `mem_read`, `mem_write` and `mem_log` cover the high-frequency work;
// `mem_brief` and `mem_admin` fold the rest in, so a low-frequency maintenance
// action never widens the schema the model reads on every request.
//
// Four rules shape this module.
//
//   * **The parameter DSL root is open, so `execute` rejects its own keys.**
//     DSH compiles `parameters` into `{type:'object', properties, required?}`
//     with no `additionalProperties`, which means the runtime happily passes an
//     undeclared key through to `execute`. Every `execute` therefore checks the
//     argument keys against `TOOL_PARAMETERS` (the same object the schema was
//     built from, so the allow-list cannot drift) and refuses anything else
//     before a service is called. The output schemas are closed: every object
//     node — including the `oneOf` arms of `mem_admin` — declares
//     `additionalProperties` explicitly.
//   * **No action ever fakes a result.** Every one of `mem_admin`'s six actions
//     — `lint`, `index`, `bind`, `projects`, `promote`, `jobs` — is implemented,
//     and the output schema's per-action arms describe the real values they
//     return. `lint` is read-only unless the caller explicitly asks for the dated
//     report (`report: true`); a bind refusal is reported as a refusal, never as
//     a quiet success. Results carry vault-relative paths; no `obsidian://` URI is
//     invented for a vault this plugin cannot prove Obsidian has opened.
//   * **Every path argument goes through the vault jail.** `mem_read` resolves
//     its path with `resolveVaultFile` (via `readNote`), so an absolute path,
//     `..` traversal, a symlink or an internal path such as `_meta/log.md` is
//     refused by the vault's own security boundary rather than by a second,
//     weaker check here.
//   * **One data root for the whole plugin.** `lib/index.js` calls
//     `resolveDataRoot()` exactly once and hands it here; the transaction engine
//     (through `writeMemory`/`appendLog`/`updateHot`), the index and the future
//     pending queue all receive that same directory. This module never derives
//     one for itself, which is what keeps a test-injected root authoritative.
//
// The `services` seam exists so the tool contract can be tested without a vault
// and so Task 11/12 can re-bind `mem_brief` and the session binding without
// touching a schema. `registerTools(ctx, services)` returns the six
// registration disposers; a surviving fiber effect closes every open index when
// the owning fiber stops.
import { homedir } from 'node:os'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { buildBrief } from './brief.js'
// `retryJob` owns the one revive rule (only a terminally failed job may be
// requeued) and lives in Task 16's capture seam.
import { retryJob } from './capture.js'
import { DEFAULT_LIMIT, DEFAULT_READY_TIMEOUT_MS, openIndex } from './index-db.js'
import { lintVault } from './lint.js'
import { appendLog, MemoryError, promoteNote, writeMemory } from './memory.js'
import { updateHot } from './hot.js'
import { queueRootFor, readPendingJobs } from './pending.js'
import { normalizeType } from './routing.js'
import { readNote, searchNotes } from './search.js'
import { bootstrapVault, readRegistry, resolveBinding, resolveVaultRoot, isCloudManagedVaultRoot } from './vault.js'

/** The complete tool surface (spec §9). Nothing else may be registered here. */
export const TOOL_NAMES = Object.freeze([
  'mem_search', 'mem_read', 'mem_write', 'mem_log', 'mem_brief', 'mem_admin',
])

/** The service every tool needs; `registerTools` refuses a partial seam. */
const SERVICE_KEYS = Object.freeze(['search', 'read', 'write', 'log', 'brief', 'admin'])

/** `default: 8`, mirroring `lib/index-db.js`'s bounded limit. */
const DEFAULT_SEARCH_LIMIT = DEFAULT_LIMIT

/** Which optional `mem_admin` parameters each action can actually act on. */
const ADMIN_ACTION_PARAMETERS = Object.freeze({
  // `report` and `prune` are the two explicit write requests a lint can carry;
  // without them the action only inspects. They are deliberately independent: a
  // caller who asks for the dated report must not also have snapshot
  // directories deleted.
  lint: Object.freeze(['report', 'prune']),
  index: Object.freeze(['rebuild']),
  bind: Object.freeze(['mode']),
  projects: Object.freeze([]),
  promote: Object.freeze(['path']),
  jobs: Object.freeze(['jobId', 'retry']),
})

/**
 * The hot zones `mem_log(section=…)` may target.
 *
 * `section` is the day-log block heading (spec §6.2), with one reserved value:
 * `hot` routes the entry into the hot file's controlled zones. The spec says
 * "the controlled zone" without naming which, so `hot` means 进行中 — the zone
 * for active work, which is the only one a log entry can sensibly open — and the
 * three zone names themselves are accepted directly rather than being silently
 * misread as day-log headings.
 */
const HOT_SECTIONS_BY_SECTION = Object.freeze(new Map([
  ['hot', '进行中'],
  ['强约束', '强约束'],
  ['进行中', '进行中'],
  ['已完成', '已完成'],
]))

/** What `mem_brief` answers when this working directory is not a bound project. */
const BRIEF_UNBOUND = Object.freeze({
  status: 'unbound',
  message: 'mem_brief needs a bound project: this working directory has no .obsidian-mem pointer, so there is no project memory to recall',
})

// ---------------------------------------------------------------------------
// The parameter DSL specs — the author-facing source of truth
// ---------------------------------------------------------------------------

/**
 * The per-tool parameter specs, in DSH's shorthand DSL (`required: true` per
 * property). The compiled JSON Schema is derived from exactly this object, and
 * `TOOL_ALLOWED_KEYS` below derives the extra-key rejection from it too.
 */
export const TOOL_PARAMETERS = Object.freeze({
  mem_search: Object.freeze({
    query: { type: 'string', required: true, description: 'Search text. Latin words are lowercased; CJK runs become overlapping bigrams.' },
    scope: { type: 'string', enum: ['project', 'global', 'all'], default: 'project', description: 'project (default) is the bound project only; global is 方法/ plus _meta/user.md; all crosses projects.' },
    type: { type: 'string', description: 'Optional note-type filter (doc, decision, gotcha, convention, glossary, …).' },
    projectId: { type: 'string', description: 'Only meaningful with scope "all"; a different id under scope "project" is refused, never silently crossed.' },
    includeHistory: { type: 'boolean', default: false, description: 'Include superseded and archived notes (excluded by default).' },
    limit: { type: 'number', default: DEFAULT_SEARCH_LIMIT, description: `Maximum hits, 1..50 (default ${DEFAULT_SEARCH_LIMIT}).` },
  }),
  mem_read: Object.freeze({
    path: { type: 'string', required: true, description: 'Vault-relative path of a retrievable .md note. Absolute paths, "..", symlinks and internal paths are refused.' },
    section: { type: 'string', description: 'Optional ATX heading; its body is returned as sectionBody.' },
  }),
  mem_write: Object.freeze({
    type: { type: 'string', required: true, description: 'Note type; it selects the project directory: doc, decision, gotcha, convention (alias invariant), glossary.' },
    title: { type: 'string', required: true, description: 'Human title. Titles are not identity; the id is.' },
    body: { type: 'string', required: true, description: 'Markdown body, without frontmatter.' },
    tags: { type: 'array', items: { type: 'string' }, description: 'Extra tags. The plugin always adds its own dsh-mem/<type> tag.' },
    status: { type: 'string', description: 'Lifecycle status (active, proposed, accepted, superseded, deprecated, provisional, contested, archived).' },
    confidence: { type: 'number', description: 'Confidence in [0,1].' },
    assertion: { type: 'string', enum: ['stated', 'inferred', 'observed'], description: 'stated: the user said it; inferred: the model concluded it; observed: verifiable tool evidence exists.' },
    supersedes: { type: 'string', description: 'Stable id of the note this one replaces. The old note is marked superseded, never deleted.' },
    id: { type: 'string', description: 'Update this existing id. Omitting id always CREATES a new note with a fresh random id.' },
    idempotencyKey: { type: 'string', description: 'Retrying with the same key returns the original receipt instead of writing again.' },
  }),
  mem_log: Object.freeze({
    text: { type: 'string', required: true, description: 'One log entry.' },
    session: { type: 'string', description: 'Session the block belongs to; defaults to the calling agent session id.' },
    section: { type: 'string', description: 'Day-log section heading. The reserved value "hot" (or one of 强约束/进行中/已完成) updates that controlled hot zone instead.' },
    idempotencyKey: { type: 'string', description: 'Retrying with the same key returns the original receipt.' },
  }),
  mem_brief: Object.freeze({}),
  mem_admin: Object.freeze({
    action: { type: 'string', required: true, enum: ['lint', 'index', 'bind', 'projects', 'promote', 'jobs'], description: 'Low-frequency maintenance action.' },
    path: { type: 'string', description: 'Only for promote: the vault-relative path of the source note a new 方法/ note is created from. The source is never moved or rewritten.' },
    rebuild: { type: 'boolean', default: false, description: 'Only for index: re-hash every source instead of the cheap mtime/size pass.' },
    mode: { type: 'string', enum: ['show', 'local', 'fork', 'retain'], default: 'show', description: 'Only for bind. show reports without writing; local binds this directory explicitly; fork mints a new project id here without moving the old project; retain confirms the current binding and records the origin remote hint.' },
    jobId: { type: 'string', description: 'Only for jobs: the failed job to inspect or retry.' },
    retry: { type: 'boolean', default: false, description: 'Only for jobs: explicitly retry the named job (requires jobId).' },
    report: { type: 'boolean', default: false, description: 'Only for lint: additionally write the dated _meta/Lint Report note. Default false = read-only.' },
    prune: { type: 'boolean', default: false, description: 'Only for lint: explicitly apply the .history retention policy (whole snapshot transactions older than the policy, never one a transaction still references). Default false = nothing is deleted.' },
  }),
})

/** Per-tool argument allow-list, derived from the specs above. */
const TOOL_ALLOWED_KEYS = Object.freeze(Object.fromEntries(
  Object.entries(TOOL_PARAMETERS).map(([name, spec]) => [name, Object.freeze(Object.keys(spec))]),
))

/**
 * The optional (non-required) parameter names of one tool, derived from the same
 * spec the schema is built from.
 *
 * A tool forwards exactly these keys to its service. Deriving them means a
 * parameter added to the schema cannot become an argument that `execute`
 * accepts and then silently drops on the floor.
 *
 * @param {string} name - the tool name.
 * @param {string[]} requiredKeys - that tool's required parameters.
 * @returns {string[]} every other declared parameter, in declaration order.
 */
function optionalKeysOf(name, requiredKeys) {
  return Object.freeze(Object.keys(TOOL_PARAMETERS[name]).filter((key) => !requiredKeys.includes(key)))
}

const SEARCH_OPTIONS = optionalKeysOf('mem_search', ['query'])
const READ_OPTIONS = optionalKeysOf('mem_read', ['path'])
const WRITE_OPTIONS = optionalKeysOf('mem_write', ['type', 'title', 'body'])
const LOG_OPTIONS = optionalKeysOf('mem_log', ['text'])

// ---------------------------------------------------------------------------
// Value schemas (the output contract)
// ---------------------------------------------------------------------------

/** A string or an explicit null — most vault facts are genuinely nullable. */
const STRING_OR_NULL = Object.freeze({ oneOf: [{ type: 'string' }, { type: 'null' }] })
/** A number or an explicit null. */
const NUMBER_OR_NULL = Object.freeze({ oneOf: [{ type: 'number' }, { type: 'null' }] })
/** A mapping the plugin did not author (frontmatter, hashes, receipt results). */
const OPEN_OBJECT = Object.freeze({ type: 'object', additionalProperties: true })

/** `mem_search`'s hit, exactly the fields spec §9 promises. */
const HIT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string', required: true },
    id: { type: 'string' },
    projectId: { type: 'string' },
    title: { type: 'string', required: true },
    type: { type: 'string', required: true },
    status: { type: 'string', required: true },
    source: { type: 'string', required: true },
    snippet: { type: 'string', required: true },
    scoreSignals: { type: 'array', required: true, items: { type: 'string' } },
  },
})

const SEARCH_OUTPUT = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: { hits: { type: 'array', required: true, items: HIT_SCHEMA } },
})

/** `mem_read`'s `Note`: source-verified bytes plus the parsed frontmatter. */
const NOTE_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string', required: true },
    id: { type: 'string' },
    type: { type: 'string' },
    title: { type: 'string' },
    status: { type: 'string' },
    projectId: { type: 'string' },
    updated: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    hash: { type: 'string', required: true },
    size: { type: 'number', required: true },
    body: { type: 'string', required: true },
    frontmatter: { oneOf: [OPEN_OBJECT, { type: 'null' }], required: true },
    section: { type: 'string' },
    sectionBody: { type: 'string' },
    parseError: {
      oneOf: [
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            code: { type: 'string', required: true },
            message: { type: 'string', required: true },
          },
        },
        { type: 'null' },
      ],
    },
  },
})

/** The Task 7 receipt (`lib/receipts.js` `makeReceipt`), every field present. */
const RECEIPT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    schema: { type: 'number', required: true },
    txId: { type: 'string', required: true },
    idempotencyKey: { ...STRING_OR_NULL, required: true },
    sessionId: { ...STRING_OR_NULL, required: true },
    fromSeq: { ...NUMBER_OR_NULL, required: true },
    toSeq: { ...NUMBER_OR_NULL, required: true },
    action: { type: 'string', required: true },
    paths: { type: 'array', required: true, items: { type: 'string' } },
    beforeHashes: { ...OPEN_OBJECT, required: true },
    afterHashes: { ...OPEN_OBJECT, required: true },
    result: { ...OPEN_OBJECT, required: true },
    at: { type: 'string', required: true },
  },
})

const WRITE_OUTPUT = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    path: { type: 'string', required: true },
    receipt: { ...RECEIPT_SCHEMA, required: true },
  },
})

/** One complete hot entry as the delta contract reports it (`lib/brief.js`). */
const HOT_ITEM_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    section: { type: 'string', required: true },
    text: { type: 'string', required: true },
    source: { ...STRING_OR_NULL, required: true },
  },
})

/** The index readiness a brief reports, so "not ready" is never read as "empty". */
const INDEX_STATE_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', required: true },
    reason: { ...STRING_OR_NULL, required: true },
    backend: { ...STRING_OR_NULL, required: true },
    notes: { type: 'number', required: true },
    scanning: { type: 'boolean', required: true },
  },
})

/** The real `mem_brief` value: exactly what `buildBrief` returns (Task 11). */
const BRIEF_VALUE_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    text: { type: 'string', required: true },
    charCount: { type: 'number', required: true },
    hotHash: { ...STRING_OR_NULL, required: true },
    hotItems: { type: 'array', required: true, items: HOT_ITEM_SCHEMA },
    indexState: { ...INDEX_STATE_SCHEMA, required: true },
    // R38: the machine-readable truncation signal. `truncated: false` is the
    // caller's licence to advance its hot snapshot; `true` means it must keep its
    // previous snapshot so the dropped items are retried on the next change.
    truncated: { type: 'boolean', required: true },
    omitted: { type: 'number', required: true },
  },
})

/**
 * `mem_brief`'s status-only answer: this working directory is not a bound
 * project, so there is no project memory to recall. It is the only status the
 * shipped service can produce — `buildBrief` is real, so no placeholder arm
 * exists.
 *
 * @param {string} status - the `const` this arm accepts.
 * @returns {object} the arm.
 */
function briefStatusArm(status) {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      status: { type: 'string', required: true, const: status },
      message: { type: 'string', required: true },
    },
  }
}

const BRIEF_OUTPUT = Object.freeze({
  oneOf: [BRIEF_VALUE_SCHEMA, briefStatusArm('unbound')],
})

/** The index status `mem_admin(action="index")` reports. */
const INDEX_STATUS_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    backend: { ...STRING_OR_NULL, required: true },
    requestedBackend: { type: 'string', required: true },
    degraded: { type: 'boolean', required: true },
    reason: { ...STRING_OR_NULL, required: true },
    ready: { type: 'boolean', required: true },
    scanning: { type: 'boolean', required: true },
    stale: { type: 'boolean', required: true },
    notes: { type: 'number', required: true },
    schemaVersion: { ...STRING_OR_NULL, required: true },
    lastScan: { ...STRING_OR_NULL, required: true },
    lastError: { ...STRING_OR_NULL, required: true },
    boundProjectId: { ...STRING_OR_NULL, required: true },
    fts: { type: 'boolean', required: true },
    rebuilt: { type: 'boolean', required: true },
  },
})

const PROJECT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    projectId: { type: 'string', required: true },
    dir: { type: 'string', required: true },
    displayName: { type: 'string', required: true },
    remote: { type: 'string', required: true },
  },
})

const PROJECTS_RESULT = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: { projects: { type: 'array', required: true, items: PROJECT_SCHEMA } },
})

/**
 * One `resolveBinding` result, exactly as `toResolutionView` reports it.
 *
 * The view has a fixed key set — which is what lets this node stay closed —
 * and deliberately carries no machine-local path (`cwd`, `repoRoot`,
 * `projectDir`): the vault-relative directory is the thing a caller can act on.
 */
const RESOLUTION_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', required: true },
    reason: { type: 'string' },
    message: { type: 'string' },
    hint: { type: 'string' },
    projectId: { type: 'string' },
    slug: { type: 'string' },
    displayName: { type: 'string' },
    relativeDir: { type: 'string' },
    registered: { type: 'boolean' },
    pointerCreated: { type: 'boolean' },
    pointerInherited: { type: 'boolean' },
    pointerReplaced: { type: 'boolean' },
    previousProjectId: { type: 'string' },
    remote: { type: 'string' },
    retained: { type: 'boolean' },
    vaultExists: { type: 'boolean' },
  },
})

/**
 * `mem_admin(action="bind")`: the requested mode and what it achieved.
 *
 * `resolution` is always present — for a refusal it is the refusal view, so the
 * caller sees the reason (`no-pointer`, `directory-taken`, …) instead of a bare
 * status. `status` says which of the four bind outcomes happened; the remaining
 * fields are the facts only that outcome has.
 */
const BIND_RESULT = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    mode: { type: 'string', required: true, enum: ['show', 'local', 'fork', 'retain'] },
    status: { type: 'string', required: true, enum: ['shown', 'bound', 'forked', 'retained', 'refused'] },
    resolution: { ...RESOLUTION_SCHEMA, required: true },
    message: { type: 'string' },
    previousProjectId: { type: 'string' },
    remote: { type: 'string' },
    retained: { type: 'boolean' },
    bootstrapped: { type: 'boolean' },
    registryUpdated: { type: 'boolean' },
    createdPaths: { type: 'array', items: { type: 'string' } },
  },
})

/** One lint finding: what it is, how loudly to read it, and where. */
const LINT_FINDING_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', required: true },
    severity: { type: 'string', required: true, enum: ['error', 'warn', 'info'] },
    path: { ...STRING_OR_NULL, required: true },
    message: { type: 'string', required: true },
  },
})

/** The index section of a lint report. */
const LINT_INDEX_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    backend: { ...STRING_OR_NULL, required: true },
    ready: { type: 'boolean', required: true },
    notes: { ...NUMBER_OR_NULL, required: true },
    rows: { ...NUMBER_OR_NULL, required: true },
    files: { type: 'number', required: true },
    compared: { type: 'boolean', required: true },
    reason: { ...STRING_OR_NULL, required: true },
  },
})

/** The `.history` section of a lint report. */
const LINT_HISTORY_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    policy: { ...OPEN_OBJECT, required: true },
    directories: { type: 'number', required: true },
    bytes: { type: 'number', required: true },
    prunable: { type: 'number', required: true },
    pruned: { type: 'array', required: true, items: { type: 'string' } },
    needsRepair: { type: 'array', required: true, items: { type: 'string' } },
    oversized: { type: 'boolean', required: true },
  },
})

/** `mem_admin(action="lint")`: the read-only report and the one optional write. */
const LINT_RESULT = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    projectId: { type: 'string', required: true },
    relativeDir: { type: 'string', required: true },
    generatedAt: { type: 'string', required: true },
    readOnly: { type: 'boolean', required: true },
    total: { type: 'number', required: true },
    counts: { ...OPEN_OBJECT, required: true },
    findings: { type: 'array', required: true, items: LINT_FINDING_SCHEMA },
    index: { ...LINT_INDEX_SCHEMA, required: true },
    history: { ...LINT_HISTORY_SCHEMA, required: true },
    pending: {
      type: 'object',
      additionalProperties: false,
      required: true,
      properties: {
        jobs: { type: 'number', required: true },
        failed: { type: 'number', required: true },
        invalid: { type: 'number', required: true },
        known: { type: 'boolean', required: true },
      },
    },
    repository: {
      type: 'object',
      additionalProperties: false,
      required: true,
      properties: {
        scanned: { type: 'number', required: true },
        candidates: { type: 'number', required: true },
        truncated: { type: 'boolean', required: true },
        known: { type: 'boolean', required: true },
      },
    },
    report: {
      type: 'object',
      additionalProperties: false,
      required: true,
      properties: {
        status: { type: 'string', required: true, enum: ['none', 'written', 'unchanged', 'conflict'] },
        path: { ...STRING_OR_NULL, required: true },
        message: { ...STRING_OR_NULL, required: true },
      },
    },
    safetyExclusions: { type: 'array', required: true, items: { type: 'string' } },
    ignoreGlobs: { type: 'array', required: true, items: { type: 'string' } },
    truncated: {
      type: 'object',
      additionalProperties: false,
      required: true,
      properties: {
        vault: { type: 'boolean', required: true },
        repo: { type: 'boolean', required: true },
      },
    },
  },
})

/** `mem_admin(action="promote")`: the new cross-project note, and its source. */
const PROMOTE_RESULT = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    source: { type: 'string', required: true },
    moved: { type: 'boolean', required: true },
    id: { type: 'string', required: true },
    path: { type: 'string', required: true },
    receipt: { ...RECEIPT_SCHEMA, required: true },
  },
})

/** One queued job as `mem_admin(action="jobs")` reports it. */
const JOB_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    jobId: { type: 'string', required: true },
    state: { type: 'string', required: true },
    sessionId: { type: 'string', required: true },
    projectId: { type: 'string', required: true },
    fromSeq: { type: 'number', required: true },
    toSeq: { type: 'number', required: true },
    attempts: { type: 'number', required: true },
    createdAt: { ...STRING_OR_NULL, required: true },
    failedAt: { ...STRING_OR_NULL, required: true },
    lastError: { ...STRING_OR_NULL, required: true },
    outputState: { ...STRING_OR_NULL, required: true },
  },
})

/** `mem_admin(action="jobs")`: the queue, and the one job an explicit retry revived. */
const JOBS_RESULT = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', required: true, enum: ['listed', 'retried', 'refused'] },
    jobs: { type: 'array', required: true, items: JOB_SCHEMA },
    failed: { type: 'number', required: true },
    message: { ...STRING_OR_NULL, required: true },
  },
})

/**
 * One `mem_admin` arm: the requested action as a `const`, so a result can never
 * be validated against the wrong action's shape.
 *
 * @param {string} action - the action this arm describes.
 * @param {object} resultSchema - the value schema of that action's `result`.
 * @returns {object} the arm.
 */
function adminArm(action, resultSchema) {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      action: { type: 'string', required: true, const: action },
      result: { ...resultSchema, required: true },
    },
  }
}

const ADMIN_OUTPUT = Object.freeze({
  oneOf: [
    adminArm('index', INDEX_STATUS_SCHEMA),
    adminArm('projects', PROJECTS_RESULT),
    adminArm('bind', BIND_RESULT),
    adminArm('lint', LINT_RESULT),
    adminArm('promote', PROMOTE_RESULT),
    adminArm('jobs', JOBS_RESULT),
  ],
})

/** One pure renderer for all six tools: the canonical value as JSON text. */
const renderJson = (_args, value) => [{ type: 'text', text: JSON.stringify(value) }]

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register the six `mem_*` tools against a Cordis context.
 *
 * @param {object} ctx - the Cordis context of the owning fiber (must expose the `tools` service).
 * @param {object} services - the six service functions (`search`, `read`, `write`, `log`, `brief`, `admin`), each `(args, signal, exec) => Promise<value>`.
 * @returns {Function[]} the six registration disposers, in `TOOL_NAMES` order.
 * @throws {TypeError} when the context has no `tools` service.
 * @throws {RangeError} when the service seam is incomplete.
 */
export function registerTools(ctx, services) {
  const tools = ctx !== null && typeof ctx?.get === 'function' ? ctx.get('tools') : undefined
  if (tools === null || tools === undefined || typeof tools.register !== 'function') {
    throw new TypeError("registerTools requires a Cordis context with the tools service (inject: ['tools'])")
  }
  for (const key of SERVICE_KEYS) {
    if (typeof services?.[key] !== 'function') {
      throw new RangeError(`registerTools requires services.${key} to be a function`)
    }
  }

  const definitions = [
    searchTool(services),
    readTool(services),
    writeTool(services),
    logTool(services),
    briefTool(services),
    adminTool(services),
  ]
  const disposers = definitions.map((definition) => tools.register(defineTool(definition)))

  // Index handles are process resources: when the owning fiber stops, close
  // them. The registrations above are already fiber effects; this makes the
  // index lifetime match them even if the caller drops the returned array.
  if (typeof ctx.effect === 'function' && typeof services.close === 'function') {
    ctx.effect(() => () => { void services.close() })
  }
  return disposers
}

/** `mem_search`. */
function searchTool(services) {
  return {
    name: 'mem_search',
    description: 'Search project memory. Defaults to the bound project; pass scope "global" for 方法/ and _meta/user.md, or "all" to cross projects.',
    parameters: TOOL_PARAMETERS.mem_search,
    output: { schema: SEARCH_OUTPUT, render: renderJson },
    async execute(args, exec) {
      assertKnownArguments('mem_search', args)
      assertNotAborted(exec)
      const forwarded = {
        query: args.query,
        ...forwardedOptions(args, SEARCH_OPTIONS),
        scope: args.scope ?? 'project',
        includeHistory: args.includeHistory ?? false,
        limit: args.limit ?? DEFAULT_SEARCH_LIMIT,
      }
      return { hits: await services.search(forwarded, exec.signal, exec) }
    },
  }
}

/** `mem_read`. */
function readTool(services) {
  return {
    name: 'mem_read',
    description: 'Read one vault note by its vault-relative path: source-verified body, parsed frontmatter and content hash.',
    parameters: TOOL_PARAMETERS.mem_read,
    output: { schema: NOTE_SCHEMA, render: renderJson },
    async execute(args, exec) {
      assertKnownArguments('mem_read', args)
      assertNotAborted(exec)
      return services.read({ path: args.path, ...forwardedOptions(args, READ_OPTIONS) }, exec.signal, exec)
    },
  }
}

/** `mem_write`. */
function writeTool(services) {
  return {
    name: 'mem_write',
    description: 'Write a memory note. Without an id this always CREATES a note with a fresh random id; pass an existing id to update it. Superseding verifies the old id.',
    parameters: TOOL_PARAMETERS.mem_write,
    output: { schema: WRITE_OUTPUT, render: renderJson },
    async execute(args, exec) {
      assertKnownArguments('mem_write', args)
      assertNotAborted(exec)
      const forwarded = { type: args.type, title: args.title, body: args.body, ...forwardedOptions(args, WRITE_OPTIONS) }
      return services.write(forwarded, exec.signal, exec)
    },
  }
}

/** `mem_log`. */
function logTool(services) {
  return {
    name: 'mem_log',
    description: 'Append one idempotent log entry to the day log, or with section "hot" to the controlled hot zone.',
    parameters: TOOL_PARAMETERS.mem_log,
    output: { schema: RECEIPT_SCHEMA, render: renderJson },
    async execute(args, exec) {
      assertKnownArguments('mem_log', args)
      assertNotAborted(exec)
      return services.log({ text: args.text, ...forwardedOptions(args, LOG_OPTIONS) }, exec.signal, exec)
    },
  }
}

/** `mem_brief` — the same source as the injected recall brief (Task 11). */
function briefTool(services) {
  return {
    name: 'mem_brief',
    description: 'Return the current project recall brief (the same source the session injects).',
    parameters: TOOL_PARAMETERS.mem_brief,
    output: { schema: BRIEF_OUTPUT, render: renderJson },
    async execute(_args, exec) {
      assertKnownArguments('mem_brief', _args)
      assertNotAborted(exec)
      return services.brief({}, exec.signal, exec)
    },
  }
}

/** `mem_admin`. */
function adminTool(services) {
  return {
    name: 'mem_admin',
    description: 'Low-frequency vault maintenance: lint (read-only unless report=true and/or prune=true), index status/rebuild, bind (show/local/fork/retain), the project list, promote a note into 方法/, and the pending job queue with an explicit retry.',
    parameters: TOOL_PARAMETERS.mem_admin,
    output: { schema: ADMIN_OUTPUT, render: renderJson },
    async execute(args, exec) {
      assertKnownArguments('mem_admin', args)
      assertNotAborted(exec)
      return services.admin(forwardAdminArguments(args), exec.signal, exec)
    },
  }
}

/**
 * Refuse an argument key the tool's schema does not declare.
 *
 * The shorthand parameter DSL compiles an open object root, so the runtime does
 * not reject an undeclared key for us; this is the only place that does. The
 * allow-list is derived from `TOOL_PARAMETERS`, so a new parameter cannot be
 * added to the schema without being accepted here.
 *
 * @param {string} name - the tool name, for the diagnostic.
 * @param {object} args - the parsed arguments.
 * @throws {RangeError} when at least one key is undeclared.
 */
function assertKnownArguments(name, args) {
  const allowed = TOOL_ALLOWED_KEYS[name]
  const unknown = Object.keys(args ?? {}).filter((key) => !allowed.includes(key))
  if (unknown.length === 0) return
  const named = unknown.sort().map((key) => JSON.stringify(key)).join(', ')
  throw new RangeError(`${name} does not accept ${named}; allowed arguments are ${allowed.map((key) => JSON.stringify(key)).join(', ')}`)
}

/** Cooperative cancellation: the runtime always supplies `exec.signal`. */
function assertNotAborted(exec) {
  exec?.signal?.throwIfAborted?.()
}

/**
 * Copy the optional arguments a call actually supplied, in declaration order.
 *
 * Only present keys are copied, so the service's own defaults (and the schema's
 * documented `default`) stay authoritative for an omitted parameter instead of
 * `undefined` shadowing them.
 *
 * @param {object} args - the parsed arguments.
 * @param {readonly string[]} keys - the tool's optional parameter names.
 * @returns {object} the supplied optional arguments.
 */
function forwardedOptions(args, keys) {
  const forwarded = {}
  for (const key of keys) {
    if (args[key] !== undefined) forwarded[key] = args[key]
  }
  return forwarded
}

/**
 * Validate `mem_admin`'s cross-parameter rules and apply its per-action defaults.
 *
 * A parameter that the requested action cannot act on is refused rather than
 * dropped: silently ignoring `jobId` on `projects` would report success for an
 * action that never ran.
 *
 * @param {object} args - the parsed arguments.
 * @returns {object} the arguments the service sees.
 * @throws {RangeError} when a parameter does not belong to the requested action.
 */
function forwardAdminArguments(args) {
  const allowed = ADMIN_ACTION_PARAMETERS[args.action] ?? []
  const irrelevant = Object.keys(args)
    .filter((key) => key !== 'action' && !allowed.includes(key))
    .sort()
  if (irrelevant.length > 0) {
    throw new RangeError(
      `mem_admin(action="${args.action}") does not accept ${irrelevant.map((key) => JSON.stringify(key)).join(', ')}; it accepts ${allowed.map((key) => JSON.stringify(key)).join(', ') || 'no further arguments'}`,
    )
  }
  const forwarded = { action: args.action }
  if (args.path !== undefined) forwarded.path = args.path
  if (args.jobId !== undefined) forwarded.jobId = args.jobId
  if (args.mode !== undefined) forwarded.mode = args.mode
  if (args.action === 'bind' && forwarded.mode === undefined) forwarded.mode = 'show'
  if (args.action === 'index') forwarded.rebuild = args.rebuild ?? false
  if (args.action === 'jobs') forwarded.retry = args.retry ?? false
  if (args.action === 'lint') {
    forwarded.report = args.report ?? false
    forwarded.prune = args.prune ?? false
  }
  return forwarded
}

// ---------------------------------------------------------------------------
// The service layer
// ---------------------------------------------------------------------------

/**
 * Build the six services over one vault, one data root and one binding seam.
 *
 * @param {object} options - assembly inputs.
 * @param {object} options.config - the validated plugin config (`vaultPath`, `indexBackend`, `hotCapacityChars`, `hotArchiveRatio`).
 * @param {string} options.dataRoot - the plugin data root, resolved once by `lib/index.js`.
 * @param {string} [options.cwd] - working directory to bind when a call carries no agent session.
 * @param {string} [options.home] - home seam for `~/` expansion and cloud checks.
 * @param {object|null} [options.binding] - an already-resolved `kind:'bound'` binding (Task 12 passes the session's).
 * @returns {object} `{ search, read, write, log, brief, admin, close }`.
 * @throws {RangeError} when the config or the data root is missing.
 */
export function createMemoryServices(options = {}) {
  const { config, dataRoot, cwd = process.cwd(), home = homedir(), binding = null } = options
  if (config === null || typeof config !== 'object') throw new RangeError('createMemoryServices requires the validated plugin config')
  if (typeof dataRoot !== 'string' || dataRoot.trim() === '') throw new RangeError('createMemoryServices requires a non-blank dataRoot')
  // The pending queue lives under the one data root `lib/index.js` resolved, so
  // `mem_admin(action="lint"|"jobs")` reads exactly the queue Task 16 writes.
  const queueRoot = queueRootFor(dataRoot)
  if (typeof cwd !== 'string' || cwd.trim() === '') throw new RangeError('createMemoryServices requires a non-blank cwd')
  if (binding !== null && (typeof binding !== 'object' || binding.kind !== 'bound')) {
    throw new RangeError("createMemoryServices accepts only a kind:'bound' binding")
  }

  /** Resolved vault roots, memoised so `~/…` is expanded once per service. */
  let vaultPromise = null
  /** Binding per working directory, so a session's cwd resolves once. */
  const bindingByCwd = new Map()
  /** Open indexes per project id (`''` when unbound). */
  const indexByProject = new Map()

  /**
   * The vault root this service set reads and writes.
   *
   * A tool call never mints a `.obsidian-mem` pointer: it resolves with
   * `mode: 'show'`, which reports an unbound repository instead of binding it.
   * Task 12 owns the session-start bind, and a stray pointer in a repository the
   * user only searched would be a side effect nobody asked for.
   *
   * R14: a cloud-managed vault refuses **reads as well as writes**, so the check
   * lives here rather than on the write path alone. An on-demand (dataless) file
   * under `~/Library/Mobile Documents/` or `~/Library/CloudStorage/` can fail
   * with `EDEADLK` in a background process or silently trigger a mass download,
   * and both are read hazards. Every service that touches the vault — including
   * `mem_read`, `mem_admin(action="projects")` and an unbound
   * `mem_search(scope="global")` — gets its root through this function or
   * through `indexFor`, so the refusal precedes the first vault read.
   *
   * @returns {Promise<string>} the normalised vault root.
   * @throws {MemoryError} with code `vault-cloud-managed` when the root is cloud-managed.
   */
  const vaultRoot = () => {
    if (vaultPromise === null) {
      vaultPromise = (async () => {
        const vault = await resolveVaultRoot(config.vaultPath, { home })
        if (await isCloudManagedVaultRoot(vault.root, { home })) {
          throw new MemoryError(
            'vault-cloud-managed',
            `the vault at ${vault.root} is under a cloud-managed directory; obsidian-mem refuses to read or write it until it is moved to a fully-downloaded local directory`,
          )
        }
        return vault.root
      })()
      // A refusal is not cached as an answer: the user may move the vault, so the
      // next call re-resolves instead of replaying a stale rejection.
      vaultPromise.catch(() => { vaultPromise = null })
    }
    return vaultPromise
  }

  /**
   * Resolve the project binding for one call, or `null` when unbound.
   *
   * @param {object} [exec] - the tool execution context.
   * @returns {Promise<object|null>} the binding.
   */
  async function resolveProject(exec) {
    if (binding !== null) return binding
    const key = cwdOf(exec) ?? cwd
    let pending = bindingByCwd.get(key)
    if (pending === undefined) {
      pending = (async () => {
        const resolution = await resolveBinding({ cwd: key, vaultRoot: config.vaultPath, mode: 'show', home })
        return resolution !== null && resolution.kind === 'bound' ? resolution : null
      })()
      bindingByCwd.set(key, pending)
      pending.catch(() => bindingByCwd.delete(key))
    }
    return pending
  }

  /**
   * Open (once) the index of one project.
   *
   * The vault root is taken from `vaultRoot()` first, so the R14 cloud-managed
   * refusal lands before the index is prepared or the vault is scanned — a scan
   * is a read of every note.
   *
   * @param {object|null} project - the bound project, or `null` for a global-only context.
   * @returns {Promise<object>} the object `openIndex` returns.
   */
  function indexFor(project) {
    const projectId = project === null ? null : project.projectId
    const key = projectId ?? ''
    let pending = indexByProject.get(key)
    if (pending === undefined) {
      pending = (async () => {
        const root = await vaultRoot()
        return openIndex({
          vaultRoot: root,
          dataRoot,
          backend: config.indexBackend,
          projectId,
          home,
        })
      })()
      indexByProject.set(key, pending)
      pending.catch(() => indexByProject.delete(key))
    }
    return pending
  }

  /**
   * Re-scan every open index after a committed write (spec §7: the index follows
   * a successful file write). The write is already durable, so a failed refresh
   * is not a failed write — the index reports itself `stale` on the next status.
   *
   * @returns {Promise<void>} resolves once every open index has been asked.
   */
  async function refreshOpenIndexes() {
    for (const pending of [...indexByProject.values()]) {
      let index
      try {
        index = await pending
      } catch {
        continue
      }
      try {
        await index.refresh()
      } catch {
        /* the next search retries through the ready barrier */
      }
    }
  }

  /**
   * The project a write needs, or an explicit refusal.
   *
   * @param {object} exec - the tool execution context.
   * @param {string} tool - the tool name, for the diagnostic.
   * @returns {Promise<object>} the binding.
   * @throws {MemoryError} with code `vault-cloud-managed` (R14) or `not-bound`.
   */
  async function requireProject(exec, tool) {
    // R14 first: "this vault is cloud-managed" is a more precise refusal than
    // "this repository is not bound", and it is the reason a write is refused.
    await vaultRoot()
    const project = await resolveProject(exec)
    if (project === null) {
      throw new MemoryError(
        'not-bound',
        `${tool} needs a bound project: this working directory has no .obsidian-mem pointer, and a non-bound resolution means no writes`,
      )
    }
    return project
  }

  return {
    async search(args, signal, exec) {
      const project = await resolveProject(exec)
      const index = await indexFor(project)
      const hits = await searchNotes(index, {
        query: args.query,
        scope: args.scope ?? 'project',
        type: args.type === undefined || args.type === null ? null : normalizeType(args.type),
        projectId: args.projectId ?? null,
        includeHistory: args.includeHistory === true,
        limit: args.limit ?? DEFAULT_SEARCH_LIMIT,
        signal,
      })
      return hits.map(toHitView)
    },

    async read(args, signal) {
      const root = await vaultRoot()
      // After the await, before the vault read: cancellation must beat the I/O.
      assertNotAborted({ signal })
      const note = await readNote(root, args.path, args.section, { home })
      return toNoteView(note)
    },

    async write(args, signal, exec) {
      const project = await requireProject(exec, 'mem_write')
      assertNotAborted({ signal })
      const request = { type: args.type, title: args.title, body: args.body }
      for (const key of WRITE_OPTIONS) {
        if (args[key] !== undefined) request[key] = args[key]
      }
      const session = sessionIdOf(exec)
      if (session !== null) request.session = session
      const written = await writeMemory(project, request, { dataRoot, home })
      await refreshOpenIndexes()
      return { id: written.id, path: written.path, receipt: written.receipt }
    },

    async log(args, signal, exec) {
      const project = await requireProject(exec, 'mem_log')
      assertNotAborted({ signal })
      const hotSection = args.section === undefined ? undefined : HOT_SECTIONS_BY_SECTION.get(args.section)
      const session = args.session ?? sessionIdOf(exec)
      if (hotSection !== undefined) {
        const receipt = await updateHot(project, {
          section: hotSection,
          text: args.text,
          ...(session === null || session === undefined ? {} : { session }),
          ...(args.idempotencyKey === undefined ? {} : { idempotencyKey: args.idempotencyKey }),
        }, {
          dataRoot,
          home,
          capacityChars: config.hotCapacityChars,
          archiveRatio: config.hotArchiveRatio,
        })
        await refreshOpenIndexes()
        return receipt
      }
      if (session === null || session === undefined) {
        throw new RangeError('mem_log needs a session: this call carries no agent session, so pass session="<id>"')
      }
      const receipt = await appendLog(project, {
        text: args.text,
        session,
        ...(args.section === undefined ? {} : { section: args.section }),
        ...(args.idempotencyKey === undefined ? {} : { idempotencyKey: args.idempotencyKey }),
      }, { dataRoot, home })
      await refreshOpenIndexes()
      return receipt
    },

    async brief(_args, signal, exec) {
      const project = await resolveProject(exec)
      // R14: a non-bound resolution is "no memory for this session", reported as a
      // status. `buildBrief` refuses anything that is not bound, so the service is
      // the one place that has to answer without one.
      if (project === null) return { ...BRIEF_UNBOUND }
      const index = await indexFor(project)
      const value = await buildBrief(project, { index, config, mode: 'full', signal })
      // After the await, before the value is returned: cancellation must beat the
      // answer, exactly as it does in `read`, `write` and `log`.
      assertNotAborted({ signal })
      return value
    },

    /**
     * The index handle the tools use for one call's project (Task 11 composes the
     * brief from the same object). Opening is memoised, so this can never create
     * a second handle for one project.
     *
     * @param {object} [exec] - the tool execution context that carries the cwd.
     * @returns {Promise<object>} the object `openIndex` returns.
     */
    async index(exec) {
      return indexFor(await resolveProject(exec))
    },

    /**
     * The index handle for an already-resolved binding (Task 16's queue worker).
     *
     * The worker resumes a job from its persisted project id and has no session
     * cwd to resolve, so it must not go through `resolveProject(exec)`: that would
     * bind whichever repository the process happens to sit in. Memoization is the
     * same `indexByProject` map, so the worker and the six tools share exactly one
     * handle per project.
     *
     * @param {object} binding - a `kind:'bound'` binding.
     * @returns {Promise<object>} the object `openIndex` returns.
     */
    async indexForBinding(binding) {
      return indexFor(binding ?? null)
    },

    async admin(args, signal, exec) {
      if (args.action === 'index') {
        const project = await resolveProject(exec)
        const index = await indexFor(project)
        const rebuilt = args.rebuild === true
        if (rebuilt) await index.refresh({ full: true })
        assertNotAborted({ signal })
        return { action: 'index', result: { ...toIndexStatusView(index.status()), rebuilt } }
      }
      if (args.action === 'projects') {
        const registry = await readRegistry(await vaultRoot())
        return { action: 'projects', result: { projects: registry.rows.map(toProjectRow) } }
      }
      if (args.action === 'bind') return bindAction(args, { config, dataRoot, home, cwd, exec })
      if (args.action === 'lint') {
        const project = await requireProject(exec, 'mem_admin(action="lint")')
        const index = await indexFor(project)
        // A maintenance report is worth a bounded wait: lint reports the real
        // readiness either way, but a scan that is still running would make
        // "not compared" the answer to every first call.
        if (typeof index.waitReady === 'function') {
          try {
            await index.waitReady(signal, DEFAULT_READY_TIMEOUT_MS)
          } catch {
            /* a cancelled or failed wait is reported by the lint itself */
          }
        }
        assertNotAborted({ signal })
        const report = await lintVault({
          binding: project,
          index,
          repoRoot: project.repoRoot ?? null,
          queueRoot,
          ignoreGlobs: config.ignoreGlobs ?? [],
          dataRoot,
          home,
          report: args.report === true,
          pruneHistory: args.prune === true,
          signal,
        })
        return { action: 'lint', result: toLintView(report) }
      }
      if (args.action === 'promote') {
        const project = await requireProject(exec, 'mem_admin(action="promote")')
        if (typeof args.path !== 'string' || args.path.trim() === '') {
          throw new RangeError('mem_admin(action="promote") needs path: the vault-relative path of the note to promote')
        }
        assertNotAborted({ signal })
        const promoted = await promoteNote(project, { path: args.path }, { dataRoot, home })
        await refreshOpenIndexes()
        return { action: 'promote', result: toPromoteView(promoted) }
      }
      // `jobs` is the one action that needs no vault at all: the queue lives
      // under the data root, so a session whose repository is unbound can still
      // see and retry its failures.
      return { action: 'jobs', result: await jobsAction(args, { queueRoot }) }
    },

    async close() {
      const pending = [...indexByProject.values()]
      indexByProject.clear()
      bindingByCwd.clear()
      vaultPromise = null
      await Promise.all(pending.map(async (entry) => {
        try {
          const index = await entry
          await index.close()
        } catch {
          /* a handle that never opened has nothing to release */
        }
      }))
    },
  }
}

// ---------------------------------------------------------------------------
// Projections
// ---------------------------------------------------------------------------

/** The session id provenance is recorded from, when the call carries one. */
function sessionIdOf(exec) {
  const id = exec?.agent?.session?.header?.id
  return typeof id === 'string' && id !== '' ? id : null
}

/** The working directory a call runs in, when the call carries one. */
function cwdOf(exec) {
  const cwd = exec?.agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd !== '' ? cwd : null
}

/**
 * Project one index hit onto the promise spec §9 makes: path, id, project,
 * title, type, status, source, snippet and explainable ranking signals.
 *
 * @param {object} hit - a hit from `searchNotes`.
 * @returns {object} the `mem_search` hit view.
 */
function toHitView(hit) {
  const view = {
    path: String(hit.path),
    title: hit.title ?? '',
    type: hit.type ?? '',
    status: hit.status ?? '',
    source: hit.source ?? '',
    snippet: hit.snippet ?? '',
    scoreSignals: scoreSignalsOf(hit),
  }
  if (typeof hit.id === 'string') view.id = hit.id
  if (typeof hit.projectId === 'string') view.projectId = hit.projectId
  return view
}

/**
 * Turn the index's scoring signals into the ordered, human-readable list the
 * model can use to explain why a hit ranked where it did.
 *
 * @param {object} hit - a hit from `searchNotes`.
 * @returns {string[]} at least one signal.
 */
function scoreSignalsOf(hit) {
  const signals = hit.signals ?? {}
  const out = []
  if (typeof signals.matchedBy === 'string') out.push(`matched-by:${signals.matchedBy}`)
  if (signals.titleExact === true) out.push('title-exact')
  else if (signals.titleContains === true) out.push('title-contains')
  if (signals.phraseContains === true) out.push('phrase-contains')
  if (signals.substringMatch === true) out.push('substring-match')
  if (typeof signals.tokenHits === 'number') out.push(`token-hits:${signals.tokenHits}`)
  if (typeof signals.bm25 === 'number') out.push(`bm25:${signals.bm25}`)
  if (typeof signals.relevance === 'number') out.push(`relevance:${signals.relevance}`)
  if (typeof signals.typeWeight === 'number') out.push(`type-weight:${signals.typeWeight}`)
  if (typeof signals.freshness === 'number') out.push(`freshness:${signals.freshness}`)
  if (signals.history === true) out.push('history')
  if (signals.frontmatterBroken === true) out.push('frontmatter-broken')
  if (signals.repaired === true) out.push('cache-repaired')
  if (signals.verifiedSource === true) out.push('source-verified')
  if (typeof hit.score === 'number') out.push(`score:${hit.score}`)
  return out.length > 0 ? out : ['score:0']
}

/**
 * Project a `readNote` result onto the `Note` contract.
 *
 * `hash`, `size` and `body` are always present; the frontmatter map and the
 * parse error pass through unchanged (a note without a parseable block is still
 * readable — spec §7), and a field the note does not carry is omitted rather
 * than reported as a fake empty string.
 *
 * @param {object} note - the object `readNote` returns.
 * @returns {object} the `mem_read` view.
 */
function toNoteView(note) {
  const view = {
    path: note.path,
    hash: note.hash,
    size: note.size,
    body: note.body,
    frontmatter: note.frontmatter ?? null,
    tags: Array.isArray(note.tags) ? note.tags : [],
    parseError: note.parseError ?? null,
  }
  for (const key of ['id', 'type', 'title', 'status', 'projectId', 'updated']) {
    if (typeof note[key] === 'string') view[key] = note[key]
  }
  if (typeof note.section === 'string') view.section = note.section
  if (typeof note.sectionBody === 'string') view.sectionBody = note.sectionBody
  return view
}

/**
 * Project `openIndex().status()` onto the reported index status.
 *
 * The absolute `dbPath`/`indexDir` of the plugin's own data root are left out,
 * for the same reason the bind view strips `cwd`/`repoRoot`: a tool result
 * carries no machine-local path. Design §7 documents where the index lives
 * (`<dataRoot>/index/index-<sha256(realpath(vault))>.db`), so nothing is lost.
 *
 * @param {object} status - the index status.
 * @returns {object} the `mem_admin(action="index")` result (minus `rebuilt`).
 */
function toIndexStatusView(status) {
  return {
    backend: status.backend ?? null,
    requestedBackend: status.requestedBackend,
    degraded: status.degraded === true,
    reason: status.reason ?? null,
    ready: status.ready === true,
    scanning: status.scanning === true,
    stale: status.stale === true,
    notes: status.notes ?? 0,
    schemaVersion: status.schemaVersion ?? null,
    lastScan: status.lastScan ?? null,
    lastError: status.lastError ?? null,
    boundProjectId: status.boundProjectId ?? null,
    fts: status.fts === true,
  }
}

/**
 * Project one registry row onto the reported project row.
 *
 * @param {object} row - a row from `readRegistry`.
 * @returns {object} the project row.
 */
function toProjectRow(row) {
  return {
    projectId: row.projectId,
    dir: row.dir,
    displayName: row.displayName,
    remote: row.remote ?? '',
  }
}

/**
 * Project one `resolveBinding` result onto a reportable shape.
 *
 * Machine-local absolute paths (`cwd`, `repoRoot`, `projectDir`) stay out: the
 * report carries the vault-relative directory, which is the thing a caller can
 * act on, and never an invented `obsidian://` URI.
 *
 * @param {object} resolution - the result of `resolveBinding`.
 * @returns {object} the resolution view.
 */
function toResolutionView(resolution) {
  const view = { kind: resolution.kind }
  for (const key of ['reason', 'message', 'hint']) {
    if (typeof resolution[key] === 'string') view[key] = resolution[key]
  }
  if (resolution.kind === 'bound') {
    view.projectId = resolution.projectId
    view.slug = resolution.slug
    view.displayName = resolution.displayName
    view.relativeDir = resolution.relativeDir
    view.registered = resolution.registered
    view.pointerCreated = resolution.pointerCreated
    view.pointerInherited = resolution.pointerInherited
    view.vaultExists = resolution.vaultExists
    if (resolution.pointerReplaced === true) view.pointerReplaced = true
    if (typeof resolution.previousProjectId === 'string') view.previousProjectId = resolution.previousProjectId
    if (typeof resolution.remote === 'string') view.remote = resolution.remote
    if (typeof resolution.retained === 'boolean') view.retained = resolution.retained
  }
  return view
}

/**
 * Project one lint report onto the reported shape.
 *
 * The report carries a few facts a model does not need to read on every call
 * (`repository.scanned`, the per-snapshot oversized list, the retention policy
 * object); they are dropped or folded here so the schema stays closed and the
 * payload stays bounded, while every finding keeps its path and its reason.
 *
 * @param {object} report - the object `lintVault` returned.
 * @returns {object} the `mem_admin(action="lint")` result.
 */
function toLintView(report) {
  return {
    projectId: report.projectId,
    relativeDir: report.relativeDir,
    generatedAt: report.generatedAt,
    readOnly: report.readOnly === true,
    total: report.total,
    counts: { ...report.counts },
    findings: report.findings.map((finding) => ({
      kind: finding.kind,
      severity: finding.severity,
      path: finding.path ?? null,
      message: finding.message,
    })),
    index: {
      backend: report.index.backend ?? null,
      ready: report.index.ready === true,
      notes: report.index.notes ?? null,
      rows: report.index.rows ?? null,
      files: report.index.files,
      compared: report.index.compared === true,
      reason: report.index.reason ?? null,
    },
    history: {
      policy: { ...report.history.policy },
      directories: report.history.directories,
      bytes: report.history.bytes,
      prunable: report.history.prunable,
      pruned: [...report.history.pruned],
      needsRepair: [...report.history.needsRepair],
      oversized: report.history.oversized === true,
    },
    pending: {
      jobs: report.pending.jobs,
      failed: report.pending.failed,
      invalid: report.pending.invalid,
      known: report.pending.known === true,
    },
    repository: {
      scanned: report.repository.scanned,
      candidates: report.repository.candidates,
      truncated: report.repository.truncated === true,
      known: report.repository.known === true,
    },
    report: {
      status: report.report.status,
      path: report.report.path ?? null,
      message: report.report.message ?? null,
    },
    safetyExclusions: [...report.safetyExclusions],
    ignoreGlobs: [...report.ignoreGlobs],
    truncated: { vault: report.truncated.vault === true, repo: report.truncated.repo === true },
  }
}

/** Project a promotion onto the reported shape. */
function toPromoteView(promoted) {
  return {
    source: promoted.source,
    moved: false,
    id: promoted.id,
    path: promoted.path,
    receipt: promoted.receipt,
  }
}

/** One queued job as the `jobs` result reports it (no `safeInput`, no model text). */
function toJobView(job) {
  return {
    jobId: job.jobId,
    state: job.state,
    sessionId: job.sessionId,
    projectId: job.projectId,
    fromSeq: job.fromSeq,
    toSeq: job.toSeq,
    attempts: Number.isSafeInteger(job.attempts) ? job.attempts : 0,
    createdAt: typeof job.createdAt === 'string' ? job.createdAt : null,
    failedAt: typeof job.failedAt === 'string' ? job.failedAt : null,
    lastError: typeof job.lastError === 'string' ? job.lastError : null,
    outputState: typeof job.output?.state === 'string' ? job.output.state : null,
  }
}

/**
 * `mem_admin(action="bind")`: show, or an explicit identity action.
 *
 * `show` never writes. `local` and `fork` change (or establish) this
 * repository's identity and then bootstrap the identity they produced, so the
 * very first bind creates the vault skeleton. `retain` confirms the current
 * binding and records the origin hint. A refusal — no pointer to fork, a taken
 * directory, an unreadable registry — is reported as `status: 'refused'` with the
 * resolution's own reason, never as a silent success.
 *
 * @param {object} args - the forwarded `mem_admin` arguments.
 * @param {object} seams - `{config, dataRoot, home, cwd, exec}`.
 * @returns {Promise<object>} the `mem_admin` value.
 */
async function bindAction(args, { config, dataRoot, home, cwd, exec }) {
  const mode = args.mode ?? 'show'
  const resolution = await resolveBinding({
    cwd: cwdOf(exec) ?? cwd,
    vaultRoot: config.vaultPath,
    mode,
    dataRoot,
    home,
  })
  const view = toResolutionView(resolution)
  if (mode === 'show') {
    return { action: 'bind', result: { mode, status: 'shown', resolution: view } }
  }
  if (resolution.kind !== 'bound') {
    return { action: 'bind', result: { mode, status: 'refused', resolution: view, message: resolution.message } }
  }
  if (mode === 'retain') {
    return {
      action: 'bind',
      result: {
        mode,
        status: 'retained',
        resolution: view,
        remote: resolution.remote,
        retained: resolution.retained === true,
      },
    }
  }
  const boot = await bootstrapVault(resolution, {
    initGitOnCreate: config.initGitOnCreate === true,
    home,
    dataRoot,
  })
  return {
    action: 'bind',
    result: {
      mode,
      status: mode === 'fork' ? 'forked' : 'bound',
      resolution: view,
      ...(typeof resolution.previousProjectId === 'string' ? { previousProjectId: resolution.previousProjectId } : {}),
      bootstrapped: true,
      registryUpdated: boot.registryUpdated === true,
      createdPaths: boot.createdPaths,
    },
  }
}

/**
 * `mem_admin(action="jobs")`: list the queue, inspect one job, or retry it.
 *
 * Retrying is never implicit: without `retry: true` the queue is only read.
 *
 * @param {object} args - the forwarded `mem_admin` arguments.
 * @param {{queueRoot: string}} seams - the queue root.
 * @returns {Promise<object>} the `jobs` result.
 */
async function jobsAction(args, { queueRoot }) {
  const retry = args.retry === true
  const jobId = typeof args.jobId === 'string' && args.jobId !== '' ? args.jobId : null
  if (retry && jobId === null) {
    throw new RangeError('mem_admin(action="jobs", retry=true) needs jobId: name the failed job to retry')
  }
  const read = async () => {
    const { jobs } = await readPendingJobs(queueRoot)
    return jobs
  }
  if (retry) {
    let revived = null
    try {
      revived = await retryJob(jobId, { queueRoot })
    } catch (error) {
      if (typeof error?.code === 'string') {
        const jobs = await read()
        return { status: 'refused', jobs: jobs.map(toJobView), failed: countFailed(jobs), message: `${error.code}: ${error.message}` }
      }
      throw error
    }
    if (revived === null) {
      const jobs = await read()
      return { status: 'refused', jobs: jobs.map(toJobView), failed: countFailed(jobs), message: `no pending job named ${jobId} exists in the queue` }
    }
    const jobs = await read()
    return { status: 'retried', jobs: jobs.map(toJobView), failed: countFailed(jobs), message: null }
  }
  const jobs = await read()
  const selected = jobId === null ? jobs : jobs.filter((job) => job.jobId === jobId)
  const message = jobId !== null && selected.length === 0 ? `no pending job named ${jobId} exists in the queue` : null
  return { status: 'listed', jobs: selected.map(toJobView), failed: countFailed(jobs), message }
}

/** How many queued jobs are in the terminal `failed` state. */
function countFailed(jobs) {
  return jobs.filter((job) => job.state === 'failed').length
}
