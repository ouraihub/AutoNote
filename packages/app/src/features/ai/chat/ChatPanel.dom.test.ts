import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, expect, test, vi } from 'vitest'
import type { Backend } from '@app/backend'
import { createFakePorts, KitClientError, type RunClient } from '@ouraihub/aether-ui/ports'
import ChatPanelHarness from './ChatPanelHarness.svelte'
import { EN_US_MESSAGES } from '@shared/locales/en-US'

const model = { endpointId: 'endpoint', modelId: 'model' }
afterEach(cleanup)

function mount(kind: Backend['kind'], confirm = vi.fn(async () => true), rejected = false) {
  const kit = createFakePorts({
    omit: kind === 'desktop' ? ['mcpClient', 'mcpServer'] : ['skills', 'mcpClient', 'mcpServer'],
    providers: { modelOptions: async () => [{ ...model, label: 'Model', name: null, modelType: 'chat', supportsTools: true, reasoning: null, nativeWebSearch: false, canVision: false }] },
  })
  const original = kit.chat!.start
  const run = vi.fn<RunClient['start']>(rejected
    ? async () => { throw new KitClientError({ code: 'network', message: 'Offline' }) }
    : original)
  kit.chat!.start = run
  const prefs = { load: vi.fn(async () => null), save: vi.fn(async () => {}), remove: vi.fn(async () => {}) }
  const backend = { kind, aiHost: { kit, roles: async () => [{ role: 'chat', binding: { ...model, label: 'Model' }, isFallback: false }] } } as unknown as Backend
  render(ChatPanelHarness, { backend, prefs, notify: { toast: vi.fn(), confirm } })
  return { run, prefs, confirm }
}

async function send(text: string) {
  await fireEvent.input(await screen.findByRole('textbox', { name: 'Message' }), { target: { value: text } })
  const button = screen.getByRole('button', { name: 'Send' })
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false))
  await fireEvent.click(button)
}

async function choose(label: string) {
  await fireEvent.click(await screen.findByRole('button', { name: /^Permission mode:/ }))
  await fireEvent.click(await screen.findByRole('menuitem', { name: new RegExp(`^${label}`) }))
}

test('desktop exposes five modes and sends Plan with a planning badge', async () => {
  const { run } = mount('desktop')
  expect(await screen.findByText(EN_US_MESSAGES['ai.skills_runner_warning'])).toBeTruthy()
  await fireEvent.click(await screen.findByRole('button', { name: /^Permission mode:/ }))
  for (const label of ['Ask each time', 'Plan only', 'Accept edits', 'Smart approval', 'Full access']) {
    expect(screen.getByRole('menuitem', { name: new RegExp(`^${label}`) })).toBeTruthy()
  }
  await fireEvent.click(screen.getByRole('menuitem', { name: /^Plan only/ }))
  expect(screen.getByRole('status').textContent).toContain('Plan only')
  await send('Make a plan')
  await waitFor(() => expect(run).toHaveBeenCalledTimes(1))
  expect(run.mock.calls[0]![0].permissionMode).toBe('plan')
})

test('FullAccess requires danger confirmation and is not reused by regenerate or a later message', async () => {
  const { run, confirm, prefs } = mount('desktop')
  await choose('Full access')
  await waitFor(() => expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ danger: true })))
  await send('Do this once')
  await waitFor(() => expect(run).toHaveBeenCalledTimes(1))
  expect(run.mock.calls[0]![0].permissionMode).toBe('full_access')
  const regenerate = await screen.findByRole('button', { name: 'Regenerate' })
  await waitFor(() => expect((regenerate as HTMLButtonElement).disabled).toBe(false))
  await fireEvent.click(regenerate)
  await waitFor(() => expect(run).toHaveBeenCalledTimes(2))
  expect(run.mock.calls[1]![0].permissionMode).toBe('default')
  await send('Continue normally')
  await waitFor(() => expect(run).toHaveBeenCalledTimes(3))
  expect(run.mock.calls[2]![0].permissionMode).toBe('default')
  expect(prefs.save.mock.calls.some((call) => (call as unknown[]).includes('full_access'))).toBe(false)
  expect(prefs.load.mock.calls.some((call) => /permission/i.test(String((call as unknown[])[0])))).toBe(false)
})

test('declining FullAccess keeps Default and never elevates the run', async () => {
  const { run } = mount('desktop', vi.fn(async () => false))
  await choose('Full access')
  await send('Still ask')
  await waitFor(() => expect(run).toHaveBeenCalledTimes(1))
  expect(run.mock.calls[0]![0].permissionMode).toBe('default')
})

test('a failed FullAccess attempt cannot carry elevation into retry', async () => {
  const { run } = mount('desktop', undefined, true)
  await choose('Full access')
  await send('Attempt once')
  await fireEvent.click(await screen.findByRole('button', { name: 'Retry' }))
  await waitFor(() => expect(run).toHaveBeenCalledTimes(2))
  expect(run.mock.calls.map(([request]) => request.permissionMode)).toEqual(['full_access', 'default'])
})

test('web exposes no unsupported modes and explicitly sends Default', async () => {
  const { run } = mount('web')
  await screen.findByRole('textbox', { name: 'Message' })
  expect(screen.queryByText(EN_US_MESSAGES['ai.skills_runner_warning'])).toBeNull()
  expect(screen.queryByRole('button', { name: /^Permission mode:/ })).toBeNull()
  await send('Hello')
  await waitFor(() => expect(run).toHaveBeenCalledTimes(1))
  expect(run.mock.calls[0]![0].permissionMode).toBe('default')
})

test('shared composer keeps a multiline draft and selection when expanded and collapsed', async () => {
  const { run } = mount('web')
  const input = await screen.findByRole<HTMLTextAreaElement>('textbox', { name: 'Message' })
  expect(screen.getByRole('region', { name: 'Messages' })).toBeTruthy()
  const draft = 'Shared composer\n保留草稿'
  await fireEvent.input(input, { target: { value: draft } })
  input.focus()
  input.setSelectionRange(2, 8)
  await fireEvent.click(screen.getByRole('button', { name: 'Expand input' }))
  expect(input.value).toBe(draft)
  expect([input.selectionStart, input.selectionEnd]).toEqual([2, 8])
  await fireEvent.click(screen.getByRole('button', { name: 'Collapse input' }))
  expect(screen.getByRole('textbox', { name: 'Message' })).toBe(input)
  expect(input.value).toBe(draft)
  expect([input.selectionStart, input.selectionEnd]).toEqual([2, 8])
  expect(run).not.toHaveBeenCalled()
})
