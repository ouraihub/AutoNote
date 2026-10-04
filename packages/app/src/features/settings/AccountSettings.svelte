<script lang="ts">
  import { LIMITS } from '@shared/constants'
  import { PROFILE_NAME_MAX_LENGTH } from '@shared/avatar'
  import { getBackend, getI18n, getSession } from '@app/root/context'
  import { cloudError } from './accountCloud'
  import AvatarPicker from './AvatarPicker.svelte'
  import TotpSettings from './TotpSettings.svelte'

  const backend = getBackend()
  const session = getSession()
  const i18n = getI18n()
  const account = backend.kind === 'web' && backend.capabilities.accounts ? backend.session.account : undefined
  let name = $state(session.user?.name ?? '')
  let currentPassword = $state('')
  let newPassword = $state('')
  let confirmation = $state('')
  let registrationPassword = $state('')
  let avatarOpen = $state(false)
  let busy = $state(false)
  let error = $state('')
  let notice = $state('')

  async function saveProfile(): Promise<void> {
    if (!account || busy) return
    const normalized = name.trim().replace(/\s+/gu, ' ')
    if (!normalized || [...normalized].length > PROFILE_NAME_MAX_LENGTH) {
      error = i18n.t('settings.display_name_length', { max: PROFILE_NAME_MAX_LENGTH })
      return
    }
    busy = true
    error = ''
    notice = ''
    try {
      const user = await account.updateProfile({ name: normalized }, { signal: session.epochSignal })
      if (session.user?.id !== user.id) return
      name = user.name
      notice = i18n.t('settings.display_name_saved')
      await session.load({ signal: session.epochSignal })
    } catch (cause) {
      if (!session.epochSignal.aborted) error = i18n.t(cloudError(cause))
    } finally {
      busy = false
    }
  }

  async function savePassword(): Promise<void> {
    if (!account || busy) return
    if (!currentPassword) { error = i18n.t('settings.enter_your_current_password'); return }
    if (newPassword.length < 8 || newPassword.length > LIMITS.passwordMaxLength) {
      error = i18n.t('settings.new_password_must_be_at_least_8_characters'); return
    }
    if (newPassword !== confirmation) { error = i18n.t('common.the_passwords_do_not_match'); return }
    busy = true
    error = ''
    notice = ''
    try {
      await account.setPassword({ currentPassword, newPassword }, { signal: session.epochSignal })
      currentPassword = newPassword = confirmation = ''
      notice = i18n.t('settings.password_updated')
    } catch (cause) {
      if (!session.epochSignal.aborted) error = i18n.t(cloudError(cause))
    } finally {
      busy = false
    }
  }

  async function toggleRegistration(): Promise<void> {
    if (!account || busy || !session.site || session.user?.role !== 'owner') return
    if (!registrationPassword) { error = i18n.t('settings.enter_your_current_password'); return }
    busy = true
    error = ''
    notice = ''
    try {
      const changed = await account.updateRegistration(!session.site.registrationOpen, registrationPassword, { signal: session.epochSignal })
      registrationPassword = ''
      notice = i18n.t(changed.registrationOpen ? 'settings.registration_open' : 'settings.registration_closed')
      await session.load({ signal: session.epochSignal })
    } catch (cause) {
      if (!session.epochSignal.aborted) error = i18n.t(cloudError(cause))
    } finally {
      busy = false
    }
  }
</script>

{#if account && session.status === 'authed' && session.user}
  <div class="space-y-6">
    <section class="space-y-3">
      <h3 class="font-semibold">{i18n.t('settings.personal_profile')}</h3>
      <p>@{session.user.username}</p>
      <button type="button" class="rounded border px-3 py-1" onclick={() => avatarOpen = true}>{i18n.t('settings.change_avatar')}</button>
      <form class="flex flex-wrap items-end gap-2" onsubmit={(event) => { event.preventDefault(); void saveProfile() }}>
        <label class="flex flex-col gap-1">{i18n.t('settings.display_name')}
          <input class="rounded border bg-background px-2 py-1" autocomplete="name" maxlength={PROFILE_NAME_MAX_LENGTH * 2} bind:value={name} disabled={busy} />
        </label>
        <button class="rounded border px-3 py-1" type="submit" disabled={busy || !name.trim()}>{i18n.t('common.save')}</button>
      </form>
    </section>
    <section class="space-y-3 border-t pt-4">
      <h3 class="font-semibold">{i18n.t('settings.change_password')}</h3>
      <form class="flex flex-col items-start gap-2" onsubmit={(event) => { event.preventDefault(); void savePassword() }}>
        <label>{i18n.t('settings.current_password')} <input class="rounded border bg-background px-2 py-1" type="password" autocomplete="current-password" maxlength={LIMITS.passwordMaxLength} bind:value={currentPassword} required disabled={busy} /></label>
        <label>{i18n.t('settings.new_password')} <input class="rounded border bg-background px-2 py-1" type="password" autocomplete="new-password" minlength="8" maxlength={LIMITS.passwordMaxLength} bind:value={newPassword} required disabled={busy} /></label>
        <label>{i18n.t('settings.confirm_new_password')} <input class="rounded border bg-background px-2 py-1" type="password" autocomplete="new-password" bind:value={confirmation} required disabled={busy} /></label>
        <button class="rounded border px-3 py-1" type="submit" disabled={busy}>{i18n.t('common.save')}</button>
      </form>
    </section>
    {#if backend.capabilities.totp}<TotpSettings />{/if}
    {#if session.user.role === 'owner' && session.site}
      <section class="space-y-2 border-t pt-4">
        <h3 class="font-semibold">{i18n.t('settings.registration_status')}</h3>
        <form class="flex flex-wrap gap-2" onsubmit={(event) => { event.preventDefault(); void toggleRegistration() }}>
          <label>{i18n.t('settings.current_password')} <input class="rounded border bg-background px-2 py-1" type="password" autocomplete="current-password" bind:value={registrationPassword} required disabled={busy} /></label>
          <button class="rounded border px-3 py-1" type="submit" disabled={busy}>{session.site.registrationOpen ? i18n.t('settings.confirm_closing_registration') : i18n.t('settings.confirm_opening_registration')}</button>
        </form>
      </section>
    {/if}
    {#if error}<p role="alert">{error}</p>{/if}
    {#if notice}<p role="status">{notice}</p>{/if}
    {#if avatarOpen}<AvatarPicker onClose={() => avatarOpen = false} />{/if}
  </div>
{/if}
