import { z } from 'zod'
import type { Env } from '../env'
import { badRequest, notFound, KitFailure } from './kit'
import type { ImagePart, ImageRef } from '@ouraihub/aether-contracts'
import { checkImages as checkImageParts, encodeImage as encode } from '@ouraihub/aether-core/images'
import { KitFailure as CoreFailure } from '@ouraihub/aether-core/error'
export { MAX_IMAGE_BYTES } from '@ouraihub/aether-core/images'

export const IMAGE_TTL_MS = 7 * 24 * 60 * 60 * 1000
export { encode }
export type ImageKind = 'input' | 'generated'

export const ImagesSchema = z.array(z.strictObject({ mime: z.string(), data: z.string() })).default([])

export function checkImages(images: readonly ImagePart[]): void {
  if (images.length > 4) throw badRequest('images', 'count', 4)
  try {
    checkImageParts(images)
  } catch (error) {
    if (error instanceof CoreFailure) throw new KitFailure(error.code, error.message, error.details)
    throw error
  }
}

async function storeImage(
  env: Env,
  userId: string,
  turnId: string,
  idx: number,
  image: ImagePart,
  kind: ImageKind,
  now: number,
): Promise<void> {
  const key = `ai-images/${userId}/${turnId}/${idx}`
  await env.FILES!.put(
    key,
    Uint8Array.from(atob(image.data), (c) => c.charCodeAt(0)),
    { httpMetadata: { contentType: image.mime } },
  )
  await env.DB.prepare(
    'INSERT INTO ai_turn_images (user_id, turn_id, idx, mime, object_key, created_at, kind) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)',
  )
    .bind(userId, turnId, idx, image.mime, key, now, kind)
    .run()
}

export async function saveImages(
  env: Env,
  userId: string,
  turnId: string,
  images: readonly ImagePart[],
): Promise<void> {
  if (!images.length) return
  if (!env.FILES) throw badRequest('images', 'storage_unavailable')
  const now = Date.now()
  for (const [idx, image] of images.entries()) await storeImage(env, userId, turnId, idx, image, 'input', now)
}

/** Appends one image `generate_image` produced during `turnId`'s run (docs/20 §3). */
export async function saveGenerated(env: Env, userId: string, turnId: string, image: ImagePart): Promise<void> {
  if (!env.FILES) throw badRequest('images', 'storage_unavailable')
  const next = await env.DB.prepare(
    'SELECT COALESCE(MAX(idx), -1) + 1 AS idx FROM ai_turn_images WHERE user_id = ?1 AND turn_id = ?2',
  )
    .bind(userId, turnId)
    .first<{ idx: number }>()
  await storeImage(env, userId, turnId, next?.idx ?? 0, image, 'generated', Date.now())
}

/** Copies rows of `kind` (all kinds when null); retry copies only the user's input images. */
export async function copyImages(
  db: D1Database,
  userId: string,
  pairs: readonly (readonly [from: string, to: string])[],
  kind: ImageKind | null = null,
): Promise<void> {
  if (!pairs.length) return
  await db.batch(
    pairs.map(([from, to]) =>
      db
        .prepare(
          `INSERT INTO ai_turn_images (user_id, turn_id, idx, mime, object_key, created_at, kind)
     SELECT user_id, ?3, idx, mime, object_key, created_at, kind FROM ai_turn_images WHERE user_id = ?1 AND turn_id = ?2 AND (?4 IS NULL OR kind = ?4)`,
        )
        .bind(userId, from, to, kind),
    ),
  )
}

export interface ImageRow {
  turnId: string
  idx: number
  mime: string
  objectKey: string | null
  kind: ImageKind
}

export function imageRefs(conversationId: string, turnId: string, rows: readonly ImageRow[]): ImageRef[] {
  return rows.map((row) => ({
    mime: row.mime,
    url: row.objectKey
      ? `/api/ai/kit/conversations/${encodeURIComponent(conversationId)}/turns/${encodeURIComponent(turnId)}/images/${row.idx}`
      : null,
  }))
}

/** Bytes of the still-stored images of `turnId`; expired or missing objects are skipped. */
export async function loadImages(env: Env, rows: readonly ImageRow[]): Promise<ImagePart[]> {
  const out: ImagePart[] = []
  for (const row of rows) {
    if (!row.objectKey || !env.FILES) continue
    const object = await env.FILES.get(row.objectKey)
    if (object) out.push({ mime: row.mime, data: encode(new Uint8Array(await object.arrayBuffer())) })
  }
  return out
}

export async function readImage(
  env: Env,
  userId: string,
  conversationId: string,
  turnId: string,
  idx: number,
): Promise<Response> {
  const row = await env.DB.prepare(
    `SELECT i.mime, i.object_key AS objectKey FROM ai_turn_images i
     JOIN ai_chat_turns t ON t.id = i.turn_id AND t.user_id = i.user_id
     WHERE i.user_id = ?1 AND t.conversation_id = ?2 AND i.turn_id = ?3 AND i.idx = ?4`,
  )
    .bind(userId, conversationId, turnId, idx)
    .first<{ mime: string; objectKey: string | null }>()
  const object = row?.objectKey && env.FILES ? await env.FILES.get(row.objectKey) : null
  if (!row || !object) throw notFound('image')
  return new Response(object.body, {
    headers: {
      'Content-Type': row.mime,
      'Cache-Control': 'private, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

/** Deletes rows of `turnIds`, then each R2 object no longer referenced by any row. */
export async function forgetImages(env: Env, userId: string, turnIds: readonly string[]): Promise<void> {
  if (!turnIds.length) return
  const ids = JSON.stringify(turnIds)
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT object_key AS objectKey FROM ai_turn_images WHERE user_id = ?1 AND object_key IS NOT NULL AND turn_id IN (SELECT value FROM json_each(?2))`,
  )
    .bind(userId, ids)
    .all<{ objectKey: string }>()
  await env.DB.prepare('DELETE FROM ai_turn_images WHERE user_id = ?1 AND turn_id IN (SELECT value FROM json_each(?2))')
    .bind(userId, ids)
    .run()
  for (const { objectKey } of results) {
    const still = await env.DB.prepare('SELECT 1 FROM ai_turn_images WHERE object_key = ?1 LIMIT 1')
      .bind(objectKey)
      .first()
    if (!still) await env.FILES?.delete(objectKey)
  }
}

export async function purgeExpiredChatImages(env: Env, now = Date.now()): Promise<number> {
  if (!env.FILES) return 0
  const { results } = await env.DB.prepare(
    'SELECT DISTINCT object_key AS objectKey FROM ai_turn_images WHERE object_key IS NOT NULL AND created_at < ?1 LIMIT 100',
  )
    .bind(now - IMAGE_TTL_MS)
    .all<{ objectKey: string }>()
  for (const { objectKey } of results) {
    await env.FILES.delete(objectKey)
    await env.DB.prepare('UPDATE ai_turn_images SET object_key = NULL WHERE object_key = ?1').bind(objectKey).run()
  }
  return results.length
}
