import { afterEach, expect, test, vi } from 'vitest'
import { TauriTransport, observeIpcFailures } from './transport'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invoke(...args),
  convertFileSrc: (path: string) => path,
  Channel: class {},
}))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }))

afterEach(() => {
  observeIpcFailures(undefined)
  invoke.mockReset()
})

test('rejected and malformed responses are reported once with command and code', async () => {
  const seen: string[] = []
  observeIpcFailures((command, code) => seen.push(`${command}:${code}`))
  const transport = new TauriTransport()
  invoke.mockResolvedValueOnce({ not: 'an array' })
  await expect(transport.invoke('mcp_list_keys', undefined)).rejects.toMatchObject({ code: 'invalid_response' })
  invoke.mockRejectedValueOnce({ code: 'conflict', message: 'C:/private' })
  await expect(transport.invoke('mcp_start', undefined)).rejects.toMatchObject({ code: 'conflict' })
  invoke.mockRejectedValueOnce({ code: 'internal', message: 'x' })
  await expect(transport.invoke('app_log', { entries: [], droppedCount: 0 })).rejects.toBeTruthy()
  expect(seen).toEqual(['mcp_list_keys:invalid_response', 'mcp_start:conflict'])
})
