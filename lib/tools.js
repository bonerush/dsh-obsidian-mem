// The six `mem_*` tools and the host-side service layer behind them (spec §9).
//
// This module is the public entry point and nothing else: the four names below
// are the contract `lib/index.js`, `codex/server.mjs` and the tests import, and
// each one is re-exported from the module that owns it. It used to hold all
// 2,006 lines, which meant a change to a projection, a schema and a
// registration were all edits to one file and all rewrites of one import.
//
//   * `./tool-schema.js` — the parameter specs, the closed output schemas and
//     the argument rules every `execute` shares.
//   * `./tool-registry.js` — the six `defineTool` definitions and
//     `registerTools`.
//   * `./services.js` — service lifetimes, binding and index caches, admin
//     dispatch, and the projections that shape a result.
//
// The re-export list is load-bearing: a name that disappears from here breaks a
// second entry point (`codex/server.mjs`) and the packaging check in
// `scripts/verify-pack.mjs` fails on it, so the façade cannot be trimmed by a
// refactor that only looks at `lib/`.
export { TOOL_NAMES, TOOL_PARAMETERS } from './tool-schema.js'
export { registerTools } from './tool-registry.js'
export { createMemoryServices } from './services.js'
