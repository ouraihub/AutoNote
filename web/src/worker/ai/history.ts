import type { Conversation, ConversationSummary, EndStatus, TurnStatus, ContextUsage, ReasoningEffort } from '@ouraihub/aether-ui/ports'
import { newId } from '../lib/id'
import { badRequest, charCount, conflict, notFound } from './kit'
import type { StoredMessage, Usage } from './protocol'
import type { ImageRow } from './images'
import { copyImages, imageRefs } from './images'

const STALE_RUNNING_MS = 15 * 60_000
const SUMMARY = 'id, title, scope, created_at AS createdAt, updated_at AS updatedAt, selected_turn_id AS selectedTurnId'

export interface StoredTurn {
  id: string
  parentId: string | null
  questionId: string
  supersedesId: string | null
  kind: 'reply' | 'translation'
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
  /** User input images; the only ones replayed to models. */
  images: ImageRow[]
  /** Images `generate_image` produced in this turn (docs/20 §3). */
  generated: ImageRow[]
}

export interface StoredConversation {
  summary: ConversationSummary
  revision: string
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
  const [summaries, rows, imageRows] = await db.batch([
    db.prepare(`SELECT ${SUMMARY}, revision FROM ai_chat_conversations WHERE id = ?1 AND user_id = ?2`).bind(id, userId),
    db.prepare(
      `SELECT id, parent_id AS parentId, question_id AS questionId, supersedes_id AS supersedesId, kind,
        status, input, messages, model_id AS modelId, endpoint_id AS endpointId, error_code AS errorCode, created_at AS createdAt,
        reasoning_effort AS reasoningEffort, reasoning_text AS reasoningText, context_usage AS contextUsage,
        input_tokens AS inputTokens, output_tokens AS outputTokens, cache_read_tokens AS cacheReadTokens, cache_write_tokens AS cacheWriteTokens, reasoning_tokens AS reasoningTokens
        FROM ai_chat_turns WHERE conversation_id = ?1 AND user_id = ?2 ORDER BY seq`,
    ).bind(id, userId),
    db.prepare(
      `SELECT i.turn_id AS turnId, i.idx, i.mime, i.object_key AS objectKey, i.kind FROM ai_turn_images i
       JOIN ai_chat_turns t ON t.id = i.turn_id AND t.user_id = i.user_id
       WHERE t.conversation_id = ?1 AND i.user_id = ?2 ORDER BY i.turn_id, i.idx`,
    ).bind(id, userId),
  ])
  const images = imageRows!.results as ImageRow[]
  const summary = summaries!.results[0] as (ConversationSummary & { revision: string }) | undefined
  const results = rows!.results as (Omit<StoredTurn, 'messages' | 'usage' | 'contextUsage' | 'images' | 'generated'> & Usage & { messages: string; createdAt: number; contextUsage: string | null })[]
  if (!summary) throw notFound('conversation')
  const stale = Date.now() - STALE_RUNNING_MS
  const { revision, ...wireSummary } = summary
  return {
    summary: wireSummary,
    revision,
    turns: results.map(({ createdAt, messages, contextUsage, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens, ...turn }) => ({
      ...turn,
      images: images.filter((image) => image.turnId === turn.id && image.kind === 'input'),
      generated: images.filter((image) => image.turnId === turn.id && image.kind === 'generated'),
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
      parentId: turn.parentId,
      questionId: turn.questionId,
      supersedesId: turn.supersedesId,
      kind: turn.kind,
      status: turn.status,
      input: turn.input,
      text: visibleText(turn),
      modelId: turn.modelId,
      errorCode: turn.errorCode,
      endpointId: turn.endpointId,
      reasoningEffort: turn.reasoningEffort,
      reasoningText: turn.reasoningText,
      usage: turn.usage,
      contextUsage: turn.contextUsage,
      images: imageRefs(summary.id, turn.id, turn.images),
      generated: imageRefs(summary.id, turn.id, turn.generated),
    })),
  }
}

export function visibleText(turn: StoredTurn): string {
  return turn.messages.flatMap((message) => ('assistant' in message && message.assistant.text ? [message.assistant.text] : [])).join('\n\n')
}

export function historyPath(turns: readonly StoredTurn[], head: string | null): StoredTurn[] {
  const byId = new Map(turns.map((turn) => [turn.id, turn]))
  const path: StoredTurn[] = []
  const seen = new Set<string>()
  while (head !== null) {
    if (seen.has(head)) throw conflict('history_cycle')
    seen.add(head)
    const turn = byId.get(head)
    if (!turn) throw notFound('turn')
    path.push(turn)
    head = turn.parentId
  }
  return path.reverse()
}

export function selectedHead(conversation: StoredConversation): string | null {
  return conversation.summary.selectedTurnId ?? conversation.turns.findLast((turn) => turn.status === 'completed')?.id ?? null
}

export function actionSource(conversation: StoredConversation, retryId: string | null, translationId: string | null, regenerate: boolean): StoredTurn | null {
  const id = retryId ?? translationId ?? (regenerate ? selectedHead(conversation) : null)
  if (id === null) {
    if (regenerate) throw notFound('turn')
    return null
  }
  const source = historyPath(conversation.turns, id).at(-1)!
  if (source.status === 'running') throw conflict('turn_running')
  return source
}

export function translationInput(source: StoredTurn, language: string): string {
  const text = visibleText(source)
  if (!text.trim()) throw badRequest('translateTurnId', 'empty_reply')
  return `Translate the following reply into ${language}. Return only the translation, preserving Markdown formatting.\n\n${text}`
}

export function trimHistory(turns: readonly StoredTurn[], maxTokens: number): StoredMessage[] {
  const kept: StoredTurn[] = []
  let chars = 0
  for (const turn of [...turns].reverse()) {
    if (turn.status !== 'completed') continue
    chars += charCount(turn.input)
    for (const message of turn.messages) chars += charCount('user' in message ? message.user : JSON.stringify('tool' in message ? message.tool : message.assistant))
    if (Math.ceil(chars / 3) > maxTokens) break
    kept.push(turn)
  }
  return kept.reverse().flatMap((turn) => [{ user: turn.input, turnId: turn.id }, ...turn.messages])
}

const IDLE = `NOT EXISTS (SELECT 1 FROM ai_chat_turns WHERE conversation_id = ?2 AND user_id = ?3 AND status = 'running' AND created_at >= ?5)`

function mutationGuard(db: D1Database, userId: string, conversation: StoredConversation, token: string): D1PreparedStatement {
  return db.prepare(`UPDATE ai_chat_conversations SET revision = ?1, updated_at = ?6 WHERE id = ?2 AND user_id = ?3 AND revision = ?4 AND ${IDLE}`)
    .bind(token, conversation.summary.id, userId, conversation.revision, Date.now() - STALE_RUNNING_MS, Date.now())
}


export async function beginAction(
  db: D1Database, userId: string, conversation: StoredConversation | null, scope: string | null,
  input: string, parentId: string | null, source: StoredTurn | null, translation: boolean,
): Promise<TurnHandle> {
  const now = Date.now(), turnId = newId(), token = newId()
  const id = conversation?.summary.id ?? newId()
  const parent = conversation ? historyPath(conversation.turns, parentId).at(-1) : undefined
  if (!source && parent && parent.status !== 'completed') throw conflict('turn_not_completed')
  const questionId = source && !translation ? source.questionId : turnId
  const insert = db.prepare(`INSERT INTO ai_chat_turns (id, user_id, conversation_id, seq, status, input, created_at, parent_id, question_id, supersedes_id, kind)
    SELECT ?1, ?2, ?3, COALESCE(MAX(seq), 0) + 1, 'running', ?4, ?5, ?6, ?7, ?8, ?9
    FROM ai_chat_turns WHERE conversation_id = ?3 AND user_id = ?2
    HAVING EXISTS (SELECT 1 FROM ai_chat_conversations WHERE id = ?3 AND user_id = ?2 AND revision = ?10)`)
    .bind(turnId, userId, id, input, now, parentId, questionId, source && !translation ? source.id : null, translation ? 'translation' : source?.kind ?? 'reply', token)
  const [guard, inserted] = await db.batch([
    conversation ? mutationGuard(db, userId, conversation, token)
      : db.prepare('INSERT INTO ai_chat_conversations (id, user_id, title, scope, created_at, updated_at, revision) VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6)')
        .bind(id, userId, [...input.replace(/[\r\n]/g, '')].slice(0, 40).join(''), scope, now, token),
    insert,
  ])
  if (!guard?.meta.changes || !inserted?.meta.changes) throw conflict('conversation_changed_or_running')
  return { conversationId: id, turnId }
}

export async function finishTurn(db: D1Database, userId: string, turn: TurnHandle, record: TurnRecord): Promise<void> {
  const [finished] = await db.batch([
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
    db.prepare(`UPDATE ai_chat_conversations SET updated_at = ?1, revision = ?5,
      selected_turn_id = CASE WHEN ?6 = 'completed' AND EXISTS (
        SELECT 1 FROM ai_chat_turns WHERE id = ?4 AND conversation_id = ?2 AND user_id = ?3 AND status = 'completed' AND supersedes_id IS NULL
      ) THEN ?4 ELSE selected_turn_id END WHERE id = ?2 AND user_id = ?3`)
      .bind(Date.now(), turn.conversationId, userId, turn.turnId, newId(), record.status),
  ])
  if (!finished?.meta.changes) throw conflict('turn_changed')
}

export async function editTurn(db: D1Database, userId: string, id: string, turnId: string, text: string, expectedText: string): Promise<Conversation> {
  if (!text.trim()) throw badRequest('text', 'empty')
  if (charCount(text) > 24_000) throw badRequest('text', 'too_long', 24_000)
  const conversation = await loadConversation(db, userId, id)
  const turn = historyPath(conversation.turns, turnId).at(-1)!
  if (turn.status === 'running') throw conflict('turn_running')
  if (conversation.turns.some((candidate) => candidate.parentId === turnId || candidate.supersedesId === turnId)) throw conflict('turn_has_dependents')
  if (visibleText(turn) !== expectedText) throw conflict('text_changed')
  const token = newId()
  const [guard, edited] = await db.batch([
    mutationGuard(db, userId, conversation, token),
    db.prepare(`UPDATE ai_chat_turns SET messages = ?1, reasoning_text = '', context_usage = NULL
      WHERE id = ?2 AND conversation_id = ?3 AND user_id = ?4 AND EXISTS (
        SELECT 1 FROM ai_chat_conversations WHERE id = ?3 AND user_id = ?4 AND revision = ?5
      )`).bind(JSON.stringify([{ assistant: { text, tool_calls: [] } }]), turnId, id, userId, token),
  ])
  if (!guard?.meta.changes || !edited?.meta.changes) throw conflict('conversation_changed_or_running')
  return toWire(await loadConversation(db, userId, id))
}

export async function removeTurn(db: D1Database, userId: string, id: string, turnId: string): Promise<Conversation> {
  const conversation = await loadConversation(db, userId, id)
  historyPath(conversation.turns, turnId)
  if (conversation.summary.selectedTurnId === turnId) throw conflict('turn_selected')
  if (conversation.turns.some((candidate) => candidate.parentId === turnId || candidate.supersedesId === turnId)) throw conflict('turn_has_dependents')
  const token = newId()
  const [guard, removed] = await db.batch([
    mutationGuard(db, userId, conversation, token),
    db.prepare(`DELETE FROM ai_chat_turns WHERE id = ?1 AND conversation_id = ?2 AND user_id = ?3 AND EXISTS (
      SELECT 1 FROM ai_chat_conversations WHERE id = ?2 AND user_id = ?3 AND revision = ?4
    )`).bind(turnId, id, userId, token),
  ])
  if (!guard?.meta.changes || !removed?.meta.changes) throw conflict('conversation_changed_or_running')
  return toWire(await loadConversation(db, userId, id))
}

export async function selectTurn(db: D1Database, userId: string, id: string, turnId: string): Promise<Conversation> {
  const conversation = await loadConversation(db, userId, id)
  const turn = historyPath(conversation.turns, turnId).at(-1)!
  if (turn.status !== 'completed') throw conflict('turn_not_completed')
  const token = newId()
  const [guard, selected] = await db.batch([
    mutationGuard(db, userId, conversation, token),
    db.prepare('UPDATE ai_chat_conversations SET selected_turn_id = ?1 WHERE id = ?2 AND user_id = ?3 AND revision = ?4').bind(turnId, id, userId, token),
  ])
  if (!guard?.meta.changes || !selected?.meta.changes) throw conflict('conversation_changed_or_running')
  return toWire(await loadConversation(db, userId, id))
}

export async function forkConversation(db: D1Database, userId: string, id: string, turnId: string): Promise<Conversation> {
  const conversation = await loadConversation(db, userId, id)
  const path = historyPath(conversation.turns, turnId)
  if (path.some((turn) => turn.status === 'running')) throw conflict('turn_running')
  const token = newId(), forkId = newId(), now = Date.now()
  const ids = new Map(path.map((turn) => [turn.id, newId()]))
  const questions = new Map(path.map((turn) => [turn.questionId, ids.get(turn.questionId) ?? newId()]))
  const statements = [
    mutationGuard(db, userId, conversation, token),
    db.prepare(`INSERT INTO ai_chat_conversations (id, user_id, title, scope, created_at, updated_at, selected_turn_id)
      SELECT ?1, user_id, title, scope, ?2, ?2, ?3 FROM ai_chat_conversations WHERE id = ?4 AND user_id = ?5 AND revision = ?6`)
      .bind(forkId, now, ids.get(turnId)!, id, userId, token),
    ...path.map((turn, index) => db.prepare(`INSERT INTO ai_chat_turns (
      id, user_id, conversation_id, seq, parent_id, question_id, supersedes_id, kind, status, input, messages,
      model_id, endpoint_id, error_code, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens,
      reasoning_effort, reasoning_text, context_usage, created_at
    ) SELECT ?1, user_id, ?2, ?3, ?4, ?5, ?6, kind, status, input, messages,
      model_id, endpoint_id, error_code, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens,
      reasoning_effort, reasoning_text, context_usage, created_at FROM ai_chat_turns
      WHERE id = ?7 AND conversation_id = ?8 AND user_id = ?9 AND EXISTS (
        SELECT 1 FROM ai_chat_conversations WHERE id = ?8 AND user_id = ?9 AND revision = ?10
      )`).bind(ids.get(turn.id)!, forkId, index + 1, turn.parentId ? ids.get(turn.parentId)! : null,
        questions.get(turn.questionId)!, turn.supersedesId ? ids.get(turn.supersedesId) ?? null : null, turn.id, id, userId, token)),
  ]
  const results = await db.batch(statements)
  if (results.some((result) => !result.meta.changes)) throw conflict('conversation_changed_or_running')
  await copyImages(db, userId, path.map((turn) => [turn.id, ids.get(turn.id)!] as const))
  return toWire(await loadConversation(db, userId, forkId))
}

export async function deleteConversation(db: D1Database, userId: string, id: string): Promise<void> {
  const conversation = await loadConversation(db, userId, id), token = newId()
  const [guard, , removed] = await db.batch([
    mutationGuard(db, userId, conversation, token),
    db.prepare(`DELETE FROM ai_chat_turns WHERE conversation_id = ?1 AND user_id = ?2 AND EXISTS (
      SELECT 1 FROM ai_chat_conversations WHERE id = ?1 AND user_id = ?2 AND revision = ?3
    )`).bind(id, userId, token),
    db.prepare('DELETE FROM ai_chat_conversations WHERE id = ?1 AND user_id = ?2 AND revision = ?3').bind(id, userId, token),
  ])
  if (!guard?.meta.changes || !removed?.meta.changes) throw conflict('conversation_changed_or_running')
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
