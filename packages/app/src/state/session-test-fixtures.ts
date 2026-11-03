import { vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/constants'
import type { BackendSession, FlushResult } from '@shared/backend-types'
import type {
  PasswordLoginResult,
  PublicUser,
  SessionInfo,
  TotpLoginResult,
  UserSettings,
} from '@shared/types'
import type {
  SessionAccountPort,
  SessionPort,
  SettingsPort,
} from '@app/backend'
import type { Logger } from '@app/log/logger'
import type { NotificationRequest, Notifier } from '@app/platform'
import { SessionState } from './session.svelte'
import { SettingsState } from './settings.svelte'
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

function call<T>(
  calls: Call<T>[],
  signal: AbortSignal | undefined,
): Promise<T> {
  const reply = deferred<T>()
  calls.push({ reply, signal })
  return reply.promise
}

function unexpected(): never {
  throw new Error('Unexpected port call')
}

class FakeAccountPort implements SessionAccountPort {
  readonly logins: Call<PasswordLoginResult>[] = []
  readonly totpLogins: (Call<TotpLoginResult> & {
    token: string
    code: string
  })[] = []
  readonly registrations: Call<BackendSession>[] = []
  readonly totp = {
    status: unexpected,
    startSetup: unexpected,
    confirmSetup: unexpected,
    cancelSetup: unexpected,
    regenerateRecoveryCodes: unexpected,
    disable: unexpected,
  }

  register(
    _username: string,
    _password: string,
    _locale: string,
    options?: { signal?: AbortSignal },
  ) {
    return call(this.registrations, options?.signal)
  }

  login(
    _username: string,
    _password: string,
    options?: { signal?: AbortSignal },
  ) {
    return call(this.logins, options?.signal)
  }

  completeTotpLogin(
    token: string,
    code: string,
    options?: { signal?: AbortSignal },
  ) {
    const reply = deferred<TotpLoginResult>()
    this.totpLogins.push({ reply, signal: options?.signal, token, code })
    return reply.promise
  }

  setPassword = unexpected
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

  updateProfile = unexpected

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
  return {
    id,
    login: id,
    username: id,
    name: id,
    avatarUrl: '',
    role: 'member',
    createdAt: 0,
  }
}

export function session(
  id: string | null,
  settings: UserSettings | null = DEFAULT_SETTINGS,
): SessionInfo {
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

export function setup(
  options: { accounts?: boolean; flush?: FlushResult } = {},
) {
  const account = options.accounts === false ? undefined : new FakeAccountPort()
  const port = new FakeSessionPort(account)
  const settingsPort = new FakeSettingsPort()
  const notifier = new RecordingNotifier()
  const settings = new SettingsState({
    port: settingsPort,
    notifier,
    logger: silentLogger,
  })
  let now = 1_000
  const flushNotes = vi.fn(
    async (): Promise<FlushResult> =>
      options.flush ?? { pending: 0, failed: 0 },
  )
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
