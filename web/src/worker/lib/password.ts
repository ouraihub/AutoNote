import { LIMITS } from '@shared/constants'
import {
  hashPasswordValue,
  isPasswordHashValue,
  verifyPasswordValue,
} from './password-hash'


const PASSWORD_MIN_LENGTH = 8
export const PASSWORD_MAX_LENGTH = LIMITS.passwordMaxLength
export const USERNAME_PATTERN = /^[a-z0-9_-]{3,32}$/
const DUMMY_HASH =
  'scrypt$16384$8$5$ABEiM0RVZneImaq7zN3u_w$'
  + 'EzsVp6WklW-qw8-htpRdJyzAeyRHPzojfjgoy1qFiRw'

export function normalizeUsername(raw: string): string {
  return raw.trim().toLowerCase()
}

export function validateNewPassword(password: unknown): string | null {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH) {
    return `Password must contain at least ${PASSWORD_MIN_LENGTH} characters`
  }
  if (password.length > PASSWORD_MAX_LENGTH) return 'Password is too long'
  return null
}

export async function hashPassword(password: string): Promise<string> {
  if (password.length > PASSWORD_MAX_LENGTH)
    throw new Error('password_too_long')
  return hashPasswordValue(password)
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  if (password.length > PASSWORD_MAX_LENGTH) return false
  return verifyPasswordValue(password, stored)
}

export function isPasswordHash(stored: string): boolean {
  return isPasswordHashValue(stored)
}

export async function dummyVerify(): Promise<void> {
  await verifyPassword('definitely-not-the-password', DUMMY_HASH)
}
