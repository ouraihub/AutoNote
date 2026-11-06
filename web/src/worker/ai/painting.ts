// Product tool arguments and key/address policy; Aether owns the protocol.
import {
  KitFailure,
  addressAllowed,
  badRequest,
  cancelled,
  parseTarget,
  readUpTo,
  upstreamFailure,
} from './kit'
import type { ImagePart } from '@ouraihub/aether-contracts'
import type { ToolSpec } from '@ouraihub/aether-core/types'
import {
  IMAGE_SIZES as SIZES,
  generateImage as generate,
  type ImageGeneration,
} from '@ouraihub/aether-core/images'
import { withKeys, type Connection } from './providers'

export const GENERATE_IMAGE = 'generate_image'
const REJECTED = [401, 403, 429]

export const GENERATE_IMAGE_SPEC: ToolSpec = {
  name: GENERATE_IMAGE,
  description:
    'Generate one image from a detailed English or Chin' +
    'ese prompt. Use only when the user asks for a pict' +
    'ure, drawing, illustration or photo.',
  approval: 'auto',
  effect: 'other',
  source: { kind: 'host' },
  parameters: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        minLength: 1,
        maxLength: 4000,
        description: 'What to draw.',
      },
      size: { type: 'string', enum: SIZES },
    },
    required: ['prompt'],
    additionalProperties: false,
  },
}

export function generateImageSpec(choices: readonly string[]): ToolSpec {
  if (!choices.length) return GENERATE_IMAGE_SPEC
  const ids = choices.map((_, i) => `image-${i + 1}`)
  const list = choices.map((origin, i) => `${ids[i]}: ${origin}`).join('\n')
  const { properties, ...rest } = GENERATE_IMAGE_SPEC.parameters as {
    properties: Record<string, unknown>
  }
  return {
    name: GENERATE_IMAGE,
    approval: 'auto',
    effect: 'other',
    source: { kind: 'host' },
    description:
      '' +
      `${GENERATE_IMAGE_SPEC.description}` +
      ' To edit or use existing images as references, pas' +
      's their ids in image_ids; omit it to draw from scr' +
      'atch.\nImages you can pass in image_ids (newest fi' +
      'rst):\n' +
      `${list}`,
    parameters: {
      ...rest,
      properties: {
        ...properties,
        image_ids: {
          type: 'array',
          items: { type: 'string', enum: ids },
          minItems: 1,
          maxItems: 4,
        },
      },
    },
  }
}

/**
 * Validates the model's arguments and calls the painting model once; `images`
 * (id → part) switch to `/images/edits`. Keys rotate here under AutoNote's
 * pool policy (Aether gets none) and only on an explicit 401/403/429: a thrown
 * fetch is not a KitFailure, so withKeys never resends a dispatched request
 * that may already have produced (and billed) an image. The last rejection is
 * handed back to Aether, which reports it without the provider body. Returned
 * image URLs are downloaded without a key.
 */
export async function generateImage(
  db: D1Database,
  painting: Connection,
  args: Record<string, unknown>,
  signal: AbortSignal,
  images: readonly (readonly [id: string, image: ImagePart])[] = [],
): Promise<ImageGeneration> {
  const prompt = typeof args.prompt === 'string' ? args.prompt : ''
  const size =
    args.size == null ? SIZES[0] : SIZES.find((item) => item === args.size)
  if (!size) throw badRequest('size', 'invalid')
  if (painting.exhaustion?.failure) throw painting.exhaustion.failure
  if (painting.setAside && !painting.apiKeys.length)
    throw new KitFailure(
      'rate_limited',
      'every key of this line is set aside',
      { reason: 'keys_exhausted' },
    )
  const http = {
    async fetch(raw: string, init: RequestInit): Promise<Response> {
      const url = parseTarget(raw)
      if (!(await addressAllowed(db, url)))
        throw badRequest('url', 'blocked_address')
      const request = {
        ...init,
        redirect: 'manual' as const,
        credentials: 'omit' as const,
      }
      if (init.method !== 'POST') return fetch(url, request)
      let rejected: Response | undefined
      try {
        return await withKeys(painting, async (key) => {
          if (init.signal?.aborted) throw cancelled()
          const headers = new Headers(init.headers)
          if (key) headers.set('authorization', `Bearer ${key}`)
          const response = await fetch(url, { ...request, headers })
          if (!REJECTED.includes(response.status)) return response
          const { bytes } = await readUpTo(response.body, 8192)
          rejected = new Response(bytes, {
            status: response.status,
            headers: response.headers,
          })
          throw upstreamFailure(
            response.status,
            new TextDecoder().decode(bytes),
            painting.apiKeys,
            response.headers.get('retry-after'),
          )
        })
      } catch (error) {
        if (
          rejected &&
          error instanceof KitFailure &&
          REJECTED.includes(Number(error.details.status))
        )
          return rejected
        throw error
      }
    },
  }
  return generate(
    http,
    {
      baseUrl: painting.baseUrl,
      modelId: painting.modelId,
      headers: painting.headers,
      canVision: painting.canVision,
      keys: [],
      ...(painting.imageBaseUrl ? { imageBaseUrl: painting.imageBaseUrl } : {}),
      ...(painting.imageEditBaseUrl
        ? { imageEditBaseUrl: painting.imageEditBaseUrl }
        : {}),
    },
    { prompt, size, images: images.map(([, image]) => image) },
    signal,
  )
}
