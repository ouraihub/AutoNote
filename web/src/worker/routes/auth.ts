import { Hono, type Context } from 'hono'
import type { AppBindings } from '../env'
import type { SessionInfo } from '@shared/types'
import { buildSiteInfo, sessionInfo } from '../lib/session-info'
import { rowToUser } from '../middleware/auth'
import {
  dummyVerify,
  isPasswordHash,
  normalizeUsername,
  PASSWORD_MAX_LENGTH,
  USERNAME_PATTERN,
  verifyPassword,
} from '../lib/password'
import { ApiError } from '../lib/errors'
import { requestClientIp, readJson } from '../lib/request'
import { createTotpLoginChallenge, hasEnabledTotp } from '../lib/totp-service'
import {
  assertNotLocked,
  clearLoginFailures,
  consumeAttemptBudget,
  recordLoginFailure,
  type ThrottleTarget,
  ThrottleError,
} from '../lib/throttle'
import { createSession } from '../lib/session-store'
import { USER_COLUMNS, writeSessionCookie } from '../middleware/auth'
import { accountRoutes } from './auth-account'
import { profileRoutes } from './auth-profile'

export const authRoutes = new Hono<AppBindings>()
export { normalizeAvatarPreference } from '../avatars/storage'
export { decideRegistration } from './auth-account'
export { normalizeDisplayName } from './auth-profile'

authRoutes.route('/', accountRoutes)
authRoutes.route('/', profileRoutes)

export function loginThrottleTargets(username: string, ip: string): ThrottleTarget[] {
  const identity = USERNAME_PATTERN.test(username) ? username : '_invalid'
  return [
    { key: `login:${ip}:${identity}`, freeFails: 5 },
    { key: `login-ip:${ip}`, freeFails: 25 },
    { key: `login-account:${identity}`, freeFails: 30 },
  ]
}

export function loginWorkTargets(username: string, ip: string) {
  const identity = USERNAME_PATTERN.test(username) ? username : '_invalid'
  const windowMs = 10 * 60 * 1000
  return [
    { key: `login-work:${ip}:${identity}`, maxAttempts: 8, windowMs },
    { key: `login-work-ip:${ip}`, maxAttempts: 30, windowMs },
  ]
}

async function rotateSession(c: Context<AppBindings>, userId: string): Promise<string> {
  return createSession(c.env.DB, userId)
}


authRoutes.get('/session', async (c) => {
  const user = c.get('user')
  if (user) return c.json(await sessionInfo(c.env, user))
  const body: SessionInfo = { user: null, site: await buildSiteInfo(c.env), settings: null }
  return c.json(body)
})

authRoutes.post('/login', async (c) => {
  const body = await readJson<{ username?: string; password?: string }>(c, 4096)
  const rawUsername = typeof body.username === 'string' ? body.username.slice(0, 128) : ''
  const username = normalizeUsername(rawUsername)
  const password = typeof body.password === 'string' ? body.password : ''
  const db = c.env.DB
  const throttleTargets = loginThrottleTargets(username, requestClientIp(c))
  const workTargets = loginWorkTargets(username, requestClientIp(c))
  try {
    await assertNotLocked(db, throttleTargets)
    await consumeAttemptBudget(db, workTargets)
  } catch (err) {
    if (err instanceof ThrottleError)
      throw new ApiError(429, 'too_many_attempts', `Too many attempts. Try again in ${err.retryAfterSec} seconds`, { retryAfter: err.retryAfterSec })
    throw err
  }
  const row = USERNAME_PATTERN.test(username)
    ? await db.prepare(`SELECT ${USER_COLUMNS}, password_hash FROM users WHERE username = ?1`).bind(username).first<Parameters<typeof rowToUser>[0] & { password_hash: string }>()
    : null
  let valid = false
  if (row?.password_hash && password.length <= PASSWORD_MAX_LENGTH && isPasswordHash(row.password_hash)) valid = await verifyPassword(password, row.password_hash)
  else await dummyVerify()
  if (!valid || !row) {
    await recordLoginFailure(db, throttleTargets)
    throw new ApiError(401, 'invalid_credentials', 'Incorrect username or password')
  }
  await clearLoginFailures(db, [...throttleTargets.map((target) => target.key), ...workTargets.map((target) => target.key)])
  if (await hasEnabledTotp(db, row.id)) return c.json(await createTotpLoginChallenge(db, row.id))
  const token = await rotateSession(c, row.id)
  writeSessionCookie(c, token)
  return c.json(await sessionInfo(c.env, rowToUser(row)))
})
