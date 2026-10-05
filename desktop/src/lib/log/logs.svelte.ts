import type { LogEntry } from '../host/desktop-types'

interface LogsClient {
  readLogs(limit: number): Promise<LogEntry[]>
  readAvailability(): Promise<boolean>
}

export class LogsState {
  entries = $state<LogEntry[]>([])
  loading = $state(false)
  error = $state(false)
  available = $state(true)
  onlyProblems = $state(false)
  #generation = 0
  #timer: number | undefined
  #active = false

  constructor(private readonly client: LogsClient) {}

  get visible(): LogEntry[] {
    return (
      this.onlyProblems
        ? this.entries.filter((entry) => entry.level === 'ERROR' || entry.level === 'WARN')
        : this.entries
    ).toReversed()
  }

  async refresh(): Promise<void> {
    if (this.loading || !this.#active) return
    clearTimeout(this.#timer)
    const generation = this.#generation
    this.loading = true
    try {
      const [entries, available] = await Promise.all([this.client.readLogs(300), this.client.readAvailability()])
      if (generation !== this.#generation) return
      this.entries = entries
      this.available = available
      this.error = false
    } catch {
      if (generation === this.#generation) this.error = true
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
