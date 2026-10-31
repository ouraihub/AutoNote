import type { Env } from '../env'
import type { TotpStatus } from '@shared/types'

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

export async function getTotpStatus(
  env: Env,
  userId: string,
): Promise<TotpStatus> {
  const row = await env.DB.prepare(
    `SELECT c.enabled_at, COUNT(r.code_hash) AS recovery_codes
       FROM totp_credentials c
       LEFT JOIN totp_recovery_codes r
         ON r.user_id = c.user_id
        AND r.generation = c.recovery_generation
        AND r.used_at IS NULL
      WHERE c.user_id = ?1
      GROUP BY c.user_id, c.enabled_at`,
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
