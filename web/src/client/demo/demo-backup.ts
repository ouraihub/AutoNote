import { Hono } from 'hono'
import { LIMITS } from '@shared/constants'
import { utf8ByteLength } from '@shared/text-utils'
import type {
  BackupMode,
  BackupRun,
  BackupTarget,
  BackupTargetConfig,
  BackupTargetInput,
  BackupTargetPatchInput,
  ImportResult,
} from '@shared/types'
import { readZip } from '@shared/zip'
import { exportResponse, importBundle, importMarkdown } from './transfer'
import { importBackupBatch } from './backup-transfer'
import { apiError } from './responses'
import { jsonBody } from './helpers'
import { newDemoId, type DemoState } from './state'

export function registerBackupImportRoutes(app: Hono, state: DemoState): void {
  app.get('/api/backup/targets', (c) =>
    c.json({ targets: [...state.backupTargets.values()] }),
  )
  app.post('/api/backup/targets', async (c) => {
    if (state.backupTargets.size >= LIMITS.backupTargetsMax) {
      return apiError(
        409,
        'conflict',
        `Each account can configure at most ${
          LIMITS.backupTargetsMax
        } backup targets`,
      )
    }
    const input = (await jsonBody(c.req.raw)) as unknown as BackupTargetInput
    const invalid = demoBackupTargetError(input, true)
    if (invalid) return apiError(400, 'bad_request', invalid)
    const target = createBackupTarget(input)
    state.backupTargets.set(target.id, target)
    return c.json(target, 201)
  })
  app.patch('/api/backup/targets/:id', async (c) => {
    const current = state.backupTargets.get(c.req.param('id'))
    if (!current) return apiError(404, 'not_found', 'Backup target not found')
    const input = (await jsonBody(
      c.req.raw,
    )) as unknown as BackupTargetPatchInput
    if (
      input.expectedUpdatedAt !== undefined &&
      (!Number.isSafeInteger(input.expectedUpdatedAt) ||
        input.expectedUpdatedAt < 0)
    ) {
      return apiError(
        400,
        'bad_request',
        'expectedUpdatedAt must be a non-negative integer',
      )
    }
    if (
      input.expectedUpdatedAt !== undefined &&
      input.expectedUpdatedAt !== current.updatedAt
    ) {
      return apiError(
        409,
        'conflict',
        'The backup target changed elsewhere. Refresh and try again',
      )
    }
    const changedType = input.type !== undefined && input.type !== current.type
    const mergedInput: BackupTargetInput = {
      type: input.type ?? current.type,
      name: input.name ?? current.name,
      enabled: input.enabled ?? current.enabled,
      config: input.config
        ? ({ ...current.config, ...input.config } as BackupTargetConfig)
        : current.config,
      ...(input.secret === undefined ? {} : { secret: input.secret }),
    }
    const invalid = demoBackupTargetError(mergedInput, changedType)
    if (invalid) return apiError(400, 'bad_request', invalid)
    const updated: BackupTarget = {
      ...current,
      type: mergedInput.type,
      name: mergedInput.name.trim(),
      enabled: mergedInput.enabled ?? true,
      config: demoBackupConfig(mergedInput),
      hasSecret:
        current.hasSecret ||
        hasDemoBackupSecret(mergedInput.type, input.secret),
      updatedAt: Math.max(Date.now(), current.updatedAt + 1),
    }
    state.backupTargets.set(updated.id, updated)
    return c.json(updated)
  })
  app.delete('/api/backup/targets/:id', (c) => {
    if (!state.backupTargets.delete(c.req.param('id'))) {
      return apiError(404, 'not_found', 'Backup target not found')
    }
    return c.json({ ok: true as const })
  })
  app.post('/api/backup/test', async (c) => {
    const input = (await jsonBody(c.req.raw)) as unknown as BackupTargetInput
    const invalid = demoBackupTargetError(input, true)
    return invalid
      ? apiError(400, 'bad_request', invalid)
      : c.json({
          ok: true,
          message:
            'Demo only: configuration validated locally; no remote ' +
            'connection was made',
          latencyMs: 0,
        })
  })
  app.post('/api/backup/targets/:id/test', async (c) => {
    const current = state.backupTargets.get(c.req.param('id'))
    if (!current) return apiError(404, 'not_found', 'Backup target not found')
    const input = (await jsonBody(
      c.req.raw,
    )) as unknown as BackupTargetPatchInput
    const changedType = input.type !== undefined && input.type !== current.type
    const mergedInput: BackupTargetInput = {
      type: input.type ?? current.type,
      name: input.name ?? current.name,
      enabled: input.enabled ?? current.enabled,
      config: input.config
        ? ({ ...current.config, ...input.config } as BackupTargetConfig)
        : current.config,
      ...(input.secret === undefined ? {} : { secret: input.secret }),
    }
    const invalid = demoBackupTargetError(
      mergedInput,
      changedType || !current.hasSecret,
    )
    return invalid
      ? apiError(400, 'bad_request', invalid)
      : c.json({
          ok: true,
          message:
            'Demo only: configuration validated locally; no remote ' +
            'connection was made',
          latencyMs: 0,
        })
  })
  app.post('/api/backup/run', async (c) => {
    const body = await jsonBody(c.req.raw)
    if (
      body.targetIds !== undefined &&
      (!Array.isArray(body.targetIds) ||
        body.targetIds.some(
          (id) =>
            typeof id !== 'string' || !/^[0-9a-hjkmnp-tv-z]{26}$/.test(id),
        ))
    ) {
      return apiError(
        400,
        'bad_request',
        'targetIds must be an array of valid backup target IDs',
      )
    }
    const selected = Array.isArray(body.targetIds)
      ? (body.targetIds as string[])
      : [...state.backupTargets.keys()]
    const targets = [...new Set(selected)]
      .map((id) => state.backupTargets.get(id))
      .filter((item): item is BackupTarget => Boolean(item?.enabled))
    const startedAt = Date.now()
    const results = targets.map((target) => ({
      targetId: target.id,
      targetName: target.name,
      targetType: target.type,
      ok: true,
      files: state.notes.size + state.attachments.size,
      bytes:
        [...state.notes.values()].reduce(
          (total, note) => total + utf8ByteLength(note.content),
          0,
        ) +
        [...state.attachments.values()].reduce(
          (total, item) => total + item.meta.size,
          0,
        ),
      ms: 0,
      error: null,
    }))
    const run: BackupRun = {
      id: newDemoId(),
      trigger: 'manual' as const,
      status: targets.length ? 'success' : 'failed',
      startedAt,
      finishedAt: Date.now(),
      noteCount: targets.length ? state.notes.size : 0,
      fileCount: results.reduce((total, result) => total + result.files, 0),
      bytes: results.reduce((total, result) => total + result.bytes, 0),
      results,
    }
    for (const target of targets)
      state.backupTargets.set(target.id, {
        ...target,
        lastRunAt: startedAt,
        lastStatus: 'success',
        lastError: null,
      })
    state.backupRuns.unshift(run)
    state.backupRuns.splice(LIMITS.backupRunsKept)
    return c.json(run)
  })
  app.get('/api/backup/runs', (c) => c.json({ runs: state.backupRuns }))

  app.get('/api/export', (c) =>
    exportResponse(state, c.req.query('format') === 'json' ? 'json' : 'zip'),
  )
  app.post('/api/import', async (c) => {
    const form = await c.req.raw.formData()
    const files = form
      .getAll('file')
      .filter((value): value is File => value instanceof File)
    const conflictValue = form.get('conflict') ?? 'duplicate'
    if (
      conflictValue !== 'skip' &&
      conflictValue !== 'newer' &&
      conflictValue !== 'duplicate'
    )
      return apiError(400, 'bad_request', 'Invalid import conflict strategy')
    const pathsValue: unknown = JSON.parse(
      String(
        form.get('backupPaths') ??
          JSON.stringify(files.map((file) => file.name)),
      ),
    )
    if (
      !Array.isArray(pathsValue) ||
      pathsValue.length !== files.length ||
      pathsValue.some(
        (path) =>
          typeof path !== 'string' ||
          path.includes('\\') ||
          path.split('/').includes('..'),
      )
    )
      return apiError(400, 'bad_request', 'Invalid backup paths')
    const paths = pathsValue as string[]
    if (files.length > LIMITS.importFilesMax) {
      return apiError(
        413,
        'payload_too_large',
        `The import cannot contain more than ${LIMITS.importFilesMax} files`,
      )
    }
    if (
      files.reduce((total, file) => total + file.size, 0) >
      LIMITS.importUploadMaxBytes
    ) {
      return apiError(
        413,
        'payload_too_large',
        'The import upload cannot exceed 64 MB',
      )
    }
    const result: ImportResult = {
      createdNotes: 0,
      updatedNotes: 0,
      skippedNotes: 0,
      createdFolders: 0,
      createdAttachments: 0,
      skippedAttachments: 0,
      warnings: [],
    }
    const manifest = form.get('backupManifest')
    if (typeof manifest === 'string') {
      try {
        await importBackupBatch(
          state,
          manifest,
          files,
          paths,
          conflictValue,
          result,
        )
      } catch (error) {
        result.warnings.push(
          error instanceof Error ? error.message : 'Backup import failed',
        )
      }
      state.cursor++
      return c.json(result)
    }
    for (const [index, value] of files.entries()) {
      try {
        if (value.name.toLowerCase().endsWith('.zip')) {
          const entries = await readZip(
            new Uint8Array(await value.arrayBuffer()),
            {
              maxEntries: LIMITS.importArchiveEntriesMax,
              maxEntryBytes: LIMITS.importArchiveExpandedMaxBytes,
              maxTotalBytes: LIMITS.importArchiveExpandedMaxBytes,
            },
          )
          const bundleEntry = entries.find((entry) =>
            entry.path.endsWith('autonote-export.json'),
          )
          if (!bundleEntry) {
            const backupEntry = entries.find((entry) =>
              /(?:^|\/)manifest\.json$/i.test(entry.path),
            )
            if (backupEntry) {
              await importBackupBatch(
                state,
                new TextDecoder().decode(backupEntry.data),
                entries.map(
                  (entry) =>
                    new File(
                      [entry.data.slice().buffer as ArrayBuffer],
                      entry.path,
                    ),
                ),
                entries.map((entry) => entry.path),
                conflictValue,
                result,
              )
            } else {
              for (const entry of entries)
                if (/\.(md|markdown|txt)$/i.test(entry.path))
                  importMarkdown(
                    state,
                    new TextDecoder().decode(entry.data),
                    entry.path,
                    conflictValue,
                    result,
                  )
            }
            continue
          }
          await importBundle(
            state,
            JSON.parse(new TextDecoder().decode(bundleEntry.data)),
            result,
            conflictValue,
            new Map(
              entries.map((entry) => [
                entry.path.toLocaleLowerCase(),
                entry.data,
              ]),
            ),
          )
        } else if (value.name.toLowerCase().endsWith('.json')) {
          if (value.size > LIMITS.importBundleMaxBytes) {
            throw new Error('The export file cannot exceed 32 MB')
          }
          await importBundle(
            state,
            JSON.parse(await value.text()),
            result,
            conflictValue,
          )
        } else {
          if (value.size > LIMITS.contentMaxBytes) {
            throw new Error('A note file cannot exceed 2 MB')
          }
          const content = await value.text()
          if (!/\.(md|markdown|txt)$/i.test(value.name))
            throw new Error('Select Markdown, JSON or ZIP files')
          importMarkdown(
            state,
            content,
            paths[index] ?? value.name,
            conflictValue,
            result,
          )
        }
      } catch (error) {
        result.warnings.push(
          `${value.name}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
      }
    }
    state.cursor++
    return c.json(result)
  })
}
function createBackupTarget(input: BackupTargetInput): BackupTarget {
  const now = Date.now()
  const type = input.type
  const config = demoBackupConfig(input)
  return {
    id: newDemoId(),
    type,
    name: input.name.trim(),
    enabled: input.enabled ?? true,
    config,
    hasSecret: hasDemoBackupSecret(type, input.secret),
    lastRunAt: null,
    lastStatus: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  }
}

function demoBackupConfig(input: BackupTargetInput): BackupTargetConfig {
  const mode: BackupMode = input.config.mode === 'mirror' ? 'mirror' : 'archive'
  return input.type === 's3'
    ? {
        endpoint: input.config.endpoint ?? '',
        region: input.config.region ?? 'auto',
        bucket: input.config.bucket ?? '',
        prefix: input.config.prefix ?? '',
        pathStyle: input.config.pathStyle ?? true,
        mode,
      }
    : {
        url: input.config.url ?? '',
        username: input.config.username ?? '',
        prefix: input.config.prefix ?? '',
        mode,
      }
}

function demoBackupTargetError(
  input: BackupTargetInput,
  requireSecret: boolean,
): string | null {
  if (input.type !== 's3' && input.type !== 'webdav')
    return 'type must be s3 or webdav'
  if (typeof input.name !== 'string' || !input.name.trim())
    return 'Enter a name'
  if (input.name.trim().length > 120)
    return 'The name must not exceed 120 characters'
  if (
    !input.config ||
    typeof input.config !== 'object' ||
    Array.isArray(input.config)
  ) {
    return 'config must be an object'
  }
  if (input.type === 's3') {
    if (
      typeof input.config.bucket !== 'string' ||
      !input.config.bucket.trim()
    ) {
      return 'Enter a bucket name'
    }
    if (requireSecret && !hasDemoBackupSecret('s3', input.secret)) {
      return 'Enter an Access Key and Secret Key'
    }
    return null
  }
  if (typeof input.config.url !== 'string' || !input.config.url.trim())
    return 'Enter a WebDAV URL'
  if (
    typeof input.config.username !== 'string' ||
    !input.config.username.trim()
  )
    return 'Enter a username'
  if (requireSecret && !hasDemoBackupSecret('webdav', input.secret))
    return 'Enter a password'
  return null
}

function hasDemoBackupSecret(
  type: BackupTargetInput['type'],
  secret: BackupTargetInput['secret'],
): boolean {
  if (type === 's3') {
    return Boolean(
      secret?.accessKeyId?.trim() && secret.secretAccessKey?.trim(),
    )
  }
  return Boolean(secret?.password?.trim())
}
