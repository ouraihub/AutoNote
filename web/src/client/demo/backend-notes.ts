import type { Hono } from 'hono'
import { LIMITS } from '@shared/constants'
import {
  deriveExcerpt,
  deriveTitle,
  extractWikiLinks,
  normalizeLinkKey,
} from '@shared/markdown-utils'
import { duplicateNoteTitle, utf8ByteLength } from '@shared/text-utils'
import type { Note } from '@shared/types'
import { newDemoId, refreshNote, type DemoState } from './state'
import { summarize } from './state'
import { findVersion, purgeNote, saveVersion } from './backend-helpers'
import { jsonBody } from './backend-utils'
import { apiError } from './responses'
export function registerNotesRoutes(app: Hono, state: DemoState): void {
  app.get('/api/notes', (c) => {
    const query = c.req.query()
    let notes = [...state.notes.values()]
    const view = query.view ?? 'all'
    if (view === 'trash')
      notes = notes.filter((note) => note.deletedAt !== null)
    else {
      notes = notes.filter((note) => note.deletedAt === null)
      if (view === 'starred') notes = notes.filter((note) => note.isStarred)
      if (view === 'unfiled')
        notes = notes.filter((note) => note.folderId === null)
      if (view === 'archived') notes = notes.filter((note) => note.isArchived)
      if (view === 'folder')
        notes = notes.filter((note) => note.folderId === query.folderId)
      if (view === 'tag')
        notes = notes.filter((note) => note.tags.includes(query.tag ?? ''))
      if (view === 'all' || view === 'recent')
        notes = notes.filter((note) => !note.isArchived)
    }
    const sort = query.sort ?? 'updated'
    const direction = query.order === 'asc' ? 1 : -1
    notes.sort((left, right) => {
      const compared =
        sort === 'title'
          ? left.title.localeCompare(right.title)
          : sort === 'created'
            ? left.createdAt - right.createdAt
            : left.updatedAt - right.updatedAt
      return compared * direction
    })
    const limit = Math.max(1, Math.min(500, Number(query.limit) || 100))
    const offset = Number(query.cursor ?? 0)
    if (!Number.isSafeInteger(offset) || offset < 0)
      return apiError(400, 'bad_request', 'Invalid notes cursor')
    return c.json({
      notes: notes.slice(offset, offset + limit).map(summarize),
      nextCursor: offset + limit < notes.length ? String(offset + limit) : null,
      total: notes.length,
    })
  })
  app.post('/api/notes', async (c) => {
    const body = await jsonBody(c.req.raw)
    if (
      body.id !== undefined &&
      (typeof body.id !== 'string' || !/^[0-9a-hjkmnp-tv-z]{26}$/.test(body.id))
    ) {
      return apiError(400, 'bad_request', 'id must be a valid note id')
    }
    const requestedId = typeof body.id === 'string' ? body.id : newDemoId()
    const existing = state.notes.get(requestedId)
    if (existing) return c.json(existing)
    const content = typeof body.content === 'string' ? body.content : ''
    if (utf8ByteLength(content) > LIMITS.contentMaxBytes) {
      return apiError(
        413,
        'payload_too_large',
        'Note content exceeds the 2 MB limit',
      )
    }
    const now = Date.now()
    const base: Note = {
      id: requestedId,
      title: '',
      excerpt: '',
      content: '',
      folderId:
        typeof body.folderId === 'string' && state.folders.has(body.folderId)
          ? body.folderId
          : null,
      tags: [],
      isPinned: false,
      isStarred: body.isStarred === true,
      isArchived: false,
      wordCount: 0,
      charCount: 0,
      rev: 1,
      position: now,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    }
    const created = refreshNote(
      base,
      content,
      typeof body.title === 'string' ? body.title : deriveTitle(content),
    )
    state.notes.set(created.id, created)
    state.cursor++
    return c.json(created, 201)
  })
  app.post('/api/notes/trash/empty', (c) => {
    const ids = [...state.notes.values()]
      .filter((note) => note.deletedAt !== null)
      .map((note) => note.id)
    for (const id of ids) purgeNote(state, id)
    return c.json({ purged: ids.length })
  })
  app.get('/api/notes/:id/versions', (c) => {
    const versions = state.versions.get(c.req.param('id')) ?? []
    return c.json({
      versions: versions.map((version) => {
        const meta = { ...version }
        delete (meta as Partial<typeof version>).content
        return meta
      }),
    })
  })
  app.get('/api/notes/:id/versions/:versionId', (c) => {
    const version = findVersion(
      state,
      c.req.param('id'),
      c.req.param('versionId'),
    )
    return version
      ? c.json(version)
      : apiError(404, 'not_found', 'Version not found')
  })
  app.post('/api/notes/:id/versions/:versionId/restore', (c) => {
    const id = c.req.param('id')
    const current = state.notes.get(id)
    const version = findVersion(state, id, c.req.param('versionId'))
    if (!current || !version)
      return apiError(404, 'not_found', 'Version not found')
    saveVersion(state, current)
    const restored = refreshNote(
      { ...current, rev: current.rev + 1, updatedAt: Date.now() },
      version.content,
      version.title,
    )
    state.notes.set(id, restored)
    state.cursor++
    return c.json(restored)
  })
  app.get('/api/notes/:id/backlinks', (c) => {
    const target = state.notes.get(c.req.param('id'))
    if (!target) return apiError(404, 'not_found', 'Note not found')
    const key = normalizeLinkKey(target.title)
    const backlinks = [...state.notes.values()]
      .filter(
        (note) =>
          note.id !== target.id &&
          extractWikiLinks(note.content).some((link) => link.key === key),
      )
      .map((note) => ({
        id: note.id,
        title: note.title,
        context: deriveExcerpt(note.content, 120),
      }))
    return c.json({ backlinks })
  })
  app.post('/api/notes/:id/restore', (c) => {
    const note = state.notes.get(c.req.param('id'))
    if (!note) return apiError(404, 'not_found', 'Note not found')
    const restored = {
      ...note,
      deletedAt: null,
      updatedAt: Date.now(),
      rev: note.rev + 1,
    }
    state.notes.set(note.id, restored)
    state.cursor++
    return c.json(restored)
  })
  app.post('/api/notes/:id/duplicate', async (c) => {
    const source = state.notes.get(c.req.param('id'))
    if (!source) return apiError(404, 'not_found', 'Note not found')
    const body = await jsonBody(c.req.raw)
    if (
      body.id !== undefined &&
      (typeof body.id !== 'string' || !/^[0-9a-hjkmnp-tv-z]{26}$/.test(body.id))
    ) {
      return apiError(400, 'bad_request', 'id must be a valid note id')
    }
    const id = typeof body.id === 'string' ? body.id : newDemoId()
    const existing = state.notes.get(id)
    if (existing) return c.json(existing)
    const now = Date.now()
    const copy = refreshNote(
      {
        ...source,
        id,
        rev: 1,
        createdAt: now,
        updatedAt: now,
        position: now,
        deletedAt: null,
      },
      source.content,
      duplicateNoteTitle(source.title, LIMITS.titleMaxLength),
    )
    state.notes.set(copy.id, copy)
    state.cursor++
    return c.json(copy, 201)
  })
  app.delete('/api/notes/:id/purge', (c) => {
    const id = c.req.param('id')
    if (!state.notes.has(id))
      return apiError(404, 'not_found', 'Note not found')
    purgeNote(state, id)
    return c.json({ ok: true as const, cursor: state.cursor })
  })
  app.get('/api/notes/:id', (c) => {
    const note = state.notes.get(c.req.param('id'))
    return note ? c.json(note) : apiError(404, 'not_found', 'Note not found')
  })
  app.patch('/api/notes/:id', async (c) => {
    const id = c.req.param('id')
    const note = state.notes.get(id)
    if (!note) return apiError(404, 'not_found', 'Note not found')
    const body = await jsonBody(c.req.raw)
    if (body.rev !== note.rev) {
      return apiError(409, 'conflict', 'The note changed on another device', {
        server: note,
      })
    }
    const nextContent =
      typeof body.content === 'string' ? body.content : note.content
    if (utf8ByteLength(nextContent) > LIMITS.contentMaxBytes) {
      return apiError(
        413,
        'payload_too_large',
        'Note content exceeds the 2 MB limit',
      )
    }
    if (typeof body.content === 'string' || typeof body.title === 'string')
      saveVersion(state, note)
    const updated = refreshNote(
      {
        ...note,
        folderId:
          body.folderId === null
            ? null
            : typeof body.folderId === 'string' &&
                state.folders.has(body.folderId)
              ? body.folderId
              : note.folderId,
        isPinned:
          typeof body.isPinned === 'boolean' ? body.isPinned : note.isPinned,
        isStarred:
          typeof body.isStarred === 'boolean' ? body.isStarred : note.isStarred,
        isArchived:
          typeof body.isArchived === 'boolean'
            ? body.isArchived
            : note.isArchived,
        rev: note.rev + 1,
        updatedAt: Date.now(),
      },
      nextContent,
      typeof body.title === 'string' ? body.title : undefined,
    )
    state.notes.set(id, updated)
    state.cursor++
    return c.json(updated)
  })
  app.delete('/api/notes/:id', (c) => {
    const note = state.notes.get(c.req.param('id'))
    if (!note) return apiError(404, 'not_found', 'Note not found')
    const removed = {
      ...note,
      deletedAt: Date.now(),
      updatedAt: Date.now(),
      rev: note.rev + 1,
    }
    state.notes.set(note.id, removed)
    state.cursor++
    return c.json(removed)
  })
}
