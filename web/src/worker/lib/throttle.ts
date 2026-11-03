const DEFAULT_FREE_FAILS = 5
const WINDOW_MS = 60 * 60 * 1000

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

function placeholders(n: number): string {
  return Array.from({ length: n }, (_, i) => `?${i + 1}`).join(', ')
}

export async function assertNotLocked(
  db: D1Database,
  inputs: readonly ThrottleInput[],
): Promise<void> {
  const keys = normalizeTargets(inputs).map((target) => target.key)
  if (!keys.length) return
  const { results } = await db
    .prepare(
      'SELECT locked_until FROM login_attempts WHERE key ' +
        'IN (' +
        `${placeholders(keys.length)}` +
        ')',
    )
    .bind(...keys)
    .all<{ locked_until: number | null }>()
  const now = Date.now()
  let retryAfterMs = 0
  for (const row of results) {
    if (row.locked_until && row.locked_until > now) {
      retryAfterMs = Math.max(retryAfterMs, row.locked_until - now)
    }
  }
  if (retryAfterMs) throw new ThrottleError(retryAfterMs)
}

export async function consumeAttemptBudget(
  db: D1Database,
  inputs: readonly AttemptBudgetTarget[],
): Promise<void> {
  const targets = normalizeAttemptBudgets(inputs)
  if (!targets.length) return
  const now = Date.now()
  await assertNotLocked(
    db,
    targets.map((target) => target.key),
  )
  const sql =
    '\n    INSERT INTO login_attempts (key, fails, last' +
    '_fail_at, locked_until)\n    VALUES (?1, 1, ?2, NU' +
    'LL)\n    ON CONFLICT(key) DO UPDATE SET\n      fai' +
    'ls = CASE\n        WHEN login_attempts.locked_unti' +
    'l IS NOT NULL AND login_attempts.locked_until > ?2' +
    '\n          THEN login_attempts.fails\n        WHE' +
    'N ?2 - login_attempts.last_fail_at >= ?3 THEN 1\n ' +
    '       ELSE login_attempts.fails + 1\n      END,\n' +
    '      last_fail_at = CASE\n        WHEN login_atte' +
    'mpts.locked_until IS NOT NULL AND login_attempts.l' +
    'ocked_until > ?2\n          THEN login_attempts.la' +
    'st_fail_at\n        ELSE ?2\n      END,\n      loc' +
    'ked_until = CASE\n        WHEN login_attempts.lock' +
    'ed_until IS NOT NULL AND login_attempts.locked_unt' +
    'il > ?2\n          THEN login_attempts.locked_unti' +
    'l\n        WHEN ?2 - login_attempts.last_fail_at >' +
    '= ?3 THEN NULL\n        WHEN login_attempts.fails ' +
    '+ 1 > ?4 THEN ?2 + ?5\n        ELSE NULL\n      EN' +
    'D'
  const statements = targets.map((target) =>
    db
      .prepare(sql)
      .bind(
        target.key,
        now,
        target.windowMs,
        target.maxAttempts,
        target.lockMs,
      ),
  )
  await db.batch(statements)
  await assertNotLocked(
    db,
    targets.map((target) => target.key),
  )
}

export async function recordLoginFailure(
  db: D1Database,
  inputs: readonly ThrottleInput[],
): Promise<void> {
  const targets = normalizeTargets(inputs)
  if (!targets.length) return
  const now = Date.now()
  const sql =
    '\n    INSERT INTO login_attempts (key, fails, last' +
    '_fail_at, locked_until)\n    VALUES (?1, 1, ?2, NU' +
    'LL)\n    ON CONFLICT(key) DO UPDATE SET\n      fai' +
    'ls = CASE\n        WHEN ?2 - login_attempts.last_f' +
    'ail_at > ?3 THEN 1\n        ELSE login_attempts.fa' +
    'ils + 1\n      END,\n      last_fail_at = ?2,\n   ' +
    '   locked_until = CASE\n        WHEN ?2 - login_at' +
    'tempts.last_fail_at > ?3 THEN NULL\n        WHEN l' +
    'ogin_attempts.fails + 1 < ?4 THEN NULL\n        WH' +
    'EN login_attempts.fails + 1 = ?4 THEN ?2 + 60000\n' +
    '        WHEN login_attempts.fails + 1 = ?4 + 1 THE' +
    'N ?2 + 120000\n        WHEN login_attempts.fails +' +
    ' 1 = ?4 + 2 THEN ?2 + 240000\n        WHEN login_a' +
    'ttempts.fails + 1 = ?4 + 3 THEN ?2 + 480000\n     ' +
    '   ELSE ?2 + 900000\n      END'
  const statements = targets.map((target) =>
    db.prepare(sql).bind(target.key, now, WINDOW_MS, target.freeFails),
  )
  await db.batch(statements)
}

export async function clearLoginFailures(
  db: D1Database,
  inputs: readonly ThrottleInput[],
): Promise<void> {
  const keys = normalizeTargets(inputs).map((target) => target.key)
  if (!keys.length) return
  await db
    .prepare(
      'DELETE FROM login_attempts WHERE key IN (' +
        `${placeholders(keys.length)}` +
        ')',
    )
    .bind(...keys)
    .run()
}

function normalizeTargets(
  inputs: readonly ThrottleInput[],
): Required<ThrottleTarget>[] {
  const unique = new Map<string, number>()
  for (const input of inputs) {
    const rawKey = typeof input === 'string' ? input : input.key
    const key = rawKey.slice(0, 256)
    if (!key) continue
    const requested =
      typeof input === 'string' ? DEFAULT_FREE_FAILS : input.freeFails
    const freeFails = Math.min(
      100,
      Math.max(2, Math.trunc(requested ?? DEFAULT_FREE_FAILS)),
    )
    const previous = unique.get(key)
    unique.set(
      key,
      previous === undefined ? freeFails : Math.min(previous, freeFails),
    )
  }
  return [...unique].map(([key, freeFails]) => ({ key, freeFails }))
}

function normalizeAttemptBudgets(
  inputs: readonly AttemptBudgetTarget[],
): Required<AttemptBudgetTarget>[] {
  const unique = new Map<string, Required<AttemptBudgetTarget>>()
  for (const input of inputs) {
    const key = input.key.slice(0, 256)
    if (!key) continue
    const maxAttempts = Math.min(
      1000,
      Math.max(1, Math.trunc(input.maxAttempts)),
    )
    const windowMs = Math.min(
      24 * 60 * 60 * 1000,
      Math.max(1000, Math.trunc(input.windowMs)),
    )
    const lockMs = Math.min(
      24 * 60 * 60 * 1000,
      Math.max(1000, Math.trunc(input.lockMs ?? windowMs)),
    )
    const candidate = { key, maxAttempts, windowMs, lockMs }
    const previous = unique.get(key)
    if (!previous || maxAttempts < previous.maxAttempts)
      unique.set(key, candidate)
  }
  return [...unique.values()]
}
