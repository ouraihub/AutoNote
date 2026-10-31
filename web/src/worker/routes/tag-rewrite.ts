import { LIMITS } from '@shared/constants'
import { countText, deriveExcerpt, replaceTagInContent } from '@shared/markdown-utils'
import { utf8ByteLength } from '@shared/text-utils'
import type { AppBindings } from '../env'
import { buildNoteDerivedStatements } from '../db/writes'
import { sha256Hex } from '../lib/encoding'
import { ApiError } from '../lib/errors'
import { newId } from '../lib/id'
export interface TagRewriteResult { rewritten: number; rollback: () => Promise<void> }
interface RewrittenTagNote { note: { id: string; title: string; content: string; rev: number; updated_at: number; deleted_at: number | null }; nextRev: number; updatedAt: number }
export async function rewriteTagInNotes(env: AppBindings['Bindings'], ftsEnabled: boolean, userId: string, tagId: string, from: string, to: string | null): Promise<TagRewriteResult> {
  const { results } = await env.DB.prepare(`SELECT n.id FROM notes n JOIN note_tags nt ON nt.note_id = n.id WHERE nt.tag_id = ?1 AND n.user_id = ?2`).bind(tagId, userId).all<{ id: string }>()
  let rewritten = 0
  const rewrittenNotes: RewrittenTagNote[] = []
  try {
    for (const candidate of results) {
      let complete = false
      for (let attempt = 0; attempt < 5; attempt++) {
        const note = await env.DB.prepare(`SELECT id, title, content, rev, updated_at, deleted_at FROM notes WHERE id = ?1 AND user_id = ?2`).bind(candidate.id, userId).first<RewrittenTagNote['note']>()
        if (!note) { complete = true; break }
        const content = replaceTagInContent(note.content, from, to)
        if (content === note.content) { complete = true; break }
        const { words, chars } = countText(content)
        const hash = await sha256Hex(content)
        const now = Math.max(Date.now(), note.updated_at + 1)
        const nextRev = note.rev + 1
        const mutationGuard = `EXISTS (SELECT 1 FROM notes WHERE id = ?1 AND user_id = ?2 AND rev = ?3 AND content_hash = ?4 AND title = ?5 AND updated_at = ?6)`
        const mutationValues = [note.id, userId, nextRev, hash, note.title, now] as const
        const update = env.DB.prepare(`UPDATE notes SET title = ?1, content = ?2, excerpt = ?3, word_count = ?4, char_count = ?5, content_hash = ?6, rev = ?7, updated_at = ?8 WHERE id = ?9 AND user_id = ?10 AND rev = ?11`).bind(note.title, content, deriveExcerpt(content), words, chars, hash, nextRev, now, note.id, userId, note.rev)
        const snapshot = env.DB.prepare(`INSERT INTO note_versions (id, note_id, user_id, title, content, size, created_at) SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7 WHERE ${shiftSqlPlaceholders(mutationGuard, 7)}`).bind(newId(), note.id, userId, note.title, note.content, utf8ByteLength(note.content), now, ...mutationValues)
        const trim = env.DB.prepare(`DELETE FROM note_versions WHERE note_id = ?1 AND ${shiftSqlPlaceholders(mutationGuard, 1)} AND id IN (SELECT id FROM note_versions WHERE note_id = ?1 ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ?8)`).bind(note.id, ...mutationValues, LIMITS.versionsPerNote)
        const statements: D1PreparedStatement[] = [update, snapshot, trim]
        if (note.deleted_at === null) statements.push(...buildNoteDerivedStatements({ db: env.DB, userId, noteId: note.id, title: note.title, content, ftsEnabled, titleChanged: false, previousTitle: note.title, expectedRev: nextRev, expectedContentHash: hash, expectedTitle: note.title, expectedUpdatedAt: now }).statements)
        statements.push(env.DB.prepare(`INSERT INTO changes (user_id, entity, entity_id, op, at) SELECT ?1, 'note', ?2, 'upsert', ?3 WHERE ${shiftSqlPlaceholders(mutationGuard, 3)}`).bind(userId, note.id, now, ...mutationValues))
        const [updated] = await env.DB.batch(statements)
        if (updated?.meta.changes) { rewritten++; rewrittenNotes.push({ note, nextRev, updatedAt: now }); complete = true; break }
      }
      if (!complete) throw ApiError.conflict(`Some notes are still being edited. Safely completed ${rewritten} notes; try again later`)
    }
    return { rewritten, rollback: () => rollbackTagRewrites(env, ftsEnabled, userId, rewrittenNotes) }
  } catch (error) {
    try { await rollbackTagRewrites(env, ftsEnabled, userId, rewrittenNotes) } catch { throw ApiError.conflict('Tag rename could not be rolled back safely; refresh and try again') }
    throw error
  }
}
async function rollbackTagRewrites(env: AppBindings['Bindings'], ftsEnabled: boolean, userId: string, rewrittenNotes: readonly RewrittenTagNote[]): Promise<void> {
  for (const rewritten of [...rewrittenNotes].reverse()) {
    const { note, nextRev, updatedAt } = rewritten
    const hash = await sha256Hex(note.content)
    const { words, chars } = countText(note.content)
    const update = env.DB.prepare(`UPDATE notes SET content = ?1, excerpt = ?2, word_count = ?3, char_count = ?4, content_hash = ?5, rev = ?6, updated_at = ?7 WHERE id = ?8 AND user_id = ?9 AND rev = ?10 AND updated_at = ?11`).bind(note.content, deriveExcerpt(note.content), words, chars, hash, note.rev, note.updated_at, note.id, userId, nextRev, updatedAt)
    const statements: D1PreparedStatement[] = [update]
    if (note.deleted_at === null) statements.push(...buildNoteDerivedStatements({ db: env.DB, userId, noteId: note.id, title: note.title, content: note.content, ftsEnabled, expectedRev: note.rev, expectedContentHash: hash, expectedTitle: note.title, expectedUpdatedAt: note.updated_at }).statements)
    statements.push(env.DB.prepare(`INSERT INTO changes (user_id, entity, entity_id, op, at) SELECT ?1, 'note', ?2, ?3 WHERE EXISTS (SELECT 1 FROM notes WHERE id = ?2 AND user_id = ?1 AND rev = ?4 AND updated_at = ?5)`).bind(userId, note.id, Date.now(), note.rev, note.updated_at))
    const [restored] = await env.DB.batch(statements)
    if (!restored?.meta.changes) throw new Error('tag rewrite rollback conflict')
  }
}
function shiftSqlPlaceholders(sql: string, offset: number): string { return sql.replace(/\?(\d+)/g, (_match, value: string) => `?${Number(value) + offset}`) }
