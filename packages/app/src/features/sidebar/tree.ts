import { LIMITS } from '@shared/constants'
import type { Folder } from '@shared/types'
import { folderDescendantIds, folderPath } from '@app/state/selectors'

export function folderMoveError(folders: readonly Folder[], id: string, parentId: string | null): 'cycle' | 'depth' | 'missing' | null {
  if (!folders.some((folder) => folder.id === id) || (parentId !== null && !folders.some((folder) => folder.id === parentId))) return 'missing'
  const descendants = folderDescendantIds(folders, id)
  if (parentId !== null && descendants.has(parentId)) return 'cycle'
  const depth = folderPath(folders, id).length
  const subtreeHeight = Math.max(...[...descendants].map((child) => folderPath(folders, child).length - depth))
  const targetDepth = parentId === null ? 0 : folderPath(folders, parentId).length
  return targetDepth + subtreeHeight >= LIMITS.folderDepthMax ? 'depth' : null
}

export function folderDropTarget(target: Folder | null, siblings: readonly Folder[], position: 'before' | 'inside' | 'after'): { parentId: string | null; beforeId: string | null } {
  if (!target) return { parentId: null, beforeId: null }
  if (position === 'inside') return { parentId: target.id, beforeId: null }
  return { parentId: target.parentId, beforeId: position === 'before' ? target.id : siblings[siblings.findIndex((folder) => folder.id === target.id) + 1]?.id ?? null }
}
