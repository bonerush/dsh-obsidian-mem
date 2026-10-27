// Opt-in, read-only source snapshot acceptance. Never pass a real vault to lib/.
import { execFileSync } from 'node:child_process'
import { constants } from 'node:fs'
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const hash = (value) => createHash('sha256').update(value).digest('hex')
const points = (value) => [...value].length
const check = (condition, label) => {
  if (!condition) {
    const error = new Error(label)
    error.code = label
    throw error
  }
}
const { values } = parseArgs({
  options: {
    'source-vault': { type: 'string' },
    baseline: { type: 'string', default: 'main' },
    'warm-runs': { type: 'string', default: '3' },
  },
})
const repo = process.cwd()
const warmRuns = Number(values['warm-runs'])
let stage = 'arguments'
let scratch
let sourceBefore
let sourceAfter
let sourceInputs

// Reject links in every source ancestor, not just links found by the tree walk.
async function noLinks(path) {
  const absolute = resolve(path)
  let cursor = parse(absolute).root
  for (const segment of relative(cursor, absolute).split('/').filter(Boolean)) {
    cursor = join(cursor, segment)
    check(!(await lstat(cursor)).isSymbolicLink(), 'source-symlink-refused')
  }
}

async function bytesWithoutLink(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    check((await file.stat()).isFile(), 'source-file-required')
    return await file.readFile()
  } finally {
    await file.close()
  }
}

// Paths remain in memory only. Reports contain an aggregate hash, never names.
async function manifest(inputs) {
  const entries = []
  let skippedLinks = 0
  async function walk(path, key) {
    const stat = await lstat(path)
    if (stat.isSymbolicLink()) {
      skippedLinks += 1
      entries.push({ key, kind: 'symlink' })
    } else if (stat.isDirectory()) {
      for (const name of (await readdir(path)).sort())
        await walk(join(path, name), key + '/' + name)
    } else if (stat.isFile()) {
      const bytes = await bytesWithoutLink(path)
      entries.push({ key, kind: 'file', bytes: bytes.length, hash: hash(bytes), path, stat })
    }
  }
  for (const input of inputs) await walk(input.path, input.key)
  const digest = hash(
    JSON.stringify(
      entries.map(({ key, kind, bytes, hash: digest }) => ({ key, kind, bytes, digest })),
    ),
  )
  return {
    entries,
    summary: {
      files: entries.filter((entry) => entry.kind === 'file').length,
      bytes: entries.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0),
      skippedLinks,
      sha256: digest,
    },
  }
}

async function copyManifest(source, destination) {
  for (const entry of source.entries) {
    if (entry.kind !== 'file') continue
    const bytes = await bytesWithoutLink(entry.path)
    check(hash(bytes) === entry.hash, 'source-changed-during-copy')
    const target = join(destination, entry.key)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, bytes, { mode: 0o600 })
    await utimes(target, entry.stat.atime, entry.stat.mtime)
  }
}

function countsBy(notes, key, allowed) {
  const counts = {}
  for (const note of notes) {
    const value = allowed.includes(note.data?.[key]) ? note.data[key] : 'other-or-missing'
    counts[value] = (counts[value] ?? 0) + 1
  }
  return counts
}

async function oracle(code, vault, binding) {
  const { parseNote } = await import(pathToFileURL(join(code, 'lib/frontmatter.js')))
  const { locateGeneratedBlock } = await import(pathToFileURL(join(code, 'lib/routing.js')))
  const { isAutomaticallyEligible } = await import(pathToFileURL(join(code, 'lib/note-health.js')))
  const notes = []
  async function walk(path, key) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.isDirectory()) await walk(join(path, entry.name), key + '/' + entry.name)
      else if (entry.isFile() && entry.name.endsWith('.md')) {
        let parsed
        try {
          parsed = parseNote(await readFile(join(path, entry.name)))
        } catch {
          parsed = { data: null }
        }
        notes.push({ path: key + '/' + entry.name, data: parsed.data })
      }
    }
  }
  await walk(join(vault, binding.relativeDir), binding.relativeDir)
  const byPath = new Map(notes.map((note) => [note.path, note]))
  const mocText = await readFile(join(vault, binding.relativeDir, 'Conventions/index.md'), 'utf8')
  const generated = locateGeneratedBlock(mocText)
  const moc = generated?.body ?? parseNote(mocText).body
  const all = []
  const excluded = { superseded: 0, archived: 0, provisional: 0 }
  let missingTargets = 0
  for (const raw of moc.split(/\r?\n/u)) {
    const line = raw
      .replace(/<!--.*?-->/gu, '')
      .trim()
      .replace(/^[-*+]\s+/u, '')
    if (!line.includes('[[')) continue
    check(
      (line.match(/\[\[/gu) ?? []).length === (line.match(/\]\]/gu) ?? []).length,
      'moc-unbalanced',
    )
    const match = /\[\[([^\]]+)\]\]/u.exec(line)
    check(match !== null, 'moc-link-required')
    const target = match[1].split('|')[0].split('#')[0].trim().replace(/\.md$/u, '') + '.md'
    const note = byPath.get(target)
    if (!note) missingTargets += 1
    const status = note?.data?.status
    if (!isAutomaticallyEligible(status)) excluded[status] += 1
    else all.push('- ' + line)
  }
  const recent = notes
    .filter((note) => /\/(Decisions|Pitfalls)\/[^/]+\.md$/u.test(note.path))
    .filter(
      (note) =>
        !note.path.endsWith('/index.md') && note.data && isAutomaticallyEligible(note.data.status),
    )
    .sort((a, b) => {
      const left = typeof a.data.updated === 'string' ? a.data.updated : null
      const right = typeof b.data.updated === 'string' ? b.data.updated : null
      if (left !== right) return left === null ? 1 : right === null ? -1 : left < right ? 1 : -1
      return a.path < b.path ? -1 : a.path > b.path ? 1 : 0
    })
    .slice(0, 5)
  return {
    all,
    recent,
    summary: {
      projectMarkdownFiles: notes.length,
      byType: countsBy(notes, 'type', [
        'convention',
        'decision',
        'gotcha',
        'hub',
        'doc',
        'session-log',
        'hot',
        'glossary',
        'method',
      ]),
      byStatus: countsBy(notes, 'status', ['active', 'superseded', 'archived', 'provisional']),
      conventions: {
        mocLines: all.length + Object.values(excluded).reduce((a, b) => a + b, 0),
        eligible: all.length,
        excluded,
        missingTargets,
      },
      recentEligibleTopFive: recent.length,
    },
  }
}

function renderedSection(text, heading) {
  const block = text.split('\n## ').find((part) => part.startsWith(heading))
  return block?.split('\n').filter((line) => line.startsWith('> - ') || line.startsWith('- ')) ?? []
}

async function measure(label, code, snapshot, binding, expected) {
  const { openIndex } = await import(pathToFileURL(join(code, 'lib/index-db.js')))
  const { buildBrief, pageBrief } = await import(pathToFileURL(join(code, 'lib/brief.js')))
  const home = join(scratch, label + '-home')
  const dataRoot = join(scratch, label + '-data')
  await mkdir(home)
  await mkdir(dataRoot)
  const config = { briefBudgetChars: 6000, hotCapacityChars: 9000 }
  const startIndex = performance.now()
  const index = await openIndex({
    vaultRoot: snapshot,
    dataRoot,
    home,
    backend: 'sqlite',
    projectId: binding.projectId,
  })
  try {
    check((await index.waitReady(undefined, 120_000)).ready, 'cold-index-not-ready')
    const indexMs = performance.now() - startIndex
    const indexedNotes = index.status().notes
    const elapsed = []
    let first
    let firstTextHash
    for (let i = 0; i <= warmRuns; i += 1) {
      const started = performance.now()
      const brief = await buildBrief(
        { ...binding, vaultRoot: snapshot },
        { index, config, home, mode: 'full' },
      )
      elapsed.push(+(performance.now() - started).toFixed(3))
      check(
        brief.charCount === points(brief.text) && brief.charCount <= 6000,
        'brief-budget-invariant',
      )
      check(brief.indexState.status === 'ready', 'brief-index-not-ready')
      const textHash = hash(brief.text)
      if (i === 0) {
        first = brief
        firstTextHash = textHash
      } else check(textHash === firstTextHash, 'warm-brief-changed')
    }
    const convShown = renderedSection(first.text, '约定').length
    const recentShown = renderedSection(first.text, '最近决策').length
    const result = {
      coldIndexMs: +indexMs.toFixed(3),
      firstBriefMs: elapsed[0],
      warmBriefMs: elapsed.slice(1),
      warmMedianMs: [...elapsed.slice(1)].sort((a, b) => a - b)[Math.floor(warmRuns / 2)],
      indexedSnapshotNotes: indexedNotes,
      briefChars: first.charCount,
      budget: 6000,
      hotCapacity: 9000,
      truncated: first.truncated,
      omitted: first.omitted,
      conventionsShown: convShown,
      conventionsEligible: expected.all.length,
      conventionsShownRate: +(convShown / Math.max(1, expected.all.length)).toFixed(6),
      recentShown,
      recentEligible: expected.recent.length,
      coverage: first.coverage ?? null,
    }
    if (typeof pageBrief === 'function') {
      const lines = []
      const pageSizes = []
      let offset = 0
      const started = performance.now()
      for (;;) {
        const page = await pageBrief(
          { ...binding, vaultRoot: snapshot },
          { section: 'conventions', offset, limit: 7, index, config, home },
        )
        check(page.total === expected.all.length, 'conventions-page-total')
        check(page.charCount <= 8000, 'page-budget')
        lines.push(...page.lines)
        pageSizes.push(page.lines.length)
        if (!page.hasMore) break
        check(page.nextOffset > offset, 'page-no-progress')
        offset = page.nextOffset
      }
      check(
        hash(JSON.stringify(lines)) === hash(JSON.stringify(expected.all)),
        'conventions-page-source-mismatch',
      )
      check(new Set(lines).size === lines.length, 'duplicate-convention-page-lines')
      const recentPage = await pageBrief(
        { ...binding, vaultRoot: snapshot },
        { section: 'recent', offset: 0, limit: 50, index, config, home },
      )
      check(recentPage.total === expected.recent.length, 'recent-page-total')
      check(
        expected.recent.every((note, i) =>
          recentPage.lines[i]?.includes('[[' + note.path.replace(/\.md$/u, '') + '|'),
        ),
        'recent-page-source-mismatch',
      )
      for (const section of first.coverage.sections) {
        check(section.considered === section.shown + section.omitted, 'section-coverage-invariant')
      }
      check(
        first.coverage.considered === first.coverage.shown + first.coverage.omitted,
        'total-coverage-invariant',
      )
      const conv = first.coverage.sections.find((section) => section.key === 'conventions')
      check(
        conv.considered === expected.all.length && conv.shown === convShown,
        'conventions-coverage-invariant',
      )
      result.paging = {
        sourceExact: true,
        unique: lines.length,
        pageSizes,
        elapsedMs: +(performance.now() - started).toFixed(3),
        recentSourceExact: true,
      }
    } else result.paging = { supported: false }
    return result
  } finally {
    await index.close()
  }
}

try {
  check(
    values['source-vault'] && isAbsolute(values['source-vault']),
    'explicit-absolute-source-vault-required',
  )
  check(
    Number.isSafeInteger(warmRuns) && warmRuns >= 3 && warmRuns <= 20,
    'warm-runs-between-3-and-20',
  )
  const source = resolve(values['source-vault'])
  stage = 'source-discovery'
  await noLinks(source)
  await noLinks(join(repo, '.obsidian-mem'))
  const pointer = JSON.parse(await bytesWithoutLink(join(repo, '.obsidian-mem')))
  check(/^[0-9a-f-]{36}$/u.test(pointer.projectId), 'pointer-project-id')
  const candidates = (await readdir(join(source, 'Projects'))).filter((name) =>
    name.endsWith('--' + pointer.projectId.slice(0, 8)),
  )
  check(candidates.length === 1, 'unique-bound-project-required')
  const relativeDir = 'Projects/' + candidates[0]
  await noLinks(join(source, relativeDir))
  const binding = { ...pointer, kind: 'bound', relativeDir }
  sourceInputs = [{ key: relativeDir, path: join(source, relativeDir) }]
  for (const key of ['.mem-root.md', '_meta/registry.md', '_meta/user.md']) {
    const path = join(source, key)
    if (
      await lstat(path).catch((error) => (error.code === 'ENOENT' ? null : Promise.reject(error)))
    ) {
      await noLinks(path)
      sourceInputs.push({ key, path })
    }
  }
  sourceInputs.push({ key: 'repository-pointer', path: join(repo, '.obsidian-mem') })
  sourceBefore = await manifest(sourceInputs)
  scratch = await mkdtemp(join(tmpdir(), 'obsidian-mem-coverage-snapshot-'))
  const master = join(scratch, 'master')
  await mkdir(master)
  await copyManifest(sourceBefore, master)
  stage = 'code-export'
  const baselineRef = execFileSync('git', ['rev-parse', values.baseline], {
    cwd: repo,
    encoding: 'utf8',
  }).trim()
  const currentRef = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repo,
    encoding: 'utf8',
  }).trim()
  const baselineCode = join(scratch, 'baseline-code')
  const currentCode = join(scratch, 'current-code')
  await mkdir(baselineCode)
  await mkdir(currentCode)
  const archive = execFileSync('git', ['archive', baselineRef, 'lib', 'package.json'], {
    cwd: repo,
    maxBuffer: 32 * 1024 * 1024,
  })
  execFileSync('tar', ['-xf', '-', '-C', baselineCode], { input: archive })
  await cp(join(repo, 'lib'), join(currentCode, 'lib'), { recursive: true, dereference: false })
  await cp(join(repo, 'package.json'), join(currentCode, 'package.json'))
  // Only dependencies are shared read-only; source vault links are always refused.
  for (const code of [baselineCode, currentCode])
    await symlink(join(repo, 'node_modules'), join(code, 'node_modules'), 'dir')
  const currentCodeFingerprint = (await manifest([{ key: 'lib', path: join(currentCode, 'lib') }]))
    .summary.sha256
  const { parseRegistryMarkdown } = await import(
    pathToFileURL(join(currentCode, 'lib/registry.js'))
  )
  const registry = parseRegistryMarkdown(await readFile(join(master, '_meta/registry.md'), 'utf8'))
  check(
    registry.rows.some((row) => row.projectId === pointer.projectId && row.dir === relativeDir),
    'snapshot-registry-binding-mismatch',
  )
  const expected = await oracle(currentCode, master, binding)
  const beforeCopy = (await manifest([{ key: 'vault', path: master }])).summary
  const results = {}
  for (const [label, code] of [
    ['baseline', baselineCode],
    ['current', currentCode],
  ]) {
    stage = label + '-measurement'
    const snapshot = join(scratch, label + '-vault')
    await cp(master, snapshot, { recursive: true, preserveTimestamps: true, dereference: false })
    results[label] = await measure(label, code, snapshot, binding, expected)
    const afterCopy = (await manifest([{ key: 'vault', path: snapshot }])).summary
    check(beforeCopy.sha256 === afterCopy.sha256, 'snapshot-changed-during-probe')
  }
  stage = 'source-recheck'
  sourceAfter = await manifest(sourceInputs)
  check(sourceBefore.summary.sha256 === sourceAfter.summary.sha256, 'source-fingerprint-changed')
  const output = {
    status: 'passed',
    node: process.version,
    platform: process.platform + '-' + process.arch,
    baselineRef,
    currentRef,
    currentCodeFingerprint,
    config: { briefBudgetChars: 6000, hotCapacityChars: 9000, warmRuns },
    sourceBefore: sourceBefore.summary,
    sourceAfter: sourceAfter.summary,
    sourceUnchanged: true,
    snapshotsUnchanged: true,
    corpus: expected.summary,
    ...results,
  }
  await rm(scratch, { recursive: true, force: true, maxRetries: 4 })
  scratch = null
  output.temporaryTreeRemoved = true
  console.log(JSON.stringify(output, null, 2))
} catch (error) {
  if (sourceBefore && sourceInputs) {
    sourceAfter = await manifest(sourceInputs).catch(() => null)
  }
  // Error messages may contain vault paths or note text. Emit only fixed labels.
  console.error(
    JSON.stringify({
      status: 'failed',
      stage,
      errorKind: error.name,
      check: error.code ?? null,
      frames: (error.stack?.split('\n').slice(1) ?? [])
        .map((line) => /([a-z-]+\.m?js):(\d+):(\d+)/u.exec(line)?.[0])
        .filter(Boolean),
      sourceUnchanged:
        sourceBefore && sourceAfter
          ? sourceBefore.summary.sha256 === sourceAfter.summary.sha256
          : null,
      sourceBefore: sourceBefore?.summary ?? null,
      sourceAfter: sourceAfter?.summary ?? null,
    }),
  )
  process.exitCode = 1
} finally {
  if (scratch) await rm(scratch, { recursive: true, force: true, maxRetries: 4 })
}
