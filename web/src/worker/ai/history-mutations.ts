import type {
  Conversation,
  ConversationSummary,
} from '@ouraihub/aether-ui/ports'
import { newId } from '../lib/id'
import { badRequest, charCount, conflict, notFound } from './kit'

import { copyImages } from './images'

import {
  historyPath,
  loadConversation,
  toWire,
  visibleText,
  mutationGuard,
} from './history-read'
import type {
  StoredConversation,
  StoredTurn,
  TurnHandle,
  TurnRecord,
} from './history-read'

const SUMMARY =
  'id, title, scope, created_at AS createdAt, updated' +
  '_at AS updatedAt, selected_turn_id AS selectedTurn' +
  'Id'

export async function beginAction(
  db: D1Database,
  userId: string,
  conversation: StoredConversation | null,
  scope: string | null,
  input: string,
  parentId: string | null,
  source: StoredTurn | null,
  translation: boolean,
): Promise<TurnHandle> {
  const now = Date.now(),
    turnId = newId(),
    token = newId()
  const id = conversation?.summary.id ?? newId()
  const parent = conversation
    ? historyPath(conversation.turns, parentId).at(-1)
    : undefined
  if (!source && parent && parent.status !== 'completed')
    throw conflict('turn_not_completed')
  const questionId = source && !translation ? source.questionId : turnId
  const insert = db
    .prepare(
      'INSERT INTO ai_chat_turns (id, user_id, conversati' +
        'on_id, seq, status, input, created_at, parent_id, ' +
        'question_id, supersedes_id, kind)\n    SELECT ?1, ' +
        "?2, ?3, COALESCE(MAX(seq), 0) + 1, 'running', ?4, " +
        '?5, ?6, ?7, ?8, ?9\n    FROM ai_chat_turns WHERE c' +
        'onversation_id = ?3 AND user_id = ?2\n    HAVING E' +
        'XISTS (SELECT 1 FROM ai_chat_conversations WHERE i' +
        'd = ?3 AND user_id = ?2 AND revision = ?10)',
    )
    .bind(
      turnId,
      userId,
      id,
      input,
      now,
      parentId,
      questionId,
      source && !translation ? source.id : null,
      translation ? 'translation' : (source?.kind ?? 'reply'),
      token,
    )
  const [guard, inserted] = await db.batch([
    conversation
      ? mutationGuard(db, userId, conversation, token)
      : db
          .prepare(
            'INSERT INTO ai_chat_conversations (id, user_id, ti' +
              'tle, scope, created_at, updated_at, revision) VALU' +
              'ES (?1, ?2, ?3, ?4, ?5, ?5, ?6)',
          )
          .bind(
            id,
            userId,
            [...input.replace(/[\r\n]/g, '')].slice(0, 40).join(''),
            scope,
            now,
            token,
          ),
    insert,
  ])
  if (!guard?.meta.changes || !inserted?.meta.changes)
    throw conflict('conversation_changed_or_running')
  return { conversationId: id, turnId }
}

export async function finishTurn(
  db: D1Database,
  userId: string,
  turn: TurnHandle,
  record: TurnRecord,
): Promise<void> {
  const [finished] = await db.batch([
    db
      .prepare(
        'UPDATE ai_chat_turns SET status = ?1, messages = ?' +
          '2, model_id = ?3, error_code = ?4, input_tokens = ' +
          '?5, output_tokens = ?6,\n          cache_read_toke' +
          'ns = ?7, cache_write_tokens = ?8, reasoning_tokens' +
          ' = ?9, context_usage = ?10, endpoint_id = ?11, rea' +
          'soning_effort = ?12, reasoning_text = ?13,\n      ' +
          '    cost = ?17, cost_currency = ?18\n         WHER' +
          'E id = ?14 AND conversation_id = ?15 AND user_id =' +
          " ?16 AND status = 'running'",
      )
      .bind(
        record.status,
        JSON.stringify(record.messages),
        record.modelId,
        record.errorCode,
        record.usage.inputTokens,
        record.usage.outputTokens,
        record.usage.cacheReadTokens,
        record.usage.cacheWriteTokens,
        record.usage.reasoningTokens,
        JSON.stringify(record.contextUsage),
        record.endpointId,
        record.reasoningEffort,
        record.reasoningText,
        turn.turnId,
        turn.conversationId,
        userId,
        record.cost?.amount ?? null,
        record.cost?.currency ?? null,
      ),
    db
      .prepare(
        'UPDATE ai_chat_conversations SET updated_at = ?1, ' +
          'revision = ?5,\n      selected_turn_id = CASE WHEN' +
          " ?6 = 'completed' AND EXISTS (\n        SELECT 1 F" +
          'ROM ai_chat_turns WHERE id = ?4 AND conversation_i' +
          "d = ?2 AND user_id = ?3 AND status = 'completed' A" +
          'ND supersedes_id IS NULL\n      ) THEN ?4 ELSE sel' +
          'ected_turn_id END WHERE id = ?2 AND user_id = ?3',
      )
      .bind(
        Date.now(),
        turn.conversationId,
        userId,
        turn.turnId,
        newId(),
        record.status,
      ),
  ])
  if (!finished?.meta.changes) throw conflict('turn_changed')
}

export async function editTurn(
  db: D1Database,
  userId: string,
  id: string,
  turnId: string,
  text: string,
  expectedText: string,
): Promise<Conversation> {
  if (!text.trim()) throw badRequest('text', 'empty')
  if (charCount(text) > 24_000) throw badRequest('text', 'too_long', 24_000)
  const conversation = await loadConversation(db, userId, id)
  const turn = historyPath(conversation.turns, turnId).at(-1)!
  if (turn.status === 'running') throw conflict('turn_running')
  if (
    conversation.turns.some(
      (candidate) =>
        candidate.parentId === turnId || candidate.supersedesId === turnId,
    )
  )
    throw conflict('turn_has_dependents')
  if (visibleText(turn) !== expectedText) throw conflict('text_changed')
  const token = newId()
  const [guard, edited] = await db.batch([
    mutationGuard(db, userId, conversation, token),
    db
      .prepare(
        'UPDATE ai_chat_turns SET messages = ?1, reasoning_' +
          "text = '', context_usage = NULL\n      WHERE id = " +
          '?2 AND conversation_id = ?3 AND user_id = ?4 AND E' +
          'XISTS (\n        SELECT 1 FROM ai_chat_conversatio' +
          'ns WHERE id = ?3 AND user_id = ?4 AND revision = ?' +
          '5\n      )',
      )
      .bind(
        JSON.stringify([{ assistant: { text, tool_calls: [] } }]),
        turnId,
        id,
        userId,
        token,
      ),
  ])
  if (!guard?.meta.changes || !edited?.meta.changes)
    throw conflict('conversation_changed_or_running')
  return toWire(await loadConversation(db, userId, id))
}

export async function removeTurn(
  db: D1Database,
  userId: string,
  id: string,
  turnId: string,
): Promise<Conversation> {
  const conversation = await loadConversation(db, userId, id)
  const turn = historyPath(conversation.turns, turnId).at(-1)!
  if (turn.status === 'running') throw conflict('turn_running')
  const { turns } = conversation,
    at = turns.indexOf(turn)
  // Translations only make sense next to their source; turns are seq-ordered,
  // so one pass also catches translations of translations.
  const removed = new Set([turnId])
  for (const candidate of turns)
    if (
      candidate.kind === 'translation' &&
      candidate.parentId !== null &&
      removed.has(candidate.parentId)
    )
      removed.add(candidate.id)
  const successor =
    turns.find(
      (candidate, index) =>
        index > at &&
        candidate.kind === 'reply' &&
        candidate.questionId === turn.questionId,
    ) ??
    turns.findLast(
      (candidate, index) =>
        index < at &&
        candidate.kind === 'reply' &&
        candidate.questionId === turn.questionId,
    )
  const successorId = successor?.id ?? turn.parentId
  const remaining = turns
    .filter((candidate) => !removed.has(candidate.id))
    .map((candidate) =>
      candidate.parentId !== null && removed.has(candidate.parentId)
        ? { ...candidate, parentId: successorId }
        : candidate,
    )
  let selected = conversation.summary.selectedTurnId
  if (selected !== null && removed.has(selected)) {
    // Newest leaf under the successor (docs/35 §3.3 step 4).
    let next =
      successorId !== null
        ? remaining.find((candidate) => candidate.id === successorId)
        : remaining.findLast(
            (candidate) =>
              candidate.kind === 'reply' && candidate.parentId === null,
          )
    selected = null
    while (next) {
      const head: string = next.id
      selected = head
      next = remaining.findLast(
        (candidate) =>
          candidate.kind === 'reply' && candidate.parentId === head,
      )
    }
  }
  const token = newId(),
    ids = JSON.stringify([...removed])
  const owned =
    'conversation_id = ?2 AND user_id = ?3 AND EXISTS (' +
    'SELECT 1 FROM ai_chat_conversations WHERE id = ?2 ' +
    'AND user_id = ?3 AND revision = ?4)'
  // Reparent before deleting so no row ever points at a deleted turn.
  const [guard, , , deleted] = await db.batch([
    mutationGuard(db, userId, conversation, token),
    db
      .prepare(
        'UPDATE ai_chat_turns SET parent_id = ?1 WHERE pare' +
          'nt_id IN (SELECT value FROM json_each(?5)) AND ' +
          `${owned}`,
      )
      .bind(successorId, id, userId, token, ids),
    db
      .prepare(
        'UPDATE ai_chat_turns SET supersedes_id = CASE WHEN' +
          ' id = ?1 THEN NULL ELSE ?1 END WHERE supersedes_id' +
          ' = ?5 AND ' +
          `${owned}`,
      )
      .bind(successor?.id ?? null, id, userId, token, turnId),
    db
      .prepare(
        'DELETE FROM ai_chat_turns WHERE id IN (SELECT valu' +
          'e FROM json_each(?1)) AND ' +
          `${owned}`,
      )
      .bind(ids, id, userId, token),
    db
      .prepare(
        'UPDATE ai_chat_conversations SET selected_turn_id ' +
          '= ?1 WHERE id = ?2 AND user_id = ?3 AND revision =' +
          ' ?4',
      )
      .bind(selected, id, userId, token),
  ])
  if (!guard?.meta.changes || !deleted?.meta.changes)
    throw conflict('conversation_changed_or_running')
  return toWire(await loadConversation(db, userId, id))
}

export async function selectTurn(
  db: D1Database,
  userId: string,
  id: string,
  turnId: string,
): Promise<Conversation> {
  const conversation = await loadConversation(db, userId, id)
  const turn = historyPath(conversation.turns, turnId).at(-1)!
  if (turn.status !== 'completed') throw conflict('turn_not_completed')
  const token = newId()
  const [guard, selected] = await db.batch([
    mutationGuard(db, userId, conversation, token),
    db
      .prepare(
        'UPDATE ai_chat_conversations SET selected_turn_id ' +
          '= ?1 WHERE id = ?2 AND user_id = ?3 AND revision =' +
          ' ?4',
      )
      .bind(turnId, id, userId, token),
  ])
  if (!guard?.meta.changes || !selected?.meta.changes)
    throw conflict('conversation_changed_or_running')
  return toWire(await loadConversation(db, userId, id))
}

export async function forkConversation(
  db: D1Database,
  userId: string,
  id: string,
  turnId: string,
): Promise<Conversation> {
  const conversation = await loadConversation(db, userId, id)
  const path = historyPath(conversation.turns, turnId)
  if (path.some((turn) => turn.status === 'running'))
    throw conflict('turn_running')
  const token = newId(),
    forkId = newId(),
    now = Date.now()
  const ids = new Map(path.map((turn) => [turn.id, newId()]))
  const questions = new Map(
    path.map((turn) => [turn.questionId, ids.get(turn.questionId) ?? newId()]),
  )
  const statements = [
    mutationGuard(db, userId, conversation, token),
    db
      .prepare(
        'INSERT INTO ai_chat_conversations (id, user_id, ti' +
          'tle, scope, created_at, updated_at, selected_turn_' +
          'id)\n      SELECT ?1, user_id, title, scope, ?2, ?' +
          '2, ?3 FROM ai_chat_conversations WHERE id = ?4 AND' +
          ' user_id = ?5 AND revision = ?6',
      )
      .bind(forkId, now, ids.get(turnId)!, id, userId, token),
    ...path.map((turn, index) =>
      db
        .prepare(
          'INSERT INTO ai_chat_turns (\n      id, user_id, co' +
            'nversation_id, seq, parent_id, question_id, supers' +
            'edes_id, kind, status, input, messages,\n      mod' +
            'el_id, endpoint_id, error_code, input_tokens, outp' +
            'ut_tokens, cache_read_tokens, cache_write_tokens, ' +
            'reasoning_tokens,\n      reasoning_effort, reasoni' +
            'ng_text, context_usage, created_at, cost, cost_cur' +
            'rency\n    ) SELECT ?1, user_id, ?2, ?3, ?4, ?5, ?' +
            '6, kind, status, input, messages,\n      model_id,' +
            ' endpoint_id, error_code, input_tokens, output_tok' +
            'ens, cache_read_tokens, cache_write_tokens, reason' +
            'ing_tokens,\n      reasoning_effort, reasoning_tex' +
            't, context_usage, created_at, cost, cost_currency ' +
            'FROM ai_chat_turns\n      WHERE id = ?7 AND conver' +
            'sation_id = ?8 AND user_id = ?9 AND EXISTS (\n    ' +
            '    SELECT 1 FROM ai_chat_conversations WHERE id =' +
            ' ?8 AND user_id = ?9 AND revision = ?10\n      )',
        )
        .bind(
          ids.get(turn.id)!,
          forkId,
          index + 1,
          turn.parentId ? ids.get(turn.parentId)! : null,
          questions.get(turn.questionId)!,
          turn.supersedesId ? (ids.get(turn.supersedesId) ?? null) : null,
          turn.id,
          id,
          userId,
          token,
        ),
    ),
  ]
  const results = await db.batch(statements)
  if (results.some((result) => !result.meta.changes))
    throw conflict('conversation_changed_or_running')
  await copyImages(
    db,
    userId,
    path.map((turn) => [turn.id, ids.get(turn.id)!] as const),
  )
  return toWire(await loadConversation(db, userId, forkId))
}

export async function deleteConversation(
  db: D1Database,
  userId: string,
  id: string,
): Promise<void> {
  const conversation = await loadConversation(db, userId, id),
    token = newId()
  const [guard, , removed] = await db.batch([
    mutationGuard(db, userId, conversation, token),
    db
      .prepare(
        'DELETE FROM ai_chat_turns WHERE conversation_id = ' +
          '?1 AND user_id = ?2 AND EXISTS (\n      SELECT 1 F' +
          'ROM ai_chat_conversations WHERE id = ?1 AND user_i' +
          'd = ?2 AND revision = ?3\n    )',
      )
      .bind(id, userId, token),
    db
      .prepare(
        'DELETE FROM ai_chat_conversations WHERE id = ?1 AN' +
          'D user_id = ?2 AND revision = ?3',
      )
      .bind(id, userId, token),
  ])
  if (!guard?.meta.changes || !removed?.meta.changes)
    throw conflict('conversation_changed_or_running')
}

export async function renameConversation(
  db: D1Database,
  userId: string,
  id: string,
  title: string,
): Promise<ConversationSummary> {
  const trimmed = title.trim()
  if (!trimmed) throw badRequest('title', 'empty')
  const summary = await db
    .prepare(
      'UPDATE ai_chat_conversations SET title = ?1 WHERE ' +
        'id = ?2 AND user_id = ?3 RETURNING ' +
        `${SUMMARY}`,
    )
    .bind(trimmed, id, userId)
    .first<ConversationSummary>()
  if (!summary) throw notFound('conversation')
  return summary
}
