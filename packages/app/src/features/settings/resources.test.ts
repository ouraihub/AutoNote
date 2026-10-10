import { describe, expect, test, vi } from 'vitest'
import type { Backend, BackendCapabilities } from '@app/backend'
import { createSettingsResource, createSettingsResources } from './resources'
import { settingsSections, sectionResources } from './sections'

function deferred<T>() {
  const { promise, resolve } = Promise.withResolvers<T>()
  return { promise, resolve }
}

const capabilities: BackendCapabilities = {
  ai: false,
  accounts: false,
  totp: false,
  share: false,
  remoteBackup: false,
  semanticSearch: false,
  mcp: null,
  realtime: false,
  remoteSync: false,
  updateCheck: false,
}

describe('settings resources and sections', () => {
  test('filters unsupported sections and gated host extensions', () => {
    const sections = settingsSections({ kind: 'desktop', capabilities } as Backend, [
      { id: 'desktop', order: 1, titleKey: 'settings.sync', canShow: () => true, component: (() => {}) as never },
      { id: 'hidden', order: 0, titleKey: 'settings.sync', canShow: () => false, component: (() => {}) as never },
    ])
    expect(sections.map((section) => section.id)).toEqual(['appearance', 'editor', 'data', 'desktop', 'about'])
    const enabled = settingsSections(
      { kind: 'web', capabilities: { ...capabilities, accounts: true, totp: false, mcp: 'remote', remoteBackup: true, share: true, remoteSync: true } } as Backend,
      [],
    )
    expect(enabled.map((section) => section.id)).toEqual([
      'appearance',
      'editor',
      'backup',
      'sync',
      'mcp',
      'account',
      'data',
      'shares',
      'about',
    ])
    expect(settingsSections({ kind: 'desktop', capabilities: { ...capabilities, mcp: 'local', accounts: true, share: true, remoteBackup: true, realtime: true, remoteSync: true } } as Backend, []).map((section) => section.id)).toEqual(['appearance', 'editor', 'data', 'about'])
    expect(
      sectionResources(
        enabled.find((section) => section.id === 'account')!,
        { ...capabilities, accounts: true },
      ),
    ).toEqual([])
  })

  test('deduplicates pending requests and ignores stale completion after cancellation', async () => {
    const first = deferred<number>()
    const second = deferred<number>()
    const fetcher = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const resource = createSettingsResource(fetcher)
    const pending = resource.load()
    expect(resource.load()).toBe(pending)
    expect(fetcher).toHaveBeenCalledTimes(1)
    resource.cancel()
    expect(fetcher.mock.calls[0]?.[0].aborted).toBe(true)
    const fresh = resource.load()
    second.resolve(2)
    expect(await fresh).toBe(2)
    first.resolve(1)
    expect(await pending).toBeUndefined()
    expect(resource.peek()).toBe(2)
  })

  test('a failed fetch permits retry without caching an error', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(3)
      .mockRejectedValueOnce(new Error('Offline'))
      .mockResolvedValueOnce(4)
    const resource = createSettingsResource(fetcher)
    expect(await resource.load()).toBe(3)
    resource.clear()
    await expect(resource.load()).rejects.toThrow('Offline')
    expect(resource.peek()).toBeUndefined()
    expect(await resource.load()).toBe(4)
  })

  test('clears all cached account resources on epoch change, including late responses', async () => {
    const previous = deferred<Record<string, number>>()
    const stats = vi.fn().mockReturnValueOnce(previous.promise).mockResolvedValueOnce({ notes: 2 })
    const backend = { settings: { stats } } as unknown as Backend
    const resources = createSettingsResources(backend)
    const old = resources.load('stats', 1)
    const next = resources.load('stats', 2)
    expect(stats.mock.calls[0]?.[0].signal.aborted).toBe(true)
    expect(await next).toEqual({ notes: 2 })
    previous.resolve({ notes: 1 })
    expect(await old).toBeUndefined()
    expect(resources.peek('stats')).toEqual({ notes: 2 })
    resources.clear()
    expect(resources.peek('stats')).toBeUndefined()
  })
})
