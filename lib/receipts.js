// Write receipts for vault transactions (Task 7).
//
// A receipt answers "what exactly did this transaction do, and may I trust it?"
// (spec §10.3.4/§10.4.4). It is written in two places with two different jobs:
//
//   * `_meta/log.md` inside the vault — the human-readable, append-only log the
//     user can read in Obsidian. It is a *transaction target*, so it gets the
//     same snapshot, hash re-check and rollback treatment as a note, and it is a
//     cross-project shared file, which is why the whole-vault write lock in
//     ./transaction.js serializes two projects appending to it;
//   * `<dataRoot>/receipts/<vaultHash>/<projectId>/<sha256(idempotencyKey)>.json`
//     outside the vault — the machine-readable record `findReceipt` reads back,
//     so a repeated `idempotencyKey` (a tool retry, a restart, an automatic
//     distillation replay) returns the original receipt instead of applying the
//     change a second time.
//
// The in-flight transaction manifest under
// `<dataRoot>/transactions/<vaultHash>/<txId>.json` carries the same receipt
// while the transaction is unfinished; recovery reads it from there to finish a
// commit whose process died before the machine receipt was stored. The manifest
// is the durable source of truth; this module only defines its layout and the
// pure rendering/parsing rules.
//
// Nothing here writes into the vault: the vault half of a receipt is a normal
// transaction target built in ./transaction.js.
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { resolveDataRoot, resolveVaultRoot } from './paths.js'
import { isUuidV4 } from './pointer.js'
import { sha256Hex } from './registry.js'

/** Schema version of a persisted receipt. */
export const RECEIPT_SCHEMA = 1
/** Vault-relative, append-only receipt log (spec §5.1). */
export const LOG_RELATIVE_PATH = '_meta/log.md'

/** A receipt (or a binding it depends on) cannot be trusted. */
export class ReceiptError extends Error {
  /**
   * @param {string} code - machine-readable reason (`binding-invalid`, `receipt-corrupt`, …).
   * @param {string} message - human-readable diagnostic naming the offending path.
   * @param {{ cause?: Error }} [options] - underlying failure, when there is one.
   */
  constructor(code, message, options) {
    super(message, options)
    this.name = 'ReceiptError'
    this.code = code
  }
}

/**
 * Resolve the identity a transaction is scoped to.
 *
 * The vault half of every path is keyed by `sha256(realpath(vaultRoot))`, so a
 * vault reached through a symlinked home resolves to the same lock, manifest and
 * receipt store as the same vault reached directly. A binding that is not a
 * `kind:'bound'` object with a UUIDv4 project id is refused here, before any
 * path is touched.
 *
 * @param {object} binding - a `kind:'bound'` binding.
 * @param {{ home?: string }} [options] - home directory for `~/` expansion (test seam).
 * @returns {Promise<{vaultRoot: string, vaultExists: boolean, vaultHash: string, projectId: string}>} the identity.
 * @throws {ReceiptError} when the binding cannot be trusted.
 */
export async function vaultIdentity(binding, { home = homedir() } = {}) {
  if (binding === null || typeof binding !== 'object' || Array.isArray(binding)) {
    throw new ReceiptError('binding-invalid', 'a bound project binding is required')
  }
  if (binding.kind !== undefined && binding.kind !== 'bound') {
    throw new ReceiptError('binding-invalid', `expected a bound binding, not ${JSON.stringify(binding.kind)}`)
  }
  if (!isUuidV4(binding.projectId)) {
    throw new ReceiptError('binding-invalid', 'binding.projectId must be a UUIDv4')
  }
  if (typeof binding.vaultRoot !== 'string' || binding.vaultRoot.trim().length === 0) {
    throw new ReceiptError('binding-invalid', 'binding.vaultRoot must be a non-blank path')
  }
  const vault = await resolveVaultRoot(binding.vaultRoot, { home })
  return {
    vaultRoot: vault.root,
    vaultExists: vault.exists,
    vaultHash: sha256Hex(vault.root),
    projectId: binding.projectId,
  }
}

/**
 * The hash that names an idempotency key inside the receipt store.
 *
 * Hashing keeps keys like `sessionId:toSeq:itemIndex` (and any future long key)
 * inside a filesystem-safe, fixed-length name, and keeps the on-disk layout
 * independent of the key's own alphabet.
 *
 * @param {string} key - the idempotency key.
 * @returns {string} 64 lowercase hex characters.
 * @throws {RangeError} when the key is not a non-blank string.
 */
export function receiptKeyHash(key) {
  if (typeof key !== 'string' || key.length === 0) {
    throw new RangeError('the idempotency key must be a non-blank string')
  }
  return createHash('sha256').update(key, 'utf8').digest('hex')
}

/**
 * Where a successful receipt for `key` lives.
 *
 * @param {string} dataRoot - plugin data root.
 * @param {string} vaultHash - sha256 of the vault realpath.
 * @param {string} projectId - owning project id.
 * @param {string} key - idempotency key.
 * @returns {string} absolute path to the receipt JSON (not created here).
 */
export function receiptStorePath(dataRoot, vaultHash, projectId, key) {
  return join(dataRoot, 'receipts', vaultHash, projectId, `${receiptKeyHash(key)}.json`)
}

/**
 * Where the durable record of an unfinished/failed transaction lives.
 *
 * @param {string} dataRoot - plugin data root.
 * @param {string} vaultHash - sha256 of the vault realpath.
 * @param {string} projectId - owning project id.
 * @param {string} txId - transaction id.
 * @returns {string} absolute path to the failure record (not created here).
 */
export function failureRecordPath(dataRoot, vaultHash, projectId, txId) {
  return join(dataRoot, 'receipts', vaultHash, projectId, 'failures', `${txId}.json`)
}

/**
 * Build the receipt object a transaction returns and stores.
 *
 * The field set is the plan's `Receipt` contract: it names the transaction, the
 * session range it came from, every content path with its before/after hashes,
 * the result summary and the timestamp. Hashes are keyed by vault-relative path
 * so a reader never has to correlate two parallel arrays.
 *
 * @param {object} input - receipt fields.
 * @param {string} input.txId - transaction id.
 * @param {string|null} [input.idempotencyKey] - caller-supplied replay key.
 * @param {string|null} [input.sessionId] - session that produced the write.
 * @param {number|null} [input.fromSeq] - first covered session sequence.
 * @param {number|null} [input.toSeq] - last covered session sequence.
 * @param {string} input.action - short action label (`write`, `bootstrap`, …).
 * @param {string[]} input.paths - content paths in apply order.
 * @param {Record<string, string|null>} input.beforeHashes - path → pre-transaction hash.
 * @param {Record<string, string>} input.afterHashes - path → post-transaction hash.
 * @param {object} input.result - result summary (`status`, counts, index state).
 * @param {string} [input.at] - ISO timestamp; defaults to now.
 * @returns {object} the receipt.
 */
export function makeReceipt({
  txId,
  idempotencyKey = null,
  sessionId = null,
  fromSeq = null,
  toSeq = null,
  action,
  paths,
  beforeHashes,
  afterHashes,
  result,
  at = new Date().toISOString(),
}) {
  return {
    schema: RECEIPT_SCHEMA,
    txId,
    idempotencyKey,
    sessionId,
    fromSeq,
    toSeq,
    action,
    paths: [...paths],
    beforeHashes: { ...beforeHashes },
    afterHashes: { ...afterHashes },
    result: { ...result },
    at,
  }
}

/**
 * Render the human-readable log entry for one receipt.
 *
 * The block is pure text derived from the receipt, so recovery can re-render it
 * byte-identically from a manifest. It always ends with a newline.
 *
 * @param {object} receipt - a receipt from `makeReceipt`.
 * @returns {string} the Markdown block to append to `_meta/log.md`.
 */
export function renderLogEntry(receipt) {
  const lines = [`## ${receipt.at} — ${receipt.action}`, '']
  lines.push(`- txId: \`${receipt.txId}\``)
  if (receipt.idempotencyKey !== null && receipt.idempotencyKey !== undefined) {
    lines.push(`- idempotencyKey: \`${receipt.idempotencyKey}\``)
  }
  if (receipt.sessionId !== null && receipt.sessionId !== undefined) {
    lines.push(`- session: \`${receipt.sessionId}\` seq ${receipt.fromSeq ?? '?'}–${receipt.toSeq ?? '?'}`)
  }
  const { status, created = 0, updated = 0, skipped = 0, index = 'none' } = receipt.result ?? {}
  lines.push(`- result: ${status}（新建 ${created}，更新 ${updated}，跳过 ${skipped}；索引 ${index}）`)
  lines.push('- paths:')
  for (const path of receipt.paths ?? []) {
    const before = receipt.beforeHashes?.[path] ?? null
    const after = receipt.afterHashes?.[path] ?? null
    lines.push(`  - \`${path}\` ${shortHash(before)} → ${shortHash(after)}`)
  }
  lines.push('')
  return `${lines.join('\n')}\n`
}

/**
 * Append an entry to a log document, idempotently.
 *
 * A document that already ends with exactly this block is returned unchanged:
 * that is what makes a roll-forward after a crash safe, because the entry may
 * already be on disk while the transaction was never marked committed.
 *
 * @param {string} existingText - current log contents (empty when missing).
 * @param {string} entry - the rendered block, newline-terminated.
 * @returns {string} the next log contents.
 */
export function appendLogEntry(existingText, entry) {
  const base = existingText ?? ''
  if (base.endsWith(entry)) return base
  if (base.length === 0) return entry
  const separator = base.endsWith('\n\n') ? '' : base.endsWith('\n') ? '\n' : '\n\n'
  return `${base}${separator}${entry}`
}

/**
 * Read a stored receipt.
 *
 * @param {string} path - receipt JSON path.
 * @returns {Promise<object|null>} the receipt, or `null` when the file is absent.
 * @throws {ReceiptError} when the file exists but cannot be read or parsed.
 */
export async function readReceiptRecord(path) {
  let text
  try {
    text = await fs.readFile(path, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw new ReceiptError('receipt-unreadable', `cannot read the receipt at ${path}: ${error.code ?? error.message}`, { cause: error })
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new ReceiptError('receipt-corrupt', `the receipt at ${path} is not valid JSON`, { cause: error })
  }
}

/**
 * Store a receipt durably (temporary file → `fsync` → `rename` → directory `fsync`).
 *
 * @param {string} path - receipt JSON path.
 * @param {object} receipt - receipt to persist.
 * @returns {Promise<void>} resolves once the rename is durable.
 */
export async function writeReceiptRecord(path, receipt) {
  await writeJsonAtomic(path, receipt)
}

/**
 * Look up the receipt a repeated idempotency key must return.
 *
 * A `null` result means "this key has not been applied successfully"; a
 * transaction that rolled back stores no receipt, so a retry re-applies instead
 * of trusting a half-finished attempt.
 *
 * @param {object} binding - a `kind:'bound'` binding.
 * @param {string} key - the idempotency key.
 * @param {{ dataRoot?: string, home?: string }} [options] - data root (defaults to `resolveDataRoot()`) and home seam.
 * @returns {Promise<object|null>} the stored receipt, or `null`.
 * @throws {RangeError} when the key is not a non-blank string.
 * @throws {ReceiptError} when the binding or the stored receipt cannot be trusted.
 */
export async function findReceipt(binding, key, { dataRoot = resolveDataRoot(), home = homedir() } = {}) {
  const identity = await vaultIdentity(binding, { home })
  return readReceiptRecord(receiptStorePath(dataRoot, identity.vaultHash, identity.projectId, key))
}

/**
 * Write a JSON document atomically, creating its directory.
 *
 * `fsync` on the temporary file makes the bytes durable before the rename, and
 * the directory `fsync` makes the rename itself durable — a receipt that is
 * visible after a crash is a receipt that was fully written.
 *
 * @param {string} path - destination path.
 * @param {unknown} value - JSON-serializable value.
 * @returns {Promise<void>} resolves once the rename is durable.
 */
export async function writeJsonAtomic(path, value) {
  const directory = dirname(path)
  await fs.mkdir(directory, { recursive: true })
  const temporary = join(directory, `.${Date.now()}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`)
  let handle
  try {
    handle = await fs.open(temporary, 'wx', 0o600)
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await handle.sync()
    await handle.close()
    handle = null
    await fs.rename(temporary, path)
  } catch (error) {
    await handle?.close().catch(() => {})
    await fs.rm(temporary, { force: true }).catch(() => {})
    throw error
  }
  await fsyncDirectory(directory)
}

/**
 * Shorten a hash for the human-readable log line.
 *
 * @param {string|null} hash - full sha256 or null.
 * @returns {string} a short, still-recognizable token.
 */
function shortHash(hash) {
  if (hash === null || hash === undefined) return '∅'
  return `sha256:${hash.slice(0, 12)}`
}

/**
 * `fsync` a directory so a rename inside it survives a crash.
 *
 * Some platforms refuse to open a directory; that is reported as success
 * because there is nothing more this code can do, while every other failure is
 * real and propagates.
 *
 * @param {string} directory - directory to sync.
 * @returns {Promise<void>} resolves when the directory entry is durable.
 */
export async function fsyncDirectory(directory) {
  let handle
  try {
    handle = await fs.open(directory, 'r')
  } catch (error) {
    if (['EISDIR', 'EACCES', 'EPERM', 'EINVAL', 'ENOTSUP', 'ENOENT'].includes(error.code)) return
    throw error
  }
  try {
    await handle.sync()
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EBADF'].includes(error.code)) throw error
  } finally {
    await handle.close()
  }
}
