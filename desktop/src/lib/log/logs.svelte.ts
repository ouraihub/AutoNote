import { tauriClient, type LogsClient } from '../ipc/client'
import type { LogEntry } from '../ipc/types'

export class LogsState {
  entries = $state<LogEntry[]>([])
  loading = $state(false)
  error = $state('')
  onlyProblems = $state(false)
  #generation = 0
  #timer: number | undefined
  #active = false

  constructor(private readonly client: LogsClient = tauriClient) {}

  get visible(): LogEntry[] {
    return (this.onlyProblems
      ? this.entries.filter((entry) => entry.level === 'ERROR' || entry.level === 'WARN')
      : this.entries).toReversed()
  }

  async refresh(): Promise<void> {
    if (this.loading || !this.#active) return
    clearTimeout(this.#timer)
    const generation = this.#generation
    this.loading = true
    try {
      const entries = await this.client.readLogs(300)
      if (generation !== this.#generation) return
      this.entries = entries
      this.error = ''
    } catch {
      if (generation === this.#generation) this.error = '日志读取失败，请重试。'
    } finally {
      if (generation === this.#generation) {
        this.loading = false
        if (this.#active) this.#timer = window.setTimeout(() => void this.refresh(), 2000)
      }
    }
  }

  start(): void {
    if (this.#active) return
    this.#active = true
    void this.refresh()
  }

  stop(): void {
    this.#active = false
    this.#generation++
    this.loading = false
    clearTimeout(this.#timer)
  }
}
