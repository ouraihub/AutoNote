import { scrypt as nodeScrypt } from 'node:crypto'
import { fromBase64Url, timingSafeEqual, toBase64Url } from './encoding'

export const SCRYPT_N = 2 ** 14
export const SCRYPT_R = 8
export const SCRYPT_P = 5
const KEY_BYTES = 32
const MAX_MEMORY = 32 * 1024 * 1024
const HASH_PATTERN =
  /^scrypt\$16384\$8\$5\$([A-Za-z0-9_-]{22})\$([A-Za-z0-9_-]{43})$/

export async function hashPasswordValue(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const hash = await deriveScrypt(password, salt)
  return [
    'scrypt',
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    toBase64Url(salt),
    toBase64Url(hash),
  ].join('$')
}

export async function verifyPasswordValue(
  password: string,
  stored: string,
): Promise<boolean> {
  const parsed = parsePasswordHash(stored)
  if (!parsed) return false
  try {
    const actual = await deriveScrypt(password, parsed.salt)
    return timingSafeEqual(toBase64Url(actual), parsed.expected)
  } catch {
    return false
  }
}

export function isPasswordHashValue(stored: string): boolean {
  return parsePasswordHash(stored) !== null
}

function parsePasswordHash(
  stored: string,
): { salt: Uint8Array; expected: string } | null {
  if (stored.length > 160) return null
  const match = HASH_PATTERN.exec(stored)
  if (!match) return null
  try {
    const salt = fromBase64Url(match[1]!)
    const expectedBytes = fromBase64Url(match[2]!)
    if (
      salt.byteLength !== 16 ||
      expectedBytes.byteLength !== KEY_BYTES
    ) return null
    return { salt, expected: match[2]! }
  } catch {
    return null
  }
}

function deriveScrypt(password: string, salt: Uint8Array): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    nodeScrypt(
      password,
      salt,
      KEY_BYTES,
      { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: MAX_MEMORY },
      (error, derived) => (error ? reject(error) : resolve(derived)),
    )
  })
}
