import { Hono } from 'hono'
import { LIMITS, mergeSettingsPatch } from '@shared/constants'
import { APP_VERSION } from '../../release'
import { organizerColorOrNull } from '@shared/organizer-colors'
import {
  deriveExcerpt,
  extractAttachmentIds,
  extractWikiLinks,
  normalizeLinkKey,
  replaceTagInContent,
  wikiNoteTarget,
} from '@shared/markdown-utils'
import type {
  BackupRun,
  BackupTarget,
  BackupTargetConfig,
  BackupTargetInput,
  BackupTargetPatchInput,
  Folder,
  GraphResponse,
  ImportResult,
  McpSettingsInfo,
  Note,
  PublicNote,
  SearchResponse,
  SessionInfo,
  ShareInfo,
  SyncResponse,
} from '@shared/types'
import { readZip } from '@shared/zip'
import {
  exportResponse,
  importBundle,
  importMarkdown,
  importBackupBatch,
} from './transfer'
import {
  absoluteShare,
  attachmentReferenceCounts,
  availableDemoFolderName,
  createBackupTarget,
  demoBackupConfig,
  demoBackupTargetError,
  demoFolderDepth,
  demoFolderHeight,
  demoFolderSiblings,
  folderDescendants,
  hasDemoBackupSecret,
  promoteDemoFolderChildren,
} from './backend-tail'
import { registerNotesRoutes } from './backend-notes'
import { apiError, revokeAttachment } from './responses'
import {
  createDemoState,
  listFolders,
  listTags,
  newDemoId,
  refreshNote,
  type DemoState,
} from './state'
import { utf8ByteLength } from '@shared/text-utils'

const DEMO_CREDENTIALS = { username: 'admin', password: 'password' } as const
import { summarize } from './state'
export interface DemoRuntime {
  readonly userId: string
  fetch(request: Request): Promise<Response>
  resolveFileUrl(url: string): string
  dispose(): void
}

export function createDemoRuntime(): DemoRuntime {
  const state = createDemoState()
  const app = new Hono()
  const mcp = demoMcpSettings()
  const unlockedShares = new Set<string>()
  let disposed = false
  const revokeFiles = () => {
    for (const attachment of state.attachments.values())
      revokeAttachment(attachment.meta.url)
    state.attachments.clear()
  }
  app.onError((error) =>
    error instanceof SyntaxError
      ? apiError(400, 'bad_request', 'Invalid JSON request')
      : apiError(500, 'internal', 'Demo operation failed'),
  )

  app.use('/api/*', async (c, next) => {
    const path = c.req.path
    if (
      path === '/api/site' ||
      path === '/api/auth/session' ||
      path === '/api/auth/login' ||
      (path.startsWith('/api/files/') && Boolean(c.req.query('share'))) ||
      path.startsWith('/api/public/')
    ) {
      return next()
    }
    if (!state.authenticated)
      return apiError(401, 'unauthenticated', 'Please sign in first')
    return next()
  })

  app.get('/api/site', (c) => c.json(siteInfo(state)))
  app.get('/api/auth/session', (c) => c.json(sessionInfo(state)))
  app.post('/api/auth/login', async (c) => {
    const body = await jsonBody(c.req.raw)
    const username =
      typeof body.username === 'string'
        ? body.username.trim().toLowerCase()
        : ''
    const password = typeof body.password === 'string' ? body.password : ''
    if (username !== DEMO_CREDENTIALS.username || password !== state.password) {
      return apiError(
        401,
        'invalid_credentials',
        'Invalid username or password',
      )
    }
    state.authenticated = true
    return c.json(sessionInfo(state))
  })
  app.post('/api/auth/register', () =>
    apiError(403, 'registration_closed', 'Registration is closed'),
  )
  app.post('/api/auth/logout', (c) => {
    state.authenticated = false
    return c.json({ ok: true as const })
  })
  app.get('/api/auth/totp/status', (c) =>
    c.json({
      available: false,
      enabled: false,
      enabledAt: null,
      recoveryCodesRemaining: 0,
    }),
  )
  app.post('/api/auth/password', async (c) => {
    const body = await jsonBody(c.req.raw)
    if (body.currentPassword !== state.password) {
      return apiError(
        401,
        'wrong_password',
        'The current password is incorrect',
      )
    }
    if (typeof body.newPassword !== 'string' || body.newPassword.length < 8) {
      return apiError(
        400,
        'weak_password',
        'The new password must contain at least 8 characters',
      )
    }
    if (body.newPassword.length > LIMITS.passwordMaxLength) {
      return apiError(400, 'weak_password', 'The new password is too long')
    }
    state.password = body.newPassword
    return c.json({ ok: true as const })
  })
  app.put('/api/auth/profile', async (c) => {
    const body = await jsonBody(c.req.raw)
    if (body.name !== undefined) {
      if (
        typeof body.name !== 'string' ||
        !body.name.trim() ||
        body.name.trim().length > 64
      ) {
        return apiError(
          400,
          'invalid_profile_name',
          'Enter a valid display name',
        )
      }
      state.user = {
        ...state.user,
        name: body.name.trim().replace(/\s+/g, ' '),
      }
    }
    if (body.avatarUrl !== undefined) {
      if (
        typeof body.avatarUrl !== 'string' ||
        !(
          body.avatarUrl === '' ||
          /^dicebear:[0-9a-f]{32}$/.test(body.avatarUrl) ||
          /^data:image\/(?:png|jpeg|webp);base64,/.test(body.avatarUrl)
        )
      ) {
        return apiError(
          400,
          'invalid_avatar',
          'Choose a generated avatar or upload an image',
        )
      }
      state.user = { ...state.user, avatarUrl: body.avatarUrl }
    }
    state.cursor++
    return c.json(state.user)
  })
  app.put('/api/settings/registration', async (c) => {
    const body = await jsonBody(c.req.raw)
    if (body.password !== state.password) {
      return apiError(
        401,
        'wrong_password',
        'The current password is incorrect',
      )
    }
    state.registrationOpen = body.enabled === true
    return c.json({
      ok: true as const,
      registrationOpen: state.registrationOpen,
    })
  })

  app.get('/api/mcp', (c) =>
    c.json({ ...mcp, endpoint: `${new URL(c.req.url).origin}/mcp` }),
  )
  app.put('/api/mcp', async (c) => {
    const body = await jsonBody(c.req.raw)
    for (const key of ['enabled', 'writeEnabled', 'trashEnabled'] as const) {
      if (body[key] !== undefined && typeof body[key] !== 'boolean')
        return apiError(400, 'bad_request', 'Invalid MCP preference')
    }
    if (typeof body.enabled === 'boolean') mcp.enabled = body.enabled
    mcp.preferences = {
      writeEnabled:
        typeof body.writeEnabled === 'boolean'
          ? body.writeEnabled
          : mcp.preferences.writeEnabled,
      trashEnabled:
        typeof body.trashEnabled === 'boolean'
          ? body.trashEnabled
          : mcp.preferences.trashEnabled,
      updatedAt: Date.now(),
    }
    return c.json({
      enabled: mcp.enabled,
      preferences: mcp.preferences,
      reconnectRequired: false,
    })
  })
  app.post('/api/mcp/keys', async (c) => {
    const body = await jsonBody(c.req.raw)
    if (
      typeof body.name !== 'string' ||
      !body.name.trim() ||
      body.name.length > 120
    )
      return apiError(400, 'bad_request', 'Enter a valid key name')
    const key = {
      id: newDemoId(),
      name: body.name.trim(),
      scopes: [
        'notes:read',
        ...(mcp.preferences.writeEnabled ? ['notes:write'] : []),
      ],
      createdAt: Date.now(),
      lastUsedAt: null,
    }
    mcp.apiKeys.push(key)
    return c.json({ key, token: `demo-only-${newDemoId()}` }, 201)
  })
  app.delete('/api/mcp/keys/:id', (c) => {
    const index = mcp.apiKeys.findIndex((key) => key.id === c.req.param('id'))
    if (index < 0) return apiError(404, 'not_found', 'Key not found')
    mcp.apiKeys.splice(index, 1)
    return c.json({ ok: true })
  })
  app.delete('/api/mcp/grants/:id', (c) => {
    const index = mcp.grants.findIndex(
      (grant) => grant.id === c.req.param('id'),
    )
    if (index < 0) return apiError(404, 'not_found', 'Grant not found')
    mcp.grants.splice(index, 1)
    return c.json({ ok: true })
  })
  app.post('/api/mcp/grants/revoke-all', (c) => {
    const revoked = mcp.grants.length
    mcp.grants = []
    return c.json({ ok: true, revoked })
  })
  app.get('/api/mcp/ai-search', (c) => c.json(mcp.aiSearch))
  app.all('/api/mcp/*', () =>
    apiError(403, 'forbidden', 'Remote AI is unavailable in the demo'),
  )

  registerNotesRoutes(app, state)
  app.post('/api/folders', async (c) => {
    const body = await jsonBody(c.req.raw)
    if (
      body.id !== undefined &&
      (typeof body.id !== 'string' || !/^[0-9a-hjkmnp-tv-z]{26}$/.test(body.id))
    ) {
      return apiError(400, 'bad_request', 'id must be a valid folder id')
    }
    const requestedId = typeof body.id === 'string' ? body.id : null
    const existing = requestedId ? state.folders.get(requestedId) : null
    if (existing) return c.json(existing)
    const parentId =
      body.parentId === null || body.parentId === undefined
        ? null
        : typeof body.parentId === 'string' && state.folders.has(body.parentId)
          ? body.parentId
          : undefined
    if (parentId === undefined)
      return apiError(400, 'bad_request', 'The parent folder does not exist')
    if (parentId && demoFolderDepth(state, parentId) >= LIMITS.folderDepthMax) {
      return apiError(
        400,
        'bad_request',
        `Folder depth cannot exceed ${LIMITS.folderDepthMax} levels`,
      )
    }
    const now = Date.now()
    const siblings = demoFolderSiblings(state, parentId)
    const requestedName = typeof body.name === 'string' ? body.name.trim() : ''
    if (requestedName.length > LIMITS.folderNameMaxLength) {
      return apiError(400, 'bad_request', 'Folder name is too long')
    }
    const name =
      requestedName || availableDemoFolderName(siblings, 'New folder')
    if (
      siblings.some(
        (folder) =>
          folder.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
      )
    ) {
      return apiError(409, 'conflict', 'A sibling already uses this name')
    }
    const folder: Folder = {
      id: requestedId ?? newDemoId(),
      parentId,
      name,
      icon: typeof body.icon === 'string' ? body.icon : null,
      color: organizerColorOrNull(body.color),
      position: (siblings.at(-1)?.position ?? 0) + 1000,
      createdAt: now,
      updatedAt: now,
      noteCount: 0,
    }
    state.folders.set(folder.id, folder)
    state.cursor++
    return c.json(folder, 201)
  })
  app.patch('/api/folders/:id', async (c) => {
    const current = state.folders.get(c.req.param('id'))
    if (!current) return apiError(404, 'not_found', 'Folder not found')
    const body = await jsonBody(c.req.raw)
    if ('beforeId' in body && !('parentId' in body)) {
      return apiError(
        400,
        'bad_request',
        'parentId is required when reordering a folder',
      )
    }
    const parentId =
      body.parentId === undefined
        ? current.parentId
        : body.parentId === null
          ? null
          : typeof body.parentId === 'string' &&
              state.folders.has(body.parentId)
            ? body.parentId
            : undefined
    if (parentId === undefined)
      return apiError(400, 'bad_request', 'The parent folder does not exist')
    if (
      parentId === current.id ||
      folderDescendants(state, current.id).has(parentId ?? '')
    ) {
      return apiError(
        400,
        'bad_request',
        'A folder cannot be moved into its own descendant',
      )
    }
    if (
      (parentId ? demoFolderDepth(state, parentId) : 0) +
        demoFolderHeight(state, current.id) >
      LIMITS.folderDepthMax
    ) {
      return apiError(
        400,
        'bad_request',
        `Folder depth cannot exceed ${LIMITS.folderDepthMax} levels`,
      )
    }
    const name =
      typeof body.name === 'string' && body.name.trim()
        ? body.name.trim()
        : current.name
    if (name.length > LIMITS.folderNameMaxLength) {
      return apiError(400, 'bad_request', 'Folder name is too long')
    }
    if (
      demoFolderSiblings(state, parentId, current.id).some(
        (folder) =>
          folder.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
      )
    )
      return apiError(409, 'conflict', 'A sibling already uses this name')
    const updated: Folder = {
      ...current,
      name,
      parentId,
      icon:
        body.icon === null || typeof body.icon === 'string'
          ? body.icon
          : current.icon,
      color: 'color' in body ? organizerColorOrNull(body.color) : current.color,
      updatedAt: Date.now(),
    }
    const shouldPlace = 'beforeId' in body || parentId !== current.parentId
    if (shouldPlace) {
      const siblings = demoFolderSiblings(state, parentId, current.id)
      const beforeId =
        body.beforeId === null || body.beforeId === undefined
          ? null
          : typeof body.beforeId === 'string'
            ? body.beforeId
            : undefined
      if (beforeId === undefined || beforeId === current.id) {
        return apiError(400, 'bad_request', 'The target folder is invalid')
      }
      const index =
        beforeId === null
          ? siblings.length
          : siblings.findIndex((folder) => folder.id === beforeId)
      if (index < 0)
        return apiError(
          400,
          'bad_request',
          'The target folder is not in the destination',
        )
      siblings.splice(index, 0, updated)
      siblings.forEach((folder, orderIndex) => {
        state.folders.set(folder.id, {
          ...folder,
          parentId,
          position: (orderIndex + 1) * 1000,
          updatedAt:
            folder.id === updated.id ? updated.updatedAt : folder.updatedAt,
        })
      })
    } else {
      state.folders.set(updated.id, updated)
    }
    state.cursor++
    return c.json(state.folders.get(updated.id) ?? updated)
  })
  app.delete('/api/folders/:id', (c) => {
    const root = state.folders.get(c.req.param('id'))
    if (!root) return apiError(404, 'not_found', 'Folder not found')
    const strategy = c.req.query('strategy') === 'delete' ? 'delete' : 'move-up'
    const descendants = folderDescendants(state, root.id)
    if (strategy === 'delete') {
      const now = Date.now()
      for (const note of state.notes.values()) {
        if (descendants.has(note.folderId ?? '')) {
          state.notes.set(note.id, {
            ...note,
            folderId: null,
            deletedAt: now,
            updatedAt: now,
            rev: note.rev + 1,
          })
        }
      }
      for (const id of descendants) state.folders.delete(id)
    } else {
      promoteDemoFolderChildren(state, root)
      for (const note of state.notes.values()) {
        if (note.folderId === root.id)
          state.notes.set(note.id, { ...note, folderId: root.parentId })
      }
      state.folders.delete(root.id)
    }
    state.cursor++
    return c.json({ ok: true as const })
  })

  app.get('/api/tags', (c) => c.json({ tags: listTags(state) }))
  app.post('/api/tags', async (c) => {
    const body = await jsonBody(c.req.raw)
    if (
      body.id !== undefined &&
      (typeof body.id !== 'string' || !/^[0-9a-hjkmnp-tv-z]{26}$/.test(body.id))
    ) {
      return apiError(400, 'bad_request', 'id must be a valid tag id')
    }
    const requestedId = typeof body.id === 'string' ? body.id : null
    const existingById = requestedId
      ? listTags(state).find((tag) => tag.id === requestedId)
      : null
    if (existingById) return c.json(existingById)
    const name =
      typeof body.name === 'string' ? body.name.trim().replace(/^#+/, '') : ''
    if (!name || /[\s#]/.test(name) || name.length > LIMITS.tagNameMaxLength) {
      return apiError(400, 'bad_request', 'Tag name is invalid')
    }
    const existing = listTags(state).find(
      (tag) =>
        tag.name.localeCompare(name, undefined, { sensitivity: 'base' }) === 0,
    )
    if (existing)
      return apiError(409, 'conflict', 'A tag with this name already exists')
    const id = requestedId ?? newDemoId()
    state.tagIds.set(name, id)
    state.tagColors.set(
      name,
      body.color === null || typeof body.color === 'string' ? body.color : null,
    )
    state.cursor++
    const created = listTags(state).find((tag) => tag.id === id)
    if (!created) return apiError(500, 'internal', 'Tag creation failed')
    return c.json(created, 201)
  })
  app.patch('/api/tags/:id', async (c) => {
    const current = listTags(state).find((tag) => tag.id === c.req.param('id'))
    if (!current) return apiError(404, 'not_found', 'Tag not found')
    const body = await jsonBody(c.req.raw)
    if (typeof body.color === 'string' && !/^#[0-9a-f]{6}$/i.test(body.color)) {
      return apiError(
        400,
        'bad_request',
        'Tag color must be a six-digit hexadecimal color',
      )
    }
    if (
      typeof body.name === 'string' &&
      body.name.trim() &&
      body.name.trim() !== current.name
    ) {
      const requestedName = body.name.trim().replace(/^#/, '')
      const existing = listTags(state).find(
        (tag) =>
          tag.id !== current.id &&
          tag.name.localeCompare(requestedName, undefined, {
            sensitivity: 'base',
          }) === 0,
      )
      const nextName = existing?.name ?? requestedName
      let renamed = 0
      for (const note of state.notes.values()) {
        const content = replaceTagInContent(
          note.content,
          current.name,
          nextName,
        )
        if (content === note.content) continue
        state.notes.set(
          note.id,
          refreshNote(
            { ...note, rev: note.rev + 1, updatedAt: Date.now() },
            content,
          ),
        )
        renamed++
      }
      state.tagIds.delete(current.name)
      if (!existing) state.tagIds.set(nextName, current.id)
      state.tagColors.set(
        nextName,
        body.color === null || typeof body.color === 'string'
          ? body.color
          : (state.tagColors.get(nextName) ??
              state.tagColors.get(current.name) ??
              null),
      )
      state.tagColors.delete(current.name)
      state.cursor++
      return c.json({ ok: true as const, renamed })
    }
    if (body.color === null || typeof body.color === 'string')
      state.tagColors.set(current.name, body.color)
    state.cursor++
    return c.json(
      listTags(state).find((tag) => tag.id === current.id) ?? current,
    )
  })
  app.delete('/api/tags/:id', (c) => {
    const current = listTags(state).find((tag) => tag.id === c.req.param('id'))
    if (!current) return apiError(404, 'not_found', 'Tag not found')
    let affected = 0
    for (const note of state.notes.values()) {
      const content = replaceTagInContent(note.content, current.name, null)
      if (content === note.content) continue
      state.notes.set(
        note.id,
        refreshNote(
          { ...note, rev: note.rev + 1, updatedAt: Date.now() },
          content,
        ),
      )
      affected++
    }
    state.tagIds.delete(current.name)
    state.tagColors.delete(current.name)
    state.cursor++
    return c.json({ ok: true as const, affected })
  })

  app.get('/api/search', (c) => {
    const started = performance.now()
    const query = (c.req.query('q') ?? '').trim()
    const limit = Math.max(1, Math.min(100, Number(c.req.query('limit')) || 50))
    const needle = query.toLocaleLowerCase()
    const results = [...state.notes.values()]
      .filter(
        (note) =>
          note.deletedAt === null &&
          `${note.title}\n${note.content}`.toLocaleLowerCase().includes(needle),
      )
      .slice(0, limit)
      .map((note) => ({
        note: summarize(note),
        snippet: deriveExcerpt(note.content, 140),
        score: 1,
      }))
    const response: SearchResponse = {
      results,
      mode: 'like',
      took: Math.max(0, performance.now() - started),
      query: {
        text: query,
        tags: [],
        folder: null,
        starred: null,
        archived: null,
      },
    }
    return c.json(response)
  })
  app.post('/api/search/reindex', (c) =>
    c.json({ ok: true as const, indexed: state.notes.size }),
  )
  app.get('/api/graph', (c) => {
    const mode = c.req.query('mode') === 'local' ? 'local' : 'global'
    const centerId = c.req.query('center') || null
    const depth = Math.max(1, Math.min(3, Number(c.req.query('depth')) || 1))
    const limit = Math.max(
      50,
      Math.min(600, Number(c.req.query('limit')) || 350),
    )
    const needle = (c.req.query('q') ?? '').trim().toLocaleLowerCase()
    const folderId = c.req.query('folderId') ?? ''
    const tag = (c.req.query('tag') ?? '').trim().toLocaleLowerCase()
    const includeOrphans = c.req.query('includeOrphans') !== '0'
    const includeUnresolved = c.req.query('includeUnresolved') === '1'
    const active = [...state.notes.values()]
      .filter((note) => note.deletedAt === null && !note.isArchived)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    const byTitle = new Map<string, Note>()
    for (const note of active) {
      const key = normalizeLinkKey(note.title)
      if (!byTitle.has(key)) byTitle.set(key, note)
    }
    const linkRecords = active.flatMap((note) =>
      extractWikiLinks(note.content).map((link) => ({
        source: note.id,
        target: byTitle.get(link.key)?.id ?? null,
        key: link.key,
        title: wikiNoteTarget(link.target),
      })),
    )
    const allEdges = linkRecords
      .filter((link): link is typeof link & { target: string } =>
        Boolean(link.target && link.target !== link.source),
      )
      .map((link) => ({ source: link.source, target: link.target }))
    const uniqueEdges = [
      ...new Map(
        allEdges.map((edge) => [`${edge.source}>${edge.target}`, edge]),
      ).values(),
    ]
    const degree = new Map<string, number>()
    const incoming = new Map<string, number>()
    const outgoing = new Map<string, number>()
    for (const edge of uniqueEdges) {
      degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1)
      degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1)
      outgoing.set(edge.source, (outgoing.get(edge.source) ?? 0) + 1)
      incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1)
    }
    let allowed = new Set(active.map((note) => note.id))
    if (mode === 'local' && centerId) {
      allowed = new Set([centerId])
      let frontier = new Set([centerId])
      for (let level = 0; level < depth; level++) {
        const next = new Set<string>()
        for (const edge of uniqueEdges) {
          if (frontier.has(edge.source) && !allowed.has(edge.target))
            next.add(edge.target)
          if (frontier.has(edge.target) && !allowed.has(edge.source))
            next.add(edge.source)
        }
        for (const id of next) allowed.add(id)
        frontier = next
      }
    }
    const filtered = active
      .filter(
        (note) =>
          allowed.has(note.id) &&
          (!needle || note.title.toLocaleLowerCase().includes(needle)) &&
          (!folderId || note.folderId === folderId) &&
          (!tag ||
            note.tags.some((name) => name.toLocaleLowerCase() === tag)) &&
          (includeOrphans || (degree.get(note.id) ?? 0) > 0),
      )
      .sort(
        (a, b) =>
          (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) ||
          b.updatedAt - a.updatedAt,
      )
    const shown = filtered.slice(0, limit)
    const shownIds = new Set(shown.map((note) => note.id))
    const edges = uniqueEdges.filter(
      (edge) => shownIds.has(edge.source) && shownIds.has(edge.target),
    )
    const folders = new Map(
      listFolders(state).map((folder) => [folder.id, folder]),
    )
    const nodes: GraphResponse['nodes'] = shown.map((note) => ({
      id: note.id,
      title: note.title,
      kind: 'note' as const,
      degree: degree.get(note.id) ?? 0,
      inDegree: incoming.get(note.id) ?? 0,
      outDegree: outgoing.get(note.id) ?? 0,
      folderId: note.folderId,
      folderName: note.folderId
        ? (folders.get(note.folderId)?.name ?? null)
        : null,
      folderColor: note.folderId
        ? (folders.get(note.folderId)?.color ?? null)
        : null,
      tags: note.tags.map((name) => ({
        name,
        color: state.tagColors.get(name) ?? null,
      })),
    }))
    const unresolved = new Map<
      string,
      { title: string; sources: Set<string> }
    >()
    if (includeUnresolved) {
      for (const link of linkRecords) {
        if (link.target !== null || !shownIds.has(link.source)) continue
        if (unresolved.size >= 50 && !unresolved.has(link.key)) continue
        const missing = unresolved.get(link.key) ?? {
          title: link.title,
          sources: new Set<string>(),
        }
        missing.sources.add(link.source)
        unresolved.set(link.key, missing)
      }
      for (const [key, missing] of unresolved) {
        const id = `unresolved:${key}`
        nodes.push({
          id,
          title: missing.title,
          kind: 'unresolved',
          degree: missing.sources.size,
          inDegree: missing.sources.size,
          outDegree: 0,
          folderId: null,
          folderName: null,
          folderColor: null,
          tags: [],
        })
        for (const source of missing.sources) edges.push({ source, target: id })
      }
    }
    return c.json({
      nodes,
      edges,
      meta: {
        mode,
        centerId: mode === 'local' ? centerId : null,
        depth,
        totalNodes: filtered.length + unresolved.size,
        totalEdges: edges.length,
        truncated: filtered.length > limit,
        limit,
      },
    })
  })
  app.get('/api/sync', (c) => {
    const since = Number(c.req.query('since')) || 0
    const changed = since < state.cursor
    const response: SyncResponse = {
      cursor: state.cursor,
      full: changed,
      hasMore: false,
      nextKey: null,
      facetsFull: changed,
      settingsChanged: false,
      profileChanged: false,
      notes: changed ? [...state.notes.values()].map(summarize) : [],
      folders: changed ? listFolders(state) : [],
      tags: changed ? listTags(state) : [],
      deletions: [],
      serverTime: Date.now(),
    }
    return c.json(response)
  })

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
        `The access password must not exceed ${LIMITS.passwordMaxLength}` +
          ' characters',
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

  app.get('/api/backup/targets', (c) =>
    c.json({ targets: [...state.backupTargets.values()] }),
  )
  app.post('/api/backup/targets', async (c) => {
    if (state.backupTargets.size >= LIMITS.backupTargetsMax) {
      return apiError(
        409,
        'conflict',
        `Each account can configure at most ${LIMITS.backupTargetsMax}` +
          ' backup targets',
      )
    }
    const input = (await jsonBody(c.req.raw)) as unknown as BackupTargetInput
    const invalid = demoBackupTargetError(input, true)
    if (invalid) return apiError(400, 'bad_request', invalid)
    const target = createBackupTarget(input)
    state.backupTargets.set(target.id, target)
    return c.json(target, 201)
  })
  app.patch('/api/backup/targets/:id', async (c) => {
    const current = state.backupTargets.get(c.req.param('id'))
    if (!current) return apiError(404, 'not_found', 'Backup target not found')
    const input = (await jsonBody(
      c.req.raw,
    )) as unknown as BackupTargetPatchInput
    if (
      input.expectedUpdatedAt !== undefined &&
      (!Number.isSafeInteger(input.expectedUpdatedAt) ||
        input.expectedUpdatedAt < 0)
    ) {
      return apiError(
        400,
        'bad_request',
        'expectedUpdatedAt must be a non-negative integer',
      )
    }
    if (
      input.expectedUpdatedAt !== undefined &&
      input.expectedUpdatedAt !== current.updatedAt
    ) {
      return apiError(
        409,
        'conflict',
        'The backup target changed elsewhere. Refresh and try again',
      )
    }
    const changedType = input.type !== undefined && input.type !== current.type
    const mergedInput: BackupTargetInput = {
      type: input.type ?? current.type,
      name: input.name ?? current.name,
      enabled: input.enabled ?? current.enabled,
      config: input.config
        ? ({ ...current.config, ...input.config } as BackupTargetConfig)
        : current.config,
      ...(input.secret === undefined ? {} : { secret: input.secret }),
    }
    const invalid = demoBackupTargetError(mergedInput, changedType)
    if (invalid) return apiError(400, 'bad_request', invalid)
    const updated: BackupTarget = {
      ...current,
      type: mergedInput.type,
      name: mergedInput.name.trim(),
      enabled: mergedInput.enabled ?? true,
      config: demoBackupConfig(mergedInput),
      hasSecret:
        current.hasSecret ||
        hasDemoBackupSecret(mergedInput.type, input.secret),
      updatedAt: Math.max(Date.now(), current.updatedAt + 1),
    }
    state.backupTargets.set(updated.id, updated)
    return c.json(updated)
  })
  app.delete('/api/backup/targets/:id', (c) => {
    if (!state.backupTargets.delete(c.req.param('id'))) {
      return apiError(404, 'not_found', 'Backup target not found')
    }
    return c.json({ ok: true as const })
  })
  app.post('/api/backup/test', async (c) => {
    const input = (await jsonBody(c.req.raw)) as unknown as BackupTargetInput
    const invalid = demoBackupTargetError(input, true)
    return invalid
      ? apiError(400, 'bad_request', invalid)
      : c.json({
          ok: true,
          message:
            'Demo only: configuration validated locally; no remote connection' +
              ' was made',
          latencyMs: 0,
        })
  })
  app.post('/api/backup/targets/:id/test', async (c) => {
    const current = state.backupTargets.get(c.req.param('id'))
    if (!current) return apiError(404, 'not_found', 'Backup target not found')
    const input = (await jsonBody(
      c.req.raw,
    )) as unknown as BackupTargetPatchInput
    const changedType = input.type !== undefined && input.type !== current.type
    const mergedInput: BackupTargetInput = {
      type: input.type ?? current.type,
      name: input.name ?? current.name,
      enabled: input.enabled ?? current.enabled,
      config: input.config
        ? ({ ...current.config, ...input.config } as BackupTargetConfig)
        : current.config,
      ...(input.secret === undefined ? {} : { secret: input.secret }),
    }
    const invalid = demoBackupTargetError(
      mergedInput,
      changedType || !current.hasSecret,
    )
    return invalid
      ? apiError(400, 'bad_request', invalid)
      : c.json({
          ok: true,
          message:
            'Demo only: configuration validated locally; no remote connection' +
              ' was made',
          latencyMs: 0,
        })
  })
  app.post('/api/backup/run', async (c) => {
    const body = await jsonBody(c.req.raw)
    if (
      body.targetIds !== undefined &&
      (!Array.isArray(body.targetIds) ||
        body.targetIds.some(
          (id) =>
            typeof id !== 'string' || !/^[0-9a-hjkmnp-tv-z]{26}$/.test(id),
        ))
    ) {
      return apiError(
        400,
        'bad_request',
        'targetIds must be an array of valid backup target IDs',
      )
    }
    const selected = Array.isArray(body.targetIds)
      ? (body.targetIds as string[])
      : [...state.backupTargets.keys()]
    const targets = [...new Set(selected)]
      .map((id) => state.backupTargets.get(id))
      .filter((item): item is BackupTarget => Boolean(item?.enabled))
    const startedAt = Date.now()
    const results = targets.map((target) => ({
      targetId: target.id,
      targetName: target.name,
      targetType: target.type,
      ok: true,
      files: state.notes.size + state.attachments.size,
      bytes:
        [...state.notes.values()].reduce(
          (total, note) => total + utf8ByteLength(note.content),
          0,
        ) +
        [...state.attachments.values()].reduce(
          (total, item) => total + item.meta.size,
          0,
        ),
      ms: 0,
      error: null,
    }))
    const run: BackupRun = {
      id: newDemoId(),
      trigger: 'manual' as const,
      status: targets.length ? 'success' : 'failed',
      startedAt,
      finishedAt: Date.now(),
      noteCount: targets.length ? state.notes.size : 0,
      fileCount: results.reduce((total, result) => total + result.files, 0),
      bytes: results.reduce((total, result) => total + result.bytes, 0),
      results,
    }
    for (const target of targets)
      state.backupTargets.set(target.id, {
        ...target,
        lastRunAt: startedAt,
        lastStatus: 'success',
        lastError: null,
      })
    state.backupRuns.unshift(run)
    state.backupRuns.splice(LIMITS.backupRunsKept)
    return c.json(run)
  })
  app.get('/api/backup/runs', (c) => c.json({ runs: state.backupRuns }))

  app.get('/api/export', (c) =>
    exportResponse(state, c.req.query('format') === 'json' ? 'json' : 'zip'),
  )
  app.post('/api/import', async (c) => {
    const form = await c.req.raw.formData()
    const files = form
      .getAll('file')
      .filter((value): value is File => value instanceof File)
    const conflictValue = form.get('conflict') ?? 'duplicate'
    if (
      conflictValue !== 'skip' &&
      conflictValue !== 'newer' &&
      conflictValue !== 'duplicate'
    )
      return apiError(400, 'bad_request', 'Invalid import conflict strategy')
    const pathsValue: unknown = JSON.parse(
      String(
        form.get('backupPaths') ??
          JSON.stringify(files.map((file) => file.name)),
      ),
    )
    if (
      !Array.isArray(pathsValue) ||
      pathsValue.length !== files.length ||
      pathsValue.some(
        (path) =>
          typeof path !== 'string' ||
          path.includes('\\') ||
          path.split('/').includes('..'),
      )
    )
      return apiError(400, 'bad_request', 'Invalid backup paths')
    const paths = pathsValue as string[]
    if (files.length > LIMITS.importFilesMax) {
      return apiError(
        413,
        'payload_too_large',
        `The import cannot contain more than ${LIMITS.importFilesMax} files`,
      )
    }
    if (
      files.reduce((total, file) => total + file.size, 0) >
      LIMITS.importUploadMaxBytes
    ) {
      return apiError(
        413,
        'payload_too_large',
        'The import upload cannot exceed 64 MB',
      )
    }
    const result: ImportResult = {
      createdNotes: 0,
      updatedNotes: 0,
      skippedNotes: 0,
      createdFolders: 0,
      createdAttachments: 0,
      skippedAttachments: 0,
      warnings: [],
    }
    const manifest = form.get('backupManifest')
    if (typeof manifest === 'string') {
      try {
        await importBackupBatch(
          state,
          manifest,
          files,
          paths,
          conflictValue,
          result,
        )
      } catch (error) {
        result.warnings.push(
          error instanceof Error ? error.message : 'Backup import failed',
        )
      }
      state.cursor++
      return c.json(result)
    }
    for (const [index, value] of files.entries()) {
      try {
        if (value.name.toLowerCase().endsWith('.zip')) {
          const entries = await readZip(
            new Uint8Array(await value.arrayBuffer()),
            {
              maxEntries: LIMITS.importArchiveEntriesMax,
              maxEntryBytes: LIMITS.importArchiveExpandedMaxBytes,
              maxTotalBytes: LIMITS.importArchiveExpandedMaxBytes,
            },
          )
          const bundleEntry = entries.find((entry) =>
            entry.path.endsWith('autonote-export.json'),
          )
          if (!bundleEntry) {
            const backupEntry = entries.find((entry) =>
              /(?:^|\/)manifest\.json$/i.test(entry.path),
            )
            if (backupEntry) {
              await importBackupBatch(
                state,
                new TextDecoder().decode(backupEntry.data),
                entries.map(
                  (entry) =>
                    new File(
                      [entry.data.slice().buffer as ArrayBuffer],
                      entry.path,
                    ),
                ),
                entries.map((entry) => entry.path),
                conflictValue,
                result,
              )
            } else {
              for (const entry of entries)
                if (/\.(md|markdown|txt)$/i.test(entry.path))
                  importMarkdown(
                    state,
                    new TextDecoder().decode(entry.data),
                    entry.path,
                    conflictValue,
                    result,
                  )
            }
            continue
          }
          await importBundle(
            state,
            JSON.parse(new TextDecoder().decode(bundleEntry.data)),
            result,
            conflictValue,
            new Map(
              entries.map((entry) => [
                entry.path.toLocaleLowerCase(),
                entry.data,
              ]),
            ),
          )
        } else if (value.name.toLowerCase().endsWith('.json')) {
          if (value.size > LIMITS.importBundleMaxBytes) {
            throw new Error('The export file cannot exceed 32 MB')
          }
          await importBundle(
            state,
            JSON.parse(await value.text()),
            result,
            conflictValue,
          )
        } else {
          if (value.size > LIMITS.contentMaxBytes) {
            throw new Error('A note file cannot exceed 2 MB')
          }
          const content = await value.text()
          if (!/\.(md|markdown|txt)$/i.test(value.name))
            throw new Error('Select Markdown, JSON or ZIP files')
          importMarkdown(
            state,
            content,
            paths[index] ?? value.name,
            conflictValue,
            result,
          )
        }
      } catch (error) {
        result.warnings.push(
          `${value.name}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
      }
    }
    state.cursor++
    return c.json(result)
  })

  app.all('/api/*', () => apiError(404, 'not_found', 'Demo endpoint not found'))

  return {
    userId: state.user.id,
    async fetch(request) {
      if (disposed)
        return apiError(503, 'storage_unavailable', 'Demo runtime is disposed')
      if (request.signal.aborted) throw request.signal.reason
      try {
        return await app.fetch(request)
      } finally {
        if (disposed) revokeFiles()
      }
    },
    resolveFileUrl(url) {
      if (disposed) return 'data:,'
      if (url.startsWith('blob:'))
        return [...state.attachments.values()].some(
          (item) => item.meta.url === url,
        )
          ? url
          : 'data:,'
      if (url.startsWith('data:')) return url
      if (/^(?:https?:)?\/\//i.test(url) && !/\/api\/files\//.test(url))
        return 'data:,'
      let path: string
      try {
        path = new URL(url, 'https://demo.invalid').pathname
      } catch {
        return 'data:,'
      }
      const id = /^\/api\/files\/([0-9a-hjkmnp-tv-z]{26})$/.exec(path)?.[1]
      if (id) {
        const attachment = state.attachments.get(id)
        if (!attachment) return 'data:,'
        const slug = new URL(url, 'https://demo.invalid').searchParams.get(
          'share',
        )
        if (slug !== null || !state.authenticated) {
          const share = [...state.shares.values()].find(
            (item) => item.info.slug === slug,
          )
          const note = share ? state.notes.get(share.info.noteId) : undefined
          if (
            !share ||
            !note ||
            note.deletedAt !== null ||
            (share.info.expiresAt !== null &&
              share.info.expiresAt <= Date.now()) ||
            (!extractAttachmentIds(note.content).includes(id) &&
              !note.content.includes(attachment.meta.url))
          )
            return 'data:,'
          if (share.password && !unlockedShares.has(share.info.slug))
            return 'data:,'
        }
        return attachment.meta.url
      }
      return path.startsWith('/api/') ? 'data:,' : url
    },
    dispose() {
      if (disposed) return
      disposed = true
      revokeFiles()
    },
  }
}

function demoMcpSettings(now = Date.now()): McpSettingsInfo {
  return {
    enabled: true,
    canManageGlobal: true,
    endpoint: '/mcp',
    oauth: true,
    preferences: {
      writeEnabled: true,
      trashEnabled: false,
      updatedAt: now - 24 * 60 * 60 * 1000,
    },
    apiKeys: [
      {
        id: 'demo-api-key',
        name: 'Automation key',
        scopes: ['notes:read', 'notes:write'],
        createdAt: now - 14 * 24 * 60 * 60 * 1000,
        lastUsedAt: now - 18 * 60 * 1000,
      },
    ],
    aiSearch: {
      available: false,
      enabled: false,
      model: '@cf/baai/bge-m3',
      indexedCount: 0,
      pendingCount: 0,
      reason: 'no_ai_binding',
    },
    grants: [
      {
        id: 'demo-grant',
        clientId: 'demo-desktop-client',
        clientName: 'Desktop MCP client',
        clientUri: 'https://example.com',
        scopes: ['notes:read', 'notes:write'],
        createdAt: now - 7 * 24 * 60 * 60 * 1000,
        expiresAt: null,
      },
    ],
    privacy: {
      publicEndpoint: false,
      perUserIndex: true,
      externalClientReceivesSelectedContent: true,
    },
  }
}

function siteInfo(state: DemoState) {
  return {
    name: 'AutoNote Demo',
    initialized: true,
    registrationOpen: state.registrationOpen,
    r2Enabled: true,
    kvEnabled: false,
    attachmentStorage: 'r2',
    realtimeEnabled: false,
    version: APP_VERSION,
  } as const
}

function sessionInfo(state: DemoState): SessionInfo {
  return {
    user: state.authenticated ? state.user : null,
    site: siteInfo(state),
    settings: state.authenticated ? state.settings : null,
  }
}

async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get('content-type')?.includes('application/json'))
    return {}
  const value: unknown = await request.json()
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new SyntaxError('Invalid JSON object')
  return value as Record<string, unknown>
}
