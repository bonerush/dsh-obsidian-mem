#!/usr/bin/env node
// Real-archive verifier (Task 6).
//
// `verify-pack.mjs` reads the two manifests and the tree they describe; it cannot
// see what npm actually puts in the tarball. The design used to assert a frozen
// "33 files" instead, which `lib/` growing by three modules would break — turning a
// real contract into a tripwire. This script packs for real and checks the *set*:
// every extant `lib/**/*.js` ships, the required assets ship, and nothing from the
// development trees or a vault ships.
//
// It is a verifier and nothing else: one temporary directory, packed into,
// removed in a `finally`, and no write inside the repository or a vault.
// `--ignore-scripts` is not optional — a bare `npm pack` re-enters `prepack`, which
// would run this repository's whole test suite from inside a pack.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
/** The checkout this script lives in. */
const DEFAULT_ROOT = resolve(HERE, '..')

/** Archive paths the package must carry, each with the reason it is mandatory. */
export const REQUIRED_ENTRIES = [
  ['package/package.json', 'the manifest npm publishes'],
  ['package/lib/index.js', 'the plugin entry point'],
  ['package/lib/diagnose-cli.js', 'the standalone diagnostic command'],
  ['package/lib/client.js', 'the optional browser entry'],
  ['package/lib/graph-renderer.js', 'the cached graph labels and viewport renderer'],
  ['package/lib/graph-palette.js', 'the graph theme color slots'],
  ['package/lib/graph-recall.js', 'the finite graph recall feedback'],
  ['package/lib/graph-data.js', 'the graph-only topology projection'],
  ['package/lib/graph-links.js', 'the graph link parser and resolver'],
  ['package/lib/graph-worker.js', 'the graph force simulator'],
  ['package/lib/graph-worker.LICENSE', 'the bundled D3 license notices'],
  ['package/skills/obsidian-mem/SKILL.md', 'the portable methodology skill'],
  ['package/cordis.patch.yml', 'the bundle patch that mounts the row'],
  ['package/dsh.plugin.json', 'the ecosystem metadata'],
  ['package/README.md', 'the English half of the documentation pair'],
  ['package/README.zh.md', 'the Chinese half of the documentation pair'],
  ['package/README.i18n.yaml', 'the hash record that keeps the pair honest'],
  ['package/CHANGELOG.md', 'the honest-limits record'],
  ['package/LICENSE', 'the declared MIT license'],
]

/**
 * Archive prefixes that must never appear.
 *
 * `test`, `docs`, `research` and `scratch` are development trees; `_meta`,
 * `.obsidian` and `node_modules` are a vault's internals or a dependency tree.
 */
export const FORBIDDEN_PREFIXES = [
  'package/test/',
  'package/client/',
  'package/.github/',
  'package/docs/',
  'package/research/',
  'package/scratch/',
  'package/.codegraph/',
  'package/node_modules/',
  'package/_meta/',
  'package/.obsidian/',
]

/** Path segments that mark runtime state wherever they appear. */
const FORBIDDEN_SEGMENTS = ['pending', 'locks', 'transactions', '.history', '_meta']

/** Basenames that are evidence or local state rather than package content. */
const FORBIDDEN_NAMES = [/^probe/i, /[.]jsonl$/i, /[.](?:db|sqlite|sqlite3|lock|tgz|log)$/i]

/**
 * Compare one real archive's contents against the contract.
 *
 * Pure on purpose: the failure modes are unit-tested with synthetic listings, so a
 * red result here can only mean the archive, never the test.
 *
 * @param {string[]} entries - archive paths from `tar -tf`, as `package/…`.
 * @param {string[]} libFiles - extant JavaScript files under `lib/`, repository-relative.
 * @returns {string[]} one message per problem; empty means the archive is good.
 */
export function verifyTarballEntries(entries, libFiles) {
  const problems = []
  const present = new Set(entries)
  for (const [path, reason] of REQUIRED_ENTRIES) {
    if (!present.has(path)) problems.push(`the archive is missing ${path} (${reason})`)
  }
  for (const path of libFiles) {
    if (!present.has(`package/${path}`)) {
      problems.push(`the archive is missing ${path}, which exists on disk`)
    }
  }
  for (const entry of entries) {
    const forbiddenPrefix = FORBIDDEN_PREFIXES.find((prefix) => entry.startsWith(prefix))
    if (forbiddenPrefix !== undefined) {
      problems.push(`the archive carries ${entry}, which is development or runtime state`)
      continue
    }
    const segments = entry.split('/')
    const segment = segments.find((candidate) => FORBIDDEN_SEGMENTS.includes(candidate))
    if (segment !== undefined) {
      problems.push(
        `the archive carries ${entry}, which reaches vault or data-root state (${segment})`,
      )
      continue
    }
    if (FORBIDDEN_NAMES.some((pattern) => pattern.test(segments[segments.length - 1]))) {
      problems.push(`the archive carries ${entry}, which is evidence rather than package content`)
    }
  }
  return problems
}

/** Every JavaScript file under `lib/` in one checkout, repository-relative and sorted. */
function libFilesOf(root) {
  const found = []
  const walk = (directory, prefix) => {
    const entries = readdirSync(directory, { withFileTypes: true })
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix + entry.name
      if (entry.isDirectory()) walk(join(directory, entry.name), relative + '/')
      else if (relative.endsWith('.js')) found.push(relative)
    }
  }
  walk(join(root, 'lib'), 'lib/')
  return found
}

/** Parse `--root <dir>`, refusing anything else. */
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
      throw new Error(
        'unknown argument ' +
          JSON.stringify(argument) +
          '; usage: verify-tarball.mjs [--root <dir>]',
      )
    }
  }
  return resolve(root)
}

/**
 * The npm CLI to run: `npm-cli.js` through this Node, or `npm` on PATH.
 *
 * Spawning `npm` directly is a POSIX assumption. On Windows the executable is
 * `npm.cmd`, which `spawnSync` refuses without `shell: true` (EINVAL), and a
 * `shell: true` spawn re-parses the arguments — the quoting hazard this project
 * refuses elsewhere. Running npm's own JS entry through the current Node avoids
 * both: it needs no shell, no `.cmd` shim, and the same argv reaches npm.
 *
 * @returns {{command: string, args: string[]}} the command to spawn with.
 */
function npmCommand() {
  const cli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (existsSync(cli)) return { command: process.execPath, args: [cli] }
  return { command: 'npm', args: [] }
}

/**
 * The one archive `npm pack --json` reported, from either envelope npm has used.
 *
 * npm 11 prints a one-element array; npm 12.1.0 — the version the floating
 * `node` CI leg installs — prints one object keyed by package name. Both carry
 * the same record, and `const [packed] = JSON.parse(…)` threw
 * "object is not iterable" on the second envelope, which failed
 * `the archive this checkout really produces satisfies the contract` on that leg
 * (run 41176291759) while every other leg stayed green. The contract here is
 * "exactly one archive": a report with none, or with several, is tooling output
 * this verifier cannot name, so it refuses instead of checking a file npm did
 * not describe. Pure on purpose — both envelopes and the refusals are unit-tested
 * without packing anything.
 *
 * @param {string} stdout - `npm pack --json` standard output.
 * @returns {{filename: string, files?: Array<{path: string}>}} npm's record of the archive.
 */
export function parsePackReport(stdout) {
  const parsed = JSON.parse(stdout)
  const values = Array.isArray(parsed)
    ? parsed
    : parsed !== null && typeof parsed === 'object'
      ? Object.values(parsed)
      : []
  const records = values.filter(
    (value) => value !== null && typeof value === 'object' && typeof value.filename === 'string',
  )
  if (records.length !== 1) {
    throw new Error(
      'npm pack --json reported ' + records.length + ' archive records; expected exactly one',
    )
  }
  return records[0]
}

/** Pack once into `destination` and return npm's own account of the archive. */
function pack(root, destination) {
  const npm = npmCommand()
  const run = spawnSync(
    npm.command,
    [...npm.args, 'pack', '--json', '--ignore-scripts', '--pack-destination', destination],
    {
      cwd: root,
      encoding: 'utf8',
    },
  )
  if (run.status !== 0) {
    const detail = (run.stderr || run.stdout || '').trim() || run.error?.message || 'no output'
    throw new Error('npm pack failed: ' + detail)
  }
  return parsePackReport(run.stdout)
}

/**
 * List one archive's entries, portably, through the `tar` on `PATH`.
 *
 * tar runs from the archive's own directory and is handed its **relative** file
 * name. A Windows absolute path such as `C:\Users\…\x.tgz` is read by GNU tar
 * 1.35 (Git Bash's `/usr/bin/tar`) as a remote `C:` host — `tar: Cannot connect
 * to C: resolve failed`, exit 128 — even though bsdtar accepts it, so the pack
 * gate failed on Windows for a valid archive. The relative form is accepted by
 * both tars, and running from the archive's directory keeps the listing from
 * depending on the caller's cwd.
 *
 * The failure detail is returned rather than thrown so the caller and the tests
 * see one shape: `status` is tar's exit status (`null` when tar could not be
 * spawned at all), `entries` is empty on failure, and `error` is the most
 * specific reason available — stderr, then the spawn error, then a last-resort
 * message — so a silent failure never renders as `tar -tf failed: undefined`.
 *
 * @param {string} archive - absolute (or cwd-relative) path to the archive to list.
 * @returns {{status: number|null, entries: string[], error: string|null}} the listing.
 */
export function listArchive(archive) {
  const listing = spawnSync('tar', ['-tf', basename(archive)], {
    cwd: dirname(archive),
    encoding: 'utf8',
  })
  if (listing.status === 0) {
    const entries = listing.stdout
      .split('\n')
      .map((line) => line.replace(/\r$/u, ''))
      .filter(Boolean)
    return { status: 0, entries, error: null }
  }
  const error =
    (listing.stderr || '').trim() ||
    listing.error?.message ||
    'tar exited without reporting a reason'
  return { status: listing.status, entries: [], error }
}

/**
 * Pack this checkout and check the archive it produces.
 *
 * @param {string[]} [argv] - command-line arguments after the script name.
 * @returns {number} 0 when the archive matches the contract, 1 when it does not, 2 on a usage or tooling failure.
 */
export function main(argv = process.argv.slice(2)) {
  const root = parseArgs(argv)
  const libFiles = libFilesOf(root)
  if (libFiles.length === 0) {
    process.stdout.write('verify-tarball: no lib JavaScript found to check\n')
    return 1
  }
  const destination = mkdtempSync(join(tmpdir(), 'obsidian-mem-pack-'))
  try {
    const packed = pack(root, destination)
    const archive = join(destination, packed.filename)
    if (!existsSync(archive))
      throw new Error('npm pack reported ' + packed.filename + ', which is not on disk')
    const listing = listArchive(archive)
    if (listing.status !== 0) throw new Error('tar -tf failed: ' + listing.error)
    const entries = listing.entries
    const problems = verifyTarballEntries(entries, libFiles)
    // npm's own file list has to describe the same archive; a disagreement means
    // the tar listing and the manifest came from different builds.
    const declared = new Set((packed.files ?? []).map((file) => 'package/' + file.path))
    if (declared.size > 0) {
      for (const entry of entries) {
        if (!declared.has(entry))
          problems.push(entry + " is in the archive but not in npm's own file list")
      }
    }
    if (problems.length > 0) {
      process.stdout.write('verify-tarball: FAIL ' + root + '\n')
      for (const problem of problems) process.stdout.write('  - ' + problem + '\n')
      return 1
    }
    process.stdout.write(
      'verify-tarball: OK ' +
        root +
        '\n  ' +
        entries.length +
        ' entries, ' +
        libFiles.length +
        ' lib modules, every required asset present\n',
    )
    return 0
  } finally {
    rmSync(destination, { recursive: true, force: true })
  }
}

const isEntry =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isEntry) {
  try {
    process.exitCode = main()
  } catch (error) {
    process.stderr.write('verify-tarball: ' + error.message + '\n')
    process.exitCode = 2
  }
}
