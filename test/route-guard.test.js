import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MAX_BODY_BYTES, payloadOf } from '../lib/route-guard.js'

const request = (...chunks) => ({
  async *[Symbol.asyncIterator]() {
    yield* chunks
  },
})

test('JSON payload preserves Chinese when HTTP chunks split a UTF-8 character', async () => {
  const bytes = Buffer.from(JSON.stringify({ query: '中文' }))
  for (let split = 1; split < bytes.length; split += 1) {
    assert.deepEqual(await payloadOf(request(bytes.subarray(0, split), bytes.subarray(split))), {
      query: '中文',
    })
  }
})

test('the body bound counts raw bytes at and above 4096 even across UTF-8 chunks', async () => {
  const text = JSON.stringify({ query: '中'.repeat(1360) + 'a'.repeat(4) })
  const bytes = Buffer.from(text)
  assert.equal(bytes.length, MAX_BODY_BYTES)
  assert.deepEqual(await payloadOf(request(bytes.subarray(0, 11), bytes.subarray(11))), {
    query: '中'.repeat(1360) + 'a'.repeat(4),
  })
  await assert.rejects(() => payloadOf(request(bytes, Buffer.from(' '))), /request too large/u)
  await assert.rejects(() => payloadOf(request(Buffer.from('{'))), SyntaxError)
  await assert.rejects(() => payloadOf(request(Buffer.from('[]'))), /request must be an object/u)
})
