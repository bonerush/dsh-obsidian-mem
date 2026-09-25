// Task 7: the staged gates, exercised in disposable repositories.
//
// Every case here builds its own git repository under the OS temp root and runs
// the real scripts against it with `cwd` set there. Nothing in this file reads or
// writes this checkout's git configuration — `install-hooks` is tested by pointing
// it at a fixture, never by running it here — and nothing touches a real vault or
// the real `$DSH_HOME`.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'

import { resolveBase } from '../scripts/ci-base.mjs'
import { checkStagedSources } from '../scripts/check-staged.mjs'
import { currentHooksPath, HOOKS_PATH, main as installHooks } from '../scripts/install-hooks.mjs'
import { judge, main as verifyChangelog, unreleasedSection } from '../scripts/verify-changelog.mjs'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** The changelog a fixture starts from: one Unreleased entry and one release. */
const CHANGELOG = [
  '# Changelog',
  '',
  '## Unreleased',
  '',
  '### Added',
  '',
  '- the first thing',
  '',
  '## 0.1.0',
  '',
  '### Added',
  '',
  '- the shipped thing',
  '',
].join('\n')

/** Run git in a fixture, with an identity and no inherited configuration. */
function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  })
}

/**
 * A disposable repository with one library file and a changelog.
 *
 * @param {object} t - the test context, for cleanup.
 * @returns {{root: string, lib: string, changelog: string}} fixture paths.
 */
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'obsidian-mem-gates-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'lib'), { recursive: true })
  writeFileSync(join(root, 'lib', 'x.js'), 'export const x = 1\n')
  writeFileSync(join(root, 'CHANGELOG.md'), CHANGELOG)
  writeFileSync(join(root, 'package.json'), '{ "name": "fixture", "scripts": {} }\n')
  git(root, ['init', '-q', '-b', 'main'])
  git(root, ['config', 'user.name', 'Fixture'])
  git(root, ['config', 'user.email', 'fixture@example.invalid'])
  git(root, ['config', 'commit.gpgsign', 'false'])
  git(root, ['add', '-A'])
  git(root, ['commit', '-q', '-m', 'base'])
  return { root, lib: join(root, 'lib', 'x.js'), changelog: join(root, 'CHANGELOG.md') }
}

/** Replace the changelog's Unreleased body while leaving the release section alone. */
function setUnreleased(path, body) {
  const text = readFileSync(path, 'utf8')
  writeFileSync(path, text.replace('- the first thing', body))
}

// ---------------------------------------------------------------------------
// The Unreleased gate
// ---------------------------------------------------------------------------

test('unreleasedSection reads the body, and refuses an empty one', () => {
  assert.equal(unreleasedSection(CHANGELOG), '### Added\n\n- the first thing')
  assert.equal(unreleasedSection('# Changelog\n\n## 0.1.0\n\n- only a release\n'), null)
  assert.equal(unreleasedSection('## Unreleased\n\n## 0.1.0\n'), null)
})

test('judge names the three verdicts', () => {
  assert.equal(judge({ before: 'a', after: 'a', changed: [] }).ok, true)
  assert.equal(judge({ before: 'a', after: 'a', changed: ['lib/x.js'] }).ok, false)
  assert.equal(judge({ before: 'a', after: 'b', changed: ['lib/x.js'] }).ok, true)
  assert.match(judge({ before: 'a', after: null, changed: ['lib/x.js'] }).message, /no non-empty/)
})

test('a staged lib change without an Unreleased edit fails', (t) => {
  const { root, lib } = fixture(t)
  writeFileSync(lib, 'export const x = 2\n')
  git(root, ['add', 'lib/x.js'])
  assert.equal(verifyChangelog(['--staged'], root), 1)
})

test('a staged lib change with an Unreleased edit passes', (t) => {
  const { root, lib, changelog } = fixture(t)
  writeFileSync(lib, 'export const x = 2\n')
  setUnreleased(changelog, '- the second thing')
  git(root, ['add', 'lib/x.js', 'CHANGELOG.md'])
  assert.equal(verifyChangelog(['--staged'], root), 0)
})

test('an edit to a released section does not satisfy the gate', (t) => {
  const { root, lib, changelog } = fixture(t)
  writeFileSync(lib, 'export const x = 2\n')
  writeFileSync(
    changelog,
    CHANGELOG.replace('- the shipped thing', '- the shipped thing, reworded'),
  )
  git(root, ['add', 'lib/x.js', 'CHANGELOG.md'])
  assert.equal(verifyChangelog(['--staged'], root), 1)
})

test('an Unreleased fix that is not staged cannot satisfy a staged check', (t) => {
  const { root, lib, changelog } = fixture(t)
  writeFileSync(lib, 'export const x = 2\n')
  git(root, ['add', 'lib/x.js'])
  // The working tree is honest about the change; the index is what a commit takes.
  setUnreleased(changelog, '- the second thing')
  assert.equal(verifyChangelog(['--staged'], root), 1)
  git(root, ['add', 'CHANGELOG.md'])
  assert.equal(verifyChangelog(['--staged'], root), 0)
})

test('--base compares two commits, and a bad base is an error rather than a pass', (t) => {
  const { root, lib, changelog } = fixture(t)
  const base = git(root, ['rev-parse', 'HEAD']).trim()
  writeFileSync(lib, 'export const x = 2\n')
  git(root, ['add', 'lib/x.js'])
  git(root, ['commit', '-q', '-m', 'change lib without a note'])
  assert.equal(verifyChangelog(['--base', base], root), 1)
  setUnreleased(changelog, '- the second thing')
  git(root, ['add', 'CHANGELOG.md'])
  git(root, ['commit', '-q', '-m', 'note it'])
  assert.equal(verifyChangelog(['--base', base], root), 0)
  assert.equal(verifyChangelog(['--base', 'does-not-exist'], root), 2)
  assert.equal(verifyChangelog([], root), 2)
  assert.equal(verifyChangelog(['--staged', '--base', base], root), 2)
})

// ---------------------------------------------------------------------------
// The staged source check
// ---------------------------------------------------------------------------

test('lint and format follow the index, not the working tree', (t) => {
  const { root, lib } = fixture(t)
  const binaries = {
    eslintBin: join(REPO_ROOT, 'node_modules', '.bin', 'eslint'),
    prettierBin: join(REPO_ROOT, 'node_modules', '.bin', 'prettier'),
  }
  // Staged copy valid, working tree broken: the index is what gets committed.
  writeFileSync(lib, 'export const x = 2\n')
  git(root, ['add', 'lib/x.js'])
  writeFileSync(lib, 'export const x = ;\n')
  assert.deepEqual(checkStagedSources(root, binaries).problems, [])
  // The reverse: staged copy broken, working tree fixed. It must fail, because the
  // commit would carry the broken one.
  writeFileSync(lib, 'export const x = ;\n')
  git(root, ['add', 'lib/x.js'])
  writeFileSync(lib, 'export const x = 2\n')
  const problems = checkStagedSources(root, binaries).problems
  assert.equal(problems.length > 0, true, 'a staged syntax error has to be reported')
  assert.match(problems.join('\n'), /eslint \(staged lib\/x\.js\)/)
})

// ---------------------------------------------------------------------------
// Hook installation
// ---------------------------------------------------------------------------

test('install-hooks sets core.hooksPath in the checkout it is pointed at', (t) => {
  const { root } = fixture(t)
  mkdirSync(join(root, HOOKS_PATH), { recursive: true })
  writeFileSync(join(root, HOOKS_PATH, 'pre-commit'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  assert.equal(currentHooksPath(root), '')
  assert.equal(installHooks(root), 0)
  assert.equal(currentHooksPath(root), HOOKS_PATH)
  // A directory that is not a checkout is refused rather than half-changed.
  const plain = mkdtempSync(join(tmpdir(), 'obsidian-mem-nothooks-'))
  t.after(() => rmSync(plain, { recursive: true, force: true }))
  assert.equal(installHooks(plain), 2)
})

// ---------------------------------------------------------------------------
// CI: the same gate, plus the two things only CI can supply
// ---------------------------------------------------------------------------

test('the workflow runs npm run check across the supported Node versions', () => {
  const text = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')
  const workflow = YAML.parse(text)
  assert.deepEqual(workflow.jobs.check.strategy.matrix.node, ['22.22.2', '24.x', 'node'])
  const steps = workflow.jobs.check.steps
  const commands = steps.map((step) => step.run ?? '').filter(Boolean)
  assert.equal(
    commands.some((command) => command.startsWith('npm ci')),
    true,
    'npm ci must run',
  )
  assert.equal(
    commands.some((command) => command === 'npm run check'),
    true,
  )
  assert.ok(
    commands.findIndex((command) => command.startsWith('npm ci')) <
      commands.findIndex((command) => command === 'npm run check'),
    'dependencies have to be installed before the gate runs',
  )
  // The Unreleased gate needs history and an explicit base; without fetch-depth 0
  // the base commit is simply not in the clone.
  const checkout = steps.find((step) => String(step.uses ?? '').startsWith('actions/checkout'))
  assert.equal(checkout.with['fetch-depth'], 0)
  assert.equal(
    commands.some((command) => command.includes('verify-changelog.mjs --base')),
    true,
    'CI must run the Unreleased gate with a base',
  )
  assert.equal(text.includes('pull_request.base.sha'), true)
  assert.equal(text.includes('github.event.before'), true)
  // No step may ask for a token this repository does not need.
  assert.equal(workflow.permissions?.contents, 'read')
})

test('ci-base prefers the event SHA and refuses to guess', (t) => {
  const { root, lib } = fixture(t)
  const first = git(root, ['rev-parse', 'HEAD']).trim()
  writeFileSync(lib, 'export const x = 2\n')
  git(root, ['add', '-A'])
  git(root, ['commit', '-q', '-m', 'second'])
  const second = git(root, ['rev-parse', 'HEAD']).trim()
  assert.deepEqual(resolveBase({ PR_BASE: first }, root), {
    sha: first,
    reason: 'the pull request base from the event',
  })
  assert.deepEqual(resolveBase({ BEFORE: first }, root), {
    sha: first,
    reason: 'the previous head from the event',
  })
  assert.equal(
    resolveBase({ PR_BASE: second, BEFORE: first }, root).sha,
    second,
    'the PR base wins',
  )
  // An all-zero 'before' is GitHub saying the ref did not exist; it must not be used.
  const zeros = resolveBase({ BEFORE: '0'.repeat(40), DEFAULT_BRANCH: 'main' }, root)
  assert.equal(zeros.sha, null, 'an all-zero before must fall through, not be compared against')
  // A base that is not a commit here is an error, never an empty diff.
  const bogus = resolveBase({ PR_BASE: 'f'.repeat(40) }, root)
  assert.equal(bogus.sha, null)
  assert.match(bogus.reason, /not a commit/)
})

test('ci-base refuses a base that equals HEAD', (t) => {
  const { root } = fixture(t)
  // On a branch named main with no origin, the merge base with main is HEAD itself.
  git(root, ['branch', '-M', 'main'])
  const verdict = resolveBase({ DEFAULT_BRANCH: 'main' }, root)
  assert.equal(verdict.sha, null)
  assert.match(verdict.reason, /nothing to compare|no event base/)
})
