import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, expect, test, vi } from 'vitest'
import type { Backend, AiRoleBinding } from '@app/backend'
import type { I18nState } from '@app/i18n/runtime.svelte'
import type { ModelOption, Provider, ProviderSave } from '@ouraihub/aether-ui/ports'
import type * as ProvidersModule from '@ouraihub/aether-ui/providers'
import { EN_US_MESSAGES } from '@shared/locales/en-US'
import AiSectionHarness from './AiSectionHarness.svelte'

const captured = vi.hoisted(() => ({
  usedBy: undefined as ((endpointId: string, modelId: string) => string[]) | undefined,
}))
vi.mock('@ouraihub/aether-ui/providers', async (importOriginal) => {
  const actual = await importOriginal<typeof ProvidersModule>()
  const ProvidersSettings = (...args: Parameters<typeof actual.ProvidersSettings>) => {
    captured.usedBy = args[1].usedBy
    return actual.ProvidersSettings(...args)
  }
  return { ...actual, ProvidersSettings }
})

vi.mock('./presets', () => ({ PROVIDER_PRESETS: [] }))

afterEach(cleanup)

test('usedBy lists localized roles bound to a model, including fallback writing', async () => {
  const binding = { endpointId: 'endpoint', modelId: 'm', label: 'M' }
  const roles: AiRoleBinding[] = [
    { role: 'chat', binding, isFallback: false },
    { role: 'writing', binding, isFallback: true },
    { role: 'painting', binding: { ...binding, modelId: 'img' }, isFallback: false },
  ]
  const backend = {
    aiHost: {
      roles: async () => roles,
      setRole: async () => roles,
      kit: { providers: { list: async () => [], modelOptions: async () => [] } },
    },
  } as unknown as Backend
  const i18n = { locale: 'en-US', t: (key: keyof typeof EN_US_MESSAGES) => EN_US_MESSAGES[key] } as I18nState
  render(AiSectionHarness, { props: { backend, i18n } })
  await waitFor(() =>
    expect(captured.usedBy?.('endpoint', 'm')).toEqual([
      EN_US_MESSAGES['ai.role_chat'],
      EN_US_MESSAGES['ai.role_writing'],
    ]),
  )
  expect(captured.usedBy?.('endpoint', 'img')).toEqual([EN_US_MESSAGES['ai.role_painting']])
  expect(captured.usedBy?.('other', 'm')).toEqual([])
})

test('saving a provider refreshes both role selectors and deleting it clears stale role bindings', async () => {
  let providers: Provider[] = []
  let options: ModelOption[] = []
  let roles: AiRoleBinding[] = []
  const setRole = vi.fn(async () => roles)
  const remove = vi.fn(async () => {
    providers = []
    options = []
    roles = []
    return providers
  })
  const backend = {
    aiHost: {
      roles: async () => roles,
      setRole,
      kit: {
        providers: {
          list: async () => providers,
          modelOptions: async () => options,
          save: async (input: ProviderSave) => {
            providers = [
              {
                id: 'provider',
                name: 'Saved provider',
                enabled: true,
                notes: '',
                presetId: null,
                endpoints: [
                  {
                    id: 'endpoint',
                    slug: input.endpoints[0]?.slug ?? 'main',
                    baseUrl: 'https://example.com',
                    protocol: 'openai-chat',
                    keyStrategy: 'round_robin',
                    keys: [
                      {
                        id: 'k1',
                        label: '',
                        enabled: true,
                        masked: 'test',
                        readable: true,
                        exhaustedUntil: null,
                        exhaustedReason: null,
                      },
                    ],
                    probeUrl: 'https://example.com/v1/models',
                    imageBaseUrl: null,
                    imageEditBaseUrl: null,
                    headers: {},
                    models: [],
                  },
                ],
              },
            ]
            options = [
              {
                endpointId: 'endpoint',
                modelId: 'saved-model',
                label: 'Saved model',
                name: null,
                modelType: 'chat',
                supportsTools: null,
                reasoning: null,
                nativeWebSearch: false,
                canVision: false,
              },
            ]
            roles = [
              {
                role: 'chat',
                binding: { endpointId: 'endpoint', modelId: 'saved-model', label: 'Saved model' },
                isFallback: false,
              },
            ]
            return providers
          },
          remove,
        },
      },
    },
  } as unknown as Backend
  const i18n = { locale: 'en-US', t: (key: keyof typeof EN_US_MESSAGES) => EN_US_MESSAGES[key] } as I18nState
  render(AiSectionHarness, { props: { backend, i18n } })
  const selectors = await screen.findAllByRole('button', { name: 'Select a model' })
  await waitFor(() => expect(selectors.every((button) => (button as HTMLButtonElement).disabled)).toBe(true))
  await fireEvent.click(screen.getByRole('button', { name: 'Add provider' }))
  await fireEvent.input(await screen.findByRole('textbox', { name: 'Name' }), { target: { value: 'Saved provider' } })
  await fireEvent.click(screen.getByRole('button', { name: 'OK' }))
  await waitFor(() => {
    const refreshed = screen.getAllByRole('button', { name: 'Select a model' })
    expect(refreshed.every((button) => !(button as HTMLButtonElement).disabled)).toBe(true)
    expect(refreshed.map((button) => button.textContent?.trim())).toEqual([
      'saved-model | Saved model',
      EN_US_MESSAGES['ai.role_follow_chat'],
      EN_US_MESSAGES['ai.role_none'],
    ])
  })
  await fireEvent.click(await screen.findByRole('button', { name: 'Provider settings' }))
  await fireEvent.click(await screen.findByRole('button', { name: 'Delete provider' }))
  await waitFor(() => {
    expect(remove).toHaveBeenCalledOnce()
    expect(remove).toHaveBeenCalledWith('provider')
    const refreshed = screen.getAllByRole('button', { name: 'Select a model' })
    expect(refreshed.every((button) => (button as HTMLButtonElement).disabled)).toBe(true)
    expect(refreshed[0]?.textContent).not.toContain('Saved model')
  })
})
