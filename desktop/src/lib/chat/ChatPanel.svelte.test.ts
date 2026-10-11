// @vitest-environment jsdom
import { fireEvent as dom, screen, waitFor } from '@testing-library/dom'
import { flushSync, mount as mountComponent, unmount } from 'svelte'
import { afterEach, expect, test, vi, type Mock } from 'vitest'
import { EN_US_MESSAGES } from '@shared/locales/en-US'
import type { Backend } from '@app/backend'
import type { I18nState } from '@app/i18n/runtime.svelte'
import type { Notifier } from '@app/platform/notifier'
import type { PrefsStore } from '@app/platform/prefs'
import type { UiState } from '@app/state/ui.svelte'
import type { AiChatEvent, AiChatRequest, AiConversation, AiPort } from '../ipc/ports/ai'
import ChatPanelHarness from './ChatPanelHarness.svelte'

// Desktop vitest has no Svelte testing plugin: fire, then flush synchronously.
const fire =
  (type: 'click' | 'input' | 'keyDown') =>
  (element: Element, init?: object): void => {
    dom[type](element, init)
    flushSync()
  }
const fireEvent = { click: fire('click'), input: fire('input'), keyDown: fire('keyDown') }
const i18n = {
  locale: 'en-US',
  t: (key: keyof typeof EN_US_MESSAGES, params?: Record<string, string | number>) =>
    EN_US_MESSAGES[key].replace(/\{(\w+)\}/g, (whole, name: string) => String(params?.[name] ?? whole)),
} as I18nState
let mounted: Record<string, unknown> | undefined
afterEach(async () => {
  if (mounted) await unmount(mounted)
  mounted = undefined
  document.body.innerHTML = ''
})

type Chat = (
  request: AiChatRequest,
  onEvent: (event: AiChatEvent) => void,
  options?: { signal?: AbortSignal },
) => Promise<{ conversationId: string }>
type FakeAi = AiPort & { chat: Mock<Chat> }
interface PanelOverrides {
  note?: { id: string; title: string; content: string } | null
  insert?: (text: string) => void
  openSettings?: (id: string) => void
  prefs?: PrefsStore
  ui?: { panel: string | null }
}

const chatModel = {
  id: 'gpt-5',
  modelType: 'chat',
  typeSource: 'inferred',
  contextWindow: null,
  canVision: false,
} as const
function fakeAi(chat: Chat, stored: AiConversation[] = [], withModels = true): FakeAi {
  const endpoint = {
    id: 'e',
    slug: 'openai',
    baseUrl: '',
    protocol: 'openai-chat',
    keyMasked: 'x',
    probeUrl: '',
    models: [chatModel],
  } as const
  return {
    listProviders: vi.fn(async () => (withModels ? [{ id: 'p', name: 'Relay', endpoints: [endpoint] }] : [])),
    saveProvider: vi.fn(),
    deleteProvider: vi.fn(),
    revealKey: vi.fn(),
    probe: vi.fn(),
    roles: vi.fn(async () => [
      {
        role: 'chat',
        binding: { endpointId: 'e', modelId: 'gpt-5', label: 'Relay · openai · gpt-5' },
        isFallback: false,
      },
    ]),
    setRole: vi.fn(),
    listConversations: vi.fn(async () => stored.map(({ id, title }) => ({ id, title, updatedAt: 1 }))),
    getConversation: vi.fn(async (id: string) => stored.find((item) => item.id === id)!),
    deleteConversation: vi.fn(async () => ({ ok: true as const })),
    chat: vi.fn(chat),
  } as unknown as FakeAi
}
function memoryPrefs(): PrefsStore {
  const values: Record<string, unknown> = {}
  return {
    load: async (key) => values[key],
    save: async (key, value) => void (values[key] = value),
    remove: async (key) => void delete values[key],
  }
}
function mount(ai: AiPort, overrides: PanelOverrides = {}): void {
  mounted = mountComponent(ChatPanelHarness, {
    target: document.body.appendChild(document.createElement('div')),
    props: {
      backend: { capabilities: { ai: true }, ai } as unknown as Backend,
      ...(overrides.ui ? { ui: overrides.ui as UiState } : {}),
      i18n,
      notifier: { confirm: vi.fn(async () => true), toast: vi.fn() } as Notifier,
      prefs: overrides.prefs ?? memoryPrefs(),
      note: overrides.note === undefined ? { id: 'n1', title: 'Plan', content: '# Plan\nship it' } : overrides.note,
      insert: overrides.insert ?? vi.fn(),
      openSettings: overrides.openSettings ?? vi.fn(),
      onClose: vi.fn(),
    },
  })
}
async function send(text: string): Promise<void> {
  const composer = await screen.findByRole('textbox', { name: /Message/ })
  fireEvent.input(composer, { target: { value: text } })
  fireEvent.keyDown(composer, { key: 'Enter' })
}

test('send streams deltas, includes the note, and continues the same conversation', async () => {
  const ai = fakeAi(async (_request, onEvent) => {
    onEvent({ kind: 'delta', text: 'Hel' })
    onEvent({ kind: 'delta', text: 'lo **there**' })
    return { conversationId: 'c1' }
  })
  mount(ai)
  await send('summarize')
  await waitFor(() => expect(document.querySelector('.ink-prose strong')?.textContent).toBe('there'))
  await send('more')
  await waitFor(() => expect(ai.chat).toHaveBeenCalledTimes(2))
  expect(ai.chat.mock.calls[1]![0]).toMatchObject({ conversationId: 'c1', content: 'more' })
})

test('excluding the note chip sends without note context', async () => {
  const ai = fakeAi(async () => ({ conversationId: 'c1' }))
  mount(ai)
  fireEvent.click(await screen.findByRole('button', { name: 'Don’t include this note' }))
  await send('hi')
  await waitFor(() => expect(ai.chat).toHaveBeenCalled())
  expect(ai.chat.mock.calls[0]![0].note).toBeUndefined()
})

test('Stop aborts the stream and keeps the partial reply as stopped', async () => {
  const ai = fakeAi((_request, onEvent, options) => {
    const { promise, reject } = Promise.withResolvers<{ conversationId: string }>()
    onEvent({ kind: 'delta', text: 'partial' })
    options?.signal?.addEventListener('abort', () => reject(new Error('cancelled')))
    return promise
  })
  mount(ai)
  await send('long')
  fireEvent.click(await screen.findByRole('button', { name: 'Stop' }))
  expect(await screen.findByText('Stopped')).toBeTruthy()
  expect(screen.getByText('partial')).toBeTruthy()
})

test('regenerate is offered on the last reply only and re-asks without new content', async () => {
  const stored: AiConversation = {
    id: 'c1',
    title: 'old',
    messages: [
      { id: 'm1', role: 'user', content: 'q1', status: 'done', modelId: null, createdAt: 1 },
      { id: 'm2', role: 'assistant', content: 'a1', status: 'done', modelId: 'gpt-5', createdAt: 2 },
      { id: 'm3', role: 'user', content: 'q2', status: 'done', modelId: null, createdAt: 3 },
      { id: 'm4', role: 'assistant', content: 'a2', status: 'done', modelId: 'gpt-5', createdAt: 4 },
    ],
  }
  const prefs = memoryPrefs()
  await prefs.save('desktop.chat.last', 'c1')
  const ai = fakeAi(async () => ({ conversationId: 'c1' }), [stored])
  mount(ai, { prefs })
  await screen.findByText('a2')
  expect(screen.getAllByRole('button', { name: 'Regenerate' })).toHaveLength(1)
  fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }))
  await waitFor(() => expect(ai.chat).toHaveBeenCalled())
  expect(ai.chat.mock.calls[0]![0]).toMatchObject({ conversationId: 'c1', content: '', regenerate: true })
  expect(screen.queryByText('a2')).toBeNull()
})

test('insert hands the reply text to the host', async () => {
  const ai = fakeAi(async (_request, onEvent) => {
    onEvent({ kind: 'delta', text: 'answer' })
    return { conversationId: 'c1' }
  })
  const insert = vi.fn()
  mount(ai, { insert })
  await send('q')
  fireEvent.click(await screen.findByRole('button', { name: 'Insert into note' }))
  expect(insert).toHaveBeenCalledWith('answer')
})

test('without a chat model the panel links to model settings', async () => {
  const openSettings = vi.fn()
  mount(
    fakeAi(async () => ({ conversationId: 'x' }), [], false),
    { openSettings },
  )
  fireEvent.click(await screen.findByRole('button', { name: 'Set up model service' }))
  expect(openSettings).toHaveBeenCalledWith('desktop-ai')
})

test('a failed reply shows the upstream reason and Retry regenerates', async () => {
  const ai = fakeAi(async () => {
    throw new Error('503: No available channel')
  })
  mount(ai)
  await send('q')
  expect((await screen.findByRole('alert')).textContent).toContain('503: No available channel')
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await waitFor(() => expect(ai.chat).toHaveBeenCalledTimes(2))
  expect(ai.chat.mock.calls[1]![0]).toMatchObject({ regenerate: true })
})

test('the chat role model is the default and is picked up again after settings closes', async () => {
  const ai = fakeAi(async () => ({ conversationId: 'c1' }))
  const bound = { role: 'chat' as const, binding: { endpointId: 'e', modelId: 'gpt-5', label: 'x' }, isFallback: false }
  ai.roles = vi.fn(async () => [{ ...bound, binding: null }])
  const ui = $state({ panel: null as string | null })
  mount(ai, { ui })
  const picker = (await screen.findByRole('combobox', { name: 'Model' })) as HTMLSelectElement
  // Nothing bound yet: the first saved chat model is used explicitly instead of failing on send.
  await vi.waitFor(() => expect(picker.value).toBe(JSON.stringify(['e', 'gpt-5'])))

  ui.panel = 'settings'
  ai.roles = vi.fn(async () => [bound])
  ui.panel = null
  flushSync()
  await vi.waitFor(() => expect(picker.selectedOptions[0]?.textContent).toBe('gpt-5 (default)'))
  await send('hi')
  await waitFor(() => expect(ai.chat).toHaveBeenCalled())
  expect(ai.chat.mock.calls[0]![0].model).toBeUndefined()
})
