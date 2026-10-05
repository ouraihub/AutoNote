import { CLIENT_HEADER } from '@shared/constants'
import { BackendError } from '@app/backend/errors'
import type { Logger } from '@app/log/logger'
import type { Timers } from '../platform/timers'
import { errorFromResponse, isAbortError, toBackendError } from './errors'
import type { TabBus } from './tab-bus'

export type FetchLike = (request: Request) => Promise<Response>

export interface RequestSpec {
  readonly method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  readonly path: `/api/${string}`
  readonly query?: Readonly<Record<string, string | number | boolean | undefined>>
  readonly body?: unknown
  readonly form?: FormData
  readonly signal?: AbortSignal | undefined
  readonly timeoutMs?: number
}

export interface HttpTransportDeps {
  readonly fetch: FetchLike
  readonly clientId: string
  readonly getLocale: () => string
  readonly bus: TabBus
  readonly timers: Timers
  readonly logger: Logger
  readonly captureCurrent?: () => () => boolean
}

const NOTIFY_PATH = /^\/api\/(?:notes(?:\/|\?|$)|folders(?:\/|\?|$)|tags(?:\/|\?|$)|import(?:\/|\?|$))/

export class HttpTransport {
  readonly #fetch: FetchLike
  readonly #clientId: string
  readonly #getLocale: () => string
  readonly #bus: TabBus
  readonly #timers: Timers
  readonly #captureCurrent: HttpTransportDeps['captureCurrent']

  constructor(deps: HttpTransportDeps) {
    this.#fetch = deps.fetch
    this.#clientId = deps.clientId
    this.#getLocale = deps.getLocale
    this.#bus = deps.bus
    this.#timers = deps.timers
    this.#captureCurrent = deps.captureCurrent
  }

  async json<T>(spec: RequestSpec): Promise<T> {
    const current = this.#captureCurrent?.()
    const response = await this.#request(spec)
    if (spec.signal?.aborted || current?.() === false) throw new BackendError('cancelled', 0, 'Request superseded')
    if (!response.ok) {
      const payload = isJsonResponse(response) ? parseJson(await response.text()) : undefined
      if (spec.signal?.aborted || current?.() === false) throw new BackendError('cancelled', 0, 'Request superseded')
      throw errorFromResponse(response, payload)
    }
    if (response.status === 204) {
      this.#notifyOtherTabs(spec)
      return undefined as T
    }
    const json = isJsonResponse(response)
    const text = await response.text()
    if (spec.signal?.aborted || current?.() === false) throw new BackendError('cancelled', 0, 'Request superseded')
    if (!json) {
      this.#notifyOtherTabs(spec)
      return text as T
    }
    if (text.trim() === '') throw new BackendError('invalid_response', 502, 'Invalid server response')
    const parsed = parseJson(text)
    if (parsed === undefined) throw new BackendError('invalid_response', 502, 'Invalid server response')
    this.#notifyOtherTabs(spec)
    return parsed as T
  }
  async raw(spec: RequestSpec): Promise<Response> {
    const current = this.#captureCurrent?.()
    const response = await this.#request(spec)
    if (spec.signal?.aborted || current?.() === false) throw new BackendError('cancelled', 0, 'Request superseded')
    if (!response.ok) {
      const payload = isJsonResponse(response) ? parseJson(await response.text()) : undefined
      if (spec.signal?.aborted || current?.() === false) throw new BackendError('cancelled', 0, 'Request superseded')
      throw errorFromResponse(response, payload)
    }
    this.#notifyOtherTabs(spec)
    return response
  }

  #notifyOtherTabs(spec: RequestSpec): void {
    const method = spec.method ?? 'GET'
    const path = appendQuery(spec.path, spec.query)
    if (method !== 'GET' && NOTIFY_PATH.test(path)) this.#bus.post({ type: 'local-write', clientId: this.#clientId })
  }

  async #request(spec: RequestSpec): Promise<Response> {
    const method = spec.method ?? 'GET'
    const path = appendQuery(spec.path, spec.query)
    if (spec.body !== undefined && spec.form !== undefined) {
      throw new BackendError('bad_request', 0, 'A request cannot contain both JSON and form data')
    }

    const headers = new Headers({
      [CLIENT_HEADER]: '1',
      'X-AutoNote-Origin': this.#clientId,
      'Accept-Language': this.#getLocale(),
    })
    let body: BodyInit | undefined
    if (spec.form !== undefined) body = spec.form
    else if (spec.body !== undefined) {
      headers.set('Content-Type', 'application/json')
      body = JSON.stringify(spec.body)
    }

    const timeoutMs = spec.timeoutMs
    const timeoutEnabled = typeof timeoutMs === 'number' && timeoutMs > 0
    const controller = timeoutEnabled ? new AbortController() : undefined
    let timedOut = false
    let cancelled = Boolean(spec.signal?.aborted)
    let timeoutId: number | undefined
    let removeAbortListener: (() => void) | undefined
    if (controller && timeoutMs !== undefined) {
      const abortFromCaller = (): void => {
        cancelled = true
        controller.abort(spec.signal?.reason)
      }
      if (spec.signal?.aborted) abortFromCaller()
      else if (spec.signal) {
        spec.signal.addEventListener('abort', abortFromCaller, { once: true })
        removeAbortListener = () => spec.signal?.removeEventListener('abort', abortFromCaller)
      }
      timeoutId = this.#timers.setTimeout(() => {
        timedOut = true
        controller.abort()
      }, timeoutMs)
    }

    try {
      return await this.#fetch(
        new Request(toRequestUrl(path), {
          method,
          headers,
          body: body ?? null,
          signal: controller?.signal ?? spec.signal ?? null,
          credentials: 'same-origin',
        }),
      )
    } catch (error) {
      if (timedOut) throw toBackendError(error, { timedOut: true })
      if (cancelled || spec.signal?.aborted || isAbortError(error)) throw toBackendError(error, { cancelled: true })
      throw toBackendError(error)
    } finally {
      if (timeoutId !== undefined) this.#timers.clearTimeout(timeoutId)
      removeAbortListener?.()
    }
  }
}

function appendQuery(path: string, query: RequestSpec['query']): string {
  if (!query) return path
  const entries = Object.entries(query).filter(([, value]) => value !== undefined && value !== '')
  if (entries.length === 0) return path
  const queryString = entries
    .map(
      ([key, value]) =>
        `${encodeURIComponent(key)}=${encodeURIComponent(typeof value === 'boolean' ? (value ? '1' : '0') : String(value))}`,
    )
    .join('&')
  return `${path}${path.includes('?') ? '&' : '?'}${queryString}`
}

function toRequestUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path
  const origin =
    typeof globalThis.location?.origin === 'string' ? globalThis.location.origin : 'http://autonote.invalid'
  return new URL(path, origin).toString()
}

function isJsonResponse(response: Response): boolean {
  const mediaType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  return mediaType === 'application/json' || Boolean(mediaType?.endsWith('+json'))
}

function parseJson(text: string): unknown {
  if (text.trim() === '') return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}
