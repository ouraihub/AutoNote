import type { Conversation, ConversationSummary, EndStatus, TurnStatus, ContextUsage, ReasoningEffort } from '@ouraihub/aether-ui/ports'
import { newId } from '../lib/id'
import { badRequest, charCount, conflict, notFound } from './kit'
import type { StoredMessage, Usage } from './protocol'

const STALE_RUNNING_MS = 15 * 60_000
const SUMMARY = 'id, title, scope, created_at AS createdAt, updated_at AS updatedAt'

export interface StoredTurn {
  id: string
  status: TurnStatus
  input: string
  messages: StoredMessage[]
  modelId: string | null
  errorCode: string | null
  endpointId: string | null
  reasoningEffort: ReasoningEffort
  reasoningText: string
  usage: Usage
  contextUsage: ContextUsage | null
}

export interface StoredConversation {
  summary: ConversationSummary
  turns: StoredTurn[]
}

export interface TurnHandle {
  conversationId: string
  turnId: string
}

export interface TurnRecord {
  status: EndStatus
  messages: StoredMessage[]
  modelId: string
  errorCode: string | null
  usage: Usage
  endpointId: string
  reasoningEffort: ReasoningEffort
  reasoningText: string
  contextUsage: ContextUsage
}

export async function listConversations(db: D1Database, userId: string, scope: string | null): Promise<ConversationSummary[]> {
  const { results } = await db
    .prepare(
      `SELECT ${SUMMARY} FROM ai_chat_conversations WHERE user_id = ?1 AND (?2 IS NULL OR scope = ?2) ORDER BY updated_at DESC, id DESC LIMIT 200`,
    )
    .bind(userId, scope)
    .all<ConversationSummary>()
  return results
}

export async function loadConversation(db: D1Database, userId: string, id: string): Promise<StoredConversation> {
  const [summary, { results }] = await Promise.all([
    db.prepare(`SELECT ${SUMMARY} FROM ai_chat_conversations WHERE id = ?1 AND user_id = ?2`).bind(id, userId).first<ConversationSummary>(),
    db
      .prepare(
        `SELECT id, status, input, messages, model_id AS modelId, endpoint_id AS endpointId, error_code AS errorCode, created_at AS createdAt,
          reasoning_effort AS reasoningEffort, reasoning_text AS reasoningText, context_usage AS contextUsage,
          input_tokens AS inputTokens, output_tokens AS outputTokens, cache_read_tokens AS cacheReadTokens, cache_write_tokens AS cacheWriteTokens, reasoning_tokens AS reasoningTokens
          FROM ai_chat_turns WHERE conversation_id = ?1 AND user_id = ?2 ORDER BY seq`,
      )
      .bind(id, userId)
      .all<Omit<StoredTurn, 'messages' | 'usage' | 'contextUsage'> & Usage & { messages: string; createdAt: number; contextUsage: string | null }>(),
  ])
  if (!summary) throw notFound('conversation')
  const stale = Date.now() - STALE_RUNNING_MS
  return {
    summary,
    turns: results.map(({ createdAt, messages, contextUsage, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens, ...turn }) => ({
      ...turn,
      reasoningEffort: turn.reasoningEffort ?? 'default',
      reasoningText: turn.reasoningText ?? '',
      usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens },
      contextUsage: contextUsage ? JSON.parse(contextUsage) as ContextUsage : null,
      messages: JSON.parse(messages) as StoredMessage[],
      ...(turn.status === 'running' && createdAt < stale ? { status: 'failed' as const, errorCode: 'interrupted', contextUsage: null } : {}),
    })),
  }
}

export function toWire({ summary, turns }: StoredConversation): Conversation {
  return {
    summary,
    turns: turns.map((turn) => ({
      id: turn.id,
      status: turn.status,
      input: turn.input,
      text: turn.messages.flatMap((message) => ('assistant' in message && message.assistant.text ? [message.assistant.text] : [])).join('\n\n'),
      modelId: turn.modelId,
      errorCode: turn.errorCode,
      endpointId: turn.endpointId,
      reasoningEffort: turn.reasoningEffort,
      reasoningText: turn.reasoningText,
      usage: turn.usage,
      contextUsage: turn.contextUsage,
    })),
  }
}

export function trimHistory(turns: readonly StoredTurn[], maxTokens: number): StoredMessage[] {
  const kept: StoredTurn[] = []
  let chars = 0
  for (const turn of [...turns].reverse()) {
    if (turn.status !== 'completed') continue
    chars += charCount(turn.input)
    for (const message of turn.messages) chars += charCount('user' in message ? message.user : JSON.stringify(message.assistant))
    if (Math.ceil(chars / 3) > maxTokens) break
    kept.push(turn)
  }
  return kept.reverse().flatMap((turn) => [{ user: turn.input }, ...turn.messages])
}

const INSERT_TURN = `INSERT INTO ai_chat_turns (id, user_id, conversation_id, seq, status, input, created_at)
  SELECT ?1, ?2, ?3, COALESCE(MAX(seq), 0) + 1, 'running', ?4, ?5 FROM ai_chat_turns WHERE conversation_id = ?3`

export async function beginTurn(
  db: D1Database,
  userId: string,
  conversationId: string | null,
  scope: string | null,
  input: string,
): Promise<TurnHandle> {
  const now = Date.now()
  const turnId = newId()
  if (conversationId) {
    const [touched] = await db.batch([
      db.prepare('UPDATE ai_chat_conversations SET updated_at = ?1 WHERE id = ?2 AND user_id = ?3').bind(now, conversationId, userId),
      db
        .prepare(`${INSERT_TURN} AND EXISTS (SELECT 1 FROM ai_chat_conversations WHERE id = ?3 AND user_id = ?2)`)
        .bind(turnId, userId, conversationId, input, now),
    ])
    if (!touched?.meta.changes) throw notFound('conversation')
    return { conversationId, turnId }
  }
  const id = newId()
  const title = [...input.replace(/[\r\n]/g, '')].slice(0, 40).join('')
  await db.batch([
    db
      .prepare('INSERT INTO ai_chat_conversations (id, user_id, title, scope, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)')
      .bind(id, userId, title, scope, now),
    db.prepare(INSERT_TURN).bind(turnId, userId, id, input, now),
  ])
  return { conversationId: id, turnId }
}

export async function regenerateTurn(db: D1Database, userId: string, conversationId: string): Promise<TurnHandle> {
  const last = await db
    .prepare('SELECT id FROM ai_chat_turns WHERE conversation_id = ?1 AND user_id = ?2 ORDER BY seq DESC LIMIT 1')
    .bind(conversationId, userId)
    .first<{ id: string }>()
  if (!last) throw notFound('turn')
  const now = Date.now()
  const [reset] = await db.batch([
    db
      .prepare(
        `UPDATE ai_chat_turns SET status = 'running', messages = '[]', model_id = NULL, error_code = NULL,
           input_tokens = NULL, output_tokens = NULL, cache_read_tokens = NULL, cache_write_tokens = NULL, reasoning_tokens = NULL,
           context_usage = NULL, endpoint_id = NULL, reasoning_effort = NULL, reasoning_text = NULL, created_at = ?1
         WHERE id = ?2 AND user_id = ?3 AND (status != 'running' OR created_at < ?4)`,
      )
      .bind(now, last.id, userId, now - STALE_RUNNING_MS),
    db
      .prepare(
        `UPDATE ai_chat_conversations SET updated_at = ?1 WHERE id = ?2 AND user_id = ?3
         AND EXISTS (SELECT 1 FROM ai_chat_turns WHERE id = ?4 AND status = 'running' AND created_at = ?1)`,
      )
      .bind(now, conversationId, userId, last.id),
  ])
  if (!reset?.meta.changes) throw conflict('turn_running')
  return { conversationId, turnId: last.id }
}

export async function finishTurn(db: D1Database, userId: string, turn: TurnHandle, record: TurnRecord): Promise<void> {
  await db.batch([
    db
      .prepare(
        `UPDATE ai_chat_turns SET status = ?1, messages = ?2, model_id = ?3, error_code = ?4, input_tokens = ?5, output_tokens = ?6,
          cache_read_tokens = ?7, cache_write_tokens = ?8, reasoning_tokens = ?9, context_usage = ?10, endpoint_id = ?11, reasoning_effort = ?12, reasoning_text = ?13
         WHERE id = ?14 AND conversation_id = ?15 AND user_id = ?16 AND status = 'running'`,
      )
      .bind(
        record.status, JSON.stringify(record.messages), record.modelId, record.errorCode,
        record.usage.inputTokens, record.usage.outputTokens, record.usage.cacheReadTokens, record.usage.cacheWriteTokens, record.usage.reasoningTokens,
        JSON.stringify(record.contextUsage), record.endpointId, record.reasoningEffort, record.reasoningText,
        turn.turnId, turn.conversationId, userId,
      ),
    db.prepare('UPDATE ai_chat_conversations SET updated_at = ?1 WHERE id = ?2 AND user_id = ?3').bind(Date.now(), turn.conversationId, userId),
  ])
}

export async function deleteConversation(db: D1Database, userId: string, id: string): Promise<void> {
  const [, removed] = await db.batch([
    db.prepare('DELETE FROM ai_chat_turns WHERE conversation_id = ?1 AND user_id = ?2').bind(id, userId),
    db.prepare('DELETE FROM ai_chat_conversations WHERE id = ?1 AND user_id = ?2').bind(id, userId),
  ])
  if (!removed?.meta.changes) throw notFound('conversation')
}

export async function renameConversation(db: D1Database, userId: string, id: string, title: string): Promise<ConversationSummary> {
  const trimmed = title.trim()
  if (!trimmed) throw badRequest('title', 'empty')
  const summary = await db
    .prepare(`UPDATE ai_chat_conversations SET title = ?1 WHERE id = ?2 AND user_id = ?3 RETURNING ${SUMMARY}`)
    .bind(trimmed, id, userId)
    .first<ConversationSummary>()
  if (!summary) throw notFound('conversation')
  return summary
}
