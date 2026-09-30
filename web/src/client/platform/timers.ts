export interface Timers {
  setTimeout(listener: () => void, delayMs: number): number
  clearTimeout(id: number): void
  setInterval(listener: () => void, delayMs: number): number
  clearInterval(id: number): void
}

export const browserTimers: Timers = {
  setTimeout: (listener, delayMs) => window.setTimeout(listener, delayMs),
  clearTimeout: (id) => window.clearTimeout(id),
  setInterval: (listener, delayMs) => window.setInterval(listener, delayMs),
  clearInterval: (id) => window.clearInterval(id),
}
