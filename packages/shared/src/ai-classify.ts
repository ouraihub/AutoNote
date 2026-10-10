/** Shared model inference contract (doc 23 §4). */
export type AiModelType = 'chat' | 'image' | 'video' | 'tts' | 'stt' | 'embedding' | 'rerank' | 'unknown'
export type AiProtocol = 'anthropic-messages' | 'openai-chat' | 'openai-responses'

export interface AiInference {
  modelType: AiModelType
  contextWindow: number | null
  canVision: boolean
}

export function inferAiModel(modelId: string, protocol: AiProtocol): AiInference {
  const id = modelId.toLowerCase()
  const has = (parts: readonly string[]) => parts.some((part) => id.includes(part))
  let modelType: AiModelType
  if (has(['rerank'])) modelType = 'rerank'
  else if (has(['embed']) || id.startsWith('bge-') || id.startsWith('voyage-')) modelType = 'embedding'
  else if (has(['whisper', 'transcri'])) modelType = 'stt'
  else if (has(['tts'])) modelType = 'tts'
  else if (has(['veo', 'sora', 'video'])) modelType = 'video'
  else if (has(['dall-e', 'image', 'imagen'])) modelType = 'image'
  else if (/^(claude|gpt|o\d|gemini|deepseek|qwen|glm|kimi|moonshot)/.test(id)) modelType = 'chat'
  else modelType = 'unknown'
  const family = familyOf(id)
  if (modelType !== 'chat') return { modelType, contextWindow: null, canVision: false }
  if (family === 'claude') return { modelType, contextWindow: 200_000, canVision: protocol === 'anthropic-messages' }
  if (family === 'gpt') return { modelType, contextWindow: 400_000, canVision: true }
  if (family === 'gemini') return { modelType, contextWindow: 1_000_000, canVision: true }
  return { modelType, contextWindow: 128_000, canVision: false }
}

export function aiModelGroup(modelId: string): string | null {
  return familyOf(modelId)
}

function familyOf(id: string): string | null {
  const match = /^(claude|gpt|o\d|gemini|deepseek|qwen|glm|kimi|moonshot)/.exec(id)
  return match?.[1] === 'o1' || match?.[1]?.startsWith('o') ? 'gpt' : match?.[1] ?? 'other'
}
