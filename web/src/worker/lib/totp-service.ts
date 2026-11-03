import type { TotpLoginChallenge } from '@shared/types'

import { generateOpaqueToken, hashOpaqueToken, TOTP_LOGIN_TTL_MS } from './totp'

export async function hasEnabledTotp(
  db: D1Database,
  userId: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS present FROM totp_credentials
      WHERE user_id = ?1 AND enabled_at IS NOT NULL`,
    )
    .bind(userId)
    .first<{ present: number }>()
  return Boolean(row?.present)
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
      'INSERT INTO totp_login_challenges (id, user_id, ex' +
        'pires_at, created_at)\n     VALUES (?1, ?2, ?3, ?4' +
        ')',
    )
    .bind(challengeHash, userId, expiresAt, now)
    .run()
  return { twoFactorRequired: true, challengeToken, expiresAt }
}
export {
  getTotpStatus,
  startTotpSetup,
  cancelTotpSetup,
  confirmTotpSetup,
  regenerateRecoveryCodes,
  disableTotp,
} from './totp-management'
export { completeTotpLogin } from './totp-login'
export type { CompletedTotpLogin } from './totp-login'
