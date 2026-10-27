// Cleanup must preserve import contracts even when a callback or facade has no
// named call edge. Browser URL roots are exercised by graph-route.test.js.
import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import { test } from 'node:test'

import * as memory from '../lib/memory.js'
import * as hot from '../lib/hot.js'
import * as hotText from '../lib/hot-text.js'
import * as hotArchive from '../lib/hot-archive.js'
import * as tools from '../lib/tools.js'
import { createMemoryServices } from '../lib/services.js'
import { registerTools } from '../lib/tool-registry.js'
import { TOOL_NAMES, TOOL_PARAMETERS } from '../lib/tool-schema.js'
import { listTools } from '../codex/server.mjs'

test('package roots and both CLI entrypoints remain resolvable', async () => {
  for (const [specifier, path] of [
    ['dsh-obsidian-mem', '../lib/index.js'],
    ['dsh-obsidian-mem/client', '../lib/client.js'],
    ['dsh-obsidian-mem/package.json', '../package.json'],
  ]) {
    const expected = new URL(path, import.meta.url)
    assert.equal(import.meta.resolve(specifier), expected.href)
    await access(expected)
  }
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.deepEqual(manifest.bin, {
    'dsh-obsidian-mem-diagnose': './lib/diagnose-cli.js',
    'dsh-obsidian-mem-review': './lib/curation-cli.js',
  })
  for (const path of Object.values(manifest.bin)) {
    const source = await readFile(new URL(`../${path}`, import.meta.url), 'utf8')
    assert.ok(source.startsWith('#!/usr/bin/env node\n'))
  }
})

test('candidate callback and memory exports survive execution-only cleanup', () => {
  assert.deepEqual(Object.keys(memory), [
    'MemoryError',
    'appendLog',
    'applyCandidate',
    'assertPluginOwnedContainer',
    'assertPluginOwnedNote',
    'createMemoryWithId',
    'findNoteById',
    'localDate',
    'normalizeDeps',
    'noteIdFor',
    'promoteNote',
    'readNoteById',
    'renderNote',
    'routeNote',
    'sha256Hex',
    'spliceBody',
    'typePrefix',
    'writeMemory',
  ])
  assert.equal(typeof memory.applyCandidate, 'function')
})

test('hot facade retains shared text values and planner exports', () => {
  for (const name of [
    'ARCHIVED_PREFIX',
    'ARCHIVE_FILENAME',
    'ARCHIVE_SECTION',
    'ARCHIVE_TITLE',
    'COMPACT_SECTIONS',
    'HOT_ARCHIVE_RATIO',
    'HOT_CAPACITY_CHARS',
    'HOT_ENTRY_PATTERN',
    'HOT_SECTIONS',
    'charCount',
    'isPointerLine',
    'locateSection',
  ]) {
    assert.equal(hot[name], hotText[name], name)
  }
  assert.equal(hot.MemoryError, memory.MemoryError)
  assert.deepEqual(Object.keys(hotArchive), [
    'applyPointers',
    'archiveCandidates',
    'archiveLine',
    'describeZones',
    'foldPointers',
    'planArchive',
    'totalEligibility',
    'zoneStats',
  ])
})

test('tool facade and Codex adapter keep the same production entrypoints', () => {
  assert.deepEqual(Object.keys(tools), [
    'TOOL_NAMES',
    'TOOL_PARAMETERS',
    'createMemoryServices',
    'registerTools',
  ])
  assert.equal(tools.TOOL_NAMES, TOOL_NAMES)
  assert.equal(tools.TOOL_PARAMETERS, TOOL_PARAMETERS)
  assert.equal(tools.createMemoryServices, createMemoryServices)
  assert.equal(tools.registerTools, registerTools)
  assert.deepEqual(
    listTools().map((tool) => tool.name),
    [...TOOL_NAMES],
  )
})
