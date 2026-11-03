import { createAvatar } from '@dicebear/core'
import * as micah from '@dicebear/micah'
import {
  generatedAvatarSeed,
  isBitmapAvatarDataUrl,
  parseStoredAvatarUrl,
  presetAvatarIndex,
} from '@shared/avatar'

const PRESET_AVATARS = import.meta.glob<string>('../assets/avatars/*.webp', {
  eager: true,
  query: '?url',
  import: 'default',
})

export function presetAvatarUrl(index: number): string | undefined {
  return PRESET_AVATARS[
    `../assets/avatars/${String(index).padStart(2, '0')}.webp`
  ]
}

const BACKGROUND_COLORS = [
  'f87171',
  'fb923c',
  '09acf4',
  'fb923c',
  'f472b6',
  'a78bfa',
  '34d399',
]
const BASE_COLORS = ['f7e1c3', 'f9c9b6', 'f2d6cb', 'f8ce8e', 'eac393']
const AVATAR_CACHE_LIMIT = 160
const avatarCache = new Map<string, string>()

export function avatarBackgroundColor(seed: string): string {
  let hash = 0
  for (let index = 0; index < seed.length; index++)
    hash = seed.charCodeAt(index) + ((hash << 5) - hash)
  return (
    BACKGROUND_COLORS[Math.abs(hash) % BACKGROUND_COLORS.length] ??
    BACKGROUND_COLORS[0]!
  )
}

export function createAvatarDataUri(seed: string): string {
  const normalizedSeed = seed.trim() || '?'
  const cached = avatarCache.get(normalizedSeed)
  if (cached) return cached
  const uri = createAvatar(micah, {
    seed: normalizedSeed,
    baseColor: BASE_COLORS,
    backgroundColor: [avatarBackgroundColor(normalizedSeed)],
  }).toDataUri()
  if (avatarCache.size >= AVATAR_CACHE_LIMIT) {
    const oldest = avatarCache.keys().next().value
    if (oldest !== undefined) avatarCache.delete(oldest)
  }
  avatarCache.set(normalizedSeed, uri)
  return uri
}

export function resolveAvatarSource(
  preference: string | null | undefined,
  displayName: string,
): string {
  if (
    preference &&
    (isBitmapAvatarDataUrl(preference) || parseStoredAvatarUrl(preference))
  )
    return preference
  const preset = presetAvatarIndex(preference)
  const presetUrl = preset === null ? undefined : presetAvatarUrl(preset)
  if (presetUrl) return presetUrl
  return createAvatarDataUri(generatedAvatarSeed(preference) ?? displayName)
}
