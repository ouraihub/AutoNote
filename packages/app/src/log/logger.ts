import { isBackendError } from '../backend/errors'
import { AppError } from '../i18n/errors'

export type LogValue = boolean | number | string | null
export type LogFields = Readonly<Record<string, LogValue>>

export interface Logger {
  debug(event: string, fields?: LogFields): void
  info(event: string, fields?: LogFields): void
  warn(event: string, fields?: LogFields): void
  error(event: string, fields?: LogFields): void
}

export function isSafeLogFields(fields: LogFields | undefined): boolean {
  if (!fields) return true
  return Object.entries(fields).every(([key, value]) => {
    const normalized = key.toLowerCase()
    if (normalized.includes('content') || normalized.includes('title') || normalized.includes('password')) return false
    if (normalized.includes('token') || normalized.includes('cookie') || normalized.includes('secret'))
      return value === '[redacted]'
    return true
  })
}

/** Final-layer failure log: expected errors warn with a code, program errors error with a name; cancels are silent. */
export function logFailure(logger: Logger, event: string, error: unknown, context: LogFields = {}): void {
  if (isBackendError(error)) {
    if (error.code !== 'cancelled') logger.warn(event, { ...context, code: error.code })
  } else if (error instanceof AppError) logger.warn(event, { ...context, key: error.key })
  else logger.error(event, { ...context, name: error instanceof Error ? error.name : 'unknown' })
}
