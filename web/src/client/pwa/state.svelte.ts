import { browserCapabilities } from '../platform'
import type { FlushResult } from '@shared/backend-types'
import type { Logger } from '@app/log/logger'

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>
}

export interface PwaStateDeps {
  readonly flush: () => Promise<FlushResult>
  readonly logger: Logger
}

export type OfflineStatus = 'idle' | 'preparing' | 'ready' | 'error'

export class PwaState {
  installAvailable = $state(false)
  installed = $state(isStandalone())
  installing = $state(false)
  offlineStatus = $state<OfflineStatus>('idle')
  offlineCompleted = $state(0)
  offlineTotal = $state(0)
  updateAvailable = $state(false)
  updating = $state(false)
  updateBlocked = $state(false)
  operationFailed = $state(false)

  #deps: PwaStateDeps
  #prompt: InstallPromptEvent | null = null
  #registration: ServiceWorkerRegistration | null = null
  #started = false
  #disposed = false
  #warmupRequested = false
  #warmupScheduled = false
  #idleHandle: number | undefined
  #timer: number | undefined
  #reloadRequested = false
  #reloaded = false
  #updateRegistration: ServiceWorkerRegistration | null = null
  #updateWorker: ServiceWorker | null = null
  #workerStateListener: (() => void) | null = null
  #cacheFailureLogged = false
  #onUpdateFound = (): void => {
    const worker = this.#registration?.installing
    if (!worker) return
    this.#updateWorker = worker
    this.#workerStateListener = () => {
      if (
        worker.state === 'installed' &&
        browserCapabilities.serviceWorkerContainer.controller
      )
        this.#showUpdate()
    }
    worker.addEventListener('statechange', this.#workerStateListener)
  }
  #onBeforeInstallPrompt = (event: Event): void => {
    event.preventDefault()
    this.#prompt = event as InstallPromptEvent
    this.installAvailable = true
  }
  #onInstalled = (): void => {
    this.#prompt = null
    this.installAvailable = false
    this.installed = true
    this.installing = false
  }
  #onOnline = (): void => {
    this.#scheduleWarmup()
  }
  #onVisibility = (): void => {
    if (document.hidden) return
    void this.#registration?.update().catch((error: unknown) => {
      this.#deps.logger.warn('pwa.update.check_failed', {
        name: error instanceof Error ? error.name : 'unknown',
      })
    })
    this.#scheduleWarmup()
  }
  #onMessage = (event: MessageEvent): void => {
    const data = event.data as {
      type?: string
      status?: OfflineStatus
      completed?: number
      total?: number
    } | null
    if (
      data?.type !== 'OFFLINE_CACHE_STATUS' ||
      !data.status ||
      !['idle', 'preparing', 'ready', 'error'].includes(data.status)
    )
      return
    const completed = Math.max(0, Number(data.completed) || 0)
    this.offlineStatus = data.status
    this.offlineCompleted = completed
    this.offlineTotal = Math.max(completed, Number(data.total) || 0)
    if (data.status === 'error' && !this.#cacheFailureLogged) {
      this.#cacheFailureLogged = true
      this.#deps.logger.warn('pwa.cache.failed', {
        completed: this.offlineCompleted,
      })
    }
  }
  #onControllerChange = (): void => {
    if (!this.#reloadRequested || this.#reloaded) return
    this.#reloaded = true
    location.reload()
  }

  constructor(deps: PwaStateDeps) {
    this.#deps = deps
  }

  start(): void {
    if (this.#started || this.#disposed || typeof window === 'undefined') return
    this.#started = true
    window.addEventListener('beforeinstallprompt', this.#onBeforeInstallPrompt)
    window.addEventListener('appinstalled', this.#onInstalled)
    window.addEventListener('online', this.#onOnline)
    document.addEventListener('visibilitychange', this.#onVisibility)
    if (!import.meta.env.PROD || !browserCapabilities.serviceWorker) return
    browserCapabilities.serviceWorkerContainer.addEventListener(
      'message',
      this.#onMessage,
    )
    browserCapabilities.serviceWorkerContainer.addEventListener(
      'controllerchange',
      this.#onControllerChange,
    )
    void this.#register()
  }

  requestOfflineWarmup(): void {
    this.#warmupRequested = true
    this.#scheduleWarmup()
  }

  async install(): Promise<void> {
    const prompt = this.#prompt
    if (!prompt || this.#disposed) return
    this.#prompt = null
    this.installAvailable = false
    this.installing = true
    try {
      await prompt.prompt()
      if ((await prompt.userChoice).outcome === 'accepted')
        this.installed = true
    } catch (error: unknown) {
      this.operationFailed = true
      this.#deps.logger.warn('pwa.install.failed', {
        name: error instanceof Error ? error.name : 'unknown',
      })
    } finally {
      this.installing = false
    }
  }

  async applyUpdate(): Promise<void> {
    const worker = this.#registration?.waiting
    if (!worker || this.updating || this.#disposed) return
    this.updating = true
    this.updateBlocked = false
    this.operationFailed = false
    try {
      const result = await this.#deps.flush()
      if (
        this.#disposed ||
        this.#registration?.waiting !== worker ||
        result.failed > 0
      ) {
        this.updateBlocked = true
        if (result.failed > 0)
          this.#deps.logger.warn('pwa.update.blocked', {
            failed: result.failed,
          })
        return
      }
      this.#reloadRequested = true
      worker.postMessage({ type: 'SKIP_WAITING' })
    } catch (error: unknown) {
      this.updateBlocked = true
      this.operationFailed = true
      this.#deps.logger.warn('pwa.update.flush_failed', {
        name: error instanceof Error ? error.name : 'unknown',
      })
    } finally {
      this.updating = false
    }
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#prompt = null
    if (!this.#started) return
    window.removeEventListener(
      'beforeinstallprompt',
      this.#onBeforeInstallPrompt,
    )
    window.removeEventListener('appinstalled', this.#onInstalled)
    window.removeEventListener('online', this.#onOnline)
    document.removeEventListener('visibilitychange', this.#onVisibility)
    if (browserCapabilities.serviceWorker) {
      browserCapabilities.serviceWorkerContainer.removeEventListener(
        'message',
        this.#onMessage,
      )
      browserCapabilities.serviceWorkerContainer.removeEventListener(
        'controllerchange',
        this.#onControllerChange,
      )
    }
    this.#updateRegistration?.removeEventListener(
      'updatefound',
      this.#onUpdateFound,
    )
    if (this.#updateWorker && this.#workerStateListener)
      this.#updateWorker.removeEventListener(
        'statechange',
        this.#workerStateListener,
      )
    this.#updateRegistration = null
    this.#updateWorker = null
    this.#workerStateListener = null
    if (this.#idleHandle !== undefined) {
      const idle = window as Window & {
        cancelIdleCallback?: (handle: number) => void
      }
      idle.cancelIdleCallback?.(this.#idleHandle)
      this.#idleHandle = undefined
    }
    if (this.#timer !== undefined) window.clearTimeout(this.#timer)
    this.#timer = undefined
  }

  async #register(): Promise<void> {
    try {
      const wasControlled = Boolean(
        browserCapabilities.serviceWorkerContainer.controller,
      )
      const registration =
        await browserCapabilities.serviceWorkerContainer.register('/sw.js', {
          scope: '/',
          updateViaCache: 'none',
        })
      if (this.#disposed) return
      this.#registration = registration
      if (registration.waiting && wasControlled) this.#showUpdate()
      this.#updateRegistration = registration
      registration.addEventListener('updatefound', this.#onUpdateFound)
      const ready = await browserCapabilities.serviceWorkerContainer.ready
      if (this.#disposed) return
      this.#registration = ready
      ready.active?.postMessage({ type: 'GET_OFFLINE_CACHE_STATUS' })
      this.#scheduleWarmup()
    } catch (error: unknown) {
      this.#deps.logger.warn('pwa.registration.failed', {
        name: error instanceof Error ? error.name : 'unknown',
      })
    }
  }

  #showUpdate(): void {
    this.updateAvailable = true
  }

  #scheduleWarmup(): void {
    if (
      !this.#warmupRequested ||
      this.#warmupScheduled ||
      !browserCapabilities.online ||
      !this.#registration?.active ||
      this.#disposed
    )
      return
    this.#warmupScheduled = true
    const run = (): void => {
      this.#warmupScheduled = false
      this.#idleHandle = undefined
      if (this.#warmupRequested && browserCapabilities.online)
        this.#registration?.active?.postMessage({ type: 'WARM_OFFLINE_CACHE' })
    }
    const idle = window as Window & {
      requestIdleCallback?: (
        callback: () => void,
        options?: { timeout: number },
      ) => number
    }
    if (idle.requestIdleCallback)
      this.#idleHandle = idle.requestIdleCallback(run, { timeout: 3_000 })
    else this.#timer = window.setTimeout(run, 1_200)
  }
}

function isStandalone(): boolean {
  if (typeof window === 'undefined') return false
  return (
    (typeof window.matchMedia === 'function' &&
      window.matchMedia('(display-mode: standalone)').matches) ||
    (globalThis.navigator as Navigator & { standalone?: boolean })
      .standalone === true
  )
}
