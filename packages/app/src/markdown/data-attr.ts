const PREFIX = 'b64.'

export function encodeDataValue(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (let index = 0; index < bytes.length; index += 0x4000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x4000))
  }
  return `${PREFIX}${btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')}`
}

export function decodeDataValue(value: string | undefined): string {
  if (!value?.startsWith(PREFIX)) return value ?? ''
  try {
    const encoded = value.slice(PREFIX.length).replace(/-/g, '+').replace(/_/g, '/')
    const bytes = Uint8Array.from(atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '=')), (character) =>
      character.charCodeAt(0),
    )
    return new TextDecoder().decode(bytes)
  } catch {
    return ''
  }
}
