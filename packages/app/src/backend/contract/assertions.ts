import type { ErrorCode } from '@shared/backend-types'
import { isBackendError, type BackendError } from '../errors'

export class BackendContractFailure extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(`Backend contract failed: ${message}`, options)
    this.name = 'BackendContractFailure'
  }
}

export function expect(condition: boolean, message: string): asserts condition {
  if (!condition) throw new BackendContractFailure(message)
}

export function expectEqual<T>(actual: T, expected: T, message: string): void {
  if (Object.is(actual, expected)) return
  throw new BackendContractFailure(`${message}; expected ${describe(expected)}, received ${describe(actual)}`)
}

export function expectIncludes(values: readonly string[], expected: string, message: string): void {
  if (!values.includes(expected)) throw new BackendContractFailure(`${message}; missing ${expected}`)
}

export function expectExcludes(values: readonly string[], unexpected: string, message: string): void {
  if (values.includes(unexpected)) throw new BackendContractFailure(`${message}; unexpected ${unexpected}`)
}

export function expectDefined<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new BackendContractFailure(message)
  return value
}

export async function expectBackendError(
  operation: Promise<unknown>,
  code: ErrorCode,
  message: string,
): Promise<BackendError> {
  let outcome: unknown
  try {
    outcome = await operation
  } catch (error) {
    if (isBackendError(error) && error.code === code) return error
    throw new BackendContractFailure(`${message}; expected BackendError(${code}), received ${describeError(error)}`, {
      cause: error,
    })
  }
  throw new BackendContractFailure(`${message}; expected BackendError(${code}), received ${describe(outcome)}`)
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function describeError(error: unknown): string {
  if (isBackendError(error)) return `BackendError(${error.code}): ${error.message}`
  return error instanceof Error ? `${error.name}: ${error.message}` : describe(error)
}

function describe(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (value === undefined) return 'undefined'
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}
