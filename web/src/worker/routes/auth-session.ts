import { Hono, type Context } from 'hono'
import { getCookie } from 'hono/cookie'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { hashPassword, validateNewPassword } from '../lib/password'
import { requireCurrentPassword } from '../lib/reauth'
import { readJson } from '../lib/request'
import {
  createSession,
  destroyOtherSessions,
  destroySession,
} from '../lib/session-store'
import {
  clearSessionCookie,
  sessionCookieNames,
  writeSessionCookie,
} from '../middleware/auth'

export const authSessionRoutes = new Hono<AppBindings>()

export async function rotateSession(
  c: Context<AppBindings>,
  userId: string,
): Promise<string> {
  await destroyPresentedSessions(c)
  return createSession(c.env.DB, userId)
}

async function destroyPresentedSessions(
  c: Context<AppBindings>,
): Promise<void> {
  const tokens = new Set(
    sessionCookieNames(c.req.url)
      .map((name) => getCookie(c, name))
      .filter((token): token is string => Boolean(token)),
  )
  await Promise.all([...tokens].map((token) => destroySession(c.env.DB, token)))
}

authSessionRoutes.post('/password', async (c) => {
  const user = c.get('user')
  if (!user) throw ApiError.unauthenticated()
  const body = await readJson<{
    currentPassword?: string
    newPassword?: string
  }>(c, 4096)
  const weak = validateNewPassword(body.newPassword)
  if (weak) throw new ApiError(400, 'weak_password', weak)

  const db = c.env.DB
  const expectedHash = await requireCurrentPassword(
    db,
    user.id,
    body.currentPassword,
  )
  const newHash = await hashPassword(body.newPassword!)
  const update = await db
    .prepare(
      'UPDATE users SET password_hash = ?1 ' +
        'WHERE id = ?2 AND password_hash = ?3',
    )
    .bind(newHash, user.id, expectedHash)
    .run()

  if (!update.meta.changes) {
    throw new ApiError(
      409,
      'conflict',
      'Account credentials changed elsewhere. Refresh and try again',
    )
  }

  await destroyOtherSessions(db, user.id, c.get('sessionId'))
  const token = await rotateSession(c, user.id)
  writeSessionCookie(c, token)
  return c.json({ ok: true })
})

authSessionRoutes.post('/logout', async (c) => {
  await destroyPresentedSessions(c)
  clearSessionCookie(c)
  return c.json({ ok: true })
})
