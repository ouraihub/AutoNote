import { expect, test } from 'vitest'
import { filesPort } from './ports/files'
import { ipcError } from './errors'
import { isSyncResponse } from './validation'
import type { IpcTransport } from './transport'
import fixture from '../../../fixtures/ipc-contract.json'
import { validateResponse } from './validation'

test('attachment rewriting accepts only complete logical IDs and streams slices', async () => {
  const calls: string[] = []
  const transport = {
    resolveFileUrl: (id: string) => `resolved:${id}`,
    async invoke(command: string) {
      calls.push(command)
      if (command === 'files_upload_begin') return { uploadId: 'one', chunkMaxBytes: 2 }
      return { id: 'saved' }
    },
    async uploadChunk(_id: string, offset: number, bytes: ArrayBuffer) {
      calls.push(`chunk:${offset}:${bytes.byteLength}`)
      return { received: offset + bytes.byteLength }
    },
  } as unknown as IpcTransport
  const files = filesPort(transport)
  const id = '01arz3ndektsv4rrffq69g5fav'
  expect(files.resolveUrl(`/api/files/${id}`)).toBe(`resolved:${id}`)
  for (const url of [
    `/api/files/${id.toUpperCase()}`,
    `/api/files/${id}?secret=1`,
    `/api/files/${id}/../other`,
    'https://example.com/image.png',
    'autonote-file:stage',
  ])
    expect(files.resolveUrl(url)).toBe(url)
  await files.upload(new File(['abcde'], 'image.png'))
  expect(calls).toEqual(['files_upload_begin', 'chunk:0:2', 'chunk:2:2', 'chunk:4:1', 'files_upload_finish'])
})
test('IPC errors discard native diagnostics and invalid notifications are rejected', () => {
  expect(ipcError({ code: 'internal', message: 'SQL password C:/private' }).message).not.toContain('private')
  expect(ipcError('C:/private').code).toBe('internal')
  expect(isSyncResponse({ cursor: 1 })).toBe(false)
})

test('committed fixture summaries validate and malformed success envelopes fail safely', () => {
  expect(isSyncResponse(fixture.syncResponse.snapshot)).toBe(true)
  expect(isSyncResponse(fixture.syncResponse.incremental)).toBe(true)
  expect(
    isSyncResponse({ ...fixture.syncResponse.snapshot, notes: [{ id: fixture.note.id, title: 'incomplete', rev: 1 }] }),
  ).toBe(false)
  expect(() => validateResponse('notes_list', { notes: [{}], total: 1, nextCursor: null })).toThrow()
  expect(() => validateResponse('files_upload_finish', { id: fixture.upload.finish.id })).toThrow()
  const key = { id: fixture.note.id, name: 'cli', scopes: ['notes:read'], createdAt: 1, lastUsedAt: null }
  expect(() => validateResponse('mcp_list_keys', [key])).not.toThrow()
  expect(() => validateResponse('mcp_list_keys', [])).not.toThrow()
  expect(() => validateResponse('mcp_list_keys', [{ ...key, scopes: 'notes:read' }])).toThrow()
  expect(() =>
    validateResponse('mcp_status', { running: false, endpoint: null, port: 7714, error: null }),
  ).not.toThrow()
  for (const [code, status] of [
    ['payload_too_large', 413],
    ['too_many_attempts', 429],
    ['storage_unavailable', 503],
  ] as const)
    expect(ipcError({ code, message: 'secret' }).status).toBe(status)
})
