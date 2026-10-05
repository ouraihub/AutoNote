import type { PasswordLoginResult, TotpLoginResult } from '@shared/types'
import { call } from '../transport'

export type BindStrategy = 'keep-local' | 'import-remote' | 'merge'
export type ConflictChoice = 'local' | 'remote' | 'keep-both'
export interface SyncLoginReply {
  loginId: string
  result: PasswordLoginResult
}
export interface SyncTotpReply {
  loginId: string
  result: TotpLoginResult
}
export interface SyncCounts {
  local: number
  remote: number
  matched: number
  conflicts: number
  attachments: number
  networkWrites: number
}
export interface BindPreview {
  previewId: string
  counts: SyncCounts
  expiresAt: number
}
export interface SyncConflict {
  id: string
  bindingId: string
  epoch: number
  entity: string
  reason: string
  localId?: string
  remoteId?: string
}
export interface QuarantinedBinding {
  bindingId: string
  epoch: number
  siteOrigin: string
  accountHint: string
  pending: number
}
export interface SyncStatus {
  bindingId: string | null
  epoch: number | null
  phase: string
  localCursor: number
  remoteCursor: number
  pending: number
  blocked: number
  conflicts: number
  online: boolean
  errorCode: string | null
  terminal: boolean
  siteOrigin: string | null
  accountHint: string | null
  metadataRisk: boolean
  conflictItems: SyncConflict[]
  quarantined: QuarantinedBinding[]
}

export interface SyncPort {
  login(origin: string, username: string, password: string): Promise<SyncLoginReply>
  completeTotp(loginId: string, challengeToken: string, code: string): Promise<SyncTotpReply>
  status(): Promise<SyncStatus>
  preview(loginId: string, strategy: BindStrategy): Promise<BindPreview>
  confirm(previewId: string): Promise<SyncStatus>
  unbind(bindingId: string, epoch: number): Promise<SyncStatus>
  start(): Promise<SyncStatus>
  stop(): Promise<SyncStatus>
  now(): Promise<SyncStatus>
  resolveConflict(conflictId: string, choice: ConflictChoice, bindingId: string, epoch: number): Promise<SyncStatus>
  exportQuarantined(bindingId: string, epoch: number): Promise<unknown>
  discardQuarantined(bindingId: string, epoch: number): Promise<SyncStatus>
}

export const syncPort: SyncPort = {
  login: (origin, username, password) => call('sync_login', { origin, username, password }),
  completeTotp: (loginId, challengeToken, code) => call('sync_complete_totp', { loginId, challengeToken, code }),
  status: () => call('sync_status', undefined),
  preview: (loginId, strategy) => call('sync_bind_preview', { loginId, strategy }),
  confirm: (previewId) => call('sync_bind_confirm', { previewId }),
  unbind: (bindingId, epoch) => call('sync_unbind', { bindingId, epoch }),
  start: () => call('sync_start', undefined),
  stop: () => call('sync_stop', undefined),
  now: () => call('sync_now', undefined),
  resolveConflict: (conflictId, choice, bindingId, epoch) =>
    call('sync_resolve_conflict', { conflictId, choice, bindingId, epoch }),
  exportQuarantined: (bindingId, epoch) => call('sync_export_quarantined', { bindingId, epoch }),
  discardQuarantined: (bindingId, epoch) => call('sync_discard_quarantined', { bindingId, epoch }),
}
