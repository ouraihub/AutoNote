export const GENERATED_AVATAR_PREFIX = 'dicebear:'
export const GENERATED_AVATAR_SEED_LENGTH = 32
export const PROFILE_NAME_MAX_LENGTH = 64
export const AVATAR_SOURCE_FILE_MAX_BYTES = 8 * 1024 * 1024
export const AVATAR_STORED_MAX_BYTES = 128 * 1024
export const AVATAR_PROFILE_BODY_MAX_BYTES = 256 * 1024
const GENERATED_SEED_PATTERN = /^[a-zA-Z0-9_-]{16,64}$/

export function generatedAvatarPreference(seed: string): string {
  return `${GENERATED_AVATAR_PREFIX}${seed}`
}

export function generatedAvatarSeed(value: string | null | undefined): string | null {
  if (!value?.startsWith(GENERATED_AVATAR_PREFIX)) return null
  const seed = value.slice(GENERATED_AVATAR_PREFIX.length)
  return GENERATED_SEED_PATTERN.test(seed) ? seed : null
}

export function isBitmapAvatarDataUrl(value: string | null | undefined): boolean {
  return /^data:image\/(?:png|jpeg|webp);base64,/i.test(value ?? '')
}

export interface StoredAvatarLocation {
  storage: 'r2' | 'kv'
  userId: string
  objectId: string
  extension: 'png' | 'jpg' | 'webp'
  key: string
}

export function parseStoredAvatarUrl(value: string | null | undefined): StoredAvatarLocation | null {
  const match = /^\/api\/avatars\/(r2|kv)\/([0-9a-hjkmnp-tv-z]{26})\/([0-9a-hjkmnp-tv-z]{26})\.(png|jpg|webp)$/.exec(
    value ?? '',
  )
  if (!match) return null
  const storage = match[1] as 'r2' | 'kv'
  const userId = match[2]!
  const objectId = match[3]!
  const extension = match[4] as 'png' | 'jpg' | 'webp'
  return {
    storage,
    userId,
    objectId,
    extension,
    key: `avatars/${userId}/${objectId}.${extension}`,
  }
}
