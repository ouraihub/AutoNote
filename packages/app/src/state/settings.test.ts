import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { DEFAULT_SETTINGS, mergeSettingsPatch } from '@shared/constants'
import type { SettingsPatch } from '@shared/backend-types'
import type { UserSettings } from '@shared/types'
import { BackendError, type SettingsPort } from '@app/backend'
import type { Logger } from '@app/log/logger'
import type { NotificationRequest, Notifier } from '@app/platform'
import { SETTINGS_RETRY_BASE_MS, SETTINGS_SAVE_DELAY_MS, SettingsState } from './settings.svelte'

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

class FakeSettingsPort implements SettingsPort {
  readonly saves: { patch: SettingsPatch; reply: Deferred<UserSettings> }[] = []
  readonly gets: Deferred<UserSettings>[] = []
  server: UserSettings = DEFAULT_SETTINGS

  get(): Promise<UserSettings> {
    const reply = deferred<UserSettings>()
    this.gets.push(reply)
    return reply.promise
  }

  save(patch: SettingsPatch): Promise<UserSettings> {
    const reply = deferred<UserSettings>()
    this.saves.push({ patch, reply })
    return reply.promise
  }

  async stats(): Promise<Record<string, number>> {
    return {}
  }

  acceptLast(): void {
    const last = this.saves.at(-1)
    if (!last) throw new Error('No save request')
    this.server = mergeSettingsPatch(this.server, last.patch)
    last.reply.resolve(this.server)
  }
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

const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} }

function setup() {
  const port = new FakeSettingsPort()
  const notifier = new RecordingNotifier()
  const state = new SettingsState({ port, notifier, logger: silentLogger })
  state.adopt('user-a', DEFAULT_SETTINGS)
  return { port, notifier, state }
}

async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}

describe('SettingsState', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  test('starts from DEFAULT_SETTINGS and normalizes adopted server settings', () => {
    const state = new SettingsState({
      port: new FakeSettingsPort(),
      notifier: new RecordingNotifier(),
      logger: silentLogger,
    })
    expect(state.current).toEqual(DEFAULT_SETTINGS)

    state.adopt('user-a', {
      ...DEFAULT_SETTINGS,
      editor: { ...DEFAULT_SETTINGS.editor, fontSize: 99 },
    })
    expect(state.current.editor.fontSize).toBe(22)
  })

  test('debounces rapid edits into one sectioned patch while showing every edit immediately', async () => {
    const { port, state } = setup()

    state.update({ appearance: { theme: 'dark' } })
    state.update({ editor: { fontSize: 18 } })
    state.update({ appearance: { accent: 'indigo' } })

    expect(state.current.appearance.theme).toBe('dark')
    expect(state.current.appearance.accent).toBe('indigo')
    expect(state.current.editor.fontSize).toBe(18)
    expect(state.persisted.appearance.theme).toBe(DEFAULT_SETTINGS.appearance.theme)
    expect(state.status).toBe('scheduled')

    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DELAY_MS - 1)
    expect(port.saves).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)

    expect(port.saves.map((save) => save.patch)).toEqual([
      { appearance: { theme: 'dark', accent: 'indigo' }, editor: { fontSize: 18 } },
    ])
    expect(state.status).toBe('saving')

    port.acceptLast()
    await settle()
    expect(state.persisted.appearance.accent).toBe('indigo')
    expect(state.pendingPatch).toBeNull()
    expect(state.status).toBe('idle')
  })

  test('an older save confirmation does not revert a later edit of the same field', async () => {
    const { port, state } = setup()

    state.update({ appearance: { theme: 'dark' } })
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DELAY_MS)
    state.update({ appearance: { theme: 'light' } })

    port.acceptLast()
    await settle()

    expect(state.persisted.appearance.theme).toBe('dark')
    expect(state.current.appearance.theme).toBe('light')

    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DELAY_MS)
    expect(port.saves.at(-1)?.patch).toEqual({ appearance: { theme: 'light' } })
    port.acceptLast()
    await settle()
    expect(state.persisted.appearance.theme).toBe('light')
    expect(state.current.appearance.theme).toBe('light')
  })

  test('a failed save keeps the patch, keeps later edits, and retries with backoff', async () => {
    const { port, notifier, state } = setup()

    state.update({ editor: { fontSize: 18 } })
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DELAY_MS)
    state.update({ editor: { lineNumbers: true } })
    port.saves[0]?.reply.reject(new BackendError('offline', 0, 'offline'))
    await settle()

    expect(state.error).toBe('offline')
    expect(state.status).toBe('retrying')
    expect(state.current.editor.fontSize).toBe(18)
    expect(state.current.editor.lineNumbers).toBe(true)
    expect(state.persisted.editor.fontSize).toBe(DEFAULT_SETTINGS.editor.fontSize)
    expect(notifier.toasts.map((toast) => toast.key)).toEqual(['session.could_not_save_settings'])

    await vi.advanceTimersByTimeAsync(SETTINGS_RETRY_BASE_MS - 1)
    expect(port.saves).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(port.saves[1]?.patch).toEqual({ editor: { fontSize: 18, lineNumbers: true } })

    port.saves[1]?.reply.reject(new BackendError('offline', 0, 'offline'))
    await settle()
    await vi.advanceTimersByTimeAsync(SETTINGS_RETRY_BASE_MS * 2 - 1)
    expect(port.saves).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(port.saves).toHaveLength(3)

    port.acceptLast()
    await settle()
    expect(state.error).toBeNull()
    expect(state.pendingPatch).toBeNull()
    expect(state.persisted.editor).toMatchObject({ fontSize: 18, lineNumbers: true })
  })

  test('silent edits do not raise a failure toast', async () => {
    const { port, notifier, state } = setup()

    state.update({ preview: { layout: 'split' } }, { silent: true })
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DELAY_MS)
    port.saves[0]?.reply.reject(new BackendError('storage_unavailable', 503, 'unavailable'))
    await settle()

    expect(state.error).toBe('storage_unavailable')
    expect(notifier.toasts).toHaveLength(0)
  })

  test('rejects unknown keys and out-of-range values without changing state', () => {
    const { state } = setup()

    expect(() => state.update({ editor: { fontSize: 99 } })).toThrow(BackendError)
    expect(() => state.update({ appearance: { theme: 'neon' } } as unknown as SettingsPatch)).toThrow(
      expect.objectContaining({ code: 'bad_request' }),
    )
    expect(() => state.update({ unknown: {} } as unknown as SettingsPatch)).toThrow(BackendError)
    expect(state.pendingPatch).toBeNull()
    expect(state.status).toBe('idle')
  })

  test('flush bypasses the debounce and reports whether everything was confirmed', async () => {
    const { port, state } = setup()

    state.update({ sync: { realtime: false } })
    const flushed = state.flush()
    await settle()
    expect(port.saves).toHaveLength(1)
    port.saves[0]?.reply.reject(new BackendError('offline', 0, 'offline'))
    await expect(flushed).resolves.toBe(false)
    expect(state.pendingPatch).toEqual({ sync: { realtime: false } })

    const retried = state.flush()
    await settle()
    port.acceptLast()
    await expect(retried).resolves.toBe(true)
    expect(state.pendingPatch).toBeNull()
  })

  test('switching owner discards the old patch and ignores its late response', async () => {
    const { port, state } = setup()

    state.update({ appearance: { theme: 'dark' } })
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DELAY_MS)
    state.adopt('user-b', { ...DEFAULT_SETTINGS, appearance: { ...DEFAULT_SETTINGS.appearance, accent: 'amber' } })

    port.saves[0]?.reply.resolve(mergeSettingsPatch(DEFAULT_SETTINGS, { appearance: { theme: 'dark' } }))
    await settle()

    expect(state.current.appearance.theme).toBe(DEFAULT_SETTINGS.appearance.theme)
    expect(state.current.appearance.accent).toBe('amber')
    expect(state.pendingPatch).toBeNull()
    await vi.advanceTimersByTimeAsync(SETTINGS_RETRY_BASE_MS)
    expect(port.saves).toHaveLength(1)
  })

  test('a stale load response does not overwrite a newer adopted session', async () => {
    const { port, state } = setup()

    const loading = state.load()
    state.adopt('user-a', { ...DEFAULT_SETTINGS, backup: { schedule: 'daily' } })
    port.gets[0]?.resolve({ ...DEFAULT_SETTINGS, backup: { schedule: 'off' } })
    await loading

    expect(state.current.backup.schedule).toBe('daily')
  })

  test('loading keeps outstanding local edits on top of fresh server settings', async () => {
    const { port, state } = setup()

    state.update({ editor: { tabSize: 4 } })
    const loading = state.load()
    port.gets[0]?.resolve({ ...DEFAULT_SETTINGS, editor: { ...DEFAULT_SETTINGS.editor, fontSize: 20 } })
    await loading

    expect(state.current.editor).toMatchObject({ tabSize: 4, fontSize: 20 })
    expect(state.pendingPatch).toEqual({ editor: { tabSize: 4 } })
  })
})
