// The six `defineTool` definitions and `registerTools` (spec §9; split out of
// `lib/tools.js` in Task 11).
//
// Nothing here decides a result. Every definition validates its own arguments,
// checks the abort signal, forwards to exactly one service and renders whatever
// came back through `renderJson`; the decisions are in `./services.js` and the
// contract is in `./tool-schema.js`. That division is what makes the surface
// testable without a vault: `registerTools(ctx, services)` takes the six
// functions as a seam, so a test can register the real tools against a stub.
//
// The registration returns the six disposers. A surviving fiber effect closes
// every open index when the owning fiber stops, because an index handle is a
// process resource and the caller is allowed to drop the returned array.
import { defineTool } from '@deepseek-ai/dsh-tools'

import {
  ADMIN_OUTPUT,
  assertKnownArguments,
  assertNotAborted,
  BRIEF_OUTPUT,
  DEFAULT_SEARCH_LIMIT,
  forwardAdminArguments,
  forwardedOptions,
  LOG_OPTIONS,
  NOTE_SCHEMA,
  READ_OPTIONS,
  RECEIPT_SCHEMA,
  renderJson,
  SEARCH_OPTIONS,
  SEARCH_OUTPUT,
  SERVICE_KEYS,
  TOOL_PARAMETERS,
  WRITE_OPTIONS,
  WRITE_OUTPUT,
} from './tool-schema.js'

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
    throw new TypeError(
      "registerTools requires a Cordis context with the tools service (inject: ['tools'])",
    )
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
    ctx.effect(() => () => {
      void services.close()
    })
  }
  return disposers
}

/** `mem_search`. */
function searchTool(services) {
  return {
    name: 'mem_search',
    description:
      'Search project memory. Defaults to the bound project; pass scope "global" for Methods/ and _meta/user.md, or "all" to cross projects.',
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
    description:
      'Read one vault note by its vault-relative path: source-verified body, parsed frontmatter and content hash.',
    parameters: TOOL_PARAMETERS.mem_read,
    output: { schema: NOTE_SCHEMA, render: renderJson },
    async execute(args, exec) {
      assertKnownArguments('mem_read', args)
      assertNotAborted(exec)
      return services.read(
        { path: args.path, ...forwardedOptions(args, READ_OPTIONS) },
        exec.signal,
        exec,
      )
    },
  }
}

/** `mem_write`. */
function writeTool(services) {
  return {
    name: 'mem_write',
    description:
      'Write a memory note. Without an id this always CREATES a note with a fresh random id; pass an existing id to update it. Superseding verifies the old id. A Git repository with no .obsidian-mem pointer is bound on first write.',
    parameters: TOOL_PARAMETERS.mem_write,
    output: { schema: WRITE_OUTPUT, render: renderJson },
    async execute(args, exec) {
      assertKnownArguments('mem_write', args)
      assertNotAborted(exec)
      const forwarded = {
        type: args.type,
        title: args.title,
        body: args.body,
        ...forwardedOptions(args, WRITE_OPTIONS),
      }
      return services.write(forwarded, exec.signal, exec)
    },
  }
}

/** `mem_log`. */
function logTool(services) {
  return {
    name: 'mem_log',
    description:
      'Append one idempotent log entry to the day log, or with section "hot" to the controlled hot zone. A Git repository with no .obsidian-mem pointer is bound on first write.',
    parameters: TOOL_PARAMETERS.mem_log,
    output: { schema: RECEIPT_SCHEMA, render: renderJson },
    async execute(args, exec) {
      assertKnownArguments('mem_log', args)
      assertNotAborted(exec)
      return services.log(
        { text: args.text, ...forwardedOptions(args, LOG_OPTIONS) },
        exec.signal,
        exec,
      )
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
    description:
      'Low-frequency vault maintenance: lint (read-only unless report=true and/or prune=true), index status/rebuild, bind (show/local/fork/retain), the project list, promote a note into Methods/, and the pending job queue with an explicit retry.',
    parameters: TOOL_PARAMETERS.mem_admin,
    output: { schema: ADMIN_OUTPUT, render: renderJson },
    async execute(args, exec) {
      assertKnownArguments('mem_admin', args)
      assertNotAborted(exec)
      return services.admin(forwardAdminArguments(args), exec.signal, exec)
    },
  }
}
