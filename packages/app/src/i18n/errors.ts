import type { ErrorCode } from '@shared/backend-types'
import type { MessageKey } from '@shared/locales/en-US'

const MESSAGE_KEY_BY_ERROR_CODE: Record<ErrorCode, MessageKey> = {
  unauthenticated: 'api.error.unauthenticated',
  forbidden: 'api.error.forbidden',
  not_found: 'api.error.not_found',
  conflict: 'api.error.conflict',
  bad_request: 'api.error.bad_request',
  payload_too_large: 'api.error.payload_too_large',
  storage_unavailable: 'api.error.storage_unavailable',
  internal: 'api.error.internal',
  invalid_username: 'api.error.invalid_username',
  invalid_profile_name: 'api.error.invalid_profile_name',
  invalid_avatar: 'api.error.invalid_avatar',
  weak_password: 'api.error.weak_password',
  username_taken: 'api.error.username_taken',
  invalid_credentials: 'api.error.invalid_credentials',
  invalid_two_factor_code: 'api.error.invalid_two_factor_code',
  wrong_password: 'api.error.wrong_password',
  too_many_attempts: 'api.error.too_many_attempts',
  registration_closed: 'api.error.registration_closed',
  server_misconfigured: 'api.error.server_misconfigured',
  two_factor_already_enabled: 'api.error.two_factor_already_enabled',
  two_factor_challenge_expired: 'api.error.two_factor_challenge_expired',
  two_factor_not_enabled: 'api.error.two_factor_not_enabled',
  two_factor_setup_expired: 'api.error.two_factor_setup_expired',
  two_factor_unavailable: 'api.error.two_factor_unavailable',
  offline: 'api.error.offline',
  cancelled: 'api.error.cancelled',
  request_timeout: 'api.error.request_timeout',
  invalid_response: 'api.error.invalid_response',
}

export function messageKeyForError(code: ErrorCode): MessageKey {
  return MESSAGE_KEY_BY_ERROR_CODE[code]
}
