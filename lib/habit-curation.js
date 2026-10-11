// @ts-check
// Curation feeds the existing durable distillation queue, not another learner.
import { createHash } from 'node:crypto'
import { readNote } from './search.js'
import { containsCredential, looksInjected } from './user-source.js'
import {
  queueRootFor,
  isProcessed,
  readPendingJobs,
  readProcessedRecords,
  withQueueLock,
  writeJobAtomic,
} from './pending.js'

/**
 * Queue one bounded memory re-distillation after a curation scan.
 * Only stated conventions may supply evidence; inferred habits cannot teach themselves.
 * @param {object} binding - bound project.
 * @param {string[]} paths - sources actually examined by the scan.
 * @param {object} deps - dataRoot, home, config and optional route.
 * @returns {Promise<object|null>} newly persisted job, or null for a replay/empty input.
 */
export async function enqueueHabitCuration(binding, paths, deps) {
  if (deps.config?.distill?.learnHabits === false) return null
  const sources = []
  const chunks = []
  const max = deps.config?.distill?.maxInputChars ?? 24000
  let used = 0
  for (const path of [...new Set(paths)].sort().slice(0, 256)) {
    if (sources.length === 12) break
    if (!path.startsWith(binding.relativeDir + '/')) continue
    const note = await readNote(binding.vaultRoot, path, null, { home: deps.home }).catch(
      () => null,
    )
    if (
      !note ||
      note.projectId !== binding.projectId ||
      note.frontmatter?.type !== 'convention' ||
      note.frontmatter?.assertion !== 'stated' ||
      !['active', 'accepted'].includes(note.status) ||
      /^习惯[:：]/.test(note.title ?? '') ||
      note.tags?.includes('user-habit') ||
      looksInjected(note.body) ||
      containsCredential(note.body) ||
      containsCredential(note.title)
    )
      continue
    const seq = sources.length + 1
    const quote = [...note.body].slice(0, 1200).join('')
    const chunk = `--- memory (seq ${seq}) ---\n${quote}\n`
    if (quote.trim().length < 6 || used + [...chunk].length > max) continue
    sources.push({ kind: 'memory', source: 'memory', seq, path, hash: note.hash })
    chunks.push(chunk)
    used += [...chunk].length
  }
  if (!sources.length) return null
  const hash = createHash('sha256')
    .update(JSON.stringify([binding.projectId, sources]))
    .digest('hex')
  const sessionId = `curation-${hash}`
  const jobId = `job-${hash.slice(0, 32)}`
  const queueRoot = queueRootFor(deps.dataRoot)
  return withQueueLock(queueRoot, async () => {
    const { jobs } = await readPendingJobs(queueRoot)
    const processed = await readProcessedRecords(queueRoot)
    if (
      jobs.some((j) => j.jobId === jobId) ||
      isProcessed(processed.records.get(sessionId), sources.length)
    )
      return null
    const at = new Date().toISOString()
    const job = {
      schema: 1,
      jobId,
      sessionId,
      projectId: binding.projectId,
      origin: 'habit-curation',
      fromSeq: 0,
      toSeq: sources.length,
      state: 'pending',
      attempts: 0,
      createdAt: at,
      updatedAt: at,
      route: deps.route ?? null,
      allowedEvents: sources,
      safeInput: chunks.join('\n'),
    }
    await writeJobAtomic(queueRoot, job)
    return job
  })
}

/**
 * Revalidate memory evidence on every attempt, including a validated-output replay.
 * @param {object} binding - bound project.
 * @param {object} job - persisted job.
 * @param {object} [deps] - source-reader home seam.
 * @returns {Promise<boolean>} all source identities still match, or a normal turn job.
 */
export async function curationSourcesCurrent(binding, job, deps = {}) {
  if (job.origin !== 'habit-curation') return true
  if (!job.allowedEvents?.length) return false
  for (const source of job.allowedEvents) {
    if (source.kind !== 'memory' || !source.path?.startsWith(binding.relativeDir + '/'))
      return false
    const note = await readNote(binding.vaultRoot, source.path, null, { home: deps.home }).catch(
      () => null,
    )
    if (!note || note.projectId !== binding.projectId || note.hash !== source.hash) return false
  }
  return true
}

/** Preserve already committed items when a changed source cancels the remaining work. */
export function retainedCurationOutput(job) {
  const applied = new Set((job.appliedItems ?? []).map((item) => item.idempotencyKey))
  return { items: (job.output?.items ?? []).filter((item) => applied.has(item.idempotencyKey)) }
}
