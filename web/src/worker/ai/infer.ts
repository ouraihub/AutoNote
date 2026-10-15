import type { ModelType, Protocol, ReasoningConfig } from '@ouraihub/aether-ui/ports'

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

const VISION_MARKERS = ['vision', '-vl', 'vl-', '4v'] as const

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
  const marked = VISION_MARKERS.some((marker) => name.includes(marker))
  if (family && modelType === 'chat') {
    const [contextWindow, maxOutput, canVision] = family[1]
    return { modelType, contextWindow, maxOutput, canVision: canVision || marked, supportsTools: true, group }
  }
  return { modelType, contextWindow: null, maxOutput: null, canVision: marked && modelType === 'chat', supportsTools: null, group }
}

// ponytail: bounded known-family rules; add a catalog only when provider-specific metadata is needed.
export function inferReasoning(modelId: string, protocol: Protocol, maxOutput: number | null): ReasoningConfig | null {
  const name = modelId.toLowerCase().split('/').at(-1) ?? ''
  const normalized = name.replaceAll('.', '-')
  const matches = (prefix: string): boolean => {
    if (normalized === prefix) return true
    if (!normalized.startsWith(`${prefix}-`)) return false
    const suffix = normalized.slice(prefix.length + 1).split('-')[0] ?? ''
    return !/^\d+$/.test(suffix) || suffix.length >= 4
  }
  if (protocol === 'anthropic-messages') {
    const families = ['opus', 'sonnet', 'haiku']
    const newest = families.some((family) => matches(`claude-${family}-5-5`))
    const adaptive = newest || families.some((family) => matches(`claude-${family}-5`)) ||
      ['opus', 'sonnet'].some((family) => ['6', '7', '8'].some((minor) => matches(`claude-${family}-4-${minor}`)))
    if (adaptive) return {
      dialect: 'anthropic-adaptive',
      efforts: [...(matches('claude-opus-5-5') ? [] : ['none'] as const), 'low', 'medium', 'high', ...(newest ? ['xhigh'] as const : []), 'max'],
    }
    const budget = ['claude-3-7-sonnet', 'claude-sonnet-4-5', 'claude-sonnet-4', 'claude-opus-4-5', 'claude-opus-4-1', 'claude-opus-4', 'claude-haiku-4-5'].some(matches)
    const budgetTokens = Math.min(8192, (maxOutput ?? 8193) - 1)
    if (budget && budgetTokens >= 1024) return { dialect: 'anthropic-budget', efforts: ['none', 'low', 'medium', 'high'], budgetTokens }
    return null
  }
  if (['o1', 'o3', 'o4-mini'].some(matches) && !matches('o1-mini') && !matches('o1-preview'))
    return { dialect: 'openai', efforts: ['low', 'medium', 'high'] }
  if (/-(?:chat|pro|codex)(?:-|$)/.test(normalized)) return null
  if (matches('gpt-5-1')) return { dialect: 'openai', efforts: ['none', 'low', 'medium', 'high'] }
  if (['2', '3', '4', '5', '6'].some((minor) => matches(`gpt-5-${minor}`)))
    return { dialect: 'openai', efforts: ['none', 'low', 'medium', 'high', 'xhigh'] }
  if (matches('gpt-5'))
    return { dialect: 'openai', efforts: ['minimal', 'low', 'medium', 'high'] }
  return null
}
