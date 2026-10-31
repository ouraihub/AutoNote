import type { Env } from '../env'
import { ApiError } from './errors'
import { isValidId } from './id'
import { decryptCredential, encryptCredential } from './crypto-vault'
import { isBackupCredentialRecord, readObjectString } from './crypto-guards'
export { CryptoUnavailableError } from './crypto-vault'
export async function encryptSecret(
  env: Env,
  info: string,
  value: unknown,
): Promise<string> {
  if (!isValidId(info)) throw new Error('invalid_credential_scope')
  return encryptCredential(env, `backup:${info}`, value)
}

export async function decryptSecret<T>(
  env: Env,
  info: string,
  stored: string,
): Promise<T | null> {
  if (!isValidId(info) || stored.length > 24 * 1024) return null
  const value = await decryptCredential(env, `backup:${info}`, stored)
  return isBackupCredentialRecord(value) ? value as T : null
}

export async function encryptTotpSecret(
  env: Env,
  userId: string,
  secret: string,
): Promise<string> {
  if (!isValidId(userId) || !/^[A-Z2-7]{32}$/.test(secret)) {
    throw new Error('invalid_totp_credential')
  }
  return encryptCredential(env, `totp:${userId}`, { secret })
}

export async function encryptAiKey(
  env: Env,
  scopeId: string,
  apiKey: string,
): Promise<string> {
  if (!isValidId(scopeId) || !apiKey || apiKey.length > 4096)
    throw ApiError.badRequest('Invalid API key')
  return encryptCredential(env, `ai-endpoint:${scopeId}`, { apiKey })
}

export async function decryptAiKey(
  env: Env,
  scopeId: string,
  stored: string,
): Promise<string | null> {
  if (!isValidId(scopeId) || stored.length > 24 * 1024) return null
  const value = await decryptCredential(env, `ai-endpoint:${scopeId}`, stored)
  const key = readObjectString(value, 'apiKey')
  return key && key.length <= 4096 ? key : null
}

export async function decryptTotpSecret(
  env: Env,
  userId: string,
  stored: string,
): Promise<string | null> {
  if (!isValidId(userId) || stored.length > 24 * 1024) return null
  const value = await decryptCredential(env, `totp:${userId}`, stored)
  const secret = readObjectString(value, 'secret')
  return secret && /^[A-Z2-7]{32}$/.test(secret) ? secret : null
}
