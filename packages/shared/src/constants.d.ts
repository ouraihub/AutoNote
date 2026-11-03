import type { AccentName, UserSettings, ViewKind } from './types'
export declare const CLIENT_HEADER = 'X-AutoNote-Client'
export declare const SESSION_COOKIE = '__Host-autonote_session'
export declare const LEGACY_SESSION_COOKIE = 'autonote_session'
export declare const SESSION_TTL_MS: number
export declare const SESSION_RENEW_BEFORE_MS: number
export declare const LIMITS: {
  readonly passwordMaxLength: 128
  readonly titleMaxLength: 512
  readonly contentMaxBytes: number
  readonly folderNameMaxLength: 120
  readonly tagNameMaxLength: 60
  readonly folderDepthMax: 12
  readonly attachmentMaxBytes: number
  readonly attachmentQuotaBytes: number
  readonly attachmentUploadsPerHour: 100
  readonly importFilesMax: 500
  readonly importUploadMaxBytes: number
  readonly importBundleMaxBytes: number
  readonly importArchiveEntriesMax: 2500
  readonly importArchiveExpandedMaxBytes: number
  readonly versionsPerNote: 50
  readonly backupRunsKept: 50
  readonly backupTargetsMax: 12
  readonly changeLogKept: 5000
  readonly syncBatchSize: 500
  readonly searchLimit: 50
  readonly ftsContentChars: 200000
}
export declare const ACCENTS: {
  name: AccentName
  swatch: string
  foreground: string
}[]
export declare const PROSE_WIDTH_CH: Record<string, string>
export declare const VIEW_KINDS: ViewKind[]
export declare const DEFAULT_SETTINGS: UserSettings
export declare const BACKUP_INTERVALS: Record<string, number>
export declare function mergeSettings(partial: unknown): UserSettings
export declare function mergeSettingsPatch(
  current: unknown,
  patch: unknown,
): UserSettings
