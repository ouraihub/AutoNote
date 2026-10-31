import { LIMITS } from '@shared/constants'
import {
  hasAttachmentStorage,
  isAttachmentObjectStorage,
  readAttachmentObjectStream,
} from '../attachments/backend'
import { attachmentObjectKey } from '../attachments/keys'
import type { Env } from '../env'
import { sha256Hex } from '../lib/encoding'
import { safeAttachmentMime } from '../lib/image'
import { truncateText } from '@shared/text-utils'
import type { BackupFile, BackupFileKind } from './snapshot'

export interface AttachmentSnapshotRow {
  id: string
  user_id: string
  filename: string
  mime: string
  size: number
  sha256: string
  storage: string
  created_at: number
}

const encoder = new TextEncoder()

export async function openVerifiedAttachment(
  env: Env,
  row: AttachmentSnapshotRow,
): Promise<ReadableStream<Uint8Array>> {
  if (
    !isAttachmentObjectStorage(row.storage) ||
    !hasAttachmentStorage(env, row.storage)
  ) {
    throw new Error(`Attachment storage is unavailable: ${row.filename}`)
  }
  const object = await readAttachmentObjectStream(
    env,
    row.storage,
    attachmentObjectKey(row),
  )
  if (!object) throw new Error(`Attachment data is missing: ${row.filename}`)
  if (object.size !== null && object.size !== row.size) {
    await object.body.cancel().catch(() => {})
    throw new Error(`Attachment checksum does not match: ${row.filename}`)
  }
  if (object.metadata?.sha256 && object.metadata.sha256 !== row.sha256) {
    await object.body.cancel().catch(() => {})
    throw new Error(
      `Attachment checksum metadata does not match: ${row.filename}`,
    )
  }
  if (object.metadata?.mime && object.metadata.mime !== row.mime) {
    await object.body.cancel().catch(() => {})
    throw new Error(`Attachment type metadata does not match: ${row.filename}`)
  }
  return verifyAttachmentStream(object.body, row)
}

function verifyAttachmentStream(
  source: ReadableStream<Uint8Array>,
  row: AttachmentSnapshotRow,
): ReadableStream<Uint8Array> {
  const digest = new crypto.DigestStream('SHA-256')
  const digestWriter = digest.getWriter()
  const prefixLimit = 64 * 1024
  let prefix = new Uint8Array(0)
  let bytes = 0

  const fail = async (message: string): Promise<never> => {
    await digestWriter.abort(message).catch(() => {})
    throw new Error(message)
  }

  return source.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      async transform(chunk, controller) {
        bytes += chunk.byteLength
        if (bytes > row.size)
          await fail(`Attachment size does not match: ${row.filename}`)
        if (prefix.byteLength < prefixLimit) {
          const take = Math.min(
            prefixLimit - prefix.byteLength,
            chunk.byteLength,
          )
          const next = new Uint8Array(prefix.byteLength + take)
          next.set(prefix)
          next.set(chunk.subarray(0, take), prefix.byteLength)
          prefix = next
        }
        await digestWriter.write(chunk)
        controller.enqueue(chunk)
      },
      async flush() {
        if (bytes !== row.size)
          await fail(`Attachment size does not match: ${row.filename}`)
        if (safeAttachmentMime(prefix, row.mime) !== row.mime) {
          await fail(`Attachment type metadata does not match: ${row.filename}`)
        }
        await digestWriter.close()
        const actual = bytesToHex(new Uint8Array(await digest.digest))
        if (actual !== row.sha256) {
          throw new Error(`Attachment checksum does not match: ${row.filename}`)
        }
      },
    }),
  )
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('')
}

export function validateAttachmentRow(row: AttachmentSnapshotRow): void {
  if (!/^[0-9a-hjkmnp-tv-z]{26}$/.test(row.id)) {
    throw new Error('Attachment metadata contains an invalid ID')
  }
  if (!row.filename || row.filename.length > 180) {
    throw new Error(`Invalid attachment filename: ${row.id}`)
  }
  if (
    !Number.isSafeInteger(row.size) ||
    row.size < 0 ||
    row.size > LIMITS.attachmentMaxBytes
  ) {
    throw new Error(`Invalid attachment size: ${row.filename}`)
  }
  if (!/^[0-9a-f]{64}$/.test(row.sha256)) {
    throw new Error(`Invalid attachment checksum: ${row.filename}`)
  }
  if (!isAttachmentObjectStorage(row.storage)) {
    throw new Error(`Invalid attachment storage type: ${row.filename}`)
  }
}

export async function staticFile(
  path: string,
  text: string,
  contentType: string,
  kind: BackupFileKind,
): Promise<BackupFile> {
  return staticFileAsync(path, encoder.encode(text), contentType, kind)
}

export async function staticFileAsync(
  path: string,
  bytes: Uint8Array,
  contentType: string,
  kind: BackupFileKind,
): Promise<BackupFile> {
  const sha256 = await sha256Hex(bytes)
  return {
    path,
    byteLength: bytes.byteLength,
    sha256,
    contentType,
    kind,
    open: async () => streamBytes(bytes),
  }
}

export function streamBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

export interface BackupFolderPath {
  path: string
  names: string[]
}

export function buildFolderPaths(
  folders: { id: string; parentId: string | null; name: string }[],
): Map<string, BackupFolderPath> {
  const byId = new Map(folders.map((folder) => [folder.id, folder]))
  const cache = new Map<string, BackupFolderPath>()
  const resolve = (
    id: string,
    visiting = new Set<string>(),
  ): BackupFolderPath => {
    if (cache.has(id)) return cache.get(id)!
    const folder = byId.get(id)
    if (!folder || visiting.has(id) || visiting.size >= LIMITS.folderDepthMax) {
      return { path: '', names: [] }
    }
    const next = new Set(visiting).add(id)
    const parent = folder.parentId
      ? resolve(folder.parentId, next)
      : { path: '', names: [] }
    const segment = safeSegment(folder.name)
    const value = {
      path: parent.path ? `${parent.path}/${segment}` : segment,
      names: [...parent.names, folder.name],
    }
    cache.set(id, value)
    return value
  }
  for (const folder of folders) resolve(folder.id)
  return cache
}

export function safeSegment(name: string): string {
  const normalized = name
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/[\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+|[\s.]+$/g, '')
  const cleaned = truncateText(normalized, 80).replace(/[\s.]+$/g, '')
  if (!cleaned) return 'Untitled'
  return /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(cleaned)
    ? `_${cleaned}`
    : cleaned
}

export function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${Math.ceil(bytes / (1024 * 1024))} MB`
    : `${Math.ceil(bytes / 1024)} KB`
}
