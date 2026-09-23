// Task 6: filenames, frontmatter and byte fidelity (spec §6.4 / R5 / R16 / R18 / R21 / R22).
//
// Every case here is a real byte-level assertion against real temporary
// filesystems — never an fs mock — because what is under test is exactly what a
// byte offset, a `lstat` mtime and a `readFile` do on this machine. Fixtures are
// built from `mkdtemp` under `os.tmpdir()`; the user's real vault, documents
// folder and `~/.dsh` are never read or written.
//
// The corpus below (CJK titles, emoji, `[[路径/笔记]]`, bare `0123`, CRLF) exists
// to falsify one specific mistake: `yaml` 2.x reports node ranges as JavaScript
// character offsets, but the writer edits UTF-8 bytes. Any note whose target
// field follows CJK text or an emoji splices at the wrong byte offset under the
// naive implementation, so the corpus asserts the exact expected bytes AND that
// the naive (character-offset-into-buffer) splice differs.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  assertOwnedFrontmatter,
  bootstrapVault,
  BootstrapError,
  FRONTMATTER_SCAN_LIMIT,
  FrontmatterError,
  OWNED_FIELD_TYPES,
  parseNote,
  patchOwnedFields,
  safeBasename,
  serializeOwnedValue,
  validateKnownPropertyTypes,
} from '../lib/vault.js'

/** The closed property vocabulary of spec §6.4 is the only writable surface. */
const ID1 = '1c392abb-7b08-42f7-871d-2a379caf9448'
/** sha256 hex — the optimistic-concurrency token `patchOwnedFields` enforces. */
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
/** A relative directory shaped like R4, used to place fixtures inside a vault. */
const PROJECT_DIR = `项目/alpha--${ID1.slice(0, 8)}`

async function tempRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'obsidian-mem-t6-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

/** A binding shaped like the one `resolveBinding` returns, without needing git. */
function binding(vaultRoot, overrides = {}) {
  return {
    kind: 'bound',
    projectId: ID1,
    slug: 'alpha',
    displayName: 'Alpha',
    vaultRoot,
    ...overrides,
  }
}

/** Vault-relative → absolute without resolving symlinks (fixtures never use them). */
const at = (vault, relative) => join(vault, ...relative.split('/'))

/** Every path in a tree, with size, mtime and content hash — for "nothing was written" checks. */
async function snapshotTree(root) {
  const out = new Map()
  const walk = async (dir, relative) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const childRelative = relative === '' ? entry.name : `${relative}/${entry.name}`
      const childAbsolute = join(dir, entry.name)
      if (entry.isDirectory()) {
        out.set(`${childRelative}/`, 'dir')
        await walk(childAbsolute, childRelative)
      } else {
        const info = await stat(childAbsolute)
        out.set(childRelative, `${info.size}:${info.mtimeMs}:${sha256(await readFile(childAbsolute))}`)
      }
    }
  }
  await walk(root, '')
  return out
}

/**
 * The write rule Task 7's writer must honour, reproduced here so idempotence is
 * proven end to end: write only when the patched bytes differ from what is on
 * disk. A semantic no-op therefore never touches inode metadata.
 */
async function writeIfChanged(path, bytes) {
  const current = await readFile(path)
  if (current.equals(bytes)) return false
  await writeFile(path, bytes)
  return true
}

// ---------------------------------------------------------------------------
// Step 1: file naming (R22) — sanitize, budget, case-fold collisions
// ---------------------------------------------------------------------------

test('safeBasename keeps a Chinese title intact', () => {
  assert.equal(safeBasename('调度器改为可插拔后端'), '调度器改为可插拔后端')
  assert.equal(safeBasename('  决策：缓存失效  '), '决策：缓存失效')
})

test('safeBasename strips every forbidden filename character', () => {
  const dirty = 'a/b\\c:d*e?f"g<h>i|j#k^l[m]n'
  const clean = safeBasename(dirty)
  for (const forbidden of ['/', '\\', ':', '*', '?', '"', '<', '>', '|', '#', '^', '[', ']']) {
    assert.equal(clean.includes(forbidden), false, `${JSON.stringify(clean)} must not contain ${JSON.stringify(forbidden)}`)
  }
  // the visible words survive: the forbidden characters became separators, not deletions
  assert.equal(clean.split(/\s+/).join(''), 'abcdefghijklmn')
})

test('safeBasename removes emoji and falls back when nothing survives', () => {
  assert.equal(safeBasename('发布🎉版本🚀'), '发布版本')
  assert.equal(safeBasename('👨‍👩‍👧 家庭'), '家庭')
  assert.equal(safeBasename('🎉🚀'), 'untitled')
  assert.equal(safeBasename('   '), 'untitled')
})

test('safeBasename removes control and zero-width characters', () => {
  assert.equal(safeBasename('a\u0000b\u200bc\u200d\uFEFFd'), 'abcd')
  assert.equal(safeBasename('行\u202eevil'), '行evil')
})

test('safeBasename trims trailing spaces, trailing dots and repeated dots', () => {
  assert.equal(safeBasename('报告 .. '), '报告')
  assert.equal(safeBasename('a..b'), 'a.b')
  assert.equal(safeBasename('.gitignore'), 'gitignore')
  assert.equal(safeBasename('报告.'), '报告')
})

test('safeBasename never returns a Windows device name', () => {
  for (const device of ['CON', 'con', 'PrN', 'aux', 'NUL', 'COM1', 'com9', 'LPT1', 'lpt9', 'CON.md']) {
    const clean = safeBasename(device)
    assert.notEqual(clean.toLowerCase().split('.')[0], device.toLowerCase().split('.')[0], `${device} must not stay a reserved name`)
  }
  // a device name stays stable for the same title
  assert.equal(safeBasename('CON'), safeBasename('CON'))
})

test('safeBasename budgets the file name to 200 UTF-8 bytes without splitting a character', () => {
  // R31: the budget bounds the emitted *file name*, so it is the 200-byte
  // contract minus the 3-byte `.md` extension. `safeBasename(title) + '.md'`
  // therefore fits on every path, suffixed or not.
  const clean = safeBasename('决'.repeat(120))
  assert.ok(Buffer.byteLength(clean, 'utf8') <= 197, `${Buffer.byteLength(clean, 'utf8')} bytes must fit the budget`)
  assert.equal(clean, '决'.repeat(65), '195 bytes is the longest whole-character prefix')
  assert.equal(clean.includes('\uFFFD'), false)
  assert.ok(Buffer.byteLength(`${clean}.md`, 'utf8') <= 200)

  const ascii = safeBasename('a'.repeat(500))
  assert.equal(Buffer.byteLength(ascii, 'utf8'), 197)
  assert.equal(ascii, 'a'.repeat(197))
  assert.ok(Buffer.byteLength(`${ascii}.md`, 'utf8') <= 200)

  // the budget still holds when a hash suffix has to fit
  const collided = safeBasename('决'.repeat(120), ['决'.repeat(65)])
  assert.ok(Buffer.byteLength(collided, 'utf8') <= 197)
  assert.ok(Buffer.byteLength(`${collided}.md`, 'utf8') <= 200)
  assert.notEqual(collided, '决'.repeat(65))
})

test('safeBasename adds a stable short hash suffix on a case-folded collision', () => {
  assert.equal(safeBasename('Decision', ['other']), 'Decision')
  assert.equal(safeBasename('Decision', []), 'Decision')

  const collided = safeBasename('Decision', ['decision'])
  assert.notEqual(collided.toLowerCase(), 'decision')
  assert.equal(collided.startsWith('Decision-'), true)
  assert.match(collided, /^Decision-[0-9a-f]{8}$/)
  // deterministic: the same request always yields the same basename
  assert.equal(safeBasename('Decision', ['decision']), collided)
  // an exact-case match also collides: sameness is case-folded
  assert.notEqual(safeBasename('Decision', ['Decision']), 'Decision')
  // NFC differences are collisions too
  assert.match(safeBasename('café', ['cafe\u0301']), /^café-[0-9a-f]{8}$/)
})

test('safeBasename derives the suffix from the title, so distinct titles stay distinct', () => {
  const first = safeBasename('决策#1', ['决策 1'])
  const second = safeBasename('决策^1', ['决策 1'])
  assert.equal(first.startsWith('决策 1-'), true)
  assert.equal(second.startsWith('决策 1-'), true)
  assert.notEqual(first, second, 'two different titles must not collapse onto one basename')
})

test('safeBasename folds a trailing .md so a readdir list keeps the collision guard', () => {
  // `existingNames` naturally comes from `readdir`, which returns filenames; a
  // guard that misses `foo.md` would silently overwrite an existing note.
  const collided = safeBasename('foo', ['foo.md'])
  assert.match(collided, /^foo-[0-9a-f]{8}$/)
  assert.equal(safeBasename('foo', ['foo.md']), collided, 'still deterministic')
  assert.match(safeBasename('Foo', ['foo.MD']), /^Foo-[0-9a-f]{8}$/)
  assert.match(safeBasename('foo', ['FOO.Md']), /^foo-[0-9a-f]{8}$/)
  // only a real collision triggers the suffix
  assert.equal(safeBasename('foo', ['foobar.md', 'bar.md', 'foo-bar.md']), 'foo')
  // and the budget still holds when the existing name carries its extension
  const long = safeBasename('决'.repeat(120), [`${'决'.repeat(65)}.md`])
  assert.ok(Buffer.byteLength(long, 'utf8') <= 197)
  assert.ok(Buffer.byteLength(`${long}.md`, 'utf8') <= 200)
  assert.match(long, /^决+-[0-9a-f]{8}$/)
})

test('a real readdir list can never lose the collision guard', async (t) => {
  const root = await tempRoot(t)
  await writeFile(join(root, 'foo.md'), '---\nid: "a"\n---\n')
  const existing = await readdir(root)

  const name = safeBasename('foo', existing)
  assert.notEqual(name.toLowerCase(), 'foo')
  const folded = existing.map((entry) => entry.replace(/\.md$/iu, '').toLowerCase())
  assert.equal(folded.includes(name.toLowerCase()), false, `${name} must not collide with ${existing.join(', ')}`)
  assert.equal(existing.includes(`${name}.md`), false)
})

test('safeBasename rejects a non-string title', () => {
  assert.throws(() => safeBasename(null), RangeError)
  assert.throws(() => safeBasename(42), RangeError)
  assert.throws(() => safeBasename('ok', 'not-an-array'), RangeError)
})

// ---------------------------------------------------------------------------
// Step 1: parseNote — refuse instead of repairing
// ---------------------------------------------------------------------------

const SIMPLE = Buffer.from('---\nid: "dec-1"\ntitle: "调度器"\ntags: ["dsh-mem/decision"]\nproject: null\n---\n# 正文\n\n内容\n')

test('parseNote reads frontmatter and body without changing the bytes it was given', () => {
  const before = Buffer.from(SIMPLE)
  const note = parseNote(SIMPLE)
  assert.equal(note.hasFrontmatter, true)
  assert.deepEqual(note.data, { id: 'dec-1', title: '调度器', tags: ['dsh-mem/decision'], project: null })
  assert.equal(note.body, '# 正文\n\n内容\n')
  assert.equal(note.bodyOffset, Buffer.byteLength('---\nid: "dec-1"\ntitle: "调度器"\ntags: ["dsh-mem/decision"]\nproject: null\n---\n', 'utf8'))
  assert.equal(note.bodyBytes.equals(SIMPLE.subarray(note.bodyOffset)), true)
  assert.deepEqual(SIMPLE, before, 'parsing must not mutate the caller buffer')
})

test('parseNote refuses a fragment line as the closing marker when the caller says it is a head', () => {
  const head = Buffer.from('---\nid: "a"\n---')
  // read whole, the file really does close on that line
  assert.equal(parseNote(head).hasFrontmatter, true)
  // read as a head, the same bytes cannot prove the line ended
  assert.throws(
    () => parseNote(head, { truncated: true }),
    (error) => error instanceof FrontmatterError && error.code === 'unclosed-frontmatter',
  )
  assert.throws(() => parseNote(head, { truncated: 'yes' }), RangeError)
})

test('a preflight head cut exactly at a would-be closing marker is refused, not parsed', async (t) => {
  const root = await tempRoot(t)
  const vault = join(root, 'vault')
  await mkdir(at(vault, '方法'), { recursive: true })

  // The head ends exactly after `---`, but the real line continues with `xyz`:
  // re-deriving `truncated` from the buffer length would accept the fragment,
  // parse a 65 KiB "frontmatter" and report a clean vault.
  const opening = '---\nid: "a"\n'
  const filler = `note: ${'x'.repeat(FRONTMATTER_SCAN_LIMIT - Buffer.byteLength(opening) - 'note: '.length - 1 - 3)}`
  assert.equal(Buffer.byteLength(`${opening}${filler}\n---`), FRONTMATTER_SCAN_LIMIT, 'the window must end inside the marker')
  await writeFile(at(vault, '方法/片段.md'), `${opening}${filler}\n---xyz\nmore\n`)

  const result = await validateKnownPropertyTypes(vault, { home: root })
  assert.equal(result.conflicts.length, 1, JSON.stringify(result.conflicts))
  assert.equal(result.conflicts[0].reason, 'frontmatter-beyond-scan-limit')
})

test('patchOwnedFields refuses a note whose frontmatter never closes inside the window', () => {
  const opening = '---\nid: "a"\n'
  const bytes = Buffer.from(`${opening}note: ${'x'.repeat(FRONTMATTER_SCAN_LIMIT)}\n---\nBody\n`)
  assert.throws(
    () => patchOwnedFields(bytes, { status: 'accepted' }, sha256(bytes)),
    (error) => error instanceof FrontmatterError && error.code === 'unclosed-frontmatter',
  )
})

test('parseNote reports a file with no frontmatter as such', () => {
  const note = parseNote(Buffer.from('# 只有正文\n'))
  assert.equal(note.hasFrontmatter, false)
  assert.equal(note.data, null)
  assert.equal(note.body, '# 只有正文\n')
  assert.equal(note.bodyOffset, 0)
})

test('parseNote handles CRLF frontmatter', () => {
  const note = parseNote(Buffer.from('---\r\nid: "x"\r\n---\r\nBody\r\n'))
  assert.equal(note.hasFrontmatter, true)
  assert.deepEqual(note.data, { id: 'x' })
  assert.equal(note.body, 'Body\r\n')
})

test('parseNote refuses a BOM, an unclosed block, invalid YAML and duplicate keys', () => {
  const cases = [
    [Buffer.from('\uFEFF---\nid: "x"\n---\nBody\n'), 'bom'],
    [Buffer.from('---\nid: "x"\ntitle: "y"\n'), 'unclosed-frontmatter'],
    [Buffer.from('---\nid: [unclosed\n---\nBody\n'), 'invalid-yaml'],
    [Buffer.from('---\nid: "a"\nid: "b"\n---\nBody\n'), 'duplicate-key'],
    [Buffer.from('---\n- a\n- b\n---\nBody\n'), 'frontmatter-not-mapping'],
  ]
  for (const [bytes, code] of cases) {
    assert.throws(
      () => parseNote(bytes),
      (error) => error instanceof FrontmatterError && error.code === code,
      `expected ${code} for ${JSON.stringify(bytes.toString('utf8'))}`,
    )
  }
  // a bare `---` with no line break is a thematic break, not a frontmatter opener
  assert.equal(parseNote(Buffer.from('---')).hasFrontmatter, false)
})

// ---------------------------------------------------------------------------
// Step 1: patchOwnedFields — the target field only, everything else byte-identical
// ---------------------------------------------------------------------------

test('patchOwnedFields replaces one value and keeps comments, unknown keys and body', () => {
  const original = Buffer.from('---\nid: "dec-5d46ff43-1bf8-496d-8b9f-c11e89d4e2aa"\ncssclasses: [wide] # owner\nstatus: "accepted"\n---\nBody\n')
  const updated = patchOwnedFields(original, { status: 'superseded' }, sha256(original))
  assert.deepEqual(updated, Buffer.from('---\nid: "dec-5d46ff43-1bf8-496d-8b9f-c11e89d4e2aa"\ncssclasses: [wide] # owner\nstatus: "superseded"\n---\nBody\n'))
  assert.match(updated.toString(), /cssclasses: \[wide\] # owner/)
  assert.match(updated.toString(), /\nBody\n$/)
})

test('patchOwnedFields splices CJK, emoji, CRLF and bare 0123 at the right byte offset', () => {
  const original = Buffer.from(
    '---\r\n'
    + 'id: "dec-1"\r\n'
    + 'legacy_rank: 0123\r\n'
    + 'title: "调度器🎉改为可插拔后端"\r\n'
    + 'link: "[[路径/笔记]]"\r\n'
    + 'cssclasses: [wide] # owner\r\n'
    + 'status: "proposed"\r\n'
    + '---\r\n'
    + '正文 🎉\r\n[[路径/笔记]]\r\n',
    'utf8',
  )
  const expected = Buffer.from(
    '---\r\n'
    + 'id: "dec-1"\r\n'
    + 'legacy_rank: 0123\r\n'
    + 'title: "调度器🎉改为可插拔后端"\r\n'
    + 'link: "[[路径/笔记]]"\r\n'
    + 'cssclasses: [wide] # owner\r\n'
    + 'status: "accepted"\r\n'
    + '---\r\n'
    + '正文 🎉\r\n[[路径/笔记]]\r\n',
    'utf8',
  )

  const updated = patchOwnedFields(original, { status: 'accepted' }, sha256(original))
  assert.deepEqual(updated, expected)

  // falsification: the naive character-offset splice into the buffer differs, so
  // this corpus really discriminates between the two implementations.
  const text = original.toString('utf8')
  const charStart = text.indexOf('"proposed"')
  const charEnd = charStart + '"proposed"'.length
  const naive = Buffer.concat([
    original.subarray(0, charStart),
    Buffer.from('"accepted"'),
    original.subarray(charEnd),
  ])
  assert.notDeepEqual(naive, expected, 'a character offset must not be applied to a byte buffer')
})

test('patchOwnedFields inserts a missing key as one minimal line before the closing marker', () => {
  const original = Buffer.from('---\nid: "dec-1"\nstatus: "accepted"\n---\nBody\n')
  const updated = patchOwnedFields(original, { tags: ['dsh-mem/decision'] }, sha256(original))
  assert.deepEqual(updated, Buffer.from('---\nid: "dec-1"\nstatus: "accepted"\ntags: ["dsh-mem/decision"]\n---\nBody\n'))
})

test('patchOwnedFields inserts with the file\'s own CRLF line ending', () => {
  const original = Buffer.from('---\r\nid: "dec-1"\r\n---\r\nBody\r\n')
  const updated = patchOwnedFields(original, { updated: '2026-09-23' }, sha256(original))
  assert.deepEqual(updated, Buffer.from('---\r\nid: "dec-1"\r\nupdated: 2026-09-23\r\n---\r\nBody\r\n'))
})

test('patchOwnedFields preserves a comment that floats outside the replaced value', () => {
  const original = Buffer.from('---\nstatus: # why\n  "proposed"\ntags: [a] # list\n---\nBody\n')
  const updated = patchOwnedFields(original, { status: 'accepted', tags: ['a', 'b'] }, sha256(original))
  assert.deepEqual(updated, Buffer.from('---\nstatus: # why\n  "accepted"\ntags: ["a", "b"] # list\n---\nBody\n'))
})

test('patchOwnedFields refuses when the target range carries a comment it cannot keep', () => {
  const original = Buffer.from('---\ntags: [\n  "a", # first\n  "b"\n]\nstatus: "x"\n---\nBody\n')
  assert.throws(
    () => patchOwnedFields(original, { tags: ['c'] }, sha256(original)),
    (error) => error instanceof FrontmatterError && error.code === 'unpreservable-comment',
  )
  // a block scalar keeps its comment on the header line, inside the value range
  const blockComment = Buffer.from('---\ntitle: | # why\n  a\nstatus: "x"\n---\nBody\n')
  assert.throws(
    () => patchOwnedFields(blockComment, { title: 'x' }, sha256(blockComment)),
    (error) => error instanceof FrontmatterError && error.code === 'unpreservable-comment',
  )
})

test('patchOwnedFields replaces a block scalar without swallowing the next line', () => {
  const original = Buffer.from('---\ntitle: |\n  a\n  b\nstatus: "c"\n---\nBody\n')
  const updated = patchOwnedFields(original, { title: '一行' }, sha256(original))
  assert.deepEqual(updated, Buffer.from('---\ntitle: "一行"\nstatus: "c"\n---\nBody\n'))
  assert.deepEqual(parseNote(updated).data, { title: '一行', status: 'c' })
})

test('patchOwnedFields refuses when a target field already has a conflicting visible type', () => {
  const tagsText = Buffer.from('---\nid: "dec-1"\ntags: foo\n---\nBody\n')
  assert.throws(
    () => patchOwnedFields(tagsText, { tags: ['foo'] }, sha256(tagsText)),
    (error) => error instanceof FrontmatterError && error.code === 'property-type-conflict',
  )
  const confidenceText = Buffer.from('---\nid: "dec-1"\nconfidence: "高"\n---\nBody\n')
  assert.throws(
    () => patchOwnedFields(confidenceText, { confidence: 0.5 }, sha256(confidenceText)),
    (error) => error instanceof FrontmatterError && error.code === 'property-type-conflict',
  )
  const quotedDate = Buffer.from('---\nid: "dec-1"\nupdated: "2026-09-23"\n---\nBody\n')
  assert.throws(
    () => patchOwnedFields(quotedDate, { updated: '2026-09-24' }, sha256(quotedDate)),
    (error) => error instanceof FrontmatterError && error.code === 'property-type-conflict',
  )
})

test('patchOwnedFields refuses a hash mismatch, an empty value range and a missing frontmatter', () => {
  const original = Buffer.from('---\nid: "dec-1"\n---\nBody\n')
  assert.throws(
    () => patchOwnedFields(original, { status: 'accepted' }, sha256(Buffer.from('other'))),
    (error) => error instanceof FrontmatterError && error.code === 'hash-mismatch',
  )
  const emptyValue = Buffer.from('---\nid: "dec-1"\nstatus:\n---\nBody\n')
  assert.throws(
    () => patchOwnedFields(emptyValue, { status: 'accepted' }, sha256(emptyValue)),
    (error) => error instanceof FrontmatterError && error.code === 'unlocatable-value',
  )
  const noFrontmatter = Buffer.from('# 只有正文\n')
  assert.throws(
    () => patchOwnedFields(noFrontmatter, { status: 'accepted' }, sha256(noFrontmatter)),
    (error) => error instanceof FrontmatterError && error.code === 'no-frontmatter',
  )
  assert.throws(() => patchOwnedFields(original, { nope: 'x' }, sha256(original)), RangeError)
  assert.throws(() => patchOwnedFields(original, { status: 'x' }), RangeError)
})

test('the writable vocabulary is exactly the §6.4 property set', () => {
  assert.deepEqual(Object.keys(OWNED_FIELD_TYPES).sort(), [
    'assertion', 'confidence', 'created', 'harness', 'id', 'project', 'review_after',
    'session', 'source', 'status', 'superseded_by', 'supersedes', 'tags', 'title',
    'trust', 'type', 'updated',
  ].sort())
  assert.equal(OWNED_FIELD_TYPES.cssclasses, undefined)
})

// ---------------------------------------------------------------------------
// Step 1: value rendering (R5 / R16 / R21)
// ---------------------------------------------------------------------------

test('serializeOwnedValue renders each §6.4 type so that it round-trips', () => {
  const cases = [
    ['type', 'decision'],
    ['title', '调度器🎉'],
    ['status', 'accepted'],
    ['id', '0123'],
    ['project', '1c392abb-7b08-42f7-871d-2a379caf9448'],
    ['session', null],
    ['confidence', 0.9],
    ['confidence', null],
    ['assertion', 'inferred'],
    ['supersedes', '[[路径/笔记]]'],
    ['superseded_by', null],
    ['review_after', null],
  ]
  for (const [key, value] of cases) {
    const token = serializeOwnedValue(key, value)
    const note = parseNote(Buffer.from(`---\n${key}: ${token}\n---\nBody\n`))
    assert.deepEqual(note.data[key], value, `${key}: ${token} must round-trip`)
  }
  assert.equal(serializeOwnedValue('tags', ['dsh-mem/decision', 'project/xeros']), '["dsh-mem/decision", "project/xeros"]')
  assert.equal(serializeOwnedValue('supersedes', '[[路径/笔记]]'), '"[[路径/笔记]]"')
  assert.equal(serializeOwnedValue('id', '0123'), '"0123"')
  assert.equal(serializeOwnedValue('updated', '2026-09-23'), '2026-09-23')
  assert.equal(serializeOwnedValue('updated', '2026-09-23 10:00:00'), '2026-09-23 10:00:00')
  assert.equal(serializeOwnedValue('confidence', 1), '1')
})

test('serializeOwnedValue refuses values the vocabulary cannot hold', () => {
  assert.throws(() => serializeOwnedValue('tags', 'foo'), RangeError)
  assert.throws(() => serializeOwnedValue('tags', [1]), RangeError)
  assert.throws(() => serializeOwnedValue('confidence', '高'), RangeError)
  assert.throws(() => serializeOwnedValue('confidence', 1.5), RangeError)
  assert.throws(() => serializeOwnedValue('created', '2026-09-23T10:00:00.000Z'), RangeError)
  assert.throws(() => serializeOwnedValue('updated', '2026/09/23'), RangeError)
  assert.throws(() => serializeOwnedValue('status', null), RangeError)
  assert.throws(() => serializeOwnedValue('cssclasses', 'x'), RangeError)
})

test('patchOwnedFields writes dates bare, wikilinks quoted and tags as a list', () => {
  const original = Buffer.from('---\nid: "dec-1"\n---\nBody\n')
  const updated = patchOwnedFields(original, {
    created: '2026-09-23',
    updated: '2026-09-23 10:00:00',
    supersedes: '[[路径/笔记]]',
    tags: ['dsh-mem/decision'],
    confidence: 0.9,
    assertion: 'stated',
    session: null,
    superseded_by: null,
  }, sha256(original))
  assert.deepEqual(updated, Buffer.from(
    '---\n'
    + 'id: "dec-1"\n'
    + 'created: 2026-09-23\n'
    + 'updated: 2026-09-23 10:00:00\n'
    + 'supersedes: "[[路径/笔记]]"\n'
    + 'tags: ["dsh-mem/decision"]\n'
    + 'confidence: 0.9\n'
    + 'assertion: "stated"\n'
    + 'session: null\n'
    + 'superseded_by: null\n'
    + '---\nBody\n',
  ))
  const note = parseNote(updated)
  assert.equal(note.data.supersedes, '[[路径/笔记]]')
  assert.deepEqual(note.data.tags, ['dsh-mem/decision'])
  assert.equal(note.data.updated, '2026-09-23 10:00:00')
})

test('a bare leading-zero identifier is quoted, never written as 0123', () => {
  const original = Buffer.from('---\nlegacy: 0123\n---\nBody\n')
  const updated = patchOwnedFields(original, { id: '0123' }, sha256(original))
  assert.equal(updated.toString().includes('id: "0123"'), true)
  assert.equal(updated.toString().includes('legacy: 0123'), true, 'an unknown key is never re-serialized')
  assert.equal(parseNote(updated).data.id, '0123')
})

// ---------------------------------------------------------------------------
// Step 1: semantic idempotence — bytes and mtime
// ---------------------------------------------------------------------------

test('the same semantic content twice leaves the bytes and the mtime untouched', async (t) => {
  if (process.getuid?.() === 0) t.skip('a root process ignores the read-only proof')

  const root = await tempRoot(t)
  const path = join(root, 'note.md')
  const original = Buffer.from('---\nid: "dec-1"\nstatus: "accepted"\nupdated: 2026-09-23\n---\nBody\n')
  await writeFile(path, original)

  const before = await stat(path)
  // a value that already holds the requested semantics must not be rewritten,
  // even though an unquoted `status: accepted` would render differently
  const plain = await readFile(path)
  const noop = patchOwnedFields(plain, { status: 'accepted', updated: '2026-09-23' }, sha256(plain))
  assert.equal(noop.equals(plain), true, 'a semantic no-op must produce identical bytes')
  assert.equal(await writeIfChanged(path, noop), false)

  // the read-only control: the skip is real, not an artifact of a permissive fs
  await chmod(path, 0o444)
  const again = await readFile(path)
  const second = patchOwnedFields(again, { status: 'accepted', updated: '2026-09-23' }, sha256(again))
  assert.equal(await writeIfChanged(path, second), false)
  assert.deepEqual(await readFile(path), original)
  assert.equal((await stat(path)).mtimeMs, before.mtimeMs)

  // positive control: a real change does attempt the write, so the skip above matters
  await assert.rejects(writeIfChanged(path, Buffer.from('changed\n')), { code: 'EACCES' })
  await chmod(path, 0o644)

  // and a real semantic change lands on disk with exactly one line replaced
  const changed = patchOwnedFields(await readFile(path), { status: 'superseded' }, sha256(original))
  assert.equal(await writeIfChanged(path, changed), true)
  assert.deepEqual(await readFile(path), Buffer.from('---\nid: "dec-1"\nstatus: "superseded"\nupdated: 2026-09-23\n---\nBody\n'))
})

// ---------------------------------------------------------------------------
// Step 1: the file-level property preflight, on the real bootstrap path
// ---------------------------------------------------------------------------

test('a new note is full-serialized and then verified against the vocabulary', () => {
  const ok = assertOwnedFrontmatter(
    '---\nid: "hub-1"\ncreated: 2026-09-23\ntags: ["dsh-mem/hub"]\nproject: null\n---\nBody\n',
    { path: 'index.md' },
  )
  assert.deepEqual(ok.data, { id: 'hub-1', created: '2026-09-23', tags: ['dsh-mem/hub'], project: null })

  const rejected = [
    ['---\ntags: foo\n---\nBody\n', 'property-type-conflict'],
    ['---\nid: 0123\n---\nBody\n', 'property-type-conflict'],
    ['---\ncreated: 2026-09-23T10:00:00.000Z\n---\nBody\n', 'property-type-conflict'],
    ['---\ncssclasses: [wide]\n---\nBody\n', 'unknown-property'],
    ['# no frontmatter\n', 'no-frontmatter'],
    ['---\nid: "a"\nid: "b"\n---\nBody\n', 'template-invalid'],
  ]
  for (const [text, code] of rejected) {
    assert.throws(
      () => assertOwnedFrontmatter(text),
      (error) => error instanceof FrontmatterError && error.code === code,
      `expected ${code} for ${JSON.stringify(text)}`,
    )
  }
})

test('bootstrap refuses when an existing note declares tags as text', async (t) => {
  const root = await tempRoot(t)
  const vault = join(root, 'vault')
  const projectDir = at(vault, PROJECT_DIR)
  await mkdir(projectDir, { recursive: true })
  await writeFile(at(projectDir, '坏笔记.md'), '---\nid: "dec-1"\ntags: foo\n---\nBody\n')
  const before = await snapshotTree(vault)

  await assert.rejects(
    bootstrapVault(binding(vault), { initGitOnCreate: false, home: root, dataRoot: join(root, '.data') }),
    (error) => error instanceof BootstrapError
      && error.code === 'property-type-conflict'
      && error.conflicts.some((conflict) => conflict.reason === 'type-conflict' && conflict.key === 'tags'),
  )
  assert.deepEqual(await snapshotTree(vault), before, 'a refused bootstrap must not write anything')
})

test('bootstrap refuses when a quoted confidence value conflicts with the vocabulary', async (t) => {
  const root = await tempRoot(t)
  const vault = join(root, 'vault')
  await mkdir(at(vault, PROJECT_DIR), { recursive: true })
  await writeFile(at(vault, `${PROJECT_DIR}/笔记.md`), '---\nid: "dec-1"\nconfidence: "高"\n---\nBody\n')
  const before = await snapshotTree(vault)

  await assert.rejects(
    bootstrapVault(binding(vault), { initGitOnCreate: false, home: root, dataRoot: join(root, '.data') }),
    (error) => error instanceof BootstrapError
      && error.code === 'property-type-conflict'
      && error.conflicts.some((conflict) => conflict.key === 'confidence'
        && conflict.expected === 'number-or-null' && conflict.actual === 'text'),
  )
  assert.deepEqual(await snapshotTree(vault), before)
})

test('bootstrap refuses a vault note whose frontmatter cannot be trusted', async (t) => {
  const root = await tempRoot(t)
  const vault = join(root, 'vault')
  await mkdir(at(vault, PROJECT_DIR), { recursive: true })
  const cases = [
    ['\uFEFF---\nid: "x"\n---\nBody\n', 'bom'],
    ['---\nid: "a"\nid: "b"\n---\nBody\n', 'duplicate-key'],
    ['---\nid: [oops\n---\nBody\n', 'invalid-yaml'],
  ]
  for (const [text, code] of cases) {
    const path = at(vault, `${PROJECT_DIR}/坏.md`)
    await writeFile(path, text)
    await assert.rejects(
      bootstrapVault(binding(vault), { initGitOnCreate: false, home: root, dataRoot: join(root, '.data') }),
      (error) => error instanceof BootstrapError
        && error.code === 'property-preflight-conflict'
        && error.conflicts.some((conflict) => conflict.reason === 'invalid-frontmatter' && conflict.code === code),
      `expected ${code} to stop bootstrap`,
    )
    await rm(path)
  }
})

test('validateKnownPropertyTypes passes a clean vault and reports each conflict kind', async (t) => {
  const root = await tempRoot(t)
  const vault = join(root, 'vault')
  await mkdir(at(vault, '方法'), { recursive: true })
  await writeFile(at(vault, '方法/index.md'), '---\ntype: "hub"\ntags: ["dsh-mem/hub"]\nproject: null\ncreated: 2026-09-23\nconfidence: null\n---\nBody\n')
  await writeFile(at(vault, '说明.txt'), 'tags: foo\n')
  const clean = await validateKnownPropertyTypes(vault, { home: root })
  assert.deepEqual(clean.conflicts, [])
  assert.equal(clean.scanned, 1)

  await writeFile(at(vault, '方法/坏了.md'), '---\ntitle: 2026\n---\nBody\n')
  const broken = await validateKnownPropertyTypes(vault, { home: root })
  assert.equal(broken.conflicts.length, 1)
  assert.equal(broken.conflicts[0].reason, 'type-conflict')
  assert.equal(broken.conflicts[0].key, 'title')
  assert.equal(broken.conflicts[0].expected, 'text')
  assert.equal(broken.conflicts[0].path, '方法/坏了.md')
})

test('the preflight never reads past the 64 KiB frontmatter window', async (t) => {
  const root = await tempRoot(t)
  const vault = join(root, 'vault')
  await mkdir(at(vault, '方法'), { recursive: true })

  // closing marker beyond the window: a full scan would find it and succeed
  const filler = '长'.repeat(Math.ceil((FRONTMATTER_SCAN_LIMIT + 4096) / 3))
  await writeFile(at(vault, '方法/晚.md'), `---\nid: "x"\nnote: ${filler}\n---\nBody\n`)
  const late = await validateKnownPropertyTypes(vault, { home: root })
  assert.equal(late.conflicts.length, 1, JSON.stringify(late.conflicts))
  assert.equal(late.conflicts[0].reason, 'frontmatter-beyond-scan-limit')

  await rm(at(vault, '方法/晚.md'))
  // a huge body after an early closing marker is fine and is never read whole
  await writeFile(at(vault, '方法/大.md'), `---\nid: "x"\n---\n${'y'.repeat(200_000)}`)
  const huge = await validateKnownPropertyTypes(vault, { home: root })
  assert.deepEqual(huge.conflicts, [])
  assert.equal(huge.scanned, 1)
  assert.equal(FRONTMATTER_SCAN_LIMIT, 65_536)
})

test('the preflight reports a note it cannot read instead of guessing', async (t) => {
  if (process.getuid?.() === 0) t.skip('root ignores file permissions')
  const root = await tempRoot(t)
  const vault = join(root, 'vault')
  await mkdir(at(vault, '方法'), { recursive: true })
  await writeFile(at(vault, '方法/私密.md'), '---\ntags: ["x"]\n---\nBody\n')
  await chmod(at(vault, '方法/私密.md'), 0o000)

  const result = await validateKnownPropertyTypes(vault, { home: root })
  assert.equal(result.conflicts.length, 1)
  assert.equal(result.conflicts[0].reason, 'unreadable')
  assert.equal(result.conflicts[0].path, '方法/私密.md')
})

test('a bootstrapped vault stays preflight-clean on every later run', async (t) => {
  const root = await tempRoot(t)
  const vault = join(root, 'vault')
  const result = await bootstrapVault(binding(vault), { initGitOnCreate: false, home: root, dataRoot: join(root, '.data') })
  assert.equal(result.registryUpdated, true)

  const first = await validateKnownPropertyTypes(vault, { home: root })
  assert.deepEqual(first.conflicts, [], JSON.stringify(first.conflicts))
  assert.ok(first.scanned >= 8, 'every MOC and hot.md was inspected')

  // a second bootstrap must not be stopped by the plugin's own output
  const again = await bootstrapVault(binding(vault), { initGitOnCreate: false, home: root, dataRoot: join(root, '.data') })
  assert.deepEqual(again.createdPaths, [])
  assert.deepEqual((await validateKnownPropertyTypes(vault, { home: root })).conflicts, [])
})
