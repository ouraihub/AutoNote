import { createI18n, setKitContext } from '@ouraihub/aether-ui'
import type { KitErrorCode } from '@ouraihub/aether-ui/ports'
import type { AiHostPort } from '../../backend/port'
import type { I18nState } from '../../i18n/runtime.svelte'
import type { Logger } from '../../log/logger'
import type { Notifier } from '../../platform/notifier'
import type { MessageKey } from '@shared/locales/en-US'

export function provideKitContext(aiHost: AiHostPort, app: I18nState, notifier: Notifier, logger: Logger): void {
  const translate = { 'en-US': createI18n('en-US').t, 'zh-CN': createI18n('zh-CN').t }
  setKitContext({
    ports: aiHost.kit,
    i18n: {
      get locale() {
        return app.locale
      },
      t: (key, params) => translate[app.locale](key, params),
    },
    notify: {
      toast: (kind, text) => notifier.toast({ key: 'ai.kit_message', params: { text }, tone: kind }),
      confirm: ({ title, body, danger }) =>
        notifier.confirm({
          titleKey: 'ai.kit_confirm_title',
          bodyKey: 'ai.kit_confirm_body',
          params: { title, body },
          ...(danger === undefined ? {} : { danger }),
        }),
    },
    logger,
  })
}

export const KIT_ERROR_KEYS: Partial<Record<KitErrorCode, MessageKey>> = {
  bad_request: 'api.error.bad_request',
  not_found: 'api.error.not_found',
  conflict: 'api.error.conflict',
  forbidden: 'api.error.forbidden',
  rate_limited: 'api.error.too_many_attempts',
  timeout: 'api.error.request_timeout',
  network: 'api.error.offline',
  budget_exceeded: 'api.error.payload_too_large',
  unauthorized: 'ai.error_unauthorized',
  upstream: 'ai.error_upstream',
  needs_config: 'ai.error_needs_config',
}
