// @vitest-environment jsdom
import { fireEvent as dom, screen, waitFor } from '@testing-library/dom'
import { flushSync, mount as mountComponent, unmount } from 'svelte'
import { afterEach, expect, test, vi } from 'vitest'
import { EN_US_MESSAGES } from '@shared/locales/en-US'
import type { Backend } from '@app/backend'
import type { I18nState } from '@app/i18n/runtime.svelte'
import type { Notifier } from '@app/platform/notifier'
import type { AiPort, AiProbeResult, AiProvider, AiProviderSave, AiRoleBinding } from '../../ipc/ports/ai'
import AiSectionHarness from './AiSectionHarness.svelte'

// Desktop vitest has no Svelte testing plugin, so mount directly and flush after each event.
const fire =
  (type: 'click' | 'input' | 'change') =>
  (element: Element, init?: object): void => {
    dom[type](element, init)
    flushSync()
  }
const fireEvent = { click: fire('click'), input: fire('input'), change: fire('change') }
let mounted: Record<string, unknown> | undefined
// Save shows aria-busy while any section action (including the follow-up roles reload) runs.
const idle = () =>
  waitFor(() => expect(screen.getByRole('button', { name: 'Save' }).getAttribute('aria-busy')).toBeNull())

const i18n = {
  locale: 'en-US',
  t: (key: keyof typeof EN_US_MESSAGES, params?: Record<string, string | number>) =>
    EN_US_MESSAGES[key].replace(/\{(\w+)\}/g, (whole, name: string) => String(params?.[name] ?? whole)),
} as I18nState
const notifier = { confirm: vi.fn(async () => true), toast: vi.fn() } as Notifier

const saved: AiProvider = {
  id: 'p1',
  name: 'Relay',
  endpoints: [
    {
      id: 'e1',
      slug: 'openai',
      baseUrl: 'https://relay.example/v1',
      protocol: 'openai-chat',
      keyMasked: 'sk-a…wxyz',
      probeUrl: 'https://relay.example/v1/models',
      models: [{ id: 'gpt-4o', modelType: 'chat', typeSource: 'inferred', contextWindow: 400000, canVision: true }],
    },
  ],
}

function fakePort(providers: AiProvider[], roles: AiRoleBinding[] = []) {
  const toProvider = (input: AiProviderSave): AiProvider => ({
    id: input.id ?? 'p-new',
    name: input.name,
    endpoints: input.endpoints.map((endpoint, index) => ({
      id: endpoint.id ?? `e-new-${index}`,
      slug: endpoint.slug,
      baseUrl: endpoint.baseUrl,
      protocol: endpoint.protocol,
      keyMasked:
        endpoint.apiKey === undefined
          ? (providers.flatMap((item) => item.endpoints).find((item) => item.id === endpoint.id)?.keyMasked ?? null)
          : endpoint.apiKey
            ? 'sk-…'
            : null,
      probeUrl: `${endpoint.baseUrl}/models`,
      models: endpoint.models,
    })),
  })
  return {
    listProviders: vi.fn(async () => providers),
    saveProvider: vi.fn(async (input: AiProviderSave) => [toProvider(input)]),
    deleteProvider: vi.fn(async () => ({ ok: true as const })),
    revealKey: vi.fn(async () => 'sk-plain-secret'),
    probe: vi.fn(async (): Promise<AiProbeResult> => ({
      probeUrl: 'https://relay.example/v1/models',
      models: [
        {
          id: 'claude-x',
          modelType: 'chat' as const,
          typeSource: 'inferred' as const,
          contextWindow: 200000,
          canVision: false,
          group: 'claude',
        },
        {
          id: 'text-embed-1',
          modelType: 'embedding' as const,
          typeSource: 'inferred' as const,
          contextWindow: null,
          canVision: false,
          group: 'other',
        },
      ],
      error: null,
    })),
    roles: vi.fn(async () => roles),
    setRole: vi.fn(async () => roles),
    listConversations: vi.fn(async () => []),
    getConversation: vi.fn(async (id: string) => ({ id, title: '', messages: [] })),
    deleteConversation: vi.fn(async () => ({ ok: true as const })),
    write: vi.fn(async () => ({ model: { endpointId: 'e1', modelId: 'gpt-4o' }, isFallback: false })),
    chat: vi.fn(async () => ({ conversationId: 'c1' })),
  } satisfies AiPort
}
const mount = (ai: AiPort): void => {
  mounted = mountComponent(AiSectionHarness, {
    target: document.body.appendChild(document.createElement('div')),
    props: { backend: { capabilities: { ai: true }, ai } as unknown as Backend, i18n, notifier },
  })
}
afterEach(async () => {
  if (mounted) await unmount(mounted)
  mounted = undefined
  document.body.innerHTML = ''
  vi.clearAllMocks()
})
test('creates a provider; fetch models waits for save; key tri-state in payload', async () => {
  const ai = fakePort([])
  mount(ai)
  await fireEvent.click(await screen.findByRole('button', { name: 'New provider' }))
  const fetchButton = screen.getByRole('button', { name: 'Fetch models' }) as HTMLButtonElement
  expect(fetchButton.disabled).toBe(true)
  expect(fetchButton.title).toBe('Save the provider before fetching models.')
  await fireEvent.input(screen.getByLabelText('Provider name'), { target: { value: 'Claude' } })
  await fireEvent.change(screen.getByLabelText('Protocol'), { target: { value: 'anthropic-messages' } })
  expect((screen.getByLabelText('Slug') as HTMLInputElement).value).toBe('anthropic')
  await fireEvent.input(screen.getByLabelText('Base URL'), { target: { value: 'https://api.anthropic.com' } })
  await fireEvent.input(screen.getByLabelText('API key'), { target: { value: 'sk-new' } })
  await fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() =>
    expect(ai.saveProvider).toHaveBeenCalledWith({
      name: 'Claude',
      endpoints: [
        {
          slug: 'anthropic',
          baseUrl: 'https://api.anthropic.com',
          protocol: 'anthropic-messages',
          apiKey: 'sk-new',
          models: [],
        },
      ],
    }),
  )
  await waitFor(() =>
    expect((screen.getByRole('button', { name: 'Fetch models' }) as HTMLButtonElement).disabled).toBe(false),
  )
})

test('saved key is kept when untouched and cleared via Clear; reveal shows plaintext', async () => {
  const ai = fakePort([saved])
  mount(ai)
  await fireEvent.click(await screen.findByRole('button', { name: 'Save' }))
  await waitFor(() => expect(ai.saveProvider).toHaveBeenCalledTimes(1))
  expect(ai.saveProvider.mock.calls[0]?.[0].endpoints[0]).not.toHaveProperty('apiKey')
  await idle()
  await fireEvent.click(screen.getByRole('button', { name: 'Show' }))
  await screen.findByText('sk-plain-secret')
  expect(ai.revealKey).toHaveBeenCalledWith('e1')
  await fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
  expect(screen.queryByText('sk-plain-secret')).toBeNull()
  await fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(ai.saveProvider).toHaveBeenCalledTimes(2))
  expect(ai.saveProvider.mock.calls[1]?.[0].endpoints[0]?.apiKey).toBe('')
})

test('probed models are added, retyped and saved with typeSource', async () => {
  const ai = fakePort([saved])
  mount(ai)
  await fireEvent.click(await screen.findByRole('button', { name: 'Fetch models' }))
  await waitFor(() => expect(ai.probe).toHaveBeenCalledWith('e1'))
  await fireEvent.click(await screen.findByRole('button', { name: 'Add claude-x' }))
  await fireEvent.click(screen.getByRole('button', { name: 'Add text-embed-1' }))
  await fireEvent.change(screen.getByLabelText('Type of text-embed-1'), { target: { value: 'rerank' } })
  await fireEvent.click(screen.getByRole('button', { name: 'Remove gpt-4o' }))
  await fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(ai.saveProvider).toHaveBeenCalledTimes(1))
  expect(ai.saveProvider.mock.calls[0]?.[0].endpoints[0]?.models).toEqual([
    { id: 'claude-x', modelType: 'chat', typeSource: 'inferred', contextWindow: 200000, canVision: false },
    { id: 'text-embed-1', modelType: 'rerank', typeSource: 'user', contextWindow: null, canVision: false },
  ])
})

test('probe error kind is translated inline', async () => {
  const ai = fakePort([saved])
  ai.probe.mockResolvedValueOnce({
    probeUrl: '',
    models: [],
    error: { kind: 'status', status: 502, message: 'Bad gateway' },
  })
  mount(ai)
  await fireEvent.click(await screen.findByRole('button', { name: 'Fetch models' }))
  expect((await screen.findByRole('alert')).textContent).toContain('The service returned an error (502).')
})

test('chat role select calls setRole; writing shows fallback to chat', async () => {
  const ai = fakePort(
    [saved],
    [
      {
        role: 'chat',
        binding: { endpointId: 'e1', modelId: 'gpt-4o', label: 'Relay · openai · gpt-4o' },
        isFallback: false,
      },
      {
        role: 'writing',
        binding: { endpointId: 'e1', modelId: 'gpt-4o', label: 'Relay · openai · gpt-4o' },
        isFallback: true,
      },
    ],
  )
  mount(ai)
  const writing = (await screen.findByLabelText('Writing model')) as HTMLSelectElement
  expect(writing.value).toBe('')
  expect(writing.selectedOptions[0]?.textContent).toBe('Follow chat model (Relay · openai · gpt-4o)')
  const chat = screen.getByLabelText('Chat model') as HTMLSelectElement
  expect(chat.selectedOptions[0]?.textContent).toBe('Relay · openai · gpt-4o')
  await fireEvent.change(chat, { target: { value: '' } })
  await waitFor(() => expect(ai.setRole).toHaveBeenCalledWith('chat', null))
  await idle()
  await fireEvent.change(chat, { target: { value: chat.options[1]?.value } })
  await waitFor(() => expect(ai.setRole).toHaveBeenCalledWith('chat', { endpointId: 'e1', modelId: 'gpt-4o' }))
})
