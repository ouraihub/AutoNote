import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, expect, test, vi } from 'vitest'
import type { Backend, AiRoleBinding } from '@app/backend'
import type { I18nState } from '@app/i18n/runtime.svelte'
import type { ModelOption, Provider } from '@ouraihub/aether-ui/ports'
import { EN_US_MESSAGES } from '@shared/locales/en-US'
import AiSectionHarness from './AiSectionHarness.svelte'

afterEach(cleanup)

test('saving a provider refreshes both role selectors and deleting it clears stale role bindings', async () => {
  let providers: Provider[] = []
  let options: ModelOption[] = []
  let roles: AiRoleBinding[] = []
  const setRole = vi.fn(async () => roles)
  const backend = {
    aiHost: {
      roles: async () => roles,
      setRole,
      kit: {
        providers: {
          list: async () => providers,
          modelOptions: async () => options,
          save: async () => {
            providers = [
              {
                id: 'provider',
                name: 'Saved provider',
                enabled: true,
                notes: '',
                endpoints: [
                  {
                    id: 'endpoint',
                    slug: 'main',
                    baseUrl: 'https://example.com',
                    protocol: 'openai-chat',
                    keys: [{ id: 'k1', label: '', enabled: true, masked: 'test', readable: true }],
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
          remove: async () => {
            providers = []
            options = []
            roles = []
            return providers
          },
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
    expect(refreshed[0]?.textContent).toContain('Saved model')
  })
  await fireEvent.click(await screen.findByRole('button', { name: 'Provider settings' }))
  await fireEvent.click(await screen.findByRole('button', { name: 'Delete provider' }))
  await waitFor(() => {
    const refreshed = screen.getAllByRole('button', { name: 'Select a model' })
    expect(refreshed.every((button) => (button as HTMLButtonElement).disabled)).toBe(true)
    expect(refreshed[0]?.textContent).not.toContain('Saved model')
  })
})
