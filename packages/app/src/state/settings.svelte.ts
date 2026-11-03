import {
  DEFAULT_SETTINGS,
  mergeSettings,
  mergeSettingsPatch,
} from '@shared/constants'
import type { ErrorCode, SettingsPatch } from '@shared/backend-types'
import type { UserSettings } from '@shared/types'
import {
  BackendError,
  isBackendError,
  type CallOptions,
  type SettingsPort,
} from '@app/backend'
import type { Logger } from '@app/log/logger'
import type { Notifier } from '@app/platform'

export type SettingsSaveStatus = 'idle' | 'scheduled' | 'saving' | 'retrying'

export interface SettingsStateOptions {
  port: SettingsPort
  notifier: Notifier
  logger: Logger
  saveDelayMs?: number
}

export interface SettingsUpdateOptions {
  silent?: boolean
}

export const SETTINGS_SAVE_DELAY_MS = 420
export const SETTINGS_RETRY_BASE_MS = 1_500
export const SETTINGS_RETRY_MAX_MS = 30_000

type SettingsSection = keyof SettingsPatch
const SETTINGS_SECTIONS: Readonly<Record<SettingsSection, true>> = {
  appearance: true,
  editor: true,
  preview: true,
  backup: true,
  sync: true,
}

export class SettingsState {
  #persisted = $state.raw<UserSettings>(mergeSettings(DEFAULT_SETTINGS))
  #pendingPatch = $state.raw<SettingsPatch | null>(null)
  #inFlightPatch = $state.raw<SettingsPatch | null>(null)
  #error = $state.raw<ErrorCode | null>(null)
  #status = $state<SettingsSaveStatus>('idle')
  #outstanding = $derived(mergePatches(this.#inFlightPatch, this.#pendingPatch))
  #current = $derived(
    this.#outstanding
      ? mergeSettingsPatch(this.#persisted, this.#outstanding)
      : this.#persisted,
  )

  #port: SettingsPort
  #notifier: Notifier
  #logger: Logger
  #saveDelayMs: number
  #owner: string | null = null
  #epoch = 0
  #sequence = 0
  #cancelTimer: (() => void) | null = null
  #retryDelayMs = SETTINGS_RETRY_BASE_MS
  #shouldNotify = false
  #inFlight: Promise<void> | null = null

  constructor(options: SettingsStateOptions) {
    this.#port = options.port
    this.#notifier = options.notifier
    this.#logger = options.logger
    this.#saveDelayMs = options.saveDelayMs ?? SETTINGS_SAVE_DELAY_MS
  }

  get persisted(): UserSettings {
    return this.#persisted
  }

  get current(): UserSettings {
    return this.#current
  }

  get pendingPatch(): SettingsPatch | null {
    return this.#outstanding
  }

  get error(): ErrorCode | null {
    return this.#error
  }

  get status(): SettingsSaveStatus {
    return this.#status
  }

  adopt(owner: string | null, remote: UserSettings | null): void {
    if (owner !== this.#owner) this.#reset(owner)
    this.#sequence++
    this.#persisted = mergeSettings(remote ?? {})
  }

  async load(options?: CallOptions): Promise<void> {
    const epoch = this.#epoch
    const sequence = ++this.#sequence
    try {
      const remote = await this.#port.get(options)
      if (epoch !== this.#epoch || sequence !== this.#sequence) return
      this.#persisted = mergeSettings(remote)
    } catch (error) {
      if (!isBackendError(error)) throw error
      if (
        epoch !== this.#epoch ||
        sequence !== this.#sequence ||
        error.code === 'cancelled'
      )
        return
      this.#error = error.code
      this.#logger.warn('settings.load.failed', { code: error.code })
    }
  }

  update(patch: SettingsPatch, options?: SettingsUpdateOptions): void {
    if (Object.keys(patch).length === 0) return
    assertValidPatch(this.#current, patch)
    this.#pendingPatch = mergePatches(this.#pendingPatch, patch)
    this.#shouldNotify ||= options?.silent !== true
    this.#schedule(this.#saveDelayMs)
  }

  async flush(): Promise<boolean> {
    this.#clearTimer()
    if (this.#inFlight) await this.#inFlight
    this.#clearTimer()
    if (this.#pendingPatch) await this.#save()
    return this.#outstanding === null
  }

  dispose(): void {
    this.#clearTimer()
    this.#epoch++
    this.#sequence++
    this.#inFlight = null
    this.#refreshStatus()
  }

  #reset(owner: string | null): void {
    const discarded = this.#outstanding
    if (discarded)
      this.#logger.warn('settings.pending.discarded', {
        sections: Object.keys(discarded).length,
      })
    this.#clearTimer()
    this.#owner = owner
    this.#epoch++
    this.#pendingPatch = null
    this.#inFlightPatch = null
    this.#inFlight = null
    this.#error = null
    this.#shouldNotify = false
    this.#retryDelayMs = SETTINGS_RETRY_BASE_MS
    this.#refreshStatus()
  }

  #schedule(delayMs: number): void {
    this.#clearTimer()
    const handle = setTimeout(() => {
      this.#cancelTimer = null
      void this.#save()
    }, delayMs)
    this.#cancelTimer = () => clearTimeout(handle)
    this.#refreshStatus()
  }

  #clearTimer(): void {
    if (!this.#cancelTimer) return
    this.#cancelTimer()
    this.#cancelTimer = null
    this.#refreshStatus()
  }

  #refreshStatus(): void {
    if (this.#inFlight) this.#status = 'saving'
    else if (this.#cancelTimer)
      this.#status = this.#error ? 'retrying' : 'scheduled'
    else this.#status = 'idle'
  }

  async #save(): Promise<void> {
    const outgoing = this.#pendingPatch
    if (this.#inFlight || !outgoing) return
    const shouldNotify = this.#shouldNotify
    this.#pendingPatch = null
    this.#shouldNotify = false
    this.#inFlightPatch = outgoing
    const task = this.#send(
      outgoing,
      shouldNotify,
      this.#epoch,
      ++this.#sequence,
    )
    this.#inFlight = task
    this.#refreshStatus()
    await task
  }

  async #send(
    outgoing: SettingsPatch,
    shouldNotify: boolean,
    epoch: number,
    sequence: number,
  ): Promise<void> {
    let saved: UserSettings
    try {
      saved = await this.#port.save(outgoing)
    } catch (error) {
      if (epoch !== this.#epoch) return
      this.#settle()
      this.#pendingPatch = mergePatches(outgoing, this.#pendingPatch)
      this.#shouldNotify ||= shouldNotify
      if (!isBackendError(error)) {
        this.#refreshStatus()
        throw error
      }
      this.#error = error.code
      this.#logger.warn('settings.save.failed', {
        code: error.code,
        retryInMs: this.#retryDelayMs,
      })
      if (shouldNotify) {
        this.#notifier.toast({
          id: 'settings-save-failed',
          key: 'session.could_not_save_settings',
          tone: 'error',
        })
        this.#shouldNotify = false
      }
      this.#schedule(this.#retryDelayMs)
      this.#retryDelayMs = Math.min(
        SETTINGS_RETRY_MAX_MS,
        this.#retryDelayMs * 2,
      )
      return
    }
    if (epoch !== this.#epoch) return
    this.#settle()
    this.#retryDelayMs = SETTINGS_RETRY_BASE_MS
    this.#error = null
    this.#persisted =
      sequence === this.#sequence
        ? mergeSettings(saved)
        : mergeSettingsPatch(this.#persisted, outgoing)
    if (this.#pendingPatch && !this.#cancelTimer) this.#schedule(0)
    else this.#refreshStatus()
  }

  #settle(): void {
    this.#inFlightPatch = null
    this.#inFlight = null
  }
}

function mergePatches(
  first: SettingsPatch | null,
  second: SettingsPatch | null,
): SettingsPatch | null {
  if (!first) return second
  if (!second) return first
  const merged: SettingsPatch = {}
  if (first.appearance || second.appearance)
    merged.appearance = { ...first.appearance, ...second.appearance }
  if (first.editor || second.editor)
    merged.editor = { ...first.editor, ...second.editor }
  if (first.preview || second.preview)
    merged.preview = { ...first.preview, ...second.preview }
  if (first.backup || second.backup)
    merged.backup = { ...first.backup, ...second.backup }
  if (first.sync || second.sync) merged.sync = { ...first.sync, ...second.sync }
  return merged
}

function assertValidPatch(base: UserSettings, patch: SettingsPatch): void {
  const candidate = mergeSettingsPatch(base, patch)
  for (const [section, values] of Object.entries(patch)) {
    if (
      !isSettingsSection(section) ||
      values === null ||
      typeof values !== 'object' ||
      Array.isArray(values)
    ) {
      throw new BackendError('bad_request', 0, 'Invalid settings patch')
    }
    const accepted: Readonly<Record<string, unknown>> = Object.fromEntries(
      Object.entries(candidate[section]),
    )
    for (const [key, value] of Object.entries(values)) {
      if (!Object.hasOwn(accepted, key) || !Object.is(accepted[key], value)) {
        throw new BackendError('bad_request', 0, 'Invalid settings patch')
      }
    }
  }
}

function isSettingsSection(value: string): value is SettingsSection {
  return Object.hasOwn(SETTINGS_SECTIONS, value)
}
