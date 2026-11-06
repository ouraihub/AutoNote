import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/svelte'
import { afterEach, expect, test, vi } from 'vitest'
import type { AiHostPort, Backend } from '@app/backend'
import type { PrefsStore } from '@app/platform/prefs'
import {
  createFakePorts,
  KitClientError,
  type ModelOption,
  type RunClient,
} from '@ouraihub/aether-ui/ports'
import ChatPanelHarness from './ChatPanelHarness.svelte'
import { EN_US_MESSAGES } from '@shared/locales/en-US'

const model = { endpointId: 'endpoint', modelId: 'model' }
const otherModel = { ...model, modelId: 'other-model' }
const effortKey = 'ai.chat.reasoningEffort'
afterEach(cleanup)

function mount(
  kind: Backend['kind'],
  confirm = vi.fn(async () => true),
  rejected = false,
  effort: string | null = null,
  failEffortSave = false,
) {
  const kit = createFakePorts({
    omit:
      kind === 'desktop'
        ? ['mcpClient', 'mcpServer']
        : ['skills', 'mcpClient', 'mcpServer'],
    providers: {
      modelOptions: async (): Promise<ModelOption[]> =>
        [model, otherModel].map((ref) => ({
          ...ref,
          label: ref.modelId,
          name: null,
          modelType: 'chat',
          supportsTools: true,
          reasoning: { dialect: 'openai', efforts: ['low', 'high'] },
          nativeWebSearch: false,
          canVision: false,
        })),
    },
  })
  const original = kit.chat!.start
  const run = vi.fn<RunClient['start']>(
    rejected
      ? async () => {
          throw new KitClientError({ code: 'network', message: 'Offline' })
        }
      : original,
  )
  kit.chat!.start = run
  const values = new Map<string, unknown>([[effortKey, effort]])
  const prefs = {
    load: vi.fn<PrefsStore['load']>(async (key) => values.get(key) ?? null),
    save: vi.fn<PrefsStore['save']>(async (key, value) => {
      if (failEffortSave && key === effortKey) throw new Error('offline')
      values.set(key, value)
    }),
    remove: vi.fn<PrefsStore['remove']>(async (key) => {
      if (failEffortSave && key === effortKey) throw new Error('offline')
      values.delete(key)
    }),
  }
  let roleModel = model
  const roles: AiHostPort['roles'] = async () => [
    {
      role: 'chat',
      binding: { ...roleModel, label: roleModel.modelId },
      isFallback: false,
    },
  ]
  const setRole = vi.fn<AiHostPort['setRole']>(async (_role, ref) => {
    if (ref) roleModel = ref
    return roles()
  })
  const backend = {
    kind,
    aiHost: {
      kit,
      roles,
      setRole,
    },
  } as unknown as Backend
  const view = render(ChatPanelHarness, {
    backend,
    prefs,
    notify: { toast: vi.fn(), confirm },
  })
  return { run, prefs, confirm, setRole, view }
}

async function send(text: string) {
  await fireEvent.input(
    await screen.findByRole('textbox', { name: 'Message' }),
    { target: { value: text } },
  )
  const button = screen.getByRole('button', { name: 'Send' })
  await waitFor(() =>
    expect((button as HTMLButtonElement).disabled).toBe(false),
  )
  await fireEvent.click(button)
}

test.each(['desktop', 'web'] as const)(
  '%s chat shows no permission or skills controls and sends Default',
  async (kind) => {
    const { run } = mount(kind)
    await screen.findByRole('textbox', { name: 'Message' })
    expect(
      screen.queryByRole('button', { name: /^Permission mode:/ }),
    ).toBeNull()
    expect(screen.queryByLabelText('Skills for this message')).toBeNull()
    expect(
      screen.queryByText(EN_US_MESSAGES['ai.skills_runner_warning']),
    ).toBeNull()
    await send('Hello')
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1))
    expect(run.mock.calls[0]![0]).toMatchObject({
      permissionMode: 'default',
      skills: [],
    })
  },
)

test('failed explicit default effort save remains retryable', async () => {
  const { prefs, setRole } = mount(
    'web',
    vi.fn(async () => true),
    false,
    null,
    true,
  )
  await screen.findByRole('textbox', { name: 'Message' })
  await fireEvent.click(
    await screen.findByRole('button', { name: /Model and reasoning/ }),
  )
  await fireEvent.input(
    await screen.findByLabelText('Search models, optionally with a level'),
    { target: { value: 'other-model' } },
  )
  await fireEvent.click(
    await screen.findByRole('option', { name: /^Select other-model/ }),
  )
  await fireEvent.click(
    await screen.findByRole('button', { name: 'Set as default' }),
  )
  expect(await screen.findByRole('status')).toBeTruthy()
  expect(setRole).toHaveBeenCalledWith('chat', otherModel)
  expect(prefs.remove).toHaveBeenCalledWith(effortKey)
})
