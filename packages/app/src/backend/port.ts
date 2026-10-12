import type {
  Attachment,
  Backlink,
  BackupRun,
  BackupTarget,
  BackupTargetInput,
  BackupTargetPatchInput,
  CreateNoteBody,
  Folder,
  GraphQuery,
  GraphResponse,
  ImportResult,
  ListNotesQuery,
  ListNotesResponse,
  McpAiSearchStatus,
  McpApiKey,
  McpPreferences,
  McpSettingsInfo,
  Note,
  NoteVersion,
  NoteVersionMeta,
  PasswordLoginResult,
  PatchNoteBody,
  PublicUser,
  SearchResponse,
  ShareInfo,
  ShareListItem,
  SyncResponse,
  Tag,
  TestConnectionResult,
  TotpLoginResult,
  TotpRecoveryCodesResult,
  TotpSetupInfo,
  TotpStatus,
  UpdateCheckResponse,
  UserSettings,
} from '@shared/types'
import type {
  AttachmentPage,
  BackendSession,
  FlushResult,
  FolderCreate,
  FolderPatch,
  McpLocalStatus,
  NoteWriteResult,
  ProgressEvent,
  SettingsPatch,
  TagCreate,
  TagPatch,
  TagPatchResult,
} from '@shared/backend-types'
import type { AiPort } from '@shared/ai-types'
import type { KitPorts, ModelRef } from '@ouraihub/aether-ui/ports'
import type { ChangeFeed, Unsubscribe } from './change-feed'

export interface CallOptions {
  signal?: AbortSignal
}

export interface NoteWriteOptions extends CallOptions {
  writeId: string
}

export interface TransferOptions extends CallOptions {
  onProgress?: (event: ProgressEvent) => void
}

export interface BackendCapabilities {
  accounts: boolean
  ai: boolean
  totp: boolean
  share: boolean
  remoteBackup: boolean
  semanticSearch: boolean
  mcp: 'remote' | 'local' | null
  realtime: boolean
  remoteSync: boolean
  updateCheck: boolean
}

export interface TotpPort {
  status(options?: CallOptions): Promise<TotpStatus>
  startSetup(currentPassword: string, options?: CallOptions): Promise<TotpSetupInfo>
  confirmSetup(
    setupToken: string,
    code: string,
    options?: CallOptions,
  ): Promise<TotpRecoveryCodesResult & { enabledAt: number }>
  cancelSetup(setupToken: string, options?: CallOptions): Promise<{ ok: true }>
  regenerateRecoveryCodes(
    currentPassword: string,
    code: string,
    options?: CallOptions,
  ): Promise<TotpRecoveryCodesResult>
  disable(currentPassword: string, code: string, options?: CallOptions): Promise<{ ok: true }>
}

export interface SessionAccountPort {
  readonly totp: TotpPort
  register(
    username: string,
    password: string,
    locale: 'zh-CN' | 'en-US',
    options?: CallOptions,
  ): Promise<BackendSession>
  login(username: string, password: string, options?: CallOptions): Promise<PasswordLoginResult>
  completeTotpLogin(challengeToken: string, code: string, options?: CallOptions): Promise<TotpLoginResult>
  setPassword(body: { currentPassword: string; newPassword: string }, options?: CallOptions): Promise<{ ok: true }>
  updateProfile(body: { name?: string; avatarUrl?: string }, options?: CallOptions): Promise<PublicUser>
  updateRegistration(
    enabled: boolean,
    password: string,
    options?: CallOptions,
  ): Promise<{ ok: true; registrationOpen: boolean }>
}

export interface SessionPort {
  readonly account?: SessionAccountPort
  load(options?: CallOptions): Promise<BackendSession>
  logout(options?: CallOptions): Promise<void>
}

export interface NotesPort {
  snapshot(options?: CallOptions): Promise<SyncResponse>
  list(query: ListNotesQuery, options?: CallOptions): Promise<ListNotesResponse>
  get(id: string, options?: CallOptions): Promise<Note>
  create(body: CreateNoteBody, options?: CallOptions): Promise<Note>
  patch(id: string, body: PatchNoteBody, options: NoteWriteOptions): Promise<NoteWriteResult>
  remove(id: string, options?: CallOptions): Promise<Note>
  restore(id: string, options?: CallOptions): Promise<Note>
  purge(id: string, options?: CallOptions): Promise<{ ok: true; cursor: number }>
  duplicate(id: string, body?: { id?: string }, options?: CallOptions): Promise<Note>
  emptyTrash(options?: CallOptions): Promise<{ purged: number }>
  versions(id: string, options?: CallOptions): Promise<NoteVersionMeta[]>
  version(id: string, versionId: string, options?: CallOptions): Promise<NoteVersion>
  restoreVersion(id: string, versionId: string, options?: CallOptions): Promise<Note>
  backlinks(id: string, options?: CallOptions): Promise<Backlink[]>
  flush(noteId?: string, options?: CallOptions): Promise<FlushResult>
  syncNow?(options?: CallOptions): Promise<void>
}

export interface FoldersPort {
  list(options?: CallOptions): Promise<Folder[]>
  create(body: FolderCreate, options?: CallOptions): Promise<Folder>
  patch(id: string, body: FolderPatch, options?: CallOptions): Promise<Folder>
  remove(id: string, strategy: 'move-up' | 'delete', options?: CallOptions): Promise<{ ok: true }>
}

export interface TagsPort {
  list(options?: CallOptions): Promise<Tag[]>
  create(body: TagCreate, options?: CallOptions): Promise<Tag>
  patch(id: string, body: TagPatch, options?: CallOptions): Promise<TagPatchResult>
  remove(id: string, options?: CallOptions): Promise<{ ok: true; affected: number }>
}

export interface SearchPort {
  query(query: string, limit?: number, options?: CallOptions): Promise<SearchResponse>
  graph(query: GraphQuery, options?: CallOptions): Promise<GraphResponse>
  reindex(options?: CallOptions): Promise<{ ok: true; indexed: number }>
}

export interface FilesPort {
  list(cursor?: string, options?: CallOptions): Promise<AttachmentPage>
  upload(file: File, noteId?: string, options?: CallOptions): Promise<Attachment>
  remove(id: string, options?: CallOptions): Promise<{ ok: true }>
  prune(options?: CallOptions): Promise<{ removed: number; freedBytes: number }>
  resolveUrl(url: string): string
}

export interface SettingsPort {
  get(options?: CallOptions): Promise<UserSettings>
  save(patch: SettingsPatch, options?: CallOptions): Promise<UserSettings>
  stats(options?: CallOptions): Promise<Record<string, number>>
}

export interface TransferPort {
  readonly sources: readonly ('files' | 'folder')[]
  exportTo(format: 'zip' | 'json', options?: TransferOptions): Promise<{ saved: true } | null>
  importFrom(
    source: 'files' | 'folder',
    conflict: 'skip' | 'newer' | 'duplicate',
    options?: TransferOptions,
  ): Promise<ImportResult | null>
}

export interface SharePort {
  list(options?: CallOptions): Promise<ShareListItem[]>
  get(noteId: string, options?: CallOptions): Promise<ShareInfo | null>
  create(noteId: string, body: { password?: string; expiresIn?: number }, options?: CallOptions): Promise<ShareInfo>
  remove(noteId: string, options?: CallOptions): Promise<{ ok: true }>
}

export interface BackupPort {
  targets(options?: CallOptions): Promise<BackupTarget[]>
  create(body: BackupTargetInput, options?: CallOptions): Promise<BackupTarget>
  patch(id: string, body: BackupTargetPatchInput, options?: CallOptions): Promise<BackupTarget>
  remove(id: string, options?: CallOptions): Promise<{ ok: true }>
  test(id: string, body: Partial<BackupTargetInput>, options?: CallOptions): Promise<TestConnectionResult>
  testDraft(body: BackupTargetInput, options?: CallOptions): Promise<TestConnectionResult>
  run(targetIds?: readonly string[], options?: CallOptions): Promise<BackupRun>
  runs(options?: CallOptions): Promise<BackupRun[]>
}

export interface McpBasePort {
  listKeys(options?: CallOptions): Promise<McpApiKey[]>
  createKey(name: string, options?: CallOptions): Promise<{ key: McpApiKey; token: string }>
  revokeKey(id: string, options?: CallOptions): Promise<{ ok: true }>
  getPreferences(options?: CallOptions): Promise<McpPreferences>
  savePreferences(
    patch: Partial<Pick<McpPreferences, 'writeEnabled' | 'trashEnabled'>>,
    options?: CallOptions,
  ): Promise<McpPreferences>
}

export interface RemoteMcpPort extends McpBasePort {
  get(options?: CallOptions): Promise<McpSettingsInfo>
  setEnabled(
    enabled: boolean,
    options?: CallOptions,
  ): Promise<{ enabled: boolean; preferences: McpPreferences; reconnectRequired: boolean }>
  revokeGrant(id: string, options?: CallOptions): Promise<{ ok: true }>
  revokeAllGrants(options?: CallOptions): Promise<{ ok: true; revoked: number }>
  saveAiSearch(enabled: boolean, options?: CallOptions): Promise<McpAiSearchStatus>
  reindexAiSearch(options?: CallOptions): Promise<McpAiSearchStatus & { ok: true; enqueued: number }>
  clearAiSearch(options?: CallOptions): Promise<{ ok: true; removed: number }>
}

export interface LocalMcpPort extends McpBasePort {
  status(options?: CallOptions): Promise<McpLocalStatus>
  start(options?: CallOptions): Promise<McpLocalStatus>
  stop(options?: CallOptions): Promise<McpLocalStatus>
  setPort(port: number, options?: CallOptions): Promise<McpLocalStatus>
  subscribe(listener: (status: McpLocalStatus) => void): Unsubscribe
}

export interface UpdatePort {
  check(options?: CallOptions): Promise<UpdateCheckResponse>
}

export type AiRole = 'chat' | 'writing'

export interface AiRoleBinding {
  role: AiRole
  binding: (ModelRef & { label: string }) | null
  isFallback: boolean
}

export interface AiHostPort {
  readonly kit: KitPorts
  roles(options?: CallOptions): Promise<AiRoleBinding[]>
  setRole(role: AiRole, binding: ModelRef | null, options?: CallOptions): Promise<AiRoleBinding[]>
  revealKey(endpointId: string, options?: CallOptions): Promise<string>
}

export interface Backend {
  readonly kind: 'web' | 'desktop'
  readonly capabilities: BackendCapabilities
  readonly session: SessionPort
  readonly notes: NotesPort
  readonly folders: FoldersPort
  readonly tags: TagsPort
  readonly search: SearchPort
  readonly files: FilesPort
  readonly settings: SettingsPort
  readonly transfer: TransferPort
  readonly changes: ChangeFeed
  readonly ai?: AiPort
  readonly aiHost?: AiHostPort
  readonly share?: SharePort
  readonly backup?: BackupPort
  readonly mcp?: RemoteMcpPort | LocalMcpPort
  readonly update?: UpdatePort
  dispose(): Promise<void>
}
