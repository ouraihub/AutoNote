import type {
  Conversation,
  ConversationSummary,
  Cost,
  EndStatus,
  TurnStatus,
  ContextUsage,
  ReasoningEffort,
} from '@ouraihub/aether-ui/ports'

import { badRequest, charCount, conflict, notFound } from './kit'
import type { Message as StoredMessage } from '@ouraihub/aether-core/types'
import type { TokenUsage as Usage } from '@ouraihub/aether-contracts'
import type { ImageRow } from './images'
import { imageRefs } from './images'

const STALE_RUNNING_MS = 15 * 60_000

const SUMMARY =
  'id, title, scope, created_at AS createdAt, updated' +
  '_at AS updatedAt, selected_turn_id AS selectedTurn' +
  'Id'

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
  cost: Cost | null
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
  cost: Cost | null
}

export async function listConversations(
  db: D1Database,
  userId: string,
  scope: string | null,
): Promise<ConversationSummary[]> {
  const { results } = await db
    .prepare(
      'SELECT ' +
        `${SUMMARY}` +
        ' FROM ai_chat_conversations WHERE user_id = ?1 AND' +
        ' (?2 IS NULL OR scope = ?2) ORDER BY updated_at DE' +
        'SC, id DESC LIMIT 200',
    )
    .bind(userId, scope)
    .all<ConversationSummary>()
  return results
}

export async function loadConversation(
  db: D1Database,
  userId: string,
  id: string,
): Promise<StoredConversation> {
  const [summaries, rows, imageRows] = await db.batch([
    db
      .prepare(
        'SELECT ' +
          `${SUMMARY}` +
          ', revision FROM ai_chat_conversations WHERE id = ?' +
          '1 AND user_id = ?2',
      )
      .bind(id, userId),
    db
      .prepare(
        'SELECT id, parent_id AS parentId, question_id AS q' +
          'uestionId, supersedes_id AS supersedesId, kind,\n ' +
          '       status, input, messages, model_id AS modelI' +
          'd, endpoint_id AS endpointId, error_code AS errorC' +
          'ode, created_at AS createdAt,\n        reasoning_e' +
          'ffort AS reasoningEffort, reasoning_text AS reason' +
          'ingText, context_usage AS contextUsage,\n        i' +
          'nput_tokens AS inputTokens, output_tokens AS outpu' +
          'tTokens, cache_read_tokens AS cacheReadTokens, cac' +
          'he_write_tokens AS cacheWriteTokens, reasoning_tok' +
          'ens AS reasoningTokens,\n        cost, cost_curren' +
          'cy AS costCurrency\n        FROM ai_chat_turns WHE' +
          'RE conversation_id = ?1 AND user_id = ?2 ORDER BY ' +
          'seq',
      )
      .bind(id, userId),
    db
      .prepare(
        'SELECT i.turn_id AS turnId, i.idx, i.mime, i.objec' +
          't_key AS objectKey, i.kind FROM ai_turn_images i\n' +
          '       JOIN ai_chat_turns t ON t.id = i.turn_id AN' +
          'D t.user_id = i.user_id\n       WHERE t.conversati' +
          'on_id = ?1 AND i.user_id = ?2 ORDER BY i.turn_id, ' +
          'i.idx',
      )
      .bind(id, userId),
  ])
  const images = imageRows!.results as ImageRow[]
  const summary = summaries!.results[0] as
    (ConversationSummary & { revision: string }) | undefined
  const results = rows!.results as (Omit<
    StoredTurn,
    'messages' | 'usage' | 'contextUsage' | 'images' | 'generated' | 'cost'
  > &
    Usage & {
      messages: string
      createdAt: number
      contextUsage: string | null
      cost: number | null
      costCurrency: Cost['currency'] | null
    })[]
  if (!summary) throw notFound('conversation')
  const stale = Date.now() - STALE_RUNNING_MS
  const { revision, ...wireSummary } = summary
  return {
    summary: wireSummary,
    revision,
    turns: results.map(
      ({
        createdAt,
        messages,
        contextUsage,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        reasoningTokens,
        cost,
        costCurrency,
        ...turn
      }) => ({
        ...turn,
        images: images.filter(
          (image) => image.turnId === turn.id && image.kind === 'input',
        ),
        generated: images.filter(
          (image) => image.turnId === turn.id && image.kind === 'generated',
        ),
        reasoningEffort: turn.reasoningEffort ?? 'default',
        reasoningText: turn.reasoningText ?? '',
        usage: {
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheWriteTokens,
          reasoningTokens,
        },
        cost:
          cost !== null && costCurrency !== null
            ? { amount: cost, currency: costCurrency }
            : null,
        contextUsage: contextUsage
          ? (JSON.parse(contextUsage) as ContextUsage)
          : null,
        messages: JSON.parse(messages) as StoredMessage[],
        ...(turn.status === 'running' && createdAt < stale
          ? {
              status: 'failed' as const,
              errorCode: 'interrupted',
              contextUsage: null,
            }
          : {}),
      }),
    ),
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
      cost: turn.cost,
      contextUsage: turn.contextUsage,
      images: imageRefs(summary.id, turn.id, turn.images),
      generated: imageRefs(summary.id, turn.id, turn.generated),
    })),
  }
}

export function visibleText(turn: StoredTurn): string {
  return turn.messages
    .flatMap((message) =>
      'assistant' in message && message.assistant.text
        ? [message.assistant.text]
        : [],
    )
    .join('\n\n')
}

export function historyPath(
  turns: readonly StoredTurn[],
  head: string | null,
): StoredTurn[] {
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
  return (
    conversation.summary.selectedTurnId ??
    conversation.turns.findLast((turn) => turn.status === 'completed')?.id ??
    null
  )
}

export function actionSource(
  conversation: StoredConversation,
  retryId: string | null,
  translationId: string | null,
  regenerate: boolean,
): StoredTurn | null {
  const id =
    retryId ?? translationId ?? (regenerate ? selectedHead(conversation) : null)
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
  return (
    'Translate the following reply into ' +
    `${language}` +
    '. Return only the translation, preserving Markdown' +
    ' formatting.\n\n' +
    `${text}`
  )
}

export function trimHistory(
  turns: readonly StoredTurn[],
  maxTokens: number,
): (StoredMessage & { turnId?: string })[] {
  const kept: StoredTurn[] = []
  let chars = 0
  for (const turn of [...turns].reverse()) {
    if (turn.status !== 'completed') continue
    chars += charCount(turn.input)
    for (const message of turn.messages)
      chars += charCount(
        'user' in message
          ? message.user
          : JSON.stringify(
              'tool' in message ? message.tool : message.assistant,
            ),
      )
    if (Math.ceil(chars / 3) > maxTokens) break
    kept.push(turn)
  }
  return kept
    .reverse()
    .flatMap((turn) => [
      { user: turn.input, turnId: turn.id },
      ...turn.messages,
    ])
}

const IDLE =
  'NOT EXISTS (SELECT 1 FROM ai_chat_turns WHERE conv' +
  "ersation_id = ?2 AND user_id = ?3 AND status = 'ru" +
  "nning' AND created_at >= ?5)"

export function mutationGuard(
  db: D1Database,
  userId: string,
  conversation: StoredConversation,
  token: string,
): D1PreparedStatement {
  return db
    .prepare(
      'UPDATE ai_chat_conversations SET revision = ?1, up' +
        'dated_at = ?6 WHERE id = ?2 AND user_id = ?3 AND r' +
        'evision = ?4 AND ' +
        `${IDLE}`,
    )
    .bind(
      token,
      conversation.summary.id,
      userId,
      conversation.revision,
      Date.now() - STALE_RUNNING_MS,
      Date.now(),
    )
}
