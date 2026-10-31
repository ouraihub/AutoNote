import { Hono } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { Protocol } from '@ouraihub/aether-ui/ports'
import { z } from 'zod'
import type { AppBindings } from '../env'
import { initializeDatabase } from '../db/schema'
import { ApiError, errorResponse } from '../lib/errors'
import { JSON_BODY_LIMITS, readJson } from '../lib/request'
import { requireAuth } from '../middleware/auth'
import { HTTP_STATUS, KitFailure, parseBody } from '../ai/kit'
import {
  addRelayRepo,
  createRelayKey,
  exchangeGithubToken,
  forward,
  forwardImage,
  listRelayKeys,
  listRelayRepos,
  relayEnabled,
  relayError,
  relayModels,
  removeRelayRepo,
  revokeRelayKey,
  setRelayEnabled,
  verifyRelayKey,
} from '../ai/relay'

const PAUSED = '模型转发已暂停，请在 AutoNote 设置中启用'

const kitError = (
  error: unknown,
  c: Parameters<typeof errorResponse>[0],
): Response =>
  error instanceof KitFailure
    ? c.json(
        { error: error.toJSON() },
        HTTP_STATUS[error.code] as ContentfulStatusCode,
      )
    : errorResponse(c, error)

export const relayRoutes = new Hono<
  AppBindings & {
    Variables: {
      relayUser: string
      relayKey: string
      relayMaxConcurrent: number
    }
  }
>()

const STATUS_TYPE: Record<number, string> = {
  400: 'invalid_request_error',
  401: 'authentication_error',
  403: 'permission_error',
  404: 'not_found_error',
  409: 'invalid_request_error',
  413: 'invalid_request_error',
  415: 'invalid_request_error',
  429: 'rate_limit_error',
}
const relayFailure = (status: number, message: string): Response =>
  relayError(status, STATUS_TYPE[status] ?? 'api_error', message)

relayRoutes.onError((error) => {
  if (error instanceof KitFailure)
    return relayFailure(HTTP_STATUS[error.code], error.message)
  if (error instanceof ApiError)
    return relayFailure(error.status, error.message)
  console.error('[autonote] Relay error:', error)
  return relayFailure(500, 'Internal server error')
})
relayRoutes.use('*', async (c, next) => {
  await initializeDatabase(c.env)
  await next()
})
relayRoutes.post('/github/token', async (c) => {
  const body = await readJson<{ token?: unknown }>(c, JSON_BODY_LIMITS.small)
  if (typeof body.token !== 'string')
    return relayError(400, 'invalid_request_error', 'token is required')
  return exchangeGithubToken(
    c.env,
    body.token,
    audience(c.req.raw, c.env.PUBLIC_URL),
  )
})
relayRoutes.use('/v1/*', async (c, next) => {
  const bearer = c.req.header('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]
  const auth = await verifyRelayKey(
    c.env.DB,
    (bearer ?? c.req.header('x-api-key') ?? '').trim(),
  )
  if (!auth)
    return relayError(401, 'authentication_error', 'invalid relay access key')
  if (!(await relayEnabled(c.env.DB, auth.userId)))
    return relayError(503, 'relay_paused', PAUSED)
  c.set('relayUser', auth.userId)
  c.set('relayKey', auth.keyId)
  c.set('relayMaxConcurrent', auth.maxConcurrent)
  await next()
})
relayRoutes.get('/v1/models', async (c) =>
  c.json({
    object: 'list',
    data: await relayModels(c.env.DB, c.get('relayUser')),
  }),
)
const ROUTES: [string, Protocol][] = [
  ['/v1/chat/completions', 'openai-chat'],
  ['/v1/responses', 'openai-responses'],
  ['/v1/messages', 'anthropic-messages'],
]
for (const [path, protocol] of ROUTES) {
  relayRoutes.post(path, (c) =>
    forward(
      c.env,
      c.get('relayUser'),
      c.get('relayKey'),
      c.get('relayMaxConcurrent'),
      protocol,
      c.req.raw,
    ),
  )
}
relayRoutes.post('/v1/images/generations', (c) =>
  forwardImage(
    c.env,
    c.get('relayUser'),
    c.get('relayKey'),
    c.get('relayMaxConcurrent'),
    c.req.raw,
    false,
  ),
)
relayRoutes.post('/v1/images/edits', (c) =>
  forwardImage(
    c.env,
    c.get('relayUser'),
    c.get('relayKey'),
    c.get('relayMaxConcurrent'),
    c.req.raw,
    true,
  ),
)
relayRoutes.all('*', () =>
  relayError(404, 'not_found_error', 'unknown relay path'),
)

function audience(request: Request, configured?: string): string {
  try {
    return new URL(configured ?? request.url).origin
  } catch {
    return new URL(request.url).origin
  }
}

const RepoSchema = z.strictObject({
  repo: z.string().regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/),
  workflow: z
    .string()
    .max(300)
    .regex(
      new RegExp(
        '^[A-Za-z0-9_.-]+\\/[A-Za-z0-9_.-]+\\/\\.github\\/workflows\\/' +
          '[A-Za-z0-9_./-]+\\.ya?ml$',
      ),
    ),
  ref: z
    .string()
    .regex(/^refs\/(heads|tags)\/[A-Za-z0-9_./-]{1,200}$/)
    .default('refs/heads/main'),
})
const KeySchema = z.strictObject({ name: z.string().trim().min(1).max(80) })
const EnabledSchema = z.strictObject({ enabled: z.boolean() })

export const relaySettingsRoutes = new Hono<AppBindings>()

relaySettingsRoutes.onError((error, c) => kitError(error, c))
relaySettingsRoutes.use('*', requireAuth)
relaySettingsRoutes.use('*', async (c, next) => {
  if (c.get('user').role !== 'owner')
    throw ApiError.forbidden('AI is available to the owner only')
  await next()
})
relaySettingsRoutes.get('/', async (c) => {
  const userId = c.get('userId')
  const origin = audience(c.req.raw, c.env.PUBLIC_URL)
  const [enabled, keys, repos, models] = await Promise.all([
    relayEnabled(c.env.DB, userId),
    listRelayKeys(c.env.DB, userId),
    listRelayRepos(c.env.DB, userId),
    relayModels(c.env.DB, userId),
  ])
  const protocols = [...new Set(models.map((model) => model.protocol))]
  return c.json({
    enabled,
    endpoint: `${origin}/relay/v1`,
    audience: origin,
    keys,
    repos,
    protocols,
  })
})
relaySettingsRoutes.put('/', async (c) => {
  const { enabled } = parseBody(
    EnabledSchema,
    await readJson(c, JSON_BODY_LIMITS.small),
  )
  await setRelayEnabled(c.env.DB, c.get('userId'), enabled)
  return c.json({ enabled })
})
relaySettingsRoutes.post('/keys', async (c) => {
  const { name } = parseBody(
    KeySchema,
    await readJson(c, JSON_BODY_LIMITS.small),
  )
  return c.json(await createRelayKey(c.env.DB, c.get('userId'), name), 201)
})
relaySettingsRoutes.delete('/keys/:id', async (c) => {
  if (!(await revokeRelayKey(c.env.DB, c.get('userId'), c.req.param('id'))))
    throw ApiError.notFound('Relay key not found')
  return c.json({ ok: true })
})
relaySettingsRoutes.post('/repos', async (c) => {
  await addRelayRepo(
    c.env.DB,
    c.get('userId'),
    parseBody(RepoSchema, await readJson(c, JSON_BODY_LIMITS.small)),
  )
  return c.json({ repos: await listRelayRepos(c.env.DB, c.get('userId')) })
})
relaySettingsRoutes.delete('/repos/:owner/:name', async (c) => {
  const repo = `${c.req.param('owner')}/${c.req.param('name')}`
  if (!(await removeRelayRepo(c.env.DB, c.get('userId'), repo)))
    throw ApiError.notFound('Repository not registered')
  return c.json({ repos: await listRelayRepos(c.env.DB, c.get('userId')) })
})
