// Isolated real-host probe. Records metadata only; never shipped.
import { appendFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'dsh-obsidian-mem-failure-driver'
export const inject = ['tools']

/** Mount a controlled failing tool and witness the native committed events. */
export function apply(ctx) {
  const record = (entry) =>
    appendFileSync(process.env.FAILURE_PROBE_RECORD, `${JSON.stringify(entry)}\n`)
  ctx.tools.register(
    defineTool({
      name: 'probe',
      description: 'Run the isolated project probe with a mode string.',
      parameters: { mode: { type: 'string', required: true } },
      output: {
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean', required: true } },
          additionalProperties: false,
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute({ mode }) {
        if (mode !== 'repair') throw new Error('ENOENT: probe target not found')
        return { ok: true }
      },
    }),
  )
  let timer = null
  const names = new Map()
  ctx.on('session/event', (_session, event) => {
    if (event.type === 'tool/call') names.set(event.data?.callId, event.data?.name)
    if (event.type === 'tool/result')
      record({
        type: event.type,
        seq: event.seq,
        turn: event.data?.turn,
        step: event.data?.step,
        isError: event.data?.message?.isError === true,
        probe: names.get(event.data?.message?.toolCallId) === 'probe',
      })
    if (event.type === 'user/message' && event.data?.source?.kind === 'plugin:obsidian-mem') {
      record({
        type: 'recall',
        seq: event.seq,
        trigger: event.data.source.trigger ?? null,
        chars: event.data.content.reduce((n, part) => n + [...(part.text ?? '')].length, 0),
      })
    }
    if (event.type !== 'turn/end') return
    record({ type: event.type, seq: event.seq, reason: event.data?.reason?.kind })
    const pending = join(process.env.DSH_HOME, 'data/obsidian-mem/pending')
    const receipts = join(pending, 'receipts')
    const deadline = Date.now() + 90_000
    if (timer) return
    timer = setInterval(() => {
      if (
        process.env.FAILURE_PROBE_KILL === '1' &&
        existsSync(pending) &&
        readdirSync(pending).some((p) => p.endsWith('.json'))
      ) {
        record({ type: 'durable-job' })
        clearInterval(timer)
        process.kill(process.pid, 'SIGKILL')
      } else if (
        existsSync(receipts) &&
        readdirSync(receipts).some((project) =>
          readdirSync(join(receipts, project)).some((p) => p.endsWith('.json')),
        )
      ) {
        record({ type: 'durable-receipt' })
        clearInterval(timer)
      } else if (Date.now() > deadline) {
        record({ type: 'receipt-timeout' })
        clearInterval(timer)
      }
    }, 25)
  })
}
