import { Hono } from 'hono'
import { LIMITS } from '@shared/constants'
import { truncateText } from '@shared/text-utils'
import type {
  BackupRun,
  BackupTargetInput,
  BackupTargetPatchInput,
} from '@shared/types'
import type { AppBindings } from '../env'
import { runBackup, testTarget, toBackupTarget, type TargetRow } from '../backup/engine'
import { encryptSecret } from '../lib/crypto'
import { ApiError } from '../lib/errors'
import { isValidId, newId } from '../lib/id'
import { JSON_BODY_LIMITS, readJson, readOptionalJson } from '../lib/request'
import { requireAuth } from '../middleware/auth'
import {
  currentSecret,
  enforceOutboundBudget,
  loadTarget,
  mergeSecret,
  mergeTargetInput,
  normalizeConfig,
  parseResults,
  pickSecret,
  assertRequiredSecret,
  validateInput,
  validateInputShape,
} from './backup-validation'

export const backupRoutes = new Hono<AppBindings>()

backupRoutes.use('*', requireAuth)

backupRoutes.get('/targets', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM backup_targets WHERE user_id = ?1 ORDER BY created_at ASC`,
  )
    .bind(c.get('userId'))
    .all<TargetRow>()
  return c.json({ targets: results.map(toBackupTarget) })
})

backupRoutes.post('/targets', async (c) => {
  const userId = c.get('userId')
  const body = await readJson<BackupTargetInput>(c, JSON_BODY_LIMITS.backup)
  validateInput(body, true)

  const id = newId()
  const now = Date.now()
  const config = normalizeConfig(body)
  const secret = await encryptSecret(c.env, id, pickSecret(body))

  const inserted = await c.env.DB.prepare(
    `INSERT INTO backup_targets (id, user_id, type, name, enabled, config, secret, created_at, updated_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8
      WHERE (SELECT COUNT(*) FROM backup_targets WHERE user_id = ?2) < ?9`,
  )
    .bind(
      id,
      userId,
      body.type,
      truncateText(body.name.trim(), 120),
      body.enabled === false ? 0 : 1,
      JSON.stringify(config),
      secret,
      now,
      LIMITS.backupTargetsMax,
    )
    .run()
  if (!inserted.meta.changes) {
    throw ApiError.conflict(
      `Each account can configure at most ${LIMITS.backupTargetsMax} backup targets`,
    )
  }

  return c.json(toBackupTarget(await loadTarget(c.env.DB, userId, id)), 201)
})

backupRoutes.patch('/targets/:id', async (c) => {
  const userId = c.get('userId')
  const id = c.req.param('id')
  const existing = await loadTarget(c.env.DB, userId, id)
  const body = await readJson<BackupTargetPatchInput>(
    c,
    JSON_BODY_LIMITS.backup,
  )
  validateInputShape(body)
  if (
    body.expectedUpdatedAt !== undefined &&
    (!Number.isSafeInteger(body.expectedUpdatedAt) ||
      body.expectedUpdatedAt < 0)
  ) {
    throw ApiError.badRequest(
      'expectedUpdatedAt must be a non-negative integer',
    )
  }

  const merged = mergeTargetInput(existing, body)
  validateInput(merged, false)

  const hasNewSecret = Boolean(
    body.secret &&
    Object.values(body.secret).some(
      (value) => typeof value === 'string' && value.trim(),
    ),
  )
  const changedType = merged.type !== existing.type
  let secret = existing.secret
  if (hasNewSecret || changedType) {
    const current = changedType ? {} : await currentSecret(c, existing)
    const nextSecret = mergeSecret(current, body.secret ?? {})
    assertRequiredSecret(merged.type, nextSecret)
    secret = await encryptSecret(c.env, id, nextSecret)
  }

  const updatedAt = Math.max(Date.now(), existing.updated_at + 1)
  const updated = await c.env.DB.prepare(
    `UPDATE backup_targets SET type = ?1, name = ?2, enabled = ?3, config = ?4, secret = ?5, updated_at = ?6
       WHERE id = ?7 AND user_id = ?8 AND updated_at = ?9`,
  )
    .bind(
      merged.type,
      truncateText(merged.name.trim(), 120),
      merged.enabled === false ? 0 : 1,
      JSON.stringify(normalizeConfig(merged)),
      secret,
      updatedAt,
      id,
      userId,
      body.expectedUpdatedAt ?? existing.updated_at,
    )
    .run()
  if (!updated.meta.changes) {
    throw ApiError.conflict(
      'The backup target changed elsewhere. Refresh and try again',
    )
  }

  return c.json(toBackupTarget(await loadTarget(c.env.DB, userId, id)))
})

backupRoutes.delete('/targets/:id', async (c) => {
  const res = await c.env.DB.prepare(
    `DELETE FROM backup_targets WHERE id = ?1 AND user_id = ?2`,
  )
    .bind(c.req.param('id'), c.get('userId'))
    .run()
  if (!res.meta.changes) throw ApiError.notFound('Backup target not found')
  return c.json({ ok: true })
})

backupRoutes.post('/targets/:id/test', async (c) => {
  await enforceOutboundBudget(c, 'test')
  const target = await loadTarget(c.env.DB, c.get('userId'), c.req.param('id'))
  const override = await readJson<Partial<BackupTargetInput>>(
    c,
    JSON_BODY_LIMITS.backup,
  )
  validateInputShape(override)
  const merged = mergeTargetInput(target, override)
  validateInput(merged, false)

  const draft: TargetRow = {
    ...target,
    type: merged.type,
    name: merged.name,
    enabled: merged.enabled === false ? 0 : 1,
    config: JSON.stringify(normalizeConfig(merged)),
  }
  const current =
    merged.type === target.type ? await currentSecret(c, target) : {}
  const secret = mergeSecret(current, override.secret ?? {})
  assertRequiredSecret(merged.type, secret)
  const result = await testTarget(c.env, draft, secret)
  return c.json(result)
})

backupRoutes.post('/test', async (c) => {
  await enforceOutboundBudget(c, 'test')
  const body = await readJson<BackupTargetInput>(c, JSON_BODY_LIMITS.backup)
  validateInput(body, true)
  const draft: TargetRow = {
    id: 'draft',
    user_id: c.get('userId'),
    type: body.type,
    name: body.name || 'Untitled',
    enabled: 1,
    config: JSON.stringify(normalizeConfig(body)),
    secret: null,
    last_run_at: null,
    last_status: null,
    last_error: null,
    created_at: Date.now(),
    updated_at: Date.now(),
  }
  const result = await testTarget(c.env, draft, pickSecret(body))
  return c.json(result)
})

backupRoutes.post('/run', async (c) => {
  await enforceOutboundBudget(c, 'run')
  const userId = c.get('userId')
  const body = await readOptionalJson<{ targetIds?: string[] }>(
    c,
    JSON_BODY_LIMITS.small,
    {},
  )
  if (
    body.targetIds !== undefined &&
    (!Array.isArray(body.targetIds) ||
      body.targetIds.some((id) => !isValidId(id)))
  ) {
    throw ApiError.badRequest(
      'targetIds must be an array of valid backup target IDs',
    )
  }
  if (body.targetIds && !body.targetIds.length)
    throw ApiError.badRequest('Select at least one backup target')
  const targetIds = body.targetIds ? [...new Set(body.targetIds)] : undefined
  if ((targetIds?.length ?? 0) > LIMITS.backupTargetsMax) {
    throw ApiError.badRequest(
      `Select at most ${LIMITS.backupTargetsMax} backup targets`,
    )
  }
  const run = await runBackup(c.env, userId, { trigger: 'manual', targetIds })
  return c.json(run)
})

backupRoutes.get('/runs', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, trigger, status, started_at, finished_at, note_count, file_count, bytes, detail
       FROM backup_runs WHERE user_id = ?1 ORDER BY started_at DESC LIMIT 50`,
  )
    .bind(c.get('userId'))
    .all<{
      id: string
      trigger: string
      status: string
      started_at: number
      finished_at: number | null
      note_count: number
      file_count: number
      bytes: number
      detail: string
    }>()

  const runs: BackupRun[] = results.map((row) => ({
    id: row.id,
    trigger: row.trigger as BackupRun['trigger'],
    status: row.status as BackupRun['status'],
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    noteCount: row.note_count,
    fileCount: row.file_count,
    bytes: row.bytes,
    results: parseResults(row.detail),
  }))
  return c.json({ runs })
})
