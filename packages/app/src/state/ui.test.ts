import { describe, expect, test } from 'vitest'
import { BackendError } from '@app/backend'
import type { LogFields, Logger } from '@app/log/logger'
import type { NotificationRequest, Notifier, PrefValue, PrefsStore } from '@app/platform'
import { PANEL_WIDTHS, workspacePrefKey } from './layout-prefs'
import { UiState } from './ui.svelte'

class MemoryPrefsStore implements PrefsStore {
  readonly values = new Map<string, PrefValue>()
  saves = 0
  failSaves = false
  #pendingLoads = new Map<string, PromiseWithResolvers<void>>()

  async load(key: string): Promise<unknown> {
    await this.#pendingLoads.get(key)?.promise
    return this.values.get(key)
  }

  async save(key: string, value: PrefValue): Promise<void> {
    this.saves += 1
    if (this.failSaves) throw new BackendError('internal', 0, 'Preference write failed')
    this.values.set(key, structuredClone(value))
  }

  async remove(key: string): Promise<void> {
    this.values.delete(key)
  }

  hold(key: string): () => void {
    const deferred = Promise.withResolvers<void>()
    this.#pendingLoads.set(key, deferred)
    return () => deferred.resolve()
  }
}

class RecordingLogger implements Logger {
  readonly warnings: { event: string; fields: LogFields | undefined }[] = []
  debug(): void {}
  info(): void {}
  warn(event: string, fields?: LogFields): void {
    this.warnings.push({ event, fields })
  }
  error(): void {}
}

class RecordingNotifier implements Notifier {
  readonly toasts: NotificationRequest[] = []
  toast(request: NotificationRequest): void {
    this.toasts.push(request)
  }
  async confirm(): Promise<boolean> {
    return false
  }
}

function createUi(prefs = new MemoryPrefsStore()) {
  const logger = new RecordingLogger()
  const notifier = new RecordingNotifier()
  return { ui: new UiState({ prefs, logger, notifier }), prefs, logger, notifier }
}

describe('UiState layout', () => {
  test('restores a hostile saved width as a visible panel', async () => {
    const prefs = new MemoryPrefsStore()
    prefs.values.set('layout', { navWidth: -9000, listWidth: 0, navCollapsed: 'yes' })
    const { ui } = createUi(prefs)

    await ui.load('user-a')

    expect(ui.layout.navWidth).toBe(PANEL_WIDTHS.navigation.min)
    expect(ui.layout.listWidth).toBe(PANEL_WIDTHS.noteList.min)
    expect(ui.layout.navCollapsed).toBe(false)
  })

  test('clamps resizes and persists the clamped value', async () => {
    const { ui, prefs } = createUi()
    await ui.load('user-a')

    ui.resize({ navWidth: 10_000, workspaceSplitRatio: 0.01 })
    await ui.flush()

    expect(ui.layout.navWidth).toBe(PANEL_WIDTHS.navigation.max)
    expect(prefs.values.get('layout')).toMatchObject({
      navWidth: PANEL_WIDTHS.navigation.max,
      workspaceSplitRatio: 0.2,
    })
  })

  test('coalesces rapid resizes into the latest stored value', async () => {
    const { ui, prefs } = createUi()
    await ui.load('user-a')

    for (let width = 200; width <= 300; width += 10) ui.resize({ navWidth: width })
    await ui.flush()

    expect(prefs.saves).toBeLessThanOrEqual(2)
    expect(prefs.values.get('layout')).toMatchObject({ navWidth: 300 })
  })

  test('keeps a resize made while the stored layout is still loading', async () => {
    const prefs = new MemoryPrefsStore()
    prefs.values.set('layout', { navWidth: 210 })
    const release = prefs.hold('layout')
    const { ui } = createUi(prefs)

    const loading = ui.load('user-a')
    ui.resize({ navWidth: 330 })
    release()
    await loading

    expect(ui.layout.navWidth).toBe(330)
  })

  test('reports a blocked preference store once and keeps the in-memory layout', async () => {
    const prefs = new MemoryPrefsStore()
    prefs.failSaves = true
    const { ui, logger, notifier } = createUi(prefs)
    await ui.load('user-a')

    ui.toggleNav()
    await expect(ui.flush()).rejects.toMatchObject({ code: 'internal' })
    ui.toggleList()
    await expect(ui.flush()).rejects.toMatchObject({ code: 'internal' })

    expect(ui.layout).toMatchObject({ navCollapsed: true, listCollapsed: true })
    expect(logger.warnings.map((entry) => entry.event)).toEqual(['ui.prefs.save_failed', 'ui.prefs.save_failed'])
    expect(notifier.toasts).toHaveLength(1)
    expect(notifier.toasts[0]).toMatchObject({ key: 'shell.layout_preferences_not_saved', tone: 'warning' })
    prefs.failSaves = false
    await ui.flush()
    expect(prefs.values.get('layout')).toMatchObject({ navCollapsed: true, listCollapsed: true })
  })

  test('mirrors appearance for first paint under the layout key', async () => {
    const { ui, prefs } = createUi()
    await ui.load('user-a')

    ui.applyAppearance({ theme: 'dark', accent: 'wisteria', background: 'white' })
    await ui.flush()

    expect(prefs.values.get('layout')).toMatchObject({
      appearance: { theme: 'dark', accent: 'wisteria', background: 'white' },
    })
  })
})

describe('UiState panes', () => {
  test('closing the secondary pane keeps the primary note and layout untouched', async () => {
    const { ui } = createUi()
    await ui.load('user-a')
    ui.openNote('note-a')
    ui.setPaneLayout('primary', 'split')
    ui.openNote('note-b', { pane: 'secondary' })

    ui.closePane('secondary')

    expect(ui.isSplit).toBe(false)
    expect(ui.panes.primary).toEqual({ noteId: 'note-a', layout: 'split' })
    expect(ui.activeNoteId).toBe('note-a')
    expect(ui.recent).toEqual(['note-a', 'note-b'])
  })

  test('closing the primary pane promotes the secondary note', async () => {
    const { ui } = createUi()
    await ui.load('user-a')
    ui.openNote('note-a')
    ui.openNote('note-b', { pane: 'secondary' })

    ui.closePane('primary')

    expect(ui.panes.primary.noteId).toBe('note-b')
    expect(ui.panes.secondary.noteId).toBeNull()
    expect(ui.activeNoteId).toBe('note-b')
  })

  test('changing one pane layout never changes the other pane', async () => {
    const { ui } = createUi()
    await ui.load('user-a')
    ui.openNote('note-a')
    ui.openNote('note-b', { pane: 'secondary' })
    const primaryBefore = ui.panes.primary

    ui.setPaneLayout('secondary', 'preview')

    expect(ui.panes.secondary.layout).toBe('preview')
    expect(ui.panes.primary).toBe(primaryBefore)
    expect(ui.panes.primary.layout).toBe('live')
  })

  test('opens into the active pane while split and can open in the background', async () => {
    const { ui } = createUi()
    await ui.load('user-a')
    ui.openNote('note-a')
    ui.openNote('note-b', { pane: 'secondary' })

    ui.openNote('note-c')
    ui.openNote('note-d', { pane: 'primary', activate: false })

    expect(ui.panes.secondary.noteId).toBe('note-c')
    expect(ui.panes.primary.noteId).toBe('note-d')
    expect(ui.activePane).toBe('secondary')
    expect(ui.activeNoteId).toBe('note-c')
  })

  test('a secondary open without a primary note lands in the primary pane', async () => {
    const { ui } = createUi()
    await ui.load('user-a')

    ui.openNote('note-a', { pane: 'secondary' })

    expect(ui.isSplit).toBe(false)
    expect(ui.panes.primary.noteId).toBe('note-a')
  })

  test('forgetting a deleted note collapses the panes onto the survivor', async () => {
    const { ui } = createUi()
    await ui.load('user-a')
    ui.openNote('note-a')
    ui.openNote('note-b', { pane: 'secondary' })

    ui.forgetNote('note-a')

    expect(ui.panes.primary.noteId).toBe('note-b')
    expect(ui.isSplit).toBe(false)
    expect(ui.selection).toEqual(['note-b'])
  })
})

describe('UiState mobile and history', () => {
  test('narrow screen keeps the selected note and returns to the list explicitly', async () => {
    const { ui } = createUi()
    await ui.load('user-a')
    ui.openNote('note-a')
    ui.openNote('note-b', { pane: 'secondary' })

    expect(ui.mobilePane).toBe('preview')
    ui.setMobilePane('editor')
    ui.mobileBack()

    expect(ui.mobilePane).toBe('list')
    expect(ui.activeNoteId).toBe('note-b')
    expect(ui.selection).toEqual(['note-b'])
    ui.setMobilePane('editor')
    expect(ui.mobilePane).toBe('editor')
  })

  test('note panes fall back to the list when nothing is open', async () => {
    const { ui } = createUi()
    await ui.load('user-a')

    ui.setMobilePane('preview')

    expect(ui.mobilePane).toBe('list')
  })

  test('back and forward walk visited notes without growing history', async () => {
    const { ui } = createUi()
    await ui.load('user-a')
    ui.openNote('note-a')
    ui.openNote('note-b')
    ui.openNote('note-c')

    expect(ui.goBack()).toBe('note-b')
    expect(ui.goBack()).toBe('note-a')
    expect(ui.canGoBack).toBe(false)
    expect(ui.goForward()).toBe('note-b')
    ui.openNote('note-d')

    expect(ui.canGoForward).toBe(false)
    expect(ui.goBack()).toBe('note-b')
  })

  test('opening a view clears selection but keeps the open note', async () => {
    const { ui } = createUi()
    await ui.load('user-a')
    ui.openNote('note-a')
    ui.toggleSelected('note-b', true)

    ui.openView('tag', { tag: 'work' })

    expect(ui.filter).toEqual({ view: 'tag', folderId: null, tag: 'work' })
    expect(ui.selection).toEqual([])
    expect(ui.activeNoteId).toBe('note-a')
    expect(() => ui.openView('folder')).toThrow(RangeError)
  })
})

describe('UiState account isolation', () => {
  test('recent notes and panes are stored per account', async () => {
    const prefs = new MemoryPrefsStore()
    const { ui } = createUi(prefs)
    await ui.load('user-a')
    ui.openNote('note-a')
    await ui.flush()

    await ui.load('user-b')

    expect(ui.recent).toEqual([])
    expect(ui.activeNoteId).toBeNull()
    ui.openNote('note-z')
    await ui.flush()
    await ui.load('user-a')

    expect(ui.recent).toEqual(['note-a'])
    expect(ui.activeNoteId).toBe('note-a')
    expect(prefs.values.get(workspacePrefKey('user-b'))).toMatchObject({ recentNoteIds: ['note-z'] })
  })

  test('a slow load for the previous account never overwrites the new account', async () => {
    const prefs = new MemoryPrefsStore()
    prefs.values.set(workspacePrefKey('user-a'), { recentNoteIds: ['note-a'] })
    prefs.values.set(workspacePrefKey('user-b'), { recentNoteIds: ['note-b'] })
    const release = prefs.hold(workspacePrefKey('user-a'))
    const { ui } = createUi(prefs)

    const first = ui.load('user-a')
    await ui.load('user-b')
    release()
    await first

    expect(ui.scope).toBe('user-b')
    expect(ui.recent).toEqual(['note-b'])
  })

  test('edits during an account switch are not written to either account', async () => {
    const prefs = new MemoryPrefsStore()
    const release = prefs.hold(workspacePrefKey('user-b'))
    const { ui } = createUi(prefs)
    await ui.load('user-a')

    const switching = ui.load('user-b')
    ui.openNote('note-x')
    await ui.flush()

    expect(prefs.values.has(workspacePrefKey('user-a'))).toBe(false)
    release()
    await switching
    expect(ui.activeNoteId).toBeNull()
  })

  test('never stores note bodies in preferences', async () => {
    const prefs = new MemoryPrefsStore()
    const { ui } = createUi(prefs)
    await ui.load('user-a')
    ui.openNote('note-a')
    ui.resize({ listWidth: 300 })
    await ui.flush()

    const stored = JSON.stringify([...prefs.values.entries()])
    expect(stored).not.toMatch(/content|title|body/i)
  })
})
