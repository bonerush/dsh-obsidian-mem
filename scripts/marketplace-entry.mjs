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
/** This plugin's entry file in the list, named `<owner>__<repo>.yml`. */
const PLUGIN_ENTRY = 'bonerush__dsh-obsidian-mem'

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
 * The first non-empty token among the named environment variables, else the one
 * `gh` already holds, else null.
 *
 * @param {string[]} names - environment variables to try, in order.
 * @returns {string|null} a token, or null.
 */
function tokenFrom(names) {
  for (const name of names) {
    const value = process.env[name]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  try {
    const stored = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim()
    if (stored !== '') return stored
  } catch {
    /* the caller decides whether the absence is fatal */
  }
  return null
}

/**
 * The credential that may write to the fork and open a pull request upstream.
 *
 * `MARKETPLACE_TOKEN` first, because a workflow that hands this script `GH_TOKEN`
 * is handing it the repository's own token — which cannot write to a repository
 * this project does not own. A GitHub Actions run without the secret would
 * otherwise fail later on `gh api user` with "Bad credentials", which names the
 * symptom and not the missing configuration.
 *
 * @returns {string} a token.
 * @throws {Error} when there is none, or when the only one is the wrong kind.
 */
function marketplaceToken() {
  const declared = (process.env.MARKETPLACE_TOKEN ?? '').trim()
  if (declared !== '') return declared
  const local = (process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? '').trim()
  if (local !== '') {
    throw new Error(
      'MARKETPLACE_TOKEN is not set, and GITHUB_TOKEN cannot write to a fork this repository ' +
        'does not own: add the fine-grained token as the MARKETPLACE_TOKEN secret',
    )
  }
  const found = tokenFrom(['MARKETPLACE_TOKEN', 'GH_TOKEN'])
  if (found === null) {
    throw new Error(
      'no token for the marketplace: set MARKETPLACE_TOKEN, or run `gh auth login` once',
    )
  }
  return found
}

/**
 * The credential for reading this project's own releases.
 *
 * In a workflow that means `GITHUB_TOKEN`; on a workstation it means whatever
 * `gh` holds. Kept separate from {@link marketplaceToken} so a fine-grained token
 * scoped to the listed repository does not have to be scoped to this one too.
 *
 * @returns {string} a token.
 * @throws {Error} when there is none.
 */
function localToken() {
  const found = tokenFrom(['GITHUB_TOKEN', 'GH_TOKEN'])
  if (found === null) throw new Error('no token for this repository: set GITHUB_TOKEN')
  return found
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
 * Retried, because a network that drops one TLS handshake must not be reported
 * as "the asset is not there" — the same distinction the marketplace draws
 * between a dead link and an unlooked-at one. When Node's fetch cannot reach
 * github.com at all, `gh api` answers instead: it is the same authenticated
 * client this script already needs, and on at least one machine here it is the
 * only channel that works.
 *
 * @param {string} url - the asset URL.
 * @param {string} auth - the token, for the fallback.
 * @returns {Promise<{ok: boolean, status: number, how: string}>} the verdict.
 */
async function assetAnswers(url, auth) {
  let last = { ok: false, status: 0, how: 'fetch' }
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { range: 'bytes=0-0' },
        redirect: 'follow',
        signal: AbortSignal.timeout(20000),
      })
      if (response.body) await response.body.cancel().catch(() => {})
      if (response.ok || response.status === 206) {
        return { ok: true, status: response.status, how: 'fetch' }
      }
      last = { ok: false, status: response.status, how: 'fetch' }
      // A definitive 404/410 is the asset genuinely not being there; anything
      // else non-success is "we did not get to look", so it keeps retrying.
      if (response.status === 404 || response.status === 410) return last
    } catch {
      last = { ok: false, status: 0, how: 'fetch' }
    }
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 2000 * attempt))
  }
  try {
    const afterDownload = url.split('/download/')[1]
    if (typeof afterDownload === 'string') {
      const [tag] = afterDownload.split('/')
      const release = api(`repos/bonerush/dsh-obsidian-mem/releases/tags/${tag}`, auth)
      const name = decodeURIComponent(url.split('/').pop())
      const asset = (release.assets ?? []).find((candidate) => candidate.name === name)
      return asset === undefined
        ? { ok: false, status: 404, how: 'gh' }
        : { ok: true, status: 200, how: 'gh' }
    }
  } catch {
    /* the fetch verdict stands */
  }
  return last
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

  // Two credentials on purpose. The asset and identity checks read this
  // repository; the fork, the branch and the pull request belong to a repository
  // this project only has a fork of. A token scoped to the listed repository
  // therefore does not have to be scoped to this one.
  const local = localToken()
  const marketplace = marketplaceToken()

  const verdict = await assetAnswers(url, local)
  if (!verdict.ok) {
    throw new Error(
      `the asset is not there yet: ${url} answered ${verdict.status} (via ${verdict.how}). ` +
        'Release first (the workflow attaches it), then run this.',
    )
  }

  const viewer = api('user', marketplace).login
  const [, upstreamName] = UPSTREAM.split('/')
  const parent = api(`repos/${UPSTREAM}`, marketplace)
  if (parent.fork !== false && parent.fork !== undefined) {
    throw new Error(`${UPSTREAM} is itself a fork; refusing to guess the upstream`)
  }

  const fork = `${viewer}/${upstreamName}`
  const existing = api(`repos/${fork}`, marketplace, { allow404: true })
  if (existing === null) {
    process.stdout.write(`creating the fork ${fork}\n`)
    api(`repos/${UPSTREAM}/forks`, marketplace, { method: 'POST' })
  }

  const branch = `tarball-${tag}`
  // The entry file is named for the *listed plugin's* owner and repository, not
  // for the marketplace's: `data/plugins/<owner>__<repo>.yml`.
  const entryPath = `data/plugins/${PLUGIN_ENTRY}.yml`
  const work = mkdtempSync(join(tmpdir(), 'marketplace-entry-'))
  try {
    // The token rides in the remote URL so no credential helper is consulted;
    // it is never printed.
    const remote = `https://x-access-token:${marketplace}@github.com/${fork}.git`
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
    // this script's opinion of them. `entries.mjs` imports `js-yaml`, which the
    // shallow clone does not carry, so the one dependency is installed first —
    // about two seconds, and it keeps the alternative (re-implementing the four
    // rules here) from becoming a second, drifting copy of them.
    run('npm', ['install', '--silent', '--no-audit', '--no-fund', '--no-save', 'js-yaml'], {
      cwd: work,
    })
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
          'console.log("readEntries + validateEntries + tarballProblem: 0 problems")',
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

    const open = api(`repos/${UPSTREAM}/pulls?head=${viewer}:${branch}&state=open`, marketplace, {
      allow404: true,
    })
    if (Array.isArray(open) && open.length > 0) {
      return { url: open[0].html_url, action: `updated ${branch}` }
    }
    const pr = api(`repos/${UPSTREAM}/pulls`, marketplace, {
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
  // The version is the first argument that is not a flag. Reading argv[2] made
  // `--dry-run` a version number and asked GitHub for a release named `v--dry-run`
  // — which, to its credit, answered 404.
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const version = args.find((argument) => !argument.startsWith('-'))
  main({ version, dryRun })
    .then((result) => {
      process.stdout.write(`marketplace-entry: ${result.action}\n`)
      if (result.url !== null) process.stdout.write(`${result.url}\n`)
    })
    .catch((error) => {
      process.stderr.write(`marketplace-entry: ${error.message}\n`)
      process.exitCode = 1
    })
}
