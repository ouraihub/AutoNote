// `generate_image` tool (Aether docs/20, docs/37): spec and an OpenAI-compatible `/images/generations` + `/images/edits` client.
import { KitFailure, addressAllowed, at, badRequest, cancelled, parseTarget, readUpTo, upstreamFailure } from './kit'
import { MAX_IMAGE_BYTES, encode } from './images'
import type { ImagePart } from '@ouraihub/aether-contracts'
import type { ToolSpec } from '@ouraihub/aether-core/types'
import { withKeys, type Connection } from './providers'

export const GENERATE_IMAGE = 'generate_image'
const SIZES = ['1024x1024', '1024x1536', '1536x1024'] as const
const TIMEOUT_MS = 120_000
const RESPONSE_BYTES = 8 * 1024 * 1024

export const GENERATE_IMAGE_SPEC: ToolSpec = {
  name: GENERATE_IMAGE,
  description: 'Generate one image from a detailed English or Chinese prompt. Use only when the user asks for a picture, drawing, illustration or photo.',
  approval: 'auto',
  effect: 'other',
  source: { kind: 'host' },
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

/** Per-run spec: with `choices` (docs/37 §2.1, newest first) the model may pass `image_ids` to edit them. */
export function generateImageSpec(choices: readonly string[]): ToolSpec {
  if (!choices.length) return GENERATE_IMAGE_SPEC
  const ids = choices.map((_, i) => `image-${i + 1}`)
  const list = choices.map((origin, i) => `${ids[i]}: ${origin}`).join('\n')
  const { properties, ...rest } = GENERATE_IMAGE_SPEC.parameters as { properties: Record<string, unknown> }
  return {
    name: GENERATE_IMAGE,
    approval: 'auto',
    effect: 'other',
    source: { kind: 'host' },
    description: `${GENERATE_IMAGE_SPEC.description} To edit or use existing images as references, pass their ids in image_ids; omit it to draw from scratch.\nImages you can pass in image_ids (newest first):\n${list}`,
    parameters: { ...rest, properties: { ...properties, image_ids: { type: 'array', items: { type: 'string', enum: ids }, minItems: 1, maxItems: 4 } } },
  }
}

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }

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

/** Validates the model's arguments and calls the painting model once; `images` (id → part) switch to `/images/edits`. */
export async function generateImage(db: D1Database, painting: Connection, args: Record<string, unknown>, signal: AbortSignal, images: readonly (readonly [id: string, image: ImagePart])[] = []): Promise<ImagePart> {
  const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
  if (!prompt || [...prompt].length > 4000) throw badRequest('prompt', 'invalid')
  const size = args.size == null ? SIZES[0] : SIZES.find((item) => item === args.size)
  if (!size) throw badRequest('size', 'invalid')
  const known = [...painting.apiKeys]
  // Each key attempt (and the image download) gets its own full timeout.
  const call = async (url: URL, init: RequestInit, timeout = AbortSignal.timeout(TIMEOUT_MS)): Promise<Response> => {
    try {
      return await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.any([signal, timeout]) })
    } catch {
      if (signal.aborted) throw cancelled()
      if (timeout.aborted) throw new KitFailure('timeout', 'painting timeout', { reason: 'painting' })
      throw new KitFailure('network', 'painting model unreachable')
    }
  }
  const edit = images.length > 0
  const target = await allowed(db, edit ? `${painting.imageEditBaseUrl ?? painting.baseUrl}/images/edits` : `${painting.imageBaseUrl ?? painting.baseUrl}/images/generations`)
  // No `response_format`: gpt-image-* rejects it (always b64); others may answer `url`, handled below.
  let payload: BodyInit = JSON.stringify({ model: painting.modelId, prompt, size, n: 1 })
  if (edit) {
    const form = new FormData()
    form.set('model', painting.modelId)
    form.set('prompt', prompt)
    form.set('size', size)
    form.set('n', '1')
    for (const [id, image] of images) {
      const file = Uint8Array.from(atob(image.data), (c) => c.charCodeAt(0))
      form.append(images.length === 1 ? 'image' : 'image[]', new Blob([file], { type: image.mime }), `${id}.${EXT[image.mime] ?? 'png'}`)
    }
    payload = form
  }
  const { response, text, overflow } = await withKeys(painting, async (key) => {
    const timeout = AbortSignal.timeout(TIMEOUT_MS)
    const response = await call(target, {
      method: 'POST',
      // FormData sets its own multipart content-type with the boundary.
      headers: { ...painting.headers, ...(edit ? {} : { 'content-type': 'application/json' }), ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: payload,
    }, timeout)
    // A body that breaks mid-read is this key's network failure, so fill-first tries the next key.
    const { bytes: raw, overflow } = await readUpTo(response.body, RESPONSE_BYTES).catch((error: unknown) => {
      if (signal.aborted) throw cancelled()
      if (timeout.aborted) throw new KitFailure('timeout', 'painting timeout', { reason: 'painting' })
      throw error instanceof KitFailure ? error : new KitFailure('network', 'painting model unreachable')
    })
    const text = new TextDecoder().decode(raw)
    if (!response.ok) throw upstreamFailure(response.status, text, known, response.headers.get('retry-after'))
    return { response, text, overflow }
  })
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
