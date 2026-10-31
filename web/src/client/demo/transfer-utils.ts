import { LIMITS } from '@shared/constants'
import { deriveTitle } from '@shared/markdown-utils'
import { utf8ByteLength } from '@shared/text-utils'
import type { ImportResult } from '@shared/types'
import { newDemoId, refreshNote, type DemoState } from './state'
export type ImportConflict = 'skip' | 'newer' | 'duplicate'

export function createImportedNote(
  state: DemoState,
  content: string,
  title: string | undefined,
  folderId: string | null,
): string {
  if (utf8ByteLength(content) > LIMITS.contentMaxBytes)
    throw new Error('A note file cannot exceed 2 MB')
  const now = Date.now()
  const id = newDemoId()
  const note = refreshNote(
    {
      id,
      title: title ?? deriveTitle(content),
      excerpt: '',
      content: '',
      folderId,
      tags: [],
      isPinned: false,
      isStarred: false,
      isArchived: false,
      wordCount: 0,
      charCount: 0,
      rev: 1,
      position: now,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    },
    content,
    title,
  )
  state.notes.set(id, note)
  return id
}

export function ensureFolderPath(
  state: DemoState,
  names: readonly string[],
  result: ImportResult,
): string | null {
  if (names.length > LIMITS.folderDepthMax)
    throw new Error('Folder depth exceeds the limit')
  let parentId: string | null = null
  for (const name of names) {
    if (
      !name ||
      name === '.' ||
      name === '..' ||
      name.length > LIMITS.folderNameMaxLength
    )
      throw new Error('Invalid folder name')
    const existing = [...state.folders.values()].find(
      (folder) => folder.parentId === parentId && folder.name === name,
    )
    if (existing) {
      parentId = existing.id
      continue
    }
    const id = newDemoId()
    const now = Date.now()
    state.folders.set(id, {
      id,
      parentId,
      name,
      icon: null,
      color: null,
      position: state.folders.size * 1000,
      createdAt: now,
      updatedAt: now,
    })
    parentId = id
    result.createdFolders++
  }
  return parentId
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const bytes = data.buffer.slice(
    data.byteOffset,
    data.byteOffset + data.byteLength,
  ) as ArrayBuffer
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return [...digest]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')
}
