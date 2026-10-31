import type { Clock } from '@app/platform/clock'
import type { KvStore } from '../local/kv-store'
import type { LocalDb } from '../local'

export interface ReplayLock {
  run(
    owner: string,
    task: (valid: () => Promise<boolean>) => Promise<void>,
  ): Promise<boolean>
}

export class NavigatorReplayLock implements ReplayLock {
  constructor(
    private readonly fallback: ReplayLock,
    private readonly userId: () => string | null,
  ) {}

  async run(
    owner: string,
    task: (valid: () => Promise<boolean>) => Promise<void>,
  ): Promise<boolean> {
    if (!globalThis.navigator?.locks?.request)
      return this.fallback.run(owner, task)
    const userId = this.userId()
    if (!userId) throw new Error('No local user is bound')
    return await globalThis.navigator.locks.request<Promise<boolean>>(
      `autonote-outbox-replay:${userId}`,
      async () => {
        await task(async () => true)
        return true
      },
    )
  }
}

export class LeaseReplayLock implements ReplayLock {
  constructor(
    private readonly kv: KvStore,
    private readonly localDb: Pick<LocalDb, 'activeUserId'>,
    private readonly clock: Clock,
  ) {}

  async run(
    owner: string,
    task: (valid: () => Promise<boolean>) => Promise<void>,
  ): Promise<boolean> {
    const userId = this.localDb.activeUserId()
    if (!userId) throw new Error('No local user is bound')
    const key = `user:${userId}:outboxReplayLease`
    const token = `${owner}:${globalThis.crypto.randomUUID()}`
    const deadline = this.clock.now() + 30_000
    let acquired = false
    do {
      const now = this.clock.now()
      await this.kv.update<{ owner: string; expiresAt: number } | null>(
        key,
        (current) => {
          if (!current || current.expiresAt <= now) {
            acquired = true
            return { owner: token, expiresAt: now + 90_000 }
          }
          return current
        },
      )
      if (acquired) break
      await new Promise<void>((resolve) =>
        globalThis.setTimeout(
          resolve,
          Math.min(50, Math.max(0, deadline - this.clock.now())),
        ),
      )
    } while (this.clock.now() < deadline)
    if (!acquired) return false

    let lost = false
    let heartbeat: Promise<void> = Promise.resolve()
    const valid = async (): Promise<boolean> => {
      if (lost) return false
      try {
        const current = await this.kv.get<{
          owner: string
          expiresAt: number
        } | null>(key)
        if (current?.owner === token && current.expiresAt > this.clock.now())
          return true
      } catch {
        lost = true
        return false
      }
      lost = true
      return false
    }
    const timer = globalThis.setInterval(() => {
      heartbeat = heartbeat
        .then(async () => {
          if (lost) return
          const now = this.clock.now()
          let renewed = false
          await this.kv.update<{ owner: string; expiresAt: number } | null>(
            key,
            (current) => {
              if (current?.owner === token && current.expiresAt > now) {
                renewed = true
                return { owner: token, expiresAt: now + 90_000 }
              }
              return current ?? null
            },
          )
          if (!renewed) lost = true
        })
        .catch(() => {
          lost = true
        })
    }, 20_000)
    try {
      await task(valid)
      return true
    } finally {
      globalThis.clearInterval(timer)
      await heartbeat
      await this.kv
        .update<{ owner: string; expiresAt: number } | null>(key, (current) =>
          current?.owner === token ? null : (current ?? null),
        )
        .catch(() => undefined)
    }
  }
}
