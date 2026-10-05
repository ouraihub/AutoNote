import { BackendError, backendErrorFromPayload } from '@app/backend/errors'
import { isErrorCode } from '@shared/backend-types'

export function invalidResponse(): BackendError {
  return new BackendError('invalid_response', 502, 'Invalid desktop response')
}
export function cancelled(): BackendError {
  return new BackendError('cancelled', 0, 'Desktop operation cancelled')
}
export function ipcError(error: unknown): BackendError {
  if (error instanceof BackendError) return error
  if (!error || typeof error !== 'object' || !('code' in error) || !isErrorCode(error.code))
    return new BackendError('internal', 500, 'Desktop operation failed')
  const statuses: Partial<Record<typeof error.code, number>> = {
    bad_request: 400,
    unauthenticated: 401,
    forbidden: 403,
    not_found: 404,
    conflict: 409,
    payload_too_large: 413,
    too_many_attempts: 429,
    storage_unavailable: 503,
    offline: 0,
    cancelled: 0,
    request_timeout: 408,
    invalid_response: 502,
  }
  const status = statuses[error.code] ?? 500
  const safe = backendErrorFromPayload({ error }, { code: 'internal', status, message: 'Desktop operation failed' })
  return new BackendError(safe.code, status, `Desktop operation failed (${safe.code})`, safe.details)
}
