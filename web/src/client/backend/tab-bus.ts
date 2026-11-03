import type { Note } from '@shared/types'

export type TabMessage =
  | { type: 'local-write'; clientId: string; userId?: string }
  | { type: 'pulled'; cursor: number; clientId: string; userId?: string }
  | { type: 'claim-leader'; clientId: string; at: number; userId?: string }
  | { type: 'settings-changed'; clientId: string; userId?: string }
  | { type: 'profile-changed'; clientId: string; userId?: string }
  | { type: 'site-changed'; clientId: string; userId?: string }
  | {
      type: 'outbox-base-advanced'
      clientId: string
      noteId: string
      writeId: string
      expectedRev: number
      nextRev: number
      userId?: string
    }
  | {
      type: 'outbox-result'
      clientId: string
      targetClientId: string
      noteId: string
      writeId: string
      outcome: 'saved' | 'recovered'
      recoveryReason?: 'conflict' | 'deleted'
      rev?: number
      updatedAt?: number
      savedTitle?: string
      savedNote?: Note
      copyId?: string
      userId?: string
    }

export interface TabBus {
  post(message: TabMessage): void
  subscribe(listener: (message: TabMessage) => void): () => void
  close(): void
}

export interface BroadcastChannelLike {
  onmessage: ((event: MessageEvent<unknown>) => void) | null
  postMessage(message: unknown): void
  close(): void
}

export type BroadcastChannelFactory = (name: string) => BroadcastChannelLike

const CHANNEL_NAME = 'autonote'

export class BroadcastTabBus implements TabBus {
  readonly #userId: string
  readonly #channel: BroadcastChannelLike | null
  readonly #listeners = new Set<(message: TabMessage) => void>()
  #closed = false

  constructor(userId: string, factory?: BroadcastChannelFactory) {
    this.#userId = userId
    this.#channel = factory
      ? factory(CHANNEL_NAME)
      : typeof globalThis.BroadcastChannel === 'undefined'
        ? null
        : browserBroadcastChannelFactory(CHANNEL_NAME)
    if (this.#channel)
      this.#channel.onmessage = (event) => this.#receive(event.data)
  }

  post(message: TabMessage): void {
    if (this.#closed || !this.#channel) return
    this.#channel.postMessage({ ...message, userId: this.#userId })
  }

  subscribe(listener: (message: TabMessage) => void): () => void {
    if (this.#closed) return () => undefined
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#listeners.clear()
    if (this.#channel) {
      this.#channel.onmessage = null
      this.#channel.close()
    }
  }

  #receive(value: unknown): void {
    if (this.#closed || !isTabMessage(value)) return
    if (value.userId !== this.#userId) return
    for (const listener of this.#listeners) listener(value)
  }
}

export interface MemoryTabBusChannel {
  readonly buses: Set<MemoryTabBus>
}

export function createMemoryTabBusChannel(): MemoryTabBusChannel {
  return { buses: new Set() }
}

export class MemoryTabBus implements TabBus {
  readonly #userId: string
  readonly #channel: MemoryTabBusChannel
  readonly #listeners = new Set<(message: TabMessage) => void>()
  #closed = false

  constructor(
    userId: string,
    channel: MemoryTabBusChannel = createMemoryTabBusChannel(),
  ) {
    this.#userId = userId
    this.#channel = channel
    channel.buses.add(this)
  }

  post(message: TabMessage): void {
    if (this.#closed) return
    const envelope = { ...message, userId: this.#userId }
    for (const bus of this.#channel.buses) {
      if (bus !== this) bus.#receive(envelope)
    }
  }

  subscribe(listener: (message: TabMessage) => void): () => void {
    if (this.#closed) return () => undefined
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#listeners.clear()
    this.#channel.buses.delete(this)
  }

  #receive(value: unknown): void {
    if (this.#closed || !isTabMessage(value)) return
    if (value.userId !== this.#userId) return
    for (const listener of this.#listeners) listener(value)
  }
}

function browserBroadcastChannelFactory(name: string): BroadcastChannelLike {
  return new globalThis.BroadcastChannel(name)
}

function isTabMessage(value: unknown): value is TabMessage {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return false
  if (!('type' in value) || typeof value.type !== 'string') return false
  if (!('userId' in value) || typeof value.userId !== 'string') return false
  if (
    !('clientId' in value) ||
    typeof value.clientId !== 'string' ||
    !value.clientId
  )
    return false
  if (value.type === 'claim-leader')
    return (
      'at' in value && typeof value.at === 'number' && Number.isFinite(value.at)
    )
  if (value.type === 'pulled')
    return (
      'cursor' in value &&
      typeof value.cursor === 'number' &&
      Number.isSafeInteger(value.cursor) &&
      value.cursor >= 0
    )
  if (value.type === 'outbox-base-advanced')
    return (
      'noteId' in value &&
      typeof value.noteId === 'string' &&
      'writeId' in value &&
      typeof value.writeId === 'string' &&
      'expectedRev' in value &&
      typeof value.expectedRev === 'number' &&
      Number.isSafeInteger(value.expectedRev) &&
      'nextRev' in value &&
      typeof value.nextRev === 'number' &&
      Number.isSafeInteger(value.nextRev)
    )
  if (value.type === 'outbox-result')
    return (
      'noteId' in value &&
      typeof value.noteId === 'string' &&
      'writeId' in value &&
      typeof value.writeId === 'string' &&
      'targetClientId' in value &&
      typeof value.targetClientId === 'string' &&
      'outcome' in value &&
      (value.outcome === 'saved' || value.outcome === 'recovered')
    )
  return (
    value.type === 'local-write' ||
    value.type === 'settings-changed' ||
    value.type === 'profile-changed' ||
    value.type === 'site-changed'
  )
}
