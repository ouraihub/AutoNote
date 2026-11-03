import { isErrorCode, isNote, type ErrorCode } from '@shared/backend-types'
import type { Note } from '@shared/types'

export interface BackendErrorDetails {
  server?: Note
  deletionCursor?: number
  retryAfter?: number
  issues?: readonly { path: readonly string[]; message: string }[]
}

export class BackendError extends Error {
  readonly code: ErrorCode
  readonly status: number
  readonly details: BackendErrorDetails | undefined

  constructor(
    code: ErrorCode,
    status: number,
    message: string,
    details?: BackendErrorDetails,
  ) {
    super(message)
    this.name = 'BackendError'
    this.code = code
    this.status = status
    this.details = details
  }
}

export function isBackendError(error: unknown): error is BackendError {
  return error instanceof BackendError
}

export function backendErrorFromPayload(
  payload: unknown,
  fallback: { code: ErrorCode; status: number; message: string },
): BackendError {
  if (!isApiErrorPayload(payload))
    return new BackendError(fallback.code, fallback.status, fallback.message)

  return new BackendError(
    payload.error.code,
    fallback.status,
    payload.error.message,
    safeDetails(payload.error.details),
  )
}

function isApiErrorPayload(
  value: unknown,
): value is { error: { code: ErrorCode; message: string; details?: unknown } } {
  if (value === null || typeof value !== 'object' || !('error' in value))
    return false
  const { error } = value
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    isErrorCode(error.code) &&
    'message' in error &&
    typeof error.message === 'string'
  )
}

function safeDetails(value: unknown): BackendErrorDetails | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return undefined
  const details: BackendErrorDetails = {}
  if (
    'deletionCursor' in value &&
    typeof value.deletionCursor === 'number' &&
    Number.isSafeInteger(value.deletionCursor)
  ) {
    details.deletionCursor = value.deletionCursor
  }
  if (
    'retryAfter' in value &&
    typeof value.retryAfter === 'number' &&
    Number.isFinite(value.retryAfter)
  ) {
    details.retryAfter = value.retryAfter
  }
  if ('server' in value && isNote(value.server)) details.server = value.server
  if ('issues' in value && Array.isArray(value.issues)) {
    const issues = value.issues.flatMap((issue) => {
      if (issue === null || typeof issue !== 'object' || Array.isArray(issue))
        return []
      if (
        !('message' in issue) ||
        typeof issue.message !== 'string' ||
        !('path' in issue) ||
        !Array.isArray(issue.path)
      )
        return []
      if (!issue.path.every((segment: unknown) => typeof segment === 'string'))
        return []
      return [{ path: issue.path as readonly string[], message: issue.message }]
    })
    if (issues.length > 0) details.issues = issues
  }
  return Object.keys(details).length === 0 ? undefined : details
}
