import { countText, deriveExcerpt, deriveTitle } from '@shared/markdown-utils'
import type { AppLocale } from '@shared/types'
import { welcomeNoteTemplates } from '@shared/welcome-notes'
import type { Env } from '../env'
import { newId } from '../lib/id'
import { sha256Hex } from '../lib/encoding'
import { initializeDatabase } from './schema'
import { buildNoteDerivedStatements, changeStatement } from './writes'

export async function seedWorkspace(
  env: Env,
  userId: string,
  locale: AppLocale = 'zh-CN',
): Promise<void> {
  const { ftsEnabled } = await initializeDatabase(env)
  const now = Date.now()
  const notes = await Promise.all(
    welcomeNoteTemplates(locale).map(async ({ content }, index) => {
      const id = newId()
      const createdAt = now - index
      const title = deriveTitle(content)
      const excerpt = deriveExcerpt(content)
      const { words, chars } = countText(content)
      const hash = await sha256Hex(content)
      return { id, content, title, excerpt, words, chars, hash, createdAt, position: 1000 - index }
    }),
  )
  const statements: D1PreparedStatement[] = []
  for (const note of notes) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO notes (id, user_id, folder_id, title, content, excerpt, rev, word_count, char_count,
           is_pinned, is_starred, is_archived, position, content_hash, created_at, updated_at)
         VALUES (?1, ?2, NULL, ?3, ?4, ?5, 1, ?6, ?7, 1, 1, 0, ?8, ?9, ?10, ?10)`,
      ).bind(
        note.id,
        userId,
        note.title,
        note.content,
        note.excerpt,
        note.words,
        note.chars,
        note.position,
        note.hash,
        note.createdAt,
      ),
      ...buildNoteDerivedStatements({
        db: env.DB,
        userId,
        noteId: note.id,
        title: note.title,
        content: note.content,
        ftsEnabled,
        expectedRev: 1,
        expectedContentHash: note.hash,
        expectedTitle: note.title,
        expectedUpdatedAt: note.createdAt,
      }).statements,
      changeStatement(env.DB, userId, 'note', note.id, 'upsert', note.createdAt),
    )
  }
  await env.DB.batch(statements)
}
