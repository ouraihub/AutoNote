import { Hono, type Context } from 'hono'
import { getCookie } from 'hono/cookie'
import { isBitmapAvatarDataUrl, PROFILE_NAME_MAX_LENGTH } from '@shared/avatar'
import type { AppBindings } from '../env'
import {
  discardStoredAvatar,
  normalizeAvatarPreference,
  persistUploadedAvatar,
  storedAvatarCleanup,
  type StoredAvatarObject,
} from '../avatars/storage'
import { ApiError } from '../lib/errors'
import { attachmentCleanupTarget } from '../attachments/keys'
import { drainAttachmentCleanup } from '../attachments/cleanup'
import { loadUser, publicUser } from '../lib/session-info'
import { hashPassword, validateNewPassword } from '../lib/password'
import { requireCurrentPassword } from '../lib/reauth'
import { JSON_BODY_LIMITS, readJson } from '../lib/request'
import { commitChange } from '../lib/notify'
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

export const profileRoutes = new Hono<AppBindings>()

async function destroyPresentedSessions(c: Context<AppBindings>): Promise<void> {
  const tokens = new Set(
    sessionCookieNames(c.req.url)
      .map((name) => getCookie(c, name))
      .filter((token): token is string => Boolean(token)),
  )
  await Promise.all([...tokens].map((token) => destroySession(c.env.DB, token)))
}

async function rotateSession(c: Context<AppBindings>, userId: string): Promise<string> {
  await destroyPresentedSessions(c)
  return createSession(c.env.DB, userId)
}

profileRoutes.put('/profile', async (c) => {
  const current = c.get('user')
  if (!current) throw ApiError.unauthenticated()
  const body = await readJson<{ name?: unknown; avatarUrl?: unknown }>(
    c,
    JSON_BODY_LIMITS.profile,
  )
  const hasName = Object.prototype.hasOwnProperty.call(body, 'name')
  const hasAvatar = Object.prototype.hasOwnProperty.call(body, 'avatarUrl')
  if (!hasName && !hasAvatar) {
    throw ApiError.badRequest('Provide a display name or avatar')
  }

  const name = hasName ? normalizeDisplayName(body.name) : current.name
  if (name === null) {
    throw new ApiError(
      400,
      'invalid_profile_name',
      `Display name must contain 1-${PROFILE_NAME_MAX_LENGTH} characters`,
    )
  }
  let avatarUrl = hasAvatar
    ? normalizeAvatarPreference(body.avatarUrl)
    : current.avatarUrl
  if (avatarUrl === null) {
    throw new ApiError(
      400,
      'invalid_avatar',
      'Choose a generated avatar or upload a supported image',
    )
  }

  if (name === current.name && avatarUrl === current.avatarUrl) {
    return c.json(publicUser(current))
  }

  let storedAvatar: StoredAvatarObject | null = null
  if (hasAvatar && isBitmapAvatarDataUrl(avatarUrl)) {
    storedAvatar = await persistUploadedAvatar(c.env, current.id, avatarUrl)
    avatarUrl = storedAvatar.preference
  }

  const statements: D1PreparedStatement[] = []
  const previousAvatar = hasAvatar
    ? storedAvatarCleanup(current.avatarUrl)
    : null
  if (previousAvatar) {
    statements.push(
      c.env.DB.prepare(
        `INSERT OR IGNORE INTO attachment_cleanup (object_key, user_id, created_at)
         SELECT ?1, id, ?2 FROM users WHERE id = ?3 AND avatar_url = ?4`,
      ).bind(
        attachmentCleanupTarget(previousAvatar.storage, previousAvatar.key),
        Date.now(),
        current.id,
        current.avatarUrl,
      ),
    )
  }
  statements.push(
    c.env.DB.prepare(
      `UPDATE users SET
         name = CASE WHEN ?1 = 1 THEN ?2 ELSE name END,
         avatar_url = CASE WHEN ?3 = 1 THEN ?4 ELSE avatar_url END
       WHERE id = ?5 AND (?3 = 0 OR avatar_url = ?6)`,
    ).bind(
      hasName ? 1 : 0,
      name,
      hasAvatar ? 1 : 0,
      avatarUrl,
      current.id,
      current.avatarUrl,
    ),
  )

  let results: D1Result[]
  try {
    results = await c.env.DB.batch(statements)
  } catch (error) {
    if (storedAvatar) await discardStoredAvatar(c.env, storedAvatar)
    throw error
  }
  const updated = results.at(-1)
  if (!updated?.meta.changes) {
    if (storedAvatar) await discardStoredAvatar(c.env, storedAvatar)
    throw ApiError.conflict(
      'The profile changed elsewhere. Refresh and try again',
    )
  }

  if (previousAvatar) {
    await drainAttachmentCleanup(c.env, current.id).catch((error) => {
      console.warn(
        '[autonote] Replaced avatar cleanup will retry later:',
        error,
      )
    })
  }

  await commitChange(c, 'profile', current.id, 'upsert')
  const user = await loadUser(c.env, current.id)
  if (!user) throw ApiError.unauthenticated()
  return c.json(publicUser(user))
})

profileRoutes.post('/password', async (c) => {
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
      `UPDATE users SET password_hash = ?1 WHERE id = ?2 AND password_hash = ?3`,
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

profileRoutes.post('/logout', async (c) => {
  await destroyPresentedSessions(c)
  clearSessionCookie(c)
  return c.json({ ok: true })
})

export function normalizeDisplayName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().replace(/\s+/gu, ' ')
  if (
    !normalized ||
    [...normalized].length > PROFILE_NAME_MAX_LENGTH ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(normalized)
  ) {
    return null
  }
  return normalized
}
