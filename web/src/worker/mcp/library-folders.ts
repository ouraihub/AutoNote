import { ApiError } from '../lib/errors'
import { isValidId, newId } from '../lib/id'
import { folderPromotionOrder } from '../routes/folder-helpers'

import type { LibraryContext } from './library'
import {
  loadFolderOrNull,
  normalizeFolderName,
  validateFolderParent,
  validateFolderMoveDepth,
  recordChange,
  notifyMutation,
} from './library-tail'
import { runIdempotent } from './operations'

export async function createMcpFolder(
  context: LibraryContext,
  input: {
    operationId: string
    folderId?: string
    name: string
    parentId?: string | null
    icon?: string | null
    color?: string | null
  },
) {
  const id = input.folderId ?? newId()
  if (!isValidId(id))
    throw ApiError.badRequest('folder_id must be a valid AutoNote id')
  const request = { ...input, folderId: id }
  return runIdempotent({
    db: context.env.DB,
    userId: context.userId,
    operationId: input.operationId,
    tool: 'create_folder',
    request,
    recovery: { folderId: id },
    recover: async () => {
      const folder = await loadFolderOrNull(context.env.DB, context.userId, id)
      if (!folder) return null
      const matches =
        folder.parent_id === (input.parentId ?? null) &&
        folder.name.toLowerCase() ===
          normalizeFolderName(input.name).toLowerCase() &&
        folder.icon === (input.icon ?? null) &&
        folder.color === (input.color ?? null)
      return matches ? folder : null
    },
    execute: async () => {
      const name = normalizeFolderName(input.name)
      await validateFolderParent(
        context.env.DB,
        context.userId,
        input.parentId ?? null,
      )
      const collision = await context.env.DB.prepare(
        `SELECT 1 FROM folders WHERE id = ?1`,
      )
        .bind(id)
        .first()
      if (collision) throw ApiError.conflict('This folder id is already in use')
      const now = Date.now()
      const inserted = await context.env.DB.prepare(
        'INSERT INTO folders ' +
          '(id, user_id, parent_id, name, icon, color, position, ' +
          'created_at, updated_at)\n' +
          '         SELECT ?1, ?2, ?3, ?4, ?5, ?6,\n' +
          '           ' +
          'COALESCE(MAX(position), 0) + 1000, ?7, ?7 FROM folders\n' +
          '          WHERE user_id = ?2 AND parent_id IS ?3\n' +
          '            ' +
          'AND (?3 IS NULL OR EXISTS (SELECT 1 FROM folders\n' +
          '              ' +
          'WHERE id = ?3 AND user_id = ?2 AND deleted_at IS NULL))\n' +
          '            AND NOT EXISTS (SELECT 1 FROM folders\n' +
          '              WHERE user_id = ?2 AND parent_id IS ?3 ' +
          'AND lower(name) = lower(?4) AND deleted_at IS NULL)',
      )
        .bind(
          id,
          context.userId,
          input.parentId ?? null,
          name,
          input.icon ?? null,
          input.color ?? null,
          now,
        )
        .run()
      if (!inserted.meta.changes)
        throw ApiError.conflict('A sibling folder already uses this name')
      await recordChange(context, 'folder', id, 'upsert', now)
      return (await loadFolderOrNull(context.env.DB, context.userId, id))!
    },
  })
}

export async function updateMcpFolder(
  context: LibraryContext,
  input: {
    operationId: string
    folderId: string
    expectedUpdatedAt: number
    name?: string
    parentId?: string | null
    icon?: string | null
    color?: string | null
  },
) {
  return runIdempotent({
    db: context.env.DB,
    userId: context.userId,
    operationId: input.operationId,
    tool: 'update_folder',
    request: input,
    execute: async () => {
      const current = await loadFolderOrNull(
        context.env.DB,
        context.userId,
        input.folderId,
      )
      if (!current) throw ApiError.notFound('Folder not found')
      if (current.updated_at !== input.expectedUpdatedAt)
        throw ApiError.conflict('The folder changed elsewhere')
      const parentId =
        input.parentId === undefined ? current.parent_id : input.parentId
      await validateFolderParent(
        context.env.DB,
        context.userId,
        parentId,
        input.folderId,
      )
      await validateFolderMoveDepth(
        context.env.DB,
        context.userId,
        input.folderId,
        parentId,
      )
      const name =
        input.name === undefined
          ? current.name
          : normalizeFolderName(input.name)
      const now = Math.max(Date.now(), current.updated_at + 1)
      const update = context.env.DB.prepare(
        'UPDATE folders SET parent_id = ?1, name = ?2, ' +
          'icon = ?3, color = ?4, updated_at = ?5\n' +
          '          WHERE id = ?6 AND user_id = ?7 ' +
          'AND updated_at = ?8 AND deleted_at IS NULL\n' +
          '            AND NOT EXISTS (SELECT 1 FROM folders\n' +
          '              WHERE user_id = ?7 AND parent_id IS ?1 ' +
          'AND lower(name) = lower(?2)\n' +
          '                AND id != ?6 AND deleted_at IS NULL)',
      ).bind(
        parentId,
        name,
        input.icon === undefined ? current.icon : input.icon,
        input.color === undefined ? current.color : input.color,
        now,
        input.folderId,
        context.userId,
        current.updated_at,
      )
      const change = context.env.DB.prepare(
        'INSERT INTO changes (user_id, entity, entity_id, op, at)\n' +
          "         SELECT ?1, 'folder', ?2, 'upsert', ?3\n" +
          '          WHERE EXISTS (SELECT 1 FROM folders ' +
          'WHERE id = ?2 AND user_id = ?1 AND updated_at = ?3)',
      ).bind(context.userId, input.folderId, now)
      const [updated] = await context.env.DB.batch([update, change])
      if (!updated?.meta.changes)
        throw ApiError.conflict(
          'The folder changed or a sibling uses this name',
        )
      await notifyMutation(context)
      return (await loadFolderOrNull(
        context.env.DB,
        context.userId,
        input.folderId,
      ))!
    },
  })
}

export async function removeMcpFolderAndPromote(
  context: LibraryContext,
  input: { operationId: string; folderId: string; expectedUpdatedAt: number },
) {
  return runIdempotent({
    db: context.env.DB,
    userId: context.userId,
    operationId: input.operationId,
    tool: 'remove_folder_and_promote_contents',
    request: input,
    recover: async () => {
      const folder = await loadFolderOrNull(
        context.env.DB,
        context.userId,
        input.folderId,
      )
      return folder
        ? null
        : { ok: true, folder_id: input.folderId, promoted_to: null }
    },
    execute: async () => {
      const current = await loadFolderOrNull(
        context.env.DB,
        context.userId,
        input.folderId,
      )
      if (!current) throw ApiError.notFound('Folder not found')
      if (current.updated_at !== input.expectedUpdatedAt)
        throw ApiError.conflict('The folder changed elsewhere')
      const conflict = await context.env.DB.prepare(
        'SELECT 1 FROM folders child JOIN folders sibling\n' +
          '           ON sibling.user_id = child.user_id ' +
          'AND sibling.parent_id IS ?1\n' +
          '          AND lower(sibling.name) = lower(child.name) ' +
          'AND sibling.id != child.id\n' +
          '          AND sibling.deleted_at IS NULL\n' +
          '          ' +
          'WHERE child.user_id = ?2 AND child.parent_id = ?3 ' +
          'AND child.deleted_at IS NULL LIMIT 1',
      )
        .bind(current.parent_id, context.userId, current.id)
        .first()
      if (conflict)
        throw ApiError.conflict(
          'A promoted child would duplicate a sibling folder name',
        )
      const now = Math.max(Date.now(), current.updated_at + 1)
      const promotionOrder = await folderPromotionOrder(
        context.env.DB,
        context.userId,
        current,
      )
      const promotionJson = JSON.stringify(promotionOrder)
      const guard =
        'EXISTS (SELECT 1 FROM folders\n' +
        '        WHERE id = ?1 AND user_id = ?2 ' +
        'AND updated_at = ?3 AND deleted_at IS NULL)\n' +
        '        AND NOT EXISTS (\n' +
        '          SELECT 1 FROM folders child\n' +
        '          JOIN folders sibling\n' +
        '            ON sibling.user_id = child.user_id\n' +
        '           AND sibling.parent_id IS (\n' +
        '             ' +
        'SELECT parent_id FROM folders WHERE id = ?1 AND user_id = ?2\n' +
        '           )\n' +
        '           AND lower(sibling.name) = lower(child.name)\n' +
        '           AND sibling.deleted_at IS NULL\n' +
        '           AND sibling.id != ?1\n' +
        '           AND sibling.id != child.id\n' +
        '         ' +
        'WHERE child.parent_id = ?1 AND child.user_id = ?2 ' +
        'AND child.deleted_at IS NULL\n' +
        '        )'
      const results = await context.env.DB.batch([
        context.env.DB.prepare(
          `INSERT INTO changes (user_id, entity, entity_id, op, at)
           SELECT ?2, 'folder', json_extract(item.value, '$.id'), 'upsert', ?4
             FROM json_each(?5) item WHERE ${guard}`,
        ).bind(
          current.id,
          context.userId,
          current.updated_at,
          now,
          promotionJson,
        ),
        context.env.DB.prepare(
          `INSERT INTO changes (user_id, entity, entity_id, op, at)
           SELECT ?2, 'note', id, 'upsert', ?4 FROM notes
            WHERE folder_id = ?1 AND user_id = ?2 AND ${guard}`,
        ).bind(current.id, context.userId, current.updated_at, now),
        context.env.DB.prepare(
          `INSERT INTO changes (user_id, entity, entity_id, op, at)
           SELECT ?2, 'folder', ?1, 'delete', ?4 WHERE ${guard}`,
        ).bind(current.id, context.userId, current.updated_at, now),
        context.env.DB.prepare(
          `UPDATE folders SET deleted_at = ?4
            WHERE id = ?1 AND user_id = ?2 AND updated_at = ?3
              AND deleted_at IS NULL AND ${guard}`,
        ).bind(current.id, context.userId, current.updated_at, now),
        context.env.DB.prepare(
          'UPDATE folders SET\n' +
            '             parent_id = CASE WHEN parent_id = ?1 ' +
            'THEN ?4 ELSE parent_id END,\n' +
            '             position = COALESCE((\n' +
            '               ' +
            "SELECT json_extract(item.value, '$.position') " +
            'FROM json_each(?6) item\n' +
            '                ' +
            "WHERE json_extract(item.value, '$.id') = folders.id\n" +
            '             ), position),\n' +
            '             updated_at = MAX(updated_at + 1, ?5)\n' +
            '            ' +
            "WHERE id IN (SELECT json_extract(item.value, '$.id') " +
            'FROM json_each(?6) item)\n' +
            '              AND user_id = ?2 AND deleted_at IS NULL\n' +
            '              AND EXISTS (SELECT 1 FROM folders\n' +
            '                WHERE id = ?1 AND user_id = ?2 ' +
            'AND updated_at = ?3 AND deleted_at = ?5)',
        ).bind(
          current.id,
          context.userId,
          current.updated_at,
          current.parent_id,
          now,
          promotionJson,
        ),
        context.env.DB.prepare(
          'UPDATE notes SET folder_id = ?4, ' +
            'updated_at = MAX(updated_at + 1, ?5), rev = rev + 1\n' +
            '            WHERE folder_id = ?1 AND user_id = ?2\n' +
            '              AND EXISTS (SELECT 1 FROM folders\n' +
            '                WHERE id = ?1 AND user_id = ?2 ' +
            'AND updated_at = ?3 AND deleted_at = ?5)',
        ).bind(
          current.id,
          context.userId,
          current.updated_at,
          current.parent_id,
          now,
        ),
        context.env.DB.prepare(
          `DELETE FROM folders WHERE id = ?1 AND user_id = ?2 ` +
            `AND updated_at = ?3 AND deleted_at = ?4`,
        ).bind(current.id, context.userId, current.updated_at, now),
      ])
      if (!results[6]?.meta.changes)
        throw ApiError.conflict('The folder changed elsewhere')
      await notifyMutation(context)
      return { ok: true, folder_id: current.id, promoted_to: current.parent_id }
    },
  })
}

export async function previewMcpFolderRemoval(
  db: D1Database,
  userId: string,
  folderId: string,
) {
  const folder = await loadFolderOrNull(db, userId, folderId)
  if (!folder) throw ApiError.notFound('Folder not found')
  const [childrenResult, noteCount, conflictsResult] = await Promise.all([
    db
      .prepare(
        `SELECT id, name, position, updated_at FROM folders
        WHERE user_id = ?1 AND parent_id = ?2 AND deleted_at IS NULL
        ORDER BY position ASC, created_at ASC, id ASC`,
      )
      .bind(userId, folderId)
      .all<{
        id: string
        name: string
        position: number
        updated_at: number
      }>(),
    db
      .prepare(
        `SELECT COUNT(*) AS total FROM notes ` +
          `WHERE user_id = ?1 AND folder_id = ?2`,
      )
      .bind(userId, folderId)
      .first<{ total: number }>(),
    db
      .prepare(
        'SELECT child.id, child.name FROM folders child ' +
          'JOIN folders sibling\n' +
          '         ON sibling.user_id = child.user_id ' +
          'AND sibling.parent_id IS ?1\n' +
          '        AND lower(sibling.name) = lower(child.name) ' +
          'AND sibling.id != child.id\n' +
          '        AND sibling.deleted_at IS NULL\n' +
          '        ' +
          'WHERE child.user_id = ?2 AND child.parent_id = ?3 ' +
          'AND child.deleted_at IS NULL',
      )
      .bind(folder.parent_id, userId, folderId)
      .all<{ id: string; name: string }>(),
  ])
  return {
    folder,
    destination_parent_id: folder.parent_id,
    notes_to_promote: noteCount?.total ?? 0,
    child_folders_to_promote: childrenResult.results,
    conflicts: conflictsResult.results,
    can_apply: conflictsResult.results.length === 0,
  }
}
