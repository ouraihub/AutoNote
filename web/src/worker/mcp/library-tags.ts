import { organizerColorOrNull } from '@shared/organizer-colors'
import { ApiError } from '../lib/errors'
import { isValidId, newId } from '../lib/id'
import { rewriteTagInNotes } from '../routes/tag-rewrite'
import type { LibraryContext } from './library'
import {
  loadTagOrNull,
  loadTagByName,
  normalizeTagName,
  recordChange,
} from './library-tail'
import { runIdempotent } from './operations'

export async function createMcpTag(
  context: LibraryContext,
  input: {
    operationId: string
    tagId?: string
    name: string
    color?: string | null
  },
) {
  const id = input.tagId ?? newId()
  if (!isValidId(id))
    throw ApiError.badRequest('tag_id must be a valid AutoNote id')
  return runIdempotent({
    db: context.env.DB,
    userId: context.userId,
    operationId: input.operationId,
    tool: 'create_tag',
    request: { ...input, tagId: id },
    recovery: { tagId: id },
    recover: async () => {
      const tag = await loadTagOrNull(context.env.DB, context.userId, id)
      if (!tag) return null
      const matches =
        tag.name.toLowerCase() === normalizeTagName(input.name).toLowerCase() &&
        tag.color === organizerColorOrNull(input.color)
      return matches ? tag : null
    },
    execute: async () => {
      const name = normalizeTagName(input.name)
      const now = Date.now()
      const inserted = await context.env.DB.prepare(
        'INSERT INTO tags ' +
          '(id, user_id, name, color, is_manual, created_at)\n' +
          '         SELECT ?1, ?2, ?3, ?4, 1, ?5\n' +
          '          WHERE NOT EXISTS (SELECT 1 FROM tags ' +
          'WHERE user_id = ?2 AND name = ?3 COLLATE NOCASE)',
      )
        .bind(id, context.userId, name, organizerColorOrNull(input.color), now)
        .run()
      if (!inserted.meta.changes)
        throw ApiError.conflict('A tag with this name already exists')
      await recordChange(context, 'tag', id, 'upsert', now)
      return (await loadTagOrNull(context.env.DB, context.userId, id))!
    },
  })
}

export async function updateMcpTag(
  context: LibraryContext,
  input: {
    operationId: string
    tagId: string
    name?: string
    color?: string | null
  },
) {
  return runIdempotent({
    db: context.env.DB,
    userId: context.userId,
    operationId: input.operationId,
    tool: 'update_tag',
    request: input,
    execute: async () => {
      const tag = await loadTagOrNull(
        context.env.DB,
        context.userId,
        input.tagId,
      )
      if (!tag) throw ApiError.notFound('Tag not found')
      const color =
        input.color === undefined
          ? tag.color
          : organizerColorOrNull(input.color)
      if (
        input.name === undefined ||
        normalizeTagName(input.name) === tag.name
      ) {
        if (color !== tag.color) {
          const now = Date.now()
          const updated = await context.env.DB.prepare(
            `UPDATE tags SET color = ?1, is_manual = 1 ` +
              `WHERE id = ?2 AND user_id = ?3 AND color IS ?4`,
          )
            .bind(color, tag.id, context.userId, tag.color)
            .run()
          if (!updated.meta.changes)
            throw ApiError.conflict('The tag changed elsewhere')
          await recordChange(context, 'tag', tag.id, 'upsert', now)
        }
        return {
          ok: true,
          affected: 0,
          tag: (await loadTagOrNull(context.env.DB, context.userId, tag.id))!,
        }
      }

      const next = normalizeTagName(input.name)
      const existing = await loadTagByName(
        context.env.DB,
        context.userId,
        next,
        tag.id,
      )
      const destinationName = existing?.name ?? next
      const rewrite = await rewriteTagInNotes(
        context.env,
        context.ftsEnabled,
        context.userId,
        tag.id,
        tag.name,
        destinationName,
      )
      try {
        const destination = await loadTagByName(
          context.env.DB,
          context.userId,
          destinationName,
        )
        const now = Date.now()
        if (destination && destination.id !== tag.id) {
          const results = await context.env.DB.batch([
            context.env.DB.prepare(
              `INSERT OR IGNORE INTO note_tags (note_id, tag_id)
               SELECT note_id, ?1 FROM note_tags WHERE tag_id = ?2`,
            ).bind(destination.id, tag.id),
            context.env.DB.prepare(
              `DELETE FROM note_tags WHERE tag_id = ?1`,
            ).bind(tag.id),
            context.env.DB.prepare(
              `UPDATE tags SET color = COALESCE(?1, color), is_manual = 1 ` +
                `WHERE id = ?2 AND user_id = ?3`,
            ).bind(color, destination.id, context.userId),
            context.env.DB.prepare(
              `DELETE FROM tags WHERE id = ?1 AND user_id = ?2`,
            ).bind(tag.id, context.userId),
          ])
          if (!results[3]?.meta.changes)
            throw ApiError.conflict('The tag changed elsewhere')
          await recordChange(context, 'tag', destination.id, 'upsert', now)
          await recordChange(context, 'tag', tag.id, 'delete', now)
          return {
            ok: true,
            affected: rewrite.rewritten,
            tag: (await loadTagOrNull(
              context.env.DB,
              context.userId,
              destination.id,
            ))!,
          }
        }
        const updated = await context.env.DB.prepare(
          `UPDATE tags SET name = ?1, color = ?2, is_manual = 1
            WHERE id = ?3 AND user_id = ?4 AND name = ?5`,
        )
          .bind(destinationName, color, tag.id, context.userId, tag.name)
          .run()
        if (!updated.meta.changes)
          throw ApiError.conflict('The tag changed elsewhere')
        await recordChange(context, 'tag', tag.id, 'upsert', now)
        return {
          ok: true,
          affected: rewrite.rewritten,
          tag: (await loadTagOrNull(context.env.DB, context.userId, tag.id))!,
        }
      } catch (error) {
        await rewrite.rollback()
        throw error
      }
    },
  })
}

export async function deleteMcpTag(
  context: LibraryContext,
  input: { operationId: string; tagId: string },
) {
  return runIdempotent({
    db: context.env.DB,
    userId: context.userId,
    operationId: input.operationId,
    tool: 'delete_tag',
    request: input,
    recover: async () => {
      const existing = await loadTagOrNull(
        context.env.DB,
        context.userId,
        input.tagId,
      )
      return existing ? null : { ok: true, affected: 0, tag_id: input.tagId }
    },
    execute: async () => {
      const tag = await loadTagOrNull(
        context.env.DB,
        context.userId,
        input.tagId,
      )
      if (!tag) throw ApiError.notFound('Tag not found')
      const rewrite = await rewriteTagInNotes(
        context.env,
        context.ftsEnabled,
        context.userId,
        tag.id,
        tag.name,
        null,
      )
      try {
        const results = await context.env.DB.batch([
          context.env.DB.prepare(
            `DELETE FROM note_tags WHERE tag_id = ?1`,
          ).bind(tag.id),
          context.env.DB.prepare(
            `DELETE FROM tags WHERE id = ?1 AND user_id = ?2 AND name = ?3`,
          ).bind(tag.id, context.userId, tag.name),
        ])
        if (!results[1]?.meta.changes)
          throw ApiError.conflict('The tag changed elsewhere')
        await recordChange(context, 'tag', tag.id, 'delete', Date.now())
        return { ok: true, affected: rewrite.rewritten, tag_id: tag.id }
      } catch (error) {
        await rewrite.rollback()
        throw error
      }
    },
  })
}

export async function previewMcpTagChange(
  db: D1Database,
  userId: string,
  tagId: string,
  nextName?: string | null,
) {
  const tag = await loadTagOrNull(db, userId, tagId)
  if (!tag) throw ApiError.notFound('Tag not found')
  const normalizedName = nextName == null ? null : normalizeTagName(nextName)
  const [usage, destination] = await Promise.all([
    db
      .prepare(
        'SELECT COUNT(*) AS total FROM note_tags nt ' +
          'JOIN notes n ON n.id = nt.note_id\n' +
          '        WHERE n.user_id = ?1 AND nt.tag_id = ?2',
      )
      .bind(userId, tagId)
      .first<{ total: number }>(),
    normalizedName
      ? loadTagByName(db, userId, normalizedName, tagId)
      : Promise.resolve(null),
  ])
  return {
    tag,
    action: normalizedName ? 'rename' : 'delete',
    next_name: normalizedName,
    affected_notes: usage?.total ?? 0,
    merges_into: destination,
  }
}
