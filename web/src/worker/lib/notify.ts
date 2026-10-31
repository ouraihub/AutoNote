import type { Context } from 'hono'
import {
  currentCursor,
  recordChange,
  type ChangeEntity,
  type ChangeOp,
} from '../db/writes'
import { notifySyncHub } from '../realtime/sync-hub'
import type { AppBindings } from '../env'
export { scheduleFtsDrain } from './notify-fts'

export function originOf(c: Context<AppBindings>): string | null {
  return c.req.header('X-AutoNote-Origin')?.slice(0, 128) || null
}

export async function commitChange(
  c: Context<AppBindings>,
  entity: ChangeEntity,
  entityId: string,
  op: ChangeOp,
): Promise<number> {
  const userId = c.get('userId')
  const cursor = await recordChange(c.env.DB, userId, entity, entityId, op)
  c.executionCtx?.waitUntil(
    notifySyncHub(c.env.SYNC_HUB, userId, cursor, originOf(c)),
  )
  return cursor
}

export async function broadcastCursor(
  c: Context<AppBindings>,
  knownCursor?: number,
): Promise<number> {
  const userId = c.get('userId')
  return broadcastUserCursor(c.env, userId, originOf(c), knownCursor, (task) =>
    c.executionCtx?.waitUntil(task),
  )
}

export async function broadcastUserCursor(
  env: AppBindings['Bindings'],
  userId: string,
  origin: string | null = null,
  knownCursor?: number,
  waitUntil?: (task: Promise<unknown>) => void,
): Promise<number> {
  const cursor = knownCursor ?? (await currentCursor(env.DB, userId))
  const notification = notifySyncHub(env.SYNC_HUB, userId, cursor, origin)
  if (waitUntil) waitUntil(notification)
  else await notification
  return cursor
}
