#!/usr/bin/env node
// Point the marketplace entry's `tarball:` at one release's asset.
//
// The storefront prefers a declared tarball over the build-from-source command,
// and the URL has to name a release tag: `releases/latest/download/<file>`
// resolves `latest` per request but takes the filename literally, so a version
// in the asset name rots the link on the next release. That makes the entry
// version-specific, and every release therefore owes the marketplace one line.
//
// This script is that one line, and it runs with whatever credentials the caller
// already has: `GH_TOKEN`, or the token `gh auth token` reads out of the local
// keyring. Nothing is stored here — a GitHub Actions run would have to be handed
// a token that can write to a repository this one does not own, and the local
// path needs none.
//
// It is deliberately read-mostly: the fork and the PR are looked up before
// anything is created, the branch is rewritten in place when the PR already
// exists, and the entry text is validated before it is committed.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** The curated list the DSH marketplace is generated from. */
const UPSTREAM = 'awesome-dsh-plugin/awesome-dsh-plugin'
/** Where the catalog points for this plugin's source. */
const PLUGIN_URL = 'https://github.com/bonerush/dsh-obsidian-mem'

/**
 * Run a command and return stdout, naming the failure instead of swallowing it.
 *
 * @param {string} command - the executable.
 * @param {string[]} args - its arguments.
 * @param {object} [options] - `cwd`, extra `env`, and whether stdout is wanted.
 * @returns {string} stdout.
 */
function run(command, args, options = {}) {
  try {
    return execFileSync(command, args, {
      cwd: options.cwd,
      encoding: 'utf8',
      stdio:
        options.capture === false ? ['ignore', 'inherit', 'inherit'] : ['ignore', 'pipe', 'pipe'],
      env: options.env === undefined ? process.env : { ...process.env, ...options.env },
      maxBuffer: 32 * 1024 * 1024,
    })
  } catch (error) {
    const detail = (error.stderr ?? '').trim() || error.message
    throw new Error(`${command} ${args.join(' ')} failed: ${detail}`, { cause: error })
  }
}

/**
 * The token to act with: the environment's, else the one `gh` already holds.
 *
 * @returns {string} a token.
 * @throws {Error} when neither is available.
 */
function token() {
  for (const name of ['GH_TOKEN', 'GITHUB_TOKEN']) {
    if (typeof process.env[name] === 'string' && process.env[name].trim() !== '') {
      return process.env[name].trim()
    }
  }
  try {
    const stored = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim()
    if (stored !== '') return stored
  } catch {
    /* fall through to the error below */
  }
  throw new Error('no token: set GH_TOKEN, or run `gh auth login` once')
}

/**
 * One GitHub REST call as the given token.
 *
 * @param {string} path - API path or absolute URL.
 * @param {string} auth - the token.
 * @param {{method?: string, body?: object, allow404?: boolean}} [options] - request shape.
 * @returns {object|null} the parsed body, or null for an allowed 404.
 */
function api(path, auth, options = {}) {
  const args = ['api', '--method', options.method ?? 'GET', path]
  for (const [key, value] of Object.entries(options.body ?? {})) {
    args.push('-f', `${key}=${value}`)
  }
  try {
    const out = run('gh', args, { env: { GH_TOKEN: auth } })
    return out.trim() === '' ? {} : JSON.parse(out)
  } catch (error) {
    if (options.allow404 === true && /HTTP 404/.test(error.message)) return null
    throw error
  }
}

/**
 * Whether the release asset answers a ranged request, which is the check the
 * marketplace's own tarball probe makes (404/410 means dead, anything else
 * non-success means "not checked").
 *
 * @param {string} url - the asset URL.
 * @returns {Promise<{ok: boolean, status: number}>} the verdict.
 */
async function assetAnswers(url) {
  try {
    const response = await fetch(url, {
      headers: { range: 'bytes=0-0' },
      redirect: 'follow',
      signal: AbortSignal.timeout(30000),
    })
    if (response.body) await response.body.cancel().catch(() => {})
    return { ok: response.ok || response.status === 206, status: response.status }
  } catch (error) {
    return { ok: false, status: 0, error: error.message }
  }
}

/**
 * Rewrite one entry's `tarball:` line, returning the new text.
 *
 * @param {string} text - the entry file.
 * @param {string} url - the asset URL to declare.
 * @returns {string} the new text.
 * @throws {Error} when the entry does not describe this plugin.
 */
export function setTarball(text, url) {
  if (!text.includes(PLUGIN_URL)) {
    throw new Error(`the entry does not name ${PLUGIN_URL}`)
  }
  const host = new URL(url).hostname
  if (
    ![
      'github.com',
      'objects.githubusercontent.com',
      'release-assets.githubusercontent.com',
    ].includes(host)
  ) {
    throw new Error(`the marketplace refuses a tarball on ${host}`)
  }
  if (!url.startsWith('https:') || !/\.(tgz|tar\.gz)$/.test(new URL(url).pathname)) {
    throw new Error('the marketplace refuses anything but an https .tgz')
  }
  if (url.includes('/releases/latest/download/')) {
    throw new Error('latest/download/ takes the filename literally; pin the tag instead')
  }
  const lines = text.split('\n')
  const index = lines.findIndex((line) => line.startsWith('tarball:'))
  if (index === -1) {
    // Appended after the entry's own last line, not after its trailing newline:
    // the file already ends in one, and adding to the split tail leaves a blank
    // line between the description and the field.
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
    lines.push(`tarball: ${url}`)
  } else {
    lines[index] = `tarball: ${url}`
  }
  return lines.join('\n').replace(/\n*$/, '\n')
}

/**
 * Open (or refresh) the pull request that points the entry at one release.
 *
 * @param {{version?: string, repoRoot?: string, dryRun?: boolean}} [options] - inputs.
 * @returns {Promise<{url: string|null, action: string}>} what happened.
 */
export async function main(options = {}) {
  const repoRoot = options.repoRoot ?? process.cwd()
  const version =
    options.version ?? JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version
  const tag = `v${version}`
  const asset = `dsh-obsidian-mem-${version}.tgz`
  const url = `https://github.com/bonerush/dsh-obsidian-mem/releases/download/${tag}/${asset}`

  const verdict = await assetAnswers(url)
  if (!verdict.ok) {
    throw new Error(
      `the asset is not there yet: ${url} answered ${verdict.status}. ` +
        'Release first (the workflow attaches it), then run this.',
    )
  }

  const auth = token()
  const viewer = api('user', auth).login
  const [upstreamOwner, upstreamName] = UPSTREAM.split('/')
  const parent = api(`repos/${UPSTREAM}`, auth)
  if (parent.fork !== false && parent.fork !== undefined) {
    throw new Error(`${UPSTREAM} is itself a fork; refusing to guess the upstream`)
  }

  const fork = `${viewer}/${upstreamName}`
  const existing = api(`repos/${fork}`, auth, { allow404: true })
  if (existing === null) {
    process.stdout.write(`creating the fork ${fork}\n`)
    api(`repos/${UPSTREAM}/forks`, auth, { method: 'POST' })
  }

  const branch = `tarball-${tag}`
  const entryPath = `data/plugins/${upstreamOwner.replace(/[^a-z0-9-]/gi, '')}__${upstreamName}.yml`
  const work = mkdtempSync(join(tmpdir(), 'marketplace-entry-'))
  try {
    // The token rides in the remote URL so no credential helper is consulted;
    // it is never printed.
    const remote = `https://x-access-token:${auth}@github.com/${fork}.git`
    run('git', ['clone', '--quiet', '--depth', '1', '--branch', 'main', remote, work])
    run('git', ['-C', work, 'remote', 'add', 'upstream', `https://github.com/${UPSTREAM}.git`])
    run('git', ['-C', work, 'fetch', '--quiet', '--depth', '1', 'upstream', 'main'])
    run('git', ['-C', work, 'checkout', '--quiet', '-B', branch, 'FETCH_HEAD'])

    // The entry must exist upstream: this script updates a listing, it does not
    // submit one (that is a person's PR with a person's description).
    const path = join(work, entryPath)
    const next = setTarball(readFileSync(path, 'utf8'), url)
    if (readFileSync(path, 'utf8') === next) {
      return { url: null, action: `already points at ${tag}` }
    }
    writeFileSync(path, next)

    // Their own validators, so the PR is checked by the list's rules and not by
    // this script's opinion of them.
    const problems = run(
      'node',
      [
        '--input-type=module',
        '-e',
        "const m = await import('./scripts/lib/entries.mjs');" +
          'const all = m.readEntries();' +
          'const mine = all.find((e) => e.url.includes("dsh-obsidian-mem"));' +
          'if (!mine) throw new Error("entry not found");' +
          'const bad = m.tarballProblem(mine.tarball);' +
          'if (bad) throw new Error(bad);' +
          'const problems = m.validateEntries(all);' +
          'if (problems.length) throw new Error(problems.slice(0, 3).join("; "));' +
          'console.log("validateEntries: 0 problems")',
      ],
      { cwd: work },
    ).trim()

    if (options.dryRun === true) {
      return { url: null, action: `dry run: ${entryPath} would declare ${url}` }
    }

    run('git', ['-C', work, 'config', 'user.name', viewer])
    run('git', ['-C', work, 'config', 'user.email', `${viewer}@users.noreply.github.com`])
    run('git', ['-C', work, 'add', entryPath])
    run('git', [
      '-C',
      work,
      'commit',
      '--quiet',
      '-m',
      `Point the tarball at ${tag}\n\n${problems}\n\n${url}`,
    ])
    run('git', ['-C', work, 'push', '--quiet', '--force', 'origin', `HEAD:${branch}`])

    const body =
      `Points the entry's \`tarball:\` at the ${tag} release asset.\n\n` +
      `\`\`\`\n${url}\n\`\`\`\n\n` +
      'Pinned to the tag rather than `releases/latest/download/`: the asset name\n' +
      'carries the version, and `latest` takes the filename literally.\n\n' +
      `Checked with this repository's own tooling: ${problems}, and the URL answers a\n` +
      'ranged request with a success status, which is what `probe-tarballs.mjs` asks for.\n'

    const open = api(`repos/${UPSTREAM}/pulls?head=${viewer}:${branch}&state=open`, auth, {
      allow404: true,
    })
    if (Array.isArray(open) && open.length > 0) {
      return { url: open[0].html_url, action: `updated ${branch}` }
    }
    const pr = api(`repos/${UPSTREAM}/pulls`, auth, {
      method: 'POST',
      body: {
        title: `Point the tarball at ${tag}`,
        head: `${viewer}:${branch}`,
        base: 'main',
        body,
      },
    })
    return { url: pr.html_url, action: `opened ${branch}` }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

const isEntry =
  process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href
if (isEntry) {
  main({ version: process.argv[2], dryRun: process.argv.includes('--dry-run') })
    .then((result) => {
      process.stdout.write(`marketplace-entry: ${result.action}\n`)
      if (result.url !== null) process.stdout.write(`${result.url}\n`)
    })
    .catch((error) => {
      process.stderr.write(`marketplace-entry: ${error.message}\n`)
      process.exitCode = 1
    })
}
