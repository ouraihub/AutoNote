import type { TotpRecoveryCodesResult, TotpSetupInfo } from '@shared/types'
import type { Env } from '../env'
import { decryptTotpSecret, encryptTotpSecret } from './crypto'
import { timingSafeEqual } from './encoding'
import { ApiError } from './errors'
import { newId } from './id'
import {
  beginFactorAttempt,
  changed,
  clearFactorAttempts,
  factorThrottle,
  loadCredential,
  rejectFactor,
  requireEnabledCredential,
  setupExpired,
  factorUnavailable,
} from './totp-service-common'
import {
  buildTotpUri,
  generateOpaqueToken,
  generateRecoveryCodes,
  generateTotpSecret,
  hashOpaqueToken,
  hashRecoveryCode,
  isOpaqueToken,
  matchTotpCode,
  normalizeRecoveryCode,
  TOTP_SETUP_TTL_MS,
} from './totp'


export async function startTotpSetup(input: {
  env: Env
  userId: string
  sessionId: string
  issuer: string
  account: string
  now?: number
}): Promise<TotpSetupInfo> {
  const now = input.now ?? Date.now()
  const secret = generateTotpSecret()
  const secretCiphertext = await encryptTotpSecret(
    input.env,
    input.userId,
    secret,
  )
  const setupToken = generateOpaqueToken()
  const setupTokenHash = await hashOpaqueToken(setupToken)
  const expiresAt = now + TOTP_SETUP_TTL_MS
  const results = await input.env.DB.batch([
    input.env.DB.prepare(
      `INSERT INTO totp_credentials (
         user_id, secret_ciphertext, enabled_at,
         pending_token_hash, pending_session_id, pending_expires_at,
         recovery_generation, last_used_step, last_used_by, created_at, updated_at
       ) VALUES (?1, ?2, NULL, ?3, ?4, ?5, '', NULL, NULL, ?6, ?6)
       ON CONFLICT(user_id) DO UPDATE SET
         secret_ciphertext = excluded.secret_ciphertext,
         pending_token_hash = excluded.pending_token_hash,
         pending_session_id = excluded.pending_session_id,
         pending_expires_at = excluded.pending_expires_at,
         recovery_generation = '',
         last_used_step = NULL,
         last_used_by = NULL,
         updated_at = excluded.updated_at
       WHERE totp_credentials.enabled_at IS NULL`,
    ).bind(
      input.userId,
      secretCiphertext,
      setupTokenHash,
      input.sessionId,
      expiresAt,
      now,
    ),
    input.env.DB.prepare(
      `DELETE FROM totp_recovery_codes
        WHERE user_id = ?1
          AND NOT EXISTS (
            SELECT 1 FROM totp_credentials
             WHERE user_id = ?1 AND enabled_at IS NOT NULL
          )`,
    ).bind(input.userId),
  ])
  if (!changed(results[0])) {
    throw new ApiError(
      409,
      'two_factor_already_enabled',
      'Two-step verification is already enabled',
    )
  }
  return {
    setupToken,
    secret,
    uri: buildTotpUri({ secret, issuer: input.issuer, account: input.account }),
    expiresAt,
  }
}

export async function cancelTotpSetup(input: {
  db: D1Database
  userId: string
  sessionId: string
  setupToken: unknown
}): Promise<void> {
  if (!isOpaqueToken(input.setupToken)) return
  const setupTokenHash = await hashOpaqueToken(input.setupToken)
  await input.db
    .prepare(
      `DELETE FROM totp_credentials
      WHERE user_id = ?1
        AND enabled_at IS NULL
        AND pending_token_hash = ?2
        AND pending_session_id = ?3`,
    )
    .bind(input.userId, setupTokenHash, input.sessionId)
    .run()
}

export async function confirmTotpSetup(input: {
  env: Env
  userId: string
  sessionId: string
  setupToken: unknown
  code: unknown
  now?: number
}): Promise<TotpRecoveryCodesResult & { enabledAt: number }> {
  const now = input.now ?? Date.now()
  const throttle = factorThrottle(input.userId, 'setup')
  await beginFactorAttempt(input.env.DB, throttle)
  if (!isOpaqueToken(input.setupToken)) {
    await rejectFactor(input.env.DB, throttle, 'setup')
  }
  const setupTokenHash = await hashOpaqueToken(input.setupToken as string)
  const credential = await loadCredential(input.env.DB, input.userId)
  if (
    !credential ||
    credential.enabled_at != null ||
    !credential.pending_token_hash ||
    !credential.pending_session_id ||
    !credential.pending_expires_at ||
    credential.pending_expires_at <= now ||
    credential.pending_session_id !== input.sessionId ||
    !timingSafeEqual(credential.pending_token_hash, setupTokenHash)
  ) {
    await rejectFactor(input.env.DB, throttle, 'setup')
  }

  const secret = await decryptTotpSecret(
    input.env,
    input.userId,
    credential!.secret_ciphertext,
  )
  if (!secret) throw setupExpired()
  const step = await matchTotpCode(secret, input.code, now)
  if (step == null) await rejectFactor(input.env.DB, throttle, 'code')

  const recoveryCodes = generateRecoveryCodes()
  const recoveryGeneration = newId()
  const hashes = await Promise.all(
    recoveryCodes.map((code) =>
      hashRecoveryCode(input.userId, normalizeRecoveryCode(code)!),
    ),
  )
  const statements: D1PreparedStatement[] = [
    input.env.DB.prepare(
      `UPDATE totp_credentials SET
         enabled_at = ?1,
         pending_token_hash = NULL,
         pending_session_id = NULL,
         pending_expires_at = NULL,
         recovery_generation = ?2,
         last_used_step = NULL,
         last_used_by = NULL,
         updated_at = ?1
       WHERE user_id = ?3
         AND enabled_at IS NULL
         AND pending_token_hash = ?4
         AND pending_session_id = ?5
         AND pending_expires_at > ?1`,
    ).bind(
      now,
      recoveryGeneration,
      input.userId,
      setupTokenHash,
      input.sessionId,
    ),
    input.env.DB.prepare(
      `DELETE FROM sessions
        WHERE user_id = ?1 AND id != ?2
          AND EXISTS (
            SELECT 1 FROM totp_credentials
             WHERE user_id = ?1 AND recovery_generation = ?3 AND enabled_at = ?4
          )`,
    ).bind(input.userId, input.sessionId, recoveryGeneration, now),
    input.env.DB.prepare(
      `DELETE FROM totp_recovery_codes
        WHERE user_id = ?1
          AND EXISTS (
            SELECT 1 FROM totp_credentials
             WHERE user_id = ?1 AND recovery_generation = ?2 AND enabled_at = ?3
          )`,
    ).bind(input.userId, recoveryGeneration, now),
  ]
  for (const hash of hashes) {
    statements.push(
      input.env.DB.prepare(
        `INSERT INTO totp_recovery_codes
           (user_id, code_hash, generation, created_at, used_at, used_by)
         SELECT ?1, ?2, ?3, ?4, NULL, NULL
          WHERE EXISTS (
            SELECT 1 FROM totp_credentials
             WHERE user_id = ?1 AND recovery_generation = ?3 AND enabled_at = ?4
          )`,
      ).bind(input.userId, hash, recoveryGeneration, now),
    )
  }
  const results = await input.env.DB.batch(statements)
  if (!changed(results[0])) throw setupExpired()
  await clearFactorAttempts(input.env.DB, throttle)
  return {
    recoveryCodes,
    recoveryCodesRemaining: recoveryCodes.length,
    generatedAt: now,
    enabledAt: now,
  }
}

export async function regenerateRecoveryCodes(input: {
  env: Env
  userId: string
  code: unknown
  now?: number
}): Promise<TotpRecoveryCodesResult> {
  const now = input.now ?? Date.now()
  const throttle = factorThrottle(input.userId, 'recovery')
  await beginFactorAttempt(input.env.DB, throttle)
  const credential = await requireEnabledCredential(input.env, input.userId)
  const secret = await decryptTotpSecret(
    input.env,
    input.userId,
    credential.secret_ciphertext,
  )
  if (!secret) throw factorUnavailable()
  const step = await matchTotpCode(secret, input.code, now)
  if (step == null) await rejectFactor(input.env.DB, throttle, 'code')

  const recoveryCodes = generateRecoveryCodes()
  const recoveryGeneration = newId()
  const operationId = newId()
  const hashes = await Promise.all(
    recoveryCodes.map((code) =>
      hashRecoveryCode(input.userId, normalizeRecoveryCode(code)!),
    ),
  )
  const statements: D1PreparedStatement[] = [
    input.env.DB.prepare(
      `UPDATE totp_credentials SET
         recovery_generation = ?1,
         last_used_step = ?2,
         last_used_by = ?3,
         updated_at = ?4
       WHERE user_id = ?5
         AND enabled_at IS NOT NULL
         AND recovery_generation = ?6
         AND (last_used_step IS NULL OR last_used_step < ?2)`,
    ).bind(
      recoveryGeneration,
      step,
      operationId,
      now,
      input.userId,
      credential.recovery_generation,
    ),
    input.env.DB.prepare(
      `DELETE FROM totp_recovery_codes
        WHERE user_id = ?1
          AND EXISTS (
            SELECT 1 FROM totp_credentials
             WHERE user_id = ?1
               AND recovery_generation = ?2
               AND last_used_by = ?3
          )`,
    ).bind(input.userId, recoveryGeneration, operationId),
  ]
  for (const hash of hashes) {
    statements.push(
      input.env.DB.prepare(
        `INSERT INTO totp_recovery_codes
           (user_id, code_hash, generation, created_at, used_at, used_by)
         SELECT ?1, ?2, ?3, ?4, NULL, NULL
          WHERE EXISTS (
            SELECT 1 FROM totp_credentials
             WHERE user_id = ?1
               AND recovery_generation = ?3
               AND last_used_by = ?5
          )`,
      ).bind(input.userId, hash, recoveryGeneration, now, operationId),
    )
  }
  const results = await input.env.DB.batch(statements)
  if (!changed(results[0])) await rejectFactor(input.env.DB, throttle, 'code')
  await clearFactorAttempts(input.env.DB, throttle)
  return {
    recoveryCodes,
    recoveryCodesRemaining: recoveryCodes.length,
    generatedAt: now,
  }
}

export async function disableTotp(input: {
  env: Env
  userId: string
  sessionId: string
  code: unknown
  now?: number
}): Promise<void> {
  const now = input.now ?? Date.now()
  const throttle = factorThrottle(input.userId, 'disable')
  await beginFactorAttempt(input.env.DB, throttle)
  const credential = await requireEnabledCredential(input.env, input.userId)
  const recoveryCode = normalizeRecoveryCode(input.code)
  const operationId = newId()
  let statements: D1PreparedStatement[]

  if (recoveryCode) {
    const codeHash = await hashRecoveryCode(input.userId, recoveryCode)
    statements = [
      input.env.DB.prepare(
        `UPDATE totp_recovery_codes SET used_at = ?1, used_by = ?2
          WHERE user_id = ?3
            AND code_hash = ?4
            AND generation = ?5
            AND used_at IS NULL`,
      ).bind(
        now,
        operationId,
        input.userId,
        codeHash,
        credential.recovery_generation,
      ),
      input.env.DB.prepare(
        `UPDATE totp_credentials SET recovery_generation = ?1, updated_at = ?2
          WHERE user_id = ?3
            AND enabled_at IS NOT NULL
            AND recovery_generation = ?4
            AND EXISTS (
              SELECT 1 FROM totp_recovery_codes
               WHERE user_id = ?3 AND code_hash = ?5 AND used_by = ?1
            )`,
      ).bind(
        operationId,
        now,
        input.userId,
        credential.recovery_generation,
        codeHash,
      ),
    ]
  } else {
    const secret = await decryptTotpSecret(
      input.env,
      input.userId,
      credential.secret_ciphertext,
    )
    if (!secret) throw factorUnavailable()
    const step = await matchTotpCode(secret, input.code, now)
    if (step == null) await rejectFactor(input.env.DB, throttle, 'code')
    statements = [
      input.env.DB.prepare(
        `UPDATE totp_credentials SET
           recovery_generation = ?1,
           last_used_step = ?2,
           last_used_by = ?1,
           updated_at = ?3
         WHERE user_id = ?4
           AND enabled_at IS NOT NULL
           AND recovery_generation = ?5
           AND (last_used_step IS NULL OR last_used_step < ?2)`,
      ).bind(
        operationId,
        step,
        now,
        input.userId,
        credential.recovery_generation,
      ),
    ]
  }

  statements.push(
    input.env.DB.prepare(
      `DELETE FROM sessions
        WHERE user_id = ?1 AND id != ?2
          AND EXISTS (
            SELECT 1 FROM totp_credentials
             WHERE user_id = ?1 AND recovery_generation = ?3
          )`,
    ).bind(input.userId, input.sessionId, operationId),
    input.env.DB.prepare(
      `DELETE FROM totp_login_challenges
        WHERE user_id = ?1
          AND EXISTS (
            SELECT 1 FROM totp_credentials
             WHERE user_id = ?1 AND recovery_generation = ?2
          )`,
    ).bind(input.userId, operationId),
    input.env.DB.prepare(
      `DELETE FROM totp_recovery_codes
        WHERE user_id = ?1
          AND EXISTS (
            SELECT 1 FROM totp_credentials
             WHERE user_id = ?1 AND recovery_generation = ?2
          )`,
    ).bind(input.userId, operationId),
    input.env.DB.prepare(
      `DELETE FROM totp_credentials
        WHERE user_id = ?1 AND recovery_generation = ?2`,
    ).bind(input.userId, operationId),
  )
  const results = await input.env.DB.batch(statements)
  const factorAccepted = recoveryCode
    ? changed(results[0]) && changed(results[1])
    : changed(results[0])
  if (!factorAccepted || !changed(results.at(-1))) {
    await rejectFactor(input.env.DB, throttle, 'code')
  }
  await clearFactorAttempts(input.env.DB, throttle)
}

