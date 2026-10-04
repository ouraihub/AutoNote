import { expect, it, vi } from 'vitest'
import { LIMITS } from '@shared/constants'
import { HttpFilesPort } from './files'

it('rejects oversized uploads before transport', async () => {
  const json = vi.fn()
  const port = new HttpFilesPort({ transport: { json } as never })
  await expect(
    port.upload(new File([new Uint8Array(LIMITS.attachmentMaxBytes + 1)], 'large.bin')),
  ).rejects.toMatchObject({
    code: 'payload_too_large',
    status: 413,
  })
  expect(json).not.toHaveBeenCalled()
})

it('preserves attachment page cursor', async () => {
  const json = vi.fn().mockResolvedValue({ files: [], nextCursor: 'next' })
  const port = new HttpFilesPort({ transport: { json } as never })
  await expect(port.list('current')).resolves.toEqual({ files: [], nextCursor: 'next' })
  expect(json).toHaveBeenCalledWith(expect.objectContaining({ query: { cursor: 'current' } }))
})
