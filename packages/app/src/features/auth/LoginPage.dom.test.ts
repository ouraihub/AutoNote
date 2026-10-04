import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { EN_US_MESSAGES } from '@shared/locales/en-US'
import type { TotpLoginChallenge } from '@shared/types'
import LoginPage, { type AuthSession } from './LoginPage.svelte'

const i18n = {
  locale: 'en-US' as const,
  t(
    key: keyof typeof EN_US_MESSAGES,
    params?: Readonly<Record<string, boolean | number | string | null | undefined>>,
  ): string {
    const template = EN_US_MESSAGES[key]
    return template.replace(/\{([A-Za-z0-9_]+)\}/g, (whole, name: string) => {
      const value = params?.[name]
      return value === null || value === undefined ? whole : String(value)
    })
  },
}

function session(overrides: Partial<AuthSession> = {}): AuthSession {
  return {
    canSignIn: true,
    site: {
      name: 'AutoNote',
      initialized: true,
      registrationOpen: true,
      r2Enabled: false,
      kvEnabled: false,
      attachmentStorage: null,
      realtimeEnabled: false,
      version: '1.0.0',
    },
    authError: null,
    challenge: null,
    busy: false,
    login: vi.fn(async () => 'authed' as const),
    completeTotp: vi.fn(async () => 'authed' as const),
    register: vi.fn(async () => 'authed' as const),
    cancelChallenge: vi.fn(),
    ...overrides,
  }
}

afterEach(cleanup)

describe('LoginPage', () => {
  test('does not render an account form when accounts are unavailable', () => {
    render(LoginPage, { props: { session: session({ canSignIn: false }), i18n } })

    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })

  test('submits credentials from the keyboard-accessible form and locks duplicate submissions', async () => {
    let resolveLogin!: (outcome: 'authed') => void
    const login = vi.fn(
      () =>
        new Promise<'authed'>((resolve) => {
          resolveLogin = resolve
        }),
    )
    const state = session({ login })
    render(LoginPage, { props: { session: state, i18n } })

    await fireEvent.input(screen.getByLabelText('Username'), { target: { value: 'alice' } })
    await fireEvent.input(screen.getByLabelText('Password'), { target: { value: 'password' } })
    const form = screen.getByRole('button', { name: 'Sign in' }).closest('form')
    if (!form) throw new Error('Expected login form')

    void fireEvent.submit(form)
    await waitFor(() => expect(login).toHaveBeenCalledTimes(1))
    expect((screen.getByRole('button', { name: 'Sign in' }) as HTMLButtonElement).disabled).toBe(true)
    void fireEvent.submit(form)
    expect(login).toHaveBeenCalledTimes(1)

    resolveLogin('authed')
  })

  test('requires the TOTP challenge and supports recovery-code input', async () => {
    const challenge: TotpLoginChallenge = {
      twoFactorRequired: true,
      challengeToken: 'challenge',
      expiresAt: Date.now() + 60_000,
    }
    const completeTotp = vi.fn(async () => 'authed' as const)
    const state = session({ challenge, completeTotp })
    render(LoginPage, { props: { session: state, i18n } })

    expect(screen.getByLabelText('Authenticator code')).toBeTruthy()
    await fireEvent.click(screen.getByRole('button', { name: 'Use recovery code' }))
    const code = screen.getByLabelText('Recovery code')
    await fireEvent.input(code, { target: { value: 'abcd efgh' } })
    expect((code as HTMLInputElement).value).toBe('ABCDEFGH')
    await fireEvent.submit(
      screen.getByRole('button', { name: 'Verify and sign in' }).closest('form') as HTMLFormElement,
    )

    await waitFor(() =>
      expect(completeTotp).toHaveBeenCalledWith(
        'ABCDEFGH',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    )
  })

  test('aborts an in-flight submission when unmounted', async () => {
    let capturedSignal: AbortSignal | undefined
    const pending = Promise.withResolvers<'authed'>()
    const login = vi.fn((_username: string, _password: string, options?: { signal?: AbortSignal }) => {
      capturedSignal = options?.signal
      return pending.promise
    })
    const state = session({ login })
    const { unmount } = render(LoginPage, { props: { session: state, i18n } })
    await fireEvent.input(screen.getByLabelText('Username'), { target: { value: 'alice' } })
    await fireEvent.input(screen.getByLabelText('Password'), { target: { value: 'password' } })
    void fireEvent.submit(screen.getByRole('button', { name: 'Sign in' }).closest('form') as HTMLFormElement)
    await waitFor(() => expect(capturedSignal).toBeDefined())
    unmount()
    expect(capturedSignal?.aborted).toBe(true)
    pending.resolve('authed')
  })
})
