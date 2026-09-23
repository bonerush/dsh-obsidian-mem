/**
 * demo-counter — minimal DSH/Cordis plugin exercising all three surfaces:
 *   (a) `Config`  : the composition-entry config schema (loader-validated)
 *   (b) `apply(ctx, config)` : merged config with schema defaults already filled
 *   (c) durable counter : `defineDomain` + `ctx.storageDomain.open`
 *   (d) optional user layer : `ctx.settings.register` (runtime-editable)
 *
 * Certain: every API call below is quoted from the vendored sources.
 */
import z from '/Users/yukisala/.nvm/versions/node/v25.9.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/schemastery/lib/index.cjs'
import { defineDomain, domainTable } from '/Users/yukisala/.nvm/versions/node/v25.9.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-storage-domain/lib/index.js'
import { z as zod } from '/Users/yukisala/.dsh/profiles/web/node_modules/zod/index.js'

export const name = 'demo-counter'
export const inject = ['storageDomain', 'settings']

/** (a) Composition config. Defaults are applied by Cordis BEFORE apply() runs. */
export const Config = z.object({
  label: z.string().default('counter'),
  start: z.number().default(0),
})

/** (d) Independent user-settings namespace: /^[a-z][a-z0-9-]*$/, not derived from `name`. */
export const SETTINGS_NS = 'demo-counter'
export const SettingsSchema = z.object({ step: z.number().default(1) })

/** (c) Durable domain. name + table names must match /^[a-z][a-z0-9_]*$/ ; record schemas are zod. */
const counterSpec = defineDomain({
  name: 'demo_counter',
  version: 1,
  tables: { counters: domainTable(zod.object({ value: zod.number() })) },
})

export async function apply(ctx, config) {
  // (b) merged config — `start` arrives as 0 even though the row omitted it.
  console.log('[apply] merged config =', JSON.stringify(config))

  // (d) user layer sits ABOVE the composition entry; register() is a fiber effect.
  const scope = ctx.settings.register(SETTINGS_NS, SettingsSchema, { base: { step: 1 } })
  scope.watch((next) => console.log('[settings] ->', JSON.stringify(next)))
  const step = () => scope.get().step

  // (c) durable counter
  const domain = await ctx.storageDomain.open(counterSpec)
  ctx.effect(() => () => domain.close(), 'demo-counter: close domain')

  const table = domain.table('counters')
  const KEY = config.label
  if (table.get(KEY) === undefined) await table.put(KEY, { value: config.start })

  ctx.on('domain/changed', (change) => {
    if (change.domain === 'demo_counter') console.log('[domain/changed]', JSON.stringify(change))
  })

  await table.update(KEY, (row) => ({ value: row.value + step() }))
  await table.update(KEY, (row) => ({ value: row.value + step() }))
  console.log('[apply] durable value =', table.get(KEY).value, '| step =', step())
}
