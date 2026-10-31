import { DEFAULT_SETTINGS } from '@shared/constants'
import { PROFILE_NAME_MAX_LENGTH } from '@shared/avatar'
import type { AppLocale, UserSettings } from '@shared/types'

export function normalizeLocale(value: unknown): AppLocale {
  return typeof value === 'string' && value.toLowerCase().startsWith('en')
    ? 'en-US'
    : 'zh-CN'
}

export function normalizeDisplayName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().replace(/\s+/gu, ' ')
  if (
    !normalized ||
    [...normalized].length > PROFILE_NAME_MAX_LENGTH ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(normalized)
  ) {
    return null
  }
  return normalized
}

export function settingsFor(locale: AppLocale): UserSettings {
  return {
    ...DEFAULT_SETTINGS,
    appearance: { ...DEFAULT_SETTINGS.appearance, language: locale },
    editor: { ...DEFAULT_SETTINGS.editor },
    preview: { ...DEFAULT_SETTINGS.preview },
    backup: { ...DEFAULT_SETTINGS.backup },
    sync: { ...DEFAULT_SETTINGS.sync },
  }
}
