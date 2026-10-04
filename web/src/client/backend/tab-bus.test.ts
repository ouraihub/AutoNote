import { expect, test } from 'vitest'
import { BroadcastTabBus, createMemoryTabBusChannel, MemoryTabBus } from './tab-bus'
test('BroadcastTabBus 可注入 channel 并过滤伪造消息', () => {
  let handler: ((event: MessageEvent<unknown>) => void) | null = null
  let posted: unknown
  let closed = false
  const bus = new BroadcastTabBus('user-a', () => ({
    get onmessage() {
      return handler
    },
    set onmessage(next: ((event: MessageEvent<unknown>) => void) | null) {
      handler = next
    },
    postMessage(message: unknown) {
      posted = message
    },
    close() {
      closed = true
    },
  }))
  const received: unknown[] = []
  bus.subscribe((message) => received.push(message))
  bus.post({ type: 'profile-changed', clientId: 'client-a' })
  expect(posted).toEqual({ type: 'profile-changed', clientId: 'client-a', userId: 'user-a' })
  const dispatch = handler as ((event: MessageEvent<unknown>) => void) | null
  dispatch?.({ data: { type: 'profile-changed', clientId: 'other', userId: 'user-b' } } as MessageEvent<unknown>)
  dispatch?.({ data: { type: 'profile-changed', clientId: 'same', userId: 'user-a' } } as MessageEvent<unknown>)
  expect(received).toEqual([{ type: 'profile-changed', clientId: 'same', userId: 'user-a' }])
  bus.close()
  expect(closed).toBe(true)
})

test('MemoryTabBus 只投递同用户并支持取消订阅和关闭', () => {
  const channel = createMemoryTabBusChannel()
  const first = new MemoryTabBus('user-a', channel)
  const second = new MemoryTabBus('user-a', channel)
  const other = new MemoryTabBus('user-b', channel)
  const received: unknown[] = []
  const unsubscribe = second.subscribe((message) => received.push(message))
  first.post({ type: 'settings-changed', clientId: 'first' })
  other.post({ type: 'settings-changed', clientId: 'other' })
  expect(received).toEqual([{ type: 'settings-changed', clientId: 'first', userId: 'user-a' }])
  unsubscribe()
  first.post({ type: 'settings-changed', clientId: 'again' })
  expect(received).toHaveLength(1)
  second.close()
  first.post({ type: 'settings-changed', clientId: 'closed' })
  expect(received).toHaveLength(1)
  first.close()
  other.close()
})
