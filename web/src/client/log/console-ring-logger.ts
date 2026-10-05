import type { LogFields, Logger, LogValue } from '@app/log/logger'
import { isErrorCode } from '@shared/backend-types'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogEntry {
  readonly time: number
  readonly level: LogLevel
  readonly event: string
  readonly fields: Readonly<Record<string, LogValue>>
}

export interface ConsoleLike {
  debug(...args: readonly unknown[]): void
  info(...args: readonly unknown[]): void
  warn(...args: readonly unknown[]): void
  error(...args: readonly unknown[]): void
}

export interface ConsoleRingLoggerOptions {
  readonly clock?: () => number
  readonly console?: ConsoleLike
  readonly includeDebug?: boolean
}
const NUMERIC_FIELDS: Readonly<Record<string, true>> = {
  count: true,
  pending: true,
  failed: true,
  attempts: true,
  rev: true,
  cursor: true,
  pages: true,
  durationMs: true,
  delayMs: true,
  retryInMs: true,
  completed: true,
  total: true,
  status: true,
  sections: true,
  index: true,
}
const BOOLEAN_FIELDS: Readonly<Record<string, true>> = { full: true, online: true, settingsPending: true }
const LABEL_FIELDS: Readonly<Record<string, RegExp>> = {
  code: /^[a-z_]{1,40}$/,
  name: /^(?:Error|TypeError|SyntaxError|AbortError|QuotaExceededError|InvalidStateError|SecurityError|NotAllowedError|unknown)$/,
  mode: /^(?:production|development|demo|test)$/,
  keyKind: /^(?:outbox|content|session|shell|user)$/,
  phase: /^(?:validating|reading|writing|uploading|finalizing|completed|cancelled|failed)$/,
  reason: /^(?:conflict|deleted|offline|unauthenticated)$/,
  noteId: /^[0-9a-hjkmnp-tv-z]{26}$/i,
  writeId: /^(?:[0-9a-f-]{36}|[0-9a-hjkmnp-tv-z]{26})$/i,
  jobId: /^(?:[0-9a-f-]{36}|[0-9a-hjkmnp-tv-z]{26})$/i,
}

export class ConsoleRingLogger implements Logger {
  readonly #clock: () => number
  readonly #console: ConsoleLike
  readonly #includeDebug: boolean
  #entries: LogEntry[] = []

  constructor(options: ConsoleRingLoggerOptions = {}) {
    this.#clock = options.clock ?? (() => Date.now())
    this.#console = options.console ?? console
    this.#includeDebug = options.includeDebug ?? false
  }

  debug(event: string, fields?: LogFields): void {
    this.#record('debug', event, fields)
  }

  info(event: string, fields?: LogFields): void {
    this.#record('info', event, fields)
  }

  warn(event: string, fields?: LogFields): void {
    this.#record('warn', event, fields)
  }

  error(event: string, fields?: LogFields): void {
    this.#record('error', event, fields)
  }

  entries(): readonly LogEntry[] {
    return this.#entries.map((entry) => ({ ...entry, fields: { ...entry.fields } }))
  }

  #record(level: LogLevel, event: string, fields: LogFields | undefined): void {
    if (!/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){1,5}$/.test(event)) return
    const safe: Record<string, LogValue> = {}
    for (const [key, value] of Object.entries(fields ?? {})) {
      if (key === 'code') {
        safe.code =
          isErrorCode(value) || value === 'password_required' || value === 'password_invalid' ? value : 'internal'
        continue
      }
      if (Object.hasOwn(NUMERIC_FIELDS, key) && typeof value === 'number' && Number.isFinite(value)) safe[key] = value
      else if (Object.hasOwn(BOOLEAN_FIELDS, key) && typeof value === 'boolean') safe[key] = value
      else if (Object.hasOwn(LABEL_FIELDS, key) && typeof value === 'string' && LABEL_FIELDS[key]?.test(value))
        safe[key] = value
    }
    if (fields && Object.keys(fields).length && !Object.keys(safe).length) return
    const entry: LogEntry = { time: this.#clock(), level, event, fields: safe }
    if (this.#entries.length === 200) this.#entries.shift()
    this.#entries.push(entry)
    if (level === 'debug' && !this.#includeDebug) return
    this.#console[level](JSON.stringify(entry))
  }
}
