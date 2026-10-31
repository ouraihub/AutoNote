import { SESSION_TTL_MS } from '@shared/constants'
import type { TotpLoginChallenge } from '@shared/types'
import type { Env } from '../env'
import { decryptTotpSecret } from './crypto'
import { newId } from './id'
import { hashToken, newSessionToken } from './session-store'
import {
  assertFactorUnlocked,
  challengeExpired,
  clearFactorAttempts,
  consumeWorkBudget,
  countRecoveryCodes,
  factorThrottle,
  factorUnavailable,
  rejectFactor,
} from './totp-service-common'
import type { TotpLoginRow } from './totp-service-common'
import {
  generateOpaqueToken,
  hashOpaqueToken,
  hashRecoveryCode,
  isOpaqueToken,
  matchTotpCode,
  normalizeRecoveryCode,
  TOTP_LOGIN_TTL_MS,
} from './totp'

export interface CompletedTotpLogin {
  userId: string
  sessionToken: string
  recoveryCodeUsed: boolean
  recoveryCodesRemaining: number | null
}

export async function createTotpLoginChallenge(
  db: D1Database,
  userId: string,
  now = Date.now(),
): Promise<TotpLoginChallenge> {
  const challengeToken = generateOpaqueToken()
  const challengeHash = await hashOpaqueToken(challengeToken)
  const expiresAt = now + TOTP_LOGIN_TTL_MS
  await db
    .prepare(
      `INSERT INTO totp_login_challenges (id, user_id, expires_at, created_at)
     VALUES (?1, ?2, ?3, ?4)`,
    )
    .bind(challengeHash, userId, expiresAt, now)
    .run()
  return { twoFactorRequired: true, challengeToken, expiresAt }
}

export async function completeTotpLogin(input: {
  env: Env
  challengeToken: unknown
  code: unknown
  now?: number
}): Promise<CompletedTotpLogin> {
  const now = input.now ?? Date.now()
  if (!isOpaqueToken(input.challengeToken)) throw challengeExpired()
  const challengeHash = await hashOpaqueToken(input.challengeToken)
  const workKey = `totp-login-work:${challengeHash}`
  await consumeWorkBudget(input.env.DB, workKey)
  const row = await input.env.DB.prepare(
    `SELECT ch.user_id, ch.expires_at,
            c.secret_ciphertext, c.recovery_generation, c.last_used_step
       FROM totp_login_challenges ch
       JOIN totp_credentials c ON c.user_id = ch.user_id
      WHERE ch.id = ?1 AND c.enabled_at IS NOT NULL`,
  )
    .bind(challengeHash)
    .first<TotpLoginRow>()
  if (!row || row.expires_at <= now) {
    await input.env.DB.prepare(
      `DELETE FROM totp_login_challenges WHERE id = ?1`,
    )
      .bind(challengeHash)
      .run()
    throw challengeExpired()
  }

  const throttle = factorThrottle(row.user_id, challengeHash)
  await assertFactorUnlocked(input.env.DB, throttle)
  const recoveryCode = normalizeRecoveryCode(input.code)
  const operationId = newId()
  const sessionToken = newSessionToken()
  const sessionHash = await hashToken(sessionToken)
  const expiresAt = now + SESSION_TTL_MS
  let results: D1Result[]
  let recoveryCodeUsed = false

  if (recoveryCode) {
    const codeHash = await hashRecoveryCode(row.user_id, recoveryCode)
    results = await input.env.DB.batch([
      input.env.DB.prepare(
        `UPDATE totp_recovery_codes SET used_at = ?1, used_by = ?2
          WHERE user_id = ?3
            AND code_hash = ?4
            AND generation = ?5
            AND used_at IS NULL
            AND EXISTS (
              SELECT 1 FROM totp_login_challenges
               WHERE id = ?6 AND user_id = ?3 AND expires_at > ?1 AND claimed_by IS NULL
            )`,
      ).bind(
        now,
        operationId,
        row.user_id,
        codeHash,
        row.recovery_generation,
        challengeHash,
      ),
      input.env.DB.prepare(
        `UPDATE totp_login_challenges SET claimed_by = ?1
          WHERE id = ?2 AND user_id = ?3 AND expires_at > ?4 AND claimed_by IS NULL
            AND EXISTS (
              SELECT 1 FROM totp_recovery_codes
               WHERE user_id = ?3 AND code_hash = ?5 AND used_by = ?1
            )`,
      ).bind(operationId, challengeHash, row.user_id, now, codeHash),
      input.env.DB.prepare(
        `INSERT INTO sessions (id, user_id, expires_at, created_at)
         SELECT ?1, ?2, ?3, ?4
          WHERE EXISTS (
            SELECT 1 FROM totp_recovery_codes
             WHERE user_id = ?2 AND code_hash = ?5 AND used_by = ?6
          )
            AND EXISTS (
              SELECT 1 FROM totp_login_challenges WHERE id = ?7 AND claimed_by = ?6
            )`,
      ).bind(
        sessionHash,
        row.user_id,
        expiresAt,
        now,
        codeHash,
        operationId,
        challengeHash,
      ),
      input.env.DB.prepare(
        `DELETE FROM totp_login_challenges WHERE id = ?1 AND claimed_by = ?2`,
      ).bind(challengeHash, operationId),
    ])
    recoveryCodeUsed = true
  } else {
    const secret = await decryptTotpSecret(
      input.env,
      row.user_id,
      row.secret_ciphertext,
    )
    if (!secret) throw factorUnavailable()
    const step = await matchTotpCode(secret, input.code, now)
    if (step == null)
      await rejectFactor(input.env.DB, throttle, 'code', workKey)
    results = await input.env.DB.batch([
      input.env.DB.prepare(
        `UPDATE totp_credentials SET
           last_used_step = ?1,
           last_used_by = ?2,
           updated_at = ?3
         WHERE user_id = ?4
           AND enabled_at IS NOT NULL
           AND recovery_generation = ?5
           AND (last_used_step IS NULL OR last_used_step < ?1)
           AND EXISTS (
             SELECT 1 FROM totp_login_challenges
              WHERE id = ?6 AND user_id = ?4 AND expires_at > ?3 AND claimed_by IS NULL
           )`,
      ).bind(
        step,
        operationId,
        now,
        row.user_id,
        row.recovery_generation,
        challengeHash,
      ),
      input.env.DB.prepare(
        `UPDATE totp_login_challenges SET claimed_by = ?1
          WHERE id = ?2 AND user_id = ?3 AND expires_at > ?4 AND claimed_by IS NULL
            AND EXISTS (
              SELECT 1 FROM totp_credentials
               WHERE user_id = ?3 AND last_used_by = ?1
            )`,
      ).bind(operationId, challengeHash, row.user_id, now),
      input.env.DB.prepare(
        `INSERT INTO sessions (id, user_id, expires_at, created_at)
         SELECT ?1, ?2, ?3, ?4
          WHERE EXISTS (
            SELECT 1 FROM totp_credentials
             WHERE user_id = ?2 AND last_used_by = ?5
          )
            AND EXISTS (
              SELECT 1 FROM totp_login_challenges WHERE id = ?6 AND claimed_by = ?5
            )`,
      ).bind(
        sessionHash,
        row.user_id,
        expiresAt,
        now,
        operationId,
        challengeHash,
      ),
      input.env.DB.prepare(
        `DELETE FROM totp_login_challenges WHERE id = ?1 AND claimed_by = ?2`,
      ).bind(challengeHash, operationId),
    ])
  }

  if (
    !changed(results[0]) ||
    !changed(results[1]) ||
    !changed(results[2]) ||
    !changed(results[3])
  ) {
    await rejectFactor(input.env.DB, throttle, 'code', workKey)
  }
  await clearFactorAttempts(input.env.DB, throttle, workKey)
  const remaining = recoveryCodeUsed
    ? await countRecoveryCodes(
        input.env.DB,
        row.user_id,
        row.recovery_generation,
      )
    : null
  return {
    userId: row.user_id,
    sessionToken,
    recoveryCodeUsed,
    recoveryCodesRemaining: remaining,
  }
}

function changed(result: D1Result | undefined): boolean {
  return (result?.meta.changes ?? 0) > 0
}
