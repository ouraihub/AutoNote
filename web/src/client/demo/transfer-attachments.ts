import { LIMITS } from '@shared/constants'
import type { ExportAttachment, ImportResult } from '@shared/types'
import { newDemoId, type DemoState } from './state'
import { revokeAttachment } from './responses'
import { sha256Hex } from './transfer-utils'

export async function importBundleAttachments(
  state: DemoState,
  rawAttachments: ExportAttachment[],
  archiveEntries: Map<string, Uint8Array>,
  result: ImportResult,
): Promise<{
  urls: Map<string, string>
  sourceNotes: Map<string, string | null>
}> {
  const prepared: Array<{
    sourceId: string
    sourceNoteId: string | null
    id: string
    filename: string
    mime: string
    width: number | null
    height: number | null
    createdAt: number
    data: Uint8Array
  }> = []
  let importedBytes = 0
  const sourceIds = new Set<string>()
  const manifestPaths = new Set<string>()
  for (const raw of rawAttachments) {
    if (
      !raw ||
      typeof raw !== 'object' ||
      typeof raw.id !== 'string' ||
      !/^[0-9a-hjkmnp-tv-z]{26}$/.test(raw.id)
    )
      throw new Error('The export contains an invalid attachment ID')
    if (sourceIds.has(raw.id))
      throw new Error(
        `The export contains a duplicate attachment ID: ${raw.id}`,
      )
    sourceIds.add(raw.id)
    if (
      typeof raw.path !== 'string' ||
      !raw.path ||
      typeof raw.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/i.test(raw.sha256)
    )
      throw new Error(
        `The export contains invalid attachment metadata: ${raw.id}`,
      )
    const pathSegments = raw.path.split('/')
    if (
      raw.path.length > 512 ||
      raw.path.includes('\\') ||
      pathSegments.length !== 3 ||
      pathSegments[0] !== 'attachments' ||
      pathSegments[1] !== raw.id ||
      !pathSegments[2] ||
      /[\x00-\x1f]/.test(pathSegments[2])
    )
      throw new Error(
        `The export contains an invalid attachment path: ${raw.id}`,
      )
    const pathKey = raw.path.toLocaleLowerCase()
    if (manifestPaths.has(pathKey))
      throw new Error(
        `The export contains a duplicate attachment path: ${raw.path}`,
      )
    manifestPaths.add(pathKey)
    const filename = typeof raw.filename === 'string' ? raw.filename : ''
    const mime = typeof raw.mime === 'string' ? raw.mime : ''
    if (!filename || filename.length > 180 || !mime || mime.length > 255)
      throw new Error(
        `The export contains invalid attachment metadata: ${raw.id}`,
      )
    const data = archiveEntries.get(pathKey)
    if (!data) {
      result.skippedAttachments++
      result.warnings.push(
        `${filename}: attachment bytes are missing from the backup and were` +
          ' not restored',
      )
      continue
    }
    if (
      !Number.isSafeInteger(raw.size) ||
      raw.size !== data.byteLength ||
      data.byteLength > LIMITS.attachmentMaxBytes
    )
      throw new Error(
        `The ZIP attachment has an invalid size: ${raw.filename || raw.id}`,
      )
    if ((await sha256Hex(data)) !== raw.sha256.toLocaleLowerCase())
      throw new Error(
        `The ZIP attachment checksum failed: ${raw.filename || raw.id}`,
      )
    importedBytes += data.byteLength
    prepared.push({
      sourceId: raw.id,
      sourceNoteId:
        typeof raw.noteId === 'string' &&
        /^[0-9a-hjkmnp-tv-z]{26}$/.test(raw.noteId)
          ? raw.noteId
          : null,
      id: state.attachments.has(raw.id) ? newDemoId() : raw.id,
      filename,
      mime,
      width: Number.isFinite(raw.width) ? raw.width : null,
      height: Number.isFinite(raw.height) ? raw.height : null,
      createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
      data,
    })
  }
  const usedBytes = [...state.attachments.values()].reduce(
    (total, attachment) => total + attachment.meta.size,
    0,
  )
  if (usedBytes + importedBytes > LIMITS.attachmentQuotaBytes)
    throw new Error('The imported attachments would exceed the account quota')
  const imported = new Map<string, string>()
  const sourceNotes = new Map<string, string | null>()
  const createdIds: string[] = []
  try {
    for (const item of prepared) {
      const file = new File(
        [item.data.slice().buffer as ArrayBuffer],
        item.filename,
        { type: item.mime, lastModified: item.createdAt },
      )
      const url = URL.createObjectURL(file)
      state.attachments.set(item.id, {
        file,
        meta: {
          id: item.id,
          noteId: null,
          filename: item.filename,
          mime: item.mime,
          size: file.size,
          width: item.width,
          height: item.height,
          url,
          createdAt: item.createdAt,
        },
      })
      createdIds.push(item.id)
      imported.set(item.sourceId, url)
      sourceNotes.set(item.id, item.sourceNoteId)
      result.createdAttachments++
    }
  } catch (error) {
    for (const id of createdIds) {
      const attachment = state.attachments.get(id)
      if (attachment) revokeAttachment(attachment.meta.url)
      state.attachments.delete(id)
      sourceNotes.delete(id)
      result.createdAttachments--
    }
    throw error
  }
  return { urls: imported, sourceNotes }
}
