import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { parse } from 'yaml'

const workflow = parse(
  readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'),
)
const extractors = workflow.jobs.release.steps.flatMap((step) => {
  if (typeof step.run !== 'string') return []
  return [...step.run.matchAll(/node -e '([^']*)' CHANGELOG\.md "\$(?:version|next)"/g)].map(
    (match) => ({ name: step.name, source: match[1] }),
  )
})

test('both release branches have a release-notes extractor', () => {
  assert.equal(extractors.length, 2)
})

for (const extractor of extractors) {
  test(`${extractor.name}: notes go to stdout and leave the packed changelog intact`, (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'release-notes-'))
    t.after(() => rmSync(directory, { recursive: true, force: true }))
    const changelog = [
      '# Changelog',
      '',
      '## Unreleased',
      '',
      '## 0.1.14 — 2026-10-12',
      '',
      '### Added',
      '',
      '- Habits come from memory distillation.',
      '',
      '## 0.1.13 — 2026-10-10',
      '',
      '### Fixed',
      '',
      '- An earlier fix.',
      '',
    ].join('\n')
    const file = join(directory, 'CHANGELOG.md')
    writeFileSync(file, changelog)
    // Execute the inline program that the workflow runs, so a passing helper
    // cannot hide a workflow that still writes over the file npm packs.
    const result = spawnSync(process.execPath, ['-e', extractor.source, file, '0.1.14'], {
      cwd: directory,
      encoding: 'utf8',
    })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, '### Added\n\n- Habits come from memory distillation.\n')
    assert.equal(readFileSync(file, 'utf8'), changelog)
  })
}
