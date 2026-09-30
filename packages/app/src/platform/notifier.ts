export type NotificationTone = 'info' | 'success' | 'warning' | 'error'

export interface NotificationAction {
  labelKey: string
  onInvoke(): void | Promise<void>
}

export interface NotificationRequest {
  id?: string
  key: string
  params?: Readonly<Record<string, string | number>>
  tone: NotificationTone
  action?: NotificationAction
}

export interface ConfirmationRequest {
  titleKey: string
  bodyKey: string
  danger?: boolean
}

export interface Notifier {
  toast(request: NotificationRequest): void
  confirm(request: ConfirmationRequest): Promise<boolean>
}
