// Eager configuration validation for the obsidian-mem host plugin.
//
// `Config` is a schemastery (Standard Schema v1) object, so Cordis runs
// `Config['~standard'].validate` against the row's `config:` *before* `apply`
// is ever called. `validateConfig` layers on the v1 range checks schemastery
// cannot express — safe-integer bounds, an open ratio, a non-blank path, and the
// unknown-key refusal `z.object` does not perform — and is written to be safely
// re-runnable on the value the host already validated.
//
// `ignoreGlobs` is validated and compiled here rather than at the point of use,
// because an operator's typo must fail the row loudly instead of silently
// mis-matching every path it was meant to exclude. The accepted language is
// deliberately tiny: `*` (within one segment), `**` (across segments), `?` (one
// character) and ordinary path characters. Brace expansion, character classes,
// negation (`!…`) and escapes are refused, so no user glob can express anything
// this plugin cannot honour exactly (Task 17).
import z from '@deepseek-ai/schemastery'

import { validateProviderConfig } from './retrieval-provider.js'

export const Config = z.object({
  enabled: z.boolean().default(true),
  vaultPath: z.string().default('~/Documents/dsh-memory'),
  initGitOnCreate: z.boolean().default(true),
  injectBrief: z.boolean().default(true),
  // The unbound-session notice (`lib/init-hint.js`). `true` means a session whose
  // directory resolves to no usable project is told once — so the user is asked
  // whether to bind it, and a session whose recorded directory has been moved or
  // deleted says so instead of losing memory in silence. It is a switch because it
  // is the one injection that is not project memory: a session in a scratch
  // directory can turn the question off without losing the brief.
  bindHint: z.boolean().default(true),
  briefBudgetChars: z.number().default(6000),
  // How a long conventions index is rendered: `summary` shows five lines and
  // leaves the rest addressable through mem_brief(section='conventions'); `flat`
  // is the pre-0.3 list where the budget alone decides. Rendering only; paging
  // always sees every unit.
  briefConventionMode: z.union([z.const('summary'), z.const('flat')]).default('summary'),
  recallBudgetChars: z.number().default(900),
  // The failure-triggered recall (Task 18). `true` means a session whose tool
  // calls begin failing in a run may retrieve the project's pitfalls mid-turn,
  // sharing `recallBudgetChars` with the prompt-driven recall rather than adding a
  // second budget. It is a switch because it is the one path that searches on
  // something other than what the user typed: a session that wants retrieval keyed
  // strictly to its own prompts can turn it off without losing the brief.
  failureRecall: z.boolean().default(true),
  hotCapacityChars: z.number().default(9000),
  hotArchiveRatio: z.number().default(0.67),
  autoCapture: z.boolean().default(true),
  // The default switch for automatic curation (Task 5). `true` means a committed
  // write or a session start may trigger one bounded pass; `false` disables those
  // automatic triggers only — `mem_admin(action="curation", operation="scan")`
  // stays available, because an operator turning automation off is not asking to
  // lose the ability to curate on demand.
  autoCurate: z.boolean().default(true),
  // The automatic reviewer for parked executable proposals (`lib/curation-auto.js`).
  // `true` (the default) lets the plugin decide a confident candidate itself after a
  // curation pass (automatic passes only; an explicit scan and the Codex adapter do
  // not start it), through the same `reviewCurationProposal` the CLI and the panel
  // use. `false` disables only that model decision: the review queue, the panel
  // route and the TTY command are unchanged. It is a no-op — not an error — when
  // `distill.provider`/`distill.model` are empty, because a background trigger
  // cannot know a session's last recorded route.
  autoReview: z.boolean().default(true),
  captureIdleMs: z.number().default(90000),
  distill: z.object({
    provider: z.string().default(''),
    model: z.string().default(''),
    // How the one tool-free model call reaches a model. `host` is the
    // DSH host service (`ctx.get('llm')`), unchanged since 1.0.0; `http` is an
    // OpenAI-compatible /chat/completions endpoint this plugin calls itself, so
    // distillation works without a host route (the Codex adapter, a TUI with no
    // routed provider, a CLI run) and can target a local model server or a
    // cloud one. The prompt, the strict JSON contract and every validation rule
    // are the same on both paths — this field picks a transport, not a policy.
    transport: z.union([z.const('host'), z.const('http')]).default('host'),
    // Which endpoint forms the http transport may use, with the same two modes
    // and the same literal-address rule as `retrievalProvider.egress`.
    egress: z.union([z.const('loopback'), z.const('remote')]).default('loopback'),
    endpoint: z.string().default(''),
    apiStyle: z.union([z.const('openai-chat')]).default('openai-chat'),
    // The NAME of the environment variable holding the credential, never the
    // credential. Empty means an unauthenticated endpoint (the local default).
    apiKeyEnv: z.string().default(''),
    maxItems: z.number().default(12),
    minConfidence: z.number().default(0.75),
    maxInputChars: z.number().default(24000),
    maxOutputTokens: z.number().default(4000),
    timeoutMs: z.number().default(60000),
    maxRetries: z.number().default(3),
    dryRun: z.boolean().default(false),
    learnHabits: z.boolean().default(true),
  }),
  indexBackend: z.union([z.const('auto'), z.const('sqlite'), z.const('scan')]).default('auto'),
  // How `mem_search` ranks. `hybrid` is the default from 2.0.0: it adds the
  // loopback dense candidate channel from ./retrieval-provider.js to the existing
  // lexical order (spec 2026-11-02). It is default-on in *engine* only — the
  // provider still ships disabled and empty, because every field describes an
  // operator's own local service and nothing here may silently invent one. With
  // no provider configured the engine resolves to the lexical path unchanged, so
  // an unconfigured row still behaves exactly as it did before v0.4; the fallback
  // is stated on every search (`hybridFallback: 'provider-disabled'`) rather than
  // implied. `sparse` reranks a bounded candidate set by local TF-IDF/cosine and
  // fuses the two orders without needing anything. `semantic` remains
  // deliberately absent: a bare word would promise a provider selection this
  // schema cannot make, which is what retrievalProvider exists to state.
  retrievalEngine: z
    .union([z.const('lexical'), z.const('sparse'), z.const('hybrid')])
    .default('hybrid'),
  // The optional embedding provider that the hybrid engine reads. It ships
  // disabled and empty: every field describes an operator's own service, so
  // nothing here can silently invent one. The block is judged by
  // ./retrieval-provider.js rather than by a second copy of its rules.
  //
  // Since 2.2.0 a provider may be local *or* remote. `egress` is the operator's
  // explicit statement of which, and it is what makes a non-loopback endpoint
  // legal: the literal-address rule is a loopback-mode rule, not a blanket ban.
  // `apiStyle` says which wire protocol the service speaks — the plugin's own
  // /embed contract, or the OpenAI-compatible /embeddings one an internal
  // gateway or a commercial API offers. `apiKeyEnv` names an environment
  // variable; a secret is never stored in this file.
  retrievalProvider: z.object({
    enabled: z.boolean().default(false),
    egress: z.union([z.const('loopback'), z.const('remote')]).default('loopback'),
    endpoint: z.string().default(''),
    apiStyle: z.union([z.const('embed'), z.const('openai')]).default('embed'),
    apiKeyEnv: z.string().default(''),
    model: z.string().default(''),
    dimensions: z.number().default(0),
    timeoutMs: z.number().default(500),
    rerank: z.boolean().default(false),
  }),
  ignoreGlobs: z.array(z.string()).default([]),
})

/**
 * The exact accepted key set, read back from the schema's own defaults.
 *
 * Derived rather than written twice: a second literal list would be a place for
 * the field set to drift out of the schema it is supposed to guard. Every field
 * declares a default, so `validate(undefined)` materialises all of them.
 */
const SCHEMA_DEFAULTS = Config['~standard'].validate(undefined).value
/** Accepted top-level keys. */
const CONFIG_KEYS = new Set(Object.keys(SCHEMA_DEFAULTS))
/** Accepted keys inside `distill`. */
const DISTILL_KEYS = new Set(Object.keys(SCHEMA_DEFAULTS.distill))
/** Accepted keys inside `retrievalProvider`. */
const PROVIDER_KEYS = new Set(Object.keys(SCHEMA_DEFAULTS.retrievalProvider))

/**
 * Fields the design document's §12 lists but the plan's field set drops.
 *
 * They are named in the refusal because a user copying that block gets an error
 * either way; naming them turns "unknown key" into "this was dropped on purpose,
 * go read README §Configuration".
 */
const DROPPED_BY_DESIGN = Object.freeze([
  'projectsDir',
  'methodsDir',
  'metaDir',
  'reservedPrefixes',
  'docMirror',
  'distill.mode',
  'distill.maxCostPerSession',
])

/**
 * Refuse a config object carrying a key the plan's field set does not define.
 *
 * schemastery's `z.object` is not strict: an unknown key is passed through into
 * the validated value untouched, so `{ vaultpath: '/tmp/nope' }` would silently
 * fall back to `vaultPath`'s default and point the plugin — and its bootstrap —
 * at a different vault than the operator wrote. A typo in a hand-written row
 * must be the operator's error, not a silently different vault (T3 deferred
 * minor, confirmed live by the whole-branch review).
 *
 * @param {unknown} raw - raw row config.
 * @throws {Error} naming every unknown key, and the fields dropped by design.
 */
function rejectUnknownKeys(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return
  const unknown = Object.keys(raw).filter((key) => !CONFIG_KEYS.has(key))
  // A nested block is checked the same way its parent is: an unknown key inside
  // `distill` would otherwise keep its default in silence, which
  // is the same failure the top-level check exists to prevent.
  for (const [block, accepted] of [
    ['distill', DISTILL_KEYS],
    ['retrievalProvider', PROVIDER_KEYS],
  ]) {
    const nested = raw[block]
    if (nested === null || typeof nested !== 'object' || Array.isArray(nested)) continue
    unknown.push(
      ...Object.keys(nested)
        .filter((key) => !accepted.has(key))
        .map((key) => `${block}.${key}`),
    )
  }
  if (unknown.length === 0) return
  throw new Error(
    `unknown config key${unknown.length === 1 ? '' : 's'} ${unknown.map((key) => JSON.stringify(key)).join(', ')}; ` +
      `this plugin's config is exactly ${[...CONFIG_KEYS].join(', ')} with ${[...DISTILL_KEYS].map((key) => `distill.${key}`).join(', ')} inside distill and ${[...PROVIDER_KEYS].map((key) => `retrievalProvider.${key}`).join(', ')} inside retrievalProvider. ` +
      'A key that is not in that set is refused instead of being ignored, because a typo in a known key would otherwise ' +
      'silently keep its default (for example a mistyped `vaultPath` would point the plugin at the default vault). ' +
      `The design document also lists fields that this plugin deliberately does not have and that are refused for the same reason: ${DROPPED_BY_DESIGN.join(', ')}.`,
  )
}

/** The longest accepted `ignoreGlobs` entry, in code points. */
export const IGNORE_GLOB_MAX_CHARS = 200
/**
 * The accepted alphabet: letters, numbers, marks, `.`, `_`, `-`, `/`, space and
 * the three glob operators. Everything else is unsupported syntax.
 */
const IGNORE_GLOB_ALLOWED = /^[\p{L}\p{N}\p{M}._\-/ *?]+$/u

/**
 * Assert that one `ignoreGlobs` entry is a glob this plugin can honour exactly.
 *
 * @param {unknown} glob - the candidate entry.
 * @returns {string} the entry, unchanged.
 * @throws {RangeError} when it is not a supported vault-relative glob.
 */
export function assertIgnoreGlob(glob) {
  if (typeof glob !== 'string') throw new RangeError('ignoreGlobs entries must be strings')
  const points = [...glob]
  if (points.length === 0 || glob.trim() === '')
    throw new RangeError('ignoreGlobs entries must be non-blank globs')
  if (points.length > IGNORE_GLOB_MAX_CHARS) {
    throw new RangeError(
      `ignoreGlobs entry is longer than ${IGNORE_GLOB_MAX_CHARS} characters: ${JSON.stringify(glob)}`,
    )
  }
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
  if (/[\u0000-\u001f\u007f]/.test(glob)) {
    throw new RangeError(
      `ignoreGlobs entry must not contain control characters: ${JSON.stringify(glob)}`,
    )
  }
  const unsupported = [...glob].find((character) => !IGNORE_GLOB_ALLOWED.test(character))
  if (unsupported !== undefined) {
    throw new RangeError(
      `ignoreGlobs does not support ${JSON.stringify(unsupported)} in ${JSON.stringify(glob)}; only *, **, ? and ordinary path characters are allowed`,
    )
  }
  if (glob.startsWith('/')) {
    throw new RangeError(
      `ignoreGlobs must be vault- or repository-relative, never absolute: ${JSON.stringify(glob)}`,
    )
  }
  if (glob.split('/').includes('..')) {
    throw new RangeError(`ignoreGlobs must not contain "..": ${JSON.stringify(glob)}`)
  }
  return glob
}

/**
 * Compile one supported glob into an anchored, `/`-separated path matcher.
 *
 * The glob is to be read against the path a caller offers (vault-relative or
 * repository-relative, POSIX separators). Every character that is not an
 * operator is escaped before the pattern is anchored, so a `.` in a user's glob
 * can never become a regular-expression wildcard.
 *
 * @param {string} glob - a supported glob.
 * @returns {RegExp} the anchored matcher.
 * @throws {RangeError} when the glob uses unsupported syntax.
 */
export function compileIgnoreGlob(glob) {
  assertIgnoreGlob(glob)
  let source = ''
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index]
    if (character === '*') {
      if (glob[index + 1] === '*') {
        // `**/` spans zero or more whole segments; a bare `**` spans anything.
        if (glob[index + 2] === '/') {
          source += '(?:[^/]+/)*'
          index += 2
        } else {
          source += '.*'
          index += 1
        }
      } else {
        source += '[^/]*'
      }
      continue
    }
    if (character === '?') {
      source += '[^/]'
      continue
    }
    source += /[.*+?^${}()|[\]\\]/.test(character) ? `\\${character}` : character
  }
  return new RegExp(`^${source}$`, 'u')
}

/**
 * Compile a list of globs, refusing the whole list when one entry is unsupported.
 *
 * @param {unknown} globs - the configured list.
 * @returns {RegExp[]} one anchored matcher per entry, in order.
 * @throws {RangeError} when the list or one of its entries is invalid.
 */
export function compileIgnoreGlobs(globs) {
  if (!Array.isArray(globs)) throw new RangeError('ignoreGlobs must be an array of globs')
  return globs.map((glob) => compileIgnoreGlob(glob))
}

/**
 * Whether one path matches any compiled glob.
 *
 * @param {string} path - a `/`-separated relative path.
 * @param {RegExp[]} matchers - compiled globs.
 * @returns {boolean} true when at least one glob matches.
 */
export function matchesIgnoreGlob(path, matchers) {
  return matchers.some((matcher) => matcher.test(path))
}

/**
 * The numeric bounds of every config field that validates one, in one table.
 *
 * Two readers share it and must never drift: `validateConfig` (the authority that
 * refuses an out-of-range plugin row) and `describeConfigFields` (the projection the
 * plugin page renders and validates against inline). A bound declared here is the
 * only copy, so a form cannot offer a value the loader would refuse, and a loader
 * check cannot be missing from the form.
 *
 * Entry shape: `{min?, max?, integer?, exclusiveMin?, exclusiveMax?}`.
 *   * `integer: true` — the value must be a safe integer in `[min, max]`;
 *   * `min`/`max` — inclusive bounds for a real number;
 *   * `exclusiveMin`/`exclusiveMax` — a strict bound; see `hotArchiveRatio`'s (0, 1).
 * A path is the dotted config path (`'distill.maxItems'`).
 */
export const CONFIG_RANGES = Object.freeze({
  briefBudgetChars: Object.freeze({ min: 256, max: 20000, integer: true }),
  recallBudgetChars: Object.freeze({ min: 256, max: 20000, integer: true }),
  hotCapacityChars: Object.freeze({ min: 1024, max: 50000, integer: true }),
  captureIdleMs: Object.freeze({ min: 1000, max: 3600000, integer: true }),
  'distill.maxItems': Object.freeze({ min: 1, max: 50, integer: true }),
  'distill.maxInputChars': Object.freeze({ min: 256, max: 100000, integer: true }),
  'distill.maxOutputTokens': Object.freeze({ min: 128, max: 32000, integer: true }),
  'distill.timeoutMs': Object.freeze({ min: 1000, max: 300000, integer: true }),
  'distill.maxRetries': Object.freeze({ min: 0, max: 10, integer: true }),
  hotArchiveRatio: Object.freeze({ exclusiveMin: 0, exclusiveMax: 1 }),
  'distill.minConfidence': Object.freeze({ min: 0, max: 1 }),
})

/**
 * One dotted config path's value, without trusting any intermediate node.
 *
 * @param {object} config - a validated config object.
 * @param {string} path - the dotted path.
 * @returns {unknown} the value, or `undefined` when the path does not resolve.
 */
function configPathValue(config, path) {
  let node = config
  for (const key of path.split('.')) {
    if (node === null || typeof node !== 'object') return undefined
    node = node[key]
  }
  return node
}

/**
 * Whether one value satisfies one `CONFIG_RANGES` entry.
 *
 * @param {unknown} value - the candidate value.
 * @param {{min?: number, max?: number, integer?: boolean, exclusiveMin?: number, exclusiveMax?: number}} range - the bounds.
 * @returns {boolean} whether the value is in range.
 */
function valueInRange(value, range) {
  if (range.integer === true) {
    return Number.isSafeInteger(value) && value >= range.min && value <= range.max
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    // The schema has already typed numeric fields; a non-number here is a schema
    // change this table is not written for, and refusing it is the safe answer.
    return false
  }
  if (range.min !== undefined && value < range.min) return false
  if (range.max !== undefined && value > range.max) return false
  if (range.exclusiveMin !== undefined && value <= range.exclusiveMin) return false
  if (range.exclusiveMax !== undefined && value >= range.exclusiveMax) return false
  return true
}

/**
 * The flat, browser-renderable projection of the `Config` schema's leaves.
 *
 * The plugin page's form must never keep a second copy of the field set: this walks
 * `Config.toJSON()`'s ref table (the schema's own serialized graph) and projects one
 * entry per leaf, in declaration order. `enabled` is dropped because the plugin page's
 * own switch owns that field; a `hidden` node is dropped for the same reason a form
 * renderer would hide it.
 *
 * Each entry is what the client renders with:
 * `{path, segments, type, default, enum?, min?, max?, integer?}` where
 *   * `path` is the dotted leaf path (`'distill.provider'`) — the form's key and the
 *     one the client splits to read/write the nested value; `segments` is the same
 *     path split into its parts, for a reader that wants the pieces;
 *   * `type` is `boolean`, `number`, `integer`, `string`, `enum` (a union of string
 *     constants), or `stringArray` (`z.array(z.string())`);
 *   * `default` is the value `validateConfig(undefined)` fills for that leaf;
 *   * `enum` lists the only accepted strings; `min`/`max` carry the field's bounds
 *     from `CONFIG_RANGES` (or a schema's own range metadata), `integer` says the
 *     value must be a whole number, and `exclusiveMin`/`exclusiveMax` say a bound is
 *     strict (`hotArchiveRatio` is `(0, 1)`).
 *
 * A schema node this projection cannot render throws instead of guessing: a form that
 * silently dropped or mistyped a new field would be worse than a build error the
 * schema test catches.
 *
 * @returns {Array<{path: string, segments: string[], type: string, default: *, enum?: string[], min?: number, max?: number, integer?: boolean, exclusiveMin?: boolean, exclusiveMax?: boolean}>} the leaf fields.
 * @throws {RangeError} when the schema contains a node type this projection does not know.
 */
export function describeConfigFields() {
  const document = Config.toJSON()
  const refs = document?.refs ?? {}
  const nodeOf = (uid) => {
    const node = refs[String(uid)]
    return node !== null && typeof node === 'object' ? node : null
  }
  /** One leaf's own default: absent is `null`, so the wire always carries the key. */
  const defaultOf = (node) => (Object.hasOwn(node.meta ?? {}, 'default') ? node.meta.default : null)
  const fields = []
  /**
   * Project one schema node; `path` is already resolved for it.
   *
   * @param {object} node - the schema node.
   * @param {string[]} path - its config path.
   * @returns {void}
   */
  const project = (node, path) => {
    if (node.meta?.hidden === true) return
    if (node.type === 'object') {
      const dict = node.dict ?? {}
      for (const [key, child] of Object.entries(dict)) {
        // The plugin page's enable switch is not this form's field.
        if (path.length === 0 && key === 'enabled') continue
        const childNode = nodeOf(child)
        if (childNode === null) {
          throw new RangeError(`Config schema node ${[...path, key].join('.')} is missing`)
        }
        project(childNode, [...path, key])
      }
      return
    }
    if (node.type === 'array') {
      const inner = nodeOf(node.inner)
      if (inner === null || inner.type !== 'string') {
        throw new RangeError(`Config array ${path.join('.')} is not an array of strings`)
      }
      fields.push({
        path: path.join('.'),
        segments: path,
        type: 'stringArray',
        default: defaultOf(node),
      })
      return
    }
    if (node.type === 'union') {
      const members = (node.list ?? []).map(nodeOf)
      const values = members.map((member) => (member?.type === 'const' ? member.value : undefined))
      if (values.length === 0 || values.some((value) => typeof value !== 'string')) {
        throw new RangeError(`Config union ${path.join('.')} is not a union of string constants`)
      }
      fields.push({
        path: path.join('.'),
        segments: path,
        type: 'enum',
        default: defaultOf(node),
        enum: values,
      })
      return
    }
    if (node.type === 'boolean' || node.type === 'string') {
      fields.push({
        path: path.join('.'),
        segments: path,
        type: node.type,
        default: defaultOf(node),
      })
      return
    }
    if (node.type === 'number') {
      // Schemastery has no distinct integer type, and its schema metadata carries no
      // bounds today: `CONFIG_RANGES` is the bounds source the validator and this
      // projection share, so the form can reject an out-of-range value before the
      // save it would have refused. A node's own `.min()/.max()/.step(1)` metadata is
      // still honored when a future schema declares it.
      const dotted = path.join('.')
      const range = CONFIG_RANGES[dotted]
      const integer = range?.integer === true || node.meta?.step === 1
      const field = {
        path: dotted,
        segments: path,
        type: integer ? 'integer' : 'number',
        default: defaultOf(node),
      }
      if (integer) field.integer = true
      const min = range?.min ?? range?.exclusiveMin ?? node.meta?.min
      const max = range?.max ?? range?.exclusiveMax ?? node.meta?.max
      if (Number.isFinite(min)) field.min = min
      if (Number.isFinite(max)) field.max = max
      if (range?.exclusiveMin !== undefined) field.exclusiveMin = true
      if (range?.exclusiveMax !== undefined) field.exclusiveMax = true
      fields.push(field)
      return
    }
    throw new RangeError(
      `describeConfigFields cannot project ${path.join('.') || '(root)'}: unsupported schema type ${JSON.stringify(node.type)}`,
    )
  }
  const root = nodeOf(document?.uid)
  if (root === null) throw new RangeError('Config.toJSON() did not answer its root node')
  project(root, [])
  return fields
}

/**
 * Validate raw plugin config and return the normalised config object.
 *
 * The Standard Schema entry is the same one Cordis uses, so a row without a
 * `config:` block, a partial row config, and the already-validated object the
 * host hands to `apply` all resolve through one code path. Schema violations
 * surface as an `Error` listing every issue; an unknown key as an `Error` naming
 * it (and the fields the design document drops); v1 range violations as a
 * `RangeError` naming the offending field.
 *
 * @param {unknown} raw - raw row config (possibly `undefined`).
 * @returns {object} the validated config with defaults applied.
 * @throws {Error} when schemastery reports issues, or when a key is unknown.
 * @throws {RangeError} when a v1 range check fails.
 */
export function validateConfig(raw) {
  rejectUnknownKeys(raw)
  const result = Config['~standard'].validate(raw)
  if (result.issues) throw new Error(result.issues.map((x) => x.message).join('; '))
  const c = result.value
  // Every numeric bound is the form's bounds too (`CONFIG_RANGES`), so the plugin
  // page cannot offer a value this check would refuse. The refusal is the same as
  // it has always been: a `RangeError` whose message is the dotted field path.
  for (const [path, range] of Object.entries(CONFIG_RANGES)) {
    if (!valueInRange(configPathValue(c, path), range)) throw new RangeError(path)
  }
  if (!c.vaultPath.trim()) throw new RangeError('vaultPath')
  if (Boolean(c.distill.provider) !== Boolean(c.distill.model))
    throw new RangeError('distill.route')
  // The transport and its endpoint are one decision. An endpoint written next to
  // 'host' would be config the plugin never reads — the same silent-default class
  // the unknown-key refusal exists for — and 'http' without one cannot make a
  // call at all. Both are refused here rather than deferred to the first job.
  if (c.distill.transport === 'host' && c.distill.endpoint !== '')
    throw new RangeError('distill.endpoint')
  if (c.distill.transport === 'http' && c.distill.endpoint.trim() === '')
    throw new RangeError('distill.endpoint')
  // The provider block is judged by the contract that will read it, not by a
  // second copy of the loopback/dimension rules. An enabled provider is legal
  // with any engine (nothing calls it under lexical). Since 2.0.0 the engine
  // defaults to `hybrid` while the provider defaults to disabled, so "hybrid with
  // no provider" is the *shipped* row and must load: it is not a config that
  // cannot be honoured, it is one that asked for an optional channel and did not
  // supply it. `search` answers from the lexical branch and states
  // `provider-disabled` in the search diagnostics, so the state is visible rather
  // than implied. What stays refused is the incoherent row: `enabled: true` with
  // an unusable endpoint, which is checked above by validateProviderConfig.
  const provider = validateProviderConfig(c.retrievalProvider)
  // The shipped row since 2.0.0 is `hybrid` with a disabled provider, so this
  // combination has to load. It is not a config that cannot be honoured: it asked
  // for an optional channel and did not supply one, and `services.search` answers
  // from the lexical branch with `provider-disabled` on the search event. What
  // stays refused is an *enabled* provider that cannot be used (remote endpoint,
  // blank model, non-integer width) — validateProviderConfig above throws on each.
  // Nothing needs the parsed provider handle here; no throw, no rewrite.
  void provider
  // Unsupported glob syntax is refused here, where a typo is still the
  // operator's, rather than silently mis-matching at the point of use (T17).
  compileIgnoreGlobs(c.ignoreGlobs)
  return c
}
