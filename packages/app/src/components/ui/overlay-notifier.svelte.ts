import { toast, type ExternalToast } from 'svelte-sonner'
import type { ConfirmationRequest, Notifier, NotificationRequest } from '@app/platform/notifier.ts'

export type MessageResolver = (key: string, params?: Readonly<Record<string, string | number>>) => string

interface PendingConfirmation {
  readonly request: ConfirmationRequest
  readonly resolve: (confirmed: boolean) => void
}

export class OverlayNotifier implements Notifier {
  readonly #resolveMessage: MessageResolver
  #pending: PendingConfirmation[] = []
  active = $state<PendingConfirmation | null>(null)
  open = $state(false)

  constructor(resolveMessage: MessageResolver) {
    this.#resolveMessage = resolveMessage
  }

  toast(request: NotificationRequest): void {
    const message = this.#resolveMessage(request.key, request.params)
    const options: ExternalToast = {}
    if (request.id !== undefined) options.id = request.id
    if (request.action) {
      options.action = {
        label: this.#resolveMessage(request.action.labelKey),
        onClick: () => {
          void request.action?.onInvoke()
        },
      }
    }

    if (request.tone === 'success') toast.success(message, options)
    else if (request.tone === 'warning') toast.warning(message, options)
    else if (request.tone === 'error') toast.error(message, options)
    else toast.info(message, options)
  }

  confirm(request: ConfirmationRequest): Promise<boolean> {
    const deferred = Promise.withResolvers<boolean>()
    this.#pending.push({ request, resolve: deferred.resolve })
    this.#showNext()
    return deferred.promise
  }
  settle(confirmed: boolean): void {
    const active = this.active
    if (!active) return
    this.active = null
    this.open = false
    active.resolve(confirmed)
    this.#showNext()
  }

  dismiss(): void {
    this.settle(false)
  }

  #showNext(): void {
    if (this.active || this.#pending.length === 0) return
    const next = this.#pending.shift()
    if (!next) return
    this.active = next
    this.open = true
  }
}
