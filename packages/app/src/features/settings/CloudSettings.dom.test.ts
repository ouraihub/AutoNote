import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/svelte'
import { afterEach, expect, test, vi } from 'vitest'
import { EN_US_MESSAGES } from '@shared/locales/en-US'
import type { Backend } from '@app/backend'
import type { I18nState } from '@app/i18n/runtime.svelte'
import type { SessionState } from '@app/state/session.svelte'
import type { Notifier } from '@app/platform/notifier'
import type { SettingsState } from '@app/state/settings.svelte'
import AccountSettings from './AccountSettings.svelte'
import BackupSettings from './BackupSettings.svelte'
import McpSettings from './McpSettings.svelte'
import RelaySettings from './RelaySettings.svelte'
import SharedNotes from './SharedNotes.svelte'
import UpdateSettings from './UpdateSettings.svelte'
import CloudSettingsHarness from './CloudSettingsHarness.svelte'

const i18n = {
  locale: 'en-US',
  t: (
    key: keyof typeof EN_US_MESSAGES,
    params?: Record<string, string | number>,
  ) =>
    EN_US_MESSAGES[key].replace(/\{(\w+)\}/g, (placeholder, name: string) =>
      String(params?.[name] ?? placeholder),
    ),
} as I18nState
const notifier = {
  confirm: vi.fn(async () => true),
  toast: vi.fn(),
} as Notifier
const session = {
  status: 'authed',
  epoch: 1,
  epochSignal: new AbortController().signal,
  user: {
    id: 'user-1',
    name: 'Alice',
    username: 'alice',
    avatarUrl: '',
    role: 'member',
  },
  site: { initialized: true, registrationOpen: false },
  load: vi.fn(),
} as unknown as SessionState
const updateProfile = vi.fn(async ({ name }: { name?: string }) => ({
  id: 'user-1',
  name: name ?? 'Alice',
}))
const list = vi.fn(async () => [
  {
    noteId: 'note-1',
    noteTitle: 'Shared note',
    url: 'https://example.com/s/1',
    views: 2,
    deletedAt: null,
    expiresAt: null,
  },
])
const remove = vi.fn(async () => ({ ok: true as const }))
const createKey = vi.fn(async () => ({
  key: {
    id: 'key-1',
    name: 'script',
    scopes: [],
    createdAt: 1,
    lastUsedAt: null,
  },
  token: 'secret-value',
}))
const revokeKey = vi.fn(async () => ({ ok: true as const }))
const get = vi.fn(async () => ({
  enabled: true,
  canManageGlobal: false,
  endpoint: 'https://example.com/mcp',
  preferences: { writeEnabled: false, trashEnabled: false },
  apiKeys: [],
  grants: [],
  aiSearch: { available: false },
}))
const backend = {
  kind: 'web',
  capabilities: {
    accounts: true,
    totp: false,
    share: true,
    remoteBackup: false,
    mcp: 'remote',
    updateCheck: false,
  },
  session: { updateProfile, account: { setPassword: vi.fn() } },
  share: { list, remove },
  mcp: { get, createKey, revokeKey },
} as unknown as Backend
const settings = {
  current: { backup: { schedule: 'off' } },
  update: vi.fn(),
} as unknown as SettingsState
const mount = (
  component:
    | typeof AccountSettings
    | typeof SharedNotes
    | typeof McpSettings
    | typeof RelaySettings
    | typeof BackupSettings
    | typeof UpdateSettings,
  source: Backend = backend,
) =>
  render(CloudSettingsHarness, {
    props: { component, backend: source, session, i18n, notifier, settings },
  })
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

test('profile saves through the session port', async () => {
  mount(AccountSettings)
  await fireEvent.input(screen.getByLabelText('Display name'), {
    target: { value: 'New name' },
  })
  await fireEvent.submit(screen.getByLabelText('Display name').closest('form')!)
  await waitFor(() =>
    expect(updateProfile).toHaveBeenCalledWith(
      { name: 'New name' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ),
  )
})

test('share revocation waits for the Worker before removing the item', async () => {
  mount(SharedNotes)
  await screen.findByText('Shared note')
  await fireEvent.click(screen.getByRole('button', { name: 'Revoke link' }))
  await waitFor(() =>
    expect(remove).toHaveBeenCalledWith('note-1', expect.anything()),
  )
  await waitFor(() => expect(screen.queryByText('Shared note')).toBeNull())
})

test('MCP key token appears only at creation and is removed on close', async () => {
  mount(McpSettings)
  await screen.findByText(
    'No API keys yet. Create one for scripts or minimal MCP clients.',
  )
  await fireEvent.input(screen.getByLabelText('API key name'), {
    target: { value: 'script' },
  })
  await fireEvent.click(screen.getByRole('button', { name: 'Create key' }))
  await screen.findByText('secret-value')
  await fireEvent.click(screen.getByRole('button', { name: 'Close' }))
  await waitFor(() => expect(screen.queryByText('secret-value')).toBeNull())
  await fireEvent.click(screen.getByRole('button', { name: 'Revoke key' }))
  await waitFor(() =>
    expect(revokeKey).toHaveBeenCalledWith('key-1', expect.anything()),
  )
})

test('backup creates a target and never persists its secret to settings state', async () => {
  const create = vi.fn(async () => ({
    id: 'target-1',
    name: 'Home',
    type: 'webdav',
    enabled: true,
    config: {
      url: 'https://dav.example.com',
      username: 'alice',
      prefix: '',
      mode: 'full',
    },
    hasSecret: true,
    lastRunAt: null,
    lastStatus: null,
  }))
  const targets = vi.fn(async () => [])
  mount(BackupSettings, {
    ...backend,
    capabilities: { ...backend.capabilities, remoteBackup: true },
    backup: { targets, runs: vi.fn(async () => []), create },
  } as unknown as Backend)
  await screen.findByRole('button', { name: 'Add target' })
  await fireEvent.click(screen.getByRole('button', { name: 'Add target' }))
  await fireEvent.input(screen.getByLabelText('Name'), {
    target: { value: 'Home' },
  })
  await fireEvent.input(screen.getByLabelText('WebDAV address'), {
    target: { value: 'https://dav.example.com/' },
  })
  await fireEvent.input(screen.getByLabelText('Username'), {
    target: { value: 'alice' },
  })
  await fireEvent.input(screen.getByLabelText('Password'), {
    target: { value: 'secret' },
  })
  await fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() =>
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ secret: { password: 'secret' } }),
      expect.anything(),
    ),
  )
  expect(settings.update).not.toHaveBeenCalled()
})

test('update checks are owner-only', () => {
  const check = vi.fn(async () => ({
    currentVersion: '1.0',
    latestVersion: null,
    updateUrl: null,
    checkedAt: null,
    status: 'ok' as const,
  }))
  mount(UpdateSettings, {
    ...backend,
    capabilities: { ...backend.capabilities, updateCheck: true },
    update: { check },
  } as Backend)
  expect(screen.queryByRole('button', { name: 'Check again' })).toBeNull()
  expect(check).not.toHaveBeenCalled()
})

test('relay is owner-only, shows the token once and validates repositories', async () => {
  const relay = {
    get: vi.fn(async () => ({
      enabled: false,
      endpoint: 'https://example.com/relay/v1',
      audience: 'https://example.com',
      keys: [],
      repos: [],
      protocols: ['openai-chat', 'anthropic-messages'],
    })),
    createKey: vi.fn(async () => ({
      key: {
        id: 'k/1',
        name: 'omp',
        createdAt: 1,
        lastUsedAt: null,
        expiresAt: null,
        todayRequests: 0,
      },
      token: 'anr_secret',
    })),
    revokeKey: vi.fn(async () => ({ ok: true as const })),
    addRepo: vi.fn(async () => ({
      repos: [
        {
          repo: 'me/app',
          workflow: 'me/app/.github/workflows/agent.yml',
          ref: 'refs/heads/main',
        },
      ],
    })),
  }
  const source = { ...backend, relay } as unknown as Backend
  mount(RelaySettings, source)
  expect(relay.get).not.toHaveBeenCalled()
  cleanup()
  const owner = {
    ...session,
    user: { ...session.user, role: 'owner' },
  } as unknown as SessionState
  render(CloudSettingsHarness, {
    props: {
      component: RelaySettings,
      backend: source,
      session: owner,
      i18n,
      notifier,
      settings,
    },
  })
  await screen.findByText('Model relay is paused. Relay requests return 503.')
  const snippet = screen.getByText(
    /baseUrl: "https:\/\/example\.com\/relay\/v1"/,
  ).textContent!
  expect(snippet).toContain(
    'api: openai-completions\n    discovery:\n      type: openai-models-list',
  )
  expect(snippet).toContain('api: anthropic-messages')
  expect(snippet).not.toContain('api: openai-responses')
  await fireEvent.input(screen.getByLabelText('Access key name'), {
    target: { value: 'omp' },
  })
  await fireEvent.click(screen.getByRole('button', { name: 'Create key' }))
  await screen.findByText('anr_secret')
  await fireEvent.click(screen.getByRole('button', { name: 'Close' }))
  await waitFor(() => expect(screen.queryByText('anr_secret')).toBeNull())
  expect(screen.getByText(/never expires/)).toBeTruthy()
  await fireEvent.input(screen.getByLabelText('Repository'), {
    target: { value: 'bad' },
  })
  await fireEvent.input(screen.getByLabelText('Allowed workflow'), {
    target: { value: 'me/app/.github/workflows/agent.yml' },
  })
  await fireEvent.click(screen.getByRole('button', { name: 'Add repository' }))
  await screen.findByText('Enter the repository as owner/repo')
  expect(relay.addRepo).not.toHaveBeenCalled()
  await fireEvent.input(screen.getByLabelText('Repository'), {
    target: { value: 'me/app' },
  })
  await fireEvent.input(screen.getByLabelText('Trusted branch'), {
    target: { value: 'main' },
  })
  await fireEvent.click(screen.getByRole('button', { name: 'Add repository' }))
  await screen.findByText(
    'Enter the branch as refs/heads/name or refs/tags/name',
  )
  expect(relay.addRepo).not.toHaveBeenCalled()
  await fireEvent.input(screen.getByLabelText('Trusted branch'), {
    target: { value: 'refs/heads/main' },
  })
  await fireEvent.click(screen.getByRole('button', { name: 'Add repository' }))
  await screen.findByText('me/app/.github/workflows/agent.yml')
  expect(relay.addRepo).toHaveBeenCalledWith(
    'me/app',
    'me/app/.github/workflows/agent.yml',
    'refs/heads/main',
    expect.anything(),
  )
})

test.each([
  { protocols: [], expected: 'providers: {}' },
  { protocols: ['openai-responses'], expected: 'api: openai-responses' },
])(
  'relay snippet follows supported protocols $protocols',
  async ({ protocols, expected }) => {
    const relay = {
      get: vi.fn(async () => ({
        enabled: true,
        endpoint: 'https://example.com/relay/v1',
        audience: 'https://example.com',
        keys: [],
        repos: [],
        protocols,
      })),
    }
    const source = { ...backend, relay } as unknown as Backend
    const owner = {
      ...session,
      user: { ...session.user, role: 'owner' },
    } as unknown as SessionState
    render(CloudSettingsHarness, {
      props: {
        component: RelaySettings,
        backend: source,
        session: owner,
        i18n,
        notifier,
        settings,
      },
    })
    const snippet = await screen.findByText(
      (_, element) =>
        element?.tagName === 'PRE' && !!element.textContent?.includes(expected),
    )
    expect(snippet.textContent).not.toContain('api: openai-completions')
    expect(snippet.textContent).not.toContain('api: anthropic-messages')
  },
)

test('desktop never fetches private Worker settings even with inconsistent capabilities', () => {
  const desktop = { ...backend, kind: 'desktop' } as Backend
  mount(SharedNotes, desktop)
  expect(list).not.toHaveBeenCalled()
  cleanup()
  mount(McpSettings, desktop)
  expect(get).not.toHaveBeenCalled()
  cleanup()
  mount(AccountSettings, desktop)
  expect(screen.queryByLabelText('Display name')).toBeNull()
})
