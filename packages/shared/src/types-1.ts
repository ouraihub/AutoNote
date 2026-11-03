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
