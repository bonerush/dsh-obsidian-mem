#!/usr/bin/env node
// Package-manifest verifier for dsh-obsidian-mem (Task 19; R7, R34, R8).
//
// `npm run prepack` runs the test suite and then this script, so nothing here
// may run `npm pack`: that would re-enter `prepack` and recurse. Instead this is
// a static read of the two manifests plus the tree they describe.
//
// It is a verifier and nothing else. It never edits user configuration, never
// launches Obsidian, never writes inside a vault and never touches `$DSH_HOME`;
// its only outputs are a report on stdout and an exit code (0 pass, 1 fail,
// 2 usage error). Failures are reported all at once, because a pack regression
// usually trips more than one check and seeing every one beats fixing them in
// a guess-and-rerun loop.
//
// What it guarantees:
//
//   1. `package.json` and `dsh.plugin.json` agree on version, plugin identity
//      and entry point.
//   2. `files` is a deliberate list: relative, escape-free, no `~`, no `..`.
//   3. Every asset the tarball must carry exists on disk AND is covered by that
//      list. The portable skill is the one Task 13 added, and a `files`
//      regression that dropped it would ship a plugin with no methodology.
//   4. No entry — including every file a directory entry would pull in — is a
//      scratch/research/docs/test tree, a dependency tree, a probe record, a
//      vault-internal `_meta/` path, or pending queue data.
//   5. The declared Node floor is present and well formed, and `lib/tools.js`
//      still registers the six `mem_*` tools the surface promises.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
/** The checkout this script lives in; `--root` exists for the fixture tests. */
const DEFAULT_ROOT = resolve(HERE, '..')

/**
 * Path segments that must never appear in a packed path.
 *
 * `node_modules` and the data-root directories (`pending`, `locks`,
 * `transactions`) are never package content; `docs`, `test`, `research` and
 * `scratch` are development trees; `_meta` and `.history` are vault internals
 * that must never ship into a user's tree.
 */
const FORBIDDEN_SEGMENTS = new Set([
  'node_modules', 'pending', 'locks', 'transactions', '.history', '_meta',
  '.obsidian', '.superpowers', 'scratch', 'research', 'docs', 'test', 'coverage',
])

/** Basenames that are always evidence or local state, never an asset. */
const FORBIDDEN_NAMES = [
  /^probe/i,
  /\.jsonl$/i,
  /\.(?:db|sqlite|sqlite3|lock|tgz|log)$/i,
  /^\.env/i,
  /^\.obsidian-mem$/,
]

/** Assets the tarball must carry, and the reason each one is mandatory. */
const REQUIRED_ASSETS = [
  ['lib/index.js', 'the plugin entry point'],
  ['skills/obsidian-mem/SKILL.md', 'the portable methodology skill'],
  ['cordis.patch.yml', 'the bundle patch that mounts the row'],
  ['dsh.plugin.json', 'the marketplace manifest'],
  ['README.md', 'the install and honest-limits documentation'],
  ['LICENSE', 'the declared MIT license'],
]

/** The six registered tools; the design deliberately caps the surface at six. */
const TOOL_NAMES = ['mem_search', 'mem_read', 'mem_write', 'mem_log', 'mem_brief', 'mem_admin']

/** Parse `--root <dir>` (also `--root=<dir>`). */
function parseArgs(argv) {
  let root = DEFAULT_ROOT
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--root') {
      root = argv[index + 1]
      index += 1
    } else if (argument.startsWith('--root=')) {
      root = argument.slice('--root='.length)
    } else {
      throw new Error(`unknown argument ${JSON.stringify(argument)}; usage: verify-pack.mjs [--root <dir>]`)
    }
    if (typeof root !== 'string' || !root.trim()) throw new Error('--root needs a directory')
  }
  return resolve(root)
}

/** Read and parse one JSON file, or throw a message naming the file. */
function readJson(path) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    throw new Error(`cannot read ${path}: ${error.message}`)
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`cannot parse ${path}: ${error.message}`)
  }
}

/** True when `target` is one of the allowlist entries or lives below one. */
function isCovered(target, entries) {
  return entries.some((entry) => target === entry || target.startsWith(entry.endsWith('/') ? entry : `${entry}/`))
}

/** Every file a directory entry would pull into the tarball, as pack-relative paths. */
function expand(entry, root) {
  const full = join(root, entry)
  let stats
  try {
    stats = statSync(full)
  } catch {
    return []
  }
  if (!stats.isDirectory()) return [entry]
  const found = []
  for (const child of readdirSync(full, { withFileTypes: true })) {
    const childPath = `${entry}/${child.name}`
    if (child.isDirectory()) found.push(...expand(childPath, root))
    else found.push(childPath)
  }
  return found
}

/**
 * Verify one checkout's pack contract.
 *
 * @param {string} root - the package root to inspect (read-only).
 * @returns {string[]} one message per problem; empty means the pack is sound.
 */
export function verifyPack(root) {
  const problems = []
  const pkg = readJson(join(root, 'package.json'))
  const plugin = readJson(join(root, 'dsh.plugin.json'))

  // 1. The two manifests describe one release.
  if (typeof pkg.version !== 'string' || !pkg.version.trim()) problems.push('package.json: version must be a non-blank string')
  if (typeof plugin.version !== 'string' || !plugin.version.trim()) problems.push('dsh.plugin.json: version must be a non-blank string')
  if (pkg.version !== plugin.version) {
    problems.push(`version disagreement: package.json is ${JSON.stringify(pkg.version)} but dsh.plugin.json is ${JSON.stringify(plugin.version)}`)
  }
  if (pkg.name !== plugin.id) {
    problems.push(`identity disagreement: package.json name ${JSON.stringify(pkg.name)} is not dsh.plugin.json id ${JSON.stringify(plugin.id)}`)
  }
  if (pkg.main !== plugin.main) {
    problems.push(`entry disagreement: package.json main ${JSON.stringify(pkg.main)} is not dsh.plugin.json main ${JSON.stringify(plugin.main)}`)
  }

  const floor = pkg.engines?.node
  if (typeof floor !== 'string' || !/^>=\d+\.\d+\.\d+$/.test(floor)) {
    problems.push(`engines.node must be a measured floor like ">=22.22.2" (R8); found ${JSON.stringify(floor)}`)
  }

  // 2. `files` is deliberate and cannot escape the package root.
  const entries = pkg.files
  if (!Array.isArray(entries) || entries.length === 0) {
    problems.push('package.json: files must be a non-empty allowlist (R7)')
    return problems
  }
  for (const entry of entries) {
    if (typeof entry !== 'string' || !entry.trim()) {
      problems.push(`files: ${JSON.stringify(entry)} is not a non-blank string`)
      continue
    }
    if (isAbsolute(entry)) problems.push(`files: ${JSON.stringify(entry)} is absolute; entries must be package-relative`)
    if (entry.startsWith('~') || entry.includes('~')) problems.push(`files: ${JSON.stringify(entry)} uses a home shorthand; entries must be package-relative`)
    if (entry.startsWith('/')) problems.push(`files: ${JSON.stringify(entry)} starts with "/"`)
    if (entry.split('/').includes('..')) problems.push(`files: ${JSON.stringify(entry)} escapes the package root with ".."`)
    if (entry !== entry.replace(/\/{2,}/g, '/').replace(/^\.\//, '').replace(/\/$/, '')) {
      problems.push(`files: ${JSON.stringify(entry)} is not a normalised relative path`)
    }
    if (entry === '.' || entry === '..' || entry === '*') problems.push(`files: ${JSON.stringify(entry)} would pack the whole repository`)
  }

  // 4. Nothing the allowlist would pack is scratch, evidence or local state.
  //
  // The entry itself is checked as well as what it expands to: a forbidden entry
  // is dangerous whether or not it happens to exist right now, and an entry for
  // a path that does not exist yet is exactly how one gets committed by accident.
  for (const entry of entries) {
    if (typeof entry !== 'string' || !entry.trim()) continue
    for (const packed of [entry, ...expand(entry, root)]) {
      const segments = packed.split('/')
      const bad = segments.find((segment) => FORBIDDEN_SEGMENTS.has(segment))
      if (bad !== undefined) {
        problems.push(`files: ${JSON.stringify(entry)} would pack ${JSON.stringify(packed)} (${JSON.stringify(bad)} is never package content)`)
        continue
      }
      const name = segments[segments.length - 1]
      const matched = FORBIDDEN_NAMES.find((pattern) => pattern.test(name))
      if (matched !== undefined) {
        problems.push(`files: ${JSON.stringify(entry)} would pack ${JSON.stringify(packed)} (${matched} is never package content)`)
      }
    }
  }

  // 3. Every mandatory asset exists and is covered by the allowlist.
  for (const [path, why] of REQUIRED_ASSETS) {
    if (!existsSync(join(root, path))) problems.push(`${path} is missing on disk (${why})`)
    if (!isCovered(path, entries)) problems.push(`files does not cover ${path} (${why})`)
  }

  // 5. The shipped tool surface is still the six tools the design promises.
  const toolsPath = join(root, 'lib/tools.js')
  if (existsSync(toolsPath)) {
    const source = readFileSync(toolsPath, 'utf8')
    for (const name of TOOL_NAMES) {
      if (!source.includes(`'${name}'`) && !source.includes(`"${name}"`) && !source.includes(`\`${name}\``)) {
        problems.push(`lib/tools.js no longer registers ${name}`)
      }
    }
  } else {
    problems.push('lib/tools.js is missing on disk (the six-tool surface)')
  }

  return problems
}

function main() {
  let root
  try {
    root = parseArgs(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`verify-pack: ${error.message}\n`)
    return 2
  }
  let problems
  try {
    problems = verifyPack(root)
  } catch (error) {
    process.stderr.write(`verify-pack: FAIL ${error.message}\n`)
    return 1
  }
  if (problems.length > 0) {
    process.stdout.write(`verify-pack: FAIL (${problems.length} problem${problems.length === 1 ? '' : 's'}) in ${root}\n`)
    for (const problem of problems) process.stdout.write(`  - ${problem}\n`)
    return 1
  }
  process.stdout.write(`verify-pack: OK ${root}\n`)
  process.stdout.write(`  version ${readJson(join(root, 'package.json')).version}, files allowlist ${readJson(join(root, 'package.json')).files.length} entries, ${REQUIRED_ASSETS.length} required assets present and covered, ${TOOL_NAMES.length} tools registered\n`)
  return 0
}

process.exitCode = main()
