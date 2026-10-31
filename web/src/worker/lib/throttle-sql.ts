import type { AttemptBudgetTarget, ThrottleTarget } from './throttle'

const WINDOW_MS = 60 * 60 * 1000

export function attemptBudgetSql(
  db: D1Database,
  targets: Required<AttemptBudgetTarget>[],
  now: number,
): D1PreparedStatement[] {
  const sql = `
    INSERT INTO login_attempts (key, fails, last_fail_at, locked_until)
    VALUES (?1, 1, ?2, NULL)
    ON CONFLICT(key) DO UPDATE SET
      fails = CASE
        WHEN login_attempts.locked_until IS NOT NULL AND login_attempts.locked_until > ?2
          THEN login_attempts.fails
        WHEN ?2 - login_attempts.last_fail_at >= ?3 THEN 1
        ELSE login_attempts.fails + 1
      END,
      last_fail_at = CASE
        WHEN login_attempts.locked_until IS NOT NULL AND login_attempts.locked_until > ?2
          THEN login_attempts.last_fail_at
        ELSE ?2
      END,
      locked_until = CASE
        WHEN login_attempts.locked_until IS NOT NULL AND login_attempts.locked_until > ?2
          THEN login_attempts.locked_until
        WHEN ?2 - login_attempts.last_fail_at >= ?3 THEN NULL
        WHEN login_attempts.fails + 1 > ?4 THEN ?2 + ?5
        ELSE NULL
      END`
  return targets.map((target) =>
    db.prepare(sql).bind(target.key, now, target.windowMs, target.maxAttempts, target.lockMs),
  )
}

export function loginFailureSql(
  db: D1Database,
  targets: Required<ThrottleTarget>[],
  now: number,
): D1PreparedStatement[] {
  const sql = `
    INSERT INTO login_attempts (key, fails, last_fail_at, locked_until)
    VALUES (?1, 1, ?2, NULL)
    ON CONFLICT(key) DO UPDATE SET
      fails = CASE
        WHEN ?2 - login_attempts.last_fail_at > ?3 THEN 1
        ELSE login_attempts.fails + 1
      END,
      last_fail_at = ?2,
      locked_until = CASE
        WHEN ?2 - login_attempts.last_fail_at > ?3 THEN NULL
        WHEN login_attempts.fails + 1 < ?4 THEN NULL
        WHEN login_attempts.fails + 1 = ?4 THEN ?2 + 60000
        WHEN login_attempts.fails + 1 = ?4 + 1 THEN ?2 + 120000
        WHEN login_attempts.fails + 1 = ?4 + 2 THEN ?2 + 240000
        WHEN login_attempts.fails + 1 = ?4 + 3 THEN ?2 + 480000
        ELSE ?2 + 900000
      END`
  return targets.map((target) =>
    db.prepare(sql).bind(target.key, now, WINDOW_MS, target.freeFails),
  )
}
