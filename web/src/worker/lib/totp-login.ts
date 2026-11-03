import { SESSION_TTL_MS } from '@shared/constants'

import type { Env } from '../env'
import { decryptTotpSecret } from './crypto'

import { newId } from './id'
import { hashToken, newSessionToken } from './session-store'

import {
  hashOpaqueToken,
  hashRecoveryCode,
  isOpaqueToken,
  matchTotpCode,
  normalizeRecoveryCode,
} from './totp'

import {
  countRecoveryCodes,
  factorThrottle,
  consumeWorkBudget,
  assertFactorUnlocked,
  rejectFactor,
  clearFactorAttempts,
  challengeExpired,
  factorUnavailable,
  changed,
} from './totp-helpers'

interface TotpLoginRow {
  user_id: string
  expires_at: number
  secret_ciphertext: string
  recovery_generation: string
  last_used_step: number | null
}

export interface CompletedTotpLogin {
  userId: string
  sessionToken: string
  recoveryCodeUsed: boolean
  recoveryCodesRemaining: number | null
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
    'SELECT ch.user_id, ch.expires_at,\n            c.s' +
      'ecret_ciphertext, c.recovery_generation, c.last_us' +
      'ed_step\n       FROM totp_login_challenges ch\n   ' +
      '    JOIN totp_credentials c ON c.user_id = ch.user' +
      '_id\n      WHERE ch.id = ?1 AND c.enabled_at IS NO' +
      'T NULL',
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
        'UPDATE totp_recovery_codes SET used_at = ?1, used_' +
          'by = ?2\n          WHERE user_id = ?3\n           ' +
          ' AND code_hash = ?4\n            AND generation = ' +
          '?5\n            AND used_at IS NULL\n            A' +
          'ND EXISTS (\n              SELECT 1 FROM totp_logi' +
          'n_challenges\n               WHERE id = ?6 AND use' +
          'r_id = ?3 AND expires_at > ?1 AND claimed_by IS NU' +
          'LL\n            )',
      ).bind(
        now,
        operationId,
        row.user_id,
        codeHash,
        row.recovery_generation,
        challengeHash,
      ),
      input.env.DB.prepare(
        'UPDATE totp_login_challenges SET claimed_by = ?1\n' +
          '          WHERE id = ?2 AND user_id = ?3 AND expir' +
          'es_at > ?4 AND claimed_by IS NULL\n            AND' +
          ' EXISTS (\n              SELECT 1 FROM totp_recove' +
          'ry_codes\n               WHERE user_id = ?3 AND co' +
          'de_hash = ?5 AND used_by = ?1\n            )',
      ).bind(operationId, challengeHash, row.user_id, now, codeHash),
      input.env.DB.prepare(
        'INSERT INTO sessions (id, user_id, expires_at, cre' +
          'ated_at)\n         SELECT ?1, ?2, ?3, ?4\n        ' +
          '  WHERE EXISTS (\n            SELECT 1 FROM totp_r' +
          'ecovery_codes\n             WHERE user_id = ?2 AND' +
          ' code_hash = ?5 AND used_by = ?6\n          )\n   ' +
          '         AND EXISTS (\n              SELECT 1 FROM' +
          ' totp_login_challenges WHERE id = ?7 AND claimed_b' +
          'y = ?6\n            )',
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
        'DELETE FROM totp_login_challenges WHERE id = ?1 AN' +
          'D claimed_by = ?2',
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
        'UPDATE totp_credentials SET\n           last_used_' +
          'step = ?1,\n           last_used_by = ?2,\n       ' +
          '    updated_at = ?3\n         WHERE user_id = ?4\n' +
          '           AND enabled_at IS NOT NULL\n           ' +
          'AND recovery_generation = ?5\n           AND (last' +
          '_used_step IS NULL OR last_used_step < ?1)\n      ' +
          '     AND EXISTS (\n             SELECT 1 FROM totp' +
          '_login_challenges\n              WHERE id = ?6 AND' +
          ' user_id = ?4 AND expires_at > ?3 AND claimed_by I' +
          'S NULL\n           )',
      ).bind(
        step,
        operationId,
        now,
        row.user_id,
        row.recovery_generation,
        challengeHash,
      ),
      input.env.DB.prepare(
        'UPDATE totp_login_challenges SET claimed_by = ?1\n' +
          '          WHERE id = ?2 AND user_id = ?3 AND expir' +
          'es_at > ?4 AND claimed_by IS NULL\n            AND' +
          ' EXISTS (\n              SELECT 1 FROM totp_creden' +
          'tials\n               WHERE user_id = ?3 AND last_' +
          'used_by = ?1\n            )',
      ).bind(operationId, challengeHash, row.user_id, now),
      input.env.DB.prepare(
        'INSERT INTO sessions (id, user_id, expires_at, cre' +
          'ated_at)\n         SELECT ?1, ?2, ?3, ?4\n        ' +
          '  WHERE EXISTS (\n            SELECT 1 FROM totp_c' +
          'redentials\n             WHERE user_id = ?2 AND la' +
          'st_used_by = ?5\n          )\n            AND EXIS' +
          'TS (\n              SELECT 1 FROM totp_login_chall' +
          'enges WHERE id = ?6 AND claimed_by = ?5\n         ' +
          '   )',
      ).bind(
        sessionHash,
        row.user_id,
        expiresAt,
        now,
        operationId,
        challengeHash,
      ),
      input.env.DB.prepare(
        'DELETE FROM totp_login_challenges WHERE id = ?1 AN' +
          'D claimed_by = ?2',
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
