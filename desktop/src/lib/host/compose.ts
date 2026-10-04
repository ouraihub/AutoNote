import { convertFileSrc, Channel } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { Attachment, Backlink, CreateNoteBody, Folder, GraphQuery, GraphResponse, ImportResult, ListNotesResponse, Note, NoteVersion, NoteVersionMeta, PatchNoteBody, SearchResponse, SyncResponse, Tag, UserSettings } from '@shared/types'
import type { AttachmentPage, BackendSession, FlushResult, FolderCreate, FolderPatch, NoteWriteResult, ProgressEvent, SettingsPatch, TagCreate, TagPatch, TagPatchResult } from '@shared/backend-types'
import { ChangeFeedEmitter, BackendError, type Backend, type CallOptions, type NoteWriteOptions, type TransferOptions } from '@app/backend'
import { mountApp, type AppHandle, type AppDeps } from '@app/root'
import type { Logger } from '@app/log/logger'
import type { Notifier } from '@app/platform/notifier'
import type { PrefValue, PrefsStore } from '@app/platform/prefs'
import { call } from '../ipc/transport'

const LIBRARY_CHANGED = 'autonote://library-changed'

function command<T>(name: string, args?: Record<string, unknown>, options?: CallOptions): Promise<T> {
  void options
  return call<T>(name, args)
}

function unsupported(message: string): never {
  throw new BackendError('not_found', 404, message)
}

const session: Backend['session'] = {
  async load(options) { return command<BackendSession>('session_load', undefined, options) },
  async logout(options) { return command<void>('session_logout', undefined, options) },
}

const notes: Backend['notes'] = {
  snapshot: (options) => command('notes_snapshot', undefined, options),
  list: (query, options) => command<ListNotesResponse>('notes_list', { query }, options),
  get: (id, options) => command<Note>('notes_get', { id }, options),
  create: (body: CreateNoteBody, options) => command<Note>('notes_create', { body }, options),
  patch: (id: string, body: PatchNoteBody, options: NoteWriteOptions) => command<NoteWriteResult>('notes_patch', { id, body, writeId: options.writeId }, options),
  remove: (id, options) => command<Note>('notes_remove', { id }, options),
  restore: (id, options) => command<Note>('notes_restore', { id }, options),
  purge: (id, options) => command<{ ok: true; cursor: number }>('notes_purge', { id }, options),
  duplicate: (id, body, options) => command<Note>('notes_duplicate', { id, ...(body === undefined ? {} : { body }) }, options),
  emptyTrash: (options) => command<{ purged: number }>('notes_empty_trash', undefined, options),
  versions: (id, options) => command<NoteVersionMeta[]>('notes_versions', { id }, options),
  version: (id, versionId, options) => command<NoteVersion>('notes_version', { id, versionId }, options),
  async restoreVersion(id, versionId, options) {
    const note = await this.get(id, options)
    return command<Note>('notes_restore_version', { id, versionId, rev: note.rev }, options)
  },
  backlinks: (id, options) => command<Backlink[]>('notes_backlinks', { id }, options),
  flush: (noteId, options) => command<FlushResult>('notes_flush', noteId === undefined ? undefined : { noteId }, options),
}

const folders: Backend['folders'] = {
  list: (options) => command<Folder[]>('folders_list', undefined, options),
  create: (body: FolderCreate, options) => command<Folder>('folders_create', { body }, options),
  patch: (id: string, body: FolderPatch, options) => command<Folder>('folders_patch', { id, body }, options),
  remove: (id, strategy, options) => command<{ ok: true }>('folders_remove', { id, strategy }, options),
}

const tags: Backend['tags'] = {
  list: (options) => command<Tag[]>('tags_list', undefined, options),
  create: (body: TagCreate, options) => command<Tag>('tags_create', { body }, options),
  patch: (id: string, body: TagPatch, options) => command<TagPatchResult>('tags_patch', { id, body }, options),
  remove: (id, options) => command<{ ok: true; affected: number }>('tags_remove', { id }, options),
}

const search: Backend['search'] = {
  query: (query, limit, options) => command<SearchResponse>('search_query', { query: { q: query, ...(limit === undefined ? {} : { limit }) } }, options),
  graph: (query: GraphQuery, options) => command<GraphResponse>('search_graph', { query }, options),
  async reindex(options) {
    const jobId = crypto.randomUUID()
    const onProgress = new Channel<ProgressEvent>()
    return command<{ ok: true; indexed: number }>('search_reindex', { jobId, onProgress }, options)
  },
}

const files: Backend['files'] = {
  list: (cursor, options) => command<AttachmentPage>('files_list', cursor === undefined ? undefined : { cursor }, options),
  async upload(file, noteId, options) {
    const started = await command<{ uploadId: string; chunkMaxBytes: number }>('files_upload_begin', {
      filename: file.name,
      mime: file.type || 'application/octet-stream',
      size: file.size,
      ...(noteId === undefined ? {} : { noteId }),
    }, options)
    const bytes = new Uint8Array(await file.arrayBuffer())
    for (let offset = 0; offset < bytes.length; offset += started.chunkMaxBytes) {
      const chunk = bytes.slice(offset, Math.min(bytes.length, offset + started.chunkMaxBytes))
      await call<{ received: number }>('files_upload_chunk', chunk, { headers: {
        'x-autonote-upload-id': started.uploadId,
        'x-autonote-offset': String(offset),
      } })
    }
    return command<Attachment>('files_upload_finish', { uploadId: started.uploadId }, options)
  },
  remove: (id, options) => command<{ ok: true }>('files_remove', { id }, options),
  prune: (options) => command<{ removed: number; freedBytes: number }>('files_prune', undefined, options),
  resolveUrl(url) {
    if (url.startsWith('autonote-file:')) return url
    const id = url.slice(url.lastIndexOf('/') + 1)
    return convertFileSrc(id, 'autonote-file')
  }
}

const settings: Backend['settings'] = {
  get: (options) => command<UserSettings>('settings_get', undefined, options),
  save: (patch: SettingsPatch, options) => command<UserSettings>('settings_save', { patch }, options),
  stats: (options) => command<Record<string, number>>('settings_stats', undefined, options),
}

const transfer: Backend['transfer'] = {
  sources: [],
  exportTo: async (_format: 'zip' | 'json', _options?: TransferOptions) => unsupported('Desktop export is unavailable'),
  importFrom: async (_source: 'files' | 'folder', _conflict: 'skip' | 'newer' | 'duplicate', _options?: TransferOptions): Promise<ImportResult | null> => unsupported('Desktop import is unavailable'),
}

class DesktopPrefs implements PrefsStore {
  async load(key: string): Promise<unknown> {
    try { const value = localStorage.getItem(`autonote.ui:${key}`); return value === null ? undefined : JSON.parse(value) } catch { throw new BackendError('internal', 0, 'Preference read failed') }
  }
  async save(key: string, value: PrefValue): Promise<void> {
    try { localStorage.setItem(`autonote.ui:${key}`, JSON.stringify(value)) } catch { throw new BackendError('internal', 0, 'Preference write failed') }
  }
  async remove(key: string): Promise<void> {
    try { localStorage.removeItem(`autonote.ui:${key}`) } catch { throw new BackendError('internal', 0, 'Preference remove failed') }
  }
}

const logger: Logger = {
  debug: (event, fields) => console.debug(event, fields),
  info: (event, fields) => console.info(event, fields),
  warn: (event, fields) => console.warn(event, fields),
  error: (event, fields) => console.error(event, fields),
}

const notifier: Notifier = {
  toast: (request) => console.info(request.tone, request.key, request.params),
  confirm: async (request) => typeof window.confirm === 'function' && window.confirm(`${request.titleKey}\n${request.bodyKey}`),
}

export async function bootDesktop(target: HTMLElement): Promise<AppHandle> {
  const changes = new ChangeFeedEmitter()
  const unlisten = await listen<SyncResponse>(LIBRARY_CHANGED, (event) => {
    changes.emit({ kind: 'library', payload: event.payload })
    if (event.payload.settingsChanged) changes.emit({ kind: 'settings' })
  })
  const backend: Backend = {
    kind: 'desktop',
    capabilities: { accounts: false, totp: false, share: false, remoteBackup: false, semanticSearch: true, mcp: null, realtime: true, remoteSync: false, updateCheck: false },
    session,
    notes,
    folders,
    tags,
    search,
    files,
    settings,
    transfer,
    changes,
    async dispose() { unlisten(); changes.dispose() },
  }
  const deps: AppDeps = {
    backend,
    clock: { now: () => Date.now() },
    logger,
    prefs: new DesktopPrefs(),
    notifier,
    extensions: { settingsSections: [], aboutPanels: [] },
  }
  const handle = mountApp(target, deps)
  return {
    flush: () => handle.flush(),
    async destroy() { await handle.destroy() },
  }
}
