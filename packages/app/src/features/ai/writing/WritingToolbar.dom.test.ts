import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, expect, test, vi } from 'vitest'
import type { Backend } from '@app/backend'
import type { I18nState } from '@app/i18n/runtime.svelte'
import type { RunClient } from '@ouraihub/aether-ui/ports'
import { EN_US_MESSAGES } from '@shared/locales/en-US'
import WritingToolbarHarness from './WritingToolbarHarness.svelte'

afterEach(cleanup)

test('writing always requests Default with no skills or MCP tools enabled by the request', async () => {
  const run = vi.fn<RunClient['start']>(async (_request, onEvent) => {
    queueMicrotask(() => onEvent({ kind: 'end', status: 'completed' }))
    return { runId: 'writing-run', conversationId: null, turnId: null }
  })
  const backend = {
    kind: 'desktop',
    aiHost: { kit: { chat: { start: run }, skills: {}, mcpClient: {} }, roles: async () => [] },
  } as unknown as Backend
  const i18n = { locale: 'en-US', t: (key: keyof typeof EN_US_MESSAGES) => EN_US_MESSAGES[key] } as I18nState
  render(WritingToolbarHarness, { backend, i18n })
  await fireEvent.click(await screen.findByRole('button', { name: EN_US_MESSAGES['writing.polish'] }))
  await waitFor(() => expect(run).toHaveBeenCalledTimes(1))
  const request = run.mock.calls[0]![0]
  expect(request).toMatchObject({ purpose: 'writing', permissionMode: 'default', skills: [], regenerate: false })
  expect(request.webSearch).toBeUndefined()
  expect(request.generateImage).toBeUndefined()
})
