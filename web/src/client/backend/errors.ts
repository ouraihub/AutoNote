import { isErrorCode, isNote, type ErrorCode } from '@shared/backend-types'
import { BackendError, type BackendErrorDetails } from '@app/backend/errors'

export interface BackendErrorContext {
  readonly response?: Response
  readonly payload?: unknown
  readonly timedOut?: boolean
  readonly cancelled?: boolean
}

export function offlineError(): BackendError {
  return new BackendError('offline', 0, 'Network unavailable')
}

export function toBackendError(error: unknown, context: BackendErrorContext = {}): BackendError {
  if (context.timedOut) return new BackendError('request_timeout', 0, 'Request timed out')
  if (context.cancelled) return new BackendError('cancelled', 0, 'Request cancelled')
  if (context.response) return errorFromResponse(context.response, context.payload)
  if (error instanceof BackendError) return error
  if (isAbortError(error)) return new BackendError('cancelled', 0, 'Request cancelled')
  return offlineError()
}

export function errorFromResponse(response: Response, payload: unknown = undefined): BackendError {
  const fallbackCode = statusCode(response.status)
  const fallbackMessage = `Request failed with status ${response.status}`
  if (!isApiErrorPayload(payload)) {
    const unknown = unknownApiError(payload)
    if (unknown) return new BackendError('internal', response.status, unknown.message)
    return new BackendError(fallbackCode, response.status, fallbackMessage)
  }
  return new BackendError(
    payload.error.code,
    response.status,
    payload.error.message,
    safeDetails(payload.error.details),
  )
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === 'AbortError'
    : error instanceof Error && error.name === 'AbortError'
}

function statusCode(status: number): ErrorCode {
  switch (status) {
    case 400:
      return 'bad_request'
    case 401:
      return 'unauthenticated'
    case 403:
      return 'forbidden'
    case 404:
      return 'not_found'
    case 409:
      return 'conflict'
    case 413:
      return 'payload_too_large'
    case 429:
      return 'too_many_attempts'
    case 503:
      return 'storage_unavailable'
    default:
      return 'internal'
  }
}

function unknownApiError(value: unknown): { readonly message: string } | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || !('error' in value)) return undefined
  const candidate = value.error
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) return undefined
  if (!('code' in candidate) || isErrorCode(candidate.code)) return undefined
  if (!('message' in candidate) || typeof candidate.message !== 'string') return undefined
  return { message: candidate.message }
}

function isApiErrorPayload(
  value: unknown,
): value is { readonly error: { readonly code: ErrorCode; readonly message: string; readonly details?: unknown } } {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || !('error' in value)) return false
  const candidate = value.error
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) return false
  if (!('code' in candidate) || !isErrorCode(candidate.code)) return false
  return 'message' in candidate && typeof candidate.message === 'string'
}

function safeDetails(value: unknown): BackendErrorDetails | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const source = value as Record<string, unknown>
  const details: BackendErrorDetails = {}
  if (typeof source.deletionCursor === 'number' && Number.isSafeInteger(source.deletionCursor)) {
    details.deletionCursor = source.deletionCursor
  }
  if (typeof source.retryAfter === 'number' && Number.isFinite(source.retryAfter)) {
    details.retryAfter = source.retryAfter
  }
  if (isNote(source.server)) details.server = source.server
  if (Array.isArray(source.issues)) {
    const issues = source.issues.flatMap((issue) => {
      if (issue === null || typeof issue !== 'object' || Array.isArray(issue)) return []
      if (!('path' in issue) || !('message' in issue)) return []
      const path = issue.path
      const message = issue.message
      if (!Array.isArray(path) || !path.every((segment): segment is string => typeof segment === 'string')) return []
      if (typeof message !== 'string') return []
      return [{ path, message }]
    })
    if (issues.length > 0) details.issues = issues
  }
  return Object.keys(details).length === 0 ? undefined : details
}
