// The `mem_*` contract: parameter specs, closed output schemas and the argument
// rules every `execute` shares (spec §9; split out of `lib/tools.js` in Task 11).
//
// The tool surface is deliberately six tools and no more. `mem_search`,
// `mem_read`, `mem_write` and `mem_log` cover the high-frequency work;
// `mem_brief` and `mem_admin` fold the rest in, so a low-frequency maintenance
// action never widens the schema the model reads on every request.
//
// This module is the author-facing source of truth for that surface. Three
// properties are deliberate and are the reason it is one module rather than
// constants scattered next to their users:
//
//   * **The parameter DSL root is open, so `execute` rejects its own keys.** DSH
//     compiles `parameters` into `{type:'object', properties, required?}` with no
//     `additionalProperties`, which means the runtime happily passes an
//     undeclared key through to `execute`. `assertKnownArguments` therefore
//     checks the argument keys against `TOOL_PARAMETERS` — the same object the
//     schema was built from, so the allow-list cannot drift — and refuses
//     anything else before a service is called.
//   * **The output schemas are closed.** Every object node — including the
//     `oneOf` arms of `mem_admin` — declares `additionalProperties` explicitly,
//     so a service that starts returning a new key fails the host's own
//     validation rather than shipping an undocumented field.
//   * **The cross-parameter rules live beside the parameters they constrain.**
//     `forwardAdminArguments` reads `ADMIN_ACTION_PARAMETERS` and refuses a
//     parameter the requested action cannot act on; keeping both here means a
//     new action cannot be added to the schema without deciding what it accepts.
//
// `assertNotAborted`, `forwardedOptions` and `forwardAdminArguments` are shared
// with `./services.js`, which is why they are exported rather than left private
// to the registration module: a check that only one caller can reach is a check
// the other caller will reimplement.
import { DEFAULT_LIMIT } from './index-db.js'

/** The complete tool surface (spec §9). Nothing else may be registered here. */
export const TOOL_NAMES = Object.freeze([
  'mem_search',
  'mem_read',
  'mem_write',
  'mem_log',
  'mem_brief',
  'mem_admin',
])

/** The service every tool needs; `registerTools` refuses a partial seam. */
export const SERVICE_KEYS = Object.freeze(['search', 'read', 'write', 'log', 'brief', 'admin'])

/** `default: 8`, mirroring `lib/index-db.js`'s bounded limit. */
export const DEFAULT_SEARCH_LIMIT = DEFAULT_LIMIT

/** Which optional `mem_admin` parameters each action can actually act on. */
export const ADMIN_ACTION_PARAMETERS = Object.freeze({
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
  // Reads one process-local ring and nothing else: no vault, no data root, no
  // binding. It is deliberately reachable when every other action refuses, which
  // is exactly when a developer needs it.
  diagnostics: Object.freeze([]),
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
    query: {
      type: 'string',
      required: true,
      description: 'Search text. Latin words are lowercased; CJK runs become overlapping bigrams.',
    },
    scope: {
      type: 'string',
      enum: ['project', 'global', 'all'],
      default: 'project',
      description:
        'project (default) is the bound project only; global is Methods/ plus _meta/user.md; all crosses projects.',
    },
    type: {
      type: 'string',
      description: 'Optional note-type filter (doc, decision, gotcha, convention, glossary, …).',
    },
    projectId: {
      type: 'string',
      description:
        'Only meaningful with scope "all"; a different id under scope "project" is refused, never silently crossed.',
    },
    includeHistory: {
      type: 'boolean',
      default: false,
      description: 'Include superseded and archived notes (excluded by default).',
    },
    limit: {
      type: 'number',
      default: DEFAULT_SEARCH_LIMIT,
      description: `Maximum hits, 1..50 (default ${DEFAULT_SEARCH_LIMIT}).`,
    },
  }),
  mem_read: Object.freeze({
    path: {
      type: 'string',
      required: true,
      description:
        'Vault-relative path of a retrievable .md note. Absolute paths, "..", symlinks and internal paths are refused.',
    },
    section: {
      type: 'string',
      description: 'Optional ATX heading; its body is returned as sectionBody.',
    },
  }),
  mem_write: Object.freeze({
    type: {
      type: 'string',
      required: true,
      description:
        'Note type; it selects the project directory: doc, decision, gotcha, convention (alias invariant), glossary.',
    },
    title: {
      type: 'string',
      required: true,
      description: 'Human title. Titles are not identity; the id is.',
    },
    body: { type: 'string', required: true, description: 'Markdown body, without frontmatter.' },
    tags: {
      type: 'array',
      items: { type: 'string' },
      description: 'Extra tags. The plugin always adds its own dsh-mem/<type> tag.',
    },
    status: {
      type: 'string',
      description:
        'Lifecycle status (active, proposed, accepted, superseded, deprecated, provisional, contested, archived).',
    },
    confidence: { type: 'number', description: 'Confidence in [0,1].' },
    assertion: {
      type: 'string',
      enum: ['stated', 'inferred', 'observed'],
      description:
        'stated: the user said it; inferred: the model concluded it; observed: verifiable tool evidence exists.',
    },
    supersedes: {
      type: 'string',
      description:
        'Stable id of the note this one replaces. The old note is marked superseded, never deleted.',
    },
    id: {
      type: 'string',
      description:
        'Update this existing id. Omitting id always CREATES a new note with a fresh random id.',
    },
    idempotencyKey: {
      type: 'string',
      description:
        'Retrying with the same key returns the original receipt instead of writing again.',
    },
  }),
  mem_log: Object.freeze({
    text: { type: 'string', required: true, description: 'One log entry.' },
    session: {
      type: 'string',
      description: 'Session the block belongs to; defaults to the calling agent session id.',
    },
    section: {
      type: 'string',
      description:
        'Day-log section heading. The reserved value "hot" (or one of 强约束/进行中/已完成) updates that controlled hot zone instead.',
    },
    idempotencyKey: {
      type: 'string',
      description: 'Retrying with the same key returns the original receipt.',
    },
  }),
  mem_brief: Object.freeze({}),
  mem_admin: Object.freeze({
    action: {
      type: 'string',
      required: true,
      enum: ['lint', 'index', 'bind', 'projects', 'promote', 'jobs', 'diagnostics'],
      description: 'Low-frequency maintenance action.',
    },
    path: {
      type: 'string',
      description:
        'Only for promote: the vault-relative path of the source note a new Methods/ note is created from. The source is never moved or rewritten.',
    },
    rebuild: {
      type: 'boolean',
      default: false,
      description: 'Only for index: re-hash every source instead of the cheap mtime/size pass.',
    },
    mode: {
      type: 'string',
      enum: ['show', 'local', 'fork', 'retain'],
      default: 'show',
      description:
        'Only for bind. show reports without writing; local binds this directory explicitly; fork mints a new project id here without moving the old project; retain confirms the current binding and records the origin remote hint.',
    },
    jobId: { type: 'string', description: 'Only for jobs: the failed job to inspect or retry.' },
    retry: {
      type: 'boolean',
      default: false,
      description: 'Only for jobs: explicitly retry the named job (requires jobId).',
    },
    report: {
      type: 'boolean',
      default: false,
      description:
        'Only for lint: additionally write the dated _meta/Lint Report note. Default false = read-only.',
    },
    prune: {
      type: 'boolean',
      default: false,
      description:
        'Only for lint: explicitly apply the .history retention policy (whole snapshot transactions older than the policy, never one a transaction still references). Default false = nothing is deleted.',
    },
  }),
})

/** Per-tool argument allow-list, derived from the specs above. */
export const TOOL_ALLOWED_KEYS = Object.freeze(
  Object.fromEntries(
    Object.entries(TOOL_PARAMETERS).map(([name, spec]) => [name, Object.freeze(Object.keys(spec))]),
  ),
)

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
  return Object.freeze(
    Object.keys(TOOL_PARAMETERS[name]).filter((key) => !requiredKeys.includes(key)),
  )
}

export const SEARCH_OPTIONS = optionalKeysOf('mem_search', ['query'])
export const READ_OPTIONS = optionalKeysOf('mem_read', ['path'])
export const WRITE_OPTIONS = optionalKeysOf('mem_write', ['type', 'title', 'body'])
export const LOG_OPTIONS = optionalKeysOf('mem_log', ['text'])

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

export const SEARCH_OUTPUT = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: { hits: { type: 'array', required: true, items: HIT_SCHEMA } },
})

/** `mem_read`'s `Note`: source-verified bytes plus the parsed frontmatter. */
export const NOTE_SCHEMA = Object.freeze({
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
export const RECEIPT_SCHEMA = Object.freeze({
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

export const WRITE_OUTPUT = Object.freeze({
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

export const BRIEF_OUTPUT = Object.freeze({
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
    status: {
      type: 'string',
      required: true,
      enum: ['shown', 'bound', 'forked', 'retained', 'refused'],
    },
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
        status: {
          type: 'string',
          required: true,
          enum: ['none', 'written', 'unchanged', 'conflict'],
        },
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
 * `mem_admin(action="diagnostics")`: one process-local ring, closed field by field.
 *
 * `additionalProperties: false` on every level is the point rather than a habit:
 * the schema is the second half of the privacy rule the ring enforces on the way
 * in. A field that is not listed here cannot leave the plugin even if a future
 * change starts recording it.
 */
const DIAGNOSTICS_RESULT = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    window: {
      type: 'object',
      additionalProperties: false,
      required: true,
      properties: {
        capacity: { type: 'number', required: true },
        size: { type: 'number', required: true },
        oldestSeq: { ...NUMBER_OR_NULL, required: true },
        newestSeq: { ...NUMBER_OR_NULL, required: true },
        dropped: { type: 'number', required: true },
      },
    },
    events: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          seq: { type: 'number', required: true },
          at: { type: 'string', required: true },
          event: {
            type: 'string',
            required: true,
            enum: ['capture', 'distill', 'index', 'bind', 'job', 'transaction', 'brief', 'skill'],
          },
          projectId: { type: 'string' },
          txId: { type: 'string' },
          jobId: { type: 'string' },
          outcome: { type: 'string' },
          code: { type: 'string' },
          attempts: { type: 'number' },
          ms: { type: 'number' },
        },
      },
    },
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

export const ADMIN_OUTPUT = Object.freeze({
  oneOf: [
    adminArm('index', INDEX_STATUS_SCHEMA),
    adminArm('projects', PROJECTS_RESULT),
    adminArm('bind', BIND_RESULT),
    adminArm('lint', LINT_RESULT),
    adminArm('promote', PROMOTE_RESULT),
    adminArm('jobs', JOBS_RESULT),
    adminArm('diagnostics', DIAGNOSTICS_RESULT),
  ],
})

/** One pure renderer for all six tools: the canonical value as JSON text. */
export const renderJson = (_args, value) => [{ type: 'text', text: JSON.stringify(value) }]

// ---------------------------------------------------------------------------
// The argument rules every `execute` shares
// ---------------------------------------------------------------------------

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
export function assertKnownArguments(name, args) {
  const allowed = TOOL_ALLOWED_KEYS[name]
  const unknown = Object.keys(args ?? {}).filter((key) => !allowed.includes(key))
  if (unknown.length === 0) return
  const named = unknown
    .sort()
    .map((key) => JSON.stringify(key))
    .join(', ')
  throw new RangeError(
    `${name} does not accept ${named}; allowed arguments are ${allowed.map((key) => JSON.stringify(key)).join(', ')}`,
  )
}

/** Cooperative cancellation: the runtime always supplies `exec.signal`. */
export function assertNotAborted(exec) {
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
export function forwardedOptions(args, keys) {
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
export function forwardAdminArguments(args) {
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
