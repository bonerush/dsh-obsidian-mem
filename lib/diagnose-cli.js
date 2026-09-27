#!/usr/bin/env node
// User-run, local-only support report. stdout carries only the output path.
import { realpathSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildDiagnosticReport, writeDiagnosticReport } from './diagnostic-report.js'
import { resolveDataRoot } from './paths.js'

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUTPUT_CODES = new Set([
  'output-exists',
  'output-invalid',
  'output-symlink',
  'output-write-failed',
  'report-size-limit',
])

/** Run one explicit, local export. */
export async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 2 || argv[0] !== '--output' || argv[1].trim() === '') {
    process.stderr.write('diagnose: usage: dsh-obsidian-mem-diagnose --output <file.json>\n')
    return 2
  }
  let dataRoot = null
  try {
    dataRoot = resolveDataRoot()
  } catch {
    // The report still states the Node/package checks when DSH_HOME is invalid.
  }
  try {
    const report = await buildDiagnosticReport({ dataRoot, packageRoot: PACKAGE_ROOT })
    const output = writeDiagnosticReport(report, argv[1])
    process.stdout.write(`diagnose: wrote ${output}\n`)
    return 0
  } catch (error) {
    const code = OUTPUT_CODES.has(error?.code) ? error.code : 'report-failed'
    process.stderr.write(`diagnose: ${code}\n`)
    return 1
  }
}

let isEntry = false
try {
  isEntry = realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
} catch {
  // Importing this module for tests or tooling must not run the command.
}
if (isEntry) {
  process.exitCode = await main()
}
