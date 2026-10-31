import type { Env } from '../env'
import { ApiError } from './errors'
import {
  assertNotLocked,
  clearLoginFailures,
  consumeAttemptBudget,
  recordLoginFailure,
  ThrottleError,
} from './throttle'

export interface TotpCredentialRow {
  secret_ciphertext: string
  enabled_at: number | null
  pending_token_hash: string | null
  pending_session_id: string | null
  pending_expires_at: number | null
  recovery_generation: string
  last_used_step: number | null
}

export interface TotpLoginRow {
  user_id: string
  expires_at: number
  secret_ciphertext: string
  recovery_generation: string
  last_used_step: number | null
}

export async function loadCredential(
  db: D1Database,
  userId: string,
): Promise<TotpCredentialRow | null> {
  return db
    .prepare(
      `SELECT secret_ciphertext, enabled_at,
            pending_token_hash, pending_session_id, pending_expires_at,
            recovery_generation, last_used_step
       FROM totp_credentials WHERE user_id = ?1`,
    )
    .bind(userId)
    .first<TotpCredentialRow>()
}

export async function requireEnabledCredential(
  env: Env,
  userId: string,
): Promise<TotpCredentialRow> {
  const credential = await loadCredential(env.DB, userId)
  if (!credential || credential.enabled_at == null) {
    throw new ApiError(
      409,
      'two_factor_not_enabled',
      'Two-step verification is not enabled',
    )
  }
  return credential
}

export async function countRecoveryCodes(
  db: D1Database,
  userId: string,
  generation: string,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM totp_recovery_codes
      WHERE user_id = ?1 AND generation = ?2 AND used_at IS NULL`,
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
    'The verification code is incorrect or has already been used',
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
    'The sign-in verification expired. Enter your password again',
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
    'The authenticator secret is unavailable. Use a recovery code to sign in or disable two-step verification',
  )
}

export function tooManyAttempts(error: ThrottleError): ApiError {
  return new ApiError(
    429,
    'too_many_attempts',
    `Too many attempts. Try again in ${error.retryAfterSec} seconds`,
    { retryAfter: error.retryAfterSec },
  )
}

export function changed(result: D1Result | undefined): boolean {
  return (result?.meta.changes ?? 0) > 0
}
