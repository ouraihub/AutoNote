import { readdir, readFile, stat, realpath, mkdir, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, resolve, relative, isAbsolute } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const webRoot = fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(import.meta.url)

export async function findGeneratedConfig(root, startedAt, source) {
  const candidates = []
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile() && entry.name === 'wrangler.json') candidates.push(path)
    }
  }
  await visit(root)
  if (candidates.length !== 1) throw new Error(`Expected exactly one generated wrangler.json; found ${candidates.length}. Remove stale build outputs explicitly and rebuild.`)
  const path = candidates[0]
  if ((await stat(path)).mtimeMs < startedAt) throw new Error('Generated Wrangler config is stale')
  const config = JSON.parse(await readFile(path, 'utf8'))
  if (!config.name || config.name !== source.name) throw new Error('Generated Worker name does not match this mode configuration')
  if (typeof config.assets?.directory !== 'string') throw new Error('Generated Wrangler config has no assets directory')
  const assets = await realpath(resolve(dirname(path), config.assets.directory))
  const expectedAssets = await realpath(resolve(root, 'client'))
  if (assets !== expectedAssets) throw new Error('Generated assets directory does not match dist/client')
  const inside = relative(await realpath(root), assets)
  if (inside.startsWith('..') || isAbsolute(inside)) throw new Error('Generated assets directory escapes build output')
  if ((await stat(resolve(assets, 'index.html'))).mtimeMs < startedAt) throw new Error('Client assets are stale')
  if (typeof config.main !== 'string' || (await stat(resolve(dirname(path), config.main))).mtimeMs < startedAt) throw new Error('Generated Worker entry is missing or stale')
  if (resolve(config.userConfigPath ?? config.configPath ?? '') !== resolve(source.configPath)) throw new Error('Generated config was built from a different mode configuration')
  if (source.config) {
    const normalized = (key, value) => key === 'd1_databases' ? value?.map(({ migrations_dir, ...binding }) => binding) : value
    for (const key of ['d1_databases', 'r2_buckets', 'kv_namespaces', 'durable_objects', 'exports', 'ai', 'triggers', 'vars']) {
      if (JSON.stringify(normalized(key, config[key])) !== JSON.stringify(normalized(key, source.config[key]))) throw new Error(`Generated binding differs from source: ${key}`)
    }
    if (JSON.stringify(config.assets.run_worker_first) !== JSON.stringify(source.config.assets?.run_worker_first)) throw new Error('Generated Worker routing differs from source')
  }
  return path
}

function run(bin, args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [bin, ...args], { cwd: webRoot, stdio: 'inherit', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } })
    child.once('error', reject)
    child.once('exit', (code, signal) => code === 0 ? resolveRun() : reject(new Error(`Command failed (${signal ?? code}): ${args.join(' ')}`)))
  })
}

export async function deploy(args = process.argv.slice(2)) {
  let mode = 'production'
  let dryRun = false
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--dry-run') dryRun = true
    else if (args[index] === '--mode' && args[index + 1]) mode = args[++index]
    else throw new Error(`Unknown deployment argument: ${args[index]}`)
  }
  if (!['production', 'kv', 'ai', 'demo'].includes(mode)) throw new Error(`Unsupported build mode: ${mode}`)
  const { unstable_readConfig } = await import('wrangler')
  const configPath = resolve(webRoot, mode === 'demo' ? 'wrangler.demo.toml' : mode === 'kv' ? 'wrangler.kv.toml' : 'wrangler.toml')
  const source = unstable_readConfig({ config: configPath }, { useRedirectIfAvailable: false })
  if (!source.name) throw new Error('Worker name is required')
  await run(require.resolve('typescript/bin/tsc'), ['-b'])
  await run(require.resolve('svelte-check/bin/svelte-check'), ['--tsconfig', './tsconfig.client.json', '--fail-on-warnings'])
  const startedAt = Date.now()
  await run(resolve(dirname(require.resolve('vite/package.json')), 'bin/vite.js'), ['build', '--mode', mode])
  let generated
  if (mode === 'demo') {
    const assets = await realpath(resolve(webRoot, 'dist/demo'))
    if (source.main || source.assets?.binding || source.d1_databases?.length || source.r2_buckets?.length || source.kv_namespaces?.length || source.durable_objects?.bindings?.length || source.ai || source.triggers?.crons?.length) throw new Error('Demo deployment must be static with no bindings')
    if (await realpath(resolve(dirname(configPath), source.assets?.directory ?? '')) !== assets) throw new Error('Demo assets directory must be dist/demo')
    if ((await stat(resolve(assets, 'index.html'))).mtimeMs < startedAt) throw new Error('Demo assets are stale')
    const directory = resolve(webRoot, '.wrangler/deploy-demo')
    await mkdir(directory, { recursive: true })
    generated = resolve(directory, 'wrangler.json')
    await writeFile(generated, JSON.stringify({ name: source.name, compatibility_date: source.compatibility_date, assets: { directory: assets, not_found_handling: 'single-page-application' } }))
  } else generated = await findGeneratedConfig(resolve(webRoot, 'dist'), startedAt, { name: source.name, configPath, config: source })
  await run(resolve(dirname(require.resolve('wrangler/package.json')), 'bin/wrangler.js'), ['deploy', '--config', generated, ...(dryRun ? ['--dry-run'] : [])])
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  deploy().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
