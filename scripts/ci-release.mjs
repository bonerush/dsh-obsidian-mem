#!/usr/bin/env node
// Decide whether one push into CI is a release push.
//
// The Unreleased gate wants a `lib/` change paired with a new `## Unreleased`
// entry. A release push is the one exception: it *consumes* the body, moving it
// under the new version heading, so `verify-changelog` would otherwise fail the
// very release it is shipping.
//
// The first version of the exemption keyed on the commit message
// (`chore(release):`). That covers the bump commit `release.yml` writes itself,
// but not the branch model's release: merging `Vx` into `main` with `--no-ff`
// produces git's default merge message, and the bootstrap release adds no commit
// of its own. Measured on the 2.1.0 release (2026-11-07): `main` went red on all
// five check legs for a release that had already been tagged successfully.
//
// This decides from repository state instead of commit text, so the shape of the
// push stops mattering: the declared version at HEAD differs from the base AND
// `CHANGELOG.md` carries a section for the version HEAD declares. A version bump
// without the section is *not* a release, so a forgotten changelog still reaches
// the gate, and every other push and pull request keeps running it.
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

/** Run git and throw a message that names the failure rather than a bare status. */
function git(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
  } catch (error) {
    const detail = String(error.stderr ?? error.message ?? '').trim()
    throw new Error('git ' + args.join(' ') + ' failed' + (detail === '' ? '' : ': ' + detail), {
      cause: error,
    })
  }
}

/**
 * The `version` one revision declares, or a thrown error when it declares none.
 *
 * @param {string} ref - a revision to read `package.json` from.
 * @param {string} [cwd] - repository root.
 * @returns {string} the declared version.
 */
export function versionAt(ref, cwd = process.cwd()) {
  const text = git(['show', ref + ':package.json'], cwd)
  let manifest
  try {
    manifest = JSON.parse(text)
  } catch (error) {
    throw new Error('package.json at ' + ref + ' is not JSON', { cause: error })
  }
  const version = manifest?.version
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error('package.json at ' + ref + ' has no version string')
  }
  return version
}

/**
 * Whether a changelog carries a release section for one version.
 *
 * Matches the heading `cutRelease` writes (`## 1.0.0 — 2026-01-01`) without
 * matching a version that merely shares a prefix — the space after the number is
 * part of the anchor.
 *
 * @param {string} changelog - the changelog contents.
 * @param {string} version - the version whose section is looked for.
 * @returns {boolean} true when the section heading exists.
 */
export function hasReleaseSection(changelog, version) {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  return new RegExp('^## ' + escaped + ' ', 'mu').test(changelog)
}

/**
 * Decide whether the push from `base` to HEAD is a release push.
 *
 * @param {string} base - the comparison base CI already resolved.
 * @param {string} [cwd] - repository root.
 * @returns {{release: boolean, reason: string}} the verdict.
 */
export function isReleasePush(base, cwd = process.cwd()) {
  const baseVersion = versionAt(base, cwd)
  const headVersion = versionAt('HEAD', cwd)
  if (baseVersion === headVersion) {
    return {
      release: false,
      reason: 'the declared version did not change (' + headVersion + ')',
    }
  }
  const changelog = git(['show', 'HEAD:CHANGELOG.md'], cwd)
  if (!hasReleaseSection(changelog, headVersion)) {
    return {
      release: false,
      reason:
        'the declared version changed ' +
        baseVersion +
        ' -> ' +
        headVersion +
        ' but CHANGELOG.md has no section for it',
    }
  }
  return {
    release: true,
    reason:
      'the declared version changed ' +
      baseVersion +
      ' -> ' +
      headVersion +
      ' and CHANGELOG.md carries its release section',
  }
}

/** Parse exactly one `--base <ref>` or `--base=<ref>`. */
function parseArgs(argv) {
  let base = null
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--base') {
      base = argv[index + 1]
      index += 1
    } else if (argument.startsWith('--base=')) base = argument.slice('--base='.length)
    else
      throw new Error(
        'unknown argument ' + JSON.stringify(argument) + '; usage: ci-release.mjs --base <ref>',
      )
  }
  if (base === undefined || base === null || base === '') {
    throw new Error('pass exactly one --base <ref>; a detector with no base would guess')
  }
  return base
}

/**
 * Print `true` or `false` for the push `--base` names.
 *
 * Throws nothing on a verdict, and exits 2 on a usage or git failure: the caller
 * must not read "I could not tell" as "not a release" and exempt the gate by
 * accident.
 *
 * @param {string[]} [argv] - arguments after the script name.
 * @param {string} [cwd] - repository root.
 * @returns {number} 0 with the verdict on stdout, or 2 on a usage or git failure.
 */
export function main(argv = process.argv.slice(2), cwd = process.cwd()) {
  let base
  try {
    base = parseArgs(argv)
  } catch (error) {
    process.stderr.write('ci-release: ' + error.message + '\n')
    return 2
  }
  try {
    const verdict = isReleasePush(base, cwd)
    process.stdout.write((verdict.release ? 'true' : 'false') + '\n')
    process.stderr.write('ci-release: ' + verdict.reason + '\n')
    return 0
  } catch (error) {
    process.stderr.write('ci-release: ' + error.message + '\n')
    return 2
  }
}

const isEntry =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isEntry) process.exitCode = main()
