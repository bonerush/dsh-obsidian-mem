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
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
/** The checkout this script lives in. */
const DEFAULT_ROOT = resolve(HERE, '..')

/** Archive paths the package must carry, each with the reason it is mandatory. */
export const REQUIRED_ENTRIES = [
  ['package/package.json', 'the manifest npm publishes'],
  ['package/lib/index.js', 'the plugin entry point'],
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

/** Pack once into `destination` and return npm's own account of the archive. */
function pack(root, destination) {
  const run = spawnSync(
    'npm',
    ['pack', '--json', '--ignore-scripts', '--pack-destination', destination],
    {
      cwd: root,
      encoding: 'utf8',
    },
  )
  if (run.status !== 0) throw new Error('npm pack failed: ' + (run.stderr || run.stdout))
  const [packed] = JSON.parse(run.stdout)
  if (packed === undefined) throw new Error('npm pack reported no archive')
  return packed
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
    const listing = spawnSync('tar', ['-tf', archive], { encoding: 'utf8' })
    if (listing.status !== 0) throw new Error('tar -tf failed: ' + listing.stderr)
    const entries = listing.stdout.split('\n').filter(Boolean)
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
