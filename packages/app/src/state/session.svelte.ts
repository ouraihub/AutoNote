import type {
  BackendSession,
  ErrorCode,
  FlushResult,
} from '@shared/backend-types'
import type {
  AppLocale,
  PublicUser,
  TotpLoginChallenge,
  TotpLoginResult,
} from '@shared/types'
import {
  BackendError,
  isBackendError,
  type CallOptions,
  type ChangeFeed,
  type SessionAccountPort,
  type SessionPort,
  type Unsubscribe,
} from '@app/backend'
import type { Logger } from '@app/log/logger'
import type { Clock, Notifier } from '@app/platform'
import type { SettingsState } from './settings.svelte'

export type SessionStatus = 'loading' | 'anonymous' | 'authed'
export type AuthOutcome = 'authed' | 'challenge' | 'rejected' | 'superseded'
export type SessionSite = BackendSession['site']

export type LogoutResult =
  | { kind: 'signed-out' }
  | {
      kind: 'blocked'
      pending: number
      failed: number
      settingsPending: boolean
    }
  | { kind: 'failed'; code: ErrorCode }

export interface SessionStateOptions {
  port: SessionPort
  settings: SettingsState
  notifier: Notifier
  logger: Logger
  clock: Clock
  flushNotes(): Promise<FlushResult>
}

interface SessionRequest {
  readonly sequence: number
  readonly signal: AbortSignal
}

export class SessionState {
  #status = $state<SessionStatus>('loading')
  #user = $state.raw<PublicUser | null>(null)
  #site = $state.raw<SessionSite | null>(null)
  #authError = $state.raw<ErrorCode | null>(null)
  #challenge = $state.raw<TotpLoginChallenge | null>(null)
  #epoch = $state(0)
  #busy = $state(false)

  #port: SessionPort
  #settings: SettingsState
  #notifier: Notifier
  #logger: Logger
  #clock: Clock
  #flushNotes: () => Promise<FlushResult>
  #owner: string | null | undefined = undefined
  #sequence = 0
  #request: AbortController | null = null
  #epochController = new AbortController()
  #logout: Promise<LogoutResult> | null = null
  #refreshQueued = false

  constructor(options: SessionStateOptions) {
    this.#port = options.port
    this.#settings = options.settings
    this.#notifier = options.notifier
    this.#logger = options.logger
    this.#clock = options.clock
    this.#flushNotes = options.flushNotes
  }

  get status(): SessionStatus {
    return this.#status
  }

  get user(): PublicUser | null {
    return this.#user
  }

  get site(): SessionSite | null {
    return this.#site
  }

  get authError(): ErrorCode | null {
    return this.#authError
  }

  get challenge(): TotpLoginChallenge | null {
    return this.#challenge
  }

  get epoch(): number {
    return this.#epoch
  }

  get epochSignal(): AbortSignal {
    return this.#epochController.signal
  }

  get busy(): boolean {
    return this.#busy
  }

  get canSignIn(): boolean {
    return this.#port.account !== undefined
  }

  async load(options?: CallOptions): Promise<void> {
    const request = this.#begin(options, false)
    try {
      const session = await this.#port.load({ signal: request.signal })
      if (request.sequence !== this.#sequence) return
      this.#adopt(session)
    } catch (error) {
      if (!isBackendError(error)) throw error
      if (request.sequence !== this.#sequence || error.code === 'cancelled')
        return
      this.#logger.warn('session.load.failed', { code: error.code })
      if (error.code === 'unauthenticated' || this.#user === null)
        this.#becomeAnonymous(error.code)
      else this.#authError = error.code
    } finally {
      this.#finish(request)
    }
  }

  async login(
    username: string,
    password: string,
    options?: CallOptions,
  ): Promise<AuthOutcome> {
    const account = this.#account()
    const request = this.#begin(options, true)
    try {
      const result = await account.login(username, password, {
        signal: request.signal,
      })
      if (request.sequence !== this.#sequence) return 'superseded'
      if ('twoFactorRequired' in result) {
        this.#challenge = result
        this.#authError = null
        return 'challenge'
      }
      this.#adopt(result)
      return 'authed'
    } catch (error) {
      return this.#rejectAuth(request, error)
    } finally {
      this.#finish(request)
    }
  }

  async completeTotp(
    code: string,
    options?: CallOptions,
  ): Promise<AuthOutcome> {
    const account = this.#account()
    const challenge = this.#challenge
    if (!challenge || this.#clock.now() >= challenge.expiresAt) {
      this.#challenge = null
      this.#authError = 'two_factor_challenge_expired'
      return 'rejected'
    }
    const request = this.#begin(options, true)
    try {
      const result = await account.completeTotpLogin(
        challenge.challengeToken,
        code,
        { signal: request.signal },
      )
      if (request.sequence !== this.#sequence) return 'superseded'
      this.#adopt(result)
      if (result.recoveryCodeUsed) this.#notifyRecoveryCodeUsed(result)
      return 'authed'
    } catch (error) {
      return this.#rejectAuth(request, error)
    } finally {
      this.#finish(request)
    }
  }

  async register(
    username: string,
    password: string,
    locale: AppLocale,
    options?: CallOptions,
  ): Promise<AuthOutcome> {
    const account = this.#account()
    const request = this.#begin(options, true)
    try {
      const session = await account.register(username, password, locale, {
        signal: request.signal,
      })
      if (request.sequence !== this.#sequence) return 'superseded'
      this.#adopt(session)
      return 'authed'
    } catch (error) {
      return this.#rejectAuth(request, error)
    } finally {
      this.#finish(request)
    }
  }

  cancelChallenge(): void {
    this.#cancelRequest()
    this.#challenge = null
    this.#authError = null
  }

  logout(): Promise<LogoutResult> {
    this.#logout ??= this.#runLogout().finally(() => {
      this.#logout = null
    })
    return this.#logout
  }

  watch(feed: ChangeFeed): Unsubscribe {
    return feed.subscribe((event) => {
      if (event.kind !== 'settings' || this.#refreshQueued) return
      this.#refreshQueued = true
      queueMicrotask(() => {
        this.#refreshQueued = false
        if (this.#busy || this.#status !== 'authed') return
        this.load().catch((error: unknown) => {
          this.#logger.error('session.refresh.failed', {
            name: error instanceof Error ? error.name : 'unknown',
          })
        })
      })
    })
  }

  dispose(): void {
    this.#cancelRequest()
    this.#epochController.abort()
  }

  async #runLogout(): Promise<LogoutResult> {
    if (this.#port.account === undefined)
      return { kind: 'failed', code: 'forbidden' }
    let settingsSaved: boolean
    let notes: FlushResult
    try {
      settingsSaved = await this.#settings.flush()
      notes = await this.#flushNotes()
    } catch (error) {
      if (!isBackendError(error)) throw error
      return this.#logoutFailed(error.code)
    }
    const settingsPending = !settingsSaved
    const count = notes.pending + notes.failed + (settingsPending ? 1 : 0)
    if (count > 0) {
      this.#logger.info('session.logout.blocked', {
        pending: notes.pending,
        failed: notes.failed,
        settingsPending,
      })
      this.#notifier.toast({
        id: 'session-logout-blocked',
        key: 'session.logout_blocked',
        params: { count },
        tone: 'warning',
        action: {
          labelKey: 'session.sync_and_sign_out',
          onInvoke: async () => {
            await this.logout()
          },
        },
      })
      return {
        kind: 'blocked',
        pending: notes.pending,
        failed: notes.failed,
        settingsPending,
      }
    }
    try {
      await this.#port.logout()
    } catch (error) {
      if (!isBackendError(error)) throw error
      return this.#logoutFailed(error.code)
    }
    this.#logger.info('session.logout.completed')
    this.#becomeAnonymous(null)
    return { kind: 'signed-out' }
  }

  #logoutFailed(code: ErrorCode): LogoutResult {
    this.#logger.warn('session.logout.failed', { code })
    this.#notifier.toast({
      id: 'session-logout-failed',
      key: 'session.logout_failed',
      tone: 'error',
    })
    return { kind: 'failed', code }
  }

  #account(): SessionAccountPort {
    const account = this.#port.account
    if (!account)
      throw new BackendError('forbidden', 0, 'Accounts are not available')
    return account
  }

  #begin(options: CallOptions | undefined, busy: boolean): SessionRequest {
    this.#request?.abort()
    const controller = new AbortController()
    this.#request = controller
    this.#busy = busy
    const signal = options?.signal
      ? AbortSignal.any([controller.signal, options.signal])
      : controller.signal
    return { sequence: ++this.#sequence, signal }
  }

  #finish(request: SessionRequest): void {
    if (request.sequence !== this.#sequence) return
    this.#request = null
    this.#busy = false
  }

  #cancelRequest(): void {
    this.#sequence++
    this.#request?.abort()
    this.#request = null
    this.#busy = false
  }

  #rejectAuth(request: SessionRequest, error: unknown): AuthOutcome {
    if (!isBackendError(error)) throw error
    if (request.sequence !== this.#sequence || error.code === 'cancelled')
      return 'superseded'
    if (error.code === 'two_factor_challenge_expired') this.#challenge = null
    this.#authError = error.code
    return 'rejected'
  }

  #adopt(session: BackendSession): void {
    const owner = session.user?.id ?? null
    this.#switchOwner(owner)
    this.#settings.adopt(owner, session.settings)
    this.#user = session.user
    this.#site = session.site
    this.#status = session.user ? 'authed' : 'anonymous'
    this.#authError = null
    this.#challenge = null
  }

  #becomeAnonymous(code: ErrorCode | null): void {
    this.#cancelRequest()
    this.#switchOwner(null)
    this.#settings.adopt(null, null)
    this.#user = null
    this.#status = 'anonymous'
    this.#challenge = null
    this.#authError = code
  }

  #switchOwner(owner: string | null): void {
    if (owner === this.#owner) return
    this.#owner = owner
    this.#epoch++
    this.#epochController.abort()
    this.#epochController = new AbortController()
  }

  #notifyRecoveryCodeUsed(result: TotpLoginResult): void {
    const remaining = result.recoveryCodesRemaining ?? 0
    this.#notifier.toast({
      id: 'auth-recovery-code-used',
      key: 'auth.recovery_codes_remaining',
      params: { count: remaining },
      tone: remaining > 2 ? 'success' : 'error',
    })
  }
}
