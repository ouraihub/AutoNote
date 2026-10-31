import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/svelte'
import { afterEach, expect, test, vi } from 'vitest'
import { EN_US_MESSAGES } from '@shared/locales/en-US'
import type { ShareInfo } from '@shared/types'
import type { Backend } from '@app/backend'
import type { I18nState } from '@app/i18n/runtime.svelte'
import type { Notifier } from '@app/platform/notifier'
import type { NotesState } from '@app/state/notes.svelte'
import type { SessionState } from '@app/state/session.svelte'
import type { UiState } from '@app/state/ui.svelte'
import SharePanelHarness from './SharePanelHarness.svelte'

const t = (
  key: keyof typeof EN_US_MESSAGES,
  params?: Record<string, string | number>,
) =>
  EN_US_MESSAGES[key].replace(/\{(\w+)\}/g, (placeholder, name: string) =>
    String(params?.[name] ?? placeholder),
  )
const i18n = {
  locale: 'en-US',
  t,
  formatDate: (value: number) => new Date(value).toISOString(),
} as unknown as I18nState
const session = { epochSignal: new AbortController().signal } as SessionState
const notes = {
  summaries: { 'note-1': { id: 'note-1', title: 'Plan' } },
} as unknown as NotesState
const ui = { activeNoteId: 'note-1' } as UiState
const shared: ShareInfo = {
  slug: 'slug',
  noteId: 'note-1',
  url: 'https://example.com/s/slug',
  hasPassword: true,
  expiresAt: Date.now() + 7 * 24 * 3600000,
  views: 0,
  createdAt: 1,
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

test('creates with validated passcode and expiry, updates, then revokes after confirmation', async () => {
  const create = vi.fn(async () => shared)
  const remove = vi.fn(async () => ({ ok: true as const }))
  const notifier = {
    toast: vi.fn(),
    confirm: vi.fn(async () => true),
  } as Notifier
  const backend = {
    capabilities: { share: true },
    share: { get: vi.fn(async () => null), create, remove },
  } as unknown as Backend
  render(SharePanelHarness, {
    props: { backend, notes, ui, session, i18n, notifier, onClose: vi.fn() },
  })

  const generate = await screen.findByRole('button', {
    name: t('share.generate_public_link'),
  })
  await fireEvent.click(
    screen.getByRole('switch', { name: t('common.access_passcode') }),
  )
  const passcode = screen.getByLabelText(t('share.passcode'))
  await fireEvent.input(passcode, { target: { value: 'abc' } })
  await fireEvent.click(generate)
  expect(notifier.toast).toHaveBeenCalledWith({
    key: 'share.passcode_too_short',
    tone: 'error',
  })
  expect(create).not.toHaveBeenCalled()

  await fireEvent.input(passcode, { target: { value: 'abcd' } })
  await fireEvent.click(screen.getByRole('radio', { name: t('share.7_days') }))
  await fireEvent.click(generate)
  expect(create).toHaveBeenCalledWith(
    'note-1',
    { password: 'abcd', expiresIn: 7 * 24 * 3600000 },
    expect.anything(),
  )
  expect(
    ((await screen.findByLabelText(t('share.public_link'))) as HTMLInputElement)
      .value,
  ).toBe(shared.url)

  await fireEvent.click(
    screen.getByRole('switch', { name: t('common.access_passcode') }),
  )
  await fireEvent.click(
    screen.getByRole('button', { name: t('share.update_settings') }),
  )
  expect(create).toHaveBeenLastCalledWith(
    'note-1',
    { password: '' },
    expect.anything(),
  )
  await waitFor(() => expect(create).toHaveBeenCalledTimes(2))
  await waitFor(() =>
    expect(
      screen
        .getByRole('button', { name: t('share.revoke_link') })
        .hasAttribute('disabled'),
    ).toBe(false),
  )
  await fireEvent.click(
    screen.getByRole('button', { name: t('share.revoke_link') }),
  )
  await waitFor(() =>
    expect(remove).toHaveBeenCalledWith('note-1', expect.anything()),
  )
  expect(notifier.confirm).toHaveBeenCalledWith(
    expect.objectContaining({
      titleKey: 'share.revoke_this_public_link',
      danger: true,
    }),
  )
  await screen.findByRole('button', { name: t('share.generate_public_link') })
})
