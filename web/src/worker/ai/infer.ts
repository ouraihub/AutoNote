import type { ModelType } from '@ouraihub/aether-ui/ports'

export interface Inferred {
  modelType: ModelType
  contextWindow: number | null
  maxOutput: number | null
  canVision: boolean
  supportsTools: boolean | null
  group: string | null
}

type Limits = readonly [contextWindow: number, maxOutput: number, vision: boolean]

const TYPES: readonly (readonly [readonly string[], ModelType])[] = [
  [['embed'], 'embedding'],
  [['rerank'], 'rerank'],
  [['tts', 'speech'], 'tts'],
  [['whisper', 'stt', 'transcri'], 'stt'],
  [['dall-e', 'image', 'flux', 'imagen'], 'image'],
  [['video', 'sora', 'veo'], 'video'],
]

const FAMILIES: readonly (readonly [prefix: string, group: string, limits: Limits])[] = [
  ['claude', 'claude', [200_000, 8_192, true]],
  ['gpt-3.5', 'gpt', [16_385, 4_096, false]],
  ['gpt', 'gpt', [128_000, 16_384, true]],
  ['gemini', 'gemini', [1_048_576, 8_192, true]],
  ['deepseek', 'deepseek', [128_000, 8_192, false]],
  ['qwen', 'qwen', [131_072, 8_192, false]],
  ['glm', 'glm', [128_000, 4_096, false]],
  ['kimi', 'kimi', [131_072, 8_192, false]],
  ['moonshot-v1-8k', 'moonshot', [8_192, 4_096, false]],
  ['moonshot-v1-32k', 'moonshot', [32_768, 4_096, false]],
  ['moonshot', 'moonshot', [131_072, 4_096, false]],
]

const O_SERIES: Limits = [200_000, 100_000, true]

export function inferModel(modelId: string): Inferred {
  const id = modelId.toLowerCase()
  const modelType = TYPES.find(([words]) => words.some((word) => id.includes(word)))?.[1] ?? 'chat'
  const name = id.slice(id.lastIndexOf('/') + 1)
  const known = FAMILIES.find(([prefix]) => name.startsWith(prefix))
  const family: readonly [string, Limits] | undefined = known
    ? [known[1], known[2]]
    : /^o\d/.test(name)
      ? ['o', O_SERIES]
      : undefined
  const group = family?.[0] ?? null
  if (family && modelType === 'chat') {
    const [contextWindow, maxOutput, canVision] = family[1]
    return { modelType, contextWindow, maxOutput, canVision, supportsTools: true, group }
  }
  return { modelType, contextWindow: null, maxOutput: null, canVision: false, supportsTools: null, group }
}
