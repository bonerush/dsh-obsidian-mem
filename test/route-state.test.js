// The remembered model route behind the automatic reviewer.
//
// `distill.provider`/`distill.model` is the explicit route; when the pair is empty
// a background pass may use the route the capture seam last observed for the
// project. These cases pin the contract: the private file is derived from the data
// root, a remembered pair round-trips and can be resolved without configuration, an
// explicit pair always wins, entries are bounded and the oldest is dropped, a
// stale/corrupt/foreign-shaped file reads as absent, malformed routes are refused,
// and every failure fails open to "no remembered route" instead of throwing.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { assertPrivateFile } from './platform-capabilities.js'

import { writePrivateJson } from '../lib/delivery-state.js'
import {
  REVIEW_ROUTE_MAX_BYTES,
  REVIEW_ROUTE_MAX_PROJECTS,
  REVIEW_ROUTE_SCHEMA,
  REVIEW_ROUTE_TTL_MS,
  normalizeReviewRoute,
  readRememberedRoute,
  rememberSessionRoute,
  resolveReviewRoute,
  reviewRoutePath,
} from '../lib/route-state.js'

const PROJECT_ID = '1c392abb-7b08-42f7-871d-2a379caf9448'
const OTHER_PROJECT_ID = '4d2f7c11-3a01-4e3b-9f0e-111111111111'
const NOW = 1_760_000_000_000
const ROUTE = { provider: 'deepseek-official', model: 'deepseek-chat' }

/**
 * A throwaway data root.
 *
 * @param {object} t - the node:test context.
 * @returns {Promise<{root: string, dataRoot: string}>} the fixture.
 */
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'obsidian-mem-route-state-'))
  const dataRoot = join(root, 'data')
  await mkdir(dataRoot, { recursive: true })
  t.after(async () => rm(root, { recursive: true, force: true, maxRetries: 4 }))
  return { root, dataRoot }
}

test('a remembered route round-trips through a private bounded file', async (t) => {
  const { dataRoot } = await fixture(t)
  const path = reviewRoutePath({ dataRoot })
  assert.equal(path, join(dataRoot, 'review-route.json'))
  assert.equal(
    await rememberSessionRoute({ dataRoot, projectId: PROJECT_ID, route: ROUTE, now: NOW }),
    true,
  )
  const read = await readRememberedRoute({ dataRoot, projectId: PROJECT_ID, now: NOW + 1000 })
  assert.deepEqual(read, {
    provider: 'deepseek-official',
    model: 'deepseek-chat',
    updatedAt: new Date(NOW).toISOString(),
  })
  const info = await assertPrivateFile(path, 0o600)
  assert.ok(info.size <= REVIEW_ROUTE_MAX_BYTES)
})

test('a remembered route resolves only when the configured pair is empty', async (t) => {
  const { dataRoot } = await fixture(t)
  // No configuration and no observation: nothing may guess a provider.
  assert.equal(
    await resolveReviewRoute({
      config: { distill: { provider: '', model: '' } },
      dataRoot,
      projectId: PROJECT_ID,
    }),
    null,
  )
  await rememberSessionRoute({ dataRoot, projectId: PROJECT_ID, route: ROUTE, now: NOW })
  assert.deepEqual(
    await resolveReviewRoute({
      config: { distill: { provider: '', model: '' } },
      dataRoot,
      projectId: PROJECT_ID,
      now: NOW + 1000,
    }),
    { ...ROUTE, source: 'remembered' },
  )
  // An explicit pair always wins, even when a different conversation route exists.
  assert.deepEqual(
    await resolveReviewRoute({
      config: { distill: { provider: 'cloud-a', model: 'model-a' } },
      dataRoot,
      projectId: PROJECT_ID,
      now: NOW + 1000,
    }),
    { provider: 'cloud-a', model: 'model-a', source: 'config' },
  )
})

test('a remembered route expires after the TTL and is per project', async (t) => {
  const { dataRoot } = await fixture(t)
  await rememberSessionRoute({ dataRoot, projectId: PROJECT_ID, route: ROUTE, now: NOW })
  await rememberSessionRoute({
    dataRoot,
    projectId: OTHER_PROJECT_ID,
    route: { provider: 'other', model: 'other-model' },
    now: NOW,
  })
  assert.deepEqual(
    await readRememberedRoute({ dataRoot, projectId: PROJECT_ID, now: NOW + REVIEW_ROUTE_TTL_MS }),
    { ...ROUTE, updatedAt: new Date(NOW).toISOString() },
    'the boundary is still inside the TTL',
  )
  assert.equal(
    await readRememberedRoute({
      dataRoot,
      projectId: PROJECT_ID,
      now: NOW + REVIEW_ROUTE_TTL_MS + 1,
    }),
    null,
  )
  assert.equal(
    await readRememberedRoute({ dataRoot, projectId: 'no-such-project', now: NOW }),
    null,
  )
  assert.equal(await readRememberedRoute({ dataRoot, projectId: '', now: NOW }), null)
})

test('the file keeps only the newest projects, dropping the oldest entry', async (t) => {
  const { dataRoot } = await fixture(t)
  const path = reviewRoutePath({ dataRoot })
  const projects = {}
  for (let index = 0; index < REVIEW_ROUTE_MAX_PROJECTS; index += 1) {
    projects[`00000000-0000-4000-8000-${String(index).padStart(12, '0')}`] = {
      provider: 'p',
      model: `m-${index}`,
      updatedAt: new Date(NOW - (REVIEW_ROUTE_MAX_PROJECTS - index) * 1000).toISOString(),
    }
  }
  // A corrupt-shaped entry must not stop the rest from being usable.
  projects['ffffffff-ffff-4fff-8fff-ffffffffffff'] = 'not a route'
  await writePrivateJson({
    path,
    root: dataRoot,
    value: { schema: REVIEW_ROUTE_SCHEMA, projects },
  })
  assert.equal(
    await rememberSessionRoute({
      dataRoot,
      projectId: PROJECT_ID,
      route: ROUTE,
      now: NOW + REVIEW_ROUTE_TTL_MS / 2,
    }),
    true,
  )
  const after = await readRememberedRoute({ dataRoot, projectId: PROJECT_ID, now: NOW + 2000 })
  assert.ok(after !== null, 'the newest entry is kept')
  const oldest = '00000000-0000-4000-8000-000000000000'
  assert.equal(await readRememberedRoute({ dataRoot, projectId: oldest, now: NOW }), null)
})

test('a stale, corrupt, foreign or blank-keyed file reads as no remembered route', async (t) => {
  const { dataRoot } = await fixture(t)
  const path = reviewRoutePath({ dataRoot })
  await writePrivateJson({
    path,
    root: dataRoot,
    value: { schema: REVIEW_ROUTE_SCHEMA + 1, projects: { [PROJECT_ID]: ROUTE } },
  })
  assert.equal(await readRememberedRoute({ dataRoot, projectId: PROJECT_ID, now: NOW }), null)

  await writePrivateJson({
    path,
    root: dataRoot,
    value: { schema: REVIEW_ROUTE_SCHEMA, projects: { [PROJECT_ID]: ROUTE } },
  })
  // A route with no updatedAt cannot be age-checked, so it must not be used.
  assert.equal(await readRememberedRoute({ dataRoot, projectId: PROJECT_ID, now: NOW }), null)

  await writePrivateJson({ path, root: dataRoot, value: 'not an object' })
  assert.equal(await readRememberedRoute({ dataRoot, projectId: PROJECT_ID, now: NOW }), null)
})

test('observed routes are normalized: identity characters only, bounded length', async (t) => {
  const { dataRoot } = await fixture(t)
  assert.deepEqual(
    normalizeReviewRoute({ provider: '  deepseek-official  ', model: ' deepseek-chat ' }),
    {
      provider: 'deepseek-official',
      model: 'deepseek-chat',
    },
  )
  assert.equal(normalizeReviewRoute({ provider: '', model: 'm' }), null)
  assert.equal(normalizeReviewRoute({ provider: 'p', model: -1 }), null)
  assert.equal(normalizeReviewRoute({ provider: 'p', model: 'bad model' }), null)
  assert.equal(normalizeReviewRoute({ provider: 'p', model: 'm'.repeat(201) }), null)
  assert.equal(normalizeReviewRoute(null), null)
  assert.equal(
    await rememberSessionRoute({
      dataRoot,
      projectId: PROJECT_ID,
      route: { provider: '', model: 'm' },
    }),
    false,
  )
  assert.equal(await readRememberedRoute({ dataRoot, projectId: PROJECT_ID }), null)
})

test('remembering never throws: an unwritable root costs only that observation', async (t) => {
  const { root } = await fixture(t)
  const missing = join(root, 'missing', 'data')
  assert.equal(
    await rememberSessionRoute({ dataRoot: missing, projectId: PROJECT_ID, route: ROUTE }),
    true,
    'a private directory chain is created below the data root',
  )
  assert.equal(
    await rememberSessionRoute({ dataRoot: '', projectId: PROJECT_ID, route: ROUTE }),
    false,
  )
  assert.equal(
    await rememberSessionRoute({ dataRoot: missing, projectId: '', route: ROUTE }),
    false,
  )
  assert.equal(await readRememberedRoute({ dataRoot: missing, projectId: 'no-such-project' }), null)
  assert.equal(await readRememberedRoute({ dataRoot: '', projectId: PROJECT_ID }), null)
  assert.equal(
    await resolveReviewRoute({
      config: { distill: { provider: '', model: '' } },
      dataRoot: join(root, 'gone'),
      projectId: PROJECT_ID,
    }),
    null,
  )
})
