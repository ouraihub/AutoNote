import { describe, expect, it } from 'vitest'
import { SharePageState } from './share-page.svelte'
import { addShareAccess } from './share-access'

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}
const note = (slug: string) => ({
  title: 'public',
  content: 'public text',
  createdAt: 1,
  updatedAt: 2,
  author: { name: 'author', avatarUrl: '' },
  site: { name: 'site' },
  share: { slug },
})

describe('public share isolation', () => {
  it('ignores an old request even if its transport ignores abort', async () => {
    let finish: ((value: Response) => void) | undefined
    const first = new Promise<Response>((resolve) => {
      finish = resolve
    })
    const paths: string[] = []
    const state = new SharePageState({
      origin: 'https://site.test',
      logger,
      clientId: 'test',
      getLocale: () => 'en-US',
      fetch: async (request) => {
        paths.push(new URL(request.url).pathname)
        return paths.length === 1 ? first : Response.json(note('new'))
      },
    })
    const old = state.load('old', 'secret')
    await state.load('new')
    finish?.(Response.json(note('old')))
    await old
    expect(state.note?.share.slug).toBe('new')
    expect(paths).toEqual(['/api/public/old', '/api/public/new'])
    state.dispose()
    expect(state.note).toBeNull()
  })
  it('keeps password errors and throttling separate from login identity', async () => {
    let status = 401
    const state = new SharePageState({
      origin: 'https://site.test',
      logger,
      clientId: 'test',
      getLocale: () => 'en-US',
      fetch: async () =>
        Response.json(
          {
            error: {
              code: status === 401 ? 'password_invalid' : 'too_many_attempts',
              details: { retryAfter: 37 },
            },
          },
          { status },
        ),
    })
    await state.load('locked', 'wrong')
    expect(state.status).toBe('passwordRequired')
    expect(state.errorKey).toBe('share.incorrect_passcode')
    status = 429
    await state.load('locked', 'wrong')
    expect(state.status).toBe('failed')
    expect(state.retryAfter).toBe(37)
    expect(state.note).toBeNull()
  })
  it('only grants exact same-origin attachment paths', () => {
    const id = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
    expect(
      addShareAccess(
        `/api/files/${id}?download=1`,
        'public',
        'https://site.test',
      ),
    ).toBe(`/api/files/${id}?download=1&share=public`)
    expect(
      addShareAccess(
        `https://other.test/api/files/${id}`,
        'public',
        'https://site.test',
      ),
    ).toBe(`https://other.test/api/files/${id}`)
    expect(
      addShareAccess('/api/files/private/path', 'public', 'https://site.test'),
    ).toBe('data:,')
    expect(
      addShareAccess('/api/notes/private', 'public', 'https://site.test'),
    ).toBe('data:,')
  })
})
