/// <reference types="vitest/jsdom" />

Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: jsdom.window.localStorage })

class ResizeObserverStub {
  observe(): void {}

  unobserve(): void {}

  disconnect(): void {}
}

globalThis.ResizeObserver = ResizeObserverStub

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => {
    const minWidth = /^\(min-width: (\d+)px\)$/.exec(query)?.[1]
    return {
      matches: minWidth !== undefined && Number(minWidth) <= 1280,
      addEventListener: () => {},
      removeEventListener: () => {},
    }
  },
})
