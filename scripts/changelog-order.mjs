#!/usr/bin/env node
// Changelog section placement (Task 7's gate, extended for releases).
//
// The release workflow used to insert each new section directly after
// `## Unreleased`, which is correct only while releases are published in the
// order they were written. They were not: `v0.1.1` was tagged by hand after
// `v0.1.2` had already shipped, and because `0.1.2` had been inserted at the top
// the file then read 0.1.3, 0.1.1, 0.1.2, 0.1.0. Sections out of order are a
// reader-facing defect — the file claims a sequence the numbers do not have — and
// remembering to fix it by hand is not a mechanism.
//
// The module both fixes an existing file and performs the insertion the workflow
// needs, so the same rule governs both. It never edits anything on import.
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

/** The heading whose body is the next release. */
export const UNRELEASED = '## Unreleased'

/** A release heading: `## 1.2.3 — 2026-09-29`, or `## 1.2.3` in a fixture. */
const RELEASE = /^## (\d+\.\d+\.\d+)(?:\s+—\s+\d{4}-\d{2}-\d{2})?\s*$/

/**
 * Compare two dotted version strings by number, not by text.
 *
 * `"0.1.10"` is newer than `"0.1.9"`, which a string sort gets backwards.
 *
 * @param {string} a - one version.
 * @param {string} b - the other.
 * @returns {number} negative when `a` is older, positive when newer, 0 when equal.
 */
export function compareVersions(a, b) {
  const left = a.split('.').map(Number)
  const right = b.split('.').map(Number)
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index]
  }
  return 0
}

/**
 * The changelog split into its preamble, its `## Unreleased` body and its
 * release sections, in the order they appear.
 *
 * @param {string} text - the changelog's contents.
 * @returns {{preamble: string[], unreleased: string[], releases: {version: string, lines: string[]}[]}|null} the parts, or null when there is no `## Unreleased`.
 */
export function parseChangelog(text) {
  const lines = text.split('\n')
  const start = lines.findIndex((line) => line.trim() === UNRELEASED)
  if (start === -1) return null
  const rest = lines.slice(start + 1)
  const unreleasedEnd = rest.findIndex((line) => /^## /.test(line))
  const unreleased = unreleasedEnd === -1 ? rest : rest.slice(0, unreleasedEnd)
  const body = unreleasedEnd === -1 ? [] : rest.slice(unreleasedEnd)

  const releases = []
  let current = null
  for (const line of body) {
    const match = RELEASE.exec(line)
    if (match !== null) {
      current = { version: match[1], lines: [line] }
      releases.push(current)
      continue
    }
    if (current !== null) current.lines.push(line)
  }
  return { preamble: lines.slice(0, start), unreleased, releases }
}

/**
 * Whether the release sections run from newest to oldest.
 *
 * @param {{version: string}[]} releases - the sections, in file order.
 * @returns {boolean} true when every section is older than the one before it.
 */
export function isDescending(releases) {
  for (let index = 1; index < releases.length; index += 1) {
    if (compareVersions(releases[index - 1].version, releases[index].version) <= 0) return false
  }
  return true
}

/** A `###` subsection heading inside one version section. */
const SUBSECTION = /^### (\S.*?)\s*$/

/**
 * Every `###` heading that appears twice inside one version section.
 *
 * This is the failure a release-order check cannot see, and it happened here: an
 * entry appended with its own `### Added` while the section already had one left two
 * headings of the same name, and the entries written before the second one were
 * silently re-labelled — the Fixed notes of an earlier change ended up filed under
 * Added. The file parsed, the versions stayed in order, and nothing complained.
 *
 * `main` applies this to `## Unreleased` only, and that scoping is deliberate: the
 * released sections are history and one of them (`0.1.1`) legitimately carries more
 * than one `### Changed`, which is not this gate's to rewrite. Editing happens in
 * Unreleased, and a release cut moves that body verbatim, so a clean Unreleased is
 * what keeps the next release clean.
 *
 * @param {string} text - the changelog's contents.
 * @returns {{section: string, heading: string}[]} the duplicates, in file order.
 */
export function duplicateSubsections(text) {
  const parsed = parseChangelog(text)
  if (parsed === null) return []
  const sections = [
    { name: UNRELEASED, lines: parsed.unreleased },
    ...parsed.releases.map((release) => ({ name: '## ' + release.version, lines: release.lines })),
  ]
  const found = []
  for (const section of sections) {
    const seen = new Set()
    for (const line of section.lines) {
      const match = SUBSECTION.exec(line)
      if (match === null) continue
      if (seen.has(match[1])) found.push({ section: section.name, heading: match[1] })
      seen.add(match[1])
    }
  }
  return found
}

/**
 * Build the changelog for one new release.
 *
 * The `## Unreleased` body moves under the new version, and the new section is
 * placed by version rather than at the top, so a hand-tagged release that arrives
 * late still lands in numeric order.
 *
 * @param {string} text - the changelog's contents.
 * @param {string} version - the version being released.
 * @param {string} date - the release date, `YYYY-MM-DD`.
 * @returns {string} the new contents.
 * @throws {Error} when there is no `## Unreleased` section or it is empty.
 */
export function cutRelease(text, version, date) {
  const parsed = parseChangelog(text)
  if (parsed === null) throw new Error('CHANGELOG.md has no ' + UNRELEASED + ' section')
  const body = parsed.unreleased.join('\n').trim()
  if (body === '') {
    throw new Error('the ' + UNRELEASED + ' section is empty; nothing to release')
  }
  if (parsed.releases.some((release) => release.version === version)) {
    throw new Error('CHANGELOG.md already has a section for ' + version)
  }
  const section = ['## ' + version + ' — ' + date, '', body, '']
  const release = { version, lines: section }
  const ordered = [...parsed.releases, release].sort((a, b) =>
    compareVersions(b.version, a.version),
  )
  const out = [...parsed.preamble, UNRELEASED, '', ...ordered.flatMap((entry) => entry.lines)]
  const result = out.join('\n')
  // Parsed before it is returned: a mangled changelog must not be written out.
  const check = parseChangelog(result)
  if (check === null || check.releases.length !== parsed.releases.length + 1) {
    throw new Error('refusing to write a changelog this module cannot parse back')
  }
  return result.endsWith('\n') ? result : result + '\n'
}

/**
 * Rewrite the changelog at `path` so its release sections run newest-first.
 *
 * @param {string} path - the changelog path.
 * @returns {{changed: boolean, before: string[], after: string[]}} what was seen and written.
 */
export function reorderFile(path) {
  const text = readFileSync(path, 'utf8')
  const parsed = parseChangelog(text)
  if (parsed === null) return { changed: false, before: [], after: [] }
  const before = parsed.releases.map((release) => release.version)
  if (isDescending(parsed.releases)) return { changed: false, before, after: before }
  const ordered = [...parsed.releases].sort((a, b) => compareVersions(b.version, a.version))
  const after = ordered.map((release) => release.version)
  const out = [
    ...parsed.preamble,
    UNRELEASED,
    '',
    ...ordered.flatMap((release) => release.lines),
  ].join('\n')
  const check = parseChangelog(out)
  if (check === null || check.releases.length !== parsed.releases.length) {
    throw new Error('refusing to write a changelog this module cannot parse back')
  }
  writeFileSync(path, out.endsWith('\n') ? out : out + '\n')
  return { changed: true, before, after }
}

/**
 * Run the ordering check, the rewrite (`--fix`), or one release cut
 * (`--cut <version> <date>`), which is what the release workflow calls.
 *
 * @param {string[]} [argv] - arguments after the script name.
 * @param {string} [cwd] - repository root.
 * @returns {number} 0 on success, 1 when the check fails, 2 on a usage error.
 */
export function main(argv = process.argv.slice(2), cwd = process.cwd()) {
  let fix = false
  let cut = null
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--fix') fix = true
    else if (argument === '--cut') {
      cut = { version: argv[index + 1], date: argv[index + 2] }
      index += 2
    } else {
      process.stderr.write(
        'verify-changelog-order: unknown argument ' +
          JSON.stringify(argument) +
          '; usage: verify-changelog-order.mjs [--fix] | --cut <version> <date>\n',
      )
      return 2
    }
  }
  const path = cwd + '/CHANGELOG.md'
  if (cut !== null) {
    if (typeof cut.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(cut.version)) {
      process.stderr.write('verify-changelog-order: --cut needs a version like 1.2.3\n')
      return 2
    }
    if (typeof cut.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(cut.date)) {
      process.stderr.write('verify-changelog-order: --cut needs a date like 2026-09-29\n')
      return 2
    }
    const text = readFileSync(path, 'utf8')
    let next
    try {
      next = cutRelease(text, cut.version, cut.date)
    } catch (error) {
      process.stderr.write('verify-changelog-order: ' + error.message + '\n')
      return 1
    }
    writeFileSync(path, next)
    process.stdout.write(
      'verify-changelog-order: cut ' +
        cut.version +
        ' and ordered ' +
        parseChangelog(next)
          .releases.map((release) => release.version)
          .join(', ') +
        '\n',
    )
    return 0
  }
  const text = readFileSync(path, 'utf8')
  const parsed = parseChangelog(text)
  if (parsed === null) {
    process.stderr.write('verify-changelog-order: CHANGELOG.md has no ' + UNRELEASED + ' section\n')
    return 1
  }
  const duplicates = duplicateSubsections(text).filter((entry) => entry.section === UNRELEASED)
  if (duplicates.length > 0) {
    process.stderr.write(
      'verify-changelog-order: FAIL — duplicate subsection heading(s) in ' +
        UNRELEASED +
        ': ' +
        duplicates.map((entry) => entry.heading).join(', ') +
        '; one section, one ### Added/### Fixed/… each\n',
    )
    return 1
  }
  if (isDescending(parsed.releases)) {
    process.stdout.write(
      'verify-changelog-order: OK — ' +
        parsed.releases.map((release) => release.version).join(', ') +
        '\n',
    )
    return 0
  }
  if (!fix) {
    process.stderr.write(
      'verify-changelog-order: FAIL — release sections are not newest-first: ' +
        parsed.releases.map((release) => release.version).join(', ') +
        '\n',
    )
    return 1
  }
  const result = reorderFile(path)
  process.stdout.write(
    'verify-changelog-order: reordered ' +
      result.before.join(', ') +
      ' -> ' +
      result.after.join(', ') +
      '\n',
  )
  return 0
}

const isEntry =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isEntry) process.exitCode = main()
