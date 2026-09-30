import { ApiError } from './errors'
import { PASSWORD_MAX_LENGTH, verifyPassword } from './password'
import {
  assertNotLocked,
  clearLoginFailures,
  consumeAttemptBudget,
  recordLoginFailure,
  ThrottleError,
} from './throttle'


export async function requireCurrentPassword(
  db: D1Database,
  userId: string,
  input: unknown,
): Promise<string> {
  const throttleKeys = [`pw:${userId}`]
  const workKeys = [{ key: `pw-work:${userId}`, maxAttempts: 8, windowMs: 10 * 60 * 1000 }]
  try {
    await consumeAttemptBudget(db, workKeys)
    await assertNotLocked(db, throttleKeys)
  } catch (err) {
    if (err instanceof ThrottleError) {
      throw new ApiError(429, 'too_many_attempts', `Too many attempts. Try again in ${err.retryAfterSec} seconds`, {
        retryAfter: err.retryAfterSec,
      })
    }
    throw err
  }

  const row = await db
    .prepare(`SELECT password_hash FROM users WHERE id = ?1`)
    .bind(userId)
    .first<{ password_hash: string }>()
  if (!row) throw ApiError.unauthenticated()

  const password = typeof input === 'string' && input.length <= PASSWORD_MAX_LENGTH ? input : ''
  if (!(await verifyPassword(password, row.password_hash))) {
    await recordLoginFailure(db, throttleKeys)
    throw new ApiError(401, 'wrong_password', "The current password is incorrect")
  }
  await clearLoginFailures(db, [...throttleKeys, workKeys[0]!.key])
  return row.password_hash
}
