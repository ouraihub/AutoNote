import { z } from 'zod'
import { BackendError } from '@app/backend/errors'
import { KitClientError } from '@ouraihub/aether-ui/ports'
import type {
  Conversation,
  ConversationSummary,
  Details,
  KitErrorCode,
  KitPorts,
  ModelOption,
  ProbeResult,
  Provider,
  RunAccepted,
  RunEvent,
  SearchSettingsDto,
  SearchResult,
  SearchPage,
} from '@ouraihub/aether-ui/ports'
import { errorFromResponse, isAbortError } from '../errors'
import { readSseData } from '../sse'
import type { HttpTransport, RequestSpec } from '../transport'

type Transport = Pick<HttpTransport, 'json' | 'raw'>

const KIT_CODES = [
  'bad_request',
  'not_found',
  'conflict',
  'unsupported',
  'cancelled',
  'unauthorized',
  'forbidden',
  'rate_limited',
  'upstream',
  'timeout',
  'network',
  'needs_config',
  'budget_exceeded',
  'incompatible_db',
  'internal',
] as const satisfies readonly KitErrorCode[]

const KitCode = z.enum(KIT_CODES)
const ErrorBody = z.object({
  error: z.object({ code: KitCode, message: z.string(), details: z.record(z.string(), z.unknown()).optional() }),
})
const Frame = z.looseObject({ kind: z.string() })
const Accepted = z.object({ kind: z.literal('accepted'), runId: z.string(), conversationId: z.string().nullable() })

const AUTONOTE_CODES: Readonly<Record<string, KitErrorCode>> = {
  unauthenticated: 'unauthorized',
  too_many_attempts: 'rate_limited',
  payload_too_large: 'bad_request',
  offline: 'network',
  request_timeout: 'timeout',
}

const BASE = '/api/ai/kit'

function kitError(code: KitErrorCode, message: string, details?: Details): KitClientError {
  return new KitClientError(details ? { code, message, details } : { code, message })
}

function toKitError(error: unknown): KitClientError {
  if (error instanceof KitClientError) return error
  if (error instanceof BackendError) {
    const known = KitCode.safeParse(error.code)
    const code = known.success ? known.data : (AUTONOTE_CODES[error.code] ?? 'internal')
    return kitError(code, error.message, error.code === 'payload_too_large' ? { reason: 'too_large' } : undefined)
  }
  if (isAbortError(error)) return kitError('cancelled', 'Request cancelled')
  return kitError('internal', error instanceof Error ? error.message : String(error))
}

async function send(transport: Transport, spec: RequestSpec): Promise<Response> {
  let response: Response
  try {
    response = await transport.raw({ ...spec, allowErrorStatus: true })
  } catch (error) {
    throw toKitError(error)
  }
  if (response.ok) return response
  const payload: unknown = await response.json().catch(() => undefined)
  const body = ErrorBody.safeParse(payload)
  if (!body.success) throw toKitError(errorFromResponse(response, payload))
  const { code, message, details } = body.data.error
  throw kitError(code, message, details as Details | undefined)
}

async function call<T>(transport: Transport, spec: RequestSpec): Promise<T> {
  const response = await send(transport, spec)
  try {
    const value = (await response.json()) as T
    if (spec.signal?.aborted) throw kitError('cancelled', 'Request cancelled')
    return value
  } catch (error) {
    throw toKitError(error)
  }
}

async function run(
  transport: Transport,
  request: unknown,
  onEvent: (event: RunEvent) => void,
  signal: AbortSignal | undefined,
): Promise<RunAccepted> {
  if (signal?.aborted) throw kitError('cancelled', 'Request cancelled')
  const response = await send(transport, { method: 'POST', path: `${BASE}/runs`, body: request, signal })
  if (!response.body) throw kitError('internal', 'Expected event stream')
  const frames = readSseData(response.body, signal)[Symbol.asyncIterator]()
  let first: IteratorResult<string, void>
  try {
    first = await frames.next()
  } catch {
    throw signal?.aborted ? kitError('cancelled', 'Request cancelled') : kitError('network', 'Run stream failed')
  }
  if (signal?.aborted) throw kitError('cancelled', 'Request cancelled')
  if (first.done) throw kitError('network', 'Run stream ended before acceptance')
  let accepted: z.infer<typeof Accepted>
  try {
    accepted = Accepted.parse(JSON.parse(first.value))
  } catch {
    await frames.return?.()
    throw kitError('internal', 'Invalid event stream')
  }
  const pump = async (): Promise<RunEvent | undefined> => {
    try {
      for (let next = await frames.next(); !next.done && !signal?.aborted; next = await frames.next()) {
        const event = Frame.parse(JSON.parse(next.value)) as RunEvent
        if (event.kind === 'end') return event
        onEvent(event)
      }
      return undefined
    } finally {
      await frames.return?.()
    }
  }
  void pump()
    .catch(() => undefined)
    .then((end) =>
      onEvent(
        end ??
          (signal?.aborted
            ? { kind: 'end', status: 'cancelled' }
            : { kind: 'end', status: 'failed', error: { code: 'network', message: 'Run stream ended without end' } }),
      ),
    )
  return { runId: accepted.runId, conversationId: accepted.conversationId }
}

export function createHttpKitPorts(transport: Transport): KitPorts {
  return {
    search: {
      revealNeedsPassword: true,
      settings: (capability, options) =>
        call<SearchSettingsDto>(transport, {
          path: `${BASE}/search/settings`,
          query: { capability },
          signal: options?.signal,
        }),
      save: (body, options) =>
        call<SearchSettingsDto>(transport, {
          method: 'PUT',
          path: `${BASE}/search/providers`,
          body,
          signal: options?.signal,
        }),
      setDefault: (capability, provider, options) =>
        call<SearchSettingsDto>(transport, {
          method: 'PUT',
          path: `${BASE}/search/default`,
          body: { capability, provider },
          signal: options?.signal,
        }),
      savePreferences: (body, options) =>
        call<SearchSettingsDto['preferences']>(transport, {
          method: 'PUT',
          path: `${BASE}/search/preferences`,
          body,
          signal: options?.signal,
        }),
      saveKey: (capability, provider, value, keyId, options) =>
        call<SearchSettingsDto>(transport, {
          method: 'PUT',
          path: `${BASE}/search/keys`,
          body: { capability, provider, value, keyId },
          signal: options?.signal,
        }),
      removeKey: (capability, provider, keyId, options) =>
        call<SearchSettingsDto>(transport, {
          method: 'DELETE',
          path: `${BASE}/search/keys/${encodeURIComponent(keyId)}`,
          body: { capability, provider },
          signal: options?.signal,
        }),
      reveal: (capability, provider, keyId, currentPassword, options) =>
        call<string>(transport, {
          method: 'POST',
          path: `${BASE}/search/reveal`,
          body: { capability, provider, keyId, currentPassword },
          signal: options?.signal,
        }),
      check: (capability, provider, options) =>
        call<{ count: number }>(transport, {
          method: 'POST',
          path: `${BASE}/search/check`,
          body: { capability, provider },
          signal: options?.signal,
          timeoutMs: 30_000,
        }),
      search: (query, options) =>
        call<SearchResult>(transport, {
          method: 'POST',
          path: `${BASE}/search/query`,
          body: { query },
          signal: options?.signal,
          timeoutMs: 30_000,
        }),
      fetch: (url, options) =>
        call<SearchPage>(transport, {
          method: 'POST',
          path: `${BASE}/search/fetch`,
          body: { url },
          signal: options?.signal,
          timeoutMs: 30_000,
        }),
    },
    providers: {
      list: () => call<Provider[]>(transport, { path: `${BASE}/providers` }),
      save: (provider) => call<Provider[]>(transport, { method: 'PUT', path: `${BASE}/providers`, body: provider }),
      remove: (id) =>
        call<Provider[]>(transport, { method: 'DELETE', path: `${BASE}/providers/${encodeURIComponent(id)}` }),
      modelOptions: (filter = {}) =>
        call<ModelOption[]>(transport, {
          path: `${BASE}/model-options`,
          query: {
            modelType: filter.modelType,
            supportsTools: filter.supportsTools === undefined ? undefined : String(filter.supportsTools),
          },
        }),
      probe: (target, options) =>
        options?.signal?.aborted
          ? Promise.reject(kitError('cancelled', 'Request cancelled'))
          : call<ProbeResult>(transport, {
              method: 'POST',
              path: `${BASE}/probe`,
              body: target,
              signal: options?.signal,
            }),
    },
    chat: {
      run: (request, onEvent, options) => run(transport, request, onEvent, options?.signal),
      approve: () => Promise.reject(kitError('unsupported', 'Tool approval is not available on the web')),
      history: {
        list: (scope) => call<ConversationSummary[]>(transport, { path: `${BASE}/conversations`, query: { scope } }),
        get: (id) => call<Conversation>(transport, { path: `${BASE}/conversations/${encodeURIComponent(id)}` }),
        remove: async (id) => {
          await call<unknown>(transport, { method: 'DELETE', path: `${BASE}/conversations/${encodeURIComponent(id)}` })
        },
        rename: (id, title) =>
          call<ConversationSummary>(transport, {
            method: 'PATCH',
            path: `${BASE}/conversations/${encodeURIComponent(id)}`,
            body: { title },
          }),
      },
    },
  }
}
