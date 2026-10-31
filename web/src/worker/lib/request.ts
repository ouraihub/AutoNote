import { assertDeclaredBodySize } from './request-validation'
import { LIMITS } from '@shared/constants'
import { ApiError } from './errors'
import { readBytesWithinLimit, readTextWithinLimit } from './request-body'
export {
  assertContentSize,
  clampInt,
  requestClientIp,
} from './request-validation'

export const JSON_BODY_LIMITS = {
  small: 8 * 1024,
  settings: 16 * 1024,
  backup: 32 * 1024,
  profile: 256 * 1024,
  note: LIMITS.contentMaxBytes * 6 + 64 * 1024,
  run: 24 * 1024 * 1024,
} as const

export const FORM_BODY_LIMITS = {
  authorization: 16 * 1024,
  attachment: LIMITS.attachmentMaxBytes + 512 * 1024,
  import: LIMITS.importUploadMaxBytes + 1024 * 1024,
} as const

export async function readJson<T>(
  c: {
    req: {
      json: () => Promise<unknown>
      text: () => Promise<string>
      raw?: Request
      header?: (name: string) => string | undefined
    }
  },
  maxBytes?: number,
): Promise<T> {
  if (maxBytes) assertDeclaredBodySize(c.req, maxBytes)
  let value: unknown
  try {
    if (maxBytes) {
      const text = await readTextWithinLimit(c.req, maxBytes)
      value = JSON.parse(text) as unknown
    } else {
      value = await c.req.json()
    }
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw ApiError.badRequest('The request body is not valid JSON')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw ApiError.badRequest('The request body must be a JSON object')
  }
  return value as T
}

export async function readFormDataWithinLimit(
  req: {
    raw?: Request
    header?: (name: string) => string | undefined
  },
  maxBytes: number,
): Promise<FormData> {
  assertDeclaredBodySize(req, maxBytes)
  const contentType =
    req.header?.('Content-Type') ?? req.raw?.headers.get('Content-Type') ?? ''
  if (!/^multipart\/form-data(?:\s*;|$)/i.test(contentType)) {
    throw ApiError.badRequest('The request body must use multipart/form-data')
  }

  const bytes = await readBytesWithinLimit(req.raw?.body, maxBytes)
  try {
    return await new Request('https://autonote.invalid/upload', {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body: bytes as BodyInit,
    }).formData()
  } catch {
    throw ApiError.badRequest('The upload form is invalid')
  }
}

export async function readUrlEncodedFormWithinLimit(
  req: {
    raw?: Request
    header?: (name: string) => string | undefined
  },
  maxBytes: number,
): Promise<URLSearchParams> {
  assertDeclaredBodySize(req, maxBytes)
  const contentType =
    req.header?.('Content-Type') ?? req.raw?.headers.get('Content-Type') ?? ''
  if (!/^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(contentType)) {
    throw ApiError.badRequest(
      'The request body must use application/x-www-form-urlencoded',
    )
  }
  const bytes = await readBytesWithinLimit(req.raw?.body, maxBytes)
  return new URLSearchParams(new TextDecoder().decode(bytes))
}

export function readOptionalJson<T extends object>(
  c: Parameters<typeof readJson<T>>[0],
  maxBytes: number,
  fallback: T,
): Promise<T> {
  const declared = c.req.header?.('Content-Length')
  if (c.req.raw?.body == null || declared === '0')
    return Promise.resolve(fallback)
  return readJson<T>(c, maxBytes)
}
