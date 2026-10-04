import * as idbKeyval from 'idb-keyval'
import type { UseStore } from 'idb-keyval'

export type KvEntry = readonly [string, unknown]

export interface KvStore {
  get<T = unknown>(key: string): Promise<T | undefined>
  getMany<T = unknown>(keys: readonly string[]): Promise<(T | undefined)[]>
  set<T = unknown>(key: string, value: T): Promise<void>
  setMany(entries: readonly KvEntry[]): Promise<void>
  update<T = unknown>(key: string, updater: (current: T | undefined) => T): Promise<void>
  del(key: string): Promise<void>
  delMany(keys: readonly string[]): Promise<void>
  entries(): Promise<[string, unknown][]>
  clear(): Promise<void>
}

export interface IdbKeyvalAdapter {
  createStore(databaseName: string, storeName: string): UseStore
  get<T = unknown>(key: IDBValidKey, store?: UseStore): Promise<T | undefined>
  getMany<T = unknown>(keys: IDBValidKey[], store?: UseStore): Promise<(T | undefined)[]>
  set(key: IDBValidKey, value: unknown, store?: UseStore): Promise<void>
  setMany(entries: [IDBValidKey, unknown][], store?: UseStore): Promise<void>
  update<T = unknown>(key: IDBValidKey, updater: (current: T | undefined) => T, store?: UseStore): Promise<void>
  del(key: IDBValidKey, store?: UseStore): Promise<void>
  delMany(keys: IDBValidKey[], store?: UseStore): Promise<void>
  entries<KeyType extends IDBValidKey, ValueType = unknown>(store?: UseStore): Promise<[KeyType, ValueType][]>
  clear(store?: UseStore): Promise<void>
}

const defaultAdapter: IdbKeyvalAdapter = {
  createStore: idbKeyval.createStore,
  get: idbKeyval.get,
  getMany: idbKeyval.getMany,
  set: idbKeyval.set,
  setMany: idbKeyval.setMany,
  update: idbKeyval.update,
  del: idbKeyval.del,
  delMany: idbKeyval.delMany,
  entries: idbKeyval.entries,
  clear: idbKeyval.clear,
}

export interface IdbKvStoreOptions {
  databaseName?: string
  storeName?: string
  adapter?: IdbKeyvalAdapter
}

export class IdbKvStore implements KvStore {
  readonly #adapter: IdbKeyvalAdapter
  readonly #store: UseStore

  constructor(options: IdbKvStoreOptions = {}) {
    this.#adapter = options.adapter ?? defaultAdapter
    this.#store = this.#adapter.createStore(options.databaseName ?? 'autonote', options.storeName ?? 'kv')
  }

  get<T = unknown>(key: string): Promise<T | undefined> {
    return this.#adapter.get<T>(key, this.#store)
  }

  getMany<T = unknown>(keys: readonly string[]): Promise<(T | undefined)[]> {
    return this.#adapter.getMany<T>([...keys], this.#store)
  }

  set<T = unknown>(key: string, value: T): Promise<void> {
    return this.#adapter.set(key, value, this.#store)
  }

  setMany(entries: readonly KvEntry[]): Promise<void> {
    return this.#adapter.setMany(
      entries.map(([key, value]) => [key, value] as [string, unknown]),
      this.#store,
    )
  }

  update<T = unknown>(key: string, updater: (current: T | undefined) => T): Promise<void> {
    return this.#adapter.update(key, updater, this.#store)
  }

  del(key: string): Promise<void> {
    return this.#adapter.del(key, this.#store)
  }

  delMany(keys: readonly string[]): Promise<void> {
    return this.#adapter.delMany([...keys], this.#store)
  }

  entries(): Promise<[string, unknown][]> {
    return this.#adapter.entries<string, unknown>(this.#store)
  }

  clear(): Promise<void> {
    return this.#adapter.clear(this.#store)
  }
}

function clone<T>(value: T): T {
  if (typeof structuredClone === 'function') return structuredClone(value)
  return value
}

export class MemoryKvStore implements KvStore {
  readonly #values = new Map<string, unknown>()
  readonly #updates = new Map<string, Promise<void>>()

  constructor(initial?: Iterable<KvEntry>) {
    for (const [key, value] of initial ?? []) this.#values.set(key, clone(value))
  }

  async get<T = unknown>(key: string): Promise<T | undefined> {
    return clone(this.#values.get(key) as T | undefined)
  }

  async getMany<T = unknown>(keys: readonly string[]): Promise<(T | undefined)[]> {
    return Promise.all(keys.map((key) => this.get<T>(key)))
  }

  async set<T = unknown>(key: string, value: T): Promise<void> {
    this.#values.set(key, clone(value))
  }

  async setMany(entries: readonly KvEntry[]): Promise<void> {
    const next = entries.map(([key, value]) => [key, clone(value)] as const)
    for (const [key, value] of next) this.#values.set(key, value)
  }

  async update<T = unknown>(key: string, updater: (current: T | undefined) => T): Promise<void> {
    const previous = this.#updates.get(key) ?? Promise.resolve()
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        const current = clone(this.#values.get(key) as T | undefined)
        const value = await updater(current)
        this.#values.set(key, clone(value))
      })
    this.#updates.set(key, next)
    try {
      await next
    } finally {
      if (this.#updates.get(key) === next) this.#updates.delete(key)
    }
  }

  async del(key: string): Promise<void> {
    this.#values.delete(key)
  }

  async delMany(keys: readonly string[]): Promise<void> {
    for (const key of keys) this.#values.delete(key)
  }

  async entries(): Promise<[string, unknown][]> {
    return [...this.#values.entries()].map(([key, value]) => [key, clone(value)])
  }

  async clear(): Promise<void> {
    this.#values.clear()
  }
}

export function createIdbKvStore(options?: IdbKvStoreOptions): KvStore {
  return new IdbKvStore(options)
}
