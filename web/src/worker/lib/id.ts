


const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'

export function newId(): string {
  let ts = ''
  let n = Date.now()
  for (let i = 0; i < 10; i++) {
    ts = ALPHABET[n % 32] + ts
    n = Math.floor(n / 32)
  }
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  let rand = ''
  for (let i = 0; i < 16; i++) rand += ALPHABET[bytes[i]! & 31]
  return ts + rand
}


export function newSlug(): string {
  const bytes = new Uint8Array(20)
  crypto.getRandomValues(bytes)
  let out = ''
  for (let i = 0; i < bytes.length; i++) out += ALPHABET[bytes[i]! & 31]
  return out
}

const SLUG_RE = /^[0-9a-hjkmnp-tv-z]{20}$/
export function isValidSlug(value: unknown): value is string {
  return typeof value === 'string' && SLUG_RE.test(value)
}


export function idTime(id: string): number {
  let n = 0
  for (let i = 0; i < 10 && i < id.length; i++) {
    const idx = ALPHABET.indexOf(id[i]!)
    if (idx < 0) return 0
    n = n * 32 + idx
  }
  return n
}

const ID_RE = /^[0-9a-hjkmnp-tv-z]{26}$/
export function isValidId(id: unknown): id is string {
  return typeof id === 'string' && ID_RE.test(id)
}
