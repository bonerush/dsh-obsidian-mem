#!/usr/bin/env node
// Branch-model enforcement for this repository.
//
// The model: main is release history and only ever moves through a --no-ff
// merge from a version branch (V<number>); a version branch is a version
// sub-main that only moves through --no-ff merges from typed small branches
// (<type>/<slug>), or through a --no-ff sync merge from main; small branches are
// personal and may be force-pushed.
//
// The decision helpers take pre-gathered git facts as plain arguments so the
// test suite can exercise every rule without a repository; the CLI is the only
// part that runs git. The hooks are accident prevention, not a security
// boundary: `git merge --no-verify` skips the merge guard, which is why
// pre-push and the CI PR-topology check are the durable gates.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Release history: only --no-ff merges from a version branch land here. */
export const MAIN_BRANCH = 'main'

/** Version sub-main names, e.g. V2, V10. V0 and V01 are not version branches. */
export const VERSION_BRANCH_PATTERN = /^V[1-9]\d*$/u

/** The prefixes a small branch may use. */
const SMALL_BRANCH_TYPES = ['feat', 'bug', 'doc', 'chore', 'refactor', 'test', 'perf']

/** Typed small branches: <type>/<lowercase-kebab-slug>. */
export const SMALL_BRANCH_PATTERN = new RegExp(
  `^(?:${SMALL_BRANCH_TYPES.join('|')})/[a-z0-9]+(?:-[a-z0-9]+)*$`,
  'u',
)

/** A git object id, sha1 or sha256. */
const OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu

const USAGE = `branch-policy: enforce the branch model of this repository.

The model: main is release history and takes --no-ff merges from a version
branch (V<number>) only; a version branch takes --no-ff merges from typed small
branches (<type>/<slug>: ${SMALL_BRANCH_TYPES.join(', ')}) after the user confirms, or a
--no-ff sync merge from main; small branches are personal and may be force-pushed.

Usage:
  node scripts/branch-policy.mjs guard-commit
      pre-commit guard: no direct commits on main or a version branch; a commit
      that resolves a conflicted merge is checked as that merge.
  node scripts/branch-policy.mjs guard-merge
      pre-merge-commit guard: only the allowed merge directions, and a merge of
      a typed branch into a version branch needs DSH_MERGE_APPROVED=1.
  node scripts/branch-policy.mjs guard-push
      pre-push guard; reads the ref lines git writes to stdin.
  node scripts/branch-policy.mjs check-pr --base <ref> --head <ref> [--current-version <Vn>]
      pull-request topology check for the CI workflow; --current-version lets a
      CI run refuse a pull request into a superseded (frozen) version branch.
  node scripts/branch-policy.mjs --help

Exit 0 allows the operation, 1 refuses it with a message on stderr, 2 is a
usage or internal error. The hooks are accident prevention: git merge
--no-verify skips the merge guard, so the pre-push hook and the CI check are
the gates that cannot be skipped locally.
`

/**
 * Allow the operation.
 * @param {string} reason why it is allowed, for verbose callers and tests.
 * @returns {{ok: true, reason: string}}
 */
function allow(reason) {
  return { ok: true, reason }
}

/**
 * Refuse the operation.
 * @param {string} reason an actionable refusal for the user.
 * @returns {{ok: false, reason: string}}
 */
function refuse(reason) {
  return { ok: false, reason }
}

/**
 * Is this the release branch.
 * @param {string} name branch name without the refs/heads/ prefix.
 * @returns {boolean}
 */
export function isMainBranch(name) {
  return name === MAIN_BRANCH
}

/**
 * Is this a version branch (the version sub-main, e.g. V2).
 * @param {string} name branch name without the refs/heads/ prefix.
 * @returns {boolean}
 */
export function isVersionBranch(name) {
  return typeof name === 'string' && VERSION_BRANCH_PATTERN.test(name)
}

/**
 * Is this a typed small branch (e.g. feat/branch-model).
 * @param {string} name branch name without the refs/heads/ prefix.
 * @returns {boolean}
 */
export function isSmallBranch(name) {
  return typeof name === 'string' && SMALL_BRANCH_PATTERN.test(name)
}

/**
 * Classify a branch name by its role in the model.
 * @param {string} name branch name without the refs/heads/ prefix.
 * @returns {'main' | 'version' | 'small' | 'other'}
 */
export function classifyBranch(name) {
  if (isMainBranch(name)) return 'main'
  if (isVersionBranch(name)) return 'version'
  if (isSmallBranch(name)) return 'small'
  return 'other'
}

/**
 * The version number encoded in a version branch name, or null.
 * @param {string} name branch name without the refs/heads/ prefix.
 * @returns {number | null}
 */
export function versionNumber(name) {
  return isVersionBranch(name) ? Number(name.slice(1)) : null
}

/**
 * Whether a version branch has been superseded by a higher-numbered one.
 * Older Vx branches are frozen read-only history; the next one is cut from
 * main when the user announces a new major version.
 * @param {string} name the branch being written to.
 * @param {string | null | undefined} currentVersion the highest version branch visible here.
 * @returns {boolean}
 */
function isSupersededVersion(name, currentVersion) {
  const number = versionNumber(name)
  const current = typeof currentVersion === 'string' ? versionNumber(currentVersion) : null
  return number !== null && current !== null && number < current
}

/**
 * Is this name a branch the model protects against direct pushes.
 * @param {string} name branch name without the refs/heads/ prefix.
 * @returns {boolean}
 */
function isProtectedBranch(name) {
  return isMainBranch(name) || isVersionBranch(name)
}

/**
 * Is this the all-zero object id git uses for a creation or deletion.
 * @param {string} sha an object id from a pre-push ref line.
 * @returns {boolean}
 */
export function isZeroSha(sha) {
  return typeof sha === 'string' && /^0+$/u.test(sha)
}

/**
 * Decide whether a pull request's base/head pair matches the model.
 * @param {{base: string, head: string, currentVersion?: string | null}} pair the pull request's ref names, plus the highest version branch CI can see.
 * @returns {{ok: boolean, reason: string}}
 */
export function checkPullRequest({ base, head, currentVersion }) {
  if (typeof base !== 'string' || base === '' || typeof head !== 'string' || head === '') {
    return refuse('both a base and a head branch are required')
  }
  if (isMainBranch(base)) {
    if (isVersionBranch(head)) {
      return allow(`main accepts release merges from version branches (${head})`)
    }
    return refuse(
      `a pull request into main must come from a version branch (V<number>, e.g. V2), not from ${head}; retarget it at the current Vx branch — main only receives --no-ff merges of a version branch.`,
    )
  }
  if (isVersionBranch(base)) {
    if (
      typeof currentVersion === 'string' &&
      currentVersion !== '' &&
      isVersionBranch(currentVersion) &&
      isSupersededVersion(base, currentVersion)
    ) {
      return refuse(
        `a pull request into ${base} is refused: ${base} is frozen read-only history because ${currentVersion} is the current version branch; open the pull request against ${currentVersion} instead.`,
      )
    }
    if (isSmallBranch(head)) {
      return allow(`${base} accepts merges from typed small branches (${head})`)
    }
    return refuse(
      `a pull request into ${base} must come from a typed small branch (<type>/<slug>: ${SMALL_BRANCH_TYPES.join(', ')}), not from ${head}; create the branch from ${base}, merge it back with --no-ff after the user confirms it, and open the pull request against ${base}.`,
    )
  }
  return allow(`${base} is not a protected branch`)
}

/**
 * Branch names named after "merge " in GIT_REFLOG_ACTION, e.g. "merge V2".
 * Git exports the reflog action to hooks; the merge target's HEAD is still the
 * pre-merge commit inside pre-merge-commit, so this is how the source is seen.
 * @param {string | undefined} action the GIT_REFLOG_ACTION value.
 * @returns {string[]}
 */
export function mergeSourcesFromReflog(action) {
  if (typeof action !== 'string' || !action.startsWith('merge ')) return []
  return action
    .slice('merge '.length)
    .trim()
    .split(/\s+/u)
    .filter((token) => token !== '' && !token.startsWith('-'))
}

/**
 * Parse the ref lines git writes to a pre-push hook's stdin.
 * @param {string} text the hook's stdin.
 * @returns {Array<{localRef: string, localSha: string, remoteRef: string, remoteSha: string}>}
 */
export function parsePushLines(text) {
  const updates = []
  for (const line of String(text).split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const fields = trimmed.split(/\s+/u)
    if (fields.length !== 4) {
      throw new Error(`cannot parse the pre-push ref line: ${trimmed}`)
    }
    const [localRef, localSha, remoteRef, remoteSha] = fields
    updates.push({ localRef, localSha, remoteRef, remoteSha })
  }
  return updates
}

/**
 * Decide whether the merge that is about to be committed is allowed.
 * The CLI gathers the facts; a plain object makes every rule table-testable.
 * @param {object} facts pre-gathered merge facts.
 * @param {string} facts.target the branch receiving the merge (current branch).
 * @param {string[]} [facts.sourceNames] refs named after "merge " in the reflog action.
 * @param {string[]} [facts.sourceShas] commits the merge brings in (MERGE_HEAD and resolved names).
 * @param {Record<string, string[] | null>} [facts.containingBranches] per source commit, the local branches whose tip contains it (null when git could not answer).
 * @param {boolean} [facts.mainResolved] whether a local main branch exists.
 * @param {boolean} [facts.allSourcesInMain] whether every source commit is an ancestor of local main.
 * @param {boolean} [facts.approved] whether DSH_MERGE_APPROVED is 1.
 * @param {string | null} [facts.currentVersion] the highest version branch visible in this checkout.
 * @returns {{ok: boolean, reason: string}}
 */
export function evaluateMerge(facts) {
  const target = facts.target
  const sourceNames = facts.sourceNames ?? []
  const sourceShas = facts.sourceShas ?? []
  const containingBranches = facts.containingBranches ?? {}
  const kind = classifyBranch(target)
  if (kind !== 'main' && kind !== 'version') {
    return allow(`${target || 'the current branch'} is not a protected branch`)
  }
  if (kind === 'version' && isSupersededVersion(target, facts.currentVersion)) {
    return refuse(
      `${target} is frozen read-only history: ${facts.currentVersion} is the current version branch. Version branches are cut from main when the user announces a new major version, a superseded one is read-only history; merge this work into ${facts.currentVersion} instead.`,
    )
  }
  if (sourceNames.length === 0 && sourceShas.length === 0) {
    return refuse(
      `cannot identify the branch being merged into ${target}; refusing rather than guessing. Re-run the merge naming the source branch, e.g. git merge --no-ff <branch>.`,
    )
  }
  const known = [...sourceNames]
  for (const sha of sourceShas) {
    const branches = containingBranches[sha]
    if (Array.isArray(branches)) known.push(...branches)
  }
  const versionSources = unique(known.filter(isVersionBranch))
  const smallSources = unique(known.filter(isSmallBranch))
  if (kind === 'main') {
    if (versionSources.length === 0) {
      return refuse(
        `${describeSources(sourceNames, sourceShas)} main only receives --no-ff merges of a version branch (${VERSION_BRANCH_PATTERN.source}, e.g. V2) — put the work on a typed small branch, merge it into the version branch, and merge that with --no-ff.`,
      )
    }
    if (versionSources.length > 1 || smallSources.length > 0) {
      return refuse(
        `a release merge into main must bring exactly one version branch (${VERSION_BRANCH_PATTERN.source}); this merge names ${[...versionSources, ...smallSources].join(', ')}. Merge the work into one version branch and release that.`,
      )
    }
    return allow(`main <- ${versionSources.join(', ')} (version-branch merge)`)
  }
  if (facts.allSourcesInMain === true && sourceShas.length > 0) {
    return allow(`${target} <- sources already in main (sync merge; no confirmation needed)`)
  }
  const branchLabel = smallSources[0] ?? sourceNames[0] ?? '<branch>'
  if (facts.approved !== true) {
    return refuse(
      `merging into ${target} needs the user's explicit confirmation; abort this merge with git merge --abort and re-run: DSH_MERGE_APPROVED=1 git merge --no-ff ${branchLabel} (if the merge already conflicted, finish it in place with: DSH_MERGE_APPROVED=1 git commit). A version branch only receives --no-ff merges of typed small branches that the user has confirmed; a main -> ${target} sync merge is the only exemption.`,
    )
  }
  if (smallSources.length !== 1) {
    return refuse(
      `the merge into ${target} must come from exactly one typed small branch (<type>/<slug>: ${SMALL_BRANCH_TYPES.join(', ')}); a version branch only receives typed-branch merges or a sync merge from main.`,
    )
  }
  const mixed = sourceNames.filter((source) => !isSmallBranch(source))
  if (mixed.length > 0) {
    return refuse(
      `the merge into ${target} mixes the typed branch ${smallSources[0]} with ${mixed.join(', ')}; merge one typed branch at a time.`,
    )
  }
  return allow(`${target} <- ${smallSources.join(', ')} (user-approved typed-branch merge)`)
}

/**
 * Decide whether a commit that is about to be created is allowed.
 * @param {object} facts pre-gathered commit facts.
 * @param {string | null} facts.branch the current branch, or null when detached.
 * @param {boolean} facts.detached whether HEAD is detached.
 * @param {boolean} facts.merging whether a merge is in progress (MERGE_HEAD exists).
 * @param {object | null} [facts.merge] merge facts for a conflict-resolution commit.
 * @param {string | null} [facts.currentVersion] the highest version branch visible in this checkout.
 * @returns {{ok: boolean, reason: string}}
 */
export function evaluateCommit(facts) {
  if (facts.detached === true) {
    return allow('HEAD is detached; the commit is not on a protected branch')
  }
  if (typeof facts.branch !== 'string' || facts.branch === '') {
    return refuse('cannot determine the current branch; refusing rather than guessing')
  }
  const kind = classifyBranch(facts.branch)
  if (kind !== 'main' && kind !== 'version') {
    return allow(`${facts.branch} is not a protected branch`)
  }
  if (kind === 'version' && isSupersededVersion(facts.branch, facts.currentVersion)) {
    return refuse(
      `${facts.branch} is frozen read-only history: ${facts.currentVersion} is the current version branch. Version branches are cut from main when the user announces a new major version; a superseded one is read-only history, so work on a typed branch cut from ${facts.currentVersion} instead.`,
    )
  }
  if (facts.merging !== true) {
    return refuse(
      `direct commits are not allowed on ${facts.branch}; work on a <type>/<slug> branch and merge --no-ff after user confirmation.`,
    )
  }
  if (facts.merge == null) {
    return refuse(
      `cannot identify the merge being committed on ${facts.branch}; refusing rather than guessing.`,
    )
  }
  return evaluateMerge({ ...facts.merge, target: facts.branch })
}

/**
 * Decide whether one pre-push ref update is allowed.
 * @param {{localRef: string, localSha: string, remoteRef: string, remoteSha: string}} update one ref line from the pre-push hook.
 * @param {object} [facts] pre-gathered push facts for a main/version update.
 * @param {boolean | null} [facts.localKnown] whether the local sha is a commit here.
 * @param {boolean | null} [facts.remoteKnown] whether the remote sha is a commit here.
 * @param {boolean | null} [facts.fastForward] whether the remote sha is an ancestor of the local sha.
 * @param {number | null} [facts.tipParentCount] parent count of the new tip (used to bootstrap a new remote main).
 * @param {string[] | null} [facts.secondParentBranches] local branches containing the tip's second parent.
 * @param {Array<{sha: string, parentCount: number, secondParentBranches: string[] | null, subject: string}> | null} [facts.addedOnFirstParent] commits added to the first-parent line, with the merge provenance each one needs.
 * @param {boolean | null} [facts.frozen] whether the version branch has been superseded.
 * @returns {{ok: boolean, reason: string}}
 */
export function evaluatePush(update, facts = {}) {
  const { localRef, localSha, remoteRef, remoteSha } = update
  if (remoteRef.startsWith('refs/tags/')) {
    return allow('tags are not branch history')
  }
  const name = branchRefName(remoteRef)
  if (name === null) {
    return allow(`${remoteRef} is not under refs/heads/`)
  }
  if (localRef === '(delete)' || isZeroSha(localSha)) {
    if (isProtectedBranch(name)) {
      return refuse(
        `${name} cannot be deleted from the remote: main and version branches are permanent history.`,
      )
    }
    return allow(`deleting ${name} is allowed; only main and version branches are permanent`)
  }
  if (isZeroSha(remoteSha)) {
    if (isVersionBranch(name)) {
      if (facts.frozen === true) {
        return refuse(
          `cannot create ${name}: a higher-numbered version branch is already current, and version branches are cut from main when the user announces a new major version. A superseded version branch is frozen read-only history.`,
        )
      }
      return allow(`creating remote ${name} is allowed`)
    }
    if (isSmallBranch(name)) {
      return allow(`creating remote ${name} is allowed`)
    }
    if (isMainBranch(name)) return evaluateMainCreation(facts)
    return refuse(
      `the branch name "${name}" does not match the policy; push main, a version branch (V<number>) or a typed small branch (<type>/<slug>: ${SMALL_BRANCH_TYPES.join(', ')}).`,
    )
  }
  if (isMainBranch(name)) return evaluateMainUpdate(facts)
  if (isVersionBranch(name)) return evaluateVersionUpdate(name, facts)
  if (isSmallBranch(name)) {
    return allow(`${name} is a typed small branch; force-push is allowed`)
  }
  return refuse(
    `the branch name "${name}" does not match the policy; push main, a version branch (V<number>) or a typed small branch (<type>/<slug>: ${SMALL_BRANCH_TYPES.join(', ')}).`,
  )
}

/**
 * Ref describe helper for the merge refusal that names no usable source.
 * @param {string[]} names the refs named in the reflog action.
 * @param {string[]} shas the source commits that were identified.
 * @returns {string}
 */
function describeSources(names, shas) {
  if (names.length > 0) return `the merge source (${names.join(', ')}) is not a version branch;`
  if (shas.length > 0) {
    return 'the merge source commits are not contained in a local version branch;'
  }
  return 'no merge source could be identified;'
}

/**
 * Strip the refs/heads/ prefix when the ref is a branch.
 * @param {string} ref a full ref name from a pre-push ref line.
 * @returns {string | null}
 */
function branchRefName(ref) {
  const prefix = 'refs/heads/'
  return ref.startsWith(prefix) ? ref.slice(prefix.length) : null
}

/**
 * Deduplicate values while keeping their first appearance.
 * @param {string[]} values
 * @returns {string[]}
 */
function unique(values) {
  return [...new Set(values)]
}

/**
 * Evaluate an update of remote main.
 * @param {object} facts pre-gathered push facts.
 * @returns {{ok: boolean, reason: string}}
 */
function evaluateMainCreation(facts) {
  if (facts.localKnown !== true) {
    return refuse(
      'cannot verify the initial main against the local repository; refusing (fail closed).',
    )
  }
  if (
    facts.tipParentCount === 2 &&
    Array.isArray(facts.secondParentBranches) &&
    facts.secondParentBranches.some(isVersionBranch)
  ) {
    return allow('creating remote main is allowed for a new remote (a --no-ff release merge)')
  }
  return refuse(
    'creating remote main is allowed only for the first push to a new remote, and only when its tip is a --no-ff merge of a version branch (V<number>); merge the version branch into main with --no-ff first, or ask the user.',
  )
}

/**
 * Evaluate an update of remote main.
 *
 * Checking only the new tip is not enough: a direct commit can ride behind an
 * otherwise valid release merge. Every commit the push adds to the first-parent
 * line must itself be a two-parent merge whose second parent is in a version
 * branch, so the range is what makes the gate durable.
 * @param {object} facts pre-gathered push facts.
 * @returns {{ok: boolean, reason: string}}
 */
function evaluateMainUpdate(facts) {
  if (facts.localKnown !== true || facts.remoteKnown !== true) {
    return refuse(
      'cannot verify the update of main against the local repository; fetch the remote and retry (fail closed).',
    )
  }
  if (facts.fastForward !== true) {
    return refuse(
      'refusing a non-fast-forward update of main: main only moves forward through a --no-ff merge from a version branch; fetch the remote first, and never force-push or rewind main.',
    )
  }
  if (!Array.isArray(facts.addedOnFirstParent)) {
    return refuse('cannot determine which commits the push adds to main; refusing (fail closed).')
  }
  for (const commit of facts.addedOnFirstParent) {
    if (commit.parentCount !== 2) {
      return refuse(
        `the push adds ${commit.sha} to main and it is not a merge commit with exactly two parents; main only ever receives --no-ff merges from a version branch.`,
      )
    }
    if (!Array.isArray(commit.secondParentBranches)) {
      return refuse(
        `cannot determine which local branch ${commit.sha} merges into main; refusing (fail closed).`,
      )
    }
    if (!commit.secondParentBranches.some(isVersionBranch)) {
      return refuse(
        `the push adds ${commit.sha} to main as a merge, but its second parent is not contained in a local version branch (V<number>); main must be a --no-ff merge of a version branch.`,
      )
    }
  }
  return allow('main advances through --no-ff merges of a version branch only')
}

/**
 * Evaluate an update of a version branch.
 * @param {string} name the version branch name.
 * @param {object} facts pre-gathered push facts.
 * @returns {{ok: boolean, reason: string}}
 */
function evaluateVersionUpdate(name, facts) {
  if (facts.frozen === true) {
    return refuse(
      `${name} is frozen read-only history: a higher-numbered version branch is current. Push this work to the current version branch instead.`,
    )
  }
  if (facts.localKnown !== true || facts.remoteKnown !== true) {
    return refuse(
      `cannot verify the update of ${name} against the local repository; fetch the remote and retry (fail closed).`,
    )
  }
  if (facts.fastForward !== true) {
    return refuse(
      `refusing a non-fast-forward update of ${name}: a version branch only moves forward through --no-ff merges of typed small branches; fetch the remote first, and never force-push or rewind it.`,
    )
  }
  if (!Array.isArray(facts.addedOnFirstParent)) {
    return refuse(
      `cannot determine which commits the push adds to ${name}; refusing (fail closed).`,
    )
  }
  for (const commit of facts.addedOnFirstParent) {
    if (commit.parentCount !== 2) {
      return refuse(
        `the push adds ${commit.sha} to the first-parent line of ${name}, and it is not a merge commit with exactly two parents; a version branch only receives --no-ff merges of typed small branches or a sync merge from main.`,
      )
    }
    if (!Array.isArray(commit.secondParentBranches)) {
      return refuse(
        `cannot determine which branch ${commit.sha} merged into ${name}; refusing (fail closed).`,
      )
    }
    if (commit.secondParentBranches.some(isMainBranch)) continue
    if (commit.secondParentBranches.some(isSmallBranch)) continue
    const subject = typeof commit.subject === 'string' ? commit.subject : ''
    const merged = /^Merge branch '([^']+)'/u.exec(subject)
    if (merged !== null && isSmallBranch(merged[1])) continue
    return refuse(
      `the push adds ${commit.sha} to ${name}, but its second parent is contained in neither main nor a typed small branch; ${name} only receives --no-ff merges of typed small branches or a sync merge from main.`,
    )
  }
  return allow(`${name} advances through --no-ff merges of typed small branches only`)
}

/**
 * Run git without a shell; every failure becomes a status instead of a throw.
 * @param {string[]} args arguments after "git".
 * @param {string} cwd the repository directory.
 * @returns {{status: number | null, stdout: string, stderr: string}}
 */
function runGit(args, cwd) {
  try {
    const stdout = execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { status: 0, stdout, stderr: '' }
  } catch (error) {
    return {
      status: typeof error.status === 'number' ? error.status : null,
      stdout: typeof error.stdout === 'string' ? error.stdout : '',
      stderr: typeof error.stderr === 'string' ? error.stderr : '',
    }
  }
}

/**
 * Read the current branch and whether HEAD is detached.
 * @param {string} cwd the repository directory.
 * @returns {{branch: string | null, detached: boolean}}
 */
function currentBranch(cwd) {
  const result = runGit(['symbolic-ref', '--short', '-q', 'HEAD'], cwd)
  if (result.status === 0) return { branch: result.stdout.trim(), detached: false }
  if (result.status === 1) return { branch: null, detached: true }
  throw new Error(`git symbolic-ref failed: ${result.stderr.trim()}`)
}

/**
 * Resolve the absolute git directory.
 * @param {string} cwd the repository directory.
 * @returns {string}
 */
function gitDir(cwd) {
  const result = runGit(['rev-parse', '--absolute-git-dir'], cwd)
  if (result.status !== 0) {
    throw new Error(`not inside a git repository: ${result.stderr.trim()}`)
  }
  return result.stdout.trim()
}

/**
 * Read the commits a merge in progress brings in.
 * The file is the conflict-resolution signal: a clean merge reaches
 * pre-merge-commit with MERGE_HEAD absent, a conflicted one reaches pre-commit
 * with it present.
 * @param {string} dir the absolute git directory.
 * @returns {string[]}
 */
function mergeHeadShas(dir) {
  const path = join(dir, 'MERGE_HEAD')
  if (!existsSync(path)) return []
  const shas = readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  for (const sha of shas) {
    if (!OBJECT_ID_PATTERN.test(sha)) {
      throw new Error(`cannot parse .git/MERGE_HEAD: ${sha}`)
    }
  }
  return shas
}

/**
 * The commits a `git pull` left in FETCH_HEAD.
 * @param {string} dir the absolute git directory.
 * @returns {string[]}
 */
function fetchHeadShas(dir) {
  const path = join(dir, 'FETCH_HEAD')
  if (!existsSync(path)) return []
  const shas = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const field = line.split(/\s+/u)[0]
    if (typeof field === 'string' && OBJECT_ID_PATTERN.test(field)) shas.push(field)
  }
  return shas
}

/**
 * Resolve a ref to its commit id, or null when it does not exist.
 * @param {string} cwd the repository directory.
 * @param {string} name a branch, tag, remote ref or object id.
 * @returns {string | null}
 */
function resolveRef(cwd, name) {
  const result = runGit(['rev-parse', '--verify', '--quiet', `${name}^{commit}`], cwd)
  return result.status === 0 && result.stdout.trim() !== '' ? result.stdout.trim() : null
}

/**
 * Check whether a commit id is a commit in this repository.
 * @param {string} cwd the repository directory.
 * @param {string} sha an object id.
 * @returns {string | null}
 */
function resolveCommit(cwd, sha) {
  if (!OBJECT_ID_PATTERN.test(sha)) return null
  const result = runGit(['cat-file', '-e', `${sha}^{commit}`], cwd)
  return result.status === 0 ? sha : null
}

/**
 * The local branches whose tip contains a commit.
 * @param {string} cwd the repository directory.
 * @param {string} sha a commit id.
 * @returns {string[] | null} null when git could not answer (fail closed).
 */
function branchesContaining(cwd, sha) {
  const result = runGit(
    ['for-each-ref', '--contains', sha, '--format=%(refname:short)', 'refs/heads'],
    cwd,
  )
  if (result.status !== 0) return null
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

/**
 * The highest-numbered version branch visible in this checkout, local or
 * remote-tracking. It is how the policy decides which Vx is frozen: the user
 * cuts the next one from main when a new major version is announced, so the
 * highest number is current by construction. Null when no version branch is
 * visible at all (a checkout of main only).
 * @param {string} cwd the repository directory.
 * @returns {string | null}
 */
function currentVersionBranch(cwd) {
  // Only this repository's own heads and origin's tracking refs count: another
  // remote is not this checkout's version line, and a stale tracking ref can be
  // cleared with `git fetch --prune` (documented in WORKFLOW.md).
  const result = runGit(
    ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes/origin'],
    cwd,
  )
  if (result.status !== 0) return null
  let current = null
  let currentNumber = -1
  for (const ref of result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)) {
    let name = null
    if (ref.startsWith('refs/heads/')) {
      name = ref.slice('refs/heads/'.length)
    } else if (ref.startsWith('refs/remotes/')) {
      const rest = ref.slice('refs/remotes/'.length)
      const slash = rest.indexOf('/')
      name = slash === -1 ? rest : rest.slice(slash + 1)
    }
    if (name === null || !isVersionBranch(name)) continue
    const number = versionNumber(name)
    if (number > currentNumber) {
      current = name
      currentNumber = number
    }
  }
  return current
}

/**
 * Whether a version branch has been superseded in this checkout; null when the
 * checkout shows no version branch to compare against (fail open, so a plain
 * clone of main can still create the first version branch).
 * @param {string} cwd the repository directory.
 * @param {string} name the version branch being written to.
 * @returns {boolean | null}
 */
function versionFrozen(cwd, name) {
  const current = currentVersionBranch(cwd)
  if (current === null) return null
  return isSupersededVersion(name, current)
}

/**
 * Whether a commit is an ancestor of another.
 * @param {string} cwd the repository directory.
 * @param {string} ancestor
 * @param {string} descendant
 * @returns {boolean | null} null when git could not answer (fail closed).
 */
function isAncestor(cwd, ancestor, descendant) {
  const status = runGit(['merge-base', '--is-ancestor', ancestor, descendant], cwd).status
  if (status === 0) return true
  if (status === 1) return false
  return null
}

/**
 * The parent ids of a commit.
 * @param {string} cwd the repository directory.
 * @param {string} sha a commit id.
 * @returns {string[] | null}
 */
function parentShas(cwd, sha) {
  const result = runGit(['rev-list', '--parents', '-n', '1', sha], cwd)
  if (result.status !== 0) return null
  const fields = result.stdout.trim().split(/\s+/u).filter(Boolean)
  if (fields.length === 0) return null
  return fields.slice(1)
}

/**
 * The commits a push adds on a branch's first-parent line, with the facts the
 * push rules need about each one: its parent count, which local branches
 * contain its second parent, and its subject (the fallback for a typed branch
 * that was already deleted before the push).
 * @param {string} cwd the repository directory.
 * @param {string} from the old remote tip.
 * @param {string} to the new local tip.
 * @returns {Array<{sha: string, parentCount: number, secondParentBranches: string[] | null, subject: string}> | null}
 */
function commitsAddedWithProvenance(cwd, from, to) {
  const result = runGit(['rev-list', '--first-parent', `${from}..${to}`], cwd)
  if (result.status !== 0) return null
  const shas = result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const commits = []
  for (const sha of shas) {
    const parents = parentShas(cwd, sha)
    if (parents === null) return null
    const subject = runGit(['log', '-1', '--format=%s', sha], cwd)
    if (subject.status !== 0) return null
    commits.push({
      sha,
      parentCount: parents.length,
      secondParentBranches: parents.length === 2 ? branchesContaining(cwd, parents[1]) : null,
      subject: subject.stdout.trim(),
    })
  }
  return commits
}

/**
 * Gather the facts evaluateMerge needs from this repository.
 * @param {object} options
 * @param {string} options.cwd the repository directory.
 * @param {string} options.dir the absolute git directory.
 * @param {NodeJS.ProcessEnv} options.env the hook's environment.
 * @param {string} options.target the branch receiving the merge.
 * @returns {object} merge facts.
 */
function collectMergeFacts({ cwd, dir, env, target }) {
  const action = env.GIT_REFLOG_ACTION
  // `git pull` runs through the merge machinery with a "pull ..." reflog
  // action and keeps its source commits in FETCH_HEAD rather than naming a
  // ref, so the same sync rules apply once those commits are collected.
  const pulled = typeof action === 'string' && action.startsWith('pull ')
  const sourceNames = pulled ? [] : mergeSourcesFromReflog(action)
  const mergeHead = mergeHeadShas(dir)
  const fetched = pulled ? fetchHeadShas(dir) : []
  const resolvedNames = sourceNames
    .map((name) => resolveRef(cwd, name))
    .filter((sha) => sha !== null)
  const sourceShas = unique([...mergeHead, ...fetched, ...resolvedNames])
  const containingBranches = {}
  for (const sha of sourceShas) {
    containingBranches[sha] = branchesContaining(cwd, sha)
  }
  const mainResolved = resolveRef(cwd, MAIN_BRANCH) !== null
  const originMainResolved = resolveRef(cwd, 'refs/remotes/origin/main') !== null
  const mainTips = []
  if (mainResolved) mainTips.push(MAIN_BRANCH)
  if (originMainResolved) mainTips.push('refs/remotes/origin/main')
  let allSourcesInMain = false
  if (mainTips.length > 0 && sourceShas.length > 0) {
    allSourcesInMain = sourceShas.every((sha) =>
      mainTips.some((tip) => runGit(['merge-base', '--is-ancestor', sha, tip], cwd).status === 0),
    )
  }
  return {
    target,
    sourceNames,
    sourceShas,
    containingBranches,
    mainResolved,
    allSourcesInMain,
    approved: env.DSH_MERGE_APPROVED === '1',
  }
}

/**
 * Gather the facts evaluatePush needs for a main or version branch update.
 * @param {string} cwd the repository directory.
 * @param {string} name the branch being updated.
 * @param {{localSha: string, remoteSha: string}} update the ref line.
 * @returns {object} push facts.
 */
function collectPushFacts(cwd, name, update) {
  const localKnown = resolveCommit(cwd, update.localSha) !== null
  const facts = {
    localKnown,
    remoteKnown: null,
    fastForward: null,
    tipParentCount: null,
    secondParentBranches: null,
    addedOnFirstParent: null,
  }
  if (!localKnown) return facts
  if (isMainBranch(name)) {
    // The tip facts answer the creation question: a new remote main may only be
    // published from a --no-ff release merge.
    const parents = parentShas(cwd, update.localSha)
    facts.tipParentCount = parents === null ? null : parents.length
    facts.secondParentBranches =
      parents === null || parents.length !== 2 ? null : branchesContaining(cwd, parents[1])
  }
  if (isZeroSha(update.remoteSha)) return facts
  facts.remoteKnown = resolveCommit(cwd, update.remoteSha) !== null
  if (facts.remoteKnown !== true) return facts
  facts.fastForward = isAncestor(cwd, update.remoteSha, update.localSha)
  facts.addedOnFirstParent = commitsAddedWithProvenance(cwd, update.remoteSha, update.localSha)
  return facts
}

/**
 * The pre-commit guard.
 * @param {string} cwd the repository directory.
 * @param {NodeJS.ProcessEnv} env the hook's environment.
 * @returns {{ok: boolean, reason: string}}
 */
function guardCommit(cwd, env) {
  const { branch, detached } = currentBranch(cwd)
  const dir = gitDir(cwd)
  const merging = existsSync(join(dir, 'MERGE_HEAD'))
  const needsMergeFacts =
    !detached && merging && typeof branch === 'string' && isProtectedBranch(branch)
  const merge = needsMergeFacts ? collectMergeFacts({ cwd, dir, env, target: branch }) : null
  const currentVersion =
    !detached && typeof branch === 'string' && isVersionBranch(branch)
      ? currentVersionBranch(cwd)
      : null
  return evaluateCommit({ branch, detached, merging, merge, currentVersion })
}

/**
 * The pre-merge-commit guard.
 * @param {string} cwd the repository directory.
 * @param {NodeJS.ProcessEnv} env the hook's environment.
 * @returns {{ok: boolean, reason: string}}
 */
function guardMerge(cwd, env) {
  const { branch, detached } = currentBranch(cwd)
  if (detached) return allow('HEAD is detached; the merge is not on a protected branch')
  if (!isProtectedBranch(branch)) return allow(`${branch} is not a protected branch`)
  const dir = gitDir(cwd)
  const facts = collectMergeFacts({ cwd, dir, env, target: branch })
  if (isVersionBranch(branch)) facts.currentVersion = currentVersionBranch(cwd)
  return evaluateMerge(facts)
}

/**
 * The pre-push guard: evaluate every ref line git wrote to stdin.
 * @param {string} cwd the repository directory.
 * @param {string} stdinText the hook's stdin.
 * @returns {{ok: boolean, reason: string}}
 */
function guardPush(cwd, stdinText) {
  const updates = parsePushLines(stdinText)
  for (const update of updates) {
    const name = branchRefName(update.remoteRef)
    const frozen = name !== null && isVersionBranch(name) ? versionFrozen(cwd, name) : null
    const factless =
      name === null ||
      !isProtectedBranch(name) ||
      update.localRef === '(delete)' ||
      isZeroSha(update.localSha)
    const facts = factless ? {} : collectPushFacts(cwd, name, update)
    if (frozen !== null) facts.frozen = frozen
    const verdict = evaluatePush(update, facts)
    if (!verdict.ok) return verdict
  }
  return allow('all pushed refs respect the branch model')
}

/**
 * Print a verdict: silent on allow, one prefixed line on refuse.
 * @param {{ok: boolean, reason: string}} verdict the decision.
 * @returns {number} the process exit code.
 */
function report(verdict) {
  if (verdict.ok) return 0
  process.stderr.write(`branch-policy: ${verdict.reason}\n`)
  return 1
}

/**
 * Print a usage error.
 * @param {string} message what is wrong with the invocation.
 * @returns {2} the process exit code.
 */
function usageError(message) {
  process.stderr.write(`branch-policy: ${message}\n\n${USAGE}`)
  return 2
}

/**
 * Parse the check-pr arguments, accepting both "--base X" and "--base=X".
 * @param {string[]} args arguments after the subcommand.
 * @returns {{base: string, head: string, currentVersion?: string} | null} null when the invocation is invalid.
 */
function parseCheckPullRequestArguments(args) {
  const values = {}
  const flags = { '--base': 'base', '--head': 'head', '--current-version': 'currentVersion' }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    const equals = arg.indexOf('=')
    const flag = equals === -1 ? arg : arg.slice(0, equals)
    if (!(flag in flags)) return null
    let value
    if (equals === -1) {
      value = args[index + 1]
      if (value === undefined || value.startsWith('--')) return null
      index += 1
    } else {
      value = arg.slice(equals + 1)
    }
    values[flags[flag]] = value
  }
  if (!values.base || !values.head) return null
  return values
}

/**
 * Run one guard subcommand.
 * @param {string} command guard-commit, guard-merge or guard-push.
 * @returns {number} the process exit code.
 */
function runGuard(command) {
  const cwd = process.cwd()
  try {
    if (command === 'guard-commit') return report(guardCommit(cwd, process.env))
    if (command === 'guard-merge') return report(guardMerge(cwd, process.env))
    if (process.stdin.isTTY) {
      process.stderr.write(
        'branch-policy: guard-push reads the ref lines git writes on stdin; run it from the pre-push hook\n',
      )
      return 2
    }
    return report(guardPush(cwd, readFileSync(0, 'utf8')))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`branch-policy: internal error: ${message}\n`)
    return 2
  }
}

/**
 * The command-line entry point.
 * @param {string[]} [argv] arguments after the node binary and script path.
 * @returns {number} the process exit code.
 */
export function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv
  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(USAGE)
    return 0
  }
  if (command === 'check-pr') {
    const parsed = parseCheckPullRequestArguments(rest)
    if (parsed === null) {
      return usageError('check-pr needs --base <ref> and --head <ref> [--current-version <Vn>]')
    }
    return report(checkPullRequest(parsed))
  }
  if (command === 'guard-commit' || command === 'guard-merge' || command === 'guard-push') {
    if (rest.length > 0) return usageError(`unexpected arguments: ${rest.join(' ')}`)
    return runGuard(command)
  }
  return usageError(`unknown command: ${command}`)
}

const isEntry =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isEntry) process.exitCode = main()
