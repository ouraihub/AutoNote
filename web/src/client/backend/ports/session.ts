import type { CallOptions, SessionAccountPort, SessionPort, TotpPort } from '@app/backend'
import type { BackendSession } from '@shared/backend-types'
import type {
  PasswordLoginResult,
  PublicUser,
  TotpLoginResult,
  TotpRecoveryCodesResult,
  TotpSetupInfo,
  TotpStatus,
} from '@shared/types'
import { BackendError } from '@app/backend/errors'
import type { HttpTransport } from '../transport'
import type { TabBus } from '../tab-bus'
import type { LocalDb } from '../../local'

export interface LogoutPending {
  readonly pending: number
  readonly failed: number
  readonly settingsPending?: boolean
}

export interface SessionPortDeps {
  readonly transport: Pick<HttpTransport, 'json'>
  readonly localDb: LocalDb
  readonly bus: TabBus
  readonly clientId: string
  readonly flush?: () => Promise<void>
  readonly pending?: () => Promise<LogoutPending>
  readonly waitForLocalCommit?: () => Promise<void>
}

export class HttpSessionPort implements SessionPort {
  readonly #transport: Pick<HttpTransport, 'json'>
  readonly #localDb: LocalDb
  readonly #flush: (() => Promise<void>) | undefined
  readonly #pending: (() => Promise<LogoutPending>) | undefined
  readonly #waitForLocalCommit: (() => Promise<void>) | undefined
  readonly #account: SessionAccountPort
  #epoch = 0
  #cacheWrites: Promise<void> = Promise.resolve()
  #logout: Promise<void> | null = null

  constructor(deps: SessionPortDeps) {
    this.#transport = deps.transport
    this.#localDb = deps.localDb
    this.#flush = deps.flush
    this.#pending = deps.pending
    this.#waitForLocalCommit = deps.waitForLocalCommit
    this.#account = new HttpSessionAccountPort(
      this.#transport,
      deps.bus,
      () => ++this.#epoch,
      () => this.#epoch,
      this.#saveIfCurrent,
      deps.clientId,
    )
  }

  get account(): SessionAccountPort {
    return this.#account
  }

  async load(options?: CallOptions): Promise<BackendSession> {
    const epoch = ++this.#epoch
    try {
      const result = await this.#transport.json<BackendSession>({ path: '/api/auth/session', signal: options?.signal })
      await this.#saveIfCurrent(epoch, options?.signal, result)
      return result
    } catch (error) {
      if (error instanceof BackendError && error.code === 'offline') {
        const cached = await this.#localDb.loadSession()
        this.#assertCurrent(epoch, options?.signal)
        if (cached) return cached
      }
      throw error
    }
  }

  #assertCurrent(epoch: number, signal?: AbortSignal): void {
    if (epoch !== this.#epoch || signal?.aborted) throw new BackendError('cancelled', 0, 'Session request superseded')
  }

  readonly #saveIfCurrent = (epoch: number, signal: AbortSignal | undefined, result: BackendSession): Promise<void> => {
    const write = this.#cacheWrites
      .catch(() => undefined)
      .then(async () => {
        this.#assertCurrent(epoch, signal)
        if (result.user && result.user.id !== this.#localDb.activeUserId()) await this.#waitForLocalCommit?.()
        this.#assertCurrent(epoch, signal)
        if (result.user) await this.#localDb.saveSession(result)
        else await this.#localDb.clearSession()
        this.#assertCurrent(epoch, signal)
      })
    this.#cacheWrites = write
    return write
  }

  logout(options?: CallOptions): Promise<void> {
    this.#logout ??= this.#runLogout(options).finally(() => {
      this.#logout = null
    })
    return this.#logout
  }

  async #runLogout(options?: CallOptions): Promise<void> {
    const epoch = ++this.#epoch
    await this.#cacheWrites.catch(() => undefined)
    this.#assertCurrent(epoch, options?.signal)
    if (this.#flush) await this.#flush()
    this.#assertCurrent(epoch, options?.signal)
    const pending = this.#pending ? await this.#pending() : await this.#readCurrentPending()
    this.#assertCurrent(epoch, options?.signal)
    if (pending.pending !== 0 || pending.failed !== 0 || pending.settingsPending) {
      throw new BackendError('conflict', 409, 'Local changes are still pending')
    }
    const current = await this.#readCurrentPending()
    this.#assertCurrent(epoch, options?.signal)
    if (current.pending !== 0 || current.failed !== 0) {
      throw new BackendError('conflict', 409, 'Local changes are still pending')
    }
    await this.#transport.json<{ ok: true }>({ method: 'POST', path: '/api/auth/logout', signal: options?.signal })
    this.#assertCurrent(epoch, options?.signal)
    await this.#localDb.clearSession()
  }

  async #readCurrentPending(): Promise<LogoutPending> {
    const items = await this.#localDb.getOutbox()
    return { pending: items.length, failed: items.filter((item) => item.attempts > 0).length }
  }
}

class HttpSessionAccountPort implements SessionAccountPort {
  readonly #transport: Pick<HttpTransport, 'json'>
  readonly #bus: TabBus
  readonly #beginEpoch: () => number
  readonly #currentEpoch: () => number
  readonly #saveIfCurrent: (epoch: number, signal: AbortSignal | undefined, result: BackendSession) => Promise<void>
  readonly #clientId: string
  readonly #totp: HttpTotpPort

  constructor(
    transport: Pick<HttpTransport, 'json'>,
    bus: TabBus,
    beginEpoch: () => number,
    currentEpoch: () => number,
    saveIfCurrent: (epoch: number, signal: AbortSignal | undefined, result: BackendSession) => Promise<void>,
    clientId: string,
  ) {
    this.#transport = transport
    this.#bus = bus
    this.#beginEpoch = beginEpoch
    this.#currentEpoch = currentEpoch
    this.#saveIfCurrent = saveIfCurrent
    this.#clientId = clientId
    this.#totp = new HttpTotpPort(transport)
  }

  get totp(): HttpTotpPort {
    return this.#totp
  }

  async register(
    username: string,
    password: string,
    locale: 'zh-CN' | 'en-US',
    options?: CallOptions,
  ): Promise<BackendSession> {
    const epoch = this.#beginEpoch()
    const result = await this.#transport.json<BackendSession>({
      method: 'POST',
      path: '/api/auth/register',
      body: { username, password, locale },
      signal: options?.signal,
    })
    await this.#saveIfCurrent(epoch, options?.signal, result)
    return result
  }

  async login(username: string, password: string, options?: CallOptions): Promise<PasswordLoginResult> {
    const epoch = this.#beginEpoch()
    const result = await this.#transport.json<PasswordLoginResult>({
      method: 'POST',
      path: '/api/auth/login',
      body: { username, password },
      signal: options?.signal,
    })
    if ('user' in result && result.user) await this.#saveIfCurrent(epoch, options?.signal, result as BackendSession)
    else if (epoch !== this.#currentEpoch() || options?.signal?.aborted)
      throw new BackendError('cancelled', 0, 'Session request superseded')
    return result
  }

  async completeTotpLogin(challengeToken: string, code: string, options?: CallOptions): Promise<TotpLoginResult> {
    const epoch = this.#beginEpoch()
    const result = await this.#transport.json<TotpLoginResult>({
      method: 'POST',
      path: '/api/auth/totp/login',
      body: { challengeToken, code },
      signal: options?.signal,
    })
    await this.#saveIfCurrent(epoch, options?.signal, result)
    return result
  }

  setPassword(body: { currentPassword: string; newPassword: string }, options?: CallOptions): Promise<{ ok: true }> {
    return this.#transport.json({ method: 'POST', path: '/api/auth/password', body, signal: options?.signal })
  }

  async updateProfile(body: { name?: string; avatarUrl?: string }, options?: CallOptions): Promise<PublicUser> {
    const epoch = this.#currentEpoch()
    const user = await this.#transport.json<PublicUser>({
      method: 'PUT',
      path: '/api/auth/profile',
      body,
      signal: options?.signal,
      timeoutMs: 30_000,
    })
    if (epoch === this.#currentEpoch() && !options?.signal?.aborted)
      this.#bus.post({ type: 'profile-changed', clientId: this.#clientId })
    return user
  }

  async updateRegistration(
    enabled: boolean,
    password: string,
    options?: CallOptions,
  ): Promise<{ ok: true; registrationOpen: boolean }> {
    const epoch = this.#currentEpoch()
    const result = await this.#transport.json<{ ok: true; registrationOpen: boolean }>({
      method: 'PUT',
      path: '/api/settings/registration',
      body: { enabled, password },
      signal: options?.signal,
    })
    if (epoch === this.#currentEpoch() && !options?.signal?.aborted)
      this.#bus.post({ type: 'site-changed', clientId: this.#clientId })
    return result
  }
}

class HttpTotpPort implements TotpPort {
  readonly #transport: Pick<HttpTransport, 'json'>
  constructor(transport: Pick<HttpTransport, 'json'>) {
    this.#transport = transport
  }
  status(options?: CallOptions): Promise<TotpStatus> {
    return this.#transport.json({ path: '/api/auth/totp/status', signal: options?.signal })
  }
  startSetup(currentPassword: string, options?: CallOptions): Promise<TotpSetupInfo> {
    return this.#transport.json({
      method: 'POST',
      path: '/api/auth/totp/setup',
      body: { currentPassword },
      signal: options?.signal,
    })
  }
  confirmSetup(
    setupToken: string,
    code: string,
    options?: CallOptions,
  ): Promise<TotpRecoveryCodesResult & { enabledAt: number }> {
    return this.#transport.json({
      method: 'POST',
      path: '/api/auth/totp/setup/confirm',
      body: { setupToken, code },
      signal: options?.signal,
    })
  }
  cancelSetup(setupToken: string, options?: CallOptions): Promise<{ ok: true }> {
    return this.#transport.json({
      method: 'DELETE',
      path: '/api/auth/totp/setup',
      body: { setupToken },
      signal: options?.signal,
    })
  }
  regenerateRecoveryCodes(
    currentPassword: string,
    code: string,
    options?: CallOptions,
  ): Promise<TotpRecoveryCodesResult> {
    return this.#transport.json({
      method: 'POST',
      path: '/api/auth/totp/recovery-codes',
      body: { currentPassword, code },
      signal: options?.signal,
    })
  }
  disable(currentPassword: string, code: string, options?: CallOptions): Promise<{ ok: true }> {
    return this.#transport.json({
      method: 'DELETE',
      path: '/api/auth/totp',
      body: { currentPassword, code },
      signal: options?.signal,
    })
  }
}

export function createHttpSessionPort(deps: SessionPortDeps): SessionPort {
  return new HttpSessionPort(deps)
}
