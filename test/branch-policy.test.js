// Tests for the branch-model policy.
//
// The decision helpers are pure, so the first table tests call them directly.
// The guard subcommands are the contract the hooks rely on, so the rest of the
// file runs the real CLI against throwaway git repositories, and asserts the
// pre-gathered facts (reflog action, MERGE_HEAD, ref lines) the way git hands
// them to a hook.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

import {
  checkPullRequest,
  classifyBranch,
  evaluateCommit,
  evaluateMerge,
  evaluatePush,
  isMainBranch,
  isSmallBranch,
  isVersionBranch,
  isZeroSha,
  mergeSourcesFromReflog,
  parsePushLines,
} from '../scripts/branch-policy.mjs'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const POLICY = join(REPO_ROOT, 'scripts', 'branch-policy.mjs')
const ZERO = '0'.repeat(40)

// An empty global git config keeps the developer's real configuration (hooks,
// aliases, signing) out of the throwaway repositories.
const EMPTY_GIT_CONFIG = join(tmpdir(), `branch-policy-gitconfig-${process.pid}`)
writeFileSync(EMPTY_GIT_CONFIG, '')
after(() => rmSync(EMPTY_GIT_CONFIG, { force: true }))

function isolateEnv() {
  const env = { ...process.env }
  for (const key of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_COMMON_DIR',
    'GIT_PREFIX',
    'GIT_REFLOG_ACTION',
    'DSH_MERGE_APPROVED',
  ]) {
    delete env[key]
  }
  env.GIT_CONFIG_NOSYSTEM = '1'
  env.GIT_CONFIG_GLOBAL = EMPTY_GIT_CONFIG
  env.GIT_AUTHOR_NAME = 'Fixture'
  env.GIT_AUTHOR_EMAIL = 'fixture@example.invalid'
  env.GIT_COMMITTER_NAME = 'Fixture'
  env.GIT_COMMITTER_EMAIL = 'fixture@example.invalid'
  return env
}

const BASE_ENV = isolateEnv()

/**
 * Run git in a fixture repository; throw with its stderr on failure.
 * @param {string} cwd
 * @param {string[]} args
 * @returns {string}
 */
function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: BASE_ENV })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${result.status}): ${result.stderr}`)
  }
  return result.stdout.trim()
}

/**
 * Run the policy CLI; empty stdin by default so guard-push sees no ref lines.
 * @param {string} cwd
 * @param {string[]} args
 * @param {{input?: string, env?: Record<string, string>}} [options]
 * @returns {import('node:child_process').SpawnSyncReturns<string>}
 */
function runPolicy(cwd, args, { input = '', env = {} } = {}) {
  return spawnSync(process.execPath, [POLICY, ...args], {
    cwd,
    encoding: 'utf8',
    input,
    env: { ...BASE_ENV, ...env },
  })
}

/**
 * @param {import('node:child_process').SpawnSyncReturns<string>} result
 */
function assertAllowed(result) {
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stderr, '')
}

/**
 * @param {import('node:child_process').SpawnSyncReturns<string>} result
 * @param {RegExp} [pattern]
 */
function assertRefused(result, pattern) {
  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stderr, /^branch-policy: /u)
  if (pattern !== undefined) assert.match(result.stderr, pattern)
}

function tempRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'branch-policy-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

/**
 * Create a fixture repository on main with user config already set.
 * @param {import('node:test').TestContext} t
 */
function gitFixture(t) {
  const root = tempRoot(t)
  git(root, ['init', '-q', '-b', 'main'])
  git(root, ['config', 'user.name', 'Fixture'])
  git(root, ['config', 'user.email', 'fixture@example.invalid'])
  git(root, ['config', 'commit.gpgsign', 'false'])
  return { root }
}

/**
 * Write a file and commit it; return the new commit id.
 * @param {{root: string}} repo
 * @param {string} relativePath
 * @param {string} content
 * @param {string} message
 * @returns {string}
 */
function commitFile(repo, relativePath, content, message) {
  const path = join(repo.root, relativePath)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  git(repo.root, ['add', relativePath])
  git(repo.root, ['commit', '-q', '-m', message])
  return git(repo.root, ['rev-parse', 'HEAD'])
}

/**
 * Merge a branch with --no-ff and return the merge commit.
 * @param {{root: string}} repo
 * @param {string} branch
 * @returns {string}
 */
function mergeNoFf(repo, branch) {
  git(repo.root, ['merge', '--no-ff', '-q', branch, '-m', `merge ${branch}`])
  return git(repo.root, ['rev-parse', 'HEAD'])
}

/**
 * Start a merge that is expected to conflict, leaving MERGE_HEAD behind.
 * @param {{root: string}} repo
 * @param {string} branch
 */
function conflictedMerge(repo, branch) {
  const result = spawnSync('git', ['merge', '--no-ff', branch, '-m', `merge ${branch}`], {
    cwd: repo.root,
    encoding: 'utf8',
    env: BASE_ENV,
  })
  assert.notEqual(result.status, 0, `expected the merge of ${branch} to conflict`)
  assert.ok(
    readFileSync(join(repo.root, '.git', 'MERGE_HEAD'), 'utf8').trim() !== '',
    'MERGE_HEAD should exist after a conflicted merge',
  )
}

function pushLine(localRef, localSha, remoteRef, remoteSha) {
  return `${localRef} ${localSha} ${remoteRef} ${remoteSha}\n`
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test('branch classifiers classify each role in the model', () => {
  assert.equal(isMainBranch('main'), true)
  assert.equal(isMainBranch('Main'), false)
  assert.equal(isMainBranch('mainline'), false)

  for (const name of ['V1', 'V2', 'V10', 'V123']) assert.equal(isVersionBranch(name), true)
  for (const name of ['V0', 'V01', 'V', 'v2', 'V2a', 'V2/x', 'main', 'feat/x', '']) {
    assert.equal(isVersionBranch(name), false)
  }

  for (const name of [
    'feat/branch-model',
    'bug/fix-1',
    'doc/policy',
    'chore/hooks',
    'refactor/core',
    'test/policy',
    'perf/index',
  ]) {
    assert.equal(isSmallBranch(name), true)
  }
  for (const name of [
    'feature/x',
    'feat/',
    'feat/Upper',
    'feat/under_score',
    'feat/-leading',
    'feat/x/y',
    'feat/x-',
    'feat/a--b',
    'feat/-x',
    'fix/x',
    'feat/x ',
    '',
  ]) {
    assert.equal(isSmallBranch(name), false)
  }

  assert.equal(classifyBranch('main'), 'main')
  assert.equal(classifyBranch('V2'), 'version')
  assert.equal(classifyBranch('bug/fix-1'), 'small')
  assert.equal(classifyBranch('release'), 'other')
  assert.equal(classifyBranch(''), 'other')

  assert.equal(isZeroSha('0'.repeat(40)), true)
  assert.equal(isZeroSha(ZERO), true)
  assert.equal(isZeroSha('abc'), false)
  assert.equal(isZeroSha('0'.repeat(39) + 'a'), false)
})

test('checkPullRequest accepts one topology and refuses everything else', () => {
  assert.equal(checkPullRequest({ base: 'main', head: 'V2' }).ok, true)
  assert.equal(checkPullRequest({ base: 'main', head: 'V10' }).ok, true)
  assert.equal(checkPullRequest({ base: 'main', head: 'feat/x' }).ok, false)
  assert.equal(checkPullRequest({ base: 'main', head: 'V0' }).ok, false)
  assert.equal(checkPullRequest({ base: 'V2', head: 'feat/x' }).ok, true)
  assert.equal(checkPullRequest({ base: 'V2', head: 'bug/fix-1' }).ok, true)
  assert.equal(checkPullRequest({ base: 'V2', head: 'V3' }).ok, false)
  assert.equal(checkPullRequest({ base: 'V2', head: 'main' }).ok, false)
  // CI can compute the current Vx; a pull request into a frozen Vx is refused.
  assert.equal(checkPullRequest({ base: 'V2', head: 'feat/x', currentVersion: 'V3' }).ok, false)
  assert.equal(checkPullRequest({ base: 'V2', head: 'feat/x', currentVersion: 'V2' }).ok, true)
  assert.equal(checkPullRequest({ base: 'V2', head: 'feat/x', currentVersion: null }).ok, true)
  assert.equal(checkPullRequest({ base: 'next', head: 'anything' }).ok, true)
  assert.equal(checkPullRequest({ base: 'next', head: 'V2' }).ok, true)
  assert.equal(checkPullRequest({ base: '', head: 'V2' }).ok, false)
  assert.equal(checkPullRequest({ base: 'main', head: '' }).ok, false)
})

test('parsePushLines and mergeSourcesFromReflog read git hook payloads', () => {
  const sha = 'a'.repeat(40)
  assert.deepEqual(parsePushLines(`refs/heads/V2 ${sha} refs/heads/V2 ${ZERO}\n\n   \n`), [
    { localRef: 'refs/heads/V2', localSha: sha, remoteRef: 'refs/heads/V2', remoteSha: ZERO },
  ])
  assert.deepEqual(parsePushLines(''), [])
  assert.throws(() => parsePushLines('not-a-ref-line'), /cannot parse the pre-push ref line/u)
  assert.throws(() => parsePushLines(`${sha} extra`), /cannot parse the pre-push ref line/u)

  assert.deepEqual(mergeSourcesFromReflog('merge V2'), ['V2'])
  assert.deepEqual(mergeSourcesFromReflog('merge feat/x V2'), ['feat/x', 'V2'])
  assert.deepEqual(mergeSourcesFromReflog(undefined), [])
  assert.deepEqual(mergeSourcesFromReflog('commit'), [])
  assert.deepEqual(mergeSourcesFromReflog('merge '), [])
})

test('evaluateMerge encodes the merge directions', () => {
  const sha = 'a'.repeat(40)
  assert.equal(evaluateMerge({ target: 'feat/x', sourceNames: ['main'] }).ok, true)

  // main only takes a version branch, no matter the approval marker.
  assert.equal(evaluateMerge({ target: 'main', sourceNames: ['V2'] }).ok, true)
  assert.equal(evaluateMerge({ target: 'main', sourceNames: ['feat/x'] }).ok, false)
  assert.equal(evaluateMerge({ target: 'main', sourceNames: ['feat/x'], approved: true }).ok, false)
  assert.equal(
    evaluateMerge({
      target: 'main',
      sourceShas: [sha],
      containingBranches: { [sha]: ['feat/x'] },
    }).ok,
    false,
  )
  assert.equal(
    evaluateMerge({ target: 'main', sourceShas: [sha], containingBranches: { [sha]: ['V2'] } }).ok,
    true,
  )
  // A release merge names exactly one version branch; octopus or mixed merges
  // are refused, and the marker cannot authorize a non-typed source.
  assert.equal(evaluateMerge({ target: 'main', sourceNames: ['V2', 'V3'] }).ok, false)
  assert.equal(evaluateMerge({ target: 'main', sourceNames: ['V2', 'feat/x'] }).ok, false)
  // Unidentifiable source fails closed.
  assert.equal(evaluateMerge({ target: 'main' }).ok, false)
  assert.equal(evaluateMerge({ target: 'V2' }).ok, false)

  // A version branch needs approval for a typed-branch merge.
  const unapproved = evaluateMerge({ target: 'V2', sourceNames: ['feat/x'] })
  assert.equal(unapproved.ok, false)
  assert.match(unapproved.reason, /DSH_MERGE_APPROVED=1 git merge --no-ff feat\/x/u)
  assert.equal(evaluateMerge({ target: 'V2', sourceNames: ['feat/x'], approved: true }).ok, true)
  // Exactly one typed branch: mixing main into the same merge is refused.
  assert.equal(
    evaluateMerge({ target: 'V2', sourceNames: ['feat/x', 'main'], approved: true }).ok,
    false,
  )
  // The marker alone does not authorize a non-typed source.
  assert.equal(evaluateMerge({ target: 'V2', sourceNames: ['V3'], approved: true }).ok, false)
  // A sync merge from main is exempt from the marker.
  assert.equal(
    evaluateMerge({
      target: 'V2',
      sourceNames: ['main'],
      sourceShas: [sha],
      mainResolved: true,
      allSourcesInMain: true,
    }).ok,
    true,
  )
  assert.equal(
    evaluateMerge({
      target: 'V2',
      sourceNames: ['main'],
      sourceShas: [sha],
      mainResolved: true,
      allSourcesInMain: false,
      approved: false,
    }).ok,
    false,
  )

  // A superseded version branch is frozen; the highest Vx is the current one.
  const frozen = evaluateMerge({
    target: 'V2',
    sourceNames: ['feat/x'],
    approved: true,
    currentVersion: 'V3',
  })
  assert.equal(frozen.ok, false)
  assert.match(frozen.reason, /frozen read-only history/u)
  assert.equal(
    evaluateMerge({ target: 'V2', sourceNames: ['feat/x'], approved: true, currentVersion: 'V2' })
      .ok,
    true,
  )
  // The sync exemption does not resurrect a frozen branch.
  assert.equal(
    evaluateMerge({
      target: 'V2',
      sourceNames: ['main'],
      mainResolved: true,
      allSourcesInMain: true,
      currentVersion: 'V3',
    }).ok,
    false,
  )
})

test('evaluateCommit refuses direct commits but allows merge resolutions', () => {
  const direct = evaluateCommit({ branch: 'main', detached: false, merging: false })
  assert.equal(direct.ok, false)
  assert.match(direct.reason, /direct commits are not allowed on main/u)
  assert.match(direct.reason, /<type>\/<slug>/u)
  assert.equal(evaluateCommit({ branch: 'V2', detached: false, merging: false }).ok, false)
  assert.equal(evaluateCommit({ branch: 'feat/x', detached: false, merging: false }).ok, true)
  assert.equal(evaluateCommit({ branch: null, detached: true, merging: false }).ok, true)
  assert.equal(
    evaluateCommit({
      branch: 'main',
      detached: false,
      merging: true,
      merge: { target: 'main', sourceNames: ['V2'] },
    }).ok,
    true,
  )
  assert.equal(
    evaluateCommit({
      branch: 'V2',
      detached: false,
      merging: true,
      merge: { target: 'V2', sourceNames: ['feat/x'] },
    }).ok,
    false,
  )
  // A merge state with unusable facts fails closed.
  assert.equal(
    evaluateCommit({ branch: 'V2', detached: false, merging: true, merge: null }).ok,
    false,
  )
  // A superseded version branch is frozen before any merge rule applies.
  const frozenCommit = evaluateCommit({
    branch: 'V2',
    detached: false,
    merging: false,
    currentVersion: 'V3',
  })
  assert.equal(frozenCommit.ok, false)
  assert.match(frozenCommit.reason, /frozen read-only history/u)
  assert.equal(
    evaluateCommit({ branch: 'V3', detached: false, merging: false, currentVersion: 'V3' }).ok,
    false,
  )
})

test('evaluatePush encodes the push rules', () => {
  const update = (overrides = {}) => ({
    localRef: 'refs/heads/main',
    localSha: 'b'.repeat(40),
    remoteRef: 'refs/heads/main',
    remoteSha: 'a'.repeat(40),
    ...overrides,
  })
  const releaseMerge = {
    sha: 'b'.repeat(40),
    parentCount: 2,
    secondParentBranches: ['V2'],
    subject: "Merge branch 'V2'",
  }
  const mainFacts = {
    localKnown: true,
    remoteKnown: true,
    fastForward: true,
    addedOnFirstParent: [releaseMerge],
  }
  const versionFacts = {
    localKnown: true,
    remoteKnown: true,
    fastForward: true,
    addedOnFirstParent: [
      {
        sha: 'b'.repeat(40),
        parentCount: 2,
        secondParentBranches: ['feat/x'],
        subject: "Merge branch 'feat/x'",
      },
    ],
  }

  // Tags and unknown namespaces are left alone.
  assert.equal(
    evaluatePush(update({ localRef: 'refs/tags/v1.0.0', remoteRef: 'refs/tags/v1.0.0' })).ok,
    true,
  )
  assert.equal(evaluatePush(update({ remoteRef: 'refs/notes/commits' })).ok, true)

  // Creation: version and typed branches yes, main and stray names no.
  assert.equal(evaluatePush(update({ remoteRef: 'refs/heads/V2', remoteSha: ZERO })).ok, true)
  assert.equal(evaluatePush(update({ remoteRef: 'refs/heads/feat/new', remoteSha: ZERO })).ok, true)
  assert.equal(evaluatePush(update({ remoteRef: 'refs/heads/nope', remoteSha: ZERO })).ok, false)
  assert.equal(evaluatePush(update({ remoteRef: 'refs/heads/main', remoteSha: ZERO })).ok, false)
  // Bootstrapping a new remote is allowed only from a --no-ff release merge.
  assert.equal(
    evaluatePush(update({ remoteRef: 'refs/heads/main', remoteSha: ZERO }), {
      localKnown: true,
      tipParentCount: 2,
      secondParentBranches: ['V2'],
    }).ok,
    true,
  )
  assert.equal(
    evaluatePush(update({ remoteRef: 'refs/heads/main', remoteSha: ZERO }), {
      localKnown: true,
      tipParentCount: 1,
      secondParentBranches: null,
    }).ok,
    false,
  )

  // Deletion: main and version branches are permanent, a typed branch is not.
  assert.equal(
    evaluatePush(update({ localRef: '(delete)', localSha: ZERO, remoteRef: 'refs/heads/main' })).ok,
    false,
  )
  assert.equal(
    evaluatePush(update({ localRef: '(delete)', localSha: ZERO, remoteRef: 'refs/heads/V2' })).ok,
    false,
  )
  assert.equal(
    evaluatePush(update({ localRef: '(delete)', localSha: ZERO, remoteRef: 'refs/heads/feat/x' }))
      .ok,
    true,
  )

  // main must fast-forward, and every commit the push adds to its first-parent
  // line must itself be a --no-ff merge from a local version branch.
  assert.equal(evaluatePush(update(), mainFacts).ok, true)
  assert.equal(evaluatePush(update(), { ...mainFacts, fastForward: false }).ok, false)
  assert.equal(
    evaluatePush(update(), {
      ...mainFacts,
      addedOnFirstParent: [{ ...releaseMerge, parentCount: 1 }],
    }).ok,
    false,
  )
  assert.equal(
    evaluatePush(update(), {
      ...mainFacts,
      addedOnFirstParent: [{ ...releaseMerge, secondParentBranches: ['feat/x'] }],
    }).ok,
    false,
  )
  // A direct commit hidden behind a release merge refuses the whole push.
  assert.equal(
    evaluatePush(update(), {
      ...mainFacts,
      addedOnFirstParent: [
        { ...releaseMerge, sha: 'c'.repeat(40) },
        { ...releaseMerge, parentCount: 1 },
      ],
    }).ok,
    false,
  )
  assert.equal(evaluatePush(update(), {}).ok, false)

  // A version branch must fast-forward through two-parent merges of main or a
  // typed branch; an arbitrary source is refused even when its message looks
  // conventional.
  assert.equal(evaluatePush(update({ remoteRef: 'refs/heads/V2' }), versionFacts).ok, true)
  assert.equal(
    evaluatePush(update({ remoteRef: 'refs/heads/V2' }), {
      ...versionFacts,
      addedOnFirstParent: [{ sha: 'b'.repeat(40), parentCount: 1 }],
    }).ok,
    false,
  )
  assert.equal(
    evaluatePush(update({ remoteRef: 'refs/heads/V2' }), {
      ...versionFacts,
      addedOnFirstParent: [
        {
          sha: 'b'.repeat(40),
          parentCount: 2,
          secondParentBranches: ['side'],
          subject: "Merge branch 'side'",
        },
      ],
    }).ok,
    false,
  )
  assert.equal(
    evaluatePush(update({ remoteRef: 'refs/heads/V2' }), {
      ...versionFacts,
      addedOnFirstParent: [
        {
          sha: 'b'.repeat(40),
          parentCount: 2,
          secondParentBranches: ['main'],
          subject: "Merge branch 'main'",
        },
      ],
    }).ok,
    true,
  )
  // A typed branch deleted before the push falls back to the merge subject.
  assert.equal(
    evaluatePush(update({ remoteRef: 'refs/heads/V2' }), {
      ...versionFacts,
      addedOnFirstParent: [
        {
          sha: 'b'.repeat(40),
          parentCount: 2,
          secondParentBranches: [],
          subject: "Merge branch 'feat/gone'",
        },
      ],
    }).ok,
    true,
  )
  assert.equal(
    evaluatePush(update({ remoteRef: 'refs/heads/V2' }), { ...versionFacts, fastForward: false })
      .ok,
    false,
  )
  assert.equal(evaluatePush(update({ remoteRef: 'refs/heads/V2' }), {}).ok, false)

  // A superseded version branch is frozen: it can neither be created nor
  // updated, while a higher-numbered creation remains the way a version starts.
  assert.equal(
    evaluatePush(update({ remoteRef: 'refs/heads/V2', remoteSha: ZERO }), { frozen: true }).ok,
    false,
  )
  assert.equal(
    evaluatePush(update({ remoteRef: 'refs/heads/V3', remoteSha: ZERO }), { frozen: false }).ok,
    true,
  )
  assert.equal(
    evaluatePush(update({ remoteRef: 'refs/heads/V3', remoteSha: ZERO }), { frozen: true }).ok,
    false,
  )
  assert.equal(
    evaluatePush(update({ remoteRef: 'refs/heads/V2' }), { ...versionFacts, frozen: true }).ok,
    false,
  )
  assert.equal(
    evaluatePush(update({ remoteRef: 'refs/heads/V2' }), { ...versionFacts, frozen: false }).ok,
    true,
  )

  // A typed branch is personal: updates and force-pushes are allowed.
  assert.equal(evaluatePush(update({ remoteRef: 'refs/heads/feat/x' })).ok, true)
  // A stray refs/heads name is refused for updates too.
  assert.equal(evaluatePush(update({ remoteRef: 'refs/heads/nope' })).ok, false)
})

// ---------------------------------------------------------------------------
// CLI surface
// ---------------------------------------------------------------------------

test('the CLI prints usage and maps bad invocations to exit code 2', () => {
  const help = runPolicy(REPO_ROOT, ['--help'])
  assert.equal(help.status, 0)
  assert.match(help.stdout, /guard-commit/u)
  assert.match(help.stdout, /check-pr --base/u)

  const noCommand = runPolicy(REPO_ROOT, [])
  assert.equal(noCommand.status, 0)
  assert.match(noCommand.stdout, /Usage:/u)

  assert.equal(runPolicy(REPO_ROOT, ['nonsense']).status, 2)
  assert.equal(runPolicy(REPO_ROOT, ['check-pr']).status, 2)
  assert.equal(runPolicy(REPO_ROOT, ['check-pr', '--base', 'main']).status, 2)
  assert.equal(runPolicy(REPO_ROOT, ['check-pr', '--base=']).status, 2)
  assert.equal(
    runPolicy(REPO_ROOT, ['check-pr', '--base', 'main', '--head', 'V2', '--current-version'])
      .status,
    2,
  )
  assert.equal(runPolicy(REPO_ROOT, ['guard-commit', '--now']).status, 2)
})

test('check-pr enforces the pull-request matrix', () => {
  assertAllowed(runPolicy(REPO_ROOT, ['check-pr', '--base', 'main', '--head', 'V2']))
  assertAllowed(runPolicy(REPO_ROOT, ['check-pr', '--base=main', '--head=V10']))
  assertRefused(runPolicy(REPO_ROOT, ['check-pr', '--base', 'main', '--head', 'feat/x']))
  assertAllowed(runPolicy(REPO_ROOT, ['check-pr', '--base', 'V2', '--head', 'feat/x']))
  assertRefused(runPolicy(REPO_ROOT, ['check-pr', '--base', 'V2', '--head', 'V3']))
  assertRefused(
    runPolicy(REPO_ROOT, [
      'check-pr',
      '--base',
      'V2',
      '--head',
      'feat/x',
      '--current-version',
      'V3',
    ]),
    /frozen read-only history/u,
  )
  assertAllowed(
    runPolicy(REPO_ROOT, ['check-pr', '--base=V2', '--head=feat/x', '--current-version=V2']),
  )
  assertAllowed(runPolicy(REPO_ROOT, ['check-pr', '--base', 'next', '--head', 'anything']))
})

// ---------------------------------------------------------------------------
// guard-commit against real repositories
// ---------------------------------------------------------------------------

test('guard-commit refuses direct commits on main and Vx, allows the rest', (t) => {
  const repo = gitFixture(t)
  commitFile(repo, 'a.txt', 'base\n', 'base')

  assertRefused(runPolicy(repo.root, ['guard-commit']), /direct commits are not allowed on main/u)

  git(repo.root, ['checkout', '-q', '-b', 'V2'])
  assertRefused(runPolicy(repo.root, ['guard-commit']), /direct commits are not allowed on V2/u)

  git(repo.root, ['checkout', '-q', '-b', 'feat/x'])
  assertAllowed(runPolicy(repo.root, ['guard-commit']))

  git(repo.root, ['checkout', '-q', '--detach'])
  assertAllowed(runPolicy(repo.root, ['guard-commit']))
})

test('guard-commit checks a conflicted merge as that merge', (t) => {
  const repo = gitFixture(t)
  commitFile(repo, 'a.txt', 'base\n', 'base')
  git(repo.root, ['checkout', '-q', '-b', 'V2'])
  commitFile(repo, 'a.txt', 'v2\n', 'v2 work')
  git(repo.root, ['checkout', '-q', 'main'])
  commitFile(repo, 'a.txt', 'main\n', 'main work')
  conflictedMerge(repo, 'V2')

  // The conflict resolution is what completes `git merge --no-ff V2`, so it
  // must be allowed, and it must be judged by MERGE_HEAD, not by a direct-commit
  // refusal.
  assertAllowed(runPolicy(repo.root, ['guard-commit']))
})

test('guard-commit needs approval to resolve a typed merge into a version branch', (t) => {
  const repo = gitFixture(t)
  commitFile(repo, 'a.txt', 'base\n', 'base')
  git(repo.root, ['checkout', '-q', '-b', 'V2'])
  commitFile(repo, 'a.txt', 'v2\n', 'v2 one')
  git(repo.root, ['checkout', '-q', '-b', 'feat/x'])
  commitFile(repo, 'a.txt', 'feat\n', 'feat work')
  git(repo.root, ['checkout', '-q', 'V2'])
  commitFile(repo, 'a.txt', 'v2 second\n', 'v2 two')
  conflictedMerge(repo, 'feat/x')

  assertRefused(runPolicy(repo.root, ['guard-commit']), /DSH_MERGE_APPROVED=1/u)
  assertAllowed(runPolicy(repo.root, ['guard-commit'], { env: { DSH_MERGE_APPROVED: '1' } }))
})

// ---------------------------------------------------------------------------
// guard-merge against real repositories
// ---------------------------------------------------------------------------

test('guard-merge enforces the merge directions from the reflog action', (t) => {
  const repo = gitFixture(t)
  commitFile(repo, 'a.txt', 'base\n', 'base')
  git(repo.root, ['checkout', '-q', '-b', 'V2'])
  commitFile(repo, 'v2.txt', 'v2\n', 'v2 work')
  git(repo.root, ['checkout', '-q', '-b', 'feat/x', 'main'])
  commitFile(repo, 'feat.txt', 'feat\n', 'feat work')
  git(repo.root, ['checkout', '-q', 'main'])

  // main <- V2 is a release merge.
  assertAllowed(runPolicy(repo.root, ['guard-merge'], { env: { GIT_REFLOG_ACTION: 'merge V2' } }))
  // main <- typed is never allowed, even with the marker.
  assertRefused(
    runPolicy(repo.root, ['guard-merge'], { env: { GIT_REFLOG_ACTION: 'merge feat/x' } }),
    /version branch/u,
  )
  assertRefused(
    runPolicy(repo.root, ['guard-merge'], {
      env: { GIT_REFLOG_ACTION: 'merge feat/x', DSH_MERGE_APPROVED: '1' },
    }),
    /version branch/u,
  )
  // An unidentifiable source fails closed.
  assertRefused(runPolicy(repo.root, ['guard-merge']), /cannot identify/u)

  git(repo.root, ['checkout', '-q', 'V2'])
  // V2 <- typed needs the user's confirmation.
  assertRefused(
    runPolicy(repo.root, ['guard-merge'], { env: { GIT_REFLOG_ACTION: 'merge feat/x' } }),
    /DSH_MERGE_APPROVED=1 git merge --no-ff feat\/x/u,
  )
  assertAllowed(
    runPolicy(repo.root, ['guard-merge'], {
      env: { GIT_REFLOG_ACTION: 'merge feat/x', DSH_MERGE_APPROVED: '1' },
    }),
  )
  // V2 <- main is the exempt sync merge.
  assertAllowed(runPolicy(repo.root, ['guard-merge'], { env: { GIT_REFLOG_ACTION: 'merge main' } }))
  // V2 with no visible source fails closed.
  assertRefused(runPolicy(repo.root, ['guard-merge']), /cannot identify/u)

  git(repo.root, ['checkout', '-q', 'feat/x'])
  assertAllowed(runPolicy(repo.root, ['guard-merge'], { env: { GIT_REFLOG_ACTION: 'merge main' } }))
})

// ---------------------------------------------------------------------------
// guard-push against real repositories
// ---------------------------------------------------------------------------

test('guard-push enforces the push rules from the ref lines', (t) => {
  const repo = gitFixture(t)
  const base = commitFile(repo, 'a.txt', 'base\n', 'base')
  const mainDirect = commitFile(repo, 'main.txt', 'main direct\n', 'main direct')

  git(repo.root, ['checkout', '-q', '-b', 'V2', base])
  const v2Direct = commitFile(repo, 'v2.txt', 'v2\n', 'v2 work')
  git(repo.root, ['checkout', '-q', '-b', 'feat/x'])
  const featTip = commitFile(repo, 'feat.txt', 'feat\n', 'feat work')
  git(repo.root, ['checkout', '-q', 'V2'])
  const v2Merge = mergeNoFf(repo, 'feat/x')

  git(repo.root, ['checkout', '-q', 'main'])
  const mainRelease = mergeNoFf(repo, 'V2')

  git(repo.root, ['checkout', '-q', '-b', 'side', base])
  const sideTip = commitFile(repo, 'side.txt', 'side\n', 'side work')

  const push = (localRef, localSha, remoteRef, remoteSha) =>
    runPolicy(repo.root, ['guard-push'], {
      input: pushLine(localRef, localSha, remoteRef, remoteSha),
    })

  // Tags and unknown namespaces are not branch history.
  assertAllowed(push('refs/tags/v2.0.3', mainRelease, 'refs/tags/v2.0.3', ZERO))
  assertAllowed(push('refs/notes/commits', mainRelease, 'refs/notes/commits', ZERO))
  // Empty stdin (a push with nothing to update) is allowed.
  assertAllowed(runPolicy(repo.root, ['guard-push']))

  // Creation: typed and version branches allowed; stray names and a new main refused.
  assertAllowed(push('refs/heads/feat/new', featTip, 'refs/heads/feat/new', ZERO))
  assertAllowed(push('refs/heads/V3', base, 'refs/heads/V3', ZERO))
  assertRefused(
    push('refs/heads/nope', featTip, 'refs/heads/nope', ZERO),
    /does not match the policy/u,
  )
  // Bootstrapping a new remote from a release merge is the one allowed creation.
  assertAllowed(push('refs/heads/main', mainRelease, 'refs/heads/main', ZERO))
  assertRefused(
    push('refs/heads/main', mainDirect, 'refs/heads/main', ZERO),
    /creating remote main/u,
  )

  // Deletion: main and V2 are permanent, a typed branch is deletable.
  assertRefused(push('(delete)', ZERO, 'refs/heads/main', mainRelease), /cannot be deleted/u)
  assertRefused(push('(delete)', ZERO, 'refs/heads/V2', v2Merge), /cannot be deleted/u)
  assertAllowed(push('(delete)', ZERO, 'refs/heads/feat/x', featTip))

  // main: a direct commit, a non-merge tip, a non-fast-forward and an unknown
  // remote sha are refused; the --no-ff release merge is allowed.
  assertRefused(push('refs/heads/main', mainDirect, 'refs/heads/main', base), /not a merge commit/u)
  assertRefused(
    push('refs/heads/main', mainDirect, 'refs/heads/main', sideTip),
    /non-fast-forward/u,
  )
  assertRefused(
    push('refs/heads/main', mainRelease, 'refs/heads/main', 'f'.repeat(40)),
    /cannot verify/u,
  )
  assertAllowed(push('refs/heads/main', mainRelease, 'refs/heads/main', mainDirect))

  // V2: only fast-forward merge commits may be pushed.
  assertRefused(push('refs/heads/V2', v2Direct, 'refs/heads/V2', base), /not a merge commit/u)
  assertRefused(push('refs/heads/V2', v2Direct, 'refs/heads/V2', sideTip), /non-fast-forward/u)
  assertAllowed(push('refs/heads/V2', v2Merge, 'refs/heads/V2', v2Direct))

  // A typed branch may be force-pushed.
  assertAllowed(push('refs/heads/feat/x', featTip, 'refs/heads/feat/x', sideTip))

  // One refused ref line is enough to refuse the whole push.
  const mixed =
    pushLine('refs/heads/feat/new', featTip, 'refs/heads/feat/new', ZERO) +
    pushLine('refs/heads/nope', featTip, 'refs/heads/nope', ZERO)
  assertRefused(
    runPolicy(repo.root, ['guard-push'], { input: mixed }),
    /does not match the policy/u,
  )
})

test('guard-push refuses a direct commit hidden behind a release merge', (t) => {
  const repo = gitFixture(t)
  const base = commitFile(repo, 'a.txt', 'base\n', 'base')
  git(repo.root, ['checkout', '-q', '-b', 'V2'])
  commitFile(repo, 'v2.txt', 'v2\n', 'v2 one')
  git(repo.root, ['checkout', '-q', 'main'])
  mergeNoFf(repo, 'V2')
  // The bypass the tip-only rule missed: a direct commit on main, then a second
  // release merge on top hides it from every later tip check.
  commitFile(repo, 'hidden.txt', 'hidden\n', 'hidden direct commit')
  git(repo.root, ['checkout', '-q', 'V2'])
  commitFile(repo, 'v2b.txt', 'v2b\n', 'v2 more')
  git(repo.root, ['checkout', '-q', 'main'])
  const releaseTwo = mergeNoFf(repo, 'V2')

  const push = (localSha, remoteSha) =>
    runPolicy(repo.root, ['guard-push'], {
      input: pushLine('refs/heads/main', localSha, 'refs/heads/main', remoteSha),
    })
  assertRefused(push(releaseTwo, base), /not a merge commit/u)
})

test('guard-push refuses a merge into V2 from an unapproved branch', (t) => {
  const repo = gitFixture(t)
  const base = commitFile(repo, 'a.txt', 'base\n', 'base')
  git(repo.root, ['checkout', '-q', '-b', 'V2'])
  const v2Direct = commitFile(repo, 'v2.txt', 'v2\n', 'v2 work')
  git(repo.root, ['checkout', '-q', '-b', 'side', base])
  commitFile(repo, 'side.txt', 'side\n', 'side work')
  git(repo.root, ['checkout', '-q', 'V2'])
  const v2Evil = mergeNoFf(repo, 'side')
  assert.notEqual(v2Evil, v2Direct)

  const result = runPolicy(repo.root, ['guard-push'], {
    input: pushLine('refs/heads/V2', v2Evil, 'refs/heads/V2', v2Direct),
  })
  assertRefused(result, /neither main nor a typed small branch/u)
})

test('guard-merge accepts a main sync by origin/main and by pull', (t) => {
  const repo = gitFixture(t)
  commitFile(repo, 'a.txt', 'base\n', 'base')
  const mainTip = git(repo.root, ['rev-parse', 'main'])
  git(repo.root, ['checkout', '-q', '-b', 'V2'])
  commitFile(repo, 'v2.txt', 'v2\n', 'v2 work')
  // A fetched origin/main is how a stale local main reaches a version branch.
  git(repo.root, ['update-ref', 'refs/remotes/origin/main', mainTip])

  assertAllowed(
    runPolicy(repo.root, ['guard-merge'], { env: { GIT_REFLOG_ACTION: 'merge origin/main' } }),
  )
  // `git pull --no-rebase origin main` names no ref in its reflog action, so the
  // policy reads the fetched commit instead.
  writeFileSync(join(repo.root, '.git', 'FETCH_HEAD'), `${mainTip}\t\tbranch 'main' of origin\n`)
  assertAllowed(
    runPolicy(repo.root, ['guard-merge'], {
      env: { GIT_REFLOG_ACTION: 'pull --no-rebase origin main' },
    }),
  )
})

// ---------------------------------------------------------------------------
// Superseded version branches are frozen
// ---------------------------------------------------------------------------

test('a superseded version branch is frozen read-only history', (t) => {
  const repo = gitFixture(t)
  const base = commitFile(repo, 'a.txt', 'base\n', 'base')
  git(repo.root, ['checkout', '-q', '-b', 'V2'])
  const v2Direct = commitFile(repo, 'v2.txt', 'v2\n', 'v2 work')
  git(repo.root, ['checkout', '-q', 'main'])
  git(repo.root, ['checkout', '-q', '-b', 'V3', 'main'])
  commitFile(repo, 'v3.txt', 'v3\n', 'v3 work')

  // V3 is visible, so V2 is frozen: commits, merges and pushes are refused
  // even with the approval marker a current Vx would need.
  git(repo.root, ['checkout', '-q', 'V2'])
  assertRefused(runPolicy(repo.root, ['guard-commit']), /frozen read-only history/u)
  assertRefused(
    runPolicy(repo.root, ['guard-merge'], {
      env: { GIT_REFLOG_ACTION: 'merge feat/x', DSH_MERGE_APPROVED: '1' },
    }),
    /frozen read-only history/u,
  )
  assertRefused(
    runPolicy(repo.root, ['guard-merge'], { env: { GIT_REFLOG_ACTION: 'merge main' } }),
    /frozen read-only history/u,
  )
  const push = (localSha, remoteSha) =>
    runPolicy(repo.root, ['guard-push'], {
      input: pushLine('refs/heads/V2', localSha, 'refs/heads/V2', remoteSha),
    })
  assertRefused(push(v2Direct, base), /frozen read-only history/u)
  assertRefused(push(v2Direct, ZERO), /cannot create V2/u)

  // The current version branch is not frozen; only the ordinary rules apply.
  git(repo.root, ['checkout', '-q', 'V3'])
  assertRefused(runPolicy(repo.root, ['guard-commit']), /direct commits are not allowed on V3/u)
  const v3Tip = git(repo.root, ['rev-parse', 'V3'])
  assertAllowed(
    runPolicy(repo.root, ['guard-push'], {
      input: pushLine('refs/heads/V3', v3Tip, 'refs/heads/V3', ZERO),
    }),
  )
})

// ---------------------------------------------------------------------------
// The durable CI layer
// ---------------------------------------------------------------------------

test('the branch-policy workflow checks the PR topology in CI', () => {
  const text = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'branch-policy.yml'), 'utf8')
  const workflow = parse(text)
  assert.deepEqual(workflow.on.pull_request.types, [
    'opened',
    'reopened',
    'synchronize',
    'edited',
    'ready_for_review',
  ])
  assert.equal(workflow.permissions.contents, 'read')
  const steps = workflow.jobs.topology.steps
  const checkout = steps.find((step) => step.uses?.startsWith('actions/checkout@'))
  // The base commit's copy of the script judges the pull request.
  assert.equal(checkout.with.ref, '${{ github.event.pull_request.base.sha }}')
  const setup = steps.find((step) => step.uses?.startsWith('actions/setup-node@'))
  assert.equal(setup.with['node-version'], '22.22.2')
  const fork = steps.find((step) => step.name === 'Refuse a pull request from a fork')
  assert.equal(fork.env.REPOSITORY, '${{ github.repository }}')
  assert.equal(fork.env.HEAD_REPOSITORY, '${{ github.event.pull_request.head.repo.full_name }}')
  const currentVersion = steps.find((step) => step.name === 'Resolve the current version branch')
  assert.match(currentVersion.run, /git ls-remote --heads origin 'refs\/heads\/V\*'/u)
  assert.match(currentVersion.run, /sort -V \| tail -n 1/u)
  const runStep = steps.find((step) => step.name === 'Check the pull request branch pair')
  assert.equal(runStep.env.BASE, '${{ github.event.pull_request.base.ref }}')
  assert.equal(runStep.env.HEAD, '${{ github.event.pull_request.head.ref }}')
  assert.equal(runStep.env.CURRENT_VERSION, '${{ steps.current-version.outputs.version }}')
  assert.match(runStep.run, /scripts\/branch-policy\.mjs check-pr --base "\$BASE" --head "\$HEAD"/u)
  assert.match(runStep.run, /--current-version "\$CURRENT_VERSION"/u)
})
