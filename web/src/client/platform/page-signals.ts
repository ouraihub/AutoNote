export type PageSignal = 'visible' | 'hidden' | 'focus' | 'online' | 'offline' | 'pagehide'

export interface PageSignals {
  readonly isHidden: boolean
  readonly isOnline: boolean
  on(signal: PageSignal, listener: () => void): () => void
}

const EVENT_BY_SIGNAL: Readonly<Record<PageSignal, string>> = {
  visible: 'visibilitychange',
  hidden: 'visibilitychange',
  focus: 'focus',
  online: 'online',
  offline: 'offline',
  pagehide: 'pagehide',
}

export const browserPageSignals: PageSignals = {
  get isHidden(): boolean {
    return document.hidden
  },
  get isOnline(): boolean {
    return navigator.onLine
  },
  on(signal, listener): () => void {
    const event = EVENT_BY_SIGNAL[signal]
    const guardedListener = () => {
      if (signal === 'visible' && document.hidden) return
      if (signal === 'hidden' && !document.hidden) return
      listener()
    }
    window.addEventListener(event, guardedListener)
    return () => window.removeEventListener(event, guardedListener)
  },
}
export const browserCapabilities = {
  get serviceWorker(): boolean {
    return 'serviceWorker' in globalThis.navigator
  },
  get locks(): boolean {
    return 'locks' in globalThis.navigator
  },
  get online(): boolean {
    return globalThis.navigator.onLine
  },
  get serviceWorkerContainer(): ServiceWorkerContainer {
    return globalThis.navigator.serviceWorker
  },
}
