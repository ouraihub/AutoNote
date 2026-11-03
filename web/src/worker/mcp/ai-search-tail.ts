import { toPlainText } from '@shared/markdown-utils'
import { truncateText } from '@shared/text-utils'
import type { SemanticFilters } from './ai-search'

const AI_EMBEDDING_DIMS = 1024
export function encodeVector(vector: Float32Array): ArrayBuffer {
  return new Float32Array(vector).buffer
}
export function decodeVector(buffer: ArrayBuffer): Float32Array {
  const view = new Float32Array(buffer)
  return view.length === AI_EMBEDDING_DIMS
    ? view
    : view.slice(0, AI_EMBEDDING_DIMS)
}
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const length = Math.min(a.length, b.length)
  let dot = 0
  let normA = 0
  let normB = 0
  for (let index = 0; index < length; index++) {
    dot += a[index]! * b[index]!
    normA += a[index]! * a[index]!
    normB += b[index]! * b[index]!
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB)
  return denominator === 0 ? 0 : dot / denominator
}
export function semanticSnippet(excerpt: string, radius = 90): string {
  const plain = toPlainText(excerpt).replace(/\s+/g, ' ').trim()
  if (!plain) return ''
  return (
    truncateText(plain, radius * 2) + (plain.length > radius * 2 ? '…' : '')
  )
}
export function semanticWhere(
  userId: string,
  filters: SemanticFilters,
): { binds: unknown[]; where: string } {
  const binds: unknown[] = [userId]
  let where = 'e.user_id = ?1 AND n.deleted_at IS NULL'
  if (filters.starred === true) where += ' AND n.is_starred = 1'
  if (filters.archived === true) where += ' AND n.is_archived = 1'
  else if (filters.archived === false) where += ' AND n.is_archived = 0'
  for (const tag of filters.tags ?? []) {
    binds.push(tag)
    where +=
      ' AND EXISTS (SELECT 1 FROM note_tags nt ' +
      'JOIN tags t ON t.id = nt.tag_id\n' +
      '        ' +
      'WHERE nt.note_id = n.id AND t.user_id = n.user_id\n' +
      `          AND t.name = ?${binds.length} COLLATE NOCASE)`
  }
  if (filters.folder) {
    binds.push(filters.folder)
    where +=
      ' ' +
      'AND EXISTS (SELECT 1 FROM folders f WHERE f.id = n.folder_id\n' +
      `        AND f.name = ?${binds.length} COLLATE NOCASE ` +
      'AND f.user_id = n.user_id)'
  }
  return { binds, where }
}
