import type { Logger, LogFields } from '@app/log/logger'
import type { IpcTransport } from '../ipc/transport'
import type { LogRecord } from '../ipc/commands'

const numericFields =
  /^(count|pending|failed|pendingCount|droppedCount|durationMs|cursor|rev|schemaVersion|indexed|attachmentCount|noteCount|recoveredCount|orphanCount|dpi|status)$/
const codes =
  /^(bad_request|unauthenticated|forbidden|not_found|conflict|payload_too_large|too_many_attempts|storage_unavailable|internal|offline|cancelled|request_timeout|invalid_response)$/
function safeField(key: string, value: string | number | boolean | null): boolean {
  if (typeof value === 'number') return numericFields.test(key) && Number.isFinite(value)
  if (typeof value === 'boolean') return key === 'online' || key === 'available'
  if (typeof value !== 'string') return false
  switch (key) {
    case 'command':
      return /^[a-z][a-z0-9_]{0,63}$/.test(value)
    case 'code':
      return codes.test(value)
    case 'phase':
    case 'stage':
      return /^(validating|reading|writing|uploading|finalizing|startup|shutdown|paths|library|webview|logging)$/.test(
        value,
      )
    case 'format':
      return value === 'zip' || value === 'json'
    case 'reason':
      return /^(dpi_changed|monitor_removed|offscreen|invalid_state)$/.test(value)
    case 'jobId':
    case 'writeId':
      return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    case 'noteId':
    case 'note_id':
      return /^[0-9a-hjkmnp-tv-z]{26}$/.test(value)
    case 'version':
      return /^[0-9.]{1,32}$/.test(value)
    default:
      return false
  }
}
export class IpcLogger implements Logger {
  #queue: LogRecord[] = []
  #dropped = 0
  #timer: number | NodeJS.Timeout | undefined
  #sending: Promise<void> | null = null
  #inFlightCount = 0
  #disposed = false
  #diagnostic: { event: 'app.log.unavailable'; droppedCount: number } | null = null
  get diagnostic(): Readonly<{ event: 'app.log.unavailable'; droppedCount: number }> | null {
    return this.#diagnostic
  }
  available = true
  constructor(private readonly transport: IpcTransport) {}
  debug(event: string, fields?: LogFields): void {
    this.#enqueue('debug', event, fields)
  }
  info(event: string, fields?: LogFields): void {
    this.#enqueue('info', event, fields)
  }
  warn(event: string, fields?: LogFields): void {
    this.#enqueue('warn', event, fields)
  }
  error(event: string, fields?: LogFields): void {
    this.#enqueue('error', event, fields)
  }
  #enqueue(level: LogRecord['level'], event: string, fields?: LogFields): void {
    if (this.#disposed) return
    if (event.length > 128 || !/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/.test(event)) {
      this.#dropped++
      return
    }
    const safe = Object.fromEntries(Object.entries(fields ?? {}).filter(([key, value]) => safeField(key, value)))
    const entry: LogRecord = { level, event, fields: safe }
    // All retained values are ASCII; length equals UTF-8 bytes after JSON escaping.
    if (JSON.stringify(entry).length > 4096) {
      this.#dropped++
      return
    }
    if (this.#queue.length === 200) {
      const index = this.#queue.findIndex((item) => item.level === 'debug' || item.level === 'info')
      if (index === -1) {
        this.#dropped++
        return
      }
      this.#queue.splice(index, 1)
      this.#dropped++
    }
    this.#queue.push(entry)
    if (this.#queue.length >= 20) void this.flush()
    else
      this.#timer ??= globalThis.setTimeout(() => {
        this.#timer = undefined
        void this.flush()
      }, 250)
  }
  flush(): Promise<void> {
    clearTimeout(this.#timer)
    this.#timer = undefined
    if (this.#sending) return this.#sending
    this.#sending = (async () => {
      while (!this.#disposed && (this.#queue.length || this.#dropped)) {
        const entries = this.#queue.splice(0, 20)
        const droppedCount = this.#dropped
        this.#dropped = 0
        this.#inFlightCount = entries.length
        try {
          const result = await this.transport.invoke('app_log', { entries, droppedCount })
          if (this.#disposed) break
          this.available = result.available
          this.#diagnostic = result.available ? null : { event: 'app.log.unavailable', droppedCount }
        } catch {
          if (this.#disposed) break
          this.available = false
          this.#dropped += entries.length + droppedCount
          this.#diagnostic = { event: 'app.log.unavailable', droppedCount: this.#dropped }
          this.#inFlightCount = 0
          break
        }
        this.#inFlightCount = 0
      }
    })().finally(() => {
      this.#sending = null
    })
    return this.#sending
  }
  async dispose(): Promise<void> {
    let timeout: number | NodeJS.Timeout | undefined
    await Promise.race([
      this.flush(),
      new Promise<void>((resolve) => {
        timeout = globalThis.setTimeout(resolve, 1000)
      }),
    ])
    clearTimeout(timeout)
    clearTimeout(this.#timer)
    this.#disposed = true
    if (this.#queue.length || this.#dropped || this.#inFlightCount) {
      this.#dropped += this.#queue.length + this.#inFlightCount
      this.#queue = []
      this.#diagnostic = { event: 'app.log.unavailable', droppedCount: this.#dropped }
    }
  }
}
