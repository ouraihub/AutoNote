import type {
  TotpRecoveryCodesResult,
  TotpSetupInfo,
  TotpStatus,
} from '@shared/types'
import type { Env } from '../env'
import { decryptTotpSecret, encryptTotpSecret } from './crypto'
import { timingSafeEqual } from './encoding'
import { ApiError } from './errors'
import { newId } from './id'

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

import {
  factorThrottle,
  beginFactorAttempt,
  rejectFactor,
  clearFactorAttempts,
  setupExpired,
  factorUnavailable,
  changed,
} from './totp-helpers'

interface TotpCredentialRow {
  secret_ciphertext: string
  enabled_at: number | null
  pending_token_hash: string | null
  pending_session_id: string | null
  pending_expires_at: number | null
  recovery_generation: string
  last_used_step: number | null
}

export async function getTotpStatus(
  env: Env,
  userId: string,
): Promise<TotpStatus> {
  const row = await env.DB.prepare(
    'SELECT c.enabled_at, COUNT(r.code_hash) AS recover' +
      'y_codes\n       FROM totp_credentials c\n       LE' +
      'FT JOIN totp_recovery_codes r\n         ON r.user_' +
      'id = c.user_id\n        AND r.generation = c.recov' +
      'ery_generation\n        AND r.used_at IS NULL\n   ' +
      '   WHERE c.user_id = ?1\n      GROUP BY c.user_id,' +
      ' c.enabled_at',
  )
    .bind(userId)
    .first<{ enabled_at: number | null; recovery_codes: number }>()
  return {
    available: Boolean(env.CREDENTIAL_VAULT),
    enabled: row?.enabled_at != null,
    enabledAt: row?.enabled_at ?? null,
    recoveryCodesRemaining:
      row?.enabled_at == null ? 0 : Number(row.recovery_codes || 0),
  }
}

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
      'INSERT INTO totp_credentials (\n         user_id, ' +
        'secret_ciphertext, enabled_at,\n         pending_t' +
        'oken_hash, pending_session_id, pending_expires_at,' +
        '\n         recovery_generation, last_used_step, la' +
        'st_used_by, created_at, updated_at\n       ) VALUE' +
        "S (?1, ?2, NULL, ?3, ?4, ?5, '', NULL, NULL, ?6, ?" +
        '6)\n       ON CONFLICT(user_id) DO UPDATE SET\n   ' +
        '      secret_ciphertext = excluded.secret_cipherte' +
        'xt,\n         pending_token_hash = excluded.pendin' +
        'g_token_hash,\n         pending_session_id = exclu' +
        'ded.pending_session_id,\n         pending_expires_' +
        'at = excluded.pending_expires_at,\n         recove' +
        "ry_generation = '',\n         last_used_step = NUL" +
        'L,\n         last_used_by = NULL,\n         update' +
        'd_at = excluded.updated_at\n       WHERE totp_cred' +
        'entials.enabled_at IS NULL',
    ).bind(
      input.userId,
      secretCiphertext,
      setupTokenHash,
      input.sessionId,
      expiresAt,
      now,
    ),
    input.env.DB.prepare(
      'DELETE FROM totp_recovery_codes\n        WHERE use' +
        'r_id = ?1\n          AND NOT EXISTS (\n           ' +
        ' SELECT 1 FROM totp_credentials\n             WHER' +
        'E user_id = ?1 AND enabled_at IS NOT NULL\n       ' +
        '   )',
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
      'DELETE FROM sessions\n        WHERE user_id = ?1 A' +
        'ND id != ?2\n          AND EXISTS (\n            S' +
        'ELECT 1 FROM totp_credentials\n             WHERE ' +
        'user_id = ?1 AND recovery_generation = ?3 AND enab' +
        'led_at = ?4\n          )',
    ).bind(input.userId, input.sessionId, recoveryGeneration, now),
    input.env.DB.prepare(
      'DELETE FROM totp_recovery_codes\n        WHERE use' +
        'r_id = ?1\n          AND EXISTS (\n            SEL' +
        'ECT 1 FROM totp_credentials\n             WHERE us' +
        'er_id = ?1 AND recovery_generation = ?2 AND enable' +
        'd_at = ?3\n          )',
    ).bind(input.userId, recoveryGeneration, now),
  ]
  for (const hash of hashes) {
    statements.push(
      input.env.DB.prepare(
        'INSERT INTO totp_recovery_codes\n           (user_' +
          'id, code_hash, generation, created_at, used_at, us' +
          'ed_by)\n         SELECT ?1, ?2, ?3, ?4, NULL, NULL' +
          '\n          WHERE EXISTS (\n            SELECT 1 F' +
          'ROM totp_credentials\n             WHERE user_id =' +
          ' ?1 AND recovery_generation = ?3 AND enabled_at = ' +
          '?4\n          )',
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
      'UPDATE totp_credentials SET\n         recovery_gen' +
        'eration = ?1,\n         last_used_step = ?2,\n    ' +
        '     last_used_by = ?3,\n         updated_at = ?4' +
        '\n       WHERE user_id = ?5\n         AND enabled_' +
        'at IS NOT NULL\n         AND recovery_generation =' +
        ' ?6\n         AND (last_used_step IS NULL OR last_' +
        'used_step < ?2)',
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
        'INSERT INTO totp_recovery_codes\n           (user_' +
          'id, code_hash, generation, created_at, used_at, us' +
          'ed_by)\n         SELECT ?1, ?2, ?3, ?4, NULL, NULL' +
          '\n          WHERE EXISTS (\n            SELECT 1 F' +
          'ROM totp_credentials\n             WHERE user_id =' +
          ' ?1\n               AND recovery_generation = ?3\n' +
          '               AND last_used_by = ?5\n          )',
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
        'UPDATE totp_recovery_codes SET used_at = ?1, used_' +
          'by = ?2\n          WHERE user_id = ?3\n           ' +
          ' AND code_hash = ?4\n            AND generation = ' +
          '?5\n            AND used_at IS NULL',
      ).bind(
        now,
        operationId,
        input.userId,
        codeHash,
        credential.recovery_generation,
      ),
      input.env.DB.prepare(
        'UPDATE totp_credentials SET recovery_generation = ' +
          '?1, updated_at = ?2\n          WHERE user_id = ?3' +
          '\n            AND enabled_at IS NOT NULL\n        ' +
          '    AND recovery_generation = ?4\n            AND ' +
          'EXISTS (\n              SELECT 1 FROM totp_recover' +
          'y_codes\n               WHERE user_id = ?3 AND cod' +
          'e_hash = ?5 AND used_by = ?1\n            )',
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
        'UPDATE totp_credentials SET\n           recovery_g' +
          'eneration = ?1,\n           last_used_step = ?2,\n' +
          '           last_used_by = ?1,\n           updated_' +
          'at = ?3\n         WHERE user_id = ?4\n           A' +
          'ND enabled_at IS NOT NULL\n           AND recovery' +
          '_generation = ?5\n           AND (last_used_step I' +
          'S NULL OR last_used_step < ?2)',
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
      'DELETE FROM sessions\n        WHERE user_id = ?1 A' +
        'ND id != ?2\n          AND EXISTS (\n            S' +
        'ELECT 1 FROM totp_credentials\n             WHERE ' +
        'user_id = ?1 AND recovery_generation = ?3\n       ' +
        '   )',
    ).bind(input.userId, input.sessionId, operationId),
    input.env.DB.prepare(
      'DELETE FROM totp_login_challenges\n        WHERE u' +
        'ser_id = ?1\n          AND EXISTS (\n            S' +
        'ELECT 1 FROM totp_credentials\n             WHERE ' +
        'user_id = ?1 AND recovery_generation = ?2\n       ' +
        '   )',
    ).bind(input.userId, operationId),
    input.env.DB.prepare(
      'DELETE FROM totp_recovery_codes\n        WHERE use' +
        'r_id = ?1\n          AND EXISTS (\n            SEL' +
        'ECT 1 FROM totp_credentials\n             WHERE us' +
        'er_id = ?1 AND recovery_generation = ?2\n         ' +
        ' )',
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

async function loadCredential(
  db: D1Database,
  userId: string,
): Promise<TotpCredentialRow | null> {
  return db
    .prepare(
      'SELECT secret_ciphertext, enabled_at,\n           ' +
        ' pending_token_hash, pending_session_id, pending_e' +
        'xpires_at,\n            recovery_generation, last_' +
        'used_step\n       FROM totp_credentials WHERE user' +
        '_id = ?1',
    )
    .bind(userId)
    .first<TotpCredentialRow>()
}

async function requireEnabledCredential(
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
