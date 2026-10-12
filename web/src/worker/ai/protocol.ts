import type { Protocol } from '@ouraihub/aether-ui/ports'
import { at } from './kit'

export type StoredMessage = { user: string } | { assistant: { text: string; tool_calls: never[] } }

export interface Usage {
  inputTokens: number | null
  outputTokens: number | null
}

export interface SseEvent {
  event: string | null
  data: string
}

export class SseParser {
  private buffer = new Uint8Array(0)
  private event: string | null = null
  private data: string | null = null
  private readonly decoder = new TextDecoder()

  feed(chunk: Uint8Array): SseEvent[] {
    const buffer = new Uint8Array(this.buffer.length + chunk.length)
    buffer.set(this.buffer)
    buffer.set(chunk, this.buffer.length)
    const events: SseEvent[] = []
    let start = 0
    for (let index = this.buffer.length; index < buffer.length; index++) {
      if (buffer[index] !== 10) continue
      const end = index > start && buffer[index - 1] === 13 ? index - 1 : index
      this.line(buffer.subarray(start, end), events)
      start = index + 1
    }
    this.buffer = buffer.slice(start)
    return events
  }

  finish(): SseEvent[] {
    const events: SseEvent[] = []
    const last = this.buffer.length
    const end = last > 0 && this.buffer[last - 1] === 13 ? last - 1 : last
    if (end > 0) this.line(this.buffer.subarray(0, end), events)
    this.buffer = new Uint8Array(0)
    this.line(new Uint8Array(0), events)
    return events
  }

  private line(bytes: Uint8Array, events: SseEvent[]): void {
    if (bytes.length === 0) {
      const event = this.event
      this.event = null
      if (this.data !== null) events.push({ event, data: this.data })
      this.data = null
      return
    }
    const line = this.decoder.decode(bytes)
    const colon = line.indexOf(':')
    const field = colon < 0 ? line : line.slice(0, colon)
    const raw = colon < 0 ? '' : line.slice(colon + 1)
    const value = raw.startsWith(' ') ? raw.slice(1) : raw
    if (field === 'event') this.event = value || null
    else if (field === 'data') this.data = this.data === null ? value : `${this.data}\n${value}`
  }
}

export type Decoded = { text: string } | { error: string } | null

const tokens = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff ? value : null

const text = (value: unknown): Decoded => (typeof value === 'string' && value ? { text: value } : null)

const error = (value: unknown): Decoded => {
  const message = at(value, 'message')
  return { error: typeof message === 'string' ? message : 'upstream error' }
}

export class Decoder {
  done = false
  truncated = false

  constructor(private readonly protocol: Protocol) {}

  event(data: string, usage: Usage): Decoded {
    if (data === '[DONE]') {
      this.done = true
      return null
    }
    let v: unknown
    try {
      v = JSON.parse(data)
    } catch {
      return null
    }
    const kind = at(v, 'type')
    if (this.protocol === 'anthropic-messages') {
      if (kind === 'message_start') usage.inputTokens = tokens(at(v, 'message', 'usage', 'input_tokens'))
      else if (kind === 'content_block_delta' && at(v, 'delta', 'type') === 'text_delta') return text(at(v, 'delta', 'text'))
      else if (kind === 'message_delta') {
        usage.outputTokens = tokens(at(v, 'usage', 'output_tokens')) ?? usage.outputTokens
        if (at(v, 'delta', 'stop_reason') === 'max_tokens') this.truncated = true
      } else if (kind === 'message_stop') this.done = true
      else if (kind === 'error') return error(at(v, 'error'))
      return null
    }
    if (this.protocol === 'openai-chat') {
      const failure = at(v, 'error')
      if (failure !== undefined && failure !== null) return error(failure)
      const reported = at(v, 'usage')
      if (typeof reported === 'object' && reported !== null && !Array.isArray(reported)) {
        usage.inputTokens = tokens(at(reported, 'prompt_tokens'))
        usage.outputTokens = tokens(at(reported, 'completion_tokens'))
      }
      const finish = at(v, 'choices', 0, 'finish_reason')
      if (finish !== undefined && finish !== null) {
        this.done = true
        if (finish === 'length') this.truncated = true
      }
      return text(at(v, 'choices', 0, 'delta', 'content'))
    }
    if (kind === 'response.output_text.delta') return text(at(v, 'delta'))
    if (kind === 'response.completed' || kind === 'response.incomplete') {
      usage.inputTokens = tokens(at(v, 'response', 'usage', 'input_tokens'))
      usage.outputTokens = tokens(at(v, 'response', 'usage', 'output_tokens'))
      this.done = true
      if (at(v, 'response', 'incomplete_details', 'reason') === 'max_output_tokens') this.truncated = true
    } else if (kind === 'response.failed') return error(at(v, 'response', 'error'))
    else if (kind === 'error') return error(v)
    return null
  }
}

export const PROTOCOL_PATH: Record<Protocol, string> = {
  'anthropic-messages': 'messages',
  'openai-chat': 'chat/completions',
  'openai-responses': 'responses',
}

export function authHeaders(protocol: Protocol, key: string | null): Record<string, string> {
  const headers: Record<string, string> = {}
  if (key) headers.authorization = `Bearer ${key}`
  if (protocol === 'anthropic-messages') {
    if (key) headers['x-api-key'] = key
    headers['anthropic-version'] = '2023-06-01'
  }
  return headers
}

export interface ModelRequest {
  protocol: Protocol
  model: string
  system: string
  history: readonly StoredMessage[]
  input: string
  maxOutput: number
}

export function requestBody(request: ModelRequest): Record<string, unknown> {
  const messages: Record<string, unknown>[] = request.history.map((message) =>
    'user' in message ? { role: 'user', content: message.user } : { role: 'assistant', content: message.assistant.text },
  )
  messages.push({ role: 'user', content: request.input })
  const { model, system, maxOutput } = request
  if (request.protocol === 'anthropic-messages') {
    return { model, max_tokens: maxOutput, stream: true, messages, ...(system ? { system } : {}) }
  }
  if (request.protocol === 'openai-chat') {
    if (system) messages.unshift({ role: 'system', content: system })
    return { model, max_tokens: maxOutput, stream: true, stream_options: { include_usage: true }, messages }
  }
  return { model, max_output_tokens: maxOutput, stream: true, input: messages, ...(system ? { instructions: system } : {}) }
}
