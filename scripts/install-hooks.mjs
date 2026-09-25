#!/usr/bin/env node
// Explicit hook installation (Task 7).
//
// AGENTS.md rule 1 is that no script here may rewrite a user's configuration
// without being asked. A pre-commit hook is configuration, so this is the one
// command that changes it and nothing else does: `npm run check` never touches
// git config, and this script prints the setting before and after so the change is
// visible rather than implied. It has to be run by hand.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SELF_ROOT = resolve(HERE, '..')
/** The value this repository wants, relative to the repository root. */
export const HOOKS_PATH = '.githooks'

/** Run git and return stdout, naming the failure when it fails. */
function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

/**
 * Read the current `core.hooksPath` for one checkout.
 *
 * @param {string} root - repository root.
 * @returns {string} the configured value, or an empty string when unset.
 */
export function currentHooksPath(root) {
  try {
    return git(['config', '--local', '--get', 'core.hooksPath'], root).trim()
  } catch {
    return ''
  }
}

/**
 * Point `core.hooksPath` at `.githooks` for one checkout.
 *
 * @param {string} [root] - repository root.
 * @returns {number} 0 on success, 2 when the checkout cannot host hooks.
 */
export function main(root = SELF_ROOT) {
  const hooks = join(root, HOOKS_PATH)
  try {
    git(['rev-parse', '--git-dir'], root)
  } catch {
    process.stderr.write('install-hooks: ' + root + ' is not a git checkout\n')
    return 2
  }
  if (!existsSync(join(hooks, 'pre-commit'))) {
    process.stderr.write('install-hooks: ' + join(HOOKS_PATH, 'pre-commit') + ' is missing\n')
    return 2
  }
  const before = currentHooksPath(root)
  process.stdout.write(
    'install-hooks: core.hooksPath was ' + (before === '' ? '(unset)' : before) + '\n',
  )
  git(['config', '--local', 'core.hooksPath', HOOKS_PATH], root)
  const after = currentHooksPath(root)
  process.stdout.write('install-hooks: core.hooksPath is now ' + after + '\n')
  if (after !== HOOKS_PATH) {
    process.stderr.write('install-hooks: the setting did not take\n')
    return 2
  }
  return 0
}

const isEntry =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isEntry) process.exitCode = main()
