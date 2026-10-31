import type { PasswordLoginResult, TotpLoginResult } from '@shared/types'
import { call } from '../transport'

export interface SyncLoginReply {
  loginId: string
  result: PasswordLoginResult
}
export interface SyncTotpReply {
  loginId: string
  result: TotpLoginResult
}
/** Remote snapshot compared with local notes by id; binding keeps both sides of a difference. */
export interface BindPreview {
  previewId: string
  localOnly: number
  remoteOnly: number
  same: number
  different: number
  expiresAt: number
}
export type SyncPhase = 'unbound' | 'idle' | 'syncing' | 'paused'
export interface SyncStatus {
  phase: SyncPhase
  siteOrigin: string | null
  account: string | null
  cursor: number
  /** Local rows awaiting push. */
  pending: number
  lastSuccessAt: number | null
  errorCode: string | null
}

export interface SyncPort {
  login(
    origin: string,
    username: string,
    password: string,
  ): Promise<SyncLoginReply>
  completeTotp(
    loginId: string,
    challengeToken: string,
    code: string,
  ): Promise<SyncTotpReply>
  status(): Promise<SyncStatus>
  preview(loginId: string): Promise<BindPreview>
  confirm(previewId: string): Promise<SyncStatus>
  unbind(): Promise<SyncStatus>
  start(): Promise<SyncStatus>
  stop(): Promise<SyncStatus>
  now(): Promise<SyncStatus>
}

export const syncPort: SyncPort = {
  login: (origin, username, password) =>
    call('sync_login', { origin, username, password }),
  completeTotp: (loginId, challengeToken, code) =>
    call('sync_complete_totp', { loginId, challengeToken, code }),
  status: () => call('sync_status', undefined),
  preview: (loginId) => call('sync_bind_preview', { loginId }),
  confirm: (previewId) => call('sync_bind_confirm', { previewId }),
  unbind: () => call('sync_unbind', undefined),
  start: () => call('sync_start', undefined),
  stop: () => call('sync_stop', undefined),
  now: () => call('sync_now', undefined),
}
