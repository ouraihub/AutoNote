// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest'
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks'
import { aiHostPort } from './ai-host'

const host = () => aiHostPort({ invoke: vi.fn() })
afterEach(() => clearMocks())

test('desktop conversation errors retain their domain code instead of becoming internal errors', async () => {
  mockIPC(() => {
    throw { code: 'not_found', message: 'conversation not found' }
  })
  await expect(host().kit.conversations!.get('removed')).rejects.toMatchObject({
    code: 'not_found',
    message: 'conversation not found',
  })
})

test('cancelled skill acquisition and authoring never reach the desktop runtime', async () => {
  const invoke = vi.fn(() => {
    throw new Error('cancelled operation reached IPC')
  })
  mockIPC(invoke)
  const sources = host().kit.skillSources!
  const signal = AbortSignal.abort()
  await expect(sources.search('invoice', { signal })).rejects.toMatchObject({
    code: 'cancelled',
  })
  await expect(sources.authoring!.create({ signal })).rejects.toMatchObject({
    code: 'cancelled',
  })
  expect(invoke).not.toHaveBeenCalled()
})

test('desktop provider, skills, MCP and log failures preserve permission denial', async () => {
  mockIPC(() => {
    throw { code: 'unauthorized', message: 'permission denied' }
  })
  const kit = host().kit
  for (const operation of [
    () => kit.providers!.list(),
    () => kit.skills!.list(),
    () => kit.mcpClient!.list(),
    () => kit.desktop!.openLogsDirectory(),
    () => kit.chat!.getSnapshot('private-run'),
  ])
    await expect(operation()).rejects.toMatchObject({ code: 'unauthorized' })
})

test('desktop images decode locally and reject remote URLs without fetching', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch')
  try {
    const port = host()
    const image = await port.readImage!('data:image/png;base64,AQID')
    expect(image.type).toBe('image/png')
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3]),
    )
    await expect(
      port.readImage!('https://private.example/image'),
    ).rejects.toMatchObject({ code: 'bad_request' })
    expect(fetch).not.toHaveBeenCalled()
  } finally {
    fetch.mockRestore()
  }
})
