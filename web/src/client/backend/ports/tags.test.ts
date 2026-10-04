import { expect, it } from 'vitest'
import { HttpTagsPort } from './tags'

it('normalizes a count-only rename for consumers while preserving the worker rewrite count', async () => {
  const port = new HttpTagsPort({
    transport: { json: async () => ({ ok: true, renamed: 3 }) } as never,
  })
  await expect(port.patch('tag-id', { name: 'renamed' })).resolves.toEqual({ tag: null, renamed: 3 })
})
