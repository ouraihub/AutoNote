import { Hono } from 'hono'
import type { Context } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { timingSafeEqual } from '../lib/encoding'
import { FORM_BODY_LIMITS, readUrlEncodedFormWithinLimit } from '../lib/request'
import {
  getMcpPreferences,
  grantedMcpScopes,
  isMcpEnabled,
  MCP_SUPPORTED_SCOPES,
} from '../mcp/settings'
import {
  authorizationIssuer,
  authorizationResponseRedirect,
  oauthErrorRedirect,
  parseAuthorization,
} from './mcp-authorize-protocol'
import {
  applyLocalePreference,
  authorizationCopy,
  authorizationLocale,
} from './mcp-authorize-copy'
import { consentPage, errorPage, loginPage } from './mcp-authorize-pages'
import { randomToken } from './mcp-authorize-utils'

const CSRF_COOKIE = 'autonote_mcp_csrf'

export const mcpAuthorizeRoutes = new Hono<AppBindings>()

mcpAuthorizeRoutes.get('/authorize', async (c) => {
  const localeRedirect = applyLocalePreference(c)
  if (localeRedirect) return localeRedirect
  const locale = authorizationLocale(c)
  const parsed = await parseAuthorization(c.req.raw, c.env.OAUTH_PROVIDER)
  if (parsed instanceof Response) return parsed
  const copy = authorizationCopy(locale)
  if (!(await isMcpEnabled(c.env.DB))) {
    return html(c, errorPage(copy.mcpDisabled, locale, c.req.url), 403)
  }
  const client = await c.env.OAUTH_PROVIDER!.lookupClient(parsed.clientId)
  if (!client)
    return html(c, errorPage(copy.unknownClient, locale, c.req.url), 400)
  const csrf = randomToken()
  setCookie(c, CSRF_COOKIE, csrf, {
    path: '/authorize',
    httpOnly: true,
    sameSite: 'Lax',
    secure: new URL(c.req.url).protocol === 'https:',
    maxAge: 10 * 60,
  })
  c.header('Cache-Control', 'no-store')
  const user = c.get('user')
  return html(
    c,
    user
      ? consentPage({
          client,
          request: parsed,
          csrf,
          userName: user.name || user.login,
          action: new URL(c.req.url).pathname + new URL(c.req.url).search,
          locale,
          currentUrl: c.req.url,
        })
      : loginPage(client.clientName || 'MCP client', locale, c.req.url),
    200,
  )
})

mcpAuthorizeRoutes.post('/authorize', async (c) => {
  assertSameOrigin(c.req.raw)
  const locale = authorizationLocale(c)
  const copy = authorizationCopy(locale)
  const user = c.get('user')
  if (!user)
    return html(c, errorPage(copy.sessionExpired, locale, c.req.url), 401)
  if (!(await isMcpEnabled(c.env.DB))) {
    return html(c, errorPage(copy.mcpDisabled, locale, c.req.url), 403)
  }
  const parsed = await parseAuthorization(c.req.raw, c.env.OAUTH_PROVIDER)
  if (parsed instanceof Response) return parsed
  const body = await readUrlEncodedFormWithinLimit(
    c.req,
    FORM_BODY_LIMITS.authorization,
  )
  const submittedCsrf = body.get('csrf') ?? ''
  const storedCsrf = getCookie(c, CSRF_COOKIE) ?? ''
  if (
    !submittedCsrf ||
    !storedCsrf ||
    !timingSafeEqual(submittedCsrf, storedCsrf)
  ) {
    throw ApiError.forbidden(
      'Authorization form expired. Start the connection again.',
    )
  }
  setCookie(c, CSRF_COOKIE, '', { path: '/authorize', maxAge: 0 })

  if (body.get('decision') !== 'approve') {
    return Response.redirect(
      oauthErrorRedirect(
        parsed,
        'access_denied',
        'The user declined access',
        authorizationIssuer(c.req.raw, parsed),
      ),
      302,
    )
  }
  const client = await c.env.OAUTH_PROVIDER!.lookupClient(parsed.clientId)
  if (!client)
    return html(c, errorPage(copy.unknownClient, locale, c.req.url), 400)
  const selected = body
    .getAll('scope')
    .filter((scope) =>
      (MCP_SUPPORTED_SCOPES as readonly string[]).includes(scope),
    )
  const preferences = await getMcpPreferences(c.env.DB, user.id)
  const scopes = grantedMcpScopes(
    selected.length ? selected : parsed.scope,
    preferences,
  )
  const { redirectTo } = await c.env.OAUTH_PROVIDER!.completeAuthorization({
    request: parsed,
    userId: user.id,
    scope: scopes,
    metadata: {
      clientName: client.clientName || 'MCP client',
      clientUri: client.clientUri || null,
    },
    props: {
      userId: user.id,
      role: user.role,
      scopes,
    },
  })
  return Response.redirect(
    authorizationResponseRedirect(
      redirectTo,
      authorizationIssuer(c.req.raw, parsed),
    ),
    302,
  )
})

function html(
  c: Context<AppBindings>,
  body: string,
  status: 200 | 400 | 401 | 403 | 503,
): Response {
  return c.html(body, status)
}

function assertSameOrigin(request: Request): void {
  const origin = request.headers.get('Origin')
  if (origin && origin !== new URL(request.url).origin)
    throw ApiError.forbidden('Invalid form origin')
}
