import { afterEach, expect, it, vi, type Mock } from 'vitest'
import type { PageSignal, PageSignals, Timers } from '../platform'
import { MemoryTabBus, createMemoryTabBusChannel } from '../backend/tab-bus'
import type { SyncResponse } from '@shared/types'
import { SyncEngine } from './engine'
import type { SyncSocket } from './socket'

const response: SyncResponse = {
  notes: [],
  folders: [],
  tags: [],
  deletions: [],
  cursor: 1,
  full: false,
  facetsFull: false,
  hasMore: false,
  nextKey: null,
  settingsChanged: false,
  serverTime: 1,
}

afterEach(() => vi.useRealTimers())

it('elects one polling leader, does not echo pulled, takes over on focus and releases timers/listeners', async () => {
  vi.useFakeTimers()
  const channel = createMemoryTabBusChannel()
  const timers: Timers = {
    setTimeout: (listener, delay) => Number(setTimeout(listener, delay)),
    clearTimeout: (id) => clearTimeout(id),
    setInterval: (listener, delay) => Number(setInterval(listener, delay)),
    clearInterval: (id) => clearInterval(id),
  }
  const signals = (): PageSignals & { fire(signal: PageSignal): void; count(): number } => {
    const listeners = new Map<PageSignal, Set<() => void>>()
    return {
      isHidden: false,
      isOnline: true,
      on(signal, listener) {
        const group = listeners.get(signal) ?? new Set<() => void>()
        listeners.set(signal, group)
        group.add(listener)
        return () => {
          group.delete(listener)
        }
      },
      fire(signal) {
        for (const listener of listeners.get(signal) ?? []) listener()
      },
      count() {
        return [...listeners.values()].reduce((sum, group) => sum + group.size, 0)
      },
    }
  }
  const pageA = signals(),
    pageB = signals()
  const busA = new MemoryTabBus('user', channel),
    busB = new MemoryTabBus('user', channel)
  const pulled: string[] = []
  busA.subscribe((message) => {
    if (message.type === 'pulled') pulled.push(message.clientId)
  })
  const pullA = vi.fn(async () => response),
    pullB = vi.fn(async () => response)
  const logger = { debug() {}, info() {}, warn() {}, error() {} }
  const engineA = new SyncEngine({
    bus: busA,
    page: pageA,
    timers,
    clock: { now: () => Date.now() },
    logger,
    clientId: 'a',
    pull: pullA,
    replay: async () => {},
    emitChange() {},
  })
  const engineB = new SyncEngine({
    bus: busB,
    page: pageB,
    timers,
    clock: { now: () => Date.now() },
    logger,
    clientId: 'b',
    pull: pullB,
    replay: async () => {},
    emitChange() {},
  })
  try {
    engineA.start()
    engineB.start()
    await vi.advanceTimersByTimeAsync(500)
    pullA.mockClear()
    pullB.mockClear()
    pulled.length = 0
    await vi.advanceTimersByTimeAsync(15_000)
    expect(pullA).not.toHaveBeenCalled()
    expect(pullB).toHaveBeenCalledTimes(1)
    busB.post({ type: 'pulled', cursor: 2, clientId: 'b' })
    await vi.advanceTimersByTimeAsync(500)
    expect(pullA).toHaveBeenCalledTimes(1)
    expect(pulled).toEqual(['b'])
    engineB.stop()
    pageA.fire('focus')
    await vi.advanceTimersByTimeAsync(500)
    pullA.mockClear()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(pullA).toHaveBeenCalledTimes(1)
    engineA.stop()
    expect(pageA.count() + pageB.count()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    engineA.stop()
    engineB.stop()
    busA.close()
    busB.close()
  }
})

it('uses only the elected socket, preserves the earliest pull, heartbeats, and really polls after failure', async () => {
  vi.useFakeTimers()
  const channel = createMemoryTabBusChannel()
  const timers: Timers = {
    setTimeout: (fn, ms) => Number(setTimeout(fn, ms)),
    clearTimeout: (id) => clearTimeout(id),
    setInterval: (fn, ms) => Number(setInterval(fn, ms)),
    clearInterval: (id) => clearInterval(id),
  }
  const page: PageSignals = { isHidden: false, isOnline: true, on: () => () => undefined }
  const sockets: (SyncSocket & { send: Mock; close: Mock })[] = []
  const factory = {
    create() {
      const socket = {
        readyState: 1,
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
        send: vi.fn(),
        close: vi.fn(),
      } as SyncSocket & { send: Mock; close: Mock }
      sockets.push(socket)
      return socket
    },
  }
  const busA = new MemoryTabBus('user', channel),
    busB = new MemoryTabBus('user', channel)
  const pullA = vi.fn(async () => response),
    pullB = vi.fn(async () => response)
  const logger = { debug: vi.fn(), info() {}, warn: vi.fn(), error() {} }
  const engineA = new SyncEngine({
    bus: busA,
    sockets: factory,
    page,
    timers,
    clock: { now: () => Date.now() },
    logger,
    clientId: 'a',
    pull: pullA,
    replay: async () => {},
    emitChange() {},
  })
  const engineB = new SyncEngine({
    bus: busB,
    sockets: factory,
    page,
    timers,
    clock: { now: () => Date.now() },
    logger,
    clientId: 'b',
    pull: pullB,
    replay: async () => {},
    emitChange() {},
  })
  try {
    // Start the higher same-time claim first: the later subscriber must still hear it.
    engineA.updateConfig(true, 5_000)
    engineB.updateConfig(true, 5_000)
    engineB.start()
    engineA.start()
    await vi.advanceTimersByTimeAsync(259)
    expect(sockets).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(sockets).toHaveLength(1)
    const socket = sockets[0]!
    socket.onopen?.(new Event('open'))
    await vi.advanceTimersByTimeAsync(50)
    pullA.mockClear()
    pullB.mockClear()
    socket.onmessage?.(
      new MessageEvent('message', { data: JSON.stringify({ type: 'changed', cursor: 2, origin: 'b' }) }),
    )
    await vi.advanceTimersByTimeAsync(200)
    expect(pullB).not.toHaveBeenCalled()
    socket.onmessage?.(
      new MessageEvent('message', { data: JSON.stringify({ type: 'changed', cursor: 2, origin: null }) }),
    )
    await vi.advanceTimersByTimeAsync(100)
    busA.post({ type: 'local-write', clientId: 'a' })
    await vi.advanceTimersByTimeAsync(80)
    expect(pullB).toHaveBeenCalledTimes(1)
    pullA.mockClear()
    pullB.mockClear()
    await vi.advanceTimersByTimeAsync(25_000)
    expect(socket.send).toHaveBeenCalledWith('{"type":"ping"}')
    expect(pullB).not.toHaveBeenCalled()
    pullA.mockClear()
    await vi.advanceTimersByTimeAsync(50_000)
    expect(socket.close).toHaveBeenCalledTimes(1)
    expect(logger.warn).toHaveBeenCalledWith('sync.socket.fallback', { code: 'request_timeout', delayMs: 800 })
    engineB.updateConfig(false, 5_000)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(pullB).toHaveBeenCalled()
    expect(pullA).not.toHaveBeenCalled()
    engineA.stop()
    engineB.stop()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(sockets).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    engineA.stop()
    engineB.stop()
    busA.close()
    busB.close()
  }
})
