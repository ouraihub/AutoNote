import { LIMITS } from '@shared/constants'
import { ApiError } from './errors'

export function assertDeclaredBodySize(
  req: { header?: (name: string) => string | undefined },
  maxBytes: number,
): void {
  if (!req.header) return
  const raw = req.header('Content-Length')
  if (raw === undefined) return
  const declared = Number(raw)
  if (Number.isFinite(declared) && declared >= 0 && declared > maxBytes)
    throw ApiError.tooLarge('The request body is too large')
}

export function requestClientIp(c: {
  req: { header: (name: string) => string | undefined; raw?: Request }
}): string {
  const value = c.req.header('CF-Connecting-IP')?.trim().toLowerCase()
  if (!value) return 'local'
  // CF-Connecting-IP is injected by the Cloudflare edge and cannot be
  // spoofed there. On any other runtime the header is client-controlled,
  // so ignore it rather than trusting it for throttling.
  if (!c.req.raw || !(c.req.raw as Request & { cf?: unknown }).cf)
    return 'local'
  return value.replace(/[^a-f0-9:.%-]/g, '').slice(0, 64) || 'unknown'
}

export function clampInt(
  raw: string | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw)
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

export function assertContentSize(content: string): void {
  if (new TextEncoder().encode(content).byteLength > LIMITS.contentMaxBytes)
    throw ApiError.tooLarge('Note content exceeds the 2 MB limit')
}
