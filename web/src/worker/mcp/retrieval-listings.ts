import { NoteOutlineItem } from './retrieval'
import { slugifyHeading } from '@shared/markdown-utils'
import type { D1Database } from '@cloudflare/workers-types'

export async function listMcpFolders(
  db: D1Database,
  userId: string,
): Promise<Record<string, unknown>> {
  const { results } = await db
    .prepare(
      'SELECT f.id, f.parent_id, f.name, f.position,\n' +
        '            (SELECT COUNT(*) FROM notes n\n' +
        '              ' +
        'WHERE n.user_id = f.user_id AND n.folder_id = f.id ' +
        'AND n.deleted_at IS NULL) AS note_count\n' +
        '       FROM folders f WHERE f.user_id = ?1 ' +
        'AND f.deleted_at IS NULL\n' +
        '      ' +
        'ORDER BY f.position ASC, f.name COLLATE NOCASE ASC',
    )
    .bind(userId)
    .all<{
      id: string
      parent_id: string | null
      name: string
      position: number
      note_count: number
    }>()
  const byId = new Map(results.map((folder) => [folder.id, folder]))
  const pathFor = (folder: (typeof results)[number]): string => {
    const names = [folder.name]
    const seen = new Set([folder.id])
    let parent = folder.parent_id ? byId.get(folder.parent_id) : undefined
    while (parent && !seen.has(parent.id) && names.length < 12) {
      seen.add(parent.id)
      names.unshift(parent.name)
      parent = parent.parent_id ? byId.get(parent.parent_id) : undefined
    }
    return names.join(' / ')
  }
  return {
    folders: results.map((folder) => ({
      id: folder.id,
      parent_id: folder.parent_id,
      name: folder.name,
      path: pathFor(folder),
      note_count: folder.note_count,
    })),
  }
}

export async function listMcpTags(
  db: D1Database,
  userId: string,
  limit = 100,
): Promise<Record<string, unknown>> {
  const { results } = await db
    .prepare(
      'SELECT t.id, t.name, t.color, COUNT(n.id) AS note_count\n' +
        '       ' +
        'FROM tags t LEFT JOIN note_tags nt ON nt.tag_id = t.id\n' +
        '       LEFT JOIN notes n ON n.id = nt.note_id ' +
        'AND n.user_id = t.user_id AND n.deleted_at IS NULL\n' +
        '      WHERE t.user_id = ?1\n' +
        '      GROUP BY t.id, t.name, t.color\n' +
        '      ORDER BY note_count DESC, ' +
        't.name COLLATE NOCASE ASC LIMIT ?2',
    )
    .bind(userId, Math.max(1, Math.min(200, limit)))
    .all<{
      id: string
      name: string
      color: string | null
      note_count: number
    }>()
  return { tags: results }
}

export function buildOutline(content: string): NoteOutlineItem[] {
  const lines = content.split(/\r?\n/)
  const outline: NoteOutlineItem[] = []
  const slugs = new Map<string, number>()
  let fence = ''
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    const marker = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (marker) {
      if (!fence) fence = marker[0]!
      else if (marker[0] === fence) fence = ''
      continue
    }
    if (fence) continue
    const match = /^[ \t]{0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(line)
    if (!match) continue
    const title = match[2]!.trim()
    const base = slugifyHeading(title)
    const seen = slugs.get(base) ?? 0
    slugs.set(base, seen + 1)
    outline.push({
      level: match[1]!.length,
      title,
      slug: seen ? `${base}-${seen}` : base,
      line: index + 1,
    })
    if (outline.length >= 200) break
  }
  return outline
}
