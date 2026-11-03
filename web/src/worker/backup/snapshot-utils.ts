import { LIMITS } from '@shared/constants'
import { truncateText } from '@shared/text-utils'
import { sha256Hex } from '../lib/encoding'
import { safeAttachmentMime } from '../lib/image'
import {
  hasAttachmentStorage,
  isAttachmentObjectStorage,
  readAttachmentObjectStream,
} from '../attachments/backend'
import { attachmentObjectKey } from '../attachments/keys'
import type { Env } from '../env'
import { NOTE_COLUMNS_FULL, type NoteRow } from '../db/rows'
import type {
  AttachmentSnapshotRow,
  BackupFile,
  BackupFileKind,
} from './snapshot-types'

const encoder = new TextEncoder()
const ATTACHMENT_REFERENCE_RE =
  /\/api\/files\/([0-9-a-hjkmnp-tv-z]{26})(?=$|[\s>)\]"'?#])/g

export function renderNoteBody(
  content: string,
  notePath: string,
  attachmentPaths: ReadonlyMap<string, string>,
  referencedIds: ReadonlySet<string>,
): string {
  return content.replace(ATTACHMENT_REFERENCE_RE, (match, id: string) => {
    if (!referencedIds.has(id)) return match
    const attachmentPath = attachmentPaths.get(id)
    return attachmentPath ? relativeBackupUrl(notePath, attachmentPath) : match
  })
}

export async function openPlannedNote(
  env: Env,
  userId: string,
  noteId: string,
  expectedRev: number,
  notePath: string,
  expectedSha256: string,
  attachmentPaths: ReadonlyMap<string, string>,
  referencedIds: ReadonlySet<string>,
): Promise<ReadableStream<Uint8Array>> {
  const row = await env.DB.prepare(
    `SELECT ${NOTE_COLUMNS_FULL} FROM notes n
      WHERE n.user_id = ?1 AND n.id = ?2 AND n.rev = ?3`,
  )
    .bind(userId, noteId, expectedRev)
    .first<NoteRow>()
  if (!row)
    throw new Error(`A note changed while the backup was running: ${noteId}`)
  const bytes = encoder.encode(
    renderNoteBody(row.content, notePath, attachmentPaths, referencedIds),
  )
  if ((await sha256Hex(bytes)) !== expectedSha256)
    throw new Error(`A note changed while the backup was running: ${row.title}`)
  return streamBytes(bytes)
}

export async function openVerifiedAttachment(
  env: Env,
  row: AttachmentSnapshotRow,
): Promise<ReadableStream<Uint8Array>> {
  if (
    !isAttachmentObjectStorage(row.storage) ||
    !hasAttachmentStorage(env, row.storage)
  )
    throw new Error(`Attachment storage is unavailable: ${row.filename}`)
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
        if (prefix.byteLength < 64 * 1024) {
          const take = Math.min(64 * 1024 - prefix.byteLength, chunk.byteLength)
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
        if (safeAttachmentMime(prefix, row.mime) !== row.mime)
          await fail(`Attachment type metadata does not match: ${row.filename}`)
        await digestWriter.close()
        if (bytesToHex(new Uint8Array(await digest.digest)) !== row.sha256)
          throw new Error(`Attachment checksum does not match: ${row.filename}`)
      },
    }),
  )
}

export function streamBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('')
}

export function validateAttachmentRow(row: AttachmentSnapshotRow): void {
  if (!/^[0-9a-hjkmnp-tv-z]{26}$/.test(row.id))
    throw new Error('Attachment metadata contains an invalid ID')
  if (!row.filename || row.filename.length > 180)
    throw new Error(`Invalid attachment filename: ${row.id}`)
  if (
    !Number.isSafeInteger(row.size) ||
    row.size < 0 ||
    row.size > LIMITS.attachmentMaxBytes
  )
    throw new Error(`Invalid attachment size: ${row.filename}`)
  if (!/^[0-9a-f]{64}$/.test(row.sha256))
    throw new Error(`Invalid attachment checksum: ${row.filename}`)
  if (!isAttachmentObjectStorage(row.storage))
    throw new Error(`Invalid attachment storage type: ${row.filename}`)
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
  return {
    path,
    byteLength: bytes.byteLength,
    sha256: await sha256Hex(bytes),
    contentType,
    kind,
    open: async () => streamBytes(bytes),
  }
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

export function relativeBackupUrl(fromFile: string, toFile: string): string {
  const from = fromFile.split('/').slice(0, -1)
  const to = toFile.split('/')
  let common = 0
  while (
    common < from.length &&
    common < to.length &&
    from[common] === to[common]
  )
    common++
  return [
    ...Array.from({ length: from.length - common }, () => '..'),
    ...to.slice(common),
  ]
    .map((part) => (part === '..' ? part : encodeURIComponent(part)))
    .join('/')
}
export function buildFolderPaths(
  folders: { id: string; parentId: string | null; name: string }[],
) {
  const byId = new Map(folders.map((folder) => [folder.id, folder]))
  const cache = new Map<string, { path: string; names: string[] }>()
  const resolve = (
    id: string,
    visiting = new Set<string>(),
  ): { path: string; names: string[] } => {
    if (cache.has(id)) return cache.get(id)!
    const folder = byId.get(id)
    if (!folder || visiting.has(id) || visiting.size >= LIMITS.folderDepthMax)
      return { path: '', names: [] }
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

export function formatStamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  const ms = String(date.getUTCMilliseconds()).padStart(3, '0')
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(
    date.getUTCDate(),
  )}-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(
    date.getUTCSeconds(),
  )}-${ms}`
}

export function readme(
  stamp: string,
  notes: readonly { state: string }[],
  attachments: number,
): string {
  const active = notes.filter((note) => note.state === 'notes').length
  const archived = notes.filter((note) => note.state === 'archived').length
  const trash = notes.filter((note) => note.state === 'trash').length
  return (
    'AutoNote Markdown backup\n\nSnapshot (UTC): ' +
    stamp +
    '\nTotal notes: ' +
    notes.length +
    '\nActive: ' +
    active +
    '\nArchived: ' +
    archived +
    '\nTrash: ' +
    trash +
    '\nAttachments: ' +
    attachments +
    '\n\nnotes/ contains ordinary notes in their folder hierarchy.\n' +
    'archived/ contains archived notes in their folder hierarchy.\n' +
    'trash/ contains trashed notes in their folder hierarchy.\n' +
    'attachments/ contains referenced files in their original bytes; ' +
    'the checksum in each filename prevents collisions.\n' +
    'manifest.json records note state, timestamps, paths, and checksums.\n\n' +
    'Restore this ZIP directly in AutoNote. For a backup larger than the ' +
    'browser upload limit, extract it and select the extracted folder ' +
    'instead.\n' +
    'A backup is valid only when its COMPLETE file is present and matches ' +
    'manifest.json.\n'
  )
}

export function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${Math.ceil(bytes / (1024 * 1024))} MB`
    : `${Math.ceil(bytes / 1024)} KB`
}
