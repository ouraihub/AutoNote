import type { ImagePart } from '@ouraihub/aether-contracts'
import { ImageFailure } from '@ouraihub/aether-core/images'
import type { ToolCall, ToolExecution } from '@ouraihub/aether-core/types'
import type { Env } from '../env'
import { badRequest, internal, KitFailure } from './kit'
import { GENERATE_IMAGE, generateImage } from './painting'
import { loadImages, saveGenerated } from './images'
import type { PreparedRun } from './run-prepare'

const MAX_PAINTINGS = 2

export async function runTool(
  env: Env,
  userId: string,
  run: PreparedRun,
  call: ToolCall,
  painted: { count: number },
  signal: AbortSignal,
): Promise<ToolExecution> {
  if (!run.painting || call.name !== GENERATE_IMAGE)
    return {
      kind: 'error',
      code: 'unknown_tool',
      message:
        'no tool named ' + `${JSON.stringify(call.name)}` + ' in this run',
    }
  if (painted.count++ >= MAX_PAINTINGS)
    return {
      kind: 'error',
      code: 'limit',
      message: `At most ${MAX_PAINTINGS} images per reply.`,
    }
  try {
    const result = await generateImage(
      env.DB,
      run.painting,
      call.args,
      signal,
      await pickImages(env, run, call.args.image_ids),
    )
    const { image, usage, totalTokens } = result
    if (run.turn) {
      try {
        await saveGenerated(env, userId, run.turn.turnId, image)
      } catch {
        return {
          kind: 'error',
          code: 'generated_save_failed',
          message:
            'Image generated but persistence could not be confirmed. ' +
            'Do not automatically regenerate.',
          payload: { generated: true, persisted: false, usage, totalTokens },
        }
      }
    }
    return {
      kind: 'ok',
      text: 'Generated 1 image; it is already shown to the us' + 'er.',
      payload: {
        images: [
          { mime: image.mime, url: `data:${image.mime};base64,${image.data}` },
        ],
        usage,
        totalTokens,
        revisedPrompt: result.revisedPrompt,
      },
    }
  } catch (error) {
    if (signal.aborted) return { kind: 'unknown', reason: 'cancelled' }
    if (error instanceof ImageFailure && error.dispatch === 'unknown')
      return {
        kind: 'unknown',
        reason:
          'Image generation dispatched; result unknown. ' +
          'Do not automatically retry.',
      }
    const failure = error instanceof KitFailure ? error : internal(error)
    return { kind: 'error', code: failure.code, message: failure.message }
  }
}

async function pickImages(
  env: Env,
  run: PreparedRun,
  raw: unknown,
): Promise<[string, ImagePart][]> {
  if (raw == null) return []
  if (!run.painting?.canVision) throw badRequest('image_ids', 'unsupported')
  if (!Array.isArray(raw)) throw badRequest('image_ids', 'unknown')
  if (raw.length > 4) throw badRequest('image_ids', 'too_many', 4)
  const picked: [string, ImagePart][] = []
  for (const id of raw) {
    const choice =
      typeof id === 'string'
        ? run.choices[Number(/^image-([1-9])$/.exec(id)?.[1]) - 1]
        : undefined
    if (!choice) throw badRequest('image_ids', 'unknown')
    const image =
      'objectKey' in choice.image
        ? (await loadImages(env, [choice.image]))[0]
        : choice.image
    if (!image) throw badRequest('image_ids', 'expired')
    picked.push([id, image])
  }
  return picked
}
