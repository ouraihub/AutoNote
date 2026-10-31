import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHarness as baseHarness } from './support/ai-kit-harness'
import type {
  SearchSettingsDto,
  SearchPreferences,
} from '../src/worker/ai/search'
import { hashPassword } from '../src/worker/lib/password'

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

describe('search HTTP settings and execution', () => {
  it('stores bound keys, updates without replacing identities, requires password and isolates users and capabilities', async () => {
    const h = await createHarness()
    await h.env.DB.prepare(
      "INSERT INTO users (id, username, password_hash, login, created_at, last_seen_at) VALUES ('user-a', 'user-a', ?1, 'user-a', 0, 0)",
    )
      .bind(await hashPassword('correct-password'))
      .run()
    const input = { capability: 'search', provider: 'tavily' }
    const saved = await h.json<SearchSettingsDto>(
      'user-a',
      'PUT',
      '/search/keys',
      {
        ...input,
        value: '  private-first-key  ',
      },
    )
    expect(saved.status).toBe(200)
    const first = saved.body.providers.find((p) => p.id === 'tavily')!.keys[0]!
    expect(first.masked).not.toContain('private-first-key')
    const stored = await h.env.DB.prepare(
      'SELECT key_ciphertext AS cipher FROM ai_search_keys WHERE id = ?1',
    )
      .bind(first.id)
      .first<{ cipher: string }>()
    expect(JSON.parse(stored!.cipher)).toMatchObject({
      value: { apiKey: 'private-first-key' },
    })
    expect(JSON.parse(stored!.cipher).scope).toContain(first.id)
    await h.json('user-a', 'PUT', '/search/keys', {
      ...input,
      value: 'second-key',
    })
    const changed = await h.json<SearchSettingsDto>(
      'user-a',
      'PUT',
      '/search/keys',
      {
        ...input,
        keyId: first.id,
        value: 'replacement-key',
      },
    )
    expect(
      changed.body.providers
        .find((p) => p.id === 'tavily')!
        .keys.map((k) => k.id),
    ).toContain(first.id)
    const address = await h.json<SearchSettingsDto>(
      'user-a',
      'PUT',
      '/search/providers',
      {
        ...input,
        baseUrl: 'https://search.example.com',
      },
    )
    expect(
      address.body.providers.find((p) => p.id === 'tavily')!.keys,
    ).toHaveLength(2)
    expect(
      (await h.json('user-a', 'PUT', '/search/keys', { ...input, value: ' ' }))
        .status,
    ).toBe(400)
    expect(
      (
        await h.json('user-a', 'PUT', '/search/providers', {
          ...input,
          apiKey: 'legacy',
        })
      ).status,
    ).toBe(400)
    for (const [user, capability, provider] of [
      ['user-b', 'search', 'tavily'],
      ['user-a', 'fetch', 'jina'],
      ['user-a', 'search', 'exa'],
    ]) {
      expect(
        (
          await h.json(user!, 'PUT', '/search/keys', {
            capability,
            provider,
            keyId: first.id,
            value: 'wrong-owner',
          })
        ).status,
      ).toBe(400)
    }
    expect(
      (
        await h.json('user-a', 'POST', '/search/reveal', {
          ...input,
          keyId: first.id,
          currentPassword: 'wrong',
        })
      ).status,
    ).toBe(401)
    const revealed = await h.json<string>('user-a', 'POST', '/search/reveal', {
      ...input,
      keyId: first.id,
      currentPassword: 'correct-password',
    })
    expect(revealed.body).toBe('replacement-key')
    const other = await h.json<SearchSettingsDto>(
      'user-b',
      'GET',
      '/search/settings?capability=search',
    )
    expect(other.body.providers.find((p) => p.id === 'tavily')!.keys).toEqual(
      [],
    )
    const deleted = await h.json<SearchSettingsDto>(
      'user-a',
      'DELETE',
      `/search/keys/${first.id}`,
      input,
    )
    expect(
      deleted.body.providers.find((p) => p.id === 'tavily')!.keys,
    ).toHaveLength(1)
  })

  it('persists global preferences, rejects invalid rules atomically, enforces key and preference limits', async () => {
    const h = await createHarness()
    const value = {
      ...prefs,
      maxResults: 50,
      cutoffLimit: 20000,
      blacklist: ['EXAMPLE.COM', '*://*.blocked.com/Private/*'],
      modelToolsPreferred: true,
    }
    expect(
      (await h.json('user-a', 'PUT', '/search/preferences', value)).status,
    ).toBe(200)
    await h.json('user-a', 'PUT', '/search/default', {
      capability: 'search',
      provider: 'exa-mcp',
    })
    const fetched = await h.json<SearchSettingsDto>(
      'user-a',
      'GET',
      '/search/settings?capability=fetch',
    )
    expect(fetched.body.preferences).toEqual({
      ...value,
      blacklist: ['example.com', '*://*.blocked.com/Private/*'],
    })
    expect(
      (
        await h.json<SearchSettingsDto>(
          'user-b',
          'GET',
          '/search/settings?capability=search',
        )
      ).body.preferences,
    ).toEqual(prefs)
    for (const invalid of [
      { maxResults: 0 },
      { maxResults: '5' },
      { cutoffLimit: 99 },
      { cutoffLimit: 20001 },
      { compression: 'summary' },
      { blacklist: ['https://user@host/path'] },
      { blacklist: ['[evil]'] },
      { blacklist: ['a'.repeat(257)] },
      { blacklist: Array(33).fill('example.com') },
    ]) {
      expect(
        (
          await h.json('user-a', 'PUT', '/search/preferences', {
            ...value,
            ...invalid,
          })
        ).status,
      ).toBe(400)
    }
    expect(
      (
        await h.json<SearchSettingsDto>(
          'user-a',
          'GET',
          '/search/settings?capability=search',
        )
      ).body.preferences.maxResults,
    ).toBe(50)
    expect(
      (
        await h.json('user-a', 'PUT', '/search/keys', {
          capability: 'search',
          provider: 'exa',
          value: '😀'.repeat(2048),
        })
      ).status,
    ).toBe(200)
    expect(
      (
        await h.json('user-a', 'PUT', '/search/keys', {
          capability: 'search',
          provider: 'exa',
          value: '😀'.repeat(2049),
        })
      ).status,
    ).toBe(400)
    for (let i = 0; i < 16; i++)
      expect(
        (
          await h.json('user-a', 'PUT', '/search/keys', {
            capability: 'search',
            provider: 'tavily',
            value: `key-${i}`,
          })
        ).status,
      ).toBe(200)
    expect(
      (
        await h.json('user-a', 'PUT', '/search/keys', {
          capability: 'search',
          provider: 'tavily',
          value: 'seventeenth',
        })
      ).status,
    ).toBe(400)
    expect(
      (
        await h.json('user-a', 'PUT', '/search/keys', {
          capability: 'search',
          provider: 'exa',
          value: 'x'.repeat(4097),
        })
      ).status,
    ).toBe(400)
  })

  it('rotates once per execution, retries only explicit auth/rate statuses, and filters before Unicode cutoff', async () => {
    const h = await createHarness()
    await h.json('user-a', 'PUT', '/search/default', {
      capability: 'search',
      provider: 'tavily',
    })
    for (const value of ['first-key', 'second-key'])
      await h.json('user-a', 'PUT', '/search/keys', {
        capability: 'search',
        provider: 'tavily',
        value,
      })
    const snippet = '😀'.repeat(1100)
    const result = {
      results: [
        null,
        {
          title: 'blocked',
          url: 'https://sub.example.com/a',
          content: 'hidden',
        },
        {
          title: 'path',
          url: 'https://a.blocked.com/Private/a',
          content: 'hidden',
        },
        {
          title: 'keep',
          url: 'https://a.blocked.com/private/a',
          content: snippet,
        },
        {
          title: 'dup',
          url: 'https://a.blocked.com/private/a',
          content: 'dup',
        },
      ],
    }
    await h.json('user-a', 'PUT', '/search/preferences', {
      ...prefs,
      compression: 'cutoff',
      cutoffLimit: 100,
      blacklist: ['example.com', '*://*.blocked.com/Private/*'],
    })
    const calls: string[] = []
    const mock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      calls.push(new Headers(init?.headers).get('authorization')!)
      return calls.length === 1
        ? new Response('', { status: 401 })
        : Response.json(result)
    })
    vi.stubGlobal('fetch', mock)
    const response = await h.json<{
      hits: { title: string; snippet: string }[]
    }>('user-a', 'POST', '/search/query', {
      query: 'question',
    })
    expect(response.status).toBe(200)
    expect(calls).toEqual(['Bearer first-key', 'Bearer second-key'])
    expect(response.body.hits).toEqual([
      {
        title: 'keep',
        url: 'https://a.blocked.com/private/a',
        snippet: '😀'.repeat(100),
      },
    ])
    await h.json('user-a', 'PUT', '/search/preferences', {
      ...prefs,
      blacklist: ['example.com', '*://*.blocked.com/Private/*'],
    })
    const none = await h.json<{ hits: { snippet: string }[] }>(
      'user-a',
      'POST',
      '/search/query',
      { query: 'question' },
    )
    expect(calls.at(-1)).toBe('Bearer second-key')
    expect(none.body.hits[0]!.snippet).toBe(snippet)
    for (const status of [403, 429, 401]) {
      mock.mockReset().mockResolvedValue(new Response('', { status }))
      expect(
        (
          await h.json('user-a', 'POST', '/search/check', {
            capability: 'search',
            provider: 'tavily',
          })
        ).status,
      ).not.toBe(200)
      expect(mock).toHaveBeenCalledTimes(2)
    }
    mock.mockReset().mockResolvedValue(new Response('', { status: 503 }))
    expect(
      (await h.json('user-a', 'POST', '/search/query', { query: 'question' }))
        .status,
    ).toBe(502)
    expect(mock).toHaveBeenCalledTimes(1)
    mock.mockReset().mockRejectedValue(new TypeError('network failed'))
    await h.json('user-a', 'POST', '/search/query', { query: 'question' })
    expect(mock).toHaveBeenCalledTimes(1)
    mock.mockReset()
    const cancel = new AbortController()
    cancel.abort()
    await h.call(
      'user-a',
      'POST',
      '/search/query',
      { query: 'question' },
      cancel.signal,
    )
    expect(mock).not.toHaveBeenCalled()
  })

  it('preserves complete fetch content beyond 24k with compression none', async () => {
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
  })

  it('uses the same key retry executor for fetch and blocks blacklisted URLs before networking', async () => {
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
    mock
      .mockReset()
      .mockResolvedValue(
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
    mock
      .mockReset()
      .mockResolvedValue(
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
  })
})
