import {
  AuthorizationError,
  type AuthRequest,
} from '@cloudflare/workers-oauth-provider'
import type { AppBindings } from '../env'
import { MCP_SUPPORTED_SCOPES } from '../mcp/settings'

export async function parseAuthorization(
  request: Request,
  oauth = undefined as AppBindings['Bindings']['OAUTH_PROVIDER'],
): Promise<AuthRequest | Response> {
  if (!oauth) return new Response('OAuth is unavailable', { status: 503 })
  try {
    const parsed = await oauth.parseAuthRequest(request)
    const unsupported = parsed.scope.filter(
      (scope) =>
        scope !== 'offline_access' &&
        !(MCP_SUPPORTED_SCOPES as readonly string[]).includes(scope),
    )
    if (unsupported.length) {
      return Response.redirect(
        oauthErrorRedirect(
          parsed,
          'invalid_scope',
          `Unsupported scope: ${unsupported.join(' ')}`,
          authorizationIssuer(request, parsed),
        ),
        302,
      )
    }
    return parsed
  } catch (error) {
    if (!(error instanceof AuthorizationError)) throw error
    if (!error.redirectUri)
      return new Response(error.description, { status: 400 })
    const redirect = new URL(error.redirectUri)
    redirect.searchParams.set('error', error.code)
    redirect.searchParams.set('error_description', error.description)
    if (error.state) redirect.searchParams.set('state', error.state)
    redirect.searchParams.set(
      'iss',
      error.issuer ?? new URL(request.url).origin,
    )
    return Response.redirect(redirect.toString(), 302)
  }
}

export function authorizationIssuer(
  request: Request,
  parsed: AuthRequest,
): string {
  return parsed.issuer ?? new URL(request.url).origin
}

export function authorizationResponseRedirect(
  redirectTo: string,
  issuer: string,
): string {
  const redirect = new URL(redirectTo)
  const returnedIssuer = redirect.searchParams.get('iss')
  if (returnedIssuer && returnedIssuer !== issuer) {
    throw new Error('OAuth provider returned a mismatched authorization issuer')
  }
  redirect.searchParams.set('iss', issuer)
  return redirect.toString()
}

export function oauthErrorRedirect(
  request: AuthRequest,
  code: string,
  description: string,
  issuer: string,
): string {
  const redirect = new URL(request.redirectUri)
  redirect.searchParams.set('error', code)
  redirect.searchParams.set('error_description', description)
  if (request.state) redirect.searchParams.set('state', request.state)
  redirect.searchParams.set('iss', issuer)
  return redirect.toString()
}
