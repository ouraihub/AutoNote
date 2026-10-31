import type { Hono } from 'hono'
import type { AppBindings } from '../env'
import { sliceText, truncateText } from '@shared/text-utils'
import { loadNoteRow } from './notes-shared'

export function registerNotesBacklinkRoutes(routes: Hono<AppBindings>): void {
  routes.get('/:id/backlinks', async (c) => {
    const userId = c.get('userId')
    const id = c.req.param('id')
    const note = await loadNoteRow(c.env.DB, userId, id)
    const { results } = await c.env.DB.prepare(`SELECT n.id, n.title, n.content FROM links l JOIN notes n ON n.id = l.source_note_id WHERE l.user_id = ?1 AND l.target_note_id = ?2 AND n.deleted_at IS NULL AND n.id != ?2 ORDER BY n.updated_at DESC LIMIT 50`).bind(userId, id).all<{ id: string; title: string; content: string }>()
    return c.json({ backlinks: results.map((r) => ({ id: r.id, title: r.title, context: linkContext(r.content, note.title) })) })
  })
}

function linkContext(content: string, title: string): string {
  const needle = `[[${title}`
  const idx = content.toLowerCase().indexOf(needle.toLowerCase())
  if (idx < 0) return truncateText(content, 120).replace(/\s+/g, ' ').trim()
  const start = Math.max(0, idx - 60)
  const end = Math.min(content.length, idx + needle.length + 90)
  return (start > 0 ? '…' : '') + sliceText(content, start, end).replace(/\s+/g, ' ').trim() + (end < content.length ? '…' : '')
}
