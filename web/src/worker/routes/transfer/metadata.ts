import { LIMITS } from '@shared/constants'
import { isRecord } from './values'
import { newId } from '../../lib/id'

export async function restoreTagMetadata(
  db: D1Database,
  userId: string,
  rawTags: unknown[],
): Promise<void> {
  const byName = new Map<
    string,
    { id: string; name: string; color: string | null }
  >()
  for (const raw of rawTags) {
    if (!isRecord(raw) || typeof raw.name !== 'string') continue
    const name = raw.name.trim().replace(/^#+/, '')
    if (!name || name.length > LIMITS.tagNameMaxLength || /[\s#]/.test(name))
      continue
    byName.set(name.toLocaleLowerCase(), {
      id: newId(),
      name,
      color:
        typeof raw.color === 'string' &&
        /^#[0-9a-f]{6}$/i.test(raw.color.trim())
          ? raw.color.trim()
          : null,
    })
  }
  if (!byName.size) return

  const rows = JSON.stringify([...byName.values()])
  const now = Date.now()
  await db.batch([
    db
      .prepare(
        'INSERT INTO tags (id, user_id, name, color, is_manual, ' +
          'created_at)\n       SELECT json_extract(j.value, ' +
          "'$.id'), ?2,\n              json_extract(j.value, " +
          "'$.name'), json_extract(j.value, '$.color'), 1, ?3\n     " +
          '    FROM json_each(?1) AS j\n        WHERE NOT EXISTS (\n ' +
          '         SELECT 1 FROM tags existing\n           WHERE ' +
          'existing.user_id = ?2\n             AND existing.name = ' +
          "json_extract(j.value, '$.name') COLLATE NOCASE\n        )",
      )
      .bind(rows, userId, now),
    db
      .prepare(
        'UPDATE tags SET\n         color = COALESCE(color, (\n     ' +
          "      SELECT json_extract(j.value, '$.color') FROM " +
          'json_each(?1) AS j\n            WHERE ' +
          "json_extract(j.value, '$.name') = tags.name COLLATE " +
          'NOCASE LIMIT 1\n         )),\n         is_manual = 1\n     ' +
          '  WHERE user_id = ?2 AND EXISTS (\n         SELECT 1 ' +
          'FROM json_each(?1) AS j\n          WHERE ' +
          "json_extract(j.value, '$.name') = tags.name COLLATE " +
          'NOCASE\n       )',
      )
      .bind(rows, userId),
    db
      .prepare(
        `INSERT INTO changes (user_id, entity, entity_id, op, at)
       SELECT ?1, 'tag', t.id, 'upsert', ?2
         FROM tags t JOIN json_each(?3) AS j
           ON json_extract(j.value, '$.name') = t.name COLLATE NOCASE
        WHERE t.user_id = ?1`,
      )
      .bind(userId, now, rows),
  ])
}
