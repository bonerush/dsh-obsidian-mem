#!/usr/bin/env node
// The Unreleased gate (Task 7).
//
// AGENTS.md rule 6 says a claim needs evidence and the changelog has to stay
// honest, but nothing enforced the "someone wrote it down" half. This makes that
// half mechanical: a change under `lib/` needs a matching change inside
// `## Unreleased`, and a change to an already-released section does not count —
// the released prose describes what shipped, not what is about to.
//
// It is deliberately *not* part of `npm run check`: it needs a comparison base,
// and a check with no base would pass vacuously on a clean tree, which is worse
// than no check. It runs from the pre-commit hook in `--staged` mode and from CI
// with an explicit `--base`.
//
// It never edits anything. Missing refs or files are errors rather than empty
// successes, because "I could not compare" and "nothing to compare" must not look
// the same to a reader of a green build.
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

/** The heading whose body has to move. */
const UNRELEASED = '## Unreleased'

/**
 * Run git and return stdout, throwing a message that names the failure.
 *
 * @param {string[]} args - git arguments.
 * @param {string} cwd - repository root.
 * @returns {string} stdout.
 */
function git(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  } catch (error) {
    const detail = (error.stderr ?? '').trim() || error.message
    throw new Error('git ' + args.join(' ') + ' failed: ' + detail, { cause: error })
  }
}

/**
 * The `## Unreleased` body of one changelog, or null when there is none.
 *
 * @param {string} text - the changelog's contents.
 * @returns {string|null} the section body, trimmed.
 */
export function unreleasedSection(text) {
  const lines = text.split('\n')
  const start = lines.findIndex((line) => line.trim() === UNRELEASED)
  if (start === -1) return null
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => /^## /.test(line))
  const body = (end === -1 ? rest : rest.slice(0, end)).join('\n').trim()
  return body === '' ? null : body
}

/**
 * Repository-relative paths changed between two revisions, limited to `lib/`.
 *
 * @param {string} cwd - repository root.
 * @param {string[]} args - the revision arguments for `git diff --name-only`.
 * @returns {string[]} changed paths under `lib/`.
 */
function changedLibFiles(cwd, args) {
  const out = git(['diff', '--name-only', '-z', ...args, '--', 'lib/'], cwd)
  return out.split('\0').filter(Boolean)
}

/**
 * Decide whether one comparison satisfies the gate.
 *
 * @param {{before: string|null, after: string|null, changed: string[]}} comparison - the two changelog states and the changed paths.
 * @returns {{ok: boolean, message: string}} the verdict.
 */
export function judge({ before, after, changed }) {
  if (changed.length === 0) {
    return { ok: true, message: 'no files under lib/ changed in this comparison' }
  }
  if (after === null) {
    return { ok: false, message: 'CHANGELOG.md has no non-empty ' + UNRELEASED + ' section' }
  }
  if (after === before) {
    return {
      ok: false,
      message:
        'lib/ changed (' +
        changed.slice(0, 5).join(', ') +
        (changed.length > 5 ? ', …' : '') +
        ') but ' +
        UNRELEASED +
        ' did not: add or amend an entry there, or say in the commit message why none is owed',
    }
  }
  return { ok: true, message: 'lib/ changed and ' + UNRELEASED + ' moved with it' }
}

/** Parse `--staged` or `--base <ref>`; the two are mutually exclusive. */
function parseArgs(argv) {
  let staged = false
  let base = null
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--staged') staged = true
    else if (argument === '--base') {
      base = argv[index + 1]
      index += 1
    } else if (argument.startsWith('--base=')) base = argument.slice('--base='.length)
    else
      throw new Error(
        'unknown argument ' +
          JSON.stringify(argument) +
          '; usage: verify-changelog.mjs --staged | --base <ref>',
      )
  }
  if (staged === (base !== null)) {
    throw new Error(
      'pass exactly one of --staged or --base <ref>; a check with no base passes vacuously',
    )
  }
  return { staged, base }
}

/**
 * Run the gate.
 *
 * @param {string[]} [argv] - arguments after the script name.
 * @param {string} [cwd] - repository root.
 * @returns {number} 0 when satisfied, 1 when not, 2 on a usage or git failure.
 */
export function main(argv = process.argv.slice(2), cwd = process.cwd()) {
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    process.stderr.write('verify-changelog: ' + error.message + '\n')
    return 2
  }
  try {
    let changed
    let before
    let after
    if (options.staged) {
      changed = changedLibFiles(cwd, ['--cached', 'HEAD'])
      before = git(['show', 'HEAD:CHANGELOG.md'], cwd)
      after = git(['show', ':CHANGELOG.md'], cwd)
    } else {
      const ref = options.base
      git(['rev-parse', '--verify', ref + '^{commit}'], cwd)
      changed = changedLibFiles(cwd, [ref, 'HEAD'])
      before = git(['show', ref + ':CHANGELOG.md'], cwd)
      after = git(['show', 'HEAD:CHANGELOG.md'], cwd)
    }
    const verdict = judge({
      before: unreleasedSection(before),
      after: unreleasedSection(after),
      changed,
    })
    process.stdout.write(
      'verify-changelog: ' + (verdict.ok ? 'OK' : 'FAIL') + ' — ' + verdict.message + '\n',
    )
    return verdict.ok ? 0 : 1
  } catch (error) {
    process.stderr.write('verify-changelog: ' + error.message + '\n')
    return 2
  }
}

const isEntry =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isEntry) process.exitCode = main()
