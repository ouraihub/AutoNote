import { cleanup, fireEvent, waitFor, within } from '@testing-library/svelte'
import { afterEach, expect, test, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/constants'
import type { BackendSession } from '@shared/backend-types'
import type { Note, SyncResponse } from '@shared/types'
import { ChangeFeedEmitter, type Backend } from '../backend'
import type { Logger } from '../log/logger'
import type { PrefsStore } from '../platform/prefs'
import type { Notifier } from '../platform/notifier'
import { mountApp, type AppDeps } from './index'

const ID = '00000000000000000000000001'
const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} }
const session: BackendSession = {
  user: { id: ID, login: 'alice', username: 'alice', name: 'Alice', avatarUrl: '', role: 'owner', createdAt: 1 },
  site: {
    name: 'Notebook',
    initialized: true,
    registrationOpen: false,
    r2Enabled: false,
    kvEnabled: false,
    attachmentStorage: 'local',
    realtimeEnabled: false,
    version: '1',
  },
  settings: DEFAULT_SETTINGS,
}

function makeNote(title: string): Note {
  return {
    id: ID,
    title,
    content: '',
    excerpt: '',
    folderId: null,
    tags: [],
    isPinned: false,
    isStarred: false,
    isArchived: false,
    wordCount: 0,
    charCount: 0,
    rev: 1,
    position: 0,
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
  }
}
function snapshot(note: Note): SyncResponse {
  return {
    notes: [note],
    folders: [],
    tags: [],
    deletions: [],
    cursor: 1,
    full: true,
    facetsFull: true,
    hasMore: false,
    nextKey: null,
    settingsChanged: false,
    profileChanged: false,
    siteChanged: false,
    serverTime: 1,
  }
}
function fixture(title: string) {
  const feed = new ChangeFeedEmitter()
  const note = makeNote(title)
  const notifier: Notifier = { toast() {}, confirm: async () => false }
  const prefs: PrefsStore = {
    load: async () => undefined,
    save: async () => {},
    remove: async () => {},
  }
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
    session: { load: async () => session, logout: async () => {} },
    settings: { get: async () => DEFAULT_SETTINGS, save: async () => DEFAULT_SETTINGS, stats: async () => ({}) },
    notes: {
      snapshot: async () => snapshot(note),
      list: async () => ({ notes: [note], nextCursor: null }),
      get: async () => note,
      flush: async () => ({ pending: 0, failed: 0 }),
      patch: async () => ({ queued: false, note, writeId: 'saved' }),
      create: async () => note,
    },
    changes: feed,
    dispose: vi.fn(async () => {}),
  } as unknown as Backend
  const deps: AppDeps = {
    backend,
    prefs,
    notifier,
    logger,
    clock: { now: () => 1 },
    extensions: { settingsSections: [], aboutPanels: [] },
  }
  return { deps, feed, backend }
}
function target(): HTMLElement {
  const element = document.createElement('div')
  document.body.append(element)
  return element
}
afterEach(() => {
  cleanup()
  document.body.replaceChildren()
})

test('isolates two mounted notebooks and omits share entry without capability', async () => {
  const left = target()
  const right = target()
  const first = fixture('First note')
  const second = fixture('Second note')
  const a = mountApp(left, first.deps)
  const b = mountApp(right, second.deps)
  await waitFor(() => expect(within(left).getByRole('option', { name: 'First note' })).toBeTruthy())
  await waitFor(() => expect(within(right).getByRole('option', { name: 'Second note' })).toBeTruthy())
  expect(within(left).queryByRole('option', { name: 'Second note' })).toBeNull()
  expect(within(right).queryByRole('option', { name: 'First note' })).toBeNull()
  expect(within(left).queryByRole('button', { name: /share/i })).toBeNull()
  expect(first.deps.notifier).not.toBe(second.deps.notifier)
  expect(first.deps.prefs).not.toBe(second.deps.prefs)
  first.feed.emit({ kind: 'library', payload: snapshot(makeNote('First updated')) })
  await waitFor(() => expect(within(left).getByRole('option', { name: 'First updated' })).toBeTruthy())
  expect(within(right).getByRole('option', { name: 'Second note' })).toBeTruthy()
  await fireEvent.click(within(right).getByRole('option', { name: 'Second note' }))
  expect(left.querySelector('.cm-editor')).toBeNull()
  await a.destroy()
  await b.destroy()
})

test('destroy flushes first and detaches event subscriptions; failed flush retains mounted UI', async () => {
  const element = target()
  const { deps, feed, backend } = fixture('Before')
  const handle = mountApp(element, deps)
  await waitFor(() => expect(within(element).getByRole('option', { name: 'Before' })).toBeTruthy())
  backend.notes.flush = vi.fn(async () => ({ pending: 0, failed: 1 }))
  await expect(handle.destroy()).rejects.toThrow('not safely persisted')
  expect(within(element).getByRole('option', { name: 'Before' })).toBeTruthy()
  expect(backend.dispose).not.toHaveBeenCalled()
  backend.notes.flush = vi.fn(async () => ({ pending: 0, failed: 0 }))
  await handle.destroy()
  expect(element.querySelector('[data-testid="app-shell"]')).toBeNull()
  feed.emit({ kind: 'library', payload: snapshot(makeNote('After destroy')) })
  expect(element.textContent).not.toContain('After destroy')
  expect(backend.dispose).toHaveBeenCalledTimes(1)
})

test('rejects inconsistent optional capability before mounting', () => {
  const element = target()
  const { deps } = fixture('No share')
  const inconsistent: AppDeps = {
    ...deps,
    backend: { ...deps.backend, capabilities: { ...deps.backend.capabilities, share: true } },
  }
  expect(() => mountApp(element, inconsistent)).toThrow('Share capability')
  expect(element.childNodes).toHaveLength(0)
})

test('sidebar gear opens the settings dialog', async () => {
  const element = target()
  const { deps } = fixture('Gear')
  const handle = mountApp(element, deps)
  try {
    const sidebar = await waitFor(() => within(element).getByTestId('sidebar'))
    expect(sidebar.querySelector('header img')).toBeNull()
    await fireEvent.click(within(sidebar).getByRole('button', { name: /^(Settings|设置)$/ }))
    await waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeTruthy())
  } finally {
    await handle.destroy()
  }
})

test('same-account settings refresh preserves the open document and language can switch back', async () => {
  const element = target()
  const { deps, feed, backend } = fixture('Persistent editor')
  const handle = mountApp(element, deps)
  try {
    await waitFor(() => expect(within(element).getByRole('option', { name: 'Persistent editor' })).toBeTruthy())
    await fireEvent.click(within(element).getByRole('option', { name: 'Persistent editor' }))
    await waitFor(() => expect(element.querySelector('.cm-editor')).toBeTruthy())
    const editor = element.querySelector('.cm-editor')
    backend.session.load = vi.fn(async (): Promise<BackendSession> => ({
      ...session,
      settings: {
        ...DEFAULT_SETTINGS,
        appearance: { ...DEFAULT_SETTINGS.appearance, language: 'zh-CN', theme: 'dark' },
      },
    }))
    feed.emit({ kind: 'settings' })
    await waitFor(() => expect(element.querySelector('[data-app-root]')?.getAttribute('data-theme')).toBe('dark'))
    expect(element.querySelector('.cm-editor')).toBe(editor)
    backend.session.load = vi.fn(async (): Promise<BackendSession> => ({
      ...session,
      settings: { ...DEFAULT_SETTINGS, appearance: { ...DEFAULT_SETTINGS.appearance, language: 'en-US' } },
    }))
    feed.emit({ kind: 'settings' })
    expect(element.querySelector('.cm-editor')).toBe(editor)
  } finally {
    await handle.destroy()
  }
})

test('initial navigation waits for bootstrap and newer navigation replaces a queued deep link', async () => {
  const element = target()
  const { deps, backend } = fixture('Ready note')
  const loaded = Promise.withResolvers<BackendSession>()
  backend.session.load = () => loaded.promise
  const handle = mountApp(element, deps)
  const oldTarget = handle.openNote(ID)
  const latestTarget = handle.openNote(null)
  loaded.resolve(session)
  await Promise.all([oldTarget, latestTarget])
  expect(element.querySelector('.cm-editor')).toBeNull()
  await handle.openNote(ID)
  await waitFor(() => expect(element.querySelector('.cm-editor')).toBeTruthy())
  await handle.destroy()
})
