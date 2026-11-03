import type { ProbeResult, Protocol } from '@ouraihub/aether-ui/ports'
import type { Env } from '../../env'

import { outbound } from '../outbound'
import { probe as probeProvider } from '@ouraihub/aether-core/providers'
import { notFound } from '../kit'
import { type ProbeTargetInput } from './schema'

import { endpointKeys, openKey, rotatedKeys } from './key-rotation'

export async function ownedEndpoint(
  db: D1Database,
  userId: string,
  id: string,
): Promise<{
  baseUrl: string
  protocol: Protocol
  headers: Record<string, string>
}> {
  const row = await db
    .prepare(
      'SELECT base_url AS baseUrl, protocol, headers FROM' +
        ' ai_endpoints WHERE id = ?1 AND user_id = ?2',
    )
    .bind(id, userId)
    .first<{ baseUrl: string; protocol: Protocol; headers: string }>()
  if (!row) throw notFound('endpoint')
  return { ...row, headers: JSON.parse(row.headers) as Record<string, string> }
}

/**
 * Keys a probe tries: just `keyId` when given, else the rotated enabled keys.
 */
async function probeKeys(
  env: Env,
  userId: string,
  endpointId: string,
  keyId?: string,
): Promise<string[]> {
  if (keyId === undefined) return rotatedKeys(env, userId, endpointId)
  const row = (await endpointKeys(env.DB, userId, endpointId)).find(
    (key) => key.id === keyId,
  )
  if (!row) throw notFound('key')
  return [await openKey(env, row)]
}

export async function probe(
  env: Env,
  userId: string,
  target: ProbeTargetInput,
  signal: AbortSignal,
): Promise<ProbeResult> {
  let baseUrl: string
  let protocol: Protocol
  let keys: string[] = []
  let headers: Record<string, string> = {}
  if (target.kind === 'saved') {
    ;({ baseUrl, protocol, headers } = await ownedEndpoint(
      env.DB,
      userId,
      target.endpointId,
    ))
    keys = await probeKeys(env, userId, target.endpointId)
  } else {
    baseUrl = target.baseUrl
    protocol = target.protocol
    if (target.endpointId !== undefined) {
      ;({ headers } = await ownedEndpoint(env.DB, userId, target.endpointId))
      keys = await probeKeys(env, userId, target.endpointId, target.keyId)
    } else if (target.keyId !== undefined) throw notFound('key')
  }
  return probeProvider(outbound(env), {
    endpoint: {
      endpointId: target.endpointId ?? null,
      baseUrl,
      protocol,
      keys,
      headers,
    },
    signal,
  })
}
