#!/usr/bin/env node
// Fast, staged-only pre-commit check (Task 7).
//
// The repository's rules are enforced against the *index*, not the working tree.
// That distinction is the whole point of this file: with a plain worktree check,
// `git add -p` lets a commit contain a file whose working-tree copy passes while
// the staged copy does not, and the check reports a green that describes code
// nobody is committing. So the sources come from `git show :<path>` and go into
// eslint and prettier over stdin.
//
// Two honest limits, both stated rather than hidden:
//
//   * The two fitness tests read the worktree. If any file they read has both a
//     staged and an unstaged edit, the index and the worktree disagree and this
//     script refuses instead of reporting one as the other. Finish staging, or run
//     `npm run check` on a clean tree.
//   * Deleted files are skipped: there is no staged blob to lint.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
/** The checkout this script lives in, which is where the tools are installed. */
const SELF_ROOT = resolve(HERE, '..')
/** This repository's lint and format configuration, named so a fixture checkout is judged identically. */
const ESLINT_CONFIG = join(SELF_ROOT, 'eslint.config.mjs')
const PRETTIER_CONFIG = join(SELF_ROOT, '.prettierrc.json')

/**
 * Paths the fitness tests read. A staged *and* unstaged change to any of these
 * makes their verdict ambiguous, so the run refuses rather than guess.
 */
export const FITNESS_INPUTS = [
  'lib/',
  'scripts/',
  'codex/',
  'tsconfig.json',
  'package.json',
  'AGENTS.md',
  'README.md',
  'README.zh.md',
  'README.i18n.yaml',
]

/** Run git and return stdout, naming the failure when it fails. */
function git(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  } catch (error) {
    throw new Error(
      'git ' + args.join(' ') + ' failed: ' + ((error.stderr ?? '').trim() || error.message),
      {
        cause: error,
      },
    )
  }
}

/** NUL-separated path lists, filtered to the extensions this repository lints. */
function paths(cwd, args) {
  return git(args, cwd)
    .split('\0')
    .filter((path) => path.endsWith('.js') || path.endsWith('.mjs'))
}

/**
 * Lint and format-check the staged blob of every staged source file.
 *
 * @param {string} root - repository root to read the index of.
 * @param {{eslintBin: string, prettierBin: string}} binaries - absolute tool paths.
 * @returns {{problems: string[], checked: number}} findings and how many files were read.
 */
export function checkStagedSources(root, { eslintBin, prettierBin }) {
  const problems = []
  const staged = paths(root, ['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR'])
  for (const path of staged) {
    const source = git(['show', ':' + path], root)
    // Both configs are named explicitly rather than discovered from `root`: this
    // script's job is to apply *this repository's* rules, and a fixture checkout
    // with no config of its own has to be checked the same way the real one is.
    const lint = spawnSync(
      eslintBin,
      ['--config', ESLINT_CONFIG, '--stdin', '--stdin-filename', path],
      {
        cwd: root,
        input: source,
        encoding: 'utf8',
      },
    )
    if (lint.status !== 0)
      problems.push('eslint (staged ' + path + '):\n' + (lint.stdout || lint.stderr).trim())
    const format = spawnSync(
      prettierBin,
      ['--config', PRETTIER_CONFIG, '--check', '--stdin-filepath', path],
      {
        cwd: root,
        input: source,
        encoding: 'utf8',
      },
    )
    if (format.status !== 0)
      problems.push('prettier (staged ' + path + '): ' + (format.stdout || format.stderr).trim())
  }
  return { problems, checked: staged.length }
}

/**
 * Fitness inputs that differ between the index and the worktree.
 *
 * @param {string} root - repository root.
 * @returns {string[]} the ambiguous paths.
 */
export function ambiguousFitnessInputs(root) {
  const staged = new Set(
    git(['diff', '--cached', '--name-only', '-z'], root).split('\0').filter(Boolean),
  )
  const unstaged = git(['diff', '--name-only', '-z'], root).split('\0').filter(Boolean)
  const relevant = (path) =>
    FITNESS_INPUTS.some((prefix) => path === prefix || path.startsWith(prefix))
  return unstaged.filter((path) => relevant(path) && staged.has(path))
}

/**
 * Run the fast gate.
 *
 * @param {string[]} [argv] - arguments after the script name; none are accepted.
 * @param {string} [root] - repository root.
 * @returns {number} 0 when the index is clean, 1 when it is not, 2 on a tooling failure.
 */
export function main(argv = process.argv.slice(2), root = SELF_ROOT) {
  if (argv.length > 0) {
    process.stderr.write('check-staged: takes no arguments, got ' + JSON.stringify(argv) + '\n')
    return 2
  }
  const eslintBin = join(SELF_ROOT, 'node_modules', '.bin', 'eslint')
  const prettierBin = join(SELF_ROOT, 'node_modules', '.bin', 'prettier')
  for (const binary of [eslintBin, prettierBin]) {
    if (!existsSync(binary)) {
      process.stderr.write('check-staged: ' + binary + ' is missing; run npm ci\n')
      return 2
    }
  }
  const ambiguous = ambiguousFitnessInputs(root)
  if (ambiguous.length > 0) {
    process.stderr.write(
      'check-staged: ' +
        ambiguous.join(', ') +
        ' changed in both the index and the worktree, so the fitness tests would describe neither. Stage the rest or run npm run check.\n',
    )
    return 1
  }
  const { problems, checked } = checkStagedSources(root, { eslintBin, prettierBin })
  for (const problem of problems) process.stderr.write(problem + '\n')
  if (problems.length > 0) return 1
  const tests = spawnSync(
    process.execPath,
    ['--test', 'test/architecture.test.js', 'test/repo-hygiene.test.js'],
    {
      cwd: root,
      encoding: 'utf8',
    },
  )
  if (tests.status !== 0) {
    process.stderr.write((tests.stdout || '') + (tests.stderr || ''))
    return 1
  }
  const changelog = spawnSync(
    process.execPath,
    [join(SELF_ROOT, 'scripts', 'verify-changelog.mjs'), '--staged'],
    {
      cwd: root,
      encoding: 'utf8',
    },
  )
  process.stderr.write(changelog.stdout ?? '')
  if (changelog.status !== 0) {
    process.stderr.write(changelog.stderr ?? '')
    return 1
  }
  process.stdout.write('check:fast: OK (' + checked + ' staged source file(s))\n')
  return 0
}

const isEntry =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isEntry) process.exitCode = main()
