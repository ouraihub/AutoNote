import type { KeyStrategy, Protocol } from '@ouraihub/aether-ui/ports'

export const KEY_RE = /^anr_[A-Za-z0-9_-]{43}$/
export const ACTIVE_KEYS_MAX = 20
export const MAX_BODY = 10 * 1024 * 1024
export const MAX_CONCURRENT_MANUAL = 8
export const MAX_CONCURRENT_GITHUB = 32
export const GITHUB_KEY_TTL_MS = 6 * 3_600_000
export const BUSY_RETRY_SECONDS = '2'
export const KEEP_HEADERS = [
  'anthropic-version',
  'anthropic-beta',
  'content-type',
  'accept',
]
export const KEY_STATUS = [401, 402, 403, 429]

export interface RelayKey {
  id: string
  name: string
  createdAt: number
  lastUsedAt: number | null
  expiresAt: number | null
  todayRequests: number
}

export interface RelayModel {
  id: string
  object: 'model'
  owned_by: string
  protocol: Protocol
  model_type: 'chat' | 'image'
}

export interface RelayRepo {
  repo: string
  workflow: string
  ref: string
}

export interface LineRow {
  endpointId: string
  baseUrl: string
  imageBaseUrl: string | null
  imageEditBaseUrl: string | null
  protocol: Protocol
  headers: string
  keyStrategy: KeyStrategy
  slug: string
  providerId: string
  providerName: string
  modelId: string
  modelType: 'chat' | 'image'
}

export const relayError = (
  status: number,
  type: string,
  message: string,
  headers?: HeadersInit,
): Response =>
  Response.json(
    { type: 'error', error: { type, message } },
    { status, headers },
  )

export const today = (now: number): string =>
  new Date(now).toISOString().slice(0, 10)

export const normalizeWorkflow = (workflow: string): string =>
  workflow.replace(/^[^/]+\/[^/]+/, (repo) => repo.toLowerCase())
