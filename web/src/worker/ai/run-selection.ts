import type { ModelRef } from '@ouraihub/aether-contracts'
import { z } from 'zod'
import type { Env } from '../env'
import {
  actionSource,
  loadConversation,
  type StoredConversation,
} from './history'
import { ImagesSchema } from './images'
import { badRequest, needsConfig, notFound } from './kit'
import { modelOptions, resolveModel, type Connection } from './providers'
const WRITING_FIELD_MAX_BYTES = 24_000

const WRITING_TOTAL_MAX_BYTES = 80_000

const RefSchema = z.strictObject({
  endpointId: z.string(),
  modelId: z.string(),
})

export const RunRequestSchema = z.strictObject({
  purpose: z.string(),
  model: RefSchema.nullable().default(null),
  skills: z.array(
    z.strictObject({ id: z.string(), revision: z.number().int().min(0) }),
  ),
  context: z
    .strictObject({ kind: z.string(), id: z.string() })
    .nullable()
    .default(null),
  input: z.string(),
  conversationId: z.string().nullable().default(null),
  scope: z.string().nullable().default(null),
  regenerate: z.boolean(),
  replyToId: z.string().nullable().optional(),
  retryTurnId: z.string().nullable().optional(),
  translateTurnId: z.string().nullable().optional(),
  targetLanguage: z.string().nullable().optional(),
  webSearch: z.boolean().optional().default(false),
  reasoningEffort: z
    .enum([
      'default',
      'none',
      'auto',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ])
    .default('default'),
  permissionMode: z
    .enum(['default', 'plan', 'accept_edits', 'auto', 'full_access'])
    .default('default'),
  language: z.string(),
  images: ImagesSchema,
  generateImage: z.boolean().optional().default(false),
})

export type RunRequestInput = z.infer<typeof RunRequestSchema>

const WritingSchema = z.strictObject({
  action: z.string(),
  noteId: z.string(),
  selectedText: z.string(),
  beforeText: z.string(),
  afterText: z.string(),
  cursorOffset: z.number().int().min(0),
  language: z.string(),
  title: z.string(),
})

const bytes = (value: string): number => new TextEncoder().encode(value).length

function validateWriting(req: RunRequestInput): string {
  if (bytes(req.input) > WRITING_TOTAL_MAX_BYTES)
    throw badRequest('input', 'too_long')
  let raw: unknown
  try {
    raw = JSON.parse(req.input)
  } catch {
    throw badRequest('input', 'invalid_writing_request')
  }
  const parsed = WritingSchema.safeParse(raw)
  if (!parsed.success) throw badRequest('input', 'invalid_writing_request')
  const writing = parsed.data
  if (
    !['polish', 'rewrite', 'shorten', 'expand', 'continue'].includes(
      writing.action,
    )
  )
    throw badRequest('action', 'unsupported')
  if (!writing.noteId || bytes(writing.noteId) > 128)
    throw badRequest('noteId', 'invalid')
  if (writing.language !== 'zh-CN' && writing.language !== 'en-US')
    throw badRequest('language', 'unsupported')
  if (writing.cursorOffset > Number.MAX_SAFE_INTEGER)
    throw badRequest('cursorOffset', 'out_of_range')
  for (const field of [
    'selectedText',
    'beforeText',
    'afterText',
    'title',
  ] as const) {
    if (bytes(writing[field]) > WRITING_FIELD_MAX_BYTES)
      throw badRequest(field, 'too_long')
  }
  if (
    req.scope !== `note:${writing.noteId}:writing` ||
    req.conversationId !== null ||
    req.regenerate
  ) {
    throw badRequest('scope', 'invalid_writing_scope')
  }
  return writing.noteId
}

export async function liveNote(
  env: Env,
  userId: string,
  id: string,
): Promise<{ title: string; content: string }> {
  const note = await env.DB.prepare(
    'SELECT title, content FROM notes WHERE id = ?1 A' +
      'ND user_id = ?2 AND deleted_at IS NULL',
  )
    .bind(id, userId)
    .first<{ title: string; content: string }>()
  if (!note) throw notFound('note')
  return note
}

export async function selectModel(
  env: Env,
  userId: string,
  req: RunRequestInput,
): Promise<{ model: ModelRef; conversation: StoredConversation | null }> {
  let conversation: StoredConversation | null = null
  if (req.purpose !== 'chat' && req.purpose !== 'writing')
    throw badRequest('purpose', 'unsupported')
  if (req.purpose === 'writing' && req.webSearch)
    throw badRequest('webSearch', 'unsupported')
  if (
    req.purpose === 'writing' &&
    ['replyToId', 'retryTurnId', 'translateTurnId', 'targetLanguage'].some(
      (field) => req[field as keyof RunRequestInput] !== undefined,
    )
  )
    throw badRequest('purpose', 'writing_actions')
  if (req.purpose === 'writing') {
    const noteId = validateWriting(req)
    if (!req.context) throw badRequest('context', 'required')
    await liveNote(env, userId, noteId)
    if (req.context.id !== noteId) throw notFound('note')
  } else {
    if (req.conversationId !== null) {
      conversation = await loadConversation(env.DB, userId, req.conversationId)
      if (conversation.summary.scope !== req.scope)
        throw badRequest('scope', 'conversation_mismatch')
    }
    const scope = conversation ? conversation.summary.scope : req.scope
    if (scope?.startsWith('note:')) {
      const noteId = scope.slice(5).replace(/:writing$/, '')
      if (
        req.context &&
        (req.context.kind !== 'autonote-note' || req.context.id !== noteId)
      )
        throw badRequest('context', 'conversation_mismatch')
      await liveNote(env, userId, noteId)
    }
  }
  const options = await modelOptions(env.DB, userId, { modelType: 'chat' })
  const valid = (model: ModelRef | null | undefined): model is ModelRef =>
    !!model &&
    options.some(
      (option) =>
        option.endpointId === model.endpointId &&
        option.modelId === model.modelId,
    )
  if (req.purpose === 'chat') {
    const source = conversation
      ? actionSource(
          conversation,
          req.retryTurnId ?? null,
          req.translateTurnId ?? null,
          req.regenerate,
        )
      : null
    const chosen =
      req.model ??
      (source
        ? source.endpointId && source.modelId
          ? { endpointId: source.endpointId, modelId: source.modelId }
          : null
        : undefined)
    if (chosen !== undefined) {
      if (!valid(chosen)) throw needsConfig('model')
      return { model: chosen, conversation }
    }
  }
  const { results } = await env.DB.prepare(
    'SELECT role, endpoint_id AS endpointId, model_id' +
      ' AS modelId FROM ai_roles WHERE user_id = ?1',
  )
    .bind(userId)
    .all<{ role: string; endpointId: string | null; modelId: string | null }>()
  const chat = results.find((row) => row.role === 'chat')
  const row =
    req.purpose === 'writing'
      ? (results.find((candidate) => candidate.role === 'writing') ?? chat)
      : chat
  const binding =
    row?.endpointId && row.modelId
      ? { endpointId: row.endpointId, modelId: row.modelId }
      : null
  if (!valid(binding)) throw needsConfig('model')
  return { model: binding, conversation }
}

export async function paintingModel(
  env: Env,
  userId: string,
): Promise<Connection> {
  const row = await env.DB.prepare(
    'SELECT endpoint_id AS endpointId, model_id AS mo' +
      'delId FROM ai_roles WHERE user_id = ?1 AND role ' +
      "= 'painting'",
  )
    .bind(userId)
    .first<{ endpointId: string | null; modelId: string | null }>()
  const options =
    row?.endpointId && row.modelId
      ? await modelOptions(env.DB, userId, { modelType: 'image' })
      : []
  if (
    !row?.endpointId ||
    !row.modelId ||
    !options.some(
      (option) =>
        option.endpointId === row.endpointId && option.modelId === row.modelId,
    )
  )
    throw needsConfig('painting_model')
  return resolveModel(
    env,
    userId,
    { endpointId: row.endpointId, modelId: row.modelId },
    true,
  )
}
