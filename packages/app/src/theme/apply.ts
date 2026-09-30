import type { AccentName, BackgroundName, ThemePref } from '@shared/types'

export interface ThemeAppearance {
  theme: ThemePref
  accent: AccentName
  background: BackgroundName
}

export interface MediaQueryLike {
  matches: boolean
  addEventListener(type: 'change', listener: () => void): void
  removeEventListener(type: 'change', listener: () => void): void
}

export interface ThemeDocument {
  documentElement: HTMLElement
}

export function resolveTheme(theme: ThemePref, prefersDark: boolean): 'light' | 'dark' {
  return theme === 'system' ? (prefersDark ? 'dark' : 'light') : theme
}

export function applyTheme(document: ThemeDocument, appearance: ThemeAppearance, prefersDark: boolean): void {
  const root = document.documentElement
  root.dataset.theme = resolveTheme(appearance.theme, prefersDark)
  root.dataset.accent = appearance.accent
  root.dataset.background = appearance.background
}

export class ThemeController {
  #appearance: ThemeAppearance
  #document: ThemeDocument
  #darkMedia: MediaQueryLike
  #reducedMotionMedia: MediaQueryLike
  #disposed = false
  #onDarkChanged = () => this.apply()
  #onReducedMotionChanged = () => this.applyMotion()

  constructor(
    document: ThemeDocument,
    appearance: ThemeAppearance,
    darkMedia: MediaQueryLike,
    reducedMotionMedia: MediaQueryLike,
  ) {
    this.#document = document
    this.#appearance = appearance
    this.#darkMedia = darkMedia
    this.#reducedMotionMedia = reducedMotionMedia
    this.#darkMedia.addEventListener('change', this.#onDarkChanged)
    this.#reducedMotionMedia.addEventListener('change', this.#onReducedMotionChanged)
    this.apply()
  }

  setAppearance(appearance: ThemeAppearance): void {
    if (this.#disposed) return
    this.#appearance = appearance
    this.apply()
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#darkMedia.removeEventListener('change', this.#onDarkChanged)
    this.#reducedMotionMedia.removeEventListener('change', this.#onReducedMotionChanged)
  }

  private apply(): void {
    applyTheme(this.#document, this.#appearance, this.#darkMedia.matches)
    this.applyMotion()
  }

  private applyMotion(): void {
    this.#document.documentElement.dataset.motion = this.#reducedMotionMedia.matches ? 'reduced' : 'full'
  }
}
