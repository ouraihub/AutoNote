import { LIMITS } from '@shared/constants'
import type { Attachment } from '@shared/types'
import type { AppBindings } from '../env'
import { persistAttachmentWithinQuota } from '../attachments/storage'
import { ApiError } from '../lib/errors'
import { newId } from '../lib/id'
import { FORM_BODY_LIMITS, readFormDataWithinLimit } from '../lib/request'
import { consumeAttemptBudget, ThrottleError } from '../lib/throttle'
import { requireAuth } from '../middleware/auth'
import { Hono } from 'hono'
export const filesUploadRoutes = new Hono<AppBindings>()
filesUploadRoutes.post('/', requireAuth, async (c) => {
  const userId = c.get('userId')
  try {
    await consumeAttemptBudget(c.env.DB, [{ key: `attachment-upload:${userId}`, maxAttempts: LIMITS.attachmentUploadsPerHour, windowMs: 60 * 60 * 1000, lockMs: 60 * 60 * 1000 }])
  } catch (error) {
    if (error instanceof ThrottleError) throw new ApiError(429, 'too_many_attempts', `Too many uploads. Try again in ${error.retryAfterSec} seconds`, { retryAfter: error.retryAfterSec })
    throw error
  }
  const form = await readFormDataWithinLimit(c.req, FORM_BODY_LIMITS.attachment)
  const file = form.get('file')
  if (!(file instanceof File)) throw ApiError.badRequest('Missing file field')
  if (file.size > LIMITS.attachmentMaxBytes) throw ApiError.tooLarge('The file exceeds the 25 MB limit')
  const bytes = new Uint8Array(await file.arrayBuffer())
  const id = newId()
  const rawNoteId = form.get('noteId')
  const noteId = typeof rawNoteId === 'string' && rawNoteId ? rawNoteId.slice(0, 128) : null
  if (noteId) {
    const owned = await c.env.DB.prepare(`SELECT id FROM notes WHERE id = ?1 AND user_id = ?2 AND deleted_at IS NULL`).bind(noteId, userId).first<{ id: string }>()
    if (!owned) throw ApiError.badRequest('The associated note does not exist')
  }
  const now = Date.now()
  const stored = await persistAttachmentWithinQuota(c.env, { id, userId, noteId, filename: file.name || 'file', reportedMime: file.type, bytes, createdAt: now })
  const attachment: Attachment = { id, noteId, filename: stored.filename, mime: stored.mime, size: bytes.byteLength, width: stored.width, height: stored.height, url: `/api/files/${id}`, createdAt: now }
  return c.json(attachment, 201)
})
