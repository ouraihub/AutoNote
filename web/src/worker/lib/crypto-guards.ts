export function isBackupCredentialRecord(
  value: unknown,
): value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const allowed: Record<string, true> = {
    password: true,
    accessKeyId: true,
    secretAccessKey: true,
  }
  const entries = Object.entries(value)
  return (
    entries.length > 0 &&
    entries.length <= 3 &&
    entries.every(
      ([key, field]) =>
        allowed[key] === true &&
        typeof field === 'string' &&
        field.length > 0 &&
        field.length <= 4096,
    )
  )
}

export function readObjectString(value: unknown, key: string): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const field = (value as Record<string, unknown>)[key]
  return typeof field === 'string' ? field : null
}
