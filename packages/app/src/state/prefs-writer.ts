import type { PrefValue } from '@app/platform'

export type PrefSave = (key: string, value: PrefValue) => Promise<void>

interface PendingWrite {
  value: PrefValue
  isDirty: boolean
  running: Promise<void> | null
  error: unknown
}

export class CoalescingPrefsWriter {
  readonly #save: PrefSave
  readonly #writes = new Map<string, PendingWrite>()

  constructor(save: PrefSave) {
    this.#save = save
  }

  schedule(key: string, value: PrefValue): void {
    const write = this.#writes.get(key) ?? {
      value,
      isDirty: false,
      running: null,
      error: null,
    }
    write.value = value
    write.isDirty = true
    write.error = null
    this.#writes.set(key, write)
    write.running ??= this.#drain(key, write)
  }

  async flush(): Promise<void> {
    for (const [key, write] of this.#writes) {
      if (write.isDirty) write.running ??= this.#drain(key, write)
    }
    await Promise.all([...this.#writes.values()].map((write) => write.running))
    const failed = [...this.#writes.values()].find(
      (write) => write.error !== null,
    )
    if (failed) throw failed.error
  }

  async #drain(key: string, write: PendingWrite): Promise<void> {
    try {
      while (write.isDirty) {
        write.isDirty = false
        try {
          await this.#save(key, write.value)
          write.error = null
        } catch (error) {
          write.isDirty = true
          write.error = error
          return
        }
      }
    } finally {
      write.running = null
    }
  }
}
