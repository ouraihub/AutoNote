import type { Note, Folder, Tag } from './types-base'

export type RealtimeMessage =
  | { type: 'changed'; cursor: number; origin: string | null }
  | { type: 'ping' }
  | { type: 'pong'; serverTime: number }

export type BackupTargetType = 'webdav' | 's3'
export type BackupMode = 'archive' | 'mirror'

export interface S3Config {
  endpoint: string
  region: string
  bucket: string
  prefix: string
  pathStyle: boolean
  mode: BackupMode
}

export interface WebdavConfig {
  url: string
  username: string
  prefix: string
  mode: BackupMode
}

export type BackupTargetConfig = S3Config | WebdavConfig

export interface BackupTarget {
  id: string
  type: BackupTargetType
  name: string
  enabled: boolean
  config: BackupTargetConfig
  hasSecret: boolean
  lastRunAt: number | null
  lastStatus: 'success' | 'failed' | null
  lastError: string | null
  createdAt: number
  updatedAt: number
}

export interface BackupTargetInput {
  type: BackupTargetType
  name: string
  enabled?: boolean
  config: Partial<S3Config> & Partial<WebdavConfig>

  secret?: {
    password?: string
    accessKeyId?: string
    secretAccessKey?: string
  }
}

export type BackupTargetPatchInput = Partial<BackupTargetInput> & {
  expectedUpdatedAt?: number
}

export interface BackupTargetResult {
  targetId: string
  targetName: string
  targetType: BackupTargetType
  ok: boolean
  files: number
  bytes: number
  ms: number
  error: string | null
}

export interface BackupRun {
  id: string
  trigger: 'manual' | 'cron'
  status: 'running' | 'success' | 'partial' | 'failed'
  startedAt: number
  finishedAt: number | null
  noteCount: number
  fileCount: number
  bytes: number
  results: BackupTargetResult[]
}

export interface TestConnectionResult {
  ok: boolean
  message: string
  detail?: string
  latencyMs?: number
}

export interface ShareInfo {
  slug: string
  noteId: string
  url: string
  hasPassword: boolean
  expiresAt: number | null
  views: number
  createdAt: number
}

export interface ShareListItem extends ShareInfo {
  noteTitle: string
  deletedAt: number | null
}

export interface PublicNote {
  title: string
  content: string
  updatedAt: number
  createdAt: number
  author: { name: string; avatarUrl: string }
  site: { name: string }
  share: { slug: string }
}

export interface ExportBundle {
  format: string
  version: 1
  exportedAt: number
  user: { login: string; name: string }
  folders: Folder[]
  tags: Tag[]
  notes: Note[]

  attachments: ExportAttachment[]
}

export interface ExportAttachment {
  id: string
  noteId: string | null
  filename: string
  mime: string
  size: number
  width: number | null
  height: number | null
  createdAt: number
  path: string
  sha256: string
}

export interface ImportResult {
  createdNotes: number
  updatedNotes: number
  skippedNotes: number
  createdFolders: number
  createdAttachments: number
  skippedAttachments: number
  warnings: string[]
}

export interface McpPreferences {
  writeEnabled: boolean
  trashEnabled: boolean
  updatedAt: number
}

export interface McpGrant {
  id: string
  clientId: string
  clientName: string
  clientUri: string | null
  scopes: string[]
  createdAt: number
  expiresAt: number | null
}

export interface McpApiKey {
  id: string
  name: string
  scopes: string[]
  createdAt: number
  lastUsedAt: number | null
}

export interface McpAiSearchStatus {
  available: boolean
  enabled: boolean
  model: string
  indexedCount: number
  pendingCount: number
  reason: 'no_ai_binding' | null
}

export interface McpSettingsInfo {
  enabled: boolean
  canManageGlobal: boolean
  endpoint: string
  oauth: true
  preferences: McpPreferences
  apiKeys: McpApiKey[]
  aiSearch: McpAiSearchStatus
  grants: McpGrant[]
  privacy: {
    publicEndpoint: false
    perUserIndex: true
    externalClientReceivesSelectedContent: true
  }
}

export interface ApiErrorBody {
  error: {
    code: string
    message: string
    details?: unknown
  }
}

export type ApiErrorCode =
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'bad_request'
  | 'payload_too_large'
  | 'storage_unavailable'
  | 'internal'
  | 'invalid_username'
  | 'invalid_profile_name'
  | 'invalid_avatar'
  | 'weak_password'
  | 'username_taken'
  | 'invalid_credentials'
  | 'invalid_two_factor_code'
  | 'wrong_password'
  | 'too_many_attempts'
  | 'registration_closed'
  | 'server_misconfigured'
  | 'two_factor_already_enabled'
  | 'two_factor_challenge_expired'
  | 'two_factor_not_enabled'
  | 'two_factor_setup_expired'
  | 'two_factor_unavailable'
