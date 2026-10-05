import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findGeneratedConfig } from './deploy.mjs'

test('deploy selects only fresh single mode output and preserves custom worker names', async () => {
  const root = await mkdtemp(join(tmpdir(), 'autonote-deploy-'))
  try {
    const worker = join(root, 'my_custom_worker')
    const client = join(root, 'client')
    await mkdir(worker)
    await mkdir(client)
    const configPath = join(root, 'custom.toml')
    const output = join(worker, 'wrangler.json')
    const startedAt = Date.now() - 2000
    await writeFile(join(client, 'index.html'), '<h1>AutoNote</h1>')
    await writeFile(join(worker, 'index.js'), 'export default {}')
    await writeFile(output, JSON.stringify({ name: 'my-custom-worker', userConfigPath: configPath, main: 'index.js', assets: { directory: '../client' } }))
    const source = { name: 'my-custom-worker', configPath }
    assert.equal(await findGeneratedConfig(root, startedAt, source), output)
    await assert.rejects(findGeneratedConfig(root, startedAt, { ...source, name: 'wrong-mode' }), /name/)
    await assert.rejects(findGeneratedConfig(root, startedAt, { ...source, configPath: join(root, 'kv.toml') }), /different mode/)
    await assert.rejects(findGeneratedConfig(root, startedAt, { ...source, config: { ai: { binding: 'AI' } } }), /binding differs/)
    await writeFile(output, JSON.stringify({ name: source.name, userConfigPath: configPath, main: 'index.js', assets: { directory: '../client' }, d1_databases: [{ binding: 'DB', database_id: 'user-id', migrations_dir: '../../migrations' }] }))
    assert.equal(await findGeneratedConfig(root, startedAt, { ...source, config: { d1_databases: [{ binding: 'DB', database_id: 'user-id', migrations_dir: 'migrations' }] } }), output)
    await utimes(output, 1, 1)
    await assert.rejects(findGeneratedConfig(root, startedAt, source), /stale/)
    await utimes(output, new Date(), new Date())
    await mkdir(join(root, 'old-worker'))
    await writeFile(join(root, 'old-worker/wrangler.json'), '{}')
    await assert.rejects(findGeneratedConfig(root, startedAt, source), /exactly one/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
