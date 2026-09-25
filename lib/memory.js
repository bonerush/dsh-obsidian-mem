// Note lifecycle for the obsidian-mem vault (Task 8, spec §6.2/§6.3/§6.4, §10.4).
//
// One write is never one file. Creating a decision writes the note, appends it
// to its MOC's generated region and appends a receipt to `_meta/log.md`;
// superseding a decision additionally rewrites the old note's status and both
// bodies' links; appending to a day log may create that note. Every one of those
// bytes moves through Task 7's `runTransaction`, so the whole set is staged,
// published and rolled back together — this module never writes vault bytes by
// any other route.
//
// Four rules are enforced here rather than left to a caller.
//
//   * **Identity is the `id`, never the title, the path or the ADR number.** The
//     public `writeMemory` mints a random id when it is asked to create, and
//     treats a supplied `id` as *only* an update target: a title that already
//     exists is a second fact, and an id that does not resolve is refused instead
//     of silently creating anything. The internal `createMemoryWithId` accepts a
//     pre-assigned UUIDv4 (so a crash-retry replays the same identity) plus an
//     idempotency key, creates exclusively, and refuses an id that already
//     exists — it can never be mistaken for an update.
//   * **Ownership is proven from the note's own bytes.** A note is modified only
//     when it declares `trust: agent`, `harness: dsh` and an id from the §6.4
//     prefix table — which is what a plugin-created note carries, and which a
//     hand-written note does not. `trust: owner` is a hard refusal, and the
//     transaction engine re-checks the same evidence plus the note's current hash
//     inside the lock, so a note edited after the scan is refused rather than
//     overwritten.
//   * **A repeated idempotency key applies nothing.** The stored receipt is
//     returned before any target is planned, and the returned path/id are read
//     back from the receipt rather than recomputed (a second create would
//     otherwise pick a *different* basename because the first one now exists).
//   * **A memory that cannot be classified yet is parked, not forced.** The
//     explicit inbox destination (`inbox: true`, R33) writes the new note into
//     `Inbox/` while its frontmatter keeps the type the item actually is — the
//     §6.4 `type` vocabulary is never widened to gain a destination, and parking
//     a candidate burns no ADR number. A lifecycle or destination field on an
//     update is refused (`lifecycle-on-update` / `destination-on-update`) rather
//     than silently dropped: those fields describe creating a new fact, and a
//     silent drop would report success for a relink that never happened.
//
// `_meta/user.md` is never a target of any transaction built here: the user owns
// it and the plugin is read-only for it (§5.1/§6.1).
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  assertOwnedFrontmatter,
  findReceipt,
  LOG_RELATIVE_PATH,
  newTransactionId,
  parseNote,
  patchOwnedFields,
  resolveVaultFile,
  runTransaction,
  serializeOwnedValue,
} from './vault.js'
// `resolveDataRoot` is the one helper ./vault.js does not re-export; ./paths.js is
// the module that owns it (and the module ./vault.js itself imports it from).
import { resolveDataRoot } from './paths.js'
// `readNote` is the one reader that already enforces the vault jail, the
// indexability rule and the note-size bound, which is exactly the source
// contract a promotion needs.
import { readNote } from './index-db.js'
import {
  appendGeneratedLine,
  directoryFor,
  isValidNoteId,
  MemoryError,
  mocPathFor,
  normalizeType,
  noteIdFor,
  routeNote,
  sha256Hex,
  typePrefix,
  wikilinkLine,
} from './routing.js'

export { MemoryError, noteIdFor, sha256Hex, typePrefix }
export { routeNote } from './routing.js'

/** How many times a create re-plans its name after losing an exclusive-create race. */
const CREATE_ATTEMPTS = 3
/** The only status a brand-new note may start with when the caller names none. */
const DEFAULT_STATUS = 'active'
/** How many notes one id/path scan will read before giving up. */
const SCAN_LIMIT = 5_000
/** Notes larger than this are not scanned: a memory note is a small text file. */
const SCAN_MAX_BYTES = 1_048_576

/**
 * Validate and normalise the caller's dependency seam.
 *
 * `afterScan` is a test seam, in the same spirit as `./transaction.js`'s `io`:
 * it is invoked after a note has been scanned and before the transaction that
 * would rewrite it, so a test can produce the edit-that-lands-in-the-scan-window
 * that a real filesystem cannot be asked to raise on demand. Production never
 * passes it.
 *
 * @param {{ dataRoot?: string, home?: string, now?: Date, afterScan?: Function }} [deps] - plugin data root, home for `~/` decisions, the clock, and the scan seam.
 * @returns {{dataRoot: string, home: string, now: Date, afterScan: Function|null}} the normalised deps.
 * @throws {RangeError} when a value cannot be trusted.
 */
export function normalizeDeps(deps = {}) {
  if (deps === null || typeof deps !== 'object' || Array.isArray(deps))
    throw new RangeError('deps must be an object')
  const dataRoot = deps.dataRoot ?? resolveDataRoot()
  if (typeof dataRoot !== 'string' || dataRoot.trim() === '')
    throw new RangeError('deps.dataRoot must be a non-blank path')
  const home = deps.home ?? homedir()
  if (typeof home !== 'string' || home.trim() === '')
    throw new RangeError('deps.home must be a non-blank path')
  const now = deps.now ?? new Date()
  if (!(now instanceof Date) || Number.isNaN(now.getTime()))
    throw new RangeError('deps.now must be a valid Date')
  const afterScan = deps.afterScan ?? null
  if (afterScan !== null && typeof afterScan !== 'function')
    throw new RangeError('deps.afterScan must be a function')
  return { dataRoot, home, now, afterScan }
}

/**
 * The local `YYYY-MM-DD` a write is stamped with (R16: never `toISOString()`).
 *
 * @param {Date} now - the clock.
 * @returns {string} the local date.
 */
export function localDate(now) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/**
 * Serialize a whole new note from the §6.4 closed vocabulary.
 *
 * A brand-new file may be serialized whole; every value goes through
 * `serializeOwnedValue`, so the token is the one Obsidian's parser reads back as
 * the requested value (quoted text, a `tags` list, a bare local date).
 *
 * @param {Record<string, string|number|null|string[]>} fields - ordered owned fields.
 * @param {string} body - the note body.
 * @returns {string} the note text.
 */
export function renderNote(fields, body) {
  const lines = ['---']
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue
    lines.push(`${key}: ${serializeOwnedValue(key, value)}`)
  }
  lines.push('---')
  return `${lines.join('\n')}\n${body}`
}

/**
 * Replace a note's body while patching its frontmatter, byte-faithfully.
 *
 * `patchOwnedFields` only ever touches frontmatter bytes, so the patched prefix
 * can be spliced onto the next body verbatim. Both offsets come from the same
 * reader, which is what keeps CJK/emoji notes intact.
 *
 * @param {Buffer} original - current note bytes.
 * @param {string} nextText - the next body (identical up to the body offset).
 * @param {{ today: string, changes?: object }} options - `updated` value and extra owned fields.
 * @returns {Buffer} the next note bytes.
 */
export function spliceBody(original, nextText, { today, changes = {} }) {
  const note = parseNote(original)
  const patched = patchOwnedFields(original, { ...changes, updated: today }, sha256Hex(original))
  const patchedNote = parseNote(patched)
  const nextBytes = Buffer.from(nextText, 'utf8')
  return Buffer.concat([
    patched.subarray(0, patchedNote.bodyOffset),
    nextBytes.subarray(note.bodyOffset),
  ])
}

/**
 * Prove that a note was created by this plugin before it is modified.
 *
 * The evidence is in the note's own bytes: `trust: owner` is a human file by
 * declaration, and a plugin note carries `trust: agent`, `harness: dsh` and a
 * `id` from the §6.4 prefix table. Anything else — no frontmatter, another
 * harness, an id this plugin cannot have minted — leaves ownership unproven, and
 * an unprovable owner is a refusal rather than a repair.
 *
 * @param {object} note - a parsed note.
 * @param {string} vaultRelativePath - path used in diagnostics.
 * @param {{ expectId?: string }} [options] - the identity the caller believes it is editing.
 * @returns {void}
 * @throws {MemoryError} when the note is human-owned or not provably plugin-owned.
 */
export function assertPluginOwnedNote(note, vaultRelativePath, { expectId } = {}) {
  if (note === null || note.hasFrontmatter !== true) {
    throw new MemoryError(
      'ownership-unproven',
      `${vaultRelativePath} has no frontmatter, so plugin ownership cannot be proven`,
    )
  }
  const data = note.data ?? {}
  if (data.trust === 'owner') {
    throw new MemoryError(
      'human-owned',
      `${vaultRelativePath} declares trust:owner; the plugin never rewrites a human-owned note`,
    )
  }
  if (expectId !== undefined && data.id !== expectId) {
    throw new MemoryError(
      'ownership-mismatch',
      `${vaultRelativePath} carries id ${JSON.stringify(data.id)}, not ${JSON.stringify(expectId)}`,
    )
  }
  if (data.trust !== 'agent' || data.harness !== 'dsh' || !isValidNoteId(data.id)) {
    throw new MemoryError(
      'ownership-unproven',
      `${vaultRelativePath} has no plugin ownership evidence (trust:agent + harness:dsh + a §6.4 id), so it is never modified`,
    )
  }
}

/**
 * Prove that a plugin-managed container (the hot file, which carries no id) is
 * writable.
 *
 * @param {object} note - a parsed note.
 * @param {string} vaultRelativePath - path used in diagnostics.
 * @param {string} expectedType - the `type` value the container must declare.
 * @returns {void}
 * @throws {MemoryError} when the container is not plugin-owned.
 */
export function assertPluginOwnedContainer(note, vaultRelativePath, expectedType) {
  if (note === null || note.hasFrontmatter !== true) {
    throw new MemoryError(
      'ownership-unproven',
      `${vaultRelativePath} has no frontmatter, so plugin ownership cannot be proven`,
    )
  }
  const data = note.data ?? {}
  if (data.trust === 'owner') {
    throw new MemoryError(
      'human-owned',
      `${vaultRelativePath} declares trust:owner; the plugin never rewrites a human-owned note`,
    )
  }
  if (data.trust !== 'agent' || data.harness !== 'dsh' || data.type !== expectedType) {
    throw new MemoryError(
      'ownership-unproven',
      `${vaultRelativePath} is not a plugin-managed ${expectedType} file (trust:agent + harness:dsh), so it is never modified`,
    )
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Find a note by its stable id, anywhere in the bound project.
 *
 * There is no index in this task (Task 9 builds the rebuildable one), so the
 * lookup is a bounded scan of the project's own Markdown: that keeps identity
 * resolution honest — a title and a path are never used to find the target of an
 * update — and it never leaves the bound project directory.
 *
 * @param {object} binding - a `kind:'bound'` binding.
 * @param {string} id - the stable note id.
 * @param {{ dataRoot?: string, home?: string, now?: Date }} [deps] - dependency seam.
 * @returns {Promise<{id: string, path: string, bytes: Buffer, note: object, hash: string}|null>} the note, or `null`.
 * @throws {RangeError} when `id` is not a non-blank string.
 */
export async function findNoteById(binding, id, deps = {}) {
  if (typeof id !== 'string' || id.trim() === '')
    throw new RangeError('id must be a non-blank string')
  const { home } = normalizeDeps(deps)
  const projectDir = requireProjectDirectory(binding)
  const root = await resolveVaultFile(binding.vaultRoot, projectDir, { home })
  for (const relative of await listNotePaths(root)) {
    const absolute = join(root, ...relative.split('/'))
    let bytes
    try {
      bytes = await fs.readFile(absolute)
    } catch {
      continue
    }
    let note
    try {
      note = parseNote(bytes)
    } catch {
      continue
    }
    if (note.data?.id === id) {
      return { id, path: `${projectDir}/${relative}`, bytes, note, hash: sha256Hex(bytes) }
    }
  }
  return null
}

/**
 * Read one note by id, or refuse.
 *
 * @param {object} binding - a `kind:'bound'` binding.
 * @param {string} id - the stable note id.
 * @param {{ dataRoot?: string, home?: string, now?: Date }} [deps] - dependency seam.
 * @returns {Promise<{id: string, path: string, frontmatter: object, body: string, hash: string}>} the note view.
 * @throws {MemoryError} with code `note-not-found`.
 */
export async function readNoteById(binding, id, deps = {}) {
  const found = await findNoteById(binding, id, deps)
  if (found === null)
    throw new MemoryError(
      'note-not-found',
      `no note in ${requireProjectDirectory(binding)} carries id ${JSON.stringify(id)}`,
    )
  return {
    id,
    path: found.path,
    frontmatter: found.note.data,
    body: found.note.body,
    hash: found.hash,
  }
}

// ---------------------------------------------------------------------------
// writeMemory / createMemoryWithId
// ---------------------------------------------------------------------------

/**
 * Write a memory: create a new note, or update an existing one by id.
 *
 * A create accepts `inbox: true` to park a low-confidence candidate in `Inbox/`
 * (R33) while keeping its real `type`; an update refuses `inbox`, `supersedes`
 * and `contestedWith` instead of dropping them.
 *
 * @param {object} binding - a `kind:'bound'` binding.
 * @param {object} request - the write request (`WriteRequest`, plus `inbox`).
 * @param {{ dataRoot?: string, home?: string, now?: Date, afterScan?: Function }} [deps] - dependency seam.
 * @returns {Promise<{id: string, path: string, receipt: object}>} the written identity, path and receipt.
 * @throws {MemoryError} on every policy refusal; `code` names the reason.
 * @throws {TransactionError} when the transaction engine refuses the write.
 */
export async function writeMemory(binding, request, deps = {}) {
  const options = normalizeDeps(deps)
  assertRequest(request)
  const replay = await replayReceipt(binding, request.idempotencyKey, options)
  if (replay !== null) return replay
  if (request.id !== undefined && request.id !== null) return updateNote(binding, request, options)
  return createNote(binding, request, options, { preassignedId: null })
}

/**
 * Create a note under a pre-assigned identity, exclusively.
 *
 * This is the internal creation path for automatic distillation (spec §6.4):
 * the caller persists the UUIDv4 and the idempotency key *before* the first
 * attempt, so a crash-retry replays the same identity. It looks for a successful
 * receipt first, then refuses an id or a path that is already taken — it never
 * falls back to updating an existing note.
 *
 * It is deliberately not registered as a tool: `mem_write(id=…)` always means
 * "update", and only this function means "create with this id".
 *
 * @param {object} binding - a `kind:'bound'` binding.
 * @param {object} request - `{ preassignedId, idempotencyKey, …WriteRequest }`.
 * @param {{ dataRoot?: string, home?: string, now?: Date }} [deps] - dependency seam.
 * @returns {Promise<{id: string, path: string, receipt: object}>} the written identity, path and receipt.
 * @throws {MemoryError} with code `id-taken` when the id already exists.
 */
export async function createMemoryWithId(binding, request, deps = {}) {
  const options = normalizeDeps(deps)
  assertRequest(request)
  const preassignedId = request.preassignedId
  if (!isValidNoteId(preassignedId)) {
    throw new RangeError(
      `preassignedId must be "<known prefix>-<UUIDv4>": ${JSON.stringify(preassignedId)}`,
    )
  }
  const kind = normalizeType(request.type)
  if (typePrefix(kind) !== preassignedId.slice(0, 3)) {
    throw new RangeError(
      `preassignedId ${preassignedId} does not carry the ${typePrefix(kind)}- prefix of type ${kind}`,
    )
  }
  const replay = await replayReceipt(binding, request.idempotencyKey, options)
  if (replay !== null) return replay
  return createNote(binding, { ...request, id: undefined }, options, { preassignedId })
}

// ---------------------------------------------------------------------------
// The automatic capture path (Task 16)
// ---------------------------------------------------------------------------

/**
 * The refusals that mean "the supersede target moved under us".
 *
 * Every one of them names the target's own bytes or path, so falling back to the
 * inbox can never mask a failure of the candidate itself. The ownership refusals
 * are deliberately NOT here: `ownership-unproven` is also what a MOC container
 * raises, and a target that turned human-owned is already caught deterministically
 * by the pre-check below (with a precise `human-owned` reason).
 */
const SUPERSEDE_REFUSALS = new Set([
  'hash-mismatch',
  'target-changed',
  'note-missing',
  'note-not-found',
])

/**
 * Apply one validated distillation candidate through the internal create path.
 *
 * This is the only vault writer Task 16's queue worker uses. It is deliberately
 * NOT `writeMemory`: a candidate always creates, never updates, and the identity
 * (`preassignedId` + `idempotencyKey`) was persisted before this call, so a crash
 * retry replays the same note instead of minting an ADR number or a log entry a
 * second time.
 *
 * **The supersede guard (constraint 7).** An automatic supersede happens only
 * when all three checks pass:
 *
 *   1. the target still exists in this project and its id resolves (`findNoteById`);
 *   2. its own bytes prove plugin ownership (`trust:agent` + `harness:dsh` + a
 *      §6.4 id) — a `trust:owner` note is never touched;
 *   3. the hash read by THIS pre-check is the hash the transaction must still see
 *      under the vault lock (`expectedSupersedesHash`). A note edited by hand
 *      between the pre-check and the write makes the engine refuse with
 *      `hash-mismatch` instead of overwriting the newer revision.
 *
 * When any check fails the candidate is not dropped and the old file is not
 * touched: the same fact is created in the explicit inbox destination (`Inbox/`,
 * R33) and the refusal is reported on `conflicts` so Task 16's receipt can show
 * exactly why. `afterScan` is the same test seam `updateNote` uses; it runs after
 * the pre-check and before the transaction, which is what makes the hash race
 * reproducible.
 *
 * @param {object} binding - a `kind:'bound'` binding.
 * @param {object} job - the pending job the candidate came from (`sessionId` is recorded on the note).
 * @param {object} item - a validated candidate (`type/title/body/tags/confidence/assertion/status/supersedesId` + `preassignedId`/`idempotencyKey`/`inbox`).
 * @param {{ dataRoot?: string, home?: string, now?: Date, afterScan?: Function }} [deps] - dependency seam.
 * @returns {Promise<{id: string, path: string, receipt: object, superseded: boolean, inbox: boolean, conflicts: object[]}>} the written identity and what happened to the supersede target.
 * @throws {MemoryError} / {TransactionError} when the write itself is refused for a reason that is not a supersede race.
 */
export async function applyCandidate(binding, job, item, deps = {}) {
  const options = normalizeDeps(deps)
  if (item === null || typeof item !== 'object' || Array.isArray(item)) {
    throw new RangeError('an applied candidate must be a plain object')
  }
  const kind = normalizeType(item.type)
  const conflicts = []
  let supersedesId = item.supersedesId ?? null
  let expectedSupersedesHash = null

  if (supersedesId !== null) {
    const found = await findNoteById(binding, supersedesId, options)
    if (found === null) {
      conflicts.push({ supersedesId, reason: 'note-not-found' })
      supersedesId = null
    } else {
      try {
        assertPluginOwnedNote(found.note, found.path, { expectId: supersedesId })
        expectedSupersedesHash = found.hash
      } catch (error) {
        conflicts.push({
          supersedesId,
          reason: typeof error?.code === 'string' ? error.code : 'ownership-unproven',
        })
        supersedesId = null
      }
      // The seam runs OUTSIDE the ownership guard: it is a test/caller hook, and
      // its own failure must never be misread as "this target is not ours".
      if (supersedesId !== null && options.afterScan !== null) {
        await options.afterScan({ path: found.path, id: supersedesId, hash: found.hash })
      }
    }
  }

  const inbox = item.inbox === true || conflicts.length > 0
  const request = (supersedes, destination) => ({
    preassignedId: item.preassignedId,
    idempotencyKey: item.idempotencyKey,
    type: kind,
    title: item.title,
    body: item.body,
    ...(Array.isArray(item.tags) ? { tags: item.tags } : {}),
    ...(typeof item.confidence === 'number' ? { confidence: item.confidence } : {}),
    ...(typeof item.assertion === 'string' ? { assertion: item.assertion } : {}),
    ...(typeof item.status === 'string' ? { status: item.status } : {}),
    session: typeof job?.sessionId === 'string' && job.sessionId !== '' ? job.sessionId : null,
    inbox: destination,
    ...(supersedes === null ? {} : { supersedes, expectedSupersedesHash }),
  })

  try {
    const written = await createMemoryWithId(binding, request(supersedesId, inbox), options)
    return { ...written, superseded: supersedesId !== null, inbox, conflicts }
  } catch (error) {
    if (supersedesId === null || !SUPERSEDE_REFUSALS.has(error?.code)) throw error
    // The old file moved (or was edited, or is human-owned). Never overwrite it:
    // park the candidate in the inbox under the same pre-assigned identity and
    // report the refusal. The failed attempt stored no receipt, so this retry is
    // a genuinely new create — and it takes no ADR number, because the inbox is
    // not a decision yet (R33).
    conflicts.push({ supersedesId, reason: error.code })
    const written = await createMemoryWithId(binding, request(null, true), options)
    return { ...written, superseded: false, inbox: true, conflicts }
  }
}

// ---------------------------------------------------------------------------
// Promotion (Task 17, design §11)
// ---------------------------------------------------------------------------

/** The cross-project methodology directory (§6.2): the one route outside `Projects/`. */
const METHOD_DIRECTORY_PREFIX = 'Methods/'

/**
 * Promote one project note into a new cross-project `Methods/` note.
 *
 * A promotion *copies* a fact that has outgrown its project; it never moves,
 * rewrites or deletes the original. The new note carries a link back to its
 * source (a vault-relative wikilink the lint's dead-link check can resolve) and
 * the source's body, and it is created exclusively like every other note — a
 * second promotion of the same source is a second note, never an overwrite.
 *
 * @param {object} binding - a `kind:'bound'` binding.
 * @param {{path: string, title?: string}} request - the source note and an optional override title.
 * @param {{ dataRoot?: string, home?: string, now?: Date }} [deps] - dependency seam.
 * @returns {Promise<{id: string, path: string, receipt: object, source: string, moved: boolean}>} the new note's identity.
 * @throws {MemoryError} with code `already-method`, `note-not-found` or `source-frontmatter-broken`.
 * @throws {PathSafetyError} when the path escapes the vault or walks through a symlink.
 * @throws {RangeError} when the request is malformed.
 */
export async function promoteNote(binding, request = {}, deps = {}) {
  const options = normalizeDeps(deps)
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    throw new RangeError('a promote request object is required')
  }
  const path = request.path
  if (typeof path !== 'string' || path.trim() === '') {
    throw new RangeError('promote needs the vault-relative path of the source note')
  }
  if (path.startsWith(METHOD_DIRECTORY_PREFIX)) {
    throw new MemoryError(
      'already-method',
      `${path} already lives in ${METHOD_DIRECTORY_PREFIX}; a promotion creates a cross-project note from a project fact and never rewrites one in place`,
    )
  }
  // Resolve and check the source before reading it, so "there is no such note"
  // is the documented `note-not-found` rather than whatever a reader happens to
  // throw for a missing path. The resolution is the vault jail's, so a traversal
  // or a symlink is still refused before any read.
  const sourceAbsolute = await resolveVaultFile(binding.vaultRoot, path, { home: options.home })
  if ((await lstatOrNull(sourceAbsolute)) === null) {
    throw new MemoryError('note-not-found', `no note exists at ${path} in this vault`)
  }
  const source = await readNote(binding.vaultRoot, path, undefined, { home: options.home })
  if (source.parseError !== null) {
    throw new MemoryError(
      'source-frontmatter-broken',
      `${path} has frontmatter that does not parse (${source.parseError.code}); fix the note before promoting it`,
    )
  }
  const requested = typeof request.title === 'string' ? request.title.trim() : ''
  const title = requested !== '' ? requested : (source.title ?? sourceStem(path))
  const sourceTitle = source.title ?? title
  const body = `- 来源：[[${path.replace(/\.md$/i, '')}|${sourceTitle}]]\n\n${source.body ?? ''}`
  const written = await createNote(binding, { type: 'method', title, body }, options, {
    preassignedId: null,
  })
  return { ...written, source: path, moved: false }
}

/** `lstat` that reports absence as `null` and every other failure as a throw. */
async function lstatOrNull(path) {
  try {
    return await fs.lstat(path)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

/** The basename of a vault-relative note path, without its `.md`. */
function sourceStem(path) {
  const name = String(path).slice(String(path).lastIndexOf('/') + 1)
  const stem = name.replace(/\.md$/i, '')
  return stem.trim() === '' ? 'Methods' : stem
}

// ---------------------------------------------------------------------------
// appendLog
// ---------------------------------------------------------------------------

/**
 * Append one session block to a day's cold log (`Daily/YYYY-MM-DD.md`, §6.2).
 *
 * The day note is created if it is missing and never rewritten elsewhere: the
 * append goes through a transform that reads the bytes inside the vault lock, so
 * two sessions appending to the same day cannot lose each other's block. Two
 * kinds of idempotence are enforced: a repeated `idempotencyKey` returns the
 * original receipt without touching the vault, and a repeated
 * `session`+`seq`/`section` marker makes the append a content-level no-op even
 * under a fresh key.
 *
 * @param {object} binding - a `kind:'bound'` binding.
 * @param {{ text: string, session: string, section?: string, seq?: number|string, idempotencyKey?: string }} request - the block to append.
 * @param {{ dataRoot?: string, home?: string, now?: Date }} [deps] - dependency seam.
 * @returns {Promise<object>} the transaction receipt.
 */
export async function appendLog(binding, request, deps = {}) {
  const options = normalizeDeps(deps)
  const { dataRoot, home } = options
  assertRequest(request)
  const today = localDate(options.now)
  const session = requireText(request.session, 'session')
  const section =
    request.section === undefined || request.section === null
      ? '会话'
      : requireText(request.section, 'section')
  const text = requireText(request.text, 'text')
  const discriminator =
    request.seq === undefined || request.seq === null ? section : String(request.seq)
  const idempotencyKey = request.idempotencyKey ?? null
  if (idempotencyKey !== null) {
    const stored = await findReceipt(binding, idempotencyKey, options)
    if (stored !== null) return stored
  }

  const path = routeNote(binding, 'session-log', '', { today })
  const heading = `## ${session} · ${section}`
  const marker = `<!-- mem-log:${session}:${discriminator} -->`
  const transform = (current) => {
    if (current !== null) {
      const note = parseNote(current)
      assertPluginOwnedNote(note, path)
      const noteText = current.toString('utf8')
      if (noteText.includes(marker)) return null
      const nextText = insertLogBlock(noteText, heading, text, marker)
      const next = spliceBody(current, nextText, { today })
      return next.equals(current) ? null : next
    }
    const body = `# ${today}\n\n${heading}\n\n${text}\n\n${marker}\n`
    const fresh = renderNote(logFields(binding, today), body)
    assertOwnedFrontmatter(fresh, { path })
    return Buffer.from(fresh, 'utf8')
  }

  return runTransaction(
    binding,
    {
      txId: newTransactionId(),
      idempotencyKey,
      updates: [{ path, hash: '*', transform }],
      receipt: {
        action: 'log',
        sessionId: session,
        fromSeq: numericSeq(request.seq),
        toSeq: numericSeq(request.seq),
      },
    },
    { dataRoot, home },
  )
}

// ---------------------------------------------------------------------------
// Planning: create
// ---------------------------------------------------------------------------

/**
 * Plan and apply the creation of one note.
 *
 * @param {object} binding - a `kind:'bound'` binding.
 * @param {object} request - the write request.
 * @param {object} options - normalised deps.
 * @param {{ preassignedId: string|null }} intent - the internal exclusive-create id, when there is one.
 * @returns {Promise<{id: string, path: string, receipt: object}>} the written identity, path and receipt.
 */
async function createNote(binding, request, options, { preassignedId }) {
  const { dataRoot, home } = options
  const today = localDate(options.now)
  const kind = normalizeType(request.type)
  const title = requireText(request.title, 'title').trim()
  if (title === '') throw new RangeError('title must be a non-blank string')
  const inbox = requireFlag(request.inbox, 'inbox')
  const id = preassignedId ?? noteIdFor(kind)

  if (preassignedId !== null && (await findNoteById(binding, preassignedId, options)) !== null) {
    throw new MemoryError(
      'id-taken',
      `${preassignedId} already exists in this project; createMemoryWithId creates exclusively and never overwrites an id`,
    )
  }
  const supersedes = await relatedNote(binding, request.supersedes, options, 'supersedes')
  const contested = await relatedNote(binding, request.contestedWith, options, 'contestedWith')
  if (supersedes !== null && contested !== null) {
    throw new RangeError('supersedes and contestedWith cannot be combined in one write')
  }
  // A caller that already read the supersede target (the automatic capture path)
  // pins the hash it saw, so an edit landing between that read and the vault lock
  // is refused by the engine instead of being overwritten. A caller that supplies
  // none keeps the behaviour of every existing write: the hash of the scan this
  // function just performed.
  const supersedesHash =
    supersedes !== null &&
    typeof request.expectedSupersedesHash === 'string' &&
    request.expectedSupersedesHash !== ''
      ? request.expectedSupersedesHash
      : (supersedes?.hash ?? null)

  let lastError = null
  for (let attempt = 0; attempt < CREATE_ATTEMPTS; attempt += 1) {
    // The ADR number is re-allocated per attempt, under the allocator's own
    // read: a lost exclusive-create race must move to the next number instead of
    // trying to take the one another writer just published. A candidate parked in
    // the inbox is not a decision yet, so it takes no number at all (R33).
    const adrNumber = kind === 'decision' && !inbox ? await nextAdrNumber(binding, options) : 1
    const destination = directoryFor(binding, kind, { inbox })
    const existingNames =
      kind === 'session-log' ? [] : await listNames(binding, destination, options)
    const path = routeNote(binding, kind, title, { today, adrNumber, existingNames, inbox })
    const plan = buildCreatePlan({
      binding,
      request,
      kind,
      id,
      title,
      path,
      today,
      supersedes,
      contested,
      inbox,
      supersedesHash,
    })
    try {
      const receipt = await runTransaction(binding, plan, { dataRoot, home })
      return { id, path: receipt.paths[0] ?? path, receipt }
    } catch (error) {
      if (error?.code === 'target-exists') {
        lastError = error
        continue
      }
      throw error
    }
  }
  throw lastError
}

/**
 * Build the transaction that creates a note plus its MOC entry and relinks.
 *
 * @param {object} input - the plan inputs (`supersedesHash` pins the hash the caller read, when there is one).
 * @returns {object} a `runTransaction` request.
 */
function buildCreatePlan({
  binding,
  request,
  kind,
  id,
  title,
  path,
  today,
  supersedes,
  contested,
  inbox = false,
  supersedesHash = null,
}) {
  const fields = newNoteFields({ binding, request, kind, id, title, today, supersedes, contested })
  const links = []
  if (supersedes !== null)
    links.push(`- 取代 [[${noExtension(supersedes.path)}|${supersedes.title}]]。\n`)
  if (contested !== null)
    links.push(
      `- 与 [[${noExtension(contested.path)}|${contested.title}]] 并存（contested，双方证据保留）。\n`,
    )
  const body = `${normalizeBody(request.body)}${links.join('')}`
  const contents = renderNote(fields, body)
  assertOwnedFrontmatter(contents, { path })

  const updates = []
  if (supersedes !== null) {
    updates.push({
      path: supersedes.path,
      own: { id: supersedes.id },
      // The hash the scan read (or the hash the automatic path pinned before it
      // scanned): the engine refuses the update if the note moved on between that
      // read and the lock (spec: "当前哈希匹配").
      hash: supersedesHash ?? supersedes.hash,
      transform: relinkTransform(supersedes, {
        today,
        changes: { status: 'superseded', superseded_by: id },
        linkLine: `- 已被 [[${noExtension(path)}|${title}]] 取代。\n`,
      }),
    })
  }
  if (contested !== null) {
    updates.push({
      path: contested.path,
      own: { id: contested.id },
      hash: contested.hash,
      transform: relinkTransform(contested, {
        today,
        changes: { status: 'contested' },
        linkLine: `- 与 [[${noExtension(path)}|${title}]] 并存（contested，双方证据保留）。\n`,
      }),
    })
  }
  const moc = mocPathFor(binding, kind, { inbox })
  if (moc !== null)
    updates.push({
      path: moc,
      transform: generatedLineAppender(moc, wikilinkLine(path, title), today),
    })

  return {
    txId: newTransactionId(),
    idempotencyKey: request.idempotencyKey ?? null,
    creates: [{ path, contents }],
    updates,
    receipt: { action: 'write', sessionId: request.session ?? null },
  }
}

/**
 * The ordered §6.4 frontmatter of a brand-new note.
 *
 * @param {object} input - the field inputs.
 * @returns {object} the owned fields, in vocabulary order.
 */
function newNoteFields({ binding, request, kind, id, title, today, supersedes, contested }) {
  const project = kind === 'method' ? null : binding.projectId
  const tags =
    request.tags === undefined || request.tags === null
      ? project === null
        ? [`dsh-mem/${kind}`]
        : [`dsh-mem/${kind}`, `project/${binding.slug}`]
      : request.tags
  return {
    id,
    type: kind,
    title,
    status: request.status ?? (contested !== null ? 'contested' : defaultStatus(kind)),
    created: today,
    updated: today,
    tags,
    project,
    source: request.source ?? 'agent',
    session: request.session ?? null,
    harness: 'dsh',
    trust: 'agent',
    confidence: request.confidence,
    assertion: request.assertion,
    supersedes: supersedes === null ? null : supersedes.id,
    superseded_by: null,
    review_after: request.review_after,
  }
}

/**
 * The default status of a new note of a type, before the caller overrides it.
 *
 * @param {string} kind - routing kind.
 * @returns {string} a `status` from the §6.4 vocabulary.
 */
function defaultStatus(kind) {
  return kind === 'decision' ? 'proposed' : DEFAULT_STATUS
}

/**
 * Rebuild an existing note's status and add one link to its body.
 *
 * The body is preserved byte-for-byte and the link is appended to it, so the old
 * evidence is never deleted by a supersede or a contest (§6.3, "不删除旧笔记").
 *
 * @param {{path: string, id: string}} target - the note being relinked.
 * @param {{ today: string, changes: object, linkLine: string }} input - the changes to apply.
 * @returns {Function} a transaction transform.
 */
function relinkTransform(target, { today, changes, linkLine }) {
  return (current) => {
    if (current === null) {
      throw new MemoryError(
        'note-missing',
        `${target.path} disappeared before the transaction could update it`,
      )
    }
    const note = parseNote(current)
    assertPluginOwnedNote(note, target.path, { expectId: target.id })
    const patched = patchOwnedFields(current, { ...changes, updated: today }, sha256Hex(current))
    const patchedNote = parseNote(patched)
    const next = Buffer.concat([
      patched.subarray(0, patchedNote.bodyOffset),
      Buffer.from(`${note.body}${linkLine}`, 'utf8'),
    ])
    return next.equals(current) ? null : next
  }
}

/**
 * A transform that appends one line to a MOC's generated region (R24).
 *
 * @param {string} mocPath - the MOC's vault-relative path.
 * @param {string} line - the entry line.
 * @param {string} today - the local date for the MOC's `updated`.
 * @returns {Function} a transaction transform.
 */
function generatedLineAppender(mocPath, line, today) {
  return (current) => {
    if (current === null) {
      throw new MemoryError(
        'moc-missing',
        `${mocPath} is missing; bootstrap the project before writing memories`,
      )
    }
    const note = parseNote(current)
    assertPluginOwnedContainer(note, mocPath, 'hub')
    const next = appendGeneratedLine(current.toString('utf8'), line)
    if (next === null) return null
    const nextBytes = spliceBody(current, next, { today })
    return nextBytes.equals(current) ? null : nextBytes
  }
}

// ---------------------------------------------------------------------------
// Planning: update
// ---------------------------------------------------------------------------

/**
 * Update an existing note, found by its id.
 *
 * A lifecycle or destination field is refused rather than ignored: `supersedes`
 * and `contestedWith` describe *creating* a new fact, and `inbox` describes where
 * a new note lands. Silently dropping them would report success for a relink that
 * never happened, so they fail the same way a `type` change does.
 *
 * @param {object} binding - a `kind:'bound'` binding.
 * @param {object} request - the write request carrying `id`.
 * @param {object} options - normalised deps.
 * @returns {Promise<{id: string, path: string, receipt: object}>} the updated identity, path and receipt.
 */
async function updateNote(binding, request, options) {
  const { dataRoot, home } = options
  const today = localDate(options.now)
  for (const field of ['supersedes', 'contestedWith']) {
    if (request[field] !== undefined && request[field] !== null) {
      throw new MemoryError(
        'lifecycle-on-update',
        `${field} is a lifecycle field of a new note; an update to ${JSON.stringify(request.id)} cannot relink an existing note`,
      )
    }
  }
  if (requireFlag(request.inbox, 'inbox')) {
    throw new MemoryError(
      'destination-on-update',
      `inbox is a destination for a new note; moving an existing note is an explicit promote, not an in-place update`,
    )
  }
  const found = await findNoteById(binding, request.id, options)
  if (found === null) {
    throw new MemoryError(
      'note-not-found',
      `no note in ${requireProjectDirectory(binding)} carries id ${JSON.stringify(request.id)}; mem_write creates with a random id and updates only a known id`,
    )
  }
  assertPluginOwnedNote(found.note, found.path, { expectId: request.id })
  const kind = normalizeType(found.note.data.type)
  if (request.type !== undefined && request.type !== null && normalizeType(request.type) !== kind) {
    throw new MemoryError(
      'type-mismatch',
      `${found.path} is a ${kind} note; a type change is a new fact, not an update`,
    )
  }
  const transform = updateTransform({ path: found.path, id: request.id, request, today })
  if (options.afterScan !== null)
    await options.afterScan({ path: found.path, id: request.id, hash: found.hash })
  const receipt = await runTransaction(
    binding,
    {
      txId: newTransactionId(),
      idempotencyKey: request.idempotencyKey ?? null,
      updates: [
        {
          path: found.path,
          own: { id: request.id },
          // The hash the scan read. The engine compares it with the bytes it reads
          // under the lock, so an edit that landed between the scan and the
          // transaction is refused instead of being overwritten.
          hash: found.hash,
          transform,
        },
      ],
      receipt: { action: 'write', sessionId: request.session ?? null },
    },
    { dataRoot, home },
  )
  return { id: request.id, path: found.path, receipt }
}

/**
 * Build the read-modify-write transform of a note update.
 *
 * A request that changes nothing semantically returns `null`, which the
 * transaction records as a no-op and writes no bytes — R23 forbids rewriting a
 * file merely to refresh its metadata.
 *
 * @param {{path: string, id: string, request: object, today: string}} input - the target and the changes.
 * @returns {Function} a transaction transform.
 */
function updateTransform({ path, id, request, today }) {
  return (current) => {
    if (current === null) {
      throw new MemoryError(
        'note-missing',
        `${path} disappeared before the transaction could update it`,
      )
    }
    const note = parseNote(current)
    assertPluginOwnedNote(note, path, { expectId: id })
    const changes = {}
    if (request.title !== undefined) changes.title = requireText(request.title, 'title').trim()
    if (request.status !== undefined) changes.status = requireText(request.status, 'status')
    if (request.tags !== undefined) changes.tags = request.tags
    if (request.confidence !== undefined) changes.confidence = request.confidence
    if (request.assertion !== undefined) changes.assertion = request.assertion
    if (request.review_after !== undefined) changes.review_after = request.review_after
    const nextBody = request.body === undefined ? null : normalizeBody(request.body)
    const bodyChanged = nextBody !== null && nextBody !== note.body
    if (bodyChanged) changes.updated = today
    const patched =
      Object.keys(changes).length === 0
        ? current
        : patchOwnedFields(current, changes, sha256Hex(current))
    if (!bodyChanged) return patched.equals(current) ? null : patched
    const patchedNote = parseNote(patched)
    const next = Buffer.concat([
      patched.subarray(0, patchedNote.bodyOffset),
      Buffer.from(nextBody, 'utf8'),
    ])
    return next.equals(current) ? null : next
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * Return the receipt a repeated idempotency key must replay.
 *
 * The identity and path come from the receipt itself, never from a fresh plan:
 * re-planning would pick a different basename (the first one now exists) and
 * could return a path that was never written.
 *
 * @param {object} binding - a `kind:'bound'` binding.
 * @param {string|undefined|null} idempotencyKey - the caller's replay key.
 * @param {object} options - normalised deps.
 * @returns {Promise<{id: string, path: string, receipt: object}|null>} the replay, or `null` when the key is new.
 */
async function replayReceipt(binding, idempotencyKey, options) {
  if (idempotencyKey === undefined || idempotencyKey === null) return null
  if (typeof idempotencyKey !== 'string' || idempotencyKey === '') {
    throw new RangeError('idempotencyKey must be a non-blank string when present')
  }
  const stored = await findReceipt(binding, idempotencyKey, options)
  if (stored === null) return null
  const path = (stored.paths ?? []).find(
    (candidate) => candidate.endsWith('.md') && candidate !== LOG_RELATIVE_PATH,
  )
  if (path === undefined) {
    throw new MemoryError(
      'receipt-corrupt',
      `receipt ${stored.txId} names no note path, so the replay cannot be resolved`,
    )
  }
  const found = await findNoteByPath(binding, path, options)
  if (found === null || typeof found.note?.data?.id !== 'string') {
    throw new MemoryError(
      'receipt-note-missing',
      `receipt ${stored.txId} names ${path}, which is no longer a plugin note in the vault`,
    )
  }
  return { id: found.note.data.id, path, receipt: stored }
}

/**
 * Read one note by its vault-relative path.
 *
 * @param {object} binding - a `kind:'bound'` binding.
 * @param {string} path - vault-relative path.
 * @param {object} options - normalised deps.
 * @returns {Promise<{note: object, bytes: Buffer, hash: string}|null>} the note, or `null` when absent or unreadable.
 */
async function findNoteByPath(binding, path, options) {
  let absolute
  try {
    absolute = await resolveVaultFile(binding.vaultRoot, path, { home: options.home })
  } catch {
    return null
  }
  let bytes
  try {
    bytes = await fs.readFile(absolute)
  } catch {
    return null
  }
  try {
    return { note: parseNote(bytes), bytes, hash: sha256Hex(bytes) }
  } catch {
    return null
  }
}

/**
 * Load the note a `supersedes`/`contestedWith` request points at.
 *
 * @param {object} binding - a `kind:'bound'` binding.
 * @param {string|undefined|null} id - the related note id.
 * @param {object} options - normalised deps.
 * @param {string} field - field name for diagnostics.
 * @returns {Promise<{id: string, path: string, title: string}|null>} the related note, or `null`.
 */
async function relatedNote(binding, id, options, field) {
  if (id === undefined || id === null) return null
  if (typeof id !== 'string' || id.trim() === '')
    throw new RangeError(`${field} must be a non-blank id`)
  const found = await findNoteById(binding, id, options)
  if (found === null)
    throw new MemoryError(
      'note-not-found',
      `${field} names ${id}, which does not exist in this project`,
    )
  assertPluginOwnedNote(found.note, found.path, { expectId: id })
  return { id, path: found.path, title: String(found.note.data.title ?? id), hash: found.hash }
}

/**
 * The next free ADR number for a project (§6.4).
 *
 * The number is human-readable ordering only, so this is a best-effort read of
 * the directory; the real guarantee is the exclusive create in
 * `runTransaction`, and a lost race re-allocates instead of overwriting.
 *
 * @param {object} binding - a `kind:'bound'` binding.
 * @param {object} options - normalised deps.
 * @returns {Promise<number>} the highest existing number plus one.
 */
async function nextAdrNumber(binding, options) {
  const names = await listNames(binding, directoryFor(binding, 'decision'), options)
  let highest = 0
  for (const name of names) {
    const match = /^ADR-(\d+)-/.exec(name)
    if (match !== null) highest = Math.max(highest, Number(match[1]))
  }
  return highest + 1
}

/**
 * The names in one vault-relative directory, or an empty list when it is absent.
 *
 * @param {object} binding - a `kind:'bound'` binding.
 * @param {string} relativeDir - vault-relative directory.
 * @param {object} options - normalised deps.
 * @returns {Promise<string[]>} the entry names.
 */
async function listNames(binding, relativeDir, options) {
  const absolute = await resolveVaultFile(binding.vaultRoot, relativeDir, { home: options.home })
  try {
    return await fs.readdir(absolute)
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

/**
 * Every `.md` path inside a directory tree, sorted, with dot-directories,
 * symlinks and oversized files skipped.
 *
 * @param {string} root - absolute directory.
 * @returns {Promise<string[]>} paths relative to `root`, using `/`.
 */
async function listNotePaths(root) {
  const found = []
  const queue = ['']
  while (queue.length > 0 && found.length < SCAN_LIMIT) {
    const relative = queue.shift()
    const absolute = relative === '' ? root : join(root, ...relative.split('/'))
    let entries
    try {
      entries = await fs.readdir(absolute, { withFileTypes: true })
    } catch {
      continue
    }
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue
      const child = relative === '' ? entry.name : `${relative}/${entry.name}`
      if (entry.isDirectory()) {
        queue.push(child)
        continue
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue
      try {
        if ((await fs.stat(join(root, ...child.split('/')))).size > SCAN_MAX_BYTES) continue
      } catch {
        continue
      }
      found.push(child)
      if (found.length >= SCAN_LIMIT) break
    }
  }
  return found
}

/**
 * Ensure a body is newline-terminated, so the next appended line is its own.
 *
 * @param {unknown} body - the caller's body.
 * @returns {string} the body.
 */
function normalizeBody(body) {
  if (body === undefined || body === null) return ''
  if (typeof body !== 'string') throw new RangeError('body must be a string')
  if (body === '') return ''
  return body.endsWith('\n') ? body : `${body}\n`
}

/**
 * Insert one log block under its session heading, or append a new heading.
 *
 * @param {string} noteText - the day log.
 * @param {string} heading - the session/section heading line.
 * @param {string} text - the block text.
 * @param {string} marker - the idempotence marker.
 * @returns {string} the next day log.
 */
function insertLogBlock(noteText, heading, text, marker) {
  const fragment = `\n${text}\n\n${marker}\n`
  const headingLine = `${heading}\n`
  const headingAt = noteText.startsWith(headingLine) ? 0 : noteText.indexOf(`\n${headingLine}`)
  if (headingAt === -1) {
    const base = noteText.endsWith('\n') ? noteText : `${noteText}\n`
    return `${base}\n${heading}\n${fragment}`
  }
  const sectionStart = headingAt === 0 ? 0 : headingAt + 1
  const next = noteText.indexOf('\n## ', sectionStart + headingLine.length)
  if (next === -1)
    return noteText.endsWith('\n') ? `${noteText}${fragment}` : `${noteText}\n${fragment}`
  return `${noteText.slice(0, next + 1)}${fragment}${noteText.slice(next + 1)}`
}

/**
 * The ordered §6.4 frontmatter of a fresh day log.
 *
 * @param {object} binding - a `kind:'bound'` binding.
 * @param {string} today - the local date.
 * @returns {object} the owned fields.
 */
function logFields(binding, today) {
  return {
    id: noteIdFor('session-log'),
    type: 'session-log',
    title: `${today} 会话日志`,
    status: 'active',
    created: today,
    updated: today,
    tags: ['dsh-mem/session-log', `project/${binding.slug}`],
    project: binding.projectId,
    source: 'agent',
    session: null,
    harness: 'dsh',
    trust: 'agent',
    superseded_by: null,
  }
}

/**
 * The `fromSeq`/`toSeq` a log receipt records, when the caller supplied one.
 *
 * @param {unknown} seq - the caller's sequence number.
 * @returns {number|null} the number, or `null`.
 */
function numericSeq(seq) {
  return Number.isSafeInteger(seq)
    ? seq
    : typeof seq === 'string' && /^\d+$/.test(seq)
      ? Number(seq)
      : null
}

/**
 * Require a non-blank string field.
 *
 * @param {unknown} value - candidate.
 * @param {string} field - field name for the diagnostic.
 * @returns {string} the value.
 * @throws {RangeError} when it is not a non-blank string.
 */
function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '')
    throw new RangeError(`${field} must be a non-blank string`)
  return value
}

/**
 * Read an optional boolean flag from a write request.
 *
 * @param {unknown} value - candidate flag.
 * @param {string} field - field name for the diagnostic.
 * @returns {boolean} the flag, `false` when absent.
 * @throws {RangeError} when it is neither absent nor a boolean.
 */
function requireFlag(value, field) {
  if (value === undefined || value === null) return false
  if (typeof value !== 'boolean') throw new RangeError(`${field} must be a boolean when present`)
  return value
}

/**
 * Require the write request envelope.
 *
 * @param {unknown} request - candidate request.
 * @returns {void}
 * @throws {RangeError} when it is not an object.
 */
function assertRequest(request) {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    throw new RangeError('a write request object is required')
  }
}

/**
 * The bound project's vault-relative directory.
 *
 * @param {object} binding - a `kind:'bound'` binding.
 * @returns {string} the directory.
 * @throws {RangeError} when it is missing.
 */
function requireProjectDirectory(binding) {
  if (binding === null || typeof binding !== 'object' || Array.isArray(binding)) {
    throw new RangeError('a bound project binding is required')
  }
  if (typeof binding.relativeDir !== 'string' || binding.relativeDir.trim() === '') {
    throw new RangeError('binding.relativeDir must be a non-blank vault-relative path')
  }
  return binding.relativeDir.replace(/\/+$/, '')
}

/**
 * A vault-relative note path without its `.md` extension (for wikilinks).
 *
 * @param {string} path - the note path.
 * @returns {string} the link target.
 */
function noExtension(path) {
  return String(path).replace(/\.md$/, '')
}
