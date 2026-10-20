import type { Protocol, TokenUsage, ReasoningEffort, ReasoningConfig } from '@ouraihub/aether-ui/ports'
import { at } from './kit'

export interface ReasoningBlock { protocol: Protocol; endpointId: string | null; modelId: string | null; value: unknown }
export interface ImagePart { mime: string; data: string }
export interface ImageRef { mime: string; url: string | null }
export interface ToolCall { id: string; name: string; args: Record<string, unknown> | null }
export interface ToolSpec { name: string; description: string; parameters: Record<string, unknown> }
/** Same JSON shape as Aether `Message` (externally tagged, snake_case fields). */
export type StoredMessage =
  | { user: string; images?: ImagePart[]; turnId?: string }
  | { assistant: { text: string; tool_calls: ToolCall[]; reasoning?: ReasoningBlock[] } }
  | { tool: { call_id: string; text: string } }
export type Usage = TokenUsage

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

export type Decoded = { text: string } | { reasoning: string } | { error: string } | null

const tokens = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff ? value : null

const text = (value: unknown): Decoded => (typeof value === 'string' && value ? { text: value } : null)

const error = (value: unknown): Decoded => {
  const message = at(value, 'message')
  return { error: typeof message === 'string' ? message : 'upstream error' }
}

function citation(value: unknown): Decoded {
  const raw = at(value, 'url')
  if (typeof raw !== 'string') return null
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    return { text: ` [source](<${url.href.replaceAll('<', '%3C').replaceAll('>', '%3E')}>)` }
  } catch { return null }
}

export class Decoder {
  done = false
  truncated = false
  readonly reasoning: ReasoningBlock[] = []
  private blocks = new Map<number, Record<string, unknown>>()
  private baseInput: number | null = null
  private chatReasoning = ''
  /** Streaming calls; key is the anthropic block index, openai-chat `index`, or responses `item_id`. */
  private calls: { key: unknown; id: string; name: string; args: string }[] = []
  constructor(private readonly protocol: Protocol, private readonly endpointId: string | null = null, private readonly modelId: string | null = null) {}

  private keep(value: unknown): void {
    const block = { protocol: this.protocol, endpointId: this.endpointId, modelId: this.modelId, value }
    const id = at(value, 'id')
    const existing = id == null ? -1 : this.reasoning.findIndex((item) => at(item.value, 'id') === id)
    if (existing < 0) this.reasoning.push(block)
    else this.reasoning[existing] = block
  }

  private start(key: unknown, id: unknown, name: unknown): void {
    this.calls.push({ key, id: typeof id === 'string' ? id : '', name: typeof name === 'string' ? name : '', args: '' })
  }

  private append(key: unknown, fragment: unknown): void {
    const call = this.calls.find((item) => item.key === key)
    if (call && typeof fragment === 'string') call.args += fragment
  }

  /** Calls in stream order; arguments that are not a JSON object come back as `null`. */
  toolCalls(): ToolCall[] {
    return this.calls.map(({ id, name, args }) => {
      let parsed: unknown = null
      try { parsed = JSON.parse(args || '{}') } catch { /* stays null */ }
      return { id, name, args: parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null }
    })
  }

  event(data: string, usage: Usage): Decoded {
    if (data === '[DONE]') { this.done = true; return null }
    let v: unknown
    try { v = JSON.parse(data) } catch { return null }
    const kind = at(v, 'type')
    if (this.protocol === 'anthropic-messages') {
      if (kind === 'message_start' || kind === 'message_delta') {
        const raw = kind === 'message_start' ? at(v, 'message', 'usage') : at(v, 'usage')
        this.baseInput = tokens(at(raw, 'input_tokens')) ?? this.baseInput
        usage.outputTokens = tokens(at(raw, 'output_tokens')) ?? usage.outputTokens
        usage.cacheReadTokens = tokens(at(raw, 'cache_read_input_tokens')) ?? usage.cacheReadTokens
        usage.cacheWriteTokens = tokens(at(raw, 'cache_creation_input_tokens')) ?? usage.cacheWriteTokens
        usage.reasoningTokens = tokens(at(raw, 'reasoning_tokens')) ?? usage.reasoningTokens
        if (this.baseInput !== null) usage.inputTokens = Math.min(0xffff_ffff, this.baseInput + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0))
        if (at(v, 'delta', 'stop_reason') === 'max_tokens') this.truncated = true
      } else if (kind === 'content_block_start') {
        const block = at(v, 'content_block')
        if (at(block, 'type') === 'web_search_tool_result' && at(block, 'content', 'type') === 'web_search_tool_result_error') return { error: 'native web search failed' }
        const index = tokens(at(v, 'index'))
        if (at(block, 'type') === 'tool_use') this.start(index, at(block, 'id'), at(block, 'name'))
        if (index !== null && block && typeof block === 'object' && (at(block, 'type') === 'thinking' || at(block, 'type') === 'redacted_thinking')) {
          this.blocks.set(index, { ...block })
          const initial = at(block, 'thinking')
          if (typeof initial === 'string' && initial) return { reasoning: initial }
        }
      } else if (kind === 'content_block_delta') {
        const delta = at(v, 'delta')
        if (at(delta, 'type') === 'text_delta') return text(at(delta, 'text'))
        if (at(delta, 'type') === 'citations_delta') return citation(at(delta, 'citation'))
        if (at(delta, 'type') === 'input_json_delta') { this.append(tokens(at(v, 'index')), at(delta, 'partial_json')); return null }
        const block = this.blocks.get(Number(at(v, 'index')))
        if (block && at(delta, 'type') === 'thinking_delta') {
          const fragment = at(delta, 'thinking')
          if (typeof fragment === 'string') { block.thinking = String(block.thinking ?? '') + fragment; return { reasoning: fragment } }
        }
        if (block && at(delta, 'type') === 'signature_delta') {
          const fragment = at(delta, 'signature')
          if (typeof fragment === 'string') block.signature = String(block.signature ?? '') + fragment
        }
      } else if (kind === 'content_block_stop') {
        const index = Number(at(v, 'index')), block = this.blocks.get(index)
        if (block && ((block.type === 'thinking' && typeof block.signature === 'string' && block.signature) || (block.type === 'redacted_thinking' && typeof block.data === 'string' && block.data))) this.keep(block)
        this.blocks.delete(index)
      } else if (kind === 'message_stop') this.done = true
      else if (kind === 'error') return error(at(v, 'error'))
      return null
    }
    if (this.protocol === 'openai-chat') {
      if (at(v, 'error') != null) return error(at(v, 'error'))
      const raw = at(v, 'usage')
      if (raw && typeof raw === 'object') {
        usage.inputTokens = tokens(at(raw, 'prompt_tokens')) ?? usage.inputTokens
        usage.outputTokens = tokens(at(raw, 'completion_tokens')) ?? usage.outputTokens
        usage.cacheReadTokens = tokens(at(raw, 'prompt_tokens_details', 'cached_tokens')) ?? usage.cacheReadTokens
        usage.cacheWriteTokens = tokens(at(raw, 'prompt_tokens_details', 'cache_write_tokens')) ?? usage.cacheWriteTokens
        usage.reasoningTokens = tokens(at(raw, 'completion_tokens_details', 'reasoning_tokens')) ?? usage.reasoningTokens
      }
      const finish = at(v, 'choices', 0, 'finish_reason')
      if (finish != null) {
        this.done = true; this.truncated = finish === 'length'
        if (this.chatReasoning) { this.keep(this.chatReasoning); this.chatReasoning = '' }
      }
      const deltas = at(v, 'choices', 0, 'delta', 'tool_calls')
      if (Array.isArray(deltas)) for (const delta of deltas) {
        const key = at(delta, 'index')
        if (!this.calls.some((item) => item.key === key)) this.start(key, at(delta, 'id'), at(delta, 'function', 'name'))
        this.append(key, at(delta, 'function', 'arguments'))
      }
      const thinking = at(v, 'choices', 0, 'delta', 'reasoning_content')
      if (typeof thinking === 'string' && thinking) { this.chatReasoning += thinking; return { reasoning: thinking } }
      return text(at(v, 'choices', 0, 'delta', 'content'))
    }
    if (kind === 'response.output_item.done' && at(v, 'item', 'type') === 'reasoning') this.keep(at(v, 'item'))
    // `call_id` (not the item id) is what `function_call_output` must echo.
    if (kind === 'response.output_item.added' && at(v, 'item', 'type') === 'function_call') this.start(at(v, 'item', 'id'), at(v, 'item', 'call_id'), at(v, 'item', 'name'))
    if (kind === 'response.function_call_arguments.delta') this.append(at(v, 'item_id'), at(v, 'delta'))
    if (kind === 'response.reasoning_summary_text.delta') {
      const fragment = at(v, 'delta')
      if (typeof fragment === 'string') return { reasoning: fragment }
    }
    if (kind === 'response.output_text.delta') return text(at(v, 'delta'))
    if (kind === 'response.output_text.annotation.added') return citation(at(v, 'annotation'))
    if (kind === 'response.completed' || kind === 'response.incomplete') {
      const raw = at(v, 'response', 'usage')
      usage.inputTokens = tokens(at(raw, 'input_tokens'))
      usage.outputTokens = tokens(at(raw, 'output_tokens'))
      usage.cacheReadTokens = tokens(at(raw, 'input_tokens_details', 'cached_tokens'))
      usage.cacheWriteTokens = tokens(at(raw, 'input_tokens_details', 'cache_write_tokens'))
      usage.reasoningTokens = tokens(at(raw, 'output_tokens_details', 'reasoning_tokens'))
      const output = at(v, 'response', 'output')
      if (Array.isArray(output)) for (const item of output) if (at(item, 'type') === 'reasoning') this.keep(item)
      this.done = true; this.truncated = kind === 'response.incomplete'
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
  images?: readonly ImagePart[]
  maxOutput: number
  endpointId: string
  reasoningEffort: ReasoningEffort
  reasoning: ReasoningConfig | null
  reasoningBudget: number | null
  nativeWebSearch?: boolean
  /** Host tools offered this round. */
  tools?: readonly ToolSpec[]
  /** Messages this run already produced after `input` (assistant tool calls and their results). */
  turn?: readonly StoredMessage[]
}

function userContent(protocol: Protocol, text: string, images: readonly ImagePart[] | undefined): unknown {
  if (!images?.length) return text
  const url = (image: ImagePart): string => `data:${image.mime};base64,${image.data}`
  if (protocol === 'anthropic-messages') return [...images.map((image) => ({ type: 'image', source: { type: 'base64', media_type: image.mime, data: image.data } })), { type: 'text', text }]
  if (protocol === 'openai-chat') return [{ type: 'text', text }, ...images.map((image) => ({ type: 'image_url', image_url: { url: url(image) } }))]
  return [{ type: 'input_text', text }, ...images.map((image) => ({ type: 'input_image', image_url: url(image) }))]
}

export function requestBody(request: ModelRequest): Record<string, unknown> {
  const messages: Record<string, unknown>[] = []
  const anthropic = request.protocol === 'anthropic-messages', responses = request.protocol === 'openai-responses'
  const encode = (message: StoredMessage): void => {
    if ('user' in message) { messages.push({ role: 'user', content: userContent(request.protocol, message.user, message.images) }); return }
    if ('tool' in message) {
      const { call_id, text } = message.tool
      if (responses) { messages.push({ type: 'function_call_output', call_id, output: text }); return }
      if (!anthropic) { messages.push({ role: 'tool', tool_call_id: call_id, content: text }); return }
      // Consecutive results answer one assistant message: one user message of `tool_result` blocks.
      const block = { type: 'tool_result', tool_use_id: call_id, content: text }
      const last = messages.at(-1)
      if (last?.role === 'user' && Array.isArray(last.content) && last.content.every((item) => at(item, 'type') === 'tool_result')) last.content.push(block)
      else messages.push({ role: 'user', content: [block] })
      return
    }
    const assistant = message.assistant
    const calls = assistant.tool_calls ?? []
    const reasoning = (assistant.reasoning ?? []).filter((block) => block.protocol === request.protocol && block.endpointId === request.endpointId && block.modelId === request.model)
    if (anthropic) {
      const blocks = reasoning.flatMap((block) => block.value && typeof block.value === 'object' ? [block.value] : [])
      if (assistant.text) blocks.push({ type: 'text', text: assistant.text })
      for (const call of calls) blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.args ?? {} })
      if (blocks.length) messages.push({ role: 'assistant', content: blocks })
    } else if (responses) {
      for (const block of reasoning) if (block.value && typeof block.value === 'object') messages.push(block.value as Record<string, unknown>)
      if (assistant.text) messages.push({ role: 'assistant', content: assistant.text })
      for (const call of calls) messages.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: JSON.stringify(call.args ?? {}) })
    } else if (assistant.text || calls.length) {
      messages.push({
        role: 'assistant',
        content: assistant.text,
        ...(reasoning.length ? { reasoning_content: reasoning.map((block) => typeof block.value === 'string' ? block.value : '').join('') } : {}),
        ...(calls.length ? { tool_calls: calls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) } })) } : {}),
      })
    }
  }
  for (const message of request.history) encode(message)
  encode({ user: request.input, ...(request.images ? { images: [...request.images] } : {}) })
  for (const message of request.turn ?? []) encode(message)
  const { model, system, maxOutput, reasoningEffort: effort } = request
  let body: Record<string, unknown>
  if (request.protocol === 'anthropic-messages') {
    body = { model, max_tokens: maxOutput, stream: true, messages, ...(system ? { system } : {}) }
    if (effort === 'none') body.thinking = { type: 'disabled' }
    else if (effort !== 'default' && request.reasoning?.dialect === 'anthropic-budget') body.thinking = { type: 'enabled', budget_tokens: request.reasoningBudget }
    else if (effort !== 'default') { body.thinking = { type: 'adaptive' }; body.output_config = { effort } }
  } else if (request.protocol === 'openai-chat') {
    if (system) messages.unshift({ role: 'system', content: system })
    body = { model, max_tokens: maxOutput, stream: true, stream_options: { include_usage: true }, messages, ...(effort === 'default' ? {} : { reasoning_effort: effort }) }
  } else {
    body = { model, max_output_tokens: maxOutput, stream: true, input: messages, store: false, include: ['reasoning.encrypted_content'], ...(system ? { instructions: system } : {}), ...(effort === 'default' ? {} : { reasoning: { effort, summary: 'auto' } }) }
  }
  const tools: Record<string, unknown>[] = (request.tools ?? []).map(({ name, description, parameters }) =>
    anthropic ? { name, description, input_schema: parameters } : responses ? { type: 'function', name, description, parameters } : { type: 'function', function: { name, description, parameters } })
  if (request.nativeWebSearch) {
    if (request.protocol === 'openai-chat') throw new Error('Native search is unsupported on Chat Completions')
    tools.push(anthropic ? { type: 'web_search_20250305', name: 'web_search', max_uses: 5 } : { type: 'web_search' })
  }
  if (tools.length) body.tools = tools
  return body
}
