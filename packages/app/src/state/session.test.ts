import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/constants'
import type { BackendSession, FlushResult } from '@shared/backend-types'
import type { PasswordLoginResult, PublicUser, SessionInfo, TotpLoginResult, UserSettings } from '@shared/types'
import {
  BackendError,
  ChangeFeedEmitter,
  type SessionAccountPort,
  type SessionPort,
  type SettingsPort,
} from '@app/backend'
import type { Logger } from '@app/log/logger'
import type { NotificationRequest, Notifier } from '@app/platform'
import { SessionState } from './session.svelte'
import { SETTINGS_SAVE_DELAY_MS, SettingsState } from './settings.svelte'

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

interface Call<T> {
  reply: Deferred<T>
  signal: AbortSignal | undefined
}

function call<T>(calls: Call<T>[], signal: AbortSignal | undefined): Promise<T> {
  const reply = deferred<T>()
  calls.push({ reply, signal })
  return reply.promise
}

function unexpected(): never {
  throw new Error('Unexpected port call')
}

class FakeAccountPort implements SessionAccountPort {
  readonly logins: Call<PasswordLoginResult>[] = []
  readonly totpLogins: (Call<TotpLoginResult> & { token: string; code: string })[] = []
  readonly registrations: Call<BackendSession>[] = []
  readonly totp = {
    status: unexpected,
    startSetup: unexpected,
    confirmSetup: unexpected,
    cancelSetup: unexpected,
    regenerateRecoveryCodes: unexpected,
    disable: unexpected,
  }

  register(_username: string, _password: string, _locale: string, options?: { signal?: AbortSignal }) {
    return call(this.registrations, options?.signal)
  }

  login(_username: string, _password: string, options?: { signal?: AbortSignal }) {
    return call(this.logins, options?.signal)
  }

  completeTotpLogin(token: string, code: string, options?: { signal?: AbortSignal }) {
    const reply = deferred<TotpLoginResult>()
    this.totpLogins.push({ reply, signal: options?.signal, token, code })
    return reply.promise
  }

  setPassword = unexpected
  updateProfile = unexpected
  updateRegistration = unexpected
}

class FakeSessionPort implements SessionPort {
  readonly loads: Call<BackendSession>[] = []
  readonly logouts: Call<void>[] = []
  readonly account?: SessionAccountPort

  constructor(account?: SessionAccountPort) {
    if (account) this.account = account
  }

  load(options?: { signal?: AbortSignal }) {
    return call(this.loads, options?.signal)
  }

  logout(options?: { signal?: AbortSignal }) {
    return call(this.logouts, options?.signal)
  }
}

class FakeSettingsPort implements SettingsPort {
  readonly saves: Deferred<UserSettings>[] = []
  async get(): Promise<UserSettings> {
    return DEFAULT_SETTINGS
  }
  save(): Promise<UserSettings> {
    const reply = deferred<UserSettings>()
    this.saves.push(reply)
    return reply.promise
  }
  async stats(): Promise<Record<string, number>> {
    return {}
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

function user(id: string): PublicUser {
  return { id, login: id, username: id, name: id, avatarUrl: '', role: 'member', createdAt: 0 }
}

function session(id: string | null, settings: UserSettings | null = DEFAULT_SETTINGS): SessionInfo {
  return {
    user: id ? user(id) : null,
    site: {
      name: 'AutoNote',
      initialized: true,
      registrationOpen: true,
      r2Enabled: false,
      kvEnabled: false,
      attachmentStorage: null,
      realtimeEnabled: false,
      version: '1.0.0',
    },
    settings,
  }
}

function setup(options: { accounts?: boolean; flush?: FlushResult } = {}) {
  const account = options.accounts === false ? undefined : new FakeAccountPort()
  const port = new FakeSessionPort(account)
  const settingsPort = new FakeSettingsPort()
  const notifier = new RecordingNotifier()
  const settings = new SettingsState({ port: settingsPort, notifier, logger: silentLogger })
  let now = 1_000
  const flushNotes = vi.fn(async (): Promise<FlushResult> => options.flush ?? { pending: 0, failed: 0 })
  const state = new SessionState({
    port,
    settings,
    notifier,
    logger: silentLogger,
    clock: { now: () => now },
    flushNotes,
  })
  return {
    account,
    port,
    settingsPort,
    notifier,
    settings,
    state,
    flushNotes,
    setNow(value: number) {
      now = value
    },
  }
}

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
      session('user-a', { ...DEFAULT_SETTINGS, editor: { ...DEFAULT_SETTINGS.editor, fontSize: 19 } }),
    )
    await loading

    expect(state.status).toBe('authed')
    expect(state.user?.id).toBe('user-a')
    expect(state.site?.name).toBe('AutoNote')
    expect(settings.current.editor.fontSize).toBe(19)
  })

  test('a newer load cancels the older one and its late response is ignored', async () => {
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

  test('switching accounts bumps the epoch, aborts the old epoch signal and drops old settings edits', async () => {
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
    expect(settings.current.appearance.theme).toBe(DEFAULT_SETTINGS.appearance.theme)

    settingsPort.saves[0]?.resolve({
      ...DEFAULT_SETTINGS,
      appearance: { ...DEFAULT_SETTINGS.appearance, theme: 'dark' },
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(settings.current.appearance.theme).toBe(DEFAULT_SETTINGS.appearance.theme)
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

  test('a late login response from a superseded attempt cannot sign in the old account', async () => {
    const { account, state } = setup()
    const first = state.login('user-a', 'pw-a')
    const second = state.login('user-b', 'pw-b')

    account?.logins[1]?.reply.resolve(session('user-b'))
    await expect(second).resolves.toBe('authed')
    account?.logins[0]?.reply.resolve(session('user-a'))
    await expect(first).resolves.toBe('superseded')

    expect(state.user?.id).toBe('user-b')
  })

  test('a password login that needs TOTP stores the challenge and completes with the code', async () => {
    const { account, notifier, state } = setup()
    const signingIn = state.login('user-a', 'pw')
    account?.logins[0]?.reply.resolve({ twoFactorRequired: true, challengeToken: 'challenge-1', expiresAt: 5_000 })
    await expect(signingIn).resolves.toBe('challenge')
    expect(state.status).toBe('loading')
    expect(state.challenge?.challengeToken).toBe('challenge-1')

    const verifying = state.completeTotp('123456')
    expect(account?.totpLogins[0]).toMatchObject({ token: 'challenge-1', code: '123456' })
    account?.totpLogins[0]?.reply.resolve({ ...session('user-a'), recoveryCodeUsed: true, recoveryCodesRemaining: 1 })
    await expect(verifying).resolves.toBe('authed')

    expect(state.status).toBe('authed')
    expect(state.challenge).toBeNull()
    expect(notifier.toasts).toContainEqual(
      expect.objectContaining({ key: 'auth.recovery_codes_remaining', params: { count: 1 }, tone: 'error' }),
    )
  })

  test('an expired challenge is rejected locally with the challenge-expired code', async () => {
    const { account, setNow, state } = setup()
    const signingIn = state.login('user-a', 'pw')
    account?.logins[0]?.reply.resolve({ twoFactorRequired: true, challengeToken: 'challenge-1', expiresAt: 5_000 })
    await signingIn

    setNow(5_000)
    await expect(state.completeTotp('123456')).resolves.toBe('rejected')

    expect(account?.totpLogins).toHaveLength(0)
    expect(state.authError).toBe('two_factor_challenge_expired')
    expect(state.challenge).toBeNull()
  })

  test('a server-side challenge expiry clears the challenge, while a wrong code keeps it', async () => {
    const { account, state } = setup()
    const signingIn = state.login('user-a', 'pw')
    account?.logins[0]?.reply.resolve({ twoFactorRequired: true, challengeToken: 'challenge-1', expiresAt: 50_000 })
    await signingIn

    const wrong = state.completeTotp('000000')
    account?.totpLogins[0]?.reply.reject(new BackendError('invalid_two_factor_code', 401, 'bad code'))
    await expect(wrong).resolves.toBe('rejected')
    expect(state.authError).toBe('invalid_two_factor_code')
    expect(state.challenge?.challengeToken).toBe('challenge-1')

    const expired = state.completeTotp('111111')
    account?.totpLogins[1]?.reply.reject(new BackendError('two_factor_challenge_expired', 401, 'expired'))
    await expect(expired).resolves.toBe('rejected')
    expect(state.authError).toBe('two_factor_challenge_expired')
    expect(state.challenge).toBeNull()
    expect(state.busy).toBe(false)
  })

  test('unauthenticated load becomes anonymous; offline reload keeps the signed-in user', async () => {
    const { port, state } = setup()
    const first = state.load()
    port.loads[0]?.reply.reject(new BackendError('unauthenticated', 401, 'no session'))
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

  test('desktop sessions have no account entry and never fake a sign-out', async () => {
    const { port, state } = setup({ accounts: false })
    const loading = state.load()
    port.loads[0]?.reply.resolve(session('library'))
    await loading

    expect(state.canSignIn).toBe(false)
    await expect(state.login('user', 'pw')).rejects.toMatchObject({ code: 'forbidden' })
    await expect(state.logout()).resolves.toEqual({ kind: 'failed', code: 'forbidden' })
    expect(port.logouts).toHaveLength(0)
    expect(state.status).toBe('authed')
  })

  test('logout is refused while notes or settings are unsynced and the queue is kept', async () => {
    const { port, notifier, settings, settingsPort, state } = setup({ flush: { pending: 2, failed: 1 } })
    const loading = state.load()
    port.loads[0]?.reply.resolve(session('user-a'))
    await loading

    settings.update({ editor: { fontSize: 18 } })
    const leaving = state.logout()
    await vi.advanceTimersByTimeAsync(0)
    settingsPort.saves[0]?.reject(new BackendError('offline', 0, 'offline'))

    await expect(leaving).resolves.toEqual({ kind: 'blocked', pending: 2, failed: 1, settingsPending: true })
    expect(port.logouts).toHaveLength(0)
    expect(state.status).toBe('authed')
    expect(settings.current.editor.fontSize).toBe(18)
    expect(notifier.toasts).toContainEqual(
      expect.objectContaining({ key: 'session.logout_blocked', params: { count: 4 } }),
    )
  })

  test('logout flushes first, is single-flight, and only then signs out', async () => {
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
    expect(notifier.toasts).toContainEqual(expect.objectContaining({ key: 'session.logout_failed' }))
  })

  test('settings change events coalesce into one reload and stop after unsubscribe', async () => {
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
