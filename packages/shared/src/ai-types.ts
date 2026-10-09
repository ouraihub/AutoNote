/** Product-level AI writing contract shared by Desktop Tauri and Web Worker transports. */
export type AiWriteAction = 'polish' | 'rewrite' | 'shorten' | 'expand' | 'continue'

export interface AiWriteRequest {
  action: AiWriteAction
  text: string
  context?: string
  language?: string
  noteTitle?: string
}

export type AiWriteEvent =
  | { kind: 'delta'; text: string }
  | { kind: 'done'; inputTokens: number | null; outputTokens: number | null }

export interface AiWriteResult {
  model: { endpointId: string; modelId: string }
  isFallback: boolean
}
