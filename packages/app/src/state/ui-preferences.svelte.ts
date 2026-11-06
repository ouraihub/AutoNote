import type { UiDensity } from '@shared/types'
import { isBackendError } from '@app/backend'
import type { Logger } from '@app/log/logger'
import type { Notifier, PrefsStore, PrefValue } from '@app/platform'
import type { ThemeAppearance } from '@app/theme'
import {
  DEFAULT_LAYOUT_PREFS,
  LAYOUT_PREF_KEY,
  layoutPrefsValue,
  parseLayoutPrefs,
  type LayoutPrefs,
} from './layout-prefs'
import { CoalescingPrefsWriter } from './prefs-writer'
import type { LayoutResize, UiStateOptions } from './ui.svelte'

const SAVE_FAILED_TOAST_ID = 'ui.prefs.save_failed'

export class UiPreferences {
  #layout = $state.raw<LayoutPrefs>(DEFAULT_LAYOUT_PREFS)
  #layoutLoad: Promise<void> | null = null
  #isLayoutTouched = false
  #hasReportedSaveFailure = false
  readonly #prefs: PrefsStore
  readonly #logger: Logger
  readonly #notifier: Notifier
  readonly #writer = new CoalescingPrefsWriter((key, value) =>
    this.#write(key, value),
  )

  constructor(options: UiStateOptions) {
    this.#prefs = options.prefs
    this.#logger = options.logger
    this.#notifier = options.notifier
  }

  get layout(): LayoutPrefs {
    return this.#layout
  }

  async loadLayout(): Promise<void> {
    this.#layoutLoad ??= this.read(LAYOUT_PREF_KEY).then((stored) => {
      if (!this.#isLayoutTouched) this.#layout = parseLayoutPrefs(stored)
    })
    await this.#layoutLoad
  }

  async read(key: string): Promise<unknown> {
    try {
      return await this.#prefs.load(key)
    } catch (error) {
      if (!isBackendError(error)) throw error
      this.#logger.warn('ui.prefs.load_failed', {
        key,
        code: error.code,
      })
      return undefined
    }
  }

  async flush(): Promise<void> {
    await this.#writer.flush()
  }

  schedule(key: string, value: PrefValue): void {
    this.#writer.schedule(key, value)
  }

  resize(patch: LayoutResize): void {
    const current = this.#layout
    const next = parseLayoutPrefs({ ...current, ...patch })
    if (
      next.navWidth === current.navWidth &&
      next.listWidth === current.listWidth &&
      next.assistWidth === current.assistWidth &&
      next.splitRatio === current.splitRatio &&
      next.workspaceSplitRatio === current.workspaceSplitRatio
    )
      return
    this.#persistLayout(next)
  }

  toggleNav(): void {
    this.#persistLayout({
      ...this.#layout,
      navCollapsed: !this.#layout.navCollapsed,
    })
  }

  toggleList(): void {
    this.#persistLayout({
      ...this.#layout,
      listCollapsed: !this.#layout.listCollapsed,
    })
  }

  toggleAssist(open = !this.#layout.assistOpen): void {
    if (open !== this.#layout.assistOpen)
      this.#persistLayout({ ...this.#layout, assistOpen: open })
  }

  setDensity(density: UiDensity): void {
    if (density === this.#layout.density) return
    this.#persistLayout({ ...this.#layout, density })
  }

  applyAppearance(appearance: ThemeAppearance): void {
    const current = this.#layout.appearance
    if (
      appearance.theme === current.theme &&
      appearance.accent === current.accent &&
      appearance.background === current.background
    )
      return
    const next = {
      theme: appearance.theme,
      accent: appearance.accent,
      background: appearance.background,
    }
    this.#persistLayout({ ...this.#layout, appearance: next })
  }

  #persistLayout(next: LayoutPrefs): void {
    this.#isLayoutTouched = true
    this.#layout = next
    this.#writer.schedule(LAYOUT_PREF_KEY, layoutPrefsValue(next))
  }

  async #write(key: string, value: PrefValue): Promise<void> {
    try {
      await this.#prefs.save(key, value)
      this.#hasReportedSaveFailure = false
    } catch (error) {
      if (!isBackendError(error)) throw error
      this.#logger.warn('ui.prefs.save_failed', {
        key,
        code: error.code,
      })
      if (!this.#hasReportedSaveFailure) {
        this.#hasReportedSaveFailure = true
        this.#notifier.toast({
          id: SAVE_FAILED_TOAST_ID,
          key: 'shell.layout_preferences_not_saved',
          tone: 'warning',
        })
      }
      throw error
    }
  }
}
