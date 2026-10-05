import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'

const CORE_PUBLIC = ['manifest.webmanifest', 'favicon.ico', 'autonote-logo.png', 'apple-touch-icon.png', 'pwa-192x192.png', 'pwa-512x512.png', 'pwa-maskable-512x512.png']
const PUBLIC = [...CORE_PUBLIC, 'autonote-markdown-demo.svg']
const CORE_MODULES = ['/src/client/App.svelte', '/packages/app/src/root/AppRoot.svelte', '/packages/app/src/features/workspace/Workspace.svelte', '/packages/app/src/features/auth/LoginPage.svelte', '/packages/app/src/editor/CodeEditor.svelte', '/packages/shared/src/locales/en-US.ts', '/packages/shared/src/locales/zh-CN.ts']

interface BuildChunk {
  type: 'chunk'
  fileName: string
  code: string
  isEntry: boolean
  modules: Record<string, unknown>
  imports: string[]
  viteMetadata?: { importedCss?: Set<string>; importedAssets?: Set<string> }
  facadeModuleId?: string | null
}
interface BuildAsset { type: 'asset'; fileName: string; source: string | Uint8Array }
type BuildBundle = Record<string, BuildChunk | BuildAsset>

/** Generates the same-origin static shell; never caches application data. */
export function autonotePwa(): Plugin {
  return {
    name: 'autonote:pwa',
    apply: 'build',
    applyToEnvironment: (environment) => environment.name === 'client',
    generateBundle(_options, bundle) {
      const entries = Object.values(bundle).filter((entry) => !entry.fileName.endsWith('.map'))
      const allFiles = [...new Set(['index.html', ...entries.map((entry) => entry.fileName), ...PUBLIC])].sort()
      const hash = createHash('sha256')
      for (const entry of entries.sort((a, b) => a.fileName.localeCompare(b.fileName))) {
        hash.update(entry.fileName)
        hash.update(entry.type === 'chunk' ? entry.code : entry.source)
      }
      for (const file of PUBLIC) {
        hash.update(file)
        hash.update(readFileSync(fileURLToPath(new URL(`./public/${file}`, import.meta.url))))
      }
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: serviceWorkerSource(hash.digest('hex').slice(0, 16), collectCoreFiles(bundle as BuildBundle).map((file) => `/${file}`), allFiles.map((file) => `/${file}`)) })
    },
  }
}

export function collectCoreFiles(bundle: BuildBundle): string[] {
  const files = new Set(['index.html', ...CORE_PUBLIC])
  const pending = Object.values(bundle).filter((entry): entry is BuildChunk => entry.type === 'chunk' && (entry.isEntry || Object.keys(entry.modules).some((id) => CORE_MODULES.some((suffix) => id.replaceAll('\\', '/').endsWith(suffix)))))
  while (pending.length) {
    const chunk = pending.pop()
    if (!chunk || files.has(chunk.fileName)) continue
    files.add(chunk.fileName)
    for (const asset of [...chunk.viteMetadata?.importedCss ?? [], ...chunk.viteMetadata?.importedAssets ?? []]) files.add(asset)
    for (const imported of chunk.imports) {
      const dependency = bundle[imported]
      if (dependency?.type === 'chunk') pending.push(dependency)
      else if (dependency) files.add(dependency.fileName)
    }
  }
  const index = bundle['index.html']
  if (index?.type === 'asset') {
    const html = typeof index.source === 'string' ? index.source : new TextDecoder().decode(index.source)
    for (const match of html.matchAll(/(?:src|href)=["']\/?([^"'#?]+)["']/g)) {
      const file = match[1]
      if (file && (bundle[file] || CORE_PUBLIC.includes(file))) files.add(file)
    }
  }
  return [...files].sort()
}

export function serviceWorkerSource(buildId: string, coreUrls: string[], allUrls: string[]): string {
  return `const BUILD_ID = ${JSON.stringify(buildId)}
const SHELL_CACHE = 'autonote-shell-' + BUILD_ID
const ASSET_CACHE = 'autonote-assets-v1'
const CORE_URLS = ${JSON.stringify(coreUrls)}
const ALL_URLS = ${JSON.stringify(allUrls)}
const STATIC_URLS = new Set(ALL_URLS)
const OPTIONAL_URLS = ALL_URLS.filter(url => !CORE_URLS.includes(url))
const MANIFEST_PREFIX = '/.autonote-offline-manifest/'
const HISTORY_PREFIX = '/.autonote-build-history/'
let warmPromise = null

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const shell = await caches.open(SHELL_CACHE)
    const assets = await caches.open(ASSET_CACHE)
    await concurrent(CORE_URLS, 4, async url => {
      const reused = immutable(url) ? await assets.match(url) : null
      const response = reused || await required(url)
      await shell.put(url, response.clone())
      if (immutable(url)) await assets.put(url, response.clone())
    })
    await assets.put(HISTORY_PREFIX + BUILD_ID, new Response(JSON.stringify({ buildId: BUILD_ID, urls: ALL_URLS })))
    await pruneHistory(assets)
  })())
})

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const assets = await caches.open(ASSET_CACHE)
    for (const name of await caches.keys()) {
      if (!name.startsWith('autonote-shell-') || name === SHELL_CACHE) continue
      const old = await caches.open(name)
      const urls = []
      // Preserve old core chunks before removing old shells: an open tab may lazy-import them.
      for (const request of await old.keys()) {
        const path = new URL(request.url).pathname
        if (!immutable(path)) continue
        const response = await old.match(request)
        if (response) { await assets.put(path, response); urls.push(path) }
      }
      const id = name.slice('autonote-shell-'.length)
      if (!await assets.match(HISTORY_PREFIX + id)) await assets.put(HISTORY_PREFIX + id, new Response(JSON.stringify({ buildId: id, urls })))
      await caches.delete(name)
    }
    await self.clients.claim()
  })())
})

self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') { event.waitUntil(self.skipWaiting()); return }
  if (event.data?.type === 'GET_OFFLINE_CACHE_STATUS') { event.waitUntil(report(event.source)); return }
  if (event.data?.type === 'WARM_OFFLINE_CACHE') event.waitUntil(warm())
})

self.addEventListener('fetch', event => {
  const request = event.request
  const url = new URL(request.url)
  if (request.method !== 'GET' || url.origin !== self.location.origin || networkOnly(url.pathname)) return
  if (request.mode === 'navigate') {
    // Never put network HTML (including share metadata) in Cache Storage.
    event.respondWith(fetch(request).catch(async () => (await (await caches.open(SHELL_CACHE)).match('/index.html')) || Response.error()))
    return
  }
  if (!STATIC_URLS.has(url.pathname) && !immutable(url.pathname)) return
  event.respondWith((async () => {
    const shell = await caches.open(SHELL_CACHE)
    const assets = await caches.open(ASSET_CACHE)
    const cached = await shell.match(url.pathname) || await assets.match(url.pathname)
    if (cached) return cached
    const response = await fetch(request)
    if (response.ok && STATIC_URLS.has(url.pathname)) await assets.put(url.pathname, response.clone())
    return response
  })())
})

function networkOnly(path) {
  return ['/api', '/authorize', '/mcp', '/oauth', '/.well-known', '/files', '/attachments'].some(prefix => path === prefix || path.startsWith(prefix + '/'))
}
function immutable(path) { return path.startsWith('/assets/') }
async function required(url) {
  const response = await fetch(url, { cache: 'reload' })
  if (!response.ok) throw new Error('Static resource HTTP ' + response.status)
  return response
}
async function concurrent(values, limit, work) {
  let index = 0
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (index < values.length) await work(values[index++])
  }))
}
function warm() {
  if (!warmPromise) warmPromise = runWarm().finally(() => { warmPromise = null })
  return warmPromise
}
async function countAvailable() {
  const shell = await caches.open(SHELL_CACHE), assets = await caches.open(ASSET_CACHE)
  let completed = 0
  await concurrent(ALL_URLS, 8, async url => { if (await shell.match(url) || await assets.match(url)) completed++ })
  return completed
}
async function runWarm() {
  const assets = await caches.open(ASSET_CACHE)
  if (await assets.match(MANIFEST_PREFIX + BUILD_ID)) { await status('ready', ALL_URLS.length); return }
  let completed = await countAvailable()
  await status('preparing', completed)
  try {
    let processed = 0
    await concurrent(OPTIONAL_URLS, 1, async url => {
      if (!await assets.match(url)) { await assets.put(url, await required(url)); completed++ }
      if (++processed % 8 === 0) await status('preparing', completed)
      await new Promise(resolve => setTimeout(resolve, 75))
    })
    await assets.put(MANIFEST_PREFIX + BUILD_ID, new Response(JSON.stringify({ buildId: BUILD_ID, createdAt: Date.now(), urls: OPTIONAL_URLS })))
    await pruneHistory(assets)
    await status('ready', ALL_URLS.length)
  } catch {
    // Final boundary: report failure to clients without logging URLs or response bodies.
    await status('error', await countAvailable())
  }
}
async function report(target) {
  const assets = await caches.open(ASSET_CACHE)
  const ready = Boolean(await assets.match(MANIFEST_PREFIX + BUILD_ID))
  const message = { type: 'OFFLINE_CACHE_STATUS', buildId: BUILD_ID, status: ready ? 'ready' : 'idle', completed: ready ? ALL_URLS.length : await countAvailable(), total: ALL_URLS.length }
  if (target && 'postMessage' in target) target.postMessage(message)
}
async function status(state, completed) {
  const message = { type: 'OFFLINE_CACHE_STATUS', buildId: BUILD_ID, status: state, completed, total: ALL_URLS.length }
  for (const client of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) client.postMessage(message)
}
async function pruneHistory(cache) {
  // ponytail: retain history while any tab is open; per-client build leases only if storage pressure warrants them.
  if ((await self.clients.matchAll({ type: 'window', includeUncontrolled: true })).length) return
  const manifests = []
  for (const request of await cache.keys()) {
    const path = new URL(request.url).pathname
    if (!path.startsWith(HISTORY_PREFIX) && !path.startsWith(MANIFEST_PREFIX)) continue
    const response = await cache.match(request)
    if (!response) continue
    try {
      const value = await response.json()
      if (typeof value.buildId === 'string' && Array.isArray(value.urls) && value.urls.every(url => typeof url === 'string')) manifests.push({ path, ...value })
    } catch { /* Invalid manifests are retained rather than guessed or used to delete resources. */ }
  }
  const keep = new Set(ALL_URLS)
  for (const manifest of manifests) {
    if (manifest.buildId === BUILD_ID) continue
    for (const url of manifest.urls) if (!keep.has(url)) await cache.delete(url)
    await cache.delete(manifest.path)
  }
}
`
}
