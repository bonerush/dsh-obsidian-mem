// @ts-check
// File naming for the obsidian-mem vault (Task 6, spec §6.4/R22).
//
// A basename is a *rendering*, never an identity. The identity of a note is its
// frontmatter `id` (spec §6.4), so renaming a note never creates a new fact and
// two same-titled notes stay two facts. What a sanitized name must do is
// something narrower and harder: survive a real filesystem on every platform the
// vault may be checked out on.
//
//   * Obsidian itself forbids `/ \ : * ? " < > |`, `#`, `^`, `[` and `]`.
//     Sanitizing is the only safe strategy — switching to a Markdown link cannot
//     rescue those characters, because Obsidian escapes only backslashes, control
//     characters and spaces.
//   * Windows additionally rejects trailing spaces and periods, repeated dots,
//     and the reserved device names (`CON`, `PRN`, `AUX`, `NUL`, `COM1`…).
//   * The real length ceiling is Linux ext4's 255 *bytes*, not macOS's 255
//     UTF-16 units, so the budget here is counted in UTF-8 bytes. The contract
//     is on the emitted **file name** — stem, optional hash suffix and the `.md`
//     extension together, at most 200 bytes (R31) — so the basename budget is
//     that minus the extension, and `safeBasename(title) + '.md'` always fits.
//
// Collisions inside one directory are resolved by appending a short sha256
// suffix derived from the *title* — not from the sanitized stem — so two
// different titles that happen to sanitize identically still get different
// names, and the same title always gets the same name (no matter how many times
// the vault is scanned). The suffix is inserted into the first dot-separated
// segment, because on Windows the device-name check looks at exactly that
// segment: `CON.md` must not become `CON.md-1a2b3c4d`, which is still reserved.
import { createHash } from 'node:crypto'

/** The only extension this vault writes; its bytes are reserved inside the budget (R31). */
const EXTENSION = '.md'
/** The §6.4/R22 contract: the whole emitted file name fits ext4's 255-byte limit with room to spare. */
export const MAX_FILENAME_BYTES = 200
/** The basename budget: {@link MAX_FILENAME_BYTES} minus the extension (R31). */
export const MAX_BASENAME_BYTES = MAX_FILENAME_BYTES - Buffer.byteLength(EXTENSION, 'utf8')
/** Used when sanitizing removes everything the title had to offer. */
export const FALLBACK_BASENAME = 'untitled'

/** `/ \ : * ? " < > |` and the Obsidian-specific `# ^ [ ]`. */
const FORBIDDEN_CHARACTERS = /[/\\:*?"<>|#^[\]]/g
/**
 * Emoji, its variation selectors, the zero-width joiner that composes ZWJ
 * sequences, skin-tone modifiers, keycap combiners and regional indicators
 * (flags). Property escapes are exact; a hand-written range would miss both
 * newer emoji and the pictographs that live in the low planes.
 */
const EMOJI =
  // Each escape is one code point, including the joiners and the selectors, which
  // is what lets a ZWJ sequence be recognised as a single grapheme below.
  // eslint-disable-next-line no-misleading-character-class -- matched code point by code point, on purpose
  /[\p{Extended_Pictographic}\p{Emoji_Presentation}\p{Regional_Indicator}\p{Emoji_Modifier}\u{FE0E}\u{FE0F}\u{200D}\u{20E3}]/gu
/** Control characters (including C1), zero-width and bidi-override characters, and the BOM. */
// eslint-disable-next-line no-control-regex -- stripping invisible and control characters is the whole job
const INVISIBLE = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g

/**
 * Reserved DOS device names. Windows rejects them with or without an extension,
 * and the check applies to the segment before the first dot.
 */
const DEVICE_NAMES = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  ...Array.from({ length: 9 }, (unused, index) => `COM${index + 1}`),
  ...Array.from({ length: 9 }, (unused, index) => `LPT${index + 1}`),
])

/** Suffix lengths tried in turn when a candidate is already taken or reserved. */
const SUFFIX_LENGTHS = Object.freeze([8, 12, 16, 24, 32, 64])

/**
 * Turn a note title into a safe basename (without extension).
 *
 * @param {string} title - the note title; never used as identity.
 * @param {string[]} [existingNames] - basenames already present in the target directory
 *   (excluding the note being written). A trailing `.md` is accepted and stripped, so a
 *   plain `readdir` result can be passed unchanged; comparison is case-folded and
 *   NFC-normalized.
 * @returns {string} a non-empty basename of at most {@link MAX_BASENAME_BYTES} UTF-8 bytes.
 * @throws {RangeError} when `title` is not a string or `existingNames` is not an array of strings.
 */
export function safeBasename(title, existingNames = []) {
  if (typeof title !== 'string') throw new RangeError('title must be a string')
  if (!Array.isArray(existingNames))
    throw new RangeError('existingNames must be an array of strings')
  const taken = new Set()
  for (const name of existingNames) {
    if (typeof name !== 'string') throw new RangeError('existingNames must be an array of strings')
    taken.add(foldName(name))
  }

  const stem = sanitizeStem(title)
  if (!taken.has(foldName(stem)) && !isDeviceName(stem)) return stem

  // A pure function of the title: the same title always resolves the same way,
  // and two different titles never land on the same suffix.
  const digest = createHash('sha256').update(title, 'utf8').digest('hex')
  for (const length of SUFFIX_LENGTHS) {
    const candidate = withSuffix(stem, digest.slice(0, length))
    if (!taken.has(foldName(candidate)) && !isDeviceName(candidate)) return candidate
  }
  throw new Error(`cannot derive a unique basename for ${JSON.stringify(title)}`)
}

/**
 * Strip everything a filesystem or Obsidian cannot hold, then fit the byte budget.
 *
 * @param {string} title - raw title.
 * @returns {string} the sanitized stem, or {@link FALLBACK_BASENAME} when nothing survives.
 */
function sanitizeStem(title) {
  const stripped = title
    .normalize('NFC')
    .replace(EMOJI, '')
    .replace(INVISIBLE, '')
    .replace(FORBIDDEN_CHARACTERS, ' ')
    .replace(/\s+/gu, ' ')
    .replace(/\.{2,}/g, '.')
  const trimmed = truncateToBytes(trimEdge(stripped), MAX_BASENAME_BYTES)
  const settled = trimEdge(trimmed)
  return settled === '' ? FALLBACK_BASENAME : settled
}

/**
 * Append a suffix to the first dot-separated segment and re-fit the byte budget.
 *
 * Keeping the suffix inside that segment is what defeats the Windows device-name
 * rule for names like `CON.md`.
 *
 * The whole emitted file name — basename plus its `.md` extension — must stay
 * inside the §6.4/R22 contract (R31), which `MAX_BASENAME_BYTES` already reserves
 * the extension for. The suffix is subtracted first and the tail (everything from
 * the first dot) is kept only as far as what is left; a pathological stem such as
 * `a.` followed by 300 characters used to keep the entire 199-byte tail and emit
 * a 208-byte name. Whatever the input, the result always carries the suffix — so
 * it can never silently equal the stem it was asked to disambiguate — and never
 * exceeds the budget.
 *
 * @param {string} stem - sanitized basename.
 * @param {string} suffix - hex suffix to append.
 * @returns {string} the suffixed basename within the budget.
 */
function withSuffix(stem, suffix) {
  const suffixText = `-${suffix}`
  const budget = MAX_BASENAME_BYTES - Buffer.byteLength(suffixText, 'utf8')
  const dot = stem.indexOf('.')
  const head = dot === -1 ? stem : stem.slice(0, dot)
  let tail = dot === -1 ? '' : stem.slice(dot)
  if (Buffer.byteLength(tail, 'utf8') > budget) tail = trimEdge(truncateToBytes(tail, budget))
  const headBudget = budget - Buffer.byteLength(tail, 'utf8')
  const kept = trimEdge(truncateToBytes(head, Math.max(0, headBudget)))
  return `${kept}${suffixText}${tail}`
}

/**
 * Remove leading and trailing whitespace and dots.
 *
 * Leading dots matter as much as trailing ones: a name that starts with `.` is
 * hidden on Unix and is skipped by this plugin's own vault scan.
 *
 * @param {string} text - candidate text.
 * @returns {string} the trimmed text.
 */
function trimEdge(text) {
  return text.replace(/^[\s.]+/u, '').replace(/[\s.]+$/u, '')
}

/**
 * Truncate to a UTF-8 byte budget without splitting a code point.
 *
 * @param {string} text - text to truncate.
 * @param {number} limit - maximum UTF-8 bytes.
 * @returns {string} the longest whole-code-point prefix within the budget.
 */
function truncateToBytes(text, limit) {
  if (limit <= 0) return ''
  if (Buffer.byteLength(text, 'utf8') <= limit) return text
  let bytes = 0
  let out = ''
  for (const character of text) {
    const size = Buffer.byteLength(character, 'utf8')
    if (bytes + size > limit) break
    bytes += size
    out += character
  }
  return out
}

/**
 * Whether the segment before the first dot is a reserved DOS device name.
 *
 * @param {string} name - candidate basename.
 * @returns {boolean} true when Windows would refuse the name.
 */
function isDeviceName(name) {
  const head = name.split('.')[0].trim().toUpperCase()
  return DEVICE_NAMES.has(head)
}

/**
 * Case-fold and normalize a name for collision comparison.
 *
 * macOS (APFS/HFS+) and Windows are case-insensitive by default, so two notes
 * whose names differ only in case would overwrite each other; NFC handles the
 * composed/decomposed pair that looks identical in Obsidian.
 *
 * A trailing `.md` is stripped first, because the natural caller builds
 * `existingNames` from `readdir` and therefore passes real filenames. Comparing
 * `foo` against the raw `foo.md` would find no collision, drop the suffix, and
 * silently overwrite an existing note — the guard the caller relies on would
 * disappear exactly when the directory is not empty.
 *
 * @param {string} name - basename to fold.
 * @returns {string} the comparison key.
 */
function foldName(name) {
  return name.replace(/\.md$/iu, '').normalize('NFC').toLowerCase()
}
