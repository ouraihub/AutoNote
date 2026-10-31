import type { CreateNoteBody, GraphQuery, PatchNoteBody } from '@shared/types'
import type {
  FolderCreate,
  FolderPatch,
  SettingsPatch,
  TagCreate,
  TagPatch,
} from '@shared/backend-types'
import type { Backend, NoteWriteOptions } from '@app/backend'
import type { IpcTransport } from './transport'
import { IpcChangeFeed } from './change-feed'
import { filesPort } from './ports/files'
import { transferPort } from './ports/transfer'
import { IpcMcpPort } from './ports/mcp'
import { aiHostPort } from './ports/ai-host'

export function createIpcBackend(
  transport: IpcTransport,
): Backend & { changes: IpcChangeFeed; mcp: IpcMcpPort } {
  const changes = new IpcChangeFeed(transport)
  const mcp = new IpcMcpPort(transport)
  const session: Backend['session'] = {
    async load(options) {
      return transport.invoke('session_load', undefined, options)
    },
    async updateProfile(body, options) {
      return transport.invoke('session_update_profile', { body }, options)
    },
    async logout(options) {
      return transport.invoke('session_logout', undefined, options)
    },
  }

  const notes: Backend['notes'] = {
    snapshot: (options) => changes.snapshot(options),
    list: (query, options) =>
      transport.invoke('notes_list', { query }, options),
    get: (id, options) => transport.invoke('notes_get', { id }, options),
    create: (body: CreateNoteBody, options) =>
      transport.invoke('notes_create', { body }, options),
    patch: (id: string, body: PatchNoteBody, options: NoteWriteOptions) =>
      transport.invoke(
        'notes_patch',
        { id, body, writeId: options.writeId },
        options,
      ),
    remove: (id, options) => transport.invoke('notes_remove', { id }, options),
    restore: (id, options) =>
      transport.invoke('notes_restore', { id }, options),
    purge: (id, options) => transport.invoke('notes_purge', { id }, options),
    duplicate: (id, body, options) =>
      transport.invoke(
        'notes_duplicate',
        { id, ...(body === undefined ? {} : { body }) },
        options,
      ),
    emptyTrash: (options) =>
      transport.invoke('notes_empty_trash', undefined, options),
    versions: (id, options) =>
      transport.invoke('notes_versions', { id }, options),
    version: (id, versionId, options) =>
      transport.invoke('notes_version', { id, versionId }, options),
    async restoreVersion(id, versionId, options) {
      const note = await this.get(id, options)
      return transport.invoke(
        'notes_restore_version',
        { id, versionId, rev: note.rev },
        options,
      )
    },
    backlinks: (id, options) =>
      transport.invoke('notes_backlinks', { id }, options),
    flush: (noteId, options) => transport.flushNotes(noteId, options),
  }

  const folders: Backend['folders'] = {
    list: (options) => transport.invoke('folders_list', undefined, options),
    create: (body: FolderCreate, options) =>
      transport.invoke('folders_create', { body }, options),
    patch: (id: string, body: FolderPatch, options) =>
      transport.invoke('folders_patch', { id, body }, options),
    remove: (id, strategy, options) =>
      transport.invoke('folders_remove', { id, strategy }, options),
  }

  const tags: Backend['tags'] = {
    list: (options) => transport.invoke('tags_list', undefined, options),
    create: (body: TagCreate, options) =>
      transport.invoke('tags_create', { body }, options),
    patch: (id: string, body: TagPatch, options) =>
      transport.invoke('tags_patch', { id, body }, options),
    remove: (id, options) => transport.invoke('tags_remove', { id }, options),
  }

  const search: Backend['search'] = {
    query: (query, limit, options) =>
      transport.invoke(
        'search_query',
        { query: { q: query, ...(limit === undefined ? {} : { limit }) } },
        options,
      ),
    graph: (query: GraphQuery, options) =>
      transport.invoke('search_graph', { query }, options),
    reindex: (options) => transport.reindex(options),
  }

  const files = filesPort(transport)

  const settings: Backend['settings'] = {
    get: (options) => transport.invoke('settings_get', undefined, options),
    save: (patch: SettingsPatch, options) =>
      transport.invoke('settings_save', { patch }, options),
    stats: (options) => transport.invoke('settings_stats', undefined, options),
  }

  return {
    kind: 'desktop',
    capabilities: {
      accounts: false,
      totp: false,
      share: false,
      remoteBackup: false,
      semanticSearch: false,
      mcp: 'local',
      realtime: true,
      remoteSync: true,
      updateCheck: false,
    },
    session,
    notes,
    folders,
    tags,
    search,
    files,
    settings,
    transfer: transferPort(transport),
    changes,
    mcp,
    aiHost: aiHostPort(transport),
    async dispose() {
      changes.dispose()
      mcp.dispose()
      await transport.dispose()
    },
  }
}
