// Product tool arguments and key/address policy; Aether owns the image protocol.
import { KitFailure, addressAllowed, badRequest, cancelled, parseTarget, readUpTo, upstreamFailure } from './kit'
import { generateImage as generate, IMAGE_SIZES as SIZES, type ImageGeneration } from '@ouraihub/aether-core/images'
import type { ImagePart } from '@ouraihub/aether-contracts'
import type { ToolSpec } from '@ouraihub/aether-core/types'
import { withKeys, type Connection } from './providers'

export const GENERATE_IMAGE = 'generate_image'

export const GENERATE_IMAGE_SPEC: ToolSpec = {
  name: GENERATE_IMAGE,
  description:
    'Generate one image from a detailed English or Chinese prompt. Use only when the user asks for a picture, drawing, illustration or photo.',
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
    parameters: {
      ...rest,
      properties: {
        ...properties,
        image_ids: { type: 'array', items: { type: 'string', enum: ids }, minItems: 1, maxItems: 4 },
      },
    },
  }
}

/** Resolves product tool arguments; only explicit credential rejection can rotate image keys. */
export async function generateImage(
  db: D1Database,
  painting: Connection,
  args: Record<string, unknown>,
  signal: AbortSignal,
  images: readonly (readonly [id: string, image: ImagePart])[] = [],
): Promise<ImageGeneration> {
  const prompt = typeof args.prompt === 'string' ? args.prompt : ''
  const size = args.size == null ? SIZES[0] : SIZES.find((item) => item === args.size)
  if (!size) throw badRequest('size', 'invalid')
  if (painting.exhaustion?.failure) throw painting.exhaustion.failure
  if (painting.setAside && !painting.apiKeys.length)
    throw new KitFailure('rate_limited', 'every key of this line is set aside', { reason: 'keys_exhausted' })
  return generate(
    {
      async fetch(raw, init) {
        const url = parseTarget(raw)
        if (!(await addressAllowed(db, url))) throw badRequest('url', 'blocked_address')
        const request = { ...init, redirect: 'manual' as const, credentials: 'omit' as const }
        if (init.method !== 'POST') return fetch(url, request)
        let rejected: Response | undefined
        try {
          return await withKeys(painting, async (key) => {
            if (init.signal?.aborted) throw cancelled()
            const headers = new Headers(init.headers)
            if (key) headers.set('authorization', `Bearer ${key}`)
            const response = await fetch(url, { ...request, headers })
            if (![401, 403, 429].includes(response.status)) return response
            const { bytes } = await readUpTo(response.body, 8192)
            rejected = new Response(bytes, { status: response.status, headers: response.headers })
            throw upstreamFailure(
              response.status,
              new TextDecoder().decode(bytes),
              painting.apiKeys,
              response.headers.get('retry-after'),
            )
          })
        } catch (error) {
          if (rejected && error instanceof KitFailure && [401, 403, 429].includes(Number(error.details.status)))
            return rejected
          throw error
        }
      },
    },
    {
      baseUrl: painting.baseUrl,
      modelId: painting.modelId,
      headers: painting.headers,
      canVision: painting.canVision,
      keys: [],
      ...(painting.imageBaseUrl ? { imageBaseUrl: painting.imageBaseUrl } : {}),
      ...(painting.imageEditBaseUrl ? { imageEditBaseUrl: painting.imageEditBaseUrl } : {}),
    },
    { prompt, size, images: images.map(([, image]) => image) },
    signal,
  )
}
