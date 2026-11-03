import { Hono } from 'hono'
import { LIMITS } from '@shared/constants'
import type { McpSettingsInfo } from '@shared/types'
import { newDemoId, type DemoState } from './state'
import { apiError } from './responses'
import { jsonBody, sessionInfo, siteInfo } from './helpers'

const DEMO_CREDENTIALS = { username: 'admin', password: 'password' } as const

export function registerCoreRoutes(
  app: Hono,
  state: DemoState,
  mcp: McpSettingsInfo,
): void {
  app.get('/api/site', (c) => c.json(siteInfo(state)))
  app.get('/api/auth/session', (c) => c.json(sessionInfo(state)))
  app.post('/api/auth/login', async (c) => {
    const body = await jsonBody(c.req.raw)
    const username =
      typeof body.username === 'string'
        ? body.username.trim().toLowerCase()
        : ''
    const password = typeof body.password === 'string' ? body.password : ''
    if (username !== DEMO_CREDENTIALS.username || password !== state.password) {
      return apiError(
        401,
        'invalid_credentials',
        'Invalid username or password',
      )
    }
    state.authenticated = true
    return c.json(sessionInfo(state))
  })
  app.post('/api/auth/register', () =>
    apiError(403, 'registration_closed', 'Registration is closed'),
  )
  app.post('/api/auth/logout', (c) => {
    state.authenticated = false
    return c.json({ ok: true as const })
  })
  app.get('/api/auth/totp/status', (c) =>
    c.json({
      available: false,
      enabled: false,
      enabledAt: null,
      recoveryCodesRemaining: 0,
    }),
  )
  app.post('/api/auth/password', async (c) => {
    const body = await jsonBody(c.req.raw)
    if (body.currentPassword !== state.password) {
      return apiError(
        401,
        'wrong_password',
        'The current password is incorrect',
      )
    }
    if (typeof body.newPassword !== 'string' || body.newPassword.length < 8) {
      return apiError(
        400,
        'weak_password',
        'The new password must contain at least 8 characters',
      )
    }
    if (body.newPassword.length > LIMITS.passwordMaxLength) {
      return apiError(400, 'weak_password', 'The new password is too long')
    }
    state.password = body.newPassword
    return c.json({ ok: true as const })
  })
  app.put('/api/auth/profile', async (c) => {
    const body = await jsonBody(c.req.raw)
    if (body.name !== undefined) {
      if (
        typeof body.name !== 'string' ||
        !body.name.trim() ||
        body.name.trim().length > 64
      ) {
        return apiError(
          400,
          'invalid_profile_name',
          'Enter a valid display name',
        )
      }
      state.user = {
        ...state.user,
        name: body.name.trim().replace(/\s+/g, ' '),
      }
    }
    if (body.avatarUrl !== undefined) {
      if (
        typeof body.avatarUrl !== 'string' ||
        !(
          body.avatarUrl === '' ||
          /^dicebear:[0-9a-f]{32}$/.test(body.avatarUrl) ||
          /^data:image\/(?:png|jpeg|webp);base64,/.test(body.avatarUrl)
        )
      ) {
        return apiError(
          400,
          'invalid_avatar',
          'Choose a generated avatar or upload an image',
        )
      }
      state.user = { ...state.user, avatarUrl: body.avatarUrl }
    }
    state.cursor++
    return c.json(state.user)
  })
  app.put('/api/settings/registration', async (c) => {
    const body = await jsonBody(c.req.raw)
    if (body.password !== state.password) {
      return apiError(
        401,
        'wrong_password',
        'The current password is incorrect',
      )
    }
    state.registrationOpen = body.enabled === true
    return c.json({
      ok: true as const,
      registrationOpen: state.registrationOpen,
    })
  })

  app.get('/api/mcp', (c) =>
    c.json({ ...mcp, endpoint: `${new URL(c.req.url).origin}/mcp` }),
  )
  app.put('/api/mcp', async (c) => {
    const body = await jsonBody(c.req.raw)
    for (const key of ['enabled', 'writeEnabled', 'trashEnabled'] as const) {
      if (body[key] !== undefined && typeof body[key] !== 'boolean')
        return apiError(400, 'bad_request', 'Invalid MCP preference')
    }
    if (typeof body.enabled === 'boolean') mcp.enabled = body.enabled
    mcp.preferences = {
      writeEnabled:
        typeof body.writeEnabled === 'boolean'
          ? body.writeEnabled
          : mcp.preferences.writeEnabled,
      trashEnabled:
        typeof body.trashEnabled === 'boolean'
          ? body.trashEnabled
          : mcp.preferences.trashEnabled,
      updatedAt: Date.now(),
    }
    return c.json({
      enabled: mcp.enabled,
      preferences: mcp.preferences,
      reconnectRequired: false,
    })
  })
  app.post('/api/mcp/keys', async (c) => {
    const body = await jsonBody(c.req.raw)
    if (
      typeof body.name !== 'string' ||
      !body.name.trim() ||
      body.name.length > 120
    )
      return apiError(400, 'bad_request', 'Enter a valid key name')
    const key = {
      id: newDemoId(),
      name: body.name.trim(),
      scopes: [
        'notes:read',
        ...(mcp.preferences.writeEnabled ? ['notes:write'] : []),
      ],
      createdAt: Date.now(),
      lastUsedAt: null,
    }
    mcp.apiKeys.push(key)
    return c.json({ key, token: `demo-only-${newDemoId()}` }, 201)
  })
  app.delete('/api/mcp/keys/:id', (c) => {
    const index = mcp.apiKeys.findIndex((key) => key.id === c.req.param('id'))
    if (index < 0) return apiError(404, 'not_found', 'Key not found')
    mcp.apiKeys.splice(index, 1)
    return c.json({ ok: true })
  })
  app.delete('/api/mcp/grants/:id', (c) => {
    const index = mcp.grants.findIndex(
      (grant) => grant.id === c.req.param('id'),
    )
    if (index < 0) return apiError(404, 'not_found', 'Grant not found')
    mcp.grants.splice(index, 1)
    return c.json({ ok: true })
  })
  app.post('/api/mcp/grants/revoke-all', (c) => {
    const revoked = mcp.grants.length
    mcp.grants = []
    return c.json({ ok: true, revoked })
  })
  app.get('/api/mcp/ai-search', (c) => c.json(mcp.aiSearch))
  app.all('/api/mcp/*', () =>
    apiError(403, 'forbidden', 'Remote AI is unavailable in the demo'),
  )
}
