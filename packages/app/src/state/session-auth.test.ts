import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { BackendError } from '@app/backend'
import { session, setup } from './session-test-fixtures'

describe('SessionState authentication', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  test('a late login response from a superseded\
 attempt cannot sign in the old account', async () => {
    const { account, state } = setup()
    const first = state.login('user-a', 'pw-a')
    const second = state.login('user-b', 'pw-b')

    account?.logins[1]?.reply.resolve(session('user-b'))
    await expect(second).resolves.toBe('authed')
    account?.logins[0]?.reply.resolve(session('user-a'))
    await expect(first).resolves.toBe('superseded')

    expect(state.user?.id).toBe('user-b')
  })

  test('a password login that needs TOTP stores\
 the challenge and completes with the code', async () => {
    const { account, notifier, state } = setup()
    const signingIn = state.login('user-a', 'pw')
    account?.logins[0]?.reply.resolve({
      twoFactorRequired: true,
      challengeToken: 'challenge-1',
      expiresAt: 5_000,
    })
    await expect(signingIn).resolves.toBe('challenge')
    expect(state.status).toBe('loading')
    expect(state.challenge?.challengeToken).toBe('challenge-1')

    const verifying = state.completeTotp('123456')
    expect(account?.totpLogins[0]).toMatchObject({
      token: 'challenge-1',
      code: '123456',
    })
    account?.totpLogins[0]?.reply.resolve({
      ...session('user-a'),
      recoveryCodeUsed: true,
      recoveryCodesRemaining: 1,
    })
    await expect(verifying).resolves.toBe('authed')

    expect(state.status).toBe('authed')
    expect(state.challenge).toBeNull()
    expect(notifier.toasts).toContainEqual(
      expect.objectContaining({
        key: 'auth.recovery_codes_remaining',
        params: { count: 1 },
        tone: 'error',
      }),
    )
  })

  test('an expired challenge is rejected loc\
ally with the challenge-expired code', async () => {
    const { account, setNow, state } = setup()
    const signingIn = state.login('user-a', 'pw')
    account?.logins[0]?.reply.resolve({
      twoFactorRequired: true,
      challengeToken: 'challenge-1',
      expiresAt: 5_000,
    })
    await signingIn

    setNow(5_000)
    await expect(state.completeTotp('123456')).resolves.toBe('rejected')

    expect(account?.totpLogins).toHaveLength(0)
    expect(state.authError).toBe('two_factor_challenge_expired')
    expect(state.challenge).toBeNull()
  })

  test('a server-side challenge expiry clears th\
e challenge, while a wrong code keeps it', async () => {
    const { account, state } = setup()
    const signingIn = state.login('user-a', 'pw')
    account?.logins[0]?.reply.resolve({
      twoFactorRequired: true,
      challengeToken: 'challenge-1',
      expiresAt: 50_000,
    })
    await signingIn

    const wrong = state.completeTotp('000000')
    account?.totpLogins[0]?.reply.reject(
      new BackendError('invalid_two_factor_code', 401, 'bad code'),
    )
    await expect(wrong).resolves.toBe('rejected')
    expect(state.authError).toBe('invalid_two_factor_code')
    expect(state.challenge?.challengeToken).toBe('challenge-1')

    const expired = state.completeTotp('111111')
    account?.totpLogins[1]?.reply.reject(
      new BackendError('two_factor_challenge_expired', 401, 'expired'),
    )
    await expect(expired).resolves.toBe('rejected')
    expect(state.authError).toBe('two_factor_challenge_expired')
    expect(state.challenge).toBeNull()
    expect(state.busy).toBe(false)
  })
})
