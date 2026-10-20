import { z } from 'zod'
import type {
  AccentName,
  ApiErrorCode,
  AttachmentWithUsage,
  Note,
  PublicUser,
  SessionInfo,
  SiteInfo,
  Tag,
  UserSettings,
} from './types'

const API_ERROR_CODES = [
  'unauthenticated',
  'forbidden',
  'not_found',
  'conflict',
  'bad_request',
  'payload_too_large',
  'storage_unavailable',
  'internal',
  'invalid_username',
  'invalid_profile_name',
  'invalid_avatar',
  'weak_password',
  'username_taken',
  'invalid_credentials',
  'invalid_two_factor_code',
  'wrong_password',
  'too_many_attempts',
  'registration_closed',
  'server_misconfigured',
  'two_factor_already_enabled',
  'two_factor_challenge_expired',
  'two_factor_not_enabled',
  'two_factor_setup_expired',
  'two_factor_unavailable',
] as const satisfies readonly ApiErrorCode[]

const CLIENT_ERROR_CODES = ['offline', 'cancelled', 'request_timeout', 'invalid_response'] as const
const NON_NEGATIVE_SAFE_INTEGER = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const UNIX_MILLISECONDS = NON_NEGATIVE_SAFE_INTEGER
const ID = z.string().regex(/^[0-9a-hjkmnp-tv-z]{26}$/)

export const ErrorCodeSchema = z.enum([...API_ERROR_CODES, ...CLIENT_ERROR_CODES])
export type ErrorCode = z.infer<typeof ErrorCodeSchema>

export interface BackendSession extends Omit<SessionInfo, 'site'> {
  site: Omit<SiteInfo, 'attachmentStorage'> & {
    attachmentStorage: SiteInfo['attachmentStorage'] | 'local'
  }
}

export interface FolderCreate {
  id?: string
  name?: string
  parentId?: string | null
  beforeId?: string | null
  icon?: string | null
  color?: string | null
}

export interface FolderPatch {
  name?: string
  parentId?: string | null
  beforeId?: string | null
  icon?: string | null
  color?: string | null
}

export interface TagCreate {
  id?: string
  name: string
  color?: string | null
}

export interface TagPatch {
  name?: string
  color?: string | null
}

export interface SettingsPatch {
  appearance?: Partial<UserSettings['appearance']>
  editor?: Partial<UserSettings['editor']>
  preview?: Partial<UserSettings['preview']>
  backup?: Partial<UserSettings['backup']>
  sync?: Partial<UserSettings['sync']>
}

export interface FlushResult {
  pending: number
  failed: number
}

export interface TagPatchResult {
  tag: Tag | null
  renamed: number
}

export interface AttachmentPage {
  files: AttachmentWithUsage[]
  nextCursor: string | null
}

export type ProgressPhase = 'validating' | 'reading' | 'writing' | 'uploading' | 'finalizing'

export interface ProgressEvent {
  jobId: string
  phase: ProgressPhase
  completed: number
  total: number | null
  terminal: boolean
}

export interface McpLocalStatus {
  running: boolean
  endpoint: string | null
  port: number
  error: string | null
}

export interface LocalLibraryIdentity {
  id: string
  name: string
  avatarUrl: string
  role: 'owner'
  createdAt: number
}

export interface AccentPreview {
  name: AccentName
  label: string
}

export type NoteWriteResult =
  { queued: false; writeId: string; note: Note } | { queued: true; writeId: string; noteId: string; rev: number }

export type WriteQueueEvent =
  | { kind: 'pending'; count: number }
  | { kind: 'settled'; writeId: string; noteId: string; note: Note }
  | { kind: 'recovered'; writeId: string; noteId: string; copy: Note; reason: 'deleted' }
  | { kind: 'failed'; writeId: string; noteId: string; code: ErrorCode; retained: boolean }

const PublicUserSchema = z.object({
  id: ID,
  login: z.string(),
  name: z.string(),
  avatarUrl: z.string(),
  role: z.enum(['owner', 'member']),
  createdAt: UNIX_MILLISECONDS,
  username: z.string(),
})

const SiteSchema = z.object({
  name: z.string(),
  initialized: z.boolean(),
  registrationOpen: z.boolean(),
  r2Enabled: z.boolean(),
  kvEnabled: z.boolean(),
  attachmentStorage: z.enum(['r2', 'kv', 'local']).nullable(),
  realtimeEnabled: z.boolean(),
  version: z.string(),
})

export const NoteSchema = z.object({
  id: ID,
  title: z.string(),
  excerpt: z.string(),
  folderId: ID.nullable(),
  tags: z.array(z.string()),
  isPinned: z.boolean(),
  isStarred: z.boolean(),
  isArchived: z.boolean(),
  wordCount: NON_NEGATIVE_SAFE_INTEGER,
  charCount: NON_NEGATIVE_SAFE_INTEGER,
  rev: NON_NEGATIVE_SAFE_INTEGER,
  position: z.number().finite(),
  createdAt: UNIX_MILLISECONDS,
  updatedAt: UNIX_MILLISECONDS,
  deletedAt: UNIX_MILLISECONDS.nullable(),
  content: z.string(),
})

const SettingsSchema: z.ZodType<UserSettings> = z.object({
  appearance: z.object({
    language: z.enum(['zh-CN', 'en-US']),
    theme: z.enum(['light', 'dark', 'system']),
    accent: z.enum(['cinnabar', 'indigo', 'celadon', 'amber', 'terracotta', 'wisteria', 'graphite']),
    background: z.enum(['paper', 'white']),
    density: z.enum(['comfortable', 'compact']),
    proseFont: z.enum(['sans', 'serif']),
    proseSize: z.number().finite(),
    proseWidth: z.enum(['narrow', 'normal', 'wide', 'full']),
    proseLineHeight: z.number().finite(),
  }),
  editor: z.object({
    fontSize: z.number().finite(),
    fontFamily: z.enum(['mono', 'sans']),
    lineNumbers: z.boolean(),
    typewriter: z.boolean(),
    focusMode: z.boolean(),
    spellcheck: z.boolean(),
    showToolbar: z.boolean(),
    tabSize: z.number().finite(),
    autoSaveDelay: z.number().finite(),
  }),
  preview: z.object({
    layout: z.enum(['live', 'split', 'preview']),
    syncScroll: z.boolean(),
    showToc: z.boolean(),
    math: z.boolean(),
    mermaid: z.boolean(),
    codeBlockCollapse: z.boolean(),
    codeBlockCollapseLines: z.number().finite(),
  }),
  backup: z.object({ schedule: z.enum(['off', 'hourly', 'sixHourly', 'daily']) }),
  sync: z.object({ realtime: z.boolean(), pollIntervalMs: z.number().finite() }),
})

export const BackendSessionSchema: z.ZodType<BackendSession> = z.object({
  user: PublicUserSchema.nullable(),
  site: SiteSchema,
  settings: SettingsSchema.nullable(),
})

export const NoteWriteResultSchema: z.ZodType<NoteWriteResult> = z.discriminatedUnion('queued', [
  z.object({ queued: z.literal(false), writeId: z.string().min(1), note: NoteSchema }),
  z.object({ queued: z.literal(true), writeId: z.string().min(1), noteId: ID, rev: NON_NEGATIVE_SAFE_INTEGER }),
])

export const WriteQueueEventSchema: z.ZodType<WriteQueueEvent> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pending'), count: NON_NEGATIVE_SAFE_INTEGER }),
  z.object({ kind: z.literal('settled'), writeId: z.string().min(1), noteId: ID, note: NoteSchema }),
  z.object({
    kind: z.literal('recovered'),
    writeId: z.string().min(1),
    noteId: ID,
    copy: NoteSchema,
    reason: z.literal('deleted'),
  }),
  z.object({
    kind: z.literal('failed'),
    writeId: z.string().min(1),
    noteId: ID,
    code: ErrorCodeSchema,
    retained: z.boolean(),
  }),
])

export const ProgressEventSchema: z.ZodType<ProgressEvent> = z.object({
  jobId: z.string().min(1),
  phase: z.enum(['validating', 'reading', 'writing', 'uploading', 'finalizing']),
  completed: NON_NEGATIVE_SAFE_INTEGER,
  total: NON_NEGATIVE_SAFE_INTEGER.nullable(),
  terminal: z.boolean(),
})

export function isErrorCode(value: unknown): value is ErrorCode {
  return ErrorCodeSchema.safeParse(value).success
}

export function isBackendSession(value: unknown): value is BackendSession {
  return BackendSessionSchema.safeParse(value).success
}

export function isPublicUser(value: unknown): value is PublicUser {
  return PublicUserSchema.safeParse(value).success
}

export function isNoteWriteResult(value: unknown): value is NoteWriteResult {
  return NoteWriteResultSchema.safeParse(value).success
}

export function isWriteQueueEvent(value: unknown): value is WriteQueueEvent {
  return WriteQueueEventSchema.safeParse(value).success
}

export function isProgressEvent(value: unknown): value is ProgressEvent {
  return ProgressEventSchema.safeParse(value).success
}

export function isNote(value: unknown): value is Note {
  return NoteSchema.safeParse(value).success
}
