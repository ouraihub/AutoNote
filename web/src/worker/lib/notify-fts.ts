import type { Context } from 'hono'
import { drainFtsQueue, FTS_DRAIN_DELAY_MS } from '../db/fts'
import type { AppBindings } from '../env'

interface ScheduledFtsDrain {
  max: number
  rerun: boolean
  promise: Promise<void>
}

const scheduledFtsDrains = new WeakMap<
  D1Database,
  Map<string, ScheduledFtsDrain>
>()

export function scheduleFtsDrain(c: Context<AppBindings>, max = 5): void {
  if (!c.get('database').ftsEnabled || !c.executionCtx) return
  const userId = c.get('userId')
  const db = c.env.DB
  let byUser = scheduledFtsDrains.get(db)
  if (!byUser) {
    byUser = new Map()
    scheduledFtsDrains.set(db, byUser)
  }
  const existing = byUser.get(userId)
  if (existing) {
    existing.max = Math.max(existing.max, max)
    existing.rerun = true
    return
  }

  const scheduled: ScheduledFtsDrain = {
    max,
    rerun: false,
    promise: Promise.resolve(),
  }
  scheduled.promise = new Promise<void>((resolve) => {
    setTimeout(resolve, FTS_DRAIN_DELAY_MS + 2_000)
  })
    .then(async () => {
      do {
        scheduled.rerun = false
        await drainFtsQueue(db, userId, scheduled.max, true)
      } while (scheduled.rerun)
    })
    .catch(() => {})
    .finally(() => {
      if (byUser!.get(userId) === scheduled) byUser!.delete(userId)
    })
  byUser.set(userId, scheduled)
  c.executionCtx.waitUntil(scheduled.promise)
}
