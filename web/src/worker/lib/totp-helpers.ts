import { ApiError } from './errors'

import {
  assertNotLocked,
  clearLoginFailures,
  consumeAttemptBudget,
  recordLoginFailure,
  ThrottleError,
} from './throttle'

export async function countRecoveryCodes(
  db: D1Database,
  userId: string,
  generation: string,
): Promise<number> {
  const row = await db
    .prepare(
      'SELECT COUNT(*) AS n FROM totp_recovery_codes\n   ' +
        '   WHERE user_id = ?1 AND generation = ?2 AND used' +
        '_at IS NULL',
    )
    .bind(userId, generation)
    .first<{ n: number }>()
  return Number(row?.n ?? 0)
}

export function factorThrottle(
  userId: string,
  action: string,
): { failureKeys: string[]; workKey: string } {
  return {
    failureKeys: [`totp:${userId}`, `totp:${userId}:${action}`],
    workKey: `totp-work:${userId}:${action}`,
  }
}

export async function beginFactorAttempt(
  db: D1Database,
  throttle: { failureKeys: string[]; workKey: string },
): Promise<void> {
  await consumeWorkBudget(db, throttle.workKey)
  await assertFactorUnlocked(db, throttle)
}

export async function consumeWorkBudget(
  db: D1Database,
  workKey: string,
): Promise<void> {
  try {
    await consumeAttemptBudget(db, [
      { key: workKey, maxAttempts: 8, windowMs: 10 * 60 * 1000 },
    ])
  } catch (error) {
    if (error instanceof ThrottleError) throw tooManyAttempts(error)
    throw error
  }
}

export async function assertFactorUnlocked(
  db: D1Database,
  throttle: { failureKeys: string[] },
): Promise<void> {
  try {
    await assertNotLocked(db, throttle.failureKeys)
  } catch (error) {
    if (error instanceof ThrottleError) throw tooManyAttempts(error)
    throw error
  }
}

export async function rejectFactor(
  db: D1Database,
  throttle: { failureKeys: string[] },
  kind: 'code' | 'setup',
  workKey?: string,
): Promise<never> {
  await recordLoginFailure(db, throttle.failureKeys)
  if (workKey) {
    await assertFactorUnlocked(db, throttle)
  }
  if (kind === 'setup') throw setupExpired()
  throw new ApiError(
    401,
    'invalid_two_factor_code',
    'The verification code is incorrect or has already ' + 'been used',
  )
}

export async function clearFactorAttempts(
  db: D1Database,
  throttle: { failureKeys: string[]; workKey?: string },
  extraWorkKey?: string,
): Promise<void> {
  const keys = [...throttle.failureKeys]
  if (throttle.workKey) keys.push(throttle.workKey)
  if (extraWorkKey) keys.push(extraWorkKey)
  await clearLoginFailures(db, keys)
}

export function challengeExpired(): ApiError {
  return new ApiError(
    401,
    'two_factor_challenge_expired',
    'The sign-in verification expired. Enter your passw' + 'ord again',
  )
}

export function setupExpired(): ApiError {
  return new ApiError(
    409,
    'two_factor_setup_expired',
    'The setup session expired. Start again',
  )
}

export function factorUnavailable(): ApiError {
  return new ApiError(
    503,
    'two_factor_unavailable',
    'The authenticator secret is unavailable. Use a rec' +
      'overy code to sign in or disable two-step verifica' +
      'tion',
  )
}

export function tooManyAttempts(error: ThrottleError): ApiError {
  return new ApiError(
    429,
    'too_many_attempts',
    'Too many attempts. Try again in ' + `${error.retryAfterSec}` + ' seconds',
    { retryAfter: error.retryAfterSec },
  )
}

export function changed(result: D1Result | undefined): boolean {
  return (result?.meta.changes ?? 0) > 0
}
