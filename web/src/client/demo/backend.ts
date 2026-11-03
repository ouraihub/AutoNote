import { Hono } from 'hono'
import { apiError, revokeAttachment } from './responses'
import { createDemoState } from './state'
import { demoMcpSettings } from './helpers'
import { registerCoreRoutes } from './demo-core'
import { registerNoteRoutes } from './demo-notes'
import { registerOrganizerRoutes } from './demo-organizer'
import { registerGraphRoutes } from './demo-graph'
import { registerFileShareRoutes } from './demo-files-share'
import { registerBackupImportRoutes } from './demo-backup'
import { extractAttachmentIds } from '@shared/markdown-utils'

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
    )
      return next()
    if (!state.authenticated)
      return apiError(401, 'unauthenticated', 'Please sign in first')
    return next()
  })
  registerCoreRoutes(app, state, mcp)
  registerNoteRoutes(app, state)
  registerOrganizerRoutes(app, state)
  registerGraphRoutes(app, state)
  registerFileShareRoutes(app, state, unlockedShares)
  registerBackupImportRoutes(app, state)
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
        const parsed = new URL(url, 'https://demo.invalid')
        const slug = parsed.searchParams.get('share')
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
