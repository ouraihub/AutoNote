import type { BackupTargetInput, BackupTargetResult } from '@shared/types'
import type { AppBindings } from '../env'
import type { TargetRow } from '../backup/engine'
import {
  BackupConfigError,
  normalizeBackupPrefix,
  normalizeS3Region,
  parseBackupEndpoint,
  validateS3Bucket,
} from '../backup/validation'
import { decryptSecret } from '../lib/crypto'
import { ApiError } from '../lib/errors'
import { consumeAttemptBudget, ThrottleError } from '../lib/throttle'
import type { Context } from 'hono'

export const OUTBOUND_BUDGETS = {
  test: { maxAttempts: 20, windowMs: 10 * 60 * 1000, lockMs: 10 * 60 * 1000 },
  run: { maxAttempts: 30, windowMs: 60 * 60 * 1000, lockMs: 60 * 60 * 1000 },
} as const

export async function enforceOutboundBudget(
  c: Context<AppBindings>,
  kind: keyof typeof OUTBOUND_BUDGETS,
): Promise<void> {
  const budget = OUTBOUND_BUDGETS[kind]
  try {
    await consumeAttemptBudget(c.env.DB, [
      { key: `backup-${kind}:${c.get('userId')}`, ...budget },
    ])
  } catch (error) {
    if (error instanceof ThrottleError) {
      throw new ApiError(
        429,
        'too_many_attempts',
        `Too many backup requests. Try again in ${error.retryAfterSec} seconds`,
        { retryAfter: error.retryAfterSec },
      )
    }
    throw error
  }
}

export async function loadTarget(
  db: D1Database,
  userId: string,
  id: string,
): Promise<TargetRow> {
  const row = await db
    .prepare(`SELECT * FROM backup_targets WHERE id = ?1 AND user_id = ?2`)
    .bind(id, userId)
    .first<TargetRow>()
  if (!row) throw ApiError.notFound('Backup target not found')
  return row
}

export async function currentSecret(
  c: { env: AppBindings['Bindings'] },
  target: TargetRow,
): Promise<Record<string, string>> {
  if (!target.secret) return {}
  return (
    (await decryptSecret<Record<string, string>>(
      c.env,
      target.id,
      target.secret,
    )) ?? {}
  )
}

export function mergeTargetInput(
  existing: TargetRow,
  incoming: Partial<BackupTargetInput>,
): BackupTargetInput {
  const config =
    incoming.config &&
    typeof incoming.config === 'object' &&
    !Array.isArray(incoming.config)
      ? incoming.config
      : {}
  const secret =
    incoming.secret &&
    typeof incoming.secret === 'object' &&
    !Array.isArray(incoming.secret)
      ? incoming.secret
      : undefined
  return {
    type: (incoming.type ?? existing.type) as BackupTargetInput['type'],
    name: incoming.name ?? existing.name,
    enabled: incoming.enabled ?? existing.enabled === 1,
    config: { ...safeObject(existing.config), ...config },
    ...(secret ? { secret } : {}),
  }
}

function safeObject(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw)
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

export function mergeSecret(
  current: Record<string, string>,
  incoming: NonNullable<BackupTargetInput['secret']>,
): Record<string, string> {
  const out = { ...current }
  for (const [k, v] of Object.entries(incoming)) {
    if (typeof v === 'string' && v.trim()) out[k] = v
  }
  return out
}

export function pickSecret(body: BackupTargetInput): Record<string, string> {
  const out: Record<string, string> = {}
  const keys =
    body.type === 's3' ? ['accessKeyId', 'secretAccessKey'] : ['password']
  for (const k of keys) {
    const v = body.secret?.[k as keyof NonNullable<BackupTargetInput['secret']>]
    if (typeof v === 'string' && v.trim()) out[k] = v
  }
  return out
}

export function normalizeConfig(body: BackupTargetInput): Record<string, unknown> {
  const c = body.config ?? {}
  const mode = 'archive'
  if (body.type === 's3') {
    return {
      endpoint: str(c.endpoint),
      region: normalizeS3Region(str(c.region)),
      bucket: str(c.bucket),
      prefix: normalizeBackupPrefix(str(c.prefix)),
      pathStyle: c.pathStyle !== false,
      mode,
    }
  }
  return {
    url: str(c.url),
    username: str(c.username),
    prefix: normalizeBackupPrefix(str(c.prefix)),
    mode,
  }
}

export function validateInput(body: BackupTargetInput, requireSecret: boolean): void {
  validateInputShape(body)
  if (body.type !== 's3' && body.type !== 'webdav')
    throw ApiError.badRequest('type must be s3 or webdav')
  if (typeof body.name !== 'string' || !body.name.trim())
    throw ApiError.badRequest('Enter a name')
  if (body.name.trim().length > 120)
    throw ApiError.badRequest('The name must not exceed 120 characters')

  const c = body.config ?? {}
  if (body.type === 's3') {
    assertConfigString(c.endpoint, 'Endpoint', 2048)
    assertConfigString(c.region, 'Region', 64)
    assertConfigString(c.bucket, 'Bucket', 255)
    assertConfigString(c.prefix, 'Path prefix', 1024)
    if (c.pathStyle !== undefined && typeof c.pathStyle !== 'boolean')
      throw ApiError.badRequest('pathStyle must be a boolean')
    if (!str(c.bucket)) throw ApiError.badRequest('Enter a bucket name')
    validateBackupConfig(() => normalizeS3Region(str(c.region)))
    validateBackupConfig(() => validateS3Bucket(str(c.bucket), c.pathStyle !== false))
    validateBackupConfig(() => normalizeBackupPrefix(str(c.prefix)))
    if (str(c.endpoint))
      validateBackupConfig(() => parseBackupEndpoint(str(c.endpoint), 'Endpoint'))
    if (requireSecret) assertRequiredSecret('s3', pickSecret(body))
  } else {
    assertConfigString(c.url, 'WebDAV address', 2048)
    assertConfigString(c.username, 'Username', 256)
    assertConfigString(c.prefix, 'Path prefix', 1024)
    const url = str(c.url)
    if (!url) throw ApiError.badRequest('Enter a WebDAV URL')
    validateBackupConfig(() => parseBackupEndpoint(url, 'WebDAV address'))
    validateBackupConfig(() => normalizeBackupPrefix(str(c.prefix)))
    if (!str(c.username)) throw ApiError.badRequest('Enter a username')
    if (requireSecret) assertRequiredSecret('webdav', pickSecret(body))
  }
}

export function validateInputShape(body: Partial<BackupTargetInput>): void {
  if (body.type !== undefined && body.type !== 's3' && body.type !== 'webdav')
    throw ApiError.badRequest('type must be s3 or webdav')
  if (body.name !== undefined && typeof body.name !== 'string')
    throw ApiError.badRequest('name must be a string')
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean')
    throw ApiError.badRequest('enabled must be a boolean')
  if (body.config !== undefined && (!body.config || typeof body.config !== 'object' || Array.isArray(body.config)))
    throw ApiError.badRequest('config must be an object')
  if (body.secret !== undefined && (!body.secret || typeof body.secret !== 'object' || Array.isArray(body.secret)))
    throw ApiError.badRequest('secret must be an object')
  if (body.config?.mode !== undefined && body.config.mode !== 'archive' && body.config.mode !== 'mirror')
    throw ApiError.badRequest('mode must be archive or mirror')
  for (const [key, value] of Object.entries(body.secret ?? {})) {
    if (!['password', 'accessKeyId', 'secretAccessKey'].includes(key))
      throw ApiError.badRequest(`Unknown credential field: ${key}`)
    if (value !== undefined && typeof value !== 'string')
      throw ApiError.badRequest(`${key} must be a string`)
    if (typeof value === 'string' && value.length > 4096)
      throw ApiError.badRequest(`${key} is too long`)
  }
}

export function assertRequiredSecret(
  type: BackupTargetInput['type'],
  secret: Record<string, string>,
): void {
  if (type === 's3') {
    if (!secret.accessKeyId?.trim() || !secret.secretAccessKey?.trim())
      throw ApiError.badRequest('Enter an Access Key and Secret Key')
    return
  }
  if (!secret.password?.trim()) throw ApiError.badRequest('Enter a password')
}

function assertConfigString(value: unknown, label: string, maxLength: number): void {
  if (value !== undefined && typeof value !== 'string')
    throw ApiError.badRequest(`${label} must be a string`)
  if (typeof value === 'string' && value.length > maxLength)
    throw ApiError.badRequest(`${label} is too long`)
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function validateBackupConfig(run: () => unknown): void {
  try {
    run()
  } catch (error) {
    if (error instanceof BackupConfigError) throw ApiError.badRequest(error.message)
    throw error
  }
}

export function parseResults(raw: string): BackupTargetResult[] {
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed)
      ? (parsed.filter((r) => r && r.targetId) as BackupTargetResult[])
      : []
  } catch {
    return []
  }
}
