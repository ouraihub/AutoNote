import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createHarness as baseHarness } from './support/ai-kit-harness'

import type { SearchPreferences } from '../src/worker/ai/search'

const prefs: SearchPreferences = {
  maxResults: 5,
  compression: 'none',
  cutoffLimit: 2000,
  blacklist: [],
  modelToolsPreferred: false,
}

let clock = Date.now()

beforeEach(() => {
  clock += 120_000
  vi.spyOn(Date, 'now').mockImplementation(() => clock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function createHarness() {
  const h = await baseHarness()
  return {
    ...h,
    json: <T = unknown>(...args: Parameters<typeof h.json>) => {
      clock += 61_000
      return h.json<T>(...args)
    },
    call: (...args: Parameters<typeof h.call>) => {
      clock += 61_000
      return h.call(...args)
    },
  }
}

describe('search execution', () => {
  it(
    'preserves complete fetch content beyond 24k with' + ' compression none',
    async () => {
      const h = await createHarness()
      const content = '正文😀'.repeat(10000)
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => Response.json({ data: { title: 'full', content } })),
      )
      const page = await h.json<{ content: string }>(
        'user-a',
        'POST',
        '/search/fetch',
        { url: 'https://public.test/full' },
      )
      expect(page.status).toBe(200)
      expect(page.body.content).toBe(content)
    },
  )

  it(
    'uses the same key retry executor for fetch and b' +
      'locks blacklisted URLs before networking',
    async () => {
      const h = await createHarness()
      await h.json('user-a', 'PUT', '/search/default', {
        capability: 'fetch',
        provider: 'jina',
      })
      for (const value of ['reader-one', 'reader-two'])
        await h.json('user-a', 'PUT', '/search/keys', {
          capability: 'fetch',
          provider: 'jina',
          value,
        })
      const mock = vi
        .fn()
        .mockResolvedValueOnce(new Response('', { status: 429 }))
        .mockResolvedValue(
          Response.json({ data: { title: 'page', content: '😀'.repeat(101) } }),
        )
      vi.stubGlobal('fetch', mock)
      await h.json('user-a', 'PUT', '/search/preferences', {
        ...prefs,
        compression: 'cutoff',
        cutoffLimit: 100,
        blacklist: ['example.com'],
      })
      expect(
        (
          await h.json('user-a', 'POST', '/search/fetch', {
            url: 'https://sub.example.com/a',
          })
        ).status,
      ).toBe(400)
      expect(mock).not.toHaveBeenCalled()
      const page = await h.json<{ content: string }>(
        'user-a',
        'POST',
        '/search/fetch',
        { url: 'https://public.test/a' },
      )
      expect(page.status).toBe(200)
      expect(page.body.content).toBe('😀'.repeat(100))
      expect(mock).toHaveBeenCalledTimes(2)
      mock.mockReset().mockResolvedValue(new Response('', { status: 500 }))
      await h.json('user-a', 'POST', '/search/fetch', {
        url: 'https://public.test/a',
      })
      expect(mock).toHaveBeenCalledTimes(1)
      await h.json('user-a', 'PUT', '/search/default', {
        capability: 'fetch',
        provider: 'fetch',
      })
      mock.mockReset().mockResolvedValue(
        new Response(null, {
          status: 302,
          headers: { location: 'https://sub.example.com/blocked' },
        }),
      )
      expect(
        (
          await h.json('user-a', 'POST', '/search/fetch', {
            url: 'https://public.test/a',
          })
        ).status,
      ).toBe(400)
      expect(mock).toHaveBeenCalledTimes(1)
      mock.mockReset().mockResolvedValue(
        new Response(null, {
          status: 302,
          headers: { location: 'http://127.0.0.1/private' },
        }),
      )
      expect(
        (
          await h.json('user-a', 'POST', '/search/fetch', {
            url: 'https://public.test/a',
          })
        ).status,
      ).toBe(400)
      expect(mock).toHaveBeenCalledTimes(1)
    },
  )
})
