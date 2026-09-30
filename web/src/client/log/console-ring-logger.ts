import { isSafeLogFields, type LogFields, type Logger, type LogValue } from '@app/log/logger.ts'

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
    return this.#entries
  }

  #record(level: LogLevel, event: string, fields: LogFields | undefined): void {
    if (!isSafeLogFields(fields)) return
    const entry: LogEntry = { time: this.#clock(), level, event, fields: fields ?? {} }
    if (this.#entries.length === 200) this.#entries.shift()
    this.#entries.push(entry)
    if (level === 'debug' && !this.#includeDebug) return
    this.#console[level](JSON.stringify(entry))
  }
}
