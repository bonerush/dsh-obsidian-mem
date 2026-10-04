// A real reviewer process, paused before it takes the vault lock when requested.
import { promises as fs } from 'node:fs'
import { reviewCurationProposal } from '../../lib/curation-review.js'

process.once('message', async ({ input, source, guard }) => {
  try {
    if (guard) {
      const { DatabaseSync } = await import('node:sqlite')
      const db = new DatabaseSync(guard)
      db.exec('BEGIN IMMEDIATE')
      await new Promise((resolve) => {
        process.once('message', resolve)
        process.send({ phase: 'locked' })
      })
      db.close()
      return
    }
    if (source) {
      const original = fs.readFile
      let gated = false
      fs.readFile = async (path, ...rest) => {
        if (path === source && !gated) {
          gated = true
          await new Promise((resolve) => {
            process.once('message', resolve)
            process.send({ phase: 'claimed' })
          })
        }
        return original(path, ...rest)
      }
    }
    const answer = await reviewCurationProposal({ ...input, now: new Date(input.now) })
    process.send({ phase: 'done', answer })
  } catch (error) {
    process.send({ phase: 'error', message: error.stack })
    process.exitCode = 1
  } finally {
    process.disconnect()
  }
})
