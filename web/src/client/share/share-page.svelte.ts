import type { PublicNote } from '@shared/types'
import type { Logger } from '@app/log/logger'
import type { MessageKey } from '@shared/locales/en-US'
import type { FetchLike } from '../backend/transport'

export type ShareStatus =
  'loading' | 'passwordRequired' | 'ready' | 'unavailable' | 'failed'

export class SharePageState {
  status = $state<ShareStatus>('loading')
  note = $state.raw<PublicNote | null>(null)
  errorKey = $state<MessageKey | null>(null)
  retryAfter = $state(0)
  #request: AbortController | null = null
  #generation = 0
  #disposed = false
  constructor(
    private readonly deps: {
      fetch: FetchLike
      logger: Logger
      clientId: string
      origin: string
      getLocale(): string
    },
  ) {}

  async load(slug: string, password?: string): Promise<void> {
    this.#request?.abort()
    const generation = ++this.#generation
    const controller = new AbortController()
    this.#request = controller
    this.status = 'loading'
    this.note = null
    this.errorKey = null
    this.retryAfter = 0
    try {
      const requestUrl = `${this.deps.origin}/api/public/${encodeURIComponent(slug)}`
      const response = await this.deps.fetch(
        new Request(requestUrl, {
          method: 'POST',
          credentials: 'same-origin',
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/json',
            'X-AutoNote-Client': '1',
            'X-AutoNote-Origin': this.deps.clientId,
            'Accept-Language': this.deps.getLocale(),
          },
          body: JSON.stringify(password ? { password } : {}),
        }),
      )
      const payload: unknown = await response.json()
      if (
        generation !== this.#generation ||
        controller.signal.aborted ||
        this.#disposed
      )
        return
      if (!response.ok) {
        const error =
          payload && typeof payload === 'object' && 'error' in payload
            ? payload.error
            : null
        const code =
          error && typeof error === 'object' && 'code' in error
            ? error.code
            : null
        if (
          response.status === 401 &&
          (code === 'password_required' || code === 'password_invalid')
        ) {
          this.status = 'passwordRequired'
          this.errorKey =
            code === 'password_invalid' ? 'share.incorrect_passcode' : null
        } else if (response.status === 404) this.status = 'unavailable'
        else {
          this.status = 'failed'
          this.errorKey =
            response.status === 429
              ? 'api.error.too_many_attempts'
              : 'share.content_unavailable'
          const details =
            error && typeof error === 'object' && 'details' in error
              ? error.details
              : null
          const retryAfter =
            details && typeof details === 'object' && 'retryAfter' in details
              ? details.retryAfter
              : null
          if (
            typeof retryAfter === 'number' &&
            Number.isFinite(retryAfter) &&
            retryAfter > 0
          )
            this.retryAfter = Math.ceil(retryAfter)
        }
        this.deps.logger.warn('share.read.failed', {
          code: typeof code === 'string' ? code : 'internal',
          status: response.status,
        })
        return
      }
      if (!isPublicNote(payload) || payload.share.slug !== slug) {
        this.status = 'failed'
        this.errorKey = 'api.error.invalid_response'
        this.deps.logger.warn('share.read.failed', {
          code: 'invalid_response',
          status: response.status,
        })
        return
      }
      this.note = payload
      this.status = 'ready'
    } catch (error) {
      if (
        generation !== this.#generation ||
        controller.signal.aborted ||
        this.#disposed
      )
        return
      this.status = 'failed'
      this.errorKey =
        error instanceof SyntaxError
          ? 'api.error.invalid_response'
          : 'api.error.offline'
      this.deps.logger.warn('share.read.failed', {
        code: error instanceof SyntaxError ? 'invalid_response' : 'offline',
      })
    } finally {
      if (this.#request === controller) this.#request = null
    }
  }

  dispose(): void {
    this.#disposed = true
    ++this.#generation
    this.#request?.abort()
    this.note = null
  }
}

export function isPublicNote(value: unknown): value is PublicNote {
  if (!value || typeof value !== 'object') return false
  const note = value as Record<string, unknown>
  return (
    typeof note.title === 'string' &&
    typeof note.content === 'string' &&
    typeof note.createdAt === 'number' &&
    Number.isSafeInteger(note.createdAt) &&
    note.createdAt >= 0 &&
    note.createdAt <= 8.64e15 &&
    typeof note.updatedAt === 'number' &&
    Number.isSafeInteger(note.updatedAt) &&
    note.updatedAt >= 0 &&
    note.updatedAt <= 8.64e15 &&
    !!note.author &&
    typeof note.author === 'object' &&
    'name' in note.author &&
    typeof note.author.name === 'string' &&
    'avatarUrl' in note.author &&
    typeof note.author.avatarUrl === 'string' &&
    !!note.site &&
    typeof note.site === 'object' &&
    'name' in note.site &&
    typeof note.site.name === 'string' &&
    !!note.share &&
    typeof note.share === 'object' &&
    'slug' in note.share &&
    typeof note.share.slug === 'string'
  )
}
