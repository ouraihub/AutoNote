import { ApiError } from '../lib/errors'
import type { AppBindings } from '../env'
import type { ExistingNoteIndex } from './transfer/types'
import { FORM_BODY_LIMITS } from '../lib/request'
import { Hono } from 'hono'
import type { ImportResult } from '@shared/types'
import { LIMITS } from '@shared/constants'
import { acquireLease } from '../lib/lease'
import { addWarning } from './transfer/values'
import { assertBundleCanBeRestored } from '../backup/snapshot'
import { broadcastCursor } from '../lib/notify'
import { buildJsonExport } from '../backup/snapshot'
import { buildObsidianAssetIndex } from '../lib/obsidian-import'
import { buildSnapshot } from '../backup/snapshot'
import { collectAttachmentArchivePaths } from './transfer/archive'
import { createBackupArchive } from '../backup/archive'
import { formatBytes } from './transfer/values'
import { formatStamp } from '../backup/snapshot'
import { importBackupFileBatch } from './transfer/backup'
import { importBundle } from './transfer/bundle'
import { importMarkdown } from './transfer/markdown'
import { isAutoNoteBackupManifest } from './transfer/values'
import { isBackupControlPath } from './transfer/values'
import { isExportBundlePath } from './transfer/values'
import { isImportableEntryPath } from './transfer/values'
import { isMarkdownBackupControlPath } from './transfer/values'
import { isMarkdownPath } from './transfer/values'
import { mapBundleAttachmentEntries } from './transfer/archive'
import { parseImportConflict } from './transfer/values'
import { parsePostedBackupManifest } from './transfer/archive'
import { parsePostedBackupPaths } from './transfer/archive'
import { primeFolderCache } from './transfer/folders'
import { pruneOrphanTags } from '../db/writes'
import { readFormDataWithinLimit } from '../lib/request'
import { readZip } from '@shared/zip'
import { requireAuth } from '../middleware/auth'
import { scheduleFtsDrain } from '../lib/notify'
import { selectCompleteZipBackup } from './transfer/archive'

export const transferRoutes = new Hono<AppBindings>()

transferRoutes.use('/export', requireAuth)

transferRoutes.use('/import', requireAuth)

transferRoutes.use('/import', async (c, next) => {
  const release = await acquireLease(
    c.env.DB,
    `import_lock:${c.get('userId')}`,
    15 * 60 * 1000,
    'An import is already running. Try again later',
  )

  try {
    await next()
  } finally {
    await release()
  }
})

transferRoutes.get('/export', async (c) => {
  const userId = c.get('userId')
  const release = await acquireLease(
    c.env.DB,
    `snapshot_lock:${userId}`,
    15 * 60 * 1000,
    'A backup or export is already running. Try again later',
  )
  try {
    const format = c.req.query('format') === 'json' ? 'json' : 'zip'

    if (format === 'json') {
      const bundle = await buildJsonExport(c.env, userId)
      assertBundleCanBeRestored(bundle.byteLength)
      return new Response(bundle as BodyInit, {
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition':
            'attachment; filename="autonote-export-' +
            `${formatStamp(new Date())}.json"`,
          'Cache-Control': 'private, no-store',
        },
      })
    }

    const snapshot = await buildSnapshot(c.env, userId)
    const archive = createBackupArchive(snapshot)
    const fixed = new FixedLengthStream(archive.byteLength)
    void archive.stream.pipeTo(fixed.writable).catch((error) => {
      console.error('[autonote] Streaming ZIP export failed:', error)
    })
    return new Response(fixed.readable as BodyInit, {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${archive.filename}"`,
        'Cache-Control': 'private, no-store',
      },
    })
  } finally {
    await release()
  }
})

transferRoutes.post('/import', async (c) => {
  const userId = c.get('userId')
  const { ftsEnabled } = c.get('database')
  const form = await readFormDataWithinLimit(c.req, FORM_BODY_LIMITS.import)

  const conflict = parseImportConflict(form.get('conflict'))
  const files = form.getAll('file').filter((f): f is File => f instanceof File)
  if (!files.length) throw ApiError.badRequest('No files were selected')
  if (files.length > LIMITS.importFilesMax) {
    throw ApiError.badRequest(`Import at most ${LIMITS.importFilesMax} files`)
  }
  const uploadBytes = files.reduce((sum, file) => sum + file.size, 0)
  if (
    !Number.isSafeInteger(uploadBytes) ||
    uploadBytes > LIMITS.importUploadMaxBytes ||
    files.some((file) => file.size > LIMITS.importUploadMaxBytes)
  ) {
    throw ApiError.tooLarge(
      'A single import cannot exceed ' +
        formatBytes(LIMITS.importUploadMaxBytes),
    )
  }
  const backupManifest = parsePostedBackupManifest(form.get('backupManifest'))
  const backupPaths = parsePostedBackupPaths(
    form.get('backupPaths'),
    files.length,
  )
  const selectedFiles = files.map((file, index) => ({
    file,
    path: backupPaths?.[index] ?? file.name,
  }))

  const result: ImportResult = {
    createdNotes: 0,
    updatedNotes: 0,
    skippedNotes: 0,
    createdFolders: 0,
    createdAttachments: 0,
    skippedAttachments: 0,
    warnings: [],
  }

  const byId = new Map<string, ExistingNoteIndex | null>()

  const folderCache = new Map<string, string>()
  if (!backupManifest || backupManifest.notes.length) {
    await primeFolderCache(c.env.DB, userId, folderCache)
  }

  if (backupManifest) {
    try {
      await importBackupFileBatch(c, userId, selectedFiles, backupManifest, {
        conflict,
        byId,
        folderCache,
        result,
        ftsEnabled,
      })
    } catch (error) {
      if (error instanceof ApiError) throw error
      throw ApiError.badRequest(
        error instanceof Error ? error.message : String(error),
      )
    }
    if (backupManifest.notes.length) {
      await pruneOrphanTags(c.env.DB, userId)
      await broadcastCursor(c)
      scheduleFtsDrain(c, 20)
    }
    return c.json(result)
  }

  for (const selected of selectedFiles) {
    const file = selected.file
    const name = selected.path.toLowerCase()
    let strictBackup = false
    try {
      if (name.endsWith('.zip')) {
        const bytes = new Uint8Array(await file.arrayBuffer())
        const zipOptions = {
          maxEntries: LIMITS.importArchiveEntriesMax,
          maxEntryBytes: LIMITS.importArchiveExpandedMaxBytes,
          maxTotalBytes: LIMITS.importArchiveExpandedMaxBytes,
        }
        const controls = await readZip(bytes, {
          ...zipOptions,
          maxEntryBytes: LIMITS.importUploadMaxBytes,
          maxTotalBytes: LIMITS.importUploadMaxBytes + 1024,
          include: isBackupControlPath,
        })
        strictBackup = controls.some(
          (entry) =>
            isMarkdownBackupControlPath(entry.path) ||
            isAutoNoteBackupManifest(entry),
        )
        const backup = await selectCompleteZipBackup(controls)
        if (strictBackup && !backup) {
          throw new Error(
            'The AutoNote backup ZIP is missing a valid manifest ' +
              'or COMPLETE marker',
          )
        }
        if (backup) {
          if (backup.warning) addWarning(result, backup.warning)
          const expected = new Set(
            [...backup.manifest.notes, ...backup.manifest.attachments].map(
              (entry) => `${backup.rootPrefix}${entry.path}`.toLowerCase(),
            ),
          )
          const entries = await readZip(bytes, {
            ...zipOptions,
            maxEntryBytes: LIMITS.importUploadMaxBytes,
            include: (path) => expected.has(path.toLowerCase()),
          })
          if (entries.length !== expected.size)
            throw new Error('The backup ZIP is missing one or more files')
          await importBackupFileBatch(
            c,
            userId,
            entries.map((entry) => ({
              file: new File(
                [entry.data],
                entry.path.split('/').at(-1) ?? 'file',
              ),
              path: entry.path.slice(backup.rootPrefix.length),
            })),
            backup.manifest,
            { conflict, byId, folderCache, result, ftsEnabled },
          )
          continue
        }

        const bundles = controls.filter((entry) =>
          isExportBundlePath(entry.path),
        )
        const bundleEntry = bundles[0]
        if (bundles.length > 1) {
          throw new Error(
            'The ZIP contains multiple autonote-export.json files ' +
              'and is ambiguous',
          )
        }
        if (bundleEntry) {
          const rawBundle = JSON.parse(
            new TextDecoder().decode(bundleEntry.data),
          ) as unknown
          const expectedAttachmentPaths = collectAttachmentArchivePaths(
            rawBundle,
            bundleEntry.path,
          )
          const attachmentEntries = expectedAttachmentPaths.size
            ? await readZip(bytes, {
                ...zipOptions,
                maxEntryBytes: LIMITS.attachmentMaxBytes,
                include: (path) =>
                  expectedAttachmentPaths.has(path.toLowerCase()),
              })
            : []
          await importBundle(c, userId, rawBundle, {
            conflict,
            byId,
            folderCache,
            result,
            ftsEnabled,
            attachmentEntries: mapBundleAttachmentEntries(
              attachmentEntries,
              bundleEntry.path,
            ),
          })
        } else {
          const entries = await readZip(bytes, {
            ...zipOptions,
            maxEntryBytes: LIMITS.attachmentMaxBytes,
            include: isImportableEntryPath,
          })
          const assets = buildObsidianAssetIndex(
            entries.filter((entry) => !isMarkdownPath(entry.path)),
          )
          for (const entry of entries) {
            if (!isMarkdownPath(entry.path)) continue
            await importMarkdown(
              c,
              userId,
              entry.path,
              new TextDecoder().decode(entry.data),
              {
                folderCache,
                result,
                ftsEnabled,
                assets,
              },
            )
          }
        }
      } else if (name.endsWith('.json')) {
        if (file.size > LIMITS.importBundleMaxBytes) {
          throw new Error(
            'The export file cannot exceed ' +
              formatBytes(LIMITS.importBundleMaxBytes),
          )
        }
        await importBundle(c, userId, JSON.parse(await file.text()), {
          conflict,
          byId,
          folderCache,
          result,
          ftsEnabled,
        })
      } else if (/\.(md|markdown|txt)$/i.test(name)) {
        if (file.size > LIMITS.contentMaxBytes) {
          throw new Error(
            `Note content cannot exceed ${formatBytes(LIMITS.contentMaxBytes)}`,
          )
        }
        await importMarkdown(c, userId, selected.path, await file.text(), {
          folderCache,
          result,
          ftsEnabled,
        })
      } else {
        addWarning(result, `Skipped unsupported file: ${selected.path}`)
      }
    } catch (err) {
      if (strictBackup) {
        if (err instanceof ApiError) throw err
        throw ApiError.badRequest(
          selected.path +
            ': ' +
            (err instanceof Error ? err.message : String(err)),
        )
      }
      addWarning(
        result,
        `${selected.path}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  await pruneOrphanTags(c.env.DB, userId)
  await broadcastCursor(c)
  scheduleFtsDrain(c, 20)
  return c.json(result)
})
export {
  parseImportConflict,
  importedBundleTitle,
  importedMarkdownTitle,
} from './transfer/values'
export { runBatched } from '../db/writes'
