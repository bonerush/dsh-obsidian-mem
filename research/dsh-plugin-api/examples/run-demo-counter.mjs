const D='/Users/yukisala/.nvm/versions/node/v25.9.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'
const { Context } = await import(D+'/cordis/lib/index.js')
const Storage = (await import(D+'/dsh-storage/lib/index.js')).default
const StorageJson = await import(D+'/dsh-storage-json/lib/index.js')
const StorageDomain = await import(D+'/dsh-storage-domain/lib/index.js')
const SettingsFile = (await import(D+'/dsh-settings-file/lib/index.js')).default
const fs = await import('node:fs/promises')

const root = new Context()
await root.plugin(Storage)
await root.plugin(StorageJson, { root: '/tmp/dsh-probe/demo/storages' })
await root.plugin(StorageDomain, { backend: 'json' })
const settingsFiber = root.plugin(SettingsFile, { path: '/tmp/dsh-probe/demo/settings.yaml' })
await settingsFiber

const plug = await import('/tmp/dsh-probe/demo/counter.js')
const f1 = root.plugin(plug, { label: 'hits' }); await f1
await new Promise(r => setTimeout(r, 200))
console.log('SETTINGS WRITE ->')
await root.settings.update('demo-counter', { step: 10 })
await new Promise(r => setTimeout(r, 200))
console.log('settings.yaml =\n' + await fs.readFile('/tmp/dsh-probe/demo/settings.yaml','utf8'))
await f1.dispose(); await new Promise(r=>setTimeout(r,200));
const f2 = root.plugin(plug)   // remount after dispose: NO config -> all defaults
await f2
await f2.dispose()
await new Promise(r => setTimeout(r, 300))
console.log('unit file =\n' + await fs.readFile('/tmp/dsh-probe/demo/storages/demo_counter.json','utf8'))
await settingsFiber.dispose()
