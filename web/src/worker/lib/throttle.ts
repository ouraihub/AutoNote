import { attemptBudgetSql, loginFailureSql } from './throttle-sql'
import {
  normalizeAttemptBudgets,
  normalizeTargets,
} from './throttle-normalize'

export interface ThrottleTarget {
  key: string
  freeFails?: number
}
export interface AttemptBudgetTarget {
  key: string
  maxAttempts: number
  windowMs: number
  lockMs?: number
}
type ThrottleInput = string | ThrottleTarget

export class ThrottleError extends Error {
  readonly retryAfterSec: number
  constructor(retryAfterMs: number) {
    super('too_many_attempts')
    this.name = 'ThrottleError'
    this.retryAfterSec = Math.max(1, Math.ceil(retryAfterMs / 1000))
  }
}

export async function assertNotLocked(
  db: D1Database,
  inputs: readonly ThrottleInput[],
): Promise<void> {
  const keys = normalizeTargets(inputs).map((target) => target.key)
  if (!keys.length) return
  const { results } = await db
    .prepare(
      `SELECT locked_until FROM login_attempts WHERE key IN (${placeholders(keys.length)})`,
    )
    .bind(...keys)
    .all<{ locked_until: number | null }>()
  const now = Date.now()
  const retryAfterMs = results.reduce(
    (max, row) =>
      row.locked_until && row.locked_until > now
        ? Math.max(max, row.locked_until - now)
        : max,
    0,
  )
  if (retryAfterMs) throw new ThrottleError(retryAfterMs)
}

export async function consumeAttemptBudget(
  db: D1Database,
  inputs: readonly AttemptBudgetTarget[],
): Promise<void> {
  const targets = normalizeAttemptBudgets(inputs)
  if (!targets.length) return
  const now = Date.now()
  await assertNotLocked(db, targets.map((target) => target.key))
  await db.batch(attemptBudgetSql(db, targets, now))
  await assertNotLocked(db, targets.map((target) => target.key))
}

export async function recordLoginFailure(
  db: D1Database,
  inputs: readonly ThrottleInput[],
): Promise<void> {
  const targets = normalizeTargets(inputs)
  if (targets.length) await db.batch(loginFailureSql(db, targets, Date.now()))
}

export async function clearLoginFailures(
  db: D1Database,
  inputs: readonly ThrottleInput[],
): Promise<void> {
  const keys = normalizeTargets(inputs).map((target) => target.key)
  if (!keys.length) return
  await db
    .prepare(
      `DELETE FROM login_attempts WHERE key IN (${placeholders(keys.length)})`,
    )
    .bind(...keys)
    .run()
}

function placeholders(n: number): string {
  return Array.from({ length: n }, (_, i) => `?${i + 1}`).join(', ')
}
