import { z } from 'zod'
import type { Env } from '../../env'
import { fromBase64Url, fromUtf8, utf8 } from '../../lib/encoding'
import { KitFailure } from '../kit'
import { relayEnabled, relayModels, issueGithubKey } from './auth'
import { GITHUB_KEY_TTL_MS, normalizeWorkflow, relayError } from './shared'

const GITHUB_ISSUER = 'https://token.actions.githubusercontent.com'
const JwtHeader = z.object({ alg: z.literal('RS256'), kid: z.string() })
const GithubClaims = z.object({
  iss: z.literal(GITHUB_ISSUER),
  aud: z.union([z.string(), z.array(z.string())]),
  exp: z.number(),
  nbf: z.number().optional(),
  repository: z.string(),
  ref: z.string(),
  event_name: z.string(),
  workflow_ref: z.string(),
  job_workflow_ref: z.string().optional(),
  run_id: z.string().regex(/^\d+$/),
  run_attempt: z.string().regex(/^\d+$/),
  repository_id: z.string().regex(/^\d+$/),
})
const Jwks = z.object({ keys: z.array(z.object({ kid: z.string(), kty: z.literal('RSA'), n: z.string(), e: z.string() })) })

export async function verifyGithubToken(token: string, audience: string, now = Date.now()): Promise<z.infer<typeof GithubClaims>> {
  const deny = (reason: string): KitFailure => new KitFailure('unauthorized', `GitHub token rejected: ${reason}`, { reason })
  const parts = token.split('.')
  if (parts.length !== 3) throw deny('malformed')
  const [rawHeader, rawClaims, rawSignature] = parts as [string, string, string]
  let header: z.infer<typeof JwtHeader>
  let claims: z.infer<typeof GithubClaims>
  try {
    header = JwtHeader.parse(JSON.parse(fromUtf8(fromBase64Url(rawHeader))))
    claims = GithubClaims.parse(JSON.parse(fromUtf8(fromBase64Url(rawClaims))))
  } catch {
    throw deny('malformed')
  }
  const jwks = Jwks.parse(await (await fetch(`${GITHUB_ISSUER}/.well-known/jwks`)).json())
  const jwk = jwks.keys.find((key) => key.kid === header.kid)
  if (!jwk) throw deny('unknown_key')
  const key = await crypto.subtle.importKey('jwk', { kty: jwk.kty, n: jwk.n, e: jwk.e }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'])
  let signed: boolean
  try {
    signed = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, fromBase64Url(rawSignature), utf8(`${rawHeader}.${rawClaims}`))
  } catch {
    throw deny('signature')
  }
  if (!signed) throw deny('signature')
  const seconds = now / 1000
  if (claims.exp <= seconds || (claims.nbf !== undefined && claims.nbf > seconds + 60)) throw deny('expired')
  if (!(Array.isArray(claims.aud) ? claims.aud : [claims.aud]).includes(audience)) throw deny('audience')
  return claims
}

// Only runs started by a push, a manual dispatch or a schedule; PR, comment and workflow_run triggers may run untrusted code.
const TRUSTED_EVENTS = ['push', 'workflow_dispatch', 'schedule']

/** Exchanges a trusted run of the registered workflow for a 6-hour access key of the repository's user (docs/43 §5.2, §12). */
export async function exchangeGithubToken(env: Env, token: string, audience: string): Promise<Response> {
  const claims = await verifyGithubToken(token, audience)
  const repo = claims.repository.toLowerCase()
  const owner = await env.DB.prepare('SELECT user_id AS userId, workflow, ref, repository_id AS repositoryId FROM relay_github_repos WHERE repo = ?1')
    .bind(repo)
    .first<{ userId: string; workflow: string; ref: string; repositoryId: string | null }>()
  if (!owner) return relayError(403, 'permission_error', `repository ${claims.repository} is not registered for the relay`)
  const deny = (reason: string): KitFailure => new KitFailure('unauthorized', `GitHub token rejected: ${reason}`, { reason })
  if (owner.repositoryId !== null && owner.repositoryId !== claims.repository_id) throw deny('repository_id')
  if (claims.ref !== owner.ref) throw deny('ref')
  if (!TRUSTED_EVENTS.includes(claims.event_name)) throw deny('event')
  // A reusable workflow job carries `job_workflow_ref`; a plain workflow only has `workflow_ref`.
  const workflowRef = claims.job_workflow_ref ?? claims.workflow_ref
  const at = workflowRef.indexOf('@')
  if (at <= 0 || at === workflowRef.length - 1) throw deny('workflow')
  const running = normalizeWorkflow(workflowRef.slice(0, at))
  if (running !== owner.workflow) throw deny('workflow')
  if (!(await relayEnabled(env.DB, owner.userId))) return relayError(503, 'relay_paused', '模型转发已暂停，请在 AutoNote 设置中启用')
  const models = await relayModels(env.DB, owner.userId)
  // Pinning and issuance share one transaction, so only a successful exchange can claim the repository identity.
  const expiresAt = Date.now() + GITHUB_KEY_TTL_MS
  const run = `${repo}#${claims.run_id}#${claims.run_attempt}`
  const key = await issueGithubKey(env.DB, { ...owner, repo }, claims.repository_id, run, expiresAt)
  return Response.json({ key, expiresAt, models })
}