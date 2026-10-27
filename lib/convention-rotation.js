// Spec §2: rotate the convention preview across sessions.
//
// Summary mode shows five eligible MOC units starting after a persisted anchor,
// so a reader with 176 conventions does not see the same five forever. The
// cursor is deliberately tiny and non-textual: schema, revision, inventory
// fingerprint and a hashed anchor, under dataRoot/cursors — 8 KiB, private
// modes, an atomic replace, and one short lock. Successful acknowledgement
// advances it with a compare-and-swap, so two sessions that prepared the same
// window may both deliver it but a stale acknowledgement never skips another
// window. Missing anchors resume at the first eligible unit and a corrupt state
// resets safely; no fairness is claimed while the inventory keeps changing.
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  privateIdentity,
  readPrivateJson,
  withPrivateLock,
  writePrivateJson,
} from './delivery-state.js'

/** Schema of the convention cursor document. */
export const CONVENTION_ROTATION_SCHEMA = 1
/** How many conventions a summary-mode preview shows. */
export const CONVENTION_PREVIEW_LIMIT = 5
/** The hard ceiling on one cursor file, in bytes. */
export const CONVENTION_STATE_MAX_BYTES = 8 * 1024

/**
 * The identity of one convention unit: a hash of its rendered line.
 *
 * Hashing is what lets the cursor store an anchor without copying vault text
 * into private state: the preview compares the stored hash against the current
 * inventory's hashes, never against a stored title.
 *
 * @param {string} line - the rendered convention line.
 * @returns {string} 64 lowercase hex characters.
 */
export function conventionUnitHash(line) {
  return createHash('sha256').update(String(line), 'utf8').digest('hex')
}

/**
 * The fingerprint of one inventory: every unit's hash in MOC order.
 *
 * Two session starts against the same fingerprint selected from the same list,
 * which is the only condition under which the rotation's coverage guarantee is
 * claimed. A changed inventory changes the fingerprint.
 *
 * @param {string[]} units - rendered convention lines, in MOC order.
 * @returns {string} 64 lowercase hex characters.
 */
export function inventoryFingerprint(units) {
  const lines = Array.isArray(units) ? units.map((line) => String(line)) : []
  return createHash('sha256')
    .update(lines.join(String.fromCharCode(10)), 'utf8')
    .digest('hex')
}

/**
 * Select one preview window, starting after the persisted anchor.
 *
 * The window wraps to fill five units instead of shrinking at the end of the
 * list: a two-unit preview at the tail is not a preview a reader can use, and
 * the spec's coverage rule counts windows, not distinctness. With at most five
 * eligible units the whole list is returned in MOC order and rotation is moot.
 *
 * @param {object} input - the selection inputs.
 * @param {string[]} input.units - rendered convention lines, in MOC order.
 * @param {string|null} [input.anchorHash] - the hashed last unit of the previous preview.
 * @param {number} [input.limit] - how many units to show (default 5).
 * @returns {{selected: {line: string, hash: string, index: number}[], anchorHash: string|null, wrapped: boolean, start: number}} the window.
 */
export function rotateConventions({ units, anchorHash = null, limit = CONVENTION_PREVIEW_LIMIT }) {
  const lines = Array.isArray(units) ? units.map((line) => String(line)) : []
  const hashes = lines.map((line) => conventionUnitHash(line))
  if (lines.length === 0) return { selected: [], anchorHash: null, wrapped: false, start: 0 }
  if (lines.length <= limit) {
    const selected = lines.map((line, index) => ({ line, hash: hashes[index], index }))
    return { selected, anchorHash: hashes[hashes.length - 1], wrapped: false, start: 0 }
  }
  const anchorIndex = anchorHash === null ? -1 : hashes.indexOf(anchorHash)
  const start = anchorIndex === -1 ? 0 : anchorIndex + 1
  const selected = []
  for (let step = 0; step < limit; step += 1) {
    const index = (start + step) % lines.length
    selected.push({ line: lines[index], hash: hashes[index], index })
  }
  return {
    selected,
    anchorHash: selected[selected.length - 1].hash,
    wrapped: start + limit > lines.length,
    start,
  }
}

/**
 * The absolute path of one project's convention cursor.
 *
 * @param {{dataRoot: string, vaultHash: string, projectId: string}} input - the path parts.
 * @returns {string} the path (not created here).
 */
export function conventionCursorPath({ dataRoot, vaultHash, projectId }) {
  return join(dataRoot, 'cursors', vaultHash, projectId, 'conventions.json')
}

/** @returns {object} a cursor with no anchor yet. */
function emptyCursor() {
  return { schema: CONVENTION_ROTATION_SCHEMA, revision: 0, fingerprint: null, anchorHash: null }
}

/**
 * Read one project's convention cursor.
 *
 * A missing cursor is the first session: revision 0 and no anchor, so the
 * preview starts at the first eligible unit. A corrupt, oversized or symlinked
 * cursor is treated the same way but reported as degraded, because the caller
 * has to be able to say that the rotation restarted.
 *
 * @param {object} input - the cursor identity.
 * @param {object} input.binding - a bound project binding.
 * @param {string} input.dataRoot - plugin data root.
 * @param {string} [input.home] - home seam.
 * @returns {Promise<object>} the read result.
 */
export async function readConventionCursor({ binding, dataRoot, home }) {
  const identity = await privateIdentity(binding, { home: home ?? homedir() })
  const path = conventionCursorPath({
    dataRoot,
    vaultHash: identity.vaultHash,
    projectId: identity.projectId,
  })
  const read = await readPrivateJson({
    path,
    root: join(dataRoot, 'cursors'),
    maxBytes: CONVENTION_STATE_MAX_BYTES,
  })
  const base = {
    vaultHash: identity.vaultHash,
    projectId: identity.projectId,
    path,
    corrupt: read.corrupt,
    symlink: read.symlink,
    degraded: read.degraded,
  }
  if (read.symlink || read.corrupt || read.missing) return { ...base, state: emptyCursor() }
  const value = read.value
  if (
    value.schema !== CONVENTION_ROTATION_SCHEMA ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    !(value.fingerprint === null || typeof value.fingerprint === 'string') ||
    !(value.anchorHash === null || typeof value.anchorHash === 'string')
  ) {
    return { ...base, corrupt: true, degraded: true, state: emptyCursor() }
  }
  return {
    ...base,
    state: {
      schema: CONVENTION_ROTATION_SCHEMA,
      revision: value.revision,
      fingerprint: value.fingerprint,
      anchorHash: value.anchorHash,
    },
  }
}

/**
 * Prepare one summary-mode preview and the rotation a receipt must carry.
 *
 * Preparation reads the cursor revision but does not write it: the window is a
 * proposal until the host is observed to insert the message. The receipt's
 * rotation records the revision, the inventory fingerprint and the hashed anchor
 * the acknowledgement will compare-and-swap with.
 *
 * @param {object} input - the preview inputs.
 * @param {object} input.binding - a bound project binding.
 * @param {string} input.dataRoot - plugin data root.
 * @param {string[]} input.units - every eligible convention line, in MOC order.
 * @param {number} [input.limit] - how many lines to preview (default 5).
 * @param {string} [input.home] - home seam.
 * @returns {Promise<object>} the preview lines and the rotation receipt fields.
 */
export async function prepareConventionPreview({
  binding,
  dataRoot,
  units,
  limit = CONVENTION_PREVIEW_LIMIT,
  home,
}) {
  const read = await readConventionCursor({ binding, dataRoot, home })
  const lines = Array.isArray(units) ? units.map((line) => String(line)) : []
  const selection = rotateConventions({ units: lines, anchorHash: read.state.anchorHash, limit })
  return {
    lines: selection.selected.map((entry) => entry.line),
    rotation: {
      revision: read.state.revision,
      fingerprint: inventoryFingerprint(lines),
      anchorHash: selection.anchorHash,
      selectedHashes: selection.selected.map((entry) => entry.hash),
      wrapped: selection.wrapped,
      vaultHash: read.vaultHash,
    },
    state: read.state,
    degraded: read.degraded,
    corrupt: read.corrupt,
    symlink: read.symlink,
    vaultHash: read.vaultHash,
    path: read.path,
  }
}

/**
 * Advance the cursor after a successful acknowledgement, under compare-and-swap.
 *
 * A stale revision means another session advanced first: this call is a no-op
 * rather than a skip, because its window may not be the window the next session
 * should start after. Failure or cancellation never calls this at all, which is
 * why the cursor stays where it was.
 *
 * @param {object} input - the advance request.
 * @param {object} input.binding - a bound project binding.
 * @param {string} input.dataRoot - plugin data root.
 * @param {number} input.expectedRevision - the revision the receipt recorded.
 * @param {string} input.fingerprint - the inventory the receipt was prepared against.
 * @param {string|null} input.anchorHash - the hashed last emitted unit.
 * @param {string} [input.home] - home seam.
 * @returns {Promise<{advanced: boolean, stale?: boolean, revision?: number}>} whether the cursor moved.
 */
export async function advanceConventionCursor({
  binding,
  dataRoot,
  expectedRevision,
  fingerprint,
  anchorHash,
  home,
}) {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new RangeError('the expected convention revision must be a non-negative integer')
  }
  if (typeof fingerprint !== 'string' || !/^[0-9a-f]{64}$/u.test(fingerprint)) {
    throw new RangeError('the convention inventory fingerprint must be a sha256 hex digest')
  }
  if (
    anchorHash !== null &&
    (typeof anchorHash !== 'string' || !/^[0-9a-f]{64}$/u.test(anchorHash))
  ) {
    throw new RangeError('the convention anchor must be a sha256 hex digest or null')
  }
  const identity = await privateIdentity(binding, { home: home ?? homedir() })
  const path = conventionCursorPath({
    dataRoot,
    vaultHash: identity.vaultHash,
    projectId: identity.projectId,
  })
  const root = join(dataRoot, 'cursors')
  return withPrivateLock({ path, root }, async () => {
    const read = await readPrivateJson({ path, root, maxBytes: CONVENTION_STATE_MAX_BYTES })
    const current =
      read.value !== null &&
      read.value.schema === CONVENTION_ROTATION_SCHEMA &&
      Number.isSafeInteger(read.value.revision)
        ? read.value.revision
        : 0
    if (current !== expectedRevision) return { advanced: false, stale: true, revision: current }
    const next = {
      schema: CONVENTION_ROTATION_SCHEMA,
      revision: expectedRevision + 1,
      fingerprint,
      anchorHash,
    }
    await writePrivateJson({ path, root, value: next })
    return { advanced: true, revision: next.revision }
  })
}
