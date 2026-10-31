import { LIMITS } from '@shared/constants'
import {
  deriveTitle,
  extractAttachmentIds,
  parseFrontMatter,
} from '@shared/markdown-utils'
import { organizerColorOrNull } from '@shared/organizer-colors'
import { utf8ByteLength } from '@shared/text-utils'
import { createZip } from '@shared/zip'
import type {
  ExportAttachment,
  ExportBundle,
  ImportResult,
  Note,
} from '@shared/types'
import {
  listFolders,
  listTags,
  newDemoId,
  refreshNote,
  type DemoState,
} from './state'
import { apiError } from './responses'
import { importBundleAttachments } from './transfer-attachments'
import { createImportedNote, ensureFolderPath, sha256Hex } from
  './transfer-utils'
export type ImportConflict = 'skip' | 'newer' | 'duplicate'
function exportBundle(state: DemoState): ExportBundle {
  return {
    format: 'autonote-export',
    version: 1,
    exportedAt: Date.now(),
    user: { login: state.user.login, name: state.user.name },
    folders: listFolders(state),
    tags: listTags(state),
    notes: [...state.notes.values()].map((note) => ({
      ...note,
      content: [...state.attachments.values()].reduce(
        (content, attachment) =>
          content.replaceAll(
            attachment.meta.url,
            `/api/files/${attachment.meta.id}`,
          ),
        note.content,
      ),
    })),
    attachments: [],
  }
}

export async function exportResponse(
  state: DemoState,
  format: 'json' | 'zip',
): Promise<Response> {
  const baseBundle = exportBundle(state)
  const encoder = new TextEncoder()
  if (format === 'json') {
    return new Response(JSON.stringify(baseBundle, null, 2), {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': 'attachment; filename="autonote-demo.json"',
      },
    })
  }
  const storedAttachments = [...state.attachments.values()]
  const notes = [...state.notes.values()].map((note) => ({
    ...note,
    content: storedAttachments.reduce(
      (content, attachment) =>
        content.replaceAll(
          attachment.meta.url,
          `/api/files/${attachment.meta.id}`,
        ),
      note.content,
    ),
  }))
  const noteEntries = demoNoteEntries(notes, encoder)
  const expandedBytes =
    noteEntries.reduce((total, entry) => total + entry.data.byteLength, 0) +
    storedAttachments.reduce(
      (total, attachment) => total + attachment.meta.size,
      0,
    )
  if (expandedBytes > LIMITS.importArchiveExpandedMaxBytes) {
    return apiError(
      413,
      'payload_too_large',
      'The demo ZIP would exceed the 80 MB expanded archive limit',
    )
  }
  if (
    noteEntries.length + storedAttachments.length + 1 >
    LIMITS.importArchiveEntriesMax
  ) {
    return apiError(
      413,
      'payload_too_large',
      'The demo ZIP would contain too many files',
    )
  }

  const attachments: ExportAttachment[] = []
  const attachmentEntries: Array<{ path: string; data: Uint8Array }> = []
  for (const attachment of storedAttachments) {
    const data = new Uint8Array(await attachment.file.arrayBuffer())
    const filename = safeAttachmentFilename(attachment.meta.filename)
    const path = `attachments/${attachment.meta.id}/${filename}`
    attachments.push({
      id: attachment.meta.id,
      noteId: attachment.meta.noteId,
      filename,
      mime: attachment.meta.mime,
      size: data.byteLength,
      width: attachment.meta.width,
      height: attachment.meta.height,
      createdAt: attachment.meta.createdAt,
      path,
      sha256: await sha256Hex(data),
    })
    attachmentEntries.push({ path, data })
  }
  const bundle: ExportBundle = { ...baseBundle, notes, attachments }
  const entries = [
    {
      path: 'autonote-export.json',
      data: encoder.encode(JSON.stringify(bundle, null, 2)),
    },
    ...noteEntries,
    ...attachmentEntries,
  ]
  if (
    entries.reduce((total, entry) => total + entry.data.byteLength, 0) >
    LIMITS.importArchiveExpandedMaxBytes
  ) {
    return apiError(
      413,
      'payload_too_large',
      'The demo ZIP would exceed the 80 MB expanded archive limit',
    )
  }
  const data = createZip(entries)
  return new Response(data as BodyInit, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': 'attachment; filename="autonote-demo.zip"',
    },
  })
}

function demoNoteEntries(
  notes: Iterable<Note>,
  encoder: TextEncoder,
): Array<{ path: string; data: Uint8Array }> {
  const used = new Set<string>()
  return [...notes].map((note) => {
    const base = (note.title || 'Untitled note')
      .replace(/[\\/:*?"<>|]/g, '-')
      .slice(0, 100)
    let name = base
    let suffix = 2
    while (used.has(name.toLocaleLowerCase())) name = `${base} (${suffix++})`
    used.add(name.toLocaleLowerCase())
    return { path: `notes/${name}.md`, data: encoder.encode(note.content) }
  })
}

function safeAttachmentFilename(value: string): string {
  const cleaned = value
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/[\x00-\x1f]/g, '')
    .replace(/^\.+/, '')
    .trim()
  return (cleaned || 'file').slice(0, 180)
}

export async function importBundle(
  state: DemoState,
  value: unknown,
  result: ImportResult,
  conflict: ImportConflict,
  archiveEntries?: Map<string, Uint8Array>,
): Promise<void> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid export file')
  const bundle = value as Partial<ExportBundle>
  if (!Array.isArray(bundle.notes))
    throw new Error('The export contains no notes')
  if (bundle.format !== 'autonote-export' || bundle.version !== 1)
    throw new Error('Invalid export format')
  for (const note of bundle.notes)
    if (
      !note ||
      typeof note.content !== 'string' ||
      utf8ByteLength(note.content) > LIMITS.contentMaxBytes
    )
      throw new Error('Invalid note content')
  const importedAttachments = archiveEntries
    ? await importBundleAttachments(
        state,
        Array.isArray(bundle.attachments) ? bundle.attachments : [],
        archiveEntries,
        result,
      )
    : {
        urls: new Map<string, string>(),
        sourceNotes: new Map<string, string | null>(),
      }
  if (
    !archiveEntries &&
    Array.isArray(bundle.attachments) &&
    bundle.attachments.length > 0
  ) {
    result.skippedAttachments += bundle.attachments.length
    result.warnings.push('Attachment bytes are unavailable in JSON exports')
  }
  const folderMap = new Map<string, string>()
  for (const raw of Array.isArray(bundle.folders) ? bundle.folders : []) {
    if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string') continue
    if (state.folders.has(raw.id) && conflict !== 'duplicate') {
      folderMap.set(raw.id, raw.id)
      continue
    }
    const id = state.folders.has(raw.id) ? newDemoId() : raw.id
    folderMap.set(raw.id, id)
    state.folders.set(id, {
      id,
      parentId: raw.parentId ? (folderMap.get(raw.parentId) ?? null) : null,
      name: typeof raw.name === 'string' ? raw.name : 'Imported folder',
      icon: typeof raw.icon === 'string' ? raw.icon : null,
      color: organizerColorOrNull(raw.color),
      position: Number.isFinite(raw.position)
        ? raw.position
        : state.folders.size + 1,
      createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
      updatedAt: Date.now(),
    })
    result.createdFolders++
  }
  for (const raw of Array.isArray(bundle.folders) ? bundle.folders : []) {
    const id = folderMap.get(raw.id)
    const folder = id ? state.folders.get(id) : undefined
    if (folder && raw.parentId)
      state.folders.set(folder.id, {
        ...folder,
        parentId: folderMap.get(raw.parentId) ?? null,
      })
  }
  for (const raw of Array.isArray(bundle.tags) ? bundle.tags : []) {
    if (
      !raw ||
      typeof raw.name !== 'string' ||
      !raw.name ||
      /[\s#]/.test(raw.name) ||
      raw.name.length > LIMITS.tagNameMaxLength
    )
      continue
    if (!state.tagIds.has(raw.name)) state.tagIds.set(raw.name, newDemoId())
    state.tagColors.set(raw.name, organizerColorOrNull(raw.color))
  }
  const noteMap = new Map<string, string>()
  for (const raw of bundle.notes) {
    if (!raw || typeof raw !== 'object' || typeof raw.content !== 'string') {
      result.skippedNotes++
      continue
    }
    const folderId =
      typeof raw.folderId === 'string'
        ? (folderMap.get(raw.folderId) ?? null)
        : null
    let content = raw.content
    for (const sourceId of extractAttachmentIds(content)) {
      const url = importedAttachments.urls.get(sourceId)
      if (url) content = content.replaceAll(`/api/files/${sourceId}`, url)
    }
    const existing =
      typeof raw.id === 'string' ? state.notes.get(raw.id) : undefined
    if (
      existing &&
      (conflict === 'skip' ||
        (conflict === 'newer' && raw.updatedAt <= existing.updatedAt))
    ) {
      noteMap.set(raw.id, existing.id)
      result.skippedNotes++
      continue
    }
    let id: string
    if (existing && conflict === 'newer') {
      id = existing.id
      state.notes.set(
        id,
        refreshNote(
          {
            ...existing,
            folderId,
            rev: existing.rev + 1,
            updatedAt: raw.updatedAt,
          },
          content,
          raw.title,
        ),
      )
      result.updatedNotes++
    } else {
      id = createImportedNote(
        state,
        content,
        typeof raw.title === 'string' ? raw.title : undefined,
        folderId,
      )
      const created = state.notes.get(id)
      if (created)
        state.notes.set(id, {
          ...created,
          createdAt: Number.isFinite(raw.createdAt)
            ? raw.createdAt
            : created.createdAt,
          updatedAt: Number.isFinite(raw.updatedAt)
            ? raw.updatedAt
            : created.updatedAt,
          isStarred: raw.isStarred === true,
          isPinned: raw.isPinned === true,
          isArchived: raw.isArchived === true,
          deletedAt: raw.deletedAt ?? null,
        })
      result.createdNotes++
      if (
        typeof raw.id === 'string' &&
        /^[0-9a-hjkmnp-tv-z]{26}$/.test(raw.id) &&
        !state.notes.has(raw.id) &&
        conflict !== 'duplicate'
      ) {
        const imported = state.notes.get(id)
        if (imported) {
          state.notes.delete(id)
          id = raw.id
          state.notes.set(id, { ...imported, id })
        }
      }
    }
    if (typeof raw.id === 'string') noteMap.set(raw.id, id)
  }
  for (const [id, sourceNoteId] of importedAttachments.sourceNotes) {
    const attachment = state.attachments.get(id)
    if (!attachment) continue
    attachment.meta = {
      ...attachment.meta,
      noteId: sourceNoteId ? (noteMap.get(sourceNoteId) ?? null) : null,
    }
  }
}



export function importMarkdown(
  state: DemoState,
  content: string,
  path: string,
  conflict: ImportConflict,
  result: ImportResult,
): void {
  const parsed = parseFrontMatter(content)
  if (parsed.errors.length) throw new Error('Invalid Markdown front matter')
  const title =
    typeof parsed.data.title === 'string'
      ? parsed.data.title
      : deriveTitle(parsed.body) ||
        path
          .split('/')
          .at(-1)
          ?.replace(/\.(md|markdown|txt)$/i, '') ||
        ''
  const folderId = ensureFolderPath(state, path.split('/').slice(0, -1), result)
  const sourceId =
    typeof parsed.data.id === 'string' ? parsed.data.id : undefined
  const existing = sourceId
    ? state.notes.get(sourceId)
    : [...state.notes.values()].find(
        (note) => note.title === title && note.folderId === folderId,
      )
  const updatedAt =
    typeof parsed.data.updatedAt === 'number'
      ? parsed.data.updatedAt
      : Date.parse(String(parsed.data.updated ?? ''))
  if (
    existing &&
    (conflict === 'skip' ||
      (conflict === 'newer' &&
        (!Number.isFinite(updatedAt) || updatedAt <= existing.updatedAt)))
  ) {
    result.skippedNotes++
    return
  }
  if (existing && conflict === 'newer') {
    state.notes.set(
      existing.id,
      refreshNote(
        { ...existing, folderId, rev: existing.rev + 1, updatedAt },
        content,
        title,
      ),
    )
    result.updatedNotes++
  } else {
    createImportedNote(state, content, title, folderId)
    result.createdNotes++
  }
}


export { importBackupBatch } from './transfer-backup'
