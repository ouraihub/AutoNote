import { expect, test, vi } from 'vitest'
import { aiHostPort } from './ai-host'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => []) }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args), Channel: class {} }))

test('desktop enables skills and MCP client using the shared Tauri ports', async () => {
  const host = aiHostPort({ invoke: vi.fn() })
  expect(host.kit.chat?.start).toBeDefined()
  expect(host.kit.conversations).toBeDefined()
  expect(host.kit.desktop?.openLogsDirectory).toBeDefined()
  await host.kit.skills!.list()
  await host.kit.mcpClient!.list()
  expect(invoke.mock.calls).toEqual([
    ['plugin:aether|skills_list', {}],
    ['plugin:aether|mcp_client_list', {}],
  ])
  expect(host.kit.mcpServer).toBeUndefined()
})
