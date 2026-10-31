export type UserRole = 'owner' | 'member'

export interface PublicUser {
  id: string
  login: string
  name: string
  avatarUrl: string
  role: UserRole
  createdAt: number

  username: string
}

export interface SiteInfo {
  name: string

  initialized: boolean

  registrationOpen: boolean

  r2Enabled: boolean

  kvEnabled: boolean

  attachmentStorage: 'r2' | 'kv' | null

  realtimeEnabled: boolean
  version: string
}

export interface SessionInfo {
  user: PublicUser | null
  site: SiteInfo
  settings: UserSettings | null
}

export interface TotpLoginChallenge {
  twoFactorRequired: true
  challengeToken: string
  expiresAt: number
}

export type PasswordLoginResult = SessionInfo | TotpLoginChallenge

export type TotpLoginResult = SessionInfo & {
  recoveryCodeUsed: boolean
  recoveryCodesRemaining: number | null
}

export interface TotpStatus {
  available: boolean
  enabled: boolean
  enabledAt: number | null
  recoveryCodesRemaining: number
}

export interface TotpSetupInfo {
  setupToken: string
  secret: string
  uri: string
  expiresAt: number
}

export interface TotpRecoveryCodesResult {
  recoveryCodes: string[]
  recoveryCodesRemaining: number
  generatedAt: number
}

export type UpdateCheckStatus = 'ok' | 'unavailable'

export interface UpdateCheckResponse {
  currentVersion: string
  latestVersion: string | null
  updateUrl: string | null
  checkedAt: number | null
  status: UpdateCheckStatus
}

export type ThemePref = 'light' | 'dark' | 'system'
export type AppLocale = 'zh-CN' | 'en-US'
export type AccentName =
  | 'cinnabar'
  | 'indigo'
  | 'celadon'
  | 'amber'
  | 'terracotta'
  | 'wisteria'
  | 'graphite'
export type BackgroundName = 'paper' | 'white'
export type UiDensity = 'comfortable' | 'compact'
export type ProseFont = 'sans' | 'serif'
export type ProseWidth = 'narrow' | 'normal' | 'wide' | 'full'
export type EditorLayout = 'live' | 'split' | 'preview'
export type BackupSchedule = 'off' | 'hourly' | 'sixHourly' | 'daily'

export interface AppearanceSettings {
  language: AppLocale
  theme: ThemePref
  accent: AccentName
  background: BackgroundName
  density: UiDensity
  proseFont: ProseFont
  proseSize: number
  proseWidth: ProseWidth
  proseLineHeight: number
}

export interface EditorSettings {
  fontSize: number
  fontFamily: 'mono' | 'sans'
  lineNumbers: boolean
  typewriter: boolean
  focusMode: boolean
  spellcheck: boolean
  showToolbar: boolean
  tabSize: number
  autoSaveDelay: number
}

export interface PreviewSettings {
  layout: EditorLayout
  syncScroll: boolean
  showToc: boolean
  math: boolean
  mermaid: boolean
  codeBlockCollapse: boolean
  codeBlockCollapseLines: number
}

export interface BackupSettings {
  schedule: BackupSchedule
}

export interface SyncSettings {
  realtime: boolean
  pollIntervalMs: number
}

export interface UserSettings {
  appearance: AppearanceSettings
  editor: EditorSettings
  preview: PreviewSettings
  backup: BackupSettings
  sync: SyncSettings
}

export interface NoteSummary {
  id: string
  title: string
  excerpt: string
  folderId: string | null
  tags: string[]
  isPinned: boolean
  isStarred: boolean
  isArchived: boolean
  wordCount: number
  charCount: number
  rev: number
  position: number
  createdAt: number
  updatedAt: number
  deletedAt: number | null
}

export interface Note extends NoteSummary {
  content: string
}

export interface Folder {
  id: string
  parentId: string | null
  name: string
  icon: string | null
  color: string | null
  position: number
  createdAt: number
  updatedAt: number

  noteCount?: number
}

export interface Tag {
  id: string
  name: string
  color: string | null
  count: number
  createdAt: number
}

export interface NoteVersionMeta {
  id: string
  noteId: string
  title: string
  size: number
  createdAt: number
}

export interface NoteVersion extends NoteVersionMeta {
  content: string
}

export interface Backlink {
  id: string
  title: string
  context: string
}

export interface Attachment {
  id: string
  noteId: string | null
  filename: string
  mime: string
  size: number
  width: number | null
  height: number | null
  url: string
  createdAt: number
}

export interface AttachmentWithUsage extends Attachment {
  references: number
}

export type ViewKind =
  | 'all'
  | 'recent'
  | 'starred'
  | 'unfiled'
  | 'archived'
  | 'trash'
  | 'folder'
  | 'tag'

export type SortKey = 'updated' | 'created' | 'title'
export type SortOrder = 'asc' | 'desc'

export interface ListNotesQuery {
  view?: ViewKind
  folderId?: string
  tag?: string
  sort?: SortKey
  order?: SortOrder
  limit?: number
  cursor?: string
}

export interface ListNotesResponse {
  notes: NoteSummary[]
  nextCursor: string | null
  total: number
}

export interface CreateNoteBody {
  id?: string
  title?: string
  content?: string
  folderId?: string | null
  isStarred?: boolean
}

export interface PatchNoteBody {
  rev: number
  title?: string
  content?: string
  folderId?: string | null
  isPinned?: boolean
  isStarred?: boolean
  isArchived?: boolean

  quiet?: boolean
  preserveVersion?: boolean
}

export interface ConflictPayload {
  code: 'conflict'
  message: string
  server: Note
}

export type SearchMode = 'fts' | 'like'

export interface SearchHit {
  note: NoteSummary
  snippet: string
  score: number
}

export interface SearchResponse {
  results: SearchHit[]
  mode: SearchMode
  took: number
  query: {
    text: string
    tags: string[]
    folder: string | null
    starred: boolean | null
    archived: boolean | null
  }
}

export interface GraphNode {
  id: string
  title: string
  kind: 'note' | 'unresolved'
  degree: number
  inDegree: number
  outDegree: number
  folderId: string | null
  folderName: string | null
  folderColor: string | null
  tags: Array<{ name: string; color: string | null }>
}

export interface GraphEdge {
  source: string
  target: string
}

export interface GraphResponse {
  nodes: GraphNode[]
  edges: GraphEdge[]
  meta: {
    mode: 'global' | 'local'
    centerId: string | null
    depth: number
    totalNodes: number
    totalEdges: number
    truncated: boolean
    limit: number
  }
}

export interface GraphQuery {
  mode?: 'global' | 'local'
  center?: string
  depth?: number
  q?: string
  folderId?: string
  tag?: string
  includeOrphans?: boolean
  includeUnresolved?: boolean
  limit?: number
}

export interface SyncDeletion {
  entity: 'note' | 'folder' | 'tag'
  id: string
}

export interface SyncResponse {
  cursor: number
  full: boolean

  hasMore: boolean

  nextKey: string | null

  facetsFull: boolean

  settingsChanged: boolean
  profileChanged?: boolean
  siteChanged?: boolean
  notes: NoteSummary[]
  folders: Folder[]
  tags: Tag[]
  deletions: SyncDeletion[]
  serverTime: number
}
