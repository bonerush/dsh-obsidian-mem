#!/usr/bin/env node
// Choose the commit CI compares against (Task 8).
//
// The Unreleased gate needs a base, and picking one inside the workflow YAML
// would make the only interesting logic in this repository the only logic nothing
// tests. So it lives here, takes its inputs from the environment, and prints the
// SHA on stdout.
//
// The three cases are the three shapes a GitHub event can have:
//
//   * a pull request names its base commit outright;
//   * a push names the previous head in `before`, except on the first push of a
//     branch, where it is all zeros;
//   * anything else falls back to the merge base with the default branch.
//
// Every path validates before it answers. A base that is not a commit, or that is
// not an ancestor of `HEAD`, is an error rather than an empty diff: the point of
// the gate is to look at what changed, and "I could not tell" must not read as
// "nothing changed".
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

/** The all-zero SHA GitHub sends for a ref that did not exist before. */
const ZERO = /^0+$/

/** Run git and return stdout, or null when the command fails. */
function git(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

/**
 * Resolve the comparison base.
 *
 * @param {Record<string, string|undefined>} env - the event environment.
 * @returns {{sha: string|null, reason: string}} the base, or why there is none.
 */
export function resolveBase(env, cwd = process.cwd()) {
  const candidates = []
  if (env.PR_BASE) candidates.push(['the pull request base', env.PR_BASE])
  if (env.BEFORE && !ZERO.test(env.BEFORE)) candidates.push(['the previous head', env.BEFORE])
  for (const [label, sha] of candidates) {
    if (git(['rev-parse', '--verify', sha + '^{commit}'], cwd) === null) {
      return { sha: null, reason: label + ' ' + sha + ' is not a commit in this checkout' }
    }
    return { sha, reason: label + ' from the event' }
  }
  const branch = env.DEFAULT_BRANCH || 'main'
  const mergeBase =
    git(['merge-base', 'HEAD', 'origin/' + branch], cwd) ?? git(['merge-base', 'HEAD', branch], cwd)
  if (mergeBase === null) {
    return { sha: null, reason: 'no event base and no merge base against ' + branch }
  }
  if (mergeBase === git(['rev-parse', 'HEAD'], cwd)) {
    return {
      sha: null,
      reason: 'the merge base against ' + branch + ' is HEAD, so there is nothing to compare',
    }
  }
  return { sha: mergeBase, reason: 'the merge base against ' + branch }
}

/**
 * Print the base SHA.
 *
 * @param {Record<string, string|undefined>} [env] - the environment.
 * @returns {number} 0 with a SHA on stdout, or 1 with a reason on stderr.
 */
export function main(env = process.env) {
  const { sha, reason } = resolveBase(env)
  if (sha === null) {
    process.stderr.write('ci-base: ' + reason + '\n')
    return 1
  }
  process.stdout.write(sha + '\n')
  process.stderr.write('ci-base: using ' + reason + ' (' + sha.slice(0, 12) + ')\n')
  return 0
}

const isEntry =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isEntry) process.exitCode = main()
