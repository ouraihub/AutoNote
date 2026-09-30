import { EN_US_MESSAGES } from './locales/en-US'
import { ZH_CN_MESSAGES } from './locales/zh-CN'
import type { AppLocale } from './types'

export interface WelcomeNoteTemplate {
  locale: AppLocale
  content: string
}

const WELCOME_NOTE_CONTENT: Record<AppLocale, string> = {
  'zh-CN': ZH_CN_MESSAGES['seed.welcome_note'],
  'en-US': EN_US_MESSAGES['seed.welcome_note'],
}

export function welcomeNoteContent(locale: AppLocale): string {
  return WELCOME_NOTE_CONTENT[locale]
}

export function welcomeNoteTemplates(preferredLocale: AppLocale = 'zh-CN'): WelcomeNoteTemplate[] {
  const secondaryLocale: AppLocale = preferredLocale === 'zh-CN' ? 'en-US' : 'zh-CN'
  return [preferredLocale, secondaryLocale].map((locale) => ({
    locale,
    content: welcomeNoteContent(locale),
  }))
}
