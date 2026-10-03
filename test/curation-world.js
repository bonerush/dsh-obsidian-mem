// The isolated world every curation test builds on (curation plan Task 1).
//
// One throwaway root holds a Git repository, a vault and a private data root, so
// a test can drive the *shipped* service layer exactly as a session does without
// one byte of the user's real home, real vault or real `$DSH_HOME` being read or
// written. `t.after` closes the services before the tree is removed: an open
// index holds a file descriptor under the data root, and deleting a directory out
// from under one is how a cleanup failure turns into a confusing test failure.
//
// `dataRoot` is the plugin's own root (`$DSH_HOME/data/obsidian-mem`), not
// `$DSH_HOME` itself. Both are returned, because `lib/curation-cli.js` derives
// the data root from the environment while every other caller is handed it.
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { validateConfig } from '../lib/config.js'
import { createMemoryServices } from '../lib/services.js'

/** The environment a fixture `git init` runs under, free of the user's own config. */
function gitEnvironment() {
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE']) {
    delete env[key]
  }
  return env
}

/**
 * Build one isolated world: a Git repository, a vault and a private data root.
 *
 * The repository is a real Git repository with no `.obsidian-mem` pointer, which
 * is the state spec §5.2.3 binds on first use — so the first `services.write`
 * exercises the real auto-bind and bootstrap rather than a hand-built binding.
 * Everything the plugin derives from `DSH_HOME` lives under `root/dsh`, and the
 * vault is `root/vault`.
 *
 * @param {object} t - the `node:test` context whose `after` removes the tree.
 * @param {{config?: object, cwd?: string}} [options] - extra config keys to validate, or a different working directory.
 * @returns {Promise<{root: string, vault: string, repo: string, home: string, dshHome: string, dataRoot: string, config: object, services: object}>} the world.
 */
export async function makeCurationWorld(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'obsidian-curation-'))
  const vault = join(root, 'vault')
  const repo = join(root, 'repo')
  const home = join(root, 'home')
  const dshHome = join(root, 'dsh')
  const dataRoot = join(dshHome, 'data', 'obsidian-mem')
  await mkdir(vault, { recursive: true })
  await mkdir(repo, { recursive: true })
  await mkdir(home, { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, env: gitEnvironment() })
  const config = validateConfig({ vaultPath: vault, ...(options.config ?? {}) })
  const services = createMemoryServices({
    config,
    dataRoot,
    cwd: options.cwd ?? repo,
    home,
  })
  t.after(async () => {
    // The services go first: `close()` awaits every memoized index handle, and a
    // handle that is still open keeps a descriptor inside the tree being removed.
    await services.close().catch(() => {})
    await rm(root, { recursive: true, force: true, maxRetries: 4 })
  })
  return { root, vault, repo, home, dshHome, dataRoot, config, services }
}

/**
 * Every `.md` file under one directory, as vault-relative paths.
 *
 * Tests assert on the *set* of files a pass created rather than on a count, so a
 * test that accidentally writes an extra note is visible as an extra name.
 *
 * @param {string} vault - the vault root.
 * @param {string} relativeDir - the directory to walk, vault-relative.
 * @returns {Promise<string[]>} sorted vault-relative paths.
 */
export async function listMarkdown(vault, relativeDir) {
  const base = join(vault, ...relativeDir.split('/'))
  const out = []
  // Only the nested walk swallows an error: a directory that disappears between
  // the readdir and the recursion is a race, and a test that asserts on what is
  // left is still telling the truth.
  const walk = async (directory, prefix) => {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const next = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) await walk(join(directory, entry.name), next)
      else if (entry.name.endsWith('.md')) out.push(`${relativeDir}/${next}`)
    }
  }
  // The top-level error is the caller's to see. `relativeDir` is usually derived
  // by slicing up a written path, so swallowing here turned a layout change or a
  // typo into a silent `[]` and a caller loop that asserted nothing at all.
  await readdir(base, { withFileTypes: true })
  await walk(base, '')
  return out.sort()
}
