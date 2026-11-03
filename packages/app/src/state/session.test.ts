import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/constants'
import { BackendError, ChangeFeedEmitter } from '@app/backend'
import { SETTINGS_SAVE_DELAY_MS } from './settings.svelte'
import { session, setup } from './session-test-fixtures'

describe('SessionState', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  test('load adopts the user, site and settings', async () => {
    const { port, settings, state } = setup()
    const loading = state.load()
    expect(state.status).toBe('loading')

    port.loads[0]?.reply.resolve(
      session('user-a', {
        ...DEFAULT_SETTINGS,
        editor: { ...DEFAULT_SETTINGS.editor, fontSize: 19 },
      }),
    )
    await loading

    expect(state.status).toBe('authed')
    expect(state.user?.id).toBe('user-a')
    expect(state.site?.name).toBe('AutoNote')
    expect(settings.current.editor.fontSize).toBe(19)
  })

  test('a newer load cancels the older on\
e and its late response is ignored', async () => {
    const { port, state } = setup()
    const first = state.load()
    const second = state.load()

    expect(port.loads[0]?.signal?.aborted).toBe(true)
    port.loads[1]?.reply.resolve(session('user-b'))
    await second
    port.loads[0]?.reply.resolve(session('user-a'))
    await first

    expect(state.user?.id).toBe('user-b')
  })

  test('switching accounts bumps the epoch, aborts the\
 old epoch signal and drops old settings edits', async () => {
    const { port, account, settings, settingsPort, state } = setup()
    const loading = state.load()
    port.loads[0]?.reply.resolve(session('user-a'))
    await loading
    const oldEpoch = state.epoch
    const oldSignal = state.epochSignal

    settings.update({ appearance: { theme: 'dark' } })
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DELAY_MS)
    expect(settingsPort.saves).toHaveLength(1)

    const signingIn = state.login('user-b', 'secret-password')
    account?.logins[0]?.reply.resolve(session('user-b'))
    await expect(signingIn).resolves.toBe('authed')

    expect(state.epoch).toBe(oldEpoch + 1)
    expect(oldSignal.aborted).toBe(true)
    expect(state.epochSignal.aborted).toBe(false)
    expect(settings.current.appearance.theme).toBe(
      DEFAULT_SETTINGS.appearance.theme,
    )

    settingsPort.saves[0]?.resolve({
      ...DEFAULT_SETTINGS,
      appearance: { ...DEFAULT_SETTINGS.appearance, theme: 'dark' },
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(settings.current.appearance.theme).toBe(
      DEFAULT_SETTINGS.appearance.theme,
    )
  })

  test('reloading the same account keeps the epoch', async () => {
    const { port, state } = setup()
    const first = state.load()
    port.loads[0]?.reply.resolve(session('user-a'))
    await first
    const epoch = state.epoch

    const second = state.load()
    port.loads[1]?.reply.resolve(session('user-a'))
    await second

    expect(state.epoch).toBe(epoch)
  })

  test('unauthenticated load becomes anonymous;\
 offline reload keeps the signed-in user', async () => {
    const { port, state } = setup()
    const first = state.load()
    port.loads[0]?.reply.reject(
      new BackendError('unauthenticated', 401, 'no session'),
    )
    await first
    expect(state.status).toBe('anonymous')
    expect(state.authError).toBe('unauthenticated')

    const second = state.load()
    port.loads[1]?.reply.resolve(session('user-a'))
    await second
    const third = state.load()
    port.loads[2]?.reply.reject(new BackendError('offline', 0, 'offline'))
    await third
    expect(state.status).toBe('authed')
    expect(state.user?.id).toBe('user-a')
    expect(state.authError).toBe('offline')
  })

  test('desktop sessions have no account\
 entry and never fake a sign-out', async () => {
    const { port, state } = setup({ accounts: false })
    const loading = state.load()
    port.loads[0]?.reply.resolve(session('library'))
    await loading

    expect(state.canSignIn).toBe(false)
    await expect(state.login('user', 'pw')).rejects.toMatchObject({
      code: 'forbidden',
    })
    await expect(state.logout()).resolves.toEqual({
      kind: 'failed',
      code: 'forbidden',
    })
    expect(port.logouts).toHaveLength(0)
    expect(state.status).toBe('authed')
  })

  test('logout is refused while notes or setti\
ngs are unsynced and the queue is kept', async () => {
    const { port, notifier, settings, settingsPort, state } = setup({
      flush: { pending: 2, failed: 1 },
    })
    const loading = state.load()
    port.loads[0]?.reply.resolve(session('user-a'))
    await loading

    settings.update({ editor: { fontSize: 18 } })
    const leaving = state.logout()
    await vi.advanceTimersByTimeAsync(0)
    settingsPort.saves[0]?.reject(new BackendError('offline', 0, 'offline'))

    await expect(leaving).resolves.toEqual({
      kind: 'blocked',
      pending: 2,
      failed: 1,
      settingsPending: true,
    })
    expect(port.logouts).toHaveLength(0)
    expect(state.status).toBe('authed')
    expect(settings.current.editor.fontSize).toBe(18)
    expect(notifier.toasts).toContainEqual(
      expect.objectContaining({
        key: 'session.logout_blocked',
        params: { count: 4 },
      }),
    )
  })

  test('logout flushes first, is single\
-flight, and only then signs out', async () => {
    const { port, flushNotes, state } = setup()
    const loading = state.load()
    port.loads[0]?.reply.resolve(session('user-a'))
    await loading
    const epoch = state.epoch

    const first = state.logout()
    const second = state.logout()
    expect(second).toBe(first)
    await vi.advanceTimersByTimeAsync(0)
    expect(flushNotes).toHaveBeenCalledTimes(1)
    expect(port.logouts).toHaveLength(1)

    port.logouts[0]?.reply.resolve()
    await expect(first).resolves.toEqual({ kind: 'signed-out' })
    expect(state.status).toBe('anonymous')
    expect(state.user).toBeNull()
    expect(state.epoch).toBe(epoch + 1)
  })

  test('a failed logout request keeps the current session', async () => {
    const { port, notifier, state } = setup()
    const loading = state.load()
    port.loads[0]?.reply.resolve(session('user-a'))
    await loading

    const leaving = state.logout()
    await vi.advanceTimersByTimeAsync(0)
    port.logouts[0]?.reply.reject(new BackendError('offline', 0, 'offline'))

    await expect(leaving).resolves.toEqual({ kind: 'failed', code: 'offline' })
    expect(state.status).toBe('authed')
    expect(notifier.toasts).toContainEqual(
      expect.objectContaining({ key: 'session.logout_failed' }),
    )
  })

  test('settings change events coalesce into\
 one reload and stop after unsubscribe', async () => {
    const { port, state } = setup()
    const loading = state.load()
    port.loads[0]?.reply.resolve(session('user-a'))
    await loading

    const feed = new ChangeFeedEmitter()
    const unsubscribe = state.watch(feed)
    feed.emit({ kind: 'settings' })
    feed.emit({ kind: 'settings' })
    feed.emit({ kind: 'connectivity', online: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(port.loads).toHaveLength(2)

    port.loads[1]?.reply.resolve(session('user-a'))
    await vi.advanceTimersByTimeAsync(0)
    unsubscribe()
    feed.emit({ kind: 'settings' })
    await vi.advanceTimersByTimeAsync(0)
    expect(port.loads).toHaveLength(2)
  })
})
