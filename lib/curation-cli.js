#!/usr/bin/env node
// @ts-check
// The one route by which a parked curation proposal becomes a vault change (Task 7).
//
// Approval is deliberately *not* a tool, an admin action or an HTTP surface: it is
// this command, run by the person whose vault it is, at a terminal they are sitting
// in. Three properties make that real rather than aspirational:
//
//   * **A pipe is refused.** Both stdin and stdout must be terminals
//     (`interactive-tty-required`), so an agent that can spawn a process still
//     cannot answer the prompt: there is nothing to read if nobody is there, and a
//     caller that pipes an answer in gets a non-zero exit rather than an approval.
//   * **The confirmation is byte-for-byte.** The reviewer types `apply <id>` or
//     `reject <id>` — the exact id this run displayed — and anything else, including
//     a y, a bare `apply`, or the id alone, is `confirmation-mismatch`.
//   * **One run decides one proposal.** The id is a required argument and no code
//     path here iterates a queue, so a batch is never approved by accident. There
//     is no `--all`, no `--yes` and no default answer.
//
// The vault path is a required absolute argument, and the project is resolved from
// the working directory in `show` mode — the read-only mode — so this command can
// never bind or bootstrap anything as a side effect of an approval. Its data root
// is `DSH_HOME`'s, the same private root every other curation document lives in.
//
// stdout and stderr carry the review text and a refusal code. Nothing else: no
// credential is read, printed or uploaded anywhere.
import { isAbsolute } from 'node:path'
import { resolveDataRoot } from './paths.js'
import { readCurationProposal } from './curation-proposals.js'
import { renderCurationProposal, reviewCurationProposal } from './curation-review.js'
import { resolveBinding } from './vault.js'

/** The usage text, printed for `--help` and for a malformed invocation. */
const USAGE = `usage: dsh-obsidian-mem-review --vault <absolute-path> <proposal-id>

  Shows one parked curation proposal and asks for an exact confirmation:
    apply <proposal-id>   apply exactly this proposal
    reject <proposal-id>  mark it rejected, changing no note

  --vault  the absolute path of the Obsidian vault holding the project
  DSH_HOME chooses the private data root (default ~/.dsh)
`

/**
 * Read one line from the terminal, without echoing anything back.
 *
 * Resolves `null` at end of input, which a terminal sends when the reviewer types
 * the platform's end-of-file key rather than an answer.
 *
 * @returns {Promise<string|null>} the line, without its terminator.
 */
function askLine() {
  return new Promise((resolve) => {
    let buffer = ''
    const onData = (chunk) => {
      buffer += chunk.toString('utf8')
      if (!buffer.includes('\n')) return
      cleanup()
      resolve(buffer.slice(0, buffer.indexOf('\n')).replace(/\r$/u, ''))
    }
    const onEnd = () => {
      cleanup()
      resolve(null)
    }
    const cleanup = () => {
      process.stdin.off('data', onData)
      process.stdin.off('end', onEnd)
      process.stdin.pause()
    }
    process.stdin.setEncoding('utf8')
    process.stdin.resume()
    process.stdin.on('data', onData)
    process.stdin.on('end', onEnd)
  })
}

/**
 * Parse the command line.
 *
 * `--vault` and the proposal id may appear in either order; anything the command
 * does not recognise is a usage error, because a silently ignored argument is how
 * a batch flag would one day be a no-op instead of a refusal.
 *
 * @param {string[]} argv - the arguments after the program name.
 * @returns {{help: boolean, vaultPath: string|null, proposalId: string|null}} the parsed arguments.
 */
function parseArguments(argv) {
  const parsed = { help: false, vaultPath: null, proposalId: null }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--help' || argument === '-h') {
      parsed.help = true
    } else if (argument === '--vault') {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) {
        throw new Error('usage: --vault needs an absolute path')
      }
      parsed.vaultPath = value
      index += 1
    } else if (argument.startsWith('--vault=')) {
      parsed.vaultPath = argument.slice('--vault='.length)
    } else if (argument.startsWith('-')) {
      throw new Error(`usage: unknown option ${JSON.stringify(argument)}`)
    } else if (parsed.proposalId === null) {
      parsed.proposalId = argument
    } else {
      throw new Error('usage: one proposal id per run; a batch is never approved')
    }
  }
  return parsed
}

/**
 * Run one review.
 *
 * @param {string[]} argv - the arguments after the program name.
 * @returns {Promise<number>} the process exit code (0 decided, 1 refused, 2 usage).
 */
async function main(argv) {
  let parsed
  try {
    parsed = parseArguments(argv)
  } catch (error) {
    process.stderr.write(`dsh-obsidian-mem-review: ${error.message}\n${USAGE}`)
    return 2
  }
  if (parsed.help) {
    process.stdout.write(USAGE)
    return 0
  }
  if (parsed.vaultPath === null) {
    process.stderr.write(`dsh-obsidian-mem-review: --vault is required\n${USAGE}`)
    return 2
  }
  if (parsed.proposalId === null) {
    process.stderr.write(`dsh-obsidian-mem-review: a proposal id is required\n${USAGE}`)
    return 2
  }
  // The order of these checks is the design: the two argument errors are answered
  // from argv alone, and nothing is read and no lock is taken before the run has
  // proved it is a person at a terminal.
  if (!isAbsolute(parsed.vaultPath)) {
    process.stderr.write(
      `dsh-obsidian-mem-review: absolute-vault-path-required: ${JSON.stringify(parsed.vaultPath)} is not absolute\n`,
    )
    return 2
  }
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    process.stderr.write(
      'dsh-obsidian-mem-review: interactive-tty-required: approval is typed at a terminal, never piped\n',
    )
    return 2
  }

  const binding = await resolveBinding({
    cwd: process.cwd(),
    vaultRoot: parsed.vaultPath,
    mode: 'show',
  })
  if (binding.kind !== 'bound') {
    process.stderr.write(
      `dsh-obsidian-mem-review: project-not-bound: ${binding.reason ?? binding.kind}\n`,
    )
    return 1
  }
  const dataRoot = resolveDataRoot(process.env.DSH_HOME)
  const proposal = await readCurationProposal({
    dataRoot,
    projectId: binding.projectId,
    proposalId: parsed.proposalId,
  }).catch((error) => ({ missing: error }))
  if (proposal === null || 'missing' in proposal) {
    process.stderr.write(
      `dsh-obsidian-mem-review: proposal-missing: no proposal ${parsed.proposalId} exists for this project\n`,
    )
    return 1
  }

  process.stdout.write(
    `${await renderCurationProposal(proposal, { vaultRoot: binding.vaultRoot })}\n`,
  )
  const answer = await askLine()
  const wanted = [`apply ${parsed.proposalId}`, `reject ${parsed.proposalId}`]
  if (answer === null || !wanted.includes(answer)) {
    process.stderr.write(
      `dsh-obsidian-mem-review: confirmation-mismatch: expected exactly ${wanted.map((value) => JSON.stringify(value)).join(' or ')}\n`,
    )
    return 1
  }

  const decision = answer.startsWith('apply ') ? 'apply' : 'reject'
  const result = await reviewCurationProposal({
    dataRoot,
    proposalId: parsed.proposalId,
    decision,
    binding,
  })
  if (result.status === 'refused') {
    process.stderr.write(`dsh-obsidian-mem-review: ${result.code}: ${result.message}\n`)
    return 1
  }
  // `writeMemory` answers `{id, path, receipt}`, so the path is the outer field and
  // the transaction's file list is nested inside its receipt.
  const where =
    result.status === 'applied'
      ? (result.receipt?.path ?? result.receipt?.receipt?.paths?.[0] ?? '(no path reported)')
      : 'no note changed'
  process.stdout.write(`${result.status}: ${parsed.proposalId} (${where})\n`)
  return 0
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code
  })
  .catch((error) => {
    // One line, code first: a refusal is what a reviewer needs to read, and a stack
    // trace here would print vault paths to a terminal that already shows them.
    process.stderr.write(
      `dsh-obsidian-mem-review: ${error?.code ?? 'failed'}: ${error?.message ?? String(error)}\n`,
    )
    process.exitCode = 1
  })
