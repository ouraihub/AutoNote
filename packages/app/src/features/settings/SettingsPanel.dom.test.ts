import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, describe, expect, test, vi } from 'vitest'
import TestSection from './TestSection.svelte'
import type { Backend } from '@app/backend'
import type { SessionState } from '@app/state/session.svelte'
import type { I18nState } from '@app/i18n/runtime.svelte'
import type { SettingsState } from '@app/state/settings.svelte'
import type { NotesState } from '@app/state/notes.svelte'
import type { Notifier } from '@app/platform/notifier'
import { DEFAULT_SETTINGS } from '@shared/constants'
import { EN_US_MESSAGES } from '@shared/locales/en-US'
import SettingsPanelHarness from './SettingsPanelHarness.svelte'

const session = {
  epoch: 1,
  status: 'authed',
  epochSignal: new AbortController().signal,
  user: { id: 'user-1', name: 'Alice', username: 'alice', role: 'member' },
} as unknown as SessionState
const i18n = {
  t: (key: keyof typeof EN_US_MESSAGES) => EN_US_MESSAGES[key],
  formatNumber: (value: number) => String(value),
} as I18nState
const settings = { current: DEFAULT_SETTINGS, update: vi.fn(), error: null } as unknown as SettingsState
const notes = { applySync: vi.fn() } as unknown as NotesState
const notifier = { confirm: vi.fn(async () => true), toast: vi.fn() } as Notifier
const backend = {
  kind: 'desktop',
  capabilities: {
    accounts: false,
    totp: false,
    share: false,
    remoteBackup: false,
    semanticSearch: false,
    mcp: null,
    realtime: false,
    remoteSync: false,
    updateCheck: false,
  },
  settings: { stats: vi.fn(async () => ({ notes: 1 })) },
} as unknown as Backend

const props = { backend, session, i18n, settings, notes, notifier, onClose: vi.fn(), extensions: [] }

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('settings dialog', () => {
  test('renders only eligible sections and host content with dialog focus and dismissal', async () => {
    const onClose = vi.fn()
    render(SettingsPanelHarness, {
      props: {
        ...props,
        onClose,
        extensions: [{ id: 'host', order: 0, titleKey: 'settings.sync', canShow: () => true, component: TestSection }],
      },
    })
    const dialog = await screen.findByRole('dialog', { name: 'Settings' })
    expect(screen.queryByRole('button', { name: 'Backup' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Sync' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Appearance' }).getAttribute('aria-current')).toBe('page')
    await fireEvent.click(screen.getByRole('button', { name: 'Sync' }))
    expect(screen.getByRole('button', { name: 'Sync' }).getAttribute('aria-current')).toBe('page')
    expect(await screen.findByText('Version history')).toBeTruthy()
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true))
    await fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
  })

  test('closing dismisses host account content', async () => {
    const onClose = vi.fn()
    const view = render(SettingsPanelHarness, {
      props: {
        ...props,
        onClose,
        extensions: [{ id: 'host', order: 0, titleKey: 'settings.sync', canShow: () => true, component: TestSection }],
      },
    })
    await fireEvent.click(screen.getByRole('button', { name: 'Sync' }))
    expect(await screen.findByText('Version history')).toBeTruthy()
    await fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledOnce()
    view.unmount()
    expect(screen.queryByText('Version history')).toBeNull()
  })
  test('appearance selection saves dark theme through SettingsState', async () => {
    render(SettingsPanelHarness, { props })
    await fireEvent.click(await screen.findByRole('button', { name: 'Dark' }))
    expect(settings.update).toHaveBeenCalledWith({ appearance: { theme: 'dark' } })
  })

  test('web backup and MCP navigation renders real controls', async () => {
    const web = {
      ...backend,
      kind: 'web',
      capabilities: { ...backend.capabilities, remoteBackup: true, mcp: 'remote' },
      backup: { targets: vi.fn(async () => []), runs: vi.fn(async () => []) },
      mcp: {
        getPreferences: vi.fn(async () => ({ writeEnabled: false, trashEnabled: false })),
        get: vi.fn(async () => ({
          enabled: true,
          canManageGlobal: false,
          endpoint: 'https://example.com/mcp',
          preferences: { writeEnabled: false, trashEnabled: false },
          apiKeys: [],
          grants: [],
          aiSearch: { available: false },
        })),
      },
    } as unknown as Backend
    render(SettingsPanelHarness, { props: { ...props, backend: web } })
    await fireEvent.click(screen.getByRole('button', { name: 'Backup' }))
    expect(await screen.findByRole('button', { name: 'Add target' })).toBeTruthy()
    await fireEvent.click(screen.getByRole('button', { name: 'MCP' }))
    expect(await screen.findByText('No API keys yet. Create one for scripts or minimal MCP clients.')).toBeTruthy()
  })

  test('desktop excludes cloud sections despite inconsistent capabilities', async () => {
    const desktop = {
      ...backend,
      capabilities: {
        ...backend.capabilities,
        mcp: 'local',
        remoteBackup: true,
        accounts: true,
        share: true,
        updateCheck: true,
      },
    } as Backend
    render(SettingsPanelHarness, { props: { ...props, backend: desktop } })
    await screen.findByRole('button', { name: 'Dark' })
    for (const name of ['Backup', 'MCP', 'Account', 'Shared notes']) {
      expect(screen.queryByRole('button', { name })).toBeNull()
    }
  })

  test('about offers deployment checks only to web owners', async () => {
    const web = {
      ...backend,
      kind: 'web',
      capabilities: { ...backend.capabilities, updateCheck: true },
      update: { check: vi.fn(async () => ({ status: 'unavailable', currentVersion: '1.0' })) },
    } as unknown as Backend
    const owner = { ...session, user: { ...session.user, role: 'owner' } } as SessionState
    render(SettingsPanelHarness, { props: { ...props, backend: web, session: owner } })
    await fireEvent.click(screen.getByRole('button', { name: 'about' }))
    expect(await screen.findByRole('button', { name: 'Check again' })).toBeTruthy()
    cleanup()
    render(SettingsPanelHarness, { props: { ...props, backend: web } })
    await fireEvent.click(screen.getByRole('button', { name: 'about' }))
    expect(screen.queryByRole('button', { name: 'Check again' })).toBeNull()
  })

  test('switching accounts aborts the previous resource and ignores its late response', async () => {
    let resolve!: (value: Record<string, number>) => void
    const old = new Promise<Record<string, number>>((finish) => {
      resolve = finish
    })
    const stats = vi.fn().mockReturnValueOnce(old).mockResolvedValue({ notes: 2 })
    const dataBackend = { ...backend, settings: { stats }, transfer: { sources: [] } } as unknown as Backend
    const view = render(SettingsPanelHarness, { props: { ...props, backend: dataBackend, epoch: 1 } })
    await fireEvent.click(screen.getByRole('button', { name: 'Data' }))
    await waitFor(() => expect(stats).toHaveBeenCalledTimes(1))
    await view.rerender({ ...props, backend: dataBackend, epoch: 2 })
    await waitFor(() => expect(stats.mock.calls[0]?.[0].signal.aborted).toBe(true))
    expect(screen.getByRole('button', { name: 'Appearance' }).getAttribute('aria-current')).toBe('page')
    resolve({ notes: 1 })
    await fireEvent.click(screen.getByRole('button', { name: 'Data' }))
    await waitFor(() => expect(stats.mock.calls.length).toBeGreaterThanOrEqual(2))
    expect(await screen.findByText('2')).toBeTruthy()
    expect(screen.queryByText('1')).toBeNull()
  })
})
