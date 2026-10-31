import { cleanup, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, expect, test, vi } from 'vitest'
import { createFakePorts } from '@ouraihub/aether-ui/ports'
import type { Backend } from '@app/backend'
import type { I18nState } from '@app/i18n/runtime.svelte'
import { EN_US_MESSAGES } from '@shared/locales/en-US'
import { aiHostExtensions } from '../index'
import ToolsSectionsHarness from './ToolsSectionsHarness.svelte'

const i18n = {
  locale: 'en-US',
  t: (key: keyof typeof EN_US_MESSAGES) => EN_US_MESSAGES[key],
} as I18nState
afterEach(cleanup)

test('skills and MCP client sections follow port availability, independently of the MCP server', () => {
  for (const [omit, expected] of [
    [['skills', 'mcpClient', 'mcpServer'], ['ai']],
    [
      ['mcpClient', 'mcpServer'],
      ['ai', 'skills'],
    ],
    [
      ['skills', 'mcpServer'],
      ['ai', 'mcp-client'],
    ],
    [['mcpServer'], ['ai', 'skills', 'mcp-client']],
  ] as const) {
    const backend = {
      aiHost: { kit: createFakePorts({ omit }) },
    } as unknown as Backend
    expect(
      aiHostExtensions(backend).settingsSections.map((section) => section.id),
    ).toEqual(expected)
  }
})

test('skills section mounts the shared manager and warns about user-level file and network access', async () => {
  const list = vi.fn(async () => [])
  const backend = {
    aiHost: { kit: createFakePorts({ skills: { list } }) },
  } as unknown as Backend
  render(ToolsSectionsHarness, { backend, i18n, section: 'skills' })
  expect(
    screen.getByText(EN_US_MESSAGES['ai.skills_runner_warning']),
  ).toBeTruthy()
  await waitFor(() => expect(list).toHaveBeenCalledTimes(1))
})

test('MCP client section mounts the shared manager and loads configured connections', async () => {
  const list = vi.fn(async () => [])
  const backend = {
    aiHost: { kit: createFakePorts({ mcpClient: { list } }) },
  } as unknown as Backend
  render(ToolsSectionsHarness, { backend, i18n, section: 'mcp-client' })
  await waitFor(() => expect(list).toHaveBeenCalledTimes(1))
})
