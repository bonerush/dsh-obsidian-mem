// The owned digest writer: render one deterministic digest as a plugin-owned
// Markdown note and publish it through the same whole-vault transaction engine
// every other write uses.
//
// The collector owns the bounded read; this module owns only the projection and
// the publication. It keeps three boundaries:
//
//   * the note is generated, so its path is the project's `_meta/digest.md` and
//     the collector excludes that path from its own inputs;
//   * the target is never overwritten unless it proves plugin ownership, and the
//     update carries the exact hash the transaction must still see;
//   * a refresh whose rendered bytes are unchanged writes nothing.
import { promises as fs } from 'node:fs'

import { parseNote } from './frontmatter.js'
import { assertPluginOwnedNote } from './memory.js'
import { localDate } from './note-health.js'
import { resolveVaultFile } from './paths.js'
import { noteIdFor, sha256Hex } from './routing.js'
import { newTransactionId, runTransaction } from './transaction.js'

/** The generated note's project-relative path. */
export const DIGEST_NOTE_PATH = '_meta/digest.md'

/** Hard ceiling from the v0.4 contract, metadata included. */
export const DIGEST_NOTE_MAX_CHARS = 8000

/**
 * Render one digest as the owned note's complete text.
 *
 * The function is pure: the caller supplies the identity and the clock-derived
 * dates, and every value comes from the digest object. It never reads a vault and
 * never writes.
 *
 * @param {object} digest - the `collectDigest` result.
 * @param {{project: object, id: string, created: string, now?: Date}} input - the project, note identity, creation date and clock.
 * @returns {string} the Markdown note.
 * @throws {RangeError} when the rendered note exceeds {@link DIGEST_NOTE_MAX_CHARS}.
 */
export function renderDigestNote(digest, { project, id, created, now = new Date() }) {
  if (digest === null || typeof digest !== 'object') {
    throw new RangeError('renderDigestNote requires a digest object')
  }
  if (project === null || typeof project !== 'object' || typeof project.projectId !== 'string') {
    throw new RangeError('renderDigestNote requires a bound project')
  }
  if (typeof id !== 'string' || id === '')
    throw new RangeError('renderDigestNote requires a note id')
  const updated = localDate(now)
  const window = digest.window ?? {}
  // The note is a day-granularity disclosure: the collector's exact clock would
  // otherwise make every refresh look like a change even when no source moved.
  const windowFrom = String(window.from ?? '').slice(0, 10)
  const windowTo = String(window.to ?? updated).slice(0, 10)
  const notes = digest.notes ?? {}
  const collection = digest.collection ?? {}
  const lines = [
    '---',
    'id: ' + id,
    'type: doc',
    'title: ' + JSON.stringify('项目摘要 ' + String(window.to ?? updated).slice(0, 10)),
    'status: active',
    'trust: agent',
    'harness: dsh',
    'project: ' + project.projectId,
    'created: ' + created,
    'updated: ' + updated,
    'generated_by: dsh-obsidian-mem',
    '---',
    '',
    '# 项目摘要（' + String(window.days ?? 1) + ' 天）',
    '',
    '> 窗口 ' + windowFrom + ' → ' + windowTo + '。',
    '> 检查 ' +
      String(collection.inspected ?? 0) +
      ' 条来源；生成于 ' +
      String(digest.snapshot?.at ?? updated).slice(0, 10) +
      '。',
    '',
    '## 变化计数',
    '',
    '- 新建：' + String(notes.created ?? 0),
    '- 更新：' + String(notes.updated ?? 0),
    '- 取代（当前快照）：' + String(notes.superseded ?? 0),
    '',
    '## 类型分布',
    '',
  ]
  const byType = Array.isArray(notes.byType) ? notes.byType : []
  if (byType.length === 0) lines.push('- 本窗口没有新建或更新。')
  else
    for (const row of byType)
      lines.push(
        '- ' + String(row.type) + '：新建 ' + String(row.created) + '，更新 ' + String(row.updated),
      )
  lines.push('', '## 热层', '')
  if (digest.hot === null || digest.hot === undefined) {
    lines.push('- 热层不可用。')
  } else {
    lines.push(
      '- 使用 ' +
        String(digest.hot.used) +
        ' / ' +
        String(digest.hot.capacity) +
        ' 码点，触发线 ' +
        String(digest.hot.trigger) +
        '。',
    )
    for (const section of Array.isArray(digest.hot.sections) ? digest.hot.sections : []) {
      lines.push(
        '- ' +
          String(section.name) +
          '：' +
          String(section.entries) +
          ' 条完整条目，' +
          String(section.pointers) +
          ' 条指针，可搬出 ' +
          String(section.moveable) +
          '。',
      )
    }
  }
  lines.push('', '## 队列', '')
  if (digest.queue === null || digest.queue === undefined) lines.push('- 队列不可用。')
  else
    lines.push(
      '- 排队 ' +
        String(digest.queue.queued) +
        '，失败 ' +
        String(digest.queue.failed) +
        '，延后 ' +
        String(digest.queue.deferred) +
        '。',
    )
  lines.push('', '## 最近引用', '')
  const recent = Array.isArray(digest.recent) ? digest.recent : []
  if (recent.length === 0) lines.push('- 没有可引用的最近条目。')
  else {
    for (const row of recent) {
      lines.push(
        '- [[' +
          String(row.path) +
          '|' +
          String(row.title) +
          ']]（' +
          String(row.updated ?? '无日期') +
          '）',
      )
    }
  }
  lines.push('', '## 待复核', '')
  const appraisal = digest.appraisal
  const findings = Array.isArray(appraisal?.findings) ? appraisal.findings : []
  if (appraisal === null || appraisal === undefined) lines.push('- 鉴定不可用。')
  else if (findings.length === 0) lines.push('- 没有需要复核的条目。')
  else {
    for (const finding of findings) {
      lines.push(
        '- [' +
          String(finding.severity) +
          '] `' +
          String(finding.code) +
          '` ' +
          String(finding.title) +
          '（`' +
          String(finding.path) +
          '`）：' +
          String(finding.detail),
      )
    }
    if (appraisal.truncated === true) lines.push('- 扫描已截断，仅显示部分结果。')
  }
  if (collection.incomplete === true) {
    lines.push(
      '',
      '> 采集不完整：' +
        (Array.isArray(collection.reasons) ? collection.reasons.join('、') : '未知原因') +
        '。',
    )
  }
  if (collection.truncated === true) lines.push('> 来源超过本次上限，计数仅覆盖已检查的来源。')
  lines.push('')
  const text = lines.join('\n')
  const chars = [...text].length
  if (chars > DIGEST_NOTE_MAX_CHARS) {
    const error = new RangeError(
      `the rendered digest is ${chars} code points, over the ${DIGEST_NOTE_MAX_CHARS}-code-point note ceiling`,
    )
    error.code = 'digest-too-large'
    throw error
  }
  return text
}

/**
 * Create or update the project's owned `_meta/digest.md`.
 *
 * Read and publication are separate: the rendered bytes are compared with the
 * current source first, and an unchanged note is a no-op. An existing target must
 * prove plugin ownership; a human-owned or unmarked file is refused and never
 * replaced.
 *
 * @param {object} binding - a `kind:'bound'` project.
 * @param {object} digest - the `collectDigest` result.
 * @param {{dataRoot: string, home?: string, now?: Date}} options - the private root, home seam and clock.
 * @returns {Promise<{status: 'created'|'updated'|'unchanged', path: string, id: string, charCount: number, txId: string|null}>} the publication result.
 * @throws {RangeError} when the digest cannot be rendered or the root is absent.
 * @throws {Error} when ownership cannot be proven or the transaction refuses.
 */
export async function writeDigestNote(binding, digest, { dataRoot, home, now = new Date() } = {}) {
  if (binding === null || typeof binding !== 'object' || binding.kind !== 'bound') {
    throw new RangeError('writeDigestNote requires a bound project')
  }
  if (typeof dataRoot !== 'string' || dataRoot === '') {
    throw new RangeError('writeDigestNote requires a dataRoot')
  }
  const path = binding.relativeDir + '/' + DIGEST_NOTE_PATH
  const absolute = await resolveVaultFile(binding.vaultRoot, path)
  let before = null
  let id = null
  let created = localDate(now)
  try {
    before = await fs.readFile(absolute)
    const note = parseNote(before)
    assertPluginOwnedNote(note, path)
    id = note.data.id
    if (typeof note.data.created === 'string') created = note.data.created
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  if (id === null) id = noteIdFor('doc')
  const text = renderDigestNote(digest, { project: binding, id, created, now })
  const charCount = [...text].length
  if (before !== null && before.equals(Buffer.from(text))) {
    return { status: 'unchanged', path, id, charCount, txId: null }
  }
  const receipt = await runTransaction(
    binding,
    {
      txId: newTransactionId(),
      ...(before === null
        ? { creates: [{ path, contents: Buffer.from(text) }] }
        : { updates: [{ path, hash: sha256Hex(before), contents: Buffer.from(text) }] }),
      receipt: { action: 'digest-refresh' },
    },
    { dataRoot, home },
  )
  return {
    status: before === null ? 'created' : 'updated',
    path,
    id,
    charCount,
    txId: receipt.txId,
  }
}
