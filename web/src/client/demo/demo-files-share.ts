import { Hono } from 'hono'
import { LIMITS, mergeSettingsPatch } from '@shared/constants'
import { extractAttachmentIds, extractWikiLinks } from '@shared/markdown-utils'
import type { PublicNote, ShareInfo } from '@shared/types'
import { APP_VERSION } from '../../release'
import { apiError, revokeAttachment } from './responses'
import { attachmentReferenceCounts, absoluteShare, jsonBody } from './helpers'
import { listTags, newDemoId, type DemoState } from './state'

export function registerFileShareRoutes(
  app: Hono,
  state: DemoState,
  unlockedShares: Set<string>,
): void {
  app.post('/api/files/prune', (c) => {
    const references = attachmentReferenceCounts(state)
    let removed = 0
    let freedBytes = 0
    for (const [id, attachment] of state.attachments) {
      if ((references.get(id) ?? 0) > 0) continue
      revokeAttachment(attachment.meta.url)
      state.attachments.delete(id)
      removed++
      freedBytes += attachment.meta.size
    }
    return c.json({ removed, freedBytes })
  })
  app.get('/api/files', (c) => {
    const references = attachmentReferenceCounts(state)
    const offset = Number(c.req.query('cursor') ?? 0)
    if (!Number.isSafeInteger(offset) || offset < 0)
      return apiError(400, 'bad_request', 'Invalid files cursor')
    const attachments = [...state.attachments.values()]
    return c.json({
      files: attachments.slice(offset, offset + 100).map((item) => ({
        ...item.meta,
        references: references.get(item.meta.id) ?? 0,
      })),
      nextCursor:
        offset + 100 < attachments.length ? String(offset + 100) : null,
    })
  })
  app.post('/api/files', async (c) => {
    const form = await c.req.raw.formData()
    const file = form.get('file')
    if (!(file instanceof File))
      return apiError(400, 'bad_request', 'Missing file')
    if (file.size > LIMITS.attachmentMaxBytes) {
      return apiError(
        413,
        'payload_too_large',
        'The file exceeds the 25 MB limit',
      )
    }
    const usedBytes = [...state.attachments.values()].reduce(
      (total, attachment) => total + attachment.meta.size,
      0,
    )
    if (usedBytes + file.size > LIMITS.attachmentQuotaBytes) {
      return apiError(
        413,
        'payload_too_large',
        'The account attachment quota has been reached',
      )
    }
    const rawNoteId = form.get('noteId')
    const noteId =
      typeof rawNoteId === 'string' && rawNoteId
        ? rawNoteId.slice(0, 128)
        : null
    if (noteId) {
      const note = state.notes.get(noteId)
      if (!note || note.deletedAt !== null) {
        return apiError(
          400,
          'bad_request',
          'The associated note does not exist',
        )
      }
    }
    const id = newDemoId()
    const url = URL.createObjectURL(file)
    const meta = {
      id,
      noteId,
      filename: file.name || 'file',
      mime: file.type || 'application/octet-stream',
      size: file.size,
      width: null,
      height: null,
      url,
      createdAt: Date.now(),
    }
    state.attachments.set(id, { meta, file })
    return c.json(meta, 201)
  })
  app.get('/api/files/:id', (c) => {
    const attachment = state.attachments.get(c.req.param('id'))
    const slug = c.req.query('share')
    if (slug !== undefined || !state.authenticated) {
      const share = [...state.shares.values()].find(
        (item) => item.info.slug === slug,
      )
      const note = share ? state.notes.get(share.info.noteId) : undefined
      if (
        !attachment ||
        !share ||
        !note ||
        note.deletedAt !== null ||
        (share.info.expiresAt !== null && share.info.expiresAt <= Date.now()) ||
        (share.password && !unlockedShares.has(share.info.slug)) ||
        (!extractAttachmentIds(note.content).includes(attachment.meta.id) &&
          !note.content.includes(attachment.meta.url))
      )
        return apiError(404, 'not_found', 'Attachment not found')
    }
    return attachment
      ? new Response(attachment.file, {
          headers: { 'Content-Type': attachment.meta.mime },
        })
      : apiError(404, 'not_found', 'Attachment not found')
  })
  app.delete('/api/files/:id', (c) => {
    const attachment = state.attachments.get(c.req.param('id'))
    if (!attachment) return apiError(404, 'not_found', 'Attachment not found')
    revokeAttachment(attachment.meta.url)
    state.attachments.delete(attachment.meta.id)
    return c.json({ ok: true as const })
  })

  app.get('/api/settings', (c) => c.json(state.settings))
  app.put('/api/settings', async (c) => {
    state.settings = mergeSettingsPatch(
      state.settings,
      await jsonBody(c.req.raw),
    )
    return c.json(state.settings)
  })
  app.get('/api/settings/stats', (c) => {
    const tags = listTags(state)
    const notes = [...state.notes.values()]
    return c.json({
      notes: notes.filter((note) => note.deletedAt === null).length,
      folders: state.folders.size,
      tags: tags.length,
      links: notes.reduce(
        (total, note) => total + extractWikiLinks(note.content).length,
        0,
      ),
      words: notes.reduce((total, note) => total + note.wordCount, 0),
      versions: [...state.versions.values()].reduce(
        (total, versions) => total + versions.length,
        0,
      ),
      attachments: state.attachments.size,
      attachmentBytes: [...state.attachments.values()].reduce(
        (total, item) => total + item.meta.size,
        0,
      ),
      trashed: notes.filter((note) => note.deletedAt !== null).length,
    })
  })

  app.get('/api/update', (c) =>
    c.json({
      currentVersion: APP_VERSION,
      latestVersion: null,
      updateUrl: null,
      checkedAt: null,
      status: 'unavailable' as const,
    }),
  )

  app.get('/api/share', (c) =>
    c.json({
      shares: [...state.shares.values()]
        .flatMap((share) => {
          const note = state.notes.get(share.info.noteId)
          return note
            ? [
                {
                  ...absoluteShare(share.info, c.req.url),
                  noteTitle: note.title,
                  deletedAt: note.deletedAt,
                },
              ]
            : []
        })
        .sort(
          (a, b) => b.createdAt - a.createdAt || b.slug.localeCompare(a.slug),
        ),
    }),
  )
  app.get('/api/share/:noteId', (c) => {
    const share = state.shares.get(c.req.param('noteId'))
    return c.json({
      share: share ? absoluteShare(share.info, c.req.url) : null,
    })
  })
  app.post('/api/share/:noteId', async (c) => {
    const noteId = c.req.param('noteId')
    const note = state.notes.get(noteId)
    if (!note || note.deletedAt !== null)
      return apiError(404, 'not_found', 'Note not found')
    const body = await jsonBody(c.req.raw)
    if (
      body.password !== undefined &&
      body.password !== null &&
      typeof body.password !== 'string'
    ) {
      return apiError(400, 'bad_request', 'password must be a string or null')
    }
    if (
      body.expiresIn !== undefined &&
      body.expiresIn !== null &&
      (typeof body.expiresIn !== 'number' ||
        !Number.isFinite(body.expiresIn) ||
        body.expiresIn < 0)
    ) {
      return apiError(
        400,
        'bad_request',
        'expiresIn must be a non-negative number or null',
      )
    }
    const existing = state.shares.get(noteId)
    let expiresAt = existing?.info.expiresAt ?? null
    if (body.expiresIn !== undefined) {
      expiresAt =
        typeof body.expiresIn === 'number' &&
        Number.isFinite(body.expiresIn) &&
        body.expiresIn > 0
          ? Date.now() + Math.min(body.expiresIn, 365 * 24 * 60 * 60 * 1000)
          : null
    }
    if (
      typeof body.password === 'string' &&
      body.password.length > LIMITS.passwordMaxLength
    ) {
      return apiError(
        400,
        'bad_request',
        `The access password must not exceed ${
          LIMITS.passwordMaxLength
        } characters`,
      )
    }
    if (
      typeof body.password === 'string' &&
      body.password.length > 0 &&
      body.password.length < 4
    ) {
      return apiError(
        400,
        'bad_request',
        'The access password must be at least 4 characters',
      )
    }
    const password =
      body.password === null || typeof body.password === 'string'
        ? body.password || null
        : (existing?.password ?? null)
    const info: ShareInfo = {
      slug: existing?.info.slug ?? newDemoId().slice(0, 20),
      noteId,
      url: '',
      hasPassword: Boolean(password),
      expiresAt,
      views: existing?.info.views ?? 0,
      createdAt: existing?.info.createdAt ?? Date.now(),
    }
    state.shares.set(noteId, { info, password })
    if (existing && existing.password !== password)
      unlockedShares.delete(info.slug)
    return c.json({ share: absoluteShare(info, c.req.url) })
  })
  app.delete('/api/share/:noteId', (c) => {
    state.shares.delete(c.req.param('noteId'))
    return c.json({ ok: true as const })
  })
  app.post('/api/public/:slug', async (c) => {
    const share = [...state.shares.values()].find(
      (item) => item.info.slug === c.req.param('slug'),
    )
    if (
      !share ||
      (share.info.expiresAt !== null && share.info.expiresAt <= Date.now())
    ) {
      return apiError(404, 'not_found', 'Shared note not found')
    }
    const body = await jsonBody(c.req.raw)
    if (share.password && body.password !== share.password) {
      return apiError(
        401,
        body.password ? 'password_invalid' : 'password_required',
        'Enter the share password',
      )
    }
    const note = state.notes.get(share.info.noteId)
    if (!note || note.deletedAt !== null)
      return apiError(404, 'not_found', 'Shared note not found')
    unlockedShares.add(share.info.slug)
    share.info = { ...share.info, views: share.info.views + 1 }
    const response: PublicNote = {
      title: note.title,
      content: [...state.attachments.values()].reduce(
        (content, item) =>
          content.replaceAll(
            item.meta.url,
            `/api/files/${item.meta.id}?share=${share.info.slug}`,
          ),
        note.content,
      ),
      updatedAt: note.updatedAt,
      createdAt: note.createdAt,
      author: { name: state.user.name, avatarUrl: state.user.avatarUrl },
      site: { name: 'AutoNote Demo' },
      share: { slug: share.info.slug },
    }
    return c.json(response)
  })
}
