import { BackendError, type ChangeEvent } from '@app/backend'
import type { Clock } from '@app/platform/clock'
import type { Logger } from '@app/log/logger'
import type { SyncResponse } from '@shared/types'
import type { TabBus, TabMessage } from '../backend/tab-bus'
import type { PageSignals, Timers } from '../platform'
import { compareClaims, type LeaderClaim } from './leader'
import type { SocketFactory, SyncSocket } from './socket'

export interface SyncEngineDeps {
  bus: TabBus
  sockets?: SocketFactory | null
  page: PageSignals
  timers: Timers
  clock: Clock
  logger: Logger
  clientId: string
  pull(force: boolean, signal: AbortSignal): Promise<SyncResponse>
  replay(signal: AbortSignal): Promise<unknown>
  emitChange(event: ChangeEvent): void
  onUnauthenticated?(): void
}

export class SyncEngine {
  readonly #deps: SyncEngineDeps
  #controller: AbortController | null = null
  #listeners: (() => void)[] = []
  #poll: number | null = null
  #claimTimer: number | null = null
  #pullTimer: number | null = null
  #settingsTimer: number | null = null
  #settingsDueAt = 0
  #dueAt = 0
  #announce = false
  #claim: LeaderClaim | null = null
  #leader = false
  #interval = 15_000
  #cursor = 0
  #paused = false
  #running: Promise<void> | null = null
  #force = false
  #again = false
  #realtime = false
  #socket: SyncSocket | null = null
  #heartbeat: number | null = null
  #reconnect: number | null = null
  #handshake: number | null = null
  #failures = 0
  #lastPong = 0
  #lastPull = 0
  #invalidMessages = 0

  constructor(deps: SyncEngineDeps) {
    this.#deps = deps
  }

  start(cursor = 0): void {
    if (this.#controller) return
    this.#controller = new AbortController()
    const controller = this.#controller
    this.#cursor = cursor
    this.#paused = false
    const { page, bus } = this.#deps
    this.#listeners = [
      bus.subscribe((message) => this.#receive(message)),
      page.on('visible', () => {
        this.#claimLeadership()
        this.#schedule(120)
      }),
      page.on('focus', () => {
        this.#claimLeadership()
        this.#schedule(200)
      }),
      page.on('online', () => {
        this.#failures = 0
        this.#deps.emitChange({ kind: 'connectivity', online: true })
        this.#schedule(50)
        this.#disconnect()
        this.#connect()
      }),
      page.on('offline', () => {
        this.#disconnect()
        this.#deps.emitChange({ kind: 'connectivity', online: false })
      }),
      page.on('pagehide', () => {
        void this.#deps.replay(controller.signal).catch((error: unknown) => {
          if (this.#controller === controller) this.#failure(error)
        })
      }),
    ]
    this.#claimLeadership()
    this.#startPolling()
    this.#schedule(50)
  }

  updateConfig(realtimeEnabled: boolean, pollIntervalMs: number): void {
    const interval = Number.isFinite(pollIntervalMs)
      ? Math.max(5_000, pollIntervalMs)
      : 15_000
    if (interval !== this.#interval) {
      this.#interval = interval
      if (this.#controller) this.#startPolling()
    }
    this.#realtime = realtimeEnabled && this.#deps.sockets != null
    if (this.#realtime) this.#connect()
    else this.#disconnect()
  }

  resume(): void {
    if (!this.#paused) return
    this.#paused = false
    this.#claimLeadership()
    this.#schedule(50)
  }

  pause(): void {
    this.#paused = true
    this.#disconnect()
  }

  pullNow(options: { force?: boolean } = {}): Promise<void> {
    const controller = this.#controller
    if (!controller || controller.signal.aborted || this.#paused)
      return Promise.reject(
        new BackendError(
          this.#paused ? 'unauthenticated' : 'cancelled',
          0,
          'Sync is stopped',
        ),
      )
    this.#force ||= options.force ?? false
    if (this.#running) {
      this.#again = true
      return this.#running
    }
    const current = () =>
      this.#controller === controller && !controller.signal.aborted
    let pulling = true
    const running = (async () => {
      do {
        this.#again = false
        const force = this.#force
        this.#force = false
        const announce = this.#announce
        this.#announce = false
        const before = this.#cursor
        pulling = true
        const result = await this.#deps.pull(force, controller.signal)
        if (!current()) return
        this.#cursor = result.cursor
        this.#lastPull = this.#deps.clock.now()
        this.#deps.emitChange({ kind: 'connectivity', online: true })
        if (announce && result.cursor > before)
          this.#deps.bus.post({
            type: 'pulled',
            cursor: result.cursor,
            clientId: this.#deps.clientId,
          })
        pulling = false
        await this.#deps.replay(controller.signal)
      } while (current() && (this.#force || this.#again))
    })()
      .catch((error: unknown) => {
        if (current() && pulling) this.#failure(error)
        throw error
      })
      .finally(() => {
        if (this.#running === running) this.#running = null
      })
    this.#running = running
    return running
  }

  stop(): void {
    this.#controller?.abort()
    this.#controller = null
    for (const unsubscribe of this.#listeners) unsubscribe()
    this.#listeners = []
    const { timers } = this.#deps
    if (this.#poll !== null) timers.clearInterval(this.#poll)
    for (const timer of [
      this.#claimTimer,
      this.#pullTimer,
      this.#settingsTimer,
    ])
      if (timer !== null) timers.clearTimeout(timer)
    this.#poll = this.#claimTimer = this.#pullTimer = this.#settingsTimer = null
    this.#disconnect()
    this.#leader = false
    this.#claim = null
    this.#dueAt = this.#settingsDueAt = this.#lastPull = 0
    this.#announce = this.#force = this.#again = false
    this.#running = null
    this.#failures = 0
  }

  #claimLeadership(): void {
    if (!this.#controller || this.#deps.page.isHidden || this.#paused) return
    const claim = {
      type: 'claim-leader' as const,
      clientId: this.#deps.clientId,
      at: this.#deps.clock.now(),
    }
    this.#claim = claim
    this.#deps.bus.post(claim)
    if (this.#claimTimer !== null)
      this.#deps.timers.clearTimeout(this.#claimTimer)
    this.#claimTimer = this.#deps.timers.setTimeout(() => {
      this.#claimTimer = null
      this.#leader =
        this.#claim?.clientId === claim.clientId && this.#claim.at === claim.at
      if (this.#leader) this.#connect()
      else this.#disconnect()
    }, 260)
  }

  #connect(): void {
    if (
      !this.#controller ||
      this.#paused ||
      !this.#leader ||
      !this.#realtime ||
      !this.#deps.page.isOnline ||
      this.#socket ||
      this.#reconnect !== null
    )
      return
    const factory = this.#deps.sockets
    if (!factory) return
    const controller = this.#controller
    try {
      const socket = factory.create()
      this.#socket = socket
      this.#handshake = this.#deps.timers.setTimeout(() => {
        if (this.#socket === socket) this.#socketFailure('request_timeout')
      }, 30_000)
      const current = () =>
        this.#controller === controller && this.#socket === socket
      socket.onopen = () => {
        if (!current()) return
        if (this.#handshake !== null)
          this.#deps.timers.clearTimeout(this.#handshake)
        this.#handshake = null
        this.#failures = 0
        this.#lastPong = this.#deps.clock.now()
        this.#heartbeat = this.#deps.timers.setInterval(() => {
          if (!current() || socket.readyState !== 1) return
          if (this.#deps.clock.now() - this.#lastPong >= 75_000) {
            this.#socketFailure('request_timeout')
            return
          }
          if (this.#invalidMessages) {
            this.#deps.logger.debug('sync.socket.invalid', {
              count: this.#invalidMessages,
            })
            this.#invalidMessages = 0
          }
          try {
            socket.send('{"type":"ping"}')
          } catch {
            this.#socketFailure('offline')
          }
        }, 25_000)
        this.#schedule(50)
      }
      socket.onmessage = ({ data }) => {
        if (!current()) return
        let value: unknown
        try {
          value = typeof data === 'string' ? JSON.parse(data) : null
        } catch {
          this.#invalidMessages++
          return
        }
        if (!value || typeof value !== 'object') {
          this.#invalidMessages++
          return
        }
        if (
          'type' in value &&
          value.type === 'pong' &&
          'serverTime' in value &&
          typeof value.serverTime === 'number' &&
          Number.isFinite(value.serverTime)
        ) {
          this.#lastPong = this.#deps.clock.now()
        } else if (
          'type' in value &&
          value.type === 'changed' &&
          'cursor' in value &&
          typeof value.cursor === 'number' &&
          Number.isSafeInteger(value.cursor) &&
          value.cursor >= 0 &&
          'origin' in value &&
          (value.origin === null || typeof value.origin === 'string')
        ) {
          if (
            value.origin !== this.#deps.clientId &&
            value.cursor > this.#cursor
          )
            this.#schedule(180)
        } else this.#invalidMessages++
      }
      socket.onclose = socket.onerror = () => {
        if (current()) this.#socketFailure('offline')
      }
    } catch {
      this.#socketFailure('offline')
    }
  }

  #disconnect(): void {
    const socket = this.#socket
    this.#socket = null
    if (socket) {
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null
      socket.close()
    }
    if (this.#heartbeat !== null)
      this.#deps.timers.clearInterval(this.#heartbeat)
    if (this.#handshake !== null)
      this.#deps.timers.clearTimeout(this.#handshake)
    this.#handshake = null
    if (this.#reconnect !== null)
      this.#deps.timers.clearTimeout(this.#reconnect)
    this.#heartbeat = this.#reconnect = null
    this.#invalidMessages = 0
  }

  #socketFailure(code: string): void {
    this.#disconnect()
    if (
      !this.#controller ||
      this.#paused ||
      !this.#leader ||
      !this.#realtime ||
      !this.#deps.page.isOnline
    )
      return
    const delayMs = Math.min(30_000, 800 * 2 ** Math.min(this.#failures++, 16))
    this.#deps.logger.warn('sync.socket.fallback', { code, delayMs })
    this.#reconnect = this.#deps.timers.setTimeout(() => {
      this.#reconnect = null
      this.#connect()
    }, delayMs)
  }

  #startPolling(): void {
    if (this.#poll !== null) this.#deps.timers.clearInterval(this.#poll)
    this.#poll = this.#deps.timers.setInterval(() => {
      if (
        this.#deps.page.isHidden ||
        !this.#deps.page.isOnline ||
        !this.#leader
      )
        return
      const now = this.#deps.clock.now()
      if (
        this.#socket?.readyState === 1 &&
        now - this.#lastPong < 75_000 &&
        now - this.#lastPull < 300_000
      )
        return
      this.#schedule(0)
    }, this.#interval)
  }

  #schedule(delay: number, announce = true): void {
    if (!this.#controller || this.#paused) return
    this.#announce ||= announce
    const due = this.#deps.clock.now() + delay
    if (this.#pullTimer !== null && this.#dueAt <= due) return
    if (this.#pullTimer !== null)
      this.#deps.timers.clearTimeout(this.#pullTimer)
    this.#dueAt = due
    this.#pullTimer = this.#deps.timers.setTimeout(() => {
      this.#pullTimer = null
      this.#dueAt = 0
      void this.pullNow().catch(() => undefined) // Failure is handled once at the engine boundary.
    }, delay)
  }

  #receive(message: TabMessage): void {
    const own = message.clientId === this.#deps.clientId
    if (message.type === 'claim-leader') {
      if (own || !message.clientId || !Number.isFinite(message.at)) return
      if (!this.#claim || compareClaims(message, this.#claim) > 0) {
        this.#claim = message
        this.#leader = false
        this.#disconnect()
      } else if (this.#claim.clientId === this.#deps.clientId)
        this.#deps.bus.post({ type: 'claim-leader', ...this.#claim })
    } else if (message.type === 'pulled') {
      if (
        !own &&
        Number.isSafeInteger(message.cursor) &&
        message.cursor > this.#cursor
      )
        this.#schedule(150, false)
    } else if (message.type === 'local-write') this.#schedule(own ? 700 : 400)
    else if (
      message.type === 'settings-changed' ||
      message.type === 'profile-changed' ||
      message.type === 'site-changed'
    ) {
      const delay = message.type === 'profile-changed' ? 300 : 400
      const due = this.#deps.clock.now() + delay
      if (!own && (this.#settingsTimer === null || due < this.#settingsDueAt)) {
        if (this.#settingsTimer !== null)
          this.#deps.timers.clearTimeout(this.#settingsTimer)
        this.#settingsDueAt = due
        this.#settingsTimer = this.#deps.timers.setTimeout(() => {
          this.#settingsTimer = null
          this.#settingsDueAt = 0
          this.#deps.emitChange({ kind: 'settings' })
        }, delay)
      }
      if (message.type !== 'site-changed')
        this.#schedule(own ? 700 : delay, false)
    }
  }

  #failure(error: unknown): void {
    if (error instanceof BackendError && error.code === 'cancelled') return
    if (error instanceof BackendError && error.code === 'offline')
      this.#deps.emitChange({ kind: 'connectivity', online: false })
    if (error instanceof BackendError && error.code === 'unauthenticated') {
      this.#paused = true
      this.#disconnect()
      this.#deps.onUnauthenticated?.()
      this.#deps.emitChange({ kind: 'settings' })
    }
    this.#deps.logger.warn('sync.pull.failed', {
      code: error instanceof BackendError ? error.code : 'internal',
    })
  }
}
