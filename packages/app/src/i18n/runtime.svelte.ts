import { EN_US_MESSAGES, type MessageKey } from '@shared/locales/en-US'
import { ZH_CN_MESSAGES } from '@shared/locales/zh-CN'
import type { AppLocale } from '@shared/types'
import type { PrefsStore } from '@app/platform'

export type MessageParams = Readonly<
  Record<string, boolean | number | string | null | undefined>
>
export type LocaleLoader = () => Promise<Readonly<Record<MessageKey, string>>>

export interface I18nLoaders {
  readonly 'en-US': LocaleLoader
  readonly 'zh-CN': LocaleLoader
}

export interface I18nOptions {
  prefs: PrefsStore
  loaders?: I18nLoaders
  systemLocale?: string
}

const LOCALE_PREF_KEY = 'appearance.language'

const DEFAULT_LOADERS: I18nLoaders = {
  'en-US': async () => EN_US_MESSAGES,
  'zh-CN': async () => ZH_CN_MESSAGES,
}

export class I18nState {
  locale = $state<AppLocale>('en-US')
  messages = $state.raw<Readonly<Record<MessageKey, string>>>(EN_US_MESSAGES)
  loaded = $state.raw<Readonly<Record<AppLocale, boolean>>>({
    'en-US': true,
    'zh-CN': false,
  })
  #generation = 0
  #prefs: PrefsStore
  #loaders: I18nLoaders
  #cached: Partial<Record<AppLocale, Readonly<Record<MessageKey, string>>>> = {
    'en-US': EN_US_MESSAGES,
  }
  #systemLocale: string

  constructor(options: I18nOptions) {
    this.#prefs = options.prefs
    this.#loaders = options.loaders ?? DEFAULT_LOADERS
    this.#systemLocale = options.systemLocale ?? readSystemLocale()
  }

  async init(): Promise<void> {
    const saved = await this.#prefs.load(LOCALE_PREF_KEY)
    await this.setLocale(
      isLocale(saved) ? saved : localeFromSystem(this.#systemLocale),
      false,
    )
  }

  async setLocale(locale: AppLocale, persist = true): Promise<void> {
    const generation = ++this.#generation
    if (!this.loaded[locale]) {
      const messages = await this.#loaders[locale]()
      if (generation !== this.#generation) return
      this.messages = messages
      this.#cached[locale] = messages
      this.loaded = { ...this.loaded, [locale]: true }
    } else {
      this.messages = this.#cached[locale] ?? EN_US_MESSAGES
    }
    if (generation !== this.#generation) return

    this.locale = locale
    if (persist) await this.#prefs.save(LOCALE_PREF_KEY, locale)
  }

  t(key: MessageKey, params?: MessageParams): string {
    const template = this.messages[key] ?? EN_US_MESSAGES[key]
    if (!params) return template
    return template.replace(/\{([A-Za-z0-9_]+)\}/g, (whole, name: string) => {
      const value = params[name]
      return value === null || value === undefined ? whole : String(value)
    })
  }

  formatDate(
    value: number | Date,
    options?: Intl.DateTimeFormatOptions,
  ): string {
    return new Intl.DateTimeFormat(this.locale, options).format(value)
  }

  formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
    return new Intl.NumberFormat(this.locale, options).format(value)
  }
}

export function isLocale(value: unknown): value is AppLocale {
  return value === 'en-US' || value === 'zh-CN'
}

function localeFromSystem(locale: string): AppLocale {
  return locale.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US'
}

function readSystemLocale(): string {
  return typeof navigator === 'undefined' ? 'en-US' : navigator.language
}
