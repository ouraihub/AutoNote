// `generate_image` tool (Aether docs/20): spec and an OpenAI-compatible `/images/generations` client.
import { KitFailure, addressAllowed, at, badRequest, cancelled, parseTarget, readUpTo, upstreamFailure } from './kit'
import { MAX_IMAGE_BYTES, encode } from './images'
import type { ImagePart, ToolSpec } from './protocol'
import type { Connection } from './providers'

export const GENERATE_IMAGE = 'generate_image'
const SIZES = ['1024x1024', '1024x1536', '1536x1024'] as const
const TIMEOUT_MS = 120_000
const RESPONSE_BYTES = 8 * 1024 * 1024

export const GENERATE_IMAGE_SPEC: ToolSpec = {
  name: GENERATE_IMAGE,
  description: 'Generate one image from a detailed English or Chinese prompt. Use only when the user asks for a picture, drawing, illustration or photo.',
  parameters: {
    type: 'object',
    properties: {
      prompt: { type: 'string', minLength: 1, maxLength: 4000, description: 'What to draw.' },
      size: { type: 'string', enum: SIZES },
    },
    required: ['prompt'],
    additionalProperties: false,
  },
}

function mimeOf(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg'
  if (String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP') return 'image/webp'
  return 'image/png'
}

async function allowed(db: D1Database, raw: string): Promise<URL> {
  const url = parseTarget(raw)
  if (!(await addressAllowed(db, url))) throw badRequest('url', 'blocked_address')
  return url
}

/** Validates the model's arguments and calls the painting model once. */
export async function generateImage(db: D1Database, painting: Connection, args: Record<string, unknown>, signal: AbortSignal): Promise<ImagePart> {
  const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
  if (!prompt || [...prompt].length > 4000) throw badRequest('prompt', 'invalid')
  const size = args.size == null ? SIZES[0] : SIZES.find((item) => item === args.size)
  if (!size) throw badRequest('size', 'invalid')
  const known = painting.apiKey ? [painting.apiKey] : []
  const timeout = AbortSignal.timeout(TIMEOUT_MS)
  const call = async (url: URL, init: RequestInit): Promise<Response> => {
    try {
      return await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.any([signal, timeout]) })
    } catch {
      if (signal.aborted) throw cancelled()
      if (timeout.aborted) throw new KitFailure('timeout', 'painting timeout', { reason: 'painting' })
      throw new KitFailure('network', 'painting model unreachable')
    }
  }
  const response = await call(await allowed(db, `${painting.baseUrl}/images/generations`), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(painting.apiKey ? { authorization: `Bearer ${painting.apiKey}` } : {}) },
    // No `response_format`: gpt-image-* rejects it (always b64); others may answer `url`, handled below.
    body: JSON.stringify({ model: painting.modelId, prompt, size, n: 1 }),
  })
  const { bytes: raw, overflow } = await readUpTo(response.body, RESPONSE_BYTES)
  const text = new TextDecoder().decode(raw)
  if (!response.ok) throw upstreamFailure(response.status, text, known)
  if (overflow) throw badRequest('images', 'size', MAX_IMAGE_BYTES)
  let body: unknown = null
  try { body = JSON.parse(text) } catch { /* no image below */ }
  const b64 = at(body, 'data', 0, 'b64_json'), link = at(body, 'data', 0, 'url')
  let bytes: Uint8Array
  if (typeof b64 === 'string') {
    try { bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)) } catch { throw badRequest('images', 'encoding') }
  } else if (typeof link === 'string') {
    const image = await call(await allowed(db, link), {})
    if (!image.ok) throw upstreamFailure(image.status, '', known)
    const read = await readUpTo(image.body, MAX_IMAGE_BYTES)
    if (read.overflow) throw badRequest('images', 'size', MAX_IMAGE_BYTES)
    bytes = read.bytes
  } else throw upstreamFailure(response.status, 'no image in response', known)
  if (bytes.length > MAX_IMAGE_BYTES) throw badRequest('images', 'size', MAX_IMAGE_BYTES)
  return { mime: mimeOf(bytes), data: encode(bytes) }
}
