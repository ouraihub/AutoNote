import type { AiChatRequest, AiConversationSummary, AiModelRef, AiPort, AiStoredMessage } from '../ipc/ports/ai'

export interface ChatTurn {
  key: string
  role: 'user' | 'assistant'
  content: string
  status: AiStoredMessage['status'] | 'streaming'
}

const LAST_KEY = 'desktop.chat.last'
let seq = 0
const key = (): string => `local-${++seq}`
const toTurn = (message: AiStoredMessage): ChatTurn => ({
  key: message.id,
  role: message.role,
  content: message.content,
  status: message.status,
})
const reason = (error: unknown): string =>
  error && typeof error === 'object' && 'message' in error && typeof error.message === 'string' ? error.message : ''

/** One conversation's turns plus the stream in flight. Persistence is the host's (ai_chat stores both turns). */
export class ChatSession {
  conversationId = $state<string | null>(null)
  title = $state('')
  turns = $state<ChatTurn[]>([])
  history = $state<AiConversationSummary[]>([])
  streaming = $state(false)
  error = $state<string | null>(null)
  #abort: AbortController | null = null

  constructor(
    private readonly ai: AiPort,
    private readonly prefs: {
      load(key: string): Promise<unknown>
      save(key: string, value: string | null): Promise<void>
    },
  ) {}

  async restore(): Promise<void> {
    await this.refreshHistory()
    const last = await this.prefs.load(LAST_KEY)
    if (typeof last === 'string' && this.history.some((item) => item.id === last)) await this.open(last)
  }

  async refreshHistory(): Promise<void> {
    this.history = await this.ai.listConversations()
  }

  async open(id: string): Promise<void> {
    if (this.streaming) return
    const conversation = await this.ai.getConversation(id)
    this.conversationId = conversation.id
    this.title = conversation.title
    this.turns = conversation.messages.map(toTurn)
    this.error = null
    void this.prefs.save(LAST_KEY, id)
  }

  reset(): void {
    if (this.streaming) return
    this.conversationId = null
    this.title = ''
    this.turns = []
    this.error = null
    void this.prefs.save(LAST_KEY, null)
  }

  async remove(id: string): Promise<void> {
    await this.ai.deleteConversation(id)
    if (this.conversationId === id) this.reset()
    await this.refreshHistory()
  }

  /** Sends `content`, or with `regenerate` re-answers the last user turn. */
  async send(
    content: string,
    options: { regenerate?: boolean; note?: AiChatRequest['note']; model?: AiModelRef } = {},
  ): Promise<void> {
    const text = content.trim()
    if (this.streaming || (!options.regenerate && !text)) return
    this.error = null
    if (options.regenerate) {
      const last = this.turns.at(-1)
      if (last?.role === 'assistant') this.turns = this.turns.slice(0, -1)
    } else {
      this.turns.push({ key: key(), role: 'user', content: text, status: 'done' })
    }
    const reply: ChatTurn = { key: key(), role: 'assistant', content: '', status: 'streaming' }
    this.turns.push(reply)
    const live = this.turns.at(-1)!
    this.streaming = true
    this.#abort = new AbortController()
    try {
      const { conversationId } = await this.ai.chat(
        {
          ...(this.conversationId ? { conversationId: this.conversationId } : {}),
          content: options.regenerate ? '' : text,
          ...(options.regenerate ? { regenerate: true } : {}),
          ...(options.note ? { note: options.note } : {}),
          ...(options.model ? { model: options.model } : {}),
        },
        (event) => {
          if (event.kind === 'delta') live.content += event.text
        },
        { signal: this.#abort.signal },
      )
      live.status = 'done'
      this.#adopt(conversationId, text)
    } catch (error) {
      const cancelled = this.#abort.signal.aborted
      // The host stored the turn under a new conversation even when the reply failed.
      if (!this.conversationId) await this.refreshHistory().catch(() => {})
      const newest = this.history[0]
      if (!this.conversationId && newest) this.#adopt(newest.id, text)
      // Set status and release `streaming` in the same tick so Retry is live as soon as it renders.
      live.status = cancelled ? 'interrupted' : 'failed'
      if (!cancelled) live.content = reason(error)
    } finally {
      this.streaming = false
      this.#abort = null
    }
  }

  stop(): void {
    this.#abort?.abort()
  }

  #adopt(id: string, firstMessage: string): void {
    if (this.conversationId !== id) {
      this.conversationId = id
      this.title = this.title || firstMessage.split(/\s+/).join(' ').slice(0, 40)
      void this.prefs.save(LAST_KEY, id)
    }
    void this.refreshHistory().catch(() => {})
  }
}
