class ResizeObserverStub {
  observe(): void {}

  unobserve(): void {}

  disconnect(): void {}
}

globalThis.ResizeObserver = ResizeObserverStub
// jsdom lacks scrollIntoView; bits-ui Command scrolls the highlighted item.
Element.prototype.scrollIntoView = () => undefined

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
