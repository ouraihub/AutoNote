import { expect, it } from 'vitest'
import { parseRoute } from './router'

it('only accepts complete note/share routes and never swallows Worker routes', () => {
  expect(parseRoute('/n/01ARZ3NDEKTSV4RRFFQ69G5FAV/')).toEqual({ kind: 'app', noteId: '01arz3ndektsv4rrffq69g5fav' })
  expect(parseRoute('/s/0123456789abcdefghjk/')).toEqual({ kind: 'share', slug: '0123456789abcdefghjk' })
  for (const path of [
    '/n/01ARZ3NDEKTSV4RRFFQ69G5FAV/extra',
    '/s/arbitrary',
    '/api/notes',
    '/mcp',
    '/oauth/token',
    '/.well-known/oauth-authorization-server',
    '/__gallery',
  ])
    expect(parseRoute(path).kind).toBe('not-found')
  expect(parseRoute('/__gallery', true).kind).toBe('gallery')
})
