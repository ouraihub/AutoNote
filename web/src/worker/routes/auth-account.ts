import { Hono, type Context } from 'hono'
import { getCookie } from 'hono/cookie'
import { DEFAULT_SETTINGS } from '@shared/constants'
import type { AppBindings, Env } from '../env'
import type { AppLocale, UserSettings } from '@shared/types'
import { seedWorkspace } from '../db/seed'
import { ApiError } from '../lib/errors'
import { newId } from '../lib/id'
import { getAllowRegistration } from '../lib/instance-settings'
import { loadUser, sessionInfo } from '../lib/session-info'
import { hashPassword, normalizeUsername, USERNAME_PATTERN, validateNewPassword } from '../lib/password'
import { readJson, requestClientIp } from '../lib/request'
import { createSession, destroySession } from '../lib/session-store'
import { consumeAttemptBudget, ThrottleError } from '../lib/throttle'
import { sessionCookieNames, writeSessionCookie } from '../middleware/auth'

export const accountRoutes = new Hono<AppBindings>()

export type RegistrationDecision =
  | { ok: true; role: 'owner' | 'member' }
  | { ok: false; reason: 'registration_closed' }

export function decideRegistration(input: {
  userCount: number
  registrationOpen: boolean
}): RegistrationDecision {
  if (input.userCount === 0) return { ok: true, role: 'owner' }
  if (input.registrationOpen) return { ok: true, role: 'member' }
  return { ok: false, reason: 'registration_closed' }
}

async function gate(env: Env): Promise<RegistrationDecision> {
  const countRow = await env.DB.prepare(
    `SELECT 1 AS n FROM users LIMIT 1`,
  ).first<{ n: number }>()
  return decideRegistration({
    userCount: countRow?.n ?? 0,
    registrationOpen: await getAllowRegistration(env.DB),
  })
}

async function rotateSession(
  c: Context<AppBindings>,
  userId: string,
): Promise<string> {
  const tokens = new Set(
    sessionCookieNames(c.req.url)
      .map((name) => getCookie(c, name))
      .filter((token): token is string => Boolean(token)),
  )
  await Promise.all([...tokens].map((token) => destroySession(c.env.DB, token)))
  return createSession(c.env.DB, userId)
}

accountRoutes.post('/register', async (c) => {
  const body = await readJson<{
    username?: string
    password?: string
    locale?: string
  }>(c, 4096)
  const locale = normalizeLocale(body.locale ?? c.req.header('Accept-Language'))
  const rawUsername =
    typeof body.username === 'string' ? body.username.slice(0, 128) : ''
  const username = normalizeUsername(rawUsername)
  if (!USERNAME_PATTERN.test(username)) {
    throw new ApiError(
      400,
      'invalid_username',
      'Username must contain 3-32 lowercase letters, numbers, underscores, or hyphens',
    )
  }
  const weak = validateNewPassword(body.password)
  if (weak) throw new ApiError(400, 'weak_password', weak)

  if (!(await gate(c.env)).ok) {
    throw new ApiError(
      403,
      'registration_closed',
      'Registration is closed on this instance',
    )
  }

  await enforceAttemptBudget(c.env.DB, [
    {
      key: `register-work:${requestClientIp(c)}`,
      maxAttempts: 12,
      windowMs: 10 * 60 * 1000,
    },
  ])

  const db = c.env.DB
  const id = newId()
  const now = Date.now()
  const result = await db
    .prepare(
      `INSERT INTO users
         (id, username, password_hash, login, name, avatar_url, role, settings, created_at, last_seen_at)
       SELECT ?1, ?2, ?3, ?2, ?2, '',
              CASE WHEN NOT EXISTS (SELECT 1 FROM users) THEN 'owner' ELSE 'member' END,
              ?4, ?5, ?5
        WHERE NOT EXISTS (SELECT 1 FROM users)
           OR COALESCE((SELECT value FROM app_meta WHERE key = 'setting:allow_registration'), '0') = '1'
       ON CONFLICT(username) DO NOTHING`,
    )
    .bind(
      id,
      username,
      await hashPassword(body.password!),
      JSON.stringify(settingsFor(locale)),
      now,
    )
    .run()

  if (!result.meta.changes) {
    const taken = await db
      .prepare(`SELECT id FROM users WHERE username = ?1`)
      .bind(username)
      .first()
    if (taken)
      throw new ApiError(
        409,
        'username_taken',
        'That username is already in use',
      )
    throw new ApiError(
      403,
      'registration_closed',
      'Registration is closed on this instance',
    )
  }

  await seedWorkspace(c.env, id, locale).catch((err) => {
    console.warn(
      '[autonote] Failed to initialize sample content; the account remains usable:',
      err,
    )
  })
  const token = await rotateSession(c, id)
  writeSessionCookie(c, token)
  const user = await loadUser(c.env, id)
  if (!user) throw new Error('created_user_missing')
  return c.json(await sessionInfo(c.env, user), 201)
})

async function enforceAttemptBudget(
  db: D1Database,
  targets: Parameters<typeof consumeAttemptBudget>[1],
): Promise<void> {
  try {
    await consumeAttemptBudget(db, targets)
  } catch (err) {
    if (err instanceof ThrottleError) {
      throw new ApiError(
        429,
        'too_many_attempts',
        `Too many attempts. Try again in ${err.retryAfterSec} seconds`,
        {
          retryAfter: err.retryAfterSec,
        },
      )
    }
    throw err
  }
}

function normalizeLocale(value: unknown): AppLocale {
  return typeof value === 'string' && value.toLowerCase().startsWith('en')
    ? 'en-US'
    : 'zh-CN'
}

function settingsFor(locale: AppLocale): UserSettings {
  return {
    ...DEFAULT_SETTINGS,
    appearance: { ...DEFAULT_SETTINGS.appearance, language: locale },
    editor: { ...DEFAULT_SETTINGS.editor },
    preview: { ...DEFAULT_SETTINGS.preview },
    backup: { ...DEFAULT_SETTINGS.backup },
    sync: { ...DEFAULT_SETTINGS.sync },
  }
}
